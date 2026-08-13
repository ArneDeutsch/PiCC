import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runPluginInventoryCli, type PluginInventoryCliOptions } from "../src/plugin-inventory-cli.js";
import { PLUGIN_INVENTORY_ARGV_USAGE } from "../src/runtime/plugin-inventory-text.js";
import {
  PI_SUITE_PACKAGES,
  canonicalPath,
  classifyInstallation,
  discoverNpmCommand,
  discoverTrustedGit,
  resolvePiCli,
  validatePiSuite,
} from "../bin/picc-admin.mjs";
import { collectCompilationIdentity } from "../bin/picc-runtime.mjs";
import { createOwnedMarketplaceCodec, ownedMarketplaceScopeKey, type OwnedMarketplaceRecord } from "../src/plugin-lifecycle/admission.js";
import { encodePluginStableSelector } from "../src/plugin-lifecycle/plugin-service.js";
import { createLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { createRecordEnvelope, establishOwnedStateStore, ownedRecordPartition } from "../src/plugin-lifecycle/state-store.js";
import { projectIdentities } from "../src/util/project-identity.js";

const repoRoot = path.resolve(".");
const adminSource = path.join(repoRoot, "bin", "picc-admin.mjs");
const launcherSource = path.join(repoRoot, "bin", "picc.mjs");
const pluginAdapterSource = path.join(repoRoot, "bin", "picc-plugin.mjs");
const runtimeSelectorSource = path.join(repoRoot, "bin", "picc-runtime.mjs");
const inventoryIncompleteWarning = (classes: string, actions = "repair") => `PiCC plugin inventory may be incomplete (${classes}). ${actions.includes("format") ? "Update PiCC or report the unsupported plugin-state format. " : ""}${actions.includes("repair") ? "Repair the malformed or unreadable Claude plugin state outside PiCC. " : ""}Run PiCC interactively in the same project and profile, then use \`/doctor\` for details.`;
const sourceFallbackNotice = "PiCC is using TypeScript source because the compiled runtime is missing. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC to restore compiled startup.";
const sourcePluginStderr = `${sourceFallbackNotice}\n`;
const tempDirs: string[] = [];

function temp(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function write(filename: string, contents: string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function makePackage(options: {
  root?: string;
  piVersion?: string;
  installedVersions?: Partial<Record<string, string>>;
  source?: boolean;
  withCli?: boolean;
} = {}): string {
  const root = options.root ?? temp("picc-launcher-");
  const piVersion = options.piVersion ?? "0.82.0";
  const dependencies = Object.fromEntries(PI_SUITE_PACKAGES.map((name) => [name, piVersion]));
  write(path.join(root, "package.json"), JSON.stringify({
    name: "@arnedeutsch/picc", version: "0.1.1", type: "module", dependencies,
  }));
  if (options.source ?? true) {
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    write(path.join(root, "package-lock.json"), "{}");
  }
  write(path.join(root, "picc", "index.ts"), "export default function picc() {}\n");
  for (const name of PI_SUITE_PACKAGES) {
    const version = options.installedVersions?.[name] ?? piVersion;
    write(path.join(root, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version }));
  }
  if (options.withCli ?? true) {
    write(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), "process.exit(0);\n");
  }
  return root;
}

function installLauncher(root: string): void {
  write(path.join(root, "bin", "picc-admin.mjs"), fs.readFileSync(adminSource, "utf8"));
  write(path.join(root, "bin", "picc.mjs"), fs.readFileSync(launcherSource, "utf8"));
  write(path.join(root, "bin", "picc-plugin.mjs"), fs.readFileSync(pluginAdapterSource, "utf8"));
  write(path.join(root, "bin", "picc-runtime.mjs"), fs.readFileSync(runtimeSelectorSource, "utf8"));
}

function digest(value: unknown): string {
  return createHash("sha256").update(Buffer.from(JSON.stringify(value), "utf8")).digest("hex");
}

function installVerifiedRuntime(root: string, options: {
  pluginCode?: string; sourceMatched?: boolean; sourcePluginCode?: string;
} = {}): void {
  const extension = "export default function picc() {}\n";
  const index = "export const runtime = 'compiled';\n//# sourceMappingURL=index.js.map\n";
  const plugin = options.pluginCode ?? "export function runPluginInventoryCli(argv, output) { output.log(`compiled:${argv.join(':')}`); return 0; }\n//# sourceMappingURL=plugin-inventory-cli.js.map\n";
  const indexMap = JSON.stringify({ version: 3, file: "index.js", sourceRoot: "", sources: [], names: [], mappings: "" });
  const pluginMap = JSON.stringify({ version: 3, file: "plugin-inventory-cli.js", sourceRoot: "", sources: [], names: [], mappings: "" });
  const contents = new Map([
    ["picc/index.js", extension],
    ["dist/index.js", index],
    ["dist/index.js.map", indexMap],
    ["dist/plugin-inventory-cli.js", plugin],
    ["dist/plugin-inventory-cli.js.map", pluginMap],
  ]);
  for (const [relative, contentsValue] of contents) write(path.join(root, ...relative.split("/")), contentsValue);

  let identity = {
    package: { name: "@arnedeutsch/picc", version: "0.1.1", type: "module" },
    compiler: {
      typescriptVersion: "test", configPath: "tsconfig.runtime.json", configSha256: "0".repeat(64),
      dependencyLockPath: "package-lock.json", dependencyLockSha256: "0".repeat(64),
    },
    sources: [] as Array<{ path: string; sha256: string }>,
    sourceDigest: "",
  };
  if (options.sourceMatched) {
    write(path.join(root, "src", "index.ts"), "export const source = true;\n");
    write(path.join(root, "src", "plugin-inventory-cli.ts"), options.sourcePluginCode ?? "export function runPluginInventoryCli() { return 0; }\n");
    write(path.join(root, "tsconfig.runtime.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], strict: true,
        noUncheckedIndexedAccess: true, esModuleInterop: true, skipLibCheck: true, forceConsistentCasingInFileNames: true,
        resolveJsonModule: false, allowJs: false, checkJs: false, sourceMap: true, inlineSourceMap: false,
        inlineSources: false, declaration: false, declarationMap: false, noEmit: false, emitDeclarationOnly: false,
        rootDir: "src", types: [],
      },
      include: ["src/**/*.ts"], exclude: ["node_modules", "dist", "test", "examples"],
    }));
    const typescriptTarget = path.join(root, "node_modules", "typescript");
    if (!fs.existsSync(typescriptTarget)) fs.symlinkSync(path.join(repoRoot, "node_modules", "typescript"), typescriptTarget, "junction");
    identity = collectCompilationIdentity(root);
  } else {
    identity.sourceDigest = digest({ package: identity.package, compiler: identity.compiler, sources: identity.sources });
  }
  const files = [...contents].map(([relative, contentsValue]) => ({
    path: relative, sha256: createHash("sha256").update(contentsValue).digest("hex"),
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const manifest = {
    schemaVersion: 1, package: identity.package, compiler: identity.compiler, sources: identity.sources,
    sourceDigest: identity.sourceDigest, files, runtimeDigest: digest(files),
    entries: { extension: "picc/index.js", pluginInventory: "dist/plugin-inventory-cli.js" },
  };
  write(path.join(root, "dist", "picc-runtime.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function runSourcePluginWithEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const packageRoot = makePackage({ withCli: false });
  installLauncher(packageRoot);
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  manifest.devDependencies = { jiti: "2.7.0" };
  write(manifestPath, JSON.stringify(manifest));
  copyJiti(path.join(packageRoot, "node_modules", "jiti"));
  const implementationUrl = pathToFileURL(path.join(repoRoot, "src", "plugin-inventory-cli.ts")).href;
  write(
    path.join(packageRoot, "src", "plugin-inventory-cli.ts"),
    `export { runPluginInventoryCli } from ${JSON.stringify(implementationUrl)};\n`,
  );

  const childEnv = { ...process.env };
  delete childEnv.PICC_CLAUDE_USER_DIR;
  delete childEnv.CLAUDE_CONFIG_DIR;
  Object.assign(childEnv, env);
  if (process.platform === "win32") {
    const preload = path.join(temp("picc-managed-policy-isolation-"), "isolate.cjs");
    write(preload, `
const fs = require("node:fs");
const denied = value => typeof value === "string" && value.toLowerCase().startsWith("c:\\\\program files\\\\claudecode");
const missing = value => Object.assign(new Error("test-isolated managed policy"), { code: "ENOENT", path: value });
for (const name of ["statSync", "readFileSync", "readdirSync"]) {
  const original = fs[name];
  fs[name] = function(value, ...rest) { if (denied(value)) throw missing(value); return original.call(this, value, ...rest); };
}
require("node:module").syncBuiltinESMExports();
`);
    childEnv.NODE_OPTIONS = `${childEnv.NODE_OPTIONS ?? ""} --require ${JSON.stringify(preload)}`.trim();
  }
  return spawnSync(process.execPath, [path.join(packageRoot, "bin", "picc.mjs"), "plugin", ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
}

function runSourcePlugin(cwd: string, userDir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return runSourcePluginWithEnv(cwd, args, { ...env, PICC_CLAUDE_USER_DIR: userDir });
}

function copyJiti(target: string): void {
  const manifest = canonicalPath(fileURLToPath(import.meta.resolve("jiti/package.json")));
  fs.cpSync(path.dirname(manifest), target, { recursive: true });
}

function inventoryFixture(): { project: string; userDir: string } {
  const root = temp("picc-plugin-command-");
  const project = path.join(root, "project");
  const userDir = path.join(root, "profile");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  return { project, userDir };
}

function localLifecycleFixture(): { project: string; userDir: string; homeDir: string; marketplace: string; runtimeCanary: string } {
  const { project, userDir } = inventoryFixture(); const homeDir = path.dirname(project); const marketplace = path.join(project, "marketplace"); const runtimeCanary = path.join(homeDir, "mutation-runtime-canary");
  write(path.join(marketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "official", owner: { name: "Example" }, plugins: [{ name: "bare", source: "./plugins/bare", version: "2.0.0", defaultEnabled: false }, { name: "tool", source: "./plugins/tool", defaultEnabled: true }] }));
  const hostileCommand = `${process.execPath} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(runtimeCanary)},'runtime')`)}`;
  write(path.join(marketplace, "plugins", "tool", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tool", version: "1.0.0", skills: "./skills", commands: "./commands", hooks: "./hooks/hooks.json", mcpServers: "./.mcp.json" }));
  write(path.join(marketplace, "plugins", "tool", "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hostileCommand }] }] } }));
  write(path.join(marketplace, "plugins", "tool", ".mcp.json"), JSON.stringify({ mcpServers: { hostile: { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(runtimeCanary)},'mcp')`] } } }));
  write(path.join(marketplace, "plugins", "tool", "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: local lifecycle proof\n---\nretained bytes\n");
  write(path.join(marketplace, "plugins", "tool", "commands", "hostile.md"), `---\ndescription: runtime canary\n---\n!${hostileCommand}\n`);
  write(path.join(marketplace, "plugins", "bare", "skills", "bare", "SKILL.md"), "---\nname: bare\ndescription: manifestless release proof\n---\nmanifestless bytes\n");
  return { project, userDir, homeDir, marketplace, runtimeCanary };
}

async function runPluginInProcess(
  cwd: string,
  args: string[],
  options: PluginInventoryCliOptions,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runPluginInventoryCli(args, {
    log: (message) => stdout.push(message),
    error: (message) => stderr.push(message),
  }, { cwd, platform: "linux", ...options });
  return { code, stdout, stderr };
}

describe("direct Pi package validation", () => {
  it("accepts the four exact direct packages and ignores interrupted npm staging debris", () => {
    const root = makePackage();
    write(
      path.join(root, "node_modules", "@earendil-works", ".pi-coding-agent-leftover", "node_modules", "@earendil-works", "pi-tui", "README"),
      "partial staging directory",
    );

    expect(validatePiSuite({ packageRoot: root })).toMatchObject({ ok: true, version: "0.82.0" });
    expect(resolvePiCli(root)).toMatchObject({ ok: true });
    installLauncher(root);
    expect(spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs")], {
      cwd: root, encoding: "utf8",
    }).status).toBe(0);
  });

  it("names missing and mismatched packages with expected and found versions", () => {
    const missing = makePackage();
    fs.rmSync(path.join(missing, "node_modules", "@earendil-works", "pi-ai"), { recursive: true });
    expect(validatePiSuite({ packageRoot: missing })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/pi-ai is missing \(expected 0\.82\.0\).*picc update/),
    });

    const mismatch = makePackage({ installedVersions: { "@earendil-works/pi-tui": "9.9.9" } });
    expect(validatePiSuite({ packageRoot: mismatch })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/pi-tui is 9\.9\.9; expected 0\.82\.0.*picc update/),
    });
  });

  it("rejects mixed or non-exact declarations", () => {
    const root = makePackage();
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { dependencies: Record<string, string> };
    manifest.dependencies["@earendil-works/pi-ai"] = "0.81.0";
    write(manifestPath, JSON.stringify(manifest));
    expect(validatePiSuite({ packageRoot: root })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/declarations disagree/),
    });

    manifest.dependencies["@earendil-works/pi-ai"] = "^0.82.0";
    write(manifestPath, JSON.stringify(manifest));
    expect(validatePiSuite({ packageRoot: root })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/stable exact version/),
    });
  });

  it("admits npm-hoisted packages only from the node_modules physically containing PiCC", () => {
    const prefix = temp("picc-hoisted-");
    const root = path.join(prefix, "node_modules", "@arnedeutsch", "picc");
    makePackage({ root, source: false, withCli: false });
    fs.rmSync(path.join(root, "node_modules"), { recursive: true });
    for (const name of PI_SUITE_PACKAGES) {
      write(path.join(prefix, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version: "0.82.0" }));
    }
    write(path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), "process.exit(0);\n");

    expect(resolvePiCli(root)).toMatchObject({ ok: true });
  });

  it("does not hide a broken nearer package behind a healthy hoisted copy", () => {
    const prefix = temp("picc-hoisted-shadow-");
    const root = path.join(prefix, "node_modules", "@arnedeutsch", "picc");
    makePackage({ root, source: false, withCli: false });
    fs.rmSync(path.join(root, "node_modules"), { recursive: true });
    for (const name of PI_SUITE_PACKAGES) {
      write(path.join(prefix, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version: "0.82.0" }));
    }
    write(path.join(root, "node_modules", "@earendil-works", "pi-ai", "README"), "broken nearer package");

    expect(validatePiSuite({ packageRoot: root })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/pi-ai has missing or invalid package metadata/),
    });
  });

  it("does not resolve a Pi package from an unrelated ancestor node_modules", () => {
    const parent = temp("picc-ancestor-");
    const root = path.join(parent, "checkout");
    makePackage({ root, withCli: false });
    fs.rmSync(path.join(root, "node_modules"), { recursive: true });
    for (const name of PI_SUITE_PACKAGES) {
      write(path.join(parent, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version: "0.82.0" }));
    }
    write(path.join(parent, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), "process.exit(0);\n");

    expect(validatePiSuite({ packageRoot: root })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/pi-agent-core is missing/),
    });
  });

  it("rejects a package-directory or CLI symlink escape", () => {
    const packageEscape = makePackage();
    const logicalAgent = path.join(packageEscape, "node_modules", "@earendil-works", "pi-coding-agent");
    const outsideAgent = temp("picc-agent-escape-");
    write(path.join(outsideAgent, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent", version: "0.82.0",
    }));
    write(path.join(outsideAgent, "dist", "cli.js"), "process.exit(0);\n");
    fs.rmSync(logicalAgent, { recursive: true });
    fs.symlinkSync(outsideAgent, logicalAgent, process.platform === "win32" ? "junction" : "dir");
    expect(validatePiSuite({ packageRoot: packageEscape })).toMatchObject({ ok: false });

    if (process.platform !== "win32") {
      const cliEscape = makePackage({ withCli: false });
      const outsideCli = path.join(temp("picc-cli-escape-"), "cli.js");
      write(outsideCli, "process.exit(0);\n");
      const logicalCli = path.join(cliEscape, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
      fs.mkdirSync(path.dirname(logicalCli), { recursive: true });
      fs.symlinkSync(outsideCli, logicalCli);
      expect(resolvePiCli(cliEscape)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/escaped|unavailable/),
      });
    }
  });
});

describe("installation and executable discovery", () => {
  it("classifies only .git file/directory plus a regular lockfile as source", () => {
    const directoryMarker = makePackage();
    expect(classifyInstallation({ packageRoot: directoryMarker })).toBe("source");

    const fileMarker = makePackage();
    fs.rmSync(path.join(fileMarker, ".git"), { recursive: true });
    write(path.join(fileMarker, ".git"), "gitdir: elsewhere\n");
    expect(classifyInstallation({ packageRoot: fileMarker })).toBe("source");

    const noLock = makePackage();
    fs.rmSync(path.join(noLock, "package-lock.json"));
    expect(classifyInstallation({ packageRoot: noLock })).toBe("installed");

    const noGit = makePackage();
    fs.rmSync(path.join(noGit, ".git"), { recursive: true });
    expect(classifyInstallation({ packageRoot: noGit })).toBe("installed");
  });

  it("honors an absolute PICC_GIT override and otherwise resolves inherited PATH", () => {
    const actualGit = discoverTrustedGit();
    expect(actualGit).toBeTruthy();
    expect(discoverTrustedGit({ PICC_GIT: process.execPath, PATH: "" })).toBe(canonicalPath(process.execPath));
    expect(discoverTrustedGit({ PICC_GIT: "relative-git", PATH: process.env.PATH })).toBeUndefined();

    const pathKey = process.platform === "win32" ? "Path" : "PATH";
    const env = {
      [pathKey]: path.dirname(actualGit!),
      ...(process.platform === "win32" ? { PATHEXT: path.extname(actualGit!) || ".EXE" } : {}),
    };
    expect(discoverTrustedGit(env)).toBe(canonicalPath(actualGit!));

    if (process.platform === "win32") {
      const scripts = temp("picc-git-script-");
      write(path.join(scripts, "git.cmd"), "@exit /b 0\r\n");
      expect(discoverTrustedGit({
        Path: `${scripts}${path.delimiter}${path.dirname(actualGit!)}`,
        PATHEXT: ".CMD;.EXE",
      })).toBe(canonicalPath(actualGit!));
      expect(discoverTrustedGit({ PICC_GIT: path.join(scripts, "git.cmd"), PATH: "" })).toBeUndefined();
    }
  });

  it("represents npm as Node plus an absolute npm CLI without shell execution", () => {
    const directory = temp("picc-npm-command-");
    const cli = path.join(directory, "npm-cli.js");
    write(cli, "process.exit(0);\n");
    fs.chmodSync(cli, 0o755);
    const command = discoverNpmCommand({ env: { npm_execpath: cli, PATH: "" }, execPath: process.execPath });
    expect(command).toEqual({ command: canonicalPath(process.execPath), args: [canonicalPath(cli)] });
  });
});

describe("launcher behavior", () => {
  it("surfaces the validator's precise package failure instead of a generic runtime error", () => {
    const root = makePackage({ installedVersions: { "@earendil-works/pi-ai": "9.9.9" } });
    installLauncher(root);
    const result = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs")], {
      cwd: root, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/pi-ai is 9\.9\.9; expected 0\.82\.0.*picc update/);
    expect(result.stderr).not.toMatch(/incomplete or inconsistent/);
  });

  it("routes installed and source-classified interactive launches through the verified compiled wrapper", () => {
    for (const installationKind of ["installed", "source"] as const) {
      const root = makePackage({ source: installationKind === "source" });
      installLauncher(root);
      installVerifiedRuntime(root, { sourceMatched: installationKind === "source" });
      const canary = path.join(root, "launch.json");
      const sourceCanary = path.join(root, "source-started");
      const jitiCanary = path.join(root, "jiti-started");
      write(path.join(root, "picc", "index.ts"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sourceCanary)}, "started");`);
      write(path.join(root, "node_modules", "jiti", "package.json"), JSON.stringify({
        name: "jiti", version: "2.7.0", type: "module", exports: "./index.js",
      }));
      write(path.join(root, "node_modules", "jiti", "index.js"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(jitiCanary)}, "started");`);
      const cli = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
      write(cli, `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const descendant = spawnSync(process.execPath, ["-p", "process.env.NODE_OPTIONS ?? ''"], { encoding: "utf8" });
fs.writeFileSync(process.env.PICC_TEST_CANARY, JSON.stringify({
  argv: process.argv.slice(2),
  kind: process.env.PICC_INSTALL_KIND,
  version: process.env.PICC_VERSION,
  parent: process.env.PICC_LAUNCHER_PID,
  cwd: process.cwd(),
  nodeOptions: process.env.NODE_OPTIONS,
  sourceMapsEnabled: process.sourceMapsEnabled,
  descendantStatus: descendant.status,
  descendantNodeOptions: descendant.stdout.trim(),
}));
process.exit(23);
`);
      const result = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "--model", "openai/test"], {
        cwd: root, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--no-warnings", PICC_TEST_CANARY: canary },
      });
      expect(result).toMatchObject({ status: 23, stdout: "", stderr: "" });
      const launched = JSON.parse(fs.readFileSync(canary, "utf8")) as {
        argv: string[]; kind: string; version: string; parent: string; cwd: string; nodeOptions: string;
        sourceMapsEnabled: boolean; descendantStatus: number; descendantNodeOptions: string;
      };
      expect(launched.argv).toEqual(["-e", canonicalPath(path.join(root, "picc", "index.js")), "--model", "openai/test"]);
      expect(launched).toMatchObject({
        kind: installationKind, version: "0.1.1", cwd: root, nodeOptions: "--no-warnings",
        sourceMapsEnabled: true, descendantStatus: 0, descendantNodeOptions: "--no-warnings",
      });
      expect(launched.parent).toMatch(/^[1-9]\d*$/);
      expect(fs.existsSync(sourceCanary)).toBe(false);
      expect(fs.existsSync(jitiCanary)).toBe(false);

      const version = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "--version"], {
        cwd: root, encoding: "utf8",
      });
      expect(version).toMatchObject({ status: 0, stderr: "" });
      expect(version.stdout).toBe(`PiCC 0.1.1\nEmbedded Pi 0.82.0\nInstall ${installationKind}\nRuntime compiled (verified)\n`);
    }
  });

  it("fails every installed runtime category before Pi or source startup", () => {
    for (const category of ["missing", "corrupt", "version-mismatch"] as const) {
      for (const argv of [[], ["plugin", "list"], ["plugin", "details", "same@market"]]) {
        const root = makePackage({ source: false });
        installLauncher(root);
        if (category !== "missing") installVerifiedRuntime(root);
        if (category === "corrupt") fs.appendFileSync(path.join(root, "dist", "plugin-inventory-cli.js"), "// damaged\n");
        if (category === "version-mismatch") {
          const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
          packageJson.version = "0.2.0";
          write(path.join(root, "package.json"), JSON.stringify(packageJson));
        }
        const piCanary = path.join(root, "pi-started");
        const sourceCanary = path.join(root, "source-started");
        write(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
          `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(piCanary)}, "started");`);
        write(path.join(root, "src", "plugin-inventory-cli.ts"),
          `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sourceCanary)}, "started"); export function runPluginInventoryCli() { return 0; }`);

        const result = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), ...argv], {
          cwd: root, encoding: "utf8",
        });
        expect(result.status, `${category}:${argv.join(" ")}`).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(category === "missing" ? "runtime is missing" : category === "corrupt" ? "runtime is damaged" : "runtime is version-incoherent");
        expect(result.stderr).toContain("TypeScript source was not used");
        expect(result.stderr).toContain("picc update");
        expect(result.stderr).toContain("installation owner");
        expect(fs.existsSync(piCanary)).toBe(false);
        expect(fs.existsSync(sourceCanary)).toBe(false);
      }
    }
  });

  it("discloses source missing, ordinary drift, and package-version drift once on every runtime route", () => {
    for (const state of ["missing", "source-stale", "package-drift"] as const) {
      const root = makePackage();
      installLauncher(root);
      const packageJsonPath = path.join(root, "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        version: string; dependencies: Record<string, string>;
      };
      packageJson.dependencies.jiti = "2.7.0";
      write(packageJsonPath, JSON.stringify(packageJson));
      write(path.join(root, "src", "plugin-inventory-cli.ts"), "export function runPluginInventoryCli() { return 0; }\n");
      copyJiti(path.join(root, "node_modules", "jiti"));
      if (state !== "missing") {
        installVerifiedRuntime(root, { sourceMatched: true });
        if (state === "source-stale") fs.appendFileSync(path.join(root, "src", "index.ts"), "// changed\n");
        else {
          packageJson.version = "0.2.0";
          write(packageJsonPath, JSON.stringify(packageJson));
        }
      }
      const canary = path.join(root, "source-launch.json");
      write(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
        `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(canary)}, JSON.stringify(process.argv.slice(2)));`);

      for (const argv of [["--theme", "dark"], ["plugin", "list"], ["plugin", "details", "same@market"]]) {
        const result = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), ...argv], {
          cwd: root, encoding: "utf8",
        });
        expect(result.status, `${state}:${argv.join(" ")}`).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr.match(/PiCC is using TypeScript source/gu)).toHaveLength(1);
        expect(result.stderr).toContain(state === "missing" ? "compiled runtime is missing" : "does not match this checkout");
      }
      expect(JSON.parse(fs.readFileSync(canary, "utf8"))).toEqual([
        "-e", canonicalPath(path.join(root, "picc", "index.ts")), "--theme", "dark",
      ]);
    }
  });

  it("refuses corrupt source-checkout output for interactive and plugin commands", () => {
    const root = makePackage();
    installLauncher(root);
    installVerifiedRuntime(root, { sourceMatched: true });
    fs.appendFileSync(path.join(root, "dist", "index.js"), "// damaged\n");
    const piCanary = path.join(root, "pi-started");
    write(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(piCanary)}, "started");`);

    for (const argv of [[], ["plugin", "list"], ["plugin", "details", "same@market"]]) {
      const result = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), ...argv], {
        cwd: root, encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("source-checkout compiled runtime is damaged");
      expect(result.stderr).toContain("npm run build");
      expect(result.stderr).not.toContain("using TypeScript source");
    }
    expect(fs.existsSync(piCanary)).toBe(false);
  });

  it("reports source-checkout stale, package-drifted, and corrupt runtime recovery through successful version output", () => {
    for (const state of ["source-stale", "package-drift", "corrupt"] as const) {
      const root = makePackage();
      installLauncher(root);
      installVerifiedRuntime(root, { sourceMatched: true });
      if (state === "source-stale") fs.appendFileSync(path.join(root, "src", "index.ts"), "// changed\n");
      if (state === "package-drift") {
        const packagePath = path.join(root, "package.json");
        const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version: string };
        manifest.version = "0.2.0";
        write(packagePath, JSON.stringify(manifest));
      }
      if (state === "corrupt") fs.appendFileSync(path.join(root, "dist", "index.js"), "// damaged\n");

      const result = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "--version"], {
        cwd: root, encoding: "utf8",
      });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain(state === "corrupt"
        ? "Runtime unavailable (corrupt): The source-checkout compiled runtime is damaged."
        : "Runtime source fallback (source-stale): PiCC is using TypeScript source because the compiled runtime does not match this checkout.");
      expect(result.stdout).toContain("Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC");
      expect(result.stdout).toContain(state === "corrupt" ? "Runtime unavailable" : "Runtime source fallback");
      expect(result.stdout).not.toMatch(/[0-9a-f]{64}/u);
      expect(result.stdout).not.toContain(root);
    }
  });

  it("keeps source-checkout recovery actionable when the runtime selector cannot import", () => {
    const root = makePackage();
    installLauncher(root);
    fs.rmSync(path.join(root, "bin", "picc-runtime.mjs"));
    const piCanary = path.join(root, "pi-started");
    write(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(piCanary)}, "started");`);

    const cases = [
      {
        argv: ["--version"],
        expected: {
          status: 0,
          stdout: "PiCC 0.1.1\nEmbedded Pi 0.82.0\nInstall source\nRuntime unavailable (launcher): Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC.\n",
          stderr: "",
        },
      },
      {
        argv: [],
        expected: {
          status: 1,
          stdout: "",
          stderr: "PiCC: runtime selection is unavailable. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC.\n",
        },
      },
    ] as const;
    for (const { argv, expected } of cases) {
      const result = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), ...argv], {
        cwd: root, encoding: "utf8",
      });
      expect(result, argv.join(" ") || "normal launch").toMatchObject(expected);
    }
    expect(fs.existsSync(piCanary)).toBe(false);
  });

  it("routes installed and source-classified compiled plugin commands through only the verified inventory entry", () => {
    for (const installationKind of ["installed", "source"] as const) {
      const root = makePackage({ source: installationKind === "source", withCli: false });
      installLauncher(root);
      const sourceCanary = path.join(root, "source-started");
      const sourcePluginCode = `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sourceCanary)}, "started"); export function runPluginInventoryCli() { return 9; }`;
      installVerifiedRuntime(root, {
        sourceMatched: installationKind === "source",
        sourcePluginCode,
        pluginCode: "export function runPluginInventoryCli(argv, output) { output.log(`compiled:${argv.join(':')}:maps=${process.sourceMapsEnabled}`); return 0; }\n//# sourceMappingURL=plugin-inventory-cli.js.map\n",
      });
      if (installationKind === "installed") write(path.join(root, "src", "plugin-inventory-cli.ts"), sourcePluginCode);

      for (const [argv, expected] of [
        [["plugin", "list"], "compiled:list:maps=true\n"],
        [["plugin", "details", "same@market"], "compiled:details:same@market:maps=true\n"],
        [["plugin", "install", "same@market", "--yes"], "compiled:install:same@market:--yes:maps=true\n"],
      ] as const) {
        const result = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), ...argv], {
          cwd: root, encoding: "utf8",
        });
        expect(result).toMatchObject({ status: 0, stdout: expected, stderr: "" });
      }
      expect(fs.existsSync(sourceCanary)).toBe(false);
      expect(fs.existsSync(path.join(root, "node_modules", "jiti"))).toBe(false);
    }
  });

  it("routes plugin argv before Pi resolution and reports an unavailable packaged entrypoint safely", () => {
    const root = makePackage({ withCli: false });
    installLauncher(root);
    const piCanary = path.join(root, "pi-started");
    write(
      path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(piCanary)}, "started");`,
    );

    const result = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "plugin", "list"], {
      cwd: root, encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("PiCC is using TypeScript source because the compiled runtime is missing. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC to restore compiled startup.\nPiCC plugin inventory is unavailable in this build. Update or reinstall PiCC.");
    expect(fs.existsSync(piCanary)).toBe(false);
  });

  it("loads valid local or hoisted jiti while rejected local shadows never execute", () => {
    const localRoot = makePackage();
    installLauncher(localRoot);
    const localManifestPath = path.join(localRoot, "package.json");
    const localManifest = JSON.parse(fs.readFileSync(localManifestPath, "utf8")) as { dependencies: Record<string, string> };
    localManifest.dependencies.jiti = "2.7.0";
    write(localManifestPath, JSON.stringify(localManifest));
    write(path.join(localRoot, "src", "plugin-inventory-cli.ts"), "export const runPluginInventoryCli = () => 0;\n");
    copyJiti(path.join(localRoot, "node_modules", "jiti"));
    const local = spawnSync(process.execPath, [path.join(localRoot, "bin", "picc.mjs"), "plugin", "list"], {
      cwd: localRoot, encoding: "utf8",
    });
    expect(local).toMatchObject({
      status: 0,
      stdout: "",
      stderr: "PiCC is using TypeScript source because the compiled runtime is missing. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC to restore compiled startup.\n",
    });

    const prefix = temp("picc-plugin-loader-");
    const root = path.join(prefix, "node_modules", "@arnedeutsch", "picc");
    makePackage({ root, source: true, withCli: false });
    installLauncher(root);
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      dependencies: Record<string, string>; devDependencies?: Record<string, string>;
    };
    manifest.devDependencies = { jiti: "2.7.0" };
    write(manifestPath, JSON.stringify(manifest));
    write(path.join(root, "src", "plugin-inventory-cli.ts"), "export const runPluginInventoryCli = () => 0;\n");
    copyJiti(path.join(prefix, "node_modules", "jiti"));

    const logical = path.join(root, "node_modules", "jiti");
    const outside = temp("picc-plugin-loader-escape-");
    const escapedCanary = path.join(outside, "executed");
    write(path.join(outside, "package.json"), JSON.stringify({
      name: "jiti", version: "2.7.0", type: "module",
      exports: { "./static": "./canary.mjs", "./package.json": "./package.json" },
    }));
    write(path.join(outside, "canary.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(escapedCanary)}, "executed"); export function createJiti() { return {}; }\n`);
    fs.rmSync(logical, { recursive: true, force: true });
    fs.symlinkSync(outside, logical, process.platform === "win32" ? "junction" : "dir");

    const escaped = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "plugin", "list"], {
      cwd: root, encoding: "utf8",
    });
    expect(escaped).toMatchObject({
      status: 0, stdout: "",
      stderr: "PiCC is using TypeScript source because the compiled runtime is missing. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC to restore compiled startup.\n",
    });
    expect(fs.existsSync(escapedCanary)).toBe(false);

    fs.rmSync(logical, { recursive: true, force: true });
    const rejectedCanary = path.join(logical, "executed");
    write(path.join(logical, "package.json"), JSON.stringify({
      name: "jiti-shadow", version: "9.9.9", type: "module",
      exports: { "./static": "./canary.mjs", "./package.json": "./package.json" },
    }));
    write(path.join(logical, "canary.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(rejectedCanary)}, "executed"); export function createJiti() { return {}; }\n`);
    const rejected = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "plugin", "list"], {
      cwd: root, encoding: "utf8",
    });
    expect(rejected).toMatchObject({
      status: 0, stdout: "",
      stderr: "PiCC is using TypeScript source because the compiled runtime is missing. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC to restore compiled startup.\n",
    });
    expect(fs.existsSync(rejectedCanary)).toBe(false);
  });

  it("runs command semantics and fresh snapshots in process through the shared grammar", async () => {
    const { project, userDir } = inventoryFixture();
    const env = { PICC_CLAUDE_USER_DIR: userDir };
    write(path.join(userDir, "settings.json"), JSON.stringify({
      enabledPlugins: { "same@market-a": true, "same@market-b": true },
    }));

    const list = await runPluginInProcess(project, ["list"], { env });
    expect(list).toMatchObject({ code: 0, stderr: [] });
    expect(list.stdout.join("\n")).toContain("Snapshot: captured for this command");
    expect(list.stdout.join("\n")).toContain("Plugin: same@market-a");
    expect(list.stdout.join("\n")).toContain("Plugin: same@market-b");

    const details = await runPluginInProcess(project, ["details", "same@market-b"], { env });
    expect(details).toMatchObject({ code: 0, stderr: [] });
    expect(details.stdout.join("\n")).toContain("Plugin: same@market-b");
    expect(details.stdout.join("\n")).not.toContain("Plugin: same@market-a");

    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "later@market": true } }));
    const later = await runPluginInProcess(project, ["list"], { env });
    expect(later.stdout.join("\n")).toContain("Plugin: later@market");
    expect(later.stdout.join("\n")).not.toContain("Plugin: same@market-a");

    for (const args of [[], ["LIST"], ["details"], ["details", "bare"], ["list", "extra"], ["details", "later@market", "extra"]]) {
      const result = await runPluginInProcess(project, args, { env });
      expect(result).toEqual({
        code: 2,
        stdout: [],
        stderr: [PLUGIN_INVENTORY_ARGV_USAGE],
      });
    }

    const unknown = await runPluginInProcess(project, ["details", "missing@market"], { env });
    expect(unknown).toEqual({
      code: 1,
      stdout: [],
      stderr: ["PiCC plugin not found: missing@market. Run picc plugin list to copy a listed qualified identity."],
    });
  });

  it("prints an operation-bound preview before noninteractive confirmation and cancels without execution", async () => {
    const { project, userDir } = inventoryFixture();
    const calls: string[] = [];
    const preview = {
      operationId: "marketplace_preview", action: "add", confirmationDigest: `sha256:${"a".repeat(64)}`,
      registration: { name: "official", scope: "user", source: { kind: "github", repository: "owner/repo" }, profileKey: "profile-test", ownership: "picc-owned" },
      snapshot: { snapshotId: "marketplace_exact", catalogDigest: `sha256:${"b".repeat(64)}`, trust: { targetDigest: `sha256:${"c".repeat(64)}` } },
      catalog: { plugins: Array.from({ length: 33 }, (_, index) => ({ name: `tool-${index}`, supported: true, sourceKind: "npm" })), unsupportedEntries: 0, omittedEntries: 0 }, dependents: [], acknowledgement: "preserve-installations",
      settingsEffect: { setting: "extraKnownMarketplaces", effective: true, declarationOnly: false }, participants: [{ order: 0, role: "settings", effect: "replace" }], consequences: ["Adds only the selected local registration", "Does not install plugins"],
    } as never;
    const services = () => ({ ok: true as const, value: {
      marketplaces: { listStatus: () => ({ rows: [], omitted: 0, uncertain: false }), details: () => ({ ok: false as const, code: "not-found", message: "missing" }), plan: async () => ({ ok: true as const, value: preview }), prepare: () => ({ ok: true as const, value: { preview, execute: async () => { calls.push("execute"); return { ok: true, value: { operationId: "marketplace_preview", outcome: "committed" } }; } } }), discardPreview: async () => { calls.push("discard"); return { ok: true as const, value: undefined }; } },
      plugins: { list: () => [], details: () => ({ ok: false as const, code: "not-found", message: "missing" }), plan: async () => ({ ok: false as const, code: "unused", message: "unused" }), execute: async () => ({ ok: false as const, code: "unused", message: "unused" }), discardPreview: async () => ({ ok: true as const, value: undefined }) },
      recovery: { list: () => [], preview: async () => ({ ok: false as const, code: "unused", message: "unused" }), recover: async () => ({ ok: false as const, code: "unused", message: "unused" }) },
    } });
    const cancelled = await runPluginInProcess(project, ["marketplace", "add", "official", "--source", "github", "owner/repo"], { env: { PICC_CLAUDE_USER_DIR: userDir }, stdinIsTTY: false, services: services as never });
    expect(cancelled.code).toBe(2); expect(cancelled.stdout.join("\n")).toContain("Operation ID: marketplace_preview"); expect(cancelled.stdout.join("\n")).toContain("display-anchor=opaque-sha256:"); expect(cancelled.stdout.join("\n")).not.toContain("owner/repo"); expect(cancelled.stdout.join("\n")).toContain("Plugin tool-32 uses source kind npm"); expect(cancelled.stdout.join("\n")).not.toContain("not shown"); expect(cancelled.stderr.join("\n")).toContain("confirmation is unavailable on noninteractive input"); expect(calls).toEqual(["discard"]);
    const userCancelled = await runPluginInProcess(project, ["marketplace", "add", "official", "--source", "github", "owner/repo"], { env: { PICC_CLAUDE_USER_DIR: userDir }, stdinIsTTY: true, confirm: async () => false, services: services as never });
    expect(userCancelled.stderr.join("\n")).toContain("cancelled by the user"); expect(calls).toEqual(["discard", "discard"]);
    const committed = await runPluginInProcess(project, ["marketplace", "add", "official", "--source", "github", "owner/repo", "--yes"], { env: { PICC_CLAUDE_USER_DIR: userDir }, stdinIsTTY: false, services: services as never });
    expect(committed.code).toBe(0); expect(committed.stdout.join("\n")).toContain("No installed plugin code or loaded session changed"); expect(calls).toEqual(["discard", "discard", "execute"]);
    let writes = 0; const fallback: string[] = []; const outputFailure = await runPluginInventoryCli(["marketplace", "add", "official", "--source", "github", "owner/repo", "--yes"], { log: () => { writes++; if (writes === 2) throw new Error("receipt output failed"); }, error: (message) => fallback.push(message) }, { cwd: project, platform: "linux", env: { PICC_CLAUDE_USER_DIR: userDir }, services: services as never });
    expect(outputFailure).toBe(0); expect(fallback).toEqual(["Operation ID: marketplace_preview. Result output failed; run picc plugin recover marketplace_preview."]);
  });

  it("fails closed across marketplace and plugin preview output, cleanup, preparation, and confirmation failures", async () => {
    const { project, userDir } = inventoryFixture(); const env = { PICC_CLAUDE_USER_DIR: userDir };
    const marketplacePreview = { operationId: "marketplace_matrix", action: "add", confirmationDigest: `sha256:${"a".repeat(64)}`, registration: { name: "official", scope: "user", source: { kind: "github", repository: "owner/repo" }, profileKey: "profile-test", ownership: "picc-owned" }, snapshot: { snapshotId: "marketplace_exact", catalogDigest: `sha256:${"b".repeat(64)}`, trust: { targetDigest: `sha256:${"c".repeat(64)}` } }, catalog: { plugins: [], unsupportedEntries: 0, omittedEntries: 0 }, dependents: [], acknowledgement: "preserve-installations", settingsEffect: { setting: "extraKnownMarketplaces", effective: true, declarationOnly: false }, participants: [], consequences: ["change"] } as never;
    const pluginPreview = { operationId: "plugin_matrix", action: "enable", pluginId: "tool@official", scope: "user", confirmationDigest: `sha256:${"a".repeat(64)}`, dependencies: { selected: { pluginId: "tool@official", admitted: true, reasons: [] }, decisions: [], blocking: false, graph: [] }, executableComponents: [], removeDeclaration: false, removeData: false, participants: [], consequences: ["change"] } as never;
    for (const kind of ["marketplace", "plugin"] as const) {
      let execute = 0; let discardOk = true; let prepareOk = true; const calls: string[] = [];
      const services = () => ({ ok: true as const, value: { marketplaces: { listStatus: () => ({ rows: [], omitted: 0, uncertain: false }), details: () => ({ ok: false as const, code: "unused", message: "unused" }), plan: async () => ({ ok: true as const, value: marketplacePreview }), prepare: () => prepareOk ? { ok: true as const, value: { preview: marketplacePreview, execute: async () => { execute++; return { ok: true as const, value: { operationId: "marketplace_matrix", outcome: "committed" } }; } } } : { ok: false as const, code: "prepare-failed", message: "prepare failed" }, discardPreview: async () => { calls.push("discard"); return discardOk ? { ok: true as const, value: undefined } : { ok: false as const, code: "discard-failed", message: "discard failed" }; } }, plugins: { list: () => [], details: () => ({ ok: false as const, code: "unused", message: "unused" }), plan: async () => ({ ok: true as const, value: pluginPreview }), execute: async () => { execute++; return { ok: true as const, value: { operationId: "plugin_matrix", outcome: "committed" } }; }, discardPreview: async () => { calls.push("discard"); return discardOk ? { ok: true as const, value: undefined } : { ok: false as const, code: "discard-failed", message: "discard failed" }; } }, recovery: { list: () => [], preview: async () => ({ ok: false as const, code: "unused", message: "unused" }), recover: async () => ({ ok: false as const, code: "unused", message: "unused" }) } } });
      const args = kind === "marketplace" ? ["marketplace", "add", "official", "--source", "github", "owner/repo"] : ["enable", "tool@official"];
      const errors: string[] = []; const outputFailure = await runPluginInventoryCli([...args, "--yes"], { log: () => { throw new Error("preview output"); }, error: (message) => errors.push(message) }, { cwd: project, env, services: services as never }); expect(outputFailure).toBe(1); expect(errors.join("\n")).toContain("Preview output failed"); expect(execute).toBe(0);
      discardOk = false; const uncertainOutput: string[] = []; const outputCleanupFailed = await runPluginInventoryCli([...args, "--yes"], { log: () => { throw new Error("preview output"); }, error: (message) => uncertainOutput.push(message) }, { cwd: project, env, services: services as never }); expect(outputCleanupFailed).toBe(1); expect(uncertainOutput.join("\n")).toContain("cleanup is uncertain"); expect(uncertainOutput.join("\n")).not.toContain("Staging was discarded"); expect(execute).toBe(0);
      const cancelled = await runPluginInProcess(project, args, { env, stdinIsTTY: true, confirm: async () => false, services: services as never }); expect(cancelled.code).toBe(2); expect(cancelled.stderr.join("\n")).toContain("cleanup could not be confirmed"); expect(cancelled.stderr.join("\n")).not.toContain("recover"); expect(execute).toBe(0);
      const callbackFailed = await runPluginInProcess(project, args, { env, stdinIsTTY: true, confirm: async () => { throw new Error("prompt unavailable"); }, services: services as never }); expect(callbackFailed.code).toBe(2); expect(callbackFailed.stderr.join("\n")).toContain("confirmation was unavailable"); expect(callbackFailed.stderr.join("\n")).toContain("cleanup could not be confirmed"); expect(callbackFailed.stderr.join("\n")).not.toContain("Staging was discarded"); expect(execute).toBe(0);
      const unavailable = await runPluginInProcess(project, args, { env, stdinIsTTY: false, services: services as never }); expect(unavailable.code).toBe(2); expect(unavailable.stderr.join("\n")).toContain("cleanup could not be confirmed"); expect(unavailable.stderr.join("\n")).not.toContain("Staging was discarded"); expect(execute).toBe(0);
      if (kind === "marketplace") { prepareOk = false; const prepareFailed = await runPluginInProcess(project, [...args, "--yes"], { env, services: services as never }); expect(prepareFailed.code).toBe(1); expect(prepareFailed.stderr.join("\n")).toContain("cleanup is uncertain"); expect(prepareFailed.stderr.join("\n")).not.toContain("Staging was discarded"); expect(execute).toBe(0); prepareOk = true; (marketplacePreview as { catalog: { omittedEntries: number } }).catalog.omittedEntries = 1; const omitted = await runPluginInProcess(project, [...args, "--yes"], { env, services: services as never }); expect(omitted.code).toBe(1); expect(omitted.stderr.join("\n")).toContain("cleanup could not be confirmed"); expect(omitted.stderr.join("\n")).not.toContain("Staging was discarded"); expect(omitted.stdout).toEqual([]); (marketplacePreview as { catalog: { omittedEntries: number } }).catalog.omittedEntries = 0; }
      else { (pluginPreview as { executableComponents: string[] }).executableComponents = Array.from({ length: 1025 }, (_, index) => `commands:item:${index}`); const overflow = await runPluginInProcess(project, [...args, "--yes"], { env, services: services as never }); expect(overflow.code).toBe(1); expect(overflow.stderr.join("\n")).toContain("cleanup could not be confirmed"); expect(overflow.stderr.join("\n")).not.toContain("Staging was discarded"); expect(overflow.stdout).toEqual([]); }
      expect(calls.length).toBe(kind === "marketplace" ? 7 : 6); expect(execute).toBe(0);
    }
  });

  it("guards recovery preview output failure without changing pending state", async () => {
    const { project, userDir } = inventoryFixture(); let recovered = 0; const operationId = "plugin_recovery_output"; const preview = { operationId, producerSchema: "plugin-lifecycle", producerVersion: 1, confirmationSummary: {}, confirmationDigest: `sha256:${"a".repeat(64)}`, planDigest: `sha256:${"b".repeat(64)}`, completed: 0, rolledBack: 0, remaining: 1, actions: ["rollback"] } as never;
    const services = { marketplaces: { listStatus: () => ({ rows: [], omitted: 0, uncertain: false }), details: () => ({ ok: false as const, code: "unused", message: "unused" }), plan: async () => ({ ok: false as const, code: "unused", message: "unused" }), prepare: () => ({ ok: false as const, code: "unused", message: "unused" }), discardPreview: async () => ({ ok: true as const, value: undefined }) }, plugins: { list: () => [], details: () => ({ ok: false as const, code: "unused", message: "unused" }), plan: async () => ({ ok: false as const, code: "unused", message: "unused" }), execute: async () => ({ ok: false as const, code: "unused", message: "unused" }), discardPreview: async () => ({ ok: true as const, value: undefined }) }, recovery: { list: () => [{ operationId, status: "pending" }], preview: async () => ({ ok: true as const, value: preview }), recover: async () => { recovered++; return { ok: false as const, code: "unexpected", message: "unexpected" }; } } };
    const fallback: string[] = []; const code = await runPluginInventoryCli(["recover", operationId, "--rollback", "--yes"], { log: () => { throw new Error("recovery preview renderer"); }, error: (message) => fallback.push(message) }, { cwd: project, env: { PICC_CLAUDE_USER_DIR: userDir }, services: () => ({ ok: true as const, value: services as never }) });
    expect(code).toBe(1); expect(fallback).toEqual([`Operation ID: ${operationId}. Recovery preview output failed; pending state is unchanged and no recovery mutation was attempted.`]); expect(recovered).toBe(0); expect(services.recovery.list()).toHaveLength(1);
  });

  it("preserves pending operation identity when result rendering fails and reports bounded omissions exactly", async () => {
    const { project, userDir } = inventoryFixture(); const preview = { operationId: "plugin_pending_output", action: "enable", pluginId: "tool@official", scope: "user", dependencies: { selected: { admitted: true, reasons: [] }, blocking: false, graph: [] }, executableComponents: [], removeDeclaration: false, removeData: false, participants: [], consequences: [], confirmationDigest: `sha256:${"a".repeat(64)}` } as never;
    const pendingServices = { marketplaces: { listStatus: () => ({ rows: [], omitted: 0, uncertain: false }), details: () => ({ ok: false as const, code: "unused", message: "unused" }), plan: async () => ({ ok: false as const, code: "unused", message: "unused" }), prepare: () => ({ ok: false as const, code: "unused", message: "unused" }), discardPreview: async () => ({ ok: true as const, value: undefined }) }, plugins: { list: () => [], details: () => ({ ok: false as const, code: "unused", message: "unused" }), plan: async () => ({ ok: true as const, value: preview }), execute: async () => ({ ok: false as const, code: "pending-recovery", message: "plugin_pending_output has durable progress" }), discardPreview: async () => ({ ok: true as const, value: undefined }) }, recovery: { list: () => Array.from({ length: 103 }, (_, index) => ({ operationId: `plugin_${index}`, status: "pending" })), preview: async () => ({ ok: false as const, code: "unused", message: "unused" }), recover: async () => ({ ok: false as const, code: "unused", message: "unused" }) } };
    const output: string[] = []; const code = await runPluginInventoryCli(["enable", "tool@official", "--yes"], { log: (message) => output.push(message), error: () => { throw new Error("pending renderer failed"); } }, { cwd: project, platform: "linux", env: { PICC_CLAUDE_USER_DIR: userDir }, services: () => ({ ok: true as const, value: pendingServices as never }) }); expect(code).toBe(1); expect(output.at(-1)).toContain("Operation ID: plugin_pending_output");
    const recovery = await runPluginInProcess(project, ["recover"], { env: { PICC_CLAUDE_USER_DIR: userDir }, services: () => ({ ok: true as const, value: pendingServices as never }) }); expect(recovery.stdout.at(-1)).toBe("Pending lifecycle operations: total=103; omitted=3. Run picc plugin recover <exact-operation-id> to inspect one exact operation.");
    const marketplaceServices = { ...pendingServices, marketplaces: { ...pendingServices.marketplaces, listStatus: () => ({ rows: [], omitted: 7, uncertain: true }) } }; const marketplaces = await runPluginInProcess(project, ["marketplace", "list"], { env: { PICC_CLAUDE_USER_DIR: userDir }, services: () => ({ ok: true as const, value: marketplaceServices as never }) }); expect(marketplaces.stdout).toContain("… 7 marketplace rows not shown; rerun details with an exact name.");
  });

  it("reports production pending totals as unknown when raw journal observation is uncertain", async () => {
    const { project, userDir } = inventoryFixture(); const homeDir = path.dirname(project); const identities = projectIdentities(project); const locations = createLifecycleLocations({ homeDir, profilePath: userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: identities.at(-1)!, checkoutFamilyPath: identities[0]! } }); if (!locations.ok) throw new Error(locations.error.message); const established = await establishOwnedStateStore(locations.value, homeDir); if (!established.ok) throw new Error(established.message);
    write(path.join(established.value.journalsRoot, "invalid journal name.json"), "{}");
    const result = await runPluginInProcess(project, ["recover"], { env: { PICC_CLAUDE_USER_DIR: userDir }, homeDir }); expect(result.code).toBe(1); expect(result.stdout.join("\n")).toContain("exact total unknown"); expect(result.stdout.join("\n")).toContain("additional evidence may have been omitted"); expect(result.stdout.join("\n")).not.toContain("No pending lifecycle operations");
  });

  it("returns success for requested recovery completion and terminal failed-receipt inspection", async () => {
    const { project, userDir } = inventoryFixture(); let recovered = 0; const summary = { action: "enable", pluginId: "tool@official", scope: "user", settingsEffect: { requested: true, effective: true, declarationOnly: false }, mutableRecordKey: "record", participants: [{ kind: "plugin-settings", effect: "replace" }] }; const base = { operationId: "plugin_recovery", producerSchema: "plugin-lifecycle", producerVersion: 1, confirmationSummary: summary, confirmationDigest: `sha256:${"a".repeat(64)}`, planDigest: `sha256:${"b".repeat(64)}`, completed: 0, rolledBack: 0, remaining: 1 };
    const services = (terminal = false) => ({ marketplaces: { listStatus: () => ({ rows: [], omitted: 0, uncertain: false }), details: () => ({ ok: false as const, code: "unused", message: "unused" }), plan: async () => ({ ok: false as const, code: "unused", message: "unused" }), prepare: () => ({ ok: false as const, code: "unused", message: "unused" }), discardPreview: async () => ({ ok: true as const, value: undefined }) }, plugins: { list: () => [], details: () => ({ ok: false as const, code: "unused", message: "unused" }), plan: async () => ({ ok: false as const, code: "unused", message: "unused" }), execute: async () => ({ ok: false as const, code: "unused", message: "unused" }), discardPreview: async () => ({ ok: true as const, value: undefined }) }, recovery: { list: () => [], preview: async () => ({ ok: true as const, value: terminal ? { ...base, remaining: 0, actions: [], terminalOutcome: "failed-before-commit" } : { ...base, actions: ["complete"] } }), recover: async () => { recovered++; return { ok: true as const, value: { operationId: "plugin_recovery", producerSchema: "plugin-lifecycle", outcome: terminal ? "failed-before-commit" : "committed", confirmationSummary: summary } }; } } });
    const completed = await runPluginInProcess(project, ["recover", "plugin_recovery", "--complete", "--yes"], { env: { PICC_CLAUDE_USER_DIR: userDir }, services: () => ({ ok: true as const, value: services() as never }) }); expect(completed.code).toBe(0); expect(completed.stdout.join("\n")).toContain("Chosen recovery action/result: complete");
    const terminal = await runPluginInProcess(project, ["recover", "plugin_recovery"], { env: { PICC_CLAUDE_USER_DIR: userDir }, services: () => ({ ok: true as const, value: services(true) as never }) }); expect(terminal.code).toBe(0); expect(terminal.stdout.join("\n")).toContain("Outcome: failed-before-commit"); expect(recovered).toBe(2);
  });

  it("rejects malformed, noncanonical, unknown, and wrong-record selectors before service mutation", async () => {
    const { project, userDir } = inventoryFixture(); const homeDir = path.dirname(project); let compositions = 0; const services = () => { compositions++; throw new Error("selector reached services"); };
    const encoded = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");
    const foreignRoot = path.join(userDir, "plugins", "cache", "foreign", "1.0.0"); write(path.join(foreignRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "foreign", version: "1.0.0" })); write(path.join(userDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "foreign@official": [{ scope: "user", installPath: foreignRoot, version: "1.0.0" }] } }));
    const marketplaceRoot = path.join(project, "foreign-marketplace"); write(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "foreign-market", owner: { name: "Foreign" }, plugins: [] })); write(path.join(userDir, "plugins", "known_marketplaces.json"), JSON.stringify({ "foreign-market": { source: { source: "directory", path: marketplaceRoot } } }));
    const cases = [
      ["marketplace", "refresh", "official", "--selector", "eA", "--yes"],
      ["marketplace", "remove", "official", "--selector", encoded(`marketplace-${"a".repeat(64)}`), "--preserve-installed", "yes", "--yes"],
      ["enable", "tool@official", "--selector", encoded({ pluginId: "other@official", owner: "picc-owned", scope: "user" }), "--yes"],
      ["enable", "tool@official", "--selector", encodePluginStableSelector({ pluginId: "tool@official", owner: "picc-owned", scope: "user" }), "--yes"],
      ["enable", "foreign@official", "--selector", encodePluginStableSelector({ pluginId: "foreign@official", owner: "picc-owned", scope: "local" }), "--yes"],
      ["marketplace", "refresh", "foreign-market", "--selector", encoded(`marketplace-${"b".repeat(64)}`), "--yes"],
    ];
    for (const args of cases) { const result = await runPluginInProcess(project, args, { env: { PICC_CLAUDE_USER_DIR: userDir }, homeDir, services: services as never }); expect(result.code).toBe(2); expect(result.stderr.join("\n")).toContain("invalid-selector"); expect(result.stderr.join("\n")).not.toContain("readonly"); }
    expect(compositions).toBe(0); expect(fs.existsSync(path.join(homeDir, ".picc"))).toBe(false);
  });

  it("refuses plugin mutations when imported ownership evidence is malformed or omitted", async () => {
    for (const fixture of ["malformed", "overflow", "omission"] as const) {
      const { project, userDir } = inventoryFixture(); const homeDir = path.dirname(project); const installedFile = path.join(userDir, "plugins", "installed_plugins.json");
      if (fixture === "malformed") write(installedFile, "{ malformed");
      else if (fixture === "overflow") write(installedFile, JSON.stringify({ version: 2, plugins: Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`plugin-${index}@official`, [{ scope: "user", installPath: path.join(userDir, "cache"), version: "1.0.0" }]])) }));
      else write(installedFile, JSON.stringify({ version: 2, plugins: { [`${"a".repeat(300)}@official`]: [{ scope: "user", installPath: path.join(userDir, "cache"), version: "1.0.0" }] } }));
      let compositions = 0; const options = { env: { PICC_CLAUDE_USER_DIR: userDir }, homeDir, services: (() => { compositions++; throw new Error("uncertain plugin ownership reached composition"); }) as never };
      const malformedSelector = await runPluginInProcess(project, ["enable", "target@official", "--selector", "eA", "--yes"], options); expect(malformedSelector.code).toBe(2); expect(malformedSelector.stderr.join("\n")).toContain("invalid-selector");
      for (const args of [["install", "target@official", "--yes"], ["update", "target@official", "--yes"], ["enable", "target@official", "--yes"], ["disable", "target@official", "--yes"], ["uninstall", "target@official", "--remove-declaration", "no", "--remove-data", "no", "--yes"]]) { const result = await runPluginInProcess(project, args, options); expect(result.code).toBe(1); expect(result.stderr.join("\n")).toContain("imported-ownership-uncertain"); expect(result.stderr.join("\n")).toContain(fixture === "omission" ? "omitted by safe bounds" : "repair the malformed state outside PiCC"); expect(result.stderr.join("\n")).toContain("passive picc plugin list or interactive /doctor"); expect(result.stderr.join("\n")).toContain("No acquisition, trust approval, write, staging, adoption, or service composition was attempted."); }
      expect(compositions).toBe(0); expect(fs.existsSync(path.join(homeDir, ".picc"))).toBe(false);
    }
  });

  it("refuses marketplace mutations when registration ownership evidence is malformed, unreadable, or omitted", async () => {
    for (const fixture of ["malformed", "unreadable", "overflow", "saturated"] as const) {
      const { project, userDir } = inventoryFixture(); const homeDir = path.dirname(project); const registrationFile = path.join(userDir, "plugins", "known_marketplaces.json");
      if (fixture === "malformed") write(registrationFile, "{ malformed");
      else if (fixture === "overflow") write(registrationFile, JSON.stringify(Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`market-${index}`, { source: { source: "github", repo: `owner/repo-${index}` } }]))));
      else write(registrationFile, JSON.stringify(Object.fromEntries(Array.from({ length: 160 }, (_, index) => [`market-${index}`, { source: { source: "github" } }]))));
      const open = fs.openSync; if (fixture === "unreadable") fs.openSync = ((target: fs.PathLike, ...rest: unknown[]) => path.resolve(String(target)) === path.resolve(registrationFile) ? (() => { throw new Error("denied"); })() : open(target, ...(rest as [fs.OpenMode, fs.Mode?]))) as typeof fs.openSync;
      let compositions = 0; const options = { env: { PICC_CLAUDE_USER_DIR: userDir }, homeDir, services: (() => { compositions++; throw new Error("uncertain marketplace ownership reached composition"); }) as never };
      try {
        for (const args of [["marketplace", "list"], ["marketplace", "details", "missing-market"]]) { const result = await runPluginInProcess(project, args, { env: options.env, homeDir }); const text = `${result.stdout.join("\n")}\n${result.stderr.join("\n")}`; expect(result.code).toBe(1); expect(text).toContain("Marketplace registration or catalog-selection evidence is incomplete"); expect(text).not.toContain("No marketplaces are registered"); expect(text).not.toContain("PiCC marketplace not found"); if (args[1] === "details") expect(text).toContain("inconclusive"); }
        for (const args of [["marketplace", "add", "official", "--source", "local-directory", project, "--yes"], ["marketplace", "refresh", "official", "--yes"], ["marketplace", "remove", "official", "--preserve-installed", "yes", "--yes"], ["install", "target@official", "--yes"], ["update", "target@official", "--yes"]]) { const result = await runPluginInProcess(project, args, options); expect(result.code).toBe(1); expect(result.stderr.join("\n")).toContain("marketplace-ownership-uncertain"); expect(result.stderr.join("\n")).toContain("Marketplace registration or catalog-selection evidence is incomplete"); expect(result.stderr.join("\n")).toContain("picc plugin marketplace list/details"); }
      } finally { fs.openSync = open; }
      expect(compositions).toBe(0); expect(fs.existsSync(path.join(homeDir, ".picc"))).toBe(false);
    }
  });

  it("blocks marketplace-dependent mutations on unreadable, malformed, or bounded settings authority before composition", async () => {
    for (const fixture of ["malformed", "unreadable", "omitted"] as const) {
      const { project, userDir } = inventoryFixture(); const homeDir = path.dirname(project); const settingsFile = path.join(project, ".claude", "settings.json");
      if (fixture === "malformed") write(settingsFile, "{ malformed");
      else if (fixture === "unreadable") write(settingsFile, JSON.stringify({ extraKnownMarketplaces: {} }));
      else write(settingsFile, JSON.stringify({ extraKnownMarketplaces: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`market-${index}`, { source: { source: "github", repo: `owner/repo-${index}` } }])) }));
      const read = fs.readFileSync; if (fixture === "unreadable") fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => typeof target !== "number" && path.resolve(String(target)) === path.resolve(settingsFile) ? (() => { throw new Error("denied"); })() : read(target, ...(rest as []))) as typeof fs.readFileSync;
      let compositions = 0; const options = { env: { PICC_CLAUDE_USER_DIR: userDir }, homeDir, services: (() => { compositions++; return { ok: false as const, code: "counted", message: "composition reached" }; }) as never };
      try {
        for (const args of [["marketplace", "list"], ["marketplace", "details", "new-market"]]) { const result = await runPluginInProcess(project, args, { env: options.env, homeDir }); const text = `${result.stdout.join("\n")}\n${result.stderr.join("\n")}`; expect(result.code).toBe(1); expect(text).toContain("Marketplace registration or catalog-selection evidence is incomplete"); expect(text).not.toContain("No marketplaces are registered"); expect(text).not.toContain("PiCC marketplace not found"); if (args[1] === "details") expect(text).toContain("inconclusive"); }
        for (const args of [["marketplace", "add", "new-market", "--source", "local-directory", project, "--yes"], ["marketplace", "refresh", "new-market", "--yes"], ["marketplace", "remove", "new-market", "--preserve-installed", "yes", "--yes"], ["install", "target@new-market", "--yes"], ["update", "target@new-market", "--yes"]]) { const result = await runPluginInProcess(project, args, options); expect(result.code).toBe(1); expect(result.stderr.join("\n")).toContain("Marketplace registration or catalog-selection evidence is incomplete"); expect(result.stderr.join("\n")).toContain("picc plugin marketplace list/details"); if (fixture !== "omitted") expect(result.stderr.join("\n")).toContain("settings authority"); }
        const malformedSelector = await runPluginInProcess(project, ["marketplace", "refresh", "new-market", "--selector", "eA", "--yes"], options); expect(malformedSelector.code).toBe(2); expect(malformedSelector.stderr.join("\n")).toContain("invalid-selector");
      } finally { fs.readFileSync = read; }
      expect(compositions).toBe(0); expect(fs.existsSync(path.join(homeDir, ".picc"))).toBe(false);
    }
  });

  it("does not promote ordinary malformed or oversized catalog content to marketplace authority uncertainty", async () => {
    for (const fixture of ["malformed", "oversized"] as const) {
      const { project, userDir } = inventoryFixture(); const root = path.join(project, "catalog"); write(path.join(userDir, "plugins", "known_marketplaces.json"), JSON.stringify({ official: { source: { source: "directory", path: root } } })); write(path.join(project, ".claude", "settings.json"), JSON.stringify({ cleanupPeriodDays: "invalid" }));
      const plugins = fixture === "malformed" ? Array.from({ length: 160 }, () => 42) : Array.from({ length: 1025 }, (_, index) => ({ name: `plugin-${index}`, source: `./plugin-${index}` })); write(path.join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "official", owner: { name: "Fixture" }, plugins }));
      let compositions = 0; const services = (() => { compositions++; return { ok: false as const, code: "counted", message: "composition reached" }; }) as never;
      for (const args of [["install", "target@official", "--yes"], ["update", "target@official", "--yes"]]) { const result = await runPluginInProcess(project, args, { env: { PICC_CLAUDE_USER_DIR: userDir }, services }); expect(result.stderr.join("\n")).toContain("composition reached"); expect(result.stderr.join("\n")).not.toContain("marketplace-ownership-uncertain"); }
      expect(compositions).toBe(2); expect(fs.existsSync(path.join(path.dirname(project), ".picc"))).toBe(false);
    }
  });

  it("applies marketplace uncertainty only to marketplace-dependent plugin operations", async () => {
    const { project, userDir } = inventoryFixture(); write(path.join(project, ".claude", "settings.json"), "{ malformed"); let compositions = 0; const services = (() => { compositions++; return { ok: false as const, code: "counted", message: "composition reached" }; }) as never; const options = { env: { PICC_CLAUDE_USER_DIR: userDir }, services };
    for (const args of [["install", "target@official", "--yes"], ["update", "target@official", "--yes"]]) { const result = await runPluginInProcess(project, args, options); expect(result.stderr.join("\n")).toContain("marketplace-ownership-uncertain"); }
    for (const args of [["enable", "target@official", "--yes"], ["disable", "target@official", "--yes"], ["uninstall", "target@official", "--remove-declaration", "no", "--remove-data", "no", "--yes"]]) { const result = await runPluginInProcess(project, args, options); expect(result.stderr.join("\n")).toContain("composition reached"); expect(result.stderr.join("\n")).not.toContain("marketplace-ownership-uncertain"); }
    expect(compositions).toBe(3);
  });

  it("gives truthful installed-state guidance for unsupported and unreadable authority", async () => {
    for (const fixture of ["unsupported", "unreadable"] as const) {
      const { project, userDir } = inventoryFixture(); const installedFile = path.join(userDir, "plugins", "installed_plugins.json"); write(installedFile, JSON.stringify({ version: 99, plugins: {} })); const open = fs.openSync; if (fixture === "unreadable") fs.openSync = ((target: fs.PathLike, ...rest: unknown[]) => path.resolve(String(target)) === path.resolve(installedFile) ? (() => { throw new Error("denied"); })() : open(target, ...(rest as [fs.OpenMode, fs.Mode?]))) as typeof fs.openSync;
      let compositions = 0;
      try { for (const args of [["install", "target@official", "--yes"], ["update", "target@official", "--yes"], ["enable", "target@official", "--yes"], ["disable", "target@official", "--yes"], ["uninstall", "target@official", "--remove-declaration", "no", "--remove-data", "no", "--yes"]]) { const result = await runPluginInProcess(project, args, { env: { PICC_CLAUDE_USER_DIR: userDir }, services: (() => { compositions++; throw new Error("composition reached"); }) as never }); const text = result.stderr.join("\n"); expect(text).toContain(fixture === "unsupported" ? "update PiCC or report the unsupported installed-plugin-state format" : "check permissions and access"); expect(text).toContain("passive picc plugin list or interactive /doctor"); expect(text).not.toContain("repair"); } } finally { fs.openSync = open; }
      expect(compositions).toBe(0); expect(fs.existsSync(path.join(path.dirname(project), ".picc"))).toBe(false);
    }
  });

  it("uses seed-specific read-only marketplace guidance", async () => {
    const { project, userDir } = inventoryFixture(); const homeDir = path.dirname(project); const seed = path.join(homeDir, "seed"); const sourceRoot = path.join(seed, "official"); write(path.join(seed, "known_marketplaces.json"), JSON.stringify({ official: { source: { source: "directory", path: sourceRoot } } })); write(path.join(sourceRoot, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "official", owner: { name: "Seed" }, plugins: [] }));
    let compositions = 0; const result = await runPluginInProcess(project, ["marketplace", "add", "official", "--source", "local-directory", sourceRoot, "--yes"], { env: { PICC_CLAUDE_USER_DIR: userDir, CLAUDE_CODE_PLUGIN_SEED_DIR: seed }, homeDir, services: (() => { compositions++; throw new Error("seed reached composition"); }) as never });
    expect(result.code).toBe(1); expect(result.stderr.join("\n")).toContain("seed-readonly"); expect(result.stderr.join("\n")).toContain("manage it at its configured source"); expect(result.stderr.join("\n")).not.toContain("use Claude Code"); expect(compositions).toBe(0); expect(fs.existsSync(path.join(homeDir, ".picc"))).toBe(false);
  });

  it("keeps copied foreign selectors passive and refuses every imported or managed target mutation before composition", async () => {
    const pluginActions = (identity: string): string[][] => [["install", identity, "--yes"], ["enable", identity, "--yes"], ["disable", identity, "--yes"], ["update", identity, "--yes"], ["uninstall", identity, "--remove-declaration", "no", "--remove-data", "no", "--yes"]];
    for (const scope of ["user", "managed"] as const) {
      const { project, userDir } = inventoryFixture(); const homeDir = path.dirname(project); const pluginRoot = path.join(userDir, "plugins", "cache", scope, "foreign", "1.0.0");
      write(path.join(userDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "foreign@official": [{ scope, installPath: pluginRoot, version: "1.0.0" }] } }));
      write(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "foreign", version: "1.0.0" })); write(path.join(project, ".claude", "settings.json"), "{ malformed");
      let compositions = 0; const options = { env: { PICC_CLAUDE_USER_DIR: userDir }, homeDir, services: (() => { compositions++; throw new Error("foreign target reached composition"); }) as never };
      const listed = await runPluginInProcess(project, ["details", "foreign@official"], options); const selector = /selector=([A-Za-z0-9_-]+)/u.exec(listed.stdout.join("\n"))?.[1]; expect(selector).toBeDefined();
      const copied = await runPluginInProcess(project, ["details", selector!], options); expect(copied.code).toBe(0); expect(copied.stdout.join("\n")).toContain(`owner=${scope === "managed" ? "managed" : "claude-imported-readonly"}`);
      for (const args of pluginActions("foreign@official")) { const result = await runPluginInProcess(project, args, options); expect(result.code).toBe(1); expect(result.stderr.join("\n")).toContain(scope === "managed" ? "managed-readonly" : "imported-readonly"); expect(result.stderr.join("\n")).toContain("No acquisition, trust approval, write, staging, or adoption was attempted"); }
      const selectedActions = [["enable", "foreign@official", "--selector", selector!, "--yes"], ["disable", "foreign@official", "--selector", selector!, "--yes"], ["update", "foreign@official", "--selector", selector!, "--yes"], ["uninstall", "foreign@official", "--selector", selector!, "--remove-declaration", "no", "--remove-data", "no", "--yes"]];
      for (const args of selectedActions) { const result = await runPluginInProcess(project, args, options); expect(result.code).toBe(1); expect(result.stderr.join("\n")).toContain(scope === "managed" ? "managed-readonly" : "imported-readonly"); expect(result.stderr.join("\n")).not.toContain("invalid-selector"); }
      expect(compositions).toBe(0); expect(fs.existsSync(path.join(homeDir, ".picc"))).toBe(false);
    }
    for (const managed of [false, true]) {
      const { project, userDir } = inventoryFixture(); const homeDir = path.dirname(project); const marketplaceRoot = path.join(project, "foreign-marketplace"); write(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "official", owner: { name: "Foreign" }, plugins: [] }));
      if (!managed) write(path.join(userDir, "plugins", "known_marketplaces.json"), JSON.stringify({ official: { source: { source: "directory", path: marketplaceRoot } } })); write(path.join(project, ".claude", "settings.json"), "{ malformed");
      const managedFile = path.join(homeDir, "managed-settings.json"); if (managed) write(managedFile, JSON.stringify({ extraKnownMarketplaces: { official: { source: { source: "directory", path: marketplaceRoot } } } }));
      const stat = fs.statSync; const read = fs.readFileSync; if (managed) { fs.statSync = ((target: fs.PathLike, ...rest: unknown[]) => String(target).endsWith("managed-settings.json") && String(target) !== managedFile ? stat(managedFile, ...(rest as [])) : stat(target, ...(rest as []))) as typeof fs.statSync; fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => typeof target !== "number" && String(target).endsWith("managed-settings.json") && String(target) !== managedFile ? read(managedFile, ...(rest as [])) : read(target, ...(rest as []))) as typeof fs.readFileSync; }
      let compositions = 0; const options = { env: { PICC_CLAUDE_USER_DIR: userDir }, homeDir, services: (() => { compositions++; throw new Error("foreign marketplace reached composition"); }) as never };
      try { for (const args of [["marketplace", "add", "official", "--source", "local-directory", marketplaceRoot, "--yes"], ["marketplace", "refresh", "official", "--yes"], ["marketplace", "remove", "official", "--preserve-installed", "yes", "--yes"]]) { const result = await runPluginInProcess(project, args, options); expect(result.code).toBe(1); expect(result.stderr.join("\n")).toContain(managed ? "managed-readonly" : "imported-readonly"); } } finally { fs.statSync = stat; fs.readFileSync = read; }
      expect(compositions).toBe(0); expect(fs.existsSync(path.join(homeDir, ".picc"))).toBe(false);
    }
  });

  it("rejects a production preview after another composition changes its observed authority", async () => {
    const value = localLifecycleFixture(); const options = { env: { PICC_CLAUDE_USER_DIR: value.userDir }, homeDir: value.homeDir, stdinIsTTY: true }; let competingCode: number | undefined;
    const stale = await runPluginInProcess(value.project, ["marketplace", "add", "official", "--source", "local-directory", value.marketplace], { ...options, confirm: async () => { competingCode = (await runPluginInProcess(value.project, ["marketplace", "add", "official", "--source", "local-directory", value.marketplace, "--yes"], { ...options, stdinIsTTY: false })).code; return true; } });
    expect(competingCode).toBe(0); expect(stale.code).toBe(1); expect(stale.stderr.join("\n")).toContain("stale-observation"); const details = await runPluginInProcess(value.project, ["marketplace", "details", "official"], { ...options, stdinIsTTY: false }); expect(details.code).toBe(0);
  });

  it("commits a retained local marketplace and plugin through fresh production composition", async () => {
    const value = localLifecycleFixture(); const options = { env: { PICC_CLAUDE_USER_DIR: value.userDir }, homeDir: value.homeDir, stdinIsTTY: false };
    const added = await runPluginInProcess(value.project, ["marketplace", "add", "official", "--source", "local-directory", value.marketplace, "--yes"], options);
    expect(added.code, added.stderr.join("\n")).toBe(0); expect(added.stdout.join("\n")).toContain("Marketplace state changed");
    for (const axis of ["Operation/action/target", "Selected marketplace scope/selector", "Source authority", "Immutable snapshot", "Catalog declarations", "Dependencies/dependents", "Settings/declaration", "Destructive choice", "Participants", "Expected state changes"]) expect(added.stdout.join("\n")).toContain(axis);

    const ambient = path.join(value.project, "ambient"); write(path.join(ambient, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "official", owner: { name: "Contradiction" }, plugins: [{ name: "tool", source: { source: "npm", package: "ambient-tool", registry: "https://registry.npmjs.org", version: "99.0.0" } }] }));
    write(path.join(value.project, ".claude", "settings.json"), JSON.stringify({ extraKnownMarketplaces: { official: { source: { source: "directory", path: "./ambient" } } } }));
    const marketplaceState = await runPluginInProcess(value.project, ["marketplace", "list"], options);
    const installedStdout: string[] = []; const installedStderr: string[] = []; let installedWrites = 0; const installedCode = await runPluginInventoryCli(["install", "tool@official", "--yes"], { log: (message) => { installedWrites++; if (installedWrites === 2) throw new Error("committed receipt output failed"); installedStdout.push(message); }, error: (message) => installedStderr.push(message) }, { cwd: value.project, platform: "linux", ...options }); const installed = { code: installedCode, stdout: installedStdout, stderr: installedStderr };
    expect(installed.code, `${installed.stderr.join("\n")}\n${marketplaceState.stdout.join("\n")}`).toBe(0);
    write(path.join(value.marketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "official", owner: { name: "Contradiction" }, plugins: [{ name: "tool", source: { source: "npm", package: "ambient-tool", registry: "https://registry.npmjs.org", version: "99.0.0" } }] }));
    write(path.join(value.marketplace, "plugins", "tool", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tool", version: "99.0.0" })); expect(installed.stderr.join("\n")).toContain("Result output failed; run picc plugin recover");
    expect(installed.stdout.join("\n")).toContain("requested=relative; durable=marketplace-relative"); expect(fs.existsSync(value.runtimeCanary)).toBe(false);
    for (const axis of ["Operation/action/target", "Target scope/record selector", "Selected marketplace selector", "Immutable catalog", "Source authority", "Immutable revision", "Digests", "Executable content", "Dependencies", "Trust", "Default/enablement", "Settings/declaration", "Destructive choices", "Participants", "Expected state changes"]) expect(installed.stdout.join("\n")).toContain(axis);

    const reconstructed = await runPluginInProcess(value.project, ["details", "tool@official"], options);
    expect(reconstructed.code, reconstructed.stderr.join("\n")).toBe(0); expect(reconstructed.stdout.join("\n")).toContain("Plugin: tool@official"); expect(reconstructed.stdout.join("\n")).toContain("version=1.0.0");
    const pluginSelector = /selector=([A-Za-z0-9_-]+)/u.exec(reconstructed.stdout.join("\n"))?.[1]; const marketplaceSelector = /Selected marketplace scope\/selector: user; ([A-Za-z0-9_-]+)/u.exec(added.stdout.join("\n"))?.[1]; expect(pluginSelector).toBeDefined(); expect(marketplaceSelector).toBeDefined();
    let passiveCompositions = 0; const selectedDetails = await runPluginInProcess(value.project, ["details", pluginSelector!], { ...options, services: (() => { passiveCompositions++; throw new Error("selector details composed services"); }) as never }); expect(selectedDetails.code).toBe(0); expect(selectedDetails.stdout.join("\n")).toContain(`selector=${pluginSelector}`); expect(passiveCompositions).toBe(0);
    write(path.join(value.userDir, "plugins", "installed_plugins.json"), "{ malformed"); const exactOwnedUncertain = await runPluginInProcess(value.project, ["disable", "tool@official", "--selector", pluginSelector!, "--yes"], options); expect(exactOwnedUncertain.code).toBe(1); expect(exactOwnedUncertain.stderr.join("\n")).toContain("imported-ownership-uncertain"); expect(exactOwnedUncertain.stderr.join("\n")).not.toContain("invalid-selector"); fs.rmSync(path.join(value.userDir, "plugins", "installed_plugins.json"));
    const foreignSameNameRoot = path.join(value.userDir, "plugins", "cache", "managed", "tool", "9.0.0"); write(path.join(foreignSameNameRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tool", version: "9.0.0" })); write(path.join(value.userDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "tool@official": [{ scope: "managed", installPath: foreignSameNameRoot, version: "9.0.0" }] } })); const exactOwnedDisable = await runPluginInProcess(value.project, ["disable", "tool@official", "--selector", pluginSelector!, "--yes"], options); expect(exactOwnedDisable.code).toBe(1); expect(exactOwnedDisable.stderr.join("\n")).toContain("unsafe-identity-wide-setting"); expect(exactOwnedDisable.stderr.join("\n")).not.toContain("managed-readonly"); fs.rmSync(path.join(value.userDir, "plugins", "installed_plugins.json"));
    const committedOperationId = /Operation ID: (plugin_[A-Za-z0-9_-]+)/u.exec(installed.stdout.join("\n"))?.[1]; expect(committedOperationId).toBeDefined(); const freshReceipt = runSourcePluginWithEnv(value.project, ["recover", committedOperationId!], { PICC_CLAUDE_USER_DIR: value.userDir, HOME: value.homeDir, USERPROFILE: value.homeDir }); expect(freshReceipt.status, freshReceipt.stderr).toBe(0); expect(freshReceipt.stdout).toContain("Outcome: committed");
    const freshProcess = runSourcePluginWithEnv(value.project, ["details", "tool@official"], { PICC_CLAUDE_USER_DIR: value.userDir, HOME: value.homeDir, USERPROFILE: value.homeDir }); expect(freshProcess.status, freshProcess.stderr).toBe(0); expect(freshProcess.stdout).toContain("version=1.0.0");
    expect(JSON.parse(fs.readFileSync(path.join(value.userDir, "settings.json"), "utf8"))).toMatchObject({ enabledPlugins: { "tool@official": true } });
    fs.rmSync(path.join(value.project, ".claude", "settings.json"));
    write(path.join(value.marketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "official", owner: { name: "Example" }, plugins: [{ name: "bare", source: "./plugins/bare", version: "2.0.0", defaultEnabled: false }, { name: "tool", source: "./plugins/tool", defaultEnabled: false }] }));
    write(path.join(value.marketplace, "plugins", "tool", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tool", version: "2.0.0", skills: "./skills", commands: "./commands", hooks: "./hooks/hooks.json", mcpServers: "./.mcp.json" }));
    const refreshed = await runPluginInProcess(value.project, ["marketplace", "refresh", "official", "--selector", marketplaceSelector!, "--yes"], options); expect(refreshed.code, refreshed.stderr.join("\n")).toBe(0);
    const updated = await runPluginInProcess(value.project, ["update", "tool@official", "--selector", pluginSelector!, "--marketplace-selector", marketplaceSelector!, "--yes"], options); expect(updated.code, updated.stderr.join("\n")).toBe(0); expect(updated.stdout.join("\n")).toContain("Immutable revision: marketplace-"); expect(fs.existsSync(value.runtimeCanary)).toBe(false);
    const updatedDetails = await runPluginInProcess(value.project, ["details", "tool@official"], options); expect(updatedDetails.stdout.join("\n")).toContain("version=2.0.0"); expect(JSON.parse(fs.readFileSync(path.join(value.userDir, "settings.json"), "utf8"))).toMatchObject({ enabledPlugins: { "tool@official": true } });
    const identities = projectIdentities(value.project); const locations = createLifecycleLocations({ homeDir: value.homeDir, profilePath: value.userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: identities.at(-1)!, checkoutFamilyPath: identities[0]! } }); if (!locations.ok) throw new Error(locations.error.message); const established = await establishOwnedStateStore(locations.value, value.homeDir); if (!established.ok) throw new Error(established.message);
    const registrationFiles: string[] = []; const visit = (directory: string): void => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const target = path.join(directory, entry.name); if (entry.isDirectory()) visit(target); else if (entry.name.endsWith(".json") && fs.readFileSync(target, "utf8").includes('"schema":"marketplace-registration"')) registrationFiles.push(target); } }; visit(established.value.recordsRoot); expect(registrationFiles).toHaveLength(1);
    const envelope = JSON.parse(fs.readFileSync(registrationFiles[0]!, "utf8")) as { payload: OwnedMarketplaceRecord }; const checkoutFamilyKey = locations.value.checkoutFamilyKey; if (checkoutFamilyKey === undefined) throw new Error("missing checkout identity"); const projectRecord: OwnedMarketplaceRecord = { ...envelope.payload, scope: "project", checkoutFamilyKey, projectKey: checkoutFamilyKey }; const codec = createOwnedMarketplaceCodec(locations.value.profileKey); const encodedRecord = createRecordEnvelope(codec, "picc-owned", ownedMarketplaceScopeKey(projectRecord), projectRecord); if (!encodedRecord.ok) throw new Error(encodedRecord.message); const partition = ownedRecordPartition(established.value, "picc-owned", ownedMarketplaceScopeKey(projectRecord)); if (!partition.ok) throw new Error(partition.message); fs.mkdirSync(partition.value, { recursive: true }); fs.writeFileSync(path.join(partition.value, path.basename(registrationFiles[0]!)), encodedRecord.value.bytes);
    write(path.join(value.project, ".claude", "settings.json"), JSON.stringify({ extraKnownMarketplaces: { official: { source: { source: "directory", path: "./marketplace" } } } })); const projectMarketplaceSelector = Buffer.from(ownedMarketplaceScopeKey(projectRecord), "utf8").toString("base64url");
    const ambiguousUpdate = await runPluginInProcess(value.project, ["update", "tool@official", "--selector", pluginSelector!, "--yes"], options); expect(ambiguousUpdate.code).toBe(1); expect(ambiguousUpdate.stderr.join("\n")).toContain("catalog-selection-required"); expect(ambiguousUpdate.stderr.join("\n")).toContain("picc plugin marketplace details official"); expect(ambiguousUpdate.stderr.join("\n")).toContain("--selector identifies the predecessor installed plugin record, while --marketplace-selector identifies the current registration");
    const scopedUpdate = await runPluginInProcess(value.project, ["update", "tool@official", "--selector", pluginSelector!, "--marketplace-selector", marketplaceSelector!, "--yes"], options); expect(scopedUpdate.code, scopedUpdate.stderr.join("\n")).toBe(0);
    const disabled = await runPluginInProcess(value.project, ["disable", "tool@official", "--selector", pluginSelector!, "--yes"], options); expect(disabled.code, disabled.stderr.join("\n")).toBe(0); expect(fs.existsSync(value.runtimeCanary)).toBe(false); const enabled = await runPluginInProcess(value.project, ["enable", "tool@official", "--selector", pluginSelector!, "--yes"], options); expect(enabled.code, enabled.stderr.join("\n")).toBe(0); expect(fs.existsSync(value.runtimeCanary)).toBe(false);
    const manifestless = await runPluginInProcess(value.project, ["install", "bare@official", "--marketplace-selector", marketplaceSelector!, "--yes"], options); expect(manifestless.code, manifestless.stderr.join("\n")).toBe(0); expect(manifestless.stdout.join("\n")).toContain("Immutable revision: marketplace-");
    const manifestlessDetails = await runPluginInProcess(value.project, ["details", "bare@official"], options); expect(manifestlessDetails.stdout.join("\n")).toContain("Immutable desired content: revision=2.0.0"); const bareSelector = /selector=([A-Za-z0-9_-]+)/u.exec(manifestlessDetails.stdout.join("\n"))?.[1]; expect(bareSelector).toBeDefined();
    const removedTool = await runPluginInProcess(value.project, ["uninstall", "tool@official", "--selector", pluginSelector!, "--remove-declaration", "yes", "--remove-data", "no", "--yes"], options); expect(removedTool.code, removedTool.stderr.join("\n")).toBe(0);
    const removedBare = await runPluginInProcess(value.project, ["uninstall", "bare@official", "--selector", bareSelector!, "--remove-declaration", "no", "--remove-data", "no", "--yes"], options); expect(removedBare.code, removedBare.stderr.join("\n")).toBe(0);
    fs.rmSync(path.join(partition.value, path.basename(registrationFiles[0]!))); fs.rmSync(path.join(value.project, ".claude", "settings.json"));
    const removedUserMarketplace = await runPluginInProcess(value.project, ["marketplace", "remove", "official", "--selector", marketplaceSelector!, "--preserve-installed", "yes", "--yes"], options); expect(removedUserMarketplace.code, removedUserMarketplace.stderr.join("\n")).toBe(0);
  });

  it("preserves ambient managed-policy precedence in production settings planning", async () => {
    const value = localLifecycleFixture(); const options = { env: { PICC_CLAUDE_USER_DIR: value.userDir }, homeDir: value.homeDir, stdinIsTTY: false };
    expect((await runPluginInProcess(value.project, ["marketplace", "add", "official", "--source", "local-directory", value.marketplace, "--yes"], options)).code).toBe(0);
    const managed = path.join(value.homeDir, "managed-settings.json"); const defaultManagedPaths = new Set([path.resolve("/etc/claude-code/managed-settings.json"), path.resolve("C:\\Program Files\\ClaudeCode\\managed-settings.json")]); write(managed, JSON.stringify({ enabledPlugins: { "tool@official": false } }));
    const redirectedManaged = (target: fs.PathLike): string | undefined => { const resolved = path.resolve(String(target)); return defaultManagedPaths.has(resolved) ? resolved : undefined; };
    const isDefaultManaged = (target: fs.PathLike): boolean => redirectedManaged(target) !== undefined;
    const stat = fs.statSync; const readFile = fs.readFileSync; const lstat = fs.lstatSync; const open = fs.openSync; const realpathNative = fs.realpathSync.native;
    fs.statSync = ((target: fs.PathLike, ...rest: unknown[]) => isDefaultManaged(target) ? stat(managed, ...(rest as [])) : stat(target, ...(rest as []))) as typeof fs.statSync;
    fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => typeof target !== "number" && isDefaultManaged(target) ? readFile(managed, ...(rest as [])) : readFile(target, ...(rest as []))) as typeof fs.readFileSync;
    fs.lstatSync = ((target: fs.PathLike, ...rest: unknown[]) => isDefaultManaged(target) ? lstat(managed, ...(rest as [])) : lstat(target, ...(rest as []))) as typeof fs.lstatSync;
    fs.openSync = ((target: fs.PathLike, ...rest: unknown[]) => isDefaultManaged(target) ? open(managed, ...(rest as [fs.OpenMode, fs.Mode?])) : open(target, ...(rest as [fs.OpenMode, fs.Mode?]))) as typeof fs.openSync;
    fs.realpathSync.native = ((target: fs.PathLike, ...rest: unknown[]) => redirectedManaged(target) ?? realpathNative(target, ...(rest as []))) as typeof fs.realpathSync.native;
    let installed;
    try { installed = await runPluginInProcess(value.project, ["install", "tool@official", "--declaration-only"], { ...options, stdinIsTTY: true, confirm: async () => false }); } finally { fs.statSync = stat; fs.readFileSync = readFile; fs.lstatSync = lstat; fs.openSync = open; fs.realpathSync.native = realpathNative; }
    const preview = installed.stdout.join("\n"); expect(installed.code, installed.stderr.join("\n")).toBe(2); expect(installed.stderr.join("\n")).toContain("cancelled"); expect(preview).toContain("Default/enablement: enabled=false; source=existing-effective"); expect(preview).toContain("requested=false; effective=false; declaration-only=true");
  });

  it("reports and rolls back an interrupted production lifecycle operation through fresh offline recovery", async () => {
    const value = localLifecycleFixture(); const options = { env: { PICC_CLAUDE_USER_DIR: value.userDir }, homeDir: value.homeDir, stdinIsTTY: false };
    expect((await runPluginInProcess(value.project, ["marketplace", "add", "official", "--source", "local-directory", value.marketplace, "--yes"], options)).code).toBe(0);

    const promises = fs.promises as unknown as { rename: typeof fs.promises.rename }; const originalRename = promises.rename; let interrupted = false;
    promises.rename = (async (sourcePath, destinationPath) => {
      if (interrupted) throw Object.assign(new Error("interrupted lifecycle proof"), { code: "EIO" });
      const result = await originalRename(sourcePath, destinationPath);
      const source = String(sourcePath); const destination = String(destinationPath);
      if (source.includes(".tmp-") && !destination.includes(`${path.sep}staging${path.sep}`) && destination.includes(`${path.sep}.picc${path.sep}`)) interrupted = true;
      return result;
    }) as typeof fs.promises.rename;
    let failedCode = -1; const pendingOutput: string[] = [];
    try { failedCode = await runPluginInventoryCli(["install", "tool@official", "--yes"], { log: (message) => pendingOutput.push(message), error: () => { throw new Error("pending progress renderer failed"); } }, { cwd: value.project, platform: "linux", ...options }); } finally { promises.rename = originalRename; }
    expect(interrupted).toBe(true); expect(failedCode).toBe(1); expect(pendingOutput.at(-1)).toContain("Lifecycle result output failed");
    const operationId = /Operation ID: (plugin_[A-Za-z0-9_-]+)/u.exec(pendingOutput.join("\n"))?.[1]; expect(operationId).toBeDefined();

    const listed = await runPluginInProcess(value.project, ["recover"], options); expect(listed.stdout.join("\n")).toContain(`Operation ID: ${operationId}; status=pending`);
    const profilesRoot = path.join(value.homeDir, ".picc", "plugins", "v1", "profiles"); const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : typeof input === "object" && input !== null ? Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : input;
    for (const profile of fs.readdirSync(profilesRoot)) { const locks = path.join(profilesRoot, profile, "locks"); for (const lock of fs.readdirSync(locks)) { const ownerPath = path.join(locks, lock, "owner.json"); const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as Record<string, unknown>; owner.pid = 2_147_483_647; fs.writeFileSync(ownerPath, JSON.stringify(canonical(owner))); } }
    const recovered = runSourcePluginWithEnv(value.project, ["recover", operationId!, "--rollback", "--yes"], { PICC_CLAUDE_USER_DIR: value.userDir, HOME: value.homeDir, USERPROFILE: value.homeDir });
    expect(recovered.status, recovered.stderr).toBe(0); expect(recovered.stdout).toContain("Chosen recovery action/result: rollback"); expect(recovered.stdout, recovered.stderr).toContain("Outcome: rolled-back"); expect(recovered.stdout).toContain("No durable desired state change was committed");
    const terminal = await runPluginInProcess(value.project, ["recover", operationId!], options); expect(terminal.stdout.join("\n")).toContain("Outcome: rolled-back");
  });

  it("lists pending recovery read-only without selecting an action", async () => {
    const { project, userDir } = inventoryFixture(); let previewed = 0; let recovered = 0;
    const services = () => ({ ok: true as const, value: { marketplaces: { listStatus: () => ({ rows: [], omitted: 0, uncertain: false }), details: () => ({ ok: false as const, code: "unused", message: "unused" }), plan: async () => ({ ok: false as const, code: "unused", message: "unused" }), prepare: () => ({ ok: false as const, code: "unused", message: "unused" }), discardPreview: async () => ({ ok: true as const, value: undefined }) }, plugins: { list: () => [], details: () => ({ ok: false as const, code: "unused", message: "unused" }), plan: async () => ({ ok: false as const, code: "unused", message: "unused" }), execute: async () => ({ ok: false as const, code: "unused", message: "unused" }), discardPreview: async () => ({ ok: true as const, value: undefined }) }, recovery: { list: () => [{ operationId: "plugin_pending", status: "pending" }], preview: async () => { previewed++; return { ok: false as const, code: "unused", message: "unused" }; }, recover: async () => { recovered++; return { ok: false as const, code: "unused", message: "unused" }; } } } });
    const result = await runPluginInProcess(project, ["recover"], { env: { PICC_CLAUDE_USER_DIR: userDir }, services: services as never });
    expect(result).toEqual({ code: 0, stdout: ["Operation ID: plugin_pending; status=pending", "Pending lifecycle operations: total=1; omitted=0. Run picc plugin recover <exact-operation-id> to inspect one exact operation."], stderr: [] }); expect({ previewed, recovered }).toEqual({ previewed: 0, recovered: 0 });
  });

  it("uses source-specific path-free profile errors and preserves resolver precedence", async () => {
    const { project, userDir } = inventoryFixture();
    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "picc@market": true } }));
    const configProfile = path.join(temp("picc-config-profile-"), "profile");
    write(path.join(configProfile, "settings.json"), JSON.stringify({ enabledPlugins: { "config@market": true } }));
    const defaultHome = temp("picc-default-home-");
    write(path.join(defaultHome, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "default@market": true } }));

    const precedence = await runPluginInProcess(project, ["list"], {
      env: { PICC_CLAUDE_USER_DIR: userDir, CLAUDE_CONFIG_DIR: configProfile },
      homeDir: defaultHome,
    });
    expect(precedence.stdout.join("\n")).toContain("Plugin: picc@market");
    expect(precedence.stdout.join("\n")).not.toContain("Plugin: config@market");

    const configured = await runPluginInProcess(project, ["list"], {
      env: { CLAUDE_CONFIG_DIR: configProfile }, homeDir: defaultHome,
    });
    expect(configured.stdout.join("\n")).toContain("Plugin: config@market");

    const defaulted = await runPluginInProcess(project, ["list"], { env: {}, homeDir: defaultHome });
    expect(defaulted.stdout.join("\n")).toContain("Plugin: default@market");

    const unreadablePicc = path.join(temp("picc-profile-file-"), "private-picc");
    const unreadableConfig = path.join(temp("picc-profile-file-"), "private-config");
    const unreadableDefaultHome = temp("picc-profile-file-");
    write(unreadablePicc, "not a directory");
    write(unreadableConfig, "not a directory");
    write(path.join(unreadableDefaultHome, ".claude"), "not a directory");

    const cases = [
      [
        { env: { PICC_CLAUDE_USER_DIR: unreadablePicc, CLAUDE_CONFIG_DIR: configProfile }, homeDir: defaultHome },
        "PiCC plugin inventory could not read the Claude profile. Check PICC_CLAUDE_USER_DIR and permissions.",
      ],
      [
        { env: { CLAUDE_CONFIG_DIR: unreadableConfig }, homeDir: defaultHome },
        "PiCC plugin inventory could not read the Claude profile. Check CLAUDE_CONFIG_DIR and permissions.",
      ],
      [
        { env: {}, homeDir: unreadableDefaultHome },
        "PiCC plugin inventory could not read the Claude profile. Check default Claude profile permissions or set PICC_CLAUDE_USER_DIR.",
      ],
    ] as const;
    for (const [options, message] of cases) {
      const result = await runPluginInProcess(project, ["list"], options);
      expect(result).toEqual({ code: 1, stdout: [], stderr: [message] });
      expect(message).not.toContain(unreadablePicc);
      expect(message).not.toContain(unreadableConfig);
      expect(message).not.toContain(unreadableDefaultHome);
    }
  });

  it("reports malformed and unsupported inventory state generically", async () => {
    const { project, userDir } = inventoryFixture();
    const options = { env: { PICC_CLAUDE_USER_DIR: userDir } };

    const healthyWindows = await runPluginInProcess(project, ["list"], { ...options, platform: "win32" });
    expect(healthyWindows).toMatchObject({ code: 0, stderr: [] });

    write(path.join(userDir, "plugins", "installed_plugins.json"), "{ malformed");
    write(path.join(userDir, "plugins", "known_marketplaces.json"), "{ malformed");
    const malformed = await runPluginInProcess(project, ["list"], options);
    expect(malformed).toMatchObject({ code: 0, stderr: [inventoryIncompleteWarning("installed plugin state, marketplace state")] });

    write(path.join(userDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 999, plugins: {} }));
    fs.rmSync(path.join(userDir, "plugins", "known_marketplaces.json"));
    const unsupported = await runPluginInProcess(project, ["list"], options);
    expect(unsupported).toMatchObject({ code: 0, stderr: [inventoryIncompleteWarning("installed plugin state", "format")] });
    expect(unsupported.stderr.join("\n")).not.toMatch(/repair the malformed|999/iu);

    write(path.join(userDir, "plugins", "known_marketplaces.json"), "{ malformed");
    const mixed = await runPluginInProcess(project, ["list"], options);
    expect(mixed).toMatchObject({ code: 0, stderr: [inventoryIncompleteWarning("installed plugin state, marketplace state", "format repair")] });
    expect(mixed.stderr.join("\n")).not.toContain("999");
  });

  it("classifies an unavailable cwd separately from profile failures", async () => {
    const missing = path.join(temp("picc-missing-cwd-"), "removed");
    const result = await runPluginInProcess(missing, ["list"], { env: {} });
    expect(result).toEqual({
      code: 1,
      stdout: [],
      stderr: ["PiCC plugin inventory could not access the target project directory. Run from an accessible target project directory."],
    });
  });

  it("captures managed files while Windows standalone inventory stays process-free", () => {
    const { project, userDir } = inventoryFixture();
    const cli = pathToFileURL(path.join(repoRoot, "src", "plugin-inventory-cli.ts")).href;
    const processCanary = path.join(path.dirname(project), "managed-process-canary");
    const script = `
import fs from "node:fs";
import child from "node:child_process";
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  child[name] = () => { fs.writeFileSync(${JSON.stringify(processCanary)}, name); throw new Error("child process forbidden"); };
}
const { syncBuiltinESMExports } = await import("node:module");
syncBuiltinESMExports();
const { createJiti } = await import("jiti/static");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, tsconfigPaths: false, tryNative: false });
const loaded = await jiti.import(${JSON.stringify(cli)});
const systemFile = ${JSON.stringify(String.raw`C:\Program Files\ClaudeCode\managed-settings.json`)}.toLowerCase();
const dropInDir = ${JSON.stringify(String.raw`C:\Program Files\ClaudeCode\managed-settings.d`)}.toLowerCase();
const originalStatSync = fs.statSync;
const originalReadFileSync = fs.readFileSync;
const originalReaddirSync = fs.readdirSync;
const missing = value => Object.assign(new Error("test-isolated managed policy"), { code: "ENOENT", path: value });
fs.statSync = function(value, ...rest) {
  const normalized = String(value).toLowerCase();
  if (normalized === systemFile) return { isFile: () => true };
  if (normalized.startsWith(${JSON.stringify(String.raw`C:\Program Files\ClaudeCode`).toLowerCase()})) throw missing(value);
  return originalStatSync.call(this, value, ...rest);
};
fs.readFileSync = function(value, ...rest) {
  if (String(value).toLowerCase() === systemFile) return JSON.stringify({ enabledPlugins: { "file-policy@managed": true } });
  return originalReadFileSync.call(this, value, ...rest);
};
fs.readdirSync = function(value, ...rest) {
  if (String(value).toLowerCase() === dropInDir) throw missing(value);
  return originalReaddirSync.call(this, value, ...rest);
};
syncBuiltinESMExports();
Object.defineProperty(process, "platform", { value: "win32" });
process.chdir(${JSON.stringify(project)});
process.env.PICC_CLAUDE_USER_DIR = ${JSON.stringify(userDir)};
const messages = { stdout: [], stderr: [] };
const code = await loaded.runPluginInventoryCli(["list"], { log: value => messages.stdout.push(value), error: value => messages.stderr.push(value) });
console.log(JSON.stringify({ code, messages }));
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot, encoding: "utf8",
    });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const observed = JSON.parse(result.stdout) as {
      code: number;
      messages: { stdout: string[]; stderr: string[] };
    };
    expect(observed).toMatchObject({ code: 0, messages: { stderr: [] } });
    expect(observed.messages.stdout.join("\n")).toContain("Plugin: file-policy@managed");
    expect(fs.existsSync(processCanary)).toBe(false);
  });

  it("ignores project config and keeps standalone inventory isolated from processes, shells, and network egress", () => {
    const { project, userDir } = inventoryFixture();
    const tsconfigCanary = path.join(path.dirname(project), "tsconfig-canary");
    const cacheCanary = path.join(path.dirname(project), "jiti-cache");
    const processCanary = path.join(path.dirname(project), "process-canary");
    const networkCanary = path.join(path.dirname(project), "network-canary");
    const redirect = path.join(project, "redirect-yaml.ts");
    write(redirect, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(tsconfigCanary)}, "executed"); export const parse = () => ({});\n`);
    write(path.join(project, "tsconfig.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { yaml: ["./redirect-yaml.ts"] } },
    }));
    const preload = path.join(path.dirname(project), "deny-process.cjs");
    write(preload, `
const fs = require("node:fs");
const child = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  child[name] = () => { fs.writeFileSync(${JSON.stringify(processCanary)}, name); throw new Error("child process forbidden"); };
}
const denyNetwork = name => () => { fs.writeFileSync(${JSON.stringify(networkCanary)}, name); throw new Error("network forbidden"); };
globalThis.fetch = denyNetwork("fetch");
for (const [owner, names] of [[http, ["request", "get"]], [https, ["request", "get"]], [net, ["connect", "createConnection"]]]) {
  for (const name of names) owner[name] = denyNetwork(name);
}
net.Socket.prototype.connect = denyNetwork("Socket.connect");
require("node:module").syncBuiltinESMExports();
`);

    const result = runSourcePlugin(project, userDir, ["list"], {
      JITI_FS_CACHE: cacheCanary,
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(sourcePluginStderr);
    expect(result.stdout).toContain("No plugins are known in this snapshot.");
    expect(fs.existsSync(tsconfigCanary)).toBe(false);
    expect(fs.existsSync(cacheCanary)).toBe(false);
    expect(fs.existsSync(processCanary)).toBe(false);
    expect(fs.existsSync(networkCanary)).toBe(false);
  });

  it("does not activate extensions, hooks, components, shells, or persistent plugin data", () => {
    const { project, userDir } = inventoryFixture();
    const marker = path.join(path.dirname(project), "execution-canary");
    const pluginRoot = path.join(userDir, "plugins", "cache", "market", "hostile", "1.0.0");
    write(path.join(userDir, "settings.json"), JSON.stringify({
      enabledPlugins: { "hostile@market": true },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'hook')`] }] }] },
    }));
    write(path.join(userDir, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: { "hostile@market": [{ scope: "user", installPath: pluginRoot, version: "1.0.0" }] },
    }));
    write(path.join(pluginRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "hostile",
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'plugin-hook')`] }] }] },
      mcpServers: { canary: { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'mcp')`] } },
    }));

    const before = fs.readdirSync(project).sort();
    const result = runSourcePlugin(project, userDir, ["details", "hostile@market"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe(sourcePluginStderr);
    expect(result.stdout).toContain("Plugin: hostile@market");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(userDir, "plugins", "data"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".claude", ".picc"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".git", "info", "exclude"))).toBe(false);
    expect(fs.readdirSync(project).sort()).toEqual(before);
  });

  it("preserves update and version administration while forwarding the near-collision plugins token", () => {
    const root = makePackage();
    installLauncher(root);
    const updateCanary = path.join(root, "update.json");
    const piCanary = path.join(root, "pi.json");
    write(path.join(root, "bin", "picc-update.mjs"), `import fs from "node:fs"; export async function runUpdate(value) { fs.writeFileSync(${JSON.stringify(updateCanary)}, JSON.stringify(value)); return 0; }\n`);
    const cli = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    write(cli, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(piCanary)}, JSON.stringify(process.argv.slice(2)));\n`);

    const update = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "update", "--check"], {
      cwd: root, encoding: "utf8",
    });
    expect(update).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(JSON.parse(fs.readFileSync(updateCanary, "utf8"))).toEqual({ action: "check" });

    const version = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "--version"], {
      cwd: root, encoding: "utf8",
    });
    expect(version).toMatchObject({ status: 0, stderr: "" });
    expect(version.stdout).toBe("PiCC 0.1.1\nEmbedded Pi 0.82.0\nInstall source\nRuntime source fallback (missing): PiCC is using TypeScript source because the compiled runtime is missing. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC to restore compiled startup.\n");

    const plugins = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "plugins"], {
      cwd: root, encoding: "utf8",
    });
    expect(plugins).toMatchObject({
      status: 0, stdout: "",
      stderr: "PiCC is using TypeScript source because the compiled runtime is missing. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC to restore compiled startup.\n",
    });
    expect(JSON.parse(fs.readFileSync(piCanary, "utf8"))).toEqual([
      "-e", canonicalPath(path.join(root, "picc", "index.ts")), "plugins",
    ]);
  });

  it("keeps version actionable and successful for every invalid installed runtime category", () => {
    for (const category of ["missing", "corrupt", "version-mismatch"] as const) {
      const root = makePackage({ source: false });
      installLauncher(root);
      if (category !== "missing") installVerifiedRuntime(root);
      if (category === "corrupt") fs.appendFileSync(path.join(root, "dist", "index.js"), "// damaged\n");
      if (category === "version-mismatch") {
        const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
        packageJson.version = "0.2.0";
        write(path.join(root, "package.json"), JSON.stringify(packageJson));
      }

      const result = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "--version"], {
        cwd: root, encoding: "utf8",
      });
      expect(result).toMatchObject({ status: 0, stderr: "" });
      expect(result.stdout).toContain(`Install installed\nRuntime unavailable (${category}):`);
      expect(result.stdout).toContain(category === "missing" ? "runtime is missing" : category === "corrupt" ? "runtime is damaged" : "runtime is version-incoherent");
      expect(result.stdout).toContain("TypeScript source was not used");
      expect(result.stdout).toContain("picc update");
      expect(result.stdout).toContain("installation owner");
    }
  });

  it("routes top-level help to the standalone lifecycle grammar without a JSON promise", () => {
    const result = spawnSync(process.execPath, [launcherSource, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("picc plugin <command>");
    expect(result.stdout).toContain("Local marketplace/plugin lifecycle and offline recovery");
    expect(result.stdout).toContain("picc plugin --help");
    expect(result.stdout).not.toMatch(/JSON|live.refresh/iu);
  });
});

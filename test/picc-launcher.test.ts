import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runPluginInventoryCli, type PluginInventoryCliOptions } from "../src/plugin-inventory-cli.js";
import type { ManagedRegistryAdapter } from "../src/discovery/managed-policy.js";
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

const repoRoot = path.resolve(".");
const adminSource = path.join(repoRoot, "bin", "picc-admin.mjs");
const launcherSource = path.join(repoRoot, "bin", "picc.mjs");
const pluginAdapterSource = path.join(repoRoot, "bin", "picc-plugin.mjs");
const runtimeSelectorSource = path.join(repoRoot, "bin", "picc-runtime.mjs");
const windowsRegistryWarning = "PiCC plugin inventory: Windows registry policy was not inspected. Managed files and drop-ins were still observed. Run PiCC interactively and use `/plugin list` or `/doctor` for registry-backed policy evidence.";
const inventoryIncompleteWarning = (classes: string, actions = "repair") => `PiCC plugin inventory may be incomplete (${classes}). ${actions.includes("format") ? "Update PiCC or report the unsupported plugin-state format. " : ""}${actions.includes("repair") ? "Repair the malformed or unreadable Claude plugin state outside PiCC. " : ""}Run PiCC interactively in the same project and profile, then use \`/doctor\` for details.`;
const inventoryPolicyWarning = process.platform === "win32" ? `${windowsRegistryWarning}\n` : "";
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
    name: "picc", version: "0.1.0", type: "module", dependencies,
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
    package: { name: "picc", version: "0.1.0", type: "module" },
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
  return spawnSync(process.execPath, [launcherSource, "plugin", ...args], {
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

const absentRegistry: ManagedRegistryAdapter = { readSettings: () => ({ status: "absent" }) };

function runPluginInProcess(
  cwd: string,
  args: string[],
  options: PluginInventoryCliOptions,
  registry: ManagedRegistryAdapter | null = absentRegistry,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runPluginInventoryCli(args, {
    log: (message) => stdout.push(message),
    error: (message) => stderr.push(message),
  }, registry === null ? undefined : registry, { cwd, platform: "linux", ...options });
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
    const root = path.join(prefix, "node_modules", "picc");
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
    const root = path.join(prefix, "node_modules", "picc");
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
        kind: installationKind, version: "0.1.0", cwd: root, nodeOptions: "--no-warnings",
        sourceMapsEnabled: true, descendantStatus: 0, descendantNodeOptions: "--no-warnings",
      });
      expect(launched.parent).toMatch(/^[1-9]\d*$/);
      expect(fs.existsSync(sourceCanary)).toBe(false);
      expect(fs.existsSync(jitiCanary)).toBe(false);

      const version = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "--version"], {
        cwd: root, encoding: "utf8",
      });
      expect(version).toMatchObject({ status: 0, stderr: "" });
      expect(version.stdout).toBe(`PiCC 0.1.0\nEmbedded Pi 0.82.0\nInstall ${installationKind}\nRuntime compiled (verified)\n`);
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
      expect(result.stderr).toContain("node scripts/build-runtime.mjs");
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
      expect(result.stdout).toContain("Run `node scripts/build-runtime.mjs`, then exit and relaunch PiCC");
      expect(result.stdout).toContain(state === "corrupt" ? "Runtime unavailable" : "Runtime source fallback");
      expect(result.stdout).not.toMatch(/[0-9a-f]{64}/u);
      expect(result.stdout).not.toContain(root);
    }
  });

  it("routes installed and source-classified compiled plugin list/details through only the verified inventory entry", () => {
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
    expect(result.stderr.trim()).toBe("PiCC is using TypeScript source because the compiled runtime is missing. Run `node scripts/build-runtime.mjs`, then exit and relaunch PiCC to restore compiled startup.\nPiCC plugin inventory is unavailable in this build. Update or reinstall PiCC.");
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
      stderr: "PiCC is using TypeScript source because the compiled runtime is missing. Run `node scripts/build-runtime.mjs`, then exit and relaunch PiCC to restore compiled startup.\n",
    });

    const prefix = temp("picc-plugin-loader-");
    const root = path.join(prefix, "node_modules", "picc");
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
      stderr: "PiCC is using TypeScript source because the compiled runtime is missing. Run `node scripts/build-runtime.mjs`, then exit and relaunch PiCC to restore compiled startup.\n",
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
      stderr: "PiCC is using TypeScript source because the compiled runtime is missing. Run `node scripts/build-runtime.mjs`, then exit and relaunch PiCC to restore compiled startup.\n",
    });
    expect(fs.existsSync(rejectedCanary)).toBe(false);
  });

  it("runs command semantics and fresh snapshots in process through the shared grammar", () => {
    const { project, userDir } = inventoryFixture();
    const env = { PICC_CLAUDE_USER_DIR: userDir };
    write(path.join(userDir, "settings.json"), JSON.stringify({
      enabledPlugins: { "same@market-a": true, "same@market-b": true },
    }));

    const list = runPluginInProcess(project, ["list"], { env });
    expect(list).toMatchObject({ code: 0, stderr: [] });
    expect(list.stdout.join("\n")).toContain("Snapshot: captured for this command");
    expect(list.stdout.join("\n")).toContain("Plugin: same@market-a");
    expect(list.stdout.join("\n")).toContain("Plugin: same@market-b");

    const details = runPluginInProcess(project, ["details", "same@market-b"], { env });
    expect(details).toMatchObject({ code: 0, stderr: [] });
    expect(details.stdout.join("\n")).toContain("Plugin: same@market-b");
    expect(details.stdout.join("\n")).not.toContain("Plugin: same@market-a");

    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "later@market": true } }));
    const later = runPluginInProcess(project, ["list"], { env });
    expect(later.stdout.join("\n")).toContain("Plugin: later@market");
    expect(later.stdout.join("\n")).not.toContain("Plugin: same@market-a");

    for (const args of [[], ["LIST"], ["details"], ["details", "bare"], ["list", "extra"], ["details", "later@market", "extra"]]) {
      const result = runPluginInProcess(project, args, { env });
      expect(result).toEqual({
        code: 2,
        stdout: [],
        stderr: ["Read-only usage: picc plugin list | picc plugin details <plugin@marketplace> (example: picc plugin details formatter@official). Run picc plugin list to copy an exact qualified identity."],
      });
    }

    const unknown = runPluginInProcess(project, ["details", "missing@market"], { env });
    expect(unknown).toEqual({
      code: 1,
      stdout: [],
      stderr: ["PiCC plugin not found: missing@market. The bounded launcher list can omit catalog-only identities. Run `picc plugin list` to copy a listed qualified identity, or run PiCC interactively in the same project and profile and use the literal `/plugin` filter."],
    });
  });

  it("uses source-specific path-free profile errors and preserves resolver precedence", () => {
    const { project, userDir } = inventoryFixture();
    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "picc@market": true } }));
    const configProfile = path.join(temp("picc-config-profile-"), "profile");
    write(path.join(configProfile, "settings.json"), JSON.stringify({ enabledPlugins: { "config@market": true } }));
    const defaultHome = temp("picc-default-home-");
    write(path.join(defaultHome, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "default@market": true } }));

    const precedence = runPluginInProcess(project, ["list"], {
      env: { PICC_CLAUDE_USER_DIR: userDir, CLAUDE_CONFIG_DIR: configProfile },
      homeDir: defaultHome,
    });
    expect(precedence.stdout.join("\n")).toContain("Plugin: picc@market");
    expect(precedence.stdout.join("\n")).not.toContain("Plugin: config@market");

    const configured = runPluginInProcess(project, ["list"], {
      env: { CLAUDE_CONFIG_DIR: configProfile }, homeDir: defaultHome,
    });
    expect(configured.stdout.join("\n")).toContain("Plugin: config@market");

    const defaulted = runPluginInProcess(project, ["list"], { env: {}, homeDir: defaultHome });
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
      const result = runPluginInProcess(project, ["list"], options);
      expect(result).toEqual({ code: 1, stdout: [], stderr: [message] });
      expect(message).not.toContain(unreadablePicc);
      expect(message).not.toContain(unreadableConfig);
      expect(message).not.toContain(unreadableDefaultHome);
    }
  });

  it("separates malformed inventory from the default Windows registry limitation", () => {
    const { project, userDir } = inventoryFixture();
    const options = { env: { PICC_CLAUDE_USER_DIR: userDir } };

    const healthyWindows = runPluginInProcess(project, ["list"], { ...options, platform: "win32" }, null);
    expect(healthyWindows).toMatchObject({ code: 0, stderr: [windowsRegistryWarning] });

    const customUnavailable: ManagedRegistryAdapter = { readSettings: () => ({ status: "unreadable" }) };
    const injected = runPluginInProcess(project, ["list"], { ...options, platform: "win32" }, customUnavailable);
    expect(injected).toMatchObject({ code: 0, stderr: [inventoryIncompleteWarning("managed policy state")] });
    expect(injected.stderr).not.toContain(windowsRegistryWarning);

    write(path.join(userDir, "plugins", "installed_plugins.json"), "{ malformed");
    write(path.join(userDir, "plugins", "known_marketplaces.json"), "{ malformed");
    const malformed = runPluginInProcess(project, ["list"], options);
    expect(malformed).toMatchObject({ code: 0, stderr: [inventoryIncompleteWarning("installed plugin state, marketplace state")] });

    write(path.join(userDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 999, plugins: {} }));
    fs.rmSync(path.join(userDir, "plugins", "known_marketplaces.json"));
    const unsupported = runPluginInProcess(project, ["list"], options);
    expect(unsupported).toMatchObject({ code: 0, stderr: [inventoryIncompleteWarning("installed plugin state", "format")] });
    expect(unsupported.stderr.join("\n")).not.toMatch(/repair the malformed|999/iu);

    write(path.join(userDir, "plugins", "known_marketplaces.json"), "{ malformed");
    const mixed = runPluginInProcess(project, ["list"], options);
    expect(mixed).toMatchObject({ code: 0, stderr: [inventoryIncompleteWarning("installed plugin state, marketplace state", "format repair")] });
    expect(mixed.stderr.join("\n")).not.toContain("999");
  });

  it("classifies an unavailable cwd separately from profile failures", () => {
    const missing = path.join(temp("picc-missing-cwd-"), "removed");
    const result = runPluginInProcess(missing, ["list"], { env: {} });
    expect(result).toEqual({
      code: 1,
      stdout: [],
      stderr: ["PiCC plugin inventory could not access the target project directory. Run from an accessible target project directory."],
    });
  });

  it("captures injected managed policy while unavailable Windows registry evidence stays process-free", () => {
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
const run = registry => {
  const messages = { stdout: [], stderr: [] };
  const code = loaded.runPluginInventoryCli(["list"], { log: value => messages.stdout.push(value), error: value => messages.stderr.push(value) }, registry);
  return { code, messages };
};
const unavailable = run(undefined);
const hives = [];
const managed = run({ readSettings(hive) { hives.push(hive); return { status: "present", json: JSON.stringify({ enabledPlugins: { "policy@managed": true } }) }; } });
console.log(JSON.stringify({ unavailable, managed, hives }));
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot, encoding: "utf8",
    });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    const observed = JSON.parse(result.stdout) as {
      unavailable: { code: number; messages: { stdout: string[]; stderr: string[] } };
      managed: { code: number; messages: { stdout: string[]; stderr: string[] } };
      hives: string[];
    };
    expect(observed.unavailable).toMatchObject({
      code: 0,
      messages: { stderr: [windowsRegistryWarning] },
    });
    expect(observed.unavailable.messages.stdout.join("\n")).toContain("Plugin: file-policy@managed");
    expect(observed.managed).toMatchObject({ code: 0, messages: { stderr: [] } });
    expect(observed.managed.messages.stdout.join("\n")).toContain("Plugin: file-policy@managed");
    expect(observed.managed.messages.stdout.join("\n")).toContain("Plugin: policy@managed");
    expect(observed.hives).toEqual(["HKLM"]);
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
    expect(result.stderr).toBe(inventoryPolicyWarning);
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
    expect(result.stderr).toBe(inventoryPolicyWarning);
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
    expect(version.stdout).toBe("PiCC 0.1.0\nEmbedded Pi 0.82.0\nInstall source\nRuntime source fallback (missing): PiCC is using TypeScript source because the compiled runtime is missing. Run `node scripts/build-runtime.mjs`, then exit and relaunch PiCC to restore compiled startup.\n");

    const plugins = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "plugins"], {
      cwd: root, encoding: "utf8",
    });
    expect(plugins).toMatchObject({
      status: 0, stdout: "",
      stderr: "PiCC is using TypeScript source because the compiled runtime is missing. Run `node scripts/build-runtime.mjs`, then exit and relaunch PiCC to restore compiled startup.\n",
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

  it("lists both read-only commands in help without changing help routing", () => {
    const result = spawnSync(process.execPath, [launcherSource, "--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("picc plugin list");
    expect(result.stdout).toContain("picc plugin details <plugin@marketplace>");
    expect(result.stdout).not.toMatch(/JSON|live.refresh/iu);
  });
});

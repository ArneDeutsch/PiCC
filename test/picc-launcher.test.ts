import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PI_SUITE_PACKAGES,
  canonicalPath,
  classifyInstallation,
  discoverNpmCommand,
  discoverTrustedGit,
  resolvePiCli,
  validatePiSuite,
} from "../bin/picc-admin.mjs";

const repoRoot = path.resolve(".");
const adminSource = path.join(repoRoot, "bin", "picc-admin.mjs");
const launcherSource = path.join(repoRoot, "bin", "picc.mjs");
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

  it("preserves Pi argv, child exit status, and the two-kind launcher context", () => {
    const root = makePackage();
    installLauncher(root);
    const canary = path.join(root, "launch.json");
    const cli = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    write(cli, `import fs from "node:fs";
fs.writeFileSync(process.env.PICC_TEST_CANARY, JSON.stringify({
  argv: process.argv.slice(2),
  kind: process.env.PICC_INSTALL_KIND,
  version: process.env.PICC_VERSION,
  parent: process.env.PICC_LAUNCHER_PID,
}));
process.exit(23);
`);
    const result = spawnSync(process.execPath, [path.join(root, "bin", "picc.mjs"), "--model", "openai/test"], {
      cwd: root, encoding: "utf8", env: { ...process.env, PICC_TEST_CANARY: canary },
    });
    expect(result.status).toBe(23);
    const launched = JSON.parse(fs.readFileSync(canary, "utf8")) as {
      argv: string[]; kind: string; version: string; parent: string;
    };
    expect(launched.argv).toEqual(["-e", canonicalPath(path.join(root, "picc", "index.ts")), "--model", "openai/test"]);
    expect(launched).toMatchObject({ kind: "source", version: "0.1.0" });
    expect(launched.parent).toMatch(/^[1-9]\d*$/);
  });
});

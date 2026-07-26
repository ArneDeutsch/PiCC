import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPath, discoverTrustedGit } from "../bin/picc-admin.mjs";
import { PI_SUITE_PACKAGES } from "../bin/picc-admin.mjs";
import { runUpdate } from "../bin/picc-update.mjs";

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

function makeRoot(options: { root?: string; source?: boolean; version?: string } = {}): string {
  const root = options.root ?? temp("picc-update-");
  write(path.join(root, "package.json"), JSON.stringify({
    name: "picc",
    version: options.version ?? "0.1.0",
  }));
  if (options.source ?? true) {
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    write(path.join(root, "package-lock.json"), "{}");
  }
  return root;
}

type ChildOptions = {
  code?: number;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

function child(options: ChildOptions = {}) {
  const process = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  queueMicrotask(() => {
    if (options.stdout) process.stdout.write(options.stdout);
    if (options.stderr) process.stderr.write(options.stderr);
    process.stdout.end();
    process.stderr.end();
    if (options.error) process.emit("error", options.error);
    else process.emit("close", options.code ?? 0, options.signal ?? null);
  });
  return process;
}

function outputCapture() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    sink: {
      log(value: unknown) { logs.push(String(value)); },
      error(value: unknown) { errors.push(String(value)); },
    },
  };
}

const healthySuite = () => ({ ok: true, version: "0.82.0" });
const cleanGit = () => child();

describe("source checkout update", () => {
  it("checks clean dependency state without invoking npm", async () => {
    const root = makeRoot();
    const capture = outputCapture();
    let npmCalls = 0;
    const result = await runUpdate({
      action: "check",
      packageRoot: root,
      runGit: cleanGit,
      runNpm: () => { npmCalls += 1; return child(); },
      validateSuite: healthySuite,
      output: capture.sink,
    });

    expect(result).toBe(0);
    expect(npmCalls).toBe(0);
    expect(capture.logs.join("\n")).toMatch(/clean.*coherent.*0\.82\.0/i);
  });

  it("does not report coherence when the embedded Pi CLI is missing", async () => {
    const root = makeRoot();
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    manifest.dependencies = Object.fromEntries(PI_SUITE_PACKAGES.map((name) => [name, "0.82.0"]));
    write(manifestPath, JSON.stringify(manifest));
    for (const name of PI_SUITE_PACKAGES) {
      write(path.join(root, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({
        name, version: "0.82.0",
      }));
    }
    const capture = outputCapture();
    const result = await runUpdate({
      action: "check",
      packageRoot: root,
      runGit: cleanGit,
      output: capture.sink,
    });
    expect(result).toBe(1);
    expect(capture.errors.join("\n")).toMatch(/embedded Pi CLI is unavailable/i);
  });

  it.each([
    ["staged", "A  staged.txt\n"],
    ["unstaged", " M changed.txt\n"],
    ["unmerged", "UU conflict.txt\n"],
    ["untracked", "?? new.txt\n"],
  ])("refuses %s source state before npm ci", async (_kind, status) => {
    const root = makeRoot();
    const capture = outputCapture();
    let npmCalls = 0;
    const result = await runUpdate({
      packageRoot: root,
      runGit: () => child({ stdout: status }),
      runNpm: () => { npmCalls += 1; return child(); },
      validateSuite: healthySuite,
      output: capture.sink,
    });

    expect(result).toBe(1);
    expect(npmCalls).toBe(0);
    expect(capture.errors.join("\n")).toMatch(/staged, unstaged, unmerged, or untracked/);
  });

  it("runs one plain npm ci with no proxy, CA, registry, or config overrides and revalidates", async () => {
    const root = makeRoot();
    const seen: string[][] = [];
    let validations = 0;
    const result = await runUpdate({
      packageRoot: root,
      runGit: (args: string[]) => {
        expect(args).toEqual(["-C", canonicalPath(root), "status", "--porcelain"]);
        return child();
      },
      runNpm: (args: string[]) => {
        seen.push(args);
        return child();
      },
      validateSuite: () => { validations += 1; return healthySuite(); },
      output: outputCapture().sink,
    });

    expect(result).toBe(0);
    expect(seen).toEqual([["ci", "--ignore-scripts", "--no-audit", "--no-fund"]]);
    expect(seen[0]).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/proxy|cafile|ca=|registry|userconfig|globalconfig/i),
    ]));
    expect(validations).toBe(1);
  });

  it("reports post-ci validation failure precisely", async () => {
    const root = makeRoot();
    const capture = outputCapture();
    const result = await runUpdate({
      packageRoot: root,
      runGit: cleanGit,
      runNpm: () => child(),
      validateSuite: () => ({
        ok: false,
        reason: "@earendil-works/pi-ai is 0.81.0; expected 0.82.0.",
      }),
      output: capture.sink,
    });

    expect(result).toBe(1);
    expect(capture.errors.join("\n")).toMatch(/npm ci completed.*pi-ai is 0\.81\.0; expected 0\.82\.0/i);
  });

  it("reports Git and npm child failures without starting a second transaction", async () => {
    const root = makeRoot();
    const gitCapture = outputCapture();
    expect(await runUpdate({
      packageRoot: root,
      runGit: () => child({ code: 2, stderr: "fatal: broken repository" }),
      runNpm: () => { throw new Error("must not run"); },
      validateSuite: healthySuite,
      output: gitCapture.sink,
    })).toBe(1);
    expect(gitCapture.errors.join("\n")).toMatch(/Git status failed: fatal: broken repository/);

    const npmCapture = outputCapture();
    expect(await runUpdate({
      packageRoot: root,
      runGit: cleanGit,
      runNpm: () => child({ code: 1, stderr: "npm error EPROXY" }),
      validateSuite: healthySuite,
      output: npmCapture.sink,
    })).toBe(1);
    expect(npmCapture.errors.join("\n")).toMatch(/npm ci failed: npm error EPROXY/);
  });

  it("inherits HOME so a globally ignored local settings file does not invent dirtiness", async () => {
    const git = discoverTrustedGit();
    expect(git).toBeTruthy();
    const root = temp("picc-global-ignore-repo-");
    const home = temp("picc-global-ignore-home-");
    makeRoot({ root });
    execFileSync(git!, ["init"], { cwd: root, stdio: "ignore" });
    execFileSync(git!, ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync(git!, ["config", "user.name", "PiCC Test"], { cwd: root });
    execFileSync(git!, ["add", "package.json", "package-lock.json"], { cwd: root });
    execFileSync(git!, ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });

    const excludes = path.join(home, "global-ignore");
    write(excludes, "**/.claude/settings.local.json\n");
    execFileSync(git!, ["config", "--file", path.join(home, ".gitconfig"), "core.excludesFile", excludes]);
    write(path.join(root, ".claude", "settings.local.json"), "{\"local\":true}\n");

    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    let npmCalls = 0;
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      const result = await runUpdate({
        packageRoot: root,
        runNpm: () => { npmCalls += 1; return child(); },
        validateSuite: healthySuite,
        output: outputCapture().sink,
      });
      expect(result).toBe(0);
      expect(npmCalls).toBe(1);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    }
  });

  it("passes inherited proxy, CA, and registry environment to the real npm child unchanged", async () => {
    const root = makeRoot();
    const directory = temp("picc-npm-env-");
    const cli = path.join(directory, "npm-cli.js");
    const canary = path.join(directory, "npm-env.json");
    write(cli, `import fs from "node:fs";
fs.writeFileSync(process.env.PICC_NPM_CANARY, JSON.stringify({
  args: process.argv.slice(2),
  proxy: process.env.HTTPS_PROXY,
  ca: process.env.NODE_EXTRA_CA_CERTS,
  registry: process.env.NPM_CONFIG_REGISTRY,
}));
`);
    fs.chmodSync(cli, 0o755);

    const saved = {
      npm: process.env.npm_execpath,
      proxy: process.env.HTTPS_PROXY,
      ca: process.env.NODE_EXTRA_CA_CERTS,
      registry: process.env.NPM_CONFIG_REGISTRY,
      canary: process.env.PICC_NPM_CANARY,
    };
    try {
      process.env.npm_execpath = cli;
      process.env.HTTPS_PROXY = "https://proxy.example.invalid:8443";
      process.env.NODE_EXTRA_CA_CERTS = path.join(directory, "corporate-ca.pem");
      process.env.NPM_CONFIG_REGISTRY = "https://registry.corp.invalid/";
      process.env.PICC_NPM_CANARY = canary;
      const result = await runUpdate({
        packageRoot: root,
        runGit: cleanGit,
        validateSuite: healthySuite,
        output: outputCapture().sink,
      });
      expect(result).toBe(0);
      const inherited = JSON.parse(fs.readFileSync(canary, "utf8")) as Record<string, unknown>;
      expect(inherited).toEqual({
        args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        proxy: "https://proxy.example.invalid:8443",
        ca: path.join(directory, "corporate-ca.pem"),
        registry: "https://registry.corp.invalid/",
      });
    } finally {
      const restore = (key: keyof NodeJS.ProcessEnv, value: string | undefined) => {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      };
      restore("npm_execpath", saved.npm);
      restore("HTTPS_PROXY", saved.proxy);
      restore("NODE_EXTRA_CA_CERTS", saved.ca);
      restore("NPM_CONFIG_REGISTRY", saved.registry);
      restore("PICC_NPM_CANARY", saved.canary);
    }
  });
});

describe("installed package update", () => {
  it("updates only the exact current global npm package root using normal npm configuration", async () => {
    const globalRoot = temp("picc-global-root-");
    const root = makeRoot({ root: path.join(globalRoot, "picc"), source: false });
    const calls: string[][] = [];
    const capture = outputCapture();
    const result = await runUpdate({
      packageRoot: root,
      globalRoot,
      runNpm: (args: string[]) => {
        calls.push(args);
        if (args[0] === "view") return child({ stdout: "\"0.2.0\"\n" });
        write(path.join(root, "package.json"), JSON.stringify({ name: "picc", version: "0.2.0" }));
        return child();
      },
      validateSuite: healthySuite,
      output: capture.sink,
    });

    expect(result).toBe(0);
    expect(calls).toEqual([
      ["view", "picc", "version", "--json"],
      ["install", "--global", "picc@latest", "--ignore-scripts", "--no-audit", "--no-fund"],
    ]);
    expect(capture.logs.join("\n")).toMatch(/updated PiCC to 0\.2\.0/);
  });

  it("checks a global install without mutating it when already current", async () => {
    const globalRoot = temp("picc-global-check-");
    const root = makeRoot({ root: path.join(globalRoot, "picc"), source: false });
    const calls: string[][] = [];
    const result = await runUpdate({
      action: "check",
      packageRoot: root,
      globalRoot,
      runNpm: (args: string[]) => {
        calls.push(args);
        return child({ stdout: "\"0.1.0\"\n" });
      },
      validateSuite: healthySuite,
      output: outputCapture().sink,
    });
    expect(result).toBe(0);
    expect(calls).toEqual([["view", "picc", "version", "--json"]]);
  });

  it("does not mutate a local, tarball, or other non-global installed copy", async () => {
    const root = makeRoot({ source: false });
    let npmCalls = 0;
    const capture = outputCapture();
    const result = await runUpdate({
      packageRoot: root,
      globalRoot: temp("different-global-root-"),
      runNpm: () => { npmCalls += 1; return child(); },
      validateSuite: healthySuite,
      output: capture.sink,
    });
    expect(result).toBe(1);
    expect(npmCalls).toBe(0);
    expect(capture.errors.join("\n")).toMatch(/owned by another package manager or project.*not modified/i);
    expect(capture.errors.join("\n")).toMatch(/npm install --global picc@latest/);
  });

  it("revalidates the exact requested global version after npm completes", async () => {
    const globalRoot = temp("picc-global-stale-");
    const root = makeRoot({ root: path.join(globalRoot, "picc"), source: false });
    const capture = outputCapture();
    const result = await runUpdate({
      packageRoot: root,
      globalRoot,
      runNpm: (args: string[]) => args[0] === "view"
        ? child({ stdout: "\"0.2.0\"\n" })
        : child(),
      validateSuite: healthySuite,
      output: capture.sink,
    });
    expect(result).toBe(1);
    expect(capture.errors.join("\n")).toMatch(/Expected PiCC 0\.2\.0; found 0\.1\.0/);
  });
});

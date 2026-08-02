import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPath, discoverTrustedGit, PI_SUITE_PACKAGES } from "../bin/picc-admin.mjs";
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
    type: "module",
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
  const process = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
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

const healthyRuntime = () => ({ ok: true, entries: {}, manifest: {} });
const healthySuite = () => ({ ok: true, version: "0.83.0" });
const piFailure = (reason: string) => ({ ok: false, reason: `${reason}. Run \`picc update\` or reinstall PiCC.` });
const cleanGit = () => child();

describe("source checkout update", () => {
  it("checks cleanliness, source freshness, and Pi without mutating", async () => {
    const root = makeRoot();
    const calls: string[] = [];
    const capture = outputCapture();
    const result = await runUpdate({
      action: "check",
      packageRoot: root,
      runGit: (args: string[], options: { cwd: string }) => {
        calls.push("git");
        expect(args).toEqual(["-C", canonicalPath(root), "status", "--porcelain"]);
        expect(options.cwd).toBe(canonicalPath(root));
        return child();
      },
      runNpm: () => { throw new Error("must not mutate"); },
      buildRuntime: () => { throw new Error("must not build"); },
      validateRuntime: (options: { checkSource: boolean }) => {
        calls.push("runtime");
        expect(options.checkSource).toBe(true);
        return healthyRuntime();
      },
      validateSuite: () => { calls.push("pi"); return healthySuite(); },
      output: capture.sink,
    });

    expect(result).toBe(0);
    expect(calls).toEqual(["git", "runtime", "pi"]);
    expect(capture.logs.join("\n")).toMatch(/clean.*verified runtime.*0\.83\.0/i);
  });

  it.each([
    ["staged", "A  staged.txt\n"],
    ["unstaged", " M changed.txt\n"],
    ["unmerged", "UU conflict.txt\n"],
    ["untracked", "?? new.txt\n"],
  ])("answers a dirty %s check, validates a healthy product, and never mutates", async (_kind, status) => {
    const root = makeRoot();
    const calls: string[] = [];
    const capture = outputCapture();
    const result = await runUpdate({
      action: "check",
      packageRoot: root,
      runGit: () => child({ stdout: status }),
      runNpm: () => { throw new Error("must not mutate"); },
      buildRuntime: () => { throw new Error("must not build"); },
      validateRuntime: () => { calls.push("runtime"); return healthyRuntime(); },
      validateSuite: () => { calls.push("pi"); return healthySuite(); },
      output: capture.sink,
    });

    expect(result).toBe(1);
    expect(calls).toEqual(["runtime", "pi"]);
    expect(capture.logs).toEqual([]);
    expect(capture.errors).toEqual([
      "PiCC: update refused because the source checkout has staged, unstaged, unmerged, or untracked changes. Keep intentional edits and run `node scripts/build-runtime.mjs` to refresh the compiled runtime.",
    ]);
  });

  it.each([
    {
      kind: "runtime-only",
      runtime: { ok: false, reason: "Runtime is stale." },
      suite: healthySuite(),
      expectedErrors: [
        "Outcome: the source checkout runtime needs rebuilding. Runtime is stale.",
        "After correcting the reported runtime problem, run `node scripts/build-runtime.mjs`, then `picc update --check`.",
      ],
    },
    {
      kind: "Pi-only",
      runtime: healthyRuntime(),
      suite: piFailure("The embedded Pi CLI is unavailable"),
      expectedErrors: [
        "Outcome: source dependencies are not coherent. The embedded Pi CLI is unavailable.",
        "After correcting the reported dependency problem, run `npm ci --ignore-scripts --no-audit --no-fund`, then `picc update --check`.",
      ],
    },
    {
      kind: "runtime-and-Pi",
      runtime: { ok: false, reason: "Runtime is stale." },
      suite: piFailure("The embedded Pi CLI is unavailable"),
      expectedErrors: [
        "Outcome: the source checkout runtime needs rebuilding. Runtime is stale.",
        "Outcome: source dependencies are not coherent. The embedded Pi CLI is unavailable.",
        "After correcting the reported problems, run `npm ci --ignore-scripts --no-audit --no-fund`, then `node scripts/build-runtime.mjs`, then `picc update --check`.",
      ],
    },
  ])("rejects a clean check for a $kind failure with component-aware recovery", async ({ runtime, suite, expectedErrors }) => {
    const root = makeRoot();
    const capture = outputCapture();
    const result = await runUpdate({
      action: "check",
      packageRoot: root,
      runGit: cleanGit,
      runNpm: () => { throw new Error("must not mutate"); },
      buildRuntime: () => { throw new Error("must not build"); },
      validateRuntime: () => runtime,
      validateSuite: () => suite,
      output: capture.sink,
    });

    expect(result).toBe(1);
    expect(capture.logs).toEqual([]);
    expect(capture.errors).toEqual(expectedErrors);
    expect(capture.errors.join("\n")).not.toContain("Run `picc update` or reinstall PiCC.");
  });

  it("runs clean check, one scripts-disabled npm ci, build, runtime validation, then Pi validation", async () => {
    const root = makeRoot();
    const calls: string[] = [];
    const result = await runUpdate({
      packageRoot: root,
      runGit: () => { calls.push("git"); return child(); },
      runNpm: (args: string[], options: { cwd: string }) => {
        calls.push("npm");
        expect(args).toEqual(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
        expect(options.cwd).toBe(canonicalPath(root));
        return child();
      },
      buildRuntime: (options: { packageRoot: string }) => {
        calls.push("build");
        expect(options.packageRoot).toBe(canonicalPath(root));
      },
      validateRuntime: (options: { packageRoot: string; checkSource: boolean }) => {
        calls.push("runtime");
        expect(options).toEqual({ packageRoot: canonicalPath(root), checkSource: true });
        return healthyRuntime();
      },
      validateSuite: () => { calls.push("pi"); return healthySuite(); },
      output: outputCapture().sink,
    });

    expect(result).toBe(0);
    expect(calls).toEqual(["git", "npm", "build", "runtime", "pi"]);
  });

  it("short-circuits each mutating source failure at its owner", async () => {
    const root = makeRoot();

    const dirtyCalls: string[] = [];
    expect(await runUpdate({
      packageRoot: root,
      runGit: () => child({ stdout: "?? edit.ts\n" }),
      runNpm: () => { dirtyCalls.push("npm"); return child(); },
      buildRuntime: () => { dirtyCalls.push("build"); },
      validateRuntime: () => { dirtyCalls.push("runtime"); return healthyRuntime(); },
      validateSuite: () => { dirtyCalls.push("pi"); return healthySuite(); },
      output: outputCapture().sink,
    })).toBe(1);
    expect(dirtyCalls).toEqual([]);

    const npmCalls: string[] = [];
    const npmCapture = outputCapture();
    expect(await runUpdate({
      packageRoot: root,
      runGit: cleanGit,
      runNpm: () => child({ code: 1, stderr: "npm failed" }),
      buildRuntime: () => { npmCalls.push("build"); },
      validateRuntime: () => { npmCalls.push("runtime"); return healthyRuntime(); },
      validateSuite: () => { npmCalls.push("pi"); return healthySuite(); },
      output: npmCapture.sink,
    })).toBe(1);
    expect(npmCalls).toEqual([]);
    expect(npmCapture.errors).toEqual([
      "PiCC: npm ci failed: npm failed",
      "Correct the reported npm error, then rerun `picc update` so dependency synchronization, runtime build, and product validation all follow.",
    ]);

    const buildCalls: string[] = [];
    const buildCapture = outputCapture();
    expect(await runUpdate({
      packageRoot: root,
      runGit: cleanGit,
      runNpm: () => child(),
      buildRuntime: () => { throw new Error("compile failed"); },
      validateRuntime: () => { buildCalls.push("runtime"); return healthyRuntime(); },
      validateSuite: () => { buildCalls.push("pi"); return healthySuite(); },
      output: buildCapture.sink,
    })).toBe(1);
    expect(buildCalls).toEqual([]);
    expect(buildCapture.errors).toEqual([
      "PiCC: dependency synchronization completed but the compiled runtime build failed: compile failed",
      "After correcting the reported build error, run `node scripts/build-runtime.mjs`, then run `picc update --check`.",
    ]);

    const runtimeCalls: string[] = [];
    const runtimeCapture = outputCapture();
    expect(await runUpdate({
      packageRoot: root,
      runGit: cleanGit,
      runNpm: () => child(),
      buildRuntime: () => undefined,
      validateRuntime: () => ({ ok: false, reason: "bad runtime" }),
      validateSuite: () => { runtimeCalls.push("pi"); return healthySuite(); },
      output: runtimeCapture.sink,
    })).toBe(1);
    expect(runtimeCalls).toEqual([]);
    expect(runtimeCapture.errors).toEqual([
      "PiCC: the runtime build completed but product validation failed. bad runtime",
      "After correcting the reported runtime problem, run `node scripts/build-runtime.mjs`, then run `picc update --check`.",
    ]);
  });

  it("rejects a post-build Pi-only failure with dependency-specific recovery", async () => {
    const root = makeRoot();
    const capture = outputCapture();
    const result = await runUpdate({
      packageRoot: root,
      runGit: cleanGit,
      runNpm: () => child(),
      buildRuntime: () => undefined,
      validateRuntime: healthyRuntime,
      validateSuite: () => piFailure("@earendil-works/pi-ai is 0.82.0; expected 0.83.0"),
      output: capture.sink,
    });

    expect(result).toBe(1);
    expect(capture.logs).not.toEqual(expect.arrayContaining([expect.stringMatching(/^Outcome:/)]));
    expect(capture.errors.join("\n")).toMatch(/Pi validation failed.*pi-ai is 0\.82\.0; expected 0\.83\.0/i);
    expect(capture.errors).toEqual([
      "PiCC: the runtime build completed but Pi validation failed. @earendil-works/pi-ai is 0.82.0; expected 0.83.0.",
      "After correcting the reported embedded Pi problem, run `npm ci --ignore-scripts --no-audit --no-fund`, then `node scripts/build-runtime.mjs`, then `picc update --check`.",
    ]);
    expect(capture.errors.join("\n")).not.toContain("Run `picc update` or reinstall PiCC.");
  });

  it("bounds synchronous starter throws and emitted spawn errors, preferring bounded stderr", async () => {
    const root = makeRoot();
    const spawnCapture = outputCapture();
    const longMessage = `missing-tool:${"x".repeat(70_000)}`;
    expect(await runUpdate({
      action: "check",
      packageRoot: root,
      runGit: () => child({ error: new Error(longMessage) }),
      output: spawnCapture.sink,
    })).toBe(1);
    expect(spawnCapture.errors[0]).toContain("missing-tool:");
    expect(spawnCapture.errors[0]!.length).toBeLessThanOrEqual(64 * 1024 + 32);

    const thrownCapture = outputCapture();
    expect(await runUpdate({
      action: "check",
      packageRoot: root,
      runGit: () => { throw new Error("synchronous starter failure"); },
      output: thrownCapture.sink,
    })).toBe(1);
    expect(thrownCapture.errors).toEqual(["PiCC: Git status failed: synchronous starter failure"]);

    const stderrCapture = outputCapture();
    const stderrTail = "TAIL-界";
    const longStderr = `${"界".repeat(30_000)}${stderrTail}`;
    expect(await runUpdate({
      action: "check",
      packageRoot: root,
      runGit: () => child({ stderr: longStderr, error: new Error("spawn detail") }),
      output: stderrCapture.sink,
    })).toBe(1);
    expect(stderrCapture.errors[0]).toContain(stderrTail);
    expect(stderrCapture.errors[0]).not.toContain("spawn detail");
    expect(Buffer.byteLength(stderrCapture.errors[0]!, "utf8")).toBeLessThanOrEqual(64 * 1024 + 32);
  });

  it("distinguishes an invalid PICC_GIT override from Git absent on PATH without exposing the override", async () => {
    const root = makeRoot();
    const savedGit = process.env.PICC_GIT;
    const savedPath = process.env.PATH;
    const secretOverride = path.join(root, "secret-invalid-git");
    try {
      process.env.PICC_GIT = secretOverride;
      const overrideCapture = outputCapture();
      expect(await runUpdate({ action: "check", packageRoot: root, output: overrideCapture.sink })).toBe(1);
      expect(overrideCapture.errors).toEqual([
        "PiCC: Git status failed: PICC_GIT does not identify a trusted Git executable; correct or unset the override",
      ]);
      expect(overrideCapture.errors.join("\n")).not.toContain(secretOverride);

      delete process.env.PICC_GIT;
      process.env.PATH = "";
      const pathCapture = outputCapture();
      expect(await runUpdate({ action: "check", packageRoot: root, output: pathCapture.sink })).toBe(1);
      expect(pathCapture.errors).toEqual([
        "PiCC: Git status failed: Git was not found on PATH; install Git or set PICC_GIT to its absolute path",
      ]);
    } finally {
      if (savedGit === undefined) delete process.env.PICC_GIT; else process.env.PICC_GIT = savedGit;
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });

  it("reports Git failure before product inspection", async () => {
    const root = makeRoot();
    const capture = outputCapture();
    let validations = 0;
    const result = await runUpdate({
      action: "check",
      packageRoot: root,
      runGit: () => child({ code: 2, stderr: "fatal: broken repository" }),
      validateRuntime: () => { validations += 1; return healthyRuntime(); },
      validateSuite: () => { validations += 1; return healthySuite(); },
      output: capture.sink,
    });
    expect(result).toBe(1);
    expect(validations).toBe(0);
    expect(capture.errors.join("\n")).toMatch(/Git status failed: fatal: broken repository/);
  });

  it("does not report coherence when the embedded Pi CLI is missing", async () => {
    const root = makeRoot();
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    manifest.dependencies = Object.fromEntries(PI_SUITE_PACKAGES.map((name) => [name, "0.83.0"]));
    write(manifestPath, JSON.stringify(manifest));
    for (const name of PI_SUITE_PACKAGES) {
      write(path.join(root, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({
        name, version: "0.83.0",
      }));
    }
    const capture = outputCapture();
    const result = await runUpdate({
      action: "check",
      packageRoot: root,
      runGit: cleanGit,
      validateRuntime: healthyRuntime,
      output: capture.sink,
    });
    expect(result).toBe(1);
    expect(capture.errors.join("\n")).toMatch(/embedded Pi CLI is unavailable/i);
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
        buildRuntime: () => undefined,
        validateRuntime: healthyRuntime,
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

  it("passes inherited proxy, CA, and registry environment to npm without argument overrides", async () => {
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
        buildRuntime: () => undefined,
        validateRuntime: healthyRuntime,
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

describe("global npm update and repair", () => {
  function globalFixture(version = "0.1.0") {
    const globalRoot = temp("picc-global-root-");
    const root = makeRoot({ root: path.join(globalRoot, "picc"), source: false, version });
    return { globalRoot, root };
  }

  it("checks version, runtime, and Pi without mutating", async () => {
    const { globalRoot, root } = globalFixture();
    const calls: string[] = [];
    const capture = outputCapture();
    const result = await runUpdate({
      action: "check",
      packageRoot: root,
      globalRoot,
      runNpm: (args: string[]) => {
        calls.push("version");
        expect(args).toEqual(["view", "picc", "version", "--json"]);
        return child({ stdout: "\"0.1.0\"\n" });
      },
      buildRuntime: () => { throw new Error("installed packages never build"); },
      validateRuntime: (options: { checkSource: boolean }) => {
        calls.push("runtime");
        expect(options.checkSource).toBe(false);
        return healthyRuntime();
      },
      validateSuite: () => { calls.push("pi"); return healthySuite(); },
      output: capture.sink,
    });
    expect(result).toBe(0);
    expect(calls).toEqual(["version", "runtime", "pi"]);
    expect(capture.logs.join("\n")).toMatch(/up to date.*verified runtime/i);
  });

  it.each([
    ["runtime-only", { ok: false, reason: "Runtime is damaged." }, healthySuite, "Runtime is damaged."],
    ["Pi-only", healthyRuntime(), () => piFailure("The embedded Pi CLI is unavailable"), "The embedded Pi CLI is unavailable."],
  ])("reports repair-needed for a %s invalid global check", async (_kind, runtime, suite, reason) => {
    const { globalRoot, root } = globalFixture();
    const capture = outputCapture();
    const result = await runUpdate({
      action: "check",
      packageRoot: root,
      globalRoot,
      runNpm: () => child({ stdout: "\"0.1.0\"" }),
      validateRuntime: () => runtime,
      validateSuite: suite,
      output: capture.sink,
    });
    expect(result).toBe(1);
    expect(capture.logs).toEqual([]);
    expect(capture.errors).toEqual([
      `Outcome: the installed PiCC package needs repair. ${reason}`,
      "Run `picc update`, then run `picc update --check` to verify the repaired global npm product.",
    ]);
    expect(capture.errors.join("\n")).not.toContain("Run `picc update` or reinstall PiCC.");
  });

  it("uses a replacement-forcing reinstall at the same version and post-validates package, runtime, and Pi", async () => {
    const { globalRoot, root } = globalFixture();
    const calls: string[] = [];
    let runtimeChecks = 0;
    let piChecks = 0;
    const capture = outputCapture();
    const result = await runUpdate({
      packageRoot: root,
      globalRoot,
      runNpm: (args: string[], options: { cwd: string }) => {
        calls.push(args.join(" "));
        if (args[0] === "install") expect(options.cwd).toBe(canonicalPath(globalRoot));
        return args[0] === "view" ? child({ stdout: "\"0.1.0\"" }) : child();
      },
      buildRuntime: () => { throw new Error("installed packages never build"); },
      validateRuntime: () => {
        runtimeChecks += 1;
        return runtimeChecks === 1 ? { ok: false, reason: "Runtime is damaged." } : healthyRuntime();
      },
      validateSuite: () => { piChecks += 1; return healthySuite(); },
      output: capture.sink,
    });

    expect(result).toBe(0);
    expect(calls).toEqual([
      "view picc version --json",
      "install --global --force picc@latest --ignore-scripts --no-audit --no-fund",
    ]);
    expect(runtimeChecks).toBe(2);
    expect(piChecks).toBe(2);
    expect(capture.logs.join("\n")).toMatch(/repaired PiCC 0\.1\.0.*verified runtime/i);
  });

  it("updates a newer version without force and re-reads its manifest", async () => {
    const { globalRoot, root } = globalFixture();
    const calls: string[][] = [];
    const result = await runUpdate({
      packageRoot: root,
      globalRoot,
      runNpm: (args: string[]) => {
        calls.push(args);
        if (args[0] === "view") return child({ stdout: "\"0.2.0\"" });
        write(path.join(root, "package.json"), JSON.stringify({ name: "picc", version: "0.2.0", type: "module" }));
        return child();
      },
      validateRuntime: healthyRuntime,
      validateSuite: healthySuite,
      output: outputCapture().sink,
    });
    expect(result).toBe(0);
    expect(calls[1]).toEqual(["install", "--global", "picc@latest", "--ignore-scripts", "--no-audit", "--no-fund"]);
  });

  it("rejects a completed update whose package version was not replaced while still post-validating runtime and Pi", async () => {
    const { globalRoot, root } = globalFixture();
    let runtimeChecks = 0;
    let piChecks = 0;
    const capture = outputCapture();
    const result = await runUpdate({
      packageRoot: root,
      globalRoot,
      runNpm: (args: string[]) => args[0] === "view" ? child({ stdout: "\"0.2.0\"" }) : child(),
      validateRuntime: () => { runtimeChecks += 1; return healthyRuntime(); },
      validateSuite: () => { piChecks += 1; return healthySuite(); },
      output: capture.sink,
    });
    expect(result).toBe(1);
    expect(runtimeChecks).toBe(2);
    expect(piChecks).toBe(2);
    expect(capture.errors.join("\n")).toMatch(/Expected PiCC 0\.2\.0; found 0\.1\.0/i);
  });

  it.each(["runtime", "Pi"] as const)("rejects a completed repair with a post-install %s-only failure", async (failedOwner) => {
    const { globalRoot, root } = globalFixture();
    let runtimeChecks = 0;
    let piChecks = 0;
    const capture = outputCapture();
    const result = await runUpdate({
      packageRoot: root,
      globalRoot,
      runNpm: (args: string[]) => args[0] === "view" ? child({ stdout: "\"0.1.0\"" }) : child(),
      validateRuntime: () => {
        runtimeChecks += 1;
        return failedOwner === "runtime"
          ? { ok: false, reason: runtimeChecks === 1 ? "Runtime was corrupt." : "Runtime is still corrupt." }
          : healthyRuntime();
      },
      validateSuite: () => {
        piChecks += 1;
        return failedOwner === "Pi"
          ? piFailure(piChecks === 1 ? "The embedded Pi CLI was incoherent" : "The embedded Pi CLI is still incoherent")
          : healthySuite();
      },
      output: capture.sink,
    });
    expect(result).toBe(1);
    expect(runtimeChecks).toBe(2);
    expect(piChecks).toBe(2);
    expect(capture.logs).toEqual([]);
    const expectedReason = failedOwner === "runtime" ? "Runtime is still corrupt." : "The embedded Pi CLI is still incoherent.";
    expect(capture.errors).toEqual([
      `PiCC: npm completed but the installed product did not validate. ${expectedReason}`,
      "Repair this global npm-owned copy with `npm install --global --force picc@latest --ignore-scripts --no-audit --no-fund`, then run `picc update --check`.",
    ]);
    expect(capture.errors.join("\n")).not.toContain("Run `picc update` or reinstall PiCC.");
  });

  it("short-circuits a failed npm repair before post-validation", async () => {
    const { globalRoot, root } = globalFixture();
    let runtimeChecks = 0;
    let piChecks = 0;
    const result = await runUpdate({
      packageRoot: root,
      globalRoot,
      runNpm: (args: string[]) => args[0] === "view"
        ? child({ stdout: "\"0.1.0\"" })
        : child({ code: 1, stderr: "permission denied" }),
      validateRuntime: () => { runtimeChecks += 1; return { ok: false, reason: "bad" }; },
      validateSuite: () => { piChecks += 1; return healthySuite(); },
      output: outputCapture().sink,
    });
    expect(result).toBe(1);
    expect(runtimeChecks).toBe(1);
    expect(piChecks).toBe(1);
  });

  it("does not mutate or inspect product state for another installation owner", async () => {
    const root = makeRoot({ source: false });
    let calls = 0;
    const capture = outputCapture();
    const result = await runUpdate({
      packageRoot: root,
      globalRoot: temp("different-global-root-"),
      runNpm: () => { calls += 1; return child(); },
      buildRuntime: () => { calls += 1; },
      validateRuntime: () => { calls += 1; return healthyRuntime(); },
      validateSuite: () => { calls += 1; return healthySuite(); },
      output: capture.sink,
    });
    expect(result).toBe(1);
    expect(calls).toBe(0);
    expect(capture.errors.join("\n")).toMatch(/owned by another package manager or project.*not modified/i);
  });
});

describe("installed administrative updater shape", () => {
  it("loads without scripts and reaches injected global check, repair, and non-owner routes", async () => {
    const globalRoot = temp("picc-installed-admin-");
    const root = path.join(globalRoot, "picc");
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    for (const relative of ["package.json", "bin/picc-update.mjs", "bin/picc-admin.mjs", "bin/picc-runtime.mjs"]) {
      const source = path.join(repositoryRoot, relative);
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    expect(fs.existsSync(path.join(root, "scripts"))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
    const fixtureModule = await import(`${pathToFileURL(path.join(root, "bin", "picc-update.mjs")).href}?installed-shape`);
    const fixtureRunUpdate = fixtureModule.runUpdate as typeof runUpdate;

    const checkCapture = outputCapture();
    expect(await fixtureRunUpdate({
      action: "check",
      packageRoot: root,
      globalRoot,
      runNpm: () => child({ stdout: JSON.stringify(manifest.version) }),
      validateRuntime: healthyRuntime,
      validateSuite: healthySuite,
      output: checkCapture.sink,
    })).toBe(0);
    expect(checkCapture.logs.join("\n")).toMatch(/up to date.*verified runtime/i);

    let runtimeChecks = 0;
    const repairCapture = outputCapture();
    expect(await fixtureRunUpdate({
      packageRoot: root,
      globalRoot,
      runNpm: (args: string[]) => args[0] === "view"
        ? child({ stdout: JSON.stringify(manifest.version) })
        : child(),
      validateRuntime: () => {
        runtimeChecks += 1;
        return runtimeChecks === 1 ? { ok: false, reason: "Runtime is damaged." } : healthyRuntime();
      },
      validateSuite: healthySuite,
      output: repairCapture.sink,
    })).toBe(0);
    expect(repairCapture.logs.join("\n")).toMatch(/repaired.*verified runtime/i);

    for (const action of ["check", "update"] as const) {
      const nonOwnerCapture = outputCapture();
      expect(await fixtureRunUpdate({
        action,
        packageRoot: root,
        globalRoot: temp("picc-other-owner-"),
        runNpm: () => { throw new Error("must not inspect or mutate"); },
        validateRuntime: () => { throw new Error("must not validate"); },
        validateSuite: () => { throw new Error("must not validate"); },
        output: nonOwnerCapture.sink,
      })).toBe(1);
      expect(nonOwnerCapture.errors.join("\n")).toMatch(/owned by another package manager or project/i);
    }
  });
});

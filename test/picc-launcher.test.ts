import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitUntil } from "./helpers/async.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherSource = path.join(repoRoot, "bin", "picc.mjs");
const adminSource = path.join(repoRoot, "bin", "picc-admin.mjs");
const suite = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;
const cleanup: string[] = [];
const admin = await import("../bin/picc-admin.mjs");

async function callAdmin(expression: string, ...args: string[]): Promise<unknown> {
  const script = `import * as admin from ${JSON.stringify(pathToFileURL(adminSource).href)}; const value = await (${expression}); console.log(JSON.stringify(value));`;
  const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", script, ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error); else resolve({ stdout });
    });
  });
  return JSON.parse(stdout.trim());
}

async function callAdminWithEnv(expression: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const script = `import * as admin from ${JSON.stringify(pathToFileURL(adminSource).href)}; const value = await (${expression}); console.log(JSON.stringify(value));`;
  const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, ...env } }, (error, stdout) => {
      if (error) reject(error); else resolve({ stdout });
    });
  });
  return JSON.parse(stdout.trim());
}

const trustedGit = admin.discoverTrustedGit() ?? null;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function tempDir(label = "picc launcher "): Promise<string> {
  const result = await mkdtemp(path.join(os.tmpdir(), label));
  cleanup.push(result);
  return result;
}

async function put(filename: string, content: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

async function exec(executable: string, args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && error.code === undefined) reject(error);
      else resolve({ code: error?.code as number | null ?? 0, stdout, stderr });
    });
  });
}

type FixtureOptions = { exact?: boolean; root?: string; source?: boolean; version?: string; lock?: boolean };

async function makeFixture(options: FixtureOptions = {}) {
  const root = options.root ?? await tempDir();
  const version = options.version ?? "0.81.1";
  const exact = options.exact ?? !options.source;
  await put(path.join(root, "bin", "picc.mjs"), await readFile(launcherSource, "utf8"));
  await put(path.join(root, "bin", "picc-admin.mjs"), await readFile(adminSource, "utf8"));
  await put(path.join(root, "picc", "index.ts"), "export default () => {};\n");
  const dependencies = Object.fromEntries(suite.map((name) => [name, exact ? version : `^${version}`]));
  await put(path.join(root, "package.json"), JSON.stringify({ name: "picc", version: "1.2.3", type: "module", dependencies }));
  if (options.source) {
    if (!trustedGit) throw new Error("trusted Git required for source fixture");
    const initialized = await exec(trustedGit, ["init", "--quiet"], root);
    if (initialized.code !== 0) throw new Error("could not initialize source fixture");
  }
  const packages: Record<string, unknown> = { "": { name: "picc", version: "1.2.3", dependencies } };
  for (const name of suite) {
    const packageRoot = path.join(root, "node_modules", ...name.split("/"));
    await put(path.join(packageRoot, "package.json"), JSON.stringify({ name, version, type: "module", exports: "./dist/index.js" }));
    await put(path.join(packageRoot, "dist", "index.js"), "export {};\n");
    packages[`node_modules/${name}`] = { name, version };
  }
  const cli = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  await put(cli, `import fs from "node:fs";
import path from "node:path";
const payload = { argv: process.argv.slice(2), ppid: process.ppid, env: { pid: process.env.PICC_LAUNCHER_PID, kind: process.env.PICC_INSTALL_KIND, version: process.env.PICC_VERSION, skip: process.env.PI_SKIP_VERSION_CHECK } };
if (process.env.PICC_CAPTURE) fs.writeFileSync(process.env.PICC_CAPTURE, JSON.stringify(payload));
if (process.env.PICC_LIFECYCLE_READY && process.env.PICC_LIFECYCLE_RELEASE) {
  const ready = process.env.PICC_LIFECYCLE_READY;
  const release = process.env.PICC_LIFECYCLE_RELEASE;
  fs.writeFileSync(ready + ".new", JSON.stringify({ pid: process.pid, ppid: process.ppid }));
  fs.renameSync(ready + ".new", ready);
  const finish = () => { if (fs.existsSync(release)) { watcher.close(); process.exit(0); } };
  const watcher = fs.watch(path.dirname(release), finish);
  finish();
} else if (process.env.PICC_FAKE_SIGNAL) process.kill(process.pid, process.env.PICC_FAKE_SIGNAL);
else process.exit(Number(process.env.PICC_FAKE_EXIT ?? 0));\n`);
  if (options.lock ?? options.source ?? false) {
    await put(path.join(root, "package-lock.json"), JSON.stringify({ name: "picc", version: "1.2.3", lockfileVersion: 3, packages }));
  }
  return { root, cli, packages, dependencies };
}

function run(filename: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [filename, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function validate(root: string, mode?: string): Promise<Record<string, unknown>> {
  return admin.validatePiSuite({ packageRoot: root, ...(mode ? { mode } : {}) });
}

describe("PiCC launcher administration boundary", () => {
  it.each(["--help", "-h"])("handles %s without an installed Pi", async (token) => {
    const fixture = await makeFixture();
    await rm(path.join(fixture.root, "node_modules"), { recursive: true });
    const result = await run(path.join(fixture.root, "bin", "picc.mjs"), [token]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Usage: picc");
  });

  it.each(["--version", "-v"])("reports validated installed status before launching Pi", async (token) => {
    const fixture = await makeFixture();
    const result = await run(path.join(fixture.root, "bin", "picc.mjs"), [token]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("PiCC 1.2.3\nEmbedded Pi 0.81.1 (strict-exact)\nInstall unknown/other");
    await rm(path.join(fixture.root, "node_modules"), { recursive: true });
    const missing = await run(path.join(fixture.root, "bin", "picc.mjs"), [token]);
    expect(missing.stdout).toContain("Embedded Pi unavailable/incoherent");
    expect(missing.stdout).not.toContain("^0.81.1");
  });

  it.each([
    ["--help", "extra"], ["--version", "extra"], ["update", "--nope"], ["update", "--check", "extra"],
  ])("rejects unsupported administrative tails: %s %s", async (...args) => {
    const fixture = await makeFixture();
    const result = await run(path.join(fixture.root, "bin", "picc.mjs"), args);
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toBe("PiCC: invalid administrative arguments. Run `picc --help` for usage.\n");
  });

  it.each([["update"], ["update", "--check"], ["update", "--help"]])("keeps %s out of Pi when updater is unavailable", async (...args) => {
    const fixture = await makeFixture();
    const capture = path.join(fixture.root, "capture.json");
    const result = await run(path.join(fixture.root, "bin", "picc.mjs"), args, { env: { PICC_CAPTURE: capture } });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("PiCC: updater unavailable in this build. Reinstall PiCC or update from its source checkout.\n");
    expect(existsSync(capture)).toBe(false);
  });

  it.each([undefined, "--check", "--help"])("passes updater action and exit status for %s", async (tail) => {
    const fixture = await makeFixture();
    const capture = path.join(fixture.root, "update.json");
    await put(path.join(fixture.root, "bin", "picc-update.mjs"), `import fs from "node:fs"; export function runUpdate(value) { fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(value)); return 23; }`);
    const result = await run(path.join(fixture.root, "bin", "picc.mjs"), tail ? ["update", tail] : ["update"]);
    expect(result.code).toBe(23);
    expect(JSON.parse(await readFile(capture, "utf8"))).toEqual({ action: tail === "--check" ? "check" : tail === "--help" ? "help" : "update" });
  });

  it("maps broken updater imports but preserves updater-owned safe errors", async () => {
    const fixture = await makeFixture();
    const updater = path.join(fixture.root, "bin", "picc-update.mjs");
    await put(updater, "this is not javascript !");
    const broken = await run(path.join(fixture.root, "bin", "picc.mjs"), ["update"]);
    expect(broken.stderr).toBe("PiCC: updater unavailable in this build. Reinstall PiCC or update from its source checkout.\n");
    await put(updater, `import { safeAdministrativeError } from "./picc-admin.mjs"; export function runUpdate() { throw safeAdministrativeError("PiCC: update refused because the checkout is dirty."); }`);
    const safe = await run(path.join(fixture.root, "bin", "picc.mjs"), ["update"]);
    expect(safe.stderr).toBe("PiCC: update refused because the checkout is dirty.\n");
  });

  it("preserves full argv, canonical extension, ppid, and child context", async () => {
    const parent = await tempDir("local fixture ");
    await put(path.join(parent, "package.json"), JSON.stringify({ name: "consumer" }));
    const fixture = await makeFixture({ root: path.join(parent, "node_modules", "picc") });
    const capture = path.join(parent, "capture.json");
    const args = ["-p", "spaces stay", "--", "update"];
    const result = await run(path.join(fixture.root, "bin", "picc.mjs"), args, { env: { PICC_CAPTURE: capture } });
    expect(result.code).toBe(0);
    const payload = JSON.parse(await readFile(capture, "utf8"));
    const expectedExtension = await realpath(path.join(fixture.root, "picc", "index.ts"));
    expect(payload.argv).toEqual(["-e", process.platform === "win32" ? expectedExtension.toLowerCase() : expectedExtension, ...args]);
    expect(payload.env).toEqual({ pid: String(payload.ppid), kind: "known local package", version: "1.2.3", skip: "1" });
  });

  it("does not resolve a target or ancestor fake Pi", async () => {
    const fixture = await makeFixture();
    const target = await tempDir("target fake ");
    await put(path.join(target, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }));
    const result = await run(path.join(fixture.root, "bin", "picc.mjs"), [], { cwd: target });
    expect(result).toMatchObject({ code: 0, stderr: "" });
  });

  it("preserves nonzero exit and gives fixed actionable runtime failures", async () => {
    const fixture = await makeFixture();
    expect((await run(path.join(fixture.root, "bin", "picc.mjs"), [], { env: { PICC_FAKE_EXIT: "37" } })).code).toBe(37);
    await rm(fixture.cli);
    const missing = await run(path.join(fixture.root, "bin", "picc.mjs"), []);
    expect(missing).toMatchObject({ code: 1, stderr: "PiCC: the embedded Pi runtime is incomplete or inconsistent. Run `picc update` or reinstall PiCC.\n" });
    expect(missing.stderr).not.toContain(fixture.root);
  });

  it("wires spawn errors, exit codes, and signals independently", () => {
    const spawnError = vi.fn();
    const exitCode = vi.fn();
    const signal = vi.fn();
    const failed = new EventEmitter();
    admin.wireChildLifecycle(failed, { onSpawnError: spawnError, onExitCode: exitCode, onSignal: signal });
    failed.emit("error", new Error("deterministic fake spawn failure"));
    failed.emit("exit", 9, null);
    expect(spawnError).toHaveBeenCalledOnce();
    expect(exitCode).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();

    const exited = new EventEmitter();
    admin.wireChildLifecycle(exited, { onSpawnError: spawnError, onExitCode: exitCode, onSignal: signal });
    exited.emit("exit", 37, null);
    expect(exitCode).toHaveBeenLastCalledWith(37);

    const signaled = new EventEmitter();
    admin.wireChildLifecycle(signaled, { onSpawnError: spawnError, onExitCode: exitCode, onSignal: signal });
    signaled.emit("exit", null, "SIGTERM");
    expect(signal).toHaveBeenLastCalledWith("SIGTERM");
  });

  it("keeps a real launcher and package-owned Pi child joined through gated completion", async () => {
    const fixture = await makeFixture();
    const ready = path.join(fixture.root, "lifecycle.ready");
    const release = path.join(fixture.root, "lifecycle.release");
    const launcher = spawn(process.execPath, [path.join(fixture.root, "bin", "picc.mjs")], {
      env: { ...process.env, PICC_LIFECYCLE_READY: ready, PICC_LIFECYCLE_RELEASE: release },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let stderr = "";
    launcher.stderr.on("data", (chunk) => { stderr += String(chunk); });
    launcher.on("close", (code, signalValue) => { closed = { code, signal: signalValue }; });
    let childPid: number | undefined;
    const alive = (pid: number | undefined) => {
      if (!pid) return false;
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    try {
      await waitUntil({ predicate: () => existsSync(ready), description: "package-owned Pi child readiness" });
      const payload = JSON.parse(await readFile(ready, "utf8")) as { pid: number; ppid: number };
      childPid = payload.pid;
      expect(payload.ppid).toBe(launcher.pid);
      expect(alive(launcher.pid)).toBe(true);
      expect(alive(childPid)).toBe(true);
      await writeFile(release, "release\n");
      await waitUntil({ predicate: () => closed !== undefined, description: "launcher settlement after child release" });
      expect(closed).toEqual({ code: 0, signal: null });
      expect(stderr).toBe("");
      await waitUntil({ predicate: () => !alive(childPid), description: "package-owned Pi child termination" });
      expect(alive(launcher.pid)).toBe(false);
    } finally {
      await writeFile(release, "release\n").catch(() => undefined);
      if (alive(childPid)) process.kill(childPid!, "SIGTERM");
      if (alive(launcher.pid)) launcher.kill("SIGTERM");
      await waitUntil({ predicate: () => !alive(childPid) && !alive(launcher.pid), description: "launcher lifecycle cleanup" });
    }
  });

  it.skipIf(process.platform === "win32")("propagates the embedded Pi termination signal", async () => {
    const fixture = await makeFixture();
    const result = await run(path.join(fixture.root, "bin", "picc.mjs"), [], { env: { PICC_FAKE_SIGNAL: "SIGTERM" } });
    expect(result).toMatchObject({ code: null, signal: "SIGTERM" });
  });
});

describe("shared launcher graph policy", () => {
  it.skipIf(!trustedGit)("selects coherent bootstrap only for a Git-owned source and strict validation for exact pins", async () => {
    const ranged = await makeFixture({ source: true });
    expect(await validate(ranged.root)).toMatchObject({ ok: true, mode: "coherent-bootstrap", version: "0.81.1" });
    expect(await validate(ranged.root, "strict-exact")).toMatchObject({ ok: false });
    const fake = await makeFixture({ exact: false });
    await put(path.join(fake.root, ".git"), "gitdir: forged\n");
    expect(await validate(fake.root)).toMatchObject({ ok: false, reason: "Non-source PiCC installs require exact Pi suite declarations" });
  });

  it("implements caret semantics for every pre-1.0 boundary without numeric rounding", async () => {
    expect(admin.compareStableVersions("9007199254740993.0.0", "9007199254740992.999.999")).toBe(1);
    expect(admin.parseStableExactVersion("1.2.3-beta.1")?.raw ?? null).toBeNull();
    for (const [declaration, installed, ok] of [
      ["^0.81.1", "0.81.9", true], ["^0.81.1", "0.82.0", false],
      ["^0.0.3", "0.0.3", true], ["^0.0.3", "0.0.4", false],
      ["^1.2.3", "1.99.0", true], ["^1.2.3", "2.0.0", false],
    ] as const) {
      const fixture = await makeFixture({ exact: false, version: installed });
      const manifest = JSON.parse(await readFile(path.join(fixture.root, "package.json"), "utf8"));
      manifest.dependencies = Object.fromEntries(suite.map((name) => [name, declaration]));
      await put(path.join(fixture.root, "package.json"), JSON.stringify(manifest));
      expect((await validate(fixture.root, "coherent-bootstrap")).ok).toBe(false); // non-source ranges always refuse
      const exactFixture = await makeFixture({ exact: true, version: installed });
      const exactManifest = JSON.parse(await readFile(path.join(exactFixture.root, "package.json"), "utf8"));
      exactManifest.dependencies = Object.fromEntries(suite.map((name) => [name, declaration]));
      await put(path.join(exactFixture.root, "package.json"), JSON.stringify(exactManifest));
      if (trustedGit) {
        await exec(trustedGit, ["init", "--quiet"], exactFixture.root);
        await put(path.join(exactFixture.root, "package-lock.json"), JSON.stringify({ packages: { "": {}, ...Object.fromEntries(suite.map((name) => [`node_modules/${name}`, { version: installed }])) } }));
        expect((await validate(exactFixture.root)).ok).toBe(ok);
      }
    }
  });

  it("rejects malformed, mixed, missing, stale, and unsatisfied graph state", async () => {
    const malformed = await makeFixture();
    const manifest = JSON.parse(await readFile(path.join(malformed.root, "package.json"), "utf8"));
    manifest.dependencies[suite[0]] = "latest";
    await put(path.join(malformed.root, "package.json"), JSON.stringify(manifest));
    expect(await validate(malformed.root)).toMatchObject({ ok: false, reason: "PiCC has malformed Pi suite declarations" });

    const missing = await makeFixture();
    await rm(path.join(missing.root, "node_modules", ...suite[0].split("/")), { recursive: true });
    expect(await validate(missing.root)).toMatchObject({ ok: false, reason: "The embedded Pi suite is incomplete" });

    const unsatisfied = await makeFixture({ version: "0.82.0" });
    const unsatisfiedManifest = JSON.parse(await readFile(path.join(unsatisfied.root, "package.json"), "utf8"));
    for (const name of suite) unsatisfiedManifest.dependencies[name] = "0.81.1";
    await put(path.join(unsatisfied.root, "package.json"), JSON.stringify(unsatisfiedManifest));
    expect(await validate(unsatisfied.root)).toMatchObject({ ok: false, reason: "The installed Pi suite does not satisfy PiCC's declarations" });

    if (trustedGit) {
      const noLock = await makeFixture({ source: true });
      await rm(path.join(noLock.root, "package-lock.json"));
      expect(await validate(noLock.root)).toMatchObject({ ok: false, reason: "The source lockfile is missing or malformed" });
      const stale = await makeFixture({ source: true });
      const lock = JSON.parse(await readFile(path.join(stale.root, "package-lock.json"), "utf8"));
      lock.packages[`node_modules/${suite[0]}`].version = "0.80.0";
      await put(path.join(stale.root, "package-lock.json"), JSON.stringify(lock));
      expect(await validate(stale.root)).toMatchObject({ ok: false, reason: "The installed Pi suite is stale; run `picc update`" });
    }
  });

  it("finds mixed copies through direct and non-suite intermediary node_modules", async () => {
    for (const intermediary of [[], ["ordinary-package", "node_modules"]]) {
      const fixture = await makeFixture();
      const nested = path.join(fixture.root, "node_modules", ...intermediary, ...suite[1].split("/"));
      await put(path.join(nested, "package.json"), JSON.stringify({ name: suite[1], version: "0.80.0" }));
      expect(await validate(fixture.root)).toMatchObject({ ok: false, reason: "The installed Pi suite contains mixed versions" });
    }
  });

  it("rejects malformed lock paths and lock/runtime roots that cannot correlate", async () => {
    if (!trustedGit) return;
    for (const malicious of ["../node_modules/@earendil-works/pi-ai", "/node_modules/@earendil-works/pi-ai", "C:/node_modules/@earendil-works/pi-ai", "//host/share/node_modules/@earendil-works/pi-ai", "node_modules\\@earendil-works\\pi-ai"]) {
      const fixture = await makeFixture({ source: true });
      const lock = JSON.parse(await readFile(path.join(fixture.root, "package-lock.json"), "utf8"));
      lock.packages[malicious] = { version: "0.81.1" };
      await put(path.join(fixture.root, "package-lock.json"), JSON.stringify(lock));
      expect(await validate(fixture.root)).toMatchObject({ ok: false, reason: "The PiCC lockfile is malformed" });
    }
  });

  it("resolves a validated npm-hoisted suite from the package installation tree", async () => {
    const parent = await tempDir("hoisted fixture ");
    await put(path.join(parent, "package.json"), JSON.stringify({ name: "fixture-consumer" }));
    const fixture = await makeFixture({ root: path.join(parent, "node_modules", "picc") });
    for (const name of suite) {
      const destination = path.join(parent, "node_modules", ...name.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(path.join(fixture.root, "node_modules", ...name.split("/")), destination);
    }
    await rm(path.join(fixture.root, "node_modules"), { recursive: true, force: true });
    expect(await validate(fixture.root)).toMatchObject({ ok: true, mode: "strict-exact" });
  });

  it("rejects package and CLI symlink escapes from admissible roots", async () => {
    const external = await tempDir("escaped package ");
    await put(path.join(external, "package.json"), JSON.stringify({ name: suite[0], version: "0.81.1" }));
    const fixture = await makeFixture();
    const packageRoot = path.join(fixture.root, "node_modules", ...suite[0].split("/"));
    await rm(packageRoot, { recursive: true });
    await symlink(external, packageRoot, process.platform === "win32" ? "junction" : "dir");
    expect(await validate(fixture.root)).toMatchObject({ ok: false });

    const cliExternal = await tempDir("escaped cli ");
    await put(path.join(cliExternal, "cli.js"), "export {};\n");
    const clean = await makeFixture();
    const dist = path.dirname(clean.cli);
    await rm(dist, { recursive: true });
    await symlink(cliExternal, dist, process.platform === "win32" ? "junction" : "dir");
    expect(admin.resolvePiCli(clean.root)).toMatchObject({ ok: false, reason: "The embedded Pi CLI is unavailable" });
  });

  it("validates the real checkout with a bounded measured node_modules scan", async () => {
    const started = performance.now();
    const result = await validate(repoRoot);
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ ok: true, version: "0.81.1" });
    expect(result.scannedNodeModules).toBeTypeOf("number");
    expect(result.scannedNodeModules as number).toBeLessThan(100);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("shared provenance and administrative subprocess policy", () => {
  it("accepts only hidden-lock public-registry proof for global provenance", async () => {
    const globalRoot = await tempDir("global proof ");
    const npmRoot = path.join(globalRoot, "node_modules");
    const packageRoot = path.join(npmRoot, "picc");
    const manifest = { name: "picc", version: "1.2.3", _resolved: "https://registry.npmjs.org/picc/-/picc-1.2.3.tgz", _integrity: "forge" };
    await put(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
    expect(admin.classifyInstallation({ packageRoot, globalRoot: npmRoot })).toBe("unknown/other");
    const lockFile = path.join(globalRoot, "node_modules", ".package-lock.json");
    for (const [resolved, expected] of [
      ["https://registry.npmjs.org/picc/-/picc-1.2.3.tgz", "verified public-registry global npm"],
      ["file:picc.tgz", "unknown/other"], ["git+https://example.test/picc.git", "unknown/other"],
      ["npm:other@1.2.3", "unknown/other"], ["https://example.test/picc.tgz", "unknown/other"],
    ]) {
      await put(lockFile, JSON.stringify({ packages: { "node_modules/picc": { version: "1.2.3", resolved, integrity: "sha512-proof" } } }));
      expect(admin.classifyInstallation({ packageRoot, globalRoot: npmRoot })).toBe(expected);
    }
  });

  it.skipIf(!trustedGit)("uses Git ownership for real and linked worktrees, not a forgeable .git marker", async () => {
    const source = await tempDir("linked source ");
    await put(path.join(source, "package.json"), JSON.stringify({ name: "picc", version: "1.2.3" }));
    await exec(trustedGit!, ["init", "--quiet"], source);
    expect(admin.classifyInstallation({ packageRoot: source })).toBe("source");
    const host = await tempDir("link host ");
    const link = path.join(host, "node_modules", "picc");
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(source, link, process.platform === "win32" ? "junction" : "dir");
    expect(admin.classifyInstallation({ packageRoot: link })).toBe("source");

    const main = await tempDir("worktree main ");
    await put(path.join(main, "package.json"), JSON.stringify({ name: "picc", version: "1.2.3" }));
    await exec(trustedGit!, ["init", "--quiet"], main);
    await exec(trustedGit!, ["add", "package.json"], main);
    await exec(trustedGit!, ["-c", "user.name=PiCC", "-c", "user.email=picc@example.test", "commit", "--quiet", "-m", "fixture"], main);
    const linked = path.join(await tempDir("linked worktree parent "), "linked");
    expect((await exec(trustedGit!, ["worktree", "add", "--quiet", linked], main)).code).toBe(0);
    expect(admin.classifyInstallation({ packageRoot: linked })).toBe("source");
    await exec(trustedGit!, ["worktree", "remove", "--force", linked], main);
  });

  it.skipIf(process.platform !== "win32")("uses OS-backed Windows user and system paths despite a poisoned launch environment", async () => {
    const poison = "Z:\\attacker-controlled";
    const result = await callAdminWithEnv(`(async () => {
      const fs = await import("node:fs"); const os = await import("node:os");
      const env = admin.administrativeEnvironment();
      const npm = admin.discoverTrustedNpmCli();
      const prefix = await new Promise((resolve) => {
        if (!npm) return resolve(null);
        const child = admin.runTrustedNpm(["config", "get", "prefix"]); let out = "";
        child.stdout.on("data", chunk => out += chunk); child.on("close", code => resolve(code === 0 ? out.trim() : null));
      });
      const userHome = fs.realpathSync.native(os.userInfo().homedir).toLowerCase();
      const git = admin.discoverTrustedGit() ?? null;
      admin.cleanupAdministrativeEnvironment();
      return { env, prefix, userHome, git };
    })()`, {
      HOME: poison, USERPROFILE: poison, APPDATA: poison, LOCALAPPDATA: poison,
      TEMP: poison, TMP: poison, TMPDIR: poison, SystemRoot: poison, WINDIR: poison, PATH: poison,
    }) as { env: Record<string, string>; prefix: string | null; userHome: string; git: string | null };
    const expectedAppData = path.join(result.userHome, "AppData", "Roaming").toLowerCase();
    expect(result.env.APPDATA!.toLowerCase()).toBe(expectedAppData);
    expect(result.env.LOCALAPPDATA!.toLowerCase()).toBe(path.join(result.userHome, "AppData", "Local").toLowerCase());
    expect(result.env.TEMP!.toLowerCase()).toContain(path.join(result.userHome, "AppData", "Local", "Temp").toLowerCase());
    expect(result.env.SystemRoot?.toLowerCase()).toBe("c:\\windows");
    expect(result.env.WINDIR?.toLowerCase()).toBe("c:\\windows");
    expect(Object.values(result.env).join("\n")).not.toContain(poison);
    if (result.git) expect(result.git).not.toContain(poison);
    if (result.prefix) expect(result.prefix.toLowerCase()).toBe(path.join(expectedAppData, "npm").toLowerCase());
  });

  it("does not allocate an administrative environment when both npm config paths are explicit", async () => {
    const result = await callAdmin(`(() => {
      admin.cleanupAdministrativeEnvironment();
      const args = admin.fixedNpmPolicyArgs({ userConfig: "/explicit/user.npmrc", globalConfig: "/explicit/global.npmrc" });
      return { args, cleanupCreatedEnvironment: admin.cleanupAdministrativeEnvironment() };
    })()`) as { args: string[]; cleanupCreatedEnvironment: boolean };
    expect(result.args).toEqual(expect.arrayContaining([
      "--userconfig=/explicit/user.npmrc",
      "--globalconfig=/explicit/global.npmrc",
    ]));
    expect(result.cleanupCreatedEnvironment).toBe(false);
  });

  it("sanitizes child environment, restricts cwd, and removes its temporary administration tree", async () => {
    const cwd = await tempDir("admin cwd ");
    const result = await callAdmin(`new Promise((resolve) => {
      process.env.NODE_OPTIONS = "--inspect"; process.env.HTTPS_PROXY = "https://poison"; process.env.NODE_EXTRA_CA_CERTS = "poison";
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; process.env.COMSPEC = "poison"; process.env.PATHEXT = "poison"; process.env.TEMP = "poison"; process.env.PATH = "poison";
      const child = admin.runAdministrativeChild(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], { cwd: process.argv[1], trustedRoots: [process.argv[1]] });
      let out = ""; child.stdout.on("data", chunk => out += chunk); child.on("close", code => { const env = JSON.parse(out); resolve({ code, env, root: env.HOME.split(/[\\\\/]/).slice(0, -1).join("/") }); });
    })`, cwd) as { code: number; env: Record<string, string>; root: string };
    expect(result.code).toBe(0);
    for (const name of ["NODE_OPTIONS", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "COMSPEC", "PATHEXT"]) expect(result.env[name]).toBeUndefined();
    expect(result.env.TEMP).not.toBe("poison");
    expect(result.env.PATH).not.toBe("poison");
    expect(path.isAbsolute(result.env.HOME!)).toBe(true);
    expect(existsSync(result.root)).toBe(false);
    await expect(callAdmin("admin.runAdministrativeChild(process.execPath, [], { cwd: process.argv[1] })", cwd)).rejects.toThrow(/outside trusted roots/);
  });

  it("admits only a validated child-only npm authentication overlay", async () => {
    const cwd = await tempDir("authenticated admin cwd ");
    const result = await callAdmin(`new Promise((resolve) => {
      process.env.NODE_AUTH_TOKEN = "parent-poison"; process.env.NPM_TOKEN = "parent-npm-poison";
      const child = admin.runAdministrativeChild(process.execPath, ["-e", "console.log(JSON.stringify({ token: process.env.NODE_AUTH_TOKEN, npm: process.env.NPM_TOKEN, keys: Object.keys(process.env).sort() }))"], {
        cwd: process.argv[1], trustedRoots: [process.argv[1]], environmentOverlay: { NODE_AUTH_TOKEN: "child-token" },
      });
      let out = ""; child.stdout.on("data", chunk => out += chunk); child.on("close", code => resolve({ code, value: JSON.parse(out) }));
    })`, cwd) as { code: number; value: { token: string; npm?: string; keys: string[] } };
    expect(result).toMatchObject({ code: 0, value: { token: "child-token" } });
    expect(result.value.npm).toBeUndefined();
    expect(result.value.keys).toEqual(expect.arrayContaining(["HOME", "NODE_AUTH_TOKEN", "PATH", "npm_config_userconfig"]));
    expect(result.value.keys).not.toContain("NODE_OPTIONS");
    await expect(callAdmin("admin.runAdministrativeChild(process.execPath, [], { environmentOverlay: { NODE_AUTH_TOKEN: 'bad token' } })")).rejects.toThrow(/malformed/);
    await expect(callAdmin("admin.runAdministrativeChild(process.execPath, [], { environmentOverlay: { OTHER: 'token' } })")).rejects.toThrow(/not permitted/);
  });

  it("enforces a real deadline and stops a delayed descendant before resolving", async () => {
    const cwd = await tempDir("administrative tree deadline ");
    const ready = path.join(cwd, "descendant-ready");
    const canary = path.join(cwd, "descendant-canary");
    const descendant = `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "ready"); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(canary)}, "late"), 1500); setInterval(() => {}, 1000);`;
    const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
    const child = admin.runAdministrativeChild(process.execPath, ["-e", parent], { cwd, trustedRoots: [cwd] } as never);
    const collecting = admin.collectAdministrativeChild(child, { deadlineMs: 700 });
    await waitUntil({ predicate: () => existsSync(ready), description: "administrative descendant ready marker", timeoutMs: 5_000 });
    const result = await collecting;
    expect(result).toMatchObject({ ok: false, category: "deadline exceeded" });
    await new Promise<void>((resolve, reject) => {
      const ceiling = setTimeout(() => reject(new Error("descendant canary safety ceiling exceeded")), 5_000);
      setTimeout(() => { clearTimeout(ceiling); resolve(); }, 1_700);
    });
    expect(existsSync(canary)).toBe(false);
  });

  it("runs trusted npm and Git benign probes when available and refuses unavailable forms", async () => {
    const cwd = await tempDir("npm benign space ");
    const npmResult = await callAdmin(`new Promise((resolve) => {
      const npm = admin.discoverTrustedNpmCli(); if (!npm) return resolve({ unavailable: true });
      const child = admin.runTrustedNpm(["--version"], { cwd: process.argv[1], trustedRoots: [process.argv[1]] });
      let out = ""; child.stdout.on("data", chunk => out += chunk); child.on("close", code => resolve({ code, out: out.trim() }));
    })`, cwd) as { unavailable?: boolean; code?: number; out?: string };
    if (!npmResult.unavailable) {
      expect(npmResult.code).toBe(0);
      expect(npmResult.out).toMatch(/^\d+\.\d+\.\d+/);
    }
    if (trustedGit) {
      const gitResult = await callAdmin(`new Promise((resolve) => { const child = admin.runTrustedGit(["-C", process.argv[1], "rev-parse", "--show-toplevel"], { cwd: process.argv[1], trustedRoots: [process.argv[1]] }); let out = ""; child.stdout.on("data", c => out += c); child.on("close", code => resolve({ code, out: out.trim() })); })`, repoRoot) as { code: number; out: string };
      expect(gitResult).toMatchObject({ code: 0 });
      expect(path.isAbsolute(gitResult.out)).toBe(true);
    }
    await expect(callAdmin("admin.runAdministrativeChild('npm', [])")).rejects.toThrow(/absolute/);
  });
});

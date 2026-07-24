import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRecoveryNpmPolicy, recoveryNpmPolicyArgs, reinstallGuidance, requestLatestFromRegistry, runUpdate } from "../bin/picc-update.mjs";
import { discoverTrustedGit, discoverTrustedNpmCli } from "../bin/picc-admin.mjs";

const cleanup: string[] = [];
const git = discoverTrustedGit();
const npmCli = discoverTrustedNpmCli();

afterEach(async () => {
  cleanupRecoveryNpmPolicy();
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

async function temp(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), label));
  cleanup.push(root);
  return root;
}

async function put(filename: string, content: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, sink: { log: (value: string) => stdout.push(value), error: (value: string) => stderr.push(value) } };
}

function pendingChild() {
  const process = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => queueMicrotask(() => process.emit("close", null, "SIGTERM"));
  return process;
}

function child(code = 0) {
  const process = pendingChild();
  queueMicrotask(() => process.emit("close", code, null));
  return process;
}

async function globalFixture() {
  const prefix = await temp("picc update global ");
  const globalRoot = path.join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules");
  const packageRoot = path.join(globalRoot, "picc");
  await put(path.join(packageRoot, "package.json"), JSON.stringify({ name: "picc", version: "1.2.3" }));
  const classify = (options: { globalRoot?: string }) => options.globalRoot ? "verified public-registry global npm" : "unknown/other";
  const validateSuite = () => ({ ok: true, version: "0.81.1" });
  return { prefix, globalRoot, packageRoot, classify, validateSuite };
}

async function sourceFixture() {
  if (!git) throw new Error("trusted Git unavailable");
  const packageRoot = await temp("picc update source ");
  await put(path.join(packageRoot, "package.json"), JSON.stringify({ name: "picc", version: "1.2.3" }));
  await put(path.join(packageRoot, "package-lock.json"), JSON.stringify({ name: "picc", version: "1.2.3", lockfileVersion: 3, packages: { "": { name: "picc", version: "1.2.3" } } }));
  await put(path.join(packageRoot, ".gitignore"), "node_modules/\ncanary\n");
  await command(git, ["init", "--quiet"], packageRoot);
  await command(git, ["add", "."], packageRoot);
  await command(git, ["-c", "user.name=PiCC", "-c", "user.email=picc@example.test", "commit", "--quiet", "-m", "fixture"], packageRoot);
  return packageRoot;
}

function command(executable: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${executable} failed: ${stderr}`)); else resolve({ stdout, stderr });
    });
  });
}

function commandResult(executable: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
}

function registryGet(options: { status?: number; body?: string; error?: boolean; aborted?: boolean; prematureClose?: boolean }) {
  return ((url: string, requestOptions: unknown, callback: (response: EventEmitter & { statusCode: number; resume: () => void }) => void) => {
    expect(url).toBe("https://registry.npmjs.org/picc/latest");
    expect(requestOptions).toMatchObject({ rejectUnauthorized: true });
    expect(requestOptions).not.toHaveProperty("timeout");
    expect((requestOptions as { ca: readonly string[] }).ca.length).toBeGreaterThan(0);
    const request = new EventEmitter() as EventEmitter & { destroy: () => void };
    request.destroy = () => undefined;
    queueMicrotask(() => {
      if (options.error) return request.emit("error", new Error("offline"));
      const response = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
      response.statusCode = options.status ?? 200;
      response.resume = () => undefined;
      callback(response);
      if (response.statusCode !== 200) return;
      response.emit("data", Buffer.from(options.body ?? ""));
      if (options.aborted) response.emit("aborted");
      else if (options.prematureClose) response.emit("close");
      else response.emit("end");
    });
    return request;
  }) as never;
}

describe("bounded public registry metadata", () => {
  it("accepts only the fixed package and a stable exact version", async () => {
    await expect(requestLatestFromRegistry(registryGet({ body: JSON.stringify({ name: "picc", version: "2.3.4", extra: "ignored" }) }))).resolves.toBe("2.3.4");
    for (const body of [
      JSON.stringify({ name: "other", version: "2.3.4" }),
      JSON.stringify({ name: "picc", version: "2.3.4-beta.1" }),
      "not json",
    ]) await expect(requestLatestFromRegistry(registryGet({ body }))).rejects.toThrow();
  });

  it("rejects redirects, errors, premature settlement, and oversized bodies without rendering metadata", async () => {
    await expect(requestLatestFromRegistry(registryGet({ status: 302 }))).rejects.toThrow();
    await expect(requestLatestFromRegistry(registryGet({ error: true }))).rejects.toThrow();
    await expect(requestLatestFromRegistry(registryGet({ aborted: true, body: "{" }))).rejects.toThrow(/aborted/);
    await expect(requestLatestFromRegistry(registryGet({ prematureClose: true, body: "{" }))).rejects.toThrow(/prematurely/);
    await expect(requestLatestFromRegistry(registryGet({ body: "x".repeat(65 * 1024) }))).rejects.toThrow();
  });

  it("enforces one wall-clock deadline despite a slow drip and clears it on every settlement path", async () => {
    let deadline: (() => void) | undefined;
    let clears = 0;
    const request = new EventEmitter() as EventEmitter & { destroy: () => void };
    request.destroy = () => undefined;
    const get = ((_url: string, _options: unknown, callback: (response: EventEmitter & { statusCode: number; resume: () => void }) => void) => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
      response.statusCode = 200;
      response.resume = () => undefined;
      callback(response);
      response.emit("data", Buffer.from("{"));
      response.emit("data", Buffer.from("\"name\":\"picc\","));
      return request;
    }) as never;
    const pending = requestLatestFromRegistry(get, {
      setTimeout: (callback: () => void, milliseconds: number) => { expect(milliseconds).toBe(5_000); deadline = callback; return 17; },
      clearTimeout: (handle: number) => { expect(handle).toBe(17); clears++; },
    });
    deadline!();
    await expect(pending).rejects.toThrow(/deadline/);
    expect(clears).toBe(1);

    clears = 0;
    await expect(requestLatestFromRegistry(registryGet({ body: JSON.stringify({ name: "picc", version: "2.0.0" }) }), {
      setTimeout: () => 18,
      clearTimeout: () => { clears++; },
    })).resolves.toBe("2.0.0");
    expect(clears).toBe(1);
  });
});

describe("verified global PiCC updates", () => {
  it.each([
    ["1.2.4", "available"], ["1.2.3", "up to date"], ["1.2.2", "up to date"],
  ])("reports the conclusive check outcome for registry version %s", async (latest, phrase) => {
    const fixture = await globalFixture();
    const seen: string[][] = [];
    const capture = output();
    const code = await runUpdate({ action: "check", ...fixture, requestLatest: async () => latest, runNpm: (args: string[]) => { seen.push(args); return child(); }, output: capture.sink });
    expect(code).toBe(0);
    expect(capture.stdout.join("\n")).toContain("PiCC 1.2.3\nEmbedded Pi 0.81.1\nInstall verified public-registry global npm");
    expect(capture.stdout.join("\n")).toContain(phrase);
    expect(seen).toHaveLength(0);
  });

  it("does not invoke npm for equal or older plain updates", async () => {
    for (const latest of ["1.2.3", "1.2.2"]) {
      const fixture = await globalFixture();
      let calls = 0;
      const capture = output();
      expect(await runUpdate({ action: "update", ...fixture, requestLatest: async () => latest, runNpm: () => { calls++; return child(); }, output: capture.sink })).toBe(0);
      expect(calls).toBe(0);
      expect(capture.stdout.join("\n")).toContain("up to date");
    }
  });

  it("never reports an incoherent global suite as successfully up to date", async () => {
    for (const action of ["check", "update"] as const) {
      const fixture = await globalFixture();
      let calls = 0;
      const capture = output();
      expect(await runUpdate({ action, ...fixture, requestLatest: async () => "1.2.3", validateSuite: () => ({ ok: false, reason: "mixed" }), runNpm: () => { calls++; return child(); }, output: capture.sink })).toBe(1);
      expect(calls).toBe(0);
      expect(capture.stdout.join("\n")).not.toContain("up to date");
      expect(capture.stderr.join("\n")).toContain("recovery command");
    }
  });

  it("runs one exact hardened global install at the verified prefix and revalidates", async () => {
    const fixture = await globalFixture();
    const calls: Array<{ args: string[]; options: unknown }> = [];
    let validations = 0;
    const capture = output();
    const code = await runUpdate({
      action: "update", ...fixture, requestLatest: async () => "1.2.4", output: capture.sink,
      validateSuite: () => ({ ok: true, version: validations++ === 0 ? "0.81.1" : "0.82.0" }),
      runNpm: (args: string[], options: unknown) => {
        calls.push({ args, options });
        writeFileSync(path.join(fixture.packageRoot, "package.json"), JSON.stringify({ name: "picc", version: "1.2.4" }));
        return child();
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toBeUndefined();
    const expectedPrefix = process.platform === "win32" ? fixture.prefix.toLowerCase() : fixture.prefix;
    expect(calls[0]!.args.slice(0, 4)).toEqual(["install", "--global", "picc@1.2.4", `--prefix=${expectedPrefix}`]);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--ignore-scripts", "--audit=false", "--fund=false", "--registry=https://registry.npmjs.org/", "--strict-ssl=true", "--cafile=null"]));
    expect(capture.stdout.at(-1)).toContain("updated the complete PiCC product to 1.2.4");
  });

  it("fails closed on registry, bounded npm, suite, and provenance failures with fixed recovery", async () => {
    const fixture = await globalFixture();
    const failedCheck = output();
    expect(await runUpdate({ action: "check", ...fixture, requestLatest: async () => { throw new Error("secret metadata"); }, output: failedCheck.sink })).toBe(1);
    expect(failedCheck.stderr.join("\n")).not.toContain("secret");

    for (const [makeChild, category] of [
      [() => child(1), "nonzero exit"],
      [() => { const value = pendingChild(); queueMicrotask(() => value.emit("error", new Error("secret path"))); return value; }, "spawn error"],
      [() => { const value = pendingChild(); queueMicrotask(() => value.stdout.write(Buffer.alloc(300 * 1024))); return value; }, "output overflow"],
      [() => { const value = pendingChild(); queueMicrotask(() => value.emit("close", null, "SIGTERM")); return value; }, "termination signal"],
    ] as const) {
      const capture = output();
      expect(await runUpdate({ action: "update", ...fixture, requestLatest: async () => "1.2.4", runNpm: makeChild, output: capture.sink })).toBe(1);
      expect(capture.stderr.join("\n")).toContain(category);
      expect(capture.stderr.join("\n")).not.toContain("secret path");
      expect(capture.stderr.join("\n")).toContain("recovery command");
    }

    for (const kind of ["suite", "provenance"] as const) {
      writeFileSync(path.join(fixture.packageRoot, "package.json"), JSON.stringify({ name: "picc", version: "1.2.4" }));
      let classifications = 0;
      const capture = output();
      expect(await runUpdate({
        action: "update", ...fixture, requestLatest: async () => "1.2.5", output: capture.sink,
        runNpm: () => { writeFileSync(path.join(fixture.packageRoot, "package.json"), JSON.stringify({ name: "picc", version: "1.2.5" })); return child(); },
        validateSuite: () => kind === "suite" ? ({ ok: false, reason: "secret" }) : ({ ok: true, version: "0.82.0" }),
        classify: (options: { globalRoot?: string }) => options.globalRoot && (kind !== "provenance" || classifications++ === 0) ? "verified public-registry global npm" : "unknown/other",
      })).toBe(1);
      expect(capture.stderr.join("\n")).toContain(kind === "suite" ? "embedded Pi suite" : "provenance");
      expect(capture.stderr.join("\n")).not.toContain("secret");
    }
  });

  it("renders platform-labelled recovery commands with shell-safe quoting and fixed policy", () => {
    const hostile = "/prefix with spaces/$cash/`tick`/'quote';$(touch nope)";
    const posixPolicy = ["--ignore-scripts", "--cafile=null", "--userconfig=/tmp/user.npmrc", "--globalconfig=/tmp/global.npmrc"];
    const posix = reinstallGuidance("1.2.4", hostile, "linux", posixPolicy);
    expect(posix).toContain("POSIX shell recovery command:");
    expect(posix).toContain(`'--prefix=/prefix with spaces/$cash/\`tick\`/'\"'\"'quote'\"'\"';$(touch nope)'`);
    expect(posix).toContain("'--cafile=null'");
    expect(posix).toContain("'--userconfig=/tmp/user.npmrc'");
    expect(posix).toContain("'--globalconfig=/tmp/global.npmrc'");
    const powershell = reinstallGuidance("1.2.4", hostile, "win32", ["--userconfig=C:\\user.npmrc", "--globalconfig=C:\\global.npmrc"]);
    expect(powershell).toContain("PowerShell recovery command:");
    expect(powershell).toContain("''quote''");
    expect(powershell).toContain("'--userconfig=");
    expect(powershell).toContain("'--globalconfig=");
    expect(() => reinstallGuidance("1.2.4", "bad\npath", "linux", posixPolicy)).toThrow(/unsafe/);
  });

  it.each(["known local package", "unknown/other"])("never mutates %s ownership", async (origin) => {
    const root = await temp("picc local ");
    await put(path.join(root, "package.json"), JSON.stringify({ name: "picc", version: "1.2.3" }));
    let invoked = false;
    const capture = output();
    const code = await runUpdate({ packageRoot: root, globalRoot: null, classify: () => origin, validateSuite: () => ({ ok: true, version: "0.81.1" }), runNpm: () => { invoked = true; return child(); }, output: capture.sink });
    expect(code).toBe(1);
    expect(invoked).toBe(false);
    expect(capture.stderr.join("\n")).toContain(origin === "known local package" ? "npm install picc@1.2.3" : "ownership could not be identified");
  });
});

describe.skipIf(!git)("source checkout synchronization", () => {
  it("checks clean coherent state, including detached HEAD, without npm mutation", async () => {
    const root = await sourceFixture();
    let npmCalls = 0;
    const capture = output();
    expect(await runUpdate({ action: "check", packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: true, version: "0.81.1" }), runNpm: () => { npmCalls++; return child(); }, output: capture.sink })).toBe(0);
    expect(npmCalls).toBe(0);
    await command(git!, ["checkout", "--quiet", "--detach"], root);
    const detached = output();
    expect(await runUpdate({ action: "check", packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: true, version: "0.81.1" }), output: detached.sink })).toBe(0);
    expect(detached.stdout.join("\n")).toContain("detached HEAD; check only");
    expect(await runUpdate({ action: "update", packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: true, version: "0.81.1" }), output: output().sink })).toBe(1);
  });

  it.each(["staged", "unstaged", "untracked"])("refuses %s state before invoking npm", async (kind) => {
    const root = await sourceFixture();
    if (kind === "untracked") await put(path.join(root, "untracked.txt"), "x");
    else {
      await writeFile(path.join(root, "package.json"), `${await readFile(path.join(root, "package.json"), "utf8")}\n`);
      if (kind === "staged") await command(git!, ["add", "package.json"], root);
    }
    let called = false;
    const capture = output();
    expect(await runUpdate({ packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: true, version: "0.81.1" }), runNpm: () => { called = true; return child(); }, output: capture.sink })).toBe(1);
    expect(called).toBe(false);
    expect(capture.stderr.join("\n")).toContain("staged, unstaged, unmerged, or untracked");
  });

  it.each(["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"])("refuses in-progress Git marker %s", async (marker) => {
    const root = await sourceFixture();
    const gitDir = (await command(git!, ["rev-parse", "--absolute-git-dir"], root)).stdout.trim();
    await put(path.join(gitDir, marker), "operation\n");
    const capture = output();
    expect(await runUpdate({ packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: false, reason: "malformed lock" }), output: capture.sink })).toBe(1);
    expect(capture.stderr.join("\n")).toContain("in progress");
  });

  it("reports incoherent clean checks actionably", async () => {
    const root = await sourceFixture();
    const check = output();
    expect(await runUpdate({ action: "check", packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: false, reason: "secret malformed lock" }), output: check.sink })).toBe(1);
    expect(check.stderr.join("\n")).toContain("Run `picc update`");
    expect(check.stderr.join("\n")).not.toContain("secret");
  });

  it("refuses a real unmerged conflict and accepts a clean linked worktree check", async () => {
    const root = await sourceFixture();
    await put(path.join(root, "conflict.txt"), "base\n");
    await command(git!, ["add", "conflict.txt"], root);
    await command(git!, ["-c", "user.name=PiCC", "-c", "user.email=picc@example.test", "commit", "--quiet", "-m", "base conflict"], root);
    const original = (await command(git!, ["branch", "--show-current"], root)).stdout.trim();
    await command(git!, ["checkout", "--quiet", "-b", "conflict-side"], root);
    await put(path.join(root, "conflict.txt"), "side\n");
    await command(git!, ["add", "conflict.txt"], root);
    await command(git!, ["-c", "user.name=PiCC", "-c", "user.email=picc@example.test", "commit", "--quiet", "-m", "side"], root);
    await command(git!, ["checkout", "--quiet", original], root);
    await put(path.join(root, "conflict.txt"), "main\n");
    await command(git!, ["add", "conflict.txt"], root);
    await command(git!, ["-c", "user.name=PiCC", "-c", "user.email=picc@example.test", "commit", "--quiet", "-m", "main"], root);
    expect((await commandResult(git!, ["merge", "conflict-side"], root)).code).not.toBe(0);
    const conflicted = output();
    expect(await runUpdate({ packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: true, version: "0.81.1" }), output: conflicted.sink })).toBe(1);
    expect(conflicted.stderr.join("\n")).toContain("unmerged");
    await command(git!, ["merge", "--abort"], root);

    const linkedParent = await temp("picc linked worktree ");
    const linked = path.join(linkedParent, "checkout");
    await command(git!, ["worktree", "add", "--quiet", linked, "conflict-side"], root);
    const checked = output();
    expect(await runUpdate({ action: "check", packageRoot: linked, globalRoot: null, validateSuite: () => ({ ok: true, version: "0.81.1" }), output: checked.sink })).toBe(0);
    expect(checked.stdout.join("\n")).toContain("source manifest, lockfile, and installed dependencies are coherent");
    await command(git!, ["worktree", "remove", "--force", linked], root);
  });

  it("refuses a project .npmrc before npm can consume hostile registry or CA policy", async () => {
    const root = await sourceFixture();
    await put(path.join(root, ".npmrc"), "registry=https://attacker.invalid/\ncafile=secret-ca.pem\nstrict-ssl=false\n");
    await command(git!, ["add", ".npmrc"], root);
    await command(git!, ["-c", "user.name=PiCC", "-c", "user.email=picc@example.test", "commit", "--quiet", "-m", "hostile policy"], root);
    let called = false;
    const capture = output();
    expect(await runUpdate({ packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: false, reason: "stale" }), runNpm: () => { called = true; return child(); }, output: capture.sink })).toBe(1);
    expect(called).toBe(false);
    expect(capture.stderr.join("\n")).toContain("project .npmrc");
    expect(capture.stderr.join("\n")).not.toContain("attacker.invalid");
  });

  it("uses no optional locks and one verified empty administrative hooks directory for every Git probe", async () => {
    const root = await sourceFixture();
    const seen: string[][] = [];
    const capture = output();
    const runGit = (args: string[], options: unknown) => {
      seen.push(args);
      return execFile(git!, args, options as never);
    };
    expect(await runUpdate({ action: "check", packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: true, version: "0.81.1" }), runGit, output: capture.sink })).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    const hooksPaths = new Set<string>();
    for (const args of seen) {
      expect(args[0]).toBe("--no-optional-locks");
      expect(args).toEqual(expect.arrayContaining(["core.fsmonitor=false", "filter.lfs.clean=", "filter.lfs.process="]));
      const setting = args.find((value) => value.startsWith("core.hooksPath="));
      expect(setting).toBeDefined();
      expect(setting).not.toBe("core.hooksPath=");
      hooksPaths.add(setting!.slice("core.hooksPath=".length));
    }
    expect(hooksPaths.size).toBe(1);
    expect(await readdir([...hooksPaths][0]!)).toEqual([]);
    const configIndex = seen.findIndex((args) => args.includes("--get-regexp"));
    const statusIndex = seen.findIndex((args) => args.includes("status"));
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThan(configIndex);
  });

  it.skipIf(process.platform === "win32")("disables a repository-configured fsmonitor executable for every Git probe", async () => {
    const root = await sourceFixture();
    const canary = path.join(root, "canary");
    const helper = path.join(root, "fsmonitor-helper.sh");
    await put(helper, `#!/bin/sh\nprintf executed > ${JSON.stringify(canary)}\n`);
    await chmod(helper, 0o755);
    await command(git!, ["add", "-f", "fsmonitor-helper.sh"], root);
    await command(git!, ["-c", "user.name=PiCC", "-c", "user.email=picc@example.test", "commit", "--quiet", "-m", "helper"], root);
    await command(git!, ["config", "core.fsmonitor", helper], root);
    const seen: string[][] = [];
    const capture = output();
    expect(await runUpdate({ action: "check", packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: true, version: "0.81.1" }), runGit: (args: string[], options: unknown) => { seen.push(args); const spawned = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void }; spawned.stdout = new PassThrough(); spawned.stderr = new PassThrough(); spawned.kill = () => undefined; const real = execFile(git!, args, options as never); real.stdout?.pipe(spawned.stdout); real.stderr?.pipe(spawned.stderr); real.on("error", (error) => spawned.emit("error", error)); real.on("close", (code, signal) => spawned.emit("close", code, signal)); return spawned; }, output: capture.sink })).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const args of seen) {
      expect(args.slice(0, 4)).toEqual(["--no-optional-locks", "-c", "core.fsmonitor=false", "-c"]);
      expect(args[4]).toMatch(/^core\.hooksPath=.+empty-git-hooks$/);
      expect(args[4]).not.toBe("core.hooksPath=");
    }
    expect(existsSync(canary)).toBe(false);
  });

  it.each([["canary", "clean"], ["canary", "process"], ["lfs", "clean"]])("refuses an effective filter command for %s.%s before status can execute it", async (filterName, kind) => {
    const root = await sourceFixture();
    const canary = path.join(root, "canary");
    const helper = path.join(root, "filter-helper.sh");
    await put(helper, `#!/bin/sh\nprintf executed > ${JSON.stringify(canary)}\nexit 1\n`);
    await chmod(helper, 0o755);
    await put(path.join(root, ".gitattributes"), `package.json filter=${filterName}\n`);
    await command(git!, ["add", "-f", "filter-helper.sh", ".gitattributes"], root);
    await command(git!, ["-c", "user.name=PiCC", "-c", "user.email=picc@example.test", "commit", "--quiet", "-m", "filter fixture"], root);
    await command(git!, ["config", `filter.${filterName}.${kind}`, helper], root);
    const capture = output();
    expect(await runUpdate({ action: "check", packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: true, version: "0.81.1" }), output: capture.sink })).toBe(1);
    expect(capture.stderr.join("\n")).toContain("executable clean or process filter");
    expect(capture.stderr.join("\n")).not.toContain(root);
    expect(existsSync(canary)).toBe(false);
  });

  it("preflights, rebuilds with scripts disabled, and revalidates without tracked/config changes", async () => {
    const root = await sourceFixture();
    const beforeHead = (await command(git!, ["show", "HEAD:package-lock.json"], root)).stdout;
    const beforeConfig = await readFile(path.join(root, ".git", "config"), "utf8");
    const calls: string[][] = [];
    let validations = 0;
    const capture = output();
    const code = await runUpdate({
      packageRoot: root, globalRoot: null, output: capture.sink,
      validateSuite: () => ({ ok: true, version: validations++ === 0 ? "0.80.0" : "0.81.1" }),
      runNpm: (args: string[]) => { calls.push(args); return child(); },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(expect.arrayContaining(["ci", "--dry-run", "--ignore-scripts"]));
    expect(calls[1]).toEqual(expect.arrayContaining(["ci", "--ignore-scripts", "--audit=false", "--fund=false", "--registry=https://registry.npmjs.org/", "--cafile=null"]));
    expect((await command(git!, ["status", "--porcelain=v2", "--untracked-files=all"], root)).stdout).toBe("");
    expect((await command(git!, ["show", "HEAD:package-lock.json"], root)).stdout).toBe(beforeHead);
    expect(await readFile(path.join(root, ".git", "config"), "utf8")).toBe(beforeConfig);
  });

  it("distinguishes preflight refusal from partial ignored-state failure with safe actionable diagnostics", async () => {
    for (const failAt of [0, 1]) {
      const root = await sourceFixture();
      let call = 0;
      const capture = output();
      const runNpm = () => {
        const value = pendingChild();
        const current = call++;
        queueMicrotask(() => {
          if (current === failAt) {
            value.stderr.write("npm error co");
            value.stderr.write("de ELOCKVERIFY\nsecret=/private/token\n");
          }
          value.emit("close", current === failAt ? 1 : 0, null);
        });
        return value;
      };
      expect(await runUpdate({ packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: false, reason: "stale" }), runNpm, output: capture.sink })).toBe(1);
      const rendered = capture.stderr.join("\n");
      expect(rendered.toLowerCase()).toContain(failAt === 0 ? "no dependency rebuild was started" : "ignored dependency state may have changed");
      expect(rendered).toContain("npm ELOCKVERIFY");
      expect(rendered).toContain(failAt === 0 ? "`picc update`" : "`picc update --check`");
      expect(rendered).toContain("npm 'ci'");
      expect(rendered).not.toContain("secret");
      expect(rendered).not.toContain(root);
      expect(rendered).toContain("--globalconfig");
    }
  });

  it.each(["state", "suite"])("reports source post-%s revalidation failure without raw detail", async (kind) => {
    const root = await sourceFixture();
    let validations = 0;
    let gitCalls = 0;
    const capture = output();
    const realRunGit = (args: string[], options: unknown) => {
      gitCalls++;
      if (kind === "state" && gitCalls > 7) throw new Error(`secret ${root}`);
      const spawned = execFile(git!, args, options as never);
      return spawned;
    };
    expect(await runUpdate({
      packageRoot: root, globalRoot: null, output: capture.sink,
      validateSuite: () => validations++ === 0 || kind !== "suite" ? ({ ok: true, version: "0.81.1" }) : ({ ok: false, reason: `secret ${root}` }),
      runGit: realRunGit,
      runNpm: () => child(),
    })).toBe(1);
    const rendered = capture.stderr.join("\n");
    expect(rendered).toContain(kind === "state" ? "source state revalidation" : "installed Pi suite");
    expect(rendered).toContain("`picc update --check`");
    if (kind === "state") {
      expect(rendered).toContain("Inspect and correct the checkout state");
      expect(rendered).not.toContain("npm 'ci'");
    } else {
      expect(rendered).toContain("npm 'ci'");
    }
    expect(rendered).not.toContain(root);
  });
});

describe("real launcher and updater boundary", () => {
  it("routes administration through the real updater offline and never starts a fake Pi", async () => {
    const parent = await temp("picc real route ");
    const root = path.join(parent, "node_modules", "picc");
    await put(path.join(parent, "package.json"), JSON.stringify({ name: "owner" }));
    await put(path.join(root, "bin", "picc.mjs"), await readFile(path.resolve("bin/picc.mjs"), "utf8"));
    await put(path.join(root, "bin", "picc-admin.mjs"), await readFile(path.resolve("bin/picc-admin.mjs"), "utf8"));
    await put(path.join(root, "bin", "picc-update.mjs"), await readFile(path.resolve("bin/picc-update.mjs"), "utf8"));
    const names = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];
    await put(path.join(root, "package.json"), JSON.stringify({ name: "picc", version: "1.2.3", type: "module", dependencies: Object.fromEntries(names.map((name) => [name, "0.81.1"])) }));
    for (const name of names) await put(path.join(root, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version: "0.81.1" }));
    const canary = path.join(parent, "pi-started");
    await put(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(canary)}, "started");`);
    await put(path.join(root, "picc", "index.ts"), "export default () => {};\n");
    const result = await commandResult(process.execPath, [path.join(root, "bin", "picc.mjs"), "update", "--check"], parent);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("owning project");
    expect(existsSync(canary)).toBe(false);
  });
});

describe.skipIf(!git || !npmCli)("real trusted npm source boundary", () => {
  it("uses distinct empty recovery configs and ignores hostile ambient global configuration", async () => {
    const root = await temp("picc recovery npm config ");
    const hostile = path.join(root, "hostile-global.npmrc");
    await writeFile(hostile, "registry=https://attacker.invalid/\n@earendil-works:registry=https://attacker.invalid/\n");
    const policy = recoveryNpmPolicyArgs();
    const userConfig = policy.find((value) => value.startsWith("--userconfig="))!.slice("--userconfig=".length);
    const globalConfig = policy.find((value) => value.startsWith("--globalconfig="))!.slice("--globalconfig=".length);
    expect(userConfig).not.toBe(globalConfig);
    expect(existsSync(userConfig)).toBe(true);
    expect(existsSync(globalConfig)).toBe(true);
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [npmCli!, "config", "get", "registry", ...policy], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, npm_config_globalconfig: hostile },
      }, (error, stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr }));
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("https://registry.npmjs.org/");
    expect(result.stderr).not.toMatch(/same file|userconfig.*globalconfig/i);
  });

  it("runs network-free npm ci through the updater without lifecycle scripts", async () => {
    const root = await temp("picc real npm ");
    await put(path.join(root, "dependency", "package.json"), JSON.stringify({ name: "picc-canary-dependency", version: "1.0.0", scripts: { install: "node -e \"require('fs').writeFileSync('../../canary','ran')\"" } }));
    await put(path.join(root, "package.json"), JSON.stringify({ name: "picc", version: "1.2.3", dependencies: { "picc-canary-dependency": "file:dependency" } }));
    await put(path.join(root, ".gitignore"), "node_modules/\ncanary\n");
    await command(process.execPath, [npmCli!, "install", "--package-lock-only", "--ignore-scripts", "--audit=false", "--fund=false"], root);
    await command(git!, ["init", "--quiet"], root);
    await command(git!, ["add", "."], root);
    await command(git!, ["-c", "user.name=PiCC", "-c", "user.email=picc@example.test", "commit", "--quiet", "-m", "fixture"], root);
    const capture = output();
    expect(await runUpdate({ packageRoot: root, globalRoot: null, validateSuite: () => ({ ok: true, version: "0.81.1" }), output: capture.sink })).toBe(0);
    expect(existsSync(path.join(root, "node_modules", "picc-canary-dependency", "package.json"))).toBe(true);
    expect(existsSync(path.join(root, "canary"))).toBe(false);
    expect((await command(git!, ["status", "--porcelain=v2", "--untracked-files=all"], root)).stdout).toBe("");
  }, 20_000);
});

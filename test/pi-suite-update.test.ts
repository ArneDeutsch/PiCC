import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PI_SUITE_PACKAGES, VALIDATION_MODES, discoverTrustedGit, discoverTrustedNpmCli, runTrustedNpm, validatePiSuite } from "../bin/picc-admin.mjs";
import { ignoredStateRecoveryCommand, runPiSuiteRecovery, runPiSuiteUpdate } from "../scripts/update-pi-suite.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "update-pi-suite.mjs");
const TRACKED_TEST_NAMES = ["package.json", "package-lock.json"] as const;
const cleanup: string[] = [];

function pendingChild() {
  const process = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): void };
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => queueMicrotask(() => process.emit("close", null, "SIGKILL"));
  return process;
}

function child(result: { code?: number; stdout?: string; stderr?: string } = {}) {
  const process = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): void };
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = () => process.emit("close", null, "SIGTERM");
  queueMicrotask(() => {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.stdout.end();
    process.stderr.end();
    process.emit("close", result.code ?? 0, null);
  });
  return process;
}

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, sink: { log: (value: string) => stdout.push(value), error: (value: string) => stderr.push(value) } };
}

async function put(filename: string, value: string | Buffer) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, value);
}

async function fixture(version = "0.81.1") {
  const root = await mkdtemp(path.join(os.tmpdir(), "picc suite update "));
  cleanup.push(root);
  const dependencies = Object.fromEntries(PI_SUITE_PACKAGES.map((name) => [name, version]));
  const manifest = { name: "picc", version: "0.1.0", type: "module", dependencies };
  const packages: Record<string, unknown> = { "": { name: "picc", version: "0.1.0", dependencies } };
  for (const name of PI_SUITE_PACKAGES) {
    packages[`node_modules/${name}`] = { name, version };
    await put(path.join(root, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version }));
  }
  await put(path.join(root, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  await put(path.join(root, "package-lock.json"), JSON.stringify({ name: "picc", version: "0.1.0", lockfileVersion: 3, packages }, null, 2) + "\n");
  const git = discoverTrustedGit();
  if (!git) throw new Error("trusted Git required for update fixtures");
  await new Promise<void>((resolve, reject) => execFile(git, ["init", "--quiet"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => execFile(git, ["add", "package.json", "package-lock.json"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => execFile(git, ["-c", "user.name=PiCC", "-c", "user.email=picc@example.test", "commit", "--quiet", "-m", "fixture"], { cwd: root }, (error) => error ? reject(error) : resolve()));
  return root;
}

function exactArtifacts(version: string) {
  return PI_SUITE_PACKAGES.map((name) => `${name}@${version}`);
}

function assertFixedPolicy(args: string[], offset: number) {
  const policy = args.slice(offset);
  expect(policy).toHaveLength(14);
  expect(policy.slice(0, 4)).toEqual(["--ignore-scripts", "--audit=false", "--fund=false", "--registry=https://registry.npmjs.org/"]);
  expect(policy[4]).toMatch(/^--userconfig=.+npmrc$/);
  expect(policy[5]).toMatch(/^--globalconfig=.+global-npmrc$/);
  expect(policy[4]).not.toBe(policy[5]);
  expect(policy.slice(6)).toEqual(["--proxy=null", "--https-proxy=null", "--noproxy=*", "--strict-ssl=true", "--cafile=null", "--ca=null", "--cert=null", "--key=null"]);
}

function fakeSuccess(version: string, calls: string[][], mutate?: () => void) {
  return (args: string[]) => {
    calls.push(args);
    if (args[0] === "view") return child({ stdout: JSON.stringify(version) });
    if (args[0] === "install") mutate?.();
    return child();
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("coordinated Pi-suite update", () => {
  it.each([
    [], ["0.01.0"], [" 0.82.0"], ["0.82.0 "], ["0.82.0-beta.1"], ["0.82.0+build"],
    ["^0.82.0"], ["latest"], ["0.82"], ["0.82.0", "extra"],
  ] as string[][])("rejects invalid or extra argv before resolving a checkout: %j", async (argv) => {
    const capture = output();
    expect(await runPiSuiteUpdate({ argv, packageRoot: path.join(os.tmpdir(), "does-not-exist"), output: capture.sink })).toBe(1);
    expect(capture.stderr.join("\n")).toContain("one stable exact version");
  });

  it.each(["0.81.1", "0.80.99"])("rejects equal/older targets before npm: %s", async (target) => {
    const root = await fixture();
    let npmCalls = 0;
    expect(await runPiSuiteUpdate({
      argv: [target], packageRoot: root, runNpm: () => { npmCalls += 1; return child(); },
      validateSuite: () => ({ ok: true, version: "0.81.1" }), output: output().sink,
    })).toBe(1);
    expect(npmCalls).toBe(0);
  });

  it("reports initial graph failure as a safe maintainer preflight action", async () => {
    const root = await fixture();
    const capture = output();
    let npmCalls = 0;
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: capture.sink,
      runNpm: () => { npmCalls++; return child(); },
      validateSuite: () => { throw new Error(`secret graph detail ${root}`); },
    })).toBe(1);
    expect(npmCalls).toBe(0);
    expect(capture.stderr.join("\n")).toContain("Restore or synchronize the reviewed checkout");
    expect(capture.stderr.join("\n")).not.toContain(root);
    expect(capture.stderr.join("\n")).not.toContain("secret");
  });

  it("uses decimal semantic ordering for 0.10.0", async () => {
    const root = await fixture("0.9.99");
    const calls: string[][] = [];
    let validations = 0;
    expect(await runPiSuiteUpdate({
      argv: ["0.10.0"], packageRoot: root, runNpm: fakeSuccess("0.10.0", calls),
      validateSuite: () => ({ ok: true, version: validations++ === 0 ? "0.9.99" : "0.10.0" }), output: output().sink,
    })).toBe(0);
    expect(calls.filter((args) => args[0] === "install")).toHaveLength(1);
  });

  it("preflights every artifact in shared suite order, then performs one exact disabled-script save", async () => {
    const root = await fixture();
    const calls: Array<{ args: string[]; options: unknown }> = [];
    let validations = 0;
    const capture = output();
    const code = await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: capture.sink,
      validateSuite: (options: { mode?: string }) => {
        expect(options.mode).toBe(validations === 0 ? undefined : VALIDATION_MODES.STRICT_EXACT);
        return { ok: true, version: validations++ === 0 ? "0.81.1" : "0.82.0" };
      },
      runNpm: (args: string[], options: unknown) => { calls.push({ args, options }); return args[0] === "view" ? child({ stdout: '"0.82.0"\n' }) : child(); },
    });
    expect(code).toBe(0);
    expect(calls.slice(0, -1).map(({ args }) => args.slice(0, 4))).toEqual(exactArtifacts("0.82.0").map((artifact) => ["view", artifact, "version", "--json"]));
    for (const call of calls.slice(0, -1)) assertFixedPolicy(call.args, 4);
    const install = calls.at(-1)!;
    expect(install.args.slice(0, 6)).toEqual(["install", ...exactArtifacts("0.82.0"), "--save-exact"]);
    assertFixedPolicy(install.args, 6);
    const expectedRoot = process.platform === "win32" ? fs.realpathSync.native(root).toLowerCase() : fs.realpathSync.native(root);
    for (const call of calls) expect(call.options).toEqual({ cwd: expectedRoot, trustedRoots: [expectedRoot] });
    expect(capture.stdout.join("\n")).toContain("updated the complete direct Pi suite to 0.82.0");
  });

  it("stops all mutation when any exact artifact is absent or returns mixed metadata", async () => {
    for (const failAt of PI_SUITE_PACKAGES.keys()) {
      const root = await fixture();
      const calls: string[][] = [];
      const capture = output();
      const code = await runPiSuiteUpdate({
        argv: ["0.82.0"], packageRoot: root, output: capture.sink,
        validateSuite: () => ({ ok: true, version: "0.81.1" }),
        runNpm: (args: string[]) => {
          calls.push(args);
          return child({ stdout: calls.length - 1 === failAt ? '"0.81.9"' : '"0.82.0"' });
        },
      });
      expect(code).toBe(1);
      expect(calls).toHaveLength(failAt + 1);
      expect(calls.every((args) => args[0] === "view")).toBe(true);
      expect(capture.stderr.join("\n")).not.toContain(root);
    }
  });

  it("restores tracked bytes and ignored state after npm failure, and supports retry", async () => {
    const root = await fixture();
    const manifestFile = path.join(root, "package.json");
    const lockFile = path.join(root, "package-lock.json");
    const originalManifest = await readFile(manifestFile);
    const originalLock = await readFile(lockFile);
    let failInstall = true;
    let validations = 0;
    const calls: string[][] = [];
    const runNpm = (args: string[]) => {
      calls.push(args);
      if (args[0] === "view") return child({ stdout: '"0.82.0"' });
      if (args[0] === "install" && failInstall) {
        fs.writeFileSync(manifestFile, "mutated manifest");
        fs.writeFileSync(lockFile, "mutated lock");
        return child({ code: 1, stderr: "secret npm failure" });
      }
      return child();
    };
    const capture = output();
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, runNpm, output: capture.sink,
      validateSuite: () => ({ ok: true, version: validations++ === 0 ? "0.81.1" : "0.81.1" }),
    })).toBe(1);
    expect(await readFile(manifestFile)).toEqual(originalManifest);
    expect(await readFile(lockFile)).toEqual(originalLock);
    expect(calls.at(-1)?.[0]).toBe("ci");
    expect(capture.stderr.join("\n")).toContain("ignored dependency state were restored");
    expect(capture.stderr.join("\n")).not.toContain("secret");

    failInstall = false;
    validations = 0;
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, runNpm, output: output().sink,
      validateSuite: () => ({ ok: true, version: validations++ === 0 ? "0.81.1" : "0.82.0" }),
    })).toBe(0);
  });

  it("reports an exact safe recovery command when ignored restoration fails", async () => {
    const root = await fixture();
    const originalManifest = await readFile(path.join(root, "package.json"));
    const originalLock = await readFile(path.join(root, "package-lock.json"));
    const capture = output();
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: capture.sink,
      validateSuite: () => ({ ok: true, version: "0.81.1" }),
      runNpm: (args: string[]) => {
        if (args[0] === "view") return child({ stdout: '"0.82.0"' });
        if (args[0] === "install") {
          fs.writeFileSync(path.join(root, "package.json"), "partial");
          fs.writeFileSync(path.join(root, "package-lock.json"), "partial");
        }
        return child({ code: 1, stderr: "private failure details" });
      },
    })).toBe(1);
    expect(await readFile(path.join(root, "package.json"))).toEqual(originalManifest);
    expect(await readFile(path.join(root, "package-lock.json"))).toEqual(originalLock);
    const diagnostic = capture.stderr.join("\n");
    expect(diagnostic).toContain("could not be restored deterministically");
    expect(diagnostic).toContain("recovery command");
    expect(diagnostic).toContain(process.execPath);
    expect(diagnostic).toContain("update-pi-suite.mjs");
    expect(diagnostic).toContain("--recover-ignored-state");
    expect(diagnostic).not.toMatch(/(?:^|\s)npm(?:\s|$)/);
    expect(diagnostic).not.toContain("private failure details");
    expect(diagnostic).not.toContain(root);
  });

  it.each(["manifest", "lock", "installed"])("rejects a mixed %s outcome and rolls back tracked bytes", async (layer) => {
    const root = await fixture();
    const originalManifest = await readFile(path.join(root, "package.json"));
    const originalLock = await readFile(path.join(root, "package-lock.json"));
    const code = await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: output().sink, validateSuite: validatePiSuite,
      runNpm: (args: string[]) => {
        if (args[0] === "view") return child({ stdout: '"0.82.0"' });
        if (args[0] === "install") {
          const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
          const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
          if (layer === "manifest") manifest.dependencies[PI_SUITE_PACKAGES[0]!] = "0.82.0";
          else {
            for (const name of PI_SUITE_PACKAGES) manifest.dependencies[name] = "0.82.0";
            lock.packages[""].dependencies = manifest.dependencies;
            for (const name of PI_SUITE_PACKAGES) {
              lock.packages[`node_modules/${name}`].version = layer === "lock" && name === PI_SUITE_PACKAGES[0] ? "0.81.1" : "0.82.0";
              fs.writeFileSync(path.join(root, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version: layer === "installed" && name === PI_SUITE_PACKAGES[0] ? "0.81.1" : "0.82.0" }));
            }
          }
          fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
          fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
        }
        return child();
      },
    });
    expect(code).toBe(1);
    expect(await readFile(path.join(root, "package.json"))).toEqual(originalManifest);
    expect(await readFile(path.join(root, "package-lock.json"))).toEqual(originalLock);
  });

  it("delegates nested mixed graph rejection to the strict shared validator and rolls back", async () => {
    const root = await fixture();
    const originalManifest = await readFile(path.join(root, "package.json"));
    const originalLock = await readFile(path.join(root, "package-lock.json"));
    const calls: string[][] = [];
    const code = await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: output().sink, validateSuite: validatePiSuite,
      runNpm: fakeSuccess("0.82.0", calls, () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        for (const name of PI_SUITE_PACKAGES) manifest.dependencies[name] = "0.82.0";
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
        const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
        lock.packages[""].dependencies = manifest.dependencies;
        for (const name of PI_SUITE_PACKAGES) lock.packages[`node_modules/${name}`].version = "0.82.0";
        lock.packages[`node_modules/${PI_SUITE_PACKAGES[0]}/node_modules/${PI_SUITE_PACKAGES[1]}`] = { name: PI_SUITE_PACKAGES[1], version: "0.81.1" };
        fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
      }),
    });
    expect(code).toBe(1);
    expect(await readFile(path.join(root, "package.json"))).toEqual(originalManifest);
    expect(await readFile(path.join(root, "package-lock.json"))).toEqual(originalLock);
    expect(calls.at(-1)?.[0]).toBe("ci");
  });

  it("uses the hardened path-limited Git probe and permits unrelated dirty files", async () => {
    const root = await fixture();
    await put(path.join(root, "unrelated-sentinel"), "preserve me");
    const gitCalls: Array<{ args: string[]; options: unknown }> = [];
    const npmCalls: string[][] = [];
    let validations = 0;
    const code = await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: output().sink,
      runGit: (args: string[], options: unknown) => {
        gitCalls.push({ args, options });
        return child({ stdout: args.includes("ls-files") ? "H package.json\nH package-lock.json\n" : "" });
      },
      runNpm: fakeSuccess("0.82.0", npmCalls),
      validateSuite: () => ({ ok: true, version: validations++ === 0 ? "0.81.1" : "0.82.0", mode: VALIDATION_MODES.COHERENT_BOOTSTRAP }),
    });
    expect(code).toBe(0);
    expect(gitCalls).toHaveLength(3);
    const canonicalRoot = process.platform === "win32" ? fs.realpathSync.native(root).toLowerCase() : fs.realpathSync.native(root);
    expect(gitCalls[0]!.args.slice(-6)).toEqual(["-C", canonicalRoot, "config", "--null", "--get-regexp", "^filter\\..*\\.(clean|process)$"]);
    expect(gitCalls[1]!.args.slice(-7)).toEqual(["-C", canonicalRoot, "ls-files", "-v", "--", "package.json", "package-lock.json"]);
    expect(gitCalls[2]!.args.slice(-8)).toEqual(["-C", canonicalRoot, "status", "--porcelain=v2", "--untracked-files=all", "--", "package.json", "package-lock.json"]);
    for (const call of gitCalls) {
      expect(call.args).toEqual(expect.arrayContaining(["--no-optional-locks", "core.fsmonitor=false", "filter.lfs.clean=", "filter.lfs.process="]));
      expect(call.options).toEqual({ cwd: canonicalRoot, trustedRoots: [canonicalRoot] });
    }
    expect(await readFile(path.join(root, "unrelated-sentinel"), "utf8")).toBe("preserve me");
  });

  it.each(["staged", "unstaged"])("refuses %s dependency metadata before npm", async (kind) => {
    const root = await fixture();
    await put(path.join(root, "package.json"), `${await readFile(path.join(root, "package.json"), "utf8")} `);
    if (kind === "staged") {
      const git = discoverTrustedGit()!;
      await new Promise<void>((resolve, reject) => execFile(git, ["add", "package.json"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    }
    let npmCalls = 0;
    const capture = output();
    expect(await runPiSuiteUpdate({ argv: ["0.82.0"], packageRoot: root, runNpm: () => { npmCalls++; return child(); }, output: capture.sink })).toBe(1);
    expect(npmCalls).toBe(0);
    expect(capture.stderr.join("\n")).toContain("package.json has staged or unstaged changes");
    expect(capture.stderr.join("\n")).toContain("Commit or restore package.json, then retry");
  });

  it("never echoes untrusted Git status text or paths", async () => {
    const root = await fixture();
    const capture = output();
    const hostile = "attacker-controlled-path-and-text";
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: capture.sink,
      runGit: (args: string[]) => child({
        stdout: args.includes("ls-files")
          ? "H package.json\nH package-lock.json\n"
          : args.includes("status") ? `1 .M N... 100644 100644 100644 deadbeef deadbeef ${hostile}\n` : "",
      }),
      runNpm: () => { throw new Error("npm must not run"); },
    })).toBe(1);
    expect(capture.stderr.join("\n")).toContain("package.json and package-lock.json have staged or unstaged changes");
    expect(capture.stderr.join("\n")).not.toContain(hostile);
  });

  it.each([
    ["--skip-worktree", "package.json"],
    ["--assume-unchanged", "package-lock.json"],
  ])("refuses hidden Git index state %s on %s before npm", async (flag, name) => {
    const root = await fixture();
    const git = discoverTrustedGit()!;
    await new Promise<void>((resolve, reject) => execFile(git, ["update-index", flag, name], { cwd: root }, (error) => error ? reject(error) : resolve()));
    let npmCalls = 0;
    const capture = output();
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: capture.sink,
      runNpm: () => { npmCalls++; return child(); },
    })).toBe(1);
    expect(npmCalls).toBe(0);
    expect(capture.stderr).toEqual([
      `PiCC: update refused because ${name} must be normally tracked (skip-worktree and assume-unchanged are refused). From the PiCC checkout, run \`git update-index --no-skip-worktree --no-assume-unchanged -- ${name}\`, then retry. No registry or npm mutation was attempted.`,
    ]);
  });

  it("renders only fixed metadata names in hidden-index remediation", async () => {
    const root = await fixture();
    const capture = output();
    const hostile = "attacker-controlled-index-text";
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: capture.sink,
      runGit: (args: string[]) => child({
        stdout: args.includes("ls-files") ? `S package.json\nH package-lock.json\n${hostile}\n` : "",
      }),
      runNpm: () => { throw new Error("npm must not run"); },
    })).toBe(1);
    expect(capture.stderr).toEqual([
      "PiCC: update refused because package.json must be normally tracked (skip-worktree and assume-unchanged are refused). From the PiCC checkout, run `git update-index --no-skip-worktree --no-assume-unchanged -- package.json`, then retry. No registry or npm mutation was attempted.",
    ]);
    expect(capture.stderr.join("\n")).not.toContain(hostile);
  });

  it("refuses an identical-byte metadata replacement while the Git probe settles", async () => {
    const root = await fixture();
    const filename = path.join(root, "package.json");
    const bytes = await readFile(filename);
    let npmCalls = 0;
    const capture = output();
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: capture.sink,
      runGit: (args: string[]) => {
        if (args.includes("ls-files")) return child({ stdout: "H package.json\nH package-lock.json\n" });
        if (args.includes("status")) {
          const replacement = path.join(root, ".identical-replacement");
          fs.writeFileSync(replacement, bytes);
          fs.rmSync(filename);
          fs.renameSync(replacement, filename);
        }
        return child();
      },
      runNpm: () => { npmCalls++; return child(); },
    })).toBe(1);
    expect(npmCalls).toBe(0);
    expect(await readFile(filename)).toEqual(bytes);
    expect(capture.stderr.join("\n")).toContain("changed while Git state was being verified");
  });

  it("refuses configured clean/process filters without executing them", async () => {
    const root = await fixture();
    const canary = path.join(root, "filter-canary");
    const git = discoverTrustedGit()!;
    await new Promise<void>((resolve, reject) => execFile(git, ["config", "filter.hostile.clean", `${process.execPath} -e \"require('fs').writeFileSync('${canary.replaceAll("\\", "\\\\")}', 'ran')\"`], { cwd: root }, (error) => error ? reject(error) : resolve()));
    let npmCalls = 0;
    const capture = output();
    expect(await runPiSuiteUpdate({ argv: ["0.82.0"], packageRoot: root, runNpm: () => { npmCalls++; return child(); }, output: capture.sink })).toBe(1);
    expect(npmCalls).toBe(0);
    expect(fs.existsSync(canary)).toBe(false);
    expect(capture.stderr.join("\n")).toContain("filter policy");
  });

  it.each(["spawn error", "termination signal", "output overflow", "deadline exceeded"])("recovers after install %s", async (category) => {
    const root = await fixture();
    const calls: string[][] = [];
    const capture = output();
    let validations = 0;
    const code = await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: capture.sink, deadlineMs: 20,
      validateSuite: (options: { mode?: string }) => {
        if (validations++ > 0) expect(options.mode).toBe(VALIDATION_MODES.COHERENT_BOOTSTRAP);
        return { ok: true, version: "0.81.1", mode: VALIDATION_MODES.COHERENT_BOOTSTRAP };
      },
      runNpm: (args: string[]) => {
        calls.push(args);
        if (args[0] === "view") return child({ stdout: '"0.82.0"' });
        if (args[0] === "ci") return child();
        if (category === "spawn error") { const value = pendingChild(); queueMicrotask(() => value.emit("error", new Error("secret"))); return value; }
        if (category === "termination signal") { const value = pendingChild(); queueMicrotask(() => value.emit("close", null, "SIGTERM")); return value; }
        if (category === "output overflow") return child({ stdout: "x".repeat(300 * 1024) });
        return pendingChild();
      },
    });
    expect(code).toBe(1);
    expect(capture.stderr.join("\n")).toContain(category);
    expect(calls.at(-1)?.[0]).toBe("ci");
    assertFixedPolicy(calls.at(-1)!, 1);
  });

  it("catches thrown post-validation and restores with the baseline mode", async () => {
    const root = await fixture();
    const original = await readFile(path.join(root, "package.json"));
    let validations = 0;
    const calls: string[][] = [];
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: output().sink,
      runNpm: fakeSuccess("0.82.0", calls, () => fs.writeFileSync(path.join(root, "package.json"), "partial")),
      validateSuite: (options: { mode?: string }) => {
        validations++;
        if (validations === 1) return { ok: true, version: "0.81.1", mode: VALIDATION_MODES.COHERENT_BOOTSTRAP };
        if (validations === 2) throw new Error("secret validation");
        expect(options.mode).toBe(VALIDATION_MODES.COHERENT_BOOTSTRAP);
        return { ok: true, version: "0.81.1", mode: VALIDATION_MODES.COHERENT_BOOTSTRAP };
      },
    })).toBe(1);
    expect(await readFile(path.join(root, "package.json"))).toEqual(original);
    expect(calls.at(-1)?.[0]).toBe("ci");
  });

  it.each(["package.json", "package-lock.json"])("replaces a rollback destination symlink without touching its outside canary: %s", async (name) => {
    const root = await fixture();
    const canary = path.join(await mkdtemp(path.join(os.tmpdir(), "picc outside canary ")), name);
    cleanup.push(path.dirname(canary));
    await put(canary, "outside-safe");
    const original = await readFile(path.join(root, name));
    const code = await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: output().sink,
      runNpm: (args: string[]) => {
        if (args[0] === "view") return child({ stdout: '"0.82.0"' });
        if (args[0] === "install") {
          fs.rmSync(path.join(root, name));
          try { fs.symlinkSync(canary, path.join(root, name), "file"); } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") return child({ code: 1 });
            throw error;
          }
          return child({ code: 1 });
        }
        return child();
      },
      validateSuite: () => ({ ok: true, version: "0.81.1", mode: VALIDATION_MODES.COHERENT_BOOTSTRAP }),
    });
    expect(code).toBe(1);
    expect(await readFile(canary, "utf8")).toBe("outside-safe");
    expect(await readFile(path.join(root, name))).toEqual(original);
  });

  it("restores and reverifies tracked bytes after recovery npm mutates them", async () => {
    const root = await fixture();
    const originals = await Promise.all(["package.json", "package-lock.json"].map((name) => readFile(path.join(root, name))));
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, output: output().sink,
      runNpm: (args: string[]) => {
        if (args[0] === "view") return child({ stdout: '"0.82.0"' });
        if (args[0] === "install") return child({ code: 1 });
        fs.writeFileSync(path.join(root, "package.json"), "recovery mutation");
        fs.writeFileSync(path.join(root, "package-lock.json"), "recovery mutation");
        return child();
      },
      validateSuite: () => ({ ok: true, version: "0.81.1", mode: VALIDATION_MODES.COHERENT_BOOTSTRAP }),
    })).toBe(1);
    expect(await readFile(path.join(root, "package.json"))).toEqual(originals[0]);
    expect(await readFile(path.join(root, "package-lock.json"))).toEqual(originals[1]);
  });

  it("recovers a missing installed graph before performing declaration-derived full validation", async () => {
    const root = await fixture();
    await rm(path.join(root, "node_modules"), { recursive: true });
    expect(validatePiSuite({ packageRoot: root }).ok).toBe(false);
    const calls: string[][] = [];
    expect(await runPiSuiteRecovery({
      packageRoot: root, output: output().sink, validateSuite: validatePiSuite,
      runNpm: (args: string[]) => {
        calls.push(args);
        for (const name of PI_SUITE_PACKAGES) {
          fs.mkdirSync(path.join(root, "node_modules", ...name.split("/")), { recursive: true });
          fs.writeFileSync(path.join(root, "node_modules", ...name.split("/"), "package.json"), JSON.stringify({ name, version: "0.81.1" }));
        }
        return child();
      },
    })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("ci");
    expect(validatePiSuite({ packageRoot: root })).toMatchObject({ ok: true, version: "0.81.1", mode: VALIDATION_MODES.STRICT_EXACT });
  });

  it("restores recovery-side tracked mutations before validating the resulting graph", async () => {
    const root = await fixture();
    const originals = await Promise.all(TRACKED_TEST_NAMES.map((name) => readFile(path.join(root, name))));
    let validations = 0;
    expect(await runPiSuiteRecovery({
      packageRoot: root, output: output().sink,
      runNpm: () => {
        for (const name of TRACKED_TEST_NAMES) fs.writeFileSync(path.join(root, name), "npm mutation");
        return child();
      },
      validateSuite: (options: { packageRoot: string; mode?: string }) => {
        validations++;
        expect(options.mode).toBeUndefined();
        expect(TRACKED_TEST_NAMES.map((name) => fs.readFileSync(path.join(root, name)))).toEqual(originals);
        return { ok: true, version: "0.81.1", mode: VALIDATION_MODES.STRICT_EXACT };
      },
    })).toBe(0);
    expect(validations).toBe(1);
    expect(await Promise.all(TRACKED_TEST_NAMES.map((name) => readFile(path.join(root, name))))).toEqual(originals);
  });

  it("runs dedicated recovery mode with exact ci policy and copyable platform commands", async () => {
    const root = await fixture();
    const calls: Array<{ args: string[]; options: unknown }> = [];
    let validations = 0;
    expect(await runPiSuiteRecovery({
      packageRoot: root, output: output().sink,
      runNpm: (args: string[], options: unknown) => { calls.push({ args, options }); return child(); },
      validateSuite: (options: { mode?: string }) => {
        validations++;
        expect(options.mode).toBeUndefined();
        return { ok: true, version: "0.81.1", mode: VALIDATION_MODES.STRICT_EXACT };
      },
    })).toBe(0);
    expect(validations).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe("ci");
    assertFixedPolicy(calls[0]!.args, 1);
    const canonicalRoot = process.platform === "win32" ? fs.realpathSync.native(root).toLowerCase() : fs.realpathSync.native(root);
    expect(calls[0]!.options).toEqual({ cwd: canonicalRoot, trustedRoots: [canonicalRoot] });
    expect(ignoredStateRecoveryCommand("linux", {
      nodePath: "/opt/Arne's Node/bin/node",
      scriptPath: "/work/PiCC's checkout/update suite.mjs",
    })).toBe("POSIX shell recovery command (run from the PiCC checkout): '/opt/Arne'\"'\"'s Node/bin/node' '/work/PiCC'\"'\"'s checkout/update suite.mjs' '--recover-ignored-state'");
    expect(ignoredStateRecoveryCommand("win32", {
      nodePath: "C:\\Program Files\\Arne's Node\\node.exe",
      scriptPath: "C:\\PiCC's checkout\\update suite.mjs",
    })).toBe("PowerShell recovery command (run from the PiCC checkout): & 'C:\\Program Files\\Arne''s Node\\node.exe' 'C:\\PiCC''s checkout\\update suite.mjs' '--recover-ignored-state'");
  });

  it("fails unavailable trusted tooling before mutation with non-command guidance", async () => {
    const capture = output();
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: path.join(os.tmpdir(), "absent"), output: capture.sink,
      discoverNpm: () => undefined, discoverGit: () => undefined,
    })).toBe(1);
    expect(capture.stderr.join("\n")).toContain("official distributions");
    expect(capture.stderr.join("\n")).not.toContain("recovery command");
  });

  it("real entrypoint rejects malformed argv with status 1 and no network", async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [script, "0.82.0-beta.1"], { cwd: repoRoot, encoding: "utf8" }, (error, stdout, stderr) => {
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      });
    });
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("one stable exact version");
  });

  it.skipIf(!discoverTrustedGit())("spawned entrypoint routes recovery mode in a materialized network-free fixture", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(root, "bin"), { recursive: true });
    await copyFile(script, path.join(root, "scripts", "update-pi-suite.mjs"));
    await copyFile(path.join(repoRoot, "bin", "picc-admin.mjs"), path.join(root, "bin", "picc-admin.mjs"));
    const runtime = path.join(root, "runtime");
    const materializedNode = path.join(runtime, path.basename(process.execPath));
    const fakeNpm = path.join(runtime, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(path.dirname(fakeNpm), { recursive: true });
    await copyFile(process.execPath, materializedNode);
    await chmod(materializedNode, 0o755);
    await writeFile(fakeNpm, "process.exitCode = process.argv[2] === 'ci' ? 0 : 97;\n");

    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(materializedNode, [path.join(root, "scripts", "update-pi-suite.mjs"), "--recover-ignored-state"], { cwd: root, encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      });
    });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Outcome: restored ignored dependency state for embedded Pi 0.81.1");
    expect(result.stdout).not.toContain("updated the complete direct Pi suite");
  }, 20_000);

  it.skipIf(!discoverTrustedNpmCli() || !discoverTrustedGit())("real npm honors lifecycle suppression during failed mutation and recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "picc suite real npm "));
    cleanup.push(root);
    const packageDir = path.join(root, "canary-package");
    const lifecycleCanary = path.join(root, "lifecycle-ran");
    const gitCanary = path.join(root, "git-config-ran");
    await put(path.join(packageDir, "package.json"), JSON.stringify({
      name: "canary-package", version: "1.0.0",
      scripts: {
        install: `node -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(lifecycleCanary)}, 'ran')`)}`,
        prepare: `git config --file ${JSON.stringify(gitCanary)} canary.ran yes`,
      },
    }));
    const manifestFile = path.join(root, "package.json");
    await put(manifestFile, JSON.stringify({ name: "picc", version: "0.1.0", dependencies: { "canary-package": "file:canary-package" } }, null, 2));
    await new Promise<void>((resolve, reject) => {
      const npm = runTrustedNpm(["install", "--package-lock-only", "--ignore-scripts", "--audit=false", "--fund=false"], { cwd: root, trustedRoots: [root] });
      const events = npm as unknown as EventEmitter;
      events.once("error", reject);
      events.once("close", (code: number | null) => code === 0 ? resolve() : reject(new Error("fixture lock failed")));
    });
    const baselineManifest = await readFile(manifestFile);
    const baselineLock = await readFile(path.join(root, "package-lock.json"));
    const git = discoverTrustedGit()!;
    await new Promise<void>((resolve, reject) => execFile(git, ["init", "--quiet"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => execFile(git, ["add", "package.json", "package-lock.json"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => execFile(git, ["-c", "user.name=PiCC", "-c", "user.email=picc@example.test", "commit", "--quiet", "-m", "fixture"], { cwd: root }, (error) => error ? reject(error) : resolve()));
    let validations = 0;
    const runNpm = (args: string[], options: { cwd: string; trustedRoots: string[] }) => {
      if (args[0] === "view") return child({ stdout: '"0.82.0"' });
      if (args[0] === "install") {
        const localArgs = ["install", "./canary-package", "--save-exact", ...args.slice(args.indexOf("--ignore-scripts"))];
        return runTrustedNpm(localArgs, options);
      }
      return runTrustedNpm(args, options);
    };
    expect(await runPiSuiteUpdate({
      argv: ["0.82.0"], packageRoot: root, runNpm, output: output().sink,
      validateSuite: () => ({ ok: true, version: validations++ === 0 ? "0.81.1" : "0.81.1" }),
    })).toBe(1);
    expect(await readFile(manifestFile)).toEqual(baselineManifest);
    expect(await readFile(path.join(root, "package-lock.json"))).toEqual(baselineLock);
    expect(fs.existsSync(lifecycleCanary)).toBe(false);
    expect(fs.existsSync(gitCanary)).toBe(false);
  }, 30_000);
});

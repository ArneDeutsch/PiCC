import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PI_SUITE_PACKAGES, canonicalPath } from "../bin/picc-admin.mjs";
import { runPiSuiteUpdate } from "../scripts/update-pi-suite.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "update-pi-suite.mjs");
const cleanup: string[] = [];
const npmCli = path.join(repoRoot, "fake", "npm-cli.js");
const gitCli = path.join(repoRoot, "fake", "git");

type FakeChild = EventEmitter & { stdout: PassThrough };

function child(code = 0, stdout = "", signal: NodeJS.Signals | null = null): FakeChild {
  const value = new EventEmitter() as FakeChild;
  value.stdout = new PassThrough();
  queueMicrotask(() => {
    if (stdout) value.stdout.write(stdout);
    value.stdout.end();
    value.emit("close", code, signal);
  });
  return value;
}

function spawnError(): FakeChild {
  const value = new EventEmitter() as FakeChild;
  value.stdout = new PassThrough();
  queueMicrotask(() => value.emit("error", new Error("unavailable")));
  return value;
}

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, sink: { log: (line: string) => stdout.push(line), error: (line: string) => stderr.push(line) } };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "picc-suite-update-"));
  cleanup.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "picc" }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  return canonicalPath(fs.realpathSync(root));
}

function baseOptions(root: string, spawnProcess: (...args: any[]) => FakeChild) {
  return {
    argv: ["0.82.0"],
    packageRoot: root,
    discoverGit: () => gitCli,
    discoverNpm: () => ({ command: process.execPath, args: [npmCli] }),
    spawnProcess,
    validateSuite: () => ({ ok: true, version: "0.82.0" }),
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("coordinated Pi-suite update", () => {
  it.each([
    [], ["0.82"], ["0.82.0-beta.1"], ["^0.82.0"], ["latest"], ["0.82.0", "extra"],
  ] as string[][])("rejects invalid or extra argv before discovery: %j", async (argv) => {
    let discovered = false;
    const capture = output();
    expect(await runPiSuiteUpdate({
      argv,
      output: capture.sink,
      discoverGit: () => { discovered = true; return gitCli; },
    })).toBe(1);
    expect(discovered).toBe(false);
    expect(capture.stderr.join("\n")).toContain("<stable-exact-version>");
  });

  it.each([
    ["unstaged", 0],
    ["staged", 1],
  ] as const)("refuses %s dependency metadata changes before npm", async (_kind, failAt) => {
    const root = await fixture();
    const calls: Array<{ command: string; args: string[]; options: any }> = [];
    const capture = output();
    const spawnProcess = (command: string, args: string[], options: any) => {
      calls.push({ command, args, options });
      return child(calls.length - 1 === failAt ? 1 : 0);
    };
    expect(await runPiSuiteUpdate({ ...baseOptions(root, spawnProcess), output: capture.sink })).toBe(1);
    expect(calls).toHaveLength(failAt + 1);
    expect(calls.at(-1)).toEqual({
      command: gitCli,
      args: failAt === 0
        ? ["diff", "--quiet", "--", "package.json", "package-lock.json"]
        : ["diff", "--cached", "--quiet", "--", "package.json", "package-lock.json"],
      options: { cwd: root, env: process.env, stdio: "inherit", shell: false },
    });
    expect(calls.every(({ command }) => command === gitCli)).toBe(true);
    expect(capture.stderr.join("\n")).toContain("package.json or package-lock.json is dirty");
  });

  it("runs one visible npm transaction with inherited configuration, then validates direct packages", async () => {
    const root = await fixture();
    const calls: Array<{ command: string; args: string[]; options: any }> = [];
    const validations: any[] = [];
    const capture = output();
    const spawnProcess = (command: string, args: string[], options: any) => {
      calls.push({ command, args, options });
      return child();
    };
    expect(await runPiSuiteUpdate({
      ...baseOptions(root, spawnProcess),
      output: capture.sink,
      validateSuite: (options: any) => { validations.push(options); return { ok: true, version: "0.82.0" }; },
    })).toBe(0);
    expect(calls).toEqual([
      {
        command: gitCli,
        args: ["diff", "--quiet", "--", "package.json", "package-lock.json"],
        options: { cwd: root, env: process.env, stdio: "inherit", shell: false },
      },
      {
        command: gitCli,
        args: ["diff", "--cached", "--quiet", "--", "package.json", "package-lock.json"],
        options: { cwd: root, env: process.env, stdio: "inherit", shell: false },
      },
      {
        command: process.execPath,
        args: [
          npmCli,
          "install",
          ...PI_SUITE_PACKAGES.map((name) => `${name}@0.82.0`),
          "--save-exact",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        options: { cwd: root, env: process.env, stdio: "inherit", shell: false },
      },
    ]);
    expect(validations).toEqual([{ packageRoot: root }]);
    expect(capture.stdout).toEqual(["Outcome: updated the complete direct Pi suite to 0.82.0."]);
  });

  it.each([
    ["Git failure", 0, () => child(1)],
    ["Git spawn failure", 0, () => spawnError()],
    ["npm failure", 2, () => child(1)],
    ["npm signal", 2, () => child(0, "", "SIGTERM")],
    ["npm spawn failure", 2, () => spawnError()],
  ] as const)("reports the failed lean transaction for %s", async (_label, failAt, failedChild) => {
    const root = await fixture();
    let call = 0;
    const capture = output();
    const spawnProcess = () => call++ === failAt ? failedChild() : child();
    expect(await runPiSuiteUpdate({ ...baseOptions(root, spawnProcess), output: capture.sink })).toBe(1);
    expect(capture.stderr.join("\n")).toContain(
      failAt < 2 ? "package.json or package-lock.json is dirty" : "npm install failed",
    );
  });

  it.each([
    ["package mismatch", () => ({ ok: false, reason: "direct package mismatch" }), "direct package mismatch"],
    ["wrong version", () => ({ ok: true, version: "0.82.1" }), "Pi suite validation failed"],
  ] as const)("fails after direct-package validation: %s", async (_label, validateSuite, expected) => {
    const root = await fixture();
    const capture = output();
    expect(await runPiSuiteUpdate({
      ...baseOptions(root, () => child()),
      output: capture.sink,
      validateSuite,
    })).toBe(1);
    expect(capture.stderr.join("\n")).toContain(expected);
  });

  it("fails before Git when npm is unavailable", async () => {
    const root = await fixture();
    let spawned = false;
    const capture = output();
    expect(await runPiSuiteUpdate({
      ...baseOptions(root, () => { spawned = true; return child(); }),
      discoverNpm: () => undefined,
      output: capture.sink,
    })).toBe(1);
    expect(spawned).toBe(false);
    expect(capture.stderr.join("\n")).toContain("Git and npm are required");
  });

  it("real entrypoint rejects malformed argv without starting npm", async () => {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [script, "0.82.0-beta.1"], { cwd: repoRoot, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      });
    });
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain("<stable-exact-version>");
  });
});

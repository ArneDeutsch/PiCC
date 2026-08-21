import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { discoverNpmCommand } from "../bin/picc-admin.mjs";
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

function fakeChild(stdout: string) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

function runNpmSync(npm: { command: string; args: string[] }, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(npm.command, [...npm.args, ...args], {
    cwd,
    env,
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm fixture command failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

describe("global same-version runtime repair", () => {
  it("forces a local tarball reinstall to replace corrupted bytes in an isolated npm prefix", async () => {
    const npm = discoverNpmCommand();
    expect(npm).toBeTruthy();
    const workspace = temp("picc-update-repair-");
    const packageDirectory = path.join(workspace, "package");
    const archiveDirectory = path.join(workspace, "archive");
    const prefix = path.join(workspace, "prefix");
    const cache = path.join(workspace, "npm-cache");
    fs.mkdirSync(path.join(packageDirectory, "dist"), { recursive: true });
    fs.mkdirSync(archiveDirectory, { recursive: true });
    fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({
      name: "@arnedeutsch/picc",
      version: "1.2.3",
      type: "module",
      files: ["dist"],
    }));
    fs.writeFileSync(path.join(packageDirectory, "dist", "runtime.js"), "verified-runtime\n");

    const env = {
      ...process.env,
      npm_config_cache: cache,
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    const packJson = runNpmSync(npm!, ["pack", "--ignore-scripts", "--json", "--pack-destination", archiveDirectory], packageDirectory, env);
    const packed = JSON.parse(packJson) as Array<{ filename: string }>;
    expect(packed).toHaveLength(1);
    expect(packed[0]!.filename).toBe("arnedeutsch-picc-1.2.3.tgz");
    const tarball = path.join(archiveDirectory, packed[0]!.filename);
    runNpmSync(npm!, [
      "install", "--global", tarball, "--prefix", prefix, "--offline",
      "--ignore-scripts", "--no-audit", "--no-fund",
    ], workspace, env);
    const globalRoot = runNpmSync(npm!, ["root", "--global", "--prefix", prefix], workspace, env);
    const root = path.join(globalRoot, "@arnedeutsch", "picc");
    const runtime = path.join(root, "dist", "runtime.js");
    expect(fs.readFileSync(runtime, "utf8")).toBe("verified-runtime\n");
    fs.writeFileSync(runtime, "corrupted-runtime\n");

    const observed: string[][] = [];
    const errors: string[] = [];
    const result = await runUpdate({
      packageRoot: root,
      globalRoot,
      runNpm: (args: string[], options: { cwd: string }) => {
        observed.push(args);
        if (args[0] === "view") return fakeChild("\"1.2.3\"\n");
        const localArgs = args.map((arg) => arg === "@arnedeutsch/picc@latest" ? tarball : arg);
        return spawn(npm!.command, [...npm!.args, ...localArgs, "--prefix", prefix, "--offline"], {
          cwd: options.cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      },
      buildRuntime: () => { throw new Error("an installed repair must not compile"); },
      validateRuntime: () => fs.readFileSync(runtime, "utf8") === "verified-runtime\n"
        ? { ok: true, entries: {}, manifest: {} }
        : { ok: false, reason: "The installed runtime is damaged." },
      validateSuite: () => ({ ok: true, version: "0.84.2" }),
      output: { log() {}, error(value: unknown) { errors.push(String(value)); } },
    });

    expect(errors).toEqual([]);
    expect(result).toBe(0);
    expect(observed).toEqual([
      ["view", "@arnedeutsch/picc", "version", "--json"],
      ["install", "--global", "--force", "@arnedeutsch/picc@latest", "--ignore-scripts", "--no-audit", "--no-fund"],
    ]);
    expect(fs.readFileSync(runtime, "utf8")).toBe("verified-runtime\n");
  });
});

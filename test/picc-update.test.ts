import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import picc from "../src/index.js";
import {
  capturePiccLaunchContext,
  piccUpdateGuidance,
  type PiccInstallKind,
} from "../src/runtime/picc-update.js";
import { fakePi } from "./helpers/fake-pi.js";
import { HookRunner } from "../src/engine/hook-runner.js";
import { resolveGitBashPath } from "../src/engine/shell-inject.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function directEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PICC_LAUNCHER_PID: "41",
    PICC_INSTALL_KIND: "installed",
    PICC_VERSION: "1.2.3",
    PI_SKIP_VERSION_CHECK: "1",
    ...overrides,
  };
}

describe("PiCC direct launch context", () => {
  it("accepts only the complete agreeing tuple and deletes PICC_* immediately", () => {
    const env = directEnv();
    const context = capturePiccLaunchContext({ env, parentPid: 41, localVersion: "1.2.3" });
    expect(context).toEqual({
      direct: true,
      version: "1.2.3",
      installKind: "installed",
    });
    expect(env.PICC_LAUNCHER_PID).toBeUndefined();
    expect(env.PICC_INSTALL_KIND).toBeUndefined();
    expect(env.PICC_VERSION).toBeUndefined();
    expect(env.PI_SKIP_VERSION_CHECK).toBe("1");
  });

  it.each([
    ["missing pid", { PICC_LAUNCHER_PID: undefined }, 41, "1.2.3"],
    ["zero pid", { PICC_LAUNCHER_PID: "0" }, 41, "1.2.3"],
    ["negative pid", { PICC_LAUNCHER_PID: "-41" }, 41, "1.2.3"],
    ["leading-zero pid", { PICC_LAUNCHER_PID: "041" }, 41, "1.2.3"],
    ["malformed pid", { PICC_LAUNCHER_PID: "41x" }, 41, "1.2.3"],
    ["overflow pid", { PICC_LAUNCHER_PID: "9007199254740992" }, 41, "1.2.3"],
    ["stale parent", {}, 42, "1.2.3"],
    ["wrong version", {}, 41, "1.2.4"],
    ["unavailable local version", {}, 41, null],
    ["malformed version", { PICC_VERSION: "1.2.3-beta" }, 41, "1.2.3"],
    ["missing kind", { PICC_INSTALL_KIND: undefined }, 41, "1.2.3"],
    ["wrong kind", { PICC_INSTALL_KIND: "global" }, 41, "1.2.3"],
    ["missing exact skip marker", { PI_SKIP_VERSION_CHECK: "true" }, 41, "1.2.3"],
  ])("rejects %s", (_label, overrides, parentPid, localVersion) => {
    const env = directEnv(overrides);
    expect(capturePiccLaunchContext({ env, parentPid, localVersion }).direct).toBe(false);
    expect(env.PICC_LAUNCHER_PID).toBeUndefined();
    expect(env.PI_SKIP_VERSION_CHECK).toBeUndefined();
  });

  it.each([
    "source",
    "installed",
  ] as const)("accepts the known install kind %s", (installKind) => {
    const env = directEnv({ PICC_INSTALL_KIND: installKind });
    expect(capturePiccLaunchContext({ env, parentPid: 41, localVersion: "1.2.3" })).toMatchObject({
      direct: true,
      installKind,
    });
  });

  it("does not consume an external host's independently configured Pi skip flag", () => {
    const env = { PI_SKIP_VERSION_CHECK: "1" };
    expect(capturePiccLaunchContext({ env, parentPid: 41, localVersion: "1.2.3" }).direct).toBe(false);
    expect(env.PI_SKIP_VERSION_CHECK).toBe("1");
  });
});

describe("installation guidance", () => {
  const expected: Record<PiccInstallKind, string[]> = {
    source: ["synchronize ignored dependencies", "does not adopt newer source", "Git"],
    installed: ["installed package", "Exit this session", "`picc update`", "package owner"],
  };
  for (const [installKind, fragments] of Object.entries(expected) as Array<[PiccInstallKind, string[]]>) {
    it(`renders ${installKind}`, () => {
      const text = piccUpdateGuidance({ direct: true, version: "1.2.3", installKind });
      for (const fragment of fragments) expect(text).toContain(fragment);
      expect(text).not.toContain("/update");
    });
  }
});

describe("extension command boundary", () => {
  it("registers /picc-update only for a direct launch and clears the retained skip before handling", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-update-command-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture\n", "utf8");
    const updateSkill = path.join(root, ".claude", "skills", "update");
    fs.mkdirSync(updateSkill, { recursive: true });
    fs.writeFileSync(
      path.join(updateSkill, "SKILL.md"),
      "---\ndescription: project update workflow\n---\nPROJECT-UPDATE-SKILL $ARGUMENTS\n",
      "utf8",
    );
    const userDir = path.join(root, ".user");
    fs.mkdirSync(userDir);
    const savedCwd = process.cwd();
    const saved = { ...process.env };
    try {
      process.chdir(root);
      process.env.PICC_CLAUDE_USER_DIR = userDir;
      process.env.PICC_LAUNCHER_PID = String(process.ppid);
      process.env.PICC_INSTALL_KIND = "source";
      process.env.PICC_VERSION = "0.1.0";
      process.env.PI_SKIP_VERSION_CHECK = "1";
      const pi = fakePi();
      picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
      expect(process.env.PICC_LAUNCHER_PID).toBeUndefined();
      expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
      const hookFire = vi.spyOn(HookRunner.prototype, "fire");
      const command = pi.commands.get("picc-update");
      expect(command).toBeDefined();
      await command.handler("--help", pi.tuiCtx());
      expect(process.env.PI_SKIP_VERSION_CHECK).toBeUndefined();
      expect(String(pi.entries.at(-1)?.data.output)).toContain("does not adopt newer source");
      for (const [mode, hasUI] of [["print", false], ["json", false], ["rpc", true]] as const) {
        await expect(pi.fire(
          "input",
          { text: "/picc-update", source: mode },
          pi.ctx({ mode, hasUI }),
        )).resolves.toEqual({ action: "handled" });
      }
      expect(hookFire).not.toHaveBeenCalled();
      expect(pi.userMessages).toEqual([]);
      expect(pi.messages).toEqual([]);
      const skill = await pi.fire("input", { text: "/update dependencies", source: "interactive" });
      expect(skill.action).toBe("transform");
      expect(skill.text).toContain("PROJECT-UPDATE-SKILL dependencies");
      expect(pi.messages).toEqual([]);
      await pi.waitForInitialization();
    } finally {
      process.chdir(savedCwd);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("registers first-user-Bash cleanup synchronously even when SDK setup degrades", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-update-admission-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture\n", "utf8");
    const savedCwd = process.cwd();
    const saved = { ...process.env };
    try {
      process.chdir(root);
      Object.assign(process.env, directEnv({
        PICC_LAUNCHER_PID: String(process.ppid),
        PICC_VERSION: "0.1.0",
      }));
      const pi = fakePi();
      picc(pi.api as never, {
        loadBuiltinSdk: async () => { throw new Error("SDK unavailable"); },
        onInitializationSettled: pi.captureInitialization,
      });
      expect(pi.handlers.get("user_bash")).toHaveLength(1);
      expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
      await pi.fire("user_bash", { command: "echo hi" });
      expect(process.env.PI_SKIP_VERSION_CHECK).toBeUndefined();
      await pi.waitForInitialization();
      expect(pi.handlers.get("user_bash")).toHaveLength(1);
    } finally {
      process.chdir(savedCwd);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("replaces local-Bash operations only when it can pin the shell", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-update-local-bash-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture\n", "utf8");
    const savedCwd = process.cwd();
    const saved = { ...process.env };
    const shellPath = resolveGitBashPath();
    const operationOptions: Array<Record<string, unknown>> = [];
    const instance = () => ({ execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
    const definition = () => ({});
    const sdk = {
      createLocalBashOperations: (options: Record<string, unknown>) => {
        operationOptions.push(options);
        return { execute: async () => undefined };
      },
      createBashTool: instance,
      createReadTool: instance,
      createWriteTool: instance,
      createEditTool: instance,
      createGrepTool: instance,
      createFindTool: instance,
      createLsTool: instance,
      createBashToolDefinition: definition,
      createReadToolDefinition: definition,
      createWriteToolDefinition: definition,
      createEditToolDefinition: definition,
      createGrepToolDefinition: definition,
      createFindToolDefinition: definition,
      createLsToolDefinition: definition,
    };
    try {
      process.chdir(root);
      Object.assign(process.env, directEnv({
        PICC_LAUNCHER_PID: String(process.ppid),
        PICC_VERSION: "0.1.0",
      }));
      const pi = fakePi();
      picc(pi.api as never, {
        loadBuiltinSdk: async () => sdk,
        onInitializationSettled: pi.captureInitialization,
      });
      await pi.waitForInitialization();
      expect(pi.handlers.get("user_bash")).toHaveLength(shellPath ? 2 : 1);
      await pi.fire("user_bash", { command: "echo hi" });
      expect(process.env.PI_SKIP_VERSION_CHECK).toBeUndefined();
      expect(operationOptions).toEqual(shellPath ? [{ shellPath }] : []);
    } finally {
      process.chdir(savedCwd);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("retains startup suppression for extension input, then clears before ordinary input work", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-update-input-admission-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture\n", "utf8");
    const savedCwd = process.cwd();
    const saved = { ...process.env };
    try {
      process.chdir(root);
      Object.assign(process.env, directEnv({
        PICC_LAUNCHER_PID: String(process.ppid),
        PICC_VERSION: "0.1.0",
      }));
      const pi = fakePi();
      picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
      let observed: string | undefined;
      (pi.api.on as (event: string, handler: () => void) => void)("input", () => {
        observed = process.env.PI_SKIP_VERSION_CHECK;
      });
      await pi.fire("input", { text: "internal", source: "extension" });
      expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
      await pi.fire("input", { text: "hello", source: "interactive" });
      expect(observed).toBeUndefined();
      expect(process.env.PI_SKIP_VERSION_CHECK).toBeUndefined();
      const nested = JSON.parse(execFileSync(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify({pid:process.env.PICC_LAUNCHER_PID,skip:process.env.PI_SKIP_VERSION_CHECK}))"],
        { encoding: "utf8" },
      )) as { pid?: string; skip?: string };
      expect(nested).toEqual({});
      await pi.waitForInitialization();
    } finally {
      process.chdir(savedCwd);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it("external hosting does not register the command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-update-external-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "fixture\n", "utf8");
    const savedCwd = process.cwd();
    try {
      process.chdir(root);
      const pi = fakePi();
      picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
      expect(pi.commands.has("picc-update")).toBe(false);
      await pi.waitForInitialization();
    } finally {
      process.chdir(savedCwd);
    }
  });
});

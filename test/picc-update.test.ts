import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import picc from "../src/index.js";
import {
  PICC_REGISTRY_LATEST_URL,
  capturePiccLaunchContext,
  checkForNewerPiccRelease,
  compareStableVersions,
  createPiccReleaseAdvisory,
  piccUpdateGuidance,
  type PiccInstallKind,
} from "../src/runtime/picc-update.js";
import { fakePi } from "./helpers/fake-pi.js";
import { deferred } from "./helpers/async.js";
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
    PICC_INSTALL_KIND: "verified public-registry global npm",
    PICC_VERSION: "1.2.3",
    PI_SKIP_VERSION_CHECK: "1",
    ...overrides,
  };
}

function registryResponse(value: unknown, url = PICC_REGISTRY_LATEST_URL): Response {
  const response = new Response(JSON.stringify(value), { status: 200 });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function rawRegistryResponse(
  body: ConstructorParameters<typeof Response>[0],
  init: ConstructorParameters<typeof Response>[1] = {},
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: PICC_REGISTRY_LATEST_URL });
  return response;
}

describe("PiCC direct launch context", () => {
  it("accepts only the complete agreeing tuple and deletes PICC_* immediately", () => {
    const env = directEnv();
    const context = capturePiccLaunchContext({ env, parentPid: 41, localVersion: "1.2.3" });
    expect(context).toEqual({
      direct: true,
      version: "1.2.3",
      installKind: "verified public-registry global npm",
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
    "verified public-registry global npm",
    "source",
    "known local package",
    "unknown/other",
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

  it("compares stable versions without numeric overflow or prerelease acceptance", () => {
    expect(compareStableVersions("999999999999999999999.0.0", "2.0.0")).toBe(1);
    expect(compareStableVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareStableVersions("1.2.2", "1.2.3")).toBe(-1);
    expect(compareStableVersions("1.2.4-beta", "1.2.3")).toBeUndefined();
    expect(compareStableVersions("01.2.3", "1.2.3")).toBeUndefined();
    expect(compareStableVersions("1.02.3", "1.2.3")).toBeUndefined();
    expect(compareStableVersions("1.2.03", "1.2.3")).toBeUndefined();
  });
});

describe("fixed provenance guidance", () => {
  const expected: Record<PiccInstallKind, string[]> = {
    "verified public-registry global npm": ["Exit this session", "`picc update`", "not modified"],
    source: ["synchronize ignored dependencies", "does not adopt newer source", "Git"],
    "known local package": ["installer or package owner", "will not mutate", "`picc --version`"],
    "unknown/other": ["ownership is unknown", "will not mutate", "installation owner"],
  };
  for (const [installKind, fragments] of Object.entries(expected) as Array<[PiccInstallKind, string[]]>) {
    it(`renders ${installKind}`, () => {
      const text = piccUpdateGuidance({ direct: true, version: "1.2.3", installKind });
      for (const fragment of fragments) expect(text).toContain(fragment);
      expect(text).not.toContain("/update");
    });
  }
});

describe("bounded public release check", () => {
  it("returns only a newer stable release from the fixed response origin", async () => {
    const seen: string[] = [];
    const version = await checkForNewerPiccRelease({
      currentVersion: "1.2.3",
      fetch: async (url, init) => {
        seen.push(String(url));
        expect(init?.redirect).toBe("error");
        return registryResponse({ name: "picc", version: "1.2.4" });
      },
    });
    expect(seen).toEqual([PICC_REGISTRY_LATEST_URL]);
    expect(version).toBe("1.2.4");
  });

  it.each([
    ["equal", { name: "picc", version: "1.2.3" }, PICC_REGISTRY_LATEST_URL],
    ["older", { name: "picc", version: "1.2.2" }, PICC_REGISTRY_LATEST_URL],
    ["prerelease", { name: "picc", version: "1.2.4-beta.1" }, PICC_REGISTRY_LATEST_URL],
    ["wrong schema", { name: "other", version: "9.0.0" }, PICC_REGISTRY_LATEST_URL],
    ["wrong origin", { name: "picc", version: "9.0.0" }, "https://example.com/latest"],
  ])("keeps %s responses quiet", async (_label, body, url) => {
    await expect(checkForNewerPiccRelease({
      currentVersion: "1.2.3",
      fetch: async () => registryResponse(body, url),
    })).resolves.toBeUndefined();
  });

  it("rejects an unavailable current version without fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(checkForNewerPiccRelease({
      currentVersion: "unknown",
      fetch: fetcher,
    })).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("honors offline and the distinct PiCC skip knob without fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(checkForNewerPiccRelease({
      currentVersion: "1.2.3", env: { PI_OFFLINE: "1" }, fetch: fetcher,
    })).resolves.toBeUndefined();
    await expect(checkForNewerPiccRelease({
      currentVersion: "1.2.3", env: { PICC_SKIP_UPDATE_CHECK: "1" }, fetch: fetcher,
    })).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();

    await expect(checkForNewerPiccRelease({
      currentVersion: "1.2.3",
      env: { PI_OFFLINE: "0", PICC_SKIP_UPDATE_CHECK: "false" },
      fetch: async () => registryResponse({ name: "picc", version: "1.2.4" }),
    })).resolves.toBe("1.2.4");
  });

  it.each([
    ["malformed JSON", rawRegistryResponse("{"), undefined],
    ["schema mismatch", rawRegistryResponse(JSON.stringify({ name: "picc", version: 4 })), undefined],
    ["non-OK status", rawRegistryResponse("no", { status: 503 }), undefined],
    ["missing body", rawRegistryResponse(null), undefined],
    ["invalid UTF-8", rawRegistryResponse(new Uint8Array([0xff])), undefined],
  ])("rejects %s", async (_label, response, expected) => {
    await expect(checkForNewerPiccRelease({
      currentVersion: "1.2.3",
      fetch: async () => response,
    })).resolves.toBe(expected);
  });

  it("silently rejects fetch failures", async () => {
    await expect(checkForNewerPiccRelease({
      currentVersion: "1.2.3",
      fetch: async () => { throw new Error("network down"); },
    })).resolves.toBeUndefined();
  });

  it("rejects an oversized body", async () => {
    await expect(checkForNewerPiccRelease({
      currentVersion: "1.2.3",
      maxBytes: 8,
      fetch: async () => registryResponse({ name: "picc", version: "9.0.0" }),
    })).resolves.toBeUndefined();
  });

  it("aborts a timed-out request and stays quiet", async () => {
    let aborted = false;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    }));
    await expect(checkForNewerPiccRelease({
      currentVersion: "1.2.3", timeoutMs: 5, fetch: fetcher,
    })).resolves.toBeUndefined();
    expect(aborted).toBe(true);
  });

  it("returns at the deadline and ignores a late fetch that does not honor abort", async () => {
    const late = deferred<Response>();
    const checking = checkForNewerPiccRelease({
      currentVersion: "1.2.3",
      timeoutMs: 5,
      fetch: async () => late.promise,
    });
    await expect(checking).resolves.toBeUndefined();
    late.resolve(registryResponse({ name: "picc", version: "9.0.0" }));
    await late.promise;
  });

  it.each([
    { direct: false, version: "1.2.3" },
    { direct: true, version: "1.2.3", installKind: "source" as const },
    { direct: true, version: "1.2.3", installKind: "known local package" as const },
    { direct: true, version: "1.2.3", installKind: "unknown/other" as const },
  ])("does not check an ineligible launch context: $installKind", async (context) => {
    const check = vi.fn(async () => "9.0.0");
    createPiccReleaseAdvisory({ context, check }).start(vi.fn());
    await Promise.resolve();
    expect(check).not.toHaveBeenCalled();
  });

  it("starts detached and checks/notifies at most once", async () => {
    const result = deferred<string | undefined>();
    const check = vi.fn(async () => result.promise);
    const notify = vi.fn();
    const advisory = createPiccReleaseAdvisory({
      context: {
        direct: true,
        version: "1.2.3",
        installKind: "verified public-registry global npm",
      },
      check,
    });
    advisory.start(notify);
    advisory.start(notify);
    expect(check).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    result.resolve("1.2.4");
    await result.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(notify).toHaveBeenCalledOnce();
  });
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

  it("starts one detached advisory only for verified-registry TUI startup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-update-wiring-"));
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
      const release = deferred<string | undefined>();
      const check = vi.fn(async () => release.promise);
      const pi = fakePi();
      picc(pi.api as never, { checkPiccRelease: check, onInitializationSettled: pi.captureInitialization });
      await pi.fire("session_start", { reason: "startup" }, pi.printCtx());
      await pi.fire("session_start", { reason: "startup" }, pi.ctx({ mode: "json", hasUI: false }));
      await pi.fire("session_start", { reason: "startup" }, pi.rpcCtx());
      await pi.fire("session_start", { reason: "new" }, pi.tuiCtx());
      expect(check).not.toHaveBeenCalled();
      await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
      await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
      expect(check).toHaveBeenCalledTimes(1);
      expect(pi.notifications.filter((item) => item.text.includes("9.0.0"))).toHaveLength(0);
      release.resolve("9.0.0");
      await release.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(pi.notifications.filter((item) => item.text.includes("9.0.0"))).toHaveLength(1);
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

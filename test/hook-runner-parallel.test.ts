import { afterAll, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseHookConfig } from "../src/claude/hooks.js";
import { loadSettings } from "../src/discovery/settings.js";
import { HookRunner } from "../src/engine/hook-runner.js";
import { waitUntil } from "./helpers/async.js";
import { createHookProcessFixture } from "./helpers/hook-process.js";

/**
 * Parallel execution, dedup, and async (fire-and-forget) hook semantics
 * (completeness audit C4/C5): all matching handlers of one fire() run
 * concurrently, identical commands run once, outcomes merge in CONFIG order,
 * and `async: true` handlers never delay fire().
 */

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcx-hooks-par-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function bashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function hostileCoercionValue(): object {
  return new Proxy(Object.create(null) as object, {
    get(_target, property) {
      if (property === "message" || property === "toString" || property === Symbol.toPrimitive) {
        throw new Error("hostile thrown-value content must not escape");
      }
      return undefined;
    },
  });
}

function makeRunner(
  rawHooks: unknown,
  overrides: {
    projectDir?: string;
    env?: Record<string, string>;
    onSpawnForTest?: (child: ChildProcess) => void;
  } = {},
): { runner: HookRunner; projectDir: string } {
  const projectDir = overrides.projectDir ?? makeTempDir();
  const runner = new HookRunner({
    config: parseHookConfig(rawHooks, "<test>").config,
    projectDir,
    sessionId: "sess-par-1",
    env: overrides.env ?? {},
    disableAllHooks: false,
    ...(overrides.onSpawnForTest ? { onSpawnForTest: overrides.onSpawnForTest } : {}),
  });
  return { runner, projectDir };
}

describe("HookRunner parallel execution (C4)", () => {
  it("runs matching handlers concurrently, not serially", async () => {
    const parent = makeTempDir();
    const child = createHookProcessFixture(parent);
    const { runner } = makeRunner(
      {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: child.command, args: ["parallel", "first"], timeout: 8 }] },
          { hooks: [{ type: "command", command: child.command, args: ["parallel", "second"], timeout: 8 }] },
        ],
      },
      { projectDir: parent, env: child.env, onSpawnForTest: child.onSpawnForTest },
    );
    const firing = runner.fire("UserPromptSubmit", { prompt: "hi" });
    try {
      // Each process stays gated until both entry markers exist. A serial runner
      // cannot produce the second marker, irrespective of scheduler speed.
      await child.waitFor(["first.entered", "second.entered"], "both parallel hooks to enter");
      child.release("first", "second");
      const outcome = await firing;
      expect(outcome.block).toBe(false);
      await child.waitFor(["first.done", "second.done"], "both parallel hooks to finish");
      expect(child.exitCode("first")).toBe(0);
      expect(child.exitCode("second")).toBe(0);
    } finally {
      await child.cleanup("first", "second");
      await firing;
    }
  }, 20000);

  it("merges outcomes in CONFIG order regardless of deterministic reverse completion", async () => {
    const parent = makeTempDir();
    const child = createHookProcessFixture(parent);
    const { runner } = makeRunner(
      {
        UserPromptSubmit: [{ hooks: [
          { type: "command", command: child.command, args: ["reverse-first", "first", '{"additionalContext":"ctx-first"}'], timeout: 8 },
          { type: "command", command: child.command, args: ["reverse-second", "second", '{"additionalContext":"ctx-second"}'], timeout: 8 },
        ] }],
      },
      { projectDir: parent, env: child.env, onSpawnForTest: child.onSpawnForTest },
    );
    const firing = runner.fire("UserPromptSubmit", { prompt: "hi" });
    try {
      await child.waitFor(["first.entered", "second.done"], "config-second completion before config-first");
      const outcome = await firing;
      expect(outcome.additionalContext).toBe("ctx-first\nctx-second");
      expect(child.exitCode("first")).toBe(0);
      expect(child.exitCode("second")).toBe(0);
    } finally {
      await child.cleanup("first", "second");
      await firing;
    }
  }, 20000);

  it("a reverse-first child can be cleaned up through its own release", async () => {
    const parent = makeTempDir();
    const child = createHookProcessFixture(parent);
    const { runner } = makeRunner(
      { UserPromptSubmit: [{ hooks: [{
        type: "command", command: child.command, args: ["reverse-first", "first", "released"], timeout: 8,
      }] }] },
      { projectDir: parent, env: child.env, onSpawnForTest: child.onSpawnForTest },
    );
    const firing = runner.fire("UserPromptSubmit", { prompt: "hi" });
    try {
      await child.waitFor(["first.entered"], "reverse-first hook to enter without a second hook");
      expect(child.exists("first.done")).toBe(false);
      child.release("first");
      const outcome = await firing;
      expect(outcome.stdout).toBe("released");
      await child.waitFor(["first.done"], "reverse-first hook to settle from its own release");
      expect(child.exitCode("first")).toBe(0);
    } finally {
      await child.cleanup("first");
      await firing;
    }
  }, 20000);

  it("first block wins in config order after a later hook blocks first", async () => {
    const parent = makeTempDir();
    const child = createHookProcessFixture(parent);
    const { runner } = makeRunner(
      { PreToolUse: [{ hooks: [
        { type: "command", command: child.command, args: ["reverse-first-block", "first", "config-first-reason"], timeout: 8 },
        { type: "command", command: child.command, args: ["reverse-second-block", "second", "config-second-reason"], timeout: 8 },
      ] }] },
      { projectDir: parent, env: child.env, onSpawnForTest: child.onSpawnForTest },
    );
    const firing = runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    try {
      await child.waitFor(["first.entered", "second.done"], "later blocking hook to complete first");
      const outcome = await firing;
      expect(outcome.block).toBe(true);
      expect(outcome.blockReason).toBe("config-first-reason");
      expect(child.exitCode("first")).toBe(2);
      expect(child.exitCode("second")).toBe(2);
    } finally {
      await child.cleanup("first", "second");
      await firing;
    }
  }, 20000);

  it("dedupes identical handlers (same type/command/args/shell/url) within one fire()", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      {
        UserPromptSubmit: [
          { hooks: [`echo fired >> "$MARKER"`] },
          { hooks: [`echo fired >> "$MARKER"`] }, // identical → runs once
          {
            hooks: [
              { type: "command", command: `echo fired >> "$MARKER"`, args: ["distinct"] },
            ], // different args → runs
          },
        ],
      },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("UserPromptSubmit", { prompt: "hi" });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(2);

    // The dedup window is per-fire: a second fire() runs the command again.
    await runner.fire("UserPromptSubmit", { prompt: "again" });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(4);
  });

  it("a once: true handler duplicated across entries fires exactly once across fires", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const onceHandler = { type: "command", command: `echo fired >> "$MARKER"`, once: true };
    const { runner } = makeRunner(
      {
        SessionStart: [
          // Identical dedup key, DISTINCT handler objects: the deduped-away
          // duplicate must count as fired too, not fire on the next fire().
          { hooks: [{ ...onceHandler }] },
          { hooks: [{ ...onceHandler }] },
        ],
      },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("SessionStart", {});
    await runner.fire("SessionStart", {});
    await runner.fire("SessionStart", {});
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });
});

describe("HookRunner spawn observer safety", () => {
  it("keeps a tracked command running normally when the observer throws", async () => {
    const parent = makeTempDir();
    const child = createHookProcessFixture(parent);
    const { runner } = makeRunner(
      { UserPromptSubmit: [{ hooks: [{
        type: "command", command: child.command,
        args: ["gate", "observer-normal", "observer output"], timeout: 8,
      }] }] },
      {
        projectDir: parent,
        env: child.env,
        onSpawnForTest: (spawned) => {
          child.onSpawnForTest(spawned);
          throw new Error(`normal observer exploded: ${"x".repeat(2_000)}`);
        },
      },
    );
    const firing = runner.fire("UserPromptSubmit", { prompt: "hi" });
    try {
      await child.waitFor(["observer-normal.entered"], "observer-warning command to enter");
      expect(child.exists("observer-normal.done")).toBe(false);
      child.release("observer-normal");
      const outcome = await firing;
      expect(outcome.stdout).toBe("observer output");
      const warning = outcome.diagnostics.find((diagnostic) =>
        diagnostic.message.includes("spawn observer failed"));
      expect(warning?.severity).toBe("warning");
      expect(warning?.message).toMatch(
        /^hook \(UserPromptSubmit\): spawn observer failed: normal observer exploded:/,
      );
      expect(warning?.message).toContain("…[truncated]; continuing");
      expect(warning?.message.length).toBeLessThan(1_100);
      await child.waitFor(["observer-normal.done"], "observer-warning command to finish");
      await child.waitForAllClosed("observer-warning command process to close");
      expect(child.exitCode("observer-normal")).toBe(0);
      expect(child.isClosed(child.spawnedChildren()[0]!)).toBe(true);
    } finally {
      await child.cleanup("observer-normal");
      await firing;
    }
  }, 20000);

  it("contains hostile observer coercion before tracking and lets HookRunner own completion", async () => {
    const parent = makeTempDir();
    const child = createHookProcessFixture(parent);
    const { runner } = makeRunner(
      { UserPromptSubmit: [{ hooks: [{
        type: "command", command: child.command,
        args: ["complete", "observer-hostile", "hostile command output"], timeout: 8,
      }] }] },
      {
        projectDir: parent,
        env: child.env,
        onSpawnForTest: () => {
          // Deliberately throw before the fixture can track the handle. The
          // short child must still receive stdin and reach normal close solely
          // through HookRunner's already-installed lifecycle.
          throw hostileCoercionValue();
        },
      },
    );
    const firing = runner.fire("UserPromptSubmit", { prompt: "hi" });
    try {
      const outcome = await firing;
      expect(outcome.stdout).toBe("hostile command output");
      expect(outcome.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
        "hook (UserPromptSubmit): spawn observer failed: unknown error; continuing",
      );
      expect(JSON.stringify(outcome)).not.toContain("hostile thrown-value content");
      expect(child.spawnedChildren()).toHaveLength(0);
      expect(child.exists("observer-hostile.done")).toBe(true);
      expect(child.exitCode("observer-hostile")).toBe(0);
    } finally {
      await child.cleanup("observer-hostile");
      await firing;
    }
  }, 20000);
});

describe("HookRunner async hooks (C5)", () => {
  it("reports a hostile observer warning once without rejecting, killing, or leaking", async () => {
    const parent = makeTempDir();
    const first = createHookProcessFixture(path.join(parent, "first"));
    const second = createHookProcessFixture(path.join(parent, "second"));
    const sentinel = createHookProcessFixture(path.join(parent, "sentinel"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const hostileObserver = (fixture: ReturnType<typeof createHookProcessFixture>) =>
      (spawned: ChildProcess) => {
        fixture.onSpawnForTest(spawned);
        throw hostileCoercionValue();
      };
    const firstRunner = makeRunner(
      { UserPromptSubmit: [{ hooks: [{
        type: "command", command: first.command, args: ["gate", "first"], async: true, timeout: 8,
      }] }] },
      { projectDir: parent, env: first.env, onSpawnForTest: hostileObserver(first) },
    ).runner;
    const secondRunner = makeRunner(
      { UserPromptSubmit: [{ hooks: [{
        type: "command", command: second.command, args: ["gate", "second"], async: true, timeout: 8,
      }] }] },
      { projectDir: parent, env: second.env, onSpawnForTest: hostileObserver(second) },
    ).runner;
    const sentinelRunner = makeRunner(
      { UserPromptSubmit: [{ hooks: [{
        type: "command", command: sentinel.command,
        args: ["complete", "sentinel"], async: true, timeout: 8,
      }] }] },
      {
        projectDir: parent,
        env: sentinel.env,
        onSpawnForTest: (spawned) => {
          sentinel.onSpawnForTest(spawned);
          throw new Error("observer diagnostic sentinel");
        },
      },
    ).runner;
    const firings = [
      firstRunner.fire("UserPromptSubmit", { prompt: "first" }),
      secondRunner.fire("UserPromptSubmit", { prompt: "second" }),
    ];
    try {
      await Promise.all([
        first.waitFor(["first.entered"], "first hostile-observer async command to enter"),
        second.waitFor(["second.entered"], "second hostile-observer async command to enter"),
      ]);
      await expect(Promise.all(firings)).resolves.toEqual([
        { block: false, askDowngraded: false, diagnostics: [] },
        { block: false, askDowngraded: false, diagnostics: [] },
      ]);
      first.release("first");
      second.release("second");
      await Promise.all([
        first.waitFor(["first.done"], "first hostile-observer async command to finish"),
        second.waitFor(["second.done"], "second hostile-observer async command to finish"),
        first.waitForAllClosed("first hostile-observer async command to close"),
        second.waitForAllClosed("second hostile-observer async command to close"),
      ]);

      // A distinct warning through the same detached reporting pipeline is the
      // settlement witness for both duplicate warnings; no quiet-period guess
      // is needed before asserting process-wide deduplication.
      await expect(sentinelRunner.fire("UserPromptSubmit", { prompt: "sentinel" })).resolves.toEqual({
        block: false, askDowngraded: false, diagnostics: [],
      });
      await sentinel.waitFor(["sentinel.done"], "observer diagnostic sentinel command to finish");
      await sentinel.waitForAllClosed("observer diagnostic sentinel command to close");
      await waitUntil({
        description: "observer diagnostic sentinel report",
        predicate: () => spy.mock.calls.some((call) =>
          String(call[0]).includes("observer diagnostic sentinel")),
        describeObserved: () => JSON.stringify(spy.mock.calls),
        timeoutMs: 8_000,
      });

      const hostileReports = spy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes("spawn observer failed: unknown error"));
      expect(hostileReports).toHaveLength(1);
      expect(spy.mock.calls.map((call) => String(call[0])).join("\n"))
        .not.toContain("hostile thrown-value content");
      expect(unhandled).toEqual([]);
      expect(first.spawnedChildren().every((spawned) => first.isClosed(spawned))).toBe(true);
      expect(second.spawnedChildren().every((spawned) => second.isClosed(spawned))).toBe(true);
      expect(first.exitCode("first")).toBe(0);
      expect(second.exitCode("second")).toBe(0);
    } finally {
      await first.cleanup("first");
      await second.cleanup("second");
      await sentinel.cleanup("sentinel");
      await Promise.all(firings);
      process.off("unhandledRejection", onUnhandled);
      spy.mockRestore();
    }
  }, 20000);

  it("async: true handlers return while gated and still complete after release", async () => {
    const parent = makeTempDir();
    const child = createHookProcessFixture(parent);
    const { runner } = makeRunner(
      { UserPromptSubmit: [{ hooks: [{
        type: "command", command: child.command, args: ["gate", "async", "ignored-output"], async: true, timeout: 8,
      }] }] },
      { projectDir: parent, env: child.env, onSpawnForTest: child.onSpawnForTest },
    );
    const firing = runner.fire("UserPromptSubmit", { prompt: "hi" });
    try {
      await child.waitFor(["async.entered"], "async hook process to enter");
      const outcome = await firing;
      // fire() settled while the child is observably blocked behind its release.
      expect(child.exists("async.done")).toBe(false);
      expect(outcome).toEqual({ block: false, askDowngraded: false, diagnostics: [] });
      child.release("async");
      await child.waitFor(["async.done"], "released async hook to finish");
      expect(child.exitCode("async")).toBe(0);
      await child.waitForAllClosed("released async hook process to close");
      // Detached settlement after the actual close event must not mutate the
      // already-returned outcome.
      expect(outcome).toEqual({ block: false, askDowngraded: false, diagnostics: [] });
    } finally {
      await child.cleanup("async");
      await firing;
    }
  }, 20000);

  it("keeps gated async exit-2, output, and context excluded after completion", async () => {
    const parent = makeTempDir();
    const child = createHookProcessFixture(parent);
    const { runner } = makeRunner(
      { PreToolUse: [{ hooks: [
        {
          type: "command", command: child.command,
          args: ["gate-block", "denial", "denied"], async: true, timeout: 8,
        },
        {
          type: "command", command: child.command,
          args: ["gate", "context", '{"additionalContext":"nope"}'], async: true, timeout: 8,
        },
      ] }] },
      { projectDir: parent, env: child.env, onSpawnForTest: child.onSpawnForTest },
    );
    const firing = runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    try {
      await child.waitFor(["denial.entered", "context.entered"], "both ignored async hooks to enter");
      const outcome = await firing;
      expect(child.exists("denial.done")).toBe(false);
      expect(child.exists("context.done")).toBe(false);
      expect(outcome).toEqual({ block: false, askDowngraded: false, diagnostics: [] });

      child.release("denial", "context");
      await child.waitFor(["denial.done", "context.done"], "ignored async hooks to exit");
      expect(child.exitCode("denial")).toBe(2);
      expect(child.exitCode("context")).toBe(0);
      expect(child.read("denial.stderr")).toBe("denied");
      expect(child.read("context.stdout")).toBe('{"additionalContext":"nope"}');
      await child.waitForAllClosed("ignored async hook processes to close");
      expect(outcome).toEqual({ block: false, askDowngraded: false, diagnostics: [] });
      expect(outcome.additionalContext).toBeUndefined();
      expect(outcome.stdout).toBeUndefined();
    } finally {
      await child.cleanup("denial", "context");
      await firing;
    }
  }, 20000);

  it("dedupes detached setup diagnostics before an observable sentinel report", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { runner } = makeRunner({
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi", async: true }] }],
      });
      // Pre-poison bash resolution to produce the same setup failure twice.
      (runner as unknown as { bashPath: string | null }).bashPath = null;
      await runner.fire("UserPromptSubmit", { prompt: "first" });
      await runner.fire("UserPromptSubmit", { prompt: "duplicate" });

      // A distinct failure goes through the same detached reporting chain. Its
      // report is the settlement witness for both earlier already-resolved runs.
      const { runner: sentinelRunner } = makeRunner({
        Stop: [{ hooks: [{ type: "http", url: "not-a-valid-hook-url", async: true }] }],
      });
      await sentinelRunner.fire("Stop", {});
      const asyncReports = () => spy.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.startsWith("[picc] async hook:"));
      await waitUntil({
        description: "distinct sentinel async diagnostic",
        predicate: () => asyncReports().some((message) => message.includes("not-a-valid-hook-url")),
        describeObserved: () => JSON.stringify(asyncReports()),
        timeoutMs: 8_000,
      });
      const duplicateReports = asyncReports().filter((message) => /bash not found/i.test(message));
      expect(duplicateReports).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  }, 15000);

  it("a settings-sourced async hook returns before release and eventually completes", async () => {
    const base = makeTempDir();
    const userDir = path.join(base, "userhome", ".claude");
    const projectRoot = path.join(base, "project");
    const child = createHookProcessFixture(base);
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{
        type: "command", command: child.command, args: ["gate", "settings"], async: true, timeout: 8,
      }] }] },
    }), "utf8");
    const settings = loadSettings({ cwd: projectRoot, projectRoot, userDir, managedPaths: [] });
    expect(settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.async).toBe(true);
    const runner = new HookRunner({
      config: settings.hooks,
      projectDir: projectRoot,
      sessionId: "sess-settings-async",
      env: child.env,
      disableAllHooks: false,
      onSpawnForTest: child.onSpawnForTest,
    });
    const firing = runner.fire("UserPromptSubmit", { prompt: "hi" });
    try {
      await child.waitFor(["settings.entered"], "settings-sourced async hook to enter");
      const outcome = await firing;
      expect(child.exists("settings.done")).toBe(false);
      expect(outcome).toEqual({ block: false, askDowngraded: false, diagnostics: [] });
      child.release("settings");
      await child.waitFor(["settings.done"], "settings-sourced async hook to finish");
      expect(child.exitCode("settings")).toBe(0);
      await child.waitForAllClosed("settings-sourced async hook process to close");
      expect(outcome).toEqual({ block: false, askDowngraded: false, diagnostics: [] });
    } finally {
      await child.cleanup("settings");
      await firing;
    }
  }, 20000);
});

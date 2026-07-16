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

describe("HookRunner async hooks (C5)", () => {
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

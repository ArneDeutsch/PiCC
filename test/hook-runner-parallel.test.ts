import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseHookConfig } from "../src/claude/hooks.js";
import { loadSettings } from "../src/discovery/settings.js";
import { HookRunner } from "../src/engine/hook-runner.js";

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
  overrides: { projectDir?: string; env?: Record<string, string> } = {},
): { runner: HookRunner; projectDir: string } {
  const projectDir = overrides.projectDir ?? makeTempDir();
  const runner = new HookRunner({
    config: parseHookConfig(rawHooks, "<test>").config,
    projectDir,
    sessionId: "sess-par-1",
    env: overrides.env ?? {},
    disableAllHooks: false,
  });
  return { runner, projectDir };
}

/** Polls until `check` passes or the deadline expires. */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

describe("HookRunner parallel execution (C4)", () => {
  it("runs matching handlers concurrently, not serially", async () => {
    // Two 1.2s sleeps: serial would take >= 2.4s; parallel stays well under.
    const { runner } = makeRunner({
      UserPromptSubmit: [{ hooks: ["sleep 1.2"] }, { hooks: ["sleep 1.2 && true"] }],
    });
    const start = Date.now();
    const outcome = await runner.fire("UserPromptSubmit", { prompt: "hi" });
    const elapsed = Date.now() - start;
    expect(outcome.block).toBe(false);
    expect(elapsed).toBeLessThan(2300);
  }, 15000);

  it("merges outcomes in CONFIG order regardless of completion order", async () => {
    // The first hook finishes LAST; config order must still win.
    const slowFirst = `sleep 0.8; echo '{"additionalContext":"ctx-first"}'`;
    const fastSecond = `echo '{"additionalContext":"ctx-second"}'`;
    const { runner } = makeRunner({
      UserPromptSubmit: [{ hooks: [slowFirst] }, { hooks: [fastSecond] }],
    });
    const outcome = await runner.fire("UserPromptSubmit", { prompt: "hi" });
    expect(outcome.additionalContext).toBe("ctx-first\nctx-second");
  }, 15000);

  it("first block wins in config order even when a later hook blocks sooner", async () => {
    const slowBlock = `sleep 0.8; echo config-first-reason >&2; exit 2`;
    const fastBlock = `echo config-second-reason >&2; exit 2`;
    const { runner } = makeRunner({
      PreToolUse: [{ hooks: [slowBlock] }, { hooks: [fastBlock] }],
    });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.block).toBe(true);
    expect(outcome.blockReason).toBe("config-first-reason");
  }, 15000);

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
  it("async: true handlers return immediately and still execute in the background", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      {
        UserPromptSubmit: [
          {
            hooks: [
              { type: "command", command: `sleep 1.5; echo done >> "$MARKER"`, async: true },
            ],
          },
        ],
      },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    const start = Date.now();
    const outcome = await runner.fire("UserPromptSubmit", { prompt: "hi" });
    expect(Date.now() - start).toBeLessThan(1200);
    // Excluded from outcome merging: no stdout/context/diagnostics from it.
    expect(outcome.stdout).toBeUndefined();
    expect(outcome.block).toBe(false);
    expect(outcome.diagnostics).toHaveLength(0);
    // ... but the hook itself still runs to completion in the background.
    expect(await waitFor(() => fs.existsSync(marker), 10_000)).toBe(true);
  }, 15000);

  it("an async hook's exit code and output are ignored (no block, no context)", async () => {
    const { runner } = makeRunner({
      PreToolUse: [
        {
          hooks: [
            { type: "command", command: "echo denied >&2; exit 2", async: true },
            { type: "command", command: `echo '{"additionalContext":"nope"}'`, async: true },
          ],
        },
      ],
    });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.block).toBe(false);
    expect(outcome.additionalContext).toBeUndefined();
  });

  it("surfaces async handler setup failures via console.error once per distinct message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { runner } = makeRunner({
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo hi", async: true }] }],
      });
      // Simulate an unresolvable shell: pre-poison the cached bash resolution
      // (the "not found" sentinel) so the command handler cannot spawn.
      (runner as unknown as { bashPath: string | null }).bashPath = null;
      await runner.fire("UserPromptSubmit", { prompt: "hi" });
      await runner.fire("UserPromptSubmit", { prompt: "again" });
      const asyncReports = () =>
        spy.mock.calls.filter((c) => String(c[0]).startsWith("[picc] async hook:"));
      // The detached chains settle asynchronously.
      expect(await waitFor(() => asyncReports().length > 0, 5000)).toBe(true);
      await new Promise((r) => setTimeout(r, 200)); // let any duplicate land
      expect(asyncReports()).toHaveLength(1);
      expect(String(asyncReports()[0]![0])).toMatch(/bash not found/i);
    } finally {
      spy.mockRestore();
    }
  }, 15000);

  it("a settings-sourced async: true hook reaches the runner intact and does not block fire()", async () => {
    const base = makeTempDir();
    const userDir = path.join(base, "userhome", ".claude");
    const projectRoot = path.join(base, "project");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "sleep 3", async: true }] }],
        },
      }),
      "utf8",
    );
    const settings = loadSettings({ cwd: projectRoot, projectRoot, userDir, managedPaths: [] });
    // Regression: settings normalization used to drop `async`, silently
    // turning fire-and-forget hooks into BLOCKING ones.
    expect(settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.async).toBe(true);

    const runner = new HookRunner({
      config: settings.hooks,
      projectDir: projectRoot,
      sessionId: "sess-settings-async",
      env: {},
      disableAllHooks: false,
    });
    const start = Date.now();
    const outcome = await runner.fire("UserPromptSubmit", { prompt: "hi" });
    expect(Date.now() - start).toBeLessThan(1500);
    expect(outcome.block).toBe(false);
    expect(outcome.diagnostics).toHaveLength(0);
  }, 15000);
});

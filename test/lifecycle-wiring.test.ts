import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc from "../src/index.js";
import { WorktreeManager } from "../src/runtime/worktrees.js";
import { deferred } from "./helpers/async.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";

/**
 * Wired-lifecycle coverage (review finding: zero tests fired after_provider_response,
 * model_select, agent_settled, session_shutdown): quota-header capture, steering
 * re-selection on model switch, the Stop-hook continuation loop incl. its cap,
 * SessionEnd dispatch, PostToolUse block feedback, compaction state reset,
 * and /compat suppression wiring.
 */

let dir: string;
let pi: FakePi;
const originalCwd = process.cwd();
const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-lw-"));
  const w = (rel: string, content: string) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  w("CLAUDE.md", "LW-ROOT-INSTRUCTIONS\n");
  w(".claude/rules/uncond.md", "LW-UNCOND-RULE\n");
  w(".claude/rules/scoped.md", "---\npaths:\n  - src/**\n---\nLW-SCOPED-RULE\n");
  w("src/CLAUDE.md", "LW-NESTED-SRC\n");
  w("src/a.ts", "export {};\n");
  w("src/b.ts", "export {};\n");
  w(
    ".claude/settings.json",
    JSON.stringify({
      permissions: { ask: ["Bash(git push *)"] },
      hooks: {
        SessionStart: ["startup", "resume", "clear", "fork"].map((source) => ({
          matcher: source,
          hooks: [{
            type: "command",
            command: `echo '${source}' >> "$CLAUDE_PROJECT_DIR/.claude/.session-start-log"`,
          }],
        })),
        Stop: [{ hooks: [{ type: "command", command: "echo 'LW-not-done' >&2; exit 2" }] }],
        SessionEnd: [
          {
            hooks: [
              {
                type: "command",
                command: 'echo end >> "$CLAUDE_PROJECT_DIR/.claude/.session-end-log"',
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: "echo 'LW-LINT-ERRORS' >&2; exit 2" }],
          },
        ],
      },
    }),
  );
  w(
    ".claude/.picc/config.json",
    JSON.stringify({ steering: { "steer-model*": "LW-STEERING-ACTIVE" } }),
  );
  w(
    ".claude/skills/limited/SKILL.md",
    "---\ndescription: A skill that must not fetch the web\ndisallowed-tools: WebFetch\n---\nLW-LIMITED-SKILL-BODY\n",
  );

  const userDir = path.join(dir, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);
  pi = fakePi();
  picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
  await pi.waitForInitialization();
  await pi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
});

afterAll(() => {
  process.chdir(originalCwd);
  if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
  else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("lifecycle wiring", () => {
  it("captures real extension initialization synchronously and waits for gated orphan reaping", async () => {
    const originalReapOrphans = WorktreeManager.prototype.reapOrphans;
    const reapGate = deferred<void>();
    let initialization: Promise<void> | undefined;

    WorktreeManager.prototype.reapOrphans = function (...args) {
      const genuineReaping = originalReapOrphans.apply(this, args);
      return reapGate.promise.then(() => genuineReaping);
    };

    try {
      const gatedPi = fakePi();
      picc(gatedPi.api as never, {
        onInitializationSettled: (completion) => {
          initialization = completion;
        },
      });

      // The callback is part of synchronous activation, not a later microtask.
      expect(initialization).toBeDefined();
      let settled = false;
      void initialization!.then(() => (settled = true));

      // Built-ins can finish registering while the independently gated reaper
      // keeps the combined observational completion pending.
      await gatedPi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
      expect(settled).toBe(false);

      reapGate.resolve();
      await initialization;
      expect(settled).toBe(true);
    } finally {
      reapGate.resolve();
      WorktreeManager.prototype.reapOrphans = originalReapOrphans;
      await initialization;
    }
  });

  it("captures quota headers from after_provider_response and reports them in /quota", async () => {
    await pi.fire("after_provider_response", {
      headers: { "x-ratelimit-remaining-tokens": "1234", "content-type": "application/json" },
    });
    pi.entries.length = 0;
    await pi.commands.get("quota").handler("", pi.ctx());
    const out = pi.entries
      .filter((e) => e.customType === "picc-control")
      .map((e) => String(e.data?.output ?? ""))
      .join("\n");
    expect(out).toContain("x-ratelimit-remaining-tokens: 1234");
    expect(out).not.toContain("content-type");
  });

  it("re-selects steering text on model_select (provider-less pattern matches the model id)", async () => {
    await pi.fire("model_select", { model: { provider: "openai", id: "steer-model-1" } });
    const withSteering = (await pi.fire("before_agent_start", { systemPrompt: "B" }))
      .systemPrompt as string;
    expect(withSteering).toContain("LW-STEERING-ACTIVE");

    await pi.fire("model_select", { model: { provider: "openai", id: "other-model" } });
    const without = (await pi.fire("before_agent_start", { systemPrompt: "B" }))
      .systemPrompt as string;
    expect(without).not.toContain("LW-STEERING-ACTIVE");
  });

  it("blocking Stop hook re-prompts via sendUserMessage, capped at 8 continuations", async () => {
    pi.userMessages.length = 0;
    for (let i = 0; i < 9; i++) {
      await pi.fire("agent_settled", {}, pi.ctx());
    }
    const continuations = pi.userMessages.filter((m) => String(m.content).includes("[Stop hook]"));
    expect(continuations.length).toBe(8);
    expect(String(continuations[0]?.content)).toContain("LW-not-done");
  });

  it("resets blocked Stop iteration state when the session is replaced", async () => {
    pi.userMessages.length = 0;
    for (let i = 0; i < 8; i++) await pi.fire("agent_settled", {}, pi.ctx());
    expect(pi.userMessages.filter((m) => String(m.content).includes("[Stop hook]")).length).toBe(8);

    await pi.fire("session_start", { reason: "switch" }, pi.ctx());
    await pi.fire("agent_settled", {}, pi.ctx());
    expect(pi.userMessages.filter((m) => String(m.content).includes("[Stop hook]")).length).toBe(9);
  });

  it("maps Pi 0.80.6 session reasons to Claude SessionStart sources", async () => {
    const log = path.join(dir, ".claude", ".session-start-log");
    fs.rmSync(log, { force: true });
    for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
      await pi.fire("session_start", { reason }, pi.ctx());
    }
    expect(fs.readFileSync(log, "utf8").trim().split(/\r?\n/u)).toEqual([
      "startup", "startup", "clear", "resume", "fork",
    ]);
  });

  it("session_shutdown fires the SessionEnd hook", async () => {
    const log = path.join(dir, ".claude", ".session-end-log");
    fs.rmSync(log, { force: true });
    await pi.fire("session_shutdown", { reason: "other" });
    expect(fs.existsSync(log)).toBe(true);
  });

  it("production session_shutdown joins retained child cleanup before worktree release and SessionEnd", async () => {
    const shutdownPi = fakePi();
    type Seam = NonNullable<Parameters<typeof picc>[1]>;
    let internals!: Parameters<NonNullable<Seam["onWired"]>>[0];
    picc(shutdownPi.api as never, {
      onInitializationSettled: shutdownPi.captureInitialization,
      onWired: (value) => { internals = value; },
    });
    await shutdownPi.waitForInitialization();
    const log = path.join(dir, ".claude", ".session-end-log");
    fs.rmSync(log, { force: true });
    const cleanup = deferred<void>();
    let worktreeReleased = false;
    const agentId = "agent-444444444444";
    const taskId = internals.backgroundTasks.start(
      "agent:reviewer",
      Promise.resolve({
        ok: false, outcome: "failed" as const, finalMessage: "", agentId,
        agentName: "reviewer", checkpointPaused: true, error: "paused",
      }),
      async () => {
        await cleanup.promise;
        worktreeReleased = true;
      },
      agentId,
      "reviewer",
    );
    await internals.backgroundTasks.wait(taskId);
    internals.subagentRegistry.register({
      agentId, agentName: "reviewer", depth: 1, cwd: dir, resumable: true, oneShot: false,
      checkpointPaused: true,
      session: {
        recoverCheckpoint: async () => { throw new Error("unused"); },
        stopCheckpoint: async () => cleanup.promise,
      },
    });

    let shutdownSettled = false;
    const shutdown = shutdownPi.fire("session_shutdown", { reason: "other" })
      .then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(worktreeReleased).toBe(false);
    expect(fs.existsSync(log)).toBe(false);
    expect(internals.backgroundTasks.drainSettlementNotices(() => true, () => {})).toEqual([]);

    cleanup.resolve();
    await shutdown;
    expect(worktreeReleased).toBe(true);
    expect(fs.existsSync(log)).toBe(true);
  });

  it("PostToolUse exit-2 feedback reaches the model in the tool result (lint-and-fix loop)", async () => {
    const result = await pi.fire("tool_result", {
      toolName: "edit",
      toolCallId: "c1",
      input: { path: path.join(dir, "src", "a.ts") },
      content: [{ type: "text", text: "edited ok" }],
      isError: false,
    });
    const text = (result?.content ?? [])
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    expect(text).toContain("[hook blocked]");
    expect(text).toContain("LW-LINT-ERRORS");
  });

  it("compaction resets one-shot injection: nested CLAUDE.md + path rules re-inject on next touch", async () => {
    // First touch: nested CLAUDE.md and the scoped rule inject once.
    pi.messages.length = 0;
    await pi.fire("tool_call", { toolName: "read", toolCallId: "c2", input: { path: path.join(dir, "src", "a.ts") } });
    const first = pi.messages.map((m) => String(m.message.content)).join("\n");
    expect(first).toContain("LW-NESTED-SRC");
    expect(first).toContain("LW-SCOPED-RULE");

    // Second touch pre-compaction: nothing new.
    pi.messages.length = 0;
    await pi.fire("tool_call", { toolName: "read", toolCallId: "c3", input: { path: path.join(dir, "src", "b.ts") } });
    expect(pi.messages.map((m) => String(m.message.content)).join("\n")).not.toContain("LW-NESTED-SRC");

    await pi.fire("session_before_compact", { reason: "threshold" });
    await pi.fire("session_compact", { reason: "threshold" });

    // Root CLAUDE.md + unconditional rules survive via the per-turn suffix.
    const suffix = (await pi.fire("before_agent_start", { systemPrompt: "B" })).systemPrompt as string;
    expect(suffix).toContain("LW-ROOT-INSTRUCTIONS");
    expect(suffix).toContain("LW-UNCOND-RULE");

    // Path-scoped artifacts reload on next relevant access (regression: markers never reset).
    pi.messages.length = 0;
    await pi.fire("tool_call", { toolName: "read", toolCallId: "c4", input: { path: path.join(dir, "src", "b.ts") } });
    const after = pi.messages.map((m) => String(m.message.content)).join("\n");
    expect(after).toContain("LW-NESTED-SRC");
    expect(after).toContain("LW-SCOPED-RULE");
  });

  it("an active skill's disallowed-tools deny via the guard (enforcement)", async () => {
    // Before activation, WebFetch passes.
    const before = await pi.fire("tool_call", {
      toolName: "WebFetch",
      toolCallId: "d1",
      input: { url: "https://example.com" },
    });
    expect(before?.block ?? false).toBe(false);

    await pi.tools.get("Skill").execute("d2", { name: "limited" });

    const after = await pi.fire("tool_call", {
      toolName: "WebFetch",
      toolCallId: "d3",
      input: { url: "https://example.com" },
    });
    expect(after?.block).toBe(true);
    expect(String(after?.reason ?? "")).toContain("disallowed-tools");
  });

  it("/compat suppress persists, silences the startup notice, and /compat show re-enables", async () => {
    const ack = path.join(dir, ".claude", ".picc", "compat-ack.json");
    await pi.commands.get("compat").handler("suppress", pi.ctx());
    expect(fs.existsSync(ack)).toBe(true);

    pi.entries.length = 0;
    pi.notifications.length = 0;
    await pi.fire("session_start", { reason: "startup" }, pi.ctx());
    expect(pi.entries.find((e) => e.customType === "picc-compat")).toBeUndefined();

    await pi.commands.get("compat").handler("show", pi.ctx());
    pi.entries.length = 0;
    await pi.fire("session_start", { reason: "startup" }, pi.ctx());
    // The fixture declares an ask rule, so a notice must reappear once un-suppressed.
    expect(pi.entries.find((e) => e.customType === "picc-compat")).toBeDefined();
  });
});

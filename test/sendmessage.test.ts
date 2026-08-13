import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardSteer, SubagentRegistry } from "../src/runtime/subagent-registry.js";
import { assistantTextFingerprint } from "../src/runtime/subagent-progress.js";
import {
  createAgentToolDefinition,
  createSendMessageToolDefinition,
} from "../src/runtime/subagents.js";
import {
  BackgroundTaskRegistry,
  buildSettlementNotice,
  createTaskOutputTool,
  createTaskStopTool,
} from "../src/runtime/background-tasks.js";
import { mintAgentId } from "../src/util/subagent-transcripts.js";
import {
  fakeSdk,
  makeAgent,
  makeSubagentRuntime,
  useRealSessionManager,
  type FakeSessionState,
} from "./helpers/fake-sdk.js";
import { deferred, waitUntil } from "./helpers/async.js";

// Resume tests exercise the REAL Pi SessionManager (open/restore/append) — inject
// it so fakeSdk's reopenSessionManager reopens real transcripts on disk.
useRealSessionManager(SessionManager);

const AGENT_ID = /^agent-[0-9a-f]{12}$/;
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* OS reaps temp dirs eventually */
    }
  }
});

function tempSessionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-t04-"));
  tempDirs.push(dir);
  return dir;
}

/** A main-session transcript path shaped exactly like Pi's (need not exist). */
function fakeMainSessionFile(dir: string = tempSessionsDir()): string {
  return path.join(dir, "2026-01-01T00-00-00-000Z_0197-main-session.jsonl");
}

type ToolLike = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

// ---------------------------------------------------------------------------
// SubagentRegistry — lifecycle, resolution, name integrity, settlement notice state
// ---------------------------------------------------------------------------

describe("SubagentRegistry", () => {
  function reg(): SubagentRegistry {
    return new SubagentRegistry();
  }
  const base = {
    depth: 1,
    cwd: process.cwd(),
    transcriptPath: "/x/agent.jsonl",
    resumable: true,
    oneShot: false,
  };

  it("resolves an agent by ID and by name", () => {
    const r = reg();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "reviewer", ...base });
    expect(r.resolve(id)).toEqual({ ok: true, record: r.get(id) });
    expect(r.resolve("reviewer")).toEqual({ ok: true, record: r.get(id) });
  });

  it("refuses a name reused for a different live agent, naming the current holder; IDs still work", () => {
    const r = reg();
    const id1 = mintAgentId();
    const id2 = mintAgentId();
    r.register({ agentId: id1, agentName: "reviewer", ...base });
    r.register({ agentId: id2, agentName: "reviewer", ...base });
    const byName = r.resolve("reviewer");
    expect(byName.ok).toBe(false);
    if (!byName.ok) {
      expect(byName.error).toContain(id2); // current holder
      expect(byName.error).toContain(id1); // first binding
      expect(byName.error).toMatch(/ambiguous/i);
    }
    // The IDs always disambiguate.
    expect(r.resolve(id1).ok).toBe(true);
    expect(r.resolve(id2).ok).toBe(true);
  });

  it("refuses unknown addresses (unknown id AND unknown name) with a clean error", () => {
    const r = reg();
    r.register({ agentId: mintAgentId(), agentName: "reviewer", ...base });
    const unknownId = r.resolve("agent-ffffffffffff");
    expect(unknownId.ok).toBe(false);
    const unknownName = r.resolve("nonexistent");
    expect(unknownName.ok).toBe(false);
    if (!unknownName.ok) expect(unknownName.error).toMatch(/Unknown SendMessage address/);
  });

  it("register→markSettled→register (resume) flips state running↔settled and re-arms the settled notice", () => {
    const r = reg();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "reviewer", session: {}, ...base });
    expect(r.get(id)!.state).toBe("running");
    // Still running → no settled notice owed.
    expect(r.consumeSettledNotice(id)).toBe(false);

    r.markSettled(id);
    expect(r.get(id)!.state).toBe("settled");
    expect(r.get(id)!.session).toBeUndefined(); // live handle dropped
    // First settlement notice fires exactly once.
    expect(r.consumeSettledNotice(id)).toBe(true);
    expect(r.consumeSettledNotice(id)).toBe(false);

    // Resume re-registers under the same ID → running again, notice re-armed.
    r.markResuming(id);
    expect(r.get(id)!.state).toBe("running");
    r.register({ agentId: id, agentName: "reviewer", session: {}, ...base });
    expect(r.get(id)!.state).toBe("running");
    r.markSettled(id);
    // The RESUMED settlement emits a fresh notice (swallowing it would recreate
    // the silent-outcome bug class).
    expect(r.consumeSettledNotice(id)).toBe(true);
  });

  it("resolution is registry-only — hostile `to` values never resolve and never touch fs", () => {
    const r = reg();
    r.register({ agentId: mintAgentId(), agentName: "reviewer", ...base });
    for (const hostile of [
      "..",
      "../../etc/passwd",
      "/etc/passwd",
      "C:\\evil",
      "agent-abcdef123456/../x",
      "..\\agent-abcdef123456",
      "\\\\srv\\share",
    ]) {
      const res = r.resolve(hostile);
      expect(res.ok, `must miss ${hostile}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// SubagentRegistry — panel state fields (parent link, timestamps, prompt/final
// text, color, user stop) and the shared steer guard
// ---------------------------------------------------------------------------

describe("SubagentRegistry — panel state fields", () => {
  const ESC = String.fromCharCode(27);
  const base = {
    depth: 1,
    cwd: process.cwd(),
    transcriptPath: "/x/agent.jsonl",
    resumable: true,
    oneShot: false,
  };

  it("captures parentAgentId/description/prompt/color set-once; an enrich re-register never clobbers them", () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    const parent = mintAgentId();
    r.register({
      agentId: id,
      agentName: "reviewer",
      ...base,
      parentAgentId: parent,
      description: "Review auth changes",
      prompt: "check the login flow",
      color: "purple",
    });
    const rec = r.get(id)!;
    expect(rec.parentAgentId).toBe(parent);
    expect(rec.description).toBe("Review auth changes");
    expect(rec.prompt).toBe("check the login flow");
    expect(rec.color).toBe("purple");
    // The enrich/resume re-register (same id) supplies different values — every
    // set-once field keeps its first capture.
    r.register({
      agentId: id,
      agentName: "reviewer",
      ...base,
      parentAgentId: mintAgentId(),
      description: "other label",
      prompt: "a follow-up message",
      color: "red",
    });
    expect(rec.parentAgentId).toBe(parent);
    expect(rec.description).toBe("Review auth changes");
    expect(rec.prompt).toBe("check the login flow");
    expect(rec.color).toBe("purple");
  });

  it("collapses blank-after-sanitize description/prompt to undefined, keeping the truthiness contract", () => {
    // The panel's label fallback (description -> agentName) is a plain
    // truthiness test — pure-escape or whitespace input must store undefined,
    // never "".
    const r = new SubagentRegistry();
    const id = mintAgentId();
    r.register({
      agentId: id,
      agentName: "reviewer",
      ...base,
      description: `${ESC}[31m${ESC}[0m   `,
      prompt: `${ESC}]0;title`,
    });
    const rec = r.get(id)!;
    expect(rec.description).toBeUndefined();
    expect(rec.prompt).toBeUndefined();
  });

  it("startedAt: set at first register, preserved by enrich; markSettled stamps settledAt; markResuming resets startedAt and clears settledAt", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const r = new SubagentRegistry();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "reviewer", ...base });
    expect(r.get(id)!.startedAt).toBe(1_000);
    now.mockReturnValue(2_000);
    r.register({ agentId: id, agentName: "reviewer", session: {}, ...base });
    expect(r.get(id)!.startedAt).toBe(1_000); // enrich preserves
    expect(r.get(id)!.settledAt).toBeUndefined();
    now.mockReturnValue(3_000);
    r.markSettled(id);
    expect(r.get(id)!.settledAt).toBe(3_000);
    now.mockReturnValue(4_000);
    r.markResuming(id);
    // A resumed agent's elapsed time restarts; its settlement stamp clears.
    expect(r.get(id)!.startedAt).toBe(4_000);
    expect(r.get(id)!.settledAt).toBeUndefined();
  });

  it("markResuming synchronously clears every generation-local display field", () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "reviewer", ...base, prompt: "initial task" });
    const details = [{
      kind: "assistant" as const,
      text: "old live answer",
      fingerprint: assistantTextFingerprint(["old live answer"]),
    }];
    r.noteProgress(
      id,
      { tail: ["old progress"], activity: "working…" },
      details,
      { value: { kind: "assistant", text: "old live answer" } },
    );
    expect(r.get(id)!.liveActivity).toEqual({ kind: "assistant", text: "old live answer" });
    r.markSettled(id, {
      outcome: "completed",
      usage: { inputTokens: 12 },
      finalText: `${ESC}[31mthe answer${ESC}[0m\nline two`,
    });
    expect(r.get(id)!.finalText).toBe("the answer\nline two");
    expect(r.get(id)!.liveActivity).toBeUndefined();

    r.markResuming(id);
    const resumed = r.get(id)!;
    expect(resumed).toMatchObject({
      agentId: id,
      agentName: "reviewer",
      prompt: "initial task",
      transcriptPath: base.transcriptPath,
      state: "running",
    });
    for (const field of ["finalText", "outcome", "usage", "progress", "detailLog", "liveActivity", "settledAt"] as const) {
      expect(resumed[field]).toBeUndefined();
    }

    // A resumed generation may emit no progress and settle with no text/usage;
    // nothing from the prior generation is allowed to reappear.
    r.markSettled(id, { outcome: "completed" });
    expect(r.get(id)!.outcome).toBe("completed");
    expect(r.get(id)!.finalText).toBeUndefined();
    expect(r.get(id)!.usage).toBeUndefined();
    expect(r.get(id)!.progress).toBeUndefined();
    expect(r.get(id)!.detailLog).toBeUndefined();
    expect(r.get(id)!.liveActivity).toBeUndefined();
  });

  it("deep-copies structured detail entries when storing them", () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "reviewer", ...base });
    const detail = [{ kind: "tool-call" as const, tool: "Read", detail: "a.ts" }];
    r.noteProgress(id, undefined, detail);
    detail[0]!.tool = "mutated";
    detail.push({ kind: "tool-call", tool: "Write", detail: "b.ts" });
    expect(r.get(id)!.detailLog).toEqual([
      { kind: "tool-call", tool: "Read", detail: "a.ts" },
    ]);
  });

  it("caps prompt (~4 KB) and finalText (~16 KB) at capture", () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "reviewer", ...base, prompt: "p".repeat(10_000) });
    expect(r.get(id)!.prompt!.length).toBeLessThanOrEqual(4_100);
    expect(r.get(id)!.prompt!.length).toBeLessThan(10_000);
    r.markSettled(id, { finalText: "f".repeat(50_000) });
    expect(r.get(id)!.finalText!.length).toBeLessThanOrEqual(16_400);
    expect(r.get(id)!.finalText!.length).toBeLessThan(50_000);
  });

  it("validates color against Claude's fixed color-name set: normalizes case, drops anything off-palette (never stored raw)", () => {
    const r = new SubagentRegistry();
    const good = mintAgentId();
    r.register({ agentId: good, agentName: "a", ...base, color: " Purple " });
    expect(r.get(good)!.color).toBe("purple");
    for (const hostile of [`${ESC}[31mred`, "rebeccapurple", "#ff0000", "red;41", ""]) {
      const id = mintAgentId();
      r.register({ agentId: id, agentName: "b", ...base, color: hostile });
      expect(r.get(id)!.color, `must drop ${JSON.stringify(hostile)}`).toBeUndefined();
    }
  });

  it("markUserStopped is permanent: register() never clears it and markResuming is vetoed", () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "reviewer", ...base });
    r.markSettled(id);
    r.markUserStopped(id);
    expect(r.get(id)!.userStopped).toBe(true);
    // A re-register under the same id does not clear the marker.
    r.register({ agentId: id, agentName: "reviewer", ...base });
    expect(r.get(id)!.userStopped).toBe(true);
    r.markSettled(id);
    // The resume flip refuses: the record stays settled.
    r.markResuming(id);
    expect(r.get(id)!.state).toBe("settled");
  });
});

describe("guardSteer — the shared steer guard", () => {
  const base = {
    depth: 1,
    cwd: process.cwd(),
    transcriptPath: "/x/agent.jsonl",
    resumable: true,
    oneShot: false,
  };

  it("refuses one-shot builtins", () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "Explore", ...base, oneShot: true, session: { steer() {} } });
    const guard = guardSteer(r.get(id)!);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.refusal).toMatch(/one-shot/i);
  });

  it("refuses a user-stopped agent even with a live steerable session", () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "reviewer", ...base, session: { steer() {} } });
    r.markUserStopped(id);
    const guard = guardSteer(r.get(id)!);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.refusal).toMatch(/stopped by the user/i);
  });

  it("refuses a settled record (nothing to steer)", () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "reviewer", ...base });
    r.markSettled(id);
    const guard = guardSteer(r.get(id)!);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.refusal).toMatch(/not running/i);
  });

  it("refuses a waiting record specifically instead of treating missing session as admission", () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "reviewer", ...base });
    r.noteAdmission(id, "waiting");
    const guard = guardSteer(r.get(id)!);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.refusal).toMatch(/waiting for configured concurrency capacity/i);
  });

  it("sanitizes and caps the project-controlled name only in the waiting refusal", () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    const rawName = `hostile\n\u001b[31m${"x".repeat(300)}`;
    r.register({ agentId: id, agentName: rawName, ...base });
    r.noteAdmission(id, "waiting");
    const guard = guardSteer(r.get(id)!);
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.refusal).not.toMatch(/[\n\r\u001b]/u);
      expect(guard.refusal.length).toBeLessThan(300);
      expect(guard.refusal).toContain("waiting for configured concurrency capacity");
    }
    expect(r.get(id)?.agentName).toBe(rawName);
    const resolved = r.resolve(rawName);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.record.agentId).toBe(id);
  });

  it("refuses an admitted running record with no live steerable handle", () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    r.register({ agentId: id, agentName: "reviewer", ...base }); // minimal register: no session yet
    const guard = guardSteer(r.get(id)!);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.refusal).toMatch(/cannot be steered right now/i);
  });

  it("passes a steerable running record and hands back the bound steer entry point", async () => {
    const r = new SubagentRegistry();
    const id = mintAgentId();
    const delivered: string[] = [];
    r.register({
      agentId: id,
      agentName: "reviewer",
      ...base,
      session: {
        steer(text: string) {
          delivered.push(text);
        },
      },
    });
    const guard = guardSteer(r.get(id)!);
    expect(guard.ok).toBe(true);
    if (guard.ok) await Promise.resolve(guard.steer("go left"));
    expect(delivered).toEqual(["go left"]);
  });
});

// ---------------------------------------------------------------------------
// SendMessage tool — steer (running) + refusals
// ---------------------------------------------------------------------------

describe("SendMessage tool — steer + refusals", () => {
  it("describes correction delivery as admitted and steerable only", () => {
    const registry = new SubagentRegistry();
    const runtime = makeSubagentRuntime([makeAgent()], fakeSdk().sdk, { subagentRegistry: registry });
    const tool = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks: new BackgroundTaskRegistry(),
    }) as unknown as { description: string };
    expect(tool.description).toContain("only a still-running, admitted, steerable background subagent");
  });

  it("steers a RUNNING background subagent as a mid-task course correction and acks", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = fakeSdk({ replies: [{ text: "done", gate }] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, { subagentRegistry: registry });
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks,
    }) as unknown as ToolLike;

    const started = await agentTool.execute("t", {
      subagent_type: "reviewer",
      prompt: "long task",
      run_in_background: true,
    });
    const agentId = String(started.details.agentId);
    // Prompt entry proves session creation enriched the registry with the live
    // steerable handle and that this cannot pass in the ack-only window.
    await h.waitForPromptCalls(1);
    expect(registry.get(agentId)?.session).toBeDefined();

    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    const ack = await sm.execute("s", { to: agentId, message: "focus on the auth module" });
    const canonicalAck = structuredClone(ack);
    expect(ack.content[0]!.text).toContain("mid-task course correction");
    expect(ack.details.delivery).toBe("steer");
    expect(ack).toEqual(canonicalAck);

    // The steer reached the live fake session verbatim.
    const session = h.sessions[0]!;
    expect(session.steerMessages).toContain("focus on the auth module");

    release();
    await backgroundTasks.wait(String(started.details.taskId));
    expect(registry.get(agentId)!.state).toBe("settled");
  });

  it("addresses a running agent by NAME too", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = fakeSdk({ replies: [{ text: "done", gate }] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, { subagentRegistry: registry });
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks,
    }) as unknown as ToolLike;
    const started = await agentTool.execute("t", {
      subagent_type: "reviewer",
      prompt: "task",
      run_in_background: true,
    });
    const agentId = String(started.details.agentId);
    // Prompt entry proves the by-name target is a live steerable session.
    await h.waitForPromptCalls(1);
    expect(registry.get(agentId)?.session).toBeDefined();
    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    await sm.execute("s", { to: "reviewer", message: "steer by name" });
    expect(h.sessions[0]!.steerMessages).toContain("steer by name");
    release();
    await backgroundTasks.wait(String(started.details.taskId));
  });

  it("resolves a fresh background dispatch's agent id SYNCHRONOUSLY after the ack — closes the ack-before-register window (coder SHOULD-2)", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = fakeSdk({ replies: [{ text: "done", gate }] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, { subagentRegistry: registry });
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks,
    }) as unknown as ToolLike;

    const started = await agentTool.execute("t", {
      subagent_type: "reviewer",
      prompt: "long task",
      run_in_background: true,
    });
    const agentId = String(started.details.agentId);
    // NO waitUntil: the minimal record exists the INSTANT the ack returns, so a
    // coordinator SendMessaging this id in the SAME turn resolves it. The live
    // session attaches slightly later (enrich-register at session creation).
    const record = registry.get(agentId);
    expect(record).toBeDefined();
    expect(record!.state).toBe("running");
    expect(registry.resolve(agentId).ok).toBe(true);
    expect(registry.resolve("reviewer").ok).toBe(true);

    release();
    await backgroundTasks.wait(String(started.details.taskId));
    // Name-integrity preserved: the SAME record settled (no rebind, no duplicate).
    expect(registry.get(agentId)!.state).toBe("settled");
    expect(registry.ids()).toEqual([agentId]);
  });

  it("a fork/agentOverride dispatch is registered NON-RESUMABLE; SendMessage refuses it by name AND by id with no re-dispatch (no all-tools resume)", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    // getMainSessionFile → the fork WOULD otherwise persist a transcript and look
    // resumable; the registry record is forced non-resumable regardless.
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["forked reply"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      subagentRegistry: registry,
      getMainSessionFile: () => main,
    });
    // Synthetic fork target locked to a narrow toolset — exactly what index.ts's
    // forkDispatch builds for an agent-less context:fork skill.
    const forkOverride = makeAgent({
      name: "fork:my-skill",
      tools: ["Read"],
      disallowedTools: [],
    });
    const result = await runtime.dispatch({
      subagentType: forkOverride.name,
      prompt: "run the skill",
      depth: 1,
      agentOverride: forkOverride,
    });
    // The dispatch persisted (dispatch result may be resumable) but the REGISTRY
    // record — the only thing SendMessage trusts — is forced non-resumable.
    expect(registry.get(result.agentId)!.resumable).toBe(false);
    const createdBefore = h.created.length;

    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    // Refuse by agent id.
    await expect(sm.execute("s", { to: result.agentId, message: "again" })).rejects.toThrow(
      /not resumable/i,
    );
    // Refuse by the synthetic fork:<name> name too (the model CAN address it).
    await expect(sm.execute("s", { to: "fork:my-skill", message: "again" })).rejects.toThrow(
      /not resumable/i,
    );
    // No resumed run occurred: no second createAgentSession — the security hole
    // (re-resolve to all-tools general-purpose) is unreachable.
    expect(h.created.length).toBe(createdBefore);
  });

  it("fails a completed resume when its original named definition disappeared before any worktree/provider activity", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const transcriptPath = fakeMainSessionFile();
    const id = mintAgentId();
    registry.register({
      agentId: id, agentName: "removed-reviewer", depth: 1, cwd: path.dirname(transcriptPath),
      transcriptPath, resumable: true, oneShot: false,
    });
    registry.markSettled(id, { outcome: "completed" });
    let worktreeEntries = 0;
    const h = fakeSdk({ replies: ["must not run"] });
    const runtime = makeSubagentRuntime([], h.sdk, {
      subagentRegistry: registry,
      worktrees: {
        enter: async () => { worktreeEntries += 1; return { ok: false, diagnostics: [] }; },
        exit: async () => ({}),
      },
    });
    const sm = createSendMessageToolDefinition(runtime, { registry, backgroundTasks }) as unknown as ToolLike;
    const accepted = await sm.execute("missing", { to: id, message: "continue" });
    const taskId = String(accepted.details.taskId);
    await backgroundTasks.wait(taskId);
    expect(backgroundTasks.get(taskId)).toMatchObject({ status: "failed" });
    expect(backgroundTasks.get(taskId)?.error).toContain("original agent definition");
    expect(h.created).toHaveLength(0);
    expect(worktreeEntries).toBe(0);
    expect(registry.get(id)).toMatchObject({ state: "settled", outcome: "failed" });
    const retry = await sm.execute("missing-again", { to: id, message: "status after failure" });
    await backgroundTasks.wait(String(retry.details.taskId));
    expect(backgroundTasks.get(String(retry.details.taskId))).toMatchObject({ status: "failed" });
    expect(registry.get(id)).toMatchObject({ state: "settled", outcome: "failed" });
  });

  it("settles resumed admission-policy validation failure immediately and keeps later SendMessage effect-free", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const transcriptPath = fakeMainSessionFile();
    const id = mintAgentId();
    registry.register({
      agentId: id, agentName: "reviewer", depth: 1, cwd: path.dirname(transcriptPath),
      transcriptPath, resumable: true, oneShot: false,
    });
    registry.markSettled(id, { outcome: "completed" });
    const h = fakeSdk({ replies: ["must not run"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      subagentRegistry: registry,
      validateMcpAgent: () => { throw new Error("agent MCP admission context is unavailable"); },
    });
    const sm = createSendMessageToolDefinition(runtime, { registry, backgroundTasks }) as unknown as ToolLike;

    for (const call of ["policy-1", "policy-2"]) {
      const accepted = await sm.execute(call, { to: id, message: "continue" });
      const taskId = String(accepted.details.taskId);
      await backgroundTasks.wait(taskId);
      expect(backgroundTasks.get(taskId)).toMatchObject({ status: "failed" });
      expect(backgroundTasks.get(taskId)?.error).toContain("admission context is unavailable");
      expect(registry.get(id)).toMatchObject({ state: "settled", outcome: "failed" });
    }
    expect(h.created).toHaveLength(0);
  });

  it("completed resume uses the current matching definition/policy and a fresh scope with the original cwd", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const main = fakeMainSessionFile();
    const source = { path: "/project/.claude/agents/reviewer.md", scope: "project" as const };
    const agents = [makeAgent({ name: "reviewer", tools: ["Read"], source })];
    const h = fakeSdk({ replies: ["first", "resumed"] });
    const prepared: Array<{ tools: string[] | undefined; cwd: string; scope: number }> = [];
    const closed: number[] = [];
    let policyVersion = 1;
    const runtime = makeSubagentRuntime(agents, h.sdk, {
      subagentRegistry: registry,
      getMainSessionFile: () => main,
      validateMcpAgent: (agent) => {
        expect(agent.metadata?.policy).toBe(`v${policyVersion}`);
      },
      prepareMcpFor: async (agent, cwd) => {
        const scope = prepared.length + 1;
        prepared.push({ tools: agent.tools, cwd, scope });
        return {
          scope: {
            whenSettled: async () => {}, tools: () => [], resourceServers: () => [], serverStates: () => [],
            diagnostics: () => [], setupOutcomes: () => [], knownToolNames: () => [`mcp__session-v${policyVersion}__tool`],
            borrowedServerNames: () => [`session-v${policyVersion}`], callTool: async () => ({}), readResource: async () => ({}),
            shutdown: async () => { closed.push(scope); return { confirmed: [`scope-${scope}`], unconfirmed: [], diagnostics: [] }; },
            retryUnconfirmedShutdown: async () => ({ confirmed: [], unconfirmed: [], diagnostics: [] }),
          },
          activeOwnedStdioServerNames: () => [],
        };
      },
    });
    agents[0] = { ...agents[0]!, metadata: { policy: "v1" } };
    const first = await runtime.dispatch({ subagentType: "reviewer", prompt: "first", depth: 1 });
    const originalCwd = registry.get(first.agentId)!.cwd;

    policyVersion = 2;
    agents[0] = makeAgent({ name: "reviewer", tools: ["Grep"], source, metadata: { policy: "v2" } });
    const sm = createSendMessageToolDefinition(runtime, { registry, backgroundTasks }) as unknown as ToolLike;
    const accepted = await sm.execute("resume-current", { to: first.agentId, message: "continue" });
    await backgroundTasks.wait(String(accepted.details.taskId));

    expect(prepared).toEqual([
      { tools: ["Read"], cwd: originalCwd, scope: 1 },
      { tools: ["Grep"], cwd: originalCwd, scope: 2 },
    ]);
    expect(closed).toEqual([1, 2]);
    expect(h.created).toHaveLength(2);
    expect(registry.get(first.agentId)).toMatchObject({ state: "settled", outcome: "completed", cwd: originalCwd });
  });

  it("does not fall back to built-in general-purpose when the original authored definition disappears", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const main = fakeMainSessionFile();
    const agents = [makeAgent({ name: "general-purpose", source: { path: "/project/.claude/agents/general-purpose.md", scope: "project" } })];
    const h = fakeSdk({ replies: ["authored done", "must not run"] });
    const runtime = makeSubagentRuntime(agents, h.sdk, {
      subagentRegistry: registry,
      getMainSessionFile: () => main,
    });
    const first = await runtime.dispatch({ subagentType: "general-purpose", prompt: "work", depth: 1 });
    expect(first.resumable).toBe(true);
    agents.splice(0);

    const sm = createSendMessageToolDefinition(runtime, { registry, backgroundTasks }) as unknown as ToolLike;
    const accepted = await sm.execute("resume", { to: first.agentId, message: "continue" });
    const taskId = String(accepted.details.taskId);
    await backgroundTasks.wait(taskId);
    expect(backgroundTasks.get(taskId)?.error).toContain("original agent definition");
    expect(registry.get(first.agentId)?.state).toBe("settled");
    expect(registry.get(first.agentId)?.outcome).toBe("failed");
    expect(h.created).toHaveLength(1);
  });

  it("refuses one-shot builtins (Explore) — never resumed nor steered", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["explored"] });
    const runtime = makeSubagentRuntime([], h.sdk, {
      subagentRegistry: registry,
      getMainSessionFile: () => main,
    });
    const result = await runtime.dispatch({ subagentType: "Explore", prompt: "look", depth: 1 });
    expect(result.resumable).toBe(false);
    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    await expect(sm.execute("s", { to: result.agentId, message: "again" })).rejects.toThrow(
      /one-shot/i,
    );
  });

  it("refuses a non-resumable (in-memory fallback) settled agent as non-resumable", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const h = fakeSdk({ replies: ["done"] });
    // No getMainSessionFile → in-memory fallback → not resumable, no transcript.
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, { subagentRegistry: registry });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.resumable).toBe(false);
    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    await expect(sm.execute("s", { to: result.agentId, message: "follow up" })).rejects.toThrow(
      /not resumable/i,
    );
  });

  it("refuses an unreachable agent naming the missing working directory", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    // Register a settled, resumable record whose cwd no longer exists.
    const id = mintAgentId();
    const goneDir = path.join(os.tmpdir(), "picc-t04-gone-" + mintAgentId());
    registry.register({
      agentId: id,
      agentName: "reviewer",
      depth: 1,
      cwd: goneDir,
      worktreePath: goneDir,
      transcriptPath: path.join(goneDir, "t.jsonl"),
      resumable: true,
      oneShot: false,
    });
    registry.markSettled(id);
    const runtime = makeSubagentRuntime([makeAgent()], fakeSdk().sdk, {
      subagentRegistry: registry,
    });
    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    let msg = "";
    try {
      await sm.execute("s", { to: id, message: "resume" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/unreachable/i);
    // Names the missing path (JSON-escaped in the message).
    expect(msg).toContain(JSON.stringify(goneDir).slice(1, -1));
  });

  it("refuses an unknown address with a clean error", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([makeAgent()], fakeSdk().sdk, {
      subagentRegistry: registry,
    });
    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    await expect(
      sm.execute("s", { to: "agent-ffffffffffff", message: "hi" }),
    ).rejects.toThrow(/Unknown SendMessage address/);
  });

  it("SECURITY: a hostile `to` never reaches the filesystem (registry miss → clean error)", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    // Register one legitimate agent so the registry is non-empty.
    registry.register({
      agentId: mintAgentId(),
      agentName: "reviewer",
      depth: 1,
      cwd: process.cwd(),
      transcriptPath: "/x/t.jsonl",
      resumable: true,
      oneShot: false,
    });
    registry.markSettled(registry.ids()[0]!);
    const h = fakeSdk();
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      subagentRegistry: registry,
    });
    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;

    // NIT-1: spy the whole filesystem-read surface a resume could reach — not just
    // existsSync/readdirSync — plus the SDK's session reopen. A hostile `to` must
    // refuse at registry resolution, before ANY fs access or reopen attempt.
    const existsSpy = vi.spyOn(fs, "existsSync");
    const readdirSpy = vi.spyOn(fs, "readdirSync");
    const readFileSpy = vi.spyOn(fs, "readFileSync");
    const openSpy = vi.spyOn(fs, "openSync");
    const statSpy = vi.spyOn(fs, "statSync");
    const reopenSpy = vi.spyOn(
      h.sdk as unknown as { reopenSessionManager: (...a: unknown[]) => unknown },
      "reopenSessionManager",
    );
    for (const hostile of [
      "..",
      "../../etc/passwd",
      "/etc/passwd",
      "C:\\Windows\\system32",
      "agent-abcdef123456/../reviewer",
      "..\\agent-abcdef123456",
      "\\\\server\\share\\x",
    ]) {
      await expect(
        sm.execute("s", { to: hostile, message: "x" }),
        `must refuse ${hostile}`,
      ).rejects.toThrow();
    }
    // Resolution is pure Map lookups — no filesystem access and no session reopen
    // for any hostile `to`.
    expect(existsSpy).not.toHaveBeenCalled();
    expect(readdirSpy).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(statSpy).not.toHaveBeenCalled();
    expect(reopenSpy).not.toHaveBeenCalled();
    // No session was ever created for a hostile address (no re-dispatch).
    expect(h.created.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Resume — offline integration on the REAL SessionManager (temp dir)
// ---------------------------------------------------------------------------

describe("SendMessage resume — offline integration (real SessionManager)", () => {
  it("resumes a finished subagent in the background under the same ID with prior context + appended transcript; ack is immediate; the resumed settlement re-arms the notice", async () => {
    const main = fakeMainSessionFile();
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    // Scripted usage: prove the compound dispatch→persist→settle→RESUME→
    // usage chain — usage must be captured on the RESUME path, not only fresh
    // dispatch. Both sessions report the same stats here.
    const h = fakeSdk({
      replies: [
        "FIRST REPLY",
        // The resume turn streams a live event so the RESUMED run's registry
        // mirror is observable (plain string replies emit no session events).
        {
          text: "RESUME REPLY",
          events: [
            {
              type: "turn_end",
              message: { role: "assistant", content: [{ type: "text", text: "RESUME REPLY" }] },
            },
          ],
        },
        "SECOND RESUME",
        "THIRD RESUME",
      ],
      stats: { tokens: { input: 30, output: 12, cacheRead: 4 }, cost: 0.05 },
    });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      subagentRegistry: registry,
      getMainSessionFile: () => main,
    });

    // Original dispatch → settled, resumable, transcript on disk, registered.
    const original = await runtime.dispatch({
      subagentType: "reviewer",
      prompt: "ORIGINAL TASK",
      depth: 1,
    });
    expect(original.resumable).toBe(true);
    expect(original.transcriptPath).toBeDefined();
    const agentId = original.agentId;
    expect(registry.get(agentId)!.state).toBe("settled");
    // First settlement notice fires once, then dedupes.
    expect(registry.consumeSettledNotice(agentId)).toBe(true);
    expect(registry.consumeSettledNotice(agentId)).toBe(false);

    // Focused lifecycle correlation fixture: an exact-case `reviewer` background
    // record exposes the same displayed type/stable id through targeted TaskStop
    // and settlement. Its unrelated metadata also supplies non-disclosure sentinels.
    const OUTPUT_SENTINEL = "OUTPUT-SENTINEL-7f94";
    const TRANSCRIPT_SENTINEL = "/transcripts/TRANSCRIPT-SENTINEL-7f94.jsonl";
    const PATH_SENTINEL = "/private/UNRELATED-PATH-SENTINEL-7f94";
    const DIAGNOSTIC_SENTINEL = "DIAGNOSTIC-SENTINEL-7f94";
    const lifecycleTaskId = backgroundTasks.start(
      "agent:reviewer",
      Promise.resolve({
        ok: true,
        outcome: "completed" as const,
        finalMessage: OUTPUT_SENTINEL,
        agentId,
        agentName: "reviewer",
        transcriptPath: TRANSCRIPT_SENTINEL,
        diagnostics: [
          { severity: "warning" as const, message: DIAGNOSTIC_SENTINEL },
          { severity: "info" as const, message: PATH_SENTINEL },
        ],
      }),
      undefined,
      agentId,
      "reviewer",
    );
    const lifecycleRecord = await backgroundTasks.wait(lifecycleTaskId);
    expect(lifecycleRecord).toBeDefined();
    const lifecycleIdentity = `Task(${lifecycleTaskId}) · Agent(reviewer) · ${agentId}`;
    const taskStop = createTaskStopTool(backgroundTasks) as unknown as ToolLike;
    const stopAck = await taskStop.execute("stop", { task_id: lifecycleTaskId });
    expect(stopAck.content[0]!.text.split(lifecycleIdentity)).toHaveLength(2);
    for (const sentinel of [OUTPUT_SENTINEL, TRANSCRIPT_SENTINEL, PATH_SENTINEL, DIAGNOSTIC_SENTINEL]) {
      expect(stopAck.content[0]!.text).not.toContain(sentinel);
    }
    const settlement = buildSettlementNotice(lifecycleRecord!);
    expect(settlement.split(lifecycleIdentity)).toHaveLength(2);
    expect(settlement).toContain(OUTPUT_SENTINEL);
    expect(settlement).toContain(TRANSCRIPT_SENTINEL);
    expect(settlement).not.toContain(PATH_SENTINEL);
    expect(settlement).not.toContain(DIAGNOSTIC_SENTINEL);

    // Collect the original background generation through real TaskOutput. The
    // persisted SendMessage resumes below must create independent delivery state.
    const taskOutput = createTaskOutputTool(backgroundTasks) as unknown as ToolLike;
    expect((await taskOutput.execute("collect-original", { task_id: lifecycleTaskId })).details.status).toBe("completed");
    expect(lifecycleRecord?.settlementDelivery).toBe("collected");

    // SendMessage resume → immediate ack, same ID, flipped back to running.
    const resumedActivities: unknown[] = [];
    registry.onChange(() => {
      const activity = registry.get(agentId)?.liveActivity;
      if (activity) resumedActivities.push({ ...activity });
    });
    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    const ack = await sm.execute("s", { to: agentId, message: "FOLLOW-UP WORK" });
    const taskId = String(ack.details.taskId);
    expect(taskId).not.toBe(lifecycleTaskId);
    const identity = `Task(${taskId}) · Agent(reviewer) · ${agentId}`;
    expect(ack.content[0]!.text.split(identity)).toHaveLength(2);
    expect(ack.content[0]!.text).toContain("resume accepted in background with prior context");
    expect(ack.content[0]!.text).toContain("configured concurrency capacity is available");
    expect(ack.content[0]!.text).toContain(`TaskOutput (task_id "${taskId}")`);
    expect(ack.content[0]!.text).not.toContain("FOLLOW-UP WORK");
    expect(ack.content[0]!.text).not.toContain("ORIGINAL TASK");
    expect(ack.content[0]!.text).not.toContain("FIRST REPLY");
    expect(ack.content[0]!.text).not.toContain("agent:reviewer");
    for (const sentinel of [OUTPUT_SENTINEL, TRANSCRIPT_SENTINEL, PATH_SENTINEL, DIAGNOSTIC_SENTINEL]) {
      expect(ack.content[0]!.text).not.toContain(sentinel);
    }
    expect(ack.content[0]!.text).not.toContain(original.transcriptPath!);
    expect(ack.content[0]!.text).not.toContain(registry.get(agentId)!.cwd);
    expect(ack.details).toEqual({
      agentId,
      agent: "reviewer",
      taskId,
      admission: "admitted",
      description: undefined,
      delivery: "resume",
      resumed: true,
    });
    const canonicalAck = structuredClone(ack);
    expect(ack).toEqual(canonicalAck);
    // Status flipped back to running synchronously (Claude 2.1.205).
    expect(registry.get(agentId)!.state).toBe("running");

    // The resumed run settles in the background under a NEW task but the SAME id.
    const record = await backgroundTasks.wait(taskId);
    expect(record?.status).toBe("completed");
    expect(record?.agentId).toBe(agentId);
    // The resume start() site sets the clean agentType eagerly.
    expect(record?.agentType).toBe("reviewer");
    expect(registry.get(agentId)!.state).toBe("settled");

    // The RESUMED run's usage is captured — on the background
    // task record AND the dispatch registry record under the same id — proving
    // the resume path (not just fresh dispatch) records per-subagent usage.
    const expectedUsage = {
      inputTokens: 30,
      outputTokens: 12,
      cacheReadTokens: 4,
      costUsd: 0.05,
    };
    expect(record?.usage).toEqual(expectedUsage);
    expect(registry.get(agentId)!.usage).toEqual(expectedUsage);

    // The RESUMED run's live-progress mirror worked too: the registry record's
    // last snapshot reflects the resumed generation, proving markResuming
    // re-armed the record to "running" BEFORE the mirror's events fired (the
    // one ordering that keeps noteProgress's running-guard open on resume).
    expect(registry.get(agentId)!.progress?.tail.join("\n")).toContain("RESUME REPLY");
    expect(resumedActivities).toContainEqual({ kind: "status", text: "Working…" });
    expect(registry.get(agentId)!.liveActivity).toBeUndefined();

    // A SECOND createAgentSession happened, seeded from the reopened transcript —
    // prior context is available to the resumed run (SECURITY: from the reopened
    // manager, not a fresh session).
    expect(h.created.length).toBe(2);
    const resumedManager = h.created[1]!.sessionManager as {
      buildSessionContext(): { messages: unknown[] };
    };
    const ctxText = JSON.stringify(resumedManager.buildSessionContext().messages);
    expect(ctxText).toContain("ORIGINAL TASK");
    expect(ctxText).toContain("FIRST REPLY");

    // The transcript was APPENDED (not replaced): one file, all four turns.
    const onDisk = fs.readFileSync(original.transcriptPath!, "utf8");
    expect(onDisk).toContain("ORIGINAL TASK");
    expect(onDisk).toContain("FIRST REPLY");
    expect(onDisk).toContain("FOLLOW-UP WORK");
    expect(onDisk).toContain("RESUME REPLY");

    const select = () => backgroundTasks.drainSettlementNotices(
      (id) => registry.isSettledNoticeArmed(id),
      (id) => registry.consumeSettledNotice(id),
      (id) => registry.get(id) !== undefined,
    );

    // Original collection does not suppress the real SendMessage generation:
    // its uncollected result is selected and delivered exactly once.
    const [firstResumeNotice] = select();
    expect(firstResumeNotice?.content).toContain(taskId);
    expect(firstResumeNotice?.content).toContain("RESUME REPLY");
    firstResumeNotice?.commit();
    expect(select()).toEqual([]);

    // A second real persisted resume is collected through TaskOutput, suppressing
    // only that exact generation.
    const secondAck = await sm.execute("s2", { to: agentId, message: "SECOND FOLLOW-UP" });
    const secondTaskId = String(secondAck.details.taskId);
    await backgroundTasks.wait(secondTaskId);
    expect((await taskOutput.execute("collect-resume", { task_id: secondTaskId })).content[0]?.text).toContain("SECOND RESUME");
    expect(select()).toEqual([]);

    // A third resumed generation remains eligible even when the original task is
    // collected again late: newest-resume-wins and collection is task-local.
    const thirdAck = await sm.execute("s3", { to: agentId, message: "THIRD FOLLOW-UP" });
    const thirdTaskId = String(thirdAck.details.taskId);
    await backgroundTasks.wait(thirdTaskId);
    await taskOutput.execute("late-original", { task_id: lifecycleTaskId });
    const [thirdNotice] = select();
    expect(thirdNotice?.content).toContain(thirdTaskId);
    expect(thirdNotice?.content).toContain("THIRD RESUME");
    thirdNotice?.commit();
    expect(select()).toEqual([]);
  });

  it("SECURITY: the resumed dispatch re-applies the full enforcement stack — identical gated tools, guard + maxTurns extensions, system prompt/lockdown, and preserved depth", async () => {
    const main = fakeMainSessionFile();
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const h = fakeSdk({ replies: ["first", "resumed"] });

    const customCalls: Array<{ depth: number; granted: string[] }> = [];
    const scopedFired: string[] = [];
    const agent = makeAgent({
      name: "reviewer",
      tools: ["Read", "Grep"],
      maxTurns: 5,
      hooks: { Stop: [{ hooks: [{ type: "command", command: "check", raw: {} }] }] },
    });
    const runtime = makeSubagentRuntime([agent], h.sdk, {
      subagentRegistry: registry,
      getMainSessionFile: () => main,
      buildSystemPrompt: (a, depth) => `SYS:${a.name}:depth=${depth}`,
      customToolsFor: (_a, granted, depth) => {
        customCalls.push({ depth, granted: [...granted] });
        return [{ name: "RecordedTool", execute: async () => ({ content: [] }) }];
      },
      makeScopedHookRunner: (() => ({
        fire: async (event: string) => {
          scopedFired.push(event);
          return { block: false, askDowngraded: false, diagnostics: [] };
        },
      })) as never,
    });

    const original = await runtime.dispatch({
      subagentType: "reviewer",
      prompt: "ORIGINAL",
      depth: 1,
    });
    expect(original.resumable).toBe(true);
    // SHOULD-1: snapshot the scoped-hook fire count AFTER the original dispatch so
    // the post-resume assertion proves the RESUMED run fired scoped hooks too — a
    // plain toBeGreaterThan(0) already passes from the original and would miss a
    // "skip scoped hooks on resume" regression.
    const firedAfterOriginal = scopedFired.length;

    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    const ack = await sm.execute("s", { to: original.agentId, message: "RESUME" });
    await backgroundTasks.wait(String(ack.details.taskId));

    // Two dispatches; the second is the resume.
    expect(h.created.length).toBe(2);
    const [c0, c1] = h.created as [Record<string, unknown>, Record<string, unknown>];

    // Identical gated toolset (piBuiltins from tools:[Read,Grep] + the custom tool).
    expect(c1.tools).toEqual(c0.tools);
    expect((c1.customTools as Array<{ name: string }>).map((t) => t.name)).toEqual(
      (c0.customTools as Array<{ name: string }>).map((t) => t.name),
    );

    // Identical guard + maxTurns extensions on the resumed loader.
    const names = (c: Record<string, unknown>) =>
      ((c.resourceLoader as { options: { extensionFactories: Array<{ name: string }> } }).options
        .extensionFactories).map((f) => f.name);
    expect(names(c1)).toEqual(names(c0));
    expect(names(c1)).toEqual(
      expect.arrayContaining(["picc-guard-reviewer", "picc-maxturns-reviewer"]),
    );

    // Identical system prompt + skill/agent lockdown, and PRESERVED depth.
    const spOverride = (c: Record<string, unknown>) =>
      (c.resourceLoader as { options: { systemPromptOverride: () => string } }).options
        .systemPromptOverride();
    expect(spOverride(c1)).toBe(spOverride(c0));
    expect(spOverride(c1)).toBe("SYS:reviewer:depth=1"); // depth preserved on resume
    // SHOULD-2: compare the skill/agent lockdown override RESULTS (not merely that
    // they are functions) — the same identity check applied to systemPromptOverride
    // above — so a resume that swapped in a wider (non-empty) loader lockdown fails.
    for (const key of ["skillsOverride", "agentsFilesOverride", "promptsOverride"] as const) {
      const optC0 = (c0.resourceLoader as { options: Record<string, () => unknown> }).options[key]!;
      const optC1 = (c1.resourceLoader as { options: Record<string, () => unknown> }).options[key]!;
      expect(typeof optC1).toBe("function");
      expect(JSON.stringify(optC1())).toBe(JSON.stringify(optC0()));
    }

    // The gate the shared path enforces got the SAME granted set + depth twice.
    expect(customCalls).toHaveLength(2);
    expect(customCalls[1]).toEqual(customCalls[0]);
    expect(customCalls[1]!.depth).toBe(1);
    expect(customCalls[1]!.granted).toEqual(["Read", "Grep"]);

    // SHOULD-1: the agent-scoped hooks fired for the RESUMED dispatch too — the
    // count strictly GREW past the original's (SubagentStart/Stop re-fired).
    expect(scopedFired.length).toBeGreaterThan(firedAfterOriginal);
  });
});

// ---------------------------------------------------------------------------
// SendMessage resume counts against the nested per-depth bound
// ---------------------------------------------------------------------------

describe("SendMessage resume — nested background bound", () => {
  it("a depth-2 resume ACQUIRES its per-depth budget: it queues behind a held slot and only runs once freed (guards `background: true` on the resume dispatch)", async () => {
    // The narrow-but-real case this protects: a grandchild id resumable at
    // `record.depth >= 2`. The resume dispatch sets `background: true` so it is
    // routed through the per-depth budget instead of the foreground bypass. Remove
    // that flag and `foregroundNested = depth > 1 && !background` becomes true → the
    // dispatch bypasses acquisition and runs immediately, escaping the bound.
    //
    // Deterministic, timer-free signal: dispatch() runs SYNCHRONOUSLY from entry to
    // `await budgetForDepth(depth).acquire()` (no inline await before it). Fire the
    // resume against a depth-2 pool whose only slot is already held → the bounded
    // resume SUSPENDS at that acquire and never reaches the `SubagentStart` hook
    // (which fires only AFTER acquisition). Without the flag it bypasses acquisition
    // and fires `SubagentStart` synchronously during the dispatch call. So a
    // recording `SubagentStart` hook distinguishes the two race-free — no gate-timing
    // guess, no setTimeout.
    const main = fakeMainSessionFile();
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();

    // A SubagentStart fired for the resume dispatch === "the resume acquired its slot
    // and started". Keyed by the resume's verbatim prompt so the seed/holder starts
    // (distinct prompts) never count.
    const subagentStartPrompts: string[] = [];
    const resumeStarted = () => subagentStartPrompts.some((p) => p.includes("RESUME-WORK"));
    const recordingHooks = {
      async fire(eventName: string, payload: Record<string, unknown>) {
        if (eventName === "SubagentStart") subagentStartPrompts.push(String(payload.prompt ?? ""));
        return undefined;
      },
    };

    // The holder parks in onPrompt (still holding its depth-2 slot) until released;
    // the resume records that it reached onPrompt (a second proof it ran).
    const holderEntered = deferred<void>();
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((r) => (releaseHolder = r));
    let resumeReachedOnPrompt = false;
    const resumeEntered = deferred<void>();
    const resumeGate = deferred<void>();
    const h = fakeSdk({
      onPrompt: async (text) => {
        if (text.includes("HOLD-TASK")) {
          holderEntered.resolve();
          await holderGate;
          return "held";
        }
        if (text.includes("RESUME-WORK")) {
          resumeReachedOnPrompt = true;
          resumeEntered.resolve();
          await resumeGate.promise;
          return "resumed";
        }
        return "seeded";
      },
    });

    // concurrency 1 → the depth-2 budget has exactly ONE slot, so a single held
    // dispatch is enough to force the resume to queue.
    const runtime = makeSubagentRuntime(
      [makeAgent({ name: "resumable" }), makeAgent({ name: "holder" })],
      h.sdk,
      {
        subagentRegistry: registry,
        getMainSessionFile: () => main,
        concurrency: 1,
        maxDepth: 2,
        hookRunner: recordingHooks,
      },
    );

    // Seed a RESUMABLE record at depth 2 (foreground → takes the bypass, so it does
    // not consume the depth-2 slot; persists a real transcript → resumable).
    const seed = await runtime.dispatch({
      subagentType: "resumable",
      prompt: "SEED-TASK",
      depth: 2,
    });
    expect(seed.resumable).toBe(true);
    const agentId = seed.agentId;
    expect(registry.get(agentId)!.depth).toBe(2); // the record the resume runs at
    expect(registry.get(agentId)!.state).toBe("settled");

    // Hold the single depth-2 slot with a gated BACKGROUND sibling (it acquires
    // budgetForDepth(2) and parks in onPrompt).
    const holderDispatch = runtime.dispatch({
      subagentType: "holder",
      prompt: "HOLD-TASK",
      depth: 2,
      background: true,
    });
    await waitUntil({
      description: "SendMessage queue holder to enter its gated prompt",
      predicate: () => holderEntered.promise.then(() => true),
      describeObserved: () => `prompt calls: ${h.promptCalls()}`,
    });

    // Resume the depth-2 record. The ack is synchronous; the resumed dispatch runs
    // in the background under the same id at `record.depth` (= 2) with background: true.
    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    const ack = await sm.execute("s", { to: agentId, message: "RESUME-WORK" });
    const taskId = String(ack.details.taskId);

    // GUARD: the resume is QUEUED behind the holder in the depth-2 budget — it has
    // NOT acquired, so it never fired SubagentStart nor reached onPrompt, and its
    // record (flipped to running eagerly by markResuming) has no live session yet.
    // Delete `background: true` from the resume dispatch and this flips: the bypass
    // fires SubagentStart synchronously during the dispatch → resumeStarted() true here.
    expect(resumeStarted()).toBe(false);
    expect(resumeReachedOnPrompt).toBe(false);
    expect(ack.content[0]!.text).toContain("resume accepted in background");
    expect(ack.content[0]!.text).toContain("configured concurrency capacity");
    expect(ack.content[0]!.text).not.toMatch(/\bstarted\b/iu);
    expect(ack.details.admission).toBe("waiting");
    expect(backgroundTasks.get(taskId)?.admission).toBe("waiting");
    expect(registry.get(agentId)).toMatchObject({ state: "running", admission: "waiting" });
    expect(registry.get(agentId)!.session).toBeUndefined();

    const updates: Array<{ content: Array<{ text: string }>; details: Record<string, unknown> }> = [];
    const taskOutput = createTaskOutputTool(backgroundTasks) as unknown as {
      execute(
        id: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: (update: { content: Array<{ text: string }>; details: Record<string, unknown> }) => void,
      ): Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
    };
    const awaiting = taskOutput.execute("await", { task_id: taskId }, undefined, (update) => updates.push(update));
    expect(updates.at(-1)?.details.admission).toBe("waiting");

    // Free the slot, but gate the admitted child before it emits any progress.
    // Both registries and TaskOutput must flip from waiting to admitted/running.
    releaseHolder();
    await holderDispatch;
    await resumeEntered.promise;
    expect(backgroundTasks.get(taskId)?.admission).toBe("admitted");
    expect(registry.get(agentId)?.admission).toBe("admitted");
    expect(updates.at(-1)?.details).toMatchObject({ admission: "admitted", status: "running" });
    expect(updates.at(-1)?.details.subagentProgress).toBeUndefined();
    expect(resumeStarted()).toBe(true);
    expect(resumeReachedOnPrompt).toBe(true);

    resumeGate.resolve();
    const [rec, output] = await Promise.all([backgroundTasks.wait(taskId), awaiting]);
    expect(rec?.status).toBe("completed");
    expect(output.details.status).toBe("completed");
    expect(registry.get(agentId)!.state).toBe("settled");
  });
});

// ---------------------------------------------------------------------------
// User stop — permanent for the agent id; model TaskStop stays resumable
// ---------------------------------------------------------------------------

describe("user stop vs model stop", () => {
  it("a user-stopped RUNNING agent refuses SendMessage steer", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = fakeSdk({ replies: [{ text: "done", gate }] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, { subagentRegistry: registry });
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks,
    }) as unknown as ToolLike;
    const started = await agentTool.execute("t", {
      subagent_type: "reviewer",
      prompt: "task",
      run_in_background: true,
    });
    const agentId = String(started.details.agentId);
    await h.waitForPromptCalls(1);
    expect(registry.get(agentId)?.session).toBeDefined(); // steerable before the stop

    registry.markUserStopped(agentId);
    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    await expect(sm.execute("s", { to: agentId, message: "keep going" })).rejects.toThrow(
      /stopped by the user/i,
    );
    // The refusal happened at the guard: nothing was steered in.
    expect(h.sessions[0]!.steerMessages).toEqual([]);
    release();
    await backgroundTasks.wait(String(started.details.taskId));
  });

  it("a user-stopped SETTLED agent refuses SendMessage resume with no re-dispatch", async () => {
    const main = fakeMainSessionFile();
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const h = fakeSdk({ replies: ["first"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      subagentRegistry: registry,
      getMainSessionFile: () => main,
    });
    const original = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(original.resumable).toBe(true); // would resume, were it not user-stopped
    registry.markUserStopped(original.agentId);
    const createdBefore = h.created.length;
    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    await expect(sm.execute("s", { to: original.agentId, message: "again" })).rejects.toThrow(
      /stopped by the user/i,
    );
    expect(h.created.length).toBe(createdBefore); // no resumed session was created
    expect(registry.get(original.agentId)!.state).toBe("settled");
  });

  it("a MODEL TaskStop leaves the agent resumable: SendMessage resume succeeds afterwards", async () => {
    // The registry-documented PiCC divergence ("PiCC allows resume after
    // TaskStop") — a model stop must NOT trip the permanent user-stop refusal.
    const main = fakeMainSessionFile();
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = fakeSdk({ replies: [{ text: "held", gate }, "resumed"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      subagentRegistry: registry,
      getMainSessionFile: () => main,
    });
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks,
    }) as unknown as ToolLike;
    const started = await agentTool.execute("t", {
      subagent_type: "reviewer",
      prompt: "long task",
      run_in_background: true,
    });
    const taskId = String(started.details.taskId);
    const agentId = String(started.details.agentId);
    await h.waitForPromptCalls(1);

    const taskStop = createTaskStopTool(backgroundTasks) as unknown as ToolLike;
    await taskStop.execute("stop", { task_id: taskId });
    release();
    await backgroundTasks.wait(taskId);
    expect(backgroundTasks.get(taskId)!.status).toBe("stopped");
    expect(backgroundTasks.get(taskId)!.userStopped).toBeUndefined(); // model stop ≠ user stop
    expect(registry.get(agentId)!.state).toBe("settled");
    expect(registry.get(agentId)!.userStopped).toBeUndefined();

    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    const ack = await sm.execute("s", { to: agentId, message: "continue the task" });
    expect(ack.details.delivery).toBe("resume");
    const resumed = await backgroundTasks.wait(String(ack.details.taskId));
    expect(resumed?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Dispatch → registry panel-field plumbing (parent link, description, prompt,
// finalText, color, timestamps)
// ---------------------------------------------------------------------------

describe("dispatch registers the panel fields", () => {
  it("threads parentAgentId (from ownerAgentId) + description into the record synchronously, set-once across the enrich re-register; settle records settledAt + finalText", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const owner = mintAgentId(); // this Agent tool instance "belongs" to a subagent
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = fakeSdk({ replies: [{ text: "the final answer", gate }] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, { subagentRegistry: registry });
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 1,
      backgroundTasks,
      ownerAgentId: owner,
    }) as unknown as ToolLike;
    const started = await agentTool.execute("t", {
      subagent_type: "reviewer",
      prompt: "the initial task",
      run_in_background: true,
      description: "Review auth changes",
    });
    const agentId = String(started.details.agentId);
    // The minimal register already carries the panel fields — available the
    // instant the ack returns.
    const rec = registry.get(agentId)!;
    expect(rec.parentAgentId).toBe(owner);
    expect(rec.description).toBe("Review auth changes");
    expect(rec.prompt).toBe("the initial task");
    expect(rec.startedAt).toBeGreaterThan(0);
    expect(rec.settledAt).toBeUndefined();
    await h.waitForPromptCalls(1); // the enrich re-register has happened
    expect(rec.parentAgentId).toBe(owner); // set-once survived the enrich
    expect(rec.description).toBe("Review auth changes");
    expect(rec.prompt).toBe("the initial task");
    release();
    await backgroundTasks.wait(String(started.details.taskId));
    expect(rec.settledAt).toBeGreaterThanOrEqual(rec.startedAt);
    expect(rec.finalText).toBe("the final answer");
  });

  it("a coordinator dispatch (no ownerAgentId) records no parentAgentId", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const h = fakeSdk({ replies: ["done"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, { subagentRegistry: registry });
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks,
    }) as unknown as ToolLike;
    const started = await agentTool.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    await backgroundTasks.wait(String(started.details.taskId));
    expect(registry.get(String(started.details.agentId))!.parentAgentId).toBeUndefined();
  });

  it("captures a valid agent frontmatter color and drops a hostile one", async () => {
    const registry = new SubagentRegistry();
    const h = fakeSdk({ replies: ["done", "done"] });
    const ESC = String.fromCharCode(27);
    const runtime = makeSubagentRuntime(
      [makeAgent({ name: "tinted", color: "purple" }), makeAgent({ name: "hostile", color: `${ESC}[31mred` })],
      h.sdk,
      { subagentRegistry: registry },
    );
    const tinted = await runtime.dispatch({ subagentType: "tinted", prompt: "p", depth: 1 });
    expect(registry.get(tinted.agentId)!.color).toBe("purple");
    const hostile = await runtime.dispatch({ subagentType: "hostile", prompt: "p", depth: 1 });
    expect(registry.get(hostile.agentId)!.color).toBeUndefined();
  });
});

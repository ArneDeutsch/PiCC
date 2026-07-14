import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentRegistry } from "../src/runtime/subagent-registry.js";
import {
  createAgentToolDefinition,
  createSendMessageToolDefinition,
} from "../src/runtime/subagents.js";
import {
  BackgroundTaskRegistry,
  buildSettlementNotice,
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

// Resume tests exercise the REAL Pi SessionManager (open/restore/append) — inject
// it so fakeSdk's reopenSessionManager reopens real transcripts on disk (t02/t04).
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

async function waitUntil(fn: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// SubagentRegistry — lifecycle, resolution, name integrity, t05 notice state
// ---------------------------------------------------------------------------

describe("SubagentRegistry (t04)", () => {
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
// SendMessage tool — steer (running) + refusals
// ---------------------------------------------------------------------------

describe("SendMessage tool — steer + refusals (t04)", () => {
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
    // Wait until the un-awaited dispatch has created + registered its session.
    // Steer needs the LIVE session handle, which the enrich-register attaches at
    // session creation — later than the minimal ack-window record (coder
    // SHOULD-2). Wait for the handle, not merely the running state.
    await waitUntil(() => registry.get(agentId)?.session !== undefined);

    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    const ack = await sm.execute("s", { to: agentId, message: "focus on the auth module" });
    expect(ack.content[0]!.text).toContain("mid-task course correction");
    expect(ack.details.delivery).toBe("steer");

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
    // Steer needs the LIVE session handle, which the enrich-register attaches at
    // session creation — later than the minimal ack-window record (coder
    // SHOULD-2). Wait for the handle, not merely the running state.
    await waitUntil(() => registry.get(agentId)?.session !== undefined);
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

  it("MUST-FIX #1: a fork/agentOverride dispatch is registered NON-RESUMABLE; SendMessage refuses it by name AND by id with no re-dispatch (no all-tools resume)", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    // getMainSessionFile → the fork WOULD otherwise persist a transcript and look
    // resumable; MUST-FIX #1 forces its registry record non-resumable regardless.
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
    // No resumed run occurred: no second createAgentSession — the SEC #1 hole
    // (re-resolve to all-tools general-purpose) is unreachable.
    expect(h.created.length).toBe(createdBefore);
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

describe("SendMessage resume — offline integration (real SessionManager) (t04)", () => {
  it("resumes a finished subagent in the background under the same ID with prior context + appended transcript; ack is immediate; the resumed settlement re-arms the t05 notice", async () => {
    const main = fakeMainSessionFile();
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    // Scripted usage (FIX 8): prove the compound dispatch→persist→settle→RESUME→
    // usage chain — usage must be captured on the RESUME path, not only fresh
    // dispatch. Both sessions report the same stats here.
    const h = fakeSdk({
      replies: ["FIRST REPLY", "RESUME REPLY"],
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
    // First settlement notice fires once (t05 hand-off), then dedupes.
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

    // SendMessage resume → immediate ack, same ID, flipped back to running.
    const sm = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks,
    }) as unknown as ToolLike;
    const ack = await sm.execute("s", { to: agentId, message: "FOLLOW-UP WORK" });
    const taskId = String(ack.details.taskId);
    expect(taskId).not.toBe(lifecycleTaskId);
    const identity = `Task(${taskId}) · Agent(reviewer) · ${agentId}`;
    expect(ack.content[0]!.text.split(identity)).toHaveLength(2);
    expect(ack.content[0]!.text).toContain("resume started in background with prior context");
    expect(ack.content[0]!.text).toContain("result pending");
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
      delivery: "resume",
      resumed: true,
    });
    // Status flipped back to running synchronously (Claude 2.1.205).
    expect(registry.get(agentId)!.state).toBe("running");

    // The resumed run settles in the background under a NEW task but the SAME id.
    const record = await backgroundTasks.wait(taskId);
    expect(record?.status).toBe("completed");
    expect(record?.agentId).toBe(agentId);
    // F04 t02: the resume start() site sets the clean agentType eagerly.
    expect(record?.agentType).toBe("reviewer");
    expect(registry.get(agentId)!.state).toBe("settled");

    // FIX 8 (t06 × t04): the RESUMED run's usage is captured — on the background
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

    // The resumed settlement emits a FRESH notice (re-armed by the resume).
    expect(registry.consumeSettledNotice(agentId)).toBe(true);
  });

  it("SECURITY (MUST-FIX #1): the resumed dispatch re-applies the full enforcement stack — identical gated tools, guard + maxTurns extensions, system prompt/lockdown, and preserved depth", async () => {
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

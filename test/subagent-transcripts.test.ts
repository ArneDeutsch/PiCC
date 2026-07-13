import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentTrailerLine,
  isAgentId,
  mintAgentId,
  resolveSubagentTranscript,
  subagentSessionDir,
} from "../src/util/subagent-transcripts.js";
import { createAgentToolDefinition, type PiSdk } from "../src/runtime/subagents.js";
import {
  BackgroundTaskRegistry,
  createTaskOutputTool,
} from "../src/runtime/background-tasks.js";
import {
  fakeSdk,
  makeAgent,
  makeSubagentRuntime,
  useRealSessionManager,
  type FakeSessionState,
} from "./helpers/fake-sdk.js";

// These tests exercise the REAL Pi SessionManager (create/flush/open) — inject it
// so fakeSdk's default persistedSessionManager persists to disk. Kept out of a
// static fake-sdk import so builtin-agents' vi.mock factory can't deadlock (t02).
useRealSessionManager(SessionManager);

/**
 * t02 — persisted subagent transcripts + agent IDs: every dispatch leaves a
 * JSONL transcript discoverable from the main session via the hardened
 * resolver; the coordinator receives the agent ID in model-readable text; the
 * dispose→reopen round-trip is proven on the REAL Pi SessionManager.
 */

const AGENT_ID = /^agent-[0-9a-f]{12}$/;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* OS reaps temp dirs eventually */
    }
  }
});

function tempSessionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-t02-"));
  tempDirs.push(dir);
  return dir;
}

/** A main-session transcript path shaped exactly like Pi's (need not exist). */
function fakeMainSessionFile(dir: string = tempSessionsDir()): string {
  return path.join(dir, "2026-01-01T00-00-00-000Z_0197-main-session.jsonl");
}

/** Parse a JSONL transcript into its entries. */
function readEntries(file: string): Array<Record<string, any>> {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

type ToolLike = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

describe("agent IDs and the hardened transcript resolver (t02)", () => {
  it("mints unique, well-formed agent IDs", () => {
    const minted = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = mintAgentId();
      expect(id).toMatch(AGENT_ID);
      expect(isAgentId(id)).toBe(true);
      minted.add(id);
    }
    expect(minted.size).toBe(200);
  });

  it("rejects everything that is not a minted ID: separators, dot-dot, absolute/drive/UNC paths, reserved names", () => {
    const main = fakeMainSessionFile();
    const hostile = [
      "",
      "..",
      "agent-..",
      "a/b",
      "agent-abcdef123456/..",
      "../agent-abcdef123456",
      "..\\agent-abcdef123456",
      "agent-abc\\def123456",
      "/etc/passwd",
      "C:\\evil",
      "C:evil",
      "\\\\srv\\share\\x",
      "CON",
      "NUL",
      "PRN.jsonl",
      "agent-CON",
      "agent-ABCDEF123456", // uppercase — not the minted form
      "agent-abcdef12345", // 11 hex
      "agent-abcdef1234567", // 13 hex
      "agent-abcdef12345g", // non-hex
      "agent-abcdef123456 ", // trailing space
    ];
    for (const id of hostile) {
      expect(() => resolveSubagentTranscript(main, id), `must reject ${JSON.stringify(id)}`).toThrow(
        /Invalid agent id/,
      );
    }
  });

  it("maps a minted ID to its transcript file (undefined before it exists, newest match after)", () => {
    const main = fakeMainSessionFile();
    const id = mintAgentId();
    expect(resolveSubagentTranscript(main, id)).toBeUndefined(); // no dir yet

    const dir = subagentSessionDir(main);
    fs.mkdirSync(dir, { recursive: true });
    expect(resolveSubagentTranscript(main, id)).toBeUndefined(); // empty dir

    fs.writeFileSync(path.join(dir, `2026-01-01T00-00-01-000Z_${id}.jsonl`), "{}\n");
    fs.writeFileSync(path.join(dir, `2026-01-01T00-00-02-000Z_${mintAgentId()}.jsonl`), "{}\n");
    const resolved = resolveSubagentTranscript(main, id);
    expect(resolved).toBe(path.join(dir, `2026-01-01T00-00-01-000Z_${id}.jsonl`));

    // Two transcripts for one ID (create-again edge): the newest wins.
    fs.writeFileSync(path.join(dir, `2026-01-01T00-00-03-000Z_${id}.jsonl`), "{}\n");
    expect(resolveSubagentTranscript(main, id)).toBe(
      path.join(dir, `2026-01-01T00-00-03-000Z_${id}.jsonl`),
    );
  });

  it("derives the subagents directory for Windows-shaped AND posix-shaped main-session paths", () => {
    // Windows drive-letter path — must derive correctly even on a posix host.
    expect(
      subagentSessionDir(
        "C:\\Users\\arne\\.pi\\agent\\sessions\\F--proj\\2026-01-01T00-00-00-000Z_abc.jsonl",
      ),
    ).toBe("C:\\Users\\arne\\.pi\\agent\\sessions\\F--proj\\2026-01-01T00-00-00-000Z_abc.subagents");
    // Posix path — must not be mangled by win32 semantics.
    expect(
      subagentSessionDir("/home/arne/.pi/agent/sessions/proj/2026-01-01T00-00-00-000Z_abc.jsonl"),
    ).toBe("/home/arne/.pi/agent/sessions/proj/2026-01-01T00-00-00-000Z_abc.subagents");
  });

  it("a well-formed ID against a foreign-flavor main-session path returns undefined (no throw)", () => {
    // A Windows-shaped main path on a posix host (or vice versa): the derived
    // subagents dir does not exist, so the resolver returns undefined cleanly —
    // the throw is reserved for a MALFORMED agent id, not a missing directory.
    const id = mintAgentId();
    const winPath =
      "C:\\Users\\arne\\.pi\\agent\\sessions\\F--proj\\2026-01-01T00-00-00-000Z_main.jsonl";
    const posixPath = "/home/arne/.pi/agent/sessions/proj/2026-01-01T00-00-00-000Z_main.jsonl";
    expect(() => resolveSubagentTranscript(winPath, id)).not.toThrow();
    expect(resolveSubagentTranscript(winPath, id)).toBeUndefined();
    expect(() => resolveSubagentTranscript(posixPath, id)).not.toThrow();
    expect(resolveSubagentTranscript(posixPath, id)).toBeUndefined();
  });
});

describe("dispatch persists a transcript (real Pi SessionManager)", () => {
  it("a completed dispatch leaves a JSONL transcript named by the agent ID, discoverable via the resolver", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["the review verdict"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "review it", depth: 1 });

    expect(result.ok).toBe(true);
    expect(result.agentId).toMatch(AGENT_ID);
    expect(result.resumable).toBe(true);
    expect(result.transcriptPath).toBeDefined();
    expect(path.dirname(path.resolve(result.transcriptPath!))).toBe(
      path.resolve(subagentSessionDir(main)),
    );
    expect(path.basename(result.transcriptPath!)).toContain(`_${result.agentId}.jsonl`);
    expect(fs.existsSync(result.transcriptPath!)).toBe(true);

    // The transcript carries the run: Pi session header (id = agent ID) + turns.
    const entries = readEntries(result.transcriptPath!);
    const header = entries.find((e) => e.type === "session");
    expect(header?.id).toBe(result.agentId);
    const messages = entries.filter((e) => e.type === "message").map((e) => e.message);
    expect(messages.some((m) => m.role === "user" && String(m.content).includes("review it"))).toBe(
      true,
    );
    expect(JSON.stringify(messages)).toContain("the review verdict");

    // The exported resolver maps the ID back to exactly this file.
    const resolved = resolveSubagentTranscript(main, result.agentId);
    expect(path.resolve(resolved!)).toBe(path.resolve(result.transcriptPath!));
  });

  it("parallel dispatches get distinct IDs and distinct transcripts under one main session", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["one", "two"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const [r1, r2] = await Promise.all([
      runtime.dispatch({ subagentType: "reviewer", prompt: "a", depth: 1 }),
      runtime.dispatch({ subagentType: "reviewer", prompt: "b", depth: 1 }),
    ]);
    expect(r1.agentId).not.toBe(r2.agentId);
    expect(r1.transcriptPath).not.toBe(r2.transcriptPath);
    expect(path.resolve(resolveSubagentTranscript(main, r1.agentId)!)).toBe(
      path.resolve(r1.transcriptPath!),
    );
    expect(path.resolve(resolveSubagentTranscript(main, r2.agentId)!)).toBe(
      path.resolve(r2.transcriptPath!),
    );
  });

  it("dispose→reopen round-trip: the transcript reopens with the prior messages intact and accepts appends", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["first answer"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "the task", depth: 1 });
    expect(result.resumable).toBe(true);
    // dispatch() disposed the session in its finally — reopen from disk alone.
    const reopened = SessionManager.open(result.transcriptPath!);
    expect(reopened.getSessionId()).toBe(result.agentId);
    const ctx = reopened.buildSessionContext();
    const texts = JSON.stringify(ctx.messages);
    expect(ctx.messages.length).toBeGreaterThanOrEqual(2);
    expect(texts).toContain("the task");
    expect(texts).toContain("first answer");

    // Resume-append (t04's write path): append through the reopened manager,
    // reopen AGAIN, and see all four messages — proving the file stays a valid,
    // appendable Pi session across close/reopen cycles.
    reopened.appendMessage({ role: "user", content: "follow-up question" } as never);
    reopened.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "follow-up answer" }],
      stopReason: "stop",
    } as never);
    const third = SessionManager.open(result.transcriptPath!);
    const resumed = third.buildSessionContext();
    expect(resumed.messages.length).toBe(ctx.messages.length + 2);
    expect(JSON.stringify(resumed.messages)).toContain("follow-up answer");
  });

  it("a failed run's transcript persists too (partial work is inspectable) and stays resumable", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({
      onPrompt: (_text, session: FakeSessionState) => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "half the work" }],
          stopReason: "toolUse",
        });
        session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "429 quota exceeded",
        });
      },
    });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.outcome).toBe("failed");
    expect(result.resumable).toBe(true);
    expect(fs.existsSync(result.transcriptPath!)).toBe(true);
    expect(fs.readFileSync(result.transcriptPath!, "utf8")).toContain("half the work");
  });

  it("built-in Explore/Plan persist a transcript but are flagged non-resumable; a project agent named Explore is resumable", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["explored", "planned", "project-explored"] });
    const runtime = makeSubagentRuntime([], h.sdk, { getMainSessionFile: () => main });
    const explore = await runtime.dispatch({ subagentType: "Explore", prompt: "look", depth: 1 });
    expect(explore.ok).toBe(true);
    expect(explore.resumable).toBe(false); // one-shot builtin
    expect(explore.agentId).toMatch(AGENT_ID); // still identified…
    expect(fs.existsSync(explore.transcriptPath!)).toBe(true); // …and observable

    const plan = await runtime.dispatch({ subagentType: "Plan", prompt: "plan", depth: 1 });
    expect(plan.resumable).toBe(false);

    // A same-named PROJECT agent overrides the builtin and is a normal agent.
    const projectRuntime = makeSubagentRuntime([makeAgent({ name: "Explore" })], h.sdk, {
      getMainSessionFile: () => main,
    });
    const overridden = await projectRuntime.dispatch({
      subagentType: "Explore",
      prompt: "look",
      depth: 1,
    });
    expect(overridden.resumable).toBe(true);
  });

  it("a caller-provided agent ID is reused verbatim (stability across resumes, t04)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["ok"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const result = await runtime.dispatch({
      subagentType: "reviewer",
      prompt: "p",
      depth: 1,
      agentId: "agent-aabbccddeeff",
    });
    expect(result.agentId).toBe("agent-aabbccddeeff");
    expect(path.basename(result.transcriptPath!)).toContain("_agent-aabbccddeeff.jsonl");
  });

  it("a hostile/malformed caller-provided agent ID fails the dispatch loudly (pre-t04 hardening)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["should never run"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    for (const hostile of ["../evil", "agent-../x", "agent-ABCDEF123456", "agent-xyz"]) {
      const result = await runtime.dispatch({
        subagentType: "reviewer",
        prompt: "p",
        depth: 1,
        agentId: hostile,
      });
      expect(result.ok, `must reject ${hostile}`).toBe(false);
      expect(result.outcome).toBe("failed");
      expect(result.resumable).toBe(false);
      expect(result.error).toContain(JSON.stringify(hostile));
      // Never minted-over-and-run, never passed through to disk.
      expect(result.transcriptPath).toBeUndefined();
    }
    // The session is never even created for a rejected id.
    expect(h.sessions).toHaveLength(0);
  });

  it("degrades to in-memory with a diagnostic when the main session file is unknown (print/no-session edge)", async () => {
    const h = fakeSdk({ replies: ["still works"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk); // no getMainSessionFile
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true); // dispatch MUST succeed
    expect(result.finalMessage).toBe("still works");
    expect(result.resumable).toBe(false);
    expect(result.transcriptPath).toBeUndefined();
    expect(
      result.diagnostics.some(
        (d) => d.severity === "info" && d.message.includes("not persisted"),
      ),
    ).toBe(true);
  });

  it("degrades to in-memory with a WARNING when transcript creation itself fails", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["survived"] });
    const sdk: PiSdk = {
      ...h.sdk,
      persistedSessionManager: () => {
        throw new Error("disk full (simulated)");
      },
    };
    const runtime = makeSubagentRuntime([makeAgent()], sdk, { getMainSessionFile: () => main });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.finalMessage).toBe("survived");
    expect(result.resumable).toBe(false);
    expect(result.transcriptPath).toBeUndefined();
    expect(
      result.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("disk full (simulated)"),
      ),
    ).toBe(true);
  });

  it("degrades with a diagnostic when the SDK lacks persistedSessionManager entirely", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["legacy sdk ok"] });
    const sdk: PiSdk = { ...h.sdk, persistedSessionManager: undefined };
    const runtime = makeSubagentRuntime([makeAgent()], sdk, { getMainSessionFile: () => main });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.resumable).toBe(false);
    expect(result.diagnostics.some((d) => d.message.includes("unavailable in this SDK"))).toBe(true);
  });
});

describe("model-visible agent-ID delivery (t02)", () => {
  it("foreground content of a RESUMABLE agent = verbatim message + delimited ID trailer", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["```yaml\nverdict: approve\n```"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "p" });
    const text = res.content[0]!.text;
    const agentId = String(res.details.agentId);
    expect(agentId).toMatch(AGENT_ID);
    // Verbatim message first, then the clearly delimited harness trailer.
    expect(text.startsWith("```yaml\nverdict: approve\n```")).toBe(true);
    expect(text.endsWith(`\n\n---\n[agent ${agentId} completed — resumable via SendMessage]`)).toBe(
      true,
    );
    expect(text).toBe(
      "```yaml\nverdict: approve\n```" +
        `\n\n---\n${agentTrailerLine(agentId, { completed: true })}`,
    );
    // details carries the structured copy for logs/UI.
    expect(res.details.resumable).toBe(true);
    expect(String(res.details.transcriptPath)).toContain(agentId);
  });

  it("no trailer for one-shot builtins (Explore) — the content stays fully verbatim", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["EXPLORE-FINDINGS"] });
    const runtime = makeSubagentRuntime([], h.sdk, { getMainSessionFile: () => main });
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "Explore", prompt: "p" });
    expect(res.content[0]!.text).toBe("EXPLORE-FINDINGS");
    expect(res.details.resumable).toBe(false);
  });

  it("no trailer for the in-memory fallback — non-resumable IDs are never advertised", async () => {
    const h = fakeSdk({ replies: ["plain answer"] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk); // in-memory fallback
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "p" });
    expect(res.content[0]!.text).toBe("plain answer");
    expect(res.details.resumable).toBe(false);
  });

  it("the cut-off path (failed with partial output) carries the ID inside the delimited frame", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({
      onPrompt: (_text, session: FakeSessionState) => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "half a review" }],
          stopReason: "toolUse",
        });
        session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "503 died",
        });
      },
    });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "p" });
    const text = res.content[0]!.text;
    const agentId = String(res.details.agentId);
    expect(text.startsWith("half a review")).toBe(true);
    expect(text).toContain("[subagent cut off]");
    expect(text.endsWith(`\n[agent ${agentId} — resumable via SendMessage]`)).toBe(true);
    expect(res.details.cutOff).toBe(true);
  });

  it("background start message and TaskOutput both carry the agent ID", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["BG-VERBATIM-RESULT"] });
    const registry = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await tool.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    const agentId = String(started.details.agentId);
    expect(agentId).toMatch(AGENT_ID);
    // The start message is the model-visible channel for background dispatches.
    expect(started.content[0]!.text).toContain(`agent id: ${agentId}`);

    const taskId = String(started.details.taskId);
    const record = await registry.wait(taskId);
    expect(record?.agentId).toBe(agentId); // pre-minted ID matches the settled result
    expect(record?.resumable).toBe(true);
    expect(String(record?.transcriptPath)).toContain(agentId);

    const out = await (createTaskOutputTool(registry) as unknown as ToolLike).execute("t2", {
      task_id: taskId,
    });
    const text = out.content[0]!.text;
    expect(text.startsWith("BG-VERBATIM-RESULT")).toBe(true);
    expect(text.endsWith(`\n\n---\n[agent ${agentId} completed — resumable via SendMessage]`)).toBe(
      true,
    );
    expect(out.details.agentId).toBe(agentId);
  });

  it("TaskOutput of a failed-but-resumable background task carries the ID after the failure text", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({
      onPrompt: (_text, session: FakeSessionState) => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "progress so far" }],
          stopReason: "toolUse",
        });
        session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "500 exploded",
        });
      },
    });
    const registry = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await tool.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    const agentId = String(started.details.agentId);
    const taskId = String(started.details.taskId);
    await registry.wait(taskId);
    const out = await (createTaskOutputTool(registry) as unknown as ToolLike).execute("t2", {
      task_id: taskId,
    });
    expect(out.details.status).toBe("failed");
    expect(out.content[0]!.text).toContain("500 exploded");
    expect(out.content[0]!.text).toContain(`[agent ${agentId} — resumable via SendMessage]`);
  });

  it("a NON-resumable failed-with-partial (cut-off) foreground run shows the cut-off but no resume channel", async () => {
    // In-memory fallback (no getMainSessionFile) → non-resumable, WITH partial
    // output: the tool takes the cut-off-with-partial path but must NOT advertise
    // a resume channel (guards the `resumable ? … : …` gate against a flip).
    const h = fakeSdk({
      onPrompt: (_text, session: FakeSessionState) => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "half a review" }],
          stopReason: "toolUse",
        });
        session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "503 died",
        });
      },
    });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk); // in-memory fallback
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "p" });
    const text = res.content[0]!.text;
    expect(res.details.outcome).toBe("failed");
    expect(res.details.resumable).toBe(false);
    expect(text).toContain("half a review");
    expect(text).toContain("[subagent cut off]");
    expect(text).not.toContain("resumable via SendMessage");
  });

  it("a NON-resumable failed-with-partial background task reports failed with no resume channel", async () => {
    // Same as above via the background path (createTaskOutputTool): guards the
    // `if (task.resumable && task.agentId)` gate in background-tasks.ts.
    const h = fakeSdk({
      onPrompt: (_text, session: FakeSessionState) => {
        session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "progress so far" }],
          stopReason: "toolUse",
        });
        session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "500 exploded",
        });
      },
    });
    const registry = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk); // in-memory fallback
    const tool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await tool.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    const taskId = String(started.details.taskId);
    await registry.wait(taskId);
    const out = await (createTaskOutputTool(registry) as unknown as ToolLike).execute("t2", {
      task_id: taskId,
    });
    expect(out.details.status).toBe("failed");
    expect(out.details.resumable).toBe(false);
    expect(out.content[0]!.text).toContain("failed");
    expect(out.content[0]!.text).toContain("500 exploded");
    expect(out.content[0]!.text).not.toContain("resumable via SendMessage");
  });

  it("a resumable FAILED-with-no-partial run delivers the agent ID in the thrown error; a non-resumable one does not", async () => {
    const failNoPartial = () =>
      fakeSdk({
        onPrompt: (_t: string, s: FakeSessionState) => {
          // Terminal error with NO assistant text produced → empty finalMessage,
          // so the tool takes the throw path (not the cut-off-with-partial path).
          s.messages.push({
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "429 dead",
          });
        },
      });

    // Resumable (persisted): the thrown error ends with the non-completed trailer.
    const main = fakeMainSessionFile();
    const runtimeR = makeSubagentRuntime([makeAgent()], failNoPartial().sdk, {
      getMainSessionFile: () => main,
    });
    const toolR = createAgentToolDefinition(runtimeR, { depth: 0 }) as unknown as ToolLike;
    let resumableMsg = "";
    try {
      await toolR.execute("t", { subagent_type: "reviewer", prompt: "p" });
    } catch (e) {
      resumableMsg = (e as Error).message;
    }
    expect(resumableMsg).toContain("API error");
    expect(resumableMsg).toMatch(
      /\n\n---\n\[agent agent-[0-9a-f]{12} — resumable via SendMessage\]$/,
    );

    // Non-resumable (in-memory fallback): the failure names its cause but never
    // advertises a resume channel.
    const runtimeN = makeSubagentRuntime([makeAgent()], failNoPartial().sdk); // no getMainSessionFile
    const toolN = createAgentToolDefinition(runtimeN, { depth: 0 }) as unknown as ToolLike;
    let nonResumableMsg = "";
    try {
      await toolN.execute("t", { subagent_type: "reviewer", prompt: "p" });
    } catch (e) {
      nonResumableMsg = (e as Error).message;
    }
    expect(nonResumableMsg).toContain("API error");
    expect(nonResumableMsg).not.toContain("resumable via SendMessage");
  });

  it("a truncated COMPLETED run rides the ID trailer INSIDE the single cut-off frame (no double ---)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: [{ text: "partial answer", stopReason: "length" }] });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "p" });
    const text = res.content[0]!.text;
    const agentId = String(res.details.agentId);
    expect(res.details.outcome).toBe("completed");
    expect(text).toContain("[subagent cut off]");
    // Exactly ONE `---` frame; the trailer is an extra line inside it.
    expect(text.split("\n\n---\n")).toHaveLength(2);
    expect(text.endsWith(`\n[agent ${agentId} — resumable via SendMessage]`)).toBe(true);
    expect(text).not.toContain(`\n\n---\n[agent ${agentId}`);
  });

  it("a truncated COMPLETED background task rides the trailer inside the single frame too", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: [{ text: "bg partial", stopReason: "length" }] });
    const registry = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await tool.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    const agentId = String(started.details.agentId);
    const taskId = String(started.details.taskId);
    await registry.wait(taskId);
    const out = await (createTaskOutputTool(registry) as unknown as ToolLike).execute("t2", {
      task_id: taskId,
    });
    const text = out.content[0]!.text;
    expect(out.details.status).toBe("completed");
    expect(text).toContain("[subagent cut off]");
    expect(text.split("\n\n---\n")).toHaveLength(2);
    expect(text.endsWith(`\n[agent ${agentId} — resumable via SendMessage]`)).toBe(true);
  });

  it("a one-shot builtin (Explore) background start message NOW includes the agent id (F04 t02); a resumable one keeps it", async () => {
    const main = fakeMainSessionFile();
    const registry = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([], fakeSdk({ replies: ["explored"] }).sdk, {
      getMainSessionFile: () => main,
    });
    const tool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await tool.execute("t", {
      subagent_type: "Explore",
      prompt: "look",
      run_in_background: true,
    });
    // F04 t02: the id is model-visible at the start-message surface for EVERY
    // background task, one-shot builtins included (the old suppression is gone).
    const agentId = String(started.details.agentId);
    expect(started.content[0]!.text).toContain(`agent id: ${agentId}`);
    expect(started.content[0]!.text).toContain("agent: Explore");
    expect(agentId).toMatch(AGENT_ID);

    // A resumable (non-builtin) background dispatch DOES advertise its id.
    const runtime2 = makeSubagentRuntime([makeAgent()], fakeSdk({ replies: ["r"] }).sdk, {
      getMainSessionFile: () => main,
    });
    const tool2 = createAgentToolDefinition(runtime2, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started2 = await tool2.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    expect(started2.content[0]!.text).toContain("agent id:");
  });
});

describe("subagent hooks carry agent_id/agent_type; transcript_path stays = main (t02 parity)", () => {
  it("agent-scoped hook runners are NOT re-pointed to the subagent transcript (Claude Code parity)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["done"] });
    // The runtime must construct the scoped runner WITHOUT a subagent-transcript
    // getter (no second argument) — the runner then keeps the MAIN session
    // transcript_path (index.ts fallback). Re-pointing it at the subagent's own
    // file would violate Claude Code parity (review round 2).
    const optsSeen: Array<unknown> = [];
    const makeScopedHookRunner = (_config: Record<string, unknown>, ...rest: unknown[]) => {
      optsSeen.push(rest[0]);
      return {
        fire: async () => ({ block: false, askDowngraded: false, diagnostics: [] }),
      };
    };
    const agent = makeAgent({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "check", raw: {} }] }] },
    });
    const runtime = makeSubagentRuntime([agent], h.sdk, {
      getMainSessionFile: () => main,
      makeScopedHookRunner: makeScopedHookRunner as never,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(optsSeen).toHaveLength(1);
    // No opts argument was passed → the scoped runner falls back to the main
    // transcript, never the subagent's own.
    expect(optsSeen[0]).toBeUndefined();
    expect(result.transcriptPath).toBeDefined();
  });

  it("SubagentStart and SubagentStop payloads carry agent_id + agent_type and NEVER the subagent transcript_path (parity)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["done"] });
    const fired: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const hookRunner = {
      fire: async (event: string, payload: Record<string, unknown>) => {
        fired.push({ event, payload });
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
      hookRunner,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    const start = fired.find((f) => f.event === "SubagentStart");
    const stop = fired.find((f) => f.event === "SubagentStop");
    // Both the type and the id ride on both events (Claude Code hook input parity).
    expect(start?.payload.subagent_type).toBe("reviewer");
    expect(start?.payload.agent_id).toBe(result.agentId);
    expect(start?.payload.agent_type).toBe("reviewer");
    expect(stop?.payload.subagent_type).toBe("reviewer");
    expect(stop?.payload.agent_id).toBe(result.agentId);
    expect(stop?.payload.agent_type).toBe("reviewer");
    // Parity (Claude Code, review round 2): PiCC does NOT clobber transcript_path
    // on subagent hook payloads — neither Start nor Stop carries the subagent's
    // own transcript. The MAIN transcript_path is supplied by the HookRunner's
    // own constructed default (exercised directly in hooks.test.ts), not injected
    // into the payload here.
    expect(start?.payload.transcript_path).toBeUndefined();
    expect(stop?.payload.transcript_path).toBeUndefined();
  });

  it("Pre- and PostToolUse hooks fired from INSIDE the dispatch carry agent_id + agent_type (central injection)", async () => {
    const main = fakeMainSessionFile();
    const h = fakeSdk({ replies: ["done"] });
    const fired: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const hookRunner = {
      fire: async (event: string, payload: Record<string, unknown>) => {
        fired.push({ event, payload });
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, {
      getMainSessionFile: () => main,
      hookRunner,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    // The guard extension the dispatch installed fires PreToolUse through the
    // SAME (identity-injected) runner as Subagent{Start,Stop}. Retrieve it from
    // the created session's resource loader and drive one tool_call.
    const loaderOptions = (h.created[0]!.resourceLoader as { options: Record<string, unknown> })
      .options;
    const factories = loaderOptions.extensionFactories as Array<{
      name: string;
      factory: (pi: unknown) => unknown;
    }>;
    const guardFactory = factories.find((f) => f.name.startsWith("picc-guard-"))!.factory;
    let toolCallHandler: ((event: unknown) => unknown) | undefined;
    let toolResultHandler: ((event: unknown) => unknown) | undefined;
    guardFactory({
      on: (event: string, handler: (event: unknown) => unknown) => {
        if (event === "tool_call") toolCallHandler = handler;
        if (event === "tool_result") toolResultHandler = handler;
      },
      sendMessage: () => {},
    });
    await toolCallHandler!({ toolName: "Read", input: { file_path: "x" }, toolCallId: "tc1" });
    const pre = fired.find((f) => f.event === "PreToolUse");
    expect(pre).toBeDefined();
    expect(pre?.payload.agent_id).toBe(result.agentId);
    expect(pre?.payload.agent_type).toBe("reviewer");
    // The SAME injectIdentity choke point covers PostToolUse (tool_result):
    // a non-error result fires PostToolUse through the identity-injected runner.
    await toolResultHandler!({
      toolName: "Read",
      input: { file_path: "x" },
      toolCallId: "tc1",
      content: [{ type: "text", text: "file body" }],
      isError: false,
    });
    const post = fired.find((f) => f.event === "PostToolUse");
    expect(post).toBeDefined();
    expect(post?.payload.agent_id).toBe(result.agentId);
    expect(post?.payload.agent_type).toBe("reviewer");
  });
});

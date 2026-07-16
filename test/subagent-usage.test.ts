import { describe, expect, it } from "vitest";
import {
  createAgentToolDefinition,
  type DispatchUsage,
  type PiSessionStats,
} from "../src/runtime/subagents.js";
import { BackgroundTaskRegistry, createTaskOutputTool } from "../src/runtime/background-tasks.js";
import { SubagentRegistry } from "../src/runtime/subagent-registry.js";
import { formatUsageCompact } from "../src/runtime/subagent-progress.js";
import { fakeSdk, makeAgent, makeSubagentRuntime } from "./helpers/fake-sdk.js";

/**
 * t06 — per-subagent usage accounting. Every dispatch captures the session's
 * getSessionStats() after the last prompt() and carries it as `usage`
 * (numbers-only, absent fields omitted). Surfaced in the foreground tool-result
 * details, the background TaskOutput text, and the dispatch registry the /usage
 * control command aggregates. Fakes without getSessionStats keep working
 * (usage undefined, no crash).
 */

// Full stats → the five mapped usage fields.
const FULL_STATS: PiSessionStats = {
  tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, total: 180 },
  cost: 0.0123,
};
const FULL_USAGE: DispatchUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 20,
  cacheWriteTokens: 10,
  costUsd: 0.0123,
};

type ToolLike = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (u: { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }) => void,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
  renderResult: (
    r: { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> },
    o: { isPartial?: boolean },
    theme: unknown,
  ) => { render: (w: number) => string[] };
};

describe("dispatch usage capture (t06)", () => {
  it("captures getSessionStats() into result.usage on a completed run, mapped to the numeric shape", async () => {
    const h = fakeSdk({ replies: ["done"], stats: FULL_STATS });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.outcome).toBe("completed");
    expect(result.usage).toEqual(FULL_USAGE);
  });

  it("absent getSessionStats (older SDK / minimal fake) → usage undefined, no crash", async () => {
    const h = fakeSdk({ replies: ["done"], noGetSessionStats: true });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.outcome).toBe("completed");
    expect(result.usage).toBeUndefined();
  });

  it("absent getSessionStats on a FAILED run → outcome failed, usage undefined, no throw", async () => {
    // The failed path must tolerate a stats-less session exactly like the
    // completed path — no getSessionStats to read, so usage stays undefined.
    const h = fakeSdk({
      replies: [{ stopReason: "error", errorMessage: "insufficient_quota: drained" }],
      noGetSessionStats: true,
    });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.outcome).toBe("failed");
    expect(result.usage).toBeUndefined();
  });

  it("stats present but empty (no token/cost fields) → usage undefined (never invented zeros)", async () => {
    const h = fakeSdk({ replies: ["done"], stats: {} });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.usage).toBeUndefined();
  });

  it("omits fields Pi did not report rather than inventing zeros", async () => {
    const h = fakeSdk({
      replies: ["done"],
      stats: { tokens: { input: 7 }, cost: 0.5 },
    });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.usage).toEqual({ inputTokens: 7, costUsd: 0.5 });
    expect(result.usage).not.toHaveProperty("outputTokens");
    expect(result.usage).not.toHaveProperty("cacheReadTokens");
  });

  it("a FAILED run carries its partial usage (what did the failure cost me)", async () => {
    const h = fakeSdk({
      replies: [{ stopReason: "error", errorMessage: "insufficient_quota: drained" }],
      stats: FULL_STATS,
    });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.outcome).toBe("failed");
    expect(result.usage).toEqual(FULL_USAGE);
  });

  it("an ABORTED run reports its partial usage too", async () => {
    // A never-resolving gate holds prompt() in-flight so the abort lands AFTER
    // the session exists (the aborted-during-run path, which can read stats),
    // not the pre-session guard.
    const gate = new Promise<void>(() => {});
    const h = fakeSdk({ replies: [{ text: "never", gate }], stats: FULL_STATS });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk);
    const controller = new AbortController();
    const pending = runtime.dispatch({
      subagentType: "reviewer",
      prompt: "p",
      depth: 1,
      abortSignal: controller.signal,
    });
    await h.waitForPromptCalls(1); // ensure partial usage is read from a live session
    controller.abort();
    const result = await pending;
    expect(result.outcome).toBe("aborted");
    expect(h.abortCalls()).toBeGreaterThan(0);
    expect(result.usage).toEqual(FULL_USAGE);
  });
});

describe("usage reaches the dispatch registry (t06)", () => {
  it("records per-subagent usage + outcome for a completed dispatch", async () => {
    const registry = new SubagentRegistry();
    const h = fakeSdk({ replies: ["done"], stats: FULL_STATS });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, { subagentRegistry: registry });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    const record = registry.get(result.agentId);
    expect(record).toBeDefined();
    expect(record!.outcome).toBe("completed");
    expect(record!.usage).toEqual(FULL_USAGE);
  });

  it("records the failed outcome + partial usage for a failed dispatch", async () => {
    const registry = new SubagentRegistry();
    const h = fakeSdk({
      replies: [{ stopReason: "error", errorMessage: "429" }],
      stats: FULL_STATS,
    });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk, { subagentRegistry: registry });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    const record = registry.get(result.agentId);
    expect(record!.outcome).toBe("failed");
    expect(record!.usage).toEqual(FULL_USAGE);
  });
});

describe("foreground surfaces the usage (t06 + t03 slot)", () => {
  it("tool-result details.usage is populated and renderResult's footer lights up", async () => {
    const h = fakeSdk({ replies: ["the answer"], stats: FULL_STATS });
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk);
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as ToolLike;
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "p" });
    expect(res.details.usage).toEqual(FULL_USAGE);
    // Verbatim-return contract: usage is metadata (details + footer) only — it
    // must NEVER be appended into the model-visible body (finalMessage).
    expect(res.content[0]!.text).not.toContain("usage");
    // t03's renderResult footer (formatUsageLine → formatUsageCompact) renders it.
    const rendered = tool.renderResult(res, { isPartial: false }, undefined).render(200).join("\n");
    expect(rendered).toContain("usage:");
    expect(rendered).toContain("in 100");
    expect(rendered).toContain("out 50");
    expect(rendered).toContain("$0.0123");
  });
});

describe("background surfaces the usage (t06)", () => {
  it("TaskOutput text carries a compact usage line and details.usage; the record mirrors it", async () => {
    const h = fakeSdk({ replies: ["bg answer"], stats: FULL_STATS });
    const backgroundTasks = new BackgroundTaskRegistry();
    const runtime = makeSubagentRuntime([makeAgent()], h.sdk);
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks,
    }) as unknown as ToolLike;
    const start = await agentTool.execute("t", {
      subagent_type: "reviewer",
      prompt: "p",
      run_in_background: true,
    });
    const taskId = start.details.taskId as string;
    const outTool = createTaskOutputTool(backgroundTasks) as unknown as ToolLike;
    const out = await outTool.execute("t2", { task_id: taskId });
    expect(out.content[0]!.text).toContain("usage: in 100");
    expect(out.content[0]!.text).toContain("$0.0123");
    expect(out.details.usage).toEqual(FULL_USAGE);
    // Mirror invariant: the background record's usage equals the dispatch usage.
    expect(backgroundTasks.get(taskId)!.usage).toEqual(FULL_USAGE);
  });
});

describe("formatUsageCompact (t06 shared formatter)", () => {
  it("renders only present fields, joins them, and trims cost zeros", () => {
    expect(formatUsageCompact(FULL_USAGE)).toBe(
      "in 100 · out 50 · cache read 20 · cache write 10 · $0.0123",
    );
    expect(formatUsageCompact({ inputTokens: 7, costUsd: 0.5 })).toBe("in 7 · $0.5");
    expect(formatUsageCompact({ costUsd: 0 })).toBe("$0.00");
  });

  it("never renders a nonzero cost as $0 — a sub-resolution charge floors to <$0.0001", () => {
    // Exact zero stays $0.00; a real charge below 4-decimal resolution must not
    // read as free (the "what did the failure cost me" case).
    expect(formatUsageCompact({ costUsd: 0 })).toBe("$0.00");
    expect(formatUsageCompact({ costUsd: 0.00001 })).toBe("<$0.0001");
    expect(formatUsageCompact({ costUsd: 0.5 })).toBe("$0.5");
    expect(formatUsageCompact({ costUsd: 12.3456 })).toBe("$12.3456");
    // Sanity across magnitudes: no nonzero renders as bare "$0".
    for (const c of [0.00001, 0.0123, 0.5, 3, 12.3456]) {
      expect(formatUsageCompact({ costUsd: c })).not.toBe("$0");
    }
  });

  it("returns undefined for empty / non-object input, and supports the legacy total shape", () => {
    expect(formatUsageCompact(undefined)).toBeUndefined();
    expect(formatUsageCompact({})).toBeUndefined();
    expect(formatUsageCompact("x")).toBeUndefined();
    // Legacy shape the t03 defensive slot expected (totalTokens + costUsd).
    expect(formatUsageCompact({ totalTokens: 1200, costUsd: 0.03 })).toBe("1200 tokens · $0.03");
  });
});

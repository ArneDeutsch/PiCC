import { afterEach, describe, expect, it } from "vitest";
import {
  BackgroundTaskRegistry,
  createTaskOutputTool,
  createTaskStopTool,
  type BackgroundResultLike,
} from "../src/runtime/background-tasks.js";
import { createAgentToolDefinition } from "../src/runtime/subagents.js";
import {
  fakeSdk,
  makeAgent as makeBaseAgent,
  makeSubagentRuntime as makeRuntime,
} from "./helpers/fake-sdk.js";
import type { ClaudeAgent } from "../src/types.js";

/**
 * Background task runtime (audit E4): registry lifecycle, the Agent tool's
 * run_in_background path, and the real TaskOutput/TaskStop tools (formerly
 * degrade stubs). Uses the shared fake-Pi-SDK builder from test/helpers.
 */

const makeAgent = (overrides: Partial<ClaudeAgent> = {}): ClaudeAgent =>
  makeBaseAgent({ name: "worker", description: "Does work", body: "You are the worker.", ...overrides });

/** Fake SDK whose sessions block on a gate until released (or aborted). */
function gatedSdk(finalText: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const handle = fakeSdk({ replies: [{ text: finalText, gate }] });
  return { sdk: handle.sdk, release: () => release(), abortCalls: handle.abortCalls };
}

type ToolLike = {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

const savedDisable = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;

afterEach(() => {
  if (savedDisable === undefined) delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
  else process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = savedDisable;
});

const result = (over: Partial<BackgroundResultLike> = {}): BackgroundResultLike => ({
  ok: over.outcome === undefined ? over.ok !== false : over.outcome === "completed",
  outcome: over.outcome ?? (over.ok === false ? "failed" : "completed"),
  finalMessage: "done",
  diagnostics: [],
  ...over,
});

describe("BackgroundTaskRegistry", () => {

  it("assigns sequential ids and tracks completion with the result text", async () => {
    const registry = new BackgroundTaskRegistry();
    const id1 = registry.start("agent:a", Promise.resolve(result({ finalMessage: "one" })));
    const id2 = registry.start("agent:b", Promise.resolve(result({ finalMessage: "two" })));
    expect(id1).toBe("task-1");
    expect(id2).toBe("task-2");
    expect(registry.ids()).toEqual(["task-1", "task-2"]);
    await registry.wait(id1);
    await registry.wait(id2);
    expect(registry.get(id1)?.status).toBe("completed");
    expect(registry.get(id1)?.result).toBe("one");
    expect(registry.get(id2)?.result).toBe("two");
  });

  it("records ok:false dispatches as failed with the error", async () => {
    const registry = new BackgroundTaskRegistry();
    const id = registry.start("agent:a", Promise.resolve(result({ ok: false, error: "boom" })));
    await registry.wait(id);
    expect(registry.get(id)?.status).toBe("failed");
    expect(registry.get(id)?.error).toBe("boom");
  });

  it("never lets a rejecting promise escape: records failed instead", async () => {
    const registry = new BackgroundTaskRegistry();
    const id = registry.start("agent:a", Promise.reject(new Error("kaput")));
    await registry.wait(id);
    expect(registry.get(id)?.status).toBe("failed");
    expect(registry.get(id)?.error).toBe("kaput");
  });

  it("stop marks a running task stopped, invokes the abort hook, and discards the late result", async () => {
    const registry = new BackgroundTaskRegistry();
    let resolve!: (v: ReturnType<typeof result>) => void;
    let aborted = false;
    const id = registry.start(
      "agent:a",
      new Promise((r) => (resolve = r)),
      () => {
        aborted = true;
      },
    );
    const stopped = registry.stop(id);
    expect(stopped).toEqual({ found: true, alreadySettled: false, abortRequested: true });
    expect(aborted).toBe(true);
    expect(registry.get(id)?.status).toBe("stopped");
    resolve(result({ finalMessage: "too late" }));
    await registry.wait(id);
    expect(registry.get(id)?.status).toBe("stopped");
    expect(registry.get(id)?.result).toBeUndefined();
  });

  it("stop on a settled task reports alreadySettled; unknown ids report not found", async () => {
    const registry = new BackgroundTaskRegistry();
    const id = registry.start("agent:a", Promise.resolve(result()));
    await registry.wait(id);
    expect(registry.stop(id)).toEqual({ found: true, alreadySettled: true, abortRequested: false });
    expect(registry.stop("task-99").found).toBe(false);
  });
});

describe("Agent tool run_in_background (audit E4)", () => {
  it("returns immediately with a task id; TaskOutput (wait default) returns the final text", async () => {
    const { sdk, release } = gatedSdk("bg-final");
    const registry = new BackgroundTaskRegistry();
    const runtime = makeRuntime([makeAgent()], sdk);
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;

    const started = await agentTool.execute("t1", {
      subagent_type: "worker",
      prompt: "go",
      run_in_background: true,
    });
    // Immediate return while the dispatch is still gated.
    expect(started.content[0]!.text).toMatch(/Background task task-\d+ started \(agent: worker\)/);
    expect(started.content[0]!.text).toContain("TaskOutput");
    const taskId = String(started.details.taskId);
    expect(registry.get(taskId)?.status).toBe("running");

    const taskOutput = createTaskOutputTool(registry) as unknown as ToolLike;
    const pending = taskOutput.execute("t2", { task_id: taskId });
    release();
    const res = await pending;
    expect(res.content[0]!.text).toBe("bg-final"); // verbatim final message
    expect(res.details.status).toBe("completed");
  });

  it("TaskOutput with wait:false polls the running status without blocking", async () => {
    const { sdk, release } = gatedSdk("later");
    const registry = new BackgroundTaskRegistry();
    const runtime = makeRuntime([makeAgent()], sdk);
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await agentTool.execute("t1", {
      subagent_type: "worker",
      prompt: "go",
      run_in_background: true,
    });
    const taskOutput = createTaskOutputTool(registry) as unknown as ToolLike;
    const polled = await taskOutput.execute("t2", {
      task_id: String(started.details.taskId),
      wait: false,
    });
    expect(polled.details.status).toBe("running");
    expect(polled.content[0]!.text).toContain("still running");
    release();
    await registry.wait(String(started.details.taskId));
  });

  it("TaskOutput on an unknown id errors helpfully, listing known ids", async () => {
    const registry = new BackgroundTaskRegistry();
    registry.start("agent:a", Promise.resolve(result({ finalMessage: "x" })));
    const taskOutput = createTaskOutputTool(registry) as unknown as ToolLike;
    await expect(taskOutput.execute("t", { task_id: "task-42" })).rejects.toThrow(
      /Unknown task_id "task-42".*task-1/,
    );
    // With no tasks at all the error still guides the model.
    const empty = createTaskOutputTool(new BackgroundTaskRegistry()) as unknown as ToolLike;
    await expect(empty.execute("t", { task_id: "task-1" })).rejects.toThrow(/none/);
  });

  it("TaskStop marks the task stopped and aborts the live session cooperatively", async () => {
    const { sdk, abortCalls } = gatedSdk("never-used");
    const registry = new BackgroundTaskRegistry();
    const runtime = makeRuntime([makeAgent()], sdk);
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await agentTool.execute("t1", {
      subagent_type: "worker",
      prompt: "go",
      run_in_background: true,
    });
    const taskId = String(started.details.taskId);
    // Give the un-awaited dispatch a beat to create its session.
    await new Promise((r) => setTimeout(r, 20));

    const taskStop = createTaskStopTool(registry) as unknown as ToolLike;
    const stopped = await taskStop.execute("t2", { task_id: taskId });
    expect(stopped.content[0]!.text).toContain("stop requested");
    expect(registry.get(taskId)?.status).toBe("stopped");

    await registry.wait(taskId);
    expect(abortCalls()).toBeGreaterThan(0); // AbortController → session.abort()
    expect(registry.get(taskId)?.status).toBe("stopped"); // late result discarded
    const taskOutput = createTaskOutputTool(registry) as unknown as ToolLike;
    const out = await taskOutput.execute("t3", { task_id: taskId });
    expect(out.content[0]!.text).toContain("was stopped");
  });

  it("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS forces foreground with a details note", async () => {
    process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
    const { sdk, release } = gatedSdk("fg-final");
    release(); // foreground path must complete
    const registry = new BackgroundTaskRegistry();
    const runtime = makeRuntime([makeAgent()], sdk);
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const res = await agentTool.execute("t1", {
      subagent_type: "worker",
      prompt: "go",
      run_in_background: true,
    });
    expect(res.content[0]!.text).toBe("fg-final");
    expect(String(res.details.note ?? "")).toContain("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS");
    expect(registry.ids()).toEqual([]); // nothing registered
  });

  it("a failing background dispatch reports the failure via TaskOutput (never an unhandled rejection)", async () => {
    const { sdk } = gatedSdk("unused");
    const registry = new BackgroundTaskRegistry();
    const runtime = makeRuntime([makeAgent()], sdk);
    // depth 5 → dispatch depth 6 exceeds maxDepth 2: a guaranteed ok:false path
    // (unknown subagent_types no longer fail — they fall back to general-purpose).
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 5,
      backgroundTasks: registry,
    }) as unknown as ToolLike;
    const started = await agentTool.execute("t1", {
      subagent_type: "worker",
      prompt: "go",
      run_in_background: true,
    });
    const taskId = String(started.details.taskId);
    const taskOutput = createTaskOutputTool(registry) as unknown as ToolLike;
    const out = await taskOutput.execute("t2", { task_id: taskId });
    expect(out.details.status).toBe("failed");
    expect(out.content[0]!.text).toContain("failed");
    expect(out.content[0]!.text).toContain("depth");
  });

  it("TaskStop while queued behind the concurrency cap prevents the session from ever starting (H3)", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGate = resolve));
    const handle = fakeSdk({ replies: [{ text: "gate-done", gate }] });
    const sessions = () => handle.created.length;
    const registry = new BackgroundTaskRegistry();
    const runtime = makeRuntime([makeAgent()], handle.sdk, { concurrency: 1 });
    const agentTool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as ToolLike;

    // Task 1 occupies the single slot (its prompt blocks on the gate).
    const first = await agentTool.execute("t1", {
      subagent_type: "worker",
      prompt: "hold the slot",
      run_in_background: true,
    });
    // Task 2 queues on the semaphore — no session yet.
    const second = await agentTool.execute("t2", {
      subagent_type: "worker",
      prompt: "queued work",
      run_in_background: true,
    });
    const secondId = String(second.details.taskId);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessions()).toBe(1); // only the gated task created a session

    // Stop the QUEUED task, then release the gate so it dequeues.
    const taskStop = createTaskStopTool(registry) as unknown as ToolLike;
    await taskStop.execute("t3", { task_id: secondId });
    releaseGate();
    await registry.wait(String(first.details.taskId));
    await registry.wait(secondId);

    expect(sessions()).toBe(1); // the stopped dispatch never created a session
    const taskOutput = createTaskOutputTool(registry) as unknown as ToolLike;
    const out = await taskOutput.execute("t4", { task_id: secondId });
    expect(out.details.status).toBe("stopped");
    expect(out.content[0]!.text).toContain("was stopped");
  });
});

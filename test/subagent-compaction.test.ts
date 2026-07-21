import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc from "../src/index.js";
import type { ClaudeAgent } from "../src/types.js";
import type { PiSdk, PiSessionMessage } from "../src/runtime/subagents.js";
import { createSendMessageToolDefinition } from "../src/runtime/subagents.js";
import {
  BackgroundTaskRegistry,
  createTaskOutputTool,
  createTaskStopTool,
  scopedBackgroundTools,
} from "../src/runtime/background-tasks.js";
import { SubagentRegistry } from "../src/runtime/subagent-registry.js";
import { fakeSdk, makeAgent, makeSubagentRuntime } from "./helpers/fake-sdk.js";
import { fakePi } from "./helpers/fake-pi.js";

interface ChildHarness {
  sdk: PiSdk;
  compactCalls(): number;
  sessionCreations(): number;
  disposed(): boolean;
  aborted(): boolean;
  recoveryCompactStarted(): Promise<void>;
  releaseRecoveryCompact(): void;
  resumeCalls(): number;
  events(): string[];
  customMessages(): Array<{ customType: string; content: unknown }>;
  guardResults(): unknown[];
}

function checkpointSdk(
  failures: number,
  recoveryReject: "before" | "after" | undefined = undefined,
  gateRecoveryCompact = false,
  reExhaustOnce = false,
  mixedBatch = false,
  activateSkill = false,
): ChildHarness {
  const base = fakeSdk().sdk;
  let compactions = 0;
  let creations = 0;
  let disposed = false;
  let aborted = false;
  let resumeCalls = 0;
  const events: string[] = [];
  const customMessages: Array<{ customType: string; content: unknown }> = [];
  const guardResults: unknown[] = [];
  let releaseRecoveryCompact!: () => void;
  let markRecoveryCompactStarted!: () => void;
  const recoveryCompactGate = new Promise<void>((resolve) => { releaseRecoveryCompact = resolve; });
  const recoveryCompactStarted = new Promise<void>((resolve) => { markRecoveryCompactStarted = resolve; });

  class Loader {
    constructor(readonly options: Record<string, unknown>) {}
    async reload(): Promise<void> {}
  }

  const sdk: PiSdk = {
    ...base,
    DefaultResourceLoader: Loader,
    async createAgentSession(options) {
      creations += 1;
      const loader = options.resourceLoader as Loader;
      const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
      const extensionPi = {
        on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        },
      };
      for (const entry of loader.options.extensionFactories as Array<{
        factory(pi: typeof extensionPi): unknown;
      }>) entry.factory(extensionPi);

      const messages: PiSessionMessage[] = [];
      const emit = async (event: string, payload: unknown, ctx: unknown): Promise<unknown[]> => {
        const results: unknown[] = [];
        for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
        return results;
      };
      const ctx = {
        model: { api: "openai-responses" },
        mode: "json",
        getContextUsage: () => compactions >= (reExhaustOnce ? 8 : 4)
          ? ({ percent: 10, tokens: 100, contextWindow: 1000 })
          : ({ percent: 95, tokens: 950, contextWindow: 1000 }),
        hasPendingMessages: () => false,
        abort: () => { aborted = true; },
      };
      let resumed = false;
      let rejectedRecovery = false;
      const runResumed = async (): Promise<void> => {
        await emit("turn_start", {}, ctx);
        await emit("before_provider_request", {}, ctx);
        events.push("resumed-provider");
        const assistant: PiSessionMessage = {
          role: "assistant",
          content: [{ type: "text", text: "resumed final" }],
          stopReason: "stop",
        };
        messages.push(assistant);
        await emit("message_end", { message: assistant }, ctx);
        await emit("turn_end", {}, ctx);
        await emit("agent_settled", {}, ctx);
      };
      const session = {
        messages,
        async prompt(text: string) {
          const user: PiSessionMessage = { role: "user", content: text };
          messages.push(user);
          await emit("message_start", { message: user }, ctx);
          await emit("turn_start", {}, ctx);
          await emit("before_provider_request", {}, ctx);
          if (activateSkill && creations > 1) {
            guardResults.push(...await emit("tool_call", {
              toolName: "WebFetch", toolCallId: "sibling-check", input: { url: "https://example.com" },
            }, ctx));
            const siblingFinal: PiSessionMessage = { role: "assistant", content: [{ type: "text", text: "sibling final" }], stopReason: "stop" };
            messages.push(siblingFinal);
            await emit("message_end", { message: siblingFinal }, ctx);
            await emit("turn_end", {}, ctx);
            await emit("agent_settled", {}, ctx);
            return;
          }
          const calls = mixedBatch
            ? ["CheckpointTool", "DeniedTool", "ErrorTool", "MalformedTool"]
            : activateSkill ? ["Skill"] : ["CheckpointTool"];
          const assistant: PiSessionMessage = {
            role: "assistant",
            content: calls.map((name, index) => ({
              type: "toolCall" as const, id: `call-${index + 1}`, name, arguments: {},
            })),
            stopReason: "toolUse",
          };
          messages.push(assistant);
          await emit("message_end", { message: assistant }, ctx);
          await Promise.all(calls.map(async (name, index) => {
            const tool = (options.customTools as Array<Record<string, unknown>>)
              .find((candidate) => candidate.name === name)!;
            let result: Record<string, unknown>;
            let isError = false;
            try {
              result = await (tool.execute as (...args: unknown[]) => Promise<Record<string, unknown>>)(
                `call-${index + 1}`,
                name === "Skill" ? { name: "child-scope", arguments: "example.com" } : {},
                undefined, undefined, ctx,
              );
              isError = result.isError === true || !Array.isArray(result.content);
            } catch (error) {
              result = { content: [{ type: "text", text: String(error) }], isError: true };
              isError = true;
            }
            events.push(`tool-result:${name}`);
            await emit("tool_execution_end", { toolCallId: `call-${index + 1}`, result, isError }, ctx);
          }));
          if (activateSkill) {
            guardResults.push(...await emit("tool_call", {
              toolName: "WebFetch", toolCallId: "deny-check", input: { url: "https://example.com" },
            }, ctx));
            guardResults.push(...await emit("tool_call", {
              toolName: "bash", toolCallId: "hook-check", input: { command: "echo child" },
            }, ctx));
          }
          await emit("turn_end", {}, ctx);
          await emit("agent_settled", {}, ctx);
        },
        async compact() {
          compactions += 1;
          const before = await emit("session_before_compact", { reason: "manual" }, ctx);
          if (before.some((result) => (result as { cancel?: boolean } | undefined)?.cancel)) {
            throw new Error("compaction cancelled");
          }
          if (compactions <= failures || (reExhaustOnce && compactions >= 5 && compactions <= 7)) {
            throw new Error("transient compaction failure");
          }
          if (gateRecoveryCompact && compactions === failures + 1) {
            events.push("compact-started");
            markRecoveryCompactStarted();
            await recoveryCompactGate;
          }
          await emit("session_compact", { compactionEntry: { summary: "summary" } }, ctx);
          return { summary: "summary" };
        },
        async sendCustomMessage(
          message: { customType: string; content: unknown; display: boolean },
          sendOptions?: { triggerTurn?: boolean },
        ) {
          if (sendOptions?.triggerTurn) {
            resumed = true;
            resumeCalls += 1;
            await Promise.resolve();
            if (recoveryReject === "before" && !rejectedRecovery) {
              rejectedRecovery = true;
              throw new Error("recovery rejected before turn_start");
            }
            await runResumed();
            if (recoveryReject === "after" && !rejectedRecovery) {
              rejectedRecovery = true;
              throw new Error("recovery rejected after turn_start");
            }
          } else {
            if (message.customType === "picc-retained-parent-input") events.push("queued-replay");
            customMessages.push({ customType: message.customType, content: message.content });
            messages.push({ role: "custom", content: message.content });
          }
        },
        steer() {},
        followUp() {},
        abort() { aborted = true; },
        abortCompaction() { releaseRecoveryCompact(); },
        dispose() { disposed = true; },
      };
      void resumed;
      return { session };
    },
  };

  return {
    sdk,
    compactCalls: () => compactions,
    sessionCreations: () => creations,
    disposed: () => disposed,
    aborted: () => aborted,
    recoveryCompactStarted: () => recoveryCompactStarted,
    releaseRecoveryCompact: () => releaseRecoveryCompact(),
    resumeCalls: () => resumeCalls,
    events: () => [...events],
    customMessages: () => [...customMessages],
    guardResults: () => [...guardResults],
  };
}

function runtimeFor(
  harness: ChildHarness,
  agent: ClaudeAgent = makeAgent(),
  subagentRegistry?: SubagentRegistry,
) {
  return makeSubagentRuntime([agent], harness.sdk, {
    proactiveCompactPercent: 90,
    allKnownToolNames: () => ["CheckpointTool"],
    subagentRegistry,
    customToolsFor: () => [
      {
        name: "CheckpointTool",
        async execute() { return { content: [{ type: "text", text: "tool complete" }] }; },
      },
      {
        name: "DeniedTool",
        async execute() { return { content: [{ type: "text", text: "denied" }], isError: true }; },
      },
      {
        name: "ErrorTool",
        async execute() { throw new Error("tool exploded"); },
      },
      {
        name: "MalformedTool",
        async execute() { return { malformed: true }; },
      },
    ],
  });
}

describe("subagent mid-run compaction", () => {
  it("retries, compacts, and resumes on the same live child session before classification", async () => {
    const harness = checkpointSdk(1);
    const result = await runtimeFor(harness).dispatch({
      subagentType: "reviewer",
      prompt: "review",
      depth: 1,
    });

    expect(result.outcome).toBe("completed");
    expect(result.finalMessage).toBe("resumed final");
    expect(harness.compactCalls()).toBe(2);
    expect(harness.sessionCreations()).toBe(1);
    expect(harness.disposed()).toBe(true);
  });

  it("preserves child-local Skill activation through real extension tool assembly and compaction", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-child-skill-"));
    const priorCwd = process.cwd();
    const priorUser = process.env.PICC_CLAUDE_USER_DIR;
    const write = (relative: string, content: string) => {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    const hookLog = path.join(dir, "hook.json");
    write("CLAUDE.md", "parent instructions\n");
    write(".claude/agents/reviewer.md", "---\ndescription: reviewer\ntools: Skill, WebFetch, Bash\n---\nreview\n");
    write("hook.mjs", `import fs from "node:fs";let s="";for await(const c of process.stdin)s+=c;fs.writeFileSync(${JSON.stringify(hookLog)},s);`);
    write(".claude/settings.json", JSON.stringify({ env: {
      HOOK_NODE: process.execPath,
      HOOK_SCRIPT: path.join(dir, "hook.mjs"),
    } }));
    write(".claude/skills/child-scope/SKILL.md", [
      "---",
      "description: child scoped activation",
      "disallowed-tools: WebFetch(domain:$0)",
      "hooks:",
      "  PreToolUse:",
      "    - matcher: Bash",
      "      hooks:",
      "        - type: command",
      "          command: '\"$HOOK_NODE\" \"$HOOK_SCRIPT\"'",
      "---",
      "CHILD-SKILL-BODY $ARGUMENTS",
      "",
    ].join("\n"));
    const harness = checkpointSdk(1, undefined, false, false, false, true);
    const childPi = fakePi();
    let runtime!: ReturnType<typeof runtimeFor>;
    try {
      process.chdir(dir);
      process.env.PICC_CLAUDE_USER_DIR = path.join(dir, ".user");
      picc(childPi.api as never, {
        sdk: harness.sdk,
        onInitializationSettled: childPi.captureInitialization,
        onWired: ({ subagentRuntime }) => { runtime = subagentRuntime; },
      });
      await childPi.waitForInitialization();
      const child = await runtime.dispatch({ subagentType: "reviewer", prompt: "activate", depth: 1 });
      expect(child.outcome).toBe("completed");
      expect(harness.customMessages().find((message) => message.customType === "picc-preserved")?.content)
        .toContain("CHILD-SKILL-BODY example.com");
      expect(harness.guardResults().some((result: any) => result?.block === true)).toBe(true);
      const hookPayload = JSON.parse(fs.readFileSync(hookLog, "utf8"));
      expect(hookPayload).toMatchObject({ agent_id: child.agentId, agent_type: "reviewer", cwd: dir });

      const mainGuard = await childPi.fire("tool_call", {
        toolName: "WebFetch", toolCallId: "main-check", input: { url: "https://example.com" },
      });
      expect(mainGuard?.block).not.toBe(true);
      await runtime.dispatch({ subagentType: "reviewer", prompt: "sibling", depth: 1 });
      expect(harness.guardResults().filter((result: any) => result?.block === true)).toHaveLength(1);
    } finally {
      process.chdir(priorCwd);
      if (priorUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = priorUser;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a mixed parallel child batch before compact and replays queued parent input before provider release", async () => {
    const harness = checkpointSdk(1, undefined, true, false, true);
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry);
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
      agentId: "agent-555555555555",
    });
    await harness.recoveryCompactStarted();
    const send = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks: new BackgroundTaskRegistry(),
    });
    await (send.execute as Function)("send-queued", {
      to: "agent-555555555555",
      message: "parent message during compaction",
    });
    harness.releaseRecoveryCompact();
    const result = await dispatch;

    expect(result.outcome).toBe("completed");
    const events = harness.events();
    expect(new Set(events.slice(0, events.indexOf("compact-started")))).toEqual(new Set([
      "tool-result:CheckpointTool",
      "tool-result:DeniedTool",
      "tool-result:ErrorTool",
      "tool-result:MalformedTool",
    ]));
    expect(events.indexOf("compact-started")).toBe(4);
    expect(events.indexOf("queued-replay")).toBeGreaterThan(events.indexOf("compact-started"));
    expect(events.indexOf("queued-replay")).toBeLessThan(events.indexOf("resumed-provider"));
  });

  it("reports JSON/RPC-compatible retry and exhaustion progress to the parent once in order", async () => {
    const harness = checkpointSdk(3);
    const progress: string[] = [];
    const result = await runtimeFor(harness).dispatch({
      subagentType: "reviewer",
      prompt: "review",
      depth: 1,
      onProgress: (snapshot) => progress.push(snapshot.activity ?? ""),
    });

    expect(result.checkpointPaused).toBe(true);
    expect(progress).toEqual([
      "checkpoint: checkpoint-armed",
      "checkpoint retry 2/3",
      "checkpoint retry 3/3",
      "checkpoint paused: recovery required",
    ]);
  });

  it("returns an actionable paused failure after bounded exhaustion and retains the live session", async () => {
    const harness = checkpointSdk(3);
    const result = await runtimeFor(harness).dispatch({
      subagentType: "reviewer",
      prompt: "review",
      depth: 1,
    });

    expect(result.outcome).toBe("failed");
    expect(result.checkpointPaused).toBe(true);
    expect(result.error).toContain("paused and no continuation ran");
    expect(harness.compactCalls()).toBe(3);
    expect(harness.sessionCreations()).toBe(1);
    expect(harness.disposed()).toBe(false);
    expect(harness.aborted()).toBe(false);
  });

  it("makes awaited SendMessage own and return the classified retained recovery result", async () => {
    const harness = checkpointSdk(3);
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry);
    const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    const background = new BackgroundTaskRegistry();
    const tool = createSendMessageToolDefinition(runtime, { registry, backgroundTasks: background });

    const recovered = await (tool.execute as Function)("send-1", {
      to: exhausted.agentId,
      message: "finish recovery",
    });

    expect(recovered.content[0].text).toBe("resumed final");
    expect(recovered.details).toMatchObject({
      agentId: exhausted.agentId,
      delivery: "checkpoint-recovery",
      outcome: "completed",
      recovered: true,
    });
    expect(background.ids()).toEqual([]);
    expect(harness.compactCalls()).toBe(4);
    expect(harness.disposed()).toBe(true);
    expect(registry.get(exhausted.agentId)?.state).toBe("settled");
  });

  it.each(["before", "after"] as const)(
    "keeps recovery paused when sendCustomMessage rejects %s turn_start and allows a later retry",
    async (when) => {
      const harness = checkpointSdk(3, when);
      const registry = new SubagentRegistry();
      const runtime = runtimeFor(harness, makeAgent(), registry);
      const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
      const tool = createSendMessageToolDefinition(runtime, {
        registry,
        backgroundTasks: new BackgroundTaskRegistry(),
      });

      await expect((tool.execute as Function)("send-1", {
        to: exhausted.agentId,
        message: "first recovery",
      })).rejects.toThrow(/remains paused/);
      expect(registry.get(exhausted.agentId)?.checkpointPaused).toBe(true);
      expect(harness.disposed()).toBe(false);

      const retried = await (tool.execute as Function)("send-2", {
        to: exhausted.agentId,
        message: "retry recovery",
      });
      expect(retried.details.outcome).toBe("completed");
      expect(harness.disposed()).toBe(true);
    },
  );

  it("keeps the original retained owner when a recovery continuation re-exhausts", async () => {
    const harness = checkpointSdk(3, undefined, false, true);
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry);
    const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    const tool = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks: new BackgroundTaskRegistry(),
    });

    const reExhausted = await (tool.execute as Function)("send-1", {
      to: exhausted.agentId,
      message: "recover once",
    });
    expect(reExhausted.details).toMatchObject({ outcome: "failed", recovered: false });
    expect(registry.get(exhausted.agentId)?.checkpointPaused).toBe(true);
    expect(harness.disposed()).toBe(false);

    const recovered = await (tool.execute as Function)("send-2", {
      to: exhausted.agentId,
      message: "recover again",
    });
    expect(recovered.details).toMatchObject({ outcome: "completed", recovered: true });
    expect(harness.sessionCreations()).toBe(1);
    expect(harness.compactCalls()).toBe(8);
    expect(harness.disposed()).toBe(true);
  });

  it("accepts a retained foreground agent id in TaskStop and joins before disposal", async () => {
    const harness = checkpointSdk(3);
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry);
    const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    const tool = createTaskStopTool(new BackgroundTaskRegistry(), registry);

    const stopped = await (tool.execute as Function)("stop-1", { task_id: exhausted.agentId });

    expect(stopped.details).toMatchObject({ agentId: exhausted.agentId, checkpointPaused: true });
    expect(harness.aborted()).toBe(true);
    expect(harness.disposed()).toBe(true);
    expect(registry.get(exhausted.agentId)?.state).toBe("settled");
  });

  it("TaskStop during manual recovery joins it and forbids a late continuation", async () => {
    const harness = checkpointSdk(3, undefined, true);
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry);
    const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    const send = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks: new BackgroundTaskRegistry(),
    });
    const recovery = (send.execute as Function)("send", {
      to: exhausted.agentId,
      message: "recover",
    });
    await harness.recoveryCompactStarted();

    await (createTaskStopTool(new BackgroundTaskRegistry(), registry).execute as Function)("stop", {
      task_id: exhausted.agentId,
    });

    await expect(recovery).rejects.toThrow(/cancelled/);
    expect(harness.resumeCalls()).toBe(0);
    expect(harness.disposed()).toBe(true);
    expect(registry.get(exhausted.agentId)?.state).toBe("settled");
  });

  it("TaskStop by task id joins retained cleanup and leaves one stopped generation", async () => {
    const harness = checkpointSdk(3);
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry);
    const tasks = new BackgroundTaskRegistry();
    const agentId = "agent-111111111111";
    const abort = new AbortController();
    const taskId = tasks.start(
      "agent:reviewer",
      runtime.dispatch({
        subagentType: "reviewer", prompt: "review", depth: 1, background: true,
        agentId, abortSignal: abort.signal,
      }),
      async () => {
        abort.abort();
        await runtime.stopCheckpoint(agentId);
      },
      agentId,
      "reviewer",
    );
    await tasks.wait(taskId);
    expect(tasks.get(taskId)?.checkpointPaused).toBe(true);

    const stopped = await (createTaskStopTool(tasks, registry).execute as Function)("stop", {
      task_id: taskId,
    });

    expect(stopped.details.status).toBe("stopped");
    expect(harness.disposed()).toBe(true);
    expect(registry.get(agentId)?.state).toBe("settled");
    const output = await (createTaskOutputTool(tasks).execute as Function)("out", { task_id: taskId });
    expect(output.details.outcome).toBe("aborted");
    expect(tasks.drainSettlementNotices(() => true, () => {})).toEqual([]);
  });

  it("two concurrent TaskStop calls by task id and agent id join the same pending cleanup", async () => {
    const tasks = new BackgroundTaskRegistry();
    const registry = new SubagentRegistry();
    const agentId = "agent-333333333333";
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let abortCalls = 0;
    const taskId = tasks.start(
      "agent:reviewer",
      Promise.resolve({
        ok: false, outcome: "failed" as const, finalMessage: "", agentId,
        agentName: "reviewer", checkpointPaused: true, error: "paused",
      }),
      async () => { abortCalls += 1; await cleanup; },
      agentId,
      "reviewer",
    );
    await tasks.wait(taskId);
    registry.register({
      agentId, agentName: "reviewer", depth: 1, cwd: process.cwd(), resumable: true,
      oneShot: false, checkpointPaused: true,
      session: { recoverCheckpoint: async () => { throw new Error("unused"); }, stopCheckpoint: async () => cleanup },
    });
    const tool = createTaskStopTool(tasks, registry);
    let firstDone = false;
    let secondDone = false;
    const first = (tool.execute as Function)("stop-task", { task_id: taskId }).then((value: unknown) => {
      firstDone = true;
      return value;
    });
    const second = (tool.execute as Function)("stop-agent", { task_id: agentId }).then((value: unknown) => {
      secondDone = true;
      return value;
    });
    await Promise.resolve();
    expect({ firstDone, secondDone, abortCalls }).toEqual({ firstDone: false, secondDone: false, abortCalls: 1 });

    releaseCleanup();
    const [byTask, byAgent] = await Promise.all([first, second]);
    expect(byTask.details.status).toBe("stopped");
    expect(byAgent.details.checkpointPaused).toBe(true);
    expect(abortCalls).toBe(1);
  });

  it("agent-id TaskStop atomically suppresses its linked background result", async () => {
    const harness = checkpointSdk(3);
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry);
    const tasks = new BackgroundTaskRegistry();
    const agentId = "agent-222222222222";
    const taskId = tasks.start(
      "agent:reviewer",
      runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1, agentId }),
      () => runtime.stopCheckpoint(agentId),
      agentId,
      "reviewer",
    );
    await tasks.wait(taskId);

    await (createTaskStopTool(tasks, registry).execute as Function)("stop", { task_id: agentId });

    expect(tasks.get(taskId)).toMatchObject({ status: "stopped", settlementDelivery: "collected" });
    expect(tasks.drainSettlementNotices(() => true, () => {})).toEqual([]);
    expect(harness.disposed()).toBe(true);
  });

  it("lets a nested parent stop only its own paused foreground child", async () => {
    const parentId = "agent-aaaaaaaaaaaa";
    const childId = "agent-bbbbbbbbbbbb";
    const harness = checkpointSdk(3);
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry);
    await runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 2, agentId: childId,
      parentAgentId: parentId,
    });
    const own = scopedBackgroundTools(new BackgroundTaskRegistry(), parentId, registry).taskStop;

    await (own.execute as Function)("stop", { task_id: childId });

    expect(harness.disposed()).toBe(true);
    expect(registry.get(childId)?.state).toBe("settled");
  });

  it("session-local runtime shutdown joins all of its retained paused children", async () => {
    const first = checkpointSdk(3);
    const firstRegistry = new SubagentRegistry();
    const firstRuntime = runtimeFor(first, makeAgent(), firstRegistry);
    await firstRuntime.dispatch({ subagentType: "reviewer", prompt: "one", depth: 1 });

    const independent = checkpointSdk(3);
    const independentRuntime = runtimeFor(independent, makeAgent(), new SubagentRegistry());
    await independentRuntime.dispatch({ subagentType: "reviewer", prompt: "two", depth: 1 });

    await firstRuntime.shutdownCheckpointPaused();

    expect(first.disposed()).toBe(true);
    expect(independent.disposed()).toBe(false);
    await independentRuntime.shutdownCheckpointPaused();
  });
});

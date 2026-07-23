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
import { wrapForSelfShell } from "../src/runtime/tool-shell.js";

interface ChildHarness {
  sdk: PiSdk;
  compactCalls(): number;
  sessionCreations(): number;
  disposed(): boolean;
  aborted(): boolean;
  abortCalls(): number;
  compactionAbortCalls(): number;
  compactionAbortObserved(): Promise<void>;
  recoveryCompactStarted(): Promise<void>;
  releaseRecoveryCompact(): void;
  resumeCalls(): number;
  events(): string[];
  customMessages(): Array<{ customType: string; content: unknown }>;
  guardResults(): unknown[];
  providerRegistrations(): Array<{ name: string; config: Record<string, unknown> }>;
}

interface CheckpointSdkOptions {
  failures: number;
  recoveryReject?: "before" | "after";
  gateRecoveryCompact?: boolean;
  reExhaustOnce?: boolean;
  mixedBatch?: boolean;
  activateSkill?: boolean;
  reExhaustWithRestorationFailure?: boolean;
  replayReject?: boolean;
  resumedToolHook?: boolean;
  cancelBeforeCompactLifecycle?: boolean;
  gateProactiveCompact?: boolean;
  rejectAfterCompactEvent?: "proactive" | "manual";
}

function checkpointSdk({
  failures,
  recoveryReject,
  gateRecoveryCompact = false,
  reExhaustOnce = false,
  mixedBatch = false,
  activateSkill = false,
  reExhaustWithRestorationFailure = false,
  replayReject = false,
  resumedToolHook = false,
  cancelBeforeCompactLifecycle = false,
  gateProactiveCompact = false,
  rejectAfterCompactEvent,
}: CheckpointSdkOptions): ChildHarness {
  const base = fakeSdk().sdk;
  let compactions = 0;
  let creations = 0;
  let disposed = false;
  let aborted = false;
  let abortCalls = 0;
  let compactionAbortCalls = 0;
  let resumeCalls = 0;
  const events: string[] = [];
  const customMessages: Array<{ customType: string; content: unknown }> = [];
  const guardResults: unknown[] = [];
  const providerRegistrations: Array<{ name: string; config: Record<string, unknown> }> = [];
  let releaseRecoveryCompact!: () => void;
  let markRecoveryCompactStarted!: () => void;
  let markCompactionAbortObserved!: () => void;
  const recoveryCompactGate = new Promise<void>((resolve) => { releaseRecoveryCompact = resolve; });
  const recoveryCompactStarted = new Promise<void>((resolve) => { markRecoveryCompactStarted = resolve; });
  const compactionAbortObserved = new Promise<void>((resolve) => { markCompactionAbortObserved = resolve; });

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
        registerProvider(name: string, config: Record<string, unknown>) {
          providerRegistrations.push({ name, config });
        },
        sendMessage(message: { customType: string; content: unknown }) {
          customMessages.push({ customType: message.customType, content: message.content });
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
      let activeResumeAborted = false;
      const ctx = {
        model: { api: "openai-responses" },
        mode: "json",
        getContextUsage: () => compactions >= (reExhaustOnce
          ? 4
          : reExhaustWithRestorationFailure
            ? 3
            : failures >= 3 ? 2 : 1)
          ? ({ percent: 10, tokens: 100, contextWindow: 1000 })
          : ({ percent: 95, tokens: 950, contextWindow: 1000 }),
        hasPendingMessages: () => false,
        abort: () => {
          aborted = true;
          abortCalls += 1;
          if (resumed) activeResumeAborted = true;
        },
      };
      let resumed = false;
      let rejectedRecovery = false;
      let compactionAborted = false;
      const runResumed = async (): Promise<void> => {
        await emit("turn_start", {}, ctx);
        await emit("before_provider_request", {}, ctx);
        if (activateSkill) {
          await emit("tool_call", {
            toolName: "read", toolCallId: "post-compact-touch", input: { path: "sub/note.txt" },
          }, ctx);
        }
        if (resumedToolHook) {
          await emit("tool_call", {
            toolName: "CheckpointTool", toolCallId: "resumed-hook", input: {},
          }, ctx);
        }
        if (activeResumeAborted) {
          await emit("agent_settled", {}, ctx);
          return;
        }
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
            await emit("tool_call", {
              toolName: "read", toolCallId: "pre-compact-touch", input: { path: "sub/note.txt" },
            }, ctx);
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
          // A single session.compact() transaction represents Pi's complete
          // inner retry policy. `failures < 3` therefore recovers within this
          // invocation; `failures >= 3` exhausts it. Manual recovery is the next
          // invocation, and re-exhaustion is a later checkpoint transaction.
          if ((compactions === 1 && failures >= 3) || (reExhaustOnce && compactions === 3)) {
            throw new Error("compaction transaction failed");
          }
          if ((gateRecoveryCompact && compactions === (failures >= 3 ? 2 : 1)) ||
              (gateProactiveCompact && compactions === 1)) {
            events.push("compact-started");
            markRecoveryCompactStarted();
            await recoveryCompactGate;
            if (compactionAborted) throw new Error("compaction physically aborted");
          }
          if (cancelBeforeCompactLifecycle) {
            void emit("session_shutdown", {}, ctx);
            await Promise.resolve();
            await emit("session_compact", { compactionEntry: { summary: "stale summary" } }, ctx);
            await emit("tool_call", {
              toolName: "read", toolCallId: "stale-post-compact-touch", input: { path: "sub/note.txt" },
            }, ctx);
            return { summary: "stale summary" };
          }
          events.push("compact-commit");
          await emit("session_compact", { compactionEntry: { summary: "summary" } }, ctx);
          const manualRecoveryCompact = failures >= 3 && compactions === 2;
          if (rejectAfterCompactEvent === (manualRecoveryCompact ? "manual" : "proactive")) {
            throw new Error("compact rejected after committed event");
          }
          return { summary: "summary" };
        },
        async sendCustomMessage(
          message: { customType: string; content: unknown; display: boolean },
          sendOptions?: { triggerTurn?: boolean },
        ) {
          if (sendOptions?.triggerTurn) {
            resumed = true;
            activeResumeAborted = false;
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
            if (message.customType === "picc-retained-parent-input") {
              events.push("queued-replay");
              if (replayReject) throw new Error("retained replay rejected");
            }
            customMessages.push({ customType: message.customType, content: message.content });
            messages.push({ role: "custom", content: message.content });
          }
        },
        steer() {},
        followUp() {},
        abort() {
          aborted = true;
          abortCalls += 1;
          if (resumed) activeResumeAborted = true;
        },
        abortCompaction() {
          compactionAbortCalls += 1;
          compactionAborted = true;
          markCompactionAbortObserved();
          if (!gateProactiveCompact) releaseRecoveryCompact();
        },
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
    abortCalls: () => abortCalls,
    compactionAbortCalls: () => compactionAbortCalls,
    compactionAbortObserved: () => compactionAbortObserved,
    recoveryCompactStarted: () => recoveryCompactStarted,
    releaseRecoveryCompact: () => releaseRecoveryCompact(),
    resumeCalls: () => resumeCalls,
    events: () => [...events],
    customMessages: () => [...customMessages],
    guardResults: () => [...guardResults],
    providerRegistrations: () => [...providerRegistrations],
  };
}

function runtimeFor(
  harness: ChildHarness,
  agent: ClaudeAgent = makeAgent(),
  subagentRegistry?: SubagentRegistry,
  failPostCompactAttempt?: number,
  customHookRunner?: { fire(eventName: string): Promise<any> },
  capturedStopFactories?: Array<() => () => boolean>,
  enableResume = false,
) {
  let postCompactAttempts = 0;
  const transcriptPath = path.join(process.cwd(), "package.json");
  const sdk = enableResume
    ? {
        ...harness.sdk,
        persistedSessionManager: () => ({ getSessionFile: () => transcriptPath }),
        reopenSessionManager: () => ({ getSessionFile: () => transcriptPath }),
      }
    : harness.sdk;
  return makeSubagentRuntime([agent], sdk, {
    ...(enableResume ? { getMainSessionFile: () => transcriptPath } : {}),
    proactiveCompactPercent: 90,
    allKnownToolNames: () => ["CheckpointTool"],
    subagentRegistry,
    hookRunner: customHookRunner ?? (failPostCompactAttempt === undefined ? undefined : {
      async fire(eventName: string) {
        const block = eventName === "PostCompact" && ++postCompactAttempts === failPostCompactAttempt;
        return { block, blockReason: block ? "restoration rejected" : undefined, askDowngraded: false, diagnostics: [] };
      },
    }),
    customToolsFor: (_agent, _granted, _depth, _owner, _fork, _cwd, _activation, captureStop) => {
      if (captureStop && capturedStopFactories) capturedStopFactories.push(captureStop);
      return [
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
    ];
    },
  });
}

describe("subagent mid-run compaction", () => {
  it("physically aborts and joins a child scheduled retry without a late commit or continuation", async () => {
    const harness = checkpointSdk({ failures: 0, gateProactiveCompact: true });
    const abort = new AbortController();
    const running = runtimeFor(harness).dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1, abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    let settled = false;
    const settlement = running.then((result) => {
      settled = true;
      return result;
    });
    abort.abort();
    await harness.compactionAbortObserved();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(harness.compactionAbortCalls()).toBeGreaterThanOrEqual(1);
    expect(harness.events()).not.toContain("compact-commit");
    expect(harness.events()).not.toContain("resumed-provider");
    harness.releaseRecoveryCompact();
    const result = await settlement;

    expect(result.outcome).toBe("aborted");
    expect(harness.compactCalls()).toBe(1);
    expect(harness.compactionAbortCalls()).toBeGreaterThanOrEqual(1);
    expect(harness.resumeCalls()).toBe(0);
    expect(harness.events()).not.toContain("compact-commit");
    expect(harness.events()).not.toContain("resumed-provider");
    expect(harness.customMessages().some((message) =>
      message.customType === "picc-checkpoint-resume" || message.customType === "picc-preserved")).toBe(false);
  });

  it("terminalizes a child proactive commit before a later compact rejection", async () => {
    const harness = checkpointSdk({ failures: 0, rejectAfterCompactEvent: "proactive" });
    const result = await runtimeFor(harness).dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/replacement|Do not compact/iu);
    expect(harness.compactCalls()).toBe(1);
    expect(harness.resumeCalls()).toBe(0);
    expect(harness.events()).not.toContain("resumed-provider");
  });

  it("delegates Pi-owned retries within one compact transaction and resumes the same child", async () => {
    const harness = checkpointSdk({ failures: 1 });
    const result = await runtimeFor(harness).dispatch({
      subagentType: "reviewer",
      prompt: "review",
      depth: 1,
    });

    expect(result.outcome).toBe("completed");
    expect(result.finalMessage).toBe("resumed final");
    expect(harness.compactCalls()).toBe(1);
    expect(harness.sessionCreations()).toBe(1);
    expect(harness.providerRegistrations()).toEqual([
      expect.objectContaining({
        name: "picc-codex-abort-guard",
        config: expect.objectContaining({ api: "openai-codex-responses", streamSimple: expect.any(Function) }),
      }),
    ]);
    expect(harness.disposed()).toBe(true);
  });

  it("cancels a child operation while PreCompact is awaited without resuming", async () => {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const hooks = {
      async fire(eventName: string) {
        if (eventName === "PreCompact") {
          markEntered();
          await released;
        }
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const harness = checkpointSdk({ failures: 0 });
    const abort = new AbortController();
    const dispatch = runtimeFor(harness, makeAgent(), undefined, undefined, hooks).dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1, abortSignal: abort.signal,
    });
    await entered;
    abort.abort();
    release();
    const result = await dispatch;
    expect(result.outcome).toBe("aborted");
    expect(harness.resumeCalls()).toBe(0);
    expect(harness.events()).not.toContain("resumed-provider");
  });

  it("surfaces PostCompact diagnostics without injecting output and ignores its ordinary block decision", async () => {
    const harness = checkpointSdk({ failures: 0 });
    const hooks = {
      async fire(eventName: string) {
        if (eventName === "SessionStart") {
          return { block: false, askDowngraded: false, stdout: "session context", diagnostics: [] };
        }
        if (eventName === "PostCompact") {
          return {
            block: true,
            blockReason: "ordinary post decision",
            askDowngraded: false,
            stdout: "post stdout",
            additionalContext: "post context",
            systemMessages: ["post visible"],
            diagnostics: [{ severity: "warning" as const, message: "post diagnostic" }],
          };
        }
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const result = await runtimeFor(harness, makeAgent(), undefined, undefined, hooks).dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
    });
    expect(result.outcome).toBe("completed");
    expect(harness.customMessages()).toEqual([
      expect.objectContaining({ customType: "picc-hook-context", content: "session context" }),
    ]);
    expect(harness.customMessages()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining("post stdout") }),
      expect.objectContaining({ content: expect.stringContaining("post context") }),
    ]));
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "post diagnostic" }),
      expect.objectContaining({ message: "hook (PostCompact): post visible" }),
    ]));
  });

  it("unwinds a resumed child PreToolUse universal stop before deferred cancellation join", async () => {
    const harness = checkpointSdk({ failures: 0, resumedToolHook: true });
    const hooks = {
      async fire(eventName: string) {
        return eventName === "PreToolUse"
          ? { stop: true, stopReason: "resumed child stopped", block: false, askDowngraded: false, diagnostics: [] }
          : { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const result = await runtimeFor(harness, makeAgent(), undefined, undefined, hooks).dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
    });
    expect(result.outcome).toBe("aborted");
    expect(result.error).toContain("universal hook");
    expect(harness.events()).not.toContain("resumed-provider");
  });

  it("ignores stale child compact reset, then resets child-local context on current successful compaction", async () => {
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
    write("sub/CLAUDE.md", "CHILD-NESTED-INSTRUCTIONS\n");
    write(".claude/rules/child-path.md", "---\npaths:\n  - sub/**\n---\nCHILD-PATH-INSTRUCTIONS\n");
    write("sub/note.txt", "touch\n");
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
    const staleHarness = checkpointSdk({ failures: 0, activateSkill: true, cancelBeforeCompactLifecycle: true });
    const harness = checkpointSdk({ failures: 1, activateSkill: true });
    const childPi = fakePi();
    let runtime!: ReturnType<typeof runtimeFor>;
    try {
      process.chdir(dir);
      process.env.PICC_CLAUDE_USER_DIR = path.join(dir, ".user");
      picc(childPi.api as never, {
        sdk: staleHarness.sdk,
        onInitializationSettled: childPi.captureInitialization,
        onWired: ({ subagentRuntime }) => { runtime = subagentRuntime; },
      });
      await childPi.waitForInitialization();
      const stale = await runtime.dispatch({ subagentType: "reviewer", prompt: "stale compact", depth: 1 });
      expect(stale.outcome).toBe("completed");
      const staleContext = staleHarness.customMessages().filter((message) => message.customType === "picc-context");
      expect(staleContext.filter((message) => String(message.content).includes("CHILD-NESTED-INSTRUCTIONS"))).toHaveLength(1);
      expect(staleContext.filter((message) => String(message.content).includes("CHILD-PATH-INSTRUCTIONS"))).toHaveLength(1);

      runtime.setSdkForTest(harness.sdk);
      const child = await runtime.dispatch({ subagentType: "reviewer", prompt: "activate", depth: 1 });
      expect(child.outcome).toBe("completed");
      expect(harness.customMessages().find((message) => message.customType === "picc-preserved")?.content)
        .toContain("CHILD-SKILL-BODY example.com");
      expect(harness.customMessages().filter((message) =>
        message.customType === "picc-context" && String(message.content).includes("CHILD-NESTED-INSTRUCTIONS"),
      )).toHaveLength(2);
      expect(harness.customMessages().filter((message) =>
        message.customType === "picc-context" && String(message.content).includes("CHILD-PATH-INSTRUCTIONS"),
      )).toHaveLength(2);
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
    const harness = checkpointSdk({ failures: 1, gateRecoveryCompact: true, mixedBatch: true });
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

  it("aborts and joins the child before publishing a retained-replay failure", async () => {
    const harness = checkpointSdk({ failures: 1, gateRecoveryCompact: true, replayReject: true });
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry);
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
      agentId: "agent-666666666666",
    });
    await harness.recoveryCompactStarted();
    const send = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks: new BackgroundTaskRegistry(),
    });
    await (send.execute as Function)("send-queued", {
      to: "agent-666666666666",
      message: "parent message that replay rejects",
    });
    harness.releaseRecoveryCompact();
    const result = await dispatch;

    expect(result).toMatchObject({ outcome: "failed", checkpointPaused: true });
    expect(harness.aborted()).toBe(true);
    expect(harness.events()).toContain("queued-replay");
    expect(harness.events()).not.toContain("resumed-provider");
    expect(registry.get("agent-666666666666")?.checkpointPaused).toBe(true);
  });

  it("returns an actionable paused failure with ordered progress after bounded exhaustion", async () => {
    const harness = checkpointSdk({ failures: 3 });
    const progress: string[] = [];
    const result = await runtimeFor(harness).dispatch({
      subagentType: "reviewer",
      prompt: "review",
      depth: 1,
      onProgress: (snapshot) => progress.push(snapshot.activity ?? ""),
    });

    expect(result.outcome).toBe("failed");
    expect(progress).toEqual([
      "checkpoint: checkpoint-armed",
      "checkpoint paused: recovery required",
    ]);
    expect(result.checkpointPaused).toBe(true);
    expect(result.error).toContain("paused and no continuation ran");
    expect(harness.compactCalls()).toBe(1);
    expect(harness.sessionCreations()).toBe(1);
    expect(harness.disposed()).toBe(false);
    expect(harness.aborted()).toBe(false);
  });

  it("makes awaited SendMessage own and return the classified retained recovery result", async () => {
    const harness = checkpointSdk({ failures: 3 });
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry);
    const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    const background = new BackgroundTaskRegistry();
    const tool = createSendMessageToolDefinition(runtime, { registry, backgroundTasks: background });

    const recovered = await (tool.execute as Function)("send-1", {
      to: exhausted.agentId,
      message: "finish recovery",
    });
    const canonicalRecovered = structuredClone(recovered);

    expect(recovered.content[0].text).toBe("resumed final");
    expect(recovered.details).toMatchObject({
      agentId: exhausted.agentId,
      delivery: "checkpoint-recovery",
      outcome: "completed",
      recovered: true,
    });
    const wrapped = wrapForSelfShell(tool);
    const rendered = (wrapped.renderResult as Function)(
      recovered,
      { expanded: false, isPartial: false },
      undefined,
      { state: {}, isPartial: false },
    ).render(80) as string[];
    expect(rendered).toEqual(["● resumed final"]);
    expect(rendered.join("\n").match(/[○●✗■]/gu) ?? []).toHaveLength(1);
    expect(recovered).toEqual(canonicalRecovered);
    expect(background.ids()).toEqual([]);
    expect(harness.compactCalls()).toBe(2);
    expect(harness.disposed()).toBe(true);
    expect(registry.get(exhausted.agentId)?.state).toBe("settled");
  });

  it("revokes the original paused generation after SendMessage recovery cleanup", async () => {
    const harness = checkpointSdk({ failures: 3 });
    const registry = new SubagentRegistry();
    const stopFactories: Array<() => () => boolean> = [];
    const runtime = runtimeFor(harness, makeAgent(), registry, undefined, undefined, stopFactories);
    const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    const oldAuthority = stopFactories[0]!();
    const send = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks: new BackgroundTaskRegistry(),
    });

    const recovered = await (send.execute as Function)("send", {
      to: exhausted.agentId,
      message: "finish retained recovery",
    });
    expect(recovered.details.outcome).toBe("completed");

    const later = await runtime.dispatch({ subagentType: "reviewer", prompt: "later run", depth: 1 });
    const abortsBeforeLateStop = harness.abortCalls();
    expect(oldAuthority()).toBe(false);
    expect(harness.abortCalls()).toBe(abortsBeforeLateStop);
    expect(later.outcome).toBe("completed");
    expect(stopFactories).toHaveLength(2);
  });

  it("scopes SendMessage resume authority to each active generation until true settlement", async () => {
    const harness = checkpointSdk({ failures: 0 });
    const registry = new SubagentRegistry();
    const stopFactories: Array<() => () => boolean> = [];
    let initialAuthority!: () => boolean;
    let settledResumeAuthority!: () => boolean;
    let activeResumeAuthority!: () => boolean;
    let stopCount = 0;
    let enterSecond!: () => void;
    let releaseSecond!: () => void;
    let enterThird!: () => void;
    let releaseThird!: () => void;
    const secondEntered = new Promise<void>((resolve) => { enterSecond = resolve; });
    const secondRelease = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const thirdEntered = new Promise<void>((resolve) => { enterThird = resolve; });
    const thirdRelease = new Promise<void>((resolve) => { releaseThird = resolve; });
    const hooks = {
      async fire(eventName: string) {
        if (eventName === "SubagentStop") {
          stopCount += 1;
          if (stopCount === 1) {
            initialAuthority = stopFactories[0]!();
          } else if (stopCount === 2) {
            settledResumeAuthority = stopFactories[1]!();
            enterSecond();
            await secondRelease;
          } else if (stopCount === 3) {
            activeResumeAuthority = stopFactories[2]!();
            enterThird();
            await thirdRelease;
          }
        }
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const runtime = runtimeFor(harness, makeAgent(), registry, undefined, hooks, stopFactories, true);
    const initial = await runtime.dispatch({ subagentType: "reviewer", prompt: "initial", depth: 1 });
    const background = new BackgroundTaskRegistry();
    const send = createSendMessageToolDefinition(runtime, { registry, backgroundTasks: background });

    const firstResume = await (send.execute as Function)("send-1", {
      to: initial.agentId,
      message: "first resumed generation",
    });
    await secondEntered;
    releaseSecond();
    await background.wait(firstResume.details.taskId);
    expect(initialAuthority()).toBe(false);
    expect(settledResumeAuthority()).toBe(false);

    const secondResume = await (send.execute as Function)("send-2", {
      to: initial.agentId,
      message: "second resumed generation",
    });
    await thirdEntered;
    expect(activeResumeAuthority()).toBe(true);
    releaseThird();
    await background.wait(secondResume.details.taskId);
  });

  it("terminalizes manual child recovery when session_compact commits before compact rejects", async () => {
    const harness = checkpointSdk({ failures: 3, rejectAfterCompactEvent: "manual" });
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry);
    const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    const send = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks: new BackgroundTaskRegistry(),
    });

    await expect((send.execute as Function)("send-1", {
      to: exhausted.agentId,
      message: "recover once",
    })).rejects.toThrow(/Do not compact it again/iu);
    expect(harness.compactCalls()).toBe(2);
    await expect((send.execute as Function)("send-2", {
      to: exhausted.agentId,
      message: "must not compact twice",
    })).rejects.toThrow(/Do not compact it again|replacement/iu);
    expect(harness.compactCalls()).toBe(2);
  });

  it.each(["before", "after"] as const)(
    "closes recovery when sendCustomMessage rejects %s turn_start after commit",
    async (when) => {
      const harness = checkpointSdk({ failures: 3, recoveryReject: when });
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
      })).rejects.toThrow(/Do not compact it again or retry SendMessage/);
      expect(registry.get(exhausted.agentId)?.checkpointPaused).toBe(true);
      expect(harness.disposed()).toBe(false);
      expect(harness.compactCalls()).toBe(2);

      await expect((tool.execute as Function)("send-2", {
        to: exhausted.agentId,
        message: "retry recovery",
      })).rejects.toThrow(/Do not compact it again or retry SendMessage/);
      expect(harness.compactCalls()).toBe(2);
    },
  );

  it("keeps the original retained owner when a recovery continuation re-exhausts", async () => {
    const harness = checkpointSdk({ failures: 3, reExhaustOnce: true });
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
    const canonical = structuredClone(reExhausted);
    expect(reExhausted.details).toMatchObject({
      delivery: "checkpoint-recovery",
      outcome: "failed",
      recovered: false,
    });
    const wrapped = wrapForSelfShell(tool);
    const rendered = (wrapped.renderResult as Function)(
      reExhausted,
      { expanded: false, isPartial: false },
      undefined,
      { state: {}, isPartial: false },
    ).render(120) as string[];
    expect(rendered[0]).toMatch(/^✗ /u);
    expect(rendered.join("\n").match(/[○●✗■]/gu) ?? []).toHaveLength(1);
    expect(reExhausted).toEqual(canonical);
    expect(registry.get(exhausted.agentId)?.checkpointPaused).toBe(true);
    expect(harness.disposed()).toBe(false);

    const recovered = await (tool.execute as Function)("send-2", {
      to: exhausted.agentId,
      message: "recover again",
    });
    expect(recovered.details).toMatchObject({ outcome: "completed", recovered: true });
    expect(harness.sessionCreations()).toBe(1);
    expect(harness.compactCalls()).toBe(4);
    expect(harness.disposed()).toBe(true);
  });

  it("renders an actual SendMessage aborted checkpoint result as stopped without changing it", async () => {
    const harness = checkpointSdk({ failures: 3 });
    const registry = new SubagentRegistry();
    const hooks = {
      async fire(eventName: string) {
        const stop = eventName === "SubagentStop";
        return {
          block: false,
          stop,
          stopReason: stop ? "stop recovered generation" : undefined,
          askDowngraded: false,
          diagnostics: [],
        };
      },
    };
    const runtime = runtimeFor(harness, makeAgent(), registry, undefined, hooks);
    const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    const tool = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks: new BackgroundTaskRegistry(),
    });
    const aborted = await (tool.execute as Function)("send", {
      to: exhausted.agentId,
      message: "recover then stop",
    });
    const canonical = structuredClone(aborted);
    expect(aborted.details).toMatchObject({
      delivery: "checkpoint-recovery",
      outcome: "aborted",
      recovered: false,
    });
    const wrapped = wrapForSelfShell(tool);
    const rendered = (wrapped.renderResult as Function)(
      aborted,
      { expanded: false, isPartial: false },
      undefined,
      { state: {}, isPartial: false },
    ).render(120) as string[];
    expect(rendered[0]).toMatch(/^■ /u);
    expect(rendered.join("\n").match(/[○●✗■]/gu) ?? []).toHaveLength(1);
    expect(aborted).toEqual(canonical);
  });

  it("preserves terminal restoration guidance when a recovery continuation rejects after re-exhaustion", async () => {
    const harness = checkpointSdk({ failures: 3, recoveryReject: "after", reExhaustWithRestorationFailure: true });
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry, 2);
    const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    const tool = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks: new BackgroundTaskRegistry(),
    });

    let message = "";
    try {
      await (tool.execute as Function)("send-1", {
        to: exhausted.agentId,
        message: "recover into restoration failure",
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("Do not compact it again or retry SendMessage");
    expect(message).toContain(`TaskStop using agent id ${exhausted.agentId}`);
    expect(message).toContain("dispatch a replacement agent with the retained input");
    expect(message).not.toContain("Recovery continuation failed");
    expect(message).not.toContain("The agent remains paused; retry SendMessage");
    expect(registry.get(exhausted.agentId)?.checkpointPaused).toBe(true);
    expect(harness.compactCalls()).toBe(3);
    expect(harness.disposed()).toBe(false);
  });

  it("accepts a retained foreground agent id in TaskStop and joins before disposal", async () => {
    const harness = checkpointSdk({ failures: 3 });
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

  it("revokes the original paused generation after TaskStop abandonment cleanup", async () => {
    const harness = checkpointSdk({ failures: 3 });
    const registry = new SubagentRegistry();
    const stopFactories: Array<() => () => boolean> = [];
    const runtime = runtimeFor(harness, makeAgent(), registry, undefined, undefined, stopFactories);
    const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    const oldAuthority = stopFactories[0]!();

    await (createTaskStopTool(new BackgroundTaskRegistry(), registry).execute as Function)("stop", {
      task_id: exhausted.agentId,
    });
    const later = await runtime.dispatch({ subagentType: "reviewer", prompt: "replacement run", depth: 1 });
    const abortsBeforeLateStop = harness.abortCalls();
    expect(oldAuthority()).toBe(false);
    expect(harness.abortCalls()).toBe(abortsBeforeLateStop);
    expect(later.outcome).toBe("completed");
    expect(stopFactories).toHaveLength(2);
  });

  it("TaskStop during manual recovery joins it and forbids a late continuation", async () => {
    const harness = checkpointSdk({ failures: 3, gateRecoveryCompact: true });
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

    const stopTool = createTaskStopTool(new BackgroundTaskRegistry(), registry);
    const stopped = await (stopTool.execute as Function)("stop", {
      task_id: exhausted.agentId,
    });
    const canonicalStop = structuredClone(stopped);
    expect(stopped.details).toMatchObject({
      agentId: exhausted.agentId,
      checkpointPaused: true,
      status: "stopped",
    });
    const wrappedStop = wrapForSelfShell(stopTool);
    const renderedStop = (wrappedStop.renderResult as Function)(
      stopped,
      { expanded: false, isPartial: false },
      undefined,
      { state: {}, isPartial: false },
    ).render(120) as string[];
    expect(renderedStop[0]).toMatch(/^■ /u);
    expect(renderedStop.join("\n").match(/[○●✗■]/gu) ?? []).toHaveLength(1);
    expect(stopped).toEqual(canonicalStop);

    await expect(recovery).rejects.toThrow(/cancelled/);
    expect(harness.resumeCalls()).toBe(0);
    expect(harness.disposed()).toBe(true);
    expect(registry.get(exhausted.agentId)?.state).toBe("settled");
  });

  it("TaskStop by task id joins retained cleanup and leaves one stopped generation", async () => {
    const harness = checkpointSdk({ failures: 3 });
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
    const harness = checkpointSdk({ failures: 3 });
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
    const harness = checkpointSdk({ failures: 3 });
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
    const first = checkpointSdk({ failures: 3 });
    const firstRegistry = new SubagentRegistry();
    const firstRuntime = runtimeFor(first, makeAgent(), firstRegistry);
    await firstRuntime.dispatch({ subagentType: "reviewer", prompt: "one", depth: 1 });

    const independent = checkpointSdk({ failures: 3 });
    const independentRuntime = runtimeFor(independent, makeAgent(), new SubagentRegistry());
    await independentRuntime.dispatch({ subagentType: "reviewer", prompt: "two", depth: 1 });

    await firstRuntime.shutdownCheckpointPaused();

    expect(first.disposed()).toBe(true);
    expect(independent.disposed()).toBe(false);
    await independentRuntime.shutdownCheckpointPaused();
  });
});

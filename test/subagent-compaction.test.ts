import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc from "../src/index.js";
import type { ClaudeAgent } from "../src/types.js";
import type { PiSdk, PiSessionMessage } from "../src/runtime/subagents.js";
import type {
  CheckpointProgress,
  HostDeadlineClock,
  HostDeadlinePolicy,
  MidRunCompactionController,
} from "../src/runtime/mid-run-compaction.js";
import { createSendMessageToolDefinition } from "../src/runtime/subagents.js";
import {
  BackgroundTaskRegistry,
  createTaskOutputTool,
  createTaskStopTool,
  scopedBackgroundTools,
} from "../src/runtime/background-tasks.js";
import { SubagentRegistry } from "../src/runtime/subagent-registry.js";
import { createRetainedInputReport } from "../src/runtime/retained-input-report.js";
import { fakeSdk, makeAgent, makeSubagentRuntime } from "./helpers/fake-sdk.js";
import { fakePi } from "./helpers/fake-pi.js";
import { wrapForSelfShell } from "../src/runtime/tool-shell.js";
import { settlement, waitUntil } from "./helpers/async.js";

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
  customMessages(): Array<{ customType: string; content: unknown; details?: unknown }>;
  physicalSends(): Array<{ customType: string; options?: Record<string, unknown> }>;
  guardResults(): unknown[];
  providerRegistrations(): Array<{ name: string; config: Record<string, unknown> }>;
  providerAttempts(): number;
  admittedProviderRequests(): number;
  fabricatedResponses(): number;
  checkpointToolStarted(): Promise<void>;
  releaseCheckpointTool(): void;
  executeCheckpointTool(): Promise<Record<string, unknown>>;
  providerBoundaryBlocked(): Promise<void>;
  releaseProviderBlock(): void;
  resumedRunStarted(): Promise<void>;
  releaseResumedRun(): void;
  triggerInvocationStarted(): Promise<void>;
  releaseTriggerStart(): void;
  injectSyntheticInvalidReplayCallbacks(): Promise<void>;
  replaySendStarted(): Promise<void>;
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
  assistantUsage?: "high" | "low";
  highAtProviderBoundary?: boolean;
  holdCheckpointTool?: boolean;
  holdAfterProviderBlock?: boolean;
  cancelResumedRun?: boolean;
  gateResumedRun?: boolean;
  purgeThrows?: boolean;
  consumeRetainedReplay?: boolean;
  delayTriggerStart?: boolean;
  stallCancellationPhase?: "non-trigger" | "trigger" | "abort" | "run" | "final-settlement" | "evidence";
  triggerEventVariant?: "valid" | "missing" | "stale" | "duplicate" | "wrong-content" | "wrong-role" | "wrong-type" | "unscrubbable";
  terminalEvidenceVariant?: "valid" | "duplicate-end" | "duplicate-settled" | "wrong-end" | "late-end" | "wrong-run";
  replayEventVariant?: "valid" | "stale" | "duplicate" | "wrong-content" | "wrong-role" | "wrong-type" | "unscrubbable";
  intervalHooks?: {
    afterPurge?: () => void;
    afterAbort?: () => void;
    afterAgentEnd?: () => void;
    afterAgentSettled?: () => void;
  };
  onCleanup?: () => void;
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
  assistantUsage = "high",
  highAtProviderBoundary = false,
  holdCheckpointTool = false,
  holdAfterProviderBlock = false,
  cancelResumedRun = false,
  gateResumedRun = false,
  purgeThrows = false,
  consumeRetainedReplay = true,
  delayTriggerStart = false,
  stallCancellationPhase,
  triggerEventVariant = "valid",
  terminalEvidenceVariant = "valid",
  replayEventVariant = "valid",
  intervalHooks,
  onCleanup,
}: CheckpointSdkOptions): ChildHarness {
  const base = fakeSdk().sdk;
  let compactions = 0;
  let creations = 0;
  let disposed = false;
  let aborted = false;
  let abortCalls = 0;
  let compactionAbortCalls = 0;
  let resumeCalls = 0;
  let providerAttempts = 0;
  let admittedProviderRequests = 0;
  let fabricatedResponses = 0;
  const events: string[] = [];
  const customMessages: Array<{ customType: string; content: unknown; details?: unknown }> = [];
  const physicalSends: Array<{ customType: string; options?: Record<string, unknown> }> = [];
  const guardResults: unknown[] = [];
  const providerRegistrations: Array<{ name: string; config: Record<string, unknown> }> = [];
  const pendingReplayStarts: Array<{
    message: Record<string, unknown>;
    ctx: unknown;
    delivery: "steer" | "followUp";
    replayEnvelope?: unknown;
  }> = [];
  const clearedReplayStarts: Array<{ message: Record<string, unknown>; ctx: unknown }> = [];
  let emitPendingReplay: ((message: Record<string, unknown>, ctx: unknown) => Promise<void>) | undefined;
  let releaseRecoveryCompact!: () => void;
  let markRecoveryCompactStarted!: () => void;
  let markCompactionAbortObserved!: () => void;
  let markCheckpointToolStarted!: () => void;
  let releaseCheckpointTool!: () => void;
  let markProviderBoundaryBlocked!: () => void;
  let releaseProviderBlock!: () => void;
  let markResumedRunStarted!: () => void;
  let releaseResumedRun!: () => void;
  let markTriggerInvocationStarted!: () => void;
  let releaseTriggerStart!: () => void;
  let markReplaySendStarted!: () => void;
  const recoveryCompactGate = new Promise<void>((resolve) => { releaseRecoveryCompact = resolve; });
  const recoveryCompactStarted = new Promise<void>((resolve) => { markRecoveryCompactStarted = resolve; });
  const compactionAbortObserved = new Promise<void>((resolve) => { markCompactionAbortObserved = resolve; });
  const checkpointToolStarted = new Promise<void>((resolve) => { markCheckpointToolStarted = resolve; });
  const checkpointToolGate = new Promise<void>((resolve) => { releaseCheckpointTool = resolve; });
  const providerBoundaryBlocked = new Promise<void>((resolve) => { markProviderBoundaryBlocked = resolve; });
  const providerBlockGate = new Promise<void>((resolve) => { releaseProviderBlock = resolve; });
  const resumedRunStarted = new Promise<void>((resolve) => { markResumedRunStarted = resolve; });
  const resumedRunGate = new Promise<void>((resolve) => { releaseResumedRun = resolve; });
  const triggerInvocationStarted = new Promise<void>((resolve) => { markTriggerInvocationStarted = resolve; });
  const triggerStartGate = new Promise<void>((resolve) => { releaseTriggerStart = resolve; });
  const replaySendStarted = new Promise<void>((resolve) => { markReplaySendStarted = resolve; });
  const never = new Promise<void>(() => undefined);

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
      emitPendingReplay = async (message, eventCtx) => {
        await emit("message_start", { type: "message_start", message }, eventCtx);
      };
      const advanceAgentLoop = async (): Promise<void> => {
        if (!consumeRetainedReplay) return;
        const pending = pendingReplayStarts.splice(0);
        for (const entry of pending) {
          await emitPendingReplay?.(entry.message, entry.ctx);
          if (replayEventVariant === "duplicate") {
            (entry.message.details as Record<string, unknown>).piccCheckpointInput = entry.replayEnvelope;
            await emitPendingReplay?.(entry.message, entry.ctx);
          }
        }
      };
      let activeResumeAborted = false;
      let contextHigh = false;
      let contextUsageKnown = true;
      const ctx = {
        model: { api: "openai-responses", contextWindow: 1000 },
        mode: "json",
        getContextUsage: () => !contextUsageKnown
          ? undefined
          : !contextHigh || compactions >= (reExhaustOnce
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
        providerAttempts += 1;
        await emit("before_provider_request", {}, ctx);
        if (gateResumedRun) {
          events.push("resumed-run-started");
          markResumedRunStarted();
          await resumedRunGate;
        }
        await advanceAgentLoop();
        if (!activeResumeAborted) admittedProviderRequests += 1;
        if (activateSkill) {
          await emit("tool_call", {
            toolName: "read", toolCallId: "post-compact-touch", input: { path: "sub/note.txt" },
          }, ctx);
        }
        if (resumedToolHook) {
          events.push("resumed-tool-progress");
          await emit("tool_call", {
            toolName: "CheckpointTool", toolCallId: "resumed-hook", input: {},
          }, ctx);
        }
        if (activeResumeAborted || cancelResumedRun) {
          const abortedAssistant: PiSessionMessage = {
            role: "assistant",
            content: [],
            stopReason: "aborted",
          };
          messages.push(abortedAssistant);
          await emit("message_end", { message: abortedAssistant }, ctx);
          const terminalForEvidence = terminalEvidenceVariant === "wrong-end"
            ? { ...abortedAssistant, stopReason: "stop" }
            : abortedAssistant;
          if (terminalEvidenceVariant === "late-end" && stallCancellationPhase !== "final-settlement") {
            await emit("agent_settled", {}, ctx);
          }
          if (stallCancellationPhase !== "evidence") {
            await emit("agent_end", { messages: [terminalForEvidence] }, ctx);
            intervalHooks?.afterAgentEnd?.();
            if (terminalEvidenceVariant === "duplicate-end") {
              await emit("agent_end", { messages: [terminalForEvidence] }, ctx);
            }
          }
          if (terminalEvidenceVariant !== "late-end" &&
              stallCancellationPhase !== "final-settlement" && stallCancellationPhase !== "evidence") {
            await emit("agent_settled", {}, ctx);
            intervalHooks?.afterAgentSettled?.();
            if (terminalEvidenceVariant === "duplicate-settled") await emit("agent_settled", {}, ctx);
          }
          if (terminalEvidenceVariant === "wrong-run") throw new Error("wrong resumed run settlement");
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
        if (reExhaustOnce || reExhaustWithRestorationFailure) {
          contextUsageKnown = true;
          contextHigh = true;
        }
        await emit("agent_settled", {}, ctx);
      };
      const session = {
        messages,
        async prompt(text: string) {
          const user: PiSessionMessage = { role: "user", content: text };
          messages.push(user);
          await emit("message_start", { type: "message_start", message: user }, ctx);
          await emit("turn_start", {}, ctx);
          providerAttempts += 1;
          await emit("before_provider_request", {}, ctx);
          if (!aborted) admittedProviderRequests += 1;
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
          const assistant = {
            role: "assistant",
            content: calls.map((name, index) => ({
              type: "toolCall" as const, id: `call-${index + 1}`, name, arguments: {},
            })),
            stopReason: "toolUse",
            usage: {
              input: assistantUsage === "high" ? 950 : 100,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: assistantUsage === "high" ? 950 : 100,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          } as unknown as PiSessionMessage;
          messages.push(assistant);
          contextHigh = false;
          contextUsageKnown = !(assistantUsage === "high" && !highAtProviderBoundary);
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
          if (highAtProviderBoundary) {
            contextUsageKnown = true;
            contextHigh = false;
            await emit("turn_start", {}, ctx);
            contextHigh = true;
            for (let signal = 0; signal < 2; signal += 1) {
              providerAttempts += 1;
              await emit("before_provider_request", {}, ctx);
              if (!aborted) admittedProviderRequests += 1;
            }
            markProviderBoundaryBlocked();
            if (holdAfterProviderBlock) await providerBlockGate;
            if (!aborted) {
              fabricatedResponses += 1;
              messages.push({
                role: "assistant",
                content: [{ type: "text", text: "unexpected ordinary response" }],
                stopReason: "stop",
              });
            }
          }
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
          contextUsageKnown = true;
          contextHigh = false;
          const manualRecoveryCompact = failures >= 3 && compactions === 2;
          if (rejectAfterCompactEvent === (manualRecoveryCompact ? "manual" : "proactive")) {
            throw new Error("compact rejected after committed event");
          }
          return { summary: "summary" };
        },
        async sendCustomMessage(
          message: { customType: string; content: unknown; display: boolean; details?: unknown },
          sendOptions?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
        ) {
          physicalSends.push({
            customType: message.customType,
            ...(sendOptions ? { options: { ...sendOptions } } : {}),
          });
          // Installed Pi's message_start event carries the custom message but no delivery mode.
          const startedMessage: Record<string, any> = { role: "custom", ...message };
          const originalTriggerEnvelope = (message.details as any)?.piccCheckpointResume;
          const originalReplayEnvelope = (message.details as any)?.piccCheckpointInput;
          const retainedReplay = message.customType === "picc-retained-parent-input";
          if (sendOptions?.triggerTurn) {
            resumed = true;
            activeResumeAborted = false;
            markTriggerInvocationStarted();
          }
          if (sendOptions?.triggerTurn && (delayTriggerStart || stallCancellationPhase === "trigger")) {
            events.push("trigger-invoked");
            await triggerStartGate;
          }
          if (retainedReplay && replayEventVariant !== "valid") {
            if (replayEventVariant === "stale") {
              startedMessage.details = { piccCheckpointInput: {} };
            } else if (replayEventVariant === "wrong-content") {
              startedMessage.content = "wrong replay";
            } else if (replayEventVariant === "wrong-role") {
              startedMessage.role = "user";
            } else if (replayEventVariant === "wrong-type") {
              startedMessage.customType = "wrong-replay";
            } else if (replayEventVariant === "unscrubbable") {
              Object.defineProperty(startedMessage.details, "piccCheckpointInput", {
                value: startedMessage.details.piccCheckpointInput,
                enumerable: true,
                configurable: false,
              });
            }
          }
          if (sendOptions?.triggerTurn && triggerEventVariant !== "valid") {
            if (triggerEventVariant === "stale") {
              startedMessage.details = { piccCheckpointResume: {} };
            } else if (triggerEventVariant === "wrong-content") {
              startedMessage.content = "wrong continuation";
            } else if (triggerEventVariant === "wrong-role") {
              startedMessage.role = "user";
            } else if (triggerEventVariant === "wrong-type") {
              startedMessage.customType = "wrong-trigger";
            } else if (triggerEventVariant === "unscrubbable") {
              Object.defineProperty(startedMessage.details, "piccCheckpointResume", {
                value: startedMessage.details.piccCheckpointResume,
                enumerable: true,
                configurable: false,
              });
            }
          }
          if (sendOptions?.triggerTurn && triggerEventVariant === "stale") {
            await emit("message_start", { type: "message_start", message: startedMessage }, ctx);
          } else if (!retainedReplay && triggerEventVariant !== "missing") {
            await emit("message_start", { type: "message_start", message: startedMessage }, ctx);
            if (retainedReplay && replayEventVariant === "duplicate") {
              startedMessage.details.piccCheckpointInput = originalReplayEnvelope;
              await emit("message_start", { type: "message_start", message: startedMessage }, ctx);
            }
            if (sendOptions?.triggerTurn && triggerEventVariant === "duplicate") {
              startedMessage.details.piccCheckpointResume = originalTriggerEnvelope;
              await emit("message_start", { type: "message_start", message: startedMessage }, ctx);
            }
          } else if (retainedReplay) {
            pendingReplayStarts.push({
              message: startedMessage,
              ctx,
              delivery: sendOptions?.deliverAs === "followUp" ? "followUp" : "steer",
              replayEnvelope: originalReplayEnvelope,
            });
          }
          if (sendOptions?.triggerTurn) {
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
              markReplaySendStarted();
              if (stallCancellationPhase === "non-trigger") await never;
              if (replayReject) throw new Error("retained replay rejected");
            }
            customMessages.push({
              customType: message.customType,
              content: message.content,
              ...(message.details === undefined ? {} : { details: message.details }),
            });
            messages.push({ role: "custom", content: message.content });
          }
        },
        clearQueue() {
          events.push("clear-queue");
          if (purgeThrows) throw new Error("queue purge failed");
          const removed = pendingReplayStarts.splice(0);
          clearedReplayStarts.push(...removed.map(({ message, ctx: eventCtx }) => ({ message, ctx: eventCtx })));
          intervalHooks?.afterPurge?.();
          return {
            steering: removed.filter(({ delivery }) => delivery === "steer").map(({ message }) => message),
            followUp: removed.filter(({ delivery }) => delivery === "followUp").map(({ message }) => message),
          };
        },
        steer(text: string) {
          events.push("direct-steer");
          messages.push({ role: "user", content: text });
        },
        followUp(text: string) {
          events.push("direct-follow-up");
          messages.push({ role: "user", content: text });
        },
        abort() {
          events.push("abort");
          aborted = true;
          abortCalls += 1;
          releaseProviderBlock();
          if (stallCancellationPhase !== "run") releaseResumedRun();
          if (stallCancellationPhase !== "trigger") releaseTriggerStart();
          if (resumed) activeResumeAborted = true;
          intervalHooks?.afterAbort?.();
          if (stallCancellationPhase === "abort") return never;
        },
        abortCompaction() {
          compactionAbortCalls += 1;
          compactionAborted = true;
          markCompactionAbortObserved();
          if (!gateProactiveCompact) releaseRecoveryCompact();
        },
        dispose() {
          events.push("cleanup");
          onCleanup?.();
          disposed = true;
        },
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
    physicalSends: () => physicalSends.map((send) => ({
      ...send,
      ...(send.options ? { options: { ...send.options } } : {}),
    })),
    guardResults: () => [...guardResults],
    providerRegistrations: () => [...providerRegistrations],
    providerAttempts: () => providerAttempts,
    admittedProviderRequests: () => admittedProviderRequests,
    fabricatedResponses: () => fabricatedResponses,
    checkpointToolStarted: () => checkpointToolStarted,
    releaseCheckpointTool: () => releaseCheckpointTool(),
    executeCheckpointTool: async () => {
      markCheckpointToolStarted();
      if (holdCheckpointTool) await checkpointToolGate;
      return { content: [{ type: "text", text: "tool complete" }] };
    },
    providerBoundaryBlocked: () => providerBoundaryBlocked,
    releaseProviderBlock: () => releaseProviderBlock(),
    resumedRunStarted: () => resumedRunStarted,
    releaseResumedRun: () => releaseResumedRun(),
    triggerInvocationStarted: () => triggerInvocationStarted,
    releaseTriggerStart: () => releaseTriggerStart(),
    injectSyntheticInvalidReplayCallbacks: async () => {
      const callbacks = clearedReplayStarts.splice(0);
      for (const entry of callbacks) {
        events.push("synthetic-invalid-replay-callback");
        await emitPendingReplay?.(entry.message, entry.ctx);
      }
    },
    replaySendStarted: () => replaySendStarted,
  };
}

function childManualClock(): HostDeadlineClock & {
  schedules(): number;
  pending(): boolean;
  expire(): void;
} {
  let callback: (() => void) | undefined;
  let count = 0;
  return {
    schedule(_delay, expired) {
      count += 1;
      callback = expired;
      return { clear: () => { callback = undefined; } };
    },
    schedules: () => count,
    pending: () => callback !== undefined,
    expire() {
      const current = callback;
      callback = undefined;
      current?.();
    },
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
  enableCancellationRecovery = false,
  cancellationTestOptions?: {
    deadlinePolicy?: HostDeadlinePolicy;
    onTriggerScheduledForTest?: () => void;
    onCanonicalStoreForTest?: (stored: boolean, controller: MidRunCompactionController) => void;
    onControllerProgressForTest?: (
      event: CheckpointProgress,
      controller: MidRunCompactionController,
    ) => void;
    worktrees?: any;
  },
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
    ...(cancellationTestOptions?.worktrees ? { worktrees: cancellationTestOptions.worktrees } : {}),
    ...(enableCancellationRecovery && subagentRegistry
      ? { compactionCancellationRecovery: {
          registry: subagentRegistry,
          ...(cancellationTestOptions?.deadlinePolicy
            ? { deadlinePolicy: cancellationTestOptions.deadlinePolicy }
            : {}),
          ...(cancellationTestOptions?.onTriggerScheduledForTest
            ? { onTriggerScheduledForTest: cancellationTestOptions.onTriggerScheduledForTest }
            : {}),
          ...(cancellationTestOptions?.onCanonicalStoreForTest
            ? { onCanonicalStoreForTest: cancellationTestOptions.onCanonicalStoreForTest }
            : {}),
          ...(cancellationTestOptions?.onControllerProgressForTest
            ? { onControllerProgressForTest: cancellationTestOptions.onControllerProgressForTest }
            : {}),
        } }
      : {}),
    hookRunner: customHookRunner ?? (failPostCompactAttempt === undefined ? undefined : {
      async fire(eventName: string) {
        const block = eventName === "PostCompact" && ++postCompactAttempts === failPostCompactAttempt;
        return { block, blockReason: block ? "restoration rejected" : undefined, askDowngraded: false, diagnostics: [] };
      },
    }),
    customToolsFor: (_agent, _granted, _depth, _owner, _fork, _cwd, _notebook, _activation, captureStop) => {
      if (captureStop && capturedStopFactories) capturedStopFactories.push(captureStop);
      return [
      {
        name: "CheckpointTool",
        async execute() { return await harness.executeCheckpointTool(); },
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
  it("queues fresh assistant threshold pressure until the unresolved child tool settles", async () => {
    const harness = checkpointSdk({ failures: 0, holdCheckpointTool: true });
    const progress: string[] = [];
    const running = runtimeFor(harness).dispatch({
      subagentType: "reviewer",
      prompt: "review",
      depth: 1,
      onProgress: (snapshot) => progress.push(snapshot.activity),
    });
    const toolStarted = harness.checkpointToolStarted();

    let hasPrimaryFailure = false;
    try {
      await settlement(toolStarted, { description: "assistant-armed child tool to start while context usage stays unknown" });
      await expect(toolStarted).resolves.toBeUndefined();
      expect(progress).toContain("context checkpoint queued while the current tool cycle finishes");
      expect(harness.compactCalls()).toBe(0);
    } catch (error) {
      hasPrimaryFailure = true;
      throw error;
    } finally {
      harness.releaseCheckpointTool();
      try {
        await settlement(running, { description: "assistant-armed child dispatch cleanup after tool release" });
      } catch (error) {
        if (!hasPrimaryFailure) throw error;
      }
    }

    await expect(running).resolves.toMatchObject({ outcome: "completed", finalMessage: "resumed final" });
    expect(harness.compactCalls()).toBe(1);
    expect(harness.resumeCalls()).toBe(1);
  });

  it("blocks a newly high child provider boundary once and compacts only at settlement", async () => {
    const harness = checkpointSdk({
      failures: 0,
      assistantUsage: "low",
      highAtProviderBoundary: true,
      holdAfterProviderBlock: true,
    });
    const progress: string[] = [];
    const running = runtimeFor(harness).dispatch({
      subagentType: "reviewer",
      prompt: "review",
      depth: 1,
      onProgress: (snapshot) => progress.push(snapshot.activity),
    });
    const providerBlocked = harness.providerBoundaryBlocked();

    let hasPrimaryFailure = false;
    try {
      await settlement(providerBlocked, { description: "newly high child provider admission to block" });
      await expect(providerBlocked).resolves.toBeUndefined();
      expect(progress).toContain("context checkpoint queued, waiting for safe child settlement");
      expect(harness.compactCalls()).toBe(0);
      expect(harness.fabricatedResponses()).toBe(0);
    } catch (error) {
      hasPrimaryFailure = true;
      throw error;
    } finally {
      harness.releaseProviderBlock();
      try {
        await settlement(running, { description: "provider-blocked child dispatch cleanup after gate release" });
      } catch (error) {
        if (!hasPrimaryFailure) throw error;
      }
    }

    await expect(running).resolves.toMatchObject({ outcome: "completed", finalMessage: "resumed final" });
    expect(harness.providerAttempts()).toBe(4);
    expect(harness.admittedProviderRequests()).toBe(2);
    expect(harness.fabricatedResponses()).toBe(0);
    expect(harness.abortCalls()).toBe(1);
    expect(harness.compactCalls()).toBe(1);
    expect(harness.resumeCalls()).toBe(1);
    expect(harness.sessionCreations()).toBe(1);
  });

  it("lets cancellation win after provider admission blocks and before physical child compaction", async () => {
    const harness = checkpointSdk({
      failures: 0,
      assistantUsage: "low",
      highAtProviderBoundary: true,
      holdAfterProviderBlock: true,
    });
    const abort = new AbortController();
    const running = runtimeFor(harness).dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1, abortSignal: abort.signal,
    });
    const providerBlocked = harness.providerBoundaryBlocked();

    let hasPrimaryFailure = false;
    try {
      await settlement(providerBlocked, { description: "cancellable child provider admission to block" });
      await expect(providerBlocked).resolves.toBeUndefined();
      expect(harness.compactCalls()).toBe(0);
      expect(harness.fabricatedResponses()).toBe(0);
      abort.abort();
    } catch (error) {
      hasPrimaryFailure = true;
      throw error;
    } finally {
      abort.abort();
      harness.releaseProviderBlock();
      try {
        await settlement(running, { description: "cancelled provider-blocked child dispatch cleanup" });
      } catch (error) {
        if (!hasPrimaryFailure) throw error;
      }
    }

    await expect(running).resolves.toMatchObject({ outcome: "aborted" });
    expect(harness.compactCalls()).toBe(0);
    expect(harness.resumeCalls()).toBe(0);
  });

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

  it("persists a mixed parallel child batch while omitted recovery keeps direct parent delivery", async () => {
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
    expect(events.indexOf("direct-steer")).toBeGreaterThan(events.indexOf("compact-started"));
    expect(events).not.toContain("queued-replay");
    expect(events.indexOf("direct-steer")).toBeLessThan(events.indexOf("resumed-provider"));
  });

  it("keeps resumed-cancellation custody dormant when the internal option is omitted", async () => {
    const harness = checkpointSdk({ failures: 1, gateRecoveryCompact: true, cancelResumedRun: true });
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry, undefined, undefined, undefined, true, false);
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
      agentId: "agent-888888888888",
    });
    await harness.recoveryCompactStarted();
    await registry.get("agent-888888888888")!.session!.steer!("legacy steer");
    await registry.get("agent-888888888888")!.session!.followUp!("legacy follow-up");
    expect(harness.events()).toEqual(expect.arrayContaining(["direct-steer", "direct-follow-up"]));
    expect(harness.physicalSends().filter(({ customType }) =>
      customType === "picc-retained-parent-input")).toEqual([]);
    harness.releaseRecoveryCompact();
    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "aborted" });
    expect("checkpointPaused" in result).toBe(false);
    expect(result.retainedInputReport).toBeUndefined();
    expect(registry.get("agent-888888888888")?.retainedInputReport).toBeUndefined();
    expect(registry.get("agent-888888888888")?.checkpointQuarantined).not.toBe(true);
    expect(registry.get("agent-888888888888")?.state).toBe("settled");
    expect(harness.customMessages().filter(({ customType }) =>
      customType === "picc-checkpoint-resume")).toEqual([]);
    expect(harness.events()).not.toContain("clear-queue");
    expect(harness.abortCalls()).toBe(0);
    expect(harness.disposed()).toBe(true);
  });

  it("separates accepted replay from consumption and reports equal ordered steer/follow-up custody", async () => {
    const harness = checkpointSdk({
      failures: 1,
      gateRecoveryCompact: true,
      gateResumedRun: true,
      consumeRetainedReplay: false,
    });
    const registry = new SubagentRegistry();
    const abort = new AbortController();
    const runtime = runtimeFor(harness, makeAgent(), registry, undefined, undefined, undefined, false, true);
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
      agentId: "agent-777777777777", abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    const send = createSendMessageToolDefinition(runtime, {
      registry,
      backgroundTasks: new BackgroundTaskRegistry(),
    });
    const equalContent = "retain this exact parent message";
    await (send.execute as Function)("send-retained", {
      to: "agent-777777777777",
      message: equalContent,
    });
    await registry.get("agent-777777777777")!.session!.followUp!(equalContent);
    harness.releaseRecoveryCompact();
    await harness.resumedRunStarted();
    abort.abort();

    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "aborted" });
    expect(result.retainedInputReport).toBeDefined();
    expect(result.retainedInputReport!.occurrences.map(({ shadow }) => ({
      delivery: shadow.delivery,
      content: shadow.content,
    }))).toEqual([
      { delivery: "steer", content: equalContent },
      { delivery: "followUp", content: equalContent },
    ]);
    expect(result.retainedInputReport!.guidance).toMatch(/files, tools, and external effects/iu);
    expect(harness.events()).toContain("clear-queue");
    expect(harness.physicalSends().filter(({ customType }) =>
      customType === "picc-checkpoint-resume" || customType === "picc-retained-parent-input"))
      .toEqual([
        { customType: "picc-checkpoint-resume", options: { triggerTurn: true } },
        { customType: "picc-retained-parent-input", options: { deliverAs: "steer" } },
        { customType: "picc-retained-parent-input", options: { deliverAs: "followUp" } },
      ]);
    expect(harness.physicalSends().some(({ options }) =>
      options?.deliverAs === "nextTurn" || Object.keys(options ?? {}).length === 0)).toBe(false);
    const canonical = registry.get("agent-777777777777")!.retainedInputReport;
    await harness.injectSyntheticInvalidReplayCallbacks();
    expect(harness.events()).toContain("synthetic-invalid-replay-callback");
    expect(registry.get("agent-777777777777")!.retainedInputReport).toBe(canonical);
    expect(canonical!.occurrences).toHaveLength(2);
    let presentations = 0;
    expect(await Promise.all([
      result.retainedInputReport!.claim(async () => { presentations += 1; return true; }),
      result.retainedInputReport!.claim(async () => { presentations += 1; return true; }),
    ])).toEqual([true, false]);
    expect(presentations).toBe(1);
    expect(harness.disposed()).toBe(true);
  });

  it.each([
    { timing: "before SDK invocation", delayed: false },
    { timing: "after invocation with delayed message_start", delayed: true },
  ])("cancels $timing without inventing pre-start after invocation", async ({ delayed }) => {
    const harness = checkpointSdk({
      failures: 1, gateRecoveryCompact: true, gateResumedRun: delayed, delayTriggerStart: delayed,
    });
    const registry = new SubagentRegistry();
    const abort = new AbortController();
    const runtime = runtimeFor(
      harness, makeAgent(), registry, undefined, undefined, undefined, false, true,
      delayed ? undefined : { onTriggerScheduledForTest: () => abort.abort() },
    );
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
      agentId: delayed ? "agent-111111111111" : "agent-222222222222",
      abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    harness.releaseRecoveryCompact();
    if (delayed) {
      await harness.triggerInvocationStarted();
      abort.abort();
    }
    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "aborted" });
    expect(result.retainedInputReport).toBeDefined();
    if (delayed) {
      expect(harness.events()).toContain("trigger-invoked");
      expect(harness.events()).toContain("abort");
      expect(harness.resumeCalls()).toBe(1);
      expect(result.retainedInputReport!.guidance).toMatch(/continuation began/iu);
    } else {
      expect(harness.resumeCalls()).toBe(0);
      expect(harness.events()).toContain("clear-queue");
      expect(harness.events()).not.toContain("abort");
      expect(result.retainedInputReport!.guidance).toMatch(/startup was prevented/iu);
    }
  });

  it.each([
    "missing",
    "stale",
    "duplicate",
    "wrong-content",
    "wrong-role",
    "wrong-type",
    "unscrubbable",
  ] as const)("fails closed for synthetic %s continuation-trigger evidence", async (triggerEventVariant) => {
    const clock = childManualClock();
    const harness = checkpointSdk({
      failures: 1, gateRecoveryCompact: true, gateResumedRun: true, triggerEventVariant,
    });
    const registry = new SubagentRegistry();
    const abort = new AbortController();
    const agentId = `agent-${(["missing", "stale", "duplicate", "wrong-content", "wrong-role", "wrong-type", "unscrubbable"].indexOf(triggerEventVariant) + 9).toString(16).repeat(12)}`;
    const runtime = runtimeFor(
      harness, makeAgent(), registry, undefined, undefined, undefined, false, true,
      { deadlinePolicy: { clock, resumedJoinMs: 10 } },
    );
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1, agentId, abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    harness.releaseRecoveryCompact();
    await harness.triggerInvocationStarted();
    const requiresCancellation = triggerEventVariant === "missing";
    if (requiresCancellation) {
      abort.abort();
      await waitUntil({ description: `${triggerEventVariant} evidence deadline`, predicate: () => clock.pending() });
      clock.expire();
    } else {
      await waitUntil({
        description: `${triggerEventVariant} evidence quarantine`,
        predicate: () => registry.get(agentId)?.checkpointQuarantined === true,
      });
    }
    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "failed", checkpointPaused: true, resumable: false });
    expect(result.retainedInputReport).toBeUndefined();
    expect(registry.get(agentId)?.checkpointQuarantined).toBe(true);
    expect(harness.disposed()).toBe(false);
    expect(harness.resumeCalls()).toBe(1);
    expect(harness.events()).not.toContain("resumed-provider");
    expect(registry.get(agentId)?.checkpointQuarantined).toBe(true);
  });

  it.each([
    "stale",
    "duplicate",
    "wrong-content",
    "wrong-role",
    "wrong-type",
    "unscrubbable",
  ] as const)("fails closed for synthetic %s active-stream replay occurrence evidence", async (replayEventVariant) => {
    const harness = checkpointSdk({ failures: 1, gateRecoveryCompact: true, replayEventVariant });
    const registry = new SubagentRegistry();
    const agentId = `agent-${String(["stale", "duplicate", "wrong-content", "wrong-role", "wrong-type", "unscrubbable"].indexOf(replayEventVariant) + 1).repeat(12)}`;
    const runtime = runtimeFor(harness, makeAgent(), registry, undefined, undefined, undefined, false, true);
    const dispatch = runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1, agentId });
    await harness.recoveryCompactStarted();
    const send = createSendMessageToolDefinition(runtime, {
      registry, backgroundTasks: new BackgroundTaskRegistry(),
    });
    await (send.execute as Function)("malformed-replay", { to: agentId, message: "same replay" });
    harness.releaseRecoveryCompact();
    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "failed", checkpointPaused: true, resumable: false });
    expect(registry.get(agentId)?.checkpointQuarantined).toBe(true);
    expect(harness.events()).not.toContain("resumed-provider");
    expect(harness.disposed()).toBe(false);
  });

  it.each(([
    "duplicate-end",
    "duplicate-settled",
    "wrong-end",
    "late-end",
    "wrong-run",
  ] as const).flatMap((terminalEvidenceVariant) => ([
    { terminalEvidenceVariant, cancellation: "requested" as const },
    { terminalEvidenceVariant, cancellation: "host-observed" as const },
  ])))("quarantines synthetic $cancellation $terminalEvidenceVariant evidence exactly once", async ({
    terminalEvidenceVariant,
    cancellation,
  }) => {
    const requested = cancellation === "requested";
    const harness = checkpointSdk({
      failures: 1,
      gateRecoveryCompact: true,
      gateResumedRun: requested,
      cancelResumedRun: !requested,
      terminalEvidenceVariant,
    });
    let quarantines = 0;
    class CountingQuarantineRegistry extends SubagentRegistry {
      override quarantineCheckpoint(agentId: string): boolean {
        const stored = super.quarantineCheckpoint(agentId);
        if (stored) quarantines += 1;
        return stored;
      }
    }
    const registry = new CountingQuarantineRegistry();
    const clock = childManualClock();
    const abort = new AbortController();
    const variant = ["duplicate-end", "duplicate-settled", "wrong-end", "late-end", "wrong-run"]
      .indexOf(terminalEvidenceVariant);
    const digit = (variant * 2 + (requested ? 1 : 2)).toString(16);
    const agentId = `agent-${digit.repeat(12)}`;
    const runtime = runtimeFor(
      harness, makeAgent(), registry, undefined, undefined, undefined, false, true,
      { deadlinePolicy: { clock, resumedJoinMs: 10 } },
    );
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1, agentId, abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    harness.releaseRecoveryCompact();
    if (requested) {
      await harness.resumedRunStarted();
      abort.abort();
    }
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    if (!registry.get(agentId)?.checkpointQuarantined && clock.pending()) clock.expire();
    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "failed", checkpointPaused: true, resumable: false });
    expect(result.retainedInputReport).toBeUndefined();
    expect(registry.get(agentId)?.retainedInputReport).toBeUndefined();
    expect(registry.get(agentId)?.checkpointQuarantined).toBe(true);
    expect(quarantines).toBe(1);
    expect(harness.events()).not.toContain("cleanup");
    expect(harness.disposed()).toBe(false);
    expect(harness.resumeCalls()).toBe(1);
    expect(harness.abortCalls()).toBe(requested ? 1 : 0);
  });

  it.each([
    "non-trigger",
    "trigger",
    "abort",
    "run",
    "final-settlement",
    "evidence",
  ] as const)("expires one shared deadline for a never-settling %s phase and keeps late callbacks inert", async (phase) => {
    const clock = childManualClock();
    const harness = checkpointSdk({
      failures: 1,
      gateRecoveryCompact: true,
      gateResumedRun: phase !== "non-trigger" && phase !== "trigger",
      stallCancellationPhase: phase,
    });
    const registry = new SubagentRegistry();
    const abort = new AbortController();
    const agentId = `agent-${String(["non-trigger", "trigger", "abort", "run", "final-settlement", "evidence"].indexOf(phase) + 3).repeat(12)}`;
    const runtime = runtimeFor(
      harness, makeAgent(), registry, undefined, undefined, undefined, false, true,
      { deadlinePolicy: { clock, resumedJoinMs: 10 } },
    );
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1, agentId, abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    if (phase === "non-trigger") {
      const send = createSendMessageToolDefinition(runtime, {
        registry, backgroundTasks: new BackgroundTaskRegistry(),
      });
      await (send.execute as Function)("stall-replay", { to: agentId, message: "retained" });
    }
    harness.releaseRecoveryCompact();
    if (phase === "non-trigger") await harness.replaySendStarted();
    else if (phase === "trigger") await harness.triggerInvocationStarted();
    else await harness.resumedRunStarted();
    abort.abort();
    if (phase === "run") {
      const before = harness.customMessages().length;
      const send = createSendMessageToolDefinition(runtime, {
        registry, backgroundTasks: new BackgroundTaskRegistry(),
      });
      await expect((send.execute as Function)("during-cancel", {
        to: agentId, message: "must not fall back",
      })).rejects.toThrow(/message was not sent/iu);
      expect(harness.customMessages()).toHaveLength(before);
    }
    await waitUntil({ description: `${phase} cancellation deadline`, predicate: () => clock.pending() });
    expect(clock.schedules()).toBe(1);
    clock.expire();

    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "failed", checkpointPaused: true, resumable: false });
    expect(result.retainedInputReport).toBeUndefined();
    expect(registry.get(agentId)).toMatchObject({
      checkpointQuarantined: true, checkpointPaused: true, state: "running",
    });
    expect(harness.disposed()).toBe(false);
    expect(clock.schedules()).toBe(1);

    harness.releaseTriggerStart();
    harness.releaseResumedRun();
    await harness.injectSyntheticInvalidReplayCallbacks();
    await Promise.resolve();
    expect(registry.get(agentId)?.checkpointQuarantined).toBe(true);
    expect(harness.disposed()).toBe(false);
    expect(clock.schedules()).toBe(1);
  });

  it.each([
    { interval: "purge-to-abort", hook: "afterPurge" },
    { interval: "abort-to-run", hook: "afterAbort" },
    { interval: "terminal-evidence", hook: "afterAgentEnd" },
    { interval: "settlement-to-handoff", hook: "afterAgentSettled" },
  ] as const)("refuses input without fallback during $interval", async ({ hook }) => {
    const registry = new SubagentRegistry();
    const refusals: string[] = [];
    const agentId = `agent-${String(["afterPurge", "afterAbort", "afterAgentEnd", "afterAgentSettled"].indexOf(hook) + 6).repeat(12)}`;
    const attempt = () => {
      try {
        registry.get(agentId)?.session?.steer?.("interval input");
      } catch (error) {
        refusals.push(String((error as Error).message));
      }
    };
    const harness = checkpointSdk({
      failures: 1,
      gateRecoveryCompact: true,
      gateResumedRun: true,
      intervalHooks: { [hook]: attempt },
    });
    const abort = new AbortController();
    const runtime = runtimeFor(harness, makeAgent(), registry, undefined, undefined, undefined, false, true);
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1, agentId, abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    harness.releaseRecoveryCompact();
    await harness.resumedRunStarted();
    const before = harness.customMessages().length;
    abort.abort();
    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "aborted" });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/message was not sent/iu);
    expect(result.retainedInputReport?.occurrences).toEqual([]);
    expect(harness.customMessages()).toHaveLength(before);
    expect(registry.get(agentId)?.checkpointQuarantined).not.toBe(true);
  });

  it("does not retry, replay, or release when provider/tool progress races cancellation", async () => {
    const harness = checkpointSdk({
      failures: 1, gateRecoveryCompact: true, gateResumedRun: true, resumedToolHook: true,
    });
    const registry = new SubagentRegistry();
    let reportStores = 0;
    class CountingRegistry extends SubagentRegistry {
      override storeRetainedInputReport(agentId: string, report: any): boolean {
        reportStores += 1;
        return super.storeRetainedInputReport(agentId, report);
      }
    }
    const counting = new CountingRegistry();
    const abort = new AbortController();
    const runtime = runtimeFor(harness, makeAgent(), counting, undefined, undefined, undefined, false, true);
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
      agentId: "agent-121212121212", abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    harness.releaseRecoveryCompact();
    await harness.resumedRunStarted();
    abort.abort();
    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "aborted" });
    expect(harness.events()).toContain("resumed-tool-progress");
    expect(harness.events()).not.toContain("resumed-provider");
    expect(harness.compactCalls()).toBe(1);
    expect(harness.resumeCalls()).toBe(1);
    expect(harness.abortCalls()).toBe(1);
    expect(reportStores).toBe(1);
    expect(counting.get("agent-121212121212")?.retainedInputReport).toBe(result.retainedInputReport);
    expect(harness.disposed()).toBe(true);
    expect(registry.ids()).toEqual([]);
  });

  it("stores canonically while the controller still owns occurrences, then resolves before settlement and cleanup", async () => {
    const order: string[] = [];
    const harness = checkpointSdk({
      failures: 1,
      gateRecoveryCompact: true,
      gateResumedRun: true,
    });
    const worktrees = {
      async enter() {
        return {
          ok: true, worktreePath: process.cwd(), branch: "test", baseCommit: "deadbeef",
          created: true, seededFiles: [], diagnostics: [],
        };
      },
      async exit() {
        order.push("cleanup");
        return { ok: true, removed: false, orphaned: false, diagnostics: [] };
      },
    };
    let controllerAtStore: MidRunCompactionController | undefined;
    class OrderedRegistry extends SubagentRegistry {
      override storeRetainedInputReport(agentId: string, report: any): boolean {
        order.push("store");
        return super.storeRetainedInputReport(agentId, report);
      }
      override markSettled(agentId: string, settled?: any): void {
        expect(controllerAtStore?.queuedInputSnapshot()).toHaveLength(0);
        order.push("settlement");
        super.markSettled(agentId, settled);
      }
    }
    const registry = new OrderedRegistry();
    const runtime = runtimeFor(
      harness, { ...makeAgent(), isolation: "worktree" }, registry,
      undefined, undefined, undefined, false, true,
      {
        worktrees,
        onCanonicalStoreForTest: (stored, controller) => {
          expect(stored).toBe(true);
          expect(controller.queuedInputSnapshot()).toHaveLength(1);
          expect(controller.snapshot().phase).toBe("terminalizing");
          controllerAtStore = controller;
        },
        onControllerProgressForTest: (event, controller) => {
          if (event.category === "checkpoint-cancelled") {
            expect(controller.queuedInputSnapshot()).toHaveLength(0);
            order.push("resolution");
          }
        },
      },
    );
    const abort = new AbortController();
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
      agentId: "agent-666666666666", abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    await registry.get("agent-666666666666")!.session!.steer!("retained for ordered storage");
    harness.releaseRecoveryCompact();
    await harness.resumedRunStarted();
    abort.abort();

    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "aborted" });
    const purge = harness.events().indexOf("clear-queue");
    const physicalAbort = harness.events().indexOf("abort");
    expect(purge).toBeGreaterThan(-1);
    expect(physicalAbort).toBeGreaterThan(purge);
    expect(result.retainedInputReport?.occurrences).toHaveLength(1);
    expect(registry.get("agent-666666666666")?.retainedInputReport).toBe(result.retainedInputReport);
    expect(registry.get("agent-666666666666")?.checkpointQuarantined).not.toBe(true);
    expect(order).toEqual(["store", "resolution", "settlement", "cleanup"]);
    expect(harness.disposed()).toBe(true);
  });

  it("keeps controller custody unresolved when canonical storage refuses a different report", async () => {
    const refusalOrder: string[] = [];
    const harness = checkpointSdk({
      failures: 1,
      gateRecoveryCompact: true,
      gateResumedRun: true,
      onCleanup: () => refusalOrder.push("cleanup"),
    });
    let controllerAtRefusal: MidRunCompactionController | undefined;
    class RefusingRegistry extends SubagentRegistry {
      override storeRetainedInputReport(agentId: string, report: any): boolean {
        const different = createRetainedInputReport({
          agentId,
          sessionId: report.sessionId,
          generation: report.generation,
          stage: report.stage,
          occurrences: [],
          guidance: "Different canonical report retained by the refusal fixture.",
        });
        expect(super.storeRetainedInputReport(agentId, different)).toBe(true);
        refusalOrder.push("store-refused");
        return false;
      }
    }
    const registry = new RefusingRegistry();
    const runtime = runtimeFor(
      harness, makeAgent(), registry, undefined, undefined, undefined, false, true,
      {
        onCanonicalStoreForTest: (stored, controller) => {
          expect(stored).toBe(false);
          expect(controller.queuedInputSnapshot()).toHaveLength(1);
          expect(controller.snapshot().phase).toBe("terminalizing");
          controllerAtRefusal = controller;
        },
        onControllerProgressForTest: (event) => {
          if (event.category === "checkpoint-cancelled") refusalOrder.push("resolution");
        },
      },
    );
    const abort = new AbortController();
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
      agentId: "agent-141414141414", abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    await registry.get("agent-141414141414")!.session!.followUp!("must remain controller-owned");
    harness.releaseRecoveryCompact();
    await harness.resumedRunStarted();
    abort.abort();

    const result = await dispatch;
    expect(result).toMatchObject({ checkpointPaused: true, retainedInputReport: { occurrences: [] } });
    expect(controllerAtRefusal?.queuedInputSnapshot()).toHaveLength(1);
    expect(registry.get("agent-141414141414")).toMatchObject({
      state: "running", checkpointPaused: true, checkpointQuarantined: true,
    });
    expect(refusalOrder).toEqual(["store-refused"]);
    expect(harness.events()).not.toContain("cleanup");
    expect(harness.disposed()).toBe(false);
  });

  it("keeps quarantined worktree and cleanup ownership unreleased", async () => {
    const harness = checkpointSdk({
      failures: 1, gateRecoveryCompact: true, gateResumedRun: true, purgeThrows: true,
    });
    const registry = new SubagentRegistry();
    let worktreeExits = 0;
    const worktrees = {
      async enter() {
        return {
          ok: true, worktreePath: process.cwd(), branch: "test", baseCommit: "deadbeef",
          created: true, seededFiles: [], diagnostics: [],
        };
      },
      async exit() {
        worktreeExits += 1;
        return { ok: true, removed: false, orphaned: false, diagnostics: [] };
      },
    };
    const runtime = runtimeFor(
      harness, { ...makeAgent(), isolation: "worktree" }, registry,
      undefined, undefined, undefined, false, true, { worktrees },
    );
    const abort = new AbortController();
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
      agentId: "agent-131313131313", abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    harness.releaseRecoveryCompact();
    await harness.resumedRunStarted();
    abort.abort();
    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "failed", checkpointPaused: true });
    expect(registry.get("agent-131313131313")?.worktreePath).toBe(process.cwd());
    expect(registry.get("agent-131313131313")?.checkpointQuarantined).toBe(true);
    expect(worktreeExits).toBe(0);
    expect(harness.disposed()).toBe(false);
    harness.releaseResumedRun();
  });

  it("quarantines purge ambiguity in the registry and forbids cleanup, recovery, and a second stop", async () => {
    const harness = checkpointSdk({
      failures: 1, gateRecoveryCompact: true, gateResumedRun: true, purgeThrows: true,
    });
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry, undefined, undefined, undefined, false, true);
    const abort = new AbortController();
    const dispatch = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1,
      agentId: "agent-555555555555", abortSignal: abort.signal,
    });
    await harness.recoveryCompactStarted();
    harness.releaseRecoveryCompact();
    await harness.resumedRunStarted();
    abort.abort();

    const result = await dispatch;
    expect(result).toMatchObject({ outcome: "failed", checkpointPaused: true, resumable: false });
    expect(registry.get("agent-555555555555")).toMatchObject({
      state: "running", checkpointPaused: true, checkpointQuarantined: true, resumable: false,
    });
    expect(harness.events()).toContain("clear-queue");
    expect(harness.events()).not.toContain("abort");
    // `dispose` is the cleanup/worktree-release owner's spy: quarantine never acquires it.
    expect(harness.disposed()).toBe(false);
    await expect(runtime.stopCheckpoint("agent-555555555555")).rejects.toThrow(
      /requested stop was not performed.*no canonical retained-input report.*fresh process and session.*transcript.*worktree.*external effects/isu,
    );
    const send = createSendMessageToolDefinition(runtime, {
      registry, backgroundTasks: new BackgroundTaskRegistry(),
    });
    await expect((send.execute as Function)("quarantined-send", {
      to: "agent-555555555555", message: "retry",
    })).rejects.toThrow(
      /requested message\/recovery was not performed.*no canonical retained-input report.*fresh process and session.*transcript.*worktree.*external effects/isu,
    );
    const sessionsBeforeReplacement = harness.sessionCreations();
    await expect(runtime.dispatch({
      subagentType: "reviewer", prompt: "replacement", depth: 1,
      agentId: "agent-555555555555",
    })).rejects.toThrow(
      /requested dispatch was not performed.*no canonical retained-input report.*fresh process and session.*transcript.*worktree.*external effects/isu,
    );
    expect(harness.sessionCreations()).toBe(sessionsBeforeReplacement);
    expect(registry.get("agent-555555555555")?.state).toBe("running");
    harness.releaseResumedRun();
  });

  it("aborts and joins the child before publishing a retained-replay failure", async () => {
    const harness = checkpointSdk({ failures: 1, gateRecoveryCompact: true, replayReject: true });
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(harness, makeAgent(), registry, undefined, undefined, undefined, false, true);
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
      "context checkpoint queued while the current tool cycle finishes",
      "checkpoint paused: recovery required",
    ]);
    expect(result.checkpointPaused).toBe(true);
    expect(result.recoveryDisposition).toBeUndefined();
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
    expect(rendered).toEqual([
      `● ${exhausted.agentId} · recovered`,
      "  resumed final",
    ]);
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

  it("authenticates real pre-commit shutdown cleanup without persistence or quarantine", async () => {
    const harness = checkpointSdk({ failures: 3 });
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(
      harness, makeAgent(), registry, undefined, undefined, undefined, false, true,
    );
    const exhausted = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    let persistenceAttempts = 0;

    const stopped = await runtime.stopAllRetainedSubagents({
      persist: () => { persistenceAttempts += 1; return true; },
    });

    expect(stopped).toEqual({ outcomes: [], confirmed: 0, unconfirmed: 0 });
    expect(persistenceAttempts).toBe(0);
    expect(harness.events().filter((event) => event === "cleanup")).toHaveLength(1);
    expect(harness.disposed()).toBe(true);
    expect(registry.get(exhausted.agentId)).toMatchObject({
      state: "settled",
      checkpointPaused: false,
      checkpointStopState: "confirmed",
    });
    expect(registry.get(exhausted.agentId)?.checkpointQuarantined).not.toBe(true);

    await expect(runtime.stopAllRetainedSubagents({ persist: () => { persistenceAttempts += 1; return true; } }))
      .resolves.toEqual({ outcomes: [], confirmed: 0, unconfirmed: 0 });
    expect(persistenceAttempts).toBe(0);
    expect(harness.events().filter((event) => event === "cleanup")).toHaveLength(1);
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

  it("TaskStop owns the active committed-summary resumed epoch before checkpointPaused publication", async () => {
    const harness = checkpointSdk({
      failures: 1, gateRecoveryCompact: true, gateResumedRun: true, delayTriggerStart: true,
    });
    const registry = new SubagentRegistry();
    const agentId = "agent-101010101010";
    const runtime = runtimeFor(
      harness, makeAgent(), registry, undefined, undefined, undefined, false, true,
      { onCanonicalStoreForTest: (stored) => {
        expect(stored).toBe(true);
        expect(registry.checkpointStopEligible(agentId)).toBe(true);
      } },
    );
    const tasks = new BackgroundTaskRegistry({ registry });
    let fallbackAborts = 0;
    const taskId = tasks.start(
      "agent:reviewer",
      runtime.dispatch({
        subagentType: "reviewer", prompt: "review", depth: 1, background: true, agentId,
      }),
      () => { fallbackAborts += 1; },
      agentId,
      "reviewer",
    );
    const send = createSendMessageToolDefinition(runtime, { registry, backgroundTasks: tasks });
    await harness.recoveryCompactStarted();
    expect(registry.checkpointStopEligible(agentId)).toBe(false);
    await (send.execute as Function)("before-stop", { to: agentId, message: "retain this exact input" });
    harness.releaseRecoveryCompact();
    await harness.triggerInvocationStarted();
    expect(registry.checkpointStopEligible(agentId)).toBe(false);
    harness.releaseTriggerStart();
    await harness.resumedRunStarted();

    expect(registry.checkpointStopEligible(agentId)).toBe(true);
    expect(registry.get(agentId)?.checkpointPaused).not.toBe(true);
    expect(tasks.get(taskId)?.checkpointPaused).not.toBe(true);
    const stop = createTaskStopTool(tasks, registry);
    const byTask = (stop.execute as Function)("stop-task", { task_id: taskId });
    const byAgent = (stop.execute as Function)("stop-agent", { task_id: agentId });
    expect(registry.get(agentId)?.checkpointStopState).toBe("stopping");
    expect(tasks.get(taskId)).toMatchObject({ status: "running", checkpointStopState: "stopping" });
    const sendsBeforeRefusal = harness.customMessages().length;
    await expect((send.execute as Function)("after-stop", {
      to: agentId, message: "must not reach the SDK",
    })).rejects.toThrow(/settling cancellation.*message was not sent/isu);
    expect(harness.customMessages()).toHaveLength(sendsBeforeRefusal);

    const stops = Promise.all([byTask, byAgent]);
    await settlement(stops, {
      description: "active resumed TaskStop task/agent join",
      describeObserved: () => JSON.stringify({
        events: harness.events(),
        agent: registry.get(agentId),
        task: tasks.get(taskId),
      }),
    });
    const [taskStopped, agentStopped] = await stops;
    expect(taskStopped.details).toMatchObject({ status: "stopped", disposition: "confirmed", agentId });
    expect(agentStopped.details).toMatchObject({ status: "stopped", disposition: "confirmed", agentId });
    expect(fallbackAborts).toBe(0);
    expect(harness.abortCalls()).toBe(1);
    expect(harness.events().filter((event) => event === "cleanup")).toHaveLength(1);
    expect(harness.disposed()).toBe(true);
    expect(registry.checkpointStopEligible(agentId)).toBe(false);
    expect(tasks.get(taskId)).toMatchObject({
      status: "stopped", checkpointStopDisposition: "confirmed", settlementDelivery: "collected",
    });
    const report = registry.get(agentId)?.retainedInputReport;
    expect(report?.occurrences.map((occurrence) => occurrence.shadow.content)).toEqual(["retain this exact input"]);
    const output = createTaskOutputTool(tasks);
    const firstReport = await (output.execute as Function)("report", { task_id: agentId });
    const repeatedReport = await (output.execute as Function)("report-again", { task_id: agentId });
    expect(firstReport.details.reportId).toBe(report?.reportId);
    expect(repeatedReport.content).toEqual(firstReport.content);
  });

  it("does not retain active stop eligibility after a normally finished resumed stream", async () => {
    const registry = new SubagentRegistry();
    const agentId = "agent-303030303030";
    const harness = checkpointSdk({
      failures: 1,
      gateRecoveryCompact: true,
      intervalHooks: {
        afterAgentEnd: () => expect(registry.checkpointStopEligible(agentId)).toBe(false),
      },
    });
    const runtime = runtimeFor(
      harness, makeAgent(), registry, undefined, undefined, undefined, false, true,
    );
    const result = runtime.dispatch({
      subagentType: "reviewer", prompt: "review", depth: 1, background: true, agentId,
    });
    await harness.recoveryCompactStarted();
    harness.releaseRecoveryCompact();
    await expect(result).resolves.toMatchObject({ outcome: "completed" });
    expect(registry.checkpointStopEligible(agentId)).toBe(false);
  });

  it("TaskStop quarantines an active resumed generation whose settlement cannot be confirmed", async () => {
    const clock = childManualClock();
    const harness = checkpointSdk({
      failures: 1, gateRecoveryCompact: true, gateResumedRun: true,
      stallCancellationPhase: "final-settlement",
    });
    const registry = new SubagentRegistry();
    const runtime = runtimeFor(
      harness, makeAgent(), registry, undefined, undefined, undefined, false, true,
      { deadlinePolicy: { clock, resumedJoinMs: 10 } },
    );
    const tasks = new BackgroundTaskRegistry({ registry });
    const agentId = "agent-202020202020";
    const taskId = tasks.start(
      "agent:reviewer",
      runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1, background: true, agentId }),
      undefined,
      agentId,
      "reviewer",
    );
    await harness.recoveryCompactStarted();
    harness.releaseRecoveryCompact();
    await harness.resumedRunStarted();
    expect(registry.checkpointStopEligible(agentId)).toBe(true);

    const stopping = tasks.stopAndWait(taskId);
    expect(tasks.get(taskId)).toMatchObject({ status: "running", checkpointStopState: "stopping" });
    await waitUntil({ description: "active TaskStop cancellation deadline", predicate: () => clock.pending() });
    clock.expire();
    await expect(stopping).resolves.toMatchObject({ disposition: "unconfirmed" });
    expect(registry.get(agentId)).toMatchObject({ checkpointQuarantined: true, checkpointPaused: true });
    expect(tasks.get(taskId)).toMatchObject({ status: "failed", checkpointQuarantined: true });
    expect(harness.disposed()).toBe(false);
    expect(clock.schedules()).toBe(1);
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

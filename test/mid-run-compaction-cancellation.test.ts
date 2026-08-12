import { describe, expect, it } from "vitest";
import {
  MainSessionCheckpointGate,
  MidRunCompactionController,
  type CancelledInputHandoff,
  type CancelledInputResolution,
  type CancellationOutcome,
  type CheckpointProgress,
  type HostDeadlineClock,
  type HostInputClass,
  type HostInputLease,
  type ResumeContext,
} from "../src/runtime/mid-run-compaction.js";
import { deferred, waitUntil } from "./helpers/async.js";

const usage = { tokens: 900, contextWindow: 1000, percent: 90 };

function manualClock(): HostDeadlineClock & { pending(): boolean; schedules(): number; expire(): void } {
  let callback: (() => void) | undefined;
  let scheduleCount = 0;
  return {
    schedule(_delayMs, expired) {
      scheduleCount += 1;
      callback = expired;
      return { clear: () => { callback = undefined; } };
    },
    pending: () => callback !== undefined,
    schedules: () => scheduleCount,
    expire() {
      const current = callback;
      callback = undefined;
      current?.();
    },
  };
}

function arm(controller: MidRunCompactionController): number {
  const generation = controller.sample(usage, "tool")!;
  const batch = controller.beginToolBatch(generation, ["tool"])!;
  expect(controller.finalizeTool(batch, "tool", { owned: true, canTerminate: true })).toBe(true);
  expect(controller.completeToolBatch(batch).stop).toBe("terminate");
  return generation;
}

function resolution(
  handoff: CancelledInputHandoff,
  disposition: "restored" | "reported" | "unresolved" = "restored",
  sessionDisposition: "reusable" | "terminal" | "restart-required" = "reusable",
): CancelledInputResolution {
  return {
    sessionId: handoff.sessionId,
    generation: handoff.generation,
    token: handoff.token,
    sessionDisposition,
    resolutions: handoff.retained.map((entry) => ({ id: entry.id, disposition })),
  };
}

function terminalActions(progress: readonly CheckpointProgress[]): CheckpointProgress[] {
  return progress.filter((event) => event.action !== undefined &&
    (event.category === "checkpoint-cancelled" || event.category === "checkpoint-exhausted"));
}

describe("settled resumed cancellation protocol", () => {
  it("uses one explicit-request deadline across phased leases, adapter invocation, and evidence", async () => {
    const clock = manualClock();
    const ordering: string[] = [];
    let context!: ResumeContext;
    let controller!: MidRunCompactionController;
    let triggerLease!: HostInputLease;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: (candidate) => {
        context = candidate;
        const trigger = controller.admitHostInput("continuation-trigger");
        expect(trigger.kind).toBe("lease");
        triggerLease = (trigger as { kind: "lease"; lease: HostInputLease }).lease;
        return {
          replay: async () => ({ delivered: true }),
          cancelAndJoin: async () => {
            ordering.push("adapter");
            expect(controller.settleHostInput(triggerLease)).toBe(true);
            expect(controller.resumedAborted(candidate.token)).toBe(true);
            expect(controller.resumedSettled(candidate.token, "cancelled")).toBe(true);
            return { ending: "aborted" as const };
          },
        };
      },
      cancelledInput: (handoff) => {
        ordering.push("handoff");
        return resolution(handoff, "reported");
      },
      deadlinePolicy: { clock, resumedJoinMs: 10 },
    });
    const generation = arm(controller);
    controller.shadowInput(generation, "retained", "steer");
    const checkpoint = controller.checkpoint(generation);
    await waitUntil({ description: "explicit resume ownership", predicate: () => context !== undefined && !!triggerLease });
    await Promise.resolve();
    const prejoin = controller.admitHostInput("subagent-input");
    expect(prejoin.kind).toBe("lease");
    const request = context.requestCancellation("task-stop");
    expect(controller.snapshot().phase).toBe("terminalizing");
    expect(clock.pending()).toBe(true);
    expect(clock.schedules()).toBe(1);
    await Promise.resolve();
    expect(ordering).toEqual([]);
    expect(controller.settleHostInput((prejoin as { kind: "lease"; lease: HostInputLease }).lease)).toBe(true);
    await expect(request).resolves.toEqual({ cancelled: true, rejected: [] });
    await checkpoint;
    expect(ordering).toEqual(["adapter", "handoff"]);
    expect(clock.pending()).toBe(false);
    expect(controller.snapshot()).toMatchObject({ phase: "idle", admission: "open" });
  });

  it.each(["reported", "unresolved"] as const)(
    "keeps an authenticated restart-required handoff process-terminal with %s retained custody",
    async (disposition) => {
      const progress: CheckpointProgress[] = [];
      let context!: ResumeContext;
      let controller!: MidRunCompactionController;
      controller = new MidRunCompactionController({
        sessionId: "rpc-session",
        threshold: 90,
        compact: async () => {
          controller.observeCompactionCommit(controller.snapshot().generation);
          return { ok: true };
        },
        resume: (candidate) => {
          context = candidate;
          return {
            replay: async () => ({ delivered: true, pendingHostStart: true }),
            cancelAndJoin: async () => {
              expect(controller.resumedAborted(candidate.token)).toBe(true);
              expect(controller.resumedSettled(candidate.token, "cancelled")).toBe(true);
              return { ending: "aborted" as const };
            },
          };
        },
        cancelledInput: (handoff) => resolution(handoff, disposition, "restart-required"),
        progress: (event) => progress.push(event),
      });
      const generation = arm(controller);
      controller.shadowInput(generation, "retained", "followUp");
      const checkpoint = controller.checkpoint(generation);
      await waitUntil({ description: "terminal resume ownership", predicate: () => context !== undefined });

      await expect(context.requestCancellation("user")).resolves.toEqual({ cancelled: true, rejected: [] });
      await checkpoint;

      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted",
        admission: "closed",
        queuedInputs: disposition === "unresolved" ? 1 : 0,
        failureCategory: "restart-required",
        stage: "resumed-cancellation",
      });
      expect(controller.isProcessTerminal()).toBe(true);
      expect(controller.ordinaryInputDisposition()).toBe("reject-closed");
      expect(controller.providerAdmissionAllowed(generation)).toBe(false);
      expect(controller.manualCompactionDisposition()).toBe("unavailable");
      expect(terminalActions(progress)).toEqual([
        expect.objectContaining({
          category: "checkpoint-cancelled",
          action: "restart-process",
          failureCategory: "restart-required",
          stage: "resumed-cancellation",
        }),
      ]);
      expect(progress.some((event) => event.action === "session-reusable")).toBe(false);
    },
  );

  it.each(["requested-first", "observed-first"] as const)(
    "converges %s duplicate and stale resumed requests on one owner",
    async (order) => {
      const clock = manualClock();
      const handoffGate = deferred<CancelledInputResolution>();
      let context!: ResumeContext;
      let captured!: CancelledInputHandoff;
      let adapterCalls = 0;
      let handoffCalls = 0;
      let controller!: MidRunCompactionController;
      controller = new MidRunCompactionController({
        sessionId: "session", threshold: 90,
        compact: async () => {
          controller.observeCompactionCommit(controller.snapshot().generation);
          return { ok: true };
        },
        resume: (candidate) => {
          context = candidate;
          return {
            replay: async () => ({ delivered: true }),
            cancelAndJoin: async () => {
              adapterCalls += 1;
              expect(controller.resumedAborted(candidate.token)).toBe(true);
              expect(controller.resumedSettled(candidate.token, "cancelled")).toBe(true);
              return { ending: "aborted" as const };
            },
          };
        },
        cancelledInput: (handoff) => {
          handoffCalls += 1;
          captured = handoff;
          return handoffGate.promise;
        },
        deadlinePolicy: { clock, resumedJoinMs: 10 },
      });
      const generation = arm(controller);
      controller.shadowInput(generation, "retained", "steer");
      const checkpoint = controller.checkpoint(generation);
      await waitUntil({ description: "overlap resume context", predicate: () => context !== undefined });
      await Promise.resolve();

      let first: Promise<CancellationOutcome>;
      if (order === "observed-first") {
        expect(controller.resumedAborted(context.token)).toBe(true);
        expect(controller.resumedSettled(context.token, "cancelled")).toBe(true);
        first = context.requestCancellation("task-stop");
      } else {
        first = context.requestCancellation("task-stop");
      }
      const duplicate = context.requestCancellation("shutdown");
      expect(duplicate).toBe(first);
      await waitUntil({ description: "single overlap handoff", predicate: () => handoffCalls === 1 && clock.pending() });
      await expect(controller.requestResumedCancellation({ generation, token: {} }, "replacement"))
        .resolves.toEqual({ cancelled: false, rejected: [] });
      handoffGate.resolve(resolution(captured, "reported"));
      await expect(Promise.all([first, duplicate])).resolves.toEqual([
        { cancelled: true, rejected: [] }, { cancelled: true, rejected: [] },
      ]);
      await checkpoint;
      expect(adapterCalls).toBe(order === "requested-first" ? 1 : 0);
      expect(handoffCalls).toBe(1);
      expect(clock.pending()).toBe(false);
      expect(clock.schedules()).toBe(1);
    },
  );

  it("identity-invalidates an in-flight shared request before late success can hand off custody", async () => {
    const adapter = deferred<{ ending: "aborted" }>();
    const progress: CheckpointProgress[] = [];
    let context!: ResumeContext;
    let handoffs = 0;
    let controller!: MidRunCompactionController;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: (candidate) => {
        context = candidate;
        return {
          replay: async () => ({ delivered: true, pendingHostStart: true }),
          cancelAndJoin: async () => await adapter.promise,
        };
      },
      cancelledInput: (handoff) => {
        handoffs += 1;
        return resolution(handoff);
      },
      progress: (event) => progress.push(event),
    });
    const generation = arm(controller);
    controller.shadowInput(generation, "retained", "steer");
    const checkpoint = controller.checkpoint(generation);
    await waitUntil({ description: "shared invalidation context", predicate: () => context !== undefined });
    const request = context.requestCancellation("task-stop");
    await Promise.resolve();
    expect(controller.invalidateResumedCancellation(context.token)).toBe(true);
    expect(controller.invalidateResumedCancellation(context.token)).toBe(true);
    await expect(request).rejects.toThrow(/contradictory/iu);
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted", failureCategory: "unconfirmed-host", queuedInputs: 1,
    });
    adapter.resolve({ ending: "aborted" });
    await checkpoint;
    await Promise.resolve();
    expect(handoffs).toBe(0);
    expect(controller.queuedInputSnapshot()).toHaveLength(1);
    expect(progress.filter((event) => event.failureCategory === "unconfirmed-host")).toHaveLength(1);
    expect(controller.invalidateResumedCancellation({ generation, token: {} })).toBe(false);
  });

  it("bounds an explicit cancellation adapter by default and quarantines without a second deadline", async () => {
    const clock = manualClock();
    const adapter = deferred<void>();
    const replay = deferred<{ delivered: true }>();
    let context!: ResumeContext;
    let controller!: MidRunCompactionController;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: (candidate) => {
        context = candidate;
        return {
          replay: () => replay.promise,
          cancelAndJoin: () => adapter.promise,
        };
      },
      cancelledInput: (handoff) => resolution(handoff),
      deadlinePolicy: { clock },
    });
    const generation = arm(controller);
    controller.shadowInput(generation, "retained", "followUp");
    const checkpoint = controller.checkpoint(generation);
    await waitUntil({ description: "explicit cancellation context", predicate: () => context !== undefined });
    await Promise.resolve();
    const request = context.requestCancellation("shutdown");
    await waitUntil({ description: "single explicit deadline", predicate: () => clock.pending() });
    clock.expire();
    await expect(request).rejects.toThrow(/deadline/iu);
    await checkpoint;
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted", queuedInputs: 1, failureCategory: "unconfirmed-host", stage: "cancellation-join",
    });
    adapter.resolve();
    await Promise.resolve();
    expect(controller.snapshot()).toMatchObject({ phase: "exhausted", queuedInputs: 1 });
    expect(clock.pending()).toBe(false);
    expect(clock.schedules()).toBe(1);
  });

  it("keeps legacy generic cancellation unbounded when no deadline policy is configured", async () => {
    const adapter = deferred<void>();
    const run = deferred<void>();
    let context!: ResumeContext;
    let adapterCalls = 0;
    const controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => ({ ok: true }),
      resume: (candidate) => {
        context = candidate;
        return {
          replay: async () => ({ delivered: true }),
          settled: run.promise,
          cancelAndJoin: async () => {
            adapterCalls += 1;
            await adapter.promise;
          },
        };
      },
    });
    const generation = arm(controller);
    const checkpoint = controller.checkpoint(generation);
    await waitUntil({ description: "legacy generic resume context", predicate: () => context !== undefined });
    const cancellation = controller.cancel(generation, "shutdown");
    let finished = false;
    void cancellation.then(() => { finished = true; });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    expect(adapterCalls).toBe(1);
    expect(finished).toBe(false);
    expect(controller.snapshot()).toMatchObject({ phase: "cancelled" });
    adapter.resolve();
    run.resolve();
    await expect(cancellation).resolves.toMatchObject({ cancelled: true });
    await checkpoint;
  });

  it("revokes admission, joins every send-class lease, then performs one authenticated handoff", async () => {
    const classes: HostInputClass[] = [
      "restoration-control",
      "continuation-trigger",
      "retained-replay",
      "ordinary-input",
      "subagent-input",
      "panel-steer",
    ];
    const progress: CheckpointProgress[] = [];
    const ordering: string[] = [];
    const replay = deferred<{ delivered: true }>();
    let context!: ResumeContext;
    let handoff!: CancelledInputHandoff;
    let compactCalls = 0;
    let resumeCalls = 0;
    let replayCalls = 0;
    let handoffCalls = 0;
    let controller!: MidRunCompactionController;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        compactCalls += 1;
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: (candidate) => {
        resumeCalls += 1;
        context = candidate;
        return {
          replay: async () => {
            replayCalls += 1;
            return replay.promise;
          },
          cancelAndJoin: async () => undefined,
        };
      },
      cancelledInput: async (candidate) => {
        handoffCalls += 1;
        ordering.push("handoff");
        handoff = candidate;
        return {
          ...resolution(candidate),
          resolutions: candidate.retained.map((entry, index) => ({
            id: entry.id,
            disposition: index === 0 ? "restored" as const : "reported" as const,
          })),
        };
      },
      progress: (event) => progress.push(event),
    });

    const generation = arm(controller);
    const accepted = controller.shadowInput(generation, "accepted", "steer")!;
    const owned = controller.shadowInput(generation, "owned", "followUp")!;
    const checkpoint = controller.checkpoint(generation);
    await waitUntil({ description: "resumed run to start", predicate: () => context !== undefined });

    const leases = classes.map((inputClass) => {
      const admission = controller.admitHostInput(inputClass);
      expect(admission.kind).toBe("lease");
      return (admission as { kind: "lease"; lease: HostInputLease }).lease;
    });
    expect(controller.settleHostInput(leases[0]!, accepted)).toBe(true);
    expect(controller.settleHostInput({ ...leases[1]! })).toBe(false);
    expect(controller.resumedAborted({ ...context.token })).toBe(false);
    expect(controller.resumedSettled(context.token, "cancelled")).toBe(false);
    expect(controller.resumedAborted(context.token)).toBe(true);
    expect(controller.resumedSettled(context.token, "cancelled")).toBe(true);
    expect(controller.snapshot().phase).toBe("terminalizing");
    expect(controller.resumedSettled(context.token, "cancelled")).toBe(false);
    expect(controller.admitHostInput("ordinary-input")).toEqual({ kind: "refuse-settling" });
    expect(controller.ordinaryInputDisposition()).toBe("reject-settling");
    expect(controller.providerAdmissionAllowed(generation)).toBe(false);
    expect(controller.shadowInput(generation, "late", "steer")).toBeUndefined();
    expect(controller.consumeShadow(generation, accepted.id)).toBeUndefined();
    const replacement = controller.cancel(generation, "replacement");
    const shutdown = controller.cancel(generation, "shutdown");

    for (const lease of leases.slice(1, -1)) {
      expect(controller.settleHostInput(lease)).toBe(true);
    }
    await Promise.resolve();
    expect(ordering).toEqual([]);
    expect(controller.settleHostInput(leases.at(-1)!)).toBe(true);
    expect(controller.settleHostInput(leases.at(-1)!)).toBe(false);

    await checkpoint;
    await expect(replacement).resolves.toEqual({ cancelled: true, rejected: [] });
    await expect(shutdown).resolves.toEqual({ cancelled: true, rejected: [] });
    expect(ordering).toEqual(["handoff"]);
    expect(handoff.retained).toEqual([accepted, owned]);
    expect(handoff.acceptedToHostIds).toEqual([accepted.id]);
    expect(handoff.piccOwnedIds).toEqual([owned.id]);
    expect(controller.snapshot()).toMatchObject({ phase: "idle", admission: "open", queuedInputs: 0 });
    expect(progress.filter((event) => event.action === "session-reusable")).toEqual([
      expect.objectContaining({
        category: "checkpoint-cancelled",
        failureCategory: "restoration-paused",
        stage: "resumed-cancellation",
      }),
    ]);
    expect({ compactCalls, resumeCalls, replayCalls, handoffCalls }).toEqual({
      compactCalls: 1,
      resumeCalls: 1,
      replayCalls: 1,
      handoffCalls: 1,
    });
    expect(progress.filter((event) => event.action === "session-reusable")).toHaveLength(1);
    replay.resolve({ delivered: true });
    await Promise.resolve();
    expect(controller.snapshot().phase).toBe("idle");
    expect(controller.resumedAborted(context.token)).toBe(false);
    expect(controller.resumedSettled(context.token, "cancelled")).toBe(false);
  });

  it("claims cancellation before a synchronous resume return and makes immediate endings join it", async () => {
    const progress: CheckpointProgress[] = [];
    let replacement!: Promise<CancellationOutcome>;
    let shutdown!: Promise<CancellationOutcome>;
    let compactCalls = 0;
    let resumeCalls = 0;
    let replayCalls = 0;
    let cancelAndJoinCalls = 0;
    let handoffCalls = 0;
    let controller!: MidRunCompactionController;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        compactCalls += 1;
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: (context) => {
        resumeCalls += 1;
        expect(controller.resumedAborted(context.token)).toBe(true);
        expect(controller.resumedSettled(context.token, "cancelled")).toBe(true);
        expect(controller.snapshot().phase).toBe("terminalizing");
        replacement = controller.cancel(context.generation, "replacement");
        shutdown = controller.cancel(context.generation, "shutdown");
        return {
          replay: async () => {
            replayCalls += 1;
            return { delivered: true };
          },
          cancelAndJoin: async () => {
            cancelAndJoinCalls += 1;
          },
        };
      },
      cancelledInput: (handoff) => {
        handoffCalls += 1;
        return resolution(handoff);
      },
      progress: (event) => progress.push(event),
    });

    const generation = arm(controller);
    controller.shadowInput(generation, "retained", "steer");
    await controller.checkpoint(generation);
    await expect(replacement).resolves.toEqual({ cancelled: true, rejected: [] });
    await expect(shutdown).resolves.toEqual({ cancelled: true, rejected: [] });

    expect(controller.snapshot()).toMatchObject({ phase: "idle", admission: "open", queuedInputs: 0 });
    expect({ compactCalls, resumeCalls, replayCalls, cancelAndJoinCalls, handoffCalls }).toEqual({
      compactCalls: 1,
      resumeCalls: 1,
      replayCalls: 0,
      cancelAndJoinCalls: 0,
      handoffCalls: 1,
    });
    expect(terminalActions(progress)).toEqual([{
      category: "checkpoint-cancelled",
      generation,
      action: "session-reusable",
      failureCategory: "restoration-paused",
      stage: "resumed-cancellation",
    }]);
  });

  it("keeps unresolved custody out of immediate replacement and shutdown join results", async () => {
    const progress: CheckpointProgress[] = [];
    let replacement!: Promise<CancellationOutcome>;
    let shutdown!: Promise<CancellationOutcome>;
    let capturedHandoff!: CancelledInputHandoff;
    let handoffCalls = 0;
    let controller!: MidRunCompactionController;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: (context) => {
        expect(controller.resumedAborted(context.token)).toBe(true);
        expect(controller.resumedSettled(context.token, "cancelled")).toBe(true);
        replacement = controller.cancel(context.generation, "replacement");
        shutdown = controller.cancel(context.generation, "shutdown");
        return { replay: async () => ({ delivered: true }), cancelAndJoin: async () => undefined };
      },
      cancelledInput: (handoff) => {
        handoffCalls += 1;
        capturedHandoff = handoff;
        return resolution(handoff, "unresolved");
      },
      progress: (event) => progress.push(event),
    });

    const generation = arm(controller);
    const retained = controller.shadowInput(generation, "retained", "followUp")!;
    await controller.checkpoint(generation);
    await expect(replacement).resolves.toEqual({ cancelled: true, rejected: [] });
    await expect(shutdown).resolves.toEqual({ cancelled: true, rejected: [] });

    expect(controller.queuedInputSnapshot()).toEqual([retained]);
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted",
      admission: "closed",
      queuedInputs: 1,
      failureCategory: "restoration-paused",
      stage: "cancellation-join",
    });
    expect(capturedHandoff.retained).toEqual([retained]);
    expect(capturedHandoff.acceptedToHostIds).toEqual([]);
    expect(capturedHandoff.piccOwnedIds).toEqual([retained.id]);
    expect(handoffCalls).toBe(1);
    expect(terminalActions(progress)).toEqual([{
      category: "checkpoint-exhausted",
      generation,
      action: "new-session",
      failureCategory: "restoration-paused",
      stage: "cancellation-join",
    }]);
  });

  it("keeps unconfirmed handoff custody out of immediate replacement and shutdown join results", async () => {
    const clock = manualClock();
    const progress: CheckpointProgress[] = [];
    const handoffSettlement = deferred<CancelledInputResolution>();
    let replacement!: Promise<CancellationOutcome>;
    let shutdown!: Promise<CancellationOutcome>;
    let capturedHandoff!: CancelledInputHandoff;
    let handoffCalls = 0;
    let controller!: MidRunCompactionController;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: (context) => {
        expect(controller.resumedAborted(context.token)).toBe(true);
        expect(controller.resumedSettled(context.token, "cancelled")).toBe(true);
        replacement = controller.cancel(context.generation, "replacement");
        shutdown = controller.cancel(context.generation, "shutdown");
        return { replay: async () => ({ delivered: true }), cancelAndJoin: async () => undefined };
      },
      cancelledInput: (handoff) => {
        handoffCalls += 1;
        capturedHandoff = handoff;
        return handoffSettlement.promise;
      },
      progress: (event) => progress.push(event),
      deadlinePolicy: { clock, resumedJoinMs: 10 },
    });

    const generation = arm(controller);
    const retained = controller.shadowInput(generation, "retained", "steer")!;
    const checkpoint = controller.checkpoint(generation);
    await waitUntil({
      description: "immediate join handoff deadline",
      predicate: () => capturedHandoff !== undefined && clock.pending(),
    });
    clock.expire();
    await checkpoint;
    await expect(replacement).resolves.toEqual({ cancelled: true, rejected: [] });
    await expect(shutdown).resolves.toEqual({ cancelled: true, rejected: [] });

    expect(controller.queuedInputSnapshot()).toEqual([retained]);
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted",
      admission: "closed",
      queuedInputs: 1,
      failureCategory: "unconfirmed-host",
      stage: "cancellation-join",
    });
    expect(capturedHandoff.retained).toEqual([retained]);
    expect(handoffCalls).toBe(1);
    expect(terminalActions(progress)).toEqual([{
      category: "checkpoint-cancelled",
      generation,
      action: "restart-process",
      failureCategory: "unconfirmed-host",
      stage: "cancellation-join",
    }]);

    handoffSettlement.resolve(resolution(capturedHandoff));
    await Promise.resolve();
    expect(controller.queuedInputSnapshot()).toEqual([retained]);
    expect(terminalActions(progress)).toHaveLength(1);
  });

  it("authenticates equal-content custom replay with its opaque occurrence envelope", async () => {
    const gate = new MainSessionCheckpointGate("main", 90);
    const controller = gate.currentController();
    let context!: ResumeContext;
    let forgedAccepted = true;
    gate.attachExecution({
      compact: async () => {
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: (candidate) => {
        context = candidate;
        return {
          replay: async (input) => gate.withRetainedReplayAuthorization(input, (details) => {
            forgedAccepted = gate.authorizeReplay({
              text: "same",
              source: "extension",
              streamingBehavior: input.delivery,
              details: { piccCheckpointInput: { ...details.piccCheckpointInput } },
            }) !== undefined;
            return {
              delivered: gate.authorizeReplay({
                text: "same",
                source: "extension",
                streamingBehavior: input.delivery,
                details,
              }) === input,
              pendingHostStart: true,
            };
          }),
          cancelAndJoin: async () => undefined,
        };
      },
      cancelledInput: (handoff) => resolution(handoff),
    });
    const ctx = {
      model: { api: "openai-responses", contextWindow: 1000 },
      getContextUsage: () => usage,
      hasPendingMessages: () => false,
    };
    gate.assistantMessageEnded({
      role: "assistant",
      stopReason: "toolUse",
      usage: {
        input: 900, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 900,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [{ type: "toolCall", id: "tool", name: "probe", arguments: {} }],
    }, ctx);
    const wrapped: any = gate.wrapTool({ execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("tool", {}, undefined, undefined, ctx);
    gate.toolExecutionEnded({ toolCallId: "tool", result, isError: false });
    gate.captureAcceptedInput(ctx, "same", undefined, "steer");
    gate.turnEnded(ctx);
    const generation = gate.settlementGeneration(ctx)!;
    const checkpoint = controller.checkpoint(generation);
    await waitUntil({ description: "strict replay", predicate: () => context !== undefined });
    expect(forgedAccepted).toBe(false);
    expect(controller.resumedAborted(context.token)).toBe(true);
    expect(controller.resumedSettled(context.token, "cancelled")).toBe(true);
    await checkpoint;
    expect(controller.snapshot().phase).toBe("idle");
  });

  it.each([true, false] as const)(
    "bounds an all-lease join without claiming handoff or quiescence and ignores late receipts delivered=%s",
    async (delivered) => {
      const clock = manualClock();
      const replay = deferred<{ delivered: true } | { delivered: false }>();
      let context!: ResumeContext;
      let handoffs = 0;
      let controller!: MidRunCompactionController;
      controller = new MidRunCompactionController({
        sessionId: "session",
        threshold: 90,
        compact: async () => {
          controller.observeCompactionCommit(controller.snapshot().generation);
          return { ok: true };
        },
        resume: (candidate) => {
          context = candidate;
          return { replay: () => replay.promise, cancelAndJoin: async () => undefined };
        },
        cancelledInput: (handoff) => {
          handoffs += 1;
          return resolution(handoff);
        },
        deadlinePolicy: { clock, resumedJoinMs: 10 },
      });
      const generation = arm(controller);
      controller.shadowInput(generation, "retained", "steer");
      const checkpoint = controller.checkpoint(generation);
      await waitUntil({ description: "resume context", predicate: () => context !== undefined });
      const admission = controller.admitHostInput("retained-replay");
      expect(admission.kind).toBe("lease");
      const lease = (admission as { kind: "lease"; lease: HostInputLease }).lease;
      expect(controller.resumedAborted(context.token)).toBe(true);
      expect(controller.resumedSettled(context.token, "cancelled")).toBe(true);
      await waitUntil({ description: "lease join deadline to arm", predicate: () => clock.pending() });
      clock.expire();
      await checkpoint;

      expect(handoffs).toBe(0);
      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted",
        admission: "closed",
        queuedInputs: 1,
        failureCategory: "unconfirmed-host",
        stage: "cancellation-join",
      });
      expect(controller.ordinaryInputDisposition()).toBe("reject-closed");
      const exhaustedSnapshot = controller.snapshot();
      const retainedQueue = controller.queuedInputSnapshot();
      const deadlineSchedules = clock.schedules();
      expect(controller.settleHostInput(lease)).toBe(false);
      await expect(controller.cancel(generation, "replacement")).resolves.toEqual({ cancelled: false, rejected: [] });

      replay.resolve(delivered ? { delivered: true } : { delivered: false });
      await replay.promise;
      await Promise.resolve();
      await Promise.resolve();

      expect(controller.queuedInputSnapshot()).toEqual(retainedQueue);
      expect(controller.snapshot()).toEqual(exhaustedSnapshot);
      expect(controller.ordinaryInputDisposition()).toBe("reject-closed");
      expect(handoffs).toBe(0);
      expect(clock.schedules()).toBe(deadlineSchedules);
      expect(deadlineSchedules).toBe(1);
    },
  );

  it("bounds a cancellation handoff that never settles and preserves controller custody", async () => {
    const clock = manualClock();
    const replay = deferred<{ delivered: true }>();
    const handoffSettlement = deferred<CancelledInputResolution>();
    const progress: CheckpointProgress[] = [];
    let context!: ResumeContext;
    let capturedHandoff!: CancelledInputHandoff;
    let handoffCalls = 0;
    let controller!: MidRunCompactionController;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: (candidate) => {
        context = candidate;
        return { replay: () => replay.promise, cancelAndJoin: async () => undefined };
      },
      cancelledInput: (handoff) => {
        handoffCalls += 1;
        capturedHandoff = handoff;
        return handoffSettlement.promise;
      },
      progress: (event) => progress.push(event),
      deadlinePolicy: { clock, resumedJoinMs: 10 },
    });
    const generation = arm(controller);
    controller.shadowInput(generation, "retained", "followUp");
    const checkpoint = controller.checkpoint(generation);
    await waitUntil({ description: "resume context", predicate: () => context !== undefined });
    expect(controller.resumedAborted(context.token)).toBe(true);
    expect(controller.resumedSettled(context.token, "cancelled")).toBe(true);
    await waitUntil({
      description: "cancelled-input handoff deadline",
      predicate: () => capturedHandoff !== undefined && clock.pending(),
    });
    clock.expire();
    await checkpoint;
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted",
      admission: "closed",
      queuedInputs: 1,
      failureCategory: "unconfirmed-host",
      stage: "cancellation-join",
    });
    expect(controller.isProcessTerminal()).toBe(true);
    expect(controller.admitHostInput("ordinary-input")).toEqual({ kind: "refuse-settling" });
    expect(controller.ordinaryInputDisposition()).toBe("reject-closed");
    expect(progress.at(-1)).toEqual({
      category: "checkpoint-cancelled",
      generation,
      action: "restart-process",
      failureCategory: "unconfirmed-host",
      stage: "cancellation-join",
    });
    expect(handoffCalls).toBe(1);
    handoffSettlement.resolve(resolution(capturedHandoff));
    replay.resolve({ delivered: true });
    await Promise.resolve();
    expect(controller.snapshot()).toMatchObject({ phase: "exhausted", queuedInputs: 1 });
    expect(controller.resumedAborted(context.token)).toBe(false);
    expect(controller.resumedSettled(context.token, "cancelled")).toBe(false);
    await expect(controller.cancel(generation, "replacement")).resolves.toEqual({ cancelled: false, rejected: [] });
    expect(clock.schedules()).toBe(1);
  });

  it.each([
    "restoration",
    "continuation-start",
    "input-replay",
    "provider-release",
    "resumed-work",
  ] as const)("records the %s post-commit terminal stage without retry", async (stage) => {
    const progress: CheckpointProgress[] = [];
    let context: ResumeContext | undefined;
    let replayed = false;
    let replayCalls = 0;
    let replayCompleteCalls = 0;
    let controller!: MidRunCompactionController;
    let compactCalls = 0;
    let resumeCalls = 0;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        compactCalls += 1;
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: async (candidate) => {
        resumeCalls += 1;
        context = candidate;
        if (stage === "restoration") throw new Error("restore failed");
        if (stage === "continuation-start") {
          expect(candidate.advancePostCommitStage("continuation-start")).toBe(true);
          return {} as never;
        }
        return {
          replay: async () => {
            replayCalls += 1;
            replayed = true;
            return stage === "input-replay"
              ? { delivered: false as const }
              : { delivered: true as const, pendingHostStart: true };
          },
          replayComplete: stage === "provider-release"
            ? async () => {
                replayCompleteCalls += 1;
                throw new Error("release failed");
              }
            : undefined,
          cancelAndJoin: async () => undefined,
        };
      },
      progress: (event) => progress.push(event),
    });
    const generation = arm(controller);
    if (stage === "input-replay" || stage === "resumed-work") {
      controller.shadowInput(generation, "retained", "steer");
    }
    const checkpoint = controller.checkpoint(generation);
    if (stage === "resumed-work") {
      await waitUntil({
        description: "resumed work to await settlement",
        predicate: () => context !== undefined && replayed,
      });
      expect(controller.resumedSettled(context!.token)).toBe(true);
    }
    await checkpoint;
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted",
      failureCategory: "restoration-paused",
      stage,
    });
    expect(progress.at(-1)).toEqual({
      category: "checkpoint-exhausted",
      generation,
      action: "new-session",
      failureCategory: "restoration-paused",
      stage,
    });
    expect({ compactCalls, resumeCalls }).toEqual({ compactCalls: 1, resumeCalls: 1 });
    expect(replayCalls).toBe(stage === "input-replay" || stage === "resumed-work" ? 1 : 0);
    expect(replayCompleteCalls).toBe(stage === "provider-release" ? 1 : 0);
  });

  it("advances continuation-start monotonically with resume identity before a throwing trigger", async () => {
    const progress: CheckpointProgress[] = [];
    let context!: ResumeContext;
    let controller!: MidRunCompactionController;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: (candidate) => {
        context = candidate;
        expect(candidate.advancePostCommitStage("continuation-start")).toBe(true);
        expect(candidate.advancePostCommitStage("continuation-start")).toBe(false);
        throw new Error("trigger failed");
      },
      progress: (event) => progress.push(event),
    });
    const generation = arm(controller);
    await controller.checkpoint(generation);

    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted",
      failureCategory: "restoration-paused",
      stage: "continuation-start",
    });
    expect(progress.at(-1)).toEqual({
      category: "checkpoint-exhausted",
      generation,
      action: "new-session",
      failureCategory: "restoration-paused",
      stage: "continuation-start",
    });
    expect(context.advancePostCommitStage("continuation-start")).toBe(false);
  });

  it("keeps omitted external committed-summary failures stage-less", async () => {
    const progress: CheckpointProgress[] = [];
    const controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => ({ ok: true }),
      progress: (event) => progress.push(event),
    });
    const generation = arm(controller);
    expect(controller.observeCompactionCommit(generation)).toBe(true);
    await controller.failAfterCommittedSummary(generation);

    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted",
      failureCategory: "restoration-paused",
    });
    expect(controller.snapshot()).not.toHaveProperty("stage");
    expect(progress.at(-1)).toEqual({
      category: "checkpoint-exhausted",
      generation,
      action: "new-session",
      failureCategory: "restoration-paused",
    });
  });

  it("records restoration for committed unconfirmed compaction and refuses all terminal fallback", async () => {
    const progress: CheckpointProgress[] = [];
    let controller!: MidRunCompactionController;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: false, category: "unconfirmed-host" };
      },
      progress: (event) => progress.push(event),
    });
    const generation = arm(controller);
    await controller.checkpoint(generation);

    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted",
      admission: "closed",
      failureCategory: "unconfirmed-host",
      stage: "restoration",
    });
    expect(controller.admitHostInput("ordinary-input")).toEqual({ kind: "refuse-settling" });
    expect(controller.ordinaryInputDisposition()).toBe("reject-closed");
    expect(progress.at(-1)).toEqual({
      category: "checkpoint-cancelled",
      generation,
      action: "restart-process",
      failureCategory: "unconfirmed-host",
      stage: "restoration",
    });
  });

  it("uses inactive admission only while idle and refuses exhausted, cancelled, and unresolved terminals", async () => {
    const idle = new MidRunCompactionController({
      sessionId: "idle",
      threshold: 90,
      compact: async () => ({ ok: true }),
    });
    expect(idle.admitHostInput("ordinary-input")).toEqual({ kind: "inactive" });

    const exhausted = new MidRunCompactionController({
      sessionId: "exhausted",
      threshold: 90,
      compact: async () => ({ ok: false, category: "operational" }),
    });
    await exhausted.checkpoint(arm(exhausted));
    expect(exhausted.admitHostInput("ordinary-input")).toEqual({ kind: "refuse-settling" });
    expect(exhausted.ordinaryInputDisposition()).toBe("reject-recoverable");

    const cancelled = new MidRunCompactionController({
      sessionId: "cancelled",
      threshold: 90,
      compact: async () => ({ ok: true }),
    });
    const cancelledGeneration = arm(cancelled);
    const cancellation = cancelled.cancel(cancelledGeneration, "user");
    expect(cancelled.admitHostInput("ordinary-input")).toEqual({ kind: "refuse-settling" });
    expect(cancelled.ordinaryInputDisposition()).toBe("reject-closed");
    await cancellation;
  });

  it("removes only restored/reported IDs from a valid mixed resolution", async () => {
    const progress: CheckpointProgress[] = [];
    let context!: ResumeContext;
    let retainedIds: number[] = [];
    let handoffCalls = 0;
    let controller!: MidRunCompactionController;
    controller = new MidRunCompactionController({
      sessionId: "session",
      threshold: 90,
      compact: async () => {
        controller.observeCompactionCommit(controller.snapshot().generation);
        return { ok: true };
      },
      resume: (candidate) => {
        context = candidate;
        return { replay: async () => ({ delivered: true, pendingHostStart: true }), cancelAndJoin: async () => undefined };
      },
      cancelledInput: (handoff) => {
        handoffCalls += 1;
        return {
          ...resolution(handoff),
          resolutions: [
            { id: retainedIds[0]!, disposition: "restored" },
            { id: retainedIds[1]!, disposition: "unresolved" },
            { id: retainedIds[2]!, disposition: "reported" },
          ],
        };
      },
      progress: (event) => progress.push(event),
    });
    const generation = arm(controller);
    retainedIds = ["first", "second", "third"].map((text) =>
      controller.shadowInput(generation, text, "followUp")!.id);
    const checkpoint = controller.checkpoint(generation);
    await waitUntil({ description: "mixed-resolution resume", predicate: () => context !== undefined });
    expect(controller.resumedAborted(context.token)).toBe(true);
    expect(controller.resumedSettled(context.token, "cancelled")).toBe(true);
    await checkpoint;

    expect(controller.queuedInputSnapshot().map((entry) => entry.id)).toEqual([retainedIds[1]]);
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted",
      failureCategory: "restoration-paused",
      stage: "cancellation-join",
    });
    expect(controller.admitHostInput("ordinary-input")).toEqual({ kind: "refuse-settling" });
    expect(controller.ordinaryInputDisposition()).toBe("reject-restoration");
    expect(handoffCalls).toBe(1);
    expect(progress.at(-1)).toEqual({
      category: "checkpoint-exhausted",
      generation,
      action: "new-session",
      failureCategory: "restoration-paused",
      stage: "cancellation-join",
    });
  });

  it.each([
    "missing",
    "thrown",
    "forged",
    "stale-session",
    "stale-generation",
    "unknown-id",
    "invalid-shape",
    "invalid-disposition",
    "incomplete",
    "duplicate",
    "explicit-unresolved",
  ] as const)(
    "retains authenticated custody for a %s resolution",
    async (failure) => {
      let context!: ResumeContext;
      let retainedId = 0;
      let controller!: MidRunCompactionController;
      controller = new MidRunCompactionController({
        sessionId: "session",
        threshold: 90,
        compact: async () => {
          controller.observeCompactionCommit(controller.snapshot().generation);
          return { ok: true };
        },
        resume: (candidate) => {
          context = candidate;
          return { replay: async () => ({ delivered: true, pendingHostStart: true }), cancelAndJoin: async () => undefined };
        },
        ...(failure === "missing" ? {} : {
          cancelledInput: (handoff: CancelledInputHandoff): CancelledInputResolution => {
            if (failure === "thrown") throw new Error("observer failed");
            if (failure === "forged") return { ...resolution(handoff), token: {} };
            if (failure === "stale-session") return { ...resolution(handoff), sessionId: "stale" };
            if (failure === "stale-generation") return { ...resolution(handoff), generation: handoff.generation + 1 };
            if (failure === "unknown-id") return {
              ...resolution(handoff),
              resolutions: [{ id: retainedId + 1, disposition: "restored" }],
            };
            if (failure === "invalid-shape") return { ...resolution(handoff), resolutions: [42] } as never;
            if (failure === "invalid-disposition") return {
              ...resolution(handoff),
              resolutions: [{ id: retainedId, disposition: "lost" }],
            } as never;
            if (failure === "incomplete") return { ...resolution(handoff), resolutions: [] };
            if (failure === "duplicate") return {
              ...resolution(handoff),
              resolutions: [
                { id: retainedId, disposition: "restored" },
                { id: retainedId, disposition: "reported" },
              ],
            };
            return resolution(handoff, "unresolved");
          },
        }),
      });
      const generation = arm(controller);
      retainedId = controller.shadowInput(generation, "retained", "steer")!.id;
      const checkpoint = controller.checkpoint(generation);
      await waitUntil({ description: "resume context", predicate: () => context !== undefined });
      expect(controller.resumedAborted(context.token)).toBe(true);
      expect(controller.resumedSettled(context.token, "cancelled")).toBe(true);
      await checkpoint;

      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted",
        queuedInputs: 1,
        failureCategory: "restoration-paused",
        stage: "cancellation-join",
      });
      expect(controller.queuedInputSnapshot()[0]?.id).toBe(retainedId);
    },
  );
});

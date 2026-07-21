import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc from "../src/index.js";
import {
  PROACTIVE_COOLDOWN_TURNS,
  PROACTIVE_PENDING_MAX_TURNS,
  decideProactiveCompaction,
  initialPendingState,
  pendingStateAfterCompaction,
  type ProactivePendingState,
} from "../src/runtime/proactive-compaction.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { deferred, waitUntil } from "./helpers/async.js";
import {
  MainSessionCheckpointExecutionBridge,
  MainSessionCheckpointGate,
  MidRunCompactionController,
  callbackCompactionAttempt,
  promiseCompactionAttempt,
  type CompactionAttemptResult,
  type MidRunCompactionOptions,
} from "../src/runtime/mid-run-compaction.js";

// A usage shape at/around the threshold; percent is on the 0–100 scale.
const usageAt = (percent: number | null) => ({ tokens: 100, contextWindow: 1000, percent });

describe("decideProactiveCompaction (pure decision)", () => {
  const fresh = () => initialPendingState();

  it("does not compact below threshold", () => {
    const d = decideProactiveCompaction(usageAt(84.9), 85, fresh());
    expect(d.compact).toBe(false);
    expect(d.pending.pending).toBe(false);
  });

  it("compacts at exactly the threshold and sets the pending flag", () => {
    const d = decideProactiveCompaction(usageAt(85), 85, fresh());
    expect(d.compact).toBe(true);
    expect(d.pending.pending).toBe(true);
    expect(d.pending.turnsRemaining).toBe(PROACTIVE_PENDING_MAX_TURNS);
  });

  it("compacts above threshold", () => {
    expect(decideProactiveCompaction(usageAt(99.2), 85, fresh()).compact).toBe(true);
  });

  it("does not compact and does not throw on undefined usage", () => {
    const d = decideProactiveCompaction(undefined, 85, fresh());
    expect(d.compact).toBe(false);
  });

  it("does not compact on null percent (post-compaction window)", () => {
    const d = decideProactiveCompaction(usageAt(null), 85, fresh());
    expect(d.compact).toBe(false);
  });

  it("does not compact on a partial ctx shape (percent absent, tokens null)", () => {
    expect(decideProactiveCompaction({ tokens: 1234 } as any, 85, fresh()).compact).toBe(false);
    expect(decideProactiveCompaction({ tokens: null } as any, 85, fresh()).compact).toBe(false);
    expect(decideProactiveCompaction({} as any, 85, fresh()).compact).toBe(false);
  });

  it("anti-thrash: does not compact again while pending, even above threshold", () => {
    const first = decideProactiveCompaction(usageAt(90), 85, fresh());
    expect(first.compact).toBe(true);
    const second = decideProactiveCompaction(usageAt(90), 85, first.pending);
    expect(second.compact).toBe(false);
    expect(second.pending.pending).toBe(true);
  });

  it("anti-thrash cleared on success: a fresh (cleared) state re-triggers", () => {
    // `session_compact` success resets to initialPendingState() in the handler.
    const d = decideProactiveCompaction(usageAt(90), 85, initialPendingState());
    expect(d.compact).toBe(true);
  });

  it("anti-thrash bounded fallback: suppresses intermediate turns, then re-fires when the window elapses", () => {
    // No session_compact success arrives (a silent compaction failure fires no event); the
    // pending flag must suppress re-triggers, then re-evaluate so the feature retries rather
    // than deadlocking.
    let state: ProactivePendingState = decideProactiveCompaction(usageAt(90), 85, fresh()).pending;
    // Intermediate turns while pending never compact (pins the anti-thrash bound).
    for (let turn = 1; turn < PROACTIVE_PENDING_MAX_TURNS; turn++) {
      const d = decideProactiveCompaction(usageAt(90), 85, state);
      expect(d.compact).toBe(false);
      state = d.pending;
    }
    // On the turn the fallback window elapses it re-fires in that same turn.
    expect(decideProactiveCompaction(usageAt(90), 85, state).compact).toBe(true);
  });

  it("cooldown after a completed compaction: suppresses for the cooldown window, then re-fires", () => {
    // pendingStateAfterCompaction() is what the handler adopts on `session_compact` success.
    let state: ProactivePendingState = pendingStateAfterCompaction();
    for (let turn = 0; turn < PROACTIVE_COOLDOWN_TURNS; turn++) {
      const d = decideProactiveCompaction(usageAt(90), 85, state);
      expect(d.compact, `cooldown turn ${turn} must not compact`).toBe(false);
      state = d.pending;
    }
    // Once the cooldown elapses, an at/over-threshold turn compacts again.
    expect(decideProactiveCompaction(usageAt(90), 85, state).compact).toBe(true);
  });
});

describe("MidRunCompactionController", () => {
  const usage = (percent: number | null) => ({ tokens: 900, contextWindow: 1000, percent });
  const createController = (
    options: Omit<MidRunCompactionOptions, "manualCompaction"> &
      { manualCompaction?: MidRunCompactionOptions["manualCompaction"] },
  ) => new MidRunCompactionController({ manualCompaction: { kind: "unavailable" }, ...options });
  const owned = (settled: Promise<void> = Promise.resolve(), replay: (input: any) => void = () => undefined) => ({
    settled,
    replay: async (input: any) => {
      replay(input);
      return { delivered: true } as const;
    },
    cancelAndJoin: async () => undefined,
  });
  const arm = (controller: MidRunCompactionController, ids = ["a"]) => {
    const generation = controller.sample(usage(90), "tool")!;
    const handle = controller.beginToolBatch(generation, ids)!;
    for (const id of ids) controller.finalizeTool(handle, id, { owned: true, canTerminate: true });
    return { generation, handle };
  };

  it("arms independently per session and ignores unknown or below-threshold usage", () => {
    const make = (sessionId: string) => createController({ sessionId, threshold: 90, compact: async () => ({ ok: true }) });
    const first = make("first");
    const second = make("second");
    expect(first.sample(usage(89.9), "tool")).toBeUndefined();
    expect(first.sample(usage(null), "tool")).toBeUndefined();
    expect(first.sample(usage(90), "tool")).toBe(1);
    expect(second.snapshot().phase).toBe("idle");
  });

  it("generation-binds clean batch mutations, results, and stale callbacks", async () => {
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => ({ ok: true }), resume: () => owned(),
    });
    const generation = controller.sample(usage(91), "tool")!;
    const handle = controller.beginToolBatch(generation, ["a", "b"])!;
    controller.finalizeTool(handle, "b", { owned: true, canTerminate: true });
    const details = { stable: true };
    const original = { content: [{ type: "text", text: "done" }], details, isError: false };
    const patched = controller.terminateResult(handle, "b", original);
    expect(patched).toEqual({ ...original, terminate: true });
    expect(patched.content).toBe(original.content);
    expect(patched.details).toBe(details);
    controller.finalizeTool(handle, "a", { owned: true, canTerminate: true });
    expect(controller.completeToolBatch(handle).stop).toBe("terminate");
    await controller.checkpoint(generation);
    const next = controller.sample(usage(92), "tool")!;
    expect(controller.beginToolBatch(generation, ["stale"])).toBeUndefined();
    const nextHandle = controller.beginToolBatch(next, ["c"])!;
    expect(controller.finalizeTool(handle, "a", { owned: false, canTerminate: false })).toBe(false);
    expect(controller.terminateResult(handle, "a", original)).toBe(original);
    expect(controller.completeToolBatch(handle).stop).toBe("none");
    await expect(controller.cancel(generation, "user")).resolves.toEqual({ cancelled: false, rejected: [] });
    expect(controller.snapshot().phase).toBe("stopping");
    expect(next).toBe(2);
    controller.finalizeTool(nextHandle, "c", { owned: true, canTerminate: true });
  });

  it.each([
    ["empty", [] as string[], "none"], ["duplicate ids", ["a", "a"], "none"],
    ["unknown result", ["a"], "unknown"], ["duplicate result", ["a"], "duplicate"],
    ["incomplete", ["a", "b"], "incomplete"], ["mixed", ["a", "b"], "mixed"],
  ])("fails closed for %s batch completion", (_name, ids, mutation) => {
    const controller = createController({ sessionId: "s", threshold: 90, compact: async () => ({ ok: true }) });
    const generation = controller.sample(usage(90), "tool")!;
    const handle = controller.beginToolBatch(generation, ids)!;
    if (mutation === "unknown") controller.finalizeTool(handle, "z", { owned: true, canTerminate: true });
    if (mutation === "duplicate") {
      controller.finalizeTool(handle, "a", { owned: true, canTerminate: true });
      controller.finalizeTool(handle, "a", { owned: true, canTerminate: true });
    }
    if (mutation === "incomplete") controller.finalizeTool(handle, "a", { owned: true, canTerminate: true });
    if (mutation === "mixed") {
      controller.finalizeTool(handle, "a", { owned: true, canTerminate: true });
      controller.finalizeTool(handle, "b", { owned: false, canTerminate: false });
    }
    expect(controller.completeToolBatch(handle)).toMatchObject({ complete: true, stop: "abort" });
    expect(controller.isCheckpointAbort(generation)).toBe(true);
  });

  it("retries operational failure three times with bounded backoff", async () => {
    const attempts: number[] = [];
    const backoffs: number[] = [];
    const controller = createController({
      sessionId: "s", threshold: 90,
      compact: async (attempt) => { attempts.push(attempt); return attempt < 3 ? { ok: false, category: "operational" } : { ok: true }; },
      delay: async (milliseconds) => { backoffs.push(milliseconds); },
    });
    await controller.checkpoint(controller.sample(usage(90), "settled")!);
    expect(attempts).toEqual([1, 2, 3]);
    expect(backoffs).toEqual([25, 100]);
    expect(controller.snapshot().phase).toBe("idle");
  });

  it.each(["hook-blocked", "stale-generation", "overflow-recovery"] as const)("exhausts without retry for %s", async (category) => {
    let attempts = 0;
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => { attempts += 1; return { ok: false, category }; },
    });
    await controller.checkpoint(controller.sample(usage(90), "settled")!);
    expect(attempts).toBe(1);
    expect(controller.snapshot().phase).toBe("exhausted");
  });

  it.each(["cancelled", "shutdown"] as const)("cancels without retry for %s", async (category) => {
    const controller = createController({ sessionId: "s", threshold: 90, compact: async () => ({ ok: false, category }) });
    await controller.checkpoint(controller.sample(usage(90), "settled")!);
    expect(controller.snapshot().phase).toBe("cancelled");
  });

  it("retains exhaustion input under a generation-bound recovery token", async () => {
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => ({ ok: false, category: "operational" }),
      delay: async () => undefined, resume: () => owned(),
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    const queued = controller.shadowInput(generation, "held", "steer")!;
    await controller.checkpoint(generation);
    const token = controller.recoveryToken(generation)!;
    expect(controller.recoverAfterManualCompaction({ ...token })).toEqual({ recovered: false, rejected: [] });
    expect(controller.recoverAfterManualCompaction(token)).toEqual({ recovered: true, rejected: [queued] });
  });

  it("starts resumed ownership before duplicate/interleaved image replay and accepts arrivals", async () => {
    const events: string[] = [];
    const settlement = deferred<void>();
    const imageOne = [{ type: "image", data: "one" }];
    const imageTwo = [{ type: "image", data: "two" }];
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => ({ ok: true }),
      resume: () => { events.push("resume"); return owned(settlement.promise, (input) => events.push(`replay:${input.delivery}:${input.content === imageOne ? "one" : input.content === imageTwo ? "two" : input.content}`)); },
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    const consumed = controller.shadowInput(generation, "same", "steer")!;
    controller.shadowInput(generation, "same", "followUp");
    controller.shadowInput(generation, imageOne, "steer");
    controller.shadowInput(generation, imageTwo, "followUp");
    expect(controller.consumeShadow(generation, consumed.id)).toEqual(consumed);
    expect(controller.shadowInput(generation, "foreign", "steer", "other")).toBeUndefined();
    expect(controller.shadowInput(generation + 1, "stale", "steer")).toBeUndefined();
    const stable = controller.checkpoint(generation);
    await waitUntil({ description: "initial replay", predicate: () => events.length === 4 });
    controller.shadowInput(generation, "arrival", "steer");
    await waitUntil({ description: "arrival replay", predicate: () => events.includes("replay:steer:arrival") });
    settlement.resolve();
    await stable;
    expect(events).toEqual(["resume", "replay:followUp:same", "replay:steer:one", "replay:followUp:two", "replay:steer:arrival"]);
  });

  it("never accepts or replays input during settled fallback", async () => {
    let resumed = 0;
    const gate = deferred<CompactionAttemptResult>();
    const controller = createController({
      sessionId: "s", threshold: 90, compact: () => gate.promise,
      resume: () => { resumed += 1; return owned(); },
    });
    const generation = controller.sample(usage(90), "settled")!;
    const stable = controller.checkpoint(generation);
    expect(controller.shadowInput(generation, "late", "steer")).toBeUndefined();
    gate.resolve({ ok: true });
    await stable;
    expect(resumed).toBe(0);
  });

  it("transfers callback-style nested settlement only with its resume token", async () => {
    let token: Parameters<MidRunCompactionController["resumedSettled"]>[0] | undefined;
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => ({ ok: true }),
      resume: (context) => { token = context.token; return { replay: async () => ({ delivered: true }), cancelAndJoin: async () => undefined }; },
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    const stable = controller.checkpoint(generation);
    await waitUntil({ description: "callback resume", predicate: () => token !== undefined });
    expect(controller.resumedSettled({ ...token! })).toBe(false);
    expect(controller.resumedSettled(token!)).toBe(true);
    await stable;
  });

  it("fails closed and retains input when required resume ownership is absent", async () => {
    const controller = createController({ sessionId: "s", threshold: 90, compact: async () => ({ ok: true }) });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    controller.shadowInput(generation, "retained", "followUp");
    await controller.checkpoint(generation);
    expect(controller.snapshot()).toMatchObject({ phase: "exhausted", queuedInputs: 1 });
  });

  it.each([
    ["missing", undefined],
    ["partial", { kind: "available", isActive: () => false }],
  ])("fails closed for %s manual capability", async (_name, manualCompaction) => {
    let attempts = 0;
    const controller = new MidRunCompactionController({
      sessionId: "s",
      threshold: 90,
      compact: async () => { attempts += 1; return { ok: true }; },
      manualCompaction,
    } as MidRunCompactionOptions);
    const generation = controller.sample(usage(90), "settled")!;
    await controller.checkpoint(generation);
    expect(attempts).toBe(0);
    expect(controller.snapshot().phase).toBe("exhausted");
  });

  it("manual ownership rechecks end and rejects unknown usage", async () => {
    for (const sample of [{ ended: false, usage: usage(20) }, { ended: true, usage: undefined }]) {
      const controller = createController({
        sessionId: "s", threshold: 90, compact: async () => ({ ok: true }),
        manualCompaction: { kind: "available", isActive: () => true, waitAndResample: async () => sample }, resume: () => owned(),
      });
      const { generation, handle } = arm(controller);
      controller.completeToolBatch(handle);
      await controller.checkpoint(generation);
      expect(controller.snapshot().phase).toBe("exhausted");
    }
  });

  it("manual ownership resumes after a valid below-threshold resample", async () => {
    let active = true;
    let attempts = 0;
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => { attempts += 1; return { ok: true }; },
      manualCompaction: { kind: "available", isActive: () => active, waitAndResample: async () => { active = false; return { ended: true, usage: usage(20) }; } },
      resume: () => owned(),
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    await controller.checkpoint(generation);
    expect(attempts).toBe(0);
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("cancellation during manual wait waits for that work to join", async () => {
    const manual = deferred<{ ended: boolean; usage: ReturnType<typeof usage> }>();
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => ({ ok: true }),
      manualCompaction: { kind: "available", isActive: () => true, waitAndResample: () => manual.promise }, resume: () => owned(),
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    let done = false;
    const stable = controller.checkpoint(generation).then(() => { done = true; });
    await waitUntil({ description: "manual wait", predicate: () => controller.manualCompactionDisposition() === "already-active" });
    const cancellation = controller.cancel(generation, "user");
    await Promise.resolve();
    expect(done).toBe(false);
    manual.resolve({ ended: true, usage: usage(20) });
    await expect(cancellation).resolves.toEqual({ cancelled: true, rejected: [] });
    await stable;
  });

  it.each(["compacting", "backoff"] as const)("cancellation during %s joins active work", async (phase) => {
    const compactGate = deferred<void>();
    const controller = createController({
      sessionId: "s", threshold: 90,
      compact: phase === "compacting"
        ? (_attempt, signal) => promiseCompactionAttempt(() => compactGate.promise, signal)
        : async () => ({ ok: false, category: "operational" }),
      delay: (_milliseconds, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    const generation = controller.sample(usage(90), "settled")!;
    const stable = controller.checkpoint(generation);
    await waitUntil({ description: `controller ${phase}`, predicate: () => controller.snapshot().phase === phase });
    const cancellation = controller.cancel(generation, "user");
    await stable;
    await expect(cancellation).resolves.toEqual({ cancelled: true, rejected: [] });
    expect(controller.snapshot().phase).toBe("cancelled");
    compactGate.resolve();
  });

  it.each([true, false])(
    "cancellation joins concurrently and reconciles an in-flight replay delivered=%s",
    async (delivered) => {
      const replayRelease = deferred<void>();
      const joinGate = deferred<void>();
      let replayEntered = false;
      let joinCalls = 0;
      const controller = createController({
        sessionId: "s", threshold: 90, compact: async () => ({ ok: true }),
        resume: () => ({
          settled: new Promise<void>(() => undefined),
          replay: async () => {
            replayEntered = true;
            await replayRelease.promise;
            return { delivered };
          },
          cancelAndJoin: () => {
            joinCalls += 1;
            replayRelease.resolve();
            return joinGate.promise;
          },
        }),
      });
      const { generation, handle } = arm(controller);
      controller.completeToolBatch(handle);
      const queued = controller.shadowInput(generation, "queued", "steer")!;
      let stableDone = false;
      const stable = controller.checkpoint(generation).then(() => { stableDone = true; });
      await waitUntil({ description: "replay start", predicate: () => replayEntered });
      let cancellationDone = false;
      const cancellation = controller.cancel(generation, "task-stop").then((outcome) => {
        cancellationDone = true;
        return outcome;
      });
      expect(joinCalls).toBe(1);
      await Promise.resolve();
      expect(cancellationDone).toBe(false);
      expect(stableDone).toBe(false);
      joinGate.resolve();
      await expect(cancellation).resolves.toEqual({ cancelled: true, rejected: delivered ? [] : [queued] });
      await stable;
      expect(joinCalls).toBe(1);
    },
  );

  it("does not retry cancel-and-join and rejects stability when join fails", async () => {
    const replay = deferred<{ delivered: false }>();
    let replayEntered = false;
    let joinCalls = 0;
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => ({ ok: true }),
      resume: () => ({
        settled: new Promise<void>(() => undefined),
        replay: () => {
          replayEntered = true;
          return replay.promise;
        },
        cancelAndJoin: () => {
          joinCalls += 1;
          throw new Error("private join failure");
        },
      }),
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    controller.shadowInput(generation, "retained", "steer");
    const stable = controller.checkpoint(generation);
    await waitUntil({ description: "in-flight replay", predicate: () => replayEntered });
    const cancellation = controller.cancel(generation, "user");
    replay.resolve({ delivered: false });
    await expect(cancellation).rejects.toThrow("could not confirm quiescence");
    await expect(stable).rejects.toThrow("could not confirm quiescence");
    await expect(controller.cancel(generation, "user")).rejects.toThrow("could not confirm quiescence");
    expect(joinCalls).toBe(1);
    expect(controller.snapshot()).toMatchObject({ phase: "cancelled", admission: "closed", queuedInputs: 1 });
  });

  it("cancellation while resume Promise starts waits for abort and join", async () => {
    const join = deferred<void>();
    let observedAbort = false;
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => ({ ok: true }),
      resume: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve({ replay: async () => ({ delivered: true }), cancelAndJoin: () => join.promise });
      }, { once: true })),
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    let done = false;
    const stable = controller.checkpoint(generation).then(() => { done = true; });
    await waitUntil({ description: "resuming", predicate: () => controller.snapshot().phase === "resuming" });
    const cancellation = controller.cancel(generation, "user");
    await waitUntil({ description: "resume abort", predicate: () => observedAbort });
    expect(done).toBe(false);
    join.resolve();
    await expect(cancellation).resolves.toEqual({ cancelled: true, rejected: [] });
    await stable;
  });

  it("cancellation during Promise settlement calls cancel-and-join before stable settlement", async () => {
    const settlement = deferred<void>();
    const join = deferred<void>();
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => ({ ok: true }),
      resume: () => ({ settled: settlement.promise, replay: async () => ({ delivered: true }), cancelAndJoin: () => join.promise }),
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    let done = false;
    const stable = controller.checkpoint(generation).then(() => { done = true; });
    await waitUntil({ description: "Promise settlement wait", predicate: () => controller.snapshot().phase === "resuming" });
    const cancellation = controller.cancel(generation, "user");
    await Promise.resolve();
    expect(done).toBe(false);
    join.resolve();
    await expect(cancellation).resolves.toEqual({ cancelled: true, rejected: [] });
    await stable;
    settlement.resolve();
  });

  it.each(["active-check", "wait"] as const)("fails closed when manual %s throws", async (where) => {
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => ({ ok: true }),
      manualCompaction: {
        kind: "available",
        isActive: () => {
          if (where === "active-check") throw new Error("private");
          return true;
        },
        waitAndResample: async () => {
          throw new Error("private");
        },
      },
      resume: () => owned(),
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    await controller.checkpoint(generation);
    expect(controller.snapshot().phase).toBe("exhausted");
  });

  it("resolves only the old generation barrier before reentrant progress arms a new generation", async () => {
    let controller!: MidRunCompactionController;
    let nextGeneration: number | undefined;
    controller = createController({
      sessionId: "s",
      threshold: 90,
      compact: async () => ({ ok: false, category: "hook-blocked" }),
      progress: (event) => {
        if (event.category !== "checkpoint-exhausted") return;
        const token = controller.recoveryToken(event.generation)!;
        expect(controller.recoverAfterManualCompaction(token).recovered).toBe(true);
        nextGeneration = controller.sample(usage(90), "settled");
      },
    });
    const generation = controller.sample(usage(90), "settled")!;
    await controller.checkpoint(generation);
    expect(nextGeneration).toBe(2);
    expect(controller.snapshot()).toMatchObject({ generation: 2, phase: "awaiting-settlement" });
    await controller.stableBarrier(generation);
    expect(controller.snapshot().phase).toBe("awaiting-settlement");
  });

  it.each([
    ["missing", undefined],
    ["malformed", { kind: "available", isActive: () => false }],
  ])("keeps cancellation joined to generation N+1 after synchronous %s-capability exhaustion recovery", async (_name, initialCapability) => {
    const nextRun = deferred<CompactionAttemptResult>();
    let controller!: MidRunCompactionController;
    let nextGeneration: number | undefined;
    let nextRunEntered = false;
    const options = {
      sessionId: "s",
      threshold: 90,
      manualCompaction: initialCapability,
      compact: () => {
        nextRunEntered = true;
        return nextRun.promise;
      },
      progress: (event: { category: string; generation: number }) => {
        if (event.category !== "checkpoint-exhausted" || event.generation !== 1) return;
        const recovery = controller.recoveryToken(event.generation)!;
        expect(controller.recoverAfterManualCompaction(recovery).recovered).toBe(true);
        options.manualCompaction = { kind: "unavailable" };
        nextGeneration = controller.sample(usage(90), "settled");
        void controller.checkpoint(nextGeneration!);
      },
    } as unknown as MidRunCompactionOptions;
    controller = new MidRunCompactionController(options);

    const firstGeneration = controller.sample(usage(90), "settled")!;
    await controller.checkpoint(firstGeneration);
    expect(nextGeneration).toBe(2);
    expect(nextRunEntered).toBe(true);
    expect(controller.snapshot()).toMatchObject({ generation: 2, phase: "compacting" });

    let cancellationSettled = false;
    let stabilitySettled = false;
    const currentStable = controller.stableBarrier(nextGeneration!).then(() => {
      stabilitySettled = true;
    });
    const cancellation = controller.cancel(nextGeneration!, "user").then((outcome) => {
      cancellationSettled = true;
      return outcome;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);
    expect(stabilitySettled).toBe(false);

    nextRun.resolve({ ok: true });
    await expect(cancellation).resolves.toEqual({ cancelled: true, rejected: [] });
    await currentStable;
  });

  it("omitted or stale generation callbacks cannot act on the current checkpoint", async () => {
    let attempts = 0;
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => { attempts += 1; return { ok: true }; },
    });
    const generation = controller.sample(usage(90), "settled")!;
    await (controller.checkpoint as unknown as () => Promise<void>)();
    await (controller.stableBarrier as unknown as () => Promise<void>)();
    await expect((controller.cancel as unknown as (generation: undefined, kind: "user") => Promise<unknown>)(undefined, "user"))
      .resolves.toEqual({ cancelled: false, rejected: [] });
    expect((controller.recoveryToken as unknown as () => unknown)()).toBeUndefined();
    expect((controller.beginToolBatch as unknown as (generation: undefined, ids: string[]) => unknown)(undefined, ["a"]))
      .toBeUndefined();
    expect(attempts).toBe(0);
    expect(controller.snapshot().generation).toBe(generation);
    await controller.checkpoint(generation);
    expect(attempts).toBe(1);
  });

  it("throwing progress observers cannot alter transitions", async () => {
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => ({ ok: true }), progress: () => { throw new Error("observer"); },
    });
    await controller.checkpoint(controller.sample(usage(90), "settled")!);
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("token-binds callbacks and abort-races a hung Promise attempt", async () => {
    let late: ((token: any, result: CompactionAttemptResult) => void) | undefined;
    let ownedToken: any;
    const callback = await callbackCompactionAttempt(7, (token, complete) => {
      ownedToken = token;
      late = complete;
      complete({ ...token }, { ok: false, category: "operational" });
      complete(token, { ok: true });
    }, new AbortController().signal);
    late?.(ownedToken, { ok: false, category: "operational" });
    expect(callback).toEqual({ ok: true });
    const abort = new AbortController();
    const hung = promiseCompactionAttempt(() => new Promise(() => undefined), abort.signal);
    abort.abort();
    await expect(hung).resolves.toEqual({ ok: false, category: "cancelled" });
    await expect(promiseCompactionAttempt(async () => { throw new Error("private"); }, new AbortController().signal))
      .resolves.toEqual({ ok: false, category: "operational" });
  });
});

describe("MainSessionCheckpointGate", () => {
  const usage = { tokens: 900, contextWindow: 1000, percent: 90 };
  const setup = () => {
    const execution = new MainSessionCheckpointExecutionBridge();
    const gate = new MainSessionCheckpointGate(execution, "main", 90);
    return { controller: gate.currentController(), execution, gate };
  };
  const assistant = (...ids: string[]) => ({
    role: "assistant",
    content: ids.map((id) => ({ type: "toolCall", id, name: "probe", arguments: {} })),
  });

  it("preserves wrapper this/arguments/metadata and cleanly terminates every successful result", async () => {
    const { gate } = setup();
    gate.assistantMessageEnded(assistant("a", "b"));
    const signal = new AbortController().signal;
    const update = () => undefined;
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage, hasPendingMessages: () => false };
    const receiver = { marker: "receiver" };
    const calls: unknown[][] = [];
    const detailsA = { stable: "a" };
    const contentA = [{ type: "text", text: "a" }];
    const tool: any = {
      name: "probe", label: "Probe", description: "probe", parameters: { stable: true },
      executionMode: "sequential", prepareArguments: () => ({}), renderShell: "self",
      renderCall: () => ({ render: () => [] }), renderResult: () => ({ render: () => [] }),
      async execute(this: unknown, ...args: unknown[]) {
        expect(this).toBe(receiver);
        calls.push(args);
        return args[0] === "a"
          ? { content: contentA, details: detailsA }
          : { content: [{ type: "text", text: "b" }], details: { stable: "b" } };
      },
    };
    const wrapped = gate.wrapTool(tool);
    expect(wrapped.parameters).toBe(tool.parameters);
    expect(wrapped.renderCall).toBe(tool.renderCall);
    expect(wrapped.renderResult).toBe(tool.renderResult);
    expect(wrapped.executionMode).toBe("sequential");

    const a = await wrapped.execute.call(receiver, "a", { p: 1 }, signal, update, ctx);
    const b = await wrapped.execute.call(receiver, "b", { p: 2 }, signal, update, ctx);
    expect(calls).toEqual([["a", { p: 1 }, signal, update, ctx], ["b", { p: 2 }, signal, update, ctx]]);
    expect(a).toEqual({ content: contentA, details: detailsA, terminate: true });
    expect(a.content).toBe(contentA);
    expect(a.details).toBe(detailsA);
    gate.toolExecutionEnded({ toolCallId: "a", result: a, isError: false });
    gate.toolExecutionEnded({ toolCallId: "b", result: b, isError: false });
    expect(gate.turnEnded(ctx)?.stop).toBe("terminate");
  });

  it("finishes mixed/denied/throwing batches then aborts once and restores the TUI editor", async () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("ok", "denied", "thrown"));
    let editor = "draft written concurrently";
    let aborts = 0;
    const ctx = {
      model: { api: "openai-codex-responses" }, getContextUsage: () => usage,
      hasPendingMessages: () => true, mode: "tui",
      ui: { getEditorText: () => editor, setEditorText: (value: string) => { editor = value; } },
      abort: () => { aborts += 1; editor = `queued restored\n${editor}`; },
    };
    const wrapped: any = gate.wrapTool({
      name: "probe",
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
    const result = await wrapped.execute("ok", {}, undefined, undefined, ctx);
    gate.toolExecutionEnded({ toolCallId: "ok", result, isError: false });
    gate.toolExecutionEnded({ toolCallId: "denied", result: { content: [] }, isError: true });
    gate.toolExecutionEnded({ toolCallId: "thrown", result: { content: [] }, isError: true });
    expect(gate.turnEnded(ctx)?.stop).toBe("abort");
    expect(aborts).toBe(1);
    expect(editor).toBe("draft written concurrently");
    expect(controller.isCheckpointAbort(controller.snapshot().generation)).toBe(true);
    gate.defensiveLatch(ctx);
    expect(aborts).toBe(1);
  });

  it("shadows only accepted streaming input and reconciles canonical duplicate text by image identity", () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-completions" }, getContextUsage: () => usage };
    const imageA = { type: "image", data: "a", mimeType: "image/png" };
    const imageB = { type: "image", data: "b", mimeType: "image/png" };
    const first = gate.captureAcceptedInput(ctx, "same transformed", [imageA], "steer")!;
    const second = gate.captureAcceptedInput(ctx, "same transformed", [imageB], "followUp")!;
    expect(first.id).not.toBe(second.id);
    expect(first.content).toEqual([{ type: "text", text: "same transformed" }, imageA]);
    expect(second.delivery).toBe("followUp");
    expect(gate.captureAcceptedInput(ctx, "idle", undefined, undefined)).toBeUndefined();
    expect(gate.userMessageStarted({ role: "user", content: first.content })).toBe(first);
    expect(controller.queuedInputSnapshot()).toEqual([second]);
    expect(gate.userMessageStarted({ role: "user", content: second.content })).toBe(second);
    expect(controller.queuedInputSnapshot()).toEqual([]);
  });

  it("reconciles canonical-identical duplicate shadows FIFO and uses delivery metadata when available", () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-completions" }, getContextUsage: () => usage };
    const first = gate.captureAcceptedInput(ctx, "identical", undefined, "steer")!;
    const second = gate.captureAcceptedInput(ctx, "identical", undefined, "steer")!;
    const followUp = gate.captureAcceptedInput(ctx, "identical", undefined, "followUp")!;

    expect(gate.userMessageStarted({ role: "user", content: "identical" }, "followUp")).toBe(followUp);
    expect(gate.userMessageStarted({ role: "user", content: "identical" })).toBe(first);
    expect(gate.userMessageStarted({ role: "user", content: "identical" }, "steer")).toBe(second);
    expect(controller.queuedInputSnapshot()).toEqual([]);
  });

  it("reconciles canonical-identical accepted inputs FIFO before the threshold arms", () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const low = { model: { api: "openai-responses" }, getContextUsage: () => ({ ...usage, percent: 89 }) };
    gate.captureAcceptedInput(low, "identical", undefined, "steer");
    gate.captureAcceptedInput(low, "identical", undefined, "steer");
    gate.userMessageStarted({ role: "user", content: "identical" });

    const high = { ...low, getContextUsage: () => usage };
    gate.captureAcceptedInput(high, "later", undefined, "followUp");
    expect(controller.queuedInputSnapshot().map((entry) => [entry.content, entry.delivery])).toEqual([
      ["identical", "steer"],
      ["later", "followUp"],
    ]);
  });

  it("retains accepted below-threshold input if the completed batch later crosses", async () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const low = { model: { api: "openai-responses" }, getContextUsage: () => ({ ...usage, percent: 89 }) };
    expect(gate.captureAcceptedInput(low, "queued early", undefined, "steer")).toBeUndefined();
    const wrapped: any = gate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
    const result = await wrapped.execute("a", {}, undefined, undefined, {
      ...low, getContextUsage: () => usage,
    });
    expect(result.terminate).toBe(true);
    expect(controller.queuedInputSnapshot().map((entry) => entry.content)).toEqual(["queued early"]);
  });

  it("fails closed for a tool-free turn with pending input but leaves a settled turn to fallback", () => {
    const first = setup();
    first.gate.assistantMessageEnded(assistant());
    let aborts = 0;
    const pending = {
      model: { api: "openai-responses" }, getContextUsage: () => usage,
      hasPendingMessages: () => true, abort: () => { aborts += 1; },
    };
    expect(first.gate.turnEnded(pending)?.stop).toBe("abort");
    expect(aborts).toBe(1);

    const second = setup();
    second.gate.assistantMessageEnded(assistant());
    expect(second.gate.turnEnded({ ...pending, hasPendingMessages: () => false })).toBeUndefined();
    expect(second.controller.snapshot().phase).toBe("idle");
  });

  it("keeps parallel out-of-order executions generation-bound and decorates each result once", async () => {
    const { gate } = setup();
    gate.assistantMessageEnded(assistant("a", "b"));
    const a = deferred<Record<string, unknown>>();
    const b = deferred<Record<string, unknown>>();
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage, hasPendingMessages: () => false };
    const wrapped: any = gate.wrapTool({
      name: "probe",
      execute: (id: string) => id === "a" ? a.promise : b.promise,
    });
    const first = wrapped.execute("a", {}, undefined, undefined, ctx);
    const second = wrapped.execute("b", {}, undefined, undefined, ctx);
    b.resolve({ content: [{ type: "text", text: "b" }], details: { id: "b" } });
    a.resolve({ content: [{ type: "text", text: "a" }], details: { id: "a" } });
    const [ra, rb] = await Promise.all([first, second]);
    expect(ra.terminate).toBe(true);
    expect(rb.terminate).toBe(true);
    gate.toolExecutionEnded({ toolCallId: "b", result: rb, isError: false });
    gate.toolExecutionEnded({ toolCallId: "a", result: ra, isError: false });
    expect(gate.turnEnded(ctx)?.stop).toBe("terminate");
  });

  it.each(["validation", "permission", "unknown", "execution"])(
    "preserves an actual %s failure and fails the batch closed",
    async (kind) => {
      const { gate } = setup();
      gate.assistantMessageEnded(assistant("bad"));
      let aborts = 0;
      const ctx = {
        model: { api: "openai-responses" }, getContextUsage: () => usage,
        hasPendingMessages: () => false, abort: () => { aborts += 1; },
      };
      if (kind === "execution") {
        const failure = new Error("execute failed");
        const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => { throw failure; } });
        await expect(wrapped.execute("bad", {}, undefined, undefined, ctx)).rejects.toBe(failure);
      }
      gate.toolExecutionEnded({ toolCallId: "bad", result: { content: [], details: { kind } }, isError: true });
      expect(gate.turnEnded(ctx)?.stop).toBe("abort");
      expect(aborts).toBe(1);
    },
  );

  it("does not let unrelated input steal an opaque replay authorization", async () => {
    const { gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage };
    const image = { type: "image", data: "one", mimeType: "image/png" };
    const shadow = gate.captureAcceptedInput(ctx, "accepted", [image], "steer")!;
    await gate.withReplayAuthorization(shadow, async () => {
      expect(gate.authorizeReplay({
        text: "unrelated", images: [image], source: "extension", streamingBehavior: "steer",
      })).toBeUndefined();
      expect(gate.authorizeReplay({
        text: "accepted", images: [{ mimeType: "image/png", data: "one", type: "image" }],
        source: "extension", streamingBehavior: "steer",
      })).toBe(shadow);
      expect(gate.authorizeReplay({
        text: "accepted", images: [image], source: "extension", streamingBehavior: "steer",
      })).toBeUndefined();
    });
  });

  it("leaves unmatched shadows intact and invalidates an ambiguous clean path", async () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = {
      model: { api: "openai-responses" }, getContextUsage: () => usage,
      hasPendingMessages: () => false, abort: () => undefined,
    };
    const image = { type: "image", data: "right", mimeType: "image/png" };
    const shadow = gate.captureAcceptedInput(ctx, "same", [image], "followUp")!;
    expect(gate.userMessageStarted({
      role: "user", content: [{ type: "text", text: "same" }, { ...image, data: "wrong" }],
    }, "followUp")).toBeUndefined();
    expect(controller.queuedInputSnapshot()).toEqual([shadow]);
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("a", {}, undefined, undefined, ctx);
    gate.toolExecutionEnded({ toolCallId: "a", result, isError: false });
    expect(gate.turnEnded(ctx)?.stop).toBe("abort");
  });

  it("does not touch editor APIs on a headless-shaped abort", () => {
    const { gate } = setup();
    gate.assistantMessageEnded(assistant());
    let aborts = 0;
    let editorReads = 0;
    const ctx = {
      mode: "print", model: { api: "openai-responses" }, getContextUsage: () => usage,
      hasPendingMessages: () => true, abort: () => { aborts += 1; },
      ui: { getEditorText: () => { editorReads += 1; return "draft"; } },
    };
    expect(gate.turnEnded(ctx)?.stop).toBe("abort");
    expect(aborts).toBe(1);
    expect(editorReads).toBe(0);
  });

  it("retries defensive abort when abort is absent or throws", () => {
    const { gate } = setup();
    gate.assistantMessageEnded(assistant());
    const base = {
      model: { api: "openai-responses" }, getContextUsage: () => usage,
      hasPendingMessages: () => true,
    };
    expect(gate.turnEnded(base)?.stop).toBe("abort");
    gate.defensiveLatch({ ...base, abort: () => { throw new Error("not aborted"); } });
    let successful = 0;
    gate.defensiveLatch({ ...base, abort: () => { successful += 1; } });
    gate.defensiveLatch({ ...base, abort: () => { successful += 1; } });
    expect(successful).toBe(1);
  });

  it("cancels old generations and invalidates shadows before replacing the session controller", async () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage };
    const shadow = gate.captureAcceptedInput(ctx, "queued", undefined, "steer")!;
    await gate.beforeSessionSwitch();
    expect(controller.snapshot().phase).toBe("cancelled");
    expect(controller.queuedInputSnapshot()).toEqual([]);
    expect(() => gate.withReplayAuthorization(shadow, () => undefined)).toThrow(/stale/);
    await gate.startSession("fresh");
    expect(gate.currentController()).not.toBe(controller);
    expect(gate.currentController().sessionId).toBe("fresh");
    expect(gate.currentController().snapshot().phase).toBe("idle");
  });

  it("revokes replay immediately and cancels a switch when quiescence cannot be confirmed", async () => {
    const { controller, execution, gate } = setup();
    const resumedSettlement = deferred<void>();
    execution.attach({
      manualCompaction: { kind: "unavailable" },
      compact: async () => ({ ok: true }),
      resume: () => ({
        replay: async () => ({ delivered: true }),
        settled: resumedSettlement.promise,
        cancelAndJoin: async () => { throw new Error("join failed"); },
      }),
    });
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage, hasPendingMessages: () => false };
    const shadow = gate.captureAcceptedInput(ctx, "queued", undefined, "steer")!;
    const authorize = deferred<void>();
    const staleReplay = gate.withReplayAuthorization(shadow, async () => {
      await authorize.promise;
      return gate.authorizeReplay({
        text: "queued", source: "extension", streamingBehavior: "steer",
      });
    });
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("a", {}, undefined, undefined, ctx);
    gate.toolExecutionEnded({ toolCallId: "a", result, isError: false });
    gate.turnEnded(ctx);
    void controller.checkpoint(controller.snapshot().generation).catch(() => undefined);
    await waitUntil({
      description: "checkpoint resume ownership",
      predicate: () => controller.snapshot().phase === "resuming",
      describeObserved: () => controller.snapshot().phase,
    });

    const switching = gate.beforeSessionSwitch();
    authorize.resolve();
    expect(await staleReplay).toBeUndefined();
    await expect(switching).resolves.toEqual({ cancel: true });
    expect(controller.snapshot().phase).toBe("cancelled");
    expect(() => gate.withReplayAuthorization(shadow, () => undefined)).toThrow(/stale/);
    resumedSettlement.resolve();
  });

  it("uses the attached execution adapter and controller-owned summary latch", async () => {
    const { controller, execution, gate } = setup();
    let compactCalls = 0;
    execution.attach({
      manualCompaction: { kind: "unavailable" },
      compact: async (_attempt, _signal) => {
        compactCalls += 1;
        const generation = controller.snapshot().generation;
        const token = execution.beginCompactionSummary(controller, generation)!;
        let aborts = 0;
        gate.defensiveLatch({ abort: () => { aborts += 1; } });
        expect(aborts).toBe(0);
        expect(execution.endCompactionSummary(controller, token)).toBe(true);
        return { ok: false, category: "hook-blocked" };
      },
    });
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage, hasPendingMessages: () => false };
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("a", {}, undefined, undefined, ctx);
    gate.toolExecutionEnded({ toolCallId: "a", result, isError: false });
    gate.turnEnded(ctx);
    await controller.checkpoint(controller.snapshot().generation);
    expect(compactCalls).toBe(1);
    expect(controller.snapshot().phase).toBe("exhausted");
    expect(controller.isCompactionSummaryActive(controller.snapshot().generation)).toBe(false);
  });

  it("does not arm or abort unsupported custom provider APIs", () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    let aborts = 0;
    const ctx = { model: { api: "custom-api" }, getContextUsage: () => usage, abort: () => { aborts += 1; } };
    expect(gate.turnEnded(ctx)).toBeUndefined();
    gate.defensiveLatch(ctx);
    expect(controller.snapshot().phase).toBe("idle");
    expect(aborts).toBe(0);
  });
});

describe("proactive compaction (offline integration via fake-pi)", () => {
  let dir: string;
  let pi: FakePi;
  let mainCheckpointGate: MainSessionCheckpointGate;
  const originalCwd = process.cwd();
  const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

  // Drive the state machine back to a clean baseline (no pending request, no cooldown, no
  // in-flight marker) regardless of what a prior test left behind: enough below-threshold
  // turns to age out both the pending fallback and the post-compaction cooldown.
  const drainProactiveState = async () => {
    const low = pi.ctx({ getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }) });
    for (let i = 0; i < PROACTIVE_PENDING_MAX_TURNS + PROACTIVE_COOLDOWN_TURNS + 1; i++) {
      await pi.fire("agent_settled", {}, low);
    }
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-proactive-"));
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Test project\n");
    // A PreCompact hook keyed on the trigger (manual|auto): each matcher appends its own
    // trigger to a marker so a test can read back which trigger PiCC presented.
    fs.writeFileSync(
      path.join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ type: "command", command: 'printf x >> "$CLAUDE_PROJECT_DIR/input-hook-count"; payload=$(cat); if printf "%s" "$payload" | grep -q block-me; then echo "blocked by test" >&2; exit 2; fi' }],
            },
          ],
          PreCompact: [
            {
              matcher: "auto",
              hooks: [
                { type: "command", command: 'echo auto >> "$CLAUDE_PROJECT_DIR/.claude/.precompact-log"' },
              ],
            },
            {
              matcher: "manual",
              hooks: [
                { type: "command", command: 'echo manual >> "$CLAUDE_PROJECT_DIR/.claude/.precompact-log"' },
              ],
            },
          ],
        },
      }),
    );
    const skillDir = path.join(dir, ".claude", "skills", "expand");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\ndescription: Expand test input\n---\nExpanded: $ARGUMENTS\n");
    const userDir = path.join(dir, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    pi = fakePi();
    picc(pi.api as never, {
      onInitializationSettled: pi.captureInitialization,
      onWired: (internals) => {
        mainCheckpointGate = internals.mainCheckpointGate;
      },
    });
    await pi.waitForInitialization();
    await pi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
    else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registers only the API-global stateless Codex override and owns it idempotently per registry", () => {
    const registrations = pi.providerRegistrations.filter((entry) => entry.name === "picc-codex-abort-guard");
    expect(registrations).toHaveLength(1);
    const registration = registrations[0]!;
    expect(Object.keys(registration.config).sort()).toEqual(["api", "streamSimple"]);
    expect(registration.config.api).toBe("openai-codex-responses");
    expect(registration.config.streamSimple).toBeTypeOf("function");
  });

  it("gates clean and fallback cycles through the actual registered lifecycle handlers", async () => {
    const highUsage = () => ({ tokens: 900, contextWindow: 1000, percent: 90 });
    const assistant = (...ids: string[]) => ({
      role: "assistant",
      content: ids.map((id) => ({ type: "toolCall", id, name: "Skill", arguments: {} })),
    });
    const skill = pi.tools.get("Skill");
    expect(skill).toBeDefined();

    await mainCheckpointGate.startSession("registered-clean");
    const cleanCtx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: highUsage,
      hasPendingMessages: () => false,
    });
    await pi.fire("message_end", { message: assistant("clean") }, cleanCtx);
    const clean = await skill.execute(
      "clean", { name: "expand", arguments: "registered-cycle" },
      new AbortController().signal, () => undefined, cleanCtx,
    );
    await pi.fire("tool_execution_end", { toolCallId: "clean", result: clean, isError: false }, cleanCtx);
    await pi.fire("turn_end", {}, cleanCtx);
    expect(clean.terminate).toBe(true);
    expect(mainCheckpointGate.currentController().snapshot().checkpointAbortRequested).toBe(false);

    await mainCheckpointGate.startSession("registered-error-tui");
    let tuiAborts = 0;
    pi.editorText = "keep this draft";
    const tuiCtx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-codex-responses" },
      getContextUsage: highUsage,
      hasPendingMessages: () => false,
      abort: () => { tuiAborts += 1; pi.editorText = "host-restored queue"; },
    });
    await pi.fire("message_end", { message: assistant("bad") }, tuiCtx);
    await expect(skill.execute(
      "bad", { name: "missing-skill" }, new AbortController().signal, () => undefined, tuiCtx,
    )).rejects.toThrow(/Unknown skill/);
    await pi.fire("tool_execution_end", {
      toolCallId: "bad", result: { content: [], details: { failure: true } }, isError: true,
    }, tuiCtx);
    await pi.fire("turn_end", {}, tuiCtx);
    await pi.fire("turn_start", {}, tuiCtx);
    await pi.fire("before_provider_request", {}, tuiCtx);
    expect(tuiAborts).toBe(1);
    expect(pi.editorText).toBe("keep this draft");
    expect(mainCheckpointGate.currentController().snapshot().checkpointAbortRequested).toBe(true);

    await mainCheckpointGate.startSession("registered-fallback-headless");
    let headlessAborts = 0;
    let editorReads = 0;
    const headlessCtx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-completions" },
      getContextUsage: highUsage,
      hasPendingMessages: () => true,
      abort: () => { headlessAborts += 1; },
      ui: { getEditorText: () => { editorReads += 1; return "must not read"; } },
    });
    await pi.fire("message_end", { message: assistant() }, headlessCtx);
    await pi.fire("turn_end", {}, headlessCtx);
    await pi.fire("turn_start", {}, headlessCtx);
    await pi.fire("before_provider_request", {}, headlessCtx);
    expect(headlessAborts).toBe(1);
    expect(editorReads).toBe(0);
    await mainCheckpointGate.startSession("registered-cycles-complete");
  });

  it("compacts once and emits an always-visible notice when above threshold", async () => {
    await drainProactiveState();
    pi.compactCalls.length = 0;
    pi.notifications.length = 0;
    pi.entries.length = 0;
    const ctx = pi.ctx({ getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }) });

    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(1);

    const notice = pi.notifications.find((n) => n.text.includes("proactiveCompactPercent"));
    expect(notice, "expected an always-visible proactive-compaction notice").toBeDefined();
    expect(notice!.text).toContain("compacting");
    expect(notice!.severity).toBe("info");
    // Headless fallback: a persisted entry leaves a trace even when ui.notify no-ops.
    const entry = pi.entries.find((e) => e.customType === "picc-proactive-compact");
    expect(entry, "expected a persisted proactive-compaction entry").toBeDefined();
    expect(String(entry!.data.notice)).toContain("proactiveCompactPercent");

    // Anti-thrash: a second above-threshold turn does not compact again.
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(1);

    // A success event opens the cooldown window: the next PROACTIVE_COOLDOWN_TURNS
    // above-threshold turns do NOT re-compact (anti-thrash when usage stays high).
    await pi.fire("session_compact", {}, ctx);
    for (let i = 0; i < PROACTIVE_COOLDOWN_TURNS; i++) {
      await pi.fire("agent_settled", {}, ctx);
      expect(pi.compactCalls.length, `cooldown turn ${i} must not re-compact`).toBe(1);
    }
    // Once the cooldown elapses, the next above-threshold turn compacts again.
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(2);
  });

  it("presents a proactive compaction to PreCompact as trigger:auto, while a user /compact stays manual", async () => {
    await drainProactiveState();
    const marker = path.join(dir, ".claude", ".precompact-log");
    fs.rmSync(marker, { force: true });
    pi.compactCalls.length = 0;
    const ctx = pi.ctx({ getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }) });

    // A proactive compaction marks the in-flight request and calls ctx.compact().
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(1);
    // Pi reports its programmatic compaction to this event as reason:"manual"; PiCC must
    // present it to PreCompact hooks as trigger:"auto" (Claude fidelity).
    await pi.fire("session_before_compact", { reason: "manual" }, ctx);
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["auto"]);

    // A genuine user /compact (no in-flight marker) stays manual.
    await pi.fire("session_before_compact", { reason: "manual" }, ctx);
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["auto", "manual"]);
  });

  it("re-fires through the handler after the pending fallback expires with no session_compact", async () => {
    await drainProactiveState();
    pi.compactCalls.length = 0;
    const ctx = pi.ctx({ getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }) });

    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(1);

    // No session_compact success arrives (a silent compaction failure fires no event); after
    // the bounded fallback elapses the request is treated as failed and re-fires.
    for (let i = 0; i < PROACTIVE_PENDING_MAX_TURNS; i++) {
      await pi.fire("agent_settled", {}, ctx);
    }
    expect(pi.compactCalls.length).toBe(2);
  });

  it("does not compact and emits no notice on a below-threshold turn", async () => {
    await drainProactiveState();
    pi.compactCalls.length = 0;
    pi.notifications.length = 0;
    const ctx = pi.ctx({ getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }) });
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(0);
    expect(pi.notifications.find((n) => n.text.includes("proactiveCompactPercent"))).toBeUndefined();
  });

  it("does not throw or compact when getContextUsage returns the partial legacy shape", async () => {
    await drainProactiveState();
    pi.compactCalls.length = 0;
    const ctx = pi.ctx({ getContextUsage: () => ({ tokens: 1234 }) });
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(0);
  });

  it("does not throw or compact when getContextUsage itself throws", async () => {
    await drainProactiveState();
    pi.compactCalls.length = 0;
    const ctx = pi.ctx({
      getContextUsage: () => {
        throw new Error("boom");
      },
    });
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(0);
  });

  it("marks actual guard clipping non-spoofably and forces the fallback path", async () => {
    await mainCheckpointGate.startSession("clip-session");
    const high = pi.ctx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
    });
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant", content: [{ type: "toolCall", id: "clip", name: "probe", arguments: {} }],
    });
    const wrapped: any = mainCheckpointGate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { permission: "kept" } }),
    });
    const immediate = await wrapped.execute("clip", {}, undefined, undefined, high);
    const clipped = await pi.fire("tool_result", {
      toolName: "probe", toolCallId: "clip", input: {},
      content: [{ type: "text", text: "X".repeat(100_000) }],
      details: immediate.details, isError: false,
    }, high);
    expect(clipped.content[0].text).toContain("[PiCC clipped");
    expect(clipped.details).toBe(immediate.details);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: "clip", result: clipped, isError: false });
    expect(mainCheckpointGate.turnEnded(high)?.stop).toBe("abort");

    await mainCheckpointGate.startSession("clip-spoof-session");
    const spoof = { content: [{ type: "text", text: "[PiCC clipped fake]" }], details: { truncated: true } };
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant", content: [{ type: "toolCall", id: "spoof", name: "probe", arguments: {} }],
    });
    const spoofed = await wrapped.execute("spoof", {}, undefined, undefined, high);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: "spoof", result: spoof, isError: false });
    expect(spoofed.terminate).toBe(true);
    expect(mainCheckpointGate.turnEnded(high)?.stop).toBe("terminate");
  });

  it("session lifecycle events reject old shadows and install a fresh controller", async () => {
    await mainCheckpointGate.startSession("event-old");
    const old = mainCheckpointGate.currentController();
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant", content: [{ type: "toolCall", id: "a", name: "probe", arguments: {} }],
    });
    const high = pi.ctx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
    });
    mainCheckpointGate.captureAcceptedInput(high, "queued", undefined, "steer");
    await pi.fire("session_before_switch", {}, high);
    expect(old.snapshot().phase).toBe("cancelled");
    expect(old.queuedInputSnapshot()).toEqual([]);
    await pi.fire("session_start", { reason: "switch" }, high);
    expect(mainCheckpointGate.currentController()).not.toBe(old);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
  });

  it("propagates switch cancellation through the registered lifecycle handler", async () => {
    const original = mainCheckpointGate.beforeSessionSwitch;
    mainCheckpointGate.beforeSessionSwitch = async () => ({ cancel: true });
    try {
      await expect(pi.fire("session_before_switch", {}, pi.ctx())).resolves.toEqual({ cancel: true });
    } finally {
      mainCheckpointGate.beforeSessionSwitch = original;
    }
  });

  it("shadows accepted post-transform streaming input but never blocked or handled command input", async () => {
    await mainCheckpointGate.startSession("pipeline-session");
    const high = pi.ctx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
    });
    const blocked = await pi.fire("input", {
      text: "block-me", source: "interactive", streamingBehavior: "steer", images: [],
    }, high);
    expect(blocked).toEqual({ action: "handled" });
    const handled = await pi.fire("input", {
      text: "/usage", source: "interactive", streamingBehavior: "steer", images: [],
    }, high);
    expect(handled).toEqual({ action: "handled" });
    expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([]);

    const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const transformed = await pi.fire("input", {
      text: "/expand once", source: "interactive", streamingBehavior: "followUp", images: [image],
    }, high);
    expect(transformed.action).toBe("transform");
    expect(transformed.text).toContain("Expanded: once");
    expect(transformed.text.match(/Expanded:/g)).toHaveLength(1);
    expect(transformed.images).toEqual([image]);
    const [shadow] = mainCheckpointGate.currentController().queuedInputSnapshot();
    expect(shadow?.delivery).toBe("followUp");
    expect(shadow?.content).toEqual([{ type: "text", text: transformed.text }, image]);
    const replayed = await mainCheckpointGate.withReplayAuthorization(shadow!, () => pi.fire("input", {
      text: transformed.text, source: "extension", streamingBehavior: "followUp", images: [image],
    }, high));
    expect(replayed).toEqual({ action: "continue" });
    expect(fs.readFileSync(path.join(dir, "input-hook-count"), "utf8")).toBe("xx");
    expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([shadow]);
    await pi.fire("message_start", {
      message: { role: "user", content: shadow?.content }, streamingBehavior: "followUp",
    }, high);
    expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([]);
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc, { FdWriteReleasedError, writeFdFully } from "../src/index.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk } from "./helpers/fake-sdk.js";
import { deferred, settlement, waitUntil } from "./helpers/async.js";
import {
  MainSessionCheckpointGate,
  MidRunCompactionController,
  callbackCompactionAttempt,
  promiseCompactionAttempt,
  MAIN_CALLBACK_COMPACTION_DEADLINE_MS,
  RESUMED_RUN_JOIN_DEADLINE_MS,
  type CheckpointProgress,
  type HostDeadlineClock,
  type CompactionAttemptResult,
  type MidRunCompactionOptions,
  type QueuedInputShadow,
} from "../src/runtime/mid-run-compaction.js";

function manualDeadlineClock() {
  const timers: Array<{ delayMs: number; active: boolean; expire(): void }> = [];
  const clock: HostDeadlineClock = {
    schedule(delayMs, expired) {
      const timer = {
        delayMs,
        active: true,
        expire() {
          if (!timer.active) return;
          timer.active = false;
          expired();
        },
      };
      timers.push(timer);
      return { clear: () => { timer.active = false; } };
    },
  };
  return { clock, timers };
}

function expectUnconfirmedHostRecovery(text: string): void {
  expect(text).toContain("copy any restored draft before exiting");
  expect(text).toContain("recover input from client/request history");
  expect(text).toContain("exit PiCC completely");
  expect(text).toContain("fresh PiCC process");
  expect(text).toContain("fresh session");
  expect(text).toContain("do not reopen the affected session");
  expect(text).toContain("resend it");
  expect(text).not.toContain("/compact");
}

describe("public async fd writer", () => {
  it("loops partial writes, retries bounded transient pressure, and propagates permanent failure", async () => {
    const source = Buffer.from("partial-transient-complete", "utf8");
    const output: Buffer[] = [];
    const delays: number[] = [];
    const actions: Array<number | NodeJS.ErrnoException> = [4, Object.assign(new Error("busy"), { code: "EAGAIN" }), 3, Object.assign(new Error("buffered"), { code: "ENOBUFS" }), 99];
    const writer = ((_fd: number, buffer: Buffer, offset: number, length: number, _position: null,
      callback: (error: NodeJS.ErrnoException | null, bytesWritten: number) => void) => {
      const action = actions.shift()!;
      queueMicrotask(() => {
        if (action instanceof Error) callback(action, 0);
        else {
          const written = Math.min(action, length);
          output.push(Buffer.from(buffer.subarray(offset, offset + written)));
          callback(null, written);
        }
      });
    });
    await writeFdFully(1, source, writer, async (delay) => { delays.push(delay); });
    expect(Buffer.concat(output).toString("utf8")).toBe(source.toString("utf8"));
    expect(delays).toEqual([1, 1]);

    const permanent = Object.assign(new Error("closed"), { code: "EPIPE" });
    await expect(writeFdFully(1, Buffer.from("secret-sentinel"),
      ((_fd, _buffer, _offset, _length, _position, callback) => callback(permanent, 0))))
      .rejects.toBe(permanent);

    let attempts = 0;
    await expect(writeFdFully(1, Buffer.from("bounded"),
      ((_fd, _buffer, _offset, _length, _position, callback) => {
        attempts += 1;
        callback(Object.assign(new Error("again"), { code: "EWOULDBLOCK" }), 0);
      }), async () => undefined)).rejects.toMatchObject({ code: "EWOULDBLOCK" });
    expect(attempts).toBe(6);
  });

  it("releases every abortable state through one error identity and never double-settles", async () => {
    // The identity a caller observes is part of the contract: whatever announces the
    // ending of a compaction must be able to tell a released write from an OS write
    // error without matching on prose.
    const expectReleased = async (promise: Promise<void>, reason: unknown) => {
      const error = await promise.then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(FdWriteReleasedError);
      expect(error).toMatchObject({ code: "ABORT_ERR", cause: reason });
    };

    // Abort before the call: no physical write is issued at all.
    const before = new AbortController();
    before.abort("replacement");
    let beforeWrites = 0;
    const preAborted = writeFdFully(1, Buffer.from("never issued"),
      (() => { beforeWrites += 1; }), undefined, before.signal);
    await settlement(preAborted, { description: "a pre-aborted fd write to settle" });
    await expectReleased(preAborted, "replacement");
    expect(beforeWrites).toBe(0);

    // Abort while a callback is pending, then deliver that callback late: the caller
    // is released once, and the late arrival neither double-settles nor throws.
    const pending = new AbortController();
    let lateCallback!: (error: NodeJS.ErrnoException | null, written: number) => void;
    const parked = writeFdFully(1, Buffer.from("parked"), ((_fd, _buffer, _offset, _length, _position, callback) => {
      lateCallback = callback;
    }), undefined, pending.signal);
    await waitUntil({ description: "the parked write to enter", predicate: () => lateCallback !== undefined });
    pending.abort("user");
    await settlement(parked, { description: "an aborted pending fd write to settle" });
    await expectReleased(parked, "user");
    expect(() => lateCallback(null, 6)).not.toThrow();
    await expectReleased(parked, "user");

    // Abort mid-loop, after a partial write has already been DELIVERED: the physical
    // write settles normally on its own callback, so only the loop-top release can
    // end the caller, and the remaining 13 bytes are never issued. Delivering before
    // aborting is what makes this case distinct from the pending-callback one above —
    // abort it first and the listener wins the latch, the loop is never re-entered,
    // and the guard this case exists for is never reached with a non-zero offset.
    const midLoop = new AbortController();
    const issued: number[] = [];
    const partial = writeFdFully(1, Buffer.from("partial-then-aborted"),
      ((_fd, _buffer, _offset, length, _position, callback) => {
        issued.push(length);
        queueMicrotask(() => {
          callback(null, 7);
          midLoop.abort("shutdown");
        });
      }), undefined, midLoop.signal);
    await settlement(partial, { description: "a mid-loop aborted fd write to settle" });
    await expectReleased(partial, "shutdown");
    expect(issued).toEqual([20]);

    // Abort during the transient back-off: the retry loop is bounded by the same
    // loop-top release, through the same identity, and issues nothing further.
    const transient = new AbortController();
    const transientWrites: number[] = [];
    const backoffs: number[] = [];
    const retrying = writeFdFully(1, Buffer.from("transient-then-aborted"),
      ((_fd, _buffer, _offset, length, _position, callback) => {
        transientWrites.push(length);
        queueMicrotask(() => callback(Object.assign(new Error("busy"), { code: "EAGAIN" }), 0));
      }), async (delay) => {
        backoffs.push(delay);
        transient.abort("task-stop");
      }, transient.signal);
    await settlement(retrying, { description: "an fd write aborted during transient back-off to settle" });
    await expectReleased(retrying, "task-stop");
    expect(transientWrites).toEqual([22]);
    expect(backoffs).toEqual([1]);

    // Abort after completion: no effect, no double-settle, and the write still
    // reports success — a delivered emission stays delivered.
    const after = new AbortController();
    const completed: Buffer[] = [];
    const done = writeFdFully(1, Buffer.from("complete"),
      ((_fd, buffer, offset, length, _position, callback) => {
        queueMicrotask(() => {
          completed.push(Buffer.from(buffer.subarray(offset, offset + length)));
          callback(null, length);
        });
      }), undefined, after.signal);
    await settlement(done, { description: "a completed fd write to settle" });
    await expect(done).resolves.toBeUndefined();
    after.abort("replacement");
    await expect(done).resolves.toBeUndefined();
    expect(Buffer.concat(completed).toString("utf8")).toBe("complete");
  });
});

describe("MidRunCompactionController", () => {
  const usage = (percent: number | null) => ({ tokens: 900, contextWindow: 1000, percent });
  const createController = (options: MidRunCompactionOptions) => new MidRunCompactionController(options);
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

  it("delegates one operational compaction transaction and pauses on failure", async () => {
    let compactions = 0;
    const controller = createController({
      sessionId: "s", threshold: 90,
      compact: async () => { compactions += 1; return { ok: false, category: "operational" }; },
    });
    await controller.checkpoint(controller.sample(usage(90), "settled")!);
    expect(compactions).toBe(1);
    expect(controller.snapshot().phase).toBe("exhausted");
  });

  it.each(["hook-blocked", "stale-generation"] as const)("exhausts without retry for %s", async (category) => {
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
      resume: () => owned(),
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

  it("cancellation during the delegated compaction joins active work", async () => {
    const compactGate = deferred<void>();
    const controller = createController({
      sessionId: "s", threshold: 90,
      compact: (signal) => promiseCompactionAttempt(() => compactGate.promise, signal),
    });
    const generation = controller.sample(usage(90), "settled")!;
    const stable = controller.checkpoint(generation);
    await waitUntil({ description: "controller compaction", predicate: () => controller.snapshot().phase === "compacting" });
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
    const events: CheckpointProgress[] = [];
    const dropped: Array<readonly QueuedInputShadow[]> = [];
    const controller = createController({
      sessionId: "s", threshold: 90, compact: async () => ({ ok: true }),
      progress: (event) => events.push(event),
      inputDropped: (rejected) => dropped.push(rejected),
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

    // Both surfaces reject and every consumer swallows a rejection, so without these the
    // ending is terminal in silence: no notice, no entry, and retained input nobody names.
    expect(events.map((event) => [event.category, event.action])).toEqual([
      ["checkpoint-armed", undefined], ["checkpoint-complete", "resume"],
      ["checkpoint-cancelled", "restart-process"],
    ]);
    expect(dropped).toEqual([[expect.objectContaining({ content: "retained" })]]);
    // `restart-process`, not `new-session`: a replacement cancellation — which is what the
    // gate awaits inside `startSession` before installing a fresh controller — re-rejects
    // for this generation forever, so telling the reader to start a new session would name
    // the one action the controller refuses.
    await expect(controller.cancel(generation, "replacement")).rejects.toThrow("could not confirm quiescence");
    expect(controller.snapshot()).toMatchObject({
      cancellationKind: "user", cancellationQuiescence: "unconfirmed",
    });
    expect(controller.manualCompactionDisposition()).toBe("unavailable");
    expect(controller.recoveryToken(generation)).toBeUndefined();
  });

  it.each(["replay", "release", "settlement"] as const)(
    "terminalizes a post-commit %s failure only after the exact resumed owner joins",
    async (failure) => {
      const join = deferred<void>();
      const settlement = deferred<void>();
      const replayGate = deferred<void>();
      let replayEntered = false;
      let joinCalls = 0;
      const controller = createController({
        sessionId: "post-commit", threshold: 90, compact: async () => ({ ok: true }),
        resume: () => ({
          settled: failure === "settlement" ? settlement.promise : new Promise<void>(() => undefined),
          replay: async () => {
            if (failure === "settlement" && !replayEntered) {
              replayEntered = true;
              await replayGate.promise;
            }
            return { delivered: failure !== "replay" };
          },
          replayComplete: () => {
            if (failure === "release") throw new Error("provider release failed");
          },
          cancelAndJoin: () => {
            joinCalls += 1;
            return join.promise;
          },
        }),
      });
      const { generation, handle } = arm(controller);
      controller.completeToolBatch(handle);
      if (failure !== "release") controller.shadowInput(generation, "retained", "steer");
      let stableDone = false;
      const stable = controller.checkpoint(generation).then(() => { stableDone = true; });
      if (failure === "settlement") {
        await waitUntil({ description: "first replay to enter", predicate: () => replayEntered });
        controller.shadowInput(generation, "late retained", "followUp");
        settlement.resolve();
        await Promise.resolve();
        replayGate.resolve();
      }
      await waitUntil({
        description: `${failure} failure to revoke resumed authority`,
        predicate: () => controller.snapshot().phase === "terminalizing",
      });
      expect(controller.snapshot()).toMatchObject({ admission: "checkpoint-only", failureCategory: "restoration-paused" });
      expect(stableDone).toBe(false);
      expect(joinCalls).toBe(1);

      const cancellation = controller.cancel(generation, "replacement");
      await Promise.resolve();
      expect(joinCalls).toBe(1);
      expect(stableDone).toBe(false);
      join.resolve();
      await stable;
      await expect(cancellation).resolves.toMatchObject({ cancelled: true });
      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
      });
      expect(joinCalls).toBe(1);
    },
  );

  // The three cases below share one regression: a generation that reaches a terminal must
  // publish every surface it handed out exactly once, and must never re-open the recovery
  // capability a committed summary revoked. The controller is the cheapest layer that can
  // drive the interleavings — each needs a settlement and a post-commit failure landing in
  // the same turn, which the Pi-level owners cannot schedule.
  it("settles both surfaces when a post-commit failure lands in the turn the resumed run settles", async () => {
    const settled = deferred<void>();
    const join = deferred<void>();
    let joinCalls = 0;
    const events: string[] = [];
    const controller = createController({
      sessionId: "race", threshold: 90, compact: async () => ({ ok: true }),
      resume: () => ({
        settled: settled.promise,
        replay: async () => ({ delivered: true }),
        cancelAndJoin: () => {
          joinCalls += 1;
          return join.promise;
        },
      }),
      progress: (event) => events.push(`${event.category}:${event.failureCategory ?? "-"}`),
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    const stable = controller.checkpoint(generation);
    try {
      await waitUntil({ description: "the resumed run", predicate: () => controller.snapshot().phase === "resuming" });
      // Drain microtasks so the replay loop is parked on its settlement/queue race before
      // the race is run against it; the loop uses no timer, so this is its quiescent point.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Order is load-bearing: `settled` must resolve *before* the terminalization so the
      // parked race takes its settled arm and `finishGeneration` is actually entered. Arm
      // the terminalization first and the loop never reaches the guard under test, leaving
      // this case green while it covers nothing.
      settled.resolve();
      const terminal = controller.failAfterCommittedSummary(generation);
      join.resolve();

      await settlement(stable, { description: "the generation barrier of the raced generation" });
      await expect(stable).resolves.toBeUndefined();
      await settlement(terminal, { description: "the post-commit terminalization racing settlement" });
      await expect(terminal).resolves.toEqual([]);
      // The settlement must not be able to claim the generation completed: a committed
      // summary was never restored, so admission stays closed and no token permits a
      // second compaction of it.
      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restoration-paused", queuedInputs: 0,
      });
      expect(controller.recoveryToken(generation)).toBeUndefined();
      expect(controller.manualCompactionDisposition()).toBe("unavailable");
      expect(controller.ordinaryInputDisposition()).toBe("reject-restoration");
      expect(events).toEqual(["checkpoint-armed:-", "checkpoint-complete:-", "checkpoint-exhausted:restoration-paused"]);
      expect(joinCalls).toBe(1);
    } finally {
      settled.resolve();
      join.resolve();
    }
  });

  it.each([
    ["recoverable", "recoverable-rejection", "hook-blocked"],
    ["post-commit", "closed", "restoration-paused"],
  ] as const)("refuses to re-enter a %s exhausted generation", async (ending, admission, failureCategory) => {
    const replayGate = deferred<void>();
    let replayEntered = false;
    const events: string[] = [];
    const controller = createController({
      sessionId: "exhausted", threshold: 90,
      compact: async () => ending === "recoverable" ? { ok: false, category: "hook-blocked" } : { ok: true },
      resume: () => ({
        settled: new Promise<void>(() => undefined),
        replay: async () => {
          replayEntered = true;
          await replayGate.promise;
          // Undelivered replay is terminal after the summary committed.
          return { delivered: false };
        },
        cancelAndJoin: async () => undefined,
      }),
      progress: (event) => events.push(`${event.category}:${event.failureCategory ?? "-"}`),
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    const queued = controller.shadowInput(generation, "retained", "steer")!;
    const stable = controller.checkpoint(generation);
    try {
      if (ending === "post-commit") {
        await waitUntil({ description: "replay to enter", predicate: () => replayEntered });
        replayGate.resolve();
      }
      await settlement(stable, { description: `the ${ending} generation barrier` });
      await expect(stable).resolves.toBeUndefined();
      const token = controller.recoveryToken(generation);
      expect(token === undefined).toBe(ending === "post-commit");

      const cancellation = controller.cancel(generation, "user");
      await settlement(cancellation, { description: `cancelling the ${ending} exhausted generation` });
      // The terminal the generation already chose stands: re-entering would mint the
      // `user` recovery token a committed summary revoked, and announce a second ending.
      expect(controller.manualCompactionDisposition()).toBe(ending === "post-commit" ? "unavailable" : "allow");
      expect(controller.snapshot()).toMatchObject({ phase: "exhausted", admission, failureCategory });
      expect(controller.recoveryToken(generation)).toBe(token);
      expect(events.filter((event) => event.startsWith("checkpoint-exhausted"))).toEqual([`checkpoint-exhausted:${failureCategory}`]);
      // Filter rather than `not.toContain("checkpoint-cancelled:-")`: pinning the `-`
      // placeholder would pass vacuously if the category ever started carrying a value.
      expect(events.filter((event) => event.startsWith("checkpoint-cancelled"))).toEqual([]);
      // Nothing was cancelled, so the retained input keeps the disposition its own
      // ending chose rather than being drained by a caller that changed nothing.
      await expect(cancellation).resolves.toEqual({ cancelled: false, rejected: [] });
      expect(controller.queuedInputSnapshot()).toEqual(ending === "post-commit" ? [] : [queued]);
    } finally {
      replayGate.resolve();
    }
  });

  it("records a commit once and terminalizes idempotently for concurrent post-commit callers", async () => {
    const join = deferred<void>();
    const replayGate = deferred<void>();
    let replayEntered = false;
    let joinCalls = 0;
    const events: string[] = [];
    const controller = createController({
      sessionId: "committed", threshold: 90, compact: async () => ({ ok: true }),
      resume: () => ({
        settled: new Promise<void>(() => undefined),
        replay: async () => {
          replayEntered = true;
          await replayGate.promise;
          return { delivered: true };
        },
        cancelAndJoin: () => {
          joinCalls += 1;
          return join.promise;
        },
      }),
      progress: (event) => events.push(`${event.category}:${event.failureCategory ?? "-"}`),
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    const queued = controller.shadowInput(generation, "retained", "steer")!;
    const stable = controller.checkpoint(generation);
    try {
      await waitUntil({ description: "replay to enter", predicate: () => replayEntered });
      expect(controller.observeCompactionCommit(generation + 1)).toBe(false);
      expect(controller.observeCompactionCommit(generation)).toBe(true);

      const first = controller.failAfterCommittedSummary(generation);
      const second = controller.failAfterCommittedSummary(generation);
      // A commit cannot be recorded against a generation that is already unwinding it.
      expect(controller.observeCompactionCommit(generation)).toBe(false);
      expect(joinCalls).toBe(1);
      join.resolve();

      await settlement(stable, { description: "the committed generation barrier" });
      await expect(stable).resolves.toBeUndefined();
      await expect(first).resolves.toEqual([queued]);
      await expect(second).resolves.toEqual([queued]);
      const third = controller.failAfterCommittedSummary(generation);
      await settlement(third, { description: "a post-commit failure after the terminal" });
      await expect(third).resolves.toEqual([]);
      expect(joinCalls).toBe(1);
      expect(controller.recoveryToken(generation)).toBeUndefined();
      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restoration-paused", queuedInputs: 0,
      });
      expect(events.filter((event) => event.startsWith("checkpoint-exhausted")))
        .toEqual(["checkpoint-exhausted:restoration-paused"]);
    } finally {
      replayGate.resolve();
      join.resolve();
    }
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

  it("keeps cancellation joined to generation N+1 after synchronous exhaustion recovery", async () => {
    const nextRun = deferred<CompactionAttemptResult>();
    let controller!: MidRunCompactionController;
    let nextGeneration: number | undefined;
    let firstRun = true;
    controller = createController({
      sessionId: "s",
      threshold: 90,
      compact: () => {
        if (firstRun) {
          firstRun = false;
          return Promise.resolve({ ok: false, category: "hook-blocked" });
        }
        return nextRun.promise;
      },
      progress: (event) => {
        if (event.category !== "checkpoint-exhausted" || event.generation !== 1) return;
        const recovery = controller.recoveryToken(event.generation)!;
        expect(controller.recoverAfterManualCompaction(recovery).recovered).toBe(true);
        nextGeneration = controller.sample(usage(90), "settled");
        void controller.checkpoint(nextGeneration!);
      },
    });

    await controller.checkpoint(controller.sample(usage(90), "settled")!);
    expect(nextGeneration).toBe(2);
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
    // Drain to quiescence rather than counting microtask turns: the claim is that
    // nothing but the in-flight compaction can publish generation N+1, and a fixed
    // number of turns would also pass for a publication that is merely a few turns
    // late. Nothing here is timer-driven, so a macrotask boundary is that point.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancellationSettled).toBe(false);
    expect(stabilitySettled).toBe(false);

    nextRun.resolve({ ok: true });
    await settlement(cancellation, { description: "the cancellation of generation N+1" });
    await expect(cancellation).resolves.toEqual({ cancelled: true, rejected: [] });
    await settlement(currentStable, { description: "the generation N+1 barrier held across recovery" });
    expect(stabilitySettled).toBe(true);
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

  it("completes three independent generations without a hidden repeat latch", async () => {
    let compactions = 0;
    const controller = createController({
      sessionId: "repeated", threshold: 90,
      compact: async () => { compactions += 1; return { ok: true }; },
      resume: () => owned(),
    });
    for (let expectedGeneration = 1; expectedGeneration <= 3; expectedGeneration += 1) {
      const { generation, handle } = arm(controller, [`tool-${expectedGeneration}`]);
      expect(generation).toBe(expectedGeneration);
      expect(controller.completeToolBatch(handle).stop).toBe("terminate");
      await controller.checkpoint(generation);
      expect(controller.snapshot()).toMatchObject({ phase: "idle", admission: "open" });
      expect(controller.ordinaryInputDisposition()).toBe("accept");
    }
    expect(compactions).toBe(3);
  });

  it("enqueues every unsent replay behind pending custody and authenticates each once", async () => {
    const hostSettlement = deferred<void>();
    const allReplayed = deferred<void>();
    const providerReleased = deferred<void>();
    const sends: QueuedInputShadow[] = [];
    const controller = createController({
      sessionId: "pending-host-start-success", threshold: 90,
      compact: async () => ({ ok: true }),
      resume: () => ({
        settled: hostSettlement.promise,
        replay: async (input) => {
          sends.push(input);
          if (sends.length === 2) allReplayed.resolve();
          return { delivered: true, pendingHostStart: true };
        },
        replayComplete: () => providerReleased.resolve(),
        cancelAndJoin: async () => hostSettlement.promise,
      }),
    });
    const { generation, handle } = arm(controller);
    const first = controller.shadowInput(generation, "A", "followUp")!;
    const second = controller.shadowInput(generation, "B", "steer")!;
    controller.completeToolBatch(handle);
    const checkpoint = controller.checkpoint(generation);
    try {
      await allReplayed.promise;
      await providerReleased.promise;
      expect(sends).toEqual([first, second]);
      expect(controller.queuedInputSnapshot()).toEqual([first, second]);
      expect(controller.consumeShadow(generation, first.id)).toBe(first);
      expect(controller.consumeShadow(generation, second.id)).toBe(second);
      expect(controller.consumeShadow(generation, first.id)).toBeUndefined();
      hostSettlement.resolve();
      await checkpoint;
      expect(controller.snapshot()).toMatchObject({ phase: "idle", admission: "open" });
      expect(sends).toEqual([first, second]);
    } finally {
      hostSettlement.resolve();
      await checkpoint.catch(() => undefined);
    }
  });

  it("reports every pending-host-start occurrence once when settlement arrives first", async () => {
    const hostSettlement = deferred<void>();
    const allReplayed = deferred<void>();
    const reports: Array<readonly QueuedInputShadow[]> = [];
    const sends: QueuedInputShadow[] = [];
    const controller = createController({
      sessionId: "pending-host-start-settlement", threshold: 90,
      compact: async () => ({ ok: true }),
      resume: () => ({
        settled: hostSettlement.promise,
        replay: async (input) => {
          sends.push(input);
          if (sends.length === 2) allReplayed.resolve();
          return { delivered: true, pendingHostStart: true };
        },
        cancelAndJoin: async () => hostSettlement.promise,
      }),
      inputDropped: (rejected) => reports.push(rejected),
    });
    const { generation, handle } = arm(controller);
    controller.shadowInput(generation, "A", "followUp");
    controller.shadowInput(generation, "B", "steer");
    controller.completeToolBatch(handle);
    const checkpoint = controller.checkpoint(generation);
    try {
      await allReplayed.promise;
      hostSettlement.resolve();
      await checkpoint;
      expect(sends.map((entry) => entry.content)).toEqual(["A", "B"]);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.map((entry) => entry.content)).toEqual(["A", "B"]);
    } finally {
      hostSettlement.resolve();
      await checkpoint.catch(() => undefined);
    }
  });

  it("classifies callback and resumed-join deadlines as fail-closed without late authority", async () => {
    const callbackClock = manualDeadlineClock();
    let lateComplete!: (token: any, result: CompactionAttemptResult) => void;
    let callbackToken: any;
    const callback = callbackCompactionAttempt(7, (token, complete) => {
      callbackToken = token;
      lateComplete = complete;
    }, new AbortController().signal, { clock: callbackClock.clock });
    expect(callbackClock.timers).toMatchObject([{ delayMs: MAIN_CALLBACK_COMPACTION_DEADLINE_MS, active: true }]);
    callbackClock.timers[0]!.expire();
    await expect(callback).resolves.toEqual({ ok: false, category: "unconfirmed-host" });
    lateComplete(callbackToken, { ok: true });
    await expect(callback).resolves.toEqual({ ok: false, category: "unconfirmed-host" });
    expect(callbackClock.timers[0]?.active).toBe(false);

    const joinClock = manualDeadlineClock();
    const resumed = deferred<void>();
    const reports: Array<readonly QueuedInputShadow[]> = [];
    const controller = createController({
      sessionId: "deadline", threshold: 90,
      compact: async () => ({ ok: true }),
      resume: () => ({
        settled: resumed.promise,
        replay: async () => ({ delivered: true }),
        cancelAndJoin: async () => resumed.promise,
      }),
      inputDropped: (rejected) => reports.push(rejected),
      deadlinePolicy: { clock: joinClock.clock },
    });
    const { generation, handle } = arm(controller);
    controller.completeToolBatch(handle);
    const checkpoint = controller.checkpoint(generation);
    await waitUntil({ description: "deadline-owned resume", predicate: () => controller.snapshot().phase === "resuming" });
    const cancellation = controller.cancel(generation, "user");
    await waitUntil({ description: "resumed join deadline", predicate: () => joinClock.timers.length === 1 });
    expect(joinClock.timers[0]).toMatchObject({ delayMs: RESUMED_RUN_JOIN_DEADLINE_MS, active: true });
    joinClock.timers[0]!.expire();
    await expect(cancellation).rejects.toThrow(/quiescence/);
    await expect(checkpoint).rejects.toThrow(/quiescence/);
    expect(controller.snapshot()).toMatchObject({
      phase: "cancelled", admission: "closed", cancellationQuiescence: "unconfirmed",
    });
    expect(controller.recoveryToken(generation)).toBeUndefined();
    expect(reports).toHaveLength(0);
    resumed.resolve();
    expect(controller.snapshot().phase).toBe("cancelled");
  });

  it("keeps actual default terminal timers referenced and clears their exact handles on settlement", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const captured: Array<{ delay: number; handle: NodeJS.Timeout }> = [];
    const cleared: NodeJS.Timeout[] = [];
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      const handle = realSetTimeout(handler, delay, ...args);
      if (delay === MAIN_CALLBACK_COMPACTION_DEADLINE_MS || delay === RESUMED_RUN_JOIN_DEADLINE_MS) {
        captured.push({ delay, handle });
      }
      return handle;
    }) as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: NodeJS.Timeout) => {
      if (handle) cleared.push(handle);
      realClearTimeout(handle);
    }) as typeof clearTimeout);

    const resumed = deferred<void>();
    const resumeEntered = deferred<void>();
    const joinEntered = deferred<void>();
    let callbackToken: any;
    let finishCallback: ((token: any, result: CompactionAttemptResult) => void) | undefined;
    let checkpoint: Promise<void> | undefined;
    let cancellation: Promise<unknown> | undefined;
    try {
      const callback = callbackCompactionAttempt(11, (token, complete) => {
        callbackToken = token;
        finishCallback = complete;
      }, new AbortController().signal);
      const callbackTimer = captured.find((entry) => entry.delay === MAIN_CALLBACK_COMPACTION_DEADLINE_MS);
      expect(callbackTimer?.handle.hasRef()).toBe(true);
      finishCallback!(callbackToken, { ok: true });
      await expect(callback).resolves.toEqual({ ok: true });
      expect(cleared.filter((handle) => handle === callbackTimer?.handle)).toHaveLength(1);

      const controller = createController({
        sessionId: "default-timer-custody", threshold: 90,
        compact: async () => ({ ok: true }),
        deadlinePolicy: {},
        resume: () => {
          resumeEntered.resolve();
          return {
            settled: resumed.promise,
            replay: async () => ({ delivered: true }),
            cancelAndJoin: async () => {
              joinEntered.resolve();
              await resumed.promise;
            },
          };
        },
      });
      const { generation, handle } = arm(controller);
      controller.completeToolBatch(handle);
      checkpoint = controller.checkpoint(generation);
      await resumeEntered.promise;
      cancellation = controller.cancel(generation, "user");
      await joinEntered.promise;
      const joinTimer = captured.find((entry) => entry.delay === RESUMED_RUN_JOIN_DEADLINE_MS);
      expect(joinTimer?.handle.hasRef()).toBe(true);
      resumed.resolve();
      await expect(cancellation).resolves.toMatchObject({ cancelled: true });
      await expect(checkpoint).resolves.toBeUndefined();
      expect(cleared.filter((handle) => handle === joinTimer?.handle)).toHaveLength(1);
    } finally {
      resumed.resolve();
      if (cancellation) await cancellation.catch(() => undefined);
      if (checkpoint) await checkpoint.catch(() => undefined);
      for (const { handle } of captured) realClearTimeout(handle);
      clearSpy.mockRestore();
      setSpy.mockRestore();
    }
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
    const callbackAbort = new AbortController();
    const hostCallback = deferred<void>();
    let finishHost: ((token: any, result: CompactionAttemptResult) => void) | undefined;
    let hostToken: any;
    let callbackAbortSettled = false;
    const callbackJoining = callbackCompactionAttempt(8, (token, complete) => {
      hostToken = token;
      finishHost = complete;
      void hostCallback.promise.then(() => complete(token, { ok: false, category: "operational" }));
    }, callbackAbort.signal).then((result) => {
      callbackAbortSettled = true;
      return result;
    });
    callbackAbort.abort();
    await Promise.resolve();
    expect(callbackAbortSettled).toBe(false);
    finishHost?.({ ...hostToken }, { ok: true });
    expect(callbackAbortSettled).toBe(false);
    hostCallback.resolve();
    await expect(callbackJoining).resolves.toEqual({ ok: false, category: "cancelled" });

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
    const gate = new MainSessionCheckpointGate("main", 90);
    return { controller: gate.currentController(), gate };
  };
  const assistant = (...ids: string[]) => ({
    role: "assistant",
    content: ids.map((id) => ({ type: "toolCall", id, name: "probe", arguments: {} })),
  });
  const completedAssistant = (ids: string[], tokens = 900, stopReason = "toolUse") => ({
    ...assistant(...ids),
    stopReason,
    usage: {
      input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const armForReconciliation = (gate: MainSessionCheckpointGate, ctx: Record<string, unknown>) => {
    gate.turnEnded({ ...ctx, hasPendingMessages: () => false });
  };

  it("keeps duplicate assistant delivery on one generation and batch through tool termination and settlement compaction", async () => {
    const { controller, gate } = setup();
    const toolRelease = deferred<Record<string, unknown>>();
    const order: string[] = [];
    let compactions = 0;
    let aborts = 0;
    let runningTool: Promise<Record<string, unknown>> | undefined;
    gate.attachExecution({
      compact: async () => { compactions += 1; order.push("compact"); return { ok: true }; },
      resume: () => ({
        settled: Promise.resolve(),
        replay: async () => ({ delivered: true }),
        cancelAndJoin: async () => undefined,
      }),
    });
    const ctx = {
      model: { api: "openai-responses", contextWindow: 1000 },
      getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }),
      hasPendingMessages: () => false,
      abort: () => { aborts += 1; },
    };
    const message = completedAssistant(["held"]);
    try {
      gate.assistantMessageEnded(message, ctx);
      const generation = controller.snapshot().generation;
      expect(controller.snapshot().phase).toBe("stopping");

      const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => toolRelease.promise });
      let toolSettled = false;
      runningTool = wrapped.execute("held", {}, undefined, undefined, ctx)
        .then((result: Record<string, unknown>) => { toolSettled = true; order.push("tool"); return result; });
      await Promise.resolve();
      gate.assistantMessageEnded(message, ctx);
      expect(controller.snapshot()).toMatchObject({ generation, phase: "stopping" });
      expect(toolSettled).toBe(false);
      expect({ aborts, compactions }).toEqual({ aborts: 0, compactions: 0 });

      toolRelease.resolve({ content: [], details: {} });
      const result = await runningTool!;
      expect(result.terminate).toBe(true);
      gate.toolExecutionEnded({ toolCallId: "held", result, isError: false });
      expect(gate.turnEnded(ctx)?.stop).toBe("terminate");
      expect(gate.settlementGeneration(ctx)).toBe(generation);
      await controller.checkpoint(generation);
      expect(order).toEqual(["tool", "compact"]);
      expect(compactions).toBe(1);
      expect(controller.snapshot().phase).toBe("idle");
    } finally {
      toolRelease.resolve({ content: [], details: {} });
      if (runningTool) await runningTool;
    }
  });

  it("ignores a wrapped tool result that settles after session replacement", async () => {
    const { gate } = setup();
    const toolRelease = deferred<Record<string, unknown>>();
    let oldTool: Promise<Record<string, unknown>> | undefined;
    let successorCompactions = 0;
    let successorAborts = 0;
    const oldCtx = {
      model: { api: "openai-responses", contextWindow: 1000 },
      getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }),
    };
    try {
      gate.assistantMessageEnded(completedAssistant(["old-tool"]), oldCtx);
      const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => toolRelease.promise });
      oldTool = wrapped.execute("old-tool", {}, undefined, undefined, oldCtx);
      await Promise.resolve();

      const replacement = gate.startSession("successor");
      await settlement(replacement, { description: "session replacement without waiting for the old tool" });
      await expect(replacement).resolves.toBeUndefined();
      gate.attachExecution({ compact: async () => { successorCompactions += 1; return { ok: true }; } });
      toolRelease.resolve({ content: [{ type: "text", text: "old result" }], details: {} });
      await expect(oldTool).resolves.toEqual({
        content: [{ type: "text", text: "old result" }], details: {},
      });

      const successorCtx = {
        model: { api: "openai-responses", contextWindow: 1000 },
        getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
        abort: () => { successorAborts += 1; },
      };
      expect(gate.currentController().snapshot()).toMatchObject({ generation: 0, phase: "idle", admission: "open" });
      expect(gate.settlementGeneration(successorCtx)).toBeUndefined();
      expect({ successorAborts, successorCompactions }).toEqual({ successorAborts: 0, successorCompactions: 0 });
    } finally {
      toolRelease.resolve({ content: [], details: {} });
      if (oldTool) await oldTool;
    }
  });

  it("keeps high-usage text-only responses on the settled non-resuming fallback", async () => {
    const { controller, gate } = setup();
    let compactions = 0;
    let resumes = 0;
    gate.attachExecution({
      compact: async () => { compactions += 1; return { ok: true }; },
      resume: () => { resumes += 1; throw new Error("fallback must not resume"); },
    });
    const ctx = {
      model: { api: "openai-completions", contextWindow: 1000 },
      getContextUsage: () => usage,
    };
    gate.assistantMessageEnded(completedAssistant([], 950, "stop"), ctx);
    expect(controller.snapshot().phase).toBe("idle");
    const generation = gate.settlementGeneration(ctx)!;
    await controller.checkpoint(generation);
    expect({ compactions, resumes }).toEqual({ compactions: 1, resumes: 0 });
    expect(controller.snapshot().phase).toBe("idle");
  });

  it.each(["user", "shutdown"] as const)(
    "cancels an assistant-armed unresolved tool safely for %s cancellation",
    async (kind) => {
      const { controller, gate } = setup();
      const toolRelease = deferred<Record<string, unknown>>();
      let aborts = 0;
      let compactions = 0;
      const ctx = {
        model: { api: "openai-responses", contextWindow: 1000 },
        getContextUsage: () => ({ ...usage, percent: null }),
        abort: () => { aborts += 1; },
      };
      gate.attachExecution({ compact: async () => { compactions += 1; return { ok: true }; } });
      gate.assistantMessageEnded(completedAssistant(["held"]), ctx);
      const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => toolRelease.promise });
      const runningTool = wrapped.execute("held", {}, undefined, undefined, ctx);
      try {
        await expect(gate.cancel(kind)).resolves.toMatchObject({ cancelled: true });
        expect(controller.snapshot().phase).toBe("cancelled");
        expect({ aborts, compactions }).toEqual({ aborts: 0, compactions: 0 });
      } finally {
        toolRelease.resolve({ content: [], details: {} });
        await expect(runningTool).resolves.toMatchObject({ content: [] });
      }
    },
  );

  it("blocks a newly high idle provider admission once, then resumes through settlement-owned compaction", async () => {
    const { controller, gate } = setup();
    let aborts = 0;
    let compactions = 0;
    let resumes = 0;
    gate.attachExecution({
      compact: async () => { compactions += 1; return { ok: true }; },
      resume: () => {
        resumes += 1;
        return {
          settled: Promise.resolve(),
          replay: async () => ({ delivered: true }),
          cancelAndJoin: async () => undefined,
        };
      },
    });
    let percent = 10;
    const ctx = {
      model: { api: "openai-responses", contextWindow: 1000 },
      getContextUsage: () => ({ tokens: percent * 10, contextWindow: 1000, percent }),
      abort: () => { aborts += 1; },
    };
    gate.assistantMessageEnded(completedAssistant([], 100, "stop"), ctx);
    expect(gate.settlementGeneration(ctx)).toBeUndefined();
    percent = 90;
    await gate.beforeProviderRequest(ctx);
    expect(controller.snapshot()).toMatchObject({ phase: "awaiting-settlement", admission: "checkpoint-only" });
    expect(aborts).toBe(1);
    await gate.beforeProviderRequest(ctx);
    expect(aborts).toBe(1);
    const generation = gate.settlementGeneration(ctx)!;
    await controller.checkpoint(generation);
    expect({ compactions, resumes }).toEqual({ compactions: 1, resumes: 1 });
    expect(controller.snapshot().phase).toBe("idle");
  });

  it.each(["error", "aborted"] as const)("rejects high assistant usage from a %s completion", (stopReason) => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(completedAssistant(["tool"], 950, stopReason), {
      model: { api: "openai-responses", contextWindow: 1000 },
      getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }),
    });
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("admits a controller-owned summary request and cancels an admission checkpoint without starting compaction", async () => {
    const first = setup();
    const compactRelease = deferred<CompactionAttemptResult>();
    let firstAborts = 0;
    const ctx = {
      model: { api: "openai-responses", contextWindow: 1000 },
      getContextUsage: () => usage,
      abort: () => { firstAborts += 1; },
    };
    first.gate.attachExecution({
      compact: async () => compactRelease.promise,
      resume: () => ({ settled: Promise.resolve(), replay: async () => ({ delivered: true }), cancelAndJoin: async () => undefined }),
    });
    let checkpoint: Promise<void> | undefined;
    try {
      await first.gate.beforeProviderRequest(ctx);
      const generation = first.gate.settlementGeneration(ctx)!;
      checkpoint = first.controller.checkpoint(generation);
      await waitUntil({ description: "admission checkpoint compaction", predicate: () => first.controller.snapshot().phase === "compacting" });
      const summary = first.controller.beginCompactionSummary(generation)!;
      await first.gate.beforeProviderRequest(ctx);
      expect(firstAborts).toBe(1);
      first.controller.endCompactionSummary(summary);
      compactRelease.resolve({ ok: true });
      await checkpoint;
    } finally {
      compactRelease.resolve({ ok: true });
      if (checkpoint) await checkpoint;
    }

    const second = setup();
    let secondAborts = 0;
    let secondCompactions = 0;
    const cancelCtx = { ...ctx, abort: () => { secondAborts += 1; } };
    second.gate.attachExecution({ compact: async () => { secondCompactions += 1; return { ok: true }; } });
    await second.gate.beforeProviderRequest(cancelCtx);
    await expect(second.gate.cancel("user")).resolves.toMatchObject({ cancelled: true });
    expect({ secondAborts, secondCompactions }).toEqual({ secondAborts: 1, secondCompactions: 0 });
  });

  it.each([
    ["below threshold", "openai-responses", 899, { tokens: 899, contextWindow: 1000, percent: 89.9 }],
    ["unknown usage", "openai-responses", 0, { tokens: null, contextWindow: 1000, percent: null }],
    ["unsupported API", "custom-api", 950, { tokens: 950, contextWindow: 1000, percent: 95 }],
  ] as const)("does not arm at assistant or admission sampling for %s", async (_label, api, tokens, admissionUsage) => {
    const { controller, gate } = setup();
    let aborts = 0;
    const ctx = {
      model: { api, contextWindow: 1000 },
      getContextUsage: () => admissionUsage,
      abort: () => { aborts += 1; },
    };
    gate.assistantMessageEnded(completedAssistant(["tool"], tokens), ctx);
    await gate.beforeProviderRequest(ctx);
    expect(controller.snapshot().phase).toBe("idle");
    expect(aborts).toBe(0);
  });

  it("does not treat an assistant-side percentage imitation as fresh usage proof", () => {
    const { controller, gate } = setup();
    const message = { ...assistant("tool"), stopReason: "toolUse", usage: { percent: 99 } };
    gate.assistantMessageEnded(message, {
      model: { api: "openai-responses", contextWindow: 1000 },
      getContextUsage: () => ({ tokens: null, contextWindow: 1000, percent: null }),
    });
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("keeps a low ordinary tool turn from poisoning a later explicit high-usage batch", async () => {
    const { controller, gate } = setup();
    const lifecycle: string[] = [];
    let aborts = 0;
    gate.attachExecution({
      compact: async () => ({ ok: true }),
      progress: (event) => lifecycle.push(event.category),
    });
    const staleLowCtx = {
      model: { api: "openai-responses", contextWindow: 1000 },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
      hasPendingMessages: () => false,
      abort: () => { aborts += 1; },
    };
    const wrapped: any = gate.wrapTool({
      name: "probe",
      execute: async (id: string) => ({ content: [{ type: "text", text: id }], details: { id } }),
    });

    gate.assistantMessageEnded(completedAssistant(["low"], 100), staleLowCtx);
    const first = await wrapped.execute("low", {}, undefined, undefined, staleLowCtx);
    expect(first).toEqual({ content: [{ type: "text", text: "low" }], details: { id: "low" } });
    gate.toolExecutionEnded({ toolCallId: "low", result: first, isError: false });
    expect(gate.turnEnded(staleLowCtx, "json")).toBeUndefined();
    expect(controller.snapshot()).toMatchObject({ generation: 0, phase: "idle" });

    gate.assistantMessageEnded(completedAssistant(["high"], 900), staleLowCtx);
    const second = await wrapped.execute("high", {}, undefined, undefined, staleLowCtx);
    expect(second).toEqual({
      content: [{ type: "text", text: "high" }], details: { id: "high" }, terminate: true,
    });
    gate.toolExecutionEnded({ toolCallId: "high", result: second, isError: false });
    expect(gate.turnEnded(staleLowCtx, "json")?.stop).toBe("terminate");
    expect(lifecycle.filter((category) => category === "checkpoint-armed")).toHaveLength(1);
    expect(aborts).toBe(0);
  });

  it("keeps armed missing and mismatched tool handles fail closed", async () => {
    const highCtx = {
      model: { api: "openai-responses", contextWindow: 1000 },
      getContextUsage: () => usage,
      hasPendingMessages: () => false,
      abort: vi.fn(),
    };

    const missing = new MainSessionCheckpointGate("missing-armed-handle", 90, {}, "total-host");
    missing.assistantMessageEnded(completedAssistant([], 100, "stop"), highCtx);
    const missingWrapped: any = missing.wrapTool({
      name: "probe", execute: async () => ({ content: [], details: {} }),
    });
    expect(await missingWrapped.execute("unannounced", {}, undefined, undefined, highCtx))
      .not.toHaveProperty("terminate", true);
    expect(missing.settlementGeneration(highCtx)).toBe(missing.currentController().snapshot().generation);
    expect(missing.currentController().snapshot()).toMatchObject({
      phase: "exhausted", failureCategory: "operational",
    });

    const mismatched = setup();
    mismatched.gate.assistantMessageEnded(completedAssistant(["expected"]), highCtx);
    const mismatchWrapped: any = mismatched.gate.wrapTool({
      name: "probe", execute: async () => ({ content: [], details: {} }),
    });
    const mismatchResult = await mismatchWrapped.execute("other", {}, undefined, undefined, highCtx);
    expect(mismatchResult).not.toHaveProperty("terminate", true);
    mismatched.gate.toolExecutionEnded({ toolCallId: "other", result: mismatchResult, isError: false });
    expect(mismatched.gate.turnEnded(highCtx)?.stop).toBe("abort");
  });

  it.each(["armed", "stopping"] as const)(
    "makes a %s phase total only under the explicit production host-settlement contract",
    async (phase) => {
      const intermediate = new MainSessionCheckpointGate("child", 90, {}, "intermediate");
      const production = new MainSessionCheckpointGate("main", 90, {}, "total-host");
      const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage };
      for (const gate of [intermediate, production]) {
        if (phase === "stopping") gate.assistantMessageEnded(assistant("tool"));
        const wrapped: any = gate.wrapTool({
          name: "probe", execute: async () => ({ content: [], details: {} }),
        });
        await wrapped.execute("tool", {}, undefined, undefined, ctx);
        expect(gate.currentController().snapshot().phase).toBe(phase);
      }
      expect(intermediate.settlementGeneration(ctx)).toBeUndefined();
      expect(intermediate.currentController().snapshot().phase).toBe(phase);
      expect(production.settlementGeneration(ctx))
        .toBe(production.currentController().snapshot().generation);
      expect(production.currentController().snapshot()).toMatchObject({
        phase: "exhausted", failureCategory: "operational", admission: "recoverable-rejection",
      });
    },
  );

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

  it("keeps before_provider_request latched until replayComplete opens the generation barrier", async () => {
    const { controller, gate } = setup();
    const replayRelease = deferred<void>();
    const settlement = deferred<void>();
    gate.attachExecution({
      compact: async () => ({ ok: true }),
      resume: (context) => {
        let open!: () => void;
        const barrier = new Promise<void>((resolve) => { open = resolve; });
        expect(gate.installResumeBarrier(context.generation, barrier)).toBe(true);
        return {
          settled: settlement.promise,
          replay: async () => ({ delivered: true as const }),
          replayComplete: async () => { await replayRelease.promise; open(); },
          cancelAndJoin: async () => settlement.promise,
        };
      },
    });
    gate.assistantMessageEnded(assistant("latched"));
    const ctx = {
      model: { api: "openai-responses" }, getContextUsage: () => usage,
      hasPendingMessages: () => false, abort: vi.fn(),
    };
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("latched", {}, undefined, undefined, ctx);
    gate.toolExecutionEnded({ toolCallId: "latched", result, isError: false });
    gate.turnEnded(ctx);
    const checkpoint = controller.checkpoint(controller.snapshot().generation);
    await waitUntil({ description: "resuming provider barrier", predicate: () => controller.snapshot().phase === "resuming" });

    let providerPassed = false;
    const provider = gate.defensiveLatch(ctx).then(() => { providerPassed = true; });
    await Promise.resolve();
    expect(providerPassed).toBe(false);
    replayRelease.resolve();
    await provider;
    expect(ctx.abort).not.toHaveBeenCalled();
    settlement.resolve();
    await checkpoint;
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

  it("shadows accepted streaming occurrences and reconciles exact image content", () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-completions" }, getContextUsage: () => usage };
    const imageA = { type: "image", data: "a", mimeType: "image/png" };
    const imageB = { type: "image", data: "b", mimeType: "image/png" };
    armForReconciliation(gate, ctx);
    const first = gate.captureAcceptedInput(ctx, "same transformed", [imageA], "steer")!;
    const second = gate.captureAcceptedInput(ctx, "same transformed", [imageB], "followUp")!;
    expect(first.id).not.toBe(second.id);
    expect(first.content).toEqual([{ type: "text", text: "same transformed" }, imageA]);
    expect(second.delivery).toBe("followUp");
    const modeLess = gate.captureAcceptedInput(ctx, "mode-less", undefined, undefined)!;
    expect(modeLess.delivery).toBe("followUp");
    expect(gate.userMessageStarted({ role: "user", content: first.content })).toBe(first);
    expect(controller.queuedInputSnapshot()).toEqual([second, modeLess]);
    expect(gate.userMessageStarted({ role: "user", content: second.content })).toBe(second);
    expect(gate.userMessageStarted({ role: "user", content: [{ type: "text", text: "mode-less" }] })).toBe(modeLess);
    expect(controller.queuedInputSnapshot()).toEqual([]);
  });

  it("reconciles identical duplicate shadows FIFO and uses delivery metadata when available", () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-completions" }, getContextUsage: () => usage };
    armForReconciliation(gate, ctx);
    const first = gate.captureAcceptedInput(ctx, "identical", undefined, "steer")!;
    const second = gate.captureAcceptedInput(ctx, "identical", undefined, "steer")!;
    const followUp = gate.captureAcceptedInput(ctx, "identical", undefined, "followUp")!;

    const piMessage = { role: "user", content: [{ type: "text", text: "identical" }] };
    expect(gate.userMessageStarted(piMessage, "followUp")).toBe(followUp);
    expect(gate.userMessageStarted(piMessage)).toBe(first);
    expect(gate.userMessageStarted(piMessage, "steer")).toBe(second);
    expect(controller.queuedInputSnapshot()).toEqual([]);
  });

  it("reconciles one below-threshold string occurrence from Pi's text-block message before arming", () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const low = { model: { api: "openai-responses" }, getContextUsage: () => ({ ...usage, percent: 89 }) };
    gate.captureAcceptedInput(low, "identical", undefined, "steer");
    gate.captureAcceptedInput(low, "identical", undefined, "steer");
    gate.userMessageStarted({ role: "user", content: [{ type: "text", text: "identical" }] });

    const high = { ...low, getContextUsage: () => usage };
    gate.captureAcceptedInput(high, "later", undefined, "followUp");
    armForReconciliation(gate, high);
    expect(controller.queuedInputSnapshot().map((entry) => [entry.content, entry.delivery])).toEqual([
      ["identical", "steer"],
      ["later", "followUp"],
    ]);
  });

  it("selects the steering head before an earlier accepted identical follow-up when mode is absent", () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage };
    armForReconciliation(gate, ctx);
    const followUp = gate.captureAcceptedInput(ctx, "same", undefined, "followUp")!;
    const steer = gate.captureAcceptedInput(ctx, "same", undefined, "steer")!;
    const piMessage = { role: "user", content: [{ type: "text", text: "same" }] };

    expect(gate.userMessageStarted(piMessage)).toBe(steer);
    expect(controller.queuedInputSnapshot()).toEqual([followUp]);
    expect(gate.userMessageStarted(piMessage)).toBe(followUp);
    expect(controller.queuedInputSnapshot()).toEqual([]);
  });

  it("does not probe follow-up when a mode-less observation mismatches the steering head", async () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = {
      model: { api: "openai-responses" }, getContextUsage: () => usage,
      hasPendingMessages: () => false, abort: vi.fn(),
    };
    armForReconciliation(gate, ctx);
    const steer = gate.captureAcceptedInput(ctx, "A", undefined, "steer")!;
    const followUp = gate.captureAcceptedInput(ctx, "B", undefined, "followUp")!;

    expect(gate.userMessageStarted({ role: "user", content: [{ type: "text", text: "B" }] })).toBeUndefined();
    expect(controller.queuedInputSnapshot()).toEqual([steer, followUp]);
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("a", {}, undefined, undefined, ctx);
    gate.toolExecutionEnded({ toolCallId: "a", result, isError: false });
    expect(controller.snapshot()).toMatchObject({ phase: "awaiting-settlement", checkpointAbortRequested: true });
  });

  it.each([
    ["out-of-head", [{ type: "text", text: "later" }]],
    ["malformed", [{ type: "text", text: 1 }]],
    ["extra-field text", [{ type: "text", text: "head", unsupported: true }]],
    ["unknown", [{ type: "audio", data: "bytes" }]],
    ["mismatched", [{ type: "text", text: "other" }]],
  ])("leaves ownership intact and invalidates the clean path for an %s observation", async (_kind, content) => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = {
      model: { api: "openai-responses" }, getContextUsage: () => usage,
      hasPendingMessages: () => false, abort: vi.fn(),
    };
    armForReconciliation(gate, ctx);
    const head = gate.captureAcceptedInput(ctx, "head", undefined, "steer")!;
    const later = gate.captureAcceptedInput(ctx, "later", undefined, "steer")!;

    expect(gate.userMessageStarted({ role: "user", content })).toBeUndefined();
    expect(controller.queuedInputSnapshot()).toEqual([head, later]);
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("a", {}, undefined, undefined, ctx);
    gate.toolExecutionEnded({ toolCallId: "a", result, isError: false });
    expect(controller.snapshot()).toMatchObject({ phase: "awaiting-settlement", checkpointAbortRequested: true });
  });

  it.each([
    ["leading whitespace", " exact", "exact"],
    ["trailing whitespace", "exact ", "exact"],
    ["internal whitespace", "ex act", "exact"],
    ["case", "Exact", "exact"],
    ["Unicode normalization", "é", "e\u0301"],
  ])("preserves exact text across %s differences", (_kind, expected, observed) => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage };
    armForReconciliation(gate, ctx);
    const shadow = gate.captureAcceptedInput(ctx, expected, undefined, "steer")!;

    expect(gate.userMessageStarted({ role: "user", content: [{ type: "text", text: observed }] })).toBeUndefined();
    expect(controller.queuedInputSnapshot()).toEqual([shadow]);
  });

  it("matches cloned image blocks structurally and completely", () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage };
    const images = [
      { type: "image", data: "one", mimeType: "image/png" },
      { type: "image", data: "two", mimeType: "image/jpeg" },
    ];
    armForReconciliation(gate, ctx);
    const shadow = gate.captureAcceptedInput(ctx, "images", images, "steer")!;
    const clone = structuredClone(shadow.content);

    expect(gate.userMessageStarted({ role: "user", content: clone })).toBe(shadow);
    expect(controller.queuedInputSnapshot()).toEqual([]);
  });

  it.each([
    ["bytes", (blocks: any[]) => { blocks[1].data = "changed"; }],
    ["MIME type", (blocks: any[]) => { blocks[1].mimeType = "image/gif"; }],
    ["count", (blocks: any[]) => { blocks.pop(); }],
    ["order", (blocks: any[]) => { [blocks[1], blocks[2]] = [blocks[2], blocks[1]]; }],
    ["extra field", (blocks: any[]) => { blocks[1].unsupported = true; }],
  ])("does not reconcile image content with changed %s", (_kind, mutate) => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage };
    const images = [
      { type: "image", data: "one", mimeType: "image/png" },
      { type: "image", data: "two", mimeType: "image/jpeg" },
    ];
    armForReconciliation(gate, ctx);
    const shadow = gate.captureAcceptedInput(ctx, "images", images, "steer")!;
    const observed = structuredClone(shadow.content) as any[];
    mutate(observed);

    expect(gate.userMessageStarted({ role: "user", content: observed })).toBeUndefined();
    expect(controller.queuedInputSnapshot()).toEqual([shadow]);
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

  it("refuses to mint or consume replay authorization outside the resuming phase", () => {
    const { gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage };
    const image = { type: "image", data: "one", mimeType: "image/png" };
    armForReconciliation(gate, ctx);
    const shadow = gate.captureAcceptedInput(ctx, "accepted", [image], "steer")!;
    expect(() => gate.withReplayAuthorization(shadow, () => undefined)).toThrow(/stale/);
    expect(gate.authorizeReplay({
      text: "accepted", images: [image], source: "extension", streamingBehavior: "steer",
    })).toBeUndefined();
  });

  it("keeps replay authorization source, mode, content, image structure, and one-shot bound", async () => {
    const { controller, gate } = setup();
    const settlement = deferred<void>();
    const images = [
      { type: "image", data: "one", mimeType: "image/png" },
      { type: "image", data: "two", mimeType: "image/jpeg" },
    ];
    gate.attachExecution({
      compact: async () => ({ ok: true }),
      resume: () => ({
        settled: settlement.promise,
        replay: async (input) => gate.withReplayAuthorization(input, () => {
          const base = { text: "accepted", images: structuredClone(images), source: "extension", streamingBehavior: "steer" };
          expect(() => gate.withReplayAuthorization(structuredClone(input), () => undefined)).toThrow(/stale/);
          const mutable = input as { sessionId: string; generation: number };
          mutable.sessionId = "forged-session";
          expect(() => gate.withReplayAuthorization(input, () => undefined)).toThrow(/stale/);
          mutable.sessionId = controller.sessionId;
          mutable.generation += 1;
          expect(() => gate.withReplayAuthorization(input, () => undefined)).toThrow(/stale/);
          mutable.generation -= 1;
          expect(gate.authorizeReplay({ ...base, source: "interactive" })).toBeUndefined();
          expect(gate.authorizeReplay({ ...base, streamingBehavior: "followUp" })).toBeUndefined();
          expect(gate.authorizeReplay({ ...base, text: "changed" })).toBeUndefined();
          expect(gate.authorizeReplay({ ...base, images: [{ ...images[0], data: "changed" }, images[1]] })).toBeUndefined();
          expect(gate.authorizeReplay({ ...base, images: [{ ...images[0], mimeType: "image/gif" }, images[1]] })).toBeUndefined();
          expect(gate.authorizeReplay({ ...base, images: [images[0]] })).toBeUndefined();
          expect(gate.authorizeReplay({ ...base, images: [images[1], images[0]] })).toBeUndefined();
          expect(gate.authorizeReplay({
            ...base, images: [{ ...images[0], unsupported: true }, images[1]],
          })).toBeUndefined();
          expect(gate.authorizeReplay({
            ...base, images: [{ type: "image", data: 1, mimeType: "image/png" }, images[1]],
          })).toBeUndefined();
          expect(gate.authorizeReplay({
            ...base, images: [{ type: "audio", data: "unknown", mimeType: "audio/wav" }, images[1]],
          })).toBeUndefined();
          expect(gate.authorizeReplay(base)).toBe(input);
          expect(gate.authorizeReplay(base)).toBeUndefined();
          return { delivered: true as const };
        }),
        replayComplete: () => { settlement.resolve(); },
        cancelAndJoin: async () => settlement.promise,
      }),
    });
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage, hasPendingMessages: () => false };
    gate.captureAcceptedInput(ctx, "accepted", images, "steer");
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("a", {}, undefined, undefined, ctx);
    gate.toolExecutionEnded({ toolCallId: "a", result, isError: false });
    gate.turnEnded(ctx);

    await controller.checkpoint(controller.snapshot().generation);
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("retires a pending follow-up replay before a newer identical steer shadow", async () => {
    const { controller, gate } = setup();
    const settlement = deferred<void>();
    const firstAuthorized = deferred<QueuedInputShadow>();
    const releaseFirst = deferred<void>();
    let replayCalls = 0;
    let newer: QueuedInputShadow | undefined;
    gate.attachExecution({
      compact: async () => ({ ok: true }),
      resume: () => ({
        settled: settlement.promise,
        replay: async (input) => {
          replayCalls += 1;
          const accepted = gate.withReplayAuthorization(input, () => gate.authorizeReplay({
            text: "same", source: "extension", streamingBehavior: input.delivery,
          }));
          expect(accepted).toBe(input);
          if (replayCalls === 1) {
            firstAuthorized.resolve(input);
            await releaseFirst.promise;
          } else {
            expect(input).toBe(newer);
            expect(gate.userMessageStarted({
              role: "user", content: [{ type: "text", text: "same" }],
            })).toBe(newer);
          }
          return { delivered: true as const };
        },
        replayComplete: () => { settlement.resolve(); },
        cancelAndJoin: async () => settlement.promise,
      }),
    });
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage, hasPendingMessages: () => false };
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("a", {}, undefined, undefined, ctx);
    const first = gate.captureAcceptedInput(ctx, "same", undefined, "followUp")!;
    gate.toolExecutionEnded({ toolCallId: "a", result, isError: false });
    gate.turnEnded(ctx);
    const checkpoint = controller.checkpoint(controller.snapshot().generation);

    expect(await firstAuthorized.promise).toBe(first);
    newer = gate.captureAcceptedInput(ctx, "same", undefined, "steer")!;
    expect(gate.userMessageStarted({ role: "user", content: [{ type: "text", text: "same" }] })).toBe(first);
    expect(controller.queuedInputSnapshot()).toEqual([newer]);
    releaseFirst.resolve();
    await checkpoint;
    expect(replayCalls).toBe(2);
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("revokes a pending replay tombstone after a successful generation reset", async () => {
    const { controller, gate } = setup();
    const settlement = deferred<void>();
    let retired: QueuedInputShadow | undefined;
    gate.attachExecution({
      compact: async () => ({ ok: true }),
      resume: () => ({
        settled: settlement.promise,
        replay: async (input) => {
          retired = gate.withReplayAuthorization(input, () => gate.authorizeReplay({
            text: "retired", source: "extension", streamingBehavior: "followUp",
          }));
          return { delivered: true as const };
        },
        replayComplete: () => { settlement.resolve(); },
        cancelAndJoin: async () => settlement.promise,
      }),
    });
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage, hasPendingMessages: () => false };
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("a", {}, undefined, undefined, ctx);
    const old = gate.captureAcceptedInput(ctx, "retired", undefined, "followUp")!;
    gate.toolExecutionEnded({ toolCallId: "a", result, isError: false });
    gate.turnEnded(ctx);
    await controller.checkpoint(controller.snapshot().generation);

    expect(retired).toBe(old);
    expect(controller.snapshot().phase).toBe("idle");
    gate.assistantMessageEnded(assistant("b"));
    expect(gate.captureAcceptedInput(ctx, "current", undefined, "steer")).toBeUndefined();
    expect(() => gate.withReplayAuthorization(old, () => undefined)).toThrow(/stale/);
    expect(gate.userMessageStarted({
      role: "user", content: [{ type: "text", text: "current" }],
    })).toBeUndefined();
    expect(controller.queuedInputSnapshot()).toEqual([]);
  });

  it("revokes a pending replay tombstone when the session controller is replaced", async () => {
    const { controller, gate } = setup();
    const settlement = deferred<void>();
    const authorized = deferred<void>();
    const releaseReplay = deferred<void>();
    gate.attachExecution({
      compact: async () => ({ ok: true }),
      resume: () => ({
        settled: settlement.promise,
        replay: async (input) => {
          expect(gate.withReplayAuthorization(input, () => gate.authorizeReplay({
            text: "retired", source: "extension", streamingBehavior: "followUp",
          }))).toBe(input);
          authorized.resolve();
          await releaseReplay.promise;
          return { delivered: true as const };
        },
        cancelAndJoin: () => {
          releaseReplay.resolve();
          settlement.resolve();
        },
      }),
    });
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage, hasPendingMessages: () => false };
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("a", {}, undefined, undefined, ctx);
    const old = gate.captureAcceptedInput(ctx, "retired", undefined, "followUp")!;
    gate.toolExecutionEnded({ toolCallId: "a", result, isError: false });
    gate.turnEnded(ctx);
    const checkpoint = controller.checkpoint(controller.snapshot().generation);
    await authorized.promise;

    await gate.startSession("replacement");
    await checkpoint;
    const replacement = gate.currentController();
    expect(replacement).not.toBe(controller);
    gate.assistantMessageEnded(assistant("b"));
    expect(gate.captureAcceptedInput(ctx, "replacement current", undefined, "steer")).toBeUndefined();
    expect(() => gate.withReplayAuthorization(old, () => undefined)).toThrow(/stale/);
    expect(gate.userMessageStarted({
      role: "user", content: [{ type: "text", text: "replacement current" }],
    })).toBeUndefined();
    expect(replacement.queuedInputSnapshot()).toEqual([]);
  });

  it("leaves unmatched shadows intact and invalidates an ambiguous clean path", async () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = {
      model: { api: "openai-responses" }, getContextUsage: () => usage,
      hasPendingMessages: () => false, abort: () => undefined,
    };
    const image = { type: "image", data: "right", mimeType: "image/png" };
    armForReconciliation(gate, ctx);
    const shadow = gate.captureAcceptedInput(ctx, "same", [image], "followUp")!;
    expect(gate.userMessageStarted({
      role: "user", content: [{ type: "text", text: "same" }, { ...image, data: "wrong" }],
    }, "followUp")).toBeUndefined();
    expect(controller.queuedInputSnapshot()).toEqual([shadow]);
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("a", {}, undefined, undefined, ctx);
    gate.toolExecutionEnded({ toolCallId: "a", result, isError: false });
    expect(controller.snapshot()).toMatchObject({ phase: "awaiting-settlement", checkpointAbortRequested: true });
  });

  it("revokes a stopped logical run and permits the next genuine run only after settlement", async () => {
    const { controller, gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    let aborts = 0;
    const ctx = {
      model: { api: "openai-responses" }, getContextUsage: () => usage,
      hasPendingMessages: () => false, abort: () => { aborts += 1; },
    };
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    await wrapped.execute("a", {}, undefined, undefined, ctx);
    gate.captureLogicalRunStop()();
    await controller.stableBarrier(controller.snapshot().generation);
    expect(controller.snapshot().phase).toBe("cancelled");
    expect(gate.turnEnded(ctx)).toBeUndefined();
    expect(gate.settlementGeneration(ctx)).toBeUndefined();
    await gate.defensiveLatch(ctx);
    expect(aborts).toBe(1);
    expect(await gate.settleLogicalRunStop()).toBe(true);
    expect(gate.currentController()).not.toBe(controller);
    expect(gate.currentController().snapshot().phase).toBe("idle");

    gate.assistantMessageEnded(assistant("b"));
    const next: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    expect((await next.execute("b", {}, undefined, undefined, ctx)).terminate).toBe(true);
  });

  it("ignores stale universal-stop authority after a session generation changes", async () => {
    const { gate } = setup();
    const staleStop = gate.captureLogicalRunStop();
    await gate.startSession("replacement");
    expect(staleStop()).toBe(false);
    expect(gate.isLogicalRunStopped()).toBe(false);
    expect(gate.currentController().snapshot().phase).toBe("idle");
  });

  it("revokes captured lifecycle authority at true settlement and accepted next runs", () => {
    const { gate } = setup();
    const settledRunStop = gate.captureLogicalRunStop();
    gate.logicalRunSettled();
    expect(settledRunStop()).toBe(false);

    const beforeNextInput = gate.captureLogicalRunStop();
    gate.acceptedLogicalRun();
    expect(beforeNextInput()).toBe(false);
    expect(gate.isLogicalRunStopped()).toBe(false);
  });

  it("samples the settled fallback only for a supported proactive API", () => {
    const unsupported = setup();
    expect(unsupported.gate.settlementGeneration({
      model: { api: "anthropic-messages" }, getContextUsage: () => usage,
    })).toBeUndefined();
    expect(unsupported.controller.snapshot().phase).toBe("idle");

    const supported = setup();
    const generation = supported.gate.settlementGeneration({
      model: { api: "openai-responses" }, getContextUsage: () => usage,
    });
    expect(generation).toBe(supported.controller.snapshot().generation);
    expect(supported.controller.snapshot().phase).toBe("awaiting-settlement");
  });

  it("preserves an already-active supported generation after the model API changes", () => {
    const { controller, gate } = setup();
    const generation = gate.settlementGeneration({
      model: { api: "openai-responses" }, getContextUsage: () => usage,
    });
    expect(gate.settlementGeneration({
      model: { api: "anthropic-messages" }, getContextUsage: () => usage,
    })).toBe(generation);
    expect(controller.snapshot().phase).toBe("awaiting-settlement");
  });

  it("keeps logical-run authority stable across physical checkpoint reentry", () => {
    const { gate } = setup();
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage };
    gate.settlementGeneration(ctx);
    const sameRunStop = gate.captureLogicalRunStop();
    // Re-observing the armed physical settlement does not rotate logical identity.
    gate.settlementGeneration(ctx);
    expect(sameRunStop()).toBe(true);
    expect(gate.isLogicalRunStopped()).toBe(true);
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
    armForReconciliation(gate, ctx);
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
    const { controller, gate } = setup();
    const resumedSettlement = deferred<void>();
    const replayRelease = deferred<void>();
    gate.attachExecution({
      compact: async () => ({ ok: true }),
      resume: () => ({
        replay: async () => { await replayRelease.promise; return { delivered: true }; },
        settled: resumedSettlement.promise,
        cancelAndJoin: async () => { throw new Error("join failed"); },
      }),
    });
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage, hasPendingMessages: () => false };
    const authorize = deferred<void>();
    const wrapped: any = gate.wrapTool({ name: "probe", execute: async () => ({ content: [], details: {} }) });
    const result = await wrapped.execute("a", {}, undefined, undefined, ctx);
    const shadow = gate.captureAcceptedInput(ctx, "queued", undefined, "steer")!;
    gate.toolExecutionEnded({ toolCallId: "a", result, isError: false });
    gate.turnEnded(ctx);
    void controller.checkpoint(controller.snapshot().generation).catch(() => undefined);
    await waitUntil({
      description: "checkpoint resume ownership",
      predicate: () => controller.snapshot().phase === "resuming",
      describeObserved: () => controller.snapshot().phase,
    });
    const staleReplay = gate.withReplayAuthorization(shadow, async () => {
      await authorize.promise;
      return gate.authorizeReplay({
        text: "queued", source: "extension", streamingBehavior: "steer",
      });
    });

    const switching = gate.beforeSessionSwitch();
    authorize.resolve();
    replayRelease.resolve();
    expect(await staleReplay).toBeUndefined();
    await expect(switching).resolves.toEqual({ cancel: true });
    expect(controller.snapshot().phase).toBe("cancelled");
    expect(() => gate.withReplayAuthorization(shadow, () => undefined)).toThrow(/stale/);
    resumedSettlement.resolve();
  });

  it("uses the attached execution adapter and controller-owned summary latch", async () => {
    const { controller, gate } = setup();
    let compactCalls = 0;
    gate.attachExecution({
      compact: async (_signal) => {
        compactCalls += 1;
        const generation = controller.snapshot().generation;
        const token = controller.beginCompactionSummary(generation)!;
        let aborts = 0;
        gate.defensiveLatch({ abort: () => { aborts += 1; } });
        expect(aborts).toBe(0);
        expect(controller.endCompactionSummary(token)).toBe(true);
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
  let inputHooks: { fire: (...args: any[]) => Promise<any> };
  let sdk: ReturnType<typeof fakeSdk>;
  let duringForkDispatch: ((prompt: string) => Promise<void>) | undefined;
  const integrationDeadlines = manualDeadlineClock();
  const installFreshExtension = async (): Promise<void> => {
    pi = fakePi();
    picc(pi.api as never, {
      sdk: sdk.sdk,
      onInitializationSettled: pi.captureInitialization,
      checkpointDeadlinePolicy: { clock: integrationDeadlines.clock },
      onWired: (internals) => {
        mainCheckpointGate = internals.mainCheckpointGate;
        inputHooks = internals.inputHooks;
      },
    });
    await pi.waitForInitialization();
    await pi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
  };
  const originalCwd = process.cwd();
  const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-proactive-"));
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Test project\n");
    fs.mkdirSync(path.join(dir, "guard-context"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".claude", "rules"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude", "rules", "guard-context.md"),
      "---\npaths:\n  - guard-context/**\n---\n# Guard context\n",
    );
    // A PreCompact hook keyed on the trigger (manual|auto): each matcher appends its own
    // trigger to a marker so a test can read back which trigger PiCC presented.
    fs.writeFileSync(
      path.join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "compact",
              hooks: [{ type: "command", command: `payload=$(cat); printf "%s" "$payload" | grep -q '\"source\":\"compact\"' && echo start >> "$CLAUDE_PROJECT_DIR/.claude/.compact-trace"; if [ -f "$CLAUDE_PROJECT_DIR/.claude/.session-stop" ]; then printf '%s\\n' '{"continue":false,"stopReason":"compact lifecycle stopped"}'; elif [ -f "$CLAUDE_PROJECT_DIR/.claude/.session-context" ]; then echo mandatory-context; fi` }],
            },
          ],
          PostCompact: [
            {
              matcher: "auto",
              hooks: [{ type: "command", command: 'payload=$(cat); printf "%s" "$payload" | grep -q "\\\"trigger\\\":\\\"auto\\\"" && printf "%s" "$payload" | grep -q "\\\"compact_summary\\\":\\\"summary\\\"" && ! printf "%s" "$payload" | grep -q "\\\"reason\\\"" && echo post >> "$CLAUDE_PROJECT_DIR/.claude/.compact-trace"' }],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [{ type: "command", command: 'printf x >> "$CLAUDE_PROJECT_DIR/input-hook-count"; payload=$(cat); if printf "%s" "$payload" | grep -q stop-me; then printf "%s\\n" \x27{"continue":false,"stopReason":"input stopped by test"}\x27; elif printf "%s" "$payload" | grep -q block-me; then echo "blocked by test" >&2; exit 2; fi' }],
            },
          ],
          Stop: [
            {
              hooks: [{ type: "command", command: 'if [ -f "$CLAUDE_PROJECT_DIR/.claude/gate-stop" ]; then echo entered > "$CLAUDE_PROJECT_DIR/.claude/stop-entered"; while [ ! -f "$CLAUDE_PROJECT_DIR/.claude/release-stop" ]; do sleep 0.02; done; fi; if [ -f "$CLAUDE_PROJECT_DIR/.claude/universal-stop" ]; then printf "%s\\n" \x27{"continue":false,"stopReason":"stop lifecycle stopped"}\x27; elif [ -f "$CLAUDE_PROJECT_DIR/.claude/block-stop" ]; then echo "continue test work" >&2; exit 2; fi' }],
            },
          ],
          PreCompact: [
            {
              matcher: "auto",
              hooks: [
                { type: "command", command: 'payload=$(cat); printf "%s" "$payload" | grep -q "\\\"trigger\\\":\\\"auto\\\"" && printf "%s" "$payload" | grep -q "\\\"custom_instructions\\\":\\\"\\\"" && echo auto >> "$CLAUDE_PROJECT_DIR/.claude/.precompact-log" && echo pre >> "$CLAUDE_PROJECT_DIR/.claude/.compact-trace"' },
                { type: "command", command: 'if [ -f "$CLAUDE_PROJECT_DIR/.claude/block-compact" ]; then echo "policy block" >&2; exit 2; fi' },
                { type: "command", command: 'if [ -f "$CLAUDE_PROJECT_DIR/.claude/gate-precompact" ]; then echo entered > "$CLAUDE_PROJECT_DIR/.claude/precompact-entered"; while [ ! -f "$CLAUDE_PROJECT_DIR/.claude/release-precompact" ]; do sleep 0.02; done; fi' },
              ],
            },
            {
              matcher: "manual",
              hooks: [
                { type: "command", command: 'echo manual >> "$CLAUDE_PROJECT_DIR/.claude/.precompact-log"' },
                { type: "command", command: 'if [ -f "$CLAUDE_PROJECT_DIR/.claude/gate-precompact" ]; then echo entered > "$CLAUDE_PROJECT_DIR/.claude/precompact-entered"; while [ ! -f "$CLAUDE_PROJECT_DIR/.claude/release-precompact" ]; do sleep 0.02; done; fi' },
              ],
            },
          ],
        },
      }),
    );
    const skillDir = path.join(dir, ".claude", "skills", "expand");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\ndescription: Expand test input\n---\nExpanded: $ARGUMENTS\n");
    const denySkillDir = path.join(dir, ".claude", "skills", "deny-once");
    fs.mkdirSync(denySkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(denySkillDir, "SKILL.md"),
      "---\ndescription: Temporary deny\ndisallowed-tools:\n  - Bash(blocked-*)\n---\nDeny once.\n",
    );
    const stagedDenySkillDir = path.join(dir, ".claude", "skills", "staged-deny");
    fs.mkdirSync(stagedDenySkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagedDenySkillDir, "SKILL.md"),
      "---\ndescription: Staged deny\ndisallowed-tools:\n  - Bash(staged-*)\n---\nStaged deny: $ARGUMENTS\n",
    );
    const scopedForkSkillDir = path.join(dir, ".claude", "skills", "scoped-fork");
    fs.mkdirSync(scopedForkSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(scopedForkSkillDir, "SKILL.md"),
      [
        "---",
        "description: Scoped fork hook proof",
        "context: fork",
        "hooks:",
        "  SubagentStart:",
        "    - hooks:",
        "        - type: command",
        '          command: echo scoped >> "$CLAUDE_PROJECT_DIR/.claude/scoped-fork-hook"',
        "---",
        "Run the scoped fork for $ARGUMENTS.",
        "",
      ].join("\n"),
    );
    const userDir = path.join(dir, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    sdk = fakeSdk({
      onPrompt: async (prompt) => {
        await duringForkDispatch?.(prompt);
        return "scoped fork completed";
      },
    });
    await installFreshExtension();
  });

  afterAll(() => {
    process.chdir(originalCwd);
    if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
    else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A checkpoint that gives up in a non-interactive mode sets this worker's own
  // `process.exitCode`, which is the product behaviour under test — and would otherwise
  // leak out of whichever case happened to run last.
  let savedExitCode: typeof process.exitCode;
  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it.each(["tui", "json", "rpc"] as const)(
    "fails closed with one structured %s manual refusal when callback compaction exceeds the production ceiling",
    async (mode) => {
      const deadlinePi = fakePi();
      let deadlineGate!: MainSessionCheckpointGate;
    picc(deadlinePi.api as never, {
      onInitializationSettled: deadlinePi.captureInitialization,
      checkpointDeadlinePolicy: { clock: integrationDeadlines.clock },
      onWired: (internals) => { deadlineGate = internals.mainCheckpointGate; },
    });
    await deadlinePi.waitForInitialization();
    await deadlineGate.startSession("callback-deadline");
    let compactOptions: any;
    const committed = deferred<void>();
    let ctx: any;
    ctx = deadlinePi.ctx({
      mode, hasUI: mode === "tui" || mode === "rpc",
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      compact: (options: any) => {
        compactOptions = options;
        void (async () => {
          const before = await deadlinePi.fire("session_before_compact", { reason: "manual" }, ctx);
          if (before?.cancel) return options.onError(new Error("cancelled"));
          await deadlinePi.fire("session_compact", {
            reason: "manual", compactionEntry: { summary: "committed before deadline" },
          }, ctx);
          committed.resolve();
        })();
      },
    });
    deadlineGate.assistantMessageEnded({
      role: "assistant", content: [{ type: "toolCall", id: "deadline-tool", name: "probe", arguments: {} }],
    });
    const wrapped: any = deadlineGate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    });
    const result = await wrapped.execute("deadline-tool", {}, undefined, undefined, ctx);
    deadlineGate.captureAcceptedInput(ctx, "resend after deadline", undefined, "steer");
    deadlineGate.toolExecutionEnded({ toolCallId: "deadline-tool", result, isError: false });
    deadlineGate.turnEnded(ctx);
    const settling = deadlinePi.fire("agent_settled", {}, ctx);
    await waitUntil({
      description: "main callback deadline to arm",
      predicate: () => integrationDeadlines.timers.some((timer) => timer.active && timer.delayMs === MAIN_CALLBACK_COMPACTION_DEADLINE_MS),
    });
    await committed.promise;
    const timer = [...integrationDeadlines.timers].reverse().find((candidate) => candidate.active &&
      candidate.delayMs === MAIN_CALLBACK_COMPACTION_DEADLINE_MS)!;
    timer.expire();
    await settling;
    const controller = deadlineGate.currentController();
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted", admission: "closed", failureCategory: "unconfirmed-host",
    });
    expect(controller.recoveryToken(controller.snapshot().generation)).toBeUndefined();
    const presentation = deadlinePi.entries.filter((entry) => entry.customType === "picc-proactive-compact");
    const notice = mode === "tui"
      ? presentation.find((entry) => entry.data.severity === "error")?.data.notice
      : deadlinePi.entries.find((entry) => entry.data.category === "checkpoint-cancelled")?.data.notice;
    expectUnconfirmedHostRecovery(String(notice));
    expect(presentation).toHaveLength(mode === "tui" ? 2 : 0);
    if (mode === "tui") {
      expect(presentation.at(-1)?.data).toEqual({
        notice: "1 queued input was not replayed; 1 text input was restored.",
        severity: "info",
      });
    }

    const recoveryCount = deadlinePi.entries.filter((entry) =>
      entry.data.category === "checkpoint-input-recovery").length;
    await expect(deadlinePi.fire("session_before_compact", { reason: "manual" }, ctx))
      .resolves.toEqual({ cancel: true });
    const manualRefusals = deadlinePi.entries.filter((entry) =>
      entry.data.category === "checkpoint-manual-compaction-refused");
    if (mode === "tui") {
      expect(manualRefusals).toHaveLength(0);
      expect(deadlinePi.notifications.at(-1)?.severity).toBe("warning");
      expectUnconfirmedHostRecovery(String(deadlinePi.notifications.at(-1)?.text));
    } else {
      expect(manualRefusals).toHaveLength(1);
      expect(manualRefusals[0]?.data).toMatchObject({ action: "restart-process" });
      expectUnconfirmedHostRecovery(String(manualRefusals[0]?.data.notice));
    }
    expect(deadlinePi.entries.filter((entry) =>
      entry.data.category === "checkpoint-input-recovery")).toHaveLength(recoveryCount);

    const switchCtx = deadlinePi.tuiCtx();
    await expect(deadlinePi.fire("session_before_switch", {}, switchCtx)).resolves.toEqual({ cancel: true });
    expect(deadlineGate.currentController()).toBe(controller);
    expect(deadlinePi.notifications.at(-1)?.severity).toBe("error");
    expectUnconfirmedHostRecovery(String(deadlinePi.notifications.at(-1)?.text));
    const switchNotice = deadlinePi.entries.find((entry) =>
      entry.data.category === "checkpoint-session-switch-refused")?.data.notice;
    expectUnconfirmedHostRecovery(String(switchNotice));

    const replacementError = await deadlineGate.startSession("forbidden-replacement").then(
      () => "",
      (error: unknown) => String(error),
    );
    expectUnconfirmedHostRecovery(replacementError);
    compactOptions.onComplete({ summary: "late" });
    expect(controller.snapshot().failureCategory).toBe("unconfirmed-host");
    const recovery = deadlinePi.entries.filter((entry) => entry.data.category === "checkpoint-input-recovery");
    expect(recovery).toHaveLength(1);
      expect(recovery[0]?.data.count).toBe(1);
    },
  );

  it("fails closed through registered session switching when resumed cancellation misses its ceiling", async () => {
    const deadlines = manualDeadlineClock();
    const deadlinePi = fakePi();
    let deadlineGate!: MainSessionCheckpointGate;
    picc(deadlinePi.api as never, {
      onInitializationSettled: deadlinePi.captureInitialization,
      checkpointDeadlinePolicy: { clock: deadlines.clock },
      onWired: (internals) => { deadlineGate = internals.mainCheckpointGate; },
    });
    await deadlinePi.waitForInitialization();
    await deadlineGate.startSession("resumed-join-deadline");
    let providerAborts = 0;
    const ctx = deadlinePi.ctx({
      mode: "json", hasUI: false,
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      abort: () => { providerAborts += 1; },
      compact: (options: any) => {
        void (async () => {
          const before = await deadlinePi.fire("session_before_compact", { reason: "manual" }, ctx);
          if (before?.cancel) return options.onError(new Error("cancelled"));
          await deadlinePi.fire("session_compact", {
            reason: "manual", compactionEntry: { summary: "committed" },
          }, ctx);
          options.onComplete({ summary: "committed" });
        })();
      },
    });
    deadlineGate.assistantMessageEnded({
      role: "assistant", content: [{ type: "toolCall", id: "join-tool", name: "probe", arguments: {} }],
    });
    const wrapped: any = deadlineGate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    });
    const result = await wrapped.execute("join-tool", {}, undefined, undefined, ctx);
    deadlineGate.captureAcceptedInput(ctx, "resend after join expiry", undefined, "followUp");
    deadlineGate.toolExecutionEnded({ toolCallId: "join-tool", result, isError: false });
    deadlineGate.turnEnded(ctx);
    const outer = deadlinePi.fire("agent_settled", {}, ctx);
    void outer.catch(() => undefined);
    await waitUntil({
      description: "registered resumed run",
      predicate: () => deadlineGate.currentController().snapshot().phase === "resuming",
    });
    const controllerBeforeSwitch = deadlineGate.currentController();
    const cancelling = deadlinePi.fire("session_before_switch", {}, ctx);
    await waitUntil({
      description: "registered resumed join deadline",
      predicate: () => deadlines.timers.some((timer) => timer.active && timer.delayMs === RESUMED_RUN_JOIN_DEADLINE_MS),
    });
    deadlines.timers.find((timer) => timer.active && timer.delayMs === RESUMED_RUN_JOIN_DEADLINE_MS)!.expire();
    await expect(cancelling).resolves.toEqual({ cancel: true });
    const controller = deadlineGate.currentController();
    expect(controller.snapshot()).toMatchObject({
      phase: "cancelled", admission: "closed", cancellationQuiescence: "unconfirmed",
    });
    expect(controller).toBe(controllerBeforeSwitch);
    const notice = deadlinePi.entries.find((entry) => entry.data.category === "checkpoint-cancelled")?.data.notice;
    expectUnconfirmedHostRecovery(String(notice));
    const switchNotice = deadlinePi.entries.find((entry) =>
      entry.data.category === "checkpoint-session-switch-refused")?.data.notice;
    expectUnconfirmedHostRecovery(String(switchNotice));
    const replacementError = await deadlineGate.startSession("forbidden-after-join").then(
      () => "",
      (error: unknown) => String(error),
    );
    expectUnconfirmedHostRecovery(replacementError);
    expect(deadlineGate.currentController()).toBe(controller);
    await deadlinePi.fire("agent_settled", {}, ctx);
    await expect(outer).rejects.toThrow(/quiescence/);

    expect(controller.snapshot().failureCategory).toBeUndefined();
    const recoveryBeforeLaterInput = deadlinePi.entries.filter((entry) =>
      entry.data.category === "checkpoint-input-recovery");
    expect(recoveryBeforeLaterInput).toHaveLength(1);
    await expect(deadlinePi.fire("input", {
      text: "later ordinary prompt", source: "interactive", streamingBehavior: "followUp",
    }, ctx)).resolves.toEqual({ action: "handled" });
    const admissionRefusals = deadlinePi.entries.filter((entry) =>
      entry.data.category === "checkpoint-admission-refused");
    expect(admissionRefusals).toHaveLength(1);
    expect(admissionRefusals[0]?.data).toMatchObject({ action: "restart-process" });
    expectUnconfirmedHostRecovery(String(admissionRefusals[0]?.data.notice));
    const laterInputRecovery = deadlinePi.entries.filter((entry) =>
      entry.data.category === "checkpoint-input-recovery");
    expect(laterInputRecovery).toHaveLength(2);
    expect(laterInputRecovery.every((entry) => entry.data.count === 1)).toBe(true);
    expect(laterInputRecovery.at(-1)?.data).toMatchObject({ count: 1, action: "resend-input" });
    const providerAbortsBeforeRequest = providerAborts;
    await deadlinePi.fire("before_provider_request", {}, ctx);
    expect(providerAborts).toBe(providerAbortsBeforeRequest + 1);

    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      await expect(deadlinePi.fire("session_before_switch", {}, deadlinePi.printCtx()))
        .resolves.toEqual({ cancel: true });
    } finally {
      errorSpy.mockRestore();
    }
    const stderrGuidance = errors.filter((line) => line.startsWith("PiCC: ")).join("\n");
    expectUnconfirmedHostRecovery(stderrGuidance);
    const recovery = deadlinePi.entries.filter((entry) => entry.data.category === "checkpoint-input-recovery");
    expect(recovery).toHaveLength(2);
    expect(recovery.every((entry) => entry.data.count === 1)).toBe(true);
  });

  it("rejects genuine input until a universally stopped host run settles, then accepts a real tool cycle", async () => {
    await mainCheckpointGate.startSession("stopped-input-wiring");
    const hookCount = path.join(dir, "input-hook-count");
    const before = fs.existsSync(hookCount) ? fs.readFileSync(hookCount, "utf8").length : 0;
    let aborts = 0;
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
      hasPendingMessages: () => false,
      abort: () => { aborts += 1; },
    });

    expect(await pi.fire("input", { text: "stop-me", source: "interactive" }, ctx))
      .toEqual({ action: "handled" });
    expect(mainCheckpointGate.isLogicalRunStopped()).toBe(true);
    expect(aborts).toBe(1);
    expect(await pi.fire("input", { text: "too early", source: "interactive" }, ctx))
      .toEqual({ action: "handled" });
    expect(fs.readFileSync(hookCount, "utf8").length).toBe(before + 1);

    await pi.fire("agent_settled", {}, ctx);
    expect(mainCheckpointGate.isLogicalRunStopped()).toBe(false);
    expect(await pi.fire("input", { text: "next real run", source: "interactive" }, ctx))
      .toEqual({ action: "continue" });
    expect(fs.readFileSync(hookCount, "utf8").length).toBe(before + 2);

    const skill = pi.tools.get("Skill")!;
    await pi.fire("message_end", {
      message: { role: "assistant", content: [{ type: "toolCall", id: "next-tool", name: "Skill", arguments: {} }] },
    }, ctx);
    const result = await skill.execute(
      "next-tool", { name: "expand", arguments: "after-stop" },
      new AbortController().signal, () => undefined, ctx,
    );
    await pi.fire("tool_execution_end", { toolCallId: "next-tool", result, isError: false }, ctx);
    expect(await pi.fire("turn_end", {}, ctx)).toBeUndefined();
    expect(result.terminate).toBeUndefined();
  });

  it("completes three registered generations with stable barriers and useful idle input", async () => {
    await mainCheckpointGate.startSession("registered-repeated-generations");
    let compactions = 0;
    let usagePercent = 90;
    const order: string[] = [];
    let ctx: any;
    ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({
        tokens: usagePercent * 10, contextWindow: 1000, percent: usagePercent,
      }),
      hasPendingMessages: () => false,
      compact: (options: any) => {
        compactions += 1;
        const physical = compactions;
        order.push(`compact-${physical}`);
        void (async () => {
          const before = await pi.fire("session_before_compact", { reason: "manual" }, ctx);
          if (before?.cancel) return options.onError(new Error("cancelled"));
          await pi.fire("session_compact", {
            reason: "manual", compactionEntry: { summary: `summary-${physical}` },
          }, ctx);
          options.onComplete({ summary: `summary-${physical}` });
        })();
      },
    });
    const generations: number[] = [];
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      usagePercent = 90;
      mainCheckpointGate.assistantMessageEnded({
        role: "assistant",
        content: [{ type: "toolCall", id: `repeat-${cycle}`, name: "probe", arguments: {} }],
      });
      const wrapped: any = mainCheckpointGate.wrapTool({
        name: "probe", execute: async () => ({ content: [{ type: "text", text: `done-${cycle}` }], details: {} }),
      });
      const result = await wrapped.execute(`repeat-${cycle}`, {}, undefined, undefined, ctx);
      mainCheckpointGate.toolExecutionEnded({ toolCallId: `repeat-${cycle}`, result, isError: false });
      mainCheckpointGate.turnEnded(ctx);
      generations.push(mainCheckpointGate.currentController().snapshot().generation);
      const outer = pi.fire("agent_settled", {}, ctx);
      await waitUntil({
        description: `registered generation ${cycle} resume`,
        predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming",
      });
      usagePercent = 10;
      await pi.fire("agent_settled", {}, ctx);
      await outer;
      order.push(`stable-${cycle}`);
      expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({ phase: "idle", admission: "open" });
      await expect(pi.fire("input", {
        text: `useful-after-${cycle}`, source: "interactive", streamingBehavior: undefined,
      }, ctx)).resolves.toEqual({ action: "continue" });
      await pi.fire("message_start", {
        message: { role: "user", content: [{ type: "text", text: `useful-after-${cycle}` }] },
      }, ctx);
      expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([]);
    }
    expect(generations).toEqual([1, 2, 3]);
    expect(compactions).toBe(3);
    expect(order).toEqual([
      "compact-1", "stable-1", "compact-2", "stable-2", "compact-3", "stable-3",
    ]);
  });

  it("keeps registered replay custody without message_start and consumes delayed starts once", async () => {
    const originalSendUserMessage = pi.api.sendUserMessage as (...args: any[]) => void;
    const drive = async (sessionId: string, text: string, authenticate: boolean) => {
      await mainCheckpointGate.startSession(sessionId);
      let ctx: any;
      ctx = pi.printCtx({
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        compact: (options: any) => {
          void (async () => {
            const before = await pi.fire("session_before_compact", { reason: "manual" }, ctx);
            if (before?.cancel) return options.onError(new Error("cancelled"));
            await pi.fire("session_compact", {
              reason: "manual", compactionEntry: { summary: "replay summary" },
            }, ctx);
            options.onComplete({ summary: "replay summary" });
          })();
        },
      });
      mainCheckpointGate.assistantMessageEnded({
        role: "assistant", content: [{ type: "toolCall", id: text, name: "probe", arguments: {} }],
      });
      const wrapped: any = mainCheckpointGate.wrapTool({
        name: "probe", execute: async () => ({ content: [], details: {} }),
      });
      const result = await wrapped.execute(text, {}, undefined, undefined, ctx);
      mainCheckpointGate.captureAcceptedInput(ctx, text, undefined, "followUp");
      mainCheckpointGate.toolExecutionEnded({ toolCallId: text, result, isError: false });
      mainCheckpointGate.turnEnded(ctx);
      const beforeSends = pi.userMessages.length;
      const beforeEntries = pi.entries.length;
      const outer = pi.fire("agent_settled", {}, ctx);
      await waitUntil({
        description: `registered replay dispatch for ${text}`,
        predicate: () => pi.userMessages.slice(beforeSends).some((entry) => entry.content === text),
      });
      const controller = mainCheckpointGate.currentController();
      expect(controller.queuedInputSnapshot().map((entry) => entry.content)).toEqual([text]);
      if (authenticate) {
        await pi.fire("message_start", {
          message: { role: "user", content: [{ type: "text", text }] }, delivery: "followUp",
        }, ctx);
        expect(controller.queuedInputSnapshot()).toEqual([]);
      }
      await pi.fire("agent_settled", {}, ctx);
      await outer;
      return { controller, reports: pi.entries.slice(beforeEntries).filter((entry) =>
        entry.data.category === "checkpoint-input-recovery") };
    };
    try {
      pi.api.sendUserMessage = (content: any, options: any) => originalSendUserMessage(content, options);
      const withheld = await drive("registered-replay-withheld", "withheld replay", false);
      expect(withheld.controller.snapshot()).toMatchObject({
        phase: "exhausted", failureCategory: "restoration-paused",
      });
      expect(withheld.reports).toHaveLength(1);
      const delayed = await drive("registered-replay-delayed", "delayed replay", true);
      expect(delayed.controller.snapshot()).toMatchObject({ phase: "idle", admission: "open" });
      expect(delayed.reports).toHaveLength(0);
    } finally {
      pi.api.sendUserMessage = originalSendUserMessage;
    }
  });

  it("wires fresh assistant usage and final provider admission through the registered main handlers", async () => {
    pi.entries.length = 0;
    let aborts = 0;
    let percent: number | null = null;
    const ctx = pi.rpcCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses", contextWindow: 1000 },
      getContextUsage: () => ({
        tokens: percent === null ? null : percent * 10, contextWindow: 1000, percent,
      }),
      abort: () => { aborts += 1; },
    });
    await pi.fire("session_start", { reason: "new" }, ctx);
    await pi.fire("message_end", {
      message: {
        role: "assistant", stopReason: "toolUse",
        usage: {
          input: 900, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 900,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [{ type: "toolCall", id: "wired-tool", name: "Skill", arguments: {} }],
      },
    }, ctx);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("stopping");
    expect(aborts).toBe(0);
    const armed = pi.entries.find((entry) => entry.data.category === "checkpoint-armed");
    expect(armed?.data.notice).toMatch(/queued.*safe settlement/i);
    expect(String(armed?.data.notice)).not.toMatch(/compacting|compaction (?:has )?started/i);

    await mainCheckpointGate.startSession("registered-provider-admission-boundary");
    percent = 90;
    await pi.fire("before_provider_request", {}, ctx);
    expect(aborts).toBe(1);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("awaiting-settlement");
    const admissionArmed = pi.entries.filter((entry) => entry.data.category === "checkpoint-armed").at(-1);
    expect(admissionArmed?.data.notice).toMatch(/queued.*waiting for safe settlement/i);
    expect(String(admissionArmed?.data.notice)).not.toMatch(/starting|settled fallback/i);
    await pi.fire("before_provider_request", {}, ctx);
    expect(aborts).toBe(1);

    await mainCheckpointGate.startSession("registered-settled-wording");
    pi.entries.length = 0;
    expect(mainCheckpointGate.settlementGeneration(ctx)).toBe(1);
    const settledArmed = pi.entries.find((entry) => entry.data.category === "checkpoint-armed");
    expect(settledArmed?.data.notice).toMatch(/starting.*settled fallback/i);
    expect(String(settledArmed?.data.notice)).not.toMatch(/queued|waiting/i);
    await mainCheckpointGate.startSession("registered-observation-boundaries-complete");
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

  it("scopes a staged typed-fork hook to child execution and discards it on final refusal", async () => {
    await mainCheckpointGate.startSession("staged-fork-hook-refusal");
    pi.entries.length = 0;
    const marker = path.join(dir, ".claude", "scoped-fork-hook");
    const stopMarker = path.join(dir, ".claude", ".session-stop");
    fs.rmSync(marker, { force: true });
    fs.writeFileSync(stopMarker, "close after the committed summary");
    let ctx: any;
    ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      compact: (options: any) => {
        pi.compactCalls.push(options);
        void (async () => {
          const before = await pi.fire("session_before_compact", { reason: "manual" }, ctx);
          if (before?.cancel) return options.onError(new Error("cancelled"));
          await pi.fire("session_compact", {
            reason: "manual", compactionEntry: { summary: "fork refusal summary" },
          }, ctx);
          options.onComplete({ summary: "fork refusal summary" });
        })();
      },
    });
    duringForkDispatch = async () => {
      duringForkDispatch = undefined;
      expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["scoped"]);
      await pi.fire("agent_settled", {}, ctx);
      expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
      });
    };
    try {
      await expect(pi.fire("input", {
        text: "/scoped-fork guarded child", source: "interactive", streamingBehavior: undefined,
      }, ctx)).resolves.toEqual({ action: "handled" });
      expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["scoped"]);
      expect(pi.entries.filter((entry) =>
        entry.data.category === "checkpoint-input-recovery")).toHaveLength(1);

      const promptCallsBefore = sdk.promptCalls();
      await expect(pi.tools.get("Agent").execute("post-refusal-global-proof", {
        subagent_type: "general-purpose",
        prompt: "prove the refused staged hook is not global",
        run_in_background: false,
      })).resolves.toMatchObject({ content: [expect.objectContaining({ type: "text" })] });
      expect(sdk.promptCalls()).toBe(promptCallsBefore + 1);
      expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["scoped"]);
    } finally {
      duringForkDispatch = undefined;
      fs.rmSync(stopMarker, { force: true });
      fs.rmSync(marker, { force: true });
    }
  });

  it("merges concurrently accepted skill activations and gives the latest run deny ownership", async () => {
    await mainCheckpointGate.startSession("concurrent-skill-activation");
    const ctx = pi.rpcCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    });
    const marker = path.join(dir, ".claude", "scoped-fork-hook");
    fs.rmSync(marker, { force: true });
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const promptBaseline = sdk.promptCalls();
    let dispatchOrdinal = 0;
    duringForkDispatch = async () => {
      const ordinal = dispatchOrdinal++;
      if (ordinal === 0) await releaseFirst.promise;
      else if (ordinal === 1) await releaseSecond.promise;
    };
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    try {
      first = pi.fire("input", {
        text: "/scoped-fork /deny-once", source: "rpc", streamingBehavior: undefined,
      }, ctx);
      await sdk.waitForPromptCalls(promptBaseline + 1);
      second = pi.fire("input", {
        text: "/scoped-fork /staged-deny second", source: "rpc", streamingBehavior: undefined,
      }, ctx);
      await sdk.waitForPromptCalls(promptBaseline + 2);

      releaseFirst.resolve();
      await expect(first).resolves.toMatchObject({ action: "transform" });
      releaseSecond.resolve();
      await expect(second).resolves.toMatchObject({ action: "transform" });

      const prompt = (await pi.fire("before_agent_start", { systemPrompt: "BASE" }, ctx)).systemPrompt as string;
      expect(prompt).toContain("Deny once.");
      expect(prompt).toContain("Staged deny: second");
      expect(await pi.fire("tool_call", {
        toolName: "bash", toolCallId: "older-run-deny", input: { command: "blocked-now" },
      }, ctx)).toBeUndefined();
      expect(await pi.fire("tool_call", {
        toolName: "bash", toolCallId: "latest-run-deny", input: { command: "staged-now" },
      }, ctx)).toMatchObject({ block: true });
      expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(2);

      const beforeGlobalDispatch = sdk.promptCalls();
      await expect(pi.tools.get("Agent").execute("concurrent-hook-global-proof", {
        subagent_type: "general-purpose",
        prompt: "prove one globally installed scoped hook",
        run_in_background: false,
      })).resolves.toMatchObject({ content: [expect.objectContaining({ type: "text" })] });
      expect(sdk.promptCalls()).toBe(beforeGlobalDispatch + 1);
      expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(3);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      if (first) await first.catch(() => undefined);
      if (second) await second.catch(() => undefined);
      duringForkDispatch = undefined;
      fs.rmSync(marker, { force: true });
    }
  });

  it("keeps prior skill controls while a staged slash skill races settled-fallback custody", async () => {
    await mainCheckpointGate.startSession("settled-fallback-input");
    const priorCtx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    });
    await pi.fire("input", {
      text: "/deny-once", source: "interactive", streamingBehavior: undefined,
    }, priorCtx);
    expect(await pi.fire("tool_call", {
      toolName: "bash", toolCallId: "prior-before-race", input: { command: "blocked-now" },
    }, priorCtx)).toMatchObject({ block: true });
    pi.entries.length = 0;
    pi.compactCalls.length = 0;
    const hookEntered = deferred<void>();
    const releaseHook = deferred<void>();
    const releaseCompaction = deferred<void>();
    const originalFire = inputHooks.fire.bind(inputHooks);
    let hookCalls = 0;
    let input: Promise<unknown> | undefined;
    let settlement: Promise<unknown> | undefined;
    inputHooks.fire = async (...args: any[]) => {
      if (args[0] === "UserPromptSubmit") {
        hookCalls += 1;
        hookEntered.resolve();
        await releaseHook.promise;
      }
      return originalFire(...args);
    };
    pi.editorText = "";
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      compact: (options: any) => {
        pi.compactCalls.push(options);
        void (async () => {
          const before = await pi.fire("session_before_compact", {
            reason: "manual", customInstructions: undefined,
          }, ctx);
          if (before?.cancel) return options.onError(new Error("cancelled"));
          await releaseCompaction.promise;
          await pi.fire("session_compact", {
            reason: "manual", compactionEntry: { summary: "fallback summary" },
          }, ctx);
          options.onComplete({ summary: "fallback summary" });
        })();
      },
    });
    try {
      input = pi.fire("input", {
        text: "/staged-deny original request", source: "interactive", streamingBehavior: undefined,
      }, ctx);
      await hookEntered.promise;
      settlement = pi.fire("agent_settled", {}, ctx);
      await waitUntil({
        description: "settled fallback compaction",
        predicate: () => pi.compactCalls.length > 0,
      });
      releaseHook.resolve();
      await expect(input).resolves.toEqual({ action: "handled" });
      expect(hookCalls).toBe(1);
      expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([]);
      expect(pi.entries.filter((entry) =>
        entry.data.category === "checkpoint-input-recovery")).toHaveLength(1);
      expect(pi.entries).toContainEqual(expect.objectContaining({
        customType: "picc-checkpoint-lifecycle",
        data: expect.objectContaining({ category: "checkpoint-input-recovery", count: 1 }),
      }));
      expect(await pi.fire("tool_call", {
        toolName: "bash", toolCallId: "prior-after-race", input: { command: "blocked-now" },
      }, ctx)).toMatchObject({ block: true });
      expect(await pi.fire("tool_call", {
        toolName: "bash", toolCallId: "staged-after-race", input: { command: "staged-now" },
      }, ctx)).toBeUndefined();
      expect(pi.entries.find((entry) => entry.data.category === "checkpoint-input-recovery")?.data)
        .toMatchObject({ count: 1, restoredTextCount: 1 });
      expect(pi.editorText).toBe("/staged-deny original request\n");
    } finally {
      releaseHook.resolve();
      releaseCompaction.resolve();
      if (input) await input.catch(() => undefined);
      if (settlement) await settlement.catch(() => undefined);
      inputHooks.fire = originalFire;
      pi.editorText = "";
    }
  });

  it("routes a pipeline throw through live closed-state rejection after the prompt hook", async () => {
    await mainCheckpointGate.startSession("closed-prompt-hook-input");
    pi.entries.length = 0;
    pi.compactCalls.length = 0;
    const hookEntered = deferred<void>();
    const releaseHook = deferred<void>();
    const originalFire = inputHooks.fire.bind(inputHooks);
    const stopMarker = path.join(dir, ".claude", ".session-stop");
    let hookCalls = 0;
    let input: Promise<unknown> | undefined;
    let settlement: Promise<unknown> | undefined;
    inputHooks.fire = async (...args: any[]) => {
      if (args[0] === "UserPromptSubmit") {
        hookCalls += 1;
        hookEntered.resolve();
        await releaseHook.promise;
        throw new Error("pipeline failed after lifecycle rejection");
      }
      return originalFire(...args);
    };
    fs.writeFileSync(stopMarker, "stop after commit");
    let ctx: any;
    ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      compact: (options: any) => {
        pi.compactCalls.push(options);
        void (async () => {
          const before = await pi.fire("session_before_compact", { reason: "manual" }, ctx);
          if (before?.cancel) return options.onError(new Error("cancelled"));
          await pi.fire("session_compact", {
            reason: "manual", compactionEntry: { summary: "committed while hook waited" },
          }, ctx);
          options.onComplete({ summary: "committed while hook waited" });
        })();
      },
    });
    try {
      input = pi.fire("input", {
        text: "arrived before terminal close", source: "interactive", streamingBehavior: undefined,
      }, ctx);
      await hookEntered.promise;
      settlement = pi.fire("agent_settled", {}, ctx);
      await settlement;
      expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
      });
      releaseHook.resolve();
      await expect(input).resolves.toEqual({ action: "handled" });
      expect(hookCalls).toBe(1);
      expect(pi.entries.filter((entry) =>
        entry.data.category === "checkpoint-input-recovery")).toHaveLength(1);
      expect(pi.entries.find((entry) => entry.data.category === "checkpoint-input-recovery")?.data)
        .toMatchObject({ count: 1 });
      expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([]);
    } finally {
      releaseHook.resolve();
      if (input) await input.catch(() => undefined);
      if (settlement) await settlement.catch(() => undefined);
      inputHooks.fire = originalFire;
      fs.rmSync(stopMarker, { force: true });
    }
  });

  it("awaits callback compaction, hidden resume, replay, and nested settlement", async () => {
    await mainCheckpointGate.startSession("main-resume");
    pi.messages.length = 0;
    pi.userMessages.length = 0;
    const order: string[] = [];
    const stopAdmissionResults: Array<Promise<unknown>> = [];
    const staleStopInput = deferred<void>();
    let capturedStaleStopInput = false;
    const originalSendMessage = pi.api.sendMessage as (...args: any[]) => void;
    const originalSendUserMessage = pi.api.sendUserMessage as (...args: any[]) => void;
    pi.api.sendMessage = (message: any, options: any) => {
      order.push(message.customType);
      originalSendMessage(message, options);
    };
    let high: any;
    pi.api.sendUserMessage = (content: any, options: any) => {
      order.push("user-replay");
      originalSendUserMessage(content, options);
      if (typeof content !== "string" || !content.startsWith("[Stop hook]")) {
        void pi.fire("message_start", {
          message: { role: "user", content: typeof content === "string" ? [{ type: "text", text: content }] : content },
          delivery: options?.deliverAs,
        }, high);
        return;
      }
      if (!capturedStaleStopInput) {
        capturedStaleStopInput = true;
        stopAdmissionResults.push(staleStopInput.promise.then(() => pi.fire("input", {
          text: content, source: "extension", images: undefined, streamingBehavior: undefined,
        }, high)));
      }
      stopAdmissionResults.push(pi.fire("input", {
        text: content, source: "extension", images: undefined, streamingBehavior: undefined,
      }, high));
      // A second exact occurrence cannot consume the one-shot capability again.
      stopAdmissionResults.push(pi.fire("input", {
        text: content, source: "extension", images: undefined, streamingBehavior: undefined,
      }, high));
    };
    try {
      high = pi.printCtx({
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        compact: (options: any) => {
          pi.compactCalls.push(options);
          void (async () => {
            const before = await pi.fire("session_before_compact", {
              reason: "manual", customInstructions: undefined,
            }, high);
            if (before?.cancel) options.onError(new Error("cancelled"));
            else {
              await pi.fire("session_compact", {
                reason: "manual", compactionEntry: { summary: "summary" },
              }, high);
              options.onComplete({ summary: "summary" });
            }
          })();
        },
      });
      const trace = path.join(dir, ".claude", ".compact-trace");
      const inputHookCount = path.join(dir, "input-hook-count");
      fs.rmSync(trace, { force: true });
      fs.rmSync(inputHookCount, { force: true });
      mainCheckpointGate.assistantMessageEnded({
        role: "assistant",
        content: [{ type: "toolCall", id: "tool", name: "probe", arguments: {} }],
      });
      const wrapped = mainCheckpointGate.wrapTool({
        name: "probe",
        execute: async () => ({ content: [{ type: "text", text: "done" }] }),
      }) as any;
      const result = await wrapped.execute("tool", {}, undefined, undefined, high);
      mainCheckpointGate.toolExecutionEnded({ toolCallId: "tool", result, isError: false });
      expect(mainCheckpointGate.turnEnded(high)?.stop).toBe("terminate");
      const controller = mainCheckpointGate.currentController();
      const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
      mainCheckpointGate.captureAcceptedInput(high, "queued after checkpoint", undefined, "steer");
      mainCheckpointGate.captureAcceptedInput(high, "duplicate", undefined, "followUp");
      mainCheckpointGate.captureAcceptedInput(high, "duplicate", [image], "steer");

      let outerDone = false;
      const outer = pi.fire("agent_settled", {}, high).then(() => { outerDone = true; });
      await waitUntil({
        description: "hidden checkpoint continuation",
        predicate: () => pi.messages.some((entry) => entry.message.customType === "picc-checkpoint-continuation"),
      });
      expect(outerDone).toBe(false);
      const hidden = pi.messages.find((entry) => entry.message.customType === "picc-checkpoint-continuation")!;
      expect(hidden.message).toMatchObject({ content: "Continue the paused work.", display: false });
      expect(hidden.options).toEqual({ triggerTurn: true });
      expect(order.indexOf("picc-checkpoint-continuation")).toBeLessThan(order.indexOf("user-replay"));
      expect(pi.userMessages.slice(-3)).toEqual([
        { content: "queued after checkpoint", options: { deliverAs: "steer" } },
        { content: "duplicate", options: { deliverAs: "followUp" } },
        { content: [{ type: "text", text: "duplicate" }, image], options: { deliverAs: "steer" } },
      ]);

      const stopMarker = path.join(dir, ".claude", "block-stop");
      // Same guard as the other hook markers: a surviving `block-stop` makes later
      // Stop hooks in this file block with a continuation instead of settling.
      fs.writeFileSync(stopMarker, "block");
      try {
        const predictableContinuation = "[Stop hook] Continue working: continue test work";
        await expect(pi.fire("input", {
          text: predictableContinuation, source: "extension", images: undefined, streamingBehavior: undefined,
        }, high)).resolves.toEqual({ action: "handled" });
        for (let iteration = 1; iteration <= 8; iteration += 1) {
          await pi.fire("agent_settled", {}, high);
          expect(outerDone).toBe(false);
          expect(String(pi.userMessages.at(-1)?.content)).toContain("[Stop hook] Continue working");
        }
        // The ninth logical stop attempt exhausts the eight-continuation bound.
        await pi.fire("agent_settled", {}, high);
      } finally {
        fs.rmSync(stopMarker, { force: true });
      }
      await outer;
      await mainCheckpointGate.startSession("stop-admission-stale-epoch");
      staleStopInput.resolve();
      const admission = await Promise.all(stopAdmissionResults);
      expect(admission.filter((result) => (result as any)?.action === "continue")).toHaveLength(8);
      expect(admission.filter((result) => (result as any)?.action === "handled")).toHaveLength(9);
      expect(outerDone).toBe(true);
      expect(fs.existsSync(inputHookCount)).toBe(false);
      expect(controller.snapshot().phase).toBe("idle");
      expect(fs.readFileSync(trace, "utf8").trim().split(/\r?\n/)).toEqual([
        "pre", "start", "post", "pre", "start", "post",
      ]);
    } finally {
      pi.api.sendMessage = originalSendMessage;
      pi.api.sendUserMessage = originalSendUserMessage;
    }
  });

  it("bridges a successful resumed print result exactly once and hides every unsafe settlement", async () => {
    const runResume = async (
      sessionId: string,
      mode: "print" | "json" | "rpc",
      message: Record<string, unknown>,
    ) => {
      await mainCheckpointGate.startSession(sessionId);
      let resumedMessageVisible = false;
      let stopOnTerminalRead = false;
      let stoppedResumeObserved = false;
      const ctx = pi.ctx({
        mode,
        hasUI: mode === "rpc",
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => {
          if (stopOnTerminalRead && !stoppedResumeObserved) {
            const stoppedController = mainCheckpointGate.currentController();
            const stoppedGeneration = stoppedController.snapshot().generation;
            stoppedResumeObserved = mainCheckpointGate.captureLogicalRunStop()();
            expect(stoppedResumeObserved).toBe(true);
            expect(mainCheckpointGate.stoppedRunWasResuming(stoppedController, stoppedGeneration)).toBe(true);
          }
          return resumedMessageVisible ? [{ type: "message", message }] : [];
        } },
        compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
      });
      mainCheckpointGate.assistantMessageEnded({
        role: "assistant",
        content: [{ type: "toolCall", id: sessionId, name: "probe", arguments: {} }],
      });
      const wrapped: any = mainCheckpointGate.wrapTool({
        name: "probe",
        execute: async () => ({ content: [{ type: "text", text: "tool complete" }] }),
      });
      const result = await wrapped.execute(sessionId, {}, undefined, undefined, ctx);
      mainCheckpointGate.toolExecutionEnded({ toolCallId: sessionId, result, isError: false });
      mainCheckpointGate.turnEnded(ctx);
      const outer = pi.fire("agent_settled", {}, ctx);
      await waitUntil({
        description: `${sessionId} resumed settlement`,
        predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming",
      });
      resumedMessageVisible = true;
      stopOnTerminalRead = sessionId === "print-pending";
      await pi.fire("agent_settled", {}, { ...ctx });
      await outer;
      if (["pending", "error", "aborted"].includes(String(message.stopReason))) {
        const controller = mainCheckpointGate.currentController();
        expect(controller.snapshot()).toMatchObject({
          phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
        });
        expect(controller.recoveryToken(controller.snapshot().generation)).toBeUndefined();
        expect(controller.manualCompactionDisposition()).toBe("unavailable");
        expect(mainCheckpointGate.isLogicalRunStopped()).toBe(false);
        if (sessionId === "print-pending") expect(stoppedResumeObserved).toBe(true);
      }
    };

    const writes: string[] = [];
    const originalWrite = fs.write.bind(fs);
    const writeSpy = vi.spyOn(fs, "write").mockImplementation(((fd: any, data: any, offset: any, length: any, position: any, callback: any) => {
      if (fd === process.stdout.fd && Buffer.isBuffer(data)) {
        writes.push(data.subarray(offset, offset + length).toString("utf8"));
        queueMicrotask(() => callback(null, length, data));
        return;
      }
      return originalWrite(fd, data, offset, length, position, callback);
    }) as typeof fs.write);
    pi.messages.length = 0;
    try {
      await runResume("print-safe", "print", {
        role: "assistant",
        content: [
          { type: "text", text: "resumed one" },
          { type: "image", data: "not printable" },
          { type: "text", text: "resumed two" },
        ],
        stopReason: "stop",
      });
      await runResume("print-error", "print", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thinking-secret-sentinel C:/private/transcript.jsonl" },
          { type: "text", text: "unsafe error secret-sentinel C:/private/transcript.jsonl" },
        ],
        stopReason: "error",
      });
      await runResume("print-aborted", "print", {
        role: "assistant", content: [{ type: "text", text: "unsafe aborted" }], stopReason: "aborted",
      });
      await runResume("print-pending", "print", {
        role: "assistant", content: [{ type: "text", text: "unsafe incomplete pending" }], stopReason: "pending",
      });
      await runResume("json-safe", "json", {
        role: "assistant", content: [{ type: "text", text: "machine result" }], stopReason: "stop",
      });
    } finally {
      writeSpy.mockRestore();
    }

    expect(writes).toEqual(["resumed one\nresumed two\n"]);
    expect(writes.join("\n")).not.toMatch(/thinking|secret-sentinel|private|transcript|incomplete pending/);
    expect(pi.messages.filter((entry) => entry.message.customType === "picc-checkpoint-print-result"))
      .toHaveLength(1);
  });

  it("re-authenticates after a gated Stop hook and suppresses a cancelled stale print result", async () => {
    await mainCheckpointGate.startSession("cancel-during-stop");
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "STALE_THINKING_SECRET" },
        { type: "text", text: "STALE_RESULT_SECRET C:/private/session.jsonl" },
      ],
      stopReason: "stop",
    };
    const ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [{ type: "message", message }] },
      compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
    });
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant", content: [{ type: "toolCall", id: "cancel-tool", name: "probe", arguments: {} }],
    });
    const wrapped: any = mainCheckpointGate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const toolResult = await wrapped.execute("cancel-tool", {}, undefined, undefined, ctx);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: "cancel-tool", result: toolResult, isError: false });
    mainCheckpointGate.turnEnded(ctx);
    const markerCountBefore = pi.messages.filter((entry) => entry.message.customType === "picc-checkpoint-print-result").length;
    const outer = pi.fire("agent_settled", {}, ctx);
    await waitUntil({ description: "cancel test resume", predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming" });
    const staleWrites: string[] = [];
    const originalWrite = fs.write.bind(fs);
    const gate = path.join(dir, ".claude", "gate-stop");
    const entered = path.join(dir, ".claude", "stop-entered");
    const release = path.join(dir, ".claude", "release-stop");
    let nested: Promise<unknown> | undefined;
    const writeSpy = vi.spyOn(fs, "write").mockImplementation(((fd: any, data: any, offset: any, length: any, position: any, callback: any) => {
      if (fd === process.stdout.fd && Buffer.isBuffer(data)) {
        staleWrites.push(data.subarray(offset, offset + length).toString("utf8"));
        queueMicrotask(() => callback(null, length, data));
        return;
      }
      return originalWrite(fd, data, offset, length, position, callback);
    }) as typeof fs.write);

    try {
      fs.writeFileSync(gate, "gate");
      nested = pi.fire("agent_settled", {}, { ...ctx });
      await waitUntil({ description: "Stop hook gate entry", predicate: () => fs.existsSync(entered) });
      const replacement = mainCheckpointGate.startSession("replacement-during-stop");
      fs.writeFileSync(release, "release");
      await nested;
      await replacement;
      await outer;
    } finally {
      // None of this may depend on the awaits above succeeding. The spy is global, and a
      // surviving `gate-stop` parks every later Stop hook in the hook script's polling
      // loop for the full hook timeout — that live `sh` child is also what makes the
      // afterAll rmSync of the fixture directory fail on Windows. The one ordering
      // constraint the statements below do not show: `release` must be written before the
      // join, or the gated hook never exits and `await nested` never completes.
      writeSpy.mockRestore();
      fs.writeFileSync(release, "release");
      await nested?.catch(() => undefined);
      for (const file of [gate, entered, release]) fs.rmSync(file, { force: true });
    }

    expect(staleWrites).toEqual([]);
    expect(pi.messages.filter((entry) => entry.message.customType === "picc-checkpoint-print-result")).toHaveLength(markerCountBefore);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
  });

  it("unwinds a resumed Stop universal stop before joining its exact resume settlement", async () => {
    await mainCheckpointGate.startSession("resumed-stop-deadlock");
    const marker = path.join(dir, ".claude", "universal-stop");
    // The marker arms every Stop hook in the fixture, so the guard has to start here:
    // anything between writing it and the awaits below can throw, and a surviving
    // marker universally stops the Stop lifecycle for the rest of the worker.
    fs.writeFileSync(marker, "stop");
    try {
      const ctx = pi.printCtx({
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => [] },
        compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
      });
      mainCheckpointGate.assistantMessageEnded({
        role: "assistant", content: [{ type: "toolCall", id: "stop-tool", name: "probe", arguments: {} }],
      });
      const wrapped: any = mainCheckpointGate.wrapTool({
        name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
      });
      const toolResult = await wrapped.execute("stop-tool", {}, undefined, undefined, ctx);
      mainCheckpointGate.toolExecutionEnded({ toolCallId: "stop-tool", result: toolResult, isError: false });
      mainCheckpointGate.turnEnded(ctx);
      const outer = pi.fire("agent_settled", {}, ctx);
      await waitUntil({
        description: "resumed Stop deadlock setup",
        predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming",
      });
      await pi.fire("agent_settled", {}, ctx);
      await outer;
    } finally {
      fs.rmSync(marker, { force: true });
    }
    expect(mainCheckpointGate.isLogicalRunStopped()).toBe(false);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
  });

  /**
   * Drives one proactive checkpoint through the registered handlers until the resumed
   * run exists and is waiting for its physical turn. The returned promise is the
   * settling `agent_settled` handler parked on the generation barrier — exactly where
   * real Pi parks it, inside the `_runAgentPrompt` finally that owns the user's run.
   */
  const driveResumeToResuming = async (sessionId: string, ctx: any): Promise<{ outer: Promise<unknown> }> => {
    await mainCheckpointGate.startSession(sessionId);
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant",
      content: [{ type: "toolCall", id: sessionId, name: "probe", arguments: {} }],
    });
    const wrapped: any = mainCheckpointGate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const result = await wrapped.execute(sessionId, {}, undefined, undefined, ctx);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: sessionId, result, isError: false });
    mainCheckpointGate.turnEnded(ctx);
    const outer = pi.fire("agent_settled", {}, ctx);
    await waitUntil({
      description: `${sessionId} resumed generation`,
      predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming",
    });
    return { outer };
  };

  /**
   * A print-mode context whose `compact` completes the transaction directly. It never
   * fires `session_compact`, so `observeCompactionCommit` never runs and the
   * controller's `committedGeneration` stays unset — a cancellation reached from here
   * therefore classifies as an ordinary cancellation, where production (having seen
   * the commit) would terminalize as `restoration-paused`. The resume endings below
   * do not depend on that: resume is structurally post-commit, so they carry their
   * own post-commit category rather than inferring one from the controller.
   */
  const resumeCtx = (overrides: Record<string, unknown> = {}) => pi.printCtx({
    model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
    getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
    abort: () => undefined,
    ...overrides,
  });

  it("recovers only an authenticated resumed cancellation and restores exact TUI queue order without replay", async () => {
    let branch: any[] = [];
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
      compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
      abort: () => undefined,
    });
    await mainCheckpointGate.startSession("authenticated-resumed-cancel");
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant",
      content: [{ type: "toolCall", id: "cancel-tool", name: "probe", arguments: {} }],
    });
    const wrapped: any = mainCheckpointGate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const result = await wrapped.execute("cancel-tool", {}, undefined, undefined, ctx);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: "cancel-tool", result, isError: false });
    mainCheckpointGate.turnEnded(ctx);
    // Interleaved acceptance and reverse host starts still authenticate Pi's native
    // steering FIFO before follow-up FIFO, retaining equal occurrences exactly.
    mainCheckpointGate.captureAcceptedInput(ctx, "follow-first", undefined, "followUp");
    mainCheckpointGate.captureAcceptedInput(ctx, "/same", undefined, "steer");
    mainCheckpointGate.captureAcceptedInput(ctx, "/same", undefined, "followUp");
    mainCheckpointGate.captureAcceptedInput(ctx, "steer-last", undefined, "steer");
    const messagesBaseline = pi.messages.length;
    const outer = pi.fire("agent_settled", {}, ctx);
    await waitUntil({
      description: "authenticated resumed cancellation trigger",
      predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming",
    });
    const checkpointHostMessages = pi.messages.slice(messagesBaseline).filter((entry) =>
      ["picc-hook-context", "picc-preserved", "picc-checkpoint-continuation"]
        .includes(entry.message.customType));
    const trigger = checkpointHostMessages.filter((entry) =>
      entry.message.customType === "picc-checkpoint-continuation").at(-1)!.message;
    await pi.fire("message_start", { message: { ...trigger, details: undefined } }, ctx);
    await pi.fire("message_start", { message: { ...trigger, details: { ...trigger.details } } }, ctx);
    await pi.fire("message_start", { message: { ...trigger, details: {} } }, ctx);
    for (const entry of [...checkpointHostMessages].reverse()) {
      // Native Pi reconstructs the outer message but preserves the intended details value.
      await pi.fire("message_start", {
        message: { ...entry.message, details: entry.message.details },
      }, ctx);
    }
    await pi.fire("message_start", { message: { ...trigger, details: trigger.details } }, ctx);
    pi.editorText = "/same\n\nsteer-last\n\nfollow-first\n\n/same\n\nexisting draft";
    const aborted = {
      role: "assistant", content: [{ type: "text", text: "partial effect" }], stopReason: "aborted",
    };
    await pi.fire("message_end", { message: aborted }, ctx);
    branch = [{ type: "message", message: aborted }];
    await pi.fire("agent_settled", {}, ctx);
    await outer;

    expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
      phase: "idle", admission: "open",
    });
    expect(pi.editorText).toBe("/same\n\nsteer-last\n\nfollow-first\n\n/same\n\nexisting draft");
    expect(pi.userMessages.filter((entry) => entry.content === "/same")).toHaveLength(2);
    expect(pi.messages.slice(messagesBaseline).filter((entry) =>
      entry.message.customType === "picc-checkpoint-continuation")).toHaveLength(1);
    expect(pi.entries.find((entry) => entry.customType === "picc-checkpoint-retained-input")?.data)
      .toMatchObject({ stage: "resumed-cancellation", restoredTextCount: 4, nonTextCount: 0 });
    const recovery = pi.entries.filter((entry) => entry.data.action === "session-reusable");
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.data).toMatchObject({
      stage: "resumed-cancellation", restoredCount: 4, reportedCount: 0, unresolvedCount: 0, nonTextCount: 0,
    });
    expect(String(recovery[0]?.data.notice)).toContain("No additional continuation or retained-input replay was started after cancellation");
    expect(String(recovery[0]?.data.notice)).not.toContain("/compact");
    expect(pi.entries.map((entry) => JSON.stringify(entry.data)).join("\n"))
      .toContain("Inspect possible existing files, tools, and external effects");
  });

  it("does not claim a stopped TUI editor during committed resumed-cancellation quit", async () => {
    let branch: any[] = [];
    const setEditorText = vi.fn();
    const errors: string[] = [];
    let ctx: any;
    ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
      compact: (options: any) => queueMicrotask(async () => {
        await pi.fire("session_before_compact", { reason: "manual" }, ctx);
        await pi.fire("session_compact", { reason: "manual", summary: "ok" }, ctx);
        options.onComplete({ summary: "ok" });
      }),
      abort: () => undefined,
    });
    ctx.ui.getEditorText = () => "retained on stopped editor";
    ctx.ui.setEditorText = setEditorText;
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      pi.entries.length = 0;
      await mainCheckpointGate.startSession("quit-resumed-cancel");
      mainCheckpointGate.assistantMessageEnded({
        role: "assistant",
        content: [{ type: "toolCall", id: "quit-tool", name: "probe", arguments: {} }],
      });
      const wrapped: any = mainCheckpointGate.wrapTool({
        name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
      });
      const result = await wrapped.execute("quit-tool", {}, undefined, undefined, ctx);
      mainCheckpointGate.toolExecutionEnded({ toolCallId: "quit-tool", result, isError: false });
      mainCheckpointGate.turnEnded(ctx);
      mainCheckpointGate.captureAcceptedInput(ctx, "retained on stopped editor", undefined, "followUp");
      const baseline = pi.messages.length;
      const outer = pi.fire("agent_settled", {}, ctx);
      await waitUntil({
        description: "quit resumed cancellation trigger",
        predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming",
      });
      const checkpointMessages = pi.messages.slice(baseline).filter((entry) =>
        ["picc-hook-context", "picc-preserved", "picc-checkpoint-continuation"]
          .includes(entry.message.customType));
      for (const entry of checkpointMessages) {
        await pi.fire("message_start", {
          message: { ...entry.message, details: entry.message.details },
        }, ctx);
      }

      const shutdown = pi.fire("session_shutdown", { reason: "quit" }, ctx);
      await waitUntil({
        description: "quit resumed-cancellation request",
        predicate: () => mainCheckpointGate.currentController().snapshot().phase === "terminalizing",
      });
      const aborted = {
        role: "assistant", content: [{ type: "text", text: "partial effect" }], stopReason: "aborted",
      };
      await pi.fire("message_end", { message: aborted }, ctx);
      branch = [{ type: "message", message: aborted }];
      const finalSettlement = pi.fire("agent_settled", {}, ctx);
      await Promise.all([shutdown, finalSettlement, outer]);
    } finally {
      errorSpy.mockRestore();
    }

    expect(setEditorText).not.toHaveBeenCalled();
    expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
      phase: "exhausted", failureCategory: "restoration-paused", stage: "resumed-cancellation",
    });
    const terminal = pi.entries.filter((entry) =>
      entry.customType === "picc-checkpoint-lifecycle" && entry.data.category === "checkpoint-cancelled");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.data).toMatchObject({
      action: "retrieve-and-relaunch", stage: "resumed-cancellation",
      retainedInputSource: "client/request history",
    });
    expect(String(terminal[0]?.data.notice)).toMatch(/session became non-reusable.*deliberate resubmission in a fresh request\/session/isu);
    expect(pi.entries.some((entry) => entry.data.action === "session-reusable")).toBe(false);
    expect(process.exitCode).toBe(3);
    expect(errors.join("\n")).not.toContain("could not confirm host quiescence");
    expect(errors.join("\n")).toMatch(/durable retained-input locator.*continues.*may be lost/iu);
    await pi.fire("session_start", { reason: "startup" }, ctx);
  });

  it.each([
    { mode: "print", retainedReportFailure: false },
    { mode: "json", retainedReportFailure: false },
    { mode: "rpc", retainedReportFailure: false },
    { mode: "rpc", retainedReportFailure: true },
  ] as const)(
    "keeps only TUI reusable after authenticated resumed cancellation in $mode mode (report failure: $retainedReportFailure)",
    async ({ mode, retainedReportFailure }) => {
      const savedExitCode = process.exitCode;
      process.exitCode = undefined;
      let branch: any[] = [];
      let providerAborts = 0;
      let retainedReportAttempts = 0;
      const extension = pi;
      const originalAppendEntry = extension.api.appendEntry as (customType: string, data: unknown) => void;
      if (retainedReportFailure) {
        extension.api.appendEntry = (customType: string, data: unknown) => {
          if (customType === "picc-checkpoint-retained-input") {
            retainedReportAttempts += 1;
            throw new Error("retained report unavailable");
          }
          originalAppendEntry(customType, data);
        };
      }
      const sessionFile = path.join(dir, `retained-main-${mode}.jsonl`);
      const base = {
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: {
          getBranch: () => branch,
          getSessionFile: () => sessionFile,
        },
        compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
        abort: () => { providerAborts += 1; },
      };
      const ctx = mode === "rpc" ? pi.rpcCtx(base)
        : mode === "json" ? pi.printCtx({ ...base, mode: "json" }) : pi.printCtx(base);
      try {
        await pi.fire("session_start", { reason: "startup" }, ctx);
        await mainCheckpointGate.startSession(`cancel-${mode}`);
        mainCheckpointGate.assistantMessageEnded({
          role: "assistant", content: [{ type: "toolCall", id: `tool-${mode}`, name: "probe", arguments: {} }],
        });
        const wrapped: any = mainCheckpointGate.wrapTool({
          name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
        });
        const result = await wrapped.execute(`tool-${mode}`, {}, undefined, undefined, ctx);
        mainCheckpointGate.toolExecutionEnded({ toolCallId: `tool-${mode}`, result, isError: false });
        mainCheckpointGate.turnEnded(ctx);
        mainCheckpointGate.captureAcceptedInput(ctx, `retained-${mode}`, [
          { type: "image", data: `image-${mode}`, mimeType: "image/png" },
        ], "followUp");
        pi.entries.length = 0;
        const baseline = pi.messages.length;
        const outer = pi.fire("agent_settled", {}, ctx);
        await waitUntil({
          description: `${mode} resumed cancellation trigger`,
          predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming",
        });
        const trigger = pi.messages.slice(baseline).find((entry) =>
          entry.message.customType === "picc-checkpoint-continuation")!.message;
        await pi.fire("message_start", {
          message: { ...trigger, details: trigger.details },
        }, ctx);
        const aborted = { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" };
        await pi.fire("message_end", { message: aborted }, ctx);
        branch = [{ type: "message", message: aborted }];
        await pi.fire("agent_settled", {}, ctx);
        await outer;

        expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
          phase: "exhausted", admission: "closed",
          queuedInputs: retainedReportFailure ? 1 : 0,
          failureCategory: mode === "rpc" ? "restart-required" : "restoration-paused",
          stage: "resumed-cancellation",
        });
        const lifecycleRecords = pi.entries.filter((entry) =>
          entry.customType === "picc-checkpoint-lifecycle" && entry.data.category === "checkpoint-cancelled");
        const retainedRecords = pi.entries.filter((entry) =>
          entry.customType === "picc-checkpoint-retained-input");
        expect(lifecycleRecords).toHaveLength(1);
        expect(retainedRecords).toHaveLength(retainedReportFailure ? 0 : 1);
        if (!retainedReportFailure) {
          expect(retainedRecords[0]?.data).toMatchObject({ nonTextCount: 1 });
        }
        expect(retainedReportAttempts).toBe(retainedReportFailure ? 1 : 0);
        const lifecycle = lifecycleRecords[0]?.data;
        expect(lifecycle).toMatchObject({
          action: mode === "rpc" ? "restart-process" : "retrieve-and-relaunch",
          stage: "resumed-cancellation", restoredCount: 0,
          reportedCount: retainedReportFailure ? 0 : 1,
          unresolvedCount: retainedReportFailure ? 1 : 0, nonTextCount: 1,
          retainedInputSource: "client/request history",
        });
        expect(String(lifecycle?.notice)).toContain("client/request history");
        expect(String(lifecycle?.notice)).not.toContain(sessionFile);
        expect(String(lifecycle?.notice)).not.toContain("with custom type picc-checkpoint-retained-input");
        if (!retainedReportFailure) {
          expect(String(retainedRecords[0]?.data.notice)).toContain("non-locator hint");
        }
        expect(process.exitCode).toBe(3);
        if (mode === "rpc") {
          expect(String(lifecycle?.notice)).toContain("terminate PiCC and start a fresh process and fresh session");
          expect(String(lifecycle?.notice)).toContain("native queued input may already have produced later turns");
          expect(String(lifecycle?.notice)).not.toContain("No additional continuation or retained-input replay");
          if (retainedReportFailure) {
            expect(String(lifecycle?.notice)).toContain("1 unresolved");
            expect(String(lifecycle?.notice)).toContain("Recover retained input from client/request history");
            expect(String(lifecycle?.notice)).not.toContain("client/request history and the retained-input record");
          } else {
            expect(String(retainedRecords[0]?.data.notice)).toContain("do not resubmit in this RPC session");
          }
          expect(pi.entries.some((entry) => entry.data.action === "session-reusable")).toBe(false);
          const hostMessagesBeforePrompt = pi.messages.length;
          const userMessagesBeforePrompt = pi.userMessages.length;
          await expect(pi.fire("input", {
            text: "later RPC prompt", source: "rpc", streamingBehavior: undefined,
          }, ctx)).resolves.toEqual({ action: "handled" });
          const abortsBeforeProvider = providerAborts;
          await pi.fire("before_provider_request", {}, ctx);
          expect(providerAborts).toBe(abortsBeforeProvider + 1);
          expect(pi.messages).toHaveLength(hostMessagesBeforePrompt);
          expect(pi.userMessages).toHaveLength(userMessagesBeforePrompt);
          expect(process.exitCode).toBe(3);
          expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
            phase: "exhausted", admission: "closed", failureCategory: "restart-required",
          });
          expect(mainCheckpointGate.currentController().isProcessTerminal()).toBe(true);
          expect(pi.entries.some((entry) => entry.data.action === "session-reusable")).toBe(false);

          await expect(pi.fire("session_before_switch", {}, ctx)).resolves.toEqual({ cancel: true });
          const switchRefusal = pi.entries.find((entry) =>
            entry.data.category === "checkpoint-session-switch-refused");
          expect(switchRefusal?.data).toMatchObject({ action: "restart-process" });
          expect(String(switchRefusal?.data.notice)).toContain("fresh process and fresh session");
          expect(String(switchRefusal?.data.notice)).not.toContain("could not confirm");

          for (const reason of ["new", "resume", "fork", "reload"] as const) {
            await expect(pi.fire("session_start", { reason }, ctx))
              .rejects.toThrow(/fresh process and fresh session/u);
          }
          expect(pi.entries.filter((entry) =>
            entry.data.category === "checkpoint-session-start-refused")).toHaveLength(4);
          expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
            phase: "exhausted", failureCategory: "restart-required",
          });
          await expect(pi.fire("session_shutdown", { reason: "quit" }, ctx)).resolves.toBeUndefined();
          extension.api.appendEntry = originalAppendEntry;
          // The remaining cases model later processes in this long-lived fake extension owner.
          await installFreshExtension();
        }
      } finally {
        extension.api.appendEntry = originalAppendEntry;
        process.exitCode = savedExitCode;
      }
    },
  );

  it("sets status 3 without claiming reusable RPC when terminal resumed-cancellation mode is unreadable", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    let branch: any[] = [];
    let modeReadable = true;
    const ctx = resumeCtx({ sessionManager: { getBranch: () => branch } });
    Object.defineProperty(ctx, "mode", {
      configurable: true,
      get: () => {
        if (!modeReadable) throw new Error("stale terminal context");
        return "rpc";
      },
    });
    try {
      await pi.fire("session_start", { reason: "startup" }, ctx);
      pi.entries.length = 0;
      const baseline = pi.messages.length;
      const { outer } = await driveResumeToResuming("unreadable-terminal-mode", ctx);
      const trigger = pi.messages.slice(baseline).find((entry) =>
        entry.message.customType === "picc-checkpoint-continuation")!.message;
      await pi.fire("message_start", { message: { ...trigger, details: trigger.details } }, ctx);
      const aborted = {
        role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted",
      };
      await pi.fire("message_end", { message: aborted }, ctx);
      branch = [{ type: "message", message: aborted }];
      modeReadable = false;
      await pi.fire("agent_settled", {}, ctx);
      await outer;

      expect(process.exitCode).toBe(3);
      const terminal = pi.entries.filter((entry) =>
        entry.customType === "picc-checkpoint-lifecycle" &&
        entry.data.category === "checkpoint-cancelled");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.data).toMatchObject({
        action: "restart-process", stage: "resumed-cancellation",
        retainedInputSource: "client/request history",
      });
      expect(String(terminal[0]?.data.notice)).toContain("terminate PiCC and start a fresh process and fresh session");
      expect(terminal.some((entry) => entry.data.action === "session-reusable")).toBe(false);
      expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restart-required",
      });
      expect(mainCheckpointGate.currentController().isProcessTerminal()).toBe(true);

      const hostMessages = pi.messages.length;
      const userMessages = pi.userMessages.length;
      await expect(pi.fire("input", { text: "later unreadable RPC prompt", source: "rpc" }, ctx))
        .resolves.toEqual({ action: "handled" });
      expect(pi.messages).toHaveLength(hostMessages);
      expect(pi.userMessages).toHaveLength(userMessages);
      await expect(pi.fire("session_before_switch", {}, ctx)).resolves.toEqual({ cancel: true });
      for (const reason of ["new", "resume", "fork", "reload"] as const) {
        await expect(pi.fire("session_start", { reason }, ctx)).rejects.toThrow(/fresh process and fresh session/u);
      }
      expect(pi.entries.filter((entry) => entry.data.category === "checkpoint-session-start-refused")).toHaveLength(4);
      await expect(pi.fire("session_shutdown", { reason: "quit" }, ctx)).resolves.toBeUndefined();
      await installFreshExtension();
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it.each([
    { mode: "print" }, { mode: "json" },
  ] as const)(
    "keeps a stale known non-RPC terminal mode non-RPC ($mode)",
    async ({ mode }) => {
      let branch: any[] = [];
      let modeReadable = true;
      const ctx = resumeCtx({ sessionManager: { getBranch: () => branch } });
      Object.defineProperty(ctx, "mode", {
        configurable: true,
        get: () => {
          if (!modeReadable) throw new Error("unreadable mode");
          return mode;
        },
      });
      try {
        await pi.fire("session_start", { reason: "startup" }, ctx);
        pi.entries.length = 0;
        const baseline = pi.messages.length;
        const { outer } = await driveResumeToResuming(`non-rpc-${mode}`, ctx);
        const trigger = pi.messages.slice(baseline).find((entry) =>
          entry.message.customType === "picc-checkpoint-continuation")!.message;
        await pi.fire("message_start", { message: { ...trigger, details: trigger.details } }, ctx);
        const aborted = {
          role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted",
        };
        await pi.fire("message_end", { message: aborted }, ctx);
        branch = [{ type: "message", message: aborted }];
        modeReadable = false;
        await pi.fire("agent_settled", {}, ctx);
        await outer;

        const terminal = pi.entries.filter((entry) =>
          entry.customType === "picc-checkpoint-lifecycle" && entry.data.category === "checkpoint-cancelled");
        expect(terminal).toHaveLength(1);
        expect(terminal[0]?.data).toMatchObject({
          action: "retrieve-and-relaunch",
          retainedInputSource: "client/request history",
        });
        expect(String(terminal[0]?.data.notice)).not.toContain("live RPC recovery is unsupported");
        expect(String(terminal[0]?.data.notice)).not.toContain("fresh process and fresh session");
        expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
          phase: "exhausted", failureCategory: "restoration-paused", stage: "resumed-cancellation",
        });
        expect(mainCheckpointGate.currentController().isProcessTerminal()).toBe(false);
      } finally {
        await installFreshExtension();
      }
    },
  );

  it("completes unknown-mode resumed cancellation without inferring RPC", async () => {
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    let branch: any[] = [];
    const ctx = resumeCtx({ sessionManager: { getBranch: () => branch } });
    Object.defineProperty(ctx, "mode", {
      configurable: true,
      get: () => { throw new Error("mode unavailable"); },
    });
    try {
      pi.entries.length = 0;
      await expect(pi.fire("session_start", { reason: "startup" }, ctx)).resolves.toBeUndefined();
      const baseline = pi.messages.length;
      const { outer } = await driveResumeToResuming("unknown-mode-resumed-cancel", ctx);
      const trigger = pi.messages.slice(baseline).find((entry) =>
        entry.message.customType === "picc-checkpoint-continuation")!.message;
      await pi.fire("message_start", { message: { ...trigger, details: trigger.details } }, ctx);
      const aborted = {
        role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted",
      };
      await pi.fire("message_end", { message: aborted }, ctx);
      branch = [{ type: "message", message: aborted }];
      await pi.fire("agent_settled", {}, ctx);
      await outer;

      const terminal = pi.entries.filter((entry) =>
        entry.customType === "picc-checkpoint-lifecycle" &&
        entry.data.category === "checkpoint-cancelled");
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.data).toMatchObject({
        action: "retrieve-and-relaunch", stage: "resumed-cancellation",
        failureCategory: "restoration-paused", retainedInputSource: "client/request history",
      });
      expect(String(terminal[0]?.data.notice)).toContain("session became non-reusable");
      expect(String(terminal[0]?.data.notice)).not.toContain("live RPC recovery is unsupported");
      expect(String(terminal[0]?.data.notice)).not.toContain("terminate PiCC and start a fresh process and fresh session");
      expect(pi.entries.some((entry) => entry.data.action === "restart-process")).toBe(false);
      expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
        stage: "resumed-cancellation",
      });
      expect(mainCheckpointGate.currentController().isProcessTerminal()).toBe(false);
      expect(process.exitCode).toBe(3);
    } finally {
      await installFreshExtension();
      process.exitCode = savedExitCode;
    }
  });

  it("does not carry an RPC mode latch into an accepted successor session", async () => {
    let branch: any[] = [];
    const rpc = resumeCtx({ mode: "rpc", sessionManager: { getBranch: () => branch } });
    let successorReadable = true;
    const successor = resumeCtx({ sessionManager: { getBranch: () => branch } });
    Object.defineProperty(successor, "mode", {
      configurable: true,
      get: () => {
        if (!successorReadable) throw new Error("successor mode unavailable");
        return "print";
      },
    });
    try {
      await pi.fire("session_start", { reason: "startup" }, rpc);
      await expect(pi.fire("session_before_switch", {}, rpc)).resolves.toBeUndefined();
      await pi.fire("session_start", { reason: "new" }, successor);
      pi.entries.length = 0;
      const baseline = pi.messages.length;
      const { outer } = await driveResumeToResuming("successor-without-rpc-latch", successor);
      const trigger = pi.messages.slice(baseline).find((entry) =>
        entry.message.customType === "picc-checkpoint-continuation")!.message;
      await pi.fire("message_start", { message: { ...trigger, details: trigger.details } }, successor);
      successorReadable = false;
      const aborted = {
        role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted",
      };
      await pi.fire("message_end", { message: aborted }, successor);
      branch = [{ type: "message", message: aborted }];
      await pi.fire("agent_settled", {}, successor);
      await outer;

      const terminal = pi.entries.find((entry) =>
        entry.customType === "picc-checkpoint-lifecycle" && entry.data.category === "checkpoint-cancelled");
      expect(terminal?.data).toMatchObject({
        action: "retrieve-and-relaunch", retainedInputSource: "client/request history",
      });
      expect(String(terminal?.data.notice)).not.toContain("live RPC recovery is unsupported");
      expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
        failureCategory: "restoration-paused", stage: "resumed-cancellation",
      });
    } finally {
      successorReadable = true;
      await installFreshExtension();
    }
  });

  it("fails closed when aborted terminal evidence is not the selected branch object", async () => {
    let branch: any[] = [];
    const ctx = resumeCtx({ sessionManager: { getBranch: () => branch } });
    pi.entries.length = 0;
    const baseline = pi.messages.length;
    const { outer } = await driveResumeToResuming("mismatched-aborted-branch", ctx);
    const trigger = pi.messages.slice(baseline).find((entry) =>
      entry.message.customType === "picc-checkpoint-continuation")!.message;
    await pi.fire("message_start", { message: { ...trigger, details: trigger.details } }, ctx);
    const observed = { role: "assistant", content: [{ type: "text", text: "observed" }], stopReason: "aborted" };
    const selected = { role: "assistant", content: [{ type: "text", text: "selected" }], stopReason: "aborted" };
    await pi.fire("message_end", { message: observed }, ctx);
    branch = [{ type: "message", message: selected }];
    await pi.fire("agent_settled", {}, ctx);
    await outer;

    expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
      phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
    });
    expect(pi.entries.filter((entry) =>
      entry.customType === "picc-checkpoint-lifecycle" &&
      entry.data.category === "checkpoint-cancelled" && entry.data.action === "session-reusable"))
      .toHaveLength(0);
  });

  it("does not claim reusable custody when editor and retained-report sinks fail", async () => {
    let branch: any[] = [];
    let editorAttempts = 0;
    let reportAttempts = 0;
    const ctx: any = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
      compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
      abort: () => undefined,
    });
    ctx.ui.getEditorText = () => "retained-without-sink";
    ctx.ui.setEditorText = () => { editorAttempts++; throw new Error("editor unavailable"); };
    const originalAppendEntry = pi.api.appendEntry;
    pi.api.appendEntry = (customType: string) => {
      if (customType === "picc-checkpoint-retained-input") reportAttempts++;
      throw new Error("report unavailable");
    };
    try {
      await mainCheckpointGate.startSession("failed-custody-sinks");
      mainCheckpointGate.assistantMessageEnded({
        role: "assistant", content: [{ type: "toolCall", id: "sink-tool", name: "probe", arguments: {} }],
      });
      const wrapped: any = mainCheckpointGate.wrapTool({
        name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
      });
      const result = await wrapped.execute("sink-tool", {}, undefined, undefined, ctx);
      mainCheckpointGate.toolExecutionEnded({ toolCallId: "sink-tool", result, isError: false });
      mainCheckpointGate.turnEnded(ctx);
      mainCheckpointGate.captureAcceptedInput(ctx, "retained-without-sink", undefined, "followUp");
      const baseline = pi.messages.length;
      const outer = pi.fire("agent_settled", {}, ctx);
      await waitUntil({
        description: "failed-sink resumed generation",
        predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming",
      });
      const checkpointMessages = pi.messages.slice(baseline).filter((entry) =>
        ["picc-hook-context", "picc-preserved", "picc-checkpoint-continuation"]
          .includes(entry.message.customType));
      for (const entry of checkpointMessages) {
        await pi.fire("message_start", { message: { ...entry.message, details: entry.message.details } }, ctx);
      }
      const aborted = { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" };
      await pi.fire("message_end", { message: aborted }, ctx);
      branch = [{ type: "message", message: aborted }];
      await pi.fire("agent_settled", {}, ctx);
      await outer;
    } finally {
      pi.api.appendEntry = originalAppendEntry;
    }

    expect({ editorAttempts, reportAttempts }).toEqual({ editorAttempts: 1, reportAttempts: 1 });
    expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
      phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
    });
    expect(pi.entries.some((entry) => entry.data.action === "session-reusable")).toBe(false);
  });

  it("keeps TUI preparation transient without adding a resumed-success record", async () => {
    let percent = 90;
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: percent * 10, contextWindow: 1000, percent }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
      abort: () => undefined,
    });
    await pi.fire("session_start", { reason: "startup" }, ctx);
    pi.entries.length = 0;
    pi.notifications.length = 0;
    pi.statusCalls.length = 0;
    const { outer } = await driveResumeToResuming("tui-resumed-presentation", ctx);
    percent = 10;
    await pi.fire("agent_settled", {}, ctx);
    await outer;

    expect(pi.notifications).toContainEqual({
      text: "Context checkpoint queued; waiting for safe settlement.",
      severity: "info",
    });
    expect(pi.notifications.some((notification) =>
      notification.text === "Context compacted; resumed the paused work.")).toBe(false);
    expect(pi.entries.filter((entry) => entry.customType === "picc-proactive-compact")).toEqual([]);
    expect(pi.messages.some((message) => message.message.customType === "picc-proactive-compact")).toBe(false);
    expect(pi.statusCalls.filter((call) => call.key === "picc-checkpoint" && call.text !== undefined)).toEqual([]);
  });

  it("keeps TUI preparation failure presentation-only while resumed work settles", async () => {
    let percent = 90;
    let notifyAttempts = 0;
    const ctx: any = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: percent * 10, contextWindow: 1000, percent }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
      abort: () => undefined,
    });
    ctx.ui.notify = () => {
      notifyAttempts += 1;
      throw new Error("renderer unavailable");
    };
    await pi.fire("session_start", { reason: "startup" }, ctx);
    pi.entries.length = 0;
    pi.messages.length = 0;
    pi.notifications.length = 0;
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const { outer } = await driveResumeToResuming("tui-throwing-preparation", ctx);
      percent = 10;
      await pi.fire("agent_settled", {}, ctx);
      await outer;
    } finally {
      errorSpy.mockRestore();
    }

    expect(notifyAttempts).toBe(1);
    expect(errors).toEqual([]);
    expect(pi.messages.filter((entry) =>
      entry.message.customType === "picc-checkpoint-continuation")).toEqual([
      {
        message: expect.objectContaining({
          customType: "picc-checkpoint-continuation",
          content: "Continue the paused work.",
          display: false,
          details: expect.any(Object),
        }),
        options: { triggerTurn: true },
      },
    ]);
    expect(mainCheckpointGate.currentController().snapshot())
      .toMatchObject({ phase: "idle", admission: "open" });
    expect(mainCheckpointGate.currentController().ordinaryInputDisposition()).toBe("accept");
    expect(pi.notifications).toEqual([]);
    expect(pi.entries.filter((entry) => entry.customType === "picc-proactive-compact")).toEqual([]);
  });

  it.each(["print", "json", "rpc"] as const)(
    "preserves the exact resumed success contract in %s mode",
    async (mode) => {
      let percent = 90;
      const base = {
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: percent * 10, contextWindow: 1000, percent }),
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => [] },
        compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
        abort: () => undefined,
      };
      const ctx = mode === "print" ? pi.printCtx(base)
        : mode === "rpc" ? pi.rpcCtx(base) : pi.printCtx({ ...base, mode: "json" });
      await pi.fire("session_start", { reason: "startup" }, ctx);
      pi.entries.length = 0;
      pi.notifications.length = 0;
      pi.statusCalls.length = 0;
      const errors: string[] = [];
      let generation = -1;
      const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
      try {
        const { outer } = await driveResumeToResuming(`${mode}-resumed-contract`, ctx);
        generation = mainCheckpointGate.currentController().snapshot().generation;
        percent = 10;
        await pi.fire("agent_settled", {}, ctx);
        await outer;
      } finally {
        errorSpy.mockRestore();
      }

      const lifecycle = pi.entries.filter((entry) => entry.customType === "picc-checkpoint-lifecycle");
      const presentation = pi.entries.filter((entry) => entry.customType === "picc-proactive-compact");
      if (mode === "print") {
        expect(errors).toEqual([
          "PiCC: Context checkpoint queued; waiting for safe settlement.",
          "PiCC: Context compacted; reconnecting the paused work.",
          "PiCC: Context compacted; resumed the paused work.",
        ]);
        expect(lifecycle).toEqual([]);
      } else {
        expect(errors).toEqual([]);
        expect(lifecycle.map((entry) => entry.data)).toEqual([
          {
            category: "checkpoint-armed",
            generation,
            notice: "Context checkpoint queued; waiting for safe settlement.",
          },
          {
            category: "checkpoint-complete",
            generation,
            action: "resume",
            notice: "Context compacted; reconnecting the paused work.",
          },
          {
            category: "checkpoint-resumed",
            generation,
            notice: "Context compacted; resumed the paused work.",
          },
        ]);
      }
      expect(presentation).toEqual([]);
      expect(pi.notifications).toEqual([]);
      expect(pi.statusCalls.filter((call) => call.key === "picc-checkpoint" && call.text !== undefined)).toEqual([]);
    },
  );

  it("leaves settled-fallback success to Pi's native compaction card", async () => {
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
    });
    await pi.fire("session_start", { reason: "startup" }, ctx);
    pi.entries.length = 0;
    pi.notifications.length = 0;

    await pi.fire("agent_settled", {}, ctx);

    expect(pi.notifications).toContainEqual({
      text: "Context checkpoint starting from the settled fallback.", severity: "info",
    });
    expect(pi.entries.filter((entry) => entry.customType === "picc-proactive-compact")).toEqual([]);
  });

  it.each([
    ["info", "dim"], ["warning", "warning"], ["error", "error"],
  ] as const)("renders %s checkpoint entries as unboxed fully wrapped chat rows", (severity, color) => {
    const renderer = pi.entryRenderers.get("picc-proactive-compact");
    expect(renderer).toBeDefined();
    const roles: string[] = [];
    const component = renderer!(
      { data: { notice: "alpha beta gamma", severity } },
      { expanded: false },
      { fg: (role: string, text: string) => { roles.push(role); return text; } },
    );

    const lines = component.render(6);
    expect(roles).toEqual([color]);
    expect(lines).toEqual(["alpha", "beta", "gamma"]);
    expect(lines.join(" ")).not.toContain("PiCC proactive compaction");
  });

  it("awaits Stop admission, refuses duplicates, and preserves ordinary descendant error handling", async () => {
    const marker = path.join(dir, ".claude", "block-stop");
    const originalSendUserMessage = pi.api.sendUserMessage as (...args: any[]) => void;
    const sent = deferred<void>();
    const results: unknown[] = [];
    const ctx = resumeCtx();
    const recoveryEntriesBefore = pi.entries
      .filter((entry) => entry.data.category === "checkpoint-input-recovery").length;
    let sendReturned = false;
    let admissionObservedAfterReturn = false;
    let admissionTask: Promise<void> | undefined;
    pi.api.sendUserMessage = (content: any, options: any) => {
      originalSendUserMessage(content, options);
      if (typeof content !== "string" || !content.startsWith("[Stop hook]")) return;
      admissionTask = Promise.resolve().then(async () => {
        admissionObservedAfterReturn = sendReturned;
        results.push(await pi.fire("input", {
          text: content, source: "extension", images: undefined, streamingBehavior: undefined,
        }, ctx));
        const disposition = vi.spyOn(mainCheckpointGate, "ordinaryInputDisposition");
        disposition.mockImplementationOnce(() => { throw new Error("ordinary input failed"); });
        try {
          results.push(await pi.fire("input", {
            text: "unrelated descendant extension input", source: "extension",
            images: undefined, streamingBehavior: undefined,
          }, ctx));
        } finally {
          disposition.mockRestore();
        }
        results.push(await pi.fire("input", {
          text: content, source: "extension", images: undefined, streamingBehavior: undefined,
        }, ctx));
      });
      sendReturned = true;
      sent.resolve();
    };
    let outer: Promise<unknown> | undefined;
    let nested: Promise<unknown> | undefined;
    fs.writeFileSync(marker, "block");
    try {
      ({ outer } = await driveResumeToResuming("stop-continuation-async-admission", ctx));
      vi.useFakeTimers();
      nested = pi.fire("agent_settled", {}, ctx);
      await sent.promise;
      await nested;
      await admissionTask;
      expect(admissionObservedAfterReturn).toBe(true);
      expect(results).toEqual([
        { action: "continue" },
        { action: "handled" },
        { action: "handled" },
      ]);
      expect(pi.entries
        .filter((entry) => entry.data.category === "checkpoint-input-recovery").slice(recoveryEntriesBefore))
        .toEqual([expect.objectContaining({ data: expect.objectContaining({ count: 1 }) })]);
      expect(mainCheckpointGate.currentController().snapshot().phase).toBe("resuming");
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      fs.rmSync(marker, { force: true });
      await pi.fire("agent_settled", {}, ctx);
      await outer;
      expect(mainCheckpointGate.currentController().snapshot())
        .toMatchObject({ phase: "idle", admission: "open" });
    } finally {
      vi.useRealTimers();
      pi.api.sendUserMessage = originalSendUserMessage;
      fs.rmSync(marker, { force: true });
      for (const pending of [nested, outer, admissionTask]) void pending?.catch(() => undefined);
    }
  });

  it.each([
    ["malformed", (): any => null],
    ["throwing", (): any => ({
      source: "extension",
      get text(): string { throw new Error("event text failed"); },
    })],
  ] as const)(
    "refuses a %s Stop-continuation event through the handler catch without waiting for timeout",
    async (ending, inputEvent) => {
      const marker = path.join(dir, ".claude", "block-stop");
      const originalSendUserMessage = pi.api.sendUserMessage as (...args: any[]) => void;
      const sent = deferred<void>();
      const ctx = resumeCtx();
      let admission: Promise<unknown> | undefined;
      pi.api.sendUserMessage = (content: any, options: any) => {
        originalSendUserMessage(content, options);
        if (typeof content !== "string" || !content.startsWith("[Stop hook]")) return;
        admission = pi.fire("input", inputEvent(), ctx);
        sent.resolve();
      };
      let outer: Promise<unknown> | undefined;
      let nested: Promise<unknown> | undefined;
      fs.writeFileSync(marker, "block");
      try {
        ({ outer } = await driveResumeToResuming(`stop-continuation-event-${ending}`, ctx));
        vi.useFakeTimers();
        nested = pi.fire("agent_settled", {}, ctx);
        await sent.promise;
        expect(admission).toBeDefined();
        await expect(admission!).resolves.toEqual({ action: "handled" });
        expect(vi.getTimerCount()).toBe(0);
        await nested;
        await outer;
        expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
          phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
        });
      } finally {
        vi.useRealTimers();
        pi.api.sendUserMessage = originalSendUserMessage;
        fs.rmSync(marker, { force: true });
        for (const pending of [admission, nested, outer]) void pending?.catch(() => undefined);
      }
    },
  );

  it.each(["throw", "reject"] as const)(
    "fails a %s Stop-continuation send closed and clears its admission timer",
    async (ending) => {
      const marker = path.join(dir, ".claude", "block-stop");
      const originalSendUserMessage = pi.api.sendUserMessage as (...args: any[]) => void;
      const ctx = resumeCtx();
      pi.api.sendUserMessage = (content: any, options: any) => {
        originalSendUserMessage(content, options);
        if (typeof content !== "string" || !content.startsWith("[Stop hook]")) return;
        if (ending === "throw") throw new Error("send failed");
        return Promise.reject(new Error("send rejected"));
      };
      let outer: Promise<unknown> | undefined;
      fs.writeFileSync(marker, "block");
      try {
        ({ outer } = await driveResumeToResuming(`stop-continuation-send-${ending}`, ctx));
        vi.useFakeTimers();
        await pi.fire("agent_settled", {}, ctx);
        await outer;
        expect(vi.getTimerCount()).toBe(0);
        expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
          phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
        });
      } finally {
        vi.useRealTimers();
        pi.api.sendUserMessage = originalSendUserMessage;
        fs.rmSync(marker, { force: true });
        void outer?.catch(() => undefined);
      }
    },
  );

  it("times out Stop-continuation admission and refuses its late exact occurrence", async () => {
    const marker = path.join(dir, ".claude", "block-stop");
    const originalSendUserMessage = pi.api.sendUserMessage as (...args: any[]) => void;
    const releaseLate = deferred<void>();
    const sent = deferred<void>();
    const ctx = resumeCtx();
    let lateAdmission: Promise<unknown> | undefined;
    pi.api.sendUserMessage = (content: any, options: any) => {
      originalSendUserMessage(content, options);
      if (typeof content !== "string" || !content.startsWith("[Stop hook]")) return;
      lateAdmission = releaseLate.promise.then(() => pi.fire("input", {
        text: content, source: "extension", images: undefined, streamingBehavior: undefined,
      }, ctx));
      sent.resolve();
    };
    let outer: Promise<unknown> | undefined;
    let nested: Promise<unknown> | undefined;
    let restoreTimeoutSpy: (() => void) | undefined;
    fs.writeFileSync(marker, "block");
    try {
      ({ outer } = await driveResumeToResuming("stop-continuation-admission-timeout", ctx));
      vi.useFakeTimers();
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      restoreTimeoutSpy = () => timeoutSpy.mockRestore();
      nested = pi.fire("agent_settled", {}, ctx);
      await sent.promise;
      const deadlineIndex = timeoutSpy.mock.calls.findIndex((args) => args[1] === 1_000);
      const deadline = timeoutSpy.mock.results[deadlineIndex]?.value as
        | { hasRef?: () => boolean }
        | undefined;
      expect(deadline?.hasRef?.()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_001);
      await nested;
      await outer;
      expect(vi.getTimerCount()).toBe(0);
      expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
      });
      releaseLate.resolve();
      await expect(lateAdmission).resolves.toEqual({ action: "handled" });
      expect(mainCheckpointGate.currentController().ordinaryInputDisposition()).not.toBe("accept");
    } finally {
      releaseLate.resolve();
      restoreTimeoutSpy?.();
      vi.useRealTimers();
      pi.api.sendUserMessage = originalSendUserMessage;
      fs.rmSync(marker, { force: true });
      for (const pending of [nested, outer, lateAdmission]) void pending?.catch(() => undefined);
    }
  });

  it("abandons a resumed run when PiCC's own admission refuses its Stop continuation", async () => {
    const marker = path.join(dir, ".claude", "block-stop");
    const originalSendUserMessage = pi.api.sendUserMessage as (...args: any[]) => void;
    const admissions: Array<Promise<unknown>> = [];
    const ctx = resumeCtx();
    // This fake delivers admission synchronously to isolate PiCC's shape-mismatch
    // refusal. Throw, rejection, and timeout endings have separate owners above.
    pi.api.sendUserMessage = (content: any, options: any) => {
      originalSendUserMessage(content, options);
      if (typeof content !== "string" || !content.startsWith("[Stop hook]")) return;
      admissions.push(pi.fire("input", {
        text: content, source: "extension", images: undefined, streamingBehavior: "followUp",
      }, ctx));
    };
    let outer: Promise<unknown> | undefined;
    let nested: Promise<unknown> | undefined;
    fs.writeFileSync(marker, "block");
    try {
      ({ outer } = await driveResumeToResuming("stop-continuation-refused", ctx));
      const stranded = mainCheckpointGate.currentController();
      const generation = stranded.snapshot().generation;
      const printMarkersBefore = pi.messages
        .filter((entry) => entry.message.customType === "picc-checkpoint-print-result").length;
      const entriesBefore = pi.entries.length;

      nested = pi.fire("agent_settled", {}, ctx);
      await settlement(nested, { description: "the refused continuation's settlement handler" });
      await expect(nested).resolves.toBeUndefined();
      await settlement(outer, { description: "the checkpoint generation barrier" });
      await expect(outer).resolves.toBeUndefined();

      expect(await Promise.all(admissions)).toEqual([{ action: "handled" }]);
      expect(stranded.snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
      });
      expect(stranded.recoveryToken(generation)).toBeUndefined();
      expect(stranded.manualCompactionDisposition()).toBe("unavailable");
      expect(pi.entries.slice(entriesBefore)
        .filter((entry) => entry.data.category === "checkpoint-exhausted")
        .map((entry) => entry.data))
        .toEqual([expect.objectContaining({ action: "new-session", failureCategory: "restoration-paused" })]);
      // Success is never claimed for work that was not delivered.
      expect(pi.messages.filter((entry) => entry.message.customType === "picc-checkpoint-print-result"))
        .toHaveLength(printMarkersBefore);
      // A later provider request must not park on the abandoned run's barrier.
      await expect(pi.fire("turn_start", {}, ctx)).resolves.toBeUndefined();

      const replacement = mainCheckpointGate.startSession("after-refused-continuation");
      await settlement(replacement, { description: "a replacement session after the abandoned resume" });
      await expect(replacement).resolves.toBeUndefined();
      expect(mainCheckpointGate.currentController().snapshot())
        .toMatchObject({ phase: "idle", admission: "open" });
    } finally {
      pi.api.sendUserMessage = originalSendUserMessage;
      fs.rmSync(marker, { force: true });
      // Absorb rejections without joining: a product hang must still report through
      // the settlement ceilings above rather than through this finally.
      for (const pending of [nested, outer, ...admissions]) void pending?.catch(() => undefined);
    }
  });

  it("ends a resumed run whose admitted Stop continuation never starts a turn", async () => {
    const marker = path.join(dir, ".claude", "block-stop");
    const originalSendUserMessage = pi.api.sendUserMessage as (...args: any[]) => void;
    const admissions: Array<Promise<unknown>> = [];
    const ctx = resumeCtx();
    // PiCC admits the continuation, and then Pi never starts the turn — no model,
    // expired credentials, or a pre-turn throw, all of which Pi swallows and none of
    // which PiCC can see. Nothing further ever arrives for this run.
    pi.api.sendUserMessage = (content: any, options: any) => {
      originalSendUserMessage(content, options);
      if (typeof content !== "string" || !content.startsWith("[Stop hook]")) return;
      admissions.push(pi.fire("input", {
        text: content, source: "extension", images: undefined, streamingBehavior: undefined,
      }, ctx));
    };
    let outer: Promise<unknown> | undefined;
    let nested: Promise<unknown> | undefined;
    fs.writeFileSync(marker, "block");
    try {
      ({ outer } = await driveResumeToResuming("stop-continuation-dropped", ctx));
      const stranded = mainCheckpointGate.currentController();
      const generation = stranded.snapshot().generation;
      const entriesBefore = pi.entries.length;

      nested = pi.fire("agent_settled", {}, ctx);
      await settlement(nested, { description: "the handed-off continuation's settlement handler" });
      await expect(nested).resolves.toBeUndefined();
      expect(await Promise.all(admissions)).toEqual([{ action: "continue" }]);
      // The continuation was admitted, so nothing observable distinguishes this from
      // a turn that is about to start. The run is still open at this point.
      expect(stranded.snapshot().phase).toBe("resuming");

      const switching = pi.fire("session_before_switch", {}, ctx);
      await settlement(switching, { description: "the session switch behind the dropped continuation" });
      await expect(switching).resolves.toBeUndefined();
      await settlement(outer, { description: "the checkpoint generation barrier" });
      await expect(outer).resolves.toBeUndefined();

      expect(stranded.snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
      });
      expect(stranded.recoveryToken(generation)).toBeUndefined();
      expect(stranded.manualCompactionDisposition()).toBe("unavailable");
      expect(pi.entries.slice(entriesBefore)
        .filter((entry) => entry.data.category === "checkpoint-exhausted")
        .map((entry) => entry.data))
        .toEqual([expect.objectContaining({ action: "new-session", failureCategory: "restoration-paused" })]);
      await expect(pi.fire("turn_start", {}, ctx)).resolves.toBeUndefined();

      // The switch rotated the checkpoint session epoch. Every settlement path in the
      // agent_settled handler is keyed on that epoch, so a resume surviving the
      // rotation could no longer be ended by the lifecycle event that normally ends
      // it; the replacement below is what proves nothing was left holding the gate.
      await pi.fire("session_start", { reason: "switch" }, ctx);
      expect(mainCheckpointGate.currentController()).not.toBe(stranded);
      expect(mainCheckpointGate.currentController().snapshot())
        .toMatchObject({ phase: "idle", admission: "open" });
      const replacement = mainCheckpointGate.startSession("after-dropped-continuation");
      await settlement(replacement, { description: "a replacement session after the dropped continuation" });
      await expect(replacement).resolves.toBeUndefined();
    } finally {
      pi.api.sendUserMessage = originalSendUserMessage;
      fs.rmSync(marker, { force: true });
      for (const pending of [nested, outer, ...admissions]) void pending?.catch(() => undefined);
    }
  });

  it("settles a resumed run against the terminalization that is joining it", async () => {
    const gate = path.join(dir, ".claude", "gate-stop");
    const block = path.join(dir, ".claude", "block-stop");
    const entered = path.join(dir, ".claude", "stop-entered");
    const release = path.join(dir, ".claude", "release-stop");
    const ctx = resumeCtx();
    let outer: Promise<unknown> | undefined;
    let nested: Promise<unknown> | undefined;
    let terminal: Promise<unknown> | undefined;
    // Blocking, not merely slow: a Stop hook that blocks is the ordinary Claude
    // configuration, and it is what makes the handler take its continuation exit —
    // the exit that has to hand its settlement over to the terminalization racing it.
    fs.writeFileSync(gate, "gate");
    fs.writeFileSync(block, "block");
    try {
      ({ outer } = await driveResumeToResuming("resume-phase-mismatch", ctx));
      const stranded = mainCheckpointGate.currentController();
      const generation = stranded.snapshot().generation;
      const continuations = () => pi.userMessages
        .filter((entry) => typeof entry.content === "string" && entry.content.startsWith("[Stop hook]")).length;
      const continuationsBefore = continuations();

      nested = pi.fire("agent_settled", {}, ctx);
      await waitUntil({ description: "Stop hook gate entry", predicate: () => fs.existsSync(entered) });
      // A post-commit failure terminalizes while that handler is still inside the
      // Stop hook. Terminalization joins the resumed run's settlement, and the
      // handler is about to find the phase past `resuming` — the mutual wait.
      let terminalDone = false;
      terminal = stranded.failAfterCommittedSummary(generation).then((rejected) => {
        terminalDone = true;
        return rejected;
      });
      await Promise.resolve();
      expect(terminalDone).toBe(false);
      expect(stranded.snapshot().phase).toBe("terminalizing");

      fs.writeFileSync(release, "release");
      await settlement(nested, { description: "the settlement handler that lost its phase" });
      await expect(nested).resolves.toBeUndefined();
      await settlement(terminal, { description: "the terminalization joining that handler" });
      await expect(terminal).resolves.toEqual([]);
      await settlement(outer, { description: "the checkpoint generation barrier" });
      await expect(outer).resolves.toBeUndefined();

      // The hook really blocked: a continuation went out, so the handler took the
      // exit that owes the settlement rather than the plain "run finished" one.
      expect(continuations()).toBe(continuationsBefore + 1);
      expect(stranded.snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
      });
      expect(stranded.recoveryToken(generation)).toBeUndefined();
      await expect(pi.fire("turn_start", {}, ctx)).resolves.toBeUndefined();
      const replacement = mainCheckpointGate.startSession("after-phase-mismatch");
      await settlement(replacement, { description: "a replacement session after the phase mismatch" });
      await expect(replacement).resolves.toBeUndefined();
    } finally {
      // `release` has to exist before the join, or the gated hook child never exits.
      // Only the gated handler is joined; joining the barrier promises would turn a
      // described ceiling failure into an opaque runner timeout.
      fs.writeFileSync(release, "release");
      await nested?.catch(() => undefined);
      for (const pending of [terminal, outer]) void pending?.catch(() => undefined);
      for (const file of [gate, block, entered, release]) fs.rmSync(file, { force: true });
    }
  });

  it("releases a provider request parked on the resumed barrier when the run ends", async () => {
    const originalSendUserMessage = pi.api.sendUserMessage as (...args: any[]) => void;
    let latched: Promise<unknown> | undefined;
    let aborts = 0;
    const ctx = resumeCtx({ abort: () => { aborts += 1; } });
    // Replay runs before replayComplete opens the barrier, so this is the one window
    // where a provider request genuinely parks in defensiveLatch. Ending the run from
    // inside it is what a user pressing Esc mid-replay does.
    pi.api.sendUserMessage = (content: any, options: any) => {
      originalSendUserMessage(content, options);
      if (latched || content !== "retained while resuming") return;
      latched = pi.fire("turn_start", {}, ctx);
      const controller = mainCheckpointGate.currentController();
      void controller.cancel(controller.snapshot().generation, "user").catch(() => undefined);
    };
    let outer: Promise<unknown> | undefined;
    let nested: Promise<unknown> | undefined;
    try {
      await mainCheckpointGate.startSession("resume-barrier-release");
      mainCheckpointGate.assistantMessageEnded({
        role: "assistant",
        content: [{ type: "toolCall", id: "barrier", name: "probe", arguments: {} }],
      });
      const wrapped: any = mainCheckpointGate.wrapTool({
        name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
      });
      const result = await wrapped.execute("barrier", {}, undefined, undefined, ctx);
      mainCheckpointGate.toolExecutionEnded({ toolCallId: "barrier", result, isError: false });
      mainCheckpointGate.turnEnded(ctx);
      mainCheckpointGate.captureAcceptedInput(ctx, "retained while resuming", undefined, "followUp");
      const stranded = mainCheckpointGate.currentController();
      outer = pi.fire("agent_settled", {}, ctx);
      await waitUntil({ description: "a provider request parked on the resumed barrier", predicate: () => latched !== undefined });

      await settlement(latched!, { description: "the parked provider request" });
      await expect(latched).resolves.toBeUndefined();
      // The ending revoked the turn rather than admitting it.
      expect(aborts).toBeGreaterThan(0);
      expect(stranded.snapshot().phase).not.toBe("resuming");

      nested = pi.fire("agent_settled", {}, ctx);
      await settlement(nested, { description: "the cancelled run's settlement handler" });
      await expect(nested).resolves.toBeUndefined();
      await settlement(outer, { description: "the checkpoint generation barrier" });
      await expect(outer).resolves.toBeUndefined();
      expect(stranded.snapshot()).toMatchObject({ phase: "cancelled", admission: "closed" });

      const replacement = mainCheckpointGate.startSession("after-barrier-release");
      await settlement(replacement, { description: "a replacement session after the released barrier" });
      await expect(replacement).resolves.toBeUndefined();
    } finally {
      pi.api.sendUserMessage = originalSendUserMessage;
      for (const pending of [latched, nested, outer]) void pending?.catch(() => undefined);
    }
  });

  /**
   * Arms one checkpoint generation through the registered handlers and stops there. Only
   * `agent_settled` hands a generation to the controller's run, so this reaches every
   * ending a *transition* decides without starting a host transaction — and therefore
   * without the fixture's real hook children. `session_start` is fired rather than calling
   * the gate directly so `sessionManagerRef` is this context's, which decides whether the
   * headless recovery guidance names a persisted session or calls the session ephemeral.
   */
  const armCheckpoint = async (
    ctx: any,
    id: string,
    queued?: string,
    checkpointAbortRequested = false,
    sendGuardContext = false,
  ) => {
    await pi.fire("session_start", { reason: "new" }, ctx);
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "probe", arguments: {} }],
      usage: {
        input: 900, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 900,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }, ctx);
    let guardContext: Record<string, unknown> | undefined;
    if (sendGuardContext) {
      const nested = path.join(dir, "guard-context");
      const baseline = pi.messages.length;
      await pi.fire("tool_call", {
        toolName: "read", toolCallId: id, input: { path: path.join(nested, "target.txt") },
      }, ctx);
      guardContext = pi.messages.slice(baseline)
        .find((entry) => entry.message.customType === "picc-context")?.message;
      expect(guardContext).toBeDefined();
      expect(guardContext?.details).toBeTypeOf("object");
    }
    const wrapped: any = mainCheckpointGate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const result = await wrapped.execute(id, {}, undefined, undefined, ctx);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: id, result, isError: checkpointAbortRequested });
    mainCheckpointGate.turnEnded(ctx, ctx.mode);
    if (queued !== undefined) mainCheckpointGate.captureAcceptedInput(ctx, queued, undefined, "followUp");
    const controller = mainCheckpointGate.currentController();
    expect(controller.snapshot()).toMatchObject({
      phase: "awaiting-settlement",
      checkpointAbortRequested,
      queuedInputs: queued === undefined ? 0 : 1,
    });
    return { controller, generation: controller.snapshot().generation, guardContext };
  };

  it.each([false, true])(
    "settles the exact cutoff in real order with optional guard context %s",
    async (sendGuardContext) => {
      let compactions = 0;
      let aborts = 0;
      let branch: any[] = [];
      const defensiveAbort = new AbortController();
      const terminal = { role: "assistant", content: [{ type: "text", text: "opaque diagnostic" }], stopReason: "error" };
      const ctx = pi.printCtx({
        model: { provider: "openai", id: "gpt-test", api: "openai-responses", contextWindow: 1000 },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => sendGuardContext,
        sessionManager: { getBranch: () => branch },
        signal: defensiveAbort.signal,
        abort: () => { aborts += 1; defensiveAbort.abort(); },
        compact: (options: any) => {
          compactions += 1;
          queueMicrotask(() => options.onError(new Error("summary unavailable")));
        },
      });
      const { controller, guardContext } = await armCheckpoint(
        ctx, `exact-defensive-cutoff-${sendGuardContext}`, undefined, false, sendGuardContext,
      );
      await pi.fire("turn_start", {}, ctx);
      expect(aborts).toBe(1);
      if (guardContext) {
        const guardOccurrence = {
          role: "custom", content: "Pi reconstruction", details: guardContext.details,
        };
        await pi.fire("message_start", { message: guardOccurrence }, ctx);
        await pi.fire("message_end", { message: guardOccurrence }, ctx);
      }
      await pi.fire("message_end", { message: terminal }, ctx);
      branch = [{ type: "message", message: terminal }];
      await pi.fire("agent_settled", {}, ctx);
      await pi.fire("agent_settled", {}, ctx);
      expect(compactions).toBe(1);
      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted", admission: "recoverable-rejection", failureCategory: "operational",
      });
    },
  );

  it("settles a clean exact TUI cutoff through an installed terminal fence without raw input", async () => {
    let branch: any[] = [];
    let compactions = 0;
    let aborts = 0;
    const defensiveAbort = new AbortController();
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
      signal: defensiveAbort.signal,
      abort: () => { aborts += 1; defensiveAbort.abort(); },
      compact: (options: any) => {
        compactions += 1;
        queueMicrotask(() => options.onError(new Error("summary unavailable")));
      },
    });
    const { controller } = await armCheckpoint(ctx, "exact-tui-defensive-cutoff");
    expect(pi.terminalInputHandlers).toHaveLength(1);
    await pi.fire("turn_start", {}, ctx);
    expect(aborts).toBe(1);
    await pi.fire("message_end", { message: terminal }, ctx);
    branch = [{ type: "message", message: terminal }];
    await pi.fire("agent_settled", {}, ctx);
    await pi.fire("agent_settled", {}, ctx);
    expect(compactions).toBe(1);
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted", admission: "recoverable-rejection", failureCategory: "operational",
    });
  });

  it("rebinds one TUI terminal fence after a refused switch and revokes through it once", async () => {
    let branch: any[] = [];
    let compactions = 0;
    const defensiveAbort = new AbortController();
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
      signal: defensiveAbort.signal,
      abort: () => defensiveAbort.abort(),
      compact: () => { compactions += 1; },
    });
    await pi.fire("session_start", { reason: "new" }, ctx);
    expect(pi.terminalInputHandlers).toHaveLength(1);

    const originalBeforeSessionSwitch = mainCheckpointGate.beforeSessionSwitch;
    mainCheckpointGate.beforeSessionSwitch = async () => ({ cancel: true });
    try {
      await expect(pi.fire("session_before_switch", {}, ctx)).resolves.toEqual({ cancel: true });
    } finally {
      mainCheckpointGate.beforeSessionSwitch = originalBeforeSessionSwitch;
    }
    expect(pi.terminalInputHandlers).toHaveLength(1);

    mainCheckpointGate.assistantMessageEnded({
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "refused-switch-cutoff", name: "probe", arguments: {} }],
      usage: {
        input: 900, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 900,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }, ctx);
    const wrapped: any = mainCheckpointGate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const result = await wrapped.execute("refused-switch-cutoff", {}, undefined, undefined, ctx);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: "refused-switch-cutoff", result, isError: false });
    expect(mainCheckpointGate.turnEnded(ctx, ctx.mode)?.stop).toBe("terminate");
    const controller = mainCheckpointGate.currentController();

    const revoke = vi.spyOn(mainCheckpointGate, "revokeDefensiveCutoffForTerminalInput");
    expect(pi.feedTerminalInput("raw-after-refused-switch")).toEqual({
      consumed: false, data: "raw-after-refused-switch",
    });
    expect(revoke).toHaveBeenCalledOnce();
    revoke.mockRestore();
    await pi.fire("turn_start", {}, ctx);
    await pi.fire("message_end", { message: terminal }, ctx);
    branch = [{ type: "message", message: terminal }];
    await pi.fire("agent_settled", {}, ctx);
    expect(compactions).toBe(0);
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted", admission: "recoverable-rejection", failureCategory: "operational",
    });
  });

  it("revokes offered, issued, and bound authority on non-consuming TUI input", async () => {
    for (const state of ["offered", "issued", "bound"] as const) {
      let branch: any[] = [];
      let compactions = 0;
      const defensiveAbort = new AbortController();
      const terminal = { role: "assistant", stopReason: "error", content: [] };
      const ctx = pi.tuiCtx({
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => branch },
        signal: defensiveAbort.signal,
        abort: () => defensiveAbort.abort(),
        compact: () => { compactions += 1; },
      });
      const { controller } = await armCheckpoint(ctx, `tui-input-${state}`);
      if (state !== "offered") await pi.fire("turn_start", {}, ctx);
      if (state === "bound") await pi.fire("message_end", { message: terminal }, ctx);
      expect(pi.feedTerminalInput(`raw-${state}`)).toEqual({ consumed: false, data: `raw-${state}` });
      if (state === "offered") await pi.fire("turn_start", {}, ctx);
      if (state !== "bound") await pi.fire("message_end", { message: terminal }, ctx);
      branch = [{ type: "message", message: terminal }];
      await pi.fire("agent_settled", {}, ctx);
      expect(compactions).toBe(0);
      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted", admission: "recoverable-rejection", failureCategory: "operational",
      });
    }
  });

  it("keeps TUI input inert outside the authority window and rebinds without listener leaks", async () => {
    const idle = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
      hasPendingMessages: () => false,
    });
    await pi.fire("session_start", { reason: "new" }, idle);
    expect(pi.terminalInputHandlers).toHaveLength(1);
    expect(pi.feedTerminalInput("outside")).toEqual({ consumed: false, data: "outside" });
    await pi.fire("session_start", { reason: "reload" }, idle);
    expect(pi.terminalInputHandlers).toHaveLength(1);
    await expect(pi.fire("session_before_switch", {}, idle)).resolves.toBeUndefined();
    expect(pi.terminalInputHandlers).toHaveLength(0);
    await pi.fire("session_start", { reason: "new" }, idle);
    expect(pi.terminalInputHandlers).toHaveLength(1);
  });

  it.each(["missing", "throwing", "nonfunction"] as const)(
    "fails TUI automatic cutoff closed when terminal fence installation is %s",
    async (failure) => {
      let branch: any[] = [];
      let compactions = 0;
      const defensiveAbort = new AbortController();
      const ctx = pi.tuiCtx({
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => branch },
        signal: defensiveAbort.signal,
        abort: () => defensiveAbort.abort(),
        compact: () => { compactions += 1; },
      });
      const ui = ctx.ui as any;
      if (failure === "missing") ui.onTerminalInput = undefined;
      else if (failure === "throwing") ui.onTerminalInput = () => { throw new Error("unavailable"); };
      else ui.onTerminalInput = () => 7;

      const { controller } = await armCheckpoint(ctx, `tui-fence-${failure}`);
      expect(pi.terminalInputHandlers).toHaveLength(0);
      await pi.fire("turn_start", {}, ctx);
      const terminal = { role: "assistant", stopReason: "error", content: [] };
      await pi.fire("message_end", { message: terminal }, ctx);
      branch = [{ type: "message", message: terminal }];
      await pi.fire("agent_settled", {}, ctx);
      expect(compactions).toBe(0);
      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted", admission: "recoverable-rejection", failureCategory: "operational",
      });
    },
  );

  it("fails RPC defensive cutoff closed while preserving manual precommit recovery", async () => {
    let branch: any[] = [];
    let compactions = 0;
    let aborts = 0;
    const defensiveAbort = new AbortController();
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    const ctx = pi.rpcCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
      signal: defensiveAbort.signal,
      abort: () => { aborts += 1; defensiveAbort.abort(); },
      compact: () => { compactions += 1; },
    });
    const { controller } = await armCheckpoint(ctx, "rpc-defensive-cutoff");
    Object.defineProperty(ctx, "mode", { configurable: true, get: () => { throw new Error("stale runner"); } });
    await pi.fire("turn_start", {}, ctx);
    expect(aborts).toBe(1);
    await pi.fire("message_end", { message: terminal }, ctx);
    branch = [{ type: "message", message: terminal }];
    await pi.fire("agent_settled", {}, ctx);
    expect(compactions).toBe(0);
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted", admission: "recoverable-rejection", failureCategory: "operational",
    });
    expect(pi.entries.some((entry) => entry.customType === "picc-checkpoint-lifecycle" &&
      entry.data.category === "checkpoint-exhausted" && entry.data.action === "manual-recovery")).toBe(true);
  });

  let defensiveAuthorityCase = 0;
  const prepareDefensiveAuthority = async (options: {
    ids?: string[];
    resultError?: boolean;
    pending?: boolean;
    optionalContext?: boolean;
    leakToolAbortListener?: boolean;
  } = {}) => {
    defensiveAuthorityCase += 1;
    const gate = new MainSessionCheckpointGate(`cutoff-${defensiveAuthorityCase}`, 90);
    let aborts = 0;
    const defensiveAbort = new AbortController();
    if (options.leakToolAbortListener) {
      vi.spyOn(defensiveAbort.signal, "removeEventListener").mockImplementation(() => undefined);
    }
    const ctx = {
      mode: "print",
      model: { api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => options.pending === true,
      signal: defensiveAbort.signal,
      abort: () => { aborts += 1; defensiveAbort.abort(); },
    };
    const ids = options.ids ?? ["tool"];
    gate.assistantMessageEnded({
      role: "assistant",
      content: ids.map((id) => ({ type: "toolCall", id, name: "probe", arguments: {} })),
    });
    let guardContext: Record<string, unknown> | undefined;
    const wrapped: any = gate.wrapTool({
      name: "probe",
      execute: async () => {
        if (options.optionalContext) {
          guardContext = gate.authorizeDefensiveContextSend({ content: "guard context" });
        }
        return { content: [{ type: "text", text: "done" }] };
      },
    });
    const result = await wrapped.execute(ids[0] ?? "", {}, undefined, undefined, ctx);
    gate.toolExecutionEnded({ toolCallId: ids[0], result, isError: options.resultError === true });
    const disposition = gate.turnEnded(ctx, "print");
    return {
      gate, controller: gate.currentController(), ctx, disposition, guardContext,
      aborts: () => aborts,
      userAbort: () => defensiveAbort.abort(),
    };
  };

  const startExactDefensiveCutoff = async (prepared: Awaited<ReturnType<typeof prepareDefensiveAuthority>>) => {
    await prepared.gate.defensiveLatch(prepared.ctx, "print");
    if (prepared.guardContext) {
      const occurrence = {
        role: "custom", content: "Pi reconstruction", details: prepared.guardContext.details,
      };
      prepared.gate.userMessageStarted(occurrence);
      prepared.gate.assistantMessageEnded(occurrence);
    }
  };

  it.each([false, true])("binds the first exact terminal object once with optional context %s", async (optionalContext) => {
    const exact = await prepareDefensiveAuthority({ optionalContext });
    await startExactDefensiveCutoff(exact);
    const terminal = { role: "assistant", stopReason: "error", content: [{ type: "image", data: "x" }] };
    exact.gate.assistantMessageEnded(terminal);
    expect(exact.gate.consumeDefensiveCutoff(structuredClone(terminal), "print")).toBe(false);
    expect(exact.gate.consumeDefensiveCutoff({ ...terminal }, "print")).toBe(false);
    expect(exact.gate.consumeDefensiveCutoff(terminal, "print")).toBe(true);
    expect(exact.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);
  });

  it("does not bind when a guard-owned custom occurrence starts without its exact end", async () => {
    const prepared = await prepareDefensiveAuthority({ optionalContext: true });
    await prepared.gate.defensiveLatch(prepared.ctx, "print");
    prepared.gate.userMessageStarted({
      role: "custom", content: "Pi reconstruction", details: prepared.guardContext!.details,
    });
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    prepared.gate.assistantMessageEnded(terminal);
    expect(prepared.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);
  });

  it("tolerates only the exact guard-owned pending occurrence in Pi's real event order", async () => {
    const prepared = await prepareDefensiveAuthority({ pending: true, optionalContext: true });
    expect(prepared.disposition?.stop).toBe("terminate");
    await prepared.gate.defensiveLatch(prepared.ctx, "print");
    expect(prepared.aborts()).toBe(1);
    const guardOccurrence = {
      role: "custom", content: "Pi reconstruction", details: prepared.guardContext!.details,
    };
    prepared.gate.userMessageStarted(guardOccurrence);
    prepared.gate.assistantMessageEnded(guardOccurrence);
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    prepared.gate.assistantMessageEnded(terminal);
    expect(prepared.gate.consumeDefensiveCutoff(terminal, "print")).toBe(true);
  });

  it("rejects cloned, duplicate, mutated, and stale guard-owned custom ends", async () => {
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    const prepareStarted = async () => {
      const prepared = await prepareDefensiveAuthority({ optionalContext: true });
      await prepared.gate.defensiveLatch(prepared.ctx, "print");
      const occurrence: Record<string, unknown> = {
        role: "custom", content: "ignored", details: prepared.guardContext!.details,
      };
      prepared.gate.userMessageStarted(occurrence);
      return { prepared, occurrence };
    };
    const reject = (prepared: Awaited<ReturnType<typeof prepareDefensiveAuthority>>) => {
      prepared.gate.assistantMessageEnded(terminal);
      expect(prepared.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);
    };

    const cloned = await prepareStarted();
    cloned.prepared.gate.assistantMessageEnded({ ...cloned.occurrence });
    reject(cloned.prepared);

    const duplicate = await prepareStarted();
    duplicate.prepared.gate.assistantMessageEnded(duplicate.occurrence);
    duplicate.prepared.gate.assistantMessageEnded(duplicate.occurrence);
    reject(duplicate.prepared);

    for (const mutation of [
      (occurrence: Record<string, unknown>) => { occurrence.role = "user"; },
      (occurrence: Record<string, unknown>) => { occurrence.details = {}; },
    ]) {
      const mutated = await prepareStarted();
      mutation(mutated.occurrence);
      mutated.prepared.gate.assistantMessageEnded(mutated.occurrence);
      reject(mutated.prepared);
    }

    const stale = await prepareStarted();
    stale.prepared.gate.acceptedLogicalRun();
    stale.prepared.gate.assistantMessageEnded(stale.occurrence);
    reject(stale.prepared);
  });

  it("revokes guard-pending authority when any later unrelated occurrence starts", async () => {
    for (const unrelated of [
      { role: "user", content: [{ type: "text", text: "later user" }] },
      { role: "custom", content: "later custom" },
    ]) {
      const prepared = await prepareDefensiveAuthority({ pending: true, optionalContext: true });
      await prepared.gate.defensiveLatch(prepared.ctx, "print");
      prepared.gate.userMessageStarted({ role: "custom", details: prepared.guardContext!.details });
      prepared.gate.userMessageStarted(unrelated);
      const terminal = { role: "assistant", stopReason: "error", content: [] };
      prepared.gate.assistantMessageEnded(terminal);
      expect(prepared.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);
    }
  });

  it("fails automatic cutoff closed when no epoch-bound mode is supplied", async () => {
    const prepared = await prepareDefensiveAuthority();
    expect(prepared.disposition?.stop).toBe("terminate");
    await prepared.gate.defensiveLatch(prepared.ctx, undefined);
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    prepared.gate.assistantMessageEnded(terminal);
    expect(prepared.gate.consumeDefensiveCutoff(terminal, undefined)).toBe(false);
  });

  it.each(["aborted", "stop", "length"] as const)("rejects a non-error %s terminal", async (stopReason) => {
    const prepared = await prepareDefensiveAuthority();
    await startExactDefensiveCutoff(prepared);
    const terminal = { role: "assistant", stopReason, content: [] };
    prepared.gate.assistantMessageEnded(terminal);
    expect(prepared.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);
  });

  it("revokes cloned, duplicate, wrong-role, wrong-envelope, and unrelated guard occurrences", async () => {
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    const reject = async (
      messages: (prepared: Awaited<ReturnType<typeof prepareDefensiveAuthority>>) => Record<string, unknown>[],
    ) => {
      const prepared = await prepareDefensiveAuthority({ optionalContext: true });
      await prepared.gate.defensiveLatch(prepared.ctx, "print");
      for (const message of messages(prepared)) prepared.gate.userMessageStarted(message);
      prepared.gate.assistantMessageEnded(terminal);
      expect(prepared.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);
    };

    const cloned = await prepareDefensiveAuthority({ optionalContext: true });
    await cloned.gate.defensiveLatch(cloned.ctx, "print");
    cloned.gate.userMessageStarted({
      role: "custom", details: structuredClone(cloned.guardContext!.details),
    });
    cloned.gate.assistantMessageEnded(terminal);
    expect(cloned.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);

    const duplicate = await prepareDefensiveAuthority({ optionalContext: true });
    await duplicate.gate.defensiveLatch(duplicate.ctx, "print");
    const exact = { role: "custom", details: duplicate.guardContext!.details };
    duplicate.gate.userMessageStarted(exact);
    duplicate.gate.userMessageStarted({ ...exact });
    duplicate.gate.assistantMessageEnded(terminal);
    expect(duplicate.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);

    await reject((prepared) => [{ role: "user", details: prepared.guardContext?.details }]);
    await reject(() => [{ role: "custom", details: Object.freeze({ wrong: true }) }]);
    await reject(() => [{ role: "custom", content: "unrelated" }]);
  });

  it("revokes on accepted or started user/custom occurrences even after queues drain", async () => {
    const terminal = { role: "assistant", stopReason: "error", content: [] };

    const accepted = await prepareDefensiveAuthority();
    await startExactDefensiveCutoff(accepted);
    accepted.gate.captureAcceptedInput(accepted.ctx, "accepted-after-issue", undefined, "followUp");
    accepted.gate.userMessageStarted({
      role: "user", content: [{ type: "text", text: "accepted-after-issue" }],
    }, "followUp");
    expect(accepted.controller.queuedInputSnapshot()).toEqual([]);
    accepted.gate.assistantMessageEnded(terminal);
    expect(accepted.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);

    for (const message of [
      { role: "user", content: [{ type: "text", text: "started-only" }] },
      { role: "custom", content: "unrelated custom occurrence" },
    ]) {
      const started = await prepareDefensiveAuthority();
      await startExactDefensiveCutoff(started);
      started.gate.userMessageStarted(message);
      expect(started.controller.queuedInputSnapshot()).toEqual([]);
      started.gate.assistantMessageEnded(terminal);
      expect(started.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);
    }
  });

  it("rejects ordinary provider errors and wrong or intervening terminal objects", async () => {
    const ordinary = await prepareDefensiveAuthority();
    const ordinaryError = { role: "assistant", stopReason: "error", content: [] };
    ordinary.gate.assistantMessageEnded(ordinaryError);
    expect(ordinary.gate.consumeDefensiveCutoff(ordinaryError, "print")).toBe(false);

    const wrongRole = await prepareDefensiveAuthority();
    await startExactDefensiveCutoff(wrongRole);
    wrongRole.gate.assistantMessageEnded({ role: "toolResult", stopReason: "error", content: [] });
    wrongRole.gate.assistantMessageEnded(ordinaryError);
    expect(wrongRole.gate.consumeDefensiveCutoff(ordinaryError, "print")).toBe(false);

    const second = await prepareDefensiveAuthority();
    await startExactDefensiveCutoff(second);
    const first = { role: "assistant", stopReason: "error", content: [] };
    second.gate.assistantMessageEnded(first);
    second.gate.assistantMessageEnded({ role: "assistant", stopReason: "error", content: [] });
    expect(second.gate.consumeDefensiveCutoff(first, "print")).toBe(false);
  });

  it("fails closed for failed, malformed, pending, and genuinely ambiguous batches", async () => {
    const failed = await prepareDefensiveAuthority({ resultError: true });
    const malformed = await prepareDefensiveAuthority({ ids: ["duplicate", "duplicate"] });
    const pending = await prepareDefensiveAuthority({ pending: true });
    for (const candidate of [failed, malformed, pending]) {
      expect(candidate.disposition?.stop).toBe("abort");
      await candidate.gate.defensiveLatch(candidate.ctx, "print");
      const terminal = { role: "assistant", stopReason: "error", content: [] };
      candidate.gate.assistantMessageEnded(terminal);
      expect(candidate.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);
    }
    const ambiguous = await prepareDefensiveAuthority();
    ambiguous.gate.captureAcceptedInput(ambiguous.ctx, "unrelated queued input", undefined, "followUp");
    await ambiguous.gate.defensiveLatch(ambiguous.ctx, "print");
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    ambiguous.gate.assistantMessageEnded(terminal);
    expect(ambiguous.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);
  });

  it.each((["execution", "context"] as const).flatMap((source) =>
    (["before", "during", "after-return"] as const).map((timing) => [source, timing] as const)))(
    "invalidates a successful tool when the distinct %s signal aborts %s execution settlement",
    async (source, timing) => {
      const gate = new MainSessionCheckpointGate(`tool-user-abort-${source}-${timing}`, 90);
      const executionAbort = new AbortController();
      const contextAbort = new AbortController();
      const selected = source === "execution" ? executionAbort : contextAbort;
      const other = source === "execution" ? contextAbort : executionAbort;
      const ctx = {
        model: { api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        signal: contextAbort.signal,
        abort: vi.fn(),
      };
      gate.assistantMessageEnded({
        role: "assistant",
        content: [{ type: "toolCall", id: "tool", name: "probe", arguments: {} }],
      });
      if (timing === "before") selected.abort();
      const wrapped: any = gate.wrapTool({
        name: "probe",
        execute: async () => {
          if (timing === "during") selected.abort();
          return { content: [{ type: "text", text: "success despite abort" }] };
        },
      });
      const result = await wrapped.execute("tool", {}, executionAbort.signal, undefined, ctx);
      if (timing === "after-return") selected.abort();
      expect(other.signal.aborted).toBe(false);
      if (timing !== "after-return") expect(result).not.toHaveProperty("terminate", true);
      gate.toolExecutionEnded({ toolCallId: "tool", result, isError: false });
      expect(gate.turnEnded(ctx)?.stop).toBe("abort");
    },
  );

  it("removes an execution-only abort observer when a below-threshold batch returns early", async () => {
    const gate = new MainSessionCheckpointGate("below-threshold-listener-cleanup", 90);
    const abortListeners = new Set<unknown>();
    const signal = {
      aborted: false,
      addEventListener(type: string, listener: unknown) {
        if (type === "abort") abortListeners.add(listener);
      },
      removeEventListener(type: string, listener: unknown) {
        if (type === "abort") abortListeners.delete(listener);
      },
    } as unknown as AbortSignal;
    const ctx = {
      model: { api: "openai-responses" },
      getContextUsage: () => ({ tokens: 899, contextWindow: 1000, percent: 89.9 }),
      hasPendingMessages: () => false,
      signal,
      abort: vi.fn(),
    };
    gate.assistantMessageEnded({
      role: "assistant",
      content: [{ type: "toolCall", id: "low", name: "probe", arguments: {} }],
    });
    const wrapped: any = gate.wrapTool({
      name: "probe",
      execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const result = await wrapped.execute("low", {}, signal, undefined, { ...ctx, signal: undefined });
    expect(abortListeners.size).toBe(1);
    gate.toolExecutionEnded({ toolCallId: "low", result, isError: false });
    expect(gate.turnEnded(ctx)).toBeUndefined();
    expect(abortListeners.size).toBe(0);
  });

  it("distinguishes the later PiCC defensive abort from tool cancellation", async () => {
    const prepared = await prepareDefensiveAuthority();
    expect(prepared.disposition?.stop).toBe("terminate");
    expect(prepared.ctx.signal.aborted).toBe(false);
    await startExactDefensiveCutoff(prepared);
    expect(prepared.ctx.signal.aborted).toBe(true);
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    prepared.gate.assistantMessageEnded(terminal);
    expect(prepared.gate.consumeDefensiveCutoff(terminal, "print")).toBe(true);
  });

  it("fails closed when the public signal is absent or the defensive abort does not flip it", async () => {
    const missing = await prepareDefensiveAuthority();
    delete (missing.ctx as { signal?: AbortSignal }).signal;
    await missing.gate.defensiveLatch(missing.ctx, "print");
    expect(missing.aborts()).toBe(0);
    const missingTerminal = { role: "assistant", stopReason: "error", content: [] };
    missing.gate.assistantMessageEnded(missingTerminal);
    expect(missing.gate.consumeDefensiveCutoff(missingTerminal, "print")).toBe(false);

    const unchanged = await prepareDefensiveAuthority();
    const abortWithoutSignal = vi.fn();
    unchanged.ctx.abort = abortWithoutSignal;
    await unchanged.gate.defensiveLatch(unchanged.ctx, "print");
    expect(abortWithoutSignal).toHaveBeenCalledOnce();
    expect(unchanged.ctx.signal.aborted).toBe(false);
    const unchangedTerminal = { role: "assistant", stopReason: "error", content: [] };
    unchanged.gate.assistantMessageEnded(unchangedTerminal);
    expect(unchanged.gate.consumeDefensiveCutoff(unchangedTerminal, "print")).toBe(false);
  });

  it("does not reclassify a between-turn user abort before the defensive latch", async () => {
    const prepared = await prepareDefensiveAuthority();
    expect(prepared.disposition?.stop).toBe("terminate");
    prepared.userAbort();
    await prepared.gate.defensiveLatch(prepared.ctx, "print");
    expect(prepared.aborts()).toBe(0);
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    prepared.gate.assistantMessageEnded(terminal);
    expect(prepared.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);
  });

  it("requires tool-abort listener cleanup before defensive authority can survive", async () => {
    const leaked = await prepareDefensiveAuthority({ leakToolAbortListener: true });
    expect(leaked.disposition?.stop).toBe("terminate");
    await startExactDefensiveCutoff(leaked);
    const terminal = { role: "assistant", stopReason: "error", content: [] };
    leaked.gate.assistantMessageEnded(terminal);
    expect(leaked.gate.consumeDefensiveCutoff(terminal, "print")).toBe(false);
  });

  it("revokes authority on stale identities, commit, resume, and postcommit failure", async () => {
    const bind = async () => {
      const prepared = await prepareDefensiveAuthority();
      await startExactDefensiveCutoff(prepared);
      const terminal = { role: "assistant", stopReason: "error", content: [] };
      prepared.gate.assistantMessageEnded(terminal);
      return { ...prepared, terminal, generation: prepared.controller.snapshot().generation };
    };
    const staleSession = await bind();
    await staleSession.gate.startSession("replacement-controller-session-epoch");
    expect(staleSession.gate.consumeDefensiveCutoff(staleSession.terminal, "print")).toBe(false);
    const staleRun = await bind();
    staleRun.gate.acceptedLogicalRun();
    expect(staleRun.gate.consumeDefensiveCutoff(staleRun.terminal, "print")).toBe(false);
    const staleBatch = await bind();
    staleBatch.gate.assistantMessageEnded({ role: "assistant", stopReason: "error", content: [] });
    expect(staleBatch.gate.consumeDefensiveCutoff(staleBatch.terminal, "print")).toBe(false);
    const staleGeneration = await bind();
    expect(staleGeneration.controller.exhaustUnsuccessfulAwaitingSettlement(staleGeneration.generation)).toBe(true);
    const recovery = staleGeneration.controller.recoveryToken(staleGeneration.generation)!;
    expect(staleGeneration.controller.recoverAfterManualCompaction(recovery).recovered).toBe(true);
    expect(staleGeneration.controller.sample({ tokens: 900, contextWindow: 1000, percent: 90 }, "settled"))
      .toBe(staleGeneration.generation + 1);
    expect(staleGeneration.gate.consumeDefensiveCutoff(staleGeneration.terminal, "print")).toBe(false);
    const resumed = await bind();
    const resumedSettlement = deferred<void>();
    resumed.gate.attachExecution({
      compact: async () => ({ ok: true }),
      resume: () => ({
        settled: resumedSettlement.promise,
        replay: async () => ({ delivered: true as const }),
        cancelAndJoin: async () => undefined,
      }),
    });
    const resumedRun = resumed.controller.checkpoint(resumed.generation);
    await waitUntil({
      description: "stale cutoff authority to reach resumed work",
      predicate: () => resumed.controller.snapshot().phase === "resuming",
    });
    expect(resumed.gate.consumeDefensiveCutoff(resumed.terminal, "print")).toBe(false);
    resumedSettlement.resolve();
    await resumedRun;
    const committed = await bind();
    expect(committed.controller.observeCompactionCommit(committed.generation)).toBe(true);
    expect(committed.gate.consumeDefensiveCutoff(committed.terminal, "print")).toBe(false);
    await committed.controller.failAfterCommittedSummary(committed.generation, "resumed-work");
    expect(committed.gate.consumeDefensiveCutoff(committed.terminal, "print")).toBe(false);
  });

  it.each(["pending", "error", "aborted"] as const)(
    "rejects a genuine awaiting %s terminal",
    async (stopReason) => {
      let compactions = 0;
      const terminal = {
        role: "assistant",
        content: [{ type: "text", text: `unsuccessful ${stopReason}` }],
        stopReason,
      };
      const ctx = pi.printCtx({
        mode: "json",
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => [{ type: "message", message: terminal }] },
        abort: () => undefined,
        compact: (options: any) => {
          compactions += 1;
          queueMicrotask(() => options.onError(new Error("unexpected compaction")));
        },
      });
      const { controller, generation } = await armCheckpoint(ctx, `unsuccessful-${stopReason}`);
      const barrier = controller.stableBarrier(generation);
      const beforeEntries = pi.entries.length;
      const logicalAuthority = mainCheckpointGate.captureLogicalRunStop();

      await pi.fire("agent_settled", {}, ctx);

      expect(compactions).toBe(0);
      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted", admission: "recoverable-rejection", failureCategory: "operational",
      });
      expect(controller.ordinaryInputDisposition()).toBe("reject-recoverable");
      expect(controller.manualCompactionDisposition()).toBe("allow");
      const recovery = controller.recoveryToken(generation);
      expect(recovery).toBeDefined();
      await expect(barrier).resolves.toBeUndefined();
      const diagnostics = pi.entries.slice(beforeEntries).filter((entry) =>
        entry.data.category === "checkpoint-exhausted");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.data).toMatchObject({
        generation, action: "manual-recovery", failureCategory: "operational",
      });
      await expect(pi.fire("input", {
        text: `ordinary-after-${stopReason}`, source: "interactive", streamingBehavior: undefined,
      }, ctx)).resolves.toEqual({ action: "handled" });
      expect(logicalAuthority()).toBe(false);
      expect(controller.recoverAfterManualCompaction(recovery!).recovered).toBe(true);
    },
  );

  interface EndingCase {
    /** Does this ending take the retained input away, or hold it for `/compact`? */
    drops: boolean;
    category: "checkpoint-cancelled" | "checkpoint-exhausted";
    /**
     * Pi stops the TUI renderer before it emits this ending's event, so in `tui` mode the
     * reader's only remaining surface is stderr and there is no editor to restore into.
     */
    rendererStopped?: boolean;
    severity: "warning" | "error";
    drive(ctx: any, controller: MidRunCompactionController, generation: number): Promise<unknown>;
    /** The claim the reader must be able to act on, which is not the same in every mode. */
    guidance(mode: string): string;
  }

  /**
   * A UI whose verbs are inert but present — Pi's `ui.stop()` state, where every render path
   * returns early and `setEditorText` silently discards. The recording fake cannot model this
   * (it keeps accepting notifications after shutdown), which is exactly why the shutdown row
   * used to pass while the reader saw nothing.
   */
  const stoppedUi = {
    notify: () => undefined,
    setStatus: () => undefined,
    getEditorText: () => "",
    setEditorText: () => undefined,
  };

  const endings: Array<[string, EndingCase]> = [
    ["a user cancellation", {
      drops: true,
      category: "checkpoint-cancelled",
      severity: "warning",
      drive: (_ctx, controller, generation) => controller.cancel(generation, "user"),
      guidance: () => "Run /compact to recover this session",
    }],
    ["a replacement cancellation", {
      drops: true,
      category: "checkpoint-cancelled",
      severity: "warning",
      drive: (_ctx, controller, generation) => controller.cancel(generation, "replacement"),
      guidance: () => "resend input in the new session",
    }],
    ["a shutdown cancellation", {
      drops: true,
      category: "checkpoint-cancelled",
      // Through the registered handler, because the reader is quitting: the old wording
      // sent them to a new session that will never exist. `quit` is the exact reason Pi's
      // `dispose()` emits, and the one it has already stopped the renderer for.
      rendererStopped: true,
      severity: "warning",
      drive: (ctx) => pi.fire("session_shutdown", { reason: "quit" }, ctx),
      guidance: () => "stopped when the session ended",
    }],
    ["a post-commit failure", {
      drops: true,
      category: "checkpoint-exhausted",
      severity: "error",
      drive: (_ctx, controller, generation) => controller.failAfterCommittedSummary(generation),
      guidance: (mode) => mode === "tui"
        ? "start a new session and resend the retained input"
        : "start a replacement session and resend the retained input",
    }],
    ["an operational exhaustion", {
      // The one ending that keeps the queue: it is still recoverable, and `/compact`
      // is what rejects the retained input.
      drops: false,
      category: "checkpoint-exhausted",
      severity: "error",
      drive: (ctx) => pi.fire("agent_settled", {}, ctx),
      guidance: (mode) => mode === "tui"
        ? "Run /compact, then explicitly continue"
        : mode === "rpc"
          ? "live RPC session can run /compact, then explicitly continue"
          : "This headless session is ephemeral and cannot be reopened",
    }],
  ];

  it.each([
    ["continuation-start", "was not confirmed to start", "may already exist", false],
    ["input-replay", "no second run will start automatically", "may already exist", true],
  ] as const)("reports stage-accurate post-commit truth at %s", async (stage, expected, effects, expectsEffects) => {
    const ctx = pi.printCtx({
      mode: "json",
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      abort: () => undefined,
    });
    const { controller, generation } = await armCheckpoint(ctx, `stage-${stage}`);
    pi.entries.length = 0;
    await controller.failAfterCommittedSummary(generation, stage);
    const notice = String(pi.entries.find((entry) => entry.data.category === "checkpoint-exhausted")?.data.notice);
    expect(notice).toContain(expected);
    expect(notice.includes(effects)).toBe(expectsEffects);
  });

  const modes = ["tui", "print", "json", "rpc"] as const;

  it.each(endings.flatMap(([name, ending]) =>
    modes.map((mode) => [`${name} in ${mode} mode`, mode, ending] as const)))(
    "announces %s and reports what it cost",
    async (_label, mode, ending) => {
      const errors: string[] = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
      try {
        const base = {
          model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
          getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
          hasPendingMessages: () => false,
          // No `getSessionFile`: this session is ephemeral, which is the guidance the
          // headless rows assert.
          sessionManager: { getBranch: () => [] },
          abort: () => undefined,
          compact: (options: any) => queueMicrotask(() => options.onError(new Error("no summary"))),
        };
        const ctx = mode === "tui"
          ? pi.tuiCtx(ending.rendererStopped ? { ...base, ui: stoppedUi } : base)
          : mode === "print" ? pi.printCtx(base)
            : mode === "rpc" ? pi.rpcCtx(base) : pi.printCtx({ ...base, mode: "json" });
        // The channel this mode still has when the ending arrives. A stopped TUI has none
        // of its own left: `notify` and `setEditorText` return without doing anything.
        const channel = mode === "json" || mode === "rpc"
          ? "lifecycle"
          : mode === "tui" && !ending.rendererStopped ? "presentation" : "stderr";
        const { controller, generation } = await armCheckpoint(ctx, `ending-${mode}`, "retained by the ending");
        // After arming, not before: starting this session replaces the previous case's
        // controller, and a recoverable exhaustion that still held input reports it right
        // there — which is the behaviour a later case in this file owns.
        pi.entries.length = 0;
        pi.notifications.length = 0;
        pi.editorText = "";
        errors.length = 0;

        await ending.drive(ctx, controller, generation);

        const entries = pi.entries.filter((entry) => entry.customType === "picc-checkpoint-lifecycle");
        const lifecycle = entries.filter((entry) => entry.data.category === ending.category);
        const presentation = pi.entries.filter((entry) => entry.customType === "picc-proactive-compact");
        // The ending reached the channel this mode actually has. A footer line the reader
        // may never look at is not an announcement of a terminal, and a stopped renderer
        // cannot accept a durable chat entry.
        if (channel === "presentation") {
          expect(presentation).toEqual([
            {
              customType: "picc-proactive-compact",
              data: { notice: expect.stringContaining(ending.guidance(mode)), severity: ending.severity },
            },
            ...(ending.drops ? [{
              customType: "picc-proactive-compact",
              data: {
                notice: "1 queued input was not replayed; 1 text input was restored.",
                severity: "info",
              },
            }] : []),
          ]);
        } else if (channel === "stderr") {
          expect(errors.filter((line) => line.startsWith("PiCC: ")).join("\n"))
            .toContain(ending.guidance(mode));
        } else {
          expect(lifecycle.map((entry) => String(entry.data.notice)).join("\n"))
            .toContain(ending.guidance(mode));
        }
        // Persistence is unchanged for this ending's own category: json/rpc carry every
        // category, print/TUI carry only exhaustion.
        expect(lifecycle.length)
          .toBe(mode === "json" || mode === "rpc" || ending.category === "checkpoint-exhausted" ? 1 : 0);
        // And nothing else widened it behind that filter: the ending's own record, plus at
        // most the input-recovery report, which every mode persists.
        expect(entries.length).toBe(lifecycle.length + (ending.drops ? 1 : 0));
        expect(presentation).toHaveLength(channel === "presentation" ? 1 + Number(ending.drops) : 0);
        expect(pi.messages.some((message) => message.message.customType === "picc-proactive-compact")).toBe(false);
        expect(pi.statusCalls.filter((call) => call.key === "picc-checkpoint" && call.text !== undefined)).toEqual([]);

        // What the ending cost, named rather than implied — and where there is still an
        // editor, handed back into it instead of only counted. A stopped renderer must
        // report a restore of nothing rather than record text it silently discarded.
        const recovery = entries.filter((entry) => entry.data.category === "checkpoint-input-recovery");
        const restores = channel === "presentation";
        expect(recovery.map((entry) => entry.data.count)).toEqual(ending.drops ? [1] : []);
        expect(recovery.map((entry) => entry.data.restoredTextCount))
          .toEqual(ending.drops ? [restores ? 1 : 0] : []);
        expect(pi.editorText).toBe(restores && ending.drops ? "retained by the ending\n" : "");

        // Finished versus gave up, without parsing prose. Never in the TUI, where the
        // reader is the one who saw the notice.
        expect(process.exitCode).toBe(mode === "tui" ? undefined : 3);
      } finally {
        errorSpy.mockRestore();
        pi.editorText = "";
      }
    },
  );

  it("refuses input after a session-ended cancellation without promising a wait or a new session", async () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const ctx = pi.printCtx({
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => [] },
        abort: () => undefined,
      });
      const { controller } = await armCheckpoint(ctx, "shutdown-refusal");
      await pi.fire("session_shutdown", { reason: "quit" }, ctx);
      // The state the notice has to describe: cancelled by something other than the reader,
      // settled, and holding no recovery capability.
      expect(controller.snapshot()).toMatchObject({
        phase: "cancelled", cancellationKind: "shutdown", cancellationQuiescence: "confirmed",
      });
      expect(controller.manualCompactionDisposition()).toBe("unavailable");
      errors.length = 0;

      await expect(pi.fire("input", { text: "still typing", source: "interactive" }, ctx))
        .resolves.toEqual({ action: "handled" });

      const refusal = errors.filter((line) => line.startsWith("PiCC: ")).join("\n");
      expect(refusal).toContain("cannot be recovered here");
      // Neither falsehood the endings themselves stopped telling: a wait that never ends,
      // and a new session that will never carry this input.
      expect(refusal).not.toContain("Wait before");
      expect(refusal).not.toContain("Start a new session and resend this input");

      // `/compact` in the same state answers from the same classification, so the two
      // refusals cannot drift apart again.
      errors.length = 0;
      await expect(pi.fire("session_before_compact", { reason: "manual" }, ctx))
        .resolves.toEqual({ cancel: true });
      const declined = errors.filter((line) => line.startsWith("PiCC: ")).join("\n");
      expect(declined).toContain("stopped with the session it belonged to");
      // Says why PiCC declined; never offers the recovery this ending has no token for.
      expect(declined).not.toContain("Run /compact");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("tells a reader whose own cancellation is still settling to wait, and never to abandon the session", async () => {
    let aborts = 0;
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
      abort: () => { aborts += 1; },
    });
    let outer: Promise<unknown> | undefined;
    let nested: Promise<unknown> | undefined;
    let cancelling: Promise<unknown> | undefined;
    try {
      // Esc during a resumed run — the most common cancellation there is. The real adapter's
      // `cancelAndJoin` parks on the run's settlement while the `agent_settled` handler
      // still owes it, which is the window the reader types `/compact` in.
      ({ outer } = await driveResumeToResuming("esc-while-settling", ctx));
      const controller = mainCheckpointGate.currentController();
      const generation = controller.snapshot().generation;
      cancelling = controller.cancel(generation, "user");
      await waitUntil({
        description: "the cancellation parked on the host join",
        predicate: () => aborts > 0,
      });
      expect(controller.snapshot()).toMatchObject({
        phase: "cancelled", cancellationKind: "user", cancellationQuiescence: "pending",
        cancellationCommitted: false,
      });
      pi.notifications.length = 0;

      await expect(pi.fire("session_before_compact", { reason: "manual" }, ctx))
        .resolves.toEqual({ cancel: true });

      // PiCC used to tell the reader here to throw the session away — seconds before the
      // join landed and it offered `/compact` on the same checkpoint.
      const refusal = pi.notifications.map((note) => note.text).join("\n");
      expect(refusal).toContain("has not finished settling yet");
      expect(refusal).not.toContain("Start a new session");
      expect(refusal).not.toContain("exit PiCC");

      // The wait it asked for is one that actually ends in the recovery it implies.
      nested = pi.fire("agent_settled", {}, ctx);
      await settlement(nested, { description: "the cancelled run's settlement handler" });
      await settlement(cancelling, { description: "the parked user cancellation" });
      await settlement(outer, { description: "the checkpoint generation barrier" });
      expect(controller.manualCompactionDisposition()).toBe("allow");
    } finally {
      for (const pending of [nested, cancelling, outer]) void pending?.catch(() => undefined);
    }
  });

  it("supersedes the resumed-work record when the resumed run gives up", async () => {
    const ctx = resumeCtx({ mode: "json", sessionManager: { getBranch: () => [] } });
    let outer: Promise<unknown> | undefined;
    let nested: Promise<unknown> | undefined;
    let terminal: Promise<unknown> | undefined;
    try {
      // Before the drive, not after: `replayComplete` appends the resumed-work record
      // while this helper is still running, and clearing afterwards would delete the very
      // record this case is about.
      pi.entries.length = 0;
      ({ outer } = await driveResumeToResuming("give-up-supersedes-resumed", ctx));
      const stranded = mainCheckpointGate.currentController();
      const generation = stranded.snapshot().generation;
      // `replayComplete` runs unconditionally, so the documented success signal is
      // already out before anything can go wrong with the resumed run.
      await waitUntil({
        description: "the resumed-work lifecycle record",
        predicate: () => pi.entries.some((entry) => entry.data.category === "checkpoint-resumed"),
      });

      terminal = stranded.failAfterCommittedSummary(generation);
      nested = pi.fire("agent_settled", {}, ctx);
      await settlement(nested, { description: "the settlement handler the terminalization joins" });
      await expect(nested).resolves.toBeUndefined();
      await settlement(terminal, { description: "the post-commit terminalization" });
      await settlement(outer, { description: "the checkpoint generation barrier" });
      await expect(outer).resolves.toBeUndefined();

      // `doc/user-guide.md` tells machine consumers to read `checkpoint-resumed` as proof
      // the work resumed. It must never be the last word about a run that gave up.
      // Input recovery is a different report with its own owner, and starting this
      // session released what the previous case left retained.
      const lifecycle = pi.entries.filter((entry) => entry.customType === "picc-checkpoint-lifecycle" &&
        entry.data.category !== "checkpoint-input-recovery");
      const categories = lifecycle.map((entry) => String(entry.data.category));
      expect(categories).toContain("checkpoint-resumed");
      expect(categories.at(-1)).toBe("checkpoint-exhausted");
      expect(lifecycle.at(-1)?.data).toMatchObject({
        category: "checkpoint-exhausted", failureCategory: "restoration-paused", action: "new-session",
      });
      expect(process.exitCode).toBe(3);
    } finally {
      for (const pending of [nested, terminal, outer]) void pending?.catch(() => undefined);
    }
  });

  it.each([
    ["a stopped logical run", async (ctx: any) => {
      // The Stop/SessionStart/UserPromptSubmit hook stop path, at the seam all three use.
      expect(mainCheckpointGate.captureLogicalRunStop()()).toBe(true);
      await pi.fire("agent_settled", {}, ctx);
    }, true],
    ["a session switch", async (ctx: any) => {
      await expect(pi.fire("session_before_switch", {}, ctx)).resolves.toBeUndefined();
    }, false],
    ["a new session", async (ctx: any) => {
      await pi.fire("session_start", { reason: "new" }, ctx);
    }, false],
  ])(
    "reports the queued input %s takes away",
    async (_label, drive, suppressesNotice) => {
      const ctx = pi.tuiCtx({
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => [] },
        abort: () => undefined,
      });
      await armCheckpoint(ctx, "dropped-input", "typed while paused");
      pi.entries.length = 0;
      pi.notifications.length = 0;
      pi.editorText = "";

      await drive(ctx);

      expect(pi.entries.filter((entry) => entry.data.category === "checkpoint-input-recovery")
        .map((entry) => entry.data.count)).toEqual([1]);
      expect(pi.editorText).toBe("typed while paused\n");
      // A run the reader already stopped must not narrate its own checkpoint — but the
      // input they typed is theirs, and suppressing the notice used to suppress that too.
      if (suppressesNotice) {
        expect(pi.notifications.map((note) => note.text)
          .filter((text) => text.startsWith("Proactive context compaction"))).toEqual([]);
      }
      pi.editorText = "";
    },
  );

  it("reports queued input a recoverable exhaustion still held when the session is replaced", async () => {
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      abort: () => undefined,
      compact: (options: any) => queueMicrotask(() => options.onError(new Error("no summary"))),
    });
    try {
      const { controller } = await armCheckpoint(ctx, "exhausted-retained", "held for /compact");
      pi.entries.length = 0;
      pi.editorText = "";
      await pi.fire("agent_settled", {}, ctx);
      // A recoverable exhaustion deliberately keeps its queue, and nothing cancels it: the
      // controller refuses to re-enter a terminal generation. Replacing the session is
      // therefore the moment that input stops being reachable, and the only moment left to
      // name it.
      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted", admission: "recoverable-rejection", queuedInputs: 1,
      });
      expect(pi.entries.filter((entry) => entry.data.category === "checkpoint-input-recovery")).toEqual([]);

      await pi.fire("session_before_switch", {}, ctx);
      expect(pi.entries.filter((entry) => entry.data.category === "checkpoint-input-recovery")
        .map((entry) => entry.data.count)).toEqual([1]);
      expect(pi.editorText).toBe("held for /compact\n");

      // Exactly once: the switch drained what it reported, so the session start behind it
      // finds nothing left and does not restore the same text a second time.
      await pi.fire("session_start", { reason: "switch" }, ctx);
      expect(pi.entries.filter((entry) => entry.data.category === "checkpoint-input-recovery")).toHaveLength(1);
      expect(pi.editorText).toBe("held for /compact\n");
    } finally {
      pi.editorText = "";
    }
  });

  it("explains a refused /compact instead of leaving Pi's unattributed cancellation alone", async () => {
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const tui = pi.tuiCtx({
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => [] },
        abort: () => undefined,
      });
      const { controller, generation } = await armCheckpoint(tui, "refused-compact");
      await controller.failAfterCommittedSummary(generation);
      pi.notifications.length = 0;

      await expect(pi.fire("session_before_compact", { reason: "manual" }, tui))
        .resolves.toEqual({ cancel: true });
      // Complements Pi's own `Compaction cancelled`, which carries no author and reads as
      // if the reader withdrew the request. It never repeats that word, it never offers the
      // one recovery this ending forbids, and it carries the same `PiCC: ` prefix as every
      // other diagnostic so one predicate finds them all.
      const refusal = pi.notifications.map((note) => note.text)
        .filter((text) => text.startsWith("PiCC: "));
      expect(refusal).toHaveLength(1);
      expect(refusal[0]).toContain("this compaction did not run");
      expect(refusal[0]).toContain("must never be compacted again");
      expect(refusal[0]).not.toContain("cancelled");

      // Same refusal, headless: stderr rather than a toast, still self-attributed.
      const print = pi.printCtx({
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => [] },
        abort: () => undefined,
      });
      const paused = await armCheckpoint(print, "refused-compact-headless");
      await paused.controller.failAfterCommittedSummary(paused.generation);
      errors.length = 0;
      await expect(pi.fire("session_before_compact", { reason: "manual" }, print))
        .resolves.toEqual({ cancel: true });
      expect(errors.filter((line) => line.startsWith("PiCC: this compaction did not run"))).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("drops queued resumed print output when session replacement revokes its serialized-write authority", async () => {
    await mainCheckpointGate.startSession("queued-print-authority");
    const ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
    });
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant",
      content: [{ type: "toolCall", id: "queued-print", name: "probe", arguments: {} }],
    });
    const wrapped: any = mainCheckpointGate.wrapTool({
      name: "probe",
      execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const toolResult = await wrapped.execute("queued-print", {}, undefined, undefined, ctx);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: "queued-print", result: toolResult, isError: false });
    mainCheckpointGate.turnEnded(ctx);
    const outer = pi.fire("agent_settled", {}, ctx);
    await waitUntil({
      description: "queued print resume",
      predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming",
    });

    const attemptedWrites: string[] = [];
    let releaseWrite: (() => void) | undefined;
    const writeEntered = deferred<void>();
    const markerCount = () => pi.messages.filter(
      (entry) => entry.message.customType === "picc-checkpoint-print-result",
    ).length;
    const markersBefore = markerCount();
    const writeSpy = vi.spyOn(fs, "write").mockImplementation(((_fd: any, data: any, offset: any,
      length: any, _position: any, callback: any) => {
      attemptedWrites.push(data.subarray(offset, offset + length).toString("utf8"));
      writeEntered.resolve();
      releaseWrite = () => callback(Object.assign(new Error("revoked write"), { code: "EPIPE" }), 0);
    }) as typeof fs.write);
    const resultContext = (text: string, onRead?: () => void) => ({
      ...ctx,
      sessionManager: {
        getBranch: () => {
          onRead?.();
          return [{
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              stopReason: "stop",
            },
          }];
        },
      },
    });
    try {
      const firstSettlement = pi.fire("agent_settled", {}, resultContext("tail blocker"));
      await writeEntered.promise;
      let queuedBranchRead = false;
      const queuedSettlement = pi.fire("agent_settled", {}, resultContext(
        "stale queued result",
        () => { queuedBranchRead = true; },
      ));
      await waitUntil({
        description: "second resumed print result queued behind the write tail",
        predicate: () => queuedBranchRead,
      });

      // The revocation this test is about is observable as the replacement completing.
      // Waiting on the transient `cancelled` phase is not: a stalled write no longer
      // parks the replacement there, so a poll can miss the phase entirely. The
      // assertions below still prove the queued emission lost authority before writing.
      const replacement = mainCheckpointGate.startSession("replacement-before-queued-print-write");
      await settlement(replacement, { description: "queued print authority replacement" });
      await expect(replacement).resolves.toBeUndefined();
      await Promise.all([firstSettlement, queuedSettlement, outer, replacement]);
    } finally {
      writeSpy.mockRestore();
      releaseWrite?.();
    }

    expect(attemptedWrites).toEqual(["tail blocker\n"]);
    expect(attemptedWrites.join("")).not.toContain("stale queued result");
    expect(markerCount()).toBe(markersBefore);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
    expect(mainCheckpointGate.currentController().snapshot().admission).toBe("open");
  });

  it("releases a never-completing resumed print write and leaves the next session's emission clean", async () => {
    // The whole deadlock chain, end to end: a stdout write whose callback never fires
    // must not park `agent_settled` inside the print-write chain — that parks the
    // resume, which parks the cancellation join, which leaves every later
    // startSession / beforeSessionSwitch on this gate hanging. The write callback is
    // captured and NEVER invoked here, so the run's own cancellation authority is the
    // only thing that can release it, and the next session must get its own chain.
    const stdoutWrites: string[] = [];
    let strandedCallback: ((error: NodeJS.ErrnoException | null, written: number) => void) | undefined;
    const strandedWriteEntered = deferred<void>();
    let strandWrite = true;
    const originalWrite = fs.write.bind(fs);
    const writeSpy = vi.spyOn(fs, "write").mockImplementation(((fd: any, data: any, offset: any,
      length: any, position: any, callback: any) => {
      if (fd === process.stdout.fd && Buffer.isBuffer(data)) {
        stdoutWrites.push(data.subarray(offset, offset + length).toString("utf8"));
        if (strandWrite) {
          strandedCallback = callback;
          strandedWriteEntered.resolve();
          return;
        }
        queueMicrotask(() => callback(null, length, data));
        return;
      }
      return originalWrite(fd, data, offset, length, position, callback);
    }) as typeof fs.write);

    const armResumedPrint = async (id: string, text: string) => {
      const ctx = pi.printCtx({
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: {
          getBranch: () => [{
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
          }],
        },
        compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
      });
      mainCheckpointGate.assistantMessageEnded({
        role: "assistant", content: [{ type: "toolCall", id, name: "probe", arguments: {} }],
      });
      const wrapped: any = mainCheckpointGate.wrapTool({
        name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
      });
      const result = await wrapped.execute(id, {}, undefined, undefined, ctx);
      mainCheckpointGate.toolExecutionEnded({ toolCallId: id, result, isError: false });
      mainCheckpointGate.turnEnded(ctx);
      const outer = pi.fire("agent_settled", {}, ctx);
      await waitUntil({
        description: `${id} resumed run`,
        predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming",
      });
      return { ctx, outer };
    };
    const markerCount = () => pi.messages.filter(
      (entry) => entry.message.customType === "picc-checkpoint-print-result",
    ).length;

    try {
      await mainCheckpointGate.startSession("stranded-print-write");
      const stranded = await armResumedPrint("stranded", "stranded answer");
      const strandedSettlement = pi.fire("agent_settled", {}, { ...stranded.ctx });
      await strandedWriteEntered.promise;
      const markersBefore = markerCount();

      // Abandon that session through the REGISTERED handler, not the gate method: a
      // reset that hangs off session_start is invisible to a gate-method assertion.
      const replacement = pi.fire("session_start", { reason: "new" }, pi.printCtx());
      await settlement(replacement, {
        description: "session_start to replace the session owning the stranded write",
        describeObserved: () => `controller phase: ${mainCheckpointGate.currentController().snapshot().phase}`,
      });
      await expect(replacement).resolves.toBeUndefined();
      await settlement(strandedSettlement, {
        description: "the stranded resumed print settlement to unwind",
      });
      await expect(strandedSettlement).resolves.toBeUndefined();
      await settlement(stranded.outer, { description: "the stranded run's outer agent_settled to unwind" });
      await expect(stranded.outer).resolves.toBeUndefined();
      expect(markerCount()).toBe(markersBefore);

      // A second resumed print emission on the same extension instance, with a
      // working write, while the first session's write callback is still outstanding.
      strandWrite = false;
      const fresh = await armResumedPrint("fresh", "fresh answer");
      const freshSettlement = pi.fire("agent_settled", {}, { ...fresh.ctx });
      await settlement(freshSettlement, { description: "the fresh session's resumed print settlement" });
      await expect(freshSettlement).resolves.toBeUndefined();
      await settlement(fresh.outer, { description: "the fresh run's outer agent_settled to unwind" });
      await expect(fresh.outer).resolves.toBeUndefined();

      expect(stdoutWrites).toEqual(["stranded answer\n", "fresh answer\n"]);
      expect(markerCount()).toBe(markersBefore + 1);

      const switching = pi.fire("session_before_switch", {}, pi.printCtx());
      await settlement(switching, { description: "session_before_switch after the stranded write" });
      await expect(switching).resolves.toBeUndefined();
      const restarting = pi.fire("session_start", { reason: "switch" }, pi.printCtx());
      await settlement(restarting, { description: "session_start after the stranded write" });
      await expect(restarting).resolves.toBeUndefined();
      expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({
        phase: "idle", admission: "open",
      });
    } finally {
      // Restore the global spy before anything that could throw: a failure here would
      // otherwise leave `strandWrite` stranding stdout for every later test in the file
      // and hide whatever actually failed above.
      writeSpy.mockRestore();
      strandedCallback?.(Object.assign(new Error("released after the assertions"), { code: "EPIPE" }), 0);
    }
  });

  it("settles a permanent print-write failure without a marker so Pi's native last-assistant printer can run", async () => {
    await mainCheckpointGate.startSession("print-permanent-failure");
    const assistantEntry = {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "retry-safe-result" }], stopReason: "stop" },
    };
    const branch = [assistantEntry];
    const ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => branch },
      compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
    });
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant", content: [{ type: "toolCall", id: "permanent", name: "probe", arguments: {} }],
    });
    const wrapped: any = mainCheckpointGate.wrapTool({ name: "probe", execute: async () => ({ content: [] }) });
    const result = await wrapped.execute("permanent", {}, undefined, undefined, ctx);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: "permanent", result, isError: false });
    mainCheckpointGate.turnEnded(ctx);
    const outer = pi.fire("agent_settled", {}, ctx);
    await waitUntil({ description: "permanent writer resume", predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming" });

    const markerCount = () => pi.messages.filter((entry) => entry.message.customType === "picc-checkpoint-print-result").length;
    const before = markerCount();
    const permanent = Object.assign(new Error("stdout closed"), { code: "EPIPE" });
    const failedWrite = vi.spyOn(fs, "write").mockImplementation(((_fd: any, _data: any, _offset: any, _length: any, _position: any, callback: any) => {
      queueMicrotask(() => callback(permanent, 0));
    }) as typeof fs.write);
    try {
      await expect(pi.fire("agent_settled", {}, { ...ctx })).resolves.toBeUndefined();
    } finally {
      // The spy ignores the fd and fails every `fs.write` in the worker; an unmet
      // expectation here must not hand that to every later test.
      failedWrite.mockRestore();
    }
    await outer;
    expect(markerCount()).toBe(before);
    expect((ctx.sessionManager as any).getBranch().at(-1)).toBe(assistantEntry);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
    expect(mainCheckpointGate.currentController().snapshot().admission).toBe("open");
  });

  it("terminalizes a Pi-native auto compact after mandatory SessionStart delivery failure", async () => {
    await mainCheckpointGate.startSession("ordinary-delivery");
    pi.entries.length = 0;
    pi.messages.length = 0;
    const marker = path.join(dir, ".claude", ".session-context");
    fs.writeFileSync(marker, "enabled");
    const originalSendMessage = pi.api.sendMessage as (message: any, options?: any) => void;
    (pi.api as any).sendMessage = (message: any, options: any) => {
      if (message?.customType === "picc-hook-context") throw new Error("mandatory delivery failed");
      return originalSendMessage(message, options);
    };
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    });
    try {
      expect(await pi.fire("session_before_compact", { reason: "auto" }, ctx)).toBeUndefined();
      await pi.fire("session_compact", {
        reason: "auto", compactionEntry: { summary: "ordinary committed summary" },
      }, ctx);
    } finally {
      (pi.api as any).sendMessage = originalSendMessage;
      fs.rmSync(marker, { force: true });
    }

    const controller = mainCheckpointGate.currentController();
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
    });
    expect(controller.recoveryToken(controller.snapshot().generation)).toBeUndefined();
    expect(controller.manualCompactionDisposition()).toBe("unavailable");
    expect(pi.messages.some((entry) => entry.message.customType === "picc-checkpoint-continuation")).toBe(false);
    expect(pi.entries.find((entry) => entry.data.category === "checkpoint-exhausted")?.data)
      .toMatchObject({ failureCategory: "restoration-paused", action: "new-session" });
  });

  it("terminalizes an ordinary idle compact when SessionStart universally stops", async () => {
    await mainCheckpointGate.startSession("ordinary-stop");
    pi.entries.length = 0;
    pi.messages.length = 0;
    const marker = path.join(dir, ".claude", ".session-stop");
    fs.writeFileSync(marker, "enabled");
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    });
    try {
      expect(await pi.fire("session_before_compact", { reason: "manual" }, ctx)).toBeUndefined();
      await pi.fire("session_compact", {
        reason: "manual", compactionEntry: { summary: "ordinary committed summary" },
      }, ctx);
    } finally {
      fs.rmSync(marker, { force: true });
    }
    const controller = mainCheckpointGate.currentController();
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
    });
    expect(controller.recoveryToken(controller.snapshot().generation)).toBeUndefined();
    expect(pi.messages.some((entry) => entry.message.customType === "picc-checkpoint-continuation")).toBe(false);
  });

  it("pauses without resummarizing when synchronous active-skill restoration delivery fails", async () => {
    await mainCheckpointGate.startSession("restoration-failure");
    pi.compactCalls.length = 0;
    pi.entries.length = 0;
    pi.messages.length = 0;
    const low = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    });
    await pi.fire("input", {
      text: "/expand restoration", source: "interactive", streamingBehavior: "steer",
    }, low);

    const contextMarker = path.join(dir, ".claude", ".session-context");
    fs.writeFileSync(contextMarker, "enabled");
    const failedDeliveries = new Set<string>();
    const originalSendMessage = pi.api.sendMessage as (message: any, options?: any) => void;
    (pi.api as any).sendMessage = (message: any, options: any) => {
      if (message?.customType === "picc-hook-context" || message?.customType === "picc-preserved") {
        failedDeliveries.add(message.customType);
        throw new Error("synchronous enqueue failure");
      }
      return originalSendMessage(message, options);
    };
    const high = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      compact: (options: any) => {
        pi.compactCalls.push(options);
        void (async () => {
          const before = await pi.fire("session_before_compact", {
            reason: "manual", customInstructions: undefined,
          }, high);
          if (before?.cancel) return options.onError(new Error("cancelled"));
          await pi.fire("session_compact", {
            reason: "manual", compactionEntry: { summary: "committed once" },
          }, high);
          options.onComplete({ summary: "committed once" });
        })();
      },
    });
    try {
      await pi.fire("agent_settled", {}, high);
    } finally {
      (pi.api as any).sendMessage = originalSendMessage;
      fs.rmSync(contextMarker, { force: true });
    }

    expect([...failedDeliveries].sort()).toEqual(["picc-hook-context", "picc-preserved"]);
    const controller = mainCheckpointGate.currentController();
    expect(pi.compactCalls).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted", failureCategory: "restoration-paused", admission: "closed",
    });
    expect(controller.manualCompactionDisposition()).toBe("unavailable");
    expect(controller.recoveryToken(controller.snapshot().generation)).toBeUndefined();
    expect(pi.messages.some((entry) => entry.message.customType === "picc-checkpoint-continuation")).toBe(false);
    const failure = pi.entries.find((entry) => entry.data.category === "checkpoint-exhausted");
    expect(failure?.data).toMatchObject({ failureCategory: "restoration-paused", action: "new-session" });
    expect(String(failure?.data.recovery)).toContain("do not compact");
    await expect(pi.fire("session_before_compact", { reason: "manual" }, high))
      .resolves.toEqual({ cancel: true });
    pi.editorText = "existing draft";
    await expect(pi.fire("input", {
      text: "must stay paused", source: "interactive", streamingBehavior: "steer",
      images: [{ type: "image", mimeType: "image/png", data: "rejected" }],
    }, high)).resolves.toEqual({ action: "handled" });
    expect(pi.editorText).toBe("must stay paused\nexisting draft");
    expect(pi.entries.at(-1)?.data).toMatchObject({
      category: "checkpoint-input-recovery", count: 1, restoredTextCount: 1, unrepresentableCount: 1,
    });
  });

  it("closes after synchronous hidden continuation enqueue failure without a second compaction", async () => {
    await mainCheckpointGate.startSession("continuation-enqueue-failure");
    pi.compactCalls.length = 0;
    const originalSendMessage = pi.api.sendMessage as (message: any, options?: any) => void;
    (pi.api as any).sendMessage = (message: any, options: any) => {
      if (message?.customType === "picc-checkpoint-continuation") {
        throw new Error("hidden startup enqueue failed");
      }
      return originalSendMessage(message, options);
    };
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      compact: (options: any) => {
        pi.compactCalls.push(options);
        void (async () => {
          const before = await pi.fire("session_before_compact", { reason: "manual" }, ctx);
          if (before?.cancel) return options.onError(new Error("cancelled"));
          await pi.fire("session_compact", {
            reason: "manual", compactionEntry: { summary: "committed once" },
          }, ctx);
          options.onComplete({ summary: "committed once" });
        })();
      },
    });
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant", content: [{ type: "toolCall", id: "enqueue", name: "probe", arguments: {} }],
    });
    const wrapped: any = mainCheckpointGate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const result = await wrapped.execute("enqueue", {}, undefined, undefined, ctx);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: "enqueue", result, isError: false });
    mainCheckpointGate.turnEnded(ctx);
    try {
      await pi.fire("agent_settled", {}, ctx);
    } finally {
      (pi.api as any).sendMessage = originalSendMessage;
    }
    const controller = mainCheckpointGate.currentController();
    expect(pi.compactCalls).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({
      phase: "exhausted", failureCategory: "restoration-paused", admission: "closed",
    });
    expect(controller.recoveryToken(controller.snapshot().generation)).toBeUndefined();
    expect(pi.messages.some((entry) => entry.message.customType === "picc-checkpoint-continuation")).toBe(false);
  });

  it(
    "joins main logical cancellation and lets commit dominate onError plus stale onComplete",
    async () => {
      await mainCheckpointGate.startSession("main-late-commit-callbacks");
      pi.compactCalls.length = 0;
      pi.entries.length = 0;
      pi.messages.length = 0;
      const scheduled = deferred<void>();
      const releaseCommit = deferred<void>();
      const commitHandled = deferred<void>();
      const releaseCallback = deferred<void>();
      const ctx = pi.ctx({
        mode: "tui",
        hasUI: true,
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        compact: (options: any) => {
          pi.compactCalls.push(options);
          void (async () => {
            const before = await pi.fire("session_before_compact", { reason: "manual" }, ctx);
            if (before?.cancel) return options.onError(new Error("unexpected pre-commit cancellation"));
            scheduled.resolve();
            await releaseCommit.promise;
            await pi.fire("session_compact", {
              reason: "manual", compactionEntry: { summary: "committed after logical cancellation" },
            }, ctx);
            commitHandled.resolve();
            await releaseCallback.promise;
            options.onError(new Error("private late callback failure"));
            options.onComplete({ summary: "stale callback completion" });
          })();
        },
      });

      let checkpointSettled = false;
      const checkpoint = pi.fire("agent_settled", {}, ctx).then(() => { checkpointSettled = true; });
      await scheduled.promise;
      const controller = mainCheckpointGate.currentController();
      let barrierSettled = false;
      const barrier = controller.stableBarrier(controller.snapshot().generation).then(() => { barrierSettled = true; });
      let cancellationSettled = false;
      const cancellation = mainCheckpointGate.cancel("user").then((outcome) => {
        cancellationSettled = true;
        return outcome;
      });
      await Promise.resolve();
      expect(cancellationSettled).toBe(false);
      expect(checkpointSettled).toBe(false);
      expect(barrierSettled).toBe(false);
      expect(pi.entries.some((entry) => entry.data.category === "checkpoint-cancelled")).toBe(false);
      await expect(pi.fire("input", {
        text: "ordinary request must stay blocked", source: "interactive", streamingBehavior: "steer",
      }, ctx)).resolves.toEqual({ action: "handled" });
      const preCommitNotices = pi.notifications.splice(0);
      expect(preCommitNotices.some(({ text }) => text.includes("still settling"))).toBe(true);
      expect(preCommitNotices.every(({ text }) => !text.includes("/compact"))).toBe(true);

      releaseCommit.resolve();
      await commitHandled.promise;
      await Promise.resolve();
      expect(cancellationSettled).toBe(false);
      expect(checkpointSettled).toBe(false);
      expect(barrierSettled).toBe(false);
      expect(controller.snapshot().phase).toBe("cancelled");
      expect(controller.recoveryToken(controller.snapshot().generation)).toBeUndefined();
      expect(controller.manualCompactionDisposition()).toBe("unavailable");
      expect(pi.entries.some((entry) => entry.data.category === "checkpoint-cancelled")).toBe(false);
      expect(pi.entries.some((entry) => entry.data.category === "checkpoint-exhausted")).toBe(false);
      expect(pi.messages.some((entry) => entry.message.customType === "picc-checkpoint-continuation")).toBe(false);
      await expect(pi.fire("input", {
        text: "still blocked after commit", source: "interactive", streamingBehavior: "steer",
      }, ctx)).resolves.toEqual({ action: "handled" });
      const postCommitNotices = pi.notifications.splice(0);
      expect(postCommitNotices.some(({ text }) => text.includes("still settling"))).toBe(true);
      expect(postCommitNotices.every(({ text }) => !text.includes("/compact"))).toBe(true);

      releaseCallback.resolve();
      await expect(cancellation).resolves.toMatchObject({ cancelled: true });
      await checkpoint;
      await barrier;
      await Promise.resolve();

      expect(pi.compactCalls).toHaveLength(1);
      expect(controller.snapshot()).toMatchObject({
        phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
      });
      expect(controller.recoveryToken(controller.snapshot().generation)).toBeUndefined();
      expect(controller.manualCompactionDisposition()).toBe("unavailable");
      expect(pi.entries.some((entry) => entry.data.category === "checkpoint-cancelled")).toBe(false);
      expect(pi.entries.find((entry) => entry.data.category === "checkpoint-exhausted")?.data)
        .toMatchObject({ action: "new-session", failureCategory: "restoration-paused" });
      expect(pi.messages.some((entry) => entry.message.customType === "picc-checkpoint-continuation")).toBe(false);
      expect(JSON.stringify(pi.entries)).not.toContain("private late callback failure");
      await expect(pi.fire("session_before_compact", { reason: "manual" }, ctx))
        .resolves.toEqual({ cancel: true });
    },
  );

  it("pauses after one failed callback transaction and leaves print recovery persisted", async () => {
    await mainCheckpointGate.startSession("main-exhaustion");
    pi.compactCalls.length = 0;
    pi.entries.length = 0;
    pi.messages.length = 0;
    let enteredOperations = 0;
    const ctx = pi.printCtx({
      sessionManager: {
        getSessionFile: () => path.join(dir, "persisted-session.jsonl"),
        getBranch: () => [],
      },
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      compact: (options: any) => {
        pi.compactCalls.push(options);
        void (async () => {
          const before = await pi.fire("session_before_compact", {
            reason: "manual", customInstructions: undefined,
          }, ctx);
          if (!before?.cancel) enteredOperations += 1;
          options.onError(new Error("provider detail must not surface"));
        })();
      },
    });
    await pi.fire("session_start", { reason: "startup" }, ctx);
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls).toHaveLength(1);
    expect(enteredOperations).toBe(1);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("exhausted");
    const failure = pi.entries.find((entry) =>
      entry.customType === "picc-checkpoint-lifecycle" && entry.data.category === "checkpoint-exhausted");
    // "the exact persisted session" is only actionable if the reader can tell which one
    // it is, and a headless caller has no session picker to browse.
    expect(failure?.data.notice).toContain(
      `reopen the exact persisted session (${path.join(dir, "persisted-session.jsonl")}) before /compact`);
    expect(failure?.data.notice).toContain("Run /compact, then explicitly continue");
    expect(String(failure?.data.notice)).not.toContain("provider detail");
    expect(pi.messages.some((entry) => entry.message.customType === "picc-checkpoint-continuation")).toBe(false);
    await expect(pi.fire("input", {
      text: "must remain paused", source: "interactive", streamingBehavior: "steer",
    }, ctx)).resolves.toEqual({ action: "handled" });

    await expect(pi.fire("session_before_compact", { reason: "manual" }, ctx)).resolves.toBeUndefined();
    await pi.fire("session_compact", {
      reason: "manual", compactionEntry: { summary: "manual recovery" },
    }, ctx);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
    await expect(pi.fire("input", {
      text: "explicit continuation", source: "interactive", streamingBehavior: undefined,
    }, pi.printCtx({
      ...ctx,
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    }))).resolves.toEqual({ action: "continue" });
    await pi.fire("session_start", { reason: "startup" }, pi.printCtx());
  });

  it.each([
    ["Compaction cancelled", "Error"],
    ["aborted", "AbortError"],
  ])("classifies host cancellation without retry or raw detail (%s)", async (message, name) => {
    await mainCheckpointGate.startSession(`host-cancel-${name}`);
    pi.compactCalls.length = 0;
    pi.entries.length = 0;
    const ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      compact: (options: any) => {
        pi.compactCalls.push(options);
        queueMicrotask(() => {
          const error = new Error(message);
          error.name = name;
          options.onError(error);
        });
      },
    });
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls).toHaveLength(1);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("cancelled");
    expect(pi.entries.map((entry) => JSON.stringify(entry.data)).join("\n")).not.toContain(message);

    await pi.fire("session_before_compact", { reason: "manual", customInstructions: undefined }, ctx);
    await pi.fire("session_compact", {
      reason: "manual", compactionEntry: { summary: "recovered" },
    }, ctx);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
  });

  it("restores representable rejected shadows and reports image loss after manual recovery", async () => {
    await mainCheckpointGate.startSession("shadow-recovery");
    pi.entries.length = 0;
    pi.editorText = "existing draft";
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      compact: (options: any) => queueMicrotask(() => options.onError(new Error("offline"))),
    });
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant", content: [{ type: "toolCall", id: "recover", name: "probe", arguments: {} }],
    });
    const wrapped: any = mainCheckpointGate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const result = await wrapped.execute("recover", {}, undefined, undefined, ctx);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: "recover", result, isError: false });
    mainCheckpointGate.turnEnded(ctx);
    mainCheckpointGate.captureAcceptedInput(ctx, "restore me", undefined, "steer");
    mainCheckpointGate.captureAcceptedInput(ctx, "with image", [{ type: "image", data: "x" }], "followUp");
    await pi.fire("agent_settled", {}, ctx);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("exhausted");
    expect(pi.entries.filter((entry) => entry.customType === "picc-proactive-compact").at(-1)?.data)
      .toMatchObject({ severity: "error", notice: expect.stringContaining("could not complete") });

    const presentationBaseline = pi.entries.filter(
      (entry) => entry.customType === "picc-proactive-compact",
    ).length;
    await pi.fire("session_before_compact", { reason: "manual" }, ctx);
    await pi.fire("session_compact", { reason: "manual", compactionEntry: { summary: "manual" } }, ctx);
    expect(pi.editorText).toBe("restore me\nwith image\nexisting draft");
    const report = pi.entries.find((entry) => entry.data.category === "checkpoint-input-recovery");
    expect(report?.data).toMatchObject({ count: 2, restoredTextCount: 2, unrepresentableCount: 1 });
    pi.notifications.length = 0; // Pi's post-compaction rebuild discards transient notifications.
    expect(pi.entries.filter((entry) => entry.customType === "picc-proactive-compact")
      .slice(presentationBaseline).map((entry) => entry.data)).toEqual([
      {
        notice: "Manual compaction recovered the paused session; explicitly continue when ready.",
        severity: "info",
      },
      {
        notice: "2 queued inputs were not replayed; 2 text inputs were restored; remaining input must be resent.",
        severity: "warning",
      },
    ]);
    expect(pi.messages.some((message) => message.message.customType === "picc-proactive-compact")).toBe(false);
  });

  it("keeps exceptional and recovery presentation persistence outside checkpoint authority", async () => {
    pi.entries.length = 0;
    pi.notifications.length = 0;
    pi.editorText = "existing draft";
    const presentationAttempts: Array<{ notice: string; severity: string }> = [];
    const originalAppendEntry = pi.api.appendEntry as (customType: string, data: any) => void;
    pi.api.appendEntry = (customType: string, data: any) => {
      if (customType === "picc-proactive-compact") {
        presentationAttempts.push(data);
        throw new Error("presentation persistence unavailable");
      }
      originalAppendEntry(customType, data);
    };
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      compact: (options: any) => queueMicrotask(() => options.onError(new Error("offline"))),
    });
    try {
      const { controller, generation } = await armCheckpoint(
        ctx,
        "throwing-exceptional-presentation",
        "restore me",
      );
      await pi.fire("agent_settled", {}, ctx);

      expect(controller.snapshot()).toMatchObject({
        generation,
        phase: "exhausted",
        admission: "recoverable-rejection",
        failureCategory: "operational",
      });
      expect(controller.manualCompactionDisposition()).toBe("allow");
      expect(controller.recoveryToken(generation)).toBeDefined();

      await pi.fire("session_before_compact", { reason: "manual" }, ctx);
      await pi.fire("session_compact", {
        reason: "manual", compactionEntry: { summary: "manual" },
      }, ctx);

      expect(controller.snapshot()).toMatchObject({ generation, phase: "idle", admission: "open" });
      expect(controller.ordinaryInputDisposition()).toBe("accept");
      expect(controller.recoveryToken(generation)).toBeUndefined();
      expect(pi.editorText).toBe("restore me\nexisting draft");
      expect(pi.entries.filter((entry) => entry.customType === "picc-proactive-compact")).toEqual([]);
      expect(pi.messages.some((message) =>
        message.message.customType === "picc-proactive-compact")).toBe(false);
      expect(errors).toEqual([]);
      expect(presentationAttempts).toEqual([
        {
          notice: "Automatic context compaction could not complete. Work is paused and no continuation ran. Run /compact, then explicitly continue.",
          severity: "error",
        },
        {
          notice: "Manual compaction recovered the paused session; explicitly continue when ready.",
          severity: "info",
        },
        {
          notice: "1 queued input was not replayed; 1 text input was restored.",
          severity: "info",
        },
      ]);
      expect(pi.notifications).toEqual([
        { text: "Context checkpoint queued; waiting for safe settlement.", severity: "info" },
      ]);
      expect(pi.entries.filter((entry) =>
        entry.customType === "picc-checkpoint-lifecycle" &&
        entry.data.category === "checkpoint-input-recovery").map((entry) => entry.data)).toEqual([
        {
          category: "checkpoint-input-recovery",
          count: 1,
          restoredTextCount: 1,
          unrepresentableCount: 0,
          action: "review-restored-text",
          notice: "1 queued input was not replayed; 1 text input was restored.",
        },
      ]);
    } finally {
      errorSpy.mockRestore();
      pi.api.appendEntry = originalAppendEntry;
    }
  });

  it.each(["print", "json", "rpc"] as const)(
    "preserves the exact manual-recovery compatibility stream in %s mode",
    async (mode) => {
      await mainCheckpointGate.startSession(`manual-recovery-${mode}`);
      pi.entries.length = 0;
      pi.notifications.length = 0;
      const ctx = pi.ctx({
        mode,
        hasUI: mode === "rpc",
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        compact: (options: any) => queueMicrotask(() => options.onError(new Error("offline"))),
      });
      mainCheckpointGate.assistantMessageEnded({
        role: "assistant",
        content: [{ type: "toolCall", id: `recover-${mode}`, name: "probe", arguments: {} }],
      });
      const wrapped: any = mainCheckpointGate.wrapTool({
        name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
      });
      const result = await wrapped.execute(`recover-${mode}`, {}, undefined, undefined, ctx);
      mainCheckpointGate.toolExecutionEnded({ toolCallId: `recover-${mode}`, result, isError: false });
      mainCheckpointGate.turnEnded(ctx);
      mainCheckpointGate.captureAcceptedInput(ctx, "restore me", undefined, "steer");

      const errors: string[] = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
      try {
        await pi.fire("agent_settled", {}, ctx);
        const generation = mainCheckpointGate.currentController().snapshot().generation;
        const entryBaseline = pi.entries.length;
        errors.length = 0;

        await pi.fire("session_before_compact", { reason: "manual" }, ctx);
        await pi.fire("session_compact", {
          reason: "manual", compactionEntry: { summary: "manual" },
        }, ctx);

        const delta = pi.entries.slice(entryBaseline);
        const recovered = delta.filter((entry) =>
          entry.customType === "picc-checkpoint-lifecycle" &&
          entry.data.category === "checkpoint-recovered");
        if (mode === "print") {
          expect(errors).toEqual([
            "PiCC: Manual compaction recovered the paused session; explicitly continue when ready.",
            "PiCC: Manual compaction recovered the paused session; explicitly continue when ready.",
            "PiCC: 1 queued input was not replayed. Resend 1 text input.",
          ]);
          expect(recovered).toEqual([]);
        } else {
          expect(errors).toEqual([]);
          expect(recovered.map((entry) => entry.data)).toEqual([
            {
              category: "checkpoint-recovered",
              generation,
              notice: "Manual compaction recovered the paused session; explicitly continue when ready.",
            },
            {
              category: "checkpoint-recovered",
              generation,
              notice: "Manual compaction recovered the paused session; explicitly continue when ready.",
              action: "manual-recovery",
            },
          ]);
        }
        expect(delta.filter((entry) => entry.customType === "picc-proactive-compact")).toEqual([]);
        expect(pi.messages.some((message) => message.message.customType === "picc-proactive-compact")).toBe(false);
        expect(delta.at(-1)?.data).toMatchObject({
          category: "checkpoint-input-recovery",
          count: 1,
          action: "resend-input",
        });
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it("revalidates same-controller manual compact authority after an awaited PreCompact hook", async () => {
    await mainCheckpointGate.startSession("manual-hook-authority-race");
    const controller = mainCheckpointGate.currentController();
    const gate = path.join(dir, ".claude", "gate-precompact");
    const entered = path.join(dir, ".claude", "precompact-entered");
    const release = path.join(dir, ".claude", "release-precompact");
    const compactTrace = path.join(dir, ".claude", ".compact-trace");
    // `gate-precompact` is the polled kind: a survivor parks every later PreCompact hook in an `sh`
    // poll loop for the full hook timeout, so the guard has to start at the write, not after it.
    // `rmSync` below is force-d against ENOENT only — EPERM/EBUSY on Windows still throws here.
    fs.writeFileSync(gate, "gate");
    let before: Promise<unknown> | undefined;
    try {
      fs.rmSync(compactTrace, { force: true });
      const sentBefore = pi.messages.length;
      const ctx = pi.tuiCtx();
      before = pi.fire("session_before_compact", { reason: "manual" }, ctx);
      await waitUntil({
        description: "PreCompact hook to enter",
        predicate: () => fs.existsSync(entered),
        describeObserved: () => String(fs.existsSync(entered)),
      });
      const generation = controller.sample(
        { tokens: 900, contextWindow: 1000, percent: 90 },
        "settled",
      );
      expect(generation).toBeDefined();
      await expect(controller.cancel(generation!, "user")).resolves.toMatchObject({ cancelled: true });
      expect(mainCheckpointGate.currentController()).toBe(controller);
      expect(controller.snapshot()).toMatchObject({ generation, phase: "cancelled" });

      fs.writeFileSync(release, "release");
      await expect(before).resolves.toEqual({ cancel: true });
      expect(fs.existsSync(compactTrace)).toBe(false);
      expect(pi.messages).toHaveLength(sentBefore);
    } finally {
      fs.writeFileSync(release, "release");
      await before?.catch(() => undefined);
      for (const file of [gate, entered, release, compactTrace]) fs.rmSync(file, { force: true });
    }
  });

  it("does not retry a PreCompact policy block", async () => {
    await mainCheckpointGate.startSession("main-hook-block");
    const marker = path.join(dir, ".claude", "block-compact");
    fs.writeFileSync(marker, "block");
    pi.compactCalls.length = 0;
    const ctx = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      compact: (options: any) => {
        pi.compactCalls.push(options);
        void (async () => {
          const before = await pi.fire("session_before_compact", { reason: "manual" }, ctx);
          if (before?.cancel) options.onError(new Error("cancelled"));
        })();
      },
    });
    pi.entries.length = 0;
    try {
      await pi.fire("agent_settled", {}, ctx);
    } finally {
      fs.rmSync(marker, { force: true });
    }
    expect(pi.compactCalls).toHaveLength(1);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("exhausted");
    expect(pi.entries.filter((entry) => entry.customType === "picc-proactive-compact").at(-1)?.data)
      .toMatchObject({ severity: "error", notice: expect.stringContaining("blocked by a PreCompact hook") });
  });

  it.each([
    ["rpc", "/compact, then explicitly continue", false],
    ["json", "start a replacement session and resend retained input", true],
    ["print", "start a replacement session and resend retained input", true],
  ] as const)("gives non-persisted %s operational exhaustion truthful recovery guidance", async (
    mode, expectedRecovery, ephemeral,
  ) => {
    await mainCheckpointGate.startSession(`main-${mode}-exhaustion`);
    pi.messages.length = 0;
    const ctx = pi.ctx({
      mode,
      hasUI: mode === "rpc",
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      sessionManager: { getEntries: () => [], getBranch: () => [] },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      compact: (options: any) => queueMicrotask(() => options.onError(new Error("private failure"))),
    });
    await pi.fire("session_start", { reason: "startup" }, ctx);
    pi.entries.length = 0;
    await pi.fire("agent_settled", {}, ctx);
    const records = pi.entries.filter((entry) => entry.customType === "picc-checkpoint-lifecycle");
    const exhausted = records.find((entry) => entry.data.category === "checkpoint-exhausted");
    expect(exhausted?.data).toMatchObject({
      action: "manual-recovery", recovery: expect.stringContaining(expectedRecovery),
    });
    if (ephemeral) {
      expect(exhausted?.data.notice).toContain("ephemeral and cannot be reopened");
      expect(exhausted?.data.notice).toContain("start a replacement session");
      expect(exhausted?.data.notice).not.toContain("Run /compact");
    } else {
      expect(exhausted?.data.notice).toContain("live RPC session can run /compact");
      expect(exhausted?.data.notice).toContain("explicitly continue");
      expect(exhausted?.data.notice).not.toContain("replacement session");
    }
    expect(records.map((entry) => entry.data.notice).join("\n")).not.toContain("private failure");
    expect(pi.messages.some((entry) => entry.message.customType === "picc-checkpoint-lifecycle")).toBe(false);
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
    await mainCheckpointGate.defensiveLatch(high);
    const clippedTerminal = { role: "assistant", stopReason: "error", content: [] };
    mainCheckpointGate.assistantMessageEnded(clippedTerminal);
    expect(mainCheckpointGate.consumeDefensiveCutoff(clippedTerminal)).toBe(false);

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

  it("replacement waits for the actual nested settlement instead of pre-resolving resume", async () => {
    await mainCheckpointGate.startSession("replacement-join");
    const ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      compact: (options: any) => queueMicrotask(() => options.onComplete({ summary: "ok" })),
      abort: () => undefined,
    });
    mainCheckpointGate.assistantMessageEnded({
      role: "assistant", content: [{ type: "toolCall", id: "replace", name: "probe", arguments: {} }],
    });
    const wrapped: any = mainCheckpointGate.wrapTool({
      name: "probe", execute: async () => ({ content: [{ type: "text", text: "done" }] }),
    });
    const result = await wrapped.execute("replace", {}, undefined, undefined, ctx);
    mainCheckpointGate.toolExecutionEnded({ toolCallId: "replace", result, isError: false });
    mainCheckpointGate.turnEnded(ctx);
    let outerDone = false;
    const outer = pi.fire("agent_settled", {}, ctx).then(() => { outerDone = true; });
    await waitUntil({
      description: "replacement resumed generation",
      predicate: () => mainCheckpointGate.currentController().snapshot().phase === "resuming",
    });
    let switchDone = false;
    const switching = pi.fire("session_before_switch", {}, ctx).then((value) => {
      switchDone = true;
      return value;
    });
    await Promise.resolve();
    expect(switchDone).toBe(false);
    expect(outerDone).toBe(false);
    await pi.fire("agent_settled", {}, ctx);
    await expect(switching).resolves.toBeUndefined();
    await outer;
    expect(outerDone).toBe(true);
  });

  it("replacement joins authenticated late commit handling before callback settlement", async () => {
    await mainCheckpointGate.startSession("replacement-host-compact");
    pi.entries.length = 0;
    pi.messages.length = 0;
    const started = deferred<void>();
    const releaseCommit = deferred<void>();
    const commitHandled = deferred<void>();
    const releaseCallback = deferred<void>();
    let aborts = 0;
    const ctx = pi.ctx({
      mode: "json",
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      abort: () => { aborts += 1; },
      compact: (options: any) => {
        void (async () => {
          const before = await pi.fire("session_before_compact", {
            reason: "manual", customInstructions: undefined,
          }, ctx);
          if (before?.cancel) return options.onError(new Error("cancelled"));
          started.resolve();
          await releaseCommit.promise;
          await pi.fire("session_compact", {
            reason: "manual", compactionEntry: { summary: "summary" },
          }, ctx);
          commitHandled.resolve();
          await releaseCallback.promise;
          options.onComplete({ summary: "summary" });
        })();
      },
    });
    let settlementDone = false;
    const settlement = pi.fire("agent_settled", {}, ctx).then(() => { settlementDone = true; });
    await started.promise;
    const oldController = mainCheckpointGate.currentController();
    let barrierSettled = false;
    const barrier = oldController.stableBarrier(oldController.snapshot().generation).then(() => { barrierSettled = true; });
    let switched = false;
    const switching = pi.fire("session_before_switch", {}, ctx).then((value) => {
      switched = true;
      return value;
    });
    await Promise.resolve();
    expect(aborts).toBe(1);
    expect(switched).toBe(false);
    expect(settlementDone).toBe(false);
    expect(barrierSettled).toBe(false);
    expect(pi.entries.some((entry) => entry.data.category === "checkpoint-cancelled")).toBe(false);

    releaseCommit.resolve();
    await commitHandled.promise;
    await Promise.resolve();
    expect(switched).toBe(false);
    expect(settlementDone).toBe(false);
    expect(barrierSettled).toBe(false);
    expect(oldController.snapshot().phase).toBe("cancelled");
    expect(oldController.recoveryToken(oldController.snapshot().generation)).toBeUndefined();
    expect(oldController.manualCompactionDisposition()).toBe("unavailable");
    expect(pi.entries.some((entry) => entry.data.category === "checkpoint-cancelled")).toBe(false);
    expect(pi.entries.some((entry) => entry.data.category === "checkpoint-exhausted")).toBe(false);
    expect(pi.messages.some((entry) => entry.message.customType === "picc-checkpoint-continuation")).toBe(false);
    await expect(pi.fire("input", {
      text: "replacement-pending work", source: "interactive", streamingBehavior: "steer",
    }, ctx)).resolves.toEqual({ action: "handled" });

    releaseCallback.resolve();
    await expect(switching).resolves.toBeUndefined();
    await settlement;
    await barrier;
    await Promise.resolve();
    expect(oldController.snapshot()).toMatchObject({
      phase: "exhausted", admission: "closed", failureCategory: "restoration-paused",
    });
    expect(oldController.recoveryToken(oldController.snapshot().generation)).toBeUndefined();
    expect(oldController.manualCompactionDisposition()).toBe("unavailable");
    expect(pi.entries.some((entry) => entry.data.category === "checkpoint-cancelled")).toBe(false);
    expect(pi.entries.find((entry) => entry.data.category === "checkpoint-exhausted")?.data)
      .toMatchObject({ action: "new-session", failureCategory: "restoration-paused" });
    expect(pi.messages.some((entry) => entry.message.customType === "picc-checkpoint-continuation")).toBe(false);
  });

  it("records replacement cancellation in the outgoing session before installing a fresh controller", async () => {
    const high = pi.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      hasPendingMessages: () => false,
      abort: () => undefined,
    });
    await pi.fire("session_start", { reason: "startup" }, high);
    const { controller: old } = await armCheckpoint(high, "event-old", "queued");
    pi.entries.length = 0;
    await pi.fire("session_before_switch", {}, high);
    expect(old.snapshot().phase).toBe("cancelled");
    expect(old.queuedInputSnapshot()).toEqual([]);
    const outgoingPresentation = pi.entries.filter((entry) => entry.customType === "picc-proactive-compact");
    expect(outgoingPresentation).toEqual([
      {
        customType: "picc-proactive-compact",
        data: {
          notice: "Proactive context compaction stopped with the old session; resend input in the new session.",
          severity: "warning",
        },
      },
      {
        customType: "picc-proactive-compact",
        data: {
          notice: "1 queued input was not replayed; 1 text input was restored.",
          severity: "info",
        },
      },
    ]);
    await pi.fire("session_start", { reason: "switch" }, high);
    expect(pi.entries.filter((entry) => entry.customType === "picc-proactive-compact"))
      .toEqual(outgoingPresentation);
    expect(mainCheckpointGate.currentController()).not.toBe(old);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
  });

  it("releases a native operation without session_compact at the next true settlement", async () => {
    await mainCheckpointGate.startSession("native-operation-settlement");
    const ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    });
    await expect(pi.fire("session_before_compact", { reason: "auto" }, ctx)).resolves.toBeUndefined();
    await expect(pi.fire("session_before_compact", {
      reason: "manual", customInstructions: "must not overlap native ownership",
    }, ctx)).resolves.toEqual({ cancel: true });
    await pi.fire("agent_settled", {}, ctx);
    await expect(pi.fire("session_before_compact", {
      reason: "manual", customInstructions: "later transaction",
    }, ctx)).resolves.toBeUndefined();
    await pi.fire("session_compact", {
      reason: "manual", compactionEntry: { summary: "later succeeded" },
    }, ctx);
  });

  it("consumes a stopped unsuccessful settlement before releasing native and logical-run authority", async () => {
    await mainCheckpointGate.startSession("stopped-unsuccessful-native");
    const terminal = {
      role: "assistant",
      content: [{ type: "text", text: "unsuccessful native boundary" }],
      stopReason: "error",
    };
    const ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
      sessionManager: { getBranch: () => [{ type: "message", message: terminal }] },
    });
    await expect(pi.fire("session_before_compact", { reason: "auto" }, ctx)).resolves.toBeUndefined();
    const stoppedAuthority = mainCheckpointGate.captureLogicalRunStop();
    expect(stoppedAuthority()).toBe(true);
    await pi.fire("agent_settled", {}, ctx);
    expect(mainCheckpointGate.isLogicalRunStopped()).toBe(false);
    expect(stoppedAuthority()).toBe(false);
    expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({ phase: "idle", admission: "open" });
    await expect(pi.fire("session_before_compact", {
      reason: "manual", customInstructions: "native identity was released",
    }, ctx)).resolves.toBeUndefined();
    await pi.fire("session_compact", {
      reason: "manual", compactionEntry: { summary: "successor operation" },
    }, ctx);

    await mainCheckpointGate.startSession("ordinary-unsuccessful-authority");
    const ordinaryAuthority = mainCheckpointGate.captureLogicalRunStop();
    await pi.fire("agent_settled", {}, ctx);
    expect(ordinaryAuthority()).toBe(false);
    expect(mainCheckpointGate.currentController().snapshot()).toMatchObject({ phase: "idle", admission: "open" });
  });

  it("keeps manual ownership across stale native events and refuses native overlap", async () => {
    await mainCheckpointGate.startSession("physical-origin-interleavings");
    const ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    });
    await expect(pi.fire("session_before_compact", { reason: "manual" }, ctx)).resolves.toBeUndefined();
    await expect(pi.fire("session_before_compact", { reason: "auto" }, ctx))
      .resolves.toEqual({ cancel: true });
    await pi.fire("session_compact", {
      reason: "auto", compactionEntry: { summary: "stale native completion" },
    }, ctx);
    // The stale old-origin completion neither authenticated nor cleared the live manual.
    await expect(pi.fire("session_before_compact", { reason: "auto" }, ctx))
      .resolves.toEqual({ cancel: true });
    await pi.fire("session_compact", {
      reason: "manual", compactionEntry: { summary: "manual successor" },
    }, ctx);
    await expect(pi.fire("session_before_compact", { reason: "auto" }, ctx)).resolves.toBeUndefined();
    await pi.fire("session_compact", {
      reason: "auto", compactionEntry: { summary: "new native operation" },
    }, ctx);
  });

  it("lets a new manual operation replace a failed current-epoch manual operation", async () => {
    await mainCheckpointGate.startSession("manual-operation-retry");
    const ctx = pi.printCtx();
    await expect(pi.fire("session_before_compact", {
      reason: "manual", customInstructions: "first",
    }, ctx)).resolves.toBeUndefined();
    // Pi publishes no completion event when this user-owned operation fails.
    await expect(pi.fire("session_before_compact", {
      reason: "manual", customInstructions: "second",
    }, ctx)).resolves.toBeUndefined();
    await pi.fire("session_compact", {
      reason: "manual", compactionEntry: { summary: "second succeeded" },
    }, ctx);
    await expect(pi.fire("session_before_compact", {
      reason: "manual", customInstructions: "third",
    }, ctx)).resolves.toBeUndefined();
    await pi.fire("session_compact", {
      reason: "manual", compactionEntry: { summary: "third succeeded" },
    }, ctx);
  });

  it("does not let a failed manual operation lock switching and ignores its stale completion", async () => {
    await mainCheckpointGate.startSession("manual-operation-old");
    const oldCtx = pi.printCtx();
    await expect(pi.fire("session_before_compact", {
      reason: "manual", customInstructions: "manual detail",
    }, oldCtx)).resolves.toBeUndefined();
    fs.rmSync(path.join(dir, ".claude", ".compact-trace"), { force: true });
    pi.messages.length = 0;

    await expect(pi.fire("session_before_switch", {}, oldCtx)).resolves.not.toEqual({ cancel: true });
    await pi.fire("session_start", { reason: "switch" }, pi.printCtx());
    await pi.fire("session_compact", {
      reason: "manual", compactionEntry: { summary: "stale summary" },
    }, oldCtx);
    expect(fs.existsSync(path.join(dir, ".claude", ".compact-trace"))).toBe(false);
    expect(pi.messages.some((entry) => ["picc-hook-context", "picc-preserved"]
      .includes(entry.message.customType))).toBe(false);
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

  it("keeps activation deny effects across synthetic continuation and expires them on accepted user input", async () => {
    await mainCheckpointGate.startSession("deny-cadence");
    const ctx = pi.ctx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    });
    await pi.fire("input", {
      text: "/deny-once", source: "interactive", streamingBehavior: undefined,
    }, ctx);
    expect(await pi.fire("tool_call", { toolName: "bash", toolCallId: "d1", input: { command: "blocked-now" } }, ctx))
      .toMatchObject({ block: true });
    await pi.fire("input", {
      text: "synthetic", source: "extension", streamingBehavior: undefined,
    }, ctx);
    expect(await pi.fire("tool_call", { toolName: "bash", toolCallId: "d2", input: { command: "blocked-now" } }, ctx))
      .toMatchObject({ block: true });
    await pi.fire("input", {
      text: "next user turn", source: "interactive", streamingBehavior: undefined,
    }, ctx);
    expect(await pi.fire("tool_call", { toolName: "bash", toolCallId: "d3", input: { command: "blocked-now" } }, ctx))
      .toBeUndefined();
  });

  it("shadows accepted post-transform streaming input but never blocked or handled command input", async () => {
    fs.rmSync(path.join(dir, "input-hook-count"), { force: true });
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

    await expect(pi.fire("input", {
      text: "mode-less", source: "interactive", streamingBehavior: undefined,
    }, high)).resolves.toEqual({ action: "continue" });
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
    expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([]);
    await pi.fire("message_start", {
      message: { role: "user", content: [{ type: "text", text: "mode-less" }] },
    }, high);
    await expect(pi.fire("input", {
      text: "unauthenticated extension", source: "extension", streamingBehavior: "steer",
    }, high)).resolves.toEqual({ action: "continue" });

    for (const streamingBehavior of ["followUp", "followUp", "steer", "steer"] as const) {
      await expect(pi.fire("input", {
        text: "identical", source: "interactive", streamingBehavior,
      }, high)).resolves.toEqual({ action: "continue" });
      await pi.fire("message_start", {
        message: { role: "user", content: [{ type: "text", text: "identical" }] },
      }, high);
    }
    expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([]);

    const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const transformed = await pi.fire("input", {
      text: "/expand once", source: "interactive", streamingBehavior: "followUp", images: [image],
    }, high);
    expect(transformed).toMatchObject({ action: "transform", images: [image] });
    expect((transformed as { text: string }).text).toContain("Expanded: once");
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
    expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([]);
  });
});

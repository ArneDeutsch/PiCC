import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc, { writeFdFully } from "../src/index.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { deferred, waitUntil } from "./helpers/async.js";
import {
  MainSessionCheckpointGate,
  MidRunCompactionController,
  callbackCompactionAttempt,
  promiseCompactionAttempt,
  type CompactionAttemptResult,
  type MidRunCompactionOptions,
} from "../src/runtime/mid-run-compaction.js";

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
    const modeLess = gate.captureAcceptedInput(ctx, "mode-less", undefined, undefined)!;
    expect(modeLess.delivery).toBe("followUp");
    expect(gate.userMessageStarted({ role: "user", content: first.content })).toBe(first);
    expect(controller.queuedInputSnapshot()).toEqual([second, modeLess]);
    expect(gate.userMessageStarted({ role: "user", content: second.content })).toBe(second);
    expect(gate.userMessageStarted({ role: "user", content: modeLess.content })).toBe(modeLess);
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

  it("refuses to mint or consume replay authorization outside the resuming phase", () => {
    const { gate } = setup();
    gate.assistantMessageEnded(assistant("a"));
    const ctx = { model: { api: "openai-responses" }, getContextUsage: () => usage };
    const image = { type: "image", data: "one", mimeType: "image/png" };
    const shadow = gate.captureAcceptedInput(ctx, "accepted", [image], "steer")!;
    expect(() => gate.withReplayAuthorization(shadow, () => undefined)).toThrow(/stale/);
    expect(gate.authorizeReplay({
      text: "accepted", images: [image], source: "extension", streamingBehavior: "steer",
    })).toBeUndefined();
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
    const shadow = gate.captureAcceptedInput(ctx, "queued", undefined, "steer")!;
    const authorize = deferred<void>();
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
  const originalCwd = process.cwd();
  const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

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

  it("handles and reports concurrent input while settled fallback cannot shadow it", async () => {
    await mainCheckpointGate.startSession("settled-fallback-input");
    pi.entries.length = 0;
    pi.compactCalls.length = 0;
    const release = deferred<void>();
    const ctx = pi.printCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      compact: (options: any) => {
        pi.compactCalls.push(options);
        void (async () => {
          const before = await pi.fire("session_before_compact", {
            reason: "manual", customInstructions: undefined,
          }, ctx);
          if (before?.cancel) return options.onError(new Error("cancelled"));
          await release.promise;
          await pi.fire("session_compact", {
            reason: "manual", compactionEntry: { summary: "fallback summary" },
          }, ctx);
          options.onComplete({ summary: "fallback summary" });
        })();
      },
    });
    const settlement = pi.fire("agent_settled", {}, ctx);
    await waitUntil({
      description: "settled fallback compaction",
      predicate: () => pi.compactCalls.length > 0,
    });
    await expect(pi.fire("input", {
      text: "arrived during fallback", source: "interactive", streamingBehavior: undefined,
    }, ctx)).resolves.toEqual({ action: "handled" });
    expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([]);
    expect(pi.entries).toContainEqual(expect.objectContaining({
      customType: "picc-checkpoint-lifecycle",
      data: expect.objectContaining({ category: "checkpoint-input-recovery", count: 1 }),
    }));
    release.resolve();
    await settlement;
  });

  it("awaits callback compaction, hidden resume, replay, and nested settlement", async () => {
    await mainCheckpointGate.startSession("main-resume");
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
      if (typeof content !== "string" || !content.startsWith("[Stop hook]")) return;
      if (!capturedStaleStopInput) {
        capturedStaleStopInput = true;
        stopAdmissionResults.push(pi.fire("input", {
          text: content, source: "extension", images: [{ type: "image", data: "mismatch" }],
          streamingBehavior: undefined,
        }, high));
        stopAdmissionResults.push(pi.fire("input", {
          text: content, source: "extension", images: undefined, streamingBehavior: "followUp",
        }, high));
        stopAdmissionResults.push(staleStopInput.promise.then(() => pi.fire("input", {
          text: content, source: "extension", images: undefined, streamingBehavior: undefined,
        }, high)));
      }
      stopAdmissionResults.push(pi.fire("input", {
        text: content, source: "extension", images: undefined, streamingBehavior: undefined,
      }, high));
      stopAdmissionResults.push(pi.fire("input", {
        text: content, source: "extension", images: undefined, streamingBehavior: undefined,
      }, high));
    };
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
    fs.writeFileSync(stopMarker, "block");
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
    fs.rmSync(stopMarker, { force: true });
    await outer;
    await mainCheckpointGate.startSession("stop-admission-stale-epoch");
    staleStopInput.resolve();
    const admission = await Promise.all(stopAdmissionResults);
    expect(admission.filter((result) => (result as any)?.action === "continue")).toHaveLength(8);
    expect(admission.filter((result) => (result as any)?.action === "handled")).toHaveLength(11);
    expect(outerDone).toBe(true);
    expect(fs.existsSync(inputHookCount)).toBe(false);
    expect(controller.snapshot().phase).toBe("idle");
    expect(fs.readFileSync(trace, "utf8").trim().split(/\r?\n/)).toEqual(["pre", "start", "post"]);
    pi.api.sendMessage = originalSendMessage;
    pi.api.sendUserMessage = originalSendUserMessage;
  });

  it("bridges a successful resumed print result exactly once and hides every unsafe settlement", async () => {
    const runResume = async (
      sessionId: string,
      mode: "print" | "json" | "rpc",
      message: Record<string, unknown>,
    ) => {
      await mainCheckpointGate.startSession(sessionId);
      const ctx = pi.ctx({
        mode,
        hasUI: mode === "rpc",
        model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
        getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => [{ type: "message", message }] },
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
      await Promise.all([
        pi.fire("agent_settled", {}, { ...ctx }),
        pi.fire("agent_settled", {}, { ...ctx }),
      ]);
      await outer;
      await pi.fire("agent_settled", {}, { ...ctx });
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
      await runResume("json-safe", "json", {
        role: "assistant", content: [{ type: "text", text: "machine result" }], stopReason: "stop",
      });
    } finally {
      writeSpy.mockRestore();
    }

    expect(writes).toEqual(["resumed one\nresumed two\n"]);
    expect(writes.join("\n")).not.toMatch(/thinking|secret-sentinel|private|transcript/);
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
    const writeSpy = vi.spyOn(fs, "write").mockImplementation(((fd: any, data: any, offset: any, length: any, position: any, callback: any) => {
      if (fd === process.stdout.fd && Buffer.isBuffer(data)) {
        staleWrites.push(data.subarray(offset, offset + length).toString("utf8"));
        queueMicrotask(() => callback(null, length, data));
        return;
      }
      return originalWrite(fd, data, offset, length, position, callback);
    }) as typeof fs.write);

    const gate = path.join(dir, ".claude", "gate-stop");
    const entered = path.join(dir, ".claude", "stop-entered");
    const release = path.join(dir, ".claude", "release-stop");
    fs.writeFileSync(gate, "gate");
    const nested = pi.fire("agent_settled", {}, { ...ctx });
    await waitUntil({ description: "Stop hook gate entry", predicate: () => fs.existsSync(entered) });
    const replacement = mainCheckpointGate.startSession("replacement-during-stop");
    fs.writeFileSync(release, "release");
    await nested;
    await replacement;
    await outer;
    writeSpy.mockRestore();
    fs.rmSync(gate, { force: true });
    fs.rmSync(entered, { force: true });
    fs.rmSync(release, { force: true });

    expect(staleWrites).toEqual([]);
    expect(pi.messages.filter((entry) => entry.message.customType === "picc-checkpoint-print-result")).toHaveLength(markerCountBefore);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
  });

  it("unwinds a resumed Stop universal stop before joining its exact resume settlement", async () => {
    await mainCheckpointGate.startSession("resumed-stop-deadlock");
    const marker = path.join(dir, ".claude", "universal-stop");
    fs.writeFileSync(marker, "stop");
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
    try {
      await pi.fire("agent_settled", {}, ctx);
      await outer;
    } finally {
      fs.rmSync(marker, { force: true });
    }
    expect(mainCheckpointGate.isLogicalRunStopped()).toBe(false);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
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
    let releaseWrite!: () => void;
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

      const replacement = mainCheckpointGate.startSession("replacement-before-queued-print-write");
      await waitUntil({
        description: "queued print authority cancellation",
        predicate: () => mainCheckpointGate.currentController().snapshot().phase === "cancelled",
      });
      releaseWrite();
      await Promise.all([firstSettlement, queuedSettlement, outer, replacement]);
    } finally {
      writeSpy.mockRestore();
    }

    expect(attemptedWrites).toEqual(["tail blocker\n"]);
    expect(attemptedWrites.join("")).not.toContain("stale queued result");
    expect(markerCount()).toBe(markersBefore);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("idle");
    expect(mainCheckpointGate.currentController().snapshot().admission).toBe("open");
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
    await expect(pi.fire("agent_settled", {}, { ...ctx })).resolves.toBeUndefined();
    failedWrite.mockRestore();
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
      sessionManager: { getSessionFile: () => path.join(dir, "persisted-session.jsonl") },
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
    expect(failure?.data.notice).toContain("reopen the exact persisted session before /compact");
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

    await pi.fire("session_before_compact", { reason: "manual" }, ctx);
    await pi.fire("session_compact", { reason: "manual", compactionEntry: { summary: "manual" } }, ctx);
    expect(pi.editorText).toBe("restore me\nwith image\nexisting draft");
    const report = pi.entries.find((entry) => entry.data.category === "checkpoint-input-recovery");
    expect(report?.data).toMatchObject({ count: 2, restoredTextCount: 2, unrepresentableCount: 1 });
    expect(pi.notifications.at(-1)?.text).toContain("must be resent");
  });

  it("revalidates same-controller manual compact authority after an awaited PreCompact hook", async () => {
    await mainCheckpointGate.startSession("manual-hook-authority-race");
    const controller = mainCheckpointGate.currentController();
    const gate = path.join(dir, ".claude", "gate-precompact");
    const entered = path.join(dir, ".claude", "precompact-entered");
    const release = path.join(dir, ".claude", "release-precompact");
    const compactTrace = path.join(dir, ".claude", ".compact-trace");
    fs.writeFileSync(gate, "gate");
    fs.rmSync(compactTrace, { force: true });
    const sentBefore = pi.messages.length;
    const ctx = pi.tuiCtx();
    const before = pi.fire("session_before_compact", { reason: "manual" }, ctx);
    try {
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
      await before.catch(() => undefined);
      for (const file of [gate, entered, release, compactTrace]) fs.rmSync(file, { force: true });
    }
  });

  it("does not retry a PreCompact policy block", async () => {
    await mainCheckpointGate.startSession("main-hook-block");
    const marker = path.join(dir, ".claude", "block-compact");
    fs.writeFileSync(marker, "block");
    pi.compactCalls.length = 0;
    const ctx = pi.printCtx({
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
    try {
      await pi.fire("agent_settled", {}, ctx);
    } finally {
      fs.rmSync(marker, { force: true });
    }
    expect(pi.compactCalls).toHaveLength(1);
    expect(mainCheckpointGate.currentController().snapshot().phase).toBe("exhausted");
  });

  it.each(["rpc", "json"] as const)("emits uncorrelated %s lifecycle records on exhaustion", async (mode) => {
    await mainCheckpointGate.startSession(`main-${mode}-exhaustion`);
    pi.messages.length = 0;
    const ctx = pi.ctx({
      mode,
      hasUI: mode === "rpc",
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      sessionManager: { getEntries: () => [] },
      getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }),
      compact: (options: any) => queueMicrotask(() => options.onError(new Error("private failure"))),
    });
    await pi.fire("session_start", { reason: "startup" }, ctx);
    await pi.fire("agent_settled", {}, ctx);
    const records = pi.entries.filter((entry) => entry.customType === "picc-checkpoint-lifecycle");
    expect(records.some((entry) => entry.data.category === "checkpoint-exhausted")).toBe(true);
    expect(records.at(-1)?.data.notice).toContain("ephemeral and cannot be reopened");
    expect(records.at(-1)?.data.notice).toContain("start a replacement session");
    expect(records.at(-1)?.data.notice).not.toContain("Run /compact");
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
    }, high)).resolves.toEqual({ action: "handled" });
    await expect(pi.fire("input", {
      text: "unauthenticated extension", source: "extension", streamingBehavior: "steer",
    }, high)).resolves.toEqual({ action: "handled" });
    const [modeLess] = mainCheckpointGate.currentController().queuedInputSnapshot();
    expect(modeLess).toMatchObject({ content: "mode-less", delivery: "followUp" });
    await pi.fire("message_start", {
      message: { role: "user", content: "mode-less" }, streamingBehavior: "followUp",
    }, high);
    expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([]);

    const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const transformed = await pi.fire("input", {
      text: "/expand once", source: "interactive", streamingBehavior: "followUp", images: [image],
    }, high);
    expect(transformed).toEqual({ action: "handled" });
    const [shadow] = mainCheckpointGate.currentController().queuedInputSnapshot();
    expect(shadow?.delivery).toBe("followUp");
    expect(Array.isArray(shadow?.content)).toBe(true);
    const transformedText = (shadow?.content as any[])[0]?.text;
    expect(transformedText).toContain("Expanded: once");
    expect(transformedText.match(/Expanded:/g)).toHaveLength(1);
    expect(shadow?.content).toEqual([{ type: "text", text: transformedText }, image]);
    expect(() => mainCheckpointGate.withReplayAuthorization(shadow!, () => pi.fire("input", {
      text: transformedText, source: "extension", streamingBehavior: "followUp", images: [image],
    }, high))).toThrow(/stale/);
    expect(fs.readFileSync(path.join(dir, "input-hook-count"), "utf8")).toBe("xxx");
    expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([shadow]);
    await pi.fire("message_start", {
      message: { role: "user", content: shadow?.content }, streamingBehavior: "followUp",
    }, high);
    expect(mainCheckpointGate.currentController().queuedInputSnapshot()).toEqual([]);
  });
});

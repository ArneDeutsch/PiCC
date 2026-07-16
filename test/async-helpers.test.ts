import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, waitUntil } from "./helpers/async.js";
import { fakePi } from "./helpers/fake-pi.js";
import { fakeSdk } from "./helpers/fake-sdk.js";

function registerTool(pi: ReturnType<typeof fakePi>, name: string): void {
  (pi.api.registerTool as (tool: { name: string }) => void)({ name });
}

describe("async test readiness helpers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("settles a deferred only once", async () => {
    const value = deferred<number>();
    value.resolve(7);
    value.resolve(8);
    value.reject(new Error("too late"));

    await expect(value.promise).resolves.toBe(7);
  });

  it("preserves a deferred's first rejection", async () => {
    const sentinel = new Error("first rejection");
    const value = deferred<number>();
    const rejection = expect(value.promise).rejects.toBe(sentinel);

    value.reject(sentinel);
    value.resolve(7);
    value.reject(new Error("too late"));

    await rejection;
  });

  it("waitUntil resolves immediately when readiness already holds", async () => {
    await waitUntil({ description: "ready flag", predicate: () => true });
  });

  it("waitUntil resolves from event-driven delayed readiness", async () => {
    const ready = deferred<void>();
    const waiting = waitUntil({
      description: "readiness event",
      predicate: () => ready.promise.then(() => true),
    });

    expect(vi.getTimerCount()).toBe(1);
    ready.resolve();
    await waiting;
  });

  it("waitUntil retries a synchronous predicate until it becomes true", async () => {
    let attempts = 0;
    const waiting = waitUntil({
      description: "third predicate attempt",
      predicate: () => ++attempts === 3,
    });

    await Promise.resolve();
    expect(attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(10);
    expect(attempts).toBe(2);
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(10);
    await waiting;
    expect(attempts).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports expected and final observed state when the safety ceiling expires", async () => {
    let started = 1;
    const waiting = waitUntil({
      description: "three workers to start",
      predicate: () => false,
      describeObserved: () => `started: ${started}`,
      timeoutMs: 25,
    });
    const rejection = expect(waiting).rejects.toThrow(
      "Timed out after 25ms waiting for three workers to start; observed: started: 2",
    );

    started = 2;
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("propagates a synchronous predicate error unchanged", async () => {
    const sentinel = new Error("predicate failed");
    const waiting = waitUntil({
      description: "never reached",
      predicate: () => {
        throw sentinel;
      },
    });

    await expect(waiting).rejects.toBe(sentinel);
  });

  it("propagates an asynchronous predicate rejection unchanged", async () => {
    const sentinel = new Error("event source failed");
    const event = deferred<boolean>();
    const waiting = waitUntil({
      description: "event source",
      predicate: () => event.promise,
    });

    event.reject(sentinel);
    await expect(waiting).rejects.toBe(sentinel);
  });

  it("FakeSdkHandle observes prompt entry before a scripted gate", async () => {
    const gate = deferred<void>();
    const handle = fakeSdk({ replies: [{ text: "done", gate: gate.promise }] });
    const { session } = await handle.sdk.createAgentSession({});
    const waiting = handle.waitForPromptCalls(1);
    const prompt = session.prompt("work");

    await waiting;
    expect(handle.promptCalls()).toBe(1);
    expect(handle.sessions[0]?.messages).toEqual([{ role: "user", content: "work" }]);

    gate.resolve();
    await prompt;
  });

  it("FakeSdkHandle supports readiness that predates the call and simultaneous thresholds", async () => {
    const handle = fakeSdk({ replies: ["first done", "second done"] });
    const { session } = await handle.sdk.createAgentSession({});
    const first = handle.waitForPromptCalls(1);
    const second = handle.waitForPromptCalls(2);
    let firstSettled = false;
    let secondSettled = false;
    void first.then(() => (firstSettled = true));
    void second.then(() => (secondSettled = true));

    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    await session.prompt("first");
    await first;
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(false);

    await session.prompt("second");
    await second;
    expect(secondSettled).toBe(true);
    await handle.waitForPromptCalls(2);
  });

  it("FakeSdkHandle timeout reports expected and final actual prompt counts", async () => {
    const handle = fakeSdk({ replies: ["done"] });
    const { session } = await handle.sdk.createAgentSession({});
    const waiting = handle.waitForPromptCalls(2);
    const rejection = expect(waiting).rejects.toThrow(
      /prompt call count to reach 2; observed: expected: 2; actual: 1/,
    );

    await session.prompt("first");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it("FakePi observes later registration for simultaneous thresholds", async () => {
    const pi = fakePi();
    const first = pi.waitForTools(["Read"]);
    const second = pi.waitForTools(["Read", "Write"]);
    let firstSettled = false;
    let secondSettled = false;
    void first.then(() => (firstSettled = true));
    void second.then(() => (secondSettled = true));

    await Promise.resolve();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    registerTool(pi, "Read");
    await first;
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(false);

    registerTool(pi, "Write");
    await second;
    expect(secondSettled).toBe(true);
  });

  it("FakePi resolves immediately when tools are already registered", async () => {
    const pi = fakePi();
    registerTool(pi, "Read");

    await pi.waitForTools(["Read"]);
    await pi.waitForTools([]);
  });

  it("FakePi waits for captured initialization completion rather than capture alone", async () => {
    const pi = fakePi();
    const completion = deferred<void>();
    pi.captureInitialization(completion.promise);

    const waiting = pi.waitForInitialization();
    let settled = false;
    void waiting.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    completion.resolve();
    await waiting;
    expect(settled).toBe(true);
  });

  it("FakePi supports waiting before initialization completion is captured", async () => {
    const pi = fakePi();
    const completion = deferred<void>();
    const waiting = pi.waitForInitialization();
    let settled = false;
    void waiting.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    pi.captureInitialization(completion.promise);
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);

    completion.resolve();
    await waiting;
    expect(settled).toBe(true);
  });

  it("FakePi reports when initialization completion was never captured", async () => {
    const pi = fakePi();
    const waiting = pi.waitForInitialization();
    const rejection = expect(waiting).rejects.toThrow(
      /extension detached initialization to be captured and settled; observed: completion callback not captured/,
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it("FakePi timeout reports final missing and registered tool names", async () => {
    const pi = fakePi();
    const waiting = pi.waitForTools(["Read", "Write"]);
    const rejection = expect(waiting).rejects.toThrow(
      /tools to be registered: Read, Write; observed: missing: Write; registered: Read/,
    );

    registerTool(pi, "Read");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });
});

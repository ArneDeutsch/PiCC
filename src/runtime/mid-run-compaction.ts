/** Session-local coordination for proactive mid-run context checkpoints. */

import type { ContextUsageShape } from "./proactive-compaction.js";

export type CheckpointPhase =
  | "idle"
  | "armed"
  | "stopping"
  | "awaiting-settlement"
  | "compacting"
  | "backoff"
  | "resuming"
  | "exhausted"
  | "cancelled";

export type QueueDeliveryMode = "steer" | "followUp";
export type QueueContent = string | readonly unknown[];
export type CheckpointSource = "tool" | "settled";
export type CancellationKind = "user" | "task-stop" | "shutdown" | "replacement";
export type CompactionFailureCategory =
  | "operational"
  | "cancelled"
  | "hook-blocked"
  | "stale-generation"
  | "shutdown"
  | "overflow-recovery";
export type CheckpointDiagnosticCategory =
  | "checkpoint-armed"
  | "checkpoint-retrying"
  | "checkpoint-complete"
  | "checkpoint-exhausted"
  | "checkpoint-cancelled"
  | "checkpoint-recovered";

export type CompactionAttemptResult =
  | { ok: true }
  | { ok: false; category: CompactionFailureCategory };

export interface QueuedInputShadow {
  id: number;
  generation: number;
  sessionId: string;
  content: QueueContent;
  delivery: QueueDeliveryMode;
}

export interface CheckpointProgress {
  category: CheckpointDiagnosticCategory;
  generation: number;
  attempt?: number;
}

export interface CheckpointSnapshot {
  generation: number;
  phase: CheckpointPhase;
  attempt: number;
  checkpointAbortRequested: boolean;
  queuedInputs: number;
  admission: "open" | "checkpoint-only" | "recoverable-rejection" | "closed";
}

export interface ToolBatchDisposition {
  generation: number;
  complete: boolean;
  stop: "none" | "terminate" | "abort";
}

/** Identity, rather than its fields, authenticates a callback to its batch. */
export interface ToolBatchHandle {
  readonly generation: number;
  readonly token: object;
}

/** Identity, rather than its fields, authenticates explicit recovery. */
export interface RecoveryToken {
  readonly generation: number;
  readonly token: object;
}

export interface ResumeToken {
  readonly generation: number;
  readonly token: object;
}

export interface ResumeContext {
  generation: number;
  token: ResumeToken;
  signal: AbortSignal;
}

export interface ReplayContext extends ResumeContext {}

export type ReplayDeliveryResult = { delivered: true } | { delivered: false };

/**
 * A resumed run owns replay and cancellation. Callback runs omit `settled` and transfer
 * their nested settlement with `resumedSettled`; Promise runs provide `settled`.
 */
export interface ResumedRunOwnership {
  replay(input: QueuedInputShadow, context: ReplayContext): ReplayDeliveryResult | Promise<ReplayDeliveryResult>;
  settled?: Promise<void>;
  cancelAndJoin(kind: CancellationKind, context: ResumeContext): void | Promise<void>;
}

export interface ManualCompactionOwnership {
  kind: "available";
  isActive(): boolean;
  waitAndResample(context: { generation: number; signal: AbortSignal }): Promise<{
    ended: boolean;
    usage: ContextUsageShape | undefined;
  }>;
}

export type ManualCompactionCapability = ManualCompactionOwnership | { kind: "unavailable" };
export type OrdinaryInputDisposition = "accept" | "quarantine" | "reject-recoverable" | "reject-closed";
export type ManualCompactionDisposition = "allow" | "already-active" | "unavailable";

export interface CancellationOutcome {
  cancelled: boolean;
  rejected: readonly QueuedInputShadow[];
}

export interface MidRunCompactionOptions {
  sessionId: string;
  threshold: number;
  compact(attempt: number, signal: AbortSignal): Promise<CompactionAttemptResult>;
  resume?(context: ResumeContext): ResumedRunOwnership | Promise<ResumedRunOwnership>;
  delay?(milliseconds: number, signal: AbortSignal): Promise<void>;
  backoffMs?: readonly number[];
  progress?(event: CheckpointProgress): void;
  manualCompaction: ManualCompactionCapability;
}

interface ToolState {
  finalized: boolean;
  owned: boolean;
  canTerminate: boolean;
}

interface ActiveBatch {
  handle: ToolBatchHandle;
  malformed: boolean;
  tools: Map<string, ToolState>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // A caller may capture the barrier after a synchronous failure transition.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

interface CancellationState {
  generation: number;
  kind: CancellationKind;
  outcome: Deferred<CancellationOutcome>;
  join?: Promise<void>;
  finishing?: Promise<void>;
}

interface RunOwnership {
  generation: number;
  token: object;
  settled: Deferred<void>;
}

function defaultDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function usageIsKnown(usage: ContextUsageShape | undefined): usage is ContextUsageShape & { percent: number } {
  return typeof usage?.percent === "number" && Number.isFinite(usage.percent);
}

function usageMeetsThreshold(usage: ContextUsageShape | undefined, threshold: number): boolean {
  return usageIsKnown(usage) && usage.percent >= threshold;
}

const NON_RETRYABLE = new Set<CompactionFailureCategory>([
  "cancelled",
  "hook-blocked",
  "stale-generation",
  "shutdown",
  "overflow-recovery",
]);

/** Coordinates one session's checkpoint generation and leaves Pi-specific wiring to callers. */
export class MidRunCompactionController {
  readonly sessionId: string;
  readonly threshold: number;

  private generation = 0;
  private phase: CheckpointPhase = "idle";
  private attempt = 0;
  private activeBatch: ActiveBatch | undefined;
  private queue: QueuedInputShadow[] = [];
  private nextQueueId = 1;
  private checkpointAbortRequested = false;
  private runAbort = new AbortController();
  private stable: Deferred<void> | undefined;
  private runOwnership: RunOwnership | undefined;
  private fallback = false;
  private resumeToken: ResumeToken | undefined;
  private resumedSettlement: Deferred<void> | undefined;
  private queueChanged = deferred();
  private recovery: RecoveryToken | undefined;
  private resumedOwnership: ResumedRunOwnership | undefined;
  private resumeContext: ResumeContext | undefined;
  private cancellation: CancellationState | undefined;

  constructor(private readonly options: MidRunCompactionOptions) {
    this.sessionId = options.sessionId;
    this.threshold = options.threshold;
  }

  snapshot(): CheckpointSnapshot {
    return {
      generation: this.generation,
      phase: this.phase,
      attempt: this.attempt,
      checkpointAbortRequested: this.checkpointAbortRequested,
      queuedInputs: this.queue.length,
      admission: this.phase === "exhausted"
        ? "recoverable-rejection"
        : this.phase === "cancelled"
          ? "closed"
          : this.phase === "idle"
            ? "open"
            : "checkpoint-only",
    };
  }

  sample(usage: ContextUsageShape | undefined, source: CheckpointSource): number | undefined {
    if (this.phase !== "idle" || this.queue.length !== 0 || !usageMeetsThreshold(usage, this.threshold)) {
      return undefined;
    }
    this.generation += 1;
    this.phase = source === "tool" ? "armed" : "awaiting-settlement";
    this.attempt = 0;
    this.activeBatch = undefined;
    this.checkpointAbortRequested = false;
    this.runAbort = new AbortController();
    this.stable = deferred();
    this.fallback = source === "settled";
    this.resumeToken = undefined;
    this.resumedSettlement = undefined;
    this.queueChanged = deferred();
    this.recovery = undefined;
    this.resumedOwnership = undefined;
    this.resumeContext = undefined;
    this.cancellation = undefined;
    this.emit("checkpoint-armed");
    return this.generation;
  }

  beginToolBatch(generation: number, toolCallIds: readonly string[]): ToolBatchHandle | undefined {
    if (generation !== this.generation || this.phase !== "armed") return undefined;
    this.phase = "stopping";
    const handle = { generation: this.generation, token: {} };
    const unique = new Set(toolCallIds);
    const malformed = toolCallIds.length === 0 || unique.size !== toolCallIds.length || unique.has("");
    this.activeBatch = {
      handle,
      malformed,
      tools: new Map([...unique].filter((id) => id !== "").map((id) => [id, {
        finalized: false,
        owned: false,
        canTerminate: false,
      }])),
    };
    return handle;
  }

  finalizeTool(handle: ToolBatchHandle, toolCallId: string, result: { owned: boolean; canTerminate: boolean }): boolean {
    const batch = this.currentBatch(handle);
    if (!batch) return false;
    const state = batch.tools.get(toolCallId);
    if (!state || state.finalized) {
      batch.malformed = true;
      return false;
    }
    state.finalized = true;
    state.owned = result.owned;
    state.canTerminate = result.canTerminate;
    return true;
  }

  /** Add only Pi's stop bit; canonical content/details/error fields retain identity. */
  terminateResult<T extends Record<string, unknown>>(
    handle: ToolBatchHandle,
    toolCallId: string,
    result: T,
  ): T & { terminate?: true } {
    const batch = this.currentBatch(handle);
    const state = batch?.tools.get(toolCallId);
    if (batch && !batch.malformed && state?.finalized && state.owned && state.canTerminate) {
      return { ...result, terminate: true };
    }
    return result;
  }

  /** Requesting completion closes malformed, unknown, duplicate, empty, and incomplete batches by abort. */
  completeToolBatch(handle: ToolBatchHandle): ToolBatchDisposition {
    const batch = this.currentBatch(handle);
    if (!batch) return { generation: this.generation, complete: false, stop: "none" };
    const states = [...batch.tools.values()];
    const clean = !batch.malformed && states.length > 0 &&
      states.every((state) => state.finalized && state.owned && state.canTerminate);
    this.phase = "awaiting-settlement";
    this.checkpointAbortRequested = !clean;
    return { generation: this.generation, complete: true, stop: clean ? "terminate" : "abort" };
  }

  isCheckpointAbort(generation: number): boolean {
    return generation === this.generation && this.checkpointAbortRequested && this.phase !== "cancelled";
  }

  shadowInput(
    generation: number,
    content: QueueContent,
    delivery: QueueDeliveryMode,
    sessionId = this.sessionId,
  ): QueuedInputShadow | undefined {
    if (generation !== this.generation || sessionId !== this.sessionId || this.fallback ||
        this.phase === "idle" || this.phase === "exhausted" || this.phase === "cancelled") {
      return undefined;
    }
    const entry = { id: this.nextQueueId++, generation, sessionId, content, delivery };
    this.queue.push(entry);
    this.queueChanged.resolve();
    return entry;
  }

  consumeShadow(generation: number, id: number, sessionId = this.sessionId): QueuedInputShadow | undefined {
    if (generation !== this.generation || sessionId !== this.sessionId) return undefined;
    const index = this.queue.findIndex((entry) => entry.id === id && entry.generation === generation && entry.sessionId === sessionId);
    if (index < 0) return undefined;
    return this.queue.splice(index, 1)[0];
  }

  queuedInputSnapshot(): readonly QueuedInputShadow[] {
    return [...this.queue];
  }

  ordinaryInputDisposition(): OrdinaryInputDisposition {
    if (this.phase === "idle") return "accept";
    if (this.phase === "exhausted") return "reject-recoverable";
    if (this.phase === "cancelled") return "reject-closed";
    return "quarantine";
  }

  manualCompactionDisposition(): ManualCompactionDisposition {
    if (this.phase === "idle" || this.phase === "exhausted") return "allow";
    if (this.phase === "cancelled") return "unavailable";
    return "already-active";
  }

  stableBarrier(generation: number): Promise<void> {
    return generation === this.generation && this.stable ? this.stable.promise : Promise.resolve();
  }

  checkpoint(generation: number): Promise<void> {
    if (generation !== this.generation || !this.stable) return Promise.resolve();
    const generationBarrier = this.stable;
    if (this.runOwnership?.generation !== generation && this.phase === "awaiting-settlement") {
      const ownership: RunOwnership = { generation, token: {}, settled: deferred() };
      this.runOwnership = ownership;
      void this.run(generation)
        .catch(() => {
          if (this.phase === "cancelled") return;
          if (this.isCurrent(generation)) this.exhaust(generation);
        })
        .finally(() => {
          if (this.runOwnership?.token === ownership.token) this.runOwnership = undefined;
          ownership.settled.resolve();
        });
    }
    return generationBarrier.promise;
  }

  resumedSettled(token: ResumeToken): boolean {
    if (token !== this.resumeToken || token.generation !== this.generation || this.phase !== "resuming") return false;
    this.resumedSettlement?.resolve();
    return true;
  }

  /** Reports rejected input only after active replay and resumed work have joined. */
  cancel(generation: number, kind: CancellationKind): Promise<CancellationOutcome> {
    if (generation !== this.generation || this.phase === "idle") {
      return Promise.resolve({ cancelled: false, rejected: [] });
    }
    if (this.phase === "cancelled") {
      return this.cancellation?.generation === generation
        ? this.cancellation.outcome.promise
        : Promise.resolve({ cancelled: false, rejected: [] });
    }
    this.phase = "cancelled";
    this.cancellation = { generation, kind, outcome: deferred<CancellationOutcome>() };
    this.checkpointAbortRequested = false;
    this.runAbort.abort(kind);
    this.queueChanged.resolve();
    this.startCancelAndJoin(generation);
    this.emit("checkpoint-cancelled", generation);
    if (this.stable) this.scheduleCancellationFinish(generation, this.stable);
    return this.cancellation.outcome.promise;
  }

  recoveryToken(generation: number): RecoveryToken | undefined {
    return generation === this.generation && this.phase === "exhausted" ? this.recovery : undefined;
  }

  /** Recovery rejects retained input explicitly and never revives the exhausted continuation. */
  recoverAfterManualCompaction(token: RecoveryToken): { recovered: boolean; rejected: readonly QueuedInputShadow[] } {
    if (this.phase !== "exhausted" || token !== this.recovery || token.generation !== this.generation) {
      return { recovered: false, rejected: [] };
    }
    const rejected = this.queue.splice(0);
    this.phase = "idle";
    this.checkpointAbortRequested = false;
    this.recovery = undefined;
    this.emit("checkpoint-recovered");
    return { recovered: true, rejected };
  }

  private currentBatch(handle: ToolBatchHandle): ActiveBatch | undefined {
    return this.phase === "stopping" && handle === this.activeBatch?.handle &&
      handle.generation === this.generation ? this.activeBatch : undefined;
  }

  private async run(generation: number): Promise<void> {
    const manual = this.options.manualCompaction;
    if (!manual || (manual.kind !== "available" && manual.kind !== "unavailable")) {
      this.exhaust(generation);
      return;
    }
    if (manual.kind === "available") {
      if (typeof manual.isActive !== "function" || typeof manual.waitAndResample !== "function") {
        this.exhaust(generation);
        return;
      }
      let active: boolean;
      try {
        active = manual.isActive();
      } catch {
        this.exhaust(generation);
        return;
      }
      if (active) {
        let sample: { ended: boolean; usage: ContextUsageShape | undefined };
        try {
          sample = await manual.waitAndResample({ generation, signal: this.runAbort.signal });
        } catch {
          if (this.phase === "cancelled") return;
          this.exhaust(generation);
          return;
        }
        if (!this.isCurrent(generation)) return;
        let ended: boolean;
        try {
          ended = sample.ended && !manual.isActive();
        } catch {
          ended = false;
        }
        if (!ended || !usageIsKnown(sample.usage)) {
          this.exhaust(generation);
          return;
        }
        if (!usageMeetsThreshold(sample.usage, this.threshold)) {
          await this.resumeOrFinish(generation);
          return;
        }
      }
    }

    const backoffs = this.options.backoffMs ?? [25, 100];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (!this.isCurrent(generation)) return;
      this.phase = "compacting";
      this.attempt = attempt;
      let result: CompactionAttemptResult;
      try {
        result = await this.options.compact(attempt, this.runAbort.signal);
      } catch {
        result = this.runAbort.signal.aborted
          ? { ok: false, category: "cancelled" }
          : { ok: false, category: "operational" };
      }
      if (!this.isCurrent(generation)) return;
      if (result.ok) {
        this.phase = "awaiting-settlement";
        this.emit("checkpoint-complete", generation, attempt);
        await this.resumeOrFinish(generation);
        return;
      }
      if (NON_RETRYABLE.has(result.category) || attempt === 3) {
        if (result.category === "cancelled" || result.category === "shutdown") {
          void this.cancel(generation, result.category === "shutdown" ? "shutdown" : "user");
        } else {
          this.exhaust(generation);
        }
        return;
      }
      this.phase = "backoff";
      this.emit("checkpoint-retrying", generation, attempt);
      try {
        await (this.options.delay ?? defaultDelay)(backoffs[attempt - 1] ?? 100, this.runAbort.signal);
      } catch {
        if (this.isCurrent(generation)) void this.cancel(generation, "user");
        return;
      }
    }
  }

  private async resumeOrFinish(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    if (this.fallback) {
      if (this.queue.length === 0) this.finishGeneration();
      else this.exhaust(generation);
      return;
    }
    if (!this.options.resume) {
      this.exhaust(generation);
      return;
    }

    this.phase = "resuming";
    const token = { generation, token: {} };
    this.resumeToken = token;
    this.resumedSettlement = deferred();
    const context = { generation, token, signal: this.runAbort.signal };
    this.resumeContext = context;
    try {
      const ownership = await this.options.resume(context);
      if (!ownership || typeof ownership.replay !== "function" || typeof ownership.cancelAndJoin !== "function") {
        throw new Error("invalid resume ownership");
      }
      this.resumedOwnership = ownership;
      if (this.isCancelled()) {
        this.startCancelAndJoin(generation);
        return;
      }
      const settlement = ownership.settled ?? this.resumedSettlement.promise;
      await this.replayUntilSettled(generation, ownership, context, settlement);
    } catch {
      if (this.isCancelled()) return;
      this.exhaust(generation);
    }
  }

  private async replayUntilSettled(
    generation: number,
    ownership: ResumedRunOwnership,
    context: ResumeContext,
    settlement: Promise<void>,
  ): Promise<void> {
    let settled = false;
    const settlementEvent = settlement.then(() => {
      settled = true;
      return "settled" as const;
    });

    while (this.isCurrent(generation)) {
      while (this.queue.length > 0 && this.isCurrent(generation)) {
        if (settled) {
          this.exhaust(generation);
          return;
        }
        const entry = this.queue[0];
        if (entry) {
          let result: ReplayDeliveryResult = { delivered: false };
          try {
            const candidate = await ownership.replay(entry, context);
            if (candidate?.delivered === true || candidate?.delivered === false) result = candidate;
          } catch {
            // A throwing adapter has not demonstrated delivery, so controller ownership remains.
          }
          if (result.delivered && this.queue[0] === entry) this.queue.shift();
          if (this.isCancelled()) return;
          if (!result.delivered) {
            this.exhaust(generation);
            return;
          }
        }
      }
      if (!this.isCurrent(generation)) break;
      if (settled) {
        this.finishGeneration();
        return;
      }
      this.queueChanged = deferred();
      if (this.queue.length > 0) continue;
      const event = await Promise.race([
        settlementEvent,
        this.queueChanged.promise.then(() => "queue" as const),
      ]);
      if (event === "settled") {
        if (this.queue.length === 0) this.finishGeneration();
        else this.exhaust(generation);
        return;
      }
    }
  }

  private finishGeneration(): void {
    if (this.queue.length !== 0) {
      this.exhaust(this.generation);
      return;
    }
    const generationBarrier = this.stable;
    this.phase = "idle";
    this.checkpointAbortRequested = false;
    generationBarrier?.resolve();
  }

  private exhaust(generation: number): void {
    if (!this.isCurrent(generation)) return;
    const generationBarrier = this.stable;
    this.phase = "exhausted";
    this.checkpointAbortRequested = false;
    this.recovery = { generation, token: {} };
    generationBarrier?.resolve();
    this.emit("checkpoint-exhausted", generation, this.attempt);
  }

  private startCancelAndJoin(generation: number): void {
    const cancellation = this.cancellation;
    const ownership = this.resumedOwnership;
    const context = this.resumeContext;
    if (!cancellation || cancellation.generation !== generation || cancellation.join || !ownership || !context) return;
    const join = deferred();
    cancellation.join = join.promise;
    try {
      Promise.resolve(ownership.cancelAndJoin(cancellation.kind, context)).then(join.resolve, join.reject);
    } catch (error) {
      join.reject(error);
    }
  }

  private scheduleCancellationFinish(generation: number, generationBarrier: Deferred<void>): void {
    const cancellation = this.cancellation;
    if (!cancellation || cancellation.generation !== generation || cancellation.finishing) return;
    const activeRun = this.runOwnership?.generation === generation ? this.runOwnership.settled.promise : undefined;
    cancellation.finishing = Promise.resolve(activeRun)
      .then(() => this.finishCancellation(generation, generationBarrier));
  }

  private async finishCancellation(generation: number, generationBarrier: Deferred<void>): Promise<void> {
    const cancellation = this.cancellation;
    if (!cancellation || cancellation.generation !== generation) return;
    this.startCancelAndJoin(generation);
    try {
      await cancellation.join;
    } catch {
      const failure = new Error("Checkpoint cancellation could not confirm quiescence");
      generationBarrier.reject(failure);
      cancellation.outcome.reject(failure);
      return;
    }
    const rejected = this.queue.splice(0);
    generationBarrier.resolve();
    cancellation.outcome.resolve({ cancelled: true, rejected });
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.phase !== "cancelled" && this.phase !== "exhausted";
  }

  private isCancelled(): boolean {
    return this.phase === "cancelled";
  }

  private emit(category: CheckpointDiagnosticCategory, generation = this.generation, attempt?: number): void {
    try {
      this.options.progress?.({ category, generation, ...(attempt === undefined ? {} : { attempt }) });
    } catch {
      // Observers cannot own checkpoint transitions or barriers.
    }
  }
}

export interface CompactionCallbackToken {
  readonly generation: number;
  readonly token: object;
}

/** Convert a callback-owned main-session attempt into the controller's Promise contract. */
export function callbackCompactionAttempt(
  generation: number,
  start: (
    token: CompactionCallbackToken,
    complete: (token: CompactionCallbackToken, result: CompactionAttemptResult) => void,
  ) => void,
  signal: AbortSignal,
): Promise<CompactionAttemptResult> {
  return new Promise((resolve) => {
    let settled = false;
    const token = { generation, token: {} };
    const finish = (candidate: CompactionCallbackToken, result: CompactionAttemptResult): void => {
      if (settled || candidate !== token || candidate.generation !== generation) return;
      settled = true;
      resolve(result);
    };
    if (signal.aborted) {
      finish(token, { ok: false, category: "cancelled" });
      return;
    }
    signal.addEventListener("abort", () => finish(token, { ok: false, category: "cancelled" }), { once: true });
    try {
      start(token, finish);
    } catch {
      finish(token, { ok: false, category: "operational" });
    }
  });
}

/** Promise-style SDK compaction settles on abort even when the SDK Promise hangs. */
export async function promiseCompactionAttempt(
  compact: () => Promise<unknown>,
  signal: AbortSignal,
): Promise<CompactionAttemptResult> {
  if (signal.aborted) return { ok: false, category: "cancelled" };
  const operation = Promise.resolve()
    .then(compact)
    .then<CompactionAttemptResult>(() => signal.aborted ? { ok: false, category: "cancelled" } : { ok: true })
    .catch<CompactionAttemptResult>(() => signal.aborted
      ? { ok: false, category: "cancelled" }
      : { ok: false, category: "operational" });
  const aborted = new Promise<CompactionAttemptResult>((resolve) => {
    signal.addEventListener("abort", () => resolve({ ok: false, category: "cancelled" }), { once: true });
  });
  return Promise.race([operation, aborted]);
}

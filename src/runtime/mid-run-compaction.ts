/** Session-local coordination for proactive mid-run context checkpoints. */

import { AsyncLocalStorage } from "node:async_hooks";
import { toolResultHasGuardClipping } from "./guard.js";

export interface ContextUsageShape {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

export type CheckpointPhase =
  | "idle"
  | "armed"
  | "stopping"
  | "awaiting-settlement"
  | "compacting"
  | "backoff"
  | "resuming"
  | "terminalizing"
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
  | "restoration-paused"
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
  action?: "resume" | "settled-fallback" | "manual-recovery" | "new-session";
  failureCategory?: CompactionFailureCategory;
}

export interface CheckpointSnapshot {
  generation: number;
  phase: CheckpointPhase;
  attempt: number;
  checkpointAbortRequested: boolean;
  queuedInputs: number;
  admission: "open" | "checkpoint-only" | "recoverable-rejection" | "closed";
  failureCategory?: CompactionFailureCategory;
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

/** Identity-authenticated permission for one controller-owned summary request. */
export interface CompactionSummaryToken {
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
  /** Opens the resumed provider barrier only after every accepted shadow has reconciled. */
  replayComplete?(context: ResumeContext): void | Promise<void>;
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
export type OrdinaryInputDisposition = "accept" | "quarantine" | "reject-recoverable" | "reject-restoration" | "reject-closed";
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
  "restoration-paused",
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
  private compactionSummary: CompactionSummaryToken | undefined;
  private terminalFailure: CompactionFailureCategory | undefined;
  private terminalization: Promise<readonly QueuedInputShadow[]> | undefined;

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
        ? this.terminalFailure === "restoration-paused" ? "closed" : "recoverable-rejection"
        : this.phase === "cancelled"
          ? "closed"
          : this.phase === "idle"
            ? "open"
            : "checkpoint-only",
      ...(this.terminalFailure === undefined ? {} : { failureCategory: this.terminalFailure }),
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
    this.compactionSummary = undefined;
    this.terminalFailure = undefined;
    this.terminalization = undefined;
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

  beginCompactionSummary(generation: number): CompactionSummaryToken | undefined {
    if (generation !== this.generation || this.phase !== "compacting" || this.compactionSummary) return undefined;
    const token = { generation, token: {} };
    this.compactionSummary = token;
    return token;
  }

  endCompactionSummary(token: CompactionSummaryToken): boolean {
    if (token !== this.compactionSummary || token.generation !== this.generation) return false;
    this.compactionSummary = undefined;
    return true;
  }

  isCompactionSummaryActive(generation: number): boolean {
    return generation === this.generation && this.compactionSummary?.generation === generation;
  }

  /** Mark host-observed validation, permission, hook, truncation, or queue paths unclean. */
  invalidateToolBatch(handle: ToolBatchHandle): boolean {
    const batch = this.currentBatch(handle);
    if (!batch) return false;
    batch.malformed = true;
    return true;
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
    if (this.phase === "exhausted") {
      return this.terminalFailure === "restoration-paused" ? "reject-restoration" : "reject-recoverable";
    }
    if (this.phase === "cancelled") return "reject-closed";
    return "quarantine";
  }

  manualCompactionDisposition(): ManualCompactionDisposition {
    if (this.phase === "idle" || (this.phase === "exhausted" && this.recovery !== undefined) ||
        (this.phase === "cancelled" && this.cancellation?.kind === "user" && this.recovery !== undefined)) {
      return "allow";
    }
    if (this.phase === "cancelled" || this.phase === "exhausted") return "unavailable";
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
    if (this.phase === "terminalizing") {
      return (this.terminalization ?? Promise.resolve([])).then((rejected) => ({
        cancelled: true,
        rejected,
      }));
    }
    if (this.phase === "cancelled") {
      return this.cancellation?.generation === generation
        ? this.cancellation.outcome.promise
        : Promise.resolve({ cancelled: false, rejected: [] });
    }
    this.phase = "cancelled";
    this.cancellation = { generation, kind, outcome: deferred<CancellationOutcome>() };
    this.checkpointAbortRequested = false;
    this.compactionSummary = undefined;
    this.runAbort.abort(kind);
    this.queueChanged.resolve();
    this.startCancelAndJoin(generation);
    this.emit("checkpoint-cancelled", generation, undefined, {
      action: kind === "user" ? "manual-recovery" : "new-session",
    });
    const generationBarrier = this.stable ??= deferred();
    this.scheduleCancellationFinish(generation, generationBarrier);
    return this.cancellation.outcome.promise;
  }

  recoveryToken(generation: number): RecoveryToken | undefined {
    const recoverable = this.phase === "exhausted" ||
      (this.phase === "cancelled" && this.cancellation?.kind === "user");
    return generation === this.generation && recoverable ? this.recovery : undefined;
  }

  /** Recovery rejects retained input explicitly and never revives the old continuation. */
  recoverAfterManualCompaction(token: RecoveryToken): { recovered: boolean; rejected: readonly QueuedInputShadow[] } {
    const recoverable = this.phase === "exhausted" ||
      (this.phase === "cancelled" && this.cancellation?.kind === "user");
    if (!recoverable || token !== this.recovery || token.generation !== this.generation) {
      return { recovered: false, rejected: [] };
    }
    const rejected = this.queue.splice(0);
    this.phase = "idle";
    this.checkpointAbortRequested = false;
    this.recovery = undefined;
    this.emit("checkpoint-recovered");
    return { recovered: true, rejected };
  }

  /** Close a generation after its summary committed; no recovery capability survives. */
  failAfterCommittedSummary(generation: number): Promise<readonly QueuedInputShadow[]> {
    return this.terminalizeAfterCommittedSummary(generation);
  }

  /** A public-session continuation failed to start or settle; only pre-commit failures remain recoverable. */
  pauseAfterRecoveryFailure(
    generation: number,
    failureCategory: CompactionFailureCategory = "operational",
  ): boolean {
    if (generation !== this.generation || this.phase !== "idle") return false;
    this.phase = "exhausted";
    this.terminalFailure = failureCategory;
    this.recovery = failureCategory === "restoration-paused" ? undefined : { generation, token: {} };
    this.emit("checkpoint-exhausted", generation, this.attempt, {
      action: failureCategory === "restoration-paused" ? "new-session" : "manual-recovery",
      failureCategory,
    });
    return true;
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
      } finally {
        // The adapter normally closes its token; this floor keeps a failed adapter
        // from authorizing ordinary transport during backoff or a later attempt.
        this.compactionSummary = undefined;
      }
      if (!this.isCurrent(generation)) return;
      if (result.ok) {
        this.phase = "awaiting-settlement";
        this.emit("checkpoint-complete", generation, attempt, {
          action: this.fallback ? "settled-fallback" : "resume",
        });
        await this.resumeOrFinish(generation);
        return;
      }
      if (NON_RETRYABLE.has(result.category) || attempt === 3) {
        if (result.category === "cancelled" || result.category === "shutdown") {
          void this.cancel(generation, result.category === "shutdown" ? "shutdown" : "user");
        } else if (result.category === "restoration-paused") {
          await this.terminalizeAfterCommittedSummary(generation);
        } else {
          this.exhaust(generation, result.category);
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
      // The summary is already committed before resume ownership begins. Any
      // restoration, replay, startup, or settlement failure is terminal for
      // this session and must never mint a token that permits re-compaction.
      await this.terminalizeAfterCommittedSummary(generation);
    }
  }

  private async replayUntilSettled(
    generation: number,
    ownership: ResumedRunOwnership,
    context: ResumeContext,
    settlement: Promise<void>,
  ): Promise<void> {
    let settled = false;
    let replayCompleted = false;
    const settlementEvent = settlement.then(() => {
      settled = true;
      return "settled" as const;
    });

    while (this.isCurrent(generation)) {
      while (this.queue.length > 0 && this.isCurrent(generation)) {
        if (settled) {
          await this.terminalizeAfterCommittedSummary(generation);
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
            await this.terminalizeAfterCommittedSummary(generation);
            return;
          }
        }
      }
      if (!this.isCurrent(generation)) break;
      if (!replayCompleted && ownership.replayComplete) {
        try {
          await ownership.replayComplete(context);
          replayCompleted = true;
        } catch {
          if (!this.isCancelled()) await this.terminalizeAfterCommittedSummary(generation);
          return;
        }
      }
      if (!this.isCurrent(generation)) return;
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
        else await this.terminalizeAfterCommittedSummary(generation);
        return;
      }
    }
  }

  private terminalizeAfterCommittedSummary(generation: number): Promise<readonly QueuedInputShadow[]> {
    if (generation !== this.generation || this.phase === "cancelled" || this.phase === "exhausted") {
      return Promise.resolve([]);
    }
    if (this.phase === "terminalizing") return this.terminalization ?? Promise.resolve([]);

    const ownership = this.resumedOwnership;
    const context = this.resumeContext;
    const generationBarrier = this.stable;
    this.phase = "terminalizing";
    this.checkpointAbortRequested = false;
    this.compactionSummary = undefined;
    this.terminalFailure = "restoration-paused";
    this.recovery = undefined;
    this.runAbort.abort("post-commit failure");
    this.queueChanged.resolve();

    const terminalization = (async (): Promise<readonly QueuedInputShadow[]> => {
      if (ownership && context) {
        try {
          await ownership.cancelAndJoin("replacement", context);
        } catch {
          // The adapter has already revoked provider/replay authority. A failed
          // host join cannot reopen this generation, but stable publication must
          // still wait for that exact join attempt to settle.
        }
      }
      if (generation !== this.generation || this.phase !== "terminalizing") return [];
      this.resumedOwnership = undefined;
      this.resumeContext = undefined;
      this.resumeToken = undefined;
      this.resumedSettlement = undefined;
      const rejected = this.queue.splice(0);
      this.phase = "exhausted";
      generationBarrier?.resolve();
      this.emit("checkpoint-exhausted", generation, this.attempt, {
        action: "new-session",
        failureCategory: "restoration-paused",
      });
      return rejected;
    })();
    this.terminalization = terminalization;
    return terminalization;
  }

  private finishGeneration(): void {
    if (this.queue.length !== 0) {
      this.exhaust(this.generation);
      return;
    }
    const generationBarrier = this.stable;
    this.phase = "idle";
    this.checkpointAbortRequested = false;
    this.compactionSummary = undefined;
    generationBarrier?.resolve();
  }

  private exhaust(generation: number, failureCategory: CompactionFailureCategory = "operational"): void {
    if (!this.isCurrent(generation)) return;
    const generationBarrier = this.stable;
    this.phase = "exhausted";
    this.checkpointAbortRequested = false;
    this.compactionSummary = undefined;
    this.terminalFailure = failureCategory;
    this.recovery = failureCategory === "restoration-paused" ? undefined : { generation, token: {} };
    generationBarrier?.resolve();
    this.emit("checkpoint-exhausted", generation, this.attempt, {
      action: failureCategory === "restoration-paused" ? "new-session" : "manual-recovery",
      failureCategory,
    });
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
    if (cancellation.kind === "user") this.recovery = { generation, token: {} };
    generationBarrier.resolve();
    cancellation.outcome.resolve({ cancelled: true, rejected });
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation && this.phase !== "cancelled" &&
      this.phase !== "terminalizing" && this.phase !== "exhausted";
  }

  private isCancelled(): boolean {
    return this.phase === "cancelled";
  }

  private emit(
    category: CheckpointDiagnosticCategory,
    generation = this.generation,
    attempt?: number,
    details: Pick<CheckpointProgress, "action" | "failureCategory"> = {},
  ): void {
    try {
      this.options.progress?.({ category, generation, ...(attempt === undefined ? {} : { attempt }), ...details });
    } catch {
      // Observers cannot own checkpoint transitions or barriers.
    }
  }
}

const GUARDED_OPENAI_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
]);

interface MainGateContext {
  model?: { api?: string };
  mode?: string;
  ui?: { getEditorText?: () => string; setEditorText?: (text: string) => void };
  getContextUsage?: () => ContextUsageShape | undefined;
  hasPendingMessages?: () => boolean;
  abort?: () => void;
}

interface MainBatchObservation {
  run: object;
  ids: string[];
  final: Map<string, { isError: boolean; truncated: boolean }>;
  successful: Map<string, { terminated: boolean; truncated: boolean }>;
}

export interface MainSessionCheckpointExecutionAdapter {
  compact(attempt: number, signal: AbortSignal): Promise<CompactionAttemptResult>;
  resume?(context: ResumeContext): ResumedRunOwnership | Promise<ResumedRunOwnership>;
  manualCompaction: ManualCompactionCapability;
  delay?(milliseconds: number, signal: AbortSignal): Promise<void>;
  progress?(event: CheckpointProgress): void;
}

/** Stable mutable seam through which main-session lifecycle wiring supplies execution behavior. */
export class MainSessionCheckpointExecutionBridge {
  private adapter: MainSessionCheckpointExecutionAdapter | undefined;

  attach(adapter: MainSessionCheckpointExecutionAdapter): () => void {
    this.adapter = adapter;
    return () => {
      if (this.adapter === adapter) this.adapter = undefined;
    };
  }

  createController(sessionId: string, threshold: number): MidRunCompactionController {
    const bridge = this;
    const manual = {
      get kind(): ManualCompactionCapability["kind"] {
        return bridge.adapter?.manualCompaction.kind ?? "unavailable";
      },
      isActive: () => bridge.adapter?.manualCompaction.kind === "available" &&
        bridge.adapter.manualCompaction.isActive(),
      waitAndResample: (context: { generation: number; signal: AbortSignal }) => {
        const capability = bridge.adapter?.manualCompaction;
        return capability?.kind === "available"
          ? capability.waitAndResample(context)
          : Promise.resolve({ ended: false, usage: undefined });
      },
    } as ManualCompactionCapability;
    return new MidRunCompactionController({
      sessionId,
      threshold,
      compact: (attempt, signal) => this.adapter
        ? this.adapter.compact(attempt, signal)
        : Promise.resolve({ ok: false, category: "operational" }),
      resume: (context) => {
        const resume = this.adapter?.resume;
        if (!resume) throw new Error("Main-session checkpoint resume adapter is not attached");
        return resume(context);
      },
      delay: (milliseconds, signal) => this.adapter?.delay
        ? this.adapter.delay(milliseconds, signal)
        : defaultDelay(milliseconds, signal),
      progress: (event) => this.adapter?.progress?.(event),
      manualCompaction: manual,
    });
  }

  beginCompactionSummary(controller: MidRunCompactionController, generation: number): CompactionSummaryToken | undefined {
    return controller.beginCompactionSummary(generation);
  }

  endCompactionSummary(controller: MidRunCompactionController, token: CompactionSummaryToken): boolean {
    return controller.endCompactionSummary(token);
  }
}

function toolCallIds(message: unknown): string[] {
  if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is { type: "toolCall"; id: string } =>
      block?.type === "toolCall" && typeof block.id === "string")
    .map((block) => block.id);
}

function resultIsTruncated(result: unknown): boolean {
  return toolResultHasGuardClipping(result);
}

function canonical(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (typeof value === "string") return `s${value.length}:${value}`;
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (typeof value === "number") return `d${Number.isNaN(value) ? "nan" : String(value)}`;
  if (typeof value !== "object") return `${typeof value}:${String(value)}`;
  if (seen.has(value)) return "circular";
  seen.add(value);
  if (Array.isArray(value)) return `a[${value.map((item) => canonical(item, seen)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `o{${Object.keys(record).sort().map((key) => `${canonical(key)}=${canonical(record[key], seen)}`).join(",")}}`;
}

function acceptedContent(text: string, images: readonly unknown[] | undefined): QueueContent {
  return images?.length ? [{ type: "text", text }, ...images] : text;
}

interface ExpectedInput {
  content: QueueContent;
  canonical: string;
  delivery: QueueDeliveryMode;
}

interface ReplayAuthorization {
  gate: object;
  sessionId: string;
  generation: number;
  shadow: QueuedInputShadow;
  canonical: string;
  source: string;
  mode: QueueDeliveryMode;
  used: boolean;
}

const replayAuthorization = new AsyncLocalStorage<ReplayAuthorization>();

/** Main-session lifecycle adapter around the generation-authenticated controller. */
export class MainSessionCheckpointGate {
  private controller: MidRunCompactionController;
  private generation: number | undefined;
  private handle: ToolBatchHandle | undefined;
  private batch: MainBatchObservation = { run: {}, ids: [], final: new Map(), successful: new Map() };
  private abortIssued: { generation: number; run: object } | undefined;
  private acceptedBeforeArm: ExpectedInput[] = [];
  private ambiguousInput = false;
  private sessionEpoch: object = {};
  private transition: Promise<void> = Promise.resolve();
  private resumeBarrier: { generation: number; promise: Promise<void> } | undefined;

  constructor(
    private readonly execution: MainSessionCheckpointExecutionBridge,
    sessionId: string,
    private readonly threshold: number,
  ) {
    this.controller = execution.createController(sessionId, threshold);
  }

  currentController(): MidRunCompactionController {
    return this.controller;
  }

  async beforeSessionSwitch(): Promise<{ cancel: true } | undefined> {
    // Pi swallows lifecycle-handler throws, so report cancellation explicitly if
    // the old generation cannot join. The controller must cancel before replay
    // authority is revoked so its abort-before-join ordering remains observable.
    const operation = this.transition.then(async () => {
      await this.cancelCurrent("replacement");
      this.sessionEpoch = {};
    });
    this.transition = operation.catch(() => undefined);
    try {
      await operation;
    } catch {
      return { cancel: true };
    }
    this.invalidateSessionState();
    return undefined;
  }

  async startSession(sessionId: string): Promise<void> {
    const operation = this.transition.then(async () => {
      await this.cancelCurrent("replacement");
      this.controller = this.execution.createController(sessionId, this.threshold);
      this.invalidateSessionState();
    });
    this.transition = operation.catch(() => undefined);
    await operation;
  }

  wrapTool<T extends Record<string, unknown>>(tool: T): T {
    const execute = tool.execute;
    if (typeof execute !== "function") return tool;
    const gate = this;
    return {
      ...tool,
      async execute(this: unknown, ...args: unknown[]) {
        const result = await Reflect.apply(execute, this, args) as unknown as Record<string, unknown>;
        return gate.successfulTool(String(args[0] ?? ""), result, args[4] as MainGateContext | undefined);
      },
    };
  }

  assistantMessageEnded(message: unknown): void {
    if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") return;
    this.batch = { run: {}, ids: toolCallIds(message), final: new Map(), successful: new Map() };
    this.handle = undefined;
    this.abortIssued = undefined;
  }

  toolExecutionEnded(event: { toolCallId?: unknown; result?: unknown; isError?: unknown }): void {
    if (typeof event.toolCallId !== "string") return;
    const truncated = resultIsTruncated(event.result);
    this.batch.final.set(event.toolCallId, { isError: event.isError === true, truncated });
    if (event.isError === true || truncated) this.invalidate();
  }

  turnEnded(ctx: MainGateContext): ToolBatchDisposition | undefined {
    let pending = false;
    try {
      pending = ctx.hasPendingMessages?.() === true;
    } catch {
      pending = true;
    }
    if (this.batch.ids.length === 0 && !pending) return undefined;
    this.arm(ctx);
    if (this.generation === undefined) return undefined;
    this.beginBatch(true);
    if (!this.handle) return undefined;

    for (const id of this.batch.ids) {
      const observed = this.batch.successful.get(id);
      const final = this.batch.final.get(id);
      if (!observed?.terminated || observed.truncated || !final || final.isError || final.truncated) {
        this.controller.invalidateToolBatch(this.handle);
      }
    }
    if (this.batch.final.size !== this.batch.ids.length ||
        [...this.batch.final.keys()].some((id) => !this.batch.ids.includes(id)) || pending || this.ambiguousInput) {
      this.controller.invalidateToolBatch(this.handle);
    }

    const disposition = this.controller.completeToolBatch(this.handle);
    if (disposition.stop === "abort") this.abortAfterBatch(ctx);
    return disposition;
  }

  async defensiveLatch(ctx: MainGateContext): Promise<void> {
    const generation = this.generation;
    if (generation === undefined || this.controller.isCompactionSummaryActive(generation)) return;
    const snapshot = this.controller.snapshot();
    if (snapshot.phase === "idle") return;
    const barrier = this.resumeBarrier;
    if (snapshot.phase === "resuming" && barrier?.generation === generation) {
      try {
        await barrier.promise;
      } catch {
        this.abortAfterBatch(ctx);
        return;
      }
      // Opening the latch is not itself transport authority. Cancellation or a
      // replacement can settle the barrier specifically to unblock waiters; a
      // provider callback waking afterward must re-authenticate the same
      // controller generation and resuming phase before it may return to Pi.
      const current = this.controller.snapshot();
      if (this.generation !== generation || this.resumeBarrier !== barrier ||
          current.generation !== generation || current.phase !== "resuming") {
        this.abortAfterBatch(ctx);
      }
      return;
    }
    this.abortAfterBatch(ctx);
  }

  installResumeBarrier(generation: number, barrier: Promise<void>): boolean {
    if (generation !== this.generation || this.controller.snapshot().phase !== "resuming") return false;
    this.resumeBarrier = { generation, promise: barrier };
    return true;
  }

  clearResumeBarrier(generation: number, barrier: Promise<void>): boolean {
    if (this.resumeBarrier?.generation !== generation || this.resumeBarrier.promise !== barrier) return false;
    this.resumeBarrier = undefined;
    return true;
  }

  settlementGeneration(ctx: MainGateContext): number | undefined {
    this.resetCompletedGeneration();
    if (this.generation !== undefined) {
      return this.controller.snapshot().phase === "awaiting-settlement" ? this.generation : undefined;
    }
    let usage: ContextUsageShape | undefined;
    try {
      usage = ctx.getContextUsage?.();
    } catch {
      usage = undefined;
    }
    const generation = this.controller.sample(usage, "settled");
    if (generation !== undefined) this.generation = generation;
    return generation;
  }

  ordinaryInputDisposition(): OrdinaryInputDisposition {
    return this.controller.ordinaryInputDisposition();
  }

  async cancel(kind: CancellationKind): Promise<CancellationOutcome> {
    const snapshot = this.controller.snapshot();
    return snapshot.phase === "idle"
      ? { cancelled: false, rejected: [] }
      : this.controller.cancel(snapshot.generation, kind);
  }

  isActive(): boolean {
    this.resetCompletedGeneration();
    return this.generation !== undefined;
  }

  withReplayAuthorization<T>(input: QueuedInputShadow, operation: () => T, source = "extension"): T {
    const current = this.controller.queuedInputSnapshot().find((entry) => entry === input);
    if (!current || input.sessionId !== this.controller.sessionId || input.generation !== this.generation) {
      throw new Error("Cannot authorize stale checkpoint replay");
    }
    return replayAuthorization.run({
      gate: this.sessionEpoch,
      sessionId: input.sessionId,
      generation: input.generation,
      shadow: input,
      canonical: canonical(input.content),
      source,
      mode: input.delivery,
      used: false,
    }, operation);
  }

  authorizeReplay(event: {
    text?: unknown;
    images?: readonly unknown[];
    source?: unknown;
    streamingBehavior?: unknown;
  }): QueuedInputShadow | undefined {
    const authorization = replayAuthorization.getStore();
    const phase = this.controller.snapshot().phase;
    if (!authorization || authorization.used || authorization.gate !== this.sessionEpoch ||
        phase === "cancelled" || phase === "exhausted" ||
        authorization.sessionId !== this.controller.sessionId || authorization.generation !== this.generation ||
        event.source !== authorization.source || event.streamingBehavior !== authorization.mode ||
        canonical(acceptedContent(String(event.text ?? ""), event.images)) !== authorization.canonical ||
        !this.controller.queuedInputSnapshot().some((entry) => entry === authorization.shadow)) return undefined;
    authorization.used = true;
    return authorization.shadow;
  }

  captureAcceptedInput(
    ctx: MainGateContext,
    text: string,
    images: readonly unknown[] | undefined,
    delivery: QueueDeliveryMode | undefined,
  ): QueuedInputShadow | undefined {
    if (!GUARDED_OPENAI_APIS.has(ctx.model?.api ?? "")) return undefined;
    const content = acceptedContent(text, images);
    this.arm(ctx);
    const effectiveDelivery = delivery ?? (this.generation === undefined ? undefined : "followUp");
    if (!effectiveDelivery) return undefined;
    const expected = { content, canonical: canonical(content), delivery: effectiveDelivery };
    if (this.generation === undefined) {
      this.acceptedBeforeArm.push(expected);
      return undefined;
    }
    return this.controller.shadowInput(this.generation, content, effectiveDelivery);
  }

  userMessageStarted(message: unknown, delivery?: QueueDeliveryMode): QueuedInputShadow | undefined {
    if (!message || typeof message !== "object" || (message as { role?: string }).role !== "user") return undefined;
    const messageCanonical = canonical((message as { content?: unknown }).content);
    if (this.generation === undefined) {
      const index = this.acceptedBeforeArm.findIndex((entry) =>
        entry.canonical === messageCanonical && (delivery === undefined || entry.delivery === delivery));
      if (index >= 0) this.acceptedBeforeArm.splice(index, 1);
      else if (this.acceptedBeforeArm.length > 0) this.ambiguousInput = true;
      return undefined;
    }
    const match = this.controller.queuedInputSnapshot().find((entry) =>
      entry.generation === this.generation && entry.sessionId === this.controller.sessionId &&
      canonical(entry.content) === messageCanonical && (delivery === undefined || entry.delivery === delivery));
    if (!match) {
      if (this.controller.queuedInputSnapshot().length > 0) {
        this.ambiguousInput = true;
        this.invalidate();
      }
      return undefined;
    }
    return this.controller.consumeShadow(this.generation, match.id, this.controller.sessionId);
  }

  private successfulTool(id: string, result: Record<string, unknown>, ctx: MainGateContext | undefined): Record<string, unknown> {
    if (ctx) this.arm(ctx);
    const truncated = resultIsTruncated(result);
    const observation = { terminated: false, truncated };
    this.batch.successful.set(id, observation);
    this.beginBatch();
    if (!this.handle || !this.batch.ids.includes(id)) {
      this.invalidate();
      return result;
    }
    const finalized = this.controller.finalizeTool(this.handle, id, { owned: true, canTerminate: !truncated });
    if (!finalized || truncated) {
      this.controller.invalidateToolBatch(this.handle);
      return result;
    }
    observation.terminated = true;
    return this.controller.terminateResult(this.handle, id, result);
  }

  private arm(ctx: MainGateContext): void {
    this.resetCompletedGeneration();
    if (this.generation !== undefined || !GUARDED_OPENAI_APIS.has(ctx.model?.api ?? "")) return;
    let usage: ContextUsageShape | undefined;
    try {
      usage = ctx.getContextUsage?.();
    } catch {
      usage = undefined;
    }
    const generation = this.controller.sample(usage, "tool");
    if (generation !== undefined) {
      this.generation = generation;
      for (const accepted of this.acceptedBeforeArm.splice(0)) {
        this.controller.shadowInput(generation, accepted.content, accepted.delivery);
      }
      this.beginBatch();
      if (this.ambiguousInput && this.handle) this.controller.invalidateToolBatch(this.handle);
    }
  }

  private beginBatch(allowEmpty = false): void {
    if (this.handle || this.generation === undefined || (!allowEmpty && this.batch.ids.length === 0)) return;
    this.handle = this.controller.beginToolBatch(this.generation, this.batch.ids);
  }

  private resetCompletedGeneration(): void {
    if (this.generation === undefined || this.controller.snapshot().phase !== "idle") return;
    this.generation = undefined;
    this.handle = undefined;
    this.abortIssued = undefined;
    this.ambiguousInput = false;
    this.resumeBarrier = undefined;
  }

  private invalidate(): void {
    if (this.handle) this.controller.invalidateToolBatch(this.handle);
    else this.ambiguousInput = true;
  }

  private abortAfterBatch(ctx: MainGateContext): void {
    const generation = this.generation;
    if (generation === undefined ||
        (this.abortIssued?.generation === generation && this.abortIssued.run === this.batch.run) ||
        typeof ctx.abort !== "function") return;
    let editor: string | undefined;
    if (ctx.mode === "tui") {
      try { editor = ctx.ui?.getEditorText?.(); } catch { editor = undefined; }
    }
    try {
      ctx.abort();
      this.abortIssued = { generation, run: this.batch.run };
    } catch {
      return;
    } finally {
      if (editor !== undefined) {
        try { ctx.ui?.setEditorText?.(editor); } catch {
          // Queue ownership does not depend on best-effort editor restoration.
        }
      }
    }
  }

  private async cancelCurrent(kind: CancellationKind): Promise<void> {
    const snapshot = this.controller.snapshot();
    if (snapshot.phase !== "idle") await this.controller.cancel(snapshot.generation, kind);
  }

  private invalidateSessionState(): void {
    this.generation = undefined;
    this.handle = undefined;
    this.batch = { run: {}, ids: [], final: new Map(), successful: new Map() };
    this.abortIssued = undefined;
    this.acceptedBeforeArm = [];
    this.ambiguousInput = false;
    this.sessionEpoch = {};
    this.resumeBarrier = undefined;
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
      resolve(signal.aborted ? { ok: false, category: "cancelled" } : result);
    };
    // Once host compaction starts, cancellation requests host abort but still joins
    // the real callback; that callback follows Pi's committed hook/restoration work.
    if (signal.aborted) {
      finish(token, { ok: false, category: "cancelled" });
      return;
    }
    try {
      start(token, finish);
    } catch {
      finish(token, { ok: false, category: signal.aborted ? "cancelled" : "operational" });
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

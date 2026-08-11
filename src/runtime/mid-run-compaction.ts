/** Session-local coordination for proactive mid-run context checkpoints. */

import { AsyncLocalStorage } from "node:async_hooks";
import { calculateContextTokens } from "@earendil-works/pi-agent-core";
import { isProactiveCompactionApi } from "../registry/capability-registry.js";
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
  | "resuming"
  | "terminalizing"
  | "exhausted"
  | "cancelled";

export type QueueDeliveryMode = "steer" | "followUp";
export type QueueContent = string | readonly unknown[];
export type CheckpointSource = "tool" | "assistant" | "admission" | "settled";
export type CancellationKind = "user" | "task-stop" | "shutdown" | "replacement";
export type CompactionFailureCategory =
  | "operational"
  | "cancelled"
  | "hook-blocked"
  | "restoration-paused"
  | "unconfirmed-host"
  | "stale-generation"
  | "shutdown";
export type CheckpointDiagnosticCategory =
  | "checkpoint-armed"
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

/**
 * What the reader can still do after this ending. `session-ended` and `restart-process`
 * exist because "start a new session" is false for a session that is shutting down and
 * for a cancellation whose join never confirmed the host went quiet — the latter leaves
 * a controller that refuses replacement as well as recovery.
 */
export type CheckpointAction =
  | "resume"
  | "settled-fallback"
  | "manual-recovery"
  | "new-session"
  | "session-ended"
  | "restart-process"
  | "session-reusable";

export interface CheckpointProgress {
  category: CheckpointDiagnosticCategory;
  generation: number;
  source?: CheckpointSource;
  action?: CheckpointAction;
  failureCategory?: CompactionFailureCategory;
  stage?: PostCommitStage;
}

/** Whether a cancellation established that the host stopped; `unconfirmed` is terminal. */
export type CancellationQuiescence = "pending" | "confirmed" | "unconfirmed";

export interface CheckpointSnapshot {
  generation: number;
  phase: CheckpointPhase;
  checkpointAbortRequested: boolean;
  queuedInputs: number;
  admission: "open" | "checkpoint-only" | "recoverable-rejection" | "closed";
  failureCategory?: CompactionFailureCategory;
  stage?: PostCommitStage;
  /** Present only while a cancellation owns this generation; all three fields travel together. */
  cancellationKind?: CancellationKind;
  cancellationQuiescence?: CancellationQuiescence;
  /**
   * Whether this generation's summary is already committed. A cancellation of a committed
   * generation terminalizes post-commit and mints no recovery capability, whatever its
   * kind — so `cancellationKind === "user"` alone does not mean the wait ends recoverably.
   */
  cancellationCommitted?: boolean;
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

export type ResumedSettlementOutcome = "completed" | "cancelled";

export type PostCommitStage =
  | "restoration"
  | "continuation-start"
  | "input-replay"
  | "provider-release"
  | "resumed-work"
  | "resumed-cancellation"
  | "cancellation-join";

export type HostInputClass =
  | "restoration-control"
  | "continuation-trigger"
  | "retained-replay"
  | "ordinary-input"
  | "subagent-input"
  | "panel-steer";

/** Identity-authenticated custody for one host-bound operation. */
export interface HostInputLease {
  readonly sessionId: string;
  readonly generation: number;
  readonly inputClass: HostInputClass;
  readonly token: object;
}

export type HostInputAdmission =
  | { kind: "inactive" }
  | { kind: "refuse-settling" }
  | { kind: "lease"; lease: HostInputLease };

export interface CancelledInputHandoff {
  readonly sessionId: string;
  readonly generation: number;
  readonly token: object;
  readonly retained: readonly QueuedInputShadow[];
  readonly acceptedToHostIds: readonly number[];
  readonly piccOwnedIds: readonly number[];
}

export type CancelledInputDisposition = "restored" | "reported" | "unresolved";

export interface CancelledInputResolutionEntry {
  readonly id: number;
  readonly disposition: CancelledInputDisposition;
}

export interface CancelledInputResolution {
  readonly sessionId: string;
  readonly generation: number;
  readonly token: object;
  readonly resolutions: readonly CancelledInputResolutionEntry[];
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
  /** Authenticate the adapter's transition from restoration into continuation startup. */
  advancePostCommitStage(stage: "continuation-start"): boolean;
}

export type ReplayDeliveryResult =
  | { delivered: true; pendingHostStart?: boolean }
  | { delivered: false };

export const MAIN_CALLBACK_COMPACTION_DEADLINE_MS = 5 * 60 * 1000;
export const RESUMED_RUN_JOIN_DEADLINE_MS = 30 * 1000;
export const UNCONFIRMED_HOST_RECOVERY_GUIDANCE =
  "In the TUI, copy any restored draft before exiting; in headless modes, recover input from client/request history. Then exit PiCC completely, start a fresh PiCC process and a fresh session, do not reopen the affected session, and resend it.";

export interface HostDeadlineTimer {
  clear(): void;
}

export interface HostDeadlineClock {
  schedule(delayMs: number, expired: () => void): HostDeadlineTimer;
}

export interface HostDeadlinePolicy {
  clock?: HostDeadlineClock;
  mainCallbackMs?: number;
  resumedJoinMs?: number;
}

export class UnconfirmedHostDeadlineError extends Error {
  constructor() {
    super("Host lifecycle did not settle before its deadline");
    this.name = "UnconfirmedHostDeadlineError";
  }
}

const systemDeadlineClock: HostDeadlineClock = {
  schedule(delayMs, expired) {
    // This timer is the operation's sole liveness owner after the host stops answering.
    // Keep Node's default referenced timer and clear it only after real settlement.
    const timer = setTimeout(expired, delayMs);
    return { clear: () => clearTimeout(timer) };
  },
};

function deadlineClock(policy: HostDeadlinePolicy | undefined): HostDeadlineClock {
  return policy?.clock ?? systemDeadlineClock;
}

function resumedJoinDeadline(policy: HostDeadlinePolicy | undefined): number {
  return policy?.resumedJoinMs ?? RESUMED_RUN_JOIN_DEADLINE_MS;
}

async function withHostDeadline<T>(
  operation: Promise<T>,
  delayMs: number,
  clock: HostDeadlineClock,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = clock.schedule(delayMs, () => {
      if (settled) return;
      settled = true;
      reject(new UnconfirmedHostDeadlineError());
    });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        timer.clear();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        timer.clear();
        reject(error);
      },
    );
  });
}

/**
 * A resumed run owns replay and cancellation. Callback runs omit `settled` and transfer
 * their nested settlement with `resumedSettled`; Promise runs provide `settled`.
 */
export interface ResumedRunOwnership {
  replay(input: QueuedInputShadow, context: ResumeContext): ReplayDeliveryResult | Promise<ReplayDeliveryResult>;
  /** Opens the resumed provider barrier only after every accepted shadow has reconciled. */
  replayComplete?(context: ResumeContext): void | Promise<void>;
  settled?: Promise<void>;
  cancelAndJoin(kind: CancellationKind, context: ResumeContext): void | Promise<void>;
}

export type OrdinaryInputDisposition = "accept" | "quarantine" | "reject-recoverable" | "reject-restoration" | "reject-closed" | "reject-stopped" | "reject-settling";
export type ManualCompactionDisposition = "allow" | "already-active" | "unavailable";

export interface CancellationOutcome {
  cancelled: boolean;
  rejected: readonly QueuedInputShadow[];
}

export interface MidRunCompactionOptions {
  sessionId: string;
  threshold: number;
  compact(signal: AbortSignal): Promise<CompactionAttemptResult>;
  resume?(context: ResumeContext): ResumedRunOwnership | Promise<ResumedRunOwnership>;
  cancelledInput?(
    handoff: CancelledInputHandoff,
    context: ResumeContext,
  ): CancelledInputResolution | Promise<CancelledInputResolution>;
  progress?(event: CheckpointProgress): void;
  /**
   * Report input a terminal transition has taken out of the queue. Every splice that
   * ends a generation hands its shadows here, so this — not a return value some caller
   * has to remember to forward — is where retained input survives an ending. The
   * diagnostic for that ending is emitted first, so a reader sees what happened before
   * what it cost them.
   */
  inputDropped?(rejected: readonly QueuedInputShadow[]): void;
  deadlinePolicy?: HostDeadlinePolicy;
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
  quiescence: CancellationQuiescence;
  outcome: Deferred<CancellationOutcome>;
  join?: Promise<void>;
  /**
   * Set by the one branch that reports dropped input without draining it (a failed join
   * must decide nothing about a generation whose quiescence it could not establish). It
   * makes "reported exactly once" a fact this file enforces rather than an argument about
   * which caller the rejection happens to stop.
   */
  reported?: boolean;
}

interface RunOwnership {
  generation: number;
  settled: Deferred<void>;
}

interface ActiveHostInputLease {
  lease: HostInputLease;
  settled: Deferred<void>;
}

function usageIsKnown(usage: ContextUsageShape | undefined): usage is ContextUsageShape & { percent: number } {
  return typeof usage?.percent === "number" && Number.isFinite(usage.percent);
}

function usageMeetsThreshold(usage: ContextUsageShape | undefined, threshold: number): boolean {
  return usageIsKnown(usage) && usage.percent >= threshold;
}

/** Coordinates one session's checkpoint generation and leaves Pi-specific wiring to callers. */
export class MidRunCompactionController {
  readonly sessionId: string;
  readonly threshold: number;

  private generation = 0;
  private phase: CheckpointPhase = "idle";
  private activeBatch: ActiveBatch | undefined;
  private queue: QueuedInputShadow[] = [];
  private nextQueueId = 1;
  private checkpointAbortRequested = false;
  private runAbort = new AbortController();
  private stable: Deferred<void> | undefined;
  private runOwnership: RunOwnership | undefined;
  private fallback = false;
  private resumeToken: ResumeToken | undefined;
  private resumedSettlement: Deferred<ResumedSettlementOutcome> | undefined;
  private resumedCancellationEvidence: ResumeToken | undefined;
  private resumedSettlementRecorded = false;
  private queueChanged = deferred();
  private recovery: RecoveryToken | undefined;
  private resumedOwnership: ResumedRunOwnership | undefined;
  private resumeContext: ResumeContext | undefined;
  private cancellation: CancellationState | undefined;
  private compactionSummary: CompactionSummaryToken | undefined;
  private committedGeneration: number | undefined;
  private terminalFailure: CompactionFailureCategory | undefined;
  private terminalization: Promise<readonly QueuedInputShadow[]> | undefined;
  private terminalStage: PostCommitStage | undefined;
  private postCommitStage: PostCommitStage | undefined;
  private pendingHostStarts = new Set<number>();
  private hostInputLeases = new Map<HostInputLease, ActiveHostInputLease>();
  private hostAdmissionRevoked = false;
  private cancellationHandoff: CancelledInputHandoff | undefined;

  constructor(private readonly options: MidRunCompactionOptions) {
    this.sessionId = options.sessionId;
    this.threshold = options.threshold;
  }

  snapshot(): CheckpointSnapshot {
    return {
      generation: this.generation,
      phase: this.phase,
      checkpointAbortRequested: this.checkpointAbortRequested,
      queuedInputs: this.queue.length,
      admission: this.phase === "exhausted"
        ? this.terminalFailure === "restoration-paused" || this.terminalFailure === "unconfirmed-host"
          ? "closed" : "recoverable-rejection"
        : this.phase === "cancelled"
          ? "closed"
          : this.phase === "idle"
            ? "open"
            : "checkpoint-only",
      ...(this.terminalFailure === undefined ? {} : { failureCategory: this.terminalFailure }),
      ...(this.terminalStage === undefined ? {} : { stage: this.terminalStage }),
      // Read by the admission-refusal notice: "wait for the cancellation to settle" is
      // true only for a `user` cancellation that is still pending, and no wait ever
      // helps once a join has reported `unconfirmed`. `cancellationCommitted` is what
      // separates a wait that ends in `/compact` from one that ends in `restoration-paused`
      // (`finishCancellation` terminalizes a committed generation instead of minting the
      // token), which kind alone cannot tell apart.
      ...(this.cancellation === undefined ? {} : {
        cancellationKind: this.cancellation.kind,
        cancellationQuiescence: this.cancellation.quiescence,
        cancellationCommitted: this.committedGeneration === this.cancellation.generation,
      }),
    };
  }

  sample(usage: ContextUsageShape | undefined, source: CheckpointSource): number | undefined {
    if (this.phase !== "idle" || this.queue.length !== 0 || !usageMeetsThreshold(usage, this.threshold)) {
      return undefined;
    }
    this.generation += 1;
    this.phase = source === "tool" || source === "assistant" ? "armed" : "awaiting-settlement";
    this.activeBatch = undefined;
    this.checkpointAbortRequested = false;
    this.runAbort = new AbortController();
    this.stable = deferred();
    this.fallback = source === "settled";
    this.resumeToken = undefined;
    this.resumedSettlement = undefined;
    this.resumedCancellationEvidence = undefined;
    this.resumedSettlementRecorded = false;
    this.queueChanged = deferred();
    this.recovery = undefined;
    this.resumedOwnership = undefined;
    this.resumeContext = undefined;
    this.cancellation = undefined;
    this.compactionSummary = undefined;
    this.committedGeneration = undefined;
    this.terminalFailure = undefined;
    this.terminalization = undefined;
    this.terminalStage = undefined;
    this.postCommitStage = undefined;
    this.pendingHostStarts.clear();
    this.hostInputLeases.clear();
    this.hostAdmissionRevoked = false;
    this.cancellationHandoff = undefined;
    this.emit("checkpoint-armed", this.generation, { source });
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
    // This records only which physical stop PiCC selected; it is not logical failure
    // evidence and deliberately cannot decide settlement-exception eligibility.
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

  /** Irrevocably records commit without publishing settlement ahead of the physical operation. */
  observeCompactionCommit(generation: number): boolean {
    if (generation !== this.generation || this.phase === "idle" || this.phase === "terminalizing") return false;
    this.committedGeneration = generation;
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
    if (generation !== this.generation || sessionId !== this.sessionId || this.fallback || this.hostAdmissionRevoked ||
        this.phase === "idle" || this.phase === "terminalizing" || this.phase === "exhausted" || this.phase === "cancelled") {
      return undefined;
    }
    const entry = { id: this.nextQueueId++, generation, sessionId, content, delivery };
    this.queue.push(entry);
    this.queueChanged.resolve();
    return entry;
  }

  consumeShadow(generation: number, id: number, sessionId = this.sessionId): QueuedInputShadow | undefined {
    if (generation !== this.generation || sessionId !== this.sessionId || this.hostAdmissionRevoked) return undefined;
    const index = this.queue.findIndex((entry) => entry.id === id && entry.generation === generation && entry.sessionId === sessionId);
    if (index < 0) return undefined;
    const [consumed] = this.queue.splice(index, 1);
    if (consumed) this.pendingHostStarts.delete(consumed.id);
    this.queueChanged.resolve();
    return consumed;
  }

  queuedInputSnapshot(): readonly QueuedInputShadow[] {
    return [...this.queue];
  }

  /**
   * Hand back input this generation can no longer deliver. A terminal generation keeps
   * its queue on purpose — a recoverable exhaustion holds it for `/compact` — so the
   * moment the controller is replaced or its session left is when those shadows stop
   * being reachable, and the last moment a report can still name them. Draining here is
   * what keeps that report exactly once: the replacement path finds nothing left when a
   * cancellation already drained and reported the same shadows — and for the one branch
   * that reports without draining, `reported` says so, so these shadows are released
   * without being named twice.
   */
  releaseQueuedInput(): readonly QueuedInputShadow[] {
    const released = this.queue.splice(0);
    this.pendingHostStarts.clear();
    return this.cancellation?.reported ? [] : released;
  }

  ordinaryInputDisposition(): OrdinaryInputDisposition {
    if (this.phase === "idle") return "accept";
    if (this.phase === "exhausted") {
      if (this.terminalFailure === "restoration-paused") return "reject-restoration";
      if (this.terminalFailure === "unconfirmed-host" || !this.recovery) return "reject-closed";
      return "reject-recoverable";
    }
    if (this.phase === "cancelled") return "reject-closed";
    if (this.hostAdmissionRevoked) return "reject-settling";
    return "quarantine";
  }

  providerAdmissionAllowed(generation: number): boolean {
    return generation === this.generation && this.phase === "resuming" && !this.hostAdmissionRevoked;
  }

  isProcessTerminal(): boolean {
    return (this.phase === "exhausted" && this.terminalFailure === "unconfirmed-host") ||
      (this.phase === "cancelled" && this.cancellation?.quiescence === "unconfirmed");
  }

  settleMalformedAtHostBoundary(generation: number): boolean {
    if (generation !== this.generation || (this.phase !== "armed" && this.phase !== "stopping")) return false;
    this.exhaust(generation, "operational");
    return true;
  }

  exhaustUnsuccessfulAwaitingSettlement(generation: number): boolean {
    if (generation !== this.generation || this.phase !== "awaiting-settlement" ||
        this.committedGeneration === generation) return false;
    this.exhaust(generation, "operational");
    return true;
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
      const ownership: RunOwnership = { generation, settled: deferred() };
      this.runOwnership = ownership;
      void this.run(generation)
        .catch(() => {
          if (this.phase === "cancelled") return;
          if (this.isCurrent(generation)) this.exhaust(generation);
        })
        .finally(() => {
          if (this.runOwnership === ownership) this.runOwnership = undefined;
          ownership.settled.resolve();
        });
    }
    return generationBarrier.promise;
  }

  /** Record run-bound terminal-aborted evidence before the physical run settles. */
  resumedAborted(token: ResumeToken): boolean {
    if (token !== this.resumeToken || token.generation !== this.generation || this.phase !== "resuming" ||
        this.resumedCancellationEvidence) return false;
    this.resumedCancellationEvidence = token;
    return true;
  }

  resumedSettled(token: ResumeToken, outcome: ResumedSettlementOutcome = "completed"): boolean {
    if (token !== this.resumeToken || token.generation !== this.generation || this.phase !== "resuming" ||
        this.resumedSettlementRecorded) return false;
    if (outcome === "cancelled" && this.resumedCancellationEvidence !== token) return false;
    this.resumedSettlementRecorded = true;
    if (outcome === "cancelled") {
      this.hostAdmissionRevoked = true;
      const context = this.resumeContext;
      if (context) void this.settleResumedCancellation(token.generation, context);
    }
    this.resumedSettlement?.resolve(outcome);
    return true;
  }

  admitHostInput(inputClass: HostInputClass): HostInputAdmission {
    if (this.phase === "idle" && this.queue.length === 0 && !this.hostAdmissionRevoked) {
      return { kind: "inactive" };
    }
    if (this.hostAdmissionRevoked || this.phase === "terminalizing" || this.phase === "exhausted" ||
        this.phase === "cancelled") return { kind: "refuse-settling" };
    const lease = { sessionId: this.sessionId, generation: this.generation, inputClass, token: {} };
    this.hostInputLeases.set(lease, { lease, settled: deferred() });
    return { kind: "lease", lease };
  }

  settleHostInput(
    lease: HostInputLease,
    acceptedShadow?: QueuedInputShadow,
  ): boolean {
    const active = this.hostInputLeases.get(lease);
    if (!active || active.lease !== lease || lease.sessionId !== this.sessionId ||
        lease.generation !== this.generation) return false;
    if (acceptedShadow) {
      if (acceptedShadow.sessionId !== this.sessionId || acceptedShadow.generation !== this.generation ||
          !this.queue.some((entry) => entry === acceptedShadow)) return false;
      this.pendingHostStarts.add(acceptedShadow.id);
    }
    this.hostInputLeases.delete(lease);
    active.settled.resolve();
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
    if (this.phase === "exhausted") {
      // An exhausted generation already chose its terminal: its barrier is published,
      // its diagnostic is emitted, and its recovery capability is either minted or
      // deliberately withheld. Re-entering would announce a second ending and, after a
      // post-commit terminal, mint the `user` recovery token that permits re-compacting
      // an already committed summary — the one lie this machinery must never tell.
      return Promise.resolve({ cancelled: false, rejected: [] });
    }
    // Every remaining phase is live, so this is the only place a cancellation state is
    // created and the finish that publishes it is scheduled unconditionally below.
    const cancellation: CancellationState = {
      generation, kind, quiescence: "pending", outcome: deferred<CancellationOutcome>(),
    };
    this.phase = "cancelled";
    this.cancellation = cancellation;
    this.checkpointAbortRequested = false;
    this.compactionSummary = undefined;
    this.runAbort.abort(kind);
    this.queueChanged.resolve();
    this.startCancelAndJoin(generation);
    const generationBarrier = this.stable ??= deferred();
    const activeRun = this.runOwnership?.generation === generation ? this.runOwnership.settled.promise : undefined;
    // Not retained: the finish publishes both of this cancellation's surfaces itself, so a
    // caller waits on `outcome`/the barrier rather than on the finish. `outcome` rejects if
    // the join cannot confirm quiescence, which is why nothing has to await this chain.
    void Promise.resolve(activeRun)
      .then(() => this.finishCancellation(cancellation, generationBarrier));
    return cancellation.outcome.promise;
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
    this.committedGeneration = undefined;
    this.recovery = undefined;
    // Recovery is the one transition from a terminal back to a live phase, so it is also
    // the only place a cancellation could outlive the phase that owns it. Dropping it keeps
    // "a live phase never carries a cancellation" true by construction, which is what lets
    // `publishExit` force `cancelled: true`. An in-flight `finishCancellation` is unaffected:
    // it publishes through the state it was handed and its identity guard already declines
    // to mutate a controller that replaced it.
    this.cancellation = undefined;
    this.emit("checkpoint-recovered");
    return { recovered: true, rejected };
  }

  /** Close a generation after its summary committed; no recovery capability survives. */
  failAfterCommittedSummary(
    generation: number,
    stage?: PostCommitStage,
  ): Promise<readonly QueuedInputShadow[]> {
    return this.terminalizeAfterCommittedSummary(generation, stage);
  }

  private currentBatch(handle: ToolBatchHandle): ActiveBatch | undefined {
    return this.phase === "stopping" && handle === this.activeBatch?.handle &&
      handle.generation === this.generation ? this.activeBatch : undefined;
  }

  private async run(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    this.phase = "compacting";
    let result: CompactionAttemptResult;
    try {
      result = await this.options.compact(this.runAbort.signal);
    } catch {
      result = this.runAbort.signal.aborted
        ? { ok: false, category: "cancelled" }
        : { ok: false, category: "operational" };
    } finally {
      // The adapter normally closes its token; this floor prevents ordinary
      // transport from inheriting summary authority after adapter settlement.
      this.compactionSummary = undefined;
    }
    if (!result.ok && result.category === "unconfirmed-host") {
      this.exhaustUnconfirmed(
        generation,
        this.stable,
        this.committedGeneration === generation ? "restoration" : undefined,
      );
      return;
    }
    if (!result.ok && this.committedGeneration === generation) {
      await this.terminalizeAfterCommittedSummary(generation, "restoration");
      return;
    }
    if (!this.isCurrent(generation)) return;
    if (result.ok) {
      this.phase = "awaiting-settlement";
      this.emit("checkpoint-complete", generation, {
        action: this.fallback ? "settled-fallback" : "resume",
      });
      await this.resumeOrFinish(generation);
      return;
    }
    if (result.category === "cancelled" || result.category === "shutdown") {
      void this.cancel(generation, result.category === "shutdown" ? "shutdown" : "user");
    } else if (result.category === "restoration-paused") {
      await this.terminalizeAfterCommittedSummary(generation, "restoration");
    } else {
      this.exhaust(generation, result.category);
    }
  }

  private async resumeOrFinish(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    if (this.fallback) {
      if (this.queue.length === 0) this.finishGeneration(generation);
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
    let context!: ResumeContext;
    context = {
      generation,
      token,
      signal: this.runAbort.signal,
      advancePostCommitStage: (stage) => this.advanceAdapterPostCommitStage(context, stage),
    };
    this.resumeContext = context;
    this.postCommitStage = "restoration";
    try {
      const ownership = await this.options.resume(context);
      if (generation !== this.generation || this.resumeContext !== context || this.resumeToken !== token ||
          (this.phase !== "resuming" && this.phase !== "cancelled")) return;
      this.advanceInternalPostCommitStage("continuation-start");
      if (!ownership || typeof ownership.replay !== "function" || typeof ownership.cancelAndJoin !== "function") {
        throw new Error("invalid resume ownership");
      }
      this.resumedOwnership = ownership;
      this.advanceInternalPostCommitStage("input-replay");
      if (this.isCancelled()) {
        this.startCancelAndJoin(generation);
        return;
      }
      const settlement: Promise<ResumedSettlementOutcome> = ownership.settled
        ? ownership.settled.then(() => "completed" as const)
        : this.resumedSettlement.promise;
      await this.replayUntilSettled(generation, ownership, context, settlement);
    } catch {
      if (this.isCancelled()) return;
      // The summary is already committed before resume ownership begins. Any
      // restoration, replay, startup, or settlement failure is terminal for
      // this session and must never mint a token that permits re-compaction.
      await this.terminalizeAfterCommittedSummary(generation, this.postCommitStage ?? "restoration");
    }
  }

  private async replayUntilSettled(
    generation: number,
    ownership: ResumedRunOwnership,
    context: ResumeContext,
    settlement: Promise<ResumedSettlementOutcome>,
  ): Promise<void> {
    let settlementOutcome: ResumedSettlementOutcome | undefined;
    let replayCompleted = false;
    const settlementEvent = settlement.then((outcome) => {
      settlementOutcome = outcome;
      return "settled" as const;
    });

    while (this.isCurrent(generation)) {
      while (this.queue.length > 0 && this.isCurrent(generation)) {
        if (settlementOutcome) {
          if (settlementOutcome === "cancelled") await this.settleResumedCancellation(generation, context);
          else await this.terminalizeAfterCommittedSummary(generation, "resumed-work");
          return;
        }
        // Pending host starts retain custody but do not head-of-line block later
        // occurrences. Select an unsent shadow so every occurrence is enqueued once
        // before the provider barrier opens.
        const entry = this.queue.find((candidate) => !this.pendingHostStarts.has(candidate.id));
        if (!entry) break;
        let result: ReplayDeliveryResult = { delivered: false };
        try {
          const replayEvent = Promise.resolve(ownership.replay(entry, context)).then((candidate) => ({
            kind: "replay" as const,
            candidate,
          }));
          const event = await Promise.race([
            replayEvent,
            settlementEvent.then(() => ({ kind: "settled" as const })),
          ]);
          if (event.kind === "settled") {
            if (settlementOutcome === "cancelled") await this.settleResumedCancellation(generation, context);
            else await this.terminalizeAfterCommittedSummary(generation, "input-replay");
            return;
          }
          const candidate = event.candidate;
          if (candidate?.delivered === true || candidate?.delivered === false) result = candidate;
        } catch {
          // A throwing adapter has not demonstrated delivery, so controller ownership remains.
        }
        if (result.delivered && this.queue.includes(entry)) {
          if (result.pendingHostStart) this.pendingHostStarts.add(entry.id);
          else this.queue.splice(this.queue.indexOf(entry), 1);
        }
        if (this.isCancelled()) return;
        if (!result.delivered) {
          await this.terminalizeAfterCommittedSummary(generation, "input-replay");
          return;
        }
      }
      if (!this.isCurrent(generation)) break;
      if (!replayCompleted && ownership.replayComplete) {
        this.advanceInternalPostCommitStage("provider-release");
        try {
          await ownership.replayComplete(context);
          replayCompleted = true;
        } catch {
          if (!this.isCancelled()) await this.terminalizeAfterCommittedSummary(generation, "provider-release");
          return;
        }
      }
      if (!this.isCurrent(generation)) return;
      this.advanceInternalPostCommitStage("resumed-work");
      if (settlementOutcome) {
        if (settlementOutcome === "cancelled") await this.settleResumedCancellation(generation, context);
        else this.finishGeneration(generation);
        return;
      }
      this.queueChanged = deferred();
      if (this.queue.some((entry) => !this.pendingHostStarts.has(entry.id))) continue;
      const event = await Promise.race([
        settlementEvent,
        this.queueChanged.promise.then(() => "queue" as const),
      ]);
      if (event === "settled") {
        // A competing terminalization can own the ending while this race is parked.
        // The completed branch then declines to finish, while the cancelled branch
        // joins that owner; neither publishes a second ending or handoff.
        if (settlementOutcome === "cancelled") await this.settleResumedCancellation(generation, context);
        else if (this.queue.length === 0) this.finishGeneration(generation);
        else await this.terminalizeAfterCommittedSummary(generation, "resumed-work");
        return;
      }
    }
  }

  private settleResumedCancellation(
    generation: number,
    context: ResumeContext,
  ): Promise<readonly QueuedInputShadow[]> {
    if (generation !== this.generation || context !== this.resumeContext ||
        this.resumedCancellationEvidence !== context.token) return Promise.resolve([]);
    if (this.phase === "terminalizing") return this.terminalization ?? Promise.resolve([]);
    if (this.phase !== "resuming") return Promise.resolve([]);

    const generationBarrier = this.stable;
    this.phase = "terminalizing";
    this.hostAdmissionRevoked = true;
    this.checkpointAbortRequested = false;
    this.compactionSummary = undefined;
    this.terminalFailure = "restoration-paused";
    this.terminalStage = "resumed-cancellation";
    this.recovery = undefined;
    this.queueChanged.resolve();

    const terminalization = (async (): Promise<readonly QueuedInputShadow[]> => {
      const leases = [...this.hostInputLeases.values()];
      try {
        await withHostDeadline(
          Promise.all(leases.map((entry) => entry.settled.promise)).then(() => undefined),
          resumedJoinDeadline(this.options.deadlinePolicy),
          deadlineClock(this.options.deadlinePolicy),
        );
      } catch {
        this.terminalStage = "cancellation-join";
        this.terminalFailure = "unconfirmed-host";
        this.phase = "exhausted";
        this.clearResumeAuthority();
        this.emit("checkpoint-cancelled", generation, {
          action: "restart-process",
          failureCategory: "unconfirmed-host",
          stage: "cancellation-join",
        });
        return [];
      }

      const retained = this.queuedInputSnapshot();
      const acceptedToHostIds = retained.filter((entry) => this.pendingHostStarts.has(entry.id)).map((entry) => entry.id);
      const piccOwnedIds = retained.filter((entry) => !this.pendingHostStarts.has(entry.id)).map((entry) => entry.id);
      const handoff: CancelledInputHandoff = Object.freeze({
        sessionId: this.sessionId,
        generation,
        token: {},
        retained: Object.freeze([...retained]),
        acceptedToHostIds: Object.freeze(acceptedToHostIds),
        piccOwnedIds: Object.freeze(piccOwnedIds),
      });
      this.cancellationHandoff = handoff;

      let resolution: CancelledInputResolution | undefined;
      try {
        const cancelledInput = this.options.cancelledInput;
        if (!cancelledInput) throw new Error("Cancelled-input adapter is not attached");
        resolution = await withHostDeadline(
          Promise.resolve(cancelledInput(handoff, context)),
          resumedJoinDeadline(this.options.deadlinePolicy),
          deadlineClock(this.options.deadlinePolicy),
        );
      } catch (error) {
        if (error instanceof UnconfirmedHostDeadlineError) {
          this.terminalStage = "cancellation-join";
          this.terminalFailure = "unconfirmed-host";
          this.phase = "exhausted";
          this.clearResumeAuthority();
          this.emit("checkpoint-cancelled", generation, {
            action: "restart-process",
            failureCategory: "unconfirmed-host",
            stage: "cancellation-join",
          });
          return [];
        }
        resolution = undefined;
      }
      const validated = this.validateCancelledInputResolution(handoff, resolution);
      const resolvedIds = new Set([...validated.dispositions]
        .filter(([, disposition]) => disposition !== "unresolved")
        .map(([id]) => id));
      if (resolvedIds.size > 0) {
        this.queue = this.queue.filter((entry) => !resolvedIds.has(entry.id));
        for (const id of resolvedIds) this.pendingHostStarts.delete(id);
      }
      this.clearResumeAuthority();

      if (validated.authenticated && this.queue.length === 0) {
        this.phase = "idle";
        this.committedGeneration = undefined;
        this.terminalFailure = undefined;
        this.terminalStage = undefined;
        this.hostAdmissionRevoked = false;
        this.emit("checkpoint-cancelled", generation, {
          action: "session-reusable",
          failureCategory: "restoration-paused",
          stage: "resumed-cancellation",
        });
        return [];
      }

      this.phase = "exhausted";
      this.terminalStage = "cancellation-join";
      this.emit("checkpoint-exhausted", generation, {
        action: "new-session",
        failureCategory: "restoration-paused",
        stage: "cancellation-join",
      });
      return [];
    })().finally(() => this.publishExit(generation, generationBarrier));
    this.terminalization = terminalization;
    return terminalization;
  }

  private validateCancelledInputResolution(
    handoff: CancelledInputHandoff,
    resolution: CancelledInputResolution | undefined,
  ): { authenticated: boolean; dispositions: ReadonlyMap<number, CancelledInputDisposition> } {
    const unresolved = new Map(handoff.retained.map((entry) => [entry.id, "unresolved" as const]));
    try {
      if (!resolution || resolution.sessionId !== handoff.sessionId || resolution.generation !== handoff.generation ||
          resolution.token !== handoff.token || !Array.isArray(resolution.resolutions)) {
        return { authenticated: false, dispositions: unresolved };
      }
      const expected = new Set(handoff.retained.map((entry) => entry.id));
      const validated = new Map<number, CancelledInputDisposition>();
      for (const entry of resolution.resolutions) {
        if (!entry || typeof entry !== "object" || !expected.has(entry.id) || validated.has(entry.id) ||
            (entry.disposition !== "restored" && entry.disposition !== "reported" && entry.disposition !== "unresolved")) {
          return { authenticated: false, dispositions: unresolved };
        }
        validated.set(entry.id, entry.disposition);
      }
      if (validated.size !== expected.size) return { authenticated: false, dispositions: unresolved };
      return { authenticated: true, dispositions: validated };
    } catch {
      return { authenticated: false, dispositions: unresolved };
    }
  }

  private advanceAdapterPostCommitStage(
    context: ResumeContext,
    stage: "continuation-start",
  ): boolean {
    if (context !== this.resumeContext || context.token !== this.resumeToken ||
        context.generation !== this.generation || this.phase !== "resuming" ||
        this.postCommitStage !== "restoration") return false;
    this.postCommitStage = stage;
    return true;
  }

  private advanceInternalPostCommitStage(stage: PostCommitStage): void {
    const order: readonly PostCommitStage[] = [
      "restoration",
      "continuation-start",
      "input-replay",
      "provider-release",
      "resumed-work",
    ];
    const current = this.postCommitStage === undefined ? -1 : order.indexOf(this.postCommitStage);
    const next = order.indexOf(stage);
    if (next >= 0 && next > current) this.postCommitStage = stage;
  }

  private clearResumeAuthority(): void {
    this.resumedOwnership = undefined;
    this.resumeContext = undefined;
    this.resumeToken = undefined;
    this.resumedSettlement = undefined;
    this.resumedCancellationEvidence = undefined;
    this.resumedSettlementRecorded = false;
    this.postCommitStage = undefined;
    this.hostInputLeases.clear();
  }

  private terminalizeAfterCommittedSummary(
    generation: number,
    stage?: PostCommitStage,
  ): Promise<readonly QueuedInputShadow[]> {
    if (generation !== this.generation ||
        (this.phase === "exhausted" && this.terminalFailure === "restoration-paused")) return Promise.resolve([]);
    if (this.phase === "terminalizing") return this.terminalization ?? Promise.resolve([]);

    const ownership = this.resumedOwnership;
    const context = this.resumeContext;
    const generationBarrier = this.stable;
    this.phase = "terminalizing";
    this.checkpointAbortRequested = false;
    this.compactionSummary = undefined;
    this.terminalFailure = "restoration-paused";
    this.terminalStage = stage;
    this.recovery = undefined;
    this.runAbort.abort("post-commit failure");
    this.queueChanged.resolve();

    let rejected: readonly QueuedInputShadow[] = [];
    const terminalization = (async (): Promise<readonly QueuedInputShadow[]> => {
      try {
        if (ownership && context) {
          try {
            const joining = Promise.resolve(ownership.cancelAndJoin("replacement", context));
            await (this.options.deadlinePolicy
              ? withHostDeadline(
                  joining,
                  resumedJoinDeadline(this.options.deadlinePolicy),
                  deadlineClock(this.options.deadlinePolicy),
                )
              : joining);
          } catch (error) {
            if (error instanceof UnconfirmedHostDeadlineError) {
              return this.exhaustUnconfirmed(generation, generationBarrier, "cancellation-join");
            }
            // The adapter revoked provider/replay authority before this join. An ordinary
            // settled rejection still confirms host quiescence and keeps the post-commit
            // terminal; only deadline expiry leaves host quiescence unconfirmed.
          }
        }
        // Nothing else can leave `terminalizing`: `sample` needs `idle`, `cancel` and a
        // re-entrant terminalization return this promise, and `exhaust`/`finishGeneration`
        // refuse a generation that is no longer live. The guard is a floor for a future
        // transition rather than a reachable path, and the `finally` is what keeps it
        // from becoming a strand if one ever appears.
        if (generation !== this.generation || this.phase !== "terminalizing") return [];
        this.resumedOwnership = undefined;
        this.resumeContext = undefined;
        this.resumeToken = undefined;
        this.resumedSettlement = undefined;
        rejected = this.queue.splice(0);
        this.pendingHostStarts.clear();
        this.phase = "exhausted";
        this.emit("checkpoint-exhausted", generation, {
          action: "new-session",
          failureCategory: "restoration-paused",
          ...(stage === undefined ? {} : { stage }),
        });
        // The ending tells the reader to resend the retained input; this is what names
        // it. Every internal caller of this transition discards the return value, so the
        // report cannot depend on one of them forwarding it.
        this.reportDropped(rejected);
        return rejected;
      } finally {
        this.publishExit(generation, generationBarrier, rejected);
      }
    })();
    this.terminalization = terminalization;
    return terminalization;
  }

  private finishGeneration(generation: number): void {
    // A generation that has left the live phases belongs to the transition that took it
    // there; completing it from behind would resolve its barrier while a terminalization
    // is still joining the host, and strand that terminalization's own surfaces.
    if (!this.isCurrent(generation)) return;
    if (this.queue.length !== 0) {
      this.exhaust(generation);
      return;
    }
    const generationBarrier = this.stable;
    try {
      this.phase = "idle";
      this.checkpointAbortRequested = false;
      this.compactionSummary = undefined;
      this.committedGeneration = undefined;
    } finally {
      this.publishExit(generation, generationBarrier);
    }
  }

  private exhaust(generation: number, failureCategory: CompactionFailureCategory = "operational"): void {
    if (!this.isCurrent(generation)) return;
    const generationBarrier = this.stable;
    try {
      this.phase = "exhausted";
      this.checkpointAbortRequested = false;
      this.compactionSummary = undefined;
      // A terminal generation retains no adapter ownership. Terminalization drops the same
      // four fields; dropping them here too makes that a property of every terminal instead
      // of a cross-file invariant about which adapter published its own settlement first —
      // which is what the `exhausted` guard in `cancel()` would otherwise have to rest on.
      this.resumedOwnership = undefined;
      this.resumeContext = undefined;
      this.resumeToken = undefined;
      this.resumedSettlement = undefined;
      this.terminalFailure = failureCategory;
      this.recovery = failureCategory === "restoration-paused" ? undefined : { generation, token: {} };
      this.emit("checkpoint-exhausted", generation, {
        action: failureCategory === "restoration-paused" ? "new-session" : "manual-recovery",
        failureCategory,
      });
    } finally {
      this.publishExit(generation, generationBarrier);
    }
  }

  /**
   * Publish everything one generation hands out: the barrier held by `checkpoint()` and
   * `stableBarrier()` callers, the outcome held by `cancel()` callers, and the replay
   * loop's queue wait. Every transition out of a live phase calls this from a `finally`,
   * so an early return added to one of those bodies later cannot strand a caller — the
   * body decides the terminal, this decides that it is published, and both promise
   * surfaces settle exactly once because the first settlement wins.
   *
   * The barrier — and, where the caller holds one, the cancellation — is passed in because
   * both are *handed-out* surfaces: a generation that has been overtaken must still release
   * its own callers and not the successor's. `queueChanged` is deliberately the opposite: it
   * is read live off the controller because it is a wake-up that every loop re-arms, and the
   * point is to wake whoever is parked *now*, not the generation that captured it. Capturing
   * it would poke a deferred nobody is waiting on and leave the current waiter parked.
   *
   * `cancelled: true` is truthful wherever a cancellation for `generation` exists: only
   * `cancel()` creates one, it leaves the live phases synchronously, and every transition
   * back to a live phase clears it — so a completing transition can never observe one.
   *
   * The boundary of the guarantee, stated because it cannot be closed here: the
   * controller publishes exactly once *whenever every adapter promise it awaits settles*.
   * It cannot make `compact`, `replay`, `replayComplete`, or `cancelAndJoin` return, so a
   * host that never answers still parks the transition joining it. Totality of those
   * waits belongs to the resume adapter's `conclude` in `src/index.ts`, which ends the
   * resumed run on every exit instead of waiting for a host event that may never arrive.
   */
  private publishExit(
    generation: number,
    generationBarrier: Deferred<void> | undefined,
    rejected: readonly QueuedInputShadow[] = [],
    cancellation = this.cancellation,
  ): void {
    generationBarrier?.resolve();
    if (cancellation?.generation === generation) {
      cancellation.outcome.resolve({ cancelled: true, rejected });
    }
    this.queueChanged.resolve();
  }

  private startCancelAndJoin(generation: number): void {
    const cancellation = this.cancellation;
    const ownership = this.resumedOwnership;
    const context = this.resumeContext;
    if (!cancellation || cancellation.generation !== generation || cancellation.join || !ownership || !context) return;
    const join = deferred();
    cancellation.join = join.promise;
    try {
      const joining = Promise.resolve(ownership.cancelAndJoin(cancellation.kind, context));
      (this.options.deadlinePolicy
        ? withHostDeadline(
            joining,
            resumedJoinDeadline(this.options.deadlinePolicy),
            deadlineClock(this.options.deadlinePolicy),
          )
        : joining).then(join.resolve, join.reject);
    } catch (error) {
      join.reject(error);
    }
  }

  private async finishCancellation(cancellation: CancellationState, generationBarrier: Deferred<void>): Promise<void> {
    const generation = cancellation.generation;
    let rejected: readonly QueuedInputShadow[] = [];
    try {
      // Identity, not fields: a cancellation the controller has already replaced no
      // longer owns the terminal, but its own callers are still published in `finally`.
      if (this.cancellation !== cancellation) return;
      if (this.phase === "terminalizing") {
        await this.terminalization;
        return;
      }
      this.startCancelAndJoin(generation);
      try {
        await cancellation.join;
      } catch {
        // A rejection is a terminal answer: a caller that awaits either surface learns
        // quiescence could not be confirmed instead of waiting forever for one.
        cancellation.quiescence = "unconfirmed";
        // Both surfaces reject, and every consumer of a rejection swallows it, so this
        // ending had no words in any mode. Emitted before the rejections, so the
        // diagnostic is out before any awaiting caller wakes. `restart-process` rather
        // than `new-session`: this generation mints no recovery capability, and the same
        // rejection comes back out of controller replacement, so a replacement session is
        // refused too. The queue is reported but deliberately NOT drained — this branch
        // must not decide anything about a generation whose quiescence it could not
        // establish. `reported` is what keeps it exactly once: controller replacement
        // still drains this queue, and must not name the same shadows again.
        this.emit("checkpoint-cancelled", generation, { action: "restart-process" });
        cancellation.reported = true;
        this.reportDropped(this.queuedInputSnapshot());
        const failure = new Error("Checkpoint cancellation could not confirm quiescence");
        generationBarrier.reject(failure);
        cancellation.outcome.reject(failure);
        return;
      }
      cancellation.quiescence = "confirmed";
      // Read through `snapshot()`: the join can drive the very transition the guard
      // above excluded, which narrowing on `this.phase` would then declare impossible.
      if (this.snapshot().phase === "terminalizing") {
        await this.terminalization;
        return;
      }
      if (this.committedGeneration === generation) {
        await this.terminalizeAfterCommittedSummary(generation, "cancellation-join");
        return;
      }
      if (this.phase === "exhausted") return;
      rejected = this.queue.splice(0);
      this.pendingHostStarts.clear();
      if (cancellation.kind === "user") this.recovery = { generation, token: {} };
      // Only `replacement` puts the reader in a new session. `shutdown` is the process
      // leaving and `task-stop` is a child task being abandoned: telling either to resend
      // input in a session that will never exist is the guidance this task exists to
      // delete.
      this.emit("checkpoint-cancelled", generation, {
        action: cancellation.kind === "user"
          ? "manual-recovery"
          : cancellation.kind === "replacement" ? "new-session" : "session-ended",
      });
      this.reportDropped(rejected);
    } finally {
      this.publishExit(generation, generationBarrier, rejected, cancellation);
    }
  }

  private exhaustUnconfirmed(
    generation: number,
    generationBarrier = this.stable,
    stage?: PostCommitStage,
  ): readonly QueuedInputShadow[] {
    if (generation !== this.generation) return [];
    const rejected = this.queue.splice(0);
    this.pendingHostStarts.clear();
    this.phase = "exhausted";
    this.checkpointAbortRequested = false;
    this.compactionSummary = undefined;
    this.resumedOwnership = undefined;
    this.resumeContext = undefined;
    this.resumeToken = undefined;
    this.resumedSettlement = undefined;
    this.terminalFailure = "unconfirmed-host";
    this.terminalStage = stage;
    this.recovery = undefined;
    this.emit("checkpoint-cancelled", generation, {
      action: "restart-process",
      failureCategory: "unconfirmed-host",
      ...(stage === undefined ? {} : { stage }),
    });
    this.reportDropped(rejected);
    this.publishExit(generation, generationBarrier, rejected);
    return rejected;
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
    details: Pick<CheckpointProgress, "source" | "action" | "failureCategory" | "stage"> = {},
  ): void {
    try {
      this.options.progress?.({ category, generation, ...details });
    } catch {
      // Observers cannot own checkpoint transitions or barriers.
    }
  }

  private reportDropped(rejected: readonly QueuedInputShadow[]): void {
    if (rejected.length === 0) return;
    try {
      this.options.inputDropped?.(rejected);
    } catch {
      // Observers cannot own checkpoint transitions or barriers.
    }
  }
}

interface MainGateContext {
  model?: { api?: string; contextWindow?: number };
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

interface ToolObservationAuthority {
  controller: MidRunCompactionController;
  epoch: object;
  logicalRun: object;
  batch: MainBatchObservation;
  generation: number | undefined;
  handle: ToolBatchHandle | undefined;
}

export interface CheckpointExecutionAdapter {
  compact(signal: AbortSignal): Promise<CompactionAttemptResult>;
  resume?(context: ResumeContext): ResumedRunOwnership | Promise<ResumedRunOwnership>;
  cancelledInput?(
    handoff: CancelledInputHandoff,
    context: ResumeContext,
  ): CancelledInputResolution | Promise<CancelledInputResolution>;
  progress?(event: CheckpointProgress): void;
  /** Input an ending, or the replacement of this gate's controller, can no longer deliver. */
  inputDropped?(rejected: readonly QueuedInputShadow[]): void;
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

function completedAssistantUsage(message: unknown, contextWindow: unknown): ContextUsageShape | undefined {
  try {
    if (!message || typeof message !== "object" ||
        !Number.isFinite(contextWindow) || (contextWindow as number) <= 0) return undefined;
    const stopReason = (message as { stopReason?: unknown }).stopReason;
    if (stopReason !== "stop" && stopReason !== "length" && stopReason !== "toolUse") return undefined;
    const usage = (message as { usage?: unknown }).usage;
    if (!usage || typeof usage !== "object") return undefined;
    const tokens = calculateContextTokens(usage as Parameters<typeof calculateContextTokens>[0]);
    if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
    return { tokens, contextWindow: contextWindow as number, percent: tokens / (contextWindow as number) * 100 };
  } catch {
    return undefined;
  }
}

function acceptedContent(text: string, images: readonly unknown[] | undefined): QueueContent {
  return images?.length ? [{ type: "text", text }, ...images] : text;
}

interface ReconciliationTextBlock { readonly type: "text"; readonly text: string }
interface ReconciliationImageBlock { readonly type: "image"; readonly data: string; readonly mimeType: string }
type ReconciliationBlock = ReconciliationTextBlock | ReconciliationImageBlock;
type ReconciliationContent =
  | { kind: "text"; text: string }
  | { kind: "blocks"; blocks: readonly ReconciliationBlock[] };

function exactOwnDataFields(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== keys.length || keys.some((key) => !names.includes(key))) return undefined;
    const fields: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      fields[key] = descriptor.value;
    }
    return fields;
  } catch {
    return undefined;
  }
}

function reconciliationBlock(value: unknown): ReconciliationBlock | undefined {
  const text = exactOwnDataFields(value, ["type", "text"]);
  if (text?.type === "text" && typeof text.text === "string") return { type: "text", text: text.text };
  const image = exactOwnDataFields(value, ["type", "data", "mimeType"]);
  if (image?.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string") {
    return { type: "image", data: image.data, mimeType: image.mimeType };
  }
  return undefined;
}

function reconciliationContent(value: unknown): ReconciliationContent | undefined {
  if (typeof value === "string") return { kind: "text", text: value };
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const names = Object.getOwnPropertyNames(value);
    if (value.length === 0 || names.length !== value.length + 1 || !names.includes("length")) return undefined;
    const blocks: ReconciliationBlock[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      const block = reconciliationBlock(descriptor.value);
      if (!block) return undefined;
      blocks.push(block);
    }
    return { kind: "blocks", blocks };
  } catch {
    return undefined;
  }
}

function reconciliationBlockEqual(left: ReconciliationBlock, right: ReconciliationBlock): boolean {
  if (left.type !== right.type) return false;
  return left.type === "text"
    ? left.text === (right as ReconciliationTextBlock).text
    : left.data === (right as ReconciliationImageBlock).data && left.mimeType === (right as ReconciliationImageBlock).mimeType;
}

function reconciliationContentEqual(left: ReconciliationContent, right: ReconciliationContent): boolean {
  if (left.kind === "text") {
    if (right.kind === "text") return left.text === right.text;
    return right.blocks.length === 1 && right.blocks[0]?.type === "text" && right.blocks[0].text === left.text;
  }
  if (right.kind === "text") {
    return left.blocks.length === 1 && left.blocks[0]?.type === "text" && left.blocks[0].text === right.text;
  }
  return left.blocks.length === right.blocks.length &&
    left.blocks.every((block, index) => reconciliationBlockEqual(block, right.blocks[index]!));
}

interface ExpectedInput {
  content: QueueContent;
  reconciliation: ReconciliationContent | undefined;
  delivery: QueueDeliveryMode;
}

export interface RetainedInputOccurrenceEnvelope {
  readonly sessionId: string;
  readonly generation: number;
  readonly id: number;
  readonly delivery: QueueDeliveryMode;
  readonly nonce: object;
}

interface TrackedInputOccurrence extends ExpectedInput {
  epoch: object;
  sessionId: string;
  generation: number;
  shadow: QueuedInputShadow;
  envelope: RetainedInputOccurrenceEnvelope;
  pendingHostStart: boolean;
}

interface ReplayAuthorization {
  gate: object;
  sessionId: string;
  generation: number;
  shadow: QueuedInputShadow;
  reconciliation: ReconciliationContent;
  source: string;
  mode: QueueDeliveryMode;
  envelope: RetainedInputOccurrenceEnvelope;
  envelopeRequired: boolean;
  used: boolean;
}

const replayAuthorization = new AsyncLocalStorage<ReplayAuthorization>();

/** Main-session lifecycle adapter around the generation-authenticated controller. */
export type HostSettlementMode = "intermediate" | "total-host";

export class MainSessionCheckpointGate {
  private controller: MidRunCompactionController;
  private execution: CheckpointExecutionAdapter | undefined;
  private generation: number | undefined;
  private generationSource: CheckpointSource | undefined;
  private handle: ToolBatchHandle | undefined;
  private batch: MainBatchObservation = { run: {}, ids: [], final: new Map(), successful: new Map() };
  private abortIssued: { generation: number; run: object } | undefined;
  private acceptedBeforeArm: ExpectedInput[] = [];
  private trackedOccurrences: TrackedInputOccurrence[] = [];
  private ambiguousInput = false;
  private sessionEpoch: object = {};
  /** Opaque identity of the user-visible logical run; physical checkpoint runs retain it. */
  private logicalRunIdentity: object = {};
  private transition: Promise<void> = Promise.resolve();
  private resumeBarrier: { generation: number; promise: Promise<void> } | undefined;
  private settledStoppedResume: {
    controller: MidRunCompactionController;
    epoch: object;
    generation: number;
  } | undefined;
  private logicalRunStop: {
    controller: MidRunCompactionController;
    epoch: object;
    generation: number;
    run: object;
    wasResuming: boolean;
    join: Promise<void>;
  } | undefined;

  constructor(
    sessionId: string,
    private readonly threshold: number,
    private readonly deadlinePolicy?: HostDeadlinePolicy,
    private readonly hostSettlementMode: HostSettlementMode = "intermediate",
  ) {
    this.controller = this.createController(sessionId);
  }

  attachExecution(adapter: CheckpointExecutionAdapter): void {
    this.execution = adapter;
  }

  currentController(): MidRunCompactionController {
    return this.controller;
  }

  /** Capture opaque authority for the current controller generation and logical run. */
  captureLogicalRunStop(): () => boolean {
    const controller = this.controller;
    const epoch = this.sessionEpoch;
    const generation = controller.snapshot().generation;
    const run = this.logicalRunIdentity;
    return () => {
      if (controller !== this.controller || epoch !== this.sessionEpoch || run !== this.logicalRunIdentity ||
          generation !== controller.snapshot().generation || this.logicalRunStop) return false;
      // Publish the latch before cancellation can re-enter lifecycle handlers. Hook
      // call sites must unwind immediately; agent_settled owns the eventual join.
      const stopped = {
        controller, epoch, generation, run,
        wasResuming: controller.snapshot().phase === "resuming",
        join: Promise.resolve(),
      };
      this.logicalRunStop = stopped;
      const join = this.cancelCurrent("replacement");
      stopped.join = join;
      this.transition = join.catch(() => undefined);
      return true;
    };
  }

  /** Rotate authority when a genuine user input has been accepted as the next run. */
  acceptedLogicalRun(): void {
    this.logicalRunIdentity = {};
    this.settledStoppedResume = undefined;
  }

  /** Revoke run-scoped authority only at a true user-visible settlement. */
  logicalRunSettled(): void {
    this.logicalRunIdentity = {};
    this.settledStoppedResume = undefined;
  }

  isLogicalRunStopped(): boolean {
    return this.logicalRunStop !== undefined;
  }

  stoppedRunMatches(controller: MidRunCompactionController, generation: number): boolean {
    const stopped = this.logicalRunStop;
    return stopped?.controller === controller && stopped.epoch === this.sessionEpoch &&
      stopped.run === this.logicalRunIdentity && stopped.generation === generation;
  }

  stoppedRunWasResuming(controller: MidRunCompactionController, generation: number): boolean {
    const stopped = this.logicalRunStop;
    return stopped?.controller === controller && stopped.epoch === this.sessionEpoch &&
      stopped.generation === generation && stopped.wasResuming;
  }

  consumeSettledStoppedResume(controller: MidRunCompactionController, generation: number): boolean {
    const stopped = this.settledStoppedResume;
    if (stopped?.controller !== controller || stopped.epoch !== this.sessionEpoch || stopped.generation !== generation) {
      return false;
    }
    this.settledStoppedResume = undefined;
    return true;
  }

  /** Join and consume a stop only from the host agent_settled boundary. */
  async settleLogicalRunStop(): Promise<boolean> {
    const stopped = this.logicalRunStop;
    if (!stopped) return false;
    await stopped.join;
    if (this.logicalRunStop !== stopped) return false;
    const wasResuming = stopped.wasResuming;
    this.resetStoppedLogicalRun();
    if (wasResuming) {
      this.settledStoppedResume = {
        controller: this.controller,
        epoch: this.sessionEpoch,
        generation: this.controller.snapshot().generation,
      };
    }
    return true;
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
    // Only after the switch is accepted: a refused switch leaves the session, and its
    // retained input, exactly where they were.
    this.releaseRetainedInput();
    this.invalidateSessionState();
    return undefined;
  }

  async startSession(sessionId: string): Promise<void> {
    const operation = this.transition.then(async () => {
      await this.cancelCurrent("replacement");
      this.releaseRetainedInput();
      this.controller = this.createController(sessionId);
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
        const ctx = args[4] as MainGateContext | undefined;
        if (ctx) gate.arm(ctx);
        const authority = gate.captureToolObservationAuthority();
        const result = await Reflect.apply(execute, this, args) as unknown as Record<string, unknown>;
        if (!gate.toolObservationAuthorityMatches(authority)) return result;
        return gate.successfulTool(String(args[0] ?? ""), result, ctx);
      },
    };
  }

  assistantMessageEnded(message: unknown, ctx?: MainGateContext): void {
    if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") return;
    const ids = toolCallIds(message);
    if (this.generationSource === "assistant" && this.controller.snapshot().phase === "stopping" &&
        ids.length === this.batch.ids.length && ids.every((id, index) => id === this.batch.ids[index])) return;
    this.batch = { run: {}, ids, final: new Map(), successful: new Map() };
    this.handle = undefined;
    this.abortIssued = undefined;
    if (ctx && ids.length > 0 && isProactiveCompactionApi(ctx.model?.api)) {
      this.armWithUsage(completedAssistantUsage(message, ctx.model?.contextWindow), "assistant");
    }
  }

  toolExecutionEnded(event: { toolCallId?: unknown; result?: unknown; isError?: unknown }): void {
    if (typeof event.toolCallId !== "string") return;
    const truncated = toolResultHasGuardClipping(event.result);
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
    if (this.logicalRunStop) {
      this.abortAfterBatch(ctx);
      return undefined;
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

  async beforeProviderRequest(ctx: MainGateContext): Promise<void> {
    this.resetCompletedGeneration();
    if (!this.logicalRunStop && this.generation === undefined && isProactiveCompactionApi(ctx.model?.api)) {
      let usage: ContextUsageShape | undefined;
      try {
        usage = ctx.getContextUsage?.();
      } catch {
        usage = undefined;
      }
      this.armWithUsage(usage, "admission");
    }
    await this.defensiveLatch(ctx);
  }

  async defensiveLatch(ctx: MainGateContext): Promise<void> {
    if (this.logicalRunStop) {
      this.abortAfterBatch(ctx);
      return;
    }
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
          current.generation !== generation || !this.controller.providerAdmissionAllowed(generation)) {
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
    if (this.logicalRunStop) return undefined;
    this.resetCompletedGeneration();
    if (this.generation !== undefined) {
      const snapshot = this.controller.snapshot();
      // Child sessions publish intermediate physical settlements while their SDK run
      // still owns progress. Only production main wiring opts into Pi's total post-run
      // settlement contract; deadline configuration is independent of that meaning.
      if (this.hostSettlementMode !== "total-host") {
        return snapshot.phase === "awaiting-settlement" ? this.generation : undefined;
      }
      if (snapshot.phase === "armed" || snapshot.phase === "stopping") {
        this.controller.settleMalformedAtHostBoundary(this.generation);
      }
      return this.generation;
    }
    if (!isProactiveCompactionApi(ctx.model?.api)) return undefined;
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
    return this.logicalRunStop ? "reject-stopped" : this.controller.ordinaryInputDisposition();
  }

  hostInputAdmission(inputClass: HostInputClass): HostInputAdmission {
    if (this.logicalRunStop) return { kind: "refuse-settling" };
    return this.controller.admitHostInput(inputClass);
  }

  settleHostInput(lease: HostInputLease, acceptedShadow?: QueuedInputShadow): boolean {
    const occurrence = acceptedShadow && this.trackedOccurrences.find((entry) => entry.shadow === acceptedShadow);
    const settled = this.controller.settleHostInput(lease, acceptedShadow);
    if (settled && occurrence) occurrence.pendingHostStart = true;
    return settled;
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
    const occurrence = this.trackedOccurrences.find((entry) => entry.shadow === input && !entry.pendingHostStart);
    const reconciliation = reconciliationContent(input.content);
    if (this.controller.snapshot().phase !== "resuming" || !current || !occurrence || !reconciliation ||
        occurrence.epoch !== this.sessionEpoch || occurrence.sessionId !== this.controller.sessionId ||
        occurrence.generation !== this.generation || input.sessionId !== this.controller.sessionId ||
        input.generation !== this.generation) {
      throw new Error("Cannot authorize stale checkpoint replay");
    }
    return replayAuthorization.run({
      gate: this.sessionEpoch,
      sessionId: input.sessionId,
      generation: input.generation,
      shadow: input,
      reconciliation,
      source,
      mode: input.delivery,
      envelope: occurrence.envelope,
      envelopeRequired: false,
      used: false,
    }, operation);
  }

  withRetainedReplayAuthorization<T>(
    input: QueuedInputShadow,
    operation: (details: { piccCheckpointInput: RetainedInputOccurrenceEnvelope }) => T,
    source = "extension",
  ): T {
    const current = this.controller.queuedInputSnapshot().find((entry) => entry === input);
    const occurrence = this.trackedOccurrences.find((entry) => entry.shadow === input && !entry.pendingHostStart);
    const reconciliation = reconciliationContent(input.content);
    if (this.controller.snapshot().phase !== "resuming" || !current || !occurrence || !reconciliation ||
        occurrence.epoch !== this.sessionEpoch || occurrence.sessionId !== this.controller.sessionId ||
        occurrence.generation !== this.generation || input.sessionId !== this.controller.sessionId ||
        input.generation !== this.generation) {
      throw new Error("Cannot authorize stale checkpoint replay");
    }
    return replayAuthorization.run({
      gate: this.sessionEpoch,
      sessionId: input.sessionId,
      generation: input.generation,
      shadow: input,
      reconciliation,
      source,
      mode: input.delivery,
      envelope: occurrence.envelope,
      envelopeRequired: true,
      used: false,
    }, () => operation({ piccCheckpointInput: occurrence.envelope }));
  }

  authorizeReplay(event: {
    text?: unknown;
    images?: readonly unknown[];
    source?: unknown;
    streamingBehavior?: unknown;
    details?: unknown;
  }): QueuedInputShadow | undefined {
    const authorization = replayAuthorization.getStore();
    const phase = this.controller.snapshot().phase;
    const observed = typeof event.text === "string"
      ? reconciliationContent(acceptedContent(event.text, event.images))
      : undefined;
    const occurrence = authorization && this.trackedOccurrences.find((entry) =>
      entry.shadow === authorization.shadow && !entry.pendingHostStart);
    if (!authorization || authorization.used || authorization.gate !== this.sessionEpoch ||
        phase !== "resuming" || !observed || !occurrence || occurrence.epoch !== this.sessionEpoch ||
        occurrence.sessionId !== this.controller.sessionId || occurrence.generation !== this.generation ||
        authorization.sessionId !== this.controller.sessionId || authorization.generation !== this.generation ||
        event.source !== authorization.source || event.streamingBehavior !== authorization.mode ||
        (authorization.envelopeRequired &&
          (event.details as { piccCheckpointInput?: unknown } | undefined)?.piccCheckpointInput !== authorization.envelope) ||
        !reconciliationContentEqual(observed, authorization.reconciliation) ||
        !this.controller.queuedInputSnapshot().some((entry) => entry === authorization.shadow)) return undefined;
    authorization.used = true;
    occurrence.pendingHostStart = true;
    return authorization.shadow;
  }

  captureAcceptedInput(
    ctx: MainGateContext,
    text: string,
    images: readonly unknown[] | undefined,
    delivery: QueueDeliveryMode | undefined,
  ): QueuedInputShadow | undefined {
    if (!isProactiveCompactionApi(ctx.model?.api)) return undefined;
    const content = acceptedContent(text, images);
    // Input is evidence to reconcile, never an executor. Tool completion or a true
    // settlement must name the generation that can actually run compaction.
    const effectiveDelivery = delivery ?? (this.generation === undefined ? undefined : "followUp");
    if (!effectiveDelivery) return undefined;
    const expected = { content, reconciliation: reconciliationContent(content), delivery: effectiveDelivery };
    if (this.generation === undefined) {
      this.acceptedBeforeArm.push(expected);
      return undefined;
    }
    return this.trackShadow(this.controller.shadowInput(this.generation, content, effectiveDelivery), expected);
  }

  userMessageStarted(message: unknown, delivery?: QueueDeliveryMode): QueuedInputShadow | undefined {
    this.resetCompletedGeneration();
    if (!message || typeof message !== "object" || (message as { role?: string }).role !== "user") return undefined;
    const observed = reconciliationContent((message as { content?: unknown }).content);
    if (this.generation === undefined) {
      const eligible = this.eligibleOccurrence(this.acceptedBeforeArm, delivery);
      if (eligible && observed && eligible.reconciliation && reconciliationContentEqual(eligible.reconciliation, observed)) {
        this.acceptedBeforeArm.splice(this.acceptedBeforeArm.indexOf(eligible), 1);
      } else if (this.acceptedBeforeArm.length > 0) {
        this.ambiguousInput = true;
      }
      return undefined;
    }
    const current = this.trackedOccurrences.filter((entry) =>
      entry.epoch === this.sessionEpoch && entry.sessionId === this.controller.sessionId &&
      entry.generation === this.generation);
    const eligible = this.eligibleOccurrence(current, delivery);
    if (!eligible || !observed || !eligible.reconciliation ||
        !reconciliationContentEqual(eligible.reconciliation, observed)) {
      if (current.length > 0 || this.controller.queuedInputSnapshot().length > 0) {
        this.ambiguousInput = true;
        this.invalidate();
      }
      return undefined;
    }
    this.trackedOccurrences.splice(this.trackedOccurrences.indexOf(eligible), 1);
    const consumed = this.controller.consumeShadow(this.generation, eligible.shadow.id, this.controller.sessionId);
    if (!consumed) {
      this.ambiguousInput = true;
      this.invalidate();
    }
    return consumed;
  }

  private eligibleOccurrence<T extends { delivery: QueueDeliveryMode; pendingHostStart?: boolean }>(
    occurrences: readonly T[],
    delivery: QueueDeliveryMode | undefined,
  ): T | undefined {
    if (delivery !== undefined) {
      return occurrences.find((entry) => entry.pendingHostStart === true && entry.delivery === delivery) ??
        occurrences.find((entry) => entry.delivery === delivery);
    }
    const pending = occurrences.filter((entry) => entry.pendingHostStart === true);
    const eligible = pending.length > 0 ? pending : occurrences;
    return eligible.find((entry) => entry.delivery === "steer") ??
      eligible.find((entry) => entry.delivery === "followUp");
  }

  private trackShadow(shadow: QueuedInputShadow | undefined, expected: ExpectedInput): QueuedInputShadow | undefined {
    if (!shadow) return undefined;
    this.trackedOccurrences.push({
      ...expected,
      epoch: this.sessionEpoch,
      sessionId: shadow.sessionId,
      generation: shadow.generation,
      shadow,
      envelope: Object.freeze({
        sessionId: shadow.sessionId,
        generation: shadow.generation,
        id: shadow.id,
        delivery: shadow.delivery,
        nonce: {},
      }),
      pendingHostStart: false,
    });
    return shadow;
  }

  private captureToolObservationAuthority(): ToolObservationAuthority {
    return {
      controller: this.controller,
      epoch: this.sessionEpoch,
      logicalRun: this.logicalRunIdentity,
      batch: this.batch,
      generation: this.generation,
      handle: this.handle,
    };
  }

  private toolObservationAuthorityMatches(authority: ToolObservationAuthority): boolean {
    return authority.controller === this.controller && authority.epoch === this.sessionEpoch &&
      authority.logicalRun === this.logicalRunIdentity && authority.batch === this.batch &&
      authority.generation === this.generation && authority.handle === this.handle;
  }

  private successfulTool(id: string, result: Record<string, unknown>, ctx: MainGateContext | undefined): Record<string, unknown> {
    if (ctx) this.arm(ctx);
    const truncated = toolResultHasGuardClipping(result);
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
    if (this.logicalRunStop || this.generation !== undefined || !isProactiveCompactionApi(ctx.model?.api)) return;
    let usage: ContextUsageShape | undefined;
    try {
      usage = ctx.getContextUsage?.();
    } catch {
      usage = undefined;
    }
    this.armWithUsage(usage, "tool");
  }

  private armWithUsage(usage: ContextUsageShape | undefined, source: CheckpointSource): void {
    if (this.logicalRunStop || this.generation !== undefined) return;
    const generation = this.controller.sample(usage, source);
    if (generation === undefined) return;
    this.generation = generation;
    this.generationSource = source;
    for (const accepted of this.acceptedBeforeArm.splice(0)) {
      this.trackShadow(this.controller.shadowInput(generation, accepted.content, accepted.delivery), accepted);
    }
    if (source === "tool" || source === "assistant") {
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
    this.generationSource = undefined;
    this.handle = undefined;
    this.abortIssued = undefined;
    this.trackedOccurrences = [];
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

  private createController(sessionId: string): MidRunCompactionController {
    return new MidRunCompactionController({
      sessionId,
      threshold: this.threshold,
      compact: (signal) => this.execution
        ? this.execution.compact(signal)
        : Promise.resolve({ ok: false, category: "operational" }),
      resume: (context) => {
        const resume = this.execution?.resume;
        if (!resume) throw new Error("Checkpoint resume adapter is not attached");
        return resume(context);
      },
      cancelledInput: (handoff, context) => {
        const cancelledInput = this.execution?.cancelledInput;
        if (!cancelledInput) throw new Error("Cancelled-input adapter is not attached");
        return cancelledInput(handoff, context);
      },
      progress: (event) => this.execution?.progress?.(event),
      inputDropped: (rejected) => this.execution?.inputDropped?.(rejected),
      deadlinePolicy: this.deadlinePolicy,
    });
  }

  private async cancelCurrent(kind: CancellationKind): Promise<void> {
    const snapshot = this.controller.snapshot();
    if (this.controller.isProcessTerminal()) {
      throw new Error(`Checkpoint host quiescence is unconfirmed. ${UNCONFIRMED_HOST_RECOVERY_GUIDANCE}`);
    }
    if (snapshot.phase !== "idle") await this.controller.cancel(snapshot.generation, kind);
  }

  /**
   * Report what the outgoing controller still held. A cancellation drains and reports
   * its own queue, so this speaks only for the generations no cancellation reaches: an
   * exhausted one, whose queue is deliberately retained for `/compact` right up to the
   * moment the session it belongs to is replaced or left.
   */
  private releaseRetainedInput(): void {
    const retained = this.controller.releaseQueuedInput();
    if (retained.length === 0) return;
    try {
      this.execution?.inputDropped?.(retained);
    } catch {
      // Presentation cannot own session replacement.
    }
  }

  private resetStoppedLogicalRun(): void {
    const sessionId = this.controller.sessionId;
    this.releaseRetainedInput();
    this.controller = this.createController(sessionId);
    this.logicalRunStop = undefined;
    this.invalidateSessionState();
  }

  private invalidateSessionState(): void {
    this.logicalRunStop = undefined;
    this.settledStoppedResume = undefined;
    this.logicalRunIdentity = {};
    this.generation = undefined;
    this.generationSource = undefined;
    this.handle = undefined;
    this.batch = { run: {}, ids: [], final: new Map(), successful: new Map() };
    this.abortIssued = undefined;
    this.acceptedBeforeArm = [];
    this.trackedOccurrences = [];
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
  policy?: HostDeadlinePolicy,
): Promise<CompactionAttemptResult> {
  return new Promise((resolve) => {
    let settled = false;
    const token = { generation, token: {} };
    let timer: HostDeadlineTimer | undefined;
    const finish = (candidate: CompactionCallbackToken, result: CompactionAttemptResult): void => {
      if (settled || candidate !== token || candidate.generation !== generation) return;
      settled = true;
      timer?.clear();
      resolve(!result.ok && result.category === "unconfirmed-host"
        ? result
        : signal.aborted ? { ok: false, category: "cancelled" } : result);
    };
    timer = deadlineClock(policy).schedule(
      policy?.mainCallbackMs ?? MAIN_CALLBACK_COMPACTION_DEADLINE_MS,
      () => finish(token, { ok: false, category: "unconfirmed-host" }),
    );
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

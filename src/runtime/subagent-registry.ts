import { isAgentId } from "../util/subagent-transcripts.js";
import { normalizeAgentColor, type AgentColorName } from "./agent-color.js";
import type { RetainedInputReport } from "./retained-input-report.js";
import {
  assistantTextFingerprint,
  sanitizeLine,
  sanitizeProgressText,
  scalarSafeText,
  type ProgressSnapshot,
  type SubagentDetailEntry,
  type SubagentLiveActivity,
} from "./subagent-progress.js";

export { AGENT_COLOR_NAMES, normalizeAgentColor } from "./agent-color.js";
export type { AgentColorName } from "./agent-color.js";

/**
 * Dispatch registry: the in-memory source of truth for what a subagent ID or
 * name reaches — the ONLY thing `SendMessage` resolves against. Keyed by agent
 * ID; a name → ID index tracks the ORIGINAL binding so a name that was later
 * reused for a different live agent refuses cleanly (name integrity, Claude
 * Code 2.1.199). The registry is per-orchestrator-session and process-lifetime;
 * cross-restart resume is out of scope.
 *
 * SECURITY: resolution is pure in-memory Map lookups.
 * The transcript path used to reopen a session comes from the REGISTRY RECORD
 * (captured from the real persisted SessionManager's `getSessionFile()` at
 * dispatch time), NEVER string-assembled from the model-supplied `to`, and never
 * a fresh on-disk resolver scan. A hostile `to` (`..`, path separators, an
 * absolute path) is neither a minted agent ID nor a registered name → registry
 * miss → clean error, no filesystem access.
 */

/**
 * Minimal structural view of a live Pi AgentSession that a running dispatch can
 * be steered through. Defined here (not imported from subagents.ts) so this
 * module has no import cycle with the runtime that populates it.
 */
export interface CheckpointRecoveryResult {
  ok: boolean;
  outcome: SubagentOutcome;
  finalMessage: string;
  agentId: string;
  agentName?: string;
  truncated?: boolean;
  error?: string;
}

export type SubagentMessageSource = "send-message" | "panel";

export interface CheckpointStopAttemptIdentity {
  readonly attemptId: object;
  readonly agentId: string;
  readonly dispatchGeneration: number;
  readonly checkpointGeneration?: number;
  readonly checkpointOwner?: object;
  /** Session shutdown defers destructive cleanup until its one report-persistence attempt completes. */
  readonly deferCleanup?: true;
}

export type CheckpointStopTerminalEvidence =
  | {
      readonly confirmed: true;
      readonly attemptId: object;
      readonly kind?: "retained-report";
      readonly report: RetainedInputReport;
      /** Exact-attempt authority retained until shutdown's one persistence attempt completes. */
      readonly releaseCleanup?: (attemptId: object) => Promise<void>;
    }
  | {
      readonly confirmed: true;
      readonly attemptId: object;
      readonly kind: "ordinary-cleanup";
      readonly report?: never;
      readonly releaseCleanup?: never;
    };

export interface CheckpointStopDisposition {
  readonly disposition: "confirmed" | "ordinary-cleanup" | "unconfirmed";
  readonly report?: RetainedInputReport;
}

export interface ActiveCheckpointStopEligibility {
  readonly agentId: string;
  readonly dispatchGeneration: number;
  readonly checkpointGeneration: number;
  readonly owner: object;
}

export interface SteerableSession {
  /** Queue a mid-task course correction (delivered before the next LLM call). */
  steer?(text: string, metadata?: { source: SubagentMessageSource }): Promise<void> | void;
  /** Authenticated continuation of this exact retained checkpoint-paused session. */
  recoverCheckpoint?(text: string): Promise<CheckpointRecoveryResult>;
  /** Side-effect-free identity for the exact active committed-summary resumed stop owner. */
  checkpointStopEligibility?(): ActiveCheckpointStopEligibility | undefined;
  /** Stop and join this exact retained checkpoint-paused session. Void remains source-compatible but is not confirmation. */
  stopCheckpoint?(attempt?: CheckpointStopAttemptIdentity): Promise<CheckpointStopTerminalEvidence | void> | void;
  /**
   * Queue a follow-up processed after the agent finishes its current work.
   * Declared for the pi-contract pin; the runtime never calls it — steering
   * uses steer(), resume uses reopen().
   */
  followUp?(text: string): Promise<void> | void;
}

/**
 * Per-subagent usage, mirrored structurally from `DispatchUsage` in
 * `subagents.ts` so this module keeps no import coupling with the runtime.
 */
export interface SubagentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** Runtime-derived concurrency admission, orthogonal to the running/settled lifecycle. */
export type SubagentAdmission = "waiting" | "admitted";

/** Settled fate of a dispatch, recorded for the /usage report. */
export type SubagentOutcome = "completed" | "failed" | "aborted";

export class QuarantinedSubagentError extends Error {
  readonly code = "PICC_SUBAGENT_QUARANTINED";

  constructor(readonly agentId: string, hasReport: boolean) {
    const reportGuidance = hasReport
      ? " Recover represented retained input only from its canonical report; inspect the transcript for any unrepresentable input."
      : " No canonical retained-input report is available; inspect the transcript for retained input.";
    super(`Agent ${agentId} is quarantined for this process lifetime. The requested dispatch was not performed.${reportGuidance} Do not retry in this process. Exit PiCC completely, start a fresh process and session, then inspect the transcript, worktree, and possible files, tools, and external effects.`);
    this.name = "QuarantinedSubagentError";
  }
}

/**
 * Caps for stored conversation content, applied at capture. Both fields hold
 * model conversation text: they exist for the status panel's drill-down and
 * must NEVER be interpolated into error messages, thrown strings, or logging.
 */
export const SUBAGENT_PROMPT_CAP = 4096;
export const SUBAGENT_FINAL_TEXT_CAP = 16_384;
/** Single-line cap for the stored Agent-tool `description` label. */
const DESCRIPTION_CAP = 120;

/**
 * Multi-line conversation content sanitized (escape/control stripping, newlines
 * kept) and capped at capture. Blank-after-sanitize collapses to undefined so a
 * consumer's "is there content?" check stays a plain truthiness test.
 */
function boundedContent(text: string | undefined, cap: number): string | undefined {
  if (text === undefined) return undefined;
  const clean = scalarSafeText(sanitizeProgressText(text.slice(0, cap + 1)));
  if (!clean.trim()) return undefined;
  if (text.length <= cap && clean.length <= cap) return clean;
  let prefix = clean.slice(0, cap);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

/** Single-line description label sanitized and capped at capture. */
function boundedDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  return sanitizeLine(description, DESCRIPTION_CAP) || undefined;
}

export interface SubagentAgentProvenance {
  readonly kind: "builtin" | "authored";
  readonly sourcePath: string;
  readonly sourceScope: string;
  readonly pluginId?: string;
}

export interface SubagentRegistryRecord {
  /** Opaque, minted `agent-<12 hex>` identity — the primary key. */
  agentId: string;
  /** The resolved agent definition name (re-resolved on resume for construction). */
  agentName: string;
  /** Canonical authored/built-in source identity captured by the original dispatch. */
  agentProvenance?: SubagentAgentProvenance;
  /** Original nesting depth — a resume reuses it (subagents keep their depth). */
  depth: number;
  /** The cwd the dispatch ran in (worktree path when isolated) — reused on resume. */
  cwd: string;
  /** The worktree path, when the agent ran isolated — reachability is checked here. */
  worktreePath?: string;
  /** On-disk transcript path (from the persisted manager) — reopened on resume. */
  transcriptPath?: string;
  /** True when the agent can be continued (persisted transcript, not one-shot). */
  resumable: boolean;
  /** True for one-shot builtins (Explore/Plan) — never resumable, refuse steer too. */
  oneShot: boolean;
  /** Whether the dispatch is currently running (steerable) or has settled. */
  state: "running" | "settled";
  /** Registry-owned dispatch generation; incremented before every deliberate resume. */
  dispatchGeneration?: number;
  /** Runtime-derived concurrency admission; absent compatibility records are admitted. */
  admission?: SubagentAdmission;
  /**
   * Recorded at settlement so the /usage control command can report each
   * subagent's outcome. Undefined while running (or for a settle that could not
   * classify).
   */
  outcome?: SubagentOutcome;
  /**
   * Recorded at settlement from the dispatch's captured session stats.
   * Undefined when the session provided none (fake/older SDK, or a run that
   * died before any billable turn).
   */
  usage?: SubagentUsage;
  /** Live session handle while running (steering or checkpoint-recovery target). */
  session?: SteerableSession;
  /** The running record is retained solely at a settled checkpoint exhaustion boundary. */
  checkpointPaused?: boolean;
  /** Canonical process-lifetime custody report, retained after ordinary live cleanup. */
  retainedInputReport?: RetainedInputReport;
  /** Dispatch generation in which the canonical report was stored; stale retained reports never confirm a resumed stop. */
  retainedInputReportDispatchGeneration?: number;
  /** Exact generation whose non-deferred stop already completed destructive cleanup. */
  retainedInputCleanupReleasedDispatchGeneration?: number;
  /** Process-terminal checkpoint ambiguity; no later lifecycle mutation is authorized. */
  checkpointQuarantined?: boolean;
  /** Nonterminal ownership while an opted-in consumer joins checkpoint cancellation. */
  checkpointStopState?: "stopping" | "settling-cancellation" | "confirmed" | "unconfirmed";
  /** Presentation origin only; it never creates a second cancellation or steering owner. */
  checkpointStopSource?: "task-stop" | "panel" | "session";
  /**
   * Settled-notice readiness gate. A (re)dispatch re-arms this agent-level
   * gate, but the background-task registry's task-generation collection and
   * newest-generation checks can still suppress delivery; only an eligible
   * current uncollected run is noticed.
   */
  settledNoticeConsumed: boolean;
  /**
   * The DISPATCHING agent's id (the status panel's tree parent link). Set-once
   * at first register — never clobbered by an enrich/resume re-register.
   * Absent for a depth-1 dispatch (the coordinator has no agent id).
   */
  parentAgentId?: string;
  /**
   * The Agent tool's model-supplied `description` label, sanitized and capped
   * at capture; set-once. The panel's label column (fallback: `agentName`).
   */
  description?: string;
  /**
   * Epoch ms the CURRENT run started: set at first register, reset by
   * `markResuming` (a resumed agent's elapsed time restarts).
   */
  startedAt: number;
  /** Epoch ms of the last settlement (`markSettled`); cleared by `markResuming`. */
  settledAt?: number;
  /**
   * The initial dispatch prompt, sanitized and capped at capture; set-once
   * (a resume's follow-up message never replaces it). Conversation content —
   * never interpolate into error messages, thrown strings, or logging.
   */
  prompt?: string;
  /**
   * The final answer text (best-effort partial output on a failed run),
   * sanitized and capped in `markSettled`. Conversation content — same
   * never-into-errors/logging rule as `prompt`.
   */
  finalText?: string;
  /**
   * Agent frontmatter `color:`, validated at capture against Claude's fixed
   * color-name set (off-palette values are dropped, never stored raw); set-once.
   */
  color?: AgentColorName;
  /**
   * Latest bounded legacy progress snapshot mirrored from every dispatch.
   * `progress.usage` is the live accumulation; settlement-time `usage` wins.
   */
  progress?: ProgressSnapshot;
  /** Independent bounded live-panel payload; may include a display-only thinking handoff. */
  liveActivity?: SubagentLiveActivity;
  /**
   * Structured, typed live detail events for the selected-agent view. Entries
   * are display-only, sanitized and bounded by the condenser, then copied here
   * so the registry remains the panel's sole ownership boundary.
   */
  detailLog?: SubagentDetailEntry[];
  /**
   * USER-initiated stop marker: set only by `markUserStopped` (a panel stop
   * action), NEVER by a model `TaskStop`, and never cleared by `register()` or
   * `markResuming` — a user stop is permanent for this agent id (a fresh
   * dispatch of the same agent TYPE stays legal). Model-initiated `TaskStop`
   * deliberately stays resumable ("PiCC allows resume after TaskStop" — the
   * registry-documented divergence from Claude Code).
   */
  userStopped?: boolean;
}

/** Result of resolving a `to` address to a registry record. */
export type ResolveResult =
  | { ok: true; record: SubagentRegistryRecord }
  | { ok: false; error: string };

/** Fields a dispatch supplies when it registers (or re-registers) an agent. */
export interface RegisterInput {
  agentId: string;
  agentName: string;
  agentProvenance?: SubagentAgentProvenance;
  depth: number;
  cwd: string;
  worktreePath?: string;
  transcriptPath?: string;
  resumable: boolean;
  oneShot: boolean;
  session?: SteerableSession;
  checkpointPaused?: boolean;
  /** The dispatching agent's id; absent for a depth-1 dispatch. Set-once. */
  parentAgentId?: string;
  /** Model-supplied Agent-tool `description` (sanitized+capped here). Set-once. */
  description?: string;
  /** The initial dispatch prompt (sanitized+capped here). Set-once. */
  prompt?: string;
  /** Agent frontmatter `color:` (validated against the fixed set here). Set-once. */
  color?: string;
}

interface CheckpointStopFlight {
  readonly record: SubagentRegistryRecord;
  readonly dispatchGeneration: number;
  readonly session: SteerableSession;
  readonly attempt: CheckpointStopAttemptIdentity;
  readonly settlement: Promise<CheckpointStopDisposition>;
}

interface CheckpointCleanupAuthority {
  readonly record: SubagentRegistryRecord;
  readonly dispatchGeneration: number;
  readonly report: RetainedInputReport;
  readonly attemptId: object;
  readonly release: (attemptId: object) => Promise<void>;
  settlement?: Promise<void>;
}

export class SubagentRegistry {
  private readonly records = new Map<string, SubagentRegistryRecord>();
  private readonly checkpointStopFlights = new Map<string, CheckpointStopFlight>();
  private readonly checkpointCleanupAuthorities = new Map<string, CheckpointCleanupAuthority>();
  private readonly nameIndex = new Map<
    string,
    { firstId: string; currentId: string; rebound: boolean }
  >();
  private readonly changeListeners = new Set<() => void>();

  /**
   * Minimal change-notification seam for event-driven display consumers (the
   * status panel repaints on it and re-installs its widget on next activity).
   * `listener` fires synchronously after every record mutation — register,
   * noteProgress, markSettled, markResuming, markUserStopped — and never for a
   * no-op call (unknown id, user-stop veto). `consumeSettledNotice`'s gate
   * flip is deliberately silent: nothing rendered reads it. Returns an
   * idempotent unsubscribe. A throwing listener is swallowed — display-side
   * failures must never corrupt registry state or starve other listeners.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChange(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch {
        // display-side listener — never corrupt registry mutation
      }
    }
  }

  /** Refuse before a dispatch can create a session, transcript, or worktree for a quarantined identity. */
  assertDispatchAdmission(agentId: string): void {
    const record = this.records.get(agentId);
    if (record?.checkpointQuarantined) {
      throw new QuarantinedSubagentError(agentId, record.retainedInputReport !== undefined);
    }
  }

  /**
   * Register a dispatch at session-creation time, or UPDATE an existing record
   * on resume (same agent ID). New IDs also (re)bind the name index; a resume of
   * an already-known ID leaves the name binding untouched (it is the SAME agent,
   * not a name collision). Every call flips the record to `running`, re-attaches
   * the live session handle, and RE-ARMS the settled notice.
   */
  register(input: RegisterInput): SubagentRegistryRecord {
    this.assertDispatchAdmission(input.agentId);
    const existing = this.records.get(input.agentId);
    if (existing) {
      existing.agentName = input.agentName;
      existing.agentProvenance ??= input.agentProvenance === undefined
        ? undefined
        : Object.freeze({ ...input.agentProvenance });
      existing.depth = input.depth;
      existing.cwd = input.cwd;
      existing.worktreePath = input.worktreePath;
      existing.transcriptPath = input.transcriptPath;
      existing.resumable = input.resumable;
      existing.oneShot = input.oneShot;
      existing.session = input.session;
      existing.checkpointPaused = input.checkpointPaused;
      existing.state = "running";
      existing.settledNoticeConsumed = false;
      // Set-once panel fields: the enrich/resume re-register never clobbers a
      // value the first register captured (a resume's follow-up must not
      // replace the initial prompt). Resume-related RESETS (startedAt,
      // settledAt) live in markResuming, not here — the SendMessage resume
      // path already calls it. `userStopped` is deliberately untouched: a
      // user stop is permanent and register() never clears it.
      existing.parentAgentId ??= input.parentAgentId;
      existing.description ??= boundedDescription(input.description);
      existing.prompt ??= boundedContent(input.prompt, SUBAGENT_PROMPT_CAP);
      existing.color ??= normalizeAgentColor(input.color);
      this.notifyChange();
      return existing;
    }
    const record: SubagentRegistryRecord = {
      agentId: input.agentId,
      agentName: input.agentName,
      agentProvenance: input.agentProvenance === undefined
        ? undefined
        : Object.freeze({ ...input.agentProvenance }),
      depth: input.depth,
      cwd: input.cwd,
      worktreePath: input.worktreePath,
      transcriptPath: input.transcriptPath,
      resumable: input.resumable,
      oneShot: input.oneShot,
      state: "running",
      dispatchGeneration: 1,
      admission: "admitted",
      session: input.session,
      checkpointPaused: input.checkpointPaused,
      settledNoticeConsumed: false,
      parentAgentId: input.parentAgentId,
      description: boundedDescription(input.description),
      startedAt: Date.now(),
      prompt: boundedContent(input.prompt, SUBAGENT_PROMPT_CAP),
      color: normalizeAgentColor(input.color),
    };
    this.records.set(input.agentId, record);
    // Name → ID index with original-binding tracking. A name reused for a NEW
    // live agent marks the binding `rebound`, so a by-name SendMessage then
    // refuses (the ID always disambiguates). The check is inherently scoped to
    // this session — the registry is per-orchestrator-session.
    const bound = this.nameIndex.get(input.agentName);
    if (!bound) {
      this.nameIndex.set(input.agentName, {
        firstId: input.agentId,
        currentId: input.agentId,
        rebound: false,
      });
    } else {
      bound.currentId = input.agentId;
      bound.rebound = true;
    }
    this.notifyChange();
    return record;
  }

  /**
   * Mirror independently changed runtime projections onto a running record.
   * The condenser has already sanitized and bounded every value. The explicit
   * activity envelope distinguishes no update from clearing the current atom.
   * Unknown ids and settled records are ignored.
   */
  noteProgress(
    agentId: string,
    snapshot: ProgressSnapshot | undefined,
    detailLog?: SubagentDetailEntry[],
    liveActivityUpdate?: { value: SubagentLiveActivity | undefined },
  ): void {
    const record = this.records.get(agentId);
    if (!record || record.checkpointQuarantined || record.state !== "running") return;
    if (snapshot) {
      record.progress = {
        ...snapshot,
        tail: [...snapshot.tail],
        ...(snapshot.usage ? { usage: { ...snapshot.usage } } : {}),
      };
    }
    if (detailLog) record.detailLog = detailLog.map((entry) => ({ ...entry }));
    if (liveActivityUpdate) {
      record.liveActivity = liveActivityUpdate.value
        ? { ...liveActivityUpdate.value }
        : undefined;
    }
    this.notifyChange();
  }

  /** Mirror runtime concurrency admission without changing lifecycle state. */
  noteAdmission(agentId: string, admission: SubagentAdmission): void {
    const record = this.records.get(agentId);
    if (!record || record.checkpointQuarantined || record.state !== "running") return;
    record.admission = admission;
    this.notifyChange();
  }

  /** Mark a running record as the exact live checkpoint-paused recovery target. */
  markCheckpointPaused(agentId: string): void {
    const record = this.records.get(agentId);
    if (!record || record.checkpointQuarantined || record.state !== "running" || !record.session?.recoverCheckpoint) return;
    record.checkpointPaused = true;
    this.notifyChange();
  }

  /**
   * Mark a dispatch settled: drop the live session handle (it is disposed) and
   * flip the state, keeping name/ID/state/transcript-path + everything resume
   * needs. The agent-level notice gate stays unconsumed; the background-task
   * registry may still suppress a notice after terminal collection or
   * newest-generation supersession. `settled.outcome`/`settled.usage`/
   * `settled.finalText` are each stored only when provided, so a settle that
   * couldn't classify (or produced no text) leaves the prior value intact.
   * Before `finalText` is sanitized/capped, the identity-only source (defaulting
   * to that raw text) removes only an exactly matching trailing assistant detail
   * entry. The identity source is never stored. Conversation content is stored
   * for the panel drill-down only, never for error/log interpolation.
   */
  markSettled(
    agentId: string,
    settled?: {
      outcome?: SubagentOutcome;
      usage?: SubagentUsage;
      finalText?: string;
      assistantIdentityText?: string;
    },
  ): void {
    const record = this.records.get(agentId);
    if (!record || record.checkpointQuarantined) return;
    record.state = "settled";
    record.session = undefined;
    record.liveActivity = undefined;
    record.checkpointPaused = false;
    record.settledAt = Date.now();
    if (settled?.outcome !== undefined) record.outcome = settled.outcome;
    if (settled?.usage !== undefined) record.usage = settled.usage;
    const rawFinalText = settled?.finalText;
    const assistantIdentityText = settled?.assistantIdentityText ?? rawFinalText;
    const detailLog = record.detailLog;
    const trailingDetail = detailLog?.at(-1);
    if (
      assistantIdentityText !== undefined &&
      detailLog &&
      trailingDetail?.kind === "assistant" &&
      trailingDetail.fingerprint === assistantTextFingerprint([assistantIdentityText])
    ) {
      record.detailLog = detailLog.slice(0, -1);
    }
    const finalText = boundedContent(rawFinalText, SUBAGENT_FINAL_TEXT_CAP);
    if (finalText !== undefined) record.finalText = finalText;
    this.notifyChange();
  }

  /**
   * Flip a record to `running` and re-arm its settled notice at the instant a
   * resume is initiated — Claude Code 2.1.205 flips the status synchronously
   * (stale settled status was a fixed bug). The subsequent `register()` from the
   * resumed dispatch reconfirms this with the live session handle. Also the one
   * home of generation-local resets: elapsed time restarts and every prior
   * outcome, usage, progress/detail buffer, final text, and settlement time
   * clears before the resumed session can emit. No-op for unknown ids, and —
   * the permanence backstop behind the SendMessage refusal — for user-stopped
   * records.
   */
  markResuming(agentId: string): void {
    const record = this.records.get(agentId);
    if (!record || record.userStopped || record.checkpointQuarantined) return;
    record.state = "running";
    record.admission = "admitted";
    record.settledNoticeConsumed = false;
    record.startedAt = Date.now();
    record.finalText = undefined;
    record.outcome = undefined;
    record.usage = undefined;
    record.progress = undefined;
    record.detailLog = undefined;
    record.liveActivity = undefined;
    record.settledAt = undefined;
    record.dispatchGeneration = (record.dispatchGeneration ?? 1) + 1;
    record.checkpointStopState = undefined;
    record.checkpointStopSource = undefined;
    this.notifyChange();
  }

  /**
   * Record a USER-initiated stop (a panel action, never the model's TaskStop).
   * Permanent for this agent id: register()/markResuming never clear it, the
   * steer guard and the SendMessage resume path both refuse it — the model
   * cannot silently resume a user-stopped agent. The caller pairs this with
   * `BackgroundTaskRegistry.markUserStopped` for the task-side marker/abort.
   * No-op for unknown ids.
   */
  markUserStopped(agentId: string): void {
    const record = this.records.get(agentId);
    if (!record || record.checkpointQuarantined) return;
    record.userStopped = true;
    this.notifyChange();
  }

  private activeCheckpointStopEligibility(
    agentId: string,
  ): ActiveCheckpointStopEligibility | undefined {
    const record = this.records.get(agentId);
    if (!record || record.checkpointQuarantined || record.state !== "running") return undefined;
    let eligibility: ActiveCheckpointStopEligibility | undefined;
    try {
      eligibility = record.session?.checkpointStopEligibility?.();
    } catch {
      return undefined;
    }
    if (eligibility?.agentId !== agentId ||
        eligibility.dispatchGeneration !== (record.dispatchGeneration ?? 1) ||
        !Number.isSafeInteger(eligibility.checkpointGeneration) ||
        eligibility.owner === null || typeof eligibility.owner !== "object") return undefined;
    return eligibility;
  }

  /** Pure lookup of the exact active committed-summary resumed stop owner. */
  checkpointStopEligible(agentId: string, dispatchGeneration?: number): boolean {
    const eligibility = this.activeCheckpointStopEligibility(agentId);
    return eligibility !== undefined &&
      (dispatchGeneration === undefined || eligibility.dispatchGeneration === dispatchGeneration);
  }

  /** Canonical selector for checkpoint-paused or registry-owned stop work. */
  checkpointStopOwned(agentId: string, dispatchGeneration?: number): boolean {
    const record = this.records.get(agentId);
    if (!record || (dispatchGeneration !== undefined &&
        (record.dispatchGeneration ?? 1) !== dispatchGeneration)) return false;
    return record.checkpointPaused === true ||
      record.checkpointStopState === "stopping" ||
      record.checkpointStopState === "settling-cancellation" ||
      this.checkpointStopEligible(agentId, dispatchGeneration);
  }

  /** Publish provisional stop ownership without claiming a terminal outcome. */
  private markCheckpointStopping(
    agentId: string,
    source: "task-stop" | "panel" | "session",
    activeEligibility = false,
  ): boolean {
    const record = this.records.get(agentId);
    if (!record || record.checkpointQuarantined || record.state !== "running" ||
        (!record.checkpointPaused && !activeEligibility)) return false;
    if (record.checkpointStopState === "stopping" || record.checkpointStopState === "settling-cancellation") return true;
    record.checkpointStopState = "stopping";
    record.checkpointStopSource = source;
    this.notifyChange();
    return true;
  }

  /** Acquire or join the one physical stop for the exact active dispatch generation. */
  stopCheckpoint(
    agentId: string,
    source: "task-stop" | "panel" | "session",
  ): Promise<CheckpointStopDisposition> {
    const record = this.records.get(agentId);
    if (!record || record.checkpointQuarantined) {
      return Promise.resolve({ disposition: "unconfirmed", ...(record?.retainedInputReport ? { report: record.retainedInputReport } : {}) });
    }
    const generation = record.dispatchGeneration ?? 1;
    const existing = this.checkpointStopFlights.get(agentId);
    if (existing?.record === record && existing.dispatchGeneration === generation) return existing.settlement;
    const session = record.session;
    const callback = session?.stopCheckpoint;
    const activeEligibility = this.activeCheckpointStopEligibility(agentId);
    if (record.state !== "running" || (!record.checkpointPaused && !activeEligibility) || !session || !callback) {
      this.quarantineCheckpoint(agentId);
      return Promise.resolve({ disposition: "unconfirmed", ...(record.retainedInputReport ? { report: record.retainedInputReport } : {}) });
    }
    this.markCheckpointStopping(agentId, source, activeEligibility !== undefined);
    const attempt = Object.freeze({
      attemptId: Object.freeze({}), agentId, dispatchGeneration: generation,
      ...(activeEligibility ? {
        checkpointGeneration: activeEligibility.checkpointGeneration,
        checkpointOwner: activeEligibility.owner,
      } : {}),
      ...(source === "session" ? { deferCleanup: true as const } : {}),
    });
    let resolveSettlement!: (value: CheckpointStopDisposition) => void;
    const settlement = new Promise<CheckpointStopDisposition>((resolve) => { resolveSettlement = resolve; });
    const flight: CheckpointStopFlight = { record, dispatchGeneration: generation, session, attempt, settlement };
    this.checkpointStopFlights.set(agentId, flight);
    void Promise.resolve().then(() => callback.call(session, attempt)).then((evidence) => {
      const current = this.records.get(agentId);
      const stillCurrent = current === record && (current?.dispatchGeneration ?? 1) === generation &&
        this.checkpointStopFlights.get(agentId) === flight;
      if (!stillCurrent) {
        resolveSettlement({ disposition: "unconfirmed" });
        return;
      }
      const authenticated = evidence?.confirmed === true && evidence.attemptId === attempt.attemptId;
      if (authenticated && evidence.kind === "ordinary-cleanup") {
        if (current.retainedInputReport || current.checkpointQuarantined) {
          this.quarantineCheckpoint(agentId);
          resolveSettlement({ disposition: "unconfirmed", ...(current.retainedInputReport ? { report: current.retainedInputReport } : {}) });
          return;
        }
        current.retainedInputCleanupReleasedDispatchGeneration = generation;
        current.checkpointStopState = "confirmed";
        current.checkpointPaused = false;
        current.resumable = false;
        this.notifyChange();
        resolveSettlement({ disposition: "ordinary-cleanup" });
        return;
      }
      const report = authenticated ? evidence.report : undefined;
      if (!report || report.agentId !== agentId || current.retainedInputReport !== report ||
          current.retainedInputReportDispatchGeneration !== generation) {
        this.quarantineCheckpoint(agentId);
        resolveSettlement({ disposition: "unconfirmed", ...(current.retainedInputReport ? { report: current.retainedInputReport } : {}) });
        return;
      }
      if (attempt.deferCleanup) {
        if (typeof evidence?.releaseCleanup !== "function") {
          this.quarantineCheckpoint(agentId);
          resolveSettlement({ disposition: "unconfirmed", report });
          return;
        }
        this.checkpointCleanupAuthorities.set(agentId, {
          record, dispatchGeneration: generation, report, attemptId: attempt.attemptId,
          release: evidence.releaseCleanup,
        });
      } else {
        // The callback returns only after its exact-generation cleanup joins. Preserve
        // that authenticated fact so a later shutdown does not invent deferred authority.
        current.retainedInputCleanupReleasedDispatchGeneration = generation;
      }
      current.checkpointStopState = "confirmed";
      current.checkpointPaused = false;
      // This post-commit child is terminal; the ordinary model-TaskStop resume
      // divergence does not turn its canonical retained report into resume authority.
      current.resumable = false;
      this.notifyChange();
      resolveSettlement({ disposition: "confirmed", report });
    }, () => {
      const current = this.records.get(agentId);
      if (current === record && (current.dispatchGeneration ?? 1) === generation &&
          this.checkpointStopFlights.get(agentId) === flight) {
        this.quarantineCheckpoint(agentId);
        resolveSettlement({ disposition: "unconfirmed", ...(current.retainedInputReport ? { report: current.retainedInputReport } : {}) });
      } else {
        resolveSettlement({ disposition: "unconfirmed" });
      }
    });
    return settlement;
  }

  /** Release the exact confirmed shutdown cleanup, or verify that an ordinary stop already did. */
  releaseCheckpointCleanup(agentId: string, report: RetainedInputReport): Promise<void> {
    const authority = this.checkpointCleanupAuthorities.get(agentId);
    const current = this.records.get(agentId);
    const generation = current?.dispatchGeneration ?? 1;
    if (current?.retainedInputReport === report && !current.checkpointQuarantined &&
        current.retainedInputCleanupReleasedDispatchGeneration === generation) {
      return Promise.resolve();
    }
    if (!authority || authority.record !== current || authority.report !== report ||
        generation !== authority.dispatchGeneration || current.checkpointQuarantined) {
      return Promise.reject(new Error("checkpoint cleanup authority is stale or unavailable"));
    }
    authority.settlement ??= Promise.resolve().then(() => authority.release(authority.attemptId));
    return authority.settlement.then(() => {
      if (this.checkpointCleanupAuthorities.get(agentId) === authority) {
        this.checkpointCleanupAuthorities.delete(agentId);
      }
    });
  }

  /** Store one canonical report before its occurrences may resolve as reported. */
  storeRetainedInputReport(agentId: string, report: RetainedInputReport): boolean {
    const record = this.records.get(agentId);
    if (!record || report.agentId !== agentId || record.checkpointQuarantined) return false;
    if (record.retainedInputReport) return record.retainedInputReport === report;
    record.retainedInputReport = report;
    record.retainedInputReportDispatchGeneration = record.dispatchGeneration ?? 1;
    if (record.checkpointStopState === "stopping") {
      record.checkpointStopState = "settling-cancellation";
    }
    this.notifyChange();
    return true;
  }

  /** Latch process-terminal ambiguity before any cleanup or replacement can acquire authority. */
  quarantineCheckpoint(agentId: string): boolean {
    const record = this.records.get(agentId);
    if (!record || record.checkpointQuarantined) return false;
    record.checkpointQuarantined = true;
    record.checkpointPaused = true;
    record.checkpointStopState = "unconfirmed";
    record.resumable = false;
    this.notifyChange();
    return true;
  }

  get(agentId: string): SubagentRegistryRecord | undefined {
    return this.records.get(agentId);
  }

  ids(): string[] {
    return [...this.records.keys()];
  }

  /**
   * Every dispatch record in registration order — the /usage control command
   * iterates this to report each subagent's id, name, outcome, usage, and
   * transcript path, plus a session total.
   */
  list(): SubagentRegistryRecord[] {
    return [...this.records.values()];
  }

  /**
   * PEEK: is the agent-level readiness gate armed for this ID? Returns true iff
   * the record is settled and its gate is unconsumed, WITHOUT flipping it. The
   * background-task registry separately checks collection/current-generation
   * eligibility. A delivery throw keeps an otherwise eligible notice armed for
   * the next drain. Pure — no mutation.
   */
  isSettledNoticeArmed(agentId: string): boolean {
    const record = this.records.get(agentId);
    return !!record && record.state === "settled" && !record.settledNoticeConsumed;
  }

  /**
   * Agent-level hand-off: consume readiness once for the eligible current
   * settlement selected by the background-task registry. Returns true on the
   * first eligible hand-off after arming and false thereafter; terminal
   * collection/newest-generation filtering happens before this gate.
   */
  consumeSettledNotice(agentId: string): boolean {
    const record = this.records.get(agentId);
    if (!record || record.checkpointQuarantined || record.state !== "settled" || record.settledNoticeConsumed) return false;
    record.settledNoticeConsumed = true;
    return true;
  }

  /**
   * Resolve a model-supplied `to` (agent ID or name) to a registry record.
   * SECURITY: registry-only — pure Map lookups, never the filesystem.
   * Refuses unknown addresses and name collisions (name integrity)
   * with precise messages; an ID always disambiguates.
   */
  resolve(to: string): ResolveResult {
    const address = String(to ?? "").trim();
    if (!address) {
      return { ok: false, error: "SendMessage requires a `to` (agent id or name)." };
    }
    if (isAgentId(address)) {
      const record = this.records.get(address);
      if (record) return { ok: true, record };
      return { ok: false, error: this.unknownAddressError(address) };
    }
    // Treat as a name. A hostile string (path separators, `..`, absolute path)
    // is not a minted agent ID and will not be a registered name → miss below.
    const bound = this.nameIndex.get(address);
    if (!bound) {
      return { ok: false, error: this.unknownAddressError(address) };
    }
    if (bound.rebound) {
      return {
        ok: false,
        error:
          `The name ${JSON.stringify(address)} is ambiguous: it was reused for more than one ` +
          `agent this session and now reaches ${bound.currentId} (it first bound ${bound.firstId}). ` +
          `Address the exact agent by its id (e.g. ${bound.currentId}).`,
      };
    }
    const record = this.records.get(bound.currentId);
    if (record) return { ok: true, record };
    return { ok: false, error: this.unknownAddressError(address) };
  }

  private unknownAddressError(address: string): string {
    const ids = this.ids();
    const names = [...this.nameIndex.keys()];
    const known =
      ids.length || names.length
        ? `Known agents: ${[...new Set([...names, ...ids])].join(", ")}.`
        : "No subagents have been dispatched this session.";
    return `Unknown SendMessage address ${JSON.stringify(address)}. ${known}`;
  }
}

/** Verdict of {@link guardSteer}: the steer entry point, or the refusal to surface. */
export type SteerGuardResult =
  | { ok: true; steer: (text: string) => Promise<void> | void }
  | { ok: false; refusal: string };

/**
 * The one refusal message for a user-stopped agent — shared by the steer guard
 * and the SendMessage resume path so the two seams cannot drift.
 */
export function userStoppedRefusal(record: SubagentRegistryRecord): string {
  const report = record.retainedInputReport;
  const retained = report
    ? ` Reported input was not auto-replayed; retrieve the unchanged report with ${taskOutputAgentLocator(record.agentId)} and inspect possible existing effects before any deliberate new dispatch.`
    : "";
  return (
    `Agent ${record.agentId} ("${record.agentName}") was stopped by the user — ` +
    `a user-stopped agent cannot be steered or resumed.${retained} Dispatch a new agent instead.`
  );
}

/**
 * The one refusal message for a one-shot builtin — shared by the steer guard
 * and the SendMessage settled branch so the two seams cannot drift.
 */
export function oneShotRefusal(record: SubagentRegistryRecord): string {
  return (
    `Agent ${record.agentId} ("${record.agentName}") is a one-shot ${record.agentName} agent — ` +
    `one-shot built-ins (Explore/Plan) cannot be resumed or steered. Dispatch a new agent instead.`
  );
}

/**
 * The single steer guard: every surface that steers a running subagent (the
 * SendMessage tool, the panel drill-down) routes through this predicate bundle
 * so the refusal rules cannot drift per caller. On `ok` it hands back the
 * bound steer entry point, so a caller cannot pass the guard and then reach a
 * different session. Refusals, in order: one-shot builtins, user-stopped
 * agents (permanent), not-running records, capacity-waiting records, and
 * running records without a live steerable handle (the transient
 * minimal-register window, or a fake/older SDK session).
 */
export function taskOutputAgentLocator(agentId: string): string {
  return `TaskOutput with task_id "${agentId}"`;
}

export function retainedInputCount(report: RetainedInputReport): number {
  return Math.min(Number.MAX_SAFE_INTEGER, report.occurrences.length + report.unrepresentableCount);
}

/** One durable textual projection of the immutable canonical report. */
export function formatRetainedInputReport(report: RetainedInputReport): string {
  const locator = taskOutputAgentLocator(report.agentId);
  const lines = [
    `Retained input report for ${report.agentId}: ${report.occurrences.length} represented, ${report.unrepresentableCount} unrepresentable (${retainedInputCount(report)} total); stage ${report.stage}; ${retainedInputCount(report)} retained input occurrence(s).`,
    `Locator: ${locator}.`,
    "Reported input was not auto-replayed. Inspect possible existing files, tools, and external effects before any deliberate retry.",
    report.guidance,
  ];
  for (const [index, occurrence] of report.occurrences.entries()) {
    lines.push(`${index + 1}. ${occurrence.shadow.delivery}: ${JSON.stringify(occurrence.shadow.content)}`);
  }
  if (report.unrepresentableCount > 0) {
    lines.push(`${report.unrepresentableCount} retained occurrence(s) could not be represented safely; inspect the transcript before retrying.`);
  }
  return lines.filter(Boolean).join("\n");
}

export function guardSteer(
  record: SubagentRegistryRecord,
  source: SubagentMessageSource = "send-message",
): SteerGuardResult {
  if (record.checkpointQuarantined) {
    const locator = record.retainedInputReport
      ? ` Retrieve it with ${taskOutputAgentLocator(record.agentId)}.`
      : " No canonical retained-input report exists; inspect the transcript for retained input.";
    return {
      ok: false,
      refusal: `Agent ${record.agentId} is quarantined; the message was not sent.${locator} Do not retry in this process. Exit PiCC completely, start a fresh process and session, and inspect the transcript, worktree, and possible existing effects.`,
    };
  }
  if (record.checkpointStopState === "stopping" || record.checkpointStopState === "settling-cancellation") {
    return {
      ok: false,
      refusal: `Agent ${record.agentId} is settling cancellation; the message was not sent. If cancellation is confirmed, retrieve retained input with ${taskOutputAgentLocator(record.agentId)} and inspect possible existing effects before retrying.`,
    };
  }
  if (record.oneShot) {
    return { ok: false, refusal: oneShotRefusal(record) };
  }
  if (record.userStopped) {
    if (source === "panel" && record.retainedInputReport) {
      return {
        ok: false,
        refusal: `Agent ${record.agentId} was stopped by the user permanently; panel message was not sent. Reported input was not auto-replayed. ${taskOutputAgentLocator(record.agentId)}; inspect existing effects.`,
      };
    }
    return { ok: false, refusal: userStoppedRefusal(record) };
  }
  if (record.state !== "running") {
    return {
      ok: false,
      refusal:
        `Agent ${record.agentId} ("${record.agentName}") is not running — ` +
        `there is no live dispatch to steer.`,
    };
  }
  if (record.admission === "waiting") {
    const agentName = sanitizeLine(record.agentName, DESCRIPTION_CAP) || "subagent";
    return {
      ok: false,
      refusal:
        `Agent ${record.agentId} ("${agentName}") is waiting for configured concurrency capacity ` +
        `and cannot be steered before execution is admitted.`,
    };
  }
  const session = record.session;
  const steer = session?.steer;
  if (!session || typeof steer !== "function") {
    return {
      ok: false,
      refusal:
        `Agent ${record.agentId} ("${record.agentName}") is running but cannot be steered right now — ` +
        `only background dispatches are steerable (a foreground Agent call blocks the parent's turn).`,
    };
  }
  return {
    ok: true,
    steer: (text: string) => steer.call(session, text, { source }),
  };
}

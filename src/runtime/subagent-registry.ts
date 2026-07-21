import { isAgentId } from "../util/subagent-transcripts.js";
import {
  sanitizeLine,
  sanitizeProgressText,
  type ProgressSnapshot,
} from "./subagent-progress.js";

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

export interface SteerableSession {
  /** Queue a mid-task course correction (delivered before the next LLM call). */
  steer?(text: string): Promise<void> | void;
  /** Authenticated continuation of this exact retained checkpoint-paused session. */
  recoverCheckpoint?(text: string): Promise<CheckpointRecoveryResult>;
  /** Stop and join this exact retained checkpoint-paused session. */
  stopCheckpoint?(): Promise<void>;
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

/** Settled fate of a dispatch, recorded for the /usage report. */
export type SubagentOutcome = "completed" | "failed" | "aborted";

/**
 * Caps for stored conversation content, applied at capture. Both fields hold
 * model conversation text: they exist for the status panel's drill-down and
 * must NEVER be interpolated into error messages, thrown strings, or logging.
 */
const PROMPT_CAP = 4096;
const FINAL_TEXT_CAP = 16384;
/** Single-line cap for the stored Agent-tool `description` label. */
const DESCRIPTION_CAP = 120;

/**
 * Claude Code's fixed agent-frontmatter color-name set (the /agents picker
 * palette). Anything else is dropped at capture — hostile frontmatter must
 * never reach a renderer as a raw string. Exported as the whitelist the
 * render-side ANSI palette (`AGENT_COLOR_ANSI` in subagent-panel-render.ts)
 * is test-pinned against.
 */
export const AGENT_COLOR_NAMES: ReadonlySet<string> = new Set([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);

/** The validated (lowercased) color name, or undefined for anything off-palette. */
function validAgentColor(color: string | undefined): string | undefined {
  const normalized = color?.trim().toLowerCase();
  return normalized && AGENT_COLOR_NAMES.has(normalized) ? normalized : undefined;
}

/**
 * Multi-line conversation content sanitized (escape/control stripping, newlines
 * kept) and capped at capture. Blank-after-sanitize collapses to undefined so a
 * consumer's "is there content?" check stays a plain truthiness test.
 */
function boundedContent(text: string | undefined, cap: number): string | undefined {
  if (text === undefined) return undefined;
  const clean = sanitizeProgressText(text);
  if (!clean.trim()) return undefined;
  return clean.length > cap ? `${clean.slice(0, cap)}…` : clean;
}

/** Single-line description label sanitized and capped at capture. */
function boundedDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  return sanitizeLine(description, DESCRIPTION_CAP) || undefined;
}

export interface SubagentRegistryRecord {
  /** Opaque, minted `agent-<12 hex>` identity — the primary key. */
  agentId: string;
  /** The resolved agent definition name (re-resolved on resume for construction). */
  agentName: string;
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
  color?: string;
  /**
   * Latest bounded live-progress snapshot, mirrored via `noteProgress` from
   * EVERY dispatch's condenser subscription (foreground, background, nested,
   * resumed) — the status panel's single live data source. Sanitized by the
   * condenser at capture. `progress.usage` is the live accumulation; the
   * settlement-time `usage` above wins where both exist.
   */
  progress?: ProgressSnapshot;
  /**
   * Enlarged bounded transcript buffer for the panel's drill-down view,
   * updated beside `progress`. A PARALLEL field, deliberately not on the
   * snapshot, so it never rides `details.subagentProgress` emissions.
   * Sanitized and capped by the condenser at capture.
   */
  fullTail?: string[];
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

export class SubagentRegistry {
  private readonly records = new Map<string, SubagentRegistryRecord>();
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

  /**
   * Register a dispatch at session-creation time, or UPDATE an existing record
   * on resume (same agent ID). New IDs also (re)bind the name index; a resume of
   * an already-known ID leaves the name binding untouched (it is the SAME agent,
   * not a name collision). Every call flips the record to `running`, re-attaches
   * the live session handle, and RE-ARMS the settled notice.
   */
  register(input: RegisterInput): SubagentRegistryRecord {
    const existing = this.records.get(input.agentId);
    if (existing) {
      existing.agentName = input.agentName;
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
      existing.prompt ??= boundedContent(input.prompt, PROMPT_CAP);
      existing.color ??= validAgentColor(input.color);
      this.notifyChange();
      return existing;
    }
    const record: SubagentRegistryRecord = {
      agentId: input.agentId,
      agentName: input.agentName,
      depth: input.depth,
      cwd: input.cwd,
      worktreePath: input.worktreePath,
      transcriptPath: input.transcriptPath,
      resumable: input.resumable,
      oneShot: input.oneShot,
      state: "running",
      session: input.session,
      checkpointPaused: input.checkpointPaused,
      settledNoticeConsumed: false,
      parentAgentId: input.parentAgentId,
      description: boundedDescription(input.description),
      startedAt: Date.now(),
      prompt: boundedContent(input.prompt, PROMPT_CAP),
      color: validAgentColor(input.color),
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
   * Mirror the latest live-progress snapshot (and drill-down `fullTail`) of a
   * RUNNING dispatch onto its record. The condenser is the sanitizer/bounder —
   * both arguments arrive sanitized and capped at capture. Ignored for
   * unknown ids and settled records (a settled record's finalText/usage stay
   * authoritative; dispatch unsubscribes its condenser before settling, so
   * the guard only catches stale callers).
   */
  noteProgress(agentId: string, snapshot: ProgressSnapshot, fullTail?: string[]): void {
    const record = this.records.get(agentId);
    if (!record || record.state !== "running") return;
    record.progress = snapshot;
    if (fullTail) record.fullTail = fullTail;
    this.notifyChange();
  }

  /** Mark a running record as the exact live checkpoint-paused recovery target. */
  markCheckpointPaused(agentId: string): void {
    const record = this.records.get(agentId);
    if (!record || record.state !== "running" || !record.session?.recoverCheckpoint) return;
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
   * `finalText` is sanitized and capped here — conversation content, stored
   * for the panel drill-down only, never for error/log interpolation.
   */
  markSettled(
    agentId: string,
    settled?: { outcome?: SubagentOutcome; usage?: SubagentUsage; finalText?: string },
  ): void {
    const record = this.records.get(agentId);
    if (!record) return;
    record.state = "settled";
    record.session = undefined;
    record.checkpointPaused = false;
    record.settledAt = Date.now();
    if (settled?.outcome !== undefined) record.outcome = settled.outcome;
    if (settled?.usage !== undefined) record.usage = settled.usage;
    const finalText = boundedContent(settled?.finalText, FINAL_TEXT_CAP);
    if (finalText !== undefined) record.finalText = finalText;
    this.notifyChange();
  }

  /**
   * Flip a record to `running` and re-arm its settled notice at the instant a
   * resume is initiated — Claude Code 2.1.205 flips the status synchronously
   * (stale settled status was a fixed bug). The subsequent `register()` from the
   * resumed dispatch reconfirms this with the live session handle. Also the one
   * home of the resume-related RESETS: `startedAt` restarts (a resumed agent's
   * elapsed time restarts) and `settledAt` clears. No-op for unknown ids, and —
   * the permanence backstop behind the SendMessage refusal — for user-stopped
   * records.
   */
  markResuming(agentId: string): void {
    const record = this.records.get(agentId);
    if (!record || record.userStopped) return;
    record.state = "running";
    record.settledNoticeConsumed = false;
    record.startedAt = Date.now();
    record.settledAt = undefined;
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
    if (!record) return;
    record.userStopped = true;
    this.notifyChange();
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
    if (!record || record.state !== "settled" || record.settledNoticeConsumed) return false;
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
  return (
    `Agent ${record.agentId} ("${record.agentName}") was stopped by the user — ` +
    `a user-stopped agent cannot be steered or resumed. Dispatch a new agent instead.`
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
 * agents (permanent), not-running records, and running records without a live
 * steerable handle (the transient minimal-register window, or a fake/older
 * SDK session).
 */
export function guardSteer(record: SubagentRegistryRecord): SteerGuardResult {
  if (record.oneShot) {
    return { ok: false, refusal: oneShotRefusal(record) };
  }
  if (record.userStopped) {
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
  return { ok: true, steer: steer.bind(session) };
}

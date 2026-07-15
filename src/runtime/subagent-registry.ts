import { isAgentId } from "../util/subagent-transcripts.js";

/**
 * Dispatch registry (t04): the in-memory source of truth for what a subagent ID
 * or name reaches — the ONLY thing `SendMessage` resolves against. Keyed by
 * agent ID; a name → ID index tracks the ORIGINAL binding so a name that was
 * later reused for a different live agent refuses cleanly (name integrity,
 * Claude Code 2.1.199). The registry is per-orchestrator-session and
 * process-lifetime (cross-restart resume is out of scope — t07 records that).
 *
 * SECURITY (plan-review MUST-FIX #2): resolution is pure in-memory Map lookups.
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
export interface SteerableSession {
  /** Queue a mid-task course correction (delivered before the next LLM call). */
  steer?(text: string): Promise<void> | void;
  /**
   * Queue a follow-up processed after the agent finishes its current work.
   * Declared for the pi-contract pin; the runtime never calls it — steering
   * uses steer(), resume uses reopen().
   */
  followUp?(text: string): Promise<void> | void;
}

/**
 * Per-subagent usage (t06), mirrored structurally from `DispatchUsage`
 * (subagents.ts) so this module keeps no import coupling with the runtime.
 */
export interface SubagentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** Settled fate of a dispatch (t01 vocabulary), recorded for the /usage report. */
export type SubagentOutcome = "completed" | "failed" | "aborted";

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
   * Settled fate (t06): completed / failed / aborted, recorded at settlement so
   * the /usage control command can report each subagent's outcome. Undefined
   * while running (or for a settle that could not classify).
   */
  outcome?: SubagentOutcome;
  /**
   * Per-subagent token/cost usage (t06), recorded at settlement from the
   * dispatch's captured session stats. Undefined when the session provided none
   * (fake/older SDK, or a run that died before any billable turn).
   */
  usage?: SubagentUsage;
  /** Live session handle while running (steering target); dropped on settlement. */
  session?: SteerableSession;
  /**
   * t05 settled-notice readiness gate. A (re)dispatch re-arms the agent-level
   * gate, but F21 task-generation collection and newest-generation checks can
   * suppress delivery; only an eligible current uncollected run is noticed.
   */
  settledNoticeConsumed: boolean;
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
}

export class SubagentRegistry {
  private readonly records = new Map<string, SubagentRegistryRecord>();
  private readonly nameIndex = new Map<
    string,
    { firstId: string; currentId: string; rebound: boolean }
  >();

  /**
   * Register a dispatch at session-creation time, or UPDATE an existing record
   * on resume (same agent ID). New IDs also (re)bind the name index; a resume of
   * an already-known ID leaves the name binding untouched (it is the SAME agent,
   * not a name collision). Every call flips the record to `running`, re-attaches
   * the live session handle, and RE-ARMS the settled notice (t05).
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
      existing.state = "running";
      existing.settledNoticeConsumed = false;
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
      settledNoticeConsumed: false,
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
    return record;
  }

  /**
   * Mark a dispatch settled: drop the live session handle (it is disposed) and
   * flip the state, keeping name/ID/state/transcript-path + everything resume
   * needs. The agent-level notice gate stays unconsumed; F21 may still suppress
   * a notice after terminal collection or newest-generation supersession.
   * `settled.outcome`/`settled.usage` (t06) record the run's fate and per-
   * subagent usage for the /usage control command; each is stored only when
   * provided, so a settle that couldn't classify leaves the prior value intact.
   */
  markSettled(
    agentId: string,
    settled?: { outcome?: SubagentOutcome; usage?: SubagentUsage },
  ): void {
    const record = this.records.get(agentId);
    if (!record) return;
    record.state = "settled";
    record.session = undefined;
    if (settled?.outcome !== undefined) record.outcome = settled.outcome;
    if (settled?.usage !== undefined) record.usage = settled.usage;
  }

  /**
   * Flip a record to `running` and re-arm its settled notice at the instant a
   * resume is initiated — Claude Code 2.1.205 flips the status synchronously
   * (stale settled status was a fixed bug). The subsequent `register()` from the
   * resumed dispatch reconfirms this with the live session handle. No-op for
   * unknown ids.
   */
  markResuming(agentId: string): void {
    const record = this.records.get(agentId);
    if (!record) return;
    record.state = "running";
    record.settledNoticeConsumed = false;
  }

  get(agentId: string): SubagentRegistryRecord | undefined {
    return this.records.get(agentId);
  }

  ids(): string[] {
    return [...this.records.keys()];
  }

  /**
   * Every dispatch record in registration order (t06): the /usage control
   * command iterates this to report each subagent's id, name, outcome, usage,
   * and transcript path, plus a session total.
   */
  list(): SubagentRegistryRecord[] {
    return [...this.records.values()];
  }

  /**
   * t05 PEEK (FIX 1): is the agent-level readiness gate armed for this ID?
   * Returns true iff the record is settled and its gate is unconsumed, WITHOUT
   * flipping it. The task registry separately checks F21 collection/current-
   * generation eligibility. A delivery throw keeps an otherwise eligible notice
   * armed for the next drain. Pure — no mutation.
   */
  isSettledNoticeArmed(agentId: string): boolean {
    const record = this.records.get(agentId);
    return !!record && record.state === "settled" && !record.settledNoticeConsumed;
  }

  /**
   * t05 agent-level hand-off: consume readiness once for the eligible current
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
   * SECURITY (MUST-FIX #2): registry-only — pure Map lookups, never the
   * filesystem. Refuses unknown addresses and name collisions (name integrity)
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

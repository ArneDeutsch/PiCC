import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type {
  ClaudeAgent,
  Diagnostic,
  HookConfig,
  HookOutcome,
  HookPayload,
  ToolCallDescriptor,
} from "../types.js";
import type { HookRunner } from "../engine/hook-runner.js";
import { PermissionEngine } from "../engine/permissions.js";
import { builtinAgents, resolveAgent } from "../claude/agents.js";
import { parseHookConfig } from "../claude/hooks.js";
import { claudeToolsToPiBuiltins } from "./tool-map.js";
import { createGuardExtension } from "./guard.js";
import { CwdState } from "./cwd-state.js";
import { findByName } from "../project.js";
import type { BackgroundTaskRegistry, UsageLike } from "./background-tasks.js";
import type {
  SteerableSession,
  SubagentRegistry,
  SubagentUsage,
} from "./subagent-registry.js";
import { guardSteer, oneShotRefusal, userStoppedRefusal } from "./subagent-registry.js";
import {
  agentTrailerFrame,
  agentTrailerLine,
  FORK_DEGRADE_PREFIX,
  isAgentId,
  mintAgentId,
  subagentSessionDir,
} from "../util/subagent-transcripts.js";
import {
  renderProgressText,
  sanitizeLine,
  SubagentProgressCondenser,
  type ProgressSnapshot,
} from "./subagent-progress.js";
import { renderAgentCall, renderAgentResult } from "./subagent-render.js";
import { formatBackgroundTaskIdentity } from "./background-identity.js";

/**
 * Subagent dispatch runtime: spawns fresh-context Pi sessions per dispatch,
 * parallel fan-out under a concurrency cap, per-agent tools:/model/effort, configurable
 * nesting depth, optional worktree isolation, and VERBATIM final-message return
 * (skills parse the final message — often locked YAML — directly; hard contract).
 */

/** Structural interface for the WorktreeManager (avoids import-order coupling). */
export interface WorktreeManagerLike {
  enter(opts: { name?: string; path?: string }): Promise<{
    ok: boolean;
    worktreePath?: string;
    branch?: string;
    error?: string;
    diagnostics: Diagnostic[];
  }>;
  exit(opts: { worktreePath: string; action: "keep" | "remove" }): Promise<unknown>;
}

export interface SubagentRuntimeDeps {
  getAgents: () => ClaudeAgent[];
  /** Assemble the subagent's system prompt: agent body + CLAUDE.md/rules hierarchy + env. */
  buildSystemPrompt: (agent: ClaudeAgent, depth?: number) => string;
  /**
   * Claude-named custom tool definitions granted to an agent (WebFetch, Task*, ...).
   * `ownerAgentId` is the DISPATCHER's own agent id (this dispatch's minted id,
   * the `agentId` minted in `dispatch`) — it scopes the agent's TaskOutput/TaskStop to the tasks this
   * dispatch started AND tags the tasks it starts, so the two line up.
   * `subCwd` is the dispatch-local cwd state — tools must resolve against it, not
   * the orchestrator's cwd, or worktree-isolated agents search the wrong checkout.
   * (`ownerAgentId` is inserted BEFORE the optional `subCwd` because a required
   * parameter cannot follow an optional one.)
   * `dispatcherIsFork` is the runtime-set marker: true iff THIS dispatch
   * is a genuinely-inheriting fork, so the Agent/Task tools it grants know their
   * dispatcher was a fork and can refuse a fork-spawns-fork. Never derived from a
   * tool parameter (same anti-spoofing discipline as `ownerAgentId`); called
   * per-dispatch, so it scopes to THIS fork's tools and does not leak to the fork's
   * normal (non-fork) grandchildren.
   */
  customToolsFor: (
    agent: ClaudeAgent,
    grantedClaudeNames: string[],
    depth: number,
    ownerAgentId: string,
    dispatcherIsFork: boolean,
    subCwd?: CwdState,
  ) => unknown[];
  /** All Claude tool names the harness knows (for gateTools' allKnown). */
  allKnownToolNames: () => string[];
  permissionEngine: PermissionEngine;
  hookRunner: HookRunner;
  getCwd: () => string;
  /**
   * Preferred: builds a PER-DISPATCH context injector with its own fresh injection
   * state. Sharing the parent's injector would let a subagent's file touches consume
   * the orchestrator's one-shot nested-CLAUDE.md/path-rule injections (and vice versa).
   */
  makeContextInjector?: (getCwd: () => string) => (filePath: string) => string | undefined;
  /** Legacy shared injector — used only when makeContextInjector is absent. */
  contextForTouchedFile?: (filePath: string) => string | undefined;
  /** Resolve "provider/model" (or undefined) to a Pi Model object, or undefined to inherit. */
  resolveModel: (spec: string | undefined) => unknown | undefined;
  mapEffort: (effort: string | undefined) => string | undefined;
  /**
   * Builds a per-dispatch HookRunner for an agent's frontmatter `hooks:` —
   * same deps as the session's main runner. The scoped runner fires only for
   * that subagent's dispatch and is discarded when it ends.
   * Its `transcript_path` stays the MAIN session transcript (Claude Code
   * parity): PiCC does NOT re-point subagent hook events at the subagent's
   * own transcript.
   */
  makeScopedHookRunner?: (config: HookConfig) => HookRunner;
  /**
   * MAIN session transcript file (late-bound; undefined in print/no-session
   * modes and tests). Subagent transcripts persist in a sibling directory
   * derived from it; without it, dispatch degrades to in-memory.
   */
  getMainSessionFile?: () => string | undefined;
  worktrees?: WorktreeManagerLike;
  maxDepth: number;
  concurrency: number;
  sessionId: string;
  /**
   * Dispatch registry: every session-creating dispatch registers here so
   * SendMessage can resolve an agent ID/name to its live session (steer) or its
   * persisted transcript (resume). Optional — when absent, dispatch runs
   * unchanged and SendMessage is simply not wired (print/test paths).
   */
  subagentRegistry?: SubagentRegistry;
  /** Injected for testability; defaults to the real Pi SDK. */
  sdk?: PiSdk;
  log?: (message: string) => void;
}

/** Structural view of a Pi SessionManager (only what dispatch reads). */
export interface PiSessionManagerLike {
  getSessionFile(): string | undefined;
}

/**
 * Per-subagent token/cost usage. Numbers only, and each field is OMITTED
 * when Pi doesn't measure it rather than invented as a zero. Mirrored
 * structurally on `BackgroundResultLike`/`BackgroundTaskRecord` (background-
 * tasks.ts) and the dispatch registry record (subagent-registry.ts).
 */
export interface DispatchUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/**
 * Drift guard: `DispatchUsage` (here), `UsageLike` (background-tasks),
 * and `SubagentUsage` (subagent-registry) are byte-identical by intent but kept
 * in three files to preserve those modules' no-value-import relationship. This
 * compile-time assertion breaks `tsc` the moment any of the three gains, loses,
 * or retypes a field without the others — key drift is caught by the mutual
 * `keyof` containment, field-type drift by the mutual assignability. Type-only
 * (the imports above are `import type`, erased at runtime — no cycle).
 */
type _SameShape<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? A extends B
      ? B extends A
        ? true
        : never
      : never
    : never
  : never;
type _UsageDriftGuard = _SameShape<DispatchUsage, UsageLike> &
  _SameShape<DispatchUsage, SubagentUsage>;
const _usageDriftOk: _UsageDriftGuard = true;
void _usageDriftOk;

/**
 * Structural view of Pi's `AgentSession.getSessionStats()` return
 * (`SessionStats`): the subset the usage accounting reads. Pi aggregates over ALL session
 * entries (incl. compacted-away history), so these totals reflect what was
 * actually billed for the subagent's whole run.
 */
export interface PiSessionStats {
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
}

/** Map Pi's SessionStats to the usage shape, omitting fields Pi didn't report. */
export function usageFromStats(stats: PiSessionStats | undefined): DispatchUsage | undefined {
  if (!stats || typeof stats !== "object") return undefined;
  const usage: DispatchUsage = {};
  const tokens = stats.tokens;
  if (tokens && typeof tokens === "object") {
    if (typeof tokens.input === "number") usage.inputTokens = tokens.input;
    if (typeof tokens.output === "number") usage.outputTokens = tokens.output;
    if (typeof tokens.cacheRead === "number") usage.cacheReadTokens = tokens.cacheRead;
    if (typeof tokens.cacheWrite === "number") usage.cacheWriteTokens = tokens.cacheWrite;
  }
  if (typeof stats.cost === "number") usage.costUsd = stats.cost;
  return Object.keys(usage).length ? usage : undefined;
}

export interface PiSdk {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSession }>;
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> };
  inMemorySessionManager(cwd: string): unknown;
  /**
   * Persisted session manager in a custom directory with a pinned session id
   * (subagent transcripts — Pi names the file `<stamp>_<id>.jsonl`).
   * Optional: when absent, dispatch degrades to in-memory (non-resumable).
   */
  persistedSessionManager?(cwd: string, sessionDir: string, id: string): PiSessionManagerLike;
  /**
   * Reopen a persisted subagent transcript for a SendMessage resume —
   * `SessionManager.open(path, sessionDir?, cwdOverride?)`. Restores the prior
   * messages and appends the resumed run to the SAME file. Optional: when
   * absent, resume fails loudly rather than losing context.
   */
  reopenSessionManager?(
    transcriptPath: string,
    sessionDir: string,
    cwd: string,
  ): PiSessionManagerLike;
  /**
   * Fork a persisted subagent transcript FROM a source session's full history
   * (`subagent_type: "fork"`). Wraps `SessionManager.forkFrom`, which reads
   * the source transcript FILE and writes a BRAND-NEW file, so the parent
   * transcript is never touched (NEVER reopen it in place — that would append the
   * fork's steps onto the parent's on-disk history). Optional: when absent (older/
   * fake SDKs), a `"fork"` dispatch cannot inherit → visible degrade to fresh
   * context.
   */
  forkSessionManager?(
    sourcePath: string,
    cwd: string,
    sessionDir: string,
    id: string,
  ): PiSessionManagerLike;
  inMemorySettingsManager(): unknown;
  agentDir(): string;
}

/**
 * Structural view of a Pi session message. Real assistant messages carry a
 * required `stopReason` (pi-ai `AssistantMessage`) and an `errorMessage` when
 * the run ended on a terminal LLM failure — optional here so simple fakes and
 * non-assistant roles stay assignable.
 */
export interface PiSessionMessage {
  role: string;
  content: unknown;
  stopReason?: string;
  errorMessage?: string;
}

interface PiSession {
  prompt(text: string): Promise<void>;
  messages: PiSessionMessage[];
  dispose(): void;
  setThinkingLevel?(level: string): void;
  /** Cooperative abort (real Pi sessions expose it; TaskStop uses it best-effort). */
  abort?(): Promise<void> | void;
  /**
   * Live event stream (real Pi `AgentSession.subscribe`; live progress).
   * Optional so simple test fakes can omit it — dispatch degrades to no live
   * progress when absent, never crashing. Returns an unsubscribe function.
   */
  subscribe?(listener: (event: unknown) => void): () => void;
  /**
   * Mid-task course correction for a RUNNING dispatch (SendMessage steer).
   * Real Pi `AgentSession.steer` queues the message, delivered after the current
   * assistant turn's tool calls, before the next LLM call. Optional so fakes/
   * older SDKs degrade cleanly — steering a session without it refuses.
   */
  steer?(text: string): Promise<void> | void;
  /**
   * Queue a follow-up processed after the agent finishes (real Pi followUp).
   * Declared for the pi-contract pin (kept in sync with Pi's SteerableSession);
   * the runtime never calls it — steering uses steer(), resume uses reopen().
   */
  followUp?(text: string): Promise<void> | void;
  /**
   * Aggregate token/cost stats for the whole session (real Pi
   * `AgentSession.getSessionStats`; usage accounting). Optional so simple
   * fakes/older SDKs omit it — dispatch then reports no usage, never crashing.
   */
  getSessionStats?(): PiSessionStats;
}

/** Classified fate of a dispatch. Mirrored by `BackgroundResultLike`. */
export type DispatchOutcome = "completed" | "failed" | "aborted";

export interface DispatchResult {
  /** True iff `outcome === "completed"`. */
  ok: boolean;
  /** Every exit path classifies: completed, failed (terminal error), or aborted (deliberate stop). */
  outcome: DispatchOutcome;
  /**
   * The subagent's final assistant message, verbatim. On a failed run this is
   * the best-effort partial output produced before the failure (post-compaction
   * content — compaction inside prompt() may have rewritten earlier turns), or "".
   */
  finalMessage: string;
  /**
   * Opaque dispatch identity: unique per agent, stable across resumes — a
   * resume reuses the ID and appends to the same transcript.
   */
  agentId: string;
  /** On-disk JSONL transcript of the subagent's session, when persisted. */
  transcriptPath?: string;
  /**
   * True when this agent can be continued under `agentId` (persisted
   * transcript; not a one-shot builtin like Explore/Plan; not the in-memory
   * fallback). SendMessage refuses non-resumable IDs cleanly.
   */
  resumable: boolean;
  /**
   * True when `finalMessage` was cut at the model's output token limit (stop
   * reason "length") and already carries the cut-off frame. The model-visible
   * trailer then rides INSIDE that existing frame instead of opening a second one.
   */
  truncated?: boolean;
  /**
   * True ONLY when this dispatch was a `subagent_type: "fork"` that ACTUALLY
   * inherited the parent conversation. A degraded fork (gate off, no
   * transcript, nested dispatcher, SDK cannot fork, forkFrom threw) is a plain
   * fresh general-purpose run and reports `isFork` falsey. Metadata only.
   */
  isFork?: boolean;
  agentName?: string;
  worktreePath?: string;
  /**
   * Per-subagent token/cost usage, captured from the session's
   * `getSessionStats()` after the last `prompt()`. Present when the session
   * provided stats — including failed/aborted runs (their PARTIAL usage answers
   * "what did the failure cost me"). Metadata only: NEVER mixed into
   * `finalMessage` (the verbatim-return contract is untouched).
   */
  usage?: DispatchUsage;
  /** The single error channel: present iff `outcome !== "completed"`, names the cause. */
  error?: string;
  diagnostics: Diagnostic[];
}

async function loadRealSdk(): Promise<PiSdk> {
  const mod = await import("@earendil-works/pi-coding-agent");
  const { resolveGitBashPath } = await import("../engine/shell-inject.js");
  const m = mod as unknown as Record<string, any>;
  const shellPath = resolveGitBashPath();
  return {
    createAgentSession: (options) => m.createAgentSession(options),
    DefaultResourceLoader: m.DefaultResourceLoader,
    inMemorySessionManager: (cwd: string) => m.SessionManager.inMemory(cwd),
    // Persisted subagent transcript: Pi validates the id and names the
    // file `<stamp>_<id>.jsonl` in the custom directory (created on demand).
    persistedSessionManager: (cwd: string, sessionDir: string, id: string) =>
      m.SessionManager.create(cwd, sessionDir, { id }),
    // Resume: reopen the SAME transcript file to restore prior context and
    // append the resumed run — `open(path, sessionDir, cwdOverride)`.
    reopenSessionManager: (transcriptPath: string, sessionDir: string, cwd: string) =>
      m.SessionManager.open(transcriptPath, sessionDir, cwd),
    // Fork: seed a NEW subagent transcript with the parent (main-session)
    // conversation. `forkFrom(sourcePath, targetCwd, sessionDir, { id })` reads the
    // source file and writes a brand-new file — the parent transcript is untouched.
    forkSessionManager: (sourcePath: string, cwd: string, sessionDir: string, id: string) =>
      m.SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id }),
    // shellPath pins subagent bash to Git Bash on Windows (see resolveGitBashPath).
    inMemorySettingsManager: () =>
      m.SettingsManager.inMemory({
        compaction: { enabled: true },
        ...(shellPath ? { shellPath } : {}),
      }),
    agentDir: () => m.getAgentDir(),
  };
}

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }
  private release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/**
 * The reserved `subagent_type` that inherits the parent conversation.
 * A project agent literally named `fork` never shadows it — the interception wins.
 */
const FORK_SUBAGENT_TYPE = "fork";

/**
 * Single-line cap for model-supplied identity/label strings (subagent_type,
 * description, agent name) sanitized at capture, on top of the render-time
 * defense that stays in place.
 */
const CAPTURED_LINE_CAP = 120;

/**
 * Synthetic agent for an inheriting fork. `tools: undefined` ⇒ all-tools
 * (the main-session grant, since forks are main-session-only), `isolation:
 * undefined` ⇒ shares the parent cwd. Its neutral persona + the normal
 * buildSystemPrompt path reconstruct the parent's project context (CLAUDE.md/
 * rules/skills/memory/steering) — NOT an agent persona. Assigned to the local
 * `resolved`/`agent`; `opts.agentOverride` stays undefined (so `overrideDispatch`
 * is false and the fork isn't mistaken for a skill override).
 */
function buildForkAgent(): ClaudeAgent {
  return {
    name: FORK_SUBAGENT_TYPE,
    description: "Forked continuation inheriting the parent (main-session) conversation",
    body: "You are a forked continuation of the main session. You have inherited the full conversation so far as your working context — continue the task using that shared history, and reply with your final result. (The caller sees only your final message.)",
    tools: undefined,
    disallowedTools: undefined,
    isolation: undefined,
    metadata: {},
    source: { path: "<fork>", scope: "builtin" },
    unknownKeys: [],
    diagnostics: [],
  };
}

/** Truthy env-flag semantics: set and not an explicit "off" value. */
function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** Merge hook outcomes: any block wins (first reason), context/diagnostics accumulate. */
function mergeHookOutcomes(outcomes: Array<HookOutcome | undefined>): HookOutcome {
  const merged: HookOutcome = { block: false, askDowngraded: false, diagnostics: [] };
  for (const o of outcomes) {
    if (!o) continue;
    if (o.block && !merged.block) {
      merged.block = true;
      merged.blockReason = o.blockReason;
    }
    merged.askDowngraded = merged.askDowngraded || o.askDowngraded;
    if (o.additionalContext) {
      merged.additionalContext = merged.additionalContext
        ? `${merged.additionalContext}\n${o.additionalContext}`
        : o.additionalContext;
    }
    if (o.updatedInput) merged.updatedInput = { ...merged.updatedInput, ...o.updatedInput };
    if (o.stdout) merged.stdout = merged.stdout ? `${merged.stdout}\n${o.stdout}` : o.stdout;
    if (o.systemMessages?.length) {
      merged.systemMessages = [...(merged.systemMessages ?? []), ...o.systemMessages];
    }
    merged.diagnostics.push(...o.diagnostics);
  }
  return merged;
}

/**
 * HookRunner-shaped facade multiplexing the session runner with an agent's
 * scoped runner — same pattern as index.ts's HookMultiplexer,
 * but per-dispatch and discarded with it.
 */
function multiplexHookRunners(base: HookRunner, scoped: HookRunner): HookRunner {
  return {
    fire: async (
      eventName: string,
      payload: Partial<HookPayload>,
      toolCall?: ToolCallDescriptor,
    ): Promise<HookOutcome> =>
      mergeHookOutcomes([
        await base.fire(eventName, payload, toolCall),
        await scoped.fire(eventName, payload, toolCall),
      ]),
  } as unknown as HookRunner;
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as any).type === "text")
      .map((c) => (c as any).text ?? "")
      .join("");
  }
  return "";
}

export class SubagentRuntime {
  private readonly semaphore: Semaphore;
  /**
   * Per-depth budgets for nested BACKGROUND dispatches. Each `depth ≥ 2`
   * gets its own `Semaphore` sized like the root, created lazily. A dispatch
   * acquires from the pool for ITS OWN depth, so an ancestor at depth `d` (holding
   * a slot in pool `d`, e.g. while blocked in a `TaskOutput(wait)` on a child)
   * never holds the slot a descendant at depth `d+1` is waiting on — no cross-depth
   * wait-for cycle, hence deadlock-free even at `concurrency = 1`. A single shared
   * pool would deadlock exactly there (see the acquire gate comment). Total nested
   * concurrency is bounded by `maxDepth × concurrency`, both finite. Depth ≤ 1
   * stays on the existing root `semaphore` so root behaviour/tests are unchanged.
   */
  private readonly nestedBudgets = new Map<number, Semaphore>();
  private sdkPromise: Promise<PiSdk> | undefined;

  constructor(private readonly deps: SubagentRuntimeDeps) {
    this.semaphore = new Semaphore(Math.max(1, deps.concurrency));
  }

  /**
   * The concurrency pool a dispatch at `depth` acquires from. Root (`depth ≤ 1`)
   * uses the existing root semaphore; each nested depth gets its own lazily-created
   * budget of the same size. Per-depth (not shared) is what keeps nested background
   * fan-out deadlock-free — see {@link nestedBudgets}.
   */
  private budgetForDepth(depth: number): Semaphore {
    if (depth <= 1) return this.semaphore;
    let budget = this.nestedBudgets.get(depth);
    if (!budget) {
      budget = new Semaphore(Math.max(1, this.deps.concurrency));
      this.nestedBudgets.set(depth, budget);
    }
    return budget;
  }

  private sdk(): Promise<PiSdk> {
    if (this.deps.sdk) return Promise.resolve(this.deps.sdk);
    this.sdkPromise ??= loadRealSdk();
    return this.sdkPromise;
  }

  /**
   * TEST-ONLY: inject a fake {@link PiSdk} so an offline-integration
   * test can drive a REAL dispatch through the `picc()`-constructed runtime
   * (proving the dispatch-mint → customToolsFor → scopedTo / start() owner threading) with
   * no live model call. Reachable only via the in-process `onWired` seam, never
   * the project-loading path; call before the first dispatch.
   */
  setSdkForTest(sdk: PiSdk): void {
    this.deps.sdk = sdk;
  }

  /**
   * Resolve a requested subagent name to its definition via the shared 3-step
   * chain: project/user/plugin agents by exact name, then case-insensitive
   * name, then built-ins. `dispatch()` prepends its `agentOverride`;
   * `isOneShotBuiltin()` uses the bare chain — both route through here so the
   * resolution order can never desync between them.
   */
  private resolveAgentDefinition(requested: string): ClaudeAgent | undefined {
    const agents = this.deps.getAgents();
    return (
      findByName(agents, requested) ??
      agents.find((a) => a.name.toLowerCase() === requested.toLowerCase()) ??
      resolveAgent(builtinAgents(), requested)
    );
  }

  /**
   * The one-shot-builtin predicate (Explore/Plan): shared by dispatch()'s
   * `resumable` flag and the background start message's id suppression, so a
   * future third one-shot builtin can't desync them.
   */
  private isOneShot(agent: ClaudeAgent | undefined): boolean {
    return agent?.builtin === true && (agent.name === "Explore" || agent.name === "Plan");
  }

  /**
   * True iff `subagentType` resolves to a one-shot BUILTIN (Explore/Plan) —
   * i.e. a definitely non-resumable dispatch. Mirrors dispatch()'s resolution
   * order (shared resolver) so a same-named PROJECT agent (which resolves first
   * and lacks the builtin marker) is NOT treated as one-shot. Used by the
   * background Agent tool to decide whether the start message should advertise
   * an agent id: one-shot builtins get no id segment (a follow-up would be
   * refused).
   */
  isOneShotBuiltin(subagentType: string): boolean {
    const requested = subagentType.trim() || "general-purpose";
    return this.isOneShot(this.resolveAgentDefinition(requested));
  }

  /**
   * True iff `subagentType` resolves to an agent whose frontmatter sets
   * `background: true` (Claude 2.1.198): the dispatch runs in the background
   * even against an explicit `run_in_background: false` — its remaining
   * significance now that dispatch is background-by-default. Mirrors
   * dispatch()'s resolution order via the shared resolver.
   */
  isBackgroundAgent(subagentType: string): boolean {
    const requested = subagentType.trim() || "general-purpose";
    return this.resolveAgentDefinition(requested)?.background === true;
  }

  async dispatch(opts: {
    subagentType: string;
    prompt: string;
    model?: string;
    /** Effort override (e.g. a context:fork skill's `effort:`); defaults to the agent's. */
    effort?: string;
    depth: number;
    /**
     * Nested background bound: when a `depth > 1` dispatch is issued on
     * the BACKGROUND arm (un-awaited via `backgroundTasks.start`, or a
     * `SendMessage` resume that landed at `record.depth ≥ 2`), it must count
     * against the concurrency bound instead of taking the foreground nested
     * bypass. Set `true` on those arms only; the foreground arm and `forkDispatch`
     * leave it unset so they keep the `() => {}` bypass. Ignored at `depth ≤ 1`
     * (root always acquires its own pool regardless). See the acquire gate below.
     */
    background?: boolean;
    /**
     * Runtime-set fork-spawns-fork marker: true iff this dispatch's
     * DISPATCHER is a genuinely-inheriting fork. Set ONLY by the runtime (threaded
     * from a fork's `isFork` into its granted Agent/Task tool definitions), NEVER
     * derived from a tool parameter — same anti-spoofing discipline as `ownerAgentId`.
     * When true, a `subagent_type: "fork"` request is refused (visible degrade to
     * fresh general-purpose with a fork-specific "a fork cannot spawn another fork"
     * notice); normal subagent types are unaffected.
     */
    dispatcherIsFork?: boolean;
    /**
     * Dispatch this agent definition directly instead of looking subagentType up —
     * used for the synthetic general-purpose target of agent-less context:fork skills.
     */
    agentOverride?: ClaudeAgent;
    /** Cooperative abort (TaskStop): best-effort session.abort() when signaled. */
    abortSignal?: AbortSignal;
    /**
     * Pre-minted agent ID: the background Agent tool mints it up front so the
     * start message can carry it; a resume passes the existing ID.
     */
    agentId?: string;
    /**
     * The DISPATCHER's own agent id, recorded set-once as the child record's
     * parent link (the status panel's tree). Runtime-threaded from the Agent
     * tool's `ownerAgentId` — never a tool parameter (same anti-spoofing
     * discipline). Absent for a coordinator dispatch.
     */
    parentAgentId?: string;
    /**
     * The Agent tool's model-supplied `description` label, already sanitized
     * at capture; stored set-once on the registry record (the panel's label).
     */
    description?: string;
    /**
     * Live-progress sink: fed a bounded, sanitized {@link ProgressSnapshot}
     * whenever the running subagent's visible activity changes. Display-only —
     * NEVER part of `finalMessage` (the verbatim-return contract is untouched).
     * Requires the session to expose `subscribe`; a no-op when it does not.
     */
    onProgress?: (snapshot: ProgressSnapshot) => void;
    /**
     * Resume a finished subagent (SendMessage). When set, dispatch takes the
     * SAME construction path (gated tools, guard, scoped hooks, system prompt +
     * lockdown, maxTurns, depth, model) but seeds the session from the persisted
     * transcript instead of creating a fresh one, and reuses the original cwd/
     * worktree instead of entering a new one. SECURITY: there is no
     * lighter resume path — every enforcement layer is re-applied because it is
     * the identical dispatch code. The caller passes the SAME `agentId`.
     */
    resume?: {
      /** The persisted transcript to reopen (from the registry record, never `to`). */
      transcriptPath: string;
      /** The cwd the original run used (worktree path when isolated) — reused as-is. */
      cwd: string;
      /** The original worktree path, when isolated — reused, never re-entered. */
      worktreePath?: string;
    };
  }): Promise<DispatchResult> {
    const diagnostics: Diagnostic[] = [];
    // Caller-provided agent ID hardening: a resume/model-derived ID MUST be the
    // minted `agent-<12 hex>` form. A hostile or malformed value fails the
    // dispatch loudly — never silently minted-over or passed through to the
    // session/filesystem path.
    if (opts.agentId !== undefined && !isAgentId(opts.agentId)) {
      return {
        ok: false,
        outcome: "failed",
        finalMessage: "",
        agentId: mintAgentId(),
        resumable: false,
        error: `Refusing to dispatch: caller-provided agent id ${JSON.stringify(
          opts.agentId,
        )} is not the minted "agent-<12 hex>" form.`,
        diagnostics,
      };
    }
    // Agent identity: minted here unless the caller pre-minted/reuses one.
    // Every exit path carries it, so mirrors (background records) stay keyed.
    const agentId = opts.agentId ?? mintAgentId();
    const agents = this.deps.getAgents();
    // Built-ins resolve AFTER project/user/plugin agents: a project agent named
    // Explore overrides the built-in. Empty/omitted subagent_type defaults to
    // general-purpose.
    const builtins = builtinAgents();
    const requested = opts.subagentType.trim() || "general-purpose";
    let prompt = opts.prompt;

    // The reserved `subagent_type: "fork"` inherits the parent conversation.
    // Intercepted HERE — before the unknown-type fallback below — and always sets
    // `resolved`, so the generic `unknown subagent_type "fork"; ran as
    // general-purpose` warning can NEVER fire for a fork. `isFork` is the single
    // per-dispatch marker (true ONLY when the fork will ACTUALLY inherit) kept in
    // scope down to the customToolsFor call, which threads it into the fork's
    // Agent/Task tools. A degraded fork keeps `isFork === false` — it is a plain
    // fresh general-purpose run and must not carry the fork marker.
    let isFork = false;
    // An inheriting fork's child session-manager. It is REUSED by the later
    // session-manager stage (never re-forked). `forkFrom` is EAGER + SYNCHRONOUS —
    // it writes a full copy of the parent conversation to disk the instant it is
    // called — so the actual construction is DEFERRED (via `attemptForkSession`
    // below) to just before `customToolsFor`, AFTER the abort-before-start,
    // SubagentStart-block, and abort-after-worktree gates: an aborted or hook-blocked
    // fork must never leave an on-disk copy behind. It still runs BEFORE customTools/
    // identity are finalized, so a `forkFrom` throw resolves to a plain
    // general-purpose (isFork=false, unmarked tools, honest badge) before either is
    // fixed. Undefined ⇒ this dispatch is not (or no longer) an inheriting fork.
    let forkSession: PiSessionManagerLike | undefined;
    // The deferred `forkFrom` call. Set (in the interception below) ONLY
    // for a fork that passed every degrade check; invoked once, immediately before
    // `customToolsFor`. A fork shares the parent cwd (isolation undefined) and is
    // never a resume, so the cwd known at interception equals the dispatch cwd passed
    // here. Undefined ⇒ nothing to fork (degraded at interception, or not a fork).
    let attemptForkSession: ((cwd: string) => PiSessionManagerLike) | undefined;
    // The developer-/model-facing degrade reason + tone (calm `info` for a chosen/
    // expected opt-out, `warning` for a genuine can't-do). Surfaced as a fork-
    // specific notice — never the generic unknown-type warning, never silent. The
    // MODEL sees `modelReason` only; `devReason` (optional) may carry capped error
    // detail for the developer diagnostic (forkFrom-throw case).
    let forkDegrade: { modelReason: string; devReason?: string; tone: "info" | "warning" } | undefined;
    let resolved: ClaudeAgent | undefined;
    // Emit a fork-degrade in ONE place so the model-facing prompt prefix and
    // the developer-facing diagnostic sentinel can't drift across the (3) degrade
    // sites (gate/nested/no-transcript/no-SDK here, plus forkFrom-throw and the
    // defensive branch in the session-manager stage). SECURITY: the MODEL sees
    // `modelReason` ONLY — never raw error text, which can embed the main session's
    // absolute path. The developer-facing diagnostic carries `devReason` (defaults
    // to `modelReason`), which MAY include capped error detail (forkFrom-throw case).
    const emitForkDegrade = (
      tone: "info" | "warning",
      modelReason: string,
      devReason: string = modelReason,
    ): void => {
      prompt = `(PiCC: this "fork" dispatch ran with FRESH context — it did NOT inherit the parent conversation. Reason: ${modelReason}.)\n\n${prompt}`;
      diagnostics.push({ severity: tone, message: `${FORK_DEGRADE_PREFIX}${devReason}` });
    };
    if (requested === FORK_SUBAGENT_TYPE) {
      // SECURITY: the gate is read from process.env ONLY — never
      // project.settings.env / frontmatter / any project file (a project could
      // otherwise force-enable inheritance of its OWN dispatches). Unset ⇒ ENABLED
      // (a deliberate PiCC parity choice); present-but-off (`=0`/`false`/…) ⇒ off.
      const gateRaw = process.env.CLAUDE_CODE_FORK_SUBAGENT;
      const gateOff = gateRaw !== undefined && !isEnvTruthy(gateRaw);
      // Main-session-only (SECURITY): getMainSessionFile() ALWAYS returns the ROOT
      // transcript regardless of dispatcher, so a non-main-session (depth ≠ 1) fork
      // would seed the WRONG (root) conversation — an exfiltration path (a tool-
      // restricted subagent forking the root conversation into itself). The main
      // session's Agent/Task tools dispatch at depth 0→1, so ONLY opts.depth === 1
      // may inherit (a hypothetical depth-0 dispatch also degrades).
      let forkMainFile: string | undefined;
      try {
        forkMainFile = this.deps.getMainSessionFile?.();
      } catch {
        forkMainFile = undefined;
      }
      // SDK fork capability (older/fake SDKs lack forkSessionManager). Loaded here
      // in a guard so a loader failure degrades to fresh rather than rejecting;
      // distinguish a load FAILURE from an SDK that loaded but lacks fork support.
      let forkSdk: PiSdk | undefined;
      let forkSdkLoadFailed = false;
      try {
        forkSdk = await this.sdk();
      } catch {
        forkSdk = undefined;
        forkSdkLoadFailed = true;
      }
      const canForkSdk = typeof forkSdk?.forkSessionManager === "function";

      if (opts.dispatcherIsFork) {
        // Fork-spawns-fork guard: this dispatch's DISPATCHER is itself a
        // genuinely-inheriting fork (the runtime-set `dispatcherIsFork` marker,
        // threaded into a fork's Agent/Task tools — NEVER a tool parameter). A
        // fork cannot spawn another fork (Claude's documented rule), so refuse it:
        // a VISIBLE degrade to fresh general-purpose with a fork-SPECIFIC, calm
        // (by-design) notice — distinct from the gate/nested wording. Enforced
        // via the marker, not the depth guard (which stays the untouched outer
        // backstop). Checked FIRST so a nested fork (depth ≠ 1) gets this precise
        // reason rather than the generic "nested fork" one.
        forkDegrade = {
          modelReason: `a fork cannot spawn another fork`,
          tone: "info",
        };
      } else if (gateOff) {
        forkDegrade = {
          modelReason: `fork inheritance is disabled via CLAUDE_CODE_FORK_SUBAGENT; unset it to enable`,
          tone: "info",
        };
      } else if (opts.depth !== 1) {
        forkDegrade = {
          modelReason: `the parent conversation is not available for a nested fork (only the main session can fork)`,
          tone: "warning",
        };
      } else if (!forkMainFile) {
        forkDegrade = {
          modelReason: `no parent transcript is available to fork (print/headless/no-session mode)`,
          tone: "warning",
        };
      } else if (!canForkSdk) {
        forkDegrade = {
          modelReason: forkSdkLoadFailed
            ? `the fork runtime could not be loaded`
            : `this runtime cannot fork a session (the SDK lacks forkSessionManager)`,
          tone: "warning",
        };
      } else {
        // Genuinely inheriting fork — every degrade check passed. DEFER the actual
        // `forkFrom` call (it is eager + synchronous and writes the parent
        // conversation to disk) to just before `customToolsFor`, AFTER the abort/
        // SubagentStart-block gates, so an aborted or hook-blocked dispatch never
        // creates the on-disk copy. Tentatively mark isFork so the gates + the
        // SubagentStart payload use the fork identity; the deferred attempt settles
        // the FINAL isFork/identity/badge (a throw there re-resolves to
        // general-purpose) BEFORE the child tools + identity are built.
        // The env=0 / nested / no-transcript / SDK-can't-fork / fork-spawns-fork
        // degrades stay resolved at interception — none of them need `forkFrom`.
        isFork = true;
        // Capture the fork inputs (SDK + narrowed main-session file) for the thunk;
        // the dispatch cwd is passed in at the call site.
        const forkSdkRef = forkSdk!;
        const forkMainFileRef = forkMainFile;
        attemptForkSession = (cwd: string) =>
          forkSdkRef.forkSessionManager!(
            forkMainFileRef,
            cwd,
            subagentSessionDir(forkMainFileRef),
            agentId,
          );
      }

      if (isFork) {
        // Reads as a fork (agentName "fork" → an honest `Agent(fork)` badge).
        resolved = buildForkAgent();
      } else {
        // Degrade: run as fresh general-purpose (a fresh IDENTITY, so success vs.
        // degrade are distinguishable in the rendered badge) with a fork-SPECIFIC
        // notice — never the generic unknown-type warning, never inheriting.
        resolved = resolveAgent(builtins, "general-purpose");
        emitForkDegrade(forkDegrade!.tone, forkDegrade!.modelReason, forkDegrade!.devReason);
      }
    } else {
      // Shared resolver: one home for the resolution order so
      // isOneShotBuiltin() can't desync from this dispatch's settled resumability.
      resolved = opts.agentOverride ?? this.resolveAgentDefinition(requested);
    }
    // Claude fallback: an unknown subagent_type runs as
    // general-purpose instead of hard-erroring — with a VISIBLE degrade in
    // both the diagnostics and the subagent's own prompt. (A fork always set
    // `resolved` above, so this generic warning can never fire for it.)
    const resolvedAgent = resolved ?? resolveAgent(builtins, "general-purpose");
    if (!resolved && resolvedAgent) {
      diagnostics.push({
        severity: "warning",
        message: `unknown subagent_type "${requested}"; ran as general-purpose`,
      });
      prompt = `(You were dispatched as subagent type "${requested}", which is not defined in this project; you are running as a general-purpose agent.)\n\n${opts.prompt}`;
    }
    if (!resolvedAgent) {
      // Genuinely unusable (general-purpose itself unavailable): keep the
      // catalog-listing error so the model can pick a real agent.
      const known = [...agents, ...builtins].map((a) => a.name).join(", ");
      return {
        ok: false,
        outcome: "failed",
        finalMessage: "",
        agentId,
        resumable: false,
        error: `Unknown subagent_type "${opts.subagentType}". Available: ${known || "(none)"}`,
        diagnostics,
      };
    }
    // `let` (not `const`): a DEFERRED forkFrom throw (just before customToolsFor,
    // after the gates) re-resolves this to general-purpose so the RESULT badge and
    // the post-gate hook identity are honest (`Agent(general-purpose)`). Typed
    // explicitly (ClaudeAgent, not `| undefined`) off the guarded `resolvedAgent` so
    // control-flow narrowing survives the reassignment across the later awaits.
    let agent: ClaudeAgent = resolvedAgent;
    if (opts.depth > this.deps.maxDepth) {
      return {
        ok: false,
        outcome: "failed",
        finalMessage: "",
        agentId,
        resumable: false,
        agentName: agent.name,
        error: `Subagent nesting depth ${opts.depth} exceeds the configured maximum (subagents.maxDepth) of ${this.deps.maxDepth}. Raise subagents.maxDepth to 2..5 in .claude/settings.json to allow nested delegation.`,
        diagnostics,
      };
    }
    if (opts.abortSignal?.aborted) {
      return {
        ok: false,
        outcome: "aborted",
        finalMessage: "",
        agentId,
        resumable: false,
        agentName: agent.name,
        error: `Subagent "${agent.name}" was stopped before it started.`,
        diagnostics,
      };
    }

    // Transcript persistence state: the transcript path only exists once the
    // session manager is created (below); it is carried on the DispatchResult
    // and drives `resumable`. Parity: subagent hook events are NOT re-pointed to
    // it — they keep the main transcript_path.
    let transcriptPath: string | undefined;
    let resumable = false;
    // Built-in one-shot agents (Explore/Plan) are never resumable — the flag
    // travels with the ID so SendMessage can refuse. A same-named PROJECT agent is a
    // normal agent (it resolves first and lacks the builtin marker).
    const oneShot = this.isOneShot(agent);

    // A fork/`agentOverride` dispatch runs a SYNTHETIC agent definition
    // (`fork:<skill>`) that is NOT in getAgents()/builtins — it cannot be safely
    // re-derived by name on resume (a by-name resolve would miss and fall back to
    // all-tools general-purpose, WIDENING the tool gate). SECURITY:
    // such a dispatch is recorded NON-RESUMABLE regardless of transcript, so
    // SendMessage refuses it via the existing non-resumable path (forks are not
    // SendMessage-resumable).
    const overrideDispatch = opts.agentOverride !== undefined;

    // Ack-before-register window: for a fresh `run_in_background`
    // dispatch the ack (carrying agentId) is handed out by backgroundTasks.start()
    // BEFORE this async dispatch reaches the session-creation register() below, so
    // a coordinator that SendMessages that id in the SAME turn would hit a registry
    // miss. Register a MINIMAL record synchronously at entry (before the semaphore
    // await) so the id resolves the instant the ack returns; the session-creation
    // register() ENRICHES it (session handle, transcriptPath, resumable, worktree).
    // The record starts running with no session — a SendMessage arriving in this
    // transient window takes the "running but not yet steerable" refusal (below),
    // by design. Name-integrity is unchanged: this binds the name exactly as the
    // enrich would, and the enrich shares the same agentId → updates in place,
    // never rebinding. Skip on resume — markResuming already re-armed the existing
    // record; re-registering minimally here would transiently wipe its
    // transcriptPath/resumable mid-resume.
    if (!opts.resume) {
      // Panel fields ride on the FIRST register (set-once): parent link,
      // description, the initial prompt (opts.prompt, not the local `prompt` a
      // fork degrade may have prefixed), and the frontmatter color (validated
      // by the registry). startedAt is stamped by the registry itself.
      this.deps.subagentRegistry?.register({
        agentId,
        agentName: agent.name,
        depth: opts.depth,
        cwd: this.deps.getCwd(),
        resumable: false,
        oneShot,
        parentAgentId: opts.parentAgentId,
        description: opts.description,
        prompt: opts.prompt,
        color: agent.color,
      });
    }

    // Agent-scoped hooks: frontmatter `hooks:` dispatch while THIS
    // subagent runs. The scoped runner is multiplexed with the session runner
    // for the dispatch's guard and Subagent* events and discarded when it ends.
    let scopedHooks: HookRunner | undefined;
    if (
      this.deps.makeScopedHookRunner &&
      agent.hooks &&
      Object.values(agent.hooks).some((entries) => entries?.length)
    ) {
      try {
        const parsed = parseHookConfig(agent.hooks, agent.source.path);
        diagnostics.push(...parsed.diagnostics);
        if (Object.keys(parsed.config).length > 0) {
          // Parity: the scoped runner keeps the MAIN session
          // transcript_path — subagent hook events must NOT be re-pointed at the
          // subagent's own transcript (Claude Code behavior).
          scopedHooks = this.deps.makeScopedHookRunner(parsed.config);
          diagnostics.push({
            severity: "info",
            message: `agent-scoped hooks active for "${agent.name}" (${Object.keys(parsed.config).join(", ")})`,
          });
        }
      } catch (err) {
        // This hook-config parsing sits BETWEEN the minimal register() above and
        // the main try/finally that settles the record. A throw here (before the
        // semaphore is acquired) would otherwise strand the registry record as
        // "running" forever. Settle it failed and fail the dispatch loudly. No
        // slot to release — the semaphore has not been acquired yet.
        this.deps.subagentRegistry?.markSettled(agentId, { outcome: "failed" });
        return {
          ok: false,
          outcome: "failed",
          finalMessage: "",
          agentId,
          resumable: false,
          agentName: agent.name,
          error: `Subagent "${agent.name}" failed during hook setup: ${capErrorText(
            (err as Error)?.message ?? String(err),
          )}`,
          diagnostics,
        };
      }
    }
    if (scopedHooks) {
      // Agent-hook `systemMessage`s are user-facing: surface each
      // distinct message through the dispatch diagnostics (the same channel the
      // Agent tool result / console reports).
      const inner = scopedHooks;
      const seenSystemMessages = new Set<string>();
      scopedHooks = {
        fire: async (
          eventName: string,
          payload: Partial<HookPayload>,
          toolCall?: ToolCallDescriptor,
        ): Promise<HookOutcome> => {
          const outcome = await inner.fire(eventName, payload, toolCall);
          for (const msg of outcome?.systemMessages ?? []) {
            if (seenSystemMessages.has(msg)) continue;
            seenSystemMessages.add(msg);
            diagnostics.push({
              severity: "info",
              message: `agent hook systemMessage: ${msg}`,
            });
          }
          return outcome;
        },
      } as unknown as HookRunner;
    }
    // Central identity injection: agent_id AND agent_type (the agent's
    // name) ride on EVERY hook payload fired within this dispatch — the guard's
    // PreToolUse/PostToolUse fired from inside the subagent, SubagentStart, and
    // SubagentStop/Stop — so the subagent identity can't drift per fire site
    // (Claude Code hook input carries both). One choke point wrapping each raw
    // runner. transcript_path is deliberately NOT injected — parity: subagent
    // hook events keep the MAIN session transcript_path (the runner's own
    // constructed default), never the subagent's own file.
    const injectIdentity = (runner: HookRunner): HookRunner =>
      ({
        fire: (
          eventName: string,
          payload: Partial<HookPayload>,
          toolCall?: ToolCallDescriptor,
        ): Promise<HookOutcome> =>
          runner.fire(
            eventName,
            { ...payload, agent_id: agentId, agent_type: agent.name },
            toolCall,
          ),
      }) as unknown as HookRunner;
    const baseRunner = injectIdentity(this.deps.hookRunner);
    if (scopedHooks) scopedHooks = injectIdentity(scopedHooks);
    const hookRunner = scopedHooks
      ? multiplexHookRunners(baseRunner, scopedHooks)
      : baseRunner;
    // Agent frontmatter `Stop` hooks map to SubagentStop time for this dispatch.
    const fireSubagentStop = async (
      payload: Partial<HookPayload>,
    ): Promise<HookOutcome | undefined> => {
      // Parity: the Stop payload carries NO transcript_path.
      // Inside a subagent Claude Code keeps transcript_path pointing at the MAIN
      // session transcript, which the HookRunner supplies from its own
      // constructed default — PiCC must not clobber it with the subagent's own
      // file. agent_id/agent_type come from the central injection above.
      const outcomes: Array<HookOutcome | undefined> = [
        await hookRunner.fire("SubagentStop", payload).catch(() => undefined),
      ];
      if (scopedHooks) {
        outcomes.push(await scopedHooks.fire("Stop", payload).catch(() => undefined));
      }
      return mergeHookOutcomes(outcomes);
    };

    // Concurrency gate. Two nested-deadlock hazards, handled distinctly:
    //   * FOREGROUND nested (`depth > 1`, no `background`): keeps its `() => {}`
    //     bypass. A foreground parent BLOCKS its turn awaiting the child, holding
    //     its slot; if the child had to acquire the SAME pool the parent holds, C
    //     such parents would deadlock C queued children. Foreground children never
    //     acquire, so no slot-holder ever waits on a slot-waiter.
    //   * BACKGROUND nested (`depth > 1`, `background: true`): must be BOUNDED, but
    //     a single shared pool would deadlock too — a parent blocked in
    //     TaskOutput(wait) on its background child holds a slot while the child
    //     queues for the same pool (guaranteed at C = 1). So it acquires from a
    //     PER-DEPTH budget: an ancestor's held slot lives in pool `depth-1`, the
    //     descendant waits in pool `depth`, never the same slot → no cross-depth
    //     cycle → deadlock-free even at concurrency 1.
    // Root (`depth ≤ 1`) always acquires its own (root) pool, exactly as before.
    const foregroundNested = opts.depth > 1 && !opts.background;
    const release = foregroundNested
      ? () => {}
      : await this.budgetForDepth(opts.depth).acquire();
    let worktreePath: string | undefined;
    let session: PiSession | undefined;
    let started = false;
    let stopFired = false;
    let abortListener: (() => void) | undefined;
    let progressUnsub: (() => void) | undefined;
    // Usage accounting: capture the session's aggregate stats AFTER the
    // last prompt() and BEFORE each result is built — the result literals live
    // in this try block, so a finally-only capture would have nowhere to attach
    // to the returned DispatchResult. `captureUsage()` reads the live session's
    // getSessionStats() (best-effort; a fake/older SDK without it → undefined,
    // never a crash) into the mutable local, threaded into every session-bearing
    // result and read once more in the finally for the dispatch registry.
    // `settledOutcome` records the fate for the registry's per-subagent report.
    let capturedUsage: DispatchUsage | undefined;
    let settledOutcome: DispatchOutcome | undefined;
    // The final answer text for the registry record (panel drill-down): the
    // completed final message, or a failed run's best-effort partial. Aborted
    // runs leave it unset — a deliberately stopped result is discarded by
    // contract. Read once in the finally alongside outcome/usage.
    let settledFinalText: string | undefined;
    const captureUsage = (): DispatchUsage | undefined => {
      const live = session;
      if (live && typeof live.getSessionStats === "function") {
        try {
          capturedUsage = usageFromStats(live.getSessionStats());
        } catch {
          // usage is metadata — a stats failure must never fail the dispatch
        }
      }
      return capturedUsage;
    };
    try {
      if (opts.abortSignal?.aborted) {
        // Re-check after the semaphore wait: a TaskStop issued while
        // the dispatch was queued must not burn a full session. Informational
        // SubagentStop matches the error-path pattern; finally releases the slot.
        settledOutcome = "aborted";
        stopFired = true;
        await fireSubagentStop({
          subagent_type: agent.name,
          cwd: this.deps.getCwd(),
        }).catch(() => undefined);
        return {
          ok: false,
          outcome: "aborted",
          finalMessage: "",
          agentId,
          resumable: false,
          agentName: agent.name,
          error: `Subagent "${agent.name}" was stopped before it started.`,
          diagnostics,
        };
      }
      const startOutcome = await hookRunner
        .fire("SubagentStart", {
          // agent_id + agent_type are added centrally (injectIdentity); a
          // SubagentStart payload carries NO transcript_path (the session/
          // transcript may not exist yet).
          subagent_type: agent.name,
          prompt,
          cwd: this.deps.getCwd(),
        })
        .catch(() => undefined);
      if (startOutcome?.block) {
        settledOutcome = "failed";
        return {
          ok: false,
          outcome: "failed",
          finalMessage: "",
          agentId,
          resumable: false,
          agentName: agent.name,
          error: `SubagentStart hook blocked dispatch${startOutcome.blockReason ? `: ${startOutcome.blockReason}` : ""}`,
          diagnostics,
        };
      }
      started = true;

      let cwd = this.deps.getCwd();
      if (opts.resume) {
        // Resume: reuse the ORIGINAL cwd/worktree exactly — never enter a
        // new worktree (that would branch a fresh, empty checkout and lose the
        // run's context). Reachability was already checked by SendMessage against
        // the REGISTRY-stored path before this dispatch was kicked off.
        cwd = opts.resume.cwd;
        worktreePath = opts.resume.worktreePath;
      } else if (agent.isolation === "worktree" && this.deps.worktrees) {
        // Collision-free name: parallel fan-out of one agent must never share a
        // worktree (Date.now()-based names collide within the same millisecond).
        const enter = await this.deps.worktrees.enter({
          name: `agent-${agent.name}-${randomUUID().slice(0, 8)}`,
        });
        if (enter.ok && enter.worktreePath) {
          worktreePath = enter.worktreePath;
          cwd = enter.worktreePath;
          diagnostics.push(...enter.diagnostics);
        } else {
          diagnostics.push({
            severity: "warning",
            message: `isolation: worktree requested but entry failed (${enter.error ?? "unknown"}); running in shared cwd`,
          });
        }
      }
      if (opts.abortSignal?.aborted) {
        // Re-check after worktree entry: a stop during enter() must
        // not spin up the session. The finally keep-exits the worktree.
        settledOutcome = "aborted";
        stopFired = true;
        await fireSubagentStop({
          subagent_type: agent.name,
          cwd: this.deps.getCwd(),
        }).catch(() => undefined);
        return {
          ok: false,
          outcome: "aborted",
          finalMessage: "",
          agentId,
          resumable: false,
          agentName: agent.name,
          worktreePath,
          error: `Subagent "${agent.name}" was stopped before it started.`,
          diagnostics,
        };
      }
      // The DEFERRED forkFrom call. `forkFrom` is eager + synchronous —
      // it immediately writes a full copy of the parent conversation to disk — so it
      // runs HERE, AFTER the abort-before-start, SubagentStart-block, and
      // abort-after-worktree gates: an aborted or hook-blocked fork never leaves an
      // on-disk copy behind (the env=0/nested/no-transcript/SDK-can't-fork/
      // fork-spawns-fork degrades were already resolved at interception — they don't
      // need `forkFrom`). It still runs BEFORE `customToolsFor` so the FINAL isFork +
      // resolved identity/badge are settled before the child tools + identity are
      // built. The constructed manager is reused by the session-manager
      // stage (never re-forked), keeping `forkCalls()` at 1.
      if (attemptForkSession) {
        try {
          forkSession = attemptForkSession(cwd);
          // Success: isFork stays true; the fork identity/badge stand.
        } catch (err) {
          // Degrade to a plain general-purpose run: flip isFork false so
          // `customToolsFor` builds UNMARKED tools, re-resolve the identity so the
          // RESULT badge is honest (`Agent(general-purpose)`), and emit the generic
          // model reason. SECURITY: the raw error can embed the main session's
          // ABSOLUTE PATH, so the capped detail rides the developer diagnostic only.
          // Accepted cosmetic: the SubagentStart hook already fired with the "fork"
          // subagent_type (before this throw was known); the badge stays honest.
          isFork = false;
          agent = resolveAgent(builtins, "general-purpose") ?? agent;
          emitForkDegrade(
            "warning",
            `forking the parent session failed`,
            `forking the parent session failed (${capErrorText(
              (err as Error)?.message ?? String(err),
            )})`,
          );
        }
      }

      // Dispatch-local cwd state: the subagent's tools (and its own EnterWorktree
      // use) must never swap the ORCHESTRATOR's cwd.
      const subCwd = new CwdState(cwd);

      const granted = this.deps.permissionEngine.gateTools(
        agent.tools,
        agent.disallowedTools,
        this.deps.allKnownToolNames(),
      );
      const piBuiltins = claudeToolsToPiBuiltins(granted);
      // `agentId` (the dispatch's own minted id, above) is the OWNER that
      // scopes this agent's TaskOutput/TaskStop and tags the tasks it starts.
      // Never derived from a tool param (anti-spoofing).
      // `isFork` is in scope here (true ONLY for a fork that ACTUALLY
      // inherits — the DEFERRED forkFrom attempt just above has already flipped it
      // false on throw) — thread it as the runtime-set `dispatcherIsFork` marker so
      // the fork's granted Agent/Task tools refuse a fork-spawns-fork. A degraded
      // fork is `isFork === false`, so its tools stay unmarked and its own nested
      // dispatches are not mis-refused.
      const customTools = this.deps.customToolsFor(agent, granted, opts.depth, agentId, isFork, subCwd);

      const sdk = await this.sdk();
      const injector = this.deps.makeContextInjector
        ? this.deps.makeContextInjector(() => subCwd.get())
        : this.deps.contextForTouchedFile;
      const guard = createGuardExtension({
        engine: this.deps.permissionEngine,
        // Multiplexed runner: the agent's scoped PreToolUse/PostToolUse/
        // PostToolUseFailure hooks fire alongside the session hooks — for this
        // dispatch's tool calls only.
        hooks: hookRunner,
        getCwd: () => subCwd.get(),
        contextForTouchedFile: injector,
        label: `subagent:${agent.name}`,
      });
      const extensionFactories: Array<{ name: string; factory: (pi: unknown) => unknown }> = [
        { name: `picc-guard-${agent.name}`, factory: guard as (pi: unknown) => unknown },
      ];
      if (agent.maxTurns && agent.maxTurns > 0) {
        extensionFactories.push({
          name: `picc-maxturns-${agent.name}`,
          factory: createMaxTurnsExtension(agent.maxTurns, diagnostics) as (pi: unknown) => unknown,
        });
      }
      const loader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir: sdk.agentDir(),
        systemPromptOverride: () => this.deps.buildSystemPrompt(agent, opts.depth),
        skillsOverride: () => ({ skills: [], diagnostics: [] }),
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        promptsOverride: () => ({ prompts: [], diagnostics: [] }),
        extensionFactories,
      });
      await loader.reload();

      // Model resolution order: CLAUDE_CODE_SUBAGENT_MODEL env beats
      // the per-invocation `model` param, which beats agent frontmatter `model:`,
      // which beats the session model. "inherit"/empty env value = unset.
      const envModelRaw = process.env.CLAUDE_CODE_SUBAGENT_MODEL?.trim();
      const envModel =
        envModelRaw && envModelRaw.toLowerCase() !== "inherit" ? envModelRaw : undefined;
      const modelSpec = envModel ?? opts.model ?? agent.model;
      let model = this.deps.resolveModel(modelSpec);
      if (modelSpec && model === undefined) {
        // Visible degrade: inherit the session model rather than silently
        // falling through to Pi's default model.
        diagnostics.push({
          severity: "warning",
          message: `agent model "${modelSpec}" is not resolvable; inheriting the session model`,
        });
        model = this.deps.resolveModel(undefined);
      }
      const thinking = this.deps.mapEffort(opts.effort ?? agent.effort);
      const toolNames = [
        ...piBuiltins,
        ...customTools.map((t) => (t as { name: string }).name),
      ];

      // Persisted subagent transcript: one JSONL per dispatch, named by
      // the agent ID, in a sibling directory of the MAIN session's transcript.
      // Degrade, never crash: unknown main file (print/no-session modes,
      // tests), an SDK without the factory, or a failing create all fall back
      // to in-memory with a diagnostic — such agents are non-resumable.
      let sessionManager: unknown;
      let mainSessionFile: string | undefined;
      try {
        mainSessionFile = this.deps.getMainSessionFile?.();
      } catch {
        mainSessionFile = undefined;
      }
      if (opts.resume) {
        // Resume: REOPEN the same transcript instead of creating a fresh
        // one, so the reopened session carries the prior context. A resume that
        // cannot reopen must FAIL LOUDLY — silently degrading to a fresh
        // in-memory session would run the agent WITHOUT its context (the exact
        // silent-outcome bug class this feature fixes).
        if (!sdk.reopenSessionManager) {
          settledOutcome = "failed";
          return {
            ok: false,
            outcome: "failed",
            finalMessage: "",
            agentId,
            resumable: false,
            agentName: agent.name,
            worktreePath,
            error: `Cannot resume agent ${agentId}: this runtime cannot reopen persisted transcripts.`,
            diagnostics,
          };
        }
        try {
          const reopened = sdk.reopenSessionManager(
            opts.resume.transcriptPath,
            path.dirname(opts.resume.transcriptPath),
            cwd,
          );
          transcriptPath = reopened.getSessionFile() ?? opts.resume.transcriptPath;
          sessionManager = reopened;
          resumable = !oneShot && transcriptPath !== undefined;
        } catch (err) {
          settledOutcome = "failed";
          return {
            ok: false,
            outcome: "failed",
            finalMessage: "",
            agentId,
            transcriptPath: opts.resume.transcriptPath,
            resumable: false,
            agentName: agent.name,
            worktreePath,
            error: `Cannot resume agent ${agentId}: reopening its transcript failed (${capErrorText(
              (err as Error)?.message ?? String(err),
            )}).`,
            diagnostics,
          };
        }
      } else if (isFork) {
        // Fork branch (third session-manager branch): the child session was
        // ALREADY forkFrom-seeded just before `customToolsFor` — `isFork` here
        // therefore reflects the FINAL post-fork-attempt state, so a forkFrom
        // throw already degraded to fresh (isFork=false, unmarked tools,
        // general-purpose badge) and never reaches this branch. REUSE the
        // constructed manager (a BRAND-NEW file seeded with
        // the parent history; the parent transcript is untouched); never re-fork.
        if (forkSession) {
          // Read the real path back for transcriptPath ONLY — a fork is forced
          // non-resumable regardless (its inherited context is the parent
          // conversation at fork time and cannot be safely re-derived).
          transcriptPath = forkSession.getSessionFile() ?? undefined;
          sessionManager = forkSession;
          resumable = false;
        } else {
          // Defensive degrade: `isFork` is only set true alongside a constructed
          // `forkSession`, so this is unreachable — run fresh rather than un-forked
          // silently if that invariant is ever violated. Re-resolve the identity
          // (mirroring the forkFrom-throw path) so the RESULT badge is honest
          // (`Agent(general-purpose)`) and never reads `Agent(fork)` while the
          // footer says it ran fresh.
          isFork = false;
          agent = resolveAgent(builtins, "general-purpose") ?? agent;
          resumable = false;
          emitForkDegrade("warning", `the parent transcript became unavailable before forking`);
        }
      } else if (mainSessionFile && sdk.persistedSessionManager) {
        try {
          const persisted = sdk.persistedSessionManager(
            cwd,
            subagentSessionDir(mainSessionFile),
            agentId,
          );
          transcriptPath = persisted.getSessionFile() ?? undefined;
          sessionManager = persisted;
          resumable = !oneShot && transcriptPath !== undefined;
        } catch (err) {
          diagnostics.push({
            severity: "warning",
            message: `subagent transcript persistence failed (${capErrorText(
              (err as Error)?.message ?? String(err),
            )}); running in-memory — this agent will not be resumable`,
          });
        }
      } else {
        diagnostics.push({
          severity: "info",
          message: mainSessionFile
            ? "subagent transcript persistence is unavailable in this SDK; running in-memory — this agent will not be resumable"
            : "main session has no transcript file (print/no-session mode?); subagent transcript not persisted — this agent will not be resumable",
        });
      }
      sessionManager ??= sdk.inMemorySessionManager(cwd);

      const sessionOptions: Record<string, unknown> = {
        cwd,
        tools: toolNames,
        customTools,
        resourceLoader: loader,
        sessionManager,
        settingsManager: sdk.inMemorySettingsManager(),
      };
      if (model) sessionOptions.model = model;
      if (thinking) sessionOptions.thinkingLevel = thinking;

      const created = await sdk.createAgentSession(sessionOptions);
      session = created.session;
      if (thinking && session.setThinkingLevel) session.setThinkingLevel(thinking);

      // Dispatch registry: record this live run so SendMessage can steer it
      // (running) or resume it (once settled). Registered with everything a resume
      // needs — agent name (re-resolved for construction), depth, cwd/worktree,
      // transcript path — and the live session handle for steering. A resume
      // re-registers under the same ID: state flips back to running and re-arms
      // the agent-level settlement-readiness gate. Task-local delivery state and
      // newest-generation checks still decide notice eligibility after settlement.
      // The finally drops the handle on settlement.
      this.deps.subagentRegistry?.register({
        agentId,
        agentName: agent.name,
        depth: opts.depth,
        cwd,
        worktreePath,
        transcriptPath,
        // SECURITY: a fork/agentOverride dispatch is never resumable — its
        // synthetic `fork:<skill>` definition cannot be re-derived by name
        // without weakening the tool gate. An inheriting
        // fork (isFork) is likewise never resumable — its inherited parent
        // conversation at fork time cannot be safely re-derived (the local
        // `resumable` is already forced false in the fork branch; this predicate
        // keeps the registry record honest even if that ever changes).
        resumable: overrideDispatch || isFork ? false : resumable,
        oneShot,
        session: session as SteerableSession,
        // Set-once in the registry: on a fresh dispatch these reconfirm the
        // minimal register's values; on a resume the original prompt/
        // description/parent/color are preserved (opts.prompt is the follow-up
        // message here, deliberately NOT stored over the initial prompt).
        parentAgentId: opts.parentAgentId,
        description: opts.description,
        prompt: opts.prompt,
        color: agent.color,
      });

      // Cooperative stop: a TaskStop-triggered signal aborts the
      // live session best-effort (real Pi sessions expose abort()).
      if (opts.abortSignal) {
        const live = session;
        abortListener = () => {
          try {
            // Promise.resolve absorbs both sync returns and promises; the catch
            // keeps a rejecting abort() from becoming an unhandled rejection.
            Promise.resolve(live.abort?.()).catch(() => {});
          } catch {
            // best-effort — an abort failure must not corrupt the dispatch
          }
        };
        if (opts.abortSignal.aborted) abortListener();
        else opts.abortSignal.addEventListener("abort", abortListener, { once: true });
      }

      // Live progress: subscribe to the child session's event stream and
      // condense it into a bounded, sanitized snapshot pushed to opts.onProgress
      // on every visible change. Event-stream only — NEVER poll session.messages
      // (compaction inside prompt() rewrites that array mid-flight). Degrades to
      // nothing when the session has no subscribe() (simple fakes, older SDKs).
      if (opts.onProgress && typeof session.subscribe === "function") {
        const emit = opts.onProgress;
        const condenser = new SubagentProgressCondenser();
        progressUnsub = session.subscribe((event: unknown) => {
          try {
            if (condenser.consume(event)) emit(condenser.snapshot());
          } catch {
            // progress is best-effort display — never let it break the dispatch
          }
        });
      }

      this.deps.log?.(`dispatch ${agent.name} (depth ${opts.depth})`);
      const fullPrompt = agent.initialPrompt
        ? `${agent.initialPrompt}\n\n${prompt}`
        : prompt;

      // Post-prompt() classification: Pi's prompt() resolves NORMALLY on a
      // terminal LLM failure — the failure lives on the last assistant message as
      // stopReason "error"/"aborted". Called after every prompt() so the retry and
      // SubagentStop-loop re-prompts are classified too.
      const live = session;
      let truncated = false;
      let truncationDiagnosed = false;
      const terminalOutcome = (): DispatchResult | undefined => {
        const last = lastAssistantMessage(live);
        if (last?.stopReason === "error") {
          settledOutcome = "failed";
          // Best-effort partial output: whatever assistant text exists post-run
          // (compaction inside prompt() may have rewritten earlier turns).
          settledFinalText = assistantTextSoFar(live);
          return {
            ok: false,
            outcome: "failed",
            finalMessage: settledFinalText,
            agentId,
            transcriptPath,
            // A failed-but-persisted agent stays resumable: the coordinator may
            // follow up / retry it with its prior context.
            resumable,
            agentName: agent.name,
            worktreePath,
            isFork,
            // Partial usage of the failed run: "what did the failure cost me".
            usage: captureUsage(),
            error: `Agent terminated early due to an API error: ${capErrorText(last.errorMessage ?? "unknown error")}`,
            diagnostics,
          };
        }
        if (last?.stopReason === "aborted" || opts.abortSignal?.aborted) {
          settledOutcome = "aborted";
          return {
            ok: false,
            outcome: "aborted",
            finalMessage: "",
            agentId,
            transcriptPath,
            resumable,
            agentName: agent.name,
            worktreePath,
            isFork,
            usage: captureUsage(),
            error: `Subagent "${agent.name}" was aborted before completing its task.`,
            diagnostics,
          };
        }
        // A token-limit stop still completes, but never silently: the truncation
        // is marked on the final message (below) and in the diagnostics.
        truncated = last?.stopReason === "length";
        if (truncated && !truncationDiagnosed) {
          truncationDiagnosed = true;
          diagnostics.push({
            severity: "warning",
            message: `subagent reply hit the model's output token limit (stop reason "length"); the returned message is truncated`,
          });
        }
        return undefined;
      };

      await session.prompt(fullPrompt);
      {
        const terminal = terminalOutcome();
        if (terminal) return terminal;
      }

      // Verbatim final assistant message (hard contract — no wrapping/summarizing).
      let finalMessage = lastAssistantText(session);

      // One-retry-on-empty convention: a single re-prompt when nothing
      // came back — only for genuinely successful empty stops. Error/abort stops
      // returned above (retrying them just repeated the failure and doubled latency).
      if (!finalMessage.trim()) {
        await session.prompt(
          "Your previous reply was empty. Reply now with your final answer in the requested format.",
        );
        const terminal = terminalOutcome();
        if (terminal) return terminal;
        finalMessage = lastAssistantText(session);
        diagnostics.push({ severity: "info", message: "subagent returned empty; retried once" });
      }

      // SubagentStop validation loop ("don't stop until validated"):
      // a blocking hook re-prompts the subagent with its reason, bounded like the
      // main-session Stop loop.
      for (let iteration = 0; ; iteration++) {
        const stopOutcome = await fireSubagentStop({
          subagent_type: agent.name,
          cwd: subCwd.get(),
          stop_hook_active: iteration > 0,
        });
        stopFired = true;
        if (opts.abortSignal?.aborted) {
          // Abort-race consistency: a signal firing during
          // SubagentStop-hook evaluation classifies aborted — the same way a
          // signal firing while prompt() settles does (terminalOutcome). Aborted
          // results are discarded by contract, so breaking out to a
          // completed-looking result here would leak past the abort.
          settledOutcome = "aborted";
          return {
            ok: false,
            outcome: "aborted",
            finalMessage: "",
            agentId,
            transcriptPath,
            resumable,
            agentName: agent.name,
            worktreePath,
            isFork,
            usage: captureUsage(),
            error: `Subagent "${agent.name}" was aborted before completing its task.`,
            diagnostics,
          };
        }
        if (!stopOutcome?.block) break;
        if (iteration >= 3) {
          diagnostics.push({
            severity: "warning",
            message: `SubagentStop hook still blocking after ${iteration} continuation(s): ${stopOutcome.blockReason ?? "(no reason)"}`,
          });
          break;
        }
        await session.prompt(
          `[SubagentStop hook] Continue working: ${stopOutcome.blockReason ?? "the stop condition is not met yet"}`,
        );
        const terminal = terminalOutcome();
        if (terminal) return terminal;
        finalMessage = lastAssistantText(session);
      }

      // A truncated completion ends with the cut-off frame; `cutOff` records
      // that so the model-visible ID trailer rides INSIDE that frame instead of
      // opening a second `---` frame.
      const cutOff = truncated && finalMessage.trim() !== "";
      if (cutOff) {
        finalMessage = appendCutOffNote(
          finalMessage,
          `The reply was truncated at the model's output token limit (stop reason "length"); the output above may be incomplete.`,
        );
      }
      settledOutcome = "completed";
      settledFinalText = finalMessage;
      return {
        ok: true,
        outcome: "completed",
        finalMessage,
        agentId,
        transcriptPath,
        resumable,
        truncated: cutOff,
        isFork,
        agentName: agent.name,
        worktreePath,
        usage: captureUsage(),
        diagnostics,
      };
    } catch (err) {
      // Catch-all: covers createAgentSession itself throwing — the "API dead
      // before the session exists" case — and any other dispatch-internal error.
      // Conservative: not resumable (the session may never have run), but the
      // transcript path (when one was allocated) stays visible for diagnosis.
      settledOutcome = "failed";
      return {
        ok: false,
        outcome: "failed",
        finalMessage: "",
        agentId,
        transcriptPath,
        resumable: false,
        isFork,
        agentName: agent.name,
        worktreePath,
        // Partial usage when the session ran at all before throwing.
        usage: captureUsage(),
        error: `Subagent "${agent.name}" failed: ${capErrorText((err as Error)?.message ?? String(err))}`,
        diagnostics,
      };
    } finally {
      if (abortListener && opts.abortSignal) {
        try {
          opts.abortSignal.removeEventListener("abort", abortListener);
        } catch {
          // floor
        }
      }
      try {
        progressUnsub?.();
      } catch {
        // unsubscribe must not mask results
      }
      // Usage safety-net: capture stats one last time while the session is
      // still alive (before dispose), so the registry record carries usage even
      // if some future return path forgets to capture. Idempotent with the
      // per-return captures above (same session, same value).
      captureUsage();
      try {
        session?.dispose();
      } catch {
        // dispose failures must not mask results
      }
      // Dispatch registry: the session is disposed — drop the live
      // handle and flip the record to settled, keeping name/ID/state/transcript-
      // path so a later SendMessage can still resume it, and recording the run's
      // fate + per-subagent usage for the /usage control command. No-op for
      // never-registered ids.
      this.deps.subagentRegistry?.markSettled(agentId, {
        outcome: settledOutcome,
        usage: capturedUsage,
        // Sanitized+capped by the registry; conversation content, never for
        // error/log interpolation.
        finalText: settledFinalText,
      });
      if (worktreePath && this.deps.worktrees && !opts.resume) {
        // Keep the worktree (the project's own merge flow owns its lifecycle); just unlock.
        // On resume we reused an existing worktree we never entered — leave its lock alone.
        await this.deps.worktrees.exit({ worktreePath, action: "keep" }).catch(() => undefined);
      }
      if (started && !stopFired) {
        // Error paths still fire SubagentStop once (informational; block is moot here).
        await fireSubagentStop({
          subagent_type: agent.name,
          cwd: this.deps.getCwd(),
        }).catch(() => undefined);
      }
      release();
    }
  }
}

function lastAssistantText(session: PiSession): string {
  const last = lastAssistantMessage(session);
  return last ? extractText(last.content) : "";
}

function lastAssistantMessage(session: PiSession): PiSessionMessage | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i]!.role === "assistant") return session.messages[i];
  }
  return undefined;
}

/**
 * Best-effort partial output of a failed run: the concatenated text of all
 * assistant turns (blank-line separated). The dying turn usually has no text;
 * when it does, that partial streamed text is preserved too.
 */
function assistantTextSoFar(session: PiSession): string {
  return session.messages
    .filter((m) => m.role === "assistant")
    .map((m) => extractText(m.content))
    .filter((t) => t.trim())
    .join("\n\n");
}

/** Model-visible error text stays short: capped ~500 chars, never enriched. */
const ERROR_TEXT_CAP = 500;

/**
 * Single-line, capped error text for the model-visible channel. Control
 * characters and whitespace runs collapse to single spaces so a
 * provider-controlled errorMessage cannot fabricate a multi-line fake
 * cut-off frame. Mirrored in background-tasks.ts (kept local there to avoid
 * a value-level import of this module).
 */
function capErrorText(message: string): string {
  const flat = message.replace(/[\s\p{Cc}]+/gu, " ").trim();
  return flat.length > ERROR_TEXT_CAP
    ? `${flat.slice(0, ERROR_TEXT_CAP)} [truncated]`
    : flat;
}

/**
 * The cut-off-note mechanism: partial/truncated subagent output followed
 * by a clearly separated note naming the cause. The note is the ONLY error text
 * ever mixed into the otherwise-verbatim message channel. Exported so
 * the fork presentation path can produce a byte-identical frame.
 */
export function appendCutOffNote(text: string, note: string): string {
  return `${text.replace(/\s+$/, "")}\n\n---\n[subagent cut off] ${note}`;
}

/**
 * The default cut-off note: used when a failed run carries partial output but
 * no explicit error string. Reproduces the Agent tool's inline wording verbatim
 * so the fork path stays byte-identical.
 */
const DEFAULT_CUT_OFF_NOTE = "The run ended on an API error before completing.";

/**
 * The user-facing presentation of a {@link DispatchResult}. A
 * `result` is returned/folded into content text (carrying `cutOff`); a
 * `failure` is thrown or folded into an error channel. The `text`/`message`
 * already carry any resume trailer and cut-off frame — the consumer owns only
 * the surrounding `details` (identity/usage/outcome/error) and the actual
 * throw-vs-return plumbing.
 */
export type DispatchPresentation =
  | { kind: "result"; text: string; cutOff: boolean }
  | { kind: "failure"; message: string };

/**
 * Map a {@link DispatchResult} to its user-facing {@link DispatchPresentation},
 * reproducing the `Agent` tool's four-branch mapping exactly:
 * completed / failed-with-partial / failed-no-output / aborted.
 *
 * TOTAL & pure: returns a presentation for every result and never throws (reads
 * `finalMessage` defensively). Does NOT re-apply `capErrorText` — `result.error`
 * arrives pre-capped from dispatch construction, so re-capping would double-cap
 * and could corrupt the verbatim channel.
 *
 * `allowResumeTrailer` (default `true`) gates the resume trailer on top of
 * `result.resumable`; passing `false` suppresses every trailer regardless of
 * resumability (forks are non-resumable — the fork path passes `false`).
 */
export function presentDispatchResult(
  result: DispatchResult,
  opts?: { allowResumeTrailer?: boolean },
): DispatchPresentation {
  const withTrailer = result.resumable && opts?.allowResumeTrailer !== false;
  const finalMessage = result.finalMessage ?? "";

  // failed WITH partial output → SUCCESS-shaped result: the partial output plus
  // a clearly separated cut-off note naming the error. A resumable agent's ID
  // rides in the same frame (single `\n`, non-"completed" wording).
  if (result.outcome === "failed" && finalMessage.trim()) {
    const cut = appendCutOffNote(finalMessage, result.error ?? DEFAULT_CUT_OFF_NOTE);
    return {
      kind: "result",
      text: withTrailer
        ? `${cut}\n${agentTrailerLine(result.agentId, { completed: false })}`
        : cut,
      cutOff: true,
    };
  }

  // failed with no partial output, or aborted → surface as a failure. A
  // resumable FAILED-with-no-partial run still delivers its agent ID; aborted
  // and non-resumable failures carry no trailer (aborted's ternary requires
  // outcome === "failed").
  if (!result.ok) {
    const base = result.error ?? "subagent failed";
    return {
      kind: "failure",
      message:
        result.outcome === "failed" && withTrailer
          ? `${base}${agentTrailerFrame(result.agentId, { completed: false })}`
          : base,
    };
  }

  // completed → the verbatim final message. Resumable completions append a
  // trailer OUTSIDE the verbatim channel; a truncated completion already ends
  // with a `---` cut-off frame, so the trailer rides INSIDE it (single `\n`,
  // non-"completed" wording) rather than stacking a second frame.
  let text: string;
  if (!withTrailer) {
    text = finalMessage;
  } else if (result.truncated) {
    text = `${finalMessage}\n${agentTrailerLine(result.agentId, { completed: false })}`;
  } else {
    text = `${finalMessage}${agentTrailerFrame(result.agentId, { completed: true })}`;
  }
  return { kind: "result", text, cutOff: result.truncated === true };
}

/**
 * Best-effort `maxTurns` enforcement: Pi sessions have no
 * turn-cap option, so past the cap every further tool call is blocked with an
 * instruction to answer — the subagent can still produce its final message.
 */
function createMaxTurnsExtension(maxTurns: number, diagnostics: Diagnostic[]) {
  return (pi: { on(event: string, handler: (event: any, ctx: any) => unknown): void }) => {
    let turns = 0;
    let reported = false;
    pi.on("turn_start", () => {
      turns++;
    });
    pi.on("tool_call", () => {
      if (turns <= maxTurns) return undefined;
      if (!reported) {
        reported = true;
        diagnostics.push({
          severity: "warning",
          message: `maxTurns (${maxTurns}) reached; further tool calls blocked`,
        });
      }
      return {
        block: true,
        reason: `maxTurns (${maxTurns}) reached — stop using tools and reply now with your final answer.`,
      };
    });
  };
}

/** The `Agent` dispatch tool definition (Claude-compatible; also registered as `Task`). */
export function createAgentToolDefinition(
  runtime: SubagentRuntime,
  opts: {
    depth: number;
    name?: string;
    backgroundTasks?: BackgroundTaskRegistry;
    /**
     * The DISPATCHER's own agent id: when this Agent tool is handed to
     * a subagent, tasks it starts in the background are tagged with this owner so
     * the subagent's scoped TaskOutput/TaskStop can reach them (and nobody else's
     * can). Undefined for the coordinator instance — its tasks stay
     * coordinator-owned (`owner: undefined`, reachable only via the full registry).
     */
    ownerAgentId?: string;
    /**
     * Runtime-set fork-spawns-fork marker: true iff the dispatcher that
     * was granted THIS Agent/Task tool is a genuinely-inheriting fork. Carried onto
     * every dispatch this tool makes (both background and foreground arms) so a
     * nested `subagent_type: "fork"` is refused. Undefined for the coordinator and
     * for normal (non-fork) subagents. Never sourced from a tool parameter.
     */
    dispatcherIsFork?: boolean;
  },
): Record<string, unknown> {
  return {
    name: opts.name ?? "Agent",
    label: "Agent",
    description:
      "Launch a subagent to handle a task. Pick subagent_type from the 'Available subagents' catalog by matching the task to the agent descriptions (omit it for a general-purpose agent). Subagents run in the background by default: the call returns a task id immediately and runs concurrently with any other dispatch in this turn, so collect the result with TaskOutput before you rely on it or finalize an answer. If the latest task generation for an agent settles and remains uncollected and unnotified when a later interactive turn starts, it gets one bounded notice; a running TaskOutput poll preserves eligibility, while terminal collection suppresses a not-yet-sent notice. Pass run_in_background: false for a synchronous run that blocks this turn and returns the subagent's final message verbatim inline.",
    parameters: Type.Object({
      subagent_type: Type.String({ description: "Name of the agent to dispatch" }),
      prompt: Type.String({ description: "The task for the subagent" }),
      model: Type.Optional(
        Type.String({ description: "Model override as provider/model (rarely needed)" }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description:
            "Background is the default: omit (or pass true) to background the dispatch — it returns a task id immediately, to be collected with TaskOutput. The latest generation gets one bounded later-interactive-turn notice only if it settles and remains uncollected and unnotified; a running poll preserves eligibility, while terminal collection suppresses a not-yet-sent notice. Pass false for a synchronous run that blocks this turn and returns the final message inline.",
        }),
      ),
      description: Type.Optional(
        Type.String({
          description:
            "Short (3-5 word) human-readable task label, shown in the UI while the subagent runs (e.g. \"Review auth changes\")",
        }),
      ),
    }),
    // Dispatch-time display: show WHICH agent and WHAT it was asked, at
    // call time — replacing Pi's bare bold "Agent" fallback. Cheap and
    // model-independent. Returns a structural pi-tui Component ({ render });
    // guarded so it can never throw into the render loop.
    renderCall(args: Record<string, unknown>, theme: unknown) {
      return renderAgentCall(args, theme);
    },
    // Result display (REQUIRED): Pi's fallback renders only result text, so
    // without this the outcome badge, agent ID, transcript path, and usage
    // would be invisible. Also renders the live rolling tail for partial
    // (streaming) results. Renders defensively when optional fields are absent.
    renderResult(
      result: { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> },
      options: { expanded?: boolean; isPartial?: boolean },
      theme: unknown,
    ) {
      return renderAgentResult(result, options, theme);
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (update: {
        content: Array<{ type: string; text: string }>;
        details?: Record<string, unknown>;
      }) => void,
    ) {
      const subagentType = String(params.subagent_type ?? "");
      // Capture-time sanitization: the model-supplied
      // subagent_type becomes the displayed label/agentType — it rides into the
      // start message, tool details, and the background task record, so it is a
      // single sanitized line from here on (render-time defense stays too).
      const label = sanitizeLine(subagentType, CAPTURED_LINE_CAP) || "general-purpose";
      // Model-supplied task label for the registry record (the panel's label
      // column) — sanitized at capture, before it is threaded anywhere.
      const description =
        sanitizeLine(String(params.description ?? ""), CAPTURED_LINE_CAP) || undefined;
      const dispatchOpts = {
        subagentType,
        prompt: String(params.prompt ?? ""),
        model: params.model ? String(params.model) : undefined,
        depth: opts.depth + 1,
        // Propagate the runtime-set marker onto EVERY dispatch this tool
        // makes (spread into both the background and foreground arms below), so a
        // fork's own Agent/Task tool refuses a nested `subagent_type: "fork"`.
        dispatcherIsFork: opts.dispatcherIsFork,
        // Parent link for the panel tree: the dispatcher's own id (undefined
        // for the coordinator) — the same runtime-set channel as ownerAgentId,
        // never a tool parameter.
        parentAgentId: opts.ownerAgentId,
        description,
      };
      const backgroundDisabled = isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);
      // Background-by-default (Claude 2.1.198+): a dispatch backgrounds
      // unless it explicitly opts out with `run_in_background: false`. Precedence
      // ladder (with the env gate below): CLAUDE_CODE_DISABLE_BACKGROUND_TASKS >
      // `background: true` frontmatter > explicit `run_in_background` > default
      // (background). Only the frontmatter-beats-explicit-false rung is
      // Claude-parity-verified (`background: true` = "always run in the
      // background even when Claude needs the result"); the env-over-everything
      // top rung is pre-existing PiCC behaviour this feature preserves, not a
      // documented Claude semantic. `isBg` is hoisted because the intent-split
      // note below reuses it.
      const isBg = runtime.isBackgroundAgent(subagentType);
      const wantsBackground = isBg || params.run_in_background !== false;
      // Degrade-note intent: the "background requested but ran foreground" note
      // keys on EXPLICIT background intent only, so a merely-defaulted dispatch
      // that ends up foreground (disable-env, or a
      // caller with no background registry wired) never falsely claims background
      // was requested. `wantsBackground` drives routing; this drives the note.
      const explicitBackgroundIntent = params.run_in_background === true || isBg;
      if (wantsBackground && !backgroundDisabled && opts.backgroundTasks) {
        // Real background execution: the un-awaited dispatch still
        // takes its concurrency slot and fires SubagentStart/Stop hooks; the
        // registry owns its settlement (never an unhandled rejection).
        const controller = new AbortController();
        // Pre-minted agent ID: the start message is the background
        // channel's guaranteed model-visible ID delivery, so it must exist
        // BEFORE the un-awaited dispatch settles.
        const agentId = mintAgentId();
        const registry = opts.backgroundTasks;
        // Live progress → task record: the same condensed activity that
        // drives the foreground UI updates a lightweight last-activity field so
        // TaskOutput shows the background subagent is alive. `taskId` is assigned
        // synchronously by start() below, long before any event fires.
        let taskId: string | undefined;
        // Hand the whole condensed snapshot to noteProgress, which stores it,
        // derives lastActivity, and fans out to any waiting TaskOutput subscriber.
        const onProgress = (snapshot: ProgressSnapshot) => {
          if (taskId) registry.noteProgress(taskId, snapshot);
        };
        const id = registry.start(
          `agent:${label}`,
          runtime.dispatch({
            ...dispatchOpts,
            // Nested background bound: mark this un-awaited dispatch as
            // background so a `depth > 1` fan-out acquires its per-depth budget
            // instead of taking the foreground bypass (which would be unbounded).
            background: true,
            agentId,
            abortSignal: controller.signal,
            onProgress,
          }),
          () => controller.abort(),
          agentId,
          label,
          // Owner tag: the dispatcher's id (a subagent's own id, or
          // undefined for the coordinator) so scoped TaskOutput/TaskStop reach
          // exactly the tasks that dispatcher started.
          opts.ownerAgentId,
        );
        taskId = id;
        // Identity-at-start: the agent id appears for EVERY background
        // task — including one-shot builtins (Explore/Plan) — since the
        // start-message is the only model-visible id delivery in print/RPC mode.
        return {
          content: [
            {
              type: "text",
              text: `Background task ${id} started (agent: ${label}, agent id: ${agentId}). Use TaskOutput with task_id "${id}" to retrieve the result before finalizing.`,
            },
          ],
          details: { background: true, taskId: id, agent: label, agentId },
        };
      }
      // Foreground: Pi's per-call signal (parent Esc) aborts the dispatch.
      // Live progress: stream the child's condensed, sanitized activity
      // through Pi's onUpdate partial-result channel (works in interactive AND
      // print/RPC modes — no ctx.ui dependency). Display-only: this text never
      // enters `finalMessage` (the returned content below is authoritative).
      const onProgress = onUpdate
        ? (snapshot: ProgressSnapshot) => {
            onUpdate({
              content: [{ type: "text", text: renderProgressText(snapshot) }],
              details: { subagentProgress: snapshot, agent: label, live: true },
            });
          }
        : undefined;
      const result = await runtime.dispatch({
        ...dispatchOpts,
        abortSignal: signal,
        onProgress,
      });
      // Structured copy of the identity fields for every content-returning path
      // (details is logs/UI-only — the model never sees it, hence the trailer).
      const identityDetails = {
        agentId: result.agentId,
        transcriptPath: result.transcriptPath,
        resumable: result.resumable,
        // Usage metadata: populates the renderResult footer usage line
        // (formatUsageLine → formatUsageCompact). details is logs/UI-only — never
        // the model-visible content, so the verbatim-return contract is untouched.
        usage: result.usage,
      };
      // Claude 2.1.200 outcome→presentation mapping: the text, cut-off frame,
      // resume trailer, and throw-vs-return decision all live in the shared,
      // pure `presentDispatchResult` helper — the fork path consumes the same
      // helper for byte-identical framing. `details`
      // (identity/usage/outcome/error/note) stays this consumer's job.
      const presentation = presentDispatchResult(result);
      if (presentation.kind === "failure") {
        // Failed with no output ("Agent terminated early due to an API error: ...",
        // or a pre-start failure naming its cause) and aborted runs (distinct
        // wording naming the abort) both surface on the isError channel.
        // A resumable FAILED-with-no-partial run still delivers its agent ID;
        // aborted and non-resumable failures carry no trailer.
        throw new Error(presentation.message);
      }
      // A `kind:"result"` with outcome "failed" is necessarily the cut-off case:
      // presentDispatchResult only routes failed-WITH-partial to `result` (aborted
      // and failed-no-output become `kind:"failure"` above). This mirrors the
      // helper's own branch guard — keep the two in sync if that guard changes.
      if (result.outcome === "failed") {
        // failed WITH partial output → success-shaped cut-off result: the partial
        // output plus a clearly separated cut-off note. A resumable agent's ID
        // rides in the same delimited frame: the coordinator can follow up on
        // the cut-off run via SendMessage.
        return {
          content: [{ type: "text", text: presentation.text }],
          details: {
            agent: result.agentName,
            worktreePath: result.worktreePath,
            diagnostics: result.diagnostics,
            outcome: result.outcome,
            cutOff: presentation.cutOff,
            error: result.error,
            ...identityDetails,
          },
        };
      }
      // Verbatim-return contract: callers parse finalMessage directly (often a
      // locked YAML block) — compatibility notes belong in details only.
      // Exception: resumable agents get a clearly
      // delimited agent-ID trailer OUTSIDE the verbatim message, in the content
      // the model actually reads — `details` never reaches it. When the
      // completion was truncated it already ends with a `---` cut-off frame, so
      // the trailer rides INSIDE that frame (single `\n`, non-"completed"
      // wording) rather than stacking a second frame.
      return {
        content: [{ type: "text", text: presentation.text }],
        details: {
          agent: result.agentName,
          worktreePath: result.worktreePath,
          diagnostics: result.diagnostics,
          outcome: result.outcome,
          // A turn-capped SUCCESS is truncated — surface it so the badge
          // renders `completed (truncated)` instead of a clean `● completed`
          // (`presentation.cutOff === result.truncated === true` on this path).
          cutOff: presentation.cutOff,
          ...identityDetails,
          // Visible-degrade note: key it on EXPLICIT background
          // intent — `run_in_background: true` OR a `background: true` frontmatter
          // agent (isBackgroundAgent) — NOT on wantsBackground, which is true
          // for every defaulted dispatch. So a
          // frontmatter-background agent (or an explicit run_in_background) forced
          // foreground (e.g. under CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, or with no
          // background registry wired) still surfaces the divergence — matching the
          // registry's forced-to-foreground divergence note — while a plain defaulted
          // dispatch that simply ran foreground does not falsely claim it.
          ...(explicitBackgroundIntent
            ? {
                note: backgroundDisabled
                  ? "background tasks are disabled (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS); the background dispatch (run_in_background or a background:true agent) ran in foreground"
                  : "background dispatch (run_in_background or a background:true agent) requested but no background task registry is wired; ran in foreground",
              }
            : {}),
        },
      };
    },
  };
}

/**
 * The `SendMessage` tool: the coordinator's channel back into its subagents.
 * Addressing is by agent ID or name (`to`), resolved EXCLUSIVELY against the
 * in-memory dispatch registry (SECURITY — a hostile `to` never touches the
 * filesystem). Two deliveries:
 *  - A still-running BACKGROUND subagent → the message is steered in as a
 *    mid-task course correction (`AgentSession.steer`); an ack is returned. (A
 *    foreground Agent call blocks the parent's turn, so steering de-facto reaches
 *    only background dispatches — by design, not a defect.)
 *  - A FINISHED subagent → it resumes IN THE BACKGROUND under the SAME agent ID
 *    with its full prior context, via a full re-dispatch through
 *    `SubagentRuntime.dispatch({ resume })` (SECURITY — the entire
 *    enforcement stack is re-applied because it is the identical construction
 *    path). The tool returns an immediate ack; the run's outcome is available
 *    via TaskOutput (and, while eligible/current/uncollected, a bounded notice).
 *
 * Parent-initiated ONLY: this tool is NEVER added to subagent toolsets
 * (`customToolsFor`) — no subagent→subagent or subagent→parent messaging. The
 * message content is delivered VERBATIM as user-role task direction; an agent
 * message is never a permission approval (the permission engine still gates
 * every tool the resumed/steered agent runs — no parallel approval path here).
 */
export function createSendMessageToolDefinition(
  runtime: SubagentRuntime,
  opts: { registry: SubagentRegistry; backgroundTasks: BackgroundTaskRegistry },
): Record<string, unknown> {
  return {
    name: "SendMessage",
    label: "SendMessage",
    description:
      "Send a follow-up message to a subagent you previously dispatched. Address it by its agent id (agent-…) or name (`to`). A finished subagent resumes in the background under the same id with its full prior context; a still-running background subagent receives the message as a mid-task course correction. Returns an acknowledgment; a resumed run's result arrives via TaskOutput.",
    parameters: Type.Object({
      to: Type.String({
        description: "Agent id (e.g. agent-3fa9c2d1b4e5) or the agent name from a prior dispatch",
      }),
      message: Type.String({
        description: "The follow-up instruction, delivered to the agent verbatim as a user turn",
      }),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const to = String(params.to ?? "");
      const message = String(params.message ?? "");
      if (!message.trim()) {
        throw new Error("SendMessage requires a non-empty `message` to deliver.");
      }
      // SECURITY: registry-only resolution — pure in-memory Map
      // lookups. A hostile `to` (`..`, separators, absolute path) is neither a
      // minted agent id nor a registered name → clean miss, no filesystem touch.
      const resolved = opts.registry.resolve(to);
      if (!resolved.ok) throw new Error(resolved.error);
      const record = resolved.record;

      // Running background dispatch → steer (mid-task course correction). The
      // refusal predicates (one-shot, user-stopped, no live steerable handle)
      // live in the shared guardSteer — the same guard the panel drill-down
      // steer calls — so the two surfaces cannot drift.
      if (record.state === "running") {
        const guard = guardSteer(record);
        if (!guard.ok) throw new Error(guard.refusal);
        await Promise.resolve(guard.steer(message));
        return {
          content: [
            {
              type: "text",
              text: `Message delivered to running agent ${record.agentId} ("${record.agentName}") as a mid-task course correction.`,
            },
          ],
          details: { agentId: record.agentId, agent: record.agentName, delivery: "steer" },
        };
      }

      // One-shot builtins (Explore/Plan) refuse resume too (guardSteer already
      // refuses the steer arm above).
      if (record.oneShot) {
        throw new Error(oneShotRefusal(record));
      }

      // A USER stop is permanent: the resume seam refuses it here (the steer
      // seam is guardSteer above). Deliberately narrower than a model TaskStop,
      // which stays resumable — the registry-documented PiCC divergence
      // ("PiCC allows resume after TaskStop").
      if (record.userStopped) {
        throw new Error(userStoppedRefusal(record));
      }

      // Settled → resume. Refuse the non-resumable cleanly — never silently start
      // a fresh context-less run. Two shapes: no persisted transcript (in-memory
      // fallback / one-shot builtin) OR a persisted transcript that is still
      // non-resumable (a fork persists its inherited transcript but its
      // context — the parent conversation at fork time — cannot be safely
      // re-derived). Give each an honest reason (tests assert refusal, not wording).
      if (!record.resumable || !record.transcriptPath) {
        const reason = record.transcriptPath
          ? "its context cannot be safely re-derived (e.g. a fork's inherited parent conversation, or another non-resumable run)"
          : "it ran without a persisted transcript (print/no-session mode or a one-shot builtin)";
        throw new Error(
          `Agent ${record.agentId} ("${record.agentName}") is not resumable: ${reason}. Dispatch a new agent instead.`,
        );
      }

      // Reachability (registry-stored path — NOT the model `to`): the original
      // working directory / worktree must still exist, or the resumed run would
      // reopen against a missing checkout.
      const missing =
        record.worktreePath && !existsSyncSafe(record.worktreePath)
          ? record.worktreePath
          : !existsSyncSafe(record.cwd)
            ? record.cwd
            : undefined;
      if (missing) {
        throw new Error(
          `Agent ${record.agentId} ("${record.agentName}") is unreachable: its working directory ${JSON.stringify(
            missing,
          )} no longer exists (the worktree may have been merged or removed). Dispatch a new agent instead.`,
        );
      }

      // Resume: flip the record to running eagerly (Claude 2.1.205 synchronous
      // status flip; re-arms notice eligibility, subject to collection and
      // newest-generation checks), then re-dispatch in the
      // BACKGROUND under the SAME agent id through the shared construction path.
      // Between this markResuming and the re-dispatch's session-creation
      // register(), the record is running with no live session handle — a second
      // concurrent SendMessage in that window hits the "running but not yet
      // steerable" refusal (transient, by design).
      opts.registry.markResuming(record.agentId);
      const controller = new AbortController();
      let taskId: string | undefined;
      const onProgress = (snapshot: ProgressSnapshot) => {
        if (taskId) opts.backgroundTasks.noteProgress(taskId, snapshot);
      };
      // Capture-time sanitization: record.agentName flows into the
      // background record's label/agentType here — a single sanitized line.
      const agentLabel = sanitizeLine(record.agentName, CAPTURED_LINE_CAP) || "subagent";
      const id = opts.backgroundTasks.start(
        `agent:${agentLabel}`,
        runtime.dispatch({
          subagentType: record.agentName,
          prompt: message,
          depth: record.depth,
          // Nested background bound: a SendMessage resume is always
          // background. It is REQUIRED here, not optional — SendMessage is
          // parent-initiated only, so the common resumable agent is depth-1
          // (acquires its root pool regardless), but a grandchild id that bubbled
          // to the root is resumable at `record.depth ≥ 2` and would otherwise hit
          // `depth > 1 && !background` → the foreground bypass → an unbounded
          // escape from the nested bound. Deadlock-free: the only waiter is root,
          // which holds no slot.
          background: true,
          agentId: record.agentId,
          resume: {
            transcriptPath: record.transcriptPath,
            cwd: record.cwd,
            worktreePath: record.worktreePath,
          },
          abortSignal: controller.signal,
          onProgress,
        }),
        () => controller.abort(),
        record.agentId,
        agentLabel,
      );
      taskId = id;
      const identity = formatBackgroundTaskIdentity(id, record.agentName, record.agentId);
      return {
        content: [
          {
            type: "text",
            text: `${identity} — resume started in background with prior context; result pending. Retrieve it with TaskOutput (task_id "${id}").`,
          },
        ],
        details: {
          agentId: record.agentId,
          agent: record.agentName,
          taskId: id,
          delivery: "resume",
          resumed: true,
        },
      };
    },
  };
}

/** `fs.existsSync` that never throws (a permission error must not crash the tool). */
function existsSyncSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

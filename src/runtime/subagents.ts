import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  ClaudeAgent,
  Diagnostic,
  HookConfig,
  HookOutcome,
  HookPayload,
  ToolCallDescriptor,
} from "../types.js";
import { mergeHookOutcomes, type HookRunner, type HookRunnerLike } from "../engine/hook-runner.js";
import { PermissionEngine } from "../engine/permissions.js";
import { builtinAgents, resolveAgent } from "../claude/agents.js";
import { parseHookConfig } from "../claude/hooks.js";
import { claudeToolsToPiBuiltins } from "./tool-map.js";
import { createGuardExtension } from "./guard.js";
import { registerCodexAbortGuard } from "./codex-abort-guard.js";
import { CwdState } from "./cwd-state.js";
import { findByName } from "../project.js";
import type { BackgroundTaskRegistry, UsageLike } from "./background-tasks.js";
import type {
  SteerableSession,
  SubagentAdmission,
  SubagentRegistry,
  SubagentRegistryRecord,
  SubagentUsage,
  SubagentMessageSource,
  ActiveCheckpointStopEligibility,
  CheckpointStopAttemptIdentity,
  CheckpointStopTerminalEvidence,
} from "./subagent-registry.js";
import {
  formatRetainedInputReport,
  guardSteer,
  oneShotRefusal,
  retainedInputCount,
  taskOutputAgentLocator,
  userStoppedRefusal,
} from "./subagent-registry.js";
import {
  agentTrailerFrame,
  agentTrailerLine,
  FORK_DEGRADE_PREFIX,
  isAgentId,
  mintAgentId,
  prepareSubagentTranscriptCollection,
  type PrepareSubagentTranscriptCollectionResult,
} from "../util/subagent-transcripts.js";
import {
  renderProgressText,
  sanitizeLine,
  SubagentProgressCondenser,
  type ProgressSnapshot,
  type SnapshotUsage,
} from "./subagent-progress.js";
import {
  renderAgentCall,
  renderAgentResult,
  renderSendMessageCall,
  renderSendMessageResult,
  rememberSendMessageResult,
  type SubagentLifecycleRenderContext,
  type SubagentRenderDetails,
} from "./subagent-render.js";
import { formatBackgroundTaskIdentity } from "./background-identity.js";
import { buildStockBuiltinTools, type BuiltinToolSdk } from "./builtin-tools.js";
import {
  NOTEBOOK_SESSION_CUSTOM_TYPE,
  NotebookSessionState,
  newestNotebookSessionSnapshot,
  type SerializedNotebookSession,
} from "./notebook-session.js";
import {
  MainSessionCheckpointGate,
  promiseCompactionAttempt,
  type CancelledInputHandoff,
  type CancelledInputResolution,
  type CancellationKind,
  type CheckpointProgress,
  type HostDeadlinePolicy,
  type HostInputClass,
  type HostInputLease,
  type MidRunCompactionController,
  type QueuedInputShadow,
  type ResumeContext,
  type ResumeToken,
  type RetainedInputOccurrenceEnvelope,
} from "./mid-run-compaction.js";
import {
  createRetainedInputReport,
  type RetainedInputReport,
} from "./retained-input-report.js";
import {
  budgetSkillReinjection,
  newSkillActivationState,
  type SkillActivationState,
} from "./skill-activation.js";
import {
  formatSubagentRecoveryGuidance,
  SubagentRecoveryProgress,
  type SubagentRecoveryDisposition,
} from "./subagent-recovery.js";

/**
 * Subagent dispatch runtime: spawns fresh-context Pi sessions per dispatch,
 * parallel fan-out under a concurrency cap, per-agent tools:/model/effort, configurable
 * nesting depth, optional worktree isolation, and VERBATIM final-message return
 * (skills parse the final message — often locked YAML — directly; hard contract).
 */

export const TRANSCRIPT_OWNERSHIP_RECOVERY_GUIDANCE =
  "Preserve or back up any existing transcript data and collections. Never edit or delete an ownership marker by hand. Start a new main session before retrying future persisted subagents, and review old transcript data separately.";

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

export type SubagentCustomToolsFactory = (
  agent: ClaudeAgent,
  grantedClaudeNames: string[],
  depth: number,
  ownerAgentId: string,
  dispatcherIsFork: boolean,
  subCwd: CwdState | undefined,
  notebookSession: NotebookSessionState,
  activation: SkillActivationState,
  captureUniversalStop?: () => () => boolean,
) => unknown[];

export interface SubagentRuntimeDeps {
  getAgents: () => ClaudeAgent[];
  /** Project and validate an agent before session/resource construction. */
  prepareAgent?: (agent: ClaudeAgent) => ClaudeAgent;
  /** Assemble the subagent's system prompt: agent body + CLAUDE.md/rules hierarchy + env. */
  buildSystemPrompt: (
    agent: ClaudeAgent,
    depth?: number,
    diagnosticSink?: (diagnostic: Diagnostic) => void,
  ) => string;
  /** Immediate headless diagnostic surface; TUI consumes dispatch details instead. */
  surfaceHeadlessDiagnostic?: (diagnostic: Diagnostic) => void;
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
   * `notebookSession` is the dispatch-owned state shared by this child's Read and
   * NotebookEdit tools; it is never reconstructed by the factory.
   */
  customToolsFor: SubagentCustomToolsFactory;
  /** All Claude tool names the harness knows (for gateTools' allKnown). */
  allKnownToolNames: () => string[];
  permissionEngine: PermissionEngine;
  hookRunner: HookRunner;
  getCwd: () => string;
  /**
   * The project's configured environment (`project.settings.env`), fed to the
   * shared built-in factory so a subagent's bash subprocess receives the same
   * env the main session's bash does. OPTIONAL with a `{}` default so the
   * fake `makeSubagentRuntime` and any hand-built deps literal don't break.
   */
  settingsEnv?: Record<string, string | undefined>;
  /**
   * Absolute project root, injected as `CLAUDE_PROJECT_DIR` into subagent bash.
   * OPTIONAL; defaults to the dispatch cwd when unset.
   */
  projectRoot?: string;
  /**
   * Pinned Git-Bash path on Windows (from `resolveGitBashPath`), applied to the
   * subagent built-in bash tool by the shared factory. OPTIONAL/absent elsewhere.
   */
  shellPath?: string;
  /**
   * Per-text-block token budget above which a single tool result is clipped, fed
   * into every subagent's guard so the backstop covers subagent/Task/MCP outputs
   * too. `PiCCConfig` is not in scope at the subagent guard-install site, so the
   * resolved value (`config.compaction.clipMaxTokens`) is threaded here. OPTIONAL;
   * when unset the clip simply does not run for subagents.
   */
  clipMaxTokens?: number;
  /** Child sessions use the same resolved proactive threshold as the main session. */
  proactiveCompactPercent?: number;
  /** Dormant until production composes canonical post-compaction cancellation custody. */
  compactionCancellationRecovery?: {
    registry: SubagentRegistry;
    /** Deterministic deadline seam used by focused child lifecycle tests. */
    deadlinePolicy?: HostDeadlinePolicy;
    /** Test observation seam after trigger ownership is scheduled but before SDK invocation. */
    onTriggerScheduledForTest?: () => void;
    /** Observe canonical-store ordering without exposing child controller ownership in production. */
    onCanonicalStoreForTest?: (stored: boolean, controller: MidRunCompactionController) => void;
    /** Observe controller progress ordering even when ordinary stopped-run presentation is suppressed. */
    onControllerProgressForTest?: (event: CheckpointProgress, controller: MidRunCompactionController) => void;
  };
  /**
   * Preferred: builds a PER-DISPATCH context injector with its own fresh injection
   * state. Sharing the parent's injector would let a subagent's file touches consume
   * the orchestrator's one-shot nested-CLAUDE.md/path-rule injections (and vice versa).
   */
  makeContextInjector?: (getCwd: () => string) => {
    inject: (filePath: string) => string | undefined;
    reset: () => void;
  };
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
  makeScopedHookRunner?: (config: HookConfig) => HookRunnerLike;
  /**
   * MAIN session transcript file (late-bound; undefined in print/no-session
   * modes and tests). Subagent transcripts persist in a sibling directory
   * derived from it; without it, dispatch degrades to in-memory.
   */
  getMainSessionFile?: () => string | undefined;
  /** Test-only seam; production validates and marks ownership before either persistence factory runs. */
  prepareTranscriptCollection?: (mainSessionFile: string) => PrepareSubagentTranscriptCollectionResult;
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
  getBranch?(): unknown;
  appendCustomEntry?(customType: string, data: SerializedNotebookSession): unknown;
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
 * `SubagentUsage` (subagent-registry), and `SnapshotUsage` (subagent-progress)
 * are byte-identical by intent but kept in four files to preserve those
 * modules' no-value-import relationship. This compile-time assertion breaks
 * `tsc` the moment any of them gains, loses, or retypes a field without the
 * others — key drift is caught by the mutual `keyof` containment, field-type
 * drift by the mutual assignability. Type-only (the imports above are
 * `import type`, erased at runtime — no cycle).
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
  _SameShape<DispatchUsage, SubagentUsage> &
  _SameShape<DispatchUsage, SnapshotUsage>;
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

/**
 * PiSdk also mirrors {@link BuiltinToolSdk}'s built-in tool constructors, but as
 * OPTIONAL members (via `Partial`) so the checked fake-sdk literal and any
 * un-wired fake still satisfy the interface. The subagent path narrows/asserts
 * the handle to the required `BuiltinToolSdk` before calling
 * `buildStockBuiltinTools`.
 *
 * This mirror is hand-maintained: the main path passes the raw Pi import
 * directly, so a newly-added built-in must be added to `loadRealSdk` by hand. That
 * is loud-fail plumbing (`undefined is not a function`), NOT a semantic-drift
 * surface — both paths still call the SAME factory, so tool *semantics* stay
 * single-owned.
 */
export interface PiSdk extends Partial<BuiltinToolSdk> {
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
  getContextUsage?(): { percent?: number; tokens?: number; contextWindow?: number } | undefined;
  compact?(customInstructions?: string): Promise<unknown>;
  abortCompaction?(): void;
  sendCustomMessage?(
    message: { customType: string; content: unknown; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void>;
  clearQueue?(): { steering: unknown[]; followUp: unknown[] };
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
  /** True when exhaustion retained this exact live guarded session for recovery/stop. */
  checkpointPaused?: boolean;
  /** Structured custody for input left undelivered by a settled resumed cancellation. */
  retainedInputReport?: RetainedInputReport;
  /** True only for an ordinary terminal assistant error after the session ran. */
  terminalAssistantError?: true;
  /** State-aware recovery advice for an ordinary transient-category terminal failure. */
  recoveryDisposition?: SubagentRecoveryDisposition;
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
    // Git-Bash pin — DEGRADE BACKSTOP, not the primary owner. The single owner of
    // the builtin bash tool's Windows Git-Bash pin is the shared factory
    // (buildStockBuiltinTools, threaded `shellPath`): that factory bash shadows the
    // SDK's stock bash BY NAME, so this settings-manager `shellPath` no longer
    // reaches the tool the model actually calls. It backs only the SDK-INTERNAL /
    // `!`-shell path (which still resolves through the settings manager). The
    // factory's `shellPath` threading is covered by the win32 shared-factory
    // bash-options unit test; the end-to-end proof that subagent bash resolves Git
    // Bash on Windows is the real-stack subagent e2e. Keep this line as an explicit
    // backstop for the `!`-shell path, do not delete it.
    inMemorySettingsManager: () =>
      m.SettingsManager.inMemory({
        compaction: { enabled: true },
        ...(shellPath ? { shellPath } : {}),
      }),
    agentDir: () => m.getAgentDir(),
    // Built-in tool constructors (hand-maintained mirror; see PiSdk doc). Exposed
    // so the shared factory (buildStockBuiltinTools) can build the subagent path's
    // built-ins from the same source the main session uses.
    createBashTool: (cwd: string, options: unknown) => m.createBashTool(cwd, options),
    createReadTool: (cwd: string) => m.createReadTool(cwd),
    createWriteTool: (cwd: string) => m.createWriteTool(cwd),
    createEditTool: (cwd: string) => m.createEditTool(cwd),
    createGrepTool: (cwd: string) => m.createGrepTool(cwd),
    createFindTool: (cwd: string) => m.createFindTool(cwd),
    createLsTool: (cwd: string) => m.createLsTool(cwd),
    createBashToolDefinition: (cwd: string) => m.createBashToolDefinition(cwd),
    createReadToolDefinition: (cwd: string) => m.createReadToolDefinition(cwd),
    createWriteToolDefinition: (cwd: string) => m.createWriteToolDefinition(cwd),
    createEditToolDefinition: (cwd: string) => m.createEditToolDefinition(cwd),
    createGrepToolDefinition: (cwd: string) => m.createGrepToolDefinition(cwd),
    createFindToolDefinition: (cwd: string) => m.createFindToolDefinition(cwd),
    createLsToolDefinition: (cwd: string) => m.createLsToolDefinition(cwd),
  };
}

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async acquire(onAdmission?: (admission: SubagentAdmission) => void): Promise<() => void> {
    const notify = (admission: SubagentAdmission) => {
      try {
        onAdmission?.(admission);
      } catch {
        // Admission observers are metadata-only and never scheduler authority.
      }
    };
    if (this.active < this.limit) {
      this.active++;
      notify("admitted");
      return () => this.release();
    }
    return new Promise((resolve) => {
      const waiter = () => {
        this.active++;
        notify("admitted");
        resolve(() => this.release());
      };
      this.queue.push(waiter);
      notify("waiting");
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

/**
 * HookRunner-shaped facade multiplexing the session runner with an agent's
 * scoped runner — same pattern as index.ts's HookMultiplexer,
 * but per-dispatch and discarded with it.
 */
function multiplexHookRunners(base: HookRunnerLike, scoped: HookRunnerLike): HookRunnerLike {
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
  };
}

interface ChildDeferred<T = void> {
  promise: Promise<T>;
  resolve(value?: T): void;
  reject(reason?: unknown): void;
}

function childDeferred<T = void>(): ChildDeferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolvePromise = done;
    rejectPromise = fail;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value as T),
    reject: rejectPromise,
  };
}

const CHILD_SCOPED_HOOK_DIAGNOSTIC_CAP = 20;
const PRELOAD_DIAGNOSTIC_CAP = 20;

function createPreloadDiagnosticCollector(
  diagnostics: Diagnostic[],
  surfaceDiagnostic?: (diagnostic: Diagnostic) => void,
): (diagnostic: Diagnostic) => void {
  const fingerprints = new Set<string>();
  let saturated = false;
  const surface = (diagnostic: Diagnostic): void => {
    if (diagnostic.severity !== "warning" && diagnostic.severity !== "error") return;
    try {
      surfaceDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are additive observation and cannot change dispatch.
    }
  };
  return (diagnostic): void => {
    const safe: Diagnostic = {
      ...diagnostic,
      source: diagnostic.source === undefined ? undefined : sanitizeLine(diagnostic.source, 120),
      message: sanitizeLine(diagnostic.message, 500),
    };
    const fingerprint = `${safe.severity}:${safe.source ?? ""}:${safe.message}`;
    if (fingerprints.has(fingerprint)) return;
    if (fingerprints.size >= PRELOAD_DIAGNOSTIC_CAP) {
      if (!saturated) {
        saturated = true;
        const overflow: Diagnostic = {
          severity: "warning",
          source: "plugin skill preload",
          message: "Additional distinct plugin-skill preload diagnostics were suppressed.",
        };
        diagnostics.push(overflow);
        surface(overflow);
      }
      return;
    }
    fingerprints.add(fingerprint);
    diagnostics.push(safe);
    surface(safe);
  };
}

type RetainedCheckpointOwner = {
  recover: (text: string) => Promise<DispatchResult>;
  cleanup: (outcome: DispatchOutcome, finalText?: string) => Promise<void>;
  operation?: Promise<DispatchResult>;
  cleanupPromise?: Promise<void>;
  stopping: boolean;
};

/** Adapts one live child AgentSession to the shared checkpoint state machine. */
class ChildCheckpointCoordinator {
  readonly activation: SkillActivationState;
  readonly gate: MainSessionCheckpointGate;

  private session: PiSession | undefined;
  private readonly hooks: HookRunnerLike;
  private hookBlocked = false;
  private restorationFailed = false;
  private summaryCommitted = false;
  private manualRecovery = false;
  private stoppedRunSettled = false;
  private compactOperation: {
    controller: import("./mid-run-compaction.js").MidRunCompactionController;
    generation: number;
    proactive: boolean;
    trigger: "auto" | "manual";
  } | undefined;
  private retained: RetainedCheckpointOwner | undefined;
  private readonly retainedReady = childDeferred<RetainedCheckpointOwner>();
  private readonly dispatchSettled = childDeferred();
  private activeResume: {
    generation: number;
    token: ResumeToken;
    context: ResumeContext;
    started: ChildDeferred;
    providerOpen: ChildDeferred;
    settled: ChildDeferred;
    run: Promise<void>;
    agentSettled: boolean;
    runCompleted: boolean;
    runRejected: boolean;
    abortedEvidence: boolean;
    triggerLease?: HostInputLease;
    triggerEnvelope: object;
    triggerAccepted: ChildDeferred;
    triggerStarted: boolean;
    triggerInvocation: "scheduled" | "invoked" | "prevented";
    activeStreaming: boolean;
    invalidEvidence: boolean;
    checkpointStopEligibility?: ActiveCheckpointStopEligibility;
  } | undefined;
  private readonly pendingReplayEnvelopes = new Map<RetainedInputOccurrenceEnvelope, {
    shadow: QueuedInputShadow;
    lease?: HostInputLease;
    delivery: "steer" | "followUp";
    content: QueuedInputShadow["content"];
  }>();
  private readonly scopedHookDiagnosticFingerprints = new Set<string>();
  private scopedHookDiagnosticsSaturated = false;

  constructor(
    sessionId: string,
    threshold: number,
    private readonly agentName: string,
    private readonly hookAgentType: string,
    private readonly agentId: string,
    private readonly dispatchGeneration: number,
    private readonly cwd: CwdState,
    hooks: HookRunnerLike,
    private readonly diagnostics: Diagnostic[],
    private readonly surfaceDiagnostic?: (diagnostic: Diagnostic) => void,
    private readonly emitProgress?: (snapshot: ProgressSnapshot) => void,
    private readonly cancellationRecovery?: SubagentRuntimeDeps["compactionCancellationRecovery"],
  ) {
    const identityWrap = (runner: HookRunnerLike): HookRunnerLike => ({
      fire: (eventName, payload, toolCall) => runner.fire(
        eventName,
        { ...payload, agent_id: agentId, agent_type: this.hookAgentType },
        toolCall,
      ),
    });
    this.activation = newSkillActivationState(new Map(), identityWrap);
    this.hooks = this.hookFacade(hooks);
    this.gate = new MainSessionCheckpointGate(
      sessionId,
      threshold,
      cancellationRecovery?.deadlinePolicy,
    );
    this.gate.attachExecution({
      progress: (event) => this.progress(event),
      compact: (signal) => this.compact(signal),
      resume: (context) => this.resume(context),
      ...(cancellationRecovery
        ? { cancelledInput: (handoff: CancelledInputHandoff, context: ResumeContext) =>
            this.reclaimCancelledInput(handoff, context) }
        : {}),
    });
  }

  private resetContextInjection: (() => void) | undefined;

  attach(session: PiSession): void {
    this.session = session;
  }

  attachContextReset(reset: (() => void) | undefined): void {
    this.resetContextInjection = reset;
  }

  private hostOperation<T>(inputClass: HostInputClass, operation: () => T | Promise<T>): Promise<T> {
    const admission = this.gate.hostInputAdmission(inputClass);
    if (admission.kind === "refuse-settling") {
      throw new Error(`Subagent "${this.agentName}" is settling a checkpoint cancellation. Retry only after the parent call returns; this message was not sent.`);
    }
    if (admission.kind === "inactive") return Promise.resolve().then(operation);
    const running = Promise.resolve().then(operation);
    void running.then(
      () => { this.gate.settleHostInput(admission.lease); },
      () => { this.gate.settleHostInput(admission.lease); },
    );
    return running;
  }

  private invalidateResumeEvidence(resume: NonNullable<ChildCheckpointCoordinator["activeResume"]>): void {
    resume.invalidEvidence = true;
    const controller = this.gate.currentController();
    if (controller.invalidateResumedCancellation(resume.token)) {
      this.cancellationRecovery?.registry.quarantineCheckpoint(this.agentId);
    }
  }

  private customMessageStarted(event: any): void {
    const message = event?.message;
    if (!message) return;
    const resume = this.activeResume;
    const piCCMessage = message.customType === "picc-checkpoint-resume" ||
      message.customType === "picc-retained-parent-input";
    if (message.role !== "custom") {
      if (this.cancellationRecovery && resume && piCCMessage) this.invalidateResumeEvidence(resume);
      return;
    }
    if (resume && message.details?.piccCheckpointResume === resume.triggerEnvelope) {
      const lease = resume.triggerLease;
      const valid = !!lease && !resume.triggerStarted && resume.triggerInvocation === "invoked" &&
        message.customType === "picc-checkpoint-resume" &&
        message.content === "Context was compacted. Continue the same pending task from the preserved state.";
      if (!valid || !scrubEnvelope(message.details, "piccCheckpointResume")) {
        if (lease) this.gate.settleHostInput(lease);
        resume.triggerLease = undefined;
        resume.triggerAccepted.resolve();
        this.invalidateResumeEvidence(resume);
        return;
      }
      resume.triggerStarted = true;
      resume.activeStreaming = true;
      resume.triggerLease = undefined;
      this.gate.settleHostInput(lease);
      resume.triggerAccepted.resolve();
      return;
    }
    if (this.cancellationRecovery && resume && message.customType === "picc-checkpoint-resume") {
      this.invalidateResumeEvidence(resume);
      return;
    }

    const details = message.details;
    const envelope = details?.piccCheckpointInput as RetainedInputOccurrenceEnvelope | undefined;
    const pending = envelope && this.pendingReplayEnvelopes.get(envelope);
    if (!envelope || !pending) {
      if (this.cancellationRecovery && resume && message.customType === "picc-retained-parent-input") {
        this.invalidateResumeEvidence(resume);
      }
      return;
    }
    const { shadow, lease, delivery, content } = pending;
    // Installed Pi message_start carries no delivery metadata. The authenticated resumed
    // stream plus this exact PiCC-owned envelope and pending physical send class are the authority.
    const valid = !!resume && resume.activeStreaming && !resume.invalidEvidence &&
      (delivery === "steer" || delivery === "followUp") && message.content === content &&
      message.customType === "picc-retained-parent-input" &&
      envelope.sessionId === shadow.sessionId && envelope.generation === shadow.generation &&
      envelope.id === shadow.id && envelope.delivery === delivery &&
      scrubEnvelope(details, "piccCheckpointInput");
    this.pendingReplayEnvelopes.delete(envelope);
    if (lease) this.gate.settleHostInput(lease);
    if (!valid || this.gate.currentController().consumeShadow(
      shadow.generation,
      shadow.id,
      shadow.sessionId,
    ) !== shadow) {
      if (resume) this.invalidateResumeEvidence(resume);
      else this.gate.currentController().failUnconfirmedHost(shadow.generation);
    }
  }

  private agentEnded(event: any): void {
    const resume = this.activeResume;
    const controller = this.gate.currentController();
    if (!resume || resume.generation !== controller.snapshot().generation || !resume.triggerStarted) return;
    if (resume.agentSettled || !resume.activeStreaming) {
      this.invalidateResumeEvidence(resume);
      return;
    }
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const terminal = [...messages].reverse().find((message) => message?.role === "assistant");
    const sessionTerminal = [...(this.session?.messages ?? [])].reverse()
      .find((message) => message?.role === "assistant");
    const cancellationExpected = controller.snapshot().phase === "terminalizing" ||
      sessionTerminal?.stopReason === "aborted";
    resume.activeStreaming = false;
    if (cancellationExpected) {
      if (terminal?.stopReason !== "aborted" || sessionTerminal?.stopReason !== "aborted" ||
          resume.abortedEvidence || !controller.resumedAborted(resume.token)) {
        this.invalidateResumeEvidence(resume);
        return;
      }
      resume.abortedEvidence = true;
    } else if (terminal?.stopReason === "aborted") {
      this.invalidateResumeEvidence(resume);
    }
  }

  private reclaimCancelledInput(
    handoff: CancelledInputHandoff,
    context: ResumeContext,
  ): CancelledInputResolution {
    const registry = this.cancellationRecovery?.registry;
    if (!registry || context.token !== this.activeResume?.token || handoff.generation !== context.generation ||
        handoff.sessionId !== this.gate.currentController().sessionId) {
      throw new Error("Child cancellation custody is stale or unavailable");
    }
    // An accepted SDK send is not consumption. Cancellation reclaims every exact
    // still-pending envelope before publishing the report, making later host callbacks inert.
    for (const [envelope, pending] of this.pendingReplayEnvelopes) {
      if (pending.shadow.sessionId === handoff.sessionId &&
          pending.shadow.generation === handoff.generation) {
        if (pending.lease) this.gate.settleHostInput(pending.lease);
        this.pendingReplayEnvelopes.delete(envelope);
      }
    }
    const stageGuidance = handoff.continuationStarted
      ? `Subagent "${this.agentName}" stopped after its compacted continuation began.`
      : `Subagent "${this.agentName}" stopped at the compacted-continuation boundary; continuation startup was prevented or rejected before an authenticated stream was observed.`;
    const report = createRetainedInputReport({
      agentId: this.agentId,
      sessionId: handoff.sessionId,
      generation: handoff.generation,
      stage: "resumed-cancellation",
      occurrences: handoff.retained,
      guidance: `${stageGuidance} Files, tools, and external effects from earlier or ambiguous work may already exist; inspect the transcript and working tree before explicitly resending represented input. The report's unrepresentable count names retained input that could not be stored safely. No retained input was replayed automatically.`,
    });
    const stored = registry.storeRetainedInputReport(this.agentId, report);
    this.cancellationRecovery?.onCanonicalStoreForTest?.(stored, this.gate.currentController());
    if (!stored) {
      registry.quarantineCheckpoint(this.agentId);
      throw new Error("Canonical retained-input report storage failed");
    }
    return {
      sessionId: handoff.sessionId,
      generation: handoff.generation,
      token: handoff.token,
      sessionDisposition: "reusable",
      resolutions: handoff.retained.map((shadow) => ({ id: shadow.id, disposition: "reported" as const })),
    };
  }

  wrapTools(tools: unknown[]): unknown[] {
    return tools.map((tool) => this.gate.wrapTool(tool as Record<string, unknown>));
  }

  private captureScopedHookDiagnostic(diagnostic: Diagnostic, fallbackSource: string): void {
    const safe: Diagnostic = {
      severity: diagnostic.severity,
      source: sanitizeLine(diagnostic.source ?? fallbackSource, 120),
      message: sanitizeLine(diagnostic.message, 500),
    };
    const fingerprint = `${safe.severity}:${safe.source}:${safe.message}`;
    if (this.scopedHookDiagnosticFingerprints.has(fingerprint)) return;
    if (this.scopedHookDiagnosticFingerprints.size >= CHILD_SCOPED_HOOK_DIAGNOSTIC_CAP) {
      if (!this.scopedHookDiagnosticsSaturated) {
        this.scopedHookDiagnosticsSaturated = true;
        const overflow: Diagnostic = {
          severity: "warning",
          source: "plugin skill hooks",
          message: "Additional distinct plugin-skill hook diagnostics were suppressed.",
        };
        this.diagnostics.push(overflow);
        try {
          this.surfaceDiagnostic?.(overflow);
        } catch {
          // Diagnostics are additive observation and cannot change child hooks.
        }
      }
      return;
    }
    this.scopedHookDiagnosticFingerprints.add(fingerprint);
    this.diagnostics.push(safe);
    if (safe.severity === "warning" || safe.severity === "error") {
      try {
        this.surfaceDiagnostic?.(safe);
      } catch {
        // Diagnostics are additive observation and cannot change child hooks.
      }
    }
  }

  hookFacade(base: HookRunnerLike): HookRunnerLike {
    return {
      fire: async (eventName, payload, toolCall) => {
        const baseOutcome = await base.fire(eventName, payload, toolCall);
        const scopedOutcomes = await Promise.all(this.activation.hookRunners.map((runner) =>
          runner.fire(eventName, payload, toolCall)));
        for (const scoped of scopedOutcomes) {
          for (const diagnostic of scoped.diagnostics) {
            this.captureScopedHookDiagnostic(diagnostic, "plugin skill hooks");
          }
          for (const message of scoped.systemMessages ?? []) {
            this.captureScopedHookDiagnostic(
              { severity: "info", message },
              "plugin skill hook system message",
            );
          }
        }
        if (eventName === "SessionStart" || eventName === "PostCompact") {
          this.diagnostics.push(...baseOutcome.diagnostics);
          for (const message of baseOutcome.systemMessages ?? []) {
            this.diagnostics.push({ severity: "info", message: `hook (${eventName}): ${message}` });
          }
        }
        return mergeHookOutcomes([baseOutcome, ...scopedOutcomes]);
      },
    };
  }

  extensionFactory() {
    const child = this;
    return (pi: { on(event: string, handler: (event: any, ctx: any) => unknown): void }) => {
      pi.on("message_end", (event, ctx) => child.gate.assistantMessageEnded(event?.message, ctx));
      pi.on("message_start", (event) => {
        child.customMessageStarted(event);
        child.gate.userMessageStarted(
          event?.message,
          event?.streamingBehavior ?? event?.delivery ?? event?.message?.delivery,
        );
      });
      pi.on("tool_execution_end", (event) => child.gate.toolExecutionEnded(event));
      pi.on("turn_end", (_event, ctx) => child.gate.turnEnded(ctx));
      pi.on("turn_start", async (_event, ctx) => {
        child.activeResume?.started.resolve();
        await child.gate.defensiveLatch(ctx);
      });
      pi.on("before_provider_request", async (_event, ctx) => {
        await child.gate.beforeProviderRequest(ctx);
      });
      pi.on("agent_end", (event) => child.agentEnded(event));
      pi.on("agent_settled", async (_event, ctx) => child.settled(ctx));
      pi.on("session_before_compact", async (event) => child.beforeCompact(event));
      pi.on("session_compact", async (event) => child.afterCompact(event));
      // A child session boundary may confirm cancellation, but parent-session
      // persistence must authorize retained cleanup separately.
      pi.on("session_shutdown", async () => child.cancel("shutdown", true));
    };
  }

  async join(): Promise<void> {
    const controller = this.gate.currentController();
    const snapshot = controller.snapshot();
    await controller.stableBarrier(snapshot.generation);
  }

  settleDispatch(): void {
    this.dispatchSettled.resolve();
  }

  consumeStoppedRun(): boolean {
    const stopped = this.stoppedRunSettled;
    this.stoppedRunSettled = false;
    return stopped;
  }

  exhausted(): boolean {
    return this.gate.currentController().snapshot().phase === "exhausted";
  }

  checkpointStopEligibility(): ActiveCheckpointStopEligibility | undefined {
    const resume = this.activeResume;
    const snapshot = this.gate.currentController().snapshot();
    if (!this.cancellationRecovery || !this.summaryCommitted || !resume || resume.invalidEvidence ||
        !resume.triggerStarted || resume.generation !== snapshot.generation) return undefined;
    const activelyStreaming = snapshot.phase === "resuming" && resume.activeStreaming;
    const settlingCancellation = snapshot.phase === "terminalizing" &&
      snapshot.stage === "resumed-cancellation";
    if (!activelyStreaming && !settlingCancellation) return undefined;
    return resume.checkpointStopEligibility;
  }

  report(): RetainedInputReport | undefined {
    return this.cancellationRecovery?.registry.get(this.agentId)?.retainedInputReport;
  }

  isQuarantined(): boolean {
    return this.cancellationRecovery?.registry.get(this.agentId)?.checkpointQuarantined === true;
  }

  failureMessage(): string {
    const snapshot = this.gate.currentController().snapshot();
    if (this.isQuarantined() || snapshot.failureCategory === "unconfirmed-host") {
      const report = this.report();
      const retainedGuidance = report
        ? "Recover only the represented retained input from the canonical parent report; its unrepresentable count requires separate transcript inspection."
        : "Retained input was not safely reportable; no parent-result recovery source exists.";
      return `Subagent "${this.agentName}" has unconfirmed host work after checkpoint cancellation. Its live session, transcript, retained input, and worktree remain quarantined; do not resume, replace, or release it in this process. Do not retry in this process. ${retainedGuidance} Exit PiCC completely, start a fresh process and session, then inspect the transcript, worktree, and possible files/tools/external effects.`;
    }
    if (snapshot.failureCategory === "restoration-paused") {
      return `Automatic context compaction for subagent "${this.agentName}" committed, but restoration or continuation did not reach a confirmed reusable completion. The agent is paused; continuation may have been prevented or may have begun before the failure. Files, tools, and external effects may already exist, so inspect them before abandoning it with TaskStop using agent id ${this.agentId}, then dispatch a replacement agent with the retained input. Do not compact it again or retry SendMessage.`;
    }
    if (snapshot.failureCategory === "hook-blocked") {
      return `Automatic context compaction for subagent "${this.agentName}" paused because a PreCompact hook blocked the attempt. The agent is paused and no continuation ran; before this process exits, repair or disable the hook and use SendMessage with agent id ${this.agentId} to recover that same live agent, or abandon it with TaskStop using that agent id.`;
    }
    return `Automatic context compaction for subagent "${this.agentName}" could not complete. The agent is paused and no continuation ran; before this process exits, use SendMessage with agent id ${this.agentId} to recover that same live agent, or abandon it with TaskStop using that agent id.`;
  }

  retain(
    recover: (text: string) => Promise<DispatchResult>,
    cleanup: (outcome: DispatchOutcome, finalText?: string) => Promise<void>,
  ): void {
    // Re-exhaustion happens inside the original retained owner's recovery
    // operation. Keep that owner (and therefore its operation/cleanup chain)
    // stable so TaskStop and shutdown can still join the whole chain.
    if (this.retained) return;
    this.retained = { recover, cleanup, stopping: false };
    this.retainedReady.resolve(this.retained);
  }

  private claimRetainedCleanup(
    retained: RetainedCheckpointOwner,
    outcome: DispatchOutcome,
    finalText?: string,
  ): Promise<void> {
    // This synchronous claim is the sole entrance to disposal, registry settlement,
    // worktree release, and the final SubagentStop hook. `stopping` is reserved for an
    // external cancellation so recovery can distinguish normal terminal cleanup from a
    // concurrent stop that must suppress output. Quarantine precedes and forbids that owner.
    if (this.isQuarantined()) return Promise.reject(new Error(this.failureMessage()));
    if (!retained.cleanupPromise) retained.cleanupPromise = retained.cleanup(outcome, finalText);
    return retained.cleanupPromise;
  }

  async stopCheckpoint(
    attempt?: CheckpointStopAttemptIdentity,
  ): Promise<CheckpointStopTerminalEvidence | void> {
    const controller = this.gate.currentController();
    const before = controller.snapshot();
    const generation = before.generation;
    let retained = this.retained;
    const activeEligibility = this.checkpointStopEligibility();
    const safePreCommitCleanup = before.phase === "exhausted" && before.cancellationCommitted !== true &&
      (before.failureCategory === "operational" || before.failureCategory === "hook-blocked");
    const deferCleanup = attempt?.deferCleanup === true && !safePreCommitCleanup;
    const activeAttempt = activeEligibility !== undefined &&
      attempt?.checkpointOwner === activeEligibility.owner &&
      attempt.checkpointGeneration === activeEligibility.checkpointGeneration;
    await this.cancel(deferCleanup ? "shutdown" : "task-stop", deferCleanup);
    if (!attempt || attempt.agentId !== this.agentId || attempt.dispatchGeneration !== this.dispatchGeneration) return;
    if (attempt.checkpointOwner !== undefined && !activeAttempt) return;
    if (this.gate.currentController() !== controller || controller.snapshot().generation !== generation) return;
    if (activeAttempt && !retained) {
      retained = await Promise.race([
        this.retainedReady.promise,
        this.dispatchSettled.promise.then(() => undefined),
      ]);
    }
    if (activeAttempt && retained && !deferCleanup) {
      retained.stopping = true;
      await this.claimRetainedCleanup(retained, "aborted");
    }
    if (safePreCommitCleanup && retained && this.retained === retained && retained.cleanupPromise && !this.isQuarantined()) {
      return Object.freeze({
        confirmed: true as const,
        attemptId: attempt.attemptId,
        kind: "ordinary-cleanup" as const,
      });
    }
    const report = this.cancellationRecovery?.registry.get(this.agentId)?.retainedInputReport;
    if (!report || report.generation !== generation) return;
    const releaseCleanup = deferCleanup && retained
      ? async (attemptId: object): Promise<void> => {
          if (attemptId !== attempt.attemptId || this.retained !== retained || this.isQuarantined()) {
            throw new Error("checkpoint cleanup authority is stale");
          }
          await this.claimRetainedCleanup(retained, "aborted");
        }
      : undefined;
    return Object.freeze({
      confirmed: true as const, attemptId: attempt.attemptId, report,
      ...(releaseCleanup ? { releaseCleanup } : {}),
    });
  }

  async cancel(kind: CancellationKind, deferRetainedCleanup = false): Promise<void> {
    const retained = this.retained;
    if (retained) retained.stopping = true;
    const session = this.session;
    const controller = this.gate.currentController();
    const generation = controller.snapshot().generation;
    this.compactOperation = undefined;
    try { session?.abortCompaction?.(); } catch { /* cancellation still joins the run */ }
    const resume = this.activeResume;
    const snapshot = controller.snapshot();
    const sharedResumeCancellation = snapshot.phase === "resuming" ||
      (snapshot.phase === "terminalizing" && snapshot.stage === "resumed-cancellation");
    if (this.cancellationRecovery && resume && resume.generation === generation && sharedResumeCancellation) {
      try {
        const outcome = await resume.context.requestCancellation(kind);
        if (!outcome.cancelled) throw new Error("Checkpoint cancellation request is stale");
        await controller.stableBarrier(generation);
      } catch (error) {
        if (!this.isQuarantined()) this.cancellationRecovery.registry.quarantineCheckpoint(this.agentId);
        throw error;
      }
      if (retained && !deferRetainedCleanup) await this.claimRetainedCleanup(retained, "aborted");
      return;
    }
    const cancellation = this.gate.cancel(kind);
    this.activeResume = undefined;
    resume?.started.resolve();
    resume?.providerOpen.resolve();
    resume?.settled.reject(new Error("checkpoint cancelled"));
    try { await Promise.resolve(session?.abort?.()); } catch { /* controller join remains authoritative */ }
    await resume?.run.catch(() => undefined);
    await retained?.operation?.catch(() => undefined);
    await cancellation;
    await controller.stableBarrier(generation);
    if (retained && !deferRetainedCleanup) await this.claimRetainedCleanup(retained, "aborted");
  }

  private deliverParentInput(
    text: string,
    delivery: "steer" | "followUp",
    source: SubagentMessageSource = "send-message",
  ): Promise<void> | void {
    if (!this.cancellationRecovery) {
      return delivery === "steer" ? this.session?.steer?.(text) : this.session?.followUp?.(text);
    }
    const controller = this.gate.currentController();
    const snapshot = controller.snapshot();
    if (snapshot.phase === "exhausted") throw new Error(this.failureMessage());
    if (snapshot.phase !== "idle" && snapshot.phase !== "cancelled") {
      const retained = controller.shadowInput(snapshot.generation, text, delivery);
      if (retained) return;
      const report = this.cancellationRecovery.registry.get(this.agentId)?.retainedInputReport;
      const locator = report
        ? ` Retrieve it with ${taskOutputAgentLocator(this.agentId)}.`
        : ` If settlement is confirmed, use ${taskOutputAgentLocator(this.agentId)}.`;
      const origin = source === "panel" ? "Panel steering" : "SendMessage";
      throw new Error(`${origin} was refused because subagent "${this.agentName}" is settling checkpoint cancellation; the message was not sent.${locator} Inspect possible existing effects before retrying.`);
    }
    return delivery === "steer" ? this.session?.steer?.(text) : this.session?.followUp?.(text);
  }

  steer(text: string, metadata?: { source: SubagentMessageSource }): Promise<void> | void {
    return this.deliverParentInput(text, "steer", metadata?.source ?? "send-message");
  }

  followUp(text: string): Promise<void> | void {
    return this.deliverParentInput(text, "followUp");
  }

  recover(text: string): Promise<DispatchResult> {
    const retained = this.retained;
    if (!retained || retained.stopping || retained.cleanupPromise) {
      return Promise.reject(new Error(`${this.failureMessage()} Recovery adapter is unavailable for this retained session.`));
    }
    if (retained.operation) {
      return Promise.reject(new Error(`Checkpoint recovery for subagent "${this.agentName}" is already in progress; await that SendMessage attempt.`));
    }
    // Publish ownership synchronously: TaskStop/shutdown can now observe and
    // join the complete manual-compact + continuation + classification promise.
    const operation = this.runRecovery(retained, text);
    retained.operation = operation;
    void operation.finally(() => {
      if (retained.operation === operation) retained.operation = undefined;
    }).catch(() => undefined);
    return operation;
  }

  private async runRecovery(
    retained: NonNullable<ChildCheckpointCoordinator["retained"]>,
    text: string,
  ): Promise<DispatchResult> {
    const session = this.session;
    const controller = this.gate.currentController();
    const generation = controller.snapshot().generation;
    const token = controller.recoveryToken(generation);
    if (!token || !session?.compact || !session.sendCustomMessage) {
      throw new Error(`${this.failureMessage()} Recovery adapter is unavailable for this retained session.`);
    }
    this.hookBlocked = false;
    this.restorationFailed = false;
    this.summaryCommitted = false;
    this.manualRecovery = true;
    try {
      await session.compact();
    } catch (error) {
      void error;
      if (retained.stopping || this.retained !== retained) throw new Error("checkpoint recovery was cancelled");
      if (this.summaryCommitted) {
        await controller.failAfterCommittedSummary(generation, "restoration");
        throw new Error(`Compaction committed before recovery failed for subagent "${this.agentName}". Do not compact it again; abandon it with TaskStop using agent id ${this.agentId}, then dispatch a replacement agent with the retained input.`);
      }
      const category = this.hookBlocked ? "PreCompact hook" : "manual compaction";
      throw new Error(`${category} failed for recovery attempt on subagent "${this.agentName}". The agent remains paused; retry SendMessage after repairing the cause.`);
    } finally {
      this.manualRecovery = false;
    }
    if (retained.stopping || this.retained !== retained) throw new Error("checkpoint recovery was cancelled");
    if (this.restorationFailed) {
      await controller.failAfterCommittedSummary(generation, "restoration");
      throw new Error(`Context or skill restoration failed after compaction committed for subagent "${this.agentName}". Do not compact it again; abandon it with TaskStop using agent id ${this.agentId}, then dispatch a replacement agent with the retained input.`);
    }
    const recovered = controller.recoverAfterManualCompaction(token);
    if (!recovered.recovered || retained.stopping) throw new Error("checkpoint recovery was cancelled");
    try {
      const result = await retained.recover(text);
      // Classification may itself re-exhaust or race a stop. Authenticate the
      // original owner again before either returning the paused result or
      // claiming terminal cleanup; cancellation always wins this boundary.
      if (this.retained !== retained || retained.stopping) throw new Error("checkpoint recovery was cancelled");
      if (!result.checkpointPaused) {
        await this.claimRetainedCleanup(retained, result.outcome, result.finalMessage);
        if (this.retained !== retained || retained.stopping) throw new Error("checkpoint recovery was cancelled");
      }
      return result;
    } catch (error) {
      if (retained.stopping) throw new Error("checkpoint recovery was cancelled");
      const snapshot = controller.snapshot();
      if (snapshot.phase === "exhausted" && snapshot.failureCategory === "restoration-paused") {
        throw new Error(this.failureMessage());
      }
      const currentController = this.gate.currentController();
      const currentSnapshot = currentController.snapshot();
      await currentController.failAfterCommittedSummary(
        currentSnapshot.generation,
        currentSnapshot.stage ?? "continuation-start",
      );
      throw new Error(this.failureMessage());
    }
  }

  private async settled(ctx: any): Promise<void> {
    const controller = this.gate.currentController();
    const resume = this.activeResume;
    if (this.gate.isLogicalRunStopped()) {
      this.stoppedRunSettled = true;
      if (resume && this.gate.stoppedRunMatches(controller, controller.snapshot().generation) &&
          resume.generation === controller.snapshot().generation) {
        // The SDK run may not resolve until this handler returns. Signal only the
        // settlement capability here; cancellation joins in the background and
        // dispatch classification waits on the controller's stable barrier.
        resume.agentSettled = true;
        resume.settled.resolve();
      }
      void this.gate.settleLogicalRunStop().catch(() => undefined);
      return;
    }
    if (resume && resume.generation === controller.snapshot().generation &&
        (controller.snapshot().phase === "resuming" ||
          (this.cancellationRecovery && controller.snapshot().phase === "terminalizing"))) {
      if (resume.agentSettled) {
        if (this.cancellationRecovery) this.invalidateResumeEvidence(resume);
        return;
      }
      resume.agentSettled = true;
      // sendCustomMessage is the public ownership promise. agent_settled may
      // precede a later rejection, so success is committed only after both.
      if (resume.runCompleted) {
        const cancelled = resume.abortedEvidence;
        controller.resumedSettled(resume.token, cancelled ? "cancelled" : "completed");
        resume.settled.resolve();
        if (!cancelled) this.activeResume = undefined;
      }
      return;
    }
    const generation = this.gate.settlementGeneration(ctx);
    if (generation !== undefined) await controller.checkpoint(generation);
  }

  private async compact(signal: AbortSignal) {
    const session = this.session;
    const controller = this.gate.currentController();
    const generation = controller.snapshot().generation;
    const token = controller.beginCompactionSummary(generation);
    if (!session?.compact || !token) return { ok: false as const, category: "operational" as const };
    this.hookBlocked = false;
    this.restorationFailed = false;
    this.summaryCommitted = false;
    const operation = Promise.resolve().then(() => session.compact!());
    const abort = () => {
      try { session.abortCompaction?.(); } catch { /* operation settlement classifies */ }
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      let result = await promiseCompactionAttempt(() => operation, signal);
      if (signal.aborted) await operation.catch(() => undefined);
      if (!result.ok && this.summaryCommitted) result = { ok: false, category: "restoration-paused" };
      else if (!result.ok && this.hookBlocked) result = { ok: false, category: "hook-blocked" };
      if (result.ok && this.restorationFailed) result = { ok: false, category: "restoration-paused" };
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.compactOperation?.controller === controller &&
          this.compactOperation.generation === generation) this.compactOperation = undefined;
      controller.endCompactionSummary(token);
    }
  }

  private resume(context: ResumeContext) {
    const session = this.session;
    if (!session?.sendCustomMessage) throw new Error("Child session cannot resume through the public SDK");
    const started = childDeferred();
    const providerOpen = childDeferred();
    const settled = childDeferred();
    if (!this.cancellationRecovery) return this.resumeWithoutCancellationRecovery(context, session);
    const triggerAccepted = childDeferred();
    const triggerEnvelope = {};
    const triggerAdmission = this.gate.hostInputAdmission("continuation-trigger");
    if (triggerAdmission.kind !== "lease") {
      throw new Error(triggerAdmission.kind === "refuse-settling"
        ? "checkpoint continuation admission was revoked"
        : "checkpoint continuation trigger lacks generation custody");
    }
    const triggerLease = triggerAdmission.lease;
    let resume!: NonNullable<ChildCheckpointCoordinator["activeResume"]>;
    const isCurrent = (): boolean => {
      const controller = this.gate.currentController();
      const snapshot = controller.snapshot();
      return this.activeResume === resume && !context.signal.aborted &&
        snapshot.generation === context.generation && snapshot.phase === "resuming";
    };
    // Defer the SDK call by one microtask so ownership is installed first, then
    // authenticate again immediately before the public send side effect.
    const run = Promise.resolve().then(() => {
      if (resume.triggerInvocation === "prevented") return;
      if (!isCurrent()) throw new Error("checkpoint resume lost authority before startup");
      resume.triggerInvocation = "invoked";
      if (!context.advancePostCommitStage("continuation-start")) {
        throw new Error("checkpoint continuation stage authority is stale");
      }
      return session.sendCustomMessage!({
        customType: "picc-checkpoint-resume",
        content: "Context was compacted. Continue the same pending task from the preserved state.",
        display: false,
        details: { piccCheckpointResume: triggerEnvelope },
      }, { triggerTurn: true });
    });
    resume = {
      generation: context.generation,
      token: context.token,
      context,
      started,
      providerOpen,
      settled,
      run,
      agentSettled: false,
      runCompleted: false,
      runRejected: false,
      abortedEvidence: false,
      triggerLease,
      triggerEnvelope,
      triggerAccepted,
      triggerStarted: false,
      triggerInvocation: "scheduled",
      activeStreaming: false,
      invalidEvidence: false,
      checkpointStopEligibility: Object.freeze({
        agentId: this.agentId,
        dispatchGeneration: this.dispatchGeneration,
        checkpointGeneration: context.generation,
        owner: Object.freeze({}),
      }),
    };
    this.activeResume = resume;
    if (!this.gate.installResumeBarrier(context.generation, providerOpen.promise)) {
      this.activeResume = undefined;
      void run.catch(() => undefined);
      throw new Error("Cannot install child resumed provider barrier");
    }
    this.cancellationRecovery.onTriggerScheduledForTest?.();
    void run.then(() => {
      resume.runCompleted = true;
      if (resume.triggerInvocation === "prevented") return;
      if (resume.agentSettled && this.activeResume === resume) {
        const cancelled = resume.abortedEvidence;
        this.gate.currentController().resumedSettled(resume.token, cancelled ? "cancelled" : "completed");
        resume.settled.resolve();
        if (!cancelled) this.activeResume = undefined;
      }
    }, (error) => {
      // A rejection before or after turn_start must open every local wait while
      // rejecting controller settlement; otherwise replay can hang or finish as
      // a false successful/empty continuation.
      resume.runRejected = true;
      started.resolve();
      providerOpen.resolve();
      if (resume.triggerLease && !resume.triggerStarted) {
        this.gate.settleHostInput(resume.triggerLease);
        resume.triggerLease = undefined;
        resume.triggerAccepted.resolve();
      }
      this.gate.clearResumeBarrier(context.generation, providerOpen.promise);
      const snapshot = this.gate.currentController().snapshot();
      if (snapshot.phase === "terminalizing") {
        if (resume.triggerStarted) this.invalidateResumeEvidence(resume);
        return;
      }
      if (resume.triggerStarted && (resume.abortedEvidence || resume.agentSettled)) {
        this.invalidateResumeEvidence(resume);
        return;
      }
      settled.reject(error);
      if (this.activeResume === resume) this.activeResume = undefined;
    });
    let replayCompleted = false;
    return {
      replay: async (input: QueuedInputShadow) => {
        await started.promise;
        // Cancellation settles `started` to release this waiter; it never grants
        // replay authority. Re-authenticate the supported streaming send class before touching Pi.
        if (!isCurrent() || (input.delivery !== "steer" && input.delivery !== "followUp")) {
          return { delivered: false as const };
        }
        const envelope: RetainedInputOccurrenceEnvelope = Object.freeze({
          sessionId: input.sessionId,
          generation: input.generation,
          id: input.id,
          delivery: input.delivery,
          nonce: {},
        });
        const admission = this.gate.hostInputAdmission("retained-replay");
        if (admission.kind !== "lease") return { delivered: false as const };
        const details = { piccCheckpointInput: envelope };
        this.pendingReplayEnvelopes.set(envelope, {
          shadow: input,
          lease: admission.lease,
          delivery: input.delivery,
          content: input.content,
        });
        try {
          await session.sendCustomMessage!({
            customType: "picc-retained-parent-input",
            content: input.content,
            display: false,
            details,
          }, { deliverAs: input.delivery });
          // The physical SDK call is complete, but custody remains pending until
          // its exact authenticated message_start consumes the shadow.
          this.gate.settleHostInput(admission.lease);
          const pending = this.pendingReplayEnvelopes.get(envelope);
          if (pending) pending.lease = undefined;
        } catch (error) {
          this.pendingReplayEnvelopes.delete(envelope);
          this.gate.settleHostInput(admission.lease);
          throw error;
        }
        return { delivered: isCurrent() as true | false, pendingHostStart: true };
      },
      replayComplete: () => {
        if (!isCurrent() || replayCompleted) throw new Error("checkpoint resume provider release is not current");
        replayCompleted = true;
        providerOpen.resolve();
      },
      cancelAndJoin: async () => {
        started.resolve();
        providerOpen.resolve();
        this.gate.clearResumeBarrier(context.generation, providerOpen.promise);
        if (resume.triggerInvocation === "scheduled") resume.triggerInvocation = "prevented";
        if (!session.clearQueue || !session.abort) throw new Error("Child queue purge or abort is unavailable");
        session.clearQueue();
        if (resume.triggerInvocation === "prevented") {
          if (resume.triggerLease) {
            this.gate.settleHostInput(resume.triggerLease);
            resume.triggerLease = undefined;
            resume.triggerAccepted.resolve();
          }
          await run.catch(() => undefined);
          return { ending: "pre-start" as const };
        }
        const aborting = Promise.resolve(session.abort());
        await Promise.all([aborting, run.catch(() => undefined), resume.triggerAccepted.promise]);
        if (resume.runRejected && !resume.triggerStarted) return { ending: "pre-start" as const };
        if (resume.triggerStarted) await resume.settled.promise;
        if (resume.runRejected) throw new Error("Child resumed run rejected after authenticated start");
        if (resume.invalidEvidence || (!resume.runCompleted && !resume.runRejected)) {
          throw new Error("Child resumed run lacks exact run settlement evidence");
        }
        if (!resume.agentSettled) throw new Error("Child resumed run lacks exact final settlement evidence");
        if (!resume.triggerStarted || !resume.abortedEvidence) {
          throw new Error("Child resumed run lacks exact aborted terminal evidence");
        }
        return { ending: "aborted" as const };
      },
    };
  }

  private resumeWithoutCancellationRecovery(context: ResumeContext, session: PiSession) {
    const started = childDeferred();
    const providerOpen = childDeferred();
    const settled = childDeferred();
    let resume!: NonNullable<ChildCheckpointCoordinator["activeResume"]>;
    const isCurrent = () => {
      const snapshot = this.gate.currentController().snapshot();
      return this.activeResume === resume && !context.signal.aborted &&
        snapshot.generation === context.generation && snapshot.phase === "resuming";
    };
    const run = Promise.resolve().then(() => {
      if (!isCurrent()) throw new Error("checkpoint resume lost authority before startup");
      context.advancePostCommitStage("continuation-start");
      return session.sendCustomMessage!({
        customType: "picc-checkpoint-resume",
        content: "Context was compacted. Continue the same pending task from the preserved state.",
        display: false,
      }, { triggerTurn: true });
    });
    resume = {
      generation: context.generation,
      token: context.token,
      context,
      started,
      providerOpen,
      settled,
      run,
      agentSettled: false,
      runCompleted: false,
      runRejected: false,
      abortedEvidence: false,
      triggerEnvelope: {},
      triggerAccepted: childDeferred(),
      triggerStarted: false,
      triggerInvocation: "invoked",
      activeStreaming: false,
      invalidEvidence: false,
    };
    this.activeResume = resume;
    if (!this.gate.installResumeBarrier(context.generation, providerOpen.promise)) throw new Error("Cannot install child resumed provider barrier");
    void run.then(() => {
      resume.runCompleted = true;
      if (resume.agentSettled && this.activeResume === resume) {
        this.gate.currentController().resumedSettled(resume.token);
        settled.resolve();
        this.activeResume = undefined;
      }
    }, (error) => {
      resume.runRejected = true;
      started.resolve();
      providerOpen.resolve();
      this.gate.clearResumeBarrier(context.generation, providerOpen.promise);
      settled.reject(error);
      if (this.activeResume === resume) this.activeResume = undefined;
    });
    let replayCompleted = false;
    return {
      settled: settled.promise,
      replay: async (input: QueuedInputShadow) => {
        await started.promise;
        if (!isCurrent()) return { delivered: false as const };
        await session.sendCustomMessage!({
          customType: "picc-retained-parent-input",
          content: input.content,
          display: false,
        }, { deliverAs: input.delivery });
        return { delivered: isCurrent() as true | false };
      },
      replayComplete: () => {
        if (!isCurrent() || replayCompleted) throw new Error("checkpoint resume provider release is not current");
        replayCompleted = true;
        providerOpen.resolve();
      },
      cancelAndJoin: async () => {
        started.resolve();
        providerOpen.resolve();
        this.gate.clearResumeBarrier(context.generation, providerOpen.promise);
        try { await Promise.resolve(session.abort?.()); } finally { await run.catch(() => undefined); }
        if (this.activeResume === resume) this.activeResume = undefined;
      },
    };
  }

  private async beforeCompact(event: any): Promise<{ cancel: true } | undefined> {
    const controller = this.gate.currentController();
    const generation = controller.snapshot().generation;
    const proactive = controller.isCompactionSummaryActive(generation);
    const trigger = proactive ? "auto" : event?.reason === "manual" ? "manual" : "auto";
    if ((!proactive && trigger === "manual" && !this.manualRecovery) || this.compactOperation) return { cancel: true };
    const operation = { controller, generation, proactive, trigger } as const;
    this.compactOperation = operation;
    const isCurrent = () => this.compactOperation === operation &&
      this.gate.currentController() === controller && controller.snapshot().generation === generation &&
      (proactive ? controller.isCompactionSummaryActive(generation) :
        operation.trigger === "auto" ? controller.snapshot().phase === "idle" : this.manualRecovery);
    const stopRun = this.gate.captureLogicalRunStop();
    const outcome = await this.hooks.fire("PreCompact", {
      trigger: operation.trigger,
      custom_instructions: String(event?.customInstructions ?? ""),
      cwd: this.cwd.get(),
    }).catch(() => undefined);
    if (!isCurrent() || !outcome || outcome.block || outcome.stop) {
      if (isCurrent() && outcome?.stop) stopRun();
      if (isCurrent() && !outcome?.stop) this.hookBlocked = true;
      if (this.compactOperation === operation) this.compactOperation = undefined;
      return { cancel: true };
    }
    return undefined;
  }

  private async afterCompact(event: any): Promise<void> {
    const operation = this.compactOperation;
    const session = this.session;
    if (!operation || !session) return;
    const isCurrent = () => this.compactOperation === operation &&
      this.gate.currentController() === operation.controller &&
      operation.controller.snapshot().generation === operation.generation &&
      (operation.proactive
        ? operation.controller.isCompactionSummaryActive(operation.generation)
        : operation.trigger === "auto"
          ? operation.controller.snapshot().phase === "idle"
          : this.manualRecovery);
    if (!isCurrent()) return;
    this.summaryCommitted = true;
    if (operation.proactive) operation.controller.observeCompactionCommit(operation.generation);
    try {
      let universalStop = false;
      let startedContext = "";
      try {
        const started = await this.hooks.fire("SessionStart", { source: "compact", cwd: this.cwd.get() });
        if (!isCurrent()) return;
        if (started.stop) {
          this.restorationFailed = true;
          universalStop = true;
        }
        startedContext = [started.stdout, started.additionalContext].filter(Boolean).join("\n").trim();
      } catch {
        this.restorationFailed = true;
      }
      if (!isCurrent()) return;
      if (!universalStop && startedContext) {
        try {
          if (!isCurrent()) return;
          if (!session.sendCustomMessage) throw new Error("child hook restoration unavailable");
          await this.hostOperation("restoration-control", () => session.sendCustomMessage!({
            customType: "picc-hook-context",
            content: startedContext,
            display: true,
          }, { deliverAs: "steer" }));
          if (!isCurrent()) return;
        } catch {
          this.restorationFailed = true;
        }
      }
      if (!isCurrent()) return;
      if (!universalStop) try {
        const post = await this.hooks.fire("PostCompact", {
          trigger: operation.trigger,
          compact_summary: String(event?.compactionEntry?.summary ?? ""),
          cwd: this.cwd.get(),
        });
        if (!isCurrent()) return;
        if (post.stop) {
          this.restorationFailed = true;
          universalStop = true;
        }
      } catch {
        this.restorationFailed = true;
      }
      if (!isCurrent()) return;
      if (!universalStop) {
        try {
          if (!isCurrent()) return;
          this.resetContextInjection?.();
        } catch {
          this.restorationFailed = true;
        }
      }
      if (!isCurrent()) return;
      const preserved = budgetSkillReinjection([...this.activation.activeSkills.entries()]);
      if (!universalStop && preserved.text) {
        try {
          if (!isCurrent()) return;
          if (!session.sendCustomMessage) throw new Error("child skill restoration unavailable");
          await this.hostOperation("restoration-control", () => session.sendCustomMessage!({
            customType: "picc-preserved",
            content: `Context preserved across compaction (PiCC):\n\n${preserved.text}`,
            display: false,
          }, { deliverAs: "steer" }));
          if (!isCurrent()) return;
        } catch {
          this.restorationFailed = true;
        }
      }
    } finally {
      if (!operation.proactive && operation.trigger === "auto" && this.restorationFailed && isCurrent()) {
        await operation.controller.failAfterCommittedSummary(operation.generation, "restoration");
      }
      if (this.compactOperation === operation) this.compactOperation = undefined;
    }
  }

  private progress(event: CheckpointProgress): void {
    const controller = this.gate.currentController();
    this.cancellationRecovery?.onControllerProgressForTest?.(event, controller);
    if (event.failureCategory === "unconfirmed-host") {
      this.cancellationRecovery?.registry.quarantineCheckpoint(this.agentId);
    }
    if (this.gate.isLogicalRunStopped() && this.gate.stoppedRunMatches(controller, event.generation)) return;
    const activity = event.category === "checkpoint-exhausted"
      ? "checkpoint paused: recovery required"
      : event.category === "checkpoint-recovered"
        ? "checkpoint recovered: resuming"
        : event.category === "checkpoint-armed"
          ? event.source === "assistant" || event.source === "tool"
            ? "context checkpoint queued while the current tool cycle finishes"
            : event.source === "admission"
              ? "context checkpoint queued, waiting for safe child settlement"
              : event.source === "settled"
                ? "context checkpoint ready after the child run settled"
                : "context checkpoint queued until the child reaches safe settlement"
          : `checkpoint: ${event.category}`;
    this.emitProgress?.({ tail: [activity], activity });
    if (event.category === "checkpoint-exhausted") {
      this.diagnostics.push({ severity: "warning", message: this.failureMessage() });
    }
  }
}

function quarantineRefusal(record: SubagentRegistryRecord, action: string): string {
  const reportGuidance = record.retainedInputReport
    ? `Recover represented retained input only with ${taskOutputAgentLocator(record.agentId)}; inspect the transcript for any unrepresentable input.`
    : "No canonical retained-input report is available; inspect the transcript for retained input.";
  return `Agent ${record.agentId} ("${record.agentName}") is quarantined for this process lifetime. The requested ${action} was not performed. ${reportGuidance} Do not retry in this process. Exit PiCC completely, start a fresh process and session, then inspect the transcript, worktree, and possible files, tools, and external effects.`;
}

function scrubEnvelope(details: unknown, key: string): boolean {
  if (!details || typeof details !== "object") return false;
  try {
    return delete (details as Record<string, unknown>)[key] && !(key in details);
  } catch {
    return false;
  }
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

export interface StopAllSubagentOutcome {
  agentId: string;
  disposition: "confirmed" | "unconfirmed";
  report?: RetainedInputReport;
  stopRequested: boolean;
  persisted?: boolean;
  cleanupReleased?: boolean;
}

export interface StopAllSubagentSessionResult {
  outcomes: StopAllSubagentOutcome[];
  confirmed: number;
  unconfirmed: number;
}

export class SubagentRuntime {
  private readonly semaphore: Semaphore;
  private readonly attemptedRetainedPersistence = new WeakSet<object>();
  private readonly persistedRetainedReports = new WeakSet<object>();
  private readonly releasedRetainedCleanup = new WeakSet<object>();
  /**
   * Per-depth budgets for nested BACKGROUND dispatches. Each `depth ≥ 2`
   * gets its own `Semaphore` sized like the root, created lazily. A dispatch
   * acquires from the pool for ITS OWN depth, so an ancestor at depth `d` (holding
   * a slot in pool `d`, e.g. while blocked in a `TaskOutput(wait)` on a child)
   * never holds the slot a descendant at depth `d+1` is waiting on — no cross-depth
   * wait-for cycle, hence deadlock-free even at `concurrency = 1`. A single shared
   * pool would deadlock exactly there (see the acquire gate comment). The background
   * pools are bounded by `maxDepth × concurrency`; foreground nested dispatch bypasses
   * them, so total active work can be higher. Depth ≤ 1 stays on the existing root
   * `semaphore` so root behaviour/tests are unchanged.
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

  /** Stop one retained child owned by this runtime and join its cleanup. */
  async stopCheckpoint(agentId: string): Promise<void> {
    const recoveryRegistry = this.deps.compactionCancellationRecovery?.registry;
    const record = (recoveryRegistry ?? this.deps.subagentRegistry)?.get(agentId);
    if (record?.checkpointQuarantined) throw new Error(quarantineRefusal(record, "stop"));
    if (record?.state === "running" && (recoveryRegistry
      ? recoveryRegistry.checkpointStopOwned(agentId)
      : record.checkpointPaused === true)) {
      if (recoveryRegistry) {
        await recoveryRegistry.stopCheckpoint(agentId, "session");
      } else {
        // Capability omission preserves the existing direct adapter contract.
        await record.session?.stopCheckpoint?.();
      }
    }
  }

  /** Opted-in session boundary for confirmed reports and fail-closed quarantine. */
  async stopAllRetainedSubagents(options: {
    persist?: (report: RetainedInputReport) => boolean | Promise<boolean>;
  } = {}): Promise<StopAllSubagentSessionResult> {
    const registry = this.deps.compactionCancellationRecovery?.registry;
    if (!registry) return { outcomes: [], confirmed: 0, unconfirmed: 0 };
    const outcomes: StopAllSubagentOutcome[] = [];
    for (const initial of registry.list()) {
      let record = registry.get(initial.agentId);
      let stopRequested = false;
      if (record?.checkpointQuarantined) {
        // Quarantine is process-terminal authority: never call the adapter again.
      } else if (record?.state === "running" && registry.checkpointStopOwned(record.agentId)) {
        stopRequested = true;
        const stopped = await registry.stopCheckpoint(record.agentId, "session");
        if (stopped.disposition === "ordinary-cleanup") continue;
        record = registry.get(initial.agentId);
      } else if (!record?.retainedInputReport) {
        continue;
      } else if (record.checkpointStopState !== "confirmed") {
        registry.quarantineCheckpoint(record.agentId);
        record = registry.get(initial.agentId);
      }
      const report = record?.retainedInputReport;
      outcomes.push({
        agentId: initial.agentId,
        disposition: record?.checkpointQuarantined || record?.checkpointStopState !== "confirmed" || !report
          ? "unconfirmed" : "confirmed",
        ...(report ? { report } : {}),
        stopRequested,
      });
    }

    // Ambiguous cancellation/ownership is not a storage failure. Establish every
    // disposition before persistence or destructive cleanup so it remains fail-closed.
    if (outcomes.some((outcome) => outcome.disposition === "unconfirmed")) {
      return {
        outcomes,
        confirmed: outcomes.filter((outcome) => outcome.disposition === "confirmed").length,
        unconfirmed: outcomes.filter((outcome) => outcome.disposition === "unconfirmed").length,
      };
    }

    for (const outcome of outcomes) {
      const report = outcome.report!;
      if (this.persistedRetainedReports.has(report.reportId)) {
        outcome.persisted = true;
      } else if (options.persist && !this.attemptedRetainedPersistence.has(report.reportId)) {
        this.attemptedRetainedPersistence.add(report.reportId);
        try {
          outcome.persisted = await options.persist(report) === true;
        } catch {
          outcome.persisted = false;
        }
        if (outcome.persisted) this.persistedRetainedReports.add(report.reportId);
      } else if (this.attemptedRetainedPersistence.has(report.reportId)) {
        outcome.persisted = false;
      }

      // Confirmed shutdown persistence is best effort. Cleanup still releases exactly
      // once after the one persistence attempt; only ambiguous cleanup authority blocks.
      if (this.releasedRetainedCleanup.has(report.reportId)) {
        outcome.cleanupReleased = true;
      } else {
        try {
          await registry.releaseCheckpointCleanup(outcome.agentId, report);
          this.releasedRetainedCleanup.add(report.reportId);
          outcome.cleanupReleased = true;
        } catch {
          outcome.cleanupReleased = false;
        }
      }
    }
    return { outcomes, confirmed: outcomes.length, unconfirmed: 0 };
  }

  /** Session-local shutdown barrier for every retained child of this runtime. */
  async shutdownCheckpointPaused(): Promise<void> {
    const recoveryRegistry = this.deps.compactionCancellationRecovery?.registry;
    const records = (recoveryRegistry ?? this.deps.subagentRegistry)?.list() ?? [];
    await Promise.allSettled(records
      .filter((record) => record.state === "running" && !record.checkpointQuarantined &&
        (recoveryRegistry
          ? recoveryRegistry.checkpointStopOwned(record.agentId)
          : record.checkpointPaused === true))
      .map((record) => recoveryRegistry
        ? recoveryRegistry.stopCheckpoint(record.agentId, "session")
        : record.session?.stopCheckpoint?.() ?? Promise.resolve()));
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

  /** Resolve validated frontmatter color for human rendering only. */
  agentDisplayColor(agentId: string | undefined, subagentType: string | undefined): unknown {
    if (agentId) {
      const captured = this.deps.subagentRegistry?.get(agentId)?.color;
      if (captured) return captured;
    }
    const requested = subagentType?.trim() || "general-purpose";
    return this.resolveAgentDefinition(requested)?.color;
  }

  async dispatch(opts: {
    subagentType: string;
    prompt: string;
    model?: string;
    /** Effort override (e.g. a context:fork skill's `effort:`); defaults to the agent's. */
    effort?: string;
    depth: number;
    /** Whether immediate text diagnostics are required instead of TUI lifecycle detail. */
    headless?: boolean;
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
     * The dispatching subagent's own working directory (its `subCwd`, i.e. the
     * worktree it entered). When set, a FRESH dispatch begins here instead of at
     * the orchestrator's cwd, so a worktree-resident parent's isolation extends to
     * the children it spawns. Absent for a top-level (coordinator) dispatch, which
     * keeps the orchestrator cwd. Ignored on resume (a resumed run reuses its
     * original cwd/worktree). Runtime-threaded from the Agent tool's `dispatchCwd`,
     * never a tool parameter.
     */
    parentCwd?: string;
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
    /** Runtime-only concurrency admission sink for task-record mirroring. */
    onAdmission?: (admission: SubagentAdmission) => void;
    /** Opaque dispatcher-run stop authority captured before the Agent tool awaits. */
    captureUniversalStop?: () => boolean;
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
    const collectPreloadDiagnostic = createPreloadDiagnosticCollector(
      diagnostics,
      opts.headless ? this.deps.surfaceHeadlessDiagnostic : undefined,
    );
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
    // general-purpose (isFork=false, unmarked tools, honest lifecycle identity) before either is
    // fixed. Undefined ⇒ this dispatch is not (or no longer) an inheriting fork.
    let forkSession: PiSessionManagerLike | undefined;
    // The deferred `forkFrom` call. Set (in the interception below) ONLY
    // for a fork that passed every degrade check; invoked once, immediately before
    // `customToolsFor`. A fork shares the parent cwd (isolation undefined) and is
    // never a resume, so the cwd known at interception equals the dispatch cwd passed
    // here. Undefined ⇒ nothing to fork (degraded at interception, or not a fork).
    let attemptForkSession: ((cwd: string) => PiSessionManagerLike) | undefined;
    let forkOwnershipAdmissionFailed = false;
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
        // the FINAL isFork/operational identity/lifecycle presentation (a throw there re-resolves to
        // general-purpose) BEFORE the child tools + identity are built.
        // The env=0 / nested / no-transcript / SDK-can't-fork / fork-spawns-fork
        // degrades stay resolved at interception — none of them need `forkFrom`.
        isFork = true;
        // Capture the fork inputs (SDK + narrowed main-session file) for the thunk;
        // the dispatch cwd is passed in at the call site.
        const forkSdkRef = forkSdk!;
        const forkMainFileRef = forkMainFile;
        attemptForkSession = (cwd: string) => {
          const prepared = (this.deps.prepareTranscriptCollection ?? prepareSubagentTranscriptCollection)(
            forkMainFileRef,
          );
          if (!prepared.ok) {
            forkOwnershipAdmissionFailed = true;
            throw new Error(prepared.diagnostic.message);
          }
          return forkSdkRef.forkSessionManager!(forkMainFileRef, cwd, prepared.directory, agentId);
        };
      }

      if (isFork) {
        // Reads as a fork (agentName "fork" → an honest `fork` identity).
        resolved = buildForkAgent();
      } else {
        // Degrade: run as fresh general-purpose (a fresh IDENTITY, so success vs.
        // degrade are distinguishable in the rendered lifecycle row) with a fork-SPECIFIC
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
    // after the gates) re-resolves this to general-purpose so the result row and
    // post-gate hook identity honestly use `general-purpose`. Typed
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
        error: `Subagent nesting depth ${opts.depth} exceeds the configured maximum (subagents.maxDepth) of ${this.deps.maxDepth}. Set subagents.maxDepth to a larger positive integer in .claude/settings.json to allow nested delegation.`,
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

    // Quarantine admission precedes every hook, transcript, SDK-session, and worktree side effect.
    // register() repeats this check as a backstop so no future dispatch path can silently replace
    // the same stable identity after process-terminal ambiguity.
    this.deps.compactionCancellationRecovery?.registry.assertDispatchAdmission(agentId);
    if (this.deps.subagentRegistry !== this.deps.compactionCancellationRecovery?.registry) {
      this.deps.subagentRegistry?.assertDispatchAdmission(agentId);
    }

    try {
      agent = this.deps.prepareAgent?.(agent) ?? agent;
    } catch (err) {
      return {
        ok: false,
        outcome: "failed",
        finalMessage: "",
        agentId,
        resumable: false,
        agentName: agent.name,
        error: capErrorText((err as Error)?.message ?? String(err)),
        diagnostics,
      };
    }

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
    let scopedHooks: HookRunnerLike | undefined;
    if (
      this.deps.makeScopedHookRunner &&
      agent.hooks &&
      Object.values(agent.hooks).some((entries) => entries?.length)
    ) {
      try {
        const parsed = parseHookConfig(
          agent.hooks,
          agent.source.path,
          agent.source.pluginId ? { pluginId: agent.source.pluginId } : undefined,
        );
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
      };
    }
    // Central identity injection: agent_id AND agent_type (the agent's
    // name) ride on EVERY hook payload fired within this dispatch — the guard's
    // PreToolUse/PostToolUse fired from inside the subagent, SubagentStart, and
    // SubagentStop/Stop — so the subagent identity can't drift per fire site
    // (Claude Code hook input carries both). One choke point wrapping each raw
    // runner. transcript_path is deliberately NOT injected — parity: subagent
    // hook events keep the MAIN session transcript_path (the runner's own
    // constructed default), never the subagent's own file.
    const hookAgentType = agent.name;
    const injectIdentity = (runner: HookRunnerLike): HookRunnerLike => ({
      fire: (
        eventName: string,
        payload: Partial<HookPayload>,
        toolCall?: ToolCallDescriptor,
      ): Promise<HookOutcome> =>
        runner.fire(eventName, { ...payload, agent_id: agentId, agent_type: hookAgentType }, toolCall),
    });
    const baseRunner = injectIdentity(this.deps.hookRunner);
    if (scopedHooks) scopedHooks = injectIdentity(scopedHooks);
    let hookRunner = scopedHooks
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
      const outcome = mergeHookOutcomes(outcomes);
      if (outcome.stop) opts.captureUniversalStop?.();
      return outcome;
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
    const noteAdmission = (admission: SubagentAdmission) => {
      try { this.deps.subagentRegistry?.noteAdmission(agentId, admission); } catch { /* metadata only */ }
      try { opts.onAdmission?.(admission); } catch { /* metadata only */ }
    };
    const release = foregroundNested
      ? (noteAdmission("admitted"), () => {})
      : await this.budgetForDepth(opts.depth).acquire(noteAdmission);
    let worktreePath: string | undefined;
    let session: PiSession | undefined;
    let dispatchCwd: CwdState | undefined;
    let started = false;
    let stopFired = false;
    let abortListener: (() => void) | undefined;
    let progressUnsub: (() => void) | undefined;
    let recoveryUnsub: (() => void) | undefined;
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
    let checkpointPaused = false;
    let dispatchCheckpoint: ChildCheckpointCoordinator | undefined;
    let dispatchCheckpointGate: MainSessionCheckpointGate | undefined;
    let dispatchAuthoritySettled = false;
    const settleDispatchAuthority = () => {
      if (dispatchAuthoritySettled) return;
      dispatchAuthoritySettled = true;
      dispatchCheckpoint?.settleDispatch();
      dispatchCheckpointGate?.logicalRunSettled();
    };
    // The final answer text for the registry record (panel drill-down): the
    // completed final message, or a failed run's best-effort partial. Aborted
    // runs leave it unset — a deliberately stopped result is discarded by
    // contract. Read once in the finally alongside outcome/usage.
    let settledFinalText: string | undefined;
    let settledAssistantIdentityText: string | undefined;
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
      if (startOutcome?.stop) {
        opts.captureUniversalStop?.();
        const reason = startOutcome.stopReason ?? "SubagentStart hook requested stop";
        diagnostics.push({ severity: "warning", message: reason });
        settledOutcome = "aborted";
        return {
          ok: false,
          outcome: "aborted",
          finalMessage: "",
          agentId,
          resumable: false,
          agentName: agent.name,
          error: `Subagent "${agent.name}" was stopped by its SubagentStart hook: ${reason}`,
          diagnostics,
        };
      }
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

      // A nested dispatch begins at its DISPATCHER's cwd (`parentCwd`): a subagent
      // that entered a worktree extends that isolation to the children it spawns.
      // Top-level (coordinator) dispatches carry no `parentCwd` and keep the
      // orchestrator cwd. Resume overrides this below (original cwd reused). This
      // seed governs a child that stays put (`isolation: none` or a failed entry);
      // a child that requests `isolation: worktree` overwrites `cwd` with its own
      // worktree in the branch below — and that worktree is anchored to the
      // WorktreeManager's fixed projectRoot, NOT to `parentCwd`.
      let cwd = opts.parentCwd ?? this.deps.getCwd();
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
      // resolved operational identity/lifecycle presentation are settled before the child tools + identity are
      // built. The constructed manager is reused by the session-manager
      // stage (never re-forked), keeping `forkCalls()` at 1.
      if (attemptForkSession) {
        try {
          forkSession = attemptForkSession(cwd);
          // Success: isFork stays true; the fork identity and lifecycle presentation stand.
        } catch (err) {
          // Degrade to a plain general-purpose run: flip isFork false so
          // `customToolsFor` builds UNMARKED tools, re-resolve the identity so the
          // result row honestly uses `general-purpose`, and emit the generic
          // model reason. SECURITY: the raw error can embed the main session's
          // ABSOLUTE PATH, so the capped detail rides the developer diagnostic only.
          // Accepted cosmetic: the SubagentStart hook already fired with the "fork"
          // subagent_type (before this throw was known); the lifecycle identity stays honest.
          isFork = false;
          agent = resolveAgent(builtins, "general-purpose") ?? agent;
          emitForkDegrade(
            "warning",
            forkOwnershipAdmissionFailed
              ? `transcript ownership could not be verified. ${TRANSCRIPT_OWNERSHIP_RECOVERY_GUIDANCE}`
              : `forking the parent session failed`,
            forkOwnershipAdmissionFailed
              ? `forking the parent session failed because transcript ownership could not be verified. ${TRANSCRIPT_OWNERSHIP_RECOVERY_GUIDANCE}`
              : `forking the parent session failed (${capErrorText(
                (err as Error)?.message ?? String(err),
              )})`,
          );
        }
      }

      // Dispatch-local cwd, activation, and checkpoint state must never be shared
      // with the orchestrator or a sibling dispatch.
      const subCwd = new CwdState(cwd);
      dispatchCwd = subCwd;
      let notebookSessionManager: PiSessionManagerLike | undefined;
      const notebookSession = new NotebookSessionState({
        onChange: (snapshot) => {
          try {
            notebookSessionManager?.appendCustomEntry?.(NOTEBOOK_SESSION_CUSTOM_TYPE, snapshot);
          } catch {
            // Current child state remains usable when transcript persistence fails.
          }
        },
      });
      const checkpoint = new ChildCheckpointCoordinator(
        `${this.deps.sessionId}:${agentId}`,
        this.deps.proactiveCompactPercent ?? 90,
        agent.name,
        hookAgentType,
        agentId,
        this.deps.subagentRegistry?.get(agentId)?.dispatchGeneration ?? 1,
        subCwd,
        hookRunner,
        diagnostics,
        opts.headless ? this.deps.surfaceHeadlessDiagnostic : undefined,
        (snapshot) => {
          this.deps.subagentRegistry?.noteProgress(agentId, snapshot);
          opts.onProgress?.(snapshot);
        },
        this.deps.compactionCancellationRecovery,
      );
      dispatchCheckpoint = checkpoint;
      dispatchCheckpointGate = checkpoint.gate;
      hookRunner = checkpoint.hookFacade(hookRunner);

      let granted = this.deps.permissionEngine.gateTools(
        agent.tools,
        agent.disallowedTools,
        this.deps.allKnownToolNames(),
      );
      if (opts.background && !isFork) {
        // Claude excludes these built-in resource surfaces only from real
        // non-fork background agents. A conversation fork keeps the parent's
        // pool even when background execution was selected by default.
        granted = granted.filter(
          (name) => name !== "ListMcpResourcesTool" && name !== "ReadMcpResourceTool",
        );
      }
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
      const customToolsStop = () => checkpoint.gate.captureLogicalRunStop();
      let customTools = this.deps.customToolsFor(
        agent,
        granted,
        opts.depth,
        agentId,
        isFork,
        subCwd,
        notebookSession,
        checkpoint.activation,
        customToolsStop,
      );

      const sdk = await this.sdk();

      // Subagent built-ins from the SHARED factory: the exact same seven tool
      // implementations the main session builds (index.ts), constructed here
      // against the dispatch-local `subCwd` — NEVER the orchestrator cwd. The
      // execute closure rebinds per call via `subCwd.get()`, so after THIS agent's
      // own EnterWorktree its built-ins re-resolve to the new worktree cwd in
      // lockstep with the guard (which reads the same `subCwd` via `getCwd`, above)
      // and the custom tools (all cwd-bound to the same `subCwd`). This gives the
      // subagent bash `settingsEnv` + `CLAUDE_PROJECT_DIR` via the factory's
      // spawnHook, and eliminates the built-in/guard cwd desync after a worktree entry.
      //
      // Filter by `piBuiltins` (== `claudeToolsToPiBuiltins(granted)`), NOT by
      // `granted`: `granted` holds CLAUDE names (`Bash`, `Glob`) while the factory
      // emits PI names (`bash`, `find`, `ls`) and `Glob` fans out to `[find, ls]`.
      // A read-only agent thus receives only its permitted built-in implementations.
      //
      // The tools keep their Pi lowercase names so they (a) SHADOW the stock Pi
      // built-ins and (b) the guard's `toClaudeCall`/`PI_TO_CLAUDE` map still
      // resolves `bash → Bash` for deny rules. Appended RAW (no `wrapForSelfShell`
      // — the subagent set renders in subagent transcripts, not the TUI).
      const grantedPiBuiltins = new Set(piBuiltins);
      const factoryBuiltins = buildStockBuiltinTools(sdk as BuiltinToolSdk, subCwd, {
        settingsEnv: this.deps.settingsEnv ?? {},
        projectRoot: this.deps.projectRoot ?? cwd,
        ...(this.deps.shellPath ? { shellPath: this.deps.shellPath } : {}),
        notebookSession,
      });
      for (const builtin of factoryBuiltins) {
        if (grantedPiBuiltins.has(builtin.name)) customTools.push(builtin.def);
      }
      customTools = checkpoint.wrapTools(customTools) as unknown[];
      const contextInjection = this.deps.makeContextInjector?.(() => subCwd.get());
      const injector = contextInjection?.inject ?? this.deps.contextForTouchedFile;
      checkpoint.attachContextReset(contextInjection?.reset);
      const guard = createGuardExtension({
        engine: this.deps.permissionEngine,
        // Multiplexed runner: the agent's scoped PreToolUse/PostToolUse/
        // PostToolUseFailure hooks fire alongside the session hooks — for this
        // dispatch's tool calls only.
        hooks: hookRunner,
        getCwd: () => subCwd.get(),
        contextForTouchedFile: injector,
        label: `subagent:${agent.name}`,
        extraDenyRules: () => [...checkpoint.activation.denyRules.values()].flat(),
        ...(this.deps.clipMaxTokens !== undefined ? { clipMaxTokens: this.deps.clipMaxTokens } : {}),
        captureUniversalStop: () => checkpoint.gate.captureLogicalRunStop(),
      });
      const extensionFactories: Array<{ name: string; factory: (pi: unknown) => unknown }> = [
        {
          name: "picc-codex-provider",
          factory: ((pi: { registerProvider?: (name: string, config: Record<string, unknown>) => void }) => {
            if (typeof pi.registerProvider === "function") {
              registerCodexAbortGuard({ registerProvider: pi.registerProvider.bind(pi) });
            }
          }) as (pi: unknown) => unknown,
        },
        { name: `picc-guard-${agent.name}`, factory: guard as (pi: unknown) => unknown },
        { name: `picc-checkpoint-${agent.name}`, factory: checkpoint.extensionFactory() as (pi: unknown) => unknown },
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
        systemPromptOverride: () => this.deps.buildSystemPrompt(
          agent,
          opts.depth,
          collectPreloadDiagnostic,
        ),
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
      // The built-in NAMES must appear in `toolNames`: verified against the Pi SDK
      // (agent-session.js), custom tools are filtered by the `tools:` allowlist by
      // name, so a name absent from `toolNames` would drop the same-named FACTORY
      // custom too; the registry then sets customs over stock built-ins by name
      // last, so the same-named custom deterministically WINS (shadows the stock
      // built-in). The appended factory built-ins already contribute those names via
      // `customTools.map` below, so spreading `piBuiltins` here is belt-and-suspenders,
      // not strictly required — kept for clarity. Each name then appears twice in
      // `toolNames`, harmless because Pi de-dups `allowedToolNames` into a Set.
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
        // general-purpose lifecycle identity) and never reaches this branch. REUSE the
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
          // (mirroring the forkFrom-throw path) so the result row honestly uses
          // `general-purpose` and never reads `fork` while the footer says it ran fresh.
          isFork = false;
          agent = resolveAgent(builtins, "general-purpose") ?? agent;
          resumable = false;
          emitForkDegrade("warning", `the parent transcript became unavailable before forking`);
        }
      } else if (mainSessionFile && sdk.persistedSessionManager) {
        try {
          const prepared = (this.deps.prepareTranscriptCollection ?? prepareSubagentTranscriptCollection)(
            mainSessionFile,
          );
          if (!prepared.ok) {
            diagnostics.push(prepared.diagnostic, {
              severity: "warning",
              message: `subagent transcript persistence was skipped; this run is in-memory and non-resumable. ${TRANSCRIPT_OWNERSHIP_RECOVERY_GUIDANCE}`,
            });
          } else {
            const persisted = sdk.persistedSessionManager(cwd, prepared.directory, agentId);
            transcriptPath = persisted.getSessionFile() ?? undefined;
            sessionManager = persisted;
            resumable = !oneShot && transcriptPath !== undefined;
          }
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
      notebookSessionManager = sessionManager as PiSessionManagerLike;
      let notebookBranch: unknown;
      try {
        notebookBranch = notebookSessionManager.getBranch?.();
      } catch {
        notebookBranch = undefined;
      }
      notebookSession.restore(newestNotebookSessionSnapshot(notebookBranch));

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
      checkpoint.attach(session);
      const recoveryProgress = new SubagentRecoveryProgress(session.messages, !isFork);
      if (typeof session.subscribe === "function") {
        try {
          recoveryUnsub = session.subscribe((event: unknown) => recoveryProgress.consume(event));
          recoveryProgress.markObservationAvailable();
        } catch {
          recoveryProgress.markObservationIncomplete();
        }
      }
      const actualResumable = !overrideDispatch && !isFork && resumable;
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
        resumable: actualResumable,
        oneShot,
        session: {
          steer: (text: string, metadata) => checkpoint.steer(text, metadata),
          recoverCheckpoint: (text: string) => checkpoint.recover(text),
          checkpointStopEligibility: () => checkpoint.checkpointStopEligibility(),
          stopCheckpoint: (attempt) => checkpoint.stopCheckpoint(attempt),
          followUp: (text: string) => checkpoint.followUp(text),
        },
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
        abortListener = () => {
          try {
            void checkpoint.cancel("task-stop").catch(() => undefined);
          } catch {
            // best-effort — an abort failure must not corrupt the dispatch
          }
        };
        if (opts.abortSignal.aborted) abortListener();
        else opts.abortSignal.addEventListener("abort", abortListener, { once: true });
      }

      // Project every child event independently into the legacy snapshot, structured
      // detail log, and bounded live-panel display payload. The registry mirrors all three for
      // foreground, background, nested, and resumed dispatches; opts.onProgress receives
      // snapshot changes only, preserving its model-facing cadence. Mirror before emit so
      // the registry never lags a consumer-visible snapshot. Event-stream only — NEVER
      // poll session.messages, which compaction can rewrite mid-flight. Sessions without
      // subscribe() (simple fakes and older SDKs) degrade to no live projection.
      const dispatchRegistry = this.deps.subagentRegistry;
      if ((opts.onProgress || dispatchRegistry) && typeof session.subscribe === "function") {
        const emit = opts.onProgress;
        const condenser = new SubagentProgressCondenser();
        progressUnsub = session.subscribe((event: unknown) => {
          try {
            const snapshotChanged = condenser.consume(event);
            const detailChanged = condenser.detailChanged();
            const liveActivityChanged = condenser.liveActivityChanged();
            if (!snapshotChanged && !detailChanged && !liveActivityChanged) return;
            const snapshot = snapshotChanged ? condenser.snapshot() : undefined;
            dispatchRegistry?.noteProgress(
              agentId,
              snapshot,
              detailChanged ? condenser.detailLog() : undefined,
              liveActivityChanged ? { value: condenser.liveActivity() } : undefined,
            );
            if (snapshotChanged) emit?.(snapshot!);
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
          recoveryProgress.observeMessages(live.messages);
          let contextWindow: number | undefined;
          try {
            contextWindow = live.getContextUsage?.()?.contextWindow;
          } catch {
            contextWindow = undefined;
          }
          const assistant = last as unknown as AssistantMessage;
          const transientCategory =
            !isContextOverflow(assistant, contextWindow) && isRetryableAssistantError(assistant);
          const progressed = recoveryProgress.hasProgress();
          const recoveryDisposition: SubagentRecoveryDisposition | undefined = transientCategory
            ? progressed
              ? actualResumable
                ? "resume-preferred"
                : "progressed-non-resumable"
              : "fresh-dispatch-preferred"
            : undefined;
          return {
            ok: false,
            outcome: "failed",
            finalMessage: settledFinalText,
            agentId,
            transcriptPath,
            resumable: actualResumable,
            agentName: agent.name,
            worktreePath,
            isFork,
            // Partial usage of the failed run: "what did the failure cost me".
            usage: captureUsage(),
            terminalAssistantError: true,
            recoveryDisposition,
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
            retainedInputReport: checkpoint.report(),
            error: `Subagent "${agent.name}" was aborted before completing its task.`,
            diagnostics,
          };
        }
        if (last?.stopReason === "pending") {
          settledOutcome = "failed";
          settledFinalText = assistantTextSoFar(live);
          return {
            ok: false,
            outcome: "failed",
            finalMessage: settledFinalText,
            agentId,
            transcriptPath,
            resumable: actualResumable,
            truncated: false,
            isFork,
            agentName: agent.name,
            worktreePath,
            usage: captureUsage(),
            error: "Agent ended with an incomplete pending assistant response.",
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
      const retainedCleanup = async (outcome: DispatchOutcome, finalText?: string): Promise<void> => {
        try {
          if (abortListener && opts.abortSignal) {
            try { opts.abortSignal.removeEventListener("abort", abortListener); } catch { /* floor */ }
          }
          try { progressUnsub?.(); } catch { /* presentation only */ }
          try { recoveryUnsub?.(); } catch { /* classification only */ }
          // Session statistics must be sampled while the public session is live.
          captureUsage();
          try { session?.dispose(); } catch { /* disposal cannot mask recovery */ }
          this.deps.subagentRegistry?.markSettled(agentId, {
            outcome,
            usage: capturedUsage,
            finalText,
            assistantIdentityText: session ? lastAssistantText(session) : undefined,
          });
          // The retained initial dispatch owns its worktree through recovery. A
          // recovery generation must not independently release that same checkout.
          if (worktreePath && this.deps.worktrees && !opts.resume) {
            await this.deps.worktrees.exit({ worktreePath, action: "keep" }).catch(() => undefined);
          }
          if (started && !stopFired) {
            stopFired = true;
            await fireSubagentStop({ subagent_type: agent.name, cwd: subCwd.get() }).catch(() => undefined);
          }
        } finally {
          // A paused dispatch remains authoritative through its final retained
          // recovery/abandonment lifecycle, including SubagentStop. Revoke it
          // even when cleanup fails so stale children cannot stop a later run.
          settleDispatchAuthority();
        }
      };

      const checkpointOutcome = async (): Promise<DispatchResult | undefined> => {
        await checkpoint.join();
        if (!checkpoint.exhausted()) return undefined;
        checkpointPaused = true;
        settledOutcome = "failed";
        this.deps.subagentRegistry?.markCheckpointPaused(agentId);
        checkpoint.retain(
          async (text) => {
            await session!.sendCustomMessage!({
              customType: "picc-subagent-recovery-input",
              content: text,
              display: false,
            }, { triggerTurn: true });
            return classifyCompletedTurn();
          },
          retainedCleanup,
        );
        return {
          ok: false,
          outcome: "failed",
          finalMessage: "",
          agentId,
          transcriptPath,
          resumable: false,
          agentName: agent.name,
          worktreePath,
          isFork,
          usage: captureUsage(),
          checkpointPaused: true,
          error: checkpoint.failureMessage(),
          diagnostics,
        };
      };

      async function classifyCompletedTurn(): Promise<DispatchResult> {
        const paused = await checkpointOutcome();
        if (paused) return paused;
        if (checkpoint.consumeStoppedRun()) {
          settledOutcome = "aborted";
          return {
            ok: false, outcome: "aborted", finalMessage: "", agentId, transcriptPath,
            resumable, agentName: agent.name, worktreePath, isFork, usage: captureUsage(),
            retainedInputReport: checkpoint.report(),
            error: `Subagent "${agent.name}" was stopped by a universal hook.`, diagnostics,
          };
        }
        const terminal = terminalOutcome();
        if (terminal) return terminal;

        // The returned assistant text is a verbatim contract: callers may parse
        // strict JSON/YAML, so classification must not summarize or wrap it.
        let finalMessage = lastAssistantText(session!);
        // Retry only a genuinely successful empty reply. terminalOutcome() above
        // has already classified API errors/aborts, which must not be re-prompted.
        if (!finalMessage.trim()) {
          await session!.prompt(
            "Your previous reply was empty. Reply now with your final answer in the requested format.",
          );
          const retryPaused = await checkpointOutcome();
          if (retryPaused) return retryPaused;
          const retryTerminal = terminalOutcome();
          if (retryTerminal) return retryTerminal;
          finalMessage = lastAssistantText(session!);
          diagnostics.push({ severity: "info", message: "subagent returned empty; retried once" });
        }

        // SubagentStop continuation is part of the same logical recovery
        // generation, so the awaiting SendMessage owns its eventual result too.
        for (let iteration = 0; ; iteration++) {
          const stopOutcome = await fireSubagentStop({
            subagent_type: agent.name,
            cwd: subCwd.get(),
            stop_hook_active: iteration > 0,
          });
          stopFired = true;
          // A parent abort racing the awaited hook still wins: returning the
          // previously completed text here would leak a false success past cancellation.
          if (opts.abortSignal?.aborted) {
            settledOutcome = "aborted";
            return {
              ok: false, outcome: "aborted", finalMessage: "", agentId, transcriptPath,
              resumable, agentName: agent.name, worktreePath, isFork, usage: captureUsage(),
              retainedInputReport: checkpoint.report(),
              error: `Subagent "${agent.name}" was aborted before completing its task.`, diagnostics,
            };
          }
          if (stopOutcome?.stop) {
            const reason = stopOutcome.stopReason ?? "SubagentStop hook requested stop";
            diagnostics.push({ severity: "warning", message: reason });
            try { void Promise.resolve(session!.abort?.()).catch(() => undefined); } catch { /* stop remains final */ }
            settledOutcome = "aborted";
            return {
              ok: false, outcome: "aborted", finalMessage: "", agentId, transcriptPath,
              resumable, agentName: agent.name, worktreePath, isFork, usage: captureUsage(),
              retainedInputReport: checkpoint.report(),
              error: `Subagent "${agent.name}" was stopped by its SubagentStop hook: ${reason}`,
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
          await session!.prompt(
            `[SubagentStop hook] Continue working: ${stopOutcome.blockReason ?? "the stop condition is not met yet"}`,
          );
          const continuationPaused = await checkpointOutcome();
          if (continuationPaused) return continuationPaused;
          const continuationTerminal = terminalOutcome();
          if (continuationTerminal) return continuationTerminal;
          finalMessage = lastAssistantText(session!);
        }

        // Preserve the actual assistant turn before display-only cut-off decoration
        // so registry/render deduplication still keys on provider output identity.
        settledAssistantIdentityText = finalMessage;
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
          ok: true, outcome: "completed", finalMessage, agentId, transcriptPath, resumable,
          truncated: cutOff, isFork, agentName: agent.name, worktreePath,
          usage: captureUsage(), diagnostics,
        };
      }

      const promptRun = session.prompt(fullPrompt);
      const recoveryRegistry = this.deps.compactionCancellationRecovery?.registry;
      if (recoveryRegistry) {
        let unsubscribe: () => void = () => {};
        const quarantined = new Promise<"quarantined">((resolve) => {
          const observe = () => {
            if (recoveryRegistry.get(agentId)?.checkpointQuarantined) {
              unsubscribe();
              resolve("quarantined");
            }
          };
          unsubscribe = recoveryRegistry.onChange(observe);
          observe();
        });
        const ending = await Promise.race([
          promptRun.then(() => "settled" as const),
          quarantined,
        ]);
        unsubscribe();
        if (ending === "quarantined") {
          checkpointPaused = true;
          settledOutcome = "failed";
          void promptRun.catch(() => undefined);
          return {
            ok: false, outcome: "failed", finalMessage: "", agentId, transcriptPath,
            resumable: false, agentName: agent.name, worktreePath, isFork,
            usage: captureUsage(), checkpointPaused: true,
            retainedInputReport: checkpoint.report(),
            error: checkpoint.failureMessage(), diagnostics,
          };
        }
      } else {
        await promptRun;
      }
      return await classifyCompletedTurn();
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
        ...(dispatchCheckpoint?.isQuarantined()
          ? { retainedInputReport: dispatchCheckpoint.report() }
          : {}),
        error: `Subagent "${agent.name}" failed: ${capErrorText((err as Error)?.message ?? String(err))}`,
        diagnostics,
      };
    } finally {
      // Capture while the public session is still live: dispose may release the
      // aggregate stats that failed/aborted results still need to report.
      captureUsage();
      if (!checkpointPaused) {
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
        try {
          recoveryUnsub?.();
        } catch {
          // unsubscribe must not mask results
        }
        try {
          session?.dispose();
        } catch {
          // dispose failures must not mask results
        }
        this.deps.subagentRegistry?.markSettled(agentId, {
          outcome: settledOutcome,
          usage: capturedUsage,
          // Sanitized+capped by the registry; conversation content, never for
          // error/log interpolation.
          finalText: settledFinalText,
          assistantIdentityText: settledAssistantIdentityText,
        });
        // A resumed run reused a worktree owned by its original dispatch and
        // must not unlock or release ownership it never acquired.
        if (worktreePath && this.deps.worktrees && !opts.resume) {
          await this.deps.worktrees.exit({ worktreePath, action: "keep" }).catch(() => undefined);
        }
        // Error/abort paths still fire SubagentStop once for observability;
        // blocking is moot because no continuation can safely recover this dispatch.
        if (started && !stopFired) {
          await fireSubagentStop({
            subagent_type: agent.name,
            cwd: dispatchCwd?.get() ?? this.deps.getCwd(),
          }).catch(() => undefined);
        }
        // The dispatch and its final lifecycle hooks are now truly settled.
        // Physical agent_settled events during checkpoint/reentry never rotate it.
        settleDispatchAuthority();
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
 * `failure` is thrown or folded into an error channel. Successful results may
 * carry an identity trailer; failed results may carry disposition-dependent
 * recovery guidance. For a partial failure, trusted guidance follows the
 * untrusted partial-output/cause cut-off frame. The consumer owns only the
 * surrounding `details` (identity/usage/outcome/error) and the actual
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
 * `allowResumeTrailer` (default `true`) controls only successful-result identity
 * trailers. Passing `false` preserves completed output bytes without a trailer.
 */
export function presentDispatchResult(
  result: DispatchResult,
  opts?: { allowResumeTrailer?: boolean },
): DispatchPresentation {
  const withTrailer = result.resumable && opts?.allowResumeTrailer !== false;
  const finalMessage = result.finalMessage ?? "";
  const agentId = isAgentId(result.agentId) ? result.agentId : undefined;
  const guidanceInput = result.recoveryDisposition === "resume-preferred"
    ? result.resumable
      ? { disposition: result.recoveryDisposition, agentId, resumable: true } as const
      : undefined
    : result.recoveryDisposition === "progressed-non-resumable"
      ? !result.resumable
        ? { disposition: result.recoveryDisposition, agentId, resumable: false } as const
        : undefined
      : result.recoveryDisposition === "fresh-dispatch-preferred"
        ? { disposition: result.recoveryDisposition, agentId, resumable: result.resumable } as const
        : undefined;
  const recoveryGuidance = guidanceInput
    ? formatSubagentRecoveryGuidance(guidanceInput)
    : undefined;
  const neutralIdentity = result.outcome === "failed" && result.terminalAssistantError === true &&
      result.resumable && agentId && !recoveryGuidance
    ? `Agent ID: ${agentId}.`
    : undefined;

  // Failed partial output keeps its existing provider-output/cause cut-off frame
  // intact. Trusted PiCC recovery framing follows outside that untrusted channel.
  if (result.outcome === "failed" && finalMessage.trim()) {
    const cut = appendCutOffNote(finalMessage, result.error ?? DEFAULT_CUT_OFF_NOTE);
    return {
      kind: "result",
      text: recoveryGuidance
        ? `${cut}\n${recoveryGuidance}`
        : neutralIdentity
          ? `${cut}\n${neutralIdentity}`
          : cut,
      cutOff: true,
    };
  }

  // Failed with no partial output, or aborted, stays in the failure channel.
  if (!result.ok) {
    const base = result.error ?? "subagent failed";
    return {
      kind: "failure",
      message: recoveryGuidance
        ? `${base}\n\n${recoveryGuidance}`
        : neutralIdentity
          ? `${base}\n\n${neutralIdentity}`
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
    /**
     * The DISPATCHER's own live working directory. When this Agent/Task tool is
     * handed to a subagent, this returns that subagent's current cwd (its
     * dispatch-local `subCwd` — the worktree it may have entered), so a fresh
     * nested dispatch begins where its parent is working rather than at the
     * orchestrator's cwd. Read at dispatch time so a mid-run worktree entry is
     * reflected. Absent for the coordinator instance, whose dispatches keep the
     * orchestrator cwd. Never sourced from a tool parameter.
     */
    dispatchCwd?: () => string;
    /** Captures opaque stop authority for the dispatching logical run. */
    captureUniversalStop?: () => () => boolean;
    /** Dormant canonical retained-outcome presentation; production omits it until assembled activation. */
    retainedOutcomes?: { registry: SubagentRegistry };
  },
): Record<string, unknown> {
  return {
    name: opts.name ?? "Agent",
    label: "Agent",
    description:
      "Launch a subagent to handle a task. Pick subagent_type from the 'Available subagents' catalog by matching the task to the agent descriptions (omit it for a general-purpose agent). Background by default: work is accepted immediately and runs when configured concurrency capacity is available; collect its result with TaskOutput before you rely on it or finalize an answer. CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is the exception: it forces dispatches to run in the foreground. If the latest task generation for an agent settles and remains uncollected and unnotified when a later interactive turn starts, it gets one bounded notice; a running TaskOutput poll preserves eligibility, while terminal collection suppresses a not-yet-sent notice. Pass run_in_background: false for a synchronous run that blocks this turn and returns the subagent's final message verbatim inline.",
    parameters: Type.Object({
      subagent_type: Type.String({ description: "Name of the agent to dispatch" }),
      prompt: Type.String({ description: "The task for the subagent" }),
      model: Type.Optional(
        Type.String({ description: "Model override as provider/model (rarely needed)" }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description:
            "Background is the default: omit (or pass true) to accept the dispatch immediately; it runs when configured concurrency capacity is available and returns a task id to collect with TaskOutput. CLAUDE_CODE_DISABLE_BACKGROUND_TASKS is the exception and forces foreground execution. The latest generation gets one bounded later-interactive-turn notice only if it settles and remains uncollected and unnotified; a running poll preserves eligibility, while terminal collection suppresses a not-yet-sent notice. Pass false for a synchronous run that blocks this turn and returns the final message inline.",
        }),
      ),
      description: Type.Optional(
        Type.String({
          description:
            "Short (3-5 word) human-readable task label, shown in the UI while the subagent runs (e.g. \"Review auth changes\")",
        }),
      ),
    }),
    // Pending display is mode-neutral and result ownership is shared through
    // Pi's per-call renderer state.
    renderCall(
      args: Record<string, unknown>,
      theme: unknown,
      context: SubagentLifecycleRenderContext,
    ) {
      return renderAgentCall(args, theme, context, {
        surface: "agent",
        resolveAgentColor: (agentId, agentName) => runtime.agentDisplayColor(agentId, agentName),
      });
    },
    // Result display owns normal rows once a partial or final result exists;
    // expansion retains full output and transcript access.
    renderResult(
      result: { content?: Array<{ type: string; text: string }>; details?: SubagentRenderDetails },
      options: { expanded?: boolean; isPartial?: boolean },
      theme: unknown,
      context: SubagentLifecycleRenderContext,
    ) {
      return renderAgentResult(result, options, theme, context, {
        surface: "agent",
        resolveAgentColor: (agentId, agentName) => runtime.agentDisplayColor(agentId, agentName),
      });
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (update: {
        content: Array<{ type: string; text: string }>;
        details?: Record<string, unknown>;
      }) => void,
      ctx?: { abort?: () => void; mode?: "tui" | "print" | "json" | "rpc" },
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
      const capturedStop = opts.captureUniversalStop?.();
      const dispatchOpts = {
        subagentType,
        captureUniversalStop: capturedStop
          ? () => {
              const accepted = capturedStop();
              if (accepted) {
                try { ctx?.abort?.(); } catch { /* opaque stop authority remains final */ }
              }
              return accepted;
            }
          : undefined,
        prompt: String(params.prompt ?? ""),
        model: params.model ? String(params.model) : undefined,
        depth: opts.depth + 1,
        headless: ctx?.mode !== "tui",
        // Propagate the runtime-set marker onto EVERY dispatch this tool
        // makes (spread into both the background and foreground arms below), so a
        // fork's own Agent/Task tool refuses a nested `subagent_type: "fork"`.
        dispatcherIsFork: opts.dispatcherIsFork,
        // Parent link for the panel tree: the dispatcher's own id (undefined
        // for the coordinator) — the same runtime-set channel as ownerAgentId,
        // never a tool parameter.
        parentAgentId: opts.ownerAgentId,
        // The dispatching subagent's live cwd, resolved NOW (dispatch time) so a
        // worktree the parent entered mid-run is captured. A fresh nested dispatch
        // starts here; undefined for a coordinator dispatch (no dispatchCwd), which
        // keeps the orchestrator cwd.
        parentCwd: opts.dispatchCwd?.(),
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
        let admission: SubagentAdmission = "admitted";
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
            onAdmission: (next) => {
              admission = next;
              if (taskId) registry.noteAdmission(taskId, next);
            },
          }),
          async () => {
            controller.abort();
            await runtime.stopCheckpoint(agentId);
          },
          agentId,
          label,
          // Owner tag: the dispatcher's id (a subagent's own id, or
          // undefined for the coordinator) so scoped TaskOutput/TaskStop reach
          // exactly the tasks that dispatcher started.
          opts.ownerAgentId,
          description,
          admission,
        );
        taskId = id;
        // Identity-at-start: the agent id appears for EVERY background
        // task — including one-shot builtins (Explore/Plan) — since the
        // start-message is the only model-visible id delivery in print/RPC mode.
        return {
          content: [
            {
              type: "text",
              text: `Background task ${id} accepted (agent: ${label}, agent id: ${agentId}); it will run when configured concurrency capacity is available. Use TaskOutput with task_id "${id}" to retrieve the result before finalizing.`,
            },
          ],
          details: {
            background: true,
            taskId: id,
            agent: label,
            agentId,
            admission,
            description,
          } satisfies SubagentRenderDetails,
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
              details: {
                subagentProgress: snapshot,
                agent: label,
                live: true,
              } satisfies SubagentRenderDetails,
            });
          }
        : undefined;
      const dispatchedAtMs = Date.now();
      const result = await runtime.dispatch({
        ...dispatchOpts,
        abortSignal: signal,
        onProgress,
      });
      const settledAt = Date.now();
      const durationMs = settledAt - dispatchedAtMs;
      const timing =
        Number.isFinite(dispatchedAtMs) &&
        Number.isFinite(settledAt) &&
        Number.isFinite(durationMs) &&
        durationMs >= 0
          ? { durationMs, settledAt }
          : {};
      // Structured identity fields for every content-returning path. Details are
      // logs/UI-only; model-visible identity is handled separately by successful
      // trailers, disposition-dependent guidance, or neutral ordinary-failure metadata.
      const identityDetails = {
        agentId: result.agentId,
        transcriptPath: result.transcriptPath,
        resumable: result.resumable,
        // Usage metadata: populates the renderResult footer usage line
        // (formatUsageLine → formatUsageCompact). details is logs/UI-only — never
        // the model-visible content, so the verbatim-return contract is untouched.
        usage: result.usage,
        description,
        // Panel-registry timestamps are private to the runtime; one local
        // completion clock keeps duration and settlement instant in agreement.
        ...timing,
      } satisfies SubagentRenderDetails;
      const retainedReport = opts.retainedOutcomes?.registry.get(result.agentId)?.retainedInputReport;
      const canonicalReport = retainedReport && retainedReport === result.retainedInputReport
        ? retainedReport
        : undefined;
      const retainedText = canonicalReport ? formatRetainedInputReport(canonicalReport) : undefined;
      const retainedDetails = canonicalReport ? {
        retainedOutcome: true,
        reportId: canonicalReport.reportId,
        occurrences: canonicalReport.occurrences,
        representedCount: canonicalReport.occurrences.length,
        unrepresentableCount: canonicalReport.unrepresentableCount,
        retainedCount: retainedInputCount(canonicalReport),
      } : {};
      // Claude 2.1.200 outcome→presentation mapping: successful identity
      // trailers, failed guidance or neutral identity metadata, cut-off framing,
      // and throw-vs-return decisions live in the shared, pure
      // `presentDispatchResult` helper. Trusted guidance follows outside any
      // untrusted partial-output/cause frame. The fork path consumes the same
      // helper for byte-identical framing; `details`
      // (identity/usage/outcome/error/note) stays this consumer's job.
      const presentation = presentDispatchResult(result);
      if (presentation.kind === "failure") {
        // Failed with no output ("Agent terminated early due to an API error: ...",
        // or a pre-start failure naming its cause) and aborted runs (distinct
        // wording naming the abort) both surface on the isError channel.
        // Failed recovery guidance is disposition-dependent; a cause-only ordinary
        // error may expose neutral stable identity without turning it into advice.
        throw new Error(retainedText
          ? `${presentation.message}\n\n${retainedText}`
          : presentation.message);
      }
      // A `kind:"result"` with outcome "failed" is necessarily the cut-off case:
      // presentDispatchResult only routes failed-WITH-partial to `result` (aborted
      // and failed-no-output become `kind:"failure"` above). This mirrors the
      // helper's own branch guard — keep the two in sync if that guard changes.
      if (result.outcome === "failed") {
        // failed WITH partial output → success-shaped cut-off result: untrusted
        // partial output and cause stay in the delimited frame, while any trusted,
        // disposition-dependent recovery guidance follows outside it.
        return {
          content: [{ type: "text", text: retainedText ? `${presentation.text}\n\n${retainedText}` : presentation.text }],
          details: {
            agent: result.agentName,
            ...retainedDetails,
            worktreePath: result.worktreePath,
            diagnostics: result.diagnostics,
            outcome: result.outcome,
            cutOff: presentation.cutOff,
            error: result.error,
            ...identityDetails,
          } satisfies SubagentRenderDetails,
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
        content: [{ type: "text", text: retainedText ? `${presentation.text}\n\n${retainedText}` : presentation.text }],
        details: {
          agent: result.agentName,
          ...retainedDetails,
          worktreePath: result.worktreePath,
          diagnostics: result.diagnostics,
          outcome: result.outcome,
          // A turn-capped SUCCESS is truncated — surface it so the lifecycle row
          // renders `completed (truncated)` instead of a clean completed state
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
        } satisfies SubagentRenderDetails,
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
      "Send a follow-up message to a subagent you previously dispatched. Address it by its agent id (agent-…) or name (`to`). A finished subagent resume is accepted in the background and runs when configured concurrency capacity is available; only a still-running, admitted, steerable background subagent receives the message as a mid-task course correction. Ordinarily this returns an acknowledgment and a resumed run's result arrives via TaskOutput. Checkpoint-paused exception: the awaited call recovers the retained agent and returns its result directly, with no TaskOutput or new task generation.",
    parameters: Type.Object({
      to: Type.String({
        description: "Agent id (e.g. agent-3fa9c2d1b4e5) or the agent name from a prior dispatch",
      }),
      message: Type.String({
        description: "The follow-up instruction, delivered to the agent verbatim as a user turn",
      }),
    }),
    renderCall(
      args: Record<string, unknown>,
      theme: unknown,
      context: SubagentLifecycleRenderContext,
    ) {
      return renderSendMessageCall(args, theme, context);
    },
    renderResult(
      result: { content?: Array<{ type?: string; text?: string }>; details?: Record<string, unknown> },
      _options: Record<string, unknown>,
      theme: unknown,
      context: SubagentLifecycleRenderContext,
    ) {
      return renderSendMessageResult(result, theme, context);
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: { mode?: "tui" | "print" | "json" | "rpc" },
    ) {
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
      if (record.checkpointQuarantined) {
        throw new Error(quarantineRefusal(record, "message/recovery"));
      }

      // A checkpoint-paused record is "running" only because it retains the
      // exact guarded session. This coordinator-authenticated path deliberately
      // precedes ordinary one-shot steering refusal; normal one-shot steer/resume
      // remains forbidden below.
      if (record.state === "running" && record.checkpointPaused) {
        const recover = record.session?.recoverCheckpoint;
        if (!recover) {
          throw new Error(`Agent ${record.agentId} ("${record.agentName}") lost its live checkpoint recovery adapter; stop it and dispatch a new agent.`);
        }
        const result = await recover(message);
        const text = result.outcome === "completed"
          ? result.finalMessage
          : [result.error ?? `Subagent "${record.agentName}" ${result.outcome}.`, result.finalMessage]
              .filter(Boolean)
              .join("\n\n");
        return rememberSendMessageResult({
          content: [{ type: "text", text }],
          details: {
            agentId: record.agentId,
            agent: record.agentName,
            delivery: "checkpoint-recovery",
            outcome: result.outcome,
            recovered: result.outcome === "completed",
            truncated: result.truncated === true,
          },
        }, to);
      }

      // Running background dispatch → steer (mid-task course correction). The
      // refusal predicates (one-shot, user-stopped, no live steerable handle)
      // live in the shared guardSteer — the same guard the panel drill-down
      // steer calls — so the two surfaces cannot drift.
      if (record.state === "running") {
        const guard = guardSteer(record, "send-message");
        if (!guard.ok) throw new Error(guard.refusal);
        await Promise.resolve(guard.steer(message));
        return {
          content: [
            {
              type: "text",
              text: `Message delivered to running agent ${record.agentId} ("${record.agentName}") as a mid-task course correction.`,
            },
          ],
          details: {
            agentId: record.agentId,
            agent: record.agentName,
            description: record.description,
            delivery: "steer",
          } satisfies SubagentRenderDetails,
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
      let admission: SubagentAdmission = "admitted";
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
          headless: ctx?.mode !== "tui",
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
          onAdmission: (next) => {
            admission = next;
            if (taskId) opts.backgroundTasks.noteAdmission(taskId, next);
          },
        }),
        async () => {
          controller.abort();
          await runtime.stopCheckpoint(record.agentId);
        },
        record.agentId,
        agentLabel,
        undefined,
        record.description,
        admission,
      );
      taskId = id;
      const identity = formatBackgroundTaskIdentity(id, record.agentName, record.agentId);
      const retainedGuidance = record.retainedInputReport
        ? ` Reported input was not auto-replayed. The unchanged canonical report remains at ${taskOutputAgentLocator(record.agentId)}; inspect possible existing effects before this deliberate retry.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `${identity} — resume accepted in background with prior context; it will run when configured concurrency capacity is available. Retrieve it with TaskOutput (task_id "${id}").${retainedGuidance}`,
          },
        ],
        details: {
          agentId: record.agentId,
          agent: record.agentName,
          taskId: id,
          admission,
          description: record.description,
          delivery: "resume",
          resumed: true,
        } satisfies SubagentRenderDetails,
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

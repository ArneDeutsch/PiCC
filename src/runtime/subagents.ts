import { randomUUID } from "node:crypto";
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
import type { BackgroundTaskRegistry } from "./background-tasks.js";
import {
  agentTrailerFrame,
  agentTrailerLine,
  isAgentId,
  mintAgentId,
  subagentSessionDir,
} from "../util/subagent-transcripts.js";

/**
 * Subagent dispatch runtime (plan §4.3): spawns fresh-context Pi sessions per dispatch,
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
   * `subCwd` is the dispatch-local cwd state — tools must resolve against it, not the
   * orchestrator's cwd, or worktree-isolated agents search the wrong checkout.
   */
  customToolsFor: (
    agent: ClaudeAgent,
    grantedClaudeNames: string[],
    depth: number,
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
   * Builds a per-dispatch HookRunner for an agent's frontmatter `hooks:`
   * (audit C10) — same deps as the session's main runner. The scoped runner
   * fires only for that subagent's dispatch and is discarded when it ends.
   * Its `transcript_path` stays the MAIN session transcript (Claude Code
   * parity, t02 review round 2): PiCC does NOT re-point subagent hook events
   * at the subagent's own transcript.
   */
  makeScopedHookRunner?: (config: HookConfig) => HookRunner;
  /**
   * MAIN session transcript file (late-bound; undefined in print/no-session
   * modes and tests). Subagent transcripts persist in a sibling directory
   * derived from it (t02); without it, dispatch degrades to in-memory.
   */
  getMainSessionFile?: () => string | undefined;
  worktrees?: WorktreeManagerLike;
  maxDepth: number;
  concurrency: number;
  sessionId: string;
  /** Injected for testability; defaults to the real Pi SDK. */
  sdk?: PiSdk;
  log?: (message: string) => void;
}

/** Structural view of a Pi SessionManager (only what dispatch reads). */
export interface PiSessionManagerLike {
  getSessionFile(): string | undefined;
}

export interface PiSdk {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSession }>;
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> };
  inMemorySessionManager(cwd: string): unknown;
  /**
   * Persisted session manager in a custom directory with a pinned session id
   * (t02: subagent transcripts — Pi names the file `<stamp>_<id>.jsonl`).
   * Optional: when absent, dispatch degrades to in-memory (non-resumable).
   */
  persistedSessionManager?(cwd: string, sessionDir: string, id: string): PiSessionManagerLike;
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
}

/** Classified fate of a dispatch. Mirrored by `BackgroundResultLike` (t01 contract). */
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
   * Opaque dispatch identity (t02): unique per agent, stable across resumes —
   * a resume (t04) reuses the ID and appends to the same transcript.
   */
  agentId: string;
  /** On-disk JSONL transcript of the subagent's session, when persisted. */
  transcriptPath?: string;
  /**
   * True when this agent can be continued under `agentId` (persisted
   * transcript; not a one-shot builtin like Explore/Plan; not the in-memory
   * fallback). t04's SendMessage refuses non-resumable IDs cleanly.
   */
  resumable: boolean;
  /**
   * True when `finalMessage` was cut at the model's output token limit (stop
   * reason "length") and already carries the t01 cut-off frame. The model-visible
   * trailer then rides INSIDE that existing frame instead of opening a second one.
   */
  truncated?: boolean;
  agentName?: string;
  worktreePath?: string;
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
    // Persisted subagent transcript (t02): Pi validates the id and names the
    // file `<stamp>_<id>.jsonl` in the custom directory (created on demand).
    persistedSessionManager: (cwd: string, sessionDir: string, id: string) =>
      m.SessionManager.create(cwd, sessionDir, { id }),
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
 * scoped runner (audit C10) — same pattern as index.ts's HookMultiplexer,
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
  private sdkPromise: Promise<PiSdk> | undefined;

  constructor(private readonly deps: SubagentRuntimeDeps) {
    this.semaphore = new Semaphore(Math.max(1, deps.concurrency));
  }

  private sdk(): Promise<PiSdk> {
    if (this.deps.sdk) return Promise.resolve(this.deps.sdk);
    this.sdkPromise ??= loadRealSdk();
    return this.sdkPromise;
  }

  /**
   * Resolve a requested subagent name to its definition via the shared 3-step
   * chain: project/user/plugin agents by exact name, then case-insensitive
   * name, then built-ins. `dispatch()` prepends its `agentOverride`;
   * `isOneShotBuiltin()` uses the bare chain — both route through here so the
   * resolution order can never desync between them (t02 review round 2).
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
   * future third one-shot builtin can't desync them (t02 review round 2).
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
   * an agent id (t02): one-shot builtins get no id segment (t04 would refuse a
   * follow-up).
   */
  isOneShotBuiltin(subagentType: string): boolean {
    const requested = subagentType.trim() || "general-purpose";
    return this.isOneShot(this.resolveAgentDefinition(requested));
  }

  async dispatch(opts: {
    subagentType: string;
    prompt: string;
    model?: string;
    /** Effort override (e.g. a context:fork skill's `effort:`); defaults to the agent's. */
    effort?: string;
    depth: number;
    /**
     * Dispatch this agent definition directly instead of looking subagentType up —
     * used for the synthetic general-purpose target of agent-less context:fork skills.
     */
    agentOverride?: ClaudeAgent;
    /** Cooperative abort (TaskStop, audit E4): best-effort session.abort() when signaled. */
    abortSignal?: AbortSignal;
    /**
     * Pre-minted agent ID (t02): the background Agent tool mints it up front so
     * the start message can carry it; t04 passes an existing ID on resume.
     */
    agentId?: string;
  }): Promise<DispatchResult> {
    const diagnostics: Diagnostic[] = [];
    // Caller-provided agent ID hardening (t02, pre-t04): a resume/model-derived
    // ID (t04 feeds these) MUST be the minted `agent-<12 hex>` form. A hostile or
    // malformed value fails the dispatch loudly (t01 semantics) — never silently
    // minted-over or passed through to the session/filesystem path.
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
    // Agent identity (t02): minted here unless the caller pre-minted/reuses one.
    // Every exit path carries it, so mirrors (background records) stay keyed.
    const agentId = opts.agentId ?? mintAgentId();
    const agents = this.deps.getAgents();
    // Built-ins resolve AFTER project/user/plugin agents (audit E1): a project
    // agent named Explore overrides the built-in. Empty/omitted subagent_type
    // defaults to general-purpose (audit E2).
    const builtins = builtinAgents();
    const requested = opts.subagentType.trim() || "general-purpose";
    // Shared resolver (t02 review round 2): one home for the resolution order so
    // isOneShotBuiltin() can't desync from this dispatch's settled resumability.
    const resolved = opts.agentOverride ?? this.resolveAgentDefinition(requested);
    // Claude fallback (review H1): an unknown subagent_type runs as
    // general-purpose instead of hard-erroring — with a VISIBLE degrade in
    // both the diagnostics and the subagent's own prompt.
    const agent = resolved ?? resolveAgent(builtins, "general-purpose");
    let prompt = opts.prompt;
    if (!resolved && agent) {
      diagnostics.push({
        severity: "warning",
        message: `unknown subagent_type "${requested}"; ran as general-purpose`,
      });
      prompt = `(You were dispatched as subagent type "${requested}", which is not defined in this project; you are running as a general-purpose agent.)\n\n${opts.prompt}`;
    }
    if (!agent) {
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
    if (opts.depth > this.deps.maxDepth) {
      return {
        ok: false,
        outcome: "failed",
        finalMessage: "",
        agentId,
        resumable: false,
        agentName: agent.name,
        error: `Subagent nesting depth ${opts.depth} exceeds the configured maximum of ${this.deps.maxDepth}.`,
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

    // Transcript persistence state (t02): the transcript path only exists once
    // the session manager is created (below); it is carried on the
    // DispatchResult and drives `resumable`. Parity (review round 2): subagent
    // hook events are NOT re-pointed to it — they keep the main transcript_path.
    let transcriptPath: string | undefined;
    let resumable = false;
    // Built-in one-shot agents (Explore/Plan) are never resumable — the flag
    // travels with the ID so t04 can refuse. A same-named PROJECT agent is a
    // normal agent (it resolves first and lacks the builtin marker).
    const oneShot = this.isOneShot(agent);

    // Agent-scoped hooks (audit C10): frontmatter `hooks:` dispatch while THIS
    // subagent runs. The scoped runner is multiplexed with the session runner
    // for the dispatch's guard and Subagent* events and discarded when it ends.
    let scopedHooks: HookRunner | undefined;
    if (
      this.deps.makeScopedHookRunner &&
      agent.hooks &&
      Object.values(agent.hooks).some((entries) => entries?.length)
    ) {
      const parsed = parseHookConfig(agent.hooks, agent.source.path);
      diagnostics.push(...parsed.diagnostics);
      if (Object.keys(parsed.config).length > 0) {
        // Parity (t02 review round 2): the scoped runner keeps the MAIN session
        // transcript_path — subagent hook events must NOT be re-pointed at the
        // subagent's own transcript (Claude Code behavior).
        scopedHooks = this.deps.makeScopedHookRunner(parsed.config);
        diagnostics.push({
          severity: "info",
          message: `agent-scoped hooks active for "${agent.name}" (${Object.keys(parsed.config).join(", ")})`,
        });
      }
    }
    if (scopedHooks) {
      // Agent-hook `systemMessage`s are user-facing (review H4): surface each
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
    // Central identity injection (t02): agent_id AND agent_type (the agent's
    // name) ride on EVERY hook payload fired within this dispatch — the guard's
    // PreToolUse/PostToolUse fired from inside the subagent, SubagentStart, and
    // SubagentStop/Stop — so the subagent identity can't drift per fire site
    // (Claude Code hook input carries both). One choke point wrapping each raw
    // runner. transcript_path is deliberately NOT injected — parity (review
    // round 2): subagent hook events keep the MAIN session transcript_path (the
    // runner's own constructed default), never the subagent's own file.
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
      // Parity (t02 review round 2): the Stop payload carries NO transcript_path.
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

    // Only root-level dispatches count against the concurrency cap. An ancestor
    // holds its slot while awaiting its descendants, so counting nested dispatches
    // too would deadlock the moment `concurrency` ancestors each await a queued
    // child (guaranteed at concurrency 1 for ANY depth-2 nesting).
    const release = opts.depth > 1 ? () => {} : await this.semaphore.acquire();
    let worktreePath: string | undefined;
    let session: PiSession | undefined;
    let started = false;
    let stopFired = false;
    let abortListener: (() => void) | undefined;
    try {
      if (opts.abortSignal?.aborted) {
        // Re-check after the semaphore wait (review H3): a TaskStop issued while
        // the dispatch was queued must not burn a full session. Informational
        // SubagentStop matches the error-path pattern; finally releases the slot.
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
          // transcript may not exist yet — item 6).
          subagent_type: agent.name,
          prompt,
          cwd: this.deps.getCwd(),
        })
        .catch(() => undefined);
      if (startOutcome?.block) {
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
      if (agent.isolation === "worktree" && this.deps.worktrees) {
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
        // Re-check after worktree entry (review H3): a stop during enter() must
        // not spin up the session. The finally keep-exits the worktree.
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
      // Dispatch-local cwd state: the subagent's tools (and its own EnterWorktree
      // use) must never swap the ORCHESTRATOR's cwd.
      const subCwd = new CwdState(cwd);

      const granted = this.deps.permissionEngine.gateTools(
        agent.tools,
        agent.disallowedTools,
        this.deps.allKnownToolNames(),
      );
      const piBuiltins = claudeToolsToPiBuiltins(granted);
      const customTools = this.deps.customToolsFor(agent, granted, opts.depth, subCwd);

      const sdk = await this.sdk();
      const injector = this.deps.makeContextInjector
        ? this.deps.makeContextInjector(() => subCwd.get())
        : this.deps.contextForTouchedFile;
      const guard = createGuardExtension({
        engine: this.deps.permissionEngine,
        // Multiplexed runner (C10): the agent's scoped PreToolUse/PostToolUse/
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

      // Model resolution order (audit E5): CLAUDE_CODE_SUBAGENT_MODEL env beats
      // the per-invocation `model` param, which beats agent frontmatter `model:`,
      // which beats the session model. "inherit"/empty env value = unset.
      const envModelRaw = process.env.CLAUDE_CODE_SUBAGENT_MODEL?.trim();
      const envModel =
        envModelRaw && envModelRaw.toLowerCase() !== "inherit" ? envModelRaw : undefined;
      const modelSpec = envModel ?? opts.model ?? agent.model;
      let model = this.deps.resolveModel(modelSpec);
      if (modelSpec && model === undefined) {
        // Visible degrade (§2.2): inherit the session model rather than silently
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

      // Persisted subagent transcript (t02): one JSONL per dispatch, named by
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
      if (mainSessionFile && sdk.persistedSessionManager) {
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

      // Cooperative stop (audit E4): a TaskStop-triggered signal aborts the
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

      this.deps.log?.(`dispatch ${agent.name} (depth ${opts.depth})`);
      const fullPrompt = agent.initialPrompt
        ? `${agent.initialPrompt}\n\n${prompt}`
        : prompt;

      // Post-prompt() classification (t01): Pi's prompt() resolves NORMALLY on a
      // terminal LLM failure — the failure lives on the last assistant message as
      // stopReason "error"/"aborted". Called after every prompt() so the retry and
      // SubagentStop-loop re-prompts are classified too.
      const live = session;
      let truncated = false;
      let truncationDiagnosed = false;
      const terminalOutcome = (): DispatchResult | undefined => {
        const last = lastAssistantMessage(live);
        if (last?.stopReason === "error") {
          return {
            ok: false,
            outcome: "failed",
            // Best-effort partial output: whatever assistant text exists post-run
            // (compaction inside prompt() may have rewritten earlier turns).
            finalMessage: assistantTextSoFar(live),
            agentId,
            transcriptPath,
            // A failed-but-persisted agent stays resumable: the coordinator may
            // follow up / retry it with its prior context (t04 decides).
            resumable,
            agentName: agent.name,
            worktreePath,
            error: `Agent terminated early due to an API error: ${capErrorText(last.errorMessage ?? "unknown error")}`,
            diagnostics,
          };
        }
        if (last?.stopReason === "aborted" || opts.abortSignal?.aborted) {
          return {
            ok: false,
            outcome: "aborted",
            finalMessage: "",
            agentId,
            transcriptPath,
            resumable,
            agentName: agent.name,
            worktreePath,
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

      // One-retry-on-empty convention (plan §4.3): a single re-prompt when nothing
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

      // SubagentStop validation loop (plan §4.5 "don't stop until validated"):
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
          // Abort-race consistency (t01 review): a signal firing during
          // SubagentStop-hook evaluation classifies aborted — the same way a
          // signal firing while prompt() settles does (terminalOutcome). Aborted
          // results are discarded by contract, so breaking out to a
          // completed-looking result here would leak past the abort.
          return {
            ok: false,
            outcome: "aborted",
            finalMessage: "",
            agentId,
            transcriptPath,
            resumable,
            agentName: agent.name,
            worktreePath,
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

      // A truncated completion ends with the t01 cut-off frame; `cutOff` records
      // that so the model-visible ID trailer rides INSIDE that frame instead of
      // opening a second `---` frame (t02 review item 4).
      const cutOff = truncated && finalMessage.trim() !== "";
      if (cutOff) {
        finalMessage = appendCutOffNote(
          finalMessage,
          `The reply was truncated at the model's output token limit (stop reason "length"); the output above may be incomplete.`,
        );
      }
      return {
        ok: true,
        outcome: "completed",
        finalMessage,
        agentId,
        transcriptPath,
        resumable,
        truncated: cutOff,
        agentName: agent.name,
        worktreePath,
        diagnostics,
      };
    } catch (err) {
      // Catch-all: covers createAgentSession itself throwing — the "API dead
      // before the session exists" case — and any other dispatch-internal error.
      // Conservative: not resumable (the session may never have run), but the
      // transcript path (when one was allocated) stays visible for diagnosis.
      return {
        ok: false,
        outcome: "failed",
        finalMessage: "",
        agentId,
        transcriptPath,
        resumable: false,
        agentName: agent.name,
        worktreePath,
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
        session?.dispose();
      } catch {
        // dispose failures must not mask results
      }
      if (worktreePath && this.deps.worktrees) {
        // Keep the worktree (the project's own merge flow owns its lifecycle); just unlock.
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
 * The cut-off-note mechanism (t01): partial/truncated subagent output followed
 * by a clearly separated note naming the cause. The note is the ONLY error text
 * ever mixed into the otherwise-verbatim message channel.
 */
function appendCutOffNote(text: string, note: string): string {
  return `${text.replace(/\s+$/, "")}\n\n---\n[subagent cut off] ${note}`;
}

/**
 * Best-effort `maxTurns` enforcement (plan §4.3 tier-up): Pi sessions have no
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
  opts: { depth: number; name?: string; backgroundTasks?: BackgroundTaskRegistry },
): Record<string, unknown> {
  return {
    name: opts.name ?? "Agent",
    label: "Agent",
    description:
      "Launch a subagent to handle a task. Pick subagent_type from the 'Available subagents' catalog by matching the task to the agent descriptions (omit it for a general-purpose agent). Returns the subagent's final message verbatim.",
    parameters: Type.Object({
      subagent_type: Type.String({ description: "Name of the agent to dispatch" }),
      prompt: Type.String({ description: "The task for the subagent" }),
      model: Type.Optional(
        Type.String({ description: "Model override as provider/model (rarely needed)" }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description:
            "Run the dispatch in the background; returns a task id immediately — retrieve the result with TaskOutput",
        }),
      ),
      description: Type.Optional(Type.String({ description: "Short task label (ignored)" })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const subagentType = String(params.subagent_type ?? "");
      const dispatchOpts = {
        subagentType,
        prompt: String(params.prompt ?? ""),
        model: params.model ? String(params.model) : undefined,
        depth: opts.depth + 1,
      };
      const backgroundDisabled = isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);
      if (params.run_in_background === true && !backgroundDisabled && opts.backgroundTasks) {
        // Real background execution (audit E4): the un-awaited dispatch still
        // takes its concurrency slot and fires SubagentStart/Stop hooks; the
        // registry owns its settlement (never an unhandled rejection).
        const controller = new AbortController();
        const label = subagentType.trim() || "general-purpose";
        // Pre-minted agent ID (t02): the start message is the background
        // channel's guaranteed model-visible ID delivery, so it must exist
        // BEFORE the un-awaited dispatch settles.
        const agentId = mintAgentId();
        const id = opts.backgroundTasks.start(
          `agent:${label}`,
          runtime.dispatch({ ...dispatchOpts, agentId, abortSignal: controller.signal }),
          () => controller.abort(),
          agentId,
        );
        // One-shot builtins (Explore/Plan) are non-resumable — advertising an
        // agent id in the start message would falsely invite a SendMessage
        // follow-up (t04 would refuse it). Resumable/non-builtin dispatches keep
        // the id segment. `details.agentId` stays for logs/UI regardless.
        const idSegment = runtime.isOneShotBuiltin(subagentType)
          ? ""
          : `, agent id: ${agentId}`;
        return {
          content: [
            {
              type: "text",
              text: `Background task ${id} started (agent: ${label}${idSegment}). Use TaskOutput with task_id "${id}" to retrieve the result.`,
            },
          ],
          details: { background: true, taskId: id, agent: label, agentId },
        };
      }
      // Foreground: Pi's per-call signal (parent Esc) aborts the dispatch.
      const result = await runtime.dispatch({ ...dispatchOpts, abortSignal: signal });
      // Structured copy of the identity fields for every content-returning path
      // (details is logs/UI-only — the model never sees it, hence the trailer).
      const identityDetails = {
        agentId: result.agentId,
        transcriptPath: result.transcriptPath,
        resumable: result.resumable,
      };
      if (result.outcome === "failed" && result.finalMessage.trim()) {
        // Claude 2.1.200 semantics: real work done before an API death comes back
        // as a SUCCESS result — the partial output plus a clearly separated
        // cut-off note naming the error. Never a normal-looking success.
        // A resumable agent's ID rides in the same delimited frame (t02): the
        // coordinator can follow up on the cut-off run via SendMessage (t04).
        const cut = appendCutOffNote(
          result.finalMessage,
          result.error ?? "The run ended on an API error before completing.",
        );
        return {
          content: [
            {
              type: "text",
              text: result.resumable
                ? `${cut}\n${agentTrailerLine(result.agentId, { completed: false })}`
                : cut,
            },
          ],
          details: {
            agent: result.agentName,
            worktreePath: result.worktreePath,
            diagnostics: result.diagnostics,
            outcome: result.outcome,
            cutOff: true,
            error: result.error,
            ...identityDetails,
          },
        };
      }
      if (!result.ok) {
        // Failed with no output ("Agent terminated early due to an API error: ...",
        // or a pre-start failure naming its cause) and aborted runs (distinct
        // wording naming the abort) both surface on the isError channel.
        // A resumable FAILED-with-no-partial run still delivers its agent ID —
        // the coordinator gets no other channel to it (the background path
        // already delivers the ID on failure; parity here, t02 review item 3).
        // Aborted and non-resumable failures carry no trailer.
        const base = result.error ?? "subagent failed";
        throw new Error(
          result.outcome === "failed" && result.resumable
            ? `${base}${agentTrailerFrame(result.agentId, { completed: false })}`
            : base,
        );
      }
      // Verbatim-return contract (plan §4.3): callers parse finalMessage directly
      // (often a locked YAML block) — compatibility notes belong in details only.
      // Exception (t02 plan-review MUST-FIX): resumable agents get a clearly
      // delimited agent-ID trailer OUTSIDE the verbatim message, in the content
      // the model actually reads — `details` never reaches it. When the
      // completion was truncated it already ends with a `---` cut-off frame, so
      // the trailer rides INSIDE that frame (single `\n`, non-"completed"
      // wording) rather than stacking a second frame (t02 review item 4).
      let text: string;
      if (!result.resumable) {
        text = result.finalMessage;
      } else if (result.truncated) {
        text = `${result.finalMessage}\n${agentTrailerLine(result.agentId, { completed: false })}`;
      } else {
        text = `${result.finalMessage}${agentTrailerFrame(result.agentId, { completed: true })}`;
      }
      return {
        content: [{ type: "text", text }],
        details: {
          agent: result.agentName,
          worktreePath: result.worktreePath,
          diagnostics: result.diagnostics,
          outcome: result.outcome,
          ...identityDetails,
          ...(params.run_in_background
            ? {
                note: backgroundDisabled
                  ? "background tasks are disabled (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS); run_in_background ran in foreground"
                  : "run_in_background requested but no background task registry is wired; ran in foreground",
              }
            : {}),
        },
      };
    },
  };
}

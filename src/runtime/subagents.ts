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
   */
  makeScopedHookRunner?: (config: HookConfig) => HookRunner;
  worktrees?: WorktreeManagerLike;
  maxDepth: number;
  concurrency: number;
  sessionId: string;
  /** Injected for testability; defaults to the real Pi SDK. */
  sdk?: PiSdk;
  log?: (message: string) => void;
}

export interface PiSdk {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSession }>;
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> };
  inMemorySessionManager(cwd: string): unknown;
  inMemorySettingsManager(): unknown;
  agentDir(): string;
}

interface PiSession {
  prompt(text: string): Promise<void>;
  messages: Array<{ role: string; content: unknown }>;
  dispose(): void;
  setThinkingLevel?(level: string): void;
  /** Cooperative abort (real Pi sessions expose it; TaskStop uses it best-effort). */
  abort?(): Promise<void> | void;
}

export interface DispatchResult {
  ok: boolean;
  /** The subagent's final assistant message, verbatim. */
  finalMessage: string;
  agentName?: string;
  worktreePath?: string;
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
  }): Promise<DispatchResult> {
    const diagnostics: Diagnostic[] = [];
    const agents = this.deps.getAgents();
    // Built-ins resolve AFTER project/user/plugin agents (audit E1): a project
    // agent named Explore overrides the built-in. Empty/omitted subagent_type
    // defaults to general-purpose (audit E2).
    const builtins = builtinAgents();
    const requested = opts.subagentType.trim() || "general-purpose";
    const resolved =
      opts.agentOverride ??
      findByName(agents, requested) ??
      agents.find((a) => a.name.toLowerCase() === requested.toLowerCase()) ??
      resolveAgent(builtins, requested);
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
        finalMessage: "",
        error: `Unknown subagent_type "${opts.subagentType}". Available: ${known || "(none)"}`,
        diagnostics,
      };
    }
    if (opts.depth > this.deps.maxDepth) {
      return {
        ok: false,
        finalMessage: "",
        agentName: agent.name,
        error: `Subagent nesting depth ${opts.depth} exceeds the configured maximum of ${this.deps.maxDepth}.`,
        diagnostics,
      };
    }
    if (opts.abortSignal?.aborted) {
      return {
        ok: false,
        finalMessage: "",
        agentName: agent.name,
        error: `Subagent "${agent.name}" was stopped before it started.`,
        diagnostics,
      };
    }

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
    const hookRunner = scopedHooks
      ? multiplexHookRunners(this.deps.hookRunner, scopedHooks)
      : this.deps.hookRunner;
    // Agent frontmatter `Stop` hooks map to SubagentStop time for this dispatch.
    const fireSubagentStop = async (
      payload: Partial<HookPayload>,
    ): Promise<HookOutcome | undefined> => {
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
          finalMessage: "",
          agentName: agent.name,
          error: `Subagent "${agent.name}" was stopped before it started.`,
          diagnostics,
        };
      }
      const startOutcome = await hookRunner
        .fire("SubagentStart", {
          subagent_type: agent.name,
          prompt,
          cwd: this.deps.getCwd(),
        })
        .catch(() => undefined);
      if (startOutcome?.block) {
        return {
          ok: false,
          finalMessage: "",
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
          finalMessage: "",
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

      const sessionOptions: Record<string, unknown> = {
        cwd,
        tools: toolNames,
        customTools,
        resourceLoader: loader,
        sessionManager: sdk.inMemorySessionManager(cwd),
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
            void live.abort?.();
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
      await session.prompt(fullPrompt);

      // Verbatim final assistant message (hard contract — no wrapping/summarizing).
      let finalMessage = lastAssistantText(session);

      // One-retry-on-empty convention (plan §4.3): a single re-prompt when nothing
      // came back — skipped for aborted dispatches (their result is discarded anyway).
      if (!finalMessage.trim() && !opts.abortSignal?.aborted) {
        await session.prompt(
          "Your previous reply was empty. Reply now with your final answer in the requested format.",
        );
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
        if (!stopOutcome?.block) break;
        if (opts.abortSignal?.aborted) break;
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
        finalMessage = lastAssistantText(session);
      }

      return { ok: true, finalMessage, agentName: agent.name, worktreePath, diagnostics };
    } catch (err) {
      return {
        ok: false,
        finalMessage: "",
        agentName: agent.name,
        worktreePath,
        error: `Subagent "${agent.name}" failed: ${(err as Error).message}`,
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
  const assistants = session.messages.filter((m) => m.role === "assistant");
  const last = assistants[assistants.length - 1];
  return last ? extractText(last.content) : "";
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
    async execute(_toolCallId: string, params: Record<string, unknown>) {
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
        const id = opts.backgroundTasks.start(
          `agent:${label}`,
          runtime.dispatch({ ...dispatchOpts, abortSignal: controller.signal }),
          () => controller.abort(),
        );
        return {
          content: [
            {
              type: "text",
              text: `Background task ${id} started (agent: ${label}). Use TaskOutput with task_id "${id}" to retrieve the result.`,
            },
          ],
          details: { background: true, taskId: id, agent: label },
        };
      }
      const result = await runtime.dispatch(dispatchOpts);
      if (!result.ok) {
        throw new Error(result.error ?? "subagent failed");
      }
      // Verbatim-return contract (plan §4.3): callers parse finalMessage directly
      // (often a locked YAML block) — compatibility notes belong in details only.
      return {
        content: [{ type: "text", text: result.finalMessage }],
        details: {
          agent: result.agentName,
          worktreePath: result.worktreePath,
          diagnostics: result.diagnostics,
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

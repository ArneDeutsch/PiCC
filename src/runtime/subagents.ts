import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ClaudeAgent, Diagnostic } from "../types.js";
import type { HookRunner } from "../engine/hook-runner.js";
import { PermissionEngine } from "../engine/permissions.js";
import { claudeToolsToPiBuiltins } from "./tool-map.js";
import { createGuardExtension } from "./guard.js";
import { CwdState } from "./cwd-state.js";
import { findByName } from "../project.js";

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
  }): Promise<DispatchResult> {
    const diagnostics: Diagnostic[] = [];
    const agents = this.deps.getAgents();
    const agent =
      opts.agentOverride ??
      findByName(agents, opts.subagentType) ??
      agents.find((a) => a.name.toLowerCase() === opts.subagentType.toLowerCase());
    if (!agent) {
      const known = agents.map((a) => a.name).join(", ");
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

    // Only root-level dispatches count against the concurrency cap. An ancestor
    // holds its slot while awaiting its descendants, so counting nested dispatches
    // too would deadlock the moment `concurrency` ancestors each await a queued
    // child (guaranteed at concurrency 1 for ANY depth-2 nesting).
    const release = opts.depth > 1 ? () => {} : await this.semaphore.acquire();
    let worktreePath: string | undefined;
    let session: PiSession | undefined;
    let started = false;
    let stopFired = false;
    try {
      const startOutcome = await this.deps.hookRunner
        .fire("SubagentStart", {
          subagent_type: agent.name,
          prompt: opts.prompt,
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
        hooks: this.deps.hookRunner,
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

      const modelSpec = opts.model ?? agent.model;
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

      this.deps.log?.(`dispatch ${agent.name} (depth ${opts.depth})`);
      const fullPrompt = agent.initialPrompt
        ? `${agent.initialPrompt}\n\n${opts.prompt}`
        : opts.prompt;
      await session.prompt(fullPrompt);

      // Verbatim final assistant message (hard contract — no wrapping/summarizing).
      let finalMessage = lastAssistantText(session);

      // One-retry-on-empty convention (plan §4.3): a single re-prompt when nothing came back.
      if (!finalMessage.trim()) {
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
        const stopOutcome = await this.deps.hookRunner
          .fire("SubagentStop", {
            subagent_type: agent.name,
            cwd: subCwd.get(),
            stop_hook_active: iteration > 0,
          })
          .catch(() => undefined);
        stopFired = true;
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
        await this.deps.hookRunner
          .fire("SubagentStop", {
            subagent_type: agent.name,
            cwd: this.deps.getCwd(),
          })
          .catch(() => undefined);
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
  opts: { depth: number; name?: string },
): Record<string, unknown> {
  return {
    name: opts.name ?? "Agent",
    label: "Agent",
    description:
      "Launch a subagent to handle a task. Pick subagent_type from the 'Available subagents' catalog by matching the task to the agent descriptions. Returns the subagent's final message verbatim.",
    parameters: Type.Object({
      subagent_type: Type.String({ description: "Name of the agent to dispatch" }),
      prompt: Type.String({ description: "The task for the subagent" }),
      model: Type.Optional(
        Type.String({ description: "Model override as provider/model (rarely needed)" }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({ description: "Accepted for compatibility; runs foreground in v1" }),
      ),
      description: Type.Optional(Type.String({ description: "Short task label (ignored)" })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const result = await runtime.dispatch({
        subagentType: String(params.subagent_type ?? ""),
        prompt: String(params.prompt ?? ""),
        model: params.model ? String(params.model) : undefined,
        depth: opts.depth + 1,
      });
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
            ? { note: "run_in_background is not supported in PiCC v1; ran in foreground" }
            : {}),
        },
      };
    },
  };
}

import { Type } from "typebox";
import type { ClaudeAgent, Diagnostic } from "../types.js";
import type { HookRunner } from "../engine/hook-runner.js";
import { PermissionEngine } from "../engine/permissions.js";
import { claudeToolsToPiBuiltins } from "./tool-map.js";
import { createGuardExtension } from "./guard.js";

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
  buildSystemPrompt: (agent: ClaudeAgent) => string;
  /** Claude-named custom tool definitions granted to an agent (WebFetch, Task*, ...). */
  customToolsFor: (agent: ClaudeAgent, grantedClaudeNames: string[], depth: number) => unknown[];
  /** All Claude tool names the harness knows (for gateTools' allKnown). */
  allKnownToolNames: () => string[];
  permissionEngine: PermissionEngine;
  hookRunner: HookRunner;
  getCwd: () => string;
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
  const m = mod as unknown as Record<string, any>;
  return {
    createAgentSession: (options) => m.createAgentSession(options),
    DefaultResourceLoader: m.DefaultResourceLoader,
    inMemorySessionManager: (cwd: string) => m.SessionManager.inMemory(cwd),
    inMemorySettingsManager: () => m.SettingsManager.inMemory({ compaction: { enabled: true } }),
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
    depth: number;
  }): Promise<DispatchResult> {
    const diagnostics: Diagnostic[] = [];
    const agents = this.deps.getAgents();
    const agent =
      agents.find((a) => a.name === opts.subagentType) ??
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

    const release = await this.semaphore.acquire();
    let worktreePath: string | undefined;
    let session: PiSession | undefined;
    try {
      await this.deps.hookRunner.fire("SubagentStart", {
        subagent_type: agent.name,
        prompt: opts.prompt,
        cwd: this.deps.getCwd(),
      });

      let cwd = this.deps.getCwd();
      if (agent.isolation === "worktree" && this.deps.worktrees) {
        const enter = await this.deps.worktrees.enter({
          name: `agent-${agent.name}-${Date.now().toString(36)}`,
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

      const granted = this.deps.permissionEngine.gateTools(
        agent.tools,
        agent.disallowedTools,
        this.deps.allKnownToolNames(),
      );
      const piBuiltins = claudeToolsToPiBuiltins(granted);
      const customTools = this.deps.customToolsFor(agent, granted, opts.depth);

      const sdk = await this.sdk();
      const guard = createGuardExtension({
        engine: this.deps.permissionEngine,
        hooks: this.deps.hookRunner,
        getCwd: () => cwd,
        contextForTouchedFile: this.deps.contextForTouchedFile,
        label: `subagent:${agent.name}`,
      });
      const loader = new sdk.DefaultResourceLoader({
        cwd,
        systemPromptOverride: () => this.deps.buildSystemPrompt(agent),
        skillsOverride: () => ({ skills: [], diagnostics: [] }),
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        promptsOverride: () => ({ prompts: [], diagnostics: [] }),
        extensionFactories: [{ name: `piclaudex-guard-${agent.name}`, factory: guard }],
      });
      await loader.reload();

      const model = this.deps.resolveModel(opts.model ?? agent.model);
      const thinking = this.deps.mapEffort(agent.effort);
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
      const assistants = session.messages.filter((m) => m.role === "assistant");
      const last = assistants[assistants.length - 1];
      let finalMessage = last ? extractText(last.content) : "";

      // One-retry-on-empty convention (plan §4.3): a single re-prompt when nothing came back.
      if (!finalMessage.trim()) {
        await session.prompt(
          "Your previous reply was empty. Reply now with your final answer in the requested format.",
        );
        const retryAssistants = session.messages.filter((m) => m.role === "assistant");
        const retryLast = retryAssistants[retryAssistants.length - 1];
        finalMessage = retryLast ? extractText(retryLast.content) : "";
        diagnostics.push({ severity: "info", message: "subagent returned empty; retried once" });
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
      await this.deps.hookRunner
        .fire("SubagentStop", {
          subagent_type: agent.name,
          cwd: this.deps.getCwd(),
        })
        .catch(() => undefined);
      release();
    }
  }
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
      let text = result.finalMessage;
      if (params.run_in_background) {
        text = `[note: run_in_background is not supported in PiClauDex v1; ran in foreground]\n${text}`;
      }
      return {
        content: [{ type: "text", text }],
        details: {
          agent: result.agentName,
          worktreePath: result.worktreePath,
          diagnostics: result.diagnostics,
        },
      };
    },
  };
}

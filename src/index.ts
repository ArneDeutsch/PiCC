import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { HookOutcome, HookPayload, ToolCallDescriptor } from "./types.js";
import { findByName, loadClaudeProject, type LoadedProject } from "./project.js";
import { loadPiCCConfig, mapEffort, steeringForModel } from "./runtime/steering.js";
import { CwdState } from "./runtime/cwd-state.js";
import { HookRunner } from "./engine/hook-runner.js";
import { PermissionEngine } from "./engine/permissions.js";
import { parseHookConfig } from "./claude/hooks.js";
import { WorktreeManager } from "./runtime/worktrees.js";
import {
  SubagentRuntime,
  createAgentToolDefinition,
  createSendMessageToolDefinition,
  presentDispatchResult,
} from "./runtime/subagents.js";
import type { PiSdk } from "./runtime/subagents.js";
import { SubagentRegistry } from "./runtime/subagent-registry.js";
import type { SubagentRegistryRecord } from "./runtime/subagent-registry.js";
import { formatUsageCompact, sanitizeLine } from "./runtime/subagent-progress.js";
import { createGuardExtension } from "./runtime/guard.js";
import {
  buildSystemPromptSuffix,
  contextForTouchedFile,
  createTierChangeReporter,
  MEMORY_WRITE_POLICY,
  newSessionContextState,
  resetInjectionState,
} from "./runtime/context-assembly.js";
import {
  budgetSkillReinjection,
  renderSkillForActivation,
  skillActivationMessage,
  skillActivationVars,
} from "./runtime/skill-activation.js";
import { createWorktreeTools } from "./runtime/tools/worktree-tools.js";
import { createWebFetchTool, createWebSearchTool } from "./runtime/tools/web-tools.js";
import { createGrepTool as createClaudeGrepTool, createGlobTool } from "./runtime/tools/search-tools.js";
import { createNotebookReadTool } from "./runtime/tools/notebook-tools.js";
import { createMultiEditTool } from "./runtime/tools/multi-edit.js";
import { createTaskTools } from "./runtime/tools/task-tools.js";
import {
  BackgroundTaskRegistry,
  createTaskOutputTool,
  createTaskStopTool,
  scopedBackgroundTools,
  type SettlementNotice,
} from "./runtime/background-tasks.js";
import { builtinAgents } from "./claude/agents.js";
import { loadAgentMemory } from "./claude/memory.js";
import { createDegradeStub, DEGRADED_TOOLS } from "./runtime/tools/degrade-stubs.js";
import { buildCompatReport, readSuppression, renderDoctorReport, renderStartupNotice, writeSuppression, type CompatReport } from "./registry/compat-report.js";
import { loadSkillBody, substituteToolRules, substituteVariables } from "./claude/skills.js";
import { resolveGitBashPath, shellNamespaceDiffersFromNative } from "./engine/shell-inject.js";
import { applyUnicodeSafeProcessEnv, computeSessionScratchDir, unicodeSafeSubprocessEnv } from "./util/env.js";
import type { ClaudeAgent, ClaudeSkill } from "./types.js";

/**
 * PiCC — the Pi extension entry.
 *
 * Loads the target project's Claude Code artifact corpus and wires it into Pi:
 * system-prompt assembly each turn (also the compaction-preservation mechanism),
 * deny/hook enforcement on tool events, the Claude tool surface (Agent, Skill,
 * worktrees, web, tasks, degrade stubs), cwd-swapping built-in tool overrides,
 * skill slash commands, and the /doctor–/compat–/quota control surface.
 */

/** Delegates hook fire() to the base (settings+plugins) runner plus dynamic scoped runners. */
class HookMultiplexer {
  constructor(
    private readonly base: HookRunner,
    private readonly extras: HookRunner[] = [],
  ) {}
  addScoped(runner: HookRunner): void {
    this.extras.push(runner);
  }
  /** True when any delegate has handlers for the event (guard payload-skip, F5). */
  hasHooks(eventName: string): boolean {
    return this.base.hasHooks(eventName) || this.extras.some((r) => r.hasHooks(eventName));
  }
  private readonly reportedDiagnostics = new Set<string>();
  private askDowngradeReported = false;

  async fire(
    eventName: string,
    payload: Partial<HookPayload>,
    toolCall?: ToolCallDescriptor,
  ): Promise<HookOutcome> {
    const outcomes: HookOutcome[] = [];
    outcomes.push(await this.base.fire(eventName, payload, toolCall));
    for (const extra of this.extras) {
      outcomes.push(await extra.fire(eventName, payload, toolCall));
    }
    const merged: HookOutcome = { block: false, askDowngraded: false, diagnostics: [] };
    for (const o of outcomes) {
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
    this.surface(eventName, merged);
    return merged;
  }

  /**
   * Hook failures must be VISIBLE (§2.2 "visible, documented no-op"): every runner
   * failure path degrades to a diagnostic (bash missing, timeout, invalid matcher…)
   * and silently dropping them turns the project's whole enforcement layer off with
   * no indication. Warnings/errors go to stderr once per distinct message; the rest
   * to the PICC_DEBUG channel. Ask-downgrades are reported once per session (§6.1).
   */
  private surface(eventName: string, merged: HookOutcome): void {
    for (const d of merged.diagnostics) {
      const key = `${d.severity}:${d.message}`;
      if (this.reportedDiagnostics.has(key)) continue;
      this.reportedDiagnostics.add(key);
      if (d.severity === "warning" || d.severity === "error") {
        console.error(`[picc] hook ${eventName}: ${d.message}`);
      } else {
        debug(`hook ${eventName}: ${d.message}`);
      }
    }
    // `systemMessage` is user-facing (Claude shows it in the UI) — info-level
    // notice on stderr, shown once per distinct message.
    for (const msg of merged.systemMessages ?? []) {
      const key = `systemMessage:${msg}`;
      if (this.reportedDiagnostics.has(key)) continue;
      this.reportedDiagnostics.add(key);
      console.error(`[picc] hook ${eventName}: ${msg}`);
    }
    if (merged.askDowngraded && !this.askDowngradeReported) {
      this.askDowngradeReported = true;
      console.error(
        `[picc] a hook requested permissionDecision "ask"; allowed per posture §6.1 (deny rules still enforced)`,
      );
    }
  }
}

const CLAUDE_MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "inherit", "claude"]);

/** Diagnosability channel (plan §12.4): PICC_DEBUG=1 traces decisions to stderr. */
function debug(...args: unknown[]): void {
  if (process.env.PICC_DEBUG) console.error("[picc]", ...args);
}

/**
 * Parse a `SlashCommand` string into a `(name, argsText)` pair. Single command,
 * NO stacking (unlike the user-typed transform): only the first `/name` token is
 * taken and the rest is the args string. Tolerant of a missing leading slash
 * (`deploy x` resolves like `/deploy x`). The name token shape matches the
 * transform (`[A-Za-z0-9][\w-]*(?::[\w-]+)*`) so plugin-namespaced `/plugin:name`
 * and `findByName`'s bare-name resolution behave identically. Whitespace between
 * name and args is `[ \t]` (cross-platform, matching the transform). Returns
 * undefined for empty / whitespace-only / bare `/` input (no name token).
 */
function parseSlashCommand(command: string): { name: string; argsText: string } | undefined {
  const trimmed = command.trim();
  const m = /^\/?([A-Za-z0-9][\w-]*(?::[\w-]+)*)(?=[ \t]|$)/.exec(trimmed);
  if (!m) return undefined;
  const argsText = trimmed.slice(m[0].length).replace(/^[ \t]+/, "");
  return { name: m[1]!, argsText };
}

/**
 * TEST-ONLY injection point (t05 plan-review MUST-FIX). The fake-Pi harness
 * cannot reach the closure-local registries/runtime, so the offline-integration
 * test for the settlement-notice delivery path needs a named seam. `onWired` is
 * invoked synchronously during construction with the real in-process registries
 * and runtime, so tests can inject an offline SDK, traverse registered tools, or
 * seed focused lifecycle state before driving the REAL `before_agent_start` drain.
 *
 * SECURITY: this seam is reachable ONLY through this in-process second argument.
 * Nothing in the project-loading path (CLAUDE.md, settings, env vars, files)
 * ever supplies it — Pi invokes the extension entry as `picc(pi)` with a single
 * argument — so a loaded project can never use it to swap runtime internals. An
 * env/settings/file-gated seam would be a project-reachable runtime-swap bypass;
 * an in-process argument is not. The same invariant binds the `sdk` field below
 * (F14 t02): the fake Pi SDK it carries is the subagent runtime's execution
 * substrate — strictly higher privilege than the `onWired` registries — so it is
 * read ONLY off this in-process argument and plumbed straight into the runtime's
 * `deps.sdk`; when it is absent the runtime lazy-loads the real Pi SDK. There is
 * no `process.env` / `project.settings` / file fallback anywhere on that path.
 */
export interface PiccTestSeam {
  /**
   * TEST-ONLY synchronous barrier immediately before the production settlement
   * sender's final validity check. It can model collection after selection; no
   * project-controlled input can supply it and the production path never awaits.
   */
  beforeSettlementSend?: (notice: SettlementNotice) => void;
  onWired?: (internals: {
    backgroundTasks: BackgroundTaskRegistry;
    subagentRegistry: SubagentRegistry;
    /**
     * The session's SubagentRuntime (F13 t02): lets an offline-integration test
     * inject a fake PiSdk (`setSdkForTest`) and then drive a REAL dispatch through
     * the coordinator's registered Agent tool, so the dispatcher-owner threading
     * is exercised end to end (the owner id is minted by the runtime, never
     * supplied by the test). Reachable only via this in-process seam.
     */
    subagentRuntime: SubagentRuntime;
  }) => void;
  /**
   * TEST-ONLY subagent SDK override: replaces the real Pi SDK the session's
   * SubagentRuntime would otherwise load, so an offline test can drive the REAL
   * dispatch/fork paths through a controllable outcome without an LLM/network —
   * a `context: fork` skill invoked through the Skill tool, the SlashCommand tool
   * (F11), or the user-typed `/name` input transform (F14). Consumed at
   * SubagentRuntime construction as `deps.sdk`; unset ⇒ the runtime lazy-loads
   * the real Pi SDK (`loadRealSdk()`). Same in-process-only reachability
   * guarantee as `onWired` above (see the SECURITY note).
   */
  sdk?: PiSdk;
}

export default function picc(pi: any, testSeam?: PiccTestSeam) {
  // UTF-8 stdio for any child process (fixes Windows cp1252 UnicodeEncodeError,
  // e.g. Python printing `→`). Set before any subprocess can be spawned.
  applyUnicodeSafeProcessEnv();

  let project: LoadedProject;
  try {
    // PICC_CLAUDE_USER_DIR overrides ~/.claude (tests, multi-profile setups).
    project = loadClaudeProject({
      cwd: process.cwd(),
      userDir: process.env.PICC_CLAUDE_USER_DIR || undefined,
    });
  } catch (err) {
    // Completeness floor: a broken project must never crash the harness.
    console.error(`PiCC failed to load project artifacts: ${(err as Error).message}`);
    return;
  }

  const config = loadPiCCConfig(project.root);
  const sessionId = randomUUID();
  const cwdState = new CwdState(project.cwd);
  // Hook payload `transcript_path`: Pi's session manager (captured on
  // session_start) exposes the session file — the closest analog to Claude's
  // transcript. Live getter so session switches stay accurate.
  let sessionManagerRef: { getSessionFile?: () => string | undefined } | undefined;
  const transcriptPath = () => {
    try {
      return sessionManagerRef?.getSessionFile?.() ?? undefined;
    } catch {
      return undefined;
    }
  };
  // ${CLAUDE_PLUGIN_DATA} expansion mirrors ${CLAUDE_PLUGIN_ROOT} (C12).
  const pluginDataDirs: Record<string, string> = {};
  for (const p of project.plugins) pluginDataDirs[p.name] = p.dataDir;
  const baseHooks = new HookRunner({
    config: project.mergedHooks,
    projectDir: project.root,
    sessionId,
    env: project.settings.env,
    disableAllHooks: project.settings.disableAllHooks,
    pluginRoots: project.pluginRoots,
    pluginDataDirs,
    transcriptPath,
  });
  const hooks = new HookMultiplexer(baseHooks);
  const permissionEngine = new PermissionEngine(project.settings.permissions, {
    cwd: project.cwd,
    // Path rules anchor to the settings' project root, immune to cwd drift
    // (subdir launch, EnterWorktree).
    root: project.root,
  });
  // Rule-validation findings (e.g. unanchored mcp__* allow globs, audit D4)
  // surface once at startup — never silent, never fatal.
  for (const d of permissionEngine.diagnostics) {
    console.error(`PiCC permissions: ${d.message}`);
  }
  const worktrees = new WorktreeManager({
    projectRoot: project.root,
    settings: project.settings.worktree,
    cleanupPeriodDays: project.settings.cleanupPeriodDays,
  });
  // Reap orphaned worktree dirs from crashed sessions (plan §4.4) — fire-and-forget.
  void worktrees.reapOrphans().catch(() => undefined);
  const state = newSessionContextState(project.claudeMd);
  // Completeness floor (§2.2): a report failure must never abort extension init.
  let compat: CompatReport;
  try {
    compat = buildCompatReport(project);
  } catch (err) {
    console.error(`PiCC compatibility scan failed (continuing): ${(err as Error).message}`);
    compat = { findings: [], safetyFindings: [], unassessed: [] };
  }
  let compatSuppressed = readSuppression(project.root) || config.suppressCompatNotice === true;

  let currentModelRef = "";
  let currentModel: unknown; // the orchestrator's active model — inherited by subagents
  let steeringText: string | undefined;
  let stopHookIterations = 0;
  const quotaHeaders: Record<string, string> = {};

  const hookRunnerFacade = {
    fire: (event: string, payload: Partial<HookPayload>, call?: ToolCallDescriptor) =>
      hooks.fire(event, payload, call),
    hasHooks: (event: string) => hooks.hasHooks(event),
  } as unknown as HookRunner;

  const injectForFile = (filePath: string) =>
    contextForTouchedFile({
      filePath,
      cwd: cwdState.get(),
      projectRoot: project.root,
      rules: project.rules,
      settings: project.settings,
      state,
      skills: project.skills,
    });

  /**
   * Per-dispatch injector with FRESH injection state: a subagent's file touches
   * must inject into ITS context and must not consume the orchestrator's one-shot
   * nested-CLAUDE.md/path-rule injections (or vice versa). `getCwdFn` binds to the
   * dispatch-local cwd so worktree-isolated agents resolve against their checkout.
   */
  const makeContextInjector = (getCwdFn: () => string) => {
    const subState = newSessionContextState(project.claudeMd);
    return (filePath: string) =>
      contextForTouchedFile({
        filePath,
        cwd: getCwdFn(),
        projectRoot: project.root,
        rules: project.rules,
        settings: project.settings,
        state: subState,
        skills: project.skills,
      });
  };

  // ---------------------------------------------------------------------------
  // Skill activation (shared by Skill tool, slash commands, context:fork)
  // ---------------------------------------------------------------------------
  function pluginContextFor(skill: ClaudeSkill): { root?: string; data?: string } {
    const pluginName = skill.source.pluginName;
    if (!pluginName) return {};
    const plugin = project.plugins.find((p) => p.name === pluginName);
    return plugin ? { root: plugin.root, data: plugin.dataDir } : {};
  }

  /** Skills whose scoped hooks are already registered (re-activation must not stack duplicates). */
  const scopedHookSkills = new Set<string>();
  /** Active skills' disallowed-tools, enforced by the guard while the skill is resident. */
  const activeSkillDenyRules = new Set<string>();

  async function activateSkill(
    skill: ClaudeSkill,
    argsText: string,
    opts: { fork?: boolean; recordActivation?: boolean } = {},
  ): Promise<string> {
    const record = opts.recordActivation ?? true;
    if (skill.hooks && Object.keys(skill.hooks).length) {
      if (!record) {
        // Subagent-side activation: scoped hooks are session-wide state and must
        // not leak across the fresh-context boundary (visible degrade).
        debug(`skill ${skill.name}: scoped hooks not registered for a subagent-side activation`);
      } else if (!scopedHookSkills.has(skill.name)) {
        // Register once per skill: re-activation must not duplicate side effects
        // (and reusing the runner preserves its `once:` tracking).
        scopedHookSkills.add(skill.name);
        const parsed = parseHookConfig(skill.hooks, skill.source.path);
        hooks.addScoped(
          new HookRunner({
            config: parsed.config,
            projectDir: project.root,
            sessionId,
            env: project.settings.env,
            disableAllHooks: project.settings.disableAllHooks,
            pluginRoots: project.pluginRoots,
            pluginDataDirs,
            transcriptPath,
          }),
        );
      }
    }
    const plugin = pluginContextFor(skill);
    const rendered = await renderSkillForActivation({
      skill,
      argsText,
      projectRoot: project.root,
      cwd: cwdState.get(),
      sessionId,
      effort: skill.effort ?? config.effort,
      settings: project.settings,
      pluginRoot: plugin.root,
      pluginData: plugin.data,
    });
    // context:fork bodies go to the FORK only — keeping them resident in the
    // parent would defeat the fork's purpose (§12.1 token-efficiency contract).
    if (record && !opts.fork) {
      state.activeSkills.set(skill.name, rendered.text);
      // Use the per-activation substituted copies (${CLAUDE_*}/$ARGUMENTS, audit
      // A3) so deny rules like Bash(${CLAUDE_SKILL_DIR}/*) gate the real path.
      for (const rule of rendered.disallowedTools ?? skill.disallowedTools ?? []) {
        activeSkillDenyRules.add(rule);
      }
    }
    return rendered.text;
  }

  /**
   * Re-invocation dedup (audit A8): fingerprint of the last rendered body per
   * skill name. A re-invocation whose rendering is byte-identical substitutes a
   * short note instead of a second full copy. FNV-1a 32-bit + length — cheap,
   * dependency-free, and sufficient for change detection.
   */
  const lastSkillRenderHash = new Map<string, string>();
  function skillRenderFingerprint(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${text.length}:${(h >>> 0).toString(16)}`;
  }
  /** Returns the dedup note when `rendered` is byte-identical to the last copy, else records it. */
  function skillDedupNote(skill: ClaudeSkill, rendered: string): string | undefined {
    const fp = skillRenderFingerprint(rendered);
    if (lastSkillRenderHash.get(skill.name) === fp) {
      return `Skill "${skill.name}" was invoked again; its content is unchanged from the earlier copy above.`;
    }
    lastSkillRenderHash.set(skill.name, fp);
    return undefined;
  }

  /**
   * Dispatches a context:fork skill. A fork without `agent:` runs in a synthetic
   * general-purpose context — fresh CLAUDE.md/rules hierarchy, the skill's own
   * tool gating (with ${CLAUDE_*}/$ARGUMENTS substituted per activation, audit
   * A3), no agent persona (and no dependency on whatever agent happens to sort
   * first, or on any agent existing at all).
   */
  function forkDispatch(
    skill: ClaudeSkill,
    rendered: string,
    depth: number,
    argsText = "",
    abortSignal?: AbortSignal,
  ) {
    const plugin = pluginContextFor(skill);
    const vars = skillActivationVars({
      skill,
      projectRoot: project.root,
      sessionId,
      effort: skill.effort ?? config.effort,
      pluginRoot: plugin.root,
      pluginData: plugin.data,
    });
    const agentOverride: ClaudeAgent | undefined = skill.forkAgentType
      ? undefined
      : {
          name: `fork:${skill.name}`,
          description: `Forked general-purpose context for skill "${skill.name}"`,
          body:
            "You are executing a skill in a fresh forked context. Follow the skill instructions in the task exactly and reply with the skill's final result.",
          tools: substituteToolRules(skill.allowedTools, argsText, vars, skill.arguments),
          disallowedTools: substituteToolRules(skill.disallowedTools, argsText, vars, skill.arguments),
          model: skill.model,
          effort: skill.effort,
          metadata: {},
          source: skill.source,
          unknownKeys: [],
          diagnostics: [],
        };
    // Threads Pi's Esc AbortSignal into the dispatch (F14 t02). dispatch always
    // resolves a DispatchResult (incl. on abort), so forkDispatch resolves and
    // never rejects — both callers rely on that (the input hook must never throw).
    return subagentRuntime.dispatch({
      subagentType: skill.forkAgentType ?? agentOverride!.name,
      prompt: rendered,
      model: skill.model,
      effort: skill.effort,
      depth,
      agentOverride,
      abortSignal,
    });
  }

  // ---------------------------------------------------------------------------
  // Subagent runtime
  // ---------------------------------------------------------------------------
  const taskToolBundle = createTaskTools();
  const claudeNamedTools: Record<string, unknown>[] = [];
  // Background tasks (audit E4): one registry per session — run_in_background
  // dispatches register here; TaskOutput/TaskStop operate on it.
  const backgroundTasks = new BackgroundTaskRegistry();
  // Dispatch registry (t04): one per session — every session-creating dispatch
  // registers here so SendMessage can steer a running background subagent or
  // resume a finished one. Registry-only resolution keeps a hostile `to` off the
  // filesystem (SECURITY MUST-FIX #2).
  const subagentRegistry = new SubagentRegistry();
  // Built-in agent types (audit E1): general-purpose/Explore/Plan, appended
  // AFTER project/user/plugin agents so a same-named project agent wins (an
  // overridden built-in is dropped from the catalog — dispatch resolves the
  // project agent anyway).
  const builtins = builtinAgents();
  const agentsWithBuiltins = () => {
    const taken = new Set(project.agents.map((a) => a.name.toLowerCase()));
    return [...project.agents, ...builtins.filter((b) => !taken.has(b.name.toLowerCase()))];
  };

  /**
   * Claude-named tool instances bound to a cwd state. Built once for the main
   * session and FRESH per subagent dispatch: sharing instances would leak the
   * orchestrator's cwd (worktree-isolated agents searching the wrong checkout)
   * and its TaskStore (a subagent TodoWrite wiping the parent's task list).
   */
  function buildCwdBoundTools(
    cwdRef: CwdState,
    taskBundle: { tools: unknown[] },
  ): Record<string, unknown>[] {
    const get = () => cwdRef.get();
    return [
      createWebFetchTool(get) as unknown as Record<string, unknown>,
      createWebSearchTool(get) as unknown as Record<string, unknown>,
      createClaudeGrepTool(get) as unknown as Record<string, unknown>,
      createGlobTool(get) as unknown as Record<string, unknown>,
      createNotebookReadTool(get) as unknown as Record<string, unknown>,
      createMultiEditTool(get) as unknown as Record<string, unknown>,
      ...(taskBundle.tools as unknown as Record<string, unknown>[]),
      ...createWorktreeTools({ worktrees, cwdState: cwdRef, hookRunner: hookRunnerFacade }),
      ...DEGRADED_TOOLS.map(
        (d) => createDegradeStub(d.name, d.note) as unknown as Record<string, unknown>,
      ),
    ];
  }

  function resolveModelSpec(spec: string | undefined): unknown | undefined {
    if (!spec) return currentModel;
    const lower = spec.toLowerCase();
    if (CLAUDE_MODEL_ALIASES.has(lower)) return currentModel; // inherit session model
    try {
      if (!modelRegistryRef) return currentModel;
      if (spec.includes("/")) {
        const [provider, ...rest] = spec.split("/");
        return modelRegistryRef.find(provider, rest.join("/")) ?? undefined;
      }
      return (
        modelRegistryRef.find("openai", spec) ??
        modelRegistryRef.find("anthropic", spec) ??
        undefined
      );
    } catch {
      return undefined;
    }
  }
  let modelRegistryRef: any;

  function buildSubagentSystemPrompt(agent: ClaudeAgent, depth = 0): string {
    const sections: string[] = [agent.body.trim()];
    // Preloaded skills (agent `skills:`): body + variables, no args/shell (sync path).
    for (const name of agent.skills ?? []) {
      const skill = findByName(project.skills, name);
      if (!skill) {
        // Visible degrade (§2.2): a misspelled/shadowed skills: entry must not vanish.
        debug(`agent ${agent.name}: preloaded skill "${name}" not found`);
        sections.push(
          `## Preloaded skill: ${name}\n\n(PiCC: this skill was declared in the agent's skills: list but does not exist in the project — proceed without it.)`,
        );
        continue;
      }
      const body = substituteVariables(loadSkillBody(skill), {
        CLAUDE_SKILL_DIR: skill.baseDir,
        CLAUDE_PROJECT_DIR: project.root,
        CLAUDE_SESSION_ID: sessionId,
        CLAUDE_EFFORT: agent.effort ?? "",
      });
      sections.push(`## Preloaded skill: ${name}\n\n${body.trim()}`);
    }
    // Agent memory (audit B5): `memory:` frontmatter scope loads the agent's
    // MEMORY.md and points the agent at its durable-knowledge directory.
    if (agent.memory !== undefined && agent.memory !== null) {
      const memoryScope = typeof agent.memory === "string" ? agent.memory.trim().toLowerCase() : "";
      if (memoryScope === "user" || memoryScope === "project" || memoryScope === "local") {
        const memory = loadAgentMemory(agent.name, memoryScope, project.root, project.userDir);
        if (memory) {
          const parts = [`Memory directory: ${memory.dir}`];
          const memContent = memory.content?.trim();
          if (memContent) parts.push(memContent);
          parts.push("Any memory shown above is loaded for you each run — use it.");
          parts.push(MEMORY_WRITE_POLICY);
          sections.push(`# Agent memory\n\n${parts.join("\n\n")}`);
        }
      } else {
        // Visible degrade (§2.2): an unknown memory scope must not vanish silently.
        debug(`agent ${agent.name}: unknown memory scope "${String(agent.memory)}"; no memory loaded`);
      }
    }
    const granted = permissionEngine.gateTools(agent.tools, agent.disallowedTools, allKnownToolNames());
    // The catalog must mirror tool provisioning: at max depth the nested Agent tool
    // is not provided, so advertising subagents would only produce unknown-tool calls.
    const nestedDispatchAvailable =
      project.settings.subagentsEnabled &&
      depth + 1 <= project.settings.subagentMaxDepth &&
      (granted.includes("Agent") || granted.includes("Task"));
    // Steering is per-model (§13.2): an agent with its own model: gets that model's guidance.
    const agentModel = agent.model ? (resolveModelSpec(agent.model) as { provider?: string; id?: string } | undefined) : undefined;
    const agentModelRef =
      agentModel?.provider && agentModel?.id ? `${agentModel.provider}/${agentModel.id}` : currentModelRef;
    // Explore/Plan context trimming (audit E6): agents marked skipProjectContext
    // omit the CLAUDE.md/project-instructions and rules sections (harness
    // conventions, skill listing, and steering stay).
    const skipProject = agent.skipProjectContext === true;
    const suffix = buildSystemPromptSuffix({
      claudeMd: skipProject ? [] : project.claudeMd,
      rules: skipProject ? [] : project.rules,
      // Auto memory reaches subagents too (review H2) — except Explore/Plan,
      // whose skipProjectContext trims all project-level context.
      autoMemory: skipProject ? undefined : project.autoMemory,
      skills: project.skills,
      agents: nestedDispatchAvailable ? agentsWithBuiltins() : [],
      settings: project.settings,
      state: newSessionContextState(skipProject ? [] : project.claudeMd),
      steeringText: agentModelRef ? steeringForModel(config, agentModelRef) : steeringText,
      // Feature 25 / #48: subagents receive the same scratchpad guidance as the
      // main session — a subagent that writes a temp file via the Bash tool and
      // then Reads it (or hands it to a nested agent) hits the identical
      // shell↔native namespace trap. Reuse the one eager `scratchDir` literal +
      // predicate (harness data, safe to inject into every agent — not an
      // exfiltration-sensitive value). Reachable here because this closure runs
      // at dispatch time, after activation initialized `scratchDir`.
      scratchDir,
      windowsTempNote: shellNamespaceDiffersFromNative(),
    });
    sections.push(suffix);
    return sections.join("\n\n");
  }

  function allKnownToolNames(): string[] {
    return [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Grep",
      "Glob",
      "NotebookRead",
      "WebFetch",
      "WebSearch",
      "Agent",
      "Task",
      "SendMessage",
      "Skill",
      "SlashCommand",
      "EnterWorktree",
      "ExitWorktree",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TodoWrite",
      "TaskOutput",
      "TaskStop",
      "MultiEdit",
      ...DEGRADED_TOOLS.map((d) => d.name),
    ];
  }

  const subagentRuntime = new SubagentRuntime({
    getAgents: () => project.agents,
    buildSystemPrompt: buildSubagentSystemPrompt,
    customToolsFor: (agent, granted, depth, ownerAgentId, dispatcherIsFork, subCwd) => {
      // Per-dispatch instances (fresh TaskStore, dispatch-local cwd binding).
      // NOTE (t04): SendMessage is deliberately NEVER built here — it is
      // parent-initiated only (no subagent→subagent or subagent→parent channel).
      // Even a future "inherit all tools" change must not add it to this set.
      const tools: Record<string, unknown>[] = [];
      for (const tool of buildCwdBoundTools(subCwd ?? cwdState, createTaskTools())) {
        const name = (tool as { name: string }).name;
        if (granted.includes(name)) tools.push(tool);
      }
      if (granted.includes("Skill")) {
        // Per-dispatch Skill tool: carries the caller's depth into context:fork
        // dispatches (depth cap holds) and never mutates the parent session state.
        tools.push(createSkillTool({ depth, forSubagent: true }) as Record<string, unknown>);
      }
      if (granted.includes("SlashCommand")) {
        // Per-dispatch SlashCommand tool: a thin alias over the same shared
        // skill-activation path as the Skill tool — carries the caller's depth
        // into context:fork dispatches and leaves parent session state alone.
        tools.push(createSlashCommandTool({ depth, forSubagent: true }) as Record<string, unknown>);
      }
      // Background-task tools are SCOPED to this dispatcher's own tasks (F13 t02):
      // built over `backgroundTasks.scopedTo(ownerAgentId)`, so a subagent's
      // TaskOutput/TaskStop reach only the tasks it itself dispatched — a sibling's
      // or the coordinator's task is indistinguishable from an unknown id. The
      // coordinator keeps the full registry (below), retaining reach to every task.
      const scoped = scopedBackgroundTools(backgroundTasks, ownerAgentId);
      if (granted.includes("TaskOutput")) {
        tools.push(scoped.taskOutput);
      }
      if (granted.includes("TaskStop")) {
        tools.push(scoped.taskStop);
      }
      if (
        project.settings.subagentsEnabled &&
        depth + 1 <= project.settings.subagentMaxDepth &&
        (granted.includes("Agent") || granted.includes("Task"))
      ) {
        // Both Claude names: projects grant and reference the dispatch tool as Task.
        // `ownerAgentId` tags tasks THIS subagent starts, so its own scoped tools
        // (above) — and nobody else's — can reach them (F13 t02). `dispatcherIsFork`
        // (F16 t02) marks these tools when the dispatcher is a genuine fork, so a
        // nested `subagent_type: "fork"` is refused (a fork can't spawn a fork).
        tools.push(createAgentToolDefinition(subagentRuntime, { depth, name: "Agent", backgroundTasks, ownerAgentId, dispatcherIsFork }));
        tools.push(createAgentToolDefinition(subagentRuntime, { depth, name: "Task", backgroundTasks, ownerAgentId, dispatcherIsFork }));
      }
      return tools;
    },
    allKnownToolNames,
    permissionEngine,
    hookRunner: hookRunnerFacade,
    getCwd: () => cwdState.get(),
    makeContextInjector,
    // Agent-scoped hooks (audit C10): per-dispatch runner with the SAME deps as
    // the session's base runner; the runtime multiplexes and discards it. Its
    // transcript_path stays the MAIN session transcript (t02 review round 2):
    // Claude Code does not re-point subagent hook events at the subagent's own
    // transcript.
    makeScopedHookRunner: (config) =>
      new HookRunner({
        config,
        projectDir: project.root,
        sessionId,
        env: project.settings.env,
        disableAllHooks: project.settings.disableAllHooks,
        pluginRoots: project.pluginRoots,
        pluginDataDirs,
        transcriptPath,
      }),
    // Subagent transcripts (t02) persist next to the MAIN session's transcript.
    getMainSessionFile: transcriptPath,
    resolveModel: resolveModelSpec,
    mapEffort: (effort) => mapEffort(config, effort),
    worktrees,
    maxDepth: project.settings.subagentMaxDepth,
    concurrency: project.settings.subagentConcurrency,
    sessionId,
    subagentRegistry,
    // TEST-ONLY seam (F11/F14): an injected fake SDK reaches every dispatch —
    // including forks, which close over this one runtime instance. Read ONLY
    // from the in-process testSeam argument; unset ⇒ the runtime lazy-loads the
    // real Pi SDK (loadRealSdk). Never sourced from env/settings/files.
    ...(testSeam?.sdk ? { sdk: testSeam.sdk } : {}),
  });

  // TEST-ONLY seam (t05 settlement drain; F13 t02 dispatcher-owner threading):
  // hand the real in-process registries AND the runtime to a test that drives the
  // settlement-notice delivery path or an offline dispatch (fake SDK injected via
  // subagentRuntime.setSdkForTest). See PiccTestSeam — reachable only via this
  // in-process argument, never via project/env/settings/files. Invoked after the
  // runtime is built so the test can inject its fake SDK before the first dispatch.
  try {
    testSeam?.onWired?.({ backgroundTasks, subagentRegistry, subagentRuntime });
  } catch (err) {
    console.error(`PiCC test seam onWired failed: ${(err as Error).message}`);
  }

  // ---------------------------------------------------------------------------
  // Tool registration
  // ---------------------------------------------------------------------------
  const getCwd = () => cwdState.get();
  claudeNamedTools.push(...buildCwdBoundTools(cwdState, taskToolBundle));

  /**
   * The single skill-activation path shared by the Skill and SlashCommand tools
   * (and mirroring the user-typed `/name` transform): given a RESOLVED skill and
   * its args, honor `disable-model-invocation` refusal, `context: fork` dispatch,
   * and byte-identical re-invocation dedup. Returns the tool result or throws a
   * model-visible error. `invokedName` is the CALLER-supplied name (which for a
   * bare name resolving to a plugin-namespaced skill differs from `skill.name`);
   * the refusal message is built from it so each tool's wording is preserved.
   * `signal` is Pi's per-call Esc signal (F14): threaded into the fork dispatch so
   * an Esc'd model-invoked fork (Skill OR SlashCommand tool) reports as aborted.
   */
  async function runSkillActivation(
    skill: ClaudeSkill,
    argsText: string,
    opts: { forSubagent: boolean; depth: number; invokedName: string; signal?: AbortSignal },
  ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
    if (skill.disableModelInvocation) {
      throw new Error(`Skill "${opts.invokedName}" is user-only (disable-model-invocation). Ask the user to run /${opts.invokedName}.`);
    }
    if (skill.contextFork) {
      const rendered = await activateSkill(skill, argsText, {
        fork: true,
        recordActivation: !opts.forSubagent,
      });
      // Thread Pi's Esc signal so an Esc'd fork cancels (F14).
      const result = await forkDispatch(skill, rendered, opts.depth + 1, argsText, opts.signal);
      // Forks are non-resumable (F02): suppress every resume trailer. The shared
      // t01 helper reproduces the Agent tool's four-branch mapping —
      // failed-with-partial preserves the partial + names the cause;
      // failed-no-output and aborted surface as loud failures (distinct wording);
      // completed stays the verbatim final message.
      const p = presentDispatchResult(result, { allowResumeTrailer: false });
      if (p.kind === "failure") throw new Error(p.message);
      return {
        content: [{ type: "text", text: p.text }],
        details: { forked: true, agent: result.agentName, cutOff: p.cutOff },
      };
    }
    const rendered = await activateSkill(skill, argsText, {
      recordActivation: !opts.forSubagent,
    });
    // Re-invocation with byte-identical content → short note instead of a
    // second copy (audit A8). Subagent instances keep their own context and
    // never consult the parent-session fingerprints.
    const note = opts.forSubagent ? undefined : skillDedupNote(skill, rendered);
    if (note) {
      return {
        content: [{ type: "text", text: note }],
        details: { skill: skill.name, deduplicated: true },
      };
    }
    return {
      content: [{ type: "text", text: skillActivationMessage(skill, rendered) }],
      details: { skill: skill.name },
    };
  }

  /**
   * The Skill tool, per session scope: the orchestrator's instance records
   * activations (resident body, disallowed-tools gate, scoped hooks); subagent
   * instances carry their dispatch depth into forks and leave parent state alone.
   */
  function createSkillTool(opts: { depth: number; forSubagent: boolean }) {
    return {
      name: "Skill",
      label: "Skill",
      description:
        "Activate a skill from the 'Available skills' listing. The skill's full instructions load into context; follow them immediately.",
      parameters: Type.Object({
        name: Type.String({ description: "Skill name from the listing" }),
        arguments: Type.Optional(Type.String({ description: "Arguments for the skill, if any" })),
      }),
      async execute(
        _id: string,
        params: { name: string; arguments?: string },
        signal?: AbortSignal,
      ) {
        // findByName resolves plugin-namespaced skills by bare name when unique.
        const skill = findByName(project.skills, params.name);
        if (!skill) throw new Error(`Unknown skill: ${params.name}`);
        return runSkillActivation(skill, params.arguments ?? "", {
          forSubagent: opts.forSubagent,
          depth: opts.depth,
          invokedName: params.name,
          signal,
        });
      },
    };
  }
  const skillTool = createSkillTool({ depth: 0, forSubagent: false });
  claudeNamedTools.push(skillTool as Record<string, unknown>);

  /**
   * The SlashCommand tool, per session scope: Claude's mechanism for a MODEL to
   * run a custom `/name args` command mid-conversation. A thin alias over the
   * shared skill-activation path — parse the leading `/name` (optional slash;
   * plugin-namespaced `/plugin:name` allowed), treat the rest as the skill's
   * arguments, resolve, and activate. Model-invocability matches the Skill tool
   * (only `disable-model-invocation` blocks; `user-invocable: false` model-only
   * skills still activate) — the NON-stacking single-command counterpart of the
   * user-typed `/name` prompt transform.
   */
  function createSlashCommandTool(opts: { depth: number; forSubagent: boolean }) {
    return {
      name: "SlashCommand",
      label: "SlashCommand",
      description:
        'Run a slash command like "/name args". The name must be one from the "Available skills" listing (plugin-namespaced "/plugin:name" also works); the trailing text is passed to the skill as its arguments. Equivalent to the Skill tool for "/name args" command strings.',
      parameters: Type.Object({
        command: Type.String({ description: 'A slash command such as "/deploy staging 1.2.3"' }),
      }),
      async execute(_id: string, params: { command: string }, signal?: AbortSignal) {
        const parsed = parseSlashCommand(params.command);
        if (!parsed) throw new Error(`SlashCommand requires a command like "/name args".`);
        // findByName resolves plugin-namespaced skills by bare name when unique.
        const skill = findByName(project.skills, parsed.name);
        if (!skill) throw new Error(`Unknown slash command: /${parsed.name}`);
        return runSkillActivation(skill, parsed.argsText, {
          forSubagent: opts.forSubagent,
          depth: opts.depth,
          invokedName: parsed.name,
          signal,
        });
      },
    };
  }
  const slashCommandTool = createSlashCommandTool({ depth: 0, forSubagent: false });
  claudeNamedTools.push(slashCommandTool as Record<string, unknown>);

  if (project.settings.subagentsEnabled) {
    // The built-in agent types (E1) guarantee dispatchable agents even when the
    // project defines none — so Agent/Task always register when subagents are on.
    claudeNamedTools.push(
      createAgentToolDefinition(subagentRuntime, { depth: 0, name: "Agent", backgroundTasks }),
      createAgentToolDefinition(subagentRuntime, { depth: 0, name: "Task", backgroundTasks }),
      // SendMessage (t04): the coordinator's channel back into its subagents —
      // resume a finished one (same id, full context, background) or steer a
      // running background one. Parent-session only (never in customToolsFor).
      createSendMessageToolDefinition(subagentRuntime, {
        registry: subagentRegistry,
        backgroundTasks,
      }),
    );
  }
  // Real TaskOutput/TaskStop (audit E4) — formerly degrade stubs; they answer
  // helpfully even when no background task was ever started.
  claudeNamedTools.push(
    createTaskOutputTool(backgroundTasks) as Record<string, unknown>,
    createTaskStopTool(backgroundTasks) as Record<string, unknown>,
  );

  for (const tool of claudeNamedTools) {
    try {
      pi.registerTool(tool);
    } catch (err) {
      console.error(`PiCC: failed to register tool: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-session native-safe scratch dir (feature 25 / #48)
  // ---------------------------------------------------------------------------
  // Created EAGERLY in the outer scope — before the async IIFE below and the
  // before_agent_start registration — so its literal resolved path is captured
  // synchronously at the t02 system-prompt injection call site (not raced by the
  // first turn nor left `undefined` by the error-swallowing async closure).
  // Order is load-bearing: mkdtemp → realpath → slash-transform. Applying the
  // slash transform before realpath'ing would silently return the backslash form.
  // Root honors CLAUDE_CODE_TMPDIR (Claude Code's actual scratch relocation knob)
  // so a Claude project's tmpdir policy carries over, else os.tmpdir(). Both read
  // the harness process env, which a project settings.json cannot touch.
  let scratchDir: string | undefined;
  try {
    // Root selection + mkdtemp → realpath → slash-transform ORDER live in the pure
    // `computeSessionScratchDir` helper so the wiring test can lock them on any host
    // (see src/util/env.ts + test/subprocess-env.test.ts).
    scratchDir = computeSessionScratchDir({
      env: process.env,
      tmpdir: () => os.tmpdir(),
      mkdtemp: (prefix) => fs.mkdtempSync(prefix),
      realpath: (p) => fs.realpathSync(p),
      join: (a, b) => path.join(a, b),
      platform: process.platform,
    });
  } catch (err) {
    // A scratch-dir failure must never crash activation; t02 simply omits the
    // scratchpad guidance when the value is unavailable.
    console.error(`PiCC: session scratch dir unavailable: ${(err as Error).message}`);
  }

  // Cwd-swapping overrides of Pi built-ins (design doc §3.1). Renderers are inherited.
  void (async () => {
    try {
      const sdk: any = await import("@earendil-works/pi-coding-agent");
      // Pin the shell to real Git Bash on Windows — Pi's default `bash` lookup can
      // land on the System32 WSL stub (WSL_E_DEFAULT_DISTRO_NOT_FOUND without a distro).
      const shellPath = resolveGitBashPath();
      const factories: Array<[string, (cwd: string) => any]> = [
        ["bash", (c) => sdk.createBashTool(c, {
          ...(shellPath ? { shellPath } : {}),
          spawnHook: ({ command, cwd, env }: any) => ({
            command,
            cwd,
            env: unicodeSafeSubprocessEnv({
              ...env,
              ...project.settings.env,
              CLAUDE_PROJECT_DIR: project.root,
            }),
          }),
        })],
        ["read", (c) => sdk.createReadTool(c)],
        ["write", (c) => sdk.createWriteTool(c)],
        ["edit", (c) => sdk.createEditTool(c)],
        ["grep", (c) => sdk.createGrepTool(c)],
        ["find", (c) => sdk.createFindTool(c)],
        ["ls", (c) => sdk.createLsTool(c)],
      ];
      for (const [name, factory] of factories) {
        const template = factory(cwdState.get());
        pi.registerTool({
          ...template,
          name,
          async execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) {
            const live = factory(cwdState.get());
            return live.execute(id, params, signal, onUpdate, ctx);
          },
        });
      }
      // `!` user-bash commands also get the pinned Git Bash (and the effective cwd).
      if (shellPath && typeof sdk.createLocalBashOperations === "function") {
        pi.on("user_bash", () => ({
          operations: sdk.createLocalBashOperations({ shellPath }),
        }));
      }
    } catch (err) {
      console.error(`PiCC: built-in cwd overrides unavailable: ${(err as Error).message}`);
    }
  })();

  // ---------------------------------------------------------------------------
  // Guard: deny rules + PreToolUse/PostToolUse hooks + on-touch context injection
  // ---------------------------------------------------------------------------
  createGuardExtension({
    engine: permissionEngine,
    hooks: hookRunnerFacade,
    getCwd,
    contextForTouchedFile: injectForFile,
    // Active skills' disallowed-tools (§4.1): enforced while the skill is resident.
    extraDenyRules: () => [...activeSkillDenyRules],
  })(pi);

  // ---------------------------------------------------------------------------
  // System prompt assembly (every turn — also compaction preservation, plan §9)
  // ---------------------------------------------------------------------------
  // Skill-listing tier degradation (G5): surfaced once per tier CHANGE — the
  // suffix renders every turn, so a per-render report would spam stderr.
  const reportListingDegradation = createTierChangeReporter((message) =>
    console.error(`PiCC: ${message}`),
  );
  pi.on("before_agent_start", async (event: any) => {
    deliverSettlementNotices();
    try {
      const suffix = buildSystemPromptSuffix({
        claudeMd: project.claudeMd,
        rules: project.rules,
        skills: project.skills,
        // Built-ins appear in the routing catalog after the project's agents (E1).
        agents: project.settings.subagentsEnabled ? agentsWithBuiltins() : [],
        settings: project.settings,
        state,
        steeringText,
        // Feature 25 / #48: the literal native-safe scratch dir (captured eagerly
        // above) is injected on all platforms; the Windows namespace note is gated
        // on the shell↔native split detection.
        scratchDir,
        windowsTempNote: shellNamespaceDiffersFromNative(),
        autoMemory: project.autoMemory,
        onDiagnostic: reportListingDegradation,
      });
      return { systemPrompt: `${event.systemPrompt}\n\n${suffix}` };
    } catch (err) {
      console.error(`PiCC prompt assembly failed: ${(err as Error).message}`);
      return undefined;
    }
  });

  // ---------------------------------------------------------------------------
  // Background settlement notices (t05) — visible without polling
  // ---------------------------------------------------------------------------
  // At the parent's NEXT turn (before_agent_start, above), deliver a one-time,
  // transcript-visible notice for each eligible, uncollected current task
  // generation: outcome (t01 vocabulary — a stopped task reads "aborted"), the
  // capped error when failed, the agent id, and a bounded, explicitly-framed
  // UNTRUSTED excerpt of its output. Delivered via the message-level channel PiCC
  // already uses (pi.sendMessage + deliverAs "steer") so it lands in the
  // transcript like Claude Code's settlement message.
  // Exactly-once delivery combines task-local collected/notified state with the
  // per-agent readiness gate (which a resume re-arms). Folded into the single
  // before_agent_start handler (own try/catch) rather than a second listener, so
  // it can never depend on multi-handler ordering and a drain failure can never
  // break prompt assembly.
  //
  // Honest limitation (v1, documented — flagged for the t07 user guide + registry
  // note): before_agent_start fires when the user continues the conversation, so
  // an IDLE coordinator (turn ended, awaiting input) learns of settlement only
  // when the conversation continues — PiCC does NOT re-invoke an idle agent. No
  // wake-an-idle-parent machinery is built here.
  function deliverSettlementNotices(): void {
    let notices: SettlementNotice[];
    try {
      notices = backgroundTasks.drainSettlementNotices(
        // PEEK the dedup gate (FIX 1) — do not flip it while selecting.
        (agentId) => subagentRegistry.isSettledNoticeArmed(agentId),
        // COMMIT the gate — called by the loop below ONLY after a successful send.
        (agentId) => subagentRegistry.consumeSettledNotice(agentId),
        // Drain-fallback gate (SHOULD-3): a true registry MISS means the dispatch
        // failed at an early guard before it ever registered — the notice is then
        // emitted from the background record itself, exactly once. A registered
        // task always has a record here, so it stays on the consume path above.
        (agentId) => subagentRegistry.get(agentId) !== undefined,
      );
    } catch (err) {
      console.error(`PiCC settlement-notice drain failed: ${(err as Error).message}`);
      return;
    }
    // Deliver each notice in ITS OWN try/catch. Recheck generation validity
    // immediately before send, then commit task-local notification and agent
    // readiness only after pi.sendMessage returns: a throw on one notice must
    // neither drop the remaining batch nor consume the throwing notice.
    for (const notice of notices) {
      try {
        // Test-only synchronous barrier can invalidate a selected generation by
        // collecting it. Production performs no await before the final check,
        // synchronous send, and commit.
        testSeam?.beforeSettlementSend?.(notice);
        if (!notice.isValid()) continue;
        pi.sendMessage(
          { customType: "picc-settlement", content: notice.content, display: true },
          { deliverAs: "steer" },
        );
        notice.commit();
      } catch (err) {
        console.error(`PiCC settlement-notice delivery failed: ${(err as Error).message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------
  pi.on("session_start", async (event: any, ctx: any) => {
    try {
      modelRegistryRef = ctx.modelRegistry;
      sessionManagerRef = ctx.sessionManager;
      if (ctx.model) {
        currentModel = ctx.model;
        currentModelRef = `${ctx.model.provider}/${ctx.model.id}`;
        steeringText = steeringForModel(config, currentModelRef);
      }
      if (config.model && event.reason === "startup") {
        const m = resolveModelSpec(config.model);
        if (m) await pi.setModel(m);
      }
      if (config.effort) {
        const level = mapEffort(config, config.effort);
        if (level) pi.setThinkingLevel(level);
      }
      // core.hooksPath self-heal (plan §4.5 git-hook interplay)
      if (fs.existsSync(path.join(project.root, ".githooks"))) {
        const current = await pi.exec("git", ["config", "core.hooksPath"], {}).catch(() => ({ stdout: "" }));
        if (!String(current.stdout ?? "").trim()) {
          await pi.exec("git", ["config", "core.hooksPath", ".githooks"], {}).catch(() => undefined);
        }
      }
      const outcome = await hooks.fire("SessionStart", {
        source: event.reason,
        cwd: cwdState.get(),
      });
      const hookContext = [outcome.stdout, outcome.additionalContext].filter(Boolean).join("\n");
      if (hookContext.trim()) {
        pi.sendMessage(
          { customType: "picc-hook-context", content: hookContext.trim(), display: true },
          { deliverAs: "nextTurn" },
        );
      }
      if (!compatSuppressed && event.reason === "startup") {
        const notice = renderStartupNotice(compat, { suppressed: false });
        if (notice && ctx.hasUI) ctx.ui.notify(notice.split("\n")[0] + " — run /doctor", "warning");
        if (notice) {
          pi.appendEntry("picc-compat", { notice });
        }
      }
    } catch (err) {
      console.error(`PiCC session_start failed: ${(err as Error).message}`);
    }
  });

  pi.on("session_shutdown", async (event: any) => {
    try {
      // `reason` is the matcher subject for SessionEnd (Claude wire contract).
      await hooks.fire("SessionEnd", { cwd: cwdState.get(), reason: event?.reason ?? "other" });
    } catch {
      /* floor */
    }
  });

  pi.on("input", async (event: any, ctx: any) => {
    try {
      if (event.source === "extension") return { action: "continue" };

      // 0) PiCC control commands (/doctor /compat /quota /skills /agents /usage).
      //    In interactive mode Pi's own command router intercepts these before
      //    the input event; this branch covers the other modes so a control
      //    command is never sent to the model.
      const cmd = /^\/(doctor|compat|quota|skills|agents|usage)(?:[ \t]+([\s\S]*))?$/.exec(
        (event.text ?? "").trim(),
      );
      if (cmd) {
        const output = runControlCommand(cmd[1]!, cmd[2] ?? "", ctx);
        if (output !== undefined) {
          emitControlOutput(cmd[1]!, output, ctx);
          return { action: "handled" };
        }
      }

      // 1) UserPromptSubmit hook on the raw prompt (Claude order).
      const outcome = await hooks.fire("UserPromptSubmit", {
        prompt: event.text,
        cwd: cwdState.get(),
      });
      if (outcome.block) {
        if (ctx.hasUI) ctx.ui.notify(`Prompt blocked by hook: ${outcome.blockReason ?? ""}`, "warning");
        return { action: "handled" };
      }
      const extra = [outcome.stdout, outcome.additionalContext].filter(Boolean).join("\n").trim();
      const hookSuffix = extra ? `\n\n<hook-context>\n${extra}\n</hook-context>` : "";

      // 2) Skill slash command(s): expand `/name [args]` into the user turn,
      //    exactly as Claude Code does (this is why it must be a transform, not
      //    a self-dispatching extension command — those can't reliably trigger
      //    a turn in print mode). Up to 5 LEADING skill tokens stack
      //    (`/skill-a /skill-b remaining text`, Claude v2.1.199): all activate
      //    in order and the remaining text is the LAST skill's arguments — its
      //    rendered activation carries the text (via $ARGUMENTS/$N markers, or
      //    the ARGUMENTS: fallback when the body has none).
      const text: string = event.text ?? "";
      // Colons allowed: plugin-namespaced invocations (`/my-plugin:review`) are CC syntax.
      const skillTokenRe = /^\/([A-Za-z0-9][\w-]*(?::[\w-]+)*)(?=[ \t]|$)/;
      let rest = text.trim();
      const stacked: ClaudeSkill[] = [];
      while (stacked.length < 5) {
        const m = skillTokenRe.exec(rest);
        if (!m) break;
        const found = findByName(project.skills, m[1]!);
        // Stop at the first token that doesn't resolve to a user-invocable skill.
        if (!found?.userInvocable) break;
        stacked.push(found);
        rest = rest.slice(m[0].length).replace(/^[ \t]+/, "");
      }
      if (stacked.length) {
        const parts: string[] = [];
        for (let i = 0; i < stacked.length; i++) {
          const skill = stacked[i]!;
          const argsText = i === stacked.length - 1 ? rest : "";
          debug(`input: expanding skill /${skill.name}`);
          const rendered = await activateSkill(skill, argsText, { fork: skill.contextFork });
          if (skill.contextFork) {
            // A typed `/forked-skill` runs synchronously inside this input hook,
            // BEFORE the turn streams — so `ctx.signal` is undefined here (there is
            // no active run to abort). In interactive mode we still make it
            // Esc-cancellable: watch raw terminal input (`ctx.ui.onTerminalInput`,
            // interactive-only) and abort our own controller on a bare Esc,
            // threading that into the fork. Print/RPC modes expose no
            // `onTerminalInput` and have no Esc, so the fork simply runs to
            // completion (and `ctx.signal` stays the source of truth if Pi ever
            // provides one at this stage).
            let forkSignal: AbortSignal | undefined = ctx.signal;
            let stopEscWatch: (() => void) | undefined;
            if (!forkSignal && typeof ctx.ui?.onTerminalInput === "function") {
              // Subscribing is host (Pi) plumbing — if it throws, degrade to an
              // uncancellable fork rather than let the throw reach the handler's
              // catch and leak the raw `/skill` to the model (never-throw, below).
              try {
                const escController = new AbortController();
                stopEscWatch = ctx.ui.onTerminalInput((data: string) => {
                  // A lone ESC (0x1b) is a cancel; ESC-prefixed sequences (arrow
                  // keys, etc.) are longer, so match the bare byte only. Consume it
                  // so Pi doesn't also act on the same keypress.
                  if (data.length === 1 && data.charCodeAt(0) === 0x1b) {
                    escController.abort();
                    return { consume: true };
                  }
                  return undefined;
                });
                forkSignal = escController.signal;
              } catch {
                stopEscWatch = undefined;
                forkSignal = ctx.signal;
              }
            }
            // Fork non-resumable (allowResumeTrailer:false) and — critically —
            // EVERY outcome is folded into the transform text, never thrown: a
            // throw here would hit the handler's catch and send the raw
            // unexpanded `/skill` to the model, silently dropping the fork's work.
            let result;
            try {
              result = await forkDispatch(skill, rendered, 1, argsText, forkSignal);
            } finally {
              // Teardown must never throw over a computed result.
              try {
                stopEscWatch?.();
              } catch {
                /* ignore terminal-input unsubscribe failure */
              }
            }
            const p = presentDispatchResult(result, { allowResumeTrailer: false });
            parts.push(
              p.kind === "result"
                ? // completed OR failed-with-partial: p.text already carries the
                  // partial + cut-off note when the run died mid-flight.
                  `The ${skill.name} skill ran in a forked subagent. Its result:\n\n${p.text}`
                : // failed-no-output / aborted: name the cause loudly (no partial
                  // to preserve); the expansion still happens so the turn proceeds.
                  `The ${skill.name} skill (context: fork) did not finish: ${p.message}`,
            );
            continue;
          }
          // Byte-identical re-invocation → short note instead of a second copy (audit A8).
          const note = skillDedupNote(skill, rendered);
          parts.push(note ?? skillActivationMessage(skill, rendered));
        }
        // The trailing text is NOT re-appended as its own part (G6): the last
        // skill's rendered activation already carries it as $ARGUMENTS (or via
        // the ARGUMENTS: fallback), so a second copy would duplicate the request.
        return { action: "transform", text: parts.join("\n\n") + hookSuffix };
      }

      if (hookSuffix) {
        return { action: "transform", text: `${text}${hookSuffix}` };
      }
      return { action: "continue" };
    } catch (err) {
      debug(`input handler error: ${(err as Error).message}`);
      return { action: "continue" };
    }
  });

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    try {
      // Stop payload `last_assistant_message` (Claude wire contract): the
      // settled event carries no messages, so read the session branch via ctx
      // (best-effort — the field is simply absent when the host exposes none).
      let lastAssistantMessage: string | undefined;
      try {
        const sm = ctx?.sessionManager;
        const entries: any[] = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
          const content = entry.message.content;
          lastAssistantMessage =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter((c: any) => c?.type === "text")
                    .map((c: any) => String(c.text ?? ""))
                    .join("")
                : undefined;
          break;
        }
      } catch {
        /* best-effort field */
      }
      const outcome = await hooks.fire("Stop", {
        cwd: cwdState.get(),
        stop_hook_active: stopHookIterations > 0,
        ...(lastAssistantMessage !== undefined
          ? { last_assistant_message: lastAssistantMessage }
          : {}),
      });
      // Claude caps consecutive Stop-hook blocks at 8, then stops anyway.
      if (outcome.block && stopHookIterations < 8) {
        stopHookIterations++;
        pi.sendUserMessage(
          `[Stop hook] Continue working: ${outcome.blockReason ?? "the stop condition is not met yet"}`,
        );
      } else {
        stopHookIterations = 0;
      }
    } catch {
      /* floor */
    }
  });

  pi.on("session_before_compact", async (event: any) => {
    try {
      // `trigger` (manual|auto) is the matcher subject Claude documents for PreCompact.
      await hooks.fire("PreCompact", {
        reason: event.reason,
        trigger: event.reason === "manual" ? "manual" : "auto",
        cwd: cwdState.get(),
      });
    } catch {
      /* floor */
    }
    return undefined; // let Pi's compaction run; preservation happens via system prompt + below
  });

  pi.on("session_compact", async () => {
    try {
      await hooks.fire("PostCompact", { cwd: cwdState.get() });
      // Path-scoped artifacts reload on next relevant access (plan §9): compaction
      // summarized their transcript messages away, so the once-only markers reset.
      resetInjectionState(state, project.claudeMd);
      // Re-inject active skill bodies for mid-turn continuity (plan §9). Auto-
      // compaction happens MID-RUN and the aborted turn is retried immediately, so
      // this must deliver before the next LLM call ("steer") — "nextTurn" would sit
      // queued until the next user prompt, exactly the /doctor-class bug.
      // Budgeted like Claude's carryover (audit A9): ~5k tokens per skill,
      // ~25k combined, most recently activated first.
      if (state.activeSkills.size) {
        const budgeted = budgetSkillReinjection([...state.activeSkills.entries()]);
        for (const name of budgeted.dropped) {
          debug(
            `compaction: active skill "${name}" dropped from re-injection (combined budget exceeded)`,
          );
        }
        if (budgeted.text) {
          pi.sendMessage(
            {
              customType: "picc-preserved",
              content: `Context preserved across compaction (PiCC):\n\n${budgeted.text}`,
              display: false,
            },
            { deliverAs: "steer" },
          );
        }
      }
    } catch {
      /* floor */
    }
  });

  pi.on("model_select", (event: any) => {
    try {
      currentModel = event.model;
      currentModelRef = `${event.model.provider}/${event.model.id}`;
      steeringText = steeringForModel(config, currentModelRef);
    } catch {
      /* floor */
    }
  });

  pi.on("after_provider_response", (event: any) => {
    try {
      for (const [key, value] of Object.entries(event.headers ?? {})) {
        if (/rate-?limit|quota|usage|remaining|reset/i.test(key)) {
          quotaHeaders[key] = String(value);
        }
      }
    } catch {
      /* floor */
    }
  });

  // ---------------------------------------------------------------------------
  // Control commands: /doctor /compat /quota /skills /agents /usage.
  //
  // Rendered by shared functions so BOTH the registered command (interactive
  // path, where Pi intercepts extension commands before the model) and the
  // `input` handler (all other modes, so a control command never leaks to the
  // model) produce identical output.
  // ---------------------------------------------------------------------------
  function renderSkillsList(): string {
    const invocable = project.skills.filter((s) => s.userInvocable);
    const modelOnly = project.skills.filter((s) => !s.userInvocable && !s.disableModelInvocation);
    const userOnly = project.skills.filter((s) => s.disableModelInvocation);
    const fmt = (s: ClaudeSkill) =>
      `  /${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ""} — ${s.description}` +
      (s.source.pluginName ? ` [plugin: ${s.source.pluginName}]` : ` [${s.source.scope}]`);
    const lines = [
      `PiCC — ${project.skills.length} skill(s) loaded`,
      "",
      `Invocable as slash commands (${invocable.length}):`,
      ...invocable.map(fmt),
    ];
    if (modelOnly.length) {
      lines.push("", `Model-invocable only (${modelOnly.length}) — the model activates these via the Skill tool:`);
      lines.push(...modelOnly.map((s) => `  ${s.name} — ${s.description}`));
    }
    if (userOnly.length) {
      lines.push("", `User-only, model cannot self-invoke (${userOnly.length}):`);
      lines.push(...userOnly.map((s) => `  /${s.name} — ${s.description}`));
    }
    return lines.join("\n");
  }

  function renderAgentsList(): string {
    // Same catalog the model sees: project/user/plugin agents plus the
    // non-overridden built-ins (general-purpose/Explore/Plan).
    const agents = agentsWithBuiltins();
    if (!agents.length) return "No subagents are available.";
    const lines = [
      `PiCC — ${agents.length} subagent(s) available (dispatch with the Agent tool):`,
      "",
    ];
    for (const a of agents) {
      const gated = permissionEngine.gateTools(a.tools, a.disallowedTools, allKnownToolNames());
      const readOnly = a.tools && !["Write", "Edit", "Bash"].some((t) => gated.includes(t));
      const tags = [
        a.source.pluginName ? `plugin: ${a.source.pluginName}` : a.source.scope,
        readOnly ? "read-only" : undefined,
        a.model ? `model: ${a.model}` : undefined,
        a.isolation === "worktree" ? "worktree-isolated" : undefined,
      ].filter(Boolean);
      lines.push(`  ${a.name} [${tags.join(", ")}]`);
      lines.push(`    ${a.description.split("\n")[0]}`);
      lines.push(`    tools: ${gated.length ? gated.join(", ") : "(all)"}`);
    }
    return lines.join("\n");
  }

  /**
   * `/usage` (t06): per-subagent token/cost breakdown for THIS session, plus a
   * session total — aggregated from the dispatch registry (t04). The user noted
   * Pi's own usage surface is unhelpful; this is the per-subagent view. Lists
   * each dispatched agent's id, type, outcome, usage, and transcript path — the
   * one place a human can look for what their fan-out cost.
   */
  function renderUsageReport(): string {
    const records = subagentRegistry.list();
    if (!records.length) {
      return "No subagents have been dispatched this session (nothing to account for yet).";
    }
    const lines = [
      `PiCC — per-subagent token/cost this session (${records.length} dispatched) — does NOT include the main agent's own usage:`,
      "  Note: the main-agent / whole-session total is not shown here — the Pi extension API doesn't expose it, so this covers subagents only.",
      "",
    ];
    // Session total: sum each field only across records that reported it, so a
    // field absent everywhere stays absent (never invented as a zero).
    const total: Record<string, number> = {};
    const usageKeys = [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "costUsd",
    ] as const;
    const addToTotal = (record: SubagentRegistryRecord) => {
      const usage = record.usage;
      if (!usage) return;
      for (const key of usageKeys) {
        const value = usage[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          total[key] = (total[key] ?? 0) + value;
        }
      }
    };
    for (const record of records) {
      const state = record.state === "running" ? "running" : record.outcome ?? "settled";
      // SECURITY (FIX 4, defense-in-depth): agentName comes from agent frontmatter
      // `name`/basename (only `.trim()`ed upstream — control bytes survive) and is
      // printed to the human terminal; single-line-sanitize it so an ANSI/OSC/
      // control-byte agent name cannot inject into the terminal on /usage.
      const agentName = sanitizeLine(record.agentName, 120);
      lines.push(`  ${record.agentId} (${agentName}) — ${state}`);
      const usageLine = formatUsageCompact(record.usage);
      lines.push(`    usage: ${usageLine ?? "(none recorded)"}`);
      if (record.transcriptPath) lines.push(`    transcript: ${record.transcriptPath}`);
      addToTotal(record);
    }
    const totalLine = formatUsageCompact(total);
    lines.push("", `  Subagents total: ${totalLine ?? "(no usage recorded)"}`);
    return lines.join("\n");
  }

  function renderQuota(ctx: any): string {
    const usage = ctx?.getContextUsage?.();
    return [
      `Model: ${currentModelRef || "(not selected yet)"}`,
      usage ? `Context: ~${usage.tokens} tokens used` : undefined,
      Object.keys(quotaHeaders).length
        ? `Provider quota headers:\n${Object.entries(quotaHeaders)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join("\n")}`
        : "No quota headers observed yet (best-effort feature — send a prompt first).",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Renders control-command output (and the compat notice) as a TUI-only
   * transcript entry. Pi's `Component` contract is structural
   * ({ render(width) => lines }), so no pi-tui import is needed.
   */
  function controlOutputComponent(title: string, body: string, theme: any) {
    return {
      render(width: number): string[] {
        const lines: string[] = [title ? (theme?.fg ? theme.fg("accent", title) : title) : ""];
        for (const raw of String(body).split("\n")) {
          if (width > 0 && raw.length > width) {
            for (let i = 0; i < raw.length; i += width) lines.push(raw.slice(i, i + width));
          } else {
            lines.push(raw);
          }
        }
        return lines.filter((l, i) => l !== "" || i > 0);
      },
    };
  }
  pi.registerEntryRenderer("picc-control", (entry: any, _opts: any, theme: any) =>
    controlOutputComponent(`/${entry.data?.command ?? "picc"}`, entry.data?.output ?? "", theme),
  );
  pi.registerEntryRenderer("picc-compat", (entry: any, _opts: any, theme: any) =>
    controlOutputComponent("PiCC compatibility", entry.data?.notice ?? "", theme),
  );

  /**
   * Shows control-command output immediately. An appended entry renders in the
   * TUI transcript right away and never enters LLM context (a control command is
   * user-facing status, not model input); headless modes get it on stdout.
   */
  function emitControlOutput(name: string, output: string, ctx: any): void {
    pi.appendEntry("picc-control", { command: name, output });
    if (!ctx?.hasUI) console.log(output);
  }

  /** Runs a control command by name; returns its output text, or undefined if not one. */
  function runControlCommand(name: string, args: string, ctx: any): string | undefined {
    switch (name) {
      case "doctor":
        return renderDoctorReport(project, compat);
      case "skills":
        return renderSkillsList();
      case "agents":
        return renderAgentsList();
      case "usage":
        return renderUsageReport();
      case "quota":
        return renderQuota(ctx);
      case "compat": {
        const arg = (args ?? "").trim();
        if (arg === "suppress") {
          writeSuppression(project.root, true);
          compatSuppressed = true;
          return "Compatibility notice suppressed for this project.";
        }
        if (arg === "show") {
          writeSuppression(project.root, false);
          compatSuppressed = false;
        }
        return renderStartupNotice(compat, { suppressed: false }) ?? "No compatibility findings for this project.";
      }
      default:
        return undefined;
    }
  }

  const CONTROL_COMMANDS: Record<string, string> = {
    doctor: "PiCC: full compatibility breakdown for this project",
    compat: "PiCC: show or suppress the compatibility notice (usage: /compat [suppress|show])",
    quota: "PiCC: subscription/rate-limit info from the last provider response",
    skills: "PiCC: list the project's Claude skills (invocable + model-only)",
    agents: "PiCC: list the subagents available for dispatch",
    usage: "PiCC: per-subagent token/cost this session (subagents only — not the main agent's own usage), with a total",
  };
  for (const [name, description] of Object.entries(CONTROL_COMMANDS)) {
    pi.registerCommand(name, {
      description,
      handler: async (args: string, ctx: any) => {
        const output = runControlCommand(name, args, ctx);
        if (output !== undefined) emitControlOutput(name, output, ctx);
      },
    });
  }

  debug(
    `loaded project root=${project.root} skills=${project.skills.length} agents=${project.agents.length} rules=${project.rules.length}`,
  );

  // ---------------------------------------------------------------------------
  // Slash-command visibility for user-invocable skills.
  //
  // Skills are EXECUTED by the `input` handler above (transform → the skill body
  // becomes the user turn — Claude Code's slash semantics, works in every mode,
  // and lets a project skill win over a same-named plugin command). They are made
  // VISIBLE in the `/` palette by contributing one Pi prompt-template stub per
  // skill via `resources_discover`. The `input` transform runs before prompt-
  // template expansion, so the stub body is only a fallback and never normally
  // used — it exists purely so `/name` shows up with its description and hint.
  // ---------------------------------------------------------------------------
  // Ensure the harness-owned dir never appears as untracked in the project.
  try {
    const gitInfo = path.join(project.root, ".git", "info");
    if (fs.existsSync(gitInfo)) {
      const excludeFile = path.join(gitInfo, "exclude");
      const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
      if (!existing.includes(".claude/.picc/")) {
        fs.appendFileSync(
          excludeFile,
          `${existing.endsWith("\n") || existing === "" ? "" : "\n"}.claude/.picc/\n`,
        );
      }
    }
  } catch {
    /* best-effort — never fail startup over gitignore hygiene */
  }

  const promptStubDir = path.join(project.root, ".claude", ".picc", "prompts");
  // Our own commands + Pi built-in slash commands — don't advertise stubs that
  // would duplicate or be shadowed by these (the skill still executes via the
  // input handler if the name is typed and not intercepted as a built-in).
  const RESERVED_NAMES = new Set([
    "doctor", "compat", "quota", "skills", "agents", "usage",
    "changelog", "clone", "compact", "copy", "export", "fork", "hotkeys", "import",
    "login", "logout", "model", "name", "new", "quit", "reload", "resume",
    "scoped-models", "session", "settings", "share", "tree", "trust", "help",
  ]);
  try {
    fs.rmSync(promptStubDir, { recursive: true, force: true });
    fs.mkdirSync(promptStubDir, { recursive: true });
    for (const skill of project.skills) {
      if (!skill.userInvocable) continue;
      if (RESERVED_NAMES.has(skill.name)) continue;
      if (!/^[A-Za-z0-9][\w-]*$/.test(skill.name)) continue;
      const fm = [
        "---",
        `description: ${JSON.stringify(skill.description || `Run the ${skill.name} skill`)}`,
        ...(skill.argumentHint ? [`argument-hint: ${JSON.stringify(skill.argumentHint)}`] : []),
        "---",
        `Run the project skill "${skill.name}"${skill.argumentHint ? ` with arguments: $ARGUMENTS` : ""}.`,
        "",
        `(PiCC expands this skill in full — including argument, variable and`,
        `shell-injection processing — when you invoke /${skill.name}.)`,
      ].join("\n");
      fs.writeFileSync(path.join(promptStubDir, `${skill.name}.md`), fm, "utf8");
    }
    debug(`wrote ${fs.readdirSync(promptStubDir).length} prompt stubs to ${promptStubDir}`);
  } catch (err) {
    debug(`prompt-stub generation failed (skills still work via input): ${(err as Error).message}`);
  }

  pi.on("resources_discover", () => ({ promptPaths: [promptStubDir] }));
}

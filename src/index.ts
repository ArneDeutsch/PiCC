import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { HookOutcome, HookPayload, ToolCallDescriptor } from "./types.js";
import { loadClaudeProject, type LoadedProject } from "./project.js";
import { loadPiClauDexConfig, mapEffort, steeringForModel } from "./runtime/steering.js";
import { CwdState } from "./runtime/cwd-state.js";
import { HookRunner } from "./engine/hook-runner.js";
import { PermissionEngine } from "./engine/permissions.js";
import { parseHookConfig } from "./claude/hooks.js";
import { WorktreeManager } from "./runtime/worktrees.js";
import { SubagentRuntime, createAgentToolDefinition } from "./runtime/subagents.js";
import { createGuardExtension } from "./runtime/guard.js";
import {
  buildSystemPromptSuffix,
  contextForTouchedFile,
  newSessionContextState,
} from "./runtime/context-assembly.js";
import { renderSkillForActivation, skillActivationMessage } from "./runtime/skill-activation.js";
import { createWorktreeTools } from "./runtime/tools/worktree-tools.js";
import { createWebFetchTool, createWebSearchTool } from "./runtime/tools/web-tools.js";
import { createGrepTool as createClaudeGrepTool, createGlobTool } from "./runtime/tools/search-tools.js";
import { createTaskTools } from "./runtime/tools/task-tools.js";
import { createDegradeStub, DEGRADED_TOOLS } from "./runtime/tools/degrade-stubs.js";
import { buildCompatReport, readSuppression, renderDoctorReport, renderStartupNotice, writeSuppression } from "./registry/compat-report.js";
import { loadSkillBody, substituteVariables } from "./claude/skills.js";
import { resolveGitBashPath } from "./engine/shell-inject.js";
import type { ClaudeAgent, ClaudeSkill } from "./types.js";

/**
 * PiClauDex — the Pi extension entry.
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
      merged.diagnostics.push(...o.diagnostics);
    }
    return merged;
  }
}

const CLAUDE_MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "inherit", "claude"]);

/** Diagnosability channel (plan §12.4): PICLAUDEX_DEBUG=1 traces decisions to stderr. */
function debug(...args: unknown[]): void {
  if (process.env.PICLAUDEX_DEBUG) console.error("[piclaudex]", ...args);
}

export default function piclaudex(pi: any) {
  let project: LoadedProject;
  try {
    // PICLAUDEX_CLAUDE_USER_DIR overrides ~/.claude (tests, multi-profile setups).
    project = loadClaudeProject({
      cwd: process.cwd(),
      userDir: process.env.PICLAUDEX_CLAUDE_USER_DIR || undefined,
    });
  } catch (err) {
    // Completeness floor: a broken project must never crash the harness.
    console.error(`PiClauDex failed to load project artifacts: ${(err as Error).message}`);
    return;
  }

  const config = loadPiClauDexConfig(project.root);
  const sessionId = randomUUID();
  const cwdState = new CwdState(project.cwd);
  const baseHooks = new HookRunner({
    config: project.mergedHooks,
    projectDir: project.root,
    sessionId,
    env: project.settings.env,
    disableAllHooks: project.settings.disableAllHooks,
    pluginRoots: project.pluginRoots,
  });
  const hooks = new HookMultiplexer(baseHooks);
  const permissionEngine = new PermissionEngine(project.settings.permissions, {
    cwd: project.cwd,
  });
  const worktrees = new WorktreeManager({
    projectRoot: project.root,
    settings: project.settings.worktree,
  });
  const state = newSessionContextState(project.claudeMd);
  const compat = buildCompatReport(project);
  let compatSuppressed = readSuppression(project.root) || config.suppressCompatNotice === true;

  let currentModelRef = "";
  let currentModel: unknown; // the orchestrator's active model — inherited by subagents
  let steeringText: string | undefined;
  let stopHookIterations = 0;
  const quotaHeaders: Record<string, string> = {};

  const hookRunnerFacade = {
    fire: (event: string, payload: Partial<HookPayload>, call?: ToolCallDescriptor) =>
      hooks.fire(event, payload, call),
  } as unknown as HookRunner;

  const injectForFile = (filePath: string) =>
    contextForTouchedFile({
      filePath,
      cwd: cwdState.get(),
      projectRoot: project.root,
      rules: project.rules,
      settings: project.settings,
      state,
    });

  // ---------------------------------------------------------------------------
  // Skill activation (shared by Skill tool, slash commands, context:fork)
  // ---------------------------------------------------------------------------
  function pluginContextFor(skill: ClaudeSkill): { root?: string; data?: string } {
    const pluginName = skill.source.pluginName;
    if (!pluginName) return {};
    const plugin = project.plugins.find((p) => p.name === pluginName);
    return plugin ? { root: plugin.root, data: plugin.dataDir } : {};
  }

  async function activateSkill(skill: ClaudeSkill, argsText: string): Promise<string> {
    if (skill.hooks && Object.keys(skill.hooks).length) {
      const parsed = parseHookConfig(skill.hooks, skill.source.path);
      hooks.addScoped(
        new HookRunner({
          config: parsed.config,
          projectDir: project.root,
          sessionId,
          env: project.settings.env,
          disableAllHooks: project.settings.disableAllHooks,
          pluginRoots: project.pluginRoots,
        }),
      );
    }
    const plugin = pluginContextFor(skill);
    const rendered = await renderSkillForActivation({
      skill,
      argsText,
      projectRoot: project.root,
      cwd: cwdState.get(),
      sessionId,
      effort: config.effort,
      settings: project.settings,
      pluginRoot: plugin.root,
      pluginData: plugin.data,
    });
    state.activeSkills.set(skill.name, rendered.text);
    return rendered.text;
  }

  // ---------------------------------------------------------------------------
  // Subagent runtime
  // ---------------------------------------------------------------------------
  const taskToolBundle = createTaskTools();
  const claudeNamedTools: Record<string, unknown>[] = [];

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

  function buildSubagentSystemPrompt(agent: ClaudeAgent): string {
    const sections: string[] = [agent.body.trim()];
    // Preloaded skills (agent `skills:`): body + variables, no args/shell (sync path).
    for (const name of agent.skills ?? []) {
      const skill = project.skills.find((s) => s.name === name);
      if (!skill) continue;
      const body = substituteVariables(loadSkillBody(skill), {
        CLAUDE_SKILL_DIR: skill.baseDir,
        CLAUDE_PROJECT_DIR: project.root,
        CLAUDE_SESSION_ID: sessionId,
        CLAUDE_EFFORT: agent.effort ?? "",
      });
      sections.push(`## Preloaded skill: ${name}\n\n${body.trim()}`);
    }
    const granted = permissionEngine.gateTools(agent.tools, agent.disallowedTools, allKnownToolNames());
    const suffix = buildSystemPromptSuffix({
      claudeMd: project.claudeMd,
      rules: project.rules,
      skills: project.skills,
      agents: granted.includes("Agent") || granted.includes("Task") ? project.agents : [],
      settings: project.settings,
      state: newSessionContextState(project.claudeMd),
      steeringText,
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
      "WebFetch",
      "WebSearch",
      "Agent",
      "Task",
      "Skill",
      "EnterWorktree",
      "ExitWorktree",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TodoWrite",
      ...DEGRADED_TOOLS.map((d) => d.name),
    ];
  }

  const subagentRuntime = new SubagentRuntime({
    getAgents: () => project.agents,
    buildSystemPrompt: buildSubagentSystemPrompt,
    customToolsFor: (agent, granted, depth) => {
      const tools: Record<string, unknown>[] = [];
      for (const tool of claudeNamedTools) {
        const name = (tool as { name: string }).name;
        if (name === "Agent" || name === "Task") continue; // depth-bound below
        if (granted.includes(name)) tools.push(tool);
      }
      if (
        project.settings.subagentsEnabled &&
        depth + 1 <= project.settings.subagentMaxDepth &&
        (granted.includes("Agent") || granted.includes("Task"))
      ) {
        tools.push(createAgentToolDefinition(subagentRuntime, { depth, name: "Agent" }));
      }
      return tools;
    },
    allKnownToolNames,
    permissionEngine,
    hookRunner: hookRunnerFacade,
    getCwd: () => cwdState.get(),
    contextForTouchedFile: injectForFile,
    resolveModel: resolveModelSpec,
    mapEffort: (effort) => mapEffort(config, effort),
    worktrees,
    maxDepth: project.settings.subagentMaxDepth,
    concurrency: project.settings.subagentConcurrency,
    sessionId,
  });

  // ---------------------------------------------------------------------------
  // Tool registration
  // ---------------------------------------------------------------------------
  const getCwd = () => cwdState.get();
  claudeNamedTools.push(
    createWebFetchTool(getCwd) as unknown as Record<string, unknown>,
    createWebSearchTool(getCwd) as unknown as Record<string, unknown>,
    createClaudeGrepTool(getCwd) as unknown as Record<string, unknown>,
    createGlobTool(getCwd) as unknown as Record<string, unknown>,
    ...(taskToolBundle.tools as unknown as Record<string, unknown>[]),
    ...createWorktreeTools({ worktrees, cwdState, hookRunner: hookRunnerFacade }),
    ...DEGRADED_TOOLS.map(
      (d) => createDegradeStub(d.name, d.note) as unknown as Record<string, unknown>,
    ),
  );

  const skillTool = {
    name: "Skill",
    label: "Skill",
    description:
      "Activate a skill from the 'Available skills' listing. The skill's full instructions load into context; follow them immediately.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name from the listing" }),
      arguments: Type.Optional(Type.String({ description: "Arguments for the skill, if any" })),
    }),
    async execute(_id: string, params: { name: string; arguments?: string }) {
      const skill = project.skills.find((s) => s.name === params.name);
      if (!skill) throw new Error(`Unknown skill: ${params.name}`);
      if (skill.disableModelInvocation) {
        throw new Error(`Skill "${params.name}" is user-only (disable-model-invocation). Ask the user to run /${params.name}.`);
      }
      if (skill.contextFork) {
        const rendered = await activateSkill(skill, params.arguments ?? "");
        const result = await subagentRuntime.dispatch({
          subagentType: skill.forkAgentType ?? project.agents[0]?.name ?? "",
          prompt: rendered,
          depth: 1,
        });
        if (!result.ok) throw new Error(result.error ?? "context:fork dispatch failed");
        return {
          content: [{ type: "text", text: result.finalMessage }],
          details: { forked: true, agent: result.agentName },
        };
      }
      const rendered = await activateSkill(skill, params.arguments ?? "");
      return {
        content: [{ type: "text", text: skillActivationMessage(skill, rendered) }],
        details: { skill: skill.name },
      };
    },
  };
  claudeNamedTools.push(skillTool as Record<string, unknown>);

  if (project.settings.subagentsEnabled && project.agents.length) {
    claudeNamedTools.push(
      createAgentToolDefinition(subagentRuntime, { depth: 0, name: "Agent" }),
      createAgentToolDefinition(subagentRuntime, { depth: 0, name: "Task" }),
    );
  }

  for (const tool of claudeNamedTools) {
    try {
      pi.registerTool(tool);
    } catch (err) {
      console.error(`PiClauDex: failed to register tool: ${(err as Error).message}`);
    }
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
            env: { ...env, ...project.settings.env, CLAUDE_PROJECT_DIR: project.root },
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
      console.error(`PiClauDex: built-in cwd overrides unavailable: ${(err as Error).message}`);
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
  })(pi);

  // ---------------------------------------------------------------------------
  // System prompt assembly (every turn — also compaction preservation, plan §9)
  // ---------------------------------------------------------------------------
  pi.on("before_agent_start", async (event: any) => {
    try {
      const suffix = buildSystemPromptSuffix({
        claudeMd: project.claudeMd,
        rules: project.rules,
        skills: project.skills,
        agents: project.settings.subagentsEnabled ? project.agents : [],
        settings: project.settings,
        state,
        steeringText,
      });
      return { systemPrompt: `${event.systemPrompt}\n\n${suffix}` };
    } catch (err) {
      console.error(`PiClauDex prompt assembly failed: ${(err as Error).message}`);
      return undefined;
    }
  });

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------
  pi.on("session_start", async (event: any, ctx: any) => {
    try {
      modelRegistryRef = ctx.modelRegistry;
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
          { customType: "piclaudex-hook-context", content: hookContext.trim(), display: true },
          { deliverAs: "nextTurn" },
        );
      }
      if (!compatSuppressed && event.reason === "startup") {
        const notice = renderStartupNotice(compat, { suppressed: false });
        if (notice && ctx.hasUI) ctx.ui.notify(notice.split("\n")[0] + " — run /doctor", "warning");
        if (notice) {
          pi.appendEntry("piclaudex-compat", { notice });
        }
      }
    } catch (err) {
      console.error(`PiClauDex session_start failed: ${(err as Error).message}`);
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      await hooks.fire("SessionEnd", { cwd: cwdState.get() });
    } catch {
      /* floor */
    }
  });

  pi.on("input", async (event: any, ctx: any) => {
    try {
      if (event.source === "extension") return { action: "continue" };

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

      // 2) Skill slash command: expand `/name [args]` into the user turn, exactly
      //    as Claude Code does (this is why it must be a transform, not a
      //    self-dispatching extension command — those can't reliably trigger a
      //    turn in print mode).
      const text: string = event.text ?? "";
      const m = /^\/([A-Za-z0-9][\w-]*)(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
      if (m) {
        const skill = project.skills.find(
          (s) => s.name === m[1] && s.userInvocable && !s.legacyCommand === !s.legacyCommand,
        );
        if (skill && skill.userInvocable) {
          debug(`input: expanding skill /${skill.name}`);
          const rendered = await activateSkill(skill, m[2] ?? "");
          if (skill.contextFork) {
            const result = await subagentRuntime.dispatch({
              subagentType: skill.forkAgentType ?? project.agents[0]?.name ?? "",
              prompt: rendered,
              depth: 1,
            });
            const forkText = result.ok
              ? `The ${skill.name} skill ran in a forked subagent. Its result:\n\n${result.finalMessage}`
              : `The ${skill.name} skill (context: fork) failed: ${result.error}`;
            return { action: "transform", text: forkText + hookSuffix };
          }
          return { action: "transform", text: skillActivationMessage(skill, rendered) + hookSuffix };
        }
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
      const outcome = await hooks.fire("Stop", {
        cwd: cwdState.get(),
        stop_hook_active: stopHookIterations > 0,
      });
      if (outcome.block && stopHookIterations < 5) {
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
      await hooks.fire("PreCompact", { reason: event.reason, cwd: cwdState.get() });
    } catch {
      /* floor */
    }
    return undefined; // let Pi's compaction run; preservation happens via system prompt + below
  });

  pi.on("session_compact", async () => {
    try {
      await hooks.fire("PostCompact", { cwd: cwdState.get() });
      // Re-inject active skill bodies + instruction set for mid-turn continuity (plan §9).
      if (state.activeSkills.size) {
        const preserved = [...state.activeSkills.entries()]
          .map(([name, body]) => `### Active skill: ${name}\n${body}`)
          .join("\n\n");
        pi.sendMessage(
          {
            customType: "piclaudex-preserved",
            content: `Context preserved across compaction (PiClauDex):\n\n${preserved}`,
            display: false,
          },
          { deliverAs: "nextTurn" },
        );
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
  // Commands: /doctor, /compat, /quota + user-invocable skills
  // ---------------------------------------------------------------------------
  pi.registerCommand("doctor", {
    description: "PiClauDex: full compatibility breakdown for this project",
    handler: async () => {
      pi.sendMessage(
        { customType: "piclaudex-doctor", content: renderDoctorReport(project, compat), display: true },
        { deliverAs: "nextTurn" },
      );
    },
  });

  pi.registerCommand("compat", {
    description: "PiClauDex: show or suppress the compatibility notice (usage: /compat [suppress|show])",
    handler: async (args: string, ctx: any) => {
      const arg = (args ?? "").trim();
      if (arg === "suppress") {
        writeSuppression(project.root, true);
        compatSuppressed = true;
        if (ctx.hasUI) ctx.ui.notify("Compatibility notice suppressed for this project", "info");
        return;
      }
      if (arg === "show") {
        writeSuppression(project.root, false);
        compatSuppressed = false;
      }
      const notice = renderStartupNotice(compat, { suppressed: false }) ?? "No compatibility findings for this project.";
      pi.sendMessage(
        { customType: "piclaudex-compat", content: notice, display: true },
        { deliverAs: "nextTurn" },
      );
    },
  });

  pi.registerCommand("quota", {
    description: "PiClauDex: subscription/rate-limit info from the last provider response",
    handler: async (_args: string, ctx: any) => {
      const usage = ctx.getContextUsage?.();
      const lines = [
        `Model: ${currentModelRef || "(not selected yet)"}`,
        usage ? `Context: ~${usage.tokens} tokens used` : undefined,
        Object.keys(quotaHeaders).length
          ? `Provider quota headers:\n${Object.entries(quotaHeaders)
              .map(([k, v]) => `  ${k}: ${v}`)
              .join("\n")}`
          : "No quota headers observed yet (best-effort feature — send a prompt first).",
      ].filter(Boolean);
      pi.sendMessage(
        { customType: "piclaudex-quota", content: lines.join("\n"), display: true },
        { deliverAs: "nextTurn" },
      );
    },
  });

  debug(
    `loaded project root=${project.root} skills=${project.skills.length} agents=${project.agents.length} rules=${project.rules.length}`,
  );

  // NOTE: user-invocable skills are intentionally NOT registered as extension
  // commands. Pi intercepts extension commands *before* the `input` event and
  // requires them to drive their own turn via sendUserMessage — which is
  // fire-and-forget and does not reliably trigger a turn in print mode. Instead
  // we expand `/skill args` in the `input` handler above (transform → the skill
  // body becomes the user turn), which is exactly Claude Code's slash-command
  // semantics and works in interactive, print, and RPC modes.
  //
  // We still register autocomplete-only descriptors so `/name` shows up in
  // completion and `/help`, deferring the actual expansion to the input handler.
  for (const skill of project.skills) {
    if (!skill.userInvocable) continue;
    // Skip names that collide with our own or Pi's built-in commands.
    if (["doctor", "compat", "quota"].includes(skill.name)) continue;
  }
}

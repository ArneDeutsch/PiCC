import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HookOutcome, HookPayload, ToolCallDescriptor } from "./types.js";
import { findByName, loadClaudeProject, type LoadedProject } from "./project.js";
import { loadPiCCConfig, mapEffort, steeringForModel } from "./runtime/steering.js";
import { CwdState } from "./runtime/cwd-state.js";
import { HookRunner, mergeHookOutcomes } from "./engine/hook-runner.js";
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
import {
  createPanelHintEmitter,
  panelAgentCounts,
  PANEL_ENTRY_CHORD,
  SubagentPanelWidgetController,
} from "./runtime/subagent-panel-widget.js";
import { SubagentPanelFocusController } from "./runtime/subagent-panel-focus.js";
import type { PanelTaskInfo } from "./runtime/subagent-panel-model.js";
import { formatUsageCompact, sanitizeLine } from "./runtime/subagent-progress.js";
import { renderSettlementRecord } from "./runtime/subagent-render.js";
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
  newSkillActivationState,
  recordResidentSkill,
  renderSkillForActivation,
  skillActivationMessage,
  skillActivationVars,
  type SkillActivationState,
} from "./runtime/skill-activation.js";
import { createWorktreeTools } from "./runtime/tools/worktree-tools.js";
import { createWebFetchTool, createWebSearchTool } from "./runtime/tools/web-tools.js";
import { createGrepTool as createClaudeGrepTool, createGlobTool } from "./runtime/tools/search-tools.js";
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
import { wrapForSelfShell } from "./runtime/tool-shell.js";
import { withCompactSearchRendering } from "./runtime/search-tool-render.js";
import { withRoutineToolRendering } from "./runtime/routine-tool-render.js";
import { withDefaultCollapsedToolRendering } from "./runtime/default-collapsed-tool-render.js";
import { buildStockBuiltinTools, type BuiltinToolSdk } from "./runtime/builtin-tools.js";
import {
  MainSessionCheckpointGate,
  callbackCompactionAttempt,
  type CheckpointProgress,
  type MidRunCompactionController,
  type ResumeToken,
} from "./runtime/mid-run-compaction.js";
import { registerCodexAbortGuard } from "./runtime/codex-abort-guard.js";
import {
  buildCompatReport,
  renderDoctorReport,
  renderMcpStatusReport,
  type CompatReport,
} from "./registry/compat-report.js";
import { loadSkillBody, substituteToolRules, substituteVariables } from "./claude/skills.js";
import { resolveGitBashPath, shellNamespaceDiffersFromNative } from "./engine/shell-inject.js";
import { McpRuntime } from "./runtime/mcp.js";
import { buildMcpProxyTools } from "./runtime/mcp-tools.js";
import {
  capturePiccLaunchContext,
  checkForNewerPiccRelease,
  createPiccReleaseAdvisory,
  piccUpdateGuidance,
} from "./runtime/picc-update.js";
import {
  applyUnicodeSafeProcessEnv,
  clearPiStartupSuppression,
  computeSessionScratchDir,
  sanitizedExecFile,
  sanitizedSubprocessEnv,
} from "./util/env.js";
import type { ClaudeAgent, ClaudeSkill } from "./types.js";

/**
 * PiCC — the Pi extension entry.
 *
 * Loads the target project's Claude Code artifact corpus and wires it into Pi:
 * system-prompt assembly each turn (also the compaction-preservation mechanism),
 * deny/hook enforcement on tool events, the Claude tool surface (Agent, Skill,
 * worktrees, web, tasks, degrade stubs), cwd-swapping built-in tool overrides,
 * skill slash commands, and the PiCC control-command surface.
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
  /** True when any delegate has handlers for the event (guard payload-skip). */
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
    const merged = mergeHookOutcomes(outcomes);
    this.surface(eventName, merged);
    return merged;
  }

  /**
   * Completeness floor — hook failures must be VISIBLE: every runner failure path
   * degrades to a diagnostic (bash missing, timeout, invalid matcher…) and silently
   * dropping them turns the project's whole enforcement layer off with no
   * indication. Warnings/errors go to stderr once per distinct message; the rest
   * to the PICC_DEBUG channel. Ask-downgrades are reported once per session.
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
        `[picc] a hook requested permissionDecision "ask"; allowed per PiCC's default-permissive posture (deny rules still enforced)`,
      );
    }
  }
}

const CLAUDE_MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "inherit", "claude"]);

/** Diagnosability channel: PICC_DEBUG=1 traces decisions to stderr. */
function debug(...args: unknown[]): void {
  if (process.env.PICC_DEBUG) console.error("[picc]", ...args);
}

const TYPED_SLASH_NAME_RE = /^[A-Za-z0-9][\w-]*(?::[\w-]+)*$/;
const TYPED_SLASH_TOKEN_RE = /^\/([A-Za-z0-9][\w-]*(?::[\w-]+)*)(?=[ \t]|$)/;
const PROMPT_STUB_NAME_RE = /^[A-Za-z0-9][\w-]*$/;

function supportsTypedSlashName(name: string): boolean {
  return TYPED_SLASH_NAME_RE.test(name);
}

function supportsPromptStubName(name: string): boolean {
  return PROMPT_STUB_NAME_RE.test(name);
}

/**
 * Parse a `SlashCommand` string into a `(name, argsText)` pair. Single command,
 * NO stacking (unlike the user-typed transform): only the first `/name` token is
 * taken and the rest is the args string. Tolerant of a missing leading slash
 * (`deploy x` resolves like `/deploy x`). The token grammar is shared with typed
 * slash routing, including colon-qualified nested aliases. Whitespace between
 * name and args is `[ \t]`. Returns undefined for empty input or a bare `/`.
 */
function parseSlashCommand(command: string): { name: string; argsText: string } | undefined {
  const trimmed = command.trim();
  const m = TYPED_SLASH_TOKEN_RE.exec(trimmed.startsWith("/") ? trimmed : `/${trimmed}`);
  if (!m) return undefined;
  const consumed = m[0].length - (trimmed.startsWith("/") ? 0 : 1);
  const argsText = trimmed.slice(consumed).replace(/^[ \t]+/, "");
  return { name: m[1]!, argsText };
}

/**
 * TEST-ONLY injection point. The fake-Pi harness cannot reach the closure-local
 * registries/runtime, so the offline-integration test for the settlement-notice
 * delivery path needs a named seam. `onWired` is
 * invoked synchronously during construction with the real in-process registries
 * and runtime, so tests can inject an offline SDK, traverse registered tools, or
 * seed focused lifecycle state before driving the REAL `before_agent_start` drain.
 *
 * SECURITY: this seam is reachable ONLY through this in-process second argument.
 * Nothing in the project-loading path (CLAUDE.md, settings, env vars, files)
 * ever supplies it — Pi invokes the extension entry as `picc(pi)` with a single
 * argument — so a loaded project can never use it to swap runtime internals. An
 * env/settings/file-gated seam would be a project-reachable runtime-swap bypass;
 * an in-process argument is not. The same invariant binds the `sdk` field below:
 * the fake Pi SDK it carries is the subagent runtime's execution
 * substrate — strictly higher privilege than the `onWired` registries — so it is
 * read ONLY off this in-process argument and plumbed straight into the runtime's
 * `deps.sdk`; when it is absent the runtime lazy-loads the real Pi SDK. There is
 * no `process.env` / `project.settings` / file fallback anywhere on that path.
 */
export interface PiccTestSeam {
  /**
   * TEST-ONLY observational callback receiving completion of the extension's
   * detached startup activities. Invoked synchronously before activation returns;
   * production still neither awaits nor changes the activities' error handling.
   */
  onInitializationSettled?: (completion: Promise<void>) => void;
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
     * The session's SubagentRuntime: lets an offline-integration test inject a
     * fake PiSdk (`setSdkForTest`) and then drive a REAL dispatch through
     * the coordinator's registered Agent tool, so the dispatcher-owner threading
     * is exercised end to end (the owner id is minted by the runtime, never
     * supplied by the test). Reachable only via this in-process seam.
     */
    subagentRuntime: SubagentRuntime;
    /**
     * The session's status-panel widget controller: lets an offline test
     * inject the panel clock/tick (`configureForTest`) so linger expiry is
     * observable without fake timers around async dispatches.
     */
    subagentPanel: SubagentPanelWidgetController;
    /**
     * The focused-panel controller behind the entry chord: lets an offline
     * test inject its clock (`configureForTest`) so the focus-freeze and
     * stop-all confirmation windows are observable under the same clock rule.
     */
    subagentPanelFocus: SubagentPanelFocusController;
    mainCheckpointGate: MainSessionCheckpointGate;
  }) => void;
  /**
   * TEST-ONLY subagent SDK override: replaces the real Pi SDK the session's
   * SubagentRuntime would otherwise load, so an offline test can drive the REAL
   * dispatch/fork paths through a controllable outcome without an LLM/network —
   * a `context: fork` skill invoked through the Skill tool, the SlashCommand
   * tool, or the user-typed `/name` input transform. Consumed at
   * SubagentRuntime construction as `deps.sdk`; unset ⇒ the runtime lazy-loads
   * the real Pi SDK (`loadRealSdk()`). Same in-process-only reachability
   * guarantee as `onWired` above (see the SECURITY note).
   */
  sdk?: PiSdk;
  /** TEST-ONLY fault/timing seams for the MCP control-command boundary. */
  mcpControl?: {
    whenSettled?: () => Promise<void>;
    render?: typeof renderMcpStatusReport;
    writeText?: (output: string) => void | Promise<void>;
  };
  /** TEST-ONLY managed settings locations passed directly to project loading. */
  managedSettingsPaths?: string[];
  /** TEST-ONLY managed artifact directories passed directly to project loading. */
  managedArtifactDirs?: string[];
  /** TEST-ONLY bounded replacement for detached built-in SDK loading. */
  loadBuiltinSdk?: () => Promise<any>;
  /** TEST-ONLY bounded replacement for the public-registry advisory request. */
  checkPiccRelease?: typeof checkForNewerPiccRelease;
  /** TEST-ONLY in-process override for trusted-Git unavailability. */
  resolveTrustedGit?: () => Promise<string | undefined>;
}

const codexProviderRegistries = new WeakSet<object>();

type FdWriter = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: null,
  callback: (error: NodeJS.ErrnoException | null, bytesWritten: number) => void,
) => void;

export async function writeFdFully(
  fd: number,
  data: Buffer,
  write: FdWriter = fs.write.bind(fs),
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
): Promise<void> {
  let offset = 0;
  let transientAttempts = 0;
  while (offset < data.length) {
    try {
      const bytesWritten = await new Promise<number>((resolve, reject) => {
        write(fd, data, offset, data.length - offset, null, (error, written) => {
          if (error) reject(error);
          else resolve(written);
        });
      });
      if (bytesWritten <= 0) throw Object.assign(new Error("fd write made no progress"), { code: "EIO" });
      offset += bytesWritten;
      transientAttempts = 0;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (!["EAGAIN", "EWOULDBLOCK", "ENOBUFS"].includes(code) || transientAttempts >= 5) throw error;
      await wait(2 ** transientAttempts++);
    }
  }
}

export default function picc(pi: any, testSeam?: PiccTestSeam) {
  // Capture once before project loading can spawn or inspect anything. PICC_* is
  // removed inside this call; PI_SKIP_VERSION_CHECK remains only for Pi's
  // adjacent interactive startup work and is cleared at first user admission.
  const launchContext = capturePiccLaunchContext();
  let trustedGitPromise: Promise<string | undefined> | undefined;
  const resolveTrustedGit = (): Promise<string | undefined> => {
    trustedGitPromise ??= Promise.resolve()
      .then(async () => {
        if (testSeam?.resolveTrustedGit) return await testSeam.resolveTrustedGit();
        const adminModule: unknown = await import(new URL("../bin/picc-admin.mjs", import.meta.url).href);
        const capability = (adminModule as { discoverTrustedGit?: unknown }).discoverTrustedGit;
        if (typeof capability !== "function") return undefined;
        const discovered: unknown = capability();
        return typeof discovered === "string" ? discovered : undefined;
      })
      .catch(() => undefined);
    return trustedGitPromise;
  };
  const releaseAdvisory = createPiccReleaseAdvisory({
    context: launchContext,
    ...(testSeam?.checkPiccRelease ? { check: testSeam.checkPiccRelease } : {}),
  });
  let startupSuppressionCleared = false;
  const clearStartupSuppression = (): void => {
    if (startupSuppressionCleared || !launchContext.direct) return;
    startupSuppressionCleared = true;
    clearPiStartupSuppression();
  };
  // Admission cleanup cannot depend on the later optional SDK import. Register
  // it synchronously even when built-in replacement setup degrades or stalls.
  pi.on("user_bash", () => {
    clearStartupSuppression();
  });

  // UTF-8 stdio for any child process (fixes Windows cp1252 UnicodeEncodeError,
  // e.g. Python printing `→`). Set before any subprocess can be spawned.
  applyUnicodeSafeProcessEnv();

  let project: LoadedProject;
  try {
    // PICC_CLAUDE_USER_DIR overrides ~/.claude (tests, multi-profile setups).
    project = loadClaudeProject({
      cwd: process.cwd(),
      userDir: process.env.PICC_CLAUDE_USER_DIR || undefined,
      ...(testSeam?.managedSettingsPaths
        ? { managedSettingsPaths: testSeam.managedSettingsPaths }
        : {}),
      ...(testSeam?.managedArtifactDirs
        ? { managedArtifactDirs: testSeam.managedArtifactDirs }
        : {}),
    });
  } catch (err) {
    // Completeness floor: a broken project must never crash the harness.
    console.error(`PiCC failed to load project artifacts: ${(err as Error).message}`);
    return;
  }

  const config = loadPiCCConfig(project.root);
  // Config-validation findings (malformed file, out-of-range compaction knob reverted
  // to its default) surface once at startup — never silently swallowed. Same pattern as
  // the permission-engine diagnostics below.
  for (const d of config.diagnostics) {
    console.error(`PiCC config: ${d.message}`);
  }
  const sessionId = randomUUID();
  const mainCheckpointGate = new MainSessionCheckpointGate(
    `pre-session:${sessionId}`,
    config.compaction.proactiveCompactPercent,
  );
  // PiCC is the sole owner of this API handler while loaded. Supplying only these
  // fields preserves Pi's built-in models, OAuth, credentials, options, and headers;
  // arbitrary custom handlers for the same API are outside the guarded scope.
  if (!codexProviderRegistries.has(pi)) {
    codexProviderRegistries.add(pi);
    registerCodexAbortGuard(pi);
  }
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
  // ${CLAUDE_PLUGIN_DATA} expansion mirrors ${CLAUDE_PLUGIN_ROOT}.
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
  // Rule-validation findings (e.g. unanchored mcp__* allow globs) surface once
  // at startup — never silent, never fatal.
  for (const d of permissionEngine.diagnostics) {
    console.error(`PiCC permissions: ${d.message}`);
  }
  const worktrees = new WorktreeManager({
    projectRoot: project.root,
    settings: project.settings.worktree,
    cleanupPeriodDays: project.settings.cleanupPeriodDays,
    // Worktree setup/reaping can run before first input, so sanitize inherited
    // launcher context without admitting project-controlled environment policy.
    // Only the manager's expected command may cross this administration seam.
    exec: async (cmd, args, opts) => {
      const trustedGit = cmd === "git" ? await resolveTrustedGit() : undefined;
      if (!trustedGit) {
        return { stdout: "", stderr: "Trusted Git is unavailable", code: 1 };
      }
      return await sanitizedExecFile(trustedGit, args, opts);
    },
  });
  // Reap orphaned worktree dirs from crashed sessions — fire-and-forget.
  const orphanReaping = worktrees.reapOrphans().catch(() => undefined);
  void orphanReaping;
  const state = newSessionContextState(project.claudeMd);
  // Completeness floor: a report failure must never abort extension init.
  let compat: CompatReport;
  try {
    compat = buildCompatReport(project);
  } catch (err) {
    console.error(`PiCC compatibility scan failed (continuing): ${(err as Error).message}`);
    compat = { findings: [], safetyFindings: [], unassessed: [] };
  }
  // One-shot latch for the post-settle MCP connect-failure warning (see the
  // before_agent_start handler).
  let mcpFailureChecked = false;

  let currentModelRef = "";
  let currentModel: unknown; // the orchestrator's active model — inherited by subagents
  let steeringText: string | undefined;
  let stopHookIterations = 0;
  let checkpointContext: any;
  let checkpointSessionEpoch: object = {};
  let printedResumeToken: ResumeToken | undefined;
  let printWriteTail: Promise<void> = Promise.resolve();
  interface StopContinuationCapability {
    readonly epoch: object;
    readonly controller: MidRunCompactionController;
    readonly generation: number;
    readonly resumeToken: ResumeToken;
    readonly text: string;
    consumed: boolean;
  }
  const stopContinuationAdmission = new AsyncLocalStorage<StopContinuationCapability>();
  interface CompactionLifecycleOperation {
    identity: object;
    epoch: object;
    controller: MidRunCompactionController;
    generation: number;
    proactive: boolean;
    trigger: "auto" | "manual";
    recovery?: import("./runtime/mid-run-compaction.js").RecoveryToken;
  }
  let activeCompactionOperation: CompactionLifecycleOperation | undefined;
  let checkpointAttempt: {
    epoch: object;
    controller: MidRunCompactionController;
    generation: number;
    hookBlocked: boolean;
    operation?: object;
    committed: boolean;
    restorationFailed: boolean;
  } | undefined;
  let activeMainResume: {
    generation: number;
    token: ResumeToken;
    epoch: object;
    context: any;
    settled: Promise<void>;
    resolveSettled(): void;
    replayCompleted: boolean;
  } | undefined;
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
    return {
      inject: (filePath: string) => contextForTouchedFile({
        filePath,
        cwd: getCwdFn(),
        projectRoot: project.root,
        rules: project.rules,
        settings: project.settings,
        state: subState,
        skills: project.skills,
      }),
      reset: () => resetInjectionState(subState, project.claudeMd),
    };
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

  const mainActivation = newSkillActivationState(state.activeSkills);
  const activeSkillDenyRules = mainActivation.denyRules;

  async function activateSkill(
    skill: ClaudeSkill,
    argsText: string,
    opts: { fork?: boolean; activation?: SkillActivationState; cwd?: string } = {},
  ): Promise<string> {
    const activation = opts.activation ?? mainActivation;
    if (skill.hooks && Object.keys(skill.hooks).length && !activation.scopedHookSkills.has(skill.name)) {
      activation.scopedHookSkills.add(skill.name);
      const parsed = parseHookConfig(skill.hooks, skill.source.path);
      const runner = new HookRunner({
        config: parsed.config,
        projectDir: project.root,
        sessionId,
        env: project.settings.env,
        disableAllHooks: project.settings.disableAllHooks,
        pluginRoots: project.pluginRoots,
        pluginDataDirs,
        transcriptPath,
      });
      if (activation === mainActivation) hooks.addScoped(runner);
      else activation.hookRunners.push(activation.wrapHookRunner?.(runner) ?? runner);
    }
    const plugin = pluginContextFor(skill);
    const rendered = await renderSkillForActivation({
      skill,
      argsText,
      projectRoot: project.root,
      cwd: opts.cwd ?? cwdState.get(),
      sessionId,
      effort: skill.effort ?? config.effort,
      settings: project.settings,
      pluginRoot: plugin.root,
      pluginData: plugin.data,
    });
    // context:fork bodies go to the fork only. Keeping them resident in the
    // parent would defeat the fork's token-efficiency purpose.
    if (!opts.fork) {
      recordResidentSkill(activation.activeSkills, skill.name, rendered.text);
      activation.denyRules.set(
        skill.name,
        [...(rendered.disallowedTools ?? skill.disallowedTools ?? [])],
      );
    }
    return rendered.text;
  }

  /**
   * FNV-1a 32-bit plus length is dependency-free and sufficient for detecting
   * byte-identical re-invocations without retaining another full skill body.
   */
  function skillRenderFingerprint(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${text.length}:${(h >>> 0).toString(16)}`;
  }
  /** Returns the dedup note when `rendered` is byte-identical to the last copy, else records it. */
  function skillDedupNote(
    skill: ClaudeSkill,
    rendered: string,
    activation: SkillActivationState = mainActivation,
  ): string | undefined {
    const fp = skillRenderFingerprint(rendered);
    if (activation.lastRenderHash.get(skill.name) === fp) {
      return `Skill "${skill.name}" was invoked again; its content is unchanged from the earlier copy above.`;
    }
    activation.lastRenderHash.set(skill.name, fp);
    return undefined;
  }

  /**
   * Dispatches a context:fork skill. A fork without `agent:` runs in a synthetic
   * general-purpose context — fresh CLAUDE.md/rules hierarchy, the skill's own
   * tool gating (with ${CLAUDE_*}/$ARGUMENTS substituted per activation), no
   * agent persona (and no dependency on whatever agent happens to sort first, or
   * on any agent existing at all).
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
    // Threads Pi's Esc AbortSignal into the dispatch. dispatch always
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
  // Background tasks: one registry per session — run_in_background dispatches
  // register here; TaskOutput/TaskStop operate on it.
  const backgroundTasks = new BackgroundTaskRegistry();
  // Dispatch registry: one per session — every session-creating dispatch
  // registers here so SendMessage can steer a running background subagent or
  // resume a finished one. Registry-only resolution keeps a hostile `to` off the
  // filesystem (SECURITY).
  const subagentRegistry = new SubagentRegistry();
  // Status panel: a passive belowEditor widget over the dispatch registry.
  // Constructed unconditionally (cheap, no timer until installed) so the
  // onWired test seam can reach it; it attaches to a UI only from the
  // session_start handler's `ctx.mode === "tui"` gate.
  const panelTaskJoin = (): PanelTaskInfo[] => {
    const tasks: PanelTaskInfo[] = [];
    for (const id of backgroundTasks.ids()) {
      const record = backgroundTasks.get(id);
      if (record) tasks.push(record);
    }
    return tasks;
  };
  const subagentPanel = new SubagentPanelWidgetController({
    registry: subagentRegistry,
    tasks: panelTaskJoin,
    onTasksChange: (listener) => backgroundTasks.onChange(listener),
    // Lazy closure over the focus controller declared just below: the widget
    // reads dismissals only at view time (session_start and later), never
    // during construction.
    dismissed: () => subagentPanelFocus.dismissedKeys(),
  });
  // Focused panel (the entry chord's ctx.ui.custom component): selection,
  // stop/dismiss/stop-all. Suppresses the passive widget while open.
  const subagentPanelFocus = new SubagentPanelFocusController({
    registry: subagentRegistry,
    tasks: panelTaskJoin,
    onTasksChange: (listener) => backgroundTasks.onChange(listener),
    stopTask: (taskId) => {
      backgroundTasks.markUserStopped(taskId);
    },
    widget: subagentPanel,
  });
  // The chord only works in interactive mode (Pi dispatches extension
  // shortcuts from the TUI editor); open() re-checks the ctx mode itself.
  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut(PANEL_ENTRY_CHORD, {
      description: "Open the subagent status panel",
      handler: (ctx: any) => subagentPanelFocus.open(ctx),
    });
  }
  // One-time status-line hint (ui.notify) advertising the chord, emitted only
  // once >1 agent is admitted or waiting in a TUI session (the ui handle is
  // captured at session_start).
  let panelHintUi: any;
  const emitPanelHint = createPanelHintEmitter({
    chord: PANEL_ENTRY_CHORD,
    isTui: () => panelHintUi !== undefined,
    emit: (text) => panelHintUi?.notify?.(text, "info"),
  });
  const refreshPanelHint = (): void => {
    emitPanelHint(panelAgentCounts(subagentRegistry.list(), panelTaskJoin()));
  };
  subagentRegistry.onChange(refreshPanelHint);
  backgroundTasks.onChange(refreshPanelHint);
  // Built-in agent types: general-purpose/Explore/Plan, appended AFTER
  // project/user/plugin agents so a same-named project agent wins (an
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
    captureUniversalStop?: () => () => boolean,
  ): Record<string, unknown>[] {
    const get = () => cwdRef.get();
    return [
      createWebFetchTool(get) as unknown as Record<string, unknown>,
      createWebSearchTool(get) as unknown as Record<string, unknown>,
      createClaudeGrepTool(get) as unknown as Record<string, unknown>,
      createGlobTool(get) as unknown as Record<string, unknown>,
      createMultiEditTool(get) as unknown as Record<string, unknown>,
      ...(taskBundle.tools as unknown as Record<string, unknown>[]),
      ...createWorktreeTools({ worktrees, cwdState: cwdRef, hookRunner: hookRunnerFacade, captureUniversalStop }),
      ...DEGRADED_TOOLS.map(
        (d) =>
          createDegradeStub(d.name, d.note, { redirect: d.redirect }) as unknown as Record<
            string,
            unknown
          >,
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
        // Visible degrade: a misspelled/shadowed skills: entry must not vanish.
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
    // `memory:` frontmatter scope loads the agent's MEMORY.md and points the
    // agent at its durable-knowledge directory.
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
        // Visible degrade: an unknown memory scope must not vanish silently.
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
    // Steering is per-model: an agent with its own model: gets that model's guidance.
    const agentModel = agent.model ? (resolveModelSpec(agent.model) as { provider?: string; id?: string } | undefined) : undefined;
    const agentModelRef =
      agentModel?.provider && agentModel?.id ? `${agentModel.provider}/${agentModel.id}` : currentModelRef;
    // Explore/Plan context trimming: agents marked skipProjectContext omit the
    // CLAUDE.md/project-instructions and rules sections (harness conventions,
    // skill listing, and steering stay).
    const skipProject = agent.skipProjectContext === true;
    const suffix = buildSystemPromptSuffix({
      claudeMd: skipProject ? [] : project.claudeMd,
      rules: skipProject ? [] : project.rules,
      // Auto memory reaches subagents too — except Explore/Plan, whose
      // skipProjectContext trims all project-level context.
      autoMemory: skipProject ? undefined : project.autoMemory,
      skills: project.skills,
      agents: nestedDispatchAvailable ? agentsWithBuiltins() : [],
      settings: project.settings,
      state: newSessionContextState(skipProject ? [] : project.claudeMd),
      steeringText: agentModelRef ? steeringForModel(config, agentModelRef) : steeringText,
      // Subagents receive the same scratchpad guidance as the main session — a
      // subagent that writes a temp file via the Bash tool and then Reads it (or
      // hands it to a nested agent) hits the identical shell↔native namespace
      // trap. Reuse the one eager `scratchDir` literal +
      // predicate (harness data, safe to inject into every agent — not an
      // exfiltration-sensitive value). Reachable here because this closure runs
      // at dispatch time, after activation initialized `scratchDir`.
      scratchDir,
      windowsTempNote: shellNamespaceDiffersFromNative(),
    });
    sections.push(suffix);
    return sections.join("\n\n");
  }

  // MCP stdio runtime: session-global, started non-blocking at load (zero
  // enabled servers ⇒ nothing spawned, immediate settle). Declared above
  // allKnownToolNames so dispatch-time closures over MCP state can never hit a
  // TDZ. Model-facing registration happens in the detached mcpRegistration
  // step below; shutdown joins session_shutdown.
  const mcpRuntime = McpRuntime.start(project.mcp, {
    projectRoot: project.root,
    sessionId,
    env: process.env,
    settingsEnv: project.settings.env,
  });

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
      // Live MCP wire names (`mcp__<server>__<tool>`): gateTools already speaks
      // the MCP grammar (bare `mcp__server` fan-out, bare-name deny removal), so
      // appending the connected servers' names is all that agent
      // `tools:`/`disallowedTools:` gating needs to cover MCP. Possibly
      // incomplete (initially empty) before the runtime settles — servers
      // settle individually; dispatches happen inside turns, after the first-turn
      // barrier below, so they always see the settled set. An over-long name
      // (>64 chars) stays in this universe but has no proxy instance (the
      // builder drops it from the wire), so granting it is inert.
      ...mcpRuntime.tools().map((t) => `mcp__${t.serverName}__${t.toolName}`),
    ];
  }

  // Git-Bash pin for the subagent built-in bash tool (Windows), resolved once and
  // threaded through the deps into the shared factory — same source the main
  // session uses (resolveGitBashPath is cached).
  const subagentBashShellPath = resolveGitBashPath();
  const subagentRuntime = new SubagentRuntime({
    getAgents: () => project.agents,
    buildSystemPrompt: buildSubagentSystemPrompt,
    customToolsFor: (agent, granted, depth, ownerAgentId, dispatcherIsFork, subCwd, activation, captureUniversalStop) => {
      // Per-dispatch instances (fresh TaskStore, dispatch-local cwd binding).
      // NOTE: SendMessage is deliberately NEVER built here — it is
      // parent-initiated only (no subagent→subagent or subagent→parent channel).
      // Even a future "inherit all tools" change must not add it to this set.
      const tools: Record<string, unknown>[] = [];
      for (const tool of buildCwdBoundTools(subCwd ?? cwdState, createTaskTools(), captureUniversalStop)) {
        const name = (tool as { name: string }).name;
        if (granted.includes(name)) tools.push(tool);
      }
      // Fresh per-dispatch MCP proxy instances over the SESSION-GLOBAL runtime:
      // the ToolDefinitions are dispatch-local (never shared across sessions)
      // while the stdio client connections stay session-global — the intended
      // split (cf. buildCwdBoundTools above; proxies hold no cwd/TaskStore
      // state, so freshness here is about never sharing tool OBJECTS). The same
      // granted-name filter as the cwd-bound tools applies: `granted` already
      // went through gateTools over the MCP-extended universe, so `tools:`
      // restriction (incl. bare `mcp__server` fan-out), `disallowedTools:`, and
      // bare-name deny removal have all been decided by the time we get here.
      for (const proxy of buildMcpProxyTools(mcpRuntime)) {
        if (granted.includes(proxy.name)) tools.push(proxy as unknown as Record<string, unknown>);
      }
      if (granted.includes("Skill")) {
        // Per-dispatch Skill tool: carries the caller's depth into context:fork
        // dispatches (depth cap holds) and never mutates the parent session state.
        tools.push(createSkillTool({
          depth,
          forSubagent: true,
          activation,
          getCwd: () => (subCwd ?? cwdState).get(),
        }) as Record<string, unknown>);
      }
      if (granted.includes("SlashCommand")) {
        // Per-dispatch SlashCommand tool: a thin alias over the same shared
        // skill-activation path as the Skill tool — carries the caller's depth
        // into context:fork dispatches and leaves parent session state alone.
        tools.push(createSlashCommandTool({
          depth,
          forSubagent: true,
          activation,
          getCwd: () => (subCwd ?? cwdState).get(),
        }) as Record<string, unknown>);
      }
      // Background-task tools are SCOPED to this dispatcher's own tasks: built
      // over `backgroundTasks.scopedTo(ownerAgentId)`, so a subagent's
      // TaskOutput/TaskStop reach only the tasks it itself dispatched — a sibling's
      // or the coordinator's task is indistinguishable from an unknown id. The
      // coordinator keeps the full registry (below), retaining reach to every task.
      const scoped = scopedBackgroundTools(backgroundTasks, ownerAgentId, subagentRegistry);
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
        // (above) — and nobody else's — can reach them. `dispatcherIsFork` marks
        // these tools when the dispatcher is a genuine fork, so a nested
        // `subagent_type: "fork"` is refused (a fork can't spawn a fork).
        // `dispatchCwd` carries the dispatching subagent's OWN live cwd (its
        // `subCwd` — the worktree it may have entered) so a nested child begins
        // where its parent is working, not at the orchestrator's cwd. Read at the
        // moment the child is dispatched, so a worktree the parent enters mid-run
        // is reflected.
        const dispatchCwd = () => (subCwd ?? cwdState).get();
        tools.push(createAgentToolDefinition(subagentRuntime, { depth, name: "Agent", backgroundTasks, ownerAgentId, dispatcherIsFork, dispatchCwd, captureUniversalStop }));
        tools.push(createAgentToolDefinition(subagentRuntime, { depth, name: "Task", backgroundTasks, ownerAgentId, dispatcherIsFork, dispatchCwd, captureUniversalStop }));
      }
      return tools;
    },
    allKnownToolNames,
    permissionEngine,
    hookRunner: hookRunnerFacade,
    getCwd: () => cwdState.get(),
    // Shared built-in factory inputs: the subagent path builds its seven
    // built-ins from the SAME factory the main session uses, so a subagent's bash
    // subprocess gets `settings.env` + `CLAUDE_PROJECT_DIR` and the Windows Git-Bash
    // pin, identical to the main session. Keep these three values in lockstep with
    // the main-session factory call below (`buildStockBuiltinTools(...)`): the factory
    // single-owns tool *logic*, but its *inputs* are wired at both sites, so a new
    // dep must be added to both or the two paths silently diverge on that input.
    settingsEnv: project.settings.env ?? {},
    projectRoot: project.root,
    ...(subagentBashShellPath ? { shellPath: subagentBashShellPath } : {}),
    // Same oversized-tool-result backstop the main guard runs, threaded into every
    // subagent's guard (config is not in scope at the subagent install site).
    clipMaxTokens: config.compaction.clipMaxTokens,
    proactiveCompactPercent: config.compaction.proactiveCompactPercent,
    makeContextInjector,
    // Agent-scoped hooks: per-dispatch runner with the SAME deps as the
    // session's base runner; the runtime multiplexes and discards it. Its
    // transcript_path stays the MAIN session transcript — Claude Code does not
    // re-point subagent hook events at the subagent's own transcript.
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
    // Subagent transcripts persist next to the MAIN session's transcript.
    getMainSessionFile: transcriptPath,
    resolveModel: resolveModelSpec,
    mapEffort: (effort) => mapEffort(config, effort),
    worktrees,
    maxDepth: project.settings.subagentMaxDepth,
    concurrency: project.settings.subagentConcurrency,
    sessionId,
    subagentRegistry,
    // TEST-ONLY seam: an injected fake SDK reaches every dispatch — including
    // forks, which close over this one runtime instance. Read ONLY
    // from the in-process testSeam argument; unset ⇒ the runtime lazy-loads the
    // real Pi SDK (loadRealSdk). Never sourced from env/settings/files.
    ...(testSeam?.sdk ? { sdk: testSeam.sdk } : {}),
  });

  const checkpointText = (event: CheckpointProgress): string => {
    switch (event.category) {
      case "checkpoint-armed": return "Pausing for proactive context compaction.";
      case "checkpoint-complete": return event.action === "settled-fallback"
        ? "Context compaction completed."
        : "Context compacted; reconnecting the paused work.";
      case "checkpoint-exhausted": return event.failureCategory === "hook-blocked"
        ? "Automatic context compaction was blocked by a PreCompact hook. Work is paused and no continuation ran. Repair or disable the hook, or allow a manual compact trigger; then run /compact and explicitly continue."
        : event.failureCategory === "restoration-paused"
          ? "Context was compacted, but mandatory restoration or continuation failed. Work is paused and no continuation ran. Do not compact the committed summary again; start a new session and resend the retained input."
          : "Automatic context compaction could not complete. Work is paused and no continuation ran. Run /compact, then explicitly continue.";
      case "checkpoint-cancelled": return event.action === "new-session"
        ? "Proactive context compaction stopped with the old session; resend input in the new session."
        : "Proactive context compaction was cancelled. Run /compact to recover this session, or start a new session.";
      case "checkpoint-recovered": return "Manual compaction recovered the paused session; explicitly continue when ready.";
    }
  };

  const appendCheckpointEntry = (data: Record<string, unknown>): void => {
    try { pi.appendEntry("picc-checkpoint-lifecycle", data); } catch { /* presentation only */ }
  };

  const reportRejectedShadows = (rejected: readonly import("./runtime/mid-run-compaction.js").QueuedInputShadow[], ctx: any): void => {
    if (rejected.length === 0) return;
    const representable: string[] = [];
    let unrepresentable = 0;
    for (const shadow of rejected) {
      if (typeof shadow.content === "string") {
        representable.push(shadow.content);
        continue;
      }
      const text = shadow.content
        .filter((part) => part && typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string")
        .map((part) => (part as { text: string }).text)
        .join("");
      if (text) representable.push(text);
      if (shadow.content.some((part) => !part || typeof part !== "object" ||
          (part as { type?: unknown }).type !== "text")) unrepresentable += 1;
    }
    let restoredTextCount = 0;
    let guidance = `${rejected.length} queued input${rejected.length === 1 ? " was" : "s were"} not replayed. Resend ${representable.length} text input${representable.length === 1 ? "" : "s"}${unrepresentable ? ` and ${unrepresentable} image/unrepresentable input${unrepresentable === 1 ? "" : "s"}` : ""}.`;
    if (ctx?.mode === "tui") {
      try {
        if (representable.length && typeof ctx.ui?.setEditorText === "function") {
          const draft = String(ctx.ui?.getEditorText?.() ?? "");
          ctx.ui.setEditorText(`${representable.join("\n")}\n${draft}`);
          restoredTextCount = representable.length;
        }
        guidance = `${rejected.length} queued input${rejected.length === 1 ? " was" : "s were"} not replayed; ${restoredTextCount} text input${restoredTextCount === 1 ? " was" : "s were"} restored${representable.length > restoredTextCount || unrepresentable ? "; remaining input must be resent" : ""}.`;
        ctx.ui?.notify?.(guidance, representable.length > restoredTextCount || unrepresentable ? "warning" : "info");
      } catch {
        restoredTextCount = 0;
        guidance = `${rejected.length} queued input${rejected.length === 1 ? " was" : "s were"} not replayed. Resend ${representable.length} text input${representable.length === 1 ? "" : "s"}${unrepresentable ? ` and ${unrepresentable} image/unrepresentable input${unrepresentable === 1 ? "" : "s"}` : ""}.`;
      }
    } else if (ctx?.mode === "print") {
      console.error(`PiCC: ${guidance}`);
    }
    appendCheckpointEntry({
      category: "checkpoint-input-recovery",
      count: rejected.length,
      restoredTextCount,
      unrepresentableCount: unrepresentable,
      action: representable.length > restoredTextCount || unrepresentable ? "resend-input" : "review-restored-text",
      notice: guidance,
    });
  };

  const publishCheckpoint = (event: CheckpointProgress, ctx = checkpointContext): void => {
    const progressController = mainCheckpointGate.currentController();
    if (mainCheckpointGate.isLogicalRunStopped() &&
        mainCheckpointGate.stoppedRunMatches(progressController, event.generation)) return;
    const mode = ctx?.mode;
    const baseText = checkpointText(event);
    const recoverableHeadlessExhaustion = event.category === "checkpoint-exhausted" &&
      event.failureCategory !== "restoration-paused" && mode !== "tui";
    const persisted = transcriptPath() !== undefined;
    const headlessCause = event.failureCategory === "hook-blocked"
      ? "Automatic context compaction was blocked by a PreCompact hook. Work is paused and no continuation ran. Repair or disable the hook, or allow a manual compact trigger first."
      : "Automatic context compaction could not complete. Work is paused and no continuation ran.";
    const recoveryGuidance = persisted
      ? `If this process exits, reopen the exact persisted session before /compact.${mode === "rpc" ? " RPC acknowledgements are uncorrelated." : ""} Run /compact, then explicitly continue.`
      : "This headless session is ephemeral and cannot be reopened; start a replacement session and resend the retained input.";
    const text = recoverableHeadlessExhaustion ? `${headlessCause} ${recoveryGuidance}` : baseText;
    if (mode === "tui") {
      try {
        ctx.ui?.setStatus?.("picc-checkpoint", event.category === "checkpoint-recovered" ? undefined : text);
        if (event.category === "checkpoint-exhausted") ctx.ui?.notify?.(text, "error");
        if (event.category === "checkpoint-recovered") ctx.ui?.notify?.(text, "info");
      } catch {
        // Presentation cannot own checkpoint state.
      }
    } else if (mode === "print") {
      console.error(`PiCC: ${text}`);
    }
    if (mode === "json" || mode === "rpc" || event.category === "checkpoint-exhausted") {
      appendCheckpointEntry({
        category: event.category,
        generation: event.generation,
        notice: text,
        ...(event.action === undefined ? {} : { action: event.action }),
        ...(event.failureCategory === undefined ? {} : { failureCategory: event.failureCategory }),
        ...(event.category === "checkpoint-exhausted" ? {
          recovery: event.failureCategory === "restoration-paused"
            ? "start a new session and resend retained input; do not compact the committed summary again"
            : !persisted
              ? "start a replacement session and resend retained input; this ephemeral session cannot be reopened"
              : event.failureCategory === "hook-blocked"
                ? "repair or disable the hook, or allow manual compaction; then run /compact and explicitly continue"
                : "/compact, then explicitly continue",
        } : {}),
      });
    }
    if (event.category === "checkpoint-cancelled") {
      const controller = mainCheckpointGate.currentController();
      void controller.cancel(event.generation, event.action === "new-session" ? "replacement" : "user")
        .then((outcome) => reportRejectedShadows(outcome.rejected, ctx))
        .catch(() => undefined);
    }
  };

  mainCheckpointGate.attachExecution({
    progress: publishCheckpoint,
    compact: async (signal) => {
      const ctx = checkpointContext;
      const epoch = checkpointSessionEpoch;
      const controller = mainCheckpointGate.currentController();
      const generation = controller.snapshot().generation;
      const summary = controller.beginCompactionSummary(generation);
      if (!summary || typeof ctx?.compact !== "function") {
        return { ok: false, category: "operational" };
      }
      const attempt = {
        epoch,
        controller,
        generation,
        hookBlocked: false,
        operation: undefined as object | undefined,
        committed: false,
        restorationFailed: false,
      };
      checkpointAttempt = attempt;
      const abortHost = () => {
        try { ctx.abort?.(); } catch { /* controller cancellation remains authoritative */ }
      };
      signal.addEventListener("abort", abortHost, { once: true });
      try {
        return await callbackCompactionAttempt(generation, (_token, complete) => {
          ctx.compact({
            onComplete: () => {
              const stale = epoch !== checkpointSessionEpoch || controller !== mainCheckpointGate.currentController();
              complete(_token, attempt.committed && (attempt.restorationFailed || stale || signal.aborted)
                ? { ok: false, category: "restoration-paused" }
                : attempt.restorationFailed
                  ? { ok: false, category: "restoration-paused" }
                  : stale
                    ? { ok: false, category: "stale-generation" }
                    : { ok: true });
            },
            onError: (error: unknown) => {
              let hostCancelled = false;
              try {
                hostCancelled = error instanceof Error &&
                  (error.name === "AbortError" || error.message === "Compaction cancelled");
              } catch { /* hostile error objects classify as operational */ }
              // A failed transaction has no session_compact event to release its
              // lifecycle identity. Release only this operation's identity.
              if (activeCompactionOperation?.identity === attempt.operation) {
                activeCompactionOperation = undefined;
              }
              complete(_token, {
                ok: false,
                category: attempt.committed
                  ? "restoration-paused"
                  : checkpointAttempt === attempt && attempt.hookBlocked
                    ? "hook-blocked"
                    : signal.aborted || epoch !== checkpointSessionEpoch || hostCancelled
                      ? "cancelled"
                      : "operational",
              });
            },
          });
        }, signal);
      } finally {
        signal.removeEventListener("abort", abortHost);
        controller.endCompactionSummary(summary);
        if (checkpointAttempt === attempt) checkpointAttempt = undefined;
      }
    },
    resume: (resumeContext) => {
      const ctx = checkpointContext;
      let openProvider!: () => void;
      let rejectProvider!: (reason?: unknown) => void;
      // The hidden continuation starts the run, but queued steering must be
      // installed before its first ordinary provider request or it lands one turn late.
      const providerBarrier = new Promise<void>((resolve, reject) => {
        openProvider = resolve;
        rejectProvider = reject;
      });
      void providerBarrier.catch(() => undefined);
      if (!mainCheckpointGate.installResumeBarrier(resumeContext.generation, providerBarrier)) {
        throw new Error("Cannot install the resumed provider barrier");
      }
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
      activeMainResume = {
        generation: resumeContext.generation,
        token: resumeContext.token,
        epoch: checkpointSessionEpoch,
        context: ctx,
        settled,
        resolveSettled,
        replayCompleted: false,
      };
      const resume = activeMainResume;
      const isCurrent = () => {
        const controller = mainCheckpointGate.currentController();
        const snapshot = controller.snapshot();
        return activeMainResume === resume && resume.epoch === checkpointSessionEpoch &&
          resume.generation === snapshot.generation && resume.token === resumeContext.token &&
          snapshot.phase === "resuming" && !resumeContext.signal.aborted;
      };
      try {
        if (!isCurrent()) throw new Error("checkpoint resume lost authority before startup");
        pi.sendMessage(
          {
            customType: "picc-checkpoint-continuation",
            content: "Continue the paused work.",
            display: false,
          },
          { triggerTurn: true },
        );
      } catch (error) {
        if (activeMainResume === resume) activeMainResume = undefined;
        mainCheckpointGate.clearResumeBarrier(resumeContext.generation, providerBarrier);
        rejectProvider(error);
        resolveSettled();
        throw error;
      }
      return {
        replay: (input: any) => {
          mainCheckpointGate.withReplayAuthorization(input, () => {
            pi.sendUserMessage(input.content as any, { deliverAs: input.delivery });
          });
          return { delivered: true } as const;
        },
        replayComplete: () => {
          if (!isCurrent() || resume.replayCompleted) {
            throw new Error("checkpoint resume cannot release the provider twice");
          }
          resume.replayCompleted = true;
          openProvider();
          const text = "Context compacted; resumed the paused work.";
          if (ctx?.mode === "tui") ctx.ui?.setStatus?.("picc-checkpoint", text);
          else if (ctx?.mode === "print") console.error(`PiCC: ${text}`);
          else if (ctx?.mode === "json" || ctx?.mode === "rpc") {
            appendCheckpointEntry({
              category: "checkpoint-resumed",
              generation: resumeContext.generation,
              notice: text,
            });
          }
        },
        cancelAndJoin: async () => {
          rejectProvider(new Error("checkpoint cancelled"));
          mainCheckpointGate.clearResumeBarrier(resumeContext.generation, providerBarrier);
          try { ctx?.abort?.(); } catch { /* join below remains authoritative */ }
          await settled;
          if (activeMainResume === resume) activeMainResume = undefined;
        },
      };
    },
  });

  // TEST-ONLY seam: hand the real in-process registries AND the runtime to a
  // test that drives the settlement-notice delivery path (or the dispatcher-owner
  // threading) through an offline dispatch (fake SDK injected via
  // subagentRuntime.setSdkForTest). See PiccTestSeam — reachable only via this
  // in-process argument, never via project/env/settings/files. Invoked after the
  // runtime is built so the test can inject its fake SDK before the first dispatch.
  try {
    testSeam?.onWired?.({
      backgroundTasks,
      subagentRegistry,
      subagentRuntime,
      subagentPanel,
      subagentPanelFocus,
      mainCheckpointGate,
    });
  } catch (err) {
    console.error(`PiCC test seam onWired failed: ${(err as Error).message}`);
  }

  // ---------------------------------------------------------------------------
  // Tool registration
  // ---------------------------------------------------------------------------
  const getCwd = () => cwdState.get();
  claudeNamedTools.push(...buildCwdBoundTools(cwdState, taskToolBundle, () => mainCheckpointGate.captureLogicalRunStop()));

  /**
   * The single skill-activation path shared by the Skill and SlashCommand tools
   * (and mirroring the user-typed `/name` transform): given a RESOLVED skill and
   * its args, honor `disable-model-invocation` refusal, `context: fork` dispatch,
   * and byte-identical re-invocation dedup. Returns the tool result or throws a
   * model-visible error. `invokedName` is the CALLER-supplied name (which for a
   * bare name resolving to a plugin-namespaced skill differs from `skill.name`);
   * ordinary non-reserved refusal wording is built from it so each tool's wording
   * is preserved. Reserved collisions instead name the normalized built-in owner
   * and deliberately do not reflect the caller's spelling. `signal` is Pi's
   * per-call Esc signal: threaded into the fork dispatch so
   * an Esc'd model-invoked fork (Skill OR SlashCommand tool) reports as aborted.
   */
  async function runSkillActivation(
    skill: ClaudeSkill,
    argsText: string,
    opts: {
      forSubagent: boolean;
      depth: number;
      invokedName: string;
      signal?: AbortSignal;
      activation?: SkillActivationState;
      cwd?: string;
    },
  ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
    if (skill.disableModelInvocation) {
      const reserved = reservedBuiltinName(skill.name);
      if (reserved) {
        throw new Error(
          `Direct Skill invocation is disabled. Built-in /${reserved} owns this reserved name, and no slash fallback can activate the skill.`,
        );
      }
      throw new Error(`Skill "${opts.invokedName}" is user-only (disable-model-invocation). Ask the user to run /${opts.invokedName}.`);
    }
    if (skill.contextFork) {
      const rendered = await activateSkill(skill, argsText, {
        fork: true,
        activation: opts.activation,
        cwd: opts.cwd,
      });
      const result = await forkDispatch(skill, rendered, opts.depth + 1, argsText, opts.signal);
      // Forks are non-resumable: suppress every resume trailer. The shared
      // presenter reproduces the Agent tool's four-branch mapping —
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
      activation: opts.activation,
      cwd: opts.cwd,
    });
    const note = skillDedupNote(skill, rendered, opts.activation);
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
  function createSkillTool(opts: {
    depth: number;
    forSubagent: boolean;
    activation?: SkillActivationState;
    getCwd?: () => string;
  }) {
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
          activation: opts.activation,
          cwd: opts.getCwd?.(),
        });
      },
    };
  }
  const skillTool = createSkillTool({ depth: 0, forSubagent: false });
  claudeNamedTools.push(skillTool as Record<string, unknown>);

  /**
   * The SlashCommand tool, per session scope: Claude's mechanism for a MODEL to
   * run a custom `/name args` command mid-conversation. For non-reserved names,
   * it is a thin alias over the shared skill-activation path. Reserved built-in
   * names are rejected before lookup and cannot activate colliding skills.
   */
  function createSlashCommandTool(opts: {
    depth: number;
    forSubagent: boolean;
    activation?: SkillActivationState;
    getCwd?: () => string;
  }) {
    return {
      name: "SlashCommand",
      label: "SlashCommand",
      description:
        'Run a slash command like "/name args". For non-reserved skill names, this is equivalent to the Skill tool and passes trailing text as arguments (plugin-namespaced "/plugin:name" also works). Reserved built-in names cannot activate skills through SlashCommand.',
      parameters: Type.Object({
        command: Type.String({ description: 'A slash command such as "/deploy staging 1.2.3"' }),
      }),
      async execute(_id: string, params: { command: string }, signal?: AbortSignal) {
        const parsed = parseSlashCommand(params.command);
        if (!parsed) throw new Error(`SlashCommand requires a command like "/name args".`);
        const reserved = reservedBuiltinName(parsed.name);
        if (reserved) {
          throw new Error(`Slash command /${reserved} is reserved by a built-in and cannot activate a skill.`);
        }
        // findByName resolves plugin-namespaced skills by bare name when unique.
        const skill = findByName(project.skills, parsed.name);
        if (!skill) throw new Error(`Unknown slash command: /${parsed.name}`);
        return runSkillActivation(skill, parsed.argsText, {
          forSubagent: opts.forSubagent,
          depth: opts.depth,
          invokedName: parsed.name,
          signal,
          activation: opts.activation,
          cwd: opts.getCwd?.(),
        });
      },
    };
  }
  const slashCommandTool = createSlashCommandTool({ depth: 0, forSubagent: false });
  claudeNamedTools.push(slashCommandTool as Record<string, unknown>);

  if (project.settings.subagentsEnabled) {
    // The built-in agent types guarantee dispatchable agents even when the
    // project defines none — so Agent/Task always register when subagents are on.
    claudeNamedTools.push(
      createAgentToolDefinition(subagentRuntime, { depth: 0, name: "Agent", backgroundTasks, captureUniversalStop: () => mainCheckpointGate.captureLogicalRunStop() }),
      createAgentToolDefinition(subagentRuntime, { depth: 0, name: "Task", backgroundTasks, captureUniversalStop: () => mainCheckpointGate.captureLogicalRunStop() }),
      // SendMessage: the coordinator's channel back into its subagents —
      // resume a finished one (same id, full context, background) or steer a
      // running background one. Parent-session only (never in customToolsFor).
      createSendMessageToolDefinition(subagentRuntime, {
        registry: subagentRegistry,
        backgroundTasks,
      }),
    );
  }
  // Registered unconditionally: TaskOutput/TaskStop answer helpfully even when
  // no background task was ever started.
  claudeNamedTools.push(
    createTaskOutputTool(backgroundTasks, {
      resolveAgentColor: (agentId, agentName) => subagentRuntime.agentDisplayColor(agentId, agentName),
    }) as Record<string, unknown>,
    createTaskStopTool(backgroundTasks, subagentRegistry) as Record<string, unknown>,
  );
  for (const tool of claudeNamedTools) {
    try {
      // Main-session definitions pass through specialized search → routine/Edit
      // rendering → safe settled-success collapse → foreground-glyph self-shell.
      // The checkpoint gate then wraps execute exactly once, outside every
      // presentation decorator, before registration so canonical results retain
      // its terminate metadata. `customToolsFor` skips this parent-TUI chain.
      const mainSessionTool: Record<string, unknown> = tool.name === "Grep" || tool.name === "Glob"
        ? withCompactSearchRendering(tool as unknown as ToolDefinition, {
            resolveDisplayRoot: getCwd,
            repositoryRoot: project.root,
          }) as unknown as Record<string, unknown>
        : tool;
      const routineRendered = withRoutineToolRendering(
        mainSessionTool as unknown as ToolDefinition,
        { resolveDisplayRoot: getCwd, repositoryRoot: project.root },
      );
      const defaultCollapsed = withDefaultCollapsedToolRendering(routineRendered, {
        resolveDisplayRoot: getCwd,
        repositoryRoot: project.root,
      });
      pi.registerTool(mainCheckpointGate.wrapTool(
        wrapForSelfShell(defaultCollapsed as unknown as Record<string, unknown>),
      ));
    } catch (err) {
      console.error(`PiCC: failed to register tool: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-session native-safe scratch dir
  // ---------------------------------------------------------------------------
  // Created EAGERLY in the outer scope — before the async IIFE below and the
  // before_agent_start registration — so its literal resolved path is captured
  // synchronously at the system-prompt injection call site (not raced by the
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
    // A scratch-dir failure must never crash activation; prompt assembly simply
    // omits the scratchpad guidance when the value is unavailable.
    console.error(`PiCC: session scratch dir unavailable: ${(err as Error).message}`);
  }

  // Cwd-swapping overrides of Pi built-ins. Execute is sourced from the
  // ctx-dropping create*Tool factory (byte-identical). Main-session definitions
  // pass through routine/Edit rendering → safe default collapse → foreground-glyph
  // self-shell → the one outer checkpoint gate → registration; subagent stock
  // definitions stay raw.
  // The IIFE promise is captured (not `void`ed) so the readiness seam can await
  // built-in registration settlement via onInitializationSettled.
  const builtInRegistration = (async () => {
    try {
      const sdk: any = await (testSeam?.loadBuiltinSdk?.() ?? import("@earendil-works/pi-coding-agent"));
      // Pin the shell to real Git Bash on Windows — Pi's default `bash` lookup can
      // land on the System32 WSL stub (WSL_E_DEFAULT_DISTRO_NOT_FOUND without a distro).
      const shellPath = resolveGitBashPath();
      // Both built-in sourcings (execute from create*Tool, renderers from
      // create*ToolDefinition), the bash spawnHook/env, Git-Bash pinning, and the
      // live-cwd execute rebind live in the shared factory so the main session and
      // subagents construct byte-identical raw tools. Only this registration loop
      // adds routine/Edit rendering → safe default collapse → foreground-glyph
      // self-shell before the outer checkpoint gate and registration; keeping that
      // composition here prevents parent-TUI policy from entering subagents.
      const builtins = buildStockBuiltinTools(sdk as BuiltinToolSdk, cwdState, {
        settingsEnv: project.settings.env ?? {},
        projectRoot: project.root,
        ...(shellPath ? { shellPath } : {}),
      });
      for (const { def } of builtins) {
        const searchRendered = def.name === "grep" || def.name === "find" || def.name === "ls"
          ? withCompactSearchRendering(def as unknown as ToolDefinition, {
              resolveDisplayRoot: getCwd,
              repositoryRoot: project.root,
            })
          : def as unknown as ToolDefinition;
        const routineRendered = withRoutineToolRendering(
          searchRendered,
          { resolveEditRenderCwd: getCwd, resolveDisplayRoot: getCwd, repositoryRoot: project.root },
        );
        const defaultCollapsed = withDefaultCollapsedToolRendering(routineRendered, {
          resolveDisplayRoot: getCwd,
          repositoryRoot: project.root,
        });
        pi.registerTool(mainCheckpointGate.wrapTool(
          wrapForSelfShell(defaultCollapsed as unknown as Record<string, unknown>),
        ));
      }
      // The optional operations replacement only pins the local shell. The
      // synchronous admission handler above is the sole cleanup owner.
      if (shellPath && typeof sdk.createLocalBashOperations === "function") {
        pi.on("user_bash", () => ({
          operations: sdk.createLocalBashOperations({ shellPath }),
        }));
      }
    } catch (err) {
      console.error(`PiCC: built-in cwd overrides unavailable: ${(err as Error).message}`);
    }
  })();
  void builtInRegistration;

  // ---------------------------------------------------------------------------
  // MCP tool exposure (detached; the first-turn barrier below awaits it)
  // ---------------------------------------------------------------------------
  // After the non-blocking connect settles, each connected server's tools
  // register as `mcp__<server>__<tool>` proxies through the same decoration
  // pipeline as every other main-session custom tool; Pi auto-activates newly
  // registered names (the main session has no tool allowlist), so post-load
  // registration reaches the model on the next turn. Bare-name and server-level
  // deny rules remove matching tools from the model's context entirely (Claude
  // parity — gateTools already owns that removal grammar); the guard's
  // call-time deny stays the backstop for everything else. Zero enabled
  // servers: whenSettled is pre-resolved and zero proxies build — nothing
  // registers, nothing is printed, the model's context is untouched.
  const mcpRegistration = (async () => {
    try {
      await mcpRuntime.whenSettled();
      // Settle-time stderr drain: the runtime's accumulated diagnostics
      // (connect failures, timeouts, dropped tools — each already bounded and
      // control-stripped) go to stderr one line each. These verbose operational
      // diagnostics complement the bounded human-facing status/report surfaces
      // and one-time startup notice; this is the stderr surface the registry's
      // feature.mcp note claims.
      for (const diag of mcpRuntime.diagnostics()) {
        console.error(`PiCC: MCP: ${diag}`);
      }
      const proxies = buildMcpProxyTools(mcpRuntime);
      if (proxies.length === 0) return;
      const admitted = new Set(
        permissionEngine.gateTools(undefined, undefined, proxies.map((t) => t.name)),
      );
      for (const proxy of proxies) {
        if (!admitted.has(proxy.name)) continue;
        // Per-tool catch (same idiom as the claudeNamedTools loop): one
        // throwing registerTool must not drop the sibling tools behind it.
        try {
          const routineRendered = withRoutineToolRendering(proxy);
          const defaultCollapsed = withDefaultCollapsedToolRendering(routineRendered);
          pi.registerTool(mainCheckpointGate.wrapTool(
            wrapForSelfShell(defaultCollapsed as unknown as Record<string, unknown>, {
              fallbackCallDisplayName: proxy.label,
            }),
          ));
        } catch (err) {
          console.error(`PiCC: failed to register MCP tool "${proxy.name}": ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.error(`PiCC: MCP tool registration failed: ${(err as Error).message}`);
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
    // Active skills' disallowed-tools: enforced while the skill is resident.
    extraDenyRules: () => [...activeSkillDenyRules.values()].flat(),
    // Backstop: clip a single oversized tool result before it enters context.
    clipMaxTokens: config.compaction.clipMaxTokens,
    captureUniversalStop: () => mainCheckpointGate.captureLogicalRunStop(),
  })(pi);

  // ---------------------------------------------------------------------------
  // System prompt assembly (every turn — also compaction preservation)
  // ---------------------------------------------------------------------------
  // Skill-listing tier degradation: surfaced once per tier CHANGE — the
  // suffix renders every turn, so a per-render report would spam stderr.
  const reportListingDegradation = createTierChangeReporter((message) =>
    console.error(`PiCC: ${message}`),
  );
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    deliverSettlementNotices();
    // First-turn MCP settle barrier: Pi awaits this handler before snapshotting
    // the run's tools, so waiting for the registration step (itself bounded by
    // MCP_TIMEOUT via whenSettled) makes the first request deterministically
    // carry connected servers' tools. Registration, not bare whenSettled: settle
    // alone would race Pi's snapshot against the detached registerTool calls.
    // Resolved-promise no-op after the first settle and on the zero-enabled
    // path; never rejects (its own try/catch degrades to stderr).
    await mcpRegistration;
    // One-time MCP failure warning: every enabled server has settled behind the
    // barrier above, so the FIRST turn after settle is the one honest moment to
    // report connect failures. Checked exactly once per session — a "failed"
    // state a later shutdown synthesizes must never re-trigger it. stderr is
    // the no-UI fallback, never the only surface (/doctor stays the record).
    if (!mcpFailureChecked) {
      mcpFailureChecked = true;
      try {
        const failed = mcpRuntime.serverStates().filter((s) => s.state === "failed");
        if (failed.length > 0) {
          const message =
            `MCP server(s) failed to connect: ${failed.map((s) => s.name).join(", ")} — ` +
            "run /doctor for details.";
          if (ctx?.hasUI) ctx.ui?.notify?.(message, "warning");
          else console.error(`PiCC: ${message}`);
        }
      } catch (err) {
        console.error(`PiCC: MCP failure notice failed: ${(err as Error).message}`);
      }
    }
    try {
      const suffix = buildSystemPromptSuffix({
        claudeMd: project.claudeMd,
        rules: project.rules,
        skills: project.skills,
        // Built-ins appear in the routing catalog after the project's agents.
        agents: project.settings.subagentsEnabled ? agentsWithBuiltins() : [],
        settings: project.settings,
        state,
        steeringText,
        // Only the main session receives the `## Working with the user`
        // interaction posture — the subagent prompt builder leaves this unset.
        includeInteractionPosture: true,
        // The literal native-safe scratch dir (captured eagerly above) is
        // injected on all platforms; the Windows namespace note is gated on the
        // shell↔native split detection.
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
  // Background settlement notices — visible without polling
  // ---------------------------------------------------------------------------
  // At the parent's NEXT turn (before_agent_start, above), deliver a one-time,
  // transcript-visible notice for each eligible, uncollected current task
  // generation: outcome (the shared presenter's vocabulary — a stopped task reads
  // "aborted"), the capped error when failed, the agent id, and a bounded,
  // explicitly-framed UNTRUSTED excerpt of its output. Delivered via the
  // message-level channel PiCC already uses (pi.sendMessage + deliverAs "steer")
  // so it lands in the transcript like Claude Code's settlement message.
  // Exactly-once delivery combines task-local collected/notified state with the
  // per-agent readiness gate (which a resume re-arms). Folded into the single
  // before_agent_start handler (own try/catch) rather than a second listener, so
  // it can never depend on multi-handler ordering and a drain failure can never
  // break prompt assembly.
  //
  // Honest limitation: before_agent_start fires when the user continues the
  // conversation, so an IDLE coordinator (turn ended, awaiting input) learns of
  // settlement only when the conversation continues — PiCC does NOT re-invoke an
  // idle agent. No wake-an-idle-parent machinery is built here.
  function deliverSettlementNotices(): void {
    let notices: SettlementNotice[];
    try {
      notices = backgroundTasks.drainSettlementNotices(
        // PEEK the dedup gate — do not flip it while selecting.
        (agentId) => subagentRegistry.isSettledNoticeArmed(agentId),
        // COMMIT the gate — called by the loop below ONLY after a successful send.
        (agentId) => subagentRegistry.consumeSettledNotice(agentId),
        // Drain-fallback gate: a true registry MISS means the dispatch
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
        // `details` is UI-only structured record data for the registered
        // picc-settlement renderer; `content` stays the entire model-facing text.
        pi.sendMessage(
          {
            customType: "picc-settlement",
            content: notice.content,
            display: true,
            details: notice.details,
          },
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
  pi.on("session_before_switch", async () => {
    // The controller cancels first; the old nested agent_settled or host callback
    // is the only authority that can confirm the logical run has joined.
    const result = await mainCheckpointGate.beforeSessionSwitch();
    if (!result?.cancel) {
      // Invalidate lifecycle authority at switch acceptance, not only at the next
      // session_start, so an old manual completion in that gap is inert.
      checkpointSessionEpoch = {};
      activeCompactionOperation = undefined;
    }
    return result;
  });

  pi.on("session_start", async (event: any, ctx: any) => {
    await mainCheckpointGate.startSession(randomUUID());
    checkpointContext = ctx;
    checkpointSessionEpoch = {};
    const sessionStartEpoch = checkpointSessionEpoch;
    const sessionStartController = mainCheckpointGate.currentController();
    activeCompactionOperation = undefined;
    printedResumeToken = undefined;
    stopHookIterations = 0;
    try {
      modelRegistryRef = ctx.modelRegistry;
      sessionManagerRef = ctx.sessionManager;
      // Status panel: interactive TUI ONLY. The gate is `ctx.mode === "tui"`
      // specifically, NOT `hasUI` — RPC mode also implements setWidget (and
      // reports hasUI: true), so a hasUI gate would install the panel into an
      // RPC client; print/RPC output must stay unchanged.
      if (ctx.mode === "tui") {
        ctx.ui?.setStatus?.("picc-checkpoint", undefined);
        subagentPanel.attach(ctx.ui);
        // Arms the one-time panel hint: the TUI gate is "a TUI ui was seen",
        // so print/RPC sessions never emit it (and never consume its gate).
        panelHintUi = ctx.ui;
      }
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
      // core.hooksPath self-heal: a project shipping .githooks expects them live,
      // but a clone installed with --ignore-scripts never ran the `prepare` that
      // sets core.hooksPath. (Worktrees inherit it from the shared config.)
      if (fs.existsSync(path.join(project.root, ".githooks"))) {
        const trustedGit = await resolveTrustedGit();
        if (trustedGit) {
          const current = await sanitizedExecFile(trustedGit, ["config", "core.hooksPath"], {
            cwd: project.root,
          }).catch(() => ({ stdout: "" }));
          if (!String(current.stdout ?? "").trim()) {
            await sanitizedExecFile(trustedGit, ["config", "core.hooksPath", ".githooks"], {
              cwd: project.root,
            }).catch(() => undefined);
          }
        }
      }
      const sessionStartSource = event.reason === "new"
        ? "clear"
        : event.reason === "reload"
          ? "startup"
          : event.reason;
      const stopRun = mainCheckpointGate.captureLogicalRunStop();
      const outcome = await hooks.fire("SessionStart", {
        source: sessionStartSource,
        cwd: cwdState.get(),
      });
      if (checkpointSessionEpoch !== sessionStartEpoch ||
          mainCheckpointGate.currentController() !== sessionStartController) return;
      if (outcome.stop) {
        const reason = outcome.stopReason ?? "SessionStart hook requested stop";
        try {
          if (ctx.hasUI) ctx.ui?.notify?.(reason, "warning");
          else console.error(`PiCC: ${reason}`);
          ctx.abort?.();
        } catch { /* stop authority remains final */ }
        stopRun();
        return;
      }
      const hookContext = [outcome.stdout, outcome.additionalContext].filter(Boolean).join("\n");
      if (hookContext.trim()) {
        pi.sendMessage(
          { customType: "picc-hook-context", content: hookContext.trim(), display: true },
          { deliverAs: "nextTurn" },
        );
      }
      // Pending servers require a bounded approval or decline decision, so this
      // actionable state survives quiet startup as one notice. Startup only —
      // /new and reload must not re-toast state the user already saw.
      if (event.reason === "startup" && compat.mcpPendingNotice) {
        if (ctx.hasUI) ctx.ui?.notify?.(compat.mcpPendingNotice, "warning");
        else console.error(`PiCC: ${compat.mcpPendingNotice}`);
      }
      // Advisory only: TUI + direct verified registry launch. The detached,
      // bounded checker never delays session_start or emits machine-mode output.
      if (event.reason === "startup" && ctx.mode === "tui") {
        releaseAdvisory.start((message) => {
          try { ctx.ui?.notify?.(message, "info"); } catch { /* advisory only */ }
        });
      }
    } catch (err) {
      console.error(`PiCC session_start failed: ${(err as Error).message}`);
    }
  });

  pi.on("message_end", (event: any) => {
    mainCheckpointGate.assistantMessageEnded(event?.message);
  });

  pi.on("message_start", (event: any) => {
    mainCheckpointGate.userMessageStarted(
      event?.message,
      event?.streamingBehavior ?? event?.delivery ?? event?.message?.delivery,
    );
  });

  pi.on("tool_execution_end", (event: any) => {
    mainCheckpointGate.toolExecutionEnded(event);
  });

  pi.on("turn_end", (_event: any, ctx: any) => {
    checkpointContext = ctx;
    mainCheckpointGate.turnEnded(ctx);
  });

  pi.on("turn_start", async (_event: any, ctx: any) => {
    await mainCheckpointGate.defensiveLatch(ctx);
  });

  pi.on("before_provider_request", async (_event: any, ctx: any) => {
    await mainCheckpointGate.defensiveLatch(ctx);
  });

  pi.on("session_shutdown", async (event: any) => {
    try {
      // Cancellation owns abort-before-join; never manufacture nested settlement.
      await mainCheckpointGate.cancel("shutdown");
      // This registry/runtime pair is session-local: claim any linked background
      // generations first (suppressing stale output/notices), then join every
      // retained child before SessionEnd and process shutdown proceed.
      await Promise.allSettled(subagentRegistry.list()
        .filter((record) => record.state === "running" && record.checkpointPaused)
        .map((record) => backgroundTasks.stopAgentAndWait(record.agentId)));
      await subagentRuntime.shutdownCheckpointPaused();
      // MCP servers die with the session — after the subagent joins above
      // (an in-flight subagent MCP call must not lose its server mid-call),
      // before SessionEnd fires. Never throws; grace-bounded per server.
      await mcpRuntime.shutdown();
      // `reason` is the matcher subject for SessionEnd (Claude wire contract).
      await hooks.fire("SessionEnd", { cwd: cwdState.get(), reason: event?.reason ?? "other" });
    } catch {
      /* floor */
    }
  });

  pi.on("input", async (event: any, ctx: any) => {
    try {
      // Extension continuations are internal. Every other admitted input is a
      // user boundary and clears the retained Pi startup flag before processing.
      if (event.source !== "extension") clearStartupSuppression();
      if (mainCheckpointGate.authorizeReplay(event)) return { action: "continue" };
      const stopCapability = stopContinuationAdmission.getStore();
      if (stopCapability) {
        if (!stopCapability.consumed && event.source === "extension" &&
            event.text === stopCapability.text && event.images === undefined &&
            event.streamingBehavior === undefined) {
          const controller = mainCheckpointGate.currentController();
          const snapshot = controller.snapshot();
          const resume = activeMainResume;
          if (stopCapability.epoch === checkpointSessionEpoch &&
              stopCapability.controller === controller &&
              stopCapability.generation === snapshot.generation &&
              stopCapability.resumeToken === resume?.token &&
              resume.epoch === stopCapability.epoch &&
              resume.generation === stopCapability.generation &&
              resume.token.generation === stopCapability.generation &&
              snapshot.phase === "resuming") {
            stopCapability.consumed = true;
            return { action: "continue" };
          }
        }
        return { action: "handled" };
      }
      const inputDisposition = mainCheckpointGate.ordinaryInputDisposition();
      if (inputDisposition === "reject-recoverable" || inputDisposition === "reject-restoration" ||
          inputDisposition === "reject-closed" || inputDisposition === "reject-stopped") {
        const controller = mainCheckpointGate.currentController();
        const text = inputDisposition === "reject-recoverable"
          ? "Work remains paused. Run /compact, then explicitly continue."
          : inputDisposition === "reject-restoration"
            ? "The compacted summary is committed, but restoration or continuation failed. Do not compact it again; start a new session and resend the retained input."
            : inputDisposition === "reject-stopped"
              ? "The stopped run is still terminating. Wait for it to settle before sending another prompt."
              : controller.manualCompactionDisposition() === "allow"
                ? "The prior checkpoint was cancelled. Run /compact to recover this session, or start a new session."
                : "Checkpoint cancellation is still settling. Wait before sending another prompt or attempting recovery.";
        try {
          if (ctx.mode === "print") console.error(`PiCC: ${text}`);
          else if (ctx.mode === "tui") ctx.ui?.notify?.(text, "warning");
        } catch { /* admission was already decided */ }
        const content = Array.isArray(event.images) && event.images.length > 0
          ? [{ type: "text", text: String(event.text ?? "") }, ...event.images]
          : String(event.text ?? "");
        reportRejectedShadows([{
          id: -1,
          generation: controller.snapshot().generation,
          sessionId: controller.sessionId,
          content,
          delivery: event.streamingBehavior === "steer" ? "steer" : "followUp",
        }], ctx);
        return { action: "handled" };
      }
      if (event.source === "extension") {
        if (inputDisposition === "quarantine") {
          const controller = mainCheckpointGate.currentController();
          const images = Array.isArray(event.images) ? event.images : [];
          reportRejectedShadows([{
            id: 0,
            generation: controller.snapshot().generation,
            sessionId: controller.sessionId,
            content: images.length > 0
              ? [{ type: "text", text: String(event.text ?? "") }, ...images]
              : String(event.text ?? ""),
            delivery: event.streamingBehavior === "steer" ? "steer" : "followUp",
          }], ctx);
        }
        return inputDisposition === "accept" ? { action: "continue" } : { action: "handled" };
      }

      // Every transforming path below rewrites the turn text, but Pi may have
      // already captured images the user pasted or dropped onto this input
      // (`event.images`). A `transform` result that omits them makes Pi
      // assemble a text-only turn, silently losing the image. Carry the
      // captured blocks forward on every transform — unchanged and in order,
      // additive (prepend any images the branch itself produced; none do
      // today, but keep it composable). Only genuine user captures enter this
      // pipeline; an authenticated replay already completed it and returned above.
      // This does NOT
      // scrape image paths out of prose — the model `Read`s those (a
      // deliberate non-goal).
      type TransformResult = { action: "transform"; text: string; images?: unknown[] };
      const withCapturedImages = (result: TransformResult): TransformResult => {
        const captured = Array.isArray(event.images) ? event.images : [];
        if (captured.length === 0) return result;
        return { ...result, images: [...(result.images ?? []), ...captured] };
      };
      const accept = <T extends { action: "continue" } | TransformResult>(result: T): T | { action: "handled" } => {
        const text = result.action === "transform" ? result.text : String(event.text ?? "");
        const images = result.action === "transform" ? result.images : event.images;
        // This is the next genuine accepted user run. Rotate lifecycle authority
        // after UserPromptSubmit admission, never for extension replay/continuation.
        mainCheckpointGate.acceptedLogicalRun();
        const shadow = mainCheckpointGate.captureAcceptedInput(ctx, text, images, event.streamingBehavior);
        // Quarantine is an admission decision, not a consequence of successful
        // shadow capture. A settled fallback cannot queue input, but it still must
        // retain/report it rather than allowing provider work.
        if (inputDisposition === "quarantine" && !shadow) {
          const content = Array.isArray(images) && images.length > 0
            ? [{ type: "text", text }, ...images]
            : text;
          const controller = mainCheckpointGate.currentController();
          reportRejectedShadows([{
            id: 0,
            generation: controller.snapshot().generation,
            sessionId: controller.sessionId,
            content,
            delivery: event.streamingBehavior === "steer" ? "steer" : "followUp",
          }], ctx);
        }
        // Any quarantined input is handled even when shadow capture is unavailable;
        // otherwise it could start a second turn before or during compaction.
        return shadow || inputDisposition === "quarantine" ? { action: "handled" } : result;
      };

      // Pi routes registered TUI commands before this event; this second seam
      // keeps admitted print, JSON, and RPC input outside model context.
      const admittedText = String(event.text ?? "");
      const commandInput = parseControlCommandInput(admittedText);
      if (commandInput) {
        await handleControlCommand(commandInput.name, commandInput.args, ctx);
        return { action: "handled" };
      }
      const admittedPiBuiltin = parseAdmittedPiBuiltin(admittedText);
      if (admittedPiBuiltin) {
        await emitPiBuiltinGuidance(admittedPiBuiltin, ctx);
        return { action: "handled" };
      }

      // 1) UserPromptSubmit hook on the raw prompt (Claude order).
      const stopRun = mainCheckpointGate.captureLogicalRunStop();
      const outcome = await hooks.fire("UserPromptSubmit", {
        prompt: event.text,
        cwd: cwdState.get(),
      });
      if (outcome.stop) {
        const reason = outcome.stopReason ?? "UserPromptSubmit hook requested stop";
        try {
          if (ctx.hasUI) ctx.ui.notify(`Prompt stopped by hook: ${reason}`, "warning");
          else console.error(`PiCC: ${reason}`);
          ctx.abort?.();
        } catch { /* hook stop remains final */ }
        stopRun();
        return { action: "handled" };
      }
      if (outcome.block) {
        const reason = outcome.blockReason ?? "";
        try {
          if (ctx.hasUI) ctx.ui.notify(`Prompt blocked by hook: ${reason}`, "warning");
        } catch { /* hook admission remains blocked */ }
        return { action: "handled" };
      }
      // Activation-scoped effects belong to one logical user turn. Only a new,
      // accepted human input expires them; replay and synthetic continuations
      // returned above must preserve the effects across physical turns.
      activeSkillDenyRules.clear();
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
      let rest = text.trim();
      const stacked: ClaudeSkill[] = [];
      while (stacked.length < 5) {
        const m = TYPED_SLASH_TOKEN_RE.exec(rest);
        if (!m) break;
        if (reservedBuiltinName(m[1]!)) break;
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
                    // Esc layering: raw terminal-input listeners run BEFORE the
                    // focused component in pi-tui, so while the subagent panel
                    // is open its close-Esc would otherwise abort this fork —
                    // pass the byte through to the panel instead.
                    if (subagentPanelFocus.isOpen()) return undefined;
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
          // Byte-identical re-invocation → short note instead of a second copy.
          const note = skillDedupNote(skill, rendered);
          parts.push(note ?? skillActivationMessage(skill, rendered));
        }
        // The trailing text is NOT re-appended as its own part: the last
        // skill's rendered activation already carries it as $ARGUMENTS (or via
        // the ARGUMENTS: fallback), so a second copy would duplicate the request.
        return accept(withCapturedImages({ action: "transform", text: parts.join("\n\n") + hookSuffix }));
      }

      if (hookSuffix) {
        return accept(withCapturedImages({ action: "transform", text: `${text}${hookSuffix}` }));
      }
      return accept({ action: "continue" });
    } catch (err) {
      debug(`input handler error: ${(err as Error).message}`);
      // Once a checkpoint has closed admission, capture/hook/pipeline failures
      // cannot reopen transport by falling through to Pi. If quarantine could not
      // reach the normal capture path, preserve/report the raw input here.
      const disposition = mainCheckpointGate.ordinaryInputDisposition();
      if (disposition === "quarantine") {
        const controller = mainCheckpointGate.currentController();
        const images = Array.isArray(event.images) ? event.images : [];
        reportRejectedShadows([{
          id: 0,
          generation: controller.snapshot().generation,
          sessionId: controller.sessionId,
          content: images.length > 0
            ? [{ type: "text", text: String(event.text ?? "") }, ...images]
            : String(event.text ?? ""),
          delivery: event.streamingBehavior === "steer" ? "steer" : "followUp",
        }], ctx);
      }
      return disposition === "accept" ? { action: "continue" } : { action: "handled" };
    }
  });

  const runStopHook = async (ctx: any): Promise<boolean> => {
    try {
      let lastAssistantMessage: string | undefined;
      try {
        // agent_settled carries no messages, so derive Claude's
        // last_assistant_message from Pi's active session branch.
        // getEntries() is only the fallback for doubles without branch selection.
        const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
          const content = entry.message.content;
          lastAssistantMessage = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("")
              : undefined;
          break;
        }
      } catch {
        /* optional Stop payload field */
      }
      const stopRun = mainCheckpointGate.captureLogicalRunStop();
      const outcome = await hooks.fire("Stop", {
        cwd: cwdState.get(),
        stop_hook_active: stopHookIterations > 0,
        ...(lastAssistantMessage === undefined ? {} : { last_assistant_message: lastAssistantMessage }),
      });
      if (outcome.stop) {
        const reason = outcome.stopReason ?? "Stop hook requested termination";
        try {
          if (ctx?.hasUI) ctx.ui?.notify?.(reason, "warning");
          else console.error(`PiCC: ${reason}`);
          ctx?.abort?.();
        } catch { /* universal stop remains terminal */ }
        stopRun();
        stopHookIterations = 0;
        return true;
      }
      // Claude caps consecutive Stop-hook blocks at 8; carry that same bound
      // across checkpoint resume so the internal physical turn cannot reset it.
      if (outcome.block && stopHookIterations < 8) {
        stopHookIterations += 1;
        const continuation = `[Stop hook] Continue working: ${outcome.stopReason ?? outcome.blockReason ?? "the stop condition is not met yet"}`;
        const controller = mainCheckpointGate.currentController();
        const snapshot = controller.snapshot();
        const resume = activeMainResume;
        if (resume && resume.epoch === checkpointSessionEpoch &&
            resume.generation === snapshot.generation &&
            resume.token.generation === snapshot.generation && snapshot.phase === "resuming") {
          const capability: StopContinuationCapability = {
            epoch: checkpointSessionEpoch,
            controller,
            generation: snapshot.generation,
            resumeToken: resume.token,
            text: continuation,
            consumed: false,
          };
          stopContinuationAdmission.run(capability, () => pi.sendUserMessage(continuation));
        } else {
          pi.sendUserMessage(continuation);
        }
        return false;
      }
      stopHookIterations = 0;
      return true;
    } catch {
      return true;
    }
  };

  const emitResumedPrintResult = async (
    ctx: any,
    token: ResumeToken,
    hasAuthority: () => boolean,
  ): Promise<void> => {
    if (ctx?.mode !== "print" || printedResumeToken === token) return;
    const entries: any[] = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
    const entry = [...entries].reverse().find((candidate) =>
      candidate?.type === "message" && candidate.message?.role === "assistant");
    const message = entry?.message;
    if (!message || message.stopReason === "error" || message.stopReason === "aborted") return;
    const blocks = Array.isArray(message.content)
      ? message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string")
      : [];
    if (blocks.length === 0) return;
    const data = Buffer.from(blocks.map((part: any) => `${part.text}\n`).join(""), "utf8");
    const writing = printWriteTail.then(async () => {
      if (printedResumeToken === token || !hasAuthority()) return;
      await writeFdFully(process.stdout.fd, data);
      printedResumeToken = token;
      pi.sendMessage({
        customType: "picc-checkpoint-print-result",
        content: "",
        display: false,
      });
    });
    printWriteTail = writing.catch(() => undefined);
    await writing;
  };

  const settleStoppedMainRun = async (): Promise<boolean> => {
    if (!mainCheckpointGate.isLogicalRunStopped()) return false;
    const controller = mainCheckpointGate.currentController();
    const generation = controller.snapshot().generation;
    const resume = activeMainResume;
    if (resume && mainCheckpointGate.stoppedRunMatches(controller, generation) &&
        resume.generation === generation && resume.epoch === checkpointSessionEpoch &&
        resume.token.generation === generation) {
      // cancelAndJoin waits for this exact physical run's settlement. Release it
      // before joining cancellation so agent_settled never waits on itself.
      resume.resolveSettled();
      activeMainResume = undefined;
    }
    await mainCheckpointGate.settleLogicalRunStop();
    return true;
  };

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    checkpointContext = ctx;
    if (await settleStoppedMainRun()) return;
    const controller = mainCheckpointGate.currentController();
    const resume = activeMainResume;
    if (resume?.generation === controller.snapshot().generation &&
        resume.epoch === checkpointSessionEpoch) {
      if (controller.snapshot().phase === "terminalizing") {
        resume.resolveSettled();
        return;
      }
      if (controller.snapshot().phase === "cancelled") {
        resume.resolveSettled();
        activeMainResume = undefined;
        mainCheckpointGate.logicalRunSettled();
        return;
      }
      if (controller.snapshot().phase === "resuming") {
        if (!await runStopHook(ctx)) return;
        if (await settleStoppedMainRun()) return;
        const current = mainCheckpointGate.currentController();
        const snapshot = current.snapshot();
        if (current === controller && activeMainResume === resume &&
            resume.epoch === checkpointSessionEpoch && snapshot.phase === "cancelled") {
          resume.resolveSettled();
          activeMainResume = undefined;
          return;
        }
        if (current !== controller || activeMainResume !== resume ||
            resume.generation !== snapshot.generation || resume.epoch !== checkpointSessionEpoch ||
            resume.token.generation !== snapshot.generation || snapshot.phase !== "resuming") return;
        const hasPrintAuthority = () => {
          const authorityController = mainCheckpointGate.currentController();
          const authoritySnapshot = authorityController.snapshot();
          const authorityResume = activeMainResume;
          return authorityController === controller && authorityResume === resume &&
            authorityResume.token === resume.token && resume.epoch === checkpointSessionEpoch &&
            resume.generation === authoritySnapshot.generation &&
            resume.token.generation === authoritySnapshot.generation &&
            authoritySnapshot.phase === "resuming";
        };
        try {
          await emitResumedPrintResult(ctx, resume.token, hasPrintAuthority);
        } catch {
          // Leave the assistant entry last: Pi's native print-mode selector can
          // still emit it once this outer settlement barrier is released.
        }
        controller.resumedSettled(resume.token);
        resume.resolveSettled();
        activeMainResume = undefined;
        mainCheckpointGate.logicalRunSettled();
        if (ctx?.mode === "tui") ctx.ui?.setStatus?.("picc-checkpoint", undefined);
        return;
      }
    }

    const checkpointWasArmed = mainCheckpointGate.isActive();
    const generation = mainCheckpointGate.settlementGeneration(ctx);
    if (generation !== undefined) {
      await controller.checkpoint(generation);
      const phase = controller.snapshot().phase;
      if (phase === "exhausted" || phase === "cancelled" || checkpointWasArmed) return;
    }
    const trulySettled = await runStopHook(ctx);
    if (await settleStoppedMainRun()) return;
    // A Stop-blocked continuation remains the same logical run. Only the
    // accepted final boundary revokes lifecycle callbacks captured by it.
    if (trulySettled) mainCheckpointGate.logicalRunSettled();
  });

  pi.on("session_before_compact", async (event: any) => {
    const epoch = checkpointSessionEpoch;
    const controller = mainCheckpointGate.currentController();
    const generation = controller.snapshot().generation;
    const attempt = checkpointAttempt;
    const proactive = controller.isCompactionSummaryActive(generation) &&
      attempt?.epoch === epoch && attempt.controller === controller && attempt.generation === generation;
    const replacingStaleManual = event.reason === "manual" && !proactive &&
      activeCompactionOperation !== undefined && !activeCompactionOperation.proactive &&
      activeCompactionOperation.epoch === epoch && activeCompactionOperation.controller === controller &&
      activeCompactionOperation.generation === generation;
    if ((activeCompactionOperation && !replacingStaleManual) ||
        (!proactive && controller.manualCompactionDisposition() !== "allow")) {
      return { cancel: true };
    }
    // Pi labels extension-initiated compact() as manual; controller summary
    // authority is what maps that physical host request to Claude's auto trigger.
    const trigger = proactive ? "auto" : event.reason === "manual" ? "manual" : "auto";
    const operation: CompactionLifecycleOperation = {
      identity: {}, epoch, controller, generation, proactive, trigger,
    };
    activeCompactionOperation = operation;
    if (attempt && proactive) {
      attempt.operation = operation.identity;
    } else if (event.reason === "manual") {
      operation.recovery = controller.recoveryToken(generation);
    }
    try {
      const stopRun = mainCheckpointGate.captureLogicalRunStop();
      const outcome = await hooks.fire("PreCompact", {
        trigger,
        custom_instructions: typeof event.customInstructions === "string" ? event.customInstructions : "",
        cwd: cwdState.get(),
      });
      const snapshot = controller.snapshot();
      const stale = activeCompactionOperation !== operation || checkpointSessionEpoch !== epoch ||
        mainCheckpointGate.currentController() !== controller || snapshot.generation !== generation ||
        (proactive
          ? !controller.isCompactionSummaryActive(generation)
          : operation.recovery
            ? operation.recovery !== controller.recoveryToken(generation)
            : snapshot.phase !== "idle");
      if (stale || outcome.block || outcome.stop) {
        if (!stale && outcome.stop) stopRun();
        if (!stale && proactive && checkpointAttempt === attempt && !outcome.stop) attempt.hookBlocked = true;
        if (activeCompactionOperation === operation) activeCompactionOperation = undefined;
        return { cancel: true };
      }
    } catch {
      if (proactive && checkpointAttempt === attempt) attempt.hookBlocked = true;
      if (activeCompactionOperation === operation) activeCompactionOperation = undefined;
      return { cancel: true };
    }
    return undefined;
  });

  pi.on("session_compact", async (event: any) => {
    const operation = activeCompactionOperation;
    if (!operation) return;
    const { controller, generation, proactive, trigger, epoch } = operation;
    const attempt = checkpointAttempt;
    const operationMatches = () => operation === activeCompactionOperation && epoch === checkpointSessionEpoch &&
      controller === mainCheckpointGate.currentController() && controller.snapshot().generation === generation &&
      (proactive
        ? attempt?.operation === operation.identity && attempt.controller === controller && attempt.generation === generation
        : operation.recovery
          ? operation.recovery === controller.recoveryToken(generation)
          : controller.snapshot().phase === "idle");
    if (!operationMatches()) {
      if (activeCompactionOperation === operation) activeCompactionOperation = undefined;
      return;
    }
    if (proactive && attempt) {
      attempt.committed = true;
      controller.observeCompactionCommit(generation);
    }
    const isCurrent = () => operationMatches() && (proactive
      ? attempt?.committed === true || controller.isCompactionSummaryActive(generation)
      : operation.recovery
        ? operation.recovery === controller.recoveryToken(generation)
        : controller.snapshot().phase === "idle");

    let restorationFailed = false;
    let universalStop = false;
    try {
      const started = await hooks.fire("SessionStart", { source: "compact", cwd: cwdState.get() });
      if (!isCurrent()) return;
      if (started.stop) {
        restorationFailed = true;
        universalStop = true;
      }
      const startedContext = [started.stdout, started.additionalContext].filter(Boolean).join("\n").trim();
      if (!universalStop && startedContext) {
        if (!isCurrent()) return;
        pi.sendMessage(
          { customType: "picc-hook-context", content: startedContext, display: true },
          { deliverAs: "steer" },
        );
      }
    } catch {
      restorationFailed = true;
    }
    if (!isCurrent()) return;
    if (!universalStop) try {
      const post = await hooks.fire("PostCompact", {
        trigger,
        compact_summary: String(event.compactionEntry?.summary ?? ""),
        cwd: cwdState.get(),
      });
      if (!isCurrent()) return;
      if (post.stop) {
        restorationFailed = true;
        universalStop = true;
      }
    } catch {
      restorationFailed = true;
    }
    if (!isCurrent()) return;
    if (!universalStop) try {
      resetInjectionState(state, project.claudeMd);
      if (state.activeSkills.size) {
        const budgeted = budgetSkillReinjection([...state.activeSkills.entries()]);
        for (const name of budgeted.dropped) {
          debug(`compaction: active skill "${name}" dropped from re-injection (combined budget exceeded)`);
        }
        if (budgeted.text) {
          if (!isCurrent()) return;
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
      restorationFailed = true;
    }
    if (!isCurrent()) return;
    if (proactive && attempt && checkpointAttempt === attempt && attempt.operation === operation.identity) {
      attempt.restorationFailed = restorationFailed;
    }
    if (!proactive) {
      if (restorationFailed) {
        const rejected = await controller.failAfterCommittedSummary(generation);
        reportRejectedShadows(rejected, checkpointContext);
      } else if (event.reason === "manual" && operation.recovery && operation.recovery === controller.recoveryToken(generation)) {
        const recovered = controller.recoverAfterManualCompaction(operation.recovery);
        if (recovered.recovered) {
          publishCheckpoint({ category: "checkpoint-recovered", generation, action: "manual-recovery" }, checkpointContext);
          reportRejectedShadows(recovered.rejected, checkpointContext);
        }
      }
    }
    if (activeCompactionOperation === operation) activeCompactionOperation = undefined;
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
  // Control commands
  //
  // Pi routes registered commands before input in interactive use, while the
  // admitted-input route protects headless and protocol modes from model leakage.
  // ---------------------------------------------------------------------------
  function isTypedSlashInvocable(skill: ClaudeSkill): boolean {
    return skill.userInvocable && supportsTypedSlashName(skill.name) && !reservedBuiltinName(skill.name);
  }

  function isPromptStubEligible(skill: ClaudeSkill): boolean {
    return isTypedSlashInvocable(skill) && supportsPromptStubName(skill.name);
  }

  function directSkillAvailability(skill: ClaudeSkill): string {
    return skill.disableModelInvocation
      ? "direct Skill invocation is not allowed (disable-model-invocation)"
      : "direct Skill invocation remains allowed";
  }

  function renderSkillsList(): string {
    const shadowed = project.skills.filter((s) => s.userInvocable && reservedBuiltinName(s.name));
    const unsupportedSlashNames = project.skills.filter(
      (s) => s.userInvocable && !supportsTypedSlashName(s.name),
    );
    const excludedFromOrdinaryCategories = new Set([...shadowed, ...unsupportedSlashNames]);
    const invocable = project.skills.filter(isTypedSlashInvocable);
    const modelOnly = project.skills.filter((s) => !s.userInvocable && !s.disableModelInvocation);
    const userOnly = project.skills.filter(
      (s) => s.disableModelInvocation && !excludedFromOrdinaryCategories.has(s),
    );
    const fmt = (s: ClaudeSkill) =>
      `  /${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ""} — ${s.description}` +
      (s.source.pluginName ? ` [plugin: ${s.source.pluginName}]` : ` [${s.source.scope}]`);
    const lines = [
      `PiCC — ${project.skills.length} skill(s) loaded`,
      "",
      `Invocable as slash commands (${invocable.length}):`,
      ...invocable.map(fmt),
    ];
    if (shadowed.length) {
      lines.push("", `Shadowed by reserved built-ins (${shadowed.length}) — not invocable as slash commands:`);
      lines.push(...shadowed.map((s) => {
        const winner = reservedBuiltinName(s.name)!;
        return `  /${s.name} — built-in /${winner} wins; ${directSkillAvailability(s)}`;
      }));
    }
    if (unsupportedSlashNames.length) {
      lines.push("", `Unsupported slash names (${unsupportedSlashNames.length}) — loaded but not invocable as typed slash commands:`);
      lines.push(...unsupportedSlashNames.map(
        (s) => `  ${JSON.stringify(s.name)} — ${directSkillAvailability(s)}`,
      ));
    }
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
   * `/usage`: per-subagent token/cost breakdown for THIS session, plus a session
   * total — aggregated from the dispatch registry. Pi's own usage surface does
   * not break usage down per subagent; this does. Lists each dispatched agent's
   * id, type, outcome, usage, and transcript path — the one place a human can
   * look for what their fan-out cost.
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
      // SECURITY (defense-in-depth): agentName comes from agent frontmatter
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
   * Renders control-command output as a TUI-only transcript entry. Pi's
   * `Component` contract is structural
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
  pi.registerEntryRenderer("picc-proactive-compact", (entry: any, _opts: any, theme: any) =>
    controlOutputComponent("PiCC proactive compaction", entry.data?.notice ?? "", theme),
  );
  // Settlement notices render as the collapsed-expandable subagent completion
  // record (same shape as the tool renderers'), so a never-awaited background
  // settlement still leaves exactly one expandable record in the transcript.
  // Only the RENDERING changes — the model-facing steer text is untouched.
  // Returns undefined (→ Pi's default custom-message box) for nested tasks and
  // for messages without the structured details.
  pi.registerMessageRenderer("picc-settlement", (message: any, opts: any, theme: any) => {
    let details: unknown;
    try {
      details = message?.details;
    } catch {
      return undefined;
    }
    return renderSettlementRecord(details, opts, theme, {
      resolveAgentColor: (agentId, agentName) => subagentRuntime.agentDisplayColor(agentId, agentName),
    });
  });

  type ControlCommandEntry = {
    description: string;
    render: (args: string, ctx: any) => string | Promise<string>;
  };

  const MCP_ARGUMENT_RESPONSE =
    "/mcp is status-only; no action occurred. Run bare /mcp for status. Use /doctor or the documented MCP settings for configuration guidance.";
  const CONTROL_ERROR_RESPONSE =
    "PiCC could not produce that control-command report. No action occurred; try again or run /doctor.";

  const controlCommands = new Map<string, ControlCommandEntry>([
    ["doctor", {
      description: "PiCC: project-specific compatibility report",
      render: async () => renderDoctorReport(project, compat, currentModel, config.compaction, mcpRuntime.serverStates()),
    }],
    ["quota", {
      description: "PiCC: subscription/rate-limit info from the last provider response",
      render: async (_args, ctx) => renderQuota(ctx),
    }],
    ["skills", {
      description: "PiCC: list loaded Claude skills and their invocation availability, including shadowed skills",
      render: async () => renderSkillsList(),
    }],
    ["agents", {
      description: "PiCC: list the subagents available for dispatch",
      render: async () => renderAgentsList(),
    }],
    ["usage", {
      description: "PiCC: per-subagent token/cost this session (subagents only — not the main agent's own usage), with a total",
      render: async () => renderUsageReport(),
    }],
    ["mcp", {
      description: "PiCC: read-only MCP server status",
      render: async (args, ctx) => {
        if (args.trim()) return MCP_ARGUMENT_RESPONSE;
        if (isTextPrintMode(ctx) || ctx?.mode === "json") {
          await (testSeam?.mcpControl?.whenSettled ?? (() => mcpRuntime.whenSettled()))();
        }
        const render = testSeam?.mcpControl?.render ?? renderMcpStatusReport;
        return render(project.mcp, mcpRuntime.serverStates());
      },
    }],
  ]);
  if (launchContext.direct) {
    controlCommands.set("picc-update", {
      description: "PiCC: show non-mutating product update guidance",
      render: async () => piccUpdateGuidance(launchContext),
    });
  }

  const piBuiltinNames = new Set([
    "changelog", "clone", "compact", "copy", "export", "fork", "hotkeys", "import",
    "login", "logout", "model", "name", "new", "quit", "reload", "resume",
    "scoped-models", "session", "settings", "share", "tree", "trust", "help",
  ]);

  function reservedBuiltinName(name: string): string | undefined {
    const normalized = name.toLowerCase();
    if (controlCommands.has(normalized)) return normalized;
    return piBuiltinNames.has(normalized) ? normalized : undefined;
  }

  function parseControlCommandInput(text: string): { name: string; args: string } | undefined {
    const trimmed = text.trim();
    const match = /^\/([A-Za-z0-9][\w-]*)(?=[ \t]|$)/.exec(trimmed);
    if (!match) return undefined;
    const name = match[1]!.toLowerCase();
    if (!controlCommands.has(name)) return undefined;
    return { name, args: trimmed.slice(match[0].length).replace(/^[ \t]+/, "") };
  }

  function parseAdmittedPiBuiltin(text: string): string | undefined {
    const match = /^\/([A-Za-z0-9][\w-]*)(?=[ \t]|$)/.exec(text.trim());
    if (!match) return undefined;
    const canonical = match[1]!.toLowerCase();
    return piBuiltinNames.has(canonical) ? canonical : undefined;
  }

  function isTextPrintMode(ctx: any): boolean {
    return ctx?.mode === "print" || (!ctx?.hasUI && ctx?.mode !== "json");
  }

  async function writeTextControlOutput(output: string, ctx: any): Promise<void> {
    const write = testSeam?.mcpControl?.writeText;
    if (write) await write(output);
    else if (testSeam) console.log(output);
    else await writeFdFully(process.stdout.fd, Buffer.from(`${output}\n`, "utf8"));
  }

  async function appendControlOutput(name: string, output: string, ctx: any): Promise<void> {
    pi.appendEntry("picc-control", { command: name, output });
    // JSON and RPC must remain protocol-owned streams; only text print receives raw stdout.
    if (isTextPrintMode(ctx)) await writeTextControlOutput(output, ctx);
  }

  async function emitFixedControlError(name: string, ctx: any): Promise<void> {
    try {
      await appendControlOutput(name, CONTROL_ERROR_RESPONSE, ctx);
    } catch {
      if (isTextPrintMode(ctx)) {
        try { await writeTextControlOutput(CONTROL_ERROR_RESPONSE, ctx); } catch { /* fail closed */ }
      } else if (ctx?.mode === "tui") {
        try { ctx.ui?.notify?.(CONTROL_ERROR_RESPONSE, "error"); } catch { /* fail closed */ }
      }
    }
  }

  async function emitPiBuiltinGuidance(name: string, ctx: any): Promise<void> {
    const output = `Canonical /${name} is a Pi built-in but was not run from this input path. Use canonical /${name} in the interactive TUI; no project skill ran.`;
    try {
      await appendControlOutput(name, output, ctx);
    } catch {
      if (isTextPrintMode(ctx)) {
        try { await writeTextControlOutput(output, ctx); } catch { /* fail closed */ }
      } else if (ctx?.mode === "tui") {
        try { ctx.ui?.notify?.(output, "warning"); } catch { /* fail closed */ }
      }
    }
  }

  async function handleControlCommand(name: string, args: string, ctx: any): Promise<void> {
    clearStartupSuppression();
    const command = controlCommands.get(name);
    if (!command) return;
    try {
      const output = await command.render(args, ctx);
      await appendControlOutput(name, output, ctx);
    } catch {
      // Recognition is final: processing and presentation faults cannot release
      // the original slash input to hooks, skills, or provider context.
      await emitFixedControlError(name, ctx);
    }
  }

  for (const [name, command] of controlCommands) {
    pi.registerCommand(name, {
      description: command.description,
      handler: async (args: string, ctx: any) => {
        await handleControlCommand(name, args, ctx);
      },
    });
  }

  debug(
    `loaded project root=${project.root} skills=${project.skills.length} agents=${project.agents.length} rules=${project.rules.length}`,
  );

  // ---------------------------------------------------------------------------
  // Slash-command visibility for user-invocable skills.
  //
  // Ordinary non-reserved user-invocable skills are EXECUTED by the `input`
  // handler above (transform → the skill body becomes the user turn — Claude
  // Code's slash semantics, works in every mode, and lets a project skill win
  // over a same-named plugin command). Reserved collisions are intentionally
  // shadowed. Eligible skills are made VISIBLE in the `/` palette by contributing
  // one Pi prompt-template stub each via `resources_discover`. The `input`
  // transform runs before prompt-template expansion, so the stub body is only a
  // fallback and never normally used — it exists purely so `/name` shows up with
  // its description and hint.
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
  try {
    fs.rmSync(promptStubDir, { recursive: true, force: true });
    fs.mkdirSync(promptStubDir, { recursive: true });
    for (const skill of project.skills) {
      if (!isPromptStubEligible(skill)) continue;
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
    debug(`prompt-stub generation failed (typed-slash-eligible skills still work via input; reserved collisions remain shadowed): ${(err as Error).message}`);
  }

  pi.on("resources_discover", () => ({ promptPaths: [promptStubDir] }));

  testSeam?.onInitializationSettled?.(Promise.all([orphanReaping, builtInRegistration]).then(() => undefined));
}

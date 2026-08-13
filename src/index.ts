import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CLEANUP_PERIOD_DAYS,
  type Diagnostic,
  type HookOutcome,
  type HookPayload,
  type PluginRuntimeContext,
  type ResolvedAgentMcpConfig,
  type AgentMcpDeclaration,
  type ResolvedMcpConfig,
  type ToolCallDescriptor,
} from "./types.js";
import { findByName, loadClaudeProject, type LoadedProject } from "./project.js";
import type { ManagedMcpDiscoveryOptions } from "./discovery/managed-policy.js";
import { loadPiCCConfig, mapEffort, steeringForModel } from "./runtime/steering.js";
import { CwdState } from "./runtime/cwd-state.js";
import { HookRunner, mergeHookOutcomes } from "./engine/hook-runner.js";
import { PermissionEngine } from "./engine/permissions.js";
import { parseHookConfig } from "./claude/hooks.js";
import { WorktreeManager, type WorktreeReapResult } from "./runtime/worktrees.js";
import {
  reapSubagentTranscripts,
  type SubagentTranscriptReapResult,
} from "./runtime/subagent-transcript-retention.js";
import {
  SubagentRuntime,
  TRANSCRIPT_OWNERSHIP_RECOVERY_GUIDANCE,
  createAgentToolDefinition,
  createSendMessageToolDefinition,
  presentDispatchResult,
} from "./runtime/subagents.js";
import type { DispatchMcpContext, PiSdk } from "./runtime/subagents.js";
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
import {
  persistRetainedInputReport,
  RetainedInputPersistenceError,
  type RetainedInputPersistenceFailure,
  type RetainedInputPersistenceLocator,
} from "./runtime/retained-input-persistence.js";
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
import { createNotebookEditTool } from "./runtime/tools/notebook-edit.js";
import { createTaskTools } from "./runtime/tools/task-tools.js";
import {
  NOTEBOOK_SESSION_CUSTOM_TYPE,
  NotebookSessionState,
  newestNotebookSessionSnapshot,
  type NotebookSessionSource,
} from "./runtime/notebook-session.js";
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
import { renderMainSessionTool } from "./runtime/main-session-tool-render.js";
import { buildStockBuiltinTools, type BuiltinToolSdk } from "./runtime/builtin-tools.js";
import {
  MainSessionCheckpointGate,
  UnconfirmedHostDeadlineError,
  RESTART_REQUIRED_RECOVERY_GUIDANCE,
  UNCONFIRMED_HOST_RECOVERY_GUIDANCE,
  callbackCompactionAttempt,
  type CheckpointProgress,
  type CheckpointSnapshot,
  type CancellationKind,
  type CancellationOutcome,
  type CancelledInputHandoff,
  type CancelledInputResolution,
  type HostDeadlinePolicy,
  type HostInputLease,
  type MidRunCompactionController,
  type OrdinaryInputDisposition,
  type ResumeToken,
} from "./runtime/mid-run-compaction.js";
import { registerCodexAbortGuard } from "./runtime/codex-abort-guard.js";
import {
  buildCompatReport,
  renderDoctorReport,
  renderMcpStatusReport,
  type CompatReport,
} from "./registry/compat-report.js";
import { loadSkillBodyResult, substituteToolRules, substituteVariables } from "./claude/skills.js";
import { pluginRuntimeDataAuthorization, prepareAuthorizedPluginDataLocation, resolvePluginDataLocation, revalidatePluginDataLocation } from "./claude/plugin-paths.js";
import { resolveGitBashPath, shellNamespaceDiffersFromNative } from "./engine/shell-inject.js";
import { McpRuntime } from "./runtime/mcp.js";
import { createAgentMcpScope, type AgentMcpScope } from "./runtime/agent-mcp.js";
import { buildMcpProxyTools } from "./runtime/mcp-tools.js";
import {
  buildMcpPromptCatalog,
  invokeMcpPrompt,
  matchMcpPromptInvocation,
  McpPromptInvocationError,
  type McpPromptCatalog,
  type McpPromptInvocationErrorCategory,
} from "./runtime/mcp-prompts.js";
import {
  buildMcpResourceTools,
  ListMcpResourcesTool,
  ReadMcpResourceTool,
} from "./runtime/mcp-resources.js";
import { boundedMcpErrorText } from "./runtime/mcp-content.js";
import { clampLines, pushColored, sanitizeDisplayText } from "./runtime/render-util.js";
import {
  parsePluginInventorySlash,
  PLUGIN_INVENTORY_SLASH_USAGE,
  projectPluginInventoryStartup,
  renderPluginInventoryList,
  renderPluginInventoryOperation,
  sanitizePluginInventoryDisplayText,
} from "./runtime/plugin-inventory-text.js";
import { openPluginInventory } from "./runtime/plugin-inventory-focus.js";
import {
  capturePiccLaunchContext,
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
  private readonly executionOverlay = new AsyncLocalStorage<ReadonlyMap<string, HookRunner>>();
  private readonly extras = new Map<string, HookRunner>();

  constructor(private readonly base: HookRunner) {}
  addScoped(identity: string, runner: HookRunner): void {
    if (!this.extras.has(identity)) this.extras.set(identity, runner);
  }
  async withScoped<T>(
    runners: ReadonlyMap<string, HookRunner>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const inherited = this.executionOverlay.getStore() ?? new Map<string, HookRunner>();
    return this.executionOverlay.run(new Map([...inherited, ...runners]), operation);
  }
  private delegates(): HookRunner[] {
    const delegates = [this.base];
    const identities = new Set<string>();
    for (const [identity, runner] of [
      ...this.extras,
      ...(this.executionOverlay.getStore() ?? new Map<string, HookRunner>()),
    ] as Array<[string, HookRunner]>) {
      if (identities.has(identity)) continue;
      identities.add(identity);
      delegates.push(runner);
    }
    return delegates;
  }
  /** True when any delegate has handlers for the event (guard payload-skip). */
  hasHooks(eventName: string): boolean {
    return this.delegates().some((runner) => runner.hasHooks(eventName));
  }
  private readonly reportedDiagnostics = new Set<string>();
  private askDowngradeReported = false;

  async fire(
    eventName: string,
    payload: Partial<HookPayload>,
    toolCall?: ToolCallDescriptor,
  ): Promise<HookOutcome> {
    const outcomes: HookOutcome[] = [];
    for (const runner of this.delegates()) {
      outcomes.push(await runner.fire(eventName, payload, toolCall));
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
    /** Observe the active main notebook state for deterministic lifecycle tests. */
    getActiveNotebookState: () => NotebookSessionState;
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
    /** Observe shutdown ordering at the production MCP ownership boundary. */
    mcpRuntime: Pick<McpRuntime, "shutdown">;
    /** TEST-ONLY access to the actual input hook multiplexer for boundary spies. */
    inputHooks: { fire: (...args: any[]) => Promise<any> };
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
  /** TEST-ONLY replacement for the session-global MCP runtime; never used by production wiring. */
  mcpRuntime?: Pick<
    McpRuntime,
    | "whenSettled"
    | "tools"
    | "prompts"
    | "resourceServers"
    | "callTool"
    | "getPrompt"
    | "readResource"
    | "diagnostics"
    | "serverStates"
    | "shutdown"
  >;
  /** TEST-ONLY fault/timing seams for the MCP control-command boundary. */
  mcpControl?: {
    whenSettled?: () => Promise<void>;
    render?: typeof renderMcpStatusReport;
    writeText?: (output: string) => void | Promise<void>;
  };
  /** TEST-ONLY managed settings locations passed directly to project loading. */
  managedSettingsPaths?: string[];
  /** TEST-ONLY standalone managed-MCP authority and I/O passed directly to project loading. */
  managedMcpDiscovery?: ManagedMcpDiscoveryOptions;
  /** TEST-ONLY managed artifact directories passed directly to project loading. */
  managedArtifactDirs?: string[];
  /** TEST-ONLY bounded replacement for detached built-in SDK loading. */
  loadBuiltinSdk?: () => Promise<any>;
  /** TEST-ONLY in-process replacement at the actual main-session presentation-routing boundary. */
  renderMainSessionTool?: typeof renderMainSessionTool;
  /** TEST-ONLY in-process override for trusted-Git unavailability. */
  resolveTrustedGit?: () => Promise<string | undefined>;
  checkpointDeadlinePolicy?: HostDeadlinePolicy;
  /** TEST-ONLY replacement at the secure retained-input persistence boundary. */
  persistRetainedInputReport?: typeof persistRetainedInputReport;
  /** TEST-ONLY retention I/O and timer replacements; production uses the filesystem and Node timers. */
  retention?: {
    reapSubagentTranscripts?: typeof reapSubagentTranscripts;
    touchMainTranscript?: (file: string) => Promise<void>;
    setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
    clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  };
  /** TEST-ONLY dynamic join: each call waits only for retention jobs already scheduled. */
  onRetentionJobsSettled?: (join: () => Promise<void>) => void;
}

const codexProviderRegistries = new WeakSet<object>();

const MCP_BIDI_FORMATTING_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function escapeMcpBidiFormattingControls(text: string): string {
  return text.replace(MCP_BIDI_FORMATTING_CONTROLS, (control) =>
    `\\u${control.codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase()}`
  );
}

export function buildMcpStartupNotice(
  mcp: ResolvedMcpConfig,
  pendingNotice: string | undefined,
): string | undefined {
  const parts: string[] = [];
  if (pendingNotice) parts.push(pendingNotice);

  if (mcp.failClosed === "native-state-unusable") {
    parts.push("MCP is fail closed because native Claude state is unusable; run /mcp or /doctor for recovery guidance.");
  } else if (mcp.policyPosture === "exclusive-empty") {
    parts.push("Managed MCP policy supplies an empty exclusive server set, so all MCP is disabled; run /mcp or /doctor for details.");
  } else if (mcp.policyPosture === "fail-closed") {
    parts.push("MCP policy is fail closed, so no server can start; run /mcp or /doctor for authority-specific recovery guidance.");
  } else {
    const blocked = mcp.servers.filter((server) => server.status === "blocked");
    if (blocked.length > 0) {
      const shown = blocked.slice(0, 3).map((server) =>
        JSON.stringify(escapeMcpBidiFormattingControls(sanitizeLine(server.name, 40)))
      );
      const omitted = blocked.length - shown.length;
      parts.push(
        `MCP policy blocked ${blocked.length} server(s): ${shown.join(", ")}` +
          (omitted > 0 ? `, and ${omitted} more` : "") +
          "; run /mcp or /doctor for reason and remediation details.",
      );
    }
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Process status for a non-interactive run whose proactive checkpoint ended without
 * delivering the paused work. Distinct from `0` (the work finished) and from `1`, which
 * Pi's own print mode already uses for its failures, so a wrapper can tell a PiCC
 * give-up from either. Pi overrides it only when print mode itself returns nonzero.
 */
const CHECKPOINT_GAVE_UP_EXIT_CODE = 3;

type FdWriter = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: null,
  callback: (error: NodeJS.ErrnoException | null, bytesWritten: number) => void,
) => void;

/**
 * The one identity a caller observes when a run's abort authority releases its fd
 * write. It is deliberately distinct from every OS write error: a released write
 * ended because the run was abandoned, not because the fd failed, and callers that
 * announce the ending need to tell the two apart without matching on prose. `cause`
 * carries the controller's abort reason, which is either a cancellation kind
 * (`user` / `task-stop` / `shutdown` / `replacement`) or the post-commit failure
 * abort, so the announcement can say why.
 */
export class FdWriteReleasedError extends Error {
  readonly code = "ABORT_ERR";

  constructor(reason: unknown) {
    super("fd write released by run abort", { cause: reason });
    this.name = "FdWriteReleasedError";
  }
}

/**
 * `signal` is a parameter rather than a caller-side race because only the loop can
 * stop: a wrapper could stop *waiting* but not stop the next physical write or the
 * transient-retry loop, and an in-flight OS write cannot be recalled in any case.
 * Aborting therefore releases the awaiting caller and issues nothing further; bytes
 * already handed to the OS may still land, which is why the caller treats a released
 * write as "not delivered" rather than "delivered nothing".
 */
export async function writeFdFully(
  fd: number,
  data: Buffer,
  write: FdWriter = fs.write.bind(fs),
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
  signal?: AbortSignal,
): Promise<void> {
  // Aliased so the abort wiring below exists only when there is an authority to
  // release the write, instead of guarding a dead optional chain at every use.
  const releaseAuthority = signal;
  let offset = 0;
  let transientAttempts = 0;
  while (offset < data.length) {
    if (releaseAuthority?.aborted) throw new FdWriteReleasedError(releaseAuthority.reason);
    try {
      const bytesWritten = await new Promise<number>((resolve, reject) => {
        let settled = false;
        let detachRelease: (() => void) | undefined;
        if (releaseAuthority) {
          const release = () => {
            if (settled) return;
            settled = true;
            reject(new FdWriteReleasedError(releaseAuthority.reason));
          };
          releaseAuthority.addEventListener("abort", release, { once: true });
          detachRelease = () => releaseAuthority.removeEventListener("abort", release);
        }
        write(fd, data, offset, data.length - offset, null, (error, written) => {
          if (settled) return;
          settled = true;
          // A completed write must not leave a listener on a signal that outlives it.
          detachRelease?.();
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

const PLUGIN_CONTROL_NAMES = new Set(["plugin", "plugins", "reload-plugins"]);
const PLUGIN_REFRESH_ACTION = "run the canonical /reload in the interactive TUI or exit and relaunch PiCC";
const PLUGIN_RECONCILE_RECOVERY = `Reconcile or reinstall the plugin through Claude Code, then ${PLUGIN_REFRESH_ACTION}`;

function pluginDataFailureRecovery(code: string): string {
  return code === "unreadable-path" || code === "wrong-kind"
    ? "Repair plugin-data ownership, writability, and directory kinds, then retry the affected action; no reload is required"
    : PLUGIN_RECONCILE_RECOVERY;
}
export function pluginRuntimeContextForSource(
  source: { pluginId?: string },
  contexts: ReadonlyMap<string, PluginRuntimeContext>,
): PluginRuntimeContext | undefined {
  return source.pluginId === undefined ? undefined : contexts.get(source.pluginId);
}

export function preparePluginDataDir(opts: {
  userDir: string;
  projectRoot: string;
  context: PluginRuntimeContext;
}): { ok: true } | { ok: false; code: string } {
  const { context } = opts;
  if (path.resolve(context.projectDir) !== path.resolve(opts.projectRoot)) {
    return { ok: false, code: "project-context-mismatch" };
  }
  try {
    const authorized = pluginRuntimeDataAuthorization(context);
    if (authorized !== undefined) {
      const prepared = prepareAuthorizedPluginDataLocation(authorized);
      return prepared.ok ? { ok: true } : { ok: false, code: prepared.code };
    }
    const location = resolvePluginDataLocation(opts.userDir, context.pluginId);
    if (!location.ok) return { ok: false, code: location.code };
    if (path.resolve(location.value.lexicalPath) !== path.resolve(context.dataDir)) return { ok: false, code: "qualified-projection-mismatch" };
    fs.mkdirSync(location.value.lexicalPath, { recursive: true });
    const current = revalidatePluginDataLocation(location.value);
    return current.ok ? { ok: true } : { ok: false, code: current.code };
  } catch {
    return { ok: false, code: "data-directory-preparation-failed" };
  }
}

export function substitutePluginRuntimeText(
  text: string,
  context: PluginRuntimeContext,
  extra: Record<string, string> = {},
): string {
  return substituteVariables(text, {
    ...extra,
    CLAUDE_PLUGIN_ROOT: context.root,
    CLAUDE_PLUGIN_DATA: context.dataDir,
    CLAUDE_PROJECT_DIR: context.projectDir,
  });
}

/** Pure runtime projection; loaded project definitions remain immutable. */
export function projectPluginAgentRuntime(
  agent: ClaudeAgent,
  context: PluginRuntimeContext,
): ClaudeAgent {
  const projectRules = (rules: string[] | undefined): string[] | undefined =>
    rules?.map((rule) => substitutePluginRuntimeText(rule, context));
  return {
    ...agent,
    body: substitutePluginRuntimeText(agent.body, context),
    tools: projectRules(agent.tools),
    disallowedTools: projectRules(agent.disallowedTools),
  };
}

export function createBoundedHeadlessDiagnosticSurface(
  emit: (text: string) => void,
  fingerprintCap = 20,
): (diagnostic: Diagnostic) => void {
  const reported = new Set<string>();
  let saturated = false;
  return (diagnostic: Diagnostic): void => {
    const bounded = sanitizeLine(diagnostic.message, 500);
    const fingerprint = bounded;
    if (reported.has(fingerprint)) return;
    if (reported.size >= fingerprintCap) {
      if (!saturated) {
        saturated = true;
        try {
          emit("PiCC: additional distinct plugin runtime warnings were suppressed; run /doctor for bounded details.");
        } catch {
          // Diagnostics are additive observation and cannot change runtime work.
        }
      }
      return;
    }
    reported.add(fingerprint);
    try {
      emit(`PiCC: ${bounded}`);
    } catch {
      // Diagnostics are additive observation and cannot change runtime work.
    }
  };
}

function createBoundedTuiDiagnosticSurface(fingerprintCap = 20): (
  diagnostics: readonly Diagnostic[],
  notify: (text: string, severity: "warning" | "error") => void,
) => void {
  const reported = new Set<string>();
  let saturated = false;
  return (diagnostics, notify): void => {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity !== "warning" && diagnostic.severity !== "error") continue;
      const message = sanitizeLine(diagnostic.message, 500);
      const source = sanitizeLine(diagnostic.source ?? "", 120);
      const fingerprint = `${diagnostic.severity}:${source}:${message}`;
      if (reported.has(fingerprint)) continue;
      if (reported.size >= fingerprintCap) {
        if (!saturated) {
          saturated = true;
          try {
            notify("PiCC: additional distinct plugin runtime warnings were suppressed; run /doctor for bounded details.", "warning");
          } catch {
            // A failed UI notification must not replay the fork or leak its raw slash input.
          }
        }
        continue;
      }
      reported.add(fingerprint);
      try {
        notify(`PiCC: ${message}`, diagnostic.severity);
      } catch {
        // Diagnostics are additive presentation; the completed transform remains authoritative.
      }
    }
  };
}

const AGENT_MCP_REFRESH_ACTION = "run the canonical /reload in the interactive TUI or exit and relaunch PiCC, then make a fresh Agent dispatch";
const AGENT_MCP_TRANSIENT_OR_CONFIG_ACTION = `if repairing configuration, ${AGENT_MCP_REFRESH_ACTION}; otherwise retry a transient failure with a fresh Agent dispatch`;

export function validateAgentMcpAdmission(
  agent: Pick<ClaudeAgent, "name" | "agentMcp">,
  project: Pick<LoadedProject, "agentMcpAdmission">,
): void {
  if (agent.agentMcp?.items.some((item) => item.kind === "inline") && !project.agentMcpAdmission) {
    throw new Error(`Agent ${JSON.stringify(agent.name)} requests inline MCP, but project MCP admission authority is unavailable.`);
  }
}

export function formatAgentMcpSetupWarning(
  scope: Pick<AgentMcpScope, "borrowedServerNames" | "setupOutcomes">,
  inlineConfig: ResolvedAgentMcpConfig,
  declaration?: Pick<AgentMcpDeclaration, "items" | "diagnostics" | "diagnosticOwnership">,
): string | undefined {
  const findings = new Map<string, string>();
  const safeIdentity = (name: string) => JSON.stringify(sanitizeDisplayText(name, 96, true) || "server");
  const borrowedNames = new Set(scope.borrowedServerNames?.() ?? []);
  for (const server of inlineConfig.servers) {
    if (server.status === "enabled" || borrowedNames.has(server.name)) continue;
    const identity = safeIdentity(server.name);
    const guidance = server.status === "pending-approval"
      ? `${identity} needs project approval in user settings; approve it, ${AGENT_MCP_REFRESH_ACTION}`
      : server.status === "disabled"
        ? `${identity} is disabled; enable it, ${AGENT_MCP_REFRESH_ACTION}`
        : server.status === "blocked"
          ? `${identity} is blocked by managed MCP policy; ask the policy owner to allow it, ${AGENT_MCP_REFRESH_ACTION}`
          : `${identity} has no usable definition; fix its agent mcpServers entry, ${AGENT_MCP_REFRESH_ACTION}`;
    findings.set(server.name, guidance);
  }
  for (const outcome of scope.setupOutcomes()) {
    if (borrowedNames.has(outcome.serverName)) continue;
    const identity = safeIdentity(outcome.serverName);
    findings.set(outcome.serverName, outcome.kind === "missing-reference"
      ? `${identity} is not available in the loaded main-session MCP snapshot; configure and enable that server, ${AGENT_MCP_REFRESH_ACTION}`
      : `${identity} failed during startup or discovery; review its server logs; ${AGENT_MCP_TRANSIENT_OR_CONFIG_ACTION}`);
  }
  const ownerIsBorrowed = (owner: AgentMcpDeclaration["diagnosticOwnership"][number] | undefined): boolean =>
    owner?.kind === "server" && borrowedNames.has(owner.serverName);
  // Diagnostic prose is opaque. Only a validated exact structured owner can make a finding
  // suppressible, and only when that owner is a published session-won collision.
  const hasVisibleDeclarationDiagnostic = (declaration?.diagnostics ?? []).some(
    (_diagnostic, index) => !ownerIsBorrowed(declaration?.diagnosticOwnership?.[index]),
  );
  const hasVisibleAdmissionDiagnostic = inlineConfig.diagnostics.some(
    (_diagnostic, index) => !ownerIsBorrowed(inlineConfig.diagnosticOwnership?.[index]),
  );
  const hasVisibleServerDiagnostic = inlineConfig.servers.some(
    (server) => (server.diagnostics?.length ?? 0) > 0 && !borrowedNames.has(server.name),
  );
  if (hasVisibleDeclarationDiagnostic || hasVisibleAdmissionDiagnostic || hasVisibleServerDiagnostic) {
    findings.set("\u0000declaration", declaration?.items.length === 0
      ? `the explicit mcpServers declaration is malformed and selected no MCP servers; fix it, ${AGENT_MCP_REFRESH_ACTION}`
      : `part of the mcpServers declaration is malformed; fix the skipped entries, ${AGENT_MCP_REFRESH_ACTION}`);
  }
  const retained = [...findings.values()].slice(0, 8);
  if (findings.size > retained.length) retained.push(`${findings.size - retained.length} additional MCP setup issue(s) were omitted`);
  const body = retained.join("; ");
  if (!body) return undefined;
  const warning = `Agent MCP availability warning: ${body}.`;
  if (warning.length <= 480) return warning;
  return `Agent MCP availability warning: one or more MCP setup issues were omitted; if repairing configuration or policy, ${AGENT_MCP_REFRESH_ACTION}; otherwise retry a transient startup failure with a fresh Agent dispatch.`;
}

export default function picc(pi: any, testSeam?: PiccTestSeam) {
  const routeMainSessionTool = testSeam?.renderMainSessionTool ?? renderMainSessionTool;
  const surfaceTypedForkTuiDiagnostics = createBoundedTuiDiagnosticSurface();
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
    project = loadClaudeProject({
      cwd: process.cwd(),
      ...(testSeam?.managedSettingsPaths
        ? { managedSettingsPaths: testSeam.managedSettingsPaths }
        : {}),
      ...(testSeam?.managedMcpDiscovery
        ? { managedMcpDiscovery: testSeam.managedMcpDiscovery }
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
    testSeam?.checkpointDeadlinePolicy ?? {},
    "total-host",
  );
  // PiCC is the sole owner of this API handler while loaded. Supplying only these
  // fields preserves Pi's built-in models, OAuth, credentials, options, and headers;
  // arbitrary custom handlers for the same API are outside the guarded scope.
  if (!codexProviderRegistries.has(pi)) {
    codexProviderRegistries.add(pi);
    registerCodexAbortGuard(pi);
  }
  const cwdState = new CwdState(project.cwd);
  let activeMainNotebookState = new NotebookSessionState();
  const installMainNotebookState = (branch: unknown): void => {
    let installed!: NotebookSessionState;
    installed = new NotebookSessionState({
      onChange: (snapshot) => {
        if (activeMainNotebookState !== installed) return;
        try {
          pi.appendEntry(NOTEBOOK_SESSION_CUSTOM_TYPE, snapshot);
        } catch {
          // The live authorization transition succeeds even when transcript persistence does not.
        }
      },
    });
    installed.restore(newestNotebookSessionSnapshot(branch));
    activeMainNotebookState = installed;
  };
  // Hook payload `transcript_path`: Pi's session manager (captured on
  // session_start) exposes the session file — the closest analog to Claude's
  // transcript. Live getter so session switches stay accurate.
  type MainSessionManager = {
    getSessionFile?: () => string | undefined;
    getCwd?: () => string | undefined;
    getSessionDir?: () => string | undefined;
    getBranch?: () => unknown;
    appendCustomEntry?: (customType: string, data?: unknown) => unknown;
  };
  let sessionManagerRef: MainSessionManager | undefined;
  const transcriptPath = () => {
    try {
      return sessionManagerRef?.getSessionFile?.() ?? undefined;
    } catch {
      return undefined;
    }
  };
  const cleanupPeriodDays = project.settings.cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS;
  const touchMainTranscript = testSeam?.retention?.touchMainTranscript ?? (async (file: string) => {
    const now = new Date();
    await fs.promises.utimes(file, now, now);
  });
  const scheduleInterval = testSeam?.retention?.setInterval ?? setInterval;
  const cancelInterval = testSeam?.retention?.clearInterval ?? clearInterval;
  const transcriptReaper = testSeam?.retention?.reapSubagentTranscripts ?? reapSubagentTranscripts;
  let retentionHeartbeat: ReturnType<typeof setInterval> | undefined;
  let transcriptStartupDecided = false;
  let transcriptReaping: Promise<SubagentTranscriptReapResult> | undefined;
  let retentionPresentation: Promise<void> | undefined;
  let retentionPresentationStarted = false;
  let retentionStartupContext: any;

  const existingMainFile = (manager: MainSessionManager | undefined): string | undefined => {
    try {
      const file = manager?.getSessionFile?.();
      return typeof file === "string" && file.length > 0 ? file : undefined;
    } catch {
      return undefined;
    }
  };
  const refreshCurrentMain = async (): Promise<void> => {
    const file = existingMainFile(sessionManagerRef);
    if (!file) return;
    await touchMainTranscript(file).catch(() => undefined);
  };
  const clearRetentionHeartbeat = (): void => {
    if (retentionHeartbeat === undefined) return;
    try { cancelInterval(retentionHeartbeat); } catch { /* heartbeat cleanup is best-effort */ }
    retentionHeartbeat = undefined;
  };
  const refreshAndArmRetentionHeartbeat = (): Promise<void> => {
    clearRetentionHeartbeat();
    const immediate = refreshCurrentMain();
    if (!existingMainFile(sessionManagerRef)) return immediate;
    try {
      retentionHeartbeat = scheduleInterval(() => { void refreshCurrentMain(); }, 60 * 60 * 1000);
      retentionHeartbeat.unref?.();
    } catch {
      retentionHeartbeat = undefined;
    }
    return immediate;
  };
  const emptyTranscriptFailure = (): SubagentTranscriptReapResult => ({
    removedTranscriptFiles: 0,
    removedCollections: 0,
    retainedEntries: 0,
    failureCounts: {
      race: 0,
      permission: 0,
      busy: 0,
      "ownership-uncertain": 0,
      "other-io": 1,
    },
    diagnosticsTruncated: false,
    diagnostics: [],
  });
  const retentionBlockerSummary = (): string => {
    const blockers = (project.settings.retentionCleanupBlockers ?? []).slice(0, 8).map((blocker) => {
      const source = sanitizeLine(path.posix.basename(String(blocker.source).replaceAll("\\", "/")), 80) || "settings source";
      const reason = blocker.reason === "invalid-period"
        ? "has an invalid cleanup period"
        : blocker.reason === "unreadable-source"
          ? "could not be read"
          : blocker.reason === "malformed-source"
            ? "contains malformed JSON"
            : "does not contain a settings object";
      return `${source} ${reason}`;
    });
    const omitted = Math.max(0, (project.settings.retentionCleanupBlockers?.length ?? 0) - blockers.length);
    return `${blockers.join("; ") || "settings admission was unavailable"}${omitted > 0 ? `; ${omitted} more settings problem(s) omitted` : ""}`;
  };
  const presentRetentionOutcome = async (
    ctx: any,
    worktree: WorktreeReapResult,
    transcript: SubagentTranscriptReapResult | undefined,
  ): Promise<void> => {
    let text: string | undefined;
    let severity: "info" | "warning" = "info";
    if (!retentionCleanupAllowed) {
      severity = "warning";
      text = `Retention cleanup is paused at ${cleanupPeriodDays} days because ${retentionBlockerSummary()}. No retention deletion was attempted. Run /doctor, repair the reported settings source, then restart PiCC.`;
    } else {
      const removedWorktrees = worktree.reaped.length;
      const removedTranscriptFiles = transcript?.removedTranscriptFiles ?? 0;
      const removedCollections = transcript?.removedCollections ?? 0;
      const retainedWorktrees = worktree.retainedWorktrees;
      const retainedTranscripts = transcript?.retainedEntries ?? 0;
      const diagnosticCount = worktree.diagnostics.length + (transcript?.diagnostics.length ?? 0);
      const failureCount = Object.values(worktree.failureCounts).reduce((sum, count) => sum + count, 0) +
        Object.values(transcript?.failureCounts ?? {}).reduce((sum, count) => sum + count, 0);
      if (removedWorktrees === 0 && removedTranscriptFiles === 0 && removedCollections === 0 &&
          retainedWorktrees === 0 && retainedTranscripts === 0 && diagnosticCount === 0 &&
          failureCount === 0 && !transcript?.diagnosticsTruncated) return;

      const details: string[] = [];
      const race = transcript?.failureCounts.race ?? 0;
      if (race > 0) details.push(`${race} transcript cleanup target(s) changed concurrently; no action is needed.`);
      const transcriptPermission = transcript?.failureCounts.permission ?? 0;
      if (transcriptPermission > 0) details.push(`${transcriptPermission} transcript item(s) could not be accessed. Repair transcript ownership and permissions, then restart PiCC.`);
      const worktreePermission = worktree.failureCounts.permission;
      if (worktreePermission > 0) details.push(`${worktreePermission} worktree item(s) could not be accessed. Repair worktree ownership and permissions, then restart PiCC.`);
      const transcriptBusy = transcript?.failureCounts.busy ?? 0;
      if (transcriptBusy > 0) details.push(`${transcriptBusy} transcript item(s) were locked or busy. Close applications using them, then restart PiCC.`);
      const worktreeBusy = worktree.failureCounts.busy;
      if (worktreeBusy > 0) details.push(`${worktreeBusy} worktree item(s) were locked or busy. Close applications using them, then restart PiCC.`);
      const ownershipUncertain = transcript?.failureCounts["ownership-uncertain"] ?? 0;
      if (ownershipUncertain > 0) details.push(`Ownership could not be verified for ${ownershipUncertain} transcript item(s), so affected data remains untouched. ${TRANSCRIPT_OWNERSHIP_RECOVERY_GUIDANCE}`);
      const transcriptIo = transcript?.failureCounts["other-io"] ?? 0;
      if (transcriptIo > 0) details.push(`${transcriptIo} transcript item(s) had another I/O failure. Check session transcript storage access, then restart PiCC.`);
      const worktreeIo = worktree.failureCounts["other-io"];
      if (worktreeIo > 0) details.push(`${worktreeIo} worktree item(s) had another I/O failure. Check project-owned worktree storage access, then restart PiCC.`);
      const settingsBlocked = worktree.failureCounts["settings-blocked"];
      if (settingsBlocked > 0) details.push(`Settings prevented ${settingsBlocked} worktree cleanup attempt(s). Run /doctor, repair settings, then restart PiCC.`);
      const gitAuthority = worktree.failureCounts["git-authority"];
      if (gitAuthority > 0) details.push(`Git authority was unavailable for ${gitAuthority} worktree cleanup attempt(s). Restore repository Git access, then restart PiCC.`);
      if (retainedWorktrees > 0 || retainedTranscripts > 0) {
        details.push("Retained items remain untouched. Use the counts and categories in this notice to review them.");
      }
      const uncategorizedDiagnostics = diagnosticCount > 0 && failureCount === 0;
      if (uncategorizedDiagnostics) {
        details.push(`${diagnosticCount} additional cleanup issue(s) had no structured category. Check session transcript storage and project-owned worktree storage access, then restart PiCC.`);
      }
      if (transcript?.diagnosticsTruncated) details.push("Some transcript cleanup detail was omitted from this bounded notice.");
      text = `Retention cleanup (${cleanupPeriodDays} days): removed ${removedWorktrees} orphaned worktree(s), ${removedTranscriptFiles} transcript file(s), and ${removedCollections} transcript collection(s); retained ${retainedWorktrees} worktree(s) and ${retainedTranscripts} transcript item(s). ${details.join(" ")}`.trim();
      const actionableFailure = failureCount > race;
      severity = actionableFailure || retainedWorktrees > 0 || retainedTranscripts > 0 ||
        uncategorizedDiagnostics || transcript?.diagnosticsTruncated === true ? "warning" : "info";
    }
    try {
      if (ctx?.mode === "tui") ctx.ui?.notify?.(text, severity);
      else console.error(`PiCC: ${text}`);
    } catch {
      // Presentation cannot change cleanup or session lifecycle.
    }
  };
  const startRetentionPresentation = (): void => {
    if (retentionPresentationStarted || !transcriptStartupDecided) return;
    retentionPresentationStarted = true;
    retentionPresentation = Promise.all([orphanReaping, transcriptReaping])
      .then(([worktree, transcript]) => presentRetentionOutcome(retentionStartupContext, worktree, transcript))
      .catch(() => undefined);
    void retentionPresentation;
  };
  const joinScheduledRetentionJobs = async (): Promise<void> => {
    const jobs: Promise<unknown>[] = [orphanReaping];
    if (transcriptReaping) jobs.push(transcriptReaping);
    if (retentionPresentation) jobs.push(retentionPresentation);
    await Promise.allSettled(jobs);
  };
  const sessionRetentionStarted = (ctx: any, reason: unknown): void => {
    sessionManagerRef = ctx?.sessionManager;
    const immediateRefresh = refreshAndArmRetentionHeartbeat();
    if (reason !== "startup" || transcriptStartupDecided) return;
    transcriptStartupDecided = true;
    retentionStartupContext = ctx;
    const manager = sessionManagerRef;
    let activeMainSessionFile: string | undefined;
    let activeMainCwd: string | undefined;
    let sessionDirectory: string | undefined;
    try {
      activeMainSessionFile = manager?.getSessionFile?.();
      activeMainCwd = manager?.getCwd?.();
      sessionDirectory = manager?.getSessionDir?.();
    } catch {
      // The startup session decides transcript cleanup eligibility permanently; replacements never retry it.
    }
    if (
      typeof activeMainSessionFile === "string" && activeMainSessionFile.length > 0 &&
      typeof activeMainCwd === "string" && activeMainCwd.length > 0 &&
      typeof sessionDirectory === "string" && sessionDirectory.length > 0
    ) {
      const options = {
        sessionDirectory,
        activeMainSessionFile,
        activeMainCwd,
        maxAgeDays: cleanupPeriodDays,
        cleanupAllowed: retentionCleanupAllowed,
      };
      transcriptReaping = immediateRefresh
        .then(() => transcriptReaper(options))
        .catch(emptyTranscriptFailure);
      void transcriptReaping;
    }
    startRetentionPresentation();
  };
  let compat: CompatReport = { findings: [], safetyFindings: [], unassessed: [] };
  let pluginStartupNoticePresented = false;
  let mcpStartupNoticePresented = false;
  const pluginContexts = project.pluginContexts;
  const RUNTIME_FINDING_RETAIN_CAP = 20;
  const RUNTIME_FINDING_FINGERPRINT_CAP = 25;
  const runtimeFindingFingerprints = new Set<string>();
  const retainRuntimeFinding = (message: string): void => {
    const bounded = sanitizeLine(message, 500);
    const fingerprint = bounded;
    if (runtimeFindingFingerprints.has(fingerprint)) return;
    if (runtimeFindingFingerprints.size >= RUNTIME_FINDING_FINGERPRINT_CAP) {
      compat.pluginRuntimeFindingsOmittedAtLeast = true;
      return;
    }
    runtimeFindingFingerprints.add(fingerprint);
    if (runtimeFindingFingerprints.size <= RUNTIME_FINDING_RETAIN_CAP) {
      (compat.pluginRuntimeFindings ??= []).push(bounded);
    } else {
      compat.pluginRuntimeFindingsOmitted = runtimeFindingFingerprints.size - RUNTIME_FINDING_RETAIN_CAP;
      if (runtimeFindingFingerprints.size === RUNTIME_FINDING_FINGERPRINT_CAP) {
        compat.pluginRuntimeFindingsOmittedAtLeast = true;
      }
    }
  };
  const ensurePluginDataDir = (
    context: PluginRuntimeContext,
    component: string,
  ): { ok: true } | { ok: false; message: string } => {
    const fail = (action: string): { ok: false; message: string } => ({
      ok: false,
      message: `${sanitizeLine(component, 128)} for plugin "${sanitizeLine(context.pluginId, 128)}": ${action}; execution did not occur`,
    });
    const prepared = preparePluginDataDir({
      userDir: project.userDir,
      projectRoot: project.root,
      context,
    });
    return prepared.ok
      ? prepared
      : fail(`persistent data directory validation or creation failed (${prepared.code}). ${pluginDataFailureRecovery(prepared.code)}`);
  };
  const baseHooks = new HookRunner({
    config: project.mergedHooks,
    projectDir: project.root,
    sessionId,
    env: project.settings.env,
    disableAllHooks: project.settings.disableAllHooks,
    pluginContexts,
    ensurePluginDataDir,
    onRuntimeFinding: retainRuntimeFinding,
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
  const retentionCleanupAllowed = project.settings.retentionCleanupAllowed === true;
  const worktrees = new WorktreeManager({
    projectRoot: project.root,
    settings: project.settings.worktree,
    cleanupPeriodDays: project.settings.cleanupPeriodDays,
    retentionCleanupAllowed,
    // Worktree setup/reaping can run before first input, so sanitize inherited
    // launcher context without admitting project-controlled environment policy.
    // Only the manager's expected command may cross this administration seam.
    exec: async (cmd, args, opts) => {
      const trustedGit = cmd === "git" ? await resolveTrustedGit() : undefined;
      if (!trustedGit) {
        return {
          stdout: "",
          stderr: "Git was not found on PATH; install Git or set PICC_GIT to its absolute path",
          code: 1,
        };
      }
      return await sanitizedExecFile(trustedGit, args, opts);
    },
  });
  const emptyWorktreeFailure = (): WorktreeReapResult => ({
    reaped: [],
    retainedWorktrees: 0,
    failureCounts: {
      "settings-blocked": 0,
      "git-authority": 0,
      permission: 0,
      busy: 0,
      "other-io": 1,
    },
    diagnostics: [],
  });
  // Activation-time orphan-worktree cleanup stays detached, retaining its result for one startup report.
  const orphanReaping = worktrees.reapOrphans().catch(emptyWorktreeFailure);
  void orphanReaping;
  testSeam?.onRetentionJobsSettled?.(joinScheduledRetentionJobs);
  const state = newSessionContextState(project.claudeMd);
  // Completeness floor: a report failure must never abort extension init.
  try {
    compat = buildCompatReport(project);
  } catch (err) {
    console.error(`PiCC compatibility scan failed (continuing): ${(err as Error).message}`);
    compat = { findings: [], safetyFindings: [], unassessed: [] };
  }
  // One-shot latch for the post-settle MCP connect-failure warning (see the
  // before_agent_start handler).
  let mcpFailureChecked = false;
  const MCP_STARTUP_STATUS_KEY = "picc-mcp-startup";
  const MCP_STARTUP_STATUS_TEXT = "Waiting for MCP servers to start…";

  let currentModelRef = "";
  let currentModel: unknown; // the orchestrator's active model — inherited by subagents
  let steeringText: string | undefined;
  let stopHookIterations = 0;
  let checkpointContext: any;
  let checkpointSessionEpoch: object = {};
  let printedResumeToken: ResumeToken | undefined;
  /**
   * Serializes resumed print emissions **within one session epoch only**. What stops
   * a stalled write from parking a later emission is the abort release in
   * `writeFdFully`; keying the chain to the epoch that owns it is a structural
   * backstop, so the chain cannot outlive the session that built it even if that
   * release is ever restructured away. `checkpointSessionEpoch` is replaced at both
   * session boundaries (session_start and an accepted session_before_switch), so the
   * next session builds a fresh chain rather than queueing behind a dead one.
   *
   * The trade this accepts: a released emission returns to its caller while the OS
   * write it issued may still be in flight, so two writes can be concurrent on fd 1
   * across a session boundary. Cross-epoch stdout ordering is therefore deliberately
   * unguaranteed — deadlock-freedom is worth more than ordering between a session
   * that was abandoned and its successor.
   */
  let printWriteChain: { epoch: object; tail: Promise<void> } | undefined;
  interface StopContinuationCapability {
    readonly epoch: object;
    readonly controller: MidRunCompactionController;
    readonly generation: number;
    readonly resumeToken: ResumeToken;
    readonly text: string;
    consumed: boolean;
  }
  const stopContinuationAdmission = new AsyncLocalStorage<StopContinuationCapability>();
  type CompactionOperationOrigin = "picc-proactive" | "pi-native-auto" | "user-manual";
  interface CompactionLifecycleOperation {
    identity: object;
    epoch: object;
    controller: MidRunCompactionController;
    generation: number;
    origin: CompactionOperationOrigin;
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
  /**
   * How a resumed run ended. `completed` is the only conclusion that may claim the
   * paused work was delivered; `abandoned` is a post-commit give-up that closes the
   * session; `superseded` hands the terminal to whatever authority the controller
   * has already moved to — a cancellation, a terminalization, a stopped logical run,
   * or the replacement installed by an epoch rotation.
   */
  type ResumeConclusion = "completed" | "cancelled" | "abandoned" | "superseded";
  let activeMainResume: {
    generation: number;
    token: ResumeToken;
    epoch: object;
    context: any;
    /** The run's own cancellation authority, so a resumed emission can be released. */
    signal: AbortSignal;
    requestCancellation(kind: CancellationKind): Promise<CancellationOutcome>;
    settled: Promise<void>;
    /**
     * True while some owner is expected to publish `settled`: a physical turn PiCC
     * dispatched through an API whose completion Pi announces (see the `triggerTurn`
     * note at the send site for the one precondition that carries), or the
     * `agent_settled` handler invocation currently deciding this run's ending. It
     * goes false at exactly one place — the Stop-continuation hand-off, where PiCC
     * has bet on a `pi.sendUserMessage` that returns void and that Pi may drop
     * without ever starting a turn.
     *
     * It is a claim about who owes a settlement, not a proof: the handler
     * invocation's own coverage has one exception, named at the `agent_settled`
     * ownership comment. `cancelAndJoin` reads it to decide whether to conclude the
     * run itself before joining.
     */
    settlementOwned: boolean;
    /**
     * True once a `cancelAndJoin` has parked on `settled`. It pairs with
     * `settlementOwned` to make the hand-off race-free: the join publishes this flag
     * and then samples ownership, and the hand-off clears ownership and then samples
     * this flag, so whichever of the two runs second sees the other and publishes the
     * ending. Without it, a join that sampled ownership one tick before the hand-off
     * cleared it would wait forever on a settlement nobody owes.
     */
    joinParked: boolean;
    /** Publishes this run's settlement, whole, exactly once, on every ending. */
    conclude(conclusion: ResumeConclusion): void;
    replayCompleted: boolean;
    triggerLease?: HostInputLease;
    triggerStarted: boolean;
    abortedAssistant?: unknown;
  } | undefined;
  const mainHostSendLeases = new WeakMap<object, HostInputLease>();
  const sendCheckpointMessage = (
    message: Record<string, unknown>,
    options: Record<string, unknown>,
    inputClass: "restoration-control" | "continuation-trigger",
    onLease?: (lease: HostInputLease) => void,
  ): HostInputLease | undefined => {
    const admission = mainCheckpointGate.hostInputAdmission(inputClass);
    if (admission.kind === "refuse-settling") {
      const controller = mainCheckpointGate.currentController();
      if (inputClass === "restoration-control" &&
          controller.recoveryToken(controller.snapshot().generation)) {
        pi.sendMessage(message, options);
        return undefined;
      }
      throw new Error("checkpoint host send refused while settling");
    }
    if (admission.kind === "inactive") {
      pi.sendMessage(message, options);
      return undefined;
    }
    // Installed Pi creates a fresh outer custom-message wrapper but preserves the
    // exact `details` value. The opaque details object is therefore the authority;
    // content and wrapper identity are deliberately irrelevant.
    const envelope: { piccCheckpointHostInput?: object } = {
      piccCheckpointHostInput: Object.freeze({}),
    };
    message.details = envelope;
    mainHostSendLeases.set(envelope, admission.lease);
    onLease?.(admission.lease);
    try {
      pi.sendMessage(message, options);
      return admission.lease;
    } catch (error) {
      mainHostSendLeases.delete(envelope);
      delete envelope.piccCheckpointHostInput;
      mainCheckpointGate.settleHostInput(admission.lease);
      throw error;
    }
  };
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
  const pluginContextFor = (source: ClaudeSkill["source"]): PluginRuntimeContext | undefined =>
    source.pluginId ? pluginRuntimeContextForSource({ pluginId: source.pluginId }, pluginContexts) : undefined;

  const mainActivation = newSkillActivationState(state.activeSkills);
  const activeSkillDenyRules = mainActivation.denyRules;
  interface MainActivationStage {
    residentSkills: string[];
    renderHashes: Set<string>;
    hookRunners: Map<string, HookRunner>;
  }
  const mainActivationStages = new WeakMap<SkillActivationState, MainActivationStage>();
  const skillHookIdentity = (skill: ClaudeSkill): string => skill.name;

  const stageMainActivation = (): SkillActivationState => {
    const staged = newSkillActivationState(new Map(mainActivation.activeSkills));
    staged.scopedHookSkills = new Set(mainActivation.scopedHookSkills);
    staged.lastRenderHash = new Map(mainActivation.lastRenderHash);
    mainActivationStages.set(staged, {
      residentSkills: [],
      renderHashes: new Set(),
      hookRunners: new Map(),
    });
    return staged;
  };

  const commitMainActivation = (staged: SkillActivationState): void => {
    const delta = mainActivationStages.get(staged);
    if (!delta) return;
    for (const name of delta.residentSkills) {
      const body = staged.activeSkills.get(name);
      if (body !== undefined) recordResidentSkill(mainActivation.activeSkills, name, body);
    }
    mainActivation.denyRules.clear();
    for (const [name, rules] of staged.denyRules) mainActivation.denyRules.set(name, rules);
    for (const name of delta.renderHashes) {
      const hash = staged.lastRenderHash.get(name);
      if (hash !== undefined) mainActivation.lastRenderHash.set(name, hash);
    }
    for (const [identity, runner] of delta.hookRunners) {
      mainActivation.scopedHookSkills.add(identity);
      hooks.addScoped(identity, runner);
    }
  };

  async function activateSkill(
    skill: ClaudeSkill,
    argsText: string,
    opts: { fork?: boolean; activation?: SkillActivationState; cwd?: string } = {},
  ) {
    const activation = opts.activation ?? mainActivation;
    const pluginContext = pluginContextFor(skill.source);
    const rendered = await renderSkillForActivation({
      skill,
      argsText,
      projectRoot: project.root,
      cwd: opts.cwd ?? cwdState.get(),
      sessionId,
      effort: skill.effort ?? config.effort,
      settings: project.settings,
      pluginContext,
      ensurePluginDataDir,
      onRuntimeFinding: retainRuntimeFinding,
    });
    if (!rendered.ok) return rendered;

    if (skill.hooks && Object.keys(skill.hooks).length && !activation.scopedHookSkills.has(skill.name)) {
      activation.scopedHookSkills.add(skill.name);
      const parsed = parseHookConfig(
        skill.hooks,
        skill.source.path,
        pluginContext ? { pluginId: pluginContext.pluginId } : undefined,
      );
      const runner = new HookRunner({
        config: parsed.config,
        projectDir: project.root,
        sessionId,
        env: project.settings.env,
        disableAllHooks: project.settings.disableAllHooks,
        pluginContexts,
        ensurePluginDataDir,
        onRuntimeFinding: retainRuntimeFinding,
        transcriptPath,
      });
      const identity = skillHookIdentity(skill);
      if (activation === mainActivation) hooks.addScoped(identity, runner);
      else {
        const wrapped = activation.wrapHookRunner?.(runner) ?? runner;
        activation.hookRunners.push(wrapped);
        mainActivationStages.get(activation)?.hookRunners.set(identity, wrapped as HookRunner);
      }
    }
    // context:fork bodies go to the fork only. Keeping them resident in the
    // parent would defeat the fork's token-efficiency purpose.
    if (!opts.fork) {
      recordResidentSkill(activation.activeSkills, skill.name, rendered.text);
      mainActivationStages.get(activation)?.residentSkills.push(skill.name);
      activation.denyRules.set(
        skill.name,
        [...(rendered.disallowedTools ?? skill.disallowedTools ?? [])],
      );
    }
    return rendered;
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
    mainActivationStages.get(activation)?.renderHashes.add(skill.name);
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
    headless = false,
  ) {
    const pluginContext = pluginContextFor(skill.source);
    const vars = skillActivationVars({
      skill,
      projectRoot: project.root,
      sessionId,
      effort: skill.effort ?? config.effort,
      pluginContext,
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
      headless,
      agentOverride,
      abortSignal,
    });
  }

  // ---------------------------------------------------------------------------
  // Subagent runtime
  // ---------------------------------------------------------------------------
  const taskToolBundle = createTaskTools();
  const claudeNamedTools: Record<string, unknown>[] = [];
  // Dispatch registry owns canonical retained reports and quarantine; background
  // consumers receive that exact owner in the same production composition.
  const subagentRegistry = new SubagentRegistry();
  const backgroundTasks = new BackgroundTaskRegistry({ registry: subagentRegistry });
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
    stopTask: (taskId, metadata) => {
      if (metadata?.source === "panel") {
        return Promise.resolve(backgroundTasks.stopAndWait(taskId, "panel")).then((result) => {
          if (result.disposition === "confirmed" || result.disposition === "ordinary-cleanup") {
            backgroundTasks.markUserStopped(taskId, "panel");
          }
          return { disposition: result.disposition };
        });
      }
      backgroundTasks.markUserStopped(taskId);
    },
    retainedOutcomes: true,
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
    notebookSession: NotebookSessionSource,
    captureUniversalStop?: () => () => boolean,
    activeOwnedStdioServerNames: () => readonly string[] = () => [],
    onScopedMcpPinWarning?: (warning: string) => void,
  ): Record<string, unknown>[] {
    const get = () => cwdRef.get();
    return [
      createWebFetchTool(get) as unknown as Record<string, unknown>,
      createWebSearchTool(get) as unknown as Record<string, unknown>,
      createClaudeGrepTool(get) as unknown as Record<string, unknown>,
      createGlobTool(get) as unknown as Record<string, unknown>,
      createMultiEditTool(get) as unknown as Record<string, unknown>,
      createNotebookEditTool(get, notebookSession) as unknown as Record<string, unknown>,
      ...(taskBundle.tools as unknown as Record<string, unknown>[]),
      ...createWorktreeTools({
        worktrees,
        cwdState: cwdRef,
        hookRunner: hookRunnerFacade,
        captureUniversalStop,
        ownedStdioServerNames: activeOwnedStdioServerNames,
        onScopedMcpPinWarning,
      }),
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

  function preparePluginAgentOwner(agent: ClaudeAgent): ClaudeAgent {
    const agentContext = pluginContextFor(agent.source);
    const fail = (reason: string, recovery = PLUGIN_RECONCILE_RECOVERY): never => {
      const message = `Agent "${sanitizeLine(agent.name, 128)}" did not start: ${reason}; no provider request was made. ${recovery}.`;
      retainRuntimeFinding(message);
      throw new Error(message);
    };
    if (agent.source.pluginId && !agentContext) {
      fail(`plugin "${sanitizeLine(agent.source.pluginId, 128)}" runtime context is unavailable`);
    }
    if (!agentContext) return agent;

    const projected = projectPluginAgentRuntime(agent, agentContext);
    const effectiveText = [
      agent.body,
      ...(agent.tools ?? []),
      ...(agent.disallowedTools ?? []),
      projected.body,
      ...(projected.tools ?? []),
      ...(projected.disallowedTools ?? []),
    ];
    if (effectiveText.some((text) => /\$\{CLAUDE_PLUGIN_DATA\}|\$CLAUDE_PLUGIN_DATA(?![A-Za-z0-9_])/.test(text))) {
      const prepared = preparePluginDataDir({ userDir: project.userDir, projectRoot: project.root, context: agentContext });
      if (!prepared.ok) {
        fail(`plugin persistent data could not be prepared (${prepared.code})`, pluginDataFailureRecovery(prepared.code));
      }
    }
    return projected;
  }

  function buildSubagentSystemPrompt(
    agent: ClaudeAgent,
    depth = 0,
    diagnosticSink?: (diagnostic: Diagnostic) => void,
  ): string {
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
      const loaded = loadSkillBodyResult(skill);
      if (loaded.failure) {
        const message = `Agent "${sanitizeLine(agent.name, 128)}" omitted preloaded skill "${sanitizeLine(name, 128)}": its plugin body failed lazy path validation. ${PLUGIN_RECONCILE_RECOVERY}.`;
        retainRuntimeFinding(message);
        diagnosticSink?.({ severity: "warning", message, source: skill.source.path });
        continue;
      }
      const skillContext = pluginContextFor(skill.source);
      if (skill.source.pluginId && !skillContext) {
        const message = `Agent "${sanitizeLine(agent.name, 128)}" omitted preloaded skill "${sanitizeLine(name, 128)}": plugin runtime context is unavailable. ${PLUGIN_RECONCILE_RECOVERY}.`;
        retainRuntimeFinding(message);
        diagnosticSink?.({ severity: "warning", message, source: skill.source.path });
        continue;
      }
      if (skillContext && /\$\{CLAUDE_PLUGIN_DATA\}|\$CLAUDE_PLUGIN_DATA(?![A-Za-z0-9_])/.test(loaded.body)) {
        const ensured = ensurePluginDataDir(skillContext, `agent-preloaded skill ${name}`);
        if (!ensured.ok) {
          const message = `Agent "${sanitizeLine(agent.name, 128)}" omitted preloaded skill "${sanitizeLine(name, 128)}": ${ensured.message}.`;
          retainRuntimeFinding(message);
          diagnosticSink?.({ severity: "warning", message, source: skill.source.path });
          continue;
        }
      }
      const skillVars = {
        CLAUDE_SKILL_DIR: skill.baseDir,
        CLAUDE_PROJECT_DIR: skillContext?.projectDir ?? project.root,
        CLAUDE_SESSION_ID: sessionId,
        CLAUDE_EFFORT: agent.effort ?? "",
      };
      const body = skillContext
        ? substitutePluginRuntimeText(loaded.body, skillContext, skillVars)
        : substituteVariables(loaded.body, skillVars);
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

  // MCP runtime: session-global across stdio and remote transports, started
  // non-blocking at load. Declared above allKnownToolNames so dispatch-time
  // closures over MCP state can never hit a TDZ. Model-facing registration
  // happens once in the detached mcpExposure transaction below.
  const mcpRuntime = testSeam?.mcpRuntime ?? McpRuntime.start(project.mcp, {
    projectRoot: project.root,
    sessionId,
    env: process.env,
    settingsEnv: project.settings.env,
  });

  function allKnownToolNames(scope?: AgentMcpScope): string[] {
    const scopedMcpNames = scope
      ? [...scope.knownToolNames()]
      : [
          ...mcpRuntime.tools().map((t) => `mcp__${t.serverName}__${t.toolName}`),
          ...(mcpRuntime.resourceServers().length > 0
            ? [ListMcpResourcesTool, ReadMcpResourceTool]
            : []),
        ];
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
      "NotebookEdit",
      ...DEGRADED_TOOLS.map((d) => d.name),
      // The exact settled dispatch scope supplies its immutable MCP universe;
      // callers without a scope retain the main-session published universe.
      // In that fallback, a registered MCP name over the 64-character model-tool
      // limit may remain permission-matchable after proxy creation drops it, so
      // granting that otherwise valid name is intentionally inert.
      ...scopedMcpNames,
    ];
  }

  // Git-Bash pin for the subagent built-in bash tool (Windows), resolved once and
  // threaded through the deps into the shared factory — same source the main
  // session uses (resolveGitBashPath is cached).
  const subagentBashShellPath = resolveGitBashPath();
  const subagentRuntime = new SubagentRuntime({
    getAgents: () => project.agents,
    prepareAgent: preparePluginAgentOwner,
    buildSystemPrompt: buildSubagentSystemPrompt,
    surfaceHeadlessDiagnostic: createBoundedHeadlessDiagnosticSurface((text) => console.error(text)),
    customToolsFor: (
      agent: ClaudeAgent,
      granted: string[],
      depth: number,
      ownerAgentId: string,
      dispatcherIsFork: boolean,
      subCwd: CwdState | undefined,
      notebookSession: NotebookSessionState,
      activation: SkillActivationState,
      captureUniversalStop?: () => () => boolean,
      mcpContext?: DispatchMcpContext,
    ) => {
      // Per-dispatch instances (fresh TaskStore, dispatch-local cwd binding).
      // NOTE: SendMessage is deliberately NEVER built here — it is
      // parent-initiated only (no subagent→subagent or subagent→parent channel).
      // Even a future "inherit all tools" change must not add it to this set.
      const tools: Record<string, unknown>[] = [];
      for (const tool of buildCwdBoundTools(
        subCwd ?? cwdState,
        createTaskTools(),
        notebookSession,
        captureUniversalStop,
        mcpContext?.activeOwnedStdioServerNames,
        mcpContext?.reportPinWarning,
      )) {
        const name = (tool as { name: string }).name;
        if (granted.includes(name)) tools.push(tool);
      }
      // Fresh per-dispatch MCP proxy instances over the exact settled scope:
      // ToolDefinitions and inline routes are dispatch-local; borrowed routes
      // share only their already-published session transport/client. The same
      // granted-name filter as the cwd-bound tools applies: `granted` already
      // went through gateTools over the MCP-extended universe, so `tools:`
      // restriction (incl. bare `mcp__server` fan-out), `disallowedTools:`, and
      // bare-name deny removal have all been decided by the time we get here.
      const dispatchMcpRuntime = mcpContext?.scope ?? mcpRuntime;
      for (const proxy of buildMcpProxyTools(dispatchMcpRuntime)) {
        if (granted.includes(proxy.name)) tools.push(proxy as unknown as Record<string, unknown>);
      }
      for (const resourceTool of buildMcpResourceTools(dispatchMcpRuntime, {
        clipMaxTokens: config.compaction.clipMaxTokens,
      })) {
        if (granted.includes(resourceTool.name)) {
          tools.push(resourceTool as unknown as Record<string, unknown>);
        }
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
        tools.push(createAgentToolDefinition(subagentRuntime, { depth, name: "Agent", backgroundTasks, ownerAgentId, dispatcherIsFork, dispatchCwd, captureUniversalStop, retainedOutcomes: { registry: subagentRegistry } }));
        tools.push(createAgentToolDefinition(subagentRuntime, { depth, name: "Task", backgroundTasks, ownerAgentId, dispatcherIsFork, dispatchCwd, captureUniversalStop, retainedOutcomes: { registry: subagentRegistry } }));
      }
      return tools;
    },
    validateMcpAgent: (agent) => validateAgentMcpAdmission(agent, project),
    prepareMcpFor: async (agent, spawnCwd, signal) => {
      const declaration = agent.agentMcp;
      const inlineConfig = declaration
        ? project.agentMcpAdmission?.resolve(declaration) ?? { servers: Object.freeze([]), diagnostics: Object.freeze([]), diagnosticOwnership: Object.freeze([]) }
        : { servers: Object.freeze([]), diagnostics: Object.freeze([]), diagnosticOwnership: Object.freeze([]) };
      const scope = await createAgentMcpScope({
        sessionRuntime: mcpRuntime,
        declaration,
        inlineConfig,
        signal,
        inlineDeps: {
          projectRoot: project.root,
          spawnCwd,
          sessionId: `${sessionId}:agent`,
          env: process.env,
          settingsEnv: project.settings.env,
        },
      });

      // One generation-local, globally capped warning is built only from fixed
      // outcome classes and safe identities. Raw config, diagnostics, and enum
      // spellings never become model or renderer content. Published session
      // routes suppress same-identity inline degradation regardless of admission.
      const setupWarning = formatAgentMcpSetupWarning(scope, inlineConfig, declaration);
      return {
        scope,
        setupWarning,
        activeOwnedStdioServerNames: () => scope.activeOwnedStdioServerNames?.() ?? [],
      };
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
        pluginContexts,
        ensurePluginDataDir,
        onRuntimeFinding: retainRuntimeFinding,
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
    compactionCancellationRecovery: {
      registry: subagentRegistry,
      ...(testSeam?.checkpointDeadlinePolicy ? { deadlinePolicy: testSeam.checkpointDeadlinePolicy } : {}),
    },
    // TEST-ONLY seam: an injected fake SDK reaches every dispatch — including
    // forks, which close over this one runtime instance. Read ONLY
    // from the in-process testSeam argument; unset ⇒ the runtime lazy-loads the
    // real Pi SDK (loadRealSdk). Never sourced from env/settings/files.
    ...(testSeam?.sdk ? { sdk: testSeam.sdk } : {}),
  });

  const unconfirmedHostText =
    `PiCC could not confirm that checkpoint host work stopped. ${UNCONFIRMED_HOST_RECOVERY_GUIDANCE}`;
  const restartRequiredText =
    `This authenticated RPC checkpoint cancellation is terminal in the current process. ${RESTART_REQUIRED_RECOVERY_GUIDANCE}`;

  const postCommitFailureText = (stage: CheckpointProgress["stage"]): string => {
    if (stage === "restoration") {
      return "Context was compacted, but mandatory restoration failed before continuation startup was confirmed. Work is paused and no continuation was confirmed to begin.";
    }
    if (stage === "continuation-start") {
      return "Context was compacted, but continuation startup failed. Work is paused and continuation was not confirmed to start.";
    }
    return "Context was compacted, but replay, resumed work, provider release, or cancellation settlement failed. Work is paused; the first continuation or its files, tools, and external effects may already exist, and no second run will start automatically.";
  };

  const checkpointText = (event: CheckpointProgress): string => {
    switch (event.category) {
      case "checkpoint-armed": return event.source === "settled"
        ? "Context checkpoint starting from the settled fallback."
        : event.source === "assistant"
          ? "Context checkpoint queued; waiting for requested tools and safe settlement."
          : "Context checkpoint queued; waiting for safe settlement.";
      case "checkpoint-complete": return event.action === "settled-fallback"
        ? "Context compaction completed."
        : "Context compacted; reconnecting the paused work.";
      case "checkpoint-exhausted": return event.failureCategory === "hook-blocked"
        ? "Automatic context compaction was blocked by a PreCompact hook. Work is paused and no continuation ran. Repair or disable the hook, or allow a manual compact trigger; then run /compact and explicitly continue."
        : event.failureCategory === "restoration-paused"
          ? `${postCommitFailureText(event.stage)} Do not compact the committed summary again; start a new session and resend the retained input.`
          : "Automatic context compaction could not complete. Work is paused and no continuation ran. Run /compact, then explicitly continue.";
      // Each action names a different thing the reader can still do, because for these
      // endings "start a new session" is either impossible or already happening.
      case "checkpoint-cancelled": return event.action === "new-session"
        ? "Proactive context compaction stopped with the old session; resend input in the new session."
        : event.action === "session-ended"
          ? "Proactive context compaction stopped when the session ended. The paused work did not resume and was not delivered."
          : event.action === "restart-process"
            ? unconfirmedHostText
            : event.action === "session-reusable"
              ? "The authenticated resumed cancellation settled and the session is reusable."
              : "Proactive context compaction was cancelled. Run /compact to recover this session, or start a new session.";
      case "checkpoint-recovered": return "Manual compaction recovered the paused session; explicitly continue when ready.";
    }
  };

  const appendCheckpointEntry = (data: Record<string, unknown>): void => {
    try { pi.appendEntry("picc-checkpoint-lifecycle", data); } catch { /* presentation only */ }
  };

  type CheckpointPresentationSeverity = "info" | "warning" | "error";

  const appendCheckpointPresentation = (
    ctx: any,
    notice: string,
    severity: CheckpointPresentationSeverity,
  ): void => {
    if (checkpointSurface(ctx) !== "tui") return;
    try {
      pi.appendEntry("picc-proactive-compact", {
        notice: sanitizeDisplayText(notice, 2_000, true),
        severity,
      });
    } catch { /* presentation only */ }
  };

  /**
   * What a cancelled checkpoint can still do for the reader, decided once. Two refusals ask
   * this — an ordinary prompt and a `/compact` — and when they derived it separately they
   * drifted: the reader's own Esc, still parked on the host join, was told by one that the
   * cancellation was settling and by the other to throw the session away, seconds before
   * PiCC offered `/compact`. Callers decide `manualCompactionDisposition()` first; every
   * state reaching here mints no recovery for this generation.
   */
  type CancelledCheckpointOutlook =
    | "settling" | "settling-committed" | "unconfirmed" | "replaced" | "session-ended";

  const cancelledCheckpointOutlook = (snapshot: CheckpointSnapshot): CancelledCheckpointOutlook =>
    snapshot.cancellationQuiescence === "unconfirmed"
      ? "unconfirmed"
      : snapshot.cancellationKind === "user"
        // A `user` cancellation mints recovery when its join lands — unless the summary is
        // already committed, where the same join terminalizes post-commit instead.
        ? snapshot.cancellationCommitted ? "settling-committed" : "settling"
        : snapshot.cancellationKind === "replacement" ? "replaced" : "session-ended";

  /**
   * Set when Pi is tearing this session down for good. Pi stops the TUI *before* it emits
   * `session_shutdown` ("so extension UI cleanup cannot repaint the final frame"), so from
   * that moment every render verb is a no-op: a notification is painted into a frame that
   * never renders, and text handed back to the editor is discarded with it. Announcements
   * leave through stderr instead, and the transcript must not record a restore that the
   * reader never received.
   */
  let sessionRenderingStopped = false;
  let sessionShutdownBoundary = false;
  let mainShutdownRetainedInputAtRisk = false;
  type CheckpointMode = "tui" | "rpc" | "json" | "print";
  let checkpointModeLatch: Readonly<{ epoch: object; mode: CheckpointMode }> | undefined;

  /**
   * Pi's mode getter becomes unreadable with a stale runner. Bind every readable mode to the
   * current accepted session epoch so terminal publication and handoff cannot downgrade an
   * authenticated RPC checkpoint merely because its final context read throws.
   */
  const readableContextMode = (ctx: any): CheckpointMode | undefined => {
    try {
      const mode = ctx?.mode;
      return mode === "tui" || mode === "rpc" || mode === "json" || mode === "print" ? mode : undefined;
    } catch { return undefined; }
  };

  const checkpointMode = (ctx: any): CheckpointMode | undefined => {
    const mode = readableContextMode(ctx);
    if (mode !== undefined) {
      if (ctx === checkpointContext) checkpointModeLatch = { epoch: checkpointSessionEpoch, mode };
      return mode;
    }
    return checkpointModeLatch?.epoch === checkpointSessionEpoch ? checkpointModeLatch.mode : undefined;
  };

  /** The surface a checkpoint announcement can still reach, which is not always `ctx.mode`. */
  const checkpointSurface = (ctx: any): string | undefined => {
    const mode = checkpointMode(ctx);
    return mode === "tui" && sessionRenderingStopped ? "stderr" : mode;
  };

  const textFromQueuedContent = (content: import("./runtime/mid-run-compaction.js").QueueContent): string | undefined => {
    if (typeof content === "string") return content;
    const text: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text" ||
          typeof (part as { text?: unknown }).text !== "string") return undefined;
      text.push((part as { text: string }).text);
    }
    return text.join("");
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
    // Never the editor once the renderer is stopped: `setEditorText` still returns, so
    // taking that branch would persist `restoredTextCount: 1` for text the reader was never
    // handed back — a record that says the loss was repaired when it was not.
    const surface = checkpointSurface(ctx);
    if (surface === "tui") {
      try {
        if (representable.length && typeof ctx.ui?.setEditorText === "function") {
          const draft = String(ctx.ui?.getEditorText?.() ?? "");
          ctx.ui.setEditorText(`${representable.join("\n")}\n${draft}`);
          restoredTextCount = representable.length;
        }
        guidance = `${rejected.length} queued input${rejected.length === 1 ? " was" : "s were"} not replayed; ${restoredTextCount} text input${restoredTextCount === 1 ? " was" : "s were"} restored${representable.length > restoredTextCount || unrepresentable ? "; remaining input must be resent" : ""}.`;
      } catch {
        restoredTextCount = 0;
        guidance = `${rejected.length} queued input${rejected.length === 1 ? " was" : "s were"} not replayed. Resend ${representable.length} text input${representable.length === 1 ? "" : "s"}${unrepresentable ? ` and ${unrepresentable} image/unrepresentable input${unrepresentable === 1 ? "" : "s"}` : ""}.`;
      }
      appendCheckpointPresentation(
        ctx,
        guidance,
        representable.length > restoredTextCount || unrepresentable ? "warning" : "info",
      );
    } else if (surface === "print" || surface === "stderr") {
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

  const rejectOrdinaryInput = (
    inputDisposition: Exclude<OrdinaryInputDisposition, "accept" | "quarantine">,
    event: any,
    ctx: any,
  ): void => {
    const controller = mainCheckpointGate.currentController();
    const cancelledText = (): string => {
      const snapshot = controller.snapshot();
      if (snapshot.failureCategory === "restart-required") return restartRequiredText;
      if (snapshot.failureCategory === "unconfirmed-host") return unconfirmedHostText;
      switch (cancelledCheckpointOutlook(snapshot)) {
        case "unconfirmed": return unconfirmedHostText;
        case "settling":
          return "Checkpoint cancellation is still settling. Wait before sending another prompt or attempting recovery.";
        case "settling-committed":
          return "Checkpoint cancellation is still settling, and this session's summary is already committed, so it will not become recoverable. Do not compact it again; start a new session and resend this input.";
        case "replaced":
          return "The prior checkpoint was cancelled with the session it belonged to and cannot be recovered here. Resend this input in the new session.";
        case "session-ended":
          return "The prior checkpoint stopped when the session it belonged to ended, and cannot be recovered here. The paused work did not resume and was not delivered.";
      }
    };
    const text = inputDisposition === "reject-recoverable"
      ? "Work remains paused. Run /compact, then explicitly continue."
      : inputDisposition === "reject-restoration"
        ? "The compacted summary is committed, but restoration or continuation failed. Do not compact it again; start a new session and resend the retained input."
        : inputDisposition === "reject-stopped"
          ? "The stopped run is still terminating. Wait for it to settle before sending another prompt."
          : controller.manualCompactionDisposition() === "allow"
            ? "The prior checkpoint was cancelled. Run /compact to recover this session, or start a new session."
            : cancelledText();
    if (controller.isProcessTerminal()) {
      appendCheckpointEntry({
        category: "checkpoint-admission-refused",
        action: "restart-process",
        notice: text,
      });
    }
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
  };

  type ResumedCancellationOutcome = {
    controller: MidRunCompactionController;
    sessionEpoch: object;
    generation: number;
    stage: "resumed-cancellation";
    sessionDisposition: "reusable" | "terminal" | "restart-required";
    restoredCount: number;
    reportedCount: number;
    unresolvedCount: number;
    nonTextCount: number;
  };
  let resumedCancellationOutcome: ResumedCancellationOutcome | undefined;

  const publishCheckpoint = (event: CheckpointProgress, ctx = checkpointContext): void => {
    const progressController = mainCheckpointGate.currentController();
    if (mainCheckpointGate.isLogicalRunStopped() &&
        mainCheckpointGate.stoppedRunMatches(progressController, event.generation)) {
      resumedCancellationOutcome = undefined;
      return;
    }
    const mode = checkpointMode(ctx);
    // `stderr` is the TUI once Pi has stopped it: the ending still has to reach the reader,
    // and their scrollback is what survives the teardown.
    const surface = mode === "tui" && sessionRenderingStopped ? "stderr" : mode;
    const baseText = checkpointText(event);
    // Every headless exhaustion is rephrased, the post-commit one included: it is the
    // ending most likely to hit a one-shot `picc -p`, and the TUI wording ("start a new
    // session") describes an affordance a headless caller does not have.
    const headlessExhaustion = event.category === "checkpoint-exhausted" && mode !== "tui";
    const postCommit = event.failureCategory === "restoration-paused";
    const session = transcriptPath();
    const persisted = session !== undefined;
    const headlessCause = postCommit
      ? postCommitFailureText(event.stage)
      : event.failureCategory === "hook-blocked"
        ? "Automatic context compaction was blocked by a PreCompact hook. Work is paused and no continuation ran. Repair or disable the hook, or allow a manual compact trigger first."
        : "Automatic context compaction could not complete. Work is paused and no continuation ran.";
    const recoverableHere = !postCommit && (persisted || mode === "rpc");
    const recoveryGuidance = postCommit
      ? "Do not compact the committed summary again. This session cannot continue the paused work; start a replacement session and resend the retained input."
      : mode === "rpc"
        ? "This live RPC session can run /compact, then explicitly continue. RPC acknowledgements are uncorrelated."
        : persisted
          ? `If this process exits, reopen the exact persisted session (${session}) before /compact. Run /compact, then explicitly continue.`
          : "This headless session is ephemeral and cannot be reopened; start a replacement session and resend the retained input.";
    const candidateCancellationOutcome = resumedCancellationOutcome;
    const cancellationOutcome = event.category === "checkpoint-cancelled" &&
      candidateCancellationOutcome?.controller === progressController &&
      candidateCancellationOutcome.sessionEpoch === checkpointSessionEpoch &&
      candidateCancellationOutcome.generation === event.generation
      ? candidateCancellationOutcome : undefined;
    if (candidateCancellationOutcome && cancellationOutcome === undefined) {
      resumedCancellationOutcome = undefined;
    }
    const presentedAction = cancellationOutcome
      ? cancellationOutcome.sessionDisposition === "reusable" ? "session-reusable"
        : cancellationOutcome.sessionDisposition === "restart-required" ? "restart-process"
          : "retrieve-and-relaunch"
      : event.action;
    const retainedSource = "client/request history";
    const text = cancellationOutcome
      ? cancellationOutcome.sessionDisposition === "restart-required"
        ? `Authenticated resumed cancellation was observed, but live RPC recovery is unsupported: action=${presentedAction}, stage=${cancellationOutcome.stage}, ${cancellationOutcome.restoredCount} restored, ${cancellationOutcome.reportedCount} reported, ${cancellationOutcome.unresolvedCount} unresolved, ${cancellationOutcome.nonTextCount} non-text. The first resumed continuation and native queued input may already have produced later turns, files, tool calls, or external effects. Recover retained input from ${retainedSource}, inspect client/request history and effects, then terminate PiCC and start a fresh process and fresh session; do not deliberately resubmit in this RPC session.`
        : cancellationOutcome.sessionDisposition === "reusable"
          ? `Authenticated resumed cancellation settled: action=${presentedAction}, stage=${cancellationOutcome.stage}, ${cancellationOutcome.restoredCount} restored, ${cancellationOutcome.reportedCount} reported, ${cancellationOutcome.unresolvedCount} unresolved, ${cancellationOutcome.nonTextCount} non-text. No additional continuation or retained-input replay was started after cancellation. The first resumed continuation had already started, so prior files, tools, or external effects may exist; inspect them before deliberate resubmission.`
          : `Authenticated resumed cancellation settled after the session became non-reusable: action=${presentedAction}, stage=${cancellationOutcome.stage}, ${cancellationOutcome.restoredCount} restored, ${cancellationOutcome.reportedCount} reported, ${cancellationOutcome.unresolvedCount} unresolved, ${cancellationOutcome.nonTextCount} non-text. The first resumed continuation had already started, so files, tools, or external effects may exist. Recover retained input from ${retainedSource}, inspect possible effects, then make a deliberate resubmission in a fresh request/session; this session cannot be reused.`
      : headlessExhaustion ? `${headlessCause} ${recoveryGuidance}` : baseText;
    if (surface === "tui") {
      try {
        if (event.category === "checkpoint-armed") {
          ctx.ui?.notify?.(text, "info");
        } else if (event.category === "checkpoint-exhausted") {
          appendCheckpointPresentation(ctx, text, "error");
        } else if (event.category === "checkpoint-cancelled") {
          // Terminal cancellation needs a visible chat outcome. `restart-process` is an
          // error because the session is unusable.
          appendCheckpointPresentation(ctx, text, event.action === "restart-process" ? "error" : "warning");
        } else if (event.category === "checkpoint-recovered") {
          appendCheckpointPresentation(ctx, text, "info");
        }
      } catch {
        // Presentation cannot own checkpoint state.
      }
    } else if (surface === "print" || surface === "stderr") {
      console.error(`PiCC: ${text}`);
    }
    if (mode === "json" || mode === "rpc" || event.category === "checkpoint-exhausted" || cancellationOutcome) {
      appendCheckpointEntry({
        category: event.category,
        generation: event.generation,
        notice: text,
        ...(presentedAction === undefined ? {} : { action: presentedAction }),
        ...(event.stage === undefined ? {} : { stage: event.stage }),
        ...(cancellationOutcome ? {
          restoredCount: cancellationOutcome.restoredCount,
          reportedCount: cancellationOutcome.reportedCount,
          unresolvedCount: cancellationOutcome.unresolvedCount,
          nonTextCount: cancellationOutcome.nonTextCount,
          retainedInputSource: cancellationOutcome.sessionDisposition === "reusable"
            ? "restored editor"
            : "client/request history",
        } : {}),
        ...(event.failureCategory === undefined ? {} : { failureCategory: event.failureCategory }),
        ...(event.category === "checkpoint-exhausted" ? {
          recovery: event.failureCategory === "restoration-paused"
            ? "start a new session and resend retained input; do not compact the committed summary again"
            : !recoverableHere
              ? "start a replacement session and resend retained input; this ephemeral session cannot be reopened"
              : event.failureCategory === "hook-blocked"
                ? "repair or disable the hook, or allow manual compaction; then run /compact and explicitly continue"
                : "/compact, then explicitly continue",
        } : {}),
      });
    }
    // A non-interactive caller must be able to tell "finished" from a partial or abandoned
    // checkpoint outcome without reading prose. Terminal resumed cancellation may follow
    // started work and effects, so a wrapper that only saw Pi's own status must not consume
    // the partial answer as success. Never in the TUI, where the reader sees the notice.
    // Not cleared by later recovery: the process still gave up on that checkpoint outcome.
    //
    // Named modes rather than "not the TUI", with one deliberate exception: a mode that
    // could not be read at all (a stale runner throws) still sets it, because a give-up
    // whose notice could not be delivered is exactly when a caller has nothing but the
    // status left — and Pi's interactive quit calls `process.exit(0)` explicitly, so a
    // status set from a stale TUI context cannot leak out of an interactive run.
    if ((mode === "print" || mode === "json" || mode === "rpc" || mode === undefined ||
          cancellationOutcome?.sessionDisposition === "terminal") &&
        (event.category === "checkpoint-exhausted" || event.category === "checkpoint-cancelled")) {
      process.exitCode = CHECKPOINT_GAVE_UP_EXIT_CODE;
    }
    if (cancellationOutcome) resumedCancellationOutcome = undefined;
  };

  const cancelledMainInput = async (
    handoff: CancelledInputHandoff,
  ): Promise<CancelledInputResolution> => {
    const ctx = checkpointContext;
    const handoffController = mainCheckpointGate.currentController();
    const handoffSessionEpoch = checkpointSessionEpoch;
    const mode = checkpointSurface(ctx);
    const resolutions = new Map<number, "restored" | "reported" | "unresolved">(
      handoff.retained.map((shadow) => [shadow.id, "unresolved"]),
    );
    const textById = new Map<number, string>();
    for (const shadow of handoff.retained) {
      const text = textFromQueuedContent(shadow.content);
      if (text !== undefined) textById.set(shadow.id, text);
    }
    const acceptedIds = new Set(handoff.acceptedToHostIds);
    const acceptedText = (["steer", "followUp"] as const).flatMap((delivery) => handoff.retained
      .filter((shadow) => acceptedIds.has(shadow.id) && shadow.delivery === delivery)
      .map((shadow) => textById.get(shadow.id))
      .filter((text): text is string => text !== undefined));
    let editorCustody = false;
    if (mode === "tui" && typeof ctx?.ui?.getEditorText === "function" &&
        typeof ctx?.ui?.setEditorText === "function") {
      try {
        const restored = String(ctx.ui.getEditorText());
        const prefix = acceptedText.join("\n\n");
        const priorDraft = prefix.length === 0
          ? restored
          : restored === prefix ? "" : restored.startsWith(`${prefix}\n\n`) ? restored.slice(prefix.length + 2) : undefined;
        if (priorDraft !== undefined) {
          const steering = handoff.retained.filter((shadow) => shadow.delivery === "steer")
            .map((shadow) => textById.get(shadow.id)).filter((text): text is string => text !== undefined);
          const followUp = handoff.retained.filter((shadow) => shadow.delivery === "followUp")
            .map((shadow) => textById.get(shadow.id)).filter((text): text is string => text !== undefined);
          ctx.ui.setEditorText([...steering, ...followUp, ...(priorDraft ? [priorDraft] : [])].join("\n\n"));
          editorCustody = true;
          for (const id of textById.keys()) resolutions.set(id, "restored");
        }
      } catch {
        editorCustody = false;
      }
    }
    const sessionDisposition: ResumedCancellationOutcome["sessionDisposition"] =
      mode === "tui" ? "reusable" : mode === "rpc" ? "restart-required" : "terminal";
    let reportCustody = false;
    try {
      // At every active shutdown boundary append acceptance is only prospective:
      // it cannot prove that the outgoing main report survives. A still-live non-quit
      // TUI editor may independently retain exact text, but not non-text occurrences.
      if (sessionShutdownBoundary) throw new Error("durable shutdown sink required");
      pi.appendEntry("picc-checkpoint-retained-input", {
        version: 1,
        sessionId: handoff.sessionId,
        generation: handoff.generation,
        stage: "resumed-cancellation",
        occurrences: handoff.retained.map((shadow) => ({
          id: shadow.id, mode: shadow.delivery, content: shadow.content,
        })),
        restoredTextCount: editorCustody ? textById.size : 0,
        nonTextCount: handoff.retained.length - textById.size,
        notice: sessionDisposition === "restart-required"
          ? "Retained input may still exist in Pi's native RPC queues. This custom entry is a non-locator hint, not verified persistence. Retrieve accepted input from client/request history, inspect possible existing files, tools, and external effects, then terminate PiCC and start a fresh process and fresh session; do not resubmit in this RPC session."
          : sessionDisposition === "terminal"
            ? "Retained input was not auto-replayed. This custom entry is a non-locator hint, not verified persistence. Recover accepted input from client/request history, inspect possible existing files, tools, and external effects, then deliberately relaunch if appropriate."
            : "Retained input was not auto-replayed. This custom entry is a non-locator session hint. Inspect possible existing files, tools, and external effects before deliberate resubmission.",
      });
      reportCustody = true;
    } catch {
      reportCustody = false;
    }
    if (reportCustody) {
      for (const shadow of handoff.retained) {
        if (resolutions.get(shadow.id) === "unresolved") resolutions.set(shadow.id, "reported");
      }
    }
    const restoredCount = [...resolutions.values()].filter((value) => value === "restored").length;
    const reportedCount = [...resolutions.values()].filter((value) => value === "reported").length;
    const unresolvedCount = handoff.retained.length - restoredCount - reportedCount;
    if (sessionShutdownBoundary && unresolvedCount > 0) mainShutdownRetainedInputAtRisk = true;
    resumedCancellationOutcome = {
      controller: handoffController,
      sessionEpoch: handoffSessionEpoch,
      generation: handoff.generation,
      stage: "resumed-cancellation",
      sessionDisposition,
      restoredCount,
      reportedCount,
      unresolvedCount,
      nonTextCount: handoff.retained.length - textById.size,
    };
    return {
      sessionId: handoff.sessionId,
      generation: handoff.generation,
      token: handoff.token,
      sessionDisposition,
      resolutions: handoff.retained.map((shadow) => ({ id: shadow.id, disposition: resolutions.get(shadow.id)! })),
    };
  };

  mainCheckpointGate.attachExecution({
    progress: publishCheckpoint,
    // The controller drains a terminal generation's queue and hands it here; nothing
    // else names those shadows, so this is the single reporter for every ending.
    inputDropped: (rejected) => reportRejectedShadows(rejected, checkpointContext),
    cancelledInput: cancelledMainInput,
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
        }, signal, testSeam?.checkpointDeadlinePolicy);
      } finally {
        signal.removeEventListener("abort", abortHost);
        controller.endCompactionSummary(summary);
        if (activeCompactionOperation?.identity === attempt.operation) {
          activeCompactionOperation = undefined;
        }
        if (checkpointAttempt === attempt) checkpointAttempt = undefined;
      }
    },
    resume: (resumeContext) => {
      const ctx = checkpointContext;
      const owner = mainCheckpointGate.currentController();
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
      let concluded: ResumeConclusion | undefined;
      /**
       * The single publisher of this run's settlement. Every ending goes through it,
       * so no exit can settle the local wait while leaving the provider barrier
       * pending, or unpark a waiter while leaving the controller in `resuming` with
       * its generation barrier unpublished.
       */
      const conclude = (conclusion: ResumeConclusion): void => {
        if (concluded) return;
        concluded = conclusion;
        if (conclusion === "completed") {
          // Success is claimed here and nowhere else, and only for a turn that ran.
          owner.resumedSettled(resumeContext.token);
          openProvider();
        } else if (conclusion === "cancelled") {
          owner.resumedSettled(resumeContext.token, "cancelled");
          rejectProvider(new Error("checkpoint resume cancelled"));
        } else {
          // `defensiveLatch` captured the promise itself, so dropping the gate's
          // reference is not enough — the barrier has to be settled as well.
          rejectProvider(new Error(`checkpoint resume ${conclusion}`));
        }
        // Every ending withdraws the gate's reference, success included: an open
        // barrier that outlives its run is a latch `defensiveLatch` would wake from
        // and re-authenticate against a still-`resuming` phase, granting transport to
        // a run that has already settled. (Reachable only when `replayComplete` never
        // ran, so it is a hazard rather than an observed defect.)
        mainCheckpointGate.clearResumeBarrier(resumeContext.generation, providerBarrier);
        resolveSettled();
        if (activeMainResume === resume) activeMainResume = undefined;
        // Resume only ever runs after the summary committed, so work that cannot be
        // delivered is a post-commit failure: terminal, no recovery token, and never
        // recompactable. This also publishes the generation barrier the settling
        // agent_settled handler is parked on. Keep it last: terminalization re-enters
        // cancelAndJoin, which joins the `settled` resolved above. Today that
        // re-entrancy is void-ed rather than awaited, so the ordering is a guard
        // against a future awaited terminalization rather than a present necessity.
        if (conclusion === "abandoned" && mainCheckpointGate.currentController() === owner &&
            owner.snapshot().generation === resumeContext.generation) {
          void owner.failAfterCommittedSummary(resumeContext.generation, "resumed-work").catch(() => undefined);
        }
      };
      activeMainResume = {
        generation: resumeContext.generation,
        token: resumeContext.token,
        epoch: checkpointSessionEpoch,
        context: ctx,
        signal: resumeContext.signal,
        requestCancellation: resumeContext.requestCancellation,
        settled,
        // The continuation below is delivered with `triggerTurn`, which reaches Pi's
        // agent run whose settlement is always announced — but only while Pi is not
        // streaming; a streaming session queues it as steering instead and starts no
        // turn. That precondition holds here because resume is driven from inside
        // `agent_settled`, which Pi emits after clearing its run-active flag.
        settlementOwned: true,
        joinParked: false,
        conclude,
        replayCompleted: false,
        triggerStarted: false,
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
        if (!resumeContext.advancePostCommitStage("continuation-start")) {
          throw new Error("checkpoint continuation lost stage authority");
        }
        sendCheckpointMessage(
          {
            customType: "picc-checkpoint-continuation",
            content: "Continue the paused work.",
            display: false,
          },
          { triggerTurn: true },
          "continuation-trigger",
          (lease) => { resume.triggerLease = lease; },
        );
      } catch (error) {
        if (resume.triggerLease) mainCheckpointGate.settleHostInput(resume.triggerLease);
        // resumeOrFinish turns this throw into the post-commit terminal, so publish
        // the settlement without claiming a second one here.
        conclude("superseded");
        throw error;
      }
      return {
        replay: (input: any) => {
          mainCheckpointGate.withReplayAuthorization(input, () => {
            pi.sendUserMessage(input.content as any, { deliverAs: input.delivery });
          });
          // Pi's void return proves enqueue/admission only. The controller keeps
          // custody until the matching authenticated message_start confirms host start.
          return { delivered: true, pendingHostStart: true } as const;
        },
        replayComplete: () => {
          if (!isCurrent() || resume.replayCompleted) {
            throw new Error("checkpoint resume cannot release the provider twice");
          }
          resume.replayCompleted = true;
          openProvider();
          const text = "Context compacted; resumed the paused work.";
          const mode = readableContextMode(ctx);
          if (mode === "print") console.error(`PiCC: ${text}`);
          else if (mode === "json" || mode === "rpc") {
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
          // Publish the park BEFORE sampling ownership: the Stop-continuation
          // hand-off clears ownership and then reads this flag, so the two orders
          // interlock and whichever runs second concludes. Sampling first would let a
          // hand-off that lands between this read and the await strand the join.
          resume.joinParked = true;
          // Join a settlement only while someone is still obliged to publish it.
          // After the hand-off nobody is: Pi can drop that continuation with no turn
          // and no event, so waiting here is what turns a dropped continuation into a
          // session that can never be replaced.
          if (!resume.settlementOwned) conclude("abandoned");
          await settled;
          if (activeMainResume === resume) activeMainResume = undefined;
          if (!resume.triggerStarted) return { ending: "pre-start" as const };
          if (resume.abortedAssistant) return { ending: "aborted" as const };
          return undefined;
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
      getActiveNotebookState: () => activeMainNotebookState,
      subagentPanel,
      subagentPanelFocus,
      mainCheckpointGate,
      mcpRuntime,
      inputHooks: hooks,
    });
  } catch (err) {
    console.error(`PiCC test seam onWired failed: ${(err as Error).message}`);
  }

  // ---------------------------------------------------------------------------
  // Tool registration
  // ---------------------------------------------------------------------------
  const getCwd = () => cwdState.get();
  claudeNamedTools.push(...buildCwdBoundTools(
    cwdState,
    taskToolBundle,
    () => activeMainNotebookState,
    () => mainCheckpointGate.captureLogicalRunStop(),
  ));

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
      headless?: boolean;
      activation?: SkillActivationState;
      cwd?: string;
    },
  ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
    const invokedCollision = opts.invokedName.trim().toLowerCase();
    if (PLUGIN_CONTROL_NAMES.has(invokedCollision)) {
      throw new Error(
        `Built-in /${invokedCollision} owns this reserved plugin-management name; no skill activation occurred. Use the explicit namespaced skill name if you intended plugin content.`,
      );
    }
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
      if (!rendered.ok) throw new Error(rendered.message);
      const result = await forkDispatch(
        skill,
        rendered.text,
        opts.depth + 1,
        argsText,
        opts.signal,
        opts.headless,
      );
      // Forks are non-resumable: suppress every resume trailer. The shared
      // presenter reproduces the Agent tool's four-branch mapping —
      // failed-with-partial preserves the partial + names the cause;
      // failed-no-output and aborted surface as loud failures (distinct wording);
      // completed stays the verbatim final message.
      const p = presentDispatchResult(result, { allowResumeTrailer: false });
      if (p.kind === "failure") throw new Error(p.message);
      return {
        content: [{ type: "text", text: p.text }],
        details: {
          forked: true,
          agent: result.agentName,
          cutOff: p.cutOff,
          diagnostics: result.diagnostics,
        },
      };
    }
    const rendered = await activateSkill(skill, argsText, {
      activation: opts.activation,
      cwd: opts.cwd,
    });
    if (!rendered.ok) throw new Error(rendered.message);
    const note = skillDedupNote(skill, rendered.text, opts.activation);
    if (note) {
      return {
        content: [{ type: "text", text: note }],
        details: { skill: skill.name, deduplicated: true },
      };
    }
    return {
      content: [{ type: "text", text: skillActivationMessage(skill, rendered.text) }],
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
        _onUpdate?: unknown,
        ctx?: { mode?: "tui" | "print" | "json" | "rpc" },
      ) {
        const requested = params.name.trim().toLowerCase();
        if (PLUGIN_CONTROL_NAMES.has(requested)) {
          throw new Error(
            `Built-in /${requested} owns this reserved plugin-management name; no skill activation occurred. Use the explicit namespaced skill name if you intended plugin content.`,
          );
        }
        // findByName resolves plugin-namespaced skills by bare name when unique.
        const skill = findByName(project.skills, params.name);
        if (!skill) throw new Error(`Unknown skill: ${params.name}`);
        return runSkillActivation(skill, params.arguments ?? "", {
          forSubagent: opts.forSubagent,
          depth: opts.depth,
          invokedName: params.name,
          signal,
          headless: ctx?.mode !== "tui",
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
      async execute(
        _id: string,
        params: { command: string },
        signal?: AbortSignal,
        _onUpdate?: unknown,
        ctx?: { mode?: "tui" | "print" | "json" | "rpc" },
      ) {
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
          headless: ctx?.mode !== "tui",
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
      createAgentToolDefinition(subagentRuntime, { depth: 0, name: "Agent", backgroundTasks, captureUniversalStop: () => mainCheckpointGate.captureLogicalRunStop(), retainedOutcomes: { registry: subagentRegistry } }),
      createAgentToolDefinition(subagentRuntime, { depth: 0, name: "Task", backgroundTasks, captureUniversalStop: () => mainCheckpointGate.captureLogicalRunStop(), retainedOutcomes: { registry: subagentRegistry } }),
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
      // The checkpoint gate stays outside presentation; subagent `customToolsFor` skips both.
      pi.registerTool(mainCheckpointGate.wrapTool(routeMainSessionTool(
        tool as unknown as ToolDefinition,
        { resolveDisplayRoot: getCwd, repositoryRoot: project.root },
      ) as unknown as Record<string, unknown>));
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
  // The promise is captured so ordinary input and the observational test seam await
  // the same built-in registration settlement.
  const coreToolNames = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);
  type BuiltInReadiness =
    | { ok: true }
    | { ok: false; cause: string; possiblePartialCommit: boolean; cleanup: string; cleanupVerified: boolean };
  const boundedCause = (value: unknown): string => {
    let candidate: unknown = value;
    try {
      if (value instanceof Error) candidate = value.message;
    } catch {
      candidate = undefined;
    }
    let text = "unknown error";
    try {
      if (typeof candidate === "string") text = candidate;
      else if (candidate !== undefined) text = String(candidate);
    } catch { /* keep the bounded fallback */ }
    try {
      return text.slice(0, 1_000).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ") || "unknown error";
    } catch {
      return "unknown error";
    }
  };
  let builtInFailureDetailed = false;
  let builtInAdmissionFailed = false;
  const removeCoreFromActiveSet = (): { cleanup: string; cleanupVerified: boolean } => {
    try {
      const retained = pi.getActiveTools().filter((name: string) => !coreToolNames.has(name));
      pi.setActiveTools(retained);
      const remaining = pi.getActiveTools().filter((name: string) => coreToolNames.has(name));
      return remaining.length === 0
        ? { cleanup: "fixed core names removed from the active set", cleanupVerified: true }
        : { cleanup: `cleanup verification failed (${remaining.join(", ")} remain active)`, cleanupVerified: false };
    } catch (cleanupError) {
      return { cleanup: `active-set cleanup failed: ${boundedCause(cleanupError)}`, cleanupVerified: false };
    }
  };
  const builtInRegistration: Promise<BuiltInReadiness> = (async (): Promise<BuiltInReadiness> => {
    let registrationBegan = false;
    try {
      const sdk: any = await (testSeam?.loadBuiltinSdk?.() ?? import("@earendil-works/pi-coding-agent"));
      // Pin the shell to real Git Bash on Windows — Pi's default `bash` lookup can
      // land on the System32 WSL stub (WSL_E_DEFAULT_DISTRO_NOT_FOUND without a distro).
      const shellPath = resolveGitBashPath();
      const builtins = buildStockBuiltinTools(sdk as BuiltinToolSdk, cwdState, {
        settingsEnv: project.settings.env ?? {},
        projectRoot: project.root,
        ...(shellPath ? { shellPath } : {}),
        notebookSession: () => activeMainNotebookState,
      });
      // Construction, presentation, and the one outer execute wrapper all finish before
      // registration starts. Pi has no public rollback if a later registerTool throws.
      const prepared = builtins.map(({ def }) => {
        const rendered = routeMainSessionTool(
          def as unknown as ToolDefinition,
          {
            resolveEditRenderCwd: getCwd,
            resolveDisplayRoot: getCwd,
            repositoryRoot: project.root,
          },
        ) as unknown as Record<string, unknown>;
        return mainCheckpointGate.wrapTool(rendered);
      });
      registrationBegan = true;
      for (const definition of prepared) pi.registerTool(definition);
      if (shellPath && typeof sdk.createLocalBashOperations === "function") {
        pi.on("user_bash", () => ({ operations: sdk.createLocalBashOperations({ shellPath }) }));
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        cause: boundedCause(err),
        possiblePartialCommit: registrationBegan,
        ...removeCoreFromActiveSet(),
      };
    }
  })().catch((): BuiltInReadiness => ({
    ok: false,
    cause: "unknown error",
    possiblePartialCommit: true,
    cleanup: "readiness settlement failed before cleanup could be verified",
    cleanupVerified: false,
  }));

  // ---------------------------------------------------------------------------
  // MCP exposure transaction (detached; input and first-turn barriers await it)
  // ---------------------------------------------------------------------------
  let mcpPromptCatalog: McpPromptCatalog = buildMcpPromptCatalog([], []);
  let mcpExposureFailure: string | undefined;
  const failedPromptMarker = "picc_failed_prompt_discovery";
  const failedPromptRecordLimit = 8;
  const failedPromptMessageNameLimit = 3;
  const mcpPromptRecoveryGuidance = "Check the server configuration and logs, then restart PiCC.";
  type FailedPromptNamespace = Readonly<{ commandPrefix: string; server: string }>;
  let failedPromptNamespaces: Readonly<{
    records: readonly FailedPromptNamespace[];
    omittedCount: number;
  }> = Object.freeze({ records: Object.freeze([]), omittedCount: 0 });

  function failedPromptNamespace(serverName: string): FailedPromptNamespace | undefined {
    const synthetic = buildMcpPromptCatalog([{
      serverName,
      promptName: failedPromptMarker,
      description: "",
      arguments: [],
    }], []).commands[0];
    if (!synthetic) return undefined;
    const suffix = `__${failedPromptMarker}`;
    if (!synthetic.name.endsWith(suffix)) return undefined;
    const commandPrefix = synthetic.name.slice(0, -failedPromptMarker.length);
    const server = synthetic.name.slice("mcp__".length, -suffix.length);
    return Object.freeze({ commandPrefix, server });
  }

  function boundedPromptRecoveryMessage(prefix: string): string {
    const tail = ` ${mcpPromptRecoveryGuidance}`;
    const prefixBudget = Math.max(1, 1_200 - Array.from(tail).length);
    return `${boundedMcpErrorText(prefix, prefixBudget)}${tail}`;
  }

  function promptDiscoveryFailureMessage(record?: FailedPromptNamespace): string {
    if (record) {
      return boundedPromptRecoveryMessage(`MCP prompt discovery failed for server ${record.server}.`);
    }
    const shown = failedPromptNamespaces.records.slice(0, failedPromptMessageNameLimit);
    const omitted = failedPromptNamespaces.omittedCount + failedPromptNamespaces.records.length - shown.length;
    const subject = shown.length === 0
      ? "one or more servers"
      : `${shown.map((entry) => entry.server).join(", ")}${
        omitted > 0 ? ` and ${omitted} other${omitted === 1 ? "" : "s"}` : ""
      }`;
    return boundedPromptRecoveryMessage(`MCP prompt discovery failed for servers ${subject}.`);
  }

  function mcpPromptReservedNames(): Set<string> {
    const names = new Set<string>([...piBuiltinNames, ...controlCommands.keys()]);
    const suffixCounts = new Map<string, number>();
    for (const skill of project.skills) {
      if (!isTypedSlashInvocable(skill)) continue;
      names.add(skill.name);
      const colon = skill.name.lastIndexOf(":");
      if (colon >= 0) {
        const suffix = skill.name.slice(colon + 1);
        suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
      }
    }
    for (const skill of project.skills) {
      if (!isTypedSlashInvocable(skill)) continue;
      const colon = skill.name.lastIndexOf(":");
      if (colon >= 0) {
        const suffix = skill.name.slice(colon + 1);
        if (suffixCounts.get(suffix) === 1) names.add(suffix);
      }
    }
    return names;
  }

  const mcpExposure = (async () => {
    try {
      await mcpRuntime.whenSettled();
      mcpPromptCatalog = buildMcpPromptCatalog(mcpRuntime.prompts(), mcpPromptReservedNames());
      const failedRecords: FailedPromptNamespace[] = [];
      const retainedPrefixes = new Set<string>();
      let omittedFailedServers = 0;
      for (const state of mcpRuntime.serverStates()) {
        if (state.promptsAdvertised !== true || state.promptDiscoveryError === undefined) continue;
        const record = failedPromptNamespace(state.name);
        if (
          !record || retainedPrefixes.has(record.commandPrefix) ||
          failedRecords.length >= failedPromptRecordLimit
        ) {
          omittedFailedServers += 1;
          continue;
        }
        retainedPrefixes.add(record.commandPrefix);
        failedRecords.push(record);
      }
      failedPromptNamespaces = Object.freeze({
        records: Object.freeze(failedRecords),
        omittedCount: omittedFailedServers,
      });
      for (const diag of [...mcpRuntime.diagnostics(), ...mcpPromptCatalog.diagnostics]) {
        console.error(`PiCC: MCP: ${diag}`);
      }

      const definitions: ToolDefinition<any, any>[] = [...buildMcpProxyTools(mcpRuntime)];
      if (mcpRuntime.resourceServers().length > 0) {
        definitions.push(...buildMcpResourceTools(mcpRuntime, {
          clipMaxTokens: config.compaction.clipMaxTokens,
        }));
      }
      const admitted = new Set(
        permissionEngine.gateTools(undefined, undefined, definitions.map((tool) => tool.name)),
      );
      for (const definition of definitions) {
        if (!admitted.has(definition.name)) continue;
        try {
          pi.registerTool(mainCheckpointGate.wrapTool(routeMainSessionTool(definition, {
            fallbackCallDisplayName: definition.label,
          }) as unknown as Record<string, unknown>));
        } catch (err) {
          console.error(
            `PiCC: failed to register MCP tool "${definition.name}": ${boundedMcpErrorText(err)}`,
          );
        }
      }
    } catch (err) {
      // Retain a bounded failed-exposure state so MCP-shaped input cannot become
      // an ordinary provider prompt after startup failed. A genuine settled
      // zero-prompt runtime remains distinguishable and keeps passthrough.
      mcpExposureFailure = boundedMcpErrorText(err);
      mcpPromptCatalog = buildMcpPromptCatalog([], []);
      console.error(`PiCC: MCP exposure failed: ${mcpExposureFailure}`);
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
    // the run's tools, so waiting for the complete initial sequence and its
    // one-time registration makes the first request deterministic. Registration,
    // not bare settlement: settlement alone would race Pi's tool snapshot.
    let showsMcpStartupStatus = false;
    if (ctx?.mode === "tui") {
      // RPC also reports hasUI, so mode is the protocol boundary for footer-only chrome.
      try {
        showsMcpStartupStatus = mcpRuntime.serverStates().some(
          (state) => state.state === "connecting" || state.state === "retrying",
        );
      } catch {
        /* presentation detection must not affect prompt admission */
      }
      if (showsMcpStartupStatus) {
        try {
          ctx.ui?.setStatus?.(MCP_STARTUP_STATUS_KEY, MCP_STARTUP_STATUS_TEXT);
        } catch {
          /* presentation must not affect MCP registration */
        }
      }
    }
    try {
      await mcpExposure;
    } finally {
      if (showsMcpStartupStatus) {
        try {
          ctx.ui?.setStatus?.(MCP_STARTUP_STATUS_KEY, undefined);
        } catch {
          /* cleanup failure must not affect MCP registration */
        }
      }
    }
    // One-time MCP failure warning: every enabled server has settled behind the
    // barrier above, so the FIRST turn after settle is the one honest moment to
    // report startup failures. Checked exactly once per session — a "failed"
    // state a later shutdown synthesizes must never re-trigger it. stderr is
    // the no-UI fallback, never the only surface (/doctor stays the record).
    if (!mcpFailureChecked) {
      mcpFailureChecked = true;
      try {
        const failed = mcpRuntime.serverStates().filter((s) => s.state === "failed");
        if (failed.length > 0) {
          const toolDiscoveryFailures = failed.filter(
            (state) => state.initialToolDiscoveryFailed === true,
          );
          const selected = toolDiscoveryFailures.length > 0 ? toolDiscoveryFailures : failed;
          const shown = selected.slice(0, 8).map((state) => state.name);
          const omitted = selected.length - shown.length;
          const otherFailures = failed.length - toolDiscoveryFailures.length;
          const message = toolDiscoveryFailures.length > 0
            ? `Initial tools/list discovery failed for MCP server(s): ${shown.join(", ")}` +
              (omitted > 0 ? `, and ${omitted} more` : "") +
              " — check the server configuration and logs, then run /reload or restart PiCC." +
              (otherFailures > 0 ? ` ${otherFailures} other MCP server(s) failed; run /doctor for details.` : "")
            : `MCP server(s) failed to start: ${shown.join(", ")}` +
              (omitted > 0 ? `, and ${omitted} more` : "") +
              " — run /doctor for details.";
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
  /**
   * Rotate the checkpoint session epoch, concluding any resume that survived it.
   *
   * The narrow reason: every settlement path *inside the `agent_settled` handler* is
   * guarded on `resume.epoch === checkpointSessionEpoch`, so a resume that outlives
   * the rotation can no longer be ended by the lifecycle event that would normally
   * end it. `conclude` itself carries no epoch check, so `cancelAndJoin` could still
   * reach it — but only if something later cancels, and the rotation sites are
   * exactly where a session stops being cancellable. Cancellation normally concludes
   * the resume before the rotation runs; this makes that an invariant of the helper
   * instead of an ordering an unrelated change could silently break.
   */
  const rotateCheckpointSessionEpoch = (): void => {
    resumedCancellationOutcome = undefined;
    activeMainResume?.conclude("superseded");
    checkpointSessionEpoch = {};
  };

  pi.on("session_before_switch", async (_event: any, ctx: any) => {
    // The controller cancels first; the old nested agent_settled or host callback
    // is the only authority that can confirm the logical run has joined.
    const result = await mainCheckpointGate.beforeSessionSwitch();
    if (result?.cancel) {
      if (mainCheckpointGate.currentController().isProcessTerminal()) {
        const terminalSnapshot = mainCheckpointGate.currentController().snapshot();
        const notice = terminalSnapshot.failureCategory === "restart-required"
          ? restartRequiredText : unconfirmedHostText;
        const surface = checkpointSurface(ctx);
        try {
          if (surface === "tui") ctx.ui?.notify?.(notice, "error");
          else if (surface === "print" || surface === "stderr") console.error(`PiCC: ${notice}`);
        } catch { /* presentation only */ }
        appendCheckpointEntry({
          category: "checkpoint-session-switch-refused",
          action: "restart-process",
          notice,
        });
      }
    } else {
      // Disarm the outgoing conversation immediately; the accepted branch's
      // snapshot is installed only by its subsequent session_start.
      checkpointModeLatch = undefined;
      activeMainNotebookState = new NotebookSessionState();
      // Invalidate lifecycle authority at switch acceptance, not only at the next
      // session_start, so an old manual completion in that gap is inert.
      rotateCheckpointSessionEpoch();
      activeCompactionOperation = undefined;
    }
    return result;
  });

  pi.on("session_start", async (event: any, ctx: any) => {
    const startController = mainCheckpointGate.currentController();
    if (startController.isProcessTerminal()) {
      const notice = startController.snapshot().failureCategory === "restart-required"
        ? restartRequiredText : unconfirmedHostText;
      const surface = checkpointSurface(ctx);
      try {
        if (surface === "tui") ctx.ui?.notify?.(notice, "error");
        else if (surface === "print" || surface === "stderr") console.error(`PiCC: ${notice}`);
      } catch { /* presentation only */ }
      appendCheckpointEntry({
        category: "checkpoint-session-start-refused",
        action: "restart-process",
        notice,
      });
      throw new Error(notice);
    }
    let branch: unknown;
    try {
      branch = ctx.sessionManager?.getBranch?.();
    } catch {
      branch = undefined;
    }
    installMainNotebookState(branch);
    // Every start refreshes and replaces the heartbeat; only an actual startup may schedule transcript reaping.
    sessionRetentionStarted(ctx, event.reason);
    // A session being installed has a live runner behind it — before the outgoing
    // controller hands back what it could not deliver, which is the first thing that has
    // to reach the reader's editor. Pi never starts a session after a `quit` teardown, so
    // this only ever clears a latch that no longer describes anything.
    sessionRenderingStopped = false;
    sessionShutdownBoundary = false;
    mainShutdownRetainedInputAtRisk = false;
    await mainCheckpointGate.startSession(randomUUID());
    checkpointContext = ctx;
    rotateCheckpointSessionEpoch();
    checkpointModeLatch = undefined;
    checkpointMode(ctx);
    const sessionStartEpoch = checkpointSessionEpoch;
    const sessionStartController = mainCheckpointGate.currentController();
    activeCompactionOperation = undefined;
    printedResumeToken = undefined;
    stopHookIterations = 0;
    try {
      modelRegistryRef = ctx.modelRegistry;
      // Status panel: interactive TUI ONLY. The gate is `ctx.mode === "tui"`
      // specifically, NOT `hasUI` — RPC mode also implements setWidget (and
      // reports hasUI: true), so a hasUI gate would install the panel into an
      // RPC client; print/RPC output must stay unchanged.
      if (readableContextMode(ctx) === "tui") {
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
      // A project shipping .githooks expects them live. Worktrees inherit this
      // repository-local setting from the shared Git configuration.
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
      if (event.reason === "startup" && !pluginStartupNoticePresented) {
        const projection = projectPluginInventoryStartup(project.pluginInventory);
        const captureEvidenceOmitted = projection.omissions.captureEvidence
          .some((omission) => omission.count > 0);
        const omissionCue = projection.omissions.identities > 0 ||
          projection.omissions.managedPolicyEvidence > 0 || captureEvidenceOmitted
          ? "This startup notice is abbreviated."
          : undefined;
        const pluginNotice = [projection.text, omissionCue].filter((line): line is string => line !== undefined).join("\n");
        if (pluginNotice) {
          pluginStartupNoticePresented = true;
          try {
            if (ctx.mode === "tui") ctx.ui?.notify?.(pluginNotice, "warning");
            else console.error(`PiCC: ${pluginNotice}`);
          } catch { /* startup diagnostics cannot change session lifecycle */ }
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
      // Approval and policy outcomes share one immutable-snapshot notice. Only a
      // newly loaded extension's startup may present it; /new and same-instance
      // lifecycle events cannot replay it.
      if (event.reason === "startup" && !mcpStartupNoticePresented) {
        const mcpStartupNotice = buildMcpStartupNotice(project.mcp, compat.mcpPendingNotice);
        if (mcpStartupNotice) {
          mcpStartupNoticePresented = true;
          if (ctx.mode === "tui") ctx.ui?.notify?.(mcpStartupNotice, "warning");
          else console.error(`PiCC: ${mcpStartupNotice}`);
        }
      }
    } catch (err) {
      console.error(`PiCC session_start failed: ${(err as Error).message}`);
    }
  });

  pi.on("message_end", (event: any, ctx: any) => {
    mainCheckpointGate.assistantMessageEnded(event?.message, ctx);
    const resume = activeMainResume;
    if (resume?.triggerStarted && event?.message?.role === "assistant" && event.message.stopReason === "aborted" &&
        mainCheckpointGate.currentController().resumedAborted(resume.token)) {
      resume.abortedAssistant = event.message;
    }
  });

  pi.on("message_start", (event: any) => {
    const resume = activeMainResume;
    const message = event?.message;
    if (message && typeof message === "object") {
      const envelope = message.details;
      if (envelope && typeof envelope === "object") {
        const lease = mainHostSendLeases.get(envelope);
        if (lease) {
          mainHostSendLeases.delete(envelope);
          let scrubbed = false;
          try {
            scrubbed = delete envelope.piccCheckpointHostInput && !("piccCheckpointHostInput" in envelope);
          } catch { /* an unsrubbable envelope is not authenticated */ }
          const settled = scrubbed && mainCheckpointGate.settleHostInput(lease);
          if (!scrubbed) mainCheckpointGate.settleHostInput(lease);
          if (resume?.triggerLease === lease) resume.triggerStarted = settled;
        }
      }
    }
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
    await mainCheckpointGate.beforeProviderRequest(ctx);
  });

  const retainedPersistenceLocators = new WeakMap<object, RetainedInputPersistenceLocator>();

  pi.on("session_shutdown", async (event: any) => {
    clearRetentionHeartbeat();
    // `quit` is the one reason Pi has already stopped the renderer for (`dispose()`); the
    // switch reasons (`new`/`resume`/`fork`) and `reload` all leave a live UI behind.
    // Latched before the cancellation, because the cancellation is what announces the
    // ending and hands back the input this session will never deliver.
    if (event?.reason === "quit") sessionRenderingStopped = true;
    sessionShutdownBoundary = true;
    let custodyFailure: Error | undefined;
    try {
      // Main cancellation owns its abort and exact join. If that join cannot prove
      // quiescence, no unrelated cleanup may release process/session custody.
      try {
        const controller = mainCheckpointGate.currentController();
        const snapshot = controller.snapshot();
        const resume = activeMainResume;
        if (resume && resume.epoch === checkpointSessionEpoch && resume.generation === snapshot.generation &&
            resume.token.generation === snapshot.generation &&
            (snapshot.phase === "resuming" || snapshot.phase === "terminalizing")) {
          const outcome = await resume.requestCancellation("shutdown");
          if (!outcome.cancelled) throw new Error("Main resumed shutdown cancellation became stale");
          await controller.stableBarrier(snapshot.generation);
        } else {
          await mainCheckpointGate.cancel("shutdown");
        }
      } catch (error) {
        if (error instanceof UnconfirmedHostDeadlineError) {
          error.message = `Main checkpoint shutdown could not confirm host quiescence. ${UNCONFIRMED_HOST_RECOVERY_GUIDANCE}`;
          throw error;
        }
        throw new Error(`Main checkpoint shutdown custody could not be confirmed. ${UNCONFIRMED_HOST_RECOVERY_GUIDANCE}`, { cause: error });
      }
      const mainShutdown = mainCheckpointGate.currentController().snapshot();
      if (mainShutdown.failureCategory === "unconfirmed-host" ||
          mainShutdown.cancellationQuiescence === "unconfirmed") {
        throw new UnconfirmedHostDeadlineError();
      }
      if ((mainShutdown.cancellationKind === "shutdown" && mainShutdown.cancellationCommitted &&
           mainShutdown.phase !== "idle") || mainShutdownRetainedInputAtRisk) {
        console.error("PiCC: confirmed main-session shutdown could not establish a durable retained-input locator; shutdown continues and undelivered input may be lost.");
      }
      // Fence admission and join every active generation before taking the one retained-child
      // snapshot. A joined child may publish checkpoint custody that must enter this same
      // persistence, quarantine, and cleanup scan.
      await subagentRuntime.shutdownActiveGenerations();
      // Capture linked task generations before registry-owned checkpoint stopping can
      // terminalize their canonical agent records; background settlement still owns
      // its abort/join callback and must finish before MCP or SessionEnd cleanup.
      const checkpointAgentIds = new Set(subagentRegistry.list()
        .filter((record) => record.state === "running" &&
          subagentRegistry.checkpointStopOwned(record.agentId))
        .map((record) => record.agentId));
      const persistenceFailures = new Set<RetainedInputPersistenceFailure | "storage-unavailable">();
      const retained = await subagentRuntime.stopAllRetainedSubagents({
        persist: (report) => {
          if (retainedPersistenceLocators.has(report)) return true;
          if (!sessionManagerRef) {
            persistenceFailures.add("storage-unavailable");
            return false;
          }
          try {
            const locator = (testSeam?.persistRetainedInputReport ?? persistRetainedInputReport)(report, {
              session: sessionManagerRef as import("./runtime/retained-input-persistence.js").RetainedInputPersistenceSession,
            });
            retainedPersistenceLocators.set(report, locator);
            return true;
          } catch (error) {
            persistenceFailures.add(error instanceof RetainedInputPersistenceError ? error.category : "storage-unsafe");
            return false;
          }
        },
      });
      if (retained.unconfirmed > 0 || retained.outcomes.some((outcome) => outcome.disposition === "unconfirmed")) {
        const affectedAgents = retained.outcomes
          .filter((outcome) => outcome.disposition === "unconfirmed")
          .slice(0, 5)
          .flatMap((outcome) => {
            const agent = subagentRegistry.get(outcome.agentId);
            if (!agent) return [];
            const transcriptPath = typeof agent.transcriptPath === "string" && agent.transcriptPath.length > 0
              ? agent.transcriptPath
              : undefined;
            return [{ agentId: agent.agentId, transcriptPath }];
          });
        const named = affectedAgents.length > 0
          ? ` Bounded subset of affected agents: ${affectedAgents.map(({ agentId, transcriptPath: childPath }) =>
              childPath
                ? `agent ID ${JSON.stringify(agentId)}, exact transcript path value ${JSON.stringify(childPath)}`
                : `agent ID ${JSON.stringify(agentId)}, no transcript path was recorded`).join("; ")}. Each JSON-quoted agent ID and transcript path value above is exact and reversible: decode the quoted value as JSON, or copy its decoded contents; the surrounding quote delimiters are not part of the ID or path.`
          : "";
        const recovery = event?.reason === "quit"
          ? "The process is exiting and the renderer is already stopped, so no further TaskOutput invocation is possible. Before and after restart, decode or copy each exact quoted transcript path value above and use the decoded path as its child recovery locator. For any named agent with no transcript path recorded, no transcript locator is available; caller-owned parent/client request history is the remaining source where available. Transcript paths survive process replacement, but agent IDs do not. Inspect the named transcripts, worktree, and possible files, tools, or external effects before deliberate resubmission. Do not resume or retry the affected child in this process."
          : "While this process remains live, decode or copy each exact quoted agent ID above and attempt TaskOutput with the decoded ID before exit, copying its result only if a canonical report exists. If no canonical report exists or TaskOutput is absent or unavailable for a named agent, decode or copy its corresponding exact quoted transcript path value and copy retained input from the decoded path before exit. For any named agent with no transcript path recorded, no transcript locator is available; caller-owned parent/client request history is the remaining source where available. Transcript paths survive process replacement, but agent IDs do not. After restart, use the decoded transcript paths directly and inspect the worktree plus possible files, tools, or external effects before deliberate resubmission. Do not resume or retry the affected child in this process.";
        throw new Error(`Unconfirmed child shutdown disposition blocked cleanup.${named} ${recovery}`);
      }
      const persistedLocators = retained.outcomes.flatMap((outcome) => {
        const locator = outcome.report && retainedPersistenceLocators.get(outcome.report);
        return locator ? [locator] : [];
      });
      if (persistedLocators.length > 0) {
        const locators = persistedLocators.map((locator) => locator.kind === "session-entry"
          ? `session ${locator.sessionFile}, entry ${locator.entryId}. Open/search that named JSONL for exact entry id ${locator.entryId} and customType picc-retained-input-report, then read ordered data.report.occurrences`
          : `recovery file ${locator.path} for session ${locator.sessionFile}. Open that named JSON and read ordered report.occurrences`);
        console.error(`PiCC: persisted retained input for restart recovery: ${locators.join("; ")} before deliberate resubmission.`);
      }
      const failedPersistence = retained.outcomes.some((outcome) =>
        outcome.disposition === "confirmed" && outcome.report !== undefined && outcome.persisted !== true);
      const failedCleanup = retained.outcomes.some((outcome) =>
        outcome.disposition === "confirmed" && outcome.report !== undefined && outcome.cleanupReleased !== true);
      if (failedPersistence) {
        const categories = [
          persistenceFailures.has("report-incomplete") ? "incomplete or unrepresentable report" : undefined,
          persistenceFailures.has("storage-unsafe") || persistenceFailures.has("storage-unavailable")
            ? "storage unavailable or unsafe" : undefined,
        ].filter((value): value is string => value !== undefined);
        const missingLocatorIds = retained.outcomes
          .filter((outcome) => outcome.disposition === "confirmed" && outcome.report !== undefined && outcome.persisted !== true)
          .slice(0, 5)
          .map((outcome) => sanitizeLine(outcome.agentId, 80));
        const named = missingLocatorIds.length > 0 ? ` for this bounded subset of generated agent IDs ${missingLocatorIds.join(", ")}` : "";
        console.error(`PiCC: no durable retained-input locator was established${named}${categories.length ? ` (${categories.join("; ")})` : ""}; shutdown continues and undelivered input may be lost. Before deliberate resubmission, recover from parent/child transcripts or request history and inspect the worktree plus possible files, tools, and external effects.`);
      }
      if (failedCleanup) {
        throw new Error("Confirmed child cleanup release could not be authenticated. Cleanup remains blocked; exit PiCC completely, start a fresh process and session, and inspect the child transcript, worktree, canonical TaskOutput report, and possible files/tools/external effects.");
      }
      // Pre-commit paused records have no retained report and keep their established
      // shutdown join. Enhanced confirmed records were already joined above.
      await Promise.allSettled([...checkpointAgentIds]
        .map((agentId) => backgroundTasks.stopAgentAndWait(agentId)));
      await Promise.allSettled(backgroundTasks.ids()
        .filter((id) => {
          const task = backgroundTasks.get(id);
          return task?.status === "running" && !checkpointAgentIds.has(task.agentId ?? "");
        })
        .map((id) => backgroundTasks.stopAndWait(id)));
      await subagentRuntime.shutdownCheckpointPaused();
      await subagentRuntime.shutdownMcpScopes();
      // MCP servers die with the session — after the subagent joins above
      // (an in-flight subagent MCP call must not lose its server mid-call),
      // before SessionEnd fires. Never throws; grace-bounded per server.
      await mcpRuntime.shutdown();
      // `reason` is the matcher subject for SessionEnd (Claude wire contract).
      await hooks.fire("SessionEnd", { cwd: cwdState.get(), reason: event?.reason ?? "other" });
    } catch (error) {
      if (error instanceof UnconfirmedHostDeadlineError) {
        if (!error.message.includes("fresh PiCC process")) {
          error.message = `Main checkpoint shutdown could not confirm host quiescence. ${UNCONFIRMED_HOST_RECOVERY_GUIDANCE}`;
        }
        custodyFailure = error;
      } else if (error instanceof Error &&
          (error.message.startsWith("Main checkpoint shutdown custody could not be confirmed") ||
           error.message.startsWith("Unconfirmed child shutdown disposition") ||
           error.message.startsWith("Confirmed child cleanup release"))) {
        custodyFailure = error;
      }
      // Other shutdown integrations retain the existing never-crash floor.
    } finally {
      if (event?.reason === "quit") await joinScheduledRetentionJobs();
    }
    if (custodyFailure) throw custodyFailure;
  });

  const MCP_PROMPT_FAILURE_MESSAGE_MAX_CHARS = 4_096;
  type McpPromptFailureCategory = McpPromptInvocationErrorCategory | "unknown";
  type McpPromptFailureEntry = {
    command: string;
    server?: string;
    category: McpPromptFailureCategory;
    message: string;
    providerRequestSent: false;
  };

  pi.registerEntryRenderer("picc-mcp-prompt", (entry: any, _opts: any, theme: any) => {
    const data = (entry?.data ?? {}) as Partial<McpPromptFailureEntry>;
    const command = sanitizeDisplayText(String(data.command ?? "unknown"), 240, true) || "unknown";
    const category = sanitizeDisplayText(String(data.category ?? "response"), 40, true) || "response";
    const message = sanitizeDisplayText(
      String(data.message ?? "MCP prompt invocation failed."),
      MCP_PROMPT_FAILURE_MESSAGE_MAX_CHARS,
    );
    return {
      render(width: number): string[] {
        const columns = Math.max(1, Math.floor(width));
        const lines: string[] = [];
        const tone = category === "unknown" || category === "arguments" ? "warning" : "error";
        pushColored(theme, tone, `MCP prompt /${command} — ${category}`, columns, lines);
        for (const paragraph of message.split("\n")) pushColored(theme, "text", paragraph, columns, lines);
        return clampLines(lines, columns);
      },
    };
  });

  async function presentMcpPromptFailure(data: McpPromptFailureEntry, ctx: any): Promise<void> {
    const bounded: McpPromptFailureEntry = {
      command: sanitizeDisplayText(data.command, 240, true) || "unknown",
      ...(data.server ? { server: sanitizeDisplayText(data.server, 200, true) } : {}),
      category: data.category,
      message: boundedMcpErrorText(data.message, MCP_PROMPT_FAILURE_MESSAGE_MAX_CHARS),
      providerRequestSent: false,
    };
    try {
      if (ctx?.mode === "tui") {
        if (typeof ctx.ui?.notify !== "function") throw new Error("TUI notification unavailable");
        ctx.ui.notify(
          bounded.message,
          bounded.category === "unknown" || bounded.category === "arguments" ? "warning" : "error",
        );
      } else if (isTextPrintMode(ctx)) {
        console.error(`PiCC: ${bounded.message}`);
      } else {
        pi.appendEntry("picc-mcp-prompt", bounded);
      }
    } catch {
      try { process.stderr.write(`PiCC: ${bounded.message}\n`); } catch { /* failure remains handled */ }
    }
  }

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
      if (inputDisposition !== "accept" && inputDisposition !== "quarantine") {
        rejectOrdinaryInput(inputDisposition, event, ctx);
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

      // Registered commands normally bypass `input`; these fallbacks keep the same
      // non-provider diagnostics available in machine modes while core readiness is blocked.
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

      const readiness = await builtInRegistration;
      if (!readiness.ok) {
        // Latch admission before cleanup or diagnostics: none of those best-effort
        // surfaces may let the outer input catch fall through to provider work.
        builtInAdmissionFailed = true;
        if (!readiness.cleanupVerified) Object.assign(readiness, removeCoreFromActiveSet());
        const stderrFallback = (text: string): void => {
          try { process.stderr.write(`${text.slice(0, 2_000)}\n`); } catch { /* admission is already latched */ }
        };
        const report = (text: string, detailed: boolean): void => {
          const bounded = text.slice(0, 2_000);
          try {
            if (ctx.mode === "tui") {
              if (typeof ctx.ui?.notify !== "function") throw new Error("TUI notification unavailable");
              ctx.ui.notify(bounded, "error");
            } else if (ctx.mode === "print") {
              console.error(bounded);
            } else {
              pi.appendEntry("picc-core-readiness", detailed ? { error: bounded, detailed: true } : { error: bounded });
            }
          } catch {
            stderrFallback(bounded);
          }
        };
        if (!builtInFailureDetailed) {
          builtInFailureDetailed = true;
          const commit = readiness.possiblePartialCommit
            ? "registration began, so a partial core replacement may have committed"
            : "registration did not begin";
          report(`PiCC: core tool initialization failed; the project task was not sent. Check or update through the installation owner; for a direct PiCC launch, /picc-update or picc update --check are examples. Restart PiCC, then use /doctor and the reported cause if this persists. Cause: ${readiness.cause}; ${commit}; ${readiness.cleanup}.`, true);
        }
        report("PiCC: core tools are unavailable; task not sent. Restart PiCC after updating or reinstalling.", false);
        return { action: "handled" };
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
      const accept = <T extends { action: "continue" } | TransformResult>(
        result: T,
        stagedActivation?: SkillActivationState,
      ): T | { action: "handled" } => {
        const text = result.action === "transform" ? result.text : String(event.text ?? "");
        const images = result.action === "transform" ? result.images : event.images;
        const liveDisposition = mainCheckpointGate.ordinaryInputDisposition();
        if (liveDisposition !== "accept" && liveDisposition !== "quarantine") {
          rejectOrdinaryInput(liveDisposition, event, ctx);
          return { action: "handled" };
        }
        if (liveDisposition === "quarantine" && stagedActivation) {
          const controller = mainCheckpointGate.currentController();
          const originalImages = Array.isArray(event.images) ? event.images : [];
          reportRejectedShadows([{
            id: 0,
            generation: controller.snapshot().generation,
            sessionId: controller.sessionId,
            content: originalImages.length > 0
              ? [{ type: "text", text: String(event.text ?? "") }, ...originalImages]
              : String(event.text ?? ""),
            delivery: event.streamingBehavior === "steer" ? "steer" : "followUp",
          }], ctx);
          return { action: "handled" };
        }
        if (liveDisposition === "accept") {
          // This final live sample alone may rotate accepted-run authority and its
          // activation controls; awaited hook/skill work has no commit authority.
          mainCheckpointGate.acceptedLogicalRun();
          if (stagedActivation) commitMainActivation(stagedActivation);
          else activeSkillDenyRules.clear();
        }
        const shadow = mainCheckpointGate.captureAcceptedInput(ctx, text, images, event.streamingBehavior);
        // Quarantine is the live lifecycle decision; shadow capture success only
        // decides whether the fallback report below must retain the input.
        if (liveDisposition === "quarantine" && !shadow) {
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
        // Handling quarantine here is what prevents Pi from starting a second turn.
        return shadow || liveDisposition === "quarantine" ? { action: "handled" } : result;
      };

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
      const extra = [outcome.stdout, outcome.additionalContext].filter(Boolean).join("\n").trim();
      const hookSuffix = extra ? `\n\n<hook-context>\n${extra}\n</hook-context>` : "";

      // Resolve local/project/plugin spellings before entering the MCP namespace.
      // This identification also tells us whether a typed fork must wait for the
      // settled parent tool universe before it snapshots a child.
      const text: string = event.text ?? "";
      let rest = text.trim();
      const stacked: ClaudeSkill[] = [];
      while (stacked.length < 5) {
        const m = TYPED_SLASH_TOKEN_RE.exec(rest);
        if (!m) break;
        if (reservedBuiltinName(m[1]!)) break;
        const found = findByName(project.skills, m[1]!);
        if (!found?.userInvocable) break;
        stacked.push(found);
        rest = rest.slice(m[0].length).replace(/^[ \t]+/, "");
      }

      if (stacked.some((skill) => skill.contextFork)) await mcpExposure;

      if (stacked.length === 0 && text.trimStart().startsWith("/mcp__")) {
        await mcpExposure;
        const command = text.trim().slice(1).split(/\s/u, 1)[0] ?? "mcp__unknown";
        if (mcpExposureFailure !== undefined) {
          await presentMcpPromptFailure({
            command,
            category: "call",
            message: boundedPromptRecoveryMessage(
              `MCP prompt exposure failed during server startup: ${mcpExposureFailure}.`,
            ),
            providerRequestSent: false,
          }, ctx);
          return { action: "handled" };
        }
        const match = matchMcpPromptInvocation(text.trim(), mcpPromptCatalog);
        const failedNamespace = match?.kind === "known"
          ? undefined
          : failedPromptNamespaces.records.find((record) => command.startsWith(record.commandPrefix));
        const hasPromptDiscoveryFailures = failedPromptNamespaces.records.length > 0 ||
          failedPromptNamespaces.omittedCount > 0;
        if (failedNamespace || (
          match === undefined && mcpPromptCatalog.commands.length === 0 && hasPromptDiscoveryFailures
        )) {
          await presentMcpPromptFailure({
            command,
            ...(failedNamespace ? { server: failedNamespace.server } : {}),
            category: "call",
            message: promptDiscoveryFailureMessage(failedNamespace),
            providerRequestSent: false,
          }, ctx);
          return { action: "handled" };
        }
        if (match?.kind === "unknown") {
          await presentMcpPromptFailure({
            command: match.name,
            category: "unknown",
            message: `${match.error}. Use a published MCP prompt command from the slash palette or run /mcp to inspect server state.`,
            providerRequestSent: false,
          }, ctx);
          return { action: "handled" };
        }
        if (match?.kind === "known") {
          try {
            const expanded = await invokeMcpPrompt(
              mcpRuntime,
              match.command,
              match.argumentText,
              config.compaction.clipMaxTokens,
            );
            return accept(withCapturedImages({
              action: "transform",
              text: expanded + hookSuffix,
            }));
          } catch (error) {
            const failure = error instanceof McpPromptInvocationError
              ? error
              : new McpPromptInvocationError("response", boundedMcpErrorText(error));
            const correction = failure.category === "arguments"
              ? ` Usage: /${match.command.name}${match.command.argumentHint ? ` ${match.command.argumentHint}` : ""}.`
              : failure.category === "call"
                ? " Retry later; check the server configuration and logs if the failure persists."
                : " The server returned unusable prompt content; check or fix the server's prompt implementation.";
            await presentMcpPromptFailure({
              command: match.command.name,
              server: match.command.serverName,
              category: failure.category,
              message: `${failure.message}${correction}`,
              providerRequestSent: false,
            }, ctx);
            return { action: "handled" };
          }
        }
      }

      // 2) Skill slash command(s): expand `/name [args]` into the user turn,
      //    exactly as Claude Code does (this is why it must be a transform, not
      //    a self-dispatching extension command — those can't reliably trigger
      //    a turn in print mode). Up to 5 LEADING skill tokens stack
      //    (`/skill-a /skill-b remaining text`, Claude v2.1.199): all activate
      //    in order and the remaining text is the LAST skill's arguments — its
      //    rendered activation carries the text (via $ARGUMENTS/$N markers, or
      //    the ARGUMENTS: fallback when the body has none).
      if (stacked.length) {
        const stagedActivation = stageMainActivation();
        const parts: string[] = [];
        for (let i = 0; i < stacked.length; i++) {
          const skill = stacked[i]!;
          const argsText = i === stacked.length - 1 ? rest : "";
          debug(`input: expanding skill /${skill.name}`);
          const rendered = await activateSkill(skill, argsText, {
            fork: skill.contextFork,
            activation: stagedActivation,
          });
          if (!rendered.ok) {
            const message = sanitizeLine(rendered.message, 500);
            try {
              if (ctx.mode === "tui") ctx.ui?.notify?.(message, "error");
              else console.error(`PiCC: ${message}`);
            } catch {
              console.error(`PiCC: ${message}`);
            }
            return { action: "handled" };
          }
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
              result = await hooks.withScoped(
                mainActivationStages.get(stagedActivation)?.hookRunners ?? new Map(),
                () => forkDispatch(
                  skill,
                  rendered.text,
                  1,
                  argsText,
                  forkSignal,
                  ctx.mode !== "tui",
                ),
              );
            } finally {
              // Teardown must never throw over a computed result.
              try {
                stopEscWatch?.();
              } catch {
                /* ignore terminal-input unsubscribe failure */
              }
            }
            if (ctx.mode === "tui") {
              surfaceTypedForkTuiDiagnostics(
                result.diagnostics,
                (message, severity) => ctx.ui?.notify?.(message, severity),
              );
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
          const note = skillDedupNote(skill, rendered.text, stagedActivation);
          parts.push(note ?? skillActivationMessage(skill, rendered.text));
        }
        // The trailing text is NOT re-appended as its own part: the last
        // skill's rendered activation already carries it as $ARGUMENTS (or via
        // the ARGUMENTS: fallback), so a second copy would duplicate the request.
        return accept(
          withCapturedImages({ action: "transform", text: parts.join("\n\n") + hookSuffix }),
          stagedActivation,
        );
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
      if (builtInAdmissionFailed) return { action: "handled" };
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
        return { action: "handled" };
      }
      if (disposition !== "accept") {
        rejectOrdinaryInput(disposition, event, ctx);
        return { action: "handled" };
      }
      return { action: "continue" };
    }
  });

  /**
   * `settled` false means a Stop hook blocked and a continuation was issued instead.
   * `continuationAdmitted` then reports PiCC's own admission decision, which is the
   * one way a continuation can fail to start a turn that PiCC can actually see —
   * Pi's `sendUserMessage` returns void, and its other ways of ending without a turn
   * (no model, expired credentials, a pre-turn throw) are invisible from here.
   *
   * It is reported as refused whenever a resumed run is live and the continuation
   * went out without a capability, because PiCC then refuses it in its own `input`
   * handler: with no capability in the store the handler falls through to
   * `ordinaryInputDisposition`, which returns a refusal for every phase except
   * `idle`, and a live resume means the controller is not idle.
   */
  type StopHookOutcome =
    | { settled: true }
    | { settled: false; continuationAdmitted: boolean };

  const latestAssistantMessage = (ctx: any): any | undefined => {
    try {
      // agent_settled carries no messages, so use the active selected branch.
      // getEntries() is only the fallback for doubles without branch selection.
      const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry?.type === "message" && entry.message?.role === "assistant") return entry.message;
      }
    } catch {
      /* malformed optional session inspection is treated as unavailable */
    }
    return undefined;
  };

  const runStopHook = async (ctx: any): Promise<StopHookOutcome> => {
    try {
      let lastAssistantMessage: string | undefined;
      try {
        const content = latestAssistantMessage(ctx)?.content;
        lastAssistantMessage = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("")
            : undefined;
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
        return { settled: true };
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
          // Pi reaches the `input` event synchronously from `sendUserMessage`, and
          // PiCC's own admission decides in that handler's synchronous prefix, so
          // `consumed` is already final when the send returns. That depends on PiCC
          // being the first extension registering an `input` handler: Pi awaits each
          // handler in extension order, so an extension ahead of PiCC whose handler
          // awaits would defer this decision past the send and make `consumed` read a
          // stale `false` — abandoning a run that is in fact healthy.
          stopContinuationAdmission.run(capability, () => pi.sendUserMessage(continuation));
          return { settled: false, continuationAdmitted: capability.consumed };
        }
        // No capability could be minted — either no resumed run is carrying this
        // continuation, or authority moved while the hook ran. In the first case
        // nothing's settlement depends on the answer; in the second the answer is
        // provably "refused", because the `input` handler has no capability to match
        // and every non-idle disposition is a refusal. Reporting admission there
        // would strand the resumed run.
        const admitted = activeMainResume === undefined;
        pi.sendUserMessage(continuation);
        return { settled: false, continuationAdmitted: admitted };
      }
      stopHookIterations = 0;
      return { settled: true };
    } catch {
      return { settled: true };
    }
  };

  const emitResumedPrintResult = async (
    ctx: any,
    token: ResumeToken,
    epoch: object,
    hasAuthority: () => boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    if (ctx?.mode !== "print" || printedResumeToken === token) return;
    const entries: any[] = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
    const entry = [...entries].reverse().find((candidate) =>
      candidate?.type === "message" && candidate.message?.role === "assistant");
    const message = entry?.message;
    if (!message || message.stopReason === "pending" || message.stopReason === "error" || message.stopReason === "aborted") return;
    const blocks = Array.isArray(message.content)
      ? message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string")
      : [];
    if (blocks.length === 0) return;
    const data = Buffer.from(blocks.map((part: any) => `${part.text}\n`).join(""), "utf8");
    const chain = printWriteChain?.epoch === epoch
      ? printWriteChain
      : { epoch, tail: Promise.resolve() };
    printWriteChain = chain;
    const writing = chain.tail.then(async () => {
      if (printedResumeToken === token || !hasAuthority()) return;
      await writeFdFully(process.stdout.fd, data, undefined, undefined, signal);
      printedResumeToken = token;
      pi.sendMessage({
        customType: "picc-checkpoint-print-result",
        content: "",
        display: false,
      });
    });
    chain.tail = writing.catch(() => undefined);
    await writing;
  };

  const settleStoppedMainRun = async (matchingResumeConclusion: ResumeConclusion = "superseded"): Promise<boolean> => {
    if (!mainCheckpointGate.isLogicalRunStopped()) return false;
    const controller = mainCheckpointGate.currentController();
    const generation = controller.snapshot().generation;
    const resume = activeMainResume;
    if (resume && mainCheckpointGate.stoppedRunMatches(controller, generation) &&
        resume.generation === generation && resume.epoch === checkpointSessionEpoch &&
        resume.token.generation === generation) {
      // cancelAndJoin waits for this exact physical run's settlement. Release it
      // before joining cancellation so agent_settled never waits on itself. The
      // The stop owns ordinary cancellation. An unsuccessful resumed physical run
      // is already post-commit, so it must retain the resume owner's terminal path.
      resume.conclude(matchingResumeConclusion);
    }
    await mainCheckpointGate.settleLogicalRunStop();
    return true;
  };

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    checkpointContext = ctx;
    const terminalAssistant = latestAssistantMessage(ctx);
    const physicalUnsuccessful = ["pending", "error", "aborted"].includes(terminalAssistant?.stopReason);
    const checkpointSnapshot = mainCheckpointGate.currentController().snapshot();
    // Pi persists either PiCC-owned pre-commit stop mechanism as aborted. The
    // active awaiting generation still owns the authorized checkpoint settlement.
    // `checkpointAbortRequested` only selects abort instead of terminate and is
    // deliberately excluded from this exception's eligibility.
    const preCommitCheckpointCutoff = terminalAssistant?.stopReason === "aborted" &&
      activeMainResume === undefined && mainCheckpointGate.isActive() &&
      checkpointSnapshot.phase === "awaiting-settlement";
    const unsuccessful = physicalUnsuccessful && !preCommitCheckpointCutoff;
    if (unsuccessful && terminalAssistant.stopReason === "pending") {
      const notice = "The assistant response ended incomplete (pending); it was not accepted as a completed turn.";
      const mode = readableContextMode(ctx);
      if ((mode === "print" || mode === "json") &&
          (process.exitCode === undefined || process.exitCode === 0)) {
        process.exitCode = 1;
      }
      try {
        if (mode === "tui") ctx.ui?.notify?.(notice, "warning");
        else if (mode === "print") console.error(`PiCC: ${notice}`);
        else if (mode === "json" || mode === "rpc") {
          pi.appendEntry("picc-main-response-incomplete", { stopReason: "pending", notice });
        }
      } catch { /* incomplete classification remains authoritative */ }
    }
    // A universal hook stop is the authoritative ending even when Pi reports an
    // unsuccessful assistant terminal at the same boundary. Snapshot any matching
    // physical identity first, consume the stop, then release only that identity.
    const boundaryController = mainCheckpointGate.currentController();
    const boundaryGeneration = boundaryController.snapshot().generation;
    const physicalOperation = activeCompactionOperation;
    const matchingNativeOperation = physicalOperation?.origin === "pi-native-auto" &&
      physicalOperation.epoch === checkpointSessionEpoch &&
      physicalOperation.controller === boundaryController &&
      physicalOperation.generation === boundaryGeneration;
    const stopped = await settleStoppedMainRun(physicalUnsuccessful ? "abandoned" : "superseded");
    const controller = mainCheckpointGate.currentController();
    if (physicalUnsuccessful && mainCheckpointGate.consumeSettledStoppedResume(
      controller, controller.snapshot().generation,
    )) {
      // The authoritative stop has joined and rotated its controller. The physical
      // resumed terminal is nevertheless post-commit and closes that successor.
      await controller.failAfterCommittedSummary(controller.snapshot().generation, "resumed-work");
    }
    if (matchingNativeOperation && activeCompactionOperation === physicalOperation) {
      // Pi publishes no failure event for a native operation. A later true settlement
      // is its definitive boundary; release only the identity observed here.
      activeCompactionOperation = undefined;
    }
    if (stopped) return;
    if (unsuccessful) {
      const snapshot = controller.snapshot();
      const resume = activeMainResume;
      if (resume && resume.epoch === checkpointSessionEpoch &&
          resume.generation === snapshot.generation && resume.token.generation === snapshot.generation &&
          (snapshot.phase === "resuming" || snapshot.phase === "terminalizing")) {
        // Exact aborted message_end identity followed by this same branch settlement is
        // the sole safe resumed-cancellation exception. Every other unsuccessful ending
        // remains stage-attributed post-commit exhaustion.
        resume.conclude(terminalAssistant.stopReason === "aborted" && resume.abortedAssistant === terminalAssistant
          ? "cancelled"
          : "abandoned");
      } else {
        if (resume === undefined && !mainCheckpointGate.isLogicalRunStopped() &&
            terminalAssistant.stopReason !== "aborted" && snapshot.phase === "awaiting-settlement") {
          controller.exhaustUnsuccessfulAwaitingSettlement(snapshot.generation);
        }
        // Ordinary unsuccessful settlement still revokes callbacks captured by its run.
        mainCheckpointGate.logicalRunSettled();
      }
      return;
    }
    const resume = activeMainResume;
    if (resume?.generation === controller.snapshot().generation &&
        resume.epoch === checkpointSessionEpoch) {
      if (controller.snapshot().phase === "terminalizing") {
        // Terminalization joins this exact settlement, so it has to be published
        // here or the two wait on each other.
        resume.conclude("superseded");
        return;
      }
      if (controller.snapshot().phase === "cancelled") {
        resume.conclude("superseded");
        mainCheckpointGate.logicalRunSettled();
        return;
      }
      if (controller.snapshot().phase === "resuming") {
        // From here until this invocation returns, it is the owner: every exit
        // below either concludes the run or hands ownership off explicitly, with
        // one exception — `settleStoppedMainRun()` below returns true without
        // concluding when the stopped run does not match this resume. No reachable
        // interleaving produces that: while a logical run is stopped
        // `ordinaryInputDisposition` is `reject-stopped`, so no accepted input can
        // rotate the run identity, and a controller or epoch replacement parks
        // behind the very join this settlement releases. It is stated rather than
        // guaranteed, because it rests on that reasoning and not on the structure.
        resume.settlementOwned = true;
        const stop = await runStopHook(ctx);
        if (!stop.settled) {
          // A Stop hook blocked and a continuation went out instead. This invocation
          // is no longer deciding the ending, and Pi guarantees nothing about the
          // continuation, so release ownership rather than record a settlement
          // nobody owes.
          resume.settlementOwned = false;
          if (stop.continuationAdmitted && !resume.joinParked) return;
          // Either PiCC refused its own continuation, so no turn can follow it, or a
          // cancelAndJoin parked on this settlement while this invocation still held
          // ownership and would now wait on a settlement the line above just
          // disowned. Both mean the resumed work is over. The summary is already
          // committed, so ending it here is a post-commit give-up — unless some other
          // authority has already taken the terminal, which owns the ending instead.
          const current = mainCheckpointGate.currentController();
          const snapshot = current.snapshot();
          const stillOurs = current === controller && activeMainResume === resume &&
            resume.epoch === checkpointSessionEpoch && resume.generation === snapshot.generation &&
            resume.token.generation === snapshot.generation && snapshot.phase === "resuming";
          resume.conclude(stillOurs ? "abandoned" : "superseded");
          return;
        }
        if (await settleStoppedMainRun()) return;
        const current = mainCheckpointGate.currentController();
        const snapshot = current.snapshot();
        if (current === controller && activeMainResume === resume &&
            resume.epoch === checkpointSessionEpoch && snapshot.phase === "cancelled") {
          resume.conclude("superseded");
          return;
        }
        if (current !== controller || activeMainResume !== resume ||
            resume.generation !== snapshot.generation || resume.epoch !== checkpointSessionEpoch ||
            resume.token.generation !== snapshot.generation || snapshot.phase !== "resuming") {
          // Authority moved on while the Stop hook ran — most often to
          // terminalization, which is itself joining this settlement.
          resume.conclude("superseded");
          return;
        }
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
          await emitResumedPrintResult(ctx, resume.token, resume.epoch, hasPrintAuthority, resume.signal);
        } catch {
          // The ordinary ending for an answer that could not be delivered: a
          // permanent write error, or a write released by the run's abort authority
          // (FdWriteReleasedError). Either way the emission is abandoned without a
          // marker, and the assistant entry is left last: Pi's native
          // print-mode selector can still emit it once this outer settlement
          // barrier is released.
        }
        resume.conclude("completed");
        mainCheckpointGate.logicalRunSettled();
        // Pi clears run-active before this callback. Finish N first, then let this same
        // physical settlement sample exactly one fallback successor without a second Stop.
        const successorController = mainCheckpointGate.currentController();
        const successor = mainCheckpointGate.settlementGeneration(ctx);
        if (successor !== undefined) await successorController.checkpoint(successor);
        return;
      }
    }

    const checkpointWasArmed = mainCheckpointGate.isActive();
    const generation = mainCheckpointGate.settlementGeneration(ctx);
    if (generation !== undefined) {
      await controller.checkpoint(generation);
      const phase = controller.snapshot().phase;
      if (phase === "exhausted" || phase === "cancelled") return;
      if (checkpointWasArmed) {
        // N's stable barrier is now published. Sample at most one settled successor
        // from this boundary; returning here also preserves one Stop hook per settlement.
        const successor = mainCheckpointGate.settlementGeneration(ctx);
        if (successor !== undefined) await controller.checkpoint(successor);
        return;
      }
    }
    const trulySettled = await runStopHook(ctx);
    if (await settleStoppedMainRun()) return;
    // A Stop-blocked continuation remains the same logical run. Only the
    // accepted final boundary revokes lifecycle callbacks captured by it.
    if (trulySettled.settled) mainCheckpointGate.logicalRunSettled();
  });

  /**
   * Say why PiCC declined a compaction the reader asked for. Deliberately never repeats
   * Pi's own cancellation line — Pi prints "Compaction cancelled" itself, unattributed —
   * and never claims a recovery the controller would refuse: a committed summary must not
   * be compacted again, and a transaction already in flight is a wait rather than a
   * failure. `inFlight` is decided by the caller: a manual request that supersedes a stale
   * operation is not blocked by the operation it replaces.
   */
  const explainRefusedCompaction = (
    controller: MidRunCompactionController, ctx: any, inFlight: boolean,
  ): void => {
    const snapshot = controller.snapshot();
    const cancelledReason = (): string => {
      if (snapshot.failureCategory === "restart-required") {
        return `authenticated RPC cancellation cannot be recovered or replaced in this process. ${RESTART_REQUIRED_RECOVERY_GUIDANCE}`;
      }
      if (snapshot.failureCategory === "unconfirmed-host") {
        return `checkpoint host work could not be confirmed stopped. ${UNCONFIRMED_HOST_RECOVERY_GUIDANCE}`;
      }
      switch (cancelledCheckpointOutlook(snapshot)) {
        case "unconfirmed":
          return `checkpoint host work could not be confirmed stopped. ${UNCONFIRMED_HOST_RECOVERY_GUIDANCE}`;
        // The reader's own Esc, still settling. Telling them to abandon the session here is
        // what made PiCC contradict itself seconds later, when the join landed and the same
        // checkpoint became recoverable.
        case "settling":
          return "the cancellation you asked for has not finished settling yet; try again in a moment.";
        case "settling-committed":
          return "the cancellation you asked for is still settling, and this session's summary is already committed, so no compaction can release it. Start a new session and resend the retained input.";
        // Reachable only while the replacement is in flight: a switch PiCC refuses rejects
        // its cancellation, which classifies as `unconfirmed` above — so the new session
        // this points at is genuinely coming.
        case "replaced":
          return "this checkpoint was cancelled for a session replacement, so compacting again would not release it. Resend the retained input in the new session.";
        case "session-ended":
          return "the cancelled checkpoint stopped with the session it belonged to, so compacting again would not release it. Start a new session and resend the retained input.";
      }
    };
    const reason = inFlight
      ? "a context compaction is already running for this session; wait for it to finish."
      : snapshot.failureCategory === "restoration-paused"
        ? "this session's summary is already committed and must never be compacted again. Start a new session and resend the retained input."
        : controller.manualCompactionDisposition() === "already-active"
          ? "a proactive context checkpoint owns this session's compaction; it will report when it settles."
          : cancelledReason();
    // Self-attributed in both modes, which is the whole point: Pi's own line carries no
    // author, so an unprefixed complement would read as more of the same host message. The
    // prefix is the one every other PiCC diagnostic uses, so `^PiCC: ` finds this too.
    const notice = `PiCC: this compaction did not run — ${reason}`;
    const mode = readableContextMode(ctx);
    try {
      if (mode === "tui") ctx.ui?.notify?.(notice, "warning");
      else console.error(notice);
    } catch { /* the refusal is already decided */ }
    if ((mode === "json" || mode === "rpc") && controller.isProcessTerminal()) {
      appendCheckpointEntry({
        category: "checkpoint-manual-compaction-refused",
        action: "restart-process",
        notice,
      });
    }
  };

  pi.on("session_before_compact", async (event: any, ctx: any) => {
    const epoch = checkpointSessionEpoch;
    const controller = mainCheckpointGate.currentController();
    const generation = controller.snapshot().generation;
    const attempt = checkpointAttempt;
    const proactive = controller.isCompactionSummaryActive(generation) &&
      attempt?.epoch === epoch && attempt.controller === controller && attempt.generation === generation;
    const replacingStaleManual = event.reason === "manual" && !proactive &&
      activeCompactionOperation?.origin === "user-manual" &&
      activeCompactionOperation.epoch === epoch && activeCompactionOperation.controller === controller &&
      activeCompactionOperation.generation === generation;
    if ((activeCompactionOperation && !replacingStaleManual) ||
        (!proactive && controller.manualCompactionDisposition() !== "allow")) {
      // A refused user-initiated compaction is the one wordless ending left, and Pi
      // already renders `{cancel:true}` as an unattributed "Compaction cancelled" that
      // reads as if the reader withdrew it. Complement that line with the reason PiCC
      // declined rather than repeating that it was cancelled. Only for a request the
      // reader made: a refused proactive attempt announces itself as an exhaustion.
      if (!proactive) {
        explainRefusedCompaction(controller, ctx,
          activeCompactionOperation !== undefined && !replacingStaleManual);
      }
      return { cancel: true };
    }
    // Pi labels extension-initiated compact() as manual; controller summary
    // authority is what maps that physical host request to Claude's auto trigger.
    const origin: CompactionOperationOrigin = proactive
      ? "picc-proactive"
      : event.reason === "manual" ? "user-manual" : "pi-native-auto";
    const trigger = origin === "user-manual" ? "manual" : "auto";
    const operation: CompactionLifecycleOperation = {
      identity: {}, epoch, controller, generation, origin, proactive, trigger,
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
    const eventMatchesOrigin = operation.origin === "picc-proactive"
      ? event.reason === "manual"
      : operation.origin === "user-manual" ? event.reason === "manual" : event.reason !== "manual";
    const operationMatches = () => eventMatchesOrigin && operation === activeCompactionOperation &&
      epoch === checkpointSessionEpoch && controller === mainCheckpointGate.currentController() &&
      controller.snapshot().generation === generation &&
      (proactive
        ? attempt?.operation === operation.identity && attempt.controller === controller && attempt.generation === generation
        : operation.recovery
          ? operation.recovery === controller.recoveryToken(generation)
          : controller.snapshot().phase === "idle");
    if (!operationMatches()) {
      // Pi exposes no operation id on this event. A mismatched old-origin event must
      // not clear or authenticate the live successor currently holding this identity.
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
        sendCheckpointMessage(
          { customType: "picc-hook-context", content: startedContext, display: true },
          { deliverAs: "steer" },
          "restoration-control",
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
          sendCheckpointMessage(
            {
              customType: "picc-preserved",
              content: `Context preserved across compaction (PiCC):\n\n${budgeted.text}`,
              display: false,
            },
            { deliverAs: "steer" },
            "restoration-control",
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
        // The terminalization reports its own drained queue now, so forwarding the
        // return value here would report the same shadows twice — and restore the same
        // text into the TUI editor twice.
        await controller.failAfterCommittedSummary(generation, "restoration");
      } else if (event.reason === "manual" && operation.recovery && operation.recovery === controller.recoveryToken(generation)) {
        const recovered = controller.recoverAfterManualCompaction(operation.recovery);
        if (recovered.recovered) {
          const recoveryMode = readableContextMode(checkpointContext);
          if (recoveryMode === "print" || recoveryMode === "json" || recoveryMode === "rpc") {
            publishCheckpoint({
              category: "checkpoint-recovered",
              generation,
              action: "manual-recovery",
            }, checkpointContext);
          }
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
  pi.registerEntryRenderer("picc-proactive-compact", (entry: any, _opts: any, theme: any) => {
    const notice = sanitizeDisplayText(String(entry?.data?.notice ?? ""), 2_000, true);
    const severity = entry?.data?.severity;
    const color = severity === "warning" || severity === "error" ? severity : "dim";
    return {
      render(width: number): string[] {
        const lines: string[] = [];
        pushColored(theme, color, notice, width, lines);
        return clampLines(lines, width);
      },
    };
  });
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
    render: (args: string, ctx: any) => string | undefined | Promise<string | undefined>;
  };

  const MCP_ARGUMENT_RESPONSE =
    "/mcp is status-only; no action occurred. Run bare /mcp for status. Use /doctor or the documented MCP settings for configuration guidance.";
  const CONTROL_ERROR_RESPONSE =
    "PiCC could not produce that control-command report. No action occurred; try again or run /doctor.";
  const PLUGIN_RELOAD_GUIDANCE =
    "/reload-plugins did no reload and made no changes. Manage installation and enablement in Claude Code, then run the canonical /reload in the interactive TUI to reload the whole extension, including installed plugin state, or exit and relaunch PiCC. /doctor reports currently available compatibility and retained plugin-runtime failure findings; /new does not reload plugin state.";

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
    ["plugin", {
      description: "PiCC: inspect the read-only plugin inventory",
      render: async (args, ctx) => renderPluginControl(args, ctx),
    }],
    ["plugins", {
      description: "PiCC: list the read-only plugin inventory (exact alias)",
      render: async (args, ctx) => /^[ \t]*$/.test(args)
        ? withPluginRuntimeOverlay(renderPluginInventoryList(project.pluginInventory))
        : pluginReadOnlyUsage(ctx),
    }],
    ["reload-plugins", {
      description: "PiCC: non-mutating plugin reload guidance",
      render: async () => PLUGIN_RELOAD_GUIDANCE,
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
    const match = /^[ \t]*\/([A-Za-z0-9][\w-]*)(?=[ \t]|$)/.exec(text);
    if (match) {
      const name = match[1]!.toLowerCase();
      if (!controlCommands.has(name)) return undefined;
      return { name, args: text.slice(match[0].length).replace(/^[ \t]+/, "") };
    }

    // Pi's registered-command router and generic String trimming can disagree on
    // vertical/control whitespace. Reserve only the exact plugin tokens here;
    // near-prefix, namespaced, and non-ASCII lookalike tokens remain non-owned.
    const malformedPlugin = /^[\p{White_Space}\p{Cc}\p{Cf}]*\/([Pp][Ll][Uu][Gg][Ii][Nn](?:[Ss])?|[Rr][Ee][Ll][Oo][Aa][Dd]-[Pp][Ll][Uu][Gg][Ii][Nn][Ss])(?=$|[\p{White_Space}\p{Cc}\p{Cf}])/u.exec(text);
    if (!malformedPlugin) return undefined;
    const token = malformedPlugin[1]!;
    return {
      name: token.length === 6 ? "plugin" : token.length === 7 ? "plugins" : "reload-plugins",
      args: `\v${text.slice(malformedPlugin[0].length)}`,
    };
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

  // Deliberately passes no signal: a control command is not run-scoped work and has
  // no cancellation authority to release it, so it keeps the plain unbounded write.
  async function writeTextControlOutput(output: string, ctx: any): Promise<void> {
    const write = testSeam?.mcpControl?.writeText;
    if (write) await write(output);
    else if (testSeam) console.log(output);
    else await writeFdFully(process.stdout.fd, Buffer.from(`${output}\n`, "utf8"));
  }

  function pluginRuntimeOverlay(): string | undefined {
    const findings = compat.pluginRuntimeFindings ?? [];
    if (findings.length === 0 && !compat.pluginRuntimeFindingsOmitted && !compat.pluginRuntimeFindingsOmittedAtLeast) return undefined;
    const retained = findings.slice(0, 10).map((finding) => `- ${sanitizePluginInventoryDisplayText(finding, 240)}`);
    const omitted = Math.max(0, findings.length - retained.length) + (compat.pluginRuntimeFindingsOmitted ?? 0);
    return [
      "Runtime refusals observed after snapshot capture (display overlay only):",
      ...retained,
      ...(omitted > 0 || compat.pluginRuntimeFindingsOmittedAtLeast ? [`- ${compat.pluginRuntimeFindingsOmittedAtLeast ? "at least " : ""}${omitted} additional finding(s) not shown`] : []),
    ].join("\n");
  }

  function withPluginRuntimeOverlay(output: string): string {
    const overlay = pluginRuntimeOverlay();
    return overlay === undefined ? output : `${output}\n\n${overlay}`;
  }

  function pluginReadOnlyUsage(_ctx: any): string {
    return `${PLUGIN_INVENTORY_SLASH_USAGE} No changes were made. Manage plugin installation and enablement in Claude Code. After managing plugins, run the canonical /reload in the interactive TUI or exit and relaunch PiCC.`;
  }

  async function renderPluginControl(args: string, ctx: any): Promise<string | undefined> {
    if (/^[ \t]*$/.test(args)) {
      if (ctx?.mode !== "tui") return withPluginRuntimeOverlay(renderPluginInventoryList(project.pluginInventory));
      const overlay = pluginRuntimeOverlay();
      if (overlay !== undefined) {
        try { ctx.ui?.notify?.(overlay, "warning"); } catch { /* overlay is additive */ }
      }
      const opened = await openPluginInventory(project.pluginInventory, ctx);
      if (opened.opened) return undefined;
      const warning = opened.reason === "unavailable"
        ? "Interactive plugin inventory is unavailable in this TUI; showing the bounded read-only list instead."
        : "Interactive plugin inventory could not open; showing the bounded read-only list instead.";
      try { ctx.ui?.notify?.(warning, "warning"); } catch { /* text fallback remains authoritative */ }
      return `${warning}\n\n${withPluginRuntimeOverlay(renderPluginInventoryList(project.pluginInventory))}`;
    }
    const parsed = parsePluginInventorySlash(`/plugin ${args}`);
    return parsed.kind === "usage"
      ? pluginReadOnlyUsage(ctx)
      : withPluginRuntimeOverlay(renderPluginInventoryOperation(project.pluginInventory, parsed.operation));
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
      if (output !== undefined) await appendControlOutput(name, output, ctx);
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
  // Best-effort: add the harness-owned directory to repository-local excludes.
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

  const promptStubComponents = [".claude", ".picc", "prompts"] as const;
  let promptPublication: Promise<string | undefined> | undefined;
  let promptPublicationDiagnosticEmitted = false;
  let promptDiscoveryProgressVisible = false;

  function isWithinCanonicalRoot(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }

  async function checkedPromptStubLocation(): Promise<{
    root: string;
    parent: string;
    directory: string;
  }> {
    const root = await fs.promises.realpath(project.root);
    let current = root;
    for (const component of promptStubComponents) {
      current = path.join(current, component);
      try {
        await fs.promises.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      const canonical = await fs.promises.realpath(current);
      if (!isWithinCanonicalRoot(root, canonical)) throw new Error(`unsafe redirection at ${component}`);
      current = canonical;
    }
    const parent = path.join(root, ...promptStubComponents.slice(0, -1));
    return { root, parent, directory: path.join(parent, promptStubComponents.at(-1)!) };
  }

  async function canonicalContainedDirectory(root: string, directory: string): Promise<string> {
    const canonical = await fs.promises.realpath(directory);
    if (!isWithinCanonicalRoot(root, canonical)) throw new Error("prompt publication directory escaped the project root");
    return canonical;
  }

  async function removeContainedDirectory(root: string, directory: string): Promise<void> {
    const canonical = await canonicalContainedDirectory(root, directory);
    if (canonical !== directory) throw new Error("prompt cleanup directory changed before removal");
    await fs.promises.rm(canonical, { recursive: true, force: true });
  }

  async function publishPromptStubs(ctx: any): Promise<string | undefined> {
    let staged: { root: string; directory: string } | undefined;
    try {
      await mcpExposure;
      const initial = await checkedPromptStubLocation();
      await fs.promises.mkdir(initial.parent, { recursive: true });
      const canonicalParent = await canonicalContainedDirectory(initial.root, initial.parent);
      if (canonicalParent !== initial.parent) throw new Error("prompt publication parent changed during setup");

      const stagingDirectory = await fs.promises.mkdtemp(path.join(canonicalParent, ".prompts-staging-"));
      const canonicalStaging = await canonicalContainedDirectory(initial.root, stagingDirectory);
      if (path.dirname(canonicalStaging) !== canonicalParent) throw new Error("prompt staging directory escaped its parent");
      staged = { root: initial.root, directory: canonicalStaging };

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
        if (await fs.promises.realpath(canonicalStaging) !== canonicalStaging) {
          throw new Error("prompt staging directory changed during publication");
        }
        await fs.promises.writeFile(path.join(canonicalStaging, `${skill.name}.md`), fm, "utf8");
      }
      for (const command of mcpPromptCatalog.commands) {
        const fm = [
          "---",
          `description: ${JSON.stringify(command.description || `Run MCP prompt /${command.name}`)}`,
          ...(command.argumentHint ? [`argument-hint: ${JSON.stringify(command.argumentHint)}`] : []),
          "---",
          "",
        ].join("\n");
        if (await fs.promises.realpath(canonicalStaging) !== canonicalStaging) {
          throw new Error("prompt staging directory changed during publication");
        }
        await fs.promises.writeFile(path.join(canonicalStaging, `${command.name}.md`), fm, "utf8");
      }

      const checked = await checkedPromptStubLocation();
      const checkedParent = await canonicalContainedDirectory(checked.root, checked.parent);
      if (checked.root !== initial.root || checkedParent !== canonicalParent) {
        throw new Error("prompt publication parent changed before commit");
      }
      const backupReservation = await fs.promises.mkdtemp(path.join(canonicalParent, ".prompts-backup-"));
      const backupDirectory = await canonicalContainedDirectory(checked.root, backupReservation);
      if (path.dirname(backupDirectory) !== canonicalParent) throw new Error("prompt backup escaped its parent");
      await fs.promises.rmdir(backupDirectory);

      let oldMoved = false;
      let newInstalled = false;
      try {
        try {
          await fs.promises.lstat(checked.directory);
          await canonicalContainedDirectory(checked.root, checked.directory);
          await fs.promises.rename(checked.directory, backupDirectory);
          oldMoved = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await fs.promises.rename(canonicalStaging, checked.directory);
        newInstalled = true;
        staged = undefined;
      } catch (swapError) {
        if (oldMoved && !newInstalled) {
          try {
            await fs.promises.rename(backupDirectory, checked.directory);
            oldMoved = false;
          } catch (rollbackError) {
            throw new Error(
              `prompt palette swap failed and rollback failed: ${boundedMcpErrorText(swapError)}; ${boundedMcpErrorText(rollbackError)}`,
            );
          }
        }
        throw swapError;
      }
      if (oldMoved) await removeContainedDirectory(checked.root, backupDirectory);
      const published = await canonicalContainedDirectory(checked.root, checked.directory);
      debug(`wrote ${(await fs.promises.readdir(published)).length} prompt stubs to ${published}`);
      return published;
    } catch (error) {
      if (staged) {
        try { await removeContainedDirectory(staged.root, staged.directory); } catch { /* report the primary failure */ }
      }
      if (!promptPublicationDiagnosticEmitted) {
        promptPublicationDiagnosticEmitted = true;
        const message = `Slash-command palette publication failed; exact typed invocation still works. ${boundedMcpErrorText(error)}`;
        try {
          if (ctx?.mode === "tui") {
            if (typeof ctx.ui?.notify !== "function") throw new Error("TUI notification unavailable");
            ctx.ui.notify(message, "warning");
          } else console.error(`PiCC: ${message}`);
        } catch {
          try { process.stderr.write(`PiCC: ${message}\n`); } catch { /* typed routing remains available */ }
        }
      }
      return undefined;
    }
  }

  pi.on("resources_discover", async (_event: any, ctx: any) => {
    let finished = false;
    const progress = setTimeout(() => {
      if (finished || ctx?.mode !== "tui") return;
      try {
        const pending = mcpRuntime.serverStates().some(
          (state) => state.state === "connecting" || state.state === "retrying",
        );
        if (pending && !promptDiscoveryProgressVisible) {
          promptDiscoveryProgressVisible = true;
          ctx.ui?.setStatus?.("picc-mcp-prompt-discovery", "Discovering MCP prompts…");
        }
      } catch { /* progress is presentation-only */ }
    }, 150);
    try {
      promptPublication ??= publishPromptStubs(ctx);
      const published = await promptPublication;
      return published ? { promptPaths: [published] } : {};
    } finally {
      finished = true;
      clearTimeout(progress);
      if (promptDiscoveryProgressVisible) {
        promptDiscoveryProgressVisible = false;
        try { ctx.ui?.setStatus?.("picc-mcp-prompt-discovery", undefined); } catch { /* presentation-only */ }
      }
    }
  });

  testSeam?.onInitializationSettled?.(Promise.all([orphanReaping, builtInRegistration]).then(() => undefined));
}

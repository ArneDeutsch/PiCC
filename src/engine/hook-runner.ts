import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { evaluateIfCondition } from "./permissions.js";
import { isDirectory } from "../util/fs.js";
import { unicodeSafeSubprocessEnv } from "../util/env.js";
import type {
  Diagnostic,
  HookConfig,
  HookHandler,
  HookOutcome,
  HookPayload,
  ToolCallDescriptor,
} from "../types.js";

/**
 * Hook execution engine.
 *
 * Fires configured hooks for a lifecycle event, delivers the Claude Code
 * stdin JSON payload, and aggregates the exit-code / stdout-JSON contract
 * into a {@link HookOutcome}. Completeness floor: `fire` never throws —
 * every failure (missing bash, spawn error, timeout, bad JSON, network
 * error) degrades to a diagnostic and execution continues.
 */

/** Events whose PLAIN (non-JSON) stdout is NOT injected as context. */
const PLAIN_STDOUT_IGNORED_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
]);

/**
 * Payload key(s) the `matcher` is compared against, per event: tool events
 * match the tool name; SessionStart the source
 * (startup|resume|clear|compact); PreCompact the trigger (manual|auto) —
 * PiCC call sites currently deliver it as `reason`, so that is accepted as a
 * fallback; Subagent* the agent type; SessionEnd the reason. Events not
 * listed here document no matcher subject and Claude ignores `matcher` there
 * (entries fire unconditionally).
 */
const MATCHER_SUBJECT_KEYS: Readonly<Record<string, readonly string[]>> = {
  PreToolUse: ["tool_name"],
  PostToolUse: ["tool_name"],
  PostToolUseFailure: ["tool_name"],
  SessionStart: ["source"],
  PreCompact: ["trigger", "reason"],
  SubagentStart: ["subagent_type", "agent_type"],
  SubagentStop: ["subagent_type", "agent_type"],
  SessionEnd: ["reason"],
};

const DEFAULT_TIMEOUT_SECONDS = 60;
/** UserPromptSubmit hooks get a tighter default (Claude caps them at 30 s). */
const USER_PROMPT_SUBMIT_TIMEOUT_SECONDS = 30;
const HTTP_TIMEOUT_MS = 10_000;
/** Grace period after a kill before we stop waiting for the process to close. */
const KILL_GRACE_MS = 5_000;
/**
 * Cap per collected context value (stdout / additionalContext): Claude Code
 * silently truncates hook context at ~10k chars (anthropics/claude-code#64626).
 */
const CONTEXT_VALUE_MAX_CHARS = 10_000;
/** Keep test-observer failures useful without allowing an arbitrary thrown value to flood output. */
const OBSERVER_ERROR_MAX_CHARS = 1_000;

/**
 * Events where exit code 2 is a BLOCK (Claude "blockable" events). Everywhere
 * else (SessionStart, PostCompact, SessionEnd, Worktree*, ...) exit 2 degrades
 * to a non-blocking warning that includes the hook's stderr.
 */
const EXIT2_BLOCKABLE_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
]);

export interface HookRunnerOptions {
  config: HookConfig;
  projectDir: string;
  sessionId: string;
  /** settings `env` — layered over process.env for hook subprocesses. */
  env: Record<string, string>;
  disableAllHooks: boolean;
  /** plugin name -> plugin root dir, for ${CLAUDE_PLUGIN_ROOT} expansion. */
  pluginRoots?: Record<string, string>;
  /** plugin name -> plugin data dir, for ${CLAUDE_PLUGIN_DATA} expansion. */
  pluginDataDirs?: Record<string, string>;
  /** Session transcript file, when the host exposes one (payload `transcript_path`). */
  transcriptPath?: () => string | undefined;
  /** Test-only observer for the successfully spawned command process. */
  onSpawnForTest?: (child: ChildProcess) => void;
}

/**
 * Effective timeout for one handler: per-hook `timeout` (seconds) wins over
 * the 60 s default. The 30 s UserPromptSubmit value is a HARD ceiling (Claude
 * caps these hooks): per-hook values below it win, above it they clamp.
 */
export function effectiveTimeoutSeconds(handler: HookHandler, eventName: string): number {
  const perHook =
    typeof handler.timeout === "number" && handler.timeout > 0 ? handler.timeout : undefined;
  if (eventName === "UserPromptSubmit") {
    return Math.min(perHook ?? USER_PROMPT_SUBMIT_TIMEOUT_SECONDS, USER_PROMPT_SUBMIT_TIMEOUT_SECONDS);
  }
  return perHook ?? DEFAULT_TIMEOUT_SECONDS;
}

/**
 * Async-hook setup failures already reported (once per distinct message per
 * process): async handlers run detached with no outcome to attach diagnostics
 * to, so spawn/setup problems are surfaced via console.error instead.
 */
const reportedAsyncHookFailures = new Set<string>();

function reportAsyncHookFailure(message: string): void {
  if (reportedAsyncHookFailures.has(message)) return;
  reportedAsyncHookFailures.add(message);
  console.error(`[picc] async hook: ${message}`);
}

type HandlerResult =
  | { kind: "exit"; code: number; stdout: string; stderr: string }
  | { kind: "timeout"; timeoutSec: number }
  | { kind: "error"; message: string };

export class HookRunner {
  private readonly opts: HookRunnerOptions;
  /** Handlers with `once: true` that have already fired (object identity). */
  private readonly firedOnce = new Set<HookHandler>();
  /** Cached bash resolution: undefined = not attempted, null = not found. */
  private bashPath: string | null | undefined;

  constructor(opts: HookRunnerOptions) {
    this.opts = opts;
  }

  /**
   * Cheap config probe: does `eventName` have any configured entries at all?
   * Lets callers skip expensive payload construction (e.g. the guard's
   * structured tool_response) when a fire() would be a no-op anyway.
   */
  hasHooks(eventName: string): boolean {
    try {
      if (this.opts.disableAllHooks) return false;
      const entries = this.opts.config?.[eventName];
      return Array.isArray(entries) && entries.length > 0;
    } catch {
      return false;
    }
  }

  async fire(
    eventName: string,
    payload: Partial<HookPayload>,
    toolCall?: ToolCallDescriptor,
  ): Promise<HookOutcome> {
    const outcome: HookOutcome = { block: false, askDowngraded: false, diagnostics: [] };
    try {
      if (this.opts.disableAllHooks) return outcome;
      const entries = this.opts.config?.[eventName];
      if (!entries || entries.length === 0) return outcome;

      // Full stdin payload: merge the caller's fields, then fill/force the
      // required ones. Paths stay in native (Windows backslash) form;
      // JSON.stringify escapes the backslashes on the wire as Claude does.
      const fullPayload: HookPayload = {
        ...payload,
        session_id:
          typeof payload.session_id === "string" && payload.session_id.length > 0
            ? payload.session_id
            : this.opts.sessionId,
        cwd:
          typeof payload.cwd === "string" && payload.cwd.length > 0
            ? payload.cwd
            : this.opts.projectDir,
        hook_event_name: eventName,
        // The harness runs one (default-permissive) posture — the field is
        // constant, but real Claude hooks read it.
        permission_mode:
          typeof payload.permission_mode === "string" && payload.permission_mode.length > 0
            ? payload.permission_mode
            : "default",
      };
      const transcriptPath =
        typeof payload.transcript_path === "string" && payload.transcript_path.length > 0
          ? payload.transcript_path
          : this.safeTranscriptPath();
      if (transcriptPath !== undefined) fullPayload.transcript_path = transcriptPath;

      // Selection first (config order): matcher/if/once gates, then handlers
      // whose (type, command, args, shell, url) are identical are deduplicated
      // — Claude runs identical commands once per event firing.
      const selected: HookHandler[] = [];
      const seenKeys = new Set<string>();
      for (const entry of entries) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        if (!this.matcherMatches(entry.matcher, eventName, fullPayload, outcome.diagnostics)) {
          continue;
        }
        if (entry.if !== undefined && entry.if !== "") {
          // `if:` needs a tool call to evaluate against; without one the
          // entry is skipped (conservative: an unevaluable condition is
          // treated as not met).
          if (!toolCall) continue;
          let matched = false;
          try {
            matched = evaluateIfCondition(entry.if, toolCall);
          } catch (err) {
            outcome.diagnostics.push({
              severity: "warning",
              message: `hook (${eventName}) if-condition "${entry.if}" failed to evaluate: ${errText(err)}; entry skipped`,
            });
          }
          if (!matched) continue;
        }

        for (const handler of entry.hooks) {
          if (!handler) continue;
          if (handler.once && this.firedOnce.has(handler)) continue;
          const key = dedupKey(handler);
          if (seenKeys.has(key)) {
            // A deduped-away duplicate counts as fired too, or its own
            // `once: true` identity would fire on the NEXT fire().
            if (handler.once) this.firedOnce.add(handler);
            continue;
          }
          seenKeys.add(key);
          // The first occurrence's object identity carries the once-tracking.
          if (handler.once) this.firedOnce.add(handler);
          selected.push(handler);
        }
      }

      const contextPieces: string[] = [];
      const stdoutPieces: string[] = [];

      // All selected handlers run concurrently (Claude parallel execution);
      // outcomes merge in CONFIG order — first block wins, contexts/stdout
      // concatenate, updatedInput shallow-merges — so results stay
      // deterministic regardless of completion order.
      const runs = await Promise.all(
        selected.map((handler) => this.runHandler(handler, eventName, fullPayload)),
      );
      for (const run of runs) {
        outcome.diagnostics.push(...run.diagnostics);
        if (run.result) {
          this.applyResult(run.result, eventName, outcome, contextPieces, stdoutPieces);
        }
      }

      if (contextPieces.length > 0) outcome.additionalContext = contextPieces.join("\n");
      if (stdoutPieces.length > 0) outcome.stdout = stdoutPieces.join("\n");
    } catch (err) {
      outcome.diagnostics.push({
        severity: "error",
        message: `hook engine error for ${eventName}: ${errText(err)}`,
      });
    }
    return outcome;
  }

  /**
   * Runs one selected handler with its own diagnostics list (results merge in
   * config order, so diagnostics must not interleave across parallel runs).
   * `async: true` handlers are fire-and-forget: spawned, never awaited, output
   * and exit code ignored (debug-only trace) and excluded from outcome merging.
   */
  private async runHandler(
    handler: HookHandler,
    eventName: string,
    fullPayload: HookPayload,
  ): Promise<{ result: HandlerResult | undefined; diagnostics: Diagnostic[] }> {
    const diagnostics: Diagnostic[] = [];
    if (handler.type !== "command" && handler.type !== "http") {
      diagnostics.push({
        severity: "info",
        message: `hook (${eventName}): handler type "${handler.type}" degraded to no-op`,
      });
      return { result: undefined, diagnostics };
    }
    if (handler.async === true) {
      // runCommand/runHttp never reject (resolve-only promises), so nothing
      // can escape this detached chain; completion is traced at debug level.
      // Setup failures (bash missing, unreachable http hook, ...) land in
      // asyncDiagnostics and are surfaced once per distinct message — an
      // async hook that can never run must not fail silently.
      const asyncDiagnostics: Diagnostic[] = [];
      const detached =
        handler.type === "command"
          ? this.runCommand(handler, eventName, fullPayload, asyncDiagnostics)
          : this.runHttp(handler, eventName, fullPayload, asyncDiagnostics);
      void detached
        .then((result) => {
          for (const d of asyncDiagnostics) {
            if (d.severity === "warning" || d.severity === "error") {
              reportAsyncHookFailure(d.message);
            }
          }
          if (result?.kind === "error") {
            reportAsyncHookFailure(`hook (${eventName}) failed to run: ${result.message}`);
          }
          if (!process.env["PICC_DEBUG"] || !result) return;
          if (result.kind === "exit" && result.code !== 0) {
            console.error(
              `[picc] async hook (${eventName}) exited with code ${result.code} (ignored)`,
            );
          } else if (result.kind === "timeout") {
            console.error(
              `[picc] async hook (${eventName}) timed out after ${result.timeoutSec}s (ignored)`,
            );
          }
        })
        .catch(() => {
          // Defense in depth: detached hooks have no outcome to carry a
          // rejection. Never include the rejected value, whose coercion may
          // itself be hostile, and never let reporting create another one.
          try {
            reportAsyncHookFailure("detached async hook processing failed");
          } catch {
            /* terminal rejection handlers must remain non-throwing */
          }
        });
      return { result: undefined, diagnostics };
    }
    const result =
      handler.type === "command"
        ? await this.runCommand(handler, eventName, fullPayload, diagnostics)
        : await this.runHttp(handler, eventName, fullPayload, diagnostics);
    return { result, diagnostics };
  }

  /** Transcript path from the host, or undefined — the getter must never throw into fire(). */
  private safeTranscriptPath(): string | undefined {
    try {
      const value = this.opts.transcriptPath?.();
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Entry selection
  // -------------------------------------------------------------------------

  private matcherMatches(
    matcher: string | undefined,
    eventName: string,
    payload: HookPayload,
    diagnostics: Diagnostic[],
  ): boolean {
    if (matcher === undefined || matcher === "" || matcher === "*" || matcher === ".*") {
      return true;
    }
    const subjectKeys = MATCHER_SUBJECT_KEYS[eventName];
    // Events without a documented matcher subject (Stop, UserPromptSubmit,
    // Worktree*, ...): Claude ignores `matcher` there — treat as match-all.
    if (!subjectKeys) return true;
    let subject: string | undefined;
    for (const key of subjectKeys) {
      const value = payload[key];
      if (typeof value === "string" && value.length > 0) {
        subject = value;
        break;
      }
    }
    // The event documents a subject but the payload lacks it: conservative
    // no-match (an unevaluable matcher is treated as not met).
    if (subject === undefined) return false;
    // Claude semantics: a matcher of plain names is an EXACT-match alternative
    // list — `|` and `,` (v2.1.191) separate alternatives, so "Edit" never
    // matches NotebookEdit. Anything containing regex metacharacters is a JS
    // regex tested UNANCHORED (substring), case-sensitive.
    if (/^[A-Za-z0-9_\- |,]*$/.test(matcher)) {
      return matcher
        .split(/[|,]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .some((part) => part === subject);
    }
    try {
      return new RegExp(matcher).test(subject);
    } catch {
      diagnostics.push({
        severity: "warning",
        message: `hook matcher "${matcher}" is not a valid regex; entry skipped`,
      });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Command handlers
  // -------------------------------------------------------------------------

  private async runCommand(
    handler: HookHandler,
    eventName: string,
    fullPayload: HookPayload,
    diagnostics: Diagnostic[],
  ): Promise<HandlerResult | undefined> {
    if (typeof handler.command !== "string" || handler.command.length === 0) {
      diagnostics.push({
        severity: "warning",
        message: `hook (${eventName}): command handler has no command; skipped`,
      });
      return undefined;
    }

    let commandStr = this.expandPlaceholders(handler.command, handler, eventName, diagnostics);
    const shellKind = handler.shell === "powershell" ? "powershell" : "bash";
    if (handler.args && handler.args.length > 0) {
      // Placeholders are expanded in args too — quoting (single quotes for
      // bash) would otherwise also block env-var expansion at runtime.
      commandStr +=
        " " +
        handler.args
          .map((a) =>
            quoteArg(this.expandPlaceholders(a, handler, eventName, diagnostics), shellKind),
          )
          .join(" ");
    }

    let file: string;
    let argv: string[];
    if (shellKind === "powershell") {
      file = "powershell";
      argv = ["-NoProfile", "-Command", commandStr];
    } else {
      const bash = this.resolveBash();
      if (!bash) {
        diagnostics.push({
          severity: "warning",
          message: `hook (${eventName}): bash not found on PATH (Git Bash required on Windows); command hook degraded to no-op`,
        });
        return undefined;
      }
      file = bash;
      argv = ["-c", commandStr];
    }

    const env: NodeJS.ProcessEnv = unicodeSafeSubprocessEnv({
      ...process.env,
      ...this.opts.env,
      CLAUDE_PROJECT_DIR: this.opts.projectDir,
      CLAUDE_SESSION_ID: this.opts.sessionId,
      CLAUDE_HOOK_EVENT: eventName,
    });
    const timeoutSec = effectiveTimeoutSeconds(handler, eventName);

    // Hooks run in the payload's cwd (Claude semantics): a WorktreeCreate hook
    // must execute inside the new worktree, not the main checkout.
    const spawnCwd =
      typeof fullPayload.cwd === "string" && fullPayload.cwd.length > 0 && isDirectory(fullPayload.cwd)
        ? fullPayload.cwd
        : this.opts.projectDir;

    return await new Promise<HandlerResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(file, argv, {
          cwd: spawnCwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        resolve({ kind: "error", message: errText(err) });
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let killFallback: NodeJS.Timeout | undefined;

      const finish = (result: HandlerResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killFallback) clearTimeout(killFallback);
        resolve(result);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        // Failsafe: never hang the session waiting on a stuck process.
        killFallback = setTimeout(() => finish({ kind: "timeout", timeoutSec }), KILL_GRACE_MS);
        killFallback.unref?.();
      }, timeoutSec * 1000);

      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => finish({ kind: "error", message: err.message }));
      child.on("close", (code) => {
        if (timedOut) finish({ kind: "timeout", timeoutSec });
        else finish({ kind: "exit", code: code ?? -1, stdout, stderr });
      });
      // Ignore EPIPE when the hook exits without reading stdin.
      child.stdin?.on("error", () => {});

      // The test observer runs only after HookRunner owns the child's complete
      // lifecycle. It is genuinely observational: a broken observer adds a
      // warning but cannot alter command execution, stdin delivery, timeout,
      // or the normal error/close settlement path.
      try {
        this.opts.onSpawnForTest?.(child);
      } catch (err) {
        diagnostics.push({
          severity: "warning",
          message: `hook (${eventName}): spawn observer failed: ${truncateObserverError(errText(err))}; continuing`,
        });
      }

      child.stdin?.end(JSON.stringify(fullPayload));
    });
  }

  /**
   * Expand `${CLAUDE_PROJECT_DIR}` / `$CLAUDE_PROJECT_DIR` and (for
   * plugin-contributed handlers) `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}`
   * in a command string or argument before spawning. Replacement values are
   * inserted verbatim (no `$&` pitfalls) via replacer functions.
   */
  private expandPlaceholders(
    command: string,
    handler: HookHandler,
    eventName: string,
    diagnostics: Diagnostic[],
  ): string {
    const project = this.opts.projectDir;
    let out = command
      .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, () => project)
      .replace(/\$CLAUDE_PROJECT_DIR(?![A-Za-z0-9_])/g, () => project);

    const pluginName =
      typeof handler.raw?.["__pluginName"] === "string"
        ? (handler.raw["__pluginName"] as string)
        : undefined;
    const expandPluginVar = (
      varName: string,
      value: string | undefined,
      description: string,
    ): void => {
      const re = new RegExp(`\\$\\{${varName}\\}|\\$${varName}(?![A-Za-z0-9_])`, "g");
      if (!re.test(out)) return;
      if (value !== undefined) {
        out = out.replace(re, () => value);
      } else {
        diagnostics.push({
          severity: "warning",
          message: `hook (${eventName}): command references \${${varName}} but no plugin ${description} is known${
            pluginName ? ` for plugin "${pluginName}"` : ""
          }; left unexpanded`,
        });
      }
    };
    expandPluginVar(
      "CLAUDE_PLUGIN_ROOT",
      pluginName ? this.opts.pluginRoots?.[pluginName] : undefined,
      "root",
    );
    expandPluginVar(
      "CLAUDE_PLUGIN_DATA",
      pluginName ? this.opts.pluginDataDirs?.[pluginName] : undefined,
      "data dir",
    );
    return out;
  }

  /** Resolve bash: on Windows scan PATH for Git Bash (skip the WSL launcher in System32), plus standard Git install locations. */
  private resolveBash(): string | undefined {
    if (this.bashPath !== undefined) return this.bashPath ?? undefined;
    if (process.platform !== "win32") {
      this.bashPath = "bash";
      return "bash";
    }
    const candidates: string[] = [];
    for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
      if (!dir || /system32/i.test(dir)) continue;
      candidates.push(path.join(dir, "bash.exe"));
      // Git installs put <root>\cmd\git.exe on PATH but keep bash.exe in
      // <root>\bin / <root>\usr\bin — derive the siblings so user-local
      // installs (e.g. %LOCALAPPDATA%\Programs\Git) are found too.
      if (/[\\/]cmd[\\/]?$/i.test(dir)) {
        const root = path.dirname(dir.replace(/[\\/]+$/, ""));
        candidates.push(
          path.join(root, "bin", "bash.exe"),
          path.join(root, "usr", "bin", "bash.exe"),
        );
      }
    }
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    candidates.push(
      path.join(programFiles, "Git", "bin", "bash.exe"),
      path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    );
    const localAppData = process.env["LOCALAPPDATA"];
    if (localAppData) {
      candidates.push(path.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
    }
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) {
          this.bashPath = candidate;
          return candidate;
        }
      } catch {
        /* keep scanning */
      }
    }
    this.bashPath = null;
    return undefined;
  }

  // -------------------------------------------------------------------------
  // HTTP handlers (best-effort)
  // -------------------------------------------------------------------------

  private async runHttp(
    handler: HookHandler,
    eventName: string,
    fullPayload: HookPayload,
    diagnostics: Diagnostic[],
  ): Promise<HandlerResult | undefined> {
    const url = handler.url;
    if (typeof url !== "string" || url.length === 0) {
      diagnostics.push({
        severity: "warning",
        message: `hook (${eventName}): http handler has no url; skipped`,
      });
      return undefined;
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fullPayload),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) {
        diagnostics.push({
          severity: "warning",
          message: `hook (${eventName}): http hook ${url} returned status ${response.status}; continuing`,
        });
        return undefined;
      }
      // Response body is treated exactly like command stdout on exit 0.
      return { kind: "exit", code: 0, stdout: text, stderr: "" };
    } catch (err) {
      diagnostics.push({
        severity: "warning",
        message: `hook (${eventName}): http hook ${url} failed: ${errText(err)}; continuing`,
      });
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Outcome aggregation (exit-code + stdout-JSON contract)
  // -------------------------------------------------------------------------

  private applyResult(
    result: HandlerResult,
    eventName: string,
    outcome: HookOutcome,
    contextPieces: string[],
    stdoutPieces: string[],
  ): void {
    if (result.kind === "error") {
      outcome.diagnostics.push({
        severity: "warning",
        message: `hook (${eventName}) failed to run: ${result.message}`,
      });
      return;
    }
    if (result.kind === "timeout") {
      outcome.diagnostics.push({
        severity: "warning",
        message: `hook (${eventName}) timed out after ${result.timeoutSec}s and was killed; continuing`,
      });
      return;
    }

    const { code, stdout, stderr } = result;

    if (code === 2) {
      if (EXIT2_BLOCKABLE_EVENTS.has(eventName)) {
        // Blocking error: stderr (falling back to stdout) is the reason.
        const reason = stderr.trim() || stdout.trim();
        this.setBlock(outcome, reason || undefined);
      } else {
        // Claude: exit 2 on non-blockable events (SessionStart, PostCompact,
        // ...) shows stderr and continues.
        outcome.diagnostics.push({
          severity: "warning",
          message: `hook (${eventName}) exited with code 2, but ${eventName} is not blockable; continuing${
            stderr.trim() ? `: ${stderr.trim()}` : ""
          }`,
        });
      }
      return;
    }
    if (code !== 0) {
      outcome.diagnostics.push({
        severity: "warning",
        message: `hook (${eventName}) exited with code ${code} (non-blocking)${
          stderr.trim() ? `: ${stderr.trim()}` : ""
        }`,
      });
      return;
    }

    // Exit 0 — try the JSON stdout contract first.
    const trimmed = stdout.trim();
    let json: Record<string, unknown> | undefined;
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>;
        }
      } catch {
        /* not JSON — plain stdout handling below */
      }
    }

    if (json === undefined) {
      // Plain stdout: injected as context for the context-injecting events
      // (UserPromptSubmit, SessionStart, PreCompact, Stop, ...); ignored for
      // PreToolUse/PostToolUse (matches Claude).
      if (trimmed && !PLAIN_STDOUT_IGNORED_EVENTS.has(eventName)) {
        stdoutPieces.push(truncateContextValue(trimmed));
      }
      return;
    }

    // `systemMessage`: user-facing text, surfaced once by the call sites
    // (info-level notice, not model context).
    const systemMessage = json["systemMessage"];
    if (typeof systemMessage === "string" && systemMessage.length > 0) {
      (outcome.systemMessages ??= []).push(systemMessage);
    }
    // `suppressOutput: true` hides the hook's plain stdout from context. On the
    // JSON path the raw stdout IS the JSON document and is never injected, so
    // the flag is inherently honored; structured fields (additionalContext,
    // decisions, ...) below stay in effect regardless.

    const hso = asRecord(json["hookSpecificOutput"]);
    // Claude Code's hook schema requires hookSpecificOutput.hookEventName
    // (anthropics/claude-code#55172); a mismatch is worth a warning but the
    // fields are honored anyway (graceful superset).
    const hsoEventName = hso?.["hookEventName"];
    if (typeof hsoEventName === "string" && hsoEventName !== eventName) {
      outcome.diagnostics.push({
        severity: "warning",
        message: `hook (${eventName}): hookSpecificOutput.hookEventName is "${hsoEventName}" but the firing event is "${eventName}"; fields honored anyway`,
      });
    }

    const decision = hso?.["permissionDecision"];
    if (decision === "deny") {
      const reason = hso?.["permissionDecisionReason"];
      this.setBlock(outcome, typeof reason === "string" ? reason : undefined);
    } else if (decision === "ask") {
      // Downgraded to allow (default-permissive posture), but surfaced.
      outcome.askDowngraded = true;
    }
    // "allow" / "defer" → proceed.

    for (const ctx of [hso?.["additionalContext"], json["additionalContext"]]) {
      if (typeof ctx === "string" && ctx.length > 0) contextPieces.push(truncateContextValue(ctx));
    }

    const updated = asRecord(hso?.["updatedInput"]) ?? asRecord(json["updatedInput"]);
    if (updated) outcome.updatedInput = { ...outcome.updatedInput, ...updated };

    // Stop-hook style top-level block.
    if (json["decision"] === "block") {
      const reason = json["reason"];
      this.setBlock(outcome, typeof reason === "string" ? reason : undefined);
    }
    if (json["continue"] === false) {
      const stopReason = json["stopReason"];
      this.setBlock(outcome, typeof stopReason === "string" ? stopReason : undefined);
    }
  }

  /** First block wins: later blocks don't overwrite the original reason. */
  private setBlock(outcome: HookOutcome, reason: string | undefined): void {
    if (outcome.block) return;
    outcome.block = true;
    if (reason !== undefined) outcome.blockReason = reason;
  }
}

/**
 * The minimal structural surface the scoped-hook seam actually consumes: `fire`
 * (required) plus the optional `hasHooks` config probe. The runtime facades
 * (multiplexers, identity injectors) implement only `fire`, so `hasHooks` is
 * optional here and its callers guard it with `typeof … === "function"`. A real
 * `HookRunner` satisfies this alias, so genuine runners still flow through.
 */
export type HookRunnerLike = Pick<HookRunner, "fire"> & Partial<Pick<HookRunner, "hasHooks">>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Dedup identity within one fire(): identical commands/urls run once (Claude). */
function dedupKey(handler: HookHandler): string {
  return JSON.stringify([
    handler.type,
    handler.command ?? null,
    handler.args ?? null,
    handler.shell ?? null,
    handler.url ?? null,
  ]);
}

/** Each context value is capped at ~10,000 chars, silently truncated as Claude Code does. */
function truncateContextValue(value: string): string {
  if (value.length <= CONTEXT_VALUE_MAX_CHARS) return value;
  return `${value.slice(0, CONTEXT_VALUE_MAX_CHARS)}…[truncated]`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function truncateObserverError(value: string): string {
  if (value.length <= OBSERVER_ERROR_MAX_CHARS) return value;
  return `${value.slice(0, OBSERVER_ERROR_MAX_CHARS)}…[truncated]`;
}

function errText(err: unknown): string {
  // Reading `message`, checking exotic object identity, and string coercion
  // can all execute user code. Keep every operation guarded and use a
  // content-free fallback so error reporting itself can never escape.
  if ((typeof err === "object" && err !== null) || typeof err === "function") {
    try {
      const message = (err as { message?: unknown }).message;
      if (typeof message === "string") return message;
    } catch {
      // Fall through to guarded whole-value coercion.
    }
  }
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

function quoteArg(arg: string, shellKind: "bash" | "powershell"): string {
  if (shellKind === "powershell") return `'${arg.replace(/'/g, "''")}'`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Kill a hook process and its children; never throws. */
function killProcessTree(child: ChildProcess): void {
  try {
    if (process.platform === "win32" && child.pid) {
      // taskkill /T kills the whole tree (bash + whatever it spawned).
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      });
      killer.unref();
      return;
    }
  } catch {
    /* fall through to plain kill */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

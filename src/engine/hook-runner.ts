import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { evaluateIfCondition } from "./permissions.js";
import { isDirectory } from "../util/fs.js";
import type {
  Diagnostic,
  HookConfig,
  HookHandler,
  HookOutcome,
  HookPayload,
  ToolCallDescriptor,
} from "../types.js";

/**
 * Hook execution engine (plan §4.5, research 02 §3.4–3.6).
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

const DEFAULT_TIMEOUT_SECONDS = 60;
const HTTP_TIMEOUT_MS = 10_000;
/** Grace period after a kill before we stop waiting for the process to close. */
const KILL_GRACE_MS = 5_000;

export interface HookRunnerOptions {
  config: HookConfig;
  projectDir: string;
  sessionId: string;
  /** settings `env` — layered over process.env for hook subprocesses. */
  env: Record<string, string>;
  disableAllHooks: boolean;
  /** plugin name -> plugin root dir, for ${CLAUDE_PLUGIN_ROOT} expansion. */
  pluginRoots?: Record<string, string>;
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
      };

      const contextPieces: string[] = [];
      const stdoutPieces: string[] = [];

      for (const entry of entries) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        if (!this.matcherMatches(entry.matcher, fullPayload, outcome.diagnostics)) continue;
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
          if (handler.once) {
            if (this.firedOnce.has(handler)) continue;
            this.firedOnce.add(handler);
          }

          let result: HandlerResult | undefined;
          if (handler.type === "command") {
            result = await this.runCommand(handler, eventName, fullPayload, outcome.diagnostics);
          } else if (handler.type === "http") {
            result = await this.runHttp(handler, eventName, fullPayload, outcome.diagnostics);
          } else {
            outcome.diagnostics.push({
              severity: "info",
              message: `hook (${eventName}): handler type "${handler.type}" degraded to no-op`,
            });
            continue;
          }
          if (result) {
            this.applyResult(result, eventName, outcome, contextPieces, stdoutPieces);
          }
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

  // -------------------------------------------------------------------------
  // Entry selection
  // -------------------------------------------------------------------------

  private matcherMatches(
    matcher: string | undefined,
    payload: HookPayload,
    diagnostics: Diagnostic[],
  ): boolean {
    if (matcher === undefined || matcher === "" || matcher === "*") return true;
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    if (toolName === undefined) return false;
    try {
      // Claude matchers are unanchored regexes ("Bash", "Edit|Write", "^Edit$").
      return new RegExp(matcher).test(toolName);
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
      commandStr += " " + handler.args.map((a) => quoteArg(a, shellKind)).join(" ");
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

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.opts.env,
      CLAUDE_PROJECT_DIR: this.opts.projectDir,
      CLAUDE_SESSION_ID: this.opts.sessionId,
      CLAUDE_HOOK_EVENT: eventName,
    };
    const timeoutSec =
      typeof handler.timeout === "number" && handler.timeout > 0
        ? handler.timeout
        : DEFAULT_TIMEOUT_SECONDS;

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
      child.stdin?.end(JSON.stringify(fullPayload));
    });
  }

  /**
   * Expand `${CLAUDE_PROJECT_DIR}` / `$CLAUDE_PROJECT_DIR` and (for
   * plugin-contributed handlers) `${CLAUDE_PLUGIN_ROOT}` in a command string
   * before spawning. Replacement values are inserted verbatim (no `$&`
   * pitfalls) via replacer functions.
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

    const pluginRe = /\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT(?![A-Za-z0-9_])/g;
    if (pluginRe.test(out)) {
      const pluginName =
        typeof handler.raw?.["__pluginName"] === "string"
          ? (handler.raw["__pluginName"] as string)
          : undefined;
      const root = pluginName ? this.opts.pluginRoots?.[pluginName] : undefined;
      if (root !== undefined) {
        out = out.replace(pluginRe, () => root);
      } else {
        diagnostics.push({
          severity: "warning",
          message: `hook (${eventName}): command references \${CLAUDE_PLUGIN_ROOT} but no plugin root is known${
            pluginName ? ` for plugin "${pluginName}"` : ""
          }; left unexpanded`,
        });
      }
    }
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
    }
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    candidates.push(
      path.join(programFiles, "Git", "bin", "bash.exe"),
      path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    );
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
  // HTTP handlers (best-effort per plan §4.5)
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
      // Blocking error: stderr (falling back to stdout) is the reason.
      const reason = stderr.trim() || stdout.trim();
      this.setBlock(outcome, reason || undefined);
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
        stdoutPieces.push(trimmed);
      }
      return;
    }

    const hso = asRecord(json["hookSpecificOutput"]);

    const decision = hso?.["permissionDecision"];
    if (decision === "deny") {
      const reason = hso?.["permissionDecisionReason"];
      this.setBlock(outcome, typeof reason === "string" ? reason : undefined);
    } else if (decision === "ask") {
      // Downgraded to allow per posture §6.1, but surfaced.
      outcome.askDowngraded = true;
    }
    // "allow" / "defer" → proceed.

    for (const ctx of [hso?.["additionalContext"], json["additionalContext"]]) {
      if (typeof ctx === "string" && ctx.length > 0) contextPieces.push(ctx);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

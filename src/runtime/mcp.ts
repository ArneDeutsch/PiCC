import { unicodeSafeSubprocessEnv } from "../util/env.js";
import { killProcessTreeByPid, listDescendantPids } from "../util/process-tree.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import type { ResolvedMcpConfig, ResolvedMcpServer } from "../types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * MCP stdio runtime manager.
 *
 * Starts the ENABLED servers of a {@link ResolvedMcpConfig} as long-lived
 * stdio child processes via the `@modelcontextprotocol/sdk` client, exposes
 * their tools and a call API, and kills every server (process trees included,
 * Windows too) at shutdown. Session-global and non-blocking: `start()`
 * returns immediately, connects run in the background bounded by
 * `MCP_TIMEOUT`, and every failure degrades to a diagnostic — never a throw,
 * never a crash. With zero enabled servers nothing is imported and nothing is
 * spawned: the zero-cost path.
 *
 * Model-facing registration is NOT here — this class only owns processes,
 * connections, and tool metadata; the tool-exposure layer consumes it.
 */

/** Default connect bound — binary-verified Claude default (2.1.218): unset `MCP_TIMEOUT` → 30 000 ms. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
/** Shutdown failsafe per server: never hang on a stuck process (hook-runner precedent). */
const SHUTDOWN_GRACE_MS = 5_000;
/**
 * Per-server stderr retention. A ring (tail) rather than a concat: these are
 * LONG-LIVED processes, so unbounded accumulation is a leak, and the most
 * recent output is what explains a failure.
 */
const STDERR_RING_MAX_CHARS = 4_096;
/** Slice of the stderr ring quoted inside a failure diagnostic. */
const STDERR_EXCERPT_MAX_CHARS = 400;
/** Tool description bound (2 KB, Claude parity). */
const DESCRIPTION_MAX_CHARS = 2_048;
/** Bound on server-supplied error text quoted in a callTool rejection. */
const CALL_ERROR_MAX_CHARS = 1_000;
/** Bound on a server-supplied tool name quoted inside a diagnostic. */
const DIAG_NAME_MAX_CHARS = 200;
/**
 * Per-server cap on tool-metadata diagnostics (drops/sanitizes/dedupes): a
 * hostile tool list must not flood diagnostics(); overflow collapses into one
 * "…and K more" summary line.
 */
const TOOL_DIAG_MAX_PER_SERVER = 5;
/**
 * Tool-call timeout when neither per-server `timeoutMs` nor `MCP_TOOL_TIMEOUT`
 * is set — Claude's binary-verified unset default (2.1.218), ~27.8 h.
 */
const DEFAULT_TOOL_TIMEOUT_MS = 100_000_000;
/**
 * Claude clamps the resolved tool timeout to exactly
 * `Math.min(Math.max(n, 1000), 2147483647)` (binary-verified 2.1.218). The max
 * is also Node's TIMEOUT_MAX: an unclamped over-max value would overflow the
 * SDK's setTimeout and fire at ~1 ms.
 */
const TOOL_TIMEOUT_MIN_MS = 1_000;
const TOOL_TIMEOUT_MAX_MS = 2_147_483_647;
/** Poll cadence while capturing the transport's pid during connect. */
const PID_POLL_MS = 25;
/** SDK McpError code for a timed-out request. */
const MCP_ERROR_REQUEST_TIMEOUT = -32_001;

/**
 * Claude-parity tool-name sanitizer (binary-verified 2.1.218): every character
 * outside `[A-Za-z0-9_-]` is replaced with `_` and the tool is KEPT; only a
 * name that is empty after sanitizing is dropped. Sanitizing (not dropping)
 * keeps `mcp__<server>__<tool>` names deny-rule-compatible while matching what
 * Claude actually exposes. The stricter drop semantics apply only to MCP
 * server names (`SERVER_NAME_RE` in claude/mcp-config.ts) — those are
 * PiCC-side config, not server-supplied data.
 */
const TOOL_NAME_SANITIZE_RE = /[^A-Za-z0-9_-]/g;

export interface McpToolInfo {
  serverName: string;
  /** Server-supplied, validated against the safe charset. */
  toolName: string;
  /** Bounded (2 KB) and control/escape-stripped. */
  description: string;
  /** Raw JSON Schema from the server. */
  inputSchema: unknown;
}

export interface McpRuntimeDeps {
  /**
   * Spawn cwd and `CLAUDE_PROJECT_DIR` — deliberately the project root, never
   * the live cwd: worktree drift must not change command resolution.
   */
  projectRoot: string;
  /** `CLAUDE_CODE_SESSION_ID` for the servers — binary-verified Claude behavior (2.1.218; undocumented). */
  sessionId: string;
  /**
   * Base environment for the servers AND the source of `MCP_TIMEOUT` /
   * `MCP_TOOL_TIMEOUT`. Defaults to `process.env`; injectable for tests.
   */
  env?: Record<string, string | undefined>;
}

export interface McpServerState {
  name: string;
  state: "connecting" | "connected" | "failed";
  toolCount?: number;
  diagnostic?: string;
}

interface ServerHandle {
  server: ResolvedMcpServer;
  state: "connecting" | "connected" | "failed";
  client?: Client;
  transport?: StdioClientTransport;
  /** Captured out-of-band: transport.pid nulls on close and connect() may never return. */
  pid?: number;
  pidPoller?: NodeJS.Timeout;
  tools: McpToolInfo[];
  diagnostic?: string;
  stderrRing: string;
  /** True once shutdown() has processed (or pre-empted) this server. */
  stopped: boolean;
  /** True once this handle has counted toward whenSettled(). */
  settled: boolean;
}

export class McpRuntime {
  private readonly deps: McpRuntimeDeps;
  private readonly handles: ServerHandle[] = [];
  private readonly diags: string[] = [];
  private readonly connectTimeoutMs: number;
  private readonly toolTimeoutMs: number | undefined;
  private settleResolve: (() => void) | undefined;
  private readonly settlePromise: Promise<void>;
  private unsettledCount = 0;
  private shutdownPromise: Promise<void> | undefined;
  private exitHookRegistered = false;

  /**
   * Last-resort sweep for a dying harness process: taskkill (a spawn) cannot
   * run during `exit`, so this is a synchronous direct kill of each tracked
   * server pid — grandchildren may survive a hard kill of PiCC itself
   * (accepted). Registered lazily on first spawn and removed in shutdown():
   * the extension is constructed many times per test process, and an
   * unconditional per-instance listener would accumulate.
   */
  private readonly exitListener = (): void => {
    for (const handle of this.handles) {
      if (handle.stopped || handle.pid === undefined) continue;
      try {
        process.kill(handle.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };

  private constructor(config: ResolvedMcpConfig, deps: McpRuntimeDeps) {
    this.deps = deps;
    const env = deps.env ?? process.env;
    this.connectTimeoutMs = parsePositiveInt(env["MCP_TIMEOUT"]) ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.toolTimeoutMs = parsePositiveInt(env["MCP_TOOL_TIMEOUT"]);
    for (const server of config.servers) {
      if (server.status !== "enabled") continue;
      this.handles.push({
        server,
        state: "connecting",
        tools: [],
        stderrRing: "",
        stopped: false,
        settled: false,
      });
    }
    this.unsettledCount = this.handles.length;
    if (this.unsettledCount === 0) {
      this.settlePromise = Promise.resolve();
    } else {
      this.settlePromise = new Promise<void>((resolve) => {
        this.settleResolve = resolve;
      });
    }
  }

  /** Returns immediately; enabled servers connect in the background. */
  static start(config: ResolvedMcpConfig, deps: McpRuntimeDeps): McpRuntime {
    const runtime = new McpRuntime(config, deps);
    if (runtime.handles.length > 0) {
      // Detached background connect; connectAll never rejects.
      void runtime.connectAll();
    }
    return runtime;
  }

  /** Resolves when every enabled server is connected OR failed/timed out; never rejects. */
  whenSettled(): Promise<void> {
    return this.settlePromise;
  }

  /** Tools of connected servers; `[]` before settle. */
  tools(): McpToolInfo[] {
    const out: McpToolInfo[] = [];
    for (const handle of this.handles) {
      if (handle.state === "connected") out.push(...handle.tools);
    }
    return out;
  }

  /** Connect failures, timeouts, dropped tools, stderr excerpts — all bounded. */
  diagnostics(): string[] {
    return [...this.diags];
  }

  /** Live state of the ENABLED servers (pending/disabled/skipped stay in ResolvedMcpConfig). */
  serverStates(): McpServerState[] {
    return this.handles.map((handle) => ({
      name: handle.server.name,
      state: handle.state,
      ...(handle.state === "connected" ? { toolCount: handle.tools.length } : {}),
      ...(handle.diagnostic !== undefined ? { diagnostic: handle.diagnostic } : {}),
    }));
  }

  /** Rejects with a descriptive Error on failure/timeout; result is the raw MCP call result. */
  async callTool(serverName: string, toolName: string, args: unknown): Promise<unknown> {
    const handle = this.handles.find((h) => h.server.name === serverName);
    if (!handle) {
      // Caller-supplied names are the one interpolation here that never went
      // through validation — neutralize before quoting.
      throw new Error(
        `MCP server "${neutralizeControlChars(serverName)}" is not running (not configured or not enabled)`,
      );
    }
    if (handle.state !== "connected" || !handle.client) {
      throw new Error(
        `MCP server "${serverName}" is not connected` +
          (handle.diagnostic ? ` (${handle.diagnostic})` : ""),
      );
    }
    if (!handle.tools.some((tool) => tool.toolName === toolName)) {
      throw new Error(
        `MCP server "${serverName}" has no tool "${neutralizeControlChars(toolName)}"`,
      );
    }
    // Per-server `timeout` wins; else MCP_TOOL_TIMEOUT; else Claude's unset
    // default — the resolved value clamped exactly as Claude clamps it.
    const timeoutMs = clampToolTimeout(
      handle.server.timeoutMs ?? this.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    );
    try {
      const callArgs =
        typeof args === "object" && args !== null && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};
      return await handle.client.callTool({ name: toolName, arguments: callArgs }, undefined, {
        timeout: timeoutMs,
      });
    } catch (err) {
      if (errCode(err) === MCP_ERROR_REQUEST_TIMEOUT) {
        throw new Error(
          `MCP tool "${toolName}" on server "${serverName}" timed out after ${timeoutMs} ms`,
        );
      }
      // Reachable only on a connected server, so spawn-path error text (which
      // embeds the expanded command) never flows here; the message is the
      // server's own protocol-level speech — bounded and neutralized.
      throw new Error(
        `MCP tool "${toolName}" on server "${serverName}" failed: ${boundedErrText(err)}`,
      );
    }
  }

  /** Idempotent; closes clients and kills process trees; grace-bounded, never throws. */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.doShutdown();
    return this.shutdownPromise;
  }

  // -------------------------------------------------------------------------
  // Connect path
  // -------------------------------------------------------------------------

  private async connectAll(): Promise<void> {
    let sdk:
      | {
          Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
          StdioClientTransport: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport;
        }
      | undefined;
    try {
      // Lazy import (not top-level): a broken @modelcontextprotocol/sdk
      // install must degrade this session to MCP-unavailable diagnostics
      // instead of failing extension load.
      const [clientMod, stdioMod] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/stdio.js"),
      ]);
      sdk = { Client: clientMod.Client, StdioClientTransport: stdioMod.StdioClientTransport };
    } catch (err) {
      const summary = errSummary(err);
      for (const handle of this.handles) {
        this.settleHandle(
          handle,
          "failed",
          `MCP server "${handle.server.name}": @modelcontextprotocol/sdk failed to load (${summary}); MCP support unavailable`,
        );
      }
      return;
    }
    await Promise.all(this.handles.map((handle) => this.connectOne(handle, sdk!)));
  }

  private async connectOne(
    handle: ServerHandle,
    sdk: {
      Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
      StdioClientTransport: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport;
    },
  ): Promise<void> {
    const server = handle.server;
    // connectAll yields at the SDK import(); a shutdown() in that window has
    // already settled this handle and must not be raced into a spawn. This
    // check is complete: there is no await between here and the spawn.
    if (handle.stopped) return;
    try {
      // Spread order is binary-verified Claude parity (2.1.218): base env →
      // injected Claude vars → config `env` LAST — config wins over everything,
      // including the injected vars.
      const env = unicodeSafeSubprocessEnv({
        ...(this.deps.env ?? process.env),
        CLAUDE_PROJECT_DIR: this.deps.projectRoot,
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: this.deps.sessionId,
        ...server.env,
      });
      const transport = new sdk.StdioClientTransport({
        command: server.command,
        args: server.args,
        env,
        cwd: this.deps.projectRoot,
        stderr: "pipe",
      });
      handle.transport = transport;
      // The PassThrough exists before start(), so even the earliest stderr
      // lands in the (tail-bounded) ring.
      transport.stderr?.on("data", (chunk: Buffer) => {
        handle.stderrRing = (handle.stderrRing + chunk.toString("utf8")).slice(
          -STDERR_RING_MAX_CHARS,
        );
      });
      const client = new sdk.Client({ name: "picc", version: "0.1.0" }, { capabilities: {} });
      handle.client = client;
      this.ensureExitHook();
      // connect() does not return while initialize hangs, and close() nulls
      // the transport's pid — capture it out-of-band as soon as spawn lands so
      // the timeout/shutdown kill paths always have a target.
      handle.pidPoller = setInterval(() => {
        const pid = transport.pid;
        if (typeof pid === "number") {
          handle.pid = pid;
          this.clearPidPoller(handle);
        }
      }, PID_POLL_MS);
      handle.pidPoller.unref();

      const connectPromise = (async () => {
        await client.connect(transport);
        const tools: unknown[] = [];
        let cursor: string | undefined;
        // Bounded pagination: a hostile server must not hold connect forever
        // with an endless cursor chain.
        for (let page = 0; page < 16; page++) {
          const listed = await client.listTools(cursor === undefined ? {} : { cursor });
          tools.push(...listed.tools);
          if (typeof listed.nextCursor !== "string" || listed.nextCursor === "") break;
          cursor = listed.nextCursor;
        }
        return tools;
      })();
      // The losing branch keeps running after a timeout; never let it become
      // an unhandled rejection.
      connectPromise.catch(() => {});

      const outcome = await raceWithTimeout(connectPromise, this.connectTimeoutMs);
      this.clearPidPoller(handle);
      if (typeof transport.pid === "number") handle.pid = transport.pid;

      if (handle.stopped || handle.settled) {
        // Shutdown pre-empted this connect; stopServer owns the kill.
        return;
      }
      if (outcome.timedOut) {
        if (handle.pid !== undefined) killProcessTreeByPid(handle.pid);
        void client.close().catch(() => {});
        this.settleHandle(
          handle,
          "failed",
          `MCP server "${server.name}" failed to connect within ${this.connectTimeoutMs} ms ` +
            `(MCP_TIMEOUT) — command: ${server.rawCommand}${this.stderrExcerpt(handle)}`,
        );
        return;
      }
      handle.tools = this.validateTools(server.name, outcome.value);
      this.settleHandle(handle, "connected");
    } catch (err) {
      this.clearPidPoller(handle);
      // Fast-fail backstop: a spawn that errors within the first poll tick can
      // beat the pid poller — re-capture from the transport before deciding
      // whether anything needs killing.
      if (handle.pid === undefined && typeof handle.transport?.pid === "number") {
        handle.pid = handle.transport.pid;
      }
      if (handle.stopped || handle.settled) return;
      if (handle.pid !== undefined) killProcessTreeByPid(handle.pid);
      if (handle.client) void handle.client.close().catch(() => {});
      // Diagnostics reference the server NAME and rawCommand only — a raw
      // spawn err.message embeds the EXPANDED command path (`spawn C:\...\x
      // ENOENT`), which `${VAR}` expansion may have derived from values that
      // must not surface. errSummary keeps only the error code/name.
      this.settleHandle(
        handle,
        "failed",
        `MCP server "${server.name}" failed to start (${errSummary(err)}) — ` +
          `command: ${server.rawCommand}${this.stderrExcerpt(handle)}`,
      );
    }
  }

  /**
   * Validate server-supplied tool metadata, Claude-style (binary-verified
   * 2.1.218): names are SANITIZED (`[^A-Za-z0-9_-]` → `_`) and kept, not
   * dropped — only a name empty after sanitizing is dropped; duplicate names
   * (including post-sanitize collisions) dedupe first-wins; descriptions are
   * bounded and control-stripped. All diagnostics quote bounded name slices
   * and are capped per server.
   */
  private validateTools(serverName: string, rawTools: unknown[]): McpToolInfo[] {
    const out: McpToolInfo[] = [];
    const seen = new Set<string>();
    let emitted = 0;
    let suppressed = 0;
    const diag = (text: string): void => {
      if (emitted < TOOL_DIAG_MAX_PER_SERVER) {
        emitted += 1;
        this.diags.push(neutralizeControlChars(text));
      } else {
        suppressed += 1;
      }
    };
    for (const raw of rawTools) {
      const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
      const rawName = typeof tool.name === "string" ? tool.name : "";
      const name = rawName.replace(TOOL_NAME_SANITIZE_RE, "_");
      if (name === "") {
        diag(`MCP server "${serverName}": tool with an empty name dropped`);
        continue;
      }
      if (name !== rawName) {
        diag(
          `MCP server "${serverName}": tool name "${sliceForDiag(rawName)}" sanitized to ` +
            `"${sliceForDiag(name)}" (Claude parity: characters outside [A-Za-z0-9_-] become "_")`,
        );
      }
      if (seen.has(name)) {
        diag(
          `MCP server "${serverName}": duplicate tool name "${sliceForDiag(name)}"; first definition kept`,
        );
        continue;
      }
      seen.add(name);
      let description =
        typeof tool.description === "string" ? neutralizeControlChars(tool.description) : "";
      if (description.length > DESCRIPTION_MAX_CHARS) {
        description = `${description.slice(0, DESCRIPTION_MAX_CHARS)}… [truncated]`;
      }
      out.push({ serverName, toolName: name, description, inputSchema: tool.inputSchema });
    }
    if (suppressed > 0) {
      this.diags.push(
        `MCP server "${serverName}": …and ${suppressed} more tool-metadata diagnostic(s) suppressed`,
      );
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Shutdown path
  // -------------------------------------------------------------------------

  private async doShutdown(): Promise<void> {
    try {
      this.removeExitHook();
      // stopServer settles every still-connecting handle before its first
      // await, so nothing can remain unsettled after this.
      await Promise.all(this.handles.map((handle) => this.stopServer(handle)));
    } catch {
      /* shutdown never throws; kills are individually guarded */
    }
  }

  private async stopServer(handle: ServerHandle): Promise<void> {
    if (handle.stopped) return;
    handle.stopped = true;
    this.clearPidPoller(handle);
    if (!handle.settled && handle.state === "connecting") {
      this.settleHandle(
        handle,
        "failed",
        `MCP server "${handle.server.name}" was shut down before its connect completed`,
      );
    }
    // Backstop for the sub-poll-tick window: prefer the captured pid, fall
    // back to the transport's live value.
    const transportPid = handle.transport?.pid;
    const pid = handle.pid ?? (typeof transportPid === "number" ? transportPid : undefined);
    // Snapshot the tree BEFORE the graceful close: once the direct child exits
    // on stdin-EOF its children reparent and no later walk can find them.
    const snapshot = pid !== undefined ? [pid, ...listDescendantPids(pid)] : [];
    if (process.platform === "win32" && pid !== undefined) {
      // Windows has no graceful SIGTERM (process.kill is already a hard
      // terminate) — tree-kill immediately, while the tree is still intact.
      killProcessTreeByPid(pid);
    }
    const client = handle.client;
    if (client) {
      // SDK close: stdin-end → grace → SIGTERM → grace → SIGKILL on the direct
      // process. Raced with a failsafe so shutdown can never hang.
      await Promise.race([client.close().catch(() => {}), sleep(SHUTDOWN_GRACE_MS)]);
    }
    // Sweep the pre-close snapshot (POSIX grandchildren; win32 backstop).
    for (const target of snapshot) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Post-shutdown truthfulness: a killed server must not keep reporting
    // "connected" to /doctor. "failed" is the minimal honest state within the
    // fixed contract union; the diagnostic stays out of diagnostics() because
    // a deliberate shutdown is not an error.
    if (handle.state === "connected") {
      handle.state = "failed";
      handle.diagnostic = `MCP server "${handle.server.name}" shut down`;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private settleHandle(
    handle: ServerHandle,
    state: "connected" | "failed",
    diagnostic?: string,
  ): void {
    if (handle.settled) return;
    handle.settled = true;
    handle.state = state;
    if (diagnostic !== undefined) {
      const bounded = neutralizeControlChars(diagnostic);
      handle.diagnostic = bounded;
      this.diags.push(bounded);
    }
    this.unsettledCount -= 1;
    if (this.unsettledCount <= 0) this.settleResolve?.();
  }

  private stderrExcerpt(handle: ServerHandle): string {
    const tail = handle.stderrRing.slice(-STDERR_EXCERPT_MAX_CHARS).trim();
    if (tail === "") return "";
    return `; stderr: ${neutralizeControlChars(tail)}`;
  }

  private clearPidPoller(handle: ServerHandle): void {
    if (handle.pidPoller) {
      clearInterval(handle.pidPoller);
      handle.pidPoller = undefined;
    }
  }

  private ensureExitHook(): void {
    // A connect racing shutdown() must not re-register the listener
    // removeExitHook just took off.
    if (this.shutdownPromise) return;
    if (this.exitHookRegistered) return;
    this.exitHookRegistered = true;
    process.on("exit", this.exitListener);
  }

  private removeExitHook(): void {
    if (!this.exitHookRegistered) return;
    this.exitHookRegistered = false;
    process.off("exit", this.exitListener);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  // Cap at 2^31-1 (Node's TIMEOUT_MAX): an over-max env value must clamp, not
  // overflow a timer into firing at ~1 ms.
  return Math.min(parsed, TOOL_TIMEOUT_MAX_MS);
}

/** Claude's exact tool-timeout clamp (binary-verified 2.1.218). */
function clampToolTimeout(ms: number): number {
  return Math.min(Math.max(ms, TOOL_TIMEOUT_MIN_MS), TOOL_TIMEOUT_MAX_MS);
}

/** Bounded slice of a server-supplied name for diagnostic text. */
function sliceForDiag(name: string): string {
  return name.length > DIAG_NAME_MAX_CHARS ? `${name.slice(0, DIAG_NAME_MAX_CHARS)}…` : name;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `code` property when a numeric MCP error code is present. */
function errCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

/**
 * Leak-safe error summary: the `code` (ENOENT, EACCES, …) or constructor name
 * only — NEVER `err.message`, which for spawn failures embeds the expanded
 * command path.
 */
function errSummary(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return neutralizeControlChars(code);
    if (typeof code === "number") return `error ${code}`;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name !== "") return neutralizeControlChars(name);
  }
  return "unknown error";
}

/** Bounded, neutralized error text for callTool rejections. */
function boundedErrText(err: unknown): string {
  let message = "unknown error";
  if (typeof err === "object" && err !== null) {
    const raw = (err as { message?: unknown }).message;
    if (typeof raw === "string" && raw !== "") message = raw;
  } else if (typeof err === "string" && err !== "") {
    message = err;
  }
  const clean = neutralizeControlChars(message);
  return clean.length > CALL_ERROR_MAX_CHARS ? `${clean.slice(0, CALL_ERROR_MAX_CHARS)}…` : clean;
}

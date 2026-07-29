import { sanitizedSubprocessEnv, unicodeSafeSubprocessEnv } from "../util/env.js";
import { killProcessTreeByPid, listDescendantPids } from "../util/process-tree.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import type {
  EnabledRemoteMcpServer,
  EnabledStdioMcpServer,
  ResolvedMcpConfig,
  ResolvedMcpServer,
} from "../types.js";
import {
  classifyRemoteMcpFailure,
  createRemoteMcpTransport,
  type RemoteMcpDisconnect,
  type RemoteMcpTransportHandle,
} from "./mcp-remote.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * MCP runtime manager.
 *
 * Starts the ENABLED servers of a {@link ResolvedMcpConfig} through the
 * `@modelcontextprotocol/sdk` client, exposes
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
/** Tool description bound (2 KB — a PiCC-only bound, not Claude parity). */
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
/** SDK McpError code accepted only with independent local closure provenance. */
const MCP_ERROR_CONNECTION_CLOSED = -32_000;
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

type McpSdk = {
  Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  StdioClientTransport: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport;
};

export type McpTimeoutOutcome<T> =
  | { timedOut: true }
  | { timedOut: false; value: T };

export type McpTimeoutRace = <T>(
  promise: Promise<T>,
  timeoutMs: number,
) => Promise<McpTimeoutOutcome<T>>;

export interface McpTimeoutPolicy {
  connectTimeoutMs: number;
  environmentToolTimeoutMs: number | undefined;
}

export type McpDelay = (delayMs: number, signal: AbortSignal) => Promise<void>;

export interface McpRuntimeDeps {
  /**
   * Spawn cwd and `CLAUDE_PROJECT_DIR` — deliberately the project root, never
   * the live cwd: worktree drift must not change command resolution.
   */
  projectRoot: string;
  /** `CLAUDE_CODE_SESSION_ID` for the servers — binary-verified Claude behavior (2.1.218; undocumented). */
  sessionId: string;
  /**
   * Ambient environment for the servers and timeout settings. Defaults to
   * `process.env`; launcher-only values are removed before any overlay.
   */
  env?: Record<string, string | undefined>;
  /** Project `settings.env`, applied after sanitized ambient inheritance. */
  settingsEnv?: Record<string, string | undefined>;
  /** Test seam for exercising an SDK load/import failure. */
  loadSdk?: () => Promise<McpSdk>;
  /** Test seam for deterministic connect-timeout settlement after test-owned readiness. */
  raceWithTimeout?: McpTimeoutRace;
  /** Remote-only client loader; a failure must not affect stdio siblings. */
  loadRemoteClient?: () => Promise<typeof import("@modelcontextprotocol/sdk/client/index.js").Client>;
  /** Remote transport factory seam for lifecycle tests; production uses the safe adapter. */
  createRemoteTransport?: typeof createRemoteMcpTransport;
  /** Abortable injected scheduler for retry policy tests; production uses unref'd timers. */
  delay?: McpDelay;
}

export type McpLifecycleState =
  | "connecting"
  | "retrying"
  | "connected"
  | "reconnecting"
  | "failed";


export interface McpServerState {
  name: string;
  transport: "stdio" | "http" | "sse";
  state: McpLifecycleState;
  attempt?: number;
  attemptLimit?: number;
  toolCount?: number;
  diagnostic?: string;
  /** Bounded, non-secret failure class safe for direct status output. */
  statusSummary?: string;
}

type EnabledMcpServer = Extract<ResolvedMcpServer, { status: "enabled" }>;

interface ServerHandle {
  server: EnabledMcpServer;
  state: McpLifecycleState;
  attempt?: number;
  attemptLimit?: number;
  client?: Client;
  transport?: StdioClientTransport | RemoteMcpTransportHandle;
  remoteAbort?: AbortController;
  generation: number;
  /** Captured out-of-band: transport.pid nulls on close and connect() may never return. */
  pid?: number;
  pidPoller?: NodeJS.Timeout;
  tools: McpToolInfo[];
  diagnostic?: string;
  statusSummary?: string;
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
  private remoteClientCtorPromise?: Promise<typeof import("@modelcontextprotocol/sdk/client/index.js").Client>;

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
    const timeoutResolution = resolveMcpTimeoutPolicyInternal(
      sanitizedSubprocessEnv(deps.env ?? process.env, deps.settingsEnv),
    );
    this.connectTimeoutMs = timeoutResolution.policy.connectTimeoutMs;
    this.toolTimeoutMs = timeoutResolution.policy.environmentToolTimeoutMs;
    for (const rejected of timeoutResolution.rejected) {
      this.diags.push(timeoutRejectionDiagnostic(rejected));
    }
    for (const server of config.servers) {
      if (server.status !== "enabled") continue;
      this.handles.push({
        server,
        state: "connecting",
        tools: [],
        generation: 0,
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

  /** Resolved connect bound (`MCP_TIMEOUT`, else the 30 s Claude default) — read-only. */
  get resolvedConnectTimeoutMs(): number {
    return this.connectTimeoutMs;
  }

  /** Tools of already-connected servers — possibly incomplete (initially `[]`) before settle; servers settle individually. */
  tools(): McpToolInfo[] {
    const out: McpToolInfo[] = [];
    for (const handle of this.handles) {
      if (
        handle.tools.length > 0 &&
        (handle.server.transport !== "stdio" || handle.state === "connected")
      ) out.push(...handle.tools);
    }
    return out;
  }

  /**
   * Connect failures, timeouts, dropped tools, stderr excerpts — all bounded.
   * This is the stderr feed: the registration wiring (src/index.ts) drains it
   * to console.error once settle completes, one line per diagnostic.
   */
  diagnostics(): string[] {
    return [...this.diags];
  }

  /** Live state of the ENABLED servers (pending/disabled/skipped stay in ResolvedMcpConfig). */
  serverStates(): McpServerState[] {
    return this.handles.map((handle) => ({
      name: handle.server.name,
      transport: handle.server.transport,
      state: handle.state,
      ...(handle.attempt !== undefined ? { attempt: handle.attempt } : {}),
      ...(handle.attemptLimit !== undefined ? { attemptLimit: handle.attemptLimit } : {}),
      ...(handle.tools.length > 0 || handle.state === "connected" ? { toolCount: handle.tools.length } : {}),
      ...(handle.diagnostic !== undefined ? { diagnostic: handle.diagnostic } : {}),
      ...(handle.statusSummary !== undefined ? { statusSummary: handle.statusSummary } : {}),
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
    if (handle.state === "reconnecting" || handle.state === "retrying") {
      throw new Error(`MCP server "${serverName}" is temporarily unavailable while reconnecting`);
    }
    if (handle.state !== "connected" || !handle.client) {
      const suffix = handle.tools.length > 0
        ? " is unavailable because its remote connection failed"
        : " is not connected";
      throw new Error(`MCP server "${serverName}"${suffix}`);
    }
    if (!handle.tools.some((tool) => tool.toolName === toolName)) {
      throw new Error(
        `MCP server "${serverName}" has no tool "${neutralizeControlChars(toolName)}"`,
      );
    }
    // Per-server `timeout` wins; else MCP_TOOL_TIMEOUT; else Claude's unset
    // default — the resolved value clamped exactly as Claude clamps it.
    const timeoutMs = resolveMcpToolTimeoutMs(handle.server.timeoutMs, this.toolTimeoutMs);
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
      if (handle.server.transport !== "stdio" && isRemoteTransportFailure(err)) {
        const failure = classifyRemoteMcpFailure(err, { stage: "call" });
        if (failure.class === "transient") {
          this.beginRecovery(handle, { kind: "abrupt-stream-failure" });
          throw new Error(`MCP server "${serverName}" is temporarily unavailable while reconnecting`);
        }
        if (failure.class !== "cancelled") {
          this.failRemotePermanently(handle, failure.class);
          throw new Error(`MCP server "${serverName}" is unavailable because its remote connection failed`);
        }
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
    const stdioHandles = this.handles.filter(
      (handle): handle is ServerHandle & { server: EnabledStdioMcpServer } =>
        handle.server.transport === "stdio",
    );
    const remoteHandles = this.handles.filter(
      (handle): handle is ServerHandle & { server: EnabledRemoteMcpServer } =>
        handle.server.transport !== "stdio",
    );
    let stdioSdk: McpSdk | undefined;
    if (stdioHandles.length > 0) {
      try {
        if (this.deps.loadSdk) {
          stdioSdk = await this.deps.loadSdk();
        } else {
          const [clientMod, stdioMod] = await Promise.all([
            import("@modelcontextprotocol/sdk/client/index.js"),
            import("@modelcontextprotocol/sdk/client/stdio.js"),
          ]);
          stdioSdk = { Client: clientMod.Client, StdioClientTransport: stdioMod.StdioClientTransport };
        }
      } catch (err) {
        const summary = errSummary(err);
        for (const handle of stdioHandles) {
          this.settleHandle(
            handle,
            "failed",
            `MCP server "${handle.server.name}": @modelcontextprotocol/sdk failed to load (${summary}); MCP support unavailable`,
            "MCP support is unavailable because its SDK could not be loaded.",
          );
        }
      }
    }
    await Promise.all([
      ...(stdioSdk === undefined ? [] : stdioHandles.map((handle) => this.connectStdio(handle, stdioSdk!))),
      ...remoteHandles.map((handle) => this.connectRemoteInitial(handle)),
    ]);
  }

  private async connectStdio(
    handle: ServerHandle & { server: EnabledStdioMcpServer },
    sdk: McpSdk,
  ): Promise<void> {
    const server = handle.server;
    // connectAll yields at the SDK import(); a shutdown() in that window has
    // already settled this handle and must not be raced into a spawn. This
    // check is complete: there is no await between here and the spawn.
    if (handle.stopped) return;
    let initializationComplete = false;
    let localCloseObserved = false;
    let localTransportErrorObserved = false;
    let serverErrorObservedBeforeInitialization = false;
    try {
      // Claude parity (binary-verified 2.1.218): sanitized inheritance →
      // project settings → injected Claude defaults → server env last.
      const env = unicodeSafeSubprocessEnv({
        ...sanitizedSubprocessEnv(
          this.deps.env ?? process.env,
          this.deps.settingsEnv,
          {
            CLAUDE_PROJECT_DIR: this.deps.projectRoot,
            CLAUDECODE: "1",
            CLAUDE_CODE_SESSION_ID: this.deps.sessionId,
          },
        ),
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
      // Protocol.connect preserves preinstalled callbacks and invokes them before
      // its own handlers. That ordering distinguishes a transport-driven close
      // from a server error response whose later cleanup also closes transport.
      transport.onclose = () => {
        localCloseObserved = true;
      };
      transport.onerror = () => {
        localTransportErrorObserved = true;
      };
      transport.onmessage = (message) => {
        if (!initializationComplete && isJsonRpcErrorResponse(message)) {
          serverErrorObservedBeforeInitialization = true;
        }
      };
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
        initializationComplete = true;
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

      const outcome = await (this.deps.raceWithTimeout ?? raceWithTimeout)(
        connectPromise,
        this.connectTimeoutMs,
      );
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
          "MCP startup timed out during connection, initialization, or tool discovery; run /doctor for details.",
        );
        return;
      }
      handle.tools = this.validateTools(server.name, outcome.value);
      this.settleHandle(handle, "connected");
    } catch (err) {
      // Snapshot before catch-path cleanup: client.close() also closes the
      // transport and must never manufacture closure provenance.
      const recognizedPreInitializationClose =
        !initializationComplete &&
        localCloseObserved &&
        !localTransportErrorObserved &&
        !serverErrorObservedBeforeInitialization &&
        errCode(err) === MCP_ERROR_CONNECTION_CLOSED;
      this.clearPidPoller(handle);
      // Fast-fail backstop: a spawn that errors within the first poll tick can
      // beat the pid poller — re-capture from the transport before deciding
      // whether anything needs killing.
      const liveTransport = handle.transport as StdioClientTransport | undefined;
      if (handle.pid === undefined && typeof liveTransport?.pid === "number") {
        handle.pid = liveTransport.pid;
      }
      if (handle.stopped || handle.settled) return;
      if (handle.pid !== undefined) killProcessTreeByPid(handle.pid);
      if (handle.client) void handle.client.close().catch(() => {});
      if (recognizedPreInitializationClose) {
        this.settleHandle(
          handle,
          "failed",
          `MCP server "${server.name}": connection closed before MCP initialization completed.`,
          "Connection closed before MCP initialization completed.",
        );
        return;
      }
      // Raw exception text can embed expanded command values or server speech;
      // only code/name identity reaches the generic diagnostic.
      this.settleHandle(
        handle,
        "failed",
        `MCP server "${server.name}" failed to start (${errSummary(err)}) — ` +
          `command: ${server.rawCommand}${this.stderrExcerpt(handle)}`,
        "MCP startup failed during connection, initialization, or tool discovery; run /doctor for details.",
      );
    }
  }

  private async remoteClientCtor(): Promise<typeof import("@modelcontextprotocol/sdk/client/index.js").Client> {
    // Keep the remote-only SDK path lazy so an unavailable remote module cannot
    // break healthy stdio siblings or the zero-enabled path.
    this.remoteClientCtorPromise ??= this.deps.loadRemoteClient
      ? this.deps.loadRemoteClient()
      : import("@modelcontextprotocol/sdk/client/index.js").then((module) => module.Client);
    return this.remoteClientCtorPromise;
  }

  private async connectRemoteInitial(
    handle: ServerHandle & { server: EnabledRemoteMcpServer },
  ): Promise<void> {
    const epoch = ++handle.generation;
    const controller = new AbortController();
    handle.remoteAbort = controller;
    const sequence = this.remoteInitialSequence(handle, epoch, controller.signal);
    sequence.catch(() => undefined);
    const outcome = await (this.deps.raceWithTimeout ?? raceWithTimeout)(sequence, this.connectTimeoutMs);
    if (handle.stopped || handle.generation !== epoch) return;
    if (outcome.timedOut) {
      handle.generation += 1;
      controller.abort();
      void this.closeRemoteParts(handle, 0);
      this.settleHandle(
        handle,
        "failed",
        `MCP server "${handle.server.name}" exhausted its aggregate remote startup budget.`,
        "Remote MCP startup timed out within the aggregate MCP_TIMEOUT budget.",
      );
    }
  }

  private async remoteInitialSequence(
    handle: ServerHandle & { server: EnabledRemoteMcpServer },
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    const delays = [1_000, 2_000, 4_000] as const;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      if (!this.remoteCurrent(handle, epoch, signal)) return;
      handle.state = attempt === 1 ? "connecting" : "retrying";
      handle.attempt = attempt;
      handle.attemptLimit = 4;
      try {
        const connected = await this.openRemote(handle, epoch, signal);
        if (!this.remoteCurrent(handle, epoch, signal)) {
          await connected.transport.abort().catch(() => undefined);
          return;
        }
        handle.client = connected.client;
        handle.transport = connected.transport;
        handle.tools = this.validateTools(handle.server.name, connected.tools);
        handle.attempt = undefined;
        handle.attemptLimit = undefined;
        this.settleHandle(handle, "connected");
        return;
      } catch (error) {
        await this.closeRemoteParts(handle);
        if (!this.remoteCurrent(handle, epoch, signal)) return;
        const failure = remoteAttemptFailure(error);
        if (failure.class !== "transient" || attempt === 4) {
          this.settleHandle(
            handle,
            "failed",
            `MCP server "${handle.server.name}" remote startup failed (${failure.class}).`,
            remoteFailureSummary(failure.class, attempt === 4),
          );
          return;
        }
        handle.state = "retrying";
        handle.attempt = attempt + 1;
        await (this.deps.delay ?? abortableDelay)(delays[attempt - 1]!, signal).catch(() => undefined);
      }
    }
  }

  private async openRemote(
    handle: ServerHandle & { server: EnabledRemoteMcpServer },
    epoch: number,
    signal: AbortSignal,
  ): Promise<{ client: Client; transport: RemoteMcpTransportHandle; tools: unknown[] }> {
    const ClientCtor = await this.remoteClientCtor();
    if (!this.remoteCurrent(handle, epoch, signal)) throw cancelledRemoteAttempt();
    const factory = this.deps.createRemoteTransport ?? createRemoteMcpTransport;
    const transport = await factory({
      configuredType: handle.server.configuredType,
      transportKind: handle.server.transport,
      rawUrl: "",
      rawHeaders: Object.create(null) as Record<string, string>,
      url: handle.server.url,
      headers: handle.server.headers,
      ...(handle.server.sseDeprecation !== undefined
        ? { sseDeprecation: handle.server.sseDeprecation }
        : {}),
    });
    if (!this.remoteCurrent(handle, epoch, signal)) {
      await transport.abort().catch(() => undefined);
      throw cancelledRemoteAttempt();
    }
    handle.transport = transport;
    const client = new ClientCtor({ name: "picc", version: "0.1.0" }, { capabilities: {} });
    handle.client = client;
    let published = false;
    let transportLoss: RemoteMcpDisconnect | undefined;
    transport.onDisconnect((event) => {
      transportLoss = event;
      if (published && this.remoteCurrent(handle, epoch, signal)) this.beginRecovery(handle, event);
    });
    transport.onerror = (error): void => {
      if (!published || !this.remoteCurrent(handle, epoch, signal)) return;
      const failure = classifyRemoteMcpFailure(error, { stage: "connection" });
      if (failure.class === "transient") this.beginRecovery(handle, { kind: "abrupt-stream-failure" });
      else if (failure.class !== "cancelled") this.failRemotePermanently(handle, failure.class);
    };
    try {
      await client.connect(transport);
    } catch (error) {
      throw {
        remoteFailure: classifyRemoteMcpFailure(error, {
          stage: "connection",
          ...(transportLoss !== undefined ? { transportLoss } : {}),
        }),
      };
    }
    if (!this.remoteCurrent(handle, epoch, signal)) {
      if (handle.transport === transport) await this.closeRemoteParts(handle, 0);
      throw cancelledRemoteAttempt();
    }
    let tools: unknown[];
    try {
      tools = await this.listRemoteTools(client, signal);
    } catch (error) {
      throw {
        remoteFailure: classifyRemoteMcpFailure(error, {
          stage: "discovery",
          ...(transportLoss !== undefined ? { transportLoss } : {}),
        }),
      };
    }
    if (!this.remoteCurrent(handle, epoch, signal)) {
      if (handle.transport === transport) await this.closeRemoteParts(handle, 0);
      throw cancelledRemoteAttempt();
    }
    published = true;
    return { client, transport, tools };
  }

  private async listRemoteTools(client: Client, signal: AbortSignal): Promise<unknown[]> {
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 16; page += 1) {
      const listed = await client.listTools(
        cursor === undefined ? {} : { cursor },
        { signal, timeout: this.connectTimeoutMs, maxTotalTimeout: this.connectTimeoutMs },
      );
      tools.push(...listed.tools);
      if (typeof listed.nextCursor !== "string" || listed.nextCursor === "") break;
      cursor = listed.nextCursor;
    }
    return tools;
  }

  private beginRecovery(handle: ServerHandle, _event: RemoteMcpDisconnect): void {
    if (handle.server.transport === "stdio" || handle.stopped) return;
    if (handle.state === "reconnecting" || handle.state === "failed") return;
    const epoch = ++handle.generation;
    handle.state = "reconnecting";
    handle.statusSummary = "Remote MCP connection was lost; bounded recovery is in progress.";
    const oldController = handle.remoteAbort;
    oldController?.abort();
    const controller = new AbortController();
    handle.remoteAbort = controller;
    void this.closeRemoteParts(handle).then(() => this.recoveryLoop(
      handle as ServerHandle & { server: EnabledRemoteMcpServer },
      epoch,
      controller.signal,
    ));
  }

  private async recoveryLoop(
    handle: ServerHandle & { server: EnabledRemoteMcpServer },
    epoch: number,
    signal: AbortSignal,
  ): Promise<void> {
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
    let loopEpoch = epoch;
    for (let index = 0; index < delays.length; index += 1) {
      handle.attempt = index + 1;
      handle.attemptLimit = delays.length;
      await (this.deps.delay ?? abortableDelay)(delays[index]!, signal).catch(() => undefined);
      if (!this.remoteCurrent(handle, loopEpoch, signal)) return;
      const attemptEpoch = ++handle.generation;
      const attemptController = new AbortController();
      const onLoopAbort = (): void => attemptController.abort();
      signal.addEventListener("abort", onLoopAbort, { once: true });
      const opening = (async () => {
        try {
          return await this.openRemote(handle, attemptEpoch, attemptController.signal);
        } catch (error) {
          // Cleanup is part of this attempt's single MCP_TIMEOUT budget. A
          // stale attempt must not close a replacement published by a newer epoch.
          if (handle.generation === attemptEpoch) await this.closeRemoteParts(handle);
          throw error;
        }
      })();
      opening.catch(() => undefined);
      try {
        const outcome = await (this.deps.raceWithTimeout ?? raceWithTimeout)(opening, this.connectTimeoutMs);
        if (!this.remoteCurrent(handle, attemptEpoch, signal)) return;
        if (outcome.timedOut) {
          handle.generation += 1;
          loopEpoch = handle.generation;
          // Invalidate and initiate cleanup synchronously. A hanging close must
          // not consume a second MCP_TIMEOUT before the next attempt can progress.
          attemptController.abort();
          void this.closeRemoteParts(handle, 0);
          continue;
        }
        const connected = outcome.value;
        handle.client = connected.client;
        handle.transport = connected.transport;
        // Discovery is required for connection health, but the first catalog is immutable.
        handle.state = "connected";
        handle.attempt = undefined;
        handle.attemptLimit = undefined;
        handle.diagnostic = undefined;
        handle.statusSummary = undefined;
        return;
      } catch (error) {
        const failure = remoteAttemptFailure(error);
        if (failure.class !== "transient") {
          this.failRemotePermanently(handle, failure.class);
          return;
        }
        handle.generation += 1;
        loopEpoch = handle.generation;
      } finally {
        signal.removeEventListener("abort", onLoopAbort);
      }
    }
    if (!this.remoteCurrent(handle, loopEpoch, signal)) return;
    handle.state = "failed";
    handle.attempt = delays.length;
    handle.attemptLimit = delays.length;
    handle.diagnostic = `MCP server "${handle.server.name}" exhausted remote reconnect attempts.`;
    handle.statusSummary = "Remote MCP recovery exhausted 5 reconnect attempts; check endpoint and network availability, then reload or retry.";
    this.diags.push(handle.diagnostic);
  }

  private failRemotePermanently(handle: ServerHandle, failureClass: string): void {
    if (handle.server.transport === "stdio" || handle.stopped || handle.state === "failed") return;
    handle.generation += 1;
    handle.remoteAbort?.abort();
    void this.closeRemoteParts(handle, 0);
    handle.state = "failed";
    handle.attempt = undefined;
    handle.attemptLimit = undefined;
    handle.diagnostic = `MCP server "${handle.server.name}" remote connection failed (${failureClass}).`;
    handle.statusSummary = remoteFailureSummary(failureClass, false);
    this.diags.push(handle.diagnostic);
  }

  private remoteCurrent(handle: ServerHandle, epoch: number, signal: AbortSignal): boolean {
    return !handle.stopped && !signal.aborted && handle.generation === epoch;
  }

  private async closeRemoteParts(
    handle: ServerHandle,
    maxWaitMs: number = this.connectTimeoutMs,
  ): Promise<void> {
    const client = handle.client;
    const transport = handle.transport;
    handle.client = undefined;
    handle.transport = undefined;
    const closing: Promise<unknown>[] = [];
    if (client) {
      try {
        closing.push(client.close().catch(() => undefined));
      } catch {
        /* cleanup remains best-effort */
      }
    }
    if (transport && "abort" in transport) {
      try {
        closing.push(transport.abort().catch(() => undefined));
      } catch {
        /* cleanup remains best-effort */
      }
    }
    if (closing.length === 0 || maxWaitMs === 0) return;
    await Promise.race([Promise.all(closing), sleep(maxWaitMs)]);
  }

  /**
   * Validate server-supplied tool metadata, Claude-style: names are SANITIZED
   * (`[^A-Za-z0-9_-]` → `_`, binary-verified 2.1.218) and kept, not dropped —
   * only a name empty after sanitizing is dropped; duplicate names (including
   * post-sanitize collisions) dedupe first-wins, a PiCC-chosen direction, not
   * binary-verified; descriptions are bounded and control-stripped. All
   * diagnostics quote bounded name slices and are capped per server.
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
    handle.generation += 1;
    handle.remoteAbort?.abort();
    this.clearPidPoller(handle);
    if (!handle.settled) {
      this.settleHandle(
        handle,
        "failed",
        `MCP server "${handle.server.name}" was shut down before its connect completed`,
        "Connection stopped because the session shut down.",
      );
    }
    if (handle.server.transport !== "stdio") {
      await this.closeRemoteParts(handle, SHUTDOWN_GRACE_MS);
      if (handle.state === "connected" || handle.state === "reconnecting") {
        handle.state = "failed";
        handle.diagnostic = `MCP server "${handle.server.name}" shut down`;
        handle.statusSummary = "Connection closed because the session shut down.";
      }
      return;
    }
    // Backstop for the sub-poll-tick window: prefer the captured pid, fall
    // back to the transport's live value.
    const transportPid = (handle.transport as StdioClientTransport | undefined)?.pid;
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
    // pid-reuse inside the grace window could kill an unrelated process —
    // accepted, same class as the hook-runner taskkill pattern.
    for (const target of snapshot) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Post-shutdown truthfulness: a killed server must not keep reporting
    // "connected" to the bounded status surfaces. "failed" is the minimal
    // honest state within the fixed contract union; the diagnostic stays out
    // of diagnostics() because a deliberate shutdown is not an error.
    if (handle.state === "connected") {
      handle.state = "failed";
      handle.diagnostic = `MCP server "${handle.server.name}" shut down`;
      handle.statusSummary = "Connection closed because the session shut down.";
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private settleHandle(
    handle: ServerHandle,
    state: "connected" | "failed",
    diagnostic?: string,
    statusSummary?: string,
  ): void {
    if (handle.settled) return;
    handle.settled = true;
    handle.state = state;
    if (diagnostic !== undefined) {
      const bounded = neutralizeControlChars(diagnostic);
      handle.diagnostic = bounded;
      this.diags.push(bounded);
    }
    if (statusSummary !== undefined) handle.statusSummary = statusSummary;
    this.unsettledCount -= 1;
    if (this.unsettledCount <= 0) this.settleResolve?.();
  }

  private stderrExcerpt(handle: ServerHandle): string {
    // The excerpt splices into ONE-LINE surfaces (the /doctor posture line,
    // the stderr drain), which multi-line stderr — stack traces, Windows cmd
    // errors — would split mid-sentence; collapse whitespace runs to a space.
    const tail = handle.stderrRing
      .slice(-STDERR_EXCERPT_MAX_CHARS)
      .replace(/[\n\r\t]+/g, " ")
      .trim();
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

export function resolveMcpTimeoutPolicy(
  env: Record<string, string | undefined>,
): McpTimeoutPolicy {
  return resolveMcpTimeoutPolicyInternal(env).policy;
}

type RejectedTimeoutVariable = "MCP_TIMEOUT" | "MCP_TOOL_TIMEOUT";

interface McpTimeoutPolicyResolution {
  policy: McpTimeoutPolicy;
  rejected: RejectedTimeoutVariable[];
}

function resolveMcpTimeoutPolicyInternal(
  env: Record<string, string | undefined>,
): McpTimeoutPolicyResolution {
  const connect = parseTimeoutEnvironmentValue(env["MCP_TIMEOUT"]);
  const tool = parseTimeoutEnvironmentValue(env["MCP_TOOL_TIMEOUT"]);
  const rejected: RejectedTimeoutVariable[] = [];
  if (connect.rejected) rejected.push("MCP_TIMEOUT");
  if (tool.rejected) rejected.push("MCP_TOOL_TIMEOUT");
  return {
    policy: {
      connectTimeoutMs: connect.value ?? DEFAULT_CONNECT_TIMEOUT_MS,
      environmentToolTimeoutMs: tool.value,
    },
    rejected,
  };
}

/** Resolve per-server precedence and Claude's exact tool-timeout clamp. */
export function resolveMcpToolTimeoutMs(
  serverTimeoutMs: number | undefined,
  environmentToolTimeoutMs: number | undefined,
): number {
  return clampToolTimeout(
    serverTimeoutMs ?? environmentToolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
  );
}

type ParsedTimeoutEnvironmentValue =
  | { value: undefined; rejected: false }
  | { value: undefined; rejected: true }
  | { value: number; rejected: false };

function parseTimeoutEnvironmentValue(value: string | undefined): ParsedTimeoutEnvironmentValue {
  if (value === undefined || value.trim() === "") return { value: undefined, rejected: false };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return { value: undefined, rejected: true };
  // Cap at 2^31-1 (Node's TIMEOUT_MAX): an over-max env value must clamp, not
  // overflow a timer into firing at ~1 ms.
  return { value: Math.min(parsed, TOOL_TIMEOUT_MAX_MS), rejected: false };
}

function timeoutRejectionDiagnostic(variable: RejectedTimeoutVariable): string {
  const remedy = `Set ${variable} to a positive integer number of milliseconds or unset it.`;
  if (variable === "MCP_TIMEOUT") {
    return `MCP_TIMEOUT was rejected; using the 30000 ms fallback. ${remedy}`;
  }
  return `MCP_TOOL_TIMEOUT was rejected; per-server timeout remains authoritative, otherwise the 100000000 ms default applies. ${remedy}`;
}

/** Claude's exact tool-timeout clamp (binary-verified 2.1.218). */
function clampToolTimeout(ms: number): number {
  return Math.min(Math.max(ms, TOOL_TIMEOUT_MIN_MS), TOOL_TIMEOUT_MAX_MS);
}

/**
 * Bounded slice of a server-supplied name for diagnostic text. Bound-only,
 * unlike mcp-tools.ts's sliceForDiag: here every diagnostic is neutralized
 * once at its store point (settleHandle / validateTools' diag), so
 * neutralizing per slice would be redundant.
 */
function sliceForDiag(name: string): string {
  return name.length > DIAG_NAME_MAX_CHARS ? `${name.slice(0, DIAG_NAME_MAX_CHARS)}…` : name;
}

function cancelledRemoteAttempt(): { remoteFailure: ReturnType<typeof classifyRemoteMcpFailure> } {
  return {
    remoteFailure: { class: "cancelled", stage: "connection" },
  };
}

function remoteAttemptFailure(error: unknown): ReturnType<typeof classifyRemoteMcpFailure> {
  if (typeof error === "object" && error !== null && "remoteFailure" in error) {
    const failure = (error as { remoteFailure?: unknown }).remoteFailure;
    if (
      typeof failure === "object" && failure !== null &&
      "class" in failure && "stage" in failure
    ) {
      return failure as ReturnType<typeof classifyRemoteMcpFailure>;
    }
  }
  return classifyRemoteMcpFailure(error, { stage: "connection" });
}

function isRemoteTransportFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { constructor?: { name?: string } }).constructor?.name;
  return name === "RemoteMcpSafeError" || name === "StreamableHTTPError" || name === "SseError";
}

function remoteFailureSummary(failureClass: string, exhausted: boolean): string {
  if (failureClass === "authentication") {
    return "Remote MCP authentication failed; check configured static headers. Interactive OAuth is not supported.";
  }
  if (failureClass === "not-found") {
    return "Remote MCP endpoint was not found; check the configured URL without sharing it.";
  }
  if (exhausted) {
    return "Remote MCP startup exhausted 4 attempts; check endpoint and network availability, then reload or retry.";
  }
  return "Remote MCP connection failed permanently; check endpoint and network availability, then reload or retry.";
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
): Promise<McpTimeoutOutcome<T>> {
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

function isJsonRpcErrorResponse(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as { id?: unknown; error?: unknown };
  return candidate.id !== undefined && typeof candidate.error === "object" && candidate.error !== null;
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

import {
  SubagentRuntime,
  type PiSdk,
  type PiSessionManagerLike,
  type PiSessionMessage,
  type PiSessionStats,
  type SubagentRuntimeDeps,
} from "../../src/runtime/subagents.js";
import { PermissionEngine } from "../../src/engine/permissions.js";
import { HookRunner } from "../../src/engine/hook-runner.js";
import type { ClaudeAgent, HookOutcome } from "../../src/types.js";
import { deferred, waitUntil, type Deferred } from "./async.js";

/**
 * Shared fake Pi SDK builder: the one place tests fake `createAgentSession`.
 * Replaces the copy-pasted fakes that previously lived in runtime-core,
 * background-tasks, and builtin-agents tests — extend THIS instead of forking.
 *
 * Sessions behave like real Pi sessions at the failure surface: every assistant
 * message carries a `stopReason` (default "stop"), `abort()` resolves a pending
 * gated prompt with stopReason "aborted", and `prompt()` always resolves
 * normally — terminal failures live on the last assistant message, never as a
 * rejection (pi-agent-core agent-loop semantics).
 */

/**
 * The REAL Pi SessionManager, injected (not statically imported) so that
 * vi.mock factories which `await import` this helper — e.g. builtin-agents.test,
 * whose factory mocks the very `@earendil-works/pi-coding-agent` module this used
 * to import at eval time — cannot deadlock on the circular module load. Persisted-
 * transcript tests call `useRealSessionManager(SessionManager)` once at module
 * scope; every other test leaves it unset and dispatches stay in-memory.
 */
type RealSessionManager = {
  create(cwd: string, sessionDir: string, opts: { id: string }): PiSessionManagerLike;
  /** Reopen a transcript for resume — SessionManager.open. */
  open(path: string, sessionDir?: string, cwdOverride?: string): PiSessionManagerLike;
  /** Fork a NEW transcript seeded from a source's full history — SessionManager.forkFrom. */
  forkFrom(
    sourcePath: string,
    targetCwd: string,
    sessionDir: string,
    opts: { id: string },
  ): PiSessionManagerLike;
};
let realSessionManager: RealSessionManager | undefined;

/** Inject the real Pi SessionManager for persisted-transcript tests (see above). */
export function useRealSessionManager(sm: RealSessionManager): void {
  realSessionManager = sm;
}

/** One scripted assistant reply. Strings are shorthand for `{ text }`. */
export interface FakeReply {
  text?: string;
  /** Pi StopReason vocabulary; defaults to "stop". */
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  /** Await this before replying — lets tests hold a prompt open (abort/concurrency). */
  gate?: Promise<void>;
  /**
   * Live session events emitted to `subscribe` listeners while THIS reply
   * is produced (after the gate resolves, before the assistant message lands) —
   * lets tests script a `tool_execution_*` / `message_update` / `auto_retry_*`
   * sequence the progress condenser consumes. Loosely typed on purpose.
   */
  events?: Array<Record<string, unknown>>;
}

/** Structural shape of a dispatched custom tool as fake sessions see it
 * (nested-dispatch scripts call `execute` directly). */
export interface FakeCustomTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;
}

export interface FakeSessionState {
  messages: PiSessionMessage[];
  aborted: boolean;
  /** The customTools passed into createAgentSession (for nested-dispatch scripts). */
  customTools: FakeCustomTool[];
  /**
   * Live count of event listeners currently subscribed to this session: lets a test assert dispatch's `finally` unsubscribes — the count
   * must return to 0 after dispatch settles, on both success and failure paths.
   */
  listenerCount(): number;
  /** Messages delivered via `steer()`: SendMessage's running-agent path. */
  steerMessages: string[];
  /** Messages delivered via `followUp()`. */
  followUpMessages: string[];
  /**
   * Count of messages this session INHERITED from a fork seed — pre-loaded
   * into `messages` before the first prompt(), mirroring real Pi's forkFrom which
   * seeds the child session with the parent's history. `0` for a fresh (non-fork
   * or degraded-fork) session, so "fresh vs fork" is a one-line differential.
   */
  inheritedMessageCount: number;
}

export interface FakeSdkOptions {
  /** Sequential replies consumed across ALL sessions; the last one repeats. */
  replies?: Array<string | FakeReply>;
  /**
   * Full control over a prompt (overrides `replies`): return a reply to append,
   * or undefined after pushing messages onto `session.messages` yourself.
   */
  onPrompt?: (
    text: string,
    session: FakeSessionState,
  ) => Promise<FakeReply | string | void> | FakeReply | string | void;
  /** Reuse a caller-owned capture array for session options (vi.hoisted interop). */
  created?: Array<Record<string, unknown>>;
  /**
   * Omit `subscribe` from fake sessions: proves dispatch works unchanged
   * when the session cannot stream events (older SDK / minimal fake).
   */
  noSubscribe?: boolean;
  /** Throw while installing a lifecycle subscription. */
  subscribeThrows?: boolean;
  /**
   * Scripted session stats: fake sessions return this from
   * `getSessionStats()`. A value is returned as-is; a function is evaluated per
   * call (lets a test vary usage across sessions). Faithful to the real optional
   * contract — `getSessionStats?(): PiSessionStats` — the method is present-or-
   * absent and, when present, returns a NON-undefined `PiSessionStats`; the
   * function form must too. When `stats` is unset the method is omitted entirely
   * (method-absent), so dispatch reports no usage via that faithful route.
   */
  stats?: PiSessionStats | ((session: FakeSessionState) => PiSessionStats);
  /**
   * Omit `getSessionStats` from fake sessions: proves usage stays
   * undefined with no crash when the SDK/session cannot report stats.
   */
  noGetSessionStats?: boolean;
  /**
   * Seed the parent history a `subagent_type: "fork"` inherits. The fake
   * `forkSessionManager` captures these; `createAgentSession` pre-populates the
   * child session's `messages` from them (real Pi's forkFrom pre-loads the same
   * history from the source transcript FILE). Undefined ⇒ an empty inherited
   * history. Ignored when the real SessionManager seam is injected (that path
   * exercises the genuine on-disk forkFrom).
   */
  forkSeed?: PiSessionMessage[];
  /**
   * Omit `forkSessionManager` from the fake SDK: proves the "SDK cannot
   * fork" degrade path (a `"fork"` dispatch then runs fresh with a notice).
   */
  noForkSessionManager?: boolean;
  /** Enable deterministic fake persisted create/open managers with custom-entry branches. */
  fakePersistedSessions?: boolean;
  /** Throw on this one-based custom-entry append across fake managers. */
  failCustomAppendAt?: number;
}

/** The options object the shared factory passes to each `createBashTool`. */
export interface BuiltinBashOptions {
  shellPath?: string;
  spawnHook?: (a: { command: unknown; cwd: unknown; env: Record<string, string | undefined> }) => {
    command: unknown;
    cwd: unknown;
    env: Record<string, string>;
  };
}

export interface FakeSdkHandle {
  sdk: PiSdk;
  /** Options of every createAgentSession call, in order. */
  created: Array<Record<string, unknown>>;
  /** State of every fake session, in order. */
  sessions: FakeSessionState[];
  abortCalls: () => number;
  promptCalls: () => number;
  /** Wait until the requested prompt has entered and its user message is recorded. */
  waitForPromptCalls(count: number): Promise<void>;
  /** Args of every forkSessionManager call, in order (wiring assertions). */
  forkCalls: () => Array<{ sourcePath: string; cwd: string; sessionDir: string; id: string }>;
  /** Options captured from each shared-factory `createBashTool` call (spawnHook + shellPath). */
  builtinBashOptions: () => BuiltinBashOptions[];
  /** Custom-entry branches keyed by fake transcript path. */
  sessionBranches: () => Map<string, unknown[]>;
}

export function fakeSdk(options: FakeSdkOptions = {}): FakeSdkHandle {
  const created = options.created ?? [];
  const sessions: FakeSessionState[] = [];
  const replies = options.replies ?? [];
  let abortCalls = 0;
  let promptCalls = 0;
  const promptWaiters = new Set<{ count: number; signal: Deferred<void> }>();
  let replyIndex = 0;
  const forkCalls: Array<{ sourcePath: string; cwd: string; sessionDir: string; id: string }> = [];
  const sessionBranches = new Map<string, unknown[]>();
  let customAppendCount = 0;
  const fakeManager = (transcriptPath: string, seed: readonly unknown[] = []) => {
    const branch = [...seed];
    sessionBranches.set(transcriptPath, branch);
    return {
      getSessionFile: () => transcriptPath,
      getBranch: () => branch,
      appendCustomEntry: (customType: string, data: unknown) => {
        customAppendCount++;
        if (customAppendCount === options.failCustomAppendAt) throw new Error("scripted custom-entry failure");
        branch.push({ type: "custom", customType, data });
        return `custom-${branch.length}`;
      },
      appendMessage: (message: unknown) => {
        branch.push({ type: "message", message });
        return `message-${branch.length}`;
      },
    };
  };

  // Shared built-in factory (buildStockBuiltinTools) wiring capture: the
  // subagent path now builds its seven built-ins from the factory against these
  // RECORDING constructors, so tests can (a) capture the bash options object —
  // including its `spawnHook` — to prove the env wiring, and (b) observe the
  // per-execute cwd rebind (BUG-2) via each tool's echoed construction cwd.
  const builtinBashOptions: BuiltinBashOptions[] = [];
  // Echo the CONSTRUCTION cwd per execute: the factory rebinds
  // `factory(cwdRef.get())` on EVERY call, so a recording tool constructed with
  // the live cwd reflects it — making the BUG-2 rebind test non-vacuous.
  const recordingBuiltin =
    (name: string) =>
    (cwd: string, options?: unknown) => {
      if (name === "bash" && options && typeof options === "object") {
        builtinBashOptions.push(options as BuiltinBashOptions);
      }
      return {
        name,
        async execute() {
          return { content: [{ type: "text", text: `${name}@${cwd}` }], details: { cwd } };
        },
      };
    };
  const recordingBuiltinDef = (_cwd: string) => ({
    renderCall: () => ({ render: () => [] as string[] }),
    renderResult: () => ({ render: () => [] as string[] }),
  });

  const notifyPromptWaiters = () => {
    for (const waiter of promptWaiters) {
      if (promptCalls >= waiter.count) {
        promptWaiters.delete(waiter);
        waiter.signal.resolve();
      }
    }
  };

  const waitForPromptCalls = (count: number): Promise<void> => {
    const waiter = { count, signal: deferred<void>() };
    if (promptCalls < count) promptWaiters.add(waiter);
    return waitUntil({
      description: `prompt call count to reach ${count}`,
      predicate: () =>
        promptCalls >= count || waiter.signal.promise.then(() => promptCalls >= count),
      describeObserved: () => `expected: ${count}; actual: ${promptCalls}`,
    }).finally(() => promptWaiters.delete(waiter));
  };

  const normalize = (reply: string | FakeReply | undefined): FakeReply =>
    typeof reply === "string" ? { text: reply } : (reply ?? { text: "" });

  const sdk: PiSdk = {
    async createAgentSession(sessionOptions) {
      created.push(sessionOptions);
      const state: FakeSessionState = {
        messages: [],
        aborted: false,
        customTools: (sessionOptions.customTools as FakeCustomTool[]) ?? [],
        listenerCount: () => 0,
        steerMessages: [],
        followUpMessages: [],
        inheritedMessageCount: 0,
      };
      sessions.push(state);
      // Persistence mirror: real AgentSessions write every message
      // through their SessionManager — fake sessions do the same when the
      // dispatch handed them one with appendMessage (the real SessionManager
      // from persistedSessionManager below; the in-memory `{}` is a no-op).
      const manager = sessionOptions.sessionManager as
        | {
            appendMessage?: (message: unknown) => unknown;
            __forkSeed?: PiSessionMessage[];
            __resumeSeed?: PiSessionMessage[];
          }
        | undefined;
      // Fork inheritance: a fork's fake session manager carries a captured
      // seed of the parent history (`__forkSeed`) — pre-load it into the child
      // session's messages, exactly as real Pi's forkFrom pre-loads the parent's
      // history from the source transcript. Gated on the marker so ordinary
      // persisted/reopened managers are untouched.
      if (manager?.__forkSeed?.length) {
        for (const seeded of manager.__forkSeed) state.messages.push(seeded);
        state.inheritedMessageCount = manager.__forkSeed.length;
      } else if (manager?.__resumeSeed?.length) {
        for (const seeded of manager.__resumeSeed) state.messages.push(seeded);
      }
      const record = (message: PiSessionMessage) => {
        state.messages.push(message);
        manager?.appendMessage?.(message);
      };
      let signalAbort: () => void = () => {};
      const abortedGate = new Promise<void>((resolve) => (signalAbort = resolve));
      // Live event listeners: real AgentSessions expose subscribe(); fakes
      // register listeners here and reply.events are broadcast during prompt().
      const listeners = new Set<(event: unknown) => void>();
      state.listenerCount = () => listeners.size;
      const emit = (event: unknown) => {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch {
            // a listener throwing must not break the fake session
          }
        }
      };
      const subscribe = (listener: (event: unknown) => void) => {
        if (options.subscribeThrows) throw new Error("subscribe setup failed");
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      // Scripted usage stats: a real AgentSession exposes getSessionStats();
      // fakes return the scripted stats (or a per-session function's result).
      // Faithful to the real optional contract: the method is present only when
      // stats are actually scripted, and when present it always yields a
      // non-undefined PiSessionStats. `scriptedStats` is const, so the per-branch
      // narrowing carries into the closures — no cast needed.
      const scriptedStats = options.stats;
      const getSessionStats: (() => PiSessionStats) | undefined =
        scriptedStats === undefined
          ? undefined
          : typeof scriptedStats === "function"
            ? () => scriptedStats(state)
            : () => scriptedStats;
      return {
        session: {
          messages: state.messages,
          ...(options.noSubscribe ? {} : { subscribe }),
          ...(options.noGetSessionStats || getSessionStats === undefined
            ? {}
            : { getSessionStats }),
          async prompt(text: string) {
            promptCalls++;
            record({ role: "user", content: text });
            // Readiness is observable before any scripted gate can hold the run.
            notifyPromptWaiters();
            let reply: FakeReply;
            if (options.onPrompt) {
              const before = state.messages.length;
              const scripted = await options.onPrompt(text, state);
              if (scripted === undefined) {
                // The hook appended its own messages — mirror them too.
                for (const message of state.messages.slice(before)) {
                  manager?.appendMessage?.(message);
                }
                return;
              }
              reply = normalize(scripted);
            } else {
              reply = normalize(replies[Math.min(replyIndex, replies.length - 1)]);
              replyIndex++;
            }
            if (reply.gate) await Promise.race([reply.gate, abortedGate]);
            // Broadcast scripted live events before the reply settles.
            for (const event of reply.events ?? []) emit(event);
            if (state.aborted) {
              // Real Pi: an aborted run ends on a stopReason "aborted" assistant message.
              record({
                role: "assistant",
                content: [],
                stopReason: "aborted",
                errorMessage: "Aborted",
              });
              return;
            }
            record({
              role: "assistant",
              content: [{ type: "text", text: reply.text ?? "" }],
              stopReason: reply.stopReason ?? "stop",
              ...(reply.errorMessage !== undefined ? { errorMessage: reply.errorMessage } : {}),
            });
          },
          dispose() {},
          abort() {
            abortCalls++;
            state.aborted = true;
            signalAbort();
          },
          // Steering seam: SendMessage delivers a mid-task course
          // correction to a RUNNING background dispatch through steer().
          steer(text: string) {
            state.steerMessages.push(text);
          },
          followUp(text: string) {
            state.followUpMessages.push(text);
          },
        },
      };
    },
    DefaultResourceLoader: class {
      constructor(public options: Record<string, unknown>) {}
      async reload() {}
    },
    inMemorySessionManager: () => fakeManager(`/fake-memory/${sessionBranches.size}.jsonl`),
    // The REAL Pi SessionManager: transcript tests exercise the actual
    // create/flush/open surface. Only reached when a dispatch knows the main
    // session file (deps.getMainSessionFile) AND a test injected the real
    // manager via useRealSessionManager(); otherwise absent, so unit tests stay
    // fully in-memory (and the "SDK lacks persistedSessionManager" path is real).
    persistedSessionManager: realSessionManager
      ? (cwd: string, sessionDir: string, id: string) =>
          realSessionManager!.create(cwd, sessionDir, { id })
      : options.fakePersistedSessions
        ? (_cwd: string, sessionDir: string, id: string) =>
            fakeManager(`${sessionDir.replace(/[\\/]$/, "")}/${id}.jsonl`)
        : undefined,
    // Resume: reopen the SAME transcript with the REAL SessionManager so
    // offline-integration tests exercise Pi's actual open/restore/append surface.
    reopenSessionManager: realSessionManager
      ? (transcriptPath: string, sessionDir: string, cwd: string) =>
          realSessionManager!.open(transcriptPath, sessionDir, cwd)
      : options.fakePersistedSessions
        ? (transcriptPath: string) => {
            const branch = sessionBranches.get(transcriptPath) ?? [];
            const messages = branch.flatMap((entry) => {
              if (typeof entry !== "object" || entry === null) return [];
              const candidate = entry as { type?: unknown; message?: unknown };
              return candidate.type === "message" ? [candidate.message as PiSessionMessage] : [];
            });
            return {
              ...fakeManager(transcriptPath, branch),
              __resumeSeed: messages,
            } as unknown as PiSessionManagerLike;
          }
        : undefined,
    // Fork: seed a NEW subagent transcript from a source session's history.
    // With the real SessionManager injected, exercise the genuine on-disk
    // forkFrom; otherwise return a fake manager carrying a captured `__forkSeed`
    // (createAgentSession pre-loads it). Omitted entirely under noForkSessionManager
    // so the "SDK cannot fork" degrade path is real. Every call is recorded.
    forkSessionManager: options.noForkSessionManager
      ? undefined
      : realSessionManager
        ? (sourcePath: string, cwd: string, sessionDir: string, id: string) => {
            forkCalls.push({ sourcePath, cwd, sessionDir, id });
            return realSessionManager!.forkFrom(sourcePath, cwd, sessionDir, { id });
          }
        : (sourcePath: string, cwd: string, sessionDir: string, id: string) => {
            forkCalls.push({ sourcePath, cwd, sessionDir, id });
            const messages: PiSessionMessage[] = [...(options.forkSeed ?? [])];
            const manager = fakeManager(
              `/fake-fork/${id}.jsonl`,
              sessionBranches.get(sourcePath) ?? [],
            );
            return {
              ...manager,
              __forkSeed: messages,
              buildSessionContext: () => ({ messages }),
              appendMessage: (message: unknown) => {
                messages.push(message as PiSessionMessage);
                return manager.appendMessage(message);
              },
            } as unknown as PiSessionManagerLike;
          },
    inMemorySettingsManager: () => ({}),
    agentDir: () => "/fake-agent-dir",
    // Shared built-in factory constructors: RECORDING versions so the
    // subagent path's `buildStockBuiltinTools` call produces valid, non-crashing
    // tool defs the whole dispatch corpus can run through, while capturing the
    // bash spawnHook (env wiring) and echoing the live cwd per execute (cwd rebind).
    createBashTool: recordingBuiltin("bash"),
    createReadTool: recordingBuiltin("read"),
    createWriteTool: recordingBuiltin("write"),
    createEditTool: recordingBuiltin("edit"),
    createGrepTool: recordingBuiltin("grep"),
    createFindTool: recordingBuiltin("find"),
    createLsTool: recordingBuiltin("ls"),
    createBashToolDefinition: recordingBuiltinDef,
    createReadToolDefinition: recordingBuiltinDef,
    createWriteToolDefinition: recordingBuiltinDef,
    createEditToolDefinition: recordingBuiltinDef,
    createGrepToolDefinition: recordingBuiltinDef,
    createFindToolDefinition: recordingBuiltinDef,
    createLsToolDefinition: recordingBuiltinDef,
  };

  return {
    sdk,
    created,
    sessions,
    abortCalls: () => abortCalls,
    promptCalls: () => promptCalls,
    waitForPromptCalls,
    forkCalls: () => forkCalls,
    builtinBashOptions: () => builtinBashOptions,
    sessionBranches: () => sessionBranches,
  };
}

/** A minimal valid ClaudeAgent for dispatch tests. */
export function makeAgent(overrides: Partial<ClaudeAgent> = {}): ClaudeAgent {
  return {
    name: "reviewer",
    description: "Reviews things",
    metadata: {},
    body: "You are the reviewer.",
    source: { path: "<test>", scope: "project" },
    unknownKeys: [],
    diagnostics: [],
    ...overrides,
  };
}

/**
 * Fire-only hook-runner facade for test fakes — exactly the surface the
 * SubagentRuntime uses (its own multiplexer builds the same shape). Method
 * syntax keeps fake `payload` parameter types bivariant, so scripts can type
 * it loosely.
 */
export interface FakeHookRunner {
  fire(
    eventName: string,
    payload: Record<string, unknown>,
    toolCall?: unknown,
  ): Promise<HookOutcome | undefined>;
}

/** Typed deps overrides: everything from the real deps, hookRunner as the fire-only facade. */
export type SubagentRuntimeOverrides = Partial<Omit<SubagentRuntimeDeps, "hookRunner">> & {
  hookRunner?: FakeHookRunner;
};

/** A SubagentRuntime wired with no-op deps around the given fake SDK. */
export function makeSubagentRuntime(
  agents: ClaudeAgent[],
  sdk: PiSdk,
  overrides: SubagentRuntimeOverrides = {},
): SubagentRuntime {
  const engine = new PermissionEngine(
    { allow: [], deny: [], ask: [], additionalDirectories: [] },
    { cwd: process.cwd() },
  );
  const hookRunner = new HookRunner({
    config: {},
    projectDir: process.cwd(),
    sessionId: "t",
    env: {},
    disableAllHooks: true,
  });
  const deps: SubagentRuntimeDeps = {
    getAgents: () => agents,
    buildSystemPrompt: (a: ClaudeAgent) => `SYSTEM:${a.name}`,
    customToolsFor: (_agent, _granted, _depth, _owner, _fork, _cwd, _notebook, _activation, _stop) => [],
    allKnownToolNames: () => ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
    permissionEngine: engine,
    getCwd: () => process.cwd(),
    resolveModel: () => undefined,
    mapEffort: () => undefined,
    maxDepth: 2,
    concurrency: 2,
    sessionId: "t",
    sdk,
    ...overrides,
    // The runtime only ever calls fire(); the facade is the same shape its own
    // hook multiplexer produces, so this narrow cast is honest.
    hookRunner: (overrides.hookRunner ?? hookRunner) as HookRunner,
  };
  return new SubagentRuntime(deps);
}

import {
  SubagentRuntime,
  type PiSdk,
  type PiSessionMessage,
  type SubagentRuntimeDeps,
} from "../../src/runtime/subagents.js";
import { PermissionEngine } from "../../src/engine/permissions.js";
import { HookRunner } from "../../src/engine/hook-runner.js";
import type { ClaudeAgent, HookOutcome } from "../../src/types.js";

/**
 * Shared fake Pi SDK builder (t01): the one place tests fake `createAgentSession`.
 * Replaces the copy-pasted fakes that previously lived in runtime-core,
 * background-tasks, and builtin-agents tests — extend THIS instead of forking.
 *
 * Sessions behave like real Pi sessions at the failure surface: every assistant
 * message carries a `stopReason` (default "stop"), `abort()` resolves a pending
 * gated prompt with stopReason "aborted", and `prompt()` always resolves
 * normally — terminal failures live on the last assistant message, never as a
 * rejection (pi-agent-core agent-loop semantics).
 */

/** One scripted assistant reply. Strings are shorthand for `{ text }`. */
export interface FakeReply {
  text?: string;
  /** Pi StopReason vocabulary; defaults to "stop". */
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  /** Await this before replying — lets tests hold a prompt open (abort/concurrency). */
  gate?: Promise<void>;
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
}

export interface FakeSdkHandle {
  sdk: PiSdk;
  /** Options of every createAgentSession call, in order. */
  created: Array<Record<string, unknown>>;
  /** State of every fake session, in order. */
  sessions: FakeSessionState[];
  abortCalls: () => number;
  promptCalls: () => number;
}

export function fakeSdk(options: FakeSdkOptions = {}): FakeSdkHandle {
  const created = options.created ?? [];
  const sessions: FakeSessionState[] = [];
  const replies = options.replies ?? [];
  let abortCalls = 0;
  let promptCalls = 0;
  let replyIndex = 0;

  const normalize = (reply: string | FakeReply | undefined): FakeReply =>
    typeof reply === "string" ? { text: reply } : (reply ?? { text: "" });

  const sdk: PiSdk = {
    async createAgentSession(sessionOptions) {
      created.push(sessionOptions);
      const state: FakeSessionState = {
        messages: [],
        aborted: false,
        customTools: (sessionOptions.customTools as FakeCustomTool[]) ?? [],
      };
      sessions.push(state);
      let signalAbort: () => void = () => {};
      const abortedGate = new Promise<void>((resolve) => (signalAbort = resolve));
      return {
        session: {
          messages: state.messages,
          async prompt(text: string) {
            promptCalls++;
            state.messages.push({ role: "user", content: text });
            let reply: FakeReply;
            if (options.onPrompt) {
              const scripted = await options.onPrompt(text, state);
              if (scripted === undefined) return; // hook appended its own messages
              reply = normalize(scripted);
            } else {
              reply = normalize(replies[Math.min(replyIndex, replies.length - 1)]);
              replyIndex++;
            }
            if (reply.gate) await Promise.race([reply.gate, abortedGate]);
            if (state.aborted) {
              // Real Pi: an aborted run ends on a stopReason "aborted" assistant message.
              state.messages.push({
                role: "assistant",
                content: [],
                stopReason: "aborted",
                errorMessage: "Aborted",
              });
              return;
            }
            state.messages.push({
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
        },
      };
    },
    DefaultResourceLoader: class {
      constructor(public options: Record<string, unknown>) {}
      async reload() {}
    },
    inMemorySessionManager: () => ({}),
    inMemorySettingsManager: () => ({}),
    agentDir: () => "/fake-agent-dir",
  };

  return {
    sdk,
    created,
    sessions,
    abortCalls: () => abortCalls,
    promptCalls: () => promptCalls,
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
    customToolsFor: () => [],
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

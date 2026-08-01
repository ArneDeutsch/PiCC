/**
 * Type-level Pi contract pins. This file is never executed — it is
 * compiled by test/pi-contract.test.ts with the REAL TypeScript checker
 * (vitest's esbuild transform does not typecheck, and the project tsconfig
 * excludes test/), so a Pi type-surface change fails the contract suite
 * loudly with the tsc message.
 */
import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
  type RetryCallbacks,
  type RetryPolicy,
  type StopReason,
  type ThinkingContent,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
  MessageRenderOptions,
  NewSessionOptions,
  SessionStats,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
// Value imports for public static/function surfaces; still never executed —
// this file is only ever compiled.
import {
  generateSummary,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Exact StopReason vocabulary — a missing or extra member fails to compile.
// PiCC's outcome classification keys off "pending" / "error" / "aborted" / "length".
export const stopReasonVocabulary: Record<StopReason, true> = {
  pending: true,
  stop: true,
  length: true,
  toolUse: true,
  error: true,
  aborted: true,
};

// stopReason is REQUIRED on AssistantMessage...
export const stopReasonRequired: undefined extends AssistantMessage["stopReason"]
  ? "PIN BROKEN: AssistantMessage.stopReason became optional"
  : "ok" = "ok";

// ...and errorMessage is an optional string carrying the terminal failure text.
export const errorMessageOptional: AssistantMessage["errorMessage"] = undefined;
export const errorMessageString: AssistantMessage["errorMessage"] = "terminal failure";
export const rawStopReasonOptional: AssistantMessage["rawStopReason"] = undefined;
export const rawStopReasonString: AssistantMessage["rawStopReason"] = "provider-specific-terminal";
export const retryClassifierArg: Parameters<typeof isRetryableAssistantError>[0] = {} as AssistantMessage;
export const retryClassifierResult: ReturnType<typeof isRetryableAssistantError> = true;
export const overflowClassifierArgs: Parameters<typeof isContextOverflow> = [{} as AssistantMessage, 100_000];
export const overflowClassifierResult: ReturnType<typeof isContextOverflow> = false;

// ToolDefinition.execute is (toolCallId, params, signal, onUpdate, ctx) — the
// Agent tool forwards the 3rd parameter (AbortSignal | undefined) into dispatch.
type Exec = ToolDefinition["execute"];
export const executeArity: Parameters<Exec>["length"] = 5;
export const executeSignal: Parameters<Exec>[2] = new AbortController().signal;
export const executeSignalOptional: Parameters<Exec>[2] = undefined;

// --- foreground-glyph self-shell surface ---

// renderShell accepts "self" — the only ToolDefinition lever that removes Pi's
// default padded, state-background shell so PiCC can own foreground glyph framing.
// A Pi change that removes the field or the "self" member fails to compile here.
export const renderShellSelf: NonNullable<ToolDefinition["renderShell"]> = "self";
export const messageRendererOutputPad: MessageRenderOptions["outputPad"] = 1;

// --- subagent transcript persistence surface ---

// SessionManager.create(cwd, sessionDir?, options?) — the custom sessionDir +
// pinned-id form PiCC uses for subagent transcripts — returns a SessionManager.
export const createArgs: Parameters<typeof SessionManager.create> = [
  "/cwd",
  "/custom/session/dir",
  { id: "agent-0123456789ab" },
];
export const createReturns: ReturnType<typeof SessionManager.create> extends SessionManager
  ? "ok"
  : "PIN BROKEN: SessionManager.create no longer returns a SessionManager" = "ok";

// NewSessionOptions.id is the optional string pinning the session/file identity.
export const newSessionId: NewSessionOptions["id"] = "agent-0123456789ab";
export const newSessionIdOptional: NewSessionOptions["id"] = undefined;

// SessionManager.open(path, sessionDir?, cwdOverride?) reopens a transcript…
export const openArgs: Parameters<typeof SessionManager.open> = ["/file.jsonl", "/dir", "/cwd"];
export const openReturns: ReturnType<typeof SessionManager.open> extends SessionManager
  ? "ok"
  : "PIN BROKEN: SessionManager.open no longer returns a SessionManager" = "ok";

// …and the reopened manager exposes the restore/read surface dispatch relies on.
export const sessionFileGetter: ReturnType<SessionManager["getSessionFile"]> = undefined;
export const restoreSurface: keyof SessionManager = "buildSessionContext";
export const branchSurface: ReturnType<SessionManager["getBranch"]> = [];
export const appendCustomArgs: Parameters<SessionManager["appendCustomEntry"]> = [
  "picc-notebook-session",
  { version: 1, generation: 0, records: [] },
];
export const forkArgs: Parameters<typeof SessionManager.forkFrom> = [
  "/source.jsonl",
  "/cwd",
  "/custom/session/dir",
  { id: "agent-0123456789ab" },
];
export const forkReturns: ReturnType<typeof SessionManager.forkFrom> extends SessionManager
  ? "ok"
  : "PIN BROKEN: SessionManager.forkFrom no longer returns a SessionManager" = "ok";

// --- live-progress event stream surface ---

// AgentSession.subscribe(listener) exists and returns an unsubscribe function —
// the seam dispatch() uses to stream a subagent's activity to the parent UI.
export const subscribeArg: Parameters<AgentSession["subscribe"]>[0] = (
  _event: AgentSessionEvent,
): void => {};
export const subscribeReturns: ReturnType<AgentSession["subscribe"]> = () => {};
export const listenerAssignable: AgentSessionEventListener = (_event) => {};

// The event kinds the condenser keys off must all be members of the union.
export const turnStart: Extract<AgentSessionEvent, { type: "turn_start" }>["type"] = "turn_start";
export const turnEnd: Extract<AgentSessionEvent, { type: "turn_end" }>["type"] = "turn_end";
export const messageUpdate: Extract<AgentSessionEvent, { type: "message_update" }> = {
  type: "message_update",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "retained" }],
    api: "openai-completions",
    provider: "contract",
    model: "contract-model",
    usage: {
      input: 0,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  },
  assistantMessageEvent: {
    type: "text_delta",
    contentIndex: 0,
    delta: "retained",
    partial: {
      role: "assistant",
      content: [{ type: "text", text: "retained" }],
      api: "openai-completions",
      provider: "contract",
      model: "contract-model",
      usage: {
        input: 0,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
  },
};
export const ordinaryThinking: ThinkingContent = {
  type: "thinking",
  thinking: "retained reasoning",
};
export const opaqueThinking: ThinkingContent = {
  type: "thinking",
  thinking: "",
  thinkingSignature: "opaque-provider-payload",
  redacted: true,
};
export const ordinaryThinkingAssistant: AssistantMessage = {
  role: "assistant",
  content: [ordinaryThinking],
  api: "openai-completions",
  provider: "contract",
  model: "contract-model",
  usage: {
    input: 0,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};
export const thinkingMessageUpdate: Extract<AgentSessionEvent, { type: "message_update" }> = {
  type: "message_update",
  message: {
    role: "assistant",
    content: [opaqueThinking],
    api: "openai-completions",
    provider: "contract",
    model: "contract-model",
    usage: {
      input: 0,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  },
  assistantMessageEvent: {
    type: "thinking_end",
    contentIndex: 0,
    content: "",
    partial: {
      role: "assistant",
      content: [opaqueThinking],
      api: "openai-completions",
      provider: "contract",
      model: "contract-model",
      usage: {
        input: 0,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
  },
};
export const retainedToolResult: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "Write",
  content: [{ type: "text", text: "permission denied" }],
  isError: true,
  timestamp: 1,
};

export const messageEnd: Extract<AgentSessionEvent, { type: "message_end" }> = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "contract",
    model: "contract-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  },
};
export const toolStart: Extract<AgentSessionEvent, { type: "tool_execution_start" }> = {
  type: "tool_execution_start",
  toolCallId: "call-1",
  toolName: "Write",
  args: { path: "file.txt" },
};
export const toolUpdate: Extract<
  AgentSessionEvent,
  { type: "tool_execution_update" }
>["type"] = "tool_execution_update";
export const toolEnd: Extract<AgentSessionEvent, { type: "tool_execution_end" }>["type"] =
  "tool_execution_end";

// --- resume + steer surface ---

// AgentSession.steer(text, images?) → Promise<void> — the mid-task
// course-correction seam SendMessage uses for a RUNNING background dispatch.
export const steerArg: Parameters<AgentSession["steer"]>[0] = "course correct";
export const steerReturns: ReturnType<AgentSession["steer"]> = Promise.resolve();
// AgentSession.followUp(text, images?) → Promise<void> — pinned alongside steer.
export const followUpArg: Parameters<AgentSession["followUp"]>[0] = "follow up";
export const followUpReturns: ReturnType<AgentSession["followUp"]> = Promise.resolve();

// --- per-subagent usage accounting surface ---

// AgentSession.getSessionStats() returns SessionStats — the aggregate token/cost
// totals PiCC records per subagent. A signature change fails this pin.
export const getSessionStatsReturns: ReturnType<AgentSession["getSessionStats"]> extends SessionStats
  ? "ok"
  : "PIN BROKEN: AgentSession.getSessionStats no longer returns SessionStats" = "ok";
// The exact token/cost fields usageFromStats() reads off SessionStats.
export const statsTokens: SessionStats["tokens"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
};
export const statsCost: SessionStats["cost"] = 0;

// The silent-wait retry events carry the attempt/max fields the condenser shows.
export const retryStart: Extract<AgentSessionEvent, { type: "auto_retry_start" }> = {
  type: "auto_retry_start",
  attempt: 1,
  maxAttempts: 3,
  delayMs: 2000,
  errorMessage: "rate limited",
};
export const retryEnd: Extract<AgentSessionEvent, { type: "auto_retry_end" }> = {
  type: "auto_retry_end",
  success: true,
  attempt: 1,
};

// --- public summarization retry surface ---

export const summaryStream: Parameters<typeof generateSummary>[9] = () => {
  throw new Error("compile-only stream pin");
};
export const summaryRetryPolicy: Parameters<typeof generateSummary>[11] = {
  enabled: true,
  maxRetries: 1,
  baseDelayMs: 0,
} satisfies RetryPolicy;
export const summaryRetryCallbacks: Parameters<typeof generateSummary>[12] = {
  onRetryScheduled: (_attempt, _maxAttempts, _delayMs, _errorMessage) => {},
  onRetryAttemptStart: () => {},
  onRetryFinished: (_success, _attempt, _finalError) => {},
} satisfies RetryCallbacks;

const freshSettings = SettingsManager.inMemory();
export const retrySettings: ReturnType<typeof freshSettings.getRetrySettings> = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
};
export const providerRetrySettings: ReturnType<typeof freshSettings.getProviderRetrySettings> = {
  timeoutMs: undefined,
  maxRetries: undefined,
  maxRetryDelayMs: 60_000,
};

export const summarizationRetryScheduled: Extract<
  AgentSessionEvent,
  { type: "summarization_retry_scheduled" }
> = {
  type: "summarization_retry_scheduled",
  attempt: 1,
  maxAttempts: 3,
  delayMs: 2000,
  errorMessage: "socket closed",
};
export const compactionRetryAttemptStart: Extract<
  AgentSessionEvent,
  { type: "summarization_retry_attempt_start"; source: "compaction" }
> = {
  type: "summarization_retry_attempt_start",
  source: "compaction",
  reason: "threshold",
};
export const summarizationRetryFinished: Extract<
  AgentSessionEvent,
  { type: "summarization_retry_finished" }
> = { type: "summarization_retry_finished" };

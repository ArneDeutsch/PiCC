/**
 * Type-level Pi contract pins. This file is never executed — it is
 * compiled by test/pi-contract.test.ts with the REAL TypeScript checker
 * (vitest's esbuild transform does not typecheck, and the project tsconfig
 * excludes test/), so a Pi type-surface change fails the contract suite
 * loudly with the tsc message.
 */
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
  NewSessionOptions,
  SessionStats,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
// Value import of the CLASS (for its static side); still never executed —
// this file is only ever compiled.
import { SessionManager } from "@earendil-works/pi-coding-agent";

// Exact StopReason vocabulary — a missing or extra member fails to compile.
// PiCC's outcome classification keys off "error" / "aborted" / "length".
export const stopReasonVocabulary: Record<StopReason, true> = {
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
export const messageUpdate: Extract<AgentSessionEvent, { type: "message_update" }>["type"] =
  "message_update";
export const toolStart: Extract<
  AgentSessionEvent,
  { type: "tool_execution_start" }
>["type"] = "tool_execution_start";
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

/**
 * Type-level Pi contract pins (t01). This file is never executed — it is
 * compiled by test/pi-contract.test.ts with the REAL TypeScript checker
 * (vitest's esbuild transform does not typecheck, and the project tsconfig
 * excludes test/), so a Pi type-surface change fails the contract suite
 * loudly with the tsc message.
 */
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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

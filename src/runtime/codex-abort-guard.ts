/** Stateless public Codex transport policy for pre-aborted calls and Pi standalone summaries. */

import type {
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";

// Pi's public compat entry re-exports the public Codex API loader and is the
// extension-loader-safe spelling (the loader aliases the pi-ai package root).
const codexStreamSimple = openAICodexResponsesApi().streamSimple;
const PI_SUMMARIZATION_SYSTEM_PROMPT = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPiStandaloneSummary(context: Context, options?: SimpleStreamOptions): boolean {
  return options?.cacheRetention === "none"
    && typeof options.sessionId === "string"
    && UUID_V7.test(options.sessionId)
    && context.systemPrompt === PI_SUMMARIZATION_SYSTEM_PROMPT
    && (context.tools === undefined || context.tools.length === 0)
    && context.messages.filter((message) => message.role === "user").length === 1;
}

/**
 * Preserve ordinary Codex options, force SSE before dispatch when already aborted, and give Pi's
 * standalone-summary loop sole retry ownership. Cache retention alone cannot identify a summary;
 * the complete public request signature is required. A custom caller reproducing that exact
 * signature is indistinguishable from Pi and intentionally receives the same summary policy.
 */
export function registerCodexAbortGuard(pi: {
  registerProvider(name: string, config: Record<string, unknown>): void;
}): void {
  pi.registerProvider("picc-codex-abort-guard", {
    api: "openai-codex-responses",
    streamSimple: codexAbortGuardStreamSimple,
  });
}

export function codexAbortGuardStreamSimple(
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const summary = isPiStandaloneSummary(context, options);
  if (options?.signal?.aborted || summary) {
    return codexStreamSimple(model, context, {
      ...options,
      transport: "sse",
      ...(summary ? { maxRetries: 0 } : {}),
    });
  }
  return codexStreamSimple(model, context, options);
}

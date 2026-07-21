/** Stateless public Codex transport guard for requests aborted before dispatch. */

import type {
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";

// Pi's public compat entry re-exports the public Codex API loader and is the
// extension-loader-safe spelling (the loader aliases the pi-ai package root).
const codexStreamSimple = openAICodexResponsesApi().streamSimple;

/** Preserve normal Codex auto transport; force abort-aware SSE only once already aborted. */
export function codexAbortGuardStreamSimple(
  model: Model<"openai-codex-responses">,
  context: Context,
  options?: SimpleStreamOptions,
) {
  if (options?.signal?.aborted) {
    return codexStreamSimple(model, context, { ...options, transport: "sse" });
  }
  return codexStreamSimple(model, context, options);
}

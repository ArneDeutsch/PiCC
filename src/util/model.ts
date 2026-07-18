// ---------------------------------------------------------------------------
// Pure model predicates — dependency-light, no project-model or Pi knowledge.
//
// `modelSupportsImages` is consumed from BOTH the runtime (image ingestion,
// notebook rendering) and the registry (compat report / vision surface). It is a
// pure predicate on the model's declared `input` modalities, so it lives in the
// lowest shared layer (util/) rather than in runtime/, where a registry import of
// it would invert the architecture's layer order (registry sits below runtime).
// ---------------------------------------------------------------------------

/**
 * True iff the model's input modalities include `"image"`. Tolerant of a
 * missing/opaque model (defaults to `false`) — mirrors the condition Pi's
 * `getNonVisionImageNote` keys on (`model.input.includes("image")`).
 */
export function modelSupportsImages(model: unknown): boolean {
  const input = (model as { input?: unknown } | null | undefined)?.input;
  return Array.isArray(input) && input.includes("image");
}

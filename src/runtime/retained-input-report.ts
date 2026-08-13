import type { PostCommitStage, QueuedInputShadow, QueueContent } from "./mid-run-compaction.js";

export interface RetainedInputReport {
  readonly reportId: object;
  readonly agentId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly stage: PostCommitStage;
  readonly occurrences: readonly {
    readonly shadow: QueuedInputShadow;
    readonly disposition: "reported";
  }[];
  readonly unrepresentableCount: number;
  readonly guidance: string;
  claim(deliver: (report: RetainedInputReport) => boolean | Promise<boolean>): Promise<boolean>;
}

const GUIDANCE_CAP = 2_000;
const CONTENT_DEPTH_CAP = 20;
const CONTENT_NODE_CAP = 10_000;
const CONTENT_TEXT_CAP = 100_000;
const OCCURRENCE_CAP = 256;

function addSafeCount(current: number, omitted: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + Math.min(Number.MAX_SAFE_INTEGER, omitted));
}

type JsonLike = null | boolean | number | string | readonly JsonLike[] | { readonly [key: string]: JsonLike };

function natural(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a finite non-negative integer`);
  }
  return value;
}

function sanitizeGuidance(value: string): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim();
  return clean.length <= GUIDANCE_CAP ? clean : `${clean.slice(0, GUIDANCE_CAP - 14)}… [truncated]`;
}

/** Normalize only inert JSON-like data; invoking user accessors or preserving exotic prototypes is unsafe. */
function normalizeContent(value: unknown): JsonLike | undefined {
  const seen = new Set<object>();
  let nodes = 0;
  let text = 0;
  const visit = (candidate: unknown, depth: number): JsonLike | undefined => {
    if (++nodes > CONTENT_NODE_CAP || depth > CONTENT_DEPTH_CAP) return undefined;
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : undefined;
    if (typeof candidate === "string") {
      text += candidate.length;
      return text <= CONTENT_TEXT_CAP ? candidate : undefined;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) return undefined;
    const prototype = Object.getPrototypeOf(candidate);
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) return undefined;
    if (Object.getOwnPropertySymbols(candidate).length !== 0) return undefined;
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const result: JsonLike[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor)) return undefined;
          const nested = visit(descriptor.value, depth + 1);
          if (nested === undefined) return undefined;
          result.push(nested);
        }
        return Object.freeze(result);
      }
      const result: Record<string, JsonLike> = Object.create(null) as Record<string, JsonLike>;
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(candidate))) {
        if (!descriptor.enumerable) continue;
        text += key.length;
        if (text > CONTENT_TEXT_CAP || !("value" in descriptor)) return undefined;
        const nested = visit(descriptor.value, depth + 1);
        if (nested === undefined) return undefined;
        result[key] = nested;
      }
      return Object.freeze(result);
    } finally {
      seen.delete(candidate);
    }
  };
  return visit(value, 0);
}

function immutableShadow(
  shadow: QueuedInputShadow,
  expectedSessionId: string,
  expectedGeneration: number,
): QueuedInputShadow | undefined {
  try {
    if (!shadow || typeof shadow !== "object" || !Number.isSafeInteger(shadow.id) || shadow.id < 0 ||
        shadow.generation !== expectedGeneration || shadow.sessionId !== expectedSessionId ||
        (shadow.delivery !== "steer" && shadow.delivery !== "followUp")) return undefined;
    const content = normalizeContent(shadow.content);
    if (content === undefined || (typeof content !== "string" && !Array.isArray(content))) return undefined;
    return Object.freeze({
      id: shadow.id,
      generation: shadow.generation,
      sessionId: shadow.sessionId,
      delivery: shadow.delivery,
      content: content as QueueContent,
    });
  } catch {
    return undefined;
  }
}

export function createRetainedInputReport(options: {
  agentId: string;
  sessionId: string;
  generation: number;
  stage: PostCommitStage;
  occurrences: readonly QueuedInputShadow[];
  unrepresentableCount?: number;
  guidance: string;
}): RetainedInputReport {
  const generation = natural(options.generation, "generation");
  let unrepresentableCount = natural(options.unrepresentableCount ?? 0, "unrepresentableCount");
  let claimed = false;
  let claims = Promise.resolve();
  const reportId = Object.freeze({});
  let report!: RetainedInputReport;
  const represented: Array<Readonly<{ shadow: QueuedInputShadow; disposition: "reported" }>> = [];
  const representedIds = new Set<number>();
  for (let index = 0; index < options.occurrences.length; index += 1) {
    if (index >= OCCURRENCE_CAP) {
      unrepresentableCount = addSafeCount(unrepresentableCount, options.occurrences.length - index);
      break;
    }
    const shadow = immutableShadow(options.occurrences[index]!, options.sessionId, generation);
    if (shadow && !representedIds.has(shadow.id)) {
      representedIds.add(shadow.id);
      represented.push(Object.freeze({ shadow, disposition: "reported" as const }));
    } else {
      unrepresentableCount = addSafeCount(unrepresentableCount, 1);
    }
  }
  const occurrences = Object.freeze(represented);
  report = Object.freeze({
    reportId,
    agentId: options.agentId,
    sessionId: options.sessionId,
    generation,
    stage: options.stage,
    occurrences,
    unrepresentableCount,
    guidance: sanitizeGuidance(options.guidance),
    claim(deliver: (candidate: RetainedInputReport) => boolean | Promise<boolean>): Promise<boolean> {
      let resolveClaim!: (claimed: boolean) => void;
      const result = new Promise<boolean>((resolve) => { resolveClaim = resolve; });
      claims = claims.then(async () => {
        if (claimed) {
          resolveClaim(false);
          return;
        }
        let accepted = false;
        try {
          accepted = await deliver(report) === true;
        } catch {
          accepted = false;
        }
        if (accepted) claimed = true;
        resolveClaim(accepted);
      });
      return result;
    },
  });
  return report;
}

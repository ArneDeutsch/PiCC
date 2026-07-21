import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import picomatch from "picomatch";
import type { Diagnostic } from "../types.js";
import { parseJsonSafe, readTextSafe } from "../util/fs.js";

/**
 * Harness control surface config — lives OUTSIDE the target project
 * (user level) or in a harness-owned gitignored location inside it (never tracked files):
 *   - user:    ~/.picc/config.json
 *   - project: <projectRoot>/.claude/.picc/config.json   (harness-owned, gitignored)
 * Project overrides user, key-wise.
 */
export interface PiCCConfig {
  /** Model override, e.g. "openai/gpt-5.5". */
  model?: string;
  /** Default effort/thinking level: off|minimal|low|medium|high|xhigh|max. */
  effort?: string;
  /**
   * Model-steering layer: modelPattern -> system-prompt guidance appended for
   * matching models. Pattern is a glob over "provider/modelId" (e.g. "openai/*").
   */
  steering: Record<string, string>;
  /** Map Claude "effort" prose/values onto thinking levels; merged over defaults. */
  effortMap: Record<string, string>;
  /** Suppress the startup compatibility notice. */
  suppressCompatNotice?: boolean;
  /**
   * Compaction-resilience knob: percent of the context window at which PiCC
   * proactively triggers Pi's own compaction. **0–100 scale** (NOT a 0–1 fraction) so it
   * compares directly against Pi's `ContextUsage.percent`. Default 90; valid range 50–95.
   * Raw pre-validation file value (a number, or a numeric string from JSON) — validated once
   * via {@link resolveCompactionConfig}; production readers use {@link compaction} instead.
   */
  proactiveCompactPercent?: number | string;
  /**
   * Compaction-resilience knob: per-text-block token budget above which a single
   * tool result's text block is clipped (head+tail). Default 20000; valid integer >= 1000.
   * Raw pre-validation file value (a number, or a numeric string from JSON) — validated once
   * via {@link resolveCompactionConfig}; production readers use {@link compaction} instead.
   */
  clipMaxTokens?: number | string;
  /**
   * Fully-defaulted, validated compaction knobs, resolved exactly once at load by
   * {@link loadPiCCConfig}. This is the production read path — the hot-path consumers read
   * `config.compaction.*` and MUST NOT call {@link resolveCompactionConfig} themselves (that
   * pushes diagnostics; a per-turn call would spam them).
   */
  compaction: ResolvedCompactionConfig;
  diagnostics: Diagnostic[];
}

const DEFAULT_EFFORT_MAP: Record<string, string> = {
  // Claude effort values -> Pi thinking levels
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
  maximum: "max",
  minimal: "minimal",
  xhigh: "xhigh",
};

/** Percent of the context window at which PiCC proactively compacts (0–100 scale). */
export const DEFAULT_PROACTIVE_COMPACT_PERCENT = 90;
/** Per-text-block token budget above which a single tool result is clipped. */
export const DEFAULT_CLIP_MAX_TOKENS = 20000;

const PROACTIVE_COMPACT_PERCENT_MIN = 50;
// Capped below Pi's own ~95.6% hard compaction trigger so the proactive lever always
// PRE-EMPTS it (the whole point is to compact early) — do not raise toward 99.
const PROACTIVE_COMPACT_PERCENT_MAX = 95;
const CLIP_MAX_TOKENS_MIN = 1000;

/** Fully-defaulted, validated compaction knobs — the seam the proactive-compaction and clip paths read from. */
export interface ResolvedCompactionConfig {
  /** 0–100 scale (matches Pi `ContextUsage.percent`). Always within [50, 95]. */
  proactiveCompactPercent: number;
  /** Integer >= 1000. */
  clipMaxTokens: number;
}

/**
 * Finite-number coercion mirroring `asFiniteNumber` in src/discovery/settings.ts:
 * a number that is finite, or a non-empty numeric string. Rejects NaN/Infinity
 * (and "1e999", which parses to Infinity), booleans, objects, and empty strings.
 */
function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

interface NumericBounds {
  def: number;
  min: number;
  max: number;
  integer: boolean;
  label: string;
  rangeText: string;
}

/**
 * Fail-closed numeric resolution: validate a raw config value against its bounds and
 * fall back to the safe default (with a warning diagnostic) on anything invalid —
 * wrong type, non-finite, non-integer where an integer is required, or out of range.
 * Never clamps, never throws. Unset (`undefined`) yields the default silently.
 */
function resolveNumeric(
  raw: unknown,
  bounds: NumericBounds,
  diagnostics: Diagnostic[],
): number {
  if (raw === undefined) return bounds.def;
  const n = asFiniteNumber(raw);
  if (
    n === undefined ||
    (bounds.integer && !Number.isInteger(n)) ||
    n < bounds.min ||
    n > bounds.max
  ) {
    diagnostics.push({
      severity: "warning",
      message:
        `PiCC config "${bounds.label}" (${JSON.stringify(raw)}) is invalid ` +
        `(expected ${bounds.integer ? "an integer " : ""}${bounds.rangeText}); ` +
        `using default ${bounds.def}`,
    });
    return bounds.def;
  }
  return n;
}

/**
 * The single, validated resolver for the compaction-resilience knobs. Called exactly once
 * at load by {@link loadPiCCConfig} (which stores the result on `config.compaction`); the
 * proactive-compaction and clip paths read that field and never re-parse or re-default.
 * Invalid values fail closed to the documented defaults with a diagnostic appended to
 * `config.diagnostics`; it never throws.
 */
export function resolveCompactionConfig(config: PiCCConfig): ResolvedCompactionConfig {
  return {
    proactiveCompactPercent: resolveNumeric(
      config.proactiveCompactPercent,
      {
        def: DEFAULT_PROACTIVE_COMPACT_PERCENT,
        min: PROACTIVE_COMPACT_PERCENT_MIN,
        max: PROACTIVE_COMPACT_PERCENT_MAX,
        integer: false,
        label: "proactiveCompactPercent",
        rangeText: `${PROACTIVE_COMPACT_PERCENT_MIN}–${PROACTIVE_COMPACT_PERCENT_MAX}`,
      },
      config.diagnostics,
    ),
    clipMaxTokens: resolveNumeric(
      config.clipMaxTokens,
      {
        def: DEFAULT_CLIP_MAX_TOKENS,
        min: CLIP_MAX_TOKENS_MIN,
        max: Number.MAX_SAFE_INTEGER,
        integer: true,
        label: "clipMaxTokens",
        rangeText: `>= ${CLIP_MAX_TOKENS_MIN}`,
      },
      config.diagnostics,
    ),
  };
}

export function userConfigPath(): string {
  return path.join(os.homedir(), ".picc", "config.json");
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".claude", ".picc", "config.json");
}

export function loadPiCCConfig(projectRoot: string): PiCCConfig {
  const diagnostics: Diagnostic[] = [];
  const result: PiCCConfig = {
    steering: {},
    effortMap: { ...DEFAULT_EFFORT_MAP },
    // Placeholder; overwritten by the single resolver call below once the raw values are read.
    compaction: {
      proactiveCompactPercent: DEFAULT_PROACTIVE_COMPACT_PERCENT,
      clipMaxTokens: DEFAULT_CLIP_MAX_TOKENS,
    },
    diagnostics,
  };
  for (const file of [userConfigPath(), projectConfigPath(projectRoot)]) {
    const text = readTextSafe(file);
    if (text === undefined) continue;
    const parsed = parseJsonSafe<Record<string, unknown>>(text);
    if (!parsed || typeof parsed !== "object") {
      diagnostics.push({ severity: "warning", message: `Malformed PiCC config ignored: ${file}` });
      continue;
    }
    if (typeof parsed.model === "string") result.model = parsed.model;
    if (typeof parsed.effort === "string") result.effort = parsed.effort;
    if (typeof parsed.suppressCompatNotice === "boolean") result.suppressCompatNotice = parsed.suppressCompatNotice;
    // Compaction knobs: store the raw file value (number or numeric string) so the
    // single validator, resolveCompactionConfig, is the one place range/type is enforced.
    if (typeof parsed.proactiveCompactPercent === "number" || typeof parsed.proactiveCompactPercent === "string") {
      result.proactiveCompactPercent = parsed.proactiveCompactPercent;
    }
    if (typeof parsed.clipMaxTokens === "number" || typeof parsed.clipMaxTokens === "string") {
      result.clipMaxTokens = parsed.clipMaxTokens;
    }
    if (parsed.steering && typeof parsed.steering === "object") {
      for (const [k, v] of Object.entries(parsed.steering as Record<string, unknown>)) {
        if (typeof v === "string") result.steering[k] = v;
      }
    }
    if (parsed.effortMap && typeof parsed.effortMap === "object") {
      for (const [k, v] of Object.entries(parsed.effortMap as Record<string, unknown>)) {
        if (typeof v === "string") result.effortMap[k.toLowerCase()] = v;
      }
    }
  }
  // Resolve and validate the compaction knobs exactly once, here, emitting any validation
  // diagnostics at this single point. Production readers use `config.compaction.*`.
  result.compaction = resolveCompactionConfig(result);
  return result;
}

export function saveProjectConfigValue(projectRoot: string, key: string, value: unknown): void {
  const file = projectConfigPath(projectRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = parseJsonSafe<Record<string, unknown>>(readTextSafe(file)) ?? {};
    existing[key] = value;
    fs.writeFileSync(file, JSON.stringify(existing, null, 2) + "\n", "utf8");
  } catch {
    // Harness config persistence is best-effort; never break the session over it.
  }
}

/**
 * Steering text for the active model: concatenation of all matching patterns.
 * Patterns match the full "provider/modelId" ref; picomatch's `*` does not cross
 * `/`, so a pattern without a provider segment ("*", "gpt-5*") additionally
 * matches the bare modelId — the natural way users write model patterns.
 */
export function steeringForModel(config: PiCCConfig, modelRef: string): string | undefined {
  const parts: string[] = [];
  const modelId = modelRef.includes("/") ? modelRef.slice(modelRef.indexOf("/") + 1) : modelRef;
  for (const [pattern, text] of Object.entries(config.steering)) {
    try {
      const m = picomatch(pattern, { nocase: true });
      if (m(modelRef) || (!pattern.includes("/") && m(modelId))) parts.push(text);
    } catch {
      // Malformed pattern: skip, never break prompt assembly.
    }
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * Map a Claude `effort:` value (or prose like "apply maximum reasoning effort")
 * onto a Pi thinking level. Pass-through undefined when unmappable.
 */
export function mapEffort(config: PiCCConfig, effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  const key = effort.trim().toLowerCase();
  if (config.effortMap[key]) return config.effortMap[key];
  // prose steering: look for a known level word inside the text
  for (const word of Object.keys(config.effortMap)) {
    if (key.includes(word)) return config.effortMap[word];
  }
  return undefined;
}

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import picomatch from "picomatch";
import type { Diagnostic } from "../types.js";
import { parseJsonSafe, readTextSafe } from "../util/fs.js";

/**
 * Harness control surface config (plan §10, §13.2) — lives OUTSIDE the target project
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

/** Steering text for the active model: concatenation of all matching patterns. */
export function steeringForModel(config: PiCCConfig, modelRef: string): string | undefined {
  const parts: string[] = [];
  for (const [pattern, text] of Object.entries(config.steering)) {
    if (picomatch(pattern, { nocase: true })(modelRef)) parts.push(text);
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

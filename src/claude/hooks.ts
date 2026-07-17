import {
  SUPPORTED_HOOK_EVENTS,
  type Diagnostic,
  type HookConfig,
  type HookHandler,
  type HookHandlerType,
  type HookMatcherEntry,
} from "../types.js";

/**
 * Hook config parsing & merging.
 *
 * Normalizes the Claude settings `hooks` value:
 *
 *   { EventName: [ { matcher?, if?, hooks: [ { type, command, ... } ] } ] }
 *
 * Completeness floor: never throws. Malformed pieces degrade to diagnostics;
 * unknown event names are KEPT (they simply never fire — the engine only
 * emits the supported events) and reported with an info diagnostic; handler
 * types other than command/http are kept with their raw definition and a
 * degradation notice (the runner turns them into no-ops).
 */

const SUPPORTED_EVENT_SET: ReadonlySet<string> = new Set(SUPPORTED_HOOK_EVENTS);

/** Handler types the runner can actually execute. */
const EXECUTABLE_HANDLER_TYPES: ReadonlySet<string> = new Set(["command", "http"]);

export interface ParsedHookConfig {
  config: HookConfig;
  diagnostics: Diagnostic[];
}

export function parseHookConfig(raw: unknown, sourcePath: string): ParsedHookConfig {
  const config: HookConfig = {};
  const diagnostics: Diagnostic[] = [];
  try {
    if (raw === undefined || raw === null) return { config, diagnostics };
    if (typeof raw !== "object" || Array.isArray(raw)) {
      diagnostics.push({
        severity: "warning",
        message: `hooks config must be an object mapping event names to entries (got ${
          Array.isArray(raw) ? "array" : typeof raw
        }); ignored`,
        source: sourcePath,
      });
      return { config, diagnostics };
    }

    for (const [eventName, rawValue] of Object.entries(raw as Record<string, unknown>)) {
      if (!SUPPORTED_EVENT_SET.has(eventName)) {
        diagnostics.push({
          severity: "info",
          message: `hook event "${eventName}" is not supported by PiCC; entries are kept but will never fire`,
          source: sourcePath,
        });
      }

      const rawEntries = Array.isArray(rawValue)
        ? rawValue
        : rawValue === undefined || rawValue === null
          ? []
          : [rawValue];
      if (!Array.isArray(rawValue) && rawEntries.length > 0) {
        diagnostics.push({
          severity: "info",
          message: `hook event "${eventName}": entries should be an array; normalized single value`,
          source: sourcePath,
        });
      }

      const entries: HookMatcherEntry[] = [];
      for (const rawEntry of rawEntries) {
        const entry = parseMatcherEntry(rawEntry, eventName, sourcePath, diagnostics);
        if (entry) entries.push(entry);
      }
      config[eventName] = (config[eventName] ?? []).concat(entries);
    }
  } catch (err) {
    diagnostics.push({
      severity: "error",
      message: `failed to parse hooks config: ${err instanceof Error ? err.message : String(err)}`,
      source: sourcePath,
    });
  }
  return { config, diagnostics };
}

function parseMatcherEntry(
  rawEntry: unknown,
  eventName: string,
  sourcePath: string,
  diagnostics: Diagnostic[],
): HookMatcherEntry | undefined {
  // Ultra-shorthand: the entry itself is a command string.
  if (typeof rawEntry === "string") {
    return { hooks: [commandHandlerFromString(rawEntry)] };
  }
  if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
    diagnostics.push({
      severity: "warning",
      message: `hook event "${eventName}": ignoring malformed matcher entry (expected object, got ${
        Array.isArray(rawEntry) ? "array" : typeof rawEntry
      })`,
      source: sourcePath,
    });
    return undefined;
  }

  const entry = rawEntry as Record<string, unknown>;
  const matcher = typeof entry["matcher"] === "string" ? entry["matcher"] : undefined;
  const ifExpr = typeof entry["if"] === "string" ? entry["if"] : undefined;

  let rawHooks: unknown[];
  const hooksValue = entry["hooks"];
  if (Array.isArray(hooksValue)) {
    rawHooks = hooksValue;
  } else if (hooksValue !== undefined && hooksValue !== null) {
    rawHooks = [hooksValue];
  } else if (typeof entry["command"] === "string" || typeof entry["type"] === "string") {
    // Tolerate an entry that IS a handler (missing the `hooks` wrapper).
    rawHooks = [entry];
  } else {
    rawHooks = [];
    diagnostics.push({
      severity: "warning",
      message: `hook event "${eventName}": matcher entry has no hooks`,
      source: sourcePath,
    });
  }

  const hooks: HookHandler[] = [];
  for (const rawHandler of rawHooks) {
    const handler = parseHandler(rawHandler, eventName, sourcePath, diagnostics);
    if (handler) hooks.push(handler);
  }

  const result: HookMatcherEntry = { hooks };
  if (matcher !== undefined) result.matcher = matcher;
  if (ifExpr !== undefined) result.if = ifExpr;
  return result;
}

function commandHandlerFromString(command: string): HookHandler {
  return { type: "command", command, raw: { type: "command", command } };
}

function parseHandler(
  rawHandler: unknown,
  eventName: string,
  sourcePath: string,
  diagnostics: Diagnostic[],
): HookHandler | undefined {
  // Common shorthand: a plain string means a command hook.
  if (typeof rawHandler === "string") {
    return commandHandlerFromString(rawHandler);
  }
  if (typeof rawHandler !== "object" || rawHandler === null || Array.isArray(rawHandler)) {
    diagnostics.push({
      severity: "warning",
      message: `hook event "${eventName}": ignoring malformed handler (expected object or string, got ${
        Array.isArray(rawHandler) ? "array" : typeof rawHandler
      })`,
      source: sourcePath,
    });
    return undefined;
  }

  const h = rawHandler as Record<string, unknown>;
  const typeText = typeof h["type"] === "string" && h["type"].length > 0 ? h["type"] : "command";
  // Unknown type strings are preserved verbatim (kept + degraded by the
  // runner), so the cast is a widening we accept deliberately.
  const type = typeText as HookHandlerType;

  const handler: HookHandler = { type, raw: h };
  if (typeof h["command"] === "string") handler.command = h["command"];
  if (Array.isArray(h["args"])) {
    handler.args = (h["args"] as unknown[]).map((a) =>
      typeof a === "string" ? a : String(a),
    );
  }
  if (h["shell"] === "powershell" || h["shell"] === "bash") handler.shell = h["shell"];
  if (typeof h["timeout"] === "number" && Number.isFinite(h["timeout"]) && h["timeout"] > 0) {
    handler.timeout = h["timeout"];
  }
  if (typeof h["once"] === "boolean") handler.once = h["once"];
  if (typeof h["async"] === "boolean") handler.async = h["async"];
  if (typeof h["url"] === "string") handler.url = h["url"];

  if (!EXECUTABLE_HANDLER_TYPES.has(typeText)) {
    diagnostics.push({
      severity: "info",
      message: `hook event "${eventName}": handler type "${typeText}" is not executable in PiCC; kept but degraded to a no-op`,
      source: sourcePath,
    });
  } else if (typeText === "command" && handler.command === undefined) {
    diagnostics.push({
      severity: "warning",
      message: `hook event "${eventName}": command handler has no "command" string; it will be skipped`,
      source: sourcePath,
    });
  } else if (typeText === "http" && handler.url === undefined) {
    diagnostics.push({
      severity: "warning",
      message: `hook event "${eventName}": http handler has no "url" string; it will be skipped`,
      source: sourcePath,
    });
  }

  return handler;
}

/**
 * Merge hook configs by concatenating entries per event, in argument order
 * (callers pass configs in precedence order: managed, local, project, user,
 * plugins, skill/agent-scoped). Handler object identity is preserved so
 * `once:` tracking in the runner keys off the same objects.
 */
export function mergeHookConfigs(...configs: HookConfig[]): HookConfig {
  const merged: HookConfig = {};
  for (const config of configs) {
    if (!config || typeof config !== "object") continue;
    for (const [eventName, entries] of Object.entries(config)) {
      if (!Array.isArray(entries)) continue;
      merged[eventName] = (merged[eventName] ?? []).concat(entries);
    }
  }
  return merged;
}

import path from "node:path";
import { isFile, readTextSafe } from "../util/fs.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";

/**
 * `.mcp.json` loader and MCP server-entry normalization.
 *
 * Parses the Claude-format project `.mcp.json` (strict JSON,
 * `{"mcpServers": {<name>: <entry>}}`) and normalizes stdio server entries —
 * the same entry schema is reused for `mcpServers` blocks in settings files.
 * Loader convention: NEVER throws; every rejection degrades to a diagnostic.
 *
 * This file knows nothing about scopes, precedence, or enablement — that is
 * `src/discovery/mcp.ts`. Values here stay RAW (pre-`${VAR}` expansion);
 * expansion happens at resolution time so raw strings survive for display.
 *
 * All diagnostic strings pass {@link neutralizeControlChars} before storage:
 * they quote hostile config-derived names that later reach the terminal.
 */

/**
 * Safe server-name charset. Names become `mcp__<server>__<tool>` tool names,
 * and the permission grammar splits on `__` — so `__` anywhere in a name (and
 * whitespace, `(`, `*`, control chars, …) would break rule matching.
 */
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Entry fields we understand; anything else is ignored with a diagnostic. */
const KNOWN_ENTRY_FIELDS = new Set(["command", "args", "env", "type", "timeout", "url", "alwaysLoad", "role"]);

/** Real Claude entry fields whose feature is deferred in PiCC (entry still runs). */
const DEFERRED_ENTRY_FIELDS = ["alwaysLoad", "role"] as const;

/** Explicit remote-transport `type` values Claude accepts; all deferred here. */
const REMOTE_TYPES = new Set(["http", "streamable-http", "sse", "ws"]);

/** Minimum honored per-server tool-call timeout (Claude parity: <1000 ms ignored). */
const MIN_TIMEOUT_MS = 1000;

/** A normalized (but unexpanded, un-gated) MCP server entry. */
export interface RawMcpEntry {
  /** Server name (neutralized for storage; validation happens against the raw key). */
  name: string;
  /** Raw command ("" when the entry is skipped without one). */
  command: string;
  /** Raw args. */
  args: string[];
  /** Raw env values (null-prototype record — server-controlled keys). */
  env: Record<string, string>;
  /** Per-server tool-call timeout, only when valid (>= 1000 ms). */
  timeoutMs?: number;
  /** True when the entry must not start (invalid name, url/remote, bad shape). */
  skipped: boolean;
  diagnostics: string[];
}

export interface McpJsonResult {
  servers: RawMcpEntry[];
  /** File-level findings (unreadable, malformed JSON, wrong root shape). */
  diagnostics: string[];
  /** True when a `.mcp.json` file exists at the project root (even malformed). */
  present: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(message: string): string {
  return neutralizeControlChars(message);
}

/**
 * Normalize one `mcpServers` block (from `.mcp.json` or a settings file) into
 * entries. Invalid entries are returned with `skipped: true` rather than
 * dropped, so the resolution layer can report every discovered server.
 */
export function normalizeMcpServerBlock(
  block: Record<string, unknown>,
  sourceLabel: string,
): RawMcpEntry[] {
  const out: RawMcpEntry[] = [];
  for (const [rawName, rawEntry] of Object.entries(block)) {
    const name = clean(rawName);
    const entry: RawMcpEntry = {
      name,
      command: "",
      args: [],
      env: Object.create(null) as Record<string, string>,
      skipped: false,
      diagnostics: [],
    };
    out.push(entry);
    const push = (msg: string): void => {
      entry.diagnostics.push(clean(msg));
    };

    if (!SERVER_NAME_RE.test(rawName) || rawName.includes("__")) {
      entry.skipped = true;
      push(
        `Invalid MCP server name ${JSON.stringify(rawName)} in ${sourceLabel} ` +
          `(allowed: letters, digits, ".", "_", "-"; must not contain "__"); server skipped`,
      );
      continue;
    }
    if (!isPlainObject(rawEntry)) {
      entry.skipped = true;
      push(`MCP server "${name}" in ${sourceLabel} is not an object; server skipped`);
      continue;
    }
    const type = rawEntry.type;
    if (typeof type === "string" && REMOTE_TYPES.has(type)) {
      entry.skipped = true;
      push(
        `MCP server "${name}" in ${sourceLabel} uses remote transport ${JSON.stringify(type)} — remote ` +
          `MCP transports (HTTP/SSE/WebSocket) are not supported yet; server skipped`,
      );
      continue;
    }
    if (type !== undefined && type !== "stdio") {
      entry.skipped = true;
      push(
        `MCP server "${name}" in ${sourceLabel} has unsupported type ${JSON.stringify(type)}; ` +
          `only "stdio" is currently supported; server skipped`,
      );
      continue;
    }
    // Claude parity: `url` alone (no `type`, no `command`) is an implicit remote
    // entry — skipped. With a valid stdio shape, a stray `url` key is ignored.
    if ("url" in rawEntry && type === undefined && rawEntry.command === undefined) {
      entry.skipped = true;
      push(
        `MCP server "${name}" in ${sourceLabel} has a "url" but no "type" — remote MCP transports ` +
          `are not supported yet; server skipped`,
      );
      continue;
    }
    if (typeof rawEntry.command !== "string" || rawEntry.command.trim() === "") {
      entry.skipped = true;
      push(`MCP server "${name}" in ${sourceLabel} is missing required string "command"; server skipped`);
      continue;
    }
    entry.command = rawEntry.command;
    if ("url" in rawEntry) {
      push(`MCP server "${name}": field "url" is ignored on a stdio server`);
    }

    // Claude parity (zod-schema strictness): a shape violation in args/env/
    // timeout skips the WHOLE server — never salvage a partial entry, or the
    // server would run with an argv/env its author never wrote.
    if (rawEntry.args !== undefined) {
      if (!Array.isArray(rawEntry.args) || rawEntry.args.some((arg) => typeof arg !== "string")) {
        entry.skipped = true;
        push(
          `MCP server "${name}" in ${sourceLabel} has an invalid "args" ` +
            `(must be an array of strings); server skipped`,
        );
        continue;
      }
      entry.args.push(...(rawEntry.args as string[]));
    }

    if (rawEntry.env !== undefined) {
      if (
        !isPlainObject(rawEntry.env) ||
        Object.values(rawEntry.env).some((envVal) => typeof envVal !== "string")
      ) {
        entry.skipped = true;
        push(
          `MCP server "${name}" in ${sourceLabel} has an invalid "env" ` +
            `(must be an object with string values); server skipped`,
        );
        continue;
      }
      for (const [envKey, envVal] of Object.entries(rawEntry.env)) {
        entry.env[envKey] = envVal as string;
      }
    }

    if (rawEntry.timeout !== undefined) {
      const t = rawEntry.timeout;
      if (typeof t !== "number" || !Number.isInteger(t) || t <= 0) {
        entry.skipped = true;
        push(
          `MCP server "${name}" in ${sourceLabel} has an invalid "timeout" ` +
            `(must be a positive integer, in ms); server skipped`,
        );
        continue;
      }
      // Verified Claude exception: a positive integer below the minimum is
      // merely ignored — the server still runs with the default timeout.
      if (t >= MIN_TIMEOUT_MS) {
        entry.timeoutMs = t;
      } else {
        push(`MCP server "${name}": "timeout" ${t} ms is below the ${MIN_TIMEOUT_MS} ms minimum; ignored`);
      }
    }

    for (const field of DEFERRED_ENTRY_FIELDS) {
      if (field in rawEntry) {
        push(`MCP server "${name}": "${field}" is a deferred feature in PiCC; ignored (server still runs)`);
      }
    }
    for (const key of Object.keys(rawEntry)) {
      if (!KNOWN_ENTRY_FIELDS.has(key)) {
        push(`MCP server "${name}": unknown field ${JSON.stringify(key)} ignored`);
      }
    }
  }
  return out;
}

/**
 * Load `.mcp.json` from the project root (no walk-up, no nested files).
 * Strict JSON — no JSONC tolerance — except a leading UTF-8 BOM, which
 * {@link readTextSafe} strips so a Notepad/PowerShell-authored file does not
 * silently lose its servers. Never throws.
 */
export function loadMcpJson(projectRoot: string): McpJsonResult {
  const result: McpJsonResult = { servers: [], diagnostics: [], present: false };
  const filePath = path.join(projectRoot, ".mcp.json");
  if (!isFile(filePath)) return result;
  result.present = true;

  const text = readTextSafe(filePath);
  if (text === undefined) {
    result.diagnostics.push(clean(`.mcp.json is unreadable; ignored`));
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    result.diagnostics.push(clean(`.mcp.json is malformed JSON (${(err as Error).message}); ignored`));
    return result;
  }
  if (!isPlainObject(parsed)) {
    result.diagnostics.push(clean(`.mcp.json root is not an object; ignored`));
    return result;
  }
  const block = parsed.mcpServers;
  if (block === undefined) {
    result.diagnostics.push(clean(`.mcp.json has no "mcpServers" key; ignored`));
    return result;
  }
  if (!isPlainObject(block)) {
    result.diagnostics.push(clean(`.mcp.json "mcpServers" is not an object; ignored`));
    return result;
  }
  result.servers = normalizeMcpServerBlock(block, ".mcp.json");
  return result;
}

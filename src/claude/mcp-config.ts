import path from "node:path";
import { isFile, readTextSafe } from "../util/fs.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import {
  parseRemoteMcpFields,
  type RawRemoteMcpFields,
} from "./mcp-remote-config.js";

/**
 * `.mcp.json` loader and MCP server-entry normalization.
 *
 * Parses the Claude-format project `.mcp.json` (strict JSON,
 * `{"mcpServers": {<name>: <entry>}}`) and normalizes MCP server entries —
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

/**
 * Server-name length gate (PiCC-only): names ride into tool names, deny rules,
 * findings, and the /doctor posture line — rejecting over-long names here keeps
 * every downstream line bounded without per-consumer truncation.
 */
const MAX_SERVER_NAME_CHARS = 128;

/** Slice of an over-long name quoted inside its rejection diagnostic. */
const NAME_DIAG_SLICE_CHARS = 32;

/** Entry fields we understand; anything else is ignored with a diagnostic. */
const KNOWN_ENTRY_FIELDS = new Set([
  "command", "args", "env", "type", "timeout", "url", "headers", "headersHelper",
  "alwaysLoad", "role", "oauth",
]);

/** Real Claude entry fields whose feature is deferred in PiCC (entry still runs). */
const DEFERRED_ENTRY_FIELDS = ["alwaysLoad", "role", "oauth"] as const;

/** Minimum honored per-server tool-call timeout (Claude parity: <1000 ms ignored). */
const MIN_TIMEOUT_MS = 1000;

/** A normalized (but unexpanded, un-gated) MCP server entry. */
export interface RawMcpEntry {
  /**
   * Server name (neutralized for storage, truncated when over the length gate;
   * validation happens against the raw key).
   */
  name: string;
  /** Raw command ("" when the entry is skipped without one). */
  command: string;
  /** Raw args. */
  args: string[];
  /** Raw env values (null-prototype record — server-controlled keys). */
  env: Record<string, string>;
  /** Per-server tool-call timeout, only when valid (>= 1000 ms). */
  timeoutMs?: number;
  /** Parsed remote fields remain raw until the enablement gate permits expansion. */
  remote?: RawRemoteMcpFields;
  /** Explicit supported remote type with an empty URL: quietly inactive. */
  notConfigured?: boolean;
  /** True when the entry must not start (invalid name or bad shape). */
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
    // An over-long name is stored TRUNCATED (display-only on a skipped entry)
    // so no downstream line ever carries the full hostile-length name.
    const overLongName = rawName.length > MAX_SERVER_NAME_CHARS;
    const name = overLongName
      ? `${clean(rawName).slice(0, NAME_DIAG_SLICE_CHARS)}…`
      : clean(rawName);
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

    if (overLongName) {
      entry.skipped = true;
      push(
        `Invalid MCP server name "${name}" in ${sourceLabel} ` +
          `(${rawName.length} chars exceeds the ${MAX_SERVER_NAME_CHARS}-char limit); server skipped`,
      );
      continue;
    }
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
    // An untyped entry with a valid command is stdio even when it carries a
    // stray URL. Explicit remote types always take the remote parser path.
    const hasValidCommand =
      typeof rawEntry.command === "string" && rawEntry.command.trim() !== "";
    const remote = type === undefined && hasValidCommand
      ? { kind: "not-remote" as const }
      : parseRemoteMcpFields(rawEntry, rawName, sourceLabel, { deferPostAdmission: true });
    if (remote.kind === "skipped") {
      entry.skipped = true;
      entry.diagnostics.push(...remote.diagnostics.map(clean));
      continue;
    }
    if (remote.kind === "not-configured") {
      entry.notConfigured = true;
      entry.remote = {
        configuredType: remote.configuredType,
        transportKind: remote.configuredType === "sse" ? "sse" : "http",
        rawUrl: "",
        rawEntry: rawEntry as Record<string, unknown>,
        rawHeaders: Object.create(null) as Record<string, string>,
        ...(remote.configuredType === "sse"
          ? { sseDeprecation: { deprecated: true as const, replacement: "http" as const } }
          : {}),
      };
      continue;
    }
    if (remote.kind === "supported") {
      entry.remote = remote.fields;
      entry.diagnostics.push(...remote.diagnostics.map(clean));
    } else if (type !== undefined && type !== "stdio") {
      entry.skipped = true;
      push(
        `MCP server "${name}" in ${sourceLabel} has unsupported type ${JSON.stringify(type)}; ` +
          `only "stdio", "http", "streamable-http", and "sse" are supported; server skipped`,
      );
      continue;
    }
    // With a valid stdio shape, a stray `url` key is ignored.
    if (entry.remote === undefined) {
      if (typeof rawEntry.command !== "string" || rawEntry.command.trim() === "") {
        entry.skipped = true;
        push(`MCP server "${name}" in ${sourceLabel} is missing required string "command"; server skipped`);
        continue;
      }
      entry.command = rawEntry.command;
      if ("url" in rawEntry) {
        push(`MCP server "${name}": field "url" is ignored on a stdio server`);
      }
    }

    // Claude parity (zod-schema strictness): a shape violation in args/env/
    // timeout skips the WHOLE server — never salvage a partial entry, or the
    // server would run with an argv/env its author never wrote.
    if (entry.remote !== undefined && (rawEntry.args !== undefined || rawEntry.env !== undefined)) {
      entry.skipped = true;
      push(`MCP server "${name}" in ${sourceLabel} mixes remote transport fields with stdio args/env; server skipped`);
      continue;
    }
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

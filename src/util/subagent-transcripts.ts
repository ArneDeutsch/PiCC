import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Diagnostic } from "../types.js";

/**
 * Subagent transcript location + agent-ID helpers.
 *
 * Every successfully persisted subagent dispatch stores its Pi session as one JSONL transcript,
 * discoverable from the MAIN session's transcript file (Claude parity analog:
 * `…/{sessionId}/subagents/agent-{id}.jsonl`):
 *
 *   main:        <sessionsDir>/<stamp>_<mainSessionId>.jsonl
 *   subagents:   <sessionsDir>/<mainFileBase>.subagents/<stamp>_<agentId>.jsonl
 *
 * The per-transcript filename is minted by Pi's `SessionManager.create(cwd,
 * sessionDir, { id: agentId })` — `<timestamp>_<agentId>.jsonl` — so the agent
 * ID is embedded verbatim in the filename and the resolver finds a transcript
 * by scanning for that suffix. A resume reopens the SAME file via
 * `SessionManager.open`, so one agent ID maps to one transcript across resumes.
 *
 * This module is shared by subagents.ts and background-tasks.ts; keeping it in
 * util avoids a value-level import between those two modules.
 */

/**
 * Minted agent-ID shape: `agent-` + 12 lowercase hex chars. The strict
 * allowlist doubles as the resolver's path hardening — anything containing
 * separators, `..`, drive/UNC prefixes, or NTFS-reserved names (CON, NUL, …)
 * simply cannot match. Pi's own `assertValidSessionId` re-validates on create.
 */
const AGENT_ID_RE = /^agent-[0-9a-f]{12}$/;
const SESSION_ID_SOURCE = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const SESSION_STAMP_SOURCE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z";
const SESSION_FILE_RE = new RegExp(`^(${SESSION_STAMP_SOURCE})_(${SESSION_ID_SOURCE})\\.jsonl$`);
const CHILD_SESSION_FILE_RE = new RegExp(
  `^(${SESSION_STAMP_SOURCE})_(agent-[0-9a-f]{12})\\.jsonl$`,
);
export const MAX_PI_SESSION_HEADER_BYTES = 16 * 1024;
export const MAX_SUBAGENT_OWNERSHIP_MARKER_BYTES = 4096;

/** Stable evidence file placed in newly admitted PiCC subagent collections. */
export const SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER = ".picc-owner.json";
export const SUBAGENT_TRANSCRIPT_OWNERSHIP_VERSION = 1;

export interface SubagentTranscriptOwnership {
  version: 1;
  parentBasename: string;
  cwdHash: string;
}

export interface PiSessionHeader {
  id: string;
  timestamp: string;
  cwd: string;
}

export type PrepareSubagentTranscriptCollectionResult =
  | { ok: true; directory: string }
  | { ok: false; diagnostic: Diagnostic };

export interface PrepareSubagentTranscriptCollectionFs {
  realpath(file: string): string;
  lstat(file: string): fs.Stats;
  mkdir(directory: string): void;
  open(file: string, flags: "r"): number;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
  writeFile(file: string, data: string, options: { encoding: "utf8"; flag: "wx"; mode: number }): void;
}

const realPreparationFs: PrepareSubagentTranscriptCollectionFs = {
  realpath: (file) => fs.realpathSync.native(file),
  lstat: fs.lstatSync,
  mkdir: (directory) => fs.mkdirSync(directory),
  open: fs.openSync,
  read: fs.readSync,
  close: fs.closeSync,
  writeFile: (file, data, options) => fs.writeFileSync(file, data, options),
};

function safeDiagnostic(message: string): Diagnostic {
  return { severity: "warning", message };
}

export function parsePiSessionFilename(
  basename: string,
  childOnly = false,
): { id: string; timestamp: string } | undefined {
  const match = (childOnly ? CHILD_SESSION_FILE_RE : SESSION_FILE_RE).exec(basename);
  if (!match) return undefined;
  const timestamp = match[1]!.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1:$2:$3.$4Z",
  );
  if (!Number.isFinite(Date.parse(timestamp))) return undefined;
  return { timestamp, id: match[2]! };
}

export function hashCanonicalPath(canonical: string): string {
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function canonicalCwdHash(
  cwd: string,
  realpath: (value: string) => string = fs.realpathSync.native,
): string {
  return hashCanonicalPath(realpath(cwd));
}

export function parsePiSessionHeader(value: unknown): PiSessionHeader | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const header = value as Record<string, unknown>;
  if (
    header.type !== "session" ||
    typeof header.id !== "string" ||
    typeof header.timestamp !== "string" ||
    typeof header.cwd !== "string"
  ) return undefined;
  return { id: header.id, timestamp: header.timestamp, cwd: header.cwd };
}

export function parseSubagentOwnershipMarker(
  value: unknown,
  parentBasename: string,
  cwdHash: string,
): SubagentTranscriptOwnership | undefined {
  return isMatchingOwnership(value, parentBasename, cwdHash) ? value : undefined;
}

export function readBoundedPiSessionHeader(
  file: string,
  read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number =
    fs.readSync,
  open: (file: string, flags: "r") => number = fs.openSync,
  close: (fd: number) => void = fs.closeSync,
): PiSessionHeader | undefined {
  let fd: number | undefined;
  try {
    fd = open(file, "r");
    const buffer = Buffer.alloc(MAX_PI_SESSION_HEADER_BYTES + 1);
    const count = read(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, count).indexOf(0x0a);
    if (newline < 0 || newline > MAX_PI_SESSION_HEADER_BYTES) return undefined;
    return parsePiSessionHeader(JSON.parse(buffer.subarray(0, newline).toString("utf8")));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { close(fd); } catch { /* best effort */ }
    }
  }
}

export function subagentTranscriptOwnership(
  parentBasename: string,
  cwdHash: string,
): SubagentTranscriptOwnership {
  return {
    version: SUBAGENT_TRANSCRIPT_OWNERSHIP_VERSION,
    parentBasename,
    cwdHash,
  };
}

export function serializeSubagentTranscriptOwnership(
  parentBasename: string,
  cwdHash: string,
): string {
  return `${JSON.stringify(subagentTranscriptOwnership(parentBasename, cwdHash))}\n`;
}

export function ownershipFor(
  parentBasename: string,
  cwd: string,
  realpath: (value: string) => string = fs.realpathSync.native,
): SubagentTranscriptOwnership {
  return subagentTranscriptOwnership(parentBasename, canonicalCwdHash(cwd, realpath));
}

export function isMatchingOwnership(
  value: unknown,
  parentBasename: string,
  cwdHash: string,
): value is SubagentTranscriptOwnership {
  if (typeof value !== "object" || value === null) return false;
  const marker = value as Record<string, unknown>;
  return marker.version === SUBAGENT_TRANSCRIPT_OWNERSHIP_VERSION &&
    marker.parentBasename === parentBasename && marker.cwdHash === cwdHash;
}

/** Validate the real parent header, then atomically admit its owned collection. */
export function prepareSubagentTranscriptCollection(
  mainSessionFile: string,
  fsOverrides: Partial<PrepareSubagentTranscriptCollectionFs> = {},
): PrepareSubagentTranscriptCollectionResult {
  const io: PrepareSubagentTranscriptCollectionFs = { ...realPreparationFs, ...fsOverrides };
  const parentBasename = path.basename(mainSessionFile);
  const parsedName = parsePiSessionFilename(parentBasename);
  try {
    const parentStat = io.lstat(mainSessionFile);
    if (!parentStat.isFile() || parentStat.isSymbolicLink() || !parsedName) {
      return { ok: false, diagnostic: safeDiagnostic(`subagent transcript ownership refused for ${parentBasename}: invalid parent`) };
    }
    const header = readBoundedPiSessionHeader(mainSessionFile, io.read, io.open, io.close);
    if (!header || header.id !== parsedName.id || header.timestamp !== parsedName.timestamp) {
      return { ok: false, diagnostic: safeDiagnostic(`subagent transcript ownership refused for ${parentBasename}: parent header mismatch`) };
    }
    const expected = ownershipFor(parentBasename, header.cwd, io.realpath);
    const directory = subagentSessionDir(mainSessionFile);
    try {
      io.mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const directoryStat = io.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return { ok: false, diagnostic: safeDiagnostic(`subagent transcript ownership refused for ${parentBasename}: collection is not a direct directory`) };
    }
    const marker = path.join(directory, SUBAGENT_TRANSCRIPT_OWNERSHIP_MARKER);
    const serialized = serializeSubagentTranscriptOwnership(parentBasename, expected.cwdHash);
    try {
      io.writeFile(marker, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const markerStat = io.lstat(marker);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw error;
      let fd: number | undefined;
      try {
        fd = io.open(marker, "r");
        const buffer = Buffer.alloc(MAX_SUBAGENT_OWNERSHIP_MARKER_BYTES + 1);
        const count = io.read(fd, buffer, 0, buffer.length, 0);
        if (count > MAX_SUBAGENT_OWNERSHIP_MARKER_BYTES ||
            !parseSubagentOwnershipMarker(
              JSON.parse(buffer.subarray(0, count).toString("utf8")),
              parentBasename,
              expected.cwdHash,
            )) throw error;
      } finally {
        if (fd !== undefined) io.close(fd);
      }
    }
    return { ok: true, directory };
  } catch {
    return { ok: false, diagnostic: safeDiagnostic(`subagent transcript ownership refused for ${parentBasename}: marker unavailable or mismatched`) };
  }
}

/**
 * Prefix marking the developer-/model-facing fork-degrade line. A
 * `subagent_type: "fork"` dispatch that could not inherit the parent
 * conversation runs fresh and records a fork-SPECIFIC diagnostic whose message
 * starts with this sentinel. It is the SHARED home for the prefix so the emitter
 * (subagents.ts) and the result renderer (subagent-render.ts) match without a
 * hand-written "MUST match" comment that could silently drift — both import it
 * here (this util is the shared low-level module both already depend on, and
 * subagent-render.ts must not import from subagents.ts, which imports render).
 */
export const FORK_DEGRADE_PREFIX = "fork ran with fresh context: ";

/** Mint a new opaque agent ID (unique per agent, stable across resumes). */
export function mintAgentId(): string {
  return `agent-${crypto.randomBytes(6).toString("hex")}`;
}

/** True iff `value` has exactly the minted agent-ID shape. */
export function isAgentId(value: string): boolean {
  return AGENT_ID_RE.test(value);
}

/**
 * Pick the path flavor matching the INPUT string, not the host platform: the
 * resolver must derive correct Windows-shaped paths even when unit-tested on
 * POSIX (and `path.win32` handles both separator styles). A POSIX filename
 * containing a literal backslash would be misclassified — Pi session paths
 * never are.
 */
function pathApiFor(p: string): typeof path.win32 {
  return /^[A-Za-z]:[\\/]/.test(p) || p.includes("\\") ? path.win32 : path.posix;
}

/**
 * Directory holding the subagent transcripts of the given MAIN session
 * transcript file: a `<mainFileBase>.subagents` sibling directory. Pure path
 * derivation — nothing is created or checked on disk.
 */
export function subagentSessionDir(mainSessionFile: string): string {
  const p = pathApiFor(mainSessionFile);
  const base = p.basename(mainSessionFile).replace(/\.jsonl$/i, "");
  return p.join(p.dirname(mainSessionFile), `${base}.subagents`);
}

/**
 * Resolve an agent ID to its transcript path under the main session's
 * subagents directory, or undefined when no transcript exists (never ran,
 * never flushed, or in-memory fallback).
 *
 * This is the ID→transcript discovery entry point for EXTERNAL tooling and
 * humans, exercised by the e2e/unit tests that prove transcripts are
 * discoverable. It deliberately has NO `src/` production caller — SECURITY:
 * resume (SendMessage) uses the REGISTRY-STORED path captured at dispatch time,
 * never a fresh on-disk scan, so a model-supplied `to` can never drive a disk
 * lookup. Do not "dead-code" delete it; the disk-scan absence in resume is by
 * design, not a gap.
 *
 * Hardening (defense in depth — this is exported and IDs land in filenames):
 * throws on anything that is not a minted agent ID, which rejects path
 * separators, `..`, absolute paths, drive/UNC prefixes, and reserved device
 * names outright.
 */
export function resolveSubagentTranscript(
  mainSessionFile: string,
  agentId: string,
): string | undefined {
  if (!isAgentId(agentId)) {
    throw new Error(
      `Invalid agent id ${JSON.stringify(agentId)}: expected the minted "agent-<12 hex>" form`,
    );
  }
  const dir = subagentSessionDir(mainSessionFile);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined; // no subagents directory yet
  }
  // Anchor the match to Pi's full minted filename `<ISO-timestamp>_<agentId>.jsonl`
  // (`toISOString().replace(/[:.]/g, "-")`, e.g. `2026-01-01T00-00-00-000Z`), not a
  // bare `_<id>.jsonl` suffix — so an unrelated file that merely ends with the suffix
  // can't masquerade as a Pi transcript. Timestamps sort lexically, so the last match
  // is the newest (normally there is exactly one). The agentId is a validated
  // `agent-<12 hex>` token (no regex metacharacters), so embedding it is safe.
  const pattern = new RegExp(
    `^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_${agentId}\\.jsonl$`,
  );
  const matches = entries.filter((f) => pattern.test(f)).sort();
  const newest = matches[matches.length - 1];
  return newest === undefined ? undefined : pathApiFor(mainSessionFile).join(dir, newest);
}

/**
 * The model-visible agent-ID trailer line. Appended — clearly delimited, outside
 * the verbatim-message contract, like the cut-off note — to completed and
 * truncated-completed foreground results and TaskOutput text of RESUMABLE agents.
 * Advisory, not authenticated: a subagent could forge a look-alike line in its
 * own prose; the dispatch registry stays the source of truth for what an ID
 * reaches, bounding impact to misdirected (legitimate) delivery — the same
 * in-band property Claude Code has.
 */
export function agentTrailerLine(agentId: string, opts: { completed: boolean }): string {
  return `[agent ${agentId}${opts.completed ? " completed" : ""} — resumable via SendMessage]`;
}

/**
 * The STANDALONE trailer frame: the `\n\n---\n` delimiter followed by the
 * trailer line. This is the single home of the `\n\n---\n` framing string —
 * hand-writing it at each call site lets the delimiter drift. Use this when a
 * completed message's trailer opens its OWN frame. When a truncated-completed
 * message's trailer instead rides INSIDE its existing cut-off frame, append a
 * bare `agentTrailerLine` with a single-`\n` prefix rather than opening a second
 * frame.
 */
export function agentTrailerFrame(agentId: string, opts: { completed: boolean }): string {
  return `\n\n---\n${agentTrailerLine(agentId, opts)}`;
}

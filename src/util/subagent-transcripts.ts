import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Subagent transcript location + agent-ID helpers.
 *
 * Every subagent dispatch persists its Pi session as one JSONL transcript,
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
 * the verbatim-message contract, like the cut-off note — to foreground tool
 * results and TaskOutput text of RESUMABLE agents.
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
 * hand-writing it at each call site lets the delimiter drift. Use
 * this when the trailer opens its OWN frame (a completed message, or a failed
 * message with no prior cut-off frame). When the trailer instead rides INSIDE
 * an existing cut-off frame (truncated/partial output already ends with a
 * `---` frame), append a bare `agentTrailerLine` with a single-`\n` prefix
 * rather than opening a second frame.
 */
export function agentTrailerFrame(agentId: string, opts: { completed: boolean }): string {
  return `\n\n---\n${agentTrailerLine(agentId, opts)}`;
}

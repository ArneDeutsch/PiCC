import os from "node:os";
import path from "node:path";
import type { ClaudeSettings } from "../types.js";
import { expandEnvVars } from "../discovery/settings.js";
import { isFile, readTextSafe } from "../util/fs.js";

/**
 * Memory subsystem, read side.
 *
 * - `loadAutoMemory`: Claude Code's per-project auto memory — `MEMORY.md` under
 *   `<userDir>/projects/<flattened-project-path>/memory` (or the
 *   `autoMemoryDirectory` setting), truncated to the first 200 lines / 25 KB.
 *   Gated by `autoMemoryEnabled` (default true) and the
 *   `CLAUDE_CODE_DISABLE_AUTO_MEMORY` env var.
 * - `loadAgentMemory`: per-agent memory dirs for the `memory:` frontmatter scopes
 *   (`user`/`project`/`local`), same MEMORY.md truncation.
 *
 * Completeness floor: nothing in this module throws; unreadable files degrade to
 * an absent `content`.
 */

const MEMORY_MAX_LINES = 200;
const MEMORY_MAX_BYTES = 25 * 1024;

export interface MemorySnapshot {
  /** Absolute memory directory (may not exist yet — the model creates it on first write). */
  dir: string;
  /** MEMORY.md content, truncated to the first 200 lines / 25 KB; undefined when absent. */
  content?: string;
}

/**
 * Claude's project-path flattening for the per-project state dir: the absolute
 * projectRoot with every non-alphanumeric char replaced by `-`
 * (e.g. `F:\Arne\Projekte\picc` → `F--Arne-Projekte-picc`).
 */
export function flattenProjectPath(projectRoot: string): string {
  return path.resolve(projectRoot).replace(/[^A-Za-z0-9]/g, "-");
}

/** Truthy env-flag semantics: set and not an explicit "off" value. */
function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** Expand a leading `~` against the home dir (settings values may use it). */
function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/**
 * Truncate MEMORY.md content to the first 200 lines or 25 KB, whichever cuts
 * first, appending a marker line when anything was dropped.
 */
function truncateMemory(raw: string): string {
  let out = raw;
  let truncated = false;
  const lines = out.split("\n");
  if (lines.length > MEMORY_MAX_LINES) {
    out = lines.slice(0, MEMORY_MAX_LINES).join("\n");
    truncated = true;
  }
  const buf = Buffer.from(out, "utf8");
  if (buf.length > MEMORY_MAX_BYTES) {
    let cut = MEMORY_MAX_BYTES;
    // Never split a multi-byte UTF-8 sequence: back up over continuation bytes.
    while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
    out = buf.subarray(0, cut).toString("utf8");
    truncated = true;
  }
  if (truncated) {
    out += `\n[MEMORY.md truncated: only the first ${MEMORY_MAX_LINES} lines / ${MEMORY_MAX_BYTES / 1024} KB are shown]`;
  }
  return out;
}

/** Read and truncate `<dir>/MEMORY.md`; undefined when absent or unreadable. */
function readMemoryMd(dir: string): string | undefined {
  const file = path.join(dir, "MEMORY.md");
  if (!isFile(file)) return undefined;
  const raw = readTextSafe(file);
  return raw === undefined ? undefined : truncateMemory(raw);
}

/**
 * Resolve and load the auto-memory directory for a project.
 * Returns undefined when auto memory is disabled (`autoMemoryEnabled: false` or
 * a truthy `CLAUDE_CODE_DISABLE_AUTO_MEMORY`); otherwise the directory always
 * resolves, with `content` present only when MEMORY.md exists.
 */
export function loadAutoMemory(
  projectRoot: string,
  userDir: string,
  settings: Pick<ClaudeSettings, "autoMemoryEnabled" | "autoMemoryDirectory">,
  env: NodeJS.ProcessEnv = process.env,
): MemorySnapshot | undefined {
  if (isEnvTruthy(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY)) return undefined;
  if (settings.autoMemoryEnabled === false) return undefined;

  const override = settings.autoMemoryDirectory;
  const dir =
    override !== undefined && override.trim() !== ""
      ? path.resolve(expandTilde(expandEnvVars(override, env), os.homedir()))
      : path.join(path.resolve(userDir), "projects", flattenProjectPath(projectRoot), "memory");
  return { dir, content: readMemoryMd(dir) };
}

/**
 * Resolve and load an agent's memory dir for the `memory:` frontmatter scopes:
 * user → `<userDir>/agent-memory/<name>/`, project →
 * `<projectRoot>/.claude/agent-memory/<name>/`, local →
 * `<projectRoot>/.claude/agent-memory-local/<name>/`. Unknown scopes degrade to
 * undefined (never throw).
 */
export function loadAgentMemory(
  agentName: string,
  scope: "user" | "project" | "local",
  projectRoot: string,
  userDir: string,
): MemorySnapshot | undefined {
  let dir: string;
  switch (scope) {
    case "user":
      dir = path.join(path.resolve(userDir), "agent-memory", agentName);
      break;
    case "project":
      dir = path.join(path.resolve(projectRoot), ".claude", "agent-memory", agentName);
      break;
    case "local":
      dir = path.join(path.resolve(projectRoot), ".claude", "agent-memory-local", agentName);
      break;
    default:
      return undefined;
  }
  return { dir, content: readMemoryMd(dir) };
}

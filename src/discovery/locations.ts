import path from "node:path";
import { findRepoRoot, isDirectory } from "../util/fs.js";
import type { Scope, SourceRef } from "../types.js";

/**
 * Artifact location resolution (plan §3): where skills/agents/rules/commands live,
 * with the monorepo walk-up (cwd → repo root, nearest first) and user-scope dirs.
 */

/** A directory that contributes artifacts, tagged with the scope it was found at. */
export interface SourceDirs {
  dir: string;
  scope: Scope;
}

export interface ArtifactDirs {
  skillDirs: SourceDirs[];
  agentDirs: SourceDirs[];
  ruleDirs: SourceDirs[];
  commandDirs: SourceDirs[];
}

/** Resolve the project root: enclosing git repo root, falling back to cwd. */
export function resolveProjectRoot(cwd: string): string {
  return findRepoRoot(cwd) ?? path.resolve(cwd);
}

/** Path equality that tolerates Windows case-insensitivity. */
function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (process.platform === "win32") return ra.toLowerCase() === rb.toLowerCase();
  return ra === rb;
}

/**
 * Default managed/policy artifact base directories (research doc §4.1). Mirrors
 * the managed settings locations in settings.ts; degrade-silent when absent.
 */
function defaultManagedDirs(): string[] {
  if (process.platform === "win32") {
    return [path.join("C:\\", "ProgramData", "ClaudeCode")];
  }
  return [path.join("/etc", "claude-code")];
}

/**
 * Discover every artifact-contributing directory for a session.
 *
 * Managed/policy directories come FIRST (highest precedence, per
 * SCOPE_PRECEDENCE; degrade-safe when absent). Monorepo walk-up: from `cwd` up
 * to `projectRoot`, every `.claude/` directory contributes; results are ordered
 * NEAREST-FIRST so callers can apply "nearest definition wins" via
 * {@link dedupeByName}. User-scope directories (`<userDir>/skills` etc.) come
 * last. Only existing directories are returned.
 */
export function discoverArtifactDirs(opts: {
  cwd: string;
  projectRoot: string;
  userDir: string;
  /** Override managed/policy artifact base directories (used by tests). */
  managedDirs?: string[];
}): ArtifactDirs {
  const result: ArtifactDirs = { skillDirs: [], agentDirs: [], ruleDirs: [], commandDirs: [] };

  const push = (baseDir: string, scope: Scope): void => {
    const add = (bucket: SourceDirs[], sub: string): void => {
      const dir = path.join(baseDir, sub);
      if (isDirectory(dir)) bucket.push({ dir, scope });
    };
    add(result.skillDirs, "skills");
    add(result.agentDirs, "agents");
    add(result.ruleDirs, "rules");
    add(result.commandDirs, "commands");
  };

  // Managed/policy scope: highest precedence, absent on most machines.
  for (const base of opts.managedDirs ?? defaultManagedDirs()) {
    push(path.resolve(base), "managed");
  }

  // Project scope: walk cwd → projectRoot (inclusive), nearest first.
  const root = path.resolve(opts.projectRoot);
  let dir = path.resolve(opts.cwd);
  for (;;) {
    const claudeDir = path.join(dir, ".claude");
    if (isDirectory(claudeDir)) push(claudeDir, "project");
    if (samePath(dir, root)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root without meeting projectRoot
    dir = parent;
  }

  // User scope, lowest precedence of the discovered set.
  push(path.resolve(opts.userDir), "user");

  return result;
}

/**
 * Precedence helper for named artifacts: keeps the FIRST occurrence of each name.
 * Callers must order candidates managed > local > project (nearest-first) > user > plugin
 * before calling; the returned array contains only the winners, original order preserved.
 */
export function dedupeByName<T extends { name: string; source: SourceRef }>(items: T[]): T[] {
  const seen = new Set<string>();
  const winners: T[] = [];
  for (const item of items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    winners.push(item);
  }
  return winners;
}

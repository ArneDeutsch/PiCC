import path from "node:path";
import type { ClaudeRule, Diagnostic, Scope } from "../types.js";
import { isDirectory, readTextSafe, walkFiles } from "../util/fs.js";
import { matchesAny, normalizeSlashes } from "../util/globs.js";
import { parseMarkdown, toStringList } from "../util/markdown.js";

/**
 * Rules subsystem: `.claude/rules/**\/*.md`, project and user scope.
 *
 * Files without `paths:` frontmatter load unconditionally at session start; files with
 * `paths:` (glob list, shared engine with path-scoped skills) inject only when the model
 * touches a matching file.
 *
 * Completeness floor: never throws; malformed files degrade with diagnostics.
 */

/** Frontmatter keys the rules subsystem understands. */
const KNOWN_KEYS = new Set(["paths"]);

export interface LoadRulesResult {
  rules: ClaudeRule[];
  diagnostics: Diagnostic[];
}

/**
 * Recursively load `**\/*.md` under each rules dir.
 *
 * Order: input dir order preserved. The caller passes dirs in ASCENDING priority
 * (user, then project root→cwd, then managed last) so higher-priority
 * guidance renders later/closer in the prompt; files within a dir sort
 * lexicographically by their forward-slash relative id. `excludes` glob patterns
 * (base = projectRoot) skip matching files.
 */
export function loadRules(
  dirs: Array<{ dir: string; scope: Scope }>,
  opts: { excludes: string[]; projectRoot: string },
): LoadRulesResult {
  const rules: ClaudeRule[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const { dir, scope } of dirs) {
    if (!isDirectory(dir)) continue;
    const found = walkFiles(dir, (name) => name.toLowerCase().endsWith(".md"));
    const entries = found
      .map((file) => ({ file, id: normalizeSlashes(path.relative(dir, file)) }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const { file, id } of entries) {
      if (opts.excludes.length > 0 && matchesAny(file, opts.excludes, opts.projectRoot)) {
        diagnostics.push({
          severity: "info",
          message: `Rule skipped by excludes: ${file}`,
          source: file,
        });
        continue;
      }
      const raw = readTextSafe(file);
      if (raw === undefined) {
        diagnostics.push({
          severity: "warning",
          message: `Rule file unreadable: ${file}`,
          source: file,
        });
        continue;
      }
      const parsed = parseMarkdown(raw, file);
      const paths = toStringList(parsed.frontmatter["paths"]);
      const unknownKeys = Object.keys(parsed.frontmatter).filter((k) => !KNOWN_KEYS.has(k));
      const rule: ClaudeRule = {
        id,
        // Empty `paths:` degrades to unconditional rather than never-matching.
        paths: paths !== undefined && paths.length > 0 ? paths : undefined,
        body: parsed.body,
        source: { path: file, scope },
        unknownKeys,
        diagnostics: parsed.diagnostics,
      };
      rules.push(rule);
      diagnostics.push(...parsed.diagnostics);
    }
  }
  return { rules, diagnostics };
}

/**
 * Whether a rule applies to a touched file. Unconditional rules (no `paths:`) always
 * apply; path-scoped rules use the shared glob engine.
 *
 * Mirrors findNestedClaudeMd's resolution: the touched path resolves against the
 * session `cwd` (the model passes cwd-relative paths, and after EnterWorktree the
 * cwd is the worktree), and a file inside `<projectRoot>/.claude/worktrees/<name>/`
 * matches the globs relative to that worktree root — a worktree is its own checkout,
 * so `src/**` rules must fire for `<worktree>/src/main.rs` exactly as on main.
 */
export function ruleAppliesTo(
  rule: ClaudeRule,
  filePath: string,
  projectRoot: string,
  cwd?: string,
): boolean {
  if (!rule.paths || rule.paths.length === 0) return true;
  const root = path.resolve(projectRoot);
  const abs = path.resolve(cwd ?? root, filePath);
  let effectiveRoot = root;
  const rel = normalizeSlashes(path.relative(root, abs));
  const wt = /^\.claude\/worktrees\/([^/]+)(?:\/|$)/i.exec(rel);
  if (wt) effectiveRoot = path.join(root, ".claude", "worktrees", wt[1]!);
  return matchesAny(abs, rule.paths, effectiveRoot);
}

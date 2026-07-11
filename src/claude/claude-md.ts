import os from "node:os";
import path from "node:path";
import type { ClaudeMdFile, Diagnostic, Scope } from "../types.js";
import { isFile, readTextSafe } from "../util/fs.js";
import { matchesAny, normalizeSlashes } from "../util/globs.js";
import { stripBlockHtmlComments } from "../util/markdown.js";

/**
 * CLAUDE.md hierarchy subsystem (plan §4.6).
 *
 * - `expandImports`: `@path` import expansion (recursive, hop-limited, code-span aware).
 * - `loadClaudeMdHierarchy`: session-start collection (user → root→cwd → .claude, with
 *   CLAUDE.local.md siblings).
 * - `findNestedClaudeMd`: on-demand nearest-ancestor lookup when the model touches a file,
 *   worktree-aware.
 *
 * Completeness floor: nothing in this module throws; problems degrade to diagnostics.
 */

// ---------------------------------------------------------------------------
// @import expansion
// ---------------------------------------------------------------------------

const DEFAULT_MAX_HOPS = 4;

export interface ExpandImportsResult {
  content: string;
  /** Absolute paths of every file successfully imported (deduplicated, discovery order). */
  imported: string[];
  diagnostics: Diagnostic[];
}

interface ExpandContext {
  home: string;
  maxHops: number;
  imported: string[];
  importedKeys: Set<string>;
  diagnostics: Diagnostic[];
}

/** Canonical key for cycle/dedupe checks (Windows: case-insensitive, forward slashes). */
function pathKey(p: string): string {
  const k = normalizeSlashes(path.resolve(p));
  return process.platform === "win32" ? k.toLowerCase() : k;
}

/**
 * Expand `@path` imports in `content` recursively, up to `maxHops` (default 4) levels deep.
 *
 * An import token starts with `@` at a word boundary (start of line or preceded by
 * whitespace), followed by a path-looking string (contains `.`, `/`, or `\`). Tokens inside
 * fenced code blocks (``` / ~~~) or inline code spans (backticks) are left untouched.
 * `@~/x` expands against the home dir; absolute paths are used as-is; everything else is
 * relative to `baseDir`. Missing files and cycles keep the token and add a diagnostic.
 */
export function expandImports(
  content: string,
  baseDir: string,
  opts: { home?: string; maxHops?: number } = {},
): ExpandImportsResult {
  const ctx: ExpandContext = {
    home: opts.home ?? os.homedir(),
    maxHops: opts.maxHops ?? DEFAULT_MAX_HOPS,
    imported: [],
    importedKeys: new Set(),
    diagnostics: [],
  };
  const expanded = expandText(content, baseDir, 0, new Set(), ctx);
  return { content: expanded, imported: ctx.imported, diagnostics: ctx.diagnostics };
}

function expandText(
  content: string,
  baseDir: string,
  depth: number,
  stack: Set<string>,
  ctx: ExpandContext,
): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let fenceMarker: string | undefined; // "`" or "~" while inside a fenced block
  let fenceLen = 0;

  for (const line of lines) {
    const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1]!.charAt(0);
      const len = fence[1]!.length;
      if (fenceMarker === undefined) {
        fenceMarker = marker;
        fenceLen = len;
      } else if (marker === fenceMarker && len >= fenceLen) {
        fenceMarker = undefined;
      }
      out.push(line);
      continue;
    }
    if (fenceMarker !== undefined) {
      out.push(line);
      continue;
    }
    out.push(expandLine(line, baseDir, depth, stack, ctx));
  }
  return out.join("\n");
}

/** Ranges of the line covered by inline code spans (CommonMark-ish backtick-run pairing). */
function codeSpanRanges(line: string): Array<[number, number]> {
  const runs: Array<{ start: number; len: number }> = [];
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) runs.push({ start: m.index, len: m[0].length });

  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < runs.length) {
    const open = runs[i]!;
    let j = i + 1;
    while (j < runs.length && runs[j]!.len !== open.len) j++;
    if (j < runs.length) {
      const close = runs[j]!;
      ranges.push([open.start, close.start + close.len]);
      i = j + 1;
    } else {
      i++;
    }
  }
  return ranges;
}

function expandLine(
  line: string,
  baseDir: string,
  depth: number,
  stack: Set<string>,
  ctx: ExpandContext,
): string {
  const spans = codeSpanRanges(line);
  const inSpan = (idx: number) => spans.some(([s, e]) => idx >= s && idx < e);

  const re = /@([^\s`]+)/g;
  let result = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const idx = m.index;
    const token = m[0];
    const rawPath = m[1]!;
    // Word boundary: start of line or preceded by whitespace (rules out user@host.com).
    if (idx > 0 && !/\s/.test(line.charAt(idx - 1))) continue;
    if (inSpan(idx)) continue;
    // Must look like a path: contains a dot or a path separator.
    if (!/[./\\]/.test(rawPath)) continue;

    const replacement = resolveImport(rawPath, token, baseDir, depth, stack, ctx);
    if (replacement === undefined) continue; // keep token as-is
    result += line.slice(last, idx) + replacement;
    last = idx + token.length;
  }
  return result + line.slice(last);
}

/** Returns the expanded content for an import token, or undefined to keep the token. */
function resolveImport(
  rawPath: string,
  token: string,
  baseDir: string,
  depth: number,
  stack: Set<string>,
  ctx: ExpandContext,
): string | undefined {
  let resolved: string;
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    resolved = path.join(ctx.home, rawPath.slice(2));
  } else if (path.isAbsolute(rawPath)) {
    resolved = path.resolve(rawPath);
  } else {
    resolved = path.resolve(baseDir, rawPath);
  }
  const key = pathKey(resolved);

  if (depth >= ctx.maxHops) {
    ctx.diagnostics.push({
      severity: "warning",
      message: `Import ${token} not expanded: max import depth (${ctx.maxHops} hops) reached`,
      source: resolved,
    });
    return undefined;
  }
  if (stack.has(key)) {
    ctx.diagnostics.push({
      severity: "warning",
      message: `Circular import detected: ${token} is already being expanded`,
      source: resolved,
    });
    return undefined;
  }
  const raw = readTextSafe(resolved);
  if (raw === undefined || !isFile(resolved)) {
    ctx.diagnostics.push({
      severity: "warning",
      message: `Import ${token} not found (resolved to ${resolved}); leaving token as-is`,
      source: resolved,
    });
    return undefined;
  }

  if (!ctx.importedKeys.has(key)) {
    ctx.importedKeys.add(key);
    ctx.imported.push(resolved);
  }
  const nextStack = new Set(stack);
  nextStack.add(key);
  return expandText(raw, path.dirname(resolved), depth + 1, nextStack, ctx);
}

// ---------------------------------------------------------------------------
// Hierarchy loading (session start)
// ---------------------------------------------------------------------------

export interface ClaudeMdHierarchyResult {
  files: ClaudeMdFile[];
  diagnostics: Diagnostic[];
}

function loadOne(
  filePath: string,
  scope: Scope,
  loadAtStart: boolean,
  home?: string,
): ClaudeMdFile {
  const dir = path.dirname(filePath);
  const raw = readTextSafe(filePath) ?? "";
  const expanded = expandImports(raw, dir, home === undefined ? {} : { home });
  const content = stripBlockHtmlComments(expanded.content);
  return { path: filePath, dir, content, scope, loadAtStart, diagnostics: expanded.diagnostics };
}

/** Directories from projectRoot down to cwd (both inclusive, root first). */
function dirChain(projectRoot: string, cwd: string): string[] {
  const root = path.resolve(projectRoot);
  const target = path.resolve(cwd);
  const rel = path.relative(root, target);
  if (rel === "") return [root];
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [root]; // cwd outside root: root only
  const chain = [root];
  let acc = root;
  for (const seg of rel.split(path.sep).filter(Boolean)) {
    acc = path.join(acc, seg);
    chain.push(acc);
  }
  return chain;
}

/**
 * Collect the CLAUDE.md hierarchy loaded at session start, in load order:
 * 1. `<userDir>/CLAUDE.md` (scope "user")
 * 2. every `CLAUDE.md` from projectRoot down to cwd (root→cwd, scope "project")
 * 3. `<projectRoot>/.claude/CLAUDE.md` if present (scope "project")
 * With `CLAUDE.local.md` (scope "local") immediately after its sibling in each directory.
 * `excludes` glob patterns (base = projectRoot) skip matching files.
 */
export function loadClaudeMdHierarchy(opts: {
  cwd: string;
  projectRoot: string;
  userDir: string;
  excludes: string[];
  /** Test hook: overrides the home dir used for `@~/` imports. */
  home?: string;
}): ClaudeMdHierarchyResult {
  const files: ClaudeMdFile[] = [];
  const diagnostics: Diagnostic[] = [];
  const projectRoot = path.resolve(opts.projectRoot);
  const seen = new Set<string>();

  const candidates: Array<{ dir: string; scope: Scope }> = [
    { dir: path.resolve(opts.userDir), scope: "user" },
    ...dirChain(projectRoot, opts.cwd).map((dir) => ({ dir, scope: "project" as Scope })),
    { dir: path.join(projectRoot, ".claude"), scope: "project" },
  ];

  for (const { dir, scope } of candidates) {
    for (const { name, fileScope } of [
      { name: "CLAUDE.md", fileScope: scope },
      { name: "CLAUDE.local.md", fileScope: "local" as Scope },
    ]) {
      const full = path.join(dir, name);
      const key = pathKey(full);
      if (seen.has(key)) continue;
      if (!isFile(full)) continue;
      seen.add(key);
      if (opts.excludes.length > 0 && matchesAny(full, opts.excludes, projectRoot)) {
        diagnostics.push({
          severity: "info",
          message: `Skipped by claudeMdExcludes: ${full}`,
          source: full,
        });
        continue;
      }
      const file = loadOne(full, fileScope, true, opts.home);
      files.push(file);
      diagnostics.push(...file.diagnostics);
    }
  }
  return { files, diagnostics };
}

// ---------------------------------------------------------------------------
// Nested (on-demand) lookup
// ---------------------------------------------------------------------------

/** True when `dir` is `root` or lies below it. */
function isWithin(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Find the nearest-ancestor `CLAUDE.md` for a touched file, walking from
 * `dirname(fileTouched)` up to the project root — or, when the file lives inside a
 * worktree checkout (`<projectRoot>/.claude/worktrees/<name>/...`), up to that worktree
 * root (the worktree contains its own checkout of CLAUDE.md files).
 *
 * Files already present in `loaded` (absolute-path set) are skipped; the walk continues
 * upward past them. Returns undefined when nothing new is found.
 */
export function findNestedClaudeMd(
  fileTouched: string,
  opts: { cwd: string; projectRoot: string; excludes: string[]; loaded: Set<string> },
): ClaudeMdFile | undefined {
  const projectRoot = path.resolve(opts.projectRoot);
  const abs = path.resolve(opts.cwd, fileTouched);
  if (!isWithin(projectRoot, abs)) return undefined;

  // Worktree detection: stop the walk at the worktree root instead of the project root.
  let effectiveRoot = projectRoot;
  const rel = normalizeSlashes(path.relative(projectRoot, abs));
  const wt = /^\.claude\/worktrees\/([^/]+)(?:\/|$)/i.exec(rel);
  if (wt) effectiveRoot = path.join(projectRoot, ".claude", "worktrees", wt[1]!);

  const loadedKeys = new Set<string>();
  for (const p of opts.loaded) loadedKeys.add(pathKey(p));

  let dir = path.dirname(abs);
  if (!isWithin(effectiveRoot, dir)) return undefined;
  for (;;) {
    const candidate = path.join(dir, "CLAUDE.md");
    if (
      isFile(candidate) &&
      !loadedKeys.has(pathKey(candidate)) &&
      !(opts.excludes.length > 0 && matchesAny(candidate, opts.excludes, projectRoot))
    ) {
      return loadOne(candidate, "project", false);
    }
    if (pathKey(dir) === pathKey(effectiveRoot)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir || !isWithin(effectiveRoot, parent)) return undefined;
    dir = parent;
  }
}

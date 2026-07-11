import picomatch from "picomatch";
import path from "node:path";

/**
 * Shared glob engine (plan §4.2): used by rules `paths:`, skills `paths:`,
 * permission rules Read/Edit(glob), `claudeMdExcludes`, `.worktreeinclude`.
 *
 * Semantics (gitignore-flavoured, Claude Code compatible):
 * - Patterns use forward slashes; matched paths are normalized to forward slashes.
 * - A pattern without a slash matches against the basename anywhere ("*.md"),
 *   and — gitignore-style — everything inside a directory of that name.
 * - A pattern with a non-trailing slash is anchored to the given base
 *   (project root / cwd). A slash ONLY at the end does not anchor.
 * - `**` crosses directories; trailing `/` means "directory and everything below".
 * - Leading `//` (Claude) or absolute paths anchor to filesystem root.
 * - `~/` expands to the home directory.
 *
 * The base/home directories are treated as LITERAL paths: glob metacharacters
 * in them (e.g. "C:/Program Files (x86)") never gain glob meaning. This is done
 * by prefix-stripping instead of concatenating them into the pattern.
 */

const NOCASE = process.platform === "win32";
const PM_OPTS = { dot: true, nocase: NOCASE, windows: false } as const;

export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Escape glob metacharacters in a literal path so it can be safely embedded
 * in a glob pattern (e.g. a resolved cwd prefixed onto a user pattern).
 */
export function escapeGlobPath(p: string): string {
  return p.replace(/[(){}[\]*?+@!|]/g, (c) => `\\${c}`);
}

/** Absolute-path check that also recognizes Windows drive/backslash paths on POSIX. */
function isAbsoluteLike(p: string): boolean {
  return path.isAbsolute(p) || /^([a-zA-Z]:)?[\\/]/.test(p);
}

/** Case-aware "p is inside directory prefix" check on normalized paths. */
function hasPathPrefix(p: string, prefix: string): boolean {
  if (p.length <= prefix.length || p[prefix.length] !== "/") return false;
  const head = p.slice(0, prefix.length);
  return NOCASE ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
}

/**
 * Matcher anchored under a literal directory: the candidate must lie inside
 * `anchorDir` (compared literally, case-insensitively on Windows) and its
 * anchor-relative part must match `relPattern`. Keeps metacharacters in the
 * anchor directory from being interpreted as glob syntax.
 */
function makeAnchoredMatcher(anchorDir: string, relPattern: string): (file: string) => boolean {
  const prefix = `${anchorDir.replace(/\/+$/, "")}/`;
  const cmpPrefix = NOCASE ? prefix.toLowerCase() : prefix;
  const rel = relPattern.replace(/^\/+/, "") || "**";
  const isMatch = picomatch(rel, PM_OPTS);
  return (file: string) => {
    const f = NOCASE ? file.toLowerCase() : file;
    if (!f.startsWith(cmpPrefix)) return false;
    return isMatch(file.slice(prefix.length));
  };
}

export interface GlobMatcher {
  (filePath: string): boolean;
  patterns: string[];
}

export function createGlobMatcher(
  patterns: string[],
  opts: { base?: string; home?: string } = {},
): GlobMatcher {
  const base = opts.base
    ? normalizeSlashes(path.resolve(opts.base)).replace(/\/+$/, "") || "/"
    : undefined;
  const home = normalizeSlashes(
    opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "~",
  ).replace(/\/+$/, "");

  const compiled = patterns.map((raw): ((file: string) => boolean) => {
    let pattern = normalizeSlashes(raw.trim());
    if (!pattern) return () => false;

    let homeAnchored = false;
    let absolute = false;
    if (pattern.startsWith("~/")) {
      pattern = pattern.slice(2);
      homeAnchored = true;
    } else if (pattern.startsWith("//")) {
      pattern = pattern.slice(1);
      absolute = true;
    } else if (/^([a-zA-Z]:)?\//.test(pattern)) {
      absolute = true;
    }

    // gitignore: a trailing `/` means "directory and everything below" and does
    // NOT anchor — decide anchoring before appending the contents glob.
    const isDirPattern = pattern.endsWith("/");
    if (isDirPattern) pattern = pattern.replace(/\/+$/, "");
    if (!absolute && !homeAnchored && (pattern === "." || pattern === "./" || pattern === "")) {
      // "./" — everything under the base.
      if (base) return makeAnchoredMatcher(base, "**");
      const isMatch = picomatch("**", PM_OPTS);
      return (file: string) => isMatch(file);
    }

    if (absolute) {
      if (isDirPattern) pattern += "/**";
      // If the pattern lies literally under base/home (e.g. a cwd-prefixed
      // permission rule), strip that literal prefix so metacharacters in the
      // directory path don't break matching.
      for (const anchor of [base, home]) {
        if (anchor && hasPathPrefix(pattern, anchor)) {
          return makeAnchoredMatcher(anchor, pattern.slice(anchor.length + 1));
        }
      }
      const isMatch = picomatch(pattern, PM_OPTS);
      return (file: string) => isMatch(file);
    }

    if (homeAnchored) {
      if (isDirPattern) pattern += "/**";
      return makeAnchoredMatcher(home, pattern);
    }

    if (pattern.includes("/")) {
      // Non-trailing slash: anchored to base.
      pattern = pattern.replace(/^\.?\//, "");
      if (isDirPattern) pattern += "/**";
      if (base) return makeAnchoredMatcher(base, pattern);
      const isMatch = picomatch(`**/${pattern}`, PM_OPTS);
      return (file: string) => isMatch(file);
    }

    // Slash-free: match anywhere. Bare names match the file/dir itself AND
    // (gitignore directory semantics) everything inside a directory so named;
    // trailing-slash patterns match only directory contents.
    const matchers: Array<(file: string) => boolean> = [];
    if (!isDirPattern) {
      matchers.push(picomatch(pattern, { ...PM_OPTS, basename: true }));
      matchers.push(picomatch(`**/${pattern}`, PM_OPTS));
    }
    matchers.push(picomatch(`**/${pattern}/**`, PM_OPTS));
    return (file: string) => matchers.some((m) => m(file));
  });

  const matcher = ((filePath: string) => {
    const resolved =
      isAbsoluteLike(filePath) || !opts.base ? filePath : path.resolve(opts.base, filePath);
    const normalized = normalizeSlashes(resolved);
    return compiled.some((m) => m(normalized));
  }) as GlobMatcher;
  matcher.patterns = patterns;
  return matcher;
}

/** Match a single relative-or-absolute file path against patterns with a base dir. */
export function matchesAny(filePath: string, patterns: string[], base?: string): boolean {
  if (patterns.length === 0) return false;
  const abs = base && !isAbsoluteLike(filePath) ? path.resolve(base, filePath) : filePath;
  return createGlobMatcher(patterns, { base })(normalizeSlashes(abs));
}

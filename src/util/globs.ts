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
 * - Leading `//` (Claude) or absolute paths anchor to filesystem root. A
 *   non-drive `//…` pattern (`//server/share/**`) additionally matches UNC
 *   candidates (`\\server\share\…` normalizes to `//server/share/…`); a
 *   wildcard form (`//**` + `/x`) means "any absolute path" and matches drive,
 *   POSIX-root, AND UNC paths — all of them are absolute.
 * - `~/` expands to the home directory.
 * - Windows normalization (Claude v2.1.166): drive-lettered paths and patterns
 *   are canonicalized to `/c/…` form before matching, so `//c/**` addresses
 *   drive C and backslash/forward-slash/drive-case variants all compare equal.
 *   POSIX inputs pass through byte-identical.
 *
 * The base/home directories are treated as LITERAL paths: glob metacharacters
 * in them (e.g. "C:/Program Files (x86)") never gain glob meaning. This is done
 * by prefix-stripping instead of concatenating them into the pattern.
 */

const PLATFORM_NOCASE = process.platform === "win32";

function pmOpts(nocase: boolean): { dot: true; nocase: boolean; windows: false } {
  return { dot: true, nocase, windows: false };
}

export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Canonicalize a path for matching: backslashes → forward slashes, and a
 * drive-letter absolute prefix `C:/x` → `/c/x` (lowercase drive) so Claude's
 * documented `//c/**` pattern form can address Windows drives regardless of
 * input flavor. Non-drive paths pass through with slashes normalized only —
 * POSIX behavior stays byte-identical.
 */
export function normalizeDrivePath(p: string): string {
  const s = normalizeSlashes(p);
  const m = /^([A-Za-z]):(\/.*)?$/.exec(s);
  if (!m || m[1] === undefined) return s;
  return `/${m[1].toLowerCase()}${m[2] ?? "/"}`;
}

/** Pattern shapes that address a Windows drive (`C:/…`, `C:\…`, `//c/…`). */
function isDriveLetteredPattern(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\/\/[A-Za-z](\/|$)/.test(p);
}

/**
 * Escape glob metacharacters in a literal path so it can be safely embedded
 * in a glob pattern (e.g. a resolved cwd prefixed onto a user pattern).
 */
export function escapeGlobPath(p: string): string {
  return p.replace(/[(){}[\]*?+@!|]/g, (c) => `\\${c}`);
}

/** Absolute-path check that also recognizes Windows drive/backslash paths on POSIX. */
export function isAbsoluteLike(p: string): boolean {
  return path.isAbsolute(p) || /^([a-zA-Z]:)?[\\/]/.test(p);
}

/** Case-aware "p is inside directory prefix" check on normalized paths. */
function hasPathPrefix(p: string, prefix: string, nocase: boolean): boolean {
  if (p.length <= prefix.length || p[prefix.length] !== "/") return false;
  const head = p.slice(0, prefix.length);
  return nocase ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
}

/**
 * Matcher anchored under a literal directory: the candidate must lie inside
 * `anchorDir` (compared literally, case-insensitively on Windows) and its
 * anchor-relative part must match `relPattern`. Keeps metacharacters in the
 * anchor directory from being interpreted as glob syntax.
 */
function makeAnchoredMatcher(
  anchorDir: string,
  relPattern: string,
  nocase: boolean,
): (file: string) => boolean {
  const prefix = `${anchorDir.replace(/\/+$/, "")}/`;
  const cmpPrefix = nocase ? prefix.toLowerCase() : prefix;
  const rel = relPattern.replace(/^\/+/, "") || "**";
  const isMatch = picomatch(rel, pmOpts(nocase));
  return (file: string) => {
    const f = nocase ? file.toLowerCase() : file;
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
  opts: { base?: string; home?: string; nocase?: boolean } = {},
): GlobMatcher {
  // Resolve the base natively when the platform understands it; a foreign
  // absolute form (drive-lettered on POSIX) passes through for drive
  // normalization instead of being glued onto the POSIX cwd.
  const rawBase = opts.base;
  const base = rawBase
    ? normalizeDrivePath(
        path.isAbsolute(rawBase) || !isAbsoluteLike(rawBase) ? path.resolve(rawBase) : rawBase,
      ).replace(/\/+$/, "") || "/"
    : undefined;
  const home = normalizeDrivePath(
    opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "~",
  ).replace(/\/+$/, "");

  const compiled = patterns.map((raw): ((file: string) => boolean) => {
    let pattern = normalizeSlashes(raw.trim());
    if (!pattern) return () => false;
    // Case-insensitive on Windows, and for drive-lettered patterns on every
    // platform (Windows filesystems are case-insensitive no matter where the
    // rule is evaluated). `opts.nocase` overrides both for callers/tests.
    const nocase = opts.nocase ?? (PLATFORM_NOCASE || isDriveLetteredPattern(pattern));

    let homeAnchored = false;
    let absolute = false;
    // Set for non-drive `//…` patterns (UNC share `//server/share/**`, or a
    // wildcard first segment `//**/…`): UNC candidates normalize to
    // `//server/…`, so matching also tries the candidate with its leading `//`
    // collapsed into the single-slash space. Such a pattern therefore matches
    // BOTH fs-root absolute paths (`/etc/x`, `/c/x` — POSIX behavior
    // unchanged) AND UNC paths: both are absolute. `//c/**` (single drive
    // letter) keeps its drive-only semantics.
    let uncCollapse = false;
    if (pattern.startsWith("~/")) {
      pattern = pattern.slice(2);
      homeAnchored = true;
    } else if (pattern.startsWith("//")) {
      // `//c/**` (drive) and `//**/…` (any absolute) are already in the
      // normalized `/…` space after dropping one slash.
      uncCollapse = !/^\/\/[A-Za-z](\/|$)/.test(pattern);
      pattern = pattern.slice(1);
      absolute = true;
    } else if (/^([a-zA-Z]:)?\//.test(pattern)) {
      pattern = normalizeDrivePath(pattern);
      absolute = true;
    }

    // gitignore: a trailing `/` means "directory and everything below" and does
    // NOT anchor — decide anchoring before appending the contents glob.
    const isDirPattern = pattern.endsWith("/");
    if (isDirPattern) pattern = pattern.replace(/\/+$/, "");
    if (!absolute && !homeAnchored && (pattern === "." || pattern === "./" || pattern === "")) {
      // "./" — everything under the base.
      if (base) return makeAnchoredMatcher(base, "**", nocase);
      const isMatch = picomatch("**", pmOpts(nocase));
      return (file: string) => isMatch(file);
    }

    if (absolute) {
      if (isDirPattern) pattern += "/**";
      // If the pattern lies literally under base/home (e.g. a cwd-prefixed
      // permission rule), strip that literal prefix so metacharacters in the
      // directory path don't break matching. UNC-capable patterns also try
      // their original `//…` form — a UNC base keeps its double slash.
      for (const anchor of [base, home]) {
        if (!anchor) continue;
        if (hasPathPrefix(pattern, anchor, nocase)) {
          return makeAnchoredMatcher(anchor, pattern.slice(anchor.length + 1), nocase);
        }
        if (uncCollapse && hasPathPrefix(`/${pattern}`, anchor, nocase)) {
          return makeAnchoredMatcher(anchor, `/${pattern}`.slice(anchor.length + 1), nocase);
        }
      }
      const isMatch = picomatch(pattern, pmOpts(nocase));
      if (uncCollapse) {
        return (file: string) => isMatch(file) || (file.startsWith("//") && isMatch(file.slice(1)));
      }
      return (file: string) => isMatch(file);
    }

    if (homeAnchored) {
      if (isDirPattern) pattern += "/**";
      return makeAnchoredMatcher(home, pattern, nocase);
    }

    if (pattern.includes("/")) {
      // Non-trailing slash: anchored to base.
      pattern = pattern.replace(/^\.?\//, "");
      if (isDirPattern) pattern += "/**";
      if (base) return makeAnchoredMatcher(base, pattern, nocase);
      const isMatch = picomatch(`**/${pattern}`, pmOpts(nocase));
      return (file: string) => isMatch(file);
    }

    // Slash-free: match anywhere. Bare names match the file/dir itself AND
    // (gitignore directory semantics) everything inside a directory so named;
    // trailing-slash patterns match only directory contents.
    const matchers: Array<(file: string) => boolean> = [];
    if (!isDirPattern) {
      matchers.push(picomatch(pattern, { ...pmOpts(nocase), basename: true }));
      matchers.push(picomatch(`**/${pattern}`, pmOpts(nocase)));
    }
    matchers.push(picomatch(`**/${pattern}/**`, pmOpts(nocase)));
    return (file: string) => matchers.some((m) => m(file));
  });

  const matcher = ((filePath: string) => {
    const resolved =
      isAbsoluteLike(filePath) || !opts.base ? filePath : path.resolve(opts.base, filePath);
    const normalized = normalizeDrivePath(resolved);
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

import picomatch from "picomatch";
import path from "node:path";

/**
 * Shared glob engine (plan §4.2): used by rules `paths:`, skills `paths:`,
 * permission rules Read/Edit(glob), `claudeMdExcludes`, `.worktreeinclude`.
 *
 * Semantics (gitignore-flavoured, Claude Code compatible):
 * - Patterns use forward slashes; matched paths are normalized to forward slashes.
 * - A pattern without a slash matches against the basename anywhere ("*.md").
 * - A pattern with a slash is anchored to the given base (project root / cwd).
 * - `**` crosses directories; trailing `/` means "directory and everything below".
 * - Leading `//` (Claude) or absolute paths anchor to filesystem root.
 * - `~/` expands to the home directory.
 */

export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface GlobMatcher {
  (filePath: string): boolean;
  patterns: string[];
}

export function createGlobMatcher(
  patterns: string[],
  opts: { base?: string; home?: string } = {},
): GlobMatcher {
  const base = opts.base ? normalizeSlashes(path.resolve(opts.base)) : undefined;
  const home = normalizeSlashes(opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "~");

  const compiled = patterns.map((raw) => {
    let pattern = normalizeSlashes(raw.trim());
    if (!pattern) return () => false;
    let anchored = false;
    if (pattern.startsWith("~/")) {
      pattern = home.replace(/\/$/, "") + pattern.slice(1);
      anchored = true;
    } else if (pattern.startsWith("//")) {
      pattern = pattern.slice(1);
      anchored = true;
    } else if (/^([a-zA-Z]:)?\//.test(pattern)) {
      anchored = true;
    }
    if (pattern.endsWith("/")) pattern += "**";

    if (!anchored && base && pattern.includes("/")) {
      pattern = `${base.replace(/\/$/, "")}/${pattern.replace(/^\.?\//, "")}`;
      anchored = true;
    }

    const isMatch = picomatch(pattern, { dot: true, nocase: process.platform === "win32", windows: false });
    if (anchored) {
      return (file: string) => isMatch(file);
    }
    // Unanchored (no slash): match basename or any suffix path segment sequence.
    const isBaseMatch = picomatch(pattern, { dot: true, nocase: process.platform === "win32", windows: false, basename: true });
    const isDeepMatch = picomatch(`**/${pattern}`, { dot: true, nocase: process.platform === "win32", windows: false });
    return (file: string) => isBaseMatch(file) || isDeepMatch(file);
  });

  const matcher = ((filePath: string) => {
    const normalized = normalizeSlashes(path.isAbsolute(filePath) ? filePath : filePath);
    return compiled.some((m) => m(normalized));
  }) as GlobMatcher;
  matcher.patterns = patterns;
  return matcher;
}

/** Match a single relative-or-absolute file path against patterns with a base dir. */
export function matchesAny(filePath: string, patterns: string[], base?: string): boolean {
  if (patterns.length === 0) return false;
  const abs = base && !path.isAbsolute(filePath) ? path.resolve(base, filePath) : filePath;
  return createGlobMatcher(patterns, { base })(normalizeSlashes(abs));
}

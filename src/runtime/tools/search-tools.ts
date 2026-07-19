import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Search tools: Claude-named `Grep` and `Glob`.
 *
 * `Grep` prefers the ripgrep binary when present on PATH and falls back to a
 * pure-JS walker otherwise (or when forced for tests). The two engines are
 * kept aligned on ripgrep's defaults: hidden files and `.git` are skipped,
 * `.gitignore` is honored when the search path is inside a git repository,
 * explicitly named files are always searched (no glob/type filtering), and
 * output shapes match exactly (`path:line:content`, `path:count`, plain
 * paths, `--` chunk separators in context mode). `Glob` is a pure-JS walker
 * sorted by mtime. Both resolve relative paths through `getCwd()` at execute
 * time so worktree cwd swaps are honored.
 */

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB — skip larger files in the JS walker
const BINARY_SNIFF_BYTES = 8192;
export const DEFAULT_GREP_HEAD_LIMIT = 100;
export const GLOB_RESULT_CAP = 200;
const RG_TIMEOUT_MS = 30_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

export interface GrepToolOptions {
  /** Skip the ripgrep binary and always use the pure-JS fallback (for tests). */
  forceJs?: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("search aborted");
  }
}

// ---------------------------------------------------------------------------
// Gitignore handling (best effort, mirrors ripgrep defaults)
// ---------------------------------------------------------------------------

interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  matches: (rel: string) => boolean;
}

interface IgnoreScope {
  /** Directory containing the .gitignore, absolute with forward slashes. */
  dir: string;
  rules: IgnoreRule[];
}

function parseGitignore(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (line.length === 0) continue;
    // A slash (other than a trailing one) anchors the pattern to the
    // .gitignore's directory; otherwise it matches at any depth.
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const glob = anchored ? line : `**/${line}`;
    try {
      const isMatch = picomatch(glob, { dot: true, windows: false });
      rules.push({ negated, dirOnly, matches: isMatch });
    } catch {
      /* unparseable pattern — skip it, best effort */
    }
  }
  return rules;
}

function loadIgnoreScope(dirAbs: string): IgnoreScope | undefined {
  let content: string;
  try {
    content = fs.readFileSync(path.join(dirAbs, ".gitignore"), "utf8");
  } catch {
    return undefined;
  }
  const rules = parseGitignore(content);
  if (rules.length === 0) return undefined;
  return { dir: toForwardSlashes(dirAbs), rules };
}

/** Last matching rule wins; scopes are ordered shallow→deep so deeper .gitignore files take precedence. */
function isIgnored(scopes: IgnoreScope[], absForward: string, isDir: boolean): boolean {
  let ignored = false;
  for (const scope of scopes) {
    if (!absForward.startsWith(`${scope.dir}/`)) continue;
    const rel = absForward.slice(scope.dir.length + 1);
    for (const rule of scope.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.matches(rel)) ignored = !rule.negated;
    }
  }
  return ignored;
}

/** Like ripgrep, .gitignore is only honored inside a git repository. */
function findGitRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Shared file walker
// ---------------------------------------------------------------------------

interface WalkedFile {
  abs: string;
  /** Path relative to the walk base, forward slashes. */
  rel: string;
}

interface WalkOptions {
  /** Skip dot-files and dot-directories (ripgrep default). */
  skipHidden?: boolean;
  /** Honor .gitignore files when the base is inside a git repository (ripgrep default). */
  gitignore?: boolean;
}

interface WalkItem {
  dir: string;
  scopes: IgnoreScope[] | undefined;
}

function walkFiles(
  base: string,
  signal: AbortSignal | undefined,
  opts: WalkOptions = {},
): WalkedFile[] {
  const skipHidden = opts.skipHidden === true;
  let rootScopes: IgnoreScope[] | undefined;
  if (opts.gitignore === true) {
    const gitRoot = findGitRoot(base);
    if (gitRoot !== undefined) {
      rootScopes = [];
      // .gitignore files between the repo root and the search base apply too.
      const ancestors: string[] = [];
      let cur = path.resolve(base);
      while (cur !== gitRoot) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
        ancestors.unshift(cur);
      }
      for (const dir of ancestors) {
        const scope = loadIgnoreScope(dir);
        if (scope) rootScopes.push(scope);
      }
    }
  }

  const out: WalkedFile[] = [];
  const stack: WalkItem[] = [{ dir: base, scopes: rootScopes }];
  while (stack.length > 0) {
    throwIfAborted(signal);
    const item = stack.pop() as WalkItem;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip, never crash
    }
    let scopes = item.scopes;
    if (scopes !== undefined) {
      const scope = loadIgnoreScope(item.dir);
      if (scope) scopes = [...scopes, scope];
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // avoid cycles
      if (skipHidden && entry.name.startsWith(".")) continue;
      const abs = path.join(item.dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (scopes !== undefined && isIgnored(scopes, toForwardSlashes(abs), true)) continue;
        stack.push({ dir: abs, scopes });
      } else if (entry.isFile()) {
        if (scopes !== undefined && isIgnored(scopes, toForwardSlashes(abs), false)) continue;
        out.push({ abs, rel: toForwardSlashes(path.relative(base, abs)) });
      }
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** Read a file as text; returns undefined for too-large or binary files. */
function readTextFile(abs: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return undefined;
  }
  if (stat.size > MAX_FILE_SIZE) return undefined;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return undefined;
  }
  const sniff = buf.subarray(0, BINARY_SNIFF_BYTES);
  if (sniff.includes(0)) return undefined; // binary
  return buf.toString("utf8");
}

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

export type GrepMode = "content" | "files_with_matches" | "count";

export interface GrepResultDetails {
  mode: GrepMode;
  engine: "rg" | "js";
  totalEntries: number;
  returnedEntries: number;
  truncated: boolean;
}

export interface GlobResultDetails {
  totalMatches: number;
  returned: number;
  capped: boolean;
  truncated: boolean;
}

interface GrepNormalizationArgs {
  output_mode?: unknown;
  "-A"?: unknown;
  "-B"?: unknown;
  "-C"?: unknown;
  context?: unknown;
}

export function resolveGrepMode(args: { output_mode?: unknown }): GrepMode | undefined {
  const mode = args.output_mode ?? "files_with_matches";
  return mode === "content" || mode === "files_with_matches" || mode === "count"
    ? mode
    : undefined;
}

export function normalizeFiniteNonnegative(
  value: unknown,
  fallback = 0,
): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

export function resolveGrepHeadLimit(value: unknown): number | undefined {
  if (value === undefined) return DEFAULT_GREP_HEAD_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value <= 0 ? Number.POSITIVE_INFINITY : Math.floor(value);
}

export function resolveGrepContext(
  args: GrepNormalizationArgs,
  mode: GrepMode,
): { before: number; after: number } | undefined {
  if (mode !== "content") return { before: 0, after: 0 };
  const both = normalizeFiniteNonnegative(args["-C"] ?? args.context);
  if (both === undefined) return undefined;
  const before = normalizeFiniteNonnegative(args["-B"], both);
  const after = normalizeFiniteNonnegative(args["-A"], both);
  return before === undefined || after === undefined ? undefined : { before, after };
}

/** Fully resolved query shared by both engines. */
interface GrepQuery {
  pattern: string;
  mode: GrepMode;
  ignoreCase: boolean;
  /** Show line numbers in content mode (-n, default true). */
  lineNumbers: boolean;
  /** Context lines before/after each match (content mode only). */
  before: number;
  after: number;
  /** Print only the matched parts of matching lines (-o, content mode only). */
  onlyMatching: boolean;
  /** Multiline mode: . matches newlines, patterns can span lines. */
  multiline: boolean;
  glob?: string;
  type?: string;
}

/**
 * File-type filter for the JS engine, mirroring ripgrep's built-in type
 * definitions (`rg --type-list`) for common types, extensions only.
 */
const JS_FILE_TYPES: Record<string, readonly string[]> = {
  c: ["c", "h"],
  cpp: ["cpp", "hpp", "cc", "hh", "cxx", "hxx", "inl"],
  cs: ["cs"],
  css: ["css", "scss"],
  go: ["go"],
  html: ["html", "htm", "ejs"],
  java: ["java", "jsp", "jspx", "properties"],
  js: ["js", "jsx", "mjs", "cjs", "vue"],
  json: ["json", "sarif"],
  kotlin: ["kt", "kts"],
  lua: ["lua"],
  markdown: ["md", "markdown", "mdown", "mdwn", "mdx", "mkd", "mkdn"],
  md: ["md", "markdown", "mdown", "mdwn", "mdx", "mkd", "mkdn"],
  php: ["php", "php3", "php4", "php5", "php7", "php8", "pht", "phtml"],
  py: ["py", "pyi"],
  rb: ["rb", "rbw", "gemspec"],
  ruby: ["rb", "rbw", "gemspec"],
  rust: ["rs"],
  sh: ["sh", "bash", "bashrc", "zsh", "csh", "cshrc", "ksh", "kshrc", "tcsh"],
  sql: ["sql", "psql"],
  swift: ["swift"],
  toml: ["toml"],
  ts: ["ts", "tsx", "cts", "mts"],
  txt: ["txt"],
  xml: ["xml", "xsd", "xsl", "xslt", "dtd", "rng", "sch", "xhtml"],
  yaml: ["yaml", "yml"],
};

function fileExtension(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function uniqueFlags(flags: string): string {
  return Array.from(new Set(flags.split(""))).join("");
}

function withGlobalFlag(re: RegExp): RegExp {
  return re.flags.includes("g") ? re : new RegExp(re.source, `${re.flags}g`);
}

/**
 * Compile the pattern for the JS engine. Ripgrep's Rust regex accepts some
 * syntax JS does not; translate the common cases (leading inline flags like
 * `(?i)`, `(?P<name>` groups). Untranslatable regex syntax produces a clear
 * error rather than a silent literal search; patterns that are not regex
 * syntax in either engine fall back to a literal text search.
 */
function compileGrepRegex(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch {
    /* try ripgrep→JS translations below */
  }
  let translated = pattern.replace(/\(\?P</g, "(?<");
  const inline = /^\(\?([ims]+)\)/.exec(translated);
  let extraFlags = "";
  if (inline !== null) {
    extraFlags = inline[1] as string;
    translated = translated.slice(inline[0].length);
  }
  try {
    return new RegExp(translated, uniqueFlags(flags + extraFlags));
  } catch {
    /* fall through */
  }
  if (/\(\?[a-zA-Z][a-zA-Z-]*[):]/.test(pattern) || pattern.includes("(?P<")) {
    throw new Error(
      `Grep: pattern uses ripgrep regex syntax the JS fallback engine cannot run: ${pattern}. ` +
        "Rewrite it as a JS-compatible regex (e.g. use the -i parameter instead of an inline (?i) flag).",
    );
  }
  // Not valid regex syntax in either engine — search for the literal text.
  return new RegExp(escapeRegExp(pattern), flags);
}

interface RgOutcome {
  code: number;
  stdout: string;
}

/** Spawn ripgrep; resolves null when the binary is not on PATH. */
function runRipgrep(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<RgOutcome | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn("rg", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`ripgrep timed out after ${RG_TIMEOUT_MS / 1000}s`)));
    }, RG_TIMEOUT_MS);
    const onAbort = () => {
      child.kill();
      finish(() => reject(new Error("search aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", () => {
      /* drained; rg exit code drives handling */
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") finish(() => resolve(null));
      else finish(() => reject(err));
    });
    child.on("close", (code) => {
      finish(() => resolve({ code: code ?? 1, stdout }));
    });
  });
}

interface GrepResult {
  entries: string[];
  engine: "rg" | "js";
}

async function grepWithRipgrep(
  q: GrepQuery,
  searchPath: string,
  signal: AbortSignal | undefined,
): Promise<GrepResult | null> {
  const stat = fs.statSync(searchPath);
  const baseDir = stat.isDirectory() ? searchPath : path.dirname(searchPath);
  const target = stat.isDirectory() ? "." : path.basename(searchPath);

  const args = [
    "--no-config",
    "--color",
    "never",
    "--no-messages",
    "--sort",
    "path", // deterministic output, aligned with the JS engine's sorted walk
    "--path-separator",
    "/",
  ];
  if (q.ignoreCase) args.push("-i");
  if (q.glob !== undefined) args.push("--glob", q.glob);
  if (q.type !== undefined) args.push("--type", q.type);
  if (q.multiline) args.push("-U", "--multiline-dotall");
  if (q.mode === "content") {
    args.push("-H", q.lineNumbers ? "-n" : "--no-line-number");
    if (q.onlyMatching) {
      args.push("-o");
    } else {
      if (q.before > 0) args.push("-B", String(q.before));
      if (q.after > 0) args.push("-A", String(q.after));
    }
  } else if (q.mode === "files_with_matches") {
    args.push("-l");
  } else {
    args.push("-H", "-c"); // -H so single-file searches keep the "path:count" shape
  }
  args.push("-e", q.pattern, target);

  const outcome = await runRipgrep(args, baseDir, signal);
  if (outcome === null) return null; // rg not installed
  if (outcome.code !== 0 && outcome.code !== 1) return null; // rg rejected pattern/args — JS fallback
  let entries = outcome.stdout
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
    .map((l) => (l.startsWith("./") ? l.slice(2) : l));
  if (q.mode === "count") entries = entries.filter((l) => !/:0$/.test(l));
  return { entries, engine: "rg" };
}

interface MultilineMatches {
  /** 0-based indices of all lines covered by at least one match, sorted. */
  matchLines: number[];
  /** Number of matches (ripgrep counts multiline matches, not lines). */
  count: number;
  /** Per-line matched segments, for -o output. */
  segments: Array<{ line: number; text: string }>;
}

function findMultilineMatches(text: string, re: RegExp, wantSegments: boolean): MultilineMatches {
  const g = withGlobalFlag(re);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineSet = new Set<number>();
  const segments: MultilineMatches["segments"] = [];
  let count = 0;
  for (const m of text.matchAll(g)) {
    if (m[0] === "") continue; // ignore empty matches
    count++;
    const startLine = lineAt(m.index);
    const parts = m[0].split("\n");
    if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    for (let k = 0; k < parts.length; k++) {
      lineSet.add(startLine + k);
      if (wantSegments) {
        segments.push({ line: startLine + k, text: (parts[k] as string).replace(/\r$/, "") });
      }
    }
  }
  return { matchLines: Array.from(lineSet).sort((a, b) => a - b), count, segments };
}

/** Merge per-match context ranges into ripgrep-style chunks (adjacent/overlapping ranges coalesce). */
function mergeContextRanges(
  matchIdx: number[],
  before: number,
  after: number,
  lineCount: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const i of matchIdx) {
    const start = Math.max(0, i - before);
    const end = Math.min(lineCount - 1, i + after);
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function grepWithJs(
  q: GrepQuery,
  searchPath: string,
  signal: AbortSignal | undefined,
): GrepResult {
  const baseFlags = (q.ignoreCase ? "i" : "") + (q.multiline ? "ms" : "");
  const re = compileGrepRegex(q.pattern, baseFlags);

  const stat = fs.statSync(searchPath);
  const explicitFile = stat.isFile();
  let files: WalkedFile[];
  if (explicitFile) {
    files = [{ abs: searchPath, rel: toForwardSlashes(path.basename(searchPath)) }];
  } else {
    files = walkFiles(searchPath, signal, { skipHidden: true, gitignore: true });
  }

  if (q.type !== undefined) {
    const extensions = JS_FILE_TYPES[q.type];
    if (extensions === undefined) {
      throw new Error(`Grep: unrecognized file type: ${q.type}`);
    }
    // Like ripgrep, --type/--glob filters do not apply to explicitly named files.
    if (!explicitFile) files = files.filter((f) => extensions.includes(fileExtension(f.rel)));
  }
  if (q.glob !== undefined && !explicitFile) {
    const isMatch = picomatch(q.glob, { dot: true, basename: !q.glob.includes("/") });
    files = files.filter((f) => isMatch(f.rel));
  }

  const entries: string[] = [];
  let firstChunk = true; // "--" separators go between context chunks, across files too
  for (const file of files) {
    throwIfAborted(signal);
    const text = readTextFile(file.abs);
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // no phantom line after a trailing newline

    let matchIdx: number[];
    let count: number;
    let onlySegments: MultilineMatches["segments"] = [];
    if (q.multiline) {
      const found = findMultilineMatches(text, re, q.onlyMatching);
      matchIdx = found.matchLines;
      count = found.count;
      onlySegments = found.segments;
    } else {
      matchIdx = [];
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i] as string)) continue;
        matchIdx.push(i);
        if (q.mode === "files_with_matches") break;
      }
      count = matchIdx.length;
    }
    if (matchIdx.length === 0) continue;

    if (q.mode === "files_with_matches") {
      entries.push(file.rel);
      continue;
    }
    if (q.mode === "count") {
      entries.push(`${file.rel}:${count}`);
      continue;
    }

    const rel = file.rel;
    if (q.onlyMatching) {
      if (q.multiline) {
        for (const seg of onlySegments) {
          entries.push(q.lineNumbers ? `${rel}:${seg.line + 1}:${seg.text}` : `${rel}:${seg.text}`);
        }
      } else {
        const g = withGlobalFlag(re);
        for (const i of matchIdx) {
          for (const m of (lines[i] as string).matchAll(g)) {
            if (m[0] === "") continue; // only non-empty matched parts
            entries.push(q.lineNumbers ? `${rel}:${i + 1}:${m[0]}` : `${rel}:${m[0]}`);
          }
        }
      }
    } else if (q.before > 0 || q.after > 0) {
      const matchSet = new Set(matchIdx);
      for (const [start, end] of mergeContextRanges(matchIdx, q.before, q.after, lines.length)) {
        if (!firstChunk) entries.push("--");
        firstChunk = false;
        for (let ln = start; ln <= end; ln++) {
          const sep = matchSet.has(ln) ? ":" : "-";
          const content = lines[ln] as string;
          entries.push(q.lineNumbers ? `${rel}${sep}${ln + 1}${sep}${content}` : `${rel}${sep}${content}`);
        }
      }
    } else {
      for (const i of matchIdx) {
        entries.push(q.lineNumbers ? `${rel}:${i + 1}:${lines[i]}` : `${rel}:${lines[i]}`);
      }
    }
  }
  return { entries, engine: "js" };
}

export function createGrepTool(getCwd: () => string, opts: GrepToolOptions = {}): ToolDefinition {
  return defineTool({
    name: "Grep",
    label: "Grep",
    description:
      "Search file contents with a regular expression (ripgrep when available, pure-JS " +
      "fallback otherwise; both skip hidden files and honor .gitignore inside git repos). " +
      "Supports case-insensitive search, glob and file-type filters, context lines " +
      "(-A/-B/-C), multiline mode, and content / files_with_matches / count output modes.",
    parameters: Type.Object({
      pattern: Type.String({
        description: "The regular expression pattern to search for in file contents",
      }),
      path: Type.Optional(
        Type.String({
          description: "File or directory to search in (default: current working directory)",
        }),
      ),
      glob: Type.Optional(
        Type.String({ description: 'Glob to filter files, e.g. "*.ts" or "src/**/*.md"' }),
      ),
      type: Type.Optional(
        Type.String({
          description:
            'File type to search, e.g. "js", "py", "rust" (more efficient than glob for standard types)',
        }),
      ),
      "-i": Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
      "-n": Type.Optional(
        Type.Boolean({
          description:
            'Show line numbers in output (default true). Requires output_mode: "content", ignored otherwise.',
        }),
      ),
      "-A": Type.Optional(
        Type.Number({
          description:
            'Number of lines to show after each match. Requires output_mode: "content", ignored otherwise.',
        }),
      ),
      "-B": Type.Optional(
        Type.Number({
          description:
            'Number of lines to show before each match. Requires output_mode: "content", ignored otherwise.',
        }),
      ),
      "-C": Type.Optional(
        Type.Number({
          description:
            'Number of lines to show before and after each match. Requires output_mode: "content", ignored otherwise.',
        }),
      ),
      context: Type.Optional(Type.Number({ description: "Alias for -C." })),
      "-o": Type.Optional(
        Type.Boolean({
          description:
            "Print only the matched (non-empty) parts of each matching line, one match per " +
            'output line. Requires output_mode: "content", ignored otherwise.',
        }),
      ),
      multiline: Type.Optional(
        Type.Boolean({
          description:
            "Enable multiline mode where . matches newlines and patterns can span lines (default false).",
        }),
      ),
      output_mode: Type.Optional(
        StringEnum(["content", "files_with_matches", "count"] as const, {
          description:
            "content: matching lines; files_with_matches: file paths (default); count: match counts",
          default: "files_with_matches",
        }),
      ),
      head_limit: Type.Optional(
        Type.Number({
          description: "Maximum number of entries to return (default 100). Pass 0 for unlimited.",
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description: "Skip the first N entries before applying head_limit (default 0).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const searchPath = path.resolve(getCwd(), params.path ?? ".");
      if (!fs.existsSync(searchPath)) {
        throw new Error(`Grep: path does not exist: ${searchPath}`);
      }
      const mode = resolveGrepMode(params) as GrepMode;
      const resolvedContext = resolveGrepContext(params, mode) as { before: number; after: number };
      const query: GrepQuery = {
        pattern: params.pattern,
        mode,
        ignoreCase: params["-i"] === true,
        lineNumbers: params["-n"] !== false,
        before: resolvedContext.before,
        after: resolvedContext.after,
        onlyMatching: mode === "content" && params["-o"] === true,
        multiline: params.multiline === true,
        glob: params.glob,
        type: params.type,
      };
      const headLimit = resolveGrepHeadLimit(params.head_limit) as number;
      const offset = normalizeFiniteNonnegative(params.offset) as number;

      let result: GrepResult | null = null;
      if (!opts.forceJs) {
        try {
          result = await grepWithRipgrep(query, searchPath, signal);
        } catch (err) {
          if (signal?.aborted) throw err;
          result = null; // any rg failure falls back to the JS engine
        }
      }
      if (result === null) {
        result = grepWithJs(query, searchPath, signal);
      }

      const total = result.entries.length;
      const limited = Number.isFinite(headLimit)
        ? result.entries.slice(offset, offset + headLimit)
        : result.entries.slice(offset);
      let text: string;
      if (total === 0) {
        text = "No matches found";
      } else if (limited.length === 0) {
        text = `No entries at offset ${offset} (${total} total)`;
      } else {
        text = limited.join("\n");
        if (offset > 0) {
          text += `\n[Showing entries ${offset + 1}-${offset + limited.length} of ${total}]`;
        } else if (total > limited.length) {
          text += `\n[Results limited to first ${limited.length} of ${total} entries]`;
        }
      }
      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      return {
        content: [{ type: "text" as const, text: truncation.content }],
        details: {
          mode,
          engine: result.engine,
          totalEntries: total,
          returnedEntries: limited.length,
          truncated: truncation.truncated,
        } satisfies GrepResultDetails,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

export function createGlobTool(getCwd: () => string): ToolDefinition {
  return defineTool({
    name: "Glob",
    label: "Glob",
    description:
      "Find files matching a glob pattern (e.g. \"**/*.ts\", \"src/**/*.md\"). Returns " +
      "absolute paths sorted by modification time (newest first), capped at 200 results.",
    parameters: Type.Object({
      pattern: Type.String({ description: "The glob pattern to match files against" }),
      path: Type.Optional(
        Type.String({
          description: "Directory to search in (default: current working directory)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const base = path.resolve(getCwd(), params.path ?? ".");
      if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
        throw new Error(`Glob: directory does not exist: ${base}`);
      }
      const isMatch = picomatch(params.pattern, { dot: true });
      const matches: Array<{ abs: string; mtime: number }> = [];
      for (const file of walkFiles(base, signal)) {
        if (!isMatch(file.rel)) continue;
        let mtime = 0;
        try {
          mtime = fs.statSync(file.abs).mtimeMs;
        } catch {
          /* keep mtime 0 */
        }
        matches.push({ abs: file.abs, mtime });
      }
      matches.sort((a, b) => b.mtime - a.mtime);
      const capped = matches.length > GLOB_RESULT_CAP;
      const shown = matches.slice(0, GLOB_RESULT_CAP);

      let text: string;
      if (shown.length === 0) {
        text = "No files found";
      } else {
        text = shown.map((m) => m.abs).join("\n");
        if (capped) {
          text += `\n[Results capped at ${GLOB_RESULT_CAP} of ${matches.length} files]`;
        }
      }
      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      return {
        content: [{ type: "text" as const, text: truncation.content }],
        details: {
          totalMatches: matches.length,
          returned: shown.length,
          capped,
          truncated: truncation.truncated,
        } satisfies GlobResultDetails,
      };
    },
  });
}

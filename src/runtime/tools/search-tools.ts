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
 * Search tools (plan §4.8): Claude-named `Grep` and `Glob`.
 *
 * `Grep` prefers the ripgrep binary when present on PATH and falls back to a
 * pure-JS walker otherwise (or when forced for tests). `Glob` is a pure-JS
 * walker sorted by mtime. Both resolve relative paths through `getCwd()` at
 * execute time so worktree cwd swaps are honored.
 */

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB — skip larger files in the JS walker
const BINARY_SNIFF_BYTES = 8192;
const DEFAULT_HEAD_LIMIT = 100;
const GLOB_MAX_RESULTS = 200;
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
// Shared file walker
// ---------------------------------------------------------------------------

interface WalkedFile {
  /** Absolute path. */
  abs: string;
  /** Path relative to the walk base, forward slashes. */
  rel: string;
}

function walkFiles(base: string, signal: AbortSignal | undefined): WalkedFile[] {
  const out: WalkedFile[] = [];
  const stack: string[] = [base];
  while (stack.length > 0) {
    throwIfAborted(signal);
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip, never crash
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // avoid cycles
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
      } else if (entry.isFile()) {
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

type GrepMode = "content" | "files_with_matches" | "count";

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

/** Normalize an rg-printed path prefix: strip "./"/".\" and use forward slashes. */
function normalizeRgPath(p: string): string {
  return toForwardSlashes(p.replace(/^\.[\\/]/, ""));
}

interface GrepResult {
  entries: string[];
  engine: "rg" | "js";
}

async function grepWithRipgrep(
  pattern: string,
  literal: boolean,
  searchPath: string,
  mode: GrepMode,
  ignoreCase: boolean,
  glob: string | undefined,
  signal: AbortSignal | undefined,
): Promise<GrepResult | null> {
  const stat = fs.statSync(searchPath);
  const baseDir = stat.isDirectory() ? searchPath : path.dirname(searchPath);
  const target = stat.isDirectory() ? "." : path.basename(searchPath);

  const args = ["--no-config", "--color", "never", "--no-messages"];
  if (ignoreCase) args.push("-i");
  if (glob !== undefined) args.push("--glob", glob);
  if (mode === "content") args.push("-n");
  else if (mode === "files_with_matches") args.push("-l");
  else args.push("-c");
  if (literal) args.push("-F");
  args.push("-e", pattern, target);

  const outcome = await runRipgrep(args, baseDir, signal);
  if (outcome === null) return null; // rg not installed
  if (outcome.code !== 0 && outcome.code !== 1) return null; // rg rejected pattern/args — JS fallback
  const lines = outcome.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  let entries: string[];
  if (mode === "content") {
    entries = lines.map((l) => {
      const m = /^(.*?):(\d+):([\s\S]*)$/.exec(l);
      return m ? `${normalizeRgPath(m[1] as string)}:${m[2]}:${m[3]}` : l;
    });
  } else if (mode === "count") {
    entries = lines
      .map((l) => {
        const m = /^(.*?):(\d+)$/.exec(l);
        return m ? `${normalizeRgPath(m[1] as string)}:${m[2]}` : l;
      })
      .filter((l) => !/:0$/.test(l));
  } else {
    entries = lines.map(normalizeRgPath);
  }
  return { entries, engine: "rg" };
}

function grepWithJs(
  pattern: string,
  searchPath: string,
  mode: GrepMode,
  ignoreCase: boolean,
  glob: string | undefined,
  signal: AbortSignal | undefined,
): GrepResult {
  const flags = ignoreCase ? "i" : "";
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    // Invalid regex → search for the literal text instead.
    re = new RegExp(escapeRegExp(pattern), flags);
  }

  const stat = fs.statSync(searchPath);
  let files: WalkedFile[];
  if (stat.isFile()) {
    files = [{ abs: searchPath, rel: toForwardSlashes(path.basename(searchPath)) }];
  } else {
    files = walkFiles(searchPath, signal);
  }

  if (glob !== undefined) {
    const isMatch = picomatch(glob, { dot: true, basename: !glob.includes("/") });
    files = files.filter((f) => isMatch(f.rel));
  }

  const entries: string[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    const text = readTextFile(file.abs);
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!re.test(line)) continue;
      count++;
      if (mode === "content") entries.push(`${file.rel}:${i + 1}:${line}`);
      else if (mode === "files_with_matches") break;
    }
    if (count > 0) {
      if (mode === "files_with_matches") entries.push(file.rel);
      else if (mode === "count") entries.push(`${file.rel}:${count}`);
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
      "fallback otherwise). Supports case-insensitive search, a glob file filter, and " +
      "content / files_with_matches / count output modes. Invalid regexes are searched " +
      "as literal text.",
    parameters: Type.Object({
      pattern: Type.String({ description: "The regular expression to search for" }),
      path: Type.Optional(
        Type.String({
          description: "File or directory to search in (default: current working directory)",
        }),
      ),
      glob: Type.Optional(
        Type.String({ description: 'Glob to filter files, e.g. "*.ts" or "src/**/*.md"' }),
      ),
      "-i": Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
      output_mode: Type.Optional(
        StringEnum(["content", "files_with_matches", "count"] as const, {
          description:
            "content: matching lines; files_with_matches: file paths (default); count: match counts",
          default: "files_with_matches",
        }),
      ),
      head_limit: Type.Optional(
        Type.Number({ description: "Maximum number of entries to return (default 100)" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const searchPath = path.resolve(getCwd(), params.path ?? ".");
      if (!fs.existsSync(searchPath)) {
        throw new Error(`Grep: path does not exist: ${searchPath}`);
      }
      const mode: GrepMode = params.output_mode ?? "files_with_matches";
      const ignoreCase = params["-i"] === true;
      const headLimit =
        params.head_limit !== undefined && params.head_limit > 0
          ? Math.floor(params.head_limit)
          : DEFAULT_HEAD_LIMIT;

      // Pre-validate the pattern so both engines agree on literal fallback.
      let literal = false;
      try {
        new RegExp(params.pattern);
      } catch {
        literal = true;
      }

      let result: GrepResult | null = null;
      if (!opts.forceJs) {
        try {
          result = await grepWithRipgrep(
            params.pattern,
            literal,
            searchPath,
            mode,
            ignoreCase,
            params.glob,
            signal,
          );
        } catch (err) {
          if (signal?.aborted) throw err;
          result = null; // any rg failure falls back to the JS engine
        }
      }
      if (result === null) {
        result = grepWithJs(params.pattern, searchPath, mode, ignoreCase, params.glob, signal);
      }

      const total = result.entries.length;
      const limited = result.entries.slice(0, headLimit);
      let text: string;
      if (total === 0) {
        text = "No matches found";
      } else {
        text = limited.join("\n");
        if (total > limited.length) {
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
        },
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
      const capped = matches.length > GLOB_MAX_RESULTS;
      const shown = matches.slice(0, GLOB_MAX_RESULTS);

      let text: string;
      if (shown.length === 0) {
        text = "No files found";
      } else {
        text = shown.map((m) => m.abs).join("\n");
        if (capped) {
          text += `\n[Results capped at ${GLOB_MAX_RESULTS} of ${matches.length} files]`;
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
        },
      };
    },
  });
}

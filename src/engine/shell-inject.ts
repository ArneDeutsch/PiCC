import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Diagnostic } from "../types.js";
import { unicodeSafeSubprocessEnv } from "../util/env.js";

/**
 * Dynamic context injection for skill bodies:
 * - inline `` !`cmd` `` (recognized at line start or after whitespace),
 * - fenced blocks whose info string starts with `!` (the whole fence content
 *   is the script),
 * are replaced with the command's stdout (trailing newlines trimmed) BEFORE
 * the content reaches the model.
 *
 * Immunity rules: inline `` !`cmd` `` does NOT trigger inside inline code
 * spans or inside fenced code blocks other than ```! fences.
 *
 * Never throws (completeness floor): disabled execution degrades to a bracketed
 * note + diagnostic; spawn failures, non-zero exits and timeouts leave the
 * ORIGINAL literal text in place (Claude behavior) + a warning diagnostic.
 * Output is single-pass — preserved literals are never re-scanned.
 */

export interface ShellInjectionOptions {
  shell: "bash" | "powershell";
  cwd: string;
  /**
   * Claude-specific overlay (settings `env`, `CLAUDE_*` vars) layered ON TOP of
   * the inherited `process.env` — commands must still see PATH/HOME/SystemRoot.
   */
  env: Record<string, string>;
  disabled: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** `original` is the exact literal source text, restored verbatim on failure. */
type Part = string | { cmd: string; original: string };

/** Scan a single line (outside fenced blocks) for inline !`cmd`, skipping code spans. */
function scanInlineLine(line: string, parts: Part[]): void {
  let i = 0;
  let textStart = 0;
  while (i < line.length) {
    const c = line[i]!;
    // Inline injection: !` at line start or after whitespace, with a closing backtick.
    if (c === "!" && line[i + 1] === "`" && (i === 0 || /\s/.test(line[i - 1]!))) {
      const close = line.indexOf("`", i + 2);
      if (close !== -1) {
        if (i > textStart) parts.push(line.slice(textStart, i));
        parts.push({ cmd: line.slice(i + 2, close), original: line.slice(i, close + 1) });
        i = close + 1;
        textStart = i;
        continue;
      }
    }
    // Inline code span: a run of N backticks closed by the next run of exactly N.
    if (c === "`") {
      let n = 1;
      while (line[i + n] === "`") n++;
      let k = i + n;
      let end = -1;
      while (k < line.length) {
        if (line[k] === "`") {
          let m = 1;
          while (line[k + m] === "`") m++;
          if (m === n) {
            end = k + m;
            break;
          }
          k += m;
        } else {
          k++;
        }
      }
      if (end !== -1) {
        i = end; // skip the whole span verbatim — no injection inside
        continue;
      }
      i += n; // unclosed span: treat as plain text
      continue;
    }
    i++;
  }
  if (textStart < line.length) parts.push(line.slice(textStart));
}

/** Parse the body into literal text parts and commands to execute. */
function parseBody(body: string): Part[] {
  const lines = body.split(/\r?\n/);
  const parts: Part[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const info = (fence[2] ?? "").trim();
      // Find the closing fence (same char, at least as long).
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]!.trim();
        if (t.length >= marker.length && [...t].every((ch) => ch === marker[0])) {
          close = j;
          break;
        }
      }
      const end = close === -1 ? lines.length - 1 : close;
      if (info.startsWith("!")) {
        // ```! fence: the whole fence content is the script.
        const inner = lines.slice(i + 1, close === -1 ? lines.length : close);
        const extra = info.slice(1).trim(); // tolerate ```!cmd on the fence line
        const script = (extra ? extra + "\n" : "") + inner.join("\n");
        parts.push({ cmd: script, original: lines.slice(i, end + 1).join("\n") });
        if (end < lines.length - 1) parts.push("\n");
      } else {
        // Ordinary fenced block: verbatim, no inline scanning inside.
        for (let k = i; k <= end; k++) {
          parts.push(lines[k]!);
          if (k < lines.length - 1) parts.push("\n");
        }
      }
      i = end + 1;
      continue;
    }
    scanInlineLine(line, parts);
    if (i < lines.length - 1) parts.push("\n");
    i++;
  }
  return parts;
}

let cachedBash: string | undefined;
let cachedPowershell: string | undefined;

function firstExistingFile(candidates: string[]): string | undefined {
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // keep probing
    }
  }
  return undefined;
}

/**
 * Resolve the PowerShell binary: `pwsh` (PowerShell Core — the only variant on
 * POSIX) first, then Windows PowerShell's powershell.exe on Windows. When
 * neither exists we degrade to the bare platform name so the spawn fails with
 * ENOENT and preprocessShellInjection reports a clear diagnostic (never-crash
 * floor).
 */
function resolvePowershellBinary(env?: Record<string, string>): string {
  if (cachedPowershell !== undefined && env === undefined) return cachedPowershell;
  const get = (key: string): string | undefined =>
    env?.[key] ?? (process.env[key] as string | undefined);
  const isWin = process.platform === "win32";
  const pathDirs = (get("PATH") ?? get("Path") ?? "")
    .split(isWin ? ";" : ":")
    .map((d) => d.trim())
    .filter(Boolean);

  const pwshName = isWin ? "pwsh.exe" : "pwsh";
  const candidates: string[] = pathDirs.map((d) => path.join(d, pwshName));
  if (isWin) {
    const programFiles = get("ProgramFiles") ?? "C:\\Program Files";
    candidates.push(path.join(programFiles, "PowerShell", "7", "pwsh.exe"));
    for (const d of pathDirs) candidates.push(path.join(d, "powershell.exe"));
    const systemRoot = get("SystemRoot") ?? get("SYSTEMROOT") ?? "C:\\Windows";
    candidates.push(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  }
  const resolved = firstExistingFile(candidates) ?? (isWin ? "powershell" : "pwsh");
  if (env === undefined) cachedPowershell = resolved;
  return resolved;
}

/**
 * Resolve the binary to spawn for a given shell (exported for tests/engine).
 *
 * Windows quirk: a bare `bash` on PATH usually resolves to the System32 WSL
 * stub, which fails when no WSL distro is installed. Prefer Git Bash's
 * bash.exe when it can be located; otherwise fall back to plain `bash`.
 *
 * "powershell" prefers pwsh (PowerShell Core) and falls back to Windows
 * PowerShell — see resolvePowershellBinary.
 */
export function resolveShellBinary(
  shell: "bash" | "powershell",
  env?: Record<string, string>,
): string {
  if (shell === "powershell") return resolvePowershellBinary(env);
  if (process.platform !== "win32") return "bash";
  if (cachedBash !== undefined && env === undefined) return cachedBash;

  const get = (key: string): string | undefined =>
    env?.[key] ?? (process.env[key] as string | undefined);
  const candidates: string[] = [];
  const programFiles = get("ProgramFiles") ?? "C:\\Program Files";
  const programFilesX86 = get("ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
  const localAppData = get("LOCALAPPDATA");
  candidates.push(path.join(programFiles, "Git", "bin", "bash.exe"));
  candidates.push(path.join(programFilesX86, "Git", "bin", "bash.exe"));
  if (localAppData) candidates.push(path.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  // PATH scan, skipping the WSL stub locations (System32 / WindowsApps).
  const pathVar = get("PATH") ?? get("Path") ?? "";
  for (const dir of pathVar.split(";")) {
    const d = dir.trim();
    if (!d) continue;
    const lower = d.toLowerCase();
    if (lower.includes("system32") || lower.includes("windowsapps")) continue;
    candidates.push(path.join(d, "bash.exe"));
  }
  const resolved = firstExistingFile(candidates) ?? "bash";
  if (env === undefined) cachedBash = resolved;
  return resolved;
}

/**
 * Concrete Git Bash path for Pi's `shellPath` options on Windows (never the
 * System32 WSL stub, which fails with WSL_E_DEFAULT_DISTRO_NOT_FOUND when no
 * distro is installed). Returns undefined when Pi's own default is fine
 * (POSIX, or no Git Bash found to pin).
 */
export function resolveGitBashPath(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const bash = resolveShellBinary("bash");
  return bash !== "bash" ? bash : undefined;
}

/**
 * True when the harness's pinned shell (Git Bash / MSYS) resolves path strings in
 * a DIFFERENT namespace than its native Node file tools (Read/Grep/Glob) — i.e. on
 * Windows with a real Git Bash pinned. In that split a bare `/tmp/...` written via
 * the Bash tool is resolved drive-relative by the native tools and not found.
 *
 * Deliberately false for bare-`bash`/WSL (no Git Bash pinned): those live in yet
 * another namespace where the forward-slash drive-letter contract does not hold, so
 * the harness withholds the Windows note there. Uses the cached `resolveGitBashPath`,
 * so it is free on the per-turn system-prompt hot path.
 *
 * `platform` is injectable (like `toNativeSafeTempForm`), but only the FALSE branch
 * is fully unit-testable without a real OS: passing a non-win32 `platform` short-circuits
 * to false regardless of host. The TRUE branch also requires `resolveGitBashPath()` to
 * find a pinned Git Bash, and that reads the real `process.platform` (win32) — so the
 * true branch is only reachable on an actual win32 host, not by injecting `platform`.
 */
export function shellNamespaceDiffersFromNative(platform?: NodeJS.Platform): boolean {
  return (platform ?? process.platform) === "win32" && resolveGitBashPath() !== undefined;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | string | null;
  timedOut: boolean;
  spawnError?: string;
}

function runCommand(cmd: string, opts: ShellInjectionOptions): Promise<RunResult> {
  const bin = resolveShellBinary(opts.shell, opts.env);
  const args =
    opts.shell === "powershell" ? ["-NoProfile", "-Command", cmd] : ["-c", cmd];
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        args,
        {
          cwd: opts.cwd,
          // Inherit the full harness env; opts.env is only the Claude overlay.
          env: unicodeSafeSubprocessEnv({ ...process.env, ...opts.env }),
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ ok: true, stdout, stderr, code: 0, timedOut: false });
            return;
          }
          const anyErr = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
          resolve({
            ok: false,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            code: anyErr.code ?? null,
            timedOut: anyErr.killed === true,
            spawnError: typeof anyErr.code === "string" ? err.message : undefined,
          });
        },
      );
    } catch (err) {
      // execFile itself should not throw, but the completeness floor says never trust that.
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        code: null,
        timedOut: false,
        spawnError: (err as Error).message,
      });
    }
  });
}

function firstLine(s: string): string {
  return s.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** Compact single-line display form of a (possibly multi-line) command. */
function displayCmd(cmd: string): string {
  return cmd.trim().replace(/\s*\r?\n\s*/g, "; ");
}

/**
 * Preprocess `` !`cmd` `` inline occurrences and ```! fenced blocks in a skill
 * body, replacing them with command output. Sequential execution, input order.
 */
export async function preprocessShellInjection(
  body: string,
  opts: ShellInjectionOptions,
): Promise<{ text: string; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const parts = parseBody(body);
  if (!parts.some((p) => typeof p !== "string")) {
    return { text: body, diagnostics };
  }

  const out: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      out.push(part);
      continue;
    }
    const shown = displayCmd(part.cmd);
    if (opts.disabled) {
      out.push(`[shell execution disabled: ${shown}]`);
      diagnostics.push({
        severity: "info",
        message: `Skill shell execution disabled; skipped command: ${shown}`,
      });
      continue;
    }
    const result = await runCommand(part.cmd, opts);
    if (result.ok) {
      out.push(result.stdout.replace(/[\r\n]+$/, ""));
      continue;
    }
    const codeStr = result.timedOut
      ? "timeout"
      : typeof result.code === "number"
        ? String(result.code)
        : (result.code ?? "?").toString();
    const note =
      result.code === "ENOENT" && opts.shell === "powershell"
        ? "PowerShell not found (tried pwsh and powershell); install PowerShell or use shell: bash"
        : firstLine(result.stderr) ||
          (result.spawnError ? firstLine(result.spawnError) : "") ||
          (result.timedOut ? `timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : "no stderr output");
    // Claude behavior: a failed/timed-out command leaves the literal
    // placeholder text in place. Single-pass output — it is never re-scanned.
    out.push(part.original);
    diagnostics.push({
      severity: "warning",
      message: `Shell injection command failed (exit ${codeStr}): ${shown} — ${note}; literal text preserved`,
    });
  }
  return { text: out.join(""), diagnostics };
}

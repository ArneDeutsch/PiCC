/**
 * Subprocess environment defaults for cross-platform Unicode safety.
 *
 * On Windows, child processes (notably Python) default their stdout/stderr to
 * the legacy code page (cp1252 "charmap"), which cannot encode common Unicode
 * the model routinely prints (e.g. `→` U+2192), producing UnicodeEncodeError.
 * A misconfigured POSIX locale (LANG=C) has the same failure mode. Forcing
 * UTF-8 for interpreter I/O makes tool output deterministic everywhere.
 *
 * We only set a variable when it is not already provided (by process.env or the
 * project's settings `env`), so an explicit project/user choice always wins.
 */
export function unicodeSafeSubprocessEnv(
  base: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = v;
  }
  const setDefault = (key: string, value: string) => {
    if (out[key] === undefined || out[key] === "") out[key] = value;
  };
  // Python: make stdio and default file encoding UTF-8.
  setDefault("PYTHONIOENCODING", "utf-8");
  setDefault("PYTHONUTF8", "1");
  return out;
}

/**
 * Convert a resolved absolute path into the form that both the pinned Git Bash
 * (as a redirect target) and the native Node file tools (`Read`/`Grep`/`Glob`)
 * resolve to the *same* real path.
 *
 * On Windows the harness shell is a POSIX-emulation shell (Git Bash/MSYS): a bare
 * `/tmp/...` string denotes the shell's mount to Git Bash but a drive-relative
 * `F:\tmp\...` to native Node — the same string, two different real files. The
 * forward-slash drive-letter form (`C:/Users/A/Temp`) is a valid Git Bash redirect
 * target AND is resolved identically by the native Pi Read tool, so both namespaces
 * agree. On every other platform the shell and native tools already share one
 * namespace, so the path is returned unchanged.
 *
 * Pure and side-effect free; `platform` is injectable (default `process.platform`)
 * mirroring `resolveShellBinary`'s seam. `shell` is deliberately not a parameter:
 * the forward-slash form is valid for Git Bash, PowerShell, and native Node alike.
 */
export function toNativeSafeTempForm(
  p: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return p.replace(/\\/g, "/");
  return p;
}

/**
 * Injectable I/O seam for {@link computeSessionScratchDir} — the real
 * `os.tmpdir` / `fs.mkdtempSync` / `fs.realpathSync` / `path.join` / `process.env`
 * / `process.platform` are passed in by the composition root, and stubbed in tests
 * so the win32 branch and the realpath→transform ORDER are reachable on any host.
 */
export interface ScratchDirIo {
  env: NodeJS.ProcessEnv;
  tmpdir: () => string;
  /** Create a fresh scratch dir under `prefix`; returns its (possibly symlinked) path. */
  mkdtemp: (prefix: string) => string;
  /** Resolve symlinks to the canonical on-disk path (may differ from `mkdtemp`'s result). */
  realpath: (p: string) => string;
  join: (a: string, b: string) => string;
  platform: NodeJS.Platform;
}

/**
 * Compute the per-session native-safe scratch dir path.
 *
 * Order is load-bearing and is the thing the wiring test locks:
 *   root = CLAUDE_CODE_TMPDIR || tmpdir()   (honor Claude Code's relocation knob)
 *   → mkdtemp(join(root, "picc-scratch-"))  (unique, unpredictable dir)
 *   → realpath(...)                          (canonicalize FIRST — Windows temp is
 *                                             often a short/symlinked path)
 *   → toNativeSafeTempForm(..., platform)    (slash-transform LAST, so the win32
 *                                             backslash form realpath returns is the
 *                                             thing that gets forward-slashed).
 *
 * Applying the slash transform BEFORE realpath would feed realpath a
 * forward-slashed path and then return the raw backslash canonical path unchanged —
 * silently defeating the fix. Pure aside from the injected I/O.
 */
export function computeSessionScratchDir(io: ScratchDirIo): string {
  const root = io.env.CLAUDE_CODE_TMPDIR || io.tmpdir();
  const created = io.mkdtemp(io.join(root, "picc-scratch-"));
  const real = io.realpath(created);
  return toNativeSafeTempForm(real, io.platform);
}

/**
 * Apply the same defaults to the harness process env once at startup, so every
 * child process — including subagent bash tools built by the Pi SDK, which we do
 * not spawn ourselves — inherits them. Existing values are never overwritten.
 */
export function applyUnicodeSafeProcessEnv(): void {
  if (!process.env.PYTHONIOENCODING) process.env.PYTHONIOENCODING = "utf-8";
  if (!process.env.PYTHONUTF8) process.env.PYTHONUTF8 = "1";
}

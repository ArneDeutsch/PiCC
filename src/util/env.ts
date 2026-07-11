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
 * Apply the same defaults to the harness process env once at startup, so every
 * child process — including subagent bash tools built by the Pi SDK, which we do
 * not spawn ourselves — inherits them. Existing values are never overwritten.
 */
export function applyUnicodeSafeProcessEnv(): void {
  if (!process.env.PYTHONIOENCODING) process.env.PYTHONIOENCODING = "utf-8";
  if (!process.env.PYTHONUTF8) process.env.PYTHONUTF8 = "1";
}

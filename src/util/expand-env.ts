/**
 * Deterministic `${VAR}` / `${VAR:-default}` interpolation against the caller's
 * bounded environment snapshot. The optional unset callback is caller-owned.
 * Direct appends intentionally avoid replacement-string APIs, which reinterpret
 * `$&`, `$'`, and related sequences in environment-provided values.
 */
export function expandEnvVars(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  onUnset?: (name: string) => void,
  maxChars: number = Number.POSITIVE_INFINITY,
): string {
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;
  let result = "";
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    result += value.slice(offset, match.index);
    const name = match[1]!;
    const current = Object.hasOwn(env, name) ? env[name] : undefined;
    if (match[2] !== undefined) result += current !== undefined ? current : (match[3] ?? "");
    else if (current === undefined) {
      onUnset?.(name);
      result += match[0];
    } else result += current;
    if (result.length > maxChars) return result.slice(0, maxChars + 1);
    offset = match.index + match[0].length;
  }
  result += value.slice(offset);
  return result.length > maxChars ? result.slice(0, maxChars + 1) : result;
}

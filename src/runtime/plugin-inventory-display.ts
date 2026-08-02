const SOURCE_KEYS = [
  "kind", "value", "repo", "ref", "url", "path", "localPath", "package", "version",
  "registry", "sha", "hostPattern", "pathPattern",
] as const;

type SourceKey = typeof SOURCE_KEYS[number];
const MAX_SOURCE_VALUE = 512;

function clean(value: string): string | undefined {
  const normalized = value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "�")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .normalize("NFKC")
    .trim();
  if (normalized.length === 0) return undefined;
  return Array.from(normalized).slice(0, MAX_SOURCE_VALUE).join("");
}

function safeUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) return undefined;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function safeRelativeSource(value: string, raw: string): string | undefined {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw) || /[\\=:]/u.test(value) || /^(?:[A-Za-z]:|[\\/~])/u.test(value)) return undefined;
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  if (normalized.length === 0 || normalized.startsWith("./")) return undefined;
  const segments = normalized.split("/");
  if (segments.some((part) => part === "" || part === "." || part === ".." || !/^[A-Za-z0-9_@+.-]+$/u.test(part) || /^(?:authorization|password|passwd|token|secret|credential|api[-_.]?key)$/iu.test(part))) return undefined;
  return segments.join("/");
}

function safeSourceValue(key: SourceKey, raw: string): string {
  const value = clean(raw);
  if (value === undefined) return "<redacted>";
  if (key === "url" || key === "registry") return safeUrl(value) ?? "<redacted>";
  if (key === "path" || key === "localPath" || key === "value") return safeRelativeSource(value, raw) ?? "<redacted>";
  if (key === "repo" && (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) || value.split("/").some((part) => part === "." || part === ".."))) return "<redacted>";
  if ((key === "kind" || key === "sha") && !/^[A-Za-z0-9._+-]+$/u.test(value)) return "<redacted>";
  if (key === "package" && (!/^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/u.test(value) || value.split("/").some((part) => part === "." || part === ".."))) return "<redacted>";
  if (key === "version" && !/^[A-Za-z0-9._+~^<>=|* -]+$/u.test(value)) return "<redacted>";
  if ((key === "ref" || key === "hostPattern" || key === "pathPattern") && /[\\\s:=]/u.test(value)) return "<redacted>";
  return value;
}

/** Displays only the allowlisted, snapshot-projected marketplace source fields. */
export function formatPluginInventoryStructuredSource(source: Readonly<Record<string, string>>): string {
  const fields: string[] = [];
  for (const key of SOURCE_KEYS) {
    if (typeof source[key] !== "string") continue;
    fields.push(`${key}=${safeSourceValue(key, source[key]!)}`);
  }
  return fields.length === 0 ? "none" : fields.join(", ");
}

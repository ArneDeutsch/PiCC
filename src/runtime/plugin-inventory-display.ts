const SOURCE_KEYS = [
  "kind", "value", "repo", "ref", "url", "path", "localPath", "package", "version",
  "registry", "sha", "hostPattern", "pathPattern",
] as const;

type SourceKey = typeof SOURCE_KEYS[number];
const MAX_SOURCE_VALUE = 512;
const MAX_DECODE_INPUT = 2_048;
const MAX_DECODE_OUTPUT = 4_096;
const CREDENTIAL_KEY_SOURCE = String.raw`(?:authorization|proxy[-_.\s]?authorization|passwords?|passwd|tokens?|secrets?|client[-_.\s]secret|credentials?|api[-_.\s]keys?)`;
const CREDENTIAL_KEY = new RegExp(`^${CREDENTIAL_KEY_SOURCE}$`, "iu");
const CREDENTIAL_FIELD = new RegExp(String.raw`(?:^|[^\p{L}\p{N}_])['"]?${CREDENTIAL_KEY_SOURCE}['"]?\s*(?::|=|\s+(?=['"]|\S))\s*['"]?\S`, "iu");

function clean(value: string): string | undefined {
  if (value.length > MAX_DECODE_INPUT) return undefined;
  const normalized = value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, "�")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .normalize("NFKC")
    .trim();
  if (normalized.length === 0 || Array.from(normalized).length > MAX_SOURCE_VALUE) return undefined;
  return normalized;
}

function safeDecode(value: string): string | undefined {
  if (value.length > MAX_DECODE_INPUT) return undefined;
  try {
    let decoded = value;
    for (let pass = 0; pass < 3 && /%[0-9A-Fa-f]{2}/u.test(decoded); pass += 1) {
      decoded = decodeURIComponent(decoded);
      if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(decoded)) return undefined;
    }
    if (decoded.includes("%")) return undefined;
    decoded = decoded.normalize("NFKC");
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(decoded)) return undefined;
    return decoded.length <= MAX_DECODE_OUTPUT ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function hasCredentialSegments(value: string): boolean {
  if (CREDENTIAL_FIELD.test(value)) return true;
  const segments = value.split(/[\\/&=#?]/u).filter(Boolean);
  if (segments.some((segment) => CREDENTIAL_KEY.test(segment) || CREDENTIAL_FIELD.test(segment))) return true;
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (/^(?:api\.keys?|client\.secrets?|passwords?\.values?|passwd\.values?)$/iu.test(`${segments[index]}.${segments[index + 1]}`)) return true;
  }
  return segments.some((segment) => /^(?:api[._-]keys?|client[._-]secrets?|passwords?[._-]values?|passwd[._-]values?)$/iu.test(segment));
}

function safeUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) return undefined;
    const path = safeDecode(parsed.pathname);
    if (path === undefined || path.includes("=") || hasCredentialSegments(path)) return undefined;
    parsed.pathname = path;
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
  if ((key === "url" || key === "registry" || key === "ref" || key === "hostPattern" || key === "pathPattern")
    && /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(raw)) return "<redacted>";
  const cleaned = clean(raw);
  if (cleaned === undefined) return "<redacted>";
  if (key === "url" || key === "registry") return safeUrl(cleaned) ?? "<redacted>";
  const value = safeDecode(cleaned);
  if (value === undefined || hasCredentialSegments(value)) return "<redacted>";
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

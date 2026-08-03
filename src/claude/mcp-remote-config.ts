import { expandEnvVars } from "../util/expand-env.js";

export type RemoteMcpTransportKind = "http" | "sse";
export type RemoteMcpConfiguredType = "http" | "streamable-http" | "sse";

export interface RemoteMcpSseDeprecation {
  deprecated: true;
  replacement: "http";
}

export interface RawRemoteMcpFields {
  configuredType: RemoteMcpConfiguredType;
  transportKind: RemoteMcpTransportKind;
  rawUrl: string;
  /** Inert original shape. Header/helper fields are not inspected before admission. */
  rawEntry?: Record<string, unknown>;
  /** Empty before admission; retained for already-materialized runtime inputs. */
  rawHeaders: Record<string, string>;
  sseDeprecation?: RemoteMcpSseDeprecation;
}

export interface ResolvedRemoteMcpFields extends RawRemoteMcpFields {
  url: string;
  headers: Record<string, string>;
}

export interface RemoteMcpWorkHooks {
  onHeaderValidation?: () => void;
  onHeadersConstruction?: () => void;
  onHelperInspection?: () => void;
  onMaterialization?: () => void;
}

export type ParseRemoteMcpFieldsResult =
  | { kind: "not-remote" }
  | { kind: "supported"; fields: RawRemoteMcpFields; diagnostics: string[] }
  | {
      kind: "not-configured";
      configuredType: RemoteMcpConfiguredType;
      diagnostics: [];
    }
  | { kind: "skipped"; diagnostics: string[] };

export type ResolveRemoteMcpFieldsResult =
  | { kind: "resolved"; fields: ResolvedRemoteMcpFields; diagnostics: string[] }
  | { kind: "skipped"; diagnostics: string[] };

const SUPPORTED_TYPES = new Set<RemoteMcpConfiguredType>(["http", "streamable-http", "sse"]);
const MAX_URL_CHARS = 8192;
const MAX_HEADER_ENTRIES = 64;
const MAX_HEADER_NAME_CHARS = 256;
const MAX_HEADER_VALUE_CHARS = 8192;

const RESERVED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function diagnostic(serverName: string, sourceLabel: string, reason: string): string {
  return `MCP server ${JSON.stringify(serverName)} in ${sourceLabel} ${reason}; server skipped`;
}

function validateAndCopyHeaders(
  value: unknown,
  serverName: string,
  sourceLabel: string,
  hooks?: RemoteMcpWorkHooks,
): { headers: Record<string, string> } | { diagnostic: string } {
  hooks?.onHeaderValidation?.();
  if (!isPlainRecord(value)) {
    return {
      diagnostic: diagnostic(
        serverName,
        sourceLabel,
        'has invalid "headers" (must be a plain object with string values)',
      ),
    };
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_HEADER_ENTRIES) {
    return {
      diagnostic: diagnostic(
        serverName,
        sourceLabel,
        `has too many header entries (maximum ${MAX_HEADER_ENTRIES})`,
      ),
    };
  }

  const headers = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const name = entry[0];
    const valueAtEntry = entry[1];
    const position = index + 1;
    if (typeof valueAtEntry !== "string") {
      return {
        diagnostic: diagnostic(
          serverName,
          sourceLabel,
          `has a non-string header value at entry ${position}`,
        ),
      };
    }
    if (name.length > MAX_HEADER_NAME_CHARS) {
      return {
        diagnostic: diagnostic(
          serverName,
          sourceLabel,
          `has an over-length header name at entry ${position} (maximum ${MAX_HEADER_NAME_CHARS} characters)`,
        ),
      };
    }
    if (valueAtEntry.length > MAX_HEADER_VALUE_CHARS) {
      return {
        diagnostic: diagnostic(
          serverName,
          sourceLabel,
          `has an over-length header value at entry ${position} (maximum ${MAX_HEADER_VALUE_CHARS} characters)`,
        ),
      };
    }
    if (name.includes("\r") || name.includes("\n") || valueAtEntry.includes("\r") || valueAtEntry.includes("\n")) {
      return {
        diagnostic: diagnostic(
          serverName,
          sourceLabel,
          `has a header containing a line break at entry ${position}`,
        ),
      };
    }

    const normalizedName = name.toLowerCase();
    if (seen.has(normalizedName)) {
      return {
        diagnostic: diagnostic(
          serverName,
          sourceLabel,
          `has a case-insensitive duplicate header at entry ${position}`,
        ),
      };
    }
    if (RESERVED_HEADERS.has(normalizedName)) {
      return {
        diagnostic: diagnostic(
          serverName,
          sourceLabel,
          `has a reserved transport-owned header at entry ${position}`,
        ),
      };
    }
    try {
      hooks?.onHeadersConstruction?.();
      new Headers([[name, valueAtEntry]]);
    } catch {
      return {
        diagnostic: diagnostic(
          serverName,
          sourceLabel,
          `has invalid header syntax at entry ${position}`,
        ),
      };
    }
    seen.add(normalizedName);
    headers[name] = valueAtEntry;
  }
  return { headers };
}

export function parseRemoteMcpFields(
  rawEntry: unknown,
  serverName: string,
  sourceLabel: string,
  options: { deferPostAdmission?: boolean } = {},
): ParseRemoteMcpFieldsResult {
  if (!isPlainRecord(rawEntry)) return { kind: "not-remote" };

  const configured = rawEntry.type;
  const hasUrl = Object.hasOwn(rawEntry, "url");
  if (configured === undefined && !hasUrl) return { kind: "not-remote" };
  if (configured === "stdio") return { kind: "not-remote" };

  if (configured === "ws") {
    return {
      kind: "skipped",
      diagnostics: [
        diagnostic(serverName, sourceLabel, 'uses unsupported WebSocket transport "ws"'),
      ],
    };
  }

  if (configured === undefined) {
    return {
      kind: "skipped",
      diagnostics: [
        diagnostic(
          serverName,
          sourceLabel,
          'has a "url" but no explicit remote "type" (use "http", "streamable-http", or "sse")',
        ),
      ],
    };
  }

  if (typeof configured !== "string" || !SUPPORTED_TYPES.has(configured as RemoteMcpConfiguredType)) {
    if (!hasUrl) return { kind: "not-remote" };
    return {
      kind: "skipped",
      diagnostics: [diagnostic(serverName, sourceLabel, "uses an unsupported explicit remote transport")],
    };
  }

  const configuredType = configured as RemoteMcpConfiguredType;
  if (!hasUrl || typeof rawEntry.url !== "string") {
    return {
      kind: "skipped",
      diagnostics: [diagnostic(serverName, sourceLabel, 'is missing required string "url"')],
    };
  }
  if (rawEntry.url.length === 0) {
    return { kind: "not-configured", configuredType, diagnostics: [] };
  }
  let rawHeaders = Object.create(null) as Record<string, string>;
  if (options.deferPostAdmission !== true) {
    if (Object.hasOwn(rawEntry, "headersHelper")) {
      return {
        kind: "skipped",
        diagnostics: [diagnostic(serverName, sourceLabel, 'uses deferred dynamic field "headersHelper"')],
      };
    }
    const headerResult = validateAndCopyHeaders(
      rawEntry.headers === undefined ? Object.create(null) : rawEntry.headers,
      serverName,
      sourceLabel,
    );
    if ("diagnostic" in headerResult) return { kind: "skipped", diagnostics: [headerResult.diagnostic] };
    rawHeaders = headerResult.headers;
  }
  const transportKind: RemoteMcpTransportKind = configuredType === "sse" ? "sse" : "http";
  const fields: RawRemoteMcpFields = {
    configuredType,
    transportKind,
    rawUrl: rawEntry.url,
    rawEntry,
    rawHeaders,
  };
  if (configuredType === "sse") {
    fields.sseDeprecation = { deprecated: true, replacement: "http" };
  }
  return { kind: "supported", fields, diagnostics: [] };
}

export function resolveRemoteMcpFields(
  raw: RawRemoteMcpFields,
  env: NodeJS.ProcessEnv,
  onUnset: ((name: string) => void) | undefined,
  serverName: string,
  sourceLabel: string,
  hooks?: RemoteMcpWorkHooks,
): ResolveRemoteMcpFieldsResult {
  hooks?.onMaterialization?.();
  const rawEntry = raw.rawEntry;
  hooks?.onHelperInspection?.();
  if (rawEntry !== undefined && Object.hasOwn(rawEntry, "headersHelper")) {
    return {
      kind: "skipped",
      diagnostics: [diagnostic(serverName, sourceLabel, 'uses deferred dynamic field "headersHelper"')],
    };
  }
  const rawHeaderResult = validateAndCopyHeaders(
    rawEntry === undefined
      ? raw.rawHeaders
      : rawEntry.headers === undefined ? Object.create(null) : rawEntry.headers,
    serverName,
    sourceLabel,
    hooks,
  );
  if ("diagnostic" in rawHeaderResult) return { kind: "skipped", diagnostics: [rawHeaderResult.diagnostic] };

  const unsetNames = new Set<string>();
  const reportUnset = (name: string): void => {
    onUnset?.(name);
    unsetNames.add(name);
  };
  const url = expandEnvVars(raw.rawUrl, env, reportUnset);
  const expandedHeaders = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(rawHeaderResult.headers)) {
    expandedHeaders[name] = expandEnvVars(value, env, reportUnset);
  }

  if (url.length > MAX_URL_CHARS) {
    return {
      kind: "skipped",
      diagnostics: [
        diagnostic(
          serverName,
          sourceLabel,
          `has an over-length expanded URL (maximum ${MAX_URL_CHARS} characters)`,
        ),
      ],
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      kind: "skipped",
      diagnostics: [diagnostic(serverName, sourceLabel, "has a malformed expanded URL")],
    };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      kind: "skipped",
      diagnostics: [diagnostic(serverName, sourceLabel, "uses a non-HTTP(S) URL scheme")],
    };
  }
  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    return {
      kind: "skipped",
      diagnostics: [diagnostic(serverName, sourceLabel, "has credentials in its URL")],
    };
  }

  const headerResult = validateAndCopyHeaders(expandedHeaders, serverName, sourceLabel, hooks);
  if ("diagnostic" in headerResult) {
    return { kind: "skipped", diagnostics: [headerResult.diagnostic] };
  }

  return {
    kind: "resolved",
    fields: { ...raw, url, headers: headerResult.headers },
    diagnostics: Array.from(unsetNames, (name) =>
      diagnostic(serverName, sourceLabel, `references unset environment variable ${JSON.stringify(name)}`)
        .replace("; server skipped", "; literal retained"),
    ),
  };
}

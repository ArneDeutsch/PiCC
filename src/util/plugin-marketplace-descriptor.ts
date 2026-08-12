import type {
  PluginMarketplacePolicyDescriptor,
  PluginMarketplaceRegistrationSource,
  PluginMarketplaceSettingsDescriptorObservation,
  Scope,
} from "../types.js";

const MAX_STRING = 4096;
const MAX_PATTERN = 512;
const MAX_NAME = 128;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const SCP_GIT = /^git@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):([A-Za-z0-9._~/-]+)$/;

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function text(value: unknown, maximum = MAX_STRING): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function exactKeys(raw: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(raw).every((key) => keys.includes(key));
}

function portableRelative(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || /^(?:\\\\|\/\/)/.test(value)) return false;
  const parts = value.replaceAll("\\", "/").replace(/^\.\//, "").split("/");
  return parts.length > 0 && !parts.some((part) => part === "" || part === "." || part === ".." || part.includes(":") || /[<>"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part));
}

function safeRef(value: string): boolean {
  return value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes("..") && !value.includes("//") && !value.endsWith("/") && !value.endsWith(".") && !value.endsWith(".lock");
}

function safeHierarchicalUrl(value: string): { safe: boolean; host?: string } {
  try {
    const parsed = new URL(value);
    return /^[A-Za-z][A-Za-z0-9+.-]*:$/.test(parsed.protocol) && parsed.host !== "" && parsed.username === "" &&
      parsed.password === "" && parsed.search === "" && parsed.hash === ""
      ? { safe: true, host: parsed.hostname }
      : { safe: false };
  } catch {
    return { safe: false };
  }
}

function safeGithubRepo(value: string): boolean {
  const segments = value.split("/");
  return segments.length === 2 && GITHUB_OWNER.test(segments[0]!) && GITHUB_REPOSITORY.test(segments[1]!) &&
    segments[1] !== "." && segments[1] !== "..";
}

function safeGitLocation(value: string): boolean {
  const scp = SCP_GIT.exec(value);
  if (scp !== null) return portableRelative(scp[2]!);
  if (!safeHierarchicalUrl(value).safe) return false;
  try {
    const parsed = new URL(value);
    return ["git:", "http:", "https:", "ssh:"].includes(parsed.protocol) && parsed.pathname !== "" && parsed.pathname !== "/";
  } catch { return false; }
}

function redactedUrl(value: string): { value: string; ambiguous: boolean } {
  if (safeGitLocation(value)) return { value, ambiguous: false };
  return { value: "<redacted-url>", ambiguous: true };
}

function matchKey(descriptor: PluginMarketplaceRegistrationSource | PluginMarketplacePolicyDescriptor): string {
  return JSON.stringify(descriptor);
}

function normalizedRawDescriptor(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const kind = own(raw, "kind");
  if (typeof kind !== "string") return undefined;
  const allowed = kind === "github" ? ["kind", "repo", "ref"]
    : kind === "git" ? ["kind", "url", "ref"]
    : kind === "url" ? ["kind", "url"]
    : kind === "directory" || kind === "file" ? ["kind", "path", "localPath"]
    : kind === "hostPattern" ? ["kind", "hostPattern"]
    : kind === "pathPattern" ? ["kind", "pathPattern"]
    : undefined;
  if (allowed === undefined || !exactKeys(raw, allowed)) return undefined;
  if ((kind === "directory" || kind === "file") && own(raw, "path") !== own(raw, "localPath")) return undefined;
  const converted: Record<string, unknown> = { source: kind };
  for (const key of ["repo", "url", "ref", "path", "hostPattern", "pathPattern"] as const) {
    if (own(raw, key) !== undefined) converted[key] = own(raw, key);
  }
  return converted;
}

function registrationSource(rawRecord: unknown, scope?: Scope): PluginMarketplaceSettingsDescriptorObservation {
  let raw: Record<string, unknown> | undefined;
  let requestedValidity: unknown;
  if (plain(rawRecord) && own(rawRecord, "validity") !== undefined) {
    if (!exactKeys(rawRecord, ["descriptor", "validity", "matchKey", "indeterminate"])) return { validity: "invalid" };
    requestedValidity = own(rawRecord, "validity");
    if (requestedValidity !== "valid" && requestedValidity !== "redacted" && requestedValidity !== "invalid") return { validity: "invalid" };
    if (requestedValidity === "invalid") return { validity: "invalid" };
    const descriptor = own(rawRecord, "descriptor");
    raw = plain(descriptor) ? normalizedRawDescriptor(descriptor) : undefined;
  } else if (plain(rawRecord) && plain(own(rawRecord, "source"))) {
    if (own(rawRecord, "autoUpdate") !== undefined && typeof own(rawRecord, "autoUpdate") !== "boolean") return { validity: "invalid" };
    const selected = own(rawRecord, "source") as Record<string, unknown>;
    if (own(selected, "skipLfs") !== undefined && typeof own(selected, "skipLfs") !== "boolean") return { validity: "invalid" };
    raw = Object.fromEntries(Object.entries(selected).filter(([key]) => key !== "skipLfs"));
  }
  if (raw === undefined) return { validity: "invalid" };

  const kind = own(raw, "source");
  const optional = (key: string): string | undefined => own(raw!, key) === undefined ? undefined : text(own(raw!, key), 256);
  const optionalValid = (key: string): boolean => own(raw!, key) === undefined || optional(key) !== undefined;
  const rawRef = optional("ref");
  const refUnsafe = rawRef !== undefined && !safeRef(rawRef);
  const ref = rawRef === undefined ? undefined : refUnsafe ? "<redacted-ref>" : rawRef;
  let descriptor: PluginMarketplaceRegistrationSource | undefined;
  let ambiguous = refUnsafe;
  if (kind === "github") {
    const repo = text(own(raw, "repo"), 256);
    if (repo !== undefined && safeGithubRepo(repo) && exactKeys(raw, ["source", "repo", "ref"]) && optionalValid("ref")) {
      descriptor = { kind, repo, ...(ref === undefined ? {} : { ref }) };
    }
  } else if (kind === "git") {
    const url = text(own(raw, "url"));
    if (url !== undefined && exactKeys(raw, ["source", "url", "ref"]) && optionalValid("ref")) {
      const safe = redactedUrl(url); ambiguous ||= safe.ambiguous;
      descriptor = { kind, url: safe.value, ...(ref === undefined ? {} : { ref }) };
    }
  } else if (kind === "url") {
    const url = text(own(raw, "url"));
    if (url !== undefined && exactKeys(raw, ["source", "url"])) {
      const safe = redactedUrl(url); ambiguous ||= safe.ambiguous;
      descriptor = { kind, url: safe.value };
    }
  } else if (kind === "directory" || kind === "file") {
    const declaredPath = text(own(raw, "path"));
    if (declaredPath !== undefined && exactKeys(raw, ["source", "path"])) {
      const unsafeLocal = /^(?:\\\\|\/\/)/.test(declaredPath) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(declaredPath) && !/^[A-Za-z]:[\\/]/.test(declaredPath) ||
        /(?:^|[\\/])[^\\/\s:]+:[^\\/\s@]+@[^\\/\s]+/.test(declaredPath) || /[?#]/.test(declaredPath);
      const scopeRejected = (scope === "project" || scope === "local") && !portableRelative(declaredPath);
      if (!unsafeLocal && !scopeRejected) descriptor = { kind, path: declaredPath, localPath: declaredPath };
      else { descriptor = { kind, path: "<redacted-path>", localPath: "<redacted-path>" }; ambiguous = true; }
    }
  }
  if (descriptor === undefined) return { validity: "invalid" };
  if (ambiguous || requestedValidity === "redacted") {
    return { descriptor, validity: "redacted", indeterminate: "credential-bearing-or-ambiguous" };
  }
  return { descriptor, validity: "valid", matchKey: matchKey(descriptor) };
}

export function normalizeMarketplaceRegistrationRecord(raw: unknown, scope?: Scope): PluginMarketplaceSettingsDescriptorObservation {
  return registrationSource(raw, scope);
}

type PatternToken = { kind: "literal"; value: string } | { kind: "any" } | { kind: "star" };
export interface SupportedMarketplacePattern { tokens: readonly PatternToken[]; start: boolean; end: boolean }

export function parseSupportedMarketplacePattern(pattern: string): SupportedMarketplacePattern | undefined {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN || /[\u0000-\u001f\u007f]/.test(pattern)) return undefined;
  let index = 0;
  const start = pattern.startsWith("^");
  if (start) index++;
  const tokens: PatternToken[] = [];
  let stars = 0;
  while (index < pattern.length) {
    if (pattern[index] === "$" && index === pattern.length - 1) return { tokens, start, end: true };
    const character = pattern[index]!;
    if (character === "\\") {
      const escaped = pattern[++index];
      if (escaped === undefined || !/[.\\/\-_:]/.test(escaped)) return undefined;
      tokens.push({ kind: "literal", value: escaped }); index++;
    } else if (character === ".") {
      if (pattern[index + 1] === "*") {
        if (++stars > 16) return undefined;
        tokens.push({ kind: "star" }); index += 2;
      } else { tokens.push({ kind: "any" }); index++; }
    } else {
      if (/[*+?{}()[\]|^$]/.test(character)) return undefined;
      tokens.push({ kind: "literal", value: character }); index++;
    }
  }
  return { tokens, start, end: false };
}

export function supportedMarketplacePatternMatches(pattern: SupportedMarketplacePattern, value: string): boolean {
  const tokens: PatternToken[] = [...(pattern.start ? [] : [{ kind: "star" } as const]), ...pattern.tokens, ...(pattern.end ? [] : [{ kind: "star" } as const])];
  let tokenIndex = 0, valueIndex = 0, lastStar = -1, retryValue = -1;
  while (valueIndex < value.length) {
    const token = tokens[tokenIndex];
    if (token?.kind === "literal" && token.value === value[valueIndex] || token?.kind === "any") { tokenIndex++; valueIndex++; continue; }
    if (token?.kind === "star") { lastStar = tokenIndex++; retryValue = valueIndex; continue; }
    if (lastStar >= 0) { tokenIndex = lastStar + 1; valueIndex = ++retryValue; continue; }
    return false;
  }
  while (tokens[tokenIndex]?.kind === "star") tokenIndex++;
  return tokenIndex === tokens.length;
}

export function normalizeMarketplacePolicyDescriptor(rawValue: unknown): PluginMarketplaceSettingsDescriptorObservation {
  let raw = rawValue;
  let requestedValidity: unknown;
  if (plain(rawValue) && own(rawValue, "validity") !== undefined) {
    if (!exactKeys(rawValue, ["descriptor", "validity", "matchKey", "indeterminate"])) return { validity: "invalid" };
    requestedValidity = own(rawValue, "validity");
    if (requestedValidity !== "valid" && requestedValidity !== "redacted" && requestedValidity !== "invalid") return { validity: "invalid" };
    if (requestedValidity === "invalid") return { validity: "invalid" };
    const descriptor = own(rawValue, "descriptor");
    raw = plain(descriptor) ? normalizedRawDescriptor(descriptor) : undefined;
  }
  if (!plain(raw)) return { validity: "invalid" };
  const kind = own(raw, "source");
  if (kind === "hostPattern" || kind === "pathPattern") {
    const key = kind === "hostPattern" ? "hostPattern" : "pathPattern";
    const rawPattern = own(raw, key);
    if (typeof rawPattern !== "string" || !exactKeys(raw, ["source", key])) return { validity: "invalid" };
    if (parseSupportedMarketplacePattern(rawPattern) === undefined || requestedValidity === "redacted") {
      const descriptor: PluginMarketplacePolicyDescriptor = kind === "hostPattern"
        ? { kind, hostPattern: "<unsupported-regex-subset>" }
        : { kind, pathPattern: "<unsupported-regex-subset>" };
      return { descriptor, validity: "redacted", indeterminate: "unsupported-regex-subset" };
    }
    const descriptor: PluginMarketplacePolicyDescriptor = kind === "hostPattern" ? { kind, hostPattern: rawPattern } : { kind, pathPattern: rawPattern };
    return { descriptor, validity: "valid", matchKey: matchKey(descriptor) };
  }
  const registration = registrationSource({ source: raw });
  return requestedValidity === "redacted" && registration.descriptor !== undefined
    ? { descriptor: registration.descriptor, validity: "redacted", indeterminate: "credential-bearing-or-ambiguous" }
    : registration;
}

export function extractMarketplaceSourceHost(source: PluginMarketplaceRegistrationSource): string | undefined {
  if (source.kind === "github") return "github.com";
  if (source.kind !== "git" && source.kind !== "url") return undefined;
  const scp = SCP_GIT.exec(source.url);
  if (scp !== null) return scp[1];
  return safeHierarchicalUrl(source.url).host;
}

export function isSafeMarketplaceRef(value: string): boolean { return safeRef(value); }
export function isSafeMarketplaceGitLocation(value: string): boolean { return safeGitLocation(value); }
export function isSafeMarketplaceGithubRepo(value: string): boolean { return safeGithubRepo(value); }

export function isDocumentedMarketplaceName(value: string): boolean {
  return value.length <= MAX_NAME && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && !WINDOWS_RESERVED.test(value);
}

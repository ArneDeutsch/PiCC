import type {
  CompiledMcpPolicy,
  McpAdmissionDecision,
  McpPolicyAuthority,
  McpPolicyObservation,
  McpPolicyRule,
  McpPolicySettingsEntry,
  McpPolicySourceFailure,
  RawMcpPolicyCandidate,
} from "../types.js";
import { expandEnvVars } from "../util/expand-env.js";

export const MCP_POLICY_LIMITS = Object.freeze({
  settingsEntries: 256,
  sourceFailures: 64,
  environmentEntries: 512,
  environmentChars: 262_144,
  rulesPerField: 512,
  ruleChars: 4_096,
  aggregateRuleChars: 524_288,
  commandVector: 128,
  candidateNameChars: 1_024,
  candidateUrlChars: 16_384,
  candidateCommandChars: 4_096,
  candidateArgs: 128,
  candidateAggregateArgChars: 262_144,
} as const);

export interface CompileMcpPolicyInput {
  settings?: readonly McpPolicySettingsEntry[];
  sourceFailures?: readonly McpPolicySourceFailure[];
  /** Undefined means no exclusive managed configuration; zero means MCP is disabled. */
  exclusiveManagedServerCount?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** An upstream bounded collector detected lost policy material. */
  restrictiveMaterialOmitted?: boolean;
}

type RuleKind = "name" | "url" | "command";
interface NormalizedRule {
  readonly kind: RuleKind;
  readonly name?: string;
  readonly url?: string;
  readonly commandVector?: readonly string[];
}
interface InternalPolicy {
  readonly marker: "picc-mcp-policy-v1";
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly allowPresent: boolean;
  readonly allow: readonly NormalizedRule[];
  readonly deny: readonly NormalizedRule[];
  readonly managedOnly: boolean;
  readonly exclusive: boolean;
  readonly exclusiveEmpty: boolean;
  readonly failClosed: boolean;
  readonly authority: McpPolicyAuthority;
  readonly observations: readonly McpPolicyObservation[];
}

const INTERNAL_POLICIES = new WeakMap<object, InternalPolicy>();
const COMPILER_UNCERTAINTY_OBSERVATIONS = Object.freeze(["compiler-uncertainty-fail-closed"] as const);
const EMPTY_FAILURES = Object.freeze([]);
const EMERGENCY_INTERNAL_POLICY: InternalPolicy = Object.freeze({
  marker: "picc-mcp-policy-v1",
  env: Object.freeze(Object.create(null)),
  allowPresent: false,
  allow: Object.freeze([]),
  deny: Object.freeze([]),
  managedOnly: false,
  exclusive: false,
  exclusiveEmpty: false,
  failClosed: true,
  authority: "mixed",
  observations: COMPILER_UNCERTAINTY_OBSERVATIONS,
});
const EMERGENCY_TOKEN = Object.freeze({});
INTERNAL_POLICIES.set(EMERGENCY_TOKEN, EMERGENCY_INTERNAL_POLICY);
const EMERGENCY_POLICY: CompiledMcpPolicy = Object.freeze({
  posture: "fail-closed",
  authority: "mixed",
  observations: COMPILER_UNCERTAINTY_OBSERVATIONS,
  failures: EMPTY_FAILURES,
  compiled: EMERGENCY_TOKEN,
});
const EMERGENCY_DECISION: McpAdmissionDecision = Object.freeze({
  status: "blocked",
  reason: "fail-closed",
  authority: "mixed",
  observations: COMPILER_UNCERTAINTY_OBSERVATIONS,
});

type RuleResult =
  | { readonly state: "valid"; readonly rule: NormalizedRule; readonly chars: number }
  | { readonly state: "malformed" }
  | { readonly state: "over-limit" };

const FAILURE_KINDS = new Set(["malformed", "unreadable", "omitted"]);
const SOURCE_CLASSES = new Set(["system-file", "system-drop-in", "registry-hklm", "registry-hkcu", "override"]);
const AUTHORITIES = new Set(["user-controlled", "administrator-controlled", "mixed"]);
const REMEDIATIONS = new Set(["repair-user-policy", "repair-administrator-policy", "repair-mixed-policy"]);

function appendObservation(target: McpPolicyObservation[], value: McpPolicyObservation): void {
  if (!target.includes(value)) target.push(value);
}

function copyEnvironment(source: Readonly<Record<string, string | undefined>> | undefined): {
  env: Readonly<Record<string, string | undefined>>;
  overLimit: boolean;
} {
  const copy = Object.create(null) as Record<string, string | undefined>;
  if (source === undefined) return { env: Object.freeze(copy), overLimit: false };
  if (!source || typeof source !== "object" || Array.isArray(source)) return { env: Object.freeze(copy), overLimit: true };
  let entries = 0;
  let chars = 0;
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue;
    entries += 1;
    if (entries > MCP_POLICY_LIMITS.environmentEntries) return { env: Object.freeze(copy), overLimit: true };
    const value = source[key];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || (typeof value !== "string" && value !== undefined)) {
      return { env: Object.freeze(copy), overLimit: true };
    }
    chars += key.length + (value?.length ?? 0);
    if (chars > MCP_POLICY_LIMITS.environmentChars) return { env: Object.freeze(copy), overLimit: true };
    Object.defineProperty(copy, key, { value, enumerable: true, writable: false });
  }
  return { env: Object.freeze(copy), overLimit: false };
}

function copyFailures(value: readonly McpPolicySourceFailure[] | undefined): {
  failures: readonly Readonly<McpPolicySourceFailure>[];
  invalid: boolean;
} {
  if (value === undefined) return { failures: Object.freeze([]), invalid: false };
  if (!Array.isArray(value) || value.length > MCP_POLICY_LIMITS.sourceFailures) {
    return { failures: Object.freeze([]), invalid: true };
  }
  const failures: Readonly<McpPolicySourceFailure>[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" ||
      !FAILURE_KINDS.has(raw.kind) || !SOURCE_CLASSES.has(raw.sourceClass) ||
      !AUTHORITIES.has(raw.authority) || !REMEDIATIONS.has(raw.remediation)) {
      return { failures: Object.freeze([]), invalid: true };
    }
    failures.push(Object.freeze({
      kind: raw.kind,
      sourceClass: raw.sourceClass,
      authority: raw.authority,
      remediation: raw.remediation,
    }));
  }
  return { failures: Object.freeze(failures), invalid: false };
}

function authorityFor(
  settings: readonly McpPolicySettingsEntry[],
  failures: readonly Readonly<McpPolicySourceFailure>[],
  administratorEvidence: boolean,
  unknownEvidence: boolean,
): McpPolicyAuthority {
  let administrator = administratorEvidence || unknownEvidence;
  let user = unknownEvidence;
  for (const failure of failures) {
    administrator ||= failure.authority !== "user-controlled";
    user ||= failure.authority !== "administrator-controlled";
  }
  for (const entry of settings) {
    if (!entry || typeof entry !== "object" || (entry.scope !== "managed" && entry.scope !== "user" && entry.scope !== "project" && entry.scope !== "local")) {
      administrator = true;
      user = true;
    } else if (entry.scope === "managed") administrator = true;
    else user = true;
  }
  return administrator && user ? "mixed" : administrator ? "administrator-controlled" : "user-controlled";
}

function expanded(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  observations: McpPolicyObservation[],
  maxChars: number = MCP_POLICY_LIMITS.ruleChars,
): string {
  return expandEnvVars(
    value,
    env,
    () => appendObservation(observations, "unset-environment-variable"),
    maxChars,
  );
}

function hasExactKeys(object: Record<string, unknown>, expected: readonly string[]): boolean {
  let count = 0;
  for (const key in object) {
    if (!Object.hasOwn(object, key)) continue;
    count += 1;
    if (count > expected.length || !expected.includes(key)) return false;
  }
  return count === expected.length;
}

function normalizeRule(
  raw: unknown,
  allow: boolean,
  env: Readonly<Record<string, string | undefined>>,
  observations: McpPolicyObservation[],
): RuleResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { state: "malformed" };
  const object = raw as Record<string, unknown>;
  if (Object.hasOwn(object, "serverName")) {
    if (!hasExactKeys(object, ["serverName"])) return { state: "malformed" };
    const name = object.serverName;
    if (typeof name !== "string" || name.length < 1) return { state: "malformed" };
    if (name.length > MCP_POLICY_LIMITS.ruleChars) return { state: "over-limit" };
    if (allow && !/^[A-Za-z0-9_-]+$/u.test(name)) return { state: "malformed" };
    return { state: "valid", rule: Object.freeze({ kind: "name", name }), chars: name.length };
  }
  if (Object.hasOwn(object, "serverUrl")) {
    if (!hasExactKeys(object, ["serverUrl"])) return { state: "malformed" };
    const rawUrl = object.serverUrl;
    if (typeof rawUrl !== "string" || rawUrl.length < 1) return { state: "malformed" };
    if (rawUrl.length > MCP_POLICY_LIMITS.ruleChars) return { state: "over-limit" };
    const url = expanded(rawUrl, env, observations);
    if (url.length > MCP_POLICY_LIMITS.ruleChars) return { state: "over-limit" };
    if (!parseUrlPattern(url)) return { state: "malformed" };
    return { state: "valid", rule: Object.freeze({ kind: "url", url }), chars: url.length };
  }
  if (Object.hasOwn(object, "serverCommand")) {
    if (!hasExactKeys(object, ["serverCommand"])) return { state: "malformed" };
    const rawVector = object.serverCommand;
    if (!Array.isArray(rawVector) || rawVector.length < 1) return { state: "malformed" };
    if (rawVector.length > MCP_POLICY_LIMITS.commandVector) return { state: "over-limit" };
    const vector: string[] = [];
    let chars = 0;
    for (const rawPart of rawVector) {
      if (typeof rawPart !== "string" || rawPart.length < 1 && vector.length === 0) return { state: "malformed" };
      if (rawPart.length > MCP_POLICY_LIMITS.ruleChars) return { state: "over-limit" };
      const part = expanded(rawPart, env, observations);
      if (part.length > MCP_POLICY_LIMITS.ruleChars) return { state: "over-limit" };
      chars += part.length;
      if (chars > MCP_POLICY_LIMITS.aggregateRuleChars) return { state: "over-limit" };
      vector.push(part);
    }
    return {
      state: "valid",
      rule: Object.freeze({ kind: "command", commandVector: Object.freeze(vector) }),
      chars,
    };
  }
  return { state: "malformed" };
}

function ruleFingerprint(rule: NormalizedRule): string {
  if (rule.kind === "name") return `n\0${rule.name}`;
  if (rule.kind === "url") return `u\0${rule.url}`;
  return `c\0${JSON.stringify(rule.commandVector)}`;
}

function dedupe(rules: readonly NormalizedRule[]): readonly NormalizedRule[] {
  const seen = new Set<string>();
  const result: NormalizedRule[] = [];
  for (const rule of rules) {
    const key = ruleFingerprint(rule);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(rule);
    }
  }
  return Object.freeze(result);
}

interface FieldResult {
  readonly rules: readonly NormalizedRule[];
  readonly invalidWhole: boolean;
  readonly overLimit: boolean;
  readonly chars: number;
}

function compileField(
  value: unknown,
  allow: boolean,
  env: Readonly<Record<string, string | undefined>>,
  observations: McpPolicyObservation[],
): FieldResult {
  if (!Array.isArray(value)) return { rules: Object.freeze([]), invalidWhole: true, overLimit: false, chars: 0 };
  if (value.length > MCP_POLICY_LIMITS.rulesPerField) return { rules: Object.freeze([]), invalidWhole: false, overLimit: true, chars: 0 };
  const rules: NormalizedRule[] = [];
  let chars = 0;
  let overLimit = false;
  for (const raw of value) {
    const result = normalizeRule(raw, allow, env, observations);
    if (result.state === "malformed") appendObservation(observations, "invalid-rule-stripped");
    else if (result.state === "over-limit") overLimit = true;
    else {
      chars += result.chars;
      if (chars > MCP_POLICY_LIMITS.aggregateRuleChars) overLimit = true;
      else rules.push(result.rule);
    }
  }
  return {
    rules: Object.freeze(overLimit ? [] : rules),
    invalidWhole: false,
    overLimit,
    chars: overLimit ? 0 : chars,
  };
}

/** Compile settings contributions into an immutable, side-effect-free admission policy. */
export function compileMcpPolicy(input: CompileMcpPolicyInput): CompiledMcpPolicy {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return EMERGENCY_POLICY;
    const providedSettingsInvalid = input.settings !== undefined && !Array.isArray(input.settings);
    const rawSettings = Array.isArray(input.settings) ? input.settings : [];
    const settingsOverLimit = rawSettings.length > MCP_POLICY_LIMITS.settingsEntries;
    const settings = settingsOverLimit ? [] : rawSettings;
    const copiedFailures = copyFailures(input.sourceFailures);
    const copiedEnv = copyEnvironment(input.env);
    const observations: McpPolicyObservation[] = [];
    const unknownAuthority = input.restrictiveMaterialOmitted === true || providedSettingsInvalid || settingsOverLimit || copiedFailures.invalid;
    let failClosed = unknownAuthority || copiedEnv.overLimit;
    if (input.restrictiveMaterialOmitted === true || settingsOverLimit || copiedFailures.invalid) {
      appendObservation(observations, "restrictive-material-omitted");
    }
    if (providedSettingsInvalid || copiedEnv.overLimit) appendObservation(observations, "compiler-uncertainty-fail-closed");
    if (copiedFailures.failures.length > 0) {
      failClosed = true;
      appendObservation(observations, "source-failure-fail-closed");
    }

    const managedOnlyOccurrences: Array<{ order: number; value: boolean }> = [];
    for (const entry of settings) {
      if (!entry || typeof entry !== "object" ||
        (entry.scope !== "managed" && entry.scope !== "user" && entry.scope !== "project" && entry.scope !== "local")) {
        failClosed = true;
        appendObservation(observations, "compiler-uncertainty-fail-closed");
        continue;
      }
      if (entry.scope === "managed" && entry.allowManagedMcpServersOnly !== undefined) {
        const value = typeof entry.allowManagedMcpServersOnly === "boolean" ? entry.allowManagedMcpServersOnly : true;
        if (typeof entry.allowManagedMcpServersOnly !== "boolean") appendObservation(observations, "invalid-managed-only-treated-true");
        if (!Number.isSafeInteger(entry.order)) {
          failClosed = true;
          appendObservation(observations, "compiler-uncertainty-fail-closed");
        } else {
          managedOnlyOccurrences.push({ order: entry.order, value });
        }
      }
    }
    managedOnlyOccurrences.sort((left, right) => left.order - right.order);
    const managedOnly = managedOnlyOccurrences.at(-1)?.value ?? false;

    const allow: NormalizedRule[] = [];
    const deny: NormalizedRule[] = [];
    let allowPresent = false;
    let allowAggregate = 0;
    let denyAggregate = 0;
    for (const entry of settings) {
      if (!entry || typeof entry !== "object" ||
        (entry.scope !== "managed" && entry.scope !== "user" && entry.scope !== "project" && entry.scope !== "local")) continue;
      const managed = entry.scope === "managed";
      if (!managed && entry.valid !== true) {
        const hasAllowProjection = entry.allowedMcpServers !== undefined;
        const hasDenyProjection = entry.deniedMcpServers !== undefined;
        if (!hasAllowProjection && !hasDenyProjection) continue;
        appendObservation(observations, "invalid-non-managed-projection");
        if (!managedOnly && hasAllowProjection) allowPresent = true;
        if (hasDenyProjection) {
          failClosed = true;
          appendObservation(observations, "restrictive-material-omitted");
        }
        continue;
      }
      if (entry.allowedMcpServers !== undefined && (!managedOnly || managed)) {
        allowPresent = true;
        const result = compileField(entry.allowedMcpServers, true, copiedEnv.env, observations);
        if (result.invalidWhole && managed) appendObservation(observations, "invalid-managed-allow-active-empty");
        else if (result.invalidWhole) appendObservation(observations, "invalid-non-managed-projection");
        const aggregateOverflow = allowAggregate + result.chars > MCP_POLICY_LIMITS.aggregateRuleChars;
        if (result.overLimit || aggregateOverflow) appendObservation(observations, "allow-over-limit-active-empty");
        else if (!result.invalidWhole) {
          allowAggregate += result.chars;
          allow.push(...result.rules);
        }
      }
      if (entry.deniedMcpServers !== undefined) {
        const result = compileField(entry.deniedMcpServers, false, copiedEnv.env, observations);
        if (result.invalidWhole && managed) appendObservation(observations, "invalid-managed-deny-dropped");
        else if (result.invalidWhole && !managed) {
          failClosed = true;
          appendObservation(observations, "restrictive-material-omitted");
        } else if (result.overLimit || denyAggregate + result.chars > MCP_POLICY_LIMITS.aggregateRuleChars) {
          failClosed = true;
          appendObservation(observations, "restrictive-material-omitted");
        } else {
          denyAggregate += result.chars;
          deny.push(...result.rules);
        }
      }
    }

    const exclusive = input.exclusiveManagedServerCount !== undefined;
    const exclusiveCount = input.exclusiveManagedServerCount;
    if (exclusive && (!Number.isSafeInteger(exclusiveCount) || exclusiveCount! < 0)) {
      failClosed = true;
      appendObservation(observations, "compiler-uncertainty-fail-closed");
    }
    const frozenAllow = dedupe(allow);
    const frozenDeny = dedupe(deny);
    const posture = failClosed ? "fail-closed"
      : exclusive ? exclusiveCount === 0 ? "exclusive-empty" : "exclusive"
      : managedOnly ? "managed-only"
      : allowPresent || frozenDeny.length > 0 ? "active-rules"
      : "absent";
    const authority = authorityFor(
      settings,
      copiedFailures.failures,
      exclusive,
      unknownAuthority || settings.some((entry) => !entry || typeof entry !== "object" ||
        (entry.scope !== "managed" && entry.scope !== "user" && entry.scope !== "project" && entry.scope !== "local")),
    );
    const frozenObservations = Object.freeze([...observations]);
    const internal: InternalPolicy = Object.freeze({
      marker: "picc-mcp-policy-v1",
      env: copiedEnv.env,
      allowPresent,
      allow: frozenAllow,
      deny: frozenDeny,
      managedOnly,
      exclusive,
      exclusiveEmpty: exclusive && exclusiveCount === 0,
      failClosed,
      authority,
      observations: frozenObservations,
    });
    const token = Object.freeze({});
    INTERNAL_POLICIES.set(token, internal);
    return Object.freeze({
      posture,
      authority,
      observations: frozenObservations,
      failures: copiedFailures.failures,
      compiled: token,
    });
  } catch {
    return EMERGENCY_POLICY;
  }
}

interface UrlIdentity {
  readonly scheme: string;
  readonly host: string;
  readonly port?: string;
  readonly path?: string;
}

function hasAmbiguousUrlSyntax(value: string): boolean {
  return value.includes("\\") || value.includes("@") || value.includes("?") || value.includes("#") || value.includes("%") ||
    value.includes("[") || value.includes("]") || /[^\x20-\x7e]/u.test(value);
}

function hasDotSegment(path: string | undefined): boolean {
  return path !== undefined && path.split("/").some((part) => part === "." || part === "..");
}

function splitAuthority(authority: string, pattern: boolean): { host: string; port?: string } | undefined {
  if (!authority) return undefined;
  const colon = authority.lastIndexOf(":");
  const host = colon < 0 ? authority : authority.slice(0, colon);
  const port = colon < 0 ? undefined : authority.slice(colon + 1);
  const hostPattern = pattern ? /^[A-Za-z0-9.*-]+$/u : /^[A-Za-z0-9.-]+$/u;
  const portPattern = pattern ? /^[0-9*]+$/u : /^[0-9]+$/u;
  if (!host || !hostPattern.test(host) || (port !== undefined && (!port || !portPattern.test(port)))) return undefined;
  if (!pattern && port !== undefined && !isUrlValidPort(port)) return undefined;
  return { host: trimOneTrailingDot(host).toLowerCase(), ...(port === undefined ? {} : { port }) };
}

function parseUrlPattern(value: string): UrlIdentity | undefined {
  if (hasAmbiguousUrlSyntax(value)) return undefined;
  const separator = value.indexOf("://");
  if (separator < 1 || value.indexOf("://", separator + 3) >= 0) return undefined;
  const scheme = value.slice(0, separator);
  if (!/^[A-Za-z*][A-Za-z*]*$/u.test(scheme)) return undefined;
  const rest = value.slice(separator + 3);
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? undefined : rest.slice(slash);
  if (path !== undefined && (!/^\/[\x20-\x7e]*$/u.test(path) || hasDotSegment(path))) return undefined;
  const split = splitAuthority(authority, true);
  return split ? { scheme, ...split, ...(path === undefined ? {} : { path }) } : undefined;
}

function parseCandidateUrl(value: string): UrlIdentity | undefined {
  if (hasAmbiguousUrlSyntax(value) || value.includes("*")) return undefined;
  const match = /^(https?):\/\/([^/]+)(\/[^]*)?$/u.exec(value);
  if (!match || hasDotSegment(match[3])) return undefined;
  const split = splitAuthority(match[2]!, false);
  return split ? { scheme: match[1]!, ...split, ...(match[3] === undefined ? {} : { path: match[3] }) } : undefined;
}

function trimOneTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function canonicalDecimalPort(port: string): string {
  const canonical = port.replace(/^0+(?=\d)/u, "");
  return canonical || "0";
}

function isUrlValidPort(port: string): boolean {
  const canonical = canonicalDecimalPort(port);
  return canonical.length < 5 || canonical.length === 5 && canonical <= "65535";
}

function defaultPort(scheme: string): string | undefined {
  return scheme === "http" ? "80" : scheme === "https" ? "443" : undefined;
}

function kmpIndexOf(value: string, needle: string, start: number, end: number): number {
  if (needle.length === 0) return start;
  const prefix = new Array<number>(needle.length).fill(0);
  for (let index = 1, matched = 0; index < needle.length;) {
    if (needle[index] === needle[matched]) prefix[index++] = ++matched;
    else if (matched > 0) matched = prefix[matched - 1]!;
    else index += 1;
  }
  for (let index = start, matched = 0; index < end;) {
    if (value[index] === needle[matched]) {
      index += 1;
      matched += 1;
      if (matched === needle.length) return index - matched;
    } else if (matched > 0) matched = prefix[matched - 1]!;
    else index += 1;
  }
  return -1;
}

/** Anchored `*` matching; KMP segments keep traversal bounded without regex backtracking. */
function wildcardMatch(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const startsWithStar = pattern.startsWith("*");
  const endsWithStar = pattern.endsWith("*");
  const segments = pattern.split("*").filter((segment) => segment.length > 0);
  if (segments.length === 0) return true;
  let first = 0;
  let last = segments.length;
  let cursor = 0;
  let end = value.length;
  if (!startsWithStar) {
    const prefix = segments[0]!;
    if (!value.startsWith(prefix)) return false;
    cursor = prefix.length;
    first = 1;
  }
  if (!endsWithStar && last > first) {
    const suffix = segments[last - 1]!;
    if (!value.endsWith(suffix)) return false;
    end -= suffix.length;
    last -= 1;
  } else if (!endsWithStar && last === first) {
    return cursor === value.length;
  }
  for (let index = first; index < last; index += 1) {
    const segment = segments[index]!;
    const found = kmpIndexOf(value, segment, cursor, end);
    if (found < 0) return false;
    cursor = found + segment.length;
  }
  return cursor <= end;
}

function urlMatches(patternValue: string, candidateValue: string, deny: boolean): boolean {
  const pattern = parseUrlPattern(patternValue);
  const candidate = parseCandidateUrl(candidateValue);
  if (!pattern || !candidate) return false;
  if (!wildcardMatch(pattern.scheme, candidate.scheme)) return false;
  if (!wildcardMatch(pattern.host, candidate.host)) return false;
  if (deny) {
    const effectiveCandidatePort = candidate.port === undefined ? defaultPort(candidate.scheme) : canonicalDecimalPort(candidate.port);
    if (pattern.port === undefined) {
      if (effectiveCandidatePort !== defaultPort(candidate.scheme)) return false;
    } else if (pattern.port.includes("*")) {
      if (effectiveCandidatePort === undefined ||
        !wildcardMatch(pattern.port, candidate.port ?? effectiveCandidatePort) && !wildcardMatch(pattern.port, effectiveCandidatePort)) return false;
    } else if (effectiveCandidatePort === undefined || canonicalDecimalPort(pattern.port) !== effectiveCandidatePort) return false;
  } else if (pattern.port === undefined ? candidate.port !== undefined : !wildcardMatch(pattern.port, candidate.port ?? "")) return false;
  return pattern.path === undefined || wildcardMatch(pattern.path, candidate.path ?? "/");
}

function candidateRuleMatches(rule: NormalizedRule, candidate: RawMcpPolicyCandidate, deny = false): boolean {
  if (rule.kind === "name") return rule.name === candidate.name;
  if (rule.kind === "url") return candidate.transport !== "stdio" && typeof candidate.url === "string" && urlMatches(rule.url!, candidate.url, deny);
  const vector = [candidate.command!, ...(candidate.args ?? [])];
  return candidate.transport === "stdio" && rule.commandVector?.length === vector.length &&
    rule.commandVector.every((part, index) => part === vector[index]);
}

function blocked(
  policy: InternalPolicy,
  reason: McpAdmissionDecision["reason"],
  extra: readonly McpPolicyObservation[] = [],
): McpAdmissionDecision {
  return Object.freeze({
    status: "blocked",
    reason,
    authority: policy.authority,
    observations: Object.freeze([...new Set([...policy.observations, ...extra])]),
  });
}

const CANDIDATE_SOURCES = new Set([
  "native-local", "project-mcpjson", "native-user", "settings-managed", "settings-local",
  "settings-project", "settings-user", "managed-mcp", "plugin", "subagent-inline", "explicit-runtime",
]);

type CandidateInvalidity = "over-limit-or-shape" | "identity-ambiguity";

function candidateInvalidity(candidate: RawMcpPolicyCandidate, checkRemoteIdentity = false): CandidateInvalidity | undefined {
  if (!candidate || typeof candidate !== "object" || typeof candidate.name !== "string" || candidate.name.length < 1 ||
    candidate.name.length > MCP_POLICY_LIMITS.candidateNameChars || !CANDIDATE_SOURCES.has(candidate.source)) {
    return "over-limit-or-shape";
  }
  if (candidate.identityAmbiguous === true) return "identity-ambiguity";
  if (candidate.transport === "stdio") {
    if (typeof candidate.command !== "string" || candidate.command.length < 1 ||
      candidate.command.length > MCP_POLICY_LIMITS.candidateCommandChars || !Array.isArray(candidate.args ?? []) ||
      (candidate.args?.length ?? 0) > MCP_POLICY_LIMITS.candidateArgs) return "over-limit-or-shape";
    let chars = 0;
    for (const arg of candidate.args ?? []) {
      if (typeof arg !== "string" || arg.length > MCP_POLICY_LIMITS.candidateCommandChars) return "over-limit-or-shape";
      chars += arg.length;
      if (chars > MCP_POLICY_LIMITS.candidateAggregateArgChars) return "over-limit-or-shape";
    }
    return undefined;
  }
  if ((candidate.transport !== "http" && candidate.transport !== "sse") || typeof candidate.url !== "string" ||
    candidate.url.length < 1 || candidate.url.length > MCP_POLICY_LIMITS.candidateUrlChars) return "over-limit-or-shape";
  return checkRemoteIdentity && !parseCandidateUrl(candidate.url) ? "identity-ambiguity" : undefined;
}

/** Evaluate one raw candidate without materializing it or consulting ambient state. */
export function evaluateMcpPolicy(policy: CompiledMcpPolicy, candidate: RawMcpPolicyCandidate): McpAdmissionDecision {
  try {
    const token = policy.compiled;
    const internal = token && typeof token === "object" ? INTERNAL_POLICIES.get(token) : undefined;
    if (!internal || internal.marker !== "picc-mcp-policy-v1") return EMERGENCY_DECISION;
    if (internal.failClosed) return blocked(internal, "fail-closed");
    if (internal.exclusiveEmpty || (internal.exclusive && candidate.source !== "managed-mcp")) return blocked(internal, "exclusive-control");
    const rawInvalidity = candidateInvalidity(candidate);
    if (rawInvalidity) {
      return blocked(internal, "candidate-invalid", [rawInvalidity === "identity-ambiguity" ? "identity-ambiguity-blocked" : "candidate-over-limit-blocked"]);
    }
    const observations: McpPolicyObservation[] = [];
    const expandedCandidate: RawMcpPolicyCandidate = candidate.transport === "stdio"
      ? Object.freeze({
          name: candidate.name,
          source: candidate.source,
          transport: "stdio",
          command: expanded(candidate.command!, internal.env, observations, MCP_POLICY_LIMITS.candidateCommandChars),
          args: Object.freeze((candidate.args ?? []).map((arg) => expanded(arg, internal.env, observations, MCP_POLICY_LIMITS.candidateCommandChars))),
        })
      : Object.freeze({
          name: candidate.name,
          source: candidate.source,
          transport: candidate.transport,
          url: expanded(candidate.url!, internal.env, observations, MCP_POLICY_LIMITS.candidateUrlChars),
        });
    const expandedInvalidity = candidateInvalidity(expandedCandidate, true);
    if (expandedInvalidity) {
      return blocked(internal, "candidate-invalid", [
        ...observations,
        expandedInvalidity === "identity-ambiguity" ? "identity-ambiguity-blocked" : "candidate-over-limit-blocked",
      ]);
    }
    if (internal.deny.some((rule) => candidateRuleMatches(rule, expandedCandidate, true))) return blocked(internal, "denied", observations);
    const mergedObservations = Object.freeze([...new Set([...internal.observations, ...observations])]);
    if (!internal.allowPresent) return Object.freeze({ status: "allowed", reason: "allowed", authority: internal.authority, observations: mergedObservations });
    const transportRules = internal.allow.filter((rule) => expandedCandidate.transport === "stdio" ? rule.kind === "command" : rule.kind === "url");
    const eligible = transportRules.length > 0 ? transportRules : internal.allow.filter((rule) => rule.kind === "name");
    if (!eligible.some((rule) => candidateRuleMatches(rule, expandedCandidate))) {
      return blocked(internal, internal.managedOnly ? "managed-only" : "allow-miss", observations);
    }
    return Object.freeze({ status: "allowed", reason: "allowed", authority: internal.authority, observations: mergedObservations });
  } catch {
    return EMERGENCY_DECISION;
  }
}

/** Compile and evaluate in one call for callers that do not retain a snapshot. */
export function admitMcpCandidate(input: CompileMcpPolicyInput, candidate: RawMcpPolicyCandidate): McpAdmissionDecision {
  return evaluateMcpPolicy(compileMcpPolicy(input), candidate);
}

export type { McpPolicyRule };

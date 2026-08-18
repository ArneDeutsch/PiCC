import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expandEnvVars } from "../util/expand-env.js";
import { AGENT_MCP_LIMITS } from "../claude/agent-mcp.js";
import { normalizeMcpServerBlock, type McpJsonResult, type RawMcpEntry } from "../claude/mcp-config.js";
import type { ClaudeMcpStateResult } from "../claude/claude-mcp-state.js";
import { resolveRemoteMcpFields, type RemoteMcpWorkHooks } from "../claude/mcp-remote-config.js";
import type { ManagedMcpResult } from "../claude/managed-mcp.js";
import { compileMcpPolicy, evaluateMcpPolicy, MCP_POLICY_LIMITS } from "../engine/mcp-policy.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import { sanitizedSubprocessEnv } from "../util/env.js";
import {
  MCP_ADMINISTRATION_MODEL_VERSION,
  type McpAdministrationDeclaration,
  type McpAdministrationTrace,
  type McpAgentOwner,
  type McpReviewPosture,
  type McpReviewSnapshot,
} from "../mcp-administration/model.js";
import {
  commandBasename,
  createMcpReviewDefinitionDigest,
  createMcpReviewIdentity,
  matchesMcpReviewRecord,
  MCP_REVIEW_DEFINITION_VERSION,
  safeRemoteOrigin,
  staticMcpHeaderCount,
  validateAndCopyMcpReviewSnapshot,
} from "../mcp-administration/review-definition.js";
import type {
  AgentMcpAdmissionContext,
  AgentMcpDeclaration,
  AgentMcpDiagnosticOwnership,
  CompiledMcpPolicy,
  McpInactiveReason,
  McpPolicyInactiveReason,
  McpPolicySettingsEntry,
  McpPolicySourceFailure,
  McpServerStatus,
  McpSettingsEntry,
  McpSourceClass,
  NormalizedAgentMcpEntry,
  ResolvedAgentMcpConfig,
  ResolvedAgentMcpServer,
  ResolvedMcpConfig,
  ResolvedMcpServer,
} from "../types.js";

/**
 * MCP precedence & enablement resolution with one fixed, sanitized Git probe seam.
 *
 * Combines native local/user state, project `.mcp.json`, and scope-tagged
 * settings-extension captures into one {@link ResolvedMcpConfig}.
 *
 * Ordinary same-name candidates resolve as whole entries in this order: native
 * local, `.mcp.json`, native user, then managed/local/project/user settings
 * extension. Project-origin extension and `.mcp.json` winners retain the existing
 * approval gate. Native runtime disablement is an exact-name final deny for
 * authentic ordinary winners only; settings `*McpjsonServers` remain confined to
 * `.mcp.json` and extension winners. Present unusable native state fails ordinary
 * MCP closed; standalone exclusive managed input bypasses ordinary/native loading.
 * - Git-tracked local demotion (mandatory gate rule): a `settings.local.json`
 *   that is tracked in the project repository is attacker-committable, so its
 *   MCP contribution is treated as PROJECT scope with a diagnostic. Git
 *   provenance may change a local declaration's origin, but checkout-local
 *   approval keys never authorize; probe failure cannot make them authoritative.
 * - `${VAR}` / `${VAR:-default}` expansion applies to command/args/env at
 *   resolution time; unset-without-default keeps the literal and records a
 *   warning naming the VARIABLE NAME only (never values).
 *
 * Diagnostics carry raw (pre-expansion) strings only and every diagnostic
 * passes neutralize-text before storage. Never throws.
 */

/**
 * Probe seam: is `filePath` tracked by git in the project repository?
 * `undefined` means provenance is indeterminate. It never authorizes approval.
 */
export type GitTrackedProbe = (filePath: string, projectRoot: string) => boolean | undefined;

export interface ResolveMcpConfigOptions {
  projectRoot: string;
  /** Explicit ordinary project input for direct resolver callers. */
  mcpJson?: McpJsonResult;
  /**
   * Production assembly seam for ordinary native/project acquisition. Invoked
   * only after the prepared policy snapshot establishes those inputs can matter.
   */
  loadOrdinaryMcp?: () => {
    nativeState: ClaudeMcpStateResult;
    mcpJson: McpJsonResult;
  };
  /** Scope-tagged settings captures, in ascending-precedence file order. */
  mcpSettings: McpSettingsEntry[];
  /** Inert native Claude snapshot; absence preserves the extension-only contract. */
  nativeState?: ClaudeMcpStateResult;
  /** Fixed profile provenance retained only for safe fail-closed repair guidance. */
  nativeStateProfile?: import("../types.js").ClaudeProfileSource;
  /** Ordered policy contributions and typed discovery failures from settings discovery. */
  mcpPolicySettings?: readonly McpPolicySettingsEntry[];
  mcpPolicySourceFailures?: readonly McpPolicySourceFailure[];
  mcpPolicyRestrictiveMaterialOmitted?: boolean;
  /** Standalone administrator-owned exclusive MCP state. */
  managedMcp?: ManagedMcpResult;
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to a `git ls-files --error-unmatch` child call. */
  isGitTracked?: GitTrackedProbe;
  /** Immutable PiCC-owned exact-definition review decisions. */
  reviewSnapshot?: McpReviewSnapshot;
  /** Deterministic counters for enabled-only remote work. */
  remoteWorkHooksForTest?: RemoteMcpWorkHooks;
  /** Production handoff of captured authority; callback failure cannot affect ordinary resolution. */
  captureAgentMcpAdmission?: (context: AgentMcpAdmissionContext) => void;
}

type McpOrigin =
  | "settings-user"
  | "settings-project"
  | "settings-local"
  | "settings-managed"
  | "native-user"
  | "mcpjson"
  | "native-local"
  | "managed-mcp";

const ORIGIN_RANK: Record<McpOrigin, number> = {
  "settings-user": 0,
  "settings-project": 1,
  "settings-local": 2,
  "settings-managed": 3,
  "native-user": 4,
  mcpjson: 5,
  "native-local": 6,
  "managed-mcp": 7,
};

export const MCP_ADMINISTRATION_TRACE_LIMITS = Object.freeze({ declarations: 512 });

interface Candidate {
  entry: RawMcpEntry;
  origin: McpOrigin;
  authentic: boolean;
  projectApprovalRequired: boolean;
  /** Global discovery index; among equal ranks the later (nearer) file wins. */
  order: number;
  source: McpSourceClass;
}

function emptyAdministration(
  policyPosture: CompiledMcpPolicy["posture"],
  ordinarySuppressed: boolean,
  reviewInvalid: boolean,
): McpAdministrationTrace {
  return Object.freeze({
    version: MCP_ADMINISTRATION_MODEL_VERSION,
    policyPosture,
    observations: Object.freeze([
      ...(ordinarySuppressed ? ["ordinary-sources-suppressed-by-managed-mcp" as const] : []),
      ...(reviewInvalid ? ["review-snapshot-unavailable-or-invalid" as const] : []),
    ]),
    declarations: Object.freeze([]),
    omittedDeclarationCount: 0,
  });
}

function settingsMcpSource(scope: McpSettingsEntry["scope"]): McpSourceClass {
  return scope === "managed" ? "settings-managed"
    : scope === "local" ? "settings-local"
      : scope === "project" ? "settings-project" : "settings-user";
}

function candidateAuthority(source: McpSourceClass): McpAdministrationDeclaration["authority"] {
  if (source === "native-local") return Object.freeze({ kind: "mutable", scope: "local" });
  if (source === "project-mcpjson") return Object.freeze({ kind: "mutable", scope: "project" });
  if (source === "native-user") return Object.freeze({ kind: "mutable", scope: "user" });
  return Object.freeze({ kind: "read-only", sourceClass: source });
}

function matchingReview(
  snapshot: McpReviewSnapshot | undefined,
  source: McpSourceClass | "subagent-inline",
  name: string,
  digest: string | undefined,
  owner?: McpAgentOwner,
  declarationScope?: AgentMcpDeclaration["scope"],
): "approved" | "rejected" | undefined {
  if (snapshot === undefined || digest === undefined ||
    (owner !== undefined && declarationScope !== undefined && owner.scope !== declarationScope)) return undefined;
  const identity = createMcpReviewIdentity({ snapshot, source, serverName: name, ...(owner === undefined ? {} : { agentOwner: owner }) });
  let approved = false;
  for (const candidate of snapshot.records) {
    if (!matchesMcpReviewRecord(candidate, identity, digest)) continue;
    if (candidate.decision === "rejected") return "rejected";
    approved = true;
  }
  return approved ? "approved" : undefined;
}

function safeDeclarationSummary(entry: RawMcpEntry): McpAdministrationDeclaration["summary"] {
  const basename = entry.remote === undefined && !entry.skipped ? commandBasename(entry.command) : undefined;
  const origin = entry.remote === undefined ? undefined : safeRemoteOrigin(entry.remote.rawUrl);
  return Object.freeze({
    ...(entry.remote === undefined
      ? (entry.skipped ? {} : { transport: "stdio" as const, ...(basename === undefined ? {} : { commandBasename: basename }) })
      : {
          transport: entry.remote.transportKind,
          configuredType: entry.remote.configuredType,
          ...(origin === undefined ? {} : { remoteOrigin: origin }),
        }),
    argumentCount: entry.args.length,
    environmentKeyCount: Object.keys(entry.env).length,
    headerKeyCount: entry.remote === undefined ? 0 : staticMcpHeaderCount(entry),
    timeoutConfigured: entry.timeoutMs !== undefined,
  });
}

/**
 * Claude-parity list matching (binary-verified 2.1.218): Claude runs BOTH the
 * `enabledMcpjsonServers`/`disabledMcpjsonServers` entries and the server name
 * through its name sanitizer (`[^a-zA-Z0-9_-]` → `_`) before comparing. An
 * exact compare would miss the deny direction: `"my_server"` in
 * disabledMcpjsonServers must still catch a server named `my.server`.
 */
function sanitizeForListMatch(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpGitProbeEnv(
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return sanitizedSubprocessEnv(inherited);
}

function defaultGitTrackedProbe(filePath: string, projectRoot: string): boolean | undefined {
  try {
    // Probe the CANONICAL on-disk spelling, not the lexical lookup path: on a
    // case-insensitive filesystem (Windows/macOS) the loader happily reads a
    // committed ".claude/Settings.local.json" via the lowercase name, but git
    // pathspecs are case-sensitive — probing the lexical spelling would answer
    // "untracked" and bypass the declaration-origin demotion. A failed probe
    // cannot establish demotion and never makes checkout-local approvals authoritative.
    const realFile = fs.realpathSync.native(filePath);
    const realRoot = fs.realpathSync.native(projectRoot);
    const rel = path.relative(realRoot, realFile);
    if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
    const result = spawnSync(
      "git",
      ["-C", realRoot, "ls-files", "--error-unmatch", "--", rel.split(path.sep).join("/")],
      { stdio: "ignore", timeout: 5000, windowsHide: true, env: mcpGitProbeEnv() },
    );
    if (result.error) return undefined;
    if (result.status === 0) return true;
    if (result.status === 1) return false; // clean "not tracked" answer
    return undefined; // 128 = not a repo, and anything else unexpected
  } catch {
    return undefined;
  }
}

function snapshotEnvironment(source: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  unavailable: boolean;
} {
  const snapshot = Object.create(null) as NodeJS.ProcessEnv;
  try {
    for (const key of Object.keys(source)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
      const value = source[key];
      if (value !== undefined) Object.defineProperty(snapshot, key, { value, enumerable: true });
    }
    return { env: Object.freeze(snapshot), unavailable: false };
  } catch {
    return { env: Object.freeze(snapshot), unavailable: true };
  }
}

function agentPolicyReason(reason: ReturnType<typeof evaluateMcpPolicy>["reason"]): McpPolicyInactiveReason | undefined {
  switch (reason) {
    case "denied": return "policy-denied";
    case "allow-miss": return "policy-allow-miss";
    case "managed-only": return "policy-managed-only";
    case "candidate-invalid": return "policy-candidate-invalid";
    case "exclusive-control":
    case "fail-closed":
    case "allowed": return undefined;
  }
}

const AGENT_ADMISSION_DIAGNOSTIC_LIMITS = Object.freeze({
  aggregate: AGENT_MCP_LIMITS.diagnostics,
  perServer: 16,
  messageChars: AGENT_MCP_LIMITS.diagnosticChars,
});
const AGENT_ADMISSION_OMISSION = "Additional agent MCP admission diagnostics omitted";
const AGENT_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
type AgentStdioOverflowCategory = "command" | "argument" | "environment value";

function agentStdioOverflowDiagnostic(category: AgentStdioOverflowCategory): string {
  return `Agent MCP stdio ${category} exceeds the ${AGENT_MCP_LIMITS.stringChars}-character limit; shorten the declaration or referenced environment value. Server remains inactive.`;
}

function findAgentStdioIdentityOverflow(
  entry: NormalizedAgentMcpEntry,
  env: NodeJS.ProcessEnv,
): Exclude<AgentStdioOverflowCategory, "environment value"> | undefined {
  if (expandEnvVars(entry.command, env, undefined, AGENT_MCP_LIMITS.stringChars).length > AGENT_MCP_LIMITS.stringChars) {
    return "command";
  }
  for (const argument of entry.args) {
    if (expandEnvVars(argument, env, undefined, AGENT_MCP_LIMITS.stringChars).length > AGENT_MCP_LIMITS.stringChars) {
      return "argument";
    }
  }
  return undefined;
}

function safeAdmissionDiagnostic(message: string): string {
  const clean = neutralizeControlChars(message).replace(/[\r\n\t]+/gu, " ");
  return clean.length <= AGENT_ADMISSION_DIAGNOSTIC_LIMITS.messageChars
    ? clean
    : `${clean.slice(0, AGENT_ADMISSION_DIAGNOSTIC_LIMITS.messageChars - 1)}…`;
}

function ownData(record: object, key: string): unknown | typeof missingData {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : missingData;
}
const missingData = Symbol("missing-agent-mcp-data");

function safeRecord(value: unknown, allowedKeys: ReadonlySet<string>): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= AGENT_MCP_LIMITS.entryFields && keys.every((key) => {
    if (typeof key !== "string" || key.length > AGENT_MCP_LIMITS.fieldNameChars || !allowedKeys.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}

function validatedArrayLength(value: unknown, maxItems: number): number | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || lengthDescriptor.enumerable || !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 || lengthDescriptor.value > maxItems || keys.length !== lengthDescriptor.value + 1) return undefined;
  for (let index = 0; index < lengthDescriptor.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
  }
  return keys.every((key) => key === "length" ||
    (typeof key === "string" && /^(0|[1-9][0-9]*)$/u.test(key) && Number(key) < lengthDescriptor.value))
    ? lengthDescriptor.value
    : undefined;
}

function copyStringArray(value: unknown): string[] | undefined {
  const length = validatedArrayLength(value, AGENT_MCP_LIMITS.collectionItems);
  if (length === undefined) return undefined;
  const copy: string[] = [];
  for (let index = 0; index < length; index++) {
    const item = ownData(value as object, String(index));
    if (typeof item !== "string" || item.length > AGENT_MCP_LIMITS.stringChars) return undefined;
    copy.push(item);
  }
  return copy;
}

function copyStringRecord(value: unknown, keyLimit: number): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > AGENT_MCP_LIMITS.collectionItems) return undefined;
  const copy = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    if (typeof key !== "string" || key.length > keyLimit) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) ||
      typeof descriptor.value !== "string" || descriptor.value.length > AGENT_MCP_LIMITS.stringChars) return undefined;
    copy[key] = descriptor.value;
  }
  return copy;
}

const RAW_ENTRY_KEYS = new Set(["command", "args", "env", "type", "timeout", "url", "headers", "headersHelper", "alwaysLoad", "role", "oauth"]);
function copyDeferredRawEntry(value: unknown): Record<string, unknown> | undefined {
  if (!safeRecord(value, RAW_ENTRY_KEYS)) return undefined;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const item = ownData(value, key);
    if (key === "command" || key === "type" || key === "url") {
      if (typeof item !== "string" || item.length > AGENT_MCP_LIMITS.stringChars) return undefined;
      copy[key] = item;
    } else if (key === "timeout") {
      if (typeof item !== "number" || !Number.isFinite(item)) return undefined;
      copy[key] = item;
    } else if (key === "args") {
      const projected = copyStringArray(item);
      if (projected === undefined) return undefined;
      copy[key] = projected;
    } else if (key === "env" || key === "headers") {
      const projected = copyStringRecord(item, key === "headers" ? AGENT_MCP_LIMITS.headerNameChars : AGENT_MCP_LIMITS.fieldNameChars);
      if (projected === undefined) return undefined;
      copy[key] = projected;
    } else {
      if (item !== null) return undefined;
      copy[key] = null;
    }
  }
  return copy;
}

const REMOTE_KEYS = new Set(["configuredType", "transportKind", "rawUrl", "rawEntry", "rawHeaders", "sseDeprecation"]);
function copyRemote(value: unknown): NormalizedAgentMcpEntry["remote"] | undefined {
  if (!safeRecord(value, REMOTE_KEYS)) return undefined;
  const configuredType = ownData(value, "configuredType");
  const transportKind = ownData(value, "transportKind");
  const rawUrl = ownData(value, "rawUrl");
  const rawHeaders = copyStringRecord(ownData(value, "rawHeaders"), AGENT_MCP_LIMITS.headerNameChars);
  if ((configuredType !== "http" && configuredType !== "streamable-http" && configuredType !== "sse") ||
    (transportKind !== "http" && transportKind !== "sse") ||
    transportKind !== (configuredType === "sse" ? "sse" : "http") ||
    typeof rawUrl !== "string" || rawUrl.length > AGENT_MCP_LIMITS.stringChars || rawHeaders === undefined) return undefined;
  const rawEntryValue = ownData(value, "rawEntry");
  const rawEntry = rawEntryValue === missingData ? undefined : copyDeferredRawEntry(rawEntryValue);
  if (rawEntryValue !== missingData && rawEntry === undefined) return undefined;
  const deprecationValue = ownData(value, "sseDeprecation");
  let sseDeprecation: { deprecated: true; replacement: "http" } | undefined;
  if (deprecationValue !== missingData) {
    const keys = new Set(["deprecated", "replacement"]);
    if (!safeRecord(deprecationValue, keys) || ownData(deprecationValue, "deprecated") !== true || ownData(deprecationValue, "replacement") !== "http") return undefined;
    sseDeprecation = { deprecated: true, replacement: "http" };
  }
  if ((configuredType === "sse") !== (sseDeprecation !== undefined)) return undefined;
  return { configuredType, transportKind, rawUrl, ...(rawEntry === undefined ? {} : { rawEntry }), rawHeaders, ...(sseDeprecation === undefined ? {} : { sseDeprecation }) };
}

const NORMALIZED_ENTRY_KEYS = new Set(["name", "command", "args", "env", "timeoutMs", "remote", "notConfigured", "skipped"]);
function copyNormalizedEntry(value: unknown, expectedName: string): NormalizedAgentMcpEntry | undefined {
  if (!safeRecord(value, NORMALIZED_ENTRY_KEYS)) return undefined;
  const name = ownData(value, "name");
  const command = ownData(value, "command");
  const args = copyStringArray(ownData(value, "args"));
  const env = copyStringRecord(ownData(value, "env"), AGENT_MCP_LIMITS.fieldNameChars);
  const skipped = ownData(value, "skipped");
  if (name !== expectedName || typeof command !== "string" || command.length > AGENT_MCP_LIMITS.stringChars ||
    args === undefined || env === undefined || skipped !== false) return undefined;
  const timeoutValue = ownData(value, "timeoutMs");
  if (timeoutValue !== missingData && (typeof timeoutValue !== "number" || !Number.isSafeInteger(timeoutValue) || timeoutValue < 1000)) return undefined;
  const remoteValue = ownData(value, "remote");
  const remote = remoteValue === missingData ? undefined : copyRemote(remoteValue);
  if (remoteValue !== missingData && remote === undefined) return undefined;
  const notConfiguredValue = ownData(value, "notConfigured");
  if (notConfiguredValue !== missingData && notConfiguredValue !== true) return undefined;
  if (notConfiguredValue === true && (remote === undefined || remote.rawUrl !== "")) return undefined;
  return { name, command, args, env, ...(timeoutValue === missingData ? {} : { timeoutMs: timeoutValue }), ...(remote === undefined ? {} : { remote }), ...(notConfiguredValue === missingData ? {} : { notConfigured: true }), skipped: false };
}

interface ValidatedAgentDeclaration {
  scope: "user" | "project";
  diagnosticOwnership: AgentMcpDiagnosticOwnership[];
  items: Array<{ kind: "reference"; name: string } | { kind: "inline"; name: string; entry?: NormalizedAgentMcpEntry }>;
}
const DECLARATION_KEYS = new Set(["scope", "items", "diagnostics", "diagnosticOwnership"]);
const ITEM_KEYS = new Set(["kind", "name", "entry"]);
const SERVER_DIAGNOSTIC_OWNERSHIP_KEYS = new Set(["kind", "serverName"]);
const UNOWNED_DIAGNOSTIC_OWNERSHIP_KEYS = new Set(["kind", "itemIndex"]);
function copyDiagnosticOwnership(value: unknown): AgentMcpDiagnosticOwnership | undefined {
  const kind = value !== null && typeof value === "object" ? ownData(value, "kind") : missingData;
  if (kind === "server") {
    if (!safeRecord(value, SERVER_DIAGNOSTIC_OWNERSHIP_KEYS)) return undefined;
    const serverName = ownData(value, "serverName");
    if (typeof serverName !== "string" || serverName.length > AGENT_MCP_LIMITS.serverNameChars ||
      !AGENT_SERVER_NAME_RE.test(serverName) || serverName.includes("__")) return undefined;
    return Object.freeze(Object.assign(Object.create(null), { kind, serverName })) as AgentMcpDiagnosticOwnership;
  }
  if (kind === "unowned") {
    if (!safeRecord(value, UNOWNED_DIAGNOSTIC_OWNERSHIP_KEYS)) return undefined;
    const itemIndex = ownData(value, "itemIndex");
    if (itemIndex !== missingData && (!Number.isSafeInteger(itemIndex) || (itemIndex as number) < 0 ||
      (itemIndex as number) >= AGENT_MCP_LIMITS.items)) return undefined;
    return Object.freeze(Object.assign(Object.create(null), {
      kind,
      ...(itemIndex === missingData ? {} : { itemIndex }),
    })) as AgentMcpDiagnosticOwnership;
  }
  return undefined;
}
function validateAgentDeclaration(value: unknown): ValidatedAgentDeclaration | undefined {
  if (!safeRecord(value, DECLARATION_KEYS)) return undefined;
  const scope = ownData(value, "scope");
  const itemsValue = ownData(value, "items");
  const diagnosticsValue = ownData(value, "diagnostics");
  const ownershipValue = ownData(value, "diagnosticOwnership");
  const itemCount = validatedArrayLength(itemsValue, AGENT_MCP_LIMITS.items);
  const diagnosticCount = validatedArrayLength(diagnosticsValue, AGENT_MCP_LIMITS.diagnostics);
  const ownershipCount = validatedArrayLength(ownershipValue, AGENT_MCP_LIMITS.diagnostics);
  if ((scope !== "user" && scope !== "project") || itemCount === undefined || diagnosticCount === undefined ||
    ownershipCount !== diagnosticCount) return undefined;
  const diagnosticOwnership: AgentMcpDiagnosticOwnership[] = [];
  for (let index = 0; index < diagnosticCount; index++) {
    const message = ownData(diagnosticsValue as object, String(index));
    const owner = copyDiagnosticOwnership(ownData(ownershipValue as object, String(index)));
    if (typeof message !== "string" || message.length > AGENT_MCP_LIMITS.diagnosticChars || owner === undefined) return undefined;
    diagnosticOwnership.push(owner);
  }
  const items: ValidatedAgentDeclaration["items"] = [];
  for (let index = 0; index < itemCount; index++) {
    const item = ownData(itemsValue as object, String(index));
    if (!safeRecord(item, ITEM_KEYS)) {
      items.push({ kind: "inline", name: "invalid-agent-server" });
      continue;
    }
    const kind = ownData(item, "kind");
    const nameValue = ownData(item, "name");
    const nameValid = typeof nameValue === "string" && nameValue.length <= AGENT_MCP_LIMITS.serverNameChars &&
      AGENT_SERVER_NAME_RE.test(nameValue) && !nameValue.includes("__");
    const name = nameValid ? nameValue : "invalid-agent-server";
    if (kind === "reference" && nameValid && ownData(item, "entry") === missingData) {
      items.push({ kind, name });
    } else if (kind === "inline") {
      const entryValue = ownData(item, "entry");
      items.push({ kind, name, ...(!nameValid || entryValue === missingData ? {} : { entry: copyNormalizedEntry(entryValue, name) }) });
    } else {
      items.push({ kind: "inline", name });
    }
  }
  return { scope, diagnosticOwnership, items };
}

// Captured agent admission consumes preclassified policy/review authority. It resolves inert
// declarations without later filesystem or Git I/O and cannot mutate ordinary MCP resolution.
function createAgentMcpAdmissionContext(input: {
  policy: CompiledMcpPolicy;
  env: NodeJS.ProcessEnv;
  enabledNames?: ReadonlySet<string>;
  disabledNames?: ReadonlySet<string>;
  enableAll?: boolean;
  reviewSnapshot?: McpReviewSnapshot;
  reviewSnapshotInvalid?: boolean;
  unavailable?: boolean;
  remoteWorkHooksForTest?: RemoteMcpWorkHooks;
}): AgentMcpAdmissionContext {
  const enabledNames = input.enabledNames ?? new Set<string>();
  const disabledNames = input.disabledNames ?? new Set<string>();
  const unavailable = input.unavailable === true;
  const resolve = (declaration: AgentMcpDeclaration, owner?: McpAgentOwner): ResolvedAgentMcpConfig => {
    const diagnostics: string[] = [];
    const diagnosticOwnership: AgentMcpDiagnosticOwnership[] = [];
    const servers: ResolvedAgentMcpServer[] = [];
    const administrationEntries: NormalizedAgentMcpEntry[] = [];
    let diagnosticCount = 0;
    let diagnosticsOmitted = false;
    const collectDiagnostics = (messages: readonly string[], perServer = false): string[] => {
      const retained: string[] = [];
      for (const message of messages) {
        if (retained.length >= (perServer ? AGENT_ADMISSION_DIAGNOSTIC_LIMITS.perServer : AGENT_ADMISSION_DIAGNOSTIC_LIMITS.aggregate - 1) ||
          diagnosticCount >= AGENT_ADMISSION_DIAGNOSTIC_LIMITS.aggregate - 1) {
          diagnosticsOmitted = true;
          continue;
        }
        retained.push(safeAdmissionDiagnostic(message));
        diagnosticCount++;
      }
      return retained;
    };
    const unowned = (): AgentMcpDiagnosticOwnership =>
      Object.freeze(Object.assign(Object.create(null), { kind: "unowned" as const })) as AgentMcpDiagnosticOwnership;
    const finish = (): ResolvedAgentMcpConfig => {
      if (diagnosticsOmitted) {
        diagnostics.push(AGENT_ADMISSION_OMISSION);
        diagnosticOwnership.push(unowned());
      }
      const administration = owner === undefined ? undefined : Object.freeze({
        version: MCP_ADMINISTRATION_MODEL_VERSION,
        policyPosture: input.policy.posture,
        observations: Object.freeze(input.reviewSnapshotInvalid === true
          ? ["review-snapshot-unavailable-or-invalid" as const]
          : []),
        declarations: Object.freeze(administrationEntries.map((entry) => {
          const server = servers.find((candidate) => candidate.name === entry.name);
          const digest = createMcpReviewDefinitionDigest(entry as RawMcpEntry);
          const exact = matchingReview(input.reviewSnapshot, "subagent-inline", entry.name, digest, owner, declaration.scope);
          const broadAll = declaration.scope === "project" && input.enableAll === true;
          const broadName = declaration.scope === "project" && enabledNames.has(sanitizeForListMatch(entry.name));
          const rejectedCompatibility = disabledNames.has(sanitizeForListMatch(entry.name));
          const review: McpReviewPosture = declaration.scope !== "project"
            ? "not-required"
            : rejectedCompatibility ? "rejected-compatibility"
              : exact === "rejected" ? "rejected-exact"
                : broadAll ? "approved-broad-all"
                  : broadName ? "approved-broad-name"
                    : exact === "approved" ? "approved-exact" : "pending";
          const serverInactiveReason = server !== undefined && "inactiveReason" in server
            ? server.inactiveReason
            : undefined;
          const policy: McpAdministrationDeclaration["policy"] = server?.status === "blocked"
            ? (serverInactiveReason as McpPolicyInactiveReason)
            : entry.skipped || entry.notConfigured ? "invalid" : "allowed";
          return Object.freeze({
            name: entry.name,
            source: "subagent-inline" as const,
            agentOwner: Object.freeze({ ...owner }),
            authority: Object.freeze({ kind: "read-only" as const, sourceClass: "subagent-inline" as const }),
            precedence: "winner" as const,
            ...(digest === undefined ? {} : { definitionVersion: MCP_REVIEW_DEFINITION_VERSION, definitionDigest: digest }),
            summary: safeDeclarationSummary(entry as RawMcpEntry),
            policy,
            review,
            status: server?.status ?? "skipped",
            ...(serverInactiveReason === undefined ? {} : { inactiveReason: serverInactiveReason }),
          });
        })),
        omittedDeclarationCount: 0,
      }) satisfies McpAdministrationTrace | undefined;
      return Object.freeze({
        servers: Object.freeze(servers),
        diagnostics: Object.freeze(diagnostics),
        diagnosticOwnership: Object.freeze(diagnosticOwnership),
        ...(administration === undefined ? {} : { administration }),
      });
    };
    try {
      const validated = validateAgentDeclaration(declaration);
      if (validated === undefined) {
        diagnostics.push("Agent MCP admission declaration is malformed; inline servers remain inactive");
        diagnosticOwnership.push(unowned());
        return finish();
      }
      if (validated.diagnosticOwnership.length > 0) {
        diagnostics.push(...collectDiagnostics([
          "Some agent MCP entries were invalid and ignored; valid entries remain available. Review the agent mcpServers declaration.",
        ]));
        const first = validated.diagnosticOwnership[0]!;
        const sameServerOwner = first.kind === "server" && validated.diagnosticOwnership.every(
          (owner) => owner.kind === "server" && owner.serverName === first.serverName,
        );
        diagnosticOwnership.push(sameServerOwner ? first : unowned());
      }
      for (const item of validated.items) {
        if (item.kind === "reference") continue;
        if (item.entry === undefined || unavailable) {
          servers.push({
            name: item.name,
            source: "subagent-inline",
            status: "skipped",
            inactiveReason: "admission-unavailable",
            diagnostics: collectDiagnostics([item.entry === undefined
              ? "Agent MCP inline entry is malformed; server remains inactive"
              : "Agent MCP admission authority is unavailable; server remains inactive"], true),
          });
          continue;
        }
        const entry = item.entry;
        administrationEntries.push(entry);
        const transportIdentity = entry.remote === undefined
          ? { transport: "stdio" as const }
          : { transport: entry.remote.transportKind, configuredType: entry.remote.configuredType };
        if (entry.notConfigured) {
          servers.push({ name: entry.name, source: "subagent-inline", ...transportIdentity, status: "not-configured", diagnostics: [] });
          continue;
        }

        const decision = evaluateMcpPolicy(input.policy, entry.remote === undefined
          ? { name: entry.name, source: "subagent-inline", transport: "stdio", command: entry.command, args: entry.args }
          : { name: entry.name, source: "subagent-inline", transport: entry.remote.transportKind, url: entry.remote.rawUrl });
        if (decision.status === "blocked") {
          const inactiveReason = agentPolicyReason(decision.reason);
          const overflowCategory = entry.remote === undefined && decision.reason === "candidate-invalid"
            ? findAgentStdioIdentityOverflow(entry, input.env)
            : undefined;
          servers.push({
            name: entry.name,
            source: "subagent-inline",
            ...transportIdentity,
            status: "blocked",
            ...(inactiveReason === undefined ? {} : { inactiveReason }),
            diagnostics: overflowCategory === undefined
              ? []
              : collectDiagnostics([agentStdioOverflowDiagnostic(overflowCategory)], true),
          });
          continue;
        }
        if (disabledNames.has(sanitizeForListMatch(entry.name))) {
          servers.push({ name: entry.name, source: "subagent-inline", ...transportIdentity, status: "disabled", inactiveReason: "mcpjson-rejected", diagnostics: [] });
          continue;
        }
        if (validated.scope === "project") {
          const digest = createMcpReviewDefinitionDigest(entry as RawMcpEntry);
          const exact = matchingReview(input.reviewSnapshot, "subagent-inline", entry.name, digest, owner, validated.scope);
          if (exact === "rejected") {
            servers.push({ name: entry.name, source: "subagent-inline", ...transportIdentity, status: "disabled", inactiveReason: "mcpjson-rejected", diagnostics: [] });
            continue;
          }
          if (input.enableAll !== true && !enabledNames.has(sanitizeForListMatch(entry.name)) && exact !== "approved") {
            servers.push({ name: entry.name, source: "subagent-inline", ...transportIdentity, status: "pending-approval", inactiveReason: "mcpjson-unapproved", diagnostics: [] });
            continue;
          }
        }

        if (entry.remote !== undefined) {
          const resolved = resolveRemoteMcpFields(entry.remote, input.env, () => undefined, entry.name, "agent mcpServers declaration", input.remoteWorkHooksForTest);
          const perDiagnostics = collectDiagnostics(resolved.diagnostics, true);
          if (resolved.kind === "skipped") {
            servers.push({ name: entry.name, source: "subagent-inline", ...transportIdentity, status: "skipped", diagnostics: perDiagnostics });
          } else {
            servers.push({ name: entry.name, source: "subagent-inline", ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }), status: "enabled", transport: resolved.fields.transportKind, configuredType: resolved.fields.configuredType, url: resolved.fields.url, headers: resolved.fields.headers, ...(resolved.fields.sseDeprecation === undefined ? {} : { sseDeprecation: resolved.fields.sseDeprecation }), diagnostics: perDiagnostics });
          }
          continue;
        }

        const unset = new Set<string>();
        const expand = (value: string): string => expandEnvVars(
          value,
          input.env,
          (name) => { unset.add(name); },
          AGENT_MCP_LIMITS.stringChars,
        );
        const command = expand(entry.command);
        const args: string[] = [];
        const expandedEnv = Object.create(null) as Record<string, string>;
        let overflowCategory: AgentStdioOverflowCategory | undefined =
          command.length > AGENT_MCP_LIMITS.stringChars ? "command" : undefined;
        if (overflowCategory === undefined) {
          for (const arg of entry.args) {
            const expanded = expand(arg);
            if (expanded.length > AGENT_MCP_LIMITS.stringChars) {
              overflowCategory = "argument";
              break;
            }
            args.push(expanded);
          }
        }
        if (overflowCategory === undefined) {
          for (const [key, value] of Object.entries(entry.env)) {
            const expanded = expand(value);
            if (expanded.length > AGENT_MCP_LIMITS.stringChars) {
              overflowCategory = "environment value";
              break;
            }
            expandedEnv[key] = expanded;
          }
        }
        if (overflowCategory !== undefined) {
          servers.push({
            name: entry.name,
            source: "subagent-inline",
            transport: "stdio",
            status: "skipped",
            inactiveReason: "admission-unavailable",
            diagnostics: collectDiagnostics([agentStdioOverflowDiagnostic(overflowCategory)], true),
          });
          continue;
        }
        const perDiagnostics = collectDiagnostics(Array.from(unset, (name) =>
          `environment variable ${JSON.stringify(name)} is not set and has no default; literal retained`), true);
        servers.push({ name: entry.name, source: "subagent-inline", ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }), status: "enabled", transport: "stdio", command, args, env: expandedEnv, rawCommand: entry.command, diagnostics: perDiagnostics });
      }
    } catch {
      return Object.freeze({
        servers: Object.freeze([]),
        diagnostics: Object.freeze(["Agent MCP admission failed safely; inline servers remain inactive"]),
        diagnosticOwnership: Object.freeze([unowned()]),
      });
    }
    return finish();
  };
  return Object.freeze({
    resolve: (declaration: AgentMcpDeclaration) => resolve(declaration),
    resolveOwned: (declaration: AgentMcpDeclaration, owner: McpAgentOwner) => resolve(declaration, owner),
  });
}

function publishAgentAdmission(
  capture: ResolveMcpConfigOptions["captureAgentMcpAdmission"],
  context: AgentMcpAdmissionContext,
): void {
  try {
    capture?.(context);
  } catch {
    // Capturing authority is a production handoff, but ordinary MCP remains independently usable.
  }
}

/** Resolve precedence + the enablement gate into the runtime's data contract. */
export function resolveMcpConfig(opts: ResolveMcpConfigOptions): ResolvedMcpConfig {
  const reviewValidation = validateAndCopyMcpReviewSnapshot(opts.reviewSnapshot);
  const reviewSnapshot = reviewValidation.snapshot;
  const environment = snapshotEnvironment(opts.env ?? process.env);
  const env = environment.env;
  const probe = opts.isGitTracked ?? defaultGitTrackedProbe;
  const trackedCache = new Map<string, boolean | undefined>();
  const classifyTracked = (filePath: string): boolean | undefined => {
    if (trackedCache.has(filePath)) return trackedCache.get(filePath);
    let tracked: boolean | undefined;
    try {
      tracked = probe(filePath, opts.projectRoot);
    } catch {
      tracked = undefined;
    }
    trackedCache.set(filePath, tracked);
    return tracked;
  };
  const diagnostics: string[] = [];
  const pushDiag = (message: string): void => {
    diagnostics.push(neutralizeControlChars(message));
  };
  const managedMcp = opts.managedMcp ?? { status: "absent" as const };
  const exclusiveCount = managedMcp.status === "loaded" ? managedMcp.servers.length : undefined;
  const standaloneFailure: McpPolicySourceFailure | undefined = managedMcp.status === "unusable"
    ? {
        kind: managedMcp.reason === "malformed" || managedMcp.reason === "wrong-root" || managedMcp.reason === "invalid-encoding"
          ? "malformed"
          : managedMcp.reason === "oversized" ? "omitted" : "unreadable",
        sourceClass: "standalone-mcp",
        authority: "administrator-controlled",
        remediation: "repair-administrator-policy",
      }
    : undefined;
  const suppliedFailures = opts.mcpPolicySourceFailures ?? [];
  const failures = standaloneFailure === undefined
    ? suppliedFailures
    : [standaloneFailure, ...suppliedFailures.slice(0, MCP_POLICY_LIMITS.sourceFailures - 1)];
  const failureOmitted = standaloneFailure !== undefined && suppliedFailures.length >= MCP_POLICY_LIMITS.sourceFailures;
  const policy = compileMcpPolicy({
    settings: opts.mcpPolicySettings ?? [],
    sourceFailures: failures,
    ...(exclusiveCount === undefined ? {} : { exclusiveManagedServerCount: exclusiveCount }),
    env,
    environmentUnavailable: environment.unavailable,
    restrictiveMaterialOmitted: opts.mcpPolicyRestrictiveMaterialOmitted === true || failureOmitted,
  });
  const admissionObservations = new Set(policy.observations);
  const policySnapshot = {
    policyPosture: policy.posture,
    policyAuthority: policy.authority,
    policyObservations: policy.observations,
    policyFailures: policy.failures,
    ...(managedMcp.status === "absent" ? {} : { policyOrdinarySourcesSuppressed: true as const }),
  };
  if (policy.posture === "fail-closed") {
    publishAgentAdmission(opts.captureAgentMcpAdmission, createAgentMcpAdmissionContext({
      policy,
      env,
      ...(reviewSnapshot === undefined ? {} : { reviewSnapshot }),
      ...(reviewValidation.invalid ? { reviewSnapshotInvalid: true } : {}),
      ...(opts.remoteWorkHooksForTest === undefined ? {} : { remoteWorkHooksForTest: opts.remoteWorkHooksForTest }),
    }));
    return { servers: [], diagnostics, ...policySnapshot, administration: emptyAdministration(policy.posture, managedMcp.status !== "absent", reviewValidation.invalid) };
  }
  if (policy.posture === "exclusive-empty") {
    publishAgentAdmission(opts.captureAgentMcpAdmission, createAgentMcpAdmissionContext({
      policy,
      env,
      ...(reviewSnapshot === undefined ? {} : { reviewSnapshot }),
      ...(reviewValidation.invalid ? { reviewSnapshotInvalid: true } : {}),
      ...(opts.remoteWorkHooksForTest === undefined ? {} : { remoteWorkHooksForTest: opts.remoteWorkHooksForTest }),
    }));
    return { servers: [], diagnostics, ...policySnapshot, administration: emptyAdministration(policy.posture, true, reviewValidation.invalid) };
  }

  const exclusive = managedMcp.status === "loaded";
  const ordinary = !exclusive && opts.loadOrdinaryMcp !== undefined
    ? opts.loadOrdinaryMcp()
    : undefined;
  const mcpJson = ordinary?.mcpJson ?? opts.mcpJson ?? { servers: [], diagnostics: [], present: false };
  if (!exclusive) diagnostics.push(...mcpJson.diagnostics);
  const nativeState = exclusive
    ? { kind: "absent" as const, diagnostics: [] }
    : ordinary?.nativeState ?? opts.nativeState ?? { kind: "absent" as const, diagnostics: [] };
  if (nativeState.kind === "unusable") {
    publishAgentAdmission(opts.captureAgentMcpAdmission, createAgentMcpAdmissionContext({
      policy,
      env,
      unavailable: true,
      ...(reviewSnapshot === undefined ? {} : { reviewSnapshot }),
      ...(reviewValidation.invalid ? { reviewSnapshotInvalid: true } : {}),
      ...(opts.remoteWorkHooksForTest === undefined ? {} : { remoteWorkHooksForTest: opts.remoteWorkHooksForTest }),
    }));
    return {
      servers: [],
      diagnostics: nativeState.diagnostics.map(neutralizeControlChars),
      failClosed: "native-state-unusable",
      ...(opts.nativeStateProfile === undefined ? {} : { failClosedProfile: opts.nativeStateProfile }),
      ...policySnapshot,
      policyPosture: "fail-closed",
      administration: emptyAdministration("fail-closed", false, reviewValidation.invalid),
    };
  }
  if (nativeState.kind === "loaded") diagnostics.push(...nativeState.diagnostics.map(neutralizeControlChars));

  // --- Effective origin per settings entry (git-tracked local demotion) -----
  const ordinarySettings = exclusive ? [] : opts.mcpSettings;
  const normalizedSettingsServers = ordinarySettings.map((entry) => entry.servers === undefined
    ? []
    : normalizeMcpServerBlock(entry.servers, settingsMcpSource(entry.scope)));
  const isPolicyAdmissible = (server: RawMcpEntry, source: McpSourceClass): boolean =>
    !server.skipped && !server.notConfigured && evaluateMcpPolicy(policy, server.remote === undefined
      ? { name: server.name, source, transport: "stdio", command: server.command, args: server.args }
      : { name: server.name, source, transport: server.remote.transportKind, url: server.remote.rawUrl }).status === "allowed";
  const higherFixedNames = new Set<string>([
    ...(nativeState.kind === "loaded" ? nativeState.user.servers.map((server) => server.name) : []),
    ...(nativeState.kind === "loaded" ? nativeState.local.servers.map((server) => server.name) : []),
    ...mcpJson.servers.map((server) => server.name),
    ...ordinarySettings.flatMap((setting, index) => setting.scope === "managed"
      ? normalizedSettingsServers[index]!.map((server) => server.name)
      : []),
  ]);
  const nativeLocalNames = new Set(nativeState.kind === "loaded"
    ? nativeState.local.servers.map((server) => server.name)
    : []);
  const approvalTargets = new Map<string, { server: RawMcpEntry; source: McpSourceClass }>();
  for (const server of mcpJson.servers) {
    if (!nativeLocalNames.has(server.name)) approvalTargets.set(server.name, { server, source: "project-mcpjson" });
  }
  for (let index = 0; index < ordinarySettings.length; index += 1) {
    if (ordinarySettings[index]!.scope !== "project") continue;
    for (const server of normalizedSettingsServers[index]!) {
      if (!higherFixedNames.has(server.name)) approvalTargets.set(server.name, { server, source: "settings-project" });
    }
  }
  const entries = ordinarySettings.map((entry, entryIndex) => {
    let origin: McpOrigin;
    let demoted = false;
    switch (entry.scope) {
      case "managed":
        origin = "settings-managed";
        break;
      case "local": {
        origin = "settings-local";
        // Demotion only matters for keys the gate treats differently by scope.
        // A file contributing ONLY disabledMcpjsonServers (honored from every
        // scope) needs no probe and no diagnostic — demotion changes nothing.
        const localServers = normalizedSettingsServers[entryIndex]!;
        const serverClassificationMatters = localServers.some((server) => {
          if (higherFixedNames.has(server.name)) return false;
          const projectContender = approvalTargets.get(server.name);
          return isPolicyAdmissible(server, "settings-local") || projectContender !== undefined &&
            projectContender.source === "settings-project" &&
            isPolicyAdmissible(projectContender.server, projectContender.source);
        });
        const approvalNames = new Set((entry.enabledMcpjsonServers ?? []).map(sanitizeForListMatch));
        const approvalClassificationMatters = [...approvalTargets.entries()].some(([name, target]) =>
          (entry.enableAllProjectMcpServers !== undefined || approvalNames.has(sanitizeForListMatch(name))) &&
          isPolicyAdmissible(target.server, target.source));
        if (!serverClassificationMatters && !approvalClassificationMatters) break;
        // A misbehaving injected probe must not break never-throw. Failure leaves
        // declaration origin unchanged but never authorizes checkout-local approval.
        const tracked = classifyTracked(entry.sourcePath);
        if (tracked === true) {
          origin = "settings-project";
          demoted = true;
          pushDiag(
            `"${entry.sourcePath}" is tracked by git, so a cloned repo could have authored it; ` +
              `its MCP configuration is treated as project scope (approvals ignored; any contributed servers are pending)`,
          );
        }
        break;
      }
      case "project":
        origin = "settings-project";
        break;
      default:
        origin = "settings-user";
        break;
    }
    return { entry, origin, demoted };
  });

  // --- Approvals ------------------------------------------------------------
  let enableAll: boolean | undefined;
  const enabledNames = new Set<string>();
  const disabledNames = new Set<string>();
  for (const { entry, origin, demoted } of entries) {
    // disabledMcpjsonServers is honored from EVERY scope and always wins.
    for (const name of entry.disabledMcpjsonServers ?? []) {
      disabledNames.add(sanitizeForListMatch(name));
    }
    const honored = origin === "settings-user" || origin === "settings-managed";
    if (!honored) {
      if (entry.enableAllProjectMcpServers !== undefined || entry.enabledMcpjsonServers !== undefined) {
        pushDiag(
          `MCP approvals ("enableAllProjectMcpServers"/"enabledMcpjsonServers") in checkout-controlled ` +
            `settings are ignored because project bytes cannot authorize project MCP definitions. Independently ` +
            `review definitions, then use user or managed settings compatibility grants, or PiCC's private ` +
            `exact-definition review state (${entry.sourcePath}${demoted ? "; tracked local file" : ""})`,
        );
      }
      continue;
    }
    // Ascending-precedence file order: the last honored value is nearest-wins.
    if (entry.enableAllProjectMcpServers !== undefined) enableAll = entry.enableAllProjectMcpServers;
    for (const name of entry.enabledMcpjsonServers ?? []) {
      enabledNames.add(sanitizeForListMatch(name));
    }
  }

  // Agent project approvals consume the same user/managed compatibility grants.
  publishAgentAdmission(opts.captureAgentMcpAdmission, createAgentMcpAdmissionContext({
    policy,
    env,
    enabledNames,
    disabledNames,
    ...(enableAll === undefined ? {} : { enableAll }),
    ...(reviewSnapshot === undefined ? {} : { reviewSnapshot }),
    ...(reviewValidation.invalid ? { reviewSnapshotInvalid: true } : {}),
    ...(opts.remoteWorkHooksForTest === undefined ? {} : { remoteWorkHooksForTest: opts.remoteWorkHooksForTest }),
  }));

  // --- Candidates & whole-entry precedence ---------------------------------
  let order = 0;
  // Map (not a plain object): server names may be "constructor"/"toString".
  const winners = new Map<string, Candidate>();
  const candidates: Candidate[] = [];
  const consider = (candidate: Candidate): void => {
    candidates.push(candidate);
    const current = winners.get(candidate.entry.name);
    if (
      current === undefined ||
      ORIGIN_RANK[candidate.origin] > ORIGIN_RANK[current.origin] ||
      (ORIGIN_RANK[candidate.origin] === ORIGIN_RANK[current.origin] && candidate.order > current.order)
    ) {
      winners.set(candidate.entry.name, candidate);
    }
  };
  if (managedMcp.status === "loaded") {
    for (const entry of managedMcp.servers) {
      consider({
        entry,
        origin: "managed-mcp",
        authentic: true,
        projectApprovalRequired: false,
        order: order++,
        source: "managed-mcp",
      });
    }
  }
  if (nativeState.kind === "loaded") {
    for (const entry of nativeState.user.servers) {
      consider({
        entry,
        origin: "native-user",
        authentic: true,
        projectApprovalRequired: false,
        order: order++,
        source: "native-user",
      });
    }
  }
  if (!exclusive) {
    for (const entry of mcpJson.servers) {
      consider({
        entry,
        origin: "mcpjson",
        authentic: true,
        projectApprovalRequired: true,
        order: order++,
        source: "project-mcpjson",
      });
    }
  }
  for (const [entryIndex, { entry, origin }] of entries.entries()) {
    if (entry.servers === undefined) continue;
    // Source reports the physical settings scope; a tracked local contribution
    // stays settings-local for display even when gating demotes its origin.
    const source = settingsMcpSource(entry.scope);
    for (const raw of normalizedSettingsServers[entryIndex]!) {
      consider({
        entry: raw,
        origin,
        authentic: false,
        projectApprovalRequired: origin === "settings-project",
        order: order++,
        source,
      });
    }
  }
  if (nativeState.kind === "loaded") {
    for (const entry of nativeState.local.servers) {
      consider({
        entry,
        origin: "native-local",
        authentic: true,
        projectApprovalRequired: false,
        order: order++,
        source: "native-local",
      });
    }
  }

  // --- Status + enabled-only expansion per winning entry -------------------
  const servers: ResolvedMcpServer[] = [];
  for (const { entry, authentic, projectApprovalRequired, source } of winners.values()) {
    const perDiags = [...entry.diagnostics];
    let status: McpServerStatus;
    let inactiveReason: McpInactiveReason | undefined;
    let policyInactiveReason: McpPolicyInactiveReason | undefined;
    if (entry.skipped) {
      status = "skipped";
    } else if (entry.notConfigured) {
      status = "not-configured";
    } else {
      const decision = evaluateMcpPolicy(policy, entry.remote === undefined
        ? {
            name: entry.name,
            source,
            transport: "stdio",
            command: entry.command,
            args: entry.args,
          }
        : {
            name: entry.name,
            source,
            transport: entry.remote.transportKind,
            url: entry.remote.rawUrl,
          });
      if ("observations" in decision) {
        for (const observation of decision.observations) admissionObservations.add(observation);
      }
      if (decision.status === "blocked") {
        status = "blocked";
        switch (decision.reason) {
          case "denied": policyInactiveReason = "policy-denied"; break;
          case "allow-miss": policyInactiveReason = "policy-allow-miss"; break;
          case "managed-only": policyInactiveReason = "policy-managed-only"; break;
          case "candidate-invalid": policyInactiveReason = "policy-candidate-invalid"; break;
          case "exclusive-control":
          case "fail-closed":
          case "allowed":
            // Aggregate-only decisions cannot reach a row; fail safely if an
            // invalid compiled token or future engine regression does so.
            policyInactiveReason = "policy-candidate-invalid";
            break;
        }
      } else {
        const digest = createMcpReviewDefinitionDigest(entry);
        const exactReview = projectApprovalRequired
          ? matchingReview(reviewSnapshot, source, entry.name, digest)
          : undefined;
        if ((!authentic || source === "project-mcpjson") && disabledNames.has(sanitizeForListMatch(entry.name))) {
          status = "disabled";
          inactiveReason = "mcpjson-rejected";
        } else if (projectApprovalRequired && exactReview === "rejected") {
          status = "disabled";
          inactiveReason = "mcpjson-rejected";
        } else if (projectApprovalRequired && enableAll !== true &&
          !enabledNames.has(sanitizeForListMatch(entry.name)) && exactReview !== "approved") {
          status = "pending-approval";
          inactiveReason = "mcpjson-unapproved";
        } else if (authentic && nativeState.kind === "loaded" && nativeState.disabledMcpServers.has(entry.name)) {
          status = "disabled";
          inactiveReason = "native-runtime-disabled";
        } else {
          status = "enabled";
        }
      }
    }

    const common = {
      name: entry.name,
      source,
      ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    };
    const transportIdentity = entry.remote === undefined
      ? (entry.skipped ? {} : { transport: "stdio" as const })
      : {
          transport: entry.remote.transportKind,
          configuredType: entry.remote.configuredType,
        };

    // Inactive entries carry identity only: no raw templates, expanded values,
    // or fabricated fields can escape the resolver pipeline.
    if (status === "blocked") {
      servers.push({
        name: entry.name,
        source,
        ...transportIdentity,
        status: "blocked",
        inactiveReason: policyInactiveReason!,
        diagnostics: perDiags,
      });
      continue;
    }
    if (status !== "enabled") {
      servers.push({
        ...common,
        ...transportIdentity,
        status,
        ...(inactiveReason === undefined ? {} : { inactiveReason }),
        diagnostics: perDiags,
      });
      continue;
    }

    const unset = new Set<string>();
    const onUnset = (name: string): void => { unset.add(name); };
    if (entry.remote !== undefined) {
      const resolved = resolveRemoteMcpFields(
        entry.remote,
        env,
        onUnset,
        entry.name,
        source,
        opts.remoteWorkHooksForTest,
      );
      if (resolved.kind === "skipped") {
        servers.push({
          ...common,
          ...transportIdentity,
          status: "skipped",
          diagnostics: [...perDiags, ...resolved.diagnostics.map(neutralizeControlChars)],
        });
        continue;
      }
      servers.push({
        ...common,
        status: "enabled",
        transport: resolved.fields.transportKind,
        configuredType: resolved.fields.configuredType,
        url: resolved.fields.url,
        headers: resolved.fields.headers,
        ...(resolved.fields.sseDeprecation !== undefined
          ? { sseDeprecation: resolved.fields.sseDeprecation }
          : {}),
        diagnostics: [...perDiags, ...resolved.diagnostics.map(neutralizeControlChars)],
      });
      continue;
    }

    const command = expandEnvVars(entry.command, env, onUnset);
    const args = entry.args.map((arg) => expandEnvVars(arg, env, onUnset));
    const expandedEnv: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(entry.env)) {
      expandedEnv[key] = expandEnvVars(value, env, onUnset);
    }
    for (const name of unset) {
      perDiags.push(neutralizeControlChars(
        `environment variable "${name}" is not set and has no default; "\${${name}}" kept as literal text`,
      ));
    }
    servers.push({
      ...common,
      status: "enabled",
      transport: "stdio",
      command,
      args,
      env: expandedEnv,
      rawCommand: entry.command,
      diagnostics: perDiags,
    });
  }

  const traceCandidates = [
    ...candidates.filter((candidate) => winners.get(candidate.entry.name) === candidate),
    ...candidates.filter((candidate) => winners.get(candidate.entry.name) !== candidate),
  ].slice(0, MCP_ADMINISTRATION_TRACE_LIMITS.declarations);
  const omittedDeclarationCount = candidates.length - traceCandidates.length;
  const administrationDeclarations = traceCandidates.map((candidate): McpAdministrationDeclaration => {
    const { entry, source, projectApprovalRequired } = candidate;
    const winner = winners.get(entry.name) === candidate;
    const resolved = winner ? servers.find((server) => server.name === entry.name) : undefined;
    const digest = createMcpReviewDefinitionDigest(entry);
    const exact = projectApprovalRequired ? matchingReview(reviewSnapshot, source, entry.name, digest) : undefined;
    const rejectedCompatibility = (!candidate.authentic || source === "project-mcpjson") &&
      disabledNames.has(sanitizeForListMatch(entry.name));
    const broadAll = projectApprovalRequired && enableAll === true;
    const broadName = projectApprovalRequired && enabledNames.has(sanitizeForListMatch(entry.name));
    const review: McpReviewPosture = !projectApprovalRequired
      ? "not-required"
      : rejectedCompatibility ? "rejected-compatibility"
        : exact === "rejected" ? "rejected-exact"
          : broadAll ? "approved-broad-all"
            : broadName ? "approved-broad-name"
              : exact === "approved" ? "approved-exact" : "pending";
    const policyDecision = entry.skipped || entry.notConfigured ? undefined : evaluateMcpPolicy(policy, entry.remote === undefined
      ? { name: entry.name, source, transport: "stdio", command: entry.command, args: entry.args }
      : { name: entry.name, source, transport: entry.remote.transportKind, url: entry.remote.rawUrl });
    const policyTrace = entry.skipped || entry.notConfigured
      ? "invalid"
      : policyDecision?.status === "allowed" ? "allowed"
        : agentPolicyReason(policyDecision?.reason ?? "candidate-invalid") ?? "policy-candidate-invalid";
    const resolvedInactiveReason = resolved !== undefined && "inactiveReason" in resolved
      ? resolved.inactiveReason
      : undefined;
    return Object.freeze({
      name: entry.name,
      source,
      authority: candidateAuthority(source),
      precedence: winner ? "winner" : "shadowed",
      ...(digest === undefined ? {} : { definitionVersion: MCP_REVIEW_DEFINITION_VERSION, definitionDigest: digest }),
      summary: safeDeclarationSummary(entry),
      policy: policyTrace,
      review,
      status: winner ? (resolved?.status ?? "skipped") : "shadowed",
      ...(resolvedInactiveReason === undefined ? {} : { inactiveReason: resolvedInactiveReason }),
    });
  });
  const administration: McpAdministrationTrace = Object.freeze({
    version: MCP_ADMINISTRATION_MODEL_VERSION,
    policyPosture: policy.posture,
    observations: Object.freeze([
      ...(managedMcp.status === "absent" ? [] : ["ordinary-sources-suppressed-by-managed-mcp" as const]),
      ...(reviewValidation.invalid ? ["review-snapshot-unavailable-or-invalid" as const] : []),
      ...(omittedDeclarationCount > 0 ? ["administration-declarations-omitted" as const] : []),
    ]),
    declarations: Object.freeze(administrationDeclarations),
    omittedDeclarationCount,
  });
  return {
    servers,
    diagnostics,
    ...policySnapshot,
    policyObservations: Object.freeze([...admissionObservations]),
    administration,
  };
}

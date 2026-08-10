import {
  PLUGIN_INVENTORY_SESSION_BOUNDARY,
  type PluginInventoryCapabilityEvidence,
  type PluginInventoryDiagnostic,
  type PluginInventoryItem,
  type PluginInventoryLocation,
  type PluginInventoryProvenance,
  type PluginInventorySnapshot,
} from "../plugin-inventory.js";
import { parseQualifiedPluginId } from "../util/plugin-id.js";
import { formatPluginInventoryStructuredSource } from "./plugin-inventory-display.js";

const MAX_INPUT = 512;
const MAX_LIST_ITEMS = 100;
const MAX_DETAIL_VALUES = 32;
const MAX_DIAGNOSTICS = 64;
const MAX_EVIDENCE = 128;
const MAX_STARTUP_POLICY_EVIDENCE = 3;
const MAX_DOCTOR_POLICY_EVIDENCE = 10;
const MAX_LINE = 320;

export const PLUGIN_INVENTORY_SLASH_USAGE = "Read-only usage: /plugin list | /plugin details <plugin@marketplace> (example: /plugin details formatter@official). Run /plugin list to copy an exact qualified identity.";
export const PLUGIN_INVENTORY_ARGV_USAGE = "Read-only usage: picc plugin list | picc plugin details <plugin@marketplace> (example: picc plugin details formatter@official). Run picc plugin list to copy an exact qualified identity.";

export type PluginInventoryOperation =
  | { readonly kind: "list" }
  | { readonly kind: "details"; readonly qualifiedIdentity: string };

export type PluginInventoryOperationParseResult =
  | { readonly kind: "operation"; readonly operation: PluginInventoryOperation }
  | { readonly kind: "usage"; readonly usage: string };

export interface PluginInventoryManagedPolicyEvidence {
  readonly category: "managed-policy-malformed" | "managed-policy-unreadable";
  readonly condition: "malformed" | "unreadable";
  readonly sourceClass: string;
  readonly sourceLabel: string;
  readonly impact: "source-ignored";
  readonly guidance: string;
  readonly refreshGuidance: string;
}

export interface PluginInventoryCaptureOmission {
  readonly axis: string;
  readonly count: number;
}

export interface PluginInventoryStartupProjection {
  readonly needsAttention: boolean;
  readonly qualifiedIdentities: readonly string[];
  readonly managedPolicyEvidence: readonly PluginInventoryManagedPolicyEvidence[];
  readonly omissions: Readonly<{ identities: number; managedPolicyEvidence: number; captureEvidence: readonly PluginInventoryCaptureOmission[] }>;
  readonly text?: string;
}

export interface PluginInventoryDoctorDiagnostic {
  readonly qualifiedIdentity?: string;
  readonly global: boolean;
  readonly severity: PluginInventoryDiagnostic["severity"];
  readonly message: string;
  readonly status?: string;
  readonly nextCommand?: string;
  readonly repairBoundary?: string;
  readonly refreshGuidance?: string;
}

export interface PluginInventoryDoctorProjection {
  readonly counts: Readonly<{ known: number; installed: number; enabled: number; loaded: number; cataloged: number; attention: number }>;
  readonly diagnostics: readonly PluginInventoryDoctorDiagnostic[];
  readonly capabilityEvidence: readonly PluginInventoryCapabilityEvidence[];
  readonly managedPolicyEvidence: readonly PluginInventoryManagedPolicyEvidence[];
  readonly captureOmissions: readonly PluginInventoryCaptureOmission[];
  readonly omitted: Readonly<{
    diagnostics: Readonly<{ capture: number; projection: number }>;
    capabilityEvidence: Readonly<{ capture: number; projection: number }>;
    managedPolicyEvidence: Readonly<{ projection: number }>;
  }>;
  readonly snapshotBoundary: string;
}

function validQualifiedIdentity(value: string): boolean {
  return parseQualifiedPluginId(value) !== undefined;
}

function parseTokens(tokens: readonly string[], usage: string): PluginInventoryOperationParseResult {
  if (tokens.length === 1 && tokens[0] === "list") return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "list" }) });
  if (tokens.length === 2 && tokens[0] === "details" && validQualifiedIdentity(tokens[1]!)) {
    return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "details", qualifiedIdentity: tokens[1]! }) });
  }
  return Object.freeze({ kind: "usage", usage });
}

export function parsePluginInventorySlash(input: string): PluginInventoryOperationParseResult {
  if (input.length > MAX_INPUT || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.replace(/\t/gu, ""))) return Object.freeze({ kind: "usage", usage: PLUGIN_INVENTORY_SLASH_USAGE });
  const match = /^[ \t]*\/plugin(?:[ \t]+([^\r\n]*?))?[ \t]*$/.exec(input);
  if (match === null || match[1] === undefined) return Object.freeze({ kind: "usage", usage: PLUGIN_INVENTORY_SLASH_USAGE });
  return parseTokens(match[1].split(/[ \t]+/), PLUGIN_INVENTORY_SLASH_USAGE);
}

export function parsePluginInventoryArgv(argv: readonly string[]): PluginInventoryOperationParseResult {
  if (argv.some((token) => token.length > MAX_INPUT || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(token))) return Object.freeze({ kind: "usage", usage: PLUGIN_INVENTORY_ARGV_USAGE });
  return parseTokens(argv, PLUGIN_INVENTORY_ARGV_USAGE);
}

const REDACTED_FIELD = "<redacted-field>";
const REDACTED_URL = "<redacted-url>";
const CREDENTIAL_KEY_SOURCE = String.raw`(?:authorization|proxy[-_.\s]?authorization|passwords?|passwd|tokens?|secrets?|client[-_.\s]secret|credentials?|api[-_.\s]keys?)`;
const CREDENTIAL_KEY = new RegExp(`^${CREDENTIAL_KEY_SOURCE}$`, "iu");
const CREDENTIAL_KEY_SHAPE = new RegExp(String.raw`(?:^|[^\p{L}\p{N}_])['"]?${CREDENTIAL_KEY_SOURCE}['"]?(?:$|[^\p{L}\p{N}_])`, "iu");
const CREDENTIAL_FIELD = new RegExp(String.raw`(?:^|[^\p{L}\p{N}_])['"]?${CREDENTIAL_KEY_SOURCE}['"]?\s*(?::|=|\s+(?=['"]|\S))\s*['"]?\S`, "iu");
const SENSITIVE_NAME = /(?:^|[^\p{L}\p{N}_])(?:\.env(?:\.[\p{L}\p{N}_.-]+)?|\.ssh|id_rsa|id_ed25519|authorized_keys|known_hosts)(?:$|[^\p{L}\p{N}_])/iu;
const MAX_SAFE_DECODE_INPUT = 2_048;
const MAX_SAFE_DECODE_OUTPUT = 4_096;

function safeDecode(value: string): string | undefined {
  if (value.length > MAX_SAFE_DECODE_INPUT) return undefined;
  try {
    let decoded = value;
    for (let pass = 0; pass < 3 && /%[0-9A-Fa-f]{2}/u.test(decoded); pass += 1) decoded = decodeURIComponent(decoded);
    if (/%[0-9A-Fa-f]{2}/u.test(decoded) || decoded.includes("%")) return undefined;
    decoded = decoded.normalize("NFKC");
    return decoded.length <= MAX_SAFE_DECODE_OUTPUT ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function hasCredentialShape(value: string): boolean {
  return CREDENTIAL_FIELD.test(value.normalize("NFKC"));
}

function hasCredentialSegments(value: string): boolean {
  const segments = value.split(/[\\/&=#?]/u).filter(Boolean);
  if (segments.some((segment) => CREDENTIAL_KEY.test(segment) || hasCredentialShape(segment))) return true;
  for (let index = 0; index + 1 < segments.length; index += 1) {
    const pair = `${segments[index]}.${segments[index + 1]}`;
    if (/^(?:api\.keys?|client\.secrets?|passwords?\.values?|passwd\.values?)$/iu.test(pair)) return true;
  }
  return segments.some((segment) => /^(?:api[._-]keys?|client[._-]secrets?|passwords?[._-]values?|passwd[._-]values?)$/iu.test(segment));
}

function urlHasCredentials(parsed: URL): boolean {
  if (parsed.username !== "" || parsed.password !== "") return true;
  const query = safeDecode(parsed.search.slice(1));
  const fragment = safeDecode(parsed.hash.slice(1));
  if (query === undefined || fragment === undefined || hasCredentialShape(query) || hasCredentialShape(fragment) || hasCredentialSegments(query) || hasCredentialSegments(fragment)) return true;
  for (const key of parsed.searchParams.keys()) if (CREDENTIAL_KEY.test((safeDecode(key) ?? key).normalize("NFKC"))) return true;

  const path = safeDecode(parsed.pathname);
  return path === undefined || path.includes("=") || hasCredentialShape(path) || hasCredentialSegments(path);
}

function stripUnsafe(value: string): string {
  let result = value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    .normalize("NFKC")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\|$)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[\p{M}\u{E0100}-\u{E01EF}]/gu, "");

  if (/\\/u.test(result) || /(?:^|[^\p{L}\p{N}])[A-Za-z]:\//u.test(result)) return REDACTED_FIELD;

  const urls: string[] = [];
  let unsafeUrl = false;
  result = result.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:(?=$|[^\s<>'"\[\]])[^\s<>'"\[\]]*/gu, (candidate: string) => {
    if (!/^https?:\/\//iu.test(candidate)) {
      unsafeUrl = true;
      return "";
    }
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || urlHasCredentials(parsed)) {
        unsafeUrl = true;
        return "";
      }
      parsed.search = "";
      parsed.hash = "";
      urls.push(parsed.toString());
      return `PICCSAFEURL${urls.length - 1}TOKEN`;
    } catch {
      unsafeUrl = true;
      return "";
    }
  });
  if (unsafeUrl) return REDACTED_URL;

  if (hasCredentialShape(result) || CREDENTIAL_KEY_SHAPE.test(result) || /[\\/=]/u.test(result) || /:/u.test(result) || SENSITIVE_NAME.test(result)) return REDACTED_FIELD;

  return result
    .replace(/PICCSAFEURL(\d+)TOKEN/gu, (_match: string, index: string) => urls[Number(index)] ?? REDACTED_URL)
    .replace(/[ \t]+/gu, " ")
    .trim();
}

/** Canonical fail-closed projection for generic untrusted inventory text. */
export function sanitizePluginInventoryDisplayText(value: string, maximum = MAX_LINE): string {
  const safe = stripUnsafe(value);
  const points = Array.from(safe);
  return points.length <= maximum ? safe : `${points.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function text(value: string, maximum = MAX_LINE): string {
  return sanitizePluginInventoryDisplayText(value, maximum);
}

function qualified(value: string): string {
  return validQualifiedIdentity(value) ? value : "unknown@unknown";
}

/** Canonical allowlisted display for structured, already-anchored inventory locations. */
export function formatPluginInventoryDisplayLocation(value: PluginInventoryLocation | undefined): string {
  if (value === undefined) return "not available";
  const match = /^<(?:project|main-checkout|claude-user|plugin-cache|plugin-data|marketplace-cache)>((?:\/[A-Za-z0-9._@+-]+)*)$/.exec(value.display);
  if (match === null || match[1]!.split("/").some((segment) => segment === "." || segment === "..")) return "<external>";
  return value.display;
}

function location(value: PluginInventoryLocation | undefined): string {
  return formatPluginInventoryDisplayLocation(value);
}

function provenance(value: PluginInventoryProvenance | undefined): string {
  if (value === undefined) return "not available";
  const fields = [`source=${location(value.source)}`];
  if (value.scope !== undefined) fields.push(`scope=${text(value.scope, 80)}`);
  if (value.origin !== undefined) fields.push(`origin=${text(value.origin, 80)}`);
  if (value.field !== undefined) fields.push(`field=${text(value.field, 80)}`);
  if (value.order !== undefined) fields.push(`order=${value.order}`);
  return fields.join(", ");
}

function yesNo(value: boolean | undefined): string { return value === undefined ? "not declared" : value ? "yes" : "no"; }
function installationSummary(item: PluginInventoryItem): string {
  const valid = item.installations.filter((entry) => entry.validity === "valid").length;
  const invalid = item.installations.length - valid;
  return valid === 0 && invalid === 0 ? "none" : `${valid} valid${invalid > 0 ? `, ${invalid} invalid` : ""}`;
}
function runtimeStatus(item: PluginInventoryItem): string { return item.outcome?.status ?? "not resolved"; }
function lowerBoundary(value: string): string { const plain = value.endsWith(".") ? value.slice(0, -1) : value; return `${plain[0]?.toLowerCase() ?? ""}${plain.slice(1)}`; }
function boundary(snapshot: PluginInventorySnapshot): string {
  return snapshot.lifetime === "session"
    ? lowerBoundary(PLUGIN_INVENTORY_SESSION_BOUNDARY)
    : "captured for this command; rerun this command to refresh";
}

function needsAttention(item: PluginInventoryItem): boolean {
  return item.diagnostics.some((value) => value.severity === "warning" || value.severity === "error") ||
    (item.outcome !== undefined && item.outcome.status !== "loaded" && item.outcome.status !== "disabled");
}

function relevance(item: PluginInventoryItem): number {
  return (item.installations.length > 0 ? 16 : 0) + (item.enablement?.enabled === true ? 8 : 0) +
    (item.selectedInstallation !== undefined ? 4 : 0) + (item.outcome?.status === "loaded" ? 2 : 0) +
    (needsAttention(item) ? 32 : 0);
}

function relevantItems(items: readonly PluginInventoryItem[]): PluginInventoryItem[] {
  return items.map((item, index) => ({ item, index })).sort((left, right) =>
    relevance(right.item) - relevance(left.item) || left.index - right.index).map(({ item }) => item);
}

function captureOmissions(snapshot: PluginInventorySnapshot): PluginInventoryCaptureOmission[] {
  return Object.entries(snapshot.omissions)
    .filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && entry[1] > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([axis, count]) => Object.freeze({ axis: text(axis, 128), count }));
}

function captureOmissionTotal(snapshot: PluginInventorySnapshot, predicate: (axis: string) => boolean): number {
  return captureOmissions(snapshot).filter((value) => predicate(value.axis)).reduce((sum, value) => sum + value.count, 0);
}

function truncateSafe(value: string, maximum = MAX_LINE): string {
  const points = Array.from(value);
  return points.length <= maximum ? value : `${points.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

function addBounded<T>(lines: string[], heading: string, values: readonly T[], render: (value: T) => string): void {
  lines.push(`${heading}:`);
  for (const value of values.slice(0, MAX_DETAIL_VALUES)) lines.push(`- ${truncateSafe(render(value))}`);
  const omitted = Math.max(0, values.length - MAX_DETAIL_VALUES);
  if (omitted > 0) lines.push(`- … ${omitted} local values not shown`);
  if (values.length === 0) lines.push("- none");
}

function addBoundedRecords<T>(lines: string[], heading: string, values: readonly T[], render: (value: T) => readonly string[]): void {
  lines.push(`${heading}:`);
  for (const [index, value] of values.slice(0, MAX_DETAIL_VALUES).entries()) {
    lines.push(`- record ${index + 1}`);
    for (const field of render(value)) lines.push(`  ${truncateSafe(field)}`);
  }
  const omitted = Math.max(0, values.length - MAX_DETAIL_VALUES);
  if (omitted > 0) lines.push(`- … ${omitted} local values not shown`);
  if (values.length === 0) lines.push("- none");
}

export function renderPluginInventoryList(snapshot: PluginInventorySnapshot): string {
  const lines = ["Plugin inventory (read-only)", `Snapshot: ${boundary(snapshot)}`];
  for (const item of relevantItems(snapshot.items).slice(0, MAX_LIST_ITEMS)) {
    lines.push(`Plugin: ${qualified(item.qualifiedIdentity)}`);
    lines.push(`  installed: ${installationSummary(item)}`);
    lines.push(`  enabled: ${yesNo(item.enablement?.enabled)}`);
    lines.push(`  runtime: ${runtimeStatus(item)}`);
    lines.push(`  catalog: ${item.catalogPresence ? "known" : "not known"}`);
  }
  const localRows = Math.max(0, snapshot.items.length - MAX_LIST_ITEMS);
  if (localRows > 0) lines.push(`Local rows not shown: ${localRows}. Catalog-only identities may be omitted; in the interactive TUI use the literal /plugin filter to look them up.`);
  const capture = captureOmissions(snapshot);
  if (capture.length > 0) lines.push(`Snapshot-capture evidence omissions: ${capture.map((value) => `${value.axis}=${value.count}`).join(", ")}`);
  if (snapshot.items.length === 0) lines.push("No plugins are known in this snapshot.");
  return lines.join("\n");
}

export function renderPluginInventoryDetails(snapshot: PluginInventorySnapshot, qualifiedIdentity: string): string {
  if (!validQualifiedIdentity(qualifiedIdentity)) return snapshot.lifetime === "command" ? PLUGIN_INVENTORY_ARGV_USAGE : PLUGIN_INVENTORY_SLASH_USAGE;
  const item = snapshot.find(qualifiedIdentity);
  if (item === undefined || item.qualifiedIdentity !== qualifiedIdentity) return [`Plugin not found: ${qualified(qualifiedIdentity)}`, `Snapshot: ${boundary(snapshot)}`, "Bounded output can omit catalog-only identities. Use the list command to copy an exact qualified identity; in the interactive TUI use the literal /plugin filter."].join("\n");
  const lines = [
    `Plugin: ${qualified(item.qualifiedIdentity)}`, "Mode: read-only", `Snapshot: ${boundary(snapshot)}`,
    `Installed: ${installationSummary(item)}`,
    `Enablement: enabled=${yesNo(item.enablement?.enabled)}; scope=${item.enablement === undefined ? "not declared" : text(item.enablement.scope, 80)}; source=${location(item.enablement?.source)}`,
    `Runtime outcome: status=${text(runtimeStatus(item), 80)}; shared-state causes=${item.outcome?.sharedStateCauses.length ? item.outcome.sharedStateCauses.map((value) => text(value, 80)).join(", ") : "none"}`,
    `Catalog presence: ${item.catalogPresence ? "known locally" : "not known locally"}`,
    `Selected installation: scope=${item.selectedInstallation === undefined ? "not available" : text(item.selectedInstallation.scope, 80)}; version=${item.selectedInstallation === undefined ? "not available" : text(item.selectedInstallation.version, 80)}`,
    `Selected root: ${location(item.selectedInstallation?.root)}`, `Selected project location: ${location(item.selectedInstallation?.project)}`, `Data location: ${location(item.selectedInstallation?.data)}`,
    `Selected state provenance: ${item.selectedInstallation === undefined ? "not available" : `source=${location(item.selectedInstallation.provenance.state)}, state-version=${item.selectedInstallation.provenance.stateVersion}, installed-at=${text(item.selectedInstallation.provenance.installedAt ?? "not available", 80)}, last-updated=${text(item.selectedInstallation.provenance.lastUpdated ?? "not available", 80)}`}`,
    `Manifest namespace: ${item.manifestNamespace === undefined ? "not available" : text(item.manifestNamespace, 128)}`,
    `Execution risk: ${item.executionRisk.length === 0 ? "none observed" : item.executionRisk.join(", ")}`,
  ];
  if (item.metadata !== undefined) {
    lines.push("Selected metadata:");
    for (const [label, value] of [["name", item.metadata.manifestName], ["version", item.metadata.version], ["description", item.metadata.description], ["author", item.metadata.author], ["homepage", item.metadata.homepage], ["repository", item.metadata.repository], ["license", item.metadata.license]] as const) if (value !== undefined) lines.push(`- ${label}: ${text(value)}`);
  }
  addBoundedRecords(lines, "Installations", item.installations, (value) => [
    `${value.selected ? "selected" : "observed"}; scope=${text(value.scope ?? "unknown", 80)}; version=${text(value.version ?? "unknown", 80)}; validity=${value.validity}`,
    `location=${location(value.location)}; project=${location(value.projectLocation)}`,
    `problems=${value.problems.length === 0 ? "none" : value.problems.slice(0, MAX_DETAIL_VALUES).map((problem) => text(problem, 80)).join(", ")}`,
    `diagnostics=${value.diagnostics.length === 0 ? "none" : value.diagnostics.slice(0, MAX_DETAIL_VALUES).map((diagnostic) => `${diagnostic.severity}:${text(diagnostic.message, 80)}`).join(", ")}`,
  ]);
  addBoundedRecords(lines, "Catalog declarations (locally observed; not runtime authority)", item.catalogDeclarations, (value) => [
    `source=${formatPluginInventoryStructuredSource(value.source)}`, `version=${text(value.version ?? "not declared", 80)}`, `revision=${text(value.revision ?? "not declared", 80)}; evidence=${text(value.revisionEvidence ?? "not declared", 80)}`,
    `source-effect=${value.sourceEffect === undefined ? "not declared" : `availability=${text(value.sourceEffect.availability, 80)}; location=${location(value.sourceEffect.location)}; provenance=${provenance(value.sourceEffect.provenance)}`}`,
    `release=${value.release === undefined ? "not declared" : `${text(value.release.kind, 80)}:${text(value.release.value, 80)}; evidence=${text(value.release.evidence ?? "not declared", 80)}; provenance=${provenance(value.release.provenance)}`}`,
    `description=${text(value.description ?? "not declared", 160)}`, `strict=${yesNo(value.strict.value)}; presence=${value.strict.presence}; provenance=${provenance(value.strict.provenance)}`,
    `default-enabled=${yesNo(value.defaultEnabled.value)}; presence=${value.defaultEnabled.presence}; provenance=${provenance(value.defaultEnabled.provenance)}`,
    `user-config=${value.userConfig === undefined ? "not declared" : `keys=${value.userConfig.keys.map((entry) => `${text(entry.key, 60)}:${text(entry.type, 40)}`).join(", ") || "none"}; omitted=${value.userConfig.omitted}; posture=${value.userConfig.posture}; provenance=${provenance(value.userConfig.provenance)}`}`,
    `runtime=${value.runtimeEffect}`, `provenance=${provenance(value.provenance)}`,
  ]);
  addBoundedRecords(lines, "Components (declarations and final runtime are independent)", item.components, (value) => [
    `${value.origin}/${value.kind}: count=${value.count}; semantics=${value.countSemantics}`, `declaration=${value.declaration ?? "not declared"}; posture=${"posture" in value ? value.posture : "observed declaration"}`,
    `support=${value.supportTier}; capability=${value.capabilityId}`, `risk=${value.executionRisk}`,
    `declared-path=${value.declaredPath === undefined ? "not declared" : text(value.declaredPath, 160)}; safe-shape=${value.safeShape === undefined ? "not declared" : `${value.safeShape.keys.map((entry) => `${text(entry.key, 60)}:${text(entry.type, 40)}`).join(", ") || "none"}; omitted=${value.safeShape.omitted}`}`,
    `provenance=${provenance(value.provenance)}`,
  ]);
  addBoundedRecords(lines, "Dependencies (declared only; resolution is not performed)", item.dependencies, (value) => [
    `identity=${qualified(value.targetIdentity)}`, `origin=${value.origin}`, `version=${text(value.version ?? "not declared", 80)}; status=${text(value.versionStatus ?? "not declared", 80)}`,
    `qualification=${text(value.crossMarketplace, 80)}`, `posture=${text(value.posture, 120)}`, `provenance=${provenance(value.provenance)}`,
  ]);
  addBoundedRecords(lines, "Renames (declared only; migration is not performed)", item.renames, (value) => [
    `from=${text(value.from, 100)}; target=${value.target === null ? "removed" : text(value.target, 100)}`, `status=${text(value.status, 80)}`, `posture=${value.posture}`, `provenance=${provenance(value.provenance)}`,
  ]);
  addBounded(lines, "Item diagnostics", item.diagnostics, (value) => `${value.severity}: ${text(value.message)}`);
  addBounded(lines, "GLOBAL policy observations (not owned by this plugin; not enforced by PiCC)", snapshot.policyObservations, (value) => `kind=${text(value.kind, 80)}; descriptor=${value.descriptor === undefined ? "none" : text(JSON.stringify(value.descriptor), 160)}; descriptor-provenance=${provenance(value.descriptorProvenance)}; match=${text(String(value.match), 80)}; valid-scope=${yesNo(value.validScope)}; empty-lockdown=${yesNo(value.emptyLockdown)}; posture=${value.posture}; provenance=${provenance(value.provenance)}`);
  const capture = captureOmissions(snapshot);
  if (capture.length > 0) lines.push(`Snapshot-capture evidence omissions (GLOBAL, not attributed to this plugin): ${capture.map((value) => `${value.axis}=${value.count}`).join(", ")}`);
  return lines.join("\n");
}

export function renderPluginInventoryOperation(snapshot: PluginInventorySnapshot, operation: PluginInventoryOperation): string { return operation.kind === "list" ? renderPluginInventoryList(snapshot) : renderPluginInventoryDetails(snapshot, operation.qualifiedIdentity); }

const SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({ "system-file": "system policy file", "system-drop-in": "system policy drop-in", override: "managed-policy override" });
const ADMIN_POLICY_SOURCES = new Set(["system-file", "system-drop-in"]);
function policyGuidance(sourceClass: string, category: PluginInventoryManagedPolicyEvidence["category"]): string {
  if (ADMIN_POLICY_SOURCES.has(sourceClass)) return category === "managed-policy-malformed" ? "Ask an administrator to correct the policy format" : "Ask an administrator to correct access to the policy source";
  return category === "managed-policy-malformed" ? "Correct the managed-policy override format" : "Correct access to the managed-policy override input";
}
function policyRefreshAction(): string { return "run canonical /reload in the interactive TUI, or exit and relaunch PiCC"; }
function policyEvidence(diagnostics: readonly PluginInventoryDiagnostic[]): PluginInventoryManagedPolicyEvidence[] {
  const seen = new Set<string>(); const values: PluginInventoryManagedPolicyEvidence[] = [];
  for (const diagnostic of diagnostics) {
    if ((diagnostic.category !== "managed-policy-malformed" && diagnostic.category !== "managed-policy-unreadable") || diagnostic.impact !== "source-ignored" || diagnostic.sourceClass === undefined || SOURCE_LABELS[diagnostic.sourceClass] === undefined) continue;
    const key = `${diagnostic.category}\0${diagnostic.sourceClass}\0${diagnostic.impact}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(Object.freeze({ category: diagnostic.category, condition: diagnostic.category === "managed-policy-malformed" ? "malformed" : "unreadable", sourceClass: diagnostic.sourceClass, sourceLabel: SOURCE_LABELS[diagnostic.sourceClass]!, impact: diagnostic.impact, guidance: policyGuidance(diagnostic.sourceClass, diagnostic.category), refreshGuidance: policyRefreshAction() }));
  }
  return values;
}
function capPolicyEvidence(values: readonly PluginInventoryManagedPolicyEvidence[], maximum: number): PluginInventoryManagedPolicyEvidence[] {
  return values.slice(0, maximum);
}

export function projectPluginInventoryStartup(snapshot: PluginInventorySnapshot): PluginInventoryStartupProjection {
  const failed = snapshot.items.filter((item) => item.outcome !== undefined && item.outcome.status !== "loaded" && item.outcome.status !== "disabled");
  const allIdentities = [...new Set(failed.map((item) => qualified(item.qualifiedIdentity)))];
  const identities = allIdentities.slice(0, 10);
  const allPolicies = policyEvidence(snapshot.diagnostics).filter((value) => ADMIN_POLICY_SOURCES.has(value.sourceClass)); const policies = capPolicyEvidence(allPolicies, MAX_STARTUP_POLICY_EVIDENCE);
  const lines = failed.slice(0, 10).map((item) => `Plugin ${qualified(item.qualifiedIdentity)} needs attention: ${item.outcome!.status}. Run /doctor for details.`);
  for (const value of policies) {
    lines.push(`${value.sourceLabel} was ${value.condition}; the administrator source was ignored and plugin enablement may differ. ${value.guidance}, then ${value.refreshGuidance}.`);
  }
  const capture = Object.freeze(captureOmissions(snapshot));
  const omissions = Object.freeze({ identities: Math.max(0, allIdentities.length - identities.length), managedPolicyEvidence: Math.max(0, allPolicies.length - policies.length), captureEvidence: capture });
  return Object.freeze({ needsAttention: lines.length > 0, qualifiedIdentities: Object.freeze(identities), managedPolicyEvidence: Object.freeze(policies), omissions, ...(lines.length === 0 ? {} : { text: lines.join("\n") }) });
}

export function projectPluginInventoryDoctor(snapshot: PluginInventorySnapshot): PluginInventoryDoctorProjection {
  const allDiagnostics: PluginInventoryDoctorDiagnostic[] = [];
  const next = (identity: string): string => snapshot.lifetime === "session" ? `/plugin details ${identity}` : `picc plugin details ${identity}`;
  const recovery = Object.freeze({
    repairBoundary: "PiCC inventory is read-only; repair plugin state, declarations, or policy outside this command",
    ...(snapshot.lifetime === "session" ? { refreshGuidance: PLUGIN_INVENTORY_SESSION_BOUNDARY } : { refreshGuidance: "rerun this command to refresh" }),
  });
  for (const item of snapshot.items) {
    if (item.outcome !== undefined && item.outcome.status !== "loaded" && item.outcome.status !== "disabled") {
      const identity = qualified(item.qualifiedIdentity);
      allDiagnostics.push(Object.freeze({ qualifiedIdentity: identity, global: false, severity: "warning", message: `Plugin runtime outcome is ${item.outcome.status}`, status: item.outcome.status, nextCommand: next(identity), ...recovery }));
    }
    for (const diagnostic of item.diagnostics) allDiagnostics.push(Object.freeze({ qualifiedIdentity: qualified(item.qualifiedIdentity), global: false, severity: diagnostic.severity, message: text(diagnostic.message), nextCommand: next(qualified(item.qualifiedIdentity)), ...recovery }));
  }
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.category === "managed-policy-malformed" || diagnostic.category === "managed-policy-unreadable") continue;
    allDiagnostics.push(Object.freeze({ global: true, severity: diagnostic.severity, message: text(diagnostic.message), ...recovery }));
  }
  const uniqueDiagnostics = allDiagnostics.filter((value, index, values) => values.findIndex((candidate) =>
    candidate.qualifiedIdentity === value.qualifiedIdentity && candidate.global === value.global &&
    candidate.severity === value.severity && candidate.message === value.message) === index);
  const diagnostics = uniqueDiagnostics.slice(0, MAX_DIAGNOSTICS);
  const uniqueEvidence = snapshot.capabilityEvidence.filter((value, index, values) => values.findIndex((candidate) =>
    candidate.capabilityId === value.capabilityId && candidate.qualifiedIdentity === value.qualifiedIdentity &&
    candidate.component === value.component && candidate.supportTier === value.supportTier && candidate.observation === value.observation) === index);
  const evidence = uniqueEvidence.slice(0, MAX_EVIDENCE).map((value) => Object.freeze({ capabilityId: value.capabilityId, qualifiedIdentity: qualified(value.qualifiedIdentity), ...(value.component === undefined ? {} : { component: text(value.component, 80) }), ...(value.supportTier === undefined ? {} : { supportTier: value.supportTier }), observation: text(value.observation) }));
  const allPolicies = policyEvidence(snapshot.diagnostics); const policies = capPolicyEvidence(allPolicies, MAX_DOCTOR_POLICY_EVIDENCE);
  const capture = Object.freeze(captureOmissions(snapshot));
  const captureDiagnostics = captureOmissionTotal(snapshot, (axis) => axis.includes("diagnostic"));
  const captureCapabilities = captureOmissionTotal(snapshot, (axis) => axis.includes("evidence"));
  const attentionIdentities = new Set<string>();
  for (const item of snapshot.items) {
    if ((item.outcome !== undefined && item.outcome.status !== "loaded" && item.outcome.status !== "disabled") ||
      item.diagnostics.some((value) => value.severity === "warning" || value.severity === "error") ||
      item.components.some((value) => value.supportTier !== "full")) attentionIdentities.add(item.qualifiedIdentity);
  }
  for (const value of uniqueEvidence) if (value.supportTier !== undefined && value.supportTier !== "full") attentionIdentities.add(value.qualifiedIdentity);
  const attention = attentionIdentities.size;
  return Object.freeze({
    counts: Object.freeze({ known: snapshot.items.length, installed: snapshot.items.filter((item) => item.installations.some((entry) => entry.validity === "valid")).length, enabled: snapshot.items.filter((item) => item.enablement?.enabled === true).length, loaded: snapshot.items.filter((item) => item.outcome?.status === "loaded").length, cataloged: snapshot.items.filter((item) => item.catalogPresence).length, attention }),
    diagnostics: Object.freeze(diagnostics), capabilityEvidence: Object.freeze(evidence), managedPolicyEvidence: Object.freeze(policies), captureOmissions: capture,
    omitted: Object.freeze({ diagnostics: Object.freeze({ capture: captureDiagnostics, projection: Math.max(0, uniqueDiagnostics.length - diagnostics.length) }), capabilityEvidence: Object.freeze({ capture: captureCapabilities, projection: Math.max(0, uniqueEvidence.length - evidence.length) }), managedPolicyEvidence: Object.freeze({ projection: Math.max(0, allPolicies.length - policies.length) }) }),
    snapshotBoundary: boundary(snapshot),
  });
}

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

export const PLUGIN_INVENTORY_SLASH_USAGE = "Usage: /plugin list | /plugin details <plugin@marketplace>. In the interactive TUI, lifecycle actions open focused workflows; run `picc plugin --help` in a terminal for standalone commands. No changes were made.";
export const PLUGIN_INVENTORY_ARGV_USAGE = `Usage: picc plugin <command>
  marketplace list
  marketplace details <name> [--selector <record>]
  marketplace add <name> --source <local-directory|local-catalog-file|github|https-git|https-catalog> <value> [--ref <ref>] [--scope <user|project|local>] [--declaration-only] [--yes]
  marketplace refresh <name> [--selector <record>] [--declaration-only] [--yes]
  marketplace update <name> [--selector <record>] [--declaration-only] [--yes]
  marketplace remove <name> [--selector <record>] --preserve-installed yes [--declaration-only] [--yes]
  list
  details <plugin@marketplace|selector>
  install <plugin@marketplace> [--marketplace-selector <marketplace-record>] [--scope <user|project|local>] [--declaration-only] [--yes]
  enable|disable <plugin@marketplace> [--selector <plugin-record>] [--declaration-only] [--yes]
  update <plugin@marketplace> [--selector <plugin-record>] [--marketplace-selector <marketplace-record>] [--yes]
  uninstall <plugin@marketplace> [--selector <record>] --remove-declaration yes --remove-data <yes|no> [--declaration-only] [--yes]
  uninstall <plugin@marketplace> [--selector <record>] --remove-declaration no --remove-data <yes|no> [--yes]
  recover [operation-id] [--complete|--rollback] [--yes]
Output is bounded human-readable text; no stable JSON schema is provided.`;

export interface PluginLifecycleFlags {
  readonly yes: boolean;
  readonly declarationOnly: boolean;
  readonly scope?: "user" | "project" | "local";
  readonly selector?: string;
  readonly marketplaceSelector?: string;
  readonly preserveInstalled?: true;
  readonly removeDeclaration?: boolean;
  readonly removeData?: boolean;
  readonly recoveryAction?: "complete" | "rollback";
}
export type PluginInventoryOperation =
  | { readonly kind: "list" }
  | { readonly kind: "details"; readonly identity?: string; readonly qualifiedIdentity?: string }
  | { readonly kind: "marketplace-list" }
  | { readonly kind: "marketplace-details"; readonly name: string; readonly selector?: string }
  | { readonly kind: "marketplace-add"; readonly name: string; readonly sourceKind: "local-directory" | "local-catalog-file" | "github" | "https-git" | "https-catalog"; readonly sourceValue: string; readonly ref?: string; readonly flags: PluginLifecycleFlags }
  | { readonly kind: "marketplace-refresh" | "marketplace-remove"; readonly name: string; readonly flags: PluginLifecycleFlags }
  | { readonly kind: "install" | "enable" | "disable" | "update" | "uninstall"; readonly qualifiedIdentity: string; readonly flags: PluginLifecycleFlags }
  | { readonly kind: "recover-list" }
  | { readonly kind: "recover"; readonly operationId: string; readonly flags: PluginLifecycleFlags };

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
  readonly category?: "lifecycle" | "diagnostic";
  readonly operationId?: string;
  readonly semanticStep?: string;
  readonly target?: string;
  readonly recoveryCategory?: "complete-or-rollback" | "inspect";
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

function parseReadOnlyTokens(tokens: readonly string[], usage: string): PluginInventoryOperationParseResult {
  if (tokens.length === 1 && tokens[0] === "list") return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "list" }) });
  if (tokens.length === 2 && tokens[0] === "details" && validQualifiedIdentity(tokens[1]!)) return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "details", qualifiedIdentity: tokens[1]! }) });
  return Object.freeze({ kind: "usage", usage });
}

function validPlain(value: string, maximum = 256): boolean {
  return value.length > 0 && value.length <= maximum && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}
function validOperationId(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function validMarketplaceName(value: string): boolean { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 128; }

function parseFlags(tokens: readonly string[], allowed: ReadonlySet<string>): PluginLifecycleFlags | undefined {
  let yes = false; let declarationOnly = false; let scope: PluginLifecycleFlags["scope"]; let selector: string | undefined; let marketplaceSelector: string | undefined;
  let preserveInstalled: true | undefined; let removeDeclaration: boolean | undefined; let removeData: boolean | undefined; let recoveryAction: "complete" | "rollback" | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!allowed.has(token)) return undefined;
    if (token === "--yes") { if (yes) return undefined; yes = true; continue; }
    if (token === "--declaration-only") { if (declarationOnly) return undefined; declarationOnly = true; continue; }
    if (token === "--complete" || token === "--rollback") { if (recoveryAction !== undefined) return undefined; recoveryAction = token.slice(2) as "complete" | "rollback"; continue; }
    const value = tokens[++index]; if (value === undefined || value.startsWith("--") || !validPlain(value, 1024)) return undefined;
    if (token === "--scope") { if (scope !== undefined || !["user", "project", "local"].includes(value)) return undefined; scope = value as PluginLifecycleFlags["scope"]; }
    else if (token === "--selector") { if (selector !== undefined || !/^[A-Za-z0-9_-]{1,1024}$/.test(value)) return undefined; selector = value; }
    else if (token === "--marketplace-selector") { if (marketplaceSelector !== undefined || !/^[A-Za-z0-9_-]{1,1024}$/.test(value)) return undefined; marketplaceSelector = value; }
    else if (token === "--preserve-installed") { if (preserveInstalled !== undefined || value !== "yes") return undefined; preserveInstalled = true; }
    else if (token === "--remove-declaration") { if (removeDeclaration !== undefined || !["yes", "no"].includes(value)) return undefined; removeDeclaration = value === "yes"; }
    else if (token === "--remove-data") { if (removeData !== undefined || !["yes", "no"].includes(value)) return undefined; removeData = value === "yes"; }
    else return undefined;
  }
  return Object.freeze({ yes, declarationOnly, ...(scope === undefined ? {} : { scope }), ...(selector === undefined ? {} : { selector }), ...(marketplaceSelector === undefined ? {} : { marketplaceSelector }), ...(preserveInstalled === undefined ? {} : { preserveInstalled }), ...(removeDeclaration === undefined ? {} : { removeDeclaration }), ...(removeData === undefined ? {} : { removeData }), ...(recoveryAction === undefined ? {} : { recoveryAction }) });
}

function parseArgvTokens(tokens: readonly string[]): PluginInventoryOperationParseResult {
  if (tokens.length === 1 && tokens[0] === "list") return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "list" }) });
  if (tokens.length === 2 && tokens[0] === "details" && validQualifiedIdentity(tokens[1]!)) return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "details", qualifiedIdentity: tokens[1]! }) });
  if (tokens.length === 2 && tokens[0] === "details" && /^[A-Za-z0-9_-]{16,1024}$/.test(tokens[1]!)) return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "details", identity: tokens[1]! }) });
  if (tokens[0] === "marketplace") {
    if (tokens.length === 2 && tokens[1] === "list") return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "marketplace-list" }) });
    if (tokens[1] === "details" && validMarketplaceName(tokens[2] ?? "")) { const flags = parseFlags(tokens.slice(3), new Set(["--selector"])); if (flags !== undefined) return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "marketplace-details", name: tokens[2]!, ...(flags.selector === undefined ? {} : { selector: flags.selector }) }) }); }
    if (tokens[1] === "add" && validMarketplaceName(tokens[2] ?? "") && tokens[3] === "--source" && ["local-directory", "local-catalog-file", "github", "https-git", "https-catalog"].includes(tokens[4] ?? "") && validPlain(tokens[5] ?? "", 4096)) {
      const tail = [...tokens.slice(6)]; let ref: string | undefined; const refIndex = tail.indexOf("--ref");
      if (refIndex >= 0) { const value = tail[refIndex + 1]; if (value === undefined || !validPlain(value, 256) || refIndex + 2 > tail.length) return Object.freeze({ kind: "usage", usage: PLUGIN_INVENTORY_ARGV_USAGE }); ref = value; tail.splice(refIndex, 2); }
      const flags = parseFlags(tail, new Set(["--scope", "--declaration-only", "--yes"]));
      if (flags !== undefined && (ref === undefined || tokens[4] === "github" || tokens[4] === "https-git")) return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "marketplace-add", name: tokens[2]!, sourceKind: tokens[4] as "local-directory" | "local-catalog-file" | "github" | "https-git" | "https-catalog", sourceValue: tokens[5]!, ...(ref === undefined ? {} : { ref }), flags }) });
    }
    if (["refresh", "update", "remove"].includes(tokens[1] ?? "") && validMarketplaceName(tokens[2] ?? "")) {
      const remove = tokens[1] === "remove"; const flags = parseFlags(tokens.slice(3), new Set(["--selector", "--declaration-only", "--yes", ...(remove ? ["--preserve-installed"] : [])]));
      if (flags !== undefined && (!remove || flags.preserveInstalled === true)) return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: remove ? "marketplace-remove" : "marketplace-refresh", name: tokens[2]!, flags }) as PluginInventoryOperation });
    }
    return Object.freeze({ kind: "usage", usage: PLUGIN_INVENTORY_ARGV_USAGE });
  }
  if (["install", "enable", "disable", "update", "uninstall"].includes(tokens[0] ?? "") && validQualifiedIdentity(tokens[1] ?? "")) {
    const action = tokens[0] as "install" | "enable" | "disable" | "update" | "uninstall";
    const allowed = new Set(["--yes", ...(action === "update" ? [] : ["--declaration-only"]), ...(action === "install" || action === "update" ? ["--marketplace-selector"] : []), ...(action === "enable" || action === "disable" || action === "update" || action === "uninstall" ? ["--selector"] : []), ...(action === "install" ? ["--scope"] : []), ...(action === "uninstall" ? ["--remove-declaration", "--remove-data"] : [])]);
    const flags = parseFlags(tokens.slice(2), allowed);
    if (flags !== undefined && (action !== "uninstall" || flags.removeDeclaration !== undefined && flags.removeData !== undefined && (!flags.declarationOnly || flags.removeDeclaration === true))) return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: action, qualifiedIdentity: tokens[1]!, flags }) });
  }
  if (tokens[0] === "recover") {
    if (tokens.length === 1) return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "recover-list" }) });
    if (validOperationId(tokens[1] ?? "")) { const flags = parseFlags(tokens.slice(2), new Set(["--complete", "--rollback", "--yes"])); if (flags !== undefined) return Object.freeze({ kind: "operation", operation: Object.freeze({ kind: "recover", operationId: tokens[1]!, flags }) }); }
  }
  return Object.freeze({ kind: "usage", usage: PLUGIN_INVENTORY_ARGV_USAGE });
}

export function parsePluginInventorySlash(input: string): PluginInventoryOperationParseResult {
  if (input.length > MAX_INPUT || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.replace(/\t/gu, ""))) return Object.freeze({ kind: "usage", usage: PLUGIN_INVENTORY_SLASH_USAGE });
  const match = /^[ \t]*\/plugin(?:[ \t]+([^\r\n]*?))?[ \t]*$/.exec(input);
  if (match === null || match[1] === undefined) return Object.freeze({ kind: "usage", usage: PLUGIN_INVENTORY_SLASH_USAGE });
  return parseReadOnlyTokens(match[1].split(/[ \t]+/), PLUGIN_INVENTORY_SLASH_USAGE);
}

export function parsePluginInventoryArgv(argv: readonly string[]): PluginInventoryOperationParseResult {
  if (argv.some((token) => token.length > 4096 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(token))) return Object.freeze({ kind: "usage", usage: PLUGIN_INVENTORY_ARGV_USAGE });
  if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ kind: "usage", usage: PLUGIN_INVENTORY_ARGV_USAGE });
  return parseArgvTokens(argv);
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
function lifecycleSummary(item: PluginInventoryItem): string {
  const value = item.lifecycle; if (value === undefined) return "not projected";
  return `owner=${value.ownership}; desired-installed=${yesNo(value.installed)}; declared=${yesNo(value.declared)}; effective=${yesNo(value.effectiveEnabled)}; loaded=${yesNo(value.loaded)}; reload=${value.pendingReload ? "pending" : "not pending"}`;
}
function lowerBoundary(value: string): string { const plain = value.endsWith(".") ? value.slice(0, -1) : value; return `${plain[0]?.toLowerCase() ?? ""}${plain.slice(1)}`; }
function boundary(snapshot: PluginInventorySnapshot): string {
  return snapshot.lifetime === "session"
    ? lowerBoundary(PLUGIN_INVENTORY_SESSION_BOUNDARY)
    : "captured for this command; rerun this command to refresh";
}

function needsAttention(item: PluginInventoryItem): boolean {
  return item.diagnostics.some((value) => value.severity === "warning" || value.severity === "error") ||
    (item.outcome !== undefined && item.outcome.status !== "loaded" && item.outcome.status !== "disabled") || item.lifecycle?.pendingStep !== undefined || (item.lifecycle?.retainedErrors.length ?? 0) > 0;
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
  const lines = ["Plugin inventory (read-only)", `Snapshot: ${boundary(snapshot)}`, `Loaded generation: ${text(snapshot.loadedGenerationId ?? "not identified", 100)}`, `Durable desired generation: ${text(snapshot.durableDesired?.generationId ?? "not identified", 100)}`];
  for (const item of relevantItems(snapshot.items).slice(0, MAX_LIST_ITEMS)) {
    lines.push(`Plugin: ${qualified(item.qualifiedIdentity)}`);
    lines.push(`  installed: ${installationSummary(item)}`);
    lines.push(`  enabled: ${yesNo(item.enablement?.enabled)}`);
    lines.push(`  runtime: ${runtimeStatus(item)}`);
    lines.push(`  lifecycle: ${lifecycleSummary(item)}`);
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
    `Plugin: ${qualified(item.qualifiedIdentity)}`, "Mode: read-only", `Snapshot: ${boundary(snapshot)}`, `Loaded generation: ${text(snapshot.loadedGenerationId ?? "not identified", 100)}; durable desired generation: ${text(snapshot.durableDesired?.generationId ?? "not identified", 100)}`,
    `Installed: ${installationSummary(item)}`,
    `Enablement: enabled=${yesNo(item.enablement?.enabled)}; scope=${item.enablement === undefined ? "not declared" : text(item.enablement.scope, 80)}; source=${location(item.enablement?.source)}`,
    `Runtime outcome: status=${text(runtimeStatus(item), 80)}; shared-state causes=${item.outcome?.sharedStateCauses.length ? item.outcome.sharedStateCauses.map((value) => text(value, 80)).join(", ") : "none"}`,
    `Lifecycle axes: ${lifecycleSummary(item)}`,
    `Lifecycle target: mutable-record=${text(item.lifecycle?.mutableRecordKey ?? "not available", 160)}; selected-scope=${text(item.lifecycle?.selectedScope ?? "not available", 80)}; marketplace-owner=${text(item.lifecycle?.marketplaceOwnership ?? "unknown", 80)}; trusted=${yesNo(item.lifecycle?.trusted)}`,
    `Lifecycle eligibility: ${item.lifecycle?.availableActions.length ? item.lifecycle.availableActions.join(", ") : "none (read-only or unavailable)"}`,
    `Scoped candidates: ${(item.lifecycle?.candidates ?? []).map((value) => `${text(value.scope, 60)}:${value.selected ? "selected" : "candidate"}:${text(value.mutableRecordKey, 160)}`).join(", ") || "none"}${item.lifecycle?.selectionRequired ? `; selection required (${text(item.lifecycle.selectionGuidance ?? "select an exact scope", 160)})` : ""}`,
    `Immutable desired content: revision=${text(item.lifecycle?.immutableRevision ?? "not available", 100)}; integrity=${text(item.lifecycle?.integrity ?? "not available", 100)}; root=${location(item.lifecycle?.root)}`,
    `Default enablement source: ${text(item.lifecycle?.defaultEnablementSource ?? "not available", 100)}`,
    `Dependency posture: ${text(item.lifecycle?.dependency.state ?? "not available", 80)}${item.lifecycle?.dependency.reason === undefined ? "" : `; reason=${text(item.lifecycle.dependency.reason, 160)}`}`,
    `Lifecycle availability: ${item.lifecycle?.readOnlyReason === undefined ? "mutable when an explicit lifecycle action is available" : `read-only; ${text(item.lifecycle.readOnlyReason, 160)}`}`,
    `Pending lifecycle: step=${text(item.lifecycle?.pendingStep ?? "none", 160)}; reload=${item.lifecycle?.pendingReload === true ? "pending" : "not pending"}; recovery-category=${text(item.lifecycle?.recoveryCategory ?? "none", 80)}; recovery-command=${text(item.lifecycle?.recoveryCommand ?? "none", 160)}`,
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
  addBoundedRecords(lines, "Lifecycle operation guidance", item.lifecycle?.lifecycleOperations ?? [], (value) => [
    `operation=${text(value.operationId, 100)}; status=${value.status}; step=${text(value.semanticStep, 160)}`,
    `category=${value.category}; target=${text(value.target ?? "not attributed", 120)}; recovery=${text(value.recoveryCommand, 160)}`,
  ]);
  addBounded(lines, "Retained lifecycle failures", item.lifecycle?.retainedErrors ?? [], (value) => text(value));
  addBounded(lines, "Item diagnostics", item.diagnostics, (value) => `${value.severity}: ${text(value.message)}`);
  addBounded(lines, "GLOBAL policy observations (not owned by this plugin; not enforced by PiCC)", snapshot.policyObservations, (value) => `kind=${text(value.kind, 80)}; descriptor=${value.descriptor === undefined ? "none" : text(JSON.stringify(value.descriptor), 160)}; descriptor-provenance=${provenance(value.descriptorProvenance)}; match=${text(String(value.match), 80)}; valid-scope=${yesNo(value.validScope)}; empty-lockdown=${yesNo(value.emptyLockdown)}; posture=${value.posture}; provenance=${provenance(value.provenance)}`);
  const capture = captureOmissions(snapshot);
  if (capture.length > 0) lines.push(`Snapshot-capture evidence omissions (GLOBAL, not attributed to this plugin): ${capture.map((value) => `${value.axis}=${value.count}`).join(", ")}`);
  return lines.join("\n");
}

export function renderPluginInventoryOperation(snapshot: PluginInventorySnapshot, operation: PluginInventoryOperation): string {
  if (operation.kind === "list") return renderPluginInventoryList(snapshot);
  if (operation.kind === "details" && operation.qualifiedIdentity !== undefined) return renderPluginInventoryDetails(snapshot, operation.qualifiedIdentity);
  return PLUGIN_INVENTORY_ARGV_USAGE;
}

const SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({ "system-file": "system policy file", "system-drop-in": "system policy drop-in", override: "managed-policy override" });
const ADMIN_POLICY_SOURCES = new Set(["system-file", "system-drop-in"]);
function policyGuidance(sourceClass: string, category: PluginInventoryManagedPolicyEvidence["category"]): string {
  if (ADMIN_POLICY_SOURCES.has(sourceClass)) return category === "managed-policy-malformed" ? "Ask an administrator to correct the policy format" : "Ask an administrator to correct access to the policy source";
  return category === "managed-policy-malformed" ? "Correct the managed-policy override format" : "Correct access to the managed-policy override input";
}
function policyRefreshAction(): string { return "run /reload-plugins in the interactive TUI, or start a new PiCC session"; }
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
  const failed = snapshot.items.filter((item) => item.outcome !== undefined && item.outcome.status !== "loaded" && item.outcome.status !== "disabled" || item.lifecycle?.pendingStep !== undefined || (item.lifecycle?.retainedErrors.length ?? 0) > 0);
  const lifecycleOperations = [
    ...(snapshot.durableDesired?.pendingOperations ?? []),
    ...(snapshot.durableDesired?.terminalOperations.filter((value) => value.outcome === "failed-before-commit" && value.recoveryCommand !== undefined).map((value) => ({ operationId: value.operationId, status: value.outcome, semanticStep: value.semanticStep, ...(value.target === undefined ? {} : { target: value.target }), recoveryCommand: value.recoveryCommand!, category: value.category ?? "inspect" as const })) ?? []),
  ];
  const allIdentities = [...new Set(failed.map((item) => qualified(item.qualifiedIdentity)))];
  const identities = allIdentities.slice(0, 10);
  const allPolicies = policyEvidence(snapshot.diagnostics).filter((value) => ADMIN_POLICY_SOURCES.has(value.sourceClass)); const policies = capPolicyEvidence(allPolicies, MAX_STARTUP_POLICY_EVIDENCE);
  const lines = lifecycleOperations.slice(0, 10).map((value) => `Lifecycle operation ${text(value.operationId, 100)} needs attention: step=${text(value.semanticStep, 120)}; category=${value.category}; target=${text(value.target ?? "not attributed", 100)}; recovery=${text(value.recoveryCommand, 160)}. Run /doctor for details.`);
  lines.push(...failed.slice(0, Math.max(0, 10 - lines.length)).map((item) => `Plugin ${qualified(item.qualifiedIdentity)} needs attention: ${item.lifecycle?.pendingStep ?? item.outcome?.status ?? "retained lifecycle failure"}. Run /doctor for details.`));
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
    for (const operation of item.lifecycle?.lifecycleOperations ?? []) allDiagnostics.push(Object.freeze({ qualifiedIdentity: qualified(item.qualifiedIdentity), global: false, severity: "warning", category: "lifecycle", operationId: operation.operationId, semanticStep: operation.semanticStep, ...(operation.target === undefined ? {} : { target: operation.target }), recoveryCategory: operation.category, message: `Lifecycle ${operation.status}: ${text(operation.semanticStep)}`, nextCommand: operation.recoveryCommand, ...recovery }));
    for (const message of item.lifecycle?.retainedErrors ?? []) allDiagnostics.push(Object.freeze({ qualifiedIdentity: qualified(item.qualifiedIdentity), global: false, severity: "warning", category: "lifecycle", message: text(message), nextCommand: next(qualified(item.qualifiedIdentity)), ...recovery }));
    for (const diagnostic of item.diagnostics) allDiagnostics.push(Object.freeze({ qualifiedIdentity: qualified(item.qualifiedIdentity), global: false, severity: diagnostic.severity, category: "diagnostic", message: text(diagnostic.message), nextCommand: next(qualified(item.qualifiedIdentity)), ...recovery }));
  }
  const attributedOperations = new Set(snapshot.items.flatMap((item) => item.lifecycle?.lifecycleOperations?.map((value) => value.operationId) ?? []));
  const globalLifecycleOperations = [
    ...(snapshot.durableDesired?.pendingOperations ?? []),
    ...(snapshot.durableDesired?.terminalOperations.filter((value) => value.outcome === "failed-before-commit" && value.recoveryCommand !== undefined).map((value) => ({ operationId: value.operationId, status: value.outcome, semanticStep: value.semanticStep, ...(value.target === undefined ? {} : { target: value.target }), recoveryCommand: value.recoveryCommand!, category: value.category ?? "inspect" as const })) ?? []),
  ];
  for (const operation of globalLifecycleOperations) if (!attributedOperations.has(operation.operationId)) allDiagnostics.push(Object.freeze({ global: true, severity: "warning", category: "lifecycle", operationId: operation.operationId, semanticStep: operation.semanticStep, ...(operation.target === undefined ? {} : { target: operation.target }), recoveryCategory: operation.category, message: `Lifecycle ${operation.status}: ${text(operation.semanticStep)}`, nextCommand: operation.recoveryCommand, ...recovery }));
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.category === "managed-policy-malformed" || diagnostic.category === "managed-policy-unreadable") continue;
    allDiagnostics.push(Object.freeze({ global: true, severity: diagnostic.severity, category: diagnostic.category === "lifecycle-observation" ? "lifecycle" : "diagnostic", message: text(diagnostic.message), ...recovery }));
  }
  const uniqueDiagnostics = allDiagnostics.filter((value, index, values) => values.findIndex((candidate) =>
    candidate.qualifiedIdentity === value.qualifiedIdentity && candidate.global === value.global &&
    candidate.severity === value.severity && candidate.message === value.message &&
    (candidate.category !== "lifecycle" && value.category !== "lifecycle" ||
      candidate.category === value.category && candidate.operationId === value.operationId &&
      candidate.semanticStep === value.semanticStep && candidate.target === value.target &&
      candidate.recoveryCategory === value.recoveryCategory && candidate.nextCommand === value.nextCommand)) === index);
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
      item.diagnostics.some((value) => value.severity === "warning" || value.severity === "error") || item.lifecycle?.pendingStep !== undefined || (item.lifecycle?.retainedErrors.length ?? 0) > 0 ||
      item.components.some((value) => value.supportTier !== "full")) attentionIdentities.add(item.qualifiedIdentity);
  }
  for (const value of uniqueEvidence) if (value.supportTier !== undefined && value.supportTier !== "full") attentionIdentities.add(value.qualifiedIdentity);
  const attention = attentionIdentities.size;
  return Object.freeze({
    counts: Object.freeze({ known: snapshot.items.length, installed: snapshot.items.filter((item) => item.lifecycle?.installed ?? item.installations.some((entry) => entry.validity === "valid")).length, enabled: snapshot.items.filter((item) => item.lifecycle?.effectiveEnabled ?? item.enablement?.enabled === true).length, loaded: snapshot.items.filter((item) => item.lifecycle?.loaded ?? item.outcome?.status === "loaded").length, cataloged: snapshot.items.filter((item) => item.catalogPresence).length, attention }),
    diagnostics: Object.freeze(diagnostics), capabilityEvidence: Object.freeze(evidence), managedPolicyEvidence: Object.freeze(policies), captureOmissions: capture,
    omitted: Object.freeze({ diagnostics: Object.freeze({ capture: captureDiagnostics, projection: Math.max(0, uniqueDiagnostics.length - diagnostics.length) }), capabilityEvidence: Object.freeze({ capture: captureCapabilities, projection: Math.max(0, uniqueEvidence.length - evidence.length) }), managedPolicyEvidence: Object.freeze({ projection: Math.max(0, allPolicies.length - policies.length) }) }),
    snapshotBoundary: boundary(snapshot),
  });
}

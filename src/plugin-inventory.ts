import path from "node:path";
import type { InstalledPluginObservation, PluginInstalledStateStatus } from "./claude/plugin-installed-state.js";
import { readObservedPluginMetadata, type PluginMetadataReadCapability, type SafePluginManifestProjection } from "./claude/plugin-metadata.js";
import type { InstalledPlugin } from "./claude/plugins.js";
import type { DependencyAdmissionDecision } from "./plugin-lifecycle/dependency-admission.js";
import { ownedMarketplaceScopeKey, type ExecutableAdmissionGeneration, type OwnedMarketplaceRecord, type OwnedPluginInstallationRecord } from "./plugin-lifecycle/admission.js";
import { pluginMutableRecordKey } from "./plugin-lifecycle/plugin-service.js";
import type { LifecycleObservationEnvelope } from "./plugin-lifecycle/projection.js";
import { lookupCapability } from "./registry/capability-registry.js";
import type {
  Diagnostic, EffectivePluginEnablement, NormalizedPluginInstallation, PluginMarketplaceFieldProvenance, PluginMarketplaceProvenance,
  PluginMarketplacePolicyObservation, PluginMarketplaceState, PluginResolutionOutcome, PluginResolutionStatus, SupportTier,
} from "./types.js";

const LIMIT = Object.freeze({ items: 2048, installations: 64, declarations: 64, components: 128, dependencies: 128, renames: 64, marketplaces: 256, policies: 256, diagnostics: 128, evidence: 256, fields: 64 });
export const PLUGIN_INVENTORY_SESSION_BOUNDARY = "Captured for this session; run canonical /reload in the interactive TUI, or exit and relaunch PiCC to refresh.";
export const PLUGIN_INVENTORY_COMMAND_BOUNDARY = "Captured for this command; run the command again to refresh.";

type RuntimeComponentKind = "skills" | "commands" | "agents" | "hooks" | "mcpServers" | "lspServers";
type UnsupportedComponentKind = "workflows" | "outputStyles" | "themes" | "monitors" | "experimental.themes" | "experimental.monitors" | "channels";
type ComponentKind = RuntimeComponentKind | UnsupportedComponentKind;
export interface PluginInventoryLocation { readonly kind: "project" | "main-checkout" | "claude-user" | "plugin-cache" | "plugin-data" | "marketplace-cache" | "external"; readonly display: string }
export type PluginInventoryDiagnosticCategory = NonNullable<Diagnostic["category"]> | "enabled-plugins-not-object" | "enabled-plugins-invalid-identity" | "enabled-plugins-non-boolean" | "lifecycle-observation";
export interface PluginInventoryDiagnostic { readonly severity: Diagnostic["severity"]; readonly message: string; readonly category?: PluginInventoryDiagnosticCategory; readonly sourceClass?: Diagnostic["sourceClass"]; readonly impact?: Diagnostic["impact"] }
export interface PluginInventoryProvenance {
  readonly source: PluginInventoryLocation;
  readonly scope?: string;
  readonly origin?: string;
  readonly order?: number;
  readonly field?: string;
  readonly entryIndex?: number;
  readonly itemIndex?: number;
  readonly key?: string;
}
export type PluginInventoryComponentCountSemantics = "selected-manifest-declarations" | "catalog-declarations" | "finalized-registrations" | "retained-executable-registrations";
interface PluginInventoryComponentBase {
  readonly declaration?: "path" | "paths" | "object" | "shape" | "default-layout";
  readonly count: number;
  readonly capabilityId: string;
  readonly supportTier: SupportTier;
  readonly executionRisk: "context" | "code" | "network-or-process" | "unsupported-runtime";
  readonly provenance?: PluginInventoryProvenance;
  readonly declaredPath?: string;
  readonly safeShape?: { readonly keys: readonly { readonly key: string; readonly type: string }[]; readonly omitted: number };
}
export type PluginInventoryComponent = PluginInventoryComponentBase & (
  | { readonly origin: "selected-manifest"; readonly kind: ComponentKind; readonly countSemantics: "selected-manifest-declarations" }
  | { readonly origin: "catalog"; readonly kind: ComponentKind; readonly countSemantics: "catalog-declarations"; readonly posture: "declared-not-effective" }
  | { readonly origin: "final-runtime"; readonly kind: Exclude<RuntimeComponentKind, "hooks">; readonly countSemantics: "finalized-registrations"; readonly posture: "final-loaded" }
  | { readonly origin: "final-runtime"; readonly kind: "hooks"; readonly countSemantics: "retained-executable-registrations"; readonly posture: "final-loaded" }
);
export interface PluginInventoryCapabilityEvidence { readonly capabilityId: string; readonly qualifiedIdentity: string; readonly component?: string; readonly supportTier?: SupportTier; readonly observation: string }
export interface PluginInventoryInstallation {
  readonly scope?: string; readonly version?: string; readonly validity: "valid" | "invalid"; readonly selected: boolean;
  readonly location?: PluginInventoryLocation; readonly projectLocation?: PluginInventoryLocation; readonly metadata?: SafePluginManifestProjection;
  readonly diagnostics: readonly PluginInventoryDiagnostic[]; readonly problems: readonly string[];
}
export interface PluginInventoryCatalogDeclaration {
  readonly source: Readonly<Record<string, string>>; readonly sourceEffect?: { readonly availability: string; readonly location?: PluginInventoryLocation; readonly provenance: PluginInventoryProvenance };
  readonly release?: { readonly kind: string; readonly value: string; readonly evidence?: string; readonly provenance: PluginInventoryProvenance };
  readonly version?: string; readonly revision?: string; readonly revisionEvidence?: string; readonly description?: string;
  readonly fieldProvenance: Readonly<Record<string, PluginInventoryProvenance>>;
  readonly strict: { readonly value: boolean; readonly presence: "explicit" | "default"; readonly provenance: PluginInventoryProvenance };
  readonly defaultEnabled: { readonly value: boolean; readonly presence: "explicit" | "default"; readonly provenance: PluginInventoryProvenance };
  readonly userConfig?: { readonly keys: readonly { readonly key: string; readonly type: string }[]; readonly omitted: number; readonly provenance: PluginInventoryProvenance; readonly posture: "declared-not-effective" };
  readonly provenance: PluginInventoryProvenance; readonly runtimeEffect: "declared-not-effective";
}
export type PluginInventoryOwnership = "picc-owned" | "claude-imported-readonly" | "managed" | "seed" | "unknown";
export interface PluginInventoryDependencyPosture { readonly state: "satisfied" | "blocked" | "indeterminate" | "not-evaluated"; readonly reason?: string }
export interface PluginInventoryLifecycleCandidate {
  readonly mutableRecordKey: string; readonly scope: string; readonly ownership: PluginInventoryOwnership; readonly selected: boolean;
  readonly installed: boolean; readonly trusted?: boolean; readonly immutableRevision?: string; readonly integrity?: string; readonly root?: PluginInventoryLocation;
}
export interface PluginInventoryLifecycleOperation {
  readonly operationId: string; readonly status: "pending" | "terminal-residue" | "invalid" | "failed-before-commit";
  readonly semanticStep: string; readonly target?: string; readonly recoveryCommand: string; readonly category: "complete-or-rollback" | "inspect";
}
export interface PluginInventoryLifecycleState {
  readonly ownership: PluginInventoryOwnership; readonly marketplaceOwnership?: PluginInventoryOwnership; readonly mutableRecordKey?: string; readonly selectedScope?: string;
  readonly candidates?: readonly PluginInventoryLifecycleCandidate[]; readonly selectionRequired?: boolean; readonly selectionGuidance?: string;
  readonly availableActions: readonly ("install" | "update" | "reinstall" | "enable" | "disable" | "uninstall")[];
  readonly installed: boolean; readonly declared?: boolean; readonly effectiveEnabled?: boolean; readonly loaded: boolean;
  readonly trusted?: boolean; readonly immutableRevision?: string; readonly integrity?: string; readonly root?: PluginInventoryLocation;
  readonly defaultEnablementSource?: string; readonly dependency: PluginInventoryDependencyPosture;
  readonly readOnlyReason?: string; readonly pendingStep?: string; readonly recoveryCategory?: "complete-or-rollback" | "inspect" | "restart-required";
  readonly recoveryCommand?: string; readonly lifecycleOperations?: readonly PluginInventoryLifecycleOperation[]; readonly pendingReload: boolean; readonly retainedErrors: readonly string[];
}
export interface PluginInventoryItem {
  readonly qualifiedIdentity: string; readonly lifecycleName: string; readonly marketplaceName: string; readonly manifestNamespace?: string;
  readonly catalogPresence: boolean; readonly installations: readonly PluginInventoryInstallation[];
  readonly enablement?: { readonly enabled: boolean; readonly scope: string; readonly source: PluginInventoryLocation };
  readonly selectedInstallation?: { readonly scope: string; readonly version: string; readonly root: PluginInventoryLocation; readonly project?: PluginInventoryLocation; readonly data: PluginInventoryLocation; readonly provenance: { readonly state: PluginInventoryLocation; readonly stateVersion: number; readonly installedAt?: string; readonly lastUpdated?: string } };
  readonly outcome?: { readonly status: PluginResolutionStatus; readonly sharedStateCauses: readonly string[] };
  readonly metadata?: SafePluginManifestProjection; readonly catalogDeclarations: readonly PluginInventoryCatalogDeclaration[];
  readonly dependencies: readonly { readonly origin: "selected-manifest" | "catalog"; readonly targetIdentity: string; readonly version?: string; readonly versionStatus?: string; readonly posture: string; readonly crossMarketplace: string; readonly provenance: PluginInventoryProvenance }[];
  readonly renames: readonly { readonly from: string; readonly target: string | null; readonly status: string; readonly posture: "declared-not-effective"; readonly provenance: PluginInventoryProvenance }[];
  readonly components: readonly PluginInventoryComponent[]; readonly executionRisk: readonly PluginInventoryComponent["executionRisk"][];
  readonly diagnostics: readonly PluginInventoryDiagnostic[];
  readonly lifecycle?: PluginInventoryLifecycleState;
}
export interface PluginInventoryMarketplaceCandidate { readonly mutableRecordKey: string; readonly scope: string; readonly selected: boolean; readonly trusted: boolean }
export interface PluginInventoryMarketplace {
  readonly name: string; readonly selected: boolean; readonly validity: "valid" | "rejected"; readonly source: Readonly<Record<string, string>>;
  readonly ownership?: PluginInventoryOwnership; readonly mutableRecordKey?: string; readonly trusted?: boolean; readonly candidates?: readonly PluginInventoryMarketplaceCandidate[]; readonly selectionRequired?: boolean; readonly selectionGuidance?: string; readonly readOnlyReason?: string; readonly pendingStep?: string;
  readonly lifecycleOperations?: readonly PluginInventoryLifecycleOperation[]; readonly availableActions?: readonly ("inspect" | "refresh" | "remove")[];
  readonly origin: string; readonly scope: string; readonly fixtureContract?: "fixture-derived-unverified"; readonly catalog?: PluginInventoryLocation;
  readonly sourceProvenance: PluginInventoryProvenance; readonly provenance: PluginInventoryProvenance;
}
export interface PluginInventoryMarketplaceCatalog { readonly marketplace: string; readonly catalog: PluginInventoryLocation; readonly metadata?: { readonly pluginRoot: PluginInventoryLocation; readonly declaredPluginRoot?: string; readonly provenance: PluginInventoryProvenance; readonly posture: "inert-lexical-effect-only" }; readonly provenance: PluginInventoryProvenance }
export interface PluginInventoryAllowlistObservation { readonly marketplace: string; readonly allowedMarketplace: string; readonly provenance: PluginInventoryProvenance; readonly posture: "declared-not-effective" }
export interface PluginInventoryConflictObservation { readonly identity: string; readonly winner: PluginInventoryProvenance; readonly loser: PluginInventoryProvenance; readonly posture: "observed-conflict-not-effective" }
export interface PluginInventoryPolicyObservation { readonly kind: string; readonly descriptor?: Readonly<Record<string, string>>; readonly descriptorProvenance?: PluginInventoryProvenance; readonly match: PluginMarketplacePolicyObservation["match"]; readonly validScope: boolean; readonly emptyLockdown: boolean; readonly posture: "claude-lifecycle-observation-not-enforced"; readonly provenance: PluginInventoryProvenance }
export interface PluginInventoryDurableProjection {
  readonly generationId?: string; readonly pluginIdentities: readonly string[]; readonly marketplaceNames: readonly string[];
  readonly pendingOperations: readonly PluginInventoryLifecycleOperation[];
  readonly terminalOperations: readonly { readonly operationId: string; readonly outcome: "committed" | "rolled-back" | "failed-before-commit"; readonly semanticStep: string; readonly target?: string; readonly recoveryCommand?: string; readonly category?: "inspect" }[];
  readonly retainedErrors: readonly string[]; readonly omissions: Readonly<Record<string, number>>;
}
export interface PluginInventorySnapshot {
  readonly capturedAt: string; readonly lifetime: "session" | "command"; readonly refreshGuidance: string; readonly installedStateStatus: PluginInstalledStateStatus;
  readonly loadedGenerationId?: string; readonly durableDesired?: PluginInventoryDurableProjection;
  readonly items: readonly PluginInventoryItem[]; readonly marketplaces: readonly PluginInventoryMarketplace[]; readonly marketplaceCatalogs: readonly PluginInventoryMarketplaceCatalog[];
  readonly allowlistObservations: readonly PluginInventoryAllowlistObservation[]; readonly conflictObservations: readonly PluginInventoryConflictObservation[]; readonly policyObservations: readonly PluginInventoryPolicyObservation[];
  readonly diagnostics: readonly PluginInventoryDiagnostic[]; readonly capabilityEvidence: readonly PluginInventoryCapabilityEvidence[]; readonly omissions: Readonly<Record<string, number>>;
  find(qualifiedIdentity: string): PluginInventoryItem | undefined;
}
interface FinalLoadedPluginComponents { readonly skills: number; readonly commands: number; readonly agents: number; readonly hooks: number }
export interface BuildPluginInventorySnapshotOptions {
  lifetime?: "session" | "command"; capturedAt?: string; projectRoot: string; mainCheckout?: string; userDir: string;
  installedStateStatus: PluginInstalledStateStatus; installedObservations: readonly InstalledPluginObservation[]; installedObservationDiagnostics?: readonly Diagnostic[];
  installedObservationOmissions?: Readonly<Record<string, number>>; metadataReadCapability?: PluginMetadataReadCapability;
  enablementDiagnostics?: readonly Diagnostic[];
  marketplaceState: PluginMarketplaceState; enablement: Readonly<Record<string, EffectivePluginEnablement>>; outcomes: readonly PluginResolutionOutcome[];
  selectedPlugins: readonly InstalledPlugin[]; finalLoadedComponents?: Readonly<Record<string, FinalLoadedPluginComponents>>;
  diagnostics?: readonly Diagnostic[]; capabilityEvidence?: readonly PluginInventoryCapabilityEvidence[];
  lifecycleObservation?: LifecycleObservationEnvelope; loadedGeneration?: ExecutableAdmissionGeneration;
  applicableOwnedRecordKeys?: readonly string[]; selectedOwnedMarketplaces?: readonly OwnedMarketplaceRecord[];
  dependencyDecisions?: readonly DependencyAdmissionDecision[]; runtimeSelections?: readonly { readonly pluginId: string; readonly installation: NormalizedPluginInstallation }[]; explicitEnablementIdentities?: readonly string[];
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function boundedText(value: string, maximum = 256): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/(token|secret|password|credential|api[-_]?key)\s*[:=]\s*\S+/gi, "$1=<redacted>").slice(0, maximum); }
function safeToken(value: string, fallback: string): string { return /^[A-Za-z0-9][A-Za-z0-9._:@/+*-]{0,255}$/.test(value) ? value : fallback; }
function safeEvidenceObservation(value: string, assessed: boolean): string {
  if (!assessed) return value.startsWith("Plugin hook event") ? "Plugin hook event is unassessed because its capability registry entry is absent" : "Capability observation is unassessed because its registry entry is absent";
  return /^(?:Plugin agent field (?:hooks|mcpServers|permissionMode) was stripped before runtime construction|Plugin hook event support is (?:full|partial|degraded-noop|not-supported)|Plugin hook handler support is (?:full|partial|degraded-noop|not-supported)|Final loaded component support is (?:full|partial|degraded-noop|not-supported)|Selected manifest declares an unsupported plugin component)$/.test(value)
    ? value
    : "Capability limitation observed";
}
function nativeAbsolute(value: string): boolean { return process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(value) && !/^[\\/]{2}/.test(value) : value.startsWith("/") && !value.startsWith("//"); }
function within(root: string, candidate: string): string | undefined { const relative = path.relative(root, candidate); return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) ? relative : undefined; }
function resolvedAnchor(value: string | undefined): string | undefined { return value !== undefined && nativeAbsolute(value) ? path.resolve(value) : undefined; }
function location(value: string | undefined, options: BuildPluginInventorySnapshotOptions, marketplace = false): PluginInventoryLocation | undefined {
  if (value === undefined || !nativeAbsolute(value)) return value === undefined ? undefined : Object.freeze({ kind: "external", display: "<external>" });
  const anchors: Array<[string | undefined, PluginInventoryLocation["kind"], string]> = [
    [resolvedAnchor(options.projectRoot), "project", "<project>"], [resolvedAnchor(options.mainCheckout), "main-checkout", "<main-checkout>"],
    [resolvedAnchor(path.join(options.userDir, "plugins", "cache")), "plugin-cache", "<plugin-cache>"],
    [resolvedAnchor(path.join(options.userDir, "plugins", "marketplaces")), "marketplace-cache", "<marketplace-cache>"],
    [resolvedAnchor(path.join(options.userDir, "plugins", "data")), "plugin-data", "<plugin-data>"], [resolvedAnchor(options.userDir), "claude-user", "<claude-user>"],
  ];
  for (const [root, kind, label] of anchors) if (root !== undefined) { const relative = within(root, path.resolve(value)); if (relative !== undefined) return Object.freeze({ kind: marketplace && kind === "plugin-cache" ? "marketplace-cache" : kind, display: relative ? `${label}/${relative.split(path.sep).join("/")}` : label }); }
  return Object.freeze({ kind: "external", display: "<external>" });
}
function identity(value: string): { lifecycleName: string; marketplaceName: string } { const at = value.lastIndexOf("@"); return { lifecycleName: safeToken(value.slice(0, at), "unknown"), marketplaceName: safeToken(value.slice(at + 1), "unknown") }; }
function diag(value: Diagnostic): PluginInventoryDiagnostic { const managed = value.category !== undefined; return Object.freeze({ severity: value.severity, message: managed ? "Managed plugin policy evidence affected startup" : boundedText(value.message, 512), ...(value.category === undefined ? {} : { category: value.category }), ...(value.sourceClass === undefined ? {} : { sourceClass: value.sourceClass }), ...(value.impact === undefined ? {} : { impact: value.impact }) }); }
function enablementDiagnostic(value: Diagnostic): PluginInventoryDiagnostic | undefined {
  if (value.message === 'Setting "enabledPlugins" is not an object; ignored') return Object.freeze({ severity: value.severity, category: "enabled-plugins-not-object" as const, message: "The enabledPlugins declaration was not an object and was ignored" });
  if (value.message === 'Invalid plugin identity in "enabledPlugins" ignored') return Object.freeze({ severity: value.severity, category: "enabled-plugins-invalid-identity" as const, message: "An invalid qualified plugin identity in enabledPlugins was ignored" });
  if (/^Plugin ".*" in "enabledPlugins" must be a literal boolean; ignored$/u.test(value.message)) return Object.freeze({ severity: value.severity, category: "enabled-plugins-non-boolean" as const, message: "A non-boolean enabledPlugins value was ignored" });
  return undefined;
}
type ProvenanceEvidence = { sourcePath: string; field?: string; entryIndex?: number; itemIndex?: number; key?: string };
function safeIndex(value: number | undefined): number | undefined { return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function provenance(value: ProvenanceEvidence | PluginMarketplaceProvenance, options: BuildPluginInventorySnapshotOptions, context?: PluginMarketplaceProvenance): PluginInventoryProvenance {
  const full = "scope" in value ? value : context;
  const field = "field" in value && value.field !== undefined ? safeToken(value.field, "unknown-field") : undefined;
  const entryIndex = "entryIndex" in value ? safeIndex(value.entryIndex) : undefined;
  const itemIndex = "itemIndex" in value ? safeIndex(value.itemIndex) : undefined;
  const order = safeIndex(full?.order);
  return Object.freeze({
    source: location(value.sourcePath, options, true) ?? Object.freeze({ kind: "external" as const, display: "<external>" }),
    ...(full === undefined ? {} : { scope: safeToken(full.scope, "unknown"), origin: safeToken(full.origin, "unknown") }),
    ...(order === undefined ? {} : { order }), ...(field === undefined ? {} : { field }), ...(entryIndex === undefined ? {} : { entryIndex }),
    ...(itemIndex === undefined ? {} : { itemIndex }), ...("key" in value && value.key !== undefined ? { key: safeToken(value.key, "<redacted-key>") } : {}),
  });
}
function sourceText(value: string, key: string): string {
  if (key === "url" || key === "registry") { try { const parsed = new URL(value); parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = ""; return boundedText(parsed.toString(), 512); } catch { return "<redacted>"; } }
  if (key === "path" || key === "value" || key === "localPath") return !path.isAbsolute(value) && !value.includes("\0") ? boundedText(value, 512) : "<redacted>";
  return boundedText(value, 512);
}
function sourceProjection(value: object): Readonly<Record<string, string>> { const raw = value as Record<string, unknown>; const out: Record<string, string> = {}; for (const key of ["kind", "value", "repo", "ref", "url", "path", "localPath", "package", "version", "registry", "sha", "hostPattern", "pathPattern"] as const) if (typeof raw[key] === "string") out[key] = sourceText(raw[key], key); return Object.freeze(out); }
function componentCapability(kind: ComponentKind): string { return ({ skills: "feature.plugins-skills", commands: "feature.plugins-commands", agents: "feature.plugins-agents", hooks: "feature.plugins-hooks", mcpServers: "feature.mcp-plugin-servers", lspServers: "feature.plugins-other-components", workflows: "feature.plugins-other-components", outputStyles: "feature.plugins-other-components", themes: "feature.plugins-other-components", monitors: "feature.plugins-other-components", "experimental.themes": "feature.plugins-other-components", "experimental.monitors": "feature.plugins-other-components", channels: "feature.plugins-other-components" })[kind]; }
function risk(kind: ComponentKind): PluginInventoryComponent["executionRisk"] { return kind === "skills" ? "context" : kind === "mcpServers" ? "network-or-process" : ["lspServers", "workflows", "outputStyles", "themes", "monitors", "experimental.themes", "experimental.monitors", "channels"].includes(kind) ? "unsupported-runtime" : "code"; }
function observedComponent(kind: ComponentKind, origin: "selected-manifest" | "catalog", count: number, declaration?: PluginInventoryComponent["declaration"], itemProvenance?: PluginInventoryProvenance): PluginInventoryComponent {
  const capabilityId = componentCapability(kind);
  const base = { kind, count, ...(declaration === undefined ? {} : { declaration }), capabilityId, supportTier: lookupCapability(capabilityId)?.tier ?? "not-supported", executionRisk: risk(kind), ...(itemProvenance === undefined ? {} : { provenance: itemProvenance }) };
  return origin === "selected-manifest"
    ? Object.freeze({ ...base, origin, countSemantics: "selected-manifest-declarations" })
    : Object.freeze({ ...base, origin, countSemantics: "catalog-declarations", posture: "declared-not-effective" });
}
function finalComponent(kind: RuntimeComponentKind, count: number): PluginInventoryComponent {
  const capabilityId = componentCapability(kind);
  const base = { count, declaration: "default-layout" as const, capabilityId, supportTier: lookupCapability(capabilityId)?.tier ?? "not-supported", executionRisk: risk(kind), origin: "final-runtime" as const, posture: "final-loaded" as const };
  return kind === "hooks"
    ? Object.freeze({ ...base, kind, countSemantics: "retained-executable-registrations" })
    : Object.freeze({ ...base, kind, countSemantics: "finalized-registrations" });
}
function metadata(value: SafePluginManifestProjection): SafePluginManifestProjection { return Object.freeze({ ...value, keywords: Object.freeze(value.keywords.slice(0, 32).map((item) => boundedText(item))), ...(value.dependencies === undefined ? {} : { dependencies: Object.freeze(value.dependencies.slice(0, LIMIT.dependencies).map((item) => Object.freeze({ name: safeToken(item.name, "unknown"), ...(item.version === undefined ? {} : { version: boundedText(item.version) }), ...(item.marketplace === undefined ? {} : { marketplace: safeToken(item.marketplace, "unknown") }), itemIndex: safeIndex(item.itemIndex) ?? 0 }))) }), components: Object.freeze(value.components.slice(0, 64).map((item) => Object.freeze({ ...item }))), omissions: Object.freeze({ keywords: value.omissions?.keywords ?? Math.max(0, value.keywords.length - 32), ...(value.dependencies === undefined ? {} : { dependencies: (value.omissions?.dependencies ?? 0) + Math.max(0, value.dependencies.length - LIMIT.dependencies) }), components: value.omissions?.components ?? Math.max(0, value.components.length - 64), diagnostics: value.omissions?.diagnostics ?? 0 }) }); }
function catalogProvenance(value: PluginMarketplaceProvenance & { catalogPath: string; entryIndex?: number }, options: BuildPluginInventorySnapshotOptions): PluginInventoryProvenance {
  return provenance({ sourcePath: value.catalogPath, ...(value.entryIndex === undefined ? {} : { entryIndex: value.entryIndex }) }, options, value);
}
function safeShape(value: { keys: readonly { key: string; type: string }[]; omitted: number; provenance: PluginMarketplaceFieldProvenance }, options: BuildPluginInventorySnapshotOptions, context: PluginMarketplaceProvenance) { return Object.freeze({ keys: Object.freeze(value.keys.slice(0, LIMIT.fields).map((item) => Object.freeze({ key: safeToken(item.key, "<redacted-key>"), type: item.type }))), omitted: value.omitted + Math.max(0, value.keys.length - LIMIT.fields), provenance: provenance(value.provenance, options, context), posture: "declared-not-effective" as const }); }
function addOmission(target: Record<string, number>, key: string, count: number): void { if (count > 0) target[key] = (target[key] ?? 0) + count; }
function cap<T>(values: readonly T[], maximum: number, omissions: Record<string, number>, key: string): readonly T[] { addOmission(omissions, key, Math.max(0, values.length - maximum)); return values.slice(0, maximum); }
function selectedObservation(value: InstalledPluginObservation, outcome: PluginResolutionOutcome | undefined): boolean { const install = outcome?.installation; return install !== undefined && value.declared.scope === install.scope && value.declared.version === install.version && value.declared.installPath === install.installPath && value.declared.projectPath === install.projectPath; }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeOptionalToken(value: unknown): string | undefined { return typeof value === "string" && value.length <= 256 ? safeToken(value, "unknown") : undefined; }
interface LifecycleProjectionBuild {
  readonly plugins: ReadonlyMap<string, readonly PluginInventoryLifecycleCandidate[]>;
  readonly marketplaces: ReadonlyMap<string, readonly PluginInventoryMarketplaceCandidate[]>;
  readonly pluginEvidence: ReadonlyMap<string, { readonly pendingStep?: string; readonly recoveryCategory?: "complete-or-rollback" | "inspect"; readonly recoveryCommand?: string; readonly lifecycleOperations: readonly PluginInventoryLifecycleOperation[]; readonly retainedErrors: readonly string[] }>;
  readonly marketplaceEvidence: ReadonlyMap<string, { readonly pendingStep?: string; readonly lifecycleOperations: readonly PluginInventoryLifecycleOperation[]; readonly retainedErrors: readonly string[] }>;
  readonly durable: PluginInventoryDurableProjection; readonly mutationBlockedReason?: string;
}
function lifecycleProjection(options: BuildPluginInventorySnapshotOptions, omissions: Record<string, number>): LifecycleProjectionBuild {
  const envelope = options.lifecycleObservation;
  const pluginCandidates = new Map<string, PluginInventoryLifecycleCandidate[]>();
  const marketplaceCandidates = new Map<string, PluginInventoryMarketplaceCandidate[]>();
  const pluginEvidence = new Map<string, { pendingStep?: string; recoveryCategory?: "complete-or-rollback" | "inspect"; recoveryCommand?: string; lifecycleOperations: PluginInventoryLifecycleOperation[]; retainedErrors: string[] }>();
  const marketplaceEvidence = new Map<string, { pendingStep?: string; lifecycleOperations: PluginInventoryLifecycleOperation[]; retainedErrors: string[] }>();
  const pluginIds = new Set<string>(); const marketplaceNames = new Set<string>(); const retainedErrors: string[] = [];
  const desiredGenerationId = options.loadedGeneration?.generationId; let evidenceInvalid = false;
  const applicable = options.applicableOwnedRecordKeys === undefined ? undefined : new Set(options.applicableOwnedRecordKeys);
  const applicableMarketplaces = options.selectedOwnedMarketplaces === undefined ? undefined : new Set(options.selectedOwnedMarketplaces.map(ownedMarketplaceScopeKey));
  const selectedMarketplaceScopes = new Map<string, Set<string>>();
  for (const registration of options.marketplaceState.selectedRegistrations) (selectedMarketplaceScopes.get(registration.name) ?? selectedMarketplaceScopes.set(registration.name, new Set()).get(registration.name)!).add(registration.provenance.scope);
  const records = cap(envelope?.records ?? [], LIMIT.installations * 4, omissions, "lifecycle.records");
  if ((envelope?.records.length ?? 0) > records.length) evidenceInvalid = true;
  for (const observation of records) {
    if (observation.status !== "admitted") { evidenceInvalid = true; retainedErrors.push(`Owned lifecycle record is inert (${safeToken(observation.code ?? "unknown", "unknown")})`); continue; }
    const producer = observation.producer; if (producer === undefined) { evidenceInvalid = true; retainedErrors.push("Owned lifecycle producer evidence is missing"); continue; } const payload = producer.payload;
    if (producer.schema === "plugin-installation" && plain(payload)) {
      const pluginId = safeOptionalToken(payload.pluginId); const scope = safeOptionalToken(payload.scope); const profileKey = safeOptionalToken(payload.profileKey);
      const projectKey = safeOptionalToken(payload.projectKey); if (pluginId === undefined || !pluginId.includes("@") || scope === undefined || profileKey === undefined) { evidenceInvalid = true; retainedErrors.push("Owned plugin lifecycle evidence is malformed"); continue; }
      const key = pluginMutableRecordKey({ pluginId: pluginId as OwnedPluginInstallationRecord["pluginId"], scope: scope as OwnedPluginInstallationRecord["scope"], profileKey: profileKey as OwnedPluginInstallationRecord["profileKey"], ...(projectKey === undefined ? {} : { projectKey }) });
      if (applicable !== undefined && !applicable.has(key)) continue;
      pluginIds.add(pluginId); const generation = safeOptionalToken(payload.executableGenerationId);
      if (generation === undefined || desiredGenerationId !== undefined && generation !== desiredGenerationId) { evidenceInvalid = true; retainedErrors.push("Owned installation generation disagrees with the validated admission generation"); }
      const root = typeof payload.installRoot === "string" ? location(payload.installRoot, options) : undefined;
      const candidate: PluginInventoryLifecycleCandidate = Object.freeze({ mutableRecordKey: key, scope, ownership: "picc-owned", selected: false, installed: true, trusted: plain(payload.trust), ...(safeOptionalToken(payload.version) === undefined ? {} : { immutableRevision: safeOptionalToken(payload.version) }), ...(safeOptionalToken(payload.executableDigest) === undefined ? {} : { integrity: safeOptionalToken(payload.executableDigest) }), ...(root === undefined ? {} : { root }) });
      (pluginCandidates.get(pluginId) ?? pluginCandidates.set(pluginId, []).get(pluginId)!).push(candidate);
    } else if (producer.schema === "marketplace-registration" && plain(payload)) {
      const name = safeOptionalToken(payload.name); const scope = safeOptionalToken(payload.scope); const profileKey = safeOptionalToken(payload.profileKey);
      if (name === undefined || scope === undefined || profileKey === undefined) { evidenceInvalid = true; retainedErrors.push("Owned marketplace lifecycle evidence is malformed"); continue; }
      const key = ownedMarketplaceScopeKey({ name, scope: scope as OwnedMarketplaceRecord["scope"], profileKey: profileKey as OwnedMarketplaceRecord["profileKey"], ...(safeOptionalToken(payload.checkoutFamilyKey) === undefined ? {} : { checkoutFamilyKey: safeOptionalToken(payload.checkoutFamilyKey)! as OwnedMarketplaceRecord["checkoutFamilyKey"] }), ...(safeOptionalToken(payload.projectKey) === undefined ? {} : { projectKey: safeOptionalToken(payload.projectKey)! as OwnedMarketplaceRecord["projectKey"] }) });
      if (applicableMarketplaces !== undefined && !applicableMarketplaces.has(key)) continue;
      marketplaceNames.add(name); const scopes = selectedMarketplaceScopes.get(name); const candidate = Object.freeze({ mutableRecordKey: key, scope, selected: scopes?.size === 1 && scopes.has(scope), trusted: true });
      (marketplaceCandidates.get(name) ?? marketplaceCandidates.set(name, []).get(name)!).push(candidate);
    }
  }
  const pendingOperations: Array<PluginInventoryDurableProjection["pendingOperations"][number]> = [];
  const terminalOperations: Array<PluginInventoryDurableProjection["terminalOperations"][number]> = [];
  const decodeTarget = (summary: unknown, producerSchema: unknown, operationId: string): { action: string; target?: string; pluginId?: string; marketplaceName?: string } | undefined => {
    if (!plain(summary) || summary.operationId !== operationId || typeof summary.action !== "string") return undefined;
    const action = safeOptionalToken(summary.action); if (action === undefined) return undefined;
    if (producerSchema === "plugin-lifecycle") { const pluginId = safeOptionalToken(summary.pluginId); return pluginId?.includes("@") ? { action, target: pluginId, pluginId } : undefined; }
    if (producerSchema === "marketplace-lifecycle") { const registration = plain(summary.registration) ? summary.registration : undefined; const name = safeOptionalToken(registration?.name); return name === undefined ? undefined : { action, target: name, marketplaceName: name }; }
    return { action };
  };
  for (const pending of cap(envelope?.pending ?? [], LIMIT.diagnostics, omissions, "lifecycle.pending")) {
    const operationId = safeToken(pending.operationId, "unknown-operation"); const journal = plain(pending.journal) ? pending.journal : undefined;
    const decoded = journal === undefined ? undefined : decodeTarget(journal.confirmationSummary, journal.producerSchema, operationId);
    if (pending.status === "invalid" || decoded === undefined) { evidenceInvalid = true; retainedErrors.push("Lifecycle recovery evidence is invalid or ambiguously attributed"); }
    const completed = typeof journal?.completed === "number" && Number.isSafeInteger(journal.completed) && journal.completed >= 0 ? journal.completed : 0;
    const semanticStep = decoded === undefined ? "invalid lifecycle recovery evidence" : `${decoded.action}; ${completed} committed step${completed === 1 ? "" : "s"}`;
    const category = pending.status === "pending" && decoded !== undefined ? "complete-or-rollback" as const : "inspect" as const;
    const operation = Object.freeze({ operationId, status: pending.status, semanticStep, ...(decoded?.target === undefined ? {} : { target: decoded.target }), recoveryCommand: `picc plugin recover ${operationId}`, category });
    pendingOperations.push(operation);
    if (decoded?.pluginId !== undefined) { pluginIds.add(decoded.pluginId); const evidence = pluginEvidence.get(decoded.pluginId) ?? { lifecycleOperations: [], retainedErrors: [] }; evidence.pendingStep = semanticStep; evidence.recoveryCategory = category; evidence.recoveryCommand = operation.recoveryCommand; evidence.lifecycleOperations.push(operation); pluginEvidence.set(decoded.pluginId, evidence); }
    if (decoded?.marketplaceName !== undefined) { marketplaceNames.add(decoded.marketplaceName); const evidence = marketplaceEvidence.get(decoded.marketplaceName) ?? { lifecycleOperations: [], retainedErrors: [] }; evidence.pendingStep = semanticStep; evidence.lifecycleOperations.push(operation); marketplaceEvidence.set(decoded.marketplaceName, evidence); }
  }
  for (const receiptObservation of cap(envelope?.receipts ?? [], LIMIT.diagnostics, omissions, "lifecycle.receipts")) {
    if (receiptObservation.status !== "present" || !plain(receiptObservation.receipt)) { evidenceInvalid = true; retainedErrors.push("A retained lifecycle receipt is invalid"); continue; }
    const receipt = receiptObservation.receipt; const operationId = safeOptionalToken(receipt.operationId); const outcome = receipt.outcome;
    const decoded = operationId === undefined ? undefined : decodeTarget(receipt.confirmationSummary, receipt.producerSchema, operationId);
    if (decoded === undefined || !(outcome === "committed" || outcome === "rolled-back" || outcome === "failed-before-commit")) { evidenceInvalid = true; retainedErrors.push("A retained lifecycle receipt summary is malformed or ambiguously attributed"); continue; }
    const semanticStep = `${decoded.action}; ${outcome}`; const recoveryCommand = `picc plugin recover ${operationId!}`;
    terminalOperations.push(Object.freeze({ operationId: operationId!, outcome, semanticStep, ...(decoded.target === undefined ? {} : { target: decoded.target }), ...(outcome === "failed-before-commit" ? { recoveryCommand, category: "inspect" as const } : {}) }));
    if (outcome !== "committed") {
      const message = boundedText(`Lifecycle ${decoded.action} ended ${outcome}`);
      const operation = outcome === "failed-before-commit" ? Object.freeze({ operationId: operationId!, status: outcome, semanticStep, ...(decoded.target === undefined ? {} : { target: decoded.target }), recoveryCommand, category: "inspect" as const }) : undefined;
      if (decoded.pluginId !== undefined) { const evidence = pluginEvidence.get(decoded.pluginId) ?? { lifecycleOperations: [], retainedErrors: [] }; evidence.retainedErrors.push(message); if (operation !== undefined) evidence.lifecycleOperations.push(operation); pluginEvidence.set(decoded.pluginId, evidence); }
      else if (decoded.marketplaceName !== undefined) { const evidence = marketplaceEvidence.get(decoded.marketplaceName) ?? { lifecycleOperations: [], retainedErrors: [] }; evidence.retainedErrors.push(message); if (operation !== undefined) evidence.lifecycleOperations.push(operation); marketplaceEvidence.set(decoded.marketplaceName, evidence); }
    }
  }
  if ((envelope?.pending.length ?? 0) > LIMIT.diagnostics || (envelope?.receipts.length ?? 0) > LIMIT.diagnostics) evidenceInvalid = true;
  const freezeCandidates = <T extends { mutableRecordKey: string; scope: string }>(source: Map<string, T[]>): ReadonlyMap<string, readonly T[]> => new Map([...source].map(([key, values]) => [key, Object.freeze([...values].sort((a, b) => compare(a.scope, b.scope) || compare(a.mutableRecordKey, b.mutableRecordKey))) ]));
  const mutationBlockedReason = evidenceInvalid ? "Lifecycle evidence is invalid, incomplete, or ambiguous; inspect recovery before mutation" : pendingOperations.length > 0 ? "Lifecycle recovery is pending; inspect or recover it before another mutation" : undefined;
  const durable = Object.freeze({ ...(desiredGenerationId === undefined ? {} : { generationId: boundedText(desiredGenerationId) }), pluginIdentities: Object.freeze([...pluginIds].sort(compare)), marketplaceNames: Object.freeze([...marketplaceNames].sort(compare)), pendingOperations: Object.freeze(pendingOperations), terminalOperations: Object.freeze(terminalOperations), retainedErrors: Object.freeze(cap(retainedErrors, LIMIT.diagnostics, omissions, "lifecycle.errors").map((value) => boundedText(value, 256))), omissions: Object.freeze({}) });
  return { plugins: freezeCandidates(pluginCandidates), marketplaces: freezeCandidates(marketplaceCandidates), pluginEvidence: new Map([...pluginEvidence].map(([key, value]) => [key, Object.freeze({ ...value, lifecycleOperations: Object.freeze([...value.lifecycleOperations]), retainedErrors: Object.freeze([...value.retainedErrors]) })])), marketplaceEvidence: new Map([...marketplaceEvidence].map(([key, value]) => [key, Object.freeze({ ...value, lifecycleOperations: Object.freeze([...value.lifecycleOperations]), retainedErrors: Object.freeze([...value.retainedErrors]) })])), durable, ...(mutationBlockedReason === undefined ? {} : { mutationBlockedReason }) };
}

export function buildPluginInventorySnapshot(options: BuildPluginInventorySnapshotOptions): PluginInventorySnapshot {
  const omissions: Record<string, number> = {}; const lifecycle = lifecycleProjection(options, omissions);
  for (const [key, count] of Object.entries(options.installedObservationOmissions ?? {})) addOmission(omissions, `loader.installed.${safeToken(key, "unknown")}`, count);
  for (const [key, count] of Object.entries(options.marketplaceState.omissions)) addOmission(omissions, `loader.marketplace.${safeToken(key, "unknown")}`, count);
  const ids = new Set<string>();
  for (const value of options.installedObservations) ids.add(value.qualifiedIdentity); for (const value of options.marketplaceState.entries) ids.add(value.identity); for (const value of lifecycle.durable.pluginIdentities) ids.add(value);
  for (const value of Object.keys(options.enablement)) ids.add(value); for (const value of options.outcomes) ids.add(value.pluginId); for (const value of options.selectedPlugins) ids.add(value.pluginId);
  const idList = cap([...ids].sort(compare), LIMIT.items, omissions, "snapshot.items");
  const selected = new Map<string, InstalledPlugin>(); for (const value of options.selectedPlugins) if (!selected.has(value.pluginId)) selected.set(value.pluginId, value); else addOmission(omissions, "snapshot.duplicate-selected", 1);
  const outcomes = new Map<string, PluginResolutionOutcome>(); for (const value of options.outcomes) if (!outcomes.has(value.pluginId)) outcomes.set(value.pluginId, value); else addOmission(omissions, "snapshot.duplicate-outcomes", 1);
  const provenanceContext = (value: PluginMarketplaceFieldProvenance): PluginMarketplaceProvenance | undefined => {
    const entry = options.marketplaceState.entries.find((item) => item.provenance.catalogPath === value.sourcePath);
    if (entry !== undefined) return entry.provenance;
    const catalog = options.marketplaceState.catalogs.find((item) => item.catalogPath === value.sourcePath);
    if (catalog !== undefined) return catalog.provenance;
    const rename = options.marketplaceState.renames.find((item) => item.provenance.catalogPath === value.sourcePath);
    if (rename !== undefined) return rename.provenance;
    return options.marketplaceState.policies.find((item) => item.provenance.sourcePath === value.sourcePath)?.provenance;
  };
  const items: PluginInventoryItem[] = [];
  for (const qualifiedIdentityRaw of idList) {
    const qualifiedIdentity = safeToken(qualifiedIdentityRaw, "unknown@unknown"); const names = identity(qualifiedIdentityRaw); const selectedPlugin = selected.get(qualifiedIdentityRaw); const outcome = outcomes.get(qualifiedIdentityRaw);
    const observedAll = options.installedObservations.filter((value) => value.qualifiedIdentity === qualifiedIdentityRaw); const observed = cap(observedAll, LIMIT.installations, omissions, "snapshot.installations");
    const catalogEntries = cap(options.marketplaceState.entries.filter((value) => value.identity === qualifiedIdentityRaw), LIMIT.declarations, omissions, "snapshot.catalog-declarations");
    const itemDiagnostics: PluginInventoryDiagnostic[] = (outcome?.diagnostics ?? selectedPlugin?.diagnostics ?? []).map(diag);
    const installations: PluginInventoryInstallation[] = observed.map((value) => {
      const isSelected = selectedObservation(value, outcome); let observedMetadata: ReturnType<typeof readObservedPluginMetadata> | undefined;
      if (!isSelected && value.validity === "valid" && value.declared.installPath !== undefined && options.metadataReadCapability !== undefined) observedMetadata = readObservedPluginMetadata(value.declared.installPath, options.metadataReadCapability);
      const diagnostics = observedMetadata?.diagnostics.map(diag) ?? []; itemDiagnostics.push(...diagnostics);
      if (observedMetadata?.projection !== undefined) for (const [key, count] of Object.entries(observedMetadata.projection.omissions ?? {})) addOmission(omissions, `snapshot.metadata.${key}`, count);
      addOmission(omissions, "snapshot.installation-problems", Math.max(0, value.problems.length - 32));
      return Object.freeze({ ...(value.declared.scope === undefined ? {} : { scope: boundedText(value.declared.scope) }), ...(value.declared.version === undefined ? {} : { version: boundedText(value.declared.version) }), validity: value.validity, selected: isSelected, ...(value.declared.installPath === undefined ? {} : { location: location(value.declared.installPath, options) }), ...(value.declared.projectPath === undefined ? {} : { projectLocation: location(value.declared.projectPath, options) }), ...(observedMetadata?.projection === undefined ? {} : { metadata: metadata(observedMetadata.projection) }), diagnostics: Object.freeze(diagnostics), problems: Object.freeze(value.problems.slice(0, 32).map((problem) => safeToken(problem, "unknown-problem"))) });
    });
    const components: PluginInventoryComponent[] = [];
    if (selectedPlugin !== undefined) for (const declaration of selectedPlugin.manifestProjection.components) {
      const manifestProvenance = Object.freeze({ source: location(path.join(selectedPlugin.root, ".claude-plugin", "plugin.json"), options) ?? Object.freeze({ kind: "external" as const, display: "<external>" }), field: declaration.field });
      components.push(observedComponent(declaration.field, "selected-manifest", declaration.count, declaration.declaration, manifestProvenance));
    }
    const finalCounts = options.finalLoadedComponents?.[qualifiedIdentityRaw] ?? (selectedPlugin === undefined ? undefined : { skills: 0, commands: 0, agents: 0, hooks: 0 });
    if (finalCounts !== undefined) for (const kind of ["skills", "commands", "agents", "hooks"] as const) if (finalCounts[kind] > 0) components.push(finalComponent(kind, finalCounts[kind]));
    for (const entry of catalogEntries) {
      for (const kind of ["commands", "agents", "skills", "hooks", "mcpServers", "lspServers"] as const) for (const declaration of entry.components[kind] ?? []) {
        const base = observedComponent(kind, "catalog", declaration.kind === "object-shape" ? declaration.shape.keys.length : 1, declaration.kind === "path" ? "path" : "object", provenance(declaration.provenance, options, entry.provenance));
        if (declaration.kind === "path") components.push(Object.freeze({ ...base, declaredPath: sourceText(declaration.value, "path") }));
        else { const keys = declaration.shape.keys.slice(0, LIMIT.fields).map((item) => Object.freeze({ key: safeToken(item.key, "<redacted-key>"), type: item.type })); components.push(Object.freeze({ ...base, safeShape: Object.freeze({ keys: Object.freeze(keys), omitted: declaration.shape.omitted + Math.max(0, declaration.shape.keys.length - LIMIT.fields) }) })); addOmission(omissions, "snapshot.catalog-component-shape", declaration.shape.omitted + Math.max(0, declaration.shape.keys.length - LIMIT.fields)); }
      }
      for (const declaration of entry.unsupportedComponents ?? []) components.push(observedComponent(declaration.field, "catalog", declaration.count, "shape", provenance(declaration.provenance, options, entry.provenance)));
    }
    const keptComponents = cap(components, LIMIT.components, omissions, "snapshot.components");
    const declarations: PluginInventoryCatalogDeclaration[] = catalogEntries.map((entry) => Object.freeze({ source: sourceProjection(entry.source), ...(entry.sourceEffect === undefined ? {} : { sourceEffect: Object.freeze({ availability: entry.sourceEffect.availability, ...(entry.sourceEffect.lexicalPath === undefined ? {} : { location: location(entry.sourceEffect.lexicalPath, options) }), provenance: provenance(entry.sourceEffect.provenance, options, entry.provenance) }) }), ...(entry.release === undefined ? {} : { release: Object.freeze({ kind: entry.release.kind, value: boundedText(entry.release.value), ...(entry.release.evidence === undefined ? {} : { evidence: entry.release.evidence }), provenance: provenance(entry.release.provenance, options, entry.provenance) }) }), ...(entry.version === undefined ? {} : { version: boundedText(entry.version) }), ...(entry.revision === undefined ? {} : { revision: boundedText(entry.revision) }), ...(entry.revisionEvidence === undefined ? {} : { revisionEvidence: entry.revisionEvidence }), ...(entry.description === undefined ? {} : { description: boundedText(entry.description, 512) }), fieldProvenance: Object.freeze(Object.fromEntries(Object.entries(entry.fieldProvenance).slice(0, LIMIT.fields).map(([key, value]) => [safeToken(key, "unknown-field"), provenance(value, options, entry.provenance)]))), strict: Object.freeze({ value: entry.strictDeclaration.value, presence: entry.strictDeclaration.presence, provenance: provenance(entry.strictDeclaration.provenance, options, entry.provenance) }), defaultEnabled: Object.freeze({ value: entry.defaultEnabledDeclaration.value, presence: entry.defaultEnabledDeclaration.presence, provenance: provenance(entry.defaultEnabledDeclaration.provenance, options, entry.provenance) }), ...(entry.userConfig === undefined ? {} : { userConfig: safeShape(entry.userConfig, options, entry.provenance) }), provenance: catalogProvenance(entry.provenance, options), runtimeEffect: entry.runtimeEffect }));
    for (const entry of catalogEntries) { addOmission(omissions, "snapshot.catalog-field-provenance", Math.max(0, Object.keys(entry.fieldProvenance).length - LIMIT.fields)); if (entry.userConfig !== undefined) addOmission(omissions, "snapshot.catalog-user-config", entry.userConfig.omitted + Math.max(0, entry.userConfig.keys.length - LIMIT.fields)); }
    const selectedAllowedMarketplaces = new Set(options.marketplaceState.allowlists.filter((value) => value.marketplace === names.marketplaceName).map((value) => value.allowedMarketplace));
    const selectedDependencyValues: PluginInventoryItem["dependencies"][number][] = (selectedPlugin?.manifestProjection.dependencies ?? []).map((value) => {
      const targetMarketplace = value.marketplace ?? names.marketplaceName;
      const crossMarketplace = targetMarketplace === names.marketplaceName ? "same-marketplace" : selectedAllowedMarketplaces.has(targetMarketplace) ? "declared-allowed" : options.marketplaceState.omissions.allowlists > 0 ? "indeterminate-because-evidence-omitted" : "declared-not-allowed";
      return Object.freeze({ origin: "selected-manifest", targetIdentity: safeToken(`${value.name}@${targetMarketplace}`, "unknown@unknown"), ...(value.version === undefined ? {} : { version: boundedText(value.version), versionStatus: "syntax-unverified-not-resolved" }), posture: "selected-manifest-observed-not-resolved", crossMarketplace, provenance: Object.freeze({ source: location(selectedPlugin === undefined ? undefined : path.join(selectedPlugin.root, ".claude-plugin", "plugin.json"), options) ?? Object.freeze({ kind: "external" as const, display: "<external>" }), field: "dependencies", itemIndex: value.itemIndex }) });
    });
    const catalogDependencyValues: PluginInventoryItem["dependencies"][number][] = catalogEntries.flatMap((entry) => entry.dependencies.map((value) => Object.freeze({ origin: "catalog", targetIdentity: safeToken(value.targetIdentity, "unknown@unknown"), ...(value.version === undefined ? {} : { version: boundedText(value.version) }), ...(value.versionStatus === undefined ? {} : { versionStatus: value.versionStatus }), posture: value.posture, crossMarketplace: value.crossMarketplace, provenance: provenance(value.provenance, options, entry.provenance) })));
    const dependencies = [...cap(selectedDependencyValues, LIMIT.dependencies, omissions, "snapshot.dependencies.selected-manifest"), ...cap(catalogDependencyValues, LIMIT.dependencies, omissions, "snapshot.dependencies.catalog")];
    const renameValues = options.marketplaceState.renames.filter((value) => value.currentIdentity === qualifiedIdentityRaw || `${value.from}@${value.marketplace}` === qualifiedIdentityRaw);
    const renames = cap(renameValues, LIMIT.renames, omissions, "snapshot.renames").map((value) => Object.freeze({ from: safeToken(value.from, "unknown"), target: value.declaredTarget === null ? null : safeToken(value.declaredTarget, "unknown"), status: value.status, posture: value.runtimeEffect, provenance: provenance(value.fieldProvenance, options, value.provenance) }));
    const enablement = options.enablement[qualifiedIdentityRaw]; const uniqueRisk = [...new Set(keptComponents.map((value) => value.executionRisk))].sort(compare);
    if (selectedPlugin !== undefined) for (const [key, count] of Object.entries(selectedPlugin.manifestProjection.omissions ?? {})) addOmission(omissions, key === "dependencies" ? "snapshot.dependencies.selected-manifest" : `snapshot.metadata.${key}`, count);
    const rawCandidates = lifecycle.plugins.get(qualifiedIdentityRaw) ?? Object.freeze([]); const managed = observed.some((value) => value.declared.scope === "managed");
    const runtimeSelection = outcome?.installation ?? options.runtimeSelections?.find((value) => value.pluginId === qualifiedIdentityRaw)?.installation;
    const selectedCandidates = rawCandidates.filter((candidate) => runtimeSelection !== undefined && candidate.scope === runtimeSelection.scope && candidate.immutableRevision === runtimeSelection.version && candidate.root?.display === location(runtimeSelection.installPath, options)?.display);
    const selectedCandidate = selectedCandidates.length === 1 ? selectedCandidates[0] : undefined;
    const candidates = Object.freeze(rawCandidates.map((candidate) => Object.freeze({ ...candidate, selected: candidate === selectedCandidate })));
    const selectionRequired = rawCandidates.length > 1;
    const lifecycleOwnership: PluginInventoryOwnership = selectedCandidate?.ownership ?? (rawCandidates.length > 0 ? "picc-owned" : managed ? "managed" : observed.length > 0 ? "claude-imported-readonly" : "unknown");
    const loaded = outcome?.status === "loaded"; const installed = selectedCandidate?.installed ?? (observed.some((value) => value.validity === "valid") || rawCandidates.length > 0);
    const evidence = lifecycle.pluginEvidence.get(qualifiedIdentityRaw); const explicitDeclared = options.explicitEnablementIdentities?.includes(qualifiedIdentityRaw) ?? (enablement !== undefined && !enablement.source.startsWith("picc-owned:"));
    const dependencyDecision = options.dependencyDecisions?.find((value) => value.pluginId === qualifiedIdentityRaw);
    const dependencyReasons = dependencyDecision?.reasons ?? [];
    const dependency: PluginInventoryDependencyPosture = enablement?.enabled === false ? Object.freeze({ state: "not-evaluated", reason: "Plugin is disabled; dependencies were not activation blockers" }) : dependencyDecision === undefined ? Object.freeze({ state: "not-evaluated" }) : dependencyReasons.length > 0 ? Object.freeze({ state: dependencyReasons.includes("indeterminate") ? "indeterminate" : "blocked", reason: `Dependency assembly decision: ${dependencyReasons.join(", ")}` }) : dependencyDecision.admitted ? Object.freeze({ state: "satisfied" }) : Object.freeze({ state: "not-evaluated" });
    const loadedGenerationId = options.loadedGeneration?.generationId;
    const generationDiverged = lifecycle.durable.generationId !== undefined && loadedGenerationId !== undefined && lifecycle.durable.generationId !== loadedGenerationId;
    const activationDiverged = loaded && !installed || installed && enablement?.enabled === true && !loaded && dependency.state === "satisfied";
    const pendingReload = generationDiverged || activationDiverged;
    const retainedErrors = Object.freeze(cap(evidence?.retainedErrors ?? [], LIMIT.diagnostics, omissions, "lifecycle.item-errors").map((value) => boundedText(value, 256)));
    const marketplaceCandidates = lifecycle.marketplaces.get(names.marketplaceName) ?? []; const marketplaceOwnership: PluginInventoryOwnership | undefined = marketplaceCandidates.length > 0 ? "picc-owned" : undefined;
    const catalogInstallEligible = !installed && catalogEntries.length > 0 && marketplaceCandidates.length === 1 && marketplaceCandidates[0]?.selected === true && lifecycle.mutationBlockedReason === undefined;
    const targetReady = selectedCandidate !== undefined && !selectionRequired && lifecycle.mutationBlockedReason === undefined;
    const availableActions: PluginInventoryLifecycleState["availableActions"] = catalogInstallEligible ? ["install"] : targetReady ? ["update", "reinstall", "enable", "disable", "uninstall"] : [];
    const readOnlyReason = lifecycle.mutationBlockedReason ?? (selectionRequired ? "More than one writable scope is available; select an exact scope before mutation" : rawCandidates.length > 0 && selectedCandidate === undefined ? "No exact runtime-selected writable target was observed" : lifecycleOwnership === "managed" ? "Administrator-owned installation" : lifecycleOwnership === "seed" ? "Seed installation is managed at its source" : lifecycleOwnership === "claude-imported-readonly" ? "Claude-owned installation; use Claude Code to mutate it" : undefined);
    const defaultEnablementSource = explicitDeclared ? "explicit-setting" : selectedCandidate !== undefined && enablement !== undefined ? "derived-owned-default" : selectedPlugin?.manifestProjection.defaultEnabled?.presence === "explicit" ? "manifest-default" : "enabled-by-default";
    const itemLifecycle: PluginInventoryLifecycleState = Object.freeze({ ownership: lifecycleOwnership, ...(marketplaceOwnership === undefined ? {} : { marketplaceOwnership }), candidates, ...(selectionRequired ? { selectionRequired: true, selectionGuidance: "Select one exact writable scope before previewing a lifecycle mutation" } : {}), availableActions: Object.freeze(availableActions), ...(selectedCandidate === undefined ? {} : { mutableRecordKey: selectedCandidate.mutableRecordKey, selectedScope: selectedCandidate.scope, trusted: selectedCandidate.trusted, immutableRevision: selectedCandidate.immutableRevision, integrity: selectedCandidate.integrity, root: selectedCandidate.root }), installed, declared: explicitDeclared, effectiveEnabled: enablement?.enabled, loaded, defaultEnablementSource, dependency, ...(readOnlyReason === undefined ? {} : { readOnlyReason }), ...(evidence?.pendingStep === undefined ? {} : { pendingStep: evidence.pendingStep }), ...(evidence?.recoveryCategory === undefined ? {} : { recoveryCategory: evidence.recoveryCategory }), ...(evidence?.recoveryCommand === undefined ? {} : { recoveryCommand: evidence.recoveryCommand }), lifecycleOperations: evidence?.lifecycleOperations ?? Object.freeze([]), pendingReload, retainedErrors });
    items.push(Object.freeze({ qualifiedIdentity, ...names, ...(selectedPlugin === undefined ? {} : { manifestNamespace: selectedPlugin.name }), catalogPresence: catalogEntries.length > 0, installations: Object.freeze(installations), ...(enablement === undefined ? {} : { enablement: Object.freeze({ enabled: enablement.enabled, scope: enablement.scope, source: location(enablement.source, options) ?? Object.freeze({ kind: "external" as const, display: "<external>" }) }) }), ...(selectedPlugin === undefined ? {} : { selectedInstallation: Object.freeze({ scope: selectedPlugin.scope, version: boundedText(selectedPlugin.version), root: location(selectedPlugin.root, options) ?? Object.freeze({ kind: "external" as const, display: "<external>" }), ...(selectedPlugin.projectPath === undefined ? {} : { project: location(selectedPlugin.projectPath, options) }), data: location(selectedPlugin.dataDir, options) ?? Object.freeze({ kind: "external" as const, display: "<external>" }), provenance: Object.freeze({ state: location(selectedPlugin.installation.provenance.statePath, options) ?? Object.freeze({ kind: "external" as const, display: "<external>" }), stateVersion: selectedPlugin.installation.provenance.stateVersion, ...(selectedPlugin.installation.provenance.installedAt === undefined ? {} : { installedAt: boundedText(selectedPlugin.installation.provenance.installedAt) }), ...(selectedPlugin.installation.provenance.lastUpdated === undefined ? {} : { lastUpdated: boundedText(selectedPlugin.installation.provenance.lastUpdated) }) }) }) }), ...(outcome === undefined ? {} : { outcome: Object.freeze({ status: outcome.status, sharedStateCauses: Object.freeze([...(outcome.sharedStateCauses ?? [])]) }) }), ...(selectedPlugin === undefined ? {} : { metadata: metadata(selectedPlugin.manifestProjection) }), catalogDeclarations: Object.freeze(declarations), dependencies: Object.freeze(dependencies), renames: Object.freeze(renames), components: Object.freeze(keptComponents), executionRisk: Object.freeze(uniqueRisk), diagnostics: Object.freeze(cap(itemDiagnostics, LIMIT.diagnostics, omissions, "snapshot.item-diagnostics")), lifecycle: itemLifecycle }));
  }
  const marketplaces: PluginInventoryMarketplace[] = cap(options.marketplaceState.registrations, LIMIT.marketplaces, omissions, "snapshot.marketplaces").map((value) => {
    const candidates = lifecycle.marketplaces.get(value.name) ?? Object.freeze([]); const selected = candidates.filter((candidate) => candidate.selected); const selectedCandidate = selected.length === 1 ? selected[0] : undefined; const selectionRequired = candidates.length > 1; const evidence = lifecycle.marketplaceEvidence.get(value.name);
    const blocked = lifecycle.mutationBlockedReason ?? (selectionRequired ? "More than one writable marketplace scope is available; select an exact scope before mutation" : candidates.length > 0 && selectedCandidate === undefined ? "No exact selected writable marketplace scope was observed" : undefined);
    return Object.freeze({ name: safeToken(value.name, "unknown"), selected: value.selected, validity: value.validity, source: sourceProjection(value.source), candidates, ...(candidates.length === 0 ? { ownership: "claude-imported-readonly" as PluginInventoryOwnership, readOnlyReason: "Claude-owned marketplace; use Claude Code to mutate it", availableActions: Object.freeze(["inspect"] as const) } : { ownership: "picc-owned" as const, ...(selectedCandidate === undefined ? {} : { mutableRecordKey: selectedCandidate.mutableRecordKey, trusted: selectedCandidate.trusted }), ...(selectionRequired ? { selectionRequired: true, selectionGuidance: "Select one exact writable marketplace scope before previewing a mutation" } : {}), ...(blocked === undefined ? { availableActions: Object.freeze(["inspect", "refresh", "remove"] as const) } : { availableActions: Object.freeze(["inspect"] as const), readOnlyReason: blocked }) }), ...(evidence?.pendingStep === undefined ? {} : { pendingStep: evidence.pendingStep }), lifecycleOperations: evidence?.lifecycleOperations ?? Object.freeze([]), origin: safeToken(value.provenance.origin, "unknown"), scope: safeToken(value.provenance.scope, "unknown"), ...(value.fixtureContract === undefined ? {} : { fixtureContract: value.fixtureContract }), ...(value.catalogPath === undefined ? {} : { catalog: location(value.catalogPath, options, true) }), sourceProvenance: provenance(value.sourceProvenance, options, value.provenance), provenance: provenance(value.provenance, options) });
  });
  for (const name of lifecycle.durable.marketplaceNames) if (!marketplaces.some((value) => value.name === name)) { if (marketplaces.length >= LIMIT.marketplaces) { addOmission(omissions, "snapshot.marketplaces", 1); continue; } const candidates = lifecycle.marketplaces.get(name) ?? Object.freeze([]); const selected = candidates.filter((value) => value.selected); const selectedCandidate = selected.length === 1 ? selected[0] : undefined; const selectionRequired = candidates.length > 1; const blocked = lifecycle.mutationBlockedReason ?? (selectionRequired ? "More than one writable marketplace scope is available; select an exact scope before mutation" : selectedCandidate === undefined ? "No exact selected writable marketplace scope was observed" : undefined); const evidence = lifecycle.marketplaceEvidence.get(name); marketplaces.push(Object.freeze({ name, selected: selectedCandidate !== undefined, validity: "valid", source: Object.freeze({}), ownership: "picc-owned", candidates, ...(selectedCandidate === undefined ? {} : { mutableRecordKey: selectedCandidate.mutableRecordKey, trusted: selectedCandidate.trusted }), ...(selectionRequired ? { selectionRequired: true, selectionGuidance: "Select one exact writable marketplace scope before previewing a mutation" } : {}), ...(blocked === undefined ? { availableActions: Object.freeze(["inspect", "refresh", "remove"] as const) } : { availableActions: Object.freeze(["inspect"] as const), readOnlyReason: blocked }), ...(evidence?.pendingStep === undefined ? {} : { pendingStep: evidence.pendingStep }), lifecycleOperations: evidence?.lifecycleOperations ?? Object.freeze([]), origin: "picc-owned", scope: selectedCandidate?.scope ?? "unknown", sourceProvenance: Object.freeze({ source: Object.freeze({ kind: "external", display: "<external>" }) }), provenance: Object.freeze({ source: Object.freeze({ kind: "external", display: "<external>" }) }) })); }
  const marketplaceCatalogs = cap(options.marketplaceState.catalogs, LIMIT.marketplaces, omissions, "snapshot.marketplace-catalogs").map((value) => Object.freeze({ marketplace: safeToken(value.marketplace, "unknown"), catalog: location(value.catalogPath, options, true) ?? Object.freeze({ kind: "external" as const, display: "<external>" }), ...(value.metadata === undefined ? {} : { metadata: Object.freeze({ pluginRoot: location(value.metadata.pluginRoot, options, true) ?? Object.freeze({ kind: "external" as const, display: "<external>" }), ...(!path.isAbsolute(value.metadata.pluginRoot) ? { declaredPluginRoot: sourceText(value.metadata.pluginRoot, "path") } : {}), provenance: provenance(value.metadata.provenance, options, value.provenance), posture: value.metadata.posture }) }), provenance: provenance(value.provenance, options) }));
  const allowlistObservations = cap(options.marketplaceState.allowlists, LIMIT.declarations, omissions, "snapshot.allowlists").map((value) => Object.freeze({ marketplace: safeToken(value.marketplace, "unknown"), allowedMarketplace: safeToken(value.allowedMarketplace, "unknown"), provenance: provenance(value.provenance, options, provenanceContext(value.provenance)), posture: "declared-not-effective" as const }));
  const conflictObservations = cap(options.marketplaceState.conflicts, LIMIT.declarations, omissions, "snapshot.conflicts").map((value) => Object.freeze({ identity: safeToken(value.identity, "unknown@unknown"), winner: provenance(value.winner, options, provenanceContext(value.winner)), loser: provenance(value.loser, options, provenanceContext(value.loser)), posture: value.posture }));
  const policyObservations = cap(options.marketplaceState.policies, LIMIT.policies, omissions, "snapshot.policies").map((value) => Object.freeze({ kind: value.kind, ...(value.descriptor === undefined ? {} : { descriptor: sourceProjection(value.descriptor) }), ...(value.descriptorProvenance === undefined ? {} : { descriptorProvenance: provenance(value.descriptorProvenance, options, value.provenance) }), match: value.match, validScope: value.validScope, emptyLockdown: value.emptyLockdown === true, posture: value.posture, provenance: provenance(value.provenance, options) }));
  const classifiedEnablementDiagnostics = (options.enablementDiagnostics ?? []).map(enablementDiagnostic).filter((value): value is PluginInventoryDiagnostic => value !== undefined);
  const ordinaryGlobalDiagnostics = [...(options.installedObservationDiagnostics ?? []), ...options.marketplaceState.diagnostics, ...(options.diagnostics ?? [])].map(diag);
  ordinaryGlobalDiagnostics.push(...lifecycle.durable.retainedErrors.map((message) => Object.freeze({ severity: "warning" as const, category: "lifecycle-observation" as const, message })));
  const globalDiagnostics = cap([...classifiedEnablementDiagnostics, ...ordinaryGlobalDiagnostics], LIMIT.diagnostics, omissions, "snapshot.diagnostics");
  const componentEvidence: PluginInventoryCapabilityEvidence[] = items.flatMap((item) => item.components.filter((value) => (value.origin === "final-runtime" && value.supportTier !== "full") || (value.origin === "selected-manifest" && value.executionRisk === "unsupported-runtime")).map((value) => ({ capabilityId: value.capabilityId, qualifiedIdentity: item.qualifiedIdentity, component: value.kind, observation: value.origin === "selected-manifest" ? "Selected manifest declares an unsupported plugin component" : `Final loaded component support is ${value.supportTier}` })));
  const seen = new Set<string>(); const evidenceValues: PluginInventoryCapabilityEvidence[] = [];
  for (const value of [...(options.capabilityEvidence ?? []), ...componentEvidence]) { const rawCapability = safeToken(value.capabilityId, "unassessed"); const capability = lookupCapability(rawCapability); const assessed = capability !== undefined; const capabilityId = rawCapability; const qualifiedIdentity = safeToken(value.qualifiedIdentity, "unknown@unknown"); const componentName = value.component === undefined ? undefined : safeToken(value.component, "unknown-component"); const observation = safeEvidenceObservation(value.observation, assessed); const key = `${capabilityId}\0${qualifiedIdentity}\0${componentName ?? ""}\0${observation}`; if (seen.has(key)) continue; seen.add(key); evidenceValues.push(Object.freeze({ capabilityId, qualifiedIdentity, ...(componentName === undefined ? {} : { component: componentName }), ...(capability === undefined ? {} : { supportTier: capability.tier }), observation })); }
  const capabilityEvidence = cap(evidenceValues, LIMIT.evidence, omissions, "snapshot.capability-evidence");
  const index = new Map(items.map((value) => [value.qualifiedIdentity, value]));
  const durableDesired = Object.freeze({ ...lifecycle.durable, omissions: Object.freeze(Object.fromEntries(Object.entries(omissions).filter(([key]) => key.startsWith("lifecycle.")))) });
  return Object.freeze({ capturedAt: boundedText(options.capturedAt ?? new Date().toISOString()), lifetime: options.lifetime ?? "session", refreshGuidance: (options.lifetime ?? "session") === "command" ? PLUGIN_INVENTORY_COMMAND_BOUNDARY : PLUGIN_INVENTORY_SESSION_BOUNDARY, installedStateStatus: options.installedStateStatus, ...(options.loadedGeneration === undefined ? {} : { loadedGenerationId: boundedText(options.loadedGeneration.generationId) }), durableDesired, items: Object.freeze(items), marketplaces: Object.freeze(marketplaces), marketplaceCatalogs: Object.freeze(marketplaceCatalogs), allowlistObservations: Object.freeze(allowlistObservations), conflictObservations: Object.freeze(conflictObservations), policyObservations: Object.freeze(policyObservations), diagnostics: Object.freeze(globalDiagnostics), capabilityEvidence: Object.freeze(capabilityEvidence), omissions: Object.freeze({ ...omissions }), find: (qualifiedIdentity: string) => index.get(qualifiedIdentity) });
}

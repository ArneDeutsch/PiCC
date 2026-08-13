import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { loadPluginMarketplaceState } from "./claude/plugin-marketplaces.js";
import { resolveClaudeProfile, type ClaudeProfile } from "./discovery/claude-profile.js";
import { loadClaudeProject, type LoadedProject } from "./project.js";
import { createExecutableAdmissionGenerationCodec, createOwnedMarketplaceCodec, createOwnedMarketplaceSnapshotCodec, createOwnedPluginInstallationCodec, observeExecutableGenerationFile, ownedMarketplaceScopeKey, readOwnedAdmissionRecords, type MarketplaceSnapshotAuthority } from "./plugin-lifecycle/admission.js";
import { createLifecycleLocations } from "./plugin-lifecycle/locations.js";
import type { MarketplaceMutationPreview, MarketplaceReceipt } from "./plugin-lifecycle/planner.js";
import { createMarketplaceAcquisitionAdapter, marketplaceSourceAnchor, PluginMarketplaceService, type MarketplaceObservation, type MarketplaceObservationList, type MarketplaceObservationView } from "./plugin-lifecycle/marketplace-service.js";
import { createPluginAcquisitionAdapter, decodePluginStableSelector, deriveOwnedPluginCatalogSelections, encodePluginStableSelector, inspectAcquiredPlugin, pluginMutableRecordKey, PluginLifecycleService, type PluginCatalogSelection, type PluginDetailsView, type PluginLocalSnapshot, type PluginMutationPreview, type PluginOperationLookup, type PluginReceipt, type PluginStableSelector } from "./plugin-lifecycle/plugin-service.js";
import type { PluginInventorySnapshot } from "./plugin-inventory.js";
import { LifecycleRecoveryService } from "./plugin-lifecycle/lifecycle-service.js";
import type { RecoveryPreview } from "./plugin-lifecycle/recovery.js";
import { planPluginSettingsWrite } from "./plugin-lifecycle/settings-plan.js";
import { canonicalJsonBytes, createProducerCodecRegistry, establishOwnedStateStore, type StoreResult } from "./plugin-lifecycle/state-store.js";
import { observePersistedTransactionsSync, type TransactionReceipt } from "./plugin-lifecycle/transaction.js";
import type { MarketplaceRegistrationSource, MutablePluginScope, QualifiedPluginIdentity } from "./plugin-lifecycle/types.js";
import { projectIdentities } from "./util/project-identity.js";
import {
  PLUGIN_INVENTORY_ARGV_USAGE,
  parsePluginInventoryArgv,
  renderPluginInventoryDetails,
  renderPluginInventoryOperation,
  sanitizePluginInventoryDisplayText,
  type PluginInventoryOperation,
} from "./runtime/plugin-inventory-text.js";

const PROJECT_UNAVAILABLE = "PiCC plugin inventory could not access the target project directory. Run from an accessible target project directory.";
const INVENTORY_INCOMPLETE_PREFIX = "PiCC plugin inventory may be incomplete";
const INVENTORY_FORMAT_RECOVERY = "Update PiCC or report the unsupported plugin-state format.";
const INVENTORY_REPAIR_RECOVERY = "Repair the malformed or unreadable Claude plugin state outside PiCC.";
const INVENTORY_DOCTOR_RECOVERY = "Run PiCC interactively in the same project and profile, then use `/doctor` for details.";
const MAX_ROWS = 100;
const MAX_PREVIEW_VALUES = 1024;

export interface PluginInventoryCliOutput {
  log(message: string): void;
  error(message: string): void;
}

interface PreparedMarketplace { readonly preview: MarketplaceMutationPreview; readonly execute: (digest: string) => Promise<StoreResult<MarketplaceReceipt> | { readonly ok: false; readonly code: string; readonly message: string; readonly receipt?: MarketplaceReceipt }> }
export type PluginLifecycleReceipt = MarketplaceReceipt | PluginReceipt | TransactionReceipt;
export type PluginLifecycleOperationLookup =
  | { readonly state: "pending"; readonly operationId: string; readonly completed: number; readonly total: number; readonly recoveryActions: readonly ("complete" | "rollback")[] }
  | { readonly state: "terminal"; readonly receipt: PluginLifecycleReceipt };
export interface PluginLifecycleExactTarget { readonly kind: "plugin" | "marketplace"; readonly identity: string; readonly scope: string; readonly mutableRecordKey: string; readonly selector: string }

/** One production lifecycle composition shared by the terminal command and focused TUI. */
export interface PluginLifecyclePort {
  readonly marketplaces: {
    listStatus(): MarketplaceObservationList;
    details(name: string, selector?: string): StoreResult<MarketplaceObservationView>;
    plan(operation: Extract<PluginInventoryOperation, { kind: "marketplace-add" | "marketplace-refresh" | "marketplace-remove" }>, signal?: AbortSignal): Promise<StoreResult<MarketplaceMutationPreview>>;
    prepare(preview: MarketplaceMutationPreview): StoreResult<PreparedMarketplace>;
    discardPreview(operationId: string): Promise<StoreResult<void>>;
  };
  readonly plugins: {
    list(): readonly PluginDetailsView[];
    details(identity: string): StoreResult<PluginDetailsView>;
    plan(operation: Extract<PluginInventoryOperation, { kind: "install" | "enable" | "disable" | "update" | "uninstall" }>, signal?: AbortSignal): Promise<StoreResult<PluginMutationPreview>>;
    execute(preview: PluginMutationPreview, digest: string): Promise<StoreResult<PluginReceipt> | { readonly ok: false; readonly code: string; readonly message: string; readonly receipt?: PluginReceipt }>;
    discardPreview(operationId: string): Promise<StoreResult<void>>;
  };
  readonly recovery: {
    list(): readonly { readonly operationId: string; readonly status: string }[];
    preview(operationId: string): Promise<StoreResult<RecoveryPreview>>;
    recover(operationId: string, action: "complete" | "rollback"): Promise<StoreResult<PluginLifecycleReceipt>>;
  };
  readonly targets: {
    plugin(identity: string, mutableRecordKey: string): StoreResult<PluginLifecycleExactTarget>;
    marketplace(name: string, mutableRecordKey: string): StoreResult<PluginLifecycleExactTarget>;
  };
  lookup(operationId: string): Promise<StoreResult<PluginLifecycleOperationLookup | undefined>>;
  projection(): StoreResult<PluginInventorySnapshot>;
}
export type PluginLifecycleCliServices = PluginLifecyclePort;

export interface PluginInventoryCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  stdinIsTTY?: boolean;
  confirm?: (preview: string) => Promise<boolean>;
  services?: (project: LoadedProject) => Promise<StoreResult<PluginLifecycleCliServices>> | StoreResult<PluginLifecycleCliServices>;
}

function readableDirectory(directory: string): boolean {
  try { const stat = fs.statSync(directory); if (!stat.isDirectory()) return false; fs.accessSync(directory, fs.constants.R_OK); fs.readdirSync(directory, { withFileTypes: true }); return true; }
  catch { return false; }
}
function readableProfile(userDir: string): boolean { try { const stat = fs.statSync(userDir, { throwIfNoEntry: false }); return stat === undefined || readableDirectory(userDir); } catch { return false; } }
function unreadableProfileMessage(profile: ClaudeProfile): string {
  switch (profile.source) {
    case "picc-override": return "PiCC plugin inventory could not read the Claude profile. Check PICC_CLAUDE_USER_DIR and permissions.";
    case "claude-config": return "PiCC plugin inventory could not read the Claude profile. Check CLAUDE_CONFIG_DIR and permissions.";
    case "default": return "PiCC plugin inventory could not read the Claude profile. Check default Claude profile permissions or set PICC_CLAUDE_USER_DIR.";
    case "explicit": return "PiCC plugin inventory could not read the selected Claude profile. Check its permissions.";
  }
}
function resolveCommandInputs(options: PluginInventoryCliOptions): { cwd: string; profile: ClaudeProfile } | { error: string } {
  let cwd: string; try { cwd = options.cwd ?? process.cwd(); } catch { return { error: PROJECT_UNAVAILABLE }; }
  if (!readableDirectory(cwd)) return { error: PROJECT_UNAVAILABLE };
  const profile = resolveClaudeProfile({ ...(options.env === undefined ? {} : { env: options.env }), ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }) });
  return readableProfile(profile.userDir) ? { cwd, profile } : { error: unreadableProfileMessage(profile) };
}
function incompleteStateWarning(status: "absent" | "valid" | "unreadable" | "unsupported" | "malformed", diagnostics: readonly { readonly category?: string; readonly sourceClass?: string; readonly message: string }[]): string {
  const classes = new Set<string>(); let unsupported = status === "unsupported"; let repair = status === "malformed" || status === "unreadable";
  for (const diagnostic of diagnostics) { const evidence = `${diagnostic.category ?? ""} ${diagnostic.sourceClass ?? ""} ${diagnostic.message}`.toLowerCase(); if (/installed|blocklist/u.test(evidence)) classes.add("installed plugin state"); if (/marketplace|catalog|allowlist/u.test(evidence)) classes.add("marketplace state"); if (/managed-policy/u.test(evidence)) classes.add("managed policy state"); if (/manifest|metadata/u.test(evidence)) classes.add("plugin metadata"); const format = /unsupported (?:format|version)|format is unsupported|undocumented/u.test(evidence); if (format) unsupported = true; else if (/malformed|unreadable|could not be read|invalid type|wrong (?:type|shape)/u.test(evidence)) repair = true; }
  const category = classes.size > 0 ? ` (${[...classes].sort().join(", ")})` : ""; const actions = [...(unsupported ? [INVENTORY_FORMAT_RECOVERY] : []), ...(repair || !unsupported ? [INVENTORY_REPAIR_RECOVERY] : []), INVENTORY_DOCTOR_RECOVERY]; return `${INVENTORY_INCOMPLETE_PREFIX}${category}. ${actions.join(" ")}`;
}
function safe(value: unknown, maximum = 240): string { return sanitizePluginInventoryDisplayText(typeof value === "string" ? value : String(value), maximum); }
function resultError(result: { readonly code: string; readonly message: string }): string {
  const operationId = /\b(?:marketplace|plugin)_[A-Za-z0-9_-]{1,120}\b/u.exec(result.message)?.[0];
  if (result.code === "pending-recovery") return `PiCC plugin lifecycle is pending recovery: safe partial progress may exist.${operationId === undefined ? "" : ` Operation ID: ${safe(operationId, 128)}. Run picc plugin recover ${safe(operationId, 128)}.`}`;
  return `PiCC plugin lifecycle refused (${safe(result.code, 80)}): ${safe(result.message, 1024)}. No durable desired state change was committed.`;
}
function marketplaceSelector(scopeKey: string): string { return Buffer.from(scopeKey, "utf8").toString("base64url"); }
function decodeCanonicalBase64Url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) return undefined;
  try { const decoded = Buffer.from(value, "base64url"); return decoded.toString("base64url") === value ? decoded.toString("utf8") : undefined; } catch { return undefined; }
}
function decodeMarketplaceSelector(value: string | undefined): string | undefined {
  if (value === undefined) return undefined; const decoded = decodeCanonicalBase64Url(value);
  return decoded !== undefined && /^marketplace-[a-f0-9]{64}$/u.test(decoded) ? decoded : undefined;
}
function decodePluginSelector(value: string, pluginId?: string): PluginStableSelector | undefined {
  const parsed = decodePluginStableSelector(value);
  return parsed !== undefined && (pluginId === undefined || parsed.pluginId === pluginId) ? parsed : undefined;
}
function same(left: unknown, right: unknown): boolean { const a = canonicalJsonBytes(left); const b = canonicalJsonBytes(right); return a.ok && b.ok && Buffer.from(a.value).equals(Buffer.from(b.value)); }
function digestText(value: unknown): string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : safe(value ?? "unchanged", 100); }
function componentText(value: string): string { const match = /^(skills|commands|agents|hooks|mcpServers|lspServers):.*:([0-9]+)$/u.exec(value); return match === null ? safe(value, 120) : `${match[1]} count ${match[2]}`; }
function source(operation: Extract<PluginInventoryOperation, { kind: "marketplace-add" }>): MarketplaceRegistrationSource {
  if (operation.sourceKind === "local-directory" || operation.sourceKind === "local-catalog-file") return { kind: operation.sourceKind, path: operation.sourceValue };
  if (operation.sourceKind === "github") return { kind: "github", repository: operation.sourceValue, ...(operation.ref === undefined ? {} : { ref: operation.ref }) };
  if (operation.sourceKind === "https-git") return { kind: "https-git", url: operation.sourceValue, ...(operation.ref === undefined ? {} : { ref: operation.ref }) };
  return { kind: "https-catalog", url: operation.sourceValue };
}
function displayAnchor(value: unknown): string {
  const bytes = canonicalJsonBytes(value); const digest = createHash("sha256").update(bytes.ok ? bytes.value : Buffer.from("unavailable", "utf8")).digest("hex");
  return `opaque-sha256:${digest}`;
}
function sourceAnchorText(sourceValue: unknown): string {
  if (typeof sourceValue !== "object" || sourceValue === null || Array.isArray(sourceValue)) return `kind=unavailable; display-anchor=${displayAnchor("unavailable")}`;
  const sourceRecord = sourceValue as Record<string, unknown>; const kind = typeof sourceRecord.kind === "string" ? safe(sourceRecord.kind, 40) : "unknown";
  const rawUrl = typeof sourceRecord.url === "string" ? sourceRecord.url : undefined; let origin: string | undefined;
  if (rawUrl !== undefined) { try { const parsed = new URL(rawUrl); if (parsed.protocol === "https:" && parsed.username === "" && parsed.password === "") origin = parsed.host; } catch {} }
  return `kind=${kind}${origin === undefined ? "" : `; origin-host=${safe(origin, 160)}`}; display-anchor=${displayAnchor(sourceValue)}`;
}
function renderMarketplaceRow(row: MarketplaceObservationView): string { const selector = row.registration === undefined ? undefined : marketplaceSelector(ownedMarketplaceScopeKey(row.registration)); return [`Marketplace: ${safe(row.name, 128)}`, `  owner: ${row.owner}; selected=${row.selected}; effective=${row.effective}; trusted=${row.trusted}`, `  scope/selector: ${safe(row.registration?.scope ?? "read-only", 80)}${selector === undefined ? "; read-only" : `; ${selector}`}`, `  source authority: ${sourceAnchorText(row.source)}`, `  plugins: ${row.plugins.length}${row.pluginOmitted > 0 ? `; … ${row.pluginOmitted} not shown` : ""}`, `  dependents: ${row.dependents.length}${row.dependentOmitted > 0 ? `; … ${row.dependentOmitted} not shown` : ""}`].join("\n"); }
function renderPluginRow(row: PluginDetailsView): string { return [`Plugin: ${safe(row.pluginId)}`, `  selector: ${safe(row.selector, 1024)}`, `  owner: ${row.owner}; scope=${row.scope}; enabled=${row.enabled}; trusted=${row.trusted}`, `  version: ${safe(row.version ?? "not installed")}`, ...(row.guidance === undefined ? [] : [`  guidance: ${safe(row.guidance)}`])].join("\n"); }
type ProjectPluginAdmission = LoadedProject["pluginAdmissions"][number];
interface ProjectSelectorCandidate { readonly pluginId: string; readonly selector: string; readonly row: string; readonly projection: ProjectPluginAdmission }
function projectSelectorCandidates(project: LoadedProject, identity?: string): readonly ProjectSelectorCandidate[] {
  return project.pluginAdmissions.flatMap((projection) => {
    const pluginId = projection.ownership === "picc-owned" ? projection.pluginId : projection.installation.pluginId; if (identity !== undefined && pluginId !== identity) return [];
    const value: PluginStableSelector = projection.ownership === "picc-owned" ? { pluginId: pluginId as QualifiedPluginIdentity, owner: "picc-owned", scope: projection.scope, profileKey: projection.authority.record.profileKey, ...(projection.authority.record.projectKey === undefined ? {} : { projectKey: projection.authority.record.projectKey }) } : { pluginId: pluginId as QualifiedPluginIdentity, owner: projection.installation.scope === "managed" ? "managed" : "claude-imported-readonly", scope: projection.installation.scope };
    const selector = encodePluginStableSelector(value); const readOnly = value.owner === "picc-owned" ? "writable" : "read-only";
    return [{ pluginId, selector, projection, row: `Scoped candidate: ${safe(pluginId)}; scope=${value.scope}; owner=${value.owner}; ${readOnly}; selector=${selector}` }];
  });
}
function projectSelectorRows(project: LoadedProject, identity?: string): readonly string[] { return projectSelectorCandidates(project, identity).map((candidate) => candidate.row); }
function completeLines(values: readonly string[], render: (value: string) => string = (value) => value): string[] { return values.map((value) => `- ${safe(render(value), 8192)}`); }
function previewArraysWithinBound(preview: MarketplaceMutationPreview | PluginMutationPreview): boolean {
  if ("registration" in preview) return preview.catalog.omittedEntries === 0 && [preview.catalog.plugins, preview.dependents, preview.consequences, preview.participants].every((values) => values.length <= MAX_PREVIEW_VALUES);
  const plugin = preview as PluginMutationPreview;
  return [plugin.executableComponents, plugin.dependencies.selected.reasons, plugin.dependencies.graph, plugin.dependencies.decisions ?? [], plugin.participants, plugin.consequences].every((values) => values.length <= MAX_PREVIEW_VALUES);
}
function renderMarketplacePreview(preview: MarketplaceMutationPreview): string {
  const plugins = preview.catalog.plugins.map((plugin) => plugin.supported ? `Plugin ${plugin.name} uses source kind ${plugin.sourceKind}` : `Plugin ${plugin.name} is unsupported because ${plugin.error}`); const selector = marketplaceSelector(ownedMarketplaceScopeKey(preview.registration));
  return ["Marketplace lifecycle preview", `Operation ID: ${safe(preview.operationId, 128)}`, `Operation/action/target: marketplace ${preview.action}; ${safe(preview.registration.name, 128)}`, `Selected marketplace scope/selector: ${preview.registration.scope}; ${selector}`, `Source authority: ${sourceAnchorText(preview.registration.source)}`, `Immutable snapshot: ${safe(preview.snapshot.snapshotId, 128)}; catalog digest=${digestText(preview.snapshot.catalogDigest)}; trust=${digestText(preview.snapshot.trust.targetDigest)}`, `Catalog declarations: ${plugins.length}; unsupported=${preview.catalog.unsupportedEntries}; omitted=${preview.catalog.omittedEntries}`, ...completeLines(plugins), `Dependencies/dependents: ${preview.dependents.length} installed dependents`, ...completeLines(preview.dependents), `Settings/declaration: ${safe(preview.settingsEffect.setting)}; effective=${preview.settingsEffect.effective}; declaration-only=${preview.settingsEffect.declarationOnly}`, `Destructive choice: preserve-installations=${preview.acknowledgement === "preserve-installations"}`, `Participants: ${preview.participants.length}`, ...preview.participants.map((item) => `- ${item.order}:${item.role}:${item.effect}`), "Expected state changes:", ...completeLines(preview.consequences)].join("\n");
}
function renderPluginPreview(preview: PluginMutationPreview, operation: Extract<PluginInventoryOperation, { kind: "install" | "enable" | "disable" | "update" | "uninstall" }>): string {
  const dependencyReasons = preview.dependencies.selected.reasons; const marketplaceSelection = operation.kind === "install" || operation.kind === "update" ? operation.flags.marketplaceSelector ?? "unambiguous current registration" : "not applicable";
  const graph = preview.dependencies.graph.map((item) => { const dependencies = item.dependencies?.map((dependency) => `item ${dependency.itemIndex} ${safe(dependency.name, 2048)}${dependency.marketplace === undefined ? "" : ` at ${safe(dependency.marketplace, 2048)}`}${dependency.version === undefined ? "" : ` version ${safe(dependency.version, 2048)}`}`).join(", ") ?? "none"; const allowed = item.allowedCrossMarketplaceDependencies?.map((value) => safe(value, 2048)).join(", ") ?? "none"; return `- ${safe(item.pluginId, 2048)}; version=${safe(item.version, 2048)}; enabled=${item.enabled}; ownership=${item.ownership}; available=${item.available ?? "unspecified"}; declaration=${item.dependencyDeclaration ?? "unspecified"}; dependencies=${dependencies}; cross-marketplace-allowlist=${allowed}`; });
  const decisions = (preview.dependencies.decisions ?? []).map((item) => `- ${safe(item.pluginId, 2048)}; admitted=${item.admitted}; reasons=${item.reasons.join(", ") || "none"}`);
  return ["Plugin lifecycle preview", `Operation ID: ${safe(preview.operationId, 128)}`, `Operation/action/target: plugin ${preview.action}; ${safe(preview.pluginId)}`, `Target scope/record selector: ${preview.scope}; ${safe(operation.flags.selector ?? "new record", 1024)}`, `Selected marketplace selector: ${safe(marketplaceSelection, 1024)}`, `Immutable catalog: ${preview.catalog === undefined ? "unchanged" : `${safe(preview.catalog.marketplaceName, 128)}; snapshot=${safe(preview.catalog.snapshotId, 128)}; digest=${digestText(preview.catalog.catalogDigest)}`}`, `Source authority: ${preview.requestedSource === undefined ? "unchanged" : sourceAnchorText(preview.requestedSource)}`, `Source kinds: requested=${preview.requestedSource?.kind ?? "unchanged"}; durable=${preview.source?.kind ?? "unchanged"}`, `Immutable revision: ${safe(preview.immutableRevision ?? "unchanged")}`, `Digests: artifact=${digestText(preview.artifactDigest)}; tree=${digestText(preview.treeDigest)}; root=${digestText(preview.rootDigest)}; executable=${digestText(preview.executableDigest)}`, `Executable content: ${preview.executableComponents.length || "none"}`, ...preview.executableComponents.map((item) => `- ${componentText(item)}`), `Dependencies: admitted=${preview.dependencies.selected.admitted}; blocking=${preview.dependencies.blocking}; reasons=${safe(dependencyReasons.join(", ") || "none")}; graph=${preview.dependencies.graph.length}`, ...completeLines(dependencyReasons), ...graph, ...decisions, `Trust: ${preview.trust === undefined ? "existing authority" : `required for ${safe(preview.trust.target)}; artifact=${digestText(preview.trust.artifactDigest)}; executable=${digestText(preview.trust.executableDigest)}`}`, `Default/enablement: ${preview.enablement === undefined ? "preserved or unchanged" : `enabled=${preview.enablement.enabled}; source=${preview.enablement.source}`}`, `Settings/declaration: ${preview.settingsEffect === undefined ? "unchanged" : `${preview.settingsEffect.setting}; requested=${preview.settingsEffect.requested}; effective=${preview.settingsEffect.effective}; declaration-only=${preview.settingsEffect.declarationOnly}`}`, `Destructive choices: remove-declaration=${preview.removeDeclaration}; remove-data=${preview.removeData}`, `Participants: ${preview.participants.length}`, ...preview.participants.map((item) => `- ${item.kind}:${item.effect}:${item.targetClass}`), "Expected state changes:", ...completeLines(preview.consequences)].join("\n");
}
function recoverySummaryWithinBound(summary: unknown): boolean {
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) return true;
  const value = summary as Record<string, unknown>; const arrays = [value.participants, value.consequences, value.executableComponents]; const dependencies = typeof value.dependencies === "object" && value.dependencies !== null ? value.dependencies as Record<string, unknown> : undefined; const selected = typeof dependencies?.selected === "object" && dependencies.selected !== null ? dependencies.selected as Record<string, unknown> : undefined; arrays.push(dependencies?.graph, dependencies?.decisions, selected?.reasons); const catalog = typeof value.catalog === "object" && value.catalog !== null ? value.catalog as Record<string, unknown> : undefined; arrays.push(catalog?.plugins, value.dependents);
  return catalog?.omittedEntries !== undefined && catalog.omittedEntries !== 0 ? false : arrays.every((item) => !Array.isArray(item) || item.length <= MAX_PREVIEW_VALUES);
}
function recoverySummaryLines(summary: unknown, completed: number): string[] {
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) return ["Producer consequences: validated summary has no recognized display projection."];
  const value = summary as Record<string, unknown>; const registration = typeof value.registration === "object" && value.registration !== null ? value.registration as Record<string, unknown> : undefined;
  const target = typeof value.pluginId === "string" ? value.pluginId : typeof registration?.name === "string" ? registration.name : "unknown"; const scope = typeof value.scope === "string" ? value.scope : typeof registration?.scope === "string" ? registration.scope : "unknown";
  const settings = typeof value.settingsEffect === "object" && value.settingsEffect !== null ? value.settingsEffect as Record<string, unknown> : undefined; const participants = Array.isArray(value.participants) ? value.participants : [];
  const participantText = participants.map((participant, index) => { const item = typeof participant === "object" && participant !== null ? participant as Record<string, unknown> : {}; return `${index < completed ? "completed" : "remaining"}:${safe(item.role ?? item.kind ?? "unknown", 60)}:${safe(item.effect ?? "unknown", 40)}`; }); const consequences = Array.isArray(value.consequences) ? value.consequences.filter((item): item is string => typeof item === "string") : [];
  return [`Producer target/scope/action: ${safe(target, 160)}; ${safe(scope, 80)}; ${safe(value.action ?? "unknown", 80)}`, `Settings/declaration effect: ${settings === undefined ? "unchanged or unavailable" : `requested=${safe(settings.requested ?? settings.setting ?? "unknown", 120)}; effective=${safe(settings.effective ?? "unknown", 40)}; declaration-only=${safe(settings.declarationOnly ?? "unknown", 20)}`}`, `Record/generation/data/destructive effects: record=${safe(value.mutableRecordKey ?? "unchanged", 160)}; generation=${safe(value.generationId ?? "unchanged", 120)}; remove-declaration=${safe(value.removeDeclaration ?? "false", 20)}; remove-data=${safe(value.removeData ?? "false", 20)}; acknowledgement=${safe(value.acknowledgement ?? "none", 80)}`, `Participant effects: total=${participants.length}; ${participantText.join(", ") || "none"}`, `Producer consequences: total=${consequences.length}`, ...completeLines(consequences)];
}
function renderRecoveryPreview(preview: RecoveryPreview, chosen?: "complete" | "rollback"): string { return ["Offline lifecycle recovery preview", `Operation ID: ${safe(preview.operationId, 128)}`, ...recoverySummaryLines(preview.confirmationSummary, preview.completed), `Chosen recovery action/result: ${chosen ?? "not selected"}; feasible=${preview.actions.join(" or ") || `terminal ${preview.terminalOutcome ?? "unknown"}`}`, `Completed safe prefix: ${preview.completed}; rolled back=${preview.rolledBack}; remaining=${preview.remaining}`, `Freshness: producer=${safe(preview.producerSchema)}@${preview.producerVersion}; plan=${digestText(preview.planDigest)}; confirmation=${digestText(preview.confirmationDigest)}`, "Remaining session action: existing sessions remain unchanged; after a committed plugin result use /reload-plugins in the interactive TUI or start a new PiCC session.", "Recovery is offline: it performs no acquisition or trust approval."].join("\n"); }
function receiptText(receipt: MarketplaceReceipt | PluginReceipt | TransactionReceipt): string { const plugin = "pluginId" in receipt || "producerSchema" in receipt && receipt.producerSchema === "plugin-lifecycle"; const target = "pluginId" in receipt ? receipt.pluginId : "confirmationSummary" in receipt ? (receipt.confirmationSummary as { pluginId?: unknown }).pluginId : undefined; const lines = ["Lifecycle receipt", `Operation ID: ${safe(receipt.operationId, 128)}`, `Outcome: ${receipt.outcome}`]; if (receipt.outcome !== "committed") return [...lines, "No durable desired state change was committed. Existing sessions remain unchanged."].join("\n"); return [...lines, ...(plugin ? [`Durable desired plugin state changed${target === undefined ? "" : ` for ${safe(target)}`}. Existing sessions remain unchanged; use /reload-plugins in the interactive TUI or start a new PiCC session.`] : ["Marketplace state changed. No installed plugin code or loaded session changed."])].join("\n"); }
async function defaultConfirm(_preview: string): Promise<boolean> { const readline = createInterface({ input: process.stdin, output: process.stderr }); try { const answer = await readline.question("Type yes to confirm: "); return answer === "yes"; } finally { readline.close(); } }
type Confirmation = "confirmed" | "unavailable" | "cancelled";
async function confirmed(operation: { readonly flags: { readonly yes: boolean } }, preview: string, options: PluginInventoryCliOptions): Promise<Confirmation> {
  if (operation.flags.yes) return "confirmed";
  if (!(options.stdinIsTTY ?? process.stdin.isTTY)) return "unavailable";
  try { return await (options.confirm ?? defaultConfirm)(preview) ? "confirmed" : "cancelled"; } catch { return "unavailable"; }
}
function emitLifecycleFailure(output: PluginInventoryCliOutput, result: { readonly code: string; readonly message: string }, operationId?: string): number {
  try { output.error(resultError(result)); }
  catch { if (operationId !== undefined) { try { output.log(`Operation ID: ${safe(operationId, 128)}. Lifecycle result output failed; run picc plugin recover ${safe(operationId, 128)} to inspect durable evidence if present.`); } catch {} } }
  return 1;
}
async function emitReceipt(output: PluginInventoryCliOutput, receipt: MarketplaceReceipt | PluginReceipt | TransactionReceipt, mode?: "inspection" | "rollback"): Promise<number> {
  const code = receipt.outcome === "committed" || mode === "inspection" || mode === "rollback" && receipt.outcome === "rolled-back" ? 0 : 1;
  try { output.log(receiptText(receipt)); return code; }
  catch { try { output.error(`Operation ID: ${safe(receipt.operationId, 128)}. Result output failed; run picc plugin recover ${safe(receipt.operationId, 128)}.`); } catch { /* No further safe output channel is available. */ } return code; }
}
function discardStatus(kind: "Marketplace" | "Plugin", confirmation: Confirmation, operationId: string, discarded: StoreResult<void>): string {
  if (!discarded.ok) return `${kind} lifecycle ${confirmation === "cancelled" ? "was cancelled" : "confirmation was unavailable"}, but preview cleanup could not be confirmed. Operation ID: ${safe(operationId, 128)}. Preserve any lifecycle staging and retry deliberately; no execution was attempted.`;
  return confirmation === "cancelled" ? `${kind} lifecycle operation was cancelled by the user. Staging was discarded; no durable desired state change was committed.` : `${kind} lifecycle confirmation is unavailable on noninteractive input. Re-run with --yes after reviewing the preview. Staging was discarded; no durable desired state change was committed.`;
}
async function refuseUnsafePreview(kind: "Marketplace" | "Plugin", operationId: string, discard: (operationId: string) => Promise<StoreResult<void>>, output: PluginInventoryCliOutput): Promise<number> {
  const discarded = await discard(operationId); const status = discarded.ok ? "Staging was discarded; no mutation was attempted." : "Staging cleanup could not be confirmed; preserve it. No execution was attempted.";
  try { output.error(`${kind} lifecycle preview exceeds the CLI confirmation safety bound or contains omitted catalog declarations. Operation ID: ${safe(operationId, 128)}. ${status}`); } catch {}
  return 1;
}

async function runLifecycle(operation: Exclude<PluginInventoryOperation, { kind: "list" | "details" }>, services: PluginLifecycleCliServices, output: PluginInventoryCliOutput, options: PluginInventoryCliOptions): Promise<number> {
  if (operation.kind === "marketplace-list") { const status = services.marketplaces.listStatus(); for (const row of status.rows.slice(0, MAX_ROWS)) output.log(renderMarketplaceRow(row)); if (status.omitted > 0) output.log(`… ${status.omitted} marketplace rows not shown; rerun details with an exact name.`); if (status.rows.length === 0) output.log("No marketplaces are registered."); return status.uncertain ? 1 : 0; }
  if (operation.kind === "marketplace-details") { const result = services.marketplaces.details(operation.name, operation.selector); if (!result.ok) { output.error(resultError(result)); return 1; } output.log(renderMarketplaceRow(result.value)); return 0; }
  if (operation.kind === "recover-list") { const all = services.recovery.list(); const rows = all.slice(0, MAX_ROWS); for (const row of rows) output.log(`Operation ID: ${safe(row.operationId, 128)}; status=${safe(row.status, 80)}`); const omitted = all.length - rows.length; if (all.length > 0) output.log(`Pending lifecycle operations: total=${all.length}; omitted=${omitted}. Run picc plugin recover <exact-operation-id> to inspect one exact operation.`); if (rows.length === 0) output.log("No pending lifecycle operations were found. This read-only listing made no changes."); return 0; }
  if (operation.kind === "recover") {
    const preview = await services.recovery.preview(operation.operationId); if (!preview.ok) { output.error(resultError(preview)); return 1; }
    const action = operation.flags.recoveryAction; if (!recoverySummaryWithinBound(preview.value.confirmationSummary)) { output.error(`Recovery preview exceeds the CLI confirmation safety bound or contains omitted catalog declarations. Operation ID: ${safe(operation.operationId, 128)}. Pending state is unchanged and no recovery mutation was attempted.`); return 1; } const text = renderRecoveryPreview(preview.value, action);
    try { output.log(text); } catch { try { output.error(`Operation ID: ${safe(operation.operationId, 128)}. Recovery preview output failed; pending state is unchanged and no recovery mutation was attempted.`); } catch { try { output.log(`Operation ID: ${safe(operation.operationId, 128)}. Recovery preview output failed; no recovery mutation was attempted.`); } catch {} } return 1; }
    if (preview.value.terminalOutcome !== undefined) { const receipt = await services.recovery.recover(operation.operationId, action ?? "complete"); return receipt.ok ? emitReceipt(output, receipt.value, "inspection") : (output.error(resultError(receipt)), 1); }
    if (action === undefined || !preview.value.actions.includes(action)) { output.error("Choose exactly one feasible recovery result with --complete or --rollback. Pending safe partial progress may exist; no recovery mutation was attempted."); return 2; }
    const confirmation = await confirmed(operation, text, options); if (confirmation !== "confirmed") { output.error(confirmation === "cancelled" ? "Lifecycle recovery was cancelled by the user. Pending safe partial progress remains; no recovery mutation was attempted." : "Lifecycle recovery confirmation is unavailable on noninteractive input. Re-run with --yes after reviewing the preview; pending safe partial progress remains."); return 2; }
    const result = await services.recovery.recover(operation.operationId, action); return result.ok ? emitReceipt(output, result.value, action === "rollback" ? "rollback" : undefined) : (output.error(resultError(result)), 1);
  }
  if (operation.kind.startsWith("marketplace-")) {
    const marketplaceOperation = operation as Extract<PluginInventoryOperation, { kind: "marketplace-add" | "marketplace-refresh" | "marketplace-remove" }>;
    const planned = await services.marketplaces.plan(marketplaceOperation); if (!planned.ok) { output.error(resultError(planned)); return 1; }
    if (!previewArraysWithinBound(planned.value)) return refuseUnsafePreview("Marketplace", planned.value.operationId, (id) => services.marketplaces.discardPreview(id), output);
    const text = renderMarketplacePreview(planned.value);
    try { output.log(text); } catch { const discarded = await services.marketplaces.discardPreview(planned.value.operationId); try { output.error(discarded.ok ? `Preview output failed before execution. Operation ID: ${safe(planned.value.operationId, 128)}. Staging was discarded; no durable desired state change was committed.` : `Preview output failed and staging cleanup is uncertain. Operation ID: ${safe(planned.value.operationId, 128)}. Preserve any lifecycle staging; no execution was attempted.`); } catch {} return 1; }
    const confirmation = await confirmed(operation, text, options); if (confirmation !== "confirmed") { const discarded = await services.marketplaces.discardPreview(planned.value.operationId); output.error(discardStatus("Marketplace", confirmation, planned.value.operationId, discarded)); return 2; }
    const prepared = services.marketplaces.prepare(planned.value); if (!prepared.ok) { const discarded = await services.marketplaces.discardPreview(planned.value.operationId); output.error(discarded.ok ? resultError(prepared) : `Marketplace preparation failed and staging cleanup is uncertain. Operation ID: ${safe(planned.value.operationId, 128)}. Preserve any lifecycle staging; no execution was attempted.`); return 1; }
    const result = await prepared.value.execute(planned.value.confirmationDigest);
    if (!result.ok) { if ("receipt" in result && result.receipt !== undefined) return emitReceipt(output, result.receipt); return emitLifecycleFailure(output, result, planned.value.operationId); } return emitReceipt(output, result.value);
  }
  const pluginOperation = operation as Extract<PluginInventoryOperation, { kind: "install" | "enable" | "disable" | "update" | "uninstall" }>;
  const planned = await services.plugins.plan(pluginOperation); if (!planned.ok) { output.error(resultError(planned)); return 1; }
  if (!previewArraysWithinBound(planned.value)) return refuseUnsafePreview("Plugin", planned.value.operationId, (id) => services.plugins.discardPreview(id), output);
  const text = renderPluginPreview(planned.value, pluginOperation);
  try { output.log(text); } catch { const discarded = await services.plugins.discardPreview(planned.value.operationId); try { output.error(discarded.ok ? `Preview output failed before execution. Operation ID: ${safe(planned.value.operationId, 128)}. Staging was discarded; no durable desired state change was committed.` : `Preview output failed and staging cleanup is uncertain. Operation ID: ${safe(planned.value.operationId, 128)}. Preserve any lifecycle staging; no execution was attempted.`); } catch {} return 1; }
  const confirmation = await confirmed(operation, text, options); if (confirmation !== "confirmed") { const discarded = await services.plugins.discardPreview(planned.value.operationId); output.error(discardStatus("Plugin", confirmation, planned.value.operationId, discarded)); return 2; }
  const result = await services.plugins.execute(planned.value, planned.value.confirmationDigest); if (!result.ok) { if ("receipt" in result && result.receipt !== undefined) return emitReceipt(output, result.receipt); return emitLifecycleFailure(output, result, planned.value.operationId); } return emitReceipt(output, result.value);
}

function lifecycleSource(value: LoadedProject["pluginInventory"]["marketplaces"][number]["source"]): MarketplaceRegistrationSource | undefined {
  const kind = value["kind"];
  if (kind === "directory" && typeof value["localPath"] === "string") return { kind: "local-directory", path: value["localPath"] };
  if (kind === "file" && typeof value["localPath"] === "string") return { kind: "local-catalog-file", path: value["localPath"] };
  if (kind === "github" && typeof value["repo"] === "string") return { kind: "github", repository: value["repo"], ...(typeof value["ref"] === "string" ? { ref: value["ref"] } : {}) };
  if (kind === "git" && typeof value["url"] === "string") return { kind: "https-git", url: value["url"], ...(typeof value["ref"] === "string" ? { ref: value["ref"] } : {}) };
  if (kind === "url" && typeof value["url"] === "string") return { kind: "https-catalog", url: value["url"] };
  return undefined;
}
async function createPluginLifecyclePort(project: LoadedProject, options: PluginInventoryCliOptions, freshCommandAuthority?: LoadedProject): Promise<StoreResult<PluginLifecyclePort>> {
  const home = path.resolve(options.homeDir ?? os.homedir()); const identities = projectIdentities(project.root); const active = identities.at(-1); const family = identities[0];
  if (active === undefined || family === undefined) return { ok: false, code: "wrong-checkout", message: "Lifecycle commands require one canonical active checkout" };
  const locationResult = createLifecycleLocations({ homeDir: home, profilePath: project.userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: active, checkoutFamilyPath: family } });
  if (!locationResult.ok) return { ok: false, code: locationResult.error.code, message: locationResult.error.message };
  const established = await establishOwnedStateStore(locationResult.value, home); if (!established.ok) return established; const store = established.value;
  const loadAuthority = () => {
    const marketplaceCodec = createOwnedMarketplaceCodec(locationResult.value.profileKey); const snapshotCodec = createOwnedMarketplaceSnapshotCodec({ profileKey: locationResult.value.profileKey, artifactsRoot: store.artifactsRoot });
    const preliminaryRegistry = createProducerCodecRegistry([marketplaceCodec, snapshotCodec]); if (!preliminaryRegistry.ok) throw new Error(preliminaryRegistry.message);
    const preliminary = readOwnedAdmissionRecords(store, preliminaryRegistry.value, undefined); const bySnapshot = new Map<string, MarketplaceSnapshotAuthority[]>();
    for (const snapshot of preliminary.marketplaceSnapshots) { const rows = bySnapshot.get(snapshot.snapshotId) ?? []; if (rows.length < 128) rows.push(snapshot); bySnapshot.set(snapshot.snapshotId, rows); }
    const installationCodec = createOwnedPluginInstallationCodec({ profileKey: locationResult.value.profileKey, artifactsRoot: store.artifactsRoot, marketplaceSnapshots: Object.fromEntries(bySnapshot) }); const generationCodec = createExecutableAdmissionGenerationCodec(locationResult.value.profileKey);
    const generation = observeExecutableGenerationFile(path.join(store.generationsRoot, "current.json"), generationCodec); const registry = createProducerCodecRegistry([marketplaceCodec, snapshotCodec, installationCodec]); if (!registry.ok) throw new Error(registry.message);
    const admission = readOwnedAdmissionRecords(store, registry.value, generation.status === "valid" ? generation.generation : undefined); const snapshots = admission.marketplaceSnapshots;
    const applicableRegistrations = Object.freeze(admission.marketplaces.filter((record) => record.scope === "user" || record.checkoutFamilyKey === locationResult.value.checkoutFamilyKey && record.projectKey === locationResult.value.checkoutFamilyKey));
    return Object.freeze({ admission, snapshots, applicableRegistrations });
  };
  loadAuthority();
  const captureProject = (): LoadedProject => loadClaudeProject({ cwd: project.cwd, ...(options.env === undefined ? {} : { env: options.env }), ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }), managedPolicyPlatform: options.platform ?? process.platform, pluginInventoryLifetime: "command" });
  const mutationAuthority = (): LoadedProject => freshCommandAuthority ?? captureProject();
  const catalogFor = (snapshot: ReturnType<typeof loadAuthority>["snapshots"][number] | undefined) => {
    const retained = snapshot?.executableCatalog; if (retained === undefined) return undefined;
    const plugins = retained.declarations.map((entry) => Object.freeze({ name: entry.pluginId.slice(0, entry.pluginId.lastIndexOf("@")), supported: true as const, sourceKind: entry.source.kind }));
    return Object.freeze({ name: retained.marketplaceName, ownerName: "Marketplace publisher", plugins: Object.freeze(plugins), unsupportedEntries: 0, omittedEntries: 0 });
  };
  const marketplaceObservations = (): readonly MarketplaceObservation[] => {
    const authority = loadAuthority(); const { admission, snapshots, applicableRegistrations } = authority; const current = captureProject(); const currentState = loadPluginMarketplaceState({ userDir: project.userDir, projectRoot: project.root, settings: current.settings, ...(options.env === undefined ? {} : { env: options.env }) });
    return currentState.registrations.flatMap((registration) => {
      const sourceValue = lifecycleSource(registration.source as unknown as LoadedProject["pluginInventory"]["marketplaces"][number]["source"]); if (sourceValue === undefined) return [];
      const ownedMatches = applicableRegistrations.filter((record) => record.name === registration.name && record.scope === registration.provenance.scope && same(record.source, sourceValue));
      if (ownedMatches.length > 1) return [];
      const owned = ownedMatches[0]; const snapshotMatches = owned === undefined ? [] : snapshots.filter((item) => item.profileKey === owned.profileKey && item.snapshotId === owned.selectedSnapshotId && item.marketplaceName === owned.name && same(item.source, owned.source));
      if (snapshotMatches.length > 1) return [];
      const snapshot = snapshotMatches[0]; const catalog = catalogFor(snapshot); const dependents = admission.installations.filter((item) => item.record.source.marketplaceName === registration.name).map((item) => item.record.pluginId);
      const owner = owned !== undefined ? "picc-owned" as const : registration.provenance.scope === "managed" ? "managed" as const : registration.provenance.origin === "seed" ? "seed" as const : "claude-imported" as const;
      return [Object.freeze({ name: registration.name, owner, source: owned?.source ?? sourceValue, selected: registration.selected, effective: registration.selected, trusted: owned !== undefined, ...(owned === undefined ? {} : { registration: owned }), ...(snapshot === undefined ? {} : { snapshot }), ...(catalog === undefined ? {} : { catalog }), plugins: catalog?.plugins ?? Object.freeze([]), dependents: Object.freeze(dependents), errors: Object.freeze([]), provenance: Object.freeze([]) })];
    });
  };
  const settingsPlan = (scope: MutablePluginScope, mutation: Parameters<typeof planPluginSettingsWrite>[0]["mutation"], declarationOnly: boolean) => planPluginSettingsWrite({ homeDir: home, profilePath: project.userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: active, checkoutFamilyPath: family }, projectRoot: project.root, cwd: project.cwd, scope, mutation, declarationOnly });
  const sourceAnchor = marketplaceSourceAnchor(project.root);
  const marketplaceService = new PluginMarketplaceService({ store, profilePath: project.userDir, ...(sourceAnchor.ok ? { marketplaceSourceAnchor: sourceAnchor.value } : {}), checkoutFamilyKey: locationResult.value.checkoutFamilyKey, observe: marketplaceObservations, acquire: createMarketplaceAcquisitionAdapter({ store }), planSettings: ({ action, name, scope, value, declarationOnly }) => settingsPlan(scope, { kind: "known-marketplace", key: name, ...(action === "remove" ? {} : { value }) }, declarationOnly) });
  const pluginSnapshot = (): PluginLocalSnapshot => {
    const authority = loadAuthority(); const { snapshots, applicableRegistrations: registrations } = authority; const current = captureProject(); const effective = current.settings.effectivePluginEnablement ?? {};
    const derived = deriveOwnedPluginCatalogSelections(registrations, snapshots); const selections = derived.ok ? derived.value : Object.freeze([] as PluginCatalogSelection[]);
    const rows = current.pluginAdmissions.map((projection) => { const pluginId = projection.ownership === "picc-owned" ? projection.pluginId : projection.installation.pluginId; const item = current.pluginInventory.find(pluginId); const explicit = effective[pluginId]; const selected = current.plugins.find((plugin) => plugin.pluginId === pluginId); return projection.ownership === "picc-owned" ? Object.freeze({ pluginId: pluginId as QualifiedPluginIdentity, owner: "picc-owned" as const, scope: projection.scope, version: projection.version, enabled: item?.lifecycle?.effectiveEnabled ?? false, ...(explicit === undefined ? {} : { explicitEnabled: explicit.enabled }), sourceKind: projection.authority.record.source.kind, trusted: true, dependencies: projection.authority.record.dependencies, dependencyDeclaration: projection.authority.record.dependencyDeclaration, authority: projection.authority }) : Object.freeze({ pluginId: pluginId as QualifiedPluginIdentity, owner: projection.installation.scope === "managed" ? "managed" as const : "claude-imported-readonly" as const, scope: projection.installation.scope, version: projection.installation.version, enabled: item?.enablement?.enabled ?? false, ...(explicit === undefined ? {} : { explicitEnabled: explicit.enabled }), trusted: false, dependencies: selected?.manifestProjection.dependencies ?? [], dependencyDeclaration: selected?.manifestProjection.dependencyDeclaration ?? "absent" as const }); });
    return Object.freeze({ rows: Object.freeze(rows), catalogSelections: selections, effectiveEnablement: Object.freeze(Object.fromEntries(Object.entries(effective).map(([key, value]) => [key, value.enabled]))), ...(current.ownedProfileReference === undefined ? {} : { completeReference: current.ownedProfileReference }), marketplaceRegistrations: Object.freeze(registrations), marketplaceSnapshots: Object.freeze(snapshots) });
  };
  const acquire = createPluginAcquisitionAdapter({ store, snapshots: () => loadAuthority().snapshots }); const preparedPluginServices = new Map<string, PluginLifecycleService>();
  const pluginService = (initial?: PluginLocalSnapshot) => { let first = initial; return new PluginLifecycleService({ store, profilePath: project.userDir, checkoutFamilyKey: locationResult.value.checkoutFamilyKey, observe: () => { if (first !== undefined) { const captured = first; first = undefined; return captured; } return pluginSnapshot(); }, acquire, inspect: inspectAcquiredPlugin, planSettings: ({ pluginId, scope, value, declarationOnly }) => settingsPlan(scope, { kind: "enabled-plugin", key: pluginId, ...(value === undefined ? {} : { value }) }, declarationOnly) }); };
  const recovery = () => new LifecycleRecoveryService({ store, snapshots: loadAuthority().snapshots });
  const selectedMarketplace = (name: string, selector: string): StoreResult<ReturnType<typeof loadAuthority>["applicableRegistrations"][number]> => {
    const key = decodeMarketplaceSelector(selector); if (key === undefined) return { ok: false, code: "invalid-selector", message: "Marketplace selector is malformed or noncanonical" };
    const matches = loadAuthority().applicableRegistrations.filter((record) => record.name === name && ownedMarketplaceScopeKey(record) === key);
    return matches.length === 1 ? { ok: true, value: matches[0]! } : { ok: false, code: "invalid-selector", message: "Marketplace selector is unknown or identifies another record; rerun marketplace details and copy one exact selector" };
  };
  const services: PluginLifecycleCliServices = {
    marketplaces: {
      listStatus: () => marketplaceService.listStatus(),
      details: (name, selector) => {
        if (selector === undefined) return marketplaceService.details(name);
        const selected = selectedMarketplace(name, selector); return selected.ok ? marketplaceService.details(name, selected.value) : selected;
      },
      plan: async (operation, signal) => {
        if (signal?.aborted) return { ok: false, code: "cancelled", message: "Marketplace planning was cancelled" };
        const current = mutationAuthority(); const foreign = operation.kind === "marketplace-add" || operation.flags.selector === undefined ? foreignMarketplaceTarget(current, operation.name) : undefined;
        if (foreign !== undefined) return { ok: false, code: foreign === "managed" ? "managed-readonly" : foreign === "seed" ? "seed-readonly" : "imported-readonly", message: ownershipRefusal("marketplace", foreign) };
        const uncertainty = marketplaceAuthorityUncertain(current, options); if (uncertainty.uncertain) return { ok: false, code: "marketplace-ownership-uncertain", message: uncertainMarketplaceAuthorityRefusal(uncertainty.settingsAuthorityFailure) };
        if (operation.kind === "marketplace-add") return marketplaceService.add(operation.name, source(operation), { scope: operation.flags.scope, declarationOnly: operation.flags.declarationOnly, ...(signal === undefined ? {} : { signal }) });
        const selected = operation.flags.selector === undefined ? undefined : selectedMarketplace(operation.name, operation.flags.selector);
        if (selected !== undefined && !selected.ok) return selected;
        return operation.kind === "marketplace-refresh"
          ? marketplaceService.refresh(operation.name, { ...(selected === undefined ? {} : { registration: selected.value }), declarationOnly: operation.flags.declarationOnly, ...(signal === undefined ? {} : { signal }) })
          : marketplaceService.remove(operation.name, { ...(selected === undefined ? {} : { registration: selected.value }), declarationOnly: operation.flags.declarationOnly, acknowledgePreservedDependents: operation.flags.preserveInstalled, ...(signal === undefined ? {} : { signal }) });
      },
      prepare: (preview) => marketplaceService.prepare(preview), discardPreview: (id) => marketplaceService.discardPreview(id),
    },
    plugins: {
      list: () => pluginService().list(), details: (identity) => pluginService().details(identity),
      plan: async (operation, signal) => {
        if (signal?.aborted) return { ok: false, code: "cancelled", message: "Plugin planning was cancelled" };
        const current = mutationAuthority(); const selector = operation.flags.selector;
        const exact = selector === undefined ? undefined : exactPluginSelector(current, operation.qualifiedIdentity, selector); const foreign = exact?.ownership === "claude-imported-readonly" ? { managed: exact.installation.scope === "managed" } : selector === undefined ? foreignPluginTarget(current, operation.qualifiedIdentity) : undefined;
        if (foreign !== undefined) return { ok: false, code: foreign.managed ? "managed-readonly" : "imported-readonly", message: ownershipRefusal("plugin", foreign.managed ? "managed" : "claude-imported") };
        if (pluginOwnershipUncertain(current)) return { ok: false, code: "imported-ownership-uncertain", message: uncertainPluginOwnershipRefusal(current) };
        if (operation.kind === "install" || operation.kind === "update") { const uncertainty = marketplaceAuthorityUncertain(current, options); if (uncertainty.uncertain) return { ok: false, code: "marketplace-ownership-uncertain", message: uncertainMarketplaceAuthorityRefusal(uncertainty.settingsAuthorityFailure) }; }
        if (operation.kind === "enable" || operation.kind === "disable" || operation.kind === "uninstall") { const service = pluginService(); const planned = operation.kind === "enable" ? await service.enable(operation.qualifiedIdentity as QualifiedPluginIdentity, { selector, declarationOnly: operation.flags.declarationOnly }) : operation.kind === "disable" ? await service.disable(operation.qualifiedIdentity as QualifiedPluginIdentity, { selector, declarationOnly: operation.flags.declarationOnly }) : await service.uninstall(operation.qualifiedIdentity as QualifiedPluginIdentity, { selector, declarationOnly: operation.flags.declarationOnly, removeDeclaration: operation.flags.removeDeclaration, removeData: operation.flags.removeData }); if (planned.ok) preparedPluginServices.set(planned.value.operationId, service); return planned; }
        const local = pluginSnapshot(); if (operation.kind === "install") { const foreign = local.rows.find((row) => row.pluginId === operation.qualifiedIdentity && row.owner !== "picc-owned"); if (foreign !== undefined) return { ok: false, code: foreign.owner === "managed" ? "managed-readonly" : "imported-readonly", message: foreign.owner === "managed" ? "This plugin is administrator-owned; ask the administrator to change it. No acquisition, trust approval, staging, executable publication, settings mutation, or desired-state mutation was attempted" : "This plugin is Claude-owned; use Claude Code to change or remove it. No acquisition, trust approval, staging, executable publication, settings mutation, or desired-state mutation was attempted" }; }
        const authoritative = deriveOwnedPluginCatalogSelections(local.marketplaceRegistrations ?? [], local.marketplaceSnapshots); if (!authoritative.ok) return authoritative; let candidates = authoritative.value.filter((item) => item.pluginId === operation.qualifiedIdentity);
        const marketplaceSelection = operation.flags.marketplaceSelector; if (marketplaceSelection !== undefined) { const key = decodeMarketplaceSelector(marketplaceSelection); if (key === undefined) return { ok: false, code: "invalid-selector", message: "Marketplace selector is malformed or noncanonical" }; candidates = candidates.filter((item) => item.registration !== undefined && ownedMarketplaceScopeKey(item.registration) === key); }
        if (operation.kind === "update" && selector !== undefined && decodePluginSelector(selector, operation.qualifiedIdentity) === undefined) return { ok: false, code: "invalid-selector", message: "Plugin selector is malformed, noncanonical, or identifies another plugin" };
        if (candidates.length !== 1 || candidates[0]!.registration === undefined) return { ok: false, code: "catalog-selection-required", message: `Select one exact current marketplace registration with --marketplace-selector; run picc plugin marketplace details ${safe(operation.qualifiedIdentity.slice(operation.qualifiedIdentity.lastIndexOf("@") + 1), 128)} and copy its selector. --selector identifies the predecessor installed plugin record, while --marketplace-selector identifies the current registration. Matching selections ${candidates.length}; retained declarations ${authoritative.value.slice(0, 8).map((item) => item.pluginId).join(", ") || "none"}; registrations ${local.marketplaceRegistrations?.length ?? 0}; snapshots ${local.marketplaceSnapshots.length}` };
        const selection = candidates[0]!; const snapshotMatches = local.marketplaceSnapshots.filter((item) => item.profileKey === selection.registration!.profileKey && item.marketplaceName === selection.registration!.name && item.snapshotId === selection.snapshotId && item.catalogDigest === selection.catalogDigest && same(item.source, selection.registration!.source));
        if (snapshotMatches.length !== 1) return { ok: false, code: "catalog-authority-ambiguous", message: "The selected registration no longer resolves to one exact retained snapshot; refresh or inspect the marketplace" };
        const snapshot = snapshotMatches[0]!; const request = { source: selection.source, catalog: { marketplaceName: snapshot.marketplaceName, snapshotId: snapshot.snapshotId, catalogDigest: snapshot.catalogDigest, registration: selection.registration, snapshot, defaultEnabled: selection.defaultEnabled, allowedCrossMarketplaceDependencies: selection.allowedCrossMarketplaceDependencies }, ...(signal === undefined ? {} : { signal }) };
        const service = pluginService(local); const planned = operation.kind === "install" ? await service.install({ pluginId: operation.qualifiedIdentity as QualifiedPluginIdentity, ...request }, { scope: operation.flags.scope, declarationOnly: operation.flags.declarationOnly }) : await service.update(operation.qualifiedIdentity as QualifiedPluginIdentity, request, { selector, declarationOnly: operation.flags.declarationOnly }); if (planned.ok) preparedPluginServices.set(planned.value.operationId, service); return planned;
      },
      execute: async (preview, digest) => { const service = preparedPluginServices.get(preview.operationId); if (service === undefined) return { ok: false as const, code: "preview-not-found", message: "Plugin preview is unavailable in this command composition" }; const result = await service.execute(preview, digest); if (result.ok || !result.ok && "receipt" in result && result.receipt !== undefined) preparedPluginServices.delete(preview.operationId); return result; },
      discardPreview: async (id) => { const service = preparedPluginServices.get(id); if (service === undefined) return { ok: false as const, code: "preview-not-found", message: "Plugin preview is unavailable in this command composition" }; const result = await service.discardPreview(id); if (result.ok) preparedPluginServices.delete(id); return result; },
    },
    recovery: {
      list: () => observePersistedTransactionsSync(store).journals.filter((item) => item.status === "pending").map((item) => ({ operationId: item.operationId, status: item.status })),
      preview: (id) => recovery().preview(id),
      recover: async (id, action) => {
        const observed = observePersistedTransactionsSync(store); const journal = observed.journals.find((item) => item.operationId === id); const receipt = observed.receipts.find((item) => item.receipt?.operationId === id); const producer = receipt?.receipt?.producerSchema ?? journal?.journal?.producerSchema;
        let result: StoreResult<PluginLifecycleReceipt>;
        if (producer === "plugin-lifecycle") result = await (preparedPluginServices.get(id) ?? pluginService()).recover(id, action);
        else if (producer === "marketplace-lifecycle") result = await marketplaceService.recover(id, action);
        else result = await recovery().recover(id, action);
        if (result.ok) preparedPluginServices.delete(id); return result;
      },
    },
    targets: {
      plugin: (identity, mutableRecordKey) => {
        const matches = pluginService().list().filter((row) => row.pluginId === identity).flatMap((row) => {
          const decoded = decodePluginStableSelector(row.selector); if (decoded === undefined || decoded.scope === "managed") return [];
          return pluginMutableRecordKey({ pluginId: decoded.pluginId, scope: decoded.scope, profileKey: (decoded.profileKey ?? store.profileKey) as `profile-${string}`, ...(decoded.projectKey === undefined ? {} : { projectKey: decoded.projectKey }) }) === mutableRecordKey ? [row] : [];
        });
        return matches.length === 1 ? { ok: true, value: Object.freeze({ kind: "plugin", identity, scope: matches[0]!.scope, mutableRecordKey, selector: matches[0]!.selector }) } : { ok: false, code: "stale-selector", message: "The exact plugin record is stale or ambiguous; refresh the inventory and select it again" };
      },
      marketplace: (name, mutableRecordKey) => {
        const selected = loadAuthority().applicableRegistrations.filter((record) => record.name === name && ownedMarketplaceScopeKey(record) === mutableRecordKey);
        return selected.length === 1 ? { ok: true, value: Object.freeze({ kind: "marketplace", identity: name, scope: selected[0]!.scope, mutableRecordKey, selector: marketplaceSelector(mutableRecordKey) }) } : { ok: false, code: "stale-selector", message: "The exact marketplace registration is stale or ambiguous; refresh the inventory and select it again" };
      },
    },
    lookup: async (operationId) => {
      const observed = observePersistedTransactionsSync(store);
      const journal = observed.journals.find((item) => item.operationId === operationId);
      const receipt = observed.receipts.find((item) => item.receipt?.operationId === operationId || item.status === "invalid" && path.basename(item.path) === `${operationId}.json`);
      if (journal?.status === "invalid" || receipt?.status === "invalid") return { ok: false, code: "invalid-operation-evidence", message: "Persisted operation evidence is malformed; no producer was inferred" };
      const producerSchema = receipt?.receipt?.producerSchema ?? journal?.journal?.producerSchema;
      if (producerSchema === undefined) return { ok: true, value: undefined };
      if (producerSchema === "plugin-lifecycle") { const result = await (preparedPluginServices.get(operationId) ?? pluginService()).lookupOperation(operationId) as StoreResult<PluginOperationLookup | undefined>; if (result.ok && result.value?.state === "terminal") preparedPluginServices.delete(operationId); return result; }
      if (producerSchema === "marketplace-lifecycle") {
        const terminal = await marketplaceService.receipt(operationId);
        if (!terminal.ok) return terminal;
        if (terminal.value !== undefined) return { ok: true, value: { state: "terminal", receipt: terminal.value } };
        const pending = await marketplaceService.recoveryStatus(operationId);
        if (!pending.ok) return pending.code === "not-found" ? { ok: true, value: undefined } : pending;
        return { ok: true, value: { state: "pending", operationId, completed: pending.value.completed, total: pending.value.completed + pending.value.remaining, recoveryActions: pending.value.actions } };
      }
      const preview = await recovery().preview(operationId); if (!preview.ok) return preview;
      if (preview.value.terminalOutcome !== undefined) {
        const found = receipt?.receipt; return found === undefined ? { ok: false, code: "invalid-receipt", message: "Terminal operation evidence has no validated receipt" } : { ok: true, value: { state: "terminal", receipt: found } };
      }
      return { ok: true, value: { state: "pending", operationId, completed: preview.value.completed, total: preview.value.completed + preview.value.remaining, recoveryActions: preview.value.actions } };
    },
    projection: () => {
      try { return { ok: true, value: captureProject().pluginInventory }; }
      catch { return { ok: false, code: "projection-failed", message: "Fresh durable plugin projection could not be captured" }; }
    },
  };
  return { ok: true, value: services };
}

export function createProductionPluginLifecyclePort(project: LoadedProject, options: PluginInventoryCliOptions = {}): Promise<StoreResult<PluginLifecyclePort>> { return createPluginLifecyclePort(project, options); }

function exactPluginSelector(project: LoadedProject, pluginId: string, selector: string): ProjectPluginAdmission | undefined {
  const matches = projectSelectorCandidates(project, pluginId).filter((candidate) => candidate.selector === selector);
  return matches.length === 1 ? matches[0]!.projection : undefined;
}
function foreignPluginTarget(project: LoadedProject, pluginId: string): { readonly managed: boolean } | undefined {
  const foreign = project.pluginAdmissions.filter((projection) => projection.ownership === "claude-imported-readonly" && projection.installation.pluginId === pluginId);
  const managed = foreign.find((projection) => projection.ownership === "claude-imported-readonly" && projection.installation.scope === "managed");
  return managed !== undefined ? { managed: true } : foreign.length > 0 ? { managed: false } : undefined;
}
type ForeignOwnership = "managed" | "claude-imported" | "seed" | "unknown";
function foreignMarketplaceTarget(project: LoadedProject, name: string): ForeignOwnership | undefined {
  const foreign = project.pluginInventory.marketplaces.filter((row) => row.name === name && row.ownership !== "picc-owned");
  if (foreign.some((row) => row.scope === "managed" || row.ownership === "managed")) return "managed";
  if (foreign.some((row) => row.ownership === "seed" || row.origin === "seed")) return "seed";
  if (foreign.some((row) => row.ownership === "claude-imported-readonly")) return "claude-imported";
  return foreign.length > 0 ? "unknown" : undefined;
}
function ownershipRefusal(kind: "plugin" | "marketplace", ownership: "managed" | "claude-imported" | "seed" | "unknown"): string {
  const subject = kind === "plugin" ? "This plugin" : "A same-name marketplace"; const unchanged = "No acquisition, trust approval, staging, executable publication, settings mutation, or desired-state mutation was attempted.";
  if (ownership === "managed") return `PiCC plugin lifecycle refused (managed-readonly): ${subject} is administrator-owned; ask the administrator to change it. ${unchanged}`;
  if (ownership === "seed") return `PiCC plugin lifecycle refused (seed-readonly): ${subject} is configured from a read-only seed; manage it at its configured source. ${unchanged}`;
  if (ownership === "unknown") return `PiCC plugin lifecycle refused (ownership-unknown): ${subject} ownership could not be attributed; repair or inspect marketplace state before changing it. ${unchanged}`;
  return `PiCC plugin lifecycle refused (imported-readonly): ${subject} is Claude-owned; use Claude Code to change or remove it. ${unchanged}`;
}
function hasOmission(project: LoadedProject, prefix: "loader.installed."): boolean { return Object.entries(project.pluginInventory.omissions).some(([key, count]) => key.startsWith(prefix) && count > 0); }
function pluginOwnershipUncertain(project: LoadedProject): boolean { return !["absent", "valid"].includes(project.pluginInventory.installedStateStatus) || hasOmission(project, "loader.installed."); }
const MARKETPLACE_AUTHORITY_DIAGNOSTICS = new Set([
  "Known marketplace registration file is malformed or exceeds a safe bound",
  "Known marketplace registration contains an invalid documented name",
  "Known marketplace registration entry has a malformed nested source descriptor",
  "Plugin seed directory is invalid or unreadable; ignored",
  "Additional plugin seed directories omitted after the safe limit",
  "extraKnownMarketplaces contains an invalid name or nested source descriptor",
]);
function marketplaceAuthorityUncertain(project: LoadedProject, options: PluginInventoryCliOptions): { readonly uncertain: boolean; readonly settingsAuthorityFailure: boolean } {
  const settingsAuthorityFailure = (project.settings.retentionCleanupBlockers ?? []).some((blocker) => blocker.reason === "unreadable-source" || blocker.reason === "malformed-source" || blocker.reason === "non-object-source");
  const settingsOmissions = project.settings.pluginMarketplaceSettingsOmissions;
  const state = loadPluginMarketplaceState({ userDir: project.userDir, projectRoot: project.root, settings: project.settings, env: options.env });
  const uncertain = settingsAuthorityFailure
    || (settingsOmissions?.contributions ?? 0) > 0
    || (settingsOmissions?.declarations ?? 0) > 0
    || state.omissions.registrations > 0
    || state.omissions.selectedRegistrations > 0
    || state.diagnostics.some((diagnostic) => MARKETPLACE_AUTHORITY_DIAGNOSTICS.has(diagnostic.message));
  return { uncertain, settingsAuthorityFailure };
}
function uncertainPluginOwnershipRefusal(project: LoadedProject): string {
  const unchanged = "No acquisition, trust approval, staging, executable publication, settings mutation, or desired-state mutation was attempted.";
  if (project.pluginInventory.installedStateStatus === "unsupported") return `PiCC plugin lifecycle refused (imported-ownership-uncertain): The installed-plugin-state format is unsupported; update PiCC or report the unsupported installed-plugin-state format. Use passive picc plugin list or interactive /doctor to inspect it. ${unchanged}`;
  if (project.pluginInventory.installedStateStatus === "unreadable") return `PiCC plugin lifecycle refused (imported-ownership-uncertain): Installed plugin ownership is unreadable; check permissions and access, then use passive picc plugin list or interactive /doctor. ${unchanged}`;
  if (project.pluginInventory.installedStateStatus === "malformed") return `PiCC plugin lifecycle refused (imported-ownership-uncertain): Installed plugin ownership is malformed; repair the malformed state outside PiCC, then use passive picc plugin list or interactive /doctor. ${unchanged}`;
  return `PiCC plugin lifecycle refused (imported-ownership-uncertain): Exact installed-plugin ownership evidence was omitted by safe bounds; use passive picc plugin list or interactive /doctor to inspect it, then reduce or repair the source. ${unchanged}`;
}
function uncertainMarketplaceAuthorityRefusal(settingsAuthorityFailure: boolean): string {
  const settings = settingsAuthorityFailure ? " Unreadable or malformed settings authority may hide marketplace declarations." : "";
  return `PiCC plugin lifecycle refused (marketplace-ownership-uncertain): Marketplace registration or catalog-selection evidence is incomplete.${settings} Inspect it passively with picc plugin marketplace list/details or interactive /doctor before changing it. No acquisition, trust approval, staging, executable publication, settings mutation, or desired-state mutation was attempted.`;
}

export async function runPluginInventoryCli(argv: readonly string[], output: PluginInventoryCliOutput = console, options: PluginInventoryCliOptions = {}): Promise<number> {
  const parsed = parsePluginInventoryArgv(argv); if (parsed.kind === "usage") { (argv.length === 1 && argv[0] === "--help" ? output.log : output.error)(parsed.usage); return argv.length === 1 && argv[0] === "--help" ? 0 : 2; }
  const inputs = resolveCommandInputs(options); if ("error" in inputs) { output.error(inputs.error); return 1; }
  const platform = options.platform ?? process.platform; let project: LoadedProject;
  try { project = loadClaudeProject({ cwd: inputs.cwd, ...(options.env === undefined ? {} : { env: options.env }), ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }), managedPolicyPlatform: platform, pluginInventoryLifetime: "command" }); }
  catch { output.error(readableProfile(inputs.profile.userDir) ? PROJECT_UNAVAILABLE : unreadableProfileMessage(inputs.profile)); return 1; }
  const operation = parsed.operation;
  const marketplaceSelection = operation.kind === "marketplace-details" ? operation.selector : operation.kind === "marketplace-refresh" || operation.kind === "marketplace-remove" ? operation.flags.selector : operation.kind === "install" || operation.kind === "update" ? operation.flags.marketplaceSelector : undefined;
  const marketplaceKey = marketplaceSelection === undefined ? undefined : decodeMarketplaceSelector(marketplaceSelection);
  if (marketplaceSelection !== undefined && marketplaceKey === undefined) { output.error("PiCC plugin lifecycle refused (invalid-selector): Marketplace selector is malformed, noncanonical, or identifies another record. Rerun marketplace details and copy one exact selector. No mutation was attempted."); return 2; }
  const pluginSelection = operation.kind === "enable" || operation.kind === "disable" || operation.kind === "update" || operation.kind === "uninstall" ? operation.flags.selector : undefined;
  if (pluginSelection !== undefined && decodePluginSelector(pluginSelection, operation.kind === "enable" || operation.kind === "disable" || operation.kind === "update" || operation.kind === "uninstall" ? operation.qualifiedIdentity : undefined) === undefined) { output.error("PiCC plugin lifecycle refused (invalid-selector): Plugin selector is malformed, noncanonical, or identifies another plugin. Rerun plugin details and copy one exact selector. No mutation was attempted."); return 2; }

  const marketplaceMutation = operation.kind === "marketplace-add" || operation.kind === "marketplace-refresh" || operation.kind === "marketplace-remove";
  const marketplaceDependentPluginMutation = operation.kind === "install" || operation.kind === "update";
  const pluginMutation = operation.kind === "install" || operation.kind === "enable" || operation.kind === "disable" || operation.kind === "update" || operation.kind === "uninstall";
  const expectedMarketplaceName = operation.kind === "install" || operation.kind === "update" ? operation.qualifiedIdentity.slice(operation.qualifiedIdentity.lastIndexOf("@") + 1) : "name" in operation ? operation.name : "";
  const ownedMarketplaceMatches = marketplaceKey === undefined ? [] : project.ownedMarketplaces.filter((record) => record.name === expectedMarketplaceName && ownedMarketplaceScopeKey(record) === marketplaceKey);
  const exactOwnedMarketplace = ownedMarketplaceMatches.length === 1;
  let exactOwnedPlugin: ProjectPluginAdmission | undefined;
  if (pluginSelection !== undefined) {
    const exactPlugin = exactPluginSelector(project, operation.kind === "enable" || operation.kind === "disable" || operation.kind === "update" || operation.kind === "uninstall" ? operation.qualifiedIdentity : "", pluginSelection);
    if (exactPlugin?.ownership === "claude-imported-readonly") { output.error(ownershipRefusal("plugin", exactPlugin.installation.scope === "managed" ? "managed" : "claude-imported")); return 1; }
    if (exactPlugin?.ownership === "picc-owned") exactOwnedPlugin = exactPlugin;
  }
  if (marketplaceMutation && marketplaceSelection === undefined) { const foreign = foreignMarketplaceTarget(project, operation.name); if (foreign !== undefined) { output.error(ownershipRefusal("marketplace", foreign)); return 1; } }
  if (pluginMutation && pluginSelection === undefined) { const foreign = foreignPluginTarget(project, operation.qualifiedIdentity); if (foreign !== undefined) { output.error(ownershipRefusal("plugin", foreign.managed ? "managed" : "claude-imported")); return 1; } }

  if (pluginMutation && pluginOwnershipUncertain(project)) { output.error(uncertainPluginOwnershipRefusal(project)); return 1; }
  if (marketplaceMutation || marketplaceDependentPluginMutation) {
    const authority = marketplaceAuthorityUncertain(project, options);
    if (authority.uncertain) { output.error(uncertainMarketplaceAuthorityRefusal(authority.settingsAuthorityFailure)); return 1; }
  }
  if (marketplaceSelection !== undefined && ownedMarketplaceMatches.length !== 1) { output.error("PiCC plugin lifecycle refused (invalid-selector): Marketplace selector is unknown or identifies another record. Rerun marketplace details and copy one exact selector. No mutation was attempted."); return 2; }
  if (pluginSelection !== undefined && exactOwnedPlugin === undefined) { output.error("PiCC plugin lifecycle refused (invalid-selector): Plugin selector is unknown or identifies another record. Rerun plugin details and copy one exact selector. No mutation was attempted."); return 2; }
  if (operation.kind === "details" && operation.identity !== undefined) {
    const matches = projectSelectorCandidates(project).filter((candidate) => candidate.selector === operation.identity);
    if (matches.length !== 1) { output.error("PiCC plugin lifecycle refused (invalid-selector): Plugin selector is malformed, noncanonical, unknown, or identifies another record. Rerun plugin details and copy one exact selector. No mutation was attempted."); return 2; }
    const selected = matches[0]!; if (project.pluginInventory.find(selected.pluginId) === undefined) { output.error(`PiCC plugin not found: ${safe(selected.pluginId)}. Run picc plugin list to copy a listed qualified identity.`); return 1; }
    output.log(renderPluginInventoryDetails(project.pluginInventory, selected.pluginId)); output.log(selected.row); if (project.pluginInventory.diagnostics.length > 0) output.error(incompleteStateWarning(project.pluginInventory.installedStateStatus, project.pluginInventory.diagnostics)); return 0;
  }
  if (parsed.operation.kind === "list" || parsed.operation.kind === "details" && parsed.operation.qualifiedIdentity !== undefined) {
    if (parsed.operation.kind === "details" && project.pluginInventory.find(parsed.operation.qualifiedIdentity!) === undefined) { output.error(`PiCC plugin not found: ${safe(parsed.operation.qualifiedIdentity)}. Run picc plugin list to copy a listed qualified identity.`); return 1; }
    output.log(renderPluginInventoryOperation(project.pluginInventory, parsed.operation)); const candidates = projectSelectorRows(project, parsed.operation.kind === "details" ? parsed.operation.qualifiedIdentity : undefined); for (const row of candidates.slice(0, MAX_ROWS)) output.log(row); if (candidates.length > MAX_ROWS) output.log(`Scoped plugin candidates: total=${candidates.length}; omitted=${candidates.length - MAX_ROWS}. Run picc plugin details <plugin@marketplace> to inspect one identity and copy its exact selector.`); if (project.pluginInventory.diagnostics.length > 0) output.error(incompleteStateWarning(project.pluginInventory.installedStateStatus, project.pluginInventory.diagnostics)); return 0;
  }
  if (options.services === undefined && parsed.operation.kind === "recover-list") { const observation = project.lifecycleObservation.pending; const all = observation.filter((item) => item.status === "pending"); const uncertain = observation.some((item) => item.status === "invalid"); const rows = all.slice(0, MAX_ROWS); for (const row of rows) output.log(`Operation ID: ${safe(row.operationId, 128)}; status=${row.status}`); const omitted = Math.max(0, all.length - MAX_ROWS); if (uncertain) output.log(`Pending lifecycle operations: exact total unknown; ${all.length} pending operations were observed and additional evidence may have been omitted. Run picc plugin recover <exact-operation-id> to inspect one observed operation.`); else if (all.length > 0) output.log(`Pending lifecycle operations: total=${all.length}; omitted=${omitted}. Run picc plugin recover <exact-operation-id> to inspect one exact operation.`); if (rows.length === 0 && !uncertain) output.log("No pending lifecycle operations were found. This read-only listing made no changes."); return uncertain ? 1 : 0; }
  if (options.services === undefined && (parsed.operation.kind === "marketplace-list" || parsed.operation.kind === "marketplace-details")) { const readOperation = parsed.operation; const all = project.pluginInventory.marketplaces.filter((row) => readOperation.kind === "marketplace-list" || row.name === readOperation.name && (readOperation.selector === undefined || row.mutableRecordKey === decodeMarketplaceSelector(readOperation.selector))); const rows = all.slice(0, MAX_ROWS); for (const row of rows) output.log([`Marketplace: ${safe(row.name, 128)}`, `  owner: ${row.ownership ?? "unknown"}; selected=${row.selected}; trusted=${row.trusted ?? false}`, `  source authority: ${sourceAnchorText(row.source)}`, `  scope: ${safe(row.scope, 80)}; origin=${safe(row.origin, 80)}${row.mutableRecordKey === undefined ? "; read-only" : `; selector=${marketplaceSelector(row.mutableRecordKey)}`}`].join("\n")); const capturedOmitted = readOperation.kind === "marketplace-list" ? project.pluginInventory.omissions["snapshot.marketplaces"] ?? 0 : 0; const omitted = capturedOmitted + all.length - rows.length; if (omitted > 0) output.log(`Marketplace rows: total=${all.length + capturedOmitted}; omitted=${omitted}. Run picc plugin marketplace details <exact-name> with a listed selector.`); const authority = marketplaceAuthorityUncertain(project, options); if (authority.uncertain) { const absent = rows.length === 0 && readOperation.kind === "marketplace-details" ? " The requested marketplace was not observed, but that result is inconclusive while evidence is incomplete." : ""; output.error(`${uncertainMarketplaceAuthorityRefusal(authority.settingsAuthorityFailure)}${absent}`); return 1; } if (rows.length === 0) { if (parsed.operation.kind === "marketplace-details") { output.error("PiCC marketplace not found. No changes were made."); return 1; } output.log("No marketplaces are registered."); } return 0; }
  const services = await (options.services?.(project) ?? createPluginLifecyclePort(project, options, project)); if (!services.ok) { output.error(resultError(services)); return 1; }
  if (parsed.operation.kind === "details") { const result = services.value.plugins.details(parsed.operation.identity ?? parsed.operation.qualifiedIdentity ?? ""); if (!result.ok) { output.error(resultError(result)); return 1; } output.log(renderPluginRow(result.value)); return 0; }
  return runLifecycle(parsed.operation, services.value, output, options);
}

export const marketplaceSourceForCommand = source;
export { PLUGIN_INVENTORY_ARGV_USAGE };

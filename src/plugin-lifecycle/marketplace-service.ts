import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type { PluginMarketplaceRegistrationSource } from "../types.js";
import { projectIdentities } from "../util/project-identity.js";
import { isQualifiedPluginId } from "../util/plugin-id.js";
import { deriveExecutableMarketplaceCatalogProjection, isDocumentedMarketplaceName, normalizeMarketplaceCatalogDocument, type MarketplaceCatalogDeclarationSummary } from "../util/plugin-marketplace-descriptor.js";
import {
  createMarketplaceSnapshotTrustGrant,
  createOwnedMarketplaceCodec,
  createOwnedMarketplaceSnapshotCodec,
  ownedMarketplaceScopeKey,
  ownedMarketplaceSnapshotScopeKey,
  type MarketplaceSnapshotTrustTarget,
  type OwnedMarketplaceRecord,
  type OwnedMarketplaceSnapshotRecord,
} from "./admission.js";
import { acquireLocalMarketplaceSnapshot } from "./acquisition/local.js";
import { acquireHttpsCatalogDescriptor, type PublicHttpsFetchOptions } from "./acquisition/http.js";
import { readMarketplaceSnapshotEvidence } from "./acquisition/common.js";
import { acquireResolvedGitSource, isGitAcquisitionEvidence, readGitMarketplaceCatalog, resolveGitMarketplaceSource, type GitAcquisitionOptions } from "./acquisition/git.js";
import { createMarketplaceMutationPreview, createMarketplaceTransactionCodec, type MarketplaceMutationAction, type MarketplaceMutationPreview, type MarketplaceParticipantSummary, type MarketplaceReceipt } from "./planner.js";
import { MarketplaceTransactionService, receiptMatchesPrepared, type LifecyclePreparedMutation, type MarketplaceRecoveryStatus } from "./service.js";
import { canonicalJsonBytes, createRecordEnvelope, isContainedPath, ownedRecordPartition, publishMaterializedArtifact, revalidateOwnedStateStore, sha256, type OwnedStateStore, type StoreResult } from "./state-store.js";
import { createPluginSettingsTransactionCodec, preparePluginSettingsWrite } from "./settings-writer.js";
import type { PluginSettingsWritePlan } from "./settings-plan.js";
import { isOwnedDataRetirementParticipant, observePersistedTransactionsSync, prepareTransaction, readTransactionJournal, readTransactionReceipt, type OrdinaryTransactionParticipant, type PreparedTransaction, type TransactionParticipant } from "./transaction.js";
import { discardMaterializedPluginTree } from "./tree-materializer.js";
import { routeMarketplaceSource } from "./source-matrix.js";
import type { CatalogPluginSource, MarketplaceRegistrationSource, MutablePluginScope, Sha256 } from "./types.js";

export type MarketplaceOwner = "picc-owned" | "claude-imported" | "seed" | "managed";
export interface MarketplaceCatalogPluginSummary { readonly name: string; readonly supported: boolean; readonly sourceKind?: CatalogPluginSource["kind"]; readonly error?: string }
export interface MarketplaceObservation {
  readonly name: string; readonly owner: MarketplaceOwner; readonly source: MarketplaceRegistrationSource;
  readonly selected: boolean; readonly effective: boolean; readonly trusted: boolean;
  readonly registration?: OwnedMarketplaceRecord; readonly snapshot?: OwnedMarketplaceSnapshotRecord;
  readonly catalog?: MarketplaceCatalogDeclarationSummary;
  readonly plugins: readonly MarketplaceCatalogPluginSummary[]; readonly dependents: readonly string[];
  readonly errors: readonly string[]; readonly provenance: readonly string[];
}
export interface MarketplaceObservationView {
  readonly name: string; readonly owner: MarketplaceOwner; readonly source: MarketplaceRegistrationSource | { readonly kind: "unavailable" };
  readonly selected: boolean; readonly effective: boolean; readonly trusted: boolean;
  readonly registration?: OwnedMarketplaceRecord; readonly snapshot?: OwnedMarketplaceSnapshotRecord;
  readonly catalog?: MarketplaceCatalogDeclarationSummary; readonly plugins: readonly MarketplaceCatalogPluginSummary[];
  readonly pluginOmitted: number; readonly dependents: readonly string[]; readonly dependentOmitted: number;
  readonly diagnostics: readonly string[]; readonly diagnosticOmitted: number;
}
export interface MarketplaceObservationList { readonly rows: readonly MarketplaceObservationView[]; readonly omitted: number; readonly uncertain: boolean }
export interface AcquiredMarketplaceSnapshot { readonly target: MarketplaceSnapshotTrustTarget; readonly catalogBytes: Uint8Array }
export interface MarketplaceServiceDependencies {
  readonly store: OwnedStateStore;
  readonly profilePath: string;
  readonly marketplaceSourceAnchor?: string;
  readonly checkoutFamilyKey?: `checkout-${string}`;
  readonly observe: () => readonly MarketplaceObservation[];
  readonly acquire: (name: string, source: MarketplaceRegistrationSource, signal?: AbortSignal) => Promise<StoreResult<AcquiredMarketplaceSnapshot>>;
  readonly planSettings: (inputs: { readonly operationId: string; readonly action: MarketplaceMutationAction; readonly name: string; readonly scope: MutablePluginScope; readonly value?: PluginMarketplaceRegistrationSource; readonly declarationOnly: boolean }) => Promise<StoreResult<PluginSettingsWritePlan>>;
  readonly operationId?: () => string;
  readonly transactionFaults?: import("./transaction.js").TransactionFaultSeam;
  readonly preparationFaults?: { readonly hit: (phase: "after-settings" | "after-snapshot" | "after-registration" | "before-compound-prepare") => void | Promise<void> };
  readonly processOwnershipProbe?: import("./locks.js").ProcessOwnershipProbe;
  readonly beforeTransactionExecution?: () => void | Promise<void>;
}
export interface MarketplaceMutationOptions { readonly scope?: MutablePluginScope; readonly declarationOnly?: boolean; readonly signal?: AbortSignal; readonly registration?: OwnedMarketplaceRecord; readonly acknowledgePreservedDependents?: boolean }
export interface MarketplaceAcquisitionAdapterOptions { readonly store: OwnedStateStore; readonly git?: Omit<GitAcquisitionOptions, "store" | "signal">; readonly https?: Omit<PublicHttpsFetchOptions, "signal"> }

const MAX_ROWS = 256; const MAX_ITEMS = 1024; const MAX_DIAGNOSTICS = 128; const MAX_CATALOG_BYTES = 8 * 1024 * 1024; const MAX_PREPARED = 64;
const LIVE_RESERVATIONS = new Map<string, symbol>();
interface CapturedObservations { readonly rows: readonly MarketplaceObservation[] }
interface PreparedMarketplaceEntry { readonly token: symbol; readonly preview: MarketplaceMutationPreview; readonly transaction: PreparedTransaction; state: "preview" | "bound" | "cancelling" | "running" | "pending" | "terminal" }
function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function same(left: unknown, right: unknown): boolean { const a = canonicalJsonBytes(left); const b = canonicalJsonBytes(right); return a.ok && b.ok && Buffer.from(a.value).equals(Buffer.from(b.value)); }
export function marketplaceSourceAnchor(projectRoot: string): StoreResult<string> {
  const anchor = projectIdentities(projectRoot)[0];
  return anchor === undefined ? fail("wrong-checkout", "Marketplace relative-source resolution requires a canonical checkout-family anchor") : { ok: true, value: anchor };
}
export function marketplaceSettingsDeclaration(source: MarketplaceRegistrationSource, scope: MutablePluginScope, sourceAnchor?: string): StoreResult<PluginMarketplaceRegistrationSource> {
  if (source.kind === "local-directory" || source.kind === "local-catalog-file") {
    let declared = source.path;
    if (scope !== "user") {
      if (sourceAnchor === undefined) return fail("wrong-checkout", "Project/local local-source declarations require the canonical checkout-family source anchor");
      const relative = path.relative(sourceAnchor, source.path);
      if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return fail("source-outside-project", "Project/local settings cannot author a local source outside the selected project");
      declared = `./${relative.split(path.sep).join("/")}`;
    }
    return { ok: true, value: source.kind === "local-directory" ? { kind: "directory", path: declared, localPath: declared } : { kind: "file", path: declared, localPath: declared } };
  }
  if (source.kind === "github") return { ok: true, value: { kind: "github", repo: source.repository, ...(source.ref === undefined ? {} : { ref: source.ref }) } };
  if (source.kind === "https-git") return { ok: true, value: { kind: "git", url: source.url, ...(source.ref === undefined ? {} : { ref: source.ref }) } };
  return { ok: true, value: { kind: "url", url: source.url } };
}
function validateMarketplaceSource(source: MarketplaceRegistrationSource): StoreResult<MarketplaceRegistrationSource> {
  const declaration = source.kind === "local-directory" ? { source: "directory", path: source.path }
    : source.kind === "local-catalog-file" ? { source: "file", path: source.path }
    : source.kind === "github" ? { source: "github", repo: source.repository, ...(source.ref === undefined ? {} : { ref: source.ref }) }
    : source.kind === "https-git" ? { source: "git", url: source.url, ...(source.ref === undefined ? {} : { ref: source.ref }) }
    : { source: "url", url: source.url };
  const routed = routeMarketplaceSource(declaration); return routed.ok && same(routed.value.descriptor, source) ? { ok: true, value: routed.value.descriptor } : fail("unsafe-source", "Marketplace source is malformed, unsafe, or unsupported");
}
function catalogPlugins(bytes: Uint8Array, sourceKind: MarketplaceRegistrationSource["kind"]): StoreResult<MarketplaceCatalogDeclarationSummary> {
  try { const normalized = normalizeMarketplaceCatalogDocument(JSON.parse(Buffer.from(bytes).toString("utf8")), sourceKind); return normalized === undefined ? fail("invalid-catalog", "Marketplace catalog shape is invalid") : { ok: true, value: Object.freeze({ ...normalized, ownerName: /^[A-Za-z0-9 ._'()-]{1,256}$/.test(normalized.ownerName) ? normalized.ownerName : "Marketplace publisher" }) }; }
  catch { return fail("invalid-catalog", "Marketplace catalog is malformed"); }
}

export function createMarketplaceAcquisitionAdapter(options: MarketplaceAcquisitionAdapterOptions): MarketplaceServiceDependencies["acquire"] {
  return async (name, source, signal) => {
    if (source.kind === "https-catalog") {
      const acquired = await acquireHttpsCatalogDescriptor(source, { ...options.https, ...(signal === undefined ? {} : { signal }) });
      if (!acquired.ok) return fail(acquired.error.code, acquired.error.message);
      const privateEvidence = readMarketplaceSnapshotEvidence(acquired.value); if (privateEvidence === undefined || sha256(privateEvidence.catalog) !== acquired.value.catalogDigest) return fail("invalid-evidence", "HTTPS acquisition omitted or mismatched trusted catalog evidence");
      const catalog = catalogPlugins(privateEvidence.catalog, source.kind); if (!catalog.ok) return catalog; if (catalog.value.name !== name) return fail("catalog-name-mismatch", "Resolved catalog identity does not match the selected marketplace name");
      const executableCatalog = deriveExecutableMarketplaceCatalogProjection(privateEvidence.catalog, source.kind); if (executableCatalog === undefined) return fail("invalid-catalog-authority", "Marketplace catalog executable authority is malformed, duplicated, or exceeds safe bounds");
      const target: MarketplaceSnapshotTrustTarget = { authorityKind: "catalog-only", marketplaceName: name, snapshotId: acquired.value.snapshotId, source: acquired.value.source as Extract<MarketplaceRegistrationSource, { kind: "https-catalog" }>, catalogDigest: acquired.value.catalogDigest, executableCatalog, provenance: { adapter: "public-https-catalog", canonicalUrl: (acquired.value.provenance.reviewed as { canonicalUrl: string }).canonicalUrl } };
      return { ok: true, value: Object.freeze({ target, catalogBytes: Uint8Array.from(privateEvidence.catalog) }) };
    }
    if (source.kind === "local-directory" || source.kind === "local-catalog-file") {
      const acquired = await acquireLocalMarketplaceSnapshot(source, { store: options.store, ...(signal === undefined ? {} : { signal }) });
      if (!acquired.ok) return fail(acquired.error.code, acquired.error.message); const privateEvidence = readMarketplaceSnapshotEvidence(acquired.value);
      if (privateEvidence === undefined || acquired.value.materialized === undefined || sha256(privateEvidence.catalog) !== acquired.value.catalogDigest) return fail("invalid-evidence", "Local acquisition omitted or mismatched materialized catalog evidence");
      const tree = acquired.value.materialized; const catalog = catalogPlugins(privateEvidence.catalog, source.kind); const executableCatalog = deriveExecutableMarketplaceCatalogProjection(privateEvidence.catalog, source.kind);
      if (!catalog.ok || catalog.value.name !== name || executableCatalog === undefined) { await discardMaterializedPluginTree(tree); return !catalog.ok ? catalog : executableCatalog === undefined ? fail("invalid-catalog-authority", "Marketplace catalog executable authority is malformed, duplicated, or exceeds safe bounds") : fail("catalog-name-mismatch", "Resolved catalog identity does not match the selected marketplace name"); }
      const published = await publishMaterializedArtifact(options.store, tree); if (!published.ok) { await discardMaterializedPluginTree(tree); return published; }
      const target: MarketplaceSnapshotTrustTarget = { authorityKind: "materialized", marketplaceName: name, snapshotId: acquired.value.snapshotId, source: acquired.value.source as Exclude<MarketplaceRegistrationSource, { kind: "https-catalog" }>, catalogDigest: acquired.value.catalogDigest, executableCatalog, artifactDigest: tree.treeDigest, treeDigest: tree.treeDigest, rootDigest: tree.treeDigest,
        selectedRoot: { requested: "tree-root", path: "", usedSingleWrapper: false }, artifactRoot: published.value.path, installRoot: published.value.path, catalogRelativePath: source.kind === "local-catalog-file" ? path.basename(source.path) : ".claude-plugin/marketplace.json", provenance: { adapter: source.kind === "local-directory" ? "local-directory-snapshot" : "local-catalog-snapshot", artifactDigest: tree.treeDigest } };
      return { ok: true, value: Object.freeze({ target, catalogBytes: Uint8Array.from(privateEvidence.catalog) }) };
    }
    const resolved = await resolveGitMarketplaceSource(source, { store: options.store, ...options.git, ...(signal === undefined ? {} : { signal }) }); if (!resolved.ok) return fail(resolved.error.code, resolved.error.message);
    const acquired = await acquireResolvedGitSource(resolved.value, { store: options.store, ...options.git, ...(signal === undefined ? {} : { signal }) }); if (!acquired.ok) return fail(acquired.error.code, acquired.error.message);
    if (!isGitAcquisitionEvidence(acquired.value) || acquired.value.kind !== "git-marketplace-snapshot") return fail("invalid-evidence", "Git acquisition returned the wrong evidence family");
    const catalogBytes = readGitMarketplaceCatalog(acquired.value); if (catalogBytes === undefined || sha256(catalogBytes) !== acquired.value.catalogDigest) { await discardMaterializedPluginTree(acquired.value.materialized); return fail("invalid-evidence", "Git acquisition omitted or mismatched immutable catalog bytes"); }
    const catalog = catalogPlugins(catalogBytes, source.kind); const executableCatalog = deriveExecutableMarketplaceCatalogProjection(catalogBytes, source.kind); if (!catalog.ok || catalog.value.name !== name || executableCatalog === undefined) { await discardMaterializedPluginTree(acquired.value.materialized); return !catalog.ok ? catalog : executableCatalog === undefined ? fail("invalid-catalog-authority", "Marketplace catalog executable authority is malformed, duplicated, or exceeds safe bounds") : fail("catalog-name-mismatch", "Resolved catalog identity does not match the selected marketplace name"); }
    const published = await publishMaterializedArtifact(options.store, acquired.value.materialized); if (!published.ok) { await discardMaterializedPluginTree(acquired.value.materialized); return published; }
    const target: MarketplaceSnapshotTrustTarget = { authorityKind: "materialized", marketplaceName: name, snapshotId: acquired.value.snapshotId, source, catalogDigest: acquired.value.catalogDigest, executableCatalog, artifactDigest: acquired.value.materialized.treeDigest, treeDigest: acquired.value.materialized.treeDigest, rootDigest: acquired.value.materialized.treeDigest,
      selectedRoot: { requested: "tree-root", path: "", usedSingleWrapper: false }, artifactRoot: published.value.path, installRoot: published.value.path, catalogRelativePath: ".claude-plugin/marketplace.json", provenance: { adapter: "anonymous-https-git", commit: acquired.value.commit, artifactDigest: acquired.value.materialized.treeDigest } };
    return { ok: true, value: Object.freeze({ target, catalogBytes: Uint8Array.from(catalogBytes) }) };
  };
}

async function writePrivate(target: string, bytes: Uint8Array): Promise<StoreResult<void>> {
  try { const handle = await fs.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } return { ok: true, value: undefined }; }
  catch { return fail("staging-failure", "Marketplace preparation could not stage private transaction evidence"); }
}
async function ensurePartition(store: OwnedStateStore, target: string): Promise<StoreResult<void>> {
  const valid = await revalidateOwnedStateStore(store); if (!valid.ok) return valid;
  try { const parent = path.dirname(target); if (!isContainedPath(store.recordsRoot, parent)) throw new Error("escape"); await fs.mkdir(parent, { recursive: true, mode: 0o700 }); if (process.platform !== "win32") await fs.chmod(parent, 0o700); const canonical = path.resolve(await fs.realpath(parent)); const expected = path.resolve(parent); if (process.platform === "win32" ? canonical.toLowerCase() !== expected.toLowerCase() : canonical !== expected) throw new Error("alias"); return { ok: true, value: undefined }; }
  catch { return fail("unsafe-store", "Marketplace record partition could not be established safely"); }
}
function exactDependents(values: readonly string[], marketplaceName: string): StoreResult<readonly string[]> {
  if (values.length > MAX_ITEMS || new Set(values).size !== values.length || !values.every((value) => value.length <= 256 && isQualifiedPluginId(value) && value.endsWith(`@${marketplaceName}`))) return fail("invalid-dependents", "Selected marketplace dependents are malformed, duplicated, wrong-marketplace, or over the safe limit");
  return { ok: true, value: Object.freeze([...values]) };
}
function fingerprint(rows: readonly MarketplaceObservation[], marketplaceName: string): StoreResult<Sha256> {
  if (rows.length > MAX_ROWS) return fail("observation-overflow", "Marketplace authority exceeds the global registration bound");
  const relevant = rows.filter((row) => row.name === marketplaceName);
  for (const row of relevant) { const source = validateMarketplaceSource(row.source); if (!source.ok) return fail("invalid-observation", "Marketplace authority contains an invalid source"); const dependents = exactDependents(row.dependents, marketplaceName); if (!dependents.ok) return dependents; }
  const bytes = canonicalJsonBytes(relevant.map((row) => ({ name: row.name, owner: row.owner, source: row.source, selected: row.selected, effective: row.effective, trusted: row.trusted, dependents: row.dependents, ...(row.registration === undefined ? {} : { registration: row.registration }), ...(row.snapshot === undefined ? {} : { snapshot: row.snapshot }), ...(row.catalog === undefined ? {} : { catalog: row.catalog }) })));
  return bytes.ok ? { ok: true, value: sha256(bytes.value) } : fail("invalid-observation", "Marketplace authority cannot be represented canonically");
}
const CATALOG_KINDS = new Set<CatalogPluginSource["kind"]>(["relative", "github", "https-git", "https-git-subdir", "npm", "https-zip"]);
function sanitizeCatalog(value: MarketplaceCatalogDeclarationSummary | undefined): StoreResult<MarketplaceCatalogDeclarationSummary> {
  if (value === undefined || !isDocumentedMarketplaceName(value.name) || typeof value.ownerName !== "string"
    || !Number.isSafeInteger(value.unsupportedEntries) || value.unsupportedEntries < 0 || value.unsupportedEntries > MAX_ITEMS || !Number.isSafeInteger(value.omittedEntries) || value.omittedEntries < 0 || value.omittedEntries > 1_000_000
    || !Array.isArray(value.plugins) || value.plugins.length > MAX_ITEMS) return fail("invalid-catalog", "Marketplace catalog presentation is structurally uncertain");
  const plugins: MarketplaceCatalogPluginSummary[] = [];
  for (const plugin of value.plugins) {
    if (!isDocumentedMarketplaceName(plugin.name) || typeof plugin.supported !== "boolean") return fail("invalid-catalog", "Marketplace catalog presentation is structurally uncertain");
    if (plugin.supported) {
      if (plugin.sourceKind === undefined || !CATALOG_KINDS.has(plugin.sourceKind) || plugin.error !== undefined) return fail("invalid-catalog", "Marketplace catalog relationships are uncertain");
      plugins.push(Object.freeze({ name: plugin.name, supported: true, sourceKind: plugin.sourceKind }));
    } else {
      if (plugin.sourceKind !== undefined) return fail("invalid-catalog", "Marketplace catalog relationships are uncertain");
      plugins.push(Object.freeze({ name: plugin.name, supported: false, error: "Unsupported, malformed, or unsafe plugin source declaration" }));
    }
  }
  if (plugins.filter((plugin) => !plugin.supported).length !== value.unsupportedEntries) return fail("invalid-catalog", "Marketplace catalog counts disagree with visible declarations");
  return { ok: true, value: Object.freeze({ name: value.name, ownerName: /^[A-Za-z0-9 ._'()-]{1,256}$/.test(value.ownerName) ? value.ownerName : "Marketplace publisher", plugins: Object.freeze(plugins), unsupportedEntries: value.unsupportedEntries, omittedEntries: value.omittedEntries }) };
}
function observationView(row: MarketplaceObservation, store: OwnedStateStore): MarketplaceObservationView {
  const source = validateMarketplaceSource(row.source); const name = isDocumentedMarketplaceName(row.name) ? row.name : "invalid-marketplace";
  const catalogResult = sanitizeCatalog(row.catalog); const catalog = catalogResult.ok ? catalogResult.value : undefined;
  const rawPlugins = row.catalog?.plugins ?? row.plugins; const plugins = catalog?.plugins ?? Object.freeze(rawPlugins.slice(0, MAX_ITEMS).flatMap((plugin) => isDocumentedMarketplaceName(plugin.name) && typeof plugin.supported === "boolean" && (plugin.sourceKind === undefined || CATALOG_KINDS.has(plugin.sourceKind))
    ? [Object.freeze({ name: plugin.name, supported: plugin.supported, ...(plugin.supported && plugin.sourceKind !== undefined ? { sourceKind: plugin.sourceKind } : {}), ...(!plugin.supported ? { error: "Plugin declaration is unsupported or invalid" } : {}) })] : []));
  const registration = row.registration === undefined ? undefined : createOwnedMarketplaceCodec(store.profileKey as `profile-${string}`).decode(row.registration); const snapshot = row.snapshot === undefined ? undefined : createOwnedMarketplaceSnapshotCodec({ profileKey: store.profileKey as `profile-${string}`, artifactsRoot: store.artifactsRoot }).decode(row.snapshot);
  const ownedRelationships = row.owner !== "picc-owned" || registration?.ok === true && snapshot?.ok === true && source.ok && catalog !== undefined
    && registration.value.name === name && registration.value.selectedSnapshotId === snapshot.value.snapshotId && snapshot.value.marketplaceName === name
    && same(registration.value.source, source.value) && same(snapshot.value.source, source.value) && same(plugins, catalog.plugins)
    && row.selected === true && row.trusted === true;
  const uncertain = !ownedRelationships || !catalogResult.ok && row.catalog !== undefined;
  const diagnostics = [...(row.errors.length > 0 ? ["Marketplace observation reported errors"] : []), ...(row.provenance.length > 0 ? ["Marketplace provenance is retained internally"] : []), ...(uncertain ? ["Marketplace authority relationships are uncertain"] : [])].slice(0, MAX_DIAGNOSTICS);
  return Object.freeze({ name, owner: ["picc-owned", "claude-imported", "seed", "managed"].includes(row.owner) ? row.owner : "claude-imported", source: source.ok ? source.value : { kind: "unavailable" as const }, selected: uncertain ? false : row.selected === true, effective: uncertain ? false : row.effective === true, trusted: uncertain ? false : row.trusted === true,
    ...(registration?.ok ? { registration: registration.value } : {}), ...(snapshot?.ok ? { snapshot: snapshot.value } : {}), ...(catalog === undefined ? {} : { catalog }), plugins, pluginOmitted: Math.max(catalog?.omittedEntries ?? 0, rawPlugins.length - plugins.length), dependents: Object.freeze(row.dependents.slice(0, MAX_ITEMS).filter((value) => typeof value === "string" && value.length <= 256 && isQualifiedPluginId(value))), dependentOmitted: Math.max(0, row.dependents.length - MAX_ITEMS), diagnostics: Object.freeze(diagnostics), diagnosticOmitted: Math.max(0, row.errors.length + row.provenance.length + (uncertain ? 1 : 0) - diagnostics.length) });
}
async function cleanupParticipants(store: OwnedStateStore, participants: readonly TransactionParticipant[]): Promise<StoreResult<void>> {
  try {
    const candidates = participants.filter((participant): participant is OrdinaryTransactionParticipant => !isOwnedDataRetirementParticipant(participant)).flatMap((participant) => [participant.stagedPath, participant.rollback.kind === "restore-backup" ? participant.rollback.path : undefined]).filter((candidate): candidate is string => candidate !== undefined && isContainedPath(store.stagingRoot, candidate));
    await Promise.all(candidates.map((candidate) => fs.rm(candidate, { force: true })));
    return { ok: true, value: undefined };
  } catch { return fail("cleanup-failure", "Marketplace preparation failed and operation-owned staging cleanup could not be confirmed"); }
}

export class PluginMarketplaceService {
  readonly #dependencies: MarketplaceServiceDependencies;
  readonly #prepared = new Map<string, PreparedMarketplaceEntry>();
  readonly #transactions: MarketplaceTransactionService;
  constructor(dependencies: MarketplaceServiceDependencies) {
    this.#dependencies = dependencies; const codec = createMarketplaceTransactionCodec({ store: dependencies.store, settingsCodec: createPluginSettingsTransactionCodec() });
    this.#transactions = new MarketplaceTransactionService({ store: dependencies.store, codec, ...(dependencies.transactionFaults === undefined ? {} : { faults: dependencies.transactionFaults }),
      fresh: async (preview) => { const current = fingerprint(this.#rawObservations(), preview.registration.name); return current.ok && current.value === preview.stateFingerprint ? { ok: true, value: undefined } : current.ok ? fail("stale-observation", "Marketplace source, owner, effective state, snapshot, catalog, or dependents changed; create a new preview") : current; },
      ...(dependencies.processOwnershipProbe === undefined ? {} : { processProbe: dependencies.processOwnershipProbe }),
      ...(dependencies.beforeTransactionExecution === undefined ? {} : { beforeTransactionExecution: dependencies.beforeTransactionExecution }) });
  }
  #rawObservations(): readonly MarketplaceObservation[] { return this.#dependencies.observe(); }
  listStatus(): MarketplaceObservationList {
    const raw = this.#rawObservations(); const rows = raw.slice(0, MAX_ROWS).map((row) => observationView(row, this.#dependencies.store)).sort((a, b) => a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner));
    return Object.freeze({ rows: Object.freeze(rows), omitted: Math.max(0, raw.length - MAX_ROWS), uncertain: raw.length > MAX_ROWS });
  }
  list(): readonly MarketplaceObservationView[] { return this.listStatus().rows; }
  details(name: string, registration?: OwnedMarketplaceRecord): StoreResult<MarketplaceObservationView> {
    if (!isDocumentedMarketplaceName(name)) return fail("invalid-marketplace", "Marketplace name is invalid"); const status = this.listStatus();
    const rows = status.rows.filter((row) => row.name === name && (registration === undefined || same(row.registration, registration)));
    if (rows.length === 0 && status.omitted > 0) return fail("observation-overflow", `Marketplace details are uncertain because ${status.omitted} registrations were omitted`);
    return rows.length === 1 ? { ok: true, value: rows[0]! } : rows.length === 0 ? fail("not-found", "Marketplace registration was not found") : fail("ambiguous-marketplace", "Select one exact marketplace registration and snapshot");
  }
  async add(name: string, source: MarketplaceRegistrationSource, options: MarketplaceMutationOptions = {}): Promise<StoreResult<MarketplaceMutationPreview>> {
    const captured = this.#captureMutation(); if (!captured.ok) return captured; const reserved = await this.#reserveOperation();
    return reserved.ok ? this.#finishPlanning(reserved.value.operationId, reserved.value.token, this.#acquireAndPlan(reserved.value.operationId, "add", name, source, options, captured.value, undefined, reserved.value.token)) : reserved;
  }
  async refresh(name: string, options: MarketplaceMutationOptions = {}): Promise<StoreResult<MarketplaceMutationPreview>> {
    const captured = this.#captureMutation(); if (!captured.ok) return captured; const selected = this.#select(captured.value, name, options.registration); if (!selected.ok) return selected; const reserved = await this.#reserveOperation();
    return reserved.ok ? this.#finishPlanning(reserved.value.operationId, reserved.value.token, this.#acquireAndPlan(reserved.value.operationId, "refresh", name, selected.value.source, { ...options, registration: selected.value.registration }, captured.value, selected.value, reserved.value.token)) : reserved;
  }
  async update(name: string, options: MarketplaceMutationOptions = {}): Promise<StoreResult<MarketplaceMutationPreview>> { return this.refresh(name, options); }
  async remove(name: string, options: MarketplaceMutationOptions = {}): Promise<StoreResult<MarketplaceMutationPreview>> {
    const captured = this.#captureMutation(); if (!captured.ok) return captured; const selected = this.#select(captured.value, name, options.registration); if (!selected.ok) return selected; if (selected.value.dependents.length > 0 && options.acknowledgePreservedDependents !== true) return fail("consequence-confirmation-required", "Acknowledge that removal preserves installed plugins but loses future catalog/update availability");
    const reserved = await this.#reserveOperation(); return reserved.ok ? this.#finishPlanning(reserved.value.operationId, reserved.value.token, this.#plan(reserved.value.operationId, "remove", selected.value, selected.value.snapshot!, selected.value.catalog!, undefined, options, ["Removes only the selected local registration", "Preserves installations, enablement declarations, code, data, generations, and immutable snapshots", "Loses future catalog and update availability from this registration"], captured.value, reserved.value.token)) : reserved;
  }
  prepare(preview: MarketplaceMutationPreview): StoreResult<LifecyclePreparedMutation<MarketplaceMutationPreview>> {
    const found = this.#prepared.get(preview.operationId); if (found === undefined || !this.#owns(found) || !same(found.preview, preview)) return fail("stale-preview", "Marketplace preview is stale or was not prepared by this service");
    if (found.state === "cancelling") return fail("cancellation-in-progress", "Cancellation is in progress; wait for discardPreview to finish");
    if (found.state === "running") return fail("operation-running", "This operation is running; wait for its active execute result");
    if (found.state === "pending") return fail("pending-recovery", `This operation has durable pending state; call recoveryStatus(${JSON.stringify(preview.operationId)}) and then recover with one of its feasible actions`);
    if (found.state === "terminal") return fail("operation-terminal", `This operation is terminal; call receipt(${JSON.stringify(preview.operationId)}) to inspect its result`);
    const bound = this.#transactions.bind(found.preview, found.transaction); if (!bound.ok) return bound; if (found.state === "preview") found.state = "bound";
    return { ok: true, value: Object.freeze({ preview: bound.value.preview, execute: async (digest: string) => {
      if (this.#prepared.get(preview.operationId) !== found || !this.#owns(found)) return fail("preparation-revoked", "This marketplace preparation generation was discarded or superseded");
      if (found.state === "cancelling") return fail("cancellation-in-progress", "Cancellation is in progress; wait for discardPreview to finish");
      if (found.state === "running") return fail("operation-running", "This operation is running; wait for its active execute result because retry and cancellation are unavailable");
      if (found.state === "pending") return fail("pending-recovery", `This operation has durable pending state; call recoveryStatus(${JSON.stringify(preview.operationId)}) and then recover with one of its feasible actions`);
      found.state = "running"; const result = await bound.value.execute(digest);
      if (result.ok || !result.ok && "receipt" in result) this.#markTerminal(found); else found.state = !result.ok && result.code === "pending-recovery" ? "pending" : "bound"; return result;
    } }) };
  }
  async discardPreview(operationId: string): Promise<StoreResult<void>> {
    const found = this.#prepared.get(operationId); if (found === undefined || !this.#owns(found)) return fail("preview-not-found", "Never-started marketplace preparation was not found");
    if (found.state === "terminal") return fail("preview-started", "This operation is terminal; inspect receipt(id) instead of cancelling it");
    if (found.state === "cancelling") return fail("cancellation-in-progress", "Cancellation is already in progress; wait for discardPreview to finish");
    if (found.state === "running") return fail("preview-started", "This operation is running; wait for its active execute result because retry and cancellation are unavailable");
    if (found.state === "pending") return fail("preview-started", `This operation has durable pending state; call recoveryStatus(${JSON.stringify(operationId)}) and then recover with one of its feasible actions`);
    const cancellableState = found.state; found.state = "cancelling";
    try {
      await fs.lstat(path.join(this.#dependencies.store.journalsRoot, `${operationId}.json`));
      const journal = await readTransactionJournal(this.#dependencies.store, operationId);
      if (journal.ok && receiptMatchesPrepared(journal.value, found.transaction)) {
        found.state = "pending";
        return fail("preview-started", `Durable state for this operation appeared during cancellation; call recoveryStatus(${JSON.stringify(operationId)}) and then recover with one of its feasible actions`);
      }
      found.state = cancellableState;
      return fail("operation-evidence-uncertain", "Journal evidence collided with cancellation and its identity is uncertain; preserve it and inspect recovery status before any further mutation");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { found.state = cancellableState; return fail("operation-evidence-uncertain", "Transaction evidence is uncertain; preserve it and inspect recovery status before cancellation"); }
    }
    const cleaned = await cleanupParticipants(this.#dependencies.store, found.transaction.participants);
    if (!cleaned.ok) { found.state = cancellableState; return cleaned; }
    if (this.#prepared.get(operationId) === found && LIVE_RESERVATIONS.get(this.#reservationKey(operationId)) === found.token) this.#releaseEntry(operationId, found);
    return { ok: true, value: undefined };
  }
  async recoveryStatus(operationId: string): Promise<StoreResult<MarketplaceRecoveryStatus>> { return this.#transactions.recoveryStatus(operationId); }
  async recover(operationId: string, action: "complete" | "rollback"): Promise<StoreResult<MarketplaceReceipt>> { const result = await this.#transactions.recover(operationId, action); if (result.ok) await this.#releaseForTerminal(operationId); return result; }
  async receipt(operationId: string): Promise<StoreResult<MarketplaceReceipt | undefined>> { const result = await this.#transactions.receipt(operationId); if (result.ok && result.value !== undefined) await this.#releaseForTerminal(operationId); return result; }

  #operationId(): string { return this.#dependencies.operationId?.() ?? `marketplace_${randomBytes(18).toString("base64url")}`; }
  #reservationKey(operationId: string): string { return `${this.#dependencies.store.profileRoot}\u0000${operationId}`; }
  #owns(entry: PreparedMarketplaceEntry): boolean { return entry.state === "terminal" || LIVE_RESERVATIONS.get(this.#reservationKey(entry.preview.operationId)) === entry.token; }
  #releaseToken(operationId: string, token: symbol): void { const key = this.#reservationKey(operationId); if (LIVE_RESERVATIONS.get(key) === token) LIVE_RESERVATIONS.delete(key); }
  #releaseEntry(operationId: string, entry: PreparedMarketplaceEntry): void { if (this.#prepared.get(operationId) === entry) this.#prepared.delete(operationId); this.#releaseToken(operationId, entry.token); }
  #markTerminal(entry: PreparedMarketplaceEntry): void { entry.state = "terminal"; this.#releaseToken(entry.preview.operationId, entry.token); }
  async #releaseForTerminal(operationId: string): Promise<void> { const entry = this.#prepared.get(operationId); if (entry === undefined || !this.#owns(entry)) return; const receipt = await readTransactionReceipt(this.#dependencies.store, operationId); if (receipt.ok && receipt.value !== undefined && receiptMatchesPrepared(receipt.value, entry.transaction)) this.#markTerminal(entry); }
  async #finishPlanning(operationId: string, token: symbol, planning: Promise<StoreResult<MarketplaceMutationPreview>>): Promise<StoreResult<MarketplaceMutationPreview>> { const result = await planning; if (!result.ok) this.#releaseToken(operationId, token); return result; }
  async #reserveOperation(): Promise<StoreResult<{ readonly operationId: string; readonly token: symbol }>> {
    const operationId = this.#operationId(); const reservationKey = this.#reservationKey(operationId);
    if (LIVE_RESERVATIONS.has(reservationKey)) return fail("duplicate-operation-id", "Marketplace operation id is already reserved by a live preview or bound handle");
    const terminal = await readTransactionReceipt(this.#dependencies.store, operationId); if (!terminal.ok) return fail("operation-id-uncertain", "Marketplace operation receipt authority is uncertain; inspect receipt(id) before retrying");
    if (terminal.value !== undefined) return fail("terminal-operation-id", `Marketplace operation ${operationId} is terminal; call receipt(${JSON.stringify(operationId)}) instead of creating a new preparation`);
    try { await fs.lstat(path.join(this.#dependencies.store.journalsRoot, `${operationId}.json`)); return fail("pending-recovery", `Marketplace operation ${operationId} already has journal evidence; inspect recoveryStatus before recovery`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("pending-recovery", "Marketplace operation journal authority is uncertain"); }
    const profilePrefix = `${this.#dependencies.store.profileRoot}\u0000`; if ([...LIVE_RESERVATIONS.keys()].filter((key) => key.startsWith(profilePrefix)).length >= MAX_PREPARED) return fail("preview-limit", "Discard an unjournaled marketplace preparation before preparing another");
    const token = Symbol(operationId); LIVE_RESERVATIONS.set(reservationKey, token); return { ok: true, value: { operationId, token } };
  }
  #captureMutation(): StoreResult<CapturedObservations> {
    const transactions = observePersistedTransactionsSync(this.#dependencies.store); const blocking = transactions.journals.find((journal) => journal.status === "pending" || journal.status === "invalid");
    if (blocking !== undefined) return fail("pending-recovery", blocking.status === "pending" ? `Profile mutation is blocked by pending operation ${blocking.operationId}; inspect recoveryStatus(${JSON.stringify(blocking.operationId)}) before recovery` : "Profile transaction journals are invalid or overflowed; inspect lifecycle recovery status before mutating");
    const rows = this.#rawObservations(); if (rows.length > MAX_ROWS) return fail("observation-uncertain", "Marketplace mutation is unavailable while registrations exceed the global authority bound");
    try { const captured = structuredClone(rows) as MarketplaceObservation[]; return { ok: true, value: Object.freeze({ rows: Object.freeze(captured.map((row) => Object.freeze(row))) }) }; }
    catch { return fail("invalid-observation", "Marketplace observations could not be captured as bounded inert data"); }
  }
  #select(captured: CapturedObservations, name: string, registration?: OwnedMarketplaceRecord): StoreResult<MarketplaceObservation> {
    const raw = captured.rows;
    const rows = raw.filter((row) => row.name === name && (registration === undefined || same(row.registration, registration)));
    if (rows.length !== 1) return rows.length === 0 ? fail("not-found", "The exact marketplace registration was not found") : fail("ambiguous-marketplace", "Differing authority requires one exact writable registration and snapshot");
    const row = rows[0]!;
    if (row.owner !== "picc-owned") return row.owner === "managed" ? fail("managed-readonly", "This marketplace is managed by an administrator; ask the administrator to modify it") : row.owner === "seed" ? fail("seed-readonly", "This seed marketplace is read-only; modify its configured seed source or provider") : fail("imported-readonly", "This marketplace is Claude-owned; use Claude Code to modify it");
    if (row.registration === undefined || row.snapshot === undefined || row.catalog === undefined) return fail("invalid-owned-observation", "Owned marketplace authority or catalog evidence is incomplete");
    const dependents = exactDependents(row.dependents, row.name); const catalog = sanitizeCatalog(row.catalog); if (!dependents.ok || !catalog.ok || catalog.value.omittedEntries > 0) return fail("invalid-owned-observation", "Selected marketplace authority has omitted catalog entries, uncertain catalog relationships, or invalid dependents");
    const pluginCatalog = sanitizeCatalog({ ...catalog.value, plugins: row.plugins });
    const decodedRegistration = createOwnedMarketplaceCodec(this.#dependencies.store.profileKey as `profile-${string}`).decode(row.registration); const snapshot = createOwnedMarketplaceSnapshotCodec({ profileKey: this.#dependencies.store.profileKey as `profile-${string}`, artifactsRoot: this.#dependencies.store.artifactsRoot }).decode(row.snapshot);
    const sanitizedPlugins = catalog.value.plugins;
    if (!decodedRegistration.ok || !snapshot.ok || !pluginCatalog.ok || decodedRegistration.value.name !== row.name || !same(decodedRegistration.value.source, row.source) || decodedRegistration.value.selectedSnapshotId !== snapshot.value.snapshotId
      || !same(decodedRegistration.value.source, snapshot.value.source) || row.selected !== true || row.trusted !== true || catalog.value.name !== row.name || !same(sanitizedPlugins, pluginCatalog.value.plugins)) return fail("invalid-owned-observation", "Owned marketplace row relationships do not match exact codec authority");
    return { ok: true, value: Object.freeze({ ...row, registration: decodedRegistration.value, snapshot: snapshot.value, catalog: catalog.value, plugins: sanitizedPlugins, dependents: dependents.value, errors: Object.freeze([]), provenance: Object.freeze([]) }) };
  }
  async #acquireAndPlan(operationId: string, action: "add" | "refresh", name: string, source: MarketplaceRegistrationSource, options: MarketplaceMutationOptions, captured: CapturedObservations, selectedPrior: MarketplaceObservation | undefined, token: symbol): Promise<StoreResult<MarketplaceMutationPreview>> {
    if (!isDocumentedMarketplaceName(name)) return fail("invalid-marketplace", "Marketplace name is invalid"); const raw = captured.rows;
    const validSource = validateMarketplaceSource(source); if (!validSource.ok) return validSource;
    const priorRows = raw.filter((row) => row.name === name); const acquired = await this.#dependencies.acquire(name, validSource.value, options.signal); if (!acquired.ok) return acquired;
    const catalogBytes = Uint8Array.from(acquired.value.catalogBytes); if (catalogBytes.byteLength === 0 || catalogBytes.byteLength > MAX_CATALOG_BYTES || sha256(catalogBytes) !== acquired.value.target.catalogDigest) return fail("catalog-digest-mismatch", "Acquired immutable catalog bytes do not match the trusted catalog digest");
    const catalog = catalogPlugins(catalogBytes, source.kind); if (!catalog.ok || catalog.value.name !== name) return !catalog.ok ? catalog : fail("catalog-name-mismatch", "Resolved catalog identity does not match the selected marketplace name");
    const executableCatalog = deriveExecutableMarketplaceCatalogProjection(catalogBytes, source.kind); if (executableCatalog === undefined || !same(executableCatalog, acquired.value.target.executableCatalog)) return fail("catalog-authority-mismatch", "Acquired catalog projection does not match the exact trusted catalog bytes");
    if (catalog.value.omittedEntries > 0) return fail("catalog-omitted", "Marketplace mutation requires a complete bounded catalog; omitted declarations make the exact result uncertain");
    if (!same(acquired.value.target.source, source) || acquired.value.target.marketplaceName !== name) return fail("source-changed", "Acquisition returned different canonical source or catalog authority");
    const scope = options.scope ?? options.registration?.scope ?? "user"; if (scope !== "user" && this.#dependencies.checkoutFamilyKey === undefined) return fail("wrong-checkout", "Project/local scope requires the exact checkout family");
    const registration: OwnedMarketplaceRecord = scope === "user" ? { ownership: "picc-owned", name, profileKey: this.#dependencies.store.profileKey as `profile-${string}`, scope, source, selectedSnapshotId: acquired.value.target.snapshotId } : { ownership: "picc-owned", name, profileKey: this.#dependencies.store.profileKey as `profile-${string}`, scope, checkoutFamilyKey: this.#dependencies.checkoutFamilyKey!, projectKey: this.#dependencies.checkoutFamilyKey!, source, selectedSnapshotId: acquired.value.target.snapshotId };
    if (action === "refresh" && (options.registration === undefined || ownedMarketplaceScopeKey(options.registration) !== ownedMarketplaceScopeKey(registration))) return fail("record-mismatch", "Refresh requires the exact writable record and scope");
    const grant = createMarketplaceSnapshotTrustGrant(acquired.value.target); if (!grant.ok) return grant;
    const snapshot: OwnedMarketplaceSnapshotRecord = { ownership: "picc-owned", profileKey: registration.profileKey, ...acquired.value.target, trust: grant.value };
    const exactRegistration = createOwnedMarketplaceCodec(registration.profileKey).decode(registration); const exactSnapshot = createOwnedMarketplaceSnapshotCodec({ profileKey: registration.profileKey, artifactsRoot: this.#dependencies.store.artifactsRoot }).decode(snapshot);
    if (!exactRegistration.ok || !exactSnapshot.ok) return fail("invalid-acquisition-authority", "Acquisition did not produce exact t07 registration and snapshot authority");
    if (action === "add" && priorRows.length > 0) {
      const identical = priorRows.length === 1 && priorRows[0]!.owner === "picc-owned" && same(priorRows[0]!.source, source) && same(priorRows[0]!.registration, registration) && same(priorRows[0]!.snapshot, snapshot) && same(priorRows[0]!.catalog, catalog.value);
      return identical ? fail("no-change", "The exact owner, record, source, scope, and catalog snapshot are already registered") : fail("same-name-conflict", "A same-name marketplace has different owner, scope, source, or snapshot authority; select it explicitly");
    }
    const authored = marketplaceSettingsDeclaration(source, scope, this.#dependencies.marketplaceSourceAnchor); if (!authored.ok) return authored;
    const dependents = selectedPrior?.dependents ?? [];
    const row: MarketplaceObservation = { name, owner: "picc-owned", source, selected: true, effective: true, trusted: true, registration, snapshot, catalog: catalog.value, plugins: catalog.value.plugins, dependents, errors: [], provenance: [] };
    return this.#plan(operationId, action, row, snapshot, catalog.value, authored.value, options, [action === "add" ? "Adds only the selected local registration" : "Selects a new immutable catalog snapshot without changing installed generation membership", "Does not install, update, enable, disable, or remove plugins"], captured, token);
  }

  async #plan(operationId: string, action: MarketplaceMutationAction, row: MarketplaceObservation, snapshot: OwnedMarketplaceSnapshotRecord, catalog: MarketplaceCatalogDeclarationSummary, value: PluginMarketplaceRegistrationSource | undefined, options: MarketplaceMutationOptions, consequences: readonly string[], captured: CapturedObservations, token: symbol): Promise<StoreResult<MarketplaceMutationPreview>> {
    const registration = row.registration!; const settingsPlan = await this.#dependencies.planSettings({ operationId, action, name: row.name, scope: registration.scope, ...(value === undefined ? {} : { value }), declarationOnly: options.declarationOnly === true }); if (!settingsPlan.ok) return settingsPlan;
    const settings = await preparePluginSettingsWrite({ store: this.#dependencies.store, operationId, profilePath: this.#dependencies.profilePath, plan: settingsPlan.value }); if (!settings.ok) return settings;
    const settingsParticipant = settings.value.transaction.participants[0]; if (settingsParticipant === undefined || isOwnedDataRetirementParticipant(settingsParticipant)) return fail("invalid-plan", "Settings producer returned a non-file participant");
    const recordParticipants: OrdinaryTransactionParticipant[] = []; const summaries: MarketplaceParticipantSummary[] = []; const allParticipants = (): TransactionParticipant[] => [settingsParticipant, ...recordParticipants];
    const abort = async (failure: StoreResult<never>): Promise<StoreResult<MarketplaceMutationPreview>> => { const cleanup = await cleanupParticipants(this.#dependencies.store, allParticipants()); return cleanup.ok ? failure : cleanup; };
    try {
      const settingsEvidence = canonicalJsonBytes(settingsParticipant.producerEvidence); if (!settingsEvidence.ok) return abort(settingsEvidence);
      await this.#dependencies.preparationFaults?.hit("after-settings");
      summaries.push({ order: 0, role: "settings", target: settingsParticipant.targetPath, effect: settingsParticipant.effect ?? "replace", scopeKey: settingsParticipant.scopeKey, stagedDigest: settingsParticipant.stagedDigest, payloadDigest: sha256(settingsEvidence.value) });
      const addRecord = async (role: "snapshot" | "registration", payload: OwnedMarketplaceSnapshotRecord | OwnedMarketplaceRecord, effect: "replace" | "delete"): Promise<StoreResult<void>> => {
        const codec = role === "snapshot" ? createOwnedMarketplaceSnapshotCodec({ profileKey: registration.profileKey, artifactsRoot: this.#dependencies.store.artifactsRoot }) : createOwnedMarketplaceCodec(registration.profileKey);
        const scopeKey = role === "snapshot" ? ownedMarketplaceSnapshotScopeKey(payload as OwnedMarketplaceSnapshotRecord) : ownedMarketplaceScopeKey(payload as OwnedMarketplaceRecord); const partition = ownedRecordPartition(this.#dependencies.store, "picc-owned", scopeKey); if (!partition.ok) return partition; const target = path.join(partition.value, "record.json"); const established = await ensurePartition(this.#dependencies.store, target); if (!established.ok) return established;
        const envelope = createRecordEnvelope(codec as never, "picc-owned", scopeKey, payload as never); if (!envelope.ok) return envelope; let prior: Buffer | undefined; try { prior = await fs.readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("record-unreadable", "Marketplace record precondition is unreadable"); }
        if (effect === "delete" && (prior === undefined || !Buffer.from(envelope.value.bytes).equals(prior))) return fail("stale-preview", "Selected registration bytes changed; re-preview before removal");
        const suffix = randomBytes(8).toString("hex"); const stagedPath = path.join(this.#dependencies.store.stagingRoot, `${operationId}-${role}-${suffix}.json`); const staged = await writePrivate(stagedPath, effect === "delete" ? prior! : envelope.value.bytes); if (!staged.ok) return staged;
        let rollback: OrdinaryTransactionParticipant["rollback"];  if (prior === undefined) rollback = { kind: "delete-new-target" }; else { const backup = path.join(this.#dependencies.store.stagingRoot, `${operationId}-${role}-${suffix}.backup`); const backed = await writePrivate(backup, prior); if (!backed.ok) { await fs.rm(stagedPath, { force: true }).catch(() => undefined); return backed; } rollback = { kind: "restore-backup", path: backup, digest: sha256(prior) }; }
        const participant: OrdinaryTransactionParticipant = { kind: `marketplace-${role}`, ...(effect === "delete" ? { effect } : {}), key: `${role}-${row.name}`, ownerKey: "picc-owned", scopeKey, targetPath: target, targetClass: "owned", precondition: prior === undefined ? { state: "absent" } : { state: "present", digest: sha256(prior) }, stagedPath, stagedDigest: sha256(effect === "delete" ? prior! : envelope.value.bytes), rollback, producerEvidence: { role, payload } }; recordParticipants.push(participant); summaries.push({ order: summaries.length, role, target, effect, scopeKey, stagedDigest: participant.stagedDigest, payloadDigest: envelope.value.envelope.payloadDigest }); return { ok: true, value: undefined };
      };
      if (action !== "remove") { const added = await addRecord("snapshot", snapshot, "replace"); if (!added.ok) return abort(added); await this.#dependencies.preparationFaults?.hit("after-snapshot"); }
      const registrationAdded = await addRecord("registration", registration, action === "remove" ? "delete" : "replace"); if (!registrationAdded.ok) return abort(registrationAdded); await this.#dependencies.preparationFaults?.hit("after-registration");
      const settingsProducer = settingsParticipant.producerEvidence as { authorityFingerprints: unknown }; const settingsBytes = canonicalJsonBytes(settingsProducer.authorityFingerprints); if (!settingsBytes.ok) return abort(settingsBytes);
      const stateFingerprint = fingerprint(captured.rows, row.name); if (!stateFingerprint.ok) return abort(stateFingerprint);
      const declarationConsequences = settings.value.summary.declarationOnly ? [...consequences, `Declaration only: the authored registration will not become effective${settings.value.summary.effectiveAfter.present ? `; retained effective scope is ${settings.value.summary.effectiveAfter.scope}` : ""}`] : consequences;
      const context = { profileKey: this.#dependencies.store.profileKey as `profile-${string}`, artifactsRoot: this.#dependencies.store.artifactsRoot };
      const preview = createMarketplaceMutationPreview({ operationId, action, registration, snapshot, catalog, settingsEffect: settings.value.summary, stateFingerprint: stateFingerprint.value, settingsFingerprint: sha256(settingsBytes.value), dependents: row.dependents, acknowledgement: "preserve-installations", consequences: declarationConsequences, participants: summaries }, context); if (!preview.ok) return abort(preview);
      await this.#dependencies.preparationFaults?.hit("before-compound-prepare");
      const codec = createMarketplaceTransactionCodec({ store: this.#dependencies.store, settingsCodec: settings.value.codec }); const transaction = await prepareTransaction({ store: this.#dependencies.store, codec, operationId, confirmationSummary: preview.value, participants: allParticipants() }); if (!transaction.ok) return abort(transaction);
      if (LIVE_RESERVATIONS.get(this.#reservationKey(operationId)) !== token) return abort(fail("preparation-revoked", "Marketplace preparation generation was superseded"));
      this.#prepared.set(operationId, { token, preview: preview.value, transaction: transaction.value, state: "preview" }); return preview;
    } catch { return abort(fail("preparation-failure", "Marketplace preparation failed before journaling")); }
  }
}

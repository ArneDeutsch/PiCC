import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { normalizePortableRelativePath, routeCatalogPluginSource, routeMarketplaceSource } from "./source-matrix.js";
import { digestArtifactEntries, type ArtifactDigestEntry } from "./artifact-digest.js";
import { PORTABLE_TREE_LIMITS } from "./tree-validator.js";
import { canonicalJsonBytes, createProducerCodecRegistry, isContainedPath, ownedRecordPartition, readRecordEnvelope, revalidateOwnedStateStore, sha256, type OwnedStateStore, type ProducerCodec, type ProducerCodecRegistry, type StoreResult } from "./state-store.js";
import type { CatalogPluginSource, CheckoutFamilyKey, LifecycleProfileKey, MarketplaceRegistrationSource, MutablePluginScope, QualifiedPluginIdentity, Sha256 } from "./types.js";
import type { PluginRootSelection } from "./plugin-root.js";
import { isQualifiedPluginId } from "../util/plugin-id.js";
import { issueMarketplaceGenerationFromOwnedAdmission, type MarketplaceGeneration } from "./marketplace-generation.js";
import { acquisitionFailure, issueRetainedMarketplaceGenerationAuthority, type RetainedMarketplaceGenerationEvidence } from "./acquisition/common.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const GENERATION = /^admission-[A-Za-z0-9_-]{1,96}$/;
const SNAPSHOT = /^marketplace-[A-Za-z0-9_-]{1,128}$/;
const PROFILE = /^profile-[A-Za-z0-9_-]+$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$/;
const CHECKOUT = /^checkout-[A-Za-z0-9_-]+$/;
const MARKETPLACE = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const MAX_RECORDS = 4096;
const MAX_RECORD_DEPTH = 8;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RETIREMENT_EVIDENCE_BYTES = 16 * 1024 * 1024;

export interface InstallationCatalogProvenance { readonly marketplaceName: string; readonly marketplaceSnapshotId: `marketplace-${string}`; readonly catalogDigest: Sha256 }
export type PersistedSelectedRoot = PluginRootSelection | { readonly requested: "package/"; readonly path: ""; readonly usedSingleWrapper: true };
export type PersistedPluginSource = InstallationCatalogProvenance & (
  | { readonly kind: "marketplace-relative"; readonly path: string; readonly pluginRoot?: string }
  | { readonly kind: "git"; readonly declaration: Extract<CatalogPluginSource, { readonly kind: "github" | "https-git" | "https-git-subdir" }>; readonly commit: string }
  | { readonly kind: "npm"; readonly package: string; readonly version: string; readonly integrity: string; readonly registry: "https://registry.npmjs.org" }
  | { readonly kind: "zip"; readonly url: string; readonly zipDigest: Sha256 }
);

export interface ExecutableTrustGrant {
  readonly target: QualifiedPluginIdentity;
  readonly artifactDigest: Sha256;
  readonly treeDigest: Sha256;
  readonly rootDigest: Sha256;
  readonly executableDigest: Sha256;
  readonly selectedRoot: PersistedSelectedRoot;
  readonly allowedCrossMarketplaceDependencies: readonly string[];
}
export interface OwnedPluginInstallationRecord {
  readonly ownership: "picc-owned";
  readonly pluginId: QualifiedPluginIdentity;
  readonly scope: MutablePluginScope;
  readonly profileKey: LifecycleProfileKey;
  readonly checkoutFamilyKey?: CheckoutFamilyKey;
  readonly projectKey?: string;
  readonly version: string;
  readonly source: PersistedPluginSource;
  readonly artifactDigest: Sha256;
  readonly treeDigest: Sha256;
  readonly rootDigest: Sha256;
  readonly executableDigest: Sha256;
  readonly selectedRoot: PersistedSelectedRoot;
  readonly installRoot: string;
  readonly dataIdentity: { readonly profileKey: LifecycleProfileKey; readonly identity: QualifiedPluginIdentity };
  readonly executableGenerationId: string;
  readonly trust: ExecutableTrustGrant;
  readonly allowedCrossMarketplaceDependencies: readonly string[];
  readonly marketplaceDefaultEnabled?: boolean;
}
export interface ExecutableAdmissionGenerationMember {
  readonly pluginId: QualifiedPluginIdentity;
  readonly scope: MutablePluginScope;
  readonly checkoutFamilyKey?: CheckoutFamilyKey;
  readonly projectKey?: string;
  readonly recordDigest: Sha256;
}
export interface ExecutableAdmissionGeneration { readonly ownership: "picc-owned"; readonly profileKey: LifecycleProfileKey; readonly generationId: string; readonly members: readonly ExecutableAdmissionGenerationMember[] }
interface OwnedMarketplaceRecordBase {
  readonly ownership: "picc-owned"; readonly name: string; readonly profileKey: LifecycleProfileKey;
  readonly source: MarketplaceRegistrationSource; readonly selectedSnapshotId: `marketplace-${string}`;
}
export type OwnedMarketplaceRecord = OwnedMarketplaceRecordBase & (
  | { readonly scope: "user"; readonly checkoutFamilyKey?: never; readonly projectKey?: never }
  | { readonly scope: "project" | "local"; readonly checkoutFamilyKey: CheckoutFamilyKey; readonly projectKey: CheckoutFamilyKey }
);
export interface CatalogOnlyMarketplaceSnapshotTrustTarget {
  readonly authorityKind: "catalog-only"; readonly marketplaceName: string; readonly snapshotId: `marketplace-${string}`;
  readonly source: Extract<MarketplaceRegistrationSource, { readonly kind: "https-catalog" }>; readonly catalogDigest: Sha256;
  readonly provenance: Readonly<{ readonly adapter: "public-https-catalog"; readonly canonicalUrl: string }>;
}
export interface MaterializedMarketplaceSnapshotTrustTarget {
  readonly authorityKind: "materialized"; readonly marketplaceName: string; readonly snapshotId: `marketplace-${string}`;
  readonly source: Exclude<MarketplaceRegistrationSource, { readonly kind: "https-catalog" }>; readonly catalogDigest: Sha256;
  readonly artifactDigest: Sha256; readonly treeDigest: Sha256; readonly rootDigest: Sha256;
  readonly selectedRoot: PluginRootSelection; readonly artifactRoot: string; readonly installRoot: string; readonly catalogRelativePath: string;
  readonly provenance: Readonly<
    | { readonly adapter: "local-directory-snapshot" | "local-catalog-snapshot"; readonly artifactDigest: Sha256 }
    | { readonly adapter: "anonymous-https-git"; readonly commit: string; readonly artifactDigest: Sha256 }
  >;
}
export type MarketplaceSnapshotTrustTarget = CatalogOnlyMarketplaceSnapshotTrustTarget | MaterializedMarketplaceSnapshotTrustTarget;
export interface MarketplaceSnapshotTrustGrant { readonly kind: "marketplace-snapshot-trust"; readonly target: MarketplaceSnapshotTrustTarget; readonly targetDigest: Sha256 }
interface OwnedMarketplaceSnapshotRecordBase { readonly ownership: "picc-owned"; readonly profileKey: LifecycleProfileKey; readonly trust: MarketplaceSnapshotTrustGrant }
export type OwnedMarketplaceSnapshotRecord = OwnedMarketplaceSnapshotRecordBase & MarketplaceSnapshotTrustTarget;
export type MarketplaceSnapshotAuthority = OwnedMarketplaceSnapshotRecord;

const admittedMarketplaceSnapshots = new WeakMap<OwnedMarketplaceSnapshotRecord, OwnedStateStore>();

export function ownedInstallationScopeKey(record: Pick<OwnedPluginInstallationRecord, "scope" | "profileKey" | "projectKey">): string { return record.scope === "user" ? `user-${record.profileKey}` : `${record.scope}-${record.projectKey ?? "invalid"}`; }
function partitionSegment(value: string): string { return `${Buffer.byteLength(value, "utf8")}-${value}`; }
function partitionIdentity(parts: readonly string[]): string { return sha256(Buffer.from(parts.map(partitionSegment).join(""), "utf8")).slice("sha256:".length); }
export function ownedMarketplaceScopeKey(record: Pick<OwnedMarketplaceRecord, "profileKey" | "scope" | "checkoutFamilyKey" | "projectKey" | "name">): string { return `marketplace-${partitionIdentity([record.profileKey, record.scope, record.checkoutFamilyKey ?? "", record.projectKey ?? "", record.name])}`; }
export function ownedMarketplaceSnapshotScopeKey(record: Pick<OwnedMarketplaceSnapshotRecord, "profileKey" | "marketplaceName" | "snapshotId" | "source">): string { return `marketplace-snapshot-${partitionIdentity([record.profileKey, record.marketplaceName, record.snapshotId, JSON.stringify(record.source)])}`; }
export interface AdmissionContext { readonly profileKey: LifecycleProfileKey; readonly artifactsRoot: string; readonly marketplaceSnapshots?: Readonly<Record<string, readonly MarketplaceSnapshotAuthority[]>> }
export interface MarketplaceSnapshotCodecContext { readonly profileKey: LifecycleProfileKey; readonly artifactsRoot: string }

function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0; }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> { if (!plain(value)) return false; const keys = Object.keys(value); return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key)); }
function digest(value: unknown): value is Sha256 { return typeof value === "string" && DIGEST.test(value); }
function safeIdentity(value: unknown): value is QualifiedPluginIdentity { return typeof value === "string" && isQualifiedPluginId(value); }
function safeProjectKey(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0"); }
function portableRootPath(value: unknown): value is string { return typeof value === "string" && value.length <= 1024 && (value === "" || normalizePortableRelativePath(value) === value); }
function decodeRootSelection(value: unknown): PersistedSelectedRoot | undefined {
  if (!exact(value, ["requested", "path", "usedSingleWrapper"]) || !portableRootPath(value.path) || typeof value.usedSingleWrapper !== "boolean") return undefined;
  if (value.requested === "package/") return value.path === "" && value.usedSingleWrapper === true ? value as unknown as PersistedSelectedRoot : undefined;
  return value.requested === "tree-root" || value.requested === "relative-subtree" || value.requested === "root-or-single-wrapper" ? value as unknown as PersistedSelectedRoot : undefined;
}
function pluginMarketplace(pluginId: string): string { return pluginId.slice(pluginId.lastIndexOf("@") + 1); }

function marketplaceSource(value: unknown): MarketplaceRegistrationSource | undefined {
  if (!plain(value)) return undefined;
  const raw = value.kind === "local-directory" ? { source: "directory", path: value.path } : value.kind === "local-catalog-file" ? { source: "file", path: value.path }
    : value.kind === "github" ? { source: "github", repo: value.repository, ...(value.ref === undefined ? {} : { ref: value.ref }) }
    : value.kind === "https-git" ? { source: "git", url: value.url, ...(value.ref === undefined ? {} : { ref: value.ref }) }
    : value.kind === "https-catalog" ? { source: "url", url: value.url } : undefined;
  if (raw === undefined) return undefined; const routed = routeMarketplaceSource(raw);
  return routed.ok && JSON.stringify(routed.value.descriptor) === JSON.stringify(value) ? routed.value.descriptor : undefined;
}
function gitDeclaration(value: unknown): Extract<CatalogPluginSource, { readonly kind: "github" | "https-git" | "https-git-subdir" }> | undefined {
  if (!plain(value)) return undefined; const source = value.kind === "github" ? "github" : value.kind === "https-git-subdir" ? "git-subdir" : "url";
  const raw = source === "github" ? { source, repo: value.repository, ...(value.ref === undefined ? {} : { ref: value.ref }), ...(value.sha === undefined ? {} : { sha: value.sha }) }
    : { source, url: value.url, ...(value.path === undefined ? {} : { path: value.path }), ...(value.ref === undefined ? {} : { ref: value.ref }), ...(value.sha === undefined ? {} : { sha: value.sha }) };
  const routed = routeCatalogPluginSource(raw, { marketplaceSourceKind: "local-directory" });
  return routed.ok && JSON.stringify(routed.value.descriptor) === JSON.stringify(value) && ["github", "https-git", "https-git-subdir"].includes(routed.value.descriptor.kind) ? routed.value.descriptor as ReturnType<typeof gitDeclaration> : undefined;
}
function decodeSource(value: unknown): PersistedPluginSource | undefined {
  if (!plain(value) || typeof value.marketplaceName !== "string" || !MARKETPLACE.test(value.marketplaceName) || typeof value.marketplaceSnapshotId !== "string" || !SNAPSHOT.test(value.marketplaceSnapshotId) || !digest(value.catalogDigest)) return undefined;
  const common = ["marketplaceName", "marketplaceSnapshotId", "catalogDigest"];
  if (value.kind === "marketplace-relative" && exact(value, ["kind", ...common, "path"], ["pluginRoot"])) {
    const routed = routeCatalogPluginSource(value.pluginRoot === undefined ? `./${String(value.path)}` : String(value.path), { marketplaceSourceKind: "local-directory", ...(value.pluginRoot === undefined ? {} : { metadataPluginRoot: String(value.pluginRoot) }) });
    return routed.ok && routed.value.descriptor.kind === "relative" && routed.value.descriptor.path === value.path && routed.value.descriptor.pluginRoot === value.pluginRoot ? value as unknown as PersistedPluginSource : undefined;
  }
  if (value.kind === "git" && exact(value, ["kind", ...common, "declaration", "commit"])) { const declaration = gitDeclaration(value.declaration); return declaration !== undefined && typeof value.commit === "string" && /^[a-f0-9]{40}$/.test(value.commit) && (!("sha" in declaration) || declaration.sha === undefined || declaration.sha === value.commit) ? value as unknown as PersistedPluginSource : undefined; }
  if (value.kind === "npm" && exact(value, ["kind", ...common, "package", "version", "integrity", "registry"])) { const routed = routeCatalogPluginSource({ source: "npm", package: value.package, version: value.version, registry: value.registry }, { marketplaceSourceKind: "local-directory" }); return routed.ok && routed.value.descriptor.kind === "npm" && routed.value.descriptor.package === value.package && typeof value.version === "string" && semver.valid(value.version) === value.version && value.registry === "https://registry.npmjs.org" && typeof value.integrity === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/.test(value.integrity) ? value as unknown as PersistedPluginSource : undefined; }
  if (value.kind === "zip" && exact(value, ["kind", ...common, "url", "zipDigest"])) { const routed = routeCatalogPluginSource({ source: "archive", url: value.url, sha256: typeof value.zipDigest === "string" ? value.zipDigest.slice(7) : value.zipDigest }, { marketplaceSourceKind: "local-directory" }); return routed.ok && routed.value.descriptor.kind === "https-zip" && digest(value.zipDigest) ? value as unknown as PersistedPluginSource : undefined; }
  return undefined;
}
function decodeTrust(value: unknown): ExecutableTrustGrant | undefined { return exact(value, ["target", "artifactDigest", "treeDigest", "rootDigest", "executableDigest", "selectedRoot", "allowedCrossMarketplaceDependencies"]) && safeIdentity(value.target) && digest(value.artifactDigest) && digest(value.treeDigest) && digest(value.rootDigest) && digest(value.executableDigest) && decodeRootSelection(value.selectedRoot) !== undefined && Array.isArray(value.allowedCrossMarketplaceDependencies) ? value as unknown as ExecutableTrustGrant : undefined; }
function validScope(payload: Record<string, unknown>): boolean { return payload.scope === "user" ? payload.checkoutFamilyKey === undefined && payload.projectKey === undefined : (payload.scope === "project" || payload.scope === "local") && safeProjectKey(payload.checkoutFamilyKey) && CHECKOUT.test(payload.checkoutFamilyKey) && payload.projectKey === payload.checkoutFamilyKey; }

export function createOwnedPluginInstallationCodec(context: AdmissionContext): ProducerCodec<OwnedPluginInstallationRecord> {
  return Object.freeze({ schema: "plugin-installation", version: 1, decode: (payload: unknown) => {
    if (!exact(payload, ["ownership", "pluginId", "scope", "profileKey", "version", "source", "artifactDigest", "treeDigest", "rootDigest", "executableDigest", "selectedRoot", "installRoot", "dataIdentity", "executableGenerationId", "trust", "allowedCrossMarketplaceDependencies"], ["checkoutFamilyKey", "projectKey", "marketplaceDefaultEnabled"])) return fail("invalid-admission", "Owned installation payload has an inexact shape");
    const source = decodeSource(payload.source); const trust = decodeTrust(payload.trust); const data = exact(payload.dataIdentity, ["profileKey", "identity"]) ? payload.dataIdentity : undefined;
    const allow = payload.allowedCrossMarketplaceDependencies; const validAllow = Array.isArray(allow) && allow.length <= 128 && allow.every((item) => typeof item === "string" && MARKETPLACE.test(item)) && allow.every((item, i) => i === 0 || allow[i - 1]! < item);
    const selectedRoot = decodeRootSelection(payload.selectedRoot);
    const artifactRoot = digest(payload.treeDigest) ? path.join(path.resolve(context.artifactsRoot), payload.treeDigest.slice(7)) : "";
    const expectedRoot = selectedRoot === undefined ? "" : path.join(artifactRoot, ...selectedRoot.path.split("/"));
    const snapshots = source === undefined ? [] : context.marketplaceSnapshots?.[source.marketplaceSnapshotId] ?? [];
    const catalogAuthorities = source === undefined || source.marketplaceName !== pluginMarketplace(String(payload.pluginId)) ? [] : snapshots.filter((snapshot) => snapshot.snapshotId === source.marketplaceSnapshotId && snapshot.marketplaceName === source.marketplaceName && snapshot.catalogDigest === source.catalogDigest);
    const catalogRelationship = catalogAuthorities.length > 0;
    const relativePath = source?.kind === "marketplace-relative" ? [source.pluginRoot, source.path].filter((item): item is string => item !== undefined && item !== "").join("/") : "";
    const snapshotDeclarationRelationship = source !== undefined && catalogAuthorities.every((snapshot) => snapshot.authorityKind === "catalog-only" || verifyMaterializedMarketplaceCatalog(snapshot, context.artifactsRoot, { pluginId: String(payload.pluginId), source }));
    const relativeSnapshotRelationship = source?.kind !== "marketplace-relative" || catalogAuthorities.length > 0 && catalogAuthorities.every((snapshot) => snapshot.authorityKind === "materialized" && snapshot.artifactDigest === payload.artifactDigest && snapshot.treeDigest === payload.treeDigest);
    const selectionRelationship = source?.kind === "marketplace-relative" ? selectedRoot?.requested === "relative-subtree" && selectedRoot.path === relativePath && !selectedRoot.usedSingleWrapper
      : source?.kind === "git" ? selectedRoot?.requested === "tree-root" && selectedRoot.path === "" && !selectedRoot.usedSingleWrapper
      : source?.kind === "npm" ? selectedRoot?.requested === "package/" && selectedRoot.path === "" && selectedRoot.usedSingleWrapper
      : source?.kind === "zip" ? selectedRoot?.requested === "root-or-single-wrapper" && ((selectedRoot.path === "" && !selectedRoot.usedSingleWrapper) || (selectedRoot.usedSingleWrapper && selectedRoot.path.length > 0 && !selectedRoot.path.includes("/"))) : false;
    const sourceRelationship = source?.kind === "npm" ? source.version === payload.version : source?.kind === "zip" ? source.zipDigest === payload.artifactDigest : source?.kind === "git" || source?.kind === "marketplace-relative" ? payload.artifactDigest === payload.treeDigest : false;
    const versionRelationship = typeof payload.version === "string" && (source?.kind === "npm" ? semver.valid(payload.version) === payload.version : VERSION.test(payload.version));
    if (payload.ownership !== "picc-owned" || !safeIdentity(payload.pluginId) || payload.profileKey !== context.profileKey || !PROFILE.test(String(payload.profileKey)) || !validScope(payload) || !versionRelationship || source === undefined || !catalogRelationship || !snapshotDeclarationRelationship || !relativeSnapshotRelationship || !selectionRelationship || !sourceRelationship || !digest(payload.artifactDigest) || !digest(payload.treeDigest) || !digest(payload.rootDigest) || !digest(payload.executableDigest) || selectedRoot === undefined || typeof payload.installRoot !== "string" || !path.isAbsolute(payload.installRoot) || path.resolve(payload.installRoot) !== path.resolve(expectedRoot) || trust === undefined || trust.target !== payload.pluginId || trust.artifactDigest !== payload.artifactDigest || trust.treeDigest !== payload.treeDigest || trust.rootDigest !== payload.rootDigest || trust.executableDigest !== payload.executableDigest || JSON.stringify(trust.selectedRoot) !== JSON.stringify(selectedRoot) || JSON.stringify(trust.allowedCrossMarketplaceDependencies) !== JSON.stringify(allow) || !data || data.profileKey !== payload.profileKey || data.identity !== payload.pluginId || typeof payload.executableGenerationId !== "string" || !GENERATION.test(payload.executableGenerationId) || !validAllow || (payload.marketplaceDefaultEnabled !== undefined && typeof payload.marketplaceDefaultEnabled !== "boolean")) return fail("invalid-admission", "Owned installation authority or relationship is invalid");
    return { ok: true as const, value: Object.freeze(payload as unknown as OwnedPluginInstallationRecord) };
  } });
}
function memberIdentity(member: ExecutableAdmissionGenerationMember): string { return member.scope === "user" ? `${member.pluginId}\0user` : `${member.pluginId}\0${member.scope}\0${member.checkoutFamilyKey}\0${member.projectKey}`; }
export function createExecutableAdmissionGenerationCodec(profileKey: LifecycleProfileKey): ProducerCodec<ExecutableAdmissionGeneration> {
  return Object.freeze({ schema: "executable-admission-generation", version: 1, decode: (payload: unknown) => {
    if (!exact(payload, ["ownership", "profileKey", "generationId", "members"]) || payload.ownership !== "picc-owned" || payload.profileKey !== profileKey || !Array.isArray(payload.members) || payload.members.length > 1024 || typeof payload.generationId !== "string" || !GENERATION.test(payload.generationId)) return fail("invalid-generation", "Executable admission generation is invalid");
    const seen = new Set<string>(); for (const raw of payload.members) { if (!exact(raw, ["pluginId", "scope", "recordDigest"], ["checkoutFamilyKey", "projectKey"]) || !safeIdentity(raw.pluginId) || !digest(raw.recordDigest) || !validScope(raw)) return fail("invalid-generation", "Executable admission membership is invalid"); const key = memberIdentity(raw as unknown as ExecutableAdmissionGenerationMember); if (seen.has(key)) return fail("invalid-generation", "Executable admission membership is duplicated"); seen.add(key); }
    return { ok: true as const, value: Object.freeze(payload as unknown as ExecutableAdmissionGeneration) };
  } });
}
export function createOwnedMarketplaceCodec(profileKey: LifecycleProfileKey): ProducerCodec<OwnedMarketplaceRecord> {
  return Object.freeze({ schema: "marketplace-registration", version: 1, decode: (payload: unknown): StoreResult<OwnedMarketplaceRecord> => {
    if (!exact(payload, ["ownership", "name", "profileKey", "scope", "source", "selectedSnapshotId"], ["checkoutFamilyKey", "projectKey"])) return fail("invalid-marketplace", "Owned marketplace registration is invalid");
    const source = marketplaceSource(payload.source);
    return payload.ownership === "picc-owned" && payload.profileKey === profileKey && PROFILE.test(String(payload.profileKey)) && typeof payload.name === "string" && MARKETPLACE.test(payload.name) && validScope(payload) && source !== undefined && typeof payload.selectedSnapshotId === "string" && SNAPSHOT.test(payload.selectedSnapshotId)
      ? { ok: true, value: Object.freeze(payload as unknown as OwnedMarketplaceRecord) } : fail("invalid-marketplace", "Owned marketplace registration is invalid");
  } });
}
function sameCanonical(left: unknown, right: unknown): boolean { const leftBytes = canonicalJsonBytes(left); const rightBytes = canonicalJsonBytes(right); return leftBytes.ok && rightBytes.ok && Buffer.from(leftBytes.value).equals(Buffer.from(rightBytes.value)); }
function snapshotTargetDigest(target: MarketplaceSnapshotTrustTarget): Sha256 | undefined { const bytes = canonicalJsonBytes(target); return bytes.ok ? sha256(bytes.value) : undefined; }
export function createMarketplaceSnapshotTrustGrant(target: MarketplaceSnapshotTrustTarget): StoreResult<MarketplaceSnapshotTrustGrant> { const targetDigest = snapshotTargetDigest(target); return targetDigest === undefined ? fail("invalid-marketplace-trust", "Marketplace snapshot trust target is not canonical") : { ok: true, value: Object.freeze({ kind: "marketplace-snapshot-trust", target, targetDigest }) }; }
function validSnapshotTrust(value: unknown, target: MarketplaceSnapshotTrustTarget): value is MarketplaceSnapshotTrustGrant {
  if (!exact(value, ["kind", "target", "targetDigest"]) || value.kind !== "marketplace-snapshot-trust" || !digest(value.targetDigest) || !sameCanonical(value.target, target)) return false;
  return snapshotTargetDigest(target) === value.targetDigest;
}
function catalogOnlyTarget(payload: Record<string, unknown>, source: MarketplaceRegistrationSource): CatalogOnlyMarketplaceSnapshotTrustTarget | undefined {
  if (source.kind !== "https-catalog" || !exact(payload, ["ownership", "profileKey", "authorityKind", "marketplaceName", "snapshotId", "source", "catalogDigest", "provenance", "trust"]) || !exact(payload.provenance, ["adapter", "canonicalUrl"]) || payload.provenance.adapter !== "public-https-catalog" || typeof payload.provenance.canonicalUrl !== "string") return undefined;
  let canonicalUrl: URL; try { canonicalUrl = new URL(payload.provenance.canonicalUrl); } catch { return undefined; }
  const routedFinal = routeMarketplaceSource({ source: "url", url: payload.provenance.canonicalUrl });
  let declaredUrl: URL; try { declaredUrl = new URL(source.url); } catch { return undefined; }
  const declaredPort = declaredUrl.port === "" ? 443 : Number(declaredUrl.port); const finalPort = canonicalUrl.port === "" ? 443 : Number(canonicalUrl.port);
  if (!routedFinal.ok || routedFinal.value.descriptor.kind !== "https-catalog" || routedFinal.value.descriptor.url !== payload.provenance.canonicalUrl
    || canonicalUrl.toString() !== payload.provenance.canonicalUrl || declaredPort !== 443 && declaredPort !== 8443 || finalPort !== 443 && finalPort !== 8443
    || payload.snapshotId !== `marketplace-${createHash("sha256").update(`${payload.catalogDigest}\0${payload.provenance.canonicalUrl}`).digest("base64url")}`) return undefined;
  return Object.freeze({ authorityKind: "catalog-only", marketplaceName: payload.marketplaceName, snapshotId: payload.snapshotId, source, catalogDigest: payload.catalogDigest, provenance: payload.provenance }) as CatalogOnlyMarketplaceSnapshotTrustTarget;
}
function materializedTarget(payload: Record<string, unknown>, source: MarketplaceRegistrationSource, artifactsRoot: string): MaterializedMarketplaceSnapshotTrustTarget | undefined {
  if (source.kind === "https-catalog" || !exact(payload, ["ownership", "profileKey", "authorityKind", "marketplaceName", "snapshotId", "source", "catalogDigest", "artifactDigest", "treeDigest", "rootDigest", "selectedRoot", "artifactRoot", "installRoot", "catalogRelativePath", "provenance", "trust"])) return undefined;
  const selectedRoot = decodeRootSelection(payload.selectedRoot); const expectedArtifactRoot = digest(payload.treeDigest) ? path.join(path.resolve(artifactsRoot), payload.treeDigest.slice(7)) : "";
  const expectedCatalogPath = source.kind === "local-catalog-file" ? path.basename(source.path) : ".claude-plugin/marketplace.json";
  const localAdapter = source.kind === "local-directory" ? "local-directory-snapshot" : source.kind === "local-catalog-file" ? "local-catalog-snapshot" : undefined; const provenance = plain(payload.provenance) ? payload.provenance : {};
  const localProvenance = localAdapter !== undefined && exact(provenance, ["adapter", "artifactDigest"]) && provenance.adapter === localAdapter && provenance.artifactDigest === payload.artifactDigest;
  const gitProvenance = (source.kind === "github" || source.kind === "https-git") && exact(provenance, ["adapter", "commit", "artifactDigest"]) && provenance.adapter === "anonymous-https-git" && typeof provenance.commit === "string" && /^[a-f0-9]{40}$/.test(provenance.commit) && provenance.artifactDigest === payload.artifactDigest;
  const identitySeed = gitProvenance ? `${String(provenance.commit)}\0${payload.catalogDigest}\0${payload.treeDigest}` : `${payload.catalogDigest}\0${payload.treeDigest}`; const expectedSnapshotId = `marketplace-${createHash("sha256").update(identitySeed).digest("base64url")}`;
  if (!digest(payload.artifactDigest) || !digest(payload.treeDigest) || !digest(payload.rootDigest) || payload.snapshotId !== expectedSnapshotId || payload.artifactDigest !== payload.treeDigest || payload.rootDigest !== payload.treeDigest || selectedRoot?.requested !== "tree-root" || selectedRoot.path !== "" || selectedRoot.usedSingleWrapper || typeof payload.artifactRoot !== "string" || !path.isAbsolute(payload.artifactRoot) || !samePath(path.resolve(payload.artifactRoot), expectedArtifactRoot) || typeof payload.installRoot !== "string" || !samePath(path.resolve(payload.installRoot), expectedArtifactRoot) || typeof payload.catalogRelativePath !== "string" || payload.catalogRelativePath === "" || normalizePortableRelativePath(payload.catalogRelativePath) !== payload.catalogRelativePath || payload.catalogRelativePath !== expectedCatalogPath || (!localProvenance && !gitProvenance)) return undefined;
  const catalogPath = path.resolve(expectedArtifactRoot, ...payload.catalogRelativePath.split("/")); if (!isContainedPath(expectedArtifactRoot, catalogPath) || samePath(expectedArtifactRoot, catalogPath)) return undefined;
  return Object.freeze({ authorityKind: "materialized", marketplaceName: payload.marketplaceName, snapshotId: payload.snapshotId, source, catalogDigest: payload.catalogDigest, artifactDigest: payload.artifactDigest, treeDigest: payload.treeDigest, rootDigest: payload.rootDigest, selectedRoot: payload.selectedRoot, artifactRoot: payload.artifactRoot, installRoot: payload.installRoot, catalogRelativePath: payload.catalogRelativePath, provenance: payload.provenance }) as MaterializedMarketplaceSnapshotTrustTarget;
}
export function createOwnedMarketplaceSnapshotCodec(context: MarketplaceSnapshotCodecContext): ProducerCodec<OwnedMarketplaceSnapshotRecord> {
  return Object.freeze({ schema: "marketplace-catalog-snapshot", version: 1, decode: (payload: unknown): StoreResult<OwnedMarketplaceSnapshotRecord> => {
    if (!plain(payload)) return fail("invalid-marketplace-snapshot", "Owned marketplace snapshot is invalid");
    const source = marketplaceSource(payload.source);
    if (payload.ownership !== "picc-owned" || payload.profileKey !== context.profileKey || !PROFILE.test(String(payload.profileKey)) || payload.authorityKind !== "catalog-only" && payload.authorityKind !== "materialized" || typeof payload.marketplaceName !== "string" || !MARKETPLACE.test(payload.marketplaceName) || typeof payload.snapshotId !== "string" || !SNAPSHOT.test(payload.snapshotId) || !digest(payload.catalogDigest) || source === undefined) return fail("invalid-marketplace-snapshot", "Owned marketplace snapshot is invalid");
    const target = payload.authorityKind === "catalog-only" ? catalogOnlyTarget(payload, source) : materializedTarget(payload, source, context.artifactsRoot);
    return target !== undefined && validSnapshotTrust(payload.trust, target) ? { ok: true, value: Object.freeze(payload as unknown as OwnedMarketplaceSnapshotRecord) } : fail("invalid-marketplace-snapshot", "Marketplace snapshot authority or trust is unbound");
  } });
}

function samePath(left: string, right: string): boolean { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function ordinaryCanonicalDirectory(candidate: string): boolean { try { const stat = fs.lstatSync(candidate); return stat.isDirectory() && !stat.isSymbolicLink() && samePath(fs.realpathSync.native(candidate), path.resolve(candidate)); } catch { return false; } }
interface OpenedOrdinaryFile { readonly bytes: Buffer; readonly stat: fs.BigIntStats }
function readOpenedOrdinaryFile(candidate: string, limit: number): OpenedOrdinaryFile {
  const resolved = path.resolve(candidate); const handle = fs.openSync(resolved, fs.constants.O_RDONLY);
  try {
    const stat = fs.fstatSync(handle, { bigint: true });
    const pathname = fs.lstatSync(resolved, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !pathname.isFile() || pathname.isSymbolicLink() || pathname.dev !== stat.dev || pathname.ino !== stat.ino || !samePath(fs.realpathSync.native(resolved), resolved)) throw new Error("nonordinary");
    const chunks: Buffer[] = []; let total = 0;
    while (total <= limit) { const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total)); const count = fs.readSync(handle, chunk, 0, chunk.length, null); if (count === 0) break; chunks.push(chunk.subarray(0, count)); total += count; }
    const after = fs.lstatSync(resolved, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || !after.isFile() || after.isSymbolicLink() || !samePath(fs.realpathSync.native(resolved), resolved) || total > limit) throw new Error("changed-or-over-limit");
    return { bytes: Buffer.concat(chunks, total), stat };
  } finally { fs.closeSync(handle); }
}
function boundedDirectoryNames(directory: string, maximum: number, count: { value: number }): string[] {
  const names: string[] = []; const opened = fs.opendirSync(directory);
  try { for (let entry = opened.readSync(); entry !== null; entry = opened.readSync()) { count.value += 1; if (count.value > maximum) throw new Error("entries"); names.push(entry.name); } }
  finally { opened.closeSync(); }
  return names.sort();
}
interface ExecutableCatalogDeclaration { readonly index: number; readonly name: string; readonly source: CatalogPluginSource; readonly defaultEnabled?: boolean }
interface ExecutableCatalogProjection { readonly name: string; readonly pluginRoot?: string; readonly declarations: readonly ExecutableCatalogDeclaration[] }
function decodeExecutableMarketplaceCatalog(bytes: Uint8Array, sourceKind: MarketplaceRegistrationSource["kind"]): ExecutableCatalogProjection | undefined {
  let parsed: unknown; try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return undefined; }
  if (!plain(parsed) || typeof parsed.name !== "string" || !MARKETPLACE.test(parsed.name) || !Array.isArray(parsed.plugins) || parsed.plugins.length > 1024) return undefined;
  const metadata = plain(parsed.metadata) ? parsed.metadata : undefined; const pluginRoot = metadata?.pluginRoot;
  if (pluginRoot !== undefined && (typeof pluginRoot !== "string" || normalizePortableRelativePath(pluginRoot) !== pluginRoot)) return undefined;
  const declarations: ExecutableCatalogDeclaration[] = [];
  for (const [index, value] of parsed.plugins.entries()) {
    if (!plain(value) || typeof value.name !== "string" || !MARKETPLACE.test(value.name)) continue;
    const routed = routeCatalogPluginSource(value.source, { marketplaceSourceKind: sourceKind, ...(pluginRoot === undefined ? {} : { metadataPluginRoot: pluginRoot }) });
    if (!routed.ok) continue;
    if (value.defaultEnabled !== undefined && typeof value.defaultEnabled !== "boolean") continue;
    declarations.push(Object.freeze({ index, name: value.name, source: routed.value.descriptor, ...(value.defaultEnabled === undefined ? {} : { defaultEnabled: value.defaultEnabled }) }));
  }
  return Object.freeze({ name: parsed.name, ...(pluginRoot === undefined ? {} : { pluginRoot }), declarations: Object.freeze(declarations) });
}
function readPersistedTree(artifactRoot: string): readonly ArtifactDigestEntry[] {
  if (!ordinaryCanonicalDirectory(artifactRoot)) throw new Error("artifact-root");
  const entries: ArtifactDigestEntry[] = []; const count = { value: 0 }; let total = 0;
  const walk = (directory: string, relative: string, depth: number): void => { if (depth > PORTABLE_TREE_LIMITS.maximumDepth) throw new Error("depth"); const names = boundedDirectoryNames(directory, PORTABLE_TREE_LIMITS.maximumEntries, count); for (const name of names) { const child = path.join(directory, name); const childRelative = relative === "" ? name : `${relative}/${name}`; if (Buffer.byteLength(childRelative, "utf8") > PORTABLE_TREE_LIMITS.maximumPathBytes) throw new Error("path"); const stat = fs.lstatSync(child); if (stat.isSymbolicLink() || !samePath(fs.realpathSync.native(child), path.resolve(child))) throw new Error("alias"); if (stat.isDirectory()) { entries.push({ path: childRelative, kind: "directory" }); walk(child, childRelative, depth + 1); } else if (stat.isFile()) { const opened = readOpenedOrdinaryFile(child, PORTABLE_TREE_LIMITS.maximumFileBytes); if ((total += opened.bytes.length) > PORTABLE_TREE_LIMITS.maximumTotalBytes) throw new Error("bytes"); entries.push({ path: childRelative, kind: "file", executable: process.platform !== "win32" && (opened.stat.mode & 0o111n) !== 0n, data: opened.bytes }); } else throw new Error("special"); } };
  walk(artifactRoot, "", 0); return Object.freeze(entries);
}
function verifyMaterializedMarketplaceCatalog(snapshot: MaterializedMarketplaceSnapshotTrustTarget, artifactsRoot: string, installation?: { readonly pluginId: string; readonly source: PersistedPluginSource }): boolean {
  try {
    const root = path.resolve(artifactsRoot); const artifactRoot = path.join(root, snapshot.treeDigest.slice(7));
    if (!ordinaryCanonicalDirectory(root) || !ordinaryCanonicalDirectory(artifactRoot) || !samePath(path.resolve(snapshot.artifactRoot), artifactRoot) || !samePath(path.resolve(snapshot.installRoot), artifactRoot)) return false;
    const catalogPath = path.join(artifactRoot, ...snapshot.catalogRelativePath.split("/")); const catalog = readOpenedOrdinaryFile(catalogPath, MAX_RECORD_BYTES).bytes;
    let basic: unknown; try { basic = JSON.parse(catalog.toString("utf8")); } catch { return false; }
    if (!plain(basic) || basic.name !== snapshot.marketplaceName || !Array.isArray(basic.plugins) || basic.plugins.length > 1024 || sha256(catalog) !== snapshot.catalogDigest) return false;
    if (installation === undefined) return true;
    const projection = decodeExecutableMarketplaceCatalog(catalog, snapshot.source.kind); if (projection === undefined) return false;
    const pluginName = installation.pluginId.slice(0, installation.pluginId.lastIndexOf("@"));
    return projection.declarations.filter((item) => {
      if (item.name !== pluginName) return false;
      const source = installation.source;
      if (source.kind === "marketplace-relative") return item.source.kind === "relative" && item.source.path === source.path && item.source.pluginRoot === source.pluginRoot;
      if (source.kind === "git") return JSON.stringify(item.source) === JSON.stringify(source.declaration);
      if (source.kind === "npm") return item.source.kind === "npm" && item.source.package === source.package && item.source.registry === source.registry;
      return item.source.kind === "https-zip" && item.source.url === source.url && (item.source.sha256 === undefined || `sha256:${item.source.sha256}` === source.zipDigest);
    }).length === 1;
  } catch { return false; }
}
function verifyMaterializedMarketplaceSnapshot(snapshot: MaterializedMarketplaceSnapshotTrustTarget, artifactsRoot: string): boolean {
  try {
    const artifactRoot = path.join(path.resolve(artifactsRoot), snapshot.treeDigest.slice(7)); const entries = readPersistedTree(artifactRoot);
    return digestArtifactEntries(entries) === snapshot.treeDigest && snapshot.artifactDigest === snapshot.treeDigest && snapshot.rootDigest === snapshot.treeDigest
      && verifyMaterializedMarketplaceCatalog(snapshot, artifactsRoot);
  } catch { return false; }
}
function verifyPersistedTree(record: OwnedPluginInstallationRecord, artifactsRoot: string): boolean {
  try {
    const root = path.resolve(artifactsRoot); const artifactRoot = path.join(root, record.treeDigest.slice(7)); const installRoot = path.resolve(record.installRoot);
    if (!ordinaryCanonicalDirectory(root) || !ordinaryCanonicalDirectory(installRoot) || !samePath(installRoot, path.join(artifactRoot, ...record.selectedRoot.path.split("/"))) || !isContainedPath(artifactRoot, installRoot)) return false;
    const entries = readPersistedTree(artifactRoot); return digestArtifactEntries(entries) === record.treeDigest && digestArtifactEntries(entries, record.selectedRoot.path) === record.rootDigest;
  } catch { return false; }
}
export interface AdmittedOwnedInstallation { readonly record: OwnedPluginInstallationRecord; readonly recordDigest: Sha256 }
interface AdmittedInstallationEvidence { readonly recordPath: string; readonly recordBytesDigest: Sha256 }
const admittedInstallationEvidence = new WeakMap<AdmittedOwnedInstallation, AdmittedInstallationEvidence>();
export function getAdmittedInstallationEvidence(installation: AdmittedOwnedInstallation): AdmittedInstallationEvidence | undefined { return admittedInstallationEvidence.get(installation); }
export interface OwnedDataRetirementInstallationEvidence {
  readonly recordPath: string;
  readonly recordBytesDigest: Sha256;
  readonly recordEnvelopeBase64: string;
}
export interface OwnedDataRetirementProducerEvidence {
  readonly kind: "owned-data-retirement-authority";
  readonly version: 1;
  readonly predecessorGeneration: ExecutableAdmissionGeneration;
  readonly successorGeneration: ExecutableAdmissionGeneration;
  readonly selectedRecordPath: string;
  readonly installations: readonly OwnedDataRetirementInstallationEvidence[];
}
export interface ReloadableOwnedDataRetirementRecordEvidence {
  readonly targetPath: string;
  readonly targetDigest: Sha256;
  readonly backupPath: string;
  readonly backupDigest: Sha256;
  readonly scopeKey: string;
}
export interface ReconstructedOwnedDataRetirementInstallation {
  readonly installation: OwnedPluginInstallationRecord;
  readonly recordDigest: Sha256;
  readonly recordPath: string;
  readonly recordBytesDigest: Sha256;
  readonly recordBytes: Buffer;
}
function retirementAdmissionRegistry(store: OwnedStateStore): StoreResult<ProducerCodecRegistry> {
  const profileKey = store.profileKey as LifecycleProfileKey;
  const snapshotRegistry = createProducerCodecRegistry([createOwnedMarketplaceCodec(profileKey), createOwnedMarketplaceSnapshotCodec({ profileKey, artifactsRoot: store.artifactsRoot })]);
  if (!snapshotRegistry.ok) return snapshotRegistry;
  const snapshots = readOwnedAdmissionRecords(store, snapshotRegistry.value, undefined).marketplaceSnapshots; const byId: Record<string, OwnedMarketplaceSnapshotRecord[]> = {};
  for (const snapshot of snapshots) (byId[snapshot.snapshotId] ??= []).push(snapshot);
  return createProducerCodecRegistry([createOwnedPluginInstallationCodec({ profileKey, artifactsRoot: store.artifactsRoot, marketplaceSnapshots: byId })]);
}
export function issueOwnedDataRetirementProducerEvidence(inputs: {
  readonly store: OwnedStateStore;
  readonly predecessor: CompleteOwnedProfileReference;
  readonly selectedInstallation: AdmittedOwnedInstallation;
  readonly successorGeneration: ExecutableAdmissionGeneration;
}): StoreResult<OwnedDataRetirementProducerEvidence> {
  const profileKey = inputs.store.profileKey as LifecycleProfileKey;
  const selectedEvidence = getAdmittedInstallationEvidence(inputs.selectedInstallation);
  const matching = inputs.predecessor.installations.filter((item) => item.record.pluginId === inputs.selectedInstallation.record.pluginId);
  const expectedMembers = inputs.predecessor.generation.members.filter((member) => !sameMember(inputs.selectedInstallation.record, member));
  const successor = createExecutableAdmissionGenerationCodec(profileKey).decode(inputs.successorGeneration);
  if (!isCompleteOwnedProfileReferenceForStore(inputs.store, inputs.predecessor) || !revalidateCompleteOwnedProfileReference(inputs.store, inputs.predecessor)
    || matching.length !== 1 || matching[0] !== inputs.selectedInstallation || selectedEvidence === undefined || !successor.ok
    || successor.value.generationId === inputs.predecessor.generation.generationId
    || inputs.selectedInstallation.record.executableGenerationId !== inputs.predecessor.generation.generationId
    || successor.value.members.length !== expectedMembers.length
    || !successor.value.members.every((member) => expectedMembers.some((expected) => memberIdentity(member) === memberIdentity(expected)))) {
    return fail("retirement-authority", "Authentic reloadable owned data retirement evidence is unavailable");
  }
  try {
    let evidenceBytes = 0; const installations = inputs.predecessor.installations.map((installation): OwnedDataRetirementInstallationEvidence => {
      const admitted = getAdmittedInstallationEvidence(installation); if (admitted === undefined) throw new Error("missing-evidence");
      const recordBytes = readOpenedOrdinaryFile(admitted.recordPath, MAX_RECORD_BYTES).bytes;
      if (sha256(recordBytes) !== admitted.recordBytesDigest || (evidenceBytes += recordBytes.byteLength) > MAX_RETIREMENT_EVIDENCE_BYTES) throw new Error("changed-envelope");
      return Object.freeze({ recordPath: admitted.recordPath, recordBytesDigest: admitted.recordBytesDigest, recordEnvelopeBase64: recordBytes.toString("base64") });
    });
    return { ok: true, value: Object.freeze({ kind: "owned-data-retirement-authority", version: 1, predecessorGeneration: inputs.predecessor.generation,
      successorGeneration: successor.value, selectedRecordPath: selectedEvidence.recordPath, installations: Object.freeze(installations) }) };
  } catch { return fail("retirement-authority", "Installation envelope evidence is unavailable"); }
}
export function reconstructOwnedDataRetirementProducerEvidence(store: OwnedStateStore, raw: unknown, recordEvidence: ReloadableOwnedDataRetirementRecordEvidence): StoreResult<{ readonly evidence: OwnedDataRetirementProducerEvidence; readonly installation: OwnedPluginInstallationRecord; readonly recordDigest: Sha256; readonly installations: readonly ReconstructedOwnedDataRetirementInstallation[]; readonly registry: ProducerCodecRegistry }> {
  const profileKey = store.profileKey as LifecycleProfileKey;
  if (!exact(raw, ["kind", "version", "predecessorGeneration", "successorGeneration", "selectedRecordPath", "installations"]) || raw.kind !== "owned-data-retirement-authority" || raw.version !== 1
    || typeof raw.selectedRecordPath !== "string" || !path.isAbsolute(raw.selectedRecordPath) || !Array.isArray(raw.installations) || raw.installations.length === 0 || raw.installations.length > 1024) return fail("retirement-authority", "Persisted owned data retirement evidence is malformed");
  const predecessor = createExecutableAdmissionGenerationCodec(profileKey).decode(raw.predecessorGeneration); const successor = createExecutableAdmissionGenerationCodec(profileKey).decode(raw.successorGeneration);
  if (!predecessor.ok || !successor.ok || predecessor.value.generationId === successor.value.generationId
    || !samePath(raw.selectedRecordPath, recordEvidence.targetPath) || recordEvidence.backupDigest !== recordEvidence.targetDigest) return fail("retirement-authority", "Persisted owned data retirement generation or record binding is invalid");
  const registry = retirementAdmissionRegistry(store); if (!registry.ok) return registry as StoreResult<never>;
  try {
    let evidenceBytes = 0; const installations: ReconstructedOwnedDataRetirementInstallation[] = [];
    for (const item of raw.installations) {
      if (!exact(item, ["recordPath", "recordBytesDigest", "recordEnvelopeBase64"]) || typeof item.recordPath !== "string" || !path.isAbsolute(item.recordPath)
        || !digest(item.recordBytesDigest) || typeof item.recordEnvelopeBase64 !== "string" || item.recordEnvelopeBase64.length > 2 * MAX_RECORD_BYTES) return fail("retirement-authority", "Persisted installation evidence is malformed");
      const bytes = Buffer.from(item.recordEnvelopeBase64, "base64");
      if (bytes.toString("base64") !== item.recordEnvelopeBase64 || bytes.byteLength > MAX_RECORD_BYTES || (evidenceBytes += bytes.byteLength) > MAX_RETIREMENT_EVIDENCE_BYTES || sha256(bytes) !== item.recordBytesDigest) return fail("retirement-authority", "Persisted installation envelope changed");
      const decoded = readRecordEnvelope(bytes, registry.value);
      if (!decoded.ok || decoded.value.envelope.schema !== "plugin-installation" || decoded.value.envelope.ownerKey !== "picc-owned") return fail("retirement-authority", "Persisted envelope is not an authentic installation");
      const installation = decoded.value.decoded as OwnedPluginInstallationRecord; const scopeKey = ownedInstallationScopeKey(installation); const partition = ownedRecordPartition(store, "picc-owned", scopeKey);
      if (!partition.ok || !isContainedPath(partition.value, item.recordPath) || decoded.value.envelope.scopeKey !== scopeKey
        || installation.executableGenerationId !== predecessor.value.generationId
        || !predecessor.value.members.some((member) => sameMember(installation, member) && member.recordDigest === decoded.value.envelope.payloadDigest)) return fail("retirement-authority", "Persisted installation is outside predecessor authority");
      installations.push({ installation, recordDigest: decoded.value.envelope.payloadDigest, recordPath: item.recordPath, recordBytesDigest: item.recordBytesDigest, recordBytes: bytes });
    }
    if (installations.length !== predecessor.value.members.length || new Set(installations.map((item) => item.recordPath.toLowerCase())).size !== installations.length
      || !predecessor.value.members.every((member) => installations.some((item) => sameMember(item.installation, member) && item.recordDigest === member.recordDigest))) return fail("retirement-authority", "Embedded predecessor installation set is incomplete");
    const selected = installations.filter((item) => samePath(item.recordPath, recordEvidence.targetPath) && item.recordBytesDigest === recordEvidence.targetDigest);
    if (selected.length !== 1 || selected[0]!.installation.pluginId === undefined || ownedInstallationScopeKey(selected[0]!.installation) !== recordEvidence.scopeKey) return fail("retirement-authority", "Selected deletion is not the exact embedded installation");
    try { const stagedBackup = readOpenedOrdinaryFile(recordEvidence.backupPath, MAX_RECORD_BYTES).bytes; if (sha256(stagedBackup) !== recordEvidence.backupDigest || !stagedBackup.equals(selected[0]!.recordBytes)) return fail("retirement-authority", "Persisted selected backup changed"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { ok: true, value: { evidence: raw as unknown as OwnedDataRetirementProducerEvidence, installation: selected[0]!.installation, recordDigest: selected[0]!.recordDigest, installations: Object.freeze(installations), registry: registry.value } };
  } catch { return fail("retirement-authority", "Persisted installation evidence is unavailable or unsafe"); }
}
export interface AdmissionRecordObservation { readonly path: string; readonly status: "admitted" | "inert"; readonly code?: string; readonly producer?: { readonly schema: string; readonly version: number; readonly ownerKey: string; readonly scopeKey: string; readonly payload: unknown } }
export interface CompleteOwnedProfileReference { readonly installations: readonly AdmittedOwnedInstallation[]; readonly generation: ExecutableAdmissionGeneration }
interface CompleteReferenceAuthority { readonly profileRoot: string; readonly profileKey: string; readonly revision: Sha256 }
const completeReferences = new WeakMap<CompleteOwnedProfileReference, CompleteReferenceAuthority>();
export function isCompleteOwnedProfileReference(value: unknown): value is CompleteOwnedProfileReference { return typeof value === "object" && value !== null && completeReferences.has(value as CompleteOwnedProfileReference); }
export interface OwnedAdmissionLoad { readonly installations: readonly AdmittedOwnedInstallation[]; readonly marketplaces: readonly OwnedMarketplaceRecord[]; readonly marketplaceSnapshots: readonly OwnedMarketplaceSnapshotRecord[]; readonly records: readonly AdmissionRecordObservation[]; readonly completeReference?: CompleteOwnedProfileReference }
function discoverRecordFiles(root: string): StoreResult<readonly string[]> { try { try { fs.lstatSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: Object.freeze([]) }; throw error; } if (!ordinaryCanonicalDirectory(root)) return fail("record-root-invalid", "Existing record root is aliased, unreadable, or unsafe"); const files: string[] = []; const discoveredEntries = { value: 0 }; const walk = (dir: string, depth: number): void => { if (depth > MAX_RECORD_DEPTH) throw new Error("depth"); for (const name of boundedDirectoryNames(dir, MAX_RECORDS, discoveredEntries)) { const child = path.join(dir, name); const stat = fs.lstatSync(child); if (stat.isSymbolicLink() || !samePath(fs.realpathSync.native(child), path.resolve(child))) throw new Error("alias"); if (stat.isDirectory()) walk(child, depth + 1); else if (stat.isFile() && name.endsWith(".json")) files.push(child); else if (!stat.isFile()) throw new Error("special"); } }; walk(root, 0); return { ok: true, value: Object.freeze(files.sort()) }; } catch { return fail("record-discovery-invalid", "Owned record discovery exceeded bounds or encountered unsafe storage"); } }
function completeReferenceRevision(store: OwnedStateStore): StoreResult<Sha256> {
  const roots = [store.recordsRoot, store.generationsRoot]; const chunks: Buffer[] = [];
  for (const root of roots) {
    const files = discoverRecordFiles(root); if (!files.ok) return files;
    for (const file of files.value) {
      try {
        const bytes = readOpenedOrdinaryFile(file, MAX_RECORD_BYTES).bytes;
        chunks.push(Buffer.from(path.relative(store.profileRoot, file), "utf8"), Buffer.from([0]), bytes, Buffer.from([0]));
      } catch { return fail("reference-stale", "Complete owned-profile storage changed or became uncertain"); }
    }
  }
  return { ok: true, value: sha256(Buffer.concat(chunks)) };
}
export function isCompleteOwnedProfileReferenceForStore(store: OwnedStateStore, reference: CompleteOwnedProfileReference): boolean {
  const authority = completeReferences.get(reference); return authority !== undefined && authority.profileKey === store.profileKey && samePath(authority.profileRoot, store.profileRoot);
}
export function revalidateCompleteOwnedProfileReference(store: OwnedStateStore, reference: CompleteOwnedProfileReference): boolean {
  if (!isCompleteOwnedProfileReferenceForStore(store, reference)) return false;
  const authority = completeReferences.get(reference)!; const revision = completeReferenceRevision(store); return revision.ok && revision.value === authority.revision;
}
function sameMember(record: OwnedPluginInstallationRecord, member: ExecutableAdmissionGenerationMember): boolean { return record.pluginId === member.pluginId && record.scope === member.scope && record.checkoutFamilyKey === member.checkoutFamilyKey && record.projectKey === member.projectKey; }
export function readOwnedAdmissionRecords(store: OwnedStateStore, registry: ProducerCodecRegistry, generation: ExecutableAdmissionGeneration | undefined): OwnedAdmissionLoad {
  const records: AdmissionRecordObservation[] = []; const candidates: Array<{ installation: AdmittedOwnedInstallation; observationIndex: number }> = []; const marketplaceCandidates: Array<{ record: OwnedMarketplaceRecord; observationIndex: number }> = []; const snapshotCandidates: Array<{ record: OwnedMarketplaceSnapshotRecord; observationIndex: number }> = [];
  const discovered = discoverRecordFiles(store.recordsRoot); if (!discovered.ok) return Object.freeze({ installations: Object.freeze([]), marketplaces: Object.freeze([]), marketplaceSnapshots: Object.freeze([]), records: Object.freeze([{ path: store.recordsRoot, status: "inert" as const, code: discovered.code }]) });
  let installationEnvelopeCount = 0; const uncertainRecordFiles: string[] = [];
  for (const file of discovered.value) { try { const bytes = readOpenedOrdinaryFile(file, MAX_RECORD_BYTES).bytes; try { const raw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; if (raw.schema === "plugin-installation") installationEnvelopeCount++; } catch { /* malformed records remain observable below */ } const decoded = readRecordEnvelope(bytes, registry); if (!decoded.ok) { uncertainRecordFiles.push(file); records.push({ path: file, status: "inert", code: decoded.code }); continue; } const producer = Object.freeze({ schema: decoded.value.envelope.schema, version: decoded.value.envelope.codecVersion, ownerKey: decoded.value.envelope.ownerKey, scopeKey: decoded.value.envelope.scopeKey, payload: decoded.value.decoded }); const reject = (code: string): void => { records.push({ path: file, status: "inert", code, producer }); }; if (decoded.value.envelope.ownerKey !== "picc-owned") { reject("owner-mismatch"); continue; } const partition = ownedRecordPartition(store, decoded.value.envelope.ownerKey, decoded.value.envelope.scopeKey); if (!partition.ok || !isContainedPath(partition.value, file)) { reject("record-containment"); continue; }
    if (decoded.value.envelope.schema === "plugin-installation") { const record = decoded.value.decoded as OwnedPluginInstallationRecord; if (decoded.value.envelope.scopeKey !== ownedInstallationScopeKey(record)) { reject("scope-mismatch"); continue; } const member = generation?.members.find((item) => sameMember(record, item)); if (generation === undefined || generation.generationId !== record.executableGenerationId || member?.recordDigest !== decoded.value.envelope.payloadDigest || !verifyPersistedTree(record, store.artifactsRoot)) { reject(member === undefined ? "generation-mismatch" : "artifact-mismatch"); continue; } const observationIndex = records.length; records.push({ path: file, status: "admitted", producer }); const installation = Object.freeze({ record, recordDigest: decoded.value.envelope.payloadDigest }); admittedInstallationEvidence.set(installation, { recordPath: file, recordBytesDigest: sha256(bytes) }); candidates.push({ installation, observationIndex });
    } else if (decoded.value.envelope.schema === "marketplace-registration") { const record = decoded.value.decoded as OwnedMarketplaceRecord; if (decoded.value.envelope.scopeKey !== ownedMarketplaceScopeKey(record)) reject("scope-mismatch"); else { const observationIndex = records.length; records.push({ path: file, status: "admitted", producer }); marketplaceCandidates.push({ record, observationIndex }); }
    } else if (decoded.value.envelope.schema === "marketplace-catalog-snapshot") { const record = decoded.value.decoded as OwnedMarketplaceSnapshotRecord; if (decoded.value.envelope.scopeKey !== ownedMarketplaceSnapshotScopeKey(record)) reject("scope-mismatch"); else if (record.authorityKind === "materialized" && !verifyMaterializedMarketplaceSnapshot(record, store.artifactsRoot)) reject("artifact-mismatch"); else { const observationIndex = records.length; records.push({ path: file, status: "admitted", producer }); snapshotCandidates.push({ record, observationIndex }); }
    } else reject("unsupported-record");
  } catch { uncertainRecordFiles.push(file); records.push({ path: file, status: "inert", code: "unreadable-record" }); } }
  const partitionUncertain = (scopeKey: string): boolean => { const partition = ownedRecordPartition(store, "picc-owned", scopeKey); return partition.ok && uncertainRecordFiles.some((file) => isContainedPath(partition.value, file)); };
  const uncertainMarketplaceCandidates = new Set(marketplaceCandidates.filter((candidate) => partitionUncertain(ownedMarketplaceScopeKey(candidate.record))));
  for (const candidate of uncertainMarketplaceCandidates) records[candidate.observationIndex] = { ...records[candidate.observationIndex]!, status: "inert", code: "authority-uncertain" };
  const marketplaces = marketplaceCandidates.filter((candidate) => !uncertainMarketplaceCandidates.has(candidate)).map((candidate) => candidate.record);
  const conflictingSnapshotAuthorities = new Set<string>(); const snapshotAuthority = new Map<string, string>();
  for (const candidate of snapshotCandidates) { const key = ownedMarketplaceSnapshotScopeKey(candidate.record); const authority = JSON.stringify(candidate.record); const existing = snapshotAuthority.get(key); if (existing === undefined) snapshotAuthority.set(key, authority); else if (existing !== authority) conflictingSnapshotAuthorities.add(key); }
  const uncertainSnapshotCandidates = new Set(snapshotCandidates.filter((candidate) => partitionUncertain(ownedMarketplaceSnapshotScopeKey(candidate.record))));
  for (const candidate of snapshotCandidates) if (conflictingSnapshotAuthorities.has(ownedMarketplaceSnapshotScopeKey(candidate.record))) records[candidate.observationIndex] = { ...records[candidate.observationIndex]!, status: "inert", code: "snapshot-authority-conflict" }; else if (uncertainSnapshotCandidates.has(candidate)) records[candidate.observationIndex] = { ...records[candidate.observationIndex]!, status: "inert", code: "authority-uncertain" };
  const marketplaceSnapshots = snapshotCandidates.filter((candidate) => !conflictingSnapshotAuthorities.has(ownedMarketplaceSnapshotScopeKey(candidate.record)) && !uncertainSnapshotCandidates.has(candidate)).map((candidate) => candidate.record);
  for (const snapshot of marketplaceSnapshots) admittedMarketplaceSnapshots.set(snapshot, store);
  const uncertainInstallationRecord = generation?.members.some((member) => { const scopeKey = member.scope === "user" ? `user-${store.profileKey}` : `${member.scope}-${member.projectKey ?? "invalid"}`; return partitionUncertain(scopeKey); }) ?? false;
  const complete = generation !== undefined && !uncertainInstallationRecord && installationEnvelopeCount === generation.members.length && candidates.length === generation.members.length && generation.members.every((member) => candidates.some(({ installation }) => sameMember(installation.record, member) && installation.recordDigest === member.recordDigest));
  if (!complete) for (const candidate of candidates) records[candidate.observationIndex] = { ...records[candidate.observationIndex]!, status: "inert", code: "generation-incomplete" };
  const installations = Object.freeze(complete ? candidates.map((item) => item.installation) : []); const revision = complete ? completeReferenceRevision(store) : undefined; const completeReference = complete && generation !== undefined && revision?.ok ? Object.freeze({ installations, generation }) : undefined; if (completeReference && revision?.ok) completeReferences.set(completeReference, { profileRoot: store.profileRoot, profileKey: store.profileKey, revision: revision.value });
  return Object.freeze({ installations, marketplaces: Object.freeze(marketplaces), marketplaceSnapshots: Object.freeze(marketplaceSnapshots), records: Object.freeze(records), ...(completeReference === undefined ? {} : { completeReference }) });
}
export async function reopenAdmittedMarketplaceSnapshot(
  snapshot: OwnedMarketplaceSnapshotRecord,
  store: OwnedStateStore,
): Promise<StoreResult<MarketplaceGeneration>> {
  if (snapshot.authorityKind !== "materialized" || admittedMarketplaceSnapshots.get(snapshot) !== store) {
    return fail("invalid-retained-snapshot", "Retained marketplace snapshot authority is not authentic materialized admission");
  }
  const authority = issueRetainedMarketplaceGenerationAuthority({
    source: snapshot.source,
    snapshotId: snapshot.snapshotId,
    catalogDigest: snapshot.catalogDigest,
  }, store, async () => {
    const storeStatus = await revalidateOwnedStateStore(store);
    if (!storeStatus.ok || store.profileKey !== snapshot.profileKey) return acquisitionFailure("unsafe-source", "Retained marketplace snapshot store authority changed");
    const registry = createProducerCodecRegistry([createOwnedMarketplaceSnapshotCodec({ profileKey: snapshot.profileKey, artifactsRoot: store.artifactsRoot })]);
    if (!registry.ok) return acquisitionFailure("unsafe-source", "Retained marketplace snapshot codec authority is unavailable");
    const fresh = readOwnedAdmissionRecords(store, registry.value, undefined).marketplaceSnapshots
      .filter((candidate) => candidate.authorityKind === "materialized" && sameCanonical(candidate, snapshot));
    if (fresh.length !== 1) return acquisitionFailure("unsafe-source", "Retained marketplace snapshot is stale, conflicting, or authority-uncertain");
    try {
      const entries = readPersistedTree(snapshot.artifactRoot);
      if (digestArtifactEntries(entries) !== snapshot.treeDigest || !verifyMaterializedMarketplaceSnapshot(snapshot, store.artifactsRoot)) throw new Error("changed");
      const catalogEntries = entries.filter((entry) => entry.kind === "file" && entry.path === snapshot.catalogRelativePath);
      const catalog = catalogEntries[0]?.data;
      if (catalogEntries.length !== 1 || catalog === undefined || sha256(catalog) !== snapshot.catalogDigest) throw new Error("catalog");
      const evidence: RetainedMarketplaceGenerationEvidence = Object.freeze({
        marketplaceName: snapshot.marketplaceName,
        source: snapshot.source,
        snapshotId: snapshot.snapshotId,
        catalogDigest: snapshot.catalogDigest,
        catalog: Uint8Array.from(catalog),
        entries: Object.freeze(entries.map((entry) => {
          if (entry.kind === "directory") return Object.freeze({ path: entry.path, kind: "directory" as const });
          if (entry.data === undefined) throw new Error("file-data");
          return Object.freeze({ path: entry.path, kind: "file" as const, data: Uint8Array.from(entry.data), ...(entry.executable === undefined ? {} : { executable: entry.executable }) });
        })),
        reviewed: Object.freeze({
          kind: "retained-marketplace-snapshot",
          marketplaceName: snapshot.marketplaceName,
          snapshotId: snapshot.snapshotId,
          source: snapshot.source,
          catalogDigest: snapshot.catalogDigest,
          artifactDigest: snapshot.artifactDigest,
          treeDigest: snapshot.treeDigest,
        }),
      });
      return { ok: true, value: evidence };
    } catch {
      return acquisitionFailure("unsafe-source", "Retained marketplace snapshot artifact or catalog changed");
    }
  });
  const issued = issueMarketplaceGenerationFromOwnedAdmission(authority);
  return issued.ok ? issued : fail("invalid-retained-snapshot", issued.error.message);
}

export type GenerationMarkerObservation = { readonly status: "absent" } | { readonly status: "valid"; readonly generation: ExecutableAdmissionGeneration } | { readonly status: "membership-invalid"; readonly code: string; readonly generation: ExecutableAdmissionGeneration } | { readonly status: "malformed" | "noncanonical" | "unreadable"; readonly code: string };
export function observeExecutableGenerationFile(file: string, codec: ProducerCodec<ExecutableAdmissionGeneration>): GenerationMarkerObservation { try { const parent = path.dirname(file); try { const parentStat = fs.lstatSync(parent); if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !samePath(fs.realpathSync.native(parent), path.resolve(parent))) return { status: "unreadable", code: "invalid-generation-root" }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" }; return { status: "unreadable", code: "invalid-generation-root" }; } const bytes = readOpenedOrdinaryFile(file, MAX_RECORD_BYTES).bytes; let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return { status: "malformed", code: "invalid-generation" }; } const canonical = canonicalJsonBytes(parsed); if (!canonical.ok) return { status: "malformed", code: canonical.code }; if (!Buffer.from(canonical.value).equals(bytes)) return { status: "noncanonical", code: "invalid-generation" }; const decoded = codec.decode(parsed); return decoded.ok ? { status: "valid", generation: decoded.value } : { status: "malformed", code: decoded.code }; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "absent" } : { status: "unreadable", code: "invalid-generation" }; } }
export function decodeExecutableGenerationFile(file: string, codec: ProducerCodec<ExecutableAdmissionGeneration>): StoreResult<ExecutableAdmissionGeneration | undefined> { const observed = observeExecutableGenerationFile(file, codec); return observed.status === "absent" ? { ok: true, value: undefined } : observed.status === "valid" ? { ok: true, value: observed.generation } : fail(observed.code, `Generation marker is ${observed.status}`); }
export function executableDigestForProjection(value: unknown): StoreResult<Sha256> { const bytes = canonicalJsonBytes(value); return bytes.ok ? { ok: true, value: sha256(bytes.value) } : bytes; }

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { normalizePortableRelativePath, routeCatalogPluginSource, routeMarketplaceSource } from "./source-matrix.js";
import { digestArtifactEntries, type ArtifactDigestEntry } from "./artifact-digest.js";
import { PORTABLE_TREE_LIMITS } from "./tree-validator.js";
import { canonicalJsonBytes, isContainedPath, ownedRecordPartition, readRecordEnvelope, sha256, type OwnedStateStore, type ProducerCodec, type ProducerCodecRegistry, type StoreResult } from "./state-store.js";
import type { CatalogPluginSource, CheckoutFamilyKey, LifecycleProfileKey, MarketplaceRegistrationSource, MutablePluginScope, QualifiedPluginIdentity, Sha256 } from "./types.js";
import type { PluginRootSelection } from "./plugin-root.js";
import { isQualifiedPluginId } from "../util/plugin-id.js";

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
export interface OwnedMarketplaceRecord {
  readonly ownership: "picc-owned"; readonly name: string; readonly profileKey: LifecycleProfileKey;
  readonly source: MarketplaceRegistrationSource; readonly selectedSnapshotId: `marketplace-${string}`;
}
export interface OwnedMarketplaceSnapshotRecord {
  readonly ownership: "picc-owned"; readonly marketplaceName: string; readonly profileKey: LifecycleProfileKey;
  readonly snapshotId: `marketplace-${string}`; readonly catalogDigest: Sha256; readonly source: MarketplaceRegistrationSource;
  readonly provenance: Readonly<{ readonly adapter: "local-directory-snapshot" | "local-catalog-snapshot" | "anonymous-https-git" | "public-https-catalog"; readonly immutableIdentity: string }>;
}
export interface MarketplaceSnapshotAuthority { readonly marketplaceName: string; readonly catalogDigest: Sha256; readonly source: MarketplaceRegistrationSource; readonly provenance: OwnedMarketplaceSnapshotRecord["provenance"] }

export function ownedInstallationScopeKey(record: Pick<OwnedPluginInstallationRecord, "scope" | "profileKey" | "projectKey">): string { return record.scope === "user" ? `user-${record.profileKey}` : `${record.scope}-${record.projectKey ?? "invalid"}`; }
export function ownedMarketplaceScopeKey(record: Pick<OwnedMarketplaceRecord, "name">): string { return `marketplace-${record.name}`; }
export function ownedMarketplaceSnapshotScopeKey(record: Pick<OwnedMarketplaceSnapshotRecord, "marketplaceName">): string { return `marketplace-snapshot-${record.marketplaceName}`; }
export interface AdmissionContext { readonly profileKey: LifecycleProfileKey; readonly artifactsRoot: string; readonly marketplaceSnapshots?: Readonly<Record<string, MarketplaceSnapshotAuthority>> }

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
function validScope(payload: Record<string, unknown>): boolean { return payload.scope === "user" ? payload.checkoutFamilyKey === undefined && payload.projectKey === undefined : (payload.scope === "project" || payload.scope === "local") && typeof payload.checkoutFamilyKey === "string" && CHECKOUT.test(payload.checkoutFamilyKey) && payload.projectKey === payload.checkoutFamilyKey; }

export function createOwnedPluginInstallationCodec(context: AdmissionContext): ProducerCodec<OwnedPluginInstallationRecord> {
  return Object.freeze({ schema: "plugin-installation", version: 1, decode: (payload: unknown) => {
    if (!exact(payload, ["ownership", "pluginId", "scope", "profileKey", "version", "source", "artifactDigest", "treeDigest", "rootDigest", "executableDigest", "selectedRoot", "installRoot", "dataIdentity", "executableGenerationId", "trust", "allowedCrossMarketplaceDependencies"], ["checkoutFamilyKey", "projectKey", "marketplaceDefaultEnabled"])) return fail("invalid-admission", "Owned installation payload has an inexact shape");
    const source = decodeSource(payload.source); const trust = decodeTrust(payload.trust); const data = exact(payload.dataIdentity, ["profileKey", "identity"]) ? payload.dataIdentity : undefined;
    const allow = payload.allowedCrossMarketplaceDependencies; const validAllow = Array.isArray(allow) && allow.length <= 128 && allow.every((item) => typeof item === "string" && MARKETPLACE.test(item)) && allow.every((item, i) => i === 0 || allow[i - 1]! < item);
    const selectedRoot = decodeRootSelection(payload.selectedRoot);
    const artifactRoot = digest(payload.treeDigest) ? path.join(path.resolve(context.artifactsRoot), payload.treeDigest.slice(7)) : "";
    const expectedRoot = selectedRoot === undefined ? "" : path.join(artifactRoot, ...selectedRoot.path.split("/"));
    const snapshot = source === undefined ? undefined : context.marketplaceSnapshots?.[source.marketplaceSnapshotId];
    const catalogRelationship = source !== undefined && source.marketplaceName === pluginMarketplace(String(payload.pluginId)) && snapshot?.marketplaceName === source.marketplaceName && snapshot.catalogDigest === source.catalogDigest;
    const relativePath = source?.kind === "marketplace-relative" ? [source.pluginRoot, source.path].filter((item): item is string => item !== undefined && item !== "").join("/") : "";
    const selectionRelationship = source?.kind === "marketplace-relative" ? selectedRoot?.requested === "relative-subtree" && selectedRoot.path === relativePath && !selectedRoot.usedSingleWrapper
      : source?.kind === "git" ? selectedRoot?.requested === "tree-root" && selectedRoot.path === "" && !selectedRoot.usedSingleWrapper
      : source?.kind === "npm" ? selectedRoot?.requested === "package/" && selectedRoot.path === "" && selectedRoot.usedSingleWrapper
      : source?.kind === "zip" ? selectedRoot?.requested === "root-or-single-wrapper" && ((selectedRoot.path === "" && !selectedRoot.usedSingleWrapper) || (selectedRoot.usedSingleWrapper && selectedRoot.path.length > 0 && !selectedRoot.path.includes("/"))) : false;
    const sourceRelationship = source?.kind === "npm" ? source.version === payload.version : source?.kind === "zip" ? source.zipDigest === payload.artifactDigest : source?.kind === "git" || source?.kind === "marketplace-relative" ? payload.artifactDigest === payload.treeDigest : false;
    const versionRelationship = typeof payload.version === "string" && (source?.kind === "npm" ? semver.valid(payload.version) === payload.version : VERSION.test(payload.version));
    if (payload.ownership !== "picc-owned" || !safeIdentity(payload.pluginId) || payload.profileKey !== context.profileKey || !PROFILE.test(String(payload.profileKey)) || !validScope(payload) || !versionRelationship || source === undefined || !catalogRelationship || !selectionRelationship || !sourceRelationship || !digest(payload.artifactDigest) || !digest(payload.treeDigest) || !digest(payload.rootDigest) || !digest(payload.executableDigest) || selectedRoot === undefined || typeof payload.installRoot !== "string" || !path.isAbsolute(payload.installRoot) || path.resolve(payload.installRoot) !== path.resolve(expectedRoot) || trust === undefined || trust.target !== payload.pluginId || trust.artifactDigest !== payload.artifactDigest || trust.treeDigest !== payload.treeDigest || trust.rootDigest !== payload.rootDigest || trust.executableDigest !== payload.executableDigest || JSON.stringify(trust.selectedRoot) !== JSON.stringify(selectedRoot) || JSON.stringify(trust.allowedCrossMarketplaceDependencies) !== JSON.stringify(allow) || !data || data.profileKey !== payload.profileKey || data.identity !== payload.pluginId || typeof payload.executableGenerationId !== "string" || !GENERATION.test(payload.executableGenerationId) || !validAllow || (payload.marketplaceDefaultEnabled !== undefined && typeof payload.marketplaceDefaultEnabled !== "boolean")) return fail("invalid-admission", "Owned installation authority or relationship is invalid");
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
    if (!exact(payload, ["ownership", "name", "profileKey", "source", "selectedSnapshotId"])) return fail("invalid-marketplace", "Owned marketplace registration is invalid");
    const source = marketplaceSource(payload.source);
    return payload.ownership === "picc-owned" && payload.profileKey === profileKey && typeof payload.name === "string" && MARKETPLACE.test(payload.name) && source !== undefined && typeof payload.selectedSnapshotId === "string" && SNAPSHOT.test(payload.selectedSnapshotId)
      ? { ok: true, value: Object.freeze(payload as unknown as OwnedMarketplaceRecord) } : fail("invalid-marketplace", "Owned marketplace registration is invalid");
  } });
}
export function createOwnedMarketplaceSnapshotCodec(profileKey: LifecycleProfileKey): ProducerCodec<OwnedMarketplaceSnapshotRecord> {
  return Object.freeze({ schema: "marketplace-catalog-snapshot", version: 1, decode: (payload: unknown): StoreResult<OwnedMarketplaceSnapshotRecord> => {
    if (!exact(payload, ["ownership", "marketplaceName", "profileKey", "snapshotId", "catalogDigest", "source", "provenance"])) return fail("invalid-marketplace-snapshot", "Owned marketplace snapshot is invalid");
    const source = marketplaceSource(payload.source);
    if (payload.ownership !== "picc-owned" || payload.profileKey !== profileKey || typeof payload.marketplaceName !== "string" || !MARKETPLACE.test(payload.marketplaceName) || typeof payload.snapshotId !== "string" || !SNAPSHOT.test(payload.snapshotId) || !digest(payload.catalogDigest) || source === undefined || !exact(payload.provenance, ["adapter", "immutableIdentity"]) || typeof payload.provenance.immutableIdentity !== "string" || payload.provenance.immutableIdentity.length === 0 || payload.provenance.immutableIdentity.length > 512) return fail("invalid-marketplace-snapshot", "Owned marketplace snapshot is invalid");
    const adapter = source.kind === "local-directory" ? "local-directory-snapshot" : source.kind === "local-catalog-file" ? "local-catalog-snapshot" : source.kind === "https-catalog" ? "public-https-catalog" : "anonymous-https-git";
    const identity = source.kind === "local-directory" || source.kind === "local-catalog-file" ? source.path : source.kind === "https-catalog" ? source.url : payload.provenance.immutableIdentity;
    const immutableIdentityValid = source.kind !== "github" && source.kind !== "https-git" || /^[a-f0-9]{40}$/.test(payload.provenance.immutableIdentity);
    return payload.provenance.adapter === adapter && immutableIdentityValid && identity === payload.provenance.immutableIdentity ? { ok: true, value: Object.freeze(payload as unknown as OwnedMarketplaceSnapshotRecord) } : fail("invalid-marketplace-snapshot", "Marketplace snapshot provenance is unbound");
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
function verifyPersistedTree(record: OwnedPluginInstallationRecord, artifactsRoot: string): boolean {
  try {
    const root = path.resolve(artifactsRoot); const artifactRoot = path.join(root, record.treeDigest.slice(7)); const installRoot = path.resolve(record.installRoot);
    if (!ordinaryCanonicalDirectory(root) || !ordinaryCanonicalDirectory(artifactRoot) || !ordinaryCanonicalDirectory(installRoot) || !samePath(installRoot, path.join(artifactRoot, ...record.selectedRoot.path.split("/"))) || !isContainedPath(artifactRoot, installRoot)) return false;
    const entries: ArtifactDigestEntry[] = []; const count = { value: 0 }; let total = 0;
    const walk = (directory: string, relative: string, depth: number): void => { if (depth > PORTABLE_TREE_LIMITS.maximumDepth) throw new Error("depth"); const names = boundedDirectoryNames(directory, PORTABLE_TREE_LIMITS.maximumEntries, count); for (const name of names) { const child = path.join(directory, name); const childRelative = relative === "" ? name : `${relative}/${name}`; if (Buffer.byteLength(childRelative, "utf8") > PORTABLE_TREE_LIMITS.maximumPathBytes) throw new Error("path"); const stat = fs.lstatSync(child); if (stat.isSymbolicLink() || !samePath(fs.realpathSync.native(child), path.resolve(child))) throw new Error("alias"); if (stat.isDirectory()) { entries.push({ path: childRelative, kind: "directory" }); walk(child, childRelative, depth + 1); } else if (stat.isFile()) { const opened = readOpenedOrdinaryFile(child, PORTABLE_TREE_LIMITS.maximumFileBytes); if ((total += opened.bytes.length) > PORTABLE_TREE_LIMITS.maximumTotalBytes) throw new Error("bytes"); entries.push({ path: childRelative, kind: "file", executable: process.platform !== "win32" && (opened.stat.mode & 0o111n) !== 0n, data: opened.bytes }); } else throw new Error("special"); } };
    walk(artifactRoot, "", 0); return digestArtifactEntries(entries) === record.treeDigest && digestArtifactEntries(entries, record.selectedRoot.path) === record.rootDigest;
  } catch { return false; }
}
export interface AdmittedOwnedInstallation { readonly record: OwnedPluginInstallationRecord; readonly recordDigest: Sha256 }
export interface AdmissionRecordObservation { readonly path: string; readonly status: "admitted" | "inert"; readonly code?: string; readonly producer?: { readonly schema: string; readonly version: number; readonly ownerKey: string; readonly scopeKey: string; readonly payload: unknown } }
export interface CompleteOwnedProfileReference { readonly installations: readonly AdmittedOwnedInstallation[] }
const completeReferences = new WeakSet<CompleteOwnedProfileReference>();
export function isCompleteOwnedProfileReference(value: unknown): value is CompleteOwnedProfileReference { return typeof value === "object" && value !== null && completeReferences.has(value as CompleteOwnedProfileReference); }
export interface OwnedAdmissionLoad { readonly installations: readonly AdmittedOwnedInstallation[]; readonly marketplaces: readonly OwnedMarketplaceRecord[]; readonly marketplaceSnapshots: readonly OwnedMarketplaceSnapshotRecord[]; readonly records: readonly AdmissionRecordObservation[]; readonly completeReference?: CompleteOwnedProfileReference }
function discoverRecordFiles(root: string): StoreResult<readonly string[]> { try { try { fs.lstatSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: Object.freeze([]) }; throw error; } if (!ordinaryCanonicalDirectory(root)) return fail("record-root-invalid", "Existing record root is aliased, unreadable, or unsafe"); const files: string[] = []; const discoveredEntries = { value: 0 }; const walk = (dir: string, depth: number): void => { if (depth > MAX_RECORD_DEPTH) throw new Error("depth"); for (const name of boundedDirectoryNames(dir, MAX_RECORDS, discoveredEntries)) { const child = path.join(dir, name); const stat = fs.lstatSync(child); if (stat.isSymbolicLink() || !samePath(fs.realpathSync.native(child), path.resolve(child))) throw new Error("alias"); if (stat.isDirectory()) walk(child, depth + 1); else if (stat.isFile() && name.endsWith(".json")) files.push(child); else if (!stat.isFile()) throw new Error("special"); } }; walk(root, 0); return { ok: true, value: Object.freeze(files.sort()) }; } catch { return fail("record-discovery-invalid", "Owned record discovery exceeded bounds or encountered unsafe storage"); } }
function sameMember(record: OwnedPluginInstallationRecord, member: ExecutableAdmissionGenerationMember): boolean { return record.pluginId === member.pluginId && record.scope === member.scope && record.checkoutFamilyKey === member.checkoutFamilyKey && record.projectKey === member.projectKey; }
export function readOwnedAdmissionRecords(store: OwnedStateStore, registry: ProducerCodecRegistry, generation: ExecutableAdmissionGeneration | undefined): OwnedAdmissionLoad {
  const records: AdmissionRecordObservation[] = []; const candidates: Array<{ installation: AdmittedOwnedInstallation; observationIndex: number }> = []; const marketplaceCandidates: Array<{ record: OwnedMarketplaceRecord; observationIndex: number }> = []; const snapshotCandidates: Array<{ record: OwnedMarketplaceSnapshotRecord; observationIndex: number }> = [];
  const discovered = discoverRecordFiles(store.recordsRoot); if (!discovered.ok) return Object.freeze({ installations: Object.freeze([]), marketplaces: Object.freeze([]), marketplaceSnapshots: Object.freeze([]), records: Object.freeze([{ path: store.recordsRoot, status: "inert" as const, code: discovered.code }]) });
  let installationEnvelopeCount = 0; const uncertainRecordFiles: string[] = [];
  for (const file of discovered.value) { try { const bytes = readOpenedOrdinaryFile(file, MAX_RECORD_BYTES).bytes; try { const raw = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; if (raw.schema === "plugin-installation") installationEnvelopeCount++; } catch { /* malformed records remain observable below */ } const decoded = readRecordEnvelope(bytes, registry); if (!decoded.ok) { uncertainRecordFiles.push(file); records.push({ path: file, status: "inert", code: decoded.code }); continue; } const producer = Object.freeze({ schema: decoded.value.envelope.schema, version: decoded.value.envelope.codecVersion, ownerKey: decoded.value.envelope.ownerKey, scopeKey: decoded.value.envelope.scopeKey, payload: decoded.value.decoded }); const reject = (code: string): void => { records.push({ path: file, status: "inert", code, producer }); }; if (decoded.value.envelope.ownerKey !== "picc-owned") { reject("owner-mismatch"); continue; } const partition = ownedRecordPartition(store, decoded.value.envelope.ownerKey, decoded.value.envelope.scopeKey); if (!partition.ok || !isContainedPath(partition.value, file)) { reject("record-containment"); continue; }
    if (decoded.value.envelope.schema === "plugin-installation") { const record = decoded.value.decoded as OwnedPluginInstallationRecord; if (decoded.value.envelope.scopeKey !== ownedInstallationScopeKey(record)) { reject("scope-mismatch"); continue; } const member = generation?.members.find((item) => sameMember(record, item)); if (generation === undefined || generation.generationId !== record.executableGenerationId || member?.recordDigest !== decoded.value.envelope.payloadDigest || !verifyPersistedTree(record, store.artifactsRoot)) { reject(member === undefined ? "generation-mismatch" : "artifact-mismatch"); continue; } const observationIndex = records.length; records.push({ path: file, status: "admitted", producer }); candidates.push({ installation: { record, recordDigest: decoded.value.envelope.payloadDigest }, observationIndex });
    } else if (decoded.value.envelope.schema === "marketplace-registration") { const record = decoded.value.decoded as OwnedMarketplaceRecord; if (decoded.value.envelope.scopeKey !== ownedMarketplaceScopeKey(record)) reject("scope-mismatch"); else { const observationIndex = records.length; records.push({ path: file, status: "admitted", producer }); marketplaceCandidates.push({ record, observationIndex }); }
    } else if (decoded.value.envelope.schema === "marketplace-catalog-snapshot") { const record = decoded.value.decoded as OwnedMarketplaceSnapshotRecord; if (decoded.value.envelope.scopeKey !== ownedMarketplaceSnapshotScopeKey(record)) reject("scope-mismatch"); else { const observationIndex = records.length; records.push({ path: file, status: "admitted", producer }); snapshotCandidates.push({ record, observationIndex }); }
    } else reject("unsupported-record");
  } catch { uncertainRecordFiles.push(file); records.push({ path: file, status: "inert", code: "unreadable-record" }); } }
  const partitionUncertain = (scopeKey: string): boolean => { const partition = ownedRecordPartition(store, "picc-owned", scopeKey); return partition.ok && uncertainRecordFiles.some((file) => isContainedPath(partition.value, file)); };
  const uncertainMarketplaceCandidates = new Set(marketplaceCandidates.filter((candidate) => partitionUncertain(ownedMarketplaceScopeKey(candidate.record))));
  for (const candidate of uncertainMarketplaceCandidates) records[candidate.observationIndex] = { ...records[candidate.observationIndex]!, status: "inert", code: "authority-uncertain" };
  const marketplaces = marketplaceCandidates.filter((candidate) => !uncertainMarketplaceCandidates.has(candidate)).map((candidate) => candidate.record);
  const conflictingSnapshotIds = new Set<string>(); const snapshotAuthority = new Map<string, string>();
  for (const candidate of snapshotCandidates) { const authority = JSON.stringify(candidate.record); const existing = snapshotAuthority.get(candidate.record.snapshotId); if (existing === undefined) snapshotAuthority.set(candidate.record.snapshotId, authority); else if (existing !== authority) conflictingSnapshotIds.add(candidate.record.snapshotId); }
  const uncertainSnapshotCandidates = new Set(snapshotCandidates.filter((candidate) => partitionUncertain(ownedMarketplaceSnapshotScopeKey(candidate.record))));
  for (const candidate of snapshotCandidates) if (conflictingSnapshotIds.has(candidate.record.snapshotId)) records[candidate.observationIndex] = { ...records[candidate.observationIndex]!, status: "inert", code: "snapshot-authority-conflict" }; else if (uncertainSnapshotCandidates.has(candidate)) records[candidate.observationIndex] = { ...records[candidate.observationIndex]!, status: "inert", code: "authority-uncertain" };
  const marketplaceSnapshots = snapshotCandidates.filter((candidate) => !conflictingSnapshotIds.has(candidate.record.snapshotId) && !uncertainSnapshotCandidates.has(candidate)).map((candidate) => candidate.record);
  const uncertainInstallationRecord = generation?.members.some((member) => { const scopeKey = member.scope === "user" ? `user-${store.profileKey}` : `${member.scope}-${member.projectKey ?? "invalid"}`; return partitionUncertain(scopeKey); }) ?? false;
  const complete = generation !== undefined && !uncertainInstallationRecord && installationEnvelopeCount === generation.members.length && candidates.length === generation.members.length && generation.members.every((member) => candidates.some(({ installation }) => sameMember(installation.record, member) && installation.recordDigest === member.recordDigest));
  if (!complete) for (const candidate of candidates) records[candidate.observationIndex] = { ...records[candidate.observationIndex]!, status: "inert", code: "generation-incomplete" };
  const installations = Object.freeze(complete ? candidates.map((item) => item.installation) : []); const completeReference = complete ? Object.freeze({ installations }) : undefined; if (completeReference) completeReferences.add(completeReference);
  return Object.freeze({ installations, marketplaces: Object.freeze(marketplaces), marketplaceSnapshots: Object.freeze(marketplaceSnapshots), records: Object.freeze(records), ...(completeReference === undefined ? {} : { completeReference }) });
}
export type GenerationMarkerObservation = { readonly status: "absent" } | { readonly status: "valid"; readonly generation: ExecutableAdmissionGeneration } | { readonly status: "membership-invalid"; readonly code: string; readonly generation: ExecutableAdmissionGeneration } | { readonly status: "malformed" | "noncanonical" | "unreadable"; readonly code: string };
export function observeExecutableGenerationFile(file: string, codec: ProducerCodec<ExecutableAdmissionGeneration>): GenerationMarkerObservation { try { const parent = path.dirname(file); try { const parentStat = fs.lstatSync(parent); if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !samePath(fs.realpathSync.native(parent), path.resolve(parent))) return { status: "unreadable", code: "invalid-generation-root" }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" }; return { status: "unreadable", code: "invalid-generation-root" }; } const bytes = readOpenedOrdinaryFile(file, MAX_RECORD_BYTES).bytes; let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return { status: "malformed", code: "invalid-generation" }; } const canonical = canonicalJsonBytes(parsed); if (!canonical.ok) return { status: "malformed", code: canonical.code }; if (!Buffer.from(canonical.value).equals(bytes)) return { status: "noncanonical", code: "invalid-generation" }; const decoded = codec.decode(parsed); return decoded.ok ? { status: "valid", generation: decoded.value } : { status: "malformed", code: decoded.code }; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "absent" } : { status: "unreadable", code: "invalid-generation" }; } }
export function decodeExecutableGenerationFile(file: string, codec: ProducerCodec<ExecutableAdmissionGeneration>): StoreResult<ExecutableAdmissionGeneration | undefined> { const observed = observeExecutableGenerationFile(file, codec); return observed.status === "absent" ? { ok: true, value: undefined } : observed.status === "valid" ? { ok: true, value: observed.generation } : fail(observed.code, `Generation marker is ${observed.status}`); }
export function executableDigestForProjection(value: unknown): StoreResult<Sha256> { const bytes = canonicalJsonBytes(value); return bytes.ok ? { ok: true, value: sha256(bytes.value) } : bytes; }

import { createHash } from "node:crypto";
import { normalizePortableRelativePath, routeCatalogPluginSource, routeMarketplaceSource } from "../source-matrix.js";
import type { OwnedStateStore } from "../state-store.js";
import type { MaterializedPluginTree, PluginTreeEntry } from "../tree-materializer.js";
import { PLUGIN_LIFECYCLE_LIMITS, type CatalogPluginSource, type MarketplaceRegistrationSource, type Sha256 } from "../types.js";

export const ACQUISITION_LIMITS = Object.freeze({
  maximumCatalogBytes: 1024 * 1024,
  maximumDownloadBytes: 32 * 1024 * 1024,
  maximumRedirects: 5,
  timeoutMilliseconds: 15_000,
});

export interface AcquisitionContext {
  readonly store: OwnedStateStore;
  readonly signal?: AbortSignal;
}

export interface AcquisitionFailure {
  readonly ok: false;
  readonly error: {
    readonly code: "cancelled" | "not-found" | "unreadable" | "storage-overlap" | "unsafe-source" | "source-changed" | "limit-exceeded" | "download-limit" | "timeout" | "network-failure" | "invalid-catalog" | "invalid-archive" | "integrity";
    readonly message: string;
  };
}

export type AcquisitionResult<T> = { readonly ok: true; readonly value: T } | AcquisitionFailure;

export interface ReviewedLocalIdentity {
  readonly kind: "local-path";
  readonly canonicalPath: string;
}

export interface ReviewedHttpIdentity {
  readonly kind: "https-destination";
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly address: string;
  readonly family: 4 | 6;
  readonly canonicalUrl: string;
  readonly path: string;
  readonly redirectCount: number;
  readonly redirected: boolean;
}

export interface AcquisitionProvenance {
  readonly adapter: "local-directory-snapshot" | "local-catalog-snapshot" | "public-https-catalog" | "public-https-zip" | "marketplace-relative-tree";
  readonly reviewed: ReviewedLocalIdentity | ReviewedHttpIdentity;
  readonly artifactDigest: Sha256;
  readonly selectedRoot: MaterializedPluginTree["rootSelection"] | { readonly requested: "catalog-document"; readonly path: ""; readonly usedSingleWrapper: false };
  readonly marketplaceSnapshotId?: `marketplace-${string}`;
  readonly catalogDigest?: Sha256;
  readonly treeDigest?: Sha256;
  readonly rootDigest?: Sha256;
}

declare const marketplaceEvidenceBrand: unique symbol;
export interface MarketplaceSnapshotEvidence {
  readonly [marketplaceEvidenceBrand]: true;
  readonly kind: "marketplace-snapshot";
  readonly source: MarketplaceRegistrationSource;
  readonly snapshotId: `marketplace-${string}`;
  readonly catalogDigest: Sha256;
  readonly provenance: AcquisitionProvenance;
  readonly materialized?: MaterializedPluginTree;
}

declare const pluginEvidenceBrand: unique symbol;
export interface PluginAcquisitionEvidence {
  readonly [pluginEvidenceBrand]: true;
  readonly kind: "plugin-acquisition";
  readonly source: CatalogPluginSource;
  readonly artifactDigest: Sha256;
  readonly treeDigest: Sha256;
  readonly rootDigest: Sha256;
  readonly materialized: MaterializedPluginTree;
  readonly provenance: AcquisitionProvenance;
}

interface MarketplacePrivate {
  readonly catalog: Uint8Array;
  readonly entries?: readonly PluginTreeEntry[];
}

const marketplaceEvidence = new WeakMap<MarketplaceSnapshotEvidence, MarketplacePrivate>();
const pluginEvidence = new WeakSet<PluginAcquisitionEvidence>();
declare const acquisitionAuthorityBrand: unique symbol;
export interface AcquisitionAuthority { readonly [acquisitionAuthorityBrand]: true }
const acquisitionAuthorities = new WeakMap<AcquisitionAuthority, AcquisitionProvenance["adapter"]>();

// Repository adapters are trusted; this capability prevents declaration-shaped callers from invoking generic evidence issuers.
export function issueAcquisitionAuthorityForTrustedAdapter(adapter: AcquisitionProvenance["adapter"]): AcquisitionAuthority {
  const authority = Object.freeze({}) as AcquisitionAuthority;
  acquisitionAuthorities.set(authority, adapter);
  return authority;
}

function cloneEntries(entries: readonly PluginTreeEntry[]): readonly PluginTreeEntry[] {
  return Object.freeze(entries.map((entry) => {
    if (plainExact(entry, ["path", "kind"]) && entry["kind"] === "directory" && typeof entry["path"] === "string") {
      return Object.freeze({ path: entry["path"], kind: "directory" as const });
    }
    const keys = entry.executable === undefined ? ["path", "kind", "data"] : ["path", "kind", "data", "executable"];
    if (!plainExact(entry, keys) || entry["kind"] !== "file" || typeof entry["path"] !== "string"
      || !(entry["data"] instanceof Uint8Array) || (entry["executable"] !== undefined && typeof entry["executable"] !== "boolean")) {
      throw new Error("Marketplace evidence entries require exact validated shapes");
    }
    return Object.freeze({
      path: entry["path"], kind: "file" as const, data: Uint8Array.from(entry["data"]),
      ...(entry["executable"] === undefined ? {} : { executable: entry["executable"] }),
    });
  }));
}

function plainExact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined);
}

export function exactMarketplaceSource(value: unknown): MarketplaceRegistrationSource | undefined {
  let raw: Record<string, unknown>;
  if (plainExact(value, ["kind", "path"])
    && (value["kind"] === "local-directory" || value["kind"] === "local-catalog-file")
    && typeof value["path"] === "string") {
    raw = { source: value["kind"] === "local-directory" ? "directory" : "file", path: value["path"] };
  } else if (plainExact(value, ["kind", "url"]) && value["kind"] === "https-catalog" && typeof value["url"] === "string") {
    raw = { source: "url", url: value["url"] };
  } else {
    return undefined;
  }
  const routed = routeMarketplaceSource(raw);
  if (!routed.ok) return undefined;
  const descriptor = routed.value.descriptor;
  if (descriptor.kind !== value["kind"]) return undefined;
  if (descriptor.kind === "local-directory" || descriptor.kind === "local-catalog-file") {
    return descriptor.path === value["path"] ? descriptor : undefined;
  }
  return descriptor.kind === "https-catalog" && descriptor.url === value["url"] ? descriptor : undefined;
}

export function exactRelativeSource(value: unknown): Extract<CatalogPluginSource, { readonly kind: "relative" }> | undefined {
  if (plainExact(value, ["kind", "path"]) && value["kind"] === "relative" && typeof value["path"] === "string"
    && normalizePortableRelativePath(value["path"]) === value["path"]) {
    return Object.freeze({ kind: "relative", path: value["path"] });
  }
  if (plainExact(value, ["kind", "path", "pluginRoot"]) && value["kind"] === "relative"
    && typeof value["path"] === "string" && typeof value["pluginRoot"] === "string"
    && normalizePortableRelativePath(value["path"]) === value["path"]
    && normalizePortableRelativePath(value["pluginRoot"]) === value["pluginRoot"]) {
    return Object.freeze({ kind: "relative", path: value["path"], pluginRoot: value["pluginRoot"] });
  }
  return undefined;
}

export function exactZipSource(value: unknown): Extract<CatalogPluginSource, { readonly kind: "https-zip" }> | undefined {
  const hasDigest = plainExact(value, ["kind", "url", "sha256"]);
  if ((!hasDigest && !plainExact(value, ["kind", "url"])) || value["kind"] !== "https-zip"
    || typeof value["url"] !== "string" || (hasDigest && typeof value["sha256"] !== "string")) return undefined;
  const routed = routeCatalogPluginSource({
    source: "archive",
    url: value["url"],
    ...(hasDigest ? { sha256: value["sha256"] } : {}),
  }, { marketplaceSourceKind: "local-directory" });
  if (!routed.ok || routed.value.descriptor.kind !== "https-zip") return undefined;
  const descriptor = routed.value.descriptor;
  return descriptor.url === value["url"] && descriptor.sha256 === value["sha256"] ? descriptor : undefined;
}

export function acquisitionFailure(code: AcquisitionFailure["error"]["code"], message: string): AcquisitionFailure {
  return { ok: false, error: Object.freeze({ code, message }) };
}

export function parseBoundedJsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  if (bytes.byteLength > ACQUISITION_LIMITS.maximumCatalogBytes) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    let items = 0;
    const inspect = (value: unknown, depth: number): boolean => {
      items += 1;
      if (items > PLUGIN_LIFECYCLE_LIMITS.maximumFileCount || depth > PLUGIN_LIFECYCLE_LIMITS.maximumNesting) return false;
      if (value === null || typeof value === "boolean") return true;
      if (typeof value === "number") return Number.isFinite(value);
      if (typeof value === "string") return value.length <= PLUGIN_LIFECYCLE_LIMITS.maximumStringLength;
      if (Array.isArray(value)) return value.length <= PLUGIN_LIFECYCLE_LIMITS.maximumArrayItems
        && value.every((item) => inspect(item, depth + 1));
      if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
      const entries = Object.entries(value);
      return entries.length <= PLUGIN_LIFECYCLE_LIMITS.maximumObjectKeys
        && entries.every(([key, item]) => key.length <= PLUGIN_LIFECYCLE_LIMITS.maximumKeyLength && inspect(item, depth + 1));
    };
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && inspect(parsed, 0)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException("The operation was cancelled", "AbortError");
}

export function issueMarketplaceSnapshotEvidence(
  value: Omit<MarketplaceSnapshotEvidence, typeof marketplaceEvidenceBrand>,
  privateValue: MarketplacePrivate,
  authority: AcquisitionAuthority,
): MarketplaceSnapshotEvidence {
  const adapter = acquisitionAuthorities.get(authority);
  const source = exactMarketplaceSource(value.source);
  const catalogDigest = `sha256:${createHash("sha256").update(privateValue.catalog).digest("hex")}`;
  const local = adapter === "local-directory-snapshot" || adapter === "local-catalog-snapshot";
  if (adapter !== value.provenance.adapter || adapter === "marketplace-relative-tree" || source === undefined
    || parseBoundedJsonObject(privateValue.catalog) === undefined || catalogDigest !== value.catalogDigest
    || (local ? privateValue.entries === undefined || value.materialized === undefined : privateValue.entries !== undefined || value.materialized !== undefined)
    || (adapter === "local-directory-snapshot" && source.kind !== "local-directory")
    || (adapter === "local-catalog-snapshot" && source.kind !== "local-catalog-file")
    || (adapter === "public-https-catalog" && source.kind !== "https-catalog")) {
    throw new Error("Marketplace evidence requires exact adapter acquisition authority and bounded catalog evidence");
  }
  const clonedEntries = privateValue.entries === undefined ? undefined : cloneEntries(privateValue.entries);
  acquisitionAuthorities.delete(authority);
  const evidence = Object.freeze({
    kind: "marketplace-snapshot" as const, source, snapshotId: value.snapshotId,
    catalogDigest: value.catalogDigest, provenance: value.provenance,
    ...(value.materialized === undefined ? {} : { materialized: value.materialized }),
  }) as MarketplaceSnapshotEvidence;
  marketplaceEvidence.set(evidence, Object.freeze({
    catalog: Uint8Array.from(privateValue.catalog),
    ...(clonedEntries === undefined ? {} : { entries: clonedEntries }),
  }));
  return evidence;
}

export function readMarketplaceSnapshotEvidence(evidence: MarketplaceSnapshotEvidence): MarketplacePrivate | undefined {
  const value = marketplaceEvidence.get(evidence);
  return value === undefined ? undefined : {
    catalog: Uint8Array.from(value.catalog),
    ...(value.entries === undefined ? {} : { entries: cloneEntries(value.entries) }),
  };
}

export function issuePluginAcquisitionEvidence(
  value: Omit<PluginAcquisitionEvidence, typeof pluginEvidenceBrand>,
  authority: AcquisitionAuthority,
): PluginAcquisitionEvidence {
  const adapter = acquisitionAuthorities.get(authority);
  const source = adapter === "public-https-zip" ? exactZipSource(value.source) : exactRelativeSource(value.source);
  if (adapter !== value.provenance.adapter || (adapter !== "public-https-zip" && adapter !== "marketplace-relative-tree") || source === undefined) {
    throw new Error("Plugin evidence requires exact adapter acquisition authority");
  }
  acquisitionAuthorities.delete(authority);
  const evidence = Object.freeze({
    kind: "plugin-acquisition" as const, source, artifactDigest: value.artifactDigest,
    treeDigest: value.treeDigest, rootDigest: value.rootDigest,
    materialized: value.materialized, provenance: value.provenance,
  }) as PluginAcquisitionEvidence;
  pluginEvidence.add(evidence);
  return evidence;
}

export function isPluginAcquisitionEvidence(value: unknown): value is PluginAcquisitionEvidence {
  return typeof value === "object" && value !== null && pluginEvidence.has(value as PluginAcquisitionEvidence);
}

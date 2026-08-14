import { routeCatalogPluginSource } from "./source-matrix.js";
import { issuePrivateStagingParent } from "./state-store.js";
import { discardMaterializedPluginTree, materializePluginTree, validatePluginTree } from "./tree-materializer.js";
import type { CatalogPluginSource, QualifiedPluginIdentity } from "./types.js";
import { MAX_QUALIFIED_PLUGIN_ID_LENGTH, parseQualifiedPluginId } from "../util/plugin-id.js";
import { isDocumentedMarketplaceName } from "../util/plugin-marketplace-descriptor.js";
import {
  acquisitionFailure,
  consumeRetainedMarketplaceGenerationAuthority,
  exactRelativeSource,
  inspectRetainedMarketplaceGenerationAuthority,
  issueAcquisitionAuthorityForTrustedAdapter,
  issuePluginAcquisitionEvidence,
  parseBoundedJsonObject,
  readMarketplaceSnapshotEvidence,
  type AcquisitionContext,
  type AcquisitionResult,
  type MarketplaceSnapshotEvidence,
  type PluginAcquisitionEvidence,
  type RetainedMarketplaceGenerationAuthority,
} from "./acquisition/common.js";

declare const generationBrand: unique symbol;
export interface MarketplaceGeneration {
  readonly [generationBrand]: true;
  readonly snapshotId: MarketplaceSnapshotEvidence["snapshotId"];
  readonly catalogDigest: MarketplaceSnapshotEvidence["catalogDigest"];
  readonly marketplaceSource: MarketplaceSnapshotEvidence["source"];
}

interface GenerationSnapshot {
  readonly source: MarketplaceSnapshotEvidence["source"];
  readonly snapshotId: MarketplaceSnapshotEvidence["snapshotId"];
  readonly catalogDigest: MarketplaceSnapshotEvidence["catalogDigest"];
  readonly catalog: Uint8Array;
  readonly entries?: readonly import("./tree-materializer.js").PluginTreeEntry[];
  readonly reviewed?: import("./acquisition/common.js").AcquisitionProvenance["reviewed"];
  readonly retainedAuthority?: RetainedMarketplaceGenerationAuthority;
}

const snapshots = new WeakMap<MarketplaceGeneration, GenerationSnapshot>();

function catalogDeclaresRelativeSource(
  snapshot: GenerationSnapshot,
  pluginId: QualifiedPluginIdentity,
  expected: Extract<CatalogPluginSource, { readonly kind: "relative" }>,
): boolean {
  try {
    const value = parseBoundedJsonObject(snapshot.catalog);
    const parsedId = parseQualifiedPluginId(pluginId, MAX_QUALIFIED_PLUGIN_ID_LENGTH);
    if (value === undefined || parsedId === undefined || typeof value["name"] !== "string" || !Array.isArray(value["plugins"])
      || !isDocumentedMarketplaceName(parsedId.lifecycleName) || !isDocumentedMarketplaceName(parsedId.marketplaceName)
      || !isDocumentedMarketplaceName(value["name"]) || parsedId.marketplaceName !== value["name"]) return false;
    const declarations = value["plugins"].filter((plugin): plugin is Record<string, unknown> =>
      typeof plugin === "object" && plugin !== null && !Array.isArray(plugin) && plugin["name"] === parsedId.lifecycleName);
    if (declarations.length !== 1 || !isDocumentedMarketplaceName(parsedId.lifecycleName)) return false;
    const metadata = typeof value["metadata"] === "object" && value["metadata"] !== null && !Array.isArray(value["metadata"])
      ? value["metadata"] as Record<string, unknown>
      : undefined;
    const metadataPluginRoot = typeof metadata?.["pluginRoot"] === "string" ? metadata["pluginRoot"] : undefined;
    const routed = routeCatalogPluginSource(declarations[0]!["source"], {
      marketplaceSourceKind: snapshot.source.kind,
      ...(metadataPluginRoot === undefined ? {} : { metadataPluginRoot }),
    });
    return routed.ok && routed.value.descriptor.kind === "relative"
      && routed.value.descriptor.path === expected.path
      && routed.value.descriptor.pluginRoot === expected.pluginRoot;
  } catch {
    return false;
  }
}

export function createMarketplaceGeneration(
  evidence: MarketplaceSnapshotEvidence,
): AcquisitionResult<MarketplaceGeneration> {
  if (readMarketplaceSnapshotEvidence(evidence) === undefined) {
    return acquisitionFailure("unsafe-source", "Marketplace generation requires resolved snapshot evidence");
  }
  const generation = Object.freeze({
    snapshotId: evidence.snapshotId,
    catalogDigest: evidence.catalogDigest,
    marketplaceSource: evidence.source,
  }) as MarketplaceGeneration;
  const privateEvidence = readMarketplaceSnapshotEvidence(evidence)!;
  snapshots.set(generation, Object.freeze({
    source: evidence.source,
    snapshotId: evidence.snapshotId,
    catalogDigest: evidence.catalogDigest,
    catalog: privateEvidence.catalog,
    ...(privateEvidence.entries === undefined ? {} : { entries: privateEvidence.entries }),
    reviewed: evidence.provenance.reviewed,
  }));
  return { ok: true, value: generation };
}

export function issueMarketplaceGenerationFromOwnedAdmission(
  authority: RetainedMarketplaceGenerationAuthority,
): AcquisitionResult<MarketplaceGeneration> {
  const identity = inspectRetainedMarketplaceGenerationAuthority(authority);
  if (identity === undefined) return acquisitionFailure("unsafe-source", "Marketplace generation requires authentic retained snapshot authority");
  const generation = Object.freeze({
    snapshotId: identity.snapshotId,
    catalogDigest: identity.catalogDigest,
    marketplaceSource: identity.source,
  }) as MarketplaceGeneration;
  snapshots.set(generation, Object.freeze({
    source: identity.source,
    snapshotId: identity.snapshotId,
    catalogDigest: identity.catalogDigest,
    catalog: new Uint8Array(),
    retainedAuthority: authority,
  }));
  return { ok: true, value: generation };
}

export async function acquireMarketplaceRelativePlugin(
  generation: MarketplaceGeneration,
  pluginIdOrSource: QualifiedPluginIdentity | CatalogPluginSource,
  sourceOrOptions: CatalogPluginSource | AcquisitionContext,
  maybeOptions?: AcquisitionContext,
): Promise<AcquisitionResult<PluginAcquisitionEvidence>> {
  let snapshot = snapshots.get(generation);
  if (snapshot?.retainedAuthority !== undefined) {
    snapshots.delete(generation);
    const retained = await consumeRetainedMarketplaceGenerationAuthority(snapshot.retainedAuthority, maybeOptions?.store);
    if (!retained.ok) return retained;
    snapshot = Object.freeze({
      source: retained.value.source,
      snapshotId: retained.value.snapshotId,
      catalogDigest: retained.value.catalogDigest,
      catalog: retained.value.catalog,
      entries: retained.value.entries,
      reviewed: retained.value.reviewed,
    });
  }
  const parsedId = parseQualifiedPluginId(pluginIdOrSource, MAX_QUALIFIED_PLUGIN_ID_LENGTH);
  if (parsedId === undefined || !isDocumentedMarketplaceName(parsedId.lifecycleName)
    || !isDocumentedMarketplaceName(parsedId.marketplaceName) || maybeOptions === undefined) {
    return acquisitionFailure("unsafe-source", "Relative plugin content requires an exact requested plugin identity");
  }
  const pluginId = parsedId.qualifiedIdentity as QualifiedPluginIdentity;
  const source = sourceOrOptions as CatalogPluginSource;
  const options = maybeOptions;
  const exactSource = exactRelativeSource(source);
  if (snapshot === undefined || snapshot.entries === undefined || snapshot.reviewed === undefined
    || snapshot.reviewed.kind === "https-destination" || exactSource === undefined) {
    return acquisitionFailure("unsafe-source", "Relative plugin content requires a local resolved marketplace generation");
  }
  const reviewed = snapshot.reviewed;
  if (!catalogDeclaresRelativeSource(snapshot, pluginId, exactSource)) {
    return acquisitionFailure("unsafe-source", "The exact marketplace catalog snapshot does not declare this relative plugin source");
  }
  const selectedPath = [exactSource.pluginRoot, exactSource.path].filter((item): item is string => item !== undefined).join("/");
  const plan = validatePluginTree(snapshot.entries, { kind: "relative-subtree", path: selectedPath });
  if (!plan.ok) return acquisitionFailure("unsafe-source", "The marketplace-relative plugin root is not a contained validated directory");
  if (options.signal?.aborted === true) return acquisitionFailure("cancelled", "Marketplace-relative acquisition was cancelled");
  const staging = await issuePrivateStagingParent(options.store);
  if (!staging.ok) return acquisitionFailure("unsafe-source", "The marketplace-relative plugin store authority is unavailable");
  const materialized = await materializePluginTree(plan.value, staging.value);
  if (!materialized.ok) return acquisitionFailure("unsafe-source", "The marketplace-relative plugin could not be materialized safely");
  if (Boolean(options.signal?.aborted)) {
    await discardMaterializedPluginTree(materialized.value);
    return acquisitionFailure("cancelled", "Marketplace-relative acquisition was cancelled before evidence issuance");
  }
  return { ok: true, value: issuePluginAcquisitionEvidence({
    kind: "plugin-acquisition",
    source: exactSource,
    requestedPluginId: pluginId,
    artifactDigest: materialized.value.treeDigest,
    treeDigest: materialized.value.treeDigest,
    rootDigest: materialized.value.rootDigest,
    materialized: materialized.value,
    provenance: Object.freeze({
      adapter: "marketplace-relative-tree",
      reviewed,
      artifactDigest: materialized.value.treeDigest,
      selectedRoot: materialized.value.rootSelection,
      marketplaceSnapshotId: snapshot.snapshotId,
      catalogDigest: snapshot.catalogDigest,
      treeDigest: materialized.value.treeDigest,
      rootDigest: materialized.value.rootDigest,
    }),
  }, issueAcquisitionAuthorityForTrustedAdapter("marketplace-relative-tree")) };
}

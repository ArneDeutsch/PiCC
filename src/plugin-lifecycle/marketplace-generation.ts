import { routeCatalogPluginSource } from "./source-matrix.js";
import { issuePrivateStagingParent } from "./state-store.js";
import { discardMaterializedPluginTree, materializePluginTree, validatePluginTree } from "./tree-materializer.js";
import type { CatalogPluginSource } from "./types.js";
import {
  acquisitionFailure,
  exactRelativeSource,
  issueAcquisitionAuthorityForTrustedAdapter,
  issuePluginAcquisitionEvidence,
  parseBoundedJsonObject,
  readMarketplaceSnapshotEvidence,
  type AcquisitionContext,
  type AcquisitionResult,
  type MarketplaceSnapshotEvidence,
  type PluginAcquisitionEvidence,
} from "./acquisition/common.js";

declare const generationBrand: unique symbol;
export interface MarketplaceGeneration {
  readonly [generationBrand]: true;
  readonly snapshotId: MarketplaceSnapshotEvidence["snapshotId"];
  readonly catalogDigest: MarketplaceSnapshotEvidence["catalogDigest"];
  readonly marketplaceSource: MarketplaceSnapshotEvidence["source"];
}

const snapshots = new WeakMap<MarketplaceGeneration, MarketplaceSnapshotEvidence>();

function catalogDeclaresRelativeSource(
  catalog: Uint8Array,
  snapshot: MarketplaceSnapshotEvidence,
  expected: Extract<CatalogPluginSource, { readonly kind: "relative" }>,
): boolean {
  try {
    const value = parseBoundedJsonObject(catalog);
    if (value === undefined || !Array.isArray(value["plugins"])) return false;
    const metadata = typeof value["metadata"] === "object" && value["metadata"] !== null && !Array.isArray(value["metadata"])
      ? value["metadata"] as Record<string, unknown>
      : undefined;
    const metadataPluginRoot = typeof metadata?.["pluginRoot"] === "string" ? metadata["pluginRoot"] : undefined;
    for (const plugin of value["plugins"]) {
      if (typeof plugin !== "object" || plugin === null || Array.isArray(plugin)) continue;
      const routed = routeCatalogPluginSource((plugin as Record<string, unknown>)["source"], {
        marketplaceSourceKind: snapshot.source.kind,
        ...(metadataPluginRoot === undefined ? {} : { metadataPluginRoot }),
      });
      if (routed.ok && routed.value.descriptor.kind === "relative"
        && routed.value.descriptor.path === expected.path
        && routed.value.descriptor.pluginRoot === expected.pluginRoot) return true;
    }
    return false;
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
  snapshots.set(generation, evidence);
  return { ok: true, value: generation };
}

export async function acquireMarketplaceRelativePlugin(
  generation: MarketplaceGeneration,
  source: CatalogPluginSource,
  options: AcquisitionContext,
): Promise<AcquisitionResult<PluginAcquisitionEvidence>> {
  const snapshot = snapshots.get(generation);
  const privateSnapshot = snapshot === undefined ? undefined : readMarketplaceSnapshotEvidence(snapshot);
  const exactSource = exactRelativeSource(source);
  if (snapshot === undefined || privateSnapshot?.entries === undefined || exactSource === undefined) {
    return acquisitionFailure("unsafe-source", "Relative plugin content requires a local resolved marketplace generation");
  }
  if (!catalogDeclaresRelativeSource(privateSnapshot.catalog, snapshot, exactSource)) {
    return acquisitionFailure("unsafe-source", "The exact marketplace catalog snapshot does not declare this relative plugin source");
  }
  const selectedPath = [exactSource.pluginRoot, exactSource.path].filter((item): item is string => item !== undefined).join("/");
  const plan = validatePluginTree(privateSnapshot.entries, { kind: "relative-subtree", path: selectedPath });
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
    artifactDigest: materialized.value.treeDigest,
    treeDigest: materialized.value.treeDigest,
    rootDigest: materialized.value.rootDigest,
    materialized: materialized.value,
    provenance: Object.freeze({
      adapter: "marketplace-relative-tree",
      reviewed: snapshot.provenance.reviewed,
      artifactDigest: materialized.value.treeDigest,
      selectedRoot: materialized.value.rootSelection,
      marketplaceSnapshotId: snapshot.snapshotId,
      catalogDigest: snapshot.catalogDigest,
      treeDigest: materialized.value.treeDigest,
      rootDigest: materialized.value.rootDigest,
    }),
  }, issueAcquisitionAuthorityForTrustedAdapter("marketplace-relative-tree")) };
}

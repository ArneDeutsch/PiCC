import type { EffectivePluginEnablement, NormalizedPluginInstallation, PluginInstallationScope } from "../types.js";
import type { SafePluginManifestDependency } from "../claude/plugin-metadata.js";
import type { ExecutableCatalogRelease } from "../util/plugin-marketplace-descriptor.js";
import type { LifecycleLocations } from "./locations.js";
import { pluginDataPath } from "./locations.js";
import type { AdmittedOwnedInstallation, AdmissionRecordObservation, OwnedMarketplaceRecord, OwnedMarketplaceSnapshotRecord, ResolvedPluginVersionAuthority } from "./admission.js";
import { projectIdentities } from "../util/project-identity.js";
import { observePersistedTransactionsSync } from "./transaction.js";

export interface ImportedInstallationProjection {
  readonly ownership: "claude-imported-readonly";
  readonly installation: NormalizedPluginInstallation;
}
export interface OwnedInstallationProjection {
  readonly ownership: "picc-owned";
  readonly pluginId: string;
  readonly scope: Exclude<PluginInstallationScope, "managed">;
  readonly projectPath?: string;
  readonly installPath: string;
  readonly version: string;
  readonly dataPath: string;
  readonly profileRoot: string;
  readonly dataRoot: string;
  readonly executableGenerationId: string;
  readonly allowedCrossMarketplaceDependencies: readonly string[];
  readonly dependencies: readonly SafePluginManifestDependency[];
  readonly dependencyDeclaration: "absent" | "complete";
  readonly catalogDependencies: readonly SafePluginManifestDependency[];
  readonly catalogDependencyDeclaration: "absent" | "complete";
  readonly catalogRelease?: ExecutableCatalogRelease;
  readonly resolvedVersionAuthority?: ResolvedPluginVersionAuthority;
  readonly marketplaceDefaultEnabled?: boolean;
  readonly authority: AdmittedOwnedInstallation;
}
export type InstallationProjection = ImportedInstallationProjection | OwnedInstallationProjection;
const ownedProjectionAuthorities = new WeakSet<OwnedInstallationProjection>();
export function isOwnedInstallationProjection(value: unknown): value is OwnedInstallationProjection {
  return typeof value === "object" && value !== null && ownedProjectionAuthorities.has(value as OwnedInstallationProjection);
}

export interface LifecycleObservationEnvelope {
  readonly records: readonly AdmissionRecordObservation[];
  readonly receipts: readonly { readonly path: string; readonly status: "present" | "invalid"; readonly receipt?: unknown }[];
  readonly pending: readonly { readonly operationId: string; readonly status: "pending" | "terminal-residue" | "invalid"; readonly journal?: unknown }[];
}

function compare(left: InstallationProjection, right: InstallationProjection): number {
  const a = left.ownership === "picc-owned" ? left.pluginId : left.installation.pluginId;
  const b = right.ownership === "picc-owned" ? right.pluginId : right.installation.pluginId;
  return a.localeCompare(b) || left.ownership.localeCompare(right.ownership);
}

export function projectOwnedAndImportedInstallations(inputs: {
  readonly imported: readonly NormalizedPluginInstallation[];
  readonly owned: readonly AdmittedOwnedInstallation[];
  readonly locations: LifecycleLocations;
  readonly projectPath: string;
}): { readonly projections: readonly InstallationProjection[]; readonly conflicts: readonly string[] } {
  const projections: InstallationProjection[] = inputs.imported.map((installation) => Object.freeze({ ownership: "claude-imported-readonly" as const, installation }));
  const currentProjectIdentities = new Set(projectIdentities(inputs.projectPath));
  const importedApplicable = (installation: NormalizedPluginInstallation): boolean => {
    if (installation.scope === "user" || installation.scope === "managed") return true;
    if (installation.projectPath === undefined) return false;
    return projectIdentities(installation.projectPath).some((identity) => currentProjectIdentities.has(identity));
  };
  const conflicts = new Set<string>();
  const rejectedIdentities = new Set<string>();
  for (const authority of inputs.owned) {
    const record = authority.record;
    if (record.scope !== "user" && (record.checkoutFamilyKey !== inputs.locations.checkoutFamilyKey || record.projectKey !== inputs.locations.checkoutFamilyKey)) continue;
    const projectPath = record.scope === "user" ? undefined : inputs.projectPath;
    const owned: OwnedInstallationProjection = Object.freeze({ ownership: "picc-owned", pluginId: record.pluginId, scope: record.scope,
      ...(projectPath === undefined ? {} : { projectPath }), installPath: record.installRoot, version: record.version,
      dataPath: pluginDataPath(inputs.locations, record.pluginId), profileRoot: inputs.locations.profileRoot, dataRoot: inputs.locations.dataRoot, executableGenerationId: record.executableGenerationId,
      allowedCrossMarketplaceDependencies: record.allowedCrossMarketplaceDependencies, dependencies: record.dependencies, dependencyDeclaration: record.dependencyDeclaration,
      catalogDependencies: record.catalogDependencies, catalogDependencyDeclaration: record.catalogDependencyDeclaration,
      ...(record.catalogRelease === undefined ? {} : { catalogRelease: record.catalogRelease }), resolvedVersionAuthority: record.resolvedVersionAuthority,
      ...(record.marketplaceDefaultEnabled === undefined ? {} : { marketplaceDefaultEnabled: record.marketplaceDefaultEnabled }), authority });
    ownedProjectionAuthorities.add(owned);
    const sameAuthority = projections.find((candidate) => {
      const installation = candidate.ownership === "picc-owned" ? candidate : candidate.installation;
      const pluginId = candidate.ownership === "picc-owned" ? candidate.pluginId : installation.pluginId;
      return pluginId === owned.pluginId && installation.scope === owned.scope
        && (candidate.ownership === "picc-owned" || importedApplicable(candidate.installation));
    });
    if (sameAuthority !== undefined) {
      if (sameAuthority.ownership === "picc-owned" && sameAuthority.installPath === owned.installPath && sameAuthority.version === owned.version && sameAuthority.executableGenerationId === owned.executableGenerationId) continue;
      conflicts.add(`${owned.pluginId}:${owned.scope}`); rejectedIdentities.add(owned.pluginId); continue;
    }
    projections.push(owned);
  }
  return Object.freeze({ projections: Object.freeze(projections.filter((item) => {
    const installation = item.ownership === "picc-owned" ? item : item.installation;
    const pluginId = item.ownership === "picc-owned" ? item.pluginId : installation.pluginId;
    return !rejectedIdentities.has(pluginId);
  }).sort(compare)), conflicts: Object.freeze([...conflicts].sort()) });
}

function projectionApplicable(projection: InstallationProjection, projectPath: string | undefined): boolean {
  if (projection.ownership === "picc-owned" || projectPath === undefined || projection.installation.scope === "user" || projection.installation.scope === "managed") return true;
  return projection.installation.projectPath !== undefined && projectIdentities(projection.installation.projectPath).some((identity) => new Set(projectIdentities(projectPath)).has(identity));
}
export function uniquelySelectedApplicableOwnedWinner(projections: readonly InstallationProjection[], pluginId: string, projectPath?: string): OwnedInstallationProjection | undefined {
  const rank: Readonly<Record<PluginInstallationScope, number>> = { user: 0, project: 1, local: 2, managed: 3 };
  const candidates = projections.filter((item) => projectionApplicable(item, projectPath) && (item.ownership === "picc-owned" ? item.pluginId : item.installation.pluginId) === pluginId);
  if (candidates.length === 0) return undefined;
  const winnerRank = Math.max(...candidates.map((item) => rank[item.ownership === "picc-owned" ? item.scope : item.installation.scope]));
  const winners = candidates.filter((item) => rank[item.ownership === "picc-owned" ? item.scope : item.installation.scope] === winnerRank);
  return winners.length === 1 && winners[0]!.ownership === "picc-owned" ? winners[0] : undefined;
}
export function assembledEnablement(inputs: {
  readonly projections: readonly InstallationProjection[];
  readonly explicit: Readonly<Record<string, EffectivePluginEnablement>>;
  readonly projectPath?: string;
}): Readonly<Record<string, EffectivePluginEnablement>> {
  const result: Record<string, EffectivePluginEnablement> = { ...inputs.explicit };
  const identities = new Set(inputs.projections.filter((item) => projectionApplicable(item, inputs.projectPath)).map((item) => item.ownership === "picc-owned" ? item.pluginId : item.installation.pluginId));
  for (const pluginId of identities) {
    if (Object.hasOwn(result, pluginId)) continue;
    const winner = uniquelySelectedApplicableOwnedWinner(inputs.projections, pluginId, inputs.projectPath);
    if (winner === undefined) continue;
    result[pluginId] = Object.freeze({ enabled: winner.marketplaceDefaultEnabled ?? true, scope: winner.scope, source: `picc-owned:${winner.executableGenerationId}` });
  }
  return Object.freeze(result);
}

export function observeLifecycleEnvelope(store: Parameters<typeof observePersistedTransactionsSync>[0], records: LifecycleObservationEnvelope["records"]): LifecycleObservationEnvelope {
  const observed = observePersistedTransactionsSync(store);
  return Object.freeze({ records: Object.freeze([...records]), receipts: observed.receipts, pending: observed.journals });
}

export function ownedMarketplaceProjection(records: readonly OwnedMarketplaceRecord[], snapshots: readonly OwnedMarketplaceSnapshotRecord[], active: { readonly checkoutFamilyKey: string; readonly projectKey: string }): readonly OwnedMarketplaceRecord[] {
  const byAuthority = new Map<string, OwnedMarketplaceRecord>(); const conflicts = new Set<string>();
  for (const record of records) {
    if (record.scope !== "user" && (record.checkoutFamilyKey !== active.checkoutFamilyKey || record.projectKey !== active.projectKey)) continue;
    const snapshot = snapshots.find((item) => item.snapshotId === record.selectedSnapshotId && item.marketplaceName === record.name && JSON.stringify(item.source) === JSON.stringify(record.source));
    const authority = record.scope === "user" ? `${record.profileKey}\0user\0${record.name}` : `${record.profileKey}\0${record.scope}\0${record.checkoutFamilyKey}\0${record.projectKey}\0${record.name}`;
    if (snapshot === undefined) { conflicts.add(authority); continue; }
    const existing = byAuthority.get(authority);
    if (existing === undefined) byAuthority.set(authority, record);
    else if (JSON.stringify(existing) !== JSON.stringify(record)) conflicts.add(authority);
  }
  return Object.freeze([...byAuthority.entries()].filter(([authority]) => !conflicts.has(authority)).map(([, record]) => record).sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope)));
}

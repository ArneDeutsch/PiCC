import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExecutableAdmissionGenerationCodec, createOwnedMarketplaceCodec, createOwnedMarketplaceSnapshotCodec, createOwnedPluginInstallationCodec, type OwnedPluginInstallationRecord } from "../src/plugin-lifecycle/admission.js";
import { assembledEnablement, ownedMarketplaceProjection, projectOwnedAndImportedInstallations } from "../src/plugin-lifecycle/projection.js";
import { createLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { admitDependencyGraph, type DependencyAdmissionCandidate } from "../src/plugin-lifecycle/dependency-admission.js";
import type { LifecycleProfileKey, Sha256 } from "../src/plugin-lifecycle/types.js";

const digest = (character: string): Sha256 => `sha256:${character.repeat(64)}` as Sha256;
const profileKey = `profile-${"p".repeat(43)}` as LifecycleProfileKey;
const checkoutFamilyKey = `checkout-${"c".repeat(43)}` as const;
const artifactsRoot = path.resolve("owned-artifacts");
const installRoot = path.join(artifactsRoot, digest("b").slice(7), "selected");

function installation(source: OwnedPluginInstallationRecord["source"] = {
  kind: "marketplace-relative", marketplaceName: "official", path: "plugins/tool", pluginRoot: "selected", marketplaceSnapshotId: "marketplace-snapshotA", catalogDigest: digest("f"),
}): OwnedPluginInstallationRecord {
  const selectedRoot = source.kind === "marketplace-relative" ? { requested: "relative-subtree" as const, path: [source.pluginRoot, source.path].filter(Boolean).join("/"), usedSingleWrapper: false } : source.kind === "zip" ? { requested: "root-or-single-wrapper" as const, path: "selected", usedSingleWrapper: true } : source.kind === "npm" ? { requested: "package/" as const, path: "" as const, usedSingleWrapper: true as const } : { requested: "tree-root" as const, path: "", usedSingleWrapper: false };
  const selectedInstallRoot = path.join(artifactsRoot, digest("b").slice(7), ...selectedRoot.path.split("/"));
  return {
    ownership: "picc-owned", pluginId: "tool@official", scope: "project", profileKey, checkoutFamilyKey,
    projectKey: checkoutFamilyKey, version: "1.2.3", source, artifactDigest: source.kind === "marketplace-relative" || source.kind === "git" ? digest("b") : digest("a"), treeDigest: digest("b"),
    rootDigest: digest("c"), executableDigest: digest("d"), selectedRoot, installRoot: selectedInstallRoot,
    dataIdentity: { profileKey, identity: "tool@official" }, executableGenerationId: "admission-current",
    trust: { target: "tool@official", artifactDigest: source.kind === "marketplace-relative" || source.kind === "git" ? digest("b") : digest("a"), treeDigest: digest("b"), rootDigest: digest("c"), executableDigest: digest("d"), selectedRoot, allowedCrossMarketplaceDependencies: [] },
    allowedCrossMarketplaceDependencies: [],
    marketplaceDefaultEnabled: false,
  };
}

function mutate(source: OwnedPluginInstallationRecord, pathName: string, value: unknown): unknown {
  const result = structuredClone(source) as unknown as Record<string, unknown>; const parts = pathName.split("."); let target = result;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = value; return result;
}

const snapshotAuthority = { marketplaceName: "official", catalogDigest: digest("f"), source: { kind: "https-catalog", url: "https://catalog.example.org/catalog.json" } as const, provenance: { adapter: "public-https-catalog" as const, immutableIdentity: "https://catalog.example.org/catalog.json" } };
const codec = createOwnedPluginInstallationCodec({ profileKey, artifactsRoot, marketplaceSnapshots: { "marketplace-snapshotA": snapshotAuthority } });

describe("owned durable admission", () => {
  it("rejects every mutated installation authority field and relationship", () => {
    const base = installation();
    expect(codec.decode(base)).toMatchObject({ ok: true });
    const mutations: Array<[string, unknown]> = [
      ["ownership", "claude-imported-readonly"], ["pluginId", "other@official"], ["scope", "managed"],
      ["profileKey", `profile-${"x".repeat(43)}`], ["checkoutFamilyKey", "not-a-checkout"], ["projectKey", ""], ["projectKey", `checkout-${"d".repeat(43)}`],
      ["version", ""], ["source.kind", "generic"],
      ["artifactDigest", digest("e")], ["treeDigest", digest("e")], ["rootDigest", digest("e")], ["executableDigest", digest("e")],
      ["installRoot", path.resolve("outside")], ["dataIdentity.profileKey", `profile-${"x".repeat(43)}`], ["dataIdentity.identity", "other@official"],
      ["executableGenerationId", "catalog-snapshot"], ["selectedRoot.path", "other"], ["trust.selectedRoot.usedSingleWrapper", true], ["trust.target", "other@official"], ["trust.artifactDigest", digest("e")],
      ["trust.treeDigest", digest("e")], ["trust.rootDigest", digest("e")], ["trust.executableDigest", digest("e")],
      ["allowedCrossMarketplaceDependencies", ["Other"]], ["trust.allowedCrossMarketplaceDependencies", ["community"]],
    ];
    for (const [field, value] of mutations) expect(codec.decode(mutate(base, field, value)), field).toMatchObject({ ok: false });
    expect(createOwnedPluginInstallationCodec({ profileKey, artifactsRoot, marketplaceSnapshots: {} }).decode(base)).toMatchObject({ ok: false });
    expect(createOwnedPluginInstallationCodec({ profileKey, artifactsRoot, marketplaceSnapshots: { "marketplace-snapshotA": { ...snapshotAuthority, catalogDigest: digest("e") } } }).decode(base)).toMatchObject({ ok: false });
    expect(createOwnedPluginInstallationCodec({ profileKey, artifactsRoot, marketplaceSnapshots: { "marketplace-snapshotA": { ...snapshotAuthority, marketplaceName: "community" } } }).decode(base)).toMatchObject({ ok: false });
    const crossAuthorized = { ...base, allowedCrossMarketplaceDependencies: ["community"], trust: { ...base.trust, allowedCrossMarketplaceDependencies: ["community"] } };
    expect(codec.decode(crossAuthorized)).toMatchObject({ ok: true });
  });

  it("requires exact source-refined Git SHA, npm version/integrity, and ZIP digest evidence", () => {
    const catalog = { marketplaceName: "official", marketplaceSnapshotId: "marketplace-snapshotA" as const, catalogDigest: digest("f") };
    const sources: OwnedPluginInstallationRecord["source"][] = [
      { ...catalog, kind: "git", declaration: { kind: "https-git", url: "https://git.example.org/tool.git", sha: "a".repeat(40) }, commit: "a".repeat(40) },
      { ...catalog, kind: "npm", package: "tool", version: "1.2.3", integrity: `sha512-${"A".repeat(86)}==`, registry: "https://registry.npmjs.org" },
      { ...catalog, kind: "zip", url: "https://archive.example.org/tool", zipDigest: digest("a") },
    ];
    for (const source of sources) {
      expect(codec.decode(installation(source))).toMatchObject({ ok: true });
      expect(codec.decode(installation({ ...source, marketplaceName: "community" } as OwnedPluginInstallationRecord["source"]))).toMatchObject({ ok: false });
      expect(codec.decode(installation({ ...source, marketplaceSnapshotId: "marketplace-other" } as OwnedPluginInstallationRecord["source"]))).toMatchObject({ ok: false });
      expect(codec.decode(installation({ ...source, catalogDigest: digest("e") } as OwnedPluginInstallationRecord["source"]))).toMatchObject({ ok: false });
    }
    expect(codec.decode(installation({ ...sources[0]!, commit: "b".repeat(40) } as OwnedPluginInstallationRecord["source"]))).toMatchObject({ ok: false });
    expect(codec.decode(installation({ ...sources[1]!, version: "*" } as OwnedPluginInstallationRecord["source"]))).toMatchObject({ ok: false });
    expect(codec.decode(installation({ ...sources[1]!, integrity: "sha512-weak" } as OwnedPluginInstallationRecord["source"]))).toMatchObject({ ok: false });
    expect(codec.decode(installation({ ...sources[2]!, zipDigest: "optional" } as unknown as OwnedPluginInstallationRecord["source"]))).toMatchObject({ ok: false });
    expect(codec.decode({ ...installation(), version: "release-1" })).toMatchObject({ ok: true });
    expect(codec.decode({ ...installation(sources[1]), version: "release-1" })).toMatchObject({ ok: false });
    const npmRecord = installation(sources[1]); const internalTreeRoot = { requested: "tree-root" as const, path: "", usedSingleWrapper: false };
    expect(npmRecord.selectedRoot).toEqual({ requested: "package/", path: "", usedSingleWrapper: true });
    expect(codec.decode({ ...npmRecord, selectedRoot: internalTreeRoot, trust: { ...npmRecord.trust, selectedRoot: internalTreeRoot } })).toMatchObject({ ok: false });
    const gitSubdir = { ...sources[0]!, declaration: { kind: "https-git-subdir", url: "https://git.example.org/tool.git", path: "plugins/tool", sha: "a".repeat(40) } } as OwnedPluginInstallationRecord["source"];
    expect(codec.decode(installation(gitSubdir))).toMatchObject({ ok: true });
    const wrongGitRoot = installation(gitSubdir); const citedSubdir = { requested: "tree-root" as const, path: "plugins/tool", usedSingleWrapper: false };
    expect(codec.decode({ ...wrongGitRoot, selectedRoot: citedSubdir, installRoot: path.join(artifactsRoot, digest("b").slice(7), "plugins", "tool"), trust: { ...wrongGitRoot.trust, selectedRoot: citedSubdir } })).toMatchObject({ ok: false });
    const zipAtRoot = installation(sources[2]); const rootSelection = { requested: "root-or-single-wrapper" as const, path: "", usedSingleWrapper: false };
    expect(codec.decode({ ...zipAtRoot, selectedRoot: rootSelection, installRoot: path.join(artifactsRoot, digest("b").slice(7)), trust: { ...zipAtRoot.trust, selectedRoot: rootSelection } })).toMatchObject({ ok: true });
  });

  it("keeps catalog snapshots distinct from executable generations and validates membership", () => {
    const marketplaceCodec = createOwnedMarketplaceCodec(profileKey);
    const snapshotCodec = createOwnedMarketplaceSnapshotCodec(profileKey);
    const source = { kind: "https-catalog", url: "https://catalog.example.org/catalog.json" } as const;
    const registrationA = { ownership: "picc-owned", name: "official", profileKey, source, selectedSnapshotId: "marketplace-a" } as const;
    const registrationB = { ...registrationA, selectedSnapshotId: "marketplace-b" as const };
    const snapshotA = { ownership: "picc-owned", marketplaceName: "official", profileKey, source, snapshotId: "marketplace-a", catalogDigest: digest("a"), provenance: { adapter: "public-https-catalog", immutableIdentity: source.url } } as const;
    expect(marketplaceCodec.decode(registrationA)).toMatchObject({ ok: true });
    expect(snapshotCodec.decode(snapshotA)).toMatchObject({ ok: true });
    const gitSnapshot = { ...snapshotA, source: { kind: "https-git", url: "https://git.example.org/catalog.git" }, provenance: { adapter: "anonymous-https-git", immutableIdentity: "a".repeat(40) } } as const;
    expect(snapshotCodec.decode(gitSnapshot)).toMatchObject({ ok: true });
    expect(snapshotCodec.decode({ ...gitSnapshot, provenance: { ...gitSnapshot.provenance, immutableIdentity: "branch-main" } })).toMatchObject({ ok: false });
    expect(ownedMarketplaceProjection([registrationA, registrationB], [snapshotA])).toEqual([]);
    expect(ownedMarketplaceProjection([registrationA], [])).toEqual([]);
    const conflictingSnapshot = { ...snapshotA, marketplaceName: "community", catalogDigest: digest("b") } as const;
    expect(ownedMarketplaceProjection([registrationA], [snapshotA, conflictingSnapshot])).toEqual([]);
    const generation = createExecutableAdmissionGenerationCodec(profileKey).decode({ ownership: "picc-owned", profileKey, generationId: "admission-current", members: [{ pluginId: "tool@official", scope: "project", checkoutFamilyKey, projectKey: checkoutFamilyKey, recordDigest: digest("e") }] });
    expect(generation).toMatchObject({ ok: true, value: { generationId: "admission-current" } });
    expect(createExecutableAdmissionGenerationCodec(profileKey).decode({ ownership: "picc-owned", profileKey, generationId: "admission-current", members: [{ pluginId: "tool@official", scope: "project", checkoutFamilyKey, projectKey: `checkout-${"d".repeat(43)}`, recordDigest: digest("e") }] })).toMatchObject({ ok: false });
    expect(JSON.stringify(generation)).not.toContain("marketplace-a");
  });

  it("projects imported evidence without inventing optional timestamps and rejects owner/scope conflicts", () => {
    const locations = createLifecycleLocations({ homeDir: "/home", profilePath: "/home/.claude", platform: "posix", project: { activeCheckoutPath: "/project", checkoutFamilyPath: "/project/.git" } });
    if (!locations.ok) throw new Error("locations");
    const imported = { pluginId: "imported@official", scope: "user" as const, installPath: path.resolve("cache/imported"), version: "1", provenance: { statePath: path.resolve("installed_plugins.json"), stateVersion: 2, installedAt: "not-a-canonical-date" } };
    const owned = { record: { ...installation(), checkoutFamilyKey: locations.value.checkoutFamilyKey, projectKey: locations.value.checkoutFamilyKey }, recordDigest: digest("e") };
    const projected = projectOwnedAndImportedInstallations({ imported: [imported], owned: [owned], locations: locations.value, projectPath: path.resolve("project") });
    expect(projected.projections[0]).toMatchObject({ ownership: "claude-imported-readonly", installation: { provenance: { installedAt: "not-a-canonical-date" } } });
    expect(projected.projections[0]).not.toHaveProperty("installation.provenance.lastUpdated");
    const conflict = projectOwnedAndImportedInstallations({ imported: [{ ...imported, pluginId: "tool@official", scope: "project", projectPath: path.resolve(".") }], owned: [owned], locations: locations.value, projectPath: path.resolve(".") });
    expect(conflict.conflicts).toEqual(["tool@official:project"]);
    expect(conflict.projections).toEqual([]);
    const differentCheckout = projectOwnedAndImportedInstallations({ imported: [{ ...imported, pluginId: "tool@official", scope: "project", projectPath: path.resolve("different-checkout") }], owned: [owned], locations: locations.value, projectPath: path.resolve(".") });
    expect(differentCheckout.conflicts).toEqual([]);
    expect(differentCheckout.projections).toHaveLength(2);
    const differentScope = projectOwnedAndImportedInstallations({ imported: [{ ...imported, pluginId: "tool@official", scope: "local", projectPath: path.resolve(".") }], owned: [owned], locations: locations.value, projectPath: path.resolve(".") });
    expect(differentScope.conflicts).toEqual([]);
    expect(differentScope.projections).toHaveLength(2);
    const otherFamily = { record: { ...owned.record, checkoutFamilyKey: checkoutFamilyKey, projectKey: checkoutFamilyKey }, recordDigest: digest("e") };
    expect(projectOwnedAndImportedInstallations({ imported: [], owned: [otherFamily], locations: locations.value, projectPath: path.resolve(".") }).projections).toEqual([]);
    const mismatchedProject = { record: { ...owned.record, projectKey: checkoutFamilyKey }, recordDigest: digest("e") };
    expect(projectOwnedAndImportedInstallations({ imported: [], owned: [mismatchedProject], locations: locations.value, projectPath: path.resolve(".") }).projections).toEqual([]);
  });

  it("fails closed for every dependency graph and effective posture", () => {
    const owned = (dependencies?: DependencyAdmissionCandidate["dependencies"]): DependencyAdmissionCandidate => ({ pluginId: "tool@official", version: "1.0.0", enabled: true, ownership: "picc-owned", dependencies, dependencyDeclaration: dependencies === undefined ? "absent" : "complete", allowedCrossMarketplaceDependencies: [] });
    const dependency: DependencyAdmissionCandidate = { pluginId: "base@official", version: "2.0.0", enabled: true, ownership: "claude-imported-readonly" };
    const declared = [{ name: "base", marketplace: "official", version: "^2.0.0", itemIndex: 0 }];
    expect(admitDependencyGraph([owned(declared), dependency]).find((item) => item.pluginId === "tool@official")).toMatchObject({ admitted: true });
    expect(admitDependencyGraph([owned(declared)]).find((item) => item.pluginId === "tool@official")?.reasons).toContain("missing");
    expect(admitDependencyGraph([owned(declared), { ...dependency, enabled: false }]).find((item) => item.pluginId === "tool@official")?.reasons).toContain("disabled");
    expect(admitDependencyGraph([owned(declared), { ...dependency, version: "1.0.0" }]).find((item) => item.pluginId === "tool@official")?.reasons).toContain("incompatible");
    expect(admitDependencyGraph([owned([{ ...declared[0]!, version: "not a range" }]), dependency]).find((item) => item.pluginId === "tool@official")?.reasons).toContain("indeterminate");
    expect(admitDependencyGraph([owned([{ name: "tool", marketplace: "official", itemIndex: 0 }])]).find((item) => item.pluginId === "tool@official")?.reasons).toContain("cyclic");
    const cycle = admitDependencyGraph([owned([{ name: "base", itemIndex: 0 }]), { ...dependency, ownership: "picc-owned", dependencies: [{ name: "tool", itemIndex: 0 }] }]);
    expect(cycle.every((item) => item.reasons.includes("cyclic"))).toBe(true);
    expect(admitDependencyGraph([owned([{ name: "bad name", itemIndex: 0 }])]).find((item) => item.pluginId === "tool@official")?.reasons).toContain("disallowed");
    for (const dependencyDeclaration of ["invalid", "truncated", undefined] as const) {
      expect(admitDependencyGraph([{ ...owned(declared), dependencyDeclaration }, dependency]).find((item) => item.pluginId === "tool@official")?.reasons).toContain("indeterminate");
    }
    const crossDependency = { ...dependency, pluginId: "base@community" };
    const crossOwned = { ...owned([{ name: "base", marketplace: "community", itemIndex: 0 }]), allowedCrossMarketplaceDependencies: [] };
    expect(admitDependencyGraph([crossOwned, crossDependency]).find((item) => item.pluginId === "tool@official")?.reasons).toContain("disallowed");
    expect(admitDependencyGraph([{ ...crossOwned, allowedCrossMarketplaceDependencies: ["community"] }, crossDependency]).find((item) => item.pluginId === "tool@official")).toMatchObject({ admitted: true });
  });

  it("preserves explicit settings and uses only the applicable highest owned default winner", () => {
    const owned = { ownership: "picc-owned", pluginId: "tool@official", scope: "project", projectPath: path.resolve("project"), installPath: installRoot, version: "1.2.3", dataPath: path.resolve("data"), profileRoot: path.resolve("profile"), dataRoot: path.resolve("profile/data"), executableGenerationId: "admission-current", allowedCrossMarketplaceDependencies: [], marketplaceDefaultEnabled: false, authority: { record: installation(), recordDigest: digest("e") } } as const;
    expect(assembledEnablement({ projections: [owned], explicit: {} })["tool@official"]?.enabled).toBe(false);
    expect(assembledEnablement({ projections: [owned], explicit: { "tool@official": { enabled: true, scope: "local", source: "settings.local.json" } } })["tool@official"]).toMatchObject({ enabled: true, source: "settings.local.json" });
    const unrelatedImported = { ownership: "claude-imported-readonly" as const, installation: { pluginId: "tool@official", scope: "local" as const, projectPath: path.resolve("unrelated"), installPath: path.resolve("imported"), version: "1", provenance: { statePath: path.resolve("state.json"), stateVersion: 2 } } };
    expect(assembledEnablement({ projections: [owned, unrelatedImported], explicit: {}, projectPath: path.resolve("project") })["tool@official"]?.enabled).toBe(false);
    const higher = { ...owned, scope: "local" as const, marketplaceDefaultEnabled: true };
    const lower = { ...owned, scope: "project" as const, marketplaceDefaultEnabled: undefined };
    expect(assembledEnablement({ projections: [lower, higher], explicit: {}, projectPath: path.resolve("project") })["tool@official"]?.enabled).toBe(true);
  });
});

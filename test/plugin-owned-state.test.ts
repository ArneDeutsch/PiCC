import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExecutableAdmissionGenerationCodec, createMarketplaceSnapshotTrustGrant, createOwnedMarketplaceCodec, createOwnedMarketplaceSnapshotCodec, createOwnedPluginInstallationCodec, ownedMarketplaceScopeKey, ownedMarketplaceSnapshotScopeKey, readOwnedAdmissionRecords, reopenAdmittedMarketplaceSnapshot, type MarketplaceSnapshotTrustTarget, type OwnedPluginInstallationRecord } from "../src/plugin-lifecycle/admission.js";
import { assembledEnablement, ownedMarketplaceProjection, projectOwnedAndImportedInstallations } from "../src/plugin-lifecycle/projection.js";
import { createLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { admitDependencyGraph, type DependencyAdmissionCandidate } from "../src/plugin-lifecycle/dependency-admission.js";
import { digestArtifactEntries, type ArtifactDigestEntry } from "../src/plugin-lifecycle/artifact-digest.js";
import type { LifecycleProfileKey, Sha256 } from "../src/plugin-lifecycle/types.js";
import { createProducerCodecRegistry, createRecordEnvelope, establishOwnedStateStore, ownedRecordPartition } from "../src/plugin-lifecycle/state-store.js";
import { acquireMarketplaceRelativePlugin } from "../src/plugin-lifecycle/marketplace-generation.js";

const digest = (character: string): Sha256 => `sha256:${character.repeat(64)}` as Sha256;
const marketplaceSnapshotId = (...parts: readonly string[]): `marketplace-${string}` => `marketplace-${createHash("sha256").update(parts.join("\0")).digest("base64url")}`;
const profileKey = `profile-${"p".repeat(43)}` as LifecycleProfileKey;
const checkoutFamilyKey = `checkout-${"c".repeat(43)}` as const;
const artifactsRoot = path.resolve("owned-artifacts");
const installRoot = path.join(artifactsRoot, digest("b").slice(7), "selected");

function installation(source: OwnedPluginInstallationRecord["source"] = {
  kind: "git", marketplaceName: "official", declaration: { kind: "https-git", url: "https://git.example.org/tool.git", sha: "a".repeat(40) }, commit: "a".repeat(40), marketplaceSnapshotId: "marketplace-snapshotA", catalogDigest: digest("f"),
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

const snapshotSource = { kind: "https-catalog", url: "https://catalog.example.org/catalog.json" } as const;
const snapshotTarget: MarketplaceSnapshotTrustTarget = { authorityKind: "catalog-only", marketplaceName: "official", snapshotId: "marketplace-snapshotA", source: snapshotSource, catalogDigest: digest("f"), provenance: { adapter: "public-https-catalog", canonicalUrl: snapshotSource.url } };
const snapshotGrant = createMarketplaceSnapshotTrustGrant(snapshotTarget); if (!snapshotGrant.ok) throw new Error(snapshotGrant.message);
const snapshotAuthority = { ownership: "picc-owned", profileKey, ...snapshotTarget, trust: snapshotGrant.value } as const;
const codec = createOwnedPluginInstallationCodec({ profileKey, artifactsRoot, marketplaceSnapshots: { "marketplace-snapshotA": [snapshotAuthority] } });

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
    expect(createOwnedPluginInstallationCodec({ profileKey, artifactsRoot, marketplaceSnapshots: { "marketplace-snapshotA": [{ ...snapshotAuthority, catalogDigest: digest("e") }] } }).decode(base)).toMatchObject({ ok: false });
    expect(createOwnedPluginInstallationCodec({ profileKey, artifactsRoot, marketplaceSnapshots: { "marketplace-snapshotA": [{ ...snapshotAuthority, marketplaceName: "community" }] } }).decode(base)).toMatchObject({ ok: false });
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

  it("binds marketplace registration scope and partition authority without cross-scope conflicts", () => {
    const marketplaceCodec = createOwnedMarketplaceCodec(profileKey);
    const source = { kind: "https-catalog", url: "https://catalog.example.org/catalog.json" } as const; const selectedSnapshotId = marketplaceSnapshotId(digest("a"), source.url);
    const user = { ownership: "picc-owned", name: "official", profileKey, scope: "user", source, selectedSnapshotId } as const;
    const project = { ...user, scope: "project", checkoutFamilyKey, projectKey: checkoutFamilyKey } as const; const local = { ...project, scope: "local" } as const;
    expect(marketplaceCodec.decode(user)).toMatchObject({ ok: true });
    expect(marketplaceCodec.decode(project)).toMatchObject({ ok: true });
    expect(marketplaceCodec.decode(local)).toMatchObject({ ok: true });
    for (const candidate of [
      { ...user, checkoutFamilyKey }, { ...user, projectKey: checkoutFamilyKey }, { ...user, scope: "project" },
      { ...project, checkoutFamilyKey: `checkout-${"d".repeat(43)}` }, { ...project, projectKey: `checkout-${"d".repeat(43)}` },
      { ...project, profileKey: `profile-${"x".repeat(43)}` }, { ...project, selectedSnapshotId: "selection" },
    ]) expect(marketplaceCodec.decode(candidate)).toMatchObject({ ok: false });
    expect(new Set([ownedMarketplaceScopeKey(user), ownedMarketplaceScopeKey(project), ownedMarketplaceScopeKey(local)])).toHaveProperty("size", 3);
    const refreshedUser = { ...user, selectedSnapshotId: "marketplace-b" as const };
    expect(ownedMarketplaceScopeKey(user)).toBe(ownedMarketplaceScopeKey(refreshedUser));

    const target: MarketplaceSnapshotTrustTarget = { authorityKind: "catalog-only", marketplaceName: "official", snapshotId: selectedSnapshotId, source, catalogDigest: digest("a"), provenance: { adapter: "public-https-catalog", canonicalUrl: source.url } };
    const trust = createMarketplaceSnapshotTrustGrant(target); if (!trust.ok) throw new Error(trust.message);
    const snapshot = { ownership: "picc-owned", profileKey, ...target, trust: trust.value } as const;
    expect(ownedMarketplaceProjection([user, project, local], [snapshot], { checkoutFamilyKey, projectKey: checkoutFamilyKey })).toEqual([local, project, user]);
    const foreignFamily = `checkout-${"d".repeat(43)}` as const; const foreign = { ...project, checkoutFamilyKey: foreignFamily, projectKey: foreignFamily } as const;
    expect(ownedMarketplaceProjection([user, project, foreign], [snapshot], { checkoutFamilyKey, projectKey: checkoutFamilyKey })).toEqual([project, user]);
    expect(ownedMarketplaceProjection([{ ...user, selectedSnapshotId: "marketplace-b" }, user], [snapshot], { checkoutFamilyKey, projectKey: checkoutFamilyKey })).toEqual([]);
    expect(ownedMarketplaceProjection([user], [], { checkoutFamilyKey, projectKey: checkoutFamilyKey })).toEqual([]);
    const independentSnapshot = { ...snapshot, marketplaceName: "community" } as const;
    expect(ownedMarketplaceProjection([user], [snapshot, independentSnapshot], { checkoutFamilyKey, projectKey: checkoutFamilyKey })).toEqual([user]);
    const otherSource = { kind: "https-catalog", url: "https://mirror.example.org/catalog.json" } as const;
    const otherTarget = { ...target, source: otherSource } satisfies MarketplaceSnapshotTrustTarget; const otherTrust = createMarketplaceSnapshotTrustGrant(otherTarget); if (!otherTrust.ok) throw new Error(otherTrust.message);
    expect(ownedMarketplaceProjection([user], [snapshot, { ownership: "picc-owned", profileKey, ...otherTarget, trust: otherTrust.value }], { checkoutFamilyKey, projectKey: checkoutFamilyKey })).toEqual([user]);
  });

  it("admits only exact catalog-only or materialized marketplace snapshot authority and trust", () => {
    const snapshotCodec = createOwnedMarketplaceSnapshotCodec({ profileKey, artifactsRoot });
    const httpsSource = { kind: "https-catalog", url: "https://catalog.example.org/catalog.json" } as const; const reviewedFinalUrl = "https://cdn.example.org/catalog.json";
    const catalogTarget: MarketplaceSnapshotTrustTarget = { authorityKind: "catalog-only", marketplaceName: "official", snapshotId: marketplaceSnapshotId(digest("a"), reviewedFinalUrl), source: httpsSource, catalogDigest: digest("a"), provenance: { adapter: "public-https-catalog", canonicalUrl: reviewedFinalUrl } };
    const catalogTrust = createMarketplaceSnapshotTrustGrant(catalogTarget); if (!catalogTrust.ok) throw new Error(catalogTrust.message);
    const catalogSnapshot = { ownership: "picc-owned", profileKey, ...catalogTarget, trust: catalogTrust.value } as const;
    expect(snapshotCodec.decode(catalogSnapshot)).toMatchObject({ ok: true, value: { source: httpsSource, provenance: { canonicalUrl: reviewedFinalUrl } } });
    for (const canonicalUrl of [
      "http://cdn.example.org/catalog.json",
      "https://user:secret@cdn.example.org/catalog.json",
      "https://cdn.example.org/catalog.json?token=secret",
      "https://cdn.example.org/catalog.json#section",
      "https://127.0.0.1/catalog.json",
      "https://catalog.internal/catalog.json",
      "https://catalog/catalog.json",
      "https://catalog.example/catalog.json",
      "https://cdn.example.org:9443/catalog.json",
    ]) {
      const target = { ...catalogTarget, snapshotId: marketplaceSnapshotId(digest("a"), canonicalUrl), provenance: { adapter: "public-https-catalog" as const, canonicalUrl } } satisfies MarketplaceSnapshotTrustTarget;
      const trust = createMarketplaceSnapshotTrustGrant(target); if (!trust.ok) throw new Error(trust.message);
      expect(snapshotCodec.decode({ ownership: "picc-owned", profileKey, ...target, trust: trust.value }), canonicalUrl).toMatchObject({ ok: false });
    }
    const acceptedPortUrl = "https://cdn.example.org:8443/catalog.json"; const acceptedPortTarget = { ...catalogTarget, snapshotId: marketplaceSnapshotId(digest("a"), acceptedPortUrl), provenance: { adapter: "public-https-catalog" as const, canonicalUrl: acceptedPortUrl } } satisfies MarketplaceSnapshotTrustTarget; const acceptedPortTrust = createMarketplaceSnapshotTrustGrant(acceptedPortTarget); if (!acceptedPortTrust.ok) throw new Error(acceptedPortTrust.message);
    expect(snapshotCodec.decode({ ownership: "picc-owned", profileKey, ...acceptedPortTarget, trust: acceptedPortTrust.value })).toMatchObject({ ok: true });
    for (const declaredUrl of ["https://catalog.example.org:8443/catalog.json", "https://catalog.example.org:9443/catalog.json"] as const) {
      const target = { ...catalogTarget, source: { kind: "https-catalog" as const, url: declaredUrl } } satisfies MarketplaceSnapshotTrustTarget; const trust = createMarketplaceSnapshotTrustGrant(target); if (!trust.ok) throw new Error(trust.message);
      expect(snapshotCodec.decode({ ownership: "picc-owned", profileKey, ...target, trust: trust.value }), declaredUrl).toMatchObject({ ok: declaredUrl.includes(":8443/") });
    }
    for (const manufactured of [
      { ...catalogSnapshot, artifactDigest: digest("b") }, { ...catalogSnapshot, treeDigest: digest("b") }, { ...catalogSnapshot, rootDigest: digest("b") },
      { ...catalogSnapshot, artifactRoot: artifactsRoot }, { ...catalogSnapshot, catalogRelativePath: ".claude-plugin/marketplace.json" },
      { ...catalogSnapshot, selectedRoot: { requested: "tree-root", path: "", usedSingleWrapper: false } }, { ...catalogSnapshot, installRoot: artifactsRoot },
      { ...catalogSnapshot, provenance: { ...catalogTarget.provenance, canonicalUrl: "https://redirect.example.org/catalog.json" } },
      { ...catalogSnapshot, trust: { ...catalogTrust.value, kind: "confirmed-marketplace-snapshot-trust" } },
      { ...catalogSnapshot, trust: { ...catalogTrust.value, target: { ...catalogTarget, catalogDigest: digest("c") } } },
    ]) expect(snapshotCodec.decode(manufactured)).toMatchObject({ ok: false });

    const gitSource = { kind: "https-git", url: "https://git.example.org/catalog.git" } as const;
    const artifactRoot = path.join(artifactsRoot, digest("b").slice(7));
    const commit = "a".repeat(40); const materializedTarget: MarketplaceSnapshotTrustTarget = { authorityKind: "materialized", marketplaceName: "official", snapshotId: marketplaceSnapshotId(commit, digest("a"), digest("b")), source: gitSource, catalogDigest: digest("a"), artifactDigest: digest("b"), treeDigest: digest("b"), rootDigest: digest("b"), selectedRoot: { requested: "tree-root", path: "", usedSingleWrapper: false }, artifactRoot, installRoot: artifactRoot, catalogRelativePath: ".claude-plugin/marketplace.json", provenance: { adapter: "anonymous-https-git", commit, artifactDigest: digest("b") } };
    const materializedTrust = createMarketplaceSnapshotTrustGrant(materializedTarget); if (!materializedTrust.ok) throw new Error(materializedTrust.message);
    const materializedSnapshot = { ownership: "picc-owned", profileKey, ...materializedTarget, trust: materializedTrust.value } as const;
    expect(snapshotCodec.decode(materializedSnapshot)).toMatchObject({ ok: true });
    expect(ownedMarketplaceSnapshotScopeKey(materializedSnapshot)).not.toBe(ownedMarketplaceSnapshotScopeKey({ ...materializedSnapshot, snapshotId: "marketplace-other" }));
    expect(ownedMarketplaceSnapshotScopeKey(materializedSnapshot)).not.toBe(ownedMarketplaceSnapshotScopeKey({ ...materializedSnapshot, source: { ...gitSource, url: "https://git.example.org/other.git" } }));
    const mutations: Array<[string, unknown]> = [
      ["authorityKind", "catalog-only"], ["marketplaceName", "community"], ["snapshotId", "marketplace-other"], ["source.url", "https://git.example.org/other.git"],
      ["catalogDigest", digest("c")], ["artifactDigest", digest("c")], ["treeDigest", digest("c")], ["rootDigest", digest("c")],
      ["selectedRoot.path", "nested"], ["selectedRoot.usedSingleWrapper", true], ["artifactRoot", path.resolve("other")], ["installRoot", path.resolve("other")],
      ["catalogRelativePath", "../marketplace.json"], ["catalogRelativePath", "marketplace.json"], ["provenance.adapter", "local-directory-snapshot"], ["provenance.commit", "branch-main"], ["provenance.artifactDigest", digest("c")],
      ["trust.kind", "confirmed-marketplace-snapshot-trust"], ["trust.targetDigest", digest("c")], ["trust.target.marketplaceName", "community"], ["trust.target.snapshotId", "marketplace-other"], ["trust.target.source.url", "https://git.example.org/other.git"],
      ["trust.target.catalogDigest", digest("c")], ["trust.target.artifactDigest", digest("c")], ["trust.target.treeDigest", digest("c")], ["trust.target.rootDigest", digest("c")], ["trust.target.selectedRoot.path", "nested"], ["trust.target.artifactRoot", path.resolve("other")], ["trust.target.installRoot", path.resolve("other")], ["trust.target.catalogRelativePath", "marketplace.json"], ["trust.target.provenance.commit", "b".repeat(40)],
    ];
    for (const [field, value] of mutations) expect(snapshotCodec.decode(mutate(materializedSnapshot as unknown as OwnedPluginInstallationRecord, field, value)), `stale grant: ${field}`).toMatchObject({ ok: false });
    const resignedInvalidTargets: MarketplaceSnapshotTrustTarget[] = [
      { ...(materializedTarget as Extract<MarketplaceSnapshotTrustTarget, { readonly authorityKind: "materialized" }>), rootDigest: digest("c") },
      { ...(materializedTarget as Extract<MarketplaceSnapshotTrustTarget, { readonly authorityKind: "materialized" }>), artifactDigest: digest("c"), provenance: { ...materializedTarget.provenance, artifactDigest: digest("c") } },
      { ...(materializedTarget as Extract<MarketplaceSnapshotTrustTarget, { readonly authorityKind: "materialized" }>), selectedRoot: { requested: "tree-root", path: "nested", usedSingleWrapper: false } },
      { ...(materializedTarget as Extract<MarketplaceSnapshotTrustTarget, { readonly authorityKind: "materialized" }>), artifactRoot: path.resolve("outside-artifact") },
      { ...(materializedTarget as Extract<MarketplaceSnapshotTrustTarget, { readonly authorityKind: "materialized" }>), installRoot: path.resolve("outside-install") },
      { ...(materializedTarget as Extract<MarketplaceSnapshotTrustTarget, { readonly authorityKind: "materialized" }>), provenance: { ...materializedTarget.provenance, artifactDigest: digest("c") } },
      { ...(materializedTarget as Extract<MarketplaceSnapshotTrustTarget, { readonly authorityKind: "materialized" }>), source: { kind: "local-directory", path: path.resolve("catalog") }, provenance: materializedTarget.provenance },
      { ...(materializedTarget as Extract<MarketplaceSnapshotTrustTarget, { readonly authorityKind: "materialized" }>), provenance: { adapter: "anonymous-https-git", commit: "b".repeat(40), artifactDigest: digest("b") } },
      { ...(materializedTarget as Extract<MarketplaceSnapshotTrustTarget, { readonly authorityKind: "materialized" }>), catalogRelativePath: "marketplace.json" },
    ];
    for (const target of resignedInvalidTargets) { const grant = createMarketplaceSnapshotTrustGrant(target); if (!grant.ok) throw new Error(grant.message); expect(snapshotCodec.decode({ ownership: "picc-owned", profileKey, ...target, trust: grant.value })).toMatchObject({ ok: false }); }
    expect(snapshotCodec.decode({ ...materializedSnapshot, provenance: { ...materializedTarget.provenance, canonicalPath: path.resolve("mutable-source") } })).toMatchObject({ ok: false });
    expect(snapshotCodec.decode({ ...materializedSnapshot, trust: { ...materializedTrust.value, kind: "pending-marketplace-snapshot-trust" } })).toMatchObject({ ok: false });
    const localSource = { kind: "local-catalog-file", path: path.resolve("catalogs", "official.json") } as const; const localTarget: MarketplaceSnapshotTrustTarget = { ...(materializedTarget as Extract<MarketplaceSnapshotTrustTarget, { readonly authorityKind: "materialized" }>), snapshotId: marketplaceSnapshotId(digest("a"), digest("b")), source: localSource, catalogRelativePath: "official.json", provenance: { adapter: "local-catalog-snapshot", artifactDigest: digest("b") } }; const localTrust = createMarketplaceSnapshotTrustGrant(localTarget); if (!localTrust.ok) throw new Error(localTrust.message); const localSnapshot = { ownership: "picc-owned", profileKey, ...localTarget, trust: localTrust.value } as const;
    expect(snapshotCodec.decode(localSnapshot)).toMatchObject({ ok: true });
    expect(snapshotCodec.decode({ ...localSnapshot, catalogRelativePath: ".claude-plugin/marketplace.json" })).toMatchObject({ ok: false });
    const sourceFamilies = [
      { source: { kind: "local-directory", path: path.resolve("catalogs", "official") } as const, provenance: { adapter: "local-directory-snapshot" as const, artifactDigest: digest("b") }, id: marketplaceSnapshotId(digest("a"), digest("b")) },
      { source: { kind: "github", repository: "owner/catalog" } as const, provenance: { adapter: "anonymous-https-git" as const, commit, artifactDigest: digest("b") }, id: marketplaceSnapshotId(commit, digest("a"), digest("b")) },
    ];
    for (const family of sourceFamilies) {
      const target: MarketplaceSnapshotTrustTarget = { ...(materializedTarget as Extract<MarketplaceSnapshotTrustTarget, { readonly authorityKind: "materialized" }>), source: family.source, provenance: family.provenance, snapshotId: family.id };
      const grant = createMarketplaceSnapshotTrustGrant(target); if (!grant.ok) throw new Error(grant.message);
      expect(snapshotCodec.decode({ ownership: "picc-owned", profileKey, ...target, trust: grant.value })).toMatchObject({ ok: true });
    }
    const staleReviewedTarget = { ...catalogTarget, provenance: { ...catalogTarget.provenance, canonicalUrl: "https://redirect.example.org/catalog.json" } } satisfies MarketplaceSnapshotTrustTarget;
    const staleReviewedTrust = createMarketplaceSnapshotTrustGrant(staleReviewedTarget); if (!staleReviewedTrust.ok) throw new Error(staleReviewedTrust.message);
    expect(snapshotCodec.decode({ ownership: "picc-owned", profileKey, ...staleReviewedTarget, trust: staleReviewedTrust.value })).toMatchObject({ ok: false });
    const reboundSource = { kind: "https-catalog", url: "https://rebound.example.org/catalog.json" } as const;
    expect(snapshotCodec.decode({ ...catalogSnapshot, source: reboundSource })).toMatchObject({ ok: false });
    const unsafeReboundTarget = { ...catalogTarget, source: { kind: "https-catalog", url: "http://rebound.example.org/catalog.json" } } as MarketplaceSnapshotTrustTarget; const unsafeReboundTrust = createMarketplaceSnapshotTrustGrant(unsafeReboundTarget); if (!unsafeReboundTrust.ok) throw new Error(unsafeReboundTrust.message);
    expect(snapshotCodec.decode({ ownership: "picc-owned", profileKey, ...unsafeReboundTarget, trust: unsafeReboundTrust.value })).toMatchObject({ ok: false });

    const generation = createExecutableAdmissionGenerationCodec(profileKey).decode({ ownership: "picc-owned", profileKey, generationId: "admission-current", members: [{ pluginId: "tool@official", scope: "project", checkoutFamilyKey, projectKey: checkoutFamilyKey, recordDigest: digest("e") }] });
    expect(generation).toMatchObject({ ok: true, value: { generationId: "admission-current" } });
    expect(JSON.stringify(generation)).not.toContain("marketplace-a");
  });

  it("binds relative installation authority to one retained materialized catalog declaration", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "picc-relative-admission-"));
    try {
      const ownedArtifacts = path.join(parent, "artifacts"); const catalog = Buffer.from(JSON.stringify({ name: "official", metadata: { pluginRoot: "plugins" }, plugins: [{ name: "tool", source: "./tool" }] }));
      const entries: ArtifactDigestEntry[] = [{ path: ".claude-plugin", kind: "directory" }, { path: ".claude-plugin/marketplace.json", kind: "file", data: catalog }, { path: "plugins", kind: "directory" }, { path: "plugins/tool", kind: "directory" }];
      const treeDigest = digestArtifactEntries(entries); const artifactRoot = path.join(ownedArtifacts, treeDigest.slice(7)); fs.mkdirSync(path.join(artifactRoot, ".claude-plugin"), { recursive: true }); fs.mkdirSync(path.join(artifactRoot, "plugins", "tool"), { recursive: true }); fs.writeFileSync(path.join(artifactRoot, ".claude-plugin", "marketplace.json"), catalog);
      const rawCatalogDigest = `sha256:${createHash("sha256").update(catalog).digest("hex")}` as Sha256;
      const source = { kind: "local-directory", path: path.join(parent, "source") } as const; const snapshotId = marketplaceSnapshotId(rawCatalogDigest, treeDigest);
      const target: MarketplaceSnapshotTrustTarget = { authorityKind: "materialized", marketplaceName: "official", snapshotId, source, catalogDigest: rawCatalogDigest, artifactDigest: treeDigest, treeDigest, rootDigest: treeDigest, selectedRoot: { requested: "tree-root", path: "", usedSingleWrapper: false }, artifactRoot, installRoot: artifactRoot, catalogRelativePath: ".claude-plugin/marketplace.json", provenance: { adapter: "local-directory-snapshot", artifactDigest: treeDigest } };
      const grant = createMarketplaceSnapshotTrustGrant(target); if (!grant.ok) throw new Error(grant.message); const snapshot = { ownership: "picc-owned", profileKey, ...target, trust: grant.value } as const;
      const relative = installation({ kind: "marketplace-relative", marketplaceName: "official", path: "tool", pluginRoot: "plugins", marketplaceSnapshotId: snapshotId, catalogDigest: rawCatalogDigest });
      const record = { ...relative, artifactDigest: treeDigest, treeDigest, installRoot: path.join(artifactRoot, "plugins", "tool"), selectedRoot: { requested: "relative-subtree" as const, path: "plugins/tool", usedSingleWrapper: false }, trust: { ...relative.trust, artifactDigest: treeDigest, treeDigest, selectedRoot: { requested: "relative-subtree" as const, path: "plugins/tool", usedSingleWrapper: false } } };
      const relativeCodec = createOwnedPluginInstallationCodec({ profileKey, artifactsRoot: ownedArtifacts, marketplaceSnapshots: { [snapshotId]: [snapshot] } });
      expect(relativeCodec.decode(record)).toMatchObject({ ok: true });
      expect(relativeCodec.decode({ ...record, pluginId: "other@official", dataIdentity: { profileKey, identity: "other@official" }, trust: { ...record.trust, target: "other@official" } })).toMatchObject({ ok: false });
      const catalogOnly = snapshotAuthority; expect(createOwnedPluginInstallationCodec({ profileKey, artifactsRoot: ownedArtifacts, marketplaceSnapshots: { [snapshotId]: [catalogOnly] } }).decode(record)).toMatchObject({ ok: false });
      const expectRejectedDeclaration = (catalogValue: unknown): void => {
        const bytes = Buffer.from(JSON.stringify(catalogValue)); const candidateEntries: ArtifactDigestEntry[] = [{ path: ".claude-plugin", kind: "directory" }, { path: ".claude-plugin/marketplace.json", kind: "file", data: bytes }, { path: "plugins", kind: "directory" }, { path: "plugins/tool", kind: "directory" }];
        const candidateTree = digestArtifactEntries(candidateEntries); const candidateRoot = path.join(ownedArtifacts, candidateTree.slice(7)); fs.mkdirSync(path.join(candidateRoot, ".claude-plugin"), { recursive: true }); fs.mkdirSync(path.join(candidateRoot, "plugins", "tool"), { recursive: true }); fs.writeFileSync(path.join(candidateRoot, ".claude-plugin", "marketplace.json"), bytes);
        const candidateCatalogDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256; const candidateSnapshotId = marketplaceSnapshotId(candidateCatalogDigest, candidateTree); const candidateTarget: MarketplaceSnapshotTrustTarget = { authorityKind: "materialized", marketplaceName: "official", snapshotId: candidateSnapshotId, source, catalogDigest: candidateCatalogDigest, artifactDigest: candidateTree, treeDigest: candidateTree, rootDigest: candidateTree, selectedRoot: { requested: "tree-root", path: "", usedSingleWrapper: false }, artifactRoot: candidateRoot, installRoot: candidateRoot, catalogRelativePath: ".claude-plugin/marketplace.json", provenance: { adapter: "local-directory-snapshot", artifactDigest: candidateTree } }; const candidateGrant = createMarketplaceSnapshotTrustGrant(candidateTarget); if (!candidateGrant.ok) throw new Error(candidateGrant.message); const candidateSnapshot = { ownership: "picc-owned", profileKey, ...candidateTarget, trust: candidateGrant.value } as const;
        const candidateRelative = installation({ kind: "marketplace-relative", marketplaceName: "official", path: "tool", pluginRoot: "plugins", marketplaceSnapshotId: candidateSnapshotId, catalogDigest: candidateCatalogDigest }); const candidateRecord = { ...candidateRelative, artifactDigest: candidateTree, treeDigest: candidateTree, installRoot: path.join(candidateRoot, "plugins", "tool"), selectedRoot: { requested: "relative-subtree" as const, path: "plugins/tool", usedSingleWrapper: false }, trust: { ...candidateRelative.trust, artifactDigest: candidateTree, treeDigest: candidateTree, selectedRoot: { requested: "relative-subtree" as const, path: "plugins/tool", usedSingleWrapper: false } } };
        expect(createOwnedPluginInstallationCodec({ profileKey, artifactsRoot: ownedArtifacts, marketplaceSnapshots: { [candidateSnapshotId]: [candidateSnapshot] } }).decode(candidateRecord)).toMatchObject({ ok: false });
      };
      expectRejectedDeclaration({ name: "official", metadata: { pluginRoot: "plugins" }, plugins: [{ name: "tool", source: "./wrong" }] });
      expectRejectedDeclaration({ name: "official", metadata: { pluginRoot: "other" }, plugins: [{ name: "tool", source: "./tool" }] });
      expectRejectedDeclaration({ name: "official", metadata: { pluginRoot: "plugins" }, plugins: [{ name: "tool", source: { source: "github", repo: "owner/tool" } }] });
      expectRejectedDeclaration({ name: "official", metadata: { pluginRoot: "plugins" }, plugins: [{ name: "tool", source: "./tool" }, { name: "tool", source: "./tool" }] });
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });

  it("reopens only an authentic freshly revalidated retained materialized snapshot", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "picc-retained-snapshot-"));
    try {
      const home = path.join(parent, "home"); fs.mkdirSync(home, { mode: 0o700 });
      const locations = createLifecycleLocations({ homeDir: home, profilePath: path.join(home, ".claude"), platform: process.platform === "win32" ? "win32" : "posix" });
      if (!locations.ok) throw new Error(locations.error.message);
      const established = await establishOwnedStateStore(locations.value, home); if (!established.ok) throw new Error(established.message); const store = established.value;
      const mutableSource = path.join(parent, "mutable-source"); fs.mkdirSync(mutableSource);
      const catalog = Buffer.from(JSON.stringify({ name: "official", metadata: { pluginRoot: "plugins" }, plugins: [{ name: "tool", source: "./tool" }] }));
      const entries: ArtifactDigestEntry[] = [
        { path: ".claude-plugin", kind: "directory" }, { path: ".claude-plugin/marketplace.json", kind: "file", data: catalog },
        { path: "plugins", kind: "directory" }, { path: "plugins/tool", kind: "directory" }, { path: "plugins/tool/payload.txt", kind: "file", data: Buffer.from("retained") },
      ];
      const treeDigest = digestArtifactEntries(entries); const artifactRoot = path.join(store.artifactsRoot, treeDigest.slice(7));
      fs.mkdirSync(path.join(artifactRoot, ".claude-plugin"), { recursive: true }); fs.mkdirSync(path.join(artifactRoot, "plugins", "tool"), { recursive: true });
      fs.writeFileSync(path.join(artifactRoot, ".claude-plugin", "marketplace.json"), catalog); fs.writeFileSync(path.join(artifactRoot, "plugins", "tool", "payload.txt"), "retained");
      const catalogDigest = `sha256:${createHash("sha256").update(catalog).digest("hex")}` as Sha256;
      const source = { kind: "local-directory", path: mutableSource } as const; const snapshotId = marketplaceSnapshotId(catalogDigest, treeDigest);
      const target: MarketplaceSnapshotTrustTarget = { authorityKind: "materialized", marketplaceName: "official", snapshotId, source, catalogDigest, artifactDigest: treeDigest, treeDigest, rootDigest: treeDigest, selectedRoot: { requested: "tree-root", path: "", usedSingleWrapper: false }, artifactRoot, installRoot: artifactRoot, catalogRelativePath: ".claude-plugin/marketplace.json", provenance: { adapter: "local-directory-snapshot", artifactDigest: treeDigest } };
      const trust = createMarketplaceSnapshotTrustGrant(target); if (!trust.ok) throw new Error(trust.message);
      const snapshot = { ownership: "picc-owned", profileKey: store.profileKey as LifecycleProfileKey, ...target, trust: trust.value } as const;
      const snapshotCodec = createOwnedMarketplaceSnapshotCodec({ profileKey: snapshot.profileKey, artifactsRoot: store.artifactsRoot });
      const envelope = createRecordEnvelope(snapshotCodec, "picc-owned", ownedMarketplaceSnapshotScopeKey(snapshot), snapshot); if (!envelope.ok) throw new Error(envelope.message);
      const partition = ownedRecordPartition(store, "picc-owned", ownedMarketplaceSnapshotScopeKey(snapshot)); if (!partition.ok) throw new Error(partition.message);
      fs.mkdirSync(partition.value, { recursive: true }); const recordPath = path.join(partition.value, "snapshot.json"); fs.writeFileSync(recordPath, envelope.value.bytes);
      const registry = createProducerCodecRegistry([snapshotCodec]); if (!registry.ok) throw new Error(registry.message);
      const admitted = readOwnedAdmissionRecords(store, registry.value, undefined).marketplaceSnapshots[0]; if (admitted === undefined) throw new Error("snapshot was not admitted");

      const acquire = async (generation: Awaited<ReturnType<typeof reopenAdmittedMarketplaceSnapshot>>) => generation.ok
        ? acquireMarketplaceRelativePlugin(generation.value, "tool@official", { kind: "relative", path: "tool", pluginRoot: "plugins" }, { store })
        : undefined;
      fs.rmSync(mutableSource, { recursive: true, force: true });

      const otherHome = path.join(parent, "other-home"); fs.mkdirSync(otherHome, { mode: 0o700 });
      const otherLocations = createLifecycleLocations({ homeDir: otherHome, profilePath: path.join(otherHome, ".claude"), platform: process.platform === "win32" ? "win32" : "posix" });
      if (!otherLocations.ok) throw new Error(otherLocations.error.message);
      const otherEstablished = await establishOwnedStateStore(otherLocations.value, otherHome); if (!otherEstablished.ok) throw new Error(otherEstablished.message); const otherStore = otherEstablished.value;
      const otherStoreBefore = {
        artifacts: fs.readdirSync(otherStore.artifactsRoot),
        records: fs.readdirSync(otherStore.recordsRoot),
        staging: fs.readdirSync(otherStore.stagingRoot),
      };
      const wrongStoreGeneration = await reopenAdmittedMarketplaceSnapshot(admitted, store); if (!wrongStoreGeneration.ok) throw new Error(wrongStoreGeneration.message);
      expect(await acquireMarketplaceRelativePlugin(wrongStoreGeneration.value, "tool@official", { kind: "relative", path: "tool", pluginRoot: "plugins" }, { store: otherStore })).toMatchObject({ ok: false, error: { code: "unsafe-source" } });
      expect({
        artifacts: fs.readdirSync(otherStore.artifactsRoot),
        records: fs.readdirSync(otherStore.recordsRoot),
        staging: fs.readdirSync(otherStore.stagingRoot),
      }).toEqual(otherStoreBefore);
      expect(await acquireMarketplaceRelativePlugin(wrongStoreGeneration.value, "tool@official", { kind: "relative", path: "tool", pluginRoot: "plugins" }, { store })).toMatchObject({ ok: false, error: { code: "unsafe-source" } });

      const reopened = await reopenAdmittedMarketplaceSnapshot(admitted, store); expect(reopened).toMatchObject({ ok: true, value: { snapshotId } });
      const acquired = await acquire(reopened);
      expect(acquired?.ok && fs.readFileSync(path.join(acquired.value.materialized.pluginRoot, "payload.txt"), "utf8")).toBe("retained");
      expect(acquired).toMatchObject({ ok: true, value: {
        requestedPluginId: "tool@official", source: { kind: "relative", path: "tool", pluginRoot: "plugins" },
        artifactDigest: acquired?.ok ? acquired.value.treeDigest : undefined,
        provenance: { adapter: "marketplace-relative-tree", marketplaceSnapshotId: snapshotId, catalogDigest,
          reviewed: { kind: "retained-marketplace-snapshot", marketplaceName: "official", snapshotId, source, catalogDigest, artifactDigest: treeDigest, treeDigest } },
      } });
      if (reopened.ok) expect(await acquireMarketplaceRelativePlugin(reopened.value, "tool@official", { kind: "relative", path: "tool", pluginRoot: "plugins" }, { store })).toMatchObject({ ok: false, error: { code: "unsafe-source" } });
      expect(await reopenAdmittedMarketplaceSnapshot(structuredClone(admitted), store)).toMatchObject({ ok: false, code: "invalid-retained-snapshot" });
      expect(await reopenAdmittedMarketplaceSnapshot(admitted, { ...store } as never)).toMatchObject({ ok: false, code: "invalid-retained-snapshot" });

      const catalogSource = { kind: "https-catalog", url: "https://catalog.example.org/catalog.json" } as const;
      const catalogTarget: MarketplaceSnapshotTrustTarget = { authorityKind: "catalog-only", marketplaceName: "catalog-only", snapshotId: marketplaceSnapshotId(catalogDigest, catalogSource.url), source: catalogSource, catalogDigest, provenance: { adapter: "public-https-catalog", canonicalUrl: catalogSource.url } };
      const catalogTrust = createMarketplaceSnapshotTrustGrant(catalogTarget); if (!catalogTrust.ok) throw new Error(catalogTrust.message);
      const catalogSnapshot = { ownership: "picc-owned", profileKey: store.profileKey as LifecycleProfileKey, ...catalogTarget, trust: catalogTrust.value } as const;
      const catalogEnvelope = createRecordEnvelope(snapshotCodec, "picc-owned", ownedMarketplaceSnapshotScopeKey(catalogSnapshot), catalogSnapshot); if (!catalogEnvelope.ok) throw new Error(catalogEnvelope.message);
      const catalogPartition = ownedRecordPartition(store, "picc-owned", ownedMarketplaceSnapshotScopeKey(catalogSnapshot)); if (!catalogPartition.ok) throw new Error(catalogPartition.message);
      fs.mkdirSync(catalogPartition.value, { recursive: true }); fs.writeFileSync(path.join(catalogPartition.value, "snapshot.json"), catalogEnvelope.value.bytes);
      const admittedCatalog = readOwnedAdmissionRecords(store, registry.value, undefined).marketplaceSnapshots.find((item) => item.authorityKind === "catalog-only");
      if (admittedCatalog === undefined) throw new Error("catalog-only snapshot was not admitted");
      expect(await reopenAdmittedMarketplaceSnapshot(admittedCatalog, store)).toMatchObject({ ok: false, code: "invalid-retained-snapshot" });

      const removedGeneration = await reopenAdmittedMarketplaceSnapshot(admitted, store); fs.rmSync(recordPath);
      expect(await acquire(removedGeneration)).toMatchObject({ ok: false, error: { code: "unsafe-source" } }); fs.writeFileSync(recordPath, envelope.value.bytes);
      const replacedGeneration = await reopenAdmittedMarketplaceSnapshot(admitted, store); fs.writeFileSync(recordPath, catalogEnvelope.value.bytes);
      expect(await acquire(replacedGeneration)).toMatchObject({ ok: false, error: { code: "unsafe-source" } }); fs.writeFileSync(recordPath, envelope.value.bytes);
      const duplicateGeneration = await reopenAdmittedMarketplaceSnapshot(admitted, store); fs.copyFileSync(recordPath, path.join(partition.value, "duplicate.json"));
      expect(await acquire(duplicateGeneration)).toMatchObject({ ok: false, error: { code: "unsafe-source" } }); fs.rmSync(path.join(partition.value, "duplicate.json"));
      const malformedGeneration = await reopenAdmittedMarketplaceSnapshot(admitted, store); fs.writeFileSync(path.join(partition.value, "malformed.json"), "{");
      expect(await acquire(malformedGeneration)).toMatchObject({ ok: false, error: { code: "unsafe-source" } }); fs.rmSync(path.join(partition.value, "malformed.json"));

      const catalogGeneration = await reopenAdmittedMarketplaceSnapshot(admitted, store); fs.writeFileSync(path.join(artifactRoot, ".claude-plugin", "marketplace.json"), Buffer.concat([catalog, Buffer.from(" ")]));
      expect(await acquire(catalogGeneration)).toMatchObject({ ok: false, error: { code: "unsafe-source" } }); fs.writeFileSync(path.join(artifactRoot, ".claude-plugin", "marketplace.json"), catalog);
      const aliasGeneration = await reopenAdmittedMarketplaceSnapshot(admitted, store); const payload = path.join(artifactRoot, "plugins", "tool", "payload.txt"); const external = path.join(parent, "external-payload"); fs.writeFileSync(external, "retained"); fs.rmSync(payload); fs.linkSync(external, payload);
      expect(await acquire(aliasGeneration)).toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
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

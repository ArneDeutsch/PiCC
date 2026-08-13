import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMarketplaceSnapshotTrustGrant, createOwnedMarketplaceSnapshotCodec, ownedMarketplaceSnapshotScopeKey, type MarketplaceSnapshotTrustTarget } from "../src/plugin-lifecycle/admission.js";
import { createMarketplaceMutationPreview, createMarketplaceTransactionCodec, decodeMarketplaceMutationPreview, marketplacePreviewConfirmationDigest } from "../src/plugin-lifecycle/planner.js";
import { receiptMatchesPrepared } from "../src/plugin-lifecycle/service.js";
import { createRecordEnvelope, ownedRecordPartition, sha256, type OwnedStateStore } from "../src/plugin-lifecycle/state-store.js";
import type { TransactionParticipant, TransactionProducerCodec } from "../src/plugin-lifecycle/transaction.js";
import type { PluginSettingsEffectSummary } from "../src/plugin-lifecycle/settings-plan.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const source = { kind: "https-catalog", url: "https://catalog.example.org/catalog.json" } as const;
const target: MarketplaceSnapshotTrustTarget = { authorityKind: "catalog-only", marketplaceName: "official", snapshotId: `marketplace-${createHash("sha256").update(`${digest}\0${source.url}`).digest("base64url")}`, source, catalogDigest: digest, executableCatalog: { marketplaceName: "official", allowedCrossMarketplaceDependencies: [], declarations: [] }, provenance: { adapter: "public-https-catalog", canonicalUrl: source.url } };
const grant = createMarketplaceSnapshotTrustGrant(target); if (!grant.ok) throw new Error(grant.message);
const registration = { ownership: "picc-owned", name: "official", profileKey: "profile-test", scope: "user", source, selectedSnapshotId: target.snapshotId } as const;
const snapshot = { ownership: "picc-owned", profileKey: "profile-test", ...target, trust: grant.value } as const;
const effect = { scope: "user", targetPath: path.resolve("settings.json"), setting: "extraKnownMarketplaces", key: "official", requested: { kind: "url", url: source.url }, declarationBefore: { present: false }, declarationAfter: { present: true, value: { kind: "url", url: source.url }, scope: "user", source: path.resolve("settings.json") }, effectiveBefore: { present: false }, effectiveAfter: { present: true, value: { kind: "url", url: source.url }, scope: "user", source: path.resolve("settings.json") }, declarationOnly: false, effective: true } as const;
const participant = (order: number, role: "settings" | "snapshot" | "registration", effect: "replace" | "delete" = "replace") => ({ order, role, target: path.resolve(`${role}.json`), effect, scopeKey: role, stagedDigest: digest, payloadDigest: digest }) as const;
const catalog = { name: "official", ownerName: "Example", plugins: [{ name: "tool", supported: true, sourceKind: "npm" }], unsupportedEntries: 0, omittedEntries: 0 } as const;
const codecContext = { profileKey: "profile-test" as const, artifactsRoot: path.resolve("planner-artifacts") };
function preview() { const result = createMarketplaceMutationPreview({ operationId: "marketplace_test", action: "add", registration, snapshot, catalog, settingsEffect: effect, stateFingerprint: digest, settingsFingerprint: digest, dependents: [], acknowledgement: "preserve-installations", consequences: ["No plugins change"], participants: [participant(0, "settings"), participant(1, "snapshot"), participant(2, "registration")] }, codecContext); if (!result.ok) throw new Error(result.message); return result.value; }

describe("marketplace lifecycle planner", () => {
  it("binds complete source, scope, snapshot, trust, settings, consequences, and participant order", () => {
    const value = preview();
    const semanticallyInvalid: Record<string, unknown>[] = [
      { ...value, registration: { ...registration, scope: "project" } },
      { ...value, snapshot: { ...snapshot, catalogDigest: `sha256:${"b".repeat(64)}` } },
      { ...value, snapshot: { ...snapshot, trust: { ...snapshot.trust, targetDigest: `sha256:${"b".repeat(64)}` } } },
      { ...value, settingsEffect: { ...effect, key: "other" } }, { ...value, acknowledgement: "remove-installations" },
      { ...value, catalog: { ...catalog, plugins: [{ name: "tool", supported: true, sourceKind: "credential-provider" }] } },
      { ...value, dependents: ["plugin@other"] }, { ...value, dependents: ["plugin@official", "plugin@official"] },
      { ...value, participants: [value.participants[1], value.participants[0], value.participants[2]] },
      { ...value, participants: value.participants.map((item, index) => index === 2 ? { ...item, effect: "delete" } : item) },
    ];
    for (const mutation of semanticallyInvalid) {
      const { confirmationDigest: _old, ...without } = mutation; const resigned = marketplacePreviewConfirmationDigest(without as never); if (!resigned.ok) throw new Error(resigned.message);
      expect(decodeMarketplaceMutationPreview({ ...without, confirmationDigest: resigned.value }, codecContext).ok).toBe(false);
    }
    for (const mutation of [{ ...value, action: "refresh" }, { ...value, dependents: ["plugin@official"] }, { ...value, consequences: ["changed"] }, { ...value, confirmationDigest: `sha256:${"b".repeat(64)}` }, { ...value, extra: true }]) expect(decodeMarketplaceMutationPreview(mutation, codecContext).ok).toBe(false);
  });

  it("uses contextual t07 codecs for direct, stale-grant, and jointly resigned semantic tamper", () => {
    expect(grant.value.target).toEqual(target);
    expect(decodeMarketplaceMutationPreview({ ...preview(), snapshot: { ...snapshot, trust: { ...grant.value, target: { ...target, snapshotId: "marketplace-other" } } } }, codecContext).ok).toBe(false);
    const changedTarget = { ...target, provenance: { ...target.provenance, canonicalUrl: "https://redirect.example.org/catalog.json" } }; const changedGrant = createMarketplaceSnapshotTrustGrant(changedTarget); if (!changedGrant.ok) throw new Error(changedGrant.message);
    const changed = { ...preview(), snapshot: { ...snapshot, provenance: changedTarget.provenance, trust: changedGrant.value } }; const { confirmationDigest: _old, ...without } = changed; const resigned = marketplacePreviewConfirmationDigest(without); if (!resigned.ok) throw new Error(resigned.message);
    expect(decodeMarketplaceMutationPreview({ ...without, confirmationDigest: resigned.value }, codecContext)).toMatchObject({ ok: false, code: "invalid-preview" });
    expect(decodeMarketplaceMutationPreview(preview(), { ...codecContext, profileKey: "profile-other" })).toMatchObject({ ok: false });
  });

  it("requires exact plan, participants, and lock identity for terminal reuse", () => {
    const prepared = { operationId: "marketplace_terminal", producerSchema: "marketplace-lifecycle", producerVersion: 1, confirmationSummary: preview(), confirmationDigest: digest, planDigest: digest, participants: [{ role: "same-summary-plan-a" }], requiredLocks: [{ kind: "profile", key: "profile-test" }] } as unknown as import("../src/plugin-lifecycle/transaction.js").PreparedTransaction;
    const receipt = { ...prepared, format: "picc-transaction-receipt", formatVersion: 1, outcome: "committed", completed: 1, createdParents: [null], lockBindings: [] } as unknown as import("../src/plugin-lifecycle/transaction.js").TransactionReceipt;
    expect(receiptMatchesPrepared(receipt, prepared)).toBe(true); expect(receiptMatchesPrepared({ ...receipt, planDigest: `sha256:${"b".repeat(64)}` } as never, prepared)).toBe(false); expect(receiptMatchesPrepared({ ...receipt, participants: [{ role: "same-summary-plan-b" }] } as never, prepared)).toBe(false); expect(receiptMatchesPrepared({ ...receipt, requiredLocks: [{ kind: "profile", key: "profile-other" }] } as never, prepared)).toBe(false);
  });

  it("binds transaction-codec marketplace participants directly to t07 payload authority", () => {
    const root = path.resolve("planner-store"); const store = { profileKey: "profile-test", recordsRoot: path.join(root, "records"), artifactsRoot: path.join(root, "artifacts"), stagingRoot: path.join(root, "staging") } as OwnedStateStore;
    const settingsCodec: TransactionProducerCodec<PluginSettingsEffectSummary> = { schema: "settings", version: 1, decodeSummary: (raw) => ({ ok: true, value: raw as PluginSettingsEffectSummary }), validatePlan: () => ({ ok: true, value: undefined }), requiredLocks: () => ({ ok: true, value: [] }) };
    const codec = createMarketplaceTransactionCodec({ store, settingsCodec }); const scopeKey = ownedMarketplaceSnapshotScopeKey(snapshot); const partition = ownedRecordPartition(store, "picc-owned", scopeKey); if (!partition.ok) throw new Error(partition.message);
    const envelope = createRecordEnvelope(createOwnedMarketplaceSnapshotCodec({ profileKey: "profile-test", artifactsRoot: store.artifactsRoot }), "picc-owned", scopeKey, snapshot); if (!envelope.ok) throw new Error(envelope.message);
    const settings = { kind: "plugin-settings", key: "settings", ownerKey: "plugin-settings", scopeKey: "settings", targetPath: path.resolve("settings.json"), targetClass: "external", precondition: { state: "absent" }, stagedPath: path.resolve("settings.stage"), stagedDigest: digest, rollback: { kind: "delete-new-target" }, producerEvidence: {} } as TransactionParticipant;
    const participant = { kind: "marketplace-snapshot", key: "snapshot-official", ownerKey: "picc-owned", scopeKey, targetPath: path.join(partition.value, "record.json"), targetClass: "owned", precondition: { state: "absent" }, stagedPath: path.resolve("snapshot.stage"), stagedDigest: sha256(envelope.value.bytes), rollback: { kind: "delete-new-target" }, producerEvidence: { role: "snapshot", payload: snapshot } } as TransactionParticipant;
    expect(codec.validatePlan([settings, participant])).toMatchObject({ ok: true });
    expect(codec.validatePlan([settings, { ...participant, producerEvidence: { role: "snapshot", payload: { ...snapshot, catalogDigest: `sha256:${"b".repeat(64)}` } } }])).toMatchObject({ ok: false });
  });
});

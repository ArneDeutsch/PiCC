import path from "node:path";
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
import { isDocumentedMarketplaceName, type MarketplaceCatalogDeclarationSummary } from "../util/plugin-marketplace-descriptor.js";
import { isQualifiedPluginId } from "../util/plugin-id.js";
import { canonicalJsonBytes, createRecordEnvelope, ownedRecordPartition, sha256, type OwnedStateStore, type StoreResult } from "./state-store.js";
import type { PluginSettingsEffectSummary } from "./settings-plan.js";
import { isOwnedDataRetirementParticipant, type OrdinaryTransactionParticipant, type TransactionParticipant, type TransactionProducerCodec, type TransactionReceipt } from "./transaction.js";
import type { CatalogPluginSource, LifecycleProfileKey, Sha256 } from "./types.js";

export type MarketplaceMutationAction = "add" | "refresh" | "remove";
export interface MarketplaceParticipantSummary {
  readonly order: number;
  readonly role: "settings" | "snapshot" | "registration";
  readonly target: string;
  readonly effect: "replace" | "delete";
  readonly scopeKey: string;
  readonly stagedDigest: Sha256;
  readonly payloadDigest: Sha256;
}
export interface MarketplaceMutationPreview {
  readonly kind: "marketplace-mutation-preview";
  readonly version: 1;
  readonly operationId: string;
  readonly action: MarketplaceMutationAction;
  readonly registration: OwnedMarketplaceRecord;
  readonly snapshot: OwnedMarketplaceSnapshotRecord;
  readonly catalog: MarketplaceCatalogDeclarationSummary;
  readonly settingsEffect: PluginSettingsEffectSummary;
  readonly stateFingerprint: Sha256;
  readonly settingsFingerprint: Sha256;
  readonly dependents: readonly string[];
  readonly acknowledgement: "preserve-installations";
  readonly consequences: readonly string[];
  readonly participants: readonly MarketplaceParticipantSummary[];
  readonly confirmationDigest: Sha256;
}
export interface MarketplaceReceipt {
  readonly kind: "marketplace-receipt";
  readonly version: 1;
  readonly operationId: string;
  readonly summary: MarketplaceMutationPreview;
  readonly outcome: TransactionReceipt["outcome"];
  readonly completed: number;
  readonly failureCategory?: TransactionReceipt["failureCategory"];
  readonly planDigest: Sha256;
  readonly confirmationDigest: Sha256;
  readonly guidance?: string;
}

interface MarketplaceEvidence { readonly role: "snapshot" | "registration"; readonly payload: OwnedMarketplaceSnapshotRecord | OwnedMarketplaceRecord }
export interface MarketplaceCodecContext { readonly profileKey: LifecycleProfileKey; readonly artifactsRoot: string }
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CATALOG_SOURCE_KINDS = new Set<CatalogPluginSource["kind"]>(["relative", "github", "https-git", "https-git-subdir", "npm", "https-zip"]);
function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value: Record<string, unknown>, required: readonly string[]): boolean { const keys = Object.keys(value); return keys.length === required.length && required.every((key) => Object.hasOwn(value, key)); }
function same(left: unknown, right: unknown): boolean { const a = canonicalJsonBytes(left); const b = canonicalJsonBytes(right); return a.ok && b.ok && Buffer.from(a.value).equals(Buffer.from(b.value)); }
function boundedText(value: unknown, maximum = 8192): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value); }
function validSettingsEffect(value: unknown, record: OwnedMarketplaceRecord): value is PluginSettingsEffectSummary {
  return plain(value) && value.setting === "extraKnownMarketplaces" && value.key === record.name && value.scope === record.scope
    && typeof value.targetPath === "string" && path.isAbsolute(value.targetPath) && typeof value.declarationOnly === "boolean" && typeof value.effective === "boolean"
    && value.declarationOnly !== value.effective;
}
function validCatalog(value: unknown, name: string): value is MarketplaceCatalogDeclarationSummary {
  if (!plain(value) || !exact(value, ["name", "ownerName", "plugins", "unsupportedEntries", "omittedEntries"]) || value.name !== name || !boundedText(value.ownerName, 256)
    || !Number.isSafeInteger(value.unsupportedEntries) || (value.unsupportedEntries as number) < 0 || (value.unsupportedEntries as number) > 1024
    || !Number.isSafeInteger(value.omittedEntries) || (value.omittedEntries as number) < 0 || (value.omittedEntries as number) > 1_000_000
    || !Array.isArray(value.plugins) || value.plugins.length > 1024
    || (value.plugins as readonly { supported?: unknown }[]).filter((plugin) => plugin.supported === false).length !== value.unsupportedEntries) return false;
  return value.plugins.every((plugin) => plain(plugin) && Object.keys(plugin).every((key) => ["name", "supported", "sourceKind", "error"].includes(key))
    && boundedText(plugin.name, 128) && typeof plugin.supported === "boolean" && (plugin.sourceKind === undefined || CATALOG_SOURCE_KINDS.has(plugin.sourceKind as CatalogPluginSource["kind"])) && (plugin.error === undefined || boundedText(plugin.error, 512))
    && (plugin.supported ? plugin.sourceKind !== undefined && plugin.error === undefined : plugin.sourceKind === undefined && plugin.error !== undefined));
}

export function marketplacePreviewConfirmationDigest(value: Omit<MarketplaceMutationPreview, "confirmationDigest">): StoreResult<Sha256> {
  const bytes = canonicalJsonBytes(value); return bytes.ok ? { ok: true, value: sha256(bytes.value) } : bytes;
}

export function decodeMarketplaceMutationPreview(value: unknown, context: MarketplaceCodecContext): StoreResult<MarketplaceMutationPreview> {
  if (!plain(value) || !exact(value, ["acknowledgement", "action", "catalog", "confirmationDigest", "consequences", "dependents", "kind", "operationId", "participants", "registration", "settingsEffect", "settingsFingerprint", "snapshot", "stateFingerprint", "version"])) return fail("invalid-preview", "Marketplace preview has an inexact shape");
  if (value.kind !== "marketplace-mutation-preview" || value.version !== 1 || !boundedText(value.operationId, 128) || !/^[A-Za-z0-9_-]+$/.test(value.operationId)
    || value.action !== "add" && value.action !== "refresh" && value.action !== "remove" || value.acknowledgement !== "preserve-installations"
    || typeof value.confirmationDigest !== "string" || !DIGEST.test(value.confirmationDigest) || typeof value.stateFingerprint !== "string" || !DIGEST.test(value.stateFingerprint)
    || typeof value.settingsFingerprint !== "string" || !DIGEST.test(value.settingsFingerprint) || !Array.isArray(value.dependents) || value.dependents.length > 1024
    || !value.dependents.every((item) => boundedText(item, 256)) || new Set(value.dependents).size !== value.dependents.length
    || !Array.isArray(value.consequences) || value.consequences.length < 1 || value.consequences.length > 32 || !value.consequences.every((item) => boundedText(item))
    || !Array.isArray(value.participants) || value.participants.length !== (value.action === "remove" ? 2 : 3)) return fail("invalid-preview", "Marketplace preview fields are invalid");
  const registration = createOwnedMarketplaceCodec(context.profileKey).decode(value.registration);
  if (!registration.ok) return fail("invalid-preview", "Marketplace registration is invalid");
  const decodedSnapshot = createOwnedMarketplaceSnapshotCodec(context).decode(value.snapshot);
  if (!decodedSnapshot.ok) return fail("invalid-preview", "Marketplace snapshot is invalid");
  const snapshot = decodedSnapshot.value;
  const target = marketplaceTarget(snapshot); const expectedTrust = createMarketplaceSnapshotTrustGrant(target);
  if (registration.value.profileKey !== snapshot.profileKey || registration.value.name !== snapshot.marketplaceName || registration.value.selectedSnapshotId !== snapshot.snapshotId
    || !isDocumentedMarketplaceName(registration.value.name) || !same(registration.value.source, snapshot.source) || !expectedTrust.ok || !same(snapshot.trust, expectedTrust.value)
    || !validSettingsEffect(value.settingsEffect, registration.value) || !validCatalog(value.catalog, registration.value.name)
    || !(value.dependents as readonly string[]).every((identity) => isQualifiedPluginId(identity) && identity.endsWith(`@${registration.value.name}`))) return fail("invalid-preview", "Marketplace registration, snapshot, catalog, trust, settings, or dependents authority disagree");
  const participants = value.participants as MarketplaceParticipantSummary[];
  if (!participants.every((participant, index) => plain(participant) && exact(participant as unknown as Record<string, unknown>, ["effect", "order", "payloadDigest", "role", "scopeKey", "stagedDigest", "target"])
    && participant.order === index && (participant.role === "settings" || participant.role === "snapshot" || participant.role === "registration")
    && path.isAbsolute(participant.target) && boundedText(participant.scopeKey, 256) && DIGEST.test(participant.stagedDigest) && DIGEST.test(participant.payloadDigest))
    || !same(participants.map((participant) => participant.role), value.action === "remove" ? ["settings", "registration"] : ["settings", "snapshot", "registration"])
    || (value.action === "remove" ? participants[1]?.effect !== "delete" : participants.some((participant) => participant.effect === "delete"))) return fail("invalid-preview", "Marketplace action cannot authorize this participant order or effect");
  const without = { ...value }; delete without.confirmationDigest; const digest = marketplacePreviewConfirmationDigest(without as Omit<MarketplaceMutationPreview, "confirmationDigest">);
  return digest.ok && digest.value === value.confirmationDigest ? { ok: true, value: Object.freeze(value as unknown as MarketplaceMutationPreview) } : fail("confirmation-mismatch", "Marketplace preview confirmation digest changed");
}

export function createMarketplaceMutationPreview(value: Omit<MarketplaceMutationPreview, "kind" | "version" | "confirmationDigest">, context: MarketplaceCodecContext): StoreResult<MarketplaceMutationPreview> {
  const base = { kind: "marketplace-mutation-preview" as const, version: 1 as const, ...value }; const digest = marketplacePreviewConfirmationDigest(base); if (!digest.ok) return digest;
  return decodeMarketplaceMutationPreview({ ...base, confirmationDigest: digest.value }, context);
}

function decodeEvidence(participant: OrdinaryTransactionParticipant): MarketplaceEvidence | undefined {
  const raw = participant.producerEvidence;
  return plain(raw) && exact(raw, ["payload", "role"]) && (raw.role === "snapshot" || raw.role === "registration") && plain(raw.payload) ? raw as unknown as MarketplaceEvidence : undefined;
}
function participantProjection(participant: OrdinaryTransactionParticipant, order: number, role: MarketplaceParticipantSummary["role"], payloadDigest: Sha256): MarketplaceParticipantSummary {
  return { order, role, target: participant.targetPath, effect: participant.effect ?? "replace", scopeKey: participant.scopeKey, stagedDigest: participant.stagedDigest, payloadDigest };
}

export function createMarketplaceTransactionCodec(inputs: { readonly store: OwnedStateStore; readonly settingsCodec: TransactionProducerCodec<PluginSettingsEffectSummary> }): TransactionProducerCodec<MarketplaceMutationPreview> {
  const context: MarketplaceCodecContext = { profileKey: inputs.store.profileKey as LifecycleProfileKey, artifactsRoot: inputs.store.artifactsRoot };
  const registrationCodec = createOwnedMarketplaceCodec(context.profileKey);
  const snapshotCodec = createOwnedMarketplaceSnapshotCodec(context);
  const validateMarketplaceParticipant = (participant: TransactionParticipant): StoreResult<{ readonly participant: OrdinaryTransactionParticipant; readonly evidence: MarketplaceEvidence; readonly payloadDigest: Sha256 }> => {
    if (isOwnedDataRetirementParticipant(participant)) return fail("invalid-plan", "Marketplace operations cannot authorize data retirement");
    const evidence = decodeEvidence(participant); if (evidence === undefined) return fail("invalid-plan", "Marketplace participant semantic evidence is missing");
    const codec = evidence.role === "snapshot" ? snapshotCodec : registrationCodec; const decoded = codec.decode(evidence.payload as never); if (!decoded.ok) return decoded;
    const scopeKey = evidence.role === "snapshot" ? ownedMarketplaceSnapshotScopeKey(decoded.value as OwnedMarketplaceSnapshotRecord) : ownedMarketplaceScopeKey(decoded.value as OwnedMarketplaceRecord);
    const envelope = createRecordEnvelope(codec as never, "picc-owned", scopeKey, decoded.value as never); const partition = ownedRecordPartition(inputs.store, "picc-owned", scopeKey);
    if (!envelope.ok || !partition.ok || participant.ownerKey !== "picc-owned" || participant.scopeKey !== scopeKey || participant.targetPath !== path.join(partition.value, "record.json")
      || participant.stagedDigest !== sha256(envelope.value.bytes) || participant.key !== `${evidence.role}-${(evidence.payload as OwnedMarketplaceRecord).name ?? (evidence.payload as OwnedMarketplaceSnapshotRecord).marketplaceName}`)
      return fail("invalid-plan", "Marketplace participant target, payload, or digest is invalid");
    return { ok: true, value: { participant, evidence, payloadDigest: envelope.value.envelope.payloadDigest } };
  };
  const validateDomain = (summary: MarketplaceMutationPreview, participants: readonly TransactionParticipant[]): StoreResult<void> => {
    const settingsParticipant = participants[0];
    if (participants.length !== summary.participants.length || settingsParticipant === undefined || isOwnedDataRetirementParticipant(settingsParticipant) || !inputs.settingsCodec.validatePlan([settingsParticipant]).ok) return fail("invalid-plan", "Marketplace summary and exact ordered participant plan disagree");
    const settingsPayload = canonicalJsonBytes(settingsParticipant.producerEvidence);
    if (!settingsPayload.ok || !same(summary.participants[0], participantProjection(settingsParticipant, 0, "settings", sha256(settingsPayload.value)))) return fail("invalid-plan", "Settings participant bytes and summary disagree");
    const settingsEvidence = settingsParticipant.producerEvidence as { authorityFingerprints?: unknown };
    const fingerprintBytes = canonicalJsonBytes(settingsEvidence.authorityFingerprints);
    if (!fingerprintBytes.ok || summary.settingsFingerprint !== sha256(fingerprintBytes.value)) return fail("invalid-plan", "Settings authority fingerprint does not bind authentic producer evidence");
    for (let index = 1; index < participants.length; index++) {
      const validated = validateMarketplaceParticipant(participants[index]!); if (!validated.ok) return validated;
      const expectedRole = summary.action === "remove" ? "registration" : index === 1 ? "snapshot" : "registration";
      const expectedPayload = expectedRole === "snapshot" ? summary.snapshot : summary.registration;
      if (validated.value.evidence.role !== expectedRole || !same(validated.value.evidence.payload, expectedPayload)
        || !same(summary.participants[index], participantProjection(validated.value.participant, index, expectedRole, validated.value.payloadDigest))
        || (summary.action === "remove" ? validated.value.participant.effect !== "delete" : validated.value.participant.effect === "delete")) return fail("invalid-plan", "Marketplace participant semantics disagree with the preview");
    }
    return { ok: true, value: undefined };
  };
  return Object.freeze({ schema: "marketplace-lifecycle", version: 1,
    decodeSummary: (raw: unknown) => decodeMarketplaceMutationPreview(raw, context),
    validatePlan: (participants: readonly TransactionParticipant[]): StoreResult<void> => {
      if (participants.length < 2 || participants.length > 3 || !inputs.settingsCodec.validatePlan([participants[0]!]).ok) return fail("invalid-plan", "Marketplace participant count or settings owner is invalid");
      for (const participant of participants.slice(1)) { const valid = validateMarketplaceParticipant(participant); if (!valid.ok) return valid; }
      return { ok: true, value: undefined };
    },
    requiredLocks: (raw: unknown, participants: readonly TransactionParticipant[]) => {
      const summary = decodeMarketplaceMutationPreview(raw, context); if (!summary.ok || !validateDomain(summary.value, participants).ok) return fail("invalid-locks", "Marketplace summary and participant plan disagree");
      return inputs.settingsCodec.requiredLocks(summary.value.settingsEffect, [participants[0]!]);
    },
    ...(inputs.settingsCodec.authorizeExternal === undefined ? {} : { authorizeExternal: inputs.settingsCodec.authorizeExternal }),
    authorizeOwnedDelete: async (context: import("./transaction.js").ExternalMutationContext): Promise<StoreResult<void>> => {
      const summaryEvidence = decodeEvidence(context.participant); if (summaryEvidence?.role !== "registration" || context.participant.effect !== "delete") return fail("invalid-delete", "Only the exact selected registration may be deleted");
      const decoded = registrationCodec.decode(summaryEvidence.payload); if (!decoded.ok) return decoded;
      const scopeKey = ownedMarketplaceScopeKey(decoded.value); const partition = ownedRecordPartition(inputs.store, "picc-owned", scopeKey);
      return partition.ok && context.participant.ownerKey === "picc-owned" && context.participant.scopeKey === scopeKey && context.participant.targetPath === path.join(partition.value, "record.json")
        ? { ok: true, value: undefined } : fail("invalid-delete", "Owned registration delete authority changed");
    },
  });
}

export function wrapMarketplaceReceipt(receipt: TransactionReceipt, codec: TransactionProducerCodec<MarketplaceMutationPreview>): StoreResult<MarketplaceReceipt> {
  const summary = codec.decodeSummary(receipt.confirmationSummary);
  const locks = summary.ok ? codec.requiredLocks(summary.value, receipt.participants) : undefined;
  if (!summary.ok || summary.value.operationId !== receipt.operationId || receipt.producerSchema !== codec.schema || receipt.producerVersion !== codec.version
    || !codec.validatePlan(receipt.participants).ok || locks === undefined || !locks.ok
    || receipt.requiredLocks.length !== locks.value.length || receipt.requiredLocks.some((lock, index) => !same(lock, locks.value[index]))) return fail("invalid-receipt", "Marketplace receipt does not bind its validated lifecycle summary and transaction truth");
  const guidance = receipt.outcome === "failed-before-commit"
    ? "This operation id is terminal and was not applied. Create a new preview with a new operation id if you still want the change."
    : receipt.outcome === "rolled-back" ? "This operation id is terminal and was rolled back. Create a new preview with a new operation id to try again." : undefined;
  return { ok: true, value: Object.freeze({ kind: "marketplace-receipt", version: 1, operationId: receipt.operationId, summary: summary.value, outcome: receipt.outcome, completed: receipt.completed,
    ...(receipt.failureCategory === undefined ? {} : { failureCategory: receipt.failureCategory }), planDigest: receipt.planDigest, confirmationDigest: receipt.confirmationDigest, ...(guidance === undefined ? {} : { guidance }) }) };
}

export function marketplaceTarget(snapshot: OwnedMarketplaceSnapshotRecord): MarketplaceSnapshotTrustTarget {
  const { ownership: _ownership, profileKey: _profileKey, trust: _trust, ...target } = snapshot;
  return target;
}

import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { isQualifiedPluginId } from "../discovery/managed-policy.js";
import { isDocumentedMarketplaceName, normalizeMarketplaceRegistrationRecord } from "../util/plugin-marketplace-descriptor.js";
import { projectIdentities } from "../util/project-identity.js";
import { checkoutFamilyLocationKey, profileLocationKey } from "./locations.js";
import { canonicalJsonBytes, isContainedPath, sha256, type OwnedStateStore, type StoreResult } from "./state-store.js";
import {
  prepareTransaction,
  type ExternalAuthorization,
  type ExternalMutationContext,
  isOwnedDataRetirementParticipant,
  type OrdinaryTransactionParticipant,
  type TransactionParticipant,
  type TransactionProducerCodec,
  type PreparedTransaction,
} from "./transaction.js";
import type { LifecycleLockIdentity } from "./locks.js";
import { renderPluginSettingsEdit, selectPluginSettingsTarget, type PluginSettingsEffectSummary, type PluginSettingsWritePlan, type SettingsAuthorityFingerprint, type SettingsPathAnchor } from "./settings-plan.js";

export const PLUGIN_SETTINGS_TRANSACTION_SCHEMA = "plugin-settings";
export const PLUGIN_SETTINGS_TRANSACTION_VERSION = 1;

interface SettingsProducerEvidence {
  readonly operationId: string;
  readonly scope: "user" | "project" | "local";
  readonly setting: "enabledPlugins" | "extraKnownMarketplaces";
  readonly key: string;
  readonly requested: unknown;
  readonly homePath: string;
  readonly profilePath: string;
  readonly profileKey: string;
  readonly activeCheckoutPath?: string;
  readonly checkoutFamilyPath?: string;
  readonly checkoutFamilyKey?: string;
  readonly targetPath: string;
  readonly anchors: readonly SettingsPathAnchor[];
  readonly hierarchyAnchors: readonly SettingsPathAnchor[];
  readonly authorityFingerprints: readonly SettingsAuthorityFingerprint[];
  readonly missingParent?: SettingsPathAnchor;
  readonly stagedDigest: string;
  readonly precondition: unknown;
  readonly rollbackPosture: "delete-new-target" | "restore-backup";
  readonly fileMode?: number;
  readonly targetIdentity?: { readonly dev: string; readonly ino: string };
  readonly summary: PluginSettingsEffectSummary;
}

export interface PreparedPluginSettingsWrite {
  readonly transaction: PreparedTransaction & { readonly participants: readonly OrdinaryTransactionParticipant[] };
  readonly summary: PluginSettingsEffectSummary;
  readonly codec: TransactionProducerCodec<PluginSettingsEffectSummary>;
}

function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function samePath(left: string, right: string): boolean {
  const a = path.resolve(left); const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value); return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function digestKey(value: string): string { return createHash("sha256").update(value, "utf8").digest("base64url"); }

function validState(value: unknown): boolean {
  if (!plain(value) || typeof value.present !== "boolean") return false;
  const required = ["present"]; const optional = value.present ? ["scope", "source", "value"] : [];
  return exactKeys(value, required, optional) && (!value.present || (typeof value.scope === "string" && typeof value.source === "string" && Object.hasOwn(value, "value")));
}

function sameValue(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function validMarketplaceValue(value: unknown, scope: "user" | "project" | "local"): boolean {
  if (!plain(value)) return false;
  const observation = normalizeMarketplaceRegistrationRecord({ validity: "valid", descriptor: value, matchKey: "", indeterminate: undefined }, scope);
  return observation.validity === "valid" && observation.descriptor !== undefined && observation.descriptor.kind !== "hostPattern" && observation.descriptor.kind !== "pathPattern";
}

function decodeSummary(summary: unknown): StoreResult<PluginSettingsEffectSummary> {
  if (!plain(summary) || !exactKeys(summary, ["declarationAfter", "declarationBefore", "declarationOnly", "effective", "effectiveAfter", "effectiveBefore", "key", "requested", "scope", "setting", "targetPath"])) return fail("invalid-summary", "Settings effect summary has an inexact shape");
  if ((summary.scope !== "user" && summary.scope !== "project" && summary.scope !== "local") || (summary.setting !== "enabledPlugins" && summary.setting !== "extraKnownMarketplaces")
    || typeof summary.key !== "string" || summary.key.length < 1 || summary.key.length > 256 || typeof summary.targetPath !== "string" || !path.isAbsolute(summary.targetPath)
    || typeof summary.declarationOnly !== "boolean" || typeof summary.effective !== "boolean" || summary.declarationOnly === summary.effective
    || !validState(summary.declarationBefore) || !validState(summary.declarationAfter) || !validState(summary.effectiveBefore) || !validState(summary.effectiveAfter)) return fail("invalid-summary", "Settings effect summary fields are invalid");
  const states = [summary.declarationBefore, summary.declarationAfter, summary.effectiveBefore, summary.effectiveAfter] as Record<string, unknown>[];
  const [declarationBefore, declarationAfter, , effectiveAfter] = states as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
  if (summary.setting === "enabledPlugins") {
    if (!isQualifiedPluginId(summary.key) || summary.requested !== null && typeof summary.requested !== "boolean" || states.some((state) => state.present && typeof state.value !== "boolean")) return fail("invalid-summary", "Plugin summary identity or values are invalid");
  } else if (!isDocumentedMarketplaceName(summary.key) || summary.requested !== null && !validMarketplaceValue(summary.requested, summary.scope) || states.some((state) => state.present && !validMarketplaceValue(state.value, state.scope === "project" || state.scope === "local" ? state.scope : "user"))) return fail("invalid-summary", "Marketplace summary identity or values are invalid");
  if (declarationBefore.present && (declarationBefore.scope !== summary.scope || !samePath(String(declarationBefore.source), summary.targetPath))
    || declarationAfter.present && (declarationAfter.scope !== summary.scope || !samePath(String(declarationAfter.source), summary.targetPath))) return fail("invalid-summary", "Declaration state is not attributed to the authentic target");
  const declarationMatches = summary.requested === null ? !declarationAfter.present : declarationAfter.present && sameValue(declarationAfter.value, summary.requested);
  const effectiveMatches = summary.requested === null
    ? !effectiveAfter.present
    : effectiveAfter.present && sameValue(effectiveAfter.value, summary.requested) && effectiveAfter.scope === summary.scope
      && typeof effectiveAfter.source === "string" && samePath(effectiveAfter.source, summary.targetPath);
  if (!declarationMatches || summary.effective !== effectiveMatches || summary.declarationOnly !== !effectiveMatches) return fail("invalid-summary", "Declaration and effective result relationships are invalid");
  return { ok: true, value: summary as unknown as PluginSettingsEffectSummary };
}

function validAnchor(item: unknown): item is SettingsPathAnchor {
  return plain(item) && exactKeys(item, ["dev", "ino", "path"]) && typeof item.path === "string" && path.isAbsolute(item.path) && typeof item.dev === "string" && /^\d+$/.test(item.dev) && typeof item.ino === "string" && /^\d+$/.test(item.ino);
}
function validFingerprint(item: unknown): item is SettingsAuthorityFingerprint {
  if (!plain(item) || typeof item.path !== "string" || !path.isAbsolute(item.path) || (item.kind !== "file" && item.kind !== "directory") || (item.status !== "absent" && item.status !== "text" && item.status !== "unreadable")) return false;
  return item.status === "text" ? exactKeys(item, ["digest", "kind", "path", "status"]) && typeof item.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(item.digest) : exactKeys(item, ["kind", "path", "status"]);
}
function decodeEvidence(participant: TransactionParticipant): StoreResult<SettingsProducerEvidence> {
  if (isOwnedDataRetirementParticipant(participant)) return fail("invalid-participant", "Settings operations cannot authorize data retirement");
  const raw = participant.producerEvidence;
  if (!plain(raw) || !exactKeys(raw, ["anchors", "authorityFingerprints", "checkoutFamilyPath", "hierarchyAnchors", "homePath", "key", "operationId", "precondition", "profileKey", "profilePath", "requested", "rollbackPosture", "scope", "setting", "stagedDigest", "summary", "targetPath"], ["activeCheckoutPath", "checkoutFamilyKey", "fileMode", "missingParent", "targetIdentity"])) return fail("invalid-participant", "Settings participant semantic evidence has an inexact shape");
  const summary = decodeSummary(raw.summary); if (!summary.ok) return summary;
  if (typeof raw.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.operationId) || typeof raw.homePath !== "string" || !path.isAbsolute(raw.homePath) || typeof raw.profilePath !== "string" || !path.isAbsolute(raw.profilePath)
    || typeof raw.profileKey !== "string" || !/^profile-[A-Za-z0-9_-]+$/.test(raw.profileKey) || typeof raw.activeCheckoutPath !== "string" || !path.isAbsolute(raw.activeCheckoutPath) || typeof raw.checkoutFamilyPath !== "string" || !path.isAbsolute(raw.checkoutFamilyPath) || typeof raw.checkoutFamilyKey !== "string" || !/^checkout-[A-Za-z0-9_-]+$/.test(raw.checkoutFamilyKey) || typeof raw.targetPath !== "string" || !path.isAbsolute(raw.targetPath)
    || typeof raw.stagedDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(raw.stagedDigest) || (raw.rollbackPosture !== "delete-new-target" && raw.rollbackPosture !== "restore-backup")
    || !Array.isArray(raw.anchors) || raw.anchors.length < 1 || raw.anchors.length > 16 || !raw.anchors.every(validAnchor)
    || !Array.isArray(raw.hierarchyAnchors) || raw.hierarchyAnchors.length < 2 || raw.hierarchyAnchors.length > 16 || !raw.hierarchyAnchors.every(validAnchor)
    || !Array.isArray(raw.authorityFingerprints) || raw.authorityFingerprints.length > 64 || !raw.authorityFingerprints.every(validFingerprint)
    || (raw.missingParent !== undefined && !validAnchor(raw.missingParent))) return fail("invalid-participant", "Settings participant semantic evidence is invalid");
  if (raw.fileMode !== undefined && (typeof raw.fileMode !== "number" || !Number.isSafeInteger(raw.fileMode) || raw.fileMode < 0 || raw.fileMode > 0o777)) return fail("invalid-participant", "Settings participant mode evidence is invalid");
  if (raw.targetIdentity !== undefined && (!plain(raw.targetIdentity) || !exactKeys(raw.targetIdentity, ["dev", "ino"]) || typeof raw.targetIdentity.dev !== "string" || !/^\d+$/.test(raw.targetIdentity.dev) || typeof raw.targetIdentity.ino !== "string" || !/^\d+$/.test(raw.targetIdentity.ino))) return fail("invalid-participant", "Settings participant target identity evidence is invalid");
  if (summary.value.scope !== raw.scope || summary.value.setting !== raw.setting || summary.value.key !== raw.key || summary.value.targetPath !== raw.targetPath || JSON.stringify(summary.value.requested) !== JSON.stringify(raw.requested)) return fail("invalid-participant", "Settings participant and effect summary disagree");
  return { ok: true, value: raw as unknown as SettingsProducerEvidence };
}

function validatePlan(participants: readonly TransactionParticipant[]): StoreResult<void> {
  if (participants.length !== 1) return fail("invalid-plan", "A settings transaction must contain exactly one per-file participant");
  const participant = participants[0]!; if (isOwnedDataRetirementParticipant(participant)) return fail("invalid-plan", "Settings operations require one ordinary file participant"); const evidence = decodeEvidence(participant); if (!evidence.ok) return evidence;
  const item = evidence.value;
  const hierarchyPaths = [item.homePath, item.profilePath, item.checkoutFamilyPath!, item.activeCheckoutPath!]
    .filter((candidate, index, values) => values.findIndex((value) => samePath(value, candidate)) === index);
  const hierarchyMatches = hierarchyPaths.length === item.hierarchyAnchors.length && hierarchyPaths.every((candidate, index) => samePath(candidate, item.hierarchyAnchors[index]!.path));
  const expectedTarget = item.scope === "user" ? path.join(item.profilePath, "settings.json")
    : path.join(item.scope === "local" && !samePath(item.activeCheckoutPath!, item.homePath) ? item.checkoutFamilyPath! : item.activeCheckoutPath!, ".claude", item.scope === "local" ? "settings.local.json" : "settings.json");
  const anchorEnd = item.missingParent?.path ?? path.dirname(item.targetPath); const anchorRoot = item.anchors[0]?.path;
  const relative = anchorRoot === undefined ? ".." : path.relative(anchorRoot, anchorEnd);
  const expectedAnchors = anchorRoot === undefined || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? []
    : [anchorRoot, ...relative.split(path.sep).filter(Boolean).map((_, index, parts) => path.join(anchorRoot, ...parts.slice(0, index + 1)))];
  if (item.missingParent !== undefined) expectedAnchors.pop();
  const anchorPathsMatch = expectedAnchors.length === item.anchors.length && expectedAnchors.every((candidate, index) => samePath(candidate, item.anchors[index]!.path));
  const fingerprintKeys = item.authorityFingerprints.map((fingerprint) => `${path.resolve(fingerprint.path)}\0${fingerprint.kind}`);
  const fingerprintsCanonical = new Set(fingerprintKeys).size === fingerprintKeys.length && !item.authorityFingerprints.some((fingerprint) => samePath(fingerprint.path, item.targetPath))
    && item.authorityFingerprints.every((fingerprint, index) => index === 0 || `${item.authorityFingerprints[index - 1]!.path}\0${item.authorityFingerprints[index - 1]!.kind}`.localeCompare(`${fingerprint.path}\0${fingerprint.kind}`) <= 0);
  const platform = process.platform === "win32" ? "win32" : "posix";
  const profileKey = profileLocationKey(item.profilePath, platform); const familyKey = checkoutFamilyLocationKey(item.checkoutFamilyPath!, platform);
  if (participant.kind !== "plugin-settings" || participant.targetClass !== "external" || participant.ownerKey !== "plugin-settings" || participant.scopeKey !== `${evidence.value.scope}-${digestKey(evidence.value.targetPath)}`
    || !hierarchyMatches || !anchorPathsMatch || !fingerprintsCanonical || !samePath(item.targetPath, expectedTarget) || !profileKey.ok || profileKey.value !== item.profileKey || !familyKey.ok || familyKey.value !== item.checkoutFamilyKey
    || participant.key !== digestKey(`${evidence.value.setting}\0${evidence.value.key}`) || !samePath(participant.targetPath, evidence.value.targetPath)
    || participant.stagedDigest !== evidence.value.stagedDigest || JSON.stringify(participant.precondition) !== JSON.stringify(evidence.value.precondition) || participant.rollback.kind !== evidence.value.rollbackPosture
    || (evidence.value.missingParent === undefined ? participant.missingParent !== undefined : participant.missingParent === undefined || !samePath(participant.missingParent.path, evidence.value.missingParent.path) || !samePath(participant.missingParent.canonicalAncestor, path.dirname(evidence.value.missingParent.path)) || participant.missingParent.ancestorDev !== evidence.value.missingParent.dev || participant.missingParent.ancestorIno !== evidence.value.missingParent.ino)
    || (evidence.value.targetIdentity === undefined ? participant.precondition.state !== "absent" : participant.targetEvidence?.targetDev !== evidence.value.targetIdentity.dev || participant.targetEvidence?.targetIno !== evidence.value.targetIdentity.ino)) return fail("invalid-plan", "Settings participant relationships are invalid");
  return { ok: true, value: undefined };
}

function requiredLocks(summaryRaw: unknown, participants: readonly TransactionParticipant[]): StoreResult<readonly LifecycleLockIdentity[]> {
  const summary = decodeSummary(summaryRaw); const plan = validatePlan(participants); if (!summary.ok || !plan.ok) return fail("invalid-locks", "Settings locks require a valid summary and participant");
  const evidence = decodeEvidence(participants[0]!); if (!evidence.ok || JSON.stringify(evidence.value.summary) !== JSON.stringify(summary.value)) return fail("invalid-locks", "Settings lock evidence and summary disagree");
  const locks: LifecycleLockIdentity[] = [{ kind: "profile", key: evidence.value.profileKey }];
  locks.push({ kind: "checkout", key: evidence.value.checkoutFamilyKey! });
  locks.push({ kind: "settings", key: digestKey(evidence.value.targetPath) });
  return { ok: true, value: Object.freeze(locks) };
}

async function validateAnchors(anchors: readonly SettingsPathAnchor[], targetParent: string, missingParent?: SettingsPathAnchor): Promise<boolean> {
  try {
    const end = missingParent?.path ?? targetParent; const root = anchors[0]?.path; if (root === undefined) return false;
    const relative = path.relative(root, end); if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    const expected = [root, ...relative.split(path.sep).filter(Boolean).map((_, index, parts) => path.join(root, ...parts.slice(0, index + 1)))];
    if (missingParent !== undefined) expected.pop();
    if (expected.length !== anchors.length || expected.some((candidate, index) => !samePath(candidate, anchors[index]!.path))) return false;
    for (const anchor of anchors) {
      const stat = await fs.lstat(anchor.path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev.toString() !== anchor.dev || stat.ino.toString() !== anchor.ino || !samePath(await fs.realpath(anchor.path), anchor.path)) return false;
    }
    return true;
  } catch { return false; }
}

async function validateHierarchyAnchors(anchors: readonly SettingsPathAnchor[]): Promise<boolean> {
  try { for (const anchor of anchors) { const stat = await fs.lstat(anchor.path, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev.toString() !== anchor.dev || stat.ino.toString() !== anchor.ino || !samePath(await fs.realpath(anchor.path), anchor.path)) return false; } return true; }
  catch { return false; }
}

async function observedFingerprint(item: SettingsAuthorityFingerprint): Promise<SettingsAuthorityFingerprint> {
  try {
    const before = await fs.lstat(item.path, { bigint: true });
    if (item.kind === "file") {
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !samePath(await fs.realpath(item.path), item.path)) throw new Error("ordinary");
      const handle = await fs.open(item.path, "r"); let bytes: Buffer;
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 1024n * 1024n) throw new Error("ordinary");
        bytes = Buffer.allocUnsafe(Number(opened.size)); let offset = 0;
        while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (read.bytesRead === 0) break; offset += read.bytesRead; }
        const after = await fs.lstat(item.path, { bigint: true });
        if (offset !== bytes.length || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || !samePath(await fs.realpath(item.path), item.path)) throw new Error("changed");
      } finally { await handle.close(); }
      return { path: item.path, kind: item.kind, status: "text", digest: sha256(bytes) };
    }
    if (!before.isDirectory() || before.isSymbolicLink() || !samePath(await fs.realpath(item.path), item.path)) throw new Error("ordinary");
    const names = (await fs.readdir(item.path, { withFileTypes: true })).filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.toLowerCase().endsWith(".json")).map((entry) => entry.name).sort((a, b) => a.localeCompare(b, "en"));
    const after = await fs.lstat(item.path, { bigint: true });
    if (names.length > 64 || after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || !samePath(await fs.realpath(item.path), item.path)) throw new Error("changed");
    return { path: item.path, kind: item.kind, status: "text", digest: sha256(Buffer.from(JSON.stringify(names), "utf8")) };
  } catch (error) { return { path: item.path, kind: item.kind, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" }; }
}
async function reconstructStaged(item: SettingsProducerEvidence, participant: OrdinaryTransactionParticipant, persistedRecovery = false): Promise<StoreResult<Buffer>> {
  let original: Buffer | undefined;
  if (participant.precondition.state === "present") {
    const source = persistedRecovery && participant.rollback.kind === "restore-backup" ? participant.rollback.path : participant.targetPath;
    try { original = await fs.readFile(source); } catch { return fail("stale-precondition", "Authentic settings precondition is unavailable"); }
    if (sha256(original) !== participant.precondition.digest) return fail("stale-precondition", "Authentic settings precondition changed");
  } else if (!persistedRecovery) {
    try { await fs.lstat(participant.targetPath); return fail("stale-precondition", "Authentic absent settings precondition changed"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("stale-precondition", "Authentic absent settings precondition is indeterminate"); }
  }
  const mutation = item.setting === "enabledPlugins"
    ? { kind: "enabled-plugin" as const, key: item.key, ...(item.requested === null ? {} : { value: item.requested as boolean }) }
    : { kind: "known-marketplace" as const, key: item.key, ...(item.requested === null ? {} : { value: item.requested as import("../types.js").PluginMarketplaceRegistrationSource }) };
  return renderPluginSettingsEdit(original, item.scope, mutation);
}
async function authorizeExternal(context: ExternalMutationContext): Promise<StoreResult<void | ExternalAuthorization>> {
  const evidence = decodeEvidence(context.participant); if (!evidence.ok) return evidence;
  const item = evidence.value;
  if (item.operationId !== context.operationId || !await validateAnchors(item.anchors, path.dirname(item.targetPath), item.missingParent) || !await validateHierarchyAnchors(item.hierarchyAnchors)) return fail("unsafe-target", "Settings path authority changed after planning");
  for (const expected of item.authorityFingerprints) { const observed = await observedFingerprint(expected); if (!samePath(observed.path, expected.path) || observed.kind !== expected.kind || observed.status !== expected.status || observed.digest !== expected.digest) return fail("settings-authority-changed", "Settings authority changed; a new preview is required"); }
  const profileKey = profileLocationKey(item.profilePath, process.platform === "win32" ? "win32" : "posix");
  if (!profileKey.ok || profileKey.value !== item.profileKey) return fail("wrong-profile", "Active Claude profile identity changed after planning");
  if (item.activeCheckoutPath === undefined || item.checkoutFamilyKey === undefined) return fail("wrong-checkout", "Settings checkout evidence is missing");
  const identities = projectIdentities(item.activeCheckoutPath); const active = identities.at(-1); const family = identities[0];
  const familyKey = family === undefined ? undefined : checkoutFamilyLocationKey(family, process.platform === "win32" ? "win32" : "posix");
  if (active === undefined || family === undefined || !samePath(active, item.activeCheckoutPath) || !samePath(family, item.checkoutFamilyPath!) || familyKey === undefined || !familyKey.ok || familyKey.value !== item.checkoutFamilyKey) return fail("wrong-checkout", "Active project checkout identity changed after planning");
  const mutation = item.setting === "enabledPlugins" ? { kind: "enabled-plugin" as const, key: item.key, ...(item.requested === null ? {} : { value: item.requested as boolean }) } : { kind: "known-marketplace" as const, key: item.key, ...(item.requested === null ? {} : { value: item.requested as import("../types.js").PluginMarketplaceRegistrationSource }) };
  const selected = selectPluginSettingsTarget({ homeDir: item.homePath, profilePath: item.profilePath, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: item.activeCheckoutPath, checkoutFamilyPath: family }, projectRoot: item.activeCheckoutPath, cwd: item.activeCheckoutPath, scope: item.scope, mutation }, item.activeCheckoutPath);
  if (!selected.ok || !samePath(selected.value.path, item.targetPath)) return fail("wrong-checkout", "Active settings target changed after planning");
  if (context.mutation === "replace" || context.mutation === "revalidate") { const reconstructed = await reconstructStaged(item, context.participant, context.mutation === "revalidate"); if (!reconstructed.ok || sha256(reconstructed.value) !== context.participant.stagedDigest || sha256(await fs.readFile(context.participant.stagedPath)) !== context.participant.stagedDigest || !Buffer.from(reconstructed.value).equals(await fs.readFile(context.participant.stagedPath))) return fail("changed-staged", "Staged settings bytes do not match authentic semantic reconstruction"); }
  if (context.temporary !== undefined) {
    const expectedDigest = context.mutation === "rollback" && context.participant.rollback.kind === "restore-backup" ? context.participant.rollback.digest : context.participant.stagedDigest;
    if (!samePath(path.dirname(context.temporary.path), path.dirname(context.participant.targetPath)) || samePath(context.temporary.path, context.participant.targetPath) || context.temporary.digest !== expectedDigest) return fail("unsafe-target", "Transaction temporary identity does not match the authorized settings replacement");
  }
  return { ok: true, value: item.fileMode === undefined || context.temporary === undefined || context.mutation === "delete" || process.platform === "win32" ? undefined : { temporaryMode: item.fileMode } };
}

export function createPluginSettingsTransactionCodec(): TransactionProducerCodec<PluginSettingsEffectSummary> {
  return Object.freeze({ schema: PLUGIN_SETTINGS_TRANSACTION_SCHEMA, version: PLUGIN_SETTINGS_TRANSACTION_VERSION, decodeSummary, validatePlan, requiredLocks, authorizeExternal });
}

async function writePrivateFile(target: string, bytes: Uint8Array): Promise<StoreResult<void>> {
  try {
    const handle = await fs.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    return { ok: true, value: undefined };
  } catch { return fail("staging-failure", "Settings transaction staging could not be published safely"); }
}

export async function preparePluginSettingsWrite(inputs: { readonly store: OwnedStateStore; readonly operationId: string; readonly profilePath: string; readonly plan: PluginSettingsWritePlan }): Promise<StoreResult<PreparedPluginSettingsWrite>> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(inputs.operationId) || inputs.store.profileKey !== inputs.plan.profileKey || !path.isAbsolute(inputs.profilePath)) return fail("invalid-operation", "Settings write preparation identity is invalid");
  const codec = createPluginSettingsTransactionCodec();
  const suffix = randomBytes(12).toString("hex"); const stagedPath = path.join(inputs.store.stagingRoot, `settings-${inputs.operationId}-${suffix}.new`);
  if (!isContainedPath(inputs.store.stagingRoot, stagedPath)) return fail("staging-failure", "Settings staging path escaped owned storage");
  const staged = await writePrivateFile(stagedPath, inputs.plan.replacementBytes); if (!staged.ok) return staged;
  const created = [stagedPath]; let rollback: OrdinaryTransactionParticipant["rollback"];
  try {
    if (inputs.plan.precondition.state === "absent") rollback = { kind: "delete-new-target" };
    else {
      const backupPath = path.join(inputs.store.stagingRoot, `settings-${inputs.operationId}-${suffix}.backup`); let bytes: Buffer;
      try { bytes = await fs.readFile(inputs.plan.targetPath); } catch { throw new Error("stale-precondition"); }
      if (sha256(bytes) !== inputs.plan.precondition.digest) throw new Error("stale-precondition");
      const backup = await writePrivateFile(backupPath, bytes); if (!backup.ok) throw new Error(backup.code); created.push(backupPath);
      rollback = { kind: "restore-backup", path: backupPath, digest: inputs.plan.precondition.digest };
    }
  } catch (error) { await Promise.all(created.map((candidate) => fs.rm(candidate, { force: true }).catch(() => undefined))); return fail(error instanceof Error && error.message === "stale-precondition" ? "stale-precondition" : "staging-failure", "Settings preparation could not capture authentic rollback evidence"); }
  const evidence: SettingsProducerEvidence = Object.freeze({ operationId: inputs.operationId, scope: inputs.plan.summary.scope, setting: inputs.plan.summary.setting, key: inputs.plan.summary.key, requested: inputs.plan.summary.requested,
    homePath: inputs.plan.homePath, profilePath: path.resolve(inputs.profilePath), profileKey: inputs.plan.profileKey, ...(inputs.plan.activeCheckoutPath === undefined ? {} : { activeCheckoutPath: inputs.plan.activeCheckoutPath }), ...(inputs.plan.checkoutFamilyPath === undefined ? {} : { checkoutFamilyPath: inputs.plan.checkoutFamilyPath }), ...(inputs.plan.checkoutFamilyKey === undefined ? {} : { checkoutFamilyKey: inputs.plan.checkoutFamilyKey }),
    targetPath: inputs.plan.targetPath, anchors: inputs.plan.anchors, hierarchyAnchors: inputs.plan.hierarchyAnchors, authorityFingerprints: inputs.plan.authorityFingerprints, ...(inputs.plan.missingParent === undefined ? {} : { missingParent: inputs.plan.missingParent }), stagedDigest: inputs.plan.replacementDigest, precondition: inputs.plan.precondition, rollbackPosture: rollback.kind, ...(inputs.plan.fileMode === undefined ? {} : { fileMode: inputs.plan.fileMode }), ...(inputs.plan.targetIdentity === undefined ? {} : { targetIdentity: inputs.plan.targetIdentity }), summary: inputs.plan.summary });
  const participant: OrdinaryTransactionParticipant = Object.freeze({ kind: "plugin-settings", key: digestKey(`${inputs.plan.summary.setting}\0${inputs.plan.summary.key}`), ownerKey: "plugin-settings", scopeKey: `${inputs.plan.summary.scope}-${digestKey(inputs.plan.targetPath)}`,
    targetPath: inputs.plan.targetPath, targetClass: "external", precondition: inputs.plan.precondition, stagedPath, stagedDigest: inputs.plan.replacementDigest, rollback, producerEvidence: evidence,
    ...(inputs.plan.missingParent === undefined ? {} : { missingParent: { path: inputs.plan.missingParent.path, canonicalAncestor: path.dirname(inputs.plan.missingParent.path), ancestorDev: inputs.plan.missingParent.dev, ancestorIno: inputs.plan.missingParent.ino } }) });
  const reconstructed = await reconstructStaged(evidence, participant);
  if (!reconstructed.ok || reconstructed.value.length !== inputs.plan.replacementBytes.length || !Buffer.from(reconstructed.value).equals(inputs.plan.replacementBytes) || sha256(reconstructed.value) !== inputs.plan.replacementDigest) { await Promise.all(created.map((candidate) => fs.rm(candidate, { force: true }).catch(() => undefined))); return fail("changed-staged", "Settings plan bytes do not match authentic semantic reconstruction"); }
  const prepared = await prepareTransaction({ store: inputs.store, codec, operationId: inputs.operationId, confirmationSummary: inputs.plan.summary, participants: [participant] });
  if (!prepared.ok) { await Promise.all(created.map((candidate) => fs.rm(candidate, { force: true }).catch(() => undefined))); return prepared; }
  return { ok: true, value: Object.freeze({ transaction: prepared.value as PreparedTransaction & { readonly participants: readonly OrdinaryTransactionParticipant[] }, summary: inputs.plan.summary, codec }) };
}

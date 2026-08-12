import { createHash, randomBytes } from "node:crypto";
import fsSync, { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJsonBytes, isContainedPath, ownedRecordPartition, revalidateOwnedStateStore, sha256,
  type OwnedStateStore, type StoreResult,
} from "./state-store.js";
import {
  lockIdentitiesEqual, validateLifecycleLockLease,
  type JournalLockBinding, type LifecycleLockIdentity, type LifecycleLockLease,
} from "./locks.js";
import type { Sha256 } from "./types.js";
import { isQualifiedPluginId } from "../util/plugin-id.js";

export type CasPrecondition = { readonly state: "absent" } | { readonly state: "present"; readonly digest: Sha256 };
export type RollbackEvidence = { readonly kind: "delete-new-target" } | { readonly kind: "restore-backup"; readonly path: string; readonly digest: Sha256 };
export interface PathEvidence {
  readonly path: string;
  readonly canonicalParent: string;
  readonly parentDev: string;
  readonly parentIno: string;
  readonly targetDev?: string;
  readonly targetIno?: string;
}
export interface MissingParentRequest {
  readonly path: string;
  readonly canonicalAncestor: string;
  readonly ancestorDev: string;
  readonly ancestorIno: string;
}
export interface CreatedParentEvidence { readonly temporaryPath: string; readonly finalPath: string; readonly dev: string; readonly ino: string }
export interface OrdinaryTransactionParticipant {
  readonly kind: string;
  /** Omission is the persisted backward-compatible replace effect. */
  readonly effect?: "replace" | "delete";
  readonly key: string;
  readonly ownerKey: string;
  readonly scopeKey: string;
  readonly targetPath: string;
  readonly targetClass: "owned" | "external" | "generation";
  readonly precondition: CasPrecondition;
  readonly stagedPath: string;
  readonly stagedDigest: Sha256;
  readonly rollback: RollbackEvidence;
  readonly producerEvidence: unknown;
  readonly targetEvidence?: PathEvidence;
  readonly stagedEvidence?: PathEvidence;
  readonly backupEvidence?: PathEvidence;
  readonly missingParent?: MissingParentRequest;
  readonly generationId?: string;
}
export interface DirectoryIdentityEvidence {
  readonly path: string;
  readonly canonicalParent: string;
  readonly parentDev: string;
  readonly parentIno: string;
  readonly targetDev?: string;
  readonly targetIno?: string;
}
export interface OwnedDataRetirementParticipant {
  readonly kind: "owned-data-retirement";
  readonly key: string;
  readonly profileKey: string;
  readonly qualifiedIdentity: string;
  readonly dataPath: string;
  readonly destinationPath: string;
  readonly state: "absent" | "present";
  readonly sourceEvidence: DirectoryIdentityEvidence;
  readonly producerEvidence: unknown;
}
export type TransactionParticipant = OrdinaryTransactionParticipant | OwnedDataRetirementParticipant;
export type ExternalMutation = "replace" | "delete" | "rollback" | "create-parent" | "remove-parent" | "revalidate";
export interface AdjacentTemporaryEvidence { readonly path: string; readonly dev: string; readonly ino: string; readonly digest: Sha256 }
export interface ExternalMutationContext {
  readonly operationId: string;
  readonly participant: OrdinaryTransactionParticipant;
  readonly mutation: ExternalMutation;
  readonly temporary?: AdjacentTemporaryEvidence;
}
export type OwnedDataRetirementMutation = "revalidate" | "retire" | "rollback";
export interface OwnedDataRetirementMutationContext {
  readonly operationId: string;
  readonly participantIndex: number;
  readonly participant: OwnedDataRetirementParticipant;
  readonly participants: readonly TransactionParticipant[];
  readonly completed: number;
  readonly rolledBack: number;
  readonly state: "prepared" | "pending" | "rolling-back" | "terminal";
  readonly mutation: OwnedDataRetirementMutation;
}
const retirementMutationContexts = new WeakSet<object>();
export function isAuthenticOwnedDataRetirementMutationContext(value: OwnedDataRetirementMutationContext): boolean { return retirementMutationContexts.has(value); }
export interface ExternalAuthorization { readonly temporaryMode?: number }
export interface TransactionProducerCodec<T = unknown> {
  readonly schema: string;
  readonly version: number;
  readonly decodeSummary: (summary: unknown) => StoreResult<T>;
  readonly validatePlan: (participants: readonly TransactionParticipant[]) => StoreResult<void>;
  /** Trusted derivation of the complete canonical profile/checkout/settings lock vector. */
  readonly requiredLocks: (summary: unknown, participants: readonly TransactionParticipant[]) => StoreResult<readonly LifecycleLockIdentity[]>;
  /** Required for external participants and reconstructed from this trusted registry during recovery. */
  readonly authorizeExternal?: (context: ExternalMutationContext) => StoreResult<void | ExternalAuthorization> | Promise<StoreResult<void | ExternalAuthorization>>;
  /** Required only for explicit PiCC-owned record deletion. */
  readonly authorizeOwnedDelete?: (context: ExternalMutationContext) => StoreResult<void> | Promise<StoreResult<void>>;
  /** Required only for the distinct exact last-reference owned-data retirement participant. */
  readonly authorizeOwnedDataRetirement?: (context: OwnedDataRetirementMutationContext) => StoreResult<void> | Promise<StoreResult<void>>;
}
export interface TransactionCodecRegistry { readonly lookup: (schema: string, version: number) => TransactionProducerCodec | undefined }
function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function canonicalClone<T>(value: T): StoreResult<T> {
  const bytes = canonicalJsonBytes(value); if (!bytes.ok) return bytes as StoreResult<T>;
  return { ok: true, value: deepFreeze(JSON.parse(Buffer.from(bytes.value).toString("utf8")) as T) };
}
function validCodecIdentity(schema: unknown, version: unknown): schema is string {
  return typeof schema === "string" && /^[a-z][a-z0-9.-]{0,127}$/.test(schema) && typeof version === "number" && Number.isSafeInteger(version) && version >= 1;
}
export function createTransactionCodecRegistry(codecs: readonly TransactionProducerCodec[]): StoreResult<TransactionCodecRegistry> {
  const map = new Map<string, TransactionProducerCodec>();
  for (const codec of codecs) {
    if (!validCodecIdentity(codec.schema, codec.version) || typeof codec.decodeSummary !== "function" || typeof codec.validatePlan !== "function" || typeof codec.requiredLocks !== "function") return fail("invalid-codec", "Trusted transaction codec identity or callbacks are invalid");
    const key = `${codec.schema}\0${codec.version}`; if (map.has(key)) return fail("invalid-codec", "Trusted transaction codec identity is duplicated");
    const decodeSummary = codec.decodeSummary.bind(codec); const validatePlan = codec.validatePlan.bind(codec);
    const requiredLocks = codec.requiredLocks.bind(codec); const authorizeExternal = codec.authorizeExternal?.bind(codec); const authorizeOwnedDelete = codec.authorizeOwnedDelete?.bind(codec); const authorizeOwnedDataRetirement = codec.authorizeOwnedDataRetirement?.bind(codec);
    map.set(key, Object.freeze({ schema: codec.schema, version: codec.version, decodeSummary, validatePlan, requiredLocks, ...(authorizeExternal === undefined ? {} : { authorizeExternal }), ...(authorizeOwnedDelete === undefined ? {} : { authorizeOwnedDelete }), ...(authorizeOwnedDataRetirement === undefined ? {} : { authorizeOwnedDataRetirement }) }));
  }
  return { ok: true, value: Object.freeze({ lookup: (schema: string, version: number) => map.get(`${schema}\0${version}`) }) };
}

// Generic path lists are not semantic authority; external targets require trusted producer callbacks.
export interface TransactionTargetAuthority { readonly targets: readonly string[] }
export async function bindTransactionTargetsForTrustedCode(_targets: readonly string[]): Promise<StoreResult<TransactionTargetAuthority>> {
  return fail("unsafe-target", "Generic external path authority is unsupported; register a reconstructible producer callback");
}

interface Identity { readonly dev: bigint; readonly ino: bigint }
function identity(stat: BigIntStats): Identity { return { dev: stat.dev, ino: stat.ino }; }
function samePath(a: string, b: string): boolean { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
async function ordinaryFile(candidate: string): Promise<BigIntStats> {
  const stat = await fs.lstat(candidate, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error("not ordinary file"); return stat;
}
async function ordinaryDirectory(candidate: string): Promise<BigIntStats> {
  const stat = await fs.lstat(candidate, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not ordinary directory"); return stat;
}
async function captureEvidence(candidate: string, targetMayBeAbsent: boolean): Promise<PathEvidence> {
  const resolved = path.resolve(candidate); const parent = path.dirname(resolved);
  const parentStat = await ordinaryDirectory(parent); const canonicalParent = await fs.realpath(parent);
  if (!samePath(parent, canonicalParent)) throw new Error("aliased parent");
  let target: BigIntStats | undefined;
  try { target = await ordinaryFile(resolved); if (!samePath(await fs.realpath(resolved), resolved)) throw new Error("aliased target"); }
  catch (error) { if (!targetMayBeAbsent || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return Object.freeze({ path: resolved, canonicalParent, parentDev: parentStat.dev.toString(), parentIno: parentStat.ino.toString(),
    ...(target === undefined ? {} : { targetDev: target.dev.toString(), targetIno: target.ino.toString() }) });
}
function validMissingParent(value: unknown): value is MissingParentRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return exactKeys(item, ["ancestorDev", "ancestorIno", "canonicalAncestor", "path"])
    && typeof item.path === "string" && path.isAbsolute(item.path) && typeof item.canonicalAncestor === "string" && path.isAbsolute(item.canonicalAncestor)
    && typeof item.ancestorDev === "string" && /^\d+$/.test(item.ancestorDev) && typeof item.ancestorIno === "string" && /^\d+$/.test(item.ancestorIno);
}
function validCreatedParent(value: unknown): value is CreatedParentEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return exactKeys(item, ["dev", "finalPath", "ino", "temporaryPath"]) && typeof item.temporaryPath === "string" && path.isAbsolute(item.temporaryPath)
    && typeof item.finalPath === "string" && path.isAbsolute(item.finalPath) && !samePath(item.temporaryPath, item.finalPath)
    && samePath(path.dirname(item.temporaryPath), path.dirname(item.finalPath))
    && typeof item.dev === "string" && /^\d+$/.test(item.dev) && typeof item.ino === "string" && /^\d+$/.test(item.ino);
}
function validEvidenceShape(value: unknown): value is PathEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>; const withTarget = "targetDev" in item || "targetIno" in item;
  return exactKeys(item, withTarget ? ["canonicalParent", "parentDev", "parentIno", "path", "targetDev", "targetIno"] : ["canonicalParent", "parentDev", "parentIno", "path"])
    && typeof item.path === "string" && path.isAbsolute(item.path) && typeof item.canonicalParent === "string" && path.isAbsolute(item.canonicalParent)
    && typeof item.parentDev === "string" && /^\d+$/.test(item.parentDev) && typeof item.parentIno === "string" && /^\d+$/.test(item.parentIno)
    && (!withTarget || (typeof item.targetDev === "string" && /^\d+$/.test(item.targetDev) && typeof item.targetIno === "string" && /^\d+$/.test(item.targetIno)));
}
async function validateEvidence(evidence: PathEvidence, requireOriginalTarget: boolean): Promise<boolean> {
  try {
    const parent = await ordinaryDirectory(path.dirname(evidence.path));
    if (!samePath(path.dirname(evidence.path), evidence.canonicalParent) || !samePath(await fs.realpath(path.dirname(evidence.path)), evidence.canonicalParent)
      || parent.dev.toString() !== evidence.parentDev || parent.ino.toString() !== evidence.parentIno) return false;
    if (requireOriginalTarget) {
      const target = await ordinaryFile(evidence.path);
      return evidence.targetDev === target.dev.toString() && evidence.targetIno === target.ino.toString() && samePath(await fs.realpath(evidence.path), evidence.path);
    }
    return true;
  } catch { return false; }
}
async function fileDigest(candidate: string): Promise<Sha256 | undefined> {
  try { return sha256(await fs.readFile((await ordinaryFile(candidate), candidate))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function isOwnedDataRetirementParticipant(participant: TransactionParticipant): participant is OwnedDataRetirementParticipant { return participant.kind === "owned-data-retirement"; }
function isOwnedDataRetirement(participant: TransactionParticipant): participant is OwnedDataRetirementParticipant { return isOwnedDataRetirementParticipant(participant); }
function participantEffect(participant: OrdinaryTransactionParticipant): "replace" | "delete" { return participant.effect ?? "replace"; }
function participantForDigest(participant: TransactionParticipant): unknown {
  if (isOwnedDataRetirement(participant)) return { kind: participant.kind, key: participant.key, profileKey: participant.profileKey, qualifiedIdentity: participant.qualifiedIdentity,
    dataPath: participant.dataPath, destinationPath: participant.destinationPath, state: participant.state, sourceEvidence: participant.sourceEvidence, producerEvidence: participant.producerEvidence };
  return { kind: participant.kind, ...(participant.effect === undefined ? {} : { effect: participant.effect }), key: participant.key, ownerKey: participant.ownerKey, scopeKey: participant.scopeKey,
    targetPath: participant.targetPath, targetClass: participant.targetClass, precondition: participant.precondition,
    stagedPath: participant.stagedPath, stagedDigest: participant.stagedDigest, rollback: participant.rollback,
    producerEvidence: participant.producerEvidence, targetEvidence: participant.targetEvidence, stagedEvidence: participant.stagedEvidence,
    ...(participant.backupEvidence === undefined ? {} : { backupEvidence: participant.backupEvidence }),
    ...(participant.missingParent === undefined ? {} : { missingParent: participant.missingParent }),
    ...(participant.generationId === undefined ? {} : { generationId: participant.generationId }) };
}
function ownedDataRoot(store: OwnedStateStore): string { return store.dataRoot; }
function exactRetirementDataPath(store: OwnedStateStore, qualifiedIdentity: string): string {
  const digest = createHash("sha256").update(qualifiedIdentity, "utf8").digest("base64url");
  return path.join(ownedDataRoot(store), `plugin-${digest}`);
}
function retirementDestination(store: OwnedStateStore, operationId: string, index: number, authority: Pick<OwnedDataRetirementParticipant, "key" | "profileKey" | "qualifiedIdentity" | "state" | "sourceEvidence" | "producerEvidence">): string {
  const bytes = canonicalJsonBytes({ operationId, participantIndex: index, key: authority.key, profileKey: authority.profileKey, qualifiedIdentity: authority.qualifiedIdentity,
    state: authority.state, sourceEvidence: authority.sourceEvidence, producerEvidence: authority.producerEvidence });
  if (!bytes.ok) throw new Error("retirement-authority");
  return path.join(store.quarantineRoot, `retired-data-${sha256(bytes.value).slice("sha256:".length)}`);
}
async function captureDirectoryEvidence(candidate: string, targetMayBeAbsent: boolean): Promise<DirectoryIdentityEvidence> {
  const resolved = path.resolve(candidate); const parent = path.dirname(resolved); const parentStat = await ordinaryDirectory(parent);
  if (!samePath(await fs.realpath(parent), parent)) throw new Error("aliased parent");
  let target: BigIntStats | undefined;
  try { target = await ordinaryDirectory(resolved); if (!samePath(await fs.realpath(resolved), resolved)) throw new Error("aliased target"); }
  catch (error) { if (!targetMayBeAbsent || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return Object.freeze({ path: resolved, canonicalParent: parent, parentDev: parentStat.dev.toString(), parentIno: parentStat.ino.toString(), ...(target === undefined ? {} : { targetDev: target.dev.toString(), targetIno: target.ino.toString() }) });
}
async function normalizeParticipant(store: OwnedStateStore, raw: TransactionParticipant, operationId: string, index: number): Promise<StoreResult<TransactionParticipant>> {
  if (isOwnedDataRetirement(raw)) {
    try {
      if (!/^[A-Za-z0-9._-]{1,256}$/.test(raw.key) || raw.profileKey !== store.profileKey || !isQualifiedPluginId(raw.qualifiedIdentity)) throw new Error("identity");
      const expectedSource = exactRetirementDataPath(store, raw.qualifiedIdentity); const expectedDestination = retirementDestination(store, operationId, index, raw);
      if (!samePath(path.resolve(raw.dataPath), expectedSource) || !samePath(path.resolve(raw.destinationPath), expectedDestination)) return fail("unsafe-target", "Owned data retirement paths are not the internally derived exact profile children");
      try { await fs.lstat(expectedDestination); return fail("unsafe-target", "Operation-owned retirement destination already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const evidence = await captureDirectoryEvidence(expectedSource, true); const state = evidence.targetDev === undefined ? "absent" : "present";
      if (raw.state !== state) return fail("stale-precondition", "Owned data retirement presence changed before preparation");
      return { ok: true, value: Object.freeze({ ...raw, dataPath: expectedSource, destinationPath: expectedDestination, sourceEvidence: evidence }) };
    } catch { return fail("invalid-participant", "Owned data retirement participant is malformed or aliases nonordinary storage"); }
  }
  try {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(raw.kind) || !/^[A-Za-z0-9._-]{1,256}$/.test(raw.key)
      || !/^[A-Za-z0-9._-]{1,128}$/.test(raw.ownerKey) || !/^[A-Za-z0-9._-]{1,256}$/.test(raw.scopeKey)
      || !path.isAbsolute(raw.targetPath) || !path.isAbsolute(raw.stagedPath) || !/^sha256:[a-f0-9]{64}$/.test(raw.stagedDigest)) throw new Error("identity");
    const target = path.resolve(raw.targetPath); const staged = path.resolve(raw.stagedPath);
    if (!isContainedPath(store.stagingRoot, staged) || samePath(staged, store.stagingRoot) || await fileDigest(staged) !== raw.stagedDigest) return fail("invalid-staging", "Staged payload lacks exact canonical digest/identity evidence");
    const partition = ownedRecordPartition(store, raw.ownerKey, raw.scopeKey); if (!partition.ok) return partition;
    if (raw.targetClass === "owned" && !isContainedPath(partition.value, target)) return fail("unsafe-target", "Owned target is outside its producer owner/scope partition");
    if (raw.targetClass === "generation" && (!isContainedPath(store.generationsRoot, target) || samePath(target, store.generationsRoot))) return fail("unsafe-target", "Generation target is outside this profile");
    if (raw.targetClass === "external" && raw.generationId !== undefined) return fail("invalid-participant", "External participant cannot identify a generation");
    if (raw.missingParent !== undefined) {
      const request = raw.missingParent;
      if (raw.targetClass !== "external" || raw.precondition.state !== "absent" || !validMissingParent(request) || !samePath(request.path, path.dirname(target)) || !samePath(request.canonicalAncestor, path.dirname(request.path))) return fail("invalid-participant", "Only an absent external target may request one exact missing direct parent");
      const ancestor = await ordinaryDirectory(request.canonicalAncestor);
      if (!samePath(await fs.realpath(request.canonicalAncestor), request.canonicalAncestor) || ancestor.dev.toString() !== request.ancestorDev || ancestor.ino.toString() !== request.ancestorIno) return fail("unsafe-target", "Missing-parent ancestor authority changed");
      try { await fs.lstat(request.path); return fail("unsafe-target", "A planned missing parent already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (raw.effect !== undefined && raw.effect !== "replace" && raw.effect !== "delete") throw new Error("effect");
    if (raw.precondition.state !== "absent" && (raw.precondition.state !== "present" || !/^sha256:[a-f0-9]{64}$/.test(raw.precondition.digest))) throw new Error("precondition");
    if (raw.precondition.state === "absent" ? raw.rollback.kind !== "delete-new-target" : raw.rollback.kind !== "restore-backup" || raw.rollback.digest !== raw.precondition.digest) return fail("invalid-rollback", "CAS state and exact rollback evidence disagree");
    if (raw.effect === "delete" && (raw.targetClass !== "owned" || raw.precondition.state !== "present" || raw.rollback.kind !== "restore-backup" || raw.stagedDigest !== raw.precondition.digest || raw.missingParent !== undefined || raw.generationId !== undefined)) return fail("invalid-participant", "Forward deletion requires one exact present PiCC-owned record and authentic prior-byte evidence");
    if (raw.targetClass === "generation" && (typeof raw.generationId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(raw.generationId))) return fail("invalid-participant", "Generation participant requires a bounded id");
    if (raw.targetClass !== "generation" && raw.generationId !== undefined) return fail("invalid-participant", "Generation ids are confined to the generation participant");
    const targetEvidence = raw.missingParent === undefined
      ? await captureEvidence(target, raw.precondition.state === "absent")
      : Object.freeze({ path: target, canonicalParent: raw.missingParent.path, parentDev: raw.missingParent.ancestorDev, parentIno: raw.missingParent.ancestorIno });
    if (raw.precondition.state === "present" && await fileDigest(target) !== raw.precondition.digest) return fail("stale-precondition", "Present target no longer matches its CAS digest");
    const stagedEvidence = await captureEvidence(staged, false);
    let backupEvidence: PathEvidence | undefined;
    if (raw.rollback.kind === "restore-backup") {
      const backup = path.resolve(raw.rollback.path);
      if (!isContainedPath(store.stagingRoot, backup) || await fileDigest(backup) !== raw.rollback.digest) return fail("invalid-rollback", "Rollback backup lacks canonical contained digest evidence");
      backupEvidence = await captureEvidence(backup, false);
    }
    return { ok: true, value: Object.freeze({ ...raw, targetPath: target, stagedPath: staged, targetEvidence, stagedEvidence, ...(backupEvidence === undefined ? {} : { backupEvidence }) }) };
  } catch { return fail("invalid-participant", "Transaction participant is malformed or aliases nonordinary storage"); }
}

function validRequiredLocks(store: OwnedStateStore, locks: unknown): locks is readonly LifecycleLockIdentity[] {
  if (!Array.isArray(locks) || locks.length === 0 || locks.length > 128) return false;
  const rank = (item: LifecycleLockIdentity): number => item.kind === "profile" ? 0 : item.kind === "checkout" ? 1 : 2;
  if (!locks.every((item) => typeof item === "object" && item !== null && !Array.isArray(item)
    && exactKeys(item as unknown as Record<string, unknown>, ["key", "kind"])
    && ((item as LifecycleLockIdentity).kind === "profile" || (item as LifecycleLockIdentity).kind === "checkout" || (item as LifecycleLockIdentity).kind === "settings")
    && typeof (item as LifecycleLockIdentity).key === "string" && (item as LifecycleLockIdentity).key.length > 0 && (item as LifecycleLockIdentity).key.length <= 256 && !(item as LifecycleLockIdentity).key.includes("\0"))) return false;
  if (locks[0]!.kind !== "profile" || locks[0]!.key !== store.profileKey || new Set(locks.map((item) => `${item.kind}\0${item.key}`)).size !== locks.length) return false;
  return locks.every((item, index) => index === 0 || rank(locks[index - 1]!) < rank(item)
    || (rank(locks[index - 1]!) === rank(item) && Buffer.compare(Buffer.from(locks[index - 1]!.key, "utf8"), Buffer.from(item.key, "utf8")) < 0));
}

function validateGenerationRelationship(participants: readonly TransactionParticipant[]): StoreResult<void> {
  const indexes = participants.flatMap((participant, index) => !isOwnedDataRetirement(participant) && participant.targetClass === "generation" ? [index] : []);
  if (indexes.length > 1 || (indexes.length === 1 && indexes[0] !== participants.length - 1)) return fail("invalid-plan", "At most one non-empty generation participant is allowed and it must be last");
  return { ok: true, value: undefined };
}

export interface PreparedTransaction {
  readonly operationId: string; readonly producerSchema: string; readonly producerVersion: number;
  readonly confirmationSummary: unknown; readonly confirmationDigest: Sha256;
  readonly participants: readonly TransactionParticipant[]; readonly requiredLocks: readonly LifecycleLockIdentity[]; readonly planDigest: Sha256;
}
const preparedCapabilities = new WeakMap<PreparedTransaction, { readonly store: OwnedStateStore; readonly codec: TransactionProducerCodec }>();
function journalPath(store: OwnedStateStore, operationId: string): string { return path.join(store.journalsRoot, `${operationId}.json`); }
function receiptPath(store: OwnedStateStore, operationId: string): string { return path.join(store.receiptsRoot, `${operationId}.json`); }

export async function createOwnedDataRetirementParticipant(inputs: { readonly store: OwnedStateStore; readonly operationId: string; readonly participantIndex: number; readonly key: string; readonly qualifiedIdentity: string; readonly producerEvidence: unknown }): Promise<StoreResult<OwnedDataRetirementParticipant>> {
  const valid = await revalidateOwnedStateStore(inputs.store); if (!valid.ok) return valid;
  try {
    const dataPath = exactRetirementDataPath(inputs.store, inputs.qualifiedIdentity); const sourceEvidence = await captureDirectoryEvidence(dataPath, true);
    const authority = Object.freeze({ kind: "owned-data-retirement" as const, key: inputs.key, profileKey: inputs.store.profileKey,
      qualifiedIdentity: inputs.qualifiedIdentity, dataPath, state: sourceEvidence.targetDev === undefined ? "absent" as const : "present" as const, sourceEvidence, producerEvidence: inputs.producerEvidence });
    const participant: OwnedDataRetirementParticipant = Object.freeze({ ...authority, destinationPath: retirementDestination(inputs.store, inputs.operationId, inputs.participantIndex, authority) });
    return { ok: true, value: participant };
  } catch { return fail("invalid-participant", "Exact owned data retirement participant could not be derived"); }
}

export async function prepareTransaction<T>(inputs: { readonly store: OwnedStateStore; readonly codec: TransactionProducerCodec<T>; readonly operationId: string; readonly confirmationSummary: unknown; readonly participants: readonly TransactionParticipant[]; readonly targetAuthority?: TransactionTargetAuthority }): Promise<StoreResult<PreparedTransaction>> {
  const storeValid = await revalidateOwnedStateStore(inputs.store); if (!storeValid.ok) return storeValid;
  if (!validCodecIdentity(inputs.codec.schema, inputs.codec.version) || typeof inputs.codec.decodeSummary !== "function" || typeof inputs.codec.validatePlan !== "function" || typeof inputs.codec.requiredLocks !== "function") return fail("invalid-codec", "Producer codec identity or callbacks are invalid at preparation");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(inputs.operationId)) return fail("invalid-operation", "Operation id is invalid");
  if (inputs.targetAuthority !== undefined) return fail("unsafe-target", "Generic external authority cannot prepare a transaction");
  const decodeSummary = inputs.codec.decodeSummary.bind(inputs.codec); const validatePlan = inputs.codec.validatePlan.bind(inputs.codec);
  const deriveRequiredLocks = inputs.codec.requiredLocks.bind(inputs.codec); const authorizeExternal = inputs.codec.authorizeExternal?.bind(inputs.codec); const authorizeOwnedDelete = inputs.codec.authorizeOwnedDelete?.bind(inputs.codec); const authorizeOwnedDataRetirement = inputs.codec.authorizeOwnedDataRetirement?.bind(inputs.codec);
  const codecSnapshot: TransactionProducerCodec = Object.freeze({ schema: inputs.codec.schema, version: inputs.codec.version, decodeSummary, validatePlan, requiredLocks: deriveRequiredLocks, ...(authorizeExternal === undefined ? {} : { authorizeExternal }), ...(authorizeOwnedDelete === undefined ? {} : { authorizeOwnedDelete }), ...(authorizeOwnedDataRetirement === undefined ? {} : { authorizeOwnedDataRetirement }) });
  const summaryClone = canonicalClone(inputs.confirmationSummary); if (!summaryClone.ok) return summaryClone;
  if (!decodeSummary(summaryClone.value).ok) return fail("invalid-summary", "Producer confirmation summary is invalid");
  const summaryBytes = canonicalJsonBytes(summaryClone.value); if (!summaryBytes.ok) return summaryBytes;
  if (inputs.participants.length === 0 || inputs.participants.length > 1024) return fail("invalid-plan", "Transaction participant count is invalid");
  const normalized: TransactionParticipant[] = [];
  for (const [index, raw] of inputs.participants.entries()) { const cloned = canonicalClone(raw); if (!cloned.ok) return fail("invalid-participant", "Transaction participant is not canonical bounded data"); const value = await normalizeParticipant(inputs.store, cloned.value, inputs.operationId, index); if (!value.ok) return value; normalized.push(deepFreeze(value.value)); }
  const participantTarget = (item: TransactionParticipant): string => isOwnedDataRetirement(item) ? item.dataPath : item.targetPath;
  if (new Set(normalized.map((item) => item.key)).size !== normalized.length || new Set(normalized.map((item) => process.platform === "win32" ? participantTarget(item).toLowerCase() : participantTarget(item))).size !== normalized.length) return fail("invalid-plan", "Participant keys and canonical targets must be unique");
  const generation = validateGenerationRelationship(normalized); if (!generation.ok) return generation;
  if (normalized.some((item) => !isOwnedDataRetirement(item) && item.targetClass === "external") && authorizeExternal === undefined) return fail("unsafe-target", "External participants require a reconstructible trusted producer callback");
  if (normalized.some((item) => !isOwnedDataRetirement(item) && item.effect === "delete") && authorizeOwnedDelete === undefined) return fail("unsafe-target", "Owned deletion requires reconstructible trusted producer authority");
  if (normalized.some(isOwnedDataRetirement) && authorizeOwnedDataRetirement === undefined) return fail("unsafe-target", "Owned data retirement requires reconstructible trusted producer authority");
  if (!validatePlan(normalized).ok) return fail("invalid-plan", "Producer rejected the exact normalized plan");
  const locksResult = deriveRequiredLocks(summaryClone.value, normalized); if (!locksResult.ok) return fail("invalid-locks", "Producer could not derive required transaction locks");
  const locksClone = canonicalClone(locksResult.value); if (!locksClone.ok || !validRequiredLocks(inputs.store, locksClone.value)) return fail("invalid-locks", "Producer required locks are not an exact canonical profile-first vector");
  const planBytes = canonicalJsonBytes({ participants: normalized.map(participantForDigest), requiredLocks: locksClone.value }); if (!planBytes.ok) return planBytes;
  const prepared = deepFreeze({ operationId: inputs.operationId, producerSchema: codecSnapshot.schema, producerVersion: codecSnapshot.version,
    confirmationSummary: summaryClone.value, confirmationDigest: sha256(summaryBytes.value), participants: normalized, requiredLocks: locksClone.value, planDigest: sha256(planBytes.value) });
  for (const [index, participant] of normalized.entries()) if (!isOwnedDataRetirement(participant) && participantEffect(participant) === "delete") {
    try { await fs.lstat(deletionMarkerPath(inputs.store, prepared, index)); return fail("unsafe-target", "Operation-bound deletion evidence path already exists"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("unsafe-target", "Operation-bound deletion evidence path is unavailable"); }
  }
  for (const [index, participant] of normalized.entries()) if (isOwnedDataRetirement(participant)) {
    const authorized = await authorizeOwnedDataRetirement?.(retirementContext(prepared, participant, index, "revalidate"));
    if (authorized === undefined || !authorized.ok) return fail("invalid-producer-data", "Producer rejected prepared owned-data-retirement authority");
  }
  preparedCapabilities.set(prepared, { store: inputs.store, codec: codecSnapshot }); return { ok: true, value: prepared };
}

function validDirectoryEvidenceShape(value: unknown): value is DirectoryIdentityEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>; const present = "targetDev" in item || "targetIno" in item;
  return exactKeys(item, present ? ["canonicalParent", "parentDev", "parentIno", "path", "targetDev", "targetIno"] : ["canonicalParent", "parentDev", "parentIno", "path"])
    && typeof item.path === "string" && path.isAbsolute(item.path) && typeof item.canonicalParent === "string" && path.isAbsolute(item.canonicalParent)
    && typeof item.parentDev === "string" && /^\d+$/.test(item.parentDev) && typeof item.parentIno === "string" && /^\d+$/.test(item.parentIno)
    && (!present || (typeof item.targetDev === "string" && /^\d+$/.test(item.targetDev) && typeof item.targetIno === "string" && /^\d+$/.test(item.targetIno)));
}
function validParticipantShape(raw: unknown): raw is TransactionParticipant {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  if (value.kind === "owned-data-retirement") return exactKeys(value, ["dataPath", "destinationPath", "key", "kind", "producerEvidence", "profileKey", "qualifiedIdentity", "sourceEvidence", "state"])
    && typeof value.key === "string" && /^[A-Za-z0-9._-]{1,256}$/.test(value.key) && typeof value.profileKey === "string" && /^profile-[A-Za-z0-9_-]+$/.test(value.profileKey)
    && typeof value.qualifiedIdentity === "string" && isQualifiedPluginId(value.qualifiedIdentity)
    && typeof value.dataPath === "string" && path.isAbsolute(value.dataPath) && typeof value.destinationPath === "string" && path.isAbsolute(value.destinationPath)
    && (value.state === "absent" || value.state === "present") && validDirectoryEvidenceShape(value.sourceEvidence)
    && samePath(value.sourceEvidence.path, value.dataPath) && (value.state === "present" ? value.sourceEvidence.targetDev !== undefined : value.sourceEvidence.targetDev === undefined);
  const keys = ["key", "kind", "ownerKey", "precondition", "producerEvidence", "rollback", "scopeKey", "stagedDigest", "stagedEvidence", "stagedPath", "targetClass", "targetEvidence", "targetPath"];
  if ("effect" in value) keys.push("effect");
  if ("backupEvidence" in value) keys.push("backupEvidence"); if ("missingParent" in value) keys.push("missingParent"); if ("generationId" in value) keys.push("generationId");
  if (!exactKeys(value, keys) || typeof value.kind !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/.test(value.kind)
    || typeof value.key !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(value.key)
    || typeof value.ownerKey !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.ownerKey)
    || typeof value.scopeKey !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(value.scopeKey)
    || typeof value.targetPath !== "string" || !path.isAbsolute(value.targetPath) || typeof value.stagedPath !== "string" || !path.isAbsolute(value.stagedPath)
    || (value.effect !== undefined && value.effect !== "replace" && value.effect !== "delete")
    || (value.targetClass !== "owned" && value.targetClass !== "external" && value.targetClass !== "generation")
    || typeof value.stagedDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.stagedDigest)
    || !validEvidenceShape(value.targetEvidence) || !validEvidenceShape(value.stagedEvidence)
    || !samePath(value.targetEvidence.path, value.targetPath) || !samePath(value.stagedEvidence.path, value.stagedPath)
    || (value.missingParent !== undefined && (!validMissingParent(value.missingParent) || value.targetClass !== "external" || !samePath(value.missingParent.path, path.dirname(value.targetPath))))) return false;
  const pre = value.precondition as Record<string, unknown>; const rollback = value.rollback as Record<string, unknown>;
  if (typeof pre !== "object" || pre === null || Array.isArray(pre) || (pre.state === "absent" ? !exactKeys(pre, ["state"]) : pre.state !== "present" || !exactKeys(pre, ["digest", "state"]) || typeof pre.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(pre.digest))) return false;
  if (typeof rollback !== "object" || rollback === null || Array.isArray(rollback)) return false;
  if (rollback.kind === "delete-new-target") { if (!exactKeys(rollback, ["kind"]) || pre.state !== "absent" || "backupEvidence" in value) return false; }
  else if (rollback.kind === "restore-backup") { if (!exactKeys(rollback, ["digest", "kind", "path"]) || pre.state !== "present" || rollback.digest !== pre.digest || typeof rollback.path !== "string" || !path.isAbsolute(rollback.path) || typeof rollback.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(rollback.digest) || !validEvidenceShape(value.backupEvidence) || !samePath(value.backupEvidence.path, rollback.path)) return false; }
  else return false;
  if (value.missingParent !== undefined && (pre.state !== "absent" || value.targetClass !== "external")) return false;
  if (value.effect === "delete" && (value.targetClass !== "owned" || pre.state !== "present" || rollback.kind !== "restore-backup" || value.stagedDigest !== pre.digest || value.missingParent !== undefined || "generationId" in value)) return false;
  return value.targetClass === "generation" ? typeof value.generationId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value.generationId) : !("generationId" in value);
}

function retirementProgress(transaction: PreparedTransaction): Pick<OwnedDataRetirementMutationContext, "completed" | "rolledBack" | "state"> {
  const persisted = transaction as PreparedTransaction & Partial<Pick<TransactionJournal, "completed" | "rolledBack" | "state">> & Partial<Pick<TransactionReceipt, "outcome">>;
  if (persisted.outcome !== undefined) return { completed: persisted.outcome === "committed" ? transaction.participants.length : 0, rolledBack: persisted.outcome === "rolled-back" ? transaction.participants.length : 0, state: "terminal" };
  return { completed: persisted.completed ?? 0, rolledBack: persisted.rolledBack ?? 0, state: persisted.state ?? "prepared" };
}
function retirementContext(transaction: PreparedTransaction, participant: OwnedDataRetirementParticipant, participantIndex: number, mutation: OwnedDataRetirementMutation): OwnedDataRetirementMutationContext {
  const context = Object.freeze({ operationId: transaction.operationId, participantIndex, participant, participants: transaction.participants, ...retirementProgress(transaction), mutation });
  retirementMutationContexts.add(context); return context;
}

export async function revalidatePersistedTransaction(store: OwnedStateStore, transaction: PreparedTransaction, codec: TransactionProducerCodec, _targetAuthority?: TransactionTargetAuthority): Promise<StoreResult<void>> {
  if (!validCodecIdentity(codec.schema, codec.version) || codec.schema !== transaction.producerSchema || codec.version !== transaction.producerVersion
    || !codec.decodeSummary(transaction.confirmationSummary).ok || !transaction.participants.every(validParticipantShape) || !validRequiredLocks(store, transaction.requiredLocks)) return fail("invalid-producer-data", "Persisted transaction or producer identity is invalid");
  const generation = validateGenerationRelationship(transaction.participants); if (!generation.ok) return generation;
  if (transaction.participants.some((item) => !isOwnedDataRetirement(item) && item.targetClass === "external") && codec.authorizeExternal === undefined) return fail("unknown-producer", "External target callback is unavailable; operation remains inert");
  if (transaction.participants.some((item) => !isOwnedDataRetirement(item) && item.effect === "delete") && codec.authorizeOwnedDelete === undefined) return fail("unknown-producer", "Owned-delete callback is unavailable; operation remains inert");
  if (transaction.participants.some(isOwnedDataRetirement) && codec.authorizeOwnedDataRetirement === undefined) return fail("unknown-producer", "Owned-data-retirement callback is unavailable; operation remains inert");
  if (!codec.validatePlan(transaction.participants).ok) return fail("invalid-producer-data", "Producer rejected persisted plan");
  for (const [index, participant] of transaction.participants.entries()) {
    if (isOwnedDataRetirement(participant)) {
      const authorized = await codec.authorizeOwnedDataRetirement?.(retirementContext(transaction, participant, index, "revalidate"));
      if (authorized === undefined || !authorized.ok) return fail("invalid-producer-data", "Producer rejected persisted owned-data-retirement authority");
      continue;
    }
    if (participant.targetClass === "external") {
      const authorized = await codec.authorizeExternal?.({ operationId: transaction.operationId, participant, mutation: "revalidate" });
      if (authorized === undefined || !authorized.ok) return fail("invalid-producer-data", "Producer rejected persisted external authority");
    }
    if (participant.effect === "delete") {
      const authorized = await codec.authorizeOwnedDelete?.({ operationId: transaction.operationId, participant, mutation: "revalidate" });
      if (authorized === undefined || !authorized.ok) return fail("invalid-producer-data", "Producer rejected persisted owned-delete authority");
    }
  }
  const derivedLocks = codec.requiredLocks(transaction.confirmationSummary, transaction.participants);
  if (!derivedLocks.ok || !lockIdentitiesEqual(derivedLocks.value, transaction.requiredLocks)) return fail("invalid-producer-data", "Producer required-lock derivation changed");
  const summary = canonicalJsonBytes(transaction.confirmationSummary); const plan = canonicalJsonBytes({ participants: transaction.participants.map(participantForDigest), requiredLocks: transaction.requiredLocks });
  if (!summary.ok || !plan.ok || sha256(summary.value) !== transaction.confirmationDigest || sha256(plan.value) !== transaction.planDigest) return fail("digest-mismatch", "Transaction summary or plan binding changed");
  const terminal = (transaction as PreparedTransaction & Partial<Pick<TransactionReceipt, "outcome">>).outcome !== undefined;
  for (const [index, participant] of transaction.participants.entries()) {
    if (isOwnedDataRetirement(participant)) {
      if (participant.profileKey !== store.profileKey || !samePath(participant.dataPath, exactRetirementDataPath(store, participant.qualifiedIdentity))
        || !samePath(participant.destinationPath, retirementDestination(store, transaction.operationId, index, participant))
        || !await validateRetirementParent(store, participant)) return fail("unsafe-target", "Owned data retirement authority changed or escaped this profile");
      continue;
    }
    const partition = ownedRecordPartition(store, participant.ownerKey, participant.scopeKey); if (!partition.ok) return partition;
    if (participant.targetClass === "owned" && !isContainedPath(partition.value, participant.targetPath)) return fail("unsafe-target", "Owned participant escaped its partition");
    if (participant.targetClass === "generation" && !isContainedPath(store.generationsRoot, participant.targetPath)) return fail("unsafe-target", "Generation escaped this profile");
    if (!isContainedPath(store.stagingRoot, participant.stagedPath) || !terminal && (!await validateEvidence(participant.stagedEvidence!, false) || await fileDigest(participant.stagedPath) !== participant.stagedDigest)) return fail("changed-staged", "Persisted staged payload changed or lost canonical authority");
    if (participant.missingParent === undefined && !await validateEvidence(participant.targetEvidence!, false)) return fail("unsafe-target", "Target parent identity or canonical authority changed");
    if (participant.missingParent !== undefined) { const ancestor = participant.missingParent; try { const stat = await ordinaryDirectory(ancestor.canonicalAncestor); if (stat.dev.toString() !== ancestor.ancestorDev || stat.ino.toString() !== ancestor.ancestorIno || !samePath(await fs.realpath(ancestor.canonicalAncestor), ancestor.canonicalAncestor)) return fail("unsafe-target", "Missing-parent ancestor authority changed"); } catch { return fail("unsafe-target", "Missing-parent ancestor authority changed"); } }
    if (participant.rollback.kind === "restore-backup" && (!isContainedPath(store.stagingRoot, participant.rollback.path) || participant.backupEvidence === undefined || !terminal && (!await validateEvidence(participant.backupEvidence, false) || await fileDigest(participant.rollback.path) !== participant.rollback.digest))) return fail("invalid-rollback", "Rollback backup changed or escaped");
  }
  return { ok: true, value: undefined };
}
async function validateRetirementParent(store: OwnedStateStore, participant: OwnedDataRetirementParticipant): Promise<boolean> {
  try {
    const dataRoot = ownedDataRoot(store); const parent = await ordinaryDirectory(dataRoot); const quarantine = await ordinaryDirectory(store.quarantineRoot);
    return samePath(participant.sourceEvidence.canonicalParent, dataRoot) && samePath(path.dirname(participant.dataPath), dataRoot)
      && samePath(path.dirname(participant.destinationPath), store.quarantineRoot)
      && parent.dev.toString() === participant.sourceEvidence.parentDev && parent.ino.toString() === participant.sourceEvidence.parentIno
      && parent.dev === quarantine.dev && samePath(await fs.realpath(dataRoot), dataRoot) && samePath(await fs.realpath(store.quarantineRoot), store.quarantineRoot);
  } catch { return false; }
}
type RetirementStatus = "absent-noop" | "source" | "retired" | "cleaned" | "invalid";
async function retirementStatus(store: OwnedStateStore, participant: OwnedDataRetirementParticipant): Promise<RetirementStatus> {
  if (!await validateRetirementParent(store, participant)) return "invalid";
  const inspect = async (candidate: string): Promise<BigIntStats | undefined | null> => { try { const stat = await ordinaryDirectory(candidate); return samePath(await fs.realpath(candidate), candidate) ? stat : null; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null; } };
  const source = await inspect(participant.dataPath); const destination = await inspect(participant.destinationPath);
  if (source === null || destination === null) return "invalid";
  if (participant.state === "absent") return source === undefined && destination === undefined ? "absent-noop" : "invalid";
  const exact = (stat: BigIntStats | undefined): boolean => stat !== undefined && stat.dev.toString() === participant.sourceEvidence.targetDev && stat.ino.toString() === participant.sourceEvidence.targetIno;
  if (exact(source) && destination === undefined) return "source";
  if (source === undefined && exact(destination)) return "retired";
  if (source === undefined && destination === undefined) return "cleaned";
  return "invalid";
}
async function authorizeRetirement(codec: TransactionProducerCodec, journal: PreparedTransaction, participant: OwnedDataRetirementParticipant, index: number, mutation: OwnedDataRetirementMutation): Promise<void> {
  const result = await codec.authorizeOwnedDataRetirement?.(retirementContext(journal, participant, index, mutation));
  if (result === undefined || !result.ok) throw new Error("owned-data-retirement-authority");
}

export type TransactionFaultPhase = "before-journal" | "after-journal" | "before-parent-creation" | "after-parent-creation" | "before-parent-identity-journal" | "after-parent-identity-journal" | "before-parent-publication" | "after-parent-publication" | "before-parent-removal" | "after-parent-removal" | "before-temp-write" | "after-temp-write" | "after-flush" | "before-replacement" | "after-replacement" | "before-forward-deletion" | "after-forward-deletion-marker" | "after-forward-deletion-mutation" | "after-forward-deletion" | "before-generation-marker" | "after-generation-marker" | "before-receipt" | "after-receipt" | "before-retirement" | "after-retirement" | "before-data-retirement-rename" | "after-data-retirement-rename" | "after-data-retirement-sync" | "before-data-rollback-rename" | "after-data-rollback-rename" | "after-data-rollback-sync" | "before-data-cleanup-entry" | "after-data-cleanup-entry";
export interface TransactionFaultSeam { readonly hit: (phase: TransactionFaultPhase, participantIndex?: number) => void | Promise<void> }
const NO_FAULTS: TransactionFaultSeam = Object.freeze({ hit: () => undefined });
export interface TransactionJournal extends PreparedTransaction {
  readonly format: "picc-transaction-journal"; readonly formatVersion: 1; readonly lockBindings: readonly JournalLockBinding[];
  readonly completed: number; readonly rolledBack: number; readonly createdParents: readonly (CreatedParentEvidence | null)[]; readonly state: "prepared" | "pending" | "rolling-back";
}
export type PrecommitFailureCategory = "cancelled" | "stale-precondition" | "changed-staged" | "storage-failure";
export interface TransactionReceipt extends PreparedTransaction {
  readonly format: "picc-transaction-receipt"; readonly formatVersion: 1; readonly lockBindings: readonly JournalLockBinding[];
  readonly outcome: "committed" | "rolled-back" | "failed-before-commit"; readonly completed: number; readonly createdParents: readonly (CreatedParentEvidence | null)[];
  readonly failureCategory?: PrecommitFailureCategory; readonly generationId?: string;
}
export type TransactionOutcome =
  | { readonly state: "committed"; readonly receipt: TransactionReceipt }
  | { readonly state: "rolled-back"; readonly receipt: TransactionReceipt }
  | { readonly state: "pending-recovery"; readonly operationId: string; readonly completed: number; readonly cause: string }
  | { readonly state: "failed-before-commit"; readonly receipt: TransactionReceipt }
  | { readonly state: "rejected"; readonly operationId: string; readonly cause: string };

async function syncDirectory(directory: string): Promise<void> {
  try { const handle = await fs.open(directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES" && code !== "EBADF")) throw error; }
}
async function renameReplace(source: string, target: string, beforeAttempt?: () => Promise<void>): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await beforeAttempt?.(); await fs.rename(source, target); return; }
    catch (error) { last = error; if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; await new Promise<void>((resolve) => setTimeout(resolve, attempt + 1)); }
  }
  throw last;
}
async function writeCanonical(target: string, value: unknown, exclusive: boolean, beforePublication?: () => Promise<void>): Promise<void> {
  const bytes = canonicalJsonBytes(value); if (!bytes.ok) throw new Error(bytes.message);
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes.value); await handle.sync(); } finally { await handle.close(); }
  try {
    await beforePublication?.();
    if (exclusive) {
      let linked = false; let last: unknown;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try { await beforePublication?.(); await fs.link(temporary, target); linked = true; break; }
        catch (error) { last = error; if ((error as NodeJS.ErrnoException).code === "EEXIST" || process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; await new Promise<void>((resolve) => setTimeout(resolve, attempt + 1)); }
      }
      if (!linked) throw last; await fs.rm(temporary);
    } else await renameReplace(temporary, target, beforePublication);
    await syncDirectory(path.dirname(target));
  } catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error; }
}
async function leaseBoundary(store: OwnedStateStore, lease: LifecycleLockLease, operationId: string, bindings: readonly JournalLockBinding[], requiredLocks: readonly LifecycleLockIdentity[]): Promise<void> {
  const valid = await validateLifecycleLockLease(store, lease, operationId, bindings, requiredLocks); if (!valid.ok) throw new Error(valid.code);
}
async function persistJournal(store: OwnedStateStore, journal: TransactionJournal, lease: LifecycleLockLease, faults: TransactionFaultSeam, exclusive = false, index?: number, beforePublication?: () => Promise<void>): Promise<void> {
  await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks); await faults.hit("before-journal", index);
  await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
  await writeCanonical(journalPath(store, journal.operationId), journal, exclusive, async () => { await beforePublication?.(); await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks); });
  await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks); await faults.hit("after-journal", index);
  await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
}
async function persistReceipt(store: OwnedStateStore, receipt: TransactionReceipt, lease: LifecycleLockLease, faults: TransactionFaultSeam): Promise<void> {
  await leaseBoundary(store, lease, receipt.operationId, receipt.lockBindings, receipt.requiredLocks); await faults.hit("before-receipt");
  await leaseBoundary(store, lease, receipt.operationId, receipt.lockBindings, receipt.requiredLocks);
  await writeCanonical(receiptPath(store, receipt.operationId), receipt, true, () => leaseBoundary(store, lease, receipt.operationId, receipt.lockBindings, receipt.requiredLocks));
  await leaseBoundary(store, lease, receipt.operationId, receipt.lockBindings, receipt.requiredLocks); await faults.hit("after-receipt");
  await leaseBoundary(store, lease, receipt.operationId, receipt.lockBindings, receipt.requiredLocks);
}
async function authorize(codec: TransactionProducerCodec, operationId: string, participant: OrdinaryTransactionParticipant, mutation: ExternalMutation, temporary?: AdjacentTemporaryEvidence): Promise<ExternalAuthorization | undefined> {
  if (participant.targetClass === "external") {
    const result = await codec.authorizeExternal?.({ operationId, participant, mutation, ...(temporary === undefined ? {} : { temporary }) });
    if (result === undefined || !result.ok) throw new Error("external-authority");
    return result.value === undefined ? undefined : result.value;
  }
  if (participant.effect === "delete") {
    const result = await codec.authorizeOwnedDelete?.({ operationId, participant, mutation, ...(temporary === undefined ? {} : { temporary }) });
    if (result === undefined || !result.ok) throw new Error("owned-delete-authority");
  }
  return undefined;
}
async function captureTemporary(handle: FileHandle, temporary: string, digest: Sha256): Promise<AdjacentTemporaryEvidence> {
  const opened = await handle.stat({ bigint: true }); const pathname = await fs.lstat(temporary, { bigint: true });
  if (!opened.isFile() || opened.nlink !== 1n || !pathname.isFile() || pathname.isSymbolicLink() || opened.dev !== pathname.dev || opened.ino !== pathname.ino || !samePath(await fs.realpath(temporary), temporary)) throw new Error("temporary-identity");
  return Object.freeze({ path: temporary, dev: opened.dev.toString(), ino: opened.ino.toString(), digest });
}
async function validateTemporary(temporary: AdjacentTemporaryEvidence): Promise<boolean> {
  try {
    const handle = await fs.open(temporary.path, constants.O_RDONLY);
    try {
      const opened = await handle.stat({ bigint: true }); const pathname = await fs.lstat(temporary.path, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !pathname.isFile() || pathname.isSymbolicLink() || opened.dev !== pathname.dev || opened.ino !== pathname.ino
        || opened.dev.toString() !== temporary.dev || opened.ino.toString() !== temporary.ino || !samePath(await fs.realpath(temporary.path), temporary.path)) return false;
      const bytes = await handle.readFile(); const after = await fs.lstat(temporary.path, { bigint: true });
      return after.dev === opened.dev && after.ino === opened.ino && sha256(bytes) === temporary.digest;
    } finally { await handle.close(); }
  } catch { return false; }
}
async function createdParentLocation(participant: OrdinaryTransactionParticipant, created: CreatedParentEvidence | null | undefined): Promise<string | undefined> {
  if (participant.missingParent === undefined || created === null || created === undefined || !samePath(created.finalPath, participant.missingParent.path)) return undefined;
  try {
    const ancestor = await ordinaryDirectory(participant.missingParent.canonicalAncestor);
    if (ancestor.dev.toString() !== participant.missingParent.ancestorDev || ancestor.ino.toString() !== participant.missingParent.ancestorIno || !samePath(await fs.realpath(participant.missingParent.canonicalAncestor), participant.missingParent.canonicalAncestor)) return undefined;
    for (const candidate of [created.finalPath, created.temporaryPath]) {
      try { const parent = await ordinaryDirectory(candidate); if (parent.dev.toString() === created.dev && parent.ino.toString() === created.ino && samePath(await fs.realpath(candidate), candidate)) return candidate; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
    }
    return undefined;
  } catch { return undefined; }
}
async function validateCreatedParent(participant: OrdinaryTransactionParticipant, created: CreatedParentEvidence | null | undefined, requireFinal = true): Promise<boolean> {
  const location = await createdParentLocation(participant, created); return location !== undefined && (!requireFinal || samePath(location, created!.finalPath));
}
async function validateParticipantTarget(participant: OrdinaryTransactionParticipant, requireOriginalTarget: boolean, created?: CreatedParentEvidence | null): Promise<boolean> {
  if (participant.missingParent !== undefined && !await validateCreatedParent(participant, created)) return false;
  if (participant.missingParent === undefined && !await validateEvidence(participant.targetEvidence!, requireOriginalTarget)) return false;
  if (requireOriginalTarget) { const target = await ordinaryFile(participant.targetPath); return participant.targetEvidence?.targetDev === target.dev.toString() && participant.targetEvidence?.targetIno === target.ino.toString(); }
  return true;
}
async function validateFinalMutationTarget(participant: OrdinaryTransactionParticipant, mutation: ExternalMutation, created?: CreatedParentEvidence | null): Promise<void> {
  const restoringDelete = mutation === "rollback" && participant.effect === "delete";
  const requireOriginalTarget = mutation === "replace" && participant.precondition.state === "present";
  if (!await validateParticipantTarget(participant, requireOriginalTarget, created)) throw new Error("target-authority");
  if (mutation === "replace") { if (!await casMatches(participant)) throw new Error("stale-precondition"); }
  else if (await fileDigest(participant.targetPath) !== (restoringDelete ? undefined : participant.stagedDigest)) throw new Error("rollback-target-changed");
}
async function atomicReplace(store: OwnedStateStore, lease: LifecycleLockLease, operationId: string, bindings: readonly JournalLockBinding[], requiredLocks: readonly LifecycleLockIdentity[], codec: TransactionProducerCodec, participant: OrdinaryTransactionParticipant, bytes: Uint8Array, faults: TransactionFaultSeam, index: number, mutation: ExternalMutation, created?: CreatedParentEvidence | null): Promise<void> {
  const generation = participant.targetClass === "generation"; if (generation) { await faults.hit("before-generation-marker", index); await leaseBoundary(store, lease, operationId, bindings, requiredLocks); }
  await faults.hit("before-temp-write", index); const temporaryPath = `${participant.targetPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let temporary: AdjacentTemporaryEvidence | undefined;
  try {
    await validateFinalMutationTarget(participant, mutation, created);
    await authorize(codec, operationId, participant, mutation);
    await leaseBoundary(store, lease, operationId, bindings, requiredLocks);
    const handle = await fs.open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      temporary = await captureTemporary(handle, temporaryPath, sha256(bytes));
      await handle.writeFile(bytes); await faults.hit("after-temp-write", index); await leaseBoundary(store, lease, operationId, bindings, requiredLocks); await handle.sync(); await faults.hit("after-flush", index); await leaseBoundary(store, lease, operationId, bindings, requiredLocks);
    } finally { await handle.close(); }
    await faults.hit("before-replacement", index);
    await renameReplace(temporaryPath, participant.targetPath, async () => {
      if (!await validateTemporary(temporary!) || !await validateParticipantTarget(participant, mutation === "replace" && participant.precondition.state === "present", created)) throw new Error("temporary-identity");
      if (mutation === "replace" && !await casMatches(participant)) throw new Error("stale-precondition");
      if (mutation === "rollback" && await fileDigest(participant.targetPath) !== (participant.effect === "delete" ? undefined : participant.stagedDigest)) throw new Error("rollback-target-changed");
      const authorization = await authorize(codec, operationId, participant, mutation, temporary);
      if (authorization?.temporaryMode === undefined) {
        await leaseBoundary(store, lease, operationId, bindings, requiredLocks);
        return;
      }
      await leaseBoundary(store, lease, operationId, bindings, requiredLocks);
      await fs.chmod(temporaryPath, authorization.temporaryMode);
      if (!await validateTemporary(temporary!) || !await validateParticipantTarget(participant, mutation === "replace" && participant.precondition.state === "present", created)) throw new Error("temporary-identity");
      if (mutation === "replace" && !await casMatches(participant)) throw new Error("stale-precondition");
      if (mutation === "rollback" && await fileDigest(participant.targetPath) !== (participant.effect === "delete" ? undefined : participant.stagedDigest)) throw new Error("rollback-target-changed");
      await authorize(codec, operationId, participant, mutation, temporary);
      await leaseBoundary(store, lease, operationId, bindings, requiredLocks);
    });
    await syncDirectory(path.dirname(participant.targetPath)); await faults.hit("after-replacement", index);
    await leaseBoundary(store, lease, operationId, bindings, requiredLocks);
    if (generation) { await faults.hit("after-generation-marker", index); await leaseBoundary(store, lease, operationId, bindings, requiredLocks); }
  } catch (error) {
    try {
      if (temporary === undefined || !await validateTemporary(temporary) || !await validateParticipantTarget(participant, false, created)) throw new Error("uncertain-temporary");
      await authorize(codec, operationId, participant, mutation, temporary);
      await leaseBoundary(store, lease, operationId, bindings, requiredLocks);
      await fs.rm(temporaryPath);
    } catch { /* Uncertain adjacent residue is inactive and retained. */ }
    throw error;
  }
}
async function validateDeleteEvidence(participant: OrdinaryTransactionParticipant): Promise<boolean> {
  return participant.rollback.kind === "restore-backup" && participant.precondition.state === "present"
    && participant.stagedDigest === participant.precondition.digest && participant.rollback.digest === participant.precondition.digest
    && participant.backupEvidence !== undefined && await validateEvidence(participant.backupEvidence, false) && await validateEvidence(participant.stagedEvidence!, false)
    && await fileDigest(participant.rollback.path) === participant.precondition.digest && await fileDigest(participant.stagedPath) === participant.precondition.digest;
}
function deletionMarkerPath(store: OwnedStateStore, journal: PreparedTransaction, index: number): string {
  const binding = sha256(Buffer.from(`${journal.operationId}\0${journal.planDigest}\0${index}`, "utf8")).slice("sha256:".length);
  return path.join(store.stagingRoot, `delete-${binding}.evidence`);
}
async function deletionMarkerIdentity(store: OwnedStateStore, journal: PreparedTransaction, participant: OrdinaryTransactionParticipant, index: number): Promise<"absent" | "linked-target" | "committed" | "invalid"> {
  const marker = deletionMarkerPath(store, journal, index);
  try {
    if (!isContainedPath(store.stagingRoot, marker) || !samePath(await fs.realpath(path.dirname(marker)), store.stagingRoot)) return "invalid";
    const markerStat = await fs.lstat(marker, { bigint: true });
    const expectedDigest = participant.precondition.state === "present" ? participant.precondition.digest : undefined;
    const markerDigest = sha256(await fs.readFile(marker));
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink < 1n || participant.targetEvidence?.targetDev !== markerStat.dev.toString()
      || participant.targetEvidence.targetIno !== markerStat.ino.toString() || markerDigest !== expectedDigest) return "invalid";
    try {
      const targetStat = await fs.lstat(participant.targetPath, { bigint: true });
      return targetStat.isFile() && !targetStat.isSymbolicLink() && targetStat.dev === markerStat.dev && targetStat.ino === markerStat.ino ? "linked-target" : "committed";
    } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "committed" : "invalid"; }
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "invalid"; }
}
async function retireDeletionMarker(store: OwnedStateStore, journal: PreparedTransaction, participant: OrdinaryTransactionParticipant, index: number, allowCommitted: boolean): Promise<void> {
  const status = await deletionMarkerIdentity(store, journal, participant, index);
  if (status !== "linked-target" && !(allowCommitted && status === "committed")) throw new Error("deletion-evidence-uncertain");
  await fs.unlink(deletionMarkerPath(store, journal, index));
  await syncDirectory(store.stagingRoot);
}
export async function inspectDeletionEvidence(store: OwnedStateStore, transaction: PreparedTransaction): Promise<StoreResult<boolean>> {
  let present = false;
  for (const [index, participant] of transaction.participants.entries()) if (!isOwnedDataRetirement(participant) && participantEffect(participant) === "delete") {
    const status = await deletionMarkerIdentity(store, transaction, participant, index);
    if (status === "invalid") return fail("invalid-deletion-evidence", "Operation-bound deletion evidence is invalid; recovery remains inert");
    if (status !== "absent") present = true;
  }
  return { ok: true, value: present };
}
async function mutationCommitted(store: OwnedStateStore, journal: PreparedTransaction, participant: TransactionParticipant, index: number): Promise<boolean> {
  if (isOwnedDataRetirement(participant)) return committedPostcondition(store, journal, participant, index);
  return participantEffect(participant) === "delete" ? await deletionMarkerIdentity(store, journal, participant, index) === "committed" : await committedPostcondition(store, journal, participant, index);
}
async function preflightForwardParticipant(store: OwnedStateStore, journal: PreparedTransaction, participant: OrdinaryTransactionParticipant, index: number, created?: CreatedParentEvidence | null): Promise<void> {
  if (participantEffect(participant) === "delete") {
    const marker = await deletionMarkerIdentity(store, journal, participant, index);
    if (marker === "invalid") throw new Error("deletion-evidence-invalid");
    if (marker !== "absent") return;
  }
  if (!await validateParticipantTarget(participant, participant.precondition.state === "present", created)) throw new Error("target-authority");
  if (!await casMatches(participant)) throw new Error("stale-precondition");
}
type DeleteFailureReconciliation = "absent" | "committed" | "uncertain";
type RetirementFailureReconciliation = "precommit" | "committed" | "uncertain";
async function reconcileRetirementMutationFailure(store: OwnedStateStore, participant: OwnedDataRetirementParticipant): Promise<RetirementFailureReconciliation> {
  const status = await retirementStatus(store, participant);
  if (status === "source" || status === "absent-noop") return "precommit";
  if (status === "retired") return "committed";
  return "uncertain";
}
async function reconcileDeleteMutationFailure(store: OwnedStateStore, journal: TransactionJournal, participant: OrdinaryTransactionParticipant, index: number): Promise<DeleteFailureReconciliation> {
  const status = await deletionMarkerIdentity(store, journal, participant, index);
  if (status === "absent") return "absent";
  if (status === "committed") return "committed";
  return "uncertain";
}
async function forwardDelete(store: OwnedStateStore, lease: LifecycleLockLease, journal: TransactionJournal, codec: TransactionProducerCodec, participant: OrdinaryTransactionParticipant, faults: TransactionFaultSeam, index: number): Promise<void> {
  await faults.hit("before-forward-deletion", index);
  const marker = deletionMarkerPath(store, journal, index);
  let markerStatus = await deletionMarkerIdentity(store, journal, participant, index);
  if (markerStatus === "invalid") throw new Error("deletion-evidence-invalid");
  if (markerStatus === "committed") {
    if (await fileDigest(participant.targetPath) !== undefined) throw new Error("delete-postcondition-changed");
    await faults.hit("after-forward-deletion", index);
    await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
    return;
  }
  if (markerStatus === "absent") {
    if (!await validateParticipantTarget(participant, true) || !await casMatches(participant)) throw new Error("stale-precondition");
    if (!await validateDeleteEvidence(participant)) throw new Error("changed-staged");
    await authorize(codec, journal.operationId, participant, "delete");
    await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
    if (!await validateParticipantTarget(participant, true) || !await casMatches(participant)) throw new Error("stale-precondition");
    if (!await validateDeleteEvidence(participant)) throw new Error("changed-staged");
    await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
    await fs.link(participant.targetPath, marker);
    await syncDirectory(store.stagingRoot);
    markerStatus = await deletionMarkerIdentity(store, journal, participant, index);
    if (markerStatus !== "linked-target") throw new Error("deletion-evidence-invalid");
    await faults.hit("after-forward-deletion-marker", index);
    await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
  }
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (await deletionMarkerIdentity(store, journal, participant, index) !== "linked-target") throw new Error("deletion-evidence-invalid");
      await authorize(codec, journal.operationId, participant, "delete");
      await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
      if (await deletionMarkerIdentity(store, journal, participant, index) !== "linked-target") throw new Error("deletion-evidence-invalid");
      await fs.unlink(participant.targetPath); break;
    } catch (error) {
      last = error;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt + 1));
    }
  }
  if (await deletionMarkerIdentity(store, journal, participant, index) !== "committed") throw last ?? new Error("delete-failed");
  await faults.hit("after-forward-deletion-mutation", index);
  await syncDirectory(path.dirname(participant.targetPath));
  if (await fileDigest(participant.targetPath) !== undefined) throw new Error("delete-postcondition-changed");
  await faults.hit("after-forward-deletion", index);
  await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
}
async function ensureMissingParent(store: OwnedStateStore, lease: LifecycleLockLease, journal: TransactionJournal, codec: TransactionProducerCodec, index: number, faults: TransactionFaultSeam, onJournal?: (updated: TransactionJournal) => void): Promise<{ readonly journal: TransactionJournal; readonly created?: CreatedParentEvidence }> {
  const participant = journal.participants[index]!; if (isOwnedDataRetirement(participant) || participant.missingParent === undefined) return { journal };
  let updated = journal; let recorded = journal.createdParents[index];
  if (recorded === null) {
    const request = participant.missingParent; const ancestor = await ordinaryDirectory(request.canonicalAncestor);
    if (ancestor.dev.toString() !== request.ancestorDev || ancestor.ino.toString() !== request.ancestorIno || !samePath(await fs.realpath(request.canonicalAncestor), request.canonicalAncestor)) throw new Error("target-authority");
    try { await fs.lstat(request.path); throw new Error("parent-preexisting"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await faults.hit("before-parent-creation", index);
    const temporaryPath = `${request.path}.parent-tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    const before = await ordinaryDirectory(request.canonicalAncestor); if (before.dev.toString() !== request.ancestorDev || before.ino.toString() !== request.ancestorIno || !samePath(await fs.realpath(request.canonicalAncestor), request.canonicalAncestor)) throw new Error("target-authority");
    try { await fs.lstat(temporaryPath); throw new Error("parent-temporary-preexisting"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await authorize(codec, journal.operationId, participant, "create-parent");
    await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
    await fs.mkdir(temporaryPath); const stat = await ordinaryDirectory(temporaryPath); recorded = Object.freeze({ temporaryPath, finalPath: request.path, dev: stat.dev.toString(), ino: stat.ino.toString() });
    await faults.hit("after-parent-creation", index); await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
    await faults.hit("before-parent-identity-journal", index); await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
    const createdParents = [...journal.createdParents]; createdParents[index] = recorded; updated = Object.freeze({ ...journal, createdParents: Object.freeze(createdParents) });
    await persistJournal(store, updated, lease, NO_FAULTS); onJournal?.(updated);
    await faults.hit("after-parent-identity-journal", index); await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
  }
  if (recorded === undefined) throw new Error("target-authority");
  const location = await createdParentLocation(participant, recorded); if (location === undefined) throw new Error("target-authority");
  if (samePath(location, recorded.finalPath)) return { journal: updated, created: recorded };
  await faults.hit("before-parent-publication", index);
  if (!samePath(await createdParentLocation(participant, recorded) ?? "", recorded.temporaryPath)) throw new Error("target-authority");
  try { await fs.lstat(recorded.finalPath); throw new Error("parent-preexisting"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await authorize(codec, journal.operationId, participant, "create-parent");
  await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
  await fs.rename(recorded.temporaryPath, recorded.finalPath); await syncDirectory(path.dirname(recorded.finalPath));
  await faults.hit("after-parent-publication", index); await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
  if (!await validateCreatedParent(participant, recorded)) throw new Error("target-authority");
  return { journal: updated, created: recorded };
}
async function removeCreatedParent(store: OwnedStateStore, lease: LifecycleLockLease, journal: TransactionJournal, codec: TransactionProducerCodec, index: number, faults: TransactionFaultSeam): Promise<void> {
  const participant = journal.participants[index]!; const created = journal.createdParents[index]; if (isOwnedDataRetirement(participant) || participant.missingParent === undefined || created === null || created === undefined) return;
  let location = await createdParentLocation(participant, created); if (location === undefined) return;
  await faults.hit("before-parent-removal", index);
  try {
    if (!samePath(await createdParentLocation(participant, created) ?? "", location)) throw new Error("target-authority");
    await authorize(codec, journal.operationId, participant, "remove-parent");
    await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
    await fs.rmdir(location); await syncDirectory(path.dirname(location));
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await faults.hit("after-parent-removal", index); await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
}
async function casMatches(participant: OrdinaryTransactionParticipant): Promise<boolean> { const digest = await fileDigest(participant.targetPath); return participant.precondition.state === "absent" ? digest === undefined : digest === participant.precondition.digest; }
async function committedPostcondition(store: OwnedStateStore, transaction: PreparedTransaction, participant: TransactionParticipant, index: number): Promise<boolean> {
  if (isOwnedDataRetirement(participant)) { const status = await retirementStatus(store, participant); return status === "absent-noop" || status === "retired"; }
  return participantEffect(participant) === "delete" ? await fileDigest(participant.targetPath) === undefined : await fileDigest(participant.targetPath) === participant.stagedDigest;
}
async function forwardDataRetirement(store: OwnedStateStore, lease: LifecycleLockLease, journal: TransactionJournal, codec: TransactionProducerCodec, participant: OwnedDataRetirementParticipant, index: number, faults: TransactionFaultSeam): Promise<void> {
  let status = await retirementStatus(store, participant);
  if (status === "absent-noop" || status === "retired") return;
  if (status !== "source") throw new Error("data-retirement-authority");
  await authorizeRetirement(codec, journal, participant, index, "retire"); await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
  if (await retirementStatus(store, participant) !== "source") throw new Error("data-retirement-authority");
  await faults.hit("before-data-retirement-rename", index); await authorizeRetirement(codec, journal, participant, index, "retire"); await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
  if (await retirementStatus(store, participant) !== "source") throw new Error("data-retirement-authority");
  await fs.rename(participant.dataPath, participant.destinationPath);
  await faults.hit("after-data-retirement-rename", index);
  await syncDirectory(ownedDataRoot(store)); await syncDirectory(store.quarantineRoot);
  await faults.hit("after-data-retirement-sync", index); await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
  if (await retirementStatus(store, participant) !== "retired") throw new Error("data-retirement-postcondition");
}
export function completedGenerationId(transaction: PreparedTransaction, completed: number): string | undefined {
  if (completed !== transaction.participants.length) return undefined; const last = transaction.participants.at(-1); return last !== undefined && !isOwnedDataRetirement(last) && last.targetClass === "generation" ? last.generationId : undefined;
}
function receiptFrom(journal: TransactionJournal, outcome: TransactionReceipt["outcome"], failureCategory?: PrecommitFailureCategory): TransactionReceipt {
  const terminalCompleted = outcome === "committed" ? journal.participants.length : 0; const generationId = outcome === "committed" ? completedGenerationId(journal, journal.participants.length) : undefined;
  return Object.freeze({ format: "picc-transaction-receipt", formatVersion: 1, operationId: journal.operationId, producerSchema: journal.producerSchema, producerVersion: journal.producerVersion,
    confirmationSummary: journal.confirmationSummary, confirmationDigest: journal.confirmationDigest, participants: journal.participants, requiredLocks: journal.requiredLocks, planDigest: journal.planDigest,
    lockBindings: journal.lockBindings, outcome, completed: terminalCompleted, createdParents: journal.createdParents, ...(failureCategory === undefined ? {} : { failureCategory }), ...(generationId === undefined ? {} : { generationId }) });
}

const JOURNAL_KEYS = ["completed", "confirmationDigest", "confirmationSummary", "createdParents", "format", "formatVersion", "lockBindings", "operationId", "participants", "planDigest", "producerSchema", "producerVersion", "requiredLocks", "rolledBack", "state"];
function validBindings(raw: unknown): raw is readonly JournalLockBinding[] {
  return Array.isArray(raw) && raw.length > 0 && raw.length <= 128 && raw.every((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry)
    && exactKeys(entry as Record<string, unknown>, ["generation", "key", "kind", "nonce"])
    && ((entry as JournalLockBinding).kind === "profile" || (entry as JournalLockBinding).kind === "checkout" || (entry as JournalLockBinding).kind === "settings")
    && typeof (entry as JournalLockBinding).key === "string" && (entry as JournalLockBinding).key.length > 0 && (entry as JournalLockBinding).key.length <= 256
    && /^[a-f0-9]{32}$/.test((entry as JournalLockBinding).nonce) && /^[a-f0-9]{32}$/.test((entry as JournalLockBinding).generation));
}
function validBindingRelationships(store: OwnedStateStore, bindings: readonly JournalLockBinding[]): boolean {
  if (bindings[0]?.kind !== "profile" || bindings[0].key !== store.profileKey) return false;
  const rank = (kind: JournalLockBinding["kind"]) => kind === "profile" ? 0 : kind === "checkout" ? 1 : 2;
  return new Set(bindings.map((item) => `${item.kind}\0${item.key}`)).size === bindings.length
    && bindings.every((item, index) => index === 0 || rank(bindings[index - 1]!.kind) < rank(item.kind)
      || (rank(bindings[index - 1]!.kind) === rank(item.kind) && Buffer.compare(Buffer.from(bindings[index - 1]!.key, "utf8"), Buffer.from(item.key, "utf8")) < 0));
}
function validLockBindingIdentityRelationship(store: OwnedStateStore, locks: unknown, bindings: unknown): boolean {
  return validRequiredLocks(store, locks) && validBindings(bindings) && lockIdentitiesEqual(locks, bindings);
}
function parsePreparedBase(parsed: Record<string, unknown>, operationId: string): StoreResult<PreparedTransaction> {
  if (parsed.operationId !== operationId || !validCodecIdentity(parsed.producerSchema, parsed.producerVersion)
    || typeof parsed.confirmationDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(parsed.confirmationDigest)
    || typeof parsed.planDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(parsed.planDigest)
    || !Array.isArray(parsed.participants) || parsed.participants.length === 0 || parsed.participants.length > 1024 || !parsed.participants.every(validParticipantShape)) return fail("invalid-data", "Persisted transaction fields are invalid");
  const participants = parsed.participants as TransactionParticipant[]; const generation = validateGenerationRelationship(participants); if (!generation.ok) return generation;
  const summary = canonicalJsonBytes(parsed.confirmationSummary); const plan = canonicalJsonBytes({ participants: participants.map(participantForDigest), requiredLocks: parsed.requiredLocks });
  if (!summary.ok || !plan.ok || sha256(summary.value) !== parsed.confirmationDigest || sha256(plan.value) !== parsed.planDigest) return fail("digest-mismatch", "Persisted transaction digest relationship is invalid");
  return { ok: true, value: parsed as unknown as PreparedTransaction };
}
const PASSIVE_ARTIFACT_LIMIT = 1024 * 1024;
async function readOpenedOrdinaryFile(candidate: string, limit: number): Promise<Buffer> {
  const resolved = path.resolve(candidate); const handle = await fs.open(resolved, constants.O_RDONLY);
  try {
    const stat = await handle.stat({ bigint: true }); const pathname = await fs.lstat(resolved, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !pathname.isFile() || pathname.isSymbolicLink() || stat.dev !== pathname.dev || stat.ino !== pathname.ino || !samePath(await fs.realpath(resolved), resolved)) throw new Error("ordinary");
    const bytes = Buffer.allocUnsafe(limit + 1); let total = 0;
    while (total <= limit) { const read = await handle.read(bytes, total, limit + 1 - total, null); if (read.bytesRead === 0) break; total += read.bytesRead; }
    const after = await fs.lstat(resolved, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || !after.isFile() || after.isSymbolicLink() || !samePath(await fs.realpath(resolved), resolved) || total > limit) throw new Error("changed-or-over-limit");
    return bytes.subarray(0, total);
  } finally { await handle.close(); }
}
function readOpenedOrdinaryFileSync(candidate: string, limit: number): Buffer {
  const resolved = path.resolve(candidate); const descriptor = fsSync.openSync(resolved, constants.O_RDONLY);
  try {
    const stat = fsSync.fstatSync(descriptor, { bigint: true }); const pathname = fsSync.lstatSync(resolved, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !pathname.isFile() || pathname.isSymbolicLink() || stat.dev !== pathname.dev || stat.ino !== pathname.ino || !samePath(fsSync.realpathSync.native(resolved), resolved)) throw new Error("ordinary");
    const bytes = Buffer.allocUnsafe(limit + 1); let total = 0;
    while (total <= limit) { const count = fsSync.readSync(descriptor, bytes, total, limit + 1 - total, null); if (count === 0) break; total += count; }
    const after = fsSync.lstatSync(resolved, { bigint: true });
    if (after.dev !== stat.dev || after.ino !== stat.ino || !after.isFile() || after.isSymbolicLink() || !samePath(fsSync.realpathSync.native(resolved), resolved) || total > limit) throw new Error("changed-or-over-limit");
    return bytes.subarray(0, total);
  } finally { fsSync.closeSync(descriptor); }
}
async function readCanonicalObject(candidate: string): Promise<StoreResult<Record<string, unknown> | undefined>> {
  try { const bytes = await readOpenedOrdinaryFile(candidate, PASSIVE_ARTIFACT_LIMIT); const parsed = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape"); const canonical = canonicalJsonBytes(parsed); if (!canonical.ok || !Buffer.from(canonical.value).equals(bytes)) throw new Error("canonical"); return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { ok: true, value: undefined } : fail("invalid-data", "Persisted transaction artifact is invalid"); }
}

function readCanonicalObjectSync(candidate: string): StoreResult<Record<string, unknown> | undefined> {
  try {
    const bytes = readOpenedOrdinaryFileSync(candidate, PASSIVE_ARTIFACT_LIMIT); const parsed = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fail("invalid-data", "Persisted transaction artifact is invalid");
    const canonical = canonicalJsonBytes(parsed); return canonical.ok && Buffer.from(canonical.value).equals(bytes) ? { ok: true, value: parsed as Record<string, unknown> } : fail("invalid-data", "Persisted transaction artifact is invalid");
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { ok: true, value: undefined } : fail("invalid-data", "Persisted transaction artifact is invalid"); }
}
function validCreatedParents(raw: unknown, participants: readonly TransactionParticipant[]): raw is readonly (CreatedParentEvidence | null)[] {
  return Array.isArray(raw) && raw.length === participants.length && raw.every((item, index) => {
    const participant = participants[index];
    return item === null || participant !== undefined && !isOwnedDataRetirement(participant) && validCreatedParent(item) && participant.missingParent !== undefined && samePath(item.finalPath, participant.missingParent.path);
  });
}
function decodeReceiptStructure(store: OwnedStateStore, operationId: string, parsed: Record<string, unknown>): StoreResult<TransactionReceipt> {
  const optional = ["failureCategory", "generationId"].filter((key) => key in parsed); const expected = ["completed", "confirmationDigest", "confirmationSummary", "createdParents", "format", "formatVersion", "lockBindings", "operationId", "outcome", "participants", "planDigest", "producerSchema", "producerVersion", "requiredLocks", ...optional];
  const base = parsePreparedBase(parsed, operationId);
  if (!exactKeys(parsed, expected) || !base.ok || !validCreatedParents(parsed.createdParents, base.value.participants) || !validLockBindingIdentityRelationship(store, parsed.requiredLocks, parsed.lockBindings) || parsed.format !== "picc-transaction-receipt" || parsed.formatVersion !== 1 || !validBindings(parsed.lockBindings) || !validBindingRelationships(store, parsed.lockBindings) || (parsed.outcome !== "committed" && parsed.outcome !== "rolled-back" && parsed.outcome !== "failed-before-commit") || !Number.isSafeInteger(parsed.completed)) return fail("invalid-receipt", "Stored transaction receipt is invalid");
  const complete = parsed.outcome === "committed"; const generation = completedGenerationId(base.value, base.value.participants.length);
  if ((complete ? parsed.completed !== base.value.participants.length : parsed.completed !== 0) || (parsed.outcome === "failed-before-commit" ? !(["cancelled", "stale-precondition", "changed-staged", "storage-failure"] as unknown[]).includes(parsed.failureCategory) : "failureCategory" in parsed) || (complete ? (generation === undefined ? "generationId" in parsed : parsed.generationId !== generation) : "generationId" in parsed)) return fail("invalid-receipt", "Receipt outcome/completion/generation relationship is invalid");
  return { ok: true, value: parsed as unknown as TransactionReceipt };
}
function decodeJournalStructure(store: OwnedStateStore, operationId: string, parsed: Record<string, unknown>): StoreResult<TransactionJournal> {
  const base = parsePreparedBase(parsed, operationId);
  if (!exactKeys(parsed, JOURNAL_KEYS) || !base.ok || !validCreatedParents(parsed.createdParents, base.value.participants) || !validLockBindingIdentityRelationship(store, parsed.requiredLocks, parsed.lockBindings) || parsed.format !== "picc-transaction-journal" || parsed.formatVersion !== 1 || !validBindings(parsed.lockBindings) || !validBindingRelationships(store, parsed.lockBindings) || !Number.isSafeInteger(parsed.completed) || !Number.isSafeInteger(parsed.rolledBack) || typeof parsed.completed !== "number" || typeof parsed.rolledBack !== "number" || parsed.completed < 0 || parsed.completed > base.value.participants.length || parsed.rolledBack < 0 || parsed.rolledBack > parsed.completed || (parsed.state !== "prepared" && parsed.state !== "pending" && parsed.state !== "rolling-back") || (parsed.state === "prepared" && (parsed.completed !== 0 || parsed.rolledBack !== 0)) || (parsed.state !== "rolling-back" && parsed.rolledBack !== 0)) return fail("invalid-journal", "Stored transaction journal relationships are invalid");
  return { ok: true, value: parsed as unknown as TransactionJournal };
}
export interface PassiveTransactionObservation {
  readonly receipts: readonly { readonly path: string; readonly status: "present" | "invalid"; readonly receipt?: TransactionReceipt }[];
  readonly journals: readonly { readonly operationId: string; readonly status: "pending" | "terminal-residue" | "invalid"; readonly journal?: TransactionJournal }[];
}
export function observePersistedTransactionsSync(store: OwnedStateStore): PassiveTransactionObservation {
  const list = (root: string): { names: string[]; invalid: boolean; overflow: boolean } => { try { const rootStat = fsSync.lstatSync(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !samePath(fsSync.realpathSync.native(root), path.resolve(root))) return { names: [], invalid: true, overflow: false }; const names: string[] = []; let overflow = false; const directory = fsSync.opendirSync(root); try { for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) { if (names.length === 1024) { overflow = true; break; } names.push(entry.name); } } finally { directory.closeSync(); } return { names: names.sort(), invalid: false, overflow }; } catch (error) { return { names: [], invalid: (error as NodeJS.ErrnoException).code !== "ENOENT", overflow: false }; } };
  const receiptListing = list(store.receiptsRoot); const receiptNames = receiptListing.names; const receipts = receiptNames.map((name) => { const candidate = path.join(store.receiptsRoot, name); const match = /^([A-Za-z0-9_-]{1,128})\.json$/.exec(name); const raw = match ? readCanonicalObjectSync(candidate) : fail("invalid-data", "Invalid receipt filename"); const decoded = raw.ok && raw.value !== undefined && match ? decodeReceiptStructure(store, match[1]!, raw.value) : fail("invalid-receipt", "Stored transaction receipt is invalid"); return Object.freeze({ path: candidate, status: decoded.ok ? "present" as const : "invalid" as const, ...(decoded.ok ? { receipt: decoded.value } : {}) }); });
  const validReceipts = new Map(receipts.flatMap((item) => item.status === "present" && item.receipt ? [[item.receipt.operationId, item.receipt] as const] : []));
  const sameTerminalAuthority = (journal: TransactionJournal, receipt: TransactionReceipt): boolean => receipt.operationId === journal.operationId && receipt.producerSchema === journal.producerSchema && receipt.producerVersion === journal.producerVersion && receipt.planDigest === journal.planDigest && receipt.confirmationDigest === journal.confirmationDigest && JSON.stringify(receipt.participants) === JSON.stringify(journal.participants) && JSON.stringify(receipt.requiredLocks) === JSON.stringify(journal.requiredLocks) && JSON.stringify(receipt.lockBindings) === JSON.stringify(journal.lockBindings);
  const journalListing = list(store.journalsRoot); const journalNames = journalListing.names; const journals = journalNames.map((name, index) => { const match = /^([A-Za-z0-9_-]{1,128})\.json$/.exec(name); const operationId = match?.[1] ?? `invalid-entry-${index}`; const raw = match ? readCanonicalObjectSync(path.join(store.journalsRoot, name)) : fail("invalid-data", "Invalid journal filename"); const decoded = raw.ok && raw.value !== undefined && match ? decodeJournalStructure(store, operationId, raw.value) : fail("invalid-journal", "Stored transaction journal is invalid"); const receipt = validReceipts.get(operationId); const status = !decoded.ok ? "invalid" as const : receipt === undefined ? "pending" as const : sameTerminalAuthority(decoded.value, receipt) ? "terminal-residue" as const : "invalid" as const; return Object.freeze({ operationId, status, ...(decoded.ok ? { journal: decoded.value } : {}) }); });
  if (receiptListing.invalid || receiptListing.overflow) receipts.push({ path: receiptListing.invalid ? store.receiptsRoot : path.join(store.receiptsRoot, "<overflow>"), status: "invalid" });
  if (journalListing.invalid || journalListing.overflow) journals.push({ operationId: journalListing.invalid ? "invalid-root" : "overflow", status: "invalid" });
  return Object.freeze({ receipts: Object.freeze(receipts), journals: Object.freeze(journals) });
}

export async function readTransactionReceipt(store: OwnedStateStore, operationId: string): Promise<StoreResult<TransactionReceipt | undefined>> {
  const raw = await readCanonicalObject(receiptPath(store, operationId)); if (!raw.ok || raw.value === undefined) return raw as StoreResult<TransactionReceipt | undefined>;
  return decodeReceiptStructure(store, operationId, raw.value);
}

export async function readTransactionJournal(store: OwnedStateStore, operationId: string): Promise<StoreResult<TransactionJournal>> {
  const raw = await readCanonicalObject(journalPath(store, operationId)); if (!raw.ok || raw.value === undefined) return fail("invalid-journal", "Stored transaction journal is missing or invalid");
  const structural = decodeJournalStructure(store, operationId, raw.value); if (!structural.ok) return structural; const parsed = structural.value;
  let completed = parsed.completed; let rolledBack = parsed.rolledBack;
  if (parsed.state === "rolling-back") { while (rolledBack < completed) { const index = completed - rolledBack - 1; const p = parsed.participants[index]!; if (isOwnedDataRetirement(p)) { const status = await retirementStatus(store, p); if (status !== "source" && status !== "absent-noop") break; rolledBack += 1; continue; } const expectedDigest = p.rollback.kind === "delete-new-target" ? undefined : p.rollback.digest; if (await fileDigest(p.targetPath) !== expectedDigest) break; if (participantEffect(p) === "delete" && await deletionMarkerIdentity(store, parsed, p, index) !== "absent") break; const created = parsed.createdParents[index]; if (created !== null && await createdParentLocation(p, created) !== undefined) break; rolledBack += 1; } }
  else { while (completed < parsed.participants.length) { const p = parsed.participants[completed]!; if (!isOwnedDataRetirement(p) && participantEffect(p) === "delete" ? !(await mutationCommitted(store, parsed, p, completed) && await committedPostcondition(store, parsed, p, completed)) : !await committedPostcondition(store, parsed, p, completed)) break; completed += 1; } }
  return { ok: true, value: Object.freeze({ ...parsed, completed, rolledBack, state: parsed.state === "rolling-back" ? "rolling-back" : completed > 0 ? "pending" : parsed.state }) };
}

export async function listPendingJournals(store: OwnedStateStore): Promise<StoreResult<readonly string[]>> {
  try { const names = (await fs.readdir(store.journalsRoot)).filter((name) => /^[A-Za-z0-9_-]{1,128}\.json$/.test(name)); const pending: string[] = [];
    for (const name of names) { const id = name.slice(0, -5); const receipt = await readTransactionReceipt(store, id); if (!receipt.ok || receipt.value === undefined) pending.push(id); }
    return { ok: true, value: Object.freeze(pending.sort()) };
  } catch { return fail("journal-read", "Pending transaction journals could not be inspected"); }
}
async function retireTerminalDeletionMarkers(store: OwnedStateStore, journal: TransactionJournal, lease: LifecycleLockLease): Promise<void> {
  for (const [index, participant] of journal.participants.entries()) {
    if (isOwnedDataRetirement(participant) || participantEffect(participant) !== "delete") continue;
    await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
    const status = await deletionMarkerIdentity(store, journal, participant, index);
    if (status === "committed") await retireDeletionMarker(store, journal, participant, index, true);
    else if (status !== "absent") throw new Error("deletion-evidence-uncertain");
  }
}
async function retireJournal(store: OwnedStateStore, journal: TransactionJournal, lease: LifecycleLockLease, faults: TransactionFaultSeam): Promise<void> {
  await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks); await faults.hit("before-retirement");
  await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
  const retired = path.join(store.quarantineRoot, `retired-journal-${journal.operationId}-${randomBytes(8).toString("hex")}`);
  await fs.rename(journalPath(store, journal.operationId), retired); await syncDirectory(store.journalsRoot); await faults.hit("after-retirement");
  await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
  await fs.rm(retired, { force: true }).catch(() => undefined);
}
function classify(error: unknown, signal?: AbortSignal): PrecommitFailureCategory { const message = error instanceof Error ? error.message : ""; return signal?.aborted === true || message === "cancelled" ? "cancelled" : message.includes("stale-precondition") ? "stale-precondition" : message.includes("changed-staged") ? "changed-staged" : "storage-failure"; }
async function revalidatePreparedAuthority(store: OwnedStateStore, prepared: PreparedTransaction, codec: TransactionProducerCodec): Promise<void> {
  if (codec.schema !== prepared.producerSchema || codec.version !== prepared.producerVersion || !validRequiredLocks(store, prepared.requiredLocks)
    || !codec.decodeSummary(prepared.confirmationSummary).ok || !prepared.participants.every(validParticipantShape)
    || !validateGenerationRelationship(prepared.participants).ok || !codec.validatePlan(prepared.participants).ok) throw new Error("prepared-authority");
  const derived = codec.requiredLocks(prepared.confirmationSummary, prepared.participants);
  const summary = canonicalJsonBytes(prepared.confirmationSummary);
  const plan = canonicalJsonBytes({ participants: prepared.participants.map(participantForDigest), requiredLocks: prepared.requiredLocks });
  if (!derived.ok || !lockIdentitiesEqual(derived.value, prepared.requiredLocks) || !summary.ok || !plan.ok
    || sha256(summary.value) !== prepared.confirmationDigest || sha256(plan.value) !== prepared.planDigest) throw new Error("prepared-authority");
}
function outcomeFromReceipt(receipt: TransactionReceipt): TransactionOutcome { return receipt.outcome === "committed" ? { state: "committed", receipt } : receipt.outcome === "rolled-back" ? { state: "rolled-back", receipt } : { state: "failed-before-commit", receipt }; }

export async function executeTransaction(store: OwnedStateStore, prepared: PreparedTransaction, options: { readonly lease?: LifecycleLockLease; readonly faults?: TransactionFaultSeam; readonly signal?: AbortSignal; readonly onOutcome?: (outcome: TransactionOutcome) => void | Promise<void>; readonly fallbackOutput?: (operationId: string) => void | Promise<void> } = {}): Promise<TransactionOutcome> {
  const capability = preparedCapabilities.get(prepared); const lease = options.lease;
  if (capability === undefined || capability.store !== store || lease === undefined) return { state: "rejected", operationId: prepared.operationId, cause: "Trusted preparation and a live store/operation-bound lease are required" };
  const initialLease = await validateLifecycleLockLease(store, lease, prepared.operationId, undefined, prepared.requiredLocks); if (!initialLease.ok) return { state: "rejected", operationId: prepared.operationId, cause: initialLease.message };
  const existing = await readTransactionReceipt(store, prepared.operationId); if (!existing.ok) return { state: "rejected", operationId: prepared.operationId, cause: existing.message };
  if (existing.value !== undefined) return existing.value.producerSchema === prepared.producerSchema && existing.value.producerVersion === prepared.producerVersion
    && existing.value.planDigest === prepared.planDigest && existing.value.confirmationDigest === prepared.confirmationDigest ? outcomeFromReceipt(existing.value) : { state: "rejected", operationId: prepared.operationId, cause: "Operation id is bound to a different producer or receipt" };
  const existingJournalBytes = await fs.readFile(journalPath(store, prepared.operationId)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existingJournalBytes !== undefined) return { state: "pending-recovery", operationId: prepared.operationId, completed: (await readTransactionJournal(store, prepared.operationId)).ok ? (await readTransactionJournal(store, prepared.operationId) as { ok: true; value: TransactionJournal }).value.completed : 0, cause: "This operation id already has pending state and requires explicit recovery" };
  const pending = await listPendingJournals(store); if (!pending.ok || pending.value.length > 0) return { state: "pending-recovery", operationId: prepared.operationId, completed: 0, cause: pending.ok ? `Pending operation ${pending.value[0]} requires explicit recovery` : pending.message };
  // Preparation captured immutable data and callback references, but publication still reruns the
  // producer and digest bindings. Filesystem CAS/staging checks follow the journal so failures are durable.
  let journal: TransactionJournal = Object.freeze({ ...prepared, format: "picc-transaction-journal", formatVersion: 1, lockBindings: lease.bindings, completed: 0, rolledBack: 0, createdParents: Object.freeze(prepared.participants.map(() => null)), state: "prepared" }); const faults = options.faults ?? NO_FAULTS;
  let mutationFailurePending = false;
  try {
    await persistJournal(store, journal, lease, faults, true, undefined, () => revalidatePreparedAuthority(store, prepared, capability.codec));
    for (let index = 0; index < journal.participants.length; index += 1) {
      if (options.signal?.aborted === true) throw new Error("cancelled"); const participant = journal.participants[index]!;
      const parent = await ensureMissingParent(store, lease, journal, capability.codec, index, faults, (updated) => { journal = updated; }); journal = parent.journal;
      await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
      let payload: Uint8Array | undefined;
      if (!isOwnedDataRetirement(participant)) { await preflightForwardParticipant(store, journal, participant, index, parent.created); payload = await fs.readFile(participant.stagedPath); if (sha256(payload) !== participant.stagedDigest || !await validateEvidence(participant.stagedEvidence!, false)) throw new Error("changed-staged"); }
      try { if (isOwnedDataRetirement(participant)) await forwardDataRetirement(store, lease, journal, capability.codec, participant, index, faults); else if (participantEffect(participant) === "delete") await forwardDelete(store, lease, journal, capability.codec, participant, faults, index); else await atomicReplace(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks, capability.codec, participant, payload!, faults, index, "replace", parent.created); }
      catch (error) {
        if (!isOwnedDataRetirement(participant) && participantEffect(participant) === "delete") {
          const reconciliation = await reconcileDeleteMutationFailure(store, journal, participant, index);
          mutationFailurePending = reconciliation === "committed" || reconciliation === "uncertain";
          if (reconciliation === "committed") { journal = Object.freeze({ ...journal, completed: index + 1, state: "pending" }); await persistJournal(store, journal, lease, NO_FAULTS, false, index).catch(() => undefined); }
        } else if (isOwnedDataRetirement(participant)) {
          const reconciliation = await reconcileRetirementMutationFailure(store, participant);
          mutationFailurePending = reconciliation === "committed" || reconciliation === "uncertain";
          if (reconciliation === "committed") { journal = Object.freeze({ ...journal, completed: index + 1, state: "pending" }); await persistJournal(store, journal, lease, NO_FAULTS, false, index).catch(() => undefined); }
        } else if (await mutationCommitted(store, journal, participant, index)) { journal = Object.freeze({ ...journal, completed: index + 1, state: "pending" }); await persistJournal(store, journal, lease, NO_FAULTS, false, index).catch(() => undefined); }
        throw error;
      }
      journal = Object.freeze({ ...journal, completed: index + 1, state: "pending" }); await persistJournal(store, journal, lease, faults, false, index);
    }
    const receipt = receiptFrom(journal, "committed");
    try { await persistReceipt(store, receipt, lease, faults); } catch (error) { const reread = await readTransactionReceipt(store, journal.operationId); if (reread.ok && reread.value !== undefined) { await retireJournal(store, journal, lease, NO_FAULTS).catch(() => undefined); return await deliver(outcomeFromReceipt(reread.value), options); } throw error; }
    await retireTerminalDeletionMarkers(store, journal, lease).catch(() => undefined);
    await retireJournal(store, journal, lease, faults).catch(() => undefined); return await deliver({ state: "committed", receipt }, options);
  } catch (error) {
    const stored = await readTransactionReceipt(store, journal.operationId); if (stored.ok && stored.value !== undefined) return deliver(outcomeFromReceipt(stored.value), options);
    if (journal.completed > 0) return deliver({ state: "pending-recovery", operationId: journal.operationId, completed: journal.completed, cause: "Transaction interrupted after a committed safe prefix" }, options);
    if (mutationFailurePending) return deliver({ state: "pending-recovery", operationId: journal.operationId, completed: journal.completed, cause: "Filesystem mutation evidence requires explicit recovery" }, options);
    for (let index = 0; index < journal.participants.length; index += 1) if (journal.createdParents[index] !== null) await removeCreatedParent(store, lease, journal, capability.codec, index, NO_FAULTS).catch(() => undefined);
    const receipt = receiptFrom(journal, "failed-before-commit", classify(error, options.signal));
    try { await persistReceipt(store, receipt, lease, NO_FAULTS); await retireJournal(store, journal, lease, NO_FAULTS).catch(() => undefined); const reread = await readTransactionReceipt(store, journal.operationId); if (reread.ok && reread.value !== undefined) return deliver(outcomeFromReceipt(reread.value), options); }
    catch { const reread = await readTransactionReceipt(store, journal.operationId); if (reread.ok && reread.value !== undefined) return deliver(outcomeFromReceipt(reread.value), options); }
    return deliver({ state: "pending-recovery", operationId: journal.operationId, completed: 0, cause: "Pre-commit failure could not publish a durable terminal receipt" }, options);
  }
}
async function deliver(outcome: TransactionOutcome, options: { readonly onOutcome?: (outcome: TransactionOutcome) => void | Promise<void>; readonly fallbackOutput?: (operationId: string) => void | Promise<void> }): Promise<TransactionOutcome> {
  try { await options.onOutcome?.(outcome); } catch { try { await options.fallbackOutput?.("receipt" in outcome ? outcome.receipt.operationId : outcome.operationId); } catch { /* Stored truth is unaffected by rendering. */ } } return outcome;
}

export async function persistReconciledJournal(store: OwnedStateStore, journal: TransactionJournal, lease: LifecycleLockLease): Promise<StoreResult<TransactionJournal>> {
  const sameBindings = journal.lockBindings.length === lease.bindings.length && journal.lockBindings.every((item, index) => {
    const current = lease.bindings[index]; return current !== undefined && item.kind === current.kind && item.key === current.key && item.nonce === current.nonce && item.generation === current.generation;
  });
  try {
    await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks);
    if (!lockIdentitiesEqual(lease.identities, journal.requiredLocks)) return fail("journal-write", "Recovery lease identities differ from the persisted plan");
    if (sameBindings) return { ok: true, value: journal };
    const rebound = deepFreeze({ ...journal, lockBindings: lease.bindings }); await persistJournal(store, rebound, lease, NO_FAULTS); return { ok: true, value: rebound };
  } catch { return fail("journal-write", "Recovery lease could not rebind the reconciled journal"); }
}
export async function completeJournal(store: OwnedStateStore, journal: TransactionJournal, codec: TransactionProducerCodec, lease: LifecycleLockLease, faults: TransactionFaultSeam = NO_FAULTS): Promise<StoreResult<TransactionReceipt>> {
  let current = journal;
  try {
    for (let index = 0; index < current.completed; index += 1) { const participant = current.participants[index]!; if (!await committedPostcondition(store, current, participant, index) || (!isOwnedDataRetirement(participant) && participantEffect(participant) === "delete" && !await mutationCommitted(store, current, participant, index))) throw new Error("prefix changed"); }
    for (let index = current.completed; index < current.participants.length; index += 1) { const participant = current.participants[index]!; const parent = await ensureMissingParent(store, lease, current, codec, index, faults, (updated) => { current = updated; }); current = parent.journal; await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks); let payload: Uint8Array | undefined; if (!isOwnedDataRetirement(participant)) { await preflightForwardParticipant(store, current, participant, index, parent.created); payload = await fs.readFile(participant.stagedPath); if (sha256(payload) !== participant.stagedDigest) throw new Error("staged"); }
      try { if (isOwnedDataRetirement(participant)) await forwardDataRetirement(store, lease, current, codec, participant, index, faults); else if (participantEffect(participant) === "delete") await forwardDelete(store, lease, current, codec, participant, faults, index); else await atomicReplace(store, lease, current.operationId, current.lockBindings, current.requiredLocks, codec, participant, payload!, faults, index, "replace", parent.created); } catch (error) { if (await mutationCommitted(store, current, participant, index)) { current = Object.freeze({ ...current, completed: index + 1, state: "pending" }); await persistJournal(store, current, lease, NO_FAULTS, false, index).catch(() => undefined); } throw error; }
      current = Object.freeze({ ...current, completed: index + 1, state: "pending" }); await persistJournal(store, current, lease, faults, false, index); }
    const receipt = receiptFrom(current, "committed"); await persistReceipt(store, receipt, lease, faults); await retireTerminalDeletionMarkers(store, current, lease).catch(() => undefined); await retireJournal(store, current, lease, faults).catch(() => undefined); return { ok: true, value: receipt };
  } catch { const receipt = await readTransactionReceipt(store, current.operationId); return receipt.ok && receipt.value !== undefined ? { ok: true, value: receipt.value } : fail("recovery-interrupted", "Explicit completion remains pending"); }
}
export interface OwnedDataRetirementCleanupResult { readonly removed: boolean; readonly retained: boolean }
async function removeEmptyRetiredDirectory(store: OwnedStateStore, participant: OwnedDataRetirementParticipant, faults: TransactionFaultSeam, index: number): Promise<void> {
  if (await retirementStatus(store, participant) !== "retired") throw new Error("cleanup-identity-changed");
  await faults.hit("before-data-cleanup-entry", index);
  if (await retirementStatus(store, participant) !== "retired") throw new Error("cleanup-identity-changed");
  await fs.rmdir(participant.destinationPath);
  await faults.hit("after-data-cleanup-entry", index);
}
export async function cleanupCommittedOwnedDataRetirement(inputs: { readonly store: OwnedStateStore; readonly operationId: string; readonly registry: TransactionCodecRegistry; readonly faults?: TransactionFaultSeam }): Promise<StoreResult<OwnedDataRetirementCleanupResult>> {
  const storeValid = await revalidateOwnedStateStore(inputs.store); if (!storeValid.ok) return storeValid;
  const receipt = await readTransactionReceipt(inputs.store, inputs.operationId); if (!receipt.ok || receipt.value === undefined || receipt.value.outcome !== "committed") return fail("cleanup-ineligible", "Only an exact committed retirement receipt authorizes physical cleanup");
  const codec = inputs.registry.lookup(receipt.value.producerSchema, receipt.value.producerVersion); if (codec === undefined) return fail("unknown-producer", "Retirement cleanup producer is unavailable");
  const valid = await revalidatePersistedTransaction(inputs.store, receipt.value, codec); if (!valid.ok) return valid;
  const faults = inputs.faults ?? NO_FAULTS; let removed = false; let retained = false;
  for (const [index, participant] of receipt.value.participants.entries()) {
    if (!isOwnedDataRetirement(participant) || participant.state === "absent") continue;
    const status = await retirementStatus(inputs.store, participant);
    if (status === "invalid" || status === "source") { retained = true; continue; }
    if (status === "absent-noop" || status === "cleaned") { removed = true; continue; }
    try { await removeEmptyRetiredDirectory(inputs.store, participant, faults, index); await syncDirectory(inputs.store.quarantineRoot); removed = true; }
    catch { if (await retirementStatus(inputs.store, participant) === "cleaned") removed = true; else retained = true; }
  }
  return { ok: true, value: Object.freeze({ removed, retained }) };
}

export async function rollbackJournal(store: OwnedStateStore, journal: TransactionJournal, codec: TransactionProducerCodec, lease: LifecycleLockLease, faults: TransactionFaultSeam = NO_FAULTS): Promise<StoreResult<TransactionReceipt>> {
  let current = Object.freeze({ ...journal, state: "rolling-back" as const });
  try {
    // Publish rollback intent before exposing operation faults so every interrupted rollback is
    // durably rollback-only, including a fault before the first progress-journal update.
    await persistJournal(store, current, lease, NO_FAULTS);
    for (let index = current.completed - current.rolledBack - 1; index >= 0; index -= 1) { const participant = current.participants[index]!;
      if (isOwnedDataRetirement(participant)) {
        const status = await retirementStatus(store, participant);
        if (status === "retired") {
          await authorizeRetirement(codec, current, participant, index, "rollback"); await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks);
          await faults.hit("before-data-rollback-rename", index); await authorizeRetirement(codec, current, participant, index, "rollback"); await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks);
          if (await retirementStatus(store, participant) !== "retired") throw new Error("data-retirement-authority");
          await fs.rename(participant.destinationPath, participant.dataPath); await faults.hit("after-data-rollback-rename", index);
          await syncDirectory(store.quarantineRoot); await syncDirectory(ownedDataRoot(store)); await faults.hit("after-data-rollback-sync", index);
          await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks);
          if (await retirementStatus(store, participant) !== "source") throw new Error("data-rollback-postcondition");
        } else if (status !== "absent-noop" && status !== "source") throw new Error("data-retirement-uncertain");
      } else {
        const rollbackDigest = participant.rollback.kind === "delete-new-target" ? undefined : participant.rollback.digest; const committedDigest = participantEffect(participant) === "delete" ? undefined : participant.stagedDigest; const observed = await fileDigest(participant.targetPath);
        if (participantEffect(participant) === "delete") {
          const marker = await deletionMarkerIdentity(store, current, participant, index);
          if (marker === "committed") {
            if (observed !== undefined) throw new Error("rollback-target-changed");
            await faults.hit("before-replacement", index); await authorize(codec, current.operationId, participant, "rollback"); await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks);
            if (await deletionMarkerIdentity(store, current, participant, index) !== "committed" || !await validateParticipantTarget(participant, false, current.createdParents[index])) throw new Error("deletion-evidence-uncertain");
            await renameReplace(deletionMarkerPath(store, current, index), participant.targetPath, () => leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks));
            await syncDirectory(path.dirname(participant.targetPath)); await syncDirectory(store.stagingRoot); await faults.hit("after-replacement", index); await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks);
          } else if (marker === "linked-target") await retireDeletionMarker(store, current, participant, index, false);
          else if (marker !== "absent" || observed !== rollbackDigest) throw new Error("deletion-evidence-uncertain");
        } else {
          if (observed !== committedDigest && observed !== rollbackDigest) throw new Error("target changed");
          if (observed === committedDigest && observed !== rollbackDigest) { await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks); if (!await validateParticipantTarget(participant, false, current.createdParents[index])) throw new Error("target-authority");
            if (participant.rollback.kind === "delete-new-target") { if (await fileDigest(participant.targetPath) !== participant.stagedDigest) throw new Error("rollback-target-changed"); await faults.hit("before-replacement", index); await validateFinalMutationTarget(participant, "delete", current.createdParents[index]); await authorize(codec, current.operationId, participant, "delete"); await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks); await fs.rm(participant.targetPath); await syncDirectory(path.dirname(participant.targetPath)); await faults.hit("after-replacement", index); await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks); }
            else { const backup = await fs.readFile(participant.rollback.path); if (participant.precondition.state !== "present" || sha256(backup) !== participant.precondition.digest || participant.rollback.digest !== participant.precondition.digest) throw new Error("backup"); await atomicReplace(store, lease, current.operationId, current.lockBindings, current.requiredLocks, codec, participant, backup, faults, index, "rollback", current.createdParents[index]); } }
        }
      }
      await removeCreatedParent(store, lease, current, codec, index, faults);
      current = Object.freeze({ ...current, rolledBack: current.rolledBack + 1 }); await persistJournal(store, current, lease, faults, false, index); }
    // A process may die after journaling operation-owned evidence but before committing its participant.
    // Reconcile every remaining identity before publishing terminal rollback truth.
    for (let index = current.participants.length - 1; index >= 0; index -= 1) {
      const participant = current.participants[index]!; if (!isOwnedDataRetirement(participant)) continue;
      const status = await retirementStatus(store, participant);
      if (status === "source" || status === "absent-noop") continue;
      if (status !== "retired") throw new Error("data-retirement-uncertain");
      await authorizeRetirement(codec, current, participant, index, "rollback"); await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks);
      await faults.hit("before-data-rollback-rename", index); await authorizeRetirement(codec, current, participant, index, "rollback"); await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks);
      if (await retirementStatus(store, participant) !== "retired") throw new Error("data-retirement-authority");
      await fs.rename(participant.destinationPath, participant.dataPath); await faults.hit("after-data-rollback-rename", index);
      await syncDirectory(store.quarantineRoot); await syncDirectory(ownedDataRoot(store)); await faults.hit("after-data-rollback-sync", index);
      await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks);
      if (await retirementStatus(store, participant) !== "source") throw new Error("data-rollback-postcondition");
    }
    for (const [index, participant] of current.participants.entries()) if (!isOwnedDataRetirement(participant) && participantEffect(participant) === "delete") {
      const marker = await deletionMarkerIdentity(store, current, participant, index);
      if (marker === "linked-target") await retireDeletionMarker(store, current, participant, index, false);
      else if (marker !== "absent") throw new Error("deletion-evidence-uncertain");
    }
    for (let index = 0; index < current.createdParents.length; index += 1) if (current.createdParents[index] !== null) await removeCreatedParent(store, lease, current, codec, index, faults);
    const receipt = receiptFrom(current, "rolled-back"); await persistReceipt(store, receipt, lease, faults); await retireJournal(store, current, lease, faults).catch(() => undefined); return { ok: true, value: receipt };
  } catch { const receipt = await readTransactionReceipt(store, current.operationId); return receipt.ok && receipt.value !== undefined ? { ok: true, value: receipt.value } : fail("recovery-interrupted", "Explicit rollback remains pending"); }
}

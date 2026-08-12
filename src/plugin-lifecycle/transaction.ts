import { randomBytes } from "node:crypto";
import fsSync, { constants, promises as fs, type BigIntStats } from "node:fs";
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
export interface TransactionParticipant {
  readonly kind: string;
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
  readonly generationId?: string;
}
export type ExternalMutation = "replace" | "delete" | "rollback";
export interface ExternalMutationContext { readonly operationId: string; readonly participant: TransactionParticipant; readonly mutation: ExternalMutation }
export interface TransactionProducerCodec<T = unknown> {
  readonly schema: string;
  readonly version: number;
  readonly decodeSummary: (summary: unknown) => StoreResult<T>;
  readonly validatePlan: (participants: readonly TransactionParticipant[]) => StoreResult<void>;
  /** Trusted derivation of the complete canonical profile/checkout/settings lock vector. */
  readonly requiredLocks: (summary: unknown, participants: readonly TransactionParticipant[]) => StoreResult<readonly LifecycleLockIdentity[]>;
  /** Required for external participants and reconstructed from this trusted registry during recovery. */
  readonly authorizeExternal?: (context: ExternalMutationContext) => StoreResult<void> | Promise<StoreResult<void>>;
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
    const requiredLocks = codec.requiredLocks.bind(codec); const authorizeExternal = codec.authorizeExternal?.bind(codec);
    map.set(key, Object.freeze({ schema: codec.schema, version: codec.version, decodeSummary, validatePlan, requiredLocks, ...(authorizeExternal === undefined ? {} : { authorizeExternal }) }));
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

function participantForDigest(participant: TransactionParticipant): unknown {
  return { kind: participant.kind, key: participant.key, ownerKey: participant.ownerKey, scopeKey: participant.scopeKey,
    targetPath: participant.targetPath, targetClass: participant.targetClass, precondition: participant.precondition,
    stagedPath: participant.stagedPath, stagedDigest: participant.stagedDigest, rollback: participant.rollback,
    producerEvidence: participant.producerEvidence, targetEvidence: participant.targetEvidence, stagedEvidence: participant.stagedEvidence,
    ...(participant.backupEvidence === undefined ? {} : { backupEvidence: participant.backupEvidence }),
    ...(participant.generationId === undefined ? {} : { generationId: participant.generationId }) };
}

async function normalizeParticipant(store: OwnedStateStore, raw: TransactionParticipant): Promise<StoreResult<TransactionParticipant>> {
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
    if (raw.precondition.state !== "absent" && (raw.precondition.state !== "present" || !/^sha256:[a-f0-9]{64}$/.test(raw.precondition.digest))) throw new Error("precondition");
    if (raw.precondition.state === "absent" ? raw.rollback.kind !== "delete-new-target" : raw.rollback.kind !== "restore-backup") return fail("invalid-rollback", "CAS state and rollback evidence disagree");
    if (raw.targetClass === "generation" && (typeof raw.generationId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(raw.generationId))) return fail("invalid-participant", "Generation participant requires a bounded id");
    if (raw.targetClass !== "generation" && raw.generationId !== undefined) return fail("invalid-participant", "Generation ids are confined to the generation participant");
    const targetEvidence = await captureEvidence(target, raw.precondition.state === "absent");
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
  const indexes = participants.flatMap((participant, index) => participant.targetClass === "generation" ? [index] : []);
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

export async function prepareTransaction<T>(inputs: { readonly store: OwnedStateStore; readonly codec: TransactionProducerCodec<T>; readonly operationId: string; readonly confirmationSummary: unknown; readonly participants: readonly TransactionParticipant[]; readonly targetAuthority?: TransactionTargetAuthority }): Promise<StoreResult<PreparedTransaction>> {
  const storeValid = await revalidateOwnedStateStore(inputs.store); if (!storeValid.ok) return storeValid;
  if (!validCodecIdentity(inputs.codec.schema, inputs.codec.version) || typeof inputs.codec.decodeSummary !== "function" || typeof inputs.codec.validatePlan !== "function" || typeof inputs.codec.requiredLocks !== "function") return fail("invalid-codec", "Producer codec identity or callbacks are invalid at preparation");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(inputs.operationId)) return fail("invalid-operation", "Operation id is invalid");
  if (inputs.targetAuthority !== undefined) return fail("unsafe-target", "Generic external authority cannot prepare a transaction");
  const decodeSummary = inputs.codec.decodeSummary.bind(inputs.codec); const validatePlan = inputs.codec.validatePlan.bind(inputs.codec);
  const deriveRequiredLocks = inputs.codec.requiredLocks.bind(inputs.codec); const authorizeExternal = inputs.codec.authorizeExternal?.bind(inputs.codec);
  const codecSnapshot: TransactionProducerCodec = Object.freeze({ schema: inputs.codec.schema, version: inputs.codec.version, decodeSummary, validatePlan, requiredLocks: deriveRequiredLocks, ...(authorizeExternal === undefined ? {} : { authorizeExternal }) });
  const summaryClone = canonicalClone(inputs.confirmationSummary); if (!summaryClone.ok) return summaryClone;
  if (!decodeSummary(summaryClone.value).ok) return fail("invalid-summary", "Producer confirmation summary is invalid");
  const summaryBytes = canonicalJsonBytes(summaryClone.value); if (!summaryBytes.ok) return summaryBytes;
  if (inputs.participants.length === 0 || inputs.participants.length > 1024) return fail("invalid-plan", "Transaction participant count is invalid");
  const normalized: TransactionParticipant[] = [];
  for (const raw of inputs.participants) { const cloned = canonicalClone(raw); if (!cloned.ok) return fail("invalid-participant", "Transaction participant is not canonical bounded data"); const value = await normalizeParticipant(inputs.store, cloned.value); if (!value.ok) return value; normalized.push(deepFreeze(value.value)); }
  if (new Set(normalized.map((item) => item.key)).size !== normalized.length || new Set(normalized.map((item) => process.platform === "win32" ? item.targetPath.toLowerCase() : item.targetPath)).size !== normalized.length) return fail("invalid-plan", "Participant keys and canonical targets must be unique");
  const generation = validateGenerationRelationship(normalized); if (!generation.ok) return generation;
  if (normalized.some((item) => item.targetClass === "external") && authorizeExternal === undefined) return fail("unsafe-target", "External participants require a reconstructible trusted producer callback");
  if (!validatePlan(normalized).ok) return fail("invalid-plan", "Producer rejected the exact normalized plan");
  const locksResult = deriveRequiredLocks(summaryClone.value, normalized); if (!locksResult.ok) return fail("invalid-locks", "Producer could not derive required transaction locks");
  const locksClone = canonicalClone(locksResult.value); if (!locksClone.ok || !validRequiredLocks(inputs.store, locksClone.value)) return fail("invalid-locks", "Producer required locks are not an exact canonical profile-first vector");
  const planBytes = canonicalJsonBytes({ participants: normalized.map(participantForDigest), requiredLocks: locksClone.value }); if (!planBytes.ok) return planBytes;
  const prepared = deepFreeze({ operationId: inputs.operationId, producerSchema: codecSnapshot.schema, producerVersion: codecSnapshot.version,
    confirmationSummary: summaryClone.value, confirmationDigest: sha256(summaryBytes.value), participants: normalized, requiredLocks: locksClone.value, planDigest: sha256(planBytes.value) });
  preparedCapabilities.set(prepared, { store: inputs.store, codec: codecSnapshot }); return { ok: true, value: prepared };
}

function validParticipantShape(raw: unknown): raw is TransactionParticipant {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>; const keys = ["key", "kind", "ownerKey", "precondition", "producerEvidence", "rollback", "scopeKey", "stagedDigest", "stagedEvidence", "stagedPath", "targetClass", "targetEvidence", "targetPath"];
  if ("backupEvidence" in value) keys.push("backupEvidence"); if ("generationId" in value) keys.push("generationId");
  if (!exactKeys(value, keys) || typeof value.kind !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/.test(value.kind)
    || typeof value.key !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(value.key)
    || typeof value.ownerKey !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.ownerKey)
    || typeof value.scopeKey !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(value.scopeKey)
    || typeof value.targetPath !== "string" || !path.isAbsolute(value.targetPath) || typeof value.stagedPath !== "string" || !path.isAbsolute(value.stagedPath)
    || (value.targetClass !== "owned" && value.targetClass !== "external" && value.targetClass !== "generation")
    || typeof value.stagedDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.stagedDigest)
    || !validEvidenceShape(value.targetEvidence) || !validEvidenceShape(value.stagedEvidence)
    || !samePath(value.targetEvidence.path, value.targetPath) || !samePath(value.stagedEvidence.path, value.stagedPath)) return false;
  const pre = value.precondition as Record<string, unknown>; const rollback = value.rollback as Record<string, unknown>;
  if (typeof pre !== "object" || pre === null || Array.isArray(pre) || (pre.state === "absent" ? !exactKeys(pre, ["state"]) : pre.state !== "present" || !exactKeys(pre, ["digest", "state"]) || typeof pre.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(pre.digest))) return false;
  if (typeof rollback !== "object" || rollback === null || Array.isArray(rollback)) return false;
  if (rollback.kind === "delete-new-target") { if (!exactKeys(rollback, ["kind"]) || pre.state !== "absent" || "backupEvidence" in value) return false; }
  else if (rollback.kind === "restore-backup") { if (!exactKeys(rollback, ["digest", "kind", "path"]) || pre.state !== "present" || typeof rollback.path !== "string" || !path.isAbsolute(rollback.path) || typeof rollback.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(rollback.digest) || !validEvidenceShape(value.backupEvidence) || !samePath(value.backupEvidence.path, rollback.path)) return false; }
  else return false;
  return value.targetClass === "generation" ? typeof value.generationId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value.generationId) : !("generationId" in value);
}

export async function revalidatePersistedTransaction(store: OwnedStateStore, transaction: PreparedTransaction, codec: TransactionProducerCodec, _targetAuthority?: TransactionTargetAuthority): Promise<StoreResult<void>> {
  if (!validCodecIdentity(codec.schema, codec.version) || codec.schema !== transaction.producerSchema || codec.version !== transaction.producerVersion
    || !codec.decodeSummary(transaction.confirmationSummary).ok || !transaction.participants.every(validParticipantShape) || !validRequiredLocks(store, transaction.requiredLocks)) return fail("invalid-producer-data", "Persisted transaction or producer identity is invalid");
  const generation = validateGenerationRelationship(transaction.participants); if (!generation.ok) return generation;
  if (transaction.participants.some((item) => item.targetClass === "external") && codec.authorizeExternal === undefined) return fail("unknown-producer", "External target callback is unavailable; operation remains inert");
  if (!codec.validatePlan(transaction.participants).ok) return fail("invalid-producer-data", "Producer rejected persisted plan");
  const derivedLocks = codec.requiredLocks(transaction.confirmationSummary, transaction.participants);
  if (!derivedLocks.ok || !lockIdentitiesEqual(derivedLocks.value, transaction.requiredLocks)) return fail("invalid-producer-data", "Producer required-lock derivation changed");
  const summary = canonicalJsonBytes(transaction.confirmationSummary); const plan = canonicalJsonBytes({ participants: transaction.participants.map(participantForDigest), requiredLocks: transaction.requiredLocks });
  if (!summary.ok || !plan.ok || sha256(summary.value) !== transaction.confirmationDigest || sha256(plan.value) !== transaction.planDigest) return fail("digest-mismatch", "Transaction summary or plan binding changed");
  for (const participant of transaction.participants) {
    const partition = ownedRecordPartition(store, participant.ownerKey, participant.scopeKey); if (!partition.ok) return partition;
    if (participant.targetClass === "owned" && !isContainedPath(partition.value, participant.targetPath)) return fail("unsafe-target", "Owned participant escaped its partition");
    if (participant.targetClass === "generation" && !isContainedPath(store.generationsRoot, participant.targetPath)) return fail("unsafe-target", "Generation escaped this profile");
    if (!isContainedPath(store.stagingRoot, participant.stagedPath) || !await validateEvidence(participant.stagedEvidence!, false) || await fileDigest(participant.stagedPath) !== participant.stagedDigest) return fail("changed-staged", "Persisted staged payload changed or lost canonical authority");
    if (!await validateEvidence(participant.targetEvidence!, false)) return fail("unsafe-target", "Target parent identity or canonical authority changed");
    if (participant.rollback.kind === "restore-backup" && (!isContainedPath(store.stagingRoot, participant.rollback.path) || participant.backupEvidence === undefined || !await validateEvidence(participant.backupEvidence, false) || await fileDigest(participant.rollback.path) !== participant.rollback.digest)) return fail("invalid-rollback", "Rollback backup changed or escaped");
  }
  return { ok: true, value: undefined };
}

export type TransactionFaultPhase = "before-journal" | "after-journal" | "before-temp-write" | "after-temp-write" | "after-flush" | "before-replacement" | "after-replacement" | "before-generation-marker" | "after-generation-marker" | "before-receipt" | "after-receipt" | "before-retirement" | "after-retirement";
export interface TransactionFaultSeam { readonly hit: (phase: TransactionFaultPhase, participantIndex?: number) => void | Promise<void> }
const NO_FAULTS: TransactionFaultSeam = Object.freeze({ hit: () => undefined });
export interface TransactionJournal extends PreparedTransaction {
  readonly format: "picc-transaction-journal"; readonly formatVersion: 1; readonly lockBindings: readonly JournalLockBinding[];
  readonly completed: number; readonly rolledBack: number; readonly state: "prepared" | "pending" | "rolling-back";
}
export type PrecommitFailureCategory = "cancelled" | "stale-precondition" | "changed-staged" | "storage-failure";
export interface TransactionReceipt extends PreparedTransaction {
  readonly format: "picc-transaction-receipt"; readonly formatVersion: 1; readonly lockBindings: readonly JournalLockBinding[];
  readonly outcome: "committed" | "rolled-back" | "failed-before-commit"; readonly completed: number;
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
async function authorize(codec: TransactionProducerCodec, operationId: string, participant: TransactionParticipant, mutation: ExternalMutation): Promise<void> {
  if (participant.targetClass !== "external") return;
  const result = await codec.authorizeExternal?.({ operationId, participant, mutation }); if (result === undefined || !result.ok) throw new Error("external-authority");
}
async function validateFinalMutationTarget(participant: TransactionParticipant, mutation: ExternalMutation): Promise<void> {
  const requireOriginalTarget = mutation === "replace" && participant.precondition.state === "present";
  if (!await validateEvidence(participant.targetEvidence!, requireOriginalTarget)) throw new Error("target-authority");
  if (mutation === "replace") { if (!await casMatches(participant)) throw new Error("stale-precondition"); }
  else if (await fileDigest(participant.targetPath) !== participant.stagedDigest) throw new Error("rollback-target-changed");
}
async function atomicReplace(store: OwnedStateStore, lease: LifecycleLockLease, operationId: string, bindings: readonly JournalLockBinding[], requiredLocks: readonly LifecycleLockIdentity[], codec: TransactionProducerCodec, participant: TransactionParticipant, bytes: Uint8Array, faults: TransactionFaultSeam, index: number, mutation: ExternalMutation): Promise<void> {
  const generation = participant.targetClass === "generation"; if (generation) { await faults.hit("before-generation-marker", index); await leaseBoundary(store, lease, operationId, bindings, requiredLocks); }
  await faults.hit("before-temp-write", index); await leaseBoundary(store, lease, operationId, bindings, requiredLocks); const temporary = `${participant.targetPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(bytes); await faults.hit("after-temp-write", index); await leaseBoundary(store, lease, operationId, bindings, requiredLocks); await handle.sync(); await faults.hit("after-flush", index); await leaseBoundary(store, lease, operationId, bindings, requiredLocks); }
    finally { await handle.close(); }
    await leaseBoundary(store, lease, operationId, bindings, requiredLocks);
    if (!await validateEvidence(participant.targetEvidence!, mutation === "replace" && participant.precondition.state === "present")) throw new Error("target-authority");
    if (mutation === "replace" && !await casMatches(participant)) throw new Error("stale-precondition");
    if (mutation === "rollback" && await fileDigest(participant.targetPath) !== participant.stagedDigest) throw new Error("rollback-target-changed");
    await authorize(codec, operationId, participant, mutation); await leaseBoundary(store, lease, operationId, bindings, requiredLocks); await faults.hit("before-replacement", index);
    await leaseBoundary(store, lease, operationId, bindings, requiredLocks);
    await renameReplace(temporary, participant.targetPath, async () => { await leaseBoundary(store, lease, operationId, bindings, requiredLocks); await validateFinalMutationTarget(participant, mutation); });
    await syncDirectory(path.dirname(participant.targetPath)); await faults.hit("after-replacement", index);
    await leaseBoundary(store, lease, operationId, bindings, requiredLocks);
    if (generation) { await faults.hit("after-generation-marker", index); await leaseBoundary(store, lease, operationId, bindings, requiredLocks); }
  } catch (error) { if (await validateEvidence(participant.targetEvidence!, false)) await fs.rm(temporary, { force: true }).catch(() => undefined); throw error; }
}
async function casMatches(participant: TransactionParticipant): Promise<boolean> { const digest = await fileDigest(participant.targetPath); return participant.precondition.state === "absent" ? digest === undefined : digest === participant.precondition.digest; }
export function completedGenerationId(transaction: PreparedTransaction, completed: number): string | undefined {
  if (completed !== transaction.participants.length) return undefined; const last = transaction.participants.at(-1); return last?.targetClass === "generation" ? last.generationId : undefined;
}
function receiptFrom(journal: TransactionJournal, outcome: TransactionReceipt["outcome"], failureCategory?: PrecommitFailureCategory): TransactionReceipt {
  const terminalCompleted = outcome === "committed" ? journal.participants.length : 0; const generationId = outcome === "committed" ? completedGenerationId(journal, journal.participants.length) : undefined;
  return Object.freeze({ format: "picc-transaction-receipt", formatVersion: 1, operationId: journal.operationId, producerSchema: journal.producerSchema, producerVersion: journal.producerVersion,
    confirmationSummary: journal.confirmationSummary, confirmationDigest: journal.confirmationDigest, participants: journal.participants, requiredLocks: journal.requiredLocks, planDigest: journal.planDigest,
    lockBindings: journal.lockBindings, outcome, completed: terminalCompleted, ...(failureCategory === undefined ? {} : { failureCategory }), ...(generationId === undefined ? {} : { generationId }) });
}

const JOURNAL_KEYS = ["completed", "confirmationDigest", "confirmationSummary", "format", "formatVersion", "lockBindings", "operationId", "participants", "planDigest", "producerSchema", "producerVersion", "requiredLocks", "rolledBack", "state"];
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
function decodeReceiptStructure(store: OwnedStateStore, operationId: string, parsed: Record<string, unknown>): StoreResult<TransactionReceipt> {
  const optional = ["failureCategory", "generationId"].filter((key) => key in parsed); const expected = ["completed", "confirmationDigest", "confirmationSummary", "format", "formatVersion", "lockBindings", "operationId", "outcome", "participants", "planDigest", "producerSchema", "producerVersion", "requiredLocks", ...optional];
  const base = parsePreparedBase(parsed, operationId);
  if (!exactKeys(parsed, expected) || !base.ok || !validLockBindingIdentityRelationship(store, parsed.requiredLocks, parsed.lockBindings) || parsed.format !== "picc-transaction-receipt" || parsed.formatVersion !== 1 || !validBindings(parsed.lockBindings) || !validBindingRelationships(store, parsed.lockBindings) || (parsed.outcome !== "committed" && parsed.outcome !== "rolled-back" && parsed.outcome !== "failed-before-commit") || !Number.isSafeInteger(parsed.completed)) return fail("invalid-receipt", "Stored transaction receipt is invalid");
  const complete = parsed.outcome === "committed"; const generation = completedGenerationId(base.value, base.value.participants.length);
  if ((complete ? parsed.completed !== base.value.participants.length : parsed.completed !== 0) || (parsed.outcome === "failed-before-commit" ? !(["cancelled", "stale-precondition", "changed-staged", "storage-failure"] as unknown[]).includes(parsed.failureCategory) : "failureCategory" in parsed) || (complete ? (generation === undefined ? "generationId" in parsed : parsed.generationId !== generation) : "generationId" in parsed)) return fail("invalid-receipt", "Receipt outcome/completion/generation relationship is invalid");
  return { ok: true, value: parsed as unknown as TransactionReceipt };
}
function decodeJournalStructure(store: OwnedStateStore, operationId: string, parsed: Record<string, unknown>): StoreResult<TransactionJournal> {
  const base = parsePreparedBase(parsed, operationId);
  if (!exactKeys(parsed, JOURNAL_KEYS) || !base.ok || !validLockBindingIdentityRelationship(store, parsed.requiredLocks, parsed.lockBindings) || parsed.format !== "picc-transaction-journal" || parsed.formatVersion !== 1 || !validBindings(parsed.lockBindings) || !validBindingRelationships(store, parsed.lockBindings) || !Number.isSafeInteger(parsed.completed) || !Number.isSafeInteger(parsed.rolledBack) || typeof parsed.completed !== "number" || typeof parsed.rolledBack !== "number" || parsed.completed < 0 || parsed.completed > base.value.participants.length || parsed.rolledBack < 0 || parsed.rolledBack > parsed.completed || (parsed.state !== "prepared" && parsed.state !== "pending" && parsed.state !== "rolling-back") || (parsed.state === "prepared" && (parsed.completed !== 0 || parsed.rolledBack !== 0)) || (parsed.state !== "rolling-back" && parsed.rolledBack !== 0)) return fail("invalid-journal", "Stored transaction journal relationships are invalid");
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
  if (parsed.state === "rolling-back") { while (rolledBack < completed) { const p = parsed.participants[completed - rolledBack - 1]!; const expectedDigest = p.rollback.kind === "delete-new-target" ? undefined : p.rollback.digest; if (await fileDigest(p.targetPath) !== expectedDigest) break; rolledBack += 1; } }
  else { while (completed < parsed.participants.length && await fileDigest(parsed.participants[completed]!.targetPath) === parsed.participants[completed]!.stagedDigest) completed += 1; }
  return { ok: true, value: Object.freeze({ ...parsed, completed, rolledBack, state: parsed.state === "rolling-back" ? "rolling-back" : completed > 0 ? "pending" : parsed.state }) };
}

export async function listPendingJournals(store: OwnedStateStore): Promise<StoreResult<readonly string[]>> {
  try { const names = (await fs.readdir(store.journalsRoot)).filter((name) => /^[A-Za-z0-9_-]{1,128}\.json$/.test(name)); const pending: string[] = [];
    for (const name of names) { const id = name.slice(0, -5); const receipt = await readTransactionReceipt(store, id); if (!receipt.ok || receipt.value === undefined) pending.push(id); }
    return { ok: true, value: Object.freeze(pending.sort()) };
  } catch { return fail("journal-read", "Pending transaction journals could not be inspected"); }
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
  let journal: TransactionJournal = Object.freeze({ ...prepared, format: "picc-transaction-journal", formatVersion: 1, lockBindings: lease.bindings, completed: 0, rolledBack: 0, state: "prepared" }); const faults = options.faults ?? NO_FAULTS;
  try {
    await persistJournal(store, journal, lease, faults, true, undefined, () => revalidatePreparedAuthority(store, prepared, capability.codec));
    for (let index = 0; index < journal.participants.length; index += 1) {
      if (options.signal?.aborted === true) throw new Error("cancelled"); const participant = journal.participants[index]!;
      await leaseBoundary(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks); if (!await validateEvidence(participant.targetEvidence!, participant.precondition.state === "present")) throw new Error("target-authority"); if (!await casMatches(participant)) throw new Error("stale-precondition");
      const payload = await fs.readFile(participant.stagedPath); if (sha256(payload) !== participant.stagedDigest || !await validateEvidence(participant.stagedEvidence!, false)) throw new Error("changed-staged");
      try { await atomicReplace(store, lease, journal.operationId, journal.lockBindings, journal.requiredLocks, capability.codec, participant, payload, faults, index, "replace"); }
      catch (error) { if (await fileDigest(participant.targetPath) === participant.stagedDigest) { journal = Object.freeze({ ...journal, completed: index + 1, state: "pending" }); await persistJournal(store, journal, lease, NO_FAULTS, false, index).catch(() => undefined); } throw error; }
      journal = Object.freeze({ ...journal, completed: index + 1, state: "pending" }); await persistJournal(store, journal, lease, faults, false, index);
    }
    const receipt = receiptFrom(journal, "committed");
    try { await persistReceipt(store, receipt, lease, faults); } catch (error) { const reread = await readTransactionReceipt(store, journal.operationId); if (reread.ok && reread.value !== undefined) { await retireJournal(store, journal, lease, NO_FAULTS).catch(() => undefined); return await deliver(outcomeFromReceipt(reread.value), options); } throw error; }
    await retireJournal(store, journal, lease, faults).catch(() => undefined); return await deliver({ state: "committed", receipt }, options);
  } catch (error) {
    const stored = await readTransactionReceipt(store, journal.operationId); if (stored.ok && stored.value !== undefined) return deliver(outcomeFromReceipt(stored.value), options);
    if (journal.completed > 0) return deliver({ state: "pending-recovery", operationId: journal.operationId, completed: journal.completed, cause: "Transaction interrupted after a committed safe prefix" }, options);
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
    for (let index = 0; index < current.completed; index += 1) if (await fileDigest(current.participants[index]!.targetPath) !== current.participants[index]!.stagedDigest) throw new Error("prefix changed");
    for (let index = current.completed; index < current.participants.length; index += 1) { const participant = current.participants[index]!; await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks); if (!await validateEvidence(participant.targetEvidence!, participant.precondition.state === "present")) throw new Error("target-authority"); if (!await casMatches(participant)) throw new Error("CAS"); const payload = await fs.readFile(participant.stagedPath); if (sha256(payload) !== participant.stagedDigest) throw new Error("staged");
      try { await atomicReplace(store, lease, current.operationId, current.lockBindings, current.requiredLocks, codec, participant, payload, faults, index, "replace"); } catch (error) { if (await fileDigest(participant.targetPath) === participant.stagedDigest) { current = Object.freeze({ ...current, completed: index + 1, state: "pending" }); await persistJournal(store, current, lease, NO_FAULTS, false, index).catch(() => undefined); } throw error; }
      current = Object.freeze({ ...current, completed: index + 1, state: "pending" }); await persistJournal(store, current, lease, faults, false, index); }
    const receipt = receiptFrom(current, "committed"); await persistReceipt(store, receipt, lease, faults); await retireJournal(store, current, lease, faults).catch(() => undefined); return { ok: true, value: receipt };
  } catch { const receipt = await readTransactionReceipt(store, current.operationId); return receipt.ok && receipt.value !== undefined ? { ok: true, value: receipt.value } : fail("recovery-interrupted", "Explicit completion remains pending"); }
}
export async function rollbackJournal(store: OwnedStateStore, journal: TransactionJournal, codec: TransactionProducerCodec, lease: LifecycleLockLease, faults: TransactionFaultSeam = NO_FAULTS): Promise<StoreResult<TransactionReceipt>> {
  let current = Object.freeze({ ...journal, state: "rolling-back" as const });
  try {
    // Publish rollback intent before exposing operation faults so every interrupted rollback is
    // durably rollback-only, including a fault before the first progress-journal update.
    await persistJournal(store, current, lease, NO_FAULTS);
    for (let index = current.completed - current.rolledBack - 1; index >= 0; index -= 1) { const participant = current.participants[index]!; const rollbackDigest = participant.rollback.kind === "delete-new-target" ? undefined : participant.rollback.digest; const observed = await fileDigest(participant.targetPath); if (observed !== participant.stagedDigest && observed !== rollbackDigest) throw new Error("target changed");
      if (observed === participant.stagedDigest) { await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks); if (!await validateEvidence(participant.targetEvidence!, false)) throw new Error("target-authority");
        if (participant.rollback.kind === "delete-new-target") { if (await fileDigest(participant.targetPath) !== participant.stagedDigest) throw new Error("rollback-target-changed"); await authorize(codec, current.operationId, participant, "delete"); await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks); await faults.hit("before-replacement", index); await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks); await validateFinalMutationTarget(participant, "delete"); await fs.rm(participant.targetPath); await syncDirectory(path.dirname(participant.targetPath)); await faults.hit("after-replacement", index); await leaseBoundary(store, lease, current.operationId, current.lockBindings, current.requiredLocks); }
        else { const backup = await fs.readFile(participant.rollback.path); if (sha256(backup) !== participant.rollback.digest) throw new Error("backup"); await atomicReplace(store, lease, current.operationId, current.lockBindings, current.requiredLocks, codec, participant, backup, faults, index, "rollback"); } }
      current = Object.freeze({ ...current, rolledBack: current.rolledBack + 1 }); await persistJournal(store, current, lease, faults, false, index); }
    const receipt = receiptFrom(current, "rolled-back"); await persistReceipt(store, receipt, lease, faults); await retireJournal(store, current, lease, faults).catch(() => undefined); return { ok: true, value: receipt };
  } catch { const receipt = await readTransactionReceipt(store, current.operationId); return receipt.ok && receipt.value !== undefined ? { ok: true, value: receipt.value } : fail("recovery-interrupted", "Explicit rollback remains pending"); }
}

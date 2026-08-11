import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import path from "node:path";
import { canonicalJsonBytes, revalidateOwnedStateStore, type OwnedStateStore, type StoreResult } from "./state-store.js";

export type LifecycleLockIdentity =
  | { readonly kind: "profile"; readonly key: string }
  | { readonly kind: "checkout"; readonly key: string }
  | { readonly kind: "settings"; readonly key: string };

export interface LockOwner {
  readonly format: "picc-lifecycle-lock";
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly identityKind: LifecycleLockIdentity["kind"];
  readonly identityKey: string;
  readonly nonce: string;
  readonly generation: string;
  readonly pid: number;
  readonly processToken: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly predecessorBinding?: JournalLockBinding;
}

export interface JournalLockBinding {
  readonly kind: LifecycleLockIdentity["kind"];
  readonly key: string;
  readonly nonce: string;
  readonly generation: string;
}

export type ProcessObservation =
  | { readonly state: "absent" }
  | { readonly state: "live"; readonly processToken?: string }
  | { readonly state: "ambiguous"; readonly reason: string };
export interface ProcessOwnershipProbe { readonly observe: (pid: number) => Promise<ProcessObservation> }

async function defaultObserve(pid: number): Promise<ProcessObservation> {
  try { process.kill(pid, 0); return { state: "live" }; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? { state: "absent" } : { state: "ambiguous", reason: "Process ownership cannot be observed" }; }
}
export const defaultProcessOwnershipProbe: ProcessOwnershipProbe = Object.freeze({ observe: defaultObserve });

interface Identity { readonly dev: bigint; readonly ino: bigint }
interface HeldLock { readonly directory: string; readonly directoryIdentity: Identity; readonly owner: LockOwner }
interface DisplacedLock {
  readonly directory: string;
  readonly quarantine: string;
  readonly directoryIdentity: Identity;
  readonly ownerBytes: Buffer;
  readonly binding: JournalLockBinding;
  readonly journalBinding: JournalLockBinding;
}
interface LeaseAuthority {
  readonly store: OwnedStateStore;
  readonly held: readonly HeldLock[];
  readonly takeoverBindings?: readonly JournalLockBinding[];
  released: boolean;
}
export interface LifecycleLockLease {
  readonly operationId: string;
  readonly identities: readonly LifecycleLockIdentity[];
  readonly bindings: readonly JournalLockBinding[];
}
const leases = new WeakMap<LifecycleLockLease, LeaseAuthority>();

function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function identity(stat: BigIntStats): Identity { return { dev: stat.dev, ino: stat.ino }; }
function sameIdentity(expected: Identity, stat: BigIntStats): boolean { return expected.dev === stat.dev && expected.ino === stat.ino; }
function rank(value: LifecycleLockIdentity): number { return value.kind === "profile" ? 0 : value.kind === "checkout" ? 1 : 2; }
function identityText(value: LifecycleLockIdentity): string { return `${value.kind}\0${value.key}`; }
function encodedIdentity(value: LifecycleLockIdentity): string { return createHash("sha256").update(identityText(value), "utf8").digest("base64url"); }
export function lifecycleLockDirectory(store: OwnedStateStore, value: LifecycleLockIdentity): string { return path.join(store.locksRoot, `${value.kind}-${encodedIdentity(value)}.lock`); }
function ownerPath(directory: string): string { return path.join(directory, "owner.json"); }

const OWNER_KEYS = ["acquiredAt", "format", "formatVersion", "generation", "heartbeatAt", "identityKey", "identityKind", "nonce", "operationId", "pid", "processToken"];
const BINDING_KEYS = ["generation", "key", "kind", "nonce"];
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function validIdentity(kind: unknown, key: unknown): kind is LifecycleLockIdentity["kind"] {
  return (kind === "profile" || kind === "checkout" || kind === "settings") && typeof key === "string" && key.length > 0 && key.length <= 256 && !key.includes("\0");
}
function validBinding(value: unknown): value is JournalLockBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return exactKeys(candidate, BINDING_KEYS) && validIdentity(candidate.kind, candidate.key)
    && typeof candidate.nonce === "string" && /^[a-f0-9]{32}$/.test(candidate.nonce)
    && typeof candidate.generation === "string" && /^[a-f0-9]{32}$/.test(candidate.generation);
}
async function readOwner(directory: string): Promise<StoreResult<LockOwner>> {
  try {
    const bytes = await fs.readFile(ownerPath(directory));
    if (bytes.byteLength > 16 * 1024) throw new Error("oversize");
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const canonical = canonicalJsonBytes(parsed, 16 * 1024);
    const hasPredecessor = Object.hasOwn(parsed, "predecessorBinding");
    if (!canonical.ok || !Buffer.from(canonical.value).equals(bytes) || !exactKeys(parsed, hasPredecessor ? [...OWNER_KEYS, "predecessorBinding"] : OWNER_KEYS)
      || parsed.format !== "picc-lifecycle-lock" || parsed.formatVersion !== 1
      || !validIdentity(parsed.identityKind, parsed.identityKey)
      || typeof parsed.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(parsed.operationId)
      || typeof parsed.nonce !== "string" || !/^[a-f0-9]{32}$/.test(parsed.nonce)
      || typeof parsed.generation !== "string" || !/^[a-f0-9]{32}$/.test(parsed.generation)
      || typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid < 1
      || typeof parsed.processToken !== "string" || parsed.processToken.length < 1 || parsed.processToken.length > 128
      || typeof parsed.acquiredAt !== "string" || typeof parsed.heartbeatAt !== "string"
      || !Number.isFinite(Date.parse(parsed.acquiredAt)) || !Number.isFinite(Date.parse(parsed.heartbeatAt))
      || (hasPredecessor && (!validBinding(parsed.predecessorBinding)
        || parsed.predecessorBinding.kind !== parsed.identityKind || parsed.predecessorBinding.key !== parsed.identityKey
        || (parsed.predecessorBinding.nonce === parsed.nonce && parsed.predecessorBinding.generation === parsed.generation)))) throw new Error("invalid");
    return { ok: true, value: parsed as unknown as LockOwner };
  } catch { return fail("ambiguous-lock", "Lock ownership record is invalid; explicit inspection is required"); }
}

function binding(owner: LockOwner): JournalLockBinding {
  return Object.freeze({ kind: owner.identityKind, key: owner.identityKey, nonce: owner.nonce, generation: owner.generation });
}
function bindingsEqual(left: readonly JournalLockBinding[], right: readonly JournalLockBinding[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]; return other !== undefined && item.kind === other.kind && item.key === other.key && item.nonce === other.nonce && item.generation === other.generation;
  });
}
export function lockIdentitiesEqual(left: readonly LifecycleLockIdentity[], right: readonly LifecycleLockIdentity[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]; return other !== undefined && item.kind === other.kind && item.key === other.key;
  });
}

async function readExactJournalEvidence(store: OwnedStateStore, operationId: string): Promise<{ readonly bindings: readonly JournalLockBinding[]; readonly identities: readonly LifecycleLockIdentity[] } | undefined> {
  try {
    // Dynamic import avoids a static locks↔transaction cycle while requiring the complete,
    // versioned journal parser rather than accepting nonce-shaped JSON as takeover evidence.
    const { readTransactionJournal } = await import("./transaction.js");
    const parsed = await readTransactionJournal(store, operationId);
    return parsed.ok ? { bindings: parsed.value.lockBindings, identities: parsed.value.requiredLocks } : undefined;
  } catch { return undefined; }
}

function processToken(): string { return `${process.pid}-${process.ppid}-${Math.floor(process.uptime() * 1000)}-${randomBytes(8).toString("hex")}`; }
async function writeOwnerExclusive(directory: string, owner: LockOwner): Promise<void> {
  const bytes = canonicalJsonBytes(owner, 16 * 1024); if (!bytes.ok) throw new Error(bytes.message);
  const handle = await fs.open(ownerPath(directory), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes.value); await handle.sync(); } finally { await handle.close(); }
}
async function createHeldLock(directory: string, requested: LifecycleLockIdentity, operationId: string, token: string, predecessorBinding?: JournalLockBinding): Promise<HeldLock> {
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    if (process.platform !== "win32") await fs.chmod(directory, 0o700);
    const stat = await fs.lstat(directory, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe lock directory");
    const now = new Date().toISOString();
    const owner: LockOwner = Object.freeze({ format: "picc-lifecycle-lock", formatVersion: 1, operationId, identityKind: requested.kind, identityKey: requested.key,
      nonce: randomBytes(16).toString("hex"), generation: randomBytes(16).toString("hex"), pid: process.pid, processToken: token, acquiredAt: now, heartbeatAt: now,
      ...(predecessorBinding === undefined ? {} : { predecessorBinding: Object.freeze({ ...predecessorBinding }) }) });
    await writeOwnerExclusive(directory, owner);
    return { directory, directoryIdentity: identity(stat), owner };
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined); throw error; }
}

async function attemptTakeover(inputs: { store: OwnedStateStore; directory: string; requested: LifecycleLockIdentity; expectedRecoveryOperationId?: string; expectedJournalBindings?: readonly JournalLockBinding[]; expectedJournalBinding?: JournalLockBinding; expectedJournalIdentities?: readonly LifecycleLockIdentity[]; probe: ProcessOwnershipProbe; preflightOnly?: boolean }): Promise<StoreResult<JournalLockBinding | DisplacedLock>> {
  const owner = await readOwner(inputs.directory); if (!owner.ok) return owner;
  if (owner.value.identityKind !== inputs.requested.kind || owner.value.identityKey !== inputs.requested.key) return fail("ambiguous-lock", "Lock identity does not match its canonical directory");
  const stat = await fs.lstat(inputs.directory, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("ambiguous-lock", "Lock path is not an ordinary directory");
  const ownerBytes = await fs.readFile(ownerPath(inputs.directory));
  const observed = await inputs.probe.observe(owner.value.pid);
  if (observed.state === "live") return observed.processToken !== undefined && observed.processToken !== owner.value.processToken
    ? fail("ambiguous-lock", "Lock PID was reused; explicit recovery inspection is required")
    : fail("lock-busy", `Lifecycle lock is held by live process ${owner.value.pid}`);
  if (observed.state === "ambiguous") return fail("ambiguous-lock", `${observed.reason}; explicit inspection is required`);
  if (inputs.expectedRecoveryOperationId !== owner.value.operationId) return fail("ambiguous-lock", "Dead owner is not bound to the selected recovery operation");
  const journalEvidence = await readExactJournalEvidence(inputs.store, owner.value.operationId);
  const currentBinding = binding(owner.value);
  if (journalEvidence === undefined || inputs.expectedJournalBindings === undefined || inputs.expectedJournalBinding === undefined || inputs.expectedJournalIdentities === undefined
    || !lockIdentitiesEqual(journalEvidence.identities, inputs.expectedJournalIdentities)
    || !bindingsEqual(journalEvidence.bindings, inputs.expectedJournalBindings)) return fail("ambiguous-lock", "Dead owner lacks the selected journal's exact lock vector");
  const predecessor = owner.value.predecessorBinding;
  if (!bindingsEqual([currentBinding], [inputs.expectedJournalBinding])
    && (predecessor === undefined || !bindingsEqual([predecessor], [inputs.expectedJournalBinding]))) return fail("ambiguous-lock", "Dead owner lacks exact matching journal nonce/generation evidence");
  if (inputs.preflightOnly === true) return { ok: true, value: inputs.expectedJournalBinding };
  const reread = await readOwner(inputs.directory); const rereadBytes = await fs.readFile(ownerPath(inputs.directory)); const restat = await fs.lstat(inputs.directory, { bigint: true });
  if (!reread.ok || !bindingsEqual([binding(reread.value)], [currentBinding]) || !ownerBytes.equals(rereadBytes) || !sameIdentity(identity(stat), restat)) return fail("ambiguous-lock", "Lock generation changed during takeover");
  const quarantine = path.join(inputs.store.quarantineRoot, `dead-lock-${owner.value.generation}-${randomBytes(4).toString("hex")}`);
  let displaced: DisplacedLock | undefined;
  try {
    await fs.rename(inputs.directory, quarantine);
    displaced = { directory: inputs.directory, quarantine, directoryIdentity: identity(stat), ownerBytes, binding: currentBinding, journalBinding: inputs.expectedJournalBinding };
    const quarantined = await fs.lstat(quarantine, { bigint: true }); const quarantinedBytes = await fs.readFile(ownerPath(quarantine));
    if (!sameIdentity(displaced.directoryIdentity, quarantined) || !ownerBytes.equals(quarantinedBytes)) throw new Error("displaced evidence changed");
  } catch {
    if (displaced !== undefined) await restoreDisplaced([displaced]);
    return fail("ambiguous-lock", "Atomic dead-lock takeover lost its ownership race");
  }
  return { ok: true, value: displaced };
}

async function restoreDisplaced(displaced: readonly DisplacedLock[]): Promise<boolean> {
  const reverse = [...displaced].reverse();
  try {
    // Validate the complete restoration set before moving any member, avoiding a known-bad
    // later quarantine from producing another partial vector.
    for (const lock of reverse) {
      await fs.lstat(lock.directory).then(() => { throw new Error("replacement path occupied"); }, (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      const stat = await fs.lstat(lock.quarantine, { bigint: true }); const ownerBytes = await fs.readFile(ownerPath(lock.quarantine)); const owner = await readOwner(lock.quarantine);
      if (!sameIdentity(lock.directoryIdentity, stat) || !ownerBytes.equals(lock.ownerBytes) || !owner.ok || !bindingsEqual([binding(owner.value)], [lock.binding])) return false;
    }
    for (const lock of reverse) {
      await fs.rename(lock.quarantine, lock.directory);
      const restoredStat = await fs.lstat(lock.directory, { bigint: true }); const restoredBytes = await fs.readFile(ownerPath(lock.directory));
      if (!sameIdentity(lock.directoryIdentity, restoredStat) || !restoredBytes.equals(lock.ownerBytes)) return false;
    }
    return true;
  } catch { return false; }
}

async function releaseHeld(held: readonly HeldLock[]): Promise<boolean> {
  let complete = true;
  for (const lock of [...held].reverse()) {
    try {
      const owner = await readOwner(lock.directory); const stat = await fs.lstat(lock.directory, { bigint: true });
      if (!owner.ok || !bindingsEqual([binding(owner.value)], [binding(lock.owner)]) || !sameIdentity(lock.directoryIdentity, stat)) { complete = false; continue; }
      await fs.rm(lock.directory, { recursive: true });
    } catch { complete = false; }
  }
  return complete;
}

export async function acquireLifecycleLocks(inputs: { readonly store: OwnedStateStore; readonly operationId: string; readonly identities: readonly LifecycleLockIdentity[]; readonly expectedRecoveryOperationId?: string; readonly processProbe?: ProcessOwnershipProbe }): Promise<StoreResult<LifecycleLockLease>> {
  const valid = await revalidateOwnedStateStore(inputs.store); if (!valid.ok) return valid;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(inputs.operationId) || inputs.identities.length === 0 || inputs.identities.length > 128) return fail("invalid-lock", "Lifecycle lock request is invalid");
  const ordered = [...inputs.identities].sort((a, b) => rank(a) - rank(b) || Buffer.compare(Buffer.from(a.key, "utf8"), Buffer.from(b.key, "utf8")));
  if (!lockIdentitiesEqual(inputs.identities, ordered) || ordered[0]?.kind !== "profile" || ordered[0].key !== inputs.store.profileKey) return fail("invalid-lock-order", "Lifecycle locks must use the exact canonical profile-first order");
  if (new Set(ordered.map(identityText)).size !== ordered.length) return fail("invalid-lock", "Lifecycle lock identities are duplicated");
  let recoveryEvidence: Awaited<ReturnType<typeof readExactJournalEvidence>>;
  if (inputs.expectedRecoveryOperationId !== undefined) {
    if (inputs.expectedRecoveryOperationId !== inputs.operationId) return fail("ambiguous-lock", "Recovery operation identity is inconsistent");
    recoveryEvidence = await readExactJournalEvidence(inputs.store, inputs.operationId);
    if (recoveryEvidence === undefined || !lockIdentitiesEqual(ordered, recoveryEvidence.identities)
      || recoveryEvidence.bindings.length !== ordered.length) return fail("ambiguous-lock", "Recovery requires the journal's exact complete lock vector");
  }
  const held: HeldLock[] = []; const displaced: DisplacedLock[] = []; const prior: JournalLockBinding[] = []; const token = processToken();
  const abortTakeover = async (result: StoreResult<never>): Promise<StoreResult<never>> => {
    const released = await releaseHeld(held);
    const restored = released && await restoreDisplaced(displaced);
    return restored ? result : fail("ambiguous-lock", "Partial dead-lock takeover could not restore the exact prior lock vector; explicit inspection is required");
  };
  try {
    if (recoveryEvidence !== undefined) {
      const observed: JournalLockBinding[] = [];
      for (const [index, requested] of ordered.entries()) {
        const expectedJournalBinding = recoveryEvidence.bindings[index]; if (expectedJournalBinding === undefined) return fail("ambiguous-lock", "Recovery journal lock vector is incomplete");
        const checked = await attemptTakeover({ store: inputs.store, directory: lifecycleLockDirectory(inputs.store, requested), requested, expectedRecoveryOperationId: inputs.expectedRecoveryOperationId,
          expectedJournalBindings: recoveryEvidence.bindings, expectedJournalBinding, expectedJournalIdentities: recoveryEvidence.identities, probe: inputs.processProbe ?? defaultProcessOwnershipProbe, preflightOnly: true });
        if (!checked.ok) return checked; if ("binding" in checked.value) return fail("ambiguous-lock", "Recovery preflight unexpectedly displaced a lock"); observed.push(checked.value);
      }
      if (!bindingsEqual(observed, recoveryEvidence.bindings)) return fail("ambiguous-lock", "Recovery preflight did not prove every journal lock generation one-to-one");
    }
    for (const [index, requested] of ordered.entries()) {
      const directory = lifecycleLockDirectory(inputs.store, requested);
      try {
        if (recoveryEvidence !== undefined) {
          await fs.lstat(directory);
          const busy = Object.assign(new Error("recovery takeover"), { code: "EEXIST" });
          throw busy;
        }
        held.push(await createHeldLock(directory, requested, inputs.operationId, token));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const expectedJournalBinding = recoveryEvidence?.bindings[index];
        const takeover = await attemptTakeover({ store: inputs.store, directory, requested, expectedRecoveryOperationId: inputs.expectedRecoveryOperationId,
          ...(recoveryEvidence === undefined || expectedJournalBinding === undefined ? {} : { expectedJournalBindings: recoveryEvidence.bindings, expectedJournalBinding, expectedJournalIdentities: recoveryEvidence.identities }),
          probe: inputs.processProbe ?? defaultProcessOwnershipProbe });
        if (!takeover.ok) return abortTakeover(takeover);
        if (!("binding" in takeover.value)) return abortTakeover(fail("ambiguous-lock", "Recovery takeover did not retain displaced ownership evidence"));
        displaced.push(takeover.value); prior.push(takeover.value.journalBinding); held.push(await createHeldLock(directory, requested, inputs.operationId, token, takeover.value.journalBinding));
      }
    }
    if (recoveryEvidence !== undefined && !bindingsEqual(prior, recoveryEvidence.bindings)) return abortTakeover(fail("ambiguous-lock", "Recovery did not replace every journal lock generation one-to-one"));
    const lease = Object.freeze({ operationId: inputs.operationId, identities: Object.freeze(ordered.map((item) => Object.freeze({ kind: item.kind, key: item.key }))), bindings: Object.freeze(held.map((item) => binding(item.owner))) });
    leases.set(lease, { store: inputs.store, held: Object.freeze(held), takeoverBindings: recoveryEvidence === undefined ? undefined : Object.freeze(prior), released: false });
    return { ok: true, value: lease };
  } catch { return abortTakeover(fail("lock-io", "Lifecycle locks could not be acquired safely")); }
}

export async function validateLifecycleLockLease(store: OwnedStateStore, lease: LifecycleLockLease | undefined, operationId: string, journalBindings?: readonly JournalLockBinding[], requiredIdentities?: readonly LifecycleLockIdentity[]): Promise<StoreResult<void>> {
  const authority = lease === undefined ? undefined : leases.get(lease);
  if (authority === undefined || authority.released || authority.store !== store || lease?.operationId !== operationId) return fail("invalid-lease", "A live store/operation-bound lifecycle lock lease is required");
  if (requiredIdentities !== undefined && !lockIdentitiesEqual(lease.identities, requiredIdentities)) return fail("invalid-lease", "Lease identities do not exactly match the prepared operation");
  if (journalBindings !== undefined && !bindingsEqual(lease.bindings, journalBindings)) {
    const prior = authority.takeoverBindings;
    if (prior === undefined || !bindingsEqual(prior, journalBindings)) return fail("lost-lock", "Journal lock generation does not match this lease or its complete proven takeover evidence");
  }
  for (const lock of authority.held) {
    try {
      const owner = await readOwner(lock.directory); const stat = await fs.lstat(lock.directory, { bigint: true });
      if (!owner.ok || !bindingsEqual([binding(owner.value)], [binding(lock.owner)]) || owner.value.operationId !== operationId || !sameIdentity(lock.directoryIdentity, stat)) throw new Error("changed");
    } catch { return fail("lost-lock", "Lifecycle lock ownership changed; mutation must stop"); }
  }
  return { ok: true, value: undefined };
}

export async function heartbeatLifecycleLocks(lease: LifecycleLockLease): Promise<StoreResult<void>> {
  const authority = leases.get(lease); if (authority === undefined || authority.released) return fail("invalid-lease", "Lifecycle lock lease is not owned by this process");
  const valid = await validateLifecycleLockLease(authority.store, lease, lease.operationId); if (!valid.ok) return valid;
  try {
    for (const lock of authority.held) {
      const current = await readOwner(lock.directory); if (!current.ok) throw new Error("changed");
      const next: LockOwner = Object.freeze({ ...current.value, heartbeatAt: new Date().toISOString() });
      const bytes = canonicalJsonBytes(next, 16 * 1024); if (!bytes.ok) throw new Error(bytes.message);
      const temporary = `${ownerPath(lock.directory)}.heartbeat-${randomBytes(8).toString("hex")}`;
      const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await handle.writeFile(bytes.value); await handle.sync(); } finally { await handle.close(); }
      let renamed = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try { await fs.rename(temporary, ownerPath(lock.directory)); renamed = true; break; }
        catch (error) { if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; await new Promise<void>((resolve) => setTimeout(resolve, attempt + 1)); }
      }
      if (!renamed) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw new Error("heartbeat replacement failed"); }
    }
    return validateLifecycleLockLease(authority.store, lease, lease.operationId);
  } catch { return fail("lost-lock", "Lifecycle lock heartbeat could not preserve ownership"); }
}

export async function releaseLifecycleLocks(lease: LifecycleLockLease): Promise<StoreResult<void>> {
  const authority = leases.get(lease); if (authority === undefined || authority.released) return fail("invalid-lease", "Lifecycle lock lease is not owned by this process");
  const valid = await validateLifecycleLockLease(authority.store, lease, lease.operationId);
  authority.released = true; leases.delete(lease);
  if (!valid.ok) return valid;
  return await releaseHeld(authority.held) ? { ok: true, value: undefined } : fail("release-uncertain", "Lock release was incomplete; retained ownership evidence requires inspection");
}

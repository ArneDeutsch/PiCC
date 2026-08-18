import { promises as fs } from "node:fs";
import {
  canRollbackZeroPrefix, completeJournal, completedGenerationId, inspectDeletionEvidence, persistReconciledJournal, readTransactionJournal, readTransactionReceipt,
  rollbackJournal, revalidatePersistedTransaction, type TransactionCodecRegistry, type TransactionFaultSeam,
  type TransactionJournal, type TransactionReceipt,
} from "./transaction.js";
import { lockIdentitiesEqual, validateLifecycleLockLease, type LifecycleLockLease } from "./locks.js";
import { revalidateOwnedStateStore, type OwnedStateStore, type StoreResult } from "./state-store.js";

export interface RecoveryPreview {
  readonly operationId: string;
  readonly producerSchema: string;
  readonly producerVersion: number;
  readonly confirmationSummary: unknown;
  readonly confirmationDigest: string;
  readonly planDigest: string;
  readonly completed: number;
  readonly rolledBack: number;
  readonly remaining: number;
  readonly actions: readonly ("complete" | "rollback")[];
  readonly terminalOutcome?: TransactionReceipt["outcome"];
  readonly failureCategory?: TransactionReceipt["failureCategory"];
  readonly generationId?: string;
}
function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function terminalCodecValid(receipt: TransactionReceipt, codec: NonNullable<ReturnType<TransactionCodecRegistry["lookup"]>>): boolean {
  const locks = codec.requiredLocks(receipt.confirmationSummary, receipt.participants);
  return codec.schema === receipt.producerSchema && codec.version === receipt.producerVersion && codec.validatePlan(receipt.participants).ok
    && locks.ok && lockIdentitiesEqual(locks.value, receipt.requiredLocks);
}

async function validatedJournal(inputs: { readonly store: OwnedStateStore; readonly operationId: string; readonly registry: TransactionCodecRegistry }): Promise<StoreResult<{ readonly journal: TransactionJournal; readonly codec: NonNullable<ReturnType<TransactionCodecRegistry["lookup"]>> }>> {
  const validStore = await revalidateOwnedStateStore(inputs.store); if (!validStore.ok) return validStore;
  const persisted = await readTransactionJournal(inputs.store, inputs.operationId); if (!persisted.ok) return persisted;
  const codec = inputs.registry.lookup(persisted.value.producerSchema, persisted.value.producerVersion);
  if (codec === undefined) return fail("unknown-producer", "Pending operation producer is unavailable; recovery remains inert");
  const valid = await revalidatePersistedTransaction(inputs.store, persisted.value, codec); return valid.ok ? { ok: true, value: { journal: persisted.value, codec } } : valid;
}

export async function previewRecovery(inputs: { readonly store: OwnedStateStore; readonly operationId: string; readonly registry: TransactionCodecRegistry }): Promise<StoreResult<RecoveryPreview>> {
  const receipt = await readTransactionReceipt(inputs.store, inputs.operationId); if (!receipt.ok) return receipt;
  if (receipt.value !== undefined) {
    const codec = inputs.registry.lookup(receipt.value.producerSchema, receipt.value.producerVersion);
    const decoded = codec?.decodeSummary(receipt.value.confirmationSummary);
    if (codec === undefined || decoded === undefined || !decoded.ok || !terminalCodecValid(receipt.value, codec)) return fail("unknown-producer", "Terminal receipt producer is unavailable or invalid; receipt remains inert");
    return { ok: true, value: Object.freeze({ operationId: receipt.value.operationId, producerSchema: receipt.value.producerSchema, producerVersion: receipt.value.producerVersion,
      confirmationSummary: decoded.value, confirmationDigest: receipt.value.confirmationDigest, planDigest: receipt.value.planDigest,
      completed: receipt.value.completed, rolledBack: receipt.value.outcome === "rolled-back" ? receipt.value.participants.length : 0,
      remaining: 0, actions: Object.freeze([]), terminalOutcome: receipt.value.outcome,
      ...(receipt.value.failureCategory === undefined ? {} : { failureCategory: receipt.value.failureCategory }),
      ...(receipt.value.generationId === undefined ? {} : { generationId: receipt.value.generationId }) }) };
  }
  const validated = await validatedJournal(inputs); if (!validated.ok) return validated; const journal = validated.value.journal;
  const decoded = validated.value.codec.decodeSummary(journal.confirmationSummary); if (!decoded.ok) return fail("invalid-summary", "Pending operation summary is invalid");
  const hasCreatedParent = journal.createdParents.some((created) => created !== null);
  const deleteEvidence = await inspectDeletionEvidence(inputs.store, journal); if (!deleteEvidence.ok) return deleteEvidence;
  const hasDeleteMarker = deleteEvidence.value;
  const zeroRollback = journal.completed === 0 && !hasCreatedParent && !hasDeleteMarker ? await canRollbackZeroPrefix(inputs.store, journal) : { ok: true as const, value: false };
  if (!zeroRollback.ok) return zeroRollback;
  return { ok: true, value: Object.freeze({ operationId: journal.operationId, producerSchema: journal.producerSchema, producerVersion: journal.producerVersion,
    confirmationSummary: decoded.value, confirmationDigest: journal.confirmationDigest, planDigest: journal.planDigest,
    completed: journal.completed, rolledBack: journal.rolledBack, remaining: journal.participants.length - journal.completed,
    actions: Object.freeze(journal.state === "rolling-back" ? ["rollback"] as const : journal.completed === 0 && !hasCreatedParent && !hasDeleteMarker ? zeroRollback.value ? ["complete", "rollback"] as const : ["complete"] as const : ["complete", "rollback"] as const),
    ...(completedGenerationId(journal, journal.completed - journal.rolledBack) === undefined ? {} : { generationId: completedGenerationId(journal, journal.completed - journal.rolledBack) }) }) };
}

export async function recoverTransaction(inputs: { readonly store: OwnedStateStore; readonly operationId: string; readonly action: "complete" | "rollback"; readonly confirmedProducerSchema: string; readonly confirmedProducerVersion: number; readonly confirmedPlanDigest: string; readonly confirmedConfirmationDigest: string; readonly registry: TransactionCodecRegistry; readonly lease?: LifecycleLockLease; readonly faults?: TransactionFaultSeam }): Promise<StoreResult<TransactionReceipt>> {
  const existing = await readTransactionReceipt(inputs.store, inputs.operationId); if (!existing.ok) return existing;
  if (existing.value !== undefined) {
    const codec = inputs.registry.lookup(existing.value.producerSchema, existing.value.producerVersion);
    if (codec === undefined || !codec.decodeSummary(existing.value.confirmationSummary).ok || !terminalCodecValid(existing.value, codec)) return fail("unknown-producer", "Terminal receipt producer is unavailable or invalid");
    if (existing.value.producerSchema !== inputs.confirmedProducerSchema || existing.value.producerVersion !== inputs.confirmedProducerVersion
      || existing.value.planDigest !== inputs.confirmedPlanDigest || existing.value.confirmationDigest !== inputs.confirmedConfirmationDigest) return fail("confirmation-mismatch", "Recovery confirmation does not bind the terminal producer and operation");
    return { ok: true, value: existing.value };
  }
  if (inputs.lease === undefined) return fail("invalid-lease", "Explicit recovery requires a live operation-bound lock lease");
  const validated = await validatedJournal(inputs); if (!validated.ok) return validated; const { journal, codec } = validated.value;
  if (journal.producerSchema !== inputs.confirmedProducerSchema || journal.producerVersion !== inputs.confirmedProducerVersion
    || journal.planDigest !== inputs.confirmedPlanDigest || journal.confirmationDigest !== inputs.confirmedConfirmationDigest) return fail("confirmation-mismatch", "Recovery confirmation does not bind the pending producer and operation");
  if (journal.state === "rolling-back" && inputs.action !== "rollback") return fail("invalid-recovery", "Interrupted rollback is rollback-only");
  const deleteEvidence = await inspectDeletionEvidence(inputs.store, journal); if (!deleteEvidence.ok) return deleteEvidence;
  if (inputs.action === "rollback" && journal.completed === 0 && !journal.createdParents.some((created) => created !== null) && !deleteEvidence.value) {
    const allowed = await canRollbackZeroPrefix(inputs.store, journal);
    if (!allowed.ok) return allowed;
    if (!allowed.value) return fail("invalid-recovery", "Zero-prefix rollback requires exact authentic pre-operation state");
  }
  const leaseValid = await validateLifecycleLockLease(inputs.store, inputs.lease, inputs.operationId, journal.lockBindings, journal.requiredLocks); if (!leaseValid.ok) return leaseValid;
  const rebound = await persistReconciledJournal(inputs.store, journal, inputs.lease); if (!rebound.ok) return rebound;
  return inputs.action === "complete"
    ? completeJournal(inputs.store, rebound.value, codec, inputs.lease, inputs.faults)
    : rollbackJournal(inputs.store, rebound.value, codec, inputs.lease, inputs.faults);
}

export async function inspectLifecycleRecovery(store: OwnedStateStore): Promise<StoreResult<readonly { readonly operationId: string; readonly status: "pending" | "invalid" | "terminal-residue" }[]>> {
  try {
    const entries = await fs.readdir(store.journalsRoot); const observations = await Promise.all(entries.filter((name) => /^[A-Za-z0-9_-]{1,128}\.json$/.test(name)).map(async (name) => {
      const operationId = name.slice(0, -5); const receipt = await readTransactionReceipt(store, operationId);
      if (receipt.ok && receipt.value !== undefined) return Object.freeze({ operationId, status: "terminal-residue" as const });
      const journal = await readTransactionJournal(store, operationId); return Object.freeze({ operationId, status: journal.ok ? "pending" as const : "invalid" as const });
    }));
    return { ok: true, value: Object.freeze(observations.sort((a, b) => a.operationId.localeCompare(b.operationId))) };
  } catch { return fail("recovery-inspection", "Lifecycle recovery state could not be inspected"); }
}

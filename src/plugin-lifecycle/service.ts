import { promises as fs } from "node:fs";
import path from "node:path";
import { acquireLifecycleLocks, releaseLifecycleLocks, type LifecycleLockLease, type ProcessOwnershipProbe } from "./locks.js";
import { createTransactionCodecRegistry, executeTransaction, isOwnedDataRetirementParticipant, readTransactionJournal, readTransactionReceipt, type OrdinaryTransactionParticipant, type PreparedTransaction, type TransactionFaultSeam, type TransactionProducerCodec, type TransactionReceipt } from "./transaction.js";
import { previewRecovery, recoverTransaction } from "./recovery.js";
import { canonicalJsonBytes, isContainedPath, type OwnedStateStore, type StoreResult } from "./state-store.js";
import { wrapMarketplaceReceipt, type MarketplaceMutationPreview, type MarketplaceReceipt } from "./planner.js";

export type MarketplaceExecutionResult =
  | { readonly ok: true; readonly value: MarketplaceReceipt & { readonly outcome: "committed" } }
  | { readonly ok: false; readonly code: "mutation-not-committed"; readonly message: string; readonly receipt: MarketplaceReceipt & { readonly outcome: "failed-before-commit" | "rolled-back" } }
  | { readonly ok: false; readonly code: string; readonly message: string };
export interface LifecyclePreparedMutation<TPreview> {
  readonly preview: TPreview;
  readonly execute: (confirmedDigest: string) => Promise<MarketplaceExecutionResult>;
}
export interface MarketplaceRecoveryStatus {
  readonly operationId: string;
  readonly summary: MarketplaceMutationPreview;
  readonly completed: number;
  readonly remaining: number;
  readonly actions: readonly ("complete" | "rollback")[];
  readonly terminalOutcome?: TransactionReceipt["outcome"];
}

function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function executionTruth(receipt: MarketplaceReceipt): MarketplaceExecutionResult {
  if (receipt.outcome === "committed") return { ok: true, value: receipt as MarketplaceReceipt & { readonly outcome: "committed" } };
  return { ok: false, code: "mutation-not-committed", message: receipt.guidance ?? "The marketplace mutation did not commit", receipt: receipt as MarketplaceReceipt & { readonly outcome: "failed-before-commit" | "rolled-back" } };
}
function same(left: unknown, right: unknown): boolean { const a = canonicalJsonBytes(left); const b = canonicalJsonBytes(right); return a.ok && b.ok && Buffer.from(a.value).equals(Buffer.from(b.value)); }
export function receiptMatchesPrepared(receipt: PreparedTransaction, transaction: PreparedTransaction): boolean {
  return receipt.operationId === transaction.operationId && receipt.producerSchema === transaction.producerSchema && receipt.producerVersion === transaction.producerVersion
    && receipt.planDigest === transaction.planDigest && receipt.confirmationDigest === transaction.confirmationDigest
    && same(receipt.confirmationSummary, transaction.confirmationSummary) && same(receipt.participants, transaction.participants)
    && same(receipt.requiredLocks, transaction.requiredLocks);
}
async function discardPrepared(store: OwnedStateStore, transaction: PreparedTransaction): Promise<StoreResult<void>> {
  try {
    const candidates = transaction.participants.filter((participant): participant is OrdinaryTransactionParticipant => !isOwnedDataRetirementParticipant(participant)).flatMap((participant) => [participant.stagedPath, participant.rollback.kind === "restore-backup" ? participant.rollback.path : undefined])
      .filter((candidate): candidate is string => candidate !== undefined && isContainedPath(store.stagingRoot, candidate));
    await Promise.all(candidates.map((candidate) => fs.rm(candidate, { force: true })));
    return { ok: true, value: undefined };
  } catch { return fail("cleanup-failure", "Stale marketplace preparation cleanup could not be confirmed"); }
}
export class MarketplaceTransactionService {
  readonly #store: OwnedStateStore;
  readonly #codec: TransactionProducerCodec<MarketplaceMutationPreview>;
  readonly #faults?: TransactionFaultSeam;
  readonly #fresh?: (preview: MarketplaceMutationPreview) => Promise<StoreResult<void>>;
  readonly #terminal?: (operationId: string) => void;
  readonly #processProbe?: ProcessOwnershipProbe;
  readonly #beforeTransactionExecution?: () => void | Promise<void>;
  readonly #pendingLeases = new Map<string, LifecycleLockLease>();
  constructor(inputs: { readonly store: OwnedStateStore; readonly codec: TransactionProducerCodec<MarketplaceMutationPreview>; readonly faults?: TransactionFaultSeam; readonly fresh?: (preview: MarketplaceMutationPreview) => Promise<StoreResult<void>>; readonly terminal?: (operationId: string) => void; readonly processProbe?: ProcessOwnershipProbe; readonly beforeTransactionExecution?: () => void | Promise<void> }) {
    this.#store = inputs.store; this.#codec = inputs.codec; this.#faults = inputs.faults; this.#fresh = inputs.fresh; this.#terminal = inputs.terminal; this.#processProbe = inputs.processProbe; this.#beforeTransactionExecution = inputs.beforeTransactionExecution;
  }

  bind(preview: MarketplaceMutationPreview, transaction: PreparedTransaction): StoreResult<LifecyclePreparedMutation<MarketplaceMutationPreview>> {
    const decoded = this.#codec.decodeSummary(preview);
    if (!decoded.ok || transaction.operationId !== preview.operationId || transaction.producerSchema !== this.#codec.schema || transaction.producerVersion !== this.#codec.version
      || !same(transaction.confirmationSummary, preview)) return fail("invalid-preparation", "Prepared transaction does not bind the exact marketplace preview");
    return { ok: true, value: Object.freeze({ preview: decoded.value, execute: (confirmedDigest: string) => confirmedDigest === preview.confirmationDigest
      ? this.execute(transaction, decoded.value)
      : Promise.resolve(fail("confirmation-mismatch", "Confirmation does not bind the complete marketplace preview")) }) };
  }

  async execute(transaction: PreparedTransaction, preview: MarketplaceMutationPreview): Promise<MarketplaceExecutionResult> {
    const existing = await readTransactionReceipt(this.#store, transaction.operationId);
    if (!existing.ok) return existing;
    if (existing.value !== undefined) {
      if (!receiptMatchesPrepared(existing.value, transaction)) return fail("operation-id-mismatch", "This operation id is terminal for a different marketplace plan");
      const wrapped = wrapMarketplaceReceipt(existing.value, this.#codec);
      if (!wrapped.ok) return wrapped;
      const discarded = await discardPrepared(this.#store, transaction); if (!discarded.ok) return discarded;
      this.#terminal?.(transaction.operationId); return executionTruth(wrapped.value);
    }
    const lease = await acquireLifecycleLocks({ store: this.#store, operationId: transaction.operationId, identities: transaction.requiredLocks });
    if (!lease.ok) return lease;
    let retainLease = false;
    try {
      if (this.#fresh !== undefined) {
        const fresh = await this.#fresh(preview);
        if (!fresh.ok) return fresh;
      }
      await this.#beforeTransactionExecution?.();
      const outcome = await executeTransaction(this.#store, transaction, { lease: lease.value, ...(this.#faults === undefined ? {} : { faults: this.#faults }) });
      if (outcome.state === "committed" || outcome.state === "rolled-back" || outcome.state === "failed-before-commit") { const wrapped = wrapMarketplaceReceipt(outcome.receipt, this.#codec); if (!wrapped.ok) return wrapped; this.#terminal?.(transaction.operationId); return executionTruth(wrapped.value); }
      if (outcome.state === "pending-recovery") {
        const sameJournal = await readTransactionJournal(this.#store, transaction.operationId);
        if (sameJournal.ok && receiptMatchesPrepared(sameJournal.value, transaction)) {
          retainLease = true; this.#pendingLeases.set(transaction.operationId, lease.value);
          return fail("pending-recovery", `Marketplace operation ${outcome.operationId} is pending; call recoveryStatus(${JSON.stringify(outcome.operationId)}) and then recover with one of its feasible actions`);
        }
        try {
          await fs.lstat(path.join(this.#store.journalsRoot, `${transaction.operationId}.json`));
          return fail("operation-evidence-uncertain", "This operation's journal identity is invalid or uncertain; preserve its evidence and inspect recovery status before any further mutation");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("operation-evidence-uncertain", "This operation's journal identity is uncertain; preserve its evidence and inspect recovery status before any further mutation");
        }
        return fail("another-operation-pending", "Another profile operation became pending after this preview was checked; resolve that operation, then retry this still-bound preparation or cancel it");
      }
      return fail("transaction-rejected", "Marketplace transaction was rejected; re-preview the current state");
    } finally { if (!retainLease) await releaseLifecycleLocks(lease.value); }
  }

  async recoveryStatus(operationId: string): Promise<StoreResult<MarketplaceRecoveryStatus>> {
    const registry = createTransactionCodecRegistry([this.#codec]); if (!registry.ok) return registry;
    const recovery = await previewRecovery({ store: this.#store, operationId, registry: registry.value }); if (!recovery.ok) return recovery;
    const summary = this.#codec.decodeSummary(recovery.value.confirmationSummary); if (!summary.ok) return summary;
    return { ok: true, value: Object.freeze({ operationId, summary: summary.value, completed: recovery.value.completed, remaining: recovery.value.remaining,
      actions: recovery.value.actions, ...(recovery.value.terminalOutcome === undefined ? {} : { terminalOutcome: recovery.value.terminalOutcome }) }) };
  }

  async recover(operationId: string, action: "complete" | "rollback"): Promise<StoreResult<MarketplaceReceipt>> {
    const registry = createTransactionCodecRegistry([this.#codec]); if (!registry.ok) return registry;
    const terminal = await readTransactionReceipt(this.#store, operationId); if (!terminal.ok) return terminal;
    if (terminal.value !== undefined) { const wrapped = wrapMarketplaceReceipt(terminal.value, this.#codec); if (wrapped.ok) this.#terminal?.(operationId); return wrapped; }
    const recovery = await previewRecovery({ store: this.#store, operationId, registry: registry.value }); if (!recovery.ok) return recovery;
    if (!recovery.value.actions.includes(action)) return fail("invalid-recovery", `Selected recovery action is unavailable; feasible actions: ${recovery.value.actions.join(", ") || "none (operation is terminal)"}`);
    const journal = await readTransactionJournal(this.#store, operationId); if (!journal.ok) return journal;
    const retained = this.#pendingLeases.get(operationId); const lease = retained === undefined
      ? await acquireLifecycleLocks({ store: this.#store, operationId, identities: journal.value.requiredLocks, expectedRecoveryOperationId: operationId, ...(this.#processProbe === undefined ? {} : { processProbe: this.#processProbe }) })
      : { ok: true as const, value: retained };
    if (!lease.ok) return lease;
    try {
      const receipt = await recoverTransaction({ store: this.#store, operationId, action, confirmedProducerSchema: recovery.value.producerSchema,
        confirmedProducerVersion: recovery.value.producerVersion, confirmedPlanDigest: recovery.value.planDigest, confirmedConfirmationDigest: recovery.value.confirmationDigest,
        registry: registry.value, lease: lease.value });
      if (!receipt.ok) return receipt; const wrapped = wrapMarketplaceReceipt(receipt.value, this.#codec); if (wrapped.ok) this.#terminal?.(operationId); return wrapped;
    } finally { this.#pendingLeases.delete(operationId); await releaseLifecycleLocks(lease.value); }
  }

  async receipt(operationId: string): Promise<StoreResult<MarketplaceReceipt | undefined>> {
    const receipt = await readTransactionReceipt(this.#store, operationId); if (!receipt.ok || receipt.value === undefined) return receipt as StoreResult<MarketplaceReceipt | undefined>;
    const wrapped = wrapMarketplaceReceipt(receipt.value, this.#codec); if (wrapped.ok) this.#terminal?.(operationId); return wrapped;
  }
}

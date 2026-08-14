import { previewRecovery, recoverTransaction, type RecoveryPreview } from "./recovery.js";
import { acquireLifecycleLocks, releaseLifecycleLocks, type ProcessOwnershipProbe } from "./locks.js";
import type { OwnedMarketplaceSnapshotRecord } from "./admission.js";
import { decodePluginReceipt, pluginLifecycleProducerRegistry, pluginLifecycleTransactionRegistry, type PluginReceipt } from "./plugin-service.js";
import { readTransactionJournal, readTransactionReceipt, type TransactionReceipt } from "./transaction.js";
import type { OwnedStateStore, ProducerCodecRegistry, StoreResult } from "./state-store.js";
import type { TransactionCodecRegistry } from "./transaction.js";

export interface TrustedLifecycleRegistry {
  readonly producers: ProducerCodecRegistry;
  readonly transactions: TransactionCodecRegistry;
}

export function createTrustedLifecycleRegistry(
  store: OwnedStateStore,
  snapshots: readonly OwnedMarketplaceSnapshotRecord[],
): StoreResult<TrustedLifecycleRegistry> {
  const producers = pluginLifecycleProducerRegistry(store, snapshots); if (!producers.ok) return producers;
  const transactions = pluginLifecycleTransactionRegistry(store, snapshots); if (!transactions.ok) return transactions;
  return { ok: true, value: Object.freeze({ producers: producers.value, transactions: transactions.value }) };
}

export class LifecycleRecoveryService {
  readonly #store: OwnedStateStore; readonly #registry: TransactionCodecRegistry; readonly #probe?: ProcessOwnershipProbe; readonly #snapshots: readonly OwnedMarketplaceSnapshotRecord[];
  constructor(inputs: { readonly store: OwnedStateStore; readonly snapshots: readonly OwnedMarketplaceSnapshotRecord[]; readonly processOwnershipProbe?: ProcessOwnershipProbe }) {
    const registry = createTrustedLifecycleRegistry(inputs.store, inputs.snapshots);
    if (!registry.ok) throw new Error(`Trusted lifecycle registry unavailable: ${registry.code}`);
    this.#store = inputs.store; this.#registry = registry.value.transactions; this.#probe = inputs.processOwnershipProbe; this.#snapshots = Object.freeze([...inputs.snapshots]);
  }
  preview(operationId: string): Promise<StoreResult<RecoveryPreview>> { return previewRecovery({ store: this.#store, operationId, registry: this.#registry }); }
  async recover(operationId: string, action: "complete" | "rollback"): Promise<StoreResult<TransactionReceipt | PluginReceipt>> {
    const existing = await readTransactionReceipt(this.#store, operationId); if (!existing.ok) return existing; if (existing.value !== undefined) return existing.value.producerSchema === "plugin-lifecycle" ? decodePluginReceipt(this.#store, this.#snapshots, existing.value) : existing as StoreResult<TransactionReceipt>;
    const preview = await this.preview(operationId); if (!preview.ok) return preview;
    if (!preview.value.actions.includes(action)) return { ok: false, code: "invalid-recovery", message: "Selected recovery action is unavailable for this exact operation" };
    const journal = await readTransactionJournal(this.#store, operationId); if (!journal.ok) return journal;
    const lease = await acquireLifecycleLocks({ store: this.#store, operationId, identities: journal.value.requiredLocks, expectedRecoveryOperationId: operationId, ...(this.#probe === undefined ? {} : { processProbe: this.#probe }) }); if (!lease.ok) return lease;
    try { const recovered = await recoverTransaction({ store: this.#store, operationId, action, confirmedProducerSchema: preview.value.producerSchema, confirmedProducerVersion: preview.value.producerVersion, confirmedPlanDigest: preview.value.planDigest, confirmedConfirmationDigest: preview.value.confirmationDigest, registry: this.#registry, lease: lease.value }); if (!recovered.ok || recovered.value.producerSchema !== "plugin-lifecycle") return recovered; return decodePluginReceipt(this.#store, this.#snapshots, recovered.value); }
    finally { await releaseLifecycleLocks(lease.value); }
  }
}

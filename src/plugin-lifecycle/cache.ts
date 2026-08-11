import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { revalidateOwnedStateStore, verifyArtifact, type OwnedStateStore, type StoreResult } from "./state-store.js";
import type { Sha256 } from "./types.js";

export const DEFAULT_ARTIFACT_GRACE_MS = 24 * 60 * 60 * 1000;
export type CacheCleanupFaultPhase = "before-quarantine" | "after-quarantine" | "before-remove" | "after-remove";
export interface CacheCleanupFaultSeam { readonly hit: (phase: CacheCleanupFaultPhase, digest: Sha256, selectedPath: string) => void | Promise<void> }
const NO_FAULTS: CacheCleanupFaultSeam = Object.freeze({ hit: () => undefined });
export interface CacheCleanupResult { readonly removed: readonly Sha256[]; readonly retainedReferenced: number; readonly retainedGrace: number; readonly retainedUncertain: number; readonly quarantinedInvalid: number }

export async function cleanupOwnedArtifactCache(inputs: {
  readonly store: OwnedStateStore;
  readonly referencedDigests?: ReadonlySet<Sha256>;
  readonly activeSessionDigests?: ReadonlySet<Sha256>;
  readonly importedDigests?: ReadonlySet<Sha256>;
  readonly referenceStateCertain: boolean;
  readonly now?: number;
  readonly graceMs?: number;
  readonly faults?: CacheCleanupFaultSeam;
}): Promise<StoreResult<CacheCleanupResult>> {
  const valid = await revalidateOwnedStateStore(inputs.store); if (!valid.ok) return valid;
  const removed: Sha256[] = []; let retainedReferenced = 0; let retainedGrace = 0; let retainedUncertain = 0; let quarantinedInvalid = 0; const faults = inputs.faults ?? NO_FAULTS;
  try {
    for (const name of await fs.readdir(inputs.store.artifactsRoot)) {
      if (!/^[a-f0-9]{64}$/.test(name)) { retainedUncertain += 1; continue; }
      const digest = `sha256:${name}` as Sha256; const artifact = path.join(inputs.store.artifactsRoot, name);
      if (!inputs.referenceStateCertain || inputs.referencedDigests === undefined) { retainedUncertain += 1; continue; }
      if (inputs.importedDigests?.has(digest) === true) { retainedUncertain += 1; continue; }
      if (inputs.referencedDigests.has(digest) || inputs.activeSessionDigests?.has(digest) === true) { retainedReferenced += 1; continue; }
      const stat = await fs.lstat(artifact, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !await verifyArtifact(artifact, digest)) {
        const quarantine = path.join(inputs.store.quarantineRoot, `invalid-artifact-${name}-${randomBytes(8).toString("hex")}`);
        try { await faults.hit("before-quarantine", digest, quarantine); await fs.rename(artifact, quarantine); await faults.hit("after-quarantine", digest, quarantine); quarantinedInvalid += 1; }
        catch {
          const sourceExists = await fs.lstat(artifact).then(() => true, () => false);
          const quarantineExists = await fs.lstat(quarantine).then(() => true, () => false);
          if (!sourceExists && quarantineExists) quarantinedInvalid += 1;
          else retainedUncertain += 1;
        }
        continue;
      }
      const age = (inputs.now ?? Date.now()) - Number(stat.mtimeMs);
      if (!Number.isFinite(age) || age < 0) { retainedUncertain += 1; continue; }
      if (age < (inputs.graceMs ?? DEFAULT_ARTIFACT_GRACE_MS)) { retainedGrace += 1; continue; }
      try { await faults.hit("before-remove", digest, artifact); await fs.rm(artifact, { recursive: true }); await faults.hit("after-remove", digest, artifact); removed.push(digest); }
      catch {
        if (!await fs.lstat(artifact).then(() => true, () => false)) removed.push(digest);
        else retainedUncertain += 1;
      }
    }
    return { ok: true, value: Object.freeze({ removed: Object.freeze(removed), retainedReferenced, retainedGrace, retainedUncertain, quarantinedInvalid }) };
  } catch { return { ok: false, code: "cleanup-io", message: "Owned artifact cleanup stopped conservatively" }; }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMcpLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { canonicalJsonBytes, establishOwnedStateStore, sha256 } from "../src/plugin-lifecycle/state-store.js";
import { inspectMcpPendingOperation, persistMcpMutation } from "../src/mcp-administration/persistence.js";
import type { TransactionFaultPhase } from "../src/plugin-lifecycle/transaction.js";
import { acquireLifecycleLocks, releaseLifecycleLocks } from "../src/plugin-lifecycle/locks.js";

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-mcp-transaction-")); const home = path.join(root, "home"); const project = path.join(root, "project");
  fs.mkdirSync(home); fs.mkdirSync(project); const profile = path.join(home, ".claude.json"); fs.writeFileSync(profile, "{}\n");
  const locations = createMcpLifecycleLocations({ homeDir: home, profilePath: profile, platform: process.platform === "win32" ? "win32" : "posix",
    project: { activeCheckoutPath: project, checkoutFamilyPath: project } }); if (!locations.ok || !locations.value.checkoutFamilyKey) throw new Error("locations");
  const store = await establishOwnedStateStore(locations.value, home); if (!store.ok) throw new Error(store.message);
  const authorityFingerprint = `sha256:${"c".repeat(64)}`;
  return { root, store: store.value, context: { store: store.value, profilePath: profile, projectRoot: project, checkoutFamilyKey: locations.value.checkoutFamilyKey,
    authorityFingerprint, identifyProject: () => [fs.realpathSync.native(project)], processOwnershipProbe: { observe: async () => ({ state: "absent" as const }) }, revalidateAuthority: () => ({ ok: true as const, value: { profileKey: store.value.profileKey, checkoutFamilyKey: locations.value.checkoutFamilyKey!, authorityFingerprint } }) } };
}

function reboundPlanDigest(value: { participants: Record<string, unknown>[]; requiredLocks: unknown[] }): string {
  const participants = value.participants.map((entry) => ({ kind: entry.kind, ...(entry.effect === undefined ? {} : { effect: entry.effect }), key: entry.key, ownerKey: entry.ownerKey, scopeKey: entry.scopeKey, targetPath: entry.targetPath, targetClass: entry.targetClass, precondition: entry.precondition, stagedPath: entry.stagedPath, stagedDigest: entry.stagedDigest, rollback: entry.rollback, producerEvidence: entry.producerEvidence, targetEvidence: entry.targetEvidence, stagedEvidence: entry.stagedEvidence, ...(entry.backupEvidence === undefined ? {} : { backupEvidence: entry.backupEvidence }) }));
  const encoded = canonicalJsonBytes({ participants, requiredLocks: value.requiredLocks }); if (!encoded.ok) throw new Error(encoded.message); return sha256(encoded.value);
}

describe("MCP transaction taxonomy", () => {
  it("reports committed state and leaves no pending journal", async () => {
    const f = await setup(); try {
      for (const name of ["broad name__authenticated", "__proto__"]) {
        const result = await persistMcpMutation(f.context, { kind: "set-declaration", scope: "user", name, definition: { command: "run" } });
        expect(result, name).toMatchObject({ state: "committed", retrySafe: false }); const servers = (JSON.parse(fs.readFileSync(f.context.profilePath, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers; expect(Object.hasOwn(servers, name)).toBe(true);
      }
      expect(await inspectMcpPendingOperation(f.store)).toEqual({ pending: false, status: "clear" });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it("classifies each one-participant publication fault and automatically rolls pending work back before a new write", async () => {
    const rows: readonly { phase: TransactionFaultPhase; immediate: "failed-before-commit" | "pending-recovery" | "committed"; published: boolean }[] = [
      { phase: "before-journal", immediate: "failed-before-commit", published: false }, { phase: "after-journal", immediate: "failed-before-commit", published: false },
      { phase: "before-temp-write", immediate: "failed-before-commit", published: false }, { phase: "after-temp-write", immediate: "failed-before-commit", published: false },
      { phase: "after-flush", immediate: "failed-before-commit", published: false }, { phase: "before-replacement", immediate: "failed-before-commit", published: false },
      { phase: "after-replacement", immediate: "pending-recovery", published: true }, { phase: "before-receipt", immediate: "pending-recovery", published: true },
      { phase: "after-receipt", immediate: "committed", published: true }, { phase: "before-retirement", immediate: "committed", published: true }, { phase: "after-retirement", immediate: "committed", published: true },
    ];
    for (const row of rows) {
      const f = await setup(); try {
        let fired = false; const result = await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "requested", definition: { command: "run" } }, { faults: { hit(phase) { if (!fired && phase === row.phase) { fired = true; throw new Error("injected"); } } } });
        expect(fired, row.phase).toBe(true);
        const actualOperationId = "operationId" in result ? result.operationId : undefined; const operationId = expect.stringMatching(/^mcp_[a-f0-9]{32}$/);
        const expectedTuple = row.immediate === "pending-recovery"
          ? { state: "pending-recovery", operationId, effect: "uncertain", retrySafe: false, cleanup: "pending", reasonCode: "pending-recovery", reason: "MCP rollback remains pending and blocks new writes" }
          : row.immediate === "committed"
            ? { state: "committed", operationId, effect: "changed", retrySafe: false, cleanup: "complete" }
            : { state: "failed-before-commit", operationId, effect: "unchanged", retrySafe: true, cleanup: "complete", reasonCode: "storage-failure", reason: "MCP persistence storage failed before a durable result" };
        expect(result, row.phase).toEqual(expectedTuple);
        const target = path.join(f.context.projectRoot, ".mcp.json"); const expectedBytes = '{\n  "mcpServers": {\n    "requested": {\n      "command": "run"\n    }\n  }\n}\n'; expect(fs.existsSync(target), row.phase).toBe(row.published); if (row.published) expect(fs.readFileSync(target), row.phase).toEqual(Buffer.from(expectedBytes));
        const journals = fs.readdirSync(f.store.journalsRoot); const receipts = fs.readdirSync(f.store.receiptsRoot); const staging = fs.readdirSync(f.store.stagingRoot);
        expect(journals, row.phase).toHaveLength(row.immediate === "pending-recovery" || row.phase === "before-retirement" ? 1 : 0); expect(receipts, row.phase).toHaveLength(row.immediate === "pending-recovery" ? 0 : 1); expect(staging, row.phase).toHaveLength(row.immediate === "pending-recovery" ? 1 : 0);
        expect(await inspectMcpPendingOperation(f.store), row.phase).toEqual(row.immediate === "pending-recovery" ? { pending: true, status: "pending", operationId: actualOperationId } : { pending: false, status: "clear" });
        if (receipts.length === 1) { const receipt = JSON.parse(fs.readFileSync(path.join(f.store.receiptsRoot, receipts[0]!), "utf8")) as { outcome: string; completed: number; failureCategory?: string }; expect(receipt, row.phase).toMatchObject(row.immediate === "committed" ? { outcome: "committed", completed: 1 } : { outcome: "failed-before-commit", completed: 0, failureCategory: "storage-failure" }); }
        if (row.immediate === "pending-recovery") {
          const recovered = await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "must-not-write", definition: { command: "other" } });
          expect(recovered, row.phase).toEqual({ state: "rolled-back", operationId: actualOperationId, effect: "unchanged", retrySafe: true, cleanup: "complete" }); expect(fs.existsSync(target)).toBe(false);
          expect(fs.readdirSync(f.store.journalsRoot), row.phase).toEqual([]); expect(fs.readdirSync(f.store.stagingRoot), row.phase).toEqual([]); const recoveredReceipts = fs.readdirSync(f.store.receiptsRoot); expect(recoveredReceipts, row.phase).toHaveLength(1); expect(JSON.parse(fs.readFileSync(path.join(f.store.receiptsRoot, recoveredReceipts[0]!), "utf8")), row.phase).toMatchObject({ outcome: "rolled-back", completed: 0 }); expect(await inspectMcpPendingOperation(f.store), row.phase).toEqual({ pending: false, status: "clear" });
        }
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    }
  });

  it("keeps rollback-only recovery pending when rollback publication faults", async () => {
    const f = await setup(); try {
      expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "first", definition: { command: "run" } }, { faults: { hit(phase) { if (phase === "after-replacement") throw new Error("pending"); } } })).toMatchObject({ state: "pending-recovery" });
      const result = await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "second", definition: { command: "other" } }, { faults: { hit(phase) { if (phase === "before-replacement") throw new Error("rollback-fault"); } } });
      const target = path.join(f.context.projectRoot, ".mcp.json"); expect(result).toMatchObject({ state: "pending-recovery", effect: "uncertain", retrySafe: false, cleanup: "pending", reasonCode: "pending-recovery" }); if (result.state !== "pending-recovery") throw new Error("pending recovery expected"); expect(fs.readFileSync(target, "utf8")).not.toContain("second"); expect(await inspectMcpPendingOperation(f.store)).toMatchObject({ pending: true, operationId: result.operationId });
      const stillPending = await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "third-blocked", definition: { command: "other" } }, { faults: { hit(phase) { if (phase === "before-replacement") throw new Error("rollback-fault-again"); } } }); expect(stillPending).toMatchObject({ state: "pending-recovery", operationId: result.operationId, effect: "uncertain", cleanup: "pending", retrySafe: false }); expect(fs.readFileSync(target, "utf8")).not.toContain("third-blocked");
      expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "fourth-blocked", definition: { command: "other" } })).toEqual({ state: "rolled-back", operationId: result.operationId, effect: "unchanged", cleanup: "complete", retrySafe: true }); expect(fs.existsSync(target)).toBe(false);
      expect(fs.readdirSync(f.store.journalsRoot)).toEqual([]); expect(fs.readdirSync(f.store.stagingRoot)).toEqual([]); const receipts = fs.readdirSync(f.store.receiptsRoot); expect(receipts).toHaveLength(1); expect(JSON.parse(fs.readFileSync(path.join(f.store.receiptsRoot, receipts[0]!), "utf8"))).toMatchObject({ outcome: "rolled-back", completed: 0 }); expect(await inspectMcpPendingOperation(f.store)).toEqual({ pending: false, status: "clear" });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it("blocks before authority validation when the journal root is unreadable", async () => {
    const f = await setup(); try {
      const target = path.join(f.context.projectRoot, ".mcp.json"); const profileBefore = fs.readFileSync(f.context.profilePath); const recordsBefore = fs.readdirSync(f.store.recordsRoot); const locksBefore = fs.readdirSync(f.store.locksRoot); fs.rmSync(f.store.journalsRoot, { recursive: true }); fs.writeFileSync(f.store.journalsRoot, "not-a-directory");
      let authorityCalls = 0; const context = { ...f.context, revalidateAuthority: () => { authorityCalls += 1; return f.context.revalidateAuthority(); } };
      expect(await persistMcpMutation(context, { kind: "set-declaration", scope: "project", name: "blocked", definition: { command: "run" } })).toEqual({ state: "pending-recovery", operationId: "unknown", effect: "uncertain", cleanup: "pending", retrySafe: false, reasonCode: "pending-recovery", reason: "MCP rollback remains pending and blocks new writes" });
      expect(authorityCalls).toBe(0); expect(fs.existsSync(target)).toBe(false); expect(fs.readFileSync(f.context.profilePath)).toEqual(profileBefore); expect(fs.readdirSync(f.store.recordsRoot)).toEqual(recordsBefore); expect(fs.readdirSync(f.store.locksRoot)).toEqual(locksBefore); expect(fs.readdirSync(f.store.stagingRoot)).toEqual([]); expect(fs.readdirSync(f.store.receiptsRoot)).toEqual([]);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it("projects pending recovery before rejecting changed invocation authority", async () => {
    const f = await setup(); try {
      const pending = await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "first", definition: { command: "run" } }, { faults: { hit(phase) { if (phase === "after-replacement") throw new Error("pending"); } } }); expect(pending).toMatchObject({ state: "pending-recovery" }); if (pending.state !== "pending-recovery") throw new Error("pending operation expected");
      const invalid = { ...f.context, authorityFingerprint: "invalid", revalidateAuthority: () => ({ ok: false as const, code: "invalid", message: "invalid" }) };
      expect(await persistMcpMutation(invalid, { kind: "remove-declaration", scope: "project", name: "first" })).toEqual({ state: "pending-recovery", operationId: pending.operationId, effect: "uncertain", cleanup: "pending", retrySafe: false, reasonCode: "pending-recovery", reason: "MCP rollback remains pending and blocks new writes" });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it("keeps a digest-rebound staged payload inert when it changes an unrelated field", async () => {
    const f = await setup(); try {
      const pending = await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "safe", definition: { command: "run" } }, { faults: { hit(phase) { if (phase === "after-replacement") throw new Error("pending"); } } }); expect(pending).toMatchObject({ state: "pending-recovery" }); if (pending.state !== "pending-recovery") throw new Error("pending expected");
      const journalPath = path.join(f.store.journalsRoot, `${pending.operationId}.json`); const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { participants: Record<string, unknown>[]; requiredLocks: unknown[]; planDigest: string };
      const participant = journal.participants[0]!; const stagedPath = participant.stagedPath as string; const hostile = Buffer.from('{\n  "mcpServers": {\n    "safe": {\n      "command": "run"\n    }\n  },\n  "unrelated": true\n}\n'); fs.writeFileSync(stagedPath, hostile); participant.stagedDigest = sha256(hostile); (participant.stagedEvidence as Record<string, unknown>).digest = sha256(hostile); journal.planDigest = reboundPlanDigest(journal); const encoded = canonicalJsonBytes(journal); if (!encoded.ok) throw new Error(encoded.message); fs.writeFileSync(journalPath, encoded.value);
      expect(await persistMcpMutation(f.context, { kind: "remove-declaration", scope: "project", name: "safe" })).toMatchObject({ state: "pending-recovery", operationId: pending.operationId, effect: "uncertain", retrySafe: false }); const target = fs.readFileSync(path.join(f.context.projectRoot, ".mcp.json"), "utf8"); expect(target).not.toContain("unrelated");
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "win32")("revalidates authority on Windows sharing retries and totalizes exhaustion", async () => {
    for (const exhaust of [false, true]) {
      const f = await setup(); const target = path.join(f.context.projectRoot, ".mcp.json"); const original = fs.promises.rename.bind(fs.promises); let attempts = 0; let authorityCalls = 0; const context = { ...f.context, revalidateAuthority: () => { authorityCalls += 1; return f.context.revalidateAuthority(); } };
      const spy = vi.spyOn(fs.promises, "rename").mockImplementation(async (source, destination) => { if (destination === target) { attempts += 1; if (exhaust || attempts <= 2) { const error = new Error("sharing") as NodeJS.ErrnoException; error.code = "EPERM"; throw error; } } return original(source, destination); });
      try { const result = await persistMcpMutation(context, { kind: "set-declaration", scope: "project", name: "safe", definition: { command: "run" } }); expect(result).toMatchObject(exhaust ? { state: "failed-before-commit", effect: "unchanged", retrySafe: true } : { state: "committed", effect: "changed" }); expect(attempts).toBe(exhaust ? 50 : 3); expect(authorityCalls).toBeGreaterThan(exhaust ? 49 : 2); expect(fs.existsSync(target)).toBe(!exhaust); }
      finally { spy.mockRestore(); fs.rmSync(f.root, { recursive: true, force: true }); }
    }
  });

  it("reports an exact unchanged busy result while the canonical lock vector is held", async () => {
    const f = await setup(); const operationId = "blocking-operation"; const identities = [{ kind: "profile" as const, key: f.store.profileKey }, { kind: "checkout" as const, key: f.context.checkoutFamilyKey }, { kind: "settings" as const, key: path.join(f.context.projectRoot, ".mcp.json") }]; const held = await acquireLifecycleLocks({ store: f.store, operationId, identities }); if (!held.ok) throw new Error(held.message);
    try { const busyContext = { ...f.context, processOwnershipProbe: { observe: async () => ({ state: "live" as const }) } }; expect(await persistMcpMutation(busyContext, { kind: "set-declaration", scope: "project", name: "blocked", definition: { command: "run" } })).toMatchObject({ state: "busy", effect: "unchanged", cleanup: "complete", retrySafe: true, reasonCode: "busy" }); expect(fs.existsSync(path.join(f.context.projectRoot, ".mcp.json"))).toBe(false); }
    finally { await releaseLifecycleLocks(held.value); fs.rmSync(f.root, { recursive: true, force: true }); }
  });

  it("classifies a stale target as unchanged and retry-safe", async () => {
    const f = await setup(); try {
      const result = await persistMcpMutation(f.context, { kind: "set-declaration", scope: "user", name: "safe", definition: { command: "run" } }, {
        faults: { hit(phase) { if (phase === "after-journal") fs.writeFileSync(f.context.profilePath, '{"concurrent":true}\n'); } },
      });
      expect(result).toMatchObject({ state: "failed-before-commit", retrySafe: true, effect: "unchanged", cleanup: "complete", reasonCode: "stale" });
      expect(fs.readFileSync(f.context.profilePath, "utf8")).toBe('{"concurrent":true}\n');
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
});

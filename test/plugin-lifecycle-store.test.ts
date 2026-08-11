import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupOwnedArtifactCache } from "../src/plugin-lifecycle/cache.js";
import { createLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import {
  canonicalJsonBytes, createProducerCodecRegistry, createRecordEnvelope, establishOwnedStateStore,
  issuePrivateStagingParent, ownedRecordPartition, publishMaterializedArtifact, readRecordEnvelope,
  revalidateOwnedStateStore, sha256, type ArtifactPublicationFaultPhase, type OwnedStateStore, type ProducerCodec, type StoreResult,
} from "../src/plugin-lifecycle/state-store.js";
import { materializePluginTree, validatePluginTree } from "../src/plugin-lifecycle/tree-materializer.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function home(): Promise<string> { const value = await fs.mkdtemp(path.join(os.tmpdir(), "picc-store-")); roots.push(value); if (process.platform !== "win32") await fs.chmod(value, 0o700); return value; }
async function fixture(base?: string, profile = "profile-a"): Promise<OwnedStateStore> {
  base ??= await home();
  const locations = createLifecycleLocations({ homeDir: base, profilePath: path.join(base, profile), platform: process.platform === "win32" ? "win32" : "posix" });
  if (!locations.ok) throw new Error(locations.error.message); const established = await establishOwnedStateStore(locations.value, base); if (!established.ok) throw new Error(established.message); return established.value;
}
const codec: ProducerCodec<{ readonly answer: number }> = { schema: "test.answer", version: 1, decode(payload): StoreResult<{ readonly answer: number }> {
  return typeof payload === "object" && payload !== null && Object.keys(payload).length === 1 && (payload as { answer?: unknown }).answer === 42 ? { ok: true, value: { answer: 42 } } : { ok: false, code: "invalid", message: "invalid" };
} };
async function tree(store: OwnedStateStore, text: string) {
  const capability = await issuePrivateStagingParent(store); if (!capability.ok) throw new Error(capability.message);
  const plan = validatePluginTree([{ path: "plugin.json", kind: "file", data: Buffer.from(text) }], { kind: "tree-root" }); if (!plan.ok) throw new Error(plan.error.message);
  const result = await materializePluginTree(plan.value, capability.value); if (!result.ok) throw new Error(result.error.message); return result.value;
}
async function exists(candidate: string): Promise<boolean> { return fs.lstat(candidate).then(() => true, () => false); }
function artifactDestination(store: OwnedStateStore, digest: string): string { return path.join(store.artifactsRoot, digest.slice("sha256:".length)); }

describe("owned lifecycle state store", () => {
  it("puts every authoritative root beneath one profile and isolates equal operation names across profiles", async () => {
    const base = await home(); const first = await fixture(base, "one"); const second = await fixture(base, "two");
    for (const store of [first, second]) for (const candidate of [store.artifactsRoot, store.recordsRoot, store.stagingRoot, store.generationsRoot, store.journalsRoot, store.receiptsRoot, store.locksRoot, store.quarantineRoot]) expect(path.relative(store.profileRoot, candidate)).not.toMatch(/^\.\./);
    expect(first.profileRoot).not.toBe(second.profileRoot);
    await fs.writeFile(path.join(first.journalsRoot, "same-op.json"), "first"); await fs.writeFile(path.join(second.journalsRoot, "same-op.json"), "second");
    expect(await fs.readFile(path.join(first.journalsRoot, "same-op.json"), "utf8")).toBe("first");
    expect(await fs.readFile(path.join(second.journalsRoot, "same-op.json"), "utf8")).toBe("second");
    const a = ownedRecordPartition(first, "producer", "checkout-a"); const b = ownedRecordPartition(first, "producer", "checkout-b");
    expect(a.ok && b.ok && a.value !== b.value).toBe(true); expect(ownedRecordPartition(first, "../escape", "scope")).toMatchObject({ ok: false });
  });

  it("issues staging authority only from the live canonical store and rejects aliases/out-of-home roots", async () => {
    const store = await fixture(); expect((await revalidateOwnedStateStore(store)).ok).toBe(true); expect((await issuePrivateStagingParent(store)).ok).toBe(true); expect((await issuePrivateStagingParent({ ...store })).ok).toBe(false);
    const outside = await home(); const trusted = await home(); const locations = createLifecycleLocations({ homeDir: outside, profilePath: outside, platform: process.platform === "win32" ? "win32" : "posix" }); if (!locations.ok) throw new Error("locations");
    expect(await establishOwnedStateStore(locations.value, trusted)).toMatchObject({ ok: false, code: "unsafe-store" });
    const alias = path.join(path.dirname(store.profileRoot), "alias-profile");
    try { await fs.symlink(store.profileRoot, alias, process.platform === "win32" ? "junction" : "dir"); const forged = { ...store, profileRoot: alias, root: alias, stagingRoot: path.join(alias, "staging") }; expect((await issuePrivateStagingParent(forged)).ok).toBe(false); } catch (error) { if (process.platform !== "win32") throw error; }
  });

  it("rejects replaced and nonordinary canonical store components", async () => {
    const store = await fixture(); const displaced = `${store.stagingRoot}-old`; await fs.rename(store.stagingRoot, displaced); await fs.mkdir(store.stagingRoot, { mode: 0o700 }); expect(await revalidateOwnedStateStore(store)).toMatchObject({ ok: false, code: "changed-store" });
    const base = await home(); const locations = createLifecycleLocations({ homeDir: base, profilePath: path.join(base, "nonordinary"), platform: process.platform === "win32" ? "win32" : "posix" }); if (!locations.ok) throw new Error("locations"); await fs.mkdir(path.dirname(locations.value.profileRoot), { recursive: true }); await fs.writeFile(locations.value.profileRoot, "not a directory"); expect(await establishOwnedStateStore(locations.value, base)).toMatchObject({ ok: false, code: "unsafe-store" });
  });

  it.skipIf(process.platform !== "win32")("rejects Windows UNC/device namespace authority without claiming an ACL sandbox", async () => {
    const base = await home(); const locations = createLifecycleLocations({ homeDir: base, profilePath: path.join(base, "profile"), platform: "win32" }); if (!locations.ok) throw new Error("locations"); expect(await establishOwnedStateStore(locations.value, String.raw`\\?\C:\unsafe`)).toMatchObject({ ok: false, code: "unsafe-store" }); expect(await establishOwnedStateStore({ ...locations.value, root: String.raw`\\server\share\store` }, base)).toMatchObject({ ok: false, code: "unsafe-store" });
  });

  it.skipIf(process.platform === "win32")("rejects changed private-mode and owner evidence where exposed", async () => {
    const store = await fixture(); await fs.chmod(store.stagingRoot, 0o755); expect(await revalidateOwnedStateStore(store)).toMatchObject({ ok: false, code: "changed-store" });
  });

  it("uses exact bounded canonical record envelopes and keeps unknown/corrupt data inert", () => {
    const registry = createProducerCodecRegistry([codec]); const made = createRecordEnvelope(codec, "owner", "scope", { answer: 42 }); if (!registry.ok || !made.ok) throw new Error("fixture");
    expect(readRecordEnvelope(made.value.bytes, registry.value)).toMatchObject({ ok: true, value: { decoded: { answer: 42 } } });
    const parsed = JSON.parse(Buffer.from(made.value.bytes).toString()) as Record<string, unknown>;
    const mutations: readonly (readonly [string, unknown])[] = [
      ...Object.keys(parsed).map((key): readonly [string, unknown] => [`missing.${key}`, Object.fromEntries(Object.entries(parsed).filter(([selected]) => selected !== key))]),
      ["extra", { ...parsed, future: "RECORD_EXTRA_CANARY" }], ["format", { ...parsed, format: "future" }], ["formatVersion", { ...parsed, formatVersion: 2 }],
      ["schema", { ...parsed, schema: "INVALID/CANARY" }], ["codecVersion", { ...parsed, codecVersion: 0 }], ["owner", { ...parsed, ownerKey: "../OWNER_CANARY" }],
      ["scope", { ...parsed, scopeKey: "SCOPE/CANARY" }], ["digest", { ...parsed, payloadDigest: `sha256:${"0".repeat(64)}` }], ["payload", { ...parsed, payload: { answer: 41, evidence: "PAYLOAD_CANARY" } }],
    ];
    for (const [name, value] of mutations) { const bytes = canonicalJsonBytes(value); if (!bytes.ok) throw new Error("canonical"); const result = readRecordEnvelope(bytes.value, registry.value); expect(result.ok, name).toBe(false); expect(JSON.stringify(result), name).not.toMatch(/CANARY/); }
    expect(readRecordEnvelope(Buffer.from(`{ "format":"picc-owned-record" }`), registry.value)).toMatchObject({ ok: false, code: "invalid-envelope" });
    expect(readRecordEnvelope(Buffer.alloc(1024 * 1024 + 1, 0x20), registry.value)).toMatchObject({ ok: false, code: "bounded-data" });
    const unknown = createProducerCodecRegistry([]); if (!unknown.ok) throw new Error("registry"); expect(readRecordEnvelope(made.value.bytes, unknown.value)).toMatchObject({ ok: false, code: "unknown-producer" });
    expect(createProducerCodecRegistry([codec, codec])).toMatchObject({ ok: false, code: "invalid-codec" });
    expect(createRecordEnvelope(codec, "SECRET/../CANARY", "scope", { answer: 42 })).toMatchObject({ ok: false, code: "invalid-owner" }); expect(canonicalJsonBytes({ x: "x".repeat(100) }, 20)).toMatchObject({ ok: false, code: "bounded-data" });
  });

  it("publishes artifacts with exact source/destination/claim/result/retry truth at every fault phase", async () => {
    const phases: readonly ArtifactPublicationFaultPhase[] = ["before-claim", "after-claim", "before-publication", "after-publication", "before-claim-cleanup", "after-claim-cleanup"];
    for (const phase of phases) {
      const store = await fixture(); const source = await tree(store, `artifact-${phase}`); const destination = artifactDestination(store, source.treeDigest); const claim = path.join(store.artifactsRoot, `.${source.treeDigest.slice(7)}.publishing`); let fired = false;
      const result = await publishMaterializedArtifact(store, source, { hit(selected) { if (!fired && selected === phase) { fired = true; throw new Error("fault"); } } }); expect(fired, phase).toBe(true);
      const published = phase === "after-publication" || phase === "before-claim-cleanup" || phase === "after-claim-cleanup";
      expect(result, phase).toEqual(published ? { ok: true, value: { digest: source.treeDigest, path: destination, reused: false } } : { ok: false, code: "artifact-publication", message: "Immutable artifact could not be durably published" });
      expect(await exists(source.stagingDirectory), `${phase}.source`).toBe(!published); expect(await exists(destination), `${phase}.destination`).toBe(published);
      expect(await exists(claim), `${phase}.claim`).toBe(phase === "before-claim-cleanup");
      const retrySource = await tree(store, `artifact-${phase}`); const retry = await publishMaterializedArtifact(store, retrySource);
      expect(retry, `${phase}.retry`).toEqual({ ok: true, value: { digest: retrySource.treeDigest, path: destination, reused: published } });
      expect(await exists(retrySource.stagingDirectory), `${phase}.retry-source`).toBe(false); expect(await exists(destination), `${phase}.retry-destination`).toBe(true); expect(await exists(claim), `${phase}.retry-claim`).toBe(phase === "before-claim-cleanup");
    }
    const store = await fixture(); const first = await publishMaterializedArtifact(store, await tree(store, "reuse")); if (!first.ok) throw new Error(first.message);
    expect(await publishMaterializedArtifact(store, await tree(store, "reuse"))).toMatchObject({ ok: true, value: { reused: true } }); await fs.writeFile(path.join(first.value.path, "plugin.json"), "tampered");
    expect(await publishMaterializedArtifact(store, await tree(store, "reuse"))).toMatchObject({ ok: false, code: "artifact-collision" });
    const staged = await tree(store, "tamper-before-publish"); await fs.writeFile(path.join(staged.stagingDirectory, "plugin.json"), "changed"); expect(await publishMaterializedArtifact(store, staged)).toMatchObject({ ok: false, code: "artifact-mismatch" });
    const outside = await home(); await fs.mkdir(path.join(outside, "forged")); await fs.writeFile(path.join(outside, "forged", "plugin.json"), "outside-canary");
    expect(await publishMaterializedArtifact(store, { ...staged, stagingDirectory: path.join(outside, "forged"), treeDigest: sha256(Buffer.from("forged")) })).toMatchObject({ ok: false, code: "untrusted-staging" }); expect(await fs.readFile(path.join(outside, "forged", "plugin.json"), "utf8")).toBe("outside-canary");
  });

  it("asserts the complete cache retention, boundary, quarantine, collision, and removal table on disk", async () => {
    const now = 2_000_000_000_000; async function cached(text: string, age: number) { const store = await fixture(); const item = await publishMaterializedArtifact(store, await tree(store, text)); if (!item.ok) throw new Error(item.message); await fs.utimes(item.value.path, new Date(now - age), new Date(now - age)); return { store, ...item.value }; }
    const retention: readonly { readonly name: string; readonly certain: boolean; readonly sets: { readonly referencedDigests?: "self" | "empty"; readonly activeSessionDigests?: "self"; readonly importedDigests?: "self" }; readonly age: number; readonly grace: number; readonly counters: Readonly<Record<string, number>> }[] = [
      { name: "uncertain", certain: false, sets: {}, age: 100, grace: 0, counters: { retainedUncertain: 1 } },
      { name: "missing-reference-set", certain: true, sets: {}, age: 100, grace: 0, counters: { retainedUncertain: 1 } },
      { name: "referenced", certain: true, sets: { referencedDigests: "self" }, age: 100, grace: 0, counters: { retainedReferenced: 1 } },
      { name: "active", certain: true, sets: { referencedDigests: "empty", activeSessionDigests: "self" }, age: 100, grace: 0, counters: { retainedReferenced: 1 } },
      { name: "imported", certain: true, sets: { referencedDigests: "empty", importedDigests: "self" }, age: 100, grace: 0, counters: { retainedUncertain: 1 } },
      { name: "inside-grace", certain: true, sets: { referencedDigests: "empty" }, age: 99, grace: 100, counters: { retainedGrace: 1 } },
      { name: "future", certain: true, sets: { referencedDigests: "empty" }, age: -1, grace: 0, counters: { retainedUncertain: 1 } },
    ];
    const counters = (selected: Readonly<Record<string, number>>, removed: readonly string[] = []) => ({ removed, retainedReferenced: 0, retainedGrace: 0, retainedUncertain: 0, quarantinedInvalid: 0, ...selected });
    for (const row of retention) { const item = await cached(row.name, row.age); const set = (kind: "self" | "empty" | undefined) => kind === undefined ? undefined : new Set(kind === "self" ? [item.digest] : []); const result = await cleanupOwnedArtifactCache({ store: item.store, referenceStateCertain: row.certain, now, graceMs: row.grace, referencedDigests: set(row.sets.referencedDigests), activeSessionDigests: set(row.sets.activeSessionDigests), importedDigests: set(row.sets.importedDigests) }); expect(result, row.name).toEqual({ ok: true, value: counters(row.counters) }); expect(await exists(item.path), row.name).toBe(true); }
    for (const age of [100, 101]) { const item = await cached(`boundary-${age}`, age); const result = await cleanupOwnedArtifactCache({ store: item.store, referenceStateCertain: true, referencedDigests: new Set(), now, graceMs: 100 }); expect(result, `boundary-${age}`).toEqual({ ok: true, value: counters({}, [item.digest]) }); expect(await exists(item.path)).toBe(false); }
    const unknown = await cached("unknown", 100); await fs.writeFile(path.join(unknown.store.artifactsRoot, "imported-name-CANARY"), "unknown"); expect(await cleanupOwnedArtifactCache({ store: unknown.store, referenceStateCertain: true, referencedDigests: new Set([unknown.digest]), now, graceMs: 0 })).toMatchObject({ ok: true, value: { retainedReferenced: 1, retainedUncertain: 1 } }); expect(await exists(path.join(unknown.store.artifactsRoot, "imported-name-CANARY"))).toBe(true);
    for (const phase of ["before-remove", "after-remove"] as const) { const item = await cached(phase, 100); const result = await cleanupOwnedArtifactCache({ store: item.store, referenceStateCertain: true, referencedDigests: new Set(), now, graceMs: 0, faults: { hit(selected) { if (selected === phase) throw new Error("fault"); } } }); expect(result, phase).toEqual({ ok: true, value: phase === "before-remove" ? counters({ retainedUncertain: 1 }) : counters({}, [item.digest]) }); expect(await exists(item.path), phase).toBe(phase === "before-remove"); }
    for (const phase of ["before-quarantine", "after-quarantine"] as const) { const item = await cached(phase, 100); await fs.writeFile(path.join(item.path, "plugin.json"), "invalid"); let selectedPath = ""; const result = await cleanupOwnedArtifactCache({ store: item.store, referenceStateCertain: true, referencedDigests: new Set(), now, graceMs: 0, faults: { hit(selected, _digest, destination) { if (selected === phase) { selectedPath = destination; throw new Error("fault"); } } } }); expect(result, phase).toEqual({ ok: true, value: phase === "before-quarantine" ? counters({ retainedUncertain: 1 }) : counters({ quarantinedInvalid: 1 }) }); expect(await exists(item.path), phase).toBe(phase === "before-quarantine"); expect(await exists(selectedPath), phase).toBe(phase === "after-quarantine"); }
    const collision = await cached("collision", 100); await fs.writeFile(path.join(collision.path, "plugin.json"), "invalid"); let collisionPath = ""; const collided = await cleanupOwnedArtifactCache({ store: collision.store, referenceStateCertain: true, referencedDigests: new Set(), now, graceMs: 0, faults: { async hit(phase, _digest, destination) { if (phase === "before-quarantine") { collisionPath = destination; await fs.mkdir(destination); await fs.writeFile(path.join(destination, "canary"), "collision-canary"); } } } }); expect(collided).toEqual({ ok: true, value: counters({ retainedUncertain: 1 }) }); expect(await exists(collision.path)).toBe(true); expect(await fs.readFile(path.join(collisionPath, "canary"), "utf8")).toBe("collision-canary");
  });
});

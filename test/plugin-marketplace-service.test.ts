import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { createMarketplaceAcquisitionAdapter, marketplaceSettingsDeclaration, marketplaceSourceAnchor, PluginMarketplaceService, type AcquiredMarketplaceSnapshot, type MarketplaceObservation } from "../src/plugin-lifecycle/marketplace-service.js";
import type { GitRunRequest, GitRunResult, GitRunner } from "../src/plugin-lifecycle/acquisition/git.js";
import { deferred } from "./helpers/async.js";
import { planPluginSettingsWrite } from "../src/plugin-lifecycle/settings-plan.js";
import { canonicalJsonBytes, establishOwnedStateStore, type OwnedStateStore } from "../src/plugin-lifecycle/state-store.js";
import type { MarketplaceRegistrationSource, Sha256 } from "../src/plugin-lifecycle/types.js";

const roots: string[] = [];
let marketplaceChildLaunches = 0;
afterEach(() => { while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });
async function runMarketplaceChild(script: string, env: NodeJS.ProcessEnv): Promise<string> {
  marketplaceChildLaunches += 1; const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`marketplace child ${code}: ${stderr}`))); }); const ceiling = setTimeout(() => child.kill(), 10_000);
  try { await exited; return stdout; } finally { clearTimeout(ceiling); if (child.exitCode === null) child.kill(); await new Promise<void>((resolve) => child.exitCode === null ? child.once("exit", () => resolve()) : resolve()); }
}
function digest(char: string): Sha256 { return `sha256:${char.repeat(64)}`; }
function snapshotId(catalogDigest: Sha256, url: string): `marketplace-${string}` { return `marketplace-${createHash("sha256").update(`${catalogDigest}\0${url}`).digest("base64url")}`; }
const source = { kind: "https-catalog", url: "https://catalog.example.org/catalog.json" } as const;
const COMMIT = "1".repeat(40);
function gitSuccess(stdout: string | Uint8Array = ""): GitRunResult { return { code: 0, stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout, stderr: new Uint8Array() }; }
function marketplaceGitRunner(calls: GitRunRequest[] = []): GitRunner { const catalog = JSON.stringify({ name: "official", owner: { name: "Example" }, plugins: [] }); const hash = "3".repeat(40); return async (request: GitRunRequest) => { calls.push(request);
  if (request.args.join(" ") === "help --config") return gitSuccess("http.curloptResolve\n"); if (request.args.includes("ls-remote")) return gitSuccess(`${COMMIT}\tHEAD\n`); if (request.args.includes("init") || request.args.includes("fetch") || request.args.includes("-e")) return gitSuccess();
  if (request.args.includes("ls-tree")) return gitSuccess(Buffer.from(`100644 blob ${hash}\t.claude-plugin/marketplace.json\0`)); if (request.args.includes("--batch")) return gitSuccess(Buffer.concat([Buffer.from(`${hash} blob ${Buffer.byteLength(catalog)}\n`), Buffer.from(catalog), Buffer.from("\n")])); return { code: 1, stdout: new Uint8Array(), stderr: Buffer.from("credential-canary") };
}; }
function acquired(char = "a"): AcquiredMarketplaceSnapshot { const catalogBytes = Buffer.from(JSON.stringify({ name: "official", owner: { name: char === "a" ? "Example" : `Example ${char}` }, plugins: [{ name: "tool", source: { source: "npm", package: "tool", registry: "https://registry.npmjs.org" } }] })); const catalogDigest = `sha256:${createHash("sha256").update(catalogBytes).digest("hex")}` as Sha256; return { target: { authorityKind: "catalog-only", marketplaceName: "official", snapshotId: snapshotId(catalogDigest, source.url), source, catalogDigest, provenance: { adapter: "public-https-catalog", canonicalUrl: source.url } }, catalogBytes }; }
async function fixture() {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picc-marketplace-service-"))); roots.push(home); const profile = path.join(home, ".claude"); const project = path.join(home, "project"); fs.mkdirSync(profile); fs.mkdirSync(path.join(project, ".git"), { recursive: true }); fs.mkdirSync(path.join(project, ".claude"));
  const locations = createLifecycleLocations({ homeDir: home, profilePath: profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: project, checkoutFamilyPath: project } }); if (!locations.ok) throw new Error(locations.error.message); const store = await establishOwnedStateStore(locations.value, home); if (!store.ok) throw new Error(store.message);
  return { home, profile, project, store: store.value, checkoutFamilyKey: locations.value.checkoutFamilyKey };
}
function build(value: Awaited<ReturnType<typeof fixture>>, rows: MarketplaceObservation[], next: () => AcquiredMarketplaceSnapshot = () => acquired(), id: string | (() => string) = "marketplace_test", transactionFaults?: import("../src/plugin-lifecycle/transaction.js").TransactionFaultSeam, preparationFaults?: import("../src/plugin-lifecycle/marketplace-service.js").MarketplaceServiceDependencies["preparationFaults"], processOwnershipProbe?: import("../src/plugin-lifecycle/locks.js").ProcessOwnershipProbe, managedPaths: readonly string[] = [], beforeTransactionExecution?: () => void | Promise<void>) {
  const acquire = vi.fn(async (_name: string, _source: MarketplaceRegistrationSource) => ({ ok: true as const, value: next() }));
  const service = new PluginMarketplaceService({ store: value.store, profilePath: value.profile, marketplaceSourceAnchor: value.project, checkoutFamilyKey: value.checkoutFamilyKey, observe: () => rows, acquire, operationId: typeof id === "string" ? () => id : id, ...(transactionFaults === undefined ? {} : { transactionFaults }), ...(preparationFaults === undefined ? {} : { preparationFaults }), ...(processOwnershipProbe === undefined ? {} : { processOwnershipProbe }), ...(beforeTransactionExecution === undefined ? {} : { beforeTransactionExecution }),
    planSettings: async ({ action, name, scope, value: descriptor, declarationOnly }) => planPluginSettingsWrite({ homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths, scope, mutation: { kind: "known-marketplace", key: name, ...(action === "remove" ? {} : { value: descriptor! }) }, declarationOnly }) });
  return { service, acquire };
}
async function commit(service: PluginMarketplaceService, preview: Awaited<ReturnType<PluginMarketplaceService["add"]>>) { if (!preview.ok) throw new Error(preview.message); const prepared = service.prepare(preview.value); if (!prepared.ok) throw new Error(prepared.message); return prepared.value.execute(preview.value.confirmationDigest); }
function observed(preview: { registration: NonNullable<MarketplaceObservation["registration"]>; snapshot: NonNullable<MarketplaceObservation["snapshot"]>; catalog: NonNullable<MarketplaceObservation["catalog"]> }, dependents: readonly string[] = []): MarketplaceObservation { return { name: "official", owner: "picc-owned", source, selected: true, effective: true, trusted: true, registration: preview.registration, snapshot: preview.snapshot, catalog: preview.catalog, plugins: preview.catalog.plugins, dependents, errors: [], provenance: ["captured"] }; }

describe("PluginMarketplaceService", () => {
  it("dispatches every marketplace registration family through the real acquisition adapter with injected transports", async () => {
    const value = await fixture(); const catalog = JSON.stringify({ name: "official", owner: { name: "Example" }, plugins: [] }); const localDirectory = path.join(value.project, "directory-market"); fs.mkdirSync(path.join(localDirectory, ".claude-plugin"), { recursive: true }); fs.writeFileSync(path.join(localDirectory, ".claude-plugin", "marketplace.json"), catalog); const localFileRoot = path.join(value.project, "file-market"); fs.mkdirSync(localFileRoot); const localFile = path.join(localFileRoot, "marketplace.json"); fs.writeFileSync(localFile, catalog);
    const gitCalls: GitRunRequest[] = []; const httpCalls: Array<{ url: string; address: string }> = []; const adapter = createMarketplaceAcquisitionAdapter({ store: value.store, git: { runner: marketplaceGitRunner(gitCalls), resolver: async () => [{ address: "8.8.8.8", family: 4 }] }, https: { resolver: async () => [{ address: "8.8.8.8", family: 4 }], connector: async (request) => { httpCalls.push({ url: request.url.href, address: request.address.address }); return { status: 200, headers: {}, body: Buffer.from(catalog) }; } } });
    const families: MarketplaceRegistrationSource[] = [{ kind: "local-directory", path: localDirectory }, { kind: "local-catalog-file", path: localFile }, { kind: "github", repository: "owner/repo" }, { kind: "https-git", url: "https://git.example.org/repo.git" }, source]; const results = [];
    for (const family of families) { const result = await adapter("official", family); expect(result).toMatchObject({ ok: true, value: { target: { source: family } } }); if (!result.ok) throw new Error(result.message); expect(createHash("sha256").update(result.value.catalogBytes).digest("hex")).toBe(result.value.target.catalogDigest.slice(7)); results.push(result.value.target); }
    expect(results[0]).toMatchObject({ authorityKind: "materialized", provenance: { adapter: "local-directory-snapshot" }, catalogRelativePath: ".claude-plugin/marketplace.json" }); expect(results[1]).toMatchObject({ authorityKind: "materialized", provenance: { adapter: "local-catalog-snapshot" }, catalogRelativePath: "marketplace.json" }); expect(results[2]).toMatchObject({ authorityKind: "materialized", provenance: { adapter: "anonymous-https-git", commit: COMMIT } }); expect(results[3]).toMatchObject({ authorityKind: "materialized", provenance: { adapter: "anonymous-https-git", commit: COMMIT } }); expect(results[4]).toMatchObject({ authorityKind: "catalog-only", provenance: { adapter: "public-https-catalog", canonicalUrl: source.url } });
    const remotes = gitCalls.filter((call) => call.args.includes("ls-remote") || call.args.includes("fetch")).map((call) => call.args.find((argument) => argument.startsWith("https://"))).filter((item): item is string => item !== undefined); expect(remotes).toContain("https://github.com/owner/repo.git"); expect(remotes).toContain("https://git.example.org/repo.git"); expect(gitCalls.filter((call) => call.args.includes("ls-tree")).every((call) => call.args.includes(COMMIT))).toBe(true); expect(httpCalls).toEqual([{ url: source.url, address: "8.8.8.8" }]);
  });

  it("keeps list/details local, deeply bounded, and credential-safe with no acquisition", async () => {
    const value = await fixture(); const secret = "credential-canary-user:credential-canary-pass"; const imported: MarketplaceObservation = { name: "official", owner: "claude-imported", source, selected: true, effective: true, trusted: false, plugins: Array.from({ length: 1025 }, (_, index) => ({ name: `tool-${index}`, supported: false, error: `${secret}-${index}` })), dependents: [], errors: [secret], provenance: [secret] };
    const { service, acquire } = build(value, [imported]); const status = service.listStatus(); expect(status).toMatchObject({ uncertain: false, rows: [{ pluginOmitted: 1, diagnostics: ["Marketplace observation reported errors", "Marketplace provenance is retained internally"] }] }); expect(JSON.stringify(status)).not.toContain(secret);
    expect(service.details("official")).toMatchObject({ ok: true }); expect(acquire).not.toHaveBeenCalled();
    const unrelated = { ...imported, name: "other" }; await expect(build(value, [unrelated], () => acquired(), "marketplace_unrelated_overflow").service.add("official", source)).resolves.toMatchObject({ ok: true });
  });

  it("reserves duplicate ids before acquisition and allows only never-started preview discard", async () => {
    const value = await fixture(); const { service, acquire } = build(value, [], () => acquired(), "marketplace_reserved");
    const preview = await service.add("official", source); expect(preview.ok).toBe(true); const calls = acquire.mock.calls.length;
    await expect(service.add("official", source)).resolves.toMatchObject({ ok: false, code: "duplicate-operation-id" }); expect(acquire).toHaveBeenCalledTimes(calls); const contender = build(value, [], () => acquired(), "marketplace_reserved"); await expect(contender.service.add("official", source)).resolves.toMatchObject({ ok: false, code: "duplicate-operation-id" }); expect(contender.acquire).not.toHaveBeenCalled();
    if (!preview.ok) return; await expect(service.discardPreview(preview.value.operationId)).resolves.toMatchObject({ ok: true }); expect(fs.readdirSync(value.store.stagingRoot)).toEqual([]);
    const rebound = await service.add("official", source); if (!rebound.ok) throw new Error(rebound.message); const bound = service.prepare(rebound.value); expect(bound.ok).toBe(true); await expect(service.discardPreview(rebound.value.operationId)).resolves.toMatchObject({ ok: true }); if (bound.ok) await expect(bound.value.execute(rebound.value.confirmationDigest)).resolves.toMatchObject({ ok: false, code: "preparation-revoked" });
  });

  it("claims cancellation synchronously so re-prepare and execute cannot bypass it or remove durable evidence", async () => {
    const value = await fixture(); const transactionHit = vi.fn(); const service = build(value, [], () => acquired(), "marketplace_cancel_race", { hit: transactionHit }).service; const preview = await service.add("official", source); if (!preview.ok) throw new Error(preview.message); const bound = service.prepare(preview.value); if (!bound.ok) throw new Error(bound.message);
    const canary = path.join(value.store.stagingRoot, "unrelated-t03-evidence"); fs.writeFileSync(canary, "preserve"); const cancellation = service.discardPreview(preview.value.operationId); const reprepared = service.prepare(preview.value); const duplicateCancellation = service.discardPreview(preview.value.operationId); const raced = bound.value.execute(preview.value.confirmationDigest);
    expect(reprepared).toMatchObject({ ok: false, code: "cancellation-in-progress", message: expect.stringContaining("wait for discardPreview to finish") }); expect(await duplicateCancellation).toMatchObject({ ok: false, code: "cancellation-in-progress", message: expect.stringContaining("wait for discardPreview to finish") }); expect(await raced).toMatchObject({ ok: false, code: "cancellation-in-progress", message: expect.stringContaining("Cancellation is in progress") }); expect(await cancellation).toEqual({ ok: true, value: undefined }); expect(transactionHit).not.toHaveBeenCalled(); expect(fs.readFileSync(canary, "utf8")).toBe("preserve"); expect(fs.readdirSync(value.store.journalsRoot)).toEqual([]); expect(fs.readdirSync(value.store.receiptsRoot)).toEqual([]);
  });

  it("keeps a contender cancellable when another operation becomes pending after preflight", async () => {
    const value = await fixture(); const operationId = "marketplace_pending_contender"; const otherJournal = path.join(value.store.journalsRoot, "marketplace_other.json"); let gated = false;
    const service = build(value, [], () => acquired(), operationId, undefined, undefined, undefined, [], () => { if (!gated) { gated = true; fs.writeFileSync(otherJournal, "{}"); } }).service; const preview = await service.add("official", source); if (!preview.ok) throw new Error(preview.message); const bound = service.prepare(preview.value); if (!bound.ok) throw new Error(bound.message);
    expect(await bound.value.execute(preview.value.confirmationDigest)).toMatchObject({ ok: false, code: "another-operation-pending", message: expect.stringContaining("still-bound preparation") }); expect(fs.existsSync(path.join(value.store.journalsRoot, `${operationId}.json`))).toBe(false); expect(fs.readdirSync(value.store.locksRoot)).toEqual([]);
    expect(await service.discardPreview(operationId)).toEqual({ ok: true, value: undefined }); expect(fs.readdirSync(value.store.stagingRoot)).toEqual([]); expect(fs.existsSync(otherJournal)).toBe(true); fs.rmSync(otherJournal); const successor = await service.add("official", source); expect(successor.ok).toBe(true); if (successor.ok) await service.discardPreview(successor.value.operationId);
  });

  it("revokes only the discarded generation when an operation id is reused", async () => {
    const value = await fixture(); const service = build(value, [], () => acquired(), "marketplace_generation").service; const first = await service.add("official", source); if (!first.ok) throw new Error(first.message); const stale = service.prepare(first.value); if (!stale.ok) throw new Error(stale.message);
    expect(await service.discardPreview(first.value.operationId)).toMatchObject({ ok: true }); const successor = await service.add("official", source); if (!successor.ok) throw new Error(successor.message); const current = service.prepare(successor.value); if (!current.ok) throw new Error(current.message);
    expect(await stale.value.execute(first.value.confirmationDigest)).toMatchObject({ ok: false, code: "preparation-revoked" }); expect(await service.receipt(first.value.operationId)).toEqual({ ok: true, value: undefined }); expect(await service.discardPreview(successor.value.operationId)).toMatchObject({ ok: true }); expect(await current.value.execute(successor.value.confirmationDigest)).toMatchObject({ ok: false, code: "preparation-revoked" });
  });

  it("retains bound evidence after confirmation mismatch for explicit cancellation", async () => {
    const value = await fixture(); const service = build(value, [], () => acquired(), "marketplace_confirmation_retry").service; const preview = await service.add("official", source); if (!preview.ok) throw new Error(preview.message); const bound = service.prepare(preview.value); if (!bound.ok) throw new Error(bound.message); const staging = fs.readdirSync(value.store.stagingRoot);
    expect(await bound.value.execute(digest("b"))).toMatchObject({ ok: false, code: "confirmation-mismatch" }); expect(fs.readdirSync(value.store.stagingRoot)).toEqual(staging); expect(await service.discardPreview(preview.value.operationId)).toMatchObject({ ok: true });
  });

  it("strictly bounds all unjournaled preparations including bound handles", async () => {
    const value = await fixture(); let next = 0; const service = build(value, [], () => acquired(), () => `marketplace_limit_${next++}`).service; const previews = [];
    for (let index = 0; index < 64; index++) { const made = await service.add("official", source); if (!made.ok) throw new Error(`${index}:${made.code}`); previews.push(made.value); expect(service.prepare(made.value).ok).toBe(true); }
    await expect(service.add("official", source)).resolves.toMatchObject({ ok: false, code: "preview-limit" });
    await expect(service.discardPreview(previews[0]!.operationId)).resolves.toMatchObject({ ok: true }); const replacement = await service.add("official", source); expect(replacement.ok).toBe(true);
    for (const preview of previews.slice(1)) await service.discardPreview(preview.operationId); if (replacement.ok) await service.discardPreview(replacement.value.operationId);
  }, 30_000);

  it("rejects a terminal operation id before acquisition and directs callers to receipt lookup", async () => {
    const value = await fixture(); const first = build(value, [], () => acquired(), "marketplace_terminal_retry", { hit: (phase, index) => { if (phase === "before-replacement" && index === 0) throw new Error("fail-before-commit"); } }).service;
    const left = await first.add("official", source); expect(await commit(first, left)).toMatchObject({ ok: false, code: "mutation-not-committed", receipt: { outcome: "failed-before-commit" } });
    const second = build(value, [], () => acquired(), "marketplace_terminal_retry"); const staging = fs.readdirSync(value.store.stagingRoot); await expect(second.service.add("official", source)).resolves.toMatchObject({ ok: false, code: "terminal-operation-id", message: expect.stringContaining("receipt") }); expect(second.acquire).not.toHaveBeenCalled(); expect(fs.readdirSync(value.store.stagingRoot)).toEqual(staging);
  });

  it("blocks re-prepare and unrelated acquisition while profile state is pending", async () => {
    const value = await fixture(); let interrupted = false; const pending = build(value, [], () => acquired(), "marketplace_profile_pending", { hit: (phase, index) => { if (!interrupted && phase === "after-replacement" && index === 0) { interrupted = true; throw new Error("pending"); } } }).service; const preview = await pending.add("official", source); if (!preview.ok) throw new Error(preview.message); const bound = pending.prepare(preview.value); if (!bound.ok) throw new Error(bound.message); expect(await bound.value.execute(preview.value.confirmationDigest)).toMatchObject({ ok: false, code: "pending-recovery" });
    expect(pending.prepare(preview.value)).toMatchObject({ ok: false, code: "pending-recovery", message: expect.stringContaining("recoveryStatus") }); expect(await bound.value.execute(preview.value.confirmationDigest)).toMatchObject({ ok: false, code: "pending-recovery" });
    const contender = build(value, [], () => acquired(), "marketplace_unrelated_new"); const staging = fs.readdirSync(value.store.stagingRoot); const artifacts = fs.readdirSync(value.store.artifactsRoot); await expect(pending.discardPreview("marketplace_profile_pending")).resolves.toMatchObject({ ok: false, code: "preview-started" }); expect(fs.readdirSync(value.store.stagingRoot)).toEqual(staging); await expect(contender.service.add("other", { kind: "https-catalog", url: "https://other.example.org/catalog.json" })).resolves.toMatchObject({ ok: false, code: "pending-recovery", message: expect.stringContaining("marketplace_profile_pending") }); expect(contender.acquire).not.toHaveBeenCalled(); expect(fs.readdirSync(value.store.stagingRoot)).toEqual(staging); expect(fs.readdirSync(value.store.artifactsRoot)).toEqual(artifacts);
    expect(await pending.recover("marketplace_profile_pending", "rollback")).toMatchObject({ ok: true, value: { outcome: "rolled-back" } });
  });

  it("executes add through t08+t03, retries by operation id, and wraps terminal truth", async () => {
    const value = await fixture(); const { service } = build(value, []); const preview = await service.add("official", source);
    expect(preview).toMatchObject({ ok: true, value: { action: "add", participants: [{ role: "settings" }, { role: "snapshot" }, { role: "registration" }] } });
    if (!preview.ok) throw new Error(preview.message); const bound = service.prepare(preview.value); if (!bound.ok) throw new Error(bound.message);
    const first = await bound.value.execute(preview.value.confirmationDigest); if (!first.ok) throw new Error(`${first.code}: ${first.message}`); expect(first).toMatchObject({ ok: true, value: { outcome: "committed", completed: 3 } });
    expect(service.prepare(preview.value)).toMatchObject({ ok: false, code: "operation-terminal", message: expect.stringContaining("receipt") }); const second = await bound.value.execute(preview.value.confirmationDigest); expect(second).toEqual(first);
    expect(JSON.parse(fs.readFileSync(path.join(value.profile, "settings.json"), "utf8")).extraKnownMarketplaces.official.source).toEqual({ source: "url", url: source.url });
    const fresh = build(value, [], () => acquired(), "unused").service; await expect(fresh.receipt("marketplace_test")).resolves.toEqual(first);
  });

  it("executes authentic settings and registration participants in every mutable scope", async () => {
    for (const scope of ["user", "project", "local"] as const) { const value = await fixture(); const service = build(value, [], () => acquired(), `marketplace_${scope}`).service; const preview = await service.add("official", source, { scope }); expect(preview).toMatchObject({ ok: true, value: { registration: { scope } } }); expect((await commit(service, preview)).ok).toBe(true); const target = scope === "user" ? path.join(value.profile, "settings.json") : path.join(value.project, ".claude", scope === "local" ? "settings.local.json" : "settings.json"); expect(fs.existsSync(target)).toBe(true); }
  });

  it("refreshes and removes exact project/local/user registrations without touching plugin state", async () => {
    for (const scope of ["user", "project", "local"] as const) {
      const value = await fixture(); const addedService = build(value, [], () => acquired(), `marketplace_scope_add_${scope}`).service; const added = await addedService.add("official", source, { scope }); expect((await commit(addedService, added)).ok).toBe(true); if (!added.ok) continue;
      const refreshedService = build(value, [observed(added.value)], () => acquired("b"), `marketplace_scope_refresh_${scope}`).service; const refreshed = await refreshedService.refresh("official", { registration: added.value.registration }); expect((await commit(refreshedService, refreshed)).ok).toBe(true); if (!refreshed.ok) continue;
      const removedService = build(value, [observed(refreshed.value)], () => acquired(), `marketplace_scope_remove_${scope}`).service; const removed = await removedService.remove("official", { registration: refreshed.value.registration, acknowledgePreservedDependents: true }); expect(await commit(removedService, removed)).toMatchObject({ ok: true, value: { outcome: "committed" } });
    }
  });

  it("makes update an exact refresh alias and changes only selected catalog snapshot", async () => {
    const value = await fixture(); const initialService = build(value, []).service; const initial = await initialService.add("official", source); expect((await commit(initialService, initial)).ok).toBe(true); if (!initial.ok) return;
    const rows = [observed(initial.value)]; const refreshedService = build(value, rows, () => acquired("b"), "marketplace_refresh").service; const refreshed = await refreshedService.refresh("official", { registration: initial.value.registration }); if (refreshed.ok) await refreshedService.discardPreview(refreshed.value.operationId);
    const updated = await refreshedService.update("official", { registration: initial.value.registration }); expect(updated).toEqual(refreshed);
    if (!refreshed.ok) throw new Error(refreshed.message); expect(refreshed.value.snapshot.snapshotId).not.toBe(initial.value.snapshot.snapshotId); expect(refreshed.value.consequences.join(" ")).toContain("without changing installed generation membership");
  });

  it("removes settings before explicit owned-record deletion and preserves dependents", async () => {
    const value = await fixture(); const addService = build(value, []).service; const added = await addService.add("official", source); expect((await commit(addService, added)).ok).toBe(true); if (!added.ok) return; const rows = [observed(added.value, ["tool@official"])];
    const removeService = build(value, rows, () => acquired(), "marketplace_remove").service; await expect(removeService.remove("official", { registration: added.value.registration })).resolves.toMatchObject({ ok: false, code: "consequence-confirmation-required" });
    const removal = await removeService.remove("official", { registration: added.value.registration, acknowledgePreservedDependents: true }); expect(removal).toMatchObject({ ok: true, value: { action: "remove", dependents: ["tool@official"], participants: [{ role: "settings" }, { role: "registration", effect: "delete" }] } });
    const receipt = await commit(removeService, removal); expect(receipt).toMatchObject({ ok: true, value: { outcome: "committed", completed: 2 } }); if (!removal.ok) return;
    expect(fs.existsSync(removal.value.participants[1]!.target)).toBe(false); expect(removal.value.snapshot).toEqual(added.value.snapshot); expect(JSON.parse(fs.readFileSync(path.join(value.profile, "settings.json"), "utf8")).extraKnownMarketplaces).toEqual({});
  });

  it("rolls back a removal after the owned delete marker/mutation prefix", async () => {
    const value = await fixture(); const addService = build(value, []).service; const added = await addService.add("official", source); expect((await commit(addService, added)).ok).toBe(true); if (!added.ok) return;
    let interrupted = false; const faults = { hit: (phase: string, index?: number) => { if (!interrupted && phase === "after-forward-deletion-mutation" && index === 1) { interrupted = true; throw new Error("interrupt-delete"); } } } as import("../src/plugin-lifecycle/transaction.js").TransactionFaultSeam;
    const service = build(value, [observed(added.value)], () => acquired(), "marketplace_remove_rollback", faults).service; const removal = await service.remove("official", { registration: added.value.registration, acknowledgePreservedDependents: true }); const pending = await commit(service, removal); expect(pending).toMatchObject({ ok: false, code: "pending-recovery" });
    const rolledBack = await service.recover("marketplace_remove_rollback", "rollback"); expect(rolledBack).toMatchObject({ ok: true, value: { outcome: "rolled-back" } }); if (!removal.ok) return; expect(fs.existsSync(removal.value.participants[1]!.target)).toBe(true); expect(JSON.parse(fs.readFileSync(path.join(value.profile, "settings.json"), "utf8")).extraKnownMarketplaces.official).toBeDefined();
  });

  it("recovers representative compound prefixes across settings, snapshot, registration, and delete-marker boundaries", async () => {
    const replaceCases = [["after-replacement", 0], ["after-replacement", 1], ["after-replacement", 2]] as const;
    for (const [phase, participant] of replaceCases) { const value = await fixture(); let interrupted = false; const id = `marketplace_prefix_${participant}`; const service = build(value, [], () => acquired(), id, { hit: (current, index) => { if (!interrupted && current === phase && index === participant) { interrupted = true; throw new Error("prefix"); } } }).service; const preview = await service.add("official", source); expect(await commit(service, preview)).toMatchObject({ ok: false, code: "pending-recovery" }); expect(await service.recover(id, "complete")).toMatchObject({ ok: true, value: { outcome: "committed", completed: 3 } }); }
    const value = await fixture(); const add = build(value, []).service; const added = await add.add("official", source); expect((await commit(add, added)).ok).toBe(true); if (!added.ok) return; let interrupted = false; const removal = build(value, [observed(added.value)], () => acquired(), "marketplace_prefix_delete_marker", { hit: (phase, index) => { if (!interrupted && phase === "after-forward-deletion-marker" && index === 1) { interrupted = true; throw new Error("marker"); } } }).service; const preview = await removal.remove("official", { registration: added.value.registration, acknowledgePreservedDependents: true }); expect(await commit(removal, preview)).toMatchObject({ ok: false, code: "pending-recovery" }); expect(await removal.recover("marketplace_prefix_delete_marker", "rollback")).toMatchObject({ ok: true, value: { outcome: "rolled-back" } });
  });

  it("completes a compound settings/record prefix through explicit offline recovery", async () => {
    const value = await fixture(); let interrupted = false; const faults = { hit: (phase: string, index?: number) => { if (!interrupted && phase === "after-replacement" && index === 0) { interrupted = true; throw new Error("interrupt"); } } } as import("../src/plugin-lifecycle/transaction.js").TransactionFaultSeam;
    const service = build(value, [], () => acquired(), "marketplace_recover", faults).service; const preview = await service.add("official", source); const pending = await commit(service, preview); expect(pending).toMatchObject({ ok: false, code: "pending-recovery" });
    const recovered = await service.recover("marketplace_recover", "complete"); if (!recovered.ok) throw new Error(`${recovered.code}: ${recovered.message}`); expect(recovered).toMatchObject({ ok: true, value: { outcome: "committed", completed: 3 } });
  });

  it("refuses ineffective registration by default and labels explicit declaration-only consequences", async () => {
    const value = await fixture(); const managed = path.join(value.home, "managed.json"); fs.writeFileSync(managed, JSON.stringify({ extraKnownMarketplaces: { official: { source: { source: "url", url: "https://managed.example.org/catalog.json" } } } }));
    await expect(build(value, [], () => acquired(), "marketplace_shadow_default", undefined, undefined, undefined, [managed]).service.add("official", source, { scope: "project" })).resolves.toMatchObject({ ok: false, code: "ineffective-declaration" });
    const explicit = await build(value, [], () => acquired(), "marketplace_shadow_explicit", undefined, undefined, undefined, [managed]).service.add("official", source, { scope: "project", declarationOnly: true }); expect(explicit).toMatchObject({ ok: true, value: { settingsEffect: { declarationOnly: true, effective: false }, consequences: expect.arrayContaining([expect.stringContaining("will not become effective"), expect.stringContaining("retained effective scope is managed")]) } });
  });

  it("refuses imported/managed authority and exact-record ambiguity actionably", async () => {
    const value = await fixture(); const imported: MarketplaceObservation = { name: "official", owner: "claude-imported", source, selected: true, effective: true, trusted: false, plugins: [], dependents: [], errors: [], provenance: [] }; const managed = { ...imported, owner: "managed" as const };
    await expect(build(value, [imported]).service.refresh("official")).resolves.toMatchObject({ ok: false, code: "imported-readonly", message: expect.stringContaining("Claude Code") });
    await expect(build(value, [managed]).service.refresh("official")).resolves.toMatchObject({ ok: false, code: "managed-readonly", message: expect.stringContaining("administrator") });
    await expect(build(value, [imported, managed]).service.refresh("official")).resolves.toMatchObject({ ok: false, code: "ambiguous-marketplace" });
  });

  it("gives running operations point-of-use wait guidance without recovery or cancellation advice", async () => {
    const value = await fixture(); const entered = deferred<void>(); const release = deferred<void>(); let gated = false; const service = build(value, [], () => acquired(), "marketplace_running_guidance", { hit: async (phase) => { if (!gated && phase === "before-journal") { gated = true; entered.resolve(); await release.promise; } } }).service;
    const preview = await service.add("official", source); if (!preview.ok) throw new Error(preview.message); const bound = service.prepare(preview.value); if (!bound.ok) throw new Error(bound.message); const active = bound.value.execute(preview.value.confirmationDigest); await entered.promise;
    const reprepared = service.prepare(preview.value); const duplicate = await bound.value.execute(preview.value.confirmationDigest); const discarded = await service.discardPreview(preview.value.operationId); release.resolve(); expect((await active).ok).toBe(true); expect(reprepared).toMatchObject({ ok: false, code: "operation-running", message: expect.stringContaining("wait for its active execute result") }); expect(duplicate).toMatchObject({ ok: false, code: "operation-running", message: expect.stringContaining("wait for its active execute result") }); expect(JSON.stringify([reprepared, duplicate])).not.toContain("recovery"); expect(discarded).toMatchObject({ ok: false, message: expect.stringContaining("cancellation are unavailable") });
  });

  it("serializes truly overlapping contenders through an async post-lock transaction gate", async () => {
    const value = await fixture(); const entered = deferred<void>(); const release = deferred<void>(); let gated = false;
    const first = build(value, [], () => acquired(), "marketplace_first", { hit: async (phase) => { if (!gated && phase === "before-journal") { gated = true; entered.resolve(); await release.promise; } } }).service;
    const second = build(value, [], () => acquired(), "marketplace_second").service; const left = await first.add("official", source); const right = await second.add("official", source); const firstExecution = commit(first, left); await entered.promise; if (!right.ok) throw new Error(right.message); const secondBound = second.prepare(right.value); if (!secondBound.ok) throw new Error(secondBound.message); const overlapping = secondBound.value.execute(right.value.confirmationDigest); release.resolve();
    expect((await firstExecution).ok).toBe(true); expect(await overlapping).toMatchObject({ ok: false, code: "lock-busy" }); const stale = await secondBound.value.execute(right.value.confirmationDigest); expect(stale).toMatchObject({ ok: false, code: "mutation-not-committed", receipt: { outcome: "failed-before-commit", failureCategory: "stale-precondition", guidance: expect.stringContaining("new preview") } });
    expect(JSON.stringify(stale)).not.toContain("secret-user:secret-pass");
  });

  it("uses one captured observation for conflicts and dependents during asynchronous planning", async () => {
    const value = await fixture(); const rows: MarketplaceObservation[] = []; const entered = deferred<void>(); const release = deferred<void>(); const acquiredGate = vi.fn(async () => { entered.resolve(); await release.promise; return { ok: true as const, value: acquired() }; });
    const addService = new PluginMarketplaceService({ store: value.store, profilePath: value.profile, marketplaceSourceAnchor: value.project, checkoutFamilyKey: value.checkoutFamilyKey, observe: () => rows, acquire: acquiredGate, operationId: () => "marketplace_capture_add", planSettings: async ({ action, name, scope, value: descriptor, declarationOnly }) => planPluginSettingsWrite({ homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [], scope, mutation: { kind: "known-marketplace", key: name, ...(action === "remove" ? {} : { value: descriptor! }) }, declarationOnly }) });
    const planning = addService.add("official", source); await entered.promise; rows.push({ name: "official", owner: "claude-imported", source, selected: true, effective: true, trusted: false, plugins: [], dependents: [], errors: [], provenance: [] }); release.resolve(); const preview = await planning; expect(preview.ok).toBe(true); expect(await commit(addService, preview)).toMatchObject({ ok: false, code: "stale-observation" }); expect(fs.readdirSync(value.store.journalsRoot).filter((name) => name.startsWith("marketplace_capture_add"))).toEqual([]);

    rows.splice(0); const seedService = build(value, rows, () => acquired(), "marketplace_capture_seed").service; const seeded = await seedService.add("official", source); expect((await commit(seedService, seeded)).ok).toBe(true); if (!seeded.ok) return; rows.push(observed(seeded.value));
    const removeService = build(value, rows, () => acquired(), "marketplace_capture_remove", undefined, { hit: async (phase) => { if (phase === "after-settings") rows[0] = { ...rows[0]!, dependents: ["late@official"] }; } }).service; const removal = await removeService.remove("official", { registration: seeded.value.registration, acknowledgePreservedDependents: true }); expect(removal).toMatchObject({ ok: true, value: { dependents: [] } }); expect(await commit(removeService, removal)).toMatchObject({ ok: false, code: "stale-observation" }); expect(fs.readdirSync(value.store.journalsRoot).filter((name) => name.startsWith("marketplace_capture_remove"))).toEqual([]);
  });

  it("treats trust as confirmation-bound preview data and ignores unrelated observation presentation", async () => {
    const value = await fixture(); const rows: MarketplaceObservation[] = []; const service = build(value, rows, () => acquired(), "marketplace_stale_observation").service;
    const preview = await service.add("official", source); expect(preview).toMatchObject({ ok: true, value: { snapshot: { trust: { kind: "marketplace-snapshot-trust" } } } });
    expect(fs.existsSync(path.join(value.profile, "settings.json"))).toBe(false);
    const recordFiles = (root: string): string[] => fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? recordFiles(path.join(root, entry.name)) : entry.name === "record.json" ? [path.join(root, entry.name)] : []) : [];
    expect(recordFiles(value.store.recordsRoot)).toEqual([]);
    rows.push({ name: "other", owner: "claude-imported", source, selected: true, effective: true, trusted: false, plugins: [], dependents: [], errors: [], provenance: [] });
    await expect(commit(service, preview)).resolves.toMatchObject({ ok: true, value: { outcome: "committed" } });
    expect(await service.receipt("marketplace_stale_observation")).toMatchObject({ ok: true, value: { outcome: "committed" } });
  });

  it("rejects a terminal operation id before a randomized preparation can claim idempotent retry", async () => {
    const value = await fixture(); const first = build(value, [], () => acquired("a"), "marketplace_same_id").service; const left = await first.add("official", source); expect((await commit(first, left)).ok).toBe(true);
    const second = build(value, [], () => acquired("b"), "marketplace_same_id"); await expect(second.service.add("official", source)).resolves.toMatchObject({ ok: false, code: "terminal-operation-id" }); expect(second.acquire).not.toHaveBeenCalled();
  });

  it("reports same-name no-change only for identical authority and refuses bounded uncertainty", async () => {
    const value = await fixture(); const initialService = build(value, []).service; const initial = await initialService.add("official", source); expect((await commit(initialService, initial)).ok).toBe(true); if (!initial.ok) return;
    const exact = observed(initial.value); await expect(build(value, [exact], () => acquired(), "marketplace_no_change").service.add("official", source)).resolves.toMatchObject({ ok: false, code: "no-change" });
    const conflicts: MarketplaceObservation[] = [{ ...exact, owner: "claude-imported" }, { ...exact, source: { kind: "https-catalog", url: "https://other.example.org/catalog.json" } }, { ...exact, registration: { ...exact.registration!, scope: "project", checkoutFamilyKey: value.checkoutFamilyKey!, projectKey: value.checkoutFamilyKey! } }, { ...exact, snapshot: { ...exact.snapshot!, snapshotId: "marketplace-other" } }];
    for (const [index, conflict] of conflicts.entries()) await expect(build(value, [conflict], () => acquired(), `marketplace_conflict_${index}`).service.add("official", source)).resolves.toMatchObject({ ok: false, code: "same-name-conflict" });
    const imported = (index: number): MarketplaceObservation => ({ name: index === 256 ? "official" : `row-${index}`, owner: "claude-imported", source, selected: false, effective: false, trusted: false, plugins: [], dependents: [], errors: [], provenance: [] });
    const overflow = build(value, Array.from({ length: 257 }, (_, index) => imported(index))).service; expect(overflow.listStatus()).toMatchObject({ omitted: 1, uncertain: true });
    expect(overflow.details("official")).toMatchObject({ ok: false, code: "observation-overflow" }); await expect(overflow.refresh("official")).resolves.toMatchObject({ ok: false, code: "observation-uncertain" });
  });

  it("anchors project/local relative declarations to the canonical main checkout for files and directories", async () => {
    const family = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picc-marketplace-anchor-"))); roots.push(family); const main = path.join(family, "main"); const active = path.join(family, "active"); const admin = path.join(main, ".git", "worktrees", "active"); fs.mkdirSync(admin, { recursive: true }); fs.mkdirSync(active); fs.writeFileSync(path.join(active, ".git"), `gitdir: ${admin}\n`); fs.writeFileSync(path.join(admin, "gitdir"), `${path.join(active, ".git")}\n`); fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
    const anchor = marketplaceSourceAnchor(active); expect(anchor).toEqual({ ok: true, value: fs.realpathSync.native(main) }); if (!anchor.ok) return;
    const directory = path.join(main, "plugins", "catalog"); const file = path.join(main, "catalogs", "marketplace.json");
    expect(marketplaceSettingsDeclaration({ kind: "local-directory", path: directory }, "project", anchor.value)).toMatchObject({ ok: true, value: { kind: "directory", path: "./plugins/catalog", localPath: "./plugins/catalog" } });
    expect(marketplaceSettingsDeclaration({ kind: "local-catalog-file", path: file }, "local", anchor.value)).toMatchObject({ ok: true, value: { kind: "file", path: "./catalogs/marketplace.json", localPath: "./catalogs/marketplace.json" } });
    expect(marketplaceSettingsDeclaration({ kind: "local-directory", path: directory }, "user", anchor.value)).toMatchObject({ ok: true, value: { path: directory } });
    expect(marketplaceSettingsDeclaration({ kind: "local-catalog-file", path: path.join(active, "marketplace.json") }, "project", anchor.value)).toMatchObject({ ok: false, code: "source-outside-project" });
  });

  it("uses reconstructed codecs and deterministic ownership takeover for fresh-service complete and rollback", async () => {
    for (const action of ["complete", "rollback"] as const) {
      const value = await fixture(); let interrupted = false; const id = `marketplace_fresh_${action}`; const service = build(value, [], () => acquired(), id, { hit: (phase, index) => { if (!interrupted && phase === "after-replacement" && index === 0) { interrupted = true; throw new Error("interrupt"); } } }).service; const preview = await service.add("official", source); expect(await commit(service, preview)).toMatchObject({ ok: false, code: "pending-recovery" }); if (!preview.ok) continue;
      const fresh = build(value, [], () => acquired(), "unused", undefined, undefined, { observe: async () => ({ state: "absent" }) }).service; expect(await fresh.recoveryStatus(id)).toMatchObject({ ok: true, value: { actions: ["complete", "rollback"] } }); expect(await fresh.recover(id, action)).toMatchObject({ ok: true, value: { outcome: action === "complete" ? "committed" : "rolled-back" } });
      const settings = path.join(value.profile, "settings.json"); const registrationTarget = preview.value.participants.at(-1)!.target;
      if (action === "complete") { expect(fs.readFileSync(settings, "utf8")).toContain("official"); expect(JSON.parse(fs.readFileSync(registrationTarget, "utf8")).payload.name).toBe("official"); }
      else { expect(fs.existsSync(settings)).toBe(false); expect(fs.existsSync(registrationTarget)).toBe(false); }
    }
  });

  it("completes and rolls back marketplace pending state in genuinely fresh processes", async () => {
    const script = String.raw`
      import { createHash } from "node:crypto";
      import path from "node:path";
      import { createLifecycleLocations } from "./src/plugin-lifecycle/locations.ts";
      import { PluginMarketplaceService } from "./src/plugin-lifecycle/marketplace-service.ts";
      import { planPluginSettingsWrite } from "./src/plugin-lifecycle/settings-plan.ts";
      import { establishOwnedStateStore } from "./src/plugin-lifecycle/state-store.ts";
      const home = process.env.HOME_DIR; const profile = process.env.PROFILE_DIR; const project = process.env.PROJECT_DIR; const operationId = process.env.OP_ID; const action = process.env.ACTION; const mode = process.env.MODE;
      const locations = createLifecycleLocations({ homeDir: home, profilePath: profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: project, checkoutFamilyPath: project } }); if (!locations.ok) throw new Error(locations.error.message); const established = await establishOwnedStateStore(locations.value, home); if (!established.ok) throw new Error(established.message); const store = established.value;
      const source = { kind: "https-catalog", url: "https://catalog.example.org/catalog.json" }; const catalogBytes = Buffer.from(JSON.stringify({ name: "official", owner: { name: "Example" }, plugins: [] })); const catalogDigest = "sha256:" + createHash("sha256").update(catalogBytes).digest("hex"); const snapshotId = "marketplace-" + createHash("sha256").update(catalogDigest + "\0" + source.url).digest("base64url");
      let interrupted = false; const service = new PluginMarketplaceService({ store, profilePath: profile, marketplaceSourceAnchor: project, checkoutFamilyKey: locations.value.checkoutFamilyKey, observe: () => [], operationId: () => operationId, acquire: async () => ({ ok: true, value: { target: { authorityKind: "catalog-only", marketplaceName: "official", snapshotId, source, catalogDigest, provenance: { adapter: "public-https-catalog", canonicalUrl: source.url } }, catalogBytes } }), ...(mode === "create" ? { transactionFaults: { hit(phase, index) { if (!interrupted && phase === "after-replacement" && index === 0) { interrupted = true; throw new Error("pending-child"); } } } } : {}), planSettings: async ({ action: mutationAction, name, scope, value, declarationOnly }) => planPluginSettingsWrite({ homeDir: home, profilePath: profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: project, checkoutFamilyPath: project }, projectRoot: project, cwd: project, managedPaths: [], scope, mutation: { kind: "known-marketplace", key: name, ...(mutationAction === "remove" ? {} : { value }) }, declarationOnly }) });
      if (mode === "create") { const preview = await service.add("official", source); if (!preview.ok) throw new Error(preview.message); const bound = service.prepare(preview.value); if (!bound.ok) throw new Error(bound.message); const result = await bound.value.execute(preview.value.confirmationDigest); console.log(JSON.stringify({ result, registrationTarget: preview.value.participants.at(-1).target })); }
      else { const status = await service.recoveryStatus(operationId); const result = await service.recover(operationId, action); console.log(JSON.stringify({ status, result })); }
    `;
    const before = marketplaceChildLaunches;
    for (const action of ["complete", "rollback"] as const) {
      const value = await fixture(); const operationId = `marketplace_process_${action}`; const env = { HOME_DIR: value.home, PROFILE_DIR: value.profile, PROJECT_DIR: value.project, OP_ID: operationId, ACTION: action };
      const created = JSON.parse(await runMarketplaceChild(script, { ...env, MODE: "create" })) as { result: unknown; registrationTarget: string }; expect(created.result).toMatchObject({ ok: false, code: "pending-recovery" }); const recovered = JSON.parse(await runMarketplaceChild(script, { ...env, MODE: "recover" })); expect(recovered).toMatchObject({ status: { ok: true, value: { actions: ["complete", "rollback"] } }, result: { ok: true, value: { outcome: action === "complete" ? "committed" : "rolled-back" } } });
      const settings = path.join(value.profile, "settings.json"); expect(fs.existsSync(settings)).toBe(action === "complete"); expect(fs.existsSync(created.registrationTarget)).toBe(action === "complete"); if (action === "complete") { expect(JSON.parse(fs.readFileSync(settings, "utf8")).extraKnownMarketplaces.official).toBeDefined(); expect(JSON.parse(fs.readFileSync(created.registrationTarget, "utf8")).payload.name).toBe("official"); }
    }
    expect(marketplaceChildLaunches - before).toBe(4);
  }, 30_000);

  it("exposes validated recovery status to a genuinely fresh service", async () => {
    const value = await fixture(); let interrupted = false; const faults = { hit: (phase: string, index?: number) => { if (!interrupted && phase === "after-replacement" && index === 0) { interrupted = true; throw new Error("interrupt"); } } } as import("../src/plugin-lifecycle/transaction.js").TransactionFaultSeam;
    const service = build(value, [], () => acquired(), "marketplace_fresh_status", faults).service; const preview = await service.add("official", source); expect((await commit(service, preview)).ok).toBe(false);
    const fresh = build(value, [], () => acquired(), "unused").service; await expect(fresh.recoveryStatus("marketplace_fresh_status")).resolves.toMatchObject({ ok: true, value: { summary: { action: "add", catalog: { ownerName: "Example" } }, completed: 1, actions: ["complete", "rollback"] } });
  });

  it("independently refuses stale source, owner/effective, catalog, and dependent observations before journaling", async () => {
    const mutations: Array<(row: MarketplaceObservation) => MarketplaceObservation> = [
      (row) => ({ ...row, source: { kind: "https-catalog", url: "https://other.example.org/catalog.json" } }),
      (row) => ({ ...row, owner: "claude-imported", effective: false }),
      (row) => ({ ...row, catalog: { ...row.catalog!, ownerName: "Changed owner" } }),
      (row) => ({ ...row, dependents: ["new-dependent@official"] }),
    ];
    for (const [index, mutate] of mutations.entries()) {
      const value = await fixture(); const initialService = build(value, [], () => acquired(), `marketplace_stale_seed_${index}`).service; const initial = await initialService.add("official", source); expect((await commit(initialService, initial)).ok).toBe(true); if (!initial.ok) continue;
      const rows = [observed(initial.value)]; const service = build(value, rows, () => acquired("b"), `marketplace_stale_${index}`).service; const preview = await service.refresh("official", { registration: initial.value.registration }); if (!preview.ok) throw new Error(preview.message);
      rows[0] = mutate(rows[0]!); await expect(commit(service, preview)).resolves.toMatchObject({ ok: false, code: "stale-observation" }); expect(fs.readdirSync(value.store.journalsRoot).filter((name) => name.startsWith(`marketplace_stale_${index}.`))).toEqual([]);
    }
  });

  it("retains t08 settings authority as an independent close-to-use precondition", async () => {
    const value = await fixture(); const service = build(value, [], () => acquired(), "marketplace_stale_settings").service; const preview = await service.add("official", source); if (!preview.ok) throw new Error(preview.message);
    fs.writeFileSync(path.join(value.project, ".claude", "settings.json"), JSON.stringify({ extraKnownMarketplaces: { other: { source: { source: "url", url: "https://example.org/catalog.json" } } } }));
    await expect(commit(service, preview)).resolves.toMatchObject({ ok: false, code: "mutation-not-committed", receipt: { outcome: "failed-before-commit", failureCategory: "storage-failure" } });
  });

  it("cleans operation-owned preparation prefixes while retaining unrelated staging canaries", async () => {
    for (const phase of ["after-settings", "after-snapshot", "after-registration", "before-compound-prepare"] as const) {
      const value = await fixture(); const canary = path.join(value.store.stagingRoot, `canary-${phase}`); fs.writeFileSync(canary, "unrelated");
      const service = build(value, [], () => acquired(), `marketplace_fault_${phase}`, undefined, { hit: (current) => { if (current === phase) throw new Error("preparation fault"); } }).service;
      await expect(service.add("official", source)).resolves.toMatchObject({ ok: false, code: "preparation-failure" }); expect(fs.readFileSync(canary, "utf8")).toBe("unrelated"); expect(fs.readdirSync(value.store.stagingRoot)).toEqual([`canary-${phase}`]);
    }
  });

  it("keeps visible unsupported declarations listable and refreshable/removable", async () => {
    const value = await fixture(); const bytes = Buffer.from(JSON.stringify({ name: "official", owner: { name: "Example" }, plugins: [{ name: "future-tool", source: { source: "future" } }] })); const catalogDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256; const unsupported: AcquiredMarketplaceSnapshot = { target: { ...acquired().target, catalogDigest, snapshotId: snapshotId(catalogDigest, source.url) }, catalogBytes: bytes };
    const addService = build(value, [], () => unsupported, "marketplace_unsupported_add").service; const added = await addService.add("official", source); expect(added).toMatchObject({ ok: true, value: { catalog: { unsupportedEntries: 1, omittedEntries: 0, plugins: [{ name: "future-tool", supported: false }] } } }); expect((await commit(addService, added)).ok).toBe(true); if (!added.ok) return;
    const row = observed(added.value); expect(build(value, [row], () => unsupported, "marketplace_unsupported_view").service.details("official")).toMatchObject({ ok: true, value: { catalog: { unsupportedEntries: 1, omittedEntries: 0 }, selected: true } });
    const refreshService = build(value, [row], () => unsupported, "marketplace_unsupported_refresh").service; const refreshed = await refreshService.refresh("official", { registration: added.value.registration }); expect(refreshed.ok).toBe(true); if (refreshed.ok) await refreshService.discardPreview(refreshed.value.operationId);
    const removeService = build(value, [row], () => unsupported, "marketplace_unsupported_remove").service; const removed = await removeService.remove("official", { registration: added.value.registration, acknowledgePreservedDependents: true }); expect((await commit(removeService, removed)).ok).toBe(true);
  });

  it("suppresses contradictory owned authority and uses code-owned diagnostics", async () => {
    const value = await fixture(); const addService = build(value, [], () => acquired(), "marketplace_view_seed").service; const added = await addService.add("official", source); expect((await commit(addService, added)).ok).toBe(true); if (!added.ok) return; const mismatch = { ...observed(added.value), effective: true, snapshot: { ...added.value.snapshot, snapshotId: "marketplace-other" as const }, errors: ["credential-user:credential-pass"] };
    const view = build(value, [mismatch], () => acquired(), "marketplace_view_mismatch").service.details("official"); expect(view).toMatchObject({ ok: true, value: { selected: false, effective: false, trusted: false, diagnostics: expect.arrayContaining(["Marketplace authority relationships are uncertain"]) } }); expect(JSON.stringify(view)).not.toContain("credential-user:credential-pass");
  });

  it("binds catalog bytes to digest and derives source-context classification in the service", async () => {
    const value = await fixture(); const relativeBytes = Buffer.from(JSON.stringify({ name: "official", owner: { name: "Example" }, plugins: [{ name: "tool", source: "./tool" }] })); const catalogDigest = `sha256:${createHash("sha256").update(relativeBytes).digest("hex")}` as Sha256; const contextual: AcquiredMarketplaceSnapshot = { target: { ...acquired().target, catalogDigest, snapshotId: snapshotId(catalogDigest, source.url) }, catalogBytes: relativeBytes };
    const preview = await build(value, [], () => contextual, "marketplace_contextual_catalog").service.add("official", source); expect(preview).toMatchObject({ ok: true, value: { catalog: { plugins: [{ name: "tool", supported: false }], unsupportedEntries: 1, omittedEntries: 0 } } });
    const mismatch = { ...contextual, catalogBytes: Buffer.from(relativeBytes.toString().replace("tool", "other")) }; await expect(build(value, [], () => mismatch, "marketplace_catalog_mismatch").service.add("official", source)).resolves.toMatchObject({ ok: false, code: "catalog-digest-mismatch" });
    const omittedBytes = Buffer.from(JSON.stringify({ name: "official", owner: { name: "Example" }, plugins: [null] })); const omittedDigest = `sha256:${createHash("sha256").update(omittedBytes).digest("hex")}` as Sha256; const omitted = { target: { ...acquired().target, catalogDigest: omittedDigest, snapshotId: snapshotId(omittedDigest, source.url) }, catalogBytes: omittedBytes }; await expect(build(value, [], () => omitted, "marketplace_catalog_omitted").service.add("official", source)).resolves.toMatchObject({ ok: false, code: "catalog-omitted" });
  });

  it("cleans only operation-owned preparation evidence when preview validation fails", async () => {
    const value = await fixture(); const invalid = acquired(); const service = build(value, [], () => ({ ...invalid, catalogBytes: Buffer.from(JSON.stringify({ name: "official", owner: { name: "Example" }, plugins: Array.from({ length: 1025 }, (_, index) => ({ name: `tool-${index}`, source: { source: "npm", package: `tool-${index}`, registry: "https://registry.npmjs.org" } })) })) }), "marketplace_cleanup").service;
    await expect(service.add("official", source)).resolves.toMatchObject({ ok: false, code: "catalog-digest-mismatch" }); expect(fs.readdirSync(value.store.stagingRoot)).toEqual([]);
  });

  it("gives seed ownership distinct actionable refusal guidance", async () => {
    const value = await fixture(); const seed: MarketplaceObservation = { name: "official", owner: "seed", source, selected: true, effective: true, trusted: false, plugins: [], dependents: [], errors: [], provenance: [] };
    await expect(build(value, [seed]).service.refresh("official")).resolves.toMatchObject({ ok: false, code: "seed-readonly", message: expect.stringContaining("configured seed source") });
  });

  it("keeps removal observation credential canaries out of preview, pending status, and receipt", async () => {
    const value = await fixture(); const addService = build(value, [], () => acquired(), "marketplace_remove_secret_seed").service; const added = await addService.add("official", source); expect((await commit(addService, added)).ok).toBe(true); if (!added.ok) return; const secret = "credential-remove-user:credential-remove-pass"; const row = { ...observed(added.value), catalog: { ...added.value.catalog, ownerName: secret, plugins: added.value.catalog.plugins.map((plugin) => plugin.supported ? plugin : { ...plugin, error: secret }) }, plugins: added.value.catalog.plugins, errors: [secret], provenance: [secret] };
    let interrupted = false; const service = build(value, [row], () => acquired(), "marketplace_remove_secret", { hit: (phase, index) => { if (!interrupted && phase === "after-replacement" && index === 0) { interrupted = true; throw new Error(secret); } } }).service; const preview = await service.remove("official", { registration: added.value.registration, acknowledgePreservedDependents: true }); expect(JSON.stringify(preview)).not.toContain(secret); expect(await commit(service, preview)).toMatchObject({ ok: false, code: "pending-recovery" }); expect(JSON.stringify(await service.recoveryStatus("marketplace_remove_secret"))).not.toContain(secret); expect(JSON.stringify(await service.recover("marketplace_remove_secret", "complete"))).not.toContain(secret);
  });

  it("keeps catalog credential canaries out of preview, recovery status, and receipt views", async () => {
    const value = await fixture(); const secret = "credential-user:credential-pass"; const bytes = Buffer.from(JSON.stringify({ name: "official", owner: { name: secret }, plugins: [] })); const catalogDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256; const next: AcquiredMarketplaceSnapshot = { target: { ...acquired().target, catalogDigest, snapshotId: snapshotId(catalogDigest, source.url) }, catalogBytes: bytes }; let interrupted = false;
    const service = build(value, [], () => next, "marketplace_secret_status", { hit: (phase, index) => { if (!interrupted && phase === "after-replacement" && index === 0) { interrupted = true; throw new Error(secret); } } }).service; const preview = await service.add("official", source); expect(JSON.stringify(preview)).not.toContain(secret); expect(await commit(service, preview)).toMatchObject({ ok: false, code: "pending-recovery" }); const status = await service.recoveryStatus("marketplace_secret_status"); expect(JSON.stringify(status)).not.toContain(secret); const receipt = await service.recover("marketplace_secret_status", "complete"); expect(JSON.stringify(receipt)).not.toContain(secret);
  });

  it("rejects credential-bearing sources before acquisition without disclosing secret canaries", async () => {
    const value = await fixture(); const { service, acquire } = build(value, []); const secret = "secret-user:secret-pass";
    const result = await service.add("official", { kind: "https-git", url: `https://${secret}@example.org/catalog.git` }); expect(result).toMatchObject({ ok: false, code: "unsafe-source" });
    expect(JSON.stringify(result)).not.toContain(secret); expect(acquire).not.toHaveBeenCalled();
  });

  it("rejects independently tampered persisted participants, locks, summary, plan, and outcome", async () => {
    const value = await fixture(); const service = build(value, [], () => acquired(), "marketplace_receipt_tamper").service; const preview = await service.add("official", source); expect((await commit(service, preview)).ok).toBe(true);
    const receiptPath = path.join(value.store.receiptsRoot, "marketplace_receipt_tamper.json"); const original = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, any>;
    const mutations = [
      { ...original, participants: original.participants.map((item: any, index: number) => index === 1 ? { ...item, producerEvidence: { ...item.producerEvidence, payload: { ...item.producerEvidence.payload, catalogDigest: digest("b") } } } : item) },
      { ...original, requiredLocks: original.requiredLocks.map((item: any, index: number) => index === 0 ? { ...item, key: `${item.key}-changed` } : item) },
      { ...original, confirmationSummary: { ...original.confirmationSummary, catalog: { ...original.confirmationSummary.catalog, ownerName: "Changed" } } },
      { ...original, planDigest: digest("b") }, { ...original, outcome: "rolled-back" },
    ];
    for (const mutation of mutations) {
      const bytes = canonicalJsonBytes(mutation); if (!bytes.ok) throw new Error(bytes.message); fs.writeFileSync(receiptPath, bytes.value);
      await expect(build(value, [], () => acquired(), "unused").service.receipt("marketplace_receipt_tamper")).resolves.toMatchObject({ ok: false });
    }
    const restored = canonicalJsonBytes(original); if (!restored.ok) throw new Error(restored.message); fs.writeFileSync(receiptPath, restored.value);
  });
});

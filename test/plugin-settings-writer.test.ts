import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/discovery/settings.js";
import { createLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { establishOwnedStateStore } from "../src/plugin-lifecycle/state-store.js";
import { acquireLifecycleLocks, releaseLifecycleLocks } from "../src/plugin-lifecycle/locks.js";
import { executeTransaction } from "../src/plugin-lifecycle/transaction.js";
import { planPluginSettingsWrite, renderPluginSettingsEdit } from "../src/plugin-lifecycle/settings-plan.js";
import { createPluginSettingsTransactionCodec, preparePluginSettingsWrite } from "../src/plugin-lifecycle/settings-writer.js";

const roots: string[] = [];
function temporary(): string { const value = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picc-settings-writer-"))); roots.push(value); return value; }
afterEach(() => { while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });
function probeDirectoryAlias(): boolean { const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-settings-alias-probe-")); try { const outside = path.join(root, "outside"); fs.mkdirSync(outside); const alias = path.join(root, "alias"); fs.symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir"); return fs.lstatSync(alias).isSymbolicLink(); } catch { return false; } finally { fs.rmSync(root, { recursive: true, force: true }); } }
function probeUnreadableFile(): boolean { if (process.platform === "win32" || process.getuid?.() === 0) return false; const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-settings-unreadable-probe-")); const candidate = path.join(root, "settings.json"); try { fs.writeFileSync(candidate, "{}"); fs.chmodSync(candidate, 0o000); try { fs.readFileSync(candidate); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "EACCES"; } } finally { try { fs.chmodSync(candidate, 0o600); } catch {} fs.rmSync(root, { recursive: true, force: true }); } }
const DIRECTORY_ALIAS_SUPPORTED = probeDirectoryAlias();
const UNREADABLE_FILE_SUPPORTED = probeUnreadableFile();

function fixture() {
  const home = temporary(); const profile = path.join(home, ".claude"); const project = path.join(home, "project");
  fs.mkdirSync(profile); fs.mkdirSync(path.join(project, ".git"), { recursive: true }); fs.mkdirSync(path.join(project, ".claude"));
  const locationsResult = createLifecycleLocations({ homeDir: home, profilePath: profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: project, checkoutFamilyPath: project } });
  if (!locationsResult.ok) throw new Error("locations");
  return { home, profile, project, locations: locationsResult.value };
}

async function commit(inputs: ReturnType<typeof fixture>, scope: "user" | "project" | "local", operationId: string, mutation: Parameters<typeof planPluginSettingsWrite>[0]["mutation"], declarationOnly = false) {
  const plan = await planPluginSettingsWrite({ homeDir: inputs.home, profilePath: inputs.profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: inputs.project, checkoutFamilyPath: inputs.project }, projectRoot: inputs.project, cwd: inputs.project, managedPaths: [], scope, mutation, declarationOnly });
  if (!plan.ok) throw new Error(`${plan.code}: ${plan.message}`); expect(plan.ok).toBe(true);
  const storeResult = await establishOwnedStateStore(inputs.locations, inputs.home); expect(storeResult.ok).toBe(true); if (!storeResult.ok) throw new Error(storeResult.message);
  const prepared = await preparePluginSettingsWrite({ store: storeResult.value, operationId, profilePath: inputs.profile, plan: plan.value });
  if (!prepared.ok) throw new Error(`${prepared.code}: ${prepared.message}`); expect(prepared.ok).toBe(true);
  const lease = await acquireLifecycleLocks({ store: storeResult.value, operationId, identities: prepared.value.transaction.requiredLocks }); expect(lease.ok).toBe(true); if (!lease.ok) throw new Error(lease.message);
  try { const outcome = await executeTransaction(storeResult.value, prepared.value.transaction, { lease: lease.value }); expect(outcome.state).toBe("committed"); }
  finally { await releaseLifecycleLocks(lease.value); }
  return { plan: plan.value, prepared: prepared.value, store: storeResult.value };
}

describe("plugin settings writer", () => {
  it("preserves JSONC formatting and exact target mode without chmoding an adjacent same-prefix/same-digest canary", async () => {
    const value = fixture(); const target = path.join(value.profile, "settings.json");
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{\r\n\t// retained\r\n\t"unknown": 7,\r\n\t"enabledPlugins": {\r\n\t\t"old@official": false,\r\n\t},\r\n}\r\n')]); fs.writeFileSync(target, original, { mode: 0o640 });
    const inputs = { homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" as const : "posix" as const, project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [], scope: "user" as const, mutation: { kind: "enabled-plugin" as const, key: "new@official", value: true } };
    const plan = await planPluginSettingsWrite(inputs); if (!plan.ok) throw new Error(plan.message); const store = await establishOwnedStateStore(value.locations, value.home); if (!store.ok) throw new Error(store.message); const prepared = await preparePluginSettingsWrite({ store: store.value, operationId: "settings_user", profilePath: value.profile, plan: plan.value }); if (!prepared.ok) throw new Error(prepared.message);
    const canary = `${target}.tmp-${process.pid}-mode-canary`; fs.writeFileSync(canary, plan.value.replacementBytes, { mode: 0o777 }); const canaryMode = fs.statSync(canary).mode & 0o777; const held = await acquireLifecycleLocks({ store: store.value, operationId: "settings_user", identities: prepared.value.transaction.requiredLocks }); if (!held.ok) throw new Error(held.message); try { expect(await executeTransaction(store.value, prepared.value.transaction, { lease: held.value })).toMatchObject({ state: "committed" }); } finally { await releaseLifecycleLocks(held.value); }
    const bytes = fs.readFileSync(target); const text = bytes.toString("utf8"); expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf])); expect(text).toContain("// retained\r\n"); expect(text).toContain('"unknown": 7'); expect(text).toContain('"old@official": false'); expect(text).toContain('"new@official": true'); expect(fs.statSync(canary).mode & 0o777).toBe(canaryMode);
    if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o640); expect(loadSettings({ cwd: value.project, projectRoot: value.project, userDir: value.profile, managedPaths: [] }).effectivePluginEnablement?.["new@official"]).toMatchObject({ enabled: true, scope: "user", source: target });

    const refused = fixture(); const refusedTarget = path.join(refused.profile, "settings.json"); fs.writeFileSync(refusedTarget, "{}\n", { mode: 0o640 }); const refusedPlan = await planPluginSettingsWrite({ ...inputs, homeDir: refused.home, profilePath: refused.profile, project: { activeCheckoutPath: refused.project, checkoutFamilyPath: refused.project }, projectRoot: refused.project, cwd: refused.project }); if (!refusedPlan.ok) throw new Error(refusedPlan.message); const refusedStore = await establishOwnedStateStore(refused.locations, refused.home); if (!refusedStore.ok) throw new Error(refusedStore.message); const refusedPrepared = await preparePluginSettingsWrite({ store: refusedStore.value, operationId: "settings_refused", profilePath: refused.profile, plan: refusedPlan.value }); if (!refusedPrepared.ok) throw new Error(refusedPrepared.message); const refusedCanary = `${refusedTarget}.tmp-${process.pid}-mode-canary`; fs.writeFileSync(refusedCanary, refusedPlan.value.replacementBytes, { mode: 0o777 }); const refusedCanaryMode = fs.statSync(refusedCanary).mode & 0o777; fs.writeFileSync(path.join(refused.project, ".claude", "settings.local.json"), '{"enabledPlugins":{"new@official":false}}\n'); const refusedLease = await acquireLifecycleLocks({ store: refusedStore.value, operationId: "settings_refused", identities: refusedPrepared.value.transaction.requiredLocks }); if (!refusedLease.ok) throw new Error(refusedLease.message); try { expect(await executeTransaction(refusedStore.value, refusedPrepared.value.transaction, { lease: refusedLease.value })).toMatchObject({ state: "failed-before-commit" }); } finally { await releaseLifecycleLocks(refusedLease.value); } expect(fs.readFileSync(refusedTarget, "utf8")).toBe("{}\n"); expect(fs.statSync(refusedCanary).mode & 0o777).toBe(refusedCanaryMode); if (process.platform !== "win32") expect(fs.statSync(refusedTarget).mode & 0o777).toBe(0o640);
  });

  it("creates and removes exact project/local declarations without touching sibling fields", async () => {
    const value = fixture();
    await commit(value, "project", "settings_project", { kind: "enabled-plugin", key: "alpha@official", value: true });
    await commit(value, "local", "settings_local", { kind: "known-marketplace", key: "team", value: { kind: "github", repo: "owner/catalog", ref: "main" } });
    await commit(value, "project", "settings_remove", { kind: "enabled-plugin", key: "alpha@official" });
    expect(JSON.parse(fs.readFileSync(path.join(value.project, ".claude", "settings.json"), "utf8"))).toEqual({ enabledPlugins: {} });
    const local = JSON.parse(fs.readFileSync(path.join(value.project, ".claude", "settings.local.json"), "utf8"));
    expect(local.extraKnownMarketplaces.team).toEqual({ source: { source: "github", repo: "owner/catalog", ref: "main" } });
  });

  it("creates the one missing .claude parent only after preparation and commits the absent file", async () => {
    const value = fixture(); fs.rmSync(path.join(value.project, ".claude"), { recursive: true });
    const result = await commit(value, "project", "missing_parent", { kind: "enabled-plugin", key: "alpha@official", value: true });
    expect(process.platform === "win32" ? result.plan.missingParent?.path.toLowerCase() : result.plan.missingParent?.path).toBe(process.platform === "win32" ? path.join(value.project, ".claude").toLowerCase() : path.join(value.project, ".claude"));
    expect(JSON.parse(fs.readFileSync(path.join(value.project, ".claude", "settings.json"), "utf8"))).toEqual({ enabledPlugins: { "alpha@official": true } });
  });

  it("targets and executes local scope at the active root when canonical project root equals home", async () => {
    const home = temporary(); const profile = path.join(home, ".claude-profile"); fs.mkdirSync(profile); fs.mkdirSync(path.join(home, ".git")); fs.mkdirSync(path.join(home, ".claude")); const platform = process.platform === "win32" ? "win32" as const : "posix" as const;
    const locations = createLifecycleLocations({ homeDir: home, profilePath: profile, platform, project: { activeCheckoutPath: home, checkoutFamilyPath: home } }); if (!locations.ok) throw new Error("locations");
    const plan = await planPluginSettingsWrite({ homeDir: home, profilePath: profile, platform, project: { activeCheckoutPath: home, checkoutFamilyPath: home }, projectRoot: home, cwd: home, managedPaths: [], scope: "local", mutation: { kind: "enabled-plugin", key: "home@official", value: true } }); if (!plan.ok) throw new Error(plan.message); expect(process.platform === "win32" ? plan.value.targetPath.toLowerCase() : plan.value.targetPath).toBe(process.platform === "win32" ? path.join(home, ".claude", "settings.local.json").toLowerCase() : path.join(home, ".claude", "settings.local.json"));
    const store = await establishOwnedStateStore(locations.value, home); if (!store.ok) throw new Error(store.message); const prepared = await preparePluginSettingsWrite({ store: store.value, operationId: "home_exception", profilePath: profile, plan: plan.value }); if (!prepared.ok) throw new Error(prepared.message); const held = await acquireLifecycleLocks({ store: store.value, operationId: "home_exception", identities: prepared.value.transaction.requiredLocks }); if (!held.ok) throw new Error(held.message); try { expect(await executeTransaction(store.value, prepared.value.transaction, { lease: held.value })).toMatchObject({ state: "committed" }); } finally { await releaseLifecycleLocks(held.value); }
    expect(loadSettings({ cwd: home, projectRoot: home, userDir: profile, managedPaths: [] }).effectivePluginEnablement?.["home@official"]).toMatchObject({ enabled: true, scope: "local", source: path.join(home, ".claude", "settings.local.json") });
  });

  it("refuses shadowed edits by default and labels explicit declaration-only effects", async () => {
    const value = fixture(); const managed = path.join(value.home, "managed.json"); fs.writeFileSync(managed, JSON.stringify({ enabledPlugins: { "alpha@official": false } }));
    const base = { homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" as const : "posix" as const, project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [managed], scope: "project" as const, mutation: { kind: "enabled-plugin" as const, key: "alpha@official", value: true } };
    await expect(planPluginSettingsWrite(base)).resolves.toMatchObject({ ok: false, code: "ineffective-declaration" });
    const allowed = await planPluginSettingsWrite({ ...base, declarationOnly: true }); expect(allowed.ok).toBe(true); if (!allowed.ok) return;
    expect(allowed.value.summary).toMatchObject({ declarationOnly: true, effective: false, declarationAfter: { present: true, value: true }, effectiveAfter: { present: true, value: false, scope: "managed" } });
    const sameValue = await planPluginSettingsWrite({ ...base, mutation: { kind: "enabled-plugin", key: "alpha@official", value: false }, declarationOnly: true }); expect(sameValue.ok).toBe(true); if (!sameValue.ok) return;
    expect(sameValue.value.summary).toMatchObject({ declarationOnly: true, effective: false, effectiveAfter: { value: false, scope: "managed", source: managed } });
    const store = await establishOwnedStateStore(value.locations, value.home); if (!store.ok) throw new Error(store.message);
    const prepared = await preparePluginSettingsWrite({ store: store.value, operationId: "same_shadow", profilePath: value.profile, plan: sameValue.value }); expect(prepared.ok).toBe(true); if (!prepared.ok) return;
    const participant = prepared.value.transaction.participants[0]!; const evidence = participant.producerEvidence as Record<string, unknown>; const summary = evidence.summary as Record<string, unknown>; const effectiveAfter = summary.effectiveAfter as Record<string, unknown>;
    const forged = { ...participant, producerEvidence: { ...evidence, summary: { ...summary, effectiveAfter: { ...effectiveAfter, source: sameValue.value.targetPath } } } };
    expect(prepared.value.codec.requiredLocks(sameValue.value.summary, [forged])).toMatchObject({ ok: false });
  });

  it("patches supported marketplace source semantics while preserving optional fields and nested comments", () => {
    const original = Buffer.from('{\n  "extraKnownMarketplaces": {\n    "team": {\n      "autoUpdate": false,\n      "source": {\n        // retained\n        "source": "github",\n        "repo": "old/catalog",\n        "skipLfs": true\n      }\n    }\n  }\n}\n');
    const edited = renderPluginSettingsEdit(original, "user", { kind: "known-marketplace", key: "team", value: { kind: "github", repo: "new/catalog", ref: "main" } }); expect(edited.ok).toBe(true); if (!edited.ok) return;
    const text = edited.value.toString("utf8"); expect(text).toContain("// retained"); expect(text).toContain('"autoUpdate": false'); expect(text).toContain('"skipLfs": true'); expect(text).toContain('"repo": "new/catalog"');
    expect(renderPluginSettingsEdit(Buffer.from('{"extraKnownMarketplaces":{"team":{"source":{"source":"url","url":"https://example.test/catalog.json"},"headers":{"Authorization":"secret"}}}}'), "user", { kind: "known-marketplace", key: "team", value: { kind: "url", url: "https://example.test/new.json" } })).toMatchObject({ ok: false, code: "unsupported-marketplace-entry" });
  });

  it("plans, prepares, executes, and normally reloads commented marketplace edits with same-name precedence", async () => {
    const value = fixture(); const userTarget = path.join(value.profile, "settings.json"); fs.writeFileSync(userTarget, '{\n  "extraKnownMarketplaces": {\n    "team": {\n      "autoUpdate": false,\n      "source": {\n        // retained option context\n        "source": "github",\n        "repo": "old/catalog",\n        "skipLfs": true\n      }\n    }\n  }\n}\n');
    const committed = await commit(value, "user", "market_full", { kind: "known-marketplace", key: "team", value: { kind: "github", repo: "new/catalog", ref: "main" } }); const text = fs.readFileSync(userTarget, "utf8"); expect(text).toContain("// retained option context"); expect(text).toContain('"autoUpdate": false'); expect(text).toContain('"skipLfs": true');
    expect(committed.plan.summary.effectiveAfter).toMatchObject({ present: true, value: { kind: "github", repo: "new/catalog", ref: "main" }, scope: "user", source: userTarget });
    fs.writeFileSync(path.join(value.project, ".claude", "settings.json"), JSON.stringify({ extraKnownMarketplaces: { team: { source: { source: "github", repo: "project/catalog" } } } })); const loaded = loadSettings({ cwd: value.project, projectRoot: value.project, userDir: value.profile, managedPaths: [] }); const winner = loaded.pluginMarketplaceSettings?.flatMap((entry) => entry.extraKnownMarketplaces?.team === undefined ? [] : [{ entry, value: entry.extraKnownMarketplaces.team }]).at(-1); expect(winner).toMatchObject({ entry: { scope: "project", sourcePath: path.join(value.project, ".claude", "settings.json") } });
    await commit(value, "user", "market_remove", { kind: "known-marketplace", key: "team" }, true); expect(fs.readFileSync(userTarget, "utf8")).not.toContain('"team"');
  });

  it("rejects malformed/non-object targets, aliases, wrong checkout identity, and concurrent bytes", async () => {
    const value = fixture(); const target = path.join(value.project, ".claude", "settings.json"); fs.writeFileSync(target, "{/* broken");
    const base = { homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" as const : "posix" as const, project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [], scope: "project" as const, mutation: { kind: "enabled-plugin" as const, key: "alpha@official", value: true } };
    await expect(planPluginSettingsWrite(base)).resolves.toMatchObject({ ok: false, code: "malformed-settings" });
    fs.writeFileSync(target, "[]"); await expect(planPluginSettingsWrite(base)).resolves.toMatchObject({ ok: false, code: "non-object-settings" });
    fs.writeFileSync(target, "{}"); const planned = await planPluginSettingsWrite(base); expect(planned.ok).toBe(true); if (!planned.ok) return;
    fs.writeFileSync(target, '{"changed":true}'); const store = await establishOwnedStateStore(value.locations, value.home); if (!store.ok) throw new Error(store.message);
    await expect(preparePluginSettingsWrite({ store: store.value, operationId: "concurrent", profilePath: value.profile, plan: planned.value })).resolves.toMatchObject({ ok: false, code: "stale-precondition" });
    fs.writeFileSync(target, "{}"); const identityPlan = await planPluginSettingsWrite(base); if (!identityPlan.ok) throw new Error(identityPlan.message);
    const replacement = `${target}.replacement`; fs.writeFileSync(replacement, "{}"); fs.renameSync(replacement, target);
    await expect(preparePluginSettingsWrite({ store: store.value, operationId: "retargeted", profilePath: value.profile, plan: identityPlan.value })).resolves.toMatchObject({ ok: false, code: "invalid-plan" });
    await expect(planPluginSettingsWrite({ ...base, project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.home } })).resolves.toMatchObject({ ok: false, code: "wrong-checkout" });
  });

  it.skipIf(!DIRECTORY_ALIAS_SUPPORTED)("rejects an aliased settings ancestor without touching its outside canary", async () => {
    const value = fixture(); const outside = path.join(value.home, "outside"); fs.mkdirSync(outside); const canary = path.join(outside, "settings.json"); fs.writeFileSync(canary, '{"canary":true}');
    fs.rmSync(path.join(value.project, ".claude"), { recursive: true });
    fs.symlinkSync(outside, path.join(value.project, ".claude"), process.platform === "win32" ? "junction" : "dir");
    await expect(planPluginSettingsWrite({ homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [], scope: "project", mutation: { kind: "enabled-plugin", key: "alpha@official", value: true } })).resolves.toMatchObject({ ok: false, code: "unsafe-target" });
    expect(fs.readFileSync(canary, "utf8")).toBe('{"canary":true}');
  });

  it.skipIf(!DIRECTORY_ALIAS_SUPPORTED)("refuses mutation-time .claude junction/symlink retargeting with the outside canary untouched", async () => {
    const value = fixture(); const target = path.join(value.project, ".claude", "settings.json"); fs.writeFileSync(target, "{}\n"); const plan = await planPluginSettingsWrite({ homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [], scope: "project", mutation: { kind: "enabled-plugin", key: "alpha@official", value: true } }); if (!plan.ok) throw new Error(plan.message); const store = await establishOwnedStateStore(value.locations, value.home); if (!store.ok) throw new Error(store.message); const prepared = await preparePluginSettingsWrite({ store: store.value, operationId: "alias_retarget", profilePath: value.profile, plan: plan.value }); if (!prepared.ok) throw new Error(prepared.message); const held = await acquireLifecycleLocks({ store: store.value, operationId: "alias_retarget", identities: prepared.value.transaction.requiredLocks }); if (!held.ok) throw new Error(held.message);
    const authentic = path.join(value.project, ".claude-authentic"); const outside = path.join(value.home, "outside-retarget"); fs.mkdirSync(outside); const canary = path.join(outside, "canary.txt"); fs.writeFileSync(canary, "preserve"); fs.renameSync(path.dirname(target), authentic); fs.symlinkSync(outside, path.dirname(target), process.platform === "win32" ? "junction" : "dir"); try { expect(await executeTransaction(store.value, prepared.value.transaction, { lease: held.value })).toMatchObject({ state: "failed-before-commit" }); } finally { await releaseLifecycleLocks(held.value); } expect(fs.readFileSync(canary, "utf8")).toBe("preserve"); expect(fs.existsSync(path.join(outside, "settings.json"))).toBe(false); expect(fs.readFileSync(path.join(authentic, "settings.json"), "utf8")).toBe("{}\n");
  });

  it.skipIf(!UNREADABLE_FILE_SUPPORTED)("refuses an unreadable POSIX settings target during planning", async () => {
    const value = fixture(); const target = path.join(value.project, ".claude", "settings.json"); fs.writeFileSync(target, "{}\n"); fs.chmodSync(target, 0o000); try { await expect(planPluginSettingsWrite({ homeDir: value.home, profilePath: value.profile, platform: "posix", project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [], scope: "project", mutation: { kind: "enabled-plugin", key: "alpha@official", value: true } })).resolves.toMatchObject({ ok: false }); } finally { fs.chmodSync(target, 0o600); }
  });

  it("cleans every preparation artifact after stale CAS and post-backup semantic rejection", async () => {
    const value = fixture(); const target = path.join(value.profile, "settings.json"); fs.writeFileSync(target, "{}\n");
    const base = { homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" as const : "posix" as const, project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [], scope: "user" as const, mutation: { kind: "enabled-plugin" as const, key: "alpha@official", value: true } };
    const store = await establishOwnedStateStore(value.locations, value.home); if (!store.ok) throw new Error(store.message);
    const stale = await planPluginSettingsWrite(base); if (!stale.ok) throw new Error(stale.message); const beforeStale = fs.readdirSync(store.value.stagingRoot).sort(); fs.writeFileSync(target, "{\"intruder\":true}\n");
    await expect(preparePluginSettingsWrite({ store: store.value, operationId: "cleanup_stale", profilePath: value.profile, plan: stale.value })).resolves.toMatchObject({ ok: false, code: "stale-precondition" }); expect(fs.readdirSync(store.value.stagingRoot).sort()).toEqual(beforeStale);
    fs.writeFileSync(target, "{}\n"); const invalid = await planPluginSettingsWrite(base); if (!invalid.ok) throw new Error(invalid.message); const beforeInvalid = fs.readdirSync(store.value.stagingRoot).sort();
    const reversed = [...invalid.value.hierarchyAnchors].reverse(); await expect(preparePluginSettingsWrite({ store: store.value, operationId: "cleanup_codec", profilePath: value.profile, plan: { ...invalid.value, hierarchyAnchors: reversed } })).resolves.toMatchObject({ ok: false }); expect(fs.readdirSync(store.value.stagingRoot).sort()).toEqual(beforeInvalid);
  });

  it("rejects an independent semantic evidence and participant mutation matrix at codec-owned boundaries", async () => {
    const value = fixture(); const managed = path.join(value.home, "managed.json"); fs.writeFileSync(managed, JSON.stringify({ enabledPlugins: { "shadow@official": false } })); fs.writeFileSync(path.join(value.profile, "settings.json"), "{}\n");
    const plan = await planPluginSettingsWrite({ homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [managed], scope: "user", mutation: { kind: "enabled-plugin", key: "alpha@official", value: true } }); if (!plan.ok) throw new Error(plan.message);
    const store = await establishOwnedStateStore(value.locations, value.home); if (!store.ok) throw new Error(store.message); const prepared = await preparePluginSettingsWrite({ store: store.value, operationId: "matrix", profilePath: value.profile, plan: plan.value }); if (!prepared.ok) throw new Error(prepared.message);
    const participant = prepared.value.transaction.participants[0]!; const evidence = participant.producerEvidence as Record<string, unknown>; const summary = evidence.summary as Record<string, unknown>; const codec = prepared.value.codec;
    const evidenceMutation = (changes: Record<string, unknown>) => ({ ...participant, producerEvidence: { ...evidence, ...changes } });
    const cases: readonly [string, typeof participant][] = [
      ["participant key", { ...participant, key: "forged" }], ["evidence key", evidenceMutation({ key: "beta@official" })], ["requested value", evidenceMutation({ requested: false })], ["target", { ...participant, targetPath: path.join(value.home, "outside.json") }], ["scope", evidenceMutation({ scope: "project" })],
      ["declaration summary", evidenceMutation({ summary: { ...summary, declarationAfter: { present: false } } })], ["effective provenance", evidenceMutation({ summary: { ...summary, effectiveAfter: { ...(summary.effectiveAfter as Record<string, unknown>), source: path.join(value.home, "forged.json") } } })],
      ["staged digest", { ...participant, stagedDigest: `sha256:${"0".repeat(64)}` as const }], ["precondition", { ...participant, precondition: { state: "absent" } }], ["rollback", { ...participant, rollback: { kind: "delete-new-target" } }],
      ["target identity", evidenceMutation({ targetIdentity: { dev: "0", ino: "0" } })], ["parent anchor", evidenceMutation({ anchors: [{ ...(evidence.anchors as Record<string, unknown>[])[0]!, path: value.home }] })],
      ["hierarchy", evidenceMutation({ hierarchyAnchors: [...(evidence.hierarchyAnchors as unknown[])].reverse() })], ["home", evidenceMutation({ homePath: value.project })], ["profile", evidenceMutation({ profilePath: value.project })], ["family", evidenceMutation({ checkoutFamilyPath: value.home })],
      ["lock authority", evidenceMutation({ profileKey: "profile-forged" })],
    ];
    for (const [name, changed] of cases) expect(codec.validatePlan([changed]), name).toMatchObject({ ok: false });
    await expect(codec.authorizeExternal!({ operationId: "matrix", participant: evidenceMutation({ operationId: "other" }), mutation: "replace" })).resolves.toMatchObject({ ok: false });
    await expect(codec.authorizeExternal!({ operationId: "matrix", participant: evidenceMutation({ activeCheckoutPath: value.home }), mutation: "replace" })).resolves.toMatchObject({ ok: false });
    const fingerprints = evidence.authorityFingerprints as Record<string, unknown>[]; await expect(codec.authorizeExternal!({ operationId: "matrix", participant: evidenceMutation({ authorityFingerprints: [{ ...fingerprints[0]!, ...(fingerprints[0]!.status === "text" ? { digest: `sha256:${"1".repeat(64)}` } : { status: "unreadable" }) }, ...fingerprints.slice(1)] }), mutation: "replace" })).resolves.toMatchObject({ ok: false });
    expect(codec.requiredLocks({ ...plan.value.summary, targetPath: path.join(value.home, "forged.json") }, [participant])).toMatchObject({ ok: false });
  });

  it("rejects real target, hierarchy, and precedence races after preparation and lock without touching intruders", async () => {
    const races = ["changed-bytes", "same-bytes-identity", "parent-identity", "checkout-identity", "ordinary-source", "same-value-owner"] as const;
    for (const race of races) {
      const value = fixture(); const target = path.join(value.project, ".claude", "settings.json"); fs.writeFileSync(target, "{}\n");
      const plan = await planPluginSettingsWrite({ homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [], scope: "project", mutation: { kind: "enabled-plugin", key: "alpha@official", value: true } }); if (!plan.ok) throw new Error(plan.message);
      const store = await establishOwnedStateStore(value.locations, value.home); if (!store.ok) throw new Error(store.message); const prepared = await preparePluginSettingsWrite({ store: store.value, operationId: `race_${race.replaceAll("-", "_")}`, profilePath: value.profile, plan: plan.value }); if (!prepared.ok) throw new Error(prepared.message); const held = await acquireLifecycleLocks({ store: store.value, operationId: prepared.value.transaction.operationId, identities: prepared.value.transaction.requiredLocks }); if (!held.ok) throw new Error(held.message);
      let canary: string | undefined;
      if (race === "changed-bytes") fs.writeFileSync(target, '{"intruder":true}\n');
      else if (race === "same-bytes-identity") { const replacement = `${target}.intruder`; fs.writeFileSync(replacement, "{}\n"); fs.renameSync(replacement, target); }
      else if (race === "parent-identity") { const old = `${path.dirname(target)}.old`; fs.renameSync(path.dirname(target), old); fs.mkdirSync(path.dirname(target)); canary = path.join(path.dirname(target), "intruder-canary"); fs.writeFileSync(canary, "preserve"); }
      else if (race === "checkout-identity") { const old = `${value.project}.old`; fs.renameSync(value.project, old); fs.mkdirSync(path.join(value.project, ".claude"), { recursive: true }); canary = path.join(value.project, "intruder-canary"); fs.writeFileSync(canary, "preserve"); }
      else if (race === "ordinary-source") fs.writeFileSync(path.join(value.profile, "settings.json"), '{"unrelated":true}\n');
      else fs.writeFileSync(path.join(value.project, ".claude", "settings.local.json"), '{"enabledPlugins":{"alpha@official":true}}\n');
      const outcome = await executeTransaction(store.value, prepared.value.transaction, { lease: held.value }); expect(outcome, race).toMatchObject({ state: "failed-before-commit" }); if (canary !== undefined) expect(fs.readFileSync(canary, "utf8"), race).toBe("preserve"); else if (race === "changed-bytes") expect(fs.readFileSync(target, "utf8")).toBe('{"intruder":true}\n');
      await releaseLifecycleLocks(held.value);
    }
  });

  it("binds omitted ambient managed files and listings while explicit empty discovery remains inert", async () => {
    async function preparedAmbient(operationId: string, explicit: boolean) {
      const value = fixture(); const system = path.join(value.home, "system.json"); const dropIn = path.join(value.home, "managed.d"); fs.mkdirSync(dropIn); fs.writeFileSync(system, "{}\n");
      const inputs = { homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" as const : "posix" as const, project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, ...(explicit ? { managedPaths: [] } : { managedPolicy: { description: { systemSettingsPath: system, dropInDir: dropIn, artifactDirs: [value.home] } } }), scope: "project" as const, mutation: { kind: "enabled-plugin" as const, key: "alpha@official", value: true } };
      const plan = await planPluginSettingsWrite(inputs); if (!plan.ok) throw new Error(plan.message); const store = await establishOwnedStateStore(value.locations, value.home); if (!store.ok) throw new Error(store.message); const prepared = await preparePluginSettingsWrite({ store: store.value, operationId, profilePath: value.profile, plan: plan.value }); if (!prepared.ok) throw new Error(prepared.message); const held = await acquireLifecycleLocks({ store: store.value, operationId, identities: prepared.value.transaction.requiredLocks }); if (!held.ok) throw new Error(held.message); return { value, system, dropIn, store: store.value, prepared: prepared.value, lease: held.value };
    }
    const file = await preparedAmbient("ambient_file", false); fs.writeFileSync(file.system, '{"enabledPlugins":{"alpha@official":false}}'); expect(await executeTransaction(file.store, file.prepared.transaction, { lease: file.lease })).toMatchObject({ state: "failed-before-commit" }); expect(fs.existsSync(path.join(file.value.project, ".claude", "settings.json"))).toBe(false); await releaseLifecycleLocks(file.lease);
    const listing = await preparedAmbient("ambient_listing", false); fs.writeFileSync(path.join(listing.dropIn, "new.json"), "{}"); expect(await executeTransaction(listing.store, listing.prepared.transaction, { lease: listing.lease })).toMatchObject({ state: "failed-before-commit" }); expect(fs.existsSync(path.join(listing.value.project, ".claude", "settings.json"))).toBe(false); await releaseLifecycleLocks(listing.lease);
    const inert = await preparedAmbient("ambient_explicit_empty", true); fs.writeFileSync(inert.system, '{"enabledPlugins":{"alpha@official":false}}'); fs.writeFileSync(path.join(inert.dropIn, "new.json"), "{}"); expect(await executeTransaction(inert.store, inert.prepared.transaction, { lease: inert.lease })).toMatchObject({ state: "committed" }); await releaseLifecycleLocks(inert.lease);
  });

  it("refuses bounded marketplace omissions only for marketplace mutation", async () => {
    const value = fixture(); const registrations = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`market-${index}`, { source: { source: "github", repo: `owner/catalog-${index}` } }])); fs.writeFileSync(path.join(value.project, ".claude", "settings.json"), JSON.stringify({ extraKnownMarketplaces: registrations }));
    const base = { homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" as const : "posix" as const, project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [], scope: "project" as const };
    await expect(planPluginSettingsWrite({ ...base, mutation: { kind: "known-marketplace", key: "selected", value: { kind: "github", repo: "owner/selected" } } })).resolves.toMatchObject({ ok: false, code: "indeterminate-precedence" });
    await expect(planPluginSettingsWrite({ ...base, mutation: { kind: "enabled-plugin", key: "alpha@official", value: true } })).resolves.toMatchObject({ ok: true });
  });

  it("binds semantic participant fields and reconstructed external authority", async () => {
    const value = fixture(); fs.writeFileSync(path.join(value.profile, "settings.json"), "{}\n");
    const plan = await planPluginSettingsWrite({ homeDir: value.home, profilePath: value.profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: value.project, checkoutFamilyPath: value.project }, projectRoot: value.project, cwd: value.project, managedPaths: [], scope: "user", mutation: { kind: "enabled-plugin", key: "alpha@official", value: true } }); if (!plan.ok) throw new Error(plan.message);
    const store = await establishOwnedStateStore(value.locations, value.home); if (!store.ok) throw new Error(store.message);
    const prepared = await preparePluginSettingsWrite({ store: store.value, operationId: "semantic", profilePath: value.profile, plan: plan.value }); if (!prepared.ok) throw new Error(prepared.message);
    const participant = prepared.value.transaction.participants[0]!; const codec = createPluginSettingsTransactionCodec();
    const forgedBytes = Buffer.from('{"enabledPlugins":{"alpha@official":false}}\n');
    await expect(preparePluginSettingsWrite({ store: store.value, operationId: "forged_bytes", profilePath: value.profile, plan: { ...plan.value, replacementBytes: forgedBytes, replacementDigest: `sha256:${createHash("sha256").update(forgedBytes).digest("hex")}` } })).resolves.toMatchObject({ ok: false, code: "changed-staged" });
    expect(codec.validatePlan([{ ...participant, stagedDigest: `sha256:${"0".repeat(64)}` as const }])).toMatchObject({ ok: false });
    expect(codec.validatePlan([{ ...participant, targetPath: path.join(value.home, "outside.json") }])).toMatchObject({ ok: false });
    expect(codec.validatePlan([{ ...participant, producerEvidence: { ...(participant.producerEvidence as Record<string, unknown>), key: "forged@official" } }])).toMatchObject({ ok: false });
    const absentValue = fixture(); fs.rmSync(path.join(absentValue.project, ".claude", "settings.json"), { force: true }); const absentPlan = await planPluginSettingsWrite({ homeDir: absentValue.home, profilePath: absentValue.profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: absentValue.project, checkoutFamilyPath: absentValue.project }, projectRoot: absentValue.project, cwd: absentValue.project, managedPaths: [], scope: "project", mutation: { kind: "enabled-plugin", key: "alpha@official", value: true } }); if (!absentPlan.ok) throw new Error(absentPlan.message); const absentStore = await establishOwnedStateStore(absentValue.locations, absentValue.home); if (!absentStore.ok) throw new Error(absentStore.message);
    const absentForged = Buffer.from('{"enabledPlugins":{"alpha@official":false}}\n'); await expect(preparePluginSettingsWrite({ store: absentStore.value, operationId: "forged_absent", profilePath: absentValue.profile, plan: { ...absentPlan.value, replacementBytes: absentForged, replacementDigest: `sha256:${createHash("sha256").update(absentForged).digest("hex")}` } })).resolves.toMatchObject({ ok: false, code: "changed-staged" });
    fs.renameSync(value.profile, `${value.profile}-old`); fs.mkdirSync(value.profile);
    await expect(codec.authorizeExternal!({ operationId: "semantic", participant, mutation: "replace" })).resolves.toMatchObject({ ok: false, code: "unsafe-target" });
  });
});

import childProcess, { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HookRunner } from "../src/engine/hook-runner.js";
import { loadSkillBody } from "../src/claude/skills.js";
import { projectPluginAgentRuntime, substitutePluginRuntimeText } from "../src/index.js";
import { findByName, loadClaudeProject } from "../src/project.js";
import { buildCompatReport, renderDoctorReport } from "../src/registry/compat-report.js";
import {
  buildSystemPromptSuffix,
  createTierChangeReporter,
  newSessionContextState,
} from "../src/runtime/context-assembly.js";
import {
  REINJECT_COMBINED_MAX_CHARS,
  REINJECT_PER_SKILL_MAX_CHARS,
} from "../src/runtime/skill-activation.js";
import type { ClaudeSettings, ClaudeSkill } from "../src/types.js";
import { digestArtifactEntries, type ArtifactDigestEntry } from "../src/plugin-lifecycle/artifact-digest.js";
import { loadSettings } from "../src/discovery/settings.js";
import { createLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { createMarketplaceSnapshotTrustGrant, createOwnedMarketplaceCodec, createOwnedMarketplaceSnapshotCodec, createOwnedPluginInstallationCodec, executableDigestForProjection, issueOwnedDataRetirementProducerEvidence, ownedMarketplaceScopeKey, ownedMarketplaceSnapshotScopeKey, reconstructOwnedDataRetirementProducerEvidence, revalidateCompleteOwnedProfileReference, type ExecutableAdmissionGeneration, type MarketplaceSnapshotTrustTarget, type OwnedMarketplaceSnapshotRecord, type OwnedPluginInstallationRecord } from "../src/plugin-lifecycle/admission.js";
import { canonicalJsonBytes, createRecordEnvelope, establishOwnedStateStore, ownedRecordPartition, sha256, type OwnedStateStore } from "../src/plugin-lifecycle/state-store.js";
import { acquireLifecycleLocks, releaseLifecycleLocks } from "../src/plugin-lifecycle/locks.js";
import { createOwnedDataRetirementParticipant, createTransactionCodecRegistry, executeTransaction, prepareTransaction, type OrdinaryTransactionParticipant, type TransactionParticipant, type TransactionProducerCodec } from "../src/plugin-lifecycle/transaction.js";
import { previewRecovery, recoverTransaction } from "../src/plugin-lifecycle/recovery.js";
import { planPluginSettingsWrite } from "../src/plugin-lifecycle/settings-plan.js";
import { preparePluginSettingsWrite } from "../src/plugin-lifecycle/settings-writer.js";
import { projectPluginManifest } from "../src/claude/plugin-metadata.js";
import { createOwnedDataRetirementAuthorizer, ownedPluginDataDeletionEligible } from "../src/claude/plugin-paths.js";
import { PORTABLE_TREE_LIMITS } from "../src/plugin-lifecycle/tree-validator.js";
import { pluginMutableRecordKey } from "../src/plugin-lifecycle/plugin-service.js";
import { deriveExecutableMarketplaceCatalogProjection } from "../src/util/plugin-marketplace-descriptor.js";
import { captureImportedExecutableTrees, captureReloadCandidateBinding, clearReloadHandoff, readReloadHandoff, sameImportedExecutableTrees, sameReloadBinding, writeReloadHandoff } from "../src/plugin-lifecycle/reload-handoff.js";

/**
 * Assembly-level coverage for loadClaudeProject: settings,
 * skills, agents, and plugin content folded into one project model. These tests
 * build on-disk fixtures — they guard the wiring, not just the parsers.
 */

const tempDirs: string[] = [];

const directoryLinkProbe = (() => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "picc-assembly-dir-link-probe-"));
  try {
    const target = path.join(parent, "target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(parent, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
})();

function makeTmp(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picc-assembly-")));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup (Windows can hold handles briefly)
    }
  }
});

function write(filePath: string, content: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeSkill(dir: string, name: string, description: string): void {
  write(path.join(dir, name, "SKILL.md"), `---\ndescription: ${description}\n---\nbody of ${name}`);
}

function artifactEntriesFromDirectory(root: string): ArtifactDigestEntry[] {
  const entries: ArtifactDigestEntry[] = [];
  const walk = (directory: string, relative: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name); const childRelative = relative === "" ? name : `${relative}/${name}`; const stat = fs.statSync(file);
      if (stat.isDirectory()) { entries.push({ path: childRelative, kind: "directory" }); walk(file, childRelative); }
      else entries.push({ path: childRelative, kind: "file", executable: process.platform !== "win32" && (stat.mode & 0o111) !== 0, data: fs.readFileSync(file) });
    }
  };
  walk(root, ""); return entries;
}

/** Base fixture: a git repo root and a hermetic user dir. */
function makeBase(): { base: string; repo: string; userDir: string } {
  const base = makeTmp();
  const repo = path.join(base, "repo");
  const userDir = path.join(base, "home", ".claude");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true }); // repo-root marker
  fs.mkdirSync(userDir, { recursive: true });
  return { base, repo, userDir };
}

function installOwnedPlugin(base: string, repo: string, userDir: string, checkoutFamilyPath = repo, homeDir = path.dirname(userDir), defaults: { manifest?: boolean; marketplace?: boolean; dependencies?: unknown; catalogDependencies?: unknown; name?: string; hooks?: boolean; skillBytes?: Uint8Array; catalogPadding?: string; catalogMetadataPluginRoot?: unknown; snapshotOnly?: boolean; catalogOnlyName?: string } = { manifest: true }): { root: string; dataRoot: string; installationRecordPath: string; marketplaceRecordPath: string; snapshotRecordPath: string; generationPath: string; member: Record<string, unknown>; treeDigest: string; rootDigest: string; executableDigest: string } {
  const locationsResult = createLifecycleLocations({ homeDir, profilePath: userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: repo, checkoutFamilyPath } });
  if (!locationsResult.ok) throw new Error("locations"); const locations = locationsResult.value;
  const pluginName = defaults.name ?? "owned"; const pluginId = `${pluginName}@official` as `${string}@${string}`;
  const manifest = JSON.stringify({ name: pluginName, version: "1.0.0", ...(defaults.manifest === undefined ? {} : { defaultEnabled: defaults.manifest }), ...(defaults.dependencies === undefined ? {} : { dependencies: defaults.dependencies }), ...(defaults.hooks ? { hooks: "./hooks/hooks.json" } : {}) });
  const skill = defaults.skillBytes ?? Buffer.from(`---\ndescription: ${pluginName} skill\n---\n${pluginName} body`); const hook = JSON.stringify({ PreToolUse: [{ hooks: [] }] });
  const catalog = JSON.stringify({ name: "official", owner: { name: "PiCC test" }, plugins: [{ name: pluginName, source: `./${pluginName}`, ...(defaults.marketplace === undefined ? {} : { defaultEnabled: defaults.marketplace }), ...(defaults.catalogDependencies === undefined ? {} : { dependencies: defaults.catalogDependencies }) }, ...(defaults.catalogOnlyName === undefined ? [] : [{ name: defaults.catalogOnlyName, source: `./${defaults.catalogOnlyName}` }])], ...(defaults.catalogPadding === undefined ? {} : { padding: defaults.catalogPadding }), ...(defaults.catalogMetadataPluginRoot === undefined ? {} : { metadata: { pluginRoot: defaults.catalogMetadataPluginRoot } }) });
  const entries: ArtifactDigestEntry[] = [
    { path: ".claude-plugin", kind: "directory" }, { path: ".claude-plugin/marketplace.json", kind: "file", data: Buffer.from(catalog) },
    { path: pluginName, kind: "directory" }, { path: `${pluginName}/.claude-plugin`, kind: "directory" }, { path: `${pluginName}/.claude-plugin/plugin.json`, kind: "file", data: Buffer.from(manifest) },
    { path: `${pluginName}/skills`, kind: "directory" }, { path: `${pluginName}/skills/${pluginName}-skill`, kind: "directory" }, { path: `${pluginName}/skills/${pluginName}-skill/SKILL.md`, kind: "file", data: skill },
    ...(defaults.hooks ? [{ path: `${pluginName}/hooks`, kind: "directory" as const }, { path: `${pluginName}/hooks/hooks.json`, kind: "file" as const, data: Buffer.from(hook) }] : []),
    ...(defaults.catalogOnlyName === undefined ? [] : [{ path: defaults.catalogOnlyName, kind: "directory" as const }, { path: `${defaults.catalogOnlyName}/.claude-plugin`, kind: "directory" as const }, { path: `${defaults.catalogOnlyName}/.claude-plugin/plugin.json`, kind: "file" as const, data: Buffer.from(JSON.stringify({ name: defaults.catalogOnlyName, version: "1.0.0" })) }]),
  ];
  const treeDigest = digestArtifactEntries(entries); const artifactRoot = path.join(locations.profileRoot, "artifacts", "sha256", treeDigest.slice(7)); const root = path.join(artifactRoot, pluginName); const rootDigest = digestArtifactEntries(entries, pluginName);
  write(path.join(artifactRoot, ".claude-plugin", "marketplace.json"), catalog); write(path.join(root, ".claude-plugin", "plugin.json"), manifest); write(path.join(root, "skills", `${pluginName}-skill`, "SKILL.md"), skill); if (defaults.hooks) write(path.join(root, "hooks", "hooks.json"), hook); if (defaults.catalogOnlyName !== undefined) write(path.join(artifactRoot, defaults.catalogOnlyName, ".claude-plugin", "plugin.json"), JSON.stringify({ name: defaults.catalogOnlyName, version: "1.0.0" }));
  const manifestProjection = projectPluginManifest(JSON.parse(manifest) as Record<string, unknown>, path.join(root, ".claude-plugin", "plugin.json")).projection;
  const executable = executableDigestForProjection(manifestProjection);
  if (!executable.ok) throw new Error("executable");
  const store: OwnedStateStore = { root: locations.profileRoot, profileRoot: locations.profileRoot, profileKey: locations.profileKey, artifactsRoot: path.join(locations.profileRoot, "artifacts", "sha256"), recordsRoot: path.join(locations.profileRoot, "records"), stagingRoot: path.join(locations.profileRoot, "staging"), generationsRoot: path.join(locations.profileRoot, "generations"), journalsRoot: path.join(locations.profileRoot, "journals"), receiptsRoot: path.join(locations.profileRoot, "receipts"), locksRoot: path.join(locations.profileRoot, "locks"), quarantineRoot: path.join(locations.profileRoot, "quarantine"), dataRoot: locations.dataRoot };
  const catalogDigest = sha256(Buffer.from(catalog)); const snapshotId = `marketplace-${createHash("sha256").update(`${catalogDigest}\0${treeDigest}`).digest("base64url")}` as const;
  const source = { kind: "local-directory", path: path.resolve(base, "catalog") } as const;
  const marketplaceCodec = createOwnedMarketplaceCodec(locations.profileKey);
  const marketplace = { ownership: "picc-owned", name: "official", profileKey: locations.profileKey, scope: "project", checkoutFamilyKey: locations.checkoutFamilyKey!, projectKey: locations.checkoutFamilyKey!, source, selectedSnapshotId: snapshotId } as const;
  const marketplaceScopeKey = ownedMarketplaceScopeKey(marketplace); const marketplaceEnvelope = createRecordEnvelope(marketplaceCodec, "picc-owned", marketplaceScopeKey, marketplace); if (!marketplaceEnvelope.ok) throw new Error("marketplace envelope");
  const marketplacePartition = ownedRecordPartition(store, "picc-owned", marketplaceScopeKey); if (!marketplacePartition.ok) throw new Error("partition"); const marketplaceRecordPath = path.join(marketplacePartition.value, "record.json"); write(marketplaceRecordPath, Buffer.from(marketplaceEnvelope.value.bytes).toString("utf8"));
  const snapshotCodec = createOwnedMarketplaceSnapshotCodec({ profileKey: locations.profileKey, artifactsRoot: store.artifactsRoot });
  const executableCatalog = deriveExecutableMarketplaceCatalogProjection(Buffer.from(catalog), source.kind); if (executableCatalog === undefined) throw new Error("catalog projection");
  const snapshotTarget: MarketplaceSnapshotTrustTarget = { authorityKind: "materialized", marketplaceName: "official", snapshotId, source, catalogDigest, executableCatalog, artifactDigest: treeDigest, treeDigest, rootDigest: treeDigest, selectedRoot: { requested: "tree-root", path: "", usedSingleWrapper: false }, artifactRoot, installRoot: artifactRoot, catalogRelativePath: ".claude-plugin/marketplace.json", provenance: { adapter: "local-directory-snapshot", artifactDigest: treeDigest } };
  const snapshotTrust = createMarketplaceSnapshotTrustGrant(snapshotTarget); if (!snapshotTrust.ok) throw new Error(snapshotTrust.message); const snapshot = { ownership: "picc-owned", profileKey: locations.profileKey, ...snapshotTarget, trust: snapshotTrust.value } as const;
  const snapshotScopeKey = ownedMarketplaceSnapshotScopeKey(snapshot); const snapshotEnvelope = createRecordEnvelope(snapshotCodec, "picc-owned", snapshotScopeKey, snapshot); if (!snapshotEnvelope.ok) throw new Error("snapshot envelope");
  const snapshotPartition = ownedRecordPartition(store, "picc-owned", snapshotScopeKey); if (!snapshotPartition.ok) throw new Error("partition"); const snapshotRecordPath = path.join(snapshotPartition.value, "record.json"); write(snapshotRecordPath, Buffer.from(snapshotEnvelope.value.bytes).toString("utf8"));
  const installationCodec = createOwnedPluginInstallationCodec({ profileKey: locations.profileKey, artifactsRoot: store.artifactsRoot, marketplaceSnapshots: { [snapshotId]: [snapshot] } });
  const catalogDeclaration = executableCatalog.declarations.find((item) => item.pluginId === pluginId); const catalogDependencies = catalogDeclaration?.dependencies ?? []; const catalogDependencyDeclaration = catalogDeclaration?.dependencyDeclaration ?? "absent";
  const manifestDependencies = (manifestProjection.dependencies ?? []).map((dependency, itemIndex) => ({ ...dependency, itemIndex })); const mergedDependencies = [...catalogDependencies, ...manifestDependencies.filter((manifestDependency) => !catalogDependencies.some((catalogDependency) => catalogDependency.name === manifestDependency.name && catalogDependency.marketplace === manifestDependency.marketplace))].map((dependency, itemIndex) => ({ ...dependency, itemIndex })); const dependencyDeclaration = catalogDependencyDeclaration === "absent" && manifestProjection.dependencyDeclaration === "absent" ? "absent" as const : "complete" as const;
  const installation = { ownership: "picc-owned", pluginId, scope: "project", profileKey: locations.profileKey, checkoutFamilyKey: locations.checkoutFamilyKey!, projectKey: locations.checkoutFamilyKey!, version: "1.0.0", source: { kind: "marketplace-relative", marketplaceName: "official", path: pluginName, marketplaceSnapshotId: snapshotId, catalogDigest }, artifactDigest: treeDigest, treeDigest, rootDigest, executableDigest: executable.value, selectedRoot: { requested: "relative-subtree", path: pluginName, usedSingleWrapper: false }, installRoot: root, dataIdentity: { profileKey: locations.profileKey, identity: pluginId }, executableGenerationId: "admission-current", trust: { target: pluginId, artifactDigest: treeDigest, treeDigest, rootDigest, executableDigest: executable.value, selectedRoot: { requested: "relative-subtree", path: pluginName, usedSingleWrapper: false }, allowedCrossMarketplaceDependencies: [], dependencies: mergedDependencies, dependencyDeclaration, catalogDependencies, catalogDependencyDeclaration, resolvedVersionAuthority: { kind: "manifest-version", version: "1.0.0" } }, allowedCrossMarketplaceDependencies: [], dependencies: mergedDependencies, dependencyDeclaration, catalogDependencies, catalogDependencyDeclaration, resolvedVersionAuthority: { kind: "manifest-version", version: "1.0.0" }, ...(defaults.marketplace === undefined ? {} : { marketplaceDefaultEnabled: defaults.marketplace }) } as const;
  const installationScopeKey = `project-${locations.checkoutFamilyKey}`; let installationRecordPath = path.join(store.recordsRoot, "absent-installation.json"); let member: Record<string, unknown> = {};
  if (!defaults.snapshotOnly) { const installEnvelope = createRecordEnvelope(installationCodec, "picc-owned", installationScopeKey, installation); if (!installEnvelope.ok) throw new Error("install envelope"); const installPartition = ownedRecordPartition(store, "picc-owned", installationScopeKey); if (!installPartition.ok) throw new Error("partition"); installationRecordPath = path.join(installPartition.value, `${pluginName}.json`); write(installationRecordPath, Buffer.from(installEnvelope.value.bytes).toString("utf8")); member = { pluginId, scope: "project", checkoutFamilyKey: locations.checkoutFamilyKey, projectKey: locations.checkoutFamilyKey, recordDigest: installEnvelope.value.envelope.payloadDigest }; }
  const generation = canonicalJsonBytes({ ownership: "picc-owned", profileKey: locations.profileKey, generationId: "admission-current", members: defaults.snapshotOnly ? [] : [member] }); if (!generation.ok) throw new Error("generation"); const generationPath = path.join(store.generationsRoot, "current.json"); write(generationPath, Buffer.from(generation.value).toString("utf8"));
  return { root, dataRoot: locations.dataRoot, installationRecordPath, marketplaceRecordPath, snapshotRecordPath, generationPath, member, treeDigest, rootDigest, executableDigest: executable.value };
}

function load(cwd: string, userDir: string) {
  return loadClaudeProject({
    cwd,
    userDir,
    homeDir: path.dirname(userDir),
    managedSettingsPaths: [],
    managedArtifactDirs: [],
  });
}

/** One imported installed-state record with a hermetic cache root. */
function makeMarketplacePlugin(userDir: string, marketplace: string, name: string): string {
  const pluginId = `${name}@${marketplace}`;
  const root = path.join(userDir, "plugins", "cache", marketplace, name, "1.0.0");
  write(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  writeSkill(path.join(root, "skills"), `${name}-skill`, `skill of ${name}`);
  write(
    path.join(root, "agents", `${name}-agent.md`),
    `---\nname: ${name}-agent\ndescription: agent of ${name}\n---\nprompt`,
  );
  write(
    path.join(root, "hooks", "hooks.json"),
    JSON.stringify({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `echo ${name}-hook` }] }],
    }),
  );
  const statePath = path.join(userDir, "plugins", "installed_plugins.json");
  let state: { version: number; plugins: Record<string, unknown[]> } = { version: 2, plugins: {} };
  if (fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, "utf8")) as typeof state;
  state.plugins[pluginId] = [{ scope: "user", installPath: root, version: "1.0.0" }];
  write(statePath, JSON.stringify(state));
  return root;
}

describe("loadClaudeProject — Windows managed-file startup", () => {
  it("fresh-loads the default Windows file path without invoking child-process APIs", () => {
    const { repo, userDir } = makeBase();
    const projectModule = path.join(path.resolve("."), "src", "project.ts");
    const script = `
import child from "node:child_process";
const calls = [];
for (const name of Object.keys(child)) {
  if (typeof child[name] === "function") child[name] = (...args) => {
    calls.push({ name, args: args.length });
    throw new Error("child process forbidden");
  };
}
const { syncBuiltinESMExports } = await import("node:module");
syncBuiltinESMExports();
const { createJiti } = await import("jiti/static");
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, tsconfigPaths: false, tryNative: false });
const loaded = await jiti.import(${JSON.stringify(projectModule)});
const project = loaded.loadClaudeProject({
  cwd: ${JSON.stringify(repo)},
  userDir: ${JSON.stringify(userDir)},
  managedPolicyPlatform: "win32",
});
console.log(JSON.stringify({ calls, diagnostics: project.settings.diagnostics.length }));
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ calls: [] });
  });
});

describe("loadClaudeProject — imported installed-state enablement", () => {
  it("loads only explicitly enabled installed records from authorized cache roots (skills, agents, hooks)", () => {
    const { repo, userDir } = makeBase();
    const alphaRoot = makeMarketplacePlugin(userDir, "official", "alpha");
    write(path.join(alphaRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha", version: 7 }));
    makeMarketplacePlugin(userDir, "official", "beta");
    write(
      path.join(userDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "alpha@official": true, "beta@official": false } }),
    );

    const project = load(repo, userDir);

    // Only the enabled plugin is kept…
    expect(project.plugins.map((p) => p.pluginId)).toEqual(["alpha@official"]);
    expect(project.pluginContexts.get("alpha@official")?.pluginName).toBe("alpha");
    // …its content is present under the CC plugin namespace…
    expect(project.skills.map((s) => s.name)).toContain("alpha:alpha-skill");
    expect(project.agents.map((a) => a.name)).toContain("alpha:alpha-agent");
    const hookCommands = JSON.stringify(project.mergedHooks);
    expect(hookCommands).toContain("echo alpha-hook");
    // …and the disabled sibling contributes NOTHING.
    expect(project.skills.some((s) => s.name.includes("beta"))).toBe(false);
    expect(project.agents.some((a) => a.name.includes("beta"))).toBe(false);
    expect(hookCommands).not.toContain("beta-hook");
    expect(project.pluginInventory.find("alpha@official")).toMatchObject({ outcome: { status: "loaded" }, manifestNamespace: "alpha" });
    expect(project.pluginInventory.find("alpha@official")!.diagnostics.filter((item) => item.message.includes("metadata field version"))).toHaveLength(1);
    expect(project.pluginInventory.find("beta@official")).toMatchObject({ outcome: { status: "disabled" } });
    expect(project.pluginInventory.find("beta@official")!.selectedInstallation).toBeUndefined();
    expect(Object.isFrozen(project.pluginInventory)).toBe(true);
    expect(project.reloadCandidate.status).toBe("ready");
    if (project.reloadCandidate.status !== "ready") throw new Error(project.reloadCandidate.reason);
    expect(project.reloadCandidate.binding.importedExecutableTrees).toEqual([
      expect.objectContaining({ kind: "tree", status: "present", digest: expect.stringMatching(/^sha256:/u) }),
    ]);
    fs.appendFileSync(path.join(alphaRoot, "skills", "alpha-skill", "SKILL.md"), "\nmutated");
    const changed = project.reloadCandidate.recapture();
    expect(changed.ok).toBe(true);
    if (!changed.ok) throw new Error(changed.message);
    expect(sameReloadBinding(changed.value, project.reloadCandidate.binding)).toBe(false);
  });

  it("uses one injected environment for marketplace discovery, installed selection, and metadata authorization", () => {
    const { base, repo, userDir } = makeBase();
    const cache = path.join(base, "injected-cache");
    const seed = path.join(base, "injected-seed");
    const statePath = path.join(userDir, "plugins", "installed_plugins.json");
    const ambientCache = path.join(base, "ambient-cache");
    const ambientSeed = path.join(base, "ambient-seed");
    const alpha = path.join(cache, "official", "alpha", "1.0.0");
    const beta = path.join(cache, "official", "beta", "1.0.0");
    const ambient = path.join(ambientCache, "official", "ambient", "1.0.0");
    write(path.join(alpha, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha" }));
    write(path.join(beta, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "beta", description: "observed through injected cache" }));
    write(path.join(ambient, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "ambient", description: "must not be authorized" }));
    write(statePath, JSON.stringify({ version: 2, plugins: {
      "alpha@official": [{ scope: "user", installPath: alpha, version: "1.0.0" }],
      "beta@official": [{ scope: "user", installPath: beta, version: "1.0.0" }],
      "ambient@official": [{ scope: "user", installPath: ambient, version: "1.0.0" }],
    } }));
    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@official": true, "beta@official": false, "ambient@official": true } }));
    write(path.join(seed, "known_marketplaces.json"), JSON.stringify({ official: { source: { source: "github", repo: "example/catalog" } } }));
    write(path.join(seed, "official", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "official", owner: { name: "Example" }, plugins: [{ name: "catalog-only", source: "./catalog-only" }] }));
    write(path.join(ambientSeed, "known_marketplaces.json"), JSON.stringify({ ambient: { source: { source: "github", repo: "example/ambient" } } }));
    write(path.join(ambientSeed, "ambient", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "ambient", owner: { name: "Example" }, plugins: [{ name: "ambient-catalog", source: "./ambient" }] }));
    vi.stubEnv("CLAUDE_CODE_PLUGIN_CACHE_DIR", ambientCache);
    vi.stubEnv("CLAUDE_CODE_PLUGIN_SEED_DIR", ambientSeed);

    const project = loadClaudeProject({
      cwd: repo, userDir, env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: cache, CLAUDE_CODE_PLUGIN_SEED_DIR: seed },
      managedSettingsPaths: [], managedArtifactDirs: [],
    });

    expect(project.plugins.map((plugin) => plugin.pluginId)).toEqual(["alpha@official"]);
    expect(project.pluginInventory.find("beta@official")?.installations[0]?.metadata?.description).toBe("observed through injected cache");
    expect(project.pluginInventory.find("catalog-only@official")?.catalogPresence).toBe(true);
    expect(project.pluginInventory.find("ambient@official")).toMatchObject({ outcome: { status: "rejected" }, installations: [expect.not.objectContaining({ metadata: expect.anything() })] });
    expect(project.pluginInventory.find("ambient-catalog@ambient")).toBeUndefined();
  });

  it("captures safely classified invalid enabledPlugins evidence from real settings assembly", () => {
    const { repo, userDir } = makeBase();
    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: [] }));
    write(path.join(repo, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "SECRET-BAD-IDENTITY": true, "safe@official": "RAW-SECRET-VALUE" } }));

    const project = load(repo, userDir);
    expect(project.pluginInventory.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "enabled-plugins-not-object", message: "The enabledPlugins declaration was not an object and was ignored" }),
      expect.objectContaining({ category: "enabled-plugins-invalid-identity", message: "An invalid qualified plugin identity in enabledPlugins was ignored" }),
      expect.objectContaining({ category: "enabled-plugins-non-boolean", message: "A non-boolean enabledPlugins value was ignored" }),
    ]));
    const captured = JSON.stringify(project.pluginInventory.diagnostics);
    for (const rejected of ["SECRET-BAD-IDENTITY", "safe@official", "RAW-SECRET-VALUE", userDir, repo]) expect(captured).not.toContain(rejected);
  });

  it("does not reread observational metadata while building or rendering doctor after capture", () => {
    const { repo, userDir } = makeBase();
    const root = makeMarketplacePlugin(userDir, "official", "alpha");
    const manifest = path.join(root, ".claude-plugin", "plugin.json");
    write(manifest, JSON.stringify({ name: "alpha", description: "captured description" }));
    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@official": false } }));
    const originalOpen = fs.openSync;
    let manifestReads = 0;
    const open = vi.spyOn(fs, "openSync").mockImplementation(((filePath: fs.PathLike, ...args: unknown[]) => {
      if (path.resolve(String(filePath)) === path.resolve(manifest)) manifestReads += 1;
      return (originalOpen as (...values: unknown[]) => number)(filePath, ...args);
    }) as typeof fs.openSync);
    try {
      const project = load(repo, userDir);
      const readsAfterCapture = manifestReads;
      expect(readsAfterCapture).toBeGreaterThan(0);
      expect(project.pluginInventory.find("alpha@official")?.installations[0]?.metadata?.description).toBe("captured description");
      fs.rmSync(manifest);

      const report = buildCompatReport(project);
      const doctor = renderDoctorReport(project, report);
      expect(project.pluginInventory.find("alpha@official")?.installations[0]?.metadata?.description).toBe("captured description");
      expect(report.pluginInventory?.counts.known).toBe(1);
      expect(doctor).toContain("known: 1");
      expect(manifestReads).toBe(readsAfterCapture);
    } finally {
      open.mockRestore();
    }
  });

  it("renders lifecycle recovery evidence distinctly from ordinary doctor diagnostics", () => {
    const { repo, userDir } = makeBase();
    const project = load(repo, userDir);
    const report = buildCompatReport(project);
    const inventory = report.pluginInventory!;
    const doctor = renderDoctorReport(project, {
      ...report,
      pluginInventory: {
        ...inventory,
        diagnostics: Object.freeze([
          Object.freeze({ global: true, severity: "warning" as const, category: "lifecycle" as const, message: "Lifecycle pending: refresh", operationId: "orphan-operation", semanticStep: "refresh; 2 committed steps", recoveryCategory: "complete-or-rollback" as const, nextCommand: "picc plugin recover orphan-operation" }),
          Object.freeze({ global: true, severity: "warning" as const, category: "diagnostic" as const, message: "ordinary diagnostic", nextCommand: "/plugin details alpha@official" }),
        ]),
      },
    });
    expect(doctor).toContain("Lifecycle evidence — owner: global; operation id: orphan-operation; semantic step: refresh; 2 committed steps; recovery category: complete-or-rollback; target: not attributed; observational recovery command: picc plugin recover orphan-operation");
    expect(doctor).toContain("Diagnostic — global: ordinary diagnostic. Next: /plugin details alpha@official.");
    expect(doctor).not.toContain("Lifecycle evidence — owner: global; operation id: not available; semantic step: not available; recovery category: not available; target: not attributed; observational recovery command: /plugin details alpha@official");
  });

  it("builds capability evidence only after plugin agent and hook validation", () => {
    const { repo, userDir } = makeBase();
    const root = makeMarketplacePlugin(userDir, "official", "alpha");
    write(path.join(root, "agents", "alpha-agent.md"), "---\nname: alpha-agent\ndescription: alpha\npermissionMode: bypassPermissions\nhooks: {}\nmcpServers: {}\n---\nprompt");
    write(path.join(root, "hooks", "hooks.json"), JSON.stringify({
      FuturePluginEvent: [{ hooks: [{ type: "prompt", prompt: "ignored" }, { type: "future-handler" }] }],
      Notification: [{ hooks: [{ type: "command", command: "echo never" }] }],
      PreToolUse: [
        { hooks: [
          { type: "command", command: "echo safe" }, { type: "command", command: "echo safe" }, { type: "command", command: "" }, { type: "command", command: "   " },
          { type: "http", url: "https://example.test/hook" }, { type: "http", url: "https://example.test/hook" }, { type: "http", url: "not a url" },
          { type: "agent" }, { type: "mcp_tool" },
        ] },
        { matcher: "Read", if: "Read(src/**)", hooks: [{ type: "command", command: "echo safe" }] },
        { matcher: "Write", if: "Read(src/**)", hooks: [{ type: "command", command: "echo safe" }] },
        { matcher: "Write", if: "Edit(src/**)", hooks: [{ type: "command", command: "echo safe" }] },
      ],
      SessionStart: [{ hooks: [{ type: "mcp_tool" }] }],
    }));
    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@official": true } }));

    const project = load(repo, userDir);

    expect(project.pluginInventory.capabilityEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedIdentity: "alpha@official", capabilityId: "agent.frontmatter.permissionMode" }),
      expect.objectContaining({ qualifiedIdentity: "alpha@official", capabilityId: "agent.frontmatter.hooks" }),
      expect.objectContaining({ qualifiedIdentity: "alpha@official", capabilityId: "agent.frontmatter.mcpServers" }),
      expect.objectContaining({ qualifiedIdentity: "alpha@official", capabilityId: "hook.event.FuturePluginEvent", observation: "Plugin hook event is unassessed because its capability registry entry is absent" }),
      expect.objectContaining({ qualifiedIdentity: "alpha@official", capabilityId: "hook.event.Notification", observation: "Plugin hook event support is degraded-noop" }),
      expect.objectContaining({ qualifiedIdentity: "alpha@official", capabilityId: "feature.hook-handler.prompt", observation: "Plugin hook handler support is degraded-noop" }),
      expect.objectContaining({ qualifiedIdentity: "alpha@official", capabilityId: "feature.hook-handler.http", observation: "Plugin hook handler support is partial" }),
      expect.objectContaining({ qualifiedIdentity: "alpha@official", capabilityId: "feature.hook-handler.agent", observation: "Plugin hook handler support is degraded-noop" }),
      expect.objectContaining({ qualifiedIdentity: "alpha@official", capabilityId: "feature.hook-handler.mcp_tool-blocking-enforcement", component: "PreToolUse" }),
      expect.objectContaining({ qualifiedIdentity: "alpha@official", capabilityId: "feature.hook-handler.mcp_tool", component: "SessionStart" }),
      expect.objectContaining({ qualifiedIdentity: "alpha@official", capabilityId: "feature.hook-handler.future-handler", observation: "Capability observation is unassessed because its registry entry is absent" }),
    ]));
    expect(project.pluginInventory.capabilityEvidence.some((item) => item.capabilityId === "feature.hook-handler.command")).toBe(false);
    expect(project.pluginInventory.find("alpha@official")!.components.filter((item) => item.origin === "final-runtime")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "skills", count: 1, countSemantics: "finalized-registrations" }),
      expect.objectContaining({ kind: "agents", count: 1, countSemantics: "finalized-registrations" }),
      expect.objectContaining({ kind: "hooks", count: 7, countSemantics: "retained-executable-registrations" }),
    ]));
  });

  it("derives final component counts from post-dedupe registries and skill overrides", () => {
    const { repo, userDir } = makeBase(); const alpha = makeMarketplacePlugin(userDir, "official", "alpha"); const beta = makeMarketplacePlugin(userDir, "official", "beta");
    for (const root of [alpha, beta]) write(path.join(root, "hooks", "hooks.json"), JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "echo shared" }] }] }));
    write(path.join(repo, ".claude", "skills", "project-alpha", "SKILL.md"), "---\nname: alpha:alpha-skill\ndescription: project wins\n---\nbody");
    write(path.join(repo, ".claude", "skills", "project-run", "SKILL.md"), "---\nname: alpha:run\ndescription: project wins\n---\nbody");
    write(path.join(repo, ".claude", "agents", "project-alpha.md"), "---\nname: alpha:alpha-agent\ndescription: project wins\n---\nprompt");
    write(path.join(alpha, "commands", "run.md"), "overridden plugin command");
    write(path.join(alpha, "commands", "retained.md"), "retained plugin command");
    write(path.join(repo, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@official": true, "beta@official": true }, skillOverrides: { "beta:beta-skill": "off" } }));
    const project = load(repo, userDir);
    expect(project.pluginInventory.find("alpha@official")!.components.filter((item) => item.origin === "final-runtime")).toEqual([
      expect.objectContaining({ kind: "commands", count: 1, countSemantics: "finalized-registrations" }),
      expect.objectContaining({ kind: "hooks", count: 1, countSemantics: "retained-executable-registrations" }),
    ]);
    expect(project.pluginInventory.find("beta@official")!.components.filter((item) => item.origin === "final-runtime")).toEqual([
      expect.objectContaining({ kind: "agents", count: 1, countSemantics: "finalized-registrations" }),
      expect.objectContaining({ kind: "hooks", count: 1, countSemantics: "retained-executable-registrations" }),
    ]);
  });

  it("uses command-scoped inventory guidance through the integrated construction seam", () => {
    const { repo, userDir } = makeBase();
    const project = loadClaudeProject({ cwd: repo, userDir, managedSettingsPaths: [], managedArtifactDirs: [], pluginInventoryLifetime: "command" });
    expect(project.pluginInventory.lifetime).toBe("command");
    expect(project.pluginInventory.refreshGuidance).toBe("Captured for this command; run the command again to refresh.");
    expect(project.pluginInventory.refreshGuidance).not.toContain("/reload");
  });

  it("classifies the canonical active project and distinct main checkout in linked-worktree inventory", () => {
    const base = makeTmp();
    const main = path.join(base, "main");
    const linked = path.join(base, "linked");
    const userDir = path.join(base, "home", ".claude");
    const admin = path.join(main, ".git", "worktrees", "linked");
    fs.mkdirSync(linked, { recursive: true });
    write(path.join(linked, ".git"), `gitdir: ${admin}`);
    write(path.join(admin, "gitdir"), path.join(linked, ".git"));
    write(path.join(admin, "commondir"), "../..");
    makeMarketplacePlugin(userDir, "official", "alpha");
    const statePath = path.join(userDir, "plugins", "installed_plugins.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      plugins: Record<string, Array<Record<string, unknown>>>;
    };
    Object.assign(state.plugins["alpha@official"]![0]!, { scope: "project", projectPath: main });
    write(statePath, JSON.stringify(state));
    write(path.join(linked, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@official": true } }));

    const item = load(linked, userDir).pluginInventory.find("alpha@official")!;

    expect(item.enablement?.source).toEqual({ kind: "project", display: "<project>/.claude/settings.json" });
    expect(item.selectedInstallation?.project).toEqual({ kind: "main-checkout", display: "<main-checkout>" });
    expect(item.installations[0]?.projectLocation).toEqual({ kind: "main-checkout", display: "<main-checkout>" });
  });

  it("keeps a project-declared remote plugin passive without acquisition or lifecycle authority", () => {
    const { repo, userDir } = makeBase(); const lifecycleRoot = path.join(path.dirname(userDir), ".picc");
    write(path.join(userDir, "plugins", "known_marketplaces.json"), JSON.stringify({ official: { source: { source: "github", repo: "unavailable-owner/unavailable-catalog" } } }));
    write(path.join(userDir, "plugins", "marketplaces", "official", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "official", owner: { name: "Owner" }, plugins: [{ name: "catalog-only", source: { source: "github", repo: "unavailable-owner/unavailable-plugin", ref: "hostile-content-must-stay-unresolved" }, commands: "./commands", agents: "./agents", hooks: "./hooks/hooks.json" }] }));
    write(path.join(repo, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "catalog-only@official": true } }));
    expect(fs.existsSync(lifecycleRoot)).toBe(false);
    const processTraps = [
      vi.spyOn(childProcess, "spawn").mockImplementation((() => { throw new Error("passive load attempted spawn"); }) as typeof childProcess.spawn),
      vi.spyOn(childProcess, "spawnSync").mockImplementation((() => { throw new Error("passive load attempted spawnSync"); }) as typeof childProcess.spawnSync),
      vi.spyOn(childProcess, "exec").mockImplementation((() => { throw new Error("passive load attempted exec"); }) as unknown as typeof childProcess.exec),
      vi.spyOn(childProcess, "execSync").mockImplementation((() => { throw new Error("passive load attempted execSync"); }) as typeof childProcess.execSync),
      vi.spyOn(childProcess, "execFile").mockImplementation((() => { throw new Error("passive load attempted execFile"); }) as unknown as typeof childProcess.execFile),
      vi.spyOn(childProcess, "execFileSync").mockImplementation((() => { throw new Error("passive load attempted execFileSync"); }) as typeof childProcess.execFileSync),
      vi.spyOn(childProcess, "fork").mockImplementation((() => { throw new Error("passive load attempted fork"); }) as typeof childProcess.fork),
    ];
    const networkTraps = [
      vi.spyOn(http, "request").mockImplementation((() => { throw new Error("passive load attempted HTTP request"); }) as typeof http.request),
      vi.spyOn(http, "get").mockImplementation((() => { throw new Error("passive load attempted HTTP get"); }) as typeof http.get),
      vi.spyOn(https, "request").mockImplementation((() => { throw new Error("passive load attempted HTTPS request"); }) as typeof https.request),
      vi.spyOn(https, "get").mockImplementation((() => { throw new Error("passive load attempted HTTPS get"); }) as typeof https.get),
      vi.spyOn(net, "connect").mockImplementation((() => { throw new Error("passive load attempted network connect"); }) as typeof net.connect),
      vi.spyOn(net, "createConnection").mockImplementation((() => { throw new Error("passive load attempted network connection"); }) as typeof net.createConnection),
    ];
    const originalFetch = globalThis.fetch; const fetchTrap = vi.fn(() => Promise.reject(new Error("passive load attempted fetch"))); globalThis.fetch = fetchTrap;
    try {
      syncBuiltinESMExports();
      expect(() => spawn("")).toThrow("passive load attempted spawn");
      for (const trap of processTraps) trap.mockClear();

      const project = load(repo, userDir);
      for (const trap of [...processTraps, ...networkTraps]) expect(trap).not.toHaveBeenCalled(); expect(fetchTrap).not.toHaveBeenCalled();
      expect(project.plugins).toEqual([]);
      expect(project.pluginContexts.size).toBe(0);
      expect(project.skills.some((value) => value.source.pluginId === "catalog-only@official")).toBe(false);
      expect(project.agents.some((value) => value.source.pluginId === "catalog-only@official")).toBe(false);
      expect(JSON.stringify(project.mergedHooks)).not.toContain("catalog-only@official");
      expect(project.pluginInventory.find("catalog-only@official")).toMatchObject({ catalogPresence: true, outcome: { status: "enabled-but-uninstalled" } });
      expect(project.pluginInventory.find("catalog-only@official")!.components).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "commands", origin: "catalog" }),
        expect.objectContaining({ kind: "agents", origin: "catalog" }),
        expect.objectContaining({ kind: "hooks", origin: "catalog" }),
      ]));
      expect(project.pluginAdmissions).toEqual([]);
      expect(project.ownedMarketplaces).toEqual([]);
      expect(project.ownedProfileReference).toBeUndefined();
      expect(project.executableGenerationObservation).toEqual({ status: "absent" });
      expect(project.lifecycleObservation).toEqual({ records: [], receipts: [], pending: [] });
      expect(fs.existsSync(path.join(userDir, "plugins", "installed_plugins.json"))).toBe(false);
      expect(fs.existsSync(lifecycleRoot)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      for (const trap of [...processTraps, ...networkTraps]) trap.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("loads no installed content when enabledPlugins is absent", () => {
    const { repo, userDir } = makeBase();
    makeMarketplacePlugin(userDir, "official", "alpha");

    const project = load(repo, userDir);
    expect(project.plugins).toEqual([]);
    expect(project.skills.some((s) => s.source.pluginName === "alpha")).toBe(false);
    expect(JSON.stringify(project.mergedHooks)).not.toContain("alpha-hook");
  });

  it.each([
    ["stale cache", ["plugins", "cache", "official", "alpha", "0.9.0"], "stale-cache"],
    ["marketplace/catalog-style", ["plugins", "marketplaces", "official", "plugins", "alpha"], "catalog"],
  ] as const)("does not treat %s content as an installed record", (_label, segments, canary) => {
    const { repo, userDir } = makeBase();
    const root = path.join(userDir, ...segments);
    write(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha" }));
    writeSkill(path.join(root, "skills"), `${canary}-skill`, `${canary}-skill-description`);
    write(path.join(root, "commands", `${canary}-command.md`), `${canary}-command-body`);
    write(path.join(root, "agents", `${canary}-agent.md`), `---\ndescription: ${canary}-agent-description\n---\n${canary}-agent-body`);
    write(path.join(root, "hooks", "hooks.json"), JSON.stringify({
      PreToolUse: [{ hooks: [`echo ${canary}-hook`] }],
    }));
    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@official": true } }));

    const project = load(repo, userDir);
    const outcome = project.pluginResolutionOutcomes.find((item) => item.pluginId === "alpha@official")!;
    expect(outcome).toMatchObject({ pluginId: "alpha@official", status: "enabled-but-uninstalled", diagnostics: [] });
    expect(outcome.context).toBeUndefined();
    expect(outcome.sources).toBeUndefined();
    expect(project.plugins).toEqual([]);
    expect(project.pluginContexts.size).toBe(0);
    expect(project.skills.some((item) => item.name.includes(`${canary}-skill`))).toBe(false);
    expect(project.skills.some((item) => item.name.includes(`${canary}-command`))).toBe(false);
    expect(project.agents.some((item) => item.name.includes(`${canary}-agent`))).toBe(false);
    expect(JSON.stringify(project.mergedHooks)).not.toContain(`${canary}-hook`);
  });
});

describe("loadClaudeProject — installed hook provenance", () => {
  it("executes assembled project and installed default, explicit, and inline hooks with distinct qualified provenance", async () => {
    const { repo, userDir } = makeBase();
    const firstRoot = makeMarketplacePlugin(userDir, "first-market", "one");
    const secondRoot = makeMarketplacePlugin(userDir, "second-market", "two");
    const marker = path.join(repo, "hook-environments.jsonl");
    const script = path.join(repo, "record-hook.cjs");
    const command = 'exec "$HOOK_NODE" "$HOOK_SCRIPT"';
    write(script, [
      'const fs = require("node:fs");',
      'fs.appendFileSync(process.env.HOOK_MARKER, JSON.stringify({ label: process.argv[2], root: process.env.CLAUDE_PLUGIN_ROOT ?? null, data: process.env.CLAUDE_PLUGIN_DATA ?? null, project: process.env.CLAUDE_PROJECT_DIR }) + "\\n");',
    ].join("\n"));
    write(path.join(repo, ".claude", "settings.json"), JSON.stringify({
      enabledPlugins: { "one@first-market": true, "two@second-market": true },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, args: ["shared"] }] }] },
    }));
    write(path.join(firstRoot, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: "one",
      hooks: [
        "./explicit-hooks.json",
        { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, args: ["inline"] }] }] },
        { PreToolUse: command },
        { PreToolUse: { type: "command", command, args: ["malformed-object"] } },
        { PreToolUse: 42 },
      ],
    }));
    write(
      path.join(firstRoot, "explicit-hooks.json"),
      JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, args: ["explicit"] }] }] }),
    );
    for (const root of [firstRoot, secondRoot]) {
      write(
        path.join(root, "hooks", "hooks.json"),
        JSON.stringify({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, args: ["shared"], pluginId: "forged@raw" }] }] }),
      );
    }

    const project = load(repo, userDir);
    const handlers = project.mergedHooks["PreToolUse"]!.flatMap((entry) => entry.hooks);
    expect(handlers.map((handler) => handler.pluginId)).toEqual([
      undefined,
      "one@first-market",
      "one@first-market",
      "one@first-market",
      "two@second-market",
    ]);
    expect(handlers.filter((handler) => handler.raw["pluginId"] === "forged@raw")).toHaveLength(2);
    expect(project.diagnostics.filter((item) =>
      item.message === "Plugin hook event contribution must be an array and was ignored",
    )).toHaveLength(3);
    expect(project.pluginResolutionOutcomes.find((item) => item.pluginId === "one@first-market")?.diagnostics)
      .toContainEqual(expect.objectContaining({ message: expect.stringContaining("unsupported content") }));

    const runner = new HookRunner({
      config: project.mergedHooks,
      projectDir: repo,
      sessionId: "assembled-provenance",
      env: {
        HOOK_NODE: process.execPath.replaceAll("\\", "/"),
        HOOK_SCRIPT: script.replaceAll("\\", "/"),
        HOOK_MARKER: marker.replaceAll("\\", "/"),
        CLAUDE_PLUGIN_ROOT: "",
        CLAUDE_PLUGIN_DATA: "",
      },
      disableAllHooks: false,
      pluginContexts: project.pluginContexts,
      ensurePluginDataDir: (context) => {
        fs.mkdirSync(context.dataDir, { recursive: true });
        return { ok: true };
      },
    });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.diagnostics).toEqual([]);
    const records = fs.readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      label: string; root: string | null; data: string | null; project: string;
    });
    expect(records).toHaveLength(5);
    expect(records).toEqual(expect.arrayContaining([
      { label: "shared", root: "", data: "", project: repo },
      { label: "shared", root: firstRoot, data: project.pluginContexts.get("one@first-market")!.dataDir, project: repo },
      { label: "explicit", root: firstRoot, data: project.pluginContexts.get("one@first-market")!.dataDir, project: repo },
      { label: "inline", root: firstRoot, data: project.pluginContexts.get("one@first-market")!.dataDir, project: repo },
      { label: "shared", root: secondRoot, data: project.pluginContexts.get("two@second-market")!.dataDir, project: repo },
    ]));
    expect(records.some((record) => record.label.startsWith("malformed"))).toBe(false);
  });

  it.skipIf(!directoryLinkProbe)("keeps canonical skill, agent, and hook runtime roots fixed after cache-link retargeting", async () => {
    const { base, repo, userDir } = makeBase();
    const cacheLink = path.join(userDir, "plugins", "cache");
    const firstCache = path.join(base, "first-cache");
    const secondCache = path.join(base, "second-cache");
    fs.mkdirSync(path.dirname(cacheLink), { recursive: true });
    fs.mkdirSync(firstCache);
    fs.mkdirSync(secondCache);
    fs.symlinkSync(firstCache, cacheLink, process.platform === "win32" ? "junction" : "dir");
    const lexicalRoot = makeMarketplacePlugin(userDir, "official", "alpha");
    const skillFile = path.join(lexicalRoot, "skills", "alpha-skill", "SKILL.md");
    write(skillFile, "---\ndescription: canonical skill\n---\nroot=${CLAUDE_PLUGIN_ROOT}");
    write(
      path.join(lexicalRoot, "agents", "alpha-agent.md"),
      "---\nname: alpha-agent\ndescription: canonical agent\n---\nroot=${CLAUDE_PLUGIN_ROOT}",
    );
    const script = path.join(repo, "print-plugin-root.cjs");
    const marker = path.join(repo, "hook-root.txt");
    write(script, 'require("node:fs").writeFileSync(process.env.HOOK_MARKER, process.env.CLAUDE_PLUGIN_ROOT ?? "missing");');
    write(path.join(lexicalRoot, "hooks", "hooks.json"), JSON.stringify({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'exec "$HOOK_NODE" "$HOOK_SCRIPT"' }] }],
    }));
    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@official": true } }));

    const project = load(repo, userDir);
    const context = project.pluginContexts.get("alpha@official")!;
    const canonicalRoot = fs.realpathSync.native(lexicalRoot);
    const skill = project.skills.find((item) => item.source.pluginId === context.pluginId)!;
    const loadedSkillBody = loadSkillBody(skill);
    const agent = project.agents.find((item) => item.source.pluginId === context.pluginId)!;
    fs.unlinkSync(cacheLink);
    fs.symlinkSync(secondCache, cacheLink, process.platform === "win32" ? "junction" : "dir");

    expect(context.root).toBe(canonicalRoot);
    expect(substitutePluginRuntimeText(loadedSkillBody, context)).toBe(`root=${canonicalRoot}`);
    expect(projectPluginAgentRuntime(agent, context).body).toBe(`root=${canonicalRoot}`);
    const runner = new HookRunner({
      config: project.mergedHooks,
      projectDir: repo,
      sessionId: "canonical-root",
      env: {
        HOOK_NODE: process.execPath.replaceAll("\\", "/"),
        HOOK_SCRIPT: script.replaceAll("\\", "/"),
        HOOK_MARKER: marker.replaceAll("\\", "/"),
      },
      disableAllHooks: false,
      pluginContexts: project.pluginContexts,
      ensurePluginDataDir: () => ({ ok: true }),
    });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.diagnostics).toEqual([]);
    expect(fs.readFileSync(marker, "utf8")).toBe(canonicalRoot);
  });

  it("reserves bounded terminal reasons for only the identity that fails late", () => {
    const { repo, userDir } = makeBase();
    const alphaRoot = makeMarketplacePlugin(userDir, "official", "alpha");
    makeMarketplacePlugin(userDir, "official", "beta");
    for (let index = 0; index < 25; index++) {
      write(path.join(alphaRoot, "skills", `malformed-${index}`, "SKILL.md"), `malformed body ${index}`);
    }
    write(path.join(alphaRoot, "agents", "alpha-agent.md"), "---\nname: alpha-agent\ndescription: alpha\npermissionMode: bypassPermissions\n---\nprompt");
    write(path.join(userDir, "settings.json"), JSON.stringify({
      enabledPlugins: { "alpha@official": true, "beta@official": true },
    }));
    const hookPath = path.join(alphaRoot, "hooks", "hooks.json");
    const nativeRealpath = fs.realpathSync.native.bind(fs.realpathSync);
    let hookLookups = 0;
    const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation((value) => {
      if (path.normalize(String(value)) === path.normalize(hookPath) && ++hookLookups === 4) {
        const error = new Error("private close-to-use path");
        Object.assign(error, { code: "EACCES" });
        throw error;
      }
      return nativeRealpath(value);
    });
    try {
      const project = load(repo, userDir);
      const outcome = project.pluginResolutionOutcomes.find((item) => item.pluginId === "alpha@official")!;
      expect(outcome.status).toBe("rejected");
      expect(outcome.context).toBeUndefined();
      expect(outcome.sources).toBeUndefined();
      expect(project.diagnostics.filter((item) => item.message.includes("no description"))).toHaveLength(25);
      expect(outcome.diagnostics).toHaveLength(4);
      expect(outcome.diagnostics.map((item) => item.message)).toEqual(expect.arrayContaining([
        "Installed plugin skill/command loader reported malformed content",
        "Installed plugin agent loader reported a loader warning",
        "Installed plugin hook source loader reported unreadable content",
        "Installed plugin components could not be loaded safely; all contributions were rejected",
      ]));
      expect(outcome.diagnostics.length).toBeLessThanOrEqual(20);
      expect(outcome.diagnostics.every((item) => item.source === undefined)).toBe(true);
      expect(JSON.stringify(outcome.diagnostics)).not.toContain(alphaRoot);
      expect(JSON.stringify(outcome.diagnostics)).not.toContain(hookPath);
      expect(JSON.stringify(outcome.diagnostics)).not.toContain("private close-to-use path");
      expect(project.plugins.map((item) => item.pluginId)).toEqual(["beta@official"]);
      expect(project.pluginInventory.find("alpha@official")).toMatchObject({
        outcome: { status: "rejected" },
        selectedInstallation: { scope: "user", root: { kind: "plugin-cache" } },
      });
      expect(project.pluginInventory.find("alpha@official")!.components.filter((item) => item.origin === "final-runtime")).toEqual([]);
      expect(project.pluginInventory.capabilityEvidence.some((item) => item.qualifiedIdentity === "alpha@official" && item.capabilityId === "agent.frontmatter.permissionMode")).toBe(false);
      expect(project.skills.some((item) => item.source.pluginId === "alpha@official")).toBe(false);
      expect(project.agents.some((item) => item.source.pluginId === "alpha@official")).toBe(false);
      expect(JSON.stringify(project.mergedHooks)).not.toContain("alpha-hook");
      const sibling = project.pluginResolutionOutcomes.find((item) => item.pluginId === "beta@official")!;
      expect(sibling.status).toBe("loaded");
      expect(sibling.diagnostics).toEqual([]);
      expect(sibling.context).toEqual(project.pluginContexts.get("beta@official"));
      expect(sibling.sources?.length).toBeGreaterThan(0);
      expect(project.skills.some((item) => item.source.pluginId === "beta@official")).toBe(true);
      expect(project.agents.some((item) => item.source.pluginId === "beta@official")).toBe(true);
      expect(JSON.stringify(project.mergedHooks)).toContain("beta-hook");
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["commands", "agents"] as const)(
    "rejects a plugin when a directly declared explicit %s file fails at the final read",
    (field) => {
      const { repo, userDir } = makeBase();
      const alphaRoot = makeMarketplacePlugin(userDir, "official", "alpha");
      makeMarketplacePlugin(userDir, "official", "beta");
      const direct = path.join(alphaRoot, `direct-${field}.md`);
      write(
        direct,
        field === "agents" ? "---\ndescription: direct agent\n---\nbody" : "---\ndescription: direct command\n---\nbody",
      );
      write(
        path.join(alphaRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "alpha", [field]: `./direct-${field}.md` }),
      );
      write(path.join(userDir, "settings.json"), JSON.stringify({
        enabledPlugins: { "alpha@official": true, "beta@official": true },
      }));
      const originalReadFileSync = fs.readFileSync;
      const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((filePath: unknown, ...args: unknown[]) => {
        if (filePath === direct) {
          throw Object.assign(new Error("private final read"), { code: "EACCES" });
        }
        return (originalReadFileSync as (...readArgs: unknown[]) => unknown)(filePath, ...args);
      }) as typeof fs.readFileSync);
      try {
        const project = load(repo, userDir);
        const outcome = project.pluginResolutionOutcomes.find((item) => item.pluginId === "alpha@official")!;
        expect(outcome.status).toBe("rejected");
        expect(outcome.context).toBeUndefined();
        expect(outcome.sources).toBeUndefined();
        expect(project.pluginContexts.has("alpha@official")).toBe(false);
        expect(project.plugins.some((item) => item.pluginId === "alpha@official")).toBe(false);
        expect(project.skills.some((item) => item.source.pluginId === "alpha@official")).toBe(false);
        expect(project.agents.some((item) => item.source.pluginId === "alpha@official")).toBe(false);
        expect(JSON.stringify(project.mergedHooks)).not.toContain("alpha-hook");
        expect(outcome.diagnostics.map((item) => item.message)).toEqual(expect.arrayContaining([
          `Installed plugin ${field === "agents" ? "agent" : "skill/command"} loader reported unreadable content`,
          "Installed plugin components could not be loaded safely; all contributions were rejected",
        ]));
        expect(JSON.stringify(outcome.diagnostics)).not.toContain("private final read");
        const siblingOutcome = project.pluginResolutionOutcomes.find((item) => item.pluginId === "beta@official")!;
        expect(siblingOutcome.status).toBe("loaded");
        expect(siblingOutcome.context).toEqual(project.pluginContexts.get("beta@official"));
        expect(siblingOutcome.sources?.length).toBeGreaterThan(0);
        expect(project.skills.some((item) => item.source.pluginId === "beta@official")).toBe(true);
        expect(project.agents.some((item) => item.source.pluginId === "beta@official")).toBe(true);
        expect(JSON.stringify(project.mergedHooks)).toContain("beta-hook");
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("attaches safe component-local loader warnings to the owning loaded outcome", () => {
    const { repo, userDir } = makeBase();
    makeMarketplacePlugin(userDir, "official", "alpha");
    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@official": true } }));
    const root = path.join(userDir, "plugins", "cache", "official", "alpha", "1.0.0");
    write(path.join(root, "skills", "malformed", "SKILL.md"), "body without required description");
    write(path.join(root, "agents", "Upper.md"), "---\ndescription: malformed name\n---\nbody");
    write(path.join(root, "hooks", "hooks.json"), "not json");

    const project = load(repo, userDir);
    const outcome = project.pluginResolutionOutcomes.find((item) => item.pluginId === "alpha@official")!;
    expect(outcome.status).toBe("loaded");
    expect(outcome.diagnostics.map((item) => item.message)).toEqual(expect.arrayContaining([
      "Installed plugin skill/command loader reported malformed content",
      "Installed plugin agent loader reported malformed content",
      "Installed plugin hook source loader reported malformed content",
    ]));
    expect(outcome.diagnostics.every((item) => item.source === undefined)).toBe(true);
    expect(JSON.stringify(outcome.diagnostics)).not.toContain(root);
    expect(project.diagnostics.some((item) => item.message.includes("no description"))).toBe(true);
  });
});

describe("loadClaudeProject — agent MCP admission assembly", () => {
  it("publishes captured admission authority and derives provenance only from each declaration", () => {
    const { repo, userDir } = makeBase();
    write(path.join(repo, ".claude", "agents", "project-mcp.md"), [
      "---",
      "name: project-mcp",
      "description: project agent",
      "mcpServers:",
      "  - approved:",
      "      command: ${AGENT_BIN}",
      "  - self-approved:",
      "      command: self-command",
      "---",
      "project prompt",
    ].join("\n"));
    write(path.join(userDir, "agents", "user-mcp.md"), [
      "---",
      "name: user-mcp",
      "description: user agent",
      "mcpServers:",
      "  - user-inline:",
      "      command: user-command",
      "---",
      "user prompt",
    ].join("\n"));
    write(path.join(repo, ".claude", "settings.json"), JSON.stringify({ enabledMcpjsonServers: ["self-approved"] }));
    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledMcpjsonServers: ["approved"] }));

    const project = loadClaudeProject({
      cwd: repo,
      userDir,
      env: { AGENT_BIN: "frozen-command" },
      managedSettingsPaths: [],
      managedArtifactDirs: [],
    });
    expect(project.agentMcpAdmission).toBeDefined();
    expect(project.agentMcpAdmission!.resolve).toHaveLength(1);
    const projectAgent = findByName(project.agents, "project-mcp")!;
    const userAgent = findByName(project.agents, "user-mcp")!;

    expect(project.agentMcpAdmission!.resolve(projectAgent.agentMcp!).servers).toEqual([
      expect.objectContaining({ name: "approved", source: "subagent-inline", status: "enabled", command: "frozen-command" }),
      expect.objectContaining({ name: "self-approved", status: "pending-approval", inactiveReason: "mcpjson-unapproved" }),
    ]);
    expect(project.agentMcpAdmission!.resolve(userAgent.agentMcp!).servers).toEqual([
      expect.objectContaining({ name: "user-inline", source: "subagent-inline", status: "enabled", command: "user-command" }),
    ]);
  });
});

describe("loadClaudeProject — multi-scope precedence", () => {
  it("resolves same-named agent definitions through managed, nearest-project, root-project, and user scopes", () => {
    const { base, repo, userDir } = makeBase();
    const pkg = path.join(repo, "packages", "app");
    const managed = path.join(base, "managed");
    const agent = (description: string, body: string) => `---\nname: reviewer\ndescription: ${description}\n---\n${body}`;
    fs.mkdirSync(pkg, { recursive: true });
    write(path.join(userDir, "agents", "reviewer.md"), agent("user", "USER BODY"));
    expect(findByName(load(pkg, userDir).agents, "reviewer")).toMatchObject({
      body: "USER BODY",
      source: { scope: "user" },
    });

    write(path.join(repo, ".claude", "agents", "reviewer.md"), agent("root", "ROOT BODY"));
    expect(findByName(load(pkg, userDir).agents, "reviewer")).toMatchObject({
      body: "ROOT BODY",
      source: { scope: "project", path: path.join(repo, ".claude", "agents", "reviewer.md") },
    });

    write(path.join(pkg, ".claude", "agents", "reviewer.md"), agent("nearest", "NEAREST BODY"));
    expect(findByName(load(pkg, userDir).agents, "reviewer")).toMatchObject({
      body: "NEAREST BODY",
      source: { scope: "project", path: path.join(pkg, ".claude", "agents", "reviewer.md") },
    });

    write(path.join(managed, "agents", "reviewer.md"), agent("managed", "MANAGED BODY"));
    const managedWinner = loadClaudeProject({
      cwd: pkg,
      userDir,
      homeDir: path.dirname(userDir),
      managedSettingsPaths: [],
      managedArtifactDirs: [managed],
    });
    expect(findByName(managedWinner.agents, "reviewer")).toMatchObject({
      body: "MANAGED BODY",
      source: { scope: "managed", path: path.join(managed, "agents", "reviewer.md") },
    });
  });

  it("resolves a same-named skill at pkg/root/user scopes to the nearest project one; user-only skills stay usable", () => {
    const { repo, userDir } = makeBase();
    const pkg = path.join(repo, "packages", "app");
    writeSkill(path.join(repo, ".claude", "skills"), "deploy", "root deploy");
    writeSkill(path.join(pkg, ".claude", "skills"), "deploy", "pkg deploy");
    writeSkill(path.join(userDir, "skills"), "deploy", "user deploy");
    writeSkill(path.join(userDir, "skills"), "user-only", "only in user scope");

    const project = load(pkg, userDir);

    const deploy = project.skills.find((s) => s.name === "deploy");
    expect(deploy?.description).toBe("pkg deploy");
    expect(deploy?.source.scope).toBe("project");
    expect(project.skills.filter((s) => s.name === "deploy")).toHaveLength(1);
    expect(project.skills.find((s) => s.name === "user-only")?.source.scope).toBe("user");
  });

  it("nested .claude/settings.json is honored by the assembled project (cwd wiring)", () => {
    const { repo, userDir } = makeBase();
    const pkg = path.join(repo, "packages", "app");
    fs.mkdirSync(pkg, { recursive: true });
    write(path.join(repo, ".claude", "settings.json"), JSON.stringify({ model: "root-model" }));
    write(
      path.join(pkg, ".claude", "settings.json"),
      JSON.stringify({ model: "pkg-model", permissions: { deny: ["Bash(rm *)"] } }),
    );

    const project = load(pkg, userDir);
    expect(project.settings.model).toBe("pkg-model");
    expect(project.settings.permissions.deny).toEqual(["Bash(rm *)"]);
  });
});

describe("loadClaudeProject — plugin namespacing", () => {
  it("uses a unique namespaced plugin agent as the bare-name fallback", () => {
    const { repo, userDir } = makeBase();
    const pluginRoot = makeMarketplacePlugin(userDir, "official", "alpha");
    write(
      path.join(pluginRoot, "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: plugin reviewer\n---\nPLUGIN REVIEWER BODY",
    );
    write(
      path.join(userDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "alpha@official": true } }),
    );

    const pluginFallback = load(repo, userDir);
    expect(findByName(pluginFallback.agents, "reviewer")).toMatchObject({
      name: "alpha:reviewer",
      body: "PLUGIN REVIEWER BODY",
      source: { scope: "plugin", pluginName: "alpha" },
    });

    write(
      path.join(userDir, "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: user reviewer\n---\nUSER REVIEWER BODY",
    );
    expect(findByName(load(repo, userDir).agents, "reviewer")).toMatchObject({
      name: "reviewer",
      body: "USER REVIEWER BODY",
      source: { scope: "user" },
    });
  });

  it("keeps a plugin skill alongside a same-named project skill instead of dropping it", () => {
    const { repo, userDir } = makeBase();
    writeSkill(path.join(repo, ".claude", "skills"), "deploy", "project deploy");
    makeMarketplacePlugin(userDir, "official", "alpha");
    const pluginRoot = path.join(userDir, "plugins", "cache", "official", "alpha", "1.0.0");
    writeSkill(path.join(pluginRoot, "skills"), "deploy", "plugin deploy");
    write(
      path.join(userDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "alpha@official": true } }),
    );

    const project = load(repo, userDir);
    const names = project.skills.map((s) => s.name);
    expect(names).toContain("deploy");
    expect(names).toContain("alpha:deploy");
    expect(project.skills.find((s) => s.name === "alpha:deploy")?.source.pluginName).toBe("alpha");
    // findByName: exact match wins; the bare name resolves to the project skill.
    expect(findByName(project.skills, "deploy")?.description).toBe("project deploy");
    expect(findByName(project.skills, "alpha:deploy")?.description).toBe("plugin deploy");
  });
});

describe("loadClaudeProject — nested qualified names", () => {
  it("resolves a nested command's qualified name WITHOUT a collision; the plain stem resolves too", () => {
    const { repo, userDir } = makeBase();
    write(
      path.join(repo, ".claude", "commands", "frontend", "deploy.md"),
      "---\ndescription: FE deploy (nested, no collision)\n---\nbody",
    );

    const project = load(repo, userDir);
    const qualified = findByName(project.skills, "frontend:deploy");
    expect(qualified?.description).toBe("FE deploy (nested, no collision)");
    expect(qualified?.userInvocable).toBe(true);
    // The plain stem stays first-class (and model-listed).
    const plain = findByName(project.skills, "deploy");
    expect(plain?.description).toBe("FE deploy (nested, no collision)");
    expect(plain?.disableModelInvocation).toBe(false);
  });

  it("collision case unchanged: the first occurrence keeps the plain stem, the nested one its qualified name", () => {
    const { repo, userDir } = makeBase();
    write(
      path.join(repo, ".claude", "commands", "deploy.md"),
      "---\ndescription: top-level deploy\n---\nbody",
    );
    write(
      path.join(repo, ".claude", "commands", "frontend", "deploy.md"),
      "---\ndescription: FE deploy (nested)\n---\nbody",
    );

    const project = load(repo, userDir);
    expect(findByName(project.skills, "deploy")?.description).toBe("top-level deploy");
    expect(findByName(project.skills, "frontend:deploy")?.description).toBe("FE deploy (nested)");
  });
});

describe("findByName", () => {
  const mk = (name: string) => ({ name });

  it("resolves an unambiguous bare name against plugin-namespaced content", () => {
    expect(findByName([mk("alpha:review"), mk("deploy")], "review")?.name).toBe("alpha:review");
  });

  it("returns undefined for an ambiguous bare name", () => {
    expect(findByName([mk("alpha:review"), mk("beta:review")], "review")).toBeUndefined();
  });

  it("never suffix-matches a namespaced query", () => {
    expect(findByName([mk("alpha:review")], "other:review")).toBeUndefined();
  });
});

describe("loadClaudeProject — skillOverrides consumption", () => {
  it('honors "off", "user-invocable-only", and "name-only" and diagnoses unknown values', () => {
    const { repo, userDir } = makeBase();
    writeSkill(path.join(repo, ".claude", "skills"), "gone", "to be disabled");
    writeSkill(path.join(repo, ".claude", "skills"), "manual", "user invocable only");
    writeSkill(path.join(repo, ".claude", "skills"), "terse", "listed name-only");
    writeSkill(path.join(repo, ".claude", "skills"), "weird", "unknown override value");
    writeSkill(path.join(repo, ".claude", "skills"), "normal", "untouched");
    write(
      path.join(repo, ".claude", "settings.json"),
      JSON.stringify({
        skillOverrides: {
          gone: "off",
          manual: "user-invocable-only",
          terse: "name-only",
          weird: "sideways",
        },
      }),
    );

    const project = load(repo, userDir);
    const byName = new Map(project.skills.map((s) => [s.name, s]));
    expect(byName.has("gone")).toBe(false);
    expect(byName.get("manual")?.disableModelInvocation).toBe(true);
    expect(byName.get("terse")?.description).toBe("");
    expect(byName.get("weird")?.description).toBe("unknown override value");
    expect(byName.get("normal")?.description).toBe("untouched");
    expect(
      project.diagnostics.some((d) => d.message.includes('disabled by skillOverrides')),
    ).toBe(true);
    expect(
      project.diagnostics.some((d) => d.message.includes("Unknown skillOverrides value")),
    ).toBe(true);
  });
});

describe("loadClaudeProject — repository plugin boundary", () => {
  it("keeps repository-bundled plugin content inert even when its manifest is malformed", () => {
    const { repo, userDir } = makeBase();
    write(path.join(repo, ".claude-plugin", "plugin.json"), "{ this is not json !!");
    writeSkill(path.join(repo, ".claude-plugin", "skills"), "must-not-load", "repository content");

    const project = load(repo, userDir);
    expect(project.plugins).toEqual([]);
    expect(project.skills.some((skill) => skill.name.includes("must-not-load"))).toBe(false);
    expect(project.diagnostics.some((item) => item.source?.includes(".claude-plugin"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSystemPromptSuffix — listing degradation sink + Active skills
// budgeting
// ---------------------------------------------------------------------------

function suffixSettings(): ClaudeSettings {
  return {
    permissions: { allow: [], deny: [], ask: [], additionalDirectories: [] },
    hooks: {},
    env: {},
    disableAllHooks: false,
    disableSkillShellExecution: false,
    skillOverrides: {},
    claudeMdExcludes: [],
    worktree: { baseRef: "head" },
    subagentsEnabled: true,
    subagentMaxDepth: 2,
    subagentConcurrency: 4,
    enabledPlugins: undefined,
    unknownKeys: [],
    deferredKeys: [],
    diagnostics: [],
  };
}

function mkListedSkill(name: string, description: string, whenToUse?: string): ClaudeSkill {
  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    userInvocable: true,
    disableModelInvocation: false,
    contextFork: false,
    shell: "bash",
    metadata: {},
    baseDir: "/x",
    source: { path: "/x/SKILL.md", scope: "project" },
    legacyCommand: false,
    unknownKeys: [],
    diagnostics: [],
  };
}

describe("buildSystemPromptSuffix — skill-listing degradation sink", () => {
  // skillListingBudgetFraction 0.001 × 2M contextWindowChars → 2000-char budget.
  function build(skills: ClaudeSkill[], onDiagnostic: Parameters<typeof buildSystemPromptSuffix>[0]["onDiagnostic"]) {
    return buildSystemPromptSuffix({
      claudeMd: [],
      rules: [],
      skills,
      agents: [],
      settings: { ...suffixSettings(), skillListingBudgetFraction: 0.001 },
      state: newSessionContextState([]),
      contextWindowChars: 2_000_000,
      onDiagnostic,
    });
  }
  // Tier 4 set: names-only is the only fit within 2000 chars.
  const tier4Skills = Array.from({ length: 100 }, (_, i) => mkListedSkill(`s-${i}`, "D".repeat(500)));
  // Tier 2 set: dropping when: clauses fits within 2000 chars.
  const tier2Skills = Array.from({ length: 10 }, (_, i) =>
    mkListedSkill(`t-${i}`, "D".repeat(100), "W".repeat(200)),
  );

  it("an over-budget listing surfaces exactly one message; re-render same tier repeats nothing; a tier change reports anew", () => {
    const messages: string[] = [];
    const sink = createTierChangeReporter((m) => messages.push(m));

    build(tier4Skills, sink);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("tier 4");

    // Same tier on the next render (the suffix rebuilds every turn) → no repeat.
    build(tier4Skills, sink);
    expect(messages).toHaveLength(1);

    // Tier change → one new message.
    build(tier2Skills, sink);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("tier 2");
  });

  it("a within-budget listing never calls the sink", () => {
    const messages: string[] = [];
    build([mkListedSkill("tiny", "small description")], createTierChangeReporter((m) => messages.push(m)));
    expect(messages).toEqual([]);
  });
});

describe("buildSystemPromptSuffix — Active skills budgeting", () => {
  function buildWithActive(active: Array<[string, string]>): string {
    const state = newSessionContextState([]);
    for (const [name, body] of active) state.activeSkills.set(name, body);
    return buildSystemPromptSuffix({
      claudeMd: [],
      rules: [],
      skills: [],
      agents: [],
      settings: suffixSettings(),
      state,
    });
  }

  it("keeps small active skill bodies untouched (no truncation, no note)", () => {
    const suffix = buildWithActive([
      ["first", "FIRST-BODY"],
      ["second", "SECOND-BODY"],
    ]);
    expect(suffix).toContain("## Active skills");
    expect(suffix).toContain("FIRST-BODY");
    expect(suffix).toContain("SECOND-BODY");
    expect(suffix).not.toContain("[truncated for compaction]");
    expect(suffix).not.toContain("for context budget");
    // Most recently activated first (Map insertion order = activation order).
    expect(suffix.indexOf("### Active skill: second")).toBeLessThan(
      suffix.indexOf("### Active skill: first"),
    );
  });

  it("caps a resident body at the per-skill budget and appends the note", () => {
    const suffix = buildWithActive([["big", "X".repeat(REINJECT_PER_SKILL_MAX_CHARS + 5000)]]);
    expect(suffix).toContain("[truncated for compaction]");
    expect(suffix).not.toContain("X".repeat(REINJECT_PER_SKILL_MAX_CHARS + 1));
    expect(suffix).toContain("(1 older skill body truncated/dropped for context budget)");
  });

  it("drops the oldest bodies beyond the combined budget and counts them in the note", () => {
    // 7 × 20k-char bodies exceed the 100k combined cap → the oldest two drop.
    const active: Array<[string, string]> = Array.from({ length: 7 }, (_, i) => [
      `sk-${i}`,
      `MARK-${i}-` + "Y".repeat(REINJECT_PER_SKILL_MAX_CHARS - 10),
    ]);
    const suffix = buildWithActive(active);
    expect(suffix).toContain("### Active skill: sk-6"); // newest survives
    expect(suffix).not.toContain("### Active skill: sk-0"); // oldest dropped
    expect(suffix).not.toContain("### Active skill: sk-1");
    expect(suffix).toContain("older skill bodies truncated/dropped for context budget");
    // Sanity: the section obeys the combined cap (plus headers/note slack).
    const start = suffix.indexOf("## Active skills");
    expect(suffix.length - start).toBeLessThanOrEqual(REINJECT_COMBINED_MAX_CHARS + 2000);
  });
});

describe("loadClaudeProject — PiCC-owned admission composition", () => {
  it("loads one committed owned generation and observes lifecycle state without mutation", () => {
    const { base, repo, userDir } = makeBase();
    const owned = installOwnedPlugin(base, repo, userDir);
    const lifecycleRoot = path.join(path.dirname(userDir), ".picc", "plugins", "v1");
    const snapshot = (): string => {
      const entries: string[] = []; const walk = (directory: string): void => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else entries.push(`${path.relative(lifecycleRoot, file)}:${fs.readFileSync(file).toString("base64")}`); } }; walk(lifecycleRoot); return entries.sort().join("\n");
    };
    const before = snapshot();
    const project = load(repo, userDir);
    expect(project.ownedMarketplaces).toEqual([expect.objectContaining({ name: "official", selectedSnapshotId: expect.stringMatching(/^marketplace-/u) })]);
    expect(project.pluginAdmissions).toEqual(expect.arrayContaining([expect.objectContaining({ ownership: "picc-owned", pluginId: "owned@official", installPath: owned.root })]));
    expect(project.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ pluginId: "owned@official", ownership: "picc-owned" })]));
    expect(findByName(project.skills, "owned:owned-skill")).toBeDefined();
    expect(project.pluginContexts.get("owned@official")?.dataDir).toContain(owned.dataRoot);
    expect(project.lifecycleObservation.records.filter((item) => item.status === "admitted")).toHaveLength(3);
    const authority = project.pluginAdmissions.find((value) => value.ownership === "picc-owned" && value.pluginId === "owned@official"); if (authority?.ownership !== "picc-owned") throw new Error("owned authority");
    expect(project.pluginInventory.loadedGenerationId).toBe("admission-current");
    expect(project.pluginInventory.find("owned@official")?.lifecycle).toMatchObject({ ownership: "picc-owned", mutableRecordKey: pluginMutableRecordKey(authority.authority.record), selectedScope: "project", loaded: true, dependency: { state: "satisfied" } });
    expect(project.pluginInventory.find("owned@official")?.lifecycle?.candidates).toEqual([expect.objectContaining({ mutableRecordKey: pluginMutableRecordKey(authority.authority.record), selected: true })]);
    expect(project.pluginInventory.marketplaces.find((value) => value.name === "official")).toMatchObject({ ownership: "picc-owned", candidates: [expect.objectContaining({ mutableRecordKey: ownedMarketplaceScopeKey(project.ownedMarketplaces[0]!), trusted: true })], availableActions: ["inspect"], readOnlyReason: expect.stringContaining("No exact selected") });
    expect(snapshot()).toBe(before);
  });

  it("exposes catalog-only install eligibility only through the exact selected owned marketplace", () => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { catalogOnlyName: "catalog-only" });
    const source = path.join(repo, "catalog"); fs.cpSync(path.dirname(owned.root), source, { recursive: true }); write(path.join(repo, ".claude", "settings.json"), JSON.stringify({ extraKnownMarketplaces: { official: { source: { source: "directory", path: "./catalog" } } } }));
    const project = load(repo, userDir); const catalogOnly = project.pluginInventory.find("catalog-only@official");
    expect(catalogOnly).toMatchObject({ catalogPresence: true, lifecycle: { ownership: "unknown", marketplaceOwnership: "picc-owned", installed: false, availableActions: ["install"] } });
    expect(project.pluginInventory.marketplaces.find((value) => value.name === "official")).toMatchObject({ ownership: "picc-owned", availableActions: ["inspect", "refresh", "remove"] });
  });

  it.each([
    ["missing", (catalog: string) => fs.rmSync(catalog)],
    ["mutated", (catalog: string) => fs.appendFileSync(catalog, " ")],
    ["aliased", (catalog: string) => { const target = path.join(path.dirname(path.dirname(path.dirname(catalog))), "external-catalog.json"); fs.renameSync(catalog, target); fs.linkSync(target, catalog); }],
  ] as const)("rejects %s retained marketplace catalog evidence", (_label, mutateCatalog) => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir); const catalog = path.join(path.dirname(owned.root), ".claude-plugin", "marketplace.json"); mutateCatalog(catalog);
    const project = load(repo, userDir); expect(project.ownedMarketplaces).toEqual([]); expect(project.plugins).toEqual([]);
    expect(project.lifecycleObservation.records).toEqual(expect.arrayContaining([expect.objectContaining({ path: owned.snapshotRecordPath, status: "inert", code: "artifact-mismatch" })]));
  });

  it("rejects an initially authored catalog above the catalog-read bound while within tree bounds", () => {
    const { base, repo, userDir } = makeBase(); const padding = "x".repeat(1024 * 1024 + 1); const owned = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { catalogPadding: padding, snapshotOnly: true });
    const catalogPath = path.join(path.dirname(owned.root), ".claude-plugin", "marketplace.json"); const catalogBytes = fs.statSync(catalogPath).size;
    expect(catalogBytes).toBeGreaterThan(1024 * 1024); expect(catalogBytes).toBeLessThan(PORTABLE_TREE_LIMITS.maximumFileBytes); expect(catalogBytes).toBeLessThan(PORTABLE_TREE_LIMITS.maximumTotalBytes);
    const project = load(repo, userDir); expect(project.ownedMarketplaces).toEqual([]); expect(project.plugins).toEqual([]);
    expect(project.lifecycleObservation.records).toEqual(expect.arrayContaining([expect.objectContaining({ path: owned.snapshotRecordPath, status: "inert", code: "artifact-mismatch" })]));
  });

  it("keeps basic materialized snapshot observation when no valid relative declaration is authorized", () => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { catalogMetadataPluginRoot: "../invalid", snapshotOnly: true }); const project = load(repo, userDir);
    expect(project.ownedMarketplaces).toHaveLength(1); expect(project.plugins).toEqual([]);
    expect(project.lifecycleObservation.records).toEqual(expect.arrayContaining([expect.objectContaining({ path: owned.snapshotRecordPath, status: "admitted" })]));
  });

  it("projects only the active same-name checkout family while retaining the foreign record passively", () => {
    const { base, repo, userDir } = makeBase(); installOwnedPlugin(base, repo, userDir); const first = load(repo, userDir);
    const registration = first.lifecycleObservation.records.find((item) => item.producer?.schema === "marketplace-registration"); if (registration?.producer === undefined) throw new Error("registration");
    const payload = registration.producer.payload as Record<string, unknown>; const foreignKey = `checkout-${"f".repeat(43)}`; const foreign = { ...payload, checkoutFamilyKey: foreignKey, projectKey: foreignKey };
    const profileKey = payload.profileKey as import("../src/plugin-lifecycle/types.js").LifecycleProfileKey; const scopeKey = ownedMarketplaceScopeKey(foreign as never); const envelope = createRecordEnvelope(createOwnedMarketplaceCodec(profileKey), "picc-owned", scopeKey, foreign as never); if (!envelope.ok) throw new Error(envelope.message);
    const recordsRoot = path.dirname(path.dirname(path.dirname(registration.path))); const profileRoot = path.dirname(recordsRoot); const store = { root: profileRoot, profileRoot, profileKey, recordsRoot, artifactsRoot: "", stagingRoot: "", generationsRoot: "", journalsRoot: "", receiptsRoot: "", locksRoot: "", quarantineRoot: "", dataRoot: path.join(profileRoot, "data") } satisfies OwnedStateStore; const partition = ownedRecordPartition(store, "picc-owned", scopeKey); if (!partition.ok) throw new Error(partition.message); const foreignPath = path.join(partition.value, "record.json"); write(foreignPath, envelope.value.bytes);
    const project = load(repo, userDir); expect(project.ownedMarketplaces).toEqual([expect.objectContaining({ name: "official", checkoutFamilyKey: payload.checkoutFamilyKey })]);
    expect(project.lifecycleObservation.records).toEqual(expect.arrayContaining([expect.objectContaining({ path: foreignPath, status: "admitted", producer: expect.objectContaining({ payload: expect.objectContaining({ checkoutFamilyKey: foreignKey }) }) })]));
  });

  it("fresh-loads a stable registration refresh while retaining both snapshots and executable generation", () => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir); const first = load(repo, userDir);
    const registration = first.lifecycleObservation.records.find((item) => item.producer?.schema === "marketplace-registration"); const oldSnapshot = first.lifecycleObservation.records.find((item) => item.producer?.schema === "marketplace-catalog-snapshot"); if (registration?.producer === undefined || oldSnapshot?.producer === undefined) throw new Error("owned records");
    const oldArtifactRoot = path.dirname(owned.root); const candidate = path.join(base, "refreshed-artifact"); fs.cpSync(oldArtifactRoot, candidate, { recursive: true }); const refreshedCatalog = Buffer.from(JSON.stringify({ name: "official", owner: { name: "PiCC refreshed" }, plugins: [{ name: "owned", source: "./owned" }] })); fs.writeFileSync(path.join(candidate, ".claude-plugin", "marketplace.json"), refreshedCatalog);
    const refreshedTree = digestArtifactEntries(artifactEntriesFromDirectory(candidate)); const profileRoot = path.dirname(path.dirname(path.dirname(path.dirname(oldSnapshot.path)))); const artifactsRoot = path.join(profileRoot, "artifacts", "sha256"); const refreshedRoot = path.join(artifactsRoot, refreshedTree.slice(7)); fs.renameSync(candidate, refreshedRoot);
    const catalogDigest = sha256(refreshedCatalog); const snapshotId = `marketplace-${createHash("sha256").update(`${catalogDigest}\0${refreshedTree}`).digest("base64url")}` as const;
    const refreshedExecutableCatalog = deriveExecutableMarketplaceCatalogProjection(refreshedCatalog, "local-directory"); if (refreshedExecutableCatalog === undefined) throw new Error("catalog projection");
    const oldPayload = oldSnapshot.producer.payload as Record<string, unknown>; const target: MarketplaceSnapshotTrustTarget = { authorityKind: "materialized", marketplaceName: "official", snapshotId, source: oldPayload.source as Extract<MarketplaceSnapshotTrustTarget, { authorityKind: "materialized" }>["source"], catalogDigest, executableCatalog: refreshedExecutableCatalog, artifactDigest: refreshedTree, treeDigest: refreshedTree, rootDigest: refreshedTree, selectedRoot: { requested: "tree-root", path: "", usedSingleWrapper: false }, artifactRoot: refreshedRoot, installRoot: refreshedRoot, catalogRelativePath: ".claude-plugin/marketplace.json", provenance: { adapter: "local-directory-snapshot", artifactDigest: refreshedTree } }; const trust = createMarketplaceSnapshotTrustGrant(target); if (!trust.ok) throw new Error(trust.message);
    const profileKey = oldPayload.profileKey as import("../src/plugin-lifecycle/types.js").LifecycleProfileKey; const snapshot = { ownership: "picc-owned", profileKey, ...target, trust: trust.value } as const; const snapshotScope = ownedMarketplaceSnapshotScopeKey(snapshot); const snapshotEnvelope = createRecordEnvelope(createOwnedMarketplaceSnapshotCodec({ profileKey, artifactsRoot }), "picc-owned", snapshotScope, snapshot); if (!snapshotEnvelope.ok) throw new Error(snapshotEnvelope.message);
    const recordsRoot = path.dirname(path.dirname(path.dirname(registration.path))); const store = { root: profileRoot, profileRoot, profileKey, recordsRoot, artifactsRoot, stagingRoot: "", generationsRoot: "", journalsRoot: "", receiptsRoot: "", locksRoot: "", quarantineRoot: "", dataRoot: path.join(profileRoot, "data") } satisfies OwnedStateStore; const snapshotPartition = ownedRecordPartition(store, "picc-owned", snapshotScope); if (!snapshotPartition.ok) throw new Error(snapshotPartition.message); write(path.join(snapshotPartition.value, "record.json"), snapshotEnvelope.value.bytes);
    const refreshedRegistration = { ...(registration.producer.payload as Record<string, unknown>), selectedSnapshotId: snapshotId }; const stableScope = ownedMarketplaceScopeKey(refreshedRegistration as never); expect(stableScope).toBe(registration.producer.scopeKey); const registrationEnvelope = createRecordEnvelope(createOwnedMarketplaceCodec(profileKey), "picc-owned", stableScope, refreshedRegistration as never); if (!registrationEnvelope.ok) throw new Error(registrationEnvelope.message); fs.writeFileSync(registration.path, registrationEnvelope.value.bytes);
    const second = load(repo, userDir); expect(second.ownedMarketplaces).toEqual([expect.objectContaining({ selectedSnapshotId: snapshotId })]); expect(second.lifecycleObservation.records.filter((item) => item.producer?.schema === "marketplace-catalog-snapshot" && item.status === "admitted")).toHaveLength(2); expect(second.plugins.map((plugin) => plugin.pluginId)).toEqual(["owned@official"]); expect(second.executableGenerationObservation).toMatchObject({ status: "valid", generation: { generationId: "admission-current" } });
  });

  it("executes and freshly reconstructs an authentic operation-bound owned data retirement", async () => {
    const setup = async (operationId: string) => {
      const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir); const survivorOwned = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { manifest: true, name: "survivor" });
      const currentGeneration = JSON.parse(fs.readFileSync(owned.generationPath, "utf8")) as ExecutableAdmissionGeneration; const predecessorGeneration = { ...currentGeneration, members: [owned.member, survivorOwned.member] } as unknown as ExecutableAdmissionGeneration; const predecessorGenerationBytes = canonicalJsonBytes(predecessorGeneration); if (!predecessorGenerationBytes.ok) throw new Error(predecessorGenerationBytes.message); fs.writeFileSync(owned.generationPath, predecessorGenerationBytes.value);
      const loaded = load(repo, userDir);
      if (loaded.ownedProfileReference === undefined) throw new Error("complete reference"); const selected = loaded.ownedProfileReference.installations.find((item) => item.record.pluginId === "owned@official"); const survivor = loaded.ownedProfileReference.installations.find((item) => item.record.pluginId === "survivor@official"); if (selected === undefined || survivor === undefined) throw new Error("selected installation set");
      expect(ownedPluginDataDeletionEligible("owned@official", loaded.ownedProfileReference)).toBe(false);
      if (process.platform !== "win32") { const chmodDirectories = (root: string): void => { fs.chmodSync(root, 0o700); for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) chmodDirectories(path.join(root, entry.name)); }; chmodDirectories(path.join(path.dirname(userDir), ".picc")); }
      const locations = createLifecycleLocations({ homeDir: path.dirname(userDir), profilePath: userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: repo, checkoutFamilyPath: repo } }); if (!locations.ok) throw new Error("locations"); const established = await establishOwnedStateStore(locations.value, path.dirname(userDir)); if (!established.ok) throw new Error(established.message); const store = established.value;
      const predecessor = loaded.ownedProfileReference.generation; const successorId = `admission-${operationId}`; const snapshots = loaded.lifecycleObservation.records.filter((item) => item.status === "admitted" && item.producer?.schema === "marketplace-catalog-snapshot").map((item) => item.producer!.payload as OwnedMarketplaceSnapshotRecord); const snapshotMap: Record<string, OwnedMarketplaceSnapshotRecord[]> = {}; for (const snapshot of snapshots) (snapshotMap[snapshot.snapshotId] ??= []).push(snapshot);
      const installationCodec = createOwnedPluginInstallationCodec({ profileKey: store.profileKey as never, artifactsRoot: store.artifactsRoot, marketplaceSnapshots: snapshotMap }); const reboundSurvivor = { ...survivor.record, executableGenerationId: successorId }; const reboundEnvelope = createRecordEnvelope(installationCodec, "picc-owned", `project-${survivor.record.projectKey}`, reboundSurvivor); if (!reboundEnvelope.ok) throw new Error(reboundEnvelope.message);
      const survivorMember = predecessor.members.find((member) => member.pluginId === "survivor@official"); if (survivorMember === undefined) throw new Error("survivor member"); const successor = { ...predecessor, generationId: successorId, members: [{ ...survivorMember, recordDigest: reboundEnvelope.value.envelope.payloadDigest }] } satisfies ExecutableAdmissionGeneration;
      const issued = issueOwnedDataRetirementProducerEvidence({ store, predecessor: loaded.ownedProfileReference, selectedInstallation: selected, successorGeneration: successor }); if (!issued.ok) throw new Error(issued.message);
      expect(issueOwnedDataRetirementProducerEvidence({ store, predecessor: loaded.ownedProfileReference, selectedInstallation: selected, successorGeneration: { ...successor, generationId: predecessor.generationId } })).toMatchObject({ ok: false });
      expect(issueOwnedDataRetirementProducerEvidence({ store, predecessor: { ...loaded.ownedProfileReference, generation: { ...predecessor, generationId: "admission-decoy" } }, selectedInstallation: selected, successorGeneration: successor })).toMatchObject({ ok: false });
      const recordBytes = fs.readFileSync(owned.installationRecordPath); const survivorBytes = fs.readFileSync(survivorOwned.installationRecordPath); const recordEnvelope = JSON.parse(recordBytes.toString()) as { scopeKey: string }; const survivorRecordEnvelope = JSON.parse(survivorBytes.toString()) as { scopeKey: string }; const stage = (name: string, bytes: Uint8Array): string => { const target = path.join(store.stagingRoot, name); fs.writeFileSync(target, bytes); return target; };
      const recordStage = stage(`${operationId}-record.stage`, recordBytes); const recordBackup = stage(`${operationId}-record.backup`, recordBytes);
      const deletion: OrdinaryTransactionParticipant = { kind: "plugin-installation-delete", effect: "delete", key: "installation", ownerKey: "picc-owned", scopeKey: recordEnvelope.scopeKey, targetPath: owned.installationRecordPath, targetClass: "owned", precondition: { state: "present", digest: sha256(recordBytes) }, stagedPath: recordStage, stagedDigest: sha256(recordBytes), rollback: { kind: "restore-backup", path: recordBackup, digest: sha256(recordBytes) }, producerEvidence: { role: "selected-installation-delete" } };
      const settingsBytes = Buffer.from("{\"enabledPlugins\":{}}"); const settingsStage = stage(`${operationId}-settings.stage`, settingsBytes); const settingsTarget = path.join(repo, ".picc-retirement-settings.json"); const settingsPrefix: OrdinaryTransactionParticipant = { kind: "plugin-settings", key: "settings-prefix", ownerKey: "plugin-settings", scopeKey: "project-settings", targetPath: settingsTarget, targetClass: "external", precondition: { state: "absent" }, stagedPath: settingsStage, stagedDigest: sha256(settingsBytes), rollback: { kind: "delete-new-target" }, producerEvidence: { role: "authorized-settings-prefix" } };
      const caseVariedProfileRoot = process.platform === "win32" ? store.profileRoot.replace(/[A-Za-z]/g, (value) => value === value.toLowerCase() ? value.toUpperCase() : value.toLowerCase()) : store.profileRoot;
      const insideSettingsTarget = path.join(caseVariedProfileRoot, "inside-profile-settings.json"); const insideSettingsPrefix: OrdinaryTransactionParticipant = { ...settingsPrefix, key: "inside-profile-settings-prefix", targetPath: insideSettingsTarget };
      const survivorStage = stage(`${operationId}-survivor.stage`, reboundEnvelope.value.bytes); const survivorBackup = stage(`${operationId}-survivor.backup`, survivorBytes); const replacement: OrdinaryTransactionParticipant = { kind: "plugin-installation-replace", key: "survivor-rebind", ownerKey: "picc-owned", scopeKey: survivorRecordEnvelope.scopeKey, targetPath: survivorOwned.installationRecordPath, targetClass: "owned", precondition: { state: "present", digest: sha256(survivorBytes) }, stagedPath: survivorStage, stagedDigest: sha256(reboundEnvelope.value.bytes), rollback: { kind: "restore-backup", path: survivorBackup, digest: sha256(survivorBytes) }, producerEvidence: { role: "survivor-generation-rebind", predecessorEnvelopeBase64: survivorBytes.toString("base64"), successorEnvelopeBase64: Buffer.from(reboundEnvelope.value.bytes).toString("base64") } };
      const dataPath = path.join(store.dataRoot, `plugin-${createHash("sha256").update("owned@official").digest("base64url")}`); fs.mkdirSync(dataPath); fs.writeFileSync(path.join(dataPath, "state"), "persistent");
      const retirement = await createOwnedDataRetirementParticipant({ store, operationId, participantIndex: 3, key: "data", qualifiedIdentity: "owned@official", producerEvidence: issued.value }); if (!retirement.ok) throw new Error(retirement.message);
      const successorBytes = canonicalJsonBytes(successor); if (!successorBytes.ok) throw new Error(successorBytes.message); const successorStage = stage(`${operationId}-successor.stage`, successorBytes.value); const predecessorBytes = fs.readFileSync(owned.generationPath); const predecessorBackup = stage(`${operationId}-generation.backup`, predecessorBytes);
      const generation: OrdinaryTransactionParticipant = { kind: "executable-generation", key: "generation", ownerKey: "picc-owned", scopeKey: "generation", targetPath: path.join(store.generationsRoot, "current.json"), targetClass: "generation", precondition: { state: "present", digest: sha256(predecessorBytes) }, stagedPath: successorStage, stagedDigest: sha256(successorBytes.value), rollback: { kind: "restore-backup", path: predecessorBackup, digest: sha256(predecessorBytes) }, producerEvidence: { generation: successor }, generationId: successor.generationId };
      const participants: readonly TransactionParticipant[] = [settingsPrefix, deletion, replacement, retirement.value, generation]; expect(reconstructOwnedDataRetirementProducerEvidence(store, issued.value, { targetPath: deletion.targetPath, targetDigest: deletion.precondition.state === "present" ? deletion.precondition.digest : sha256(Buffer.alloc(0)), backupPath: recordBackup, backupDigest: sha256(recordBytes), scopeKey: deletion.scopeKey })).toMatchObject({ ok: true }); const productionAuthorizer = createOwnedDataRetirementAuthorizer({ store, qualifiedIdentity: "owned@official" }); let capturedContext: Parameters<typeof productionAuthorizer>[0] | undefined; let retirementAuthorizationCalls = 0; const makeCodec = (): TransactionProducerCodec => ({ schema: `test.production-retirement-${operationId}`, version: 1, decodeSummary: (value) => typeof value === "object" && value !== null && (value as { operationId?: unknown }).operationId === operationId ? { ok: true, value } : { ok: false, code: "summary", message: "invalid" }, validatePlan: (plan) => plan.length === 5 ? { ok: true, value: undefined } : { ok: false, code: "plan", message: "invalid" }, authorizeExternal: (context) => context.participant.kind === "plugin-settings" && (context.participant.targetPath === settingsTarget || context.participant.targetPath === insideSettingsTarget) ? { ok: true, value: undefined } : { ok: false, code: "settings", message: "wrong settings" }, requiredLocks: () => ({ ok: true, value: [{ kind: "profile", key: store.profileKey }] }), authorizeOwnedDelete: (context) => context.participant.targetPath === owned.installationRecordPath ? { ok: true, value: undefined } : { ok: false, code: "delete", message: "wrong delete" }, authorizeOwnedDataRetirement: async (context) => { retirementAuthorizationCalls += 1; capturedContext = context; return productionAuthorizer(context); } });
      const productionInvalidDelete: OrdinaryTransactionParticipant = { ...deletion, key: "survivor-delete", scopeKey: survivorRecordEnvelope.scopeKey, targetPath: survivorOwned.installationRecordPath, precondition: { state: "present", digest: sha256(survivorBytes) }, stagedPath: survivorBackup, stagedDigest: sha256(survivorBytes), rollback: { kind: "restore-backup", path: survivorBackup, digest: sha256(survivorBytes) } }; expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [productionInvalidDelete, deletion, settingsPrefix, retirement.value, generation] })).toMatchObject({ ok: false, code: "invalid-producer-data" });
      const wrongSuccessorPayload = { ...successor, generationId: `admission-${operationId}-wrong` }; const wrongSuccessorBytes = canonicalJsonBytes(wrongSuccessorPayload); if (!wrongSuccessorBytes.ok) throw new Error(wrongSuccessorBytes.message); const wrongSuccessorPath = stage(`${operationId}-wrong-successor.stage`, wrongSuccessorBytes.value); const wrongSuccessor = { ...generation, generationId: wrongSuccessorPayload.generationId, stagedPath: wrongSuccessorPath, stagedDigest: sha256(wrongSuccessorBytes.value), producerEvidence: { generation: wrongSuccessorPayload } }; expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [settingsPrefix, deletion, replacement, retirement.value, wrongSuccessor] })).toMatchObject({ ok: false, code: "invalid-producer-data" });
      const decoyPath = path.join(store.generationsRoot, "decoy.json"); fs.writeFileSync(decoyPath, predecessorBytes); const decoyGeneration = { ...generation, targetPath: decoyPath }; expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [settingsPrefix, deletion, replacement, retirement.value, decoyGeneration] })).toMatchObject({ ok: false, code: "invalid-producer-data" });
      expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [settingsPrefix, deletion, { ...replacement, kind: "ordinary-record" }, retirement.value, generation] })).toMatchObject({ ok: false, code: "invalid-producer-data" });
      expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [replacement, deletion, settingsPrefix, retirement.value, generation] })).toMatchObject({ ok: false, code: "invalid-producer-data" });
      const earlyRetirement = await createOwnedDataRetirementParticipant({ store, operationId, participantIndex: 2, key: "data", qualifiedIdentity: "owned@official", producerEvidence: issued.value }); if (!earlyRetirement.ok) throw new Error(earlyRetirement.message); expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [settingsPrefix, deletion, earlyRetirement.value, replacement, generation] })).toMatchObject({ ok: false, code: "invalid-producer-data" });
      const alteredSuccessorEnvelope = Buffer.from((replacement.producerEvidence as { successorEnvelopeBase64: string }).successorEnvelopeBase64, "base64"); const alteredRaw = JSON.parse(alteredSuccessorEnvelope.toString()) as { payload: Record<string, unknown> }; alteredRaw.payload = { ...alteredRaw.payload, version: "2.0.0" }; const alteredPayload = canonicalJsonBytes(alteredRaw.payload); if (!alteredPayload.ok) throw new Error(alteredPayload.message); (alteredRaw as unknown as { payloadDigest: string }).payloadDigest = sha256(alteredPayload.value); const alteredEnvelope = canonicalJsonBytes(alteredRaw); if (!alteredEnvelope.ok) throw new Error(alteredEnvelope.message); const alteredPath = stage(`${operationId}-altered-survivor.stage`, alteredEnvelope.value); const alteredReplacement = { ...replacement, stagedPath: alteredPath, stagedDigest: sha256(alteredEnvelope.value), producerEvidence: { ...(replacement.producerEvidence as object), successorEnvelopeBase64: Buffer.from(alteredEnvelope.value).toString("base64") } }; expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [settingsPrefix, deletion, alteredReplacement, retirement.value, generation] })).toMatchObject({ ok: false, code: "invalid-producer-data" });
      const duplicateMember = { ...predecessor.members[0]!, scope: "local" as const }; const duplicateEvidence = { ...issued.value, predecessorGeneration: { ...predecessor, members: [...predecessor.members, duplicateMember] } }; const duplicateRetirement = await createOwnedDataRetirementParticipant({ store, operationId, participantIndex: 3, key: "data", qualifiedIdentity: "owned@official", producerEvidence: duplicateEvidence }); if (!duplicateRetirement.ok) throw new Error(duplicateRetirement.message); expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [settingsPrefix, deletion, replacement, duplicateRetirement.value, generation] })).toMatchObject({ ok: false, code: "invalid-producer-data" });
      const mismatchedPredecessorEvidence = { ...issued.value, predecessorGeneration: { ...predecessor, generationId: `admission-${operationId}-mismatched-predecessor` } }; const mismatchedPredecessorRetirement = await createOwnedDataRetirementParticipant({ store, operationId, participantIndex: 3, key: "data", qualifiedIdentity: "owned@official", producerEvidence: mismatchedPredecessorEvidence }); if (!mismatchedPredecessorRetirement.ok) throw new Error(mismatchedPredecessorRetirement.message); expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [settingsPrefix, deletion, replacement, mismatchedPredecessorRetirement.value, generation] })).toMatchObject({ ok: false, code: "invalid-producer-data" });
      const sameGenerationEvidence = { ...issued.value, successorGeneration: { ...successor, generationId: predecessor.generationId } }; const sameGenerationRetirement = await createOwnedDataRetirementParticipant({ store, operationId, participantIndex: 3, key: "data", qualifiedIdentity: "owned@official", producerEvidence: sameGenerationEvidence }); if (!sameGenerationRetirement.ok) throw new Error(sameGenerationRetirement.message); expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [settingsPrefix, deletion, replacement, sameGenerationRetirement.value, generation] })).toMatchObject({ ok: false, code: "invalid-producer-data" });
      const extraEnvelopePath = path.join(path.dirname(survivorOwned.installationRecordPath), "extra-authentic.json"); const extraEnvelopeWrite: OrdinaryTransactionParticipant = { ...replacement, kind: "plugin-installation-envelope-write", key: "extra-installation-write", targetPath: extraEnvelopePath, precondition: { state: "absent" }, rollback: { kind: "delete-new-target" } }; const beforeExtra = fs.readFileSync(survivorOwned.installationRecordPath); expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [extraEnvelopeWrite, deletion, replacement, retirement.value, generation] })).toMatchObject({ ok: false, code: "invalid-producer-data" }); expect(fs.existsSync(extraEnvelopePath)).toBe(false); expect(fs.readFileSync(survivorOwned.installationRecordPath)).toEqual(beforeExtra); expect(load(repo, userDir).ownedProfileReference?.installations.map((item) => item.record.pluginId).sort()).toEqual(["owned@official", "survivor@official"]);
      const authorizationCallsBeforeInsideTarget = retirementAuthorizationCalls; expect(await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants: [insideSettingsPrefix, deletion, replacement, retirement.value, generation] })).toMatchObject({ ok: false, code: "invalid-producer-data" }); expect(retirementAuthorizationCalls).toBeGreaterThan(authorizationCallsBeforeInsideTarget);
      const prepared = await prepareTransaction({ store, codec: makeCodec(), operationId, confirmationSummary: { operationId }, participants }); if (!prepared.ok) throw new Error(`${prepared.code}: ${prepared.message}`);
      if (capturedContext === undefined) throw new Error("production context not captured"); expect(await productionAuthorizer({ ...capturedContext })).toMatchObject({ ok: false });
      const wrongIdentityAuthorizer = createOwnedDataRetirementAuthorizer({ store, qualifiedIdentity: "survivor@official" }); expect(await wrongIdentityAuthorizer(capturedContext)).toMatchObject({ ok: false });
      const foreignLocations = createLifecycleLocations({ homeDir: path.dirname(userDir), profilePath: path.join(path.dirname(userDir), ".claude-foreign"), platform: process.platform === "win32" ? "win32" : "posix" }); if (!foreignLocations.ok) throw new Error("foreign locations"); const foreignStore = await establishOwnedStateStore(foreignLocations.value, path.dirname(userDir)); if (!foreignStore.ok) throw new Error(foreignStore.message); expect(await createOwnedDataRetirementAuthorizer({ store: foreignStore.value, qualifiedIdentity: "owned@official" })(capturedContext)).toMatchObject({ ok: false });
      const lease = await acquireLifecycleLocks({ store, operationId, identities: prepared.value.requiredLocks }); if (!lease.ok) throw new Error(lease.message);
      const registry = () => { const value = createTransactionCodecRegistry([makeCodec()]); if (!value.ok) throw new Error(value.message); return value.value; };
      const recover = async (action: "complete" | "rollback") => { const preview = await previewRecovery({ store, operationId, registry: registry() }); if (!preview.ok) throw new Error(preview.message); return recoverTransaction({ store, operationId, action, confirmedProducerSchema: preview.value.producerSchema, confirmedProducerVersion: preview.value.producerVersion, confirmedPlanDigest: preview.value.planDigest, confirmedConfirmationDigest: preview.value.confirmationDigest, registry: registry(), lease: lease.value }); };
      return { store, owned, survivorOwned, repo, userDir, prepared: prepared.value, lease: lease.value, registry, recover, retirement: retirement.value, predecessor, successor };
    };
    const normal = await setup("normal"); expect(await executeTransaction(normal.store, normal.prepared, { lease: normal.lease })).toMatchObject({ state: "committed", receipt: { completed: 5, outcome: "committed" } });
    expect(JSON.parse(fs.readFileSync(normal.owned.generationPath, "utf8"))).toEqual(normal.successor); expect(fs.existsSync(normal.owned.installationRecordPath)).toBe(false);
    for (const file of fs.readdirSync(normal.store.stagingRoot)) fs.rmSync(path.join(normal.store.stagingRoot, file), { recursive: true, force: true });
    expect(load(normal.repo, normal.userDir).ownedProfileReference?.installations.map((item) => item.record.pluginId)).toEqual(["survivor@official"]);
    const recoveryCases = [[0, "after-replacement", "complete"], [0, "after-replacement", "rollback"], [1, "after-forward-deletion", "complete"], [1, "after-forward-deletion", "rollback"], [2, "after-replacement", "complete"], [2, "after-replacement", "rollback"], [3, "after-data-retirement-rename", "complete"], [3, "after-data-retirement-rename", "rollback"], [4, "after-replacement", "rollback"]] as const;
    for (const [faultIndex, selectedPhase, action] of recoveryCases) {
      const selected = await setup(`${faultIndex}-${action}`); let fired = false; const outcome = await executeTransaction(selected.store, selected.prepared, { lease: selected.lease, faults: { hit(phase, index) { if (!fired && index === faultIndex && phase === selectedPhase) { fired = true; throw new Error("fault"); } } } });
      expect(outcome).toMatchObject({ state: "pending-recovery", completed: faultIndex + 1 }); const recovered = await selected.recover(action); expect(recovered).toMatchObject({ ok: true, value: { outcome: action === "complete" ? "committed" : "rolled-back" } });
      expect(JSON.parse(fs.readFileSync(selected.owned.generationPath, "utf8"))).toEqual(action === "complete" ? selected.successor : selected.predecessor); expect(fs.existsSync(selected.owned.installationRecordPath)).toBe(action === "rollback");
      for (const file of fs.readdirSync(selected.store.stagingRoot)) fs.rmSync(path.join(selected.store.stagingRoot, file), { recursive: true, force: true });
      const fresh = load(selected.repo, selected.userDir); expect(fresh.ownedProfileReference?.installations.map((item) => item.record.pluginId).sort()).toEqual(action === "complete" ? ["survivor@official"] : ["owned@official", "survivor@official"]);
      expect(await previewRecovery({ store: selected.store, operationId: selected.prepared.operationId, registry: selected.registry() })).toMatchObject({ ok: true, value: { terminalOutcome: action === "complete" ? "committed" : "rolled-back" } });
      await releaseLifecycleLocks(selected.lease);
    }
    const ambiguous = await setup("ambiguous-selected-path"); let interrupted = false; expect(await executeTransaction(ambiguous.store, ambiguous.prepared, { lease: ambiguous.lease, faults: { hit(phase, index) { if (!interrupted && phase === "after-forward-deletion" && index === 1) { interrupted = true; throw new Error("after-delete"); } } } })).toMatchObject({ state: "pending-recovery", completed: 2 });
    fs.writeFileSync(ambiguous.owned.installationRecordPath, "recreated-foreign-bytes"); const completion = await recoverTransaction({ store: ambiguous.store, operationId: ambiguous.prepared.operationId, action: "complete", confirmedProducerSchema: ambiguous.prepared.producerSchema, confirmedProducerVersion: ambiguous.prepared.producerVersion, confirmedPlanDigest: ambiguous.prepared.planDigest, confirmedConfirmationDigest: ambiguous.prepared.confirmationDigest, registry: ambiguous.registry(), lease: ambiguous.lease }); expect(completion).toMatchObject({ ok: false }); expect(fs.readFileSync(path.join(ambiguous.store.dataRoot, `plugin-${createHash("sha256").update("owned@official").digest("base64url")}`, "state"), "utf8")).toBe("persistent"); expect(JSON.parse(fs.readFileSync(ambiguous.owned.generationPath, "utf8"))).toEqual(ambiguous.predecessor); expect(await previewRecovery({ store: ambiguous.store, operationId: ambiguous.prepared.operationId, registry: ambiguous.registry() })).toMatchObject({ ok: false }); expect(fs.existsSync(path.join(ambiguous.store.receiptsRoot, `${ambiguous.prepared.operationId}.json`))).toBe(false); await releaseLifecycleLocks(ambiguous.lease);
    expect(await previewRecovery({ store: normal.store, operationId: normal.prepared.operationId, registry: normal.registry() })).toMatchObject({ ok: true, value: { terminalOutcome: "committed" } }); await releaseLifecycleLocks(normal.lease);

    const multi = makeBase(); const multiOwned = installOwnedPlugin(multi.base, multi.repo, multi.userDir); const firstMulti = load(multi.repo, multi.userDir); const projectInstallation = firstMulti.lifecycleObservation.records.find((item) => item.producer?.schema === "plugin-installation"); if (projectInstallation?.producer === undefined) throw new Error("project installation");
    const multiProfileKey = (projectInstallation.producer.payload as OwnedPluginInstallationRecord).profileKey; const multiProfileRoot = path.dirname(path.dirname(path.dirname(path.dirname(projectInstallation.path)))); const multiStoreShape = { root: multiProfileRoot, profileRoot: multiProfileRoot, profileKey: multiProfileKey, recordsRoot: path.join(multiProfileRoot, "records"), artifactsRoot: path.join(multiProfileRoot, "artifacts", "sha256"), stagingRoot: path.join(multiProfileRoot, "staging"), generationsRoot: path.join(multiProfileRoot, "generations"), journalsRoot: path.join(multiProfileRoot, "journals"), receiptsRoot: path.join(multiProfileRoot, "receipts"), locksRoot: path.join(multiProfileRoot, "locks"), quarantineRoot: path.join(multiProfileRoot, "quarantine"), dataRoot: path.join(multiProfileRoot, "data") } satisfies OwnedStateStore;
    const multiSnapshots = firstMulti.lifecycleObservation.records.filter((item) => item.status === "admitted" && item.producer?.schema === "marketplace-catalog-snapshot").map((item) => item.producer!.payload as OwnedMarketplaceSnapshotRecord); const multiSnapshotMap: Record<string, OwnedMarketplaceSnapshotRecord[]> = {}; for (const snapshot of multiSnapshots) (multiSnapshotMap[snapshot.snapshotId] ??= []).push(snapshot); const multiCodec = createOwnedPluginInstallationCodec({ profileKey: multiProfileKey, artifactsRoot: multiStoreShape.artifactsRoot, marketplaceSnapshots: multiSnapshotMap });
    const localInstallation = { ...(projectInstallation.producer.payload as OwnedPluginInstallationRecord), scope: "local" as const }; const localScopeKey = `local-${localInstallation.projectKey}`; const localEnvelope = createRecordEnvelope(multiCodec, "picc-owned", localScopeKey, localInstallation); if (!localEnvelope.ok) throw new Error(localEnvelope.message); const localPartition = ownedRecordPartition(multiStoreShape, "picc-owned", localScopeKey); if (!localPartition.ok) throw new Error(localPartition.message); const localRecordPath = path.join(localPartition.value, "owned-local.json"); write(localRecordPath, localEnvelope.value.bytes);
    const originalGeneration = JSON.parse(fs.readFileSync(multiOwned.generationPath, "utf8")) as ExecutableAdmissionGeneration; const localMember = { ...originalGeneration.members[0]!, scope: "local" as const, recordDigest: localEnvelope.value.envelope.payloadDigest }; const completeMultiGeneration = { ...originalGeneration, members: [...originalGeneration.members, localMember] }; const completeMultiBytes = canonicalJsonBytes(completeMultiGeneration); if (!completeMultiBytes.ok) throw new Error(completeMultiBytes.message); fs.writeFileSync(multiOwned.generationPath, completeMultiBytes.value);
    const loadedMulti = load(multi.repo, multi.userDir); if (loadedMulti.ownedProfileReference === undefined) throw new Error("complete multi-scope predecessor"); expect(loadedMulti.ownedProfileReference.installations.filter((item) => item.record.pluginId === "owned@official")).toHaveLength(2); if (process.platform !== "win32") { const chmodDirectories = (root: string): void => { fs.chmodSync(root, 0o700); for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) chmodDirectories(path.join(root, entry.name)); }; chmodDirectories(path.join(path.dirname(multi.userDir), ".picc")); }
    const multiLocations = createLifecycleLocations({ homeDir: path.dirname(multi.userDir), profilePath: multi.userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: multi.repo, checkoutFamilyPath: multi.repo } }); if (!multiLocations.ok) throw new Error("multi locations"); const establishedMulti = await establishOwnedStateStore(multiLocations.value, path.dirname(multi.userDir)); if (!establishedMulti.ok) throw new Error(establishedMulti.message); const selectedMulti = loadedMulti.ownedProfileReference.installations[0]!; const multiSuccessor = { ...completeMultiGeneration, generationId: "admission-multi-successor", members: [localMember] }; const multiDataPath = path.join(establishedMulti.value.dataRoot, `plugin-${createHash("sha256").update("owned@official").digest("base64url")}`); fs.mkdirSync(multiDataPath); fs.writeFileSync(path.join(multiDataPath, "state"), "shared");
    expect(issueOwnedDataRetirementProducerEvidence({ store: establishedMulti.value, predecessor: loadedMulti.ownedProfileReference, selectedInstallation: selectedMulti, successorGeneration: multiSuccessor })).toMatchObject({ ok: false, code: "retirement-authority" }); expect(fs.readFileSync(path.join(multiDataPath, "state"), "utf8")).toBe("shared"); expect(fs.existsSync(localRecordPath)).toBe(true);
  }, 60_000);

  it.each([
    ["missing member record", (owned: ReturnType<typeof installOwnedPlugin>) => fs.rmSync(owned.installationRecordPath), "membership-invalid"],
    ["partial generation marker", (owned: ReturnType<typeof installOwnedPlugin>) => { const marker = JSON.parse(fs.readFileSync(owned.generationPath, "utf8")) as Record<string, unknown>; const encoded = canonicalJsonBytes({ ...marker, members: [] }); if (!encoded.ok) throw new Error("marker"); fs.writeFileSync(owned.generationPath, encoded.value); }, "membership-invalid"],
    ["absent generation marker", (owned: ReturnType<typeof installOwnedPlugin>) => fs.rmSync(owned.generationPath), "absent"],
    ["malformed generation marker", (owned: ReturnType<typeof installOwnedPlugin>) => fs.writeFileSync(owned.generationPath, "{not-json"), "malformed"],
    ["noncanonical generation marker", (owned: ReturnType<typeof installOwnedPlugin>) => fs.appendFileSync(owned.generationPath, "\n"), "noncanonical"],
    ["unreadable generation marker", (owned: ReturnType<typeof installOwnedPlugin>) => { fs.rmSync(owned.generationPath); fs.mkdirSync(owned.generationPath); }, "unreadable"],
    ["invalid generation parent root", (owned: ReturnType<typeof installOwnedPlugin>) => { fs.rmSync(path.dirname(owned.generationPath), { recursive: true }); fs.writeFileSync(path.dirname(owned.generationPath), "not-a-directory"); }, "unreadable"],
    ["extra generation record", (owned: ReturnType<typeof installOwnedPlugin>) => fs.copyFileSync(owned.installationRecordPath, path.join(path.dirname(owned.installationRecordPath), "extra.json")), "membership-invalid"],
  ] as const)("keeps the entire owned generation inert for %s", (_label, mutate, expectedObservation) => {
    const { base, repo, userDir } = makeBase();
    const owned = installOwnedPlugin(base, repo, userDir);
    mutate(owned);
    const project = load(repo, userDir);
    expect(project.pluginAdmissions.filter((item) => item.ownership === "picc-owned")).toEqual([]);
    expect(project.plugins.some((plugin) => plugin.ownership === "picc-owned")).toBe(false);
    expect(project.pluginContexts.has("owned@official")).toBe(false);
    expect(project.executableGenerationObservation.status).toBe(expectedObservation);
  });

  it.each([
    ["marketplace default", { manifest: true, marketplace: false }, undefined, false],
    ["manifest default", { manifest: false }, undefined, false],
    ["implicit default", {}, undefined, true],
    ["explicit enabled setting", { manifest: false, marketplace: false }, true, true],
    ["explicit disabled setting", { manifest: true }, false, false],
  ] as const)("applies %s enablement precedence on fresh assembly", (_label, defaults, explicit, expectedLoaded) => {
    const { base, repo, userDir } = makeBase();
    installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), defaults);
    if (explicit !== undefined) write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "owned@official": explicit } }));
    const project = load(repo, userDir);
    expect(project.plugins.some((plugin) => plugin.pluginId === "owned@official")).toBe(expectedLoaded);
  });

  it("does not let a higher-scope record independently change retained marketplace default authority", () => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { manifest: false }); const first = load(repo, userDir);
    const installationObservation = first.lifecycleObservation.records.find((item) => item.producer?.schema === "plugin-installation"); const snapshotObservation = first.lifecycleObservation.records.find((item) => item.producer?.schema === "marketplace-catalog-snapshot");
    if (installationObservation?.producer === undefined || snapshotObservation?.producer === undefined) throw new Error("owned observations");
    const installation = installationObservation.producer.payload as Record<string, unknown>; const snapshot = snapshotObservation.producer.payload as Record<string, unknown>; const profileKey = installation.profileKey as import("../src/plugin-lifecycle/types.js").LifecycleProfileKey;
    const installationCodec = createOwnedPluginInstallationCodec({ profileKey, artifactsRoot: path.dirname(path.dirname(owned.root)), marketplaceSnapshots: { [String(snapshot.snapshotId)]: [snapshot as never] } });
    const higher = { ...installation, scope: "local" }; const higherEnvelope = createRecordEnvelope(installationCodec, "picc-owned", `local-${String(installation.checkoutFamilyKey)}`, higher as never); if (!higherEnvelope.ok) throw new Error(higherEnvelope.message);
    const recordsRoot = path.dirname(path.dirname(path.dirname(installationObservation.path))); const profileRoot = path.dirname(recordsRoot); const store = { root: profileRoot, profileRoot, profileKey, recordsRoot, artifactsRoot: "", stagingRoot: "", generationsRoot: "", journalsRoot: "", receiptsRoot: "", locksRoot: "", quarantineRoot: "", dataRoot: path.join(profileRoot, "data") } satisfies OwnedStateStore; const partition = ownedRecordPartition(store, "picc-owned", `local-${String(installation.checkoutFamilyKey)}`); if (!partition.ok) throw new Error(partition.message); write(path.join(partition.value, "higher.json"), Buffer.from(higherEnvelope.value.bytes).toString("utf8"));
    const marker = JSON.parse(fs.readFileSync(owned.generationPath, "utf8")) as Record<string, unknown>; const bytes = canonicalJsonBytes({ ...marker, members: [owned.member, { ...owned.member, scope: "local", recordDigest: higherEnvelope.value.envelope.payloadDigest }] }); if (!bytes.ok) throw new Error(bytes.message); fs.writeFileSync(owned.generationPath, bytes.value);
    expect(load(repo, userDir).plugins.map((plugin) => plugin.pluginId)).toEqual([]);
  });

  it("projects a disabled dependency as the enabled dependent's activation blocker", () => {
    const { base, repo, userDir } = makeBase(); const required = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { name: "required" }); const dependent = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { name: "dependent", dependencies: ["required"] });
    const marker = JSON.parse(fs.readFileSync(dependent.generationPath, "utf8")) as Record<string, unknown>; const bytes = canonicalJsonBytes({ ...marker, members: [required.member, dependent.member] }); if (!bytes.ok) throw new Error(bytes.message); fs.writeFileSync(dependent.generationPath, bytes.value);
    write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "required@official": false, "dependent@official": true } }));
    const project = load(repo, userDir);
    expect(project.pluginResolutionOutcomes.find((value) => value.pluginId === "required@official")).toMatchObject({ status: "disabled" });
    expect(project.pluginInventory.find("required@official")?.lifecycle?.dependency).toMatchObject({ state: "not-evaluated" });
    expect(project.pluginInventory.find("dependent@official")?.lifecycle?.dependency).toMatchObject({ state: "blocked", reason: "Dependency assembly decision: disabled" });
  });

  it.each([
    ["missing", undefined, "*"],
    ["disabled", false, "*"],
    ["incompatible", true, "^2.0.0"],
  ] as const)("keeps a plugin inert when its dependency exists only in retained catalog authority and is %s", (_label, requiredEnabled, version) => {
    const { base, repo, userDir } = makeBase(); let required: ReturnType<typeof installOwnedPlugin> | undefined; if (requiredEnabled !== undefined) required = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { name: "required" }); const dependent = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { name: "dependent", catalogDependencies: [{ name: "required", version }] }); if (required !== undefined) { const marker = JSON.parse(fs.readFileSync(dependent.generationPath, "utf8")) as Record<string, unknown>; const bytes = canonicalJsonBytes({ ...marker, members: [required.member, dependent.member] }); if (!bytes.ok) throw new Error(bytes.message); fs.writeFileSync(dependent.generationPath, bytes.value); } write(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "dependent@official": true, ...(requiredEnabled === undefined ? {} : { "required@official": requiredEnabled }) } })); const project = load(repo, userDir); expect(project.plugins.some((plugin) => plugin.pluginId === "dependent@official")).toBe(false); expect(project.pluginResolutionOutcomes.find((item) => item.pluginId === "dependent@official")).toMatchObject({ status: "rejected" });
  });

  it.each([
    ["missing", ["missing"]],
    ["invalid", ["bad name"]],
  ])("removes a dependency-%s owned plugin from outcomes and runtime authority", (_label, dependencies) => {
    const { base, repo, userDir } = makeBase();
    installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { manifest: true, dependencies });
    const project = load(repo, userDir);
    expect(project.plugins).toEqual([]);
    expect(project.pluginContexts.has("owned@official")).toBe(false);
    expect(project.pluginResolutionOutcomes.filter((outcome) => outcome.pluginId === "owned@official")).toEqual([expect.objectContaining({ status: "rejected" })]);
  });

  it("uses the canonical checkout family while authorizing the active linked worktree", () => {
    const base = makeTmp(); const main = path.join(base, "main"); const worktree = path.join(base, "linked"); const userDir = path.join(base, "home", ".claude");
    fs.mkdirSync(main, { recursive: true }); fs.mkdirSync(userDir, { recursive: true });
    for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) expect(spawnSync("git", args, { cwd: main }).status).toBe(0);
    write(path.join(main, "seed.txt"), "seed"); expect(spawnSync("git", ["add", "."], { cwd: main }).status).toBe(0); expect(spawnSync("git", ["commit", "-m", "seed"], { cwd: main }).status).toBe(0);
    expect(spawnSync("git", ["worktree", "add", "-b", "linked", worktree], { cwd: main }).status).toBe(0);
    installOwnedPlugin(base, worktree, userDir, fs.realpathSync.native(main));
    const project = load(worktree, userDir);
    expect(project.plugins.map((plugin) => plugin.pluginId)).toContain("owned@official");
    expect(project.pluginAdmissions).toEqual(expect.arrayContaining([expect.objectContaining({ ownership: "picc-owned", projectPath: fs.realpathSync.native(worktree) })]));
  });

  it("writes and assembles settings from the active linked worktree rather than its main checkout", async () => {
    const base = makeTmp(); const main = path.join(base, "main"); const worktree = path.join(base, "linked"); const homeDir = path.join(base, "home"); const userDir = path.join(homeDir, ".claude");
    fs.mkdirSync(main, { recursive: true }); fs.mkdirSync(userDir, { recursive: true });
    for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) expect(spawnSync("git", args, { cwd: main }).status).toBe(0);
    write(path.join(main, "seed.txt"), "seed"); expect(spawnSync("git", ["add", "."], { cwd: main }).status).toBe(0); expect(spawnSync("git", ["commit", "-m", "seed"], { cwd: main }).status).toBe(0);
    expect(spawnSync("git", ["worktree", "add", "-b", "settings-linked", worktree], { cwd: main }).status).toBe(0); fs.mkdirSync(path.join(worktree, ".claude")); fs.mkdirSync(path.join(main, ".claude")); fs.mkdirSync(path.join(worktree, "nested"));
    const active = fs.realpathSync.native(worktree); const family = fs.realpathSync.native(main); const locations = createLifecycleLocations({ homeDir, profilePath: userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: active, checkoutFamilyPath: family } }); if (!locations.ok) throw new Error("locations");
    const plan = await planPluginSettingsWrite({ homeDir, profilePath: userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: active, checkoutFamilyPath: family }, projectRoot: active, cwd: path.join(active, "nested"), managedPaths: [], scope: "project", mutation: { kind: "enabled-plugin", key: "linked@official", value: false } }); if (!plan.ok) throw new Error(plan.message);
    expect(process.platform === "win32" ? plan.value.targetPath.toLowerCase() : plan.value.targetPath).toBe(process.platform === "win32" ? path.join(active, ".claude", "settings.json").toLowerCase() : path.join(active, ".claude", "settings.json")); const store = await establishOwnedStateStore(locations.value, homeDir); if (!store.ok) throw new Error(store.message);
    const prepared = await preparePluginSettingsWrite({ store: store.value, operationId: "linked_settings", profilePath: userDir, plan: plan.value }); if (!prepared.ok) throw new Error(prepared.message);
    const lease = await acquireLifecycleLocks({ store: store.value, operationId: "linked_settings", identities: prepared.value.transaction.requiredLocks }); if (!lease.ok) throw new Error(lease.message);
    try { expect((await executeTransaction(store.value, prepared.value.transaction, { lease: lease.value })).state).toBe("committed"); } finally { await releaseLifecycleLocks(lease.value); }
    expect(fs.existsSync(path.join(main, ".claude", "settings.json"))).toBe(false);
    const assembled = load(active, userDir).settings.effectivePluginEnablement?.["linked@official"]; expect(assembled).toMatchObject({ enabled: false, scope: "project" });
    expect(process.platform === "win32" ? assembled?.source.toLowerCase() : assembled?.source).toBe(process.platform === "win32" ? plan.value.targetPath.toLowerCase() : plan.value.targetPath);
    fs.writeFileSync(path.join(worktree, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "shared@official": false, "legacy@official": true } }));
    fs.writeFileSync(path.join(worktree, "nested", ".claude-settings-canary"), "untouched");
    fs.writeFileSync(path.join(main, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "shared@official": true } }));
    const legacyBytes = fs.readFileSync(path.join(worktree, ".claude", "settings.local.json"));
    const localPlan = await planPluginSettingsWrite({ homeDir, profilePath: userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: active, checkoutFamilyPath: family }, projectRoot: active, cwd: path.join(active, "nested"), managedPaths: [], scope: "local", mutation: { kind: "enabled-plugin", key: "main-write@official", value: true } }); if (!localPlan.ok) throw new Error(localPlan.message);
    expect(process.platform === "win32" ? localPlan.value.targetPath.toLowerCase() : localPlan.value.targetPath).toBe(process.platform === "win32" ? path.join(main, ".claude", "settings.local.json").toLowerCase() : path.join(main, ".claude", "settings.local.json"));
    const localPrepared = await preparePluginSettingsWrite({ store: store.value, operationId: "linked_local_settings", profilePath: userDir, plan: localPlan.value }); if (!localPrepared.ok) throw new Error(localPrepared.message); const localLease = await acquireLifecycleLocks({ store: store.value, operationId: "linked_local_settings", identities: localPrepared.value.transaction.requiredLocks }); if (!localLease.ok) throw new Error(localLease.message);
    try { expect((await executeTransaction(store.value, localPrepared.value.transaction, { lease: localLease.value })).state).toBe("committed"); } finally { await releaseLifecycleLocks(localLease.value); }
    expect(fs.readFileSync(path.join(worktree, ".claude", "settings.local.json"))).toEqual(legacyBytes); expect(fs.readFileSync(path.join(main, ".claude", "settings.local.json"), "utf8")).toContain('"main-write@official": true');
    const linkedSettings = loadSettings({ cwd: path.join(active, "nested"), projectRoot: active, userDir, managedPaths: [] });
    expect(linkedSettings.effectivePluginEnablement?.["shared@official"]).toMatchObject({ enabled: true, scope: "local", source: path.join(main, ".claude", "settings.local.json") });
    expect(linkedSettings.effectivePluginEnablement?.["legacy@official"]).toMatchObject({ enabled: true, scope: "local", source: path.join(worktree, ".claude", "settings.local.json") });
    expect(linkedSettings.effectivePluginEnablement?.["main-write@official"]).toMatchObject({ enabled: true, scope: "local", source: path.join(main, ".claude", "settings.local.json") });
    expect(load(active, userDir).settings.effectivePluginEnablement?.["main-write@official"]).toMatchObject({ enabled: true, scope: "local" });
    expect(fs.readFileSync(path.join(worktree, "nested", ".claude-settings-canary"), "utf8")).toBe("untouched");
  });

  it("stores lifecycle state under the configured home independently of a custom Claude profile", () => {
    const { base, repo } = makeBase(); const userDir = path.join(base, "profiles", "custom-claude"); const homeDir = path.join(base, "actual-home"); fs.mkdirSync(userDir, { recursive: true });
    installOwnedPlugin(base, repo, userDir, repo, homeDir);
    const project = loadClaudeProject({ cwd: repo, userDir, homeDir, managedSettingsPaths: [], managedArtifactDirs: [] });
    expect(project.plugins.map((plugin) => plugin.pluginId)).toContain("owned@official");
    const lifecycleRoot = fs.realpathSync.native(path.join(homeDir, ".picc"));
    expect(project.lifecycleObservation.records.every((record) => { const relative = path.relative(lifecycleRoot, record.path); return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); })).toBe(true);
  });

  it("keeps executable membership unchanged when registration selection lacks retained snapshot authority", () => {
    const { base, repo, userDir } = makeBase(); installOwnedPlugin(base, repo, userDir);
    const first = load(repo, userDir);
    const marketplaceRecord = first.lifecycleObservation.records.find((item) => item.producer?.schema === "marketplace-registration");
    if (marketplaceRecord?.producer === undefined) throw new Error("marketplace record");
    const payload = marketplaceRecord.producer.payload as Record<string, unknown>;
    const refreshed = { ...payload, selectedSnapshotId: "marketplace-refreshed" }; const scopeKey = ownedMarketplaceScopeKey(refreshed as never);
    const encoded = createRecordEnvelope(createOwnedMarketplaceCodec(payload["profileKey"] as import("../src/plugin-lifecycle/types.js").LifecycleProfileKey), "picc-owned", scopeKey, refreshed as never); if (!encoded.ok) throw new Error("refresh");
    const recordsRoot = path.dirname(path.dirname(path.dirname(marketplaceRecord.path))); const profileRoot = path.dirname(recordsRoot); const store = { root: profileRoot, profileRoot, profileKey: payload["profileKey"] as string, recordsRoot, artifactsRoot: "", stagingRoot: "", generationsRoot: "", journalsRoot: "", receiptsRoot: "", locksRoot: "", quarantineRoot: "", dataRoot: path.join(profileRoot, "data") } satisfies OwnedStateStore; const partition = ownedRecordPartition(store, "picc-owned", scopeKey); if (!partition.ok) throw new Error(partition.message); fs.rmSync(marketplaceRecord.path); write(path.join(partition.value, "refreshed.json"), Buffer.from(encoded.value.bytes).toString("utf8"));
    const second = load(repo, userDir);
    expect(second.plugins.map((plugin) => [plugin.pluginId, plugin.version])).toEqual(first.plugins.map((plugin) => [plugin.pluginId, plugin.version]));
    expect(second.pluginAdmissions.filter((item) => item.ownership === "picc-owned").map((item) => item.executableGenerationId)).toEqual(["admission-current"]);
  });

  it("retains immutable snapshot and executable authority after mutable marketplace removal", () => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir); fs.rmSync(owned.marketplaceRecordPath);
    const project = load(repo, userDir); expect(project.ownedMarketplaces).toEqual([]); expect(project.plugins.map((plugin) => plugin.pluginId)).toContain("owned@official");
    expect(project.lifecycleObservation.records).toEqual(expect.arrayContaining([expect.objectContaining({ path: owned.snapshotRecordPath, status: "admitted" })]));
  });

  it("treats a fresh profile with no lifecycle roots as clean absence", () => {
    const { repo, userDir } = makeBase(); const project = load(repo, userDir);
    expect(project.lifecycleObservation).toEqual({ records: [], receipts: [], pending: [] });
    expect(project.executableGenerationObservation).toEqual({ status: "absent" });
  });

  it.each([
    ["generation id", (marker: Record<string, unknown>) => ({ ...marker, generationId: "admission-other" }), "membership-invalid"],
    ["record digest", (marker: Record<string, unknown>) => ({ ...marker, members: [{ ...((marker.members as Record<string, unknown>[])[0]!), recordDigest: `sha256:${"0".repeat(64)}` }] }), "membership-invalid"],
    ["qualified identity", (marker: Record<string, unknown>) => ({ ...marker, members: [{ ...((marker.members as Record<string, unknown>[])[0]!), pluginId: "other@official" }] }), "membership-invalid"],
    ["scope", (marker: Record<string, unknown>) => ({ ...marker, members: [{ ...((marker.members as Record<string, unknown>[])[0]!), scope: "local" }] }), "membership-invalid"],
    ["checkout family", (marker: Record<string, unknown>) => ({ ...marker, members: [{ ...((marker.members as Record<string, unknown>[])[0]!), checkoutFamilyKey: `checkout-${"d".repeat(43)}`, projectKey: `checkout-${"d".repeat(43)}` }] }), "membership-invalid"],
    ["project key", (marker: Record<string, unknown>) => ({ ...marker, members: [{ ...((marker.members as Record<string, unknown>[])[0]!), projectKey: `checkout-${"d".repeat(43)}` }] }), "malformed"],
  ] as const)("keeps generation inert after a %s member mutation and retains structurally valid evidence", (_label, mutation, expected) => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir); const marker = JSON.parse(fs.readFileSync(owned.generationPath, "utf8")) as Record<string, unknown>;
    const bytes = canonicalJsonBytes(mutation(marker)); if (!bytes.ok) throw new Error(bytes.message); fs.writeFileSync(owned.generationPath, bytes.value);
    const project = load(repo, userDir); expect(project.plugins).toEqual([]); expect(project.executableGenerationObservation.status).toBe(expected);
    if (expected === "membership-invalid") expect(project.executableGenerationObservation).toHaveProperty("generation.members.0");
  });

  it("rejects missing and conflicting selected snapshot authority while retaining bounded conflict diagnosis", () => {
    const { base, repo, userDir } = makeBase(); installOwnedPlugin(base, repo, userDir); const first = load(repo, userDir);
    const snapshotRecord = first.lifecycleObservation.records.find((item) => item.producer?.schema === "marketplace-catalog-snapshot"); if (snapshotRecord?.producer === undefined) throw new Error("snapshot");
    const originalBytes = fs.readFileSync(snapshotRecord.path); fs.rmSync(snapshotRecord.path); const missing = load(repo, userDir);
    expect(missing.ownedMarketplaces).toEqual([]); expect(missing.plugins).toEqual([]);
    fs.writeFileSync(snapshotRecord.path, originalBytes); const payload = snapshotRecord.producer.payload as Record<string, unknown>;
    const profileKey = payload.profileKey as import("../src/plugin-lifecycle/types.js").LifecycleProfileKey; const recordsRoot = path.dirname(path.dirname(path.dirname(snapshotRecord.path))); const profileRoot = path.dirname(recordsRoot); const store = { root: profileRoot, profileRoot, profileKey, recordsRoot, artifactsRoot: path.join(profileRoot, "artifacts", "sha256"), stagingRoot: "", generationsRoot: "", journalsRoot: "", receiptsRoot: "", locksRoot: "", quarantineRoot: "", dataRoot: path.join(profileRoot, "data") } satisfies OwnedStateStore;
    const { ownership: _ownership, profileKey: _profileKey, trust: _trust, ...originalTarget } = payload; const originalArtifactRoot = String(originalTarget.artifactRoot); const alternateRoot = `${originalArtifactRoot}${path.sep}child${path.sep}..`; const conflictingTarget = { ...originalTarget, artifactRoot: alternateRoot, installRoot: alternateRoot } as MarketplaceSnapshotTrustTarget; const conflictingTrust = createMarketplaceSnapshotTrustGrant(conflictingTarget); if (!conflictingTrust.ok) throw new Error(conflictingTrust.message); const conflicting = { ownership: "picc-owned", profileKey, ...conflictingTarget, trust: conflictingTrust.value }; const scopeKey = ownedMarketplaceSnapshotScopeKey(conflicting); const codec = createOwnedMarketplaceSnapshotCodec({ profileKey, artifactsRoot: store.artifactsRoot }); const envelope = createRecordEnvelope(codec, "picc-owned", scopeKey, conflicting as never); if (!envelope.ok) throw new Error(envelope.message);
    const partition = ownedRecordPartition(store, "picc-owned", scopeKey); if (!partition.ok) throw new Error(partition.message);
    write(path.join(partition.value, "conflict.json"), Buffer.from(envelope.value.bytes).toString("utf8"));
    const conflict = load(repo, userDir); expect(conflict.ownedMarketplaces).toEqual([]); expect(conflict.plugins).toEqual([]);
    expect(conflict.lifecycleObservation.records.filter((item) => item.code === "snapshot-authority-conflict")).toHaveLength(2);
  });

  it("keeps content-identical same-name snapshot authorities from different sources independent", () => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir); const first = load(repo, userDir);
    const snapshotObservation = first.lifecycleObservation.records.find((item) => item.producer?.schema === "marketplace-catalog-snapshot"); if (snapshotObservation?.producer === undefined) throw new Error("snapshot");
    const original = snapshotObservation.producer.payload as Record<string, unknown>; const profileKey = original.profileKey as import("../src/plugin-lifecycle/types.js").LifecycleProfileKey; const recordsRoot = path.dirname(path.dirname(path.dirname(snapshotObservation.path))); const profileRoot = path.dirname(recordsRoot); const artifactsRoot = path.join(profileRoot, "artifacts", "sha256"); const store = { root: profileRoot, profileRoot, profileKey, recordsRoot, artifactsRoot, stagingRoot: "", generationsRoot: "", journalsRoot: "", receiptsRoot: "", locksRoot: "", quarantineRoot: "", dataRoot: path.join(profileRoot, "data") } satisfies OwnedStateStore;
    const source = { kind: "local-directory", path: path.resolve(base, "independent-catalog") } as const; const { ownership: _ownership, profileKey: _profileKey, trust: _trust, ...targetFields } = original; const target = { ...targetFields, source } as MarketplaceSnapshotTrustTarget; const trust = createMarketplaceSnapshotTrustGrant(target); if (!trust.ok) throw new Error(trust.message); const snapshot = { ownership: "picc-owned", profileKey, ...target, trust: trust.value } as const;
    const snapshotScope = ownedMarketplaceSnapshotScopeKey(snapshot); const snapshotEnvelope = createRecordEnvelope(createOwnedMarketplaceSnapshotCodec({ profileKey, artifactsRoot }), "picc-owned", snapshotScope, snapshot); if (!snapshotEnvelope.ok) throw new Error(snapshotEnvelope.message); const snapshotPartition = ownedRecordPartition(store, "picc-owned", snapshotScope); if (!snapshotPartition.ok) throw new Error(snapshotPartition.message); write(path.join(snapshotPartition.value, "record.json"), snapshotEnvelope.value.bytes);
    const registration = { ownership: "picc-owned", name: "official", profileKey, scope: "user", source, selectedSnapshotId: target.snapshotId } as const; const registrationScope = ownedMarketplaceScopeKey(registration); const registrationEnvelope = createRecordEnvelope(createOwnedMarketplaceCodec(profileKey), "picc-owned", registrationScope, registration); if (!registrationEnvelope.ok) throw new Error(registrationEnvelope.message); const registrationPartition = ownedRecordPartition(store, "picc-owned", registrationScope); if (!registrationPartition.ok) throw new Error(registrationPartition.message); write(path.join(registrationPartition.value, "record.json"), registrationEnvelope.value.bytes);
    const project = load(repo, userDir); expect(project.ownedMarketplaces).toEqual([expect.objectContaining({ scope: "project", source: original.source }), expect.objectContaining({ scope: "user", source })]); expect(project.plugins.map((plugin) => plugin.pluginId)).toEqual(["owned@official"]);
    expect(project.lifecycleObservation.records.filter((item) => item.producer?.schema === "marketplace-catalog-snapshot" && item.status === "admitted")).toHaveLength(2);
  });

  it("admits 128 agreeing same-content authorities and fails their installation bucket closed at 129", () => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir); const first = load(repo, userDir);
    const snapshotObservation = first.lifecycleObservation.records.find((item) => item.producer?.schema === "marketplace-catalog-snapshot"); if (snapshotObservation?.producer === undefined) throw new Error("snapshot");
    const original = snapshotObservation.producer.payload as Record<string, unknown>; const profileKey = original.profileKey as import("../src/plugin-lifecycle/types.js").LifecycleProfileKey; const recordsRoot = path.dirname(path.dirname(path.dirname(snapshotObservation.path))); const profileRoot = path.dirname(recordsRoot); const artifactsRoot = path.join(profileRoot, "artifacts", "sha256"); const store = { root: profileRoot, profileRoot, profileKey, recordsRoot, artifactsRoot, stagingRoot: "", generationsRoot: "", journalsRoot: "", receiptsRoot: "", locksRoot: "", quarantineRoot: "", dataRoot: path.join(profileRoot, "data") } satisfies OwnedStateStore;
    const { ownership: _ownership, profileKey: _profileKey, trust: _trust, ...targetFields } = original;
    const addAuthority = (index: number): void => {
      const source = { kind: "local-directory", path: path.resolve(base, `same-content-authority-${index}`) } as const;
      const target = { ...targetFields, source } as MarketplaceSnapshotTrustTarget; const trust = createMarketplaceSnapshotTrustGrant(target); if (!trust.ok) throw new Error(trust.message); const snapshot = { ownership: "picc-owned", profileKey, ...target, trust: trust.value } as const;
      const scopeKey = ownedMarketplaceSnapshotScopeKey(snapshot); const envelope = createRecordEnvelope(createOwnedMarketplaceSnapshotCodec({ profileKey, artifactsRoot }), "picc-owned", scopeKey, snapshot); if (!envelope.ok) throw new Error(envelope.message); const partition = ownedRecordPartition(store, "picc-owned", scopeKey); if (!partition.ok) throw new Error(partition.message); write(path.join(partition.value, "record.json"), envelope.value.bytes);
    };
    for (let index = 1; index < 128; index++) addAuthority(index);
    const atLimit = load(repo, userDir); expect(atLimit.plugins.map((plugin) => plugin.pluginId)).toEqual(["owned@official"]); expect(atLimit.pluginAdmissions.filter((item) => item.ownership === "picc-owned")).toHaveLength(1);
    addAuthority(128);
    const overflow = load(repo, userDir); expect(overflow.plugins).toEqual([]); expect(overflow.pluginAdmissions.filter((item) => item.ownership === "picc-owned")).toEqual([]); expect(overflow.executableGenerationObservation).toMatchObject({ status: "membership-invalid", code: "generation-incomplete" });
    expect(overflow.lifecycleObservation.records).toContainEqual(expect.objectContaining({ status: "inert", code: "invalid-payload" }));
  });

  it("diagnoses valid envelopes placed under other valid authority partitions without suppressing controls", () => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir); const first = load(repo, userDir);
    const registration = first.lifecycleObservation.records.find((item) => item.producer?.schema === "marketplace-registration"); const snapshot = first.lifecycleObservation.records.find((item) => item.producer?.schema === "marketplace-catalog-snapshot"); if (registration?.producer === undefined || snapshot?.producer === undefined) throw new Error("records");
    const profileKey = (registration.producer.payload as Record<string, unknown>).profileKey as import("../src/plugin-lifecycle/types.js").LifecycleProfileKey; const recordsRoot = path.dirname(path.dirname(path.dirname(registration.path))); const profileRoot = path.dirname(recordsRoot); const store = { root: profileRoot, profileRoot, profileKey, recordsRoot, artifactsRoot: path.join(profileRoot, "artifacts", "sha256"), stagingRoot: "", generationsRoot: "", journalsRoot: "", receiptsRoot: "", locksRoot: "", quarantineRoot: "", dataRoot: path.join(profileRoot, "data") } satisfies OwnedStateStore;
    const registrationPayload = registration.producer.payload as Record<string, unknown>; const userAuthority = { ...registrationPayload, scope: "user" } as Record<string, unknown>; delete userAuthority.checkoutFamilyKey; delete userAuthority.projectKey; const wrongRegistrationPartition = ownedRecordPartition(store, "picc-owned", ownedMarketplaceScopeKey(userAuthority as never)); if (!wrongRegistrationPartition.ok) throw new Error(wrongRegistrationPartition.message); const wrongRegistrationPath = path.join(wrongRegistrationPartition.value, "misplaced.json"); write(wrongRegistrationPath, fs.readFileSync(registration.path));
    const snapshotPayload = snapshot.producer.payload as Record<string, unknown>; const otherSource = { kind: "local-directory", path: path.resolve(base, "other-authority") } as const; const wrongSnapshotKey = ownedMarketplaceSnapshotScopeKey({ ...snapshotPayload, source: otherSource } as never); const wrongSnapshotPartition = ownedRecordPartition(store, "picc-owned", wrongSnapshotKey); if (!wrongSnapshotPartition.ok) throw new Error(wrongSnapshotPartition.message); const wrongSnapshotPath = path.join(wrongSnapshotPartition.value, "misplaced.json"); write(wrongSnapshotPath, fs.readFileSync(snapshot.path));
    const project = load(repo, userDir); expect(project.plugins.map((plugin) => plugin.pluginId)).toEqual(["owned@official"]); expect(project.ownedMarketplaces).toHaveLength(1);
    expect(project.lifecycleObservation.records).toEqual(expect.arrayContaining([expect.objectContaining({ path: wrongRegistrationPath, status: "inert", code: "record-containment" }), expect.objectContaining({ path: wrongSnapshotPath, status: "inert", code: "record-containment" }), expect.objectContaining({ path: owned.marketplaceRecordPath, status: "admitted" }), expect.objectContaining({ path: owned.snapshotRecordPath, status: "admitted" })]));
  });

  it("rejects aliased records/artifacts and bounds an oversized passive generation read", () => {
    const recordFixture = makeBase(); const recordOwned = installOwnedPlugin(recordFixture.base, recordFixture.repo, recordFixture.userDir);
    const recordTarget = `${recordOwned.installationRecordPath}.target`; fs.renameSync(recordOwned.installationRecordPath, recordTarget); fs.linkSync(recordTarget, recordOwned.installationRecordPath);
    expect(load(recordFixture.repo, recordFixture.userDir).plugins).toEqual([]);
    const artifactFixture = makeBase(); const artifactOwned = installOwnedPlugin(artifactFixture.base, artifactFixture.repo, artifactFixture.userDir); const manifest = path.join(artifactOwned.root, ".claude-plugin", "plugin.json"); const manifestTarget = `${manifest}.target`; fs.renameSync(manifest, manifestTarget); fs.linkSync(manifestTarget, manifest);
    expect(load(artifactFixture.repo, artifactFixture.userDir).plugins).toEqual([]);
    const oversizedFixture = makeBase(); const oversized = installOwnedPlugin(oversizedFixture.base, oversizedFixture.repo, oversizedFixture.userDir); fs.truncateSync(oversized.generationPath, 1024 * 1024 + 1);
    expect(load(oversizedFixture.repo, oversizedFixture.userDir).executableGenerationObservation.status).toBe("unreadable");
  });

  it("keeps a generation inert when an unreadable sibling creates uncertainty in its exact installation partition", () => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir);
    const oversizedPath = path.join(path.dirname(owned.installationRecordPath), "oversized.json"); fs.writeFileSync(oversizedPath, ""); fs.truncateSync(oversizedPath, 1024 * 1024 + 1);
    const project = load(repo, userDir);
    expect(project.executableGenerationObservation).toMatchObject({ status: "membership-invalid", generation: { members: [owned.member] } });
    expect(project.pluginAdmissions.filter((item) => item.ownership === "picc-owned")).toEqual([]);
    expect(project.plugins).toEqual([]);
    expect(project.pluginContexts.has("owned@official")).toBe(false);
    expect(project.lifecycleObservation.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining("oversized.json"), status: "inert", code: "unreadable-record" }),
      expect.objectContaining({ path: owned.installationRecordPath, status: "inert", code: "generation-incomplete" }),
    ]));
  });

  it("suppresses only a snapshot partition whose sibling record is unreadable", () => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir);
    const original = JSON.parse(fs.readFileSync(owned.snapshotRecordPath, "utf8")) as { payload: Record<string, unknown> }; const profileKey = original.payload.profileKey as import("../src/plugin-lifecycle/types.js").LifecycleProfileKey; const recordsRoot = path.dirname(path.dirname(path.dirname(owned.snapshotRecordPath))); const profileRoot = path.dirname(recordsRoot); const store = { root: profileRoot, profileRoot, profileKey, recordsRoot, artifactsRoot: path.join(profileRoot, "artifacts", "sha256"), stagingRoot: "", generationsRoot: "", journalsRoot: "", receiptsRoot: "", locksRoot: "", quarantineRoot: "", dataRoot: path.join(profileRoot, "data") } satisfies OwnedStateStore;
    const source = { kind: "https-catalog", url: "https://catalog.example.org/community.json" } as const; const catalogDigest = `sha256:${"7".repeat(64)}` as const; const snapshotId = `marketplace-${createHash("sha256").update(`${catalogDigest}\0${source.url}`).digest("base64url")}` as const; const target: MarketplaceSnapshotTrustTarget = { authorityKind: "catalog-only", marketplaceName: "community", snapshotId, source, catalogDigest, executableCatalog: { marketplaceName: "community", allowedCrossMarketplaceDependencies: [], declarations: [] }, provenance: { adapter: "public-https-catalog", canonicalUrl: source.url } }; const trust = createMarketplaceSnapshotTrustGrant(target); if (!trust.ok) throw new Error(trust.message); const snapshot = { ownership: "picc-owned", profileKey, ...target, trust: trust.value } as const;
    const snapshotScope = ownedMarketplaceSnapshotScopeKey(snapshot); const snapshotEnvelope = createRecordEnvelope(createOwnedMarketplaceSnapshotCodec({ profileKey, artifactsRoot: store.artifactsRoot }), "picc-owned", snapshotScope, snapshot); if (!snapshotEnvelope.ok) throw new Error(snapshotEnvelope.message); const snapshotPartition = ownedRecordPartition(store, "picc-owned", snapshotScope); if (!snapshotPartition.ok) throw new Error(snapshotPartition.message); const survivingSnapshotPath = path.join(snapshotPartition.value, "record.json"); write(survivingSnapshotPath, snapshotEnvelope.value.bytes);
    const registration = { ownership: "picc-owned", name: "community", profileKey, scope: "user", source, selectedSnapshotId: snapshotId } as const; const registrationScope = ownedMarketplaceScopeKey(registration); const registrationEnvelope = createRecordEnvelope(createOwnedMarketplaceCodec(profileKey), "picc-owned", registrationScope, registration); if (!registrationEnvelope.ok) throw new Error(registrationEnvelope.message); const registrationPartition = ownedRecordPartition(store, "picc-owned", registrationScope); if (!registrationPartition.ok) throw new Error(registrationPartition.message); write(path.join(registrationPartition.value, "record.json"), registrationEnvelope.value.bytes);
    const oversizedPath = path.join(path.dirname(owned.snapshotRecordPath), "oversized.json"); fs.writeFileSync(oversizedPath, ""); fs.truncateSync(oversizedPath, 1024 * 1024 + 1);
    const project = load(repo, userDir);
    expect(project.ownedMarketplaces).toEqual([expect.objectContaining({ name: "community", scope: "user" })]);
    expect(project.pluginAdmissions.filter((item) => item.ownership === "picc-owned")).toEqual([]);
    expect(project.plugins).toEqual([]);
    expect(project.pluginContexts.has("owned@official")).toBe(false);
    expect(project.lifecycleObservation.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining("oversized.json"), status: "inert", code: "unreadable-record" }),
      expect.objectContaining({ path: owned.snapshotRecordPath, status: "inert", code: "authority-uncertain" }),
      expect.objectContaining({ path: owned.marketplaceRecordPath, status: "admitted" }),
      expect.objectContaining({ path: survivingSnapshotPath, status: "admitted" }),
    ]));
  });

  it("contains registration uncertainty to one exact scoped marketplace partition", () => {
    const { base, repo, userDir } = makeBase(); const owned = installOwnedPlugin(base, repo, userDir);
    const projectEnvelope = JSON.parse(fs.readFileSync(owned.marketplaceRecordPath, "utf8")) as { payload: Record<string, unknown> }; const profileKey = projectEnvelope.payload.profileKey as import("../src/plugin-lifecycle/types.js").LifecycleProfileKey;
    const userRegistration: Record<string, unknown> = { ...projectEnvelope.payload, scope: "user" }; delete userRegistration.checkoutFamilyKey; delete userRegistration.projectKey;
    const userScopeKey = ownedMarketplaceScopeKey(userRegistration as never); const codec = createOwnedMarketplaceCodec(profileKey); const userEnvelope = createRecordEnvelope(codec, "picc-owned", userScopeKey, userRegistration as never); if (!userEnvelope.ok) throw new Error(userEnvelope.message);
    const recordsRoot = path.dirname(path.dirname(path.dirname(owned.marketplaceRecordPath))); const profileRoot = path.dirname(recordsRoot); const store = { root: profileRoot, profileRoot, profileKey, recordsRoot, artifactsRoot: path.join(profileRoot, "artifacts", "sha256"), stagingRoot: "", generationsRoot: "", journalsRoot: "", receiptsRoot: "", locksRoot: "", quarantineRoot: "", dataRoot: path.join(profileRoot, "data") } satisfies OwnedStateStore;
    const userPartition = ownedRecordPartition(store, "picc-owned", userScopeKey); if (!userPartition.ok) throw new Error(userPartition.message); write(path.join(userPartition.value, "record.json"), Buffer.from(userEnvelope.value.bytes).toString("utf8"));
    const oversizedPath = path.join(path.dirname(owned.marketplaceRecordPath), "oversized.json"); fs.writeFileSync(oversizedPath, ""); fs.truncateSync(oversizedPath, 1024 * 1024 + 1);
    const project = load(repo, userDir); expect(project.ownedMarketplaces).toEqual([expect.objectContaining({ name: "official", scope: "user" })]);
    expect(project.lifecycleObservation.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: owned.marketplaceRecordPath, status: "inert", code: "authority-uncertain" }),
      expect.objectContaining({ path: path.join(userPartition.value, "record.json"), status: "admitted" }),
    ]));
  });

  it("keeps an owned artifact inert when one file exceeds the portable per-file limit", () => {
    const { base, repo, userDir } = makeBase();
    const skillBytes = Buffer.alloc(PORTABLE_TREE_LIMITS.maximumFileBytes + 1, 0x61);
    const owned = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { skillBytes });
    const envelope = JSON.parse(fs.readFileSync(owned.installationRecordPath, "utf8")) as { payload: Record<string, unknown>; payloadDigest: string };
    const trust = envelope.payload.trust as Record<string, unknown>;
    const generation = JSON.parse(fs.readFileSync(owned.generationPath, "utf8")) as { members: Record<string, unknown>[] };
    const skillPath = path.join(owned.root, "skills", "owned-skill", "SKILL.md");
    const manifestPath = path.join(owned.root, ".claude-plugin", "plugin.json");
    expect(fs.statSync(skillPath).size).toBe(PORTABLE_TREE_LIMITS.maximumFileBytes + 1);
    expect(fs.statSync(skillPath).size + fs.statSync(manifestPath).size).toBeLessThan(PORTABLE_TREE_LIMITS.maximumTotalBytes);
    expect(envelope.payload).toMatchObject({ installRoot: owned.root, selectedRoot: { path: "owned" }, artifactDigest: owned.treeDigest, treeDigest: owned.treeDigest, rootDigest: owned.rootDigest, executableDigest: owned.executableDigest });
    expect(trust).toMatchObject({ selectedRoot: envelope.payload.selectedRoot, artifactDigest: owned.treeDigest, treeDigest: owned.treeDigest, rootDigest: owned.rootDigest, executableDigest: owned.executableDigest });
    expect(path.basename(owned.root)).toBe((envelope.payload.selectedRoot as { path: string }).path);
    expect(path.basename(path.dirname(owned.root))).toBe(owned.treeDigest.slice(7));
    expect(envelope.payloadDigest).toBe(owned.member.recordDigest);
    expect(generation.members).toEqual([owned.member]);
    const project = load(repo, userDir);
    expect(project.executableGenerationObservation).toMatchObject({ status: "membership-invalid", generation: { members: [owned.member] } });
    expect(project.pluginAdmissions.filter((item) => item.ownership === "picc-owned")).toEqual([]);
    expect(project.plugins).toEqual([]);
    expect(project.pluginContexts.has("owned@official")).toBe(false);
    expect(project.lifecycleObservation.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: owned.snapshotRecordPath, status: "inert", code: "artifact-mismatch" }),
      expect.objectContaining({ path: owned.installationRecordPath, status: "inert" }),
    ]));
  });

  it("removes an owned dependent after its required owned plugin has a terminal hook read rejection", () => {
    const { base, repo, userDir } = makeBase(); const required = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { name: "required", hooks: true }); const dependent = installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { name: "dependent", dependencies: ["required"] });
    const marker = JSON.parse(fs.readFileSync(dependent.generationPath, "utf8")) as Record<string, unknown>; const bytes = canonicalJsonBytes({ ...marker, members: [required.member, dependent.member] }); if (!bytes.ok) throw new Error(bytes.message); fs.writeFileSync(dependent.generationPath, bytes.value);
    const hookPath = path.join(required.root, "hooks", "hooks.json"); const original = fs.readFileSync; const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((candidate: unknown, ...args: unknown[]) => path.normalize(String(candidate)) === path.normalize(hookPath) ? (() => { throw Object.assign(new Error("deterministic hook rejection"), { code: "EACCES" }); })() : (original as (...values: unknown[]) => unknown)(candidate, ...args)) as typeof fs.readFileSync);
    try { const project = load(repo, userDir); expect(project.plugins).toEqual([]); for (const pluginId of ["required@official", "dependent@official"]) expect(project.pluginResolutionOutcomes.find((item) => item.pluginId === pluginId)).toMatchObject({ status: "rejected" }); expect(project.pluginResolutionOutcomes.find((item) => item.pluginId === "dependent@official")?.diagnostics.map((item) => item.message).join("\n")).toContain("final dependency admission"); expect(project.pluginInventory.find("required@official")?.lifecycle?.dependency).toMatchObject({ state: "indeterminate", reason: expect.stringContaining("indeterminate") }); expect(project.pluginInventory.find("dependent@official")?.lifecycle?.dependency).toMatchObject({ state: "indeterminate", reason: expect.stringContaining("indeterminate") }); }
    finally { spy.mockRestore(); }
  });

  it("rejects an imported manifest mutation between root discovery and authoritative resolution", () => {
    const { repo, userDir } = makeBase();
    const pluginRoot = makeMarketplacePlugin(userDir, "official", "alpha");
    const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
    fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "alpha@official": true } }));
    const originalRead = fs.readFileSync;
    let manifestReads = 0;
    const read = vi.spyOn(fs, "readFileSync").mockImplementation(((candidate: unknown, ...args: unknown[]) => {
      if (path.normalize(String(candidate)) === path.normalize(manifestPath)) {
        manifestReads += 1;
        if (manifestReads === 3) fs.writeFileSync(manifestPath, JSON.stringify({ name: "beta" }));
      }
      return (originalRead as (...values: unknown[]) => unknown)(candidate, ...args);
    }) as typeof fs.readFileSync);
    try {
      const project = load(repo, userDir);
      expect(manifestReads).toBeGreaterThanOrEqual(4);
      expect(project.plugins).toEqual([expect.objectContaining({ pluginId: "alpha@official", name: "beta" })]);
      expect(project.skills.some((skill) => skill.name === "beta:alpha-skill")).toBe(true);
      expect(project.pluginResolutionOutcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ pluginId: "alpha@official", status: "loaded" }),
      ]));
      expect(project.reloadCandidate).toMatchObject({
        status: "invalid",
        reason: "imported plugin inputs changed or could not be verified during component assembly",
      });
    } finally {
      read.mockRestore();
    }
  });

  it("constructs initial binding from verified post-bracket imported fingerprints without rescanning", () => {
    const { base, repo, userDir } = makeBase();
    const pluginRoot = makeMarketplacePlugin(userDir, "official", "alpha");
    const captured = captureImportedExecutableTrees([pluginRoot]);
    if (!captured.ok) throw new Error(captured.message);
    const skillPath = path.join(pluginRoot, "skills", "alpha-skill", "SKILL.md");
    fs.appendFileSync(skillPath, "\nchanged after post-capture");
    const profileRoot = path.join(base, "profile");
    const binding = captureReloadCandidateBinding({
      cwd: repo,
      projectRoot: repo,
      userDir,
      profileRoot,
      profileKey: "profile-test",
      generationPath: path.join(profileRoot, "generations", "current.json"),
      expectedGeneration: { status: "absent" },
      effectivePluginEnablement: sha256(Buffer.from("enablement")),
      importedExecutableRoots: [pluginRoot],
      initialImportedExecutableTrees: captured.value,
      managedSettingsPaths: [],
    });
    if (!binding.ok) throw new Error(binding.message);
    expect(sameImportedExecutableTrees(binding.value.binding.importedExecutableTrees, captured.value)).toBe(true);
    const recaptured = binding.value.recapture();
    expect(recaptured.ok).toBe(true);
    if (!recaptured.ok) throw new Error(recaptured.message);
    expect(sameImportedExecutableTrees(recaptured.value.importedExecutableTrees, captured.value)).toBe(false);
    expect(captureReloadCandidateBinding({
      cwd: repo,
      projectRoot: repo,
      userDir,
      profileRoot,
      profileKey: "profile-test",
      generationPath: path.join(profileRoot, "generations", "current.json"),
      effectivePluginEnablement: sha256(Buffer.from("enablement")),
      importedExecutableRoots: [path.join(base, "other-root")],
      initialImportedExecutableTrees: captured.value,
      managedSettingsPaths: [],
    })).toMatchObject({ ok: false, code: "imported-root-mismatch" });
  });

  it("binds reload handoff to exact committed generation and authentic settings inputs", () => {
    const { base, repo, userDir } = makeBase();
    installOwnedPlugin(base, repo, userDir, repo, path.dirname(userDir), { hooks: true });
    const project = load(repo, userDir);
    expect(project.reloadCandidate.status).toBe("ready");
    if (project.reloadCandidate.status !== "ready") throw new Error(project.reloadCandidate.reason);
    expect(project.reloadCandidate.binding.executableGeneration).toMatchObject({ status: "present", digest: expect.stringMatching(/^sha256:/u) });
    expect(project.reloadCandidate.binding.settings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "file", status: "absent" }),
    ]));
    expect(project.skills.some((skill) => skill.name === "owned:owned-skill")).toBe(true);
    expect(project.pluginContexts.has("owned@official")).toBe(true);
    expect(project.pluginInventory.find("owned@official")?.outcome?.status).toBe("loaded");
    expect(Object.keys(project.mergedHooks)).toContain("PreToolUse");

    const written = writeReloadHandoff(project.reloadCandidate.handoffPath, project.reloadCandidate.binding, "assembly-test-nonce", 1_000);
    expect(written.ok).toBe(true);
    const observed = readReloadHandoff(project.reloadCandidate.handoffPath, 1_001);
    expect(observed.ok && observed.value?.outcome).toBe("pending");
    expect(observed.ok && observed.value !== undefined && sameReloadBinding(observed.value.binding, project.reloadCandidate.binding)).toBe(true);

    fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "owned@official": false } }));
    const changed = project.reloadCandidate.recapture();
    expect(changed.ok).toBe(true);
    if (!changed.ok) throw new Error(changed.message);
    expect(sameReloadBinding(changed.value, project.reloadCandidate.binding)).toBe(false);
    expect(clearReloadHandoff(project.reloadCandidate.handoffPath).ok).toBe(true);
  });

  it("rejects an imported executable tree containing an external hardlink where the platform permits links", () => {
    const { base, repo, userDir } = makeBase();
    const pluginRoot = makeMarketplacePlugin(userDir, "official", "linked");
    fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({ enabledPlugins: { "linked@official": true } }));
    const skillPath = path.join(pluginRoot, "skills", "linked-skill", "SKILL.md");
    const external = path.join(base, "external-plugin-bytes.md");
    fs.writeFileSync(external, fs.readFileSync(skillPath));
    fs.rmSync(skillPath);
    try {
      fs.linkSync(external, skillPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "EPERM", "ENOTSUP", "EXDEV"].includes(String(code))) return;
      throw error;
    }
    const project = load(repo, userDir);
    expect(fs.statSync(skillPath, { bigint: true }).nlink).toBeGreaterThan(1n);
    expect(project.reloadCandidate).toMatchObject({
      status: "invalid",
      reason: "imported plugin inputs changed or could not be verified during component assembly",
    });
  });

  it("does not call an unreadable authentic settings authority a ready reload candidate", () => {
    const { repo, userDir } = makeBase();
    fs.mkdirSync(path.join(userDir, "settings.json"), { recursive: true });
    const project = load(repo, userDir);
    expect(project.settings.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Settings file unreadable; skipped" }),
    ]));
    expect(project.reloadCandidate).toMatchObject({
      status: "invalid",
      reason: "reload input fingerprint is unreadable or exceeds its bound",
    });
  });

  it("does not call an overflowed authentic settings authority a ready reload candidate", () => {
    const { repo, userDir } = makeBase();
    fs.writeFileSync(path.join(userDir, "settings.json"), Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    const project = load(repo, userDir);
    expect(project.reloadCandidate).toMatchObject({
      status: "invalid",
      reason: "reload input fingerprint is unreadable or exceeds its bound",
    });
  });

  it("rejects a mutated candidate without changing the previously assembled runtime", () => {
    const { base, repo, userDir } = makeBase();
    const owned = installOwnedPlugin(base, repo, userDir);
    const active = load(repo, userDir);
    const activeSkillNames = active.skills.map((skill) => skill.name);
    fs.appendFileSync(path.join(owned.root, "skills", "owned-skill", "SKILL.md"), "\nMUTATED");

    const candidate = load(repo, userDir);
    expect(candidate.reloadCandidate).toMatchObject({ status: "invalid" });
    expect(candidate.executableGenerationObservation.status).toBe("membership-invalid");
    expect(active.skills.map((skill) => skill.name)).toEqual(activeSkillNames);
    expect(active.plugins.map((plugin) => plugin.pluginId)).toEqual(["owned@official"]);
  });

  it("keeps retained snapshot authority executable when current registration is removed", () => {
    const { base, repo, userDir } = makeBase(); installOwnedPlugin(base, repo, userDir);
    const first = load(repo, userDir);
    const marketplaceRecord = first.lifecycleObservation.records.find((item) => {
      if (item.status !== "admitted") return false;
      return (JSON.parse(fs.readFileSync(item.path, "utf8")) as { schema: string }).schema === "marketplace-registration";
    });
    if (marketplaceRecord === undefined) throw new Error("marketplace record");
    fs.rmSync(marketplaceRecord.path);
    const second = load(repo, userDir);
    expect(second.ownedMarketplaces).toEqual([]);
    expect(first.plugins.map((plugin) => [plugin.pluginId, plugin.version])).toEqual([["owned@official", "1.0.0"]]);
    expect(second.plugins.map((plugin) => [plugin.pluginId, plugin.version])).toEqual([["owned@official", "1.0.0"]]);
    expect(second.pluginAdmissions.filter((item) => item.ownership === "picc-owned")).toHaveLength(1);
  });
});

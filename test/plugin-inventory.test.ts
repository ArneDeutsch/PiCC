import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataReadCapability, projectPluginManifest, readObservedPluginMetadata } from "../src/claude/plugin-metadata.js";
import type { InstalledPluginObservation } from "../src/claude/plugin-installed-state.js";
import { buildPluginInventorySnapshot, type PluginInventoryComponent } from "../src/plugin-inventory.js";
import type { InstalledPlugin } from "../src/claude/plugins.js";
import type { PluginMarketplaceState, PluginResolutionOutcome } from "../src/types.js";

const directoryLinksAvailable = (() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "picc-inventory-link-probe-"));
  try { const target = path.join(base, "target"); fs.mkdirSync(target); fs.symlinkSync(target, path.join(base, "link"), process.platform === "win32" ? "junction" : "dir"); return true; }
  catch { return false; } finally { fs.rmSync(base, { recursive: true, force: true }); }
})();
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "picc-inventory-")); roots.push(base);
  const projectRoot = path.join(base, "project"); const userDir = path.join(base, "home", ".claude");
  fs.mkdirSync(projectRoot, { recursive: true }); fs.mkdirSync(userDir, { recursive: true });
  return { base, projectRoot, userDir };
}
function marketplace(overrides: Partial<PluginMarketplaceState> = {}): PluginMarketplaceState {
  return {
    registrations: [], selectedRegistrations: [], catalogs: [], entries: [], dependencies: [], allowlists: [], renames: [], policies: [], conflicts: [], diagnostics: [],
    omissions: { registrations: 0, selectedRegistrations: 0, entries: 0, components: 0, dependencies: 0, renames: 0, policies: 0, allowlists: 0, metadata: 0, userConfig: 0, conflicts: 0, diagnostics: 0 },
    ...overrides,
  };
}
function expectRecursivelyFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value); expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectRecursivelyFrozen(nested, seen);
}
function mutateSourceGraph(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const nested of value) mutateSourceGraph(nested, seen);
    value.push("source-mutation");
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string") (value as Record<string, unknown>)[key] = "source-mutation";
    else if (typeof nested === "number") (value as Record<string, unknown>)[key] = nested + 1;
    else if (typeof nested === "boolean") (value as Record<string, unknown>)[key] = !nested;
    else mutateSourceGraph(nested, seen);
  }
}

describe("buildPluginInventorySnapshot", () => {
  it("types component origins, kinds, and count semantics as one discriminated union", () => {
    const common = { count: 1, capabilityId: "test", supportTier: "full" as const, executionRisk: "code" as const };
    const valid = [
      { ...common, origin: "selected-manifest", kind: "skills", countSemantics: "selected-manifest-declarations" },
      { ...common, origin: "catalog", kind: "hooks", countSemantics: "catalog-declarations", posture: "declared-not-effective" },
      { ...common, origin: "final-runtime", kind: "commands", countSemantics: "finalized-registrations", posture: "final-loaded" },
      { ...common, origin: "final-runtime", kind: "hooks", countSemantics: "retained-executable-registrations", posture: "final-loaded" },
    ] satisfies readonly PluginInventoryComponent[];
    // @ts-expect-error Selected-manifest components report declarations from that manifest.
    const invalidSelected: PluginInventoryComponent = { ...common, origin: "selected-manifest", kind: "skills", countSemantics: "catalog-declarations" };
    // @ts-expect-error Catalog components report catalog declarations.
    const invalidCatalog: PluginInventoryComponent = { ...common, origin: "catalog", kind: "agents", countSemantics: "finalized-registrations", posture: "declared-not-effective" };
    // @ts-expect-error Final runtime hooks report retained executable registrations.
    const invalidHook: PluginInventoryComponent = { ...common, origin: "final-runtime", kind: "hooks", countSemantics: "finalized-registrations", posture: "final-loaded" };
    // @ts-expect-error Final runtime non-hook components report finalized registrations.
    const invalidCommand: PluginInventoryComponent = { ...common, origin: "final-runtime", kind: "commands", countSemantics: "retained-executable-registrations", posture: "final-loaded" };
    expect(valid).toHaveLength(4);
    expect([invalidSelected, invalidCatalog, invalidHook, invalidCommand]).toHaveLength(4);
  });
  it("keeps qualified identities and independent observed, catalog, enablement, and runtime axes", () => {
    const { projectRoot, userDir } = fixture();
    const installed = path.join(userDir, "plugins", "cache", "one", "same", "1.0.0");
    const catalogPath = path.join(userDir, "plugins", "marketplaces", "two", ".claude-plugin", "marketplace.json");
    const provenance = { scope: "user" as const, sourcePath: catalogPath, origin: "primary" as const, order: 0 };
    const field = { field: "source", sourcePath: catalogPath, entryIndex: 0 };
    const state = marketplace({
      entries: [{ identity: "same@two", name: "same", marketplace: "two", source: { kind: "github", repo: "owner/repo" }, fieldProvenance: { source: field, strict: field, defaultEnabled: field }, strict: true, strictDeclaration: { value: true, presence: "default", provenance: field }, defaultEnabled: true, defaultEnabledDeclaration: { value: true, presence: "default", provenance: field }, description: "catalog copy", components: { lspServers: [{ kind: "object-shape", shape: { keys: [{ key: "command", type: "string" }], omitted: 0 }, provenance: field, posture: "declared-not-effective" }] }, dependencies: [{ declaredName: "dep", declaringIdentity: "same@two", targetIdentity: "dep@two", marketplace: "two", version: "^1", versionStatus: "syntax-unverified-not-resolved", provenance: field, crossMarketplace: "same-marketplace", posture: "declared-locally-observable-not-resolved" }], provenance: { ...provenance, catalogPath, entryIndex: 0 }, runtimeEffect: "declared-not-effective" }],
      renames: [{ marketplace: "two", from: "old", declaredTarget: "same", currentIdentity: "same@two", status: "current", fieldProvenance: field, provenance: { ...provenance, catalogPath }, runtimeEffect: "declared-not-effective" }],
    });
    const snapshot = buildPluginInventorySnapshot({
      capturedAt: "2026-01-01T00:00:00.000Z", projectRoot, userDir, installedStateStatus: "valid", marketplaceState: state,
      installedObservations: [{ qualifiedIdentity: "same@one", lifecycleName: "same", marketplaceName: "one", validity: "valid", loadEligibility: "observation-only", declared: { scope: "user", version: "1.0.0", installPath: installed }, problems: [] }],
      enablement: { "same@one": { enabled: false, scope: "user", source: path.join(userDir, "settings.json") }, "missing@one": { enabled: true, scope: "project", source: path.join(projectRoot, ".claude", "settings.json") } },
      outcomes: [{ pluginId: "same@one", status: "disabled", diagnostics: [] }, { pluginId: "missing@one", status: "enabled-but-uninstalled", diagnostics: [] }], selectedPlugins: [],
    });
    expect(snapshot.items.map((item) => item.qualifiedIdentity)).toEqual(["missing@one", "same@one", "same@two"]);
    expect(snapshot.find("same@one")).toMatchObject({ catalogPresence: false, enablement: { enabled: false }, outcome: { status: "disabled" } });
    expect(snapshot.find("same@two")).toMatchObject({ catalogPresence: true });
    expect(snapshot.find("same@two")!.outcome).toBeUndefined();
    expect(snapshot.find("same@two")!.components[0]).toMatchObject({ kind: "lspServers", countSemantics: "catalog-declarations", supportTier: "not-supported", executionRisk: "unsupported-runtime", origin: "catalog", provenance: { field: "source" } });
    expect(snapshot.find("same@two")!.catalogDeclarations[0]).toMatchObject({ strict: { value: true, presence: "default" }, defaultEnabled: { value: true, presence: "default" }, runtimeEffect: "declared-not-effective" });
    expect(snapshot.find("same@two")!.dependencies[0]).toMatchObject({ targetIdentity: "dep@two", versionStatus: "syntax-unverified-not-resolved", posture: "declared-locally-observable-not-resolved" });
    expect(snapshot.find("same@two")!.renames[0]).toMatchObject({ from: "old", target: "same", posture: "declared-not-effective" });
    expect(snapshot.find("missing@one")!.outcome!.status).toBe("enabled-but-uninstalled");
    expect(snapshot.find("same")).toBeUndefined();
  });

  it("joins the lifecycle status matrix without collapsing installation scopes or malformed siblings", () => {
    const { projectRoot, userDir } = fixture();
    const statuses = ["unsupported", "ambiguous", "blocked", "malformed", "rejected"] as const;
    const outcomes: PluginResolutionOutcome[] = statuses.map((status) => ({ pluginId: `${status}@market`, status, diagnostics: [] }));
    const installedObservations: InstalledPluginObservation[] = [
      { qualifiedIdentity: "unmentioned@market", lifecycleName: "unmentioned", marketplaceName: "market", validity: "valid", loadEligibility: "observation-only", declared: { scope: "user", version: "1", installPath: path.join(userDir, "plugins", "cache", "m", "unmentioned", "1") }, problems: [] },
      { qualifiedIdentity: "unmentioned@market", lifecycleName: "unmentioned", marketplaceName: "market", validity: "valid", loadEligibility: "observation-only", declared: { scope: "project", version: "2", installPath: path.join(userDir, "plugins", "cache", "m", "unmentioned", "2"), projectPath: projectRoot }, problems: [] },
      { qualifiedIdentity: "broken@market", lifecycleName: "broken", marketplaceName: "market", validity: "invalid", loadEligibility: "observation-only", declared: {}, problems: ["record-not-object"] },
    ];
    const snapshot = buildPluginInventorySnapshot({ projectRoot, userDir, installedStateStatus: "malformed", installedObservations, marketplaceState: marketplace(), enablement: {}, outcomes, selectedPlugins: [] });
    for (const status of statuses) expect(snapshot.find(`${status}@market`)!.outcome!.status).toBe(status);
    expect(snapshot.find("unmentioned@market")).toMatchObject({ installations: [{ scope: "user", version: "1" }, { scope: "project", version: "2" }] });
    expect(snapshot.find("unmentioned@market")!.enablement).toBeUndefined(); expect(snapshot.find("unmentioned@market")!.outcome).toBeUndefined();
    expect(snapshot.find("broken@market")!.installations[0]).toMatchObject({ validity: "invalid", problems: ["record-not-object"] });
  });

  it("marks only the exact selected project installation across every selection field", () => {
    const { projectRoot, userDir } = fixture();
    const installPath = path.join(userDir, "plugins", "cache", "market", "plug", "1");
    const installation = { pluginId: "plug@market", scope: "project" as const, version: "1", installPath, projectPath: projectRoot, provenance: { statePath: path.join(userDir, "plugins", "installed_plugins.json"), stateVersion: 2 } };
    const declared = [
      installation,
      { ...installation, scope: "user" as const },
      { ...installation, version: "1-near" },
      { ...installation, installPath: `${installPath}-near` },
      { ...installation, projectPath: `${projectRoot}-near` },
      { ...installation, projectPath: undefined },
    ];
    const installedObservations: InstalledPluginObservation[] = declared.map((value) => ({
      qualifiedIdentity: "plug@market", lifecycleName: "plug", marketplaceName: "market", validity: "valid", loadEligibility: "observation-only", declared: value, problems: [],
    }));
    const snapshot = buildPluginInventorySnapshot({ projectRoot, userDir, installedStateStatus: "valid", installedObservations, marketplaceState: marketplace(), enablement: {}, outcomes: [{ pluginId: "plug@market", status: "loaded", installation, diagnostics: [] }], selectedPlugins: [] });
    expect(snapshot.find("plug@market")!.installations.map((value) => value.selected)).toEqual([true, false, false, false, false, false]);
    expect(snapshot.find("plug@market")!.installations[0]).toMatchObject({ scope: "project", projectLocation: { kind: "project" } });
  });

  it("copies and freezes bounded safe evidence without leaking absolute malformed paths or managed text", () => {
    const { projectRoot, userDir } = fixture();
    const state = marketplace({ diagnostics: [{ severity: "warning", message: "catalog warning", source: "C:/secret/catalog.json" }] });
    const snapshot = buildPluginInventorySnapshot({ projectRoot, userDir, installedStateStatus: "malformed", installedObservations: [{ qualifiedIdentity: "bad@one", lifecycleName: "bad", marketplaceName: "one", validity: "invalid", loadEligibility: "observation-only", declared: { installPath: "C:/private/outside" }, problems: ["scope-invalid"] }], marketplaceState: state, enablement: {}, outcomes: [], selectedPlugins: [], diagnostics: [{ severity: "warning", message: "administrator secret text", category: "managed-policy-malformed", sourceClass: "system-file", impact: "source-ignored" }], capabilityEvidence: [{ capabilityId: "agent.frontmatter.hooks", qualifiedIdentity: "bad@one", component: "agent", observation: "field stripped" }] });
    expect(snapshot.items[0]!.installations[0]!.location).toEqual({ kind: "external", display: "<external>" });
    expect(JSON.stringify(snapshot)).not.toContain("private");
    expect(JSON.stringify(snapshot)).not.toContain("administrator secret text");
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ category: "managed-policy-malformed", sourceClass: "system-file", impact: "source-ignored" }));
    expect(snapshot.refreshGuidance).toContain("/reload");
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.items)).toBe(true); expect(Object.isFrozen(snapshot.items[0]!.installations)).toBe(true);
    expect(() => (snapshot.items as unknown as unknown[]).push({})).toThrow();
  });

  it("classifies enabledPlugins diagnostics into fixed immutable evidence", () => {
    const { projectRoot, userDir } = fixture();
    const snapshot = buildPluginInventorySnapshot({
      projectRoot, userDir, installedStateStatus: "valid", installedObservations: [], marketplaceState: marketplace(), enablement: {}, outcomes: [], selectedPlugins: [],
      enablementDiagnostics: [
        { severity: "warning", message: 'Setting "enabledPlugins" is not an object; ignored', source: path.join(userDir, "SECRET-settings.json") },
        { severity: "warning", message: 'Invalid plugin identity in "enabledPlugins" ignored', source: "SECRET-invalid-source" },
        { severity: "warning", message: 'Plugin "safe@market" in "enabledPlugins" must be a literal boolean; ignored', source: "SECRET-value-source" },
        { severity: "warning", message: "unrelated SECRET diagnostic" },
      ],
    });
    expect(snapshot.diagnostics).toEqual([
      { severity: "warning", category: "enabled-plugins-not-object", message: "The enabledPlugins declaration was not an object and was ignored" },
      { severity: "warning", category: "enabled-plugins-invalid-identity", message: "An invalid qualified plugin identity in enabledPlugins was ignored" },
      { severity: "warning", category: "enabled-plugins-non-boolean", message: "A non-boolean enabledPlugins value was ignored" },
    ]);
    expect(JSON.stringify(snapshot.diagnostics)).not.toMatch(/SECRET|safe@market/u);
    expect(Object.isFrozen(snapshot.diagnostics[0])).toBe(true);
  });

  it("never probes an observational root outside independently eligible cache bases", () => {
    const { base, userDir } = fixture();
    const cache = path.join(userDir, "plugins", "cache"); const outside = path.join(base, "outside");
    fs.mkdirSync(cache, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
    const capability = createPluginMetadataReadCapability([cache]);
    const read = vi.spyOn(fs, "readFileSync");
    const result = readObservedPluginMetadata(outside, capability);
    expect(result.projection).toBeUndefined();
    expect(result.diagnostics[0]!.message).toContain("outside every eligible plugin cache");
    expect(read).not.toHaveBeenCalled();
  });

  it("reads contained observational metadata within the bounded parser", () => {
    const { userDir } = fixture();
    const cache = path.join(userDir, "plugins", "cache"); const root = path.join(cache, "market", "plug", "1");
    const manifestDir = path.join(root, ".claude-plugin"); fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, "plugin.json"), JSON.stringify({ name: "plug", description: "safe" }));
    expect(readObservedPluginMetadata(root, createPluginMetadataReadCapability([cache])).projection).toMatchObject({ manifestName: "plug", description: "safe" });
  });

  it.skipIf(!directoryLinksAvailable)("rejects a junction-capable manifest directory escape", () => {
    const { base, userDir } = fixture();
    const cache = path.join(userDir, "plugins", "cache"); const root = path.join(cache, "market", "plug", "1");
    const outside = path.join(base, "outside-manifest"); fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "plugin.json"), JSON.stringify({ name: "escaped" }));
    fs.symlinkSync(outside, path.join(root, ".claude-plugin"), process.platform === "win32" ? "junction" : "dir");
    const escaped = readObservedPluginMetadata(root, createPluginMetadataReadCapability([cache]));
    expect(escaped.projection).toBeUndefined();
    expect(escaped.diagnostics[0]!.message).toContain("escaped");
  });

  it("keeps policy observations global and exact without marketplace-name attribution", () => {
    const { projectRoot, userDir } = fixture(); const sourcePath = path.join(userDir, "settings.json");
    const provenance = { scope: "user" as const, sourcePath, origin: "settings" as const, order: 0 };
    const state = marketplace({
      registrations: ["foo", "foobar"].map((name, order) => ({ name, source: { kind: "github" as const, repo: `owner/${name}` }, sourceProvenance: { field: name, sourcePath }, provenance: { ...provenance, order }, selected: true, validity: "valid" as const })),
      policies: [
        { kind: "blocked", descriptor: { kind: "github", repo: "owner/foo" }, descriptorProvenance: { field: "blockedMarketplaces", sourcePath }, provenance, validScope: true, match: true, posture: "claude-lifecycle-observation-not-enforced" },
        { kind: "strict", provenance, validScope: true, match: false, emptyLockdown: true, posture: "claude-lifecycle-observation-not-enforced" },
      ],
    });
    const snapshot = buildPluginInventorySnapshot({ projectRoot, userDir, installedStateStatus: "valid", installedObservations: [], marketplaceState: state, enablement: {}, outcomes: [], selectedPlugins: [] });
    expect(snapshot.marketplaces.map((item) => item.name)).toEqual(["foo", "foobar"]);
    expect(snapshot.marketplaces.every((item) => !("policy" in item))).toBe(true);
    expect(snapshot.policyObservations).toEqual([
      expect.objectContaining({ kind: "blocked", match: true, emptyLockdown: false }),
      expect.objectContaining({ kind: "strict", match: false, emptyLockdown: true }),
    ]);
  });

  it("separates resolver selection from final committed counts and command lifetime", () => {
    const { projectRoot, userDir } = fixture(); const root = path.join(userDir, "plugins", "cache", "official", "alpha", "1");
    const selected = {
      pluginId: "alpha@official", name: "runtime-name", marketplace: "official", version: "1", scope: "user", root,
      dataDir: path.join(userDir, "plugins", "data", "alpha"), manifestProjection: { manifestName: "runtime-name", keywords: [], components: [{ field: "agents", declaration: "path", count: 1 }] },
      skillSources: [], commandSources: [], agentSources: [], hookSources: [], hookPathSources: [], enabled: true, diagnostics: [],
      installation: { pluginId: "alpha@official", scope: "user", installPath: root, version: "1", provenance: { statePath: "state", stateVersion: 2 } },
      context: { pluginId: "alpha@official", pluginName: "runtime-name", root, dataDir: path.join(userDir, "plugins", "data", "alpha"), projectDir: projectRoot },
    } satisfies InstalledPlugin;
    const snapshot = buildPluginInventorySnapshot({ lifetime: "command", projectRoot, userDir, installedStateStatus: "valid", installedObservations: [], marketplaceState: marketplace(), enablement: {}, outcomes: [{ pluginId: "alpha@official", status: "rejected", installation: selected.installation, diagnostics: [] }], selectedPlugins: [selected], finalLoadedComponents: {} });
    selected.manifestProjection.components[0]!.count = 99;
    const item = snapshot.find("alpha@official")!;
    expect(item.selectedInstallation).toMatchObject({ root: { kind: "plugin-cache" }, data: { kind: "plugin-data" } });
    expect(item.components).toContainEqual(expect.objectContaining({ origin: "selected-manifest", kind: "agents", count: 1, countSemantics: "selected-manifest-declarations" }));
    expect(item.components.some((component) => component.origin === "final-runtime")).toBe(false);
    expect(item).not.toHaveProperty("finalLoadedComponents");
    expect(snapshot.refreshGuidance).toBe("Captured for this command; run the command again to refresh.");
    expect(snapshot.refreshGuidance).not.toContain("/reload");
    expect(fs.existsSync(selected.dataDir)).toBe(false);
  });

  it("performs no write, network, process, hook, runtime, or data-directory side effects", () => {
    const { projectRoot, userDir } = fixture(); const marker = path.join(projectRoot, "hook-marker"); const data = path.join(userDir, "plugins", "data");
    const root = path.join(userDir, "plugins", "cache", "hostile", "1"); const dataDir = path.join(data, "hostile");
    const selected: InstalledPlugin = {
      pluginId: "hostile@market", name: "hostile", marketplace: "market", version: "1", scope: "user", root, dataDir,
      manifestProjection: { manifestName: "hostile", keywords: [], components: [{ field: "hooks", declaration: "object", count: 1 }] }, skillSources: [], commandSources: [], agentSources: [],
      hookSources: [{ kind: "inline", value: { PreToolUse: `touch ${marker}` }, pluginId: "hostile@market", pluginName: "hostile", source: "plugin manifest hooks" }], hookPathSources: [], enabled: true, diagnostics: [],
      installation: { pluginId: "hostile@market", scope: "user", installPath: root, version: "1", provenance: { statePath: path.join(userDir, "plugins", "installed_plugins.json"), stateVersion: 2 } },
      context: { pluginId: "hostile@market", pluginName: "hostile", root, dataDir, projectDir: projectRoot },
    };
    const writes = vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("inventory attempted a write"); });
    const mkdirs = vi.spyOn(fs, "mkdirSync").mockImplementation(() => { throw new Error("inventory attempted mkdir"); });
    const spawns = vi.spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("inventory attempted process spawn"); });
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("inventory attempted network"); }) as typeof fetch;
    try {
      const catalogPath = path.join(userDir, "plugins", "marketplaces", "hostile", ".claude-plugin", "marketplace.json"); const provenance = { scope: "user" as const, sourcePath: catalogPath, origin: "primary" as const, order: 0 }; const field = { field: "source", sourcePath: catalogPath, entryIndex: 0 };
      const state = marketplace({ entries: [{ identity: "hostile@market", name: "hostile", marketplace: "market", source: { kind: "url", url: "https://user:password@example.test/plugin?token=secret" }, fieldProvenance: { source: field }, strict: false, strictDeclaration: { value: false, presence: "default", provenance: field }, defaultEnabled: true, defaultEnabledDeclaration: { value: true, presence: "default", provenance: field }, components: { hooks: [{ kind: "object-shape", shape: { keys: [{ key: "safe", type: "string" }], omitted: 0 }, provenance: field, posture: "declared-not-effective" }] }, dependencies: [], userConfig: { keys: [{ key: "mode", type: "string" }], omitted: 0, provenance: field }, provenance: { ...provenance, catalogPath, entryIndex: 0 }, runtimeEffect: "declared-not-effective" }] });
      const snapshot = buildPluginInventorySnapshot({ projectRoot, userDir, installedStateStatus: "valid", installedObservations: [{ qualifiedIdentity: "hostile@market", lifecycleName: "hostile", marketplaceName: "market", validity: "valid", loadEligibility: "observation-only", declared: { scope: "user", version: "1", installPath: root }, problems: [] }], marketplaceState: state, enablement: {}, outcomes: [{ pluginId: "hostile@market", status: "loaded", installation: selected.installation, diagnostics: [] }], selectedPlugins: [selected], finalLoadedComponents: { "hostile@market": { skills: 0, commands: 0, agents: 0, hooks: 1 } } });
      expect(snapshot.items).toHaveLength(1); expect(snapshot.items[0]!.components).toContainEqual(expect.objectContaining({ origin: "final-runtime", kind: "hooks", count: 1, countSemantics: "retained-executable-registrations" })); expect(JSON.stringify(snapshot)).not.toContain("password"); expect(JSON.stringify(snapshot)).not.toContain("token=secret");
      expect(writes).not.toHaveBeenCalled(); expect(mkdirs).not.toHaveBeenCalled(); expect(spawns).not.toHaveBeenCalled();
      expect(fs.existsSync(marker)).toBe(false); expect(fs.existsSync(data)).toBe(false);
    } finally {
      globalThis.fetch = fetchBefore; writes.mockRestore(); mkdirs.mockRestore(); spawns.mockRestore();
    }
  });

  it("caps, sums namespaced omissions, avoids duplicate overwrite, and deep-copies source data", () => {
    const { projectRoot, userDir } = fixture();
    const outcomes: PluginResolutionOutcome[] = Array.from({ length: 2049 }, (_, index) => ({ pluginId: `p${index}@m`, status: "disabled", diagnostics: [] }));
    outcomes.push({ pluginId: "p0@m", status: "loaded", diagnostics: [] });
    const state = marketplace({ omissions: { ...marketplace().omissions, entries: 2 } });
    const snapshot = buildPluginInventorySnapshot({ projectRoot, userDir, installedStateStatus: "valid", installedObservations: [], installedObservationOmissions: { records: 3 }, marketplaceState: state, enablement: {}, outcomes, selectedPlugins: [] });
    outcomes[0]!.status = "loaded";
    expect(snapshot.items).toHaveLength(2048);
    expect(snapshot.find("p0@m")!.outcome!.status).toBe("disabled");
    expect(snapshot.omissions).toMatchObject({ "loader.installed.records": 3, "loader.marketplace.entries": 2, "snapshot.items": 1, "snapshot.duplicate-outcomes": 1 });
    expect(Object.isFrozen(snapshot.items[0]!.outcome!.sharedStateCauses)).toBe(true);
    expect(() => (snapshot.policyObservations as unknown as unknown[]).push({})).toThrow();
  });

  it("preserves exhaustive inert catalog, policy, allowlist, conflict, and user-config evidence", () => {
    const { projectRoot, userDir } = fixture(); const catalogPath = path.join(userDir, "plugins", "marketplaces", "official", ".claude-plugin", "marketplace.json");
    const provenance = { scope: "user" as const, sourcePath: path.join(userDir, "known_marketplaces.json"), origin: "primary" as const, order: 0 };
    const field = (name: string) => ({ field: name, sourcePath: catalogPath, entryIndex: 0 });
    const sources = [
      { kind: "relative" as const, value: "./plugin" }, { kind: "github" as const, repo: "owner/repo", ref: "main", sha: "abc" },
      { kind: "url" as const, url: "https://example.test/plugin.git", ref: "v1", sha: "def" },
      { kind: "git-subdir" as const, url: "https://example.test/repo.git", path: "plugins/one", ref: "main", sha: "ghi" },
      { kind: "npm" as const, package: "@scope/plugin", version: "1.2.3", registry: "https://registry.example.test" },
    ];
    const entries: PluginMarketplaceState["entries"] = sources.map((source, index) => ({
      identity: `p${index}@official`, name: `p${index}`, marketplace: "official", source,
      sourceEffect: { availability: "locally-observable", lexicalPath: path.join(userDir, "plugins", "marketplaces", "official", `p${index}`), provenance: field("source") },
      release: { kind: "source-sha", value: `sha${index}`, provenance: field("release"), evidence: "fixture-derived-unverified" },
      version: "1.2.3", revision: "rev", revisionEvidence: "fixture-derived-unverified", description: "catalog description",
      fieldProvenance: { source: field("source"), version: field("version"), revision: field("revision"), description: field("description") },
      strict: true, strictDeclaration: { value: true, presence: "explicit", provenance: field("strict") },
      defaultEnabled: false, defaultEnabledDeclaration: { value: false, presence: "explicit", provenance: field("defaultEnabled") },
      components: {}, dependencies: [], userConfig: { keys: [{ key: "channel", type: "string" }], omitted: 2, provenance: field("userConfig") },
      provenance: { ...provenance, catalogPath, entryIndex: index }, runtimeEffect: "declared-not-effective",
    }));
    const state = marketplace({
      catalogs: [{ marketplace: "official", catalogPath, metadata: { pluginRoot: "./plugins", provenance: field("metadata.pluginRoot"), posture: "inert-lexical-effect-only" }, provenance }], entries,
      allowlists: [{ marketplace: "official", allowedMarketplace: "partner", provenance: field("allowedMarketplaces") }],
      conflicts: [{ identity: "p0@official", winner: field("winner"), loser: field("loser"), posture: "observed-conflict-not-effective" }],
      policies: [{ kind: "blocked", descriptor: { kind: "hostPattern", hostPattern: "*.example.test" }, descriptorProvenance: field("blockedMarketplaces"), provenance, validScope: true, match: false, posture: "claude-lifecycle-observation-not-enforced" }],
    });
    const snapshot = buildPluginInventorySnapshot({ projectRoot, userDir, installedStateStatus: "valid", installedObservations: [], marketplaceState: state, enablement: {}, outcomes: [], selectedPlugins: [] });
    (sources[1] as { repo: string }).repo = "mutated"; entries[0]!.fieldProvenance["source"]!.field = "mutated"; state.allowlists[0]!.allowedMarketplace = "mutated";
    expect(snapshot.items.map((item) => item.catalogDeclarations[0]!.source)).toEqual([
      { kind: "relative", value: "./plugin" }, { kind: "github", repo: "owner/repo", ref: "main", sha: "abc" },
      { kind: "url", url: "https://example.test/plugin.git", ref: "v1", sha: "def" }, { kind: "git-subdir", url: "https://example.test/repo.git", path: "plugins/one", ref: "main", sha: "ghi" },
      { kind: "npm", package: "@scope/plugin", version: "1.2.3", registry: "https://registry.example.test/" },
    ]);
    const declaration = snapshot.find("p0@official")!.catalogDeclarations[0]!;
    expect(declaration).toMatchObject({ version: "1.2.3", revision: "rev", revisionEvidence: "fixture-derived-unverified", description: "catalog description", release: { evidence: "fixture-derived-unverified" }, userConfig: { omitted: 2, posture: "declared-not-effective" }, provenance: { source: { kind: "marketplace-cache" } } });
    expect(declaration.fieldProvenance).toMatchObject({ source: { field: "source" }, version: { field: "version" }, revision: { field: "revision" }, description: { field: "description" } });
    expect(snapshot.marketplaceCatalogs[0]).toMatchObject({ metadata: { pluginRoot: { kind: "external", display: "<external>" }, posture: "inert-lexical-effect-only" } });
    expect(snapshot.allowlistObservations[0]).toMatchObject({ allowedMarketplace: "partner", posture: "declared-not-effective" });
    expect(snapshot.conflictObservations[0]).toMatchObject({ identity: "p0@official", posture: "observed-conflict-not-effective" });
    expect(snapshot.policyObservations[0]).toMatchObject({ descriptor: { kind: "hostPattern", hostPattern: "*.example.test" }, descriptorProvenance: { field: "blockedMarketplaces" } });
    expect(Object.isFrozen(declaration.fieldProvenance)).toBe(true); expect(Object.isFrozen(declaration.userConfig!.keys)).toBe(true); expect(snapshot.omissions["snapshot.catalog-user-config"]).toBe(10);
  });

  it("recursively freezes and detaches every populated snapshot branch from its sources", () => {
    const { projectRoot, userDir } = fixture();
    const root = path.join(userDir, "plugins", "cache", "official", "plug", "1");
    const catalogPath = path.join(userDir, "plugins", "marketplaces", "official", ".claude-plugin", "marketplace.json");
    const full = { scope: "user" as const, sourcePath: catalogPath, origin: "primary" as const, order: 7 };
    const field = { field: "plugins", sourcePath: catalogPath, entryIndex: 1, itemIndex: 2, key: "plug" };
    const selected: InstalledPlugin = {
      pluginId: "plug@official", name: "manifest-plug", marketplace: "official", version: "1", scope: "user", root, dataDir: path.join(userDir, "plugins", "data", "plug"),
      manifestProjection: { manifestName: "manifest-plug", description: "safe", keywords: ["one"], components: [{ field: "hooks", declaration: "path", count: 1 }], omissions: { keywords: 0, components: 0, diagnostics: 0 } },
      skillSources: [], commandSources: [], agentSources: [], hookSources: [{ kind: "inline", value: { PreToolUse: "echo safe" }, pluginId: "plug@official", pluginName: "manifest-plug", source: "plugin manifest hooks" }], hookPathSources: [], enabled: true, diagnostics: [{ severity: "warning", message: "safe warning" }],
      installation: { pluginId: "plug@official", scope: "user", installPath: root, version: "1", provenance: { statePath: path.join(userDir, "plugins", "installed_plugins.json"), stateVersion: 2, installedAt: "then" } },
      context: { pluginId: "plug@official", pluginName: "manifest-plug", root, dataDir: path.join(userDir, "plugins", "data", "plug"), projectDir: projectRoot },
    };
    const state = marketplace({
      registrations: [{ name: "official", source: { kind: "github", repo: "owner/catalog" }, sourceProvenance: field, provenance: full, fixtureContract: "fixture-derived-unverified", catalogPath, selected: true, validity: "valid" }],
      catalogs: [{ marketplace: "official", catalogPath, metadata: { pluginRoot: "./plugins", provenance: field, posture: "inert-lexical-effect-only" }, provenance: full }],
      entries: [{ identity: "plug@official", name: "plug", marketplace: "official", source: { kind: "relative", value: "./plug" }, fieldProvenance: { source: field }, strict: true, strictDeclaration: { value: true, presence: "explicit", provenance: field }, defaultEnabled: true, defaultEnabledDeclaration: { value: true, presence: "explicit", provenance: field }, components: { hooks: [{ kind: "path", value: "./hooks.json", provenance: field, posture: "declared-not-effective" }] }, dependencies: [{ declaredName: "dep", declaringIdentity: "plug@official", targetIdentity: "dep@official", marketplace: "official", provenance: field, crossMarketplace: "same-marketplace", posture: "declared-locally-observable-not-resolved" }], userConfig: { keys: [{ key: "mode", type: "string" }], omitted: 0, provenance: field }, provenance: { ...full, catalogPath, entryIndex: 1 }, runtimeEffect: "declared-not-effective" }],
      allowlists: [{ marketplace: "official", allowedMarketplace: "partner", provenance: field }],
      renames: [{ marketplace: "official", from: "old", declaredTarget: "plug", currentIdentity: "plug@official", status: "current", fieldProvenance: field, provenance: { ...full, catalogPath }, runtimeEffect: "declared-not-effective" }],
      conflicts: [{ identity: "plug@official", winner: field, loser: { ...field, itemIndex: 3 }, posture: "observed-conflict-not-effective" }],
      policies: [{ kind: "blocked", descriptor: { kind: "github", repo: "owner/blocked" }, descriptorProvenance: field, provenance: full, validScope: true, match: false, posture: "claude-lifecycle-observation-not-enforced" }],
      diagnostics: [{ severity: "warning", message: "catalog warning" }],
    });
    const options: Parameters<typeof buildPluginInventorySnapshot>[0] = {
      capturedAt: "2026-01-01T00:00:00.000Z", projectRoot, userDir, installedStateStatus: "valid", marketplaceState: state,
      installedObservations: [{ qualifiedIdentity: "plug@official", lifecycleName: "plug", marketplaceName: "official", validity: "valid", loadEligibility: "observation-only", declared: { scope: "user", version: "1", installPath: root }, problems: [] }],
      enablement: { "plug@official": { enabled: true, scope: "user", source: path.join(userDir, "settings.json") } }, outcomes: [{ pluginId: "plug@official", status: "loaded", installation: selected.installation, diagnostics: [{ severity: "warning", message: "outcome warning" }], sharedStateCauses: ["installed-state-malformed"] }],
      selectedPlugins: [selected], finalLoadedComponents: { "plug@official": { skills: 1, commands: 1, agents: 1, hooks: 1 } }, diagnostics: [{ severity: "warning", message: "global warning" }],
      capabilityEvidence: [{ capabilityId: "agent.frontmatter.hooks", qualifiedIdentity: "plug@official", component: "agent", observation: "Plugin agent field hooks was stripped before runtime construction" }],
    };
    const snapshot = buildPluginInventorySnapshot(options); const before = JSON.stringify(snapshot);
    mutateSourceGraph(options);
    expect(JSON.stringify(snapshot)).toBe(before); expectRecursivelyFrozen(snapshot);
    expect(snapshot.marketplaces[0]).toMatchObject({ fixtureContract: "fixture-derived-unverified", provenance: { scope: "user", origin: "primary", order: 7, source: { kind: "marketplace-cache" } }, sourceProvenance: { scope: "user", origin: "primary", order: 7, field: "plugins", entryIndex: 1, itemIndex: 2, key: "plug" } });
    expect(snapshot.find("plug@official")!.components.filter((component) => component.origin === "final-runtime")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "skills", count: 1, countSemantics: "finalized-registrations" }),
      expect.objectContaining({ kind: "commands", count: 1, countSemantics: "finalized-registrations" }),
      expect.objectContaining({ kind: "agents", count: 1, countSemantics: "finalized-registrations" }),
      expect.objectContaining({ kind: "hooks", count: 1, countSemantics: "retained-executable-registrations" }),
    ]));
  });

  it("caps every public collection at max plus one and records each omission", () => {
    const { projectRoot, userDir } = fixture();
    const catalogPath = path.join(userDir, "plugins", "marketplaces", "official", ".claude-plugin", "marketplace.json");
    const full = { scope: "user" as const, sourcePath: catalogPath, origin: "primary" as const, order: 0 };
    const field = { field: "plugins", sourcePath: catalogPath, entryIndex: 0, itemIndex: 0, key: "plug" };
    const dependencies = Array.from({ length: 129 }, (_, index) => ({ declaredName: `dep${index}`, declaringIdentity: "plug@official", targetIdentity: `dep${index}@official`, marketplace: "official", provenance: { ...field, itemIndex: index }, crossMarketplace: "same-marketplace" as const, posture: "declared-locally-observable-not-resolved" as const }));
    const hookDeclarations = Array.from({ length: 129 }, (_, index) => ({ kind: "path" as const, value: `./hooks/${index}.json`, provenance: { ...field, itemIndex: index }, posture: "declared-not-effective" as const }));
    const entries: PluginMarketplaceState["entries"] = Array.from({ length: 65 }, (_, index) => ({
      identity: "plug@official", name: "plug", marketplace: "official", source: { kind: "relative" as const, value: `./plug-${index}` },
      fieldProvenance: { source: { ...field, entryIndex: index } }, strict: false, strictDeclaration: { value: false, presence: "default" as const, provenance: { ...field, entryIndex: index } },
      defaultEnabled: true, defaultEnabledDeclaration: { value: true, presence: "default" as const, provenance: { ...field, entryIndex: index } },
      components: index === 0 ? { hooks: hookDeclarations } : {}, dependencies: index === 0 ? dependencies : [],
      provenance: { ...full, catalogPath, entryIndex: index }, runtimeEffect: "declared-not-effective" as const,
    }));
    const state = marketplace({
      registrations: Array.from({ length: 257 }, (_, index) => ({ name: `market${index}`, source: { kind: "github" as const, repo: `owner/market${index}` }, sourceProvenance: { ...field, key: `market${index}` }, provenance: { ...full, order: index }, selected: index === 0, validity: "valid" as const })),
      catalogs: Array.from({ length: 257 }, (_, index) => ({ marketplace: `market${index}`, catalogPath, provenance: { ...full, order: index } })),
      entries,
      allowlists: Array.from({ length: 65 }, (_, index) => ({ marketplace: "official", allowedMarketplace: `partner${index}`, provenance: { ...field, itemIndex: index } })),
      renames: Array.from({ length: 65 }, (_, index) => ({ marketplace: "official", from: `old${index}`, declaredTarget: "plug", currentIdentity: "plug@official", status: "current" as const, fieldProvenance: { ...field, itemIndex: index }, provenance: { ...full, catalogPath }, runtimeEffect: "declared-not-effective" as const })),
      conflicts: Array.from({ length: 65 }, (_, index) => ({ identity: `plug${index}@official`, winner: { ...field, itemIndex: index }, loser: { ...field, itemIndex: index + 1 }, posture: "observed-conflict-not-effective" as const })),
      policies: Array.from({ length: 257 }, (_, index) => ({ kind: "strict" as const, provenance: { ...full, order: index }, validScope: true, match: false, posture: "claude-lifecycle-observation-not-enforced" as const })),
    });
    const installedObservations: InstalledPluginObservation[] = Array.from({ length: 65 }, (_, index) => ({ qualifiedIdentity: "plug@official", lifecycleName: "plug", marketplaceName: "official", validity: "valid", loadEligibility: "observation-only", declared: { scope: "user", version: `${index}`, installPath: path.join(userDir, "plugins", "cache", "official", "plug", `${index}`) }, problems: [] }));
    const snapshot = buildPluginInventorySnapshot({
      projectRoot, userDir, installedStateStatus: "valid", installedObservations, marketplaceState: state, enablement: {},
      outcomes: [{ pluginId: "plug@official", status: "rejected", diagnostics: Array.from({ length: 129 }, (_, index) => ({ severity: "warning" as const, message: `item ${index}` })) }], selectedPlugins: [],
      diagnostics: Array.from({ length: 129 }, (_, index) => ({ severity: "warning" as const, message: `global ${index}` })),
      capabilityEvidence: Array.from({ length: 257 }, (_, index) => ({ capabilityId: "agent.frontmatter.hooks", qualifiedIdentity: "plug@official", component: `agent${index}`, observation: "Plugin agent field hooks was stripped before runtime construction" })),
    });
    const item = snapshot.find("plug@official")!;
    expect(item.installations).toHaveLength(64); expect(item.catalogDeclarations).toHaveLength(64); expect(item.components).toHaveLength(128);
    expect(item.dependencies).toHaveLength(128); expect(item.renames).toHaveLength(64); expect(item.diagnostics).toHaveLength(128);
    expect(snapshot.marketplaces).toHaveLength(256); expect(snapshot.marketplaceCatalogs).toHaveLength(256); expect(snapshot.allowlistObservations).toHaveLength(64);
    expect(snapshot.conflictObservations).toHaveLength(64); expect(snapshot.policyObservations).toHaveLength(256);
    expect(snapshot.diagnostics).toHaveLength(128); expect(snapshot.capabilityEvidence).toHaveLength(256);
    expect(snapshot.omissions).toMatchObject({
      "snapshot.installations": 1, "snapshot.catalog-declarations": 1, "snapshot.components": 1, "snapshot.dependencies": 1, "snapshot.renames": 1,
      "snapshot.item-diagnostics": 1, "snapshot.marketplaces": 1, "snapshot.marketplace-catalogs": 1, "snapshot.allowlists": 1, "snapshot.conflicts": 1,
      "snapshot.policies": 1, "snapshot.diagnostics": 1, "snapshot.capability-evidence": 1,
    });
    expect(snapshot.omissions["snapshot.allowlists"]).toBe(1); expect(snapshot.omissions["snapshot.conflicts"]).toBe(1);
  });

  it("bounds observational manifest bytes and nesting plus metadata allowlists and omissions", () => {
    const projection = projectPluginManifest({ keywords: Array.from({ length: 33 }, () => 7), skills: Array.from({ length: 65 }, () => "x"), unknownSecret: "ignored", homepage: "https://user:pass@example.test/private", name: 7, version: 7, description: 7, author: 7, repository: 7, license: 7 });
    expect(projection.projection.keywords).toHaveLength(0); expect(projection.projection.components[0]).toMatchObject({ count: 64 }); expect(projection.diagnostics).toHaveLength(32);
    expect(projection.projection.omissions).toMatchObject({ keywords: 1, components: 1 }); expect(projection.projection.omissions!.diagnostics).toBeGreaterThan(0); expect(projection.projection).not.toHaveProperty("unknownSecret"); expect(projection.projection).not.toHaveProperty("homepage");
    const { userDir } = fixture(); const cache = path.join(userDir, "plugins", "cache"); const root = path.join(cache, "m", "p", "1"); const manifest = path.join(root, ".claude-plugin", "plugin.json"); fs.mkdirSync(path.dirname(manifest), { recursive: true });
    const capability = createPluginMetadataReadCapability([cache]);
    fs.writeFileSync(manifest, `${" ".repeat(256 * 1024)}x`); expect(readObservedPluginMetadata(root, capability).diagnostics[0]!.message).toContain("byte limit");
    fs.writeFileSync(manifest, `${"[".repeat(65)}0${"]".repeat(65)}`); expect(readObservedPluginMetadata(root, capability).diagnostics[0]!.message).toContain("nesting limit");
  });
});

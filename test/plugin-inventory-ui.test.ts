import { visibleWidth } from "@earendil-works/pi-tui";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PluginInventoryDiagnostic, PluginInventoryItem, PluginInventoryMarketplace, PluginInventorySnapshot } from "../src/plugin-inventory.js";
import { PluginInventoryFocusController, openPluginInventory } from "../src/runtime/plugin-inventory-focus.js";
import { PluginInventoryModel, type PluginInventoryActionName } from "../src/runtime/plugin-inventory-model.js";
import { renderPluginInventory } from "../src/runtime/plugin-inventory-render.js";
import type { PluginLifecyclePort } from "../src/plugin-inventory-cli.js";

function item(identity: string, options: {
  catalog?: boolean; status?: PluginInventoryItem["outcome"] extends infer _T ? NonNullable<PluginInventoryItem["outcome"]>["status"] : never;
  diagnostics?: readonly PluginInventoryDiagnostic[]; description?: string; components?: number;
  installationRecords?: boolean; enablement?: boolean; runtime?: boolean;
} = {}): PluginInventoryItem {
  const [name, marketplace] = identity.split("@");
  const componentCount = options.components ?? 2;
  return {
    qualifiedIdentity: identity, lifecycleName: name!, marketplaceName: marketplace!, manifestNamespace: `ns-${name}`,
    catalogPresence: options.catalog ?? true,
    installations: options.installationRecords === false ? [] : [{ scope: "user", version: "1.2.3", validity: "valid", selected: true, location: { kind: "plugin-cache", display: `<plugin-cache>/${identity}` }, projectLocation: { kind: "project", display: "<project>" }, diagnostics: [], problems: [] }],
    ...(options.enablement === false ? {} : { enablement: { enabled: options.status !== "disabled", scope: "user" as const, source: { kind: "claude-user" as const, display: "<claude-user>/settings.json" } } }),
    ...(options.installationRecords === false ? {} : { selectedInstallation: { scope: "user" as const, version: "1.2.3", root: { kind: "plugin-cache" as const, display: `<plugin-cache>/${identity}/1.2.3` }, project: { kind: "project" as const, display: `<project>/packages/${name}` }, data: { kind: "plugin-data" as const, display: `<plugin-data>/${identity}` }, provenance: { state: { kind: "claude-user" as const, display: "<claude-user>/plugins/installed_plugins.json" }, stateVersion: 2 } } }),
    ...(options.runtime === false ? {} : { outcome: { status: options.status ?? "loaded", sharedStateCauses: [] } }),
    metadata: { manifestName: name!, version: "1.2.3", description: options.description ?? "safe description", keywords: [], components: [] },
    catalogDeclarations: [{
      source: { kind: "github" }, version: "2.0.0", revision: "rev-abc", revisionEvidence: "catalog-field", description: "catalog description", fieldProvenance: {},
      strict: { value: true, presence: "explicit", provenance: { source: { kind: "marketplace-cache", display: `<marketplace-cache>/${marketplace}/catalog.json` } } },
      defaultEnabled: { value: false, presence: "default", provenance: { source: { kind: "marketplace-cache", display: `<marketplace-cache>/${marketplace}/catalog.json` } } },
      provenance: { source: { kind: "marketplace-cache", display: `<marketplace-cache>/${marketplace}/catalog.json` }, scope: "user", origin: "catalog" }, runtimeEffect: "declared-not-effective",
    }],
    dependencies: Array.from({ length: 18 }, (_, index) => ({ origin: "catalog" as const, targetIdentity: `dependency${index}@${marketplace}`, version: `^${index}`, posture: "declared-not-effective", crossMarketplace: "same-marketplace", provenance: { source: { kind: "marketplace-cache" as const, display: `<marketplace-cache>/${marketplace}/catalog.json` }, field: "dependencies" } })),
    renames: [{ from: "old-name", target: name!, status: "current", posture: "declared-not-effective", provenance: { source: { kind: "marketplace-cache", display: `<marketplace-cache>/${marketplace}/catalog.json` }, field: "renames" } }],
    components: Array.from({ length: componentCount }, (_, index) => ({ origin: "selected-manifest" as const, kind: index % 2 ? "mcpServers" as const : "skills" as const, count: 1, countSemantics: "selected-manifest-declarations" as const, capabilityId: `plugin.component.${index}`, supportTier: index % 2 ? "not-supported" as const : "full" as const, executionRisk: index % 2 ? "unsupported-runtime" as const : "context" as const, provenance: { source: { kind: "plugin-cache" as const, display: `<plugin-cache>/${identity}/plugin.json` }, field: "components" } })),
    executionRisk: ["context", "unsupported-runtime"], diagnostics: options.diagnostics ?? [],
  };
}

function marketplace(name = "official"): PluginInventoryMarketplace {
  return { name, selected: true, validity: "valid", source: { kind: "github" }, origin: "primary", scope: "user", catalog: { kind: "marketplace-cache", display: `<marketplace-cache>/${name}/catalog.json` }, sourceProvenance: { source: { kind: "claude-user", display: "<claude-user>/known_marketplaces.json" } }, provenance: { source: { kind: "marketplace-cache", display: `<marketplace-cache>/${name}/catalog.json` } } };
}

function snapshot(options: {
  items?: readonly PluginInventoryItem[]; marketplaces?: readonly PluginInventoryMarketplace[]; diagnostics?: readonly PluginInventoryDiagnostic[];
  durableDesired?: PluginInventorySnapshot["durableDesired"]; omissions?: Readonly<Record<string, number>>; find?: (identity: string) => PluginInventoryItem | undefined;
} = {}): PluginInventorySnapshot {
  const items = options.items ?? [item("alpha@official"), item("alpha@community", { status: "rejected", diagnostics: [{ severity: "error", message: "load rejected" }] })];
  return {
    capturedAt: "2026-01-01T00:00:00.000Z", lifetime: "session", refreshGuidance: "session", installedStateStatus: "valid",
    items, marketplaces: options.marketplaces ?? [marketplace()], marketplaceCatalogs: [], allowlistObservations: [], conflictObservations: [],
    policyObservations: [{ kind: "strict", match: true, validScope: true, emptyLockdown: false, posture: "claude-lifecycle-observation-not-enforced", provenance: { source: { kind: "marketplace-cache", display: "<marketplace-cache>/official/policy.json" }, scope: "managed" } }],
    diagnostics: options.diagnostics ?? [], capabilityEvidence: [], omissions: options.omissions ?? {},
    ...(options.durableDesired === undefined ? {} : { durableDesired: options.durableDesired }),
    find: options.find ?? ((identity) => items.find((value) => value.qualifiedIdentity === identity)),
  };
}

const plainTheme = { fg: (_color: string, value: string) => value };
const output = (lines: readonly string[]): string => lines.join("\n");
const normalizedOutput = (lines: readonly string[]): string => output(lines).replace(/\s+/gu, " ");
function component(snap = snapshot(), options: { render?: typeof renderPluginInventory; requestRender?: () => void; done?: () => void; keybindings?: { matches(data: string, id: string): boolean }; onError?: (error: unknown) => void; lifecycle?: PluginLifecyclePort; lifecycleFactory?: () => Promise<{ ok: true; value: PluginLifecyclePort } | { ok: false; code: string; message: string }>; initialAction?: PluginInventoryActionName } = {}) {
  return new PluginInventoryFocusController({ snapshot: snap, tui: { requestRender: options.requestRender ?? (() => {}) }, theme: plainTheme, done: options.done ?? (() => {}), ...(options.keybindings === undefined ? {} : { keybindings: options.keybindings }), ...(options.render === undefined ? {} : { render: options.render }), ...(options.onError === undefined ? {} : { onError: options.onError }), ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }), ...(options.lifecycleFactory === undefined ? {} : { lifecycleFactory: options.lifecycleFactory }), ...(options.initialAction === undefined ? {} : { initialAction: options.initialAction }) });
}
function allDetail(model: PluginInventoryModel, width = 100): string {
  let result = renderPluginInventory(model.view(), { width, theme: plainTheme });
  const values = [output(result.lines)];
  for (let scroll = 1; scroll <= result.maxDetailScroll; scroll += 1) {
    model.setDetailScroll(scroll);
    result = renderPluginInventory(model.view(), { width, theme: plainTheme });
    values.push(output(result.lines));
  }
  return values.join("\n");
}

describe("plugin inventory focused UI", () => {
  it("owns exact membership for every tab, every empty state, and Errors semantics", () => {
    const values = [
      item("catalog-only@one", { catalog: true, components: 0, installationRecords: false, enablement: false, runtime: false }),
      item("installed@one", { catalog: false, status: "loaded", components: 0 }),
      item("unsupported-runtime@one", { catalog: false, status: "unsupported", components: 0 }),
      item("unsupported-component@one", { catalog: false, status: "loaded", components: 2 }),
      item("failed@one", { catalog: false, status: "blocked", components: 0 }),
      item("warned@one", { catalog: false, status: "loaded", components: 0, diagnostics: [{ severity: "warning", message: "warning" }] }),
      item("enabled-no-install@one", { catalog: false, components: 0, installationRecords: false, runtime: false }),
      item("runtime-no-install@one", { catalog: false, status: "loaded", components: 0, installationRecords: false, enablement: false }),
    ];
    const model = new PluginInventoryModel(snapshot({ items: values, diagnostics: [{ severity: "info", message: "global info" }] }));
    expect(model.view().rows.map((row) => row.identity)).toEqual(["catalog-only@one"]);
    model.moveView(1);
    expect(model.view().rows.map((row) => row.identity)).toEqual(["installed@one", "unsupported-runtime@one", "unsupported-component@one", "failed@one", "warned@one"]);
    model.moveView(1);
    expect(model.view().rows.map((row) => row.identity)).toEqual(["official"]);
    model.moveView(1);
    expect(model.view().rows.map((row) => row.kind === "plugin" ? row.identity : row.kind)).toEqual(["unsupported-runtime@one", "failed@one", "warned@one", "enabled-no-install@one", "runtime-no-install@one", "global-diagnostic"]);
    const supportColors: string[] = [];
    const installed = new PluginInventoryModel(snapshot({ items: [item("loaded-limited@one", { status: "loaded", components: 2 })] }));
    installed.setView(1);
    renderPluginInventory(installed.view(), { width: 120, theme: { fg(color: string, value: string) { supportColors.push(`${color}:${value}`); return value; } } });
    expect(supportColors.some((value) => value.startsWith("warning:") && value.includes("loaded") && value.includes("unsupported"))).toBe(true);
    const unsupportedColors: string[] = [];
    const unsupportedRuntime = new PluginInventoryModel(snapshot({ items: [item("runtime@one", { status: "unsupported", components: 0 })] }));
    unsupportedRuntime.setView(1);
    renderPluginInventory(unsupportedRuntime.view(), { width: 120, theme: { fg(color: string, value: string) { unsupportedColors.push(`${color}:${value}`); return value; } } });
    expect(unsupportedColors.some((value) => value.startsWith("error:") && value.includes("session outcome unsupported"))).toBe(true);
    for (const status of ["enabled-but-uninstalled", "ambiguous", "blocked", "malformed", "rejected"] as const) {
      const failedColors: string[] = [];
      const failedUnsupported = new PluginInventoryModel(snapshot({ items: [item(`${status}@one`, { status, components: 2 })] }));
      failedUnsupported.setView(1);
      renderPluginInventory(failedUnsupported.view(), { width: 160, theme: { fg(color: string, value: string) { failedColors.push(`${color}:${value}`); return value; } } });
      expect(failedColors.some((value) => value.startsWith("error:") && value.includes(`session outcome ${status}`) && value.includes("unsupported"))).toBe(true);
    }

    const empty = new PluginInventoryModel(snapshot({ items: [], marketplaces: [], diagnostics: [] }));
    for (const name of ["discover", "installed", "marketplaces", "errors"]) {
      expect(output(renderPluginInventory(empty.view(), { width: 80 }).lines)).toContain(`No ${name} entries`);
      empty.moveView(1);
    }
  });

  it("keeps framing/local-only truth, literal filtering, and exact same-name identities", () => {
    const model = new PluginInventoryModel(snapshot());
    model.moveSelection(1);
    model.appendFilter("ALPHA@");
    expect(model.view().rows.map((row) => row.identity)).toEqual(["alpha@official", "alpha@community"]);
    expect(model.view().selectedKey).toBe("plugin:alpha@community");
    model.appendFilter("[");
    const zero = output(renderPluginInventory(model.view(), { width: 90 }).lines);
    expect(zero).toContain("No matches for the active literal filter");
    expect(zero).toContain("read-only · captured for this session");
    expect(zero).toContain("run /reload-plugins in the interactive TUI");
    expect(zero).toMatch(/exit and relaunch\s+PiCC/);
    expect(zero).toContain("Local known catalogs/registrations only");
  });

  it("re-resolves plugins to the exact current object and marketplaces by their complete deterministic projection", () => {
    const staleItem = item("alpha@official", { description: "stale description" });
    const currentItem = item("alpha@official", { description: "current description" });
    const markets: PluginInventoryMarketplace[] = [marketplace("official")];
    const snap = snapshot({ items: [staleItem], marketplaces: markets, find: () => currentItem });
    const pluginModel = new PluginInventoryModel(snap);
    expect(pluginModel.enterDetail()).toBe("entered");
    const pluginTarget = pluginModel.view().detail;
    expect(pluginTarget?.kind === "plugin" ? pluginTarget.item : undefined).toBe(currentItem);
    expect(allDetail(pluginModel)).toContain("current description");
    expect(allDetail(pluginModel)).not.toContain("stale description");

    const marketModel = new PluginInventoryModel(snap);
    marketModel.setView(2);
    const key = marketModel.view().selectedKey;
    markets[0] = { ...markets[0]!, source: { ...markets[0]!.source } };
    expect(marketModel.view().selectedKey).toBe(key);
    expect(marketModel.enterDetail()).toBe("entered");
    const marketplaceTarget = marketModel.view().detail;
    expect(marketplaceTarget?.kind === "marketplace" ? marketplaceTarget.marketplace : undefined).toBe(markets[0]);
    markets[0] = { ...markets[0]!, fixtureContract: "fixture-derived-unverified", source: { ...markets[0]!.source, ref: "changed" },
      sourceProvenance: { source: { kind: "external", display: "<external>" }, scope: "project", origin: "registration", order: 2, field: "source", entryIndex: 3, itemIndex: 4, key: "official" },
      provenance: { source: { kind: "marketplace-cache", display: "<marketplace-cache>/changed.json" }, scope: "managed", origin: "changed", order: 5, field: "registration", entryIndex: 6, itemIndex: 7, key: "changed" } };
    marketModel.leaveDetail();
    expect(marketModel.enterDetail()).toBe("stale");
    marketModel.failDetail("official");
    expect(marketModel.view().warning).toContain("/plugin list, then /plugin details");

    const stalePlugin = new PluginInventoryModel(snapshot({ items: [staleItem], find: () => undefined }));
    expect(stalePlugin.enterDetail()).toBe("stale");
    stalePlugin.failDetail("alpha@official");
    expect(stalePlugin.view().warning).toContain("/plugin details alpha@official");
  });

  it("refuses marketplace actions when any visible registration or provenance field changes", () => {
    const rich: PluginInventoryMarketplace = {
      ...marketplace("rich"), fixtureContract: "fixture-derived-unverified", source: { kind: "github", repo: "owner/repo" },
      sourceProvenance: { source: { kind: "claude-user", display: "<claude-user>/known.json" }, scope: "user", origin: "source", order: 1, field: "source", entryIndex: 2, itemIndex: 3, key: "rich" },
      provenance: { source: { kind: "marketplace-cache", display: "<marketplace-cache>/rich/catalog.json" }, scope: "user", origin: "registration", order: 4, field: "registration", entryIndex: 5, itemIndex: 6, key: "rich" },
    };
    const visible = new PluginInventoryModel(snapshot({ marketplaces: [rich] }));
    visible.setView(2);
    expect(visible.enterDetail()).toBe("entered");
    const detail = allDetail(visible);
    for (const evidence of ["Fixture contract: fixture-derived-unverified", "kind=github", "repo=owner/repo", "scope user", "origin source", "order 1", "field source", "entry 2", "item 3", "key rich"]) expect(normalizedOutput(detail.split("\n"))).toContain(evidence);

    const provenanceChanges = (field: keyof NonNullable<PluginInventoryMarketplace["provenance"]>, changed: unknown) =>
      (value: PluginInventoryMarketplace): PluginInventoryMarketplace => ({ ...value, provenance: { ...value.provenance, [field]: changed } });
    const sourceProvenanceChanges = (field: keyof NonNullable<PluginInventoryMarketplace["sourceProvenance"]>, changed: unknown) =>
      (value: PluginInventoryMarketplace): PluginInventoryMarketplace => ({ ...value, sourceProvenance: { ...value.sourceProvenance, [field]: changed } });
    const changes: Array<(value: PluginInventoryMarketplace) => PluginInventoryMarketplace> = [
      (value) => ({ ...value, name: "changed" }), (value) => ({ ...value, selected: false }), (value) => ({ ...value, validity: "rejected" }),
      (value) => { const { fixtureContract: _fixtureContract, ...rest } = value; return rest; }, (value) => ({ ...value, scope: "project" }),
      (value) => ({ ...value, origin: "secondary" }), (value) => ({ ...value, catalog: { ...value.catalog!, kind: "external" } }),
      (value) => ({ ...value, catalog: { ...value.catalog!, display: "<external>" } }), (value) => ({ ...value, source: { ...value.source, repo: "changed/repo" } }),
      (value) => ({ ...value, sourceProvenance: { ...value.sourceProvenance, source: { ...value.sourceProvenance.source, kind: "external" } } }),
      (value) => ({ ...value, sourceProvenance: { ...value.sourceProvenance, source: { ...value.sourceProvenance.source, display: "<claude-user>/changed.json" } } }),
      sourceProvenanceChanges("scope", "project"), sourceProvenanceChanges("origin", "changed"), sourceProvenanceChanges("order", 99),
      sourceProvenanceChanges("field", "changed"), sourceProvenanceChanges("entryIndex", 99), sourceProvenanceChanges("itemIndex", 99), sourceProvenanceChanges("key", "changed"),
      (value) => ({ ...value, provenance: { ...value.provenance, source: { ...value.provenance.source, kind: "external" } } }),
      (value) => ({ ...value, provenance: { ...value.provenance, source: { ...value.provenance.source, display: "<external>" } } }),
      provenanceChanges("scope", "managed"), provenanceChanges("origin", "changed"), provenanceChanges("order", 99), provenanceChanges("field", "changed"),
      provenanceChanges("entryIndex", 99), provenanceChanges("itemIndex", 99), provenanceChanges("key", "changed"),
    ];
    for (const change of changes) {
      const registrations = [rich];
      const model = new PluginInventoryModel(snapshot({ marketplaces: registrations }));
      model.setView(2);
      registrations[0] = change(rich);
      expect(model.enterDetail()).toBe("stale");
    }
  });

  it("renders every plugin detail category with provenance, independent version/revision, and truthful caps", () => {
    const model = new PluginInventoryModel(snapshot({ items: [item("complete@official", { components: 20 })] }));
    expect(model.enterDetail()).toBe("entered");
    const detail = allDetail(model);
    for (const label of ["Description:", "Source:", "Version:", "Revision:", "Scope:", "Anchored location:", "Dependencies", "Renames", "Components:", "PiCC support:", "Execution risk:", "Policy:", "Diagnostics with provenance:", "Catalog declarations with provenance:"]) expect(detail).toContain(label);
    expect(detail).toContain("catalog 2.0.0");
    expect(detail).toContain("catalog rev-abc");
    expect(detail).toContain("origin catalog");
    expect(detail).toContain("qualification same-marketplace");
    expect(detail).toContain("source kind=github");
    expect(detail).toContain("selected-manifest/mcpServers");
    expect(detail).toContain("<plugin-cache>/complete@official/plugin.json");
    expect(detail).toContain("2 additional retained values are not expanded here; use /plugin details complete@official");
    expect(detail).toContain("4 additional retained values are not expanded here; use /plugin details complete@official");
    expect(detail).toContain("<plugin-cache>/complete@official/1.2.3");
  });

  it("renders benign structured URLs and redacts raw or encoded credential paths in details", () => {
    const withSource = (source: Readonly<Record<string, string>>): PluginInventoryItem => {
      const base = item("source@official");
      return { ...base, catalogDeclarations: base.catalogDeclarations.map((entry) => ({ ...entry, source })) };
    };
    const cases: ReadonlyArray<readonly [Readonly<Record<string, string>>, string]> = [
      [{ kind: "relative", value: "./plugins/safe" }, "source kind=relative, value=plugins/safe"],
      [{ kind: "git", url: "https://example.test/releases/safe?view=compact#current" }, "source kind=git, url=https://example.test/releases/safe"],
      [{ kind: "relative", value: "plugins/../private" }, "source kind=relative, value=<redacted>"],
      [{ kind: "relative", value: "plugins/%2574oken/value" }, "source kind=relative, value=<redacted>"],
      [{ kind: "git", url: "https://example.test/%EF%BD%81%EF%BD%90%EF%BD%89/%EF%BD%8B%EF%BD%85%EF%BD%99" }, "source kind=git, url=<redacted>"],
    ];
    for (const [source, expected] of cases) {
      const model = new PluginInventoryModel(snapshot({ items: [withSource(source)] }));
      expect(model.enterDetail()).toBe("entered");
      expect(allDetail(model)).toContain(expected);
    }
  });

  it("shows valid/invalid installation evidence independently from session outcome", () => {
    const base = item("invalid-only@official", { status: "blocked", components: 0 });
    const invalidOnly: PluginInventoryItem = { ...base, installations: [
      { scope: "project", version: "broken", validity: "invalid", selected: false, location: { kind: "external", display: "C:/unsafe/plugin" }, projectLocation: { kind: "project", display: "<project>/packages/broken" }, problems: ["missing-root"], diagnostics: [{ severity: "error", message: "invalid record" }] },
    ] };
    const model = new PluginInventoryModel(snapshot({ items: [invalidOnly] }));
    model.setView(1);
    const list = output(renderPluginInventory(model.view(), { width: 120, theme: plainTheme }).lines);
    expect(list).toContain("installation records 0 valid / 1 invalid");
    expect(list).toContain("session outcome blocked");
    expect(list).not.toContain("not installed");
    expect(model.enterDetail()).toBe("entered");
    const detail = allDetail(model);
    expect(detail).toContain("Installation records:");
    expect(detail).toContain("scope project · version broken · validity invalid · not selected");
    expect(normalizedOutput(detail.split("\n"))).toContain("location <external> · project <project>/packages/broken");
    expect(normalizedOutput(detail.split("\n"))).toContain("problems missing-root · diagnostics error:invalid record");
    expect(detail).toContain("Session outcome: blocked");
  });

  it("keeps list-window, local-cap, and snapshot-capture omission axes distinct in list and detail states", () => {
    const values = Array.from({ length: 520 }, (_, index) => item(`p${index}@official`, { components: 0 }));
    const model = new PluginInventoryModel(snapshot({ items: values, omissions: { "snapshot.diagnostics": 3, "snapshot.components": 2 } }));
    let rendered = output(renderPluginInventory(model.view(), { width: 100 }).lines);
    expect(rendered).toContain("retained rows below");
    expect(rendered).toContain("Local list cap: 8 retained rows are not shown");
    expect(rendered).toContain("Snapshot-capture evidence omissions: snapshot.components=2, snapshot.diagnostics=3");
    expect(model.enterDetail()).toBe("entered");
    expect(allDetail(model)).toContain("Snapshot-capture evidence omissions: snapshot.components=2, snapshot.diagnostics=3");
    model.leaveDetail();
    for (let index = 0; index < 10; index += 1) model.moveSelection(1);
    rendered = output(renderPluginInventory(model.view(), { width: 100 }).lines);
    expect(rendered).toContain("retained rows above");

    const empty = new PluginInventoryModel(snapshot({ items: [], marketplaces: [], omissions: { captured: 4 } }));
    expect(output(renderPluginInventory(empty.view(), { width: 80 }).lines)).toContain("Snapshot-capture evidence omissions: captured=4");
    empty.appendFilter("missing");
    expect(output(renderPluginInventory(empty.view(), { width: 80 }).lines)).toContain("Snapshot-capture evidence omissions: captured=4");
    empty.failSurface();
    const failed = output(renderPluginInventory(empty.view(), { width: 80 }).lines);
    expect(failed).toContain("Plugin inventory display failed");
    expect(failed).toContain("Snapshot-capture evidence omissions: captured=4");
  });

  it("uses structured global diagnostics, actionable /doctor details, and exact severity roles", () => {
    const calls: string[] = [];
    const theme = { fg(color: string, value: string) { calls.push(`${color}:${value}`); return value; } };
    const diagnostics: PluginInventoryDiagnostic[] = [
      { severity: "info", message: "error unsupported words are informational" },
      { severity: "warning", category: "managed-policy-unreadable", sourceClass: "system-file", impact: "source-ignored", message: "policy warning" },
      { severity: "error", category: "managed-policy-malformed", sourceClass: "override", impact: "source-ignored", message: "state failure" },
    ];
    const model = new PluginInventoryModel(snapshot({ items: [], marketplaces: [], diagnostics }));
    model.setView(3);
    renderPluginInventory(model.view(), { width: 120, theme });
    expect(calls.some((value) => value.startsWith("muted:") && value.includes("info · uncategorized"))).toBe(true);
    expect(calls.some((value) => value.startsWith("warning:") && value.includes("warning · managed-policy-unreadable"))).toBe(true);
    expect(calls.some((value) => value.startsWith("error:") && value.includes("error · managed-policy-malformed"))).toBe(true);
    model.moveSelection(1);
    expect(model.enterDetail()).toBe("entered");
    const detail = allDetail(model);
    expect(detail).toContain("Action: run /doctor");
    expect(detail).toContain("Administrator action may be required");
    expect(detail).toContain("Severity: warning");
    expect(detail).toContain("Source: system-file");
    expect(detail).toContain("Impact: source-ignored");
  });

  it("shows filterable unattributed lifecycle recovery rows without duplicating attributed operations", () => {
    const attributed = Object.freeze({ operationId: "attributed-operation", status: "pending" as const, semanticStep: "install; 1 committed step", target: "alpha@official", recoveryCommand: "picc plugin recover attributed-operation", category: "complete-or-rollback" as const });
    const pending = Object.freeze({ operationId: "unattributed-pending", status: "pending" as const, semanticStep: "refresh; 2 committed steps", recoveryCommand: "picc plugin recover unattributed-pending", category: "complete-or-rollback" as const });
    const failed = Object.freeze({ operationId: "unattributed-failed", outcome: "failed-before-commit" as const, semanticStep: "remove; failed-before-commit", target: "orphan target", recoveryCommand: "picc plugin recover unattributed-failed", category: "inspect" as const });
    const attributedMarketplace = { ...marketplace(), lifecycleOperations: [attributed] };
    const model = new PluginInventoryModel(snapshot({
      items: [], marketplaces: [attributedMarketplace],
      durableDesired: { pluginIdentities: [], marketplaceNames: [], pendingOperations: [attributed, pending], terminalOperations: [failed], retainedErrors: [], omissions: {} },
    }));
    model.setView(3);
    expect(model.view().rows.map((row) => row.identity)).toEqual(["Lifecycle · unattributed-pending", "Lifecycle · unattributed-failed"]);
    expect(model.view().rows.every(Object.isFrozen)).toBe(true);

    model.appendFilter("complete-or-rollback");
    expect(model.view().rows.map((row) => row.identity)).toEqual(["Lifecycle · unattributed-pending"]);
    expect(model.enterDetail()).toBe("entered");
    expect(Object.isFrozen(model.view().detail)).toBe(true);
    const detail = normalizedOutput(allDetail(model, 48).split("\n"));
    for (const evidence of ["Unattributed lifecycle evidence", "Operation id: unattributed-pending", "Semantic step: refresh; 2 committed steps", "Recovery category: complete-or-rollback", "Target: not attributed", "Observational recovery command: picc plugin recover unattributed-pending", "never invokes lifecycle recovery"]) expect(detail).toContain(evidence);

    model.leaveDetail();
    model.clearFilter();
    model.appendFilter("orphan target");
    expect(model.view().rows.map((row) => row.identity)).toEqual(["Lifecycle · unattributed-failed"]);
  });

  it("honors configured and raw keys, revision-only repaint, visible filter, and the Esc ladder", () => {
    const done = vi.fn();
    const requestRender = vi.fn();
    const c = component(snapshot(), { done, requestRender, keybindings: { matches: (data, id) => (data === "j" && id === "tui.select.down") || (data === "T" && id === "tui.input.tab") || (data === "E" && id === "tui.select.confirm") || (data === "Q" && id === "tui.select.cancel") } });
    c.handleInput("\u0001");
    c.handleInput("\u001b[A"); // already first
    expect(requestRender).toHaveBeenCalledTimes(0);
    c.handleInput("j");
    c.handleInput("\u001b[B");
    c.handleInput("\u001b[A");
    c.handleInput("T");
    c.handleInput("\u001b[D");
    c.handleInput("\u001b[C");
    c.handleInput("\u001b[Z");
    c.handleInput("alpha");
    c.handleInput("\u0008");
    expect(c.view().filter).toBe("alph");
    c.handleInput("E");
    expect(c.view().detail).toBeDefined();
    expect(output(c.render(80))).toContain("Active filter: alph");
    expect(output(c.render(80))).toContain("Esc leaves details · then Esc clears filter · then Esc closes");
    c.handleInput("\u001b[B");
    expect(c.view().detailScroll).toBe(1);
    c.handleInput("Q");
    expect(c.view().detail).toBeUndefined();
    expect(c.view().filter).toBe("alph");
    expect(output(c.render(80))).toContain("Filter: alph");
    c.handleInput("\u001b");
    expect(c.view().filter).toBe("");
    c.handleInput("\u001b");
    expect(done).toHaveBeenCalledOnce();
    expect(requestRender).toHaveBeenCalledTimes(12);
  });

  it("preserves canonical and credential-shaped qualified identities through every display width and secondary fallback", () => {
    const credentialIdentities = ["password@official", "api_key@official"];
    for (const credentialIdentity of credentialIdentities) {
      const credentialModel = new PluginInventoryModel(snapshot({ items: [item(credentialIdentity, { components: 0 })] }));
      for (const width of [12, 72, 120]) {
        const rendered = renderPluginInventory(credentialModel.view(), { width, theme: plainTheme });
        expect(output(rendered.lines).replace(/\n/gu, "")).toContain(credentialIdentity);
        if (width >= 72) {
          const identityLine = rendered.lines.find((line) => line.includes(credentialIdentity));
          expect(identityLine).toBe(`> ${credentialIdentity}`);
          expect(identityLine).not.toContain("installation records");
        }
      }
      expect(credentialModel.enterDetail()).toBe("entered");
      expect(allDetail(credentialModel, 120)).toContain(`Plugin: ${credentialIdentity}`);
    }
    const invalidModel = new PluginInventoryModel(snapshot({ items: [item("password/path@official", { components: 0 })] }));
    expect(output(renderPluginInventory(invalidModel.view(), { width: 120, theme: plainTheme }).lines)).toContain("unknown@unknown");
    expect(output(renderPluginInventory(invalidModel.view(), { width: 120, theme: plainTheme }).lines)).not.toContain("password/path");

    const identity = `${"p".repeat(190)}@${"m".repeat(65)}`;
    expect(identity).toHaveLength(256);
    const base = item(identity, { description: "Authorization Bearer SECRET" });
    const hostile: PluginInventoryItem = { ...base,
      selectedInstallation: base.selectedInstallation === undefined ? undefined : { ...base.selectedInstallation, root: { kind: "external", display: "C:/unsafe/secret" } },
    };
    const model = new PluginInventoryModel(snapshot({ items: [hostile] }));
    const hostileTheme = { fg: (_color: string, value: string) => `\u001b[31m${value}` };
    for (const width of [0, 1, 4, 12, 27, 47, 72, 120]) {
      const rendered = renderPluginInventory(model.view(), { width, theme: hostileTheme });
      for (const line of rendered.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      if (width >= 4) expect(output(rendered.lines)).toContain("PiCC");
      if (width >= 12) expect(normalizedOutput(rendered.lines)).toContain("/plugin list");
      if (width > 0 && width < 8) expect(output(rendered.lines).replace(/\n/gu, "")).toContain("unusable");
    }
    for (const width of [1, 4, 7]) {
      const lines = renderPluginInventory(model.view(), { width, theme: plainTheme }).lines;
      const reconstructed = lines.join("").replace(/\s+/gu, "");
      for (const signal of ["PiCCplugininventory", "read-onlysessionsnapshot", "widthunusable", "resizewider", "Esccloses"]) expect(reconstructed, `width ${width}`).toContain(signal);
      expect(reconstructed, `width ${width}`).not.toMatch(/Discover|Installed|Marketplaces|Errors|installation records|Filter:|←|Enter details|\/plugin list/u);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    for (const width of [12, 72, 120]) {
      const lines = renderPluginInventory(model.view(), { width, theme: plainTheme }).lines;
      const reconstructedIdentity = lines
        .map((line) => line.replace(/^>\s*/u, ""))
        .filter((line) => /^[pm@]+$/u.test(line))
        .join("");
      expect(reconstructedIdentity).toBe(identity);
    }
    expect(model.enterDetail()).toBe("entered");
    expect(model.view().detail?.identity).toBe(identity);
    const narrowDetail = output(renderPluginInventory(model.view(), { width: 24, theme: plainTheme }).lines);
    expect(narrowDetail.replace(/\n/gu, "")).toContain(identity);
    const detail = allDetail(model, 160);
    expect(detail).toContain("<redacted-field>");
    expect(normalizedOutput(detail.split("\n"))).toContain("root <external>");
    expect(detail).not.toContain("SECRET");
    expect(detail).not.toContain("C:/unsafe/secret");

    const fallback = component(snapshot({ items: [hostile] }), { render: () => { throw new Error("primary and secondary render failure"); } });
    fallback.handleInput("\r");
    const failed = output(fallback.render(18));
    expect(failed.replace(/\n/gu, "")).toContain(identity);
    expect(normalizedOutput(failed.split("\n"))).toContain("/plugin details");
    const laterListFailure = output(fallback.render(800));
    expect(laterListFailure).toContain("Plugin inventory display failed");
    expect(laterListFailure).not.toContain(identity);
    const wideFallback = component(snapshot({ items: [hostile] }), { render: () => { throw new Error("primary and secondary render failure"); } });
    wideFallback.handleInput("\r");
    expect(output(wideFallback.render(800))).toContain(`/plugin details ${identity}`);
    expect(normalizedOutput(failed.split("\n"))).toContain("display failed");
    expect(normalizedOutput(failed.split("\n"))).toContain("Esc closes");
    expect(failed).toContain("/plugin list");
    expect(failed).not.toContain("Renderer");
    expect(failed).not.toContain("/reload");
  });

  it("caches by width and state, while invalidate and state revisions force fresh rendering", () => {
    const spy = vi.fn(renderPluginInventory);
    const requestRender = vi.fn();
    const c = component(snapshot(), { render: spy, requestRender });
    expect(c.render(80)).toBe(c.render(80));
    expect(spy).toHaveBeenCalledTimes(1);
    c.render(81);
    expect(spy).toHaveBeenCalledTimes(2);
    c.invalidate();
    c.render(81);
    expect(spy).toHaveBeenCalledTimes(3);
    c.handleInput("x");
    expect(requestRender).toHaveBeenCalledOnce();
    c.render(81);
    expect(spy).toHaveBeenCalledTimes(4);
    expect(output(c.render(81))).toContain("Filter: x");
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("recovers detail/repaint faults from current render state only and retries close failure", () => {
    const errors: unknown[] = [];
    let failList = false;
    const renderer: typeof renderPluginInventory = (view, options) => {
      if (view.detail) throw new Error("detail fault");
      if (failList) throw new Error("later list fault");
      return renderPluginInventory(view, options);
    };
    const c = component(snapshot(), { render: renderer, onError: (error) => errors.push(error) });
    c.render(80);
    c.handleInput("\r");
    const recovered = output(c.render(80));
    expect(recovered.replace(/\s+/gu, " ")).toContain("/plugin details alpha@official");
    expect(c.view().detail).toBeUndefined();
    failList = true;
    c.invalidate();
    const laterFailure = output(c.render(80));
    expect(laterFailure).toContain("Plugin inventory display failed");
    expect(laterFailure).not.toContain("alpha@official");

    const repaint = component(snapshot(), { requestRender: () => { throw new Error("repaint fault"); }, onError: (error) => errors.push(error) });
    repaint.handleInput("x");
    expect(repaint.view().warning).toContain("/plugin list or /plugin details");
    expect(output(repaint.render(80))).toContain("Esc clear/close");

    const done = vi.fn().mockImplementationOnce(() => { throw new Error("close fault"); });
    const retry = component(snapshot(), { done, onError: (error) => errors.push(error) });
    retry.handleInput("\u001b");
    retry.handleInput("\u001b");
    expect(done).toHaveBeenCalledTimes(2);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("isolates unavailable/construction/initial/open/custom-promise/dispose faults and opener truth", async () => {
    expect(await openPluginInventory(snapshot(), { mode: "rpc", ui: { custom: vi.fn() } })).toEqual({ opened: false, reason: "unavailable" });
    expect(await openPluginInventory(snapshot(), { mode: "tui", ui: {} })).toEqual({ opened: false, reason: "unavailable" });
    expect(await openPluginInventory(snapshot(), { mode: "tui", ui: { custom() { throw new Error("construction"); } } })).toEqual({ opened: false, reason: "open-failed" });

    const errors: unknown[] = [];
    const opened = await openPluginInventory(snapshot(), { mode: "tui", ui: { custom(factory, options) {
      expect(options).toBeUndefined();
      const c = factory({ requestRender() {} }, plainTheme, undefined, () => {});
      expect(normalizedOutput(c.render(80))).toContain("Plugin inventory display failed. Esc closes. Use /plugin list, then /plugin details");
      const dispose = c.dispose.bind(c);
      c.dispose = () => { dispose(); throw new Error("dispose fault"); };
      return Promise.resolve();
    } } }, { render: () => { throw new Error("initial render fault"); }, onError: (error) => errors.push(error) });
    expect(opened).toEqual({ opened: true });
    expect(errors.map(String).join(" ")).toContain("initial render fault");
    expect(errors.map(String).join(" ")).toContain("dispose fault");

    let disposed = 0;
    const failed = await openPluginInventory(snapshot(), { mode: "tui", ui: { custom(factory) {
      const c = factory({}, plainTheme, undefined, () => {});
      const dispose = c.dispose.bind(c);
      c.dispose = () => { disposed += 1; dispose(); };
      return Promise.reject(new Error("custom promise fault"));
    } } });
    expect(failed).toEqual({ opened: false, reason: "open-failed" });
    expect(disposed).toBe(1);
  });

  it("passively renders lifecycle truth and scoped eligibility at normal and narrow widths", () => {
    const base = item("owned@official", { components: 0 });
    const lifecycleItem: PluginInventoryItem = { ...base, lifecycle: { ownership: "picc-owned", marketplaceOwnership: "picc-owned", candidates: [
      { mutableRecordKey: "owned@official\0picc-owned\0project\0profile-a\0checkout-a", scope: "project", ownership: "picc-owned", selected: false, installed: true, trusted: true },
      { mutableRecordKey: "owned@official\0picc-owned\0local\0profile-a\0checkout-a", scope: "local", ownership: "picc-owned", selected: false, installed: true, trusted: true },
    ], selectionRequired: true, selectionGuidance: "Select one exact writable scope", availableActions: [], installed: true, declared: false, effectiveEnabled: false, loaded: true, trusted: true, immutableRevision: "revision-with-a-very-long-value", integrity: `sha256:${"a".repeat(64)}`, defaultEnablementSource: "derived-owned-default", dependency: { state: "blocked", reason: "Dependency assembly decision: missing" }, readOnlyReason: "More than one writable scope is available", pendingStep: "update; 1 committed step", recoveryCategory: "complete-or-rollback", recoveryCommand: "picc plugin recover plugin_pending", lifecycleOperations: [{ operationId: "plugin_pending", status: "pending", semanticStep: "update; 1 committed step", target: "owned@official", recoveryCommand: "picc plugin recover plugin_pending", category: "complete-or-rollback" }], pendingReload: true, retainedErrors: ["Lifecycle update ended failed-before-commit"] } };
    const lifecycleMarketplace: PluginInventoryMarketplace = { ...marketplace("official"), pendingStep: "refresh; 0 committed steps", lifecycleOperations: [{ operationId: "market_failed", status: "failed-before-commit", semanticStep: "refresh; failed-before-commit", target: "official", recoveryCommand: "picc plugin recover market_failed", category: "inspect" }] };
    const snap = { ...snapshot({ items: [lifecycleItem], marketplaces: [lifecycleMarketplace] }), loadedGenerationId: "loaded-generation", durableDesired: { generationId: "desired-generation", pluginIdentities: ["owned@official"], marketplaceNames: ["official"], pendingOperations: [], terminalOperations: [], retainedErrors: [], omissions: {} } };
    const model = new PluginInventoryModel(snap); model.setView(1);
    const normal = output(renderPluginInventory(model.view(), { width: 120, theme: plainTheme }).lines);
    for (const truth of ["loaded loaded-generation", "desired desired-generation", "scope selection required", "eligibility none"]) expect(normal).toContain(truth);
    expect(model.enterDetail()).toBe("entered"); const detail = allDetail(model, 120);
    for (const truth of ["declared derived/default", "Dependency: blocked", "plugin_pending", "complete-or-rollback", "picc plugin recover plugin_pending", "Scoped lifecycle candidates", "Retained lifecycle failures", "Lifecycle update ended failed-before-commit"]) expect(detail).toContain(truth);
    model.leaveDetail(); model.setView(2); expect(model.enterDetail()).toBe("entered"); const marketDetail = allDetail(model, 120);
    for (const truth of ["market_failed", "refresh; failed-before-commit", "category inspect", "target official", "picc plugin recover market_failed"]) expect(marketDetail).toContain(truth);
    for (const width of [32, 18]) for (const line of renderPluginInventory(model.view(), { width, theme: plainTheme }).lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(normal).not.toContain("confirm");
  });

  it("drives typed preview, double-submit protection, cancellation propagation, receipt lookup, and fresh durable projection", async () => {
    const preview = { operationId: "plugin_ui_enable", action: "enable", pluginId: "alpha@official", scope: "user", mutableRecordKey: "record", profileKey: "profile-test", dependencies: { selected: { admitted: true, reasons: [] }, blocking: false, graph: [] }, executableComponents: [], removeDeclaration: false, removeData: false, participants: [], consequences: ["Enable the selected declaration"], confirmationDigest: `sha256:${"a".repeat(64)}` } as never;
    const receipt = { operationId: "plugin_ui_enable", action: "enable", pluginId: "alpha@official", outcome: "committed", completed: 1, summary: preview } as never;
    const desiredItem = { ...item("alpha@official"), lifecycle: { ownership: "picc-owned" as const, marketplaceOwnership: "picc-owned" as const, candidates: [], selectionRequired: false, availableActions: ["disable" as const], installed: true, declared: true, effectiveEnabled: true, loaded: false, trusted: true, dependency: { state: "satisfied" as const }, pendingReload: true, retainedErrors: [] } };
    const projection = snapshot({ items: [desiredItem], durableDesired: { generationId: "desired-new", pluginIdentities: ["alpha@official"], marketplaceNames: [], pendingOperations: [], terminalOperations: [], retainedErrors: [], omissions: {} } });
    let capturedSignal: AbortSignal | undefined; let executeCalls = 0; let lookupCalls = 0; let resolvePlan!: (value: any) => void; let blockPlan = false;
    const port = {
      marketplaces: { listStatus: () => ({ rows: [], omitted: 0, uncertain: false }), details: () => ({ ok: false, code: "unused", message: "unused" }), plan: async () => ({ ok: false, code: "unused", message: "unused" }), prepare: () => ({ ok: false, code: "unused", message: "unused" }), discardPreview: async () => ({ ok: true, value: undefined }) },
      plugins: { list: () => [], details: () => ({ ok: false, code: "unused", message: "unused" }), plan: async (_operation: unknown, signal?: AbortSignal) => { capturedSignal = signal; return blockPlan ? new Promise((resolve) => { resolvePlan = resolve; }) : { ok: true, value: preview }; }, execute: async () => { executeCalls += 1; return { ok: true, value: receipt }; }, discardPreview: async () => ({ ok: true, value: undefined }) },
      recovery: { list: () => [], preview: async () => ({ ok: false, code: "unused", message: "unused" }), recover: async () => ({ ok: false, code: "unused", message: "unused" }) },
      targets: { plugin: () => ({ ok: false, code: "unused", message: "unused" }), marketplace: () => ({ ok: false, code: "unused", message: "unused" }) },
      lookup: async () => { lookupCalls += 1; return { ok: true, value: { state: "terminal", receipt } }; }, projection: () => ({ ok: true, value: projection }),
    } as PluginLifecyclePort;
    let failReceiptRender = false;
    const renderer: typeof renderPluginInventory = (view, options) => { if (failReceiptRender && view.workflow?.phase === "receipt") throw new Error("receipt renderer"); return renderPluginInventory(view, options); };
    const c = component(snapshot({ items: [item("alpha@official")] }), { lifecycle: port, initialAction: "enable", render: renderer });
    c.handleInput("\r"); c.handleInput("alpha@official"); c.handleInput("\r");
    await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("preview"));
    expect(c.render(54).join("\n")).toContain("Operation id: plugin_ui_enable");
    c.handleInput("\r");
    expect(c.render(54).join("\n")).toContain("Final confirmation");
    c.handleInput("\r");
    await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("receipt"));
    expect(executeCalls).toBe(1);
    expect(c.view().durableDesired.durableDesired?.generationId).toBe("desired-new");
    expect(c.view().durableDesired.find("alpha@official")?.outcome?.status).toBe("loaded");
    failReceiptRender = true; c.invalidate(); c.render(80);
    await vi.waitFor(() => expect(lookupCalls).toBeGreaterThan(0));

    blockPlan = true;
    const cancelled = component(snapshot(), { lifecycle: port, initialAction: "enable" });
    cancelled.handleInput("\r"); cancelled.handleInput("alpha@official"); cancelled.handleInput("\r");
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    cancelled.handleInput("\u001b");
    expect(capturedSignal?.aborted).toBe(true);
    resolvePlan({ ok: false, code: "cancelled", message: "cancelled" });
    await vi.waitFor(() => expect(cancelled.view().workflow).toBeUndefined());
  });

  it("retains execution authority through progress renderer failure and Esc", async () => {
    const operationId = "plugin_render_flight"; const preview = { operationId, action: "enable", pluginId: "alpha@official", scope: "user", mutableRecordKey: "record", profileKey: "profile-test", dependencies: { selected: { admitted: true, reasons: [] }, blocking: false, graph: [] }, executableComponents: [], removeDeclaration: false, removeData: false, participants: [], consequences: ["enable"], confirmationDigest: `sha256:${"a".repeat(64)}` } as never;
    const receipt = { operationId, action: "enable", pluginId: "alpha@official", outcome: "committed", completed: 1, summary: preview } as never;
    let resolveExecute!: (value: unknown) => void; let lookups = 0;
    const execution = new Promise((resolve) => { resolveExecute = resolve; });
    const port = { marketplaces: {}, plugins: { plan: async () => ({ ok: true, value: preview }), execute: async () => execution, discardPreview: async () => ({ ok: true, value: undefined }) }, recovery: {}, targets: {}, lookup: async () => { lookups += 1; return { ok: true, value: { state: "terminal", receipt } }; }, projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
    const renderer: typeof renderPluginInventory = (view, options) => { if (view.workflow?.phase === "progress") throw new Error("progress renderer failed"); return renderPluginInventory(view, options); };
    const c = component(snapshot(), { lifecycle: port, initialAction: "enable", render: renderer }); c.handleInput("\r"); c.handleInput("alpha@official"); c.handleInput("\r"); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("preview")); c.render(72); c.handleInput("\r"); c.render(72); c.handleInput("\r"); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("progress")); c.render(72);
    await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("terminal-fallback")); c.handleInput("\u001b"); expect(c.view().workflow).toMatchObject({ phase: "terminal-fallback", message: expect.stringContaining("Esc intent was recorded locally") });
    resolveExecute({ ok: true, value: receipt }); await vi.waitFor(() => expect(lookups).toBeGreaterThan(0)); const terminal = c.view().workflow; expect(terminal && "operationId" in terminal ? terminal.operationId : undefined).toBe(operationId); const truth = terminal?.phase === "receipt" ? terminal.receipt.outcome : terminal?.phase === "terminal-fallback" ? terminal.message : ""; expect(truth).toContain("committed"); expect(lookups).toBeGreaterThan(0);
  });

  it("keeps global marketplace add targetless on managed/imported rows before planning", () => {
    for (const ownership of ["managed", "claude-imported-readonly"] as const) {
      let compositions = 0; const selected = { ...marketplace("official"), ownership, availableActions: [] as const };
      const c = component(snapshot({ marketplaces: [selected] }), { lifecycleFactory: async () => { compositions += 1; return { ok: false, code: "unused", message: "unused" }; } }); c.handleInput("\u001b[C"); c.handleInput("\u001b[C"); c.handleInput("A");
      expect(c.view().workflow).toMatchObject({ phase: "select-action", actions: ["marketplace-add"] }); expect((c.view().workflow as { target?: unknown }).target).toBeUndefined(); c.handleInput("\r"); expect(c.view().workflow).toMatchObject({ phase: "input", action: "marketplace-add", field: "marketplace name" }); expect(compositions).toBe(0);
    }
  });

  it("keeps direct targets private, supports editable acknowledgement input, and invalidates delayed composition on Esc/dispose", async () => {
    const direct = component(snapshot(), { initialAction: "enable" });
    expect(direct.view().workflow).toMatchObject({ phase: "select-action" });
    expect((direct.view().workflow as { target?: unknown }).target).toBeUndefined();

    let factoryCalls = 0; let planCalls = 0; let resolveFactory!: (value: { ok: true; value: PluginLifecyclePort }) => void;
    const port = { marketplaces: {}, plugins: { plan: async () => { planCalls += 1; return { ok: false, code: "unused", message: "unused" }; } }, recovery: {}, targets: {}, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
    const delayed = component(snapshot(), { initialAction: "enable", lifecycleFactory: () => { factoryCalls += 1; return new Promise((resolve) => { resolveFactory = resolve; }); } });
    delayed.handleInput("\r"); delayed.handleInput("alpha@official"); delayed.handleInput("\r");
    await vi.waitFor(() => expect(factoryCalls).toBe(1));
    delayed.handleInput("\u001b"); resolveFactory({ ok: true, value: port });
    await vi.waitFor(() => expect(delayed.view().workflow).toBeUndefined()); expect(planCalls).toBe(0);

    let removeCompositions = 0;
    const remove = component(snapshot(), { initialAction: "marketplace-remove", lifecycleFactory: async () => { removeCompositions += 1; return { ok: false, code: "fixture", message: "secret detail" }; } });
    remove.handleInput("\r"); remove.handleInput("official"); remove.handleInput("\r"); remove.handleInput("no"); remove.handleInput("\r");
    expect(remove.view().workflow).toMatchObject({ phase: "input", field: "preserve installed acknowledgement" }); expect(output(remove.render(70))).toContain("Invalid preserve installed acknowledgement"); expect(removeCompositions).toBe(0);
    remove.handleInput("\u007f"); remove.handleInput("\u007f"); remove.handleInput("yes"); remove.handleInput("\r");
    await vi.waitFor(() => expect(removeCompositions).toBe(1)); await vi.waitFor(() => expect(remove.view().workflow?.phase).toBe("failed")); expect(JSON.stringify(remove.view())).not.toContain("secret detail");

    let disposedFactory!: (value: { ok: true; value: PluginLifecyclePort }) => void;
    const disposed = component(snapshot(), { initialAction: "enable", lifecycleFactory: () => new Promise((resolve) => { disposedFactory = resolve; }) });
    disposed.handleInput("\r"); disposed.handleInput("alpha@official"); disposed.handleInput("\r"); disposed.dispose(); disposedFactory({ ok: true, value: port }); await Promise.resolve(); expect(planCalls).toBe(0);
  });

  it("binds duplicate candidates through the shared exact-selector authority and refuses stale records", async () => {
    const base = item("alpha@official"); const owned = { ...base, lifecycle: { ownership: "picc-owned" as const, candidates: [{ mutableRecordKey: "record-user", scope: "user", ownership: "picc-owned" as const, selected: false, installed: true }, { mutableRecordKey: "record-local", scope: "local", ownership: "picc-owned" as const, selected: false, installed: true }], selectionRequired: true, availableActions: [] as const, installed: true, loaded: true, dependency: { state: "satisfied" as const }, pendingReload: false, retainedErrors: [] } };
    const preview = { operationId: "plugin_exact", action: "enable", pluginId: "alpha@official", scope: "local", mutableRecordKey: "record-local", profileKey: "profile-test", dependencies: { selected: { admitted: true, reasons: [] }, blocking: false, graph: [] }, executableComponents: [], removeDeclaration: false, removeData: false, participants: [], consequences: ["enable"], confirmationDigest: `sha256:${"a".repeat(64)}` } as never;
    let operation: any; let resolvedKey: string | undefined;
    const exact = { kind: "plugin" as const, identity: "alpha@official", scope: "local", mutableRecordKey: "record-local", selector: "selector-local" };
    const port = { marketplaces: {}, plugins: { plan: async (value: unknown) => { operation = value; return { ok: true, value: preview }; }, discardPreview: async () => ({ ok: true, value: undefined }) }, recovery: {}, targets: { plugin: (_identity: string, key: string) => { resolvedKey = key; return key === "record-local" ? { ok: true, value: exact } : { ok: false, code: "stale-selector", message: "stale" }; }, marketplace: () => ({ ok: false, code: "unused", message: "unused" }) }, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
    const c = component(snapshot({ items: [owned] }), { lifecycle: port, initialAction: "enable" }); c.handleInput("\r"); c.handleInput("alpha@official"); c.handleInput("\r"); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("select-candidate")); c.handleInput("\u001b[B"); c.handleInput("\r"); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("preview")); expect(resolvedKey).toBe("record-local"); expect(operation.flags.selector).toBe("selector-local"); expect(normalizedOutput(c.render(90))).toContain("selector fingerprint");

    let stalePlans = 0; const stalePort = { ...port, plugins: { ...port.plugins, plan: async () => { stalePlans += 1; return { ok: true, value: preview }; } }, targets: { ...port.targets, plugin: () => ({ ok: false, code: "stale-selector", message: "stale" }) } } as unknown as PluginLifecyclePort;
    const stale = component(snapshot({ items: [owned] }), { lifecycle: stalePort, initialAction: "enable" }); stale.handleInput("\r"); stale.handleInput("alpha@official"); stale.handleInput("\r"); await vi.waitFor(() => expect(stale.view().workflow?.phase).toBe("select-candidate")); stale.handleInput("\r"); await vi.waitFor(() => expect(stale.view().workflow?.phase).toBe("failed")); expect(stalePlans).toBe(0); expect(output(stale.render(72))).toContain("target changed");
  });

  it("projects scope/profile/checkout and complete local source authority without raw keys or paths", async () => {
    const rendered: string[] = [];
    for (const [scope, sourceValue] of [["user", "/first/same"], ["project", "/second/same"], ["local", "/third/same"]] as const) {
      const port = { marketplaces: { plan: async (operation: any) => ({ ok: true, value: { operationId: `market_${scope}`, action: "add", registration: { name: operation.name, scope, profileKey: "profile-secret-key", ...(scope === "user" ? {} : { checkoutFamilyKey: "checkout-secret-key", projectKey: "checkout-secret-key" }), source: { kind: "local-directory", path: operation.sourceValue } }, snapshot: { snapshotId: `marketplace-${scope}`, catalogDigest: `sha256:${"b".repeat(64)}`, trust: { targetDigest: `sha256:${"c".repeat(64)}` } }, catalog: { plugins: [], omittedEntries: 0 }, stateFingerprint: `sha256:${"d".repeat(64)}`, settingsFingerprint: `sha256:${"e".repeat(64)}`, settingsEffect: { requested: true, effective: true }, acknowledgement: "preserve-installations", dependents: [], participants: [], consequences: ["add"] } }), discardPreview: async () => ({ ok: true, value: undefined }) }, plugins: {}, recovery: {}, targets: {}, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
      const c = component(snapshot(), { lifecycle: port, initialAction: "marketplace-add" }); c.handleInput("\r"); for (const value of ["new-market", "local-directory", sourceValue, scope]) { c.handleInput(value); c.handleInput("\r"); } await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("preview")); const text = normalizedOutput(c.render(120)); rendered.push(text); const sourceFingerprint = createHash("sha256").update(JSON.stringify({ kind: "local-directory", path: sourceValue }), "utf8").digest("hex").slice(0, 16); expect(text).toContain(`local-directory basename same · full authority ${sourceFingerprint}`); expect(text).toContain(`requested scope ${scope}`); expect(text).toMatch(/profile [a-f0-9]{16}/u); expect(text).toContain(scope === "user" ? "checkout user-global" : "checkout "); expect(text).not.toContain("profile-secret-key"); expect(text).not.toContain("checkout-secret-key"); expect(text).not.toContain(sourceValue); expect(c.view().workflow).toMatchObject({ confirmationEnabled: true });
    }
    expect(new Set(rendered).size).toBe(3);
    const incompletePort = { marketplaces: { plan: async () => ({ ok: true, value: { operationId: "market_incomplete", action: "add", registration: { name: "new-market", scope: "project", profileKey: "profile-secret-key", source: { kind: "local-directory", path: "/fourth/same" } }, snapshot: { snapshotId: "marketplace-incomplete", catalogDigest: `sha256:${"b".repeat(64)}`, trust: { targetDigest: `sha256:${"c".repeat(64)}` } }, catalog: { plugins: [], omittedEntries: 0 }, stateFingerprint: `sha256:${"d".repeat(64)}`, settingsFingerprint: `sha256:${"e".repeat(64)}`, settingsEffect: { requested: true, effective: true }, acknowledgement: "preserve-installations", dependents: [], participants: [], consequences: ["add"] } }), discardPreview: async () => ({ ok: true, value: undefined }) }, plugins: {}, recovery: {}, targets: {}, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
    const incomplete = component(snapshot(), { lifecycle: incompletePort, initialAction: "marketplace-add" }); incomplete.handleInput("\r"); for (const value of ["new-market", "local-directory", "/fourth/same", "project"]) { incomplete.handleInput(value); incomplete.handleInput("\r"); } await vi.waitFor(() => expect(incomplete.view().workflow?.phase).toBe("preview")); expect(incomplete.view().workflow).toMatchObject({ confirmationEnabled: false, projection: { omissions: 1 } });
  });

  it("keeps raw producer previews out of view and requires exact rendered confirmation attestation", async () => {
    const preview = { operationId: "plugin_attested", action: "enable", pluginId: "alpha@official", scope: "user", mutableRecordKey: "record", profileKey: "profile-test", requestedSource: { kind: "https-git", url: "https://user:password@example.com/private.git" }, dependencies: { selected: { admitted: true, reasons: [] }, blocking: false, graph: [] }, executableComponents: ["skill"], removeDeclaration: false, removeData: false, participants: [], consequences: ["Enable exact record"], confirmationDigest: `sha256:${"a".repeat(64)}` } as never;
    let executes = 0; let discards = 0;
    const port = { marketplaces: {}, plugins: { plan: async () => ({ ok: true, value: preview }), execute: async () => { executes += 1; return { ok: false, code: "unused", message: "unused" }; }, discardPreview: async () => { discards += 1; return { ok: true, value: undefined }; } }, recovery: {}, targets: { plugin: () => ({ ok: false, code: "unused", message: "unused" }), marketplace: () => ({ ok: false, code: "unused", message: "unused" }) }, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
    const c = component(snapshot(), { lifecycle: port, initialAction: "enable" }); c.handleInput("\r"); c.handleInput("alpha@official"); c.handleInput("\r"); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("preview"));
    expect(JSON.stringify(c.view())).not.toMatch(/password|requestedSource|confirmationDigest/u); const projected = normalizedOutput(c.render(72)); expect(projected).toContain("https-git host example.com · full authority"); expect(projected).toContain("requested scope user"); expect(projected).toMatch(/profile [a-f0-9]{16}/u);
    c.handleInput("\r"); expect(c.view().workflow?.phase).toBe("confirmation"); c.invalidate(); c.handleInput("\r"); await vi.waitFor(() => expect(discards).toBe(1)); expect(executes).toBe(0); expect(c.view().workflow?.phase).toBe("failed");

    const narrow = component(snapshot(), { lifecycle: port, initialAction: "enable" }); narrow.handleInput("\r"); narrow.handleInput("alpha@official"); narrow.handleInput("\r"); await vi.waitFor(() => expect(narrow.view().workflow?.phase).toBe("preview")); expect(narrow.render(7).join("\n")).toContain("Resize"); expect(discards).toBe(1); expect(executes).toBe(0); expect(narrow.view().workflow?.phase).toBe("preview");
  });

  it("keeps one loaded snapshot fixed across the stateful add-install-disable-enable-update-uninstall-recovery chain", async () => {
    const catalogOnly = item("alpha@official", { installationRecords: false, enablement: false, runtime: false });
    const loaded = snapshot({ items: [catalogOnly], marketplaces: [] });
    const market = { ...marketplace(), ownership: "picc-owned" as const, mutableRecordKey: "market-user", candidates: [{ mutableRecordKey: "market-user", scope: "user" as const, selected: true, trusted: true }], availableActions: ["refresh", "remove"] as const };
    const desiredItem = (action: "install" | "disable" | "enable" | "update" | "uninstall", installed: boolean): PluginInventoryItem => ({
      ...catalogOnly,
      installations: installed ? item("alpha@official").installations : [],
      lifecycle: {
        ownership: "picc-owned", marketplaceOwnership: "picc-owned",
        candidates: installed ? [{ mutableRecordKey: "record-user", scope: "user", ownership: "picc-owned", selected: true, installed: true }] : [],
        availableActions: [action], installed, declared: installed, effectiveEnabled: action !== "enable" && installed,
        loaded: false, trusted: true, dependency: { state: "satisfied" }, pendingReload: installed, retainedErrors: [],
      },
    });
    const projection = (generation: string, action: "install" | "disable" | "enable" | "update" | "uninstall", installed: boolean, pending = false) => snapshot({
      items: [desiredItem(action, installed)], marketplaces: [market],
      durableDesired: {
        generationId: generation, pluginIdentities: installed ? ["alpha@official"] : [], marketplaceNames: ["official"],
        pendingOperations: pending ? [{ operationId: "plugin_pending", status: "pending", semanticStep: "uninstall", target: "alpha@official", recoveryCommand: "picc plugin recover plugin_pending", category: "complete-or-rollback" }] : [],
        terminalOperations: [], retainedErrors: [], omissions: {},
      },
    });
    const projections = [
      projection("desired-added", "install", false), projection("desired-installed", "disable", true),
      projection("desired-disabled", "enable", true), projection("desired-enabled", "update", true),
      projection("desired-updated", "uninstall", true), projection("desired-uninstalled", "install", false, true),
      projection("desired-recovered", "install", false),
    ];
    let stage = 0;
    const plans: string[] = [];
    const executions: string[] = [];
    const pluginPreview = (action: "install" | "disable" | "enable" | "update" | "uninstall") => ({
      operationId: `plugin_${action}`, action, pluginId: "alpha@official", scope: "user", mutableRecordKey: action === "install" ? undefined : "record-user", profileKey: "profile-test",
      dependencies: { selected: { admitted: true, reasons: [] }, blocking: false, graph: [] }, executableComponents: ["skills"], removeDeclaration: action === "uninstall", removeData: false,
      participants: [], consequences: [`${action} alpha@official`], confirmationDigest: `sha256:${"a".repeat(64)}`,
    }) as never;
    const marketplacePreview = { operationId: "marketplace_add", action: "add", registration: { name: "official", scope: "user", profileKey: "profile-test", source: { kind: "https-git", url: "https://example.test/catalog.git" } }, snapshot: { snapshotId: "catalog-snapshot", catalogDigest: "sha256:catalog", trust: { targetDigest: "sha256:catalog" } }, catalog: { plugins: [{ name: "alpha", supported: true, sourceKind: "https-git" }], omittedEntries: 0 }, stateFingerprint: "state-before", settingsFingerprint: "settings-before", settingsEffect: { requested: "registered", effective: "registered" }, acknowledgement: "preserve-installations", dependents: [], participants: [], consequences: ["add official"], confirmationDigest: `sha256:${"b".repeat(64)}` } as never;
    const recoverySummary = { pluginId: "alpha@official", scope: "user", profileKey: "profile-test", dependencies: { selected: { admitted: true, reasons: [] }, graph: [], decisions: [] }, executableComponents: [], participants: [], consequences: ["complete uninstall"], removeDeclaration: true, removeData: false };
    const recoveryPreview = { operationId: "plugin_pending", producerSchema: "plugin-lifecycle", producerVersion: 1, confirmationDigest: `sha256:${"c".repeat(64)}`, planDigest: `sha256:${"d".repeat(64)}`, completed: 1, remaining: 1, rolledBack: 0, actions: ["complete"] as const, confirmationSummary: recoverySummary } as never;
    const port: PluginLifecyclePort = {
      marketplaces: {
        listStatus: () => ({ rows: [], omitted: 0, uncertain: false }), details: () => ({ ok: false, code: "unused", message: "unused" }),
        plan: async (operation) => { expect(stage).toBe(0); expect(operation).toMatchObject({ kind: "marketplace-add", name: "official", sourceValue: "https://user:secret@example.test/catalog.git" }); plans.push(operation.kind); return { ok: true, value: marketplacePreview }; },
        prepare: (preview) => ({ ok: true, value: { preview, execute: async () => { expect(stage).toBe(0); executions.push("marketplace-add"); stage += 1; return { ok: true, value: { operationId: "marketplace_add", outcome: "committed", completed: 1, summary: marketplacePreview } as never }; } } }),
        discardPreview: async () => ({ ok: true, value: undefined }),
      },
      plugins: {
        list: () => [], details: () => ({ ok: false, code: "unused", message: "unused" }),
        plan: async (operation) => {
          const expected = ["install", "disable", "enable", "update", "uninstall"][stage - 1]; expect(operation.kind).toBe(expected);
          expect(operation.qualifiedIdentity).toBe("alpha@official");
          if (operation.kind === "install") expect(operation.flags.marketplaceSelector).toBe("market-selector");
          else { expect(operation.flags.selector).toBe("plugin-selector"); if (operation.kind === "update") expect(operation.flags.marketplaceSelector).toBe("market-selector"); }
          plans.push(operation.kind); return { ok: true, value: pluginPreview(operation.kind) };
        },
        execute: async (preview) => { const expected = ["install", "disable", "enable", "update", "uninstall"][stage - 1]; expect(preview.action).toBe(expected); executions.push(preview.action); stage += 1; return { ok: true, value: { operationId: `plugin_${preview.action}`, action: preview.action, pluginId: "alpha@official", outcome: "committed", completed: 1, summary: preview } as never }; },
        discardPreview: async () => ({ ok: true, value: undefined }),
      },
      recovery: {
        list: () => [{ operationId: "plugin_pending", status: "pending" }],
        preview: async (operationId: string) => { expect(stage).toBe(6); expect(operationId).toBe("plugin_pending"); plans.push("recover"); return { ok: true, value: recoveryPreview }; },
        recover: async (operationId, action) => { expect(operationId).toBe("plugin_pending"); expect(action).toBe("complete"); executions.push("recover"); stage += 1; return { ok: true, value: { operationId, producerSchema: "plugin-lifecycle", outcome: "committed", completed: 2, summary: recoverySummary } as never }; },
      },
      targets: {
        plugin: (identity: string, key: string) => { expect(identity).toBe("alpha@official"); expect(key).toBe("record-user"); return { ok: true, value: { kind: "plugin", identity, scope: "user", mutableRecordKey: key, selector: "plugin-selector" } }; },
        marketplace: (identity: string, key: string) => { expect(identity).toBe("official"); expect(key).toBe("market-user"); return { ok: true, value: { kind: "marketplace", identity, scope: "user", mutableRecordKey: key, selector: "market-selector" } }; },
      },
      lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: projections[stage - 1]! }),
    };
    const c = component(loaded, { lifecycle: port, initialAction: "marketplace-add" });
    const enter = (value?: string) => { if (value !== undefined) c.handleInput(value); c.handleInput("\r"); };
    const confirm = async (operationId: string) => {
      await vi.waitFor(() => expect(c.view().workflow).toMatchObject({ phase: "preview", operationId }));
      expect(output(c.render(78))).toContain(`Operation id: ${operationId}`); c.handleInput("\r");
      expect(c.view().workflow?.phase).toBe("confirmation"); expect(output(c.render(78))).toContain("Final confirmation"); c.handleInput("\r");
      await vi.waitFor(() => expect(c.view().workflow).toMatchObject({ phase: "receipt", operationId })); expect(output(c.render(78))).toContain("lifecycle receipt");
      expect(c.view().loadedSnapshot).toBe(loaded); expect(c.view().loadedSnapshot.find("alpha@official")?.outcome).toBeUndefined();
    };
    const selectNext = (action: string) => { c.handleInput("\r"); c.handleInput("A"); expect(c.view().workflow).toMatchObject({ phase: "select-action", actions: [action] }); c.handleInput("\r"); };

    c.handleInput("\r"); enter("official"); enter("https-git"); enter("https://user:secret@example.test/catalog.git"); enter("user");
    await confirm("marketplace_add"); expect(JSON.stringify(c.view())).not.toMatch(/user:secret/u);
    selectNext("install"); enter("alpha@official"); enter("user"); await confirm("plugin_install");
    selectNext("disable"); await confirm("plugin_disable");
    selectNext("enable"); await confirm("plugin_enable");
    selectNext("update"); await confirm("plugin_update");
    selectNext("uninstall"); enter("yes"); enter("no"); await confirm("plugin_uninstall");

    c.handleInput("\r"); c.handleInput("\u001b[D");
    expect(c.view().rows[c.view().selectedIndex]).toMatchObject({ kind: "global-lifecycle", operation: { operationId: "plugin_pending" } });
    c.handleInput("A"); expect(c.view().workflow).toMatchObject({ phase: "select-action", actions: ["recover"], target: { kind: "recovery", identity: "plugin_pending" } }); c.handleInput("\r"); enter("complete");
    await confirm("plugin_pending");
    expect(plans).toEqual(["marketplace-add", "install", "disable", "enable", "update", "uninstall", "recover"]);
    expect(executions).toEqual(plans); expect(stage).toBe(7); expect(c.view().durableDesired.durableDesired?.generationId).toBe("desired-recovered");
  });

  it("disables confirmation for every oversized required plugin evidence family and long scalar", async () => {
    const base = { operationId: "plugin_omission", action: "enable", pluginId: "alpha@official", scope: "user", mutableRecordKey: "record", profileKey: "profile-test", immutableRevision: "rev", dependencies: { selected: { admitted: true, reasons: [] as string[] }, blocking: false, graph: [] as unknown[], decisions: [] as unknown[] }, executableComponents: [] as string[], removeDeclaration: false, removeData: false, participants: [] as unknown[], consequences: ["change"] as string[], confirmationDigest: `sha256:${"a".repeat(64)}` };
    const many = Array.from({ length: 129 }, (_, index) => `value-${index}`); const variants = [
      { ...base, executableComponents: many }, { ...base, dependencies: { ...base.dependencies, selected: { admitted: true, reasons: many } } }, { ...base, dependencies: { ...base.dependencies, graph: many } }, { ...base, dependencies: { ...base.dependencies, decisions: many } }, { ...base, participants: many }, { ...base, consequences: many }, { ...base, immutableRevision: "x".repeat(321) },
    ];
    for (const preview of variants) {
      const port = { marketplaces: {}, plugins: { plan: async () => ({ ok: true, value: preview }), discardPreview: async () => ({ ok: true, value: undefined }) }, recovery: {}, targets: {}, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
      const c = component(snapshot(), { lifecycle: port, initialAction: "enable" }); c.handleInput("\r"); c.handleInput("alpha@official"); c.handleInput("\r"); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("preview")); expect(c.view().workflow).toMatchObject({ confirmationEnabled: false, projection: { omissions: expect.any(Number) } }); expect((c.view().workflow as any).projection.omissions).toBeGreaterThan(0); c.handleInput("\u001b");
    }
  });

  it.each(["marketplace-refresh", "marketplace-remove"] as const)("drives %s through exact plan, rendered confirmations, execution, and receipt", async (action) => {
    const selected = { ...marketplace("official"), ownership: "picc-owned" as const, candidates: [{ mutableRecordKey: "market-user", scope: "user" as const, selected: true, trusted: true }], availableActions: ["refresh", "remove"] as const };
    const preview = { operationId: `market_${action}`, action: action === "marketplace-refresh" ? "refresh" : "remove", registration: { name: "official", scope: "user", profileKey: "profile", source: { kind: "github", repository: "owner/repo" } }, snapshot: { snapshotId: "snapshot", catalogDigest: "digest", trust: { targetDigest: "trust" } }, catalog: { plugins: [], omittedEntries: 0 }, stateFingerprint: "state", settingsFingerprint: "settings", settingsEffect: { requested: true, effective: true }, acknowledgement: "preserve-installations", dependents: [], participants: [], consequences: [action], confirmationDigest: `sha256:${"b".repeat(64)}` } as never;
    const receipt = { operationId: `market_${action}`, outcome: "committed", completed: 1, summary: preview } as never; let operation: any; let executes = 0;
    const port = { marketplaces: { plan: async (value: unknown) => { operation = value; return { ok: true, value: preview }; }, prepare: () => ({ ok: true, value: { preview, execute: async () => { executes += 1; return { ok: true, value: receipt }; } } }), discardPreview: async () => ({ ok: true, value: undefined }) }, plugins: {}, recovery: {}, targets: { marketplace: (_identity: string, key: string) => ({ ok: true, value: { kind: "marketplace", identity: "official", scope: "user", mutableRecordKey: key, selector: "market-selector" } }) }, lookup: async () => ({ ok: true, value: { state: "terminal", receipt } }), projection: () => ({ ok: true, value: snapshot({ marketplaces: [selected] }) }) } as unknown as PluginLifecyclePort;
    const c = component(snapshot({ marketplaces: [selected] }), { lifecycle: port, initialAction: action }); c.handleInput("\r"); c.handleInput("official"); c.handleInput("\r"); if (action === "marketplace-remove") { c.handleInput("yes"); c.handleInput("\r"); }
    await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("preview")); expect(operation.flags.selector).toBe("market-selector"); if (action === "marketplace-remove") expect(operation.flags.preserveInstalled).toBe(true); expect(output(c.render(88))).toContain("Lifecycle preview"); c.handleInput("\r"); expect(output(c.render(88))).toContain("Final confirmation"); c.handleInput("\r"); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("receipt")); expect(executes).toBe(1); expect(output(c.render(88))).toContain("Marketplace lifecycle receipt · official");
  });

  it("executes one deferred operation despite a real double confirmation submit and retains projection warning truth", async () => {
    const preview = { operationId: "plugin_double", action: "enable", pluginId: "alpha@official", scope: "user", profileKey: "profile", dependencies: { selected: { admitted: true, reasons: [] }, blocking: false, graph: [] }, executableComponents: [], removeDeclaration: false, removeData: false, participants: [], consequences: ["enable"], confirmationDigest: `sha256:${"a".repeat(64)}` } as never;
    const receipt = { operationId: "plugin_double", action: "enable", pluginId: "alpha@official", outcome: "committed", completed: 1, summary: preview } as never; let release!: (value: unknown) => void; let executes = 0;
    const port = { marketplaces: {}, plugins: { plan: async () => ({ ok: true, value: preview }), execute: async () => { executes += 1; return new Promise((resolve) => { release = resolve; }); }, discardPreview: async () => ({ ok: true, value: undefined }) }, recovery: {}, targets: {}, lookup: async () => ({ ok: true, value: { state: "terminal", receipt } }), projection: () => ({ ok: false, code: "projection-failed", message: "private" }) } as unknown as PluginLifecyclePort;
    const c = component(snapshot(), { lifecycle: port, initialAction: "enable" }); c.handleInput("\r"); c.handleInput("alpha@official"); c.handleInput("\r"); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("preview")); c.render(80); c.handleInput("\r"); c.render(80); c.handleInput("\r"); c.handleInput("\r"); await vi.waitFor(() => expect(executes).toBe(1)); release({ ok: true, value: receipt }); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("receipt")); expect(executes).toBe(1); expect(c.view().workflow).toMatchObject({ receipt: { outcome: "committed" }, projectionFailure: expect.stringContaining("receipt remains authoritative") }); expect(output(c.render(100))).toContain("Desired-state projection refresh failed");
  });

  it("discards a successful late preview after cancellation without resurrecting the workflow", async () => {
    const preview = { operationId: "plugin_late", action: "enable", pluginId: "alpha@official", scope: "user", profileKey: "profile", dependencies: { selected: { admitted: true, reasons: [] }, blocking: false, graph: [] }, executableComponents: [], removeDeclaration: false, removeData: false, participants: [], consequences: ["enable"], confirmationDigest: `sha256:${"a".repeat(64)}` } as never;
    let resolvePlan!: (value: unknown) => void; let discards = 0; let executes = 0;
    const port = { marketplaces: {}, plugins: { plan: async () => new Promise((resolve) => { resolvePlan = resolve; }), execute: async () => { executes += 1; return { ok: false, code: "unused", message: "unused" }; }, discardPreview: async () => { discards += 1; return { ok: true, value: undefined }; } }, recovery: {}, targets: {}, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
    const c = component(snapshot(), { lifecycle: port, initialAction: "enable" }); c.handleInput("\r"); c.handleInput("alpha@official"); c.handleInput("\r"); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("planning")); c.handleInput("\u001b"); resolvePlan({ ok: true, value: preview }); await vi.waitFor(() => expect(discards).toBe(1)); expect(c.view().workflow).toBeUndefined(); expect(executes).toBe(0);
  });

  it("binds a two-registration install marketplace exactly once and immediately plans the explicit choice", async () => {
    const catalog = { ...item("alpha@official", { installationRecords: false, enablement: false, runtime: false }), lifecycle: { ownership: "picc-owned" as const, marketplaceOwnership: "picc-owned" as const, candidates: [], selectionRequired: false, availableActions: ["install" as const], installed: false, loaded: false, dependency: { state: "satisfied" as const }, pendingReload: false, retainedErrors: [] } };
    const registrations = { ...marketplace("official"), ownership: "picc-owned" as const, candidates: [{ mutableRecordKey: "market-user", scope: "user" as const, selected: false, trusted: true }, { mutableRecordKey: "market-project", scope: "project" as const, selected: false, trusted: true }], selectionRequired: true };
    const preview = { operationId: "plugin_two_marketplaces", action: "install", pluginId: "alpha@official", scope: "user", profileKey: "profile", dependencies: { selected: { admitted: true, reasons: [] }, blocking: false, graph: [] }, executableComponents: [], removeDeclaration: false, removeData: false, participants: [], consequences: ["install"], confirmationDigest: `sha256:${"a".repeat(64)}` } as never;
    let plans = 0; let selectedKey = ""; let operation: any;
    const port = { marketplaces: {}, plugins: { plan: async (value: unknown) => { plans += 1; operation = value; return { ok: true, value: preview }; }, discardPreview: async () => ({ ok: true, value: undefined }) }, recovery: {}, targets: { marketplace: (_identity: string, key: string) => { selectedKey = key; return { ok: true, value: { kind: "marketplace", identity: "official", scope: key === "market-project" ? "project" : "user", mutableRecordKey: key, selector: `selector-${key}` } }; } }, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
    const c = component(snapshot({ items: [catalog], marketplaces: [registrations] }), { lifecycle: port, initialAction: "install" });
    c.handleInput("\r"); c.handleInput("alpha@official"); c.handleInput("\r"); c.handleInput("user"); c.handleInput("\r");
    await vi.waitFor(() => expect(c.view().workflow).toMatchObject({ phase: "select-candidate", candidates: [{ authority: { mutableRecordKey: "market-user" } }, { authority: { mutableRecordKey: "market-project" } }] }));
    c.handleInput("\u001b[B"); c.handleInput("\r");
    await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("preview"));
    expect(plans).toBe(1); expect(selectedKey).toBe("market-project"); expect(operation.flags.marketplaceSelector).toBe("selector-market-project");
  });

  it("keeps stale discard cleanup from resurrecting a cancelled or disposed workflow", async () => {
    const preview = { operationId: "plugin_discard_race", action: "enable", pluginId: "alpha@official", scope: "user", profileKey: "profile", dependencies: { selected: { admitted: true, reasons: [] }, blocking: false, graph: [] }, executableComponents: [], removeDeclaration: false, removeData: false, participants: [], consequences: ["enable"], confirmationDigest: `sha256:${"a".repeat(64)}` } as never;
    let release!: (value: { ok: true; value: undefined }) => void; let discards = 0; let executes = 0;
    const port = { marketplaces: {}, plugins: { plan: async () => ({ ok: true, value: preview }), execute: async () => { executes += 1; return { ok: false, code: "unused", message: "unused" }; }, discardPreview: async () => { discards += 1; return new Promise((resolve) => { release = resolve; }); } }, recovery: {}, targets: {}, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
    const renderer: typeof renderPluginInventory = (view, options) => { if (view.workflow?.phase === "preview") throw new Error("preview renderer fault"); return renderPluginInventory(view, options); };
    const cancelled = component(snapshot(), { lifecycle: port, initialAction: "enable", render: renderer }); cancelled.handleInput("\r"); cancelled.handleInput("alpha@official"); cancelled.handleInput("\r"); await vi.waitFor(() => expect(cancelled.view().workflow?.phase).toBe("preview")); cancelled.render(72); await vi.waitFor(() => expect(discards).toBe(1)); cancelled.handleInput("\u001b"); expect(cancelled.view().workflow).toBeUndefined(); release({ ok: true, value: undefined }); await Promise.resolve(); await Promise.resolve(); expect(cancelled.view().workflow).toBeUndefined(); expect(executes).toBe(0);

    let disposeRelease!: (value: { ok: true; value: undefined }) => void;
    const disposePort = { ...port, plugins: { ...port.plugins, discardPreview: async () => { discards += 1; return new Promise((resolve) => { disposeRelease = resolve; }); } } } as unknown as PluginLifecyclePort;
    const disposed = component(snapshot(), { lifecycle: disposePort, initialAction: "enable" }); disposed.handleInput("\r"); disposed.handleInput("alpha@official"); disposed.handleInput("\r"); await vi.waitFor(() => expect(disposed.view().workflow?.phase).toBe("preview")); disposed.dispose(); expect(discards).toBe(2); disposeRelease({ ok: true, value: undefined }); await Promise.resolve(); expect(executes).toBe(0);
  });

  it("renders the ordinary marketplace receipt name with outcome-specific truth", async () => {
    for (const outcome of ["committed", "rolled-back", "failed-before-commit"] as const) {
      const preview = { operationId: `market_${outcome}`, action: "add", registration: { name: "named-market", scope: "user", profileKey: "profile", source: { kind: "github", repository: "owner/repo" } }, snapshot: { snapshotId: "snapshot", catalogDigest: "digest", trust: { targetDigest: "trust" } }, catalog: { plugins: [], omittedEntries: 0 }, stateFingerprint: "state", settingsFingerprint: "settings", settingsEffect: { requested: true, effective: true }, acknowledgement: "preserve-installations", dependents: [], participants: [], consequences: ["add"], confirmationDigest: `sha256:${"b".repeat(64)}` } as never;
      const receipt = { operationId: `market_${outcome}`, outcome, completed: outcome === "committed" ? 1 : 0, summary: preview } as never;
      const port = { marketplaces: { plan: async () => ({ ok: true, value: preview }), prepare: () => ({ ok: true, value: { preview, execute: async () => ({ ok: true, value: receipt }) } }), discardPreview: async () => ({ ok: true, value: undefined }) }, plugins: {}, recovery: {}, targets: {}, lookup: async () => ({ ok: true, value: { state: "terminal", receipt } }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
      const c = component(snapshot(), { lifecycle: port, initialAction: "marketplace-add" }); c.handleInput("\r"); for (const value of ["named-market", "github", "owner/repo", "user"]) { c.handleInput(value); c.handleInput("\r"); } await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("preview")); c.render(80); c.handleInput("\r"); c.render(80); c.handleInput("\r"); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("receipt")); const rendered = output(c.render(100)); expect(rendered).toContain(`Marketplace lifecycle receipt · named-market`); expect(rendered).toContain(outcome); expect(rendered).toContain(outcome === "committed" ? "Durable marketplace state changed" : outcome === "rolled-back" ? "operation rolled back" : "failed before commit");
    }
  });

  it("fails closed on omitted marketplace/recovery evidence and refuses managed plugin mutation before composition", async () => {
    let executions = 0;
    const incompleteMarket = { operationId: "market_missing", action: "add", registration: { name: "missing", scope: "user", profileKey: "profile", source: { kind: "github", repository: "owner/repo" } }, snapshot: { snapshotId: "snapshot", catalogDigest: "digest", trust: { targetDigest: "trust" } }, catalog: { omittedEntries: 0 }, stateFingerprint: "state", settingsFingerprint: "settings", settingsEffect: { requested: true, effective: true }, acknowledgement: "preserve-installations", dependents: [], participants: [], consequences: ["add"], confirmationDigest: `sha256:${"b".repeat(64)}` } as never;
    const marketPort = { marketplaces: { plan: async () => ({ ok: true, value: incompleteMarket }), prepare: () => ({ ok: true, value: { preview: incompleteMarket, execute: async () => { executions += 1; return { ok: false, code: "unused", message: "unused" }; } } }), discardPreview: async () => ({ ok: true, value: undefined }) }, plugins: {}, recovery: {}, targets: {}, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
    const market = component(snapshot(), { lifecycle: marketPort, initialAction: "marketplace-add" }); market.handleInput("\r"); for (const value of ["missing", "github", "owner/repo", "user"]) { market.handleInput(value); market.handleInput("\r"); } await vi.waitFor(() => expect(market.view().workflow).toMatchObject({ phase: "preview", confirmationEnabled: false })); market.handleInput("\r"); expect(executions).toBe(0);

    const recoveryPreview = { operationId: "pending_missing", producerSchema: "plugin-lifecycle", producerVersion: 1, confirmationDigest: "digest", planDigest: "plan", completed: 1, remaining: 1, rolledBack: 0, actions: ["complete"], confirmationSummary: { pluginId: "alpha@official", scope: "user", profileKey: "profile", dependencies: { selected: { admitted: true, reasons: [] }, graph: [] }, executableComponents: [], consequences: [] } } as never;
    const recoveryPort = { marketplaces: {}, plugins: {}, recovery: { preview: async () => ({ ok: true, value: recoveryPreview }), recover: async () => { executions += 1; return { ok: false, code: "unused", message: "unused" }; } }, targets: {}, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
    const recovery = component(snapshot(), { lifecycle: recoveryPort, initialAction: "recover" }); recovery.handleInput("\r"); recovery.handleInput("pending_missing"); recovery.handleInput("\r"); recovery.handleInput("complete"); recovery.handleInput("\r"); await vi.waitFor(() => expect(recovery.view().workflow).toMatchObject({ phase: "preview", confirmationEnabled: false })); recovery.handleInput("\r"); expect(executions).toBe(0);

    let compositions = 0; const managedItem = { ...item("managed@official"), lifecycle: { ownership: "managed" as const, candidates: [], selectionRequired: false, availableActions: [] as const, installed: true, loaded: true, dependency: { state: "satisfied" as const }, pendingReload: false, retainedErrors: [] } }; const managed = component(snapshot({ items: [managedItem] }), { lifecycleFactory: async () => { compositions += 1; return { ok: false, code: "unused", message: "unused" }; } }); managed.handleInput("A"); expect(managed.view().workflow?.phase).toBe("refused"); expect(compositions).toBe(0);
  });

  it("keeps wide and combining Unicode workflow confirmation width-bounded", async () => {
    const preview = { operationId: "plugin_unicode", action: "enable", pluginId: "alpha@official", scope: "user", profileKey: "profile", dependencies: { selected: { admitted: true, reasons: ["界e\u0301界e\u0301"] }, blocking: false, graph: [] }, executableComponents: ["技能e\u0301"], removeDeclaration: false, removeData: false, participants: [], consequences: ["変更界e\u0301"], confirmationDigest: `sha256:${"a".repeat(64)}` } as never;
    const port = { marketplaces: {}, plugins: { plan: async () => ({ ok: true, value: preview }), discardPreview: async () => ({ ok: true, value: undefined }) }, recovery: {}, targets: {}, lookup: async () => ({ ok: true, value: undefined }), projection: () => ({ ok: true, value: snapshot() }) } as unknown as PluginLifecyclePort;
    const c = component(snapshot(), { lifecycle: port, initialAction: "enable" }); c.handleInput("\r"); c.handleInput("alpha@official"); c.handleInput("\r"); await vi.waitFor(() => expect(c.view().workflow?.phase).toBe("preview")); for (const width of [8, 13, 24]) for (const line of c.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width); c.render(24); c.handleInput("\r"); for (const line of c.render(13)) expect(visibleWidth(line)).toBeLessThanOrEqual(13);
  });

  it("performs no filesystem I/O, network, process launch, or snapshot mutation on populated paths", () => {
    const read = vi.spyOn(fs, "readFileSync");
    const write = vi.spyOn(fs, "writeFileSync");
    const spawn = vi.spyOn(childProcess, "spawn");
    const exec = vi.spyOn(childProcess, "execFile");
    const fetchTrap = vi.fn(() => { throw new Error("network forbidden"); });
    vi.stubGlobal("fetch", fetchTrap);
    const snap = snapshot({ items: [item("populated@official", { components: 20, diagnostics: [{ severity: "warning", message: "retained diagnostic" }] })], diagnostics: [{ severity: "error", message: "global", category: "managed-policy-malformed", sourceClass: "system-file", impact: "source-ignored" }], omissions: { retained: 4 } });
    const before = JSON.stringify(snap);
    const c = component(snap);
    c.render(120); c.handleInput("\r"); c.render(40); c.handleInput("\u001b[B"); c.render(1); c.handleInput("\u001b"); c.handleInput("\t"); c.render(80);
    expect(JSON.stringify(snap)).toBe(before);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
    expect(fetchTrap).not.toHaveBeenCalled();
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
});

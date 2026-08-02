import { visibleWidth } from "@earendil-works/pi-tui";
import childProcess from "node:child_process";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PluginInventoryDiagnostic, PluginInventoryItem, PluginInventoryMarketplace, PluginInventorySnapshot } from "../src/plugin-inventory.js";
import { PluginInventoryFocusController, openPluginInventory } from "../src/runtime/plugin-inventory-focus.js";
import { PluginInventoryModel } from "../src/runtime/plugin-inventory-model.js";
import { renderPluginInventory } from "../src/runtime/plugin-inventory-render.js";

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
  omissions?: Readonly<Record<string, number>>; find?: (identity: string) => PluginInventoryItem | undefined;
} = {}): PluginInventorySnapshot {
  const items = options.items ?? [item("alpha@official"), item("alpha@community", { status: "rejected", diagnostics: [{ severity: "error", message: "load rejected" }] })];
  return {
    capturedAt: "2026-01-01T00:00:00.000Z", lifetime: "session", refreshGuidance: "session", installedStateStatus: "valid",
    items, marketplaces: options.marketplaces ?? [marketplace()], marketplaceCatalogs: [], allowlistObservations: [], conflictObservations: [],
    policyObservations: [{ kind: "strict", match: true, validScope: true, emptyLockdown: false, posture: "claude-lifecycle-observation-not-enforced", provenance: { source: { kind: "marketplace-cache", display: "<marketplace-cache>/official/policy.json" }, scope: "managed" } }],
    diagnostics: options.diagnostics ?? [], capabilityEvidence: [], omissions: options.omissions ?? {},
    find: options.find ?? ((identity) => items.find((value) => value.qualifiedIdentity === identity)),
  };
}

const plainTheme = { fg: (_color: string, value: string) => value };
const output = (lines: readonly string[]): string => lines.join("\n");
const normalizedOutput = (lines: readonly string[]): string => output(lines).replace(/\s+/gu, " ");
function component(snap = snapshot(), options: { render?: typeof renderPluginInventory; requestRender?: () => void; done?: () => void; keybindings?: { matches(data: string, id: string): boolean }; onError?: (error: unknown) => void } = {}) {
  return new PluginInventoryFocusController({ snapshot: snap, tui: { requestRender: options.requestRender ?? (() => {}) }, theme: plainTheme, keybindings: options.keybindings, done: options.done ?? (() => {}), render: options.render, onError: options.onError });
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
    expect(zero).toContain("run /reload in the interactive TUI, or exit and relaunch PiCC");
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
      { severity: "warning", category: "managed-policy-unreadable", sourceClass: "system-file", impact: "weaker-policy-suppressed", message: "policy warning" },
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
    expect(detail).toContain("Impact: weaker-policy-suppressed");
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

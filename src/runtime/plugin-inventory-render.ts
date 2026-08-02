import { visibleWidth } from "@earendil-works/pi-tui";
import type { PluginInventoryComponent, PluginInventoryDiagnostic, PluginInventoryProvenance } from "../plugin-inventory.js";
import { clampLines, pushWrapped, themedFg } from "./render-util.js";
import { PLUGIN_INVENTORY_VIEWS, type PluginInventoryModelView, type PluginInventoryRow } from "./plugin-inventory-model.js";
import { parseQualifiedPluginId } from "../util/plugin-id.js";
import { formatPluginInventoryDisplayLocation, sanitizePluginInventoryDisplayText } from "./plugin-inventory-text.js";
import { formatPluginInventoryStructuredSource } from "./plugin-inventory-display.js";

const LIST_WINDOW = 8;
const DETAIL_WINDOW = 12;
const DETAIL_VALUE_CAP = 16;
const TEXT_CAP = 320;

export interface PluginInventoryRenderOptions { readonly width: number; readonly theme?: unknown }
export interface PluginInventoryRenderResult { readonly lines: readonly string[]; readonly maxDetailScroll: number; readonly selectedVisible: boolean }
interface DetailLine { readonly text: string; readonly color: string }

function safe(value: unknown, cap = TEXT_CAP): string {
  return sanitizePluginInventoryDisplayText(typeof value === "string" ? value : String(value ?? ""), cap);
}
function qualifiedIdentity(value: unknown): string {
  return parseQualifiedPluginId(value)?.qualifiedIdentity ?? "unknown@unknown";
}
function location(value: Parameters<typeof formatPluginInventoryDisplayLocation>[0]): string {
  return formatPluginInventoryDisplayLocation(value);
}
function provenance(value: PluginInventoryProvenance | undefined): string {
  if (!value) return "not available";
  return [location(value.source), value.scope && `scope ${safe(value.scope, 60)}`, value.origin && `origin ${safe(value.origin, 60)}`,
    value.order !== undefined && `order ${value.order}`, value.field && `field ${safe(value.field, 60)}`,
    value.entryIndex !== undefined && `entry ${value.entryIndex}`, value.itemIndex !== undefined && `item ${value.itemIndex}`,
    value.key && `key ${safe(value.key, 80)}`].filter((part): part is string => typeof part === "string").join(" · ");
}
function addWrapped(lines: string[], theme: unknown, color: string, trustedText: string, width: number): void {
  pushWrapped(themedFg(theme, color, trustedText), Math.max(1, width), lines);
}
function supportSummary(components: readonly PluginInventoryComponent[]): { text: string; limited: boolean } {
  if (components.length === 0) return { text: "support not observed", limited: false };
  const unsupported = components.filter((value) => value.supportTier === "not-supported").length;
  const partial = components.filter((value) => value.supportTier === "partial" || value.supportTier === "degraded-noop").length;
  if (unsupported > 0) return { text: `${unsupported} unsupported declaration${unsupported === 1 ? "" : "s"}`, limited: true };
  if (partial > 0) return { text: `${partial} limited component${partial === 1 ? "" : "s"}`, limited: true };
  return { text: "supported components", limited: false };
}
function pluginStatusColor(row: Extract<PluginInventoryRow, { kind: "plugin" }>): string {
  const item = row.item;
  const status = item.outcome?.status;
  if (status !== undefined && status !== "loaded" && status !== "disabled") return "error";
  if (item.diagnostics.some((value) => value.severity === "error")) return "error";
  if (supportSummary(item.components).limited || item.diagnostics.some((value) => value.severity === "warning")) return "warning";
  if (status === "loaded") return "success";
  return "muted";
}

function framing(view: PluginInventoryModelView, theme: unknown, width: number, lines: string[]): void {
  addWrapped(lines, theme, "accent", "PiCC plugin inventory", width);
  addWrapped(lines, theme, "muted", "read-only · captured for this session", width);
  addWrapped(lines, theme, "muted", "Refresh: run /reload in the interactive TUI, or exit and relaunch PiCC.", width);
  if (view.activeView === "Discover" || view.activeView === "Marketplaces") {
    addWrapped(lines, theme, "muted", "Local known catalogs/registrations only · no network refresh, download, or management.", width);
  }
}
function tabs(view: PluginInventoryModelView, theme: unknown, width: number, lines: string[]): void {
  if (width < 28) {
    addWrapped(lines, theme, "accent", `View: ${view.activeView} · tabs hidden at this width`, width);
    return;
  }
  pushWrapped(PLUGIN_INVENTORY_VIEWS.map((name, index) => index === view.activeViewIndex
    ? themedFg(theme, "accent", `[${name}]`) : themedFg(theme, "muted", name)).join("  "), width, lines);
}

function diagnosticSummary(value: PluginInventoryDiagnostic): string {
  return `${safe(value.severity, 30)} · ${safe(value.category ?? "uncategorized", 80)} · ${safe(value.sourceClass ?? "unknown source", 80)} · impact ${safe(value.impact ?? "not stated", 100)}`;
}
function rowSummary(row: PluginInventoryRow): { identity: string; summary: string; color: string } {
  if (row.kind === "marketplace") return {
    identity: safe(row.identity),
    summary: `${safe(row.marketplace.validity, 30)} · ${safe(row.marketplace.scope, 50)} · ${safe(row.marketplace.origin, 50)}`,
    color: row.marketplace.validity === "rejected" ? "error" : row.marketplace.selected ? "success" : "muted",
  };
  if (row.kind === "global-diagnostic") return {
    identity: safe(row.identity), summary: diagnosticSummary(row.diagnostic),
    color: row.diagnostic.severity === "error" ? "error" : row.diagnostic.severity === "warning" ? "warning" : "muted",
  };
  const item = row.item;
  const support = supportSummary(item.components);
  const valid = item.installations.filter((value) => value.validity === "valid").length;
  const invalid = item.installations.length - valid;
  return {
    identity: qualifiedIdentity(row.identity),
    summary: `installation records ${valid} valid / ${invalid} invalid · ${item.enablement ? item.enablement.enabled ? "enabled" : "disabled" : "enablement unknown"} · session outcome ${safe(item.outcome?.status ?? "not resolved", 80)} · ${support.text}`,
    color: pluginStatusColor(row),
  };
}

function renderOmissions(view: PluginInventoryModelView, theme: unknown, width: number, lines: string[]): void {
  if (view.locallyOmittedRows > 0) addWrapped(lines, theme, "muted", `Local list cap: ${view.locallyOmittedRows} retained rows are not shown.`, width);
  if (view.captureOmissions.length > 0) {
    addWrapped(lines, theme, "muted", `Snapshot-capture evidence omissions: ${view.captureOmissions.map((value) => `${safe(value.axis, 100)}=${value.count}`).join(", ")}.`, width);
  }
}

function renderList(view: PluginInventoryModelView, theme: unknown, width: number, lines: string[]): boolean {
  if (view.warning) addWrapped(lines, theme, "warning", `Warning: ${view.warning}`, width);
  addWrapped(lines, theme, view.filter ? "accent" : "muted", `Filter: ${view.filter ? safe(view.filter) : "(type to filter literally)"}`, width);
  if (view.rows.length === 0) {
    addWrapped(lines, theme, "warning", view.filter ? "No matches for the active literal filter." : `No ${view.activeView.toLocaleLowerCase()} entries in this captured snapshot.`, width);
    renderOmissions(view, theme, width, lines);
    return false;
  }
  const selected = Math.max(0, view.selectedIndex);
  const start = Math.max(0, Math.min(selected - Math.floor(LIST_WINDOW / 2), Math.max(0, view.rows.length - LIST_WINDOW)));
  const end = Math.min(view.rows.length, start + LIST_WINDOW);
  if (start > 0) addWrapped(lines, theme, "muted", `↑ ${start} retained rows above`, width);
  let selectedVisible = false;
  for (let index = start; index < end; index += 1) {
    const row = view.rows[index]!;
    const selectedRow = row.key === view.selectedKey;
    selectedVisible ||= selectedRow;
    const summary = rowSummary(row);
    const prefix = selectedRow ? "> " : "  ";
    const identity = selectedRow ? themedFg(theme, "accent", summary.identity) : summary.identity;
    const cue = row.kind === "global-diagnostic" ? "Enter action" : "Enter details";
    if (row.kind === "plugin") {
      // A canonical qualified identity has its own wrapped display lines at every width.
      pushWrapped(`${prefix}${identity}`, width, lines);
      pushWrapped(`    ${themedFg(theme, summary.color, `${summary.summary} · ${cue}`)}`, width, lines);
    } else if (width >= 72) lines.push(`${prefix}${identity}${themedFg(theme, summary.color, ` · ${summary.summary} · ${cue}`)}`);
    else {
      pushWrapped(`${prefix}${identity}${themedFg(theme, "muted", ` · ${cue}`)}`, width, lines);
      if (width >= 48) pushWrapped(`    ${themedFg(theme, summary.color, summary.summary)}`, width, lines);
    }
  }
  const below = view.rows.length - end;
  if (below > 0) addWrapped(lines, theme, "muted", `↓ ${below} retained rows below`, width);
  renderOmissions(view, theme, width, lines);
  return selectedVisible;
}

function pushDetail(lines: DetailLine[], text: string, color = "text"): void { lines.push({ text, color }); }
function addDetailValues(lines: DetailLine[], heading: string, values: readonly string[], identity: string, color = "text"): void {
  pushDetail(lines, `${heading}:`, color);
  for (const value of values.slice(0, DETAIL_VALUE_CAP)) pushDetail(lines, `  ${value}`, color);
  if (values.length === 0) pushDetail(lines, "  none", "muted");
  if (values.length > DETAIL_VALUE_CAP) {
    pushDetail(lines, `  ${values.length - DETAIL_VALUE_CAP} additional retained values are not expanded here; use /plugin details ${identity}.`, "muted");
  }
}
function pluginDetail(view: PluginInventoryModelView): DetailLine[] {
  const detail = view.detail;
  if (!detail || detail.kind !== "plugin") return [];
  const item = detail.item;
  const identity = qualifiedIdentity(detail.identity);
  const metadata = item.metadata;
  const support = supportSummary(item.components);
  const lines: DetailLine[] = [];
  pushDetail(lines, `Plugin: ${identity}`, "accent");
  pushDetail(lines, `Description: ${safe(metadata?.description ?? item.catalogDeclarations[0]?.description ?? "not available")}`);
  pushDetail(lines, `Source: selected state ${location(item.selectedInstallation?.provenance.state)} · enablement ${location(item.enablement?.source)}`);
  pushDetail(lines, `Version: installed ${safe(item.selectedInstallation?.version ?? "not available", 100)} · manifest ${safe(metadata?.version ?? "not available", 100)} · catalog ${safe(item.catalogDeclarations[0]?.version ?? "not available", 100)}`);
  pushDetail(lines, `Revision: catalog ${safe(item.catalogDeclarations[0]?.revision ?? "not available", 100)} · evidence ${safe(item.catalogDeclarations[0]?.revisionEvidence ?? "not available", 100)}`);
  pushDetail(lines, `Scope: ${safe(item.selectedInstallation?.scope ?? item.enablement?.scope ?? "not available", 80)}`);
  pushDetail(lines, `Anchored location: root ${location(item.selectedInstallation?.root)} · project ${location(item.selectedInstallation?.project)} · data ${location(item.selectedInstallation?.data)}`);
  addDetailValues(lines, "Installation records", item.installations.map((value) => {
    const problems = value.problems.length ? value.problems.map((problem) => safe(problem, 100)).join(", ") : "none";
    const diagnostics = value.diagnostics.length ? value.diagnostics.map((diagnostic) => `${safe(diagnostic.severity, 30)}:${safe(diagnostic.message, 160)}`).join(", ") : "none";
    return `scope ${safe(value.scope ?? "not available", 80)} · version ${safe(value.version ?? "not available", 100)} · validity ${value.validity} · ${value.selected ? "selected" : "not selected"} · location ${location(value.location)} · project ${location(value.projectLocation)} · problems ${problems} · diagnostics ${diagnostics}`;
  }), identity, item.installations.some((value) => value.validity === "invalid") ? "warning" : "text");
  pushDetail(lines, `Session outcome: ${safe(item.outcome?.status ?? "not resolved", 80)}`, pluginStatusColor({ kind: "plugin", key: `plugin:${item.qualifiedIdentity}`, identity: item.qualifiedIdentity, item }));
  addDetailValues(lines, "Dependencies (declared only; not resolved)", item.dependencies.map((value) => `${qualifiedIdentity(value.targetIdentity)} · origin ${value.origin} · version ${safe(value.version ?? "not declared", 80)} · qualification ${safe(value.crossMarketplace, 80)} · ${safe(value.posture, 100)} · ${provenance(value.provenance)}`), identity);
  addDetailValues(lines, "Renames (declared only; not applied)", item.renames.map((value) => `${safe(value.from, 100)} → ${safe(value.target ?? "removed", 100)} · ${safe(value.status, 80)} · ${provenance(value.provenance)}`), identity);
  addDetailValues(lines, "Components", item.components.map((value) => `${safe(value.origin, 50)}/${safe(value.kind, 50)} · count ${value.count} ${safe(value.countSemantics, 80)} · support ${safe(value.supportTier, 50)} · risk ${safe(value.executionRisk, 60)} · ${provenance(value.provenance)}`), identity, support.limited ? "warning" : "text");
  pushDetail(lines, `PiCC support: ${support.text}`, support.limited ? "warning" : "text");
  pushDetail(lines, `Execution risk: ${item.executionRisk.length ? item.executionRisk.map((value) => safe(value, 60)).join(", ") : "none observed"}`);
  addDetailValues(lines, "Policy", [
    item.enablement ? `enablement ${item.enablement.enabled ? "enabled" : "disabled"} · scope ${safe(item.enablement.scope, 80)} · ${location(item.enablement.source)}` : "no item-specific enablement decision captured",
    "Global marketplace policy observations are not attributed to this plugin and are not mutation controls.",
    ...view.policyObservations.map((value) => `GLOBAL ${safe(value.kind, 80)} · match ${safe(String(value.match), 40)} · valid scope ${value.validScope ? "yes" : "no"} · ${provenance(value.provenance)} · not attributed/not enforced`),
  ], identity, "warning");
  addDetailValues(lines, "Diagnostics with provenance", item.diagnostics.map((value) => `${safe(value.severity, 30)} · category ${safe(value.category ?? "uncategorized", 80)} · source ${safe(value.sourceClass ?? "unknown", 80)} · impact ${safe(value.impact ?? "not stated", 100)} · ${safe(value.message)}`), identity,
    item.diagnostics.some((value) => value.severity === "error") ? "error" : item.diagnostics.length ? "warning" : "text");
  addDetailValues(lines, "Catalog declarations with provenance", item.catalogDeclarations.map((value) => `source ${formatPluginInventoryStructuredSource(value.source)} · description ${safe(value.description ?? "not declared")} · version ${safe(value.version ?? "not declared", 80)} · revision ${safe(value.revision ?? "not declared", 80)} · ${provenance(value.provenance)} · ${safe(value.runtimeEffect, 80)}`), identity);
  return lines;
}
function marketplaceDetail(view: PluginInventoryModelView): DetailLine[] {
  const detail = view.detail;
  if (!detail || detail.kind !== "marketplace") return [];
  const value = detail.marketplace;
  return [
    { text: `Marketplace registration: ${safe(value.name)}`, color: "accent" },
    { text: `Validity/selection: ${safe(value.validity, 40)} · ${value.selected ? "selected" : "not selected"}`, color: value.validity === "rejected" ? "error" : "text" },
    { text: `Scope/origin: ${safe(value.scope, 100)} · ${safe(value.origin, 100)}`, color: "text" },
    { text: `Fixture contract: ${safe(value.fixtureContract ?? "not declared", 80)}`, color: "text" },
    { text: `Anchored catalog location: ${location(value.catalog)}`, color: "text" },
    { text: `Source fields: ${formatPluginInventoryStructuredSource(value.source)}`, color: "text" },
    { text: `Source provenance: ${provenance(value.sourceProvenance)}`, color: "text" },
    { text: `Registration provenance: ${provenance(value.provenance)}`, color: "text" },
    { text: "Local registration/catalog evidence only; no network refresh, download, install, update, enable, disable, or removal is available here.", color: "muted" },
  ];
}
function globalDiagnosticDetail(view: PluginInventoryModelView): DetailLine[] {
  const detail = view.detail;
  if (!detail || detail.kind !== "global-diagnostic") return [];
  const value = detail.diagnostic;
  const color = value.severity === "error" ? "error" : value.severity === "warning" ? "warning" : "muted";
  const administrator = /managed|system|administrator/iu.test(`${value.category ?? ""} ${value.sourceClass ?? ""} ${value.impact ?? ""}`);
  return [
    { text: `Global diagnostic: ${safe(value.category ?? "uncategorized", 100)}`, color: "accent" },
    { text: `Severity: ${safe(value.severity, 30)}`, color },
    { text: `Source: ${safe(value.sourceClass ?? "unknown source", 100)}`, color },
    { text: `Impact: ${safe(value.impact ?? "not stated", 160)}`, color },
    { text: `Message: ${safe(value.message)}`, color },
    { text: "Action: run /doctor for the complete diagnostic and recovery guidance.", color: "warning" },
    ...(administrator ? [{ text: "Administrator action may be required because this diagnostic is owned by managed/system policy.", color: "warning" }] : []),
  ];
}
function renderDetail(view: PluginInventoryModelView, theme: unknown, width: number, lines: string[]): number {
  const raw = view.detail?.kind === "plugin" ? pluginDetail(view) : view.detail?.kind === "marketplace" ? marketplaceDetail(view) : globalDiagnosticDetail(view);
  const body: string[] = [];
  for (const value of raw) addWrapped(body, theme, value.color, value.text, width);
  const max = Math.max(0, body.length - DETAIL_WINDOW);
  const scroll = Math.max(0, Math.min(max, view.detailScroll));
  if (scroll > 0) addWrapped(lines, theme, "muted", `↑ ${scroll} detail lines above`, width);
  lines.push(...body.slice(scroll, scroll + DETAIL_WINDOW));
  const below = Math.max(0, body.length - (scroll + DETAIL_WINDOW));
  if (below > 0) addWrapped(lines, theme, "muted", `↓ ${below} detail lines below`, width);
  return max;
}

/** Pure, width-safe renderer. Untrusted snapshot text is sanitized before theme and measurement. */
export function renderPluginInventory(view: PluginInventoryModelView, options: PluginInventoryRenderOptions): PluginInventoryRenderResult {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  if (width === 0) return { lines: [""], maxDetailScroll: 0, selectedVisible: false };
  const lines: string[] = [];
  if (width < 8) {
    for (const value of ["PiCC plugin inventory", "read-only session snapshot", "width unusable", "resize wider", "Esc closes"]) addWrapped(lines, options.theme, "warning", value, width);
    return { lines: clampLines(lines, width), maxDetailScroll: 0, selectedVisible: false };
  }
  framing(view, options.theme, width, lines);
  tabs(view, options.theme, width, lines);
  let maxDetailScroll = 0;
  let selectedVisible = false;
  if (view.detail) {
    if (view.filter) addWrapped(lines, options.theme, "accent", `Active filter: ${safe(view.filter)}`, width);
    maxDetailScroll = renderDetail(view, options.theme, width, lines);
    renderOmissions(view, options.theme, width, lines);
  } else selectedVisible = renderList(view, options.theme, width, lines);
  addWrapped(lines, options.theme, "muted", view.detail
    ? "↑/↓ scroll · Esc leaves details · then Esc clears filter · then Esc closes · /plugin list · /plugin details <qualified-name>"
    : "←/→ or Tab/Shift-Tab views · ↑/↓ select · type literal filter · Backspace edit · Enter details/action · Esc clear/close · /plugin list", width);
  const safeLines = clampLines(lines, width).map((line) => {
    try { return visibleWidth(line) <= width ? line : ""; } catch { return ""; }
  });
  return { lines: safeLines, maxDetailScroll, selectedVisible };
}

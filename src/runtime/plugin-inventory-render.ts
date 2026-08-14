import { visibleWidth } from "@earendil-works/pi-tui";
import type { PluginInventoryComponent, PluginInventoryDiagnostic, PluginInventoryProvenance } from "../plugin-inventory.js";
import { clampLines, pushWrapped, themedFg } from "./render-util.js";
import { PLUGIN_INVENTORY_VIEWS, type PluginInventoryModelView, type PluginInventoryRow, type PluginInventoryWorkflow } from "./plugin-inventory-model.js";
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
function workflowMessage(value: string): string { return [...value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")].slice(0, 512).join(""); }
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
  addWrapped(lines, theme, "accent", "PiCC plugin inventory · lifecycle", width);
  const phase = view.workflow?.phase;
  if (phase === undefined) addWrapped(lines, theme, "muted", "read-only · captured loaded runtime + active-checkout desired state · browsing is inert", width);
  else if (phase === "receipt") addWrapped(lines, theme, "warning", "Explicit confirmation authorized execution; this receipt is authoritative.", width);
  else if (["progress", "pending-recovery", "terminal-fallback"].includes(phase)) addWrapped(lines, theme, "warning", "Explicit confirmation authorized execution; receipt or recovery evidence is authoritative.", width);
  else addWrapped(lines, theme, "muted", "Workflow active · candidate acquisition or staging may occur during planning; lifecycle transaction execution and durable desired-state commit require final confirmation.", width);
  addWrapped(lines, theme, "muted", "Effective desired state comes from the active checkout at /plugin open and refreshes after receipts; loaded runtime remains session-captured.", width);
  addWrapped(lines, theme, "muted", `Generation: captured loaded ${safe(view.loadedSnapshot.loadedGenerationId ?? "not identified", 80)} · effective desired ${safe(view.durableDesired.durableDesired?.generationId ?? "not identified", 80)}`, width);
  if (view.actionOverlay) addWrapped(lines, theme, view.actionOverlay.phase === "failed" || view.actionOverlay.phase === "reload-unconfirmed" ? "warning" : "accent", `Overlay: ${safe(view.actionOverlay.phase, 40)} · ${safe(view.actionOverlay.target ?? view.actionOverlay.operationId, 100)}${view.actionOverlay.message ? ` · ${safe(view.actionOverlay.message)}` : ""}`, width);
  addWrapped(lines, theme, "muted", "Refresh loaded runtime: run /reload-plugins in the interactive TUI, or exit and relaunch PiCC.", width);
  if (view.activeView === "Discover" || view.activeView === "Marketplaces") {
    addWrapped(lines, theme, "muted", "Local known catalogs/registrations only · acquisition begins only after an explicit action and planning progress is cancellable.", width);
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
    summary: `${safe(row.marketplace.validity, 30)} · ${safe(row.marketplace.ownership ?? "unknown owner", 50)} · ${safe(row.marketplace.scope, 50)} · eligibility ${(row.marketplace.availableActions ?? []).join(",") || "inspect only"}${row.marketplace.selectionRequired ? " · scope selection required" : ""}`,
    color: row.marketplace.validity === "rejected" ? "error" : row.marketplace.selected ? "success" : "muted",
  };
  if (row.kind === "global-lifecycle") return {
    identity: safe(row.identity),
    summary: `lifecycle evidence · ${safe(row.operation.status, 40)} · step ${safe(row.operation.semanticStep, 100)} · category ${row.operation.category} · target ${safe(row.operation.target ?? "not attributed", 100)}`,
    color: "warning",
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
    summary: `installation records ${valid} valid / ${invalid} invalid · captured runtime outcome ${safe(item.outcome?.status ?? "not resolved", 80)} · owner ${safe(item.lifecycle?.ownership ?? "unknown", 40)} · active-checkout desired ${item.lifecycle === undefined ? "unknown" : item.lifecycle.installed ? "installed" : "not installed"}/${item.lifecycle?.effectiveEnabled === undefined ? "enablement unknown" : item.lifecycle.effectiveEnabled ? "enabled" : "disabled"} · captured loaded ${item.lifecycle?.loaded ? "yes" : "no"} · eligibility ${item.lifecycle?.availableActions.length ? item.lifecycle.availableActions.join(",") : "none"}${item.lifecycle?.selectionRequired ? " · scope selection required" : ""} · ${support.text}`,
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
    addWrapped(lines, theme, "warning", view.filter ? "No matches for the active literal filter." : `No ${view.activeView.toLocaleLowerCase()} entries in this active-checkout projection.`, width);
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
    const cue = "Enter details";
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
    pushDetail(lines, `  ${values.length - DETAIL_VALUE_CAP} additional retained values are not shown here; from the active checkout run picc plugin details ${identity} for the larger bounded standalone view.`, "muted");
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
  pushDetail(lines, `Lifecycle: owner ${safe(item.lifecycle?.ownership ?? "unknown", 60)} · active-checkout desired installed ${item.lifecycle?.installed ? "yes" : "no"} · declared ${item.lifecycle?.declared ? "explicit" : "derived/default"} · effective enabled ${item.lifecycle?.effectiveEnabled ? "yes" : "no"} · captured loaded ${item.lifecycle?.loaded ? "yes" : "no"}`);
  pushDetail(lines, `Eligibility: ${item.lifecycle?.availableActions.length ? item.lifecycle.availableActions.join(", ") : "none"}${item.lifecycle?.readOnlyReason ? ` · ${safe(item.lifecycle.readOnlyReason)}` : ""}`);
  pushDetail(lines, `Trust/content: trusted ${item.lifecycle?.trusted === undefined ? "unknown" : item.lifecycle.trusted ? "yes" : "no"} · revision ${safe(item.lifecycle?.immutableRevision ?? "not available", 100)} · integrity ${safe(item.lifecycle?.integrity ?? "not available", 100)}`);
  pushDetail(lines, `Pending/recovery: reload ${item.lifecycle?.pendingReload ? "pending" : "not pending"} · step ${safe(item.lifecycle?.pendingStep ?? "none", 120)} · recovery ${safe(item.lifecycle?.recoveryCommand ?? "none", 160)}`, item.lifecycle?.pendingReload || item.lifecycle?.pendingStep ? "warning" : "text");
  pushDetail(lines, `Dependency: ${safe(item.lifecycle?.dependency.state ?? "not evaluated", 60)}${item.lifecycle?.dependency.reason ? ` · ${safe(item.lifecycle.dependency.reason, 180)}` : ""}`);
  pushDetail(lines, `Scope: ${safe(item.lifecycle?.selectedScope ?? item.selectedInstallation?.scope ?? item.enablement?.scope ?? "not available", 80)} · mutable target ${safe(item.lifecycle?.mutableRecordKey ?? "not selected", 180)}`);
  addDetailValues(lines, "Scoped lifecycle candidates", (item.lifecycle?.candidates ?? []).map((value) => `${safe(value.scope, 60)} · ${value.selected ? "selected" : "candidate"} · key ${safe(value.mutableRecordKey, 200)} · trusted ${value.trusted === undefined ? "unknown" : value.trusted ? "yes" : "no"}`), identity, item.lifecycle?.selectionRequired ? "warning" : "text");
  pushDetail(lines, `Anchored location: root ${location(item.selectedInstallation?.root)} · desired root ${location(item.lifecycle?.root)} · project ${location(item.selectedInstallation?.project)} · data ${location(item.selectedInstallation?.data)}`);
  addDetailValues(lines, "Installation records", item.installations.map((value) => {
    const problems = value.problems.length ? value.problems.map((problem) => safe(problem, 100)).join(", ") : "none";
    const diagnostics = value.diagnostics.length ? value.diagnostics.map((diagnostic) => `${safe(diagnostic.severity, 30)}:${safe(diagnostic.message, 160)}`).join(", ") : "none";
    return `scope ${safe(value.scope ?? "not available", 80)} · version ${safe(value.version ?? "not available", 100)} · validity ${value.validity} · ${value.selected ? "selected" : "not selected"} · location ${location(value.location)} · project ${location(value.projectLocation)} · problems ${problems} · diagnostics ${diagnostics}`;
  }), identity, item.installations.some((value) => value.validity === "invalid") ? "warning" : "text");
  pushDetail(lines, `Captured runtime outcome: ${safe(item.outcome?.status ?? "not resolved", 80)}`, pluginStatusColor({ kind: "plugin", key: `plugin:${item.qualifiedIdentity}`, identity: item.qualifiedIdentity, item }));
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
  addDetailValues(lines, "Lifecycle operation guidance", (item.lifecycle?.lifecycleOperations ?? []).map((value) => `operation ${safe(value.operationId, 100)} · status ${value.status} · step ${safe(value.semanticStep, 160)} · category ${value.category} · target ${safe(value.target ?? "not attributed", 120)} · recovery ${safe(value.recoveryCommand, 160)}`), identity, "warning");
  addDetailValues(lines, "Retained lifecycle failures", item.lifecycle?.retainedErrors ?? [], identity, "warning");
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
    { text: `Ownership/scope: ${safe(value.ownership ?? "unknown", 80)} · ${safe(value.scope, 100)} · ${safe(value.origin, 100)}`, color: "text" },
    { text: `Eligibility: ${(value.availableActions ?? []).join(", ") || "inspect only"}${value.readOnlyReason ? ` · ${safe(value.readOnlyReason)}` : ""}`, color: value.readOnlyReason ? "warning" : "text" },
    { text: `Trust/target: ${value.trusted === undefined ? "unknown" : value.trusted ? "trusted" : "untrusted"} · ${safe(value.mutableRecordKey ?? "not selected", 180)}`, color: "text" },
    { text: `Scoped candidates: ${(value.candidates ?? []).map((candidate) => `${safe(candidate.scope, 50)}:${candidate.selected ? "selected" : "candidate"}:${safe(candidate.mutableRecordKey, 120)}`).join(" · ") || "none"}`, color: value.selectionRequired ? "warning" : "text" },
    { text: `Pending: ${safe(value.pendingStep ?? "none", 160)}`, color: value.pendingStep ? "warning" : "text" },
    ...(value.lifecycleOperations ?? []).map((operation) => ({ text: `Lifecycle operation: ${safe(operation.operationId, 100)} · ${operation.status} · step ${safe(operation.semanticStep, 160)} · category ${operation.category} · target ${safe(operation.target ?? "not attributed", 120)} · recovery ${safe(operation.recoveryCommand, 160)}`, color: "warning" })),
    { text: `Fixture contract: ${safe(value.fixtureContract ?? "not declared", 80)}`, color: "text" },
    { text: `Anchored catalog location: ${location(value.catalog)}`, color: "text" },
    { text: `Source fields: ${formatPluginInventoryStructuredSource(value.source)}`, color: "text" },
    { text: `Source provenance: ${provenance(value.sourceProvenance)}`, color: "text" },
    { text: `Registration provenance: ${provenance(value.provenance)}`, color: "text" },
    { text: "Passive eligibility only; this view never invokes, confirms, or collects input for lifecycle services.", color: "muted" },
  ];
}
function globalLifecycleDetail(view: PluginInventoryModelView): DetailLine[] {
  const detail = view.detail;
  if (!detail || detail.kind !== "global-lifecycle") return [];
  const value = detail.operation;
  return [
    { text: "Unattributed lifecycle evidence", color: "accent" },
    { text: `Operation id: ${safe(value.operationId, 100)}`, color: "warning" },
    { text: `Status: ${safe(value.status, 60)}`, color: "warning" },
    { text: `Semantic step: ${safe(value.semanticStep, 160)}`, color: "warning" },
    { text: `Recovery category: ${value.category}`, color: "warning" },
    { text: `Target: ${safe(value.target ?? "not attributed", 120)}`, color: "warning" },
    { text: `Observational recovery command: ${safe(value.recoveryCommand, 160)}`, color: "warning" },
    { text: "Passive observation only; this view performs no I/O and never invokes lifecycle recovery.", color: "muted" },
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
function workflowPreviewLines(state: Extract<PluginInventoryWorkflow, { phase: "preview" | "confirmation" }>): DetailLine[] {
  const p = state.projection; const values: DetailLine[] = [];
  pushDetail(values, `${state.phase === "confirmation" ? "Final confirmation" : "Lifecycle preview"}: ${p.action}`, "accent");
  pushDetail(values, `Operation id: ${safe(p.operationId, 128)}`, "warning"); pushDetail(values, `Target: ${safe(p.target, 320)}`); pushDetail(values, `Exact scope/selector authority: ${safe(p.authority, 1200)}`, "warning"); pushDetail(values, `Redacted source authority: ${safe(p.sourceAuthority, 400)}`);
  const groups: readonly [string, readonly string[], DetailLine["color"]][] = [
    ["Immutable resolution", p.resolution, "text"], ["Critical trust", p.trust, "warning"], ["Dependency posture", p.dependencies, "text"], ["Settings/effective/default", p.settings, "text"], ["Executable components", p.executable, "warning"], ["Destructive choices", p.destructive, "warning"], ["Participants", p.participants, "text"], ["Consequences", p.consequences, "text"], ["Current-session behavior", p.sessionBehavior, "warning"], ["Recovery", p.recovery, "warning"],
  ];
  for (const [label, entries, color] of groups) { pushDetail(values, `${label}: ${entries.length === 0 ? "none" : `${entries.length} item(s)`}`, color); for (const entry of entries) pushDetail(values, `${label}: ${safe(entry, 1400)}`, color); }
  if (p.omissions > 0) pushDetail(values, `${p.omissions} required values are missing, unsupported, oversized, truncated, or unrenderable. Confirmation is disabled.`, "error");
  return values;
}

function renderWorkflow(state: PluginInventoryWorkflow, theme: unknown, width: number, lines: string[]): number {
  if (state.phase === "select-action") { addWrapped(lines, theme, "accent", "Choose lifecycle action", width); state.actions.forEach((action, index) => addWrapped(lines, theme, index === state.selected ? "accent" : "text", `${index === state.selected ? ">" : " "} ${action}`, width)); addWrapped(lines, theme, "muted", "↑/↓ select · Enter continue · Esc cancel", width); return 0; }
  if (state.phase === "select-candidate") { addWrapped(lines, theme, "accent", `Choose exact candidate · ${safe(state.targetIdentity, 256)}`, width); state.candidates.forEach((candidate, index) => addWrapped(lines, theme, index === state.selected ? "accent" : "text", `${index === state.selected ? ">" : " "} ${safe(candidate.label, 256)}`, width)); addWrapped(lines, theme, "muted", "↑/↓ select · Enter bind exact record · Esc cancel", width); return 0; }
  if (state.phase === "input") { addWrapped(lines, theme, "accent", `${state.action} · ${state.field}`, width); addWrapped(lines, theme, state.invalid ? "error" : "muted", state.invalid ?? state.hint, width); addWrapped(lines, theme, "text", state.entered ? "Value entered (private; hidden from rendering and transcript)" : "Type value, then Enter", width); addWrapped(lines, theme, "muted", "Backspace edits · Left/Shift-Tab goes Back · Esc cancels", width); return 0; }
  if (state.phase === "planning") { addWrapped(lines, theme, "accent", `Planning ${state.action}…`, width); addWrapped(lines, theme, "muted", "Resolving immutable acquisition and preview evidence · Esc cancels", width); return 0; }
  if (state.phase === "preview" || state.phase === "confirmation") { const raw = workflowPreviewLines(state); const body: string[] = []; raw.forEach((value) => addWrapped(body, theme, value.color, value.text, width)); const max = Math.max(0, body.length - DETAIL_WINDOW); const scroll = Math.min(max, state.detailScroll); if (scroll > 0) addWrapped(lines, theme, "muted", `↑ ${scroll} confirmation lines above`, width); lines.push(...body.slice(scroll, scroll + DETAIL_WINDOW)); if (body.length > scroll + DETAIL_WINDOW) addWrapped(lines, theme, "muted", `↓ ${body.length - scroll - DETAIL_WINDOW} confirmation lines below`, width); addWrapped(lines, theme, state.confirmationEnabled ? "warning" : "error", state.confirmationEnabled ? (state.phase === "preview" ? "Enter opens final confirmation · Esc discards" : "Enter commits this visible projection · Esc discards") : "Confirmation disabled: required evidence omitted", width); return max; }
  if (state.phase === "cancelling") { addWrapped(lines, theme, "warning", state.message, width); addWrapped(lines, theme, "muted", "Confirmation is unavailable while staging is discarded.", width); return 0; }
  if (state.phase === "progress") { addWrapped(lines, theme, "accent", `Executing ${state.action} · ${safe(state.operationId, 128)}`, width); addWrapped(lines, theme, "warning", state.cancellationRequested ? "Esc intent was recorded locally after execution began; it was not sent as an execution cancellation. Waiting for authoritative receipt or recovery evidence; no rollback is claimed." : "Commit progress is authoritative; Esc records local intent and waits, but does not cancel execution or erase committed steps.", width); return 0; }
  if (state.phase === "receipt") { const target = state.receipt.target === undefined ? "" : ` · ${safe(state.receipt.target, 256)}`; addWrapped(lines, theme, state.receipt.outcome === "committed" ? "success" : "warning", `${state.receipt.kind === "plugin" ? "Plugin" : "Marketplace"} lifecycle receipt${target} · ${safe(state.operationId, 128)} · ${state.receipt.outcome} · completed ${state.receipt.completed}`, width); const truth = state.receipt.outcome === "committed" ? state.receipt.kind === "plugin" ? "Durable desired plugin state changed. Loaded runtime badges remain fixed until /reload-plugins succeeds or PiCC restarts." : "Durable marketplace state changed. Installed plugin code and loaded runtime are unchanged." : state.receipt.outcome === "rolled-back" ? "The operation rolled back; no committed desired change is claimed." : "The operation failed before commit; no committed desired change is claimed."; addWrapped(lines, theme, state.pendingReload ? "warning" : "text", truth, width); if (state.projectionFailure) addWrapped(lines, theme, "error", state.projectionFailure, width); addWrapped(lines, theme, "muted", "Enter returns to inventory.", width); return 0; }
  if (state.phase === "terminal-fallback") { addWrapped(lines, theme, "warning", `Lifecycle outcome · ${safe(state.operationId, 128)}`, width); addWrapped(lines, theme, "warning", state.message, width); if (state.recoveryCommand) addWrapped(lines, theme, "accent", state.recoveryCommand, width); return 0; }
  addWrapped(lines, theme, state.phase === "pending-recovery" ? "warning" : "error", `${state.phase === "pending-recovery" ? "Pending recovery" : state.phase === "refused" ? "Lifecycle refused" : "Lifecycle failed"}${"operationId" in state && state.operationId ? ` · ${safe(state.operationId, 128)}` : ""}`, width); addWrapped(lines, theme, "warning", workflowMessage("message" in state ? state.message : "Lifecycle state is unavailable"), width); addWrapped(lines, theme, "muted", state.phase === "pending-recovery" ? `Exact fallback from the active checkout: picc plugin recover ${state.operationId}` : "Enter returns; no unconfirmed action will execute.", width); return 0;
}

function renderDetail(view: PluginInventoryModelView, theme: unknown, width: number, lines: string[]): number {
  const raw = view.detail?.kind === "plugin" ? pluginDetail(view) : view.detail?.kind === "marketplace" ? marketplaceDetail(view) : view.detail?.kind === "global-lifecycle" ? globalLifecycleDetail(view) : globalDiagnosticDetail(view);
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
    const phase = view.workflow?.phase;
    const postConfirmation = phase !== undefined && ["progress", "receipt", "pending-recovery", "terminal-fallback"].includes(phase);
    const framing = phase === undefined ? "captured loaded + active desired" : postConfirmation ? "Explicit confirmation authorized execution; receipt or recovery evidence is authoritative." : "Active workflow; candidate acquisition or staging may occur during planning; lifecycle transaction execution and durable desired-state commit require confirmation.";
    for (const value of ["PiCC plugin inventory", framing, "width unusable", "resize wider", "Esc closes"]) addWrapped(lines, options.theme, "warning", value, width);
    return { lines: clampLines(lines, width), maxDetailScroll: 0, selectedVisible: false };
  }
  framing(view, options.theme, width, lines);
  tabs(view, options.theme, width, lines);
  let maxDetailScroll = 0;
  let selectedVisible = false;
  if (view.workflow) maxDetailScroll = renderWorkflow(view.workflow, options.theme, width, lines);
  else if (view.detail) {
    if (view.filter) addWrapped(lines, options.theme, "accent", `Active filter: ${safe(view.filter)}`, width);
    maxDetailScroll = renderDetail(view, options.theme, width, lines);
    renderOmissions(view, options.theme, width, lines);
  } else selectedVisible = renderList(view, options.theme, width, lines);
  if (!view.workflow) addWrapped(lines, options.theme, "muted", view.detail
    ? "↑/↓ scroll · Esc leaves details · then Esc clears filter · then Esc closes · re-open /plugin, or from active checkout: picc plugin list · picc plugin details <qualified-name>"
    : "←/→ or Tab/Shift-Tab views · ↑/↓ select · type literal filter · Backspace edit · Enter details · Esc clear/close · re-open /plugin, or from active checkout: picc plugin list", width);
  if (!view.workflow) addWrapped(lines, options.theme, "muted", "A opens eligible lifecycle actions.", width);
  const safeLines = clampLines(lines, width).map((line) => {
    try { return visibleWidth(line) <= width ? line : ""; } catch { return ""; }
  });
  return { lines: safeLines, maxDetailScroll, selectedVisible };
}

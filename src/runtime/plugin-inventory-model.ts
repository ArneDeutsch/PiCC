import type {
  PluginInventoryDiagnostic,
  PluginInventoryItem,
  PluginInventoryLifecycleOperation,
  PluginInventoryMarketplace,
  PluginInventorySnapshot,
} from "../plugin-inventory.js";
import { parseQualifiedPluginId } from "../util/plugin-id.js";

export const PLUGIN_INVENTORY_VIEWS = ["Discover", "Installed", "Marketplaces", "Errors"] as const;
export type PluginInventoryViewName = typeof PLUGIN_INVENTORY_VIEWS[number];

const FILTER_CAP = 256;
const ROW_CAP = 512;

export type PluginInventoryRow =
  | { readonly key: `plugin:${string}`; readonly kind: "plugin"; readonly identity: string; readonly item: PluginInventoryItem }
  | { readonly key: `marketplace:${string}`; readonly kind: "marketplace"; readonly identity: string; readonly marketplace: PluginInventoryMarketplace }
  | { readonly key: `global-lifecycle:${string}`; readonly kind: "global-lifecycle"; readonly identity: string; readonly operation: PluginInventoryLifecycleOperation }
  | { readonly key: `global-diagnostic:${string}`; readonly kind: "global-diagnostic"; readonly identity: string; readonly diagnostic: PluginInventoryDiagnostic };

export type PluginInventoryDetailTarget =
  | { readonly kind: "plugin"; readonly key: string; readonly identity: string; readonly item: PluginInventoryItem }
  | { readonly kind: "marketplace"; readonly key: string; readonly identity: string; readonly marketplace: PluginInventoryMarketplace }
  | { readonly kind: "global-lifecycle"; readonly key: string; readonly identity: string; readonly operation: PluginInventoryLifecycleOperation }
  | { readonly kind: "global-diagnostic"; readonly key: string; readonly identity: string; readonly diagnostic: PluginInventoryDiagnostic };

export interface PluginInventoryActionOverlay {
  readonly operationId: string; readonly phase: "preview" | "confirming" | "running" | "pending-recovery" | "completed" | "failed" | "reload-required" | "reload-unconfirmed";
  readonly target?: string; readonly message?: string; readonly receiptOutcome?: "committed" | "rolled-back" | "failed-before-commit";
  readonly recoveryCommand?: string; readonly updatedAt: string;
}
export interface PluginInventoryModelView {
  readonly activeView: PluginInventoryViewName;
  readonly activeViewIndex: number;
  readonly filter: string;
  readonly rows: readonly PluginInventoryRow[];
  readonly selectedKey?: string;
  readonly selectedIndex: number;
  readonly detail?: PluginInventoryDetailTarget;
  readonly detailScroll: number;
  readonly warning?: string;
  /** Rows retained by the snapshot but hidden by this local row cap. */
  readonly locallyOmittedRows: number;
  /** Upstream snapshot-capture evidence omissions, kept separate from rows. */
  readonly captureOmissions: readonly { readonly axis: string; readonly count: number }[];
  readonly policyObservations: PluginInventorySnapshot["policyObservations"];
  readonly loadedSnapshot: PluginInventorySnapshot;
  readonly durableDesired: PluginInventorySnapshot;
  readonly actionOverlay?: PluginInventoryActionOverlay;
}

const FAILURE_STATUSES = new Set(["enabled-but-uninstalled", "unsupported", "ambiguous", "blocked", "malformed", "rejected"]);

function itemHasError(item: PluginInventoryItem): boolean {
  return item.diagnostics.some((value) => value.severity === "error" || value.severity === "warning") ||
    (item.outcome?.status !== undefined && FAILURE_STATUSES.has(item.outcome.status)) ||
    (item.installations.length === 0 && (item.enablement?.enabled === true || item.outcome !== undefined)) || item.lifecycle?.pendingStep !== undefined || (item.lifecycle?.retainedErrors.length ?? 0) > 0;
}

function itemSearchText(item: PluginInventoryItem): string {
  return [
    item.qualifiedIdentity, item.lifecycleName, item.marketplaceName, item.manifestNamespace,
    item.metadata?.manifestName, item.metadata?.version, item.metadata?.description, item.outcome?.status,
    item.lifecycle?.ownership, item.lifecycle?.selectedScope, item.lifecycle?.pendingStep, item.lifecycle?.readOnlyReason, item.lifecycle?.dependency.state,
    ...(item.lifecycle?.retainedErrors ?? []), ...item.diagnostics.flatMap((value) => [value.severity, value.category, value.sourceClass, value.impact, value.message]),
  ].filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase();
}

function marketplaceSearchText(value: PluginInventoryMarketplace): string {
  return [value.name, value.scope, value.origin, value.validity, value.ownership, value.readOnlyReason, value.pendingStep, ...(value.availableActions ?? []), ...Object.values(value.source)].filter((item): item is string => typeof item === "string").join(" ").toLocaleLowerCase();
}

function stableProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableProjection);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, stableProjection(field)]));
  }
  return value;
}

function marketplaceSignature(value: PluginInventoryMarketplace): string {
  return JSON.stringify(stableProjection(value));
}

function diagnosticSignature(value: PluginInventoryDiagnostic): string {
  return JSON.stringify([value.severity, value.category ?? "", value.sourceClass ?? "", value.impact ?? "", value.message]);
}

function lifecycleOperationSignature(value: PluginInventoryLifecycleOperation): string {
  return JSON.stringify([value.operationId, value.status, value.semanticStep, value.category, value.target ?? "", value.recoveryCommand]);
}

function desiredWithCapturedRuntime(loaded: PluginInventorySnapshot, desired: PluginInventorySnapshot): PluginInventorySnapshot {
  const capturedById = new Map(loaded.items.map((item) => [item.qualifiedIdentity, item]));
  const compose = (desiredItem: PluginInventoryItem | undefined, captured: PluginInventoryItem | undefined): PluginInventoryItem => {
    const item = desiredItem ?? captured!;
    const capturedLoaded = captured?.lifecycle?.loaded ?? captured?.outcome?.status === "loaded";
    const desiredGeneration = desired.durableDesired?.generationId; const generationDiverged = desiredGeneration !== undefined && desiredGeneration !== loaded.loadedGenerationId;
    const desiredActivation = desiredItem?.lifecycle?.installed === true && desiredItem.lifecycle.effectiveEnabled === true && desiredItem.lifecycle.dependency.state === "satisfied";
    const pendingReload = generationDiverged || capturedLoaded && desiredItem?.lifecycle?.installed !== true || desiredActivation !== capturedLoaded;
    const desiredLifecycle = desiredItem?.lifecycle;
    const lifecycle = desiredLifecycle !== undefined
      ? Object.freeze({ ...desiredLifecycle, loaded: capturedLoaded, pendingReload })
      : captured?.lifecycle === undefined ? undefined : Object.freeze({ ...captured.lifecycle, availableActions: Object.freeze([]), installed: false, declared: false, effectiveEnabled: undefined, loaded: capturedLoaded, pendingReload, readOnlyReason: "No durable desired lifecycle target is present" });
    const capturedManifestComponents = captured?.components.filter((component) => component.origin === "selected-manifest") ?? [];
    const capturedRuntimeComponents = captured?.components.filter((component) => component.origin === "final-runtime") ?? [];
    const desiredCatalogComponents = desiredItem?.components.filter((component) => component.origin === "catalog") ?? [];
    const components = Object.freeze([...capturedManifestComponents, ...desiredCatalogComponents, ...capturedRuntimeComponents]);
    const executionRisk = Object.freeze([...new Set(components.map((component) => component.executionRisk))].sort());
    const capturedManifestDependencies = captured?.dependencies.filter((dependency) => dependency.origin === "selected-manifest") ?? [];
    const desiredCatalogDependencies = desiredItem?.dependencies.filter((dependency) => dependency.origin === "catalog") ?? [];
    const dependencies = Object.freeze([...capturedManifestDependencies, ...desiredCatalogDependencies]);
    const { outcome: _outcome, lifecycle: _lifecycle, selectedInstallation: _selectedInstallation, components: _components, executionRisk: _executionRisk, dependencies: _dependencies, manifestNamespace: _manifestNamespace, metadata: _metadata, ...baseAxes } = item;
    const desiredAxes = desiredItem === undefined ? { ...baseAxes, catalogPresence: false, installations: Object.freeze([]), catalogDeclarations: Object.freeze([]), renames: Object.freeze([]), diagnostics: Object.freeze([]) } : baseAxes;
    return Object.freeze({ ...desiredAxes, ...(captured?.manifestNamespace === undefined ? {} : { manifestNamespace: captured.manifestNamespace }), ...(captured?.metadata === undefined ? {} : { metadata: captured.metadata }), ...(captured?.selectedInstallation === undefined ? {} : { selectedInstallation: captured.selectedInstallation }), ...(captured?.outcome === undefined ? {} : { outcome: captured.outcome }), dependencies, components, executionRisk, ...(lifecycle === undefined ? {} : { lifecycle }) });
  };
  const desiredIds = new Set(desired.items.map((item) => item.qualifiedIdentity));
  const items = Object.freeze([
    ...desired.items.map((item) => compose(item, capturedById.get(item.qualifiedIdentity))),
    ...loaded.items.filter((item) => !desiredIds.has(item.qualifiedIdentity)).map((item) => compose(undefined, item)),
  ]);
  const index = new Map(items.map((item) => [item.qualifiedIdentity, item]));
  const { loadedGenerationId: _desiredLoadedGenerationId, ...desiredAxes } = desired;
  return Object.freeze({ ...desiredAxes, ...(loaded.loadedGenerationId === undefined ? {} : { loadedGenerationId: loaded.loadedGenerationId }), items, find: (identity: string) => index.get(identity) });
}

function keyedByOccurrence<T>(values: readonly T[], signature: (value: T) => string): { value: T; keyPart: string }[] {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const base = signature(value);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { value, keyPart: `${encodeURIComponent(base)}:${occurrence}` };
  });
}

/** Pure state machine for tabs, literal filtering, stable selection, detail and scroll. */
export class PluginInventoryModel {
  private readonly snapshot: PluginInventorySnapshot;
  private desiredSnapshot: PluginInventorySnapshot;
  private overlay?: PluginInventoryActionOverlay;
  private viewIndex = 0;
  private filterText = "";
  private selected?: string;
  private detailTarget?: PluginInventoryDetailTarget;
  private scroll = 0;
  private warningText?: string;
  private revisionNumber = 0;

  constructor(snapshot: PluginInventorySnapshot, durableDesired: PluginInventorySnapshot = snapshot) { this.snapshot = snapshot; this.desiredSnapshot = durableDesired === snapshot ? snapshot : desiredWithCapturedRuntime(snapshot, durableDesired); this.reconcile(); }

  replaceDurableDesired(snapshot: PluginInventorySnapshot): void { if (snapshot === this.desiredSnapshot) return; this.desiredSnapshot = desiredWithCapturedRuntime(this.snapshot, snapshot); this.detailTarget = undefined; this.scroll = 0; this.reconcile(); this.bump(); }
  setActionOverlay(value: PluginInventoryActionOverlay | undefined): void {
    if (value === undefined) { if (this.overlay === undefined) return; this.overlay = undefined; this.bump(); return; }
    const token = (text: string, fallback: string): string => /^[A-Za-z0-9._:@/+ -]{1,256}$/u.test(text) ? text : fallback;
    this.overlay = Object.freeze({ operationId: token(value.operationId, "unknown-operation"), phase: value.phase, ...(value.target === undefined ? {} : { target: token(value.target, "unknown target") }), ...(value.message === undefined ? {} : { message: [...value.message.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")].slice(0, 512).join("") }), ...(value.receiptOutcome === undefined ? {} : { receiptOutcome: value.receiptOutcome }), ...(value.recoveryCommand === undefined ? {} : { recoveryCommand: token(value.recoveryCommand, "inspect lifecycle recovery") }), updatedAt: token(value.updatedAt, "unknown") }); this.bump();
  }

  revision(): number { return this.revisionNumber; }
  filter(): string { return this.filterText; }
  inDetail(): boolean { return this.detailTarget !== undefined; }

  setView(index: number): void {
    const next = ((Math.trunc(index) % PLUGIN_INVENTORY_VIEWS.length) + PLUGIN_INVENTORY_VIEWS.length) % PLUGIN_INVENTORY_VIEWS.length;
    if (next === this.viewIndex) return;
    this.viewIndex = next;
    this.detailTarget = undefined;
    this.scroll = 0;
    this.warningText = undefined;
    this.reconcile();
    this.bump();
  }
  moveView(delta: number): void { this.setView(this.viewIndex + delta); }

  appendFilter(value: string): void {
    const printable = [...value].filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    });
    if (printable.length === 0) return;
    const next = [...this.filterText, ...printable].slice(0, FILTER_CAP).join("");
    if (next === this.filterText) return;
    this.filterText = next;
    this.detailTarget = undefined;
    this.scroll = 0;
    this.reconcile();
    this.bump();
  }
  backspaceFilter(): void {
    if (!this.filterText) return;
    this.filterText = [...this.filterText].slice(0, -1).join("");
    this.reconcile();
    this.bump();
  }
  clearFilter(): boolean {
    if (!this.filterText) return false;
    this.filterText = "";
    this.reconcile();
    this.bump();
    return true;
  }

  moveSelection(delta: number): void {
    const rows = this.rows().rows;
    if (rows.length === 0) return;
    const found = rows.findIndex((row) => row.key === this.selected);
    const current = found < 0 ? 0 : found;
    const next = Math.max(0, Math.min(rows.length - 1, current + Math.trunc(delta)));
    if (rows[next]!.key === this.selected) return;
    this.selected = rows[next]!.key;
    this.warningText = undefined;
    this.bump();
  }

  enterDetail(): "entered" | "stale" | "unavailable" {
    const row = this.rows().rows.find((value) => value.key === this.selected);
    if (!row) return "stale";
    let target: PluginInventoryDetailTarget | undefined;
    if (row.kind === "plugin") {
      let current: PluginInventoryItem | undefined;
      try { current = this.desiredSnapshot.find(row.identity); } catch { current = undefined; }
      if (!current || current.qualifiedIdentity !== row.identity) return "stale";
      target = { kind: "plugin", key: row.key, identity: row.identity, item: current };
    } else if (row.kind === "marketplace") {
      const current = this.marketplaceRows().find((value) => value.key === row.key);
      if (!current) return "stale";
      target = { kind: "marketplace", key: current.key, identity: current.identity, marketplace: current.marketplace };
    } else if (row.kind === "global-lifecycle") {
      const current = this.globalLifecycleRows().find((value) => value.key === row.key);
      if (!current) return "stale";
      target = Object.freeze({ kind: "global-lifecycle", key: current.key, identity: current.identity, operation: current.operation });
    } else {
      const current = this.globalDiagnosticRows().find((value) => value.key === row.key);
      if (!current) return "stale";
      target = { kind: "global-diagnostic", key: current.key, identity: current.identity, diagnostic: current.diagnostic };
    }
    this.detailTarget = target;
    this.scroll = 0;
    this.warningText = undefined;
    this.bump();
    return "entered";
  }

  leaveDetail(): boolean {
    if (!this.detailTarget) return false;
    this.detailTarget = undefined;
    this.scroll = 0;
    this.bump();
    return true;
  }
  scrollDetail(delta: number): void {
    if (!this.detailTarget || !Number.isFinite(delta)) return;
    const next = Math.max(0, this.scroll + Math.trunc(delta));
    if (next === this.scroll) return;
    this.scroll = next;
    this.bump();
  }
  setDetailScroll(value: number): void {
    const next = Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
    if (next !== this.scroll) { this.scroll = next; this.bump(); }
  }

  failDetail(identity?: string): void {
    this.detailTarget = undefined;
    this.scroll = 0;
    this.warningText = parseQualifiedPluginId(identity) !== undefined
      ? `Plugin details display failed for ${identity}. Esc closes. Use /plugin list or run /plugin details ${identity}`
      : "Plugin details display failed. Esc closes. Use /plugin list, then /plugin details <qualified-name>.";
    this.bump();
  }
  failSurface(): void {
    this.detailTarget = undefined;
    this.scroll = 0;
    this.warningText = "Plugin inventory display failed; the read-only list remains available. Esc closes. Use /plugin list or /plugin details <qualified-name>.";
    this.bump();
  }

  view(): PluginInventoryModelView {
    const result = this.rows();
    const index = result.rows.findIndex((row) => row.key === this.selected);
    return {
      activeView: PLUGIN_INVENTORY_VIEWS[this.viewIndex]!, activeViewIndex: this.viewIndex,
      filter: this.filterText, rows: result.rows, selectedKey: this.selected, selectedIndex: index,
      ...(this.detailTarget === undefined ? {} : { detail: this.detailTarget }), detailScroll: this.scroll,
      ...(this.warningText === undefined ? {} : { warning: this.warningText }),
      locallyOmittedRows: result.omitted,
      captureOmissions: Object.entries(this.desiredSnapshot.omissions)
        .filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && entry[1] > 0)
        .sort(([a], [b]) => a.localeCompare(b)).map(([axis, count]) => ({ axis, count })),
      policyObservations: this.desiredSnapshot.policyObservations,
      loadedSnapshot: this.snapshot, durableDesired: this.desiredSnapshot,
      ...(this.overlay === undefined ? {} : { actionOverlay: this.overlay }),
    };
  }

  private marketplaceRows(): Extract<PluginInventoryRow, { kind: "marketplace" }>[] {
    return keyedByOccurrence(this.desiredSnapshot.marketplaces, marketplaceSignature).map(({ value, keyPart }) => ({
      key: `marketplace:${keyPart}`, kind: "marketplace", identity: value.name, marketplace: value,
    }));
  }
  private globalLifecycleRows(): Extract<PluginInventoryRow, { kind: "global-lifecycle" }>[] {
    const attributed = new Set([
      ...this.desiredSnapshot.items.flatMap((item) => item.lifecycle?.lifecycleOperations?.map((value) => value.operationId) ?? []),
      ...this.desiredSnapshot.marketplaces.flatMap((marketplace) => marketplace.lifecycleOperations?.map((value) => value.operationId) ?? []),
    ]);
    const operations: PluginInventoryLifecycleOperation[] = [
      ...(this.desiredSnapshot.durableDesired?.pendingOperations ?? []),
      ...(this.desiredSnapshot.durableDesired?.terminalOperations.flatMap((value) => value.outcome === "failed-before-commit" && value.recoveryCommand !== undefined
        ? [Object.freeze({ operationId: value.operationId, status: value.outcome, semanticStep: value.semanticStep, ...(value.target === undefined ? {} : { target: value.target }), recoveryCommand: value.recoveryCommand, category: value.category ?? "inspect" as const })]
        : []) ?? []),
    ].filter((value) => !attributed.has(value.operationId));
    return keyedByOccurrence(operations, lifecycleOperationSignature).map(({ value, keyPart }) => Object.freeze({
      key: `global-lifecycle:${keyPart}`, kind: "global-lifecycle", identity: `Lifecycle · ${value.operationId}`, operation: value,
    }));
  }
  private globalDiagnosticRows(): Extract<PluginInventoryRow, { kind: "global-diagnostic" }>[] {
    return keyedByOccurrence(this.desiredSnapshot.diagnostics, diagnosticSignature).map(({ value, keyPart }) => ({
      key: `global-diagnostic:${keyPart}`, kind: "global-diagnostic", identity: `Global · ${value.category ?? "uncategorized"} · ${value.sourceClass ?? "unknown source"}`, diagnostic: value,
    }));
  }
  private rows(): { rows: PluginInventoryRow[]; omitted: number } {
    let values: PluginInventoryRow[];
    if (this.viewIndex === 2) values = this.marketplaceRows();
    else {
      const items = this.desiredSnapshot.items.filter((item) => this.viewIndex === 0 ? item.catalogPresence || item.lifecycle?.installed === false
        : this.viewIndex === 1 ? item.installations.length > 0 || item.lifecycle?.installed === true
          : itemHasError(item));
      values = items.map((item) => ({ key: `plugin:${item.qualifiedIdentity}`, kind: "plugin", identity: item.qualifiedIdentity, item }));
      if (this.viewIndex === 3) values.push(...this.globalLifecycleRows(), ...this.globalDiagnosticRows());
    }
    const needle = this.filterText.toLocaleLowerCase();
    if (needle) values = values.filter((row) => row.kind === "plugin" ? itemSearchText(row.item).includes(needle)
      : row.kind === "marketplace" ? marketplaceSearchText(row.marketplace).includes(needle)
        : row.kind === "global-lifecycle" ? [row.identity, row.operation.status, row.operation.semanticStep, row.operation.category, row.operation.target ?? "not attributed", row.operation.recoveryCommand].join(" ").toLocaleLowerCase().includes(needle)
          : [row.identity, row.diagnostic.severity, row.diagnostic.impact, row.diagnostic.message].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle));
    const omitted = Math.max(0, values.length - ROW_CAP);
    return { rows: values.slice(0, ROW_CAP), omitted };
  }
  private reconcile(): void {
    const rows = this.rows().rows;
    if (!rows.some((row) => row.key === this.selected)) this.selected = rows[0]?.key;
    if (this.detailTarget && !rows.some((row) => row.key === this.detailTarget?.key)) {
      this.detailTarget = undefined;
      this.scroll = 0;
    }
  }
  private bump(): void { this.revisionNumber += 1; }
}

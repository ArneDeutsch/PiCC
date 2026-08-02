import type {
  PluginInventoryDiagnostic,
  PluginInventoryItem,
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
  | { readonly key: `global-diagnostic:${string}`; readonly kind: "global-diagnostic"; readonly identity: string; readonly diagnostic: PluginInventoryDiagnostic };

export type PluginInventoryDetailTarget =
  | { readonly kind: "plugin"; readonly key: string; readonly identity: string; readonly item: PluginInventoryItem }
  | { readonly kind: "marketplace"; readonly key: string; readonly identity: string; readonly marketplace: PluginInventoryMarketplace }
  | { readonly kind: "global-diagnostic"; readonly key: string; readonly identity: string; readonly diagnostic: PluginInventoryDiagnostic };

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
}

const FAILURE_STATUSES = new Set(["enabled-but-uninstalled", "unsupported", "ambiguous", "blocked", "malformed", "rejected"]);

function itemHasError(item: PluginInventoryItem): boolean {
  return item.diagnostics.some((value) => value.severity === "error" || value.severity === "warning") ||
    (item.outcome?.status !== undefined && FAILURE_STATUSES.has(item.outcome.status)) ||
    (item.installations.length === 0 && (item.enablement?.enabled === true || item.outcome !== undefined));
}

function itemSearchText(item: PluginInventoryItem): string {
  return [
    item.qualifiedIdentity, item.lifecycleName, item.marketplaceName, item.manifestNamespace,
    item.metadata?.manifestName, item.metadata?.version, item.metadata?.description, item.outcome?.status,
    ...item.diagnostics.flatMap((value) => [value.severity, value.category, value.sourceClass, value.impact, value.message]),
  ].filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase();
}

function marketplaceSearchText(value: PluginInventoryMarketplace): string {
  return [value.name, value.scope, value.origin, value.validity, ...Object.values(value.source)].join(" ").toLocaleLowerCase();
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
  private viewIndex = 0;
  private filterText = "";
  private selected?: string;
  private detailTarget?: PluginInventoryDetailTarget;
  private scroll = 0;
  private warningText?: string;
  private revisionNumber = 0;

  constructor(snapshot: PluginInventorySnapshot) { this.snapshot = snapshot; this.reconcile(); }

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
      try { current = this.snapshot.find(row.identity); } catch { current = undefined; }
      if (!current || current.qualifiedIdentity !== row.identity) return "stale";
      target = { kind: "plugin", key: row.key, identity: row.identity, item: current };
    } else if (row.kind === "marketplace") {
      const current = this.marketplaceRows().find((value) => value.key === row.key);
      if (!current) return "stale";
      target = { kind: "marketplace", key: current.key, identity: current.identity, marketplace: current.marketplace };
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
      captureOmissions: Object.entries(this.snapshot.omissions)
        .filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && entry[1] > 0)
        .sort(([a], [b]) => a.localeCompare(b)).map(([axis, count]) => ({ axis, count })),
      policyObservations: this.snapshot.policyObservations,
    };
  }

  private marketplaceRows(): Extract<PluginInventoryRow, { kind: "marketplace" }>[] {
    return keyedByOccurrence(this.snapshot.marketplaces, marketplaceSignature).map(({ value, keyPart }) => ({
      key: `marketplace:${keyPart}`, kind: "marketplace", identity: value.name, marketplace: value,
    }));
  }
  private globalDiagnosticRows(): Extract<PluginInventoryRow, { kind: "global-diagnostic" }>[] {
    return keyedByOccurrence(this.snapshot.diagnostics, diagnosticSignature).map(({ value, keyPart }) => ({
      key: `global-diagnostic:${keyPart}`, kind: "global-diagnostic", identity: `Global · ${value.category ?? "uncategorized"} · ${value.sourceClass ?? "unknown source"}`, diagnostic: value,
    }));
  }
  private rows(): { rows: PluginInventoryRow[]; omitted: number } {
    let values: PluginInventoryRow[];
    if (this.viewIndex === 2) values = this.marketplaceRows();
    else {
      const items = this.snapshot.items.filter((item) => this.viewIndex === 0 ? item.catalogPresence
        : this.viewIndex === 1 ? item.installations.length > 0
          : itemHasError(item));
      values = items.map((item) => ({ key: `plugin:${item.qualifiedIdentity}`, kind: "plugin", identity: item.qualifiedIdentity, item }));
      if (this.viewIndex === 3) values.push(...this.globalDiagnosticRows());
    }
    const needle = this.filterText.toLocaleLowerCase();
    if (needle) values = values.filter((row) => row.kind === "plugin" ? itemSearchText(row.item).includes(needle)
      : row.kind === "marketplace" ? marketplaceSearchText(row.marketplace).includes(needle)
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

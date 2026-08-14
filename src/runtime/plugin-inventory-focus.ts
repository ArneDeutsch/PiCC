import { createHash } from "node:crypto";
import type { PluginInventorySnapshot } from "../plugin-inventory.js";
import type { MarketplaceMutationPreview } from "../plugin-lifecycle/planner.js";
import type { PluginMutationPreview } from "../plugin-lifecycle/plugin-service.js";
import type { RecoveryPreview } from "../plugin-lifecycle/recovery.js";
import type { PluginSettingsEffectSummary, SettingsValueState } from "../plugin-lifecycle/settings-plan.js";
import type { StoreResult } from "../plugin-lifecycle/state-store.js";
import type { PluginLifecycleExactTarget, PluginLifecyclePort, PluginLifecycleReceipt } from "../plugin-inventory-cli.js";
import type { PluginInventoryOperation } from "./plugin-inventory-text.js";
import { clampLines, pushWrapped } from "./render-util.js";
import { PluginInventoryModel, type PluginInventoryActionName, type PluginInventoryCandidate, type PluginInventoryConfirmationProjection, type PluginInventoryTargetAuthority } from "./plugin-inventory-model.js";
import { renderPluginInventory, type PluginInventoryRenderResult } from "./plugin-inventory-render.js";
import { parseQualifiedPluginId } from "../util/plugin-id.js";

const ESC = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(8);
const DELETE_BACKSPACE = String.fromCharCode(127);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;
const SHIFT_TAB = `${ESC}[Z`;

export type PluginInventoryOpenResult =
  | { readonly opened: true }
  | { readonly opened: false; readonly reason: "unavailable" | "open-failed" };

interface PluginInventoryKeybindingsPort { matches?(data: string, id: string): boolean }
interface PluginInventoryTuiPort { requestRender?(): void }

export interface PluginInventoryFocusComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
}

type PluginInventoryCustomFactory = (
  tui: PluginInventoryTuiPort,
  theme: unknown,
  keybindings: PluginInventoryKeybindingsPort | undefined,
  done: (value?: unknown) => void,
) => PluginInventoryFocusComponent;

export interface PluginInventoryOpenContext {
  readonly mode?: string;
  readonly ui?: { custom?: (factory: PluginInventoryCustomFactory, options?: unknown) => Promise<unknown> | unknown };
}

export interface PluginInventoryFocusOptions {
  readonly render?: typeof renderPluginInventory;
  readonly onError?: (error: unknown) => void;
  readonly lifecycle?: PluginLifecyclePort;
  readonly lifecycleFactory?: () => Promise<StoreResult<PluginLifecyclePort>>;
  readonly initialAction?: PluginInventoryActionName;
}

interface ActionField { readonly name: string; readonly hint: string }
const DECLARATION_ONLY_FIELD: ActionField = Object.freeze({ name: "declaration only", hint: "yes permits the selected-scope settings change even when higher precedence keeps effective state unchanged; no requires the requested effective result" });
const GIT_REF_FIELD: ActionField = Object.freeze({ name: "Git ref", hint: "optional branch, tag, or commit; blank uses the default ref" });
const ACTION_FIELDS: Readonly<Record<PluginInventoryActionName, readonly ActionField[]>> = Object.freeze({
  "marketplace-add": [{ name: "marketplace name", hint: "lowercase marketplace name" }, { name: "source kind", hint: "local-directory | local-catalog-file | github | https-git | https-catalog" }, { name: "source", hint: "source is hidden after entry" }, { name: "scope", hint: "user | project | local" }, DECLARATION_ONLY_FIELD],
  "marketplace-refresh": [{ name: "marketplace name", hint: "exact registered marketplace name" }, DECLARATION_ONLY_FIELD], "marketplace-remove": [{ name: "marketplace name", hint: "exact registered marketplace name" }, { name: "preserve installed acknowledgement", hint: "type yes to preserve installed plugins" }, DECLARATION_ONLY_FIELD],
  install: [{ name: "plugin", hint: "qualified plugin@marketplace" }, { name: "scope", hint: "user | project | local" }, DECLARATION_ONLY_FIELD],
  enable: [{ name: "plugin", hint: "qualified plugin@marketplace" }, DECLARATION_ONLY_FIELD], disable: [{ name: "plugin", hint: "qualified plugin@marketplace" }, DECLARATION_ONLY_FIELD], update: [{ name: "plugin", hint: "qualified plugin@marketplace" }],
  uninstall: [{ name: "plugin", hint: "qualified plugin@marketplace" }, { name: "remove declaration", hint: "yes | no" }, { name: "remove data", hint: "yes | no" }],
  recover: [{ name: "operation id", hint: "exact operation id" }, { name: "recovery result", hint: "complete | rollback" }],
});

function printableText(data: string): string | undefined {
  if (!data) return undefined;
  const flattened = [...data].length > 1 ? data.replace(/\r\n|[\r\n\t]/gu, " ") : data;
  for (const character of flattened) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return undefined;
  }
  return flattened;
}

function authorityFingerprint(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16); }
function sourceFingerprint(source: unknown): string { try { return authorityFingerprint(JSON.stringify(source)); } catch { return authorityFingerprint("unavailable"); } }
function safeSourceAuthority(source: unknown): string {
  if (typeof source !== "object" || source === null) return "unchanged existing authority";
  const value = source as Record<string, unknown>; const kind = typeof value.kind === "string" ? value.kind : "unknown"; const fingerprint = sourceFingerprint(source);
  if (kind === "github" && typeof value.repository === "string") return `github repository · full authority ${fingerprint}`;
  if ((kind === "https-git" || kind === "https-git-subdir" || kind === "https-catalog" || kind === "https-zip") && typeof value.url === "string") {
    try { const url = new URL(value.url); return url.protocol === "https:" ? `${kind} host ${url.host} · full authority ${fingerprint}` : `${kind}:unsupported-origin · full authority ${fingerprint}`;  } catch { return `${kind}:invalid-origin · full authority ${fingerprint}`; }
  }
  if ((kind === "local-directory" || kind === "local-catalog-file" || kind === "relative" || kind === "marketplace-relative") && typeof value.path === "string") {
    const leaf = value.path.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1) ?? "."; return `${kind} basename ${leaf} · full authority ${fingerprint}`;
  }
  if (kind === "npm" && typeof value.package === "string") return `npm:${value.package} · full authority ${fingerprint}`;
  return `${kind} · full authority ${fingerprint}`;
}

function settingsValue(value: unknown): string {
  if (value === null) return "declaration removal";
  if (typeof value === "boolean") return value ? "enabled/present" : "disabled";
  if (typeof value === "object" && value !== null) return "marketplace registration present";
  return "unavailable";
}
function settingsState(value: SettingsValueState | undefined): string {
  if (value?.present === false) return "absent";
  if (value?.present !== true) return "unavailable";
  const source = typeof value.source === "string" ? [...(value.source.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1) ?? "unavailable").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")].slice(0, 80).join("") : "unavailable";
  return `present · value ${settingsValue(value.value)} · scope ${value.scope ?? "unknown"} · source ${source}`;
}
function settingsProjection(value: PluginSettingsEffectSummary | undefined): readonly string[] {
  if (value === undefined) return Object.freeze(["settings unchanged"]);
  return Object.freeze([
    `requested declaration ${settingsValue(value.requested)}`,
    `requested authority achieved ${value.effective ? "yes" : "no"}`,
    `effective after ${settingsState(value.effectiveAfter)}`,
    `declaration only ${value.declarationOnly ? "yes" : "no"}`,
  ]);
}

function confirmationProjection(preview: MarketplaceMutationPreview | PluginMutationPreview | RecoveryPreview, action: PluginInventoryActionName, exact: readonly PluginLifecycleExactTarget[], recoveryAction?: "complete" | "rollback"): PluginInventoryConfirmationProjection {
  let omissions = 0;
  const scalar = (value: unknown, required = true, cap = 320): string => {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") { if (required) omissions += 1; return "<missing>"; }
    const clean = String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " "); if ([...clean].length > cap) { omissions += 1; return "<oversized field omitted>"; } return clean;
  };
  const list = (values: unknown, render: (value: unknown) => string, requiredShape = true): readonly string[] => {
    if (!Array.isArray(values)) { if (requiredShape) omissions += 1; return Object.freeze(["<missing list>"]); }
    if (values.length > 128) omissions += values.length - 128;
    return Object.freeze(values.slice(0, 128).map((value) => render(value)));
  };
  const exactAuthority = exact.length === 0 ? "no predecessor selector" : exact.map((value) => `${scalar(value.kind)} selected scope ${scalar(value.scope)} record ${authorityFingerprint(value.mutableRecordKey)} selector fingerprint ${authorityFingerprint(value.selector)}`).join("; ");
  const boundedAuthority = (scope: unknown, profileKey: unknown, checkoutFamilyKey: unknown): string => {
    const selectedScope = scalar(scope); const profile = typeof profileKey === "string" ? `profile ${authorityFingerprint(profileKey)}` : scalar(undefined);
    const checkoutRequired = scope === "project" || scope === "local"; const checkout = typeof checkoutFamilyKey === "string" ? `checkout ${authorityFingerprint(checkoutFamilyKey)}` : checkoutRequired ? scalar(undefined) : "checkout user-global";
    return `requested scope ${selectedScope} · ${profile} · ${checkout} · ${exactAuthority}`;
  };
  if ("registration" in preview) {
    const catalog = preview.catalog; const trust = preview.snapshot.trust; const authority = boundedAuthority(preview.registration.scope, preview.registration.profileKey, preview.registration.checkoutFamilyKey);
    return Object.freeze({ operationId: scalar(preview.operationId), action, target: scalar(preview.registration.name), authority, sourceAuthority: scalar(safeSourceAuthority(preview.registration.source)),
      resolution: Object.freeze([`preallocated ${scalar(preview.operationId)}`, `snapshot ${scalar(preview.snapshot.snapshotId)}`, `catalog digest ${scalar(preview.snapshot.catalogDigest)}`, `state ${scalar(preview.stateFingerprint)}`, `settings ${scalar(preview.settingsFingerprint)}`]),
      trust: Object.freeze([`critical trust target ${scalar(trust.targetDigest)}`]), dependencies: list(catalog.plugins, (value) => { const row = value as Record<string, unknown>; return `${scalar(row.name)} · ${scalar(row.supported)} · ${scalar(row.sourceKind ?? row.error)}`; }),
      settings: Object.freeze([...settingsProjection(preview.settingsEffect), "default not applicable to marketplace registration"]), executable: Object.freeze(["marketplace catalog is inert; installed executable membership is unchanged"]),
      destructive: Object.freeze([`preserve installed plugins ${preview.acknowledgement === "preserve-installations" ? "yes" : scalar(undefined)}`, ...list(preview.dependents, (value) => `dependent ${scalar(value)}`)]),
      participants: list(preview.participants, (value) => { const row = value as Record<string, unknown>; return `${scalar(row.order)} ${scalar(row.role)} ${scalar(row.effect)} ${scalar(row.scopeKey)}`; }), consequences: list(preview.consequences, (value) => scalar(value)),
      sessionBehavior: Object.freeze(["marketplace refresh does not change loaded code", "loaded plugin snapshot stays fixed for this session"]), recovery: Object.freeze([]), omissions: omissions + catalog.omittedEntries });
  }
  if ("pluginId" in preview) {
    const authority = boundedAuthority(preview.scope, preview.profileKey, preview.checkoutFamilyKey);
    return Object.freeze({ operationId: scalar(preview.operationId), action, target: scalar(preview.pluginId), authority, sourceAuthority: scalar(safeSourceAuthority(preview.requestedSource ?? preview.source)),
      resolution: Object.freeze([`preallocated ${scalar(preview.operationId)}`, `revision ${scalar(preview.immutableRevision ?? "unchanged")}`, `artifact ${scalar(preview.artifactDigest ?? "unchanged")}`, `tree ${scalar(preview.treeDigest ?? "unchanged")}`, `root ${scalar(preview.rootDigest ?? "unchanged")}`, `executable ${scalar(preview.executableDigest ?? "unchanged")}`, `generation ${scalar(preview.generationId ?? "unchanged")}`]),
      trust: Object.freeze([preview.trust === undefined ? "existing trust authority" : `critical approval ${scalar(preview.trust.target)} · ${scalar(preview.trust.executableDigest)}`]),
      dependencies: Object.freeze([`admitted ${scalar(preview.dependencies.selected.admitted)} · blocking ${scalar(preview.dependencies.blocking)}`, ...list(preview.dependencies.selected.reasons, (value) => scalar(value)), ...list(preview.dependencies.graph, (value) => scalar(JSON.stringify(value))), ...list(preview.dependencies.decisions ?? [], (value) => scalar(JSON.stringify(value)))]),
      settings: Object.freeze([...settingsProjection(preview.settingsEffect), `initial enablement source ${scalar(preview.enablement?.source ?? "existing explicit setting")}`]),
      executable: list(preview.executableComponents, (value) => scalar(value)), destructive: Object.freeze([`remove declaration ${preview.removeDeclaration ? "yes" : "no"}`, `remove data ${preview.removeData ? "yes" : "no"}`]),
      participants: list(preview.participants, (value) => { const row = value as Record<string, unknown>; return `${scalar(row.kind)} ${scalar(row.effect)} ${scalar(row.targetClass)} ${scalar(row.digest ?? "no digest")}`; }), consequences: list(preview.consequences, (value) => scalar(value)),
      sessionBehavior: Object.freeze(["durable desired state changes now", "loaded generation, components, outcomes, and badges stay fixed until successful reload or a new session"]), recovery: Object.freeze([]), omissions });
  }
  const summary = typeof preview.confirmationSummary === "object" && preview.confirmationSummary !== null ? preview.confirmationSummary as Record<string, unknown> : {};
  const producer = preview.producerSchema === "plugin-lifecycle" || preview.producerSchema === "marketplace-lifecycle";
  if (!producer) omissions += 1;
  const plugin = preview.producerSchema === "plugin-lifecycle";
  const deps = typeof summary.dependencies === "object" && summary.dependencies !== null ? summary.dependencies as Record<string, unknown> : {};
  const selected = typeof deps.selected === "object" && deps.selected !== null ? deps.selected as Record<string, unknown> : {};
  const registration = summary.registration as Record<string, unknown> | undefined; const authority = boundedAuthority(summary.scope ?? registration?.scope, summary.profileKey ?? registration?.profileKey, summary.checkoutFamilyKey ?? registration?.checkoutFamilyKey);
  return Object.freeze({ operationId: scalar(preview.operationId), action, target: scalar(summary.pluginId ?? registration?.name ?? preview.operationId), authority,
    sourceAuthority: scalar(safeSourceAuthority(summary.requestedSource ?? summary.source ?? (summary.registration as Record<string, unknown> | undefined)?.source)),
    resolution: Object.freeze([`producer ${scalar(preview.producerSchema)} v${scalar(preview.producerVersion)}`, `confirmation ${scalar(preview.confirmationDigest)}`, `plan ${scalar(preview.planDigest)}`, `completed ${scalar(preview.completed)} · remaining ${scalar(preview.remaining)} · rolled back ${scalar(preview.rolledBack)}`]),
    trust: Object.freeze([plugin ? scalar((summary.trust as Record<string, unknown> | undefined)?.target ?? "existing trust authority") : scalar(((summary.snapshot as Record<string, unknown> | undefined)?.trust as Record<string, unknown> | undefined)?.targetDigest ?? "marketplace trust authority")]),
    dependencies: plugin ? Object.freeze([`admitted ${scalar(selected.admitted)}`, ...list(selected.reasons, (value) => scalar(value)), ...list(deps.graph, (value) => scalar(JSON.stringify(value))), ...list(deps.decisions ?? [], (value) => scalar(JSON.stringify(value)))]) : list((summary.catalog as Record<string, unknown> | undefined)?.plugins, (value) => scalar(JSON.stringify(value))),
    settings: settingsProjection(typeof summary.settingsEffect === "object" && summary.settingsEffect !== null ? summary.settingsEffect as PluginSettingsEffectSummary : undefined), executable: plugin ? list(summary.executableComponents, (value) => scalar(value)) : Object.freeze(["marketplace recovery does not load code"]),
    destructive: Object.freeze([`selected recovery ${scalar(recoveryAction)}`, `remove declaration ${scalar(summary.removeDeclaration ?? false)}`, `remove data ${scalar(summary.removeData ?? false)}`, `preserve installed ${scalar(summary.acknowledgement ?? "not applicable")}`]),
    participants: list(summary.participants, (value) => scalar(JSON.stringify(value))), consequences: list(summary.consequences, (value) => scalar(value)),
    sessionBehavior: Object.freeze([plugin ? "desired plugin state may change; loaded runtime stays fixed until reload or a new session" : "marketplace recovery does not change loaded code"]), recovery: Object.freeze([`applicable ${preview.actions.join(" or ") || `terminal ${preview.terminalOutcome ?? "unknown"}`}`, `selected ${scalar(recoveryAction)}`]), omissions });
}

const DEPENDENCY_PLANNING_CODES = new Set(["dependency-blocked", "required-dependency"]);
const SETTINGS_PLANNING_CODES = new Set(["ineffective-declaration"]);
const SOURCE_PLANNING_CODES = new Set(["invalid-source", "unsafe-source", "source-changed", "invalid-catalog", "invalid-archive", "acquisition-failure", "network-failure", "download-limit"]);
const PREPARATION_PLANNING_CODES = new Set(["pending-recovery", "ambiguous-lock", "lock-busy", "data-directory-preparation-failed"]);

function planningCause(code: string): { readonly cause: string; readonly guidance: string } {
  if (code === "managed-readonly") return { cause: "managed target", guidance: "Administrator-owned target; ask the administrator to change it." };
  if (code === "imported-readonly") return { cause: "imported target", guidance: "Claude-owned target; use Claude Code to change it." };
  if (code === "seed-readonly") return { cause: "seed target", guidance: "Seed-owned read-only target; manage it at its configured seed source." };
  if (code === "stale-selector") return { cause: "stale target", guidance: "Selected exact scoped record changed; refresh inventory and select it again." };
  if (DEPENDENCY_PLANNING_CODES.has(code)) return { cause: "dependency refusal", guidance: "Inspect installed dependency versions, repair the blocking dependency, then retry planning." };
  if (SETTINGS_PLANNING_CODES.has(code)) return { cause: "settings refusal", guidance: "Choose another writable scope, or retry and explicitly choose declaration only if an ineffective declaration is intended." };
  if (SOURCE_PLANNING_CODES.has(code)) return { cause: "source refusal", guidance: "Check the supported source syntax and public reachability, then retry planning." };
  if (PREPARATION_PLANNING_CODES.has(code)) return { cause: "preparation refusal", guidance: "Inspect pending lifecycle state and storage availability, recover pending state if present, then retry planning." };
  return { cause: "planning refusal", guidance: "Correct the lifecycle input or state, then retry planning." };
}

function fallbackLines(width: number, identity?: string, workflowPhase?: string): string[] {
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (columns === 0) return [""];
  const safeIdentity = parseQualifiedPluginId(identity)?.qualifiedIdentity;
  const lines: string[] = [];
  const postConfirmation = workflowPhase !== undefined && ["progress", "receipt", "pending-recovery", "terminal-fallback"].includes(workflowPhase);
  pushWrapped(workflowPhase === undefined ? "PiCC plugin inventory · read-only · captured for this session" : postConfirmation ? "Explicit confirmation authorized execution; receipt or recovery evidence is authoritative." : "Active workflow; no durable change until explicit confirmation.", columns, lines);
  pushWrapped(safeIdentity === undefined
    ? "Plugin inventory display failed. Esc closes. Run picc plugin list, then picc plugin details <qualified-name>."
    : `Plugin details display failed for ${safeIdentity}. Esc closes. Run picc plugin list or picc plugin details ${safeIdentity}`, columns, lines);
  return clampLines(lines, columns);
}

/** Defensive full-editor replacement component; the model and renderer remain independently pure. */
export class PluginInventoryFocusController implements PluginInventoryFocusComponent {
  private readonly model: PluginInventoryModel;
  private readonly tui: PluginInventoryTuiPort;
  private readonly theme: unknown;
  private readonly keybindings: PluginInventoryKeybindingsPort | undefined;
  private readonly done: (value?: unknown) => void;
  private readonly renderFn: typeof renderPluginInventory;
  private readonly onError?: (error: unknown) => void;
  private closed = false;
  private disposed = false;
  private cache?: { width: number; revision: number; generation: number; lines: string[] };
  private generation = 0;
  private lastMaxScroll = 0;
  private lifecycle?: PluginLifecyclePort;
  private readonly lifecycleFactory?: () => Promise<StoreResult<PluginLifecyclePort>>;
  private form?: { action: PluginInventoryActionName; target?: PluginInventoryTargetAuthority; marketplaceTarget?: PluginInventoryTargetAuthority; fields: ActionField[]; index: number; values: string[]; buffer: string };
  private candidateQueue: PluginInventoryCandidate[][] = [];
  private abort?: AbortController;
  private prepared?: { kind: "marketplace" | "plugin"; preview: MarketplaceMutationPreview | PluginMutationPreview };
  private workflowEpoch = 0;
  private confirmationAttestation?: { epoch: number; revision: number; generation: number; width: number };
  private fallbackLatched = false;
  private rendererFailedAfterCommit = false;
  private executionInFlight = false;

  constructor(options: {
    snapshot: PluginInventorySnapshot;
    tui: PluginInventoryTuiPort;
    theme: unknown;
    keybindings?: PluginInventoryKeybindingsPort;
    done: (value?: unknown) => void;
    render?: typeof renderPluginInventory;
    onError?: (error: unknown) => void;
    lifecycle?: PluginLifecyclePort;
    lifecycleFactory?: () => Promise<StoreResult<PluginLifecyclePort>>;
    initialAction?: PluginInventoryActionName;
  }) {
    this.model = new PluginInventoryModel(options.snapshot);
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.done = options.done;
    this.renderFn = options.render ?? renderPluginInventory;
    this.onError = options.onError;
    this.lifecycle = options.lifecycle;
    this.lifecycleFactory = options.lifecycleFactory;
    if (options.initialAction !== undefined) this.model.beginActionSelection([options.initialAction], false);
  }

  render(width: number): string[] {
    const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const revision = this.model.revision();
    if (this.cache?.width === columns && this.cache.revision === revision && this.cache.generation === this.generation) return this.cache.lines;
    const workflow = this.model.workflow();
    if (workflow?.phase === "terminal-fallback") {
      const lines: string[] = []; pushWrapped("Explicit confirmation authorized execution; receipt or recovery evidence is authoritative.", columns, lines); pushWrapped(`Lifecycle outcome · ${workflow.operationId}`, columns, lines); pushWrapped(workflow.message, columns, lines); if (workflow.recoveryCommand) pushWrapped(workflow.recoveryCommand, columns, lines); pushWrapped("Esc closes · Enter returns to inventory", columns, lines);
      return clampLines(lines, columns);
    }
    if ((workflow?.phase === "preview" || workflow?.phase === "confirmation") && columns < 8) {
      this.confirmationAttestation = undefined;
      const lines: string[] = []; pushWrapped("Active workflow; no durable change until explicit confirmation.", columns, lines); pushWrapped("Resize", columns, lines); pushWrapped("Esc", columns, lines);
      return clampLines(lines, columns);
    }
    try {
      const rendered: PluginInventoryRenderResult = this.renderFn(this.model.view(), { width: columns, theme: this.theme });
      this.lastMaxScroll = rendered.maxDetailScroll;
      const lines = [...rendered.lines];
      this.cache = { width: columns, revision, generation: this.generation, lines };
      if (workflow?.phase === "confirmation" && workflow.confirmationEnabled) this.confirmationAttestation = { epoch: this.workflowEpoch, revision, generation: this.generation, width: columns };
      return lines;
    } catch (error) {
      if (workflow !== undefined) void this.handleWorkflowRenderFailure(workflow, error);
      const detailIdentity = this.model.view().detail?.identity;
      const identity = parseQualifiedPluginId(detailIdentity)?.qualifiedIdentity;
      if (identity !== undefined) this.model.failDetail(identity);
      else this.model.failSurface();
      this.report(error);
      // A detail-only fault should immediately recover to the real list so the
      // safe identity and text-command fallback are visible on this repaint.
      try {
        const recovered = this.renderFn(this.model.view(), { width: columns, theme: this.theme });
        this.lastMaxScroll = recovered.maxDetailScroll;
        const lines = [...recovered.lines];
        this.cache = { width: columns, revision: this.model.revision(), generation: this.generation, lines };
        return lines;
      } catch (recoveryError) {
        this.report(recoveryError);
        const lines = fallbackLines(columns, identity, workflow?.phase);
        this.cache = { width: columns, revision: this.model.revision(), generation: this.generation, lines };
        return lines;
      }
    }
  }

  handleInput(data: string): void {
    const before = this.model.revision();
    try {
      const matches = (id: string): boolean => {
        try { return this.keybindings?.matches?.(data, id) === true; } catch { return false; }
      };
      const cancel = matches("tui.select.cancel") || matches("app.interrupt") || data === ESC;
      if (cancel) {
        if (this.model.inWorkflow()) { void this.cancelWorkflow(); return; }
        // The visible ladder is detail → filtered list → close; no Esc may leave an identical screen.
        if (this.model.leaveDetail()) this.repaintIfChanged(before);
        else if (this.model.clearFilter()) this.repaintIfChanged(before);
        else this.close();
        return;
      }
      if (this.model.inWorkflow()) { this.handleWorkflowInput(data, matches); return; }
      if (this.model.inDetail()) {
        if (matches("tui.select.up") || data === UP || data === LEFT) this.model.scrollDetail(-1);
        else if (matches("tui.select.down") || data === DOWN || data === RIGHT) this.model.scrollDetail(1);
        else return;
        this.model.setDetailScroll(Math.min(this.lastMaxScroll, this.model.view().detailScroll));
        this.repaintIfChanged(before);
        return;
      }
      if (matches("tui.select.up") || data === UP) this.model.moveSelection(-1);
      else if (matches("tui.select.down") || data === DOWN) this.model.moveSelection(1);
      else if (data === LEFT || data === SHIFT_TAB) this.model.moveView(-1);
      else if (matches("tui.input.tab") || data === RIGHT || data === "\t") this.model.moveView(1);
      else if (data === "a" || data === "A") this.model.beginActionSelection();
      else if (matches("tui.select.confirm") || data === "\r" || data === "\n") {
        const result = this.model.enterDetail();
        if (result === "stale") this.model.failDetail(this.model.view().rows.find((row) => row.key === this.model.view().selectedKey)?.identity);
      } else if (data === BACKSPACE || data === DELETE_BACKSPACE) this.model.backspaceFilter();
      else {
        const text = printableText(data);
        if (text === undefined) return;
        this.model.appendFilter(text);
      }
      this.repaintIfChanged(before);
    } catch (error) {
      this.model.failSurface();
      this.report(error);
      this.repaintIfChanged(before, false);
    }
  }

  invalidate(): void {
    this.generation += 1;
    this.cache = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workflowEpoch += 1; this.abort?.abort(); this.abort = undefined; this.confirmationAttestation = undefined;
    const phase = this.model.workflow()?.phase; const prepared = this.prepared; const lifecycle = this.lifecycle; this.prepared = undefined; this.clearPrivateInput();
    if (prepared !== undefined && lifecycle !== undefined && phase !== "progress" && phase !== "terminal-fallback" && phase !== "receipt") void (prepared.kind === "marketplace" ? lifecycle.marketplaces.discardPreview(prepared.preview.operationId) : lifecycle.plugins.discardPreview(prepared.preview.operationId)).catch(() => undefined);
    this.cache = undefined;
  }

  /** Test and integration introspection; returns a detached pure view. */
  view() { return this.model.view(); }

  private handleWorkflowInput(data: string, matches: (id: string) => boolean): void {
    const state = this.model.workflow(); if (state === undefined) return;
    const confirm = matches("tui.select.confirm") || data === "\r" || data === "\n";
    const up = matches("tui.select.up") || data === UP; const down = matches("tui.select.down") || data === DOWN;
    if (state.phase === "select-action") {
      if (up) this.model.moveAction(-1); else if (down) this.model.moveAction(1);
      else if (confirm) { const action = state.actions[state.selected]; if (action !== undefined) void this.startForm(action, action === "marketplace-add" ? undefined : state.target); }
      this.repaint(); return;
    }
    if (state.phase === "select-candidate") {
      if (up || down) this.model.setWorkflow({ ...state, selected: Math.max(0, Math.min(state.candidates.length - 1, state.selected + (up ? -1 : 1))) });
      else if (confirm) { const chosen = state.candidates[state.selected]; if (chosen !== undefined && this.form !== undefined) { if (chosen.authority.kind === "marketplace" && !state.action.startsWith("marketplace-")) this.form.marketplaceTarget = chosen.authority; else this.form.target = chosen.authority; this.candidateQueue.shift(); void this.continueCandidateSelection(); } }
      this.repaint(); return;
    }
    if (state.phase === "input" && this.form !== undefined) {
      if (((data === LEFT || data === SHIFT_TAB) || ((data === BACKSPACE || data === DELETE_BACKSPACE) && this.form.buffer.length === 0)) && this.form.index > 0) { this.previousField(); return; }
      if (data === BACKSPACE || data === DELETE_BACKSPACE) this.form.buffer = [...this.form.buffer].slice(0, -1).join("");
      else if (confirm) { this.acceptField(); return; }
      else { const text = printableText(data); if (text !== undefined && [...this.form.buffer].length + [...text].length <= 4096) this.form.buffer += text; }
      this.model.setWorkflow({ ...state, entered: this.form.buffer.length > 0 }); this.repaint(); return;
    }
    if ((state.phase === "preview" || state.phase === "confirmation") && (up || down)) { this.model.setWorkflow({ ...state, detailScroll: Math.max(0, Math.min(this.lastMaxScroll, state.detailScroll + (up ? -1 : 1))) }); this.repaint(); return; }
    if (state.phase === "preview" && confirm) { if (!state.confirmationEnabled) return; this.confirmationAttestation = undefined; this.model.setWorkflow({ ...state, phase: "confirmation" }); this.repaint(); return; }
    if (state.phase === "confirmation" && confirm) { void this.executePrepared(); return; }
    if (["receipt", "pending-recovery", "terminal-fallback", "refused", "failed"].includes(state.phase) && confirm) { this.clearPrivateInput(); this.model.leaveWorkflow(); this.repaint(); }
  }

  private async startForm(action: PluginInventoryActionName, target?: PluginInventoryTargetAuthority): Promise<void> {
    ++this.workflowEpoch; this.abort?.abort(); this.abort = undefined; this.confirmationAttestation = undefined; this.fallbackLatched = false; this.rendererFailedAfterCommit = false; this.clearPrivateInput();
    let fields = ACTION_FIELDS[action];
    if (target !== undefined && ["marketplace-refresh", "marketplace-remove", "enable", "disable", "update", "uninstall", "recover"].includes(action)) fields = fields.filter((field) => field.name !== "plugin" && field.name !== "operation id" && field.name !== "marketplace name");
    if (action === "install" && target?.kind === "plugin") fields = fields.filter((field) => field.name !== "plugin");
    this.form = { action, ...(target === undefined ? {} : { target }), fields: [...fields], index: 0, values: [], buffer: "" };
    if (fields.length === 0) void this.prepareCandidates(); else this.showCurrentField();
  }

  private showCurrentField(invalid?: string): void {
    const form = this.form; const field = form?.fields[form.index]; if (form === undefined || field === undefined) return;
    this.model.setWorkflow({ phase: "input", action: form.action, ...(form.target === undefined ? {} : { target: form.target }), field: field.name, entered: form.buffer.length > 0, hint: field.hint, ...(invalid === undefined ? {} : { invalid }) }); this.repaint();
  }
  private previousField(): void { const form = this.form; if (form === undefined || form.index <= 0) return; form.index -= 1; form.buffer = form.values.pop() ?? ""; this.showCurrentField(); }
  private acceptField(): void {
    const form = this.form; const field = form?.fields[form.index]; if (form === undefined || field === undefined) return; const value = form.buffer.trim();
    const yesNo = field.name === "declaration only" || field.name.startsWith("remove ");
    const valid = field.name === "Git ref" ? [...value].length <= 256 && (value.length === 0 || !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
      : field.name === "scope" ? ["user", "project", "local"].includes(value) : yesNo ? ["yes", "no"].includes(value) : field.name === "preserve installed acknowledgement" ? value === "yes" : field.name === "source kind" ? ["local-directory", "local-catalog-file", "github", "https-git", "https-catalog"].includes(value) : value.length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
    if (!valid) { this.showCurrentField(`Invalid ${field.name}. ${field.hint}. Correct the value or go Back.`); return; }
    if (field.name === "source kind") {
      const refIndex = form.fields.findIndex((candidate) => candidate.name === "Git ref");
      const needsRef = value === "github" || value === "https-git";
      if (needsRef && refIndex < 0) form.fields.splice(form.fields.findIndex((candidate) => candidate.name === "source") + 1, 0, GIT_REF_FIELD);
      else if (!needsRef && refIndex >= 0) form.fields.splice(refIndex, 1);
    }
    if (field.name === "remove declaration") {
      const consentIndex = form.fields.findIndex((candidate) => candidate.name === "declaration only");
      if (value === "yes" && consentIndex < 0) form.fields.splice(form.index + 1, 0, DECLARATION_ONLY_FIELD);
      else if (value === "no" && consentIndex >= 0) form.fields.splice(consentIndex, 1);
    }
    form.values.push(value); form.index += 1; form.buffer = ""; if (form.fields[form.index] === undefined) void this.prepareCandidates(); else this.showCurrentField();
  }
  private fieldValue(name: string): string | undefined { const form = this.form; if (form === undefined) return undefined; const index = form.fields.findIndex((field) => field.name === name); return index < 0 ? undefined : form.values[index]; }
  private targetIdentity(): string | undefined { const form = this.form; return form?.target?.identity ?? this.fieldValue(form?.action === "recover" ? "operation id" : form?.action.startsWith("marketplace-") ? "marketplace name" : "plugin"); }

  private async prepareCandidates(): Promise<void> {
    const form = this.form; const identity = this.targetIdentity(); if (form === undefined || identity === undefined) return; this.candidateQueue = [];
    if (form.action === "install") {
      const marketplace = this.model.actionCandidates("install", identity);
      if (marketplace.length > 1) this.candidateQueue.push([...marketplace]); else if (marketplace.length === 1) form.marketplaceTarget = marketplace[0]!.authority;
    } else {
      const candidates = this.model.actionCandidates(form.action, identity);
      if (form.target?.mutableRecordKey === undefined && candidates.length > 1) this.candidateQueue.push([...candidates]); else if (form.target === undefined && candidates.length === 1) form.target = candidates[0]!.authority;
      if (form.action === "update") { const marketplace = this.model.marketplaceCandidatesForPlugin(identity); if (marketplace.length > 1) this.candidateQueue.push([...marketplace]); else if (marketplace.length === 1) form.marketplaceTarget = marketplace[0]!.authority; }
    }
    await this.continueCandidateSelection();
  }
  private async continueCandidateSelection(): Promise<void> { const form = this.form; const next = this.candidateQueue[0]; if (form === undefined) return; if (next !== undefined) { this.model.setWorkflow({ phase: "select-candidate", action: form.action, candidates: Object.freeze(next), selected: 0, targetIdentity: this.targetIdentity() ?? "unknown" }); this.repaint(); return; } await this.planForm(); }
  private async compose(epoch: number): Promise<StoreResult<PluginLifecyclePort>> { if (this.lifecycle !== undefined) return { ok: true, value: this.lifecycle }; if (this.lifecycleFactory === undefined) return { ok: false, code: "service-unavailable", message: "Lifecycle services are unavailable" }; const result = await this.lifecycleFactory(); if (epoch !== this.workflowEpoch || this.disposed) return { ok: false, code: "cancelled", message: "Stale lifecycle composition was discarded" }; if (result.ok) this.lifecycle = result.value; return result; }
  private exactTargets(lifecycle: PluginLifecyclePort, form: NonNullable<PluginInventoryFocusController["form"]>): StoreResult<readonly PluginLifecycleExactTarget[]> {
    const values: PluginLifecycleExactTarget[] = []; for (const authority of [form.target, form.marketplaceTarget]) { if (authority?.mutableRecordKey === undefined || authority.kind === "recovery") continue; const result = authority.kind === "plugin" ? lifecycle.targets?.plugin(authority.identity, authority.mutableRecordKey) : lifecycle.targets?.marketplace(authority.identity, authority.mutableRecordKey); if (result === undefined) return { ok: false, code: "target-port-unavailable", message: "Exact target authority is unavailable" }; if (!result.ok) return result; values.push(result.value); } return { ok: true, value: Object.freeze(values) };
  }
  private operationFor(form: NonNullable<PluginInventoryFocusController["form"]>, exact: readonly PluginLifecycleExactTarget[]): PluginInventoryOperation | undefined {
    const by = (name: string) => this.fieldValue(name); const target = this.targetIdentity(); const flags = { yes: false, declarationOnly: by("declaration only") === "yes" } as const; const selector = exact.find((value) => value.kind === "plugin")?.selector; const marketplaceSelector = exact.find((value) => value.kind === "marketplace")?.selector;
    if (form.action === "marketplace-add") { const ref = by("Git ref"); return { kind: "marketplace-add", name: by("marketplace name")!, sourceKind: by("source kind") as "local-directory" | "local-catalog-file" | "github" | "https-git" | "https-catalog", sourceValue: by("source")!, ...(ref === undefined || ref === "" ? {} : { ref }), flags: { ...flags, scope: by("scope") as "user" | "project" | "local" } }; }
    if (form.action === "marketplace-refresh") return { kind: "marketplace-refresh", name: target!, flags: { ...flags, ...(marketplaceSelector === undefined ? {} : { selector: marketplaceSelector }) } };
    if (form.action === "marketplace-remove") return { kind: "marketplace-remove", name: target!, flags: { ...flags, ...(marketplaceSelector === undefined ? {} : { selector: marketplaceSelector }), preserveInstalled: true } };
    if (form.action === "recover") return { kind: "recover", operationId: target!, flags: { ...flags, recoveryAction: by("recovery result") as "complete" | "rollback" } };
    if (form.action === "install") return { kind: "install", qualifiedIdentity: target!, flags: { ...flags, scope: by("scope") as "user" | "project" | "local", ...(marketplaceSelector === undefined ? {} : { marketplaceSelector }) } };
    if (form.action === "uninstall") return { kind: "uninstall", qualifiedIdentity: target!, flags: { ...flags, ...(selector === undefined ? {} : { selector }), removeDeclaration: by("remove declaration") === "yes", removeData: by("remove data") === "yes" } };
    return { kind: form.action, qualifiedIdentity: target!, flags: { ...flags, ...(selector === undefined ? {} : { selector }), ...((form.action === "update" && marketplaceSelector !== undefined) ? { marketplaceSelector } : {}) } };
  }

  private async planForm(): Promise<void> {
    const form = this.form; if (form === undefined) return; const privateValues = ["source", "Git ref"].map((name) => this.fieldValue(name)).filter((value): value is string => value !== undefined && value.length > 0); const epoch = this.workflowEpoch; this.abort = new AbortController(); const planningAbort = this.abort;
    this.model.setWorkflow({ phase: "planning", action: form.action, ...(form.target === undefined ? {} : { target: form.target }) }); if (!this.repaint()) { await this.cancelWorkflow(); return; }
    try {
      const composed = await this.compose(epoch); if (epoch !== this.workflowEpoch || planningAbort.signal.aborted || this.disposed) return; if (!composed.ok) { this.planFailure(composed, form, privateValues); return; }
      const exact = this.exactTargets(composed.value, form); if (!exact.ok) { this.planFailure(exact, form, privateValues); return; } const operation = this.operationFor(form, exact.value); if (operation === undefined) { this.planFailure({ code: "invalid-input", message: "Lifecycle input could not be composed" }, form, privateValues); return; }
      for (const privateField of ["source", "Git ref"]) { const index = form.fields.findIndex((field) => field.name === privateField); if (index >= 0) form.values[index] = ""; }
      if (operation.kind === "recover") {
        const result = await composed.value.recovery.preview(operation.operationId); if (epoch !== this.workflowEpoch || planningAbort.signal.aborted) return; if (!result.ok) { this.planFailure(result, form, privateValues); return; }
        const selected = operation.flags.recoveryAction; const projection = confirmationProjection(result.value, form.action, exact.value, selected); const enabled = selected !== undefined && result.value.actions.includes(selected) && projection.omissions === 0;
        this.model.setWorkflow({ phase: "preview", action: form.action, operationId: result.value.operationId, target: { kind: "recovery", identity: operation.operationId }, projection, detailScroll: 0, confirmationEnabled: enabled });
      } else if (operation.kind.startsWith("marketplace-")) {
        const result = await composed.value.marketplaces.plan(operation as Extract<PluginInventoryOperation, { kind: "marketplace-add" | "marketplace-refresh" | "marketplace-remove" }>, planningAbort.signal);
        if (epoch !== this.workflowEpoch || planningAbort.signal.aborted) { if (result.ok) await composed.value.marketplaces.discardPreview(result.value.operationId); return; } if (!result.ok) { this.planFailure(result, form, privateValues); return; }
        const projection = confirmationProjection(result.value, form.action, exact.value); this.prepared = { kind: "marketplace", preview: result.value }; this.model.setWorkflow({ phase: "preview", action: form.action, operationId: result.value.operationId, ...(form.target === undefined ? {} : { target: form.target }), projection, detailScroll: 0, confirmationEnabled: projection.omissions === 0 });
      } else {
        const result = await composed.value.plugins.plan(operation as Extract<PluginInventoryOperation, { kind: "install" | "enable" | "disable" | "update" | "uninstall" }>, planningAbort.signal);
        if (epoch !== this.workflowEpoch || planningAbort.signal.aborted) { if (result.ok) await composed.value.plugins.discardPreview(result.value.operationId); return; } if (!result.ok) { this.planFailure(result, form, privateValues); return; }
        const projection = confirmationProjection(result.value, form.action, exact.value); this.prepared = { kind: "plugin", preview: result.value }; this.model.setWorkflow({ phase: "preview", action: form.action, operationId: result.value.operationId, ...(form.target === undefined ? {} : { target: form.target }), projection, detailScroll: 0, confirmationEnabled: projection.omissions === 0 });
      }
    } catch {
      if (epoch === this.workflowEpoch) {
        const { action, target } = form;
        this.clearPrivateInput();
        this.model.failWorkflow("Lifecycle planning failed closed. Check lifecycle service availability and retry planning. Planning stopped before execution; no change was made.", action, undefined, target);
      }
    }
    finally { if (this.abort === planningAbort) this.abort = undefined; if (epoch === this.workflowEpoch && !this.disposed) this.repaint(); }
  }
  private planFailure(result: { readonly code: string; readonly message: string }, form: NonNullable<PluginInventoryFocusController["form"]>, _privateValues: readonly string[] = []): void {
    const presentation = planningCause(result.code);
    this.clearPrivateInput(); this.model.failWorkflow(`${presentation.cause}. ${presentation.guidance} Planning stopped before execution; no change was made.`, form.action, undefined, form.target);
  }

  private async executePrepared(): Promise<void> {
    const state = this.model.workflow(); const lifecycle = this.lifecycle; if (state?.phase !== "confirmation" || lifecycle === undefined || !state.confirmationEnabled) return;
    const attested = this.confirmationAttestation; if (attested === undefined || attested.epoch !== this.workflowEpoch || attested.revision !== this.model.revision() || attested.generation !== this.generation || attested.width < 8) { await this.failAndDiscard(state, "Final confirmation was not successfully rendered at a usable current width. Execution is blocked."); return; }
    const epoch = this.workflowEpoch; this.confirmationAttestation = undefined; this.executionInFlight = true; this.model.setWorkflow({ phase: "progress", action: state.action, operationId: state.operationId, ...(state.target === undefined ? {} : { target: state.target }), cancellationRequested: false }); this.repaint();
    let result: StoreResult<PluginLifecycleReceipt> | { readonly ok: false; readonly code: string; readonly message: string; readonly receipt?: PluginLifecycleReceipt };
    try {
      if (state.action === "recover") { const action = this.fieldValue("recovery result") as "complete" | "rollback" | undefined; result = action === undefined ? { ok: false, code: "recovery-action-required", message: "Choose complete or rollback" } : await lifecycle.recovery.recover(state.operationId, action); }
      else if (this.prepared?.kind === "marketplace") { const bound = lifecycle.marketplaces.prepare(this.prepared.preview as MarketplaceMutationPreview); result = !bound.ok ? bound : await bound.value.execute(this.prepared.preview.confirmationDigest); }
      else if (this.prepared?.kind === "plugin") result = await lifecycle.plugins.execute(this.prepared.preview as PluginMutationPreview, this.prepared.preview.confirmationDigest);
      else result = { ok: false, code: "preview-not-found", message: "Prepared lifecycle preview is unavailable" };
    } catch { result = { ok: false, code: "execution-failed", message: "Production lifecycle execution failed; inspect the exact operation id" }; }
    this.executionInFlight = false;
    if (epoch !== this.workflowEpoch || this.disposed) return;
    if (result.ok) await this.showReceipt(state.action, state.operationId, state.target, result.value); else { const receipt = "receipt" in result ? result.receipt : undefined; if (receipt !== undefined) await this.showReceipt(state.action, state.operationId, state.target, receipt); else await this.lookupOnce(state.operationId, `Lifecycle execution did not return an authoritative receipt. Failure category ${result.code.replace(/[^A-Za-z0-9 -]/gu, " ")}`); }
  }

  private receiptProjection(receipt: PluginLifecycleReceipt) { const kind = "pluginId" in receipt || "producerSchema" in receipt && receipt.producerSchema === "plugin-lifecycle" ? "plugin" as const : "marketplace" as const; const summary = "confirmationSummary" in receipt && typeof receipt.confirmationSummary === "object" && receipt.confirmationSummary !== null ? receipt.confirmationSummary as Record<string, unknown> : "summary" in receipt && typeof receipt.summary === "object" && receipt.summary !== null ? receipt.summary as unknown as Record<string, unknown> : undefined; const target = "pluginId" in receipt ? receipt.pluginId : typeof summary?.pluginId === "string" ? summary.pluginId : typeof (summary?.registration as Record<string, unknown> | undefined)?.name === "string" ? (summary!.registration as Record<string, unknown>).name as string : undefined; return Object.freeze({ kind, ...(target === undefined ? {} : { target }), outcome: receipt.outcome, completed: receipt.completed, ...("generationId" in receipt && receipt.generationId !== undefined ? { generationId: receipt.generationId } : {}) }); }
  private async showReceipt(action: PluginInventoryActionName, operationId: string, target: PluginInventoryTargetAuthority | undefined, receipt: PluginLifecycleReceipt): Promise<void> {
    const projection = this.lifecycle?.projection(); if (projection?.ok) this.model.replaceDurableDesired(projection.value); const projectionFailure = projection !== undefined && !projection.ok ? "Desired-state projection refresh failed. The receipt remains authoritative; prior desired state is retained. Reopen /plugin or start a new PiCC session." : undefined;
    const pluginChange = "pluginId" in receipt || "producerSchema" in receipt && receipt.producerSchema === "plugin-lifecycle"; this.model.setWorkflow({ phase: "receipt", action, operationId, ...(target === undefined ? {} : { target }), receipt: this.receiptProjection(receipt), pendingReload: receipt.outcome === "committed" && pluginChange, ...(projectionFailure === undefined ? {} : { projectionFailure }) }); this.prepared = undefined; this.clearPrivateInput(); if (this.rendererFailedAfterCommit) { await this.lookupOnce(operationId, projectionFailure ?? "Normal lifecycle rendering failed after execution began"); return; } if (!this.repaint()) await this.lookupOnce(operationId, "Receipt rendering failed after execution");
  }
  private async lookupOnce(operationId: string, message: string): Promise<void> {
    if (this.fallbackLatched) return; this.fallbackLatched = true; const lookup = await this.lifecycle?.lookup(operationId); const projection = this.lifecycle?.projection(); if (projection?.ok) this.model.replaceDurableDesired(projection.value); const projectionWarning = projection !== undefined && !projection.ok ? " Desired-state projection refresh failed; authoritative operation evidence remains separate." : ""; let text: string; let command: string | undefined;
    if (lookup?.ok && lookup.value?.state === "terminal") text = `Authoritative terminal receipt: ${lookup.value.receipt.outcome}; completed ${lookup.value.receipt.completed}. Operation ${operationId}. Reopen /plugin for a fresh projection or start a new PiCC session.${projectionWarning}`;
    else if (lookup?.ok && lookup.value?.state === "pending") { text = `Authoritative pending operation: completed ${lookup.value.completed}/${lookup.value.total}; recovery ${lookup.value.recoveryActions.join(" or ")}.${projectionWarning}`; command = `Exact fallback: picc plugin recover ${operationId}`; }
    else text = `${message}. Operation lookup did not produce terminal or pending authority; inspect exact operation ${operationId}.${projectionWarning}`;
    this.prepared = undefined; this.clearPrivateInput(); this.model.setWorkflow({ phase: "terminal-fallback", operationId, message: text, ...(command === undefined ? {} : { recoveryCommand: command }) }); this.cache = undefined;
  }
  private async failAndDiscard(state: Extract<NonNullable<ReturnType<PluginInventoryModel["workflow"]>>, { phase: "preview" | "confirmation" }>, message: string): Promise<void> {
    const epoch = this.workflowEpoch; const prepared = this.prepared; this.prepared = undefined; this.confirmationAttestation = undefined; this.model.setWorkflow({ phase: "cancelling", action: state.action, operationId: state.operationId, ...(state.target === undefined ? {} : { target: state.target }), message }); this.repaint();
    if (prepared === undefined || this.lifecycle === undefined) { if (epoch === this.workflowEpoch && !this.disposed) this.model.failWorkflow(message, state.action, state.operationId, state.target); return; }
    const discarded = prepared.kind === "marketplace" ? await this.lifecycle.marketplaces.discardPreview(state.operationId) : await this.lifecycle.plugins.discardPreview(state.operationId);
    if (epoch !== this.workflowEpoch || this.disposed) return;
    this.clearPrivateInput(); this.model.failWorkflow(discarded.ok ? `${message} Staging was discarded; no execution was attempted.` : `${message} Staging cleanup is uncertain; no execution was attempted.`, state.action, state.operationId, state.target); this.repaint();
  }
  private async handleWorkflowRenderFailure(workflow: NonNullable<ReturnType<PluginInventoryModel["workflow"]>>, error: unknown): Promise<void> {
    this.report(error); if (workflow.phase === "preview" || workflow.phase === "confirmation") { await this.failAndDiscard(workflow, "Required final confirmation detail could not render."); return; } if (workflow.phase === "progress") { this.rendererFailedAfterCommit = true; this.model.setWorkflow({ phase: "terminal-fallback", operationId: workflow.operationId, message: "Execution began and normal rendering failed. Waiting for the authoritative terminal receipt or pending recovery evidence." }); this.cache = undefined; return; } if (workflow.phase === "receipt") { await this.lookupOnce(workflow.operationId, workflow.projectionFailure ? `Lifecycle rendering failed after execution began. ${workflow.projectionFailure}` : "Lifecycle rendering failed after execution began"); return; } if (workflow.phase !== "terminal-fallback") this.model.failWorkflow("Lifecycle surface could not render; no execution was attempted.", "action" in workflow ? workflow.action : undefined, "operationId" in workflow ? workflow.operationId : undefined, "target" in workflow ? workflow.target : undefined);
  }
  private async cancelWorkflow(): Promise<void> {
    const state = this.model.workflow(); if (state === undefined) return; if (this.executionInFlight) { if (state.phase === "progress") this.model.setWorkflow({ ...state, cancellationRequested: true }); else if (state.phase === "terminal-fallback") this.model.setWorkflow({ ...state, message: `${state.message} Esc intent was recorded locally; execution remains in flight and its eventual receipt or pending evidence will still be shown.` }); this.repaint(); return; }
    const epoch = ++this.workflowEpoch; this.abort?.abort(); this.abort = undefined; this.confirmationAttestation = undefined; const prepared = this.prepared; this.prepared = undefined;
    const action = "action" in state && state.action !== undefined ? state.action : "recover"; this.model.setWorkflow({ phase: "cancelling", action, ...("operationId" in state && state.operationId !== undefined ? { operationId: state.operationId } : {}), ...("target" in state && state.target !== undefined ? { target: state.target } : {}), message: "Cancelling; confirmation is detached and unavailable." }); this.repaint();
    if (prepared !== undefined && this.lifecycle !== undefined) { const discarded = prepared.kind === "marketplace" ? await this.lifecycle.marketplaces.discardPreview(prepared.preview.operationId) : await this.lifecycle.plugins.discardPreview(prepared.preview.operationId); if (epoch !== this.workflowEpoch || this.disposed) return; if (!discarded.ok) { this.model.failWorkflow("Cancellation cleanup is uncertain; staging may require inspection.", action, prepared.preview.operationId); this.clearPrivateInput(); this.repaint(); return; } }
    if (epoch === this.workflowEpoch && !this.disposed) { this.clearPrivateInput(); this.model.leaveWorkflow(); this.repaint(); }
  }
  private clearPrivateInput(): void { if (this.form !== undefined) { this.form.values.fill(""); this.form.buffer = ""; } this.form = undefined; this.candidateQueue = []; }
  private repaint(): boolean { this.cache = undefined; try { this.tui.requestRender?.(); return true; } catch (error) { this.report(error); const workflow = this.model.workflow(); if (workflow !== undefined) void this.handleWorkflowRenderFailure(workflow, error); return false; } }

  private repaintIfChanged(previousRevision: number, markFailure = true): void {
    if (this.model.revision() === previousRevision) return;
    this.cache = undefined;
    try { this.tui.requestRender?.(); }
    catch (error) {
      if (markFailure) this.model.failSurface();
      this.report(error);
    }
  }

  private close(): void {
    if (this.closed) return;
    try {
      this.done(undefined);
      this.closed = true;
      this.dispose();
    } catch (error) {
      // Do not latch: a later Esc can retry and must remain able to restore focus.
      this.report(error);
    }
  }

  private report(error: unknown): void {
    try { this.onError?.(error); } catch { /* diagnostics must not trap focus */ }
  }
}

/** Open the inventory only in exact TUI mode. Full-width replacement: no overlay options are supplied. */
export async function openPluginInventory(
  snapshot: PluginInventorySnapshot,
  ctx: PluginInventoryOpenContext | undefined,
  options: PluginInventoryFocusOptions = {},
): Promise<PluginInventoryOpenResult> {
  const custom = ctx?.ui?.custom;
  if (ctx?.mode !== "tui" || typeof custom !== "function") return { opened: false, reason: "unavailable" };
  let component: PluginInventoryFocusController | undefined;
  try {
    await Promise.resolve(custom((tui, theme, keybindings, done) => {
      component = new PluginInventoryFocusController({
        snapshot, tui, theme, keybindings, done,
        ...(options.render === undefined ? {} : { render: options.render }),
        ...(options.onError === undefined ? {} : { onError: options.onError }),
        ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
        ...(options.lifecycleFactory === undefined ? {} : { lifecycleFactory: options.lifecycleFactory }),
        ...(options.initialAction === undefined ? {} : { initialAction: options.initialAction }),
      });
      return component;
    }));
    try { component?.dispose(); } catch (error) { try { options.onError?.(error); } catch { /* best effort */ } }
    return { opened: true };
  } catch (error) {
    try { component?.dispose(); } catch { /* focus restoration belongs to custom; disposal stays best effort */ }
    try { options.onError?.(error); } catch { /* best effort */ }
    return { opened: false, reason: "open-failed" };
  }
}

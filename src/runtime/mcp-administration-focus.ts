import type { McpAdministrationInventory, McpAdministrationInventoryItem } from "../mcp-administration/model.js";
import type {
  McpAdministrationConfirmationAuthority,
  McpAdministrationInteractivePreparation,
  McpAdministrationResult,
  McpAdministrationService,
} from "../mcp-administration/service.js";
import {
  MCP_ADMINISTRATION_ACTIONS,
  mcpAdministrationIdentity,
  mcpAdministrationReasonGuidance,
  orderMcpAdministrationServers,
  renderMcpAdministration,
  sameMcpAdministrationIdentity,
  type McpAdministrationActionView,
  type McpAdministrationRenderView,
  type McpAdministrationUiAction,
  type McpAdministrationUiIdentity,
} from "./mcp-administration-render.js";
import { clampLines, pushWrapped } from "./render-util.js";

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;

export type McpAdministrationActionPort = Pick<McpAdministrationService, "inventory" | "interactivePrepare" | "confirmedExecute">;
interface KeybindingsPort { matches?(data: string, id: string): boolean }
interface TuiPort { requestRender?(): void }

export type McpAdministrationOpenResult =
  | { readonly opened: true; readonly changed: boolean; readonly effect: "confirmed-changed" | "confirmed-unchanged" | "unconfirmed"; readonly message: string }
  | { readonly opened: false; readonly changed: boolean; readonly effect: "confirmed-changed" | "confirmed-unchanged" | "unconfirmed"; readonly reason: "unavailable" | "snapshot-failed" | "open-failed"; readonly message: string };

export interface McpAdministrationAggregateSnapshot {
  readonly changed: boolean;
  readonly effect: "confirmed-changed" | "confirmed-unchanged" | "unconfirmed";
  readonly submitted: boolean;
}

export interface McpAdministrationOpenContext {
  readonly mode?: string;
  readonly ui?: { custom?: (factory: (tui: TuiPort, theme: unknown, keybindings: KeybindingsPort | undefined, done: (result: McpAdministrationOpenResult) => void) => McpAdministrationFocusController, options?: unknown) => Promise<McpAdministrationOpenResult> | McpAdministrationOpenResult };
}

export interface McpAdministrationFocusOptions {
  readonly render?: typeof renderMcpAdministration;
  readonly onError?: (error: unknown) => void;
  readonly initialIdentity?: McpAdministrationUiIdentity;
  readonly initialAction?: McpAdministrationUiAction;
}

function fixedNoChange(message: string): McpAdministrationOpenResult {
  return Object.freeze({ opened: true, changed: false, effect: "confirmed-unchanged", message });
}

function projectInventory(value: McpAdministrationInventory): McpAdministrationInventory {
  return Object.freeze({
    version: 1,
    policyPosture: value.policyPosture,
    observations: Object.freeze([...value.observations]),
    ...(value.remediation === undefined ? {} : { remediation: value.remediation }),
    servers: Object.freeze(value.servers.map((server) => Object.freeze({
      name: server.name, source: server.source,
      authority: server.authority.kind === "mutable" ? Object.freeze({ kind: "mutable" as const, scope: server.authority.scope }) : Object.freeze({ kind: "read-only" as const, sourceClass: server.authority.sourceClass }), precedence: server.precedence,
      ...(server.agentOwner === undefined ? {} : { agentOwner: Object.freeze({ name: server.agentOwner.name, scope: server.agentOwner.scope }) }),
      summary: Object.freeze({
        ...(server.summary.transport === undefined ? {} : { transport: server.summary.transport }),
        ...(server.summary.configuredType === undefined ? {} : { configuredType: server.summary.configuredType }),
        argumentCount: server.summary.argumentCount, environmentKeyCount: server.summary.environmentKeyCount,
        headerKeyCount: server.summary.headerKeyCount, timeoutConfigured: server.summary.timeoutConfigured,
      }),
      policy: server.policy, review: server.review, status: server.status,
      ...(server.inactiveReason === undefined ? {} : { inactiveReason: server.inactiveReason }),
      live: server.live,
      capabilityCounts: Object.freeze({ tools: server.capabilityCounts.tools, prompts: server.capabilityCounts.prompts, resources: server.capabilityCounts.resources }),
    }))),
    omittedDeclarationCount: value.omittedDeclarationCount,
  });
}

function resultChanged(result: McpAdministrationResult): boolean {
  return result.recovery.state === "committed" && result.recovery.effect === "changed" || result.durable.state === "committed" && result.durable.effect === "changed" || result.runtime.state === "succeeded" || result.exposure.state === "succeeded";
}

function resultEffect(result: McpAdministrationResult): "confirmed-changed" | "confirmed-unchanged" | "unconfirmed" {
  const persistenceUnconfirmed = [result.recovery, result.durable].some((value) =>
    value.state !== "not-requested" && (value.effect === "uncertain" || value.cleanup === "pending" || value.state === "pending-recovery"));
  const operationUnconfirmed = result.runtime.state === "failed" || result.exposure.state === "failed";
  if (persistenceUnconfirmed || operationUnconfirmed) return "unconfirmed";
  return resultChanged(result) ? "confirmed-changed" : "confirmed-unchanged";
}

function persistenceOutcome(value: McpAdministrationResult["recovery"] | McpAdministrationResult["durable"]): string {
  if (value.state === "not-requested") return "not requested";
  return `${value.state} · effect ${value.effect} · cleanup ${value.cleanup}`;
}

function operationOutcome(value: McpAdministrationResult["runtime"]): string {
  if (value.state !== "failed") return value.state;
  const guidance = {
    "runtime-failed": "runtime failed; inspect the fresh server posture before retrying",
    "exposure-failed": "capability exposure failed; refresh before relying on tools, prompts, or resources",
    "generation-stale": "the live generation changed; refresh before retrying",
    "server-unavailable": "the admitted server is unavailable; inspect its fresh status",
    "live-port-failure": "live administration failed; refresh before retrying",
  } as const;
  return `failed · ${guidance[value.reasonCode]}`;
}

function resultProjection(result: McpAdministrationResult, action: McpAdministrationUiAction, aggregateEffect: McpAdministrationAggregateSnapshot["effect"]): Extract<McpAdministrationRenderView["phase"], { kind: "result" }> {
  return Object.freeze({
    kind: "result", action, effect: aggregateEffect,
    message: result.eligibility.eligible ? "The service returned an authoritative result." : mcpAdministrationReasonGuidance(result.eligibility.reasonCode),
    recovery: persistenceOutcome(result.recovery), durable: persistenceOutcome(result.durable),
    runtime: operationOutcome(result.runtime), exposure: operationOutcome(result.exposure),
  });
}

function failureLines(width: number, submitted: boolean, authoritative?: { readonly effect: "confirmed-changed" | "confirmed-unchanged" | "unconfirmed"; readonly changed: boolean }): string[] {
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (columns === 0) return [""];
  const lines: string[] = [];
  pushWrapped("PiCC MCP administration display failed.", columns, lines);
  if (authoritative !== undefined) pushWrapped(`Known aggregate: ${authoritative.changed ? "confirmed change" : "no confirmed change"} · ${authoritative.effect}. Detailed result rendering failed; refresh for details.`, columns, lines);
  else pushWrapped(submitted ? "Submitted work is unconfirmed and may still be running. Close does not cancel it; refresh is required." : "No administration action was started by this failed UI. Esc closes; re-open MCP administration.", columns, lines);
  return clampLines(lines, columns);
}

/** The service owns mutation authority and eligibility; local UI guards only restrict actions or fail closed. */
export class McpAdministrationFocusController {
  private inventoryState: McpAdministrationInventory;
  private ordered: readonly McpAdministrationInventoryItem[];
  private selected = 0;
  private selectedIdentity?: McpAdministrationUiIdentity;
  private phase: McpAdministrationRenderView["phase"] = Object.freeze({ kind: "list" });
  private refreshing = false;
  private notice?: string;
  private readonly port: McpAdministrationActionPort;
  private readonly tui: TuiPort;
  private theme: unknown;
  private readonly keybindings: KeybindingsPort | undefined;
  private readonly done: (result: McpAdministrationOpenResult) => void;
  private readonly renderFn: typeof renderMcpAdministration;
  private readonly onError?: (error: unknown) => void;
  private cache?: { readonly width: number; readonly revision: number; readonly themeGeneration: number; readonly lines: string[] };
  private revision = 0;
  private themeGeneration = 0;
  private maxScroll = 0;
  private lifecycleEpoch = 0;
  private previewGeneration = 0;
  private refreshGeneration = 0;
  private navigationGeneration = 0;
  private closed = false;
  private disposed = false;
  private executionInFlight = false;
  private actionStarted = false;
  private changed = false;
  private finalEffect: "confirmed-changed" | "confirmed-unchanged" | "unconfirmed" = "confirmed-unchanged";
  private unconfirmed = false;
  private confirmationRendered?: { readonly revision: number; readonly themeGeneration: number };
  private interactionEnabled = true;
  private readonly preparations = new Map<McpAdministrationUiAction, { readonly authority?: McpAdministrationConfirmationAuthority; readonly inventory: McpAdministrationInventory }>();

  constructor(options: {
    inventory: McpAdministrationInventory;
    port: McpAdministrationActionPort;
    tui: TuiPort;
    theme: unknown;
    keybindings?: KeybindingsPort;
    done: (result: McpAdministrationOpenResult) => void;
    render?: typeof renderMcpAdministration;
    onError?: (error: unknown) => void;
    initialIdentity?: McpAdministrationUiIdentity;
    initialAction?: McpAdministrationUiAction;
  }) {
    this.inventoryState = projectInventory(options.inventory);
    this.ordered = orderMcpAdministrationServers(this.inventoryState);
    this.port = options.port;
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.done = options.done;
    this.renderFn = options.render ?? renderMcpAdministration;
    this.onError = options.onError;
    const initialFound = options.initialIdentity === undefined || this.retainIdentity(options.initialIdentity);
    if (options.initialIdentity === undefined && this.ordered[0] !== undefined) this.selectedIdentity = mcpAdministrationIdentity(this.ordered[0]);
    if (initialFound && options.initialAction !== undefined && this.selectedServer() !== undefined) this.enterDetail(options.initialAction);
  }

  render(width: number): string[] {
    const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (this.cache?.width === columns && this.cache.revision === this.revision && this.cache.themeGeneration === this.themeGeneration) return this.cache.lines;
    try {
      this.interactionEnabled = columns >= 16;
      const rendered = this.renderFn(this.view(), { width: columns, theme: this.theme });
      this.maxScroll = rendered.maxScroll;
      const lines = [...rendered.lines];
      this.cache = { width: columns, revision: this.revision, themeGeneration: this.themeGeneration, lines };
      if (this.phase.kind === "confirmation") this.confirmationRendered = { revision: this.revision, themeGeneration: this.themeGeneration };
      return lines;
    } catch (error) {
      this.report(error);
      if (!this.actionStarted) this.finish(fixedNoChange("MCP administration display failed; no action was started."));
      return failureLines(columns, this.actionStarted, this.phase.kind === "result" ? { effect: this.finalEffect, changed: this.changed } : undefined);
    }
  }

  handleInput(data: string): void {
    if (this.closed || this.disposed) return;
    try {
      const matches = (id: string): boolean => {
        try { return this.keybindings?.matches?.(data, id) === true; } catch { return false; }
      };
      const cancel = data === ESC || matches("tui.select.cancel") || matches("app.interrupt");
      if (cancel) {
        if (this.phase.kind === "confirmation") { const action = this.phase.action; this.enterDetail(action); return; }
        if (this.phase.kind === "detail" || this.phase.kind === "result") { this.phase = Object.freeze({ kind: "list" }); this.bump(); return; }
        this.finish(this.actionStarted
          ? Object.freeze({ opened: true, changed: this.changed, effect: this.finalEffect, message: this.finalEffect === "unconfirmed" ? `MCP administration closed with ${this.changed ? "a confirmed change and " : ""}an unconfirmed effect; refresh is required.` : this.changed ? "MCP administration UI closed after an authoritative change." : "MCP administration UI closed after a confirmed unchanged action." })
          : fixedNoChange("MCP administration closed; no action was started."));
        return;
      }
      if ((data === "r" || data === "R") && this.phase.kind !== "executing" && this.phase.kind !== "confirmation") { void this.refresh(); return; }
      if (this.phase.kind === "list") {
        if (data === UP || matches("tui.select.up")) this.moveSelection(-1);
        else if (data === DOWN || matches("tui.select.down")) this.moveSelection(1);
        else if (data === "\r" || data === "\n" || matches("tui.select.confirm")) this.enterDetail();
        return;
      }
      if (this.phase.kind === "detail") {
        if (data === UP || matches("tui.select.up")) this.moveAction(-1);
        else if (data === DOWN || matches("tui.select.down")) this.moveAction(1);
        else if (data === LEFT) this.scroll(-1);
        else if (data === RIGHT) this.scroll(1);
        else if (data === "\r" || data === "\n" || matches("tui.select.confirm")) this.chooseAction();
        return;
      }
      if (this.phase.kind === "confirmation") {
        if (data === UP || matches("tui.select.up")) this.scroll(-1);
        else if (data === DOWN || matches("tui.select.down")) this.scroll(1);
        else if (data === "\r" || data === "\n" || matches("tui.select.confirm")) void this.submit();
        return;
      }
      if (this.phase.kind === "result" && (data === "\r" || data === "\n" || data === LEFT || matches("tui.select.confirm"))) {
        this.phase = Object.freeze({ kind: "list" }); this.bump();
      }
    } catch (error) {
      this.report(error);
      if (!this.actionStarted) this.finish(fixedNoChange("MCP administration input failed; no action was started."));
    }
  }

  invalidate(): void {
    this.themeGeneration += 1;
    this.cache = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleEpoch += 1;
    this.previewGeneration += 1;
    this.refreshGeneration += 1;
    this.cache = undefined;
    this.confirmationRendered = undefined;
  }

  view(): McpAdministrationRenderView {
    return Object.freeze({
      inventory: this.inventoryState,
      orderedServers: this.ordered,
      selectedIndex: this.selected,
      ...(this.selectedIdentity === undefined ? {} : { selectedIdentity: this.selectedIdentity }),
      phase: this.phase,
      refreshing: this.refreshing,
      ...(this.notice === undefined ? {} : { notice: this.notice }),
    });
  }

  private selectedServer(): McpAdministrationInventoryItem | undefined { return this.ordered[this.selected]; }

  private retainIdentity(identity: McpAdministrationUiIdentity): boolean {
    const index = this.ordered.findIndex((server) => sameMcpAdministrationIdentity(mcpAdministrationIdentity(server), identity));
    if (index < 0) { this.selectedIdentity = undefined; return false; }
    this.selected = index;
    this.selectedIdentity = mcpAdministrationIdentity(this.ordered[index]!);
    return true;
  }

  private moveSelection(delta: number): void {
    if (this.ordered.length === 0) return;
    const next = Math.max(0, Math.min(this.ordered.length - 1, this.selected + Math.trunc(delta)));
    if (next === this.selected) return;
    this.selected = next;
    this.navigationGeneration += 1;
    this.selectedIdentity = mcpAdministrationIdentity(this.ordered[next]!);
    this.bump();
  }

  private enterDetail(initialAction?: McpAdministrationUiAction): void {
    const server = this.selectedServer();
    if (server === undefined) return;
    this.navigationGeneration += 1;
    this.preparations.clear();
    this.selectedIdentity = mcpAdministrationIdentity(server);
    const actionIndex = initialAction === undefined ? 0 : Math.max(0, MCP_ADMINISTRATION_ACTIONS.indexOf(initialAction));
    this.phase = Object.freeze({ kind: "detail", actions: this.pendingActions(), actionIndex, scroll: 0 });
    this.bump();
    void this.loadEligibility(this.selectedIdentity);
  }

  private pendingActions(): readonly McpAdministrationActionView[] {
    return Object.freeze(MCP_ADMINISTRATION_ACTIONS.map((action) => Object.freeze({ action, pending: true })));
  }

  private detailPhase(actions = this.phase.kind === "detail" ? this.phase.actions : this.pendingActions(), actionIndex = this.phase.kind === "detail" ? this.phase.actionIndex : 0): McpAdministrationRenderView["phase"] {
    return Object.freeze({ kind: "detail", actions, actionIndex, scroll: 0 });
  }

  private async loadEligibility(identity: McpAdministrationUiIdentity): Promise<void> {
    const generation = ++this.previewGeneration;
    const preparations = await Promise.all(MCP_ADMINISTRATION_ACTIONS.map(async (action): Promise<{ readonly view: McpAdministrationActionView; readonly preparation?: McpAdministrationInteractivePreparation }> => {
      try {
        const preparation = await this.port.interactivePrepare(identity, action);
        return { preparation, view: Object.freeze({ action, pending: false, eligible: preparation.eligibility.eligible, reasonCode: preparation.eligibility.reasonCode }) };
      } catch (error) {
        this.report(error);
        return { view: Object.freeze({ action, pending: false, eligible: false, checkFailed: true }) };
      }
    }));
    if (generation !== this.previewGeneration || this.closed || this.disposed || this.phase.kind !== "detail" || !sameMcpAdministrationIdentity(identity, this.selectedIdentity)) return;
    this.preparations.clear();
    for (const entry of preparations) if (entry.preparation !== undefined) this.preparations.set(entry.view.action, { inventory: projectInventory(entry.preparation.inventory), ...(entry.preparation.authority === undefined ? {} : { authority: entry.preparation.authority }) });
    this.phase = Object.freeze({ ...this.phase, actions: Object.freeze(preparations.map((entry) => entry.view)) });
    this.bump();
  }

  private moveAction(delta: number): void {
    if (this.phase.kind !== "detail") return;
    const next = Math.max(0, Math.min(this.phase.actions.length - 1, this.phase.actionIndex + Math.trunc(delta)));
    if (next === this.phase.actionIndex) return;
    this.phase = Object.freeze({ ...this.phase, actionIndex: next }); this.bump();
  }

  private scroll(delta: number): void {
    if (this.phase.kind !== "detail" && this.phase.kind !== "confirmation") return;
    const next = Math.max(0, Math.min(this.maxScroll, this.phase.scroll + Math.trunc(delta)));
    if (next === this.phase.scroll) return;
    this.phase = Object.freeze({ ...this.phase, scroll: next }); this.bump();
  }

  private chooseAction(): void {
    if (this.phase.kind !== "detail" || !this.interactionEnabled) return;
    const selected = this.phase.actions[this.phase.actionIndex];
    if (selected === undefined || selected.pending) return;
    const inertResult = (message: string): McpAdministrationRenderView["phase"] => Object.freeze({ kind: "result", action: selected.action, effect: this.finalEffect, message, recovery: "not requested", durable: "not requested", runtime: "not requested", exposure: "not requested" });
    if (selected.action === "authenticate") {
      this.phase = inertResult(mcpAdministrationReasonGuidance(selected.reasonCode ?? "authentication-unavailable"));
      this.bump(); return;
    }
    const preparation = this.preparations.get(selected.action);
    if (!selected.eligible || selected.reasonCode === undefined || preparation?.authority === undefined) {
      this.phase = inertResult(selected.checkFailed ? "Eligibility could not be checked; press R to load a fresh snapshot." : mcpAdministrationReasonGuidance(selected.reasonCode ?? "stale-state"));
      this.bump(); return;
    }
    this.replaceInventory(preparation.inventory, this.selectedIdentity);
    if (this.selectedIdentity === undefined) { this.phase = inertResult("The exact prepared identity is no longer present; refresh."); this.bump(); return; }
    this.phase = Object.freeze({ kind: "confirmation", action: selected.action, reasonCode: selected.reasonCode, scroll: 0 });
    this.confirmationRendered = undefined;
    this.bump();
  }

  private async submit(): Promise<void> {
    if (this.phase.kind !== "confirmation" || !this.interactionEnabled || this.executionInFlight || this.confirmationRendered?.revision !== this.revision || this.confirmationRendered.themeGeneration !== this.themeGeneration) return;
    const identity = this.selectedIdentity; const action = this.phase.action; const authority = this.preparations.get(action)?.authority;
    if (identity === undefined || authority === undefined) return;
    const lifecycle = this.lifecycleEpoch;
    this.executionInFlight = true; this.actionStarted = true; this.finalEffect = "unconfirmed";
    this.preparations.delete(action);
    this.phase = Object.freeze({ kind: "executing", action }); this.bump();
    try {
      const result = await this.port.confirmedExecute(authority);
      if (lifecycle !== this.lifecycleEpoch || this.closed || this.disposed) return;
      const projected = projectInventory(result.inventory);
      const retained = mcpAdministrationIdentityFromInventory(projected, identity);
      this.replaceInventory(projected, retained ?? identity);
      const actionEffect = resultEffect(result);
      this.changed ||= resultChanged(result);
      this.unconfirmed ||= actionEffect === "unconfirmed";
      this.finalEffect = this.unconfirmed ? "unconfirmed" : this.changed ? "confirmed-changed" : "confirmed-unchanged";
      this.phase = resultProjection(result, action, this.finalEffect); this.bump();
    } catch (error) {
      this.report(error);
      if (lifecycle !== this.lifecycleEpoch || this.closed || this.disposed) return;
      this.unconfirmed = true; this.finalEffect = "unconfirmed";
      this.phase = Object.freeze({ kind: "result", action, effect: "unconfirmed", message: "Submitted work is unconfirmed and may still be running. Closing does not cancel it; refresh is required before retrying.", recovery: "unconfirmed", durable: "unconfirmed", runtime: "unconfirmed", exposure: "unconfirmed" });
      this.bump();
    } finally {
      if (lifecycle === this.lifecycleEpoch) this.executionInFlight = false;
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    const identity = this.selectedIdentity; const generation = ++this.refreshGeneration;
    const lifecycle = this.lifecycleEpoch; const navigation = this.navigationGeneration;
    this.refreshing = true; this.notice = undefined; this.bump();
    try {
      const inventory = projectInventory(await this.port.inventory());
      if (generation !== this.refreshGeneration || lifecycle !== this.lifecycleEpoch || this.closed || this.disposed || navigation !== this.navigationGeneration) return;
      this.replaceInventory(inventory, identity); this.phase = Object.freeze({ kind: "list" });
      this.notice = identity !== undefined && !sameMcpAdministrationIdentity(identity, this.selectedIdentity) ? "The previously selected exact identity is no longer present." : "Fresh service snapshot loaded.";
    } catch (error) {
      this.report(error);
      if (generation === this.refreshGeneration && lifecycle === this.lifecycleEpoch && !this.closed && !this.disposed) this.notice = "Refresh failed; the prior safe snapshot remains visible and remains usable.";
    } finally {
      if (generation === this.refreshGeneration && lifecycle === this.lifecycleEpoch && !this.closed && !this.disposed) { this.refreshing = false; this.bump(); }
    }
  }

  private replaceInventory(inventory: McpAdministrationInventory, retain?: McpAdministrationUiIdentity): void {
    this.inventoryState = projectInventory(inventory);
    this.ordered = orderMcpAdministrationServers(this.inventoryState);
    this.selected = 0;
    if (retain !== undefined) this.retainIdentity(retain);
    else this.selectedIdentity = this.ordered[0] === undefined ? undefined : mcpAdministrationIdentity(this.ordered[0]);
  }

  private bump(): void {
    this.revision += 1; this.cache = undefined; this.confirmationRendered = undefined;
    try { this.tui.requestRender?.(); } catch (error) { this.report(error); if (!this.actionStarted) this.finish(fixedNoChange("MCP administration repaint failed; no action was started.")); }
  }

  aggregateSnapshot(): McpAdministrationAggregateSnapshot {
    return Object.freeze({ changed: this.changed, effect: this.finalEffect, submitted: this.actionStarted });
  }

  private finish(result: McpAdministrationOpenResult): void {
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    try { this.done(result); } catch (error) { this.report(error); }
  }

  private report(error: unknown): void { try { this.onError?.(error); } catch { /* diagnostics cannot retain focus */ } }
}

function mcpAdministrationIdentityFromInventory(inventory: McpAdministrationInventory, wanted: McpAdministrationUiIdentity): McpAdministrationUiIdentity | undefined {
  const server = inventory.servers.find((candidate) => sameMcpAdministrationIdentity(mcpAdministrationIdentity(candidate), wanted));
  return server === undefined ? undefined : mcpAdministrationIdentity(server);
}

/** Opens the focused MCP administration UI through an available custom-component seam. */
export async function openMcpAdministration(
  ctx: McpAdministrationOpenContext | undefined,
  port: McpAdministrationActionPort,
  options: McpAdministrationFocusOptions = {},
): Promise<McpAdministrationOpenResult> {
  const custom = ctx?.ui?.custom;
  if (typeof custom !== "function") return Object.freeze({ opened: false, changed: false, effect: "confirmed-unchanged", reason: "unavailable", message: "Interactive MCP administration is unavailable; no action was started." });
  let inventory: McpAdministrationInventory;
  try { inventory = projectInventory(await port.inventory()); }
  catch (error) {
    try { options.onError?.(error); } catch { /* best effort */ }
    return Object.freeze({ opened: false, changed: false, effect: "confirmed-unchanged", reason: "snapshot-failed", message: "The safe MCP administration snapshot could not be loaded; no action was started." });
  }
  let component: McpAdministrationFocusController | undefined;
  let completion: McpAdministrationOpenResult | undefined;
  const projectCompletion = (result: McpAdministrationOpenResult): McpAdministrationOpenResult => result.opened
    ? Object.freeze({ opened: true, changed: result.changed, effect: result.effect, message: result.effect === "unconfirmed" ? `MCP administration closed with ${result.changed ? "a confirmed change and " : ""}an unconfirmed effect; refresh is required.` : result.changed ? "MCP administration closed after an authoritative change." : "MCP administration closed with no confirmed change." })
    : result;
  try {
    await Promise.resolve(custom((tui, theme, keybindings, done) => {
      component = new McpAdministrationFocusController({ inventory, port, tui, theme, keybindings, done: (result) => { completion = projectCompletion(result); done(result); }, ...(options.render === undefined ? {} : { render: options.render }), ...(options.onError === undefined ? {} : { onError: options.onError }), ...(options.initialIdentity === undefined ? {} : { initialIdentity: options.initialIdentity }), ...(options.initialAction === undefined ? {} : { initialAction: options.initialAction }) });
      return component;
    }));
    try { component?.dispose(); } catch (error) { try { options.onError?.(error); } catch { /* best effort */ } }
    if (completion !== undefined) return completion;
    const aggregate = component?.aggregateSnapshot();
    if (aggregate === undefined) return fixedNoChange("MCP administration closed; no action was started.");
    return Object.freeze({ opened: false, changed: aggregate.changed, effect: aggregate.effect, reason: "open-failed", message: aggregate.submitted ? `Interactive MCP administration ended abnormally after submission with ${aggregate.changed ? "a confirmed change" : "no confirmed change"} and aggregate effect ${aggregate.effect}; refresh is required.` : "Interactive MCP administration ended abnormally before submission; no action was started." });
  } catch (error) {
    const aggregate = component?.aggregateSnapshot();
    try { component?.dispose(); } catch { /* best effort */ }
    try { options.onError?.(error); } catch { /* best effort */ }
    if (completion !== undefined) return completion;
    if (aggregate === undefined || !aggregate.submitted) return Object.freeze({ opened: false, changed: false, effect: "confirmed-unchanged", reason: "open-failed", message: "Interactive MCP administration failed before submission; no action was started." });
    return Object.freeze({ opened: false, changed: aggregate.changed, effect: "unconfirmed", reason: "open-failed", message: `Interactive MCP administration failed after submission with ${aggregate.changed ? "a confirmed change and " : ""}an unconfirmed effect; refresh is required.` });
  }
}

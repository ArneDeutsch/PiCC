import type { PluginInventorySnapshot } from "../plugin-inventory.js";
import { clampLines, pushWrapped } from "./render-util.js";
import { PluginInventoryModel } from "./plugin-inventory-model.js";
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
}

function printableText(data: string): string | undefined {
  if (!data) return undefined;
  const flattened = [...data].length > 1 ? data.replace(/\r\n|[\r\n\t]/gu, " ") : data;
  for (const character of flattened) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return undefined;
  }
  return flattened;
}

function fallbackLines(width: number, identity?: string): string[] {
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (columns === 0) return [""];
  const safeIdentity = parseQualifiedPluginId(identity)?.qualifiedIdentity;
  const lines: string[] = [];
  pushWrapped("PiCC plugin inventory · read-only · captured for this session", columns, lines);
  pushWrapped(safeIdentity === undefined
    ? "Plugin inventory display failed. Esc closes. Use /plugin list, then /plugin details <qualified-name>."
    : `Plugin details display failed for ${safeIdentity}. Esc closes. Use /plugin list or run /plugin details ${safeIdentity}`, columns, lines);
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

  constructor(options: {
    snapshot: PluginInventorySnapshot;
    tui: PluginInventoryTuiPort;
    theme: unknown;
    keybindings?: PluginInventoryKeybindingsPort;
    done: (value?: unknown) => void;
    render?: typeof renderPluginInventory;
    onError?: (error: unknown) => void;
  }) {
    this.model = new PluginInventoryModel(options.snapshot);
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.done = options.done;
    this.renderFn = options.render ?? renderPluginInventory;
    this.onError = options.onError;
  }

  render(width: number): string[] {
    const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const revision = this.model.revision();
    if (this.cache?.width === columns && this.cache.revision === revision && this.cache.generation === this.generation) return this.cache.lines;
    try {
      const rendered: PluginInventoryRenderResult = this.renderFn(this.model.view(), { width: columns, theme: this.theme });
      this.lastMaxScroll = rendered.maxDetailScroll;
      const lines = [...rendered.lines];
      this.cache = { width: columns, revision, generation: this.generation, lines };
      return lines;
    } catch (error) {
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
        const lines = fallbackLines(columns, identity);
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
        // The visible ladder is detail → filtered list → close; no Esc may leave an identical screen.
        if (this.model.leaveDetail()) this.repaintIfChanged(before);
        else if (this.model.clearFilter()) this.repaintIfChanged(before);
        else this.close();
        return;
      }
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
    this.cache = undefined;
  }

  /** Test and integration introspection; returns a detached pure view. */
  view() { return this.model.view(); }

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

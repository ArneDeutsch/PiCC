import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatUsageCompact, sanitizeLine } from "./subagent-progress.js";
import { clampLines, themedFg } from "./render-util.js";
import type { PanelRowView, PanelViewModel } from "./subagent-panel-model.js";

/**
 * Subagent status-panel renderer: pure PanelViewModel → clamped string lines.
 * Every emitted line is <= width in pi-tui `visibleWidth` terms (the
 * crash-critical invariant — pi-tui kills the process on an over-wide line),
 * and every model-/file-supplied string passes sanitizeLine at render even
 * though capture already sanitized most of them (defense in depth; agentName
 * is deliberately raw in the record and is sanitized ONLY here).
 */

// --- glyphs and animation frames (exported so t04's widget and docs share them) ---

/** Spinner frames for a running row; the caller supplies the current frame. */
export const PANEL_RUNNING_FRAMES: readonly string[] = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];
/** Finished-state bubbles — distinct glyphs, not color-alone. */
export const PANEL_GLYPH_SUCCESS = "●";
export const PANEL_GLYPH_FAILED = "✗";
export const PANEL_GLYPH_STOPPED = "■";

/** Theme slot per row state (bubble color). */
const STATE_COLOR: Record<PanelRowView["state"], string> = {
  running: "accent",
  success: "success",
  failed: "error",
  stopped: "warning",
};

function stateGlyph(state: PanelRowView["state"], runningFrame: string | undefined): string {
  switch (state) {
    case "running":
      return runningFrame || PANEL_RUNNING_FRAMES[0]!;
    case "success":
      return PANEL_GLYPH_SUCCESS;
    case "failed":
      return PANEL_GLYPH_FAILED;
    case "stopped":
      return PANEL_GLYPH_STOPPED;
  }
}

// --- Claude agent-color tinting ---

// Raw ANSI, because Pi's `theme.fg` takes a CLOSED union of theme slots and
// cannot express Claude's fixed agent color names; emitting raw ANSI inside a
// component we own is the sanctioned escape hatch (see "Colors and themes" in
// doc/tui-extension-guide.md). ESC built from a code point so the source stays
// pure ASCII.
const ESC = String.fromCharCode(27);
/** Default-foreground reset — resets only the color this map set. */
const FG_RESET = `${ESC}[39m`;

/**
 * Claude's fixed agent-frontmatter color set → ANSI foreground codes. t01
 * guarantees only these names reach a record, but the map is still consulted
 * defensively: an unknown value falls back to no tint, never a throw.
 */
export const AGENT_COLOR_ANSI: Readonly<Record<string, string>> = {
  red: `${ESC}[31m`,
  blue: `${ESC}[34m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  purple: `${ESC}[35m`,
  orange: `${ESC}[38;5;208m`,
  pink: `${ESC}[38;5;205m`,
  cyan: `${ESC}[36m`,
};

/**
 * Tint `text` with a Claude agent color name; unknown/absent → untinted. The
 * own-key check matters: a plain-object lookup would resolve inherited
 * prototype keys ("constructor", "toString") to truthy functions and
 * interpolate them into the row.
 */
export function tintAgentColor(color: string | undefined, text: string): string {
  const code = color && Object.hasOwn(AGENT_COLOR_ANSI, color) ? AGENT_COLOR_ANSI[color] : undefined;
  return code ? `${code}${text}${FG_RESET}` : text;
}

// --- hint / affordance lines (t05 and the docs reuse these exact strings) ---

/**
 * The unfocused footer hint. CONTRACT: it names the entry chord — for a
 * single-agent run this line is the user's only discovery path into the panel
 * (the one-time chat hint fires only for >1 agent). The chord string is
 * injected by the caller (t04 owns the chord constant).
 */
export function panelHintUnfocused(entryChord: string): string {
  return `${entryChord}: agent panel`;
}

/** The focused footer hint: the panel's key map (t05 binds these keys). */
export const PANEL_HINT_FOCUSED =
  "↑↓ select · enter open · x stop · X stop all · d dismiss · esc close";

/** Overflow affordances for rows scrolled out of the bounded window. */
export function panelMoreAbove(n: number): string {
  return `… ${n} more above`;
}
export function panelMoreBelow(n: number): string {
  return `… ${n} more`;
}

/** Below this width the whole panel degrades to a single summary line. */
export const PANEL_NARROW_WIDTH = 40;

/** `12s` / `4m12s` / `1h04m` — the row's elapsed column. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

export interface PanelRenderOptions {
  width: number;
  /** Pi's Theme — null-guarded throughout; absent degrades to plain text. */
  theme?: unknown;
  /** Current spinner frame for running rows (caller animates). */
  runningFrame?: string;
  /** The panel entry chord string, e.g. "alt+a" (t04's constant). */
  entryChord: string;
}

/** A measured display segment: plain for width math, styled for output. */
interface Seg {
  plain: string;
  styled: string;
}

function segWidth(segs: readonly (Seg | undefined)[]): number {
  let w = 0;
  for (const s of segs) if (s) w += visibleWidth(s.plain);
  return w;
}

function segJoin(segs: readonly (Seg | undefined)[]): string {
  let out = "";
  for (const s of segs) if (s) out += s.styled;
  return out;
}

/** Visual indent cap: deeper trees stay valid but stop eating row width. */
const MAX_INDENT_LEVELS = 6;
/** Render-side caps for row fields (records are already capture-capped). */
const TYPE_RENDER_CAP = 60;
const LABEL_RENDER_CAP = 160;
const ACTIVITY_RENDER_CAP = 160;

/**
 * One panel row as a single line. Width degrade order when the line does not
 * fit: tokens → activity → elapsed → elastic label truncation; the final
 * clamp in renderSubagentPanel() is the safety net for the residue.
 */
function renderPanelRow(row: PanelRowView, opts: PanelRenderOptions, focused: boolean): string {
  const { width, theme } = opts;
  const muted = (text: string): Seg => ({ plain: text, styled: themedFg(theme, "muted", text) });

  const marker: Seg | undefined = focused
    ? row.selected
      ? { plain: "❯ ", styled: themedFg(theme, "accent", "❯ ") }
      : { plain: "  ", styled: "  " }
    : undefined;
  const indentText = "  ".repeat(Math.min(Math.max(0, row.treeDepth), MAX_INDENT_LEVELS));
  const indent: Seg = { plain: indentText, styled: indentText };
  const glyphText = stateGlyph(row.state, opts.runningFrame);
  const glyph: Seg = {
    plain: `${glyphText} `,
    styled: `${themedFg(theme, STATE_COLOR[row.state], glyphText)} `,
  };
  // SECURITY: agentName is the ONE record field deliberately unsanitized at
  // capture (it is the registry's name-index key) — hostile project
  // frontmatter `name:` must be sanitized at EVERY render, here.
  const typeText = sanitizeLine(row.agentType, TYPE_RENDER_CAP) || "agent";
  // Tint only when a theme is present — themeless renders degrade to plain
  // text everywhere else (render-util's convention), so the tint follows suit.
  const type: Seg = {
    plain: typeText,
    styled: theme ? tintAgentColor(row.color, typeText) : typeText,
  };
  const chip: Seg | undefined =
    row.hiddenDescendants > 0 ? muted(` (+${row.hiddenDescendants})`) : undefined;

  const labelText = sanitizeLine(row.label, LABEL_RENDER_CAP);
  // The label column falls back to agentName; when it IS the agent name the
  // type segment already shows it — render no duplicate.
  const hasLabel = labelText !== "" && labelText !== typeText;
  const activityText = sanitizeLine(row.activity, ACTIVITY_RENDER_CAP);
  const activity: Seg | undefined = activityText ? muted(` · ${activityText}`) : undefined;
  const elapsed: Seg = muted(` · ${formatElapsed(row.elapsedMs)}`);
  // Tokens are BLANK until known — a fake 0 is worse than no figure.
  const usageText = row.usage ? formatUsageCompact(row.usage) : undefined;
  const tokens: Seg | undefined = usageText ? muted(` · ${usageText}`) : undefined;

  const labelSeg = (text: string): Seg => muted(` ${text}`);
  const fixed = [marker, indent, glyph, type, chip];
  const label = hasLabel ? labelSeg(labelText) : undefined;
  const attempts: (Seg | undefined)[][] = [
    [...fixed, label, activity, elapsed, tokens],
    [...fixed, label, activity, elapsed],
    [...fixed, label, elapsed],
    [...fixed, label],
  ];
  for (const segs of attempts) {
    if (segWidth(segs) <= width) return segJoin(segs);
  }
  // Elastic label truncation: give the label whatever the fixed columns leave.
  if (hasLabel) {
    const room = width - segWidth(fixed) - 1; // 1 = the label's leading space
    if (room >= 2) {
      const truncated = truncateToWidth(labelText, room, "…");
      return segJoin([...fixed, labelSeg(truncated)]);
    }
  }
  return segJoin(fixed);
}

/** The whole-panel single line for very narrow terminals. */
function renderSummaryLine(view: PanelViewModel, opts: PanelRenderOptions): string {
  const glyphText =
    view.runningCount > 0
      ? stateGlyph("running", opts.runningFrame)
      : PANEL_GLYPH_SUCCESS;
  const glyphColor = view.runningCount > 0 ? "accent" : "success";
  const parts: string[] = [];
  if (view.runningCount > 0) parts.push(`${view.runningCount} running`);
  if (view.settledCount > 0) parts.push(`${view.settledCount} done`);
  return (
    `${themedFg(opts.theme, glyphColor, glyphText)} ` +
    themedFg(opts.theme, "muted", parts.join(" · ") || "agents")
  );
}

/**
 * Render the status panel: windowed rows, overflow affordances, and the muted
 * footer hint. Returns [] when the view is empty (the panel disappears).
 */
export function renderSubagentPanel(view: PanelViewModel, opts: PanelRenderOptions): string[] {
  if (view.empty) return [];
  const width = opts.width;
  if (width < PANEL_NARROW_WIDTH) {
    return clampLines([renderSummaryLine(view, opts)], width);
  }
  const lines: string[] = [];
  if (view.hiddenAbove > 0) {
    lines.push(themedFg(opts.theme, "muted", panelMoreAbove(view.hiddenAbove)));
  }
  for (const row of view.rows) {
    lines.push(renderPanelRow(row, opts, view.focused));
  }
  if (view.hiddenBelow > 0) {
    lines.push(themedFg(opts.theme, "muted", panelMoreBelow(view.hiddenBelow)));
  }
  lines.push(
    themedFg(
      opts.theme,
      "muted",
      view.focused ? PANEL_HINT_FOCUSED : panelHintUnfocused(opts.entryChord),
    ),
  );
  return clampLines(lines, width);
}

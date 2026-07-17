import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatUsageCompact, sanitizeLine, sanitizeProgressText } from "./subagent-progress.js";
import { clampLines, pushWrapped, themedFg } from "./render-util.js";
import type { PanelRowView, PanelViewModel } from "./subagent-panel-model.js";
import { guardSteer, type SubagentRegistryRecord } from "./subagent-registry.js";

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
 * Claude's fixed agent-frontmatter color set → ANSI foreground codes. Capture
 * validation (`AGENT_COLOR_NAMES` in subagent-registry.ts) guarantees only
 * these names reach a record — a test pins the two sets equal so capture and
 * render cannot drift — but the map is still consulted defensively: an
 * unknown value falls back to no tint, never a throw.
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
 * (the one-time status-line hint fires only for >1 agent). The chord string is
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

// --- drill-down detail view --------------------------------------------------

/** Scrollable body viewport height (lines) inside the drill-down. */
const DETAIL_BODY_ROWS = 12;
/**
 * Detail-view chords, shown in hints. Control chords, not plain letters:
 * inside the drill-down every printable key types into the steer buffer.
 */
const DETAIL_PROMPT_KEY = "ctrl+p";
const DETAIL_STOP_KEY = "ctrl+x";

// Banners for live state changes while the drill-down is open — the view
// re-resolves its record each render and narrates the transition instead of
// crashing or freezing on it.
export const DETAIL_BANNER_SETTLED = "agent settled while viewing — final answer shown";
export const DETAIL_BANNER_RESUMED = "agent resumed while viewing — live view";
export const DETAIL_BANNER_VANISHED = "agent record is no longer available — esc back";

export const DETAIL_STEER_SENT = "steer sent — delivered before the agent's next model call";
export function detailSteerFailed(reason: string): string {
  return `steer failed: ${reason}`;
}
/**
 * The honest alternative named beside a foreground steering refusal: a
 * foreground dispatch blocks the parent's turn, so the only real control the
 * user has is the editor's own turn cancel.
 */
export const DETAIL_FOREGROUND_ALT = "esc to editor; esc there cancels the whole turn";
export function detailSteerUnavailable(reason: string): string {
  return `steering unavailable (${reason})`;
}

export function detailPromptCollapsed(lineCount: number): string {
  return `initial prompt (${lineCount} line${lineCount === 1 ? "" : "s"}) — ${DETAIL_PROMPT_KEY} to expand`;
}
export const DETAIL_PROMPT_EXPANDED = `initial prompt — ${DETAIL_PROMPT_KEY} to collapse`;
export const DETAIL_NO_ACTIVITY = "(no activity captured yet)";
export const DETAIL_NO_TAIL = "(no transcript tail captured)";
export const DETAIL_NO_FINAL_ANSWER = "(no final answer captured)";
export const DETAIL_FINAL_LABEL = "final answer:";
export const DETAIL_TAIL_LABEL = "transcript tail:";
/** The pinned steer input line's prefix. */
export const DETAIL_STEER_PREFIX = "steer › ";

/** Per-state footer hint — only keys that actually work in that state. */
export function detailHint(opts: { steerable: boolean; stoppable: boolean }): string {
  const parts: string[] = [];
  if (opts.steerable) parts.push("type to steer · enter send");
  if (opts.stoppable) parts.push(`${DETAIL_STOP_KEY} stop`);
  parts.push(`${DETAIL_PROMPT_KEY} prompt`, "↑↓ scroll", "esc back");
  return parts.join(" · ");
}

/** Display-side per-line sanitize cap for detail body/notice content. */
const DETAIL_LINE_CAP = 300;

/** UI state the focus controller owns and threads through every detail render. */
export interface PanelDetailUiState {
  promptExpanded: boolean;
  /** Body scroll anchor: lines from the TOP of the body; ignored while `follow`. */
  scrollTop: number;
  /** Auto-follow the newest body line (the running-view default). */
  follow: boolean;
  steerBuffer: string;
  /** Inline one-line notice (send confirmation, refusal, failure). */
  notice?: string;
  /** Live state-change banner (settled/resumed/vanished while open). */
  banner?: string;
}

/** Per-render data, re-resolved by the caller from the registries each time. */
export interface PanelDetailData {
  /** Absent when the record cannot be resolved — renders the vanished banner. */
  record?: SubagentRegistryRecord;
  /** Newest-generation background task id, when the agent has one. */
  taskId?: string;
  nowMs: number;
}

export interface DetailRenderOptions {
  width: number;
  theme?: unknown;
  runningFrame?: string;
}

export interface PanelDetailRender {
  lines: string[];
  /** Max valid scrollTop for this body/viewport — the caller clamps its state. */
  maxScroll: number;
}

/**
 * Right-anchored width fit for the steer input line: the END of the buffer
 * (where the cursor is) must stay visible, so overflow truncates from the
 * LEFT — the one line where truncateToWidth's end-ellipsis is wrong.
 */
function tailToWidth(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (visibleWidth(text) <= maxCols) return text;
  const chars = [...text];
  let out = "";
  let used = 1; // reserved for the leading ellipsis
  for (let i = chars.length - 1; i >= 0; i--) {
    const charWidth = visibleWidth(chars[i]!);
    if (used + charWidth > maxCols) break;
    out = chars[i]! + out;
    used += charWidth;
  }
  return `…${out}`;
}

/**
 * Steer availability for display. The authoritative predicate is t01's
 * guardSteer (the send path uses ONLY its bound steer fn); this maps the same
 * ordering onto short display reasons, and the foreground case names the real
 * alternative rather than a dead end.
 */
type DetailSteerSlot = { kind: "input" } | { kind: "notice"; text: string } | { kind: "none" };

function detailSteerSlot(record: SubagentRegistryRecord): DetailSteerSlot {
  if (record.state !== "running") return { kind: "none" };
  if (guardSteer(record).ok) return { kind: "input" };
  if (record.oneShot) return { kind: "notice", text: detailSteerUnavailable("one-shot agent") };
  if (record.userStopped) {
    return { kind: "notice", text: detailSteerUnavailable("stopped by user") };
  }
  return {
    kind: "notice",
    text: `${detailSteerUnavailable("foreground agent")} — ${DETAIL_FOREGROUND_ALT}`,
  };
}

/**
 * The drill-down view: header → (banner) → scrollable body → notice/steer →
 * hint. Layout by state — running leads with the live tail (auto-following),
 * finished leads with the final answer. Pure and never-throwing over its
 * inputs; every emitted line is <= width (clampLines) and all record content
 * is re-sanitized at render (defense in depth over the capture-time pass).
 * The transcript path is rendered as an INERT pointer string only — the
 * drill-down never re-reads the JSONL.
 */
export function renderSubagentDetail(
  data: PanelDetailData,
  ui: PanelDetailUiState,
  opts: DetailRenderOptions,
): PanelDetailRender {
  const { width, theme } = opts;
  const muted = (text: string): string => themedFg(theme, "muted", text);
  const record = data.record;
  const lines: string[] = [];
  if (!record) {
    // Same sanitize discipline as the record branch's banner — the vanished
    // branch must not become the one path that trusts ui.banner raw.
    lines.push(
      themedFg(theme, "warning", sanitizeLine(ui.banner ?? DETAIL_BANNER_VANISHED, DETAIL_LINE_CAP)),
    );
    lines.push(muted("esc back"));
    return { lines: clampLines(lines, width), maxScroll: 0 };
  }

  const running = record.state === "running";
  const rowState: PanelRowView["state"] = running
    ? "running"
    : record.userStopped || record.outcome === "aborted"
      ? "stopped"
      : record.outcome === "failed"
        ? "failed"
        : "success";
  const glyphText = stateGlyph(rowState, opts.runningFrame);
  // agentName is the one deliberately-raw record field — sanitize at render.
  const typeText = sanitizeLine(record.agentName, TYPE_RENDER_CAP) || "agent";
  const labelText = sanitizeLine(record.description ?? "", LABEL_RENDER_CAP);
  lines.push(
    `${themedFg(theme, STATE_COLOR[rowState], glyphText)} ` +
      (theme ? tintAgentColor(record.color, typeText) : typeText) +
      (labelText && labelText !== typeText ? muted(` · ${labelText}`) : ""),
  );
  const elapsedEnd = running ? data.nowMs : (record.settledAt ?? record.startedAt);
  // Defense-in-depth consistency: agentId and the outcome word are typed
  // unions/ids today, but the meta line sanitizes every interpolated field
  // like the rest of the view instead of trusting record shape.
  const statusWord = running
    ? "running"
    : record.userStopped
      ? "stopped by user"
      : sanitizeLine(record.outcome ?? "settled", 60);
  const meta: string[] = [sanitizeLine(record.agentId, 60)];
  if (data.taskId) meta.push(sanitizeLine(data.taskId, 60));
  meta.push(formatElapsed(Math.max(0, elapsedEnd - record.startedAt)), statusWord);
  lines.push(muted(meta.join(" · ")));
  if (record.transcriptPath) {
    lines.push(muted(`transcript: ${sanitizeLine(record.transcriptPath, 200)}`));
  }
  if (ui.banner) lines.push(themedFg(theme, "warning", sanitizeLine(ui.banner, DETAIL_LINE_CAP)));

  // Scrollable body, assembled per state.
  const body: string[] = [];
  // sanitizeProgressText deliberately PRESERVES \r (capture-side callers line-
  // split themselves), so the multi-line paths must split on CR too: a lone
  // \r surviving into an emitted line would let hostile content overprint the
  // line from column 0 (same-line spoof). The tail path is already immune via
  // sanitizeLine's whitespace collapse.
  const LINE_BREAK_RE = /\r\n?|\n/;
  const pushMultiline = (text: string): void => {
    for (const raw of sanitizeProgressText(text).split(LINE_BREAK_RE)) {
      pushWrapped(raw, width, body);
    }
  };
  const promptLines = record.prompt
    ? sanitizeProgressText(record.prompt).split(LINE_BREAK_RE)
    : [];
  const pushPrompt = (): void => {
    if (promptLines.length === 0) return;
    if (ui.promptExpanded) {
      body.push(muted(DETAIL_PROMPT_EXPANDED));
      for (const raw of promptLines) pushWrapped(raw, width, body);
    } else {
      body.push(muted(detailPromptCollapsed(promptLines.length)));
    }
  };
  const tailLines = record.fullTail ?? [];
  const pushTail = (): void => {
    if (tailLines.length === 0) {
      body.push(muted(running ? DETAIL_NO_ACTIVITY : DETAIL_NO_TAIL));
      return;
    }
    for (const raw of tailLines) pushWrapped(sanitizeLine(raw, DETAIL_LINE_CAP), width, body);
  };
  if (running) {
    // The collapsed one-liner is PINNED between header and tail (the spec's
    // running layout) so the auto-following tail can never scroll it away;
    // the expanded prompt joins the scrollable body instead.
    if (promptLines.length > 0 && !ui.promptExpanded) {
      lines.push(muted(detailPromptCollapsed(promptLines.length)));
    }
    if (ui.promptExpanded) pushPrompt();
    pushTail();
  } else {
    body.push(muted(DETAIL_FINAL_LABEL));
    if (record.finalText) pushMultiline(record.finalText);
    else body.push(muted(DETAIL_NO_FINAL_ANSWER));
    pushPrompt();
    body.push(muted(DETAIL_TAIL_LABEL));
    pushTail();
  }

  const maxScroll = Math.max(0, body.length - DETAIL_BODY_ROWS);
  const top = ui.follow ? maxScroll : Math.min(Math.max(0, ui.scrollTop), maxScroll);
  const end = Math.min(body.length, top + DETAIL_BODY_ROWS);
  if (top > 0) lines.push(muted(panelMoreAbove(top)));
  for (let i = top; i < end; i++) lines.push(body[i]!);
  if (end < body.length) lines.push(muted(panelMoreBelow(body.length - end)));

  if (ui.notice) lines.push(themedFg(theme, "warning", sanitizeLine(ui.notice, DETAIL_LINE_CAP)));
  const slot = detailSteerSlot(record);
  if (slot.kind === "input") {
    const avail = Math.max(0, width - visibleWidth(DETAIL_STEER_PREFIX));
    lines.push(themedFg(theme, "accent", DETAIL_STEER_PREFIX) + tailToWidth(ui.steerBuffer, avail));
  } else if (slot.kind === "notice") {
    lines.push(muted(slot.text));
  }
  lines.push(
    muted(
      detailHint({
        steerable: slot.kind === "input",
        stoppable: running && data.taskId !== undefined,
      }),
    ),
  );
  return { lines: clampLines(lines, width), maxScroll };
}

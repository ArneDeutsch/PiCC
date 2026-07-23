import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AGENT_COLOR_ANSI, tintAgentColor } from "./agent-color.js";
import {
  DETAIL_FIELD_MAX_LENGTH,
  DETAIL_LOG_MAX_ENTRIES,
  formatPresentationCostUsd,
  formatPresentationCount,
  sanitizeDetailScalar,
  sanitizeLine,
  sanitizeProgressText,
  scalarSafeText,
  type SubagentDetailEntry,
} from "./subagent-progress.js";
import { clampLines, pushWrapped, themedFg } from "./render-util.js";
import type { PanelRowView, PanelViewModel } from "./subagent-panel-model.js";
import {
  guardSteer,
  SUBAGENT_FINAL_TEXT_CAP,
  SUBAGENT_PROMPT_CAP,
  type SubagentRegistryRecord,
} from "./subagent-registry.js";

export { AGENT_COLOR_ANSI, tintAgentColor } from "./agent-color.js";

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
/** Waiting/finished-state bubbles — distinct glyphs, not color-alone. */
export const PANEL_GLYPH_WAITING = "◌";
export const PANEL_GLYPH_SUCCESS = "●";
export const PANEL_GLYPH_FAILED = "✗";
export const PANEL_GLYPH_STOPPED = "■";

/** Theme slot per row state (bubble color). */
const STATE_COLOR: Record<PanelRowView["state"], string> = {
  running: "accent",
  waiting: "warning",
  success: "success",
  failed: "error",
  stopped: "warning",
};

function stateGlyph(state: PanelRowView["state"], runningFrame: string | undefined): string {
  switch (state) {
    case "running":
      return runningFrame || PANEL_RUNNING_FRAMES[0]!;
    case "waiting":
      return PANEL_GLYPH_WAITING;
    case "success":
      return PANEL_GLYPH_SUCCESS;
    case "failed":
      return PANEL_GLYPH_FAILED;
    case "stopped":
      return PANEL_GLYPH_STOPPED;
  }
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
  /** The panel entry chord string, e.g. "alt+a". */
  entryChord: string;
}

/** Visual indent cap: deeper trees stay valid but stop eating row width. */
const MAX_INDENT_LEVELS = 6;
const TYPE_RENDER_CAP = 60;
const LABEL_RENDER_CAP = 160;
const COLUMN_GAP = "  ";
const DESCRIPTION_GAP = " ";
const MIN_USEFUL_IDENTITY_WIDTH = 3;
const MIN_USEFUL_DESCRIPTION_WIDTH = 3;
/** Smallest ordinary row: state glyph + space + a useful identity fragment. */
export const PANEL_MIN_ROW_WIDTH = 5;

type MetricKey = "elapsed" | "input" | "output" | "cacheRead" | "cacheWrite" | "cost";
const METRIC_ORDER: readonly MetricKey[] = [
  "elapsed",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cost",
];
const DROP_ORDER: readonly MetricKey[] = [
  "cacheWrite",
  "cacheRead",
  "cost",
  "output",
  "input",
  "elapsed",
];

interface PlainPanelRow {
  source: PanelRowView;
  marker: string;
  indent: string;
  glyph: string;
  identity: string;
  status: string;
  chip: string;
  description: string;
  metrics: Record<MetricKey, string | undefined>;
}

function panelFg(theme: unknown, color: string, text: string): string {
  try {
    return themedFg(theme, color, text);
  } catch {
    return text;
  }
}

function finiteUsageValue(row: PanelRowView, key: keyof NonNullable<PanelRowView["usage"]>): number | undefined {
  try {
    const value = row.usage?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function preparePanelRow(row: PanelRowView, opts: PanelRenderOptions, focused: boolean): PlainPanelRow {
  const identity = scalarSafeText(sanitizeLine(row.agentType, TYPE_RENDER_CAP)) || "agent";
  const label = scalarSafeText(sanitizeLine(row.label, LABEL_RENDER_CAP));
  const rawCacheRead = finiteUsageValue(row, "cacheReadTokens");
  const rawCacheWrite = finiteUsageValue(row, "cacheWriteTokens");
  const cacheRead = rawCacheRead !== undefined && rawCacheRead > 0
    ? formatPresentationCount(rawCacheRead)
    : undefined;
  const cacheWrite = rawCacheWrite !== undefined && rawCacheWrite > 0
    ? formatPresentationCount(rawCacheWrite)
    : undefined;
  const input = formatPresentationCount(finiteUsageValue(row, "inputTokens"));
  const output = formatPresentationCount(finiteUsageValue(row, "outputTokens"));
  const cost = formatPresentationCostUsd(finiteUsageValue(row, "costUsd"));
  return {
    source: row,
    marker: focused ? (row.selected ? "❯ " : "  ") : "",
    indent: "  ".repeat(Math.min(Math.max(0, row.treeDepth), MAX_INDENT_LEVELS)),
    glyph: stateGlyph(row.state, opts.runningFrame),
    identity,
    status: row.state === "waiting" ? " [waiting]" : "",
    chip: row.hiddenDescendants > 0 ? ` (+${row.hiddenDescendants})` : "",
    description: label && label !== identity ? label : "",
    metrics: {
      elapsed: formatElapsed(row.elapsedMs),
      input: input === undefined ? undefined : `in ${input}`,
      output: output === undefined ? undefined : `out ${output}`,
      cacheRead: cacheRead === undefined ? undefined : `c/read ${cacheRead}`,
      cacheWrite: cacheWrite === undefined ? undefined : `c/write ${cacheWrite}`,
      cost,
    },
  };
}

function leftPad(text: string, width: number): string {
  return `${" ".repeat(Math.max(0, width - visibleWidth(text)))}${text}`;
}

function rightPad(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function renderAggregate(view: PanelViewModel, opts: PanelRenderOptions): string[] {
  const allEntries: Array<{ state: PanelRowView["state"]; count: number; word: string }> = [
    { state: "failed", count: view.failedCount, word: "failed" },
    { state: "stopped", count: view.stoppedCount, word: "stopped" },
    { state: "running", count: view.runningCount, word: "running" },
    { state: "waiting", count: view.waitingCount, word: "waiting" },
    { state: "success", count: view.completedCount, word: "completed" },
  ];
  const entries = allEntries.filter((entry) => entry.count > 0);
  const rendered = entries.map(({ state, count, word }) => {
    const glyph = stateGlyph(state, opts.runningFrame);
    return `${panelFg(opts.theme, STATE_COLOR[state], glyph)} ${panelFg(opts.theme, "muted", `${count} ${word}`)}`;
  });
  const joined = rendered.join(panelFg(opts.theme, "muted", " · "));
  const lines = visibleWidth(joined) <= opts.width
    ? [joined]
    : rendered.map((line, index) => visibleWidth(line) <= opts.width
      ? line
      : panelFg(opts.theme, STATE_COLOR[entries[index]!.state], stateGlyph(entries[index]!.state, opts.runningFrame)));
  const hint = view.focused ? PANEL_HINT_FOCUSED : panelHintUnfocused(opts.entryChord);
  if (visibleWidth(hint) <= opts.width) lines.push(panelFg(opts.theme, "muted", hint));
  return clampLines(lines, opts.width);
}

/**
 * Render one shared table profile for the complete visible row window. Plain
 * cells are sanitized and measured before any styling is applied.
 */
export function renderSubagentPanel(view: PanelViewModel, opts: PanelRenderOptions): string[] {
  if (view.empty) return [];
  const rows = view.rows.map((row) => preparePanelRow(row, opts, view.focused));
  const fullGutterWidth = Math.max(...rows.map((row) => visibleWidth(`${row.marker}${row.indent}${row.glyph} `)));
  const identityNaturalWidth = Math.max(...rows.map((row) => visibleWidth(row.identity)));
  const suffixNaturalWidth = Math.max(...rows.map((row) => visibleWidth(row.status) + visibleWidth(row.chip)));
  const descriptionNaturalWidth = Math.max(...rows.map((row) => visibleWidth(row.description)));

  const metricWidths = new Map<MetricKey, number>();
  for (const key of METRIC_ORDER) {
    const eligible = rows.map((row) => row.metrics[key]).filter((value): value is string => value !== undefined);
    if (eligible.length > 0) metricWidths.set(key, Math.max(...eligible.map(visibleWidth)));
  }
  const active = new Set(metricWidths.keys());
  const metricTotal = (): number =>
    [...active].reduce((sum, key) => sum + visibleWidth(COLUMN_GAP) + metricWidths.get(key)!, 0);
  const hasDescription = descriptionNaturalWidth > 0;
  const descriptionGapWidth = hasDescription ? visibleWidth(DESCRIPTION_GAP) : 0;
  const naturalWidth = (): number =>
    fullGutterWidth + identityNaturalWidth + suffixNaturalWidth +
      descriptionGapWidth + descriptionNaturalWidth + metricTotal();
  for (const key of DROP_ORDER) {
    if (naturalWidth() <= opts.width) break;
    active.delete(key);
  }

  if (opts.width < PANEL_MIN_ROW_WIDTH) return renderAggregate(view, opts);

  const availableLeft = Math.max(0, opts.width - metricTotal());
  const minimumIdentityWidth = Math.max(...rows.map((row) =>
    Math.min(MIN_USEFUL_IDENTITY_WIDTH, visibleWidth(row.identity))
  ));
  const descriptionFits = hasDescription && availableLeft >=
    fullGutterWidth + minimumIdentityWidth + suffixNaturalWidth +
      descriptionGapWidth + MIN_USEFUL_DESCRIPTION_WIDTH;
  const suffixFits = availableLeft >=
    fullGutterWidth + minimumIdentityWidth + suffixNaturalWidth;
  const fullGutterFits = availableLeft >=
    fullGutterWidth + minimumIdentityWidth + (suffixFits ? suffixNaturalWidth : 0);
  const gutterWidth = fullGutterFits ? fullGutterWidth : 2;
  const suffixWidth = suffixFits ? suffixNaturalWidth : 0;
  const identityWidth = descriptionFits
    ? Math.min(identityNaturalWidth + suffixWidth,
      availableLeft - gutterWidth - descriptionGapWidth - MIN_USEFUL_DESCRIPTION_WIDTH)
    : availableLeft - gutterWidth;
  const descriptionWidth = descriptionFits
    ? availableLeft - gutterWidth - identityWidth - descriptionGapWidth
    : 0;
  const hasDescriptionCell = descriptionFits;

  const renderedRows = rows.map((row) => {
    const markerPlain = fullGutterFits ? row.marker : "";
    const marker = row.source.selected
      ? panelFg(opts.theme, "accent", markerPlain)
      : markerPlain;
    const indent = fullGutterFits ? row.indent : "";
    const glyph = panelFg(opts.theme, STATE_COLOR[row.source.state], row.glyph);
    const gutterPlain = `${markerPlain}${indent}${row.glyph} `;
    const gutterPad = " ".repeat(Math.max(0, gutterWidth - visibleWidth(gutterPlain)));
    const suffix = suffixFits ? row.status + row.chip : "";
    const fittedIdentity = truncateToWidth(row.identity, Math.max(0, identityWidth - visibleWidth(suffix)), "…");
    const identityPlain = `${fittedIdentity}${suffix}`;
    let line = `${marker}${indent}${glyph} ${gutterPad}`;
    line += opts.theme ? tintAgentColor(row.source.color, fittedIdentity) : fittedIdentity;
    line += panelFg(opts.theme, "muted", suffix);
    line += " ".repeat(Math.max(0, identityWidth - visibleWidth(identityPlain)));
    if (hasDescriptionCell) {
      const description = truncateToWidth(row.description, descriptionWidth, "…");
      line += DESCRIPTION_GAP + panelFg(opts.theme, "text", rightPad(description, descriptionWidth));
    } else if (active.size > 0) {
      line += " ".repeat(Math.max(0, availableLeft - gutterWidth - identityWidth));
    }
    for (const key of METRIC_ORDER) {
      if (!active.has(key)) continue;
      const value = row.metrics[key] ?? "";
      line += panelFg(opts.theme, "muted", COLUMN_GAP + leftPad(value, metricWidths.get(key)!));
    }
    return line;
  });

  const lines: string[] = [];
  if (view.hiddenAbove > 0) lines.push(panelFg(opts.theme, "muted", panelMoreAbove(view.hiddenAbove)));
  lines.push(...renderedRows);
  if (view.hiddenBelow > 0) lines.push(panelFg(opts.theme, "muted", panelMoreBelow(view.hiddenBelow)));
  if (view.waitingCount > 0) {
    lines.push(panelFg(opts.theme, "muted", `${view.runningCount} running · ${view.waitingCount} waiting`));
  }
  const hint = view.focused ? PANEL_HINT_FOCUSED : panelHintUnfocused(opts.entryChord);
  lines.push(panelFg(opts.theme, "muted", hint));
  return clampLines(lines, opts.width);
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
export const DETAIL_BANNER_SETTLED = "agent completed while viewing — final answer shown";
export const DETAIL_BANNER_FAILED = "agent failed while viewing — partial output shown";
export const DETAIL_BANNER_STOPPED = "agent stopped while viewing — discarded output shown";
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
export const DETAIL_WAITING = "Waiting for configured concurrency capacity; no agent session has started yet.";
export const DETAIL_NO_ACTIVITY = "(no detail events captured yet)";
export const DETAIL_NO_FINAL_ANSWER = "(no final answer captured)";
export const DETAIL_NO_PARTIAL_OUTPUT = "(no partial output captured before failure)";
export const DETAIL_NO_DISCARDED_OUTPUT = "(no discarded output captured)";
export const DETAIL_FINAL_LABEL = "final answer:";
export const DETAIL_PARTIAL_LABEL = "partial output before failure:";
export const DETAIL_DISCARDED_LABEL = "discarded output from stopped run:";
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

// sanitizeProgressText preserves CR, so splitting CR prevents hostile same-line overprinting.
const LINE_BREAK_RE = /\r\n?|\n/;
const DETAIL_MULTILINE_RAW_INSPECTION_LIMIT = SUBAGENT_FINAL_TEXT_CAP + 1;

function boundedMultiline(value: string, cap: number): string {
  let raw = value.slice(0, DETAIL_MULTILINE_RAW_INSPECTION_LIMIT);
  if (value.length > raw.length && /[\uD800-\uDBFF]$/u.test(raw)) raw = raw.slice(0, -1);
  const clean = scalarSafeText(sanitizeProgressText(raw));
  // Registry-capped values include cap code units plus their existing ellipsis.
  if (clean.length <= cap || (clean.length === cap + 1 && clean.endsWith("…"))) return clean;
  let prefix = clean.slice(0, cap);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

/** Validate untrusted runtime-shaped detail data without walking more than its fixed budget. */
function renderableDetailLog(value: unknown): SubagentDetailEntry[] {
  let isArray = false;
  try {
    isArray = Array.isArray(value);
  } catch {
    return [];
  }
  if (!isArray) return [];

  const entries: SubagentDetailEntry[] = [];
  let count = 0;
  try {
    const length = (value as unknown[]).length;
    if (typeof length !== "number" || !Number.isFinite(length) || length <= 0) return entries;
    count = Math.min(Math.floor(length), DETAIL_LOG_MAX_ENTRIES);
  } catch {
    return entries;
  }
  for (let i = 0; i < count; i++) {
    try {
      const raw = (value as unknown[])[i];
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const kind = entry.kind;
      if (kind === "assistant") {
        const textValue = entry.text;
        const fingerprint = entry.fingerprint;
        if (
          typeof textValue !== "string" ||
          typeof fingerprint !== "string" ||
          fingerprint.length !== 64 ||
          !/^[0-9a-f]{64}$/u.test(fingerprint)
        ) continue;
        const text = sanitizeDetailScalar(textValue);
        if (text) entries.push({ kind, text, fingerprint });
        continue;
      }
      if (kind === "status") {
        const textValue = entry.text;
        if (typeof textValue !== "string") continue;
        const text = sanitizeDetailScalar(textValue);
        if (text) entries.push({ kind, text });
        continue;
      }
      if (kind === "tool-call") {
        const toolValue = entry.tool;
        const detailValue = entry.detail;
        if (typeof toolValue !== "string") continue;
        const tool = sanitizeDetailScalar(toolValue) || "tool";
        const detail = typeof detailValue === "string"
          ? sanitizeDetailScalar(detailValue)
          : undefined;
        entries.push(detail ? { kind, tool, detail } : { kind, tool });
        continue;
      }
      if (kind === "tool-outcome") {
        const toolValue = entry.tool;
        const detailValue = entry.detail;
        const failed = entry.failed;
        if (typeof toolValue !== "string" || typeof failed !== "boolean") continue;
        const tool = sanitizeDetailScalar(toolValue) || "tool";
        const detail = typeof detailValue === "string"
          ? sanitizeDetailScalar(detailValue)
          : undefined;
        entries.push(detail ? { kind, tool, detail, failed } : { kind, tool, failed });
      }
    } catch {
      // A hostile getter/proxy is one malformed entry, not a render-loop failure.
    }
  }
  return entries;
}

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
  taskStatus?: "running" | "completed" | "failed" | "stopped";
  taskAdmission?: "waiting" | "admitted";
  taskSettledAt?: number;
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

function detailWidth(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
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
 * Steer availability for display. The authoritative predicate is
 * guardSteer() (the send path uses ONLY its bound steer fn); this maps the same
 * ordering onto short display reasons, and the foreground case names the real
 * alternative rather than a dead end.
 */
type DetailSteerSlot = { kind: "input" } | { kind: "notice"; text: string } | { kind: "none" };

function detailSteerSlot(
  record: SubagentRegistryRecord,
  operational: boolean,
  waiting: boolean,
): DetailSteerSlot {
  if (!operational) return { kind: "none" };
  if (waiting) return { kind: "notice", text: detailSteerUnavailable("waiting for capacity") };
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
 * hint. Layout by state — running leads with structured live detail (auto-following),
 * finished leads with outcome-aware output. Pure and never-throwing over its
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
  const width = detailWidth(opts.width);
  const theme = opts.theme;
  const muted = (text: string): string => themedFg(theme, "muted", text);
  const record = data.record;
  const lines: string[] = [];
  if (!record) {
    // Same sanitize discipline as the record branch's banner — the vanished
    // branch must not become the one path that trusts ui.banner raw.
    lines.push(
      themedFg(theme, "warning", sanitizeLine(ui.banner ?? DETAIL_BANNER_VANISHED, DETAIL_FIELD_MAX_LENGTH)),
    );
    lines.push(muted("esc back"));
    return { lines: clampLines(lines, width), maxScroll: 0 };
  }

  const taskStopped = data.taskStatus === "stopped";
  const operational = record.state === "running" && !taskStopped;
  const waiting = operational && (data.taskAdmission ?? record.admission) === "waiting";
  const rowState: PanelRowView["state"] = taskStopped
    ? "stopped"
    : waiting
      ? "waiting"
      : operational
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
  const elapsedEnd = operational
    ? data.nowMs
    : (taskStopped && data.taskSettledAt !== undefined
      ? data.taskSettledAt
      : (record.settledAt ?? record.startedAt));
  // Defense-in-depth consistency: agentId and the outcome word are typed
  // unions/ids today, but the meta line sanitizes every interpolated field
  // like the rest of the view instead of trusting record shape.
  const statusWord = taskStopped
    ? record.userStopped ? "stopped by user" : "stopped"
    : waiting
      ? "waiting"
      : operational
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
  if (ui.banner) {
    lines.push(themedFg(theme, "warning", sanitizeLine(ui.banner, DETAIL_FIELD_MAX_LENGTH)));
  }

  // Scrollable body, assembled per state. Detail records are runtime-validated
  // here rather than trusted from TypeScript because extension data can cross
  // persistence/plugin boundaries with malformed shapes.
  const body: string[] = [];
  const pushMultiline = (text: string, color?: string): void => {
    for (const raw of text.split(LINE_BREAK_RE)) {
      pushWrapped(color ? themedFg(theme, color, raw) : raw, width, body);
    }
  };
  const pushSemantic = (label: string, text: string, color: string): void => {
    const logical = text.split(LINE_BREAK_RE);
    const first = logical.shift() ?? "";
    pushWrapped(themedFg(theme, color, first ? `${label} ${first}` : label), width, body);
    for (const raw of logical) pushWrapped(themedFg(theme, color, `  ${raw}`), width, body);
  };
  const promptText = typeof record.prompt === "string"
    ? boundedMultiline(record.prompt, SUBAGENT_PROMPT_CAP)
    : "";
  const promptLines = promptText ? promptText.split(LINE_BREAK_RE) : [];
  const pushPrompt = (): void => {
    if (promptLines.length === 0) return;
    if (ui.promptExpanded) {
      body.push(muted(DETAIL_PROMPT_EXPANDED));
      for (const raw of promptLines) pushWrapped(raw, width, body);
    } else {
      body.push(muted(detailPromptCollapsed(promptLines.length)));
    }
  };
  const finalText = typeof record.finalText === "string"
    ? boundedMultiline(record.finalText, SUBAGENT_FINAL_TEXT_CAP)
    : undefined;
  let rawDetailLog: unknown;
  try {
    rawDetailLog = record.detailLog;
  } catch {
    rawDetailLog = undefined;
  }
  const detailEntries = renderableDetailLog(rawDetailLog);
  const pushDetailEntries = (): void => {
    if (detailEntries.length === 0) {
      body.push(muted(DETAIL_NO_ACTIVITY));
      return;
    }
    for (const entry of detailEntries) {
      switch (entry.kind) {
        case "assistant":
          pushSemantic("assistant:", entry.text, "text");
          break;
        case "tool-call":
          pushSemantic("→ tool call:", entry.tool, "accent");
          if (entry.detail) pushSemantic("  input:", entry.detail, "muted");
          break;
        case "tool-outcome":
          pushSemantic(
            entry.failed ? "✗ tool failure:" : "✓ tool result:",
            entry.tool,
            entry.failed ? "error" : "success",
          );
          if (entry.detail) pushSemantic("  output:", entry.detail, entry.failed ? "error" : "muted");
          break;
        case "status":
          pushSemantic("status:", entry.text, "muted");
          break;
      }
    }
  };
  if (waiting) {
    body.push(muted(DETAIL_WAITING));
    pushPrompt();
  } else if (operational) {
    // The collapsed one-liner stays pinned above the following viewport.
    if (promptLines.length > 0 && !ui.promptExpanded) {
      lines.push(muted(detailPromptCollapsed(promptLines.length)));
    }
    if (ui.promptExpanded) pushPrompt();
    pushDetailEntries();
  } else {
    const stopped = taskStopped || record.userStopped || record.outcome === "aborted";
    const failed = record.outcome === "failed";
    const outputLabel = stopped
      ? DETAIL_DISCARDED_LABEL
      : failed
        ? DETAIL_PARTIAL_LABEL
        : DETAIL_FINAL_LABEL;
    const absentLabel = stopped
      ? DETAIL_NO_DISCARDED_OUTPUT
      : failed
        ? DETAIL_NO_PARTIAL_OUTPUT
        : DETAIL_NO_FINAL_ANSWER;
    body.push(muted(outputLabel));
    if (finalText) pushMultiline(finalText);
    else body.push(muted(absentLabel));
    pushPrompt();
    pushDetailEntries();
  }

  const maxScroll = Math.max(0, body.length - DETAIL_BODY_ROWS);
  const top = ui.follow ? maxScroll : Math.min(Math.max(0, ui.scrollTop), maxScroll);
  const end = Math.min(body.length, top + DETAIL_BODY_ROWS);
  if (top > 0) lines.push(muted(panelMoreAbove(top)));
  for (let i = top; i < end; i++) lines.push(body[i]!);
  if (end < body.length) lines.push(muted(panelMoreBelow(body.length - end)));

  if (ui.notice) {
    lines.push(themedFg(theme, "warning", sanitizeLine(ui.notice, DETAIL_FIELD_MAX_LENGTH)));
  }
  const slot = detailSteerSlot(record, operational, waiting);
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
        stoppable: operational && data.taskId !== undefined,
      }),
    ),
  );
  return { lines: clampLines(lines, width), maxScroll };
}

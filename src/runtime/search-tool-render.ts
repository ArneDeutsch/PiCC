import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_GREP_HEAD_LIMIT,
  GLOB_RESULT_CAP,
  normalizeFiniteNonnegative,
  resolveGrepContext,
  resolveGrepHeadLimit,
  resolveGrepMode,
  type GlobResultDetails,
  type GrepResultDetails,
} from "./tools/search-tools.js";
import { genericResultComponent, suppressToolRow, type RenderCtx } from "./tool-shell.js";
import { toolResultHasGuardClipping } from "./guard.js";
import { piToolsExpandKeyText } from "./pi-tui-runtime.js";
import {
  formatDisplayPathFromRoots,
  formatToolDisplayName,
  priorityDisplayRow,
  semanticDisplayRow,
  resolveDisplayRoots,
  sanitizeInlineDisplay,
  type DisplayRootResolver,
  type DisplayRoots,
} from "./tool-display.js";
import { sanitizeDisplayText, themedFg } from "./render-util.js";
const LINE_BREAK_RE = /\r\n?|\n|\u2028|\u2029/;
const DISPLAY_TEXT_LIMIT = 1_048_576;
const CLIP_INSPECTION_WINDOW = 32_768;
// Below this floor, wrapping retained bodies is unusable and can amplify one large line into millions of rows.
const DETAIL_USABLE_WIDTH = 8;
const RESIZE_GUIDANCE = "resize";
const resizeGuidance = (width: number): string[] => width >= RESIZE_GUIDANCE.length ? [RESIZE_GUIDANCE] : [];

interface Component {
  render(width: number): string[];
}

interface ResultShape {
  content?: unknown;
  details?: unknown;
}

interface SummaryState {
  status?: string;
  compactStatus?: string;
  count?: string;
  compactCount?: string;
  recovery?: string;
  expansionCue?: string;
}

interface RenderContext extends RenderCtx {
  args?: unknown;
}

type SearchName = "Grep" | "Glob";
type StockSearchName = "grep" | "find" | "ls";
type Snapshot = Record<string, unknown>;

function safeOwn(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeOwnKeys(value: unknown): string[] | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    return Object.keys(value);
  } catch {
    return undefined;
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function snapshotArgs(value: unknown): Snapshot {
  if (!plainRecord(value)) return {};
  const snapshot: Snapshot = {};
  for (const key of [
    "pattern", "path", "glob", "type", "output_mode", "-i", "-n", "-o", "-A", "-B",
    "-C", "context", "multiline", "head_limit", "offset", "limit",
  ]) {
    const own = safeOwn(value, key);
    if (own !== undefined) snapshot[key] = own;
  }
  return snapshot;
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!plainRecord(value)) return false;
  const actual = safeOwnKeys(value);
  if (!actual) return false;
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.sort().every((key, index) => key === sorted[index]);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}


function validOptional(args: Snapshot, key: string, type: "string" | "boolean" | "number"): boolean {
  const value = args[key];
  return value === undefined || (typeof value === type && (type !== "number" || Number.isFinite(value)));
}

function validArgs(toolName: SearchName, args: Snapshot): boolean {
  if (typeof args.pattern !== "string" || !validOptional(args, "path", "string")) return false;
  if (toolName === "Glob") return true;
  if (!validOptional(args, "glob", "string") || !validOptional(args, "type", "string")) return false;
  for (const key of ["-i", "-n", "-o", "multiline"]) if (!validOptional(args, key, "boolean")) return false;
  for (const key of ["-A", "-B", "-C", "context", "head_limit", "offset"]) {
    if (!validOptional(args, key, "number")) return false;
  }
  return resolveGrepMode(args) !== undefined;
}

function validateGrepDetails(value: unknown, args: Snapshot): GrepResultDetails | undefined {
  if (!plainRecord(value)) return undefined;
  const mode = safeOwn(value, "mode");
  const engine = safeOwn(value, "engine");
  const totalEntries = safeOwn(value, "totalEntries");
  const returnedEntries = safeOwn(value, "returnedEntries");
  const truncated = safeOwn(value, "truncated");
  if (mode !== "content" && mode !== "files_with_matches" && mode !== "count") return undefined;
  if (engine !== "rg" && engine !== "js") return undefined;
  if (!count(totalEntries) || !count(returnedEntries) || typeof truncated !== "boolean") return undefined;
  if (resolveGrepMode(args) !== mode) return undefined;
  const offset = normalizeFiniteNonnegative(args.offset);
  const limit = resolveGrepHeadLimit(args.head_limit);
  if (offset === undefined || limit === undefined) return undefined;
  const expected = Math.min(Math.max(0, totalEntries - offset), limit);
  if (returnedEntries !== expected) return undefined;
  return { mode, engine, totalEntries, returnedEntries, truncated };
}

function validateGlobDetails(value: unknown): GlobResultDetails | undefined {
  if (!plainRecord(value)) return undefined;
  const totalMatches = safeOwn(value, "totalMatches");
  const returned = safeOwn(value, "returned");
  const capped = safeOwn(value, "capped");
  const truncated = safeOwn(value, "truncated");
  if (!count(totalMatches) || !count(returned)) return undefined;
  if (typeof capped !== "boolean" || typeof truncated !== "boolean") return undefined;
  if (returned !== Math.min(totalMatches, GLOB_RESULT_CAP) || capped !== (totalMatches > GLOB_RESULT_CAP)) return undefined;
  return { totalMatches, returned, capped, truncated };
}

function sanitize(text: unknown, inline: boolean, limit = DISPLAY_TEXT_LIMIT): string {
  if (typeof text !== "string") return "";
  try {
    return sanitizeDisplayText(text, limit, inline);
  } catch {
    return "";
  }
}

function safeGet(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function safeFg(theme: unknown, color: string, text: string): string {
  return themedFg(theme, color, text);
}

function measuredWidth(line: string): number {
  try {
    return visibleWidth(typeof line === "string" ? line : "");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function clamp(line: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  try {
    return measuredWidth(line) > width ? truncateToWidth(line, width, "…") : line;
  } catch {
    return "";
  }
}

function guarded(component: Component, fallback = "Search result unavailable"): Component {
  return {
    render(width: number): string[] {
      try {
        const lines = component.render(width);
        if (!Array.isArray(lines)) return [clamp(fallback, width)];
        return lines.map((line) => clamp(typeof line === "string" ? line : fallback, width));
      } catch {
        return [clamp(fallback, width)];
      }
    },
  };
}

function quote(value: string): string {
  return `“${value || "?"}”`;
}

function tinySearchIdentity(toolName: SearchName, theme: unknown, width: number): string {
  const identity = safeFg(theme, "text", formatToolDisplayName(toolName));
  try {
    return truncateToWidth(identity, width, "");
  } catch {
    return toolName.slice(0, 1);
  }
}

function invocationParts(toolName: SearchName, args: Snapshot): {
  expression: string;
  path: string;
  filters: string[];
  modifiers: string[];
} {
  const expression = sanitize(args.pattern, true) || "?";
  // The decorator has already classified and path-sanitized this detached snapshot.
  const path = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
  if (toolName === "Glob") return { expression, path, filters: [], modifiers: [] };
  const filters: string[] = [];
  const glob = sanitize(args.glob, true);
  const type = sanitize(args.type, true);
  if (typeof args.glob === "string" && glob) filters.push(`glob ${quote(glob)}`);
  if (typeof args.type === "string" && type) filters.push(`type ${type}`);

  const modifiers: string[] = [];
  const mode = resolveGrepMode(args);
  if (mode === "content" || mode === "count") modifiers.push(`mode ${mode}`);
  if (args["-i"] === true) modifiers.push("-i");
  if (args.multiline === true) modifiers.push("multiline");
  if (mode === "content") {
    if (args["-n"] === false) modifiers.push("no line numbers");
    if (args["-o"] === true) {
      modifiers.push("-o");
    } else {
      const context = mode ? resolveGrepContext(args, mode) : undefined;
      if (context) {
        if (context.before === context.after && context.before > 0) modifiers.push(`-C ${String(context.before)}`);
        else {
          if (context.before > 0) modifiers.push(`-B ${String(context.before)}`);
          if (context.after > 0) modifiers.push(`-A ${String(context.after)}`);
        }
      }
    }
  }
  const limit = resolveGrepHeadLimit(args.head_limit);
  if (limit === Number.POSITIVE_INFINITY) modifiers.push("limit unlimited");
  else if (limit !== undefined && limit !== DEFAULT_GREP_HEAD_LIMIT) modifiers.push(`limit ${String(limit)}`);
  const offset = normalizeFiniteNonnegative(args.offset);
  if (offset !== undefined && offset > 0) modifiers.push(`offset ${String(offset)}`);
  return { expression, path, filters, modifiers };
}

function graphemes(value: string): string[] {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((part) => part.segment);
  } catch {
    return Array.from(value);
  }
}

function shortenPath(path: string, room: number): string | undefined {
  const prefix = "in ";
  if (room < measuredWidth(`${prefix}…`)) return undefined;
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(/[\\/]/u).filter(Boolean);
  const basename = parts.at(-1) ?? path;
  const preferred = parts.length > 1 ? `…${separator}${basename}` : basename;
  if (measuredWidth(prefix + preferred) <= room) return prefix + preferred;
  const chars = graphemes(basename);
  while (chars.length > 0 && measuredWidth(`${prefix}…${separator}${chars.join("")}`) > room) chars.shift();
  if (chars.length > 0) return `${prefix}…${separator}${chars.join("")}`;
  return `${prefix}…`;
}

function addSegment(line: string, text: string, theme: unknown, width: number): string | undefined {
  const segment = safeFg(theme, "muted", ` · ${text}`);
  return measuredWidth(line + segment) <= width ? line + segment : undefined;
}

interface SummaryCore {
  line: string;
  hasStatus: boolean;
}

function fitExpression(expression: string, room: number): string | undefined {
  if (room <= 0) return undefined;
  const fullQuoted = quote(expression);
  if (measuredWidth(fullQuoted) <= room) return fullQuoted;
  if (measuredWidth(expression) <= room) return expression;
  const clusters = graphemes(expression);
  if (clusters.length < 2) return undefined;
  let low = 1;
  let high = clusters.length - 1;
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${clusters.slice(0, middle).join("")}…`;
    if (measuredWidth(candidate) <= room) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!best) return undefined;
  return measuredWidth(quote(best)) <= room ? quote(best) : best;
}

function styledCore(
  toolName: SearchName,
  expression: string | undefined,
  status: string,
  recovery: string,
  theme: unknown,
): SummaryCore {
  const title = safeFg(theme, "text", formatToolDisplayName(toolName));
  const failed = status === "failed" || status === "fail";
  const statusText = status
    ? safeFg(theme, "muted", " · ") + safeFg(theme, failed ? "error" : "muted", status) +
      (recovery ? safeFg(theme, "muted", recovery) : "")
    : "";
  return {
    line: title + (expression ? ` ${safeFg(theme, "accent", expression)}` : "") + statusText,
    hasStatus: Boolean(status),
  };
}

function selectSummaryCore(
  toolName: SearchName,
  expression: string,
  state: SummaryState | undefined,
  theme: unknown,
  width: number,
  requireRecovery: boolean,
): SummaryCore | undefined {
  if (!Number.isFinite(width) || width <= 0) return undefined;
  const displayName = formatToolDisplayName(toolName);
  const titleWidth = measuredWidth(displayName);
  const statuses = state?.status
    ? [state.status, state.compactStatus].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index)
    : [""];
  const recovery = requireRecovery && state?.recovery ? `; ${state.recovery}` : "";
  if (requireRecovery && (!state?.status || !recovery)) return undefined;

  // Preserve the complete expression while first abbreviating status; only then shorten by grapheme.
  for (const status of statuses) {
    const suffix = status ? ` · ${status}${recovery}` : "";
    const complete = quote(expression);
    if (measuredWidth(`${displayName} ${complete}${suffix}`) <= width) {
      return styledCore(toolName, complete, status, recovery, theme);
    }
  }
  if (state?.status) {
    const status = statuses.at(-1) ?? state.status;
    const suffix = ` · ${status}${recovery}`;
    const fitted = fitExpression(expression, width - titleWidth - measuredWidth(` ${suffix}`));
    if (fitted) return styledCore(toolName, fitted, status, recovery, theme);
    if (requireRecovery) return undefined;
  }
  const fitted = fitExpression(expression, width - titleWidth - 1);
  return fitted
    ? styledCore(toolName, fitted, "", "", theme)
    : styledCore(toolName, undefined, "", "", theme);
}

interface SummaryLine {
  line: string;
  cueAppended: boolean;
}

function summaryLine(
  toolName: SearchName,
  args: Snapshot,
  state: SummaryState | undefined,
  theme: unknown,
  width: number,
): SummaryLine {
  if (!Number.isFinite(width) || width <= 0) return { line: "", cueAppended: false };
  const parts = invocationParts(toolName, args);
  const inline = selectSummaryCore(toolName, parts.expression, state, theme, width, true);
  const core = inline ?? selectSummaryCore(toolName, parts.expression, state, theme, width, false);
  let line = core?.line ?? safeFg(theme, "text", formatToolDisplayName(toolName));
  if (state?.status && !core?.hasStatus) return { line: clamp(line, width), cueAppended: false };
  if (state?.count) {
    for (const countText of [state.count, state.compactCount].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index)) {
      const next = addSegment(line, countText, theme, width);
      if (next) {
        line = next;
        break;
      }
    }
  }
  const fullPath = `in ${parts.path}`;
  const pathLine = addSegment(line, fullPath, theme, width);
  if (pathLine) line = pathLine;
  else {
    const available = width - measuredWidth(line) - measuredWidth(" · ");
    const shortened = shortenPath(parts.path, available);
    if (shortened) line = addSegment(line, shortened, theme, width) ?? line;
  }
  for (const part of [...parts.filters, ...parts.modifiers]) line = addSegment(line, part, theme, width) ?? line;
  let cueAppended = false;
  if (state?.expansionCue) {
    const binding = state.expansionCue.endsWith(" to expand")
      ? state.expansionCue.slice(0, -" to expand".length)
      : state.expansionCue;
    for (const cue of [state.expansionCue, binding]) {
      const next = cue ? addSegment(line, cue, theme, width) : undefined;
      if (next) {
        line = next;
        cueAppended = true;
        break;
      }
    }
  }
  return { line: clamp(line, width), cueAppended };
}

const CLIP_HINTS: Record<SearchName, string> = {
  Grep: "re-run the search with a tighter pattern or a smaller head_limit/offset to recover the omitted matches",
  Glob: "re-run a narrower command — target a specific path, request fewer entries, or pipe through a filter — to recover the omitted output",
};

// The exact in-band marker is advisory. Inspect only bounded retained edges during collapsed repaint.
function exactClipMarker(toolName: SearchName, text: string): boolean {
  const escaped = CLIP_HINTS[toolName].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(
    `(?:^|\\n\\n)\\[PiCC clipped (?:0|[1-9]\\d*) characters from the middle of this ${toolName} output — ${escaped}\\](?=\\n\\n|$)`,
    "u",
  );
  const prefix = text.slice(0, CLIP_INSPECTION_WINDOW);
  if (marker.test(prefix)) return true;
  if (text.length <= CLIP_INSPECTION_WINDOW) return false;
  return marker.test(text.slice(-CLIP_INSPECTION_WINDOW));
}

function deriveState(
  toolName: SearchName,
  details: GrepResultDetails | GlobResultDetails,
  args: Snapshot,
  result: unknown,
  primaryText: string,
): SummaryState {
  const statuses: string[] = [];
  const compact: string[] = [];
  let countText: string;
  let compactCount: string;
  let incomplete = false;
  if (toolName === "Grep") {
    const grep = details as GrepResultDetails;
    const offset = normalizeFiniteNonnegative(args.offset) ?? 0;
    const available = Math.max(0, grep.totalEntries - offset);
    if (grep.totalEntries === 0) {
      statuses.push("no matches"); compact.push("none");
    } else if (grep.returnedEntries === 0 && offset >= grep.totalEntries) {
      statuses.push(`empty page at offset ${String(offset)}`); compact.push(`empty@${String(offset)}`);
    } else if (offset > 0) {
      statuses.push(`offset ${String(offset)}`); compact.push(`off@${String(offset)}`);
    }
    if (offset > 0) incomplete = true;
    if (grep.returnedEntries < available) {
      statuses.push("limited"); compact.push("lim"); incomplete = true;
    }
    if (grep.truncated) {
      statuses.push("truncated"); compact.push("trunc"); incomplete = true;
    }
    countText = `${String(grep.returnedEntries)}/${String(grep.totalEntries)} entries`;
    compactCount = `${String(grep.returnedEntries)}/${String(grep.totalEntries)}`;
  } else {
    const glob = details as GlobResultDetails;
    if (glob.totalMatches === 0) {
      statuses.push("no files"); compact.push("none");
    }
    if (glob.capped) {
      statuses.push("capped"); compact.push("cap"); incomplete = true;
    }
    if (glob.truncated) {
      statuses.push("truncated"); compact.push("trunc"); incomplete = true;
    }
    countText = `${String(glob.returned)}/${String(glob.totalMatches)} files`;
    compactCount = `${String(glob.returned)}/${String(glob.totalMatches)}`;
  }
  if (toolResultHasGuardClipping(result) || exactClipMarker(toolName, primaryText)) {
    statuses.push("clipped"); compact.push("clip"); incomplete = true;
  }
  return {
    status: statuses.join(" + ") || undefined,
    compactStatus: compact.join("+") || undefined,
    count: countText,
    compactCount,
    recovery: incomplete
      ? toolName === "Grep"
        ? "narrow pattern/path or page/reduce output with head_limit/offset"
        : "narrow pattern/path (the result cap is fixed)"
      : undefined,
  };
}

function textBlockSnapshot(value: unknown): string | undefined {
  if (!exactKeys(value, ["type", "text"])) return undefined;
  return safeOwn(value, "type") === "text" && typeof safeOwn(value, "text") === "string"
    ? safeOwn(value, "text") as string
    : undefined;
}

function safeContentSnapshot(result: unknown): ResultShape {
  const content = safeOwn(result, "content");
  if (!Array.isArray(content)) return { content: [{ type: "text", text: "Unrenderable search result" }] };
  const blocks: Array<Record<string, unknown>> = [];
  for (const block of content) {
    const type = safeOwn(block, "type");
    if (type === "text") {
      const text = safeOwn(block, "text");
      blocks.push({
        type: "text",
        text: typeof text === "string" ? text : "Unrenderable search result text",
      });
    } else if (type === "image") {
      blocks.push({ type: "image", data: safeOwn(block, "data"), mimeType: safeOwn(block, "mimeType") });
    } else {
      blocks.push({ type: "text", text: "Unrenderable search result block" });
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "Empty search result" });
  return { content: blocks };
}

function failOpenComponent(
  toolName: SearchName,
  result: unknown,
  theme: unknown,
  context: RenderContext | undefined,
  tinyIdentity = true,
): Component {
  let delegate: Component | undefined;
  let lastWidth: number | undefined;
  let lastLines: string[] | undefined;
  return guarded({
    render(width: number): string[] {
      if (width < DETAIL_USABLE_WIDTH) {
        if (width <= 0) return [];
        const lines = tinyIdentity ? [tinySearchIdentity(toolName, theme, width)] : [];
        lines.push(...resizeGuidance(width));
        return lines;
      }
      if (lastWidth === width && lastLines) return lastLines;
      if (!delegate) {
        let snapshot: ResultShape;
        try {
          snapshot = safeContentSnapshot(result);
        } catch {
          snapshot = { content: [{ type: "text", text: "Unrenderable search result" }] };
        }
        const safeTheme = { fg: (slot: string, text: string) => safeFg(theme, slot, text) };
        const safeContext = { showImages: safeGet(context, "showImages") === true };
        try {
          delegate = genericResultComponent(snapshot as never, safeTheme, safeContext);
        } catch {
          delegate = { render: (columns) => [clamp("Search result unavailable", columns)] };
        }
      }
      lastLines = delegate.render(width);
      lastWidth = width;
      return lastLines;
    },
  });
}

function feedbackComponent(texts: readonly string[], theme: unknown): Component {
  let snapshot: string[] | undefined;
  let lastWidth: number | undefined;
  let lastLines: string[] | undefined;
  return guarded({
    render(width: number): string[] {
      if (width < DETAIL_USABLE_WIDTH) return [];
      if (lastWidth === width && lastLines) return lastLines;
      snapshot ??= texts.map((text) => sanitize(text, false));
      const lines: string[] = [];
      for (const text of snapshot) {
        for (const sourceLine of text.split(LINE_BREAK_RE)) {
          lines.push(...wrapTextWithAnsi(safeFg(theme, "toolOutput", sourceLine), width));
        }
      }
      lastLines = lines;
      lastWidth = width;
      return lines;
    },
  }, "Feedback unavailable");
}

function recoveryComponent(toolName: SearchName, args: Snapshot, state: SummaryState, theme: unknown): Component {
  const recovery = sanitize(state.recovery, true);
  const expression = invocationParts(toolName, args).expression;
  const snapshot = recovery ? `Recovery: ${recovery}.` : "";
  return guarded({
    render(width: number): string[] {
      if (width < DETAIL_USABLE_WIDTH || !snapshot || selectSummaryCore(toolName, expression, state, theme, width, true)) return [];
      return wrapTextWithAnsi(safeFg(theme, "toolOutput", snapshot), width);
    },
  }, "Recovery unavailable");
}

function cueCandidates(cue: string): string[] {
  const binding = cue.endsWith(" to expand") ? cue.slice(0, -" to expand".length) : cue;
  return [cue, binding].filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);
}

function summaryComponent(
  toolName: SearchName,
  args: Snapshot,
  state: SummaryState,
  theme: unknown,
  failOpenDetail?: Component,
): Component {
  return guarded({
    render(width: number): string[] {
      if (width > 0 && width < DETAIL_USABLE_WIDTH) {
        return [tinySearchIdentity(toolName, theme, width), ...(state.expansionCue ? resizeGuidance(width) : [])];
      }
      const summary = summaryLine(toolName, args, state, theme, width);
      if (!state.expansionCue || summary.cueAppended) return [summary.line];
      const separate = cueCandidates(state.expansionCue).find((candidate) => measuredWidth(candidate) <= width);
      if (separate) return [summary.line, safeFg(theme, "muted", separate)];
      return failOpenDetail ? [summary.line, ...failOpenDetail.render(width)] : [summary.line];
    },
  }, toolName);
}

function detailComponent(text: string, theme: unknown): Component {
  let sourceLines: string[] | undefined;
  let lastWidth: number | undefined;
  let lastLines: string[] | undefined;
  return guarded({
    render(width: number): string[] {
      if (width < DETAIL_USABLE_WIDTH) return resizeGuidance(width);
      if (lastWidth === width && lastLines) return lastLines;
      sourceLines ??= sanitize(text, false).split("\n");
      const lines: string[] = [];
      for (const sourceLine of sourceLines) {
        lines.push(...wrapTextWithAnsi(safeFg(theme, "toolOutput", sourceLine), width));
      }
      lastLines = lines;
      lastWidth = width;
      return lines;
    },
  }, "Search detail unavailable");
}

function combinedComponent(components: readonly Component[]): Component {
  return guarded({
    render(width: number): string[] {
      const lines: string[] = [];
      for (const component of components) lines.push(...component.render(width));
      return lines;
    },
  });
}

export interface CompactSearchRenderingDependencies {
  resolveDisplayRoot?: DisplayRootResolver;
  repositoryRoot?: string;
}

interface StockArgs {
  pattern?: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

interface StockOutcome {
  empty?: string;
  warnings: string[];
  retained: boolean;
}

interface StockLifecycle {
  args?: StockArgs;
  call?: MutableStockCall;
  nativeResult?: Component;
  roots?: DisplayRoots;
  displayPath?: string;
}

interface MutableStockCall extends Component {
  update(args: StockArgs, displayPath: string, outcome: StockOutcome | undefined, cue: string | undefined, theme: unknown): void;
}

const STOCK_ARG_KEYS: Record<StockSearchName, readonly string[]> = {
  grep: ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
  find: ["pattern", "path", "limit"],
  ls: ["path", "limit"],
};
const STOCK_DEFAULT_LIMIT: Record<StockSearchName, number> = { grep: 100, find: 1000, ls: 500 };
const STOCK_EMPTY: Record<StockSearchName, string> = {
  grep: "No matches found",
  find: "No files found matching pattern",
  ls: "(empty directory)",
};

function stockArgs(toolName: StockSearchName, value: unknown): StockArgs | undefined {
  if (!plainRecord(value)) return undefined;
  let keys: PropertyKey[];
  try { keys = Reflect.ownKeys(value); } catch { return undefined; }
  if (keys.some((key) => typeof key !== "string" || !STOCK_ARG_KEYS[toolName].includes(key))) return undefined;
  const result: StockArgs = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    (result as Record<string, unknown>)[key] = descriptor.value;
  }
  const has = (key: keyof StockArgs): boolean => Object.prototype.hasOwnProperty.call(result, key);
  if ((toolName === "grep" || toolName === "find") && typeof result.pattern !== "string") return undefined;
  if (has("path") && typeof result.path !== "string") return undefined;
  if (has("limit") && (typeof result.limit !== "number" || !Number.isFinite(result.limit))) return undefined;
  if (toolName === "grep") {
    if (has("glob") && typeof result.glob !== "string") return undefined;
    if (has("ignoreCase") && typeof result.ignoreCase !== "boolean") return undefined;
    if (has("literal") && typeof result.literal !== "boolean") return undefined;
    if (has("context") && (typeof result.context !== "number" || !Number.isFinite(result.context))) return undefined;
  }
  return result;
}

function sameStockArgs(left: StockArgs, right: StockArgs): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) &&
      Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function contextStockArgs(
  toolName: StockSearchName,
  context: RenderContext,
  captured: StockArgs | undefined,
): StockArgs | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(context, "args"); } catch { return undefined; }
  if (!descriptor) {
    try { return Reflect.has(context, "args") ? undefined : captured; } catch { return undefined; }
  }
  if (!("value" in descriptor)) return undefined;
  const current = stockArgs(toolName, descriptor.value);
  if (!current || !captured || !sameStockArgs(current, captured)) return undefined;
  return current;
}

function exactStockRecord(value: unknown, expected: readonly string[]): Record<string, unknown> | undefined {
  if (!plainRecord(value)) return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) return undefined;
    const snapshot: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch { return undefined; }
}

function exactStockTextBlock(value: unknown): string | undefined {
  const block = exactStockRecord(value, ["type", "text"]);
  if (!block || safeOwn(block, "type") !== "text") return undefined;
  const text = safeOwn(block, "text");
  return typeof text === "string" ? text : undefined;
}

function exactStockContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== 2 ||
      safeOwn(value, "length") !== 1) return undefined;
  } catch { return undefined; }
  return exactStockTextBlock(safeOwn(value, "0"));
}

function exactStockTruncation(value: unknown): boolean {
  const truncation = exactStockRecord(value, [
    "content", "truncated", "truncatedBy", "totalLines", "totalBytes", "outputLines", "outputBytes",
    "lastLinePartial", "firstLineExceedsLimit", "maxLines", "maxBytes",
  ]);
  if (!truncation || typeof safeOwn(truncation, "content") !== "string" || safeOwn(truncation, "truncated") !== true ||
    (safeOwn(truncation, "truncatedBy") !== "lines" && safeOwn(truncation, "truncatedBy") !== "bytes") ||
    typeof safeOwn(truncation, "lastLinePartial") !== "boolean" ||
    typeof safeOwn(truncation, "firstLineExceedsLimit") !== "boolean") return false;
  const numeric = ["totalLines", "totalBytes", "outputLines", "outputBytes", "maxLines", "maxBytes"] as const;
  const values = Object.fromEntries(numeric.map((key) => [key, safeOwn(truncation, key)])) as Record<typeof numeric[number], unknown>;
  if (numeric.some((key) => !Number.isSafeInteger(values[key]) || (values[key] as number) < 0) ||
    (values.maxLines as number) < 1 || (values.maxBytes as number) < 1 ||
    (values.outputLines as number) > (values.totalLines as number) ||
    (values.outputBytes as number) > (values.totalBytes as number) ||
    (values.outputLines as number) > (values.maxLines as number) ||
    (values.outputBytes as number) > (values.maxBytes as number) || safeOwn(truncation, "lastLinePartial") !== false) return false;
  if (safeOwn(truncation, "truncatedBy") === "lines") {
    return (values.totalLines as number) > (values.maxLines as number) &&
      values.outputLines === values.maxLines && (values.totalBytes as number) > (values.outputBytes as number) &&
      safeOwn(truncation, "firstLineExceedsLimit") === false;
  }
  if ((values.totalBytes as number) <= (values.maxBytes as number)) return false;
  return safeOwn(truncation, "firstLineExceedsLimit") === true
    ? values.outputLines === 0 && values.outputBytes === 0
    : (values.outputLines as number) > 0 && (values.outputBytes as number) > 0;
}

function stockEffectiveLimit(toolName: StockSearchName, args: StockArgs): number {
  const requested = args.limit ?? STOCK_DEFAULT_LIMIT[toolName];
  return toolName === "grep" ? Math.max(1, requested) : requested;
}

function stockOutcome(toolName: StockSearchName, args: StockArgs, result: unknown): StockOutcome | undefined {
  const envelope = exactStockRecord(result, ["content", "details"]) ??
    exactStockRecord(result, ["content", "details", "isError"]);
  if (!envelope || ("isError" in envelope && envelope.isError !== false)) return undefined;
  const text = exactStockContent(safeOwn(envelope, "content"));
  if (text === undefined) return undefined;
  const detailsValue = safeOwn(envelope, "details");
  if (detailsValue === undefined) {
    const empty = text.length === STOCK_EMPTY[toolName].length && text === STOCK_EMPTY[toolName]
      ? STOCK_EMPTY[toolName]
      : undefined;
    if (text === "") return undefined;
    return { ...(empty ? { empty } : {}), warnings: [], retained: !empty };
  }
  const allowed = toolName === "grep"
    ? ["matchLimitReached", "linesTruncated", "truncation"]
    : toolName === "find"
      ? ["resultLimitReached", "truncation"]
      : ["entryLimitReached", "truncation"];
  if (!plainRecord(detailsValue)) return undefined;
  let detailKeys: PropertyKey[];
  try { detailKeys = Reflect.ownKeys(detailsValue); } catch { return undefined; }
  if (detailKeys.length === 0 || detailKeys.some((key) => typeof key !== "string" || !allowed.includes(key))) return undefined;
  const details: Record<string, unknown> = {};
  for (const key of detailKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(detailsValue, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    details[key] = descriptor.value;
  }
  const limitKey = toolName === "grep" ? "matchLimitReached" : toolName === "find" ? "resultLimitReached" : "entryLimitReached";
  const hasLimit = Object.prototype.hasOwnProperty.call(details, limitKey);
  const hasLinesTruncated = Object.prototype.hasOwnProperty.call(details, "linesTruncated");
  const hasTruncation = Object.prototype.hasOwnProperty.call(details, "truncation");
  const limitValue = details[limitKey];
  if (hasLimit && (typeof limitValue !== "number" || !Number.isFinite(limitValue) || limitValue <= 0 ||
    limitValue !== stockEffectiveLimit(toolName, args))) return undefined;
  if (hasLinesTruncated && (toolName !== "grep" || details.linesTruncated !== true)) return undefined;
  if (hasTruncation && !exactStockTruncation(details.truncation)) return undefined;
  const warnings: string[] = [];
  if (hasLimit) warnings.push(`${String(limitValue)} ${toolName === "grep" ? "matches" : toolName === "find" ? "results" : "entries"} limit`);
  if (hasLinesTruncated) warnings.push("long lines truncated");
  if (hasTruncation) warnings.push("output truncated");
  return { warnings, retained: true };
}

function stockSearchRow(
  toolName: StockSearchName,
  args: StockArgs,
  displayPath: string,
  outcome: StockOutcome | undefined,
  cue: string | undefined,
  theme: unknown,
): Component {
  const optional = [
    ...(toolName !== "ls" ? [`in ${displayPath}`] : []),
    ...(toolName === "grep" && typeof args.glob === "string" && sanitize(args.glob, true)
      ? [`glob ${quote(sanitize(args.glob, true))}`] : []),
    ...(typeof args.limit === "number" ? [`limit ${String(args.limit)}`] : []),
  ];
  return semanticDisplayRow({
    action: toolName,
    primary: toolName === "ls" ? displayPath : sanitize(args.pattern, true) || "?",
    required: [
      ...(outcome?.empty ? [{ text: outcome.empty, tone: "muted" as const }] : []),
      ...((outcome?.warnings ?? []).map((text) => ({ text, tone: "warning" as const }))),
    ],
    optional,
    ...(cue ? { cue, compactCue: cue.endsWith(" to expand") ? cue.slice(0, -" to expand".length) : cue } : {}),
  }, theme);
}

function mutableStockCall(
  toolName: StockSearchName,
  args: StockArgs,
  displayPath: string,
  theme: unknown,
): MutableStockCall {
  let row = stockSearchRow(toolName, args, displayPath, undefined, undefined, theme);
  return {
    update(nextArgs, nextPath, outcome, cue, nextTheme) {
      row = stockSearchRow(toolName, nextArgs, nextPath, outcome, cue, nextTheme);
    },
    render(width) { return row.render(width); },
  };
}

function stockNativeContext(context: RenderContext, lastComponent: Component | undefined, expanded: boolean): RenderContext {
  return { ...context, lastComponent, expanded } as RenderContext;
}

function stockFailOpen(result: unknown, theme: unknown, context: RenderContext): Component {
  return failOpenComponent("Grep", result, theme, context, false);
}

// HTML serializes custom calls before results, so compact grep/find rows are result-owned.
// Interactive stock rows retain their call component and native expanded-result identity.
export function withCompactSearchRendering<T extends ToolDefinition>(
  tool: T,
  dependencies: CompactSearchRenderingDependencies = {},
): T {
  const toolName = tool.name;
  if (toolName !== "Grep" && toolName !== "Glob" && toolName !== "grep" && toolName !== "find" && toolName !== "ls") {
    throw new TypeError("compact search rendering accepts only Grep, Glob, grep, find, or ls tools");
  }
  const roots = new WeakMap<object, DisplayRoots>();
  // HTML invokes only the initial partial call pass; interactive Pi invokes a final call pass before its result.
  const htmlCallStates = new WeakSet<object>();
  const rootsFor = (context: unknown): DisplayRoots => {
    const state = safeGet(context, "state");
    const resolved = () => resolveDisplayRoots(
      dependencies.resolveDisplayRoot,
      dependencies.repositoryRoot,
      context,
    );
    if ((typeof state !== "object" && typeof state !== "function") || state === null) return resolved();
    if (safeGet(context, "argsComplete") === false) return resolved();
    if (!roots.has(state as object)) roots.set(state as object, resolved());
    return roots.get(state as object) ?? {};
  };
  if (toolName === "grep" || toolName === "find" || toolName === "ls") {
    const originalResult = tool.renderResult;
    const lifecycles = new WeakMap<object, StockLifecycle>();
    const htmlStates = new WeakSet<object>();
    const lifecycleFor = (context: RenderContext): StockLifecycle | undefined => {
      const state = safeGet(context, "state");
      if ((typeof state !== "object" && typeof state !== "function") || state === null) return undefined;
      let lifecycle = lifecycles.get(state as object);
      if (!lifecycle) {
        lifecycle = {};
        lifecycles.set(state as object, lifecycle);
      }
      return lifecycle;
    };
    return {
      ...tool,
      renderCall(argsValue: unknown, theme: unknown, context: RenderContext): Component {
        const args = stockArgs(toolName, argsValue);
        if (!args) {
          try { return typeof tool.renderCall === "function" ? tool.renderCall(argsValue as never, theme as never, context as never) : { render: () => [toolName] }; }
          catch { return { render: () => [toolName] }; }
        }
        const lifecycle = lifecycleFor(context);
        const roots = rootsFor(context);
        const rawPath = args.path ?? ".";
        const displayPath = sanitizeInlineDisplay(formatDisplayPathFromRoots(rawPath, roots)) || ".";
        if (!lifecycle) return stockSearchRow(toolName, args, displayPath, undefined, undefined, theme);
        lifecycle.args = args;
        lifecycle.roots = roots;
        lifecycle.displayPath = displayPath;
        lifecycle.call ??= mutableStockCall(toolName, args, displayPath, theme);
        lifecycle.call.update(args, displayPath, undefined, undefined, theme);
        const state = safeGet(context, "state") as object;
        if (safeGet(context, "isPartial") === true) {
          htmlStates.add(state);
          if (toolName !== "ls") {
            suppressToolRow(context);
            return { render: () => [] };
          }
        } else {
          htmlStates.delete(state);
        }
        return lifecycle.call;
      },
      renderResult(result: unknown, options: { expanded?: boolean; isPartial?: boolean }, theme: unknown, context: RenderContext): Component {
        const lifecycle = lifecycleFor(context);
        const args = contextStockArgs(toolName, context, lifecycle?.args);
        const isPartial = safeGet(options, "isPartial") === true || safeGet(context, "isPartial") === true;
        const isError = safeGet(context, "isError") === true;
        const state = safeGet(context, "state");
        const html = toolName !== "ls" && (typeof state === "object" || typeof state === "function") && state !== null &&
          htmlStates.has(state as object);
        const expanded = safeGet(options, "expanded") === true || safeGet(context, "expanded") === true;
        const expansion = piToolsExpandKeyText();
        const binding = expansion.available ? sanitize(expansion.value, true, 512) : "";
        const outcome = !isPartial && !isError && args ? stockOutcome(toolName, args, result) : undefined;
        const recognized = outcome !== undefined;
        const retained = outcome?.retained === true;
        const reveal = expanded || !expansion.available || !binding;

        const delegate = (): Component => {
          if (typeof originalResult !== "function") return stockFailOpen(result, theme, context);
          try {
            const native = originalResult(
              result as never,
              { expanded: true, isPartial } as never,
              theme as never,
              stockNativeContext(context, lifecycle?.nativeResult, true) as never,
            ) as Component;
            if (lifecycle) lifecycle.nativeResult = native;
            return native;
          } catch {
            if (lifecycle) lifecycle.nativeResult = undefined;
            return stockFailOpen(result, theme, context);
          }
        };

        if (!recognized || isPartial || isError || !args || (!lifecycle && !html)) return delegate();
        const cue = retained && !reveal ? (html ? "click to show detail" : `${binding} to expand`) : undefined;
        const displayPath = lifecycle?.displayPath ??
          (sanitizeInlineDisplay(formatDisplayPathFromRoots(args.path ?? ".", rootsFor(context))) || ".");
        if (html) {
          const row = stockSearchRow(toolName, args, displayPath, outcome, cue, theme);
          return reveal && retained ? combinedComponent([row, delegate()]) : row;
        }
        lifecycle?.call?.update(args, displayPath, outcome, cue, theme);
        if (reveal && retained) return delegate();
        return { render: () => [] };
      },
    } as T;
  }
  return {
    ...tool,
    renderCall(_args: unknown, _theme: unknown, context: RenderContext): Component {
      rootsFor(context);
      suppressToolRow(context);
      const state = safeGet(context, "state");
      if ((typeof state === "object" || typeof state === "function") && state !== null) {
        if (safeGet(context, "isPartial") === true) htmlCallStates.add(state);
        else htmlCallStates.delete(state);
      }
      return { render: () => [] };
    },
    renderResult(result: ResultShape, options: { isPartial?: boolean }, theme: unknown, context: RenderContext): Component {
      try {
        const args = snapshotArgs(safeGet(context, "args"));
        if (typeof args.path === "string") {
          args.path = sanitizeInlineDisplay(formatDisplayPathFromRoots(args.path, rootsFor(context)));
        }
        if (safeGet(context, "isError") === true) {
          const failed: SummaryState = { status: "failed", compactStatus: "fail" };
          return combinedComponent([
            guarded({ render: (width) => [width > 0 && width < DETAIL_USABLE_WIDTH
              ? tinySearchIdentity(toolName, theme, width)
              : summaryLine(toolName, args, failed, theme, width).line] }, toolName),
            failOpenComponent(toolName, result, theme, context, false),
          ]);
        }
        if (safeGet(options, "isPartial") === true) return failOpenComponent(toolName, result, theme, context);
        const content = safeOwn(result, "content");
        const detailsValue = safeOwn(result, "details");
        const details = toolName === "Grep" ? validateGrepDetails(detailsValue, args) : validateGlobDetails(detailsValue);
        if (!validArgs(toolName, args) || !Array.isArray(content) || content.length === 0 || !details) {
          return failOpenComponent(toolName, result, theme, context);
        }
        const primaryText = textBlockSnapshot(content[0]);
        if (primaryText === undefined) return failOpenComponent(toolName, result, theme, context);
        const feedback: string[] = [];
        for (const block of content.slice(1)) {
          const text = textBlockSnapshot(block);
          if (text === undefined) return failOpenComponent(toolName, result, theme, context);
          feedback.push(text);
        }
        const expansion = piToolsExpandKeyText();
        const key = expansion.available ? sanitize(expansion.value, true, 512) : "";
        const contextState = safeGet(context, "state");
        const html = (typeof contextState === "object" || typeof contextState === "function") && contextState !== null &&
          htmlCallStates.has(contextState);
        const revealDetail = safeGet(options, "expanded") === true || !expansion.available || !key;
        const state = deriveState(toolName, details, args, result, primaryText);
        if (!revealDetail) state.expansionCue = html ? "click to show detail" : `${key} to expand`;
        const detail = detailComponent(primaryText, theme);
        const components: Component[] = [summaryComponent(toolName, args, state, theme, detail)];
        if (revealDetail) components.push(detail);
        components.push(recoveryComponent(toolName, args, state, theme));
        if (feedback.length > 0) components.push(feedbackComponent(feedback, theme));
        return combinedComponent(components);
      } catch {
        return failOpenComponent(toolName, result, theme, context);
      }
    },
  } as T;
}

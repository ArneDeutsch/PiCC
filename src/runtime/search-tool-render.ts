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
import { genericResultComponent, type RenderCtx } from "./tool-shell.js";
import {
  formatDisplayPathFromRoots,
  formatToolDisplayName,
  priorityDisplayRow,
  resolveDisplayRoots,
  sanitizeInlineDisplay,
  type DisplayRootResolver,
  type DisplayRoots,
} from "./tool-display.js";
import { themedFg } from "./render-util.js";
const LINE_BREAK_RE = /\r\n?|\n|\u2028|\u2029/;

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

function stripTerminalEscapes(text: string): string {
  return text
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|\u009c)/gu, "")
    .replace(/[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/gu, "");
}

function sanitize(text: unknown, inline: boolean): string {
  let value = typeof text === "string" ? text : "";
  try {
    value = value.normalize("NFC");
  } catch {
    return "";
  }
  value = stripTerminalEscapes(value)
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (character) =>
      !inline && character === "\n" ? "\n" : character === "\t" ? "   " : " ",
    );
  return inline ? value.replace(/\s+/gu, " ").trim() : value;
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

function summaryLine(
  toolName: SearchName,
  args: Snapshot,
  state: SummaryState | undefined,
  theme: unknown,
  width: number,
): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const parts = invocationParts(toolName, args);
  const inline = selectSummaryCore(toolName, parts.expression, state, theme, width, true);
  const core = inline ?? selectSummaryCore(toolName, parts.expression, state, theme, width, false);
  let line = core?.line ?? safeFg(theme, "text", formatToolDisplayName(toolName));
  if (state?.status && !core?.hasStatus) return clamp(line, width);
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
  return clamp(line, width);
}

const CLIP_HINTS: Record<SearchName, string> = {
  Grep: "re-run the search with a tighter pattern or a smaller head_limit/offset to recover the omitted matches",
  Glob: "re-run a narrower command — target a specific path, request fewer entries, or pipe through a filter — to recover the omitted output",
};

// The exact in-band marker is an advisory clipping signal; ordinary prose and counts are ignored.
function exactClipMarker(toolName: SearchName, text: string): boolean {
  const escaped = CLIP_HINTS[toolName].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|\\n\\n)\\[PiCC clipped (?:0|[1-9]\\d*) characters from the middle of this ${toolName} output — ${escaped}\\](?=\\n\\n|$)`,
    "u",
  ).test(text);
}

function deriveState(toolName: SearchName, details: GrepResultDetails | GlobResultDetails, args: Snapshot, primaryText: string): SummaryState {
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
  if (exactClipMarker(toolName, primaryText)) {
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

function failOpenComponent(result: unknown, theme: unknown, context: RenderContext | undefined): Component {
  let snapshot: ResultShape;
  try {
    snapshot = safeContentSnapshot(result);
  } catch {
    snapshot = { content: [{ type: "text", text: "Unrenderable search result" }] };
  }
  const safeTheme = { fg: (slot: string, text: string) => safeFg(theme, slot, text) };
  const safeContext = { showImages: safeGet(context, "showImages") === true };
  try {
    return guarded(genericResultComponent(snapshot as never, safeTheme, safeContext));
  } catch {
    return guarded({ render: (width) => [clamp("Search result unavailable", width)] });
  }
}

function feedbackComponent(texts: readonly string[], theme: unknown): Component {
  const snapshot = texts.map((text) => sanitize(text, false));
  return guarded({
    render(width: number): string[] {
      if (width <= 0) return snapshot.map(() => "");
      const lines: string[] = [];
      for (const text of snapshot) {
        for (const sourceLine of text.split(LINE_BREAK_RE)) {
          lines.push(...wrapTextWithAnsi(safeFg(theme, "toolOutput", sourceLine), Math.max(1, width)));
        }
      }
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
      if (!snapshot || selectSummaryCore(toolName, expression, state, theme, width, true)) return [];
      if (width <= 0) return [""];
      return wrapTextWithAnsi(safeFg(theme, "toolOutput", snapshot), Math.max(1, width));
    },
  }, "Recovery unavailable");
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

function stockSearchCall(
  toolName: StockSearchName,
  argsValue: unknown,
  theme: unknown,
  roots: DisplayRoots,
): Component {
  const args = snapshotArgs(argsValue);
  const rawPath = typeof args.path === "string" ? args.path : ".";
  const displayPath = sanitizeInlineDisplay(formatDisplayPathFromRoots(rawPath, roots)) || ".";
  const optional = [
    ...(toolName === "grep" && typeof args.glob === "string" && sanitize(args.glob, true)
      ? [`glob ${quote(sanitize(args.glob, true))}`] : []),
    ...(typeof args.limit === "number" && Number.isFinite(args.limit) ? [`limit ${String(args.limit)}`] : []),
  ];
  if (toolName === "ls") {
    return priorityDisplayRow("ls", displayPath, [], optional, "", theme);
  }
  const expression = sanitize(args.pattern, true) || "?";
  return priorityDisplayRow(toolName, expression, [], [`in ${displayPath}`, ...optional], "", theme);
}

// HTML serializes custom calls before results, so PiCC compact rows are result-owned.
// Pi's stock built-ins retain their native result renderer and only replace the call fragment.
export function withCompactSearchRendering<T extends ToolDefinition>(
  tool: T,
  dependencies: CompactSearchRenderingDependencies = {},
): T {
  const toolName = tool.name;
  if (toolName !== "Grep" && toolName !== "Glob" && toolName !== "grep" && toolName !== "find" && toolName !== "ls") {
    throw new TypeError("compact search rendering accepts only Grep, Glob, grep, find, or ls tools");
  }
  const roots = new WeakMap<object, DisplayRoots>();
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
    return {
      ...tool,
      renderCall(args: unknown, theme: unknown, context: RenderContext): Component {
        return stockSearchCall(toolName, args, theme, rootsFor(context));
      },
    } as T;
  }
  return {
    ...tool,
    renderCall(_args: unknown, _theme: unknown, context: RenderContext): Component {
      rootsFor(context);
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
            guarded({ render: (width) => [summaryLine(toolName, args, failed, theme, width)] }, toolName),
            failOpenComponent(result, theme, context),
          ]);
        }
        if (safeGet(options, "isPartial") === true) return failOpenComponent(result, theme, context);
        const content = safeOwn(result, "content");
        const detailsValue = safeOwn(result, "details");
        const details = toolName === "Grep" ? validateGrepDetails(detailsValue, args) : validateGlobDetails(detailsValue);
        if (!validArgs(toolName, args) || !Array.isArray(content) || content.length === 0 || !details) {
          return failOpenComponent(result, theme, context);
        }
        const primaryText = textBlockSnapshot(content[0]);
        if (primaryText === undefined) return failOpenComponent(result, theme, context);
        const feedback: string[] = [];
        for (const block of content.slice(1)) {
          const text = textBlockSnapshot(block);
          if (text === undefined) return failOpenComponent(result, theme, context);
          feedback.push(text);
        }
        const state = deriveState(toolName, details, args, primaryText);
        const components: Component[] = [
          guarded({ render: (width) => [summaryLine(toolName, args, state, theme, width)] }, toolName),
          recoveryComponent(toolName, args, state, theme),
        ];
        if (feedback.length > 0) components.push(feedbackComponent(feedback, theme));
        return combinedComponent(components);
      } catch {
        return failOpenComponent(result, theme, context);
      }
    },
  } as T;
}

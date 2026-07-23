import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  adaptedEditPreviewError,
  recognizeMultiEditSuccess,
  type MultiEditSnapshot,
} from "./routine-tool-render.js";
import {
  priorityDisplayRow,
  formatDisplayPath,
  formatToolDisplayName,
  resolveDisplayRoot,
  type DisplayRootResolver,
} from "./tool-display.js";
import { themedFg } from "./render-util.js";

interface Component { render(width: number): string[] }
type ToolName = "read" | "write" | "edit" | "MultiEdit" | "bash";
type Data = Record<string, unknown>;
type NativeCall = (args: unknown, theme: unknown, context: unknown) => Component;
type NativeResult = (result: unknown, options: unknown, theme: unknown, context: unknown) => Component;

interface Lifecycle {
  args?: Data;
  call?: Component;
  result?: Component;
  editPreviewError?: string;
  displayRoot?: string;
  displayRootResolved?: boolean;
  settledCall: boolean;
}

interface FileSummary { kind: "file"; path: string; lines: number; range?: string; remaining?: number; nextOffset?: number }
interface MutationSummary { kind: "mutation"; path: string; edits: number; diffLines?: number; noNet: boolean }
interface BashSummary { kind: "bash"; outputLines: number; commandPreview: string; additionalCommandLines: number; duration?: string }
type Summary = FileSummary | MutationSummary | BashSummary;

const MAX_PATH = 16_384;
const MAX_TEXT = 1_000_000;
const MAX_IMAGE_DATA = 8 * 1024 * 1024;
const MAX_ARRAY = 1_000;
const lifecycles = new WeakMap<object, Lifecycle>();

function data(value: unknown): Data | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : undefined;
}

function exact(value: unknown, keys: readonly string[]): Data | undefined {
  const record = data(value);
  if (!record) return undefined;
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key)) ? record : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  const field = data(value)?.[key];
  return typeof field === "boolean" ? field : undefined;
}

/**
 * Display-boundary escape stripping: OSC/CSI/lone-ESC sequences become "�" and
 * remaining control/format characters are neutralized. Exported so the MCP
 * proxy result renderer shares this one implementation instead of re-deriving
 * the regexes.
 */
export function sanitize(value: string, limit: number, inline = false): string {
  let text = value.slice(0, limit).normalize("NFC");
  text = text
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu, "�")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/gu, "�")
    .replace(/\u001b(?:[ -/]*[@-~]?|.)?/gu, "�")
    .replace(/\r/gu, "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
      if (!inline && character === "\n") return "\n";
      return character === "\t" ? "   " : "�";
    });
  return inline ? text.replace(/\s+/gu, " ").trim() : text;
}

function displayArgs(toolName: ToolName, value: unknown): Data | undefined {
  if (toolName === "read") {
    const args = data(value);
    if (!args || !Object.keys(args).every((key) => ["path", "offset", "limit"].includes(key)) ||
      typeof args.path !== "string" || args.path.length > MAX_PATH) return undefined;
    for (const key of ["offset", "limit"] as const) {
      if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || (args[key] as number) < 1)) return undefined;
    }
    return { path: sanitize(args.path, MAX_PATH, true), ...(args.offset === undefined ? {} : { offset: args.offset }),
      ...(args.limit === undefined ? {} : { limit: args.limit }) };
  }
  if (toolName === "write") {
    const args = exact(value, ["path", "content"]);
    return args && typeof args.path === "string" && args.path.length <= MAX_PATH &&
      typeof args.content === "string" && args.content.length <= MAX_TEXT
      ? { path: sanitize(args.path, MAX_PATH, true), content: sanitize(args.content, MAX_TEXT) }
      : undefined;
  }
  if (toolName === "bash") {
    const args = data(value);
    if (!args || !Object.keys(args).every((key) => key === "command" || key === "timeout") ||
      typeof args.command !== "string" || args.command.length > MAX_TEXT ||
      (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isFinite(args.timeout)))) return undefined;
    const command = args.command.split(/\r\n|\n|\r|\u2028|\u2029/u)
      .map((line) => sanitize(line, MAX_TEXT, true)).join("\n");
    return { command, ...(args.timeout === undefined ? {} : { timeout: args.timeout }) };
  }
  if (toolName === "edit") {
    const args = exact(value, ["path", "edits"]);
    if (!args || typeof args.path !== "string" || args.path.length > MAX_PATH ||
      !Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > MAX_ARRAY) return undefined;
    const edits: Array<{ oldText: string; newText: string }> = [];
    for (const entry of args.edits) {
      const edit = exact(entry, ["oldText", "newText"]);
      if (!edit || typeof edit.oldText !== "string" || edit.oldText.length > MAX_TEXT ||
        typeof edit.newText !== "string" || edit.newText.length > MAX_TEXT) return undefined;
      edits.push({ oldText: sanitize(edit.oldText, MAX_TEXT), newText: sanitize(edit.newText, MAX_TEXT) });
    }
    return { path: sanitize(args.path, MAX_PATH, true), edits };
  }
  const args = exact(value, ["file_path", "edits"]);
  if (!args || typeof args.file_path !== "string" || args.file_path.length > MAX_PATH ||
    !Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > MAX_ARRAY) return undefined;
  const edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];
  for (const entry of args.edits) {
    const edit = data(entry);
    if (!edit || !Object.keys(edit).every((key) => ["old_string", "new_string", "replace_all"].includes(key)) ||
      typeof edit.old_string !== "string" || edit.old_string.length > MAX_TEXT ||
      typeof edit.new_string !== "string" || edit.new_string.length > MAX_TEXT ||
      (edit.replace_all !== undefined && typeof edit.replace_all !== "boolean")) return undefined;
    edits.push({ old_string: sanitize(edit.old_string, MAX_TEXT), new_string: sanitize(edit.new_string, MAX_TEXT),
      ...(edit.replace_all === undefined ? {} : { replace_all: edit.replace_all }) });
  }
  return { file_path: sanitize(args.file_path, MAX_PATH, true), edits };
}

function liveDisplayArgs(toolName: ToolName, value: unknown): Data | undefined {
  const source = data(value);
  if (!source) return undefined;
  const result: Data = {};
  const copyString = (key: string, limit: number, inline = false): boolean => {
    if (!(key in source)) return true;
    const field = source[key];
    if (typeof field !== "string" || field.length > limit) return false;
    result[key] = sanitize(field, limit, inline);
    return true;
  };
  const copyNumber = (key: string): boolean => {
    if (!(key in source)) return true;
    const field = source[key];
    if (typeof field !== "number" || !Number.isFinite(field)) return false;
    result[key] = field;
    return true;
  };
  const copyEdits = (key: string, oldKey: string, newKey: string): boolean => {
    if (!(key in source)) return true;
    const field = source[key];
    if (!Array.isArray(field) || field.length > MAX_ARRAY) return false;
    const edits: Data[] = [];
    for (const value of field) {
      const edit = data(value);
      if (!edit) return false;
      const safe: Data = {};
      for (const textKey of [oldKey, newKey]) {
        if (!(textKey in edit)) continue;
        const text = edit[textKey];
        if (typeof text !== "string" || text.length > MAX_TEXT) return false;
        safe[textKey] = sanitize(text, MAX_TEXT);
      }
      if ("replace_all" in edit) {
        if (typeof edit.replace_all !== "boolean") return false;
        safe.replace_all = edit.replace_all;
      }
      edits.push(safe);
    }
    result[key] = edits;
    return true;
  };

  if (toolName === "read") {
    return copyString("path", MAX_PATH, true) && copyNumber("offset") && copyNumber("limit") ? result : undefined;
  }
  if (toolName === "write") {
    return copyString("path", MAX_PATH, true) && copyString("content", MAX_TEXT) ? result : undefined;
  }
  if (toolName === "bash") {
    return copyString("command", MAX_TEXT) && copyNumber("timeout") ? result : undefined;
  }
  if (toolName === "edit") {
    return copyString("path", MAX_PATH, true) && copyEdits("edits", "oldText", "newText") ? result : undefined;
  }
  return copyString("file_path", MAX_PATH, true) && copyEdits("edits", "old_string", "new_string") ? result : undefined;
}

function displayContent(value: unknown): Array<Data> | undefined {
  if (!Array.isArray(value) || value.length > MAX_ARRAY) return undefined;
  const blocks: Data[] = [];
  for (const blockValue of value) {
    const block = data(blockValue);
    if (block?.type === "text" && typeof block.text === "string" && block.text.length <= MAX_TEXT) {
      blocks.push({ type: "text", text: sanitize(block.text, MAX_TEXT) });
    } else if (block?.type === "image" && typeof block.data === "string" && block.data.length <= MAX_IMAGE_DATA &&
      typeof block.mimeType === "string" && block.mimeType.length <= 256) {
      blocks.push({ type: "image", data: block.data, mimeType: sanitize(block.mimeType, 256, true) });
    } else return undefined;
  }
  return blocks;
}

function displayDetails(value: unknown): unknown {
  if (value === undefined) return undefined;
  const source = data(value);
  if (!source || Object.keys(source).length > 32) return undefined;
  const result: Data = {};
  for (const [key, field] of Object.entries(source)) {
    if (typeof field === "string") result[key] = sanitize(field, key.toLowerCase().includes("path") ? MAX_PATH : MAX_TEXT, key !== "diff" && key !== "patch" && key !== "content");
    else if (typeof field === "number" || typeof field === "boolean" || field === null || field === undefined) result[key] = field;
    else if (key === "truncation" && data(field)) result[key] = displayDetails(field);
    else return undefined;
  }
  return result;
}

function canonicalEnvelope(value: unknown): boolean {
  const source = data(value);
  return Boolean(source && Object.keys(source).every((key) => ["content", "details", "isError"].includes(key)));
}

function displayResult(value: unknown): Data | undefined {
  const source = data(value);
  const content = source && displayContent(source.content);
  if (!source || !content || (source.isError !== undefined && typeof source.isError !== "boolean")) return undefined;
  const details = displayDetails(source.details);
  if (source.details !== undefined && details === undefined) return undefined;
  return { content, details, ...(source.isError === undefined ? {} : { isError: source.isError }) };
}

function lifecycle(context: unknown): Lifecycle | undefined {
  const state = data(context)?.state;
  if (state === null || typeof state !== "object") return undefined;
  let current = lifecycles.get(state);
  if (!current) {
    current = { settledCall: false };
    lifecycles.set(state, current);
  }
  return current;
}

function nativeContext(context: unknown, args: Data, lastComponent: Component | undefined, expanded: boolean): Data {
  const source = data(context) ?? {};
  return { ...source, args, lastComponent, expanded };
}

function bindingHint(): string | undefined {
  try {
    const keys = getKeybindings().getKeys("app.tools.expand");
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 8 ||
      keys.some((key) => typeof key !== "string" || key.length === 0 || key.length > 64)) return undefined;
    return keys.map((key) => sanitize(key, 64, true)).join("/");
  } catch {
    return undefined;
  }
}

function fileLineCount(value: string): number {
  const lines = sanitize(value, MAX_TEXT).split("\n");
  while (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function bashLineCount(value: string): number {
  const trimmed = sanitize(value, MAX_TEXT).trim();
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

function oneText(result: unknown): { text: string; details: unknown } | undefined {
  const envelope = data(result);
  const blocks = envelope && displayContent(envelope.content);
  return envelope && blocks?.length === 1 && blocks[0]?.type === "text" && typeof blocks[0].text === "string"
    ? { text: blocks[0].text, details: envelope.details }
    : undefined;
}

function finalAgreement(options: unknown, context: unknown): boolean {
  return booleanField(options, "isPartial") === false && booleanField(context, "isPartial") === false &&
    booleanField(context, "isError") === false;
}

function readContinuationSummary(args: Data, result: unknown): FileSummary | undefined {
  const limit = args.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1) return undefined;
  const envelope = data(result);
  if (!envelope || !canonicalEnvelope(result) || envelope.details !== undefined ||
    (envelope.isError !== undefined && envelope.isError !== false) || !Array.isArray(envelope.content) ||
    envelope.content.length !== 1) return undefined;
  const block = exact(envelope.content[0], ["type", "text"]);
  if (!block || block.type !== "text" || typeof block.text !== "string") return undefined;
  const match = /\n\n\[([1-9]\d*) more lines in file\. Use offset=([1-9]\d*) to continue\.\]$/u.exec(block.text);
  if (!match) return undefined;
  const remaining = Number(match[1]);
  const nextOffset = Number(match[2]);
  const start = typeof args.offset === "number" ? args.offset : 1;
  if (!Number.isSafeInteger(remaining) || !Number.isSafeInteger(nextOffset) ||
    nextOffset !== start + (limit as number)) return undefined;
  const payload = block.text.slice(0, match.index);
  if (/\[[1-9]\d* more lines in file\. Use offset=[1-9]\d* to continue\.\]/u.test(payload) ||
    payload.split("\n").length !== limit) return undefined;
  return {
    kind: "file",
    path: args.path as string,
    lines: limit as number,
    range: `:${start}-${start + (limit as number) - 1}`,
    remaining,
    nextOffset,
  };
}

function recognize(toolName: ToolName, args: Data, result: unknown, context: unknown): Summary | undefined {
  const envelope = data(result);
  if (!canonicalEnvelope(result) || !envelope || (envelope.isError !== undefined && envelope.isError !== false)) return undefined;
  if (toolName === "MultiEdit") return undefined;
  const text = oneText(result);
  if (!text) return undefined;
  if (toolName === "read") {
    const continuation = readContinuationSummary(args, result);
    if (continuation) return continuation;
    if (text.details !== undefined || /(?:^|\n)\[(?:Showing lines |Line \d+ is |\d+ more lines in file\.|\d+ more lines in file\. Use offset=|PiCC clipped |Truncated:|First line exceeds)/u.test(text.text) ||
      /\[[^\]\n]*more\s+lines\s+in\s+file[^\]\n]*\]/iu.test(text.text) ||
      text.text.startsWith("Read image file [")) return undefined;
    const offset = typeof args.offset === "number" ? args.offset : 1;
    return { kind: "file", path: args.path as string, lines: fileLineCount(text.text),
      ...((args.offset !== undefined || args.limit !== undefined) ? { range: `:${offset}${typeof args.limit === "number" ? `-${offset + args.limit - 1}` : ""}` } : {}) };
  }
  if (toolName === "write") {
    if (text.details !== undefined || text.text !== `Successfully wrote ${(args.content as string).length} bytes to ${args.path as string}`) return undefined;
    return { kind: "file", path: args.path as string, lines: fileLineCount(args.content as string) };
  }
  if (toolName === "bash") {
    if (text.details !== undefined) return undefined;
    const state = data(data(context)?.state);
    const startedAt = state?.startedAt;
    const endedAt = state?.endedAt;
    const duration = typeof startedAt === "number" && typeof endedAt === "number" &&
      Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt
      ? `${((endedAt - startedAt) / 1000).toFixed(1)}s`
      : undefined;
    const commandLines = (args.command as string).split("\n").filter((line) => line.trim().length > 0);
    return { kind: "bash", outputLines: text.text === "(no output)" ? 0 : bashLineCount(text.text),
      commandPreview: commandLines[0] ?? "...", additionalCommandLines: Math.max(0, commandLines.length - 1),
      ...(duration ? { duration } : {}) };
  }
  const editArgs = args.edits as unknown[];
  const details = exact(text.details, ["diff", "patch", "firstChangedLine"]);
  if (!details || typeof details.diff !== "string" || typeof details.patch !== "string" ||
    text.text !== `Successfully replaced ${editArgs.length} block(s) in ${args.path as string}.`) return undefined;
  if (details.diff === "" && details.patch === "" && details.firstChangedLine === undefined) {
    return { kind: "mutation", path: args.path as string, edits: editArgs.length, noNet: true };
  }
  if (details.diff.length === 0 || !Number.isSafeInteger(details.firstChangedLine) || (details.firstChangedLine as number) < 1) return undefined;
  return { kind: "mutation", path: args.path as string, edits: editArgs.length,
    diffLines: fileLineCount(sanitize(details.diff, MAX_TEXT)), noNet: false };
}

function multiSummary(snapshot: MultiEditSnapshot): MutationSummary {
  return { kind: "mutation", path: snapshot.path, edits: snapshot.editCount,
    ...(snapshot.diff.length === 0 ? { noNet: true } : { noNet: false, diffLines: fileLineCount(snapshot.diff) }) };
}

function clamp(line: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const columns = Math.floor(width);
  try { return visibleWidth(line) > columns ? truncateToWidth(line, columns, "…") : line; }
  catch { return sanitize(line, columns, true).slice(0, columns); }
}

function summaryComponent(
  toolName: ToolName,
  summary: Summary,
  hint: string,
  theme: unknown,
  displayRoot: string | undefined,
): Component {
  const title = formatToolDisplayName(toolName);
  if (summary.kind === "bash") {
    const optional = [
      ...(summary.additionalCommandLines > 0
        ? [`${summary.additionalCommandLines} more command ${summary.additionalCommandLines === 1 ? "line" : "lines"}`]
        : []),
      summary.outputLines === 0 ? "no output" : `${summary.outputLines} output ${summary.outputLines === 1 ? "line" : "lines"} hidden`,
      ...(summary.duration ? [summary.duration] : []),
    ];
    return priorityDisplayRow(title, summary.commandPreview, [], optional, `${hint} to expand`, theme);
  }
  const path = formatDisplayPath(sanitize(summary.path, MAX_PATH, true), displayRoot);
  if (summary.kind === "mutation") {
    const detail = summary.noNet ? "no net change" : `${summary.diffLines} diff ${summary.diffLines === 1 ? "line" : "lines"} hidden`;
    return priorityDisplayRow(title, path,
      [`${summary.edits} ${summary.edits === 1 ? "edit" : "edits"} applied`], [detail], `${hint} to expand`, theme);
  }
  if (summary.remaining !== undefined && summary.nextOffset !== undefined) {
    return priorityDisplayRow(title, `${path}${summary.range ?? ""}`,
      [`next offset ${summary.nextOffset}`], [`${summary.remaining} more lines`], `${hint} to expand`, theme);
  }
  return priorityDisplayRow(title, `${path}${summary.range ?? ""}`,
    [], [`${summary.lines} ${summary.lines === 1 ? "line" : "lines"} hidden`], `${hint} to expand`, theme);
}

function messageComponent(message: string, theme: unknown): Component {
  const safe = sanitize(message, 512, true);
  return { render: (width) => [clamp(themedFg(theme, "warning", safe), width)] };
}

function combined(components: readonly Component[], theme: unknown): Component {
  return { render(width: number): string[] {
    try { return components.flatMap((component) => component.render(width).map((line) => clamp(line, width))); }
    catch { return messageComponent("Renderer failed", theme).render(width); }
  } };
}

export interface DefaultCollapsedRenderingDependencies {
  resolveDisplayRoot?: DisplayRootResolver;
}

/**
 * Collapse only recognized settled main-session successes. Display-safe live and nonordinary states
 * delegate natively, while malformed display data gets concise warnings.
 */
export function withDefaultCollapsedToolRendering<T extends ToolDefinition>(
  tool: T,
  dependencies: DefaultCollapsedRenderingDependencies = {},
): T {
  const toolName = tool.name as ToolName;
  if (!["read", "write", "edit", "MultiEdit", "bash"].includes(toolName) ||
    typeof tool.renderCall !== "function" || typeof tool.renderResult !== "function") return tool;
  const nativeCall = tool.renderCall as NativeCall;
  const nativeResult = tool.renderResult as NativeResult;

  const decorated = { ...tool } as T;
  decorated.renderCall = ((argsValue: unknown, theme: unknown, context: unknown): Component => {
    const current = lifecycle(context);
    if (current && current.displayRootResolved !== true) {
      current.displayRoot = resolveDisplayRoot(dependencies.resolveDisplayRoot, context);
      current.displayRootResolved = true;
    }
    const settled = booleanField(context, "isPartial") === false;
    const args = settled ? displayArgs(toolName, argsValue) : liveDisplayArgs(toolName, argsValue);
    if (!args) return messageComponent("Unfamiliar arguments", theme);
    if (!current) {
      try { return nativeCall(args, theme, nativeContext(context, args, undefined, booleanField(context, "expanded") === true)); }
      catch { return messageComponent("Renderer failed", theme); }
    }
    if (!settled) {
      try {
        current.call = nativeCall(args, theme, nativeContext(context, args, current.call, booleanField(context, "expanded") === true));
        return current.call;
      } catch { return messageComponent("Renderer failed", theme); }
    }
    current.args = args;
    const hint = bindingHint();
    const expanded = booleanField(context, "expanded") === true || (settled && !hint);
    try {
      current.call = nativeCall(args, theme, nativeContext(context, args, current.call, expanded));
      current.settledCall ||= settled;
      const previewError = toolName === "edit" ? adaptedEditPreviewError(current.call) : undefined;
      if (previewError) current.editPreviewError = sanitize(previewError, 512, true);
      return settled && hint ? { render: () => [] } : current.call;
    } catch {
      return messageComponent("Renderer failed", theme);
    }
  }) as T["renderCall"];

  decorated.renderResult = ((resultValue: unknown, options: unknown, theme: unknown, context: unknown): Component => {
    const current = lifecycle(context);
    const partial = booleanField(options, "isPartial") === true || booleanField(context, "isPartial") === true;
    const args = current?.args ?? (partial
      ? liveDisplayArgs(toolName, data(context)?.args)
      : displayArgs(toolName, data(context)?.args));
    const result = displayResult(resultValue);
    if (!args) return messageComponent("Unfamiliar arguments", theme);
    if (!result) return messageComponent("Unfamiliar result", theme);
    if (!current) {
      try {
        return nativeResult(result, { expanded: true, isPartial: booleanField(options, "isPartial") }, theme,
          nativeContext(context, args, undefined, true));
      } catch { return messageComponent("Renderer failed", theme); }
    }
    const requestedExpanded = booleanField(options, "expanded") === true;
    const hint = bindingHint();
    if (partial) {
      try {
        current.result = nativeResult(result, { expanded: requestedExpanded, isPartial: true }, theme,
          nativeContext(context, args, current.result, requestedExpanded));
        return current.result;
      } catch { return messageComponent("Renderer failed", theme); }
    }

    const agreed = finalAgreement(options, context);
    const previewError = toolName === "edit" ? adaptedEditPreviewError(current.call) : undefined;
    if (previewError) current.editPreviewError = sanitize(previewError, 512, true);
    const multi = toolName === "MultiEdit"
      ? recognizeMultiEditSuccess(resultValue, options, context)
      : undefined;
    let ordinary = agreed && !current.editPreviewError
      ? (multi?.kind === "displayable"
        ? multiSummary(multi) : recognize(toolName, args, resultValue, context))
      : undefined;
    const forceExpanded = !hint || !agreed || !ordinary;
    let native: Component;
    try {
      native = nativeResult(result, { expanded: forceExpanded || requestedExpanded, isPartial: false }, theme,
        nativeContext(context, args, current.result, forceExpanded || requestedExpanded));
      current.result = native;
    } catch { return messageComponent("Renderer failed", theme); }
    if (ordinary?.kind === "bash") {
      ordinary = recognize(toolName, args, resultValue, context) ?? ordinary;
    }

    const ownsRow = current.settledCall && current.call;
    if (ordinary && hint && !requestedExpanded && ownsRow) {
      const displayRoot = current.displayRootResolved === true
        ? current.displayRoot
        : resolveDisplayRoot(dependencies.resolveDisplayRoot, context);
      return summaryComponent(toolName, ordinary, hint, theme, displayRoot);
    }

    let call = current.call;
    if (ownsRow && (forceExpanded || requestedExpanded)) {
      try {
        call = nativeCall(args, theme, nativeContext(context, args, current.call, true));
        current.call = call;
      } catch { /* The retained call is still safe to show. */ }
    }
    if (!ownsRow || !call) return native;
    if (current.editPreviewError) {
      return combined([messageComponent(`Edit preview failed: ${current.editPreviewError}`, theme), call, native], theme);
    }
    return combined([call, native], theme);
  }) as T["renderResult"];

  return decorated;
}

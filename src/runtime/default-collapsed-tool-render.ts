import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  adaptedEditPreviewError,
  adaptedMultiEditSnapshot,
  type MultiEditSuccess,
} from "./routine-tool-render.js";

interface Component { render(width: number): string[] }
type ToolName = "read" | "write" | "bash" | "edit" | "MultiEdit";
type Data = Record<string, unknown>;
type NativeCall = (args: unknown, theme: unknown, context: unknown) => Component;
type NativeResult = (result: unknown, options: unknown, theme: unknown, context: unknown) => Component;

interface Lifecycle {
  settledObserved: boolean;
  nativeCall?: Component;
  nativeResult?: Component;
  nativeArgs?: Data;
  editPreviewError?: string;
  editOversized: boolean;
  editOversizedTarget?: string;
}
interface FileArgsSnapshot { path: string; content?: string; offset?: number; limit?: number }
interface BashArgsSnapshot { command: string; timeout?: number }
interface EditArgsSnapshot {
  path: string;
  editCount: number;
  content?: never;
  offset?: never;
  limit?: never;
}
type ArgsSnapshot = FileArgsSnapshot | BashArgsSnapshot | EditArgsSnapshot;
interface FileOrdinarySnapshot { kind: "file"; path: string; hiddenLines: number; range?: string }
interface BashOrdinarySnapshot { kind: "bash"; commandLines: number; outputLines: number; duration?: string }
interface MutationOrdinarySnapshot {
  kind: "mutation";
  path: string;
  editCount: number;
  diffLines?: number;
  noNet: boolean;
}
type OrdinarySnapshot = FileOrdinarySnapshot | BashOrdinarySnapshot | MutationOrdinarySnapshot;

type Snapshot<T = unknown> =
  | { kind: "complete"; value: T }
  | { kind: "capped"; budget: "characters" | "depth" | "elements" | "keys" }
  | { kind: "malformed" };
interface Budget {
  chars: number;
  maxStringChars: number;
  elements: number;
  keys: number;
  maxContainerKeys: number;
  maxElements: number;
  maxDepth: number;
}

const MAX_KEYS = 256;
const MAX_CONTAINER_KEYS = 64;
const MAX_ELEMENTS = 128;
const MAX_DEPTH = 8;
const MAX_EDIT_ELEMENTS = 256;
const MAX_EDIT_KEYS = 1_024;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_EDIT_TEXT_CHARS = 2_000_000;
const MAX_PATH_CHARS = 16_384;
const MAX_DISPLAY_LINES = 10_000;
const MAX_RENDERED_LINES = 20_000;
const MAX_KEY_HINT_CHARS = 128;
const REPLACEMENT = "�";
const lifecycles = new WeakMap<object, Lifecycle>();

function ownDescriptor(value: unknown, key: PropertyKey): PropertyDescriptor | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key); } catch { return undefined; }
}
function ownData(value: unknown, key: PropertyKey): unknown {
  const descriptor = ownDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function ownBoolean(value: unknown, key: PropertyKey): boolean | undefined {
  const field = ownData(value, key);
  return typeof field === "boolean" ? field : undefined;
}
function safeIsArray(value: unknown): boolean | undefined {
  try { return Array.isArray(value); } catch { return undefined; }
}
function safePrototype(value: object): object | null | undefined {
  try { return Object.getPrototypeOf(value); } catch { return undefined; }
}
function safeKeys(value: object): PropertyKey[] | undefined {
  try { return Reflect.ownKeys(value); } catch { return undefined; }
}

function snapshot(value: unknown, budget: Budget, depth = 0): Snapshot {
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number") {
    return { kind: "complete", value };
  }
  if (typeof value === "string") {
    if (value.length > budget.maxStringChars || value.length > budget.chars) {
      return { kind: "capped", budget: "characters" };
    }
    budget.chars -= value.length;
    return { kind: "complete", value };
  }
  if (typeof value !== "object") return { kind: "malformed" };
  if (depth >= budget.maxDepth) return { kind: "capped", budget: "depth" };
  const array = safeIsArray(value);
  if (array === undefined) return { kind: "malformed" };
  const prototype = safePrototype(value);
  if (prototype === undefined || prototype !== (array ? Array.prototype : Object.prototype)) {
    return { kind: "malformed" };
  }
  const keys = safeKeys(value);
  if (!keys) return { kind: "malformed" };
  if (keys.length > budget.maxContainerKeys || keys.length > budget.keys) return { kind: "capped", budget: "keys" };
  budget.keys -= keys.length;

  if (array) {
    const length = ownData(value, "length");
    if (!Number.isSafeInteger(length) || (length as number) < 0) return { kind: "malformed" };
    if ((length as number) > budget.maxElements || (length as number) > budget.elements) {
      return { kind: "capped", budget: "elements" };
    }
    if (keys.length !== (length as number) + 1 || !keys.includes("length")) return { kind: "malformed" };
    budget.elements -= length as number;
    const copy: unknown[] = [];
    for (let index = 0; index < (length as number); index++) {
      const descriptor = ownDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return { kind: "malformed" };
      const child = snapshot(descriptor.value, budget, depth + 1);
      if (child.kind !== "complete") return child;
      copy.push(child.value);
    }
    return { kind: "complete", value: copy };
  }

  const copy: Data = Object.create(null) as Data;
  for (const key of keys) {
    if (typeof key !== "string") return { kind: "malformed" };
    const descriptor = ownDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return { kind: "malformed" };
    const child = snapshot(descriptor.value, budget, depth + 1);
    if (child.kind !== "complete") return child;
    Object.defineProperty(copy, key, { value: child.value, enumerable: true, configurable: true, writable: true });
  }
  return { kind: "complete", value: copy };
}

function inspect(value: unknown): Snapshot {
  return snapshot(value, {
    chars: MAX_TEXT_CHARS, maxStringChars: MAX_TEXT_CHARS, elements: MAX_ELEMENTS, keys: MAX_KEYS,
    maxContainerKeys: MAX_CONTAINER_KEYS, maxElements: MAX_ELEMENTS, maxDepth: MAX_DEPTH,
  });
}
function inspectEdit(value: unknown): Snapshot {
  return snapshot(value, {
    chars: MAX_EDIT_TEXT_CHARS, maxStringChars: MAX_TEXT_CHARS,
    elements: MAX_EDIT_ELEMENTS, keys: MAX_EDIT_KEYS,
    maxContainerKeys: MAX_EDIT_ELEMENTS + 1, maxElements: MAX_EDIT_ELEMENTS, maxDepth: MAX_DEPTH,
  });
}
function record(value: unknown): Data | undefined {
  return value !== null && typeof value === "object" && safeIsArray(value) === false ? value as Data : undefined;
}
function exact(value: unknown, expected: readonly string[]): Data | undefined {
  const data = record(value);
  if (!data) return undefined;
  const keys = safeKeys(data);
  if (!keys || keys.length !== expected.length) return undefined;
  const allowed = new Set(expected);
  for (const key of keys) if (typeof key !== "string" || !allowed.has(key)) return undefined;
  return data;
}
function oneExact(value: unknown, shapes: readonly (readonly string[])[]): Data | undefined {
  for (const shape of shapes) { const found = exact(value, shape); if (found) return found; }
  return undefined;
}

function lifecycleFor(context: unknown): Lifecycle | undefined {
  const state = ownData(context, "state");
  if (state === null || typeof state !== "object") return undefined;
  try {
    let lifecycle = lifecycles.get(state);
    if (!lifecycle) { lifecycle = { settledObserved: false, editOversized: false }; lifecycles.set(state, lifecycle); }
    return lifecycle;
  } catch { return undefined; }
}

function sanitize(value: string, maxChars: number, inline: boolean, unsafeReplacement = REPLACEMENT): string {
  let source: string;
  try { source = value.slice(0, maxChars).normalize("NFC"); } catch { return ""; }
  let output = "";
  for (let index = 0; index < source.length;) {
    const code = source.charCodeAt(index);
    const next = source.charCodeAt(index + 1);
    const introducerLength = code === 0x1b ? 2 : 1;
    const kind = code === 0x9b || (code === 0x1b && next === 0x5b) ? "csi"
      : code === 0x9d || (code === 0x1b && next === 0x5d) ? "osc"
      : code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f ||
        (code === 0x1b && (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f)) ? "st"
      : undefined;
    if (kind) {
      index += introducerLength;
      while (index < source.length) {
        const current = source.charCodeAt(index);
        if (kind === "csi" && current >= 0x40 && current <= 0x7e) { index++; break; }
        if (kind === "osc" && current === 0x07) { index++; break; }
        if (current === 0x9c) { index++; break; }
        if (current === 0x1b && source.charCodeAt(index + 1) === 0x5c) { index += 2; break; }
        index++;
      }
      output += unsafeReplacement;
      continue;
    }
    const codePoint = source.codePointAt(index) ?? code;
    const character = String.fromCodePoint(codePoint);
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    if (code === 0x0d) { index++; continue; }
    if (code === 0x0a) output += inline ? " " : "\n";
    else if (code === 0x09) output += "   ";
    else if (code === 0x1b || code < 0x20 || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(character)) {
      output += unsafeReplacement;
    } else output += character;
    index += codeUnits;
  }
  return inline ? output.replace(/\s+/gu, " ").trim() : output;
}

function sanitizeDto(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return sanitize(value, MAX_TEXT_CHARS, false);
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (safeIsArray(value) === true) return (value as unknown[]).map((item) => sanitizeDto(item, depth + 1));
  const data = record(value);
  if (!data) return undefined;
  const result: Data = Object.create(null) as Data;
  const keys = safeKeys(data) ?? [];
  for (const key of keys) {
    if (typeof key === "string") Object.defineProperty(result, key, {
      value: sanitizeDto(ownData(data, key), depth + 1), enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}
function sanitizeArgsDto(value: unknown): Data | undefined {
  const data = record(value);
  if (!data) return undefined;
  const result: Data = Object.create(null) as Data;
  for (const key of safeKeys(data) ?? []) {
    if (typeof key !== "string") continue;
    const field = ownData(data, key);
    const sanitized = typeof field === "string"
      ? sanitize(field, key === "content" || key === "command" ? MAX_TEXT_CHARS : MAX_PATH_CHARS, key !== "content" && key !== "command")
      : sanitizeDto(field, 1);
    Object.defineProperty(result, key, { value: sanitized, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function safeTheme(theme: unknown, method: "fg" | "bold", args: string[], fallback: string): string {
  try {
    const candidate = ownData(theme, method);
    if (typeof candidate !== "function") return fallback;
    const rendered = Reflect.apply(candidate, theme, args);
    return typeof rendered === "string" ? rendered : fallback;
  } catch { return fallback; }
}
function clamp(line: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const columns = Math.floor(width);
  try { return visibleWidth(line) > columns ? truncateToWidth(line, columns, "…") : line; }
  catch { return sanitize(line, Math.max(columns, 1), true).slice(0, columns); }
}
function keyHint(): string | undefined {
  try {
    const keys: unknown = getKeybindings().getKeys("app.tools.expand");
    if (safeIsArray(keys) !== true || (keys as unknown[]).length === 0 || (keys as unknown[]).length > MAX_ELEMENTS) return undefined;
    let chars = 0;
    const displayed: string[] = [];
    for (let index = 0; index < (keys as unknown[]).length; index++) {
      const key = ownData(keys, String(index));
      if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_HINT_CHARS) return undefined;
      const safe = sanitize(key, MAX_KEY_HINT_CHARS, true);
      chars += safe.length;
      if (!safe || chars > MAX_KEY_HINT_CHARS) return undefined;
      displayed.push(safe);
    }
    return displayed.join("/");
  } catch { return undefined; }
}

function argsFrom(value: unknown, toolName: ToolName): ArgsSnapshot | undefined {
  if (toolName === "edit") {
    const data = exact(value, ["path", "edits"]);
    const edits = data && contentBlocks(data.edits);
    if (!data || typeof data.path !== "string" || data.path.length > MAX_PATH_CHARS ||
      !sanitize(data.path, MAX_PATH_CHARS, true) || !edits || edits.length < 1) return undefined;
    for (const entry of edits) {
      const replacement = exact(entry, ["oldText", "newText"]);
      if (!replacement || typeof replacement.oldText !== "string" || typeof replacement.newText !== "string") return undefined;
    }
    return { path: data.path, editCount: edits.length };
  }
  if (toolName === "MultiEdit") return undefined;
  if (toolName === "bash") {
    const data = oneExact(value, [["command"], ["command", "timeout"]]);
    if (!data || typeof data.command !== "string") return undefined;
    if (data.timeout !== undefined && (!Number.isFinite(data.timeout) || (data.timeout as number) <= 0)) return undefined;
    return { command: data.command, ...(typeof data.timeout === "number" ? { timeout: data.timeout } : {}) };
  }
  const shapes = toolName === "write" ? [["path", "content"]] as const
    : [["path"], ["path", "offset"], ["path", "limit"], ["path", "offset", "limit"]] as const;
  const data = oneExact(value, shapes);
  if (!data || typeof data.path !== "string" || data.path.length > MAX_PATH_CHARS || !sanitize(data.path, MAX_PATH_CHARS, true)) return undefined;
  if (toolName === "write") {
    return typeof data.content === "string" ? { path: data.path, content: data.content } : undefined;
  }
  for (const key of ["offset", "limit"] as const) {
    const field = data[key];
    if (field !== undefined && (!Number.isSafeInteger(field) || (field as number) < 1)) return undefined;
  }
  return { path: data.path, ...(typeof data.offset === "number" ? { offset: data.offset } : {}), ...(typeof data.limit === "number" ? { limit: data.limit } : {}) };
}
function resultEnvelope(value: unknown): Data | undefined {
  return oneExact(value, [["content", "details"], ["content", "details", "isError"]]);
}
function contentBlocks(value: unknown): unknown[] | undefined {
  return safeIsArray(value) === true ? value as unknown[] : undefined;
}
function textBlock(value: unknown): string | undefined {
  const data = exact(value, ["type", "text"]);
  return data?.type === "text" && typeof data.text === "string" ? data.text : undefined;
}
function logicalLineCount(value: string): Snapshot<number> {
  let currentLine = 1;
  let retainedLines = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x0d) continue;
    if (code === 0x0a) {
      currentLine++;
      continue;
    }
    retainedLines = currentLine;
    if (retainedLines > MAX_DISPLAY_LINES) return { kind: "capped", budget: "elements" };
  }
  return { kind: "complete", value: retainedLines };
}
function detachedDisplayLineCount(value: string): Snapshot<number> {
  return logicalLineCount(sanitize(value, MAX_TEXT_CHARS, false));
}
function bashDisplayLineCount(value: string): Snapshot<number> {
  // Count the same detached, terminal-safe DTO that native expansion receives.
  const display = sanitize(value, MAX_TEXT_CHARS, false).trim();
  if (!display) return { kind: "complete", value: 0 };
  let lines = 1;
  for (let index = 0; index < display.length; index++) {
    if (display.charCodeAt(index) !== 0x0a) continue;
    lines++;
    if (lines > MAX_DISPLAY_LINES) return { kind: "capped", budget: "elements" };
  }
  return { kind: "complete", value: lines };
}
function hasReadNotice(text: string): boolean {
  return /(?:^|\n)\[(?:Showing lines |Line \d+ is |\d+ more lines in file\.|PiCC clipped |Truncated:|First line exceeds)/u.test(text);
}
function nativeDuration(context: unknown): string | undefined {
  const state = ownData(context, "state");
  const startedAt = ownData(state, "startedAt");
  const endedAt = ownData(state, "endedAt");
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) ||
    typeof endedAt !== "number" || !Number.isFinite(endedAt) || endedAt < startedAt) return undefined;
  return `${((endedAt - startedAt) / 1000).toFixed(1)}s`;
}
function ordinary(toolName: ToolName, args: ArgsSnapshot, result: unknown, context: unknown): Snapshot<OrdinarySnapshot> {
  if (toolName === "edit") {
    if (!("editCount" in args)) return { kind: "malformed" };
    const envelope = resultEnvelope(result);
    const details = envelope && exact(envelope.details, ["diff", "patch", "firstChangedLine"]);
    const blocks = envelope && contentBlocks(envelope.content);
    const text = blocks?.length === 1 ? textBlock(blocks[0]) : undefined;
    if (!envelope || ("isError" in envelope && envelope.isError !== false) || !details ||
      typeof details.diff !== "string" || typeof details.patch !== "string" ||
      text !== `Successfully replaced ${args.editCount} block(s) in ${args.path}.`) return { kind: "malformed" };
    if (details.diff.length === 0) return { kind: "malformed" };
    if (!Number.isSafeInteger(details.firstChangedLine) || (details.firstChangedLine as number) < 1) return { kind: "malformed" };
    const count = logicalLineCount(sanitize(details.diff, MAX_TEXT_CHARS, false));
    return count.kind === "complete" ? { kind: "complete", value: {
      kind: "mutation", path: args.path, editCount: args.editCount, diffLines: count.value, noNet: false,
    } } : count;
  }
  const envelope = resultEnvelope(result);
  if (!envelope || ("isError" in envelope && envelope.isError !== false) || envelope.details !== undefined) return { kind: "malformed" };
  const blocks = contentBlocks(envelope.content);
  if (!blocks || blocks.length !== 1) return { kind: "malformed" };
  const text = textBlock(blocks[0]);
  if (text === undefined) return { kind: "malformed" };
  if (toolName === "bash") {
    if (!("command" in args)) return { kind: "malformed" };
    // Stock Bash displays `...` for an empty command; count the same sanitized display value delegated to it.
    const commandDisplay = sanitize(args.command, MAX_TEXT_CHARS, false) || "...";
    const commandCount = logicalLineCount(commandDisplay);
    const outputCount = text === "(no output)" ? { kind: "complete", value: 0 } as const : bashDisplayLineCount(text);
    if (commandCount.kind !== "complete") return commandCount;
    if (outputCount.kind !== "complete") return outputCount;
    const duration = nativeDuration(context);
    return { kind: "complete", value: {
      kind: "bash", commandLines: commandCount.value, outputLines: outputCount.value,
      ...(duration === undefined ? {} : { duration }),
    } };
  }
  if (!("path" in args)) return { kind: "malformed" };
  if (toolName === "read") {
    if (hasReadNotice(text) || text.startsWith("Read image file [")) return { kind: "malformed" };
    const count = detachedDisplayLineCount(text);
    return count.kind === "complete" ? {
      kind: "complete", value: {
        kind: "file", path: args.path, hiddenLines: count.value,
        ...((args.offset !== undefined || args.limit !== undefined) ? {
          range: `:${args.offset ?? 1}${args.limit === undefined ? "" : `-${(args.offset ?? 1) + args.limit - 1}`}`,
        } : {}),
      },
    } : count;
  }
  if (args.content === undefined || text !== `Successfully wrote ${args.content.length} bytes to ${args.path}`) return { kind: "malformed" };
  const count = detachedDisplayLineCount(args.content);
  return count.kind === "complete" ? { kind: "complete", value: { kind: "file", path: args.path, hiddenLines: count.value } } : count;
}

function multiEditOrdinary(value: MultiEditSuccess): Snapshot<MutationOrdinarySnapshot> {
  if (value.kind !== "displayable") return { kind: "malformed" };
  if (value.diff.length === 0) return { kind: "complete", value: {
    kind: "mutation", path: value.path, editCount: value.editCount, noNet: true,
  } };
  const count = logicalLineCount(value.diff);
  return count.kind === "complete" ? { kind: "complete", value: {
    kind: "mutation", path: value.path, editCount: value.editCount, diffLines: count.value, noNet: false,
  } } : count;
}

function recognizedEditNoNet(
  args: EditArgsSnapshot,
  result: unknown,
  options: unknown,
  context: unknown,
): boolean {
  if (ownBoolean(options, "isPartial") !== false || ownBoolean(context, "isPartial") !== false ||
    ownBoolean(context, "isError") !== false) return false;
  const envelope = resultEnvelope(result);
  const details = envelope && exact(envelope.details, ["diff", "patch", "firstChangedLine"]);
  const blocks = envelope && contentBlocks(envelope.content);
  return Boolean(envelope && (!("isError" in envelope) || envelope.isError === false) && details &&
    blocks?.length === 1 &&
    textBlock(blocks[0]) === `Successfully replaced ${args.editCount} block(s) in ${args.path}.` &&
    details.diff === "" && details.patch === "" && details.firstChangedLine === undefined);
}

function recognizedContent(value: unknown): boolean {
  const blocks = contentBlocks(value);
  if (!blocks || blocks.length === 0) return false;
  for (const block of blocks) {
    const text = exact(block, ["type", "text"]);
    if (text && text.type === "text" && typeof text.text === "string") continue;
    const image = exact(block, ["type", "data", "mimeType"]);
    if (!image || image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string") return false;
  }
  return true;
}
function recognizedReadDetails(value: unknown): boolean {
  if (value === undefined) return true;
  for (const key of ["binary", "notebookError", "truncated"] as const) {
    const detail = exact(value, [key]);
    if (detail && typeof detail[key] === "boolean") return true;
  }
  const details = exact(value, ["truncation"]);
  const truncation = details && exact(details.truncation, [
    "content", "truncated", "truncatedBy", "totalLines", "totalBytes", "outputLines", "outputBytes",
    "lastLinePartial", "firstLineExceedsLimit", "maxLines", "maxBytes",
  ]);
  if (!truncation || typeof truncation.content !== "string" || typeof truncation.truncated !== "boolean" ||
    !["lines", "bytes", null].includes(truncation.truncatedBy as never) ||
    typeof truncation.lastLinePartial !== "boolean" || typeof truncation.firstLineExceedsLimit !== "boolean") return false;
  return ["totalLines", "totalBytes", "outputLines", "outputBytes", "maxLines", "maxBytes"]
    .every((key) => Number.isSafeInteger(truncation[key]) && (truncation[key] as number) >= 0);
}
function recognizedBashDetails(value: unknown): boolean {
  if (value === undefined) return true;
  const details = oneExact(value, [["truncation"], ["fullOutputPath"], ["truncation", "fullOutputPath"]]);
  if (!details) return false;
  if (details.fullOutputPath !== undefined && typeof details.fullOutputPath !== "string") return false;
  return recognizedReadDetails(details.truncation === undefined ? undefined : { truncation: details.truncation });
}
function delegable(toolName: ToolName, args: ArgsSnapshot, result: unknown): { args: Data; result: Data } | undefined {
  const envelope = resultEnvelope(result);
  if (!envelope || !recognizedContent(envelope.content) ||
    (toolName === "write" ? envelope.details !== undefined
      : toolName === "bash" ? !recognizedBashDetails(envelope.details) : !recognizedReadDetails(envelope.details))) return undefined;
  let rawArgs: Data;
  if (toolName === "bash") {
    if (!("command" in args)) return undefined;
    rawArgs = { command: args.command, ...(args.timeout !== undefined ? { timeout: args.timeout } : {}) };
  } else if (toolName === "write") {
    if (!("path" in args)) return undefined;
    rawArgs = { path: args.path, content: args.content };
  } else {
    if (!("path" in args)) return undefined;
    rawArgs = { path: args.path, ...(args.offset !== undefined ? { offset: args.offset } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}) };
  }
  return { args: sanitizeArgsDto(rawArgs) as Data, result: sanitizeDto(result) as Data };
}
function failure(snapshotResult: Snapshot): string {
  return snapshotResult.kind === "capped"
    ? `Detail inspection limit reached (${snapshotResult.budget}); remaining detail uninspected`
    : "Unfamiliar result";
}
function editTarget(value: unknown): string | undefined {
  const data = exact(value, ["path", "edits"]);
  const path = data && ownData(data, "path");
  if (typeof path !== "string") return undefined;
  const safe = sanitize(path, MAX_PATH_CHARS, true);
  return safe || undefined;
}
function editOversizedStatus(target: string | undefined): string {
  return target ? `Edit · edit details too large; details uninspected · target ${target}`
    : "Edit · edit details too large; target and details uninspected";
}
function argsFailure(snapshotResult: Snapshot): string {
  if (snapshotResult.kind === "capped") return failure(snapshotResult);
  if (snapshotResult.kind === "complete") {
    const data = record(snapshotResult.value);
    if ((typeof data?.path === "string" && data.path.length > MAX_PATH_CHARS) ||
      (typeof data?.content === "string" && data.content.length > MAX_TEXT_CHARS)) {
      return failure({ kind: "capped", budget: "characters" });
    }
  }
  return "Unfamiliar arguments";
}

function nativeContext(context: unknown, args: Data, lastComponent: Component | undefined, expanded: boolean): Data {
  const state = ownData(context, "state");
  return {
    args, toolCallId: typeof ownData(context, "toolCallId") === "string" ? ownData(context, "toolCallId") : "display",
    invalidate: typeof ownData(context, "invalidate") === "function" ? ownData(context, "invalidate") : () => {},
    lastComponent, state: state && typeof state === "object" ? state : {},
    cwd: typeof ownData(context, "cwd") === "string" ? sanitize(ownData(context, "cwd") as string, MAX_PATH_CHARS, true) : "",
    executionStarted: ownBoolean(context, "executionStarted") === true,
    argsComplete: ownBoolean(context, "argsComplete") === true,
    isPartial: ownBoolean(context, "isPartial"),
    expanded, showImages: ownBoolean(context, "showImages") === true,
    isError: ownBoolean(context, "isError"),
  };
}
function summaryComponent(toolName: ToolName, snapshotValue: OrdinarySnapshot, hint: string, theme: unknown): Component {
  const identity = toolName === "read" ? "Read" : toolName === "write" ? "Write"
    : toolName === "edit" ? "Edit" : toolName === "MultiEdit" ? "MultiEdit" : "Bash";
  if (snapshotValue.kind === "bash") {
    const output = snapshotValue.outputLines === 0 ? "(no output)"
      : `${snapshotValue.outputLines} output ${snapshotValue.outputLines === 1 ? "line" : "lines"} hidden`;
    const outputFallback = snapshotValue.outputLines === 0 ? output : "output hidden";
    const expansion = `${hint} to expand`;
    const command = `${snapshotValue.commandLines} command ${snapshotValue.commandLines === 1 ? "line" : "lines"} hidden`;
    return { render(width: number): string[] {
      if (!Number.isFinite(width) || width <= 0) return [""];
      const columns = Math.floor(width);
      let line = clamp(safeTheme(theme, "fg", ["toolTitle", safeTheme(theme, "bold", [identity], identity)], identity), columns);
      const append = (text: string, slot: "dim" | "muted"): boolean => {
        const segment = safeTheme(theme, "fg", [slot, ` · ${text}`], ` · ${text}`);
        try {
          if (visibleWidth(line + segment) > columns) return false;
          line += segment;
          return true;
        } catch { return false; }
      };
      if (!append(output, "muted") && (outputFallback === output || !append(outputFallback, "muted"))) return [clamp(line, columns)];
      if (!append(expansion, "dim")) return [clamp(line, columns)];
      if (snapshotValue.duration !== undefined && !append(snapshotValue.duration, "muted")) return [clamp(line, columns)];
      append(command, "muted");
      return [clamp(line, columns)];
    } };
  }
  const path = sanitize(snapshotValue.path, MAX_PATH_CHARS, true);
  const range = sanitize(snapshotValue.kind === "file" ? snapshotValue.range ?? "" : "", MAX_PATH_CHARS, true);
  const count = snapshotValue.kind === "mutation"
    ? `${snapshotValue.editCount} ${snapshotValue.editCount === 1 ? "edit" : "edits"} applied · ${snapshotValue.noNet
      ? "no net change"
      : `${snapshotValue.diffLines} diff ${snapshotValue.diffLines === 1 ? "line" : "lines"} hidden`}`
    : `${snapshotValue.hiddenLines} ${snapshotValue.hiddenLines === 1 ? "line" : "lines"} hidden`;
  return { render(width: number): string[] {
    if (!Number.isFinite(width) || width <= 0) return [""];
    const columns = Math.floor(width);
    const title = safeTheme(theme, "fg", ["toolTitle", safeTheme(theme, "bold", [identity], identity)], identity);
    const fullStatus = safeTheme(theme, "fg", ["muted", ` · ${count}`], ` · ${count}`);
    const compactMutationStatus = snapshotValue.kind === "mutation"
      ? safeTheme(theme, "fg", ["muted", ` · ${snapshotValue.noNet ? "no net change" : "diff hidden"}`],
        ` · ${snapshotValue.noNet ? "no net change" : "diff hidden"}`)
      : undefined;
    const expansion = safeTheme(theme, "fg", ["dim", ` · ${hint} to expand`], ` · ${hint} to expand`);
    let line = clamp(title, columns);
    try {
      const identityWidth = visibleWidth(line);
      const available = Math.max(0, columns - identityWidth - 1);
      const fullStatusWidth = visibleWidth(fullStatus);
      const compactStatusWidth = compactMutationStatus === undefined ? Number.POSITIVE_INFINITY : visibleWidth(compactMutationStatus);
      const status = snapshotValue.kind === "mutation"
        ? (available >= fullStatusWidth + 2 ? fullStatus
          : available >= compactStatusWidth ? compactMutationStatus : undefined)
        : fullStatus;
      const statusWidth = status === undefined ? 0 : visibleWidth(status);
      const reserveStatus = snapshotValue.kind === "mutation"
        ? status !== undefined
        : available >= statusWidth + 2;
      const targetRoom = Math.max(0, available - (reserveStatus ? statusWidth : 0));
      if (targetRoom > 0) {
        const rangeWidth = visibleWidth(range);
        let targetText: string;
        if (range && rangeWidth <= targetRoom) {
          const pathRoom = targetRoom - rangeWidth;
          const pathText = pathRoom > 0
            ? (visibleWidth(path) > pathRoom ? truncateToWidth(path, pathRoom, "…") : path)
            : "";
          targetText = pathText + range;
        } else {
          targetText = visibleWidth(path) > targetRoom ? truncateToWidth(path, targetRoom, "…") : path;
        }
        const target = safeTheme(theme, "fg", ["accent", targetText], targetText);
        line += ` ${target}`;
      }
      if (status !== undefined && visibleWidth(line + status) <= columns) line += status;
      if (visibleWidth(line + expansion) <= columns) line += expansion;
    } catch { return [clamp(line, columns)]; }
    return [clamp(line, columns)];
  } };
}
function statusComponent(text: string, theme: unknown): Component {
  const safe = sanitize(text, 512, true) || "Unfamiliar result";
  return { render: (width) => [clamp(safeTheme(theme, "fg", ["warning", safe], safe), width)] };
}
function emptyComponent(): Component { return { render: () => [] }; }
function combined(components: readonly Component[], theme: unknown): Component {
  return { render(width: number): string[] {
    const lines: string[] = [];
    try {
      for (const component of components) {
        const rendered = component.render(width);
        if (safeIsArray(rendered) !== true) throw new TypeError("renderer returned non-lines");
        for (let index = 0; index < rendered.length; index++) {
          if (lines.length >= MAX_RENDERED_LINES) {
            lines.push(clamp("Detail inspection limit reached (rendered lines); remaining detail omitted", width));
            return lines;
          }
          const line = ownData(rendered, String(index));
          lines.push(clamp(typeof line === "string" ? line : "Renderer failed", width));
        }
      }
      return lines;
    } catch { return statusComponent("Renderer failed", theme).render(width); }
  } };
}

/** Decorate recognized main-session tools with a fail-open settled collapse lifecycle. */
export function withDefaultCollapsedToolRendering<T extends ToolDefinition>(tool: T): T {
  let descriptors: PropertyDescriptorMap;
  try {
    const name = Object.getOwnPropertyDescriptor(tool, "name");
    const call = Object.getOwnPropertyDescriptor(tool, "renderCall");
    const result = Object.getOwnPropertyDescriptor(tool, "renderResult");
    if (!name || !("value" in name) || (name.value !== "read" && name.value !== "write" && name.value !== "bash" &&
      name.value !== "edit" && name.value !== "MultiEdit") ||
      !call || !("value" in call) || typeof call.value !== "function" ||
      !result || !("value" in result) || typeof result.value !== "function") return tool;
    descriptors = Object.getOwnPropertyDescriptors(tool);
  } catch { return tool; }
  const toolName = (descriptors.name as PropertyDescriptor & { value: ToolName }).value;
  const nativeCall = (descriptors.renderCall as PropertyDescriptor & { value: NativeCall }).value;
  const nativeResult = (descriptors.renderResult as PropertyDescriptor & { value: NativeResult }).value;
  delete descriptors.renderCall;
  delete descriptors.renderResult;
  let decorated: T;
  try { decorated = Object.defineProperties({}, descriptors) as T; } catch { return tool; }

  function finalizeBash(
    lifecycle: Lifecycle,
    args: Data | undefined,
    result: Data | undefined,
    expanded: boolean,
    theme: unknown,
    context: unknown,
  ): { component?: Component; failed: boolean } {
    const displayArgs = args ?? lifecycle.nativeArgs ?? { command: "" };
    try {
      const component = nativeResult(
        result ?? { content: [], details: undefined },
        { expanded, isPartial: false },
        theme,
        nativeContext(context, displayArgs, lifecycle.nativeResult, expanded),
      );
      lifecycle.nativeResult = component;
      return { component, failed: false };
    } catch { return { failed: true }; }
  }
  function cleanupFailed(primary: string, theme: unknown): Component {
    return statusComponent(`${primary} · Native cleanup failed`, theme);
  }

  Object.defineProperties(decorated, {
    renderCall: { configurable: true, enumerable: true, writable: true, value(argsValue: unknown, theme: unknown, context: unknown): Component {
      const lifecycle = lifecycleFor(context);
      const settled = ownBoolean(context, "isPartial") === false;
      if (toolName === "MultiEdit") {
        if (!lifecycle) {
          try { return nativeCall(argsValue, theme, context); }
          catch { return statusComponent("Renderer failed", theme); }
        }
        const hint = keyHint();
        const forceExpanded = settled && !hint;
        try {
          const component = nativeCall(argsValue, theme,
            nativeContext(context, record(argsValue) ?? {}, lifecycle.nativeCall,
              forceExpanded || ownBoolean(context, "expanded") === true));
          lifecycle.nativeCall = component;
          if (settled) lifecycle.settledObserved = true;
          return settled && hint ? emptyComponent() : component;
        } catch { return statusComponent("Renderer failed", theme); }
      }
      const argsInspection = toolName === "edit" ? inspectEdit(argsValue) : inspect(argsValue);
      const args = argsInspection.kind === "complete" ? argsFrom(argsInspection.value, toolName) : undefined;
      const displayable = argsInspection.kind === "complete" && record(argsInspection.value);
      const rawEditPath = toolName === "edit" ? ownData(exact(argsValue, ["path", "edits"]), "path") : undefined;
      if (toolName === "edit" && (argsInspection.kind === "capped" ||
        (typeof rawEditPath === "string" && rawEditPath.length > MAX_PATH_CHARS))) {
        const target = editTarget(argsValue);
        if (lifecycle) {
          lifecycle.editOversized = true;
          lifecycle.editOversizedTarget = target;
        }
        return statusComponent(editOversizedStatus(target), theme);
      }
      if (!lifecycle || !displayable || (settled && !args)) return statusComponent(argsFailure(argsInspection), theme);
      const hint = keyHint();
      const forceExpanded = settled && !hint;
      const dto = sanitizeArgsDto(argsInspection.value) as Data;
      try {
        const component = nativeCall(dto, theme, nativeContext(context, dto, lifecycle.nativeCall, forceExpanded || ownBoolean(context, "expanded") === true));
        lifecycle.nativeCall = component;
        if (toolName === "edit") {
          const previewError = adaptedEditPreviewError(component);
          if (previewError !== undefined) lifecycle.editPreviewError = sanitize(previewError, 512, true) || "unknown preview error";
        }
        if (toolName === "bash") lifecycle.nativeArgs = dto;
        if (settled) lifecycle.settledObserved = true;
        return settled && hint ? emptyComponent() : component;
      } catch { return statusComponent("Renderer failed", theme); }
    } },
    renderResult: { configurable: true, enumerable: true, writable: true, value(resultValue: unknown, options: unknown, theme: unknown, context: unknown): Component {
      const lifecycle = lifecycleFor(context);
      const expanded = ownBoolean(options, "expanded") === true;
      if (!lifecycle) {
        if (toolName === "edit" || toolName === "MultiEdit") {
          try { return nativeResult(resultValue, options, theme, context); }
          catch { return statusComponent("Renderer failed", theme); }
        }
        return statusComponent(argsFailure(inspect(ownData(context, "args"))), theme);
      }

      if (toolName === "MultiEdit") {
        const hint = keyHint();
        const owned = lifecycle.settledObserved && Boolean(hint);
        const forceExpanded = !hint;
        let resultComponent: Component;
        try {
          resultComponent = nativeResult(resultValue, {
            expanded: forceExpanded || expanded,
            isPartial: ownBoolean(options, "isPartial"),
          }, theme, nativeContext(
            context,
            record(ownData(context, "args")) ?? {},
            lifecycle.nativeResult,
            forceExpanded || expanded,
          ));
          lifecycle.nativeResult = resultComponent;
        } catch { return statusComponent("Renderer failed", theme); }
        if (!owned) return resultComponent;
        if (!lifecycle.nativeCall) return statusComponent("Unfamiliar result", theme);
        const recognized = adaptedMultiEditSnapshot(resultComponent);
        const ordinaryMutation = recognized ? multiEditOrdinary(recognized) : { kind: "malformed" } as const;
        if (ordinaryMutation.kind === "capped") return statusComponent(failure(ordinaryMutation), theme);
        if (ordinaryMutation.kind === "complete" && !expanded) {
          return summaryComponent(toolName, ordinaryMutation.value, hint as string, theme);
        }
        if (ordinaryMutation.kind === "complete") return combined([lifecycle.nativeCall, resultComponent], theme);
        return combined([statusComponent("Elaborated result", theme), lifecycle.nativeCall, resultComponent], theme);
      }

      const argsInspection = toolName === "edit" ? inspectEdit(ownData(context, "args")) : inspect(ownData(context, "args"));
      const resultInspection = toolName === "edit" ? inspectEdit(resultValue) : inspect(resultValue);
      const args = argsInspection.kind === "complete" ? argsFrom(argsInspection.value, toolName) : undefined;

      if (toolName === "edit") {
        if (argsInspection.kind === "capped" || lifecycle.editOversized) {
          return statusComponent(editOversizedStatus(lifecycle.editOversizedTarget ?? editTarget(ownData(context, "args"))), theme);
        }
        if (!args || !("editCount" in args) || !("path" in args) || argsInspection.kind !== "complete") {
          return statusComponent(argsFailure(argsInspection), theme);
        }
        const editArgs = args as EditArgsSnapshot;
        if (resultInspection.kind === "capped") {
          return statusComponent(editOversizedStatus(editArgs.path), theme);
        }
        if (resultInspection.kind !== "complete") return statusComponent(failure(resultInspection), theme);
        const resultRecord = record(resultInspection.value);
        if (!resultRecord) return statusComponent("Unfamiliar result", theme);
        const hint = keyHint();
        const owned = lifecycle.settledObserved && Boolean(hint);
        const forceExpanded = !hint;
        const settled = ownBoolean(options, "isPartial") === false && ownBoolean(context, "isPartial") === false;
        const displayArgs = sanitizeArgsDto(argsInspection.value) as Data;
        const displayResult = sanitizeDto(resultRecord) as Data;
        const currentPreviewError = adaptedEditPreviewError(lifecycle.nativeCall);
        if (currentPreviewError !== undefined) {
          lifecycle.editPreviewError = sanitize(currentPreviewError, 512, true) || "unknown preview error";
        }
        let resultComponent: Component;
        try {
          resultComponent = nativeResult(displayResult, { expanded: forceExpanded || expanded, isPartial: !settled }, theme,
            nativeContext(context, displayArgs, lifecycle.nativeResult, forceExpanded || expanded));
          lifecycle.nativeResult = resultComponent;
        } catch { return statusComponent("Renderer failed", theme); }
        if (!owned) return resultComponent;
        if (!lifecycle.nativeCall) return statusComponent("Unfamiliar result", theme);
        let ordinaryMutation: Snapshot<MutationOrdinarySnapshot> = { kind: "malformed" };
        if (settled && ownBoolean(context, "isError") === false && lifecycle.editPreviewError === undefined) {
          const changed = ordinary("edit", editArgs, resultInspection.value, context) as Snapshot<MutationOrdinarySnapshot>;
          ordinaryMutation = changed.kind !== "malformed" ? changed
            : recognizedEditNoNet(editArgs, resultInspection.value, options, context)
              ? { kind: "complete", value: {
                kind: "mutation", path: editArgs.path, editCount: editArgs.editCount, noNet: true,
              } }
              : changed;
        }
        if (ordinaryMutation.kind === "capped") return statusComponent(failure(ordinaryMutation), theme);
        if (ordinaryMutation.kind === "complete" && !expanded) {
          return summaryComponent(toolName, ordinaryMutation.value, hint as string, theme);
        }
        if (ordinaryMutation.kind === "complete") return combined([lifecycle.nativeCall, resultComponent], theme);
        const status = lifecycle.editPreviewError === undefined
          ? "Elaborated result"
          : `Edit preview failed: ${lifecycle.editPreviewError} · settled result elaborated`;
        return combined([statusComponent(status, theme), lifecycle.nativeCall, resultComponent], theme);
      }

      if (toolName !== "bash") {
        if (!args || argsInspection.kind !== "complete") return statusComponent(argsFailure(argsInspection), theme);
        if (resultInspection.kind !== "complete") return statusComponent(failure(resultInspection), theme);
        const safe = delegable(toolName, args, resultInspection.value);
        if (!safe) return statusComponent("Unfamiliar result", theme);
        const optionsPartial = ownBoolean(options, "isPartial");
        const contextPartial = ownBoolean(context, "isPartial");
        if (optionsPartial === true || contextPartial === true) {
          try {
            const component = nativeResult(safe.result, { expanded, isPartial: true }, theme,
              nativeContext(context, safe.args, lifecycle.nativeResult, expanded));
            lifecycle.nativeResult = component;
            return component;
          } catch { return statusComponent("Renderer failed", theme); }
        }
        const hint = keyHint();
        const settledAgreement = optionsPartial === false && contextPartial === false &&
          ownBoolean(context, "isError") === false;
        const owned = lifecycle.settledObserved && Boolean(hint);
        const isOrdinary = settledAgreement
          ? ordinary(toolName, args, resultInspection.value, context) : { kind: "malformed" } as const;
        if (isOrdinary.kind === "capped") return statusComponent(failure(isOrdinary), theme);
        if (owned && isOrdinary.kind === "complete" && !expanded) {
          return summaryComponent(toolName, isOrdinary.value, hint as string, theme);
        }
        const forceExpanded = !hint || !settledAgreement;
        try {
          let callComponent = lifecycle.nativeCall;
          if (owned && forceExpanded) {
            callComponent = nativeCall(safe.args, theme,
              nativeContext(context, safe.args, lifecycle.nativeCall, true));
            lifecycle.nativeCall = callComponent;
          }
          const resultComponent = nativeResult(
            safe.result,
            { expanded: forceExpanded || expanded, isPartial: false },
            theme,
            nativeContext(context, safe.args, lifecycle.nativeResult, forceExpanded || expanded),
          );
          lifecycle.nativeResult = resultComponent;
          if (!owned) return resultComponent;
          if (!callComponent) return statusComponent("Unfamiliar result", theme);
          if (settledAgreement && isOrdinary.kind === "malformed") {
            return combined([statusComponent("Elaborated result", theme), callComponent, resultComponent], theme);
          }
          return combined([callComponent, resultComponent], theme);
        } catch { return statusComponent("Renderer failed", theme); }
      }

      const optionsFinal = ownBoolean(options, "isPartial") === false;
      const contextFinal = ownBoolean(context, "isPartial") === false;
      const contextError = ownBoolean(context, "isError") === true;
      const nativeFinal = optionsFinal || contextFinal || contextError;
      const compactContext = optionsFinal && contextFinal && ownBoolean(context, "isError") === false;
      if (!optionsFinal && !nativeFinal) {
        if (!args || argsInspection.kind !== "complete") return statusComponent(argsFailure(argsInspection), theme);
        if (resultInspection.kind !== "complete") return statusComponent(failure(resultInspection), theme);
        const resultRecord = record(resultInspection.value);
        if (!resultRecord) return statusComponent("Unfamiliar result", theme);
        const displayArgs = sanitizeArgsDto(argsInspection.value) as Data;
        const displayResult = sanitizeDto(resultRecord) as Data;
        try {
          const component = nativeResult(displayResult, { expanded, isPartial: true }, theme,
            nativeContext(context, displayArgs, lifecycle.nativeResult, expanded));
          lifecycle.nativeResult = component;
          return component;
        } catch { return statusComponent("Renderer failed", theme); }
      }

      const displayArgs = argsInspection.kind === "complete" && record(argsInspection.value)
        ? sanitizeArgsDto(argsInspection.value) : undefined;
      const inspectedResult = resultInspection.kind === "complete" ? resultInspection.value : undefined;
      const safe = args && resultInspection.kind === "complete" ? delegable(toolName, args, inspectedResult) : undefined;
      const hint = keyHint();
      const owned = lifecycle.settledObserved && Boolean(hint);
      const forceExpanded = !hint;
      const classificationArgs = safe ? argsFrom(safe.args, "bash") : undefined;
      let isOrdinary: Snapshot<OrdinarySnapshot> = compactContext && classificationArgs && resultInspection.kind === "complete"
        ? ordinary("bash", classificationArgs, inspectedResult, context)
        : { kind: "malformed" };
      let primary: string | undefined;
      if (!args || argsInspection.kind !== "complete") primary = argsFailure(argsInspection);
      else if (resultInspection.kind !== "complete") primary = failure(resultInspection);
      else if (!safe) primary = "Unfamiliar result";
      else if (!compactContext || isOrdinary.kind === "malformed") primary = "Elaborated result";
      else if (isOrdinary.kind === "capped") primary = failure(isOrdinary);

      let resultComponent: Component | undefined;
      if (toolName === "bash" && nativeFinal) {
        const finalized = finalizeBash(
          lifecycle,
          safe?.args ?? displayArgs,
          safe?.result,
          forceExpanded || expanded,
          theme,
          context,
        );
        if (finalized.failed) return cleanupFailed(primary ?? "Renderer failed", theme);
        resultComponent = finalized.component;
        if (!primary && compactContext && classificationArgs && resultInspection.kind === "complete") {
          isOrdinary = ordinary("bash", classificationArgs, inspectedResult, context);
        }
      }
      if (primary && primary !== "Elaborated result") return statusComponent(primary, theme);
      if (primary === "Elaborated result" && toolName === "bash") {
        if (hint && lifecycle.nativeCall && resultComponent) {
          return combined([statusComponent(primary, theme), lifecycle.nativeCall, resultComponent], theme);
        }
        return resultComponent ?? statusComponent(primary, theme);
      }
      if (!safe) return statusComponent("Unfamiliar result", theme);
      if (owned && isOrdinary.kind === "complete" && !expanded) {
        return summaryComponent(toolName, isOrdinary.value, hint as string, theme);
      }
      try {
        const visibleResult = resultComponent ?? nativeResult(
          safe.result,
          { expanded: forceExpanded || expanded, isPartial: false },
          theme,
          nativeContext(context, safe.args, lifecycle.nativeResult, forceExpanded || expanded),
        );
        lifecycle.nativeResult = visibleResult;
        if (!owned) return visibleResult;
        if (!lifecycle.nativeCall) return statusComponent("Unfamiliar result", theme);
        if (isOrdinary.kind === "complete") return combined([lifecycle.nativeCall, visibleResult], theme);
        return combined([statusComponent("Elaborated result", theme), lifecycle.nativeCall, visibleResult], theme);
      } catch { return statusComponent("Renderer failed", theme); }
    } },
  });
  return decorated;
}

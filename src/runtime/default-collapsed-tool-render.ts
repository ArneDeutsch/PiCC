import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  adaptedEditPreviewError,
  recognizeMultiEditSuccess,
  type MultiEditSnapshot,
} from "./routine-tool-render.js";
import {
  priorityDisplayRow,
  formatDisplayPathFromRoots,
  formatToolDisplayName,
  resolveDisplayRoots,
  sanitizeInlineDisplay,
  type DisplayRootResolver,
  type DisplayRoots,
} from "./tool-display.js";
import { piToolsExpandKeyText } from "./pi-tui-runtime.js";
import { sanitizeDisplayText, themedFg } from "./render-util.js";
import { setToolRowOutcome } from "./tool-shell.js";

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
  displayRoots?: DisplayRoots;
  displayRootsResolved?: boolean;
  displayPath?: string;
  settledCall: boolean;
}

interface CallOwnedLifecycle {
  args?: Data;
  callSlot?: MutableCallSlot;
  nativeCall?: Component;
  nativeResult?: Component;
  callExpanded?: boolean;
  callFailed?: boolean;
  displayRoots?: DisplayRoots;
  displayPath?: string;
  rootsResolved: boolean;
  ordinary?: boolean;
  malformedArgs?: boolean;
  resultFallback?: string;
}

interface MutableCallSlot extends Component {
  concise(fields: CallOwnedFields): void;
  native(component: Component): void;
  warn(message: string): void;
}

interface CallOwnedFields {
  tool: "read" | "bash";
  primary: string;
  suffix: string;
}

interface FileSummary { kind: "file"; path: string; lines: number }
interface ReadContinuation { remaining: number; nextOffset: number }
interface MutationSummary { kind: "mutation"; path: string; edits: number; diffLines?: number; noNet: boolean }
type Summary = FileSummary | MutationSummary;

const MAX_PATH = 16_384;
const MAX_TEXT = 1_000_000;
const MAX_ARRAY = 1_000;

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

const sanitize = sanitizeDisplayText;

function displayArgs(toolName: ToolName, value: unknown): Data | undefined {
  if (toolName === "read") {
    const args = data(value);
    if (!args || !Object.keys(args).every((key) => ["path", "offset", "limit"].includes(key)) ||
      typeof args.path !== "string" || args.path.length > MAX_PATH) return undefined;
    for (const key of ["offset", "limit"] as const) {
      if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || (args[key] as number) < 1)) return undefined;
    }
    if (typeof args.offset === "number" && typeof args.limit === "number" &&
      args.offset > Number.MAX_SAFE_INTEGER - (args.limit - 1)) return undefined;
    return { path: sanitizeInlineDisplay(args.path, MAX_PATH), ...(args.offset === undefined ? {} : { offset: args.offset }),
      ...(args.limit === undefined ? {} : { limit: args.limit }) };
  }
  if (toolName === "write") {
    const args = exact(value, ["path", "content"]);
    return args && typeof args.path === "string" && args.path.length <= MAX_PATH &&
      typeof args.content === "string" && args.content.length <= MAX_TEXT
      ? { path: sanitizeInlineDisplay(args.path, MAX_PATH), content: sanitize(args.content, MAX_TEXT) }
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
    return { path: sanitizeInlineDisplay(args.path, MAX_PATH), edits };
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
  return { file_path: sanitizeInlineDisplay(args.file_path, MAX_PATH), edits };
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
  const copyPath = (key: string): boolean => {
    if (!(key in source)) return true;
    const field = source[key];
    if (typeof field !== "string" || field.length > MAX_PATH) return false;
    result[key] = sanitizeInlineDisplay(field, MAX_PATH);
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
    return copyPath("path") && copyNumber("offset") && copyNumber("limit") ? result : undefined;
  }
  if (toolName === "write") {
    return copyPath("path") && copyString("content", MAX_TEXT) ? result : undefined;
  }
  if (toolName === "bash") {
    return copyString("command", MAX_TEXT) && copyNumber("timeout") ? result : undefined;
  }
  if (toolName === "edit") {
    return copyPath("path") && copyEdits("edits", "oldText", "newText") ? result : undefined;
  }
  return copyPath("file_path") && copyEdits("edits", "old_string", "new_string") ? result : undefined;
}

function displayContent(
  value: unknown,
  operations: DisplayOperationAuthority = DEFAULT_DISPLAY_OPERATIONS,
): Array<Data> | undefined {
  if (!Array.isArray(value) || value.length > MAX_ARRAY) return undefined;
  const blocks: Data[] = [];
  for (const blockValue of value) {
    const block = data(blockValue);
    if (block?.type === "text" && typeof block.text === "string" && block.text.length <= MAX_TEXT) {
      blocks.push({ type: "text", text: operations.sanitize(block.text, MAX_TEXT) });
    } else if (block?.type === "image" && typeof block.data === "string" &&
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
    if (typeof field === "string") result[key] = key.toLowerCase().includes("path")
      ? sanitizeInlineDisplay(field, MAX_PATH)
      : sanitize(field, MAX_TEXT, key !== "diff" && key !== "patch" && key !== "content");
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

function displayResult(
  value: unknown,
  operations: DisplayOperationAuthority = DEFAULT_DISPLAY_OPERATIONS,
): Data | undefined {
  const source = data(value);
  const content = source && displayContent(source.content, operations);
  if (!source || !content || (source.isError !== undefined && typeof source.isError !== "boolean")) return undefined;
  const details = displayDetails(source.details);
  if (source.details !== undefined && details === undefined) return undefined;
  return { content, details, ...(source.isError === undefined ? {} : { isError: source.isError }) };
}

function lifecycle(cache: WeakMap<object, Lifecycle>, context: unknown): Lifecycle | undefined {
  const state = data(context)?.state;
  if (state === null || typeof state !== "object") return undefined;
  let current = cache.get(state);
  if (!current) {
    current = { settledCall: false };
    cache.set(state, current);
  }
  return current;
}

function nativeContext(context: unknown, args: Data, lastComponent: Component | undefined, expanded: boolean): Data {
  const source = data(context) ?? {};
  return { ...source, args, lastComponent, expanded };
}

function bindingHint(): string | undefined {
  const binding = piToolsExpandKeyText();
  return binding.available ? sanitize(binding.value, 512, true) || undefined : undefined;
}

function fileLineCount(value: string): number {
  const lines = sanitize(value, MAX_TEXT).split("\n");
  while (lines.at(-1) === "") lines.pop();
  return lines.length;
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

function readContinuationSummary(args: Data, result: unknown): ReadContinuation | undefined {
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
  return { remaining, nextOffset };
}

function recognize(toolName: "write" | "edit", args: Data, result: unknown): Summary | undefined {
  const envelope = data(result);
  if (!canonicalEnvelope(result) || !envelope || (envelope.isError !== undefined && envelope.isError !== false)) return undefined;
  const text = oneText(result);
  if (!text) return undefined;
  if (toolName === "write") {
    if (text.details !== undefined || text.text !== `Successfully wrote ${(args.content as string).length} bytes to ${args.path as string}`) return undefined;
    return { kind: "file", path: args.path as string, lines: fileLineCount(args.content as string) };
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
  displayRoots: DisplayRoots,
  snapshottedPath?: string,
): Component {
  const title = formatToolDisplayName(toolName);
  const path = snapshottedPath ?? sanitizeInlineDisplay(formatDisplayPathFromRoots(summary.path, displayRoots), MAX_PATH);
  if (summary.kind === "mutation") {
    const detail = summary.noNet ? "no net change" : `${summary.diffLines} diff ${summary.diffLines === 1 ? "line" : "lines"} hidden`;
    return priorityDisplayRow(title, path, [],
      [`${summary.edits} ${summary.edits === 1 ? "edit" : "edits"} applied`, detail], `${hint} to expand`, theme);
  }
  return priorityDisplayRow(title, path,
    [], [`${summary.lines} ${summary.lines === 1 ? "line" : "lines"} hidden`], `${hint} to expand`, theme);
}

function messageComponent(message: string, theme: unknown): Component {
  const safe = sanitize(message, 512, true);
  return { render: (width) => [clamp(themedFg(theme, "warning", safe), width)] };
}

function evidenceComponent(
  message: string,
  theme: unknown,
  operations: DisplayOperationAuthority = DEFAULT_DISPLAY_OPERATIONS,
): Component {
  const safe = operations.sanitize(message, EVIDENCE_PREFIX + EVIDENCE_TAIL + 8);
  const lines = operations.splitLines(safe);
  return {
    render: (width) => lines.map((line) => clamp(themedFg(theme, "warning", line), width)),
  };
}

function combined(components: readonly Component[], theme: unknown): Component {
  return { render(width: number): string[] {
    try { return components.flatMap((component) => component.render(width).map((line) => clamp(line, width))); }
    catch { return messageComponent("Renderer failed", theme).render(width); }
  } };
}

export interface DisplayOperationAuthority {
  slice(value: string, start: number, end?: number): string;
  sanitize(value: string, limit: number, inline?: boolean): string;
  splitLines(value: string): string[];
}

const DEFAULT_DISPLAY_OPERATIONS: DisplayOperationAuthority = {
  slice: (value, start, end) => value.slice(start, end),
  sanitize: sanitizeDisplayText,
  splitLines: (value) => value.split("\n"),
};

export interface DefaultCollapsedRenderingDependencies {
  resolveDisplayRoot?: DisplayRootResolver;
  repositoryRoot?: string;
  displayOperations?: DisplayOperationAuthority;
}

const EMPTY_COMPONENT: Component = Object.freeze({ render: () => [] });
const EVIDENCE_PREFIX = 512;
const EVIDENCE_TAIL = 1_024;

function conciseCallLines(fields: CallOwnedFields, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return [""];
  const columns = Math.floor(width);
  const prefix = fields.tool === "bash" ? "bash $ " : "read ";
  if (visibleWidth(prefix) >= columns) return [truncateToWidth(prefix, columns, "…")];
  const suffixWidth = visibleWidth(fields.suffix);
  const available = Math.max(1, columns - visibleWidth(prefix) - suffixWidth);
  const primary = visibleWidth(fields.primary) > available
    ? truncateToWidth(fields.primary, available, "…")
    : fields.primary;
  const line = `${prefix}${primary}${fields.suffix}`;
  return [visibleWidth(line) <= columns ? line : truncateToWidth(line, columns, "…")];
}

function mutableCallSlot(initial: CallOwnedFields): MutableCallSlot {
  let fields = initial;
  let delegate: Component | undefined;
  let warning: string | undefined;
  return {
    concise(next) { fields = next; delegate = undefined; warning = undefined; },
    native(component) { delegate = component; warning = undefined; },
    warn(message) { delegate = undefined; warning = sanitize(message, 512, true); },
    render(width) {
      if (warning !== undefined) return [clamp(warning, width)];
      if (delegate) return delegate.render(width).map((line) => clamp(line, width));
      return conciseCallLines(fields, width);
    },
  };
}

function readRange(args: Data): string {
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return "";
  if (offset === undefined) return `:1-${limit}`;
  if (limit === undefined) return `:${offset}`;
  return `:${offset}-${offset + limit - 1}`;
}

function commandIdentity(command: string): { primary: string; suffix: string } {
  const lines = command.split(/\r\n|\n|\r|\u2028|\u2029/gu)
    .map((line) => sanitize(line, MAX_TEXT, true))
    .filter((line) => line.length > 0);
  return { primary: lines[0] ?? "...", suffix: lines.length > 1 ? " [ …]" : "" };
}

function callOwnedFields(toolName: "read" | "bash", args: Data, displayPath?: string): CallOwnedFields {
  if (toolName === "read") {
    const path = typeof args.path === "string" ? args.path : "...";
    return { tool: "read", primary: displayPath ?? path, suffix: readRange(args) };
  }
  const command = commandIdentity(typeof args.command === "string" ? args.command : "...");
  const timeout = typeof args.timeout === "number" ? ` (timeout ${args.timeout}s)` : "";
  return { tool: "bash", primary: command.primary, suffix: `${command.suffix}${timeout}` };
}

const MAX_EVIDENCE_BLOCKS = 4;

type SupportedEnvelope = "text" | "image" | "mixed";

function supportedEnvelope(result: unknown): SupportedEnvelope | undefined {
  const envelope = data(result);
  const content = envelope?.content;
  if (!Array.isArray(content) || content.length > MAX_ARRAY || content.length === 0) return undefined;
  let texts = 0;
  let images = 0;
  let oversizedText = false;
  for (const value of content) {
    const block = data(value);
    if (block?.type === "text") {
      const text = block.text;
      if (typeof text !== "string") return undefined;
      if (text.length > MAX_TEXT) oversizedText = true;
      texts++;
    } else if (block?.type === "image" && typeof block.mimeType === "string" && block.mimeType.length <= 256) images++;
    else return undefined;
  }
  if (images > 0 && oversizedText) return undefined;
  return images === 0 ? "text" : texts === 0 ? "image" : "mixed";
}

function successfulReadImageEnvelope(
  result: unknown,
  operations: DisplayOperationAuthority,
): Data | undefined {
  const source = data(result);
  const kind = supportedEnvelope(result);
  if (!source || !canonicalEnvelope(result) || source.isError === true || (kind !== "image" && kind !== "mixed")) return undefined;
  const details = displayDetails(source.details);
  if (source.details !== undefined && details === undefined) return undefined;
  const content: Data[] = [];
  for (const value of source.content as unknown[]) {
    const block = data(value);
    if (block?.type === "text" && typeof block.text === "string" && block.text.length <= MAX_TEXT) {
      content.push({ type: "text", text: operations.sanitize(block.text, MAX_TEXT) });
      continue;
    }
    if (block?.type !== "image" || typeof block.mimeType !== "string" || block.mimeType.length > 256) return undefined;
    const imageData = block.data;
    if (typeof imageData !== "string") return undefined;
    content.push({ type: "image", data: imageData, mimeType: sanitize(block.mimeType, 256, true) });
  }
  return { content, details, ...(source.isError === undefined ? {} : { isError: source.isError }) };
}

function boundedText(result: unknown): string | undefined {
  const envelope = data(result);
  const content = envelope?.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = data(content[0]);
  return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

function boundedProbe(text: string, operations: DisplayOperationAuthority): string {
  if (text.length <= EVIDENCE_PREFIX + EVIDENCE_TAIL) return operations.slice(text, 0, text.length);
  return `${operations.slice(text, 0, EVIDENCE_PREFIX)}\n…\n${operations.slice(text, -EVIDENCE_TAIL)}`;
}

function exceptionalEvidence(
  result: unknown,
  fallback: string,
  operations: DisplayOperationAuthority,
): string {
  const content = data(result)?.content;
  if (!Array.isArray(content)) return fallback;
  const evidence: string[] = [];
  for (let index = 0; index < content.length && evidence.length < MAX_EVIDENCE_BLOCKS && index < MAX_ARRAY; index++) {
    const block = data(content[index]);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const safe = operations.sanitize(boundedProbe(block.text, operations), EVIDENCE_PREFIX + EVIDENCE_TAIL + 4);
    if (safe.trim().length > 0) evidence.push(safe);
  }
  return evidence.length > 0 ? evidence.join("\n") : fallback;
}

function recognizedStatus(
  toolName: "read" | "bash",
  result: unknown,
  operations: DisplayOperationAuthority,
): string | undefined {
  const content = data(result)?.content;
  if (!Array.isArray(content)) return undefined;
  for (let index = 0; index < content.length && index < MAX_EVIDENCE_BLOCKS; index++) {
    const block = data(content[index]);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const probe = operations.sanitize(boundedProbe(block.text, operations), EVIDENCE_PREFIX + EVIDENCE_TAIL + 4);
    if (toolName === "read") {
      const noOffsetContinuation = /(?:^|\n)(\[[1-9]\d* more lines in file\.\])$/u.exec(probe);
      if (noOffsetContinuation?.[1]) return noOffsetContinuation[1];
    }
    const pattern = toolName === "read"
      ? /(?:^|\n)(\[(?:Showing (?:lines|last) [^\]\n]+|Line \d+ is [^\]\n]+|\d+ more lines in file\. Use offset=\d+ to continue\.|PiCC clipped [^\]\n]+|Truncated:[^\]\n]+|First line exceeds[^\]\n]*)\]|(?:Read|Operation|Tool|Command)?\s*(?:failed|errored|aborted|cancelled)[^\n]*)/iu
      : /(?:^|\n)((?:Command|Operation|Tool)?\s*(?:timed out|exited with (?:code|status)|failed|errored|aborted|cancelled)[^\n]*)/iu;
    const match = pattern.exec(probe);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function isUserAborted(status: string | undefined): boolean {
  return status !== undefined && /\b(?:aborted|cancelled)\b/iu.test(status);
}

function ordinaryCallOwnedResult(
  toolName: "read" | "bash",
  result: unknown,
  options: unknown,
  context: unknown,
  status?: string,
): boolean {
  if (booleanField(options, "isPartial") !== false || booleanField(context, "isPartial") !== false ||
    booleanField(context, "isError") !== false) return false;
  const envelope = data(result);
  if (!envelope) return false;
  const keys = Object.keys(envelope);
  if (!keys.every((key) => key === "content" || key === "details" || key === "isError") ||
    envelope.details !== undefined || envelope.isError === true) return false;
  const kind = supportedEnvelope(result);
  if (kind !== "text") return false;
  const text = boundedText(result);
  if (text === undefined) return false;
  if (toolName === "bash") return true;
  return status?.startsWith("[") !== true;
}

function collapsedExceptionalEvidence(
  toolName: "read" | "bash",
  args: Data,
  result: unknown,
  operations: DisplayOperationAuthority,
  status?: string,
): string {
  if (toolName === "read" && (boundedText(result)?.length ?? Infinity) <= EVIDENCE_PREFIX + EVIDENCE_TAIL) {
    const continuation = readContinuationSummary(args, result);
    if (continuation?.remaining !== undefined && continuation.nextOffset !== undefined) {
      return `${continuation.remaining} more lines · next offset ${continuation.nextOffset}`;
    }
  }
  return status ?? recognizedStatus(toolName, result, operations) ?? exceptionalEvidence(result, "Unfamiliar result", operations);
}

function withCallOwnedRendering<T extends ToolDefinition>(
  tool: T,
  dependencies: DefaultCollapsedRenderingDependencies,
  toolName: "read" | "bash",
): T {
  const nativeCall = tool.renderCall as NativeCall;
  const nativeResult = tool.renderResult as NativeResult;
  const operations = dependencies.displayOperations ?? DEFAULT_DISPLAY_OPERATIONS;
  const cache = new WeakMap<object, CallOwnedLifecycle>();
  const getLifecycle = (context: unknown): CallOwnedLifecycle | undefined => {
    const state = data(context)?.state;
    if (state === null || typeof state !== "object") return undefined;
    let current = cache.get(state);
    if (!current) {
      current = { rootsResolved: false };
      cache.set(state, current);
    }
    return current;
  };
  const decorated = { ...tool } as T;

  const setConcise = (current: CallOwnedLifecycle, args: Data): MutableCallSlot => {
    const fields = callOwnedFields(toolName, args, current.displayPath);
    current.callSlot ??= mutableCallSlot(fields);
    current.callSlot.concise(fields);
    current.callExpanded = false;
    current.callFailed = false;
    return current.callSlot;
  };
  const setNativeCall = (
    current: CallOwnedLifecycle,
    args: Data,
    theme: unknown,
    context: unknown,
  ): MutableCallSlot => {
    const slot = current.callSlot ??= mutableCallSlot(callOwnedFields(toolName, args, current.displayPath));
    try {
      current.nativeCall = nativeCall(args, theme, nativeContext(context, args, current.nativeCall, true));
      slot.native(current.nativeCall);
      current.callExpanded = true;
      current.callFailed = false;
    } catch {
      current.nativeCall = undefined;
      current.callExpanded = false;
      current.callFailed = true;
      slot.warn(toolName === "bash" ? "bash $ ..." : "read ...");
      setToolRowOutcome(context, "failure");
    }
    return slot;
  };

  decorated.renderCall = ((argsValue: unknown, theme: unknown, context: unknown): Component => {
    const current = getLifecycle(context);
    const settled = booleanField(context, "isPartial") === false;
    const args = settled ? displayArgs(toolName, argsValue) : liveDisplayArgs(toolName, argsValue);
    if (!current) {
      if (!args) return messageComponent(`${toolName} (unfamiliar arguments)`, theme);
      try { return nativeCall(args, theme, nativeContext(context, args, undefined, true)); }
      catch { return messageComponent(toolName === "bash" ? "bash $ ..." : "read ...", theme); }
    }
    if (!args) {
      current.malformedArgs = true;
      const slot = current.callSlot ??= mutableCallSlot(callOwnedFields(toolName, {}, undefined));
      slot.warn(`${toolName} (unfamiliar arguments)`);
      setToolRowOutcome(context, "failure");
      return slot;
    }
    current.malformedArgs = false;
    current.args = args;
    if (!current.rootsResolved && booleanField(context, "argsComplete") !== false) {
      current.displayRoots = resolveDisplayRoots(dependencies.resolveDisplayRoot, dependencies.repositoryRoot, context);
      const rawPath = data(argsValue)?.path;
      if (toolName === "read" && typeof rawPath === "string") {
        // Classify the validated invocation path before neutralizing its display representation.
        current.displayPath = sanitizeInlineDisplay(formatDisplayPathFromRoots(rawPath, current.displayRoots), MAX_PATH);
      }
      current.rootsResolved = true;
    }
    const expanded = booleanField(context, "expanded") === true || !bindingHint();
    if (expanded) return setNativeCall(current, args, theme, context);
    if (toolName === "bash") {
      try {
        current.nativeCall = nativeCall(args, theme, nativeContext(context, args, current.nativeCall, false));
        current.callFailed = false;
      } catch {
        current.nativeCall = undefined;
        current.callExpanded = false;
        current.callFailed = true;
        const slot = current.callSlot ??= mutableCallSlot(callOwnedFields(toolName, args, current.displayPath));
        slot.warn("bash $ ...");
        setToolRowOutcome(context, "failure");
        return slot;
      }
    }
    return setConcise(current, args);
  }) as T["renderCall"];

  decorated.renderResult = ((resultValue: unknown, options: unknown, theme: unknown, context: unknown): Component => {
    const current = getLifecycle(context);
    const partial = booleanField(options, "isPartial") === true || booleanField(context, "isPartial") === true;
    const args = current?.args ?? (partial
      ? liveDisplayArgs(toolName, data(context)?.args)
      : displayArgs(toolName, data(context)?.args));
    if (!args) {
      if (current?.malformedArgs) {
        setToolRowOutcome(context, "failure");
        return EMPTY_COMPONENT;
      }
      return messageComponent("Unfamiliar arguments", theme);
    }
    const requestedExpanded = booleanField(options, "expanded") === true || booleanField(context, "expanded") === true;
    const expanded = requestedExpanded || !bindingHint();
    if (!current) {
      try {
        return nativeResult(displayResult(resultValue, operations) ?? resultValue, { expanded: true, isPartial: partial }, theme,
          nativeContext(context, args, undefined, true));
      } catch { return messageComponent(exceptionalEvidence(resultValue, "Renderer failed", operations), theme); }
    }

    const malformedResult = supportedEnvelope(resultValue) === undefined && canonicalEnvelope(resultValue);
    if (malformedResult) {
      current.nativeResult = undefined;
      current.resultFallback = undefined;
      current.callExpanded = false;
      const slot = current.callSlot ??= mutableCallSlot(callOwnedFields(toolName, args, current.displayPath));
      slot.warn(`${toolName} (unfamiliar result)`);
      setToolRowOutcome(context, "failure");
      return EMPTY_COMPONENT;
    }

    if (expanded) {
      if (!current.callExpanded) setNativeCall(current, args, theme, context);
    } else if (!current.callFailed) setConcise(current, args);
    else setToolRowOutcome(context, "failure");

    let status = toolName === "read" || booleanField(context, "isError") === true
      ? recognizedStatus(toolName, resultValue, operations)
      : undefined;
    if (!partial) current.ordinary = ordinaryCallOwnedResult(toolName, resultValue, options, context, status);
    if (!current.ordinary && status === undefined) status = recognizedStatus(toolName, resultValue, operations);
    if (booleanField(context, "isError") === true && isUserAborted(status)) setToolRowOutcome(context, "stopped");
    const envelopeKind = supportedEnvelope(resultValue);
    const successfulImage = toolName === "read" && booleanField(context, "isError") === false &&
      (envelopeKind === "image" || envelopeKind === "mixed")
      ? successfulReadImageEnvelope(resultValue, operations)
      : undefined;
    if (toolName === "read" && (envelopeKind === "image" || envelopeKind === "mixed") && !successfulImage) {
      return evidenceComponent(status ?? recognizedStatus(toolName, resultValue, operations) ?? "Unfamiliar result", theme, operations);
    }
    if (expanded) {
      const safeResult = successfulImage ?? displayResult(resultValue, operations);
      if (!safeResult) return evidenceComponent(exceptionalEvidence(resultValue, "Unfamiliar result", operations), theme, operations);
      try {
        current.nativeResult = nativeResult(safeResult, { expanded: true, isPartial: partial }, theme,
          nativeContext(context, args, current.nativeResult, true));
        current.resultFallback = undefined;
        return current.nativeResult;
      } catch {
        current.nativeResult = undefined;
        current.resultFallback = status ?? exceptionalEvidence(resultValue, "Renderer failed", operations);
        return evidenceComponent(current.resultFallback, theme, operations);
      }
    }

    if (partial) {
      if (toolName === "bash") {
        try {
          current.nativeResult = nativeResult({ content: [], details: undefined },
            { expanded: false, isPartial: true }, theme,
            nativeContext(context, args, current.nativeResult, false));
        } catch {
          current.nativeResult = undefined;
          current.resultFallback = status ?? "Renderer failed";
          return evidenceComponent(current.resultFallback, theme, operations);
        }
      }
      return EMPTY_COMPONENT;
    }
    if (successfulImage) {
      try {
        current.nativeResult = nativeResult(successfulImage, { expanded: false, isPartial: false }, theme,
          nativeContext(context, args, current.nativeResult, false));
        current.resultFallback = undefined;
        return current.nativeResult;
      } catch {
        current.nativeResult = undefined;
        current.resultFallback = status ?? "Renderer failed";
        return evidenceComponent(current.resultFallback, theme, operations);
      }
    }
    if (toolName === "bash") {
      try {
        // Bash's native renderer owns timer settlement. An empty display envelope exercises that
        // lifecycle without copying, sanitizing, or formatting the retained command output.
        current.nativeResult = nativeResult({ content: [], details: undefined },
          { expanded: false, isPartial: false }, theme,
          nativeContext(context, args, current.nativeResult, false));
        current.resultFallback = undefined;
      } catch {
        current.nativeResult = undefined;
        current.resultFallback = status ?? exceptionalEvidence(resultValue, "Renderer failed", operations);
      }
    } else if (current.ordinary) {
      current.resultFallback = undefined;
    }
    if (current.resultFallback) return evidenceComponent(current.resultFallback, theme, operations);
    if (current.ordinary) return EMPTY_COMPONENT;
    return evidenceComponent(collapsedExceptionalEvidence(toolName, args, resultValue, operations, status), theme, operations);
  }) as T["renderResult"];
  return decorated;
}

/**
 * Keep routine successes concise while preserving native detail and exceptional evidence.
 */
export function withDefaultCollapsedToolRendering<T extends ToolDefinition>(
  tool: T,
  dependencies: DefaultCollapsedRenderingDependencies = {},
): T {
  const toolName = tool.name as ToolName;
  if (!["read", "write", "edit", "MultiEdit", "bash"].includes(toolName) ||
    typeof tool.renderCall !== "function" || typeof tool.renderResult !== "function") return tool;
  if (toolName === "read" || toolName === "bash") {
    return withCallOwnedRendering(tool, dependencies, toolName);
  }
  const nativeCall = tool.renderCall as NativeCall;
  const nativeResult = tool.renderResult as NativeResult;
  const lifecycles = new WeakMap<object, Lifecycle>();

  const decorated = { ...tool } as T;
  decorated.renderCall = ((argsValue: unknown, theme: unknown, context: unknown): Component => {
    const current = lifecycle(lifecycles, context);
    if (current && current.displayRootsResolved !== true && booleanField(context, "argsComplete") !== false) {
      current.displayRoots = resolveDisplayRoots(dependencies.resolveDisplayRoot, dependencies.repositoryRoot, context);
      const rawArgs = data(argsValue);
      const rawPath = toolName === "MultiEdit" ? rawArgs?.file_path : rawArgs?.path;
      if (typeof rawPath === "string") {
        current.displayPath = sanitizeInlineDisplay(formatDisplayPathFromRoots(rawPath, current.displayRoots), MAX_PATH);
      }
      current.displayRootsResolved = true;
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
      } catch {
        current.call = undefined;
        return messageComponent("Renderer failed", theme);
      }
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
      current.call = undefined;
      return messageComponent("Renderer failed", theme);
    }
  }) as T["renderCall"];

  decorated.renderResult = ((resultValue: unknown, options: unknown, theme: unknown, context: unknown): Component => {
    const current = lifecycle(lifecycles, context);
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
      } catch {
        current.result = undefined;
        return messageComponent("Renderer failed", theme);
      }
    }

    const agreed = finalAgreement(options, context);
    const previewError = toolName === "edit" ? adaptedEditPreviewError(current.call) : undefined;
    if (previewError) current.editPreviewError = sanitize(previewError, 512, true);
    const multi = toolName === "MultiEdit"
      ? recognizeMultiEditSuccess(resultValue, options, context)
      : undefined;
    const ordinary = agreed && !current.editPreviewError
      ? (multi?.kind === "displayable"
        ? multiSummary(multi)
        : toolName === "write" || toolName === "edit"
          ? recognize(toolName, args, resultValue)
          : undefined)
      : undefined;
    const forceExpanded = !hint || !agreed || !ordinary;
    let native: Component;
    try {
      native = nativeResult(result, { expanded: forceExpanded || requestedExpanded, isPartial: false }, theme,
        nativeContext(context, args, current.result, forceExpanded || requestedExpanded));
      current.result = native;
    } catch {
      current.result = undefined;
      return messageComponent("Renderer failed", theme);
    }
    const ownsRow = current.settledCall && current.call;
    if (ordinary && hint && !requestedExpanded && ownsRow) {
      const displayRoots = current.displayRootsResolved === true
        ? current.displayRoots ?? {}
        : resolveDisplayRoots(dependencies.resolveDisplayRoot, dependencies.repositoryRoot, context);
      return summaryComponent(toolName, ordinary, hint, theme, displayRoots, current.displayPath);
    }

    let call = current.call;
    if (ownsRow && (forceExpanded || requestedExpanded)) {
      try {
        call = nativeCall(args, theme, nativeContext(context, args, current.call, true));
        current.call = call;
      } catch {
        current.call = undefined;
        call = undefined;
      }
    }
    if (!ownsRow || !call) return native;
    if (current.editPreviewError) {
      return combined([messageComponent(`Edit preview failed: ${current.editPreviewError}`, theme), call, native], theme);
    }
    return combined([call, native], theme);
  }) as T["renderResult"];

  return decorated;
}

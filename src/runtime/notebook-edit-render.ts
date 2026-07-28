import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { piToolsExpandKeyText } from "./pi-tui-runtime.js";
import { sanitizeDisplayText, themedFg } from "./render-util.js";
import {
  formatDisplayPathFromRoots,
  priorityDisplayRow,
  resolveDisplayRoots,
  sanitizeInlineDisplay,
  type DisplayRootResolver,
  type DisplayRoots,
} from "./tool-display.js";
import { setToolRowOutcome } from "./tool-shell.js";
import { NOTEBOOK_MUTATION_FACTS } from "./tools/notebook-edit.js";

interface Component { render(width: number): string[] }
type EditMode = "replace" | "insert" | "delete";

interface Intent {
  readonly path: string;
  readonly pathIdentity: string;
  readonly mode: EditMode;
  readonly rawCellId?: string;
  readonly cellId?: string;
  readonly cellType?: "code" | "markdown";
}

interface CanonicalSuccess {
  readonly cellId?: string;
}

interface CanonicalMutationFacts {
  readonly addressedCellId?: string;
  readonly generatedCellId?: string;
  readonly cellType: "code" | "markdown";
  readonly previousCellType?: "code" | "markdown";
  readonly clearedExecutionCount: number;
}

interface Lifecycle {
  roots?: DisplayRoots;
  intent?: Intent;
  frozen: boolean;
  call?: MutableCall;
  expandedCall?: readonly DetailLine[];
  expandedResult?: readonly DetailLine[];
}

interface MutableCall extends Component {
  update(view: CallView): void;
}

interface CallView {
  readonly intent?: Intent;
  readonly expanded: boolean;
  readonly cue: string;
  readonly recovery: boolean;
  readonly detail: readonly DetailLine[];
  readonly theme: unknown;
}

interface DetailLine {
  readonly label: string;
  readonly value: string;
}

export interface NotebookEditRenderingOptions {
  resolveDisplayRoot?: DisplayRootResolver;
  repositoryRoot?: string;
}

const MAX_PATH = 16_384;
const MAX_ID = 256;
const MAX_BINDING = 128;
const MAX_DETAIL_FIELD = 8_192;
const MAX_DETAIL_LINES = 24;
const MAX_EVIDENCE = 2_048;
const MAX_RENDERED_LINES = 32;
const MAX_FIELD_RENDER_LINES = 3;
const RECOVERY = "detail unavailable; configure tool expansion";
const EMPTY_COMPONENT: Component = Object.freeze({ render: () => [] });

function ownDescriptor(value: unknown, key: PropertyKey): PropertyDescriptor | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key); }
  catch { return undefined; }
}

function ownData(value: unknown, key: PropertyKey): unknown {
  const descriptor = ownDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function ownBoolean(value: unknown, key: string): boolean | undefined {
  const field = ownData(value, key);
  return typeof field === "boolean" ? field : undefined;
}

function ownKeys(value: unknown): readonly PropertyKey[] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try { return Reflect.ownKeys(value); }
  catch { return undefined; }
}

function exactDataObject(value: unknown, expected: readonly (string | symbol)[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function exactOneTextContentShape(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes("0") || !keys.includes("length") || value.length !== 1) return false;
    const block = ownData(value, "0");
    if (block === null || typeof block !== "object" || Array.isArray(block) ||
      Object.getPrototypeOf(block) !== Object.prototype) return false;
    const blockKeys = Reflect.ownKeys(block);
    return blockKeys.length === 2 && blockKeys.includes("type") && blockKeys.includes("text") &&
      ownData(block, "type") === "text";
  } catch {
    return false;
  }
}

function objectState(context: unknown): object | undefined {
  const state = ownData(context, "state");
  return state !== null && (typeof state === "object" || typeof state === "function")
    ? state as object
    : undefined;
}

function safeBinding(): string | undefined {
  try {
    const availability = piToolsExpandKeyText();
    if (!availability.available) return undefined;
    return sanitizeDisplayText(availability.value, MAX_BINDING, true) || undefined;
  } catch {
    return undefined;
  }
}

function lexicalPathIdentity(value: unknown, roots: DisplayRoots): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const formatted = formatDisplayPathFromRoots(value, roots);
  if (!formatted) return undefined;
  const windowsRoots = [roots.workspace, roots.repository].some((root) =>
    typeof root === "string" && (/^[A-Za-z]:[/\\]/u.test(root) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+/u.test(root)));
  return windowsRoots ? formatted.toLowerCase() : formatted;
}

function snapshotIntent(args: unknown, roots: DisplayRoots): Intent | undefined {
  const rawPath = ownData(args, "notebook_path");
  const rawMode = ownData(args, "edit_mode");
  const rawCellId = ownData(args, "cell_id");
  const rawCellType = ownData(args, "cell_type");
  const pathIdentity = lexicalPathIdentity(rawPath, roots);
  if (!pathIdentity) return undefined;
  const mode = rawMode === undefined ? "replace" : rawMode;
  if (mode !== "replace" && mode !== "insert" && mode !== "delete") return undefined;
  if (rawCellId !== undefined && (typeof rawCellId !== "string" || rawCellId.length === 0)) return undefined;
  if (mode !== "insert" && typeof rawCellId !== "string") return undefined;
  if (rawCellType !== undefined && rawCellType !== "code" && rawCellType !== "markdown") return undefined;
  if (mode === "insert" && rawCellType === undefined) return undefined;

  const path = sanitizeInlineDisplay(formatDisplayPathFromRoots(rawPath, roots), MAX_PATH);
  if (!path) return undefined;
  const cellId = typeof rawCellId === "string" ? sanitizeInlineDisplay(rawCellId, MAX_ID) : undefined;
  if (typeof rawCellId === "string" && !cellId) return undefined;
  return Object.freeze({
    path,
    pathIdentity,
    mode,
    ...(typeof rawCellId === "string" ? { rawCellId } : {}),
    ...(cellId ? { cellId } : {}),
    ...(rawCellType === "code" || rawCellType === "markdown" ? { cellType: rawCellType } : {}),
  });
}

function sanitizeDetail(value: unknown, inline = false): string | undefined {
  if (typeof value === "string") return sanitizeDisplayText(value, MAX_DETAIL_FIELD, inline);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return undefined;
}

function detailLinesFromArgs(args: unknown): readonly DetailLine[] {
  const lines: DetailLine[] = [];
  for (const key of ["notebook_path", "edit_mode", "cell_id", "cell_type", "new_source"] as const) {
    const value = ownData(args, key);
    if (value === undefined) continue;
    const safe = sanitizeDetail(value, key !== "new_source");
    if (safe !== undefined) lines.push({ label: `args.${key}`, value: safe });
  }
  return Object.freeze(lines);
}

function firstText(result: unknown, limit: number): string | undefined {
  const content = ownData(result, "content");
  if (!Array.isArray(content) || ownData(content, "length") !== 1) return undefined;
  const block = ownData(content, "0");
  if (ownData(block, "type") !== "text") return undefined;
  const text = ownData(block, "text");
  return typeof text === "string" ? sanitizeDisplayText(text, limit) : undefined;
}

function detailLinesFromResult(result: unknown): readonly DetailLine[] {
  const lines: DetailLine[] = [];
  const details = ownData(result, "details");
  for (const key of [
    "new_source", "old_source", "cell_id", "cell_type", "language", "edit_mode",
    "notebook_path", "original_file", "updated_file", "error",
  ] as const) {
    const value = ownData(details, key);
    if (value === undefined) continue;
    const safe = sanitizeDetail(value, !["new_source", "old_source", "original_file", "updated_file", "error"].includes(key));
    if (safe !== undefined) lines.push({ label: `details.${key}`, value: safe });
  }
  return Object.freeze(lines.slice(0, MAX_DETAIL_LINES));
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function exactMutationFacts(value: unknown, mode: EditMode): CanonicalMutationFacts | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const common = [
    "document", "mode", "resolvedIndex", "resultingIndex", "cellType", "persistedCellId",
    "clearedOutputCount", "clearedExecutionCount",
  ] as const;
  const sourceKeys = new Set<PropertyKey>(["document", "newSource", "oldSource"]);
  const expected: readonly (string | symbol)[] = mode === "insert"
    ? [...common, "newSource", "generatedCellId"]
    : mode === "replace"
      ? [...common, "previousCellType", "oldSource", "newSource", "addressedCellId"]
      : [...common, "previousCellType", "oldSource", "addressedCellId"];
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) return undefined;
    for (const key of keys) {
      if (sourceKeys.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
    }
  } catch {
    return undefined;
  }

  const factMode = ownData(value, "mode");
  const resolvedIndex = ownData(value, "resolvedIndex");
  const resultingIndex = ownData(value, "resultingIndex");
  const cellType = ownData(value, "cellType");
  const persistedCellId = ownData(value, "persistedCellId");
  const clearedOutputCount = ownData(value, "clearedOutputCount");
  const clearedExecutionCount = ownData(value, "clearedExecutionCount");
  if (factMode !== mode || !nonnegativeInteger(resultingIndex) ||
    (cellType !== "code" && cellType !== "markdown") ||
    (persistedCellId !== undefined && typeof persistedCellId !== "string") ||
    !nonnegativeInteger(clearedOutputCount) || !nonnegativeInteger(clearedExecutionCount)) return undefined;

  if (mode === "insert") {
    if (resolvedIndex !== undefined && !nonnegativeInteger(resolvedIndex)) return undefined;
    if (resultingIndex !== (resolvedIndex === undefined ? 0 : resolvedIndex + 1) ||
      clearedOutputCount !== 0 || clearedExecutionCount !== 0) return undefined;
    const generatedCellId = ownData(value, "generatedCellId");
    if ((generatedCellId !== undefined &&
      (typeof generatedCellId !== "string" || !/^[0-9a-f]{8}$/u.test(generatedCellId))) ||
      generatedCellId !== persistedCellId) return undefined;
    return Object.freeze({
      ...(typeof generatedCellId === "string" ? { generatedCellId } : {}),
      cellType,
      clearedExecutionCount,
    });
  }

  if (!nonnegativeInteger(resolvedIndex) || resultingIndex !== resolvedIndex) return undefined;
  const previousCellType = ownData(value, "previousCellType");
  const addressedCellId = ownData(value, "addressedCellId");
  if ((previousCellType !== "code" && previousCellType !== "markdown") ||
    typeof addressedCellId !== "string" ||
    (previousCellType === "markdown" && (clearedOutputCount !== 0 || clearedExecutionCount !== 0)) ||
    (mode === "replace" && previousCellType === "code" && clearedExecutionCount > 1) ||
    (mode === "delete" && (cellType !== previousCellType || clearedOutputCount !== 0 || clearedExecutionCount !== 0))) {
    return undefined;
  }
  return Object.freeze({ addressedCellId, cellType, previousCellType, clearedExecutionCount });
}

function canonicalSuccess(
  result: unknown,
  renderOptions: unknown,
  context: unknown,
  intent: Intent | undefined,
  roots: DisplayRoots | undefined,
): CanonicalSuccess | undefined {
  if (ownBoolean(renderOptions, "isPartial") !== false || ownBoolean(context, "isPartial") !== false ||
    ownBoolean(context, "isError") !== false || !intent || !roots ||
    !exactDataObject(result, ["content", "details"])) return undefined;
  const content = ownData(result, "content");
  const details = ownData(result, "details");
  if (!exactOneTextContentShape(content) || details === null || typeof details !== "object" ||
    Array.isArray(details)) return undefined;

  let keys: readonly PropertyKey[];
  try {
    if (Object.getPrototypeOf(details) !== Object.prototype) return undefined;
    keys = Reflect.ownKeys(details);
  } catch {
    return undefined;
  }
  const required = [
    "new_source", "cell_type", "language", "edit_mode", "notebook_path", "original_file", "updated_file",
  ] as const;
  const optional = new Set<PropertyKey>(["old_source", "cell_id"]);
  if (!required.every((key) => keys.includes(key)) || !keys.includes(NOTEBOOK_MUTATION_FACTS) ||
    keys.some((key) => !required.includes(key as typeof required[number]) && !optional.has(key) && key !== NOTEBOOK_MUTATION_FACTS)) {
    return undefined;
  }
  const sourceKeys = new Set<PropertyKey>(["new_source", "old_source", "original_file", "updated_file"]);
  for (const key of keys) {
    if (sourceKeys.has(key)) continue;
    const descriptor = ownDescriptor(details, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
  }

  const mode = ownData(details, "edit_mode");
  const resultPathIdentity = lexicalPathIdentity(ownData(details, "notebook_path"), roots);
  const cellIdPresent = keys.includes("cell_id");
  const cellId = cellIdPresent ? ownData(details, "cell_id") : undefined;
  const cellType = ownData(details, "cell_type");
  const facts = exactMutationFacts(ownData(details, NOTEBOOK_MUTATION_FACTS), intent.mode);
  if (mode !== intent.mode || resultPathIdentity !== intent.pathIdentity || !facts ||
    cellType !== (intent.cellType ?? "code") || (cellIdPresent && typeof cellId !== "string")) return undefined;
  if ((intent.mode === "insert" && keys.includes("old_source")) ||
    (intent.mode !== "insert" && !keys.includes("old_source"))) return undefined;

  if (intent.mode === "insert") {
    const generatedCellId = facts.generatedCellId;
    if (facts.cellType !== intent.cellType ||
      (generatedCellId === undefined ? cellIdPresent : !cellIdPresent || cellId !== generatedCellId)) return undefined;
  } else {
    const addressedCellId = facts.addressedCellId;
    if (addressedCellId !== intent.rawCellId || (cellIdPresent && cellId !== addressedCellId)) return undefined;
    if (intent.mode === "replace" &&
      (intent.cellType !== undefined ? facts.cellType !== intent.cellType : facts.cellType !== facts.previousCellType)) {
      return undefined;
    }
  }
  return Object.freeze({
    ...(typeof cellId === "string" ? { cellId: sanitizeInlineDisplay(cellId, MAX_ID) } : {}),
  });
}

function collapsedEvidence(result: unknown, terminalError: boolean): string {
  if (terminalError) {
    const detailError = ownData(ownData(result, "details"), "error");
    if (typeof detailError === "string") {
      const safe = sanitizeDisplayText(detailError, MAX_EVIDENCE);
      if (safe.trim()) return safe;
    }
    const text = firstText(result, MAX_EVIDENCE);
    if (text?.trim()) return text;
  }
  return "Unfamiliar notebook edit result; inspect the canonical result before continuing.";
}

function expandedExceptionalDetail(result: unknown): readonly DetailLine[] {
  const details = [...detailLinesFromResult(result)];
  if (!details.some((line) => line.label === "details.error")) {
    const text = firstText(result, MAX_EVIDENCE);
    details.unshift({
      label: "error",
      value: text?.trim() || "Notebook edit result is unavailable or malformed; inspect the canonical result.",
    });
  }
  return Object.freeze(details.slice(0, MAX_DETAIL_LINES));
}

function clamp(line: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const columns = Math.floor(width);
  try { return visibleWidth(line) > columns ? truncateToWidth(line, columns, "…") : line; }
  catch { return sanitizeDisplayText(line, columns, true).slice(0, columns); }
}

function renderDetails(lines: readonly DetailLine[], theme: unknown, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  const columns = Math.max(1, Math.floor(width));
  const rendered: string[] = [];
  for (const { label, value } of lines.slice(0, MAX_DETAIL_LINES)) {
    const normalized = value.split("\n").slice(0, MAX_DETAIL_LINES);
    const fieldLines: string[] = [];
    for (let index = 0; index < normalized.length && fieldLines.length < MAX_FIELD_RENDER_LINES; index++) {
      const prefix = index === 0 ? `${label}: ` : "  ";
      const styled = themedFg(theme, "muted", prefix) + themedFg(theme, "toolOutput", normalized[index] ?? "");
      try {
        for (const line of wrapTextWithAnsi(styled, columns)) {
          fieldLines.push(clamp(line, columns));
          if (fieldLines.length >= MAX_FIELD_RENDER_LINES) break;
        }
      } catch {
        fieldLines.push(clamp(`${prefix}${normalized[index] ?? ""}`, columns));
      }
    }
    if (fieldLines.length === MAX_FIELD_RENDER_LINES &&
      (normalized.length > 1 || value.length > columns * MAX_FIELD_RENDER_LINES)) {
      fieldLines[MAX_FIELD_RENDER_LINES - 1] = clamp(themedFg(theme, "muted", "…"), columns);
    }
    rendered.push(...fieldLines);
    if (rendered.length >= MAX_RENDERED_LINES) return rendered.slice(0, MAX_RENDERED_LINES);
  }
  return rendered;
}

function callComponent(initial: CallView): MutableCall {
  let view = initial;
  return {
    update(next) { view = next; },
    render(width) {
      if (!Number.isFinite(width) || width <= 0) return [];
      const intent = view.intent;
      const operation = intent ? `${intent.mode}${intent.cellId ? ` cell ${intent.cellId}` : ""}` : "";
      const cue = view.expanded ? "" : view.cue ? `${view.cue} to expand` : "";
      const recovery = !view.expanded && view.recovery ? RECOVERY : "";
      const required = recovery ? [recovery] : [];
      const optional = intent?.cellType ? [operation, intent.cellType] : operation ? [operation] : [];
      const summary = priorityDisplayRow(
        "notebook write",
        intent?.path ?? "",
        required,
        optional,
        cue,
        view.theme,
      ).render(width);
      if (!view.expanded || view.detail.length === 0) return summary;
      return [...summary, ...renderDetails(view.detail, view.theme, width)].slice(0, MAX_RENDERED_LINES);
    },
  };
}

function messageComponent(message: string, theme: unknown): Component {
  const safe = sanitizeDisplayText(message, MAX_EVIDENCE);
  return { render: (width) => renderDetails([{ label: "error", value: safe }], theme, width) };
}

function genericView(theme: unknown): CallView {
  return { expanded: false, cue: "", recovery: false, detail: [], theme };
}

/** Add NotebookEdit's main-session-only human presentation without changing its canonical behavior. */
export function withNotebookEditRendering<T extends ToolDefinition>(
  tool: T,
  options: NotebookEditRenderingOptions = {},
): T {
  if (tool.name !== "NotebookEdit") return tool;
  const lifecycles = new WeakMap<object, Lifecycle>();
  const lifecycleFor = (context: unknown): Lifecycle | undefined => {
    const state = objectState(context);
    if (!state) return undefined;
    let lifecycle = lifecycles.get(state);
    if (!lifecycle) {
      lifecycle = { frozen: false };
      lifecycles.set(state, lifecycle);
    }
    return lifecycle;
  };

  const descriptors = Object.getOwnPropertyDescriptors(tool);
  delete descriptors.renderCall;
  delete descriptors.renderResult;
  const decorated = Object.defineProperties(Object.create(Object.getPrototypeOf(tool)), descriptors) as T;

  Object.defineProperty(decorated, "renderCall", {
    configurable: true,
    enumerable: true,
    writable: true,
    value(args: unknown, theme: unknown, context: unknown): Component {
      try {
        const lifecycle = lifecycleFor(context);
        const complete = ownBoolean(context, "argsComplete") === true;
        if (!complete) {
          const view = genericView(theme);
          if (!lifecycle) return callComponent(view);
          lifecycle.call ??= callComponent(view);
          lifecycle.call.update(view);
          return lifecycle.call;
        }

        const started = ownBoolean(context, "executionStarted") === true;
        if (lifecycle && !lifecycle.frozen) {
          lifecycle.roots = resolveDisplayRoots(options.resolveDisplayRoot, options.repositoryRoot, context);
          lifecycle.intent = snapshotIntent(args, lifecycle.roots);
          lifecycle.expandedCall = undefined;
          if (started) lifecycle.frozen = true;
        }
        const expanded = ownBoolean(context, "expanded") === true && ownBoolean(context, "isPartial") !== true;
        const binding = safeBinding();
        const view: CallView = {
          intent: lifecycle?.intent,
          expanded,
          cue: binding ?? "",
          recovery: !binding,
          detail: expanded
            ? lifecycle?.expandedCall ?? (lifecycle ? (lifecycle.expandedCall = detailLinesFromArgs(args)) : detailLinesFromArgs(args))
            : [],
          theme,
        };
        if (!lifecycle) return callComponent(view);
        lifecycle.call ??= callComponent(view);
        lifecycle.call.update(view);
        return lifecycle.call;
      } catch {
        return callComponent(genericView(theme));
      }
    },
  });

  Object.defineProperty(decorated, "renderResult", {
    configurable: true,
    enumerable: true,
    writable: true,
    value(result: unknown, renderOptions: unknown, theme: unknown, context: unknown): Component {
      try {
        const lifecycle = lifecycleFor(context);
        const partial = ownBoolean(renderOptions, "isPartial") === true || ownBoolean(context, "isPartial") === true;
        if (partial) {
          lifecycle?.call?.update(genericView(theme));
          return EMPTY_COMPONENT;
        }

        if (lifecycle && !lifecycle.frozen) {
          lifecycle.roots ??= resolveDisplayRoots(options.resolveDisplayRoot, options.repositoryRoot, context);
          lifecycle.intent ??= snapshotIntent(ownData(context, "args"), lifecycle.roots);
          lifecycle.frozen = true;
        }
        const expanded = ownBoolean(renderOptions, "expanded") === true || ownBoolean(context, "expanded") === true;
        const success = canonicalSuccess(result, renderOptions, context, lifecycle?.intent, lifecycle?.roots);
        if (success && lifecycle) {
          if (success.cellId) lifecycle.intent = Object.freeze({ ...lifecycle.intent!, cellId: success.cellId });
          const binding = safeBinding();
          const view: CallView = {
            intent: lifecycle.intent,
            expanded,
            cue: binding ?? "",
            recovery: !binding,
            detail: expanded
              ? lifecycle.expandedCall ?? (lifecycle.expandedCall = detailLinesFromArgs(ownData(context, "args")))
              : [],
            theme,
          };
          if (lifecycle.call) {
            lifecycle.call.update(view);
            if (!expanded) return EMPTY_COMPONENT;
            lifecycle.expandedResult ??= detailLinesFromResult(result);
            return { render: (width: number) => renderDetails(lifecycle.expandedResult ?? [], theme, width) };
          }

          const resultOnly = callComponent(view);
          if (!expanded) return resultOnly;
          lifecycle.expandedResult ??= detailLinesFromResult(result);
          return {
            render(width: number): string[] {
              return [...resultOnly.render(width), ...renderDetails(lifecycle.expandedResult ?? [], theme, width)]
                .slice(0, MAX_RENDERED_LINES);
            },
          };
        }

        const terminalError = ownBoolean(context, "isError") === true;
        const evidence = collapsedEvidence(result, terminalError);
        if (/\b(?:aborted|cancelled)\b/iu.test(evidence)) setToolRowOutcome(context, "stopped");
        else setToolRowOutcome(context, "failure");
        if (expanded) {
          const detail = expandedExceptionalDetail(result);
          return { render: (width: number) => renderDetails(detail, theme, width) };
        }
        return messageComponent(evidence, theme);
      } catch {
        setToolRowOutcome(context, "failure");
        return messageComponent("Notebook edit result could not be presented; inspect the canonical result.", theme);
      }
    },
  });

  return decorated;
}

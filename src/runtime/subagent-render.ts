import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../runtime-host.js";
import {
  formatUsagePresentation,
  sanitizeProgressText,
  scalarSafeText,
  type ProgressSnapshot,
} from "./subagent-progress.js";
import { clampLines, pushColored, pushWrapped, themedBold, themedFg } from "./render-util.js";
import { formatElapsed } from "./subagent-panel-render.js";
import { FORK_DEGRADE_PREFIX, isAgentId } from "../util/subagent-transcripts.js";
import {
  genericResultComponent,
  setToolRowOutcome,
  suppressToolRow,
  useTightToolRowMarker,
  type ToolRowOutcome,
} from "./tool-shell.js";
import type { Diagnostic } from "../types.js";
import { normalizeAgentColor, tintAgentColor, type AgentColorName } from "./agent-color.js";
import { formatToolDisplayName, semanticDisplayRow } from "./tool-display.js";
import { piToolsExpandKeyText } from "./pi-tui-runtime.js";
import type { SubagentAdmission } from "./subagent-registry.js";

// --- live-progress + result rendering helpers ---
//
// The Agent tool's renderCall/renderResult return a STRUCTURAL pi-tui Component
// ({ render(width): string[] }) — the same untyped contract src/extension.ts's control
// renderers use, so no pi-tui import is needed. The width/theme helpers
// (clampLines, pushWrapped, pushColored, themedFg, themedBold) live in
// render-util.ts, shared with the subagent status panel.

// Retained as a compatibility sentinel for print-mode negative assertions;
// interactive completion cues are resolved from Pi's configured action.
export const RECORD_EXPAND_HINT = "ctrl+o to expand";
// Retained lifecycle bodies are not useful below this width and can otherwise expand into enormous row counts.
const DETAIL_USABLE_WIDTH = 8;
const RESIZE_GUIDANCE = "resize";
/** The condensed fork-degrade warning — NEVER expand-only on a degraded fork. */
export const RECORD_FORK_MARKER = "⚠ fork degraded";
const AGENT_MCP_WARNING_PREFIX = "Agent MCP availability warning:";
const AGENT_MCP_CLEANUP_WARNING_PREFIX = "Agent MCP cleanup warning:";

/** Per-tool-call state shared by Pi across call/result renderer slots. */
export interface SubagentLifecycleRenderState {
  resultOwned?: boolean;
}

/** Structural subset of Pi's ToolRenderContext used by lifecycle renderers. */
export interface SubagentLifecycleRenderContext {
  state?: SubagentLifecycleRenderState;
  [key: string]: unknown;
}

export interface SubagentRenderingOptions {
  surface?: "agent" | "task-output" | "settlement";
  resolveAgentColor?: (agentId: string | undefined, agentName: string | undefined) => unknown;
}

interface SubagentRenderPresentation extends SubagentRenderingOptions {
  /** Factory-owned, exact-correlated awaited TaskOutput identity; never serialized into tool data. */
  awaitedTaskOutputFallback?: Readonly<{ taskId: string; description: string }>;
}

/** Complete details-only contract consumed by subagent lifecycle renderers. */
export interface SubagentRenderDetails {
  record?: "subagent-completion";
  background?: boolean;
  taskId?: string;
  status?: "running" | "completed" | "failed" | "stopped";
  admission?: SubagentAdmission;
  outcome?: "completed" | "failed" | "aborted";
  agent?: string;
  agentId?: string;
  description?: string;
  durationMs?: number;
  settledAt?: number;
  usage?: unknown;
  cutOff?: boolean;
  userStopped?: boolean;
  resumable?: boolean;
  transcriptPath?: string;
  diagnostics?: Diagnostic[];
  subagentProgress?: ProgressSnapshot;
  lastActivity?: string;
  alreadyReported?: boolean;
  error?: string;
  finalText?: string;
  nested?: boolean;
  live?: boolean;
  worktreePath?: string;
  note?: string;
  delivery?: "steer" | "resume";
  resumed?: boolean;
  retainedOutcome?: boolean;
  reportId?: object;
  occurrences?: readonly unknown[];
  representedCount?: number;
  unrepresentableCount?: number;
  retainedCount?: number;
}

const RENDER_SCALAR_LIMIT = 16_385;
const RENDER_DIAGNOSTIC_LIMIT = 100;
const RENDER_DIAGNOSTIC_MESSAGE_LIMIT = 1_000;
const RENDER_PROGRESS_TAIL_LIMIT = 12;
const RENDER_PROGRESS_LINE_LIMIT = 200;
const RENDER_BODY_BLOCK_LIMIT = 256;
const RENDER_BODY_RAW_LIMIT = 1_048_576;
const RENDER_BODY_TEXT_LIMIT = 1_048_576;

function safeArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !safeArray(value);
}

function safeField(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasOwnField(value: unknown, key: PropertyKey): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  try {
    return Object.getOwnPropertyDescriptor(value, key) !== undefined;
  } catch {
    return true;
  }
}

function boundedString(value: unknown, limit = RENDER_SCALAR_LIMIT): string | undefined {
  if (typeof value !== "string") return undefined;
  const inspected = value.slice(0, limit + 1);
  const clean = humanDisplayText(inspected, false);
  if (clean.length <= limit && value.length <= limit) return clean;
  let prefix = clean.slice(0, limit);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

function arrayLength(value: unknown, limit: number): number {
  if (!safeArray(value)) return 0;
  const length = safeField(value, "length");
  return Number.isSafeInteger(length) && (length as number) > 0 ? Math.min(length as number, limit) : 0;
}

function normalizeDiagnostics(value: unknown): Diagnostic[] | undefined {
  const diagnostics: Diagnostic[] = [];
  const length = arrayLength(value, RENDER_DIAGNOSTIC_LIMIT);
  for (let i = 0; i < length; i++) {
    const item = safeField(value, i);
    if (!isRecord(item)) continue;
    const severity = safeField(item, "severity");
    const message = boundedString(safeField(item, "message"), RENDER_DIAGNOSTIC_MESSAGE_LIMIT);
    const sourceValue = safeField(item, "source");
    const source = boundedString(sourceValue, RENDER_DIAGNOSTIC_MESSAGE_LIMIT);
    if (
      (severity !== "info" && severity !== "warning" && severity !== "error") ||
      message === undefined ||
      (sourceValue !== undefined && source === undefined)
    ) continue;
    diagnostics.push(source === undefined ? { severity, message } : { severity, message, source });
  }
  return diagnostics.length > 0 ? diagnostics : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeUsageFields(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Record<string, number> = {};
  for (const key of [
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "totalTokens", "tokens", "costUsd", "cost",
  ]) {
    const field = finiteNumber(safeField(value, key));
    if (field !== undefined) usage[key] = field;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function normalizeProgressSnapshot(value: unknown): ProgressSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const activity = boundedString(safeField(value, "activity"), RENDER_PROGRESS_LINE_LIMIT);
  const rawTail = safeField(value, "tail");
  if (activity === undefined || !safeArray(rawTail)) return undefined;
  const tail: string[] = [];
  const length = arrayLength(rawTail, RENDER_PROGRESS_TAIL_LIMIT);
  for (let i = 0; i < length; i++) {
    const line = boundedString(safeField(rawTail, i), RENDER_PROGRESS_LINE_LIMIT);
    if (line !== undefined) tail.push(line);
  }
  const usage = normalizeUsageFields(safeField(value, "usage"));
  return usage ? { activity, tail, usage } : { activity, tail };
}

function normalizeUsage(value: unknown): string | Record<string, string | number> | undefined {
  const textValue = boundedString(value);
  if (textValue !== undefined) return sanitizeInline(textValue);
  if (!isRecord(value)) return undefined;
  const usage: Record<string, string | number> = normalizeUsageFields(value) ?? {};
  const text = boundedString(safeField(value, "text"));
  if (text !== undefined) usage.text = sanitizeInline(text);
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Copy validated renderer fields from persisted or extension-message data. */
function normalizeSubagentRenderDetails(value: unknown): SubagentRenderDetails | undefined {
  if (!isRecord(value)) return undefined;
  const normalized: SubagentRenderDetails = {};
  const record = safeField(value, "record");
  if (record === "subagent-completion") normalized.record = record;
  const status = safeField(value, "status");
  if (status === "running" || status === "completed" || status === "failed" || status === "stopped") {
    normalized.status = status;
  }
  const admission = safeField(value, "admission");
  if (admission === "waiting" || admission === "admitted") normalized.admission = admission;
  const outcome = safeField(value, "outcome");
  if (outcome === "completed" || outcome === "failed" || outcome === "aborted") normalized.outcome = outcome;
  const delivery = safeField(value, "delivery");
  if (delivery === "steer" || delivery === "resume") normalized.delivery = delivery;

  for (const key of [
    "taskId", "agent", "agentId", "description", "transcriptPath", "lastActivity",
    "error", "finalText", "worktreePath", "note",
  ] as const) {
    const scalar = boundedString(safeField(value, key));
    if (scalar !== undefined) normalized[key] = scalar;
  }
  for (const key of ["durationMs", "settledAt"] as const) {
    const number = finiteNumber(safeField(value, key));
    if (number !== undefined) normalized[key] = number;
  }
  for (const key of [
    "background", "cutOff", "userStopped", "resumable", "alreadyReported",
    "nested", "live", "resumed",
  ] as const) {
    const flag = safeField(value, key);
    if (typeof flag === "boolean") normalized[key] = flag;
  }

  const retainedOutcome = safeField(value, "retainedOutcome");
  const reportId = safeField(value, "reportId");
  const occurrences = safeField(value, "occurrences");
  const representedCount = safeField(value, "representedCount");
  const unrepresentableCount = safeField(value, "unrepresentableCount");
  const retainedCount = safeField(value, "retainedCount");
  if (retainedOutcome === true && reportId !== null && typeof reportId === "object" &&
      safeArray(occurrences) && Number.isSafeInteger(representedCount) && (representedCount as number) >= 0 &&
      representedCount === occurrences.length && Number.isSafeInteger(unrepresentableCount) &&
      (unrepresentableCount as number) >= 0 && Number.isSafeInteger(retainedCount) &&
      retainedCount === Math.min(Number.MAX_SAFE_INTEGER, (representedCount as number) + (unrepresentableCount as number))) {
    normalized.retainedOutcome = true;
    normalized.reportId = reportId;
    normalized.occurrences = occurrences;
    normalized.representedCount = representedCount as number;
    normalized.unrepresentableCount = unrepresentableCount as number;
    normalized.retainedCount = retainedCount as number;
  }

  const usage = normalizeUsage(safeField(value, "usage"));
  if (usage !== undefined) normalized.usage = usage;
  const diagnostics = normalizeDiagnostics(safeField(value, "diagnostics"));
  if (diagnostics) normalized.diagnostics = diagnostics;
  const progress = normalizeProgressSnapshot(safeField(value, "subagentProgress"));
  if (progress) normalized.subagentProgress = progress;
  return normalized;
}

function boundedBodyText(result: unknown): string {
  const content = safeField(result, "content");
  const length = arrayLength(content, RENDER_BODY_BLOCK_LIMIT);
  const parts: string[] = [];
  let raw = 0;
  let output = 0;
  for (let i = 0; i < length && raw < RENDER_BODY_RAW_LIMIT && output < RENDER_BODY_TEXT_LIMIT; i++) {
    const block = safeField(content, i);
    if (safeField(block, "type") !== "text") continue;
    const text = safeField(block, "text");
    if (typeof text !== "string") continue;
    const rawRoom = RENDER_BODY_RAW_LIMIT - raw;
    const separatorWidth = parts.length > 0 ? 1 : 0;
    const outputRoom = RENDER_BODY_TEXT_LIMIT - output - separatorWidth;
    if (outputRoom <= 0) break;
    const inspectedLength = Math.min(text.length, rawRoom, outputRoom);
    const part = scalarSafeText(text.slice(0, inspectedLength));
    raw += inspectedLength;
    if (separatorWidth) {
      parts.push("\n");
      output++;
    }
    parts.push(part);
    output += part.length;
  }
  return parts.join("");
}

/**
 * SECURITY: body render paths split on this, not on `\n` alone — a
 * model-controlled `\r` surviving into an emitted line would overprint the line
 * start (same-line display spoofing), and `sanitizeProgressText` deliberately
 * preserves `\r`.
 */
const LINE_BREAK_RE = /\r\n?|\n|\u2028|\u2029/;

function humanDisplayText(text: string, inline: boolean): string {
  const safe = scalarSafeText(sanitizeProgressText(String(text ?? "")))
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u2028\u2029]/gu, inline ? " " : "\n");
  return inline ? safe.replace(/\s+/gu, " ").trim() : safe;
}

/** Push multi-line body text after neutralizing every Unicode line boundary. */
function pushBodyText(text: string, width: number, into: string[]): void {
  for (const line of String(text ?? "").split(LINE_BREAK_RE)) pushWrapped(line, width, into);
}

/** Flatten model-/file-supplied label text to a single sanitized display line. */
function sanitizeInline(text: string): string {
  return humanDisplayText(text, true);
}

function containsEquivalentErrorFraming(body: string, error: string): boolean {
  const normalizedBody = sanitizeInline(body);
  const normalizedError = sanitizeInline(error);
  if (!normalizedBody || !normalizedError) return false;
  const codePointBefore = (index: number): string | undefined => {
    if (index <= 0) return undefined;
    const trailing = normalizedBody.charCodeAt(index - 1);
    const start = trailing >= 0xDC00 && trailing <= 0xDFFF && index > 1 &&
        normalizedBody.charCodeAt(index - 2) >= 0xD800 && normalizedBody.charCodeAt(index - 2) <= 0xDBFF
      ? index - 2
      : index - 1;
    return normalizedBody.slice(start, index);
  };
  const codePointAt = (index: number): string | undefined => {
    const value = normalizedBody.codePointAt(index);
    return value === undefined ? undefined : String.fromCodePoint(value);
  };
  const constituent = (value: string | undefined) => value !== undefined && /[\p{L}\p{M}\p{N}_]/u.test(value);
  let offset = 0;
  while (offset <= normalizedBody.length - normalizedError.length) {
    const index = normalizedBody.indexOf(normalizedError, offset);
    if (index < 0) return false;
    const afterIndex = index + normalizedError.length;
    if (!constituent(codePointBefore(index)) && !constituent(codePointAt(afterIndex))) return true;
    offset = index + Math.max(1, normalizedError.length);
  }
  return false;
}

/**
 * The explicit TaskOutput target when that surface has `details.taskId`.
 * Passive Agent and settlement rows do not request this target. `taskId` is
 * registry-minted (`task-N`) but sanitized anyway so the discipline is uniform.
 */
function taskChip(details: SubagentRenderDetails): string | undefined {
  const taskId = typeof details.taskId === "string" ? sanitizeInline(details.taskId) : "";
  return taskId || undefined;
}

/** The explicit action target belongs to the invocation, even when its result is foreign or malformed. */
function taskOutputTarget(
  context: SubagentLifecycleRenderContext | undefined,
  details: SubagentRenderDetails,
): string | undefined {
  const requested = boundedString(safeField(safeField(context, "args"), "task_id"));
  const sanitized = requested === undefined ? "" : sanitizeInline(requested);
  return sanitized || taskChip(details);
}

function isTaskId(value: unknown): value is string {
  return typeof value === "string" && /^task-[1-9]\d*$/u.test(value);
}

function correlatedRunningTaskId(
  rawDetails: unknown,
  context: SubagentLifecycleRenderContext | undefined,
): string | undefined {
  const details = ownDataSnapshot(rawDetails, Object.prototype);
  const taskId = details ? snapshotField(details, "taskId") : undefined;
  const allowed = new Set<PropertyKey>([...TASK_OUTPUT_RESULT_KEYS, "subagentProgress", "live"]);
  const status = details ? snapshotField(details, "status") : undefined;
  const admission = details ? snapshotField(details, "admission") : undefined;
  const agent = details ? snapshotField(details, "agent") : undefined;
  const agentId = details ? snapshotField(details, "agentId") : undefined;
  const description = details ? snapshotField(details, "description") : undefined;
  if (!details || [...details.values.keys()].some((key) => !allowed.has(key)) || !isTaskId(taskId) ||
    status !== "running" || typeof agent !== "string" || sanitizeInline(agent) === "" ||
    (hasSnapshotField(details, "admission") && admission !== "admitted" && admission !== "waiting") ||
    (hasSnapshotField(details, "agentId") && agentId !== undefined &&
      (typeof agentId !== "string" || !isAgentId(agentId))) ||
    (hasSnapshotField(details, "description") && description !== undefined && typeof description !== "string")) {
    return undefined;
  }
  const renderContext = ownDataSnapshot(context);
  if (!renderContext || !hasSnapshotField(renderContext, "args")) return undefined;
  const args = ownDataSnapshot(snapshotField(renderContext, "args"), Object.prototype);
  if (!args || [...args.values.keys()].some((key) => key !== "task_id" && key !== "wait")) return undefined;
  const requested = snapshotField(args, "task_id");
  const wait = snapshotField(args, "wait");
  return isTaskId(requested) && requested === taskId &&
    (!hasSnapshotField(args, "wait") || typeof wait === "boolean") ? taskId : undefined;
}

interface OwnDataSnapshot {
  readonly values: ReadonlyMap<PropertyKey, unknown>;
}

function ownDataSnapshot(value: unknown, prototype?: object): OwnDataSnapshot | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    if (prototype !== undefined && Object.getPrototypeOf(value) !== prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const values = new Map<PropertyKey, unknown>();
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (!descriptor || !("value" in descriptor)) return undefined;
      values.set(key, descriptor.value);
    }
    return { values };
  } catch {
    return undefined;
  }
}

function exactSnapshot(
  value: unknown,
  prototype: object,
  allowed: ReadonlySet<PropertyKey>,
): OwnDataSnapshot | undefined {
  const snapshot = ownDataSnapshot(value, prototype);
  if (!snapshot || [...snapshot.values.keys()].some((key) => !allowed.has(key))) return undefined;
  return snapshot;
}

function snapshotField(snapshot: OwnDataSnapshot, key: PropertyKey): unknown {
  return snapshot.values.get(key);
}

function hasSnapshotField(snapshot: OwnDataSnapshot, key: PropertyKey): boolean {
  return snapshot.values.has(key);
}

const TEXT_BLOCK_KEYS = new Set<PropertyKey>(["type", "text"]);
const RESULT_ENVELOPE_KEYS = new Set<PropertyKey>(["content", "details", "isError"]);
const DIAGNOSTIC_KEYS = new Set<PropertyKey>(["severity", "message", "source"]);
const USAGE_KEYS = new Set<PropertyKey>([
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd",
]);
const AGENT_ACCEPTANCE_KEYS = new Set<PropertyKey>([
  "background", "taskId", "agent", "agentId", "admission", "description",
]);
const TASK_OUTPUT_RESULT_KEYS = new Set<PropertyKey>([
  "taskId", "status", "admission", "outcome", "agent", "agentId", "cutOff",
  "transcriptPath", "resumable", "usage", "lastActivity", "diagnostics", "description",
  "durationMs", "settledAt", "error", "userStopped", "alreadyReported", "retainedOutcome",
  "reportId", "occurrences", "representedCount", "unrepresentableCount", "retainedCount",
]);
const ARRAY_SINGLE_KEYS = new Set<PropertyKey>(["0", "length"]);

function canonicalTextEnvelopeSnapshot(result: unknown): {
  envelope: OwnDataSnapshot;
  details: OwnDataSnapshot;
} | undefined {
  const envelope = exactSnapshot(result, Object.prototype, RESULT_ENVELOPE_KEYS);
  if (!envelope || !hasSnapshotField(envelope, "content") || !hasSnapshotField(envelope, "details")) return undefined;
  const envelopeError = snapshotField(envelope, "isError");
  if (hasSnapshotField(envelope, "isError") && envelopeError !== false) return undefined;
  const content = exactSnapshot(snapshotField(envelope, "content"), Array.prototype, ARRAY_SINGLE_KEYS);
  if (!content || snapshotField(content, "length") !== 1) return undefined;
  const block = exactSnapshot(snapshotField(content, "0"), Object.prototype, TEXT_BLOCK_KEYS);
  if (!block || block.values.size !== 2 || snapshotField(block, "type") !== "text" ||
    typeof snapshotField(block, "text") !== "string" || snapshotField(block, "text") === "") return undefined;
  const details = ownDataSnapshot(snapshotField(envelope, "details"), Object.prototype);
  return details ? { envelope, details } : undefined;
}

function canonicalDiagnosticsSnapshot(value: unknown): boolean {
  const array = ownDataSnapshot(value, Array.prototype);
  if (!array) return false;
  const length = snapshotField(array, "length");
  if (!Number.isSafeInteger(length) || (length as number) > RENDER_DIAGNOSTIC_LIMIT || (length as number) < 0) return false;
  const expected = new Set<PropertyKey>(["length", ...Array.from({ length: length as number }, (_, index) => String(index))]);
  if ([...array.values.keys()].some((key) => !expected.has(key)) || array.values.size !== expected.size) return false;
  for (let index = 0; index < (length as number); index++) {
    const diagnostic = exactSnapshot(snapshotField(array, String(index)), Object.prototype, DIAGNOSTIC_KEYS);
    if (!diagnostic || !hasSnapshotField(diagnostic, "severity") || !hasSnapshotField(diagnostic, "message")) return false;
    const severity = snapshotField(diagnostic, "severity");
    const source = snapshotField(diagnostic, "source");
    if ((severity !== "info" && severity !== "warning" && severity !== "error") ||
      typeof snapshotField(diagnostic, "message") !== "string" ||
      (hasSnapshotField(diagnostic, "source") && typeof source !== "string")) return false;
  }
  return true;
}

function canonicalUsageSnapshot(value: unknown): boolean {
  const usage = exactSnapshot(value, Object.prototype, USAGE_KEYS);
  if (!usage || usage.values.size === 0) return false;
  for (const field of usage.values.values()) {
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0) return false;
  }
  return true;
}

function canonicalFinalContext(renderOptions: unknown, context: SubagentLifecycleRenderContext | undefined): OwnDataSnapshot | undefined {
  const options = ownDataSnapshot(renderOptions, Object.prototype);
  const renderContext = ownDataSnapshot(context);
  if (!options || snapshotField(options, "isPartial") !== false ||
    !renderContext || snapshotField(renderContext, "isError") !== false) return undefined;
  return renderContext;
}

function canonicalRequestedTarget(context: OwnDataSnapshot, taskId: string): boolean {
  if (!hasSnapshotField(context, "args")) return true;
  const args = ownDataSnapshot(snapshotField(context, "args"), Object.prototype);
  if (!args) return false;
  if (!hasSnapshotField(args, "task_id")) return true;
  return typeof snapshotField(args, "task_id") === "string" && snapshotField(args, "task_id") === taskId;
}

function validLifecycleIdentitySnapshot(details: OwnDataSnapshot): boolean {
  const agent = snapshotField(details, "agent");
  const agentId = snapshotField(details, "agentId");
  const description = snapshotField(details, "description");
  return typeof agent === "string" && sanitizeInline(agent) !== "" &&
    typeof agentId === "string" && isAgentId(agentId) &&
    (!hasSnapshotField(details, "description") || description === undefined || typeof description === "string");
}

function validTaskOutputOptionalsSnapshot(details: OwnDataSnapshot): boolean {
  const optional = (key: string, accepts: (value: unknown) => boolean) =>
    !hasSnapshotField(details, key) || snapshotField(details, key) === undefined || accepts(snapshotField(details, key));
  const retainedKeys = ["retainedOutcome", "reportId", "occurrences", "representedCount", "unrepresentableCount", "retainedCount"];
  const hasRetained = retainedKeys.some((key) => hasSnapshotField(details, key));
  const retainedValid = !hasRetained || (() => {
    const occurrences = snapshotField(details, "occurrences");
    const represented = snapshotField(details, "representedCount");
    const unrepresentable = snapshotField(details, "unrepresentableCount");
    const total = snapshotField(details, "retainedCount");
    return retainedKeys.every((key) => hasSnapshotField(details, key)) &&
      snapshotField(details, "retainedOutcome") === true &&
      snapshotField(details, "reportId") !== null && typeof snapshotField(details, "reportId") === "object" &&
      safeArray(occurrences) && Number.isSafeInteger(represented) && (represented as number) >= 0 &&
      represented === occurrences.length && Number.isSafeInteger(unrepresentable) && (unrepresentable as number) >= 0 &&
      Number.isSafeInteger(total) && total === Math.min(Number.MAX_SAFE_INTEGER,
        (represented as number) + (unrepresentable as number));
  })();
  return retainedValid && optional("error", (value) => typeof value === "string") &&
    optional("userStopped", (value) => typeof value === "boolean") &&
    optional("cutOff", (value) => typeof value === "boolean") &&
    optional("resumable", (value) => typeof value === "boolean") &&
    optional("durationMs", (value) => typeof value === "number" && Number.isFinite(value) && value >= 0) &&
    optional("settledAt", (value) => typeof value === "number" && Number.isFinite(value)) &&
    optional("transcriptPath", (value) => typeof value === "string") &&
    optional("lastActivity", (value) => typeof value === "string") &&
    optional("diagnostics", canonicalDiagnosticsSnapshot) &&
    optional("usage", canonicalUsageSnapshot);
}

function suppressibleAgentAcceptance(
  result: unknown,
  _details: unknown,
  renderOptions: unknown,
  context: SubagentLifecycleRenderContext | undefined,
  surface: SubagentRenderingOptions["surface"],
): boolean {
  if (surface !== "agent" || !canonicalFinalContext(renderOptions, context)) return false;
  const canonical = canonicalTextEnvelopeSnapshot(result);
  if (!canonical || [...canonical.details.values.keys()].some((key) => !AGENT_ACCEPTANCE_KEYS.has(key))) return false;
  const details = canonical.details;
  return snapshotField(details, "background") === true && isTaskId(snapshotField(details, "taskId")) &&
    validLifecycleIdentitySnapshot(details) &&
    (snapshotField(details, "admission") === "admitted" || snapshotField(details, "admission") === "waiting");
}

type CanonicalTaskOutputDelivery = "first" | "reported";

function canonicalTaskOutputDelivery(
  result: unknown,
  renderOptions: unknown,
  context: SubagentLifecycleRenderContext | undefined,
  surface: SubagentRenderingOptions["surface"],
): CanonicalTaskOutputDelivery | undefined {
  if (surface !== "task-output") return undefined;
  const renderContext = canonicalFinalContext(renderOptions, context);
  const canonical = canonicalTextEnvelopeSnapshot(result);
  if (!renderContext || !canonical ||
    [...canonical.details.values.keys()].some((key) => !TASK_OUTPUT_RESULT_KEYS.has(key))) return undefined;
  const details = canonical.details;
  const alreadyReported = snapshotField(details, "alreadyReported");
  let delivery: CanonicalTaskOutputDelivery | undefined;
  if (hasSnapshotField(details, "alreadyReported")) {
    if (alreadyReported === true) delivery = "reported";
  } else {
    delivery = "first";
  }
  if (!delivery || !validLifecycleIdentitySnapshot(details) || !validTaskOutputOptionalsSnapshot(details) ||
    (snapshotField(details, "admission") !== "admitted" && snapshotField(details, "admission") !== "waiting")) return undefined;
  const taskId = snapshotField(details, "taskId");
  if (!isTaskId(taskId) || !canonicalRequestedTarget(renderContext, taskId)) return undefined;
  const status = snapshotField(details, "status");
  const outcome = snapshotField(details, "outcome");
  const error = snapshotField(details, "error");
  const userStopped = snapshotField(details, "userStopped");
  if (status === "completed" && outcome === "completed") {
    return error === undefined && userStopped === undefined ? delivery : undefined;
  }
  if (status === "failed" && outcome === "failed") return userStopped === undefined ? delivery : undefined;
  if (status === "stopped" && outcome === "aborted") {
    const runtimeAbort = typeof error === "string" && userStopped === undefined;
    const userAbort = error === undefined && userStopped === true;
    return (error === undefined && userStopped === undefined) || runtimeAbort || userAbort ? delivery : undefined;
  }
  return undefined;
}

function resolvedAgentColor(
  options: SubagentRenderingOptions,
  details: SubagentRenderDetails,
  agentName: string,
): AgentColorName | undefined {
  try {
    return normalizeAgentColor(options.resolveAgentColor?.(agentIdOf(details), agentName));
  } catch {
    return undefined;
  }
}

/**
 * The stable `agent-<id>` when present AND well-formed — gated through
 * `isAgentId` (it is model-/file-adjacent metadata), so a malformed value never
 * reaches the terminal. `undefined` otherwise.
 */
function agentIdOf(details: SubagentRenderDetails): string | undefined {
  return typeof details.agentId === "string" && isAgentId(details.agentId)
    ? details.agentId
    : undefined;
}

/**
 * The developer-facing fork-degrade footer. A `subagent_type: "fork"`
 * dispatch that could not inherit the parent conversation runs fresh and records
 * a fork-SPECIFIC diagnostic (never the generic unknown-type warning) whose
 * message starts with this sentinel. We surface it as a muted footer line so the
 * degrade is VISIBLE — distinguishing a genuine inherited fork (no such line,
 * honest `fork` identity) from a degraded one (this line + a fresh-agent
 * identity). Read from `details.diagnostics`, the channel BOTH the foreground Agent
 * result and the background TaskOutput result already carry — so no extra
 * plumbing is needed. `FORK_DEGRADE_PREFIX` is the shared sentinel (imported from
 * the transcript util) that the emitter in subagents.ts writes.
 */
function forkDegradeLine(
  details: SubagentRenderDetails,
): { text: string; tone: string } | undefined {
  const diags: unknown = details.diagnostics;
  if (!Array.isArray(diags)) return undefined;
  for (const diagnostic of diags) {
    if (!isRecord(diagnostic)) continue;
    const { message, severity } = diagnostic;
    if (
      typeof message === "string" &&
      (severity === "info" || severity === "warning" || severity === "error") &&
      message.startsWith(FORK_DEGRADE_PREFIX)
    ) {
      // Tone: `warning` for a genuine can't-do (no transcript, SDK can't fork,
      // forkFrom threw); muted/calm for a chosen/expected opt-out (env `=0`).
      return { text: message, tone: severity === "warning" ? "warning" : "muted" };
    }
  }
  return undefined;
}

/**
 * Usage formatter for the renderResult footer.
 * Renders a string as-is, an explicit `text` override, otherwise delegates to
 * the shared `formatUsagePresentation` (the `{ inputTokens, … costUsd }` shape, and
 * the legacy `totalTokens`/`cost` shape). Returns NOTHING when absent or an
 * unrecognized shape, so the footer line drops entirely.
 */
function formatUsageLine(usage: unknown): string | undefined {
  if (usage == null) return undefined;
  if (typeof usage === "string") return sanitizeInline(usage) || undefined;
  if (typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    if (typeof u.text === "string") return sanitizeInline(u.text) || undefined;
    return formatUsagePresentation(u);
  }
  return undefined;
}

/** `details.durationMs` formatted for display, or undefined when absent/invalid. */
function durationOf(details: SubagentRenderDetails): string | undefined {
  const ms = details.durationMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0
    ? formatElapsed(ms)
    : undefined;
}

/** Foreground Agent records show local completion time alongside collapsed telemetry. */
function completionTimeOf(details: SubagentRenderDetails): string | undefined {
  if (typeof details.settledAt !== "number" || !Number.isFinite(details.settledAt)) return undefined;
  const date = new Date(details.settledAt);
  if (!Number.isFinite(date.getTime())) return undefined;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Collapsed-line error summary cap — the full error stays behind expand. */
const COLLAPSED_ERROR_CAP = 80;

/** Running-status usage: in/out tokens (+cost) only; complete usage stays in expanded detail. */
function formatUsageBrief(usage: unknown): string | undefined {
  if (usage == null) return undefined;
  if (typeof usage === "string") return sanitizeInline(usage) || undefined;
  if (typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  if (typeof u.text === "string") return sanitizeInline(u.text) || undefined;
  return formatUsagePresentation(u, { includeCache: false });
}

type LifecycleSegment = {
  separator: "" | " · " | " - ";
  text: string;
  tone?: string;
  /** Summary text may shrink; state, warning markers, and recovery cues may not. */
  elastic?: boolean;
};

function stripCanonicalMcpQualification(
  text: string,
  details: SubagentRenderDetails,
): string {
  const qualification = (details.diagnostics ?? [])
    .map((diagnostic) => diagnostic.message)
    .filter((message) =>
      message.startsWith(AGENT_MCP_WARNING_PREFIX) ||
      message.startsWith(AGENT_MCP_CLEANUP_WARNING_PREFIX),
    )
    .filter((message, index, all) => all.indexOf(message) === index)
    .join("\n");
  if (!qualification) return text;
  const frame = `\n\n---\n${qualification}\n---`;
  return text.endsWith(frame) ? text.slice(0, -frame.length) : text;
}

function actionableDiagnostics(details: SubagentRenderDetails): Diagnostic[] {
  return (details.diagnostics ?? []).filter((diagnostic) =>
    diagnostic.severity !== "info" && !diagnostic.message.startsWith(FORK_DEGRADE_PREFIX),
  );
}

function diagnosticSegments(details: SubagentRenderDetails): LifecycleSegment[] {
  const diagnostics = actionableDiagnostics(details);
  if (diagnostics.length === 0) return [];
  const severity = diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? "error"
    : "warning";
  const first = diagnostics[0]!;
  const source = first.source ? `${sanitizeInline(first.source)}: ` : "";
  return [
    { separator: " · ", text: `⚠ diagnostic ${severity}`, tone: severity },
    { separator: " - ", text: `${source}${sanitizeInline(first.message)}`, tone: severity, elastic: true },
  ];
}

function pushDiagnosticDetails(
  theme: unknown,
  details: SubagentRenderDetails,
  width: number,
  into: string[],
): void {
  for (const diagnostic of details.diagnostics ?? []) {
    if (diagnostic.message.startsWith(FORK_DEGRADE_PREFIX)) continue;
    const source = diagnostic.source ? ` · ${sanitizeInline(diagnostic.source)}` : "";
    const text = `diagnostic [${diagnostic.severity}]${source}: ${sanitizeInline(diagnostic.message)}`;
    pushColored(theme, diagnostic.severity === "info" ? "muted" : diagnostic.severity, text, width, into);
  }
}

/** Fit passive lifecycle rows; explicit task targets wrap instead of being truncated. */
function lifecycleLine(
  theme: unknown,
  options: {
    agent: unknown;
    chip?: string;
    state: string;
    prefix?: string;
    cue?: string;
    required?: LifecycleSegment[];
    optional?: LifecycleSegment[];
    description?: string;
    tone: string;
    color?: AgentColorName;
  },
  width: number,
  metadata?: { cueAppended: boolean },
): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  const columns = Math.floor(width);
  if (options.prefix && columns <= 2) {
    return clampLines([themedFg(theme, options.tone, options.prefix.trim())], columns);
  }
  const safeAgent = sanitizeInline(typeof options.agent === "string" ? options.agent : "") || "subagent";
  const required = (options.required ?? []).map((segment) => ({ ...segment }));
  const optional = [...(options.optional ?? [])];
  const description = sanitizeInline(options.description ?? "");
  const state = options.state ? ` [${options.state}]` : "";
  const prefix = options.prefix ?? "";
  const taskPrefix = options.chip
    ? `${formatToolDisplayName("TaskOutput")} ${options.chip} - `
    : "";
  const suffixPlain = () =>
    required.map((segment) => `${segment.separator}${segment.text}`).join("") +
    optional.map((segment) => `${segment.separator}${segment.text}`).join("") +
    (options.cue ? ` · ${options.cue}` : "");
  const plain = (agent = safeAgent, detail = description) =>
    `${prefix}${taskPrefix}${agent}${state}${detail ? ` - ${detail}` : ""}${suffixPlain()}`;

  while (optional.length > 0 && visibleWidth(plain()) > columns) optional.pop();

  // Reserve state, warning markers, and the expansion cue before fitting
  // diagnostic/error prose on legacy and non-terminal lifecycle rows. Identity and summaries share the
  // remaining room; summaries are elastic, but short actionable text survives.
  const elastic = required.filter((candidate) => candidate.elastic);
  const elasticWidth = elastic.reduce(
    (sum, segment) => sum + visibleWidth(segment.separator + segment.text),
    0,
  );
  let elasticRoom = Math.max(0, columns - (visibleWidth(plain("", "")) - elasticWidth) - 1);
  for (const segment of elastic) {
    const separatorWidth = visibleWidth(segment.separator);
    const textRoom = Math.max(0, elasticRoom - separatorWidth);
    if (visibleWidth(segment.text) > textRoom) {
      segment.text = textRoom > 0 ? truncateToWidth(segment.text, textRoom, "…") : "";
    }
    if (!segment.text) segment.separator = "";
    elasticRoom -= visibleWidth(segment.separator + segment.text);
  }

  if (options.chip) {
    const title = formatToolDisplayName("TaskOutput");
    const actionPlain = `${prefix}${title} ${options.chip} - `;
    const remainderFixed = state + suffixPlain() + (description ? " - " : "");
    const agentRoom = Math.max(1, columns - visibleWidth(remainderFixed));
    const fittedAgent = visibleWidth(safeAgent) > agentRoom
      ? truncateToWidth(safeAgent, agentRoom, "…")
      : safeAgent;
    const identity = options.color
      ? tintAgentColor(options.color, themedBold(theme, fittedAgent))
      : themedFg(theme, "text", fittedAgent);
    const action = themedFg(theme, options.tone, prefix) + themedFg(theme, "text", title) +
      themedFg(theme, "accent", ` ${options.chip}`) + themedFg(theme, "muted", " - ");
    let remainder = identity;
    if (state) remainder += themedFg(theme, "muted", state);
    if (description) remainder += themedFg(theme, "accent", ` - ${description}`);
    for (const segment of required) remainder += themedFg(theme, segment.tone ?? "muted", `${segment.separator}${segment.text}`);
    for (const segment of optional) remainder += themedFg(theme, segment.tone ?? "muted", `${segment.separator}${segment.text}`);
    if (options.cue) remainder += themedFg(theme, "muted", ` · ${options.cue}`);
    try {
      if (options.cue) metadata && (metadata.cueAppended = true);
      if (visibleWidth(action + remainder) <= columns) return [action + remainder];
      return [
        ...wrapTextWithAnsi(action, Math.max(1, columns)),
        ...wrapTextWithAnsi(remainder, Math.max(1, columns)),
      ];
    } catch {
      return [
        ...wrapTextWithAnsi(actionPlain, Math.max(1, columns)),
        ...wrapTextWithAnsi(`${fittedAgent}${state}${suffixPlain()}`, Math.max(1, columns)),
      ];
    }
  }
  const fixedWidth = visibleWidth(prefix + taskPrefix + state + suffixPlain());
  const descriptionSeparator = description ? visibleWidth(" - ") : 0;
  let available = Math.max(0, columns - fixedWidth - descriptionSeparator);
  let fittedAgent = safeAgent;
  let fittedDescription = description;
  if (description) {
    const minimumDescription = Math.min(2, visibleWidth(description));
    const agentAllowance = Math.max(1, available - minimumDescription);
    fittedAgent = visibleWidth(safeAgent) > agentAllowance
      ? truncateToWidth(safeAgent, agentAllowance, "…") : safeAgent;
    const descriptionAllowance = Math.max(0, available - visibleWidth(fittedAgent));
    fittedDescription = descriptionAllowance > 0
      ? (visibleWidth(description) > descriptionAllowance
        ? truncateToWidth(description, descriptionAllowance, "…") : description)
      : "";
  } else if (visibleWidth(safeAgent) > available) {
    fittedAgent = available > 0 ? truncateToWidth(safeAgent, available, "…") : "";
  }

  const identity = options.color
    ? tintAgentColor(options.color, themedBold(theme, fittedAgent))
    : themedFg(theme, "text", fittedAgent);
  let line = themedFg(theme, options.tone, prefix) + identity;
  if (state) line += themedFg(theme, "muted", state);
  if (fittedDescription) line += themedFg(theme, "accent", ` - ${fittedDescription}`);
  for (const segment of required) line += themedFg(theme, segment.tone ?? "muted", `${segment.separator}${segment.text}`);
  for (const segment of optional) line += themedFg(theme, segment.tone ?? "muted", `${segment.separator}${segment.text}`);
  if (options.cue) line += themedFg(theme, "muted", ` · ${options.cue}`);
  if (options.cue && visibleWidth(line) <= columns) metadata && (metadata.cueAppended = true);
  return clampLines([line], columns);
}

function retainedOutcomeLines(
  theme: unknown,
  details: SubagentRenderDetails,
  width: number,
): string[] {
  const agentId = agentIdOf(details);
  if (details.retainedOutcome !== true || !agentId || details.retainedCount === undefined || width < DETAIL_USABLE_WIDTH) {
    return [];
  }
  const lines: string[] = [];
  pushColored(theme, "warning", `agent: ${agentId} · ${details.retainedCount} retained input occurrence(s)`, width, lines);
  pushColored(theme, "muted", `TaskOutput with task_id "${agentId}"`, width, lines);
  return lines;
}

function meaningfulIdentityFragment(text: string, width: number): string {
  if (width <= 0) return "";
  const fitted = truncateToWidth(text, width, "…");
  const fittedPlain = fitted.replace(/\u001b\[[0-9;]*m/gu, "");
  if (fittedPlain.replace(/…/gu, "").trim()) return fitted;
  try {
    const first = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)[Symbol.iterator]().next().value?.segment ?? "";
    return first.trim() && visibleWidth(first) <= width ? first : "";
  } catch {
    return "";
  }
}

interface CollapsedRecordLines {
  lines: string[];
  cueAppended: boolean;
}

function semanticTerminalLine(
  theme: unknown,
  details: SubagentRenderDetails,
  state: string,
  prefix: string,
  tone: string,
  exceptional: LifecycleSegment[],
  width: number,
  expansionCue: string,
  color?: AgentColorName,
): CollapsedRecordLines {
  if (!Number.isFinite(width) || width <= 0) return { lines: [], cueAppended: false };
  const columns = Math.floor(width);
  const marker = prefix.trim();
  if (marker && columns <= visibleWidth(marker)) {
    return { lines: clampLines([themedFg(theme, tone, marker)], columns), cueAppended: false };
  }

  const safeAgent = sanitizeInline(details.agent ?? "") || "subagent";
  const stateText = `[${state}]`;
  const markerText = prefix.trim();
  const styledMarker = markerText ? themedFg(theme, tone, markerText) : "";
  const markerGap = markerText ? " " : "";
  const fullIdentityState = `${markerGap}${safeAgent} ${stateText}`;
  let line = styledMarker;
  let used = visibleWidth(markerText);

  if (visibleWidth(fullIdentityState) <= columns - used) {
    const styledIdentity = color
      ? tintAgentColor(color, themedBold(theme, safeAgent))
      : themedFg(theme, "text", safeAgent);
    line += markerGap + styledIdentity + themedFg(theme, "muted", ` ${stateText}`);
    used += visibleWidth(fullIdentityState);
  } else {
    const stateOnly = `${markerGap}${stateText}`;
    if (visibleWidth(stateOnly) <= columns - used) {
      const identityRoom = columns - used - visibleWidth(markerGap + ` ${stateText}`);
      const fittedAgent = meaningfulIdentityFragment(safeAgent, identityRoom);
      if (fittedAgent) {
        const styledIdentity = color
          ? tintAgentColor(color, themedBold(theme, fittedAgent))
          : themedFg(theme, "text", fittedAgent);
        line += markerGap + styledIdentity + themedFg(theme, "muted", ` ${stateText}`);
        used += visibleWidth(markerGap + fittedAgent + ` ${stateText}`);
      } else {
        line += themedFg(theme, "muted", stateOnly);
        used += visibleWidth(stateOnly);
      }
    } else {
      let identityGap = markerGap;
      let identityRoom = columns - used - visibleWidth(identityGap);
      let fittedAgent = meaningfulIdentityFragment(safeAgent, identityRoom);
      if (!fittedAgent && identityGap) {
        identityGap = "";
        identityRoom = columns - used;
        fittedAgent = meaningfulIdentityFragment(safeAgent, identityRoom);
      }
      if (!fittedAgent) return { lines: clampLines([line], columns), cueAppended: false };
      const styledIdentity = color
        ? tintAgentColor(color, themedBold(theme, fittedAgent))
        : themedFg(theme, "text", fittedAgent);
      line += identityGap + styledIdentity;
      return { lines: clampLines([line], columns), cueAppended: false };
    }
  }

  // Fit each priority class before considering the next. If a textual class
  // needs truncation, it consumes the remaining room and all lower classes drop.
  const appendText = (separator: string, text: string, slot: string, elastic: boolean): boolean => {
    const remaining = columns - used;
    const full = separator + text;
    if (visibleWidth(full) <= remaining) {
      line += themedFg(theme, slot, full);
      used += visibleWidth(full);
      return true;
    }
    if (!elastic || remaining <= visibleWidth(separator)) return false;
    const fitted = truncateToWidth(text, remaining - visibleWidth(separator), "…");
    const meaningful = fitted.replace(/\u001b\[[0-9;]*m/gu, "").replace(/…/gu, "").trim();
    if (meaningful) line += themedFg(theme, slot, separator + fitted);
    used = columns;
    return false;
  };

  for (const segment of exceptional) {
    if (!appendText(segment.separator, segment.text, segment.tone ?? "muted", true)) {
      return { lines: clampLines([line], columns), cueAppended: false };
    }
  }
  const description = sanitizeInline(details.description ?? "");
  if (description && !appendText(" - ", description, "accent", true)) {
    return { lines: clampLines([line], columns), cueAppended: false };
  }

  const remaining = columns - used;
  const binding = expansionCue.endsWith(" to expand")
    ? expansionCue.slice(0, -" to expand".length)
    : expansionCue;
  const cue = [expansionCue, binding].find((candidate) =>
    candidate.length > 0 && visibleWidth(` · ${candidate}`) <= remaining,
  );
  const cueWidth = cue ? visibleWidth(` · ${cue}`) : 0;
  const duration = durationOf(details);
  const includeDuration = cue !== undefined && duration !== undefined &&
    visibleWidth(` · ${duration}`) <= remaining - cueWidth;
  // Selection gives the cue priority, while full rows retain the established
  // description · duration · cue reading order.
  if (includeDuration && duration) appendText(" · ", duration, "muted", false);
  if (cue) appendText(" · ", cue, "muted", false);
  return { lines: clampLines([line], columns), cueAppended: cue !== undefined };
}

/** Semantic collapsed grammar for terminal TaskOutput and settlement records. */
function ensureVisibleExpansionCue(
  theme: unknown,
  collapsed: CollapsedRecordLines,
  expansionCue: string,
  width: number,
): string[] | undefined {
  const binding = expansionCue.endsWith(" to expand")
    ? expansionCue.slice(0, -" to expand".length)
    : expansionCue;
  const candidates = [expansionCue, binding].filter(
    (candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index,
  );
  if (collapsed.cueAppended) return collapsed.lines;
  const separate = candidates.find((candidate) => visibleWidth(candidate) <= width);
  return separate ? [...collapsed.lines, themedFg(theme, "muted", separate)] : undefined;
}

function collapsedRecordLines(
  theme: unknown,
  details: SubagentRenderDetails,
  outcome: "completed" | "failed" | "aborted",
  _chip: string | undefined,
  width: number,
  expansionCue: string,
  suppressSymbol = false,
  color?: AgentColorName,
  semanticTerminal = true,
): CollapsedRecordLines {
  if (!semanticTerminal) {
    const userStopped = details.userStopped === true;
    const state = userStopped
      ? "stopped by user"
      : outcome === "completed" && details.cutOff === true
        ? "completed (truncated)"
        : outcome === "failed" && details.cutOff === true
          ? "failed (partial output preserved)"
          : outcome;
    const required: LifecycleSegment[] = [];
    const fork = forkDegradeLine(details);
    if (fork) required.push({ separator: " · ", text: RECORD_FORK_MARKER, tone: fork.tone });
    required.push(...diagnosticSegments(details));
    if (outcome === "failed" && details.error) {
      required.push({ separator: " · ", text: truncateToWidth(sanitizeInline(details.error), COLLAPSED_ERROR_CAP, "…"), tone: "error", elastic: true });
    }
    const optional: LifecycleSegment[] = [];
    const duration = durationOf(details);
    if (duration) optional.push({ separator: " · ", text: duration });
    const usage = formatUsageBrief(details.usage);
    if (usage) optional.push({ separator: " · ", text: usage });
    const completionTime = completionTimeOf(details);
    if (completionTime) optional.push({ separator: " · ", text: completionTime });
    const metadata = { cueAppended: false };
    const lines = lifecycleLine(theme, {
      agent: details.agent,
      state,
      ...((outcome !== "completed" || userStopped) ? { prefix: suppressSymbol ? "" : outcome === "failed" && !userStopped ? "✗ " : "■ " } : {}),
      cue: expansionCue,
      required,
      optional,
      tone: outcome === "completed" ? "success" : outcome === "failed" && !userStopped ? "error" : "warning",
      color,
    }, width, metadata);
    return { lines, cueAppended: metadata.cueAppended };
  }
  if (outcome === "completed") {
    const fork = forkDegradeLine(details);
    return semanticTerminalLine(
      theme,
      details,
      details.cutOff === true ? "completed (truncated)" : "completed",
      suppressSymbol ? "" : "● ",
      "success",
      [
        ...(fork ? [{ separator: " · " as const, text: RECORD_FORK_MARKER }] : []),
        ...diagnosticSegments(details),
      ],
      width,
      expansionCue,
      color,
    );
  }

  const userStopped = details.userStopped === true;
  const state = userStopped
    ? "stopped by user"
    : outcome === "failed" && details.cutOff === true
      ? "failed (partial output preserved)"
      : outcome;
  const symbol = outcome === "failed" && !userStopped ? "✗" : "■";
  const tone = outcome === "failed" && !userStopped ? "error" : "warning";
  const required: LifecycleSegment[] = [];
  const fork = forkDegradeLine(details);
  if (fork) required.push({ separator: " · ", text: RECORD_FORK_MARKER, tone: fork.tone });
  required.push(...diagnosticSegments(details));
  if (outcome === "failed") {
    const error = sanitizeInline(typeof details.error === "string" ? details.error : "");
    if (error) {
      required.push({
        separator: " · ",
        text: truncateToWidth(error, COLLAPSED_ERROR_CAP, "…"),
        tone: "error",
        elastic: true,
      });
    }
  }

  return semanticTerminalLine(
    theme,
    details,
    state,
    suppressSymbol ? "" : `${symbol} `,
    tone,
    required,
    width,
    expansionCue,
    color,
  );
}

/**
 * The single running-status line shared by streaming partials and wait:false
 * polls: identity, state, and available metadata only. The panel/detail surface
 * owns live activity.
 */
function runningStatusLines(
  theme: unknown,
  chip: string | undefined,
  agent: string,
  details: SubagentRenderDetails,
  width: number,
  color?: AgentColorName,
  description?: string,
  semanticTaskId?: string,
): string[] {
  const duration = durationOf(details);
  const usage = formatUsageBrief(details.usage ?? details.subagentProgress?.usage);
  if (semanticTaskId && chip === semanticTaskId) {
    const safeAgent = sanitizeInline(agent) || "subagent";
    const safeDescription = sanitizeInline(description ?? "");
    const primary = safeDescription || safeAgent || chip;
    const optional = [
      ...(safeDescription && safeAgent !== primary ? [safeAgent] : []),
      ...(chip !== primary ? [chip] : []),
      ...(duration ? [duration] : []),
      ...(usage ? [usage] : []),
    ];
    const identityTheme = color ? {
      fg(slot: string, text: string) {
        if (text === safeAgent) {
          return tintAgentColor(color, themedBold(theme, text));
        }
        return themedFg(theme, slot, text);
      },
    } : theme;
    return semanticDisplayRow({
      action: formatToolDisplayName("TaskOutput"),
      primary,
      required: [{
        text: details.admission === "waiting" ? "waiting for capacity" : "running",
        tone: "muted",
      }],
      optional,
    }, identityTheme).render(width);
  }

  const optional: LifecycleSegment[] = [];
  if (duration) optional.push({ separator: " · ", text: duration });
  if (usage) optional.push({ separator: " · ", text: usage });
  return lifecycleLine(theme, {
    agent,
    ...(chip ? { chip } : {}),
    state: details.admission === "waiting" ? "waiting for capacity" : "running",
    optional,
    tone: "muted",
    color,
  }, width);
}

/**
 * Strip the model-facing agent-ID trailer off the HUMAN-rendered
 * body. The model still reads `result.content` verbatim (trailer included); only
 * this local display copy drops it, so the footer can present the ID + a single
 * resumable hint without the raw `---`/`[agent …]` plumbing showing up too.
 * Case 1: a completed trailer opened its own `\n\n---\n` frame — drop the frame.
 * Case 2: a truncated-completed trailer rode inside an existing cut-off frame
 * with a single `\n` prefix — drop only the trailer line, keeping the cut-off frame.
 */
function stripAgentTrailerForDisplay(text: string): string {
  const framed = text.replace(/\n\n---\n\[agent agent-[0-9a-f]{12}[^\]\n]*\]\s*$/, "");
  if (framed !== text) return framed;
  return text.replace(/\n\[agent agent-[0-9a-f]{12}[^\]\n]*\]\s*$/, "");
}

/**
 * Strip the leading self-identification (`Background task task-N (type,
 * agent-<id>) failed: ` / `… was aborted — `) from the DISPLAY body of a failed
 * or aborted TaskOutput result — the lifecycle header and expanded identity footer already state it,
 * so the body would otherwise repeat it. The reason/tail is kept (`connection
 * reset`, the `it was stopped before completing…` clause). Display-only: the
 * model-facing content stays self-identifying for print/RPC.
 */
function stripTaskIdentityPrefix(text: string, taskId: string, outcome: string): string {
  const esc = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `\(.*?\)` is non-greedy but MUST be followed by the literal suffix, so nested
  // parens in a label (e.g. `foo(bar)`) don't cause a premature match. The subject
  // is a single sanitized line, so `.` never crosses the newline into the reason.
  if (outcome === "failed") {
    return text.replace(new RegExp(`^Background task ${esc} \\(.*?\\) failed: `), "");
  }
  if (outcome === "aborted") {
    return text.replace(new RegExp(`^Background task ${esc} \\(.*?\\) was aborted — `), "");
  }
  return text;
}

/** renderCall: one mode-neutral pending invocation until a result owns the row. */
export function renderAgentCall(
  args: Record<string, unknown>,
  theme: unknown,
  context?: SubagentLifecycleRenderContext,
  options: SubagentRenderingOptions = {},
) {
  const agentType = sanitizeInline(boundedString(safeField(args, "subagent_type")) ?? "") || "general-purpose";
  const description = sanitizeInline(boundedString(safeField(args, "description")) ?? "");
  const color = resolvedAgentColor(options, {}, agentType);
  return {
    render(width: number): string[] {
      if (safeField(safeField(context, "state"), "resultOwned") === true) return [];
      return lifecycleLine(
        theme,
        {
          agent: agentType,
          state: "",
          description,
          tone: "text",
          color,
        },
        width,
      );
    },
  };
}

function lifecycleToolRowOutcome(
  details: SubagentRenderDetails,
  isPartial: boolean,
): ToolRowOutcome | undefined {
  if (details.userStopped === true) return "stopped";
  if (isPartial) return "running";
  if (details.background === true) return "success";
  if (details.taskId !== undefined && details.status === "running") return "running";
  if (details.outcome === "completed") return "success";
  if (details.outcome === "failed") return "failure";
  if (details.outcome === "aborted") return "stopped";
  return undefined;
}

/**
 * renderResult (REQUIRED). Two modes:
 *  - PARTIAL (streaming): ONE identity/state/metadata line; the status panel
 *    and its drill-down own live activity.
 *  - FINAL: terminal TaskOutput/settlement rows use the semantic priority
 *    grammar; foreground Agent rows retain their established telemetry grammar.
 *    The configured app.tools.expand action exposes the applicable body and
 *    operational footer.
 */
export function renderAgentResult(
  result: unknown,
  renderOptions: unknown,
  theme: unknown,
  context?: SubagentLifecycleRenderContext,
  presentation: SubagentRenderPresentation = {},
) {
  const state = safeField(context, "state");
  if (isRecord(state)) {
    try {
      Reflect.set(state, "resultOwned", true);
    } catch {
      // Per-call renderer state is an optimization; hostile state degrades safely.
    }
  }
  const rawDetails = safeField(result, "details");
  const details = normalizeSubagentRenderDetails(rawDetails) ?? {};
  const isPartial = safeField(renderOptions, "isPartial") === true;
  const expanded = safeField(renderOptions, "expanded");
  const expansion = piToolsExpandKeyText();
  const expansionKey = expansion.available ? sanitizeInline(expansion.value) : "";
  const expansionCue = expansionKey ? `${expansionKey} to expand` : undefined;
  const acceptedBackground = suppressibleAgentAcceptance(
    result, rawDetails, renderOptions, context, presentation.surface,
  );
  const taskOutputDelivery = canonicalTaskOutputDelivery(result, renderOptions, context, presentation.surface);
  const reportedTerminal = taskOutputDelivery === "reported";
  const firstTerminal = taskOutputDelivery === "first";
  const malformedBackground = presentation.surface === "agent" && safeField(rawDetails, "background") === true &&
    !acceptedBackground;
  const terminalTaskStatus = details.status === "completed" || details.status === "failed" || details.status === "stopped";
  const malformedTaskOutput = presentation.surface === "task-output" && !firstTerminal && !reportedTerminal &&
    (terminalTaskStatus || hasOwnField(rawDetails, "outcome") || hasOwnField(rawDetails, "alreadyReported") ||
      (hasOwnField(result, "details") && ownDataSnapshot(rawDetails, Object.prototype) === undefined));
  if (malformedBackground || malformedTaskOutput) {
    const failedEvidence = safeField(context, "isError") === true || safeField(result, "isError") === true ||
      safeField(result, "error") === true || typeof safeField(result, "error") === "string" ||
      details.status === "failed" || details.outcome === "failed" || typeof safeField(rawDetails, "error") === "string";
    const stoppedEvidence = details.status === "stopped" || details.outcome === "aborted" || details.userStopped === true;
    const failOpenOutcome: ToolRowOutcome | undefined = failedEvidence
      ? "failure"
      : stoppedEvidence ? "stopped" : undefined;
    if (failOpenOutcome) setToolRowOutcome(context, failOpenOutcome);
    const requestedTarget = taskOutputTarget(context, {});
    return {
      render(width: number): string[] {
        try {
          const lines: string[] = [];
          if (presentation.surface === "task-output" && requestedTarget) {
            lines.push(...lifecycleLine(theme, {
              agent: "subagent",
              chip: requestedTarget,
              state: "result",
              tone: failOpenOutcome === "failure" ? "error" : failOpenOutcome === "stopped" ? "warning" : "muted",
            }, width));
          }
          if (width < DETAIL_USABLE_WIDTH) {
            if (lines.length === 0) lines.push(...lifecycleLine(theme, {
              agent: "subagent", state: "result", tone: failOpenOutcome === "failure" ? "error" : "muted",
            }, width));
            if (width >= RESIZE_GUIDANCE.length) lines.push(themedFg(theme, "muted", RESIZE_GUIDANCE));
            return clampLines(lines, width);
          }
          const evidence = humanDisplayText(boundedBodyText(result), false);
          if (evidence) pushBodyText(evidence, width, lines);
          else pushWrapped("unrecognized lifecycle result", width, lines);
          return clampLines(lines, width);
        } catch {
          const fallback = humanDisplayText("unrecognized lifecycle result", false);
          return clampLines([truncateToWidth(fallback, Math.max(0, width), "…")], width);
        }
      },
    };
  }
  const lifecycleOutcome = presentation.surface === "task-output" && !isPartial && details.outcome !== undefined && !firstTerminal
    ? undefined
    : lifecycleToolRowOutcome(details, isPartial);
  const shellOwnsSymbol = lifecycleOutcome === undefined
    ? false
    : setToolRowOutcome(context, lifecycleOutcome);
  if (presentation.surface === "task-output" && typeof details.outcome === "string") {
    useTightToolRowMarker(context);
  }
  const rowSuppressed = (acceptedBackground || reportedTerminal) && suppressToolRow(context);
  const agentName = sanitizeInline(typeof details.agent === "string" ? details.agent : "") || "subagent";
  const color = resolvedAgentColor(presentation, details, agentName);
  const explicitTask = presentation.surface === "task-output" ||
    (presentation.surface === undefined && details.taskId !== undefined);
  const explicitTarget = explicitTask ? taskOutputTarget(context, details) : undefined;
  const semanticTaskId = explicitTask ? correlatedRunningTaskId(rawDetails, context) : undefined;
  const correlatedFallback = presentation.awaitedTaskOutputFallback;
  const resultDescription = semanticTaskId ? sanitizeInline(details.description ?? "") : "";
  const runningDescription = resultDescription ||
    (correlatedFallback && semanticTaskId === correlatedFallback.taskId
      ? sanitizeInline(correlatedFallback.description)
      : "");
  return {
    render(width: number): string[] {
      if (rowSuppressed) return [];
      const lines: string[] = [];
      if (isPartial) {
        // SECURITY: details.agent originates from the model-supplied subagent_type — sanitize.
        const agent = sanitizeInline(typeof details.agent === "string" ? details.agent : "") || "subagent";
        const chip = explicitTarget;
        if (details.userStopped === true) {
          return lifecycleLine(
            theme,
            { agent, ...(chip ? { chip } : {}), state: "stopped by user", tone: "warning", color },
            width,
          );
        }
        return runningStatusLines(theme, chip, agent, details, width, color, runningDescription, semanticTaskId);
      }
      // Final result. Valid Agent acceptance disappears only when trusted
      // suppression succeeded above; unbranded/direct callers retain fail-open
      // evidence. Malformed acceptance already returned generic evidence, while
      // legacy non-Agent background records retain passive status presentation.
      if (details.background === true && presentation.surface === undefined) {
        return lifecycleLine(theme, {
          agent: agentName,
          state: "background",
          description: details.description,
          tone: "muted",
          color,
        }, width);
      }
      // A wait:false poll on a RUNNING task renders one self-identifying
      // state/metadata line, never activity or a rolling tail. Gated on taskId (a foreground
      // final never carries status:"running").
      const chip = explicitTarget;
      if (chip && details.status === "running") {
        const agent =
          sanitizeInline(typeof details.agent === "string" ? details.agent : "") || "subagent";
        return runningStatusLines(theme, chip, agent, details, width, color, runningDescription, semanticTaskId);
      }
      const outcome = typeof details.outcome === "string" ? details.outcome : undefined;
      const semanticTerminal = (presentation.surface === "task-output" && firstTerminal) || presentation.surface === "settlement" ||
        (presentation.surface === undefined && details.taskId !== undefined);
      const boundedResizeRecord = (): string[] => {
        const collapsed = collapsedRecordLines(
          theme, details, outcome as "completed" | "failed" | "aborted", undefined, width,
          expansionCue ?? RECORD_EXPAND_HINT, shellOwnsSymbol, color,
          semanticTerminal || details.retainedOutcome === true,
        );
        const first = collapsed.lines.slice(0, 1);
        if (width >= RESIZE_GUIDANCE.length) first.push(themedFg(theme, "muted", RESIZE_GUIDANCE));
        return clampLines(first, width);
      };
      if (outcome && width < DETAIL_USABLE_WIDTH &&
          (details.retainedOutcome === true || expanded !== false || !expansionCue)) {
        return boundedResizeRecord();
      }
      let failOpenCollapsed = false;
      // Collapsed by default in the interactive transcript: Pi always passes a
      // BOOLEAN `expanded` (false until the configured app.tools.expand action),
      // so the collapse keys on the EXPLICIT false. A structural caller that
      // omits the option gets the full record — print/RPC never run renderers,
      // so this only widens compatibility for direct callers.
      if (outcome && expanded === false && expansionCue) {
        const collapsed = collapsedRecordLines(
          theme, details, outcome, undefined, width, expansionCue, shellOwnsSymbol, color,
          semanticTerminal || details.retainedOutcome === true,
        );
        const accessible = ensureVisibleExpansionCue(theme, collapsed, expansionCue, width);
        if (accessible) {
          return clampLines([...accessible, ...retainedOutcomeLines(theme, details, width)], width);
        }
        if (width < DETAIL_USABLE_WIDTH) return boundedResizeRecord();
        lines.push(...collapsed.lines, ...retainedOutcomeLines(theme, details, width));
        failOpenCollapsed = true;
      }
      if (!outcome && explicitTarget) {
        lines.push(...lifecycleLine(theme, {
          agent: agentName,
          chip: explicitTarget,
          state: details.status ?? "result",
          tone: safeField(context, "isError") === true ? "error" : "muted",
          color,
        }, width));
      }
      if (outcome && !failOpenCollapsed) {
        const userStopped = details.userStopped === true;
        const lifecycleState = userStopped
          ? "stopped by user"
          : outcome === "completed" && details.cutOff === true
            ? "completed (truncated)"
            : outcome === "failed" && details.cutOff === true
              ? "failed (partial output preserved)"
              : outcome;
        const tone = outcome === "completed" ? "success" : outcome === "failed" && !userStopped ? "error" : "warning";
        const symbol = outcome === "completed" ? "● " : outcome === "failed" && !userStopped ? "✗ " : "■ ";
        lines.push(...lifecycleLine(theme, {
          agent: agentName,
          state: lifecycleState,
          prefix: shellOwnsSymbol ? "" : symbol,
          tone,
          color,
        }, width));
        lines.push(...retainedOutcomeLines(theme, details, width));
      }
      // SECURITY: the model reads result.content verbatim. The human copy strips
      // the machine-facing identity trailer and sanitizes controls; the applicable
      // expanded footer retains the identity without mutating canonical content.
      // TaskOutput's completed content appends a
      // `\nusage: …` line AFTER the agent-ID trailer, which would defeat the
      // end-anchored trailer strip (raw trailer shown + usage rendered twice).
      // Drop that trailing usage line from the DISPLAY body first — the footer
      // re-renders usage from details.usage. GATED ON taskId (only TaskOutput
      // appends this line) so a FOREGROUND agent whose final message legitimately
      // ends in a `usage:` line is never mutilated; and on details.usage so a
      // background task with none keeps a genuine trailing `usage:` body line.
      // TaskOutput appends usage after every other canonical frame. Account for
      // that production envelope first, then strip the exact MCP qualification;
      // diagnostics render each availability/cleanup warning once for humans.
      let displaySource = boundedBodyText(result);
      if (details.taskId != null && details.usage != null) {
        displaySource = displaySource.replace(/\nusage:[^\n]*$/, "");
      }
      displaySource = stripCanonicalMcpQualification(displaySource, details);
      // Terminal TaskOutput headers already carry semantic identity, so remove
      // the canonical failed/aborted prose prefix from this display-only body.
      if (chip && (outcome === "failed" || outcome === "aborted")) {
        displaySource = stripTaskIdentityPrefix(displaySource, String(details.taskId), outcome);
      }
      const body = humanDisplayText(stripAgentTrailerForDisplay(displaySource), false);
      if (body) pushBodyText(body, width, lines);
      const errorSource = typeof details.error === "string" ? details.error : "";
      const errorDetail = sanitizeInline(errorSource);
      if (errorDetail && !containsEquivalentErrorFraming(body, errorSource)) {
        pushColored(theme, "error", errorDetail, width, lines);
      }
      const footer: string[] = [];
      const stableAgentId = agentIdOf(details);
      if (typeof details.description === "string" && details.description) {
        footer.push(`description: ${sanitizeInline(details.description)}`);
      }
      if (semanticTerminal && isTaskId(details.taskId)) footer.push(`task: ${details.taskId}`);
      if (stableAgentId && (semanticTerminal || outcome === "failed")) footer.push(`agent: ${stableAgentId}`);
      if (typeof details.transcriptPath === "string" && details.transcriptPath) {
        // UX: a full session path is often far wider than the terminal and wraps
        // into unreadable, hard-sliced fragments. Show it whole only when it fits;
        // otherwise show the basename (the agent id + .jsonl — what a human uses to
        // find the file), marked with a leading ellipsis. The model still gets the
        // full path via result.content / the transcript details, so nothing is lost.
        const tp = sanitizeInline(details.transcriptPath);
        const full = `transcript: ${tp}`;
        if (visibleWidth(full) <= width) {
          footer.push(full);
        } else {
          const sep = tp.includes("\\") ? "\\" : "/";
          const base = tp.split(/[\\/]/).pop() || tp;
          footer.push(`transcript: …${sep}${base}`);
        }
      }
      const duration = durationOf(details);
      if (duration) footer.push(`duration: ${duration}`);
      const usage = formatUsageLine(details.usage);
      if (usage) footer.push(`usage: ${usage}`);
      if (details.resumable === true && outcome !== "failed") {
        footer.push(!semanticTerminal && stableAgentId
          ? `resumable via SendMessage — agent ${stableAgentId}`
          : "resumable via SendMessage");
      }
      // Wrap each footer line to width (word-wrap, ANSI-aware) as a final guard.
      for (const f of footer) pushColored(theme, "muted", f, width, lines);
      pushDiagnosticDetails(theme, details, width, lines);
      // A degraded fork's fork-specific notice — its own footer line, toned
      // calm (muted) for an expected opt-out and `warning` for a genuine can't-do,
      // so the developer sees WHY a "fork" ran with fresh context (the row above
      // already uses the fresh agent identity, not `fork`).
      const forkLine = forkDegradeLine(details);
      if (forkLine) pushColored(theme, forkLine.tone, sanitizeInline(forkLine.text), width, lines);
      return clampLines(lines.length ? lines : [""], width);
    },
  };
}

/** Render a lowercase TaskOutput action row while preserving its complete target. */
export function renderTaskOutputCall(
  args: Record<string, unknown>,
  theme: unknown,
  context?: SubagentLifecycleRenderContext,
) {
  const taskId = sanitizeInline(boundedString(safeField(args, "task_id")) ?? "");
  const action = safeField(args, "wait") === false ? "polling" : "awaiting";
  return {
    render(width: number): string[] {
      if (safeField(safeField(context, "state"), "resultOwned") === true) return [];
      if (!Number.isFinite(width) || width <= 0) return [];
      const target = taskId ? ` ${taskId}` : "";
      const line = themedFg(theme, "text", formatToolDisplayName("TaskOutput")) +
        themedFg(theme, "accent", target) + themedFg(theme, "muted", ` [${action}]`);
      try { return wrapTextWithAnsi(line, Math.max(1, Math.floor(width))); }
      catch { return wrapTextWithAnsi(`${formatToolDisplayName("TaskOutput")}${target} [${action}]`, Math.max(1, Math.floor(width))); }
    },
  };
}

export function renderTaskStopCall(
  args: Record<string, unknown>,
  theme: unknown,
  context?: SubagentLifecycleRenderContext,
) {
  const target = sanitizeInline(boundedString(safeField(args, "task_id")) ?? "");
  return {
    render(width: number): string[] {
      if (safeField(safeField(context, "state"), "resultOwned") === true) return [];
      if (!Number.isFinite(width) || width <= 0) return [];
      const line = themedFg(theme, "text", formatToolDisplayName("TaskStop")) +
        themedFg(theme, "accent", target ? ` ${target}` : "");
      try { return wrapTextWithAnsi(line, Math.max(1, Math.floor(width))); }
      catch { return wrapTextWithAnsi(`${formatToolDisplayName("TaskStop")}${target ? ` ${target}` : ""}`, Math.max(1, Math.floor(width))); }
    },
  };
}

type LifecycleControlResult = {
  content?: Array<{ type?: string; text?: string }>;
  details?: Record<string, unknown>;
};

function lifecycleControlComponent(
  result: LifecycleControlResult,
  theme: unknown,
  context: SubagentLifecycleRenderContext | undefined,
  outcome: ToolRowOutcome | undefined,
) {
  if (outcome !== undefined) setToolRowOutcome(context, outcome);
  return genericResultComponent(result, theme, context ?? {});
}

type SendMessageCallSnapshot = Readonly<{ valid: boolean; to?: string }>;

type OrdinarySendMessage = Readonly<{
  to: string;
  agent: string;
  agentId: string;
  delivery: "steer" | "resume";
  admission?: SubagentAdmission;
  taskId?: string;
}>;

type CheckpointRecoverySendMessage = Readonly<{
  to: string;
  outcome: "completed" | "failed" | "aborted";
  recovered: boolean;
  truncated: boolean;
}>;

type DescriptorSnapshot = Readonly<Record<PropertyKey, PropertyDescriptor>>;

const sendMessageCalls = new WeakMap<object, SendMessageCallSnapshot>();
const producedSendMessageResults = new WeakMap<object, SendMessageCallSnapshot>();

/** Associate an execution-produced result with its already-resolved recipient without changing it. */
export function rememberSendMessageResult<T extends object>(result: T, to: string): T {
  producedSendMessageResults.set(result, Object.freeze({ valid: true, to }));
  return result;
}

function invocationState(context: SubagentLifecycleRenderContext | undefined): object | undefined {
  const state = safeField(context, "state");
  if ((typeof state !== "object" && typeof state !== "function") || state === null) return undefined;
  try {
    const prototype = Reflect.getPrototypeOf(state);
    return prototype === Object.prototype || prototype === null ? state : undefined;
  } catch {
    return undefined;
  }
}

/** Take one detached own-descriptor snapshot; validation never reads the source object again. */
function descriptorSnapshot(value: unknown, prototype: object): DescriptorSnapshot | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    if (Reflect.getPrototypeOf(value) !== prototype) return undefined;
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return undefined;
  }
}

function exactDataDescriptors(
  snapshot: DescriptorSnapshot | undefined,
  expected: readonly string[],
): snapshot is DescriptorSnapshot {
  if (!snapshot) return false;
  const keys = Reflect.ownKeys(snapshot);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string" || !expected.includes(key))) return false;
  return expected.every((key) => {
    const descriptor = snapshot[key];
    return descriptor !== undefined && "value" in descriptor && descriptor.writable === true &&
      descriptor.enumerable === true && descriptor.configurable === true;
  });
}

function exactArraySnapshot(value: unknown): DescriptorSnapshot | undefined {
  if (!safeArray(value)) return undefined;
  const snapshot = descriptorSnapshot(value, Array.prototype);
  if (!snapshot || !exactDataDescriptors(
    Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "length")),
    ["0"],
  )) return undefined;
  const keys = Reflect.ownKeys(snapshot);
  const length = snapshot.length;
  if (keys.length !== 2 || keys.some((key) => key !== "0" && key !== "length") || !length || !("value" in length) ||
    length.value !== 1 || length.writable !== true || length.enumerable !== false || length.configurable !== false) return undefined;
  return snapshot;
}

/** Capture only recipient validity; message text remains solely in canonical arguments. */
export function renderSendMessageCall(
  args: Record<string, unknown>,
  _theme: unknown,
  context?: SubagentLifecycleRenderContext,
) {
  let snapshot: SendMessageCallSnapshot = Object.freeze({ valid: false });
  const descriptors = descriptorSnapshot(args, Object.prototype);
  if (exactDataDescriptors(descriptors, ["to", "message"])) {
    const to = descriptors.to!.value;
    const message = descriptors.message!.value;
    if (typeof to === "string" && typeof message === "string") snapshot = Object.freeze({ valid: true, to });
  }
  const state = invocationState(context);
  if (state) sendMessageCalls.set(state, snapshot);
  return { render(_width: number): string[] { return []; } };
}

function exactSendMessageEnvelope(result: unknown): {
  text: string;
  details: DescriptorSnapshot;
} | undefined {
  const envelope = descriptorSnapshot(result, Object.prototype);
  const envelopeKeys = envelope ? Reflect.ownKeys(envelope) : [];
  const allowedKeys = new Set(["content", "details", "terminate", "isError"]);
  if (!envelope || envelopeKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key)) ||
    !envelopeKeys.includes("content") || !envelopeKeys.includes("details") ||
    !exactDataDescriptors(envelope, envelopeKeys as string[]) ||
    (envelope.terminate !== undefined && envelope.terminate.value !== true) ||
    (envelope.isError !== undefined && envelope.isError.value !== false)) return undefined;

  const content = exactArraySnapshot(envelope.content!.value);
  const block = content ? descriptorSnapshot(content["0"]!.value, Object.prototype) : undefined;
  if (!exactDataDescriptors(block, ["type", "text"]) || block.type!.value !== "text" ||
    typeof block.text!.value !== "string") return undefined;
  const details = descriptorSnapshot(envelope.details!.value, Object.prototype);
  return details ? { text: block.text!.value as string, details } : undefined;
}

function capturedSendMessageCall(
  context: SubagentLifecycleRenderContext | undefined,
  result?: unknown,
): SendMessageCallSnapshot | undefined {
  const state = invocationState(context);
  const fromCall = state ? sendMessageCalls.get(state) : undefined;
  if (fromCall) return fromCall;
  return (typeof result === "object" && result !== null) ? producedSendMessageResults.get(result) : undefined;
}

function recognizeOrdinarySendMessage(
  result: unknown,
  context: SubagentLifecycleRenderContext | undefined,
): OrdinarySendMessage | undefined {
  if (safeField(context, "isError") !== false) return undefined;
  const call = capturedSendMessageCall(context, result);
  if (!call?.valid || typeof call.to !== "string") return undefined;
  const envelope = exactSendMessageEnvelope(result);
  if (!envelope) return undefined;

  const { details, text } = envelope;
  const delivery = details.delivery?.value;
  const baseKeys = ["agentId", "agent", "delivery"];
  const keys = delivery === "steer"
    ? baseKeys
    : delivery === "resume"
      ? [...baseKeys, "taskId", "admission", "resumed"]
      : [];
  if (details.description) keys.push("description");
  if (!exactDataDescriptors(details, keys)) return undefined;

  const agentId = details.agentId!.value;
  const agent = details.agent!.value;
  const description = details.description?.value;
  if (typeof agentId !== "string" || !isAgentId(agentId) || typeof agent !== "string" ||
    (description !== undefined && typeof description !== "string") ||
    (call.to !== agentId && call.to !== agent)) return undefined;

  if (delivery === "steer") {
    const expected = `Message delivered to running agent ${agentId} ("${agent}") as a mid-task course correction.`;
    return text === expected ? { to: call.to, agent, agentId, delivery } : undefined;
  }
  if (delivery === "resume") {
    const taskId = details.taskId!.value;
    const admission = details.admission!.value;
    if (typeof taskId !== "string" || !/^task-[1-9]\d*$/u.test(taskId) ||
      (admission !== "admitted" && admission !== "waiting") || details.resumed!.value !== true) return undefined;
    const expected = `Task(${taskId}) · Agent(${agent}) · ${agentId} — resume accepted in background with prior context; it will run when configured concurrency capacity is available. Retrieve it with TaskOutput (task_id "${taskId}").`;
    return text === expected ? { to: call.to, agent, agentId, delivery, admission, taskId } : undefined;
  }
  return undefined;
}

/** Strictly recognize the descriptor shape emitted by checkpoint recovery without re-reading it. */
function recognizeCheckpointRecoverySendMessage(
  result: unknown,
  context: SubagentLifecycleRenderContext | undefined,
): CheckpointRecoverySendMessage | undefined {
  if (safeField(context, "isError") === true) return undefined;
  const call = capturedSendMessageCall(context, result);
  if (!call?.valid || typeof call.to !== "string") return undefined;
  const envelope = exactSendMessageEnvelope(result);
  if (!envelope || !exactDataDescriptors(envelope.details, [
    "agentId", "agent", "delivery", "outcome", "recovered", "truncated",
  ])) return undefined;
  const agentId = envelope.details.agentId!.value;
  const agent = envelope.details.agent!.value;
  const delivery = envelope.details.delivery!.value;
  const outcome = envelope.details.outcome!.value;
  const recovered = envelope.details.recovered!.value;
  const truncated = envelope.details.truncated!.value;
  if (typeof agentId !== "string" || !isAgentId(agentId) || typeof agent !== "string" ||
    (call.to !== agentId && call.to !== agent) || delivery !== "checkpoint-recovery" ||
    (outcome !== "completed" && outcome !== "failed" && outcome !== "aborted") ||
    typeof recovered !== "boolean" || recovered !== (outcome === "completed") ||
    typeof truncated !== "boolean") return undefined;
  return { to: call.to, outcome, recovered, truncated };
}

function sendMessageSemanticRow(theme: unknown, ordinary: OrdinarySendMessage) {
  const agent = sanitizeInline(ordinary.agent) || "subagent";
  const agentId = sanitizeInline(ordinary.agentId);
  const requested = sanitizeInline(ordinary.to);
  const waiting = ordinary.delivery === "resume" && ordinary.admission === "waiting";
  const required = waiting ? [{ text: "⚠ waiting", tone: "warning" as const }] : [];
  const optional = [
    ordinary.delivery === "steer" ? "delivered" : "resume",
    ...(ordinary.delivery === "resume" && !waiting ? ["admitted"] : []),
    ...(agentId && agentId !== agent ? [agentId] : []),
    ...(requested && requested !== agent && requested !== agentId ? [requested] : []),
    ...(ordinary.taskId ? [ordinary.taskId] : []),
  ];
  return semanticDisplayRow({
    action: formatToolDisplayName("SendMessage"),
    primary: agent,
    required,
    optional,
  }, theme);
}

function sendMessageTargetRow(theme: unknown, target: string, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0 || !target) return [];
  const columns = Math.floor(width);
  const title = `${formatToolDisplayName("SendMessage")} `;
  const includeTitle = visibleWidth(title) + visibleWidth(target) <= columns;
  const room = Math.max(1, columns - (includeTitle ? visibleWidth(title) : 0));
  const fitted = visibleWidth(target) > room ? truncateToWidth(target, room, "…") : target;
  return clampLines([
    (includeTitle ? themedFg(theme, "text", title) : "") + themedFg(theme, "accent", fitted),
  ], columns);
}

function checkpointRecoveryHeader(
  theme: unknown,
  checkpoint: CheckpointRecoverySendMessage,
  width: number,
): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  const columns = Math.floor(width);
  const target = sanitizeInline(checkpoint.to) || "subagent";
  const state = checkpoint.truncated
    ? "truncated"
    : checkpoint.outcome === "completed"
      ? "recovered"
      : checkpoint.outcome;
  const stateSlot = state === "recovered" ? "success" : state === "failed" ? "error" : "warning";
  const suffix = ` · ${state}`;
  const room = columns - visibleWidth(suffix);
  if (room < 1) return clampLines([themedFg(theme, stateSlot, state)], columns);
  const fitted = visibleWidth(target) > room ? truncateToWidth(target, room, "…") : target;
  return clampLines([
    themedFg(theme, "accent", fitted) + themedFg(theme, stateSlot, suffix),
  ], columns);
}

/** Result-owned ordinary summary; every uncertain shape retains generic exceptional evidence. */
export function renderSendMessageResult(
  result: LifecycleControlResult,
  theme: unknown,
  context?: SubagentLifecycleRenderContext,
) {
  const ordinary = recognizeOrdinarySendMessage(result, context);
  if (ordinary) {
    setToolRowOutcome(context, "success");
    return sendMessageSemanticRow(theme, ordinary);
  }

  const checkpoint = recognizeCheckpointRecoverySendMessage(result, context);
  const checkpointOutcome = checkpoint?.outcome === "completed" && checkpoint.truncated === false
    ? "success"
    : checkpoint?.outcome === "aborted"
      ? "stopped"
      : "failure";
  const body = lifecycleControlComponent(result, theme, context, checkpointOutcome);
  const fallbackEvidence = boundedBodyText(result);
  const requested = checkpoint ? undefined : capturedSendMessageCall(context, result)?.to;
  const target = typeof requested === "string" ? sanitizeInline(requested) : "";
  return {
    render(width: number): string[] {
      let bodyLines: string[];
      try {
        bodyLines = body.render(width);
      } catch {
        bodyLines = [];
        pushColored(theme, "muted", fallbackEvidence || "unrecognized SendMessage result", width, bodyLines);
      }
      const header = checkpoint
        ? checkpointRecoveryHeader(theme, checkpoint, width)
        : sendMessageTargetRow(theme, target, width);
      return clampLines([...header, ...bodyLines], width);
    },
  };
}

/** Preserve TaskStop's generic text presentation while mapping exact task/checkpoint lifecycle records. */
export function renderTaskStopResult(
  result: LifecycleControlResult,
  theme: unknown,
  context?: SubagentLifecycleRenderContext,
) {
  const state = safeField(context, "state");
  if (isRecord(state)) {
    try { Reflect.set(state, "resultOwned", true); } catch { /* Hostile state degrades to duplicate-safe result ownership where possible. */ }
  }
  const details = safeField(result, "details");
  const taskId = safeField(details, "taskId");
  const agentId = safeField(details, "agentId");
  const taskRecord = typeof taskId === "string" && /^task-[1-9]\d*$/u.test(taskId);
  const checkpointRecord = safeField(details, "checkpointPaused") === true &&
    typeof agentId === "string" && isAgentId(agentId);
  const status = taskRecord || checkpointRecord ? safeField(details, "status") : undefined;
  const body = lifecycleControlComponent(
    result,
    theme,
    context,
    status === "completed"
      ? "success"
      : status === "failed"
        ? "failure"
        : status === "stopped"
          ? "stopped"
          : undefined,
  );
  const requested = safeField(safeField(context, "args"), "task_id");
  const target = sanitizeInline(typeof requested === "string" ? requested :
    typeof taskId === "string" ? taskId : typeof agentId === "string" ? agentId : "");
  return {
    render(width: number): string[] {
      if (!Number.isFinite(width) || width <= 0) return [];
      const header = themedFg(theme, "text", formatToolDisplayName("TaskStop")) +
        themedFg(theme, "accent", target ? ` ${target}` : "");
      let wrapped: string[];
      try { wrapped = wrapTextWithAnsi(header, Math.max(1, Math.floor(width))); }
      catch { wrapped = wrapTextWithAnsi(`${formatToolDisplayName("TaskStop")}${target ? ` ${target}` : ""}`, Math.max(1, Math.floor(width))); }
      return [...wrapped, ...body.render(width)];
    },
  };
}

/**
 * Renderer for the `picc-settlement` custom MESSAGE (registered via
 * `pi.registerMessageRenderer` in src/extension.ts): a never-awaited background
 * settlement's notice renders as the SAME collapsed-expandable completion
 * record the tool renderers draw, keyed off the structured `details` the
 * settlement send attaches. Only the rendering changes — the model-facing
 * steer text is untouched. Returns undefined — falling back to Pi's default
 * custom-message box — for messages without the record details (older
 * sessions) and for NESTED (depth ≥ 2) tasks, which get no main-chat
 * completion record.
 */
export function renderSettlementRecord(
  details: unknown,
  options: { expanded?: boolean } | undefined,
  theme: unknown,
  presentation: SubagentRenderingOptions = {},
): { render(width: number): string[] } | undefined {
  const normalized = normalizeSubagentRenderDetails(details);
  if (normalized?.record !== "subagent-completion") return undefined;
  if (normalized.nested === true) return undefined;
  const finalText = normalized.finalText ?? "";
  const outcome = normalized.outcome ?? "completed";
  // Compose the expanded body the way the TaskOutput display reads: error +
  // recovery note + retained output for a failure, the discard note for an
  // abort, the verbatim final text otherwise. renderAgentResult sanitizes it
  // before display.
  let text = finalText;
  if (outcome === "failed") {
    const err = normalized.error || "unknown error";
    const errorAlreadyRetained = containsEquivalentErrorFraming(finalText, err);
    const displayError = sanitizeInline(err);
    const note = normalized.note ? humanDisplayText(normalized.note, false) : "";
    const retained = finalText
      ? errorAlreadyRetained ? finalText : `Partial output before the failure:\n${finalText}`
      : "";
    text = [errorAlreadyRetained ? "" : displayError, note, retained]
      .filter(Boolean)
      .join("\n\n") || finalText;
  } else if (outcome === "aborted") {
    text = "The task was stopped before completing; its result was discarded.";
  }
  return renderAgentResult(
    { content: [{ type: "text", text }], details: normalized },
    // Normalize to an explicit boolean: expanded===false is the collapse key.
    { expanded: safeField(options, "expanded") === true, isPartial: false },
    theme,
    undefined,
    { ...presentation, surface: "settlement" },
  );
}

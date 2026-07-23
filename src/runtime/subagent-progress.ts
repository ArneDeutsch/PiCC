import { createHash } from "node:crypto";

/**
 * Subagent live-progress condenser.
 *
 * A subagent runs a full Pi `AgentSession`; its `subscribe(listener)` stream
 * emits turn, message, tool, ordinary API retry, and summary-retry events.
 * This module turns that (chatty, unbounded)
 * stream into a small, BOUNDED, SANITIZED snapshot the parent can display live
 * via the Agent tool's `onUpdate` channel (interactive TUI + print/RPC alike):
 *
 *   - a rolling `tail` of recent activity lines (tool calls, the subagent's own
 *     assistant output, short tool-result previews), newest last, capped in
 *     both count and per-line length, and
 *   - a single `activity` line naming what is happening RIGHT NOW (current tool,
 *     or a silent auto-retry wait - "waiting: API retry 2/3"), and
 *   - accumulated token `usage`, absent until the first usage-bearing event.
 *
 * Beside the snapshot, the condenser keeps a typed structured detail log.
 * It is capture-sanitized and hard-bounded and never enters model-facing progress.
 *
 * SANITIZATION IS SECURITY, NOT COSMETICS: the tail replays subagent-controlled
 * text (its assistant output and - deliberately truncated - its tool results,
 * which can be arbitrary repo file content) into the PARENT terminal. Every line
 * is stripped of ANSI escape/OSC sequences and C0/C1 control characters and
 * collapsed to a single physical line, so a hostile file cannot inject terminal
 * control sequences upward. Tool results are additionally reduced to a single
 * truncated preview line so a huge file cannot flood the parent UI.
 */

/**
 * Token/cost usage accumulated across a dispatch's turns so far. Structurally
 * identical to `SubagentUsage` (subagent-registry.ts) and `DispatchUsage`
 * (subagents.ts) — declared locally to keep this module import-free of both;
 * the compile-time drift guard in subagents.ts breaks tsc the moment the
 * shapes diverge. One shape everywhere means `formatUsageCompact` and the
 * status panel read live and settlement usage identically.
 */
export interface SnapshotUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** One bounded, sanitized event for the selected-agent detail view. */
export type SubagentDetailEntry =
  | { kind: "assistant"; text: string; fingerprint: string }
  | { kind: "tool-call"; tool: string; detail?: string }
  | { kind: "tool-outcome"; tool: string; detail?: string; failed: boolean }
  | { kind: "status"; text: string };

/** A bounded, sanitized view of a running subagent's recent activity. */
export interface ProgressSnapshot {
  /** Recent activity lines, oldest -> newest; bounded in count and line length. */
  tail: string[];
  /** What the subagent is doing right now (current tool / retry wait / thinking). */
  activity: string;
  /**
   * Usage accumulated across this dispatch's turns so far. ABSENT until the
   * first usage-bearing event (nonzero `totalTokens`): Pi's
   * `AssistantMessage.usage` is a REQUIRED field, typically zero-filled
   * mid-stream, and a zero-filled event must not surface as a fake `0`
   * display. Settlement-time `getSessionStats()` stays authoritative — the
   * registry record's settled `usage` wins where both exist.
   */
  usage?: SnapshotUsage;
}

/** Default rolling-tail length (lines). Chosen to fit a small TUI slice. */
export const DEFAULT_MAX_TAIL_LINES = 12;
/** Default per-line cap (characters) before truncation. */
export const DEFAULT_MAX_LINE_LENGTH = 200;
/** Hard display budgets for the structured selected-agent detail log. */
export const DETAIL_LOG_MAX_ENTRIES = 100;
export const DETAIL_FIELD_MAX_LENGTH = 300;
/** Maximum raw code units inspected when sanitizing a malformed detail scalar. */
const DETAIL_RAW_INSPECTION_LIMIT = 4096;
/** Fixed work ceilings for a tool outcome, including payloads with no visible text. */
export const TOOL_OUTCOME_BLOCK_INSPECTION_LIMIT = 64;
export const TOOL_OUTCOME_RAW_INSPECTION_LIMIT = 4096;

// Control bytes referenced by the ANSI matchers, built from code points so the
// SOURCE stays pure ASCII (no raw control characters in this file). ESC=27, BEL=7.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// Escape-sequence families: OSC (ESC ] ... BEL-or-ST terminated), CSI (ESC [
// ... final byte), and single-char Fe escapes (ESC + one byte). Stripped before
// the control-char pass so their parameter bytes don't survive as visible junk.
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, "g");
const CSI_RE = new RegExp(`${ESC}\\[[0-9;:?]*[ -/]*[@-~]`, "g");
const FE_ESCAPE_RE = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");

/** True for C0 (except tab/newline/CR), DEL, and C1 control code points. */
function isStrippableControl(code: number): boolean {
  if (code === 9 || code === 10 || code === 13) return false; // keep \t \n \r
  return code < 32 || code === 127 || (code >= 128 && code <= 159);
}

/**
 * Strip ANSI/OSC/control sequences from arbitrary (possibly hostile) text.
 * Newlines are preserved so callers can split into lines first; every other
 * control character is removed.
 */
export function sanitizeProgressText(text: string): string {
  const escaped = String(text ?? "")
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(FE_ESCAPE_RE, "");
  let out = "";
  for (const ch of escaped) {
    if (!isStrippableControl(ch.charCodeAt(0))) out += ch;
  }
  return out;
}

export function scalarSafeText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch.length === 1 && code >= 0xd800 && code <= 0xdfff) continue;
    out += ch;
  }
  return out;
}

/** Keep an ellipsis truncation boundary from bisecting an astral code point. */
function ellipsizedPrefix(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  const limit = Math.max(0, maxLen - 1);
  let prefix = text.slice(0, limit);
  if (prefix.length && /[\uD800-\uDBFF]/u.test(prefix[prefix.length - 1]!)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}

/** Sanitize one line with the compact snapshot's legacy byte semantics. */
export function sanitizeLine(text: string, maxLen: number): string {
  const flat = sanitizeProgressText(text).replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, Math.max(0, maxLen - 1))}…`;
}

type EscapeState = "normal" | "escape" | "csi" | "osc" | "osc-escape";

/** Streaming equivalent of sanitizeLine, retaining at most one display budget. */
class BoundedScalarAccumulator {
  private out = "";
  private pendingSpace = false;
  private escapeState: EscapeState = "normal";
  truncated = false;

  constructor(private readonly maxLen: number) {}

  feed(ch: string, code: number): void {
    if (this.truncated) return;
    if (this.escapeState === "escape") {
      this.escapeState = code === 93 ? "osc" : code === 91 ? "csi" : "normal";
      if ((code >= 64 && code <= 95) || code === 91 || code === 93) return;
    } else if (this.escapeState === "csi") {
      if (code >= 64 && code <= 126) this.escapeState = "normal";
      return;
    } else if (this.escapeState === "osc") {
      if (code === 7) this.escapeState = "normal";
      else if (code === 27) this.escapeState = "osc-escape";
      return;
    } else if (this.escapeState === "osc-escape") {
      if (code === 92) {
        this.escapeState = "normal";
        return;
      }
      this.escapeState = "escape";
      this.feed(ch, code);
      return;
    }

    if (code === 27) {
      this.escapeState = "escape";
      return;
    }
    if (code === 155) {
      this.escapeState = "csi";
      return;
    }
    if (ch.length === 1 && code >= 0xd800 && code <= 0xdfff) return;
    if (isStrippableControl(code)) return;
    if (/\s/u.test(ch)) {
      if (this.out) this.pendingSpace = true;
      return;
    }
    const addition = `${this.pendingSpace ? " " : ""}${ch}`;
    this.pendingSpace = false;
    if (this.out.length + addition.length > this.maxLen) {
      this.truncated = true;
      return;
    }
    this.out += addition;
  }

  value(): string {
    return this.truncated ? ellipsizedPrefix(this.out, this.maxLen) : this.out;
  }
}

/**
 * Sanitize one structured-detail scalar while retaining at most its display
 * budget. Unlike sanitizeProgressText(), this never allocates a cleaned copy of
 * an attacker-sized input before applying the cap.
 */
export function sanitizeDetailScalar(
  value: string,
  maxLen = DETAIL_FIELD_MAX_LENGTH,
): string {
  const accumulator = new BoundedScalarAccumulator(maxLen);
  let inspected = 0;
  for (const ch of value) {
    if (inspected + ch.length > DETAIL_RAW_INSPECTION_LIMIT) break;
    inspected += ch.length;
    accumulator.feed(ch, ch.codePointAt(0)!);
    if (accumulator.truncated) break;
  }
  return accumulator.value();
}

/** Extract a display scalar without joining a complete multi-block payload. */
function boundedScalar(parts: Iterable<unknown>, maxLen = DETAIL_FIELD_MAX_LENGTH): string {
  const accumulator = new BoundedScalarAccumulator(maxLen);
  let inspected = 0;
  outer: for (const part of parts) {
    if (typeof part !== "string") continue;
    for (const ch of part) {
      if (inspected + ch.length > DETAIL_RAW_INSPECTION_LIMIT) break outer;
      inspected += ch.length;
      accumulator.feed(ch, ch.codePointAt(0)!);
      if (accumulator.truncated) break outer;
    }
  }
  return accumulator.value();
}

/** Cryptographic identity of the exact JS UTF-16 code units in uncapped assistant text. */
export function assistantTextFingerprint(parts: Iterable<unknown>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    if (typeof part === "string") hash.update(part, "utf16le");
  }
  return hash.digest("hex");
}

function* messageTextParts(message: unknown): Iterable<unknown> {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    yield content;
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      yield (block as { text?: unknown }).text;
    }
  }
}

function safeField(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function safeArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function* resultTextParts(result: unknown): Iterable<unknown> {
  if (typeof result === "string") {
    yield result;
    return;
  }
  const content = safeField(result, "content");
  if (!safeArray(content)) return;
  const rawLength = safeField(content, "length");
  if (typeof rawLength !== "number" || !Number.isSafeInteger(rawLength) || rawLength < 0) return;
  const length = Math.min(rawLength, TOOL_OUTCOME_BLOCK_INSPECTION_LIMIT);
  for (let i = 0; i < length; i++) {
    const block = safeField(content, i);
    if (safeField(block, "type") !== "text") continue;
    yield safeField(block, "text");
    // The separator lets a first-line consumer stop before the next block is inspected.
    if (i < length - 1) yield "\n";
  }
}

type LegacyEscapeState = "normal" | "escape" | "csi-params" | "csi-intermediate" | "osc" | "osc-escape";

/** Incremental equivalent of the legacy sanitizeLine pipeline. */
class LegacyLineAccumulator {
  private out = "";
  private pendingSpace = false;
  private state: LegacyEscapeState = "normal";
  private csiCandidate = "";
  private overflow = false;

  constructor(private readonly maxLen: number) {}

  feed(text: string): void {
    for (const ch of text) this.feedCharacter(ch);
  }

  private feedCharacter(ch: string): void {
    const code = ch.codePointAt(0)!;
    if (this.state === "escape") {
      if (code === 93) {
        this.state = "osc";
        return;
      }
      if (code === 91) {
        this.state = "csi-params";
        this.csiCandidate = "";
        return;
      }
      this.state = "normal";
      if ((code >= 64 && code <= 90) || (code >= 92 && code <= 95)) return;
    } else if (this.state === "osc") {
      if (code === 7) this.state = "normal";
      else if (code === 27) this.state = "osc-escape";
      return;
    } else if (this.state === "osc-escape") {
      if (code === 92) {
        this.state = "normal";
        return;
      }
      this.state = "escape";
      this.feedCharacter(ch);
      return;
    } else if (this.state === "csi-params") {
      if ((code >= 48 && code <= 57) || code === 59 || code === 58 || code === 63) {
        this.rememberCsi(ch);
        return;
      }
      if (code >= 32 && code <= 47) {
        this.rememberCsi(ch);
        this.state = "csi-intermediate";
        return;
      }
      if (code >= 64 && code <= 126) {
        this.state = "normal";
        this.csiCandidate = "";
        return;
      }
      this.flushIncompleteCsi();
    } else if (this.state === "csi-intermediate") {
      if (code >= 32 && code <= 47) {
        this.rememberCsi(ch);
        return;
      }
      if (code >= 64 && code <= 126) {
        this.state = "normal";
        this.csiCandidate = "";
        return;
      }
      this.flushIncompleteCsi();
    }

    if (code === 27) {
      this.state = "escape";
      return;
    }
    if (isStrippableControl(code)) return;
    if (/\s/u.test(ch)) {
      if (this.out) this.pendingSpace = true;
      return;
    }
    this.append(`${this.pendingSpace ? " " : ""}${ch}`);
    this.pendingSpace = false;
  }

  private rememberCsi(ch: string): void {
    if (this.csiCandidate.length <= this.maxLen) this.csiCandidate += ch;
  }

  private flushIncompleteCsi(): void {
    const candidate = this.csiCandidate;
    this.state = "normal";
    this.csiCandidate = "";
    // Legacy sanitizeProgressText strips the ESC control byte from an incomplete
    // CSI but preserves its literal '[' introducer and parameter bytes.
    this.feedCharacter("[");
    for (const ch of candidate) this.feedCharacter(ch);
    if (candidate.length > this.maxLen) this.overflow = true;
  }

  private append(text: string): void {
    if (this.out.length <= this.maxLen) this.out += text;
    if (this.out.length > this.maxLen) this.overflow = true;
  }

  value(): string {
    if (this.state === "csi-params" || this.state === "csi-intermediate") this.flushIncompleteCsi();
    const flat = this.out;
    if (!this.overflow && flat.length <= this.maxLen) return flat;
    return `${flat.slice(0, Math.max(0, this.maxLen - 1))}…`;
  }
}

function legacyScalar(parts: Iterable<unknown>, maxLen: number): string {
  const accumulator = new LegacyLineAccumulator(maxLen);
  for (const part of parts) {
    if (typeof part === "string") accumulator.feed(part);
  }
  return accumulator.value();
}

interface BoundedLine {
  found: boolean;
  value: string;
}

type LogicalLineVisitor = (legacyValues: readonly string[], safeValues: readonly string[], found: boolean) => boolean | void;

/** Walk concatenated text parts as logical lines without joining the payload. */
function scanLogicalLines(
  parts: Iterable<unknown>,
  legacyLengths: readonly number[],
  safeLengths: readonly number[],
  visit: LogicalLineVisitor,
): void {
  let legacy = legacyLengths.map((length) => new LegacyLineAccumulator(length));
  let safe = safeLengths.map((length) => new BoundedScalarAccumulator(length));
  let found = false;
  const emit = (): boolean => {
    const keepGoing = visit(
      legacy.map((accumulator) => accumulator.value()),
      safe.map((accumulator) => accumulator.value()),
      found,
    );
    legacy = legacyLengths.map((length) => new LegacyLineAccumulator(length));
    safe = safeLengths.map((length) => new BoundedScalarAccumulator(length));
    found = false;
    return keepGoing !== false;
  };

  for (const part of parts) {
    if (typeof part !== "string") continue;
    for (const ch of part) {
      if (ch === "\n") {
        if (!emit()) return;
        continue;
      }
      if (!/\s/u.test(ch)) found = true;
      for (const accumulator of legacy) accumulator.feed(ch);
      for (const accumulator of safe) accumulator.feed(ch, ch.codePointAt(0)!);
    }
  }
  emit();
}

function lastLegacyNonEmptyLine(parts: Iterable<unknown>, maxLen: number): BoundedLine {
  let result: BoundedLine = { found: false, value: "" };
  scanLogicalLines(parts, [maxLen], [], (legacy, _safe, found) => {
    if (found) result = { found: true, value: legacy[0]! };
  });
  return result;
}

interface ToolOutcomePreview {
  found: boolean;
  snapshotLine: string;
  detail: string;
}

function toolOutcomePreview(
  rawName: string,
  result: unknown,
  failed: boolean,
  snapshotMax: number,
): ToolOutcomePreview {
  const snapshot = new LegacyLineAccumulator(snapshotMax);
  const detail = new BoundedScalarAccumulator(DETAIL_FIELD_MAX_LENGTH);
  const inspectedName = rawName.slice(0, TOOL_OUTCOME_RAW_INSPECTION_LIMIT);
  const prefix = failed ? `  x ${inspectedName} failed` : `  ${inspectedName}`;
  snapshot.feed(prefix);
  let found = false;
  let inspected = 0;

  for (const part of resultTextParts(result)) {
    if (typeof part !== "string") continue;
    for (const ch of part) {
      if (inspected + ch.length > TOOL_OUTCOME_RAW_INSPECTION_LIMIT) {
        return { found, snapshotLine: snapshot.value(), detail: detail.value() };
      }
      inspected += ch.length;
      if (ch === "\n") {
        if (found) return { found, snapshotLine: snapshot.value(), detail: detail.value() };
        continue;
      }
      if (!found && !/\s/u.test(ch)) {
        found = true;
        snapshot.feed(": ");
      }
      if (found) {
        snapshot.feed(ch);
        detail.feed(ch, ch.codePointAt(0)!);
      }
    }
  }
  return { found, snapshotLine: snapshot.value(), detail: detail.value() };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * One assistant-message event's usage, or undefined when the event is not
 * usage-bearing. "Usage-bearing" means nonzero `totalTokens`: Pi zero-fills
 * the required `usage` field mid-stream, and a zero-filled event must not
 * start a fake accumulation. On a bearing event, zero individual fields are
 * honest measured zeros and are kept (mirroring `usageFromStats`).
 */
function messageUsage(message: unknown): SnapshotUsage | undefined {
  const usage = (message as { usage?: unknown } | undefined)?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const total = asNumber(u.totalTokens);
  if (total === undefined || total <= 0) return undefined;
  const cost = asNumber((u.cost as Record<string, unknown> | undefined)?.total);
  return {
    inputTokens: asNumber(u.input) ?? 0,
    outputTokens: asNumber(u.output) ?? 0,
    cacheReadTokens: asNumber(u.cacheRead) ?? 0,
    cacheWriteTokens: asNumber(u.cacheWrite) ?? 0,
    costUsd: cost ?? 0,
  };
}

/** Fieldwise sum; `a` may be absent (the first bearing turn starts the total). */
function addUsage(a: SnapshotUsage | undefined, b: SnapshotUsage): SnapshotUsage {
  if (!a) return { ...b };
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

/** A short, safe hint of a tool call's target (path/command/query), if any. */
function argumentDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    const detail = boundedScalar([a[key]]);
    if (detail) return detail;
  }
  return undefined;
}

function argHint(args: unknown, maxLen: number): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    const value = a[key];
    if (typeof value === "string" && /\S/u.test(value)) {
      return ` (${legacyScalar([value], Math.min(maxLen, 60))})`;
    }
  }
  return "";
}

/**
 * Folds a subagent's event stream into a bounded, sanitized {@link ProgressSnapshot}.
 * Pure and deterministic - no timers, no I/O. `consume()` returns whether the
 * VISIBLE snapshot changed, so the caller emits an `onUpdate` only on real
 * change (identical-snapshot dedupe is the throttle; the interactive UI further
 * coalesces renders on its own).
 */
export class SubagentProgressCondenser {
  private readonly tail: string[] = [];
  private readonly detailLogBuffer: SubagentDetailEntry[] = [];
  private detailChangedOnLastConsume = false;
  private activity = "";
  /** Usage summed over COMPLETED turns; folded at each turn_end. */
  private settledUsage: SnapshotUsage | undefined;
  /**
   * Latest usage of the IN-FLIGHT streamed message. Replaced, never summed —
   * a message's streamed usage is cumulative within that message, so summing
   * chunks would double-count.
   */
  private streamingUsage: SnapshotUsage | undefined;
  private lastSnapshot: string;

  constructor(
    private readonly maxTailLines: number = DEFAULT_MAX_TAIL_LINES,
    private readonly maxLineLength: number = DEFAULT_MAX_LINE_LENGTH,
  ) {
    // Baseline = the empty snapshot, so an event that produces no visible change
    // (e.g. an empty message_update) correctly reports "unchanged".
    this.lastSnapshot = JSON.stringify(this.snapshot());
  }

  /**
   * Consume one session event. Returns `true` iff the resulting snapshot
   * differs from the last one (so the caller can skip redundant emissions).
   * Unknown/irrelevant event types are ignored (no change).
   */
  consume(event: unknown): boolean {
    this.detailChangedOnLastConsume = false;
    const e = (event ?? {}) as { type?: string; [k: string]: unknown };
    switch (e.type) {
      case "turn_start":
        this.activity = "thinking…";
        break;
      case "auto_retry_start": {
        const attempt = asNumber(e.attempt);
        const max = asNumber(e.maxAttempts);
        // Make the otherwise-silent backoff wait visible (the motivating gap).
        this.activity =
          attempt !== undefined && max !== undefined
            ? `waiting: API retry ${attempt}/${max}`
            : "waiting: API retry";
        this.push(this.activity);
        this.pushDetail({ kind: "status", text: this.activity });
        break;
      }
      case "auto_retry_end":
        this.activity = e.success === true ? "retry succeeded; resuming…" : "retry failed";
        this.pushDetail({ kind: "status", text: this.activity });
        break;
      case "summarization_retry_scheduled": {
        const attempt = asNumber(e.attempt);
        const max = asNumber(e.maxAttempts);
        this.activity = attempt !== undefined && max !== undefined
          ? `waiting: summary retry ${attempt}/${max}`
          : "waiting: summary retry";
        this.push(this.activity);
        this.pushDetail({ kind: "status", text: this.activity });
        break;
      }
      case "summarization_retry_attempt_start":
        this.activity = "retrying summary…";
        this.pushDetail({ kind: "status", text: this.activity });
        break;
      case "summarization_retry_finished":
        this.activity = "summary retry finished";
        this.pushDetail({ kind: "status", text: this.activity });
        break;
      case "tool_execution_start": {
        // SECURITY: the tool name reaches the parent terminal (this activity line)
        // AND the model-visible TaskOutput lastActivity, so sanitize it like every
        // other activity source — live the moment MCP/project-named tools flow
        // through the event stream. Its structured field has an independent cap.
        const rawName = (typeof e.toolName === "string" && e.toolName) || "tool";
        const name = legacyScalar([rawName], this.maxLineLength) || "tool";
        const detailTool = boundedScalar([rawName], DETAIL_FIELD_MAX_LENGTH) || "tool";
        this.activity = `running ${name}…`;
        this.push(`> ${name}${argHint(e.args, this.maxLineLength)}`);
        const detail = argumentDetail(e.args);
        this.pushDetail(
          detail
            ? { kind: "tool-call", tool: detailTool, detail }
            : { kind: "tool-call", tool: detailTool },
        );
        break;
      }
      case "tool_execution_end": {
        const rawName = (typeof e.toolName === "string" && e.toolName) || "tool";
        const failed = e.isError === true;
        const preview = toolOutcomePreview(rawName, e.result, failed, this.maxLineLength);
        if (failed || preview.found) this.pushPrepared(preview.snapshotLine);
        const tool = boundedScalar([rawName], DETAIL_FIELD_MAX_LENGTH) || "tool";
        this.pushDetail(
          preview.detail
            ? { kind: "tool-outcome", tool, detail: preview.detail, failed }
            : { kind: "tool-outcome", tool, failed },
        );
        this.activity = "working…";
        break;
      }
      case "message_update": {
        // Streaming assistant text: update the ACTIVITY preview only (a single
        // bounded line) - never grow the tail token-by-token (memory + spam).
        const preview = lastLegacyNonEmptyLine(messageTextParts(e.message), this.maxLineLength);
        if (preview.found) this.activity = preview.value;
        const usage = messageUsage(e.message);
        if (usage) this.streamingUsage = usage;
        break;
      }
      case "turn_end": {
        const detailText = boundedScalar(messageTextParts(e.message));
        if (detailText) {
          this.pushDetail({
            kind: "assistant",
            text: detailText,
            fingerprint: assistantTextFingerprint(messageTextParts(e.message)),
          });
        }
        // Text blocks concatenate exactly as before, but logical lines are
        // sanitized and pushed incrementally so no joined payload is allocated.
        scanLogicalLines(
          messageTextParts(e.message),
          [this.maxLineLength],
          [],
          (legacy) => this.pushPrepared(legacy[0]!),
        );
        // message_update leaves `activity` holding the final streamed line, which
        // we just pushed into `tail` — showing it again as the "… <activity>"
        // footer would duplicate it in the idle snapshot. Reset to a neutral idle label.
        this.activity = "working…";
        // Usage accumulates by SUMMING each turn's own `AssistantMessage.usage`
        // (per-LLM-call, never session-cumulative) at turn_end. Event-stream
        // only: totals are never re-read from `session.messages`, so a
        // compaction rewriting that array mid-run can neither double- nor
        // un-count a billed call (a compaction's own summarization call counts
        // iff it surfaces as a usage-bearing event). The turn_end message is
        // the streamed message's final form — fold IT, falling back to the last
        // streamed figure only when the final event lacks usage, and drop the
        // in-flight value either way so nothing is counted twice.
        const finalUsage = messageUsage(e.message) ?? this.streamingUsage;
        if (finalUsage) this.settledUsage = addUsage(this.settledUsage, finalUsage);
        this.streamingUsage = undefined;
        break;
      }
      default:
        return false;
    }
    return this.changed();
  }

  /** Current bounded, sanitized snapshot (a fresh copy). */
  snapshot(): ProgressSnapshot {
    const usage = this.accumulatedUsage();
    return usage
      ? { tail: [...this.tail], activity: this.activity, usage }
      : { tail: [...this.tail], activity: this.activity };
  }

  /** Structured detail entries, oldest to newest, with no mutable internals exposed. */
  detailLog(): SubagentDetailEntry[] {
    return this.detailLogBuffer.map((entry) => ({ ...entry }));
  }

  /** Whether the most recent consume changed only-or-also the structured log. */
  detailChanged(): boolean {
    return this.detailChangedOnLastConsume;
  }

  /** Settled turns + the in-flight figure; undefined until usage-bearing. */
  private accumulatedUsage(): SnapshotUsage | undefined {
    if (this.streamingUsage) return addUsage(this.settledUsage, this.streamingUsage);
    return this.settledUsage ? { ...this.settledUsage } : undefined;
  }

  private pushDetail(entry: SubagentDetailEntry): void {
    this.detailLogBuffer.push({ ...entry });
    if (this.detailLogBuffer.length > DETAIL_LOG_MAX_ENTRIES) {
      this.detailLogBuffer.splice(0, this.detailLogBuffer.length - DETAIL_LOG_MAX_ENTRIES);
    }
    this.detailChangedOnLastConsume = true;
  }

  private push(line: string): void {
    this.pushPrepared(sanitizeLine(line, this.maxLineLength));
  }

  private pushPrepared(snapshotLine: string): void {
    if (!snapshotLine) return;
    this.tail.push(snapshotLine);
    if (this.tail.length > this.maxTailLines) {
      this.tail.splice(0, this.tail.length - this.maxTailLines);
    }
  }

  private changed(): boolean {
    const snap = JSON.stringify(this.snapshot());
    if (snap === this.lastSnapshot) return false;
    this.lastSnapshot = snap;
    return true;
  }
}

/**
 * Flatten a snapshot into display text for the Agent tool's `onUpdate` content
 * (what the interactive fallback and print/RPC modes show): the rolling tail
 * followed by the current-activity line.
 */
export function renderProgressText(snapshot: ProgressSnapshot): string {
  const lines = [...snapshot.tail];
  if (snapshot.activity) lines.push(`… ${snapshot.activity}`);
  return lines.join("\n");
}

/**
 * A single-line activity label for a background task's last-activity field: the
 * current activity, else the newest tail line, else empty. Pure — reads only
 * `snapshot.activity`/`tail`, no `pi-tui`. Shared by `noteProgress`
 * (background-tasks.ts) to derive the model-facing `lastActivity`/poll string.
 */
export function progressActivityLine(snapshot: ProgressSnapshot): string {
  return snapshot.activity || snapshot.tail[snapshot.tail.length - 1] || "";
}

// --- per-subagent usage formatting (shared display helper) ---
//
// The single home of the compact usage-line format, used by the foreground
// Agent tool result, the background TaskOutput text, and the /usage control
// command — so every human-visible surface reads identically. Lives here (the
// neutral display-text util already imported by subagents.ts and
// background-tasks.ts) to stay free of an import cycle between those modules.

/**
 * `$0.03`, trailing zeros trimmed; `$0.00` for an EXACT zero cost. A nonzero
 * charge below the 4-decimal resolution renders `<$0.0001` (a floor) rather than
 * a misleading `$0` — never let a real charge read as free.
 */
function formatCostUsd(cost: number): string {
  if (!Number.isFinite(cost)) return "$0.00";
  if (cost === 0) return "$0.00";
  const trimmed = cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  // A nonzero cost that rounds to zero at 4 decimals ("$0") must not read as free.
  if (trimmed === "0") return "<$0.0001";
  return `$${trimmed}`;
}

/** A finite number, or undefined for anything else (NaN/Infinity/non-number). */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Format a usage object (the `{ inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens, costUsd }` shape) into one compact line, rendering ONLY the
 * fields actually present (Pi omits what it doesn't measure — never invented as
 * zeros). Also accepts the legacy `totalTokens`/`tokens` + `cost` shape so
 * `formatUsageLine` can delegate here. Returns undefined when nothing renders,
 * so callers can drop the line entirely.
 */
export function formatUsageCompact(usage: unknown): string | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const parts: string[] = [];
  const input = finiteNumber(u.inputTokens);
  const output = finiteNumber(u.outputTokens);
  const cacheRead = finiteNumber(u.cacheReadTokens);
  const cacheWrite = finiteNumber(u.cacheWriteTokens);
  if (
    input !== undefined ||
    output !== undefined ||
    cacheRead !== undefined ||
    cacheWrite !== undefined
  ) {
    if (input !== undefined) parts.push(`in ${input}`);
    if (output !== undefined) parts.push(`out ${output}`);
    if (cacheRead !== undefined) parts.push(`cache read ${cacheRead}`);
    if (cacheWrite !== undefined) parts.push(`cache write ${cacheWrite}`);
  } else {
    // Legacy shape: a single total-token count.
    const total = finiteNumber(u.totalTokens) ?? finiteNumber(u.tokens);
    if (total !== undefined) parts.push(`${total} tokens`);
  }
  const cost = finiteNumber(u.costUsd) ?? finiteNumber(u.cost);
  if (cost !== undefined) parts.push(formatCostUsd(cost));
  return parts.length ? parts.join(" · ") : undefined;
}

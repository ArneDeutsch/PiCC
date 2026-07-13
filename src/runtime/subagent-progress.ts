/**
 * Subagent live-progress condenser (t03).
 *
 * A subagent runs a full Pi `AgentSession`; its `subscribe(listener)` stream
 * emits `turn_start/end`, `message_update`, `tool_execution_start/update/end`,
 * and `auto_retry_start/end` events. This module turns that (chatty, unbounded)
 * stream into a small, BOUNDED, SANITIZED snapshot the parent can display live
 * via the Agent tool's `onUpdate` channel (interactive TUI + print/RPC alike):
 *
 *   - a rolling `tail` of recent activity lines (tool calls, the subagent's own
 *     assistant output, short tool-result previews), newest last, capped in
 *     both count and per-line length, and
 *   - a single `activity` line naming what is happening RIGHT NOW (current tool,
 *     or a silent auto-retry wait - "waiting: API retry 2/3").
 *
 * SANITIZATION IS SECURITY, NOT COSMETICS: the tail replays subagent-controlled
 * text (its assistant output and - deliberately truncated - its tool results,
 * which can be arbitrary repo file content) into the PARENT terminal. Every line
 * is stripped of ANSI escape/OSC sequences and C0/C1 control characters and
 * collapsed to a single physical line, so a hostile file cannot inject terminal
 * control sequences upward. Tool results are additionally reduced to a single
 * truncated preview line so a huge file cannot flood the parent UI.
 */

/** A bounded, sanitized view of a running subagent's recent activity. */
export interface ProgressSnapshot {
  /** Recent activity lines, oldest -> newest; bounded in count and line length. */
  tail: string[];
  /** What the subagent is doing right now (current tool / retry wait / thinking). */
  activity: string;
}

/** Default rolling-tail length (lines). Chosen to fit a small TUI slice. */
export const DEFAULT_MAX_TAIL_LINES = 12;
/** Default per-line cap (characters) before truncation. */
export const DEFAULT_MAX_LINE_LENGTH = 200;

// Control bytes referenced by the ANSI matchers, built from code points so the
// SOURCE stays pure ASCII (no raw control characters in this file - a t01/t02
// pitfall). ESC=27, BEL=7.
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

/** Sanitize one line: strip escapes/control, collapse whitespace, cap length. */
export function sanitizeLine(text: string, maxLen: number): string {
  const flat = sanitizeProgressText(text).replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** Local text extractor (avoids a value-import cycle with subagents.ts). */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join("");
  }
  return "";
}

/** Extract text from a tool result (AgentToolResult shape or a bare string). */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown } | undefined)?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text?: string }).text ?? "")
      .join("\n");
  }
  return "";
}

function firstNonEmptyLine(text: string): string {
  for (const line of String(text ?? "").split("\n")) {
    if (line.trim()) return line;
  }
  return "";
}

function lastNonEmptyLine(text: string): string {
  const lines = String(text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim()) return lines[i]!;
  }
  return "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A short, safe hint of a tool call's target (path/command/query), if any. */
function argHint(args: unknown, maxLen: number): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) {
      return ` (${sanitizeLine(v, Math.min(maxLen, 60))})`;
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
  private activity = "";
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
        break;
      }
      case "auto_retry_end":
        this.activity = e.success === true ? "retry succeeded; resuming…" : "retry failed";
        break;
      case "tool_execution_start": {
        // SEC-1: the tool name reaches the parent terminal (this activity line)
        // AND the model-visible TaskOutput lastActivity, so sanitize it like every
        // other activity source — live the moment MCP/project-named tools flow
        // through the event stream. push() already sanitizes the tail entry below.
        const name =
          sanitizeLine((typeof e.toolName === "string" && e.toolName) || "tool", this.maxLineLength) ||
          "tool";
        this.activity = `running ${name}…`;
        this.push(`> ${name}${argHint(e.args, this.maxLineLength)}`);
        break;
      }
      case "tool_execution_end": {
        const name = (typeof e.toolName === "string" && e.toolName) || "tool";
        // Tool RESULTS are arbitrary repo content: reduce to ONE sanitized,
        // truncated preview line (push() strips ANSI/control) - never replay raw.
        const preview = firstNonEmptyLine(resultText(e.result));
        if (e.isError === true) {
          this.push(`  x ${name} failed${preview ? `: ${preview}` : ""}`);
        } else if (preview) {
          this.push(`  ${name}: ${preview}`);
        }
        this.activity = "working…";
        break;
      }
      case "message_update": {
        // Streaming assistant text: update the ACTIVITY preview only (a single
        // bounded line) - never grow the tail token-by-token (memory + spam).
        const preview = lastNonEmptyLine(messageText(e.message));
        if (preview) this.activity = sanitizeLine(preview, this.maxLineLength);
        break;
      }
      case "turn_end": {
        // The settled assistant message: its lines join the rolling tail (the
        // "latest output lines"). The tail cap keeps only the most recent.
        for (const line of messageText(e.message).split("\n")) {
          this.push(line);
        }
        // FIX-A: message_update left `activity` holding the final streamed line,
        // which we just pushed into `tail` — showing it again as the "… <activity>"
        // footer duplicates it in the idle snapshot. Reset to a neutral idle label.
        this.activity = "working…";
        break;
      }
      default:
        return false;
    }
    return this.changed();
  }

  /** Current bounded, sanitized snapshot (a fresh copy). */
  snapshot(): ProgressSnapshot {
    return { tail: [...this.tail], activity: this.activity };
  }

  private push(line: string): void {
    const s = sanitizeLine(line, this.maxLineLength);
    if (!s) return;
    this.tail.push(s);
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

// --- t06 per-subagent usage formatting (shared display helper) ---
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
 * Format a usage object (the t06 `{ inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens, costUsd }` shape) into one compact line, rendering ONLY the
 * fields actually present (Pi omits what it doesn't measure — never invented as
 * zeros). Also accepts the legacy `totalTokens`/`tokens` + `cost` shape (the t03
 * defensive slot's expectation) so `formatUsageLine` can delegate here. Returns
 * undefined when nothing renders, so callers can drop the line entirely.
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
    // Legacy shape (t03 defensive slot): a single total-token count.
    const total = finiteNumber(u.totalTokens) ?? finiteNumber(u.tokens);
    if (total !== undefined) parts.push(`${total} tokens`);
  }
  const cost = finiteNumber(u.costUsd) ?? finiteNumber(u.cost);
  if (cost !== undefined) parts.push(formatCostUsd(cost));
  return parts.length ? parts.join(" · ") : undefined;
}

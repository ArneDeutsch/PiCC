import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  formatUsageCompact,
  sanitizeProgressText,
  type ProgressSnapshot,
} from "./subagent-progress.js";
import { isAgentId } from "../util/subagent-transcripts.js";

// --- t03 live-progress + result rendering helpers ---
//
// The Agent tool's renderCall/renderResult return a STRUCTURAL pi-tui Component
// ({ render(width): string[] }) — the same untyped contract index.ts's control
// renderers use, so no pi-tui import is needed. `theme` is Pi's Theme (fg/bold);
// every access is null-guarded so a print-mode/absent theme degrades to plain
// text and a renderer can never throw into Pi's render loop.

function themedFg(theme: unknown, color: string, text: string): string {
  const t = theme as { fg?: (c: string, s: string) => string } | undefined;
  return typeof t?.fg === "function" ? t.fg(color, text) : text;
}

function themedBold(theme: unknown, text: string): string {
  const t = theme as { bold?: (s: string) => string } | undefined;
  return typeof t?.bold === "function" ? t.bold(text) : text;
}

// Width-aware line helpers, backed by pi-tui's OWN column measure. pi-tui throws
// an uncaughtException — killing the whole process — if a rendered line's visible
// width exceeds the terminal, and it decides that with visibleWidth() (grapheme +
// East-Asian-width + tabs=3). We MUST use the same function so our clamp agrees
// exactly with the check pi-tui enforces; a code-unit approximation silently
// disagrees on CJK/wide/tab content and still crashes. See doc/plan review notes.

/** Append `text` wrapped to `width` visible columns (ANSI- and wide-char-aware). */
function pushWrapped(text: string, width: number, into: string[]): void {
  for (const l of wrapTextWithAnsi(String(text ?? ""), Math.max(1, width))) into.push(l);
}

/** Wrap `text` to `width`, coloring each segment; every emitted line is <= width columns. */
function pushColored(
  theme: unknown,
  color: string,
  text: string,
  width: number,
  into: string[],
): void {
  // Color first, then wrap — wrapTextWithAnsi preserves active ANSI across breaks.
  for (const l of wrapTextWithAnsi(themedFg(theme, color, String(text ?? "")), Math.max(1, width))) {
    into.push(l);
  }
}

/**
 * FINAL SAFETY PASS before returning from render(): clamp every line to `width`
 * VISIBLE columns using pi-tui's own measure, so no line a render() returns can
 * exceed the terminal width and crash the process — even one a push site forgot
 * to wrap, or that carries wide/CJK/tab content.
 *
 * This is a WIDTH clamp, NOT a sanitizer: it preserves ANSI verbatim, so callers
 * MUST strip control/escape sequences from untrusted (model-/file-supplied) text
 * BEFORE it reaches here (see sanitizeInline / sanitizeProgressText usages).
 */
function clampLines(lines: string[], width: number): string[] {
  if (width <= 0) return lines.map(() => "");
  return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l));
}

/** Flatten model-/file-supplied label text to a single sanitized display line. */
function sanitizeInline(text: string): string {
  return sanitizeProgressText(String(text ?? "")).replace(/\s+/g, " ").trim();
}

/** First non-empty line of `text`, trimmed and capped for a one-line preview. */
function firstLine(text: string, max: number): string {
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (t) return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
  }
  return "";
}

/**
 * Usage formatter for the renderResult footer (t03 slot, populated by t06).
 * Renders a string as-is, an explicit `text` override, otherwise delegates to
 * the shared `formatUsageCompact` (the t06 `{ inputTokens, … costUsd }` shape,
 * and the legacy `totalTokens`/`cost` shape). Returns NOTHING when absent or an
 * unrecognized shape, so the footer line drops entirely.
 */
function formatUsageLine(usage: unknown): string | undefined {
  if (usage == null) return undefined;
  if (typeof usage === "string") return usage.trim() || undefined;
  if (typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    if (typeof u.text === "string" && u.text.trim()) return u.text.trim();
    return formatUsageCompact(u);
  }
  return undefined;
}

/** The outcome badge line (t01 outcome): colored symbol + agent + fate word. */
function outcomeBadgeLine(
  theme: unknown,
  outcome: string | undefined,
  cutOff: boolean,
  agentName: unknown,
): string {
  // SEC-2: agentName is model-supplied (subagent_type) OR project-file-supplied
  // (agent `name:` frontmatter) — sanitize before it reaches the parent terminal.
  const safeName = sanitizeInline(typeof agentName === "string" ? agentName : "");
  const agent = safeName ? `Agent(${safeName})` : "Agent";
  let symbol = "•";
  let color = "muted";
  let word = sanitizeInline(outcome ?? "") || "done";
  if (outcome === "completed") {
    symbol = "●";
    color = "success";
    word = cutOff ? "completed (truncated)" : "completed";
  } else if (outcome === "failed") {
    symbol = "✗";
    color = "error";
    word = cutOff ? "failed (partial output preserved)" : "failed";
  } else if (outcome === "aborted") {
    // UX-1: forward-compatible exhaustive branch. Not reached by today's live
    // foreground path (t01's seam throws aborted/failed-no-output before this
    // renders) — kept ready for the deferred t01-seam follow-up.
    symbol = "■";
    color = "warning";
    word = "aborted";
  }
  return themedFg(theme, color, themedBold(theme, `${symbol} ${agent} ${word}`));
}

/**
 * UX-2: strip the model-facing agent-ID trailer (t02) off the HUMAN-rendered
 * body. The model still reads `result.content` verbatim (trailer included); only
 * this local display copy drops it, so the footer can present the ID + a single
 * resumable hint without the raw `---`/`[agent …]` plumbing showing up too.
 * Case 1: a completed trailer opened its own `\n\n---\n` frame — drop the frame.
 * Case 2: a truncated/failed trailer rode inside an existing cut-off frame with a
 * single `\n` prefix — drop only the trailer line, keeping the cut-off frame.
 */
function stripAgentTrailerForDisplay(text: string): string {
  const framed = text.replace(/\n\n---\n\[agent agent-[0-9a-f]{12}[^\]\n]*\]\s*$/, "");
  if (framed !== text) return framed;
  return text.replace(/\n\[agent agent-[0-9a-f]{12}[^\]\n]*\]\s*$/, "");
}

/** renderCall (t03): agent type + description/prompt-head at dispatch time. */
export function renderAgentCall(args: Record<string, unknown>, theme: unknown) {
  const a = (args ?? {}) as Record<string, unknown>;
  // SEC-2: subagent_type/description/prompt are model-supplied and reach the
  // parent terminal — sanitize the DISPLAY strings (Pi does not sanitize
  // component render output). agentType is additionally flattened to one line.
  const agentType =
    sanitizeProgressText(String(a.subagent_type ?? "").trim()).replace(/\s+/g, " ").trim() ||
    "general-purpose";
  const detail = sanitizeProgressText(
    String(a.description ?? "").trim() || firstLine(String(a.prompt ?? ""), 100),
  );
  const background = a.run_in_background === true;
  return {
    render(width: number): string[] {
      const title =
        themedFg(theme, "toolTitle", themedBold(theme, `Agent(${agentType})`)) +
        (background ? themedFg(theme, "muted", " [background]") : "");
      const lines = [title];
      if (detail) {
        const wrapped: string[] = [];
        pushWrapped(`  ${detail}`, width, wrapped);
        for (const l of wrapped) lines.push(themedFg(theme, "muted", l));
      }
      return clampLines(lines, width);
    },
  };
}

/**
 * renderResult (t03, REQUIRED). Two modes:
 *  - PARTIAL (streaming): the live rolling tail + current-activity line.
 *  - FINAL: outcome badge (t01) + the verbatim message body + a metadata footer
 *    (transcript path (t02), usage slot (t06), resumable hint). Every field is
 *    optional and rendered only when present.
 */
export function renderAgentResult(
  result: { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: unknown,
) {
  const details = (result?.details ?? {}) as Record<string, unknown>;
  const contentText = (result?.content ?? [])
    .filter((c) => c && c.type === "text")
    .map((c) => String(c.text ?? ""))
    .join("\n");
  const isPartial = options?.isPartial === true;
  return {
    render(width: number): string[] {
      const lines: string[] = [];
      if (isPartial) {
        const snap = details.subagentProgress as ProgressSnapshot | undefined;
        // SEC-2: details.agent originates from the model-supplied subagent_type — sanitize.
        const agent = sanitizeInline(typeof details.agent === "string" ? details.agent : "") || "subagent";
        lines.push(
          themedFg(theme, "toolTitle", themedBold(theme, `Agent(${agent})`)) +
            themedFg(theme, "muted", " running…"),
        );
        if (snap) {
          for (const raw of snap.tail) {
            const wrapped: string[] = [];
            pushWrapped(raw, width, wrapped);
            for (const l of wrapped) lines.push(l);
          }
          // Wrap to `width` before coloring — a long activity line must not
          // overflow the terminal (pi-tui throws on overflow, crashing the app).
          if (snap.activity) pushColored(theme, "accent", `… ${snap.activity}`, width, lines);
        } else {
          // SEC-2: defensive fallback — the live partial path always carries a
          // (sanitized) progress snapshot, but keep the sanitize invariant uniform
          // so any future partial emitter can't leak control bytes to the terminal.
          pushWrapped(sanitizeProgressText(contentText), width, lines);
        }
        return clampLines(lines.length ? lines : [""], width);
      }
      // Final result.
      if (details.background === true) {
        lines.push(themedFg(theme, "accent", themedBold(theme, "Agent → background")));
        // SEC-2: the start message embeds the model-supplied agent label — sanitize.
        pushWrapped(sanitizeProgressText(contentText), width, lines);
        return clampLines(lines, width);
      }
      const outcome = typeof details.outcome === "string" ? details.outcome : undefined;
      if (outcome) {
        // UX-1: `aborted` is handled for forward-compat exhaustiveness. The live
        // foreground path does NOT currently reach `aborted`/failed-no-output here
        // (t01's foreground seam throws those before renderResult) — tracked as a
        // t01-seam follow-up; the renderer stays ready for when the seam changes.
        lines.push(outcomeBadgeLine(theme, outcome, details.cutOff === true, details.agent));
      }
      // SEC-2 + UX-2: the model reads result.content verbatim (with the t02
      // agent-ID trailer); the HUMAN view strips that trailer (the footer carries
      // the ID + a single resumable hint) and sanitizes control sequences. This
      // builds a local display string only — result.content is never mutated.
      const body = sanitizeProgressText(stripAgentTrailerForDisplay(contentText));
      if (body) pushWrapped(body, width, lines);
      const footer: string[] = [];
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
      const usage = formatUsageLine(details.usage);
      if (usage) footer.push(`usage: ${usage}`);
      if (details.resumable === true) {
        // UX-2: the ID rides in the footer (not a duplicated raw trailer frame).
        const id =
          typeof details.agentId === "string" && isAgentId(details.agentId)
            ? details.agentId
            : undefined;
        footer.push(id ? `resumable via SendMessage — agent ${id}` : "resumable via SendMessage");
      }
      // Wrap each footer line to width (word-wrap, ANSI-aware) as a final guard.
      for (const f of footer) pushColored(theme, "muted", f, width, lines);
      return clampLines(lines.length ? lines : [""], width);
    },
  };
}

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// --- shared width/theme render helpers ---
//
// Extracted from subagent-render.ts so the subagent status panel and the tool
// renderers share ONE clamp/wrap/theme discipline. `theme` is Pi's Theme
// (fg/bold); every access is null-guarded so a print-mode/absent theme degrades
// to plain text and a renderer can never throw into Pi's render loop.

/** `theme.fg(color, text)` when available, else the plain text. */
export function themedFg(theme: unknown, color: string, text: string): string {
  const t = theme as { fg?: (c: string, s: string) => string } | undefined;
  return typeof t?.fg === "function" ? t.fg(color, text) : text;
}

/** `theme.bold(text)` when available, else the plain text. */
export function themedBold(theme: unknown, text: string): string {
  const t = theme as { bold?: (s: string) => string } | undefined;
  return typeof t?.bold === "function" ? t.bold(text) : text;
}

// Width-aware line helpers, backed by pi-tui's OWN column measure. pi-tui throws
// an uncaughtException — killing the whole process — if a rendered line's visible
// width exceeds the terminal, and it decides that with visibleWidth() (grapheme +
// East-Asian-width + tabs=3). We MUST use the same function so our clamp agrees
// exactly with the check pi-tui enforces; a code-unit approximation silently
// disagrees on CJK/wide/tab content and still crashes.

/** Append `text` wrapped to `width` visible columns (ANSI- and wide-char-aware). */
export function pushWrapped(text: string, width: number, into: string[]): void {
  for (const l of wrapTextWithAnsi(String(text ?? ""), Math.max(1, width))) into.push(l);
}

/** Wrap `text` to `width`, coloring each segment; every emitted line is <= width columns. */
export function pushColored(
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
export function clampLines(lines: string[], width: number): string[] {
  if (width <= 0) return lines.map(() => "");
  return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l));
}

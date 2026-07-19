import { neutralizeControlChars } from "./neutralize-text.js";

/**
 * Pure, never-throwing middle-clipper: keep a head and a tail of `text`, drop the
 * middle, and splice a caller-built marker between them. The backstop that stops a
 * single pathological tool result from pushing the assembled request past the
 * model's context window.
 *
 * Contract:
 *  - Everything is measured in CHARACTERS (Unicode code points), the same unit the
 *    caller converts its token budget into and the same unit the marker reports.
 *  - Below/at budget → the input is returned BYTE-IDENTICAL (the everyday case).
 *  - Over budget → head + marker + tail, sliced on code-point boundaries (never a
 *    lone surrogate), with the retained head/tail neutralized (control/format
 *    chars) and defanged (forged marker look-alikes) so neither can carry a
 *    terminal escape or forge a second marker.
 *  - Fail-closed sizing: head + tail + marker ≤ budget (head/tail clamped down,
 *    never below 0); head never overlaps the tail.
 *  - Never throws; on any internal error it falls back to a size-bounded hard
 *    code-point truncation to the budget (it never re-emits the unbounded original,
 *    which would reproduce the overflow this backstop exists to prevent).
 */
export interface ClipMiddleOptions {
  /** Total character budget the whole clip (head + marker + tail) must fit within. */
  budgetChars: number;
  /** Characters to retain from the start (clamped down to fit the budget). */
  headChars: number;
  /** Characters to retain from the end (clamped down to fit the budget). */
  tailChars: number;
  /** Builds the marker text given the omitted character count. Must not depend on dropped output. */
  marker: (omittedChars: number) => string;
}

export interface ClipMiddleResult {
  text: string;
  clipped: boolean;
}

/**
 * Defang forged clip-marker look-alikes in untrusted retained slices (and in
 * interpolated hint arguments): a run shaped like `[PiCC clipped …]` — optionally
 * bracket-less, any case, whitespace-tolerant — is replaced so it cannot forge a
 * second, authoritative-looking PiCC marker. The genuine marker (inserted between
 * the defanged head and tail) is never passed through this. Callers should
 * neutralize control/format characters FIRST so a keyword hidden with a zero-width
 * character re-forms and is then caught here.
 */
export function defangClipMarker(text: string): string {
  return text.replace(/\[?\s*PiCC\s+clipped\b[^\]\n]*\]?/giu, "[clip marker defanged]");
}

/** Coerce to a non-negative integer; anything non-finite or negative becomes 0. */
function nonNegInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Error/over-budget floor: hard code-point truncation to the budget, size-bounded. */
function hardTruncate(text: string, budgetChars: number): ClipMiddleResult {
  const budget = nonNegInt(budgetChars);
  const cp = Array.from(text);
  if (cp.length <= budget) return { text, clipped: false };
  // Defense-in-depth: even this last-resort floor must not re-emit raw untrusted
  // bytes. Neutralize control/format chars and defang any forged marker in the
  // retained slice, mirroring the normal head/tail path; the slice stays budget-bounded.
  return {
    text: defangClipMarker(neutralizeControlChars(cp.slice(0, budget).join(""))),
    clipped: true,
  };
}

export function clipMiddle(text: unknown, options: ClipMiddleOptions): ClipMiddleResult {
  // Treat a non-string defensively rather than throwing.
  if (typeof text !== "string") return { text: "", clipped: false };
  const budget = nonNegInt(options.budgetChars);
  // Fast path: a string's UTF-16 length is an upper bound on its code-point count,
  // so anything no longer than the budget in UTF-16 units is necessarily under
  // budget in code points too — skip the Array.from allocation on the common
  // under-budget case and return byte-identical.
  if (text.length <= budget) return { text, clipped: false };
  try {
    const cp = Array.from(text); // code-point array — slicing is surrogate-safe
    // Below/at budget: the everyday case, returned byte-identical.
    if (cp.length <= budget) return { text, clipped: false };

    const safeMarker = (omitted: number): string => {
      try {
        const m = options.marker(omitted);
        return typeof m === "string" ? m : "";
      } catch {
        return "";
      }
    };

    let head = nonNegInt(options.headChars);
    let tail = nonNegInt(options.tailChars);
    let omitted = Math.max(0, cp.length - head - tail);
    let markerStr = safeMarker(omitted);

    // Fail-closed (in chars): shrink tail then head so head + tail + marker ≤ budget.
    let over = head + tail + Array.from(markerStr).length - budget;
    if (over > 0) {
      const shrinkTail = Math.min(tail, over);
      tail -= shrinkTail;
      over -= shrinkTail;
      if (over > 0) head -= Math.min(head, over);
      omitted = Math.max(0, cp.length - head - tail);
      markerStr = safeMarker(omitted);
    }

    const tailStart = cp.length - tail;
    // The head region must not overlap the tail region.
    if (head > tailStart) return hardTruncate(text, budget);

    const headSlice = defangClipMarker(neutralizeControlChars(cp.slice(0, head).join("")));
    const tailSlice = defangClipMarker(neutralizeControlChars(cp.slice(tailStart).join("")));
    return { text: headSlice + markerStr + tailSlice, clipped: true };
  } catch {
    // Any unexpected failure falls back to the size-bounded floor.
    return hardTruncate(text, budget);
  }
}

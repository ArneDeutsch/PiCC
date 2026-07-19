/**
 * Codepoint-safe control / format neutralization — the shared core relied on by
 * every place that lifts untrusted or oversized text into model context.
 *
 * SECURITY — what this guarantees: a SOFT, LLM-interpretation boundary against
 * control / format-character injection, NOT a hard parser boundary. Concretely it:
 *   - NFC-normalizes, then REMOVES every zero-width / format character — BOM,
 *     ZWSP/ZWNJ/ZWJ (U+200B..U+200D), word joiner (U+2060), ZWNBSP/BOM (U+FEFF)
 *     and the rest of the `\p{Cf}` format class (which subsumes those explicit
 *     points) — so a character hidden INSIDE a keyword cannot slip a forged marker
 *     past a downstream matcher. Removed (not spaced) so the keyword re-forms and
 *     any caller-specific defang then catches it;
 *   - replaces every OTHER control character (incl. `\r`, ESC, BEL, NUL, and thus
 *     the introducer of any ANSI/CSI/OSC terminal sequence) with a space, keeping
 *     only `\n`/`\t`, so no terminal escape survives.
 * The source stays pure-ASCII (no invisible bytes): the format class is matched by
 * the Unicode property `\p{Cf}`, never by embedding the raw code points. Callers
 * layer their own marker-look-alike defang on top of this core.
 */
export function neutralizeControlChars(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Cc}/gu, (c) => (c === "\n" || c === "\t" ? c : " "));
}

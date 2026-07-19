import { clipMiddle, defangClipMarker } from "../util/clip-middle.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import { sanitizeLine } from "./subagent-progress.js";
import { toClaudeToolName } from "./tool-map.js";

/**
 * Tool-result clip backstop: bound a single oversized tool result before it enters
 * model context. Head + tail are kept, the middle is dropped, and a distinctive,
 * PiCC-authored, model-visible marker with a tool-appropriate recovery hint is
 * spliced in. This covers the results Pi's own 50 KB built-in truncation never
 * touches — Claude-named tools, subagent/Task dispatch results, MCP outputs.
 *
 * The pure slicing/marker mechanics live in `util/clip-middle.ts`; this module owns
 * the runtime-facing policy: which blocks are eligible (text only), the token→char
 * budget conversion, and the input-only recovery hint.
 */

/**
 * Token→char factor mirroring Pi's `estimateTokens` (≈ bytes/4). The config knob
 * is in tokens; the whole clip is evaluated in chars and the marker reports chars,
 * so the conversion happens exactly once, here at the boundary.
 */
const CHARS_PER_TOKEN = 4;

/** Cap on an interpolated hint argument (a file path or command) before it enters the marker. */
const HINT_ARG_MAX = 160;

/**
 * Sanitize a model-supplied input argument for the marker. The order mirrors the
 * retained-slice path in `clipMiddle`: flatten to a single length-capped line
 * (`sanitizeLine`), THEN `neutralizeControlChars`, THEN `defangClipMarker`.
 * `sanitizeLine` strips only C0/C1/DEL by range — NOT the `\p{Cf}` format class
 * (zero-width / word-joiner / BOM). Neutralizing before defanging removes those, so
 * a keyword hidden with a zero-width character re-forms and is then caught, closing
 * the bypass where a hostile `file_path`/`command` could otherwise re-form a forged
 * marker inside this PiCC-authored hint. Marker-structural brackets are then dropped
 * so an argument cannot inject `[`/`]` into the marker body. Returns "" for anything
 * non-string.
 */
function sanitizeArg(value: unknown): string {
  if (typeof value !== "string") return "";
  const flattened = neutralizeControlChars(sanitizeLine(value, HINT_ARG_MAX));
  return defangClipMarker(flattened).replace(/[[\]]/g, "");
}

/**
 * Tool-appropriate recovery hint — a pure function of the tool name and the
 * model-supplied input args ONLY, never the dropped output. Read points at a
 * narrower re-read; Grep at a tighter pattern / smaller window; everything else
 * (Bash, MCP, subagent dispatch) at narrowing the command.
 */
function recoveryHint(claudeTool: string, input: Record<string, unknown>): string {
  if (claudeTool === "Read") {
    // Forward-defensive: Pi's built-in Read is pre-bounded below the clip budget, so a Read
    // result rarely reaches this clip in production — this hint covers a Claude-named/re-mapped
    // Read whose output is not so bounded.
    const fp = sanitizeArg(input.file_path ?? input.path);
    const target = fp ? `\`${fp}\`` : "the file";
    return `re-read ${target} over a narrower range (offset=<line> limit=<count>) to recover the omitted region`;
  }
  if (claudeTool === "Grep") {
    return "re-run the search with a tighter pattern or a smaller head_limit/offset to recover the omitted matches";
  }
  const cmd = sanitizeArg(input.command);
  const narrow = cmd ? ` (narrow \`${cmd}\`)` : "";
  return `re-run a narrower command${narrow} — target a specific path, request fewer entries, or pipe through a filter — to recover the omitted output`;
}

/** Marker builder: distinctive `[PiCC clipped …]`, honest char count, tool-appropriate hint. */
function makeMarker(claudeTool: string, hint: string): (omittedChars: number) => string {
  // `claudeTool` comes from toClaudeToolName, which passes unknown/MCP tool names through
  // verbatim — so a hostile project/MCP tool name containing `]`/newline/`PiCC clipped`
  // could otherwise forge or break out of this PiCC-authored marker. Run it through the
  // same sanitizeArg the hint args use (known names like Read/Grep/Bash are byte-identical);
  // fall back to a neutral label if a name is stripped to nothing.
  const safeTool = sanitizeArg(claudeTool) || "tool";
  return (omittedChars) =>
    `\n\n[PiCC clipped ${String(Number(omittedChars))} characters from the middle of this ${safeTool} output — ${hint}]\n\n`;
}

/** Split the post-marker budget into a head and a (slightly smaller-or-equal) tail. */
function splitHeadTail(avail: number): { head: number; tail: number } {
  const head = Math.ceil(avail / 2);
  return { head, tail: avail - head };
}

/**
 * Clip every oversized text block in a tool result's content array. Returns the
 * SAME array reference when nothing is clipped, so an everyday-sized result is left
 * byte-identical and the caller can cheaply detect "unchanged". Non-array content
 * and non-text blocks (image/`data`/other) pass through untouched. Never throws.
 */
export function clipOversizedToolResult(
  content: unknown,
  clipMaxTokens: number,
  piToolName: string,
  input: Record<string, unknown>,
): unknown {
  // Convert the token budget to CHARS once; everything below is in chars.
  const budgetChars = Math.max(1, Math.floor((Number(clipMaxTokens) || 0) * CHARS_PER_TOKEN));
  // Pi's tool_result event always delivers `content` as a content-block array
  // (ToolResultEventBase.content is (TextContent | ImageContent)[]); this guard is
  // a defensive floor for a hand-built/degraded caller, never the live path.
  if (!Array.isArray(content)) return content;

  const claudeTool = toClaudeToolName(piToolName);
  const marker = makeMarker(claudeTool, recoveryHint(claudeTool, input));
  // Reserve room for the marker (worst-case count digits); clipMiddle re-clamps
  // head/tail to hold head + tail + marker ≤ budget regardless of this estimate.
  const markerReserve = Array.from(marker(budgetChars)).length;
  const { head, tail } = splitHeadTail(Math.max(0, budgetChars - markerReserve));

  let changed = false;
  const out = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const b = block as { type?: unknown; text?: unknown };
    // A "text" block, OR a type-less block carrying a string `.text`, is text
    // (so a type-less text block cannot sidestep the cap); image/data/other blocks
    // are never sliced.
    const isText = b.type === "text" || (b.type === undefined && typeof b.text === "string");
    if (!isText || typeof b.text !== "string") return block;
    const result = clipMiddle(b.text, { budgetChars, headChars: head, tailChars: tail, marker });
    if (!result.clipped) return block;
    changed = true;
    return { ...(block as Record<string, unknown>), text: result.text };
  });
  return changed ? out : content;
}

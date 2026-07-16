import {
  getCapabilities,
  getImageDimensions,
  imageFallback,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// concise-tool-rows t01 — the single self-shell seam.
//
// Pi's default tool shell wraps each row in a Box(paddingX=1, paddingY=1, bgFn):
// paddingY=1 is the colored blank line above AND below the content this feature
// removes. The only lever that drops that padding is `renderShell:"self"`, but
// self mode also drops Pi's colored Box entirely (self renders a plain
// Container, prepends exactly ONE plain "" as the inter-block separator, and
// applies no background). So every row that goes self-shell must RE-APPLY the
// per-line background itself, byte-exact via the theme's own `theme.bg`.
//
// `wrapForSelfShell` does that for any tool without editing its renderers: it
// sets `renderShell:"self"`, wraps the tool's own renderCall/renderResult (or
// injects a generic fallback that reproduces Pi's createCallFallback /
// createResultFallback when the tool has none), and reframes the resulting
// lines — strip the leading/trailing blank lines, keep the 1-column gutter,
// clamp, and re-apply the state-appropriate background per line. The state/slot
// decision lives HERE (once), so it can never diverge between a tool's call and
// result line. The wrapper sits OUTSIDE the individual renderers.
//
// Everything is null-/throw-guarded: `ToolExecutionComponent` calls these
// renderers from a self-render path that is NOT wrapped in try/catch, so an
// unguarded throw (unknown bg slot, absent theme, a negative `repeat`) would
// kill Pi's whole render loop. A no-theme / headless render degrades to plain
// text and never throws.
// ---------------------------------------------------------------------------

/** The colored gutter Pi's default Box adds via `paddingX=1` — one leading col. */
const GUTTER = 1;

/**
 * The inner content width Pi's default Box lays a row out at: full width minus
 * BOTH gutters (`paddingX=1` on each side → `box.js:57` computes
 * `contentWidth = width - paddingX*2`). We render the inner content at this width
 * so a maximally-wide inner line is NOT truncated at the leading gutter and so
 * bg-filling to `width` leaves Pi's guaranteed right-hand background margin
 * (content <= width-2, +1 gutter <= width-1, fill >= 1). Floored at 1 so a
 * renderer is never handed a zero/negative width at degenerate terminal widths.
 */
function innerRenderWidth(width: number): number {
  return Math.max(1, width - 2 * GUTTER);
}

/**
 * The width reframe CLAMPS a content line to before adding the gutter. Same
 * `width - 2*GUTTER` (both-side padding), but floored at 0 rather than 1: at a
 * degenerate width (1 or 2) the 1-col gutter alone already fills the row, so the
 * clamped content must be 0 cols — otherwise `gutter + content` would exceed
 * `width` and force the final (d) clamp to fire and strip the bg reset. Flooring
 * here keeps `gutter + content <= width` at every width, so (d) stays a true
 * no-op and the painted line always ends within the terminal.
 */
function clampContentWidth(width: number): number {
  return Math.max(0, width - 2 * GUTTER);
}

type Component = { render(width: number): string[] };

/** The render context Pi threads to renderCall/renderResult (`getRenderContext`). */
export interface RenderCtx {
  isPartial?: boolean;
  isError?: boolean;
  showImages?: boolean;
  [key: string]: unknown;
}

type ResultShape = {
  content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
  details?: Record<string, unknown>;
};

/** Pi's tool-result content block, exposed for the local `getTextOutput` mirror. */
type ContentBlock = { type?: string; text?: string; data?: string; mimeType?: string };

/** The theme's background slot for a row's state (`toolPendingBg` / …Error… / …Success…). */
export type BgSlot = "toolPendingBg" | "toolErrorBg" | "toolSuccessBg";

/**
 * The single-tone background slot for a row, from the render ctx — identical for
 * the call line and the result line so a row is one tone in every state (pinned
 * to Pi's `tool-execution.js:206-210`: pending → error → success). Tolerant of a
 * missing ctx (unit callers): defaults to the success tone.
 */
export function bgSlotForCtx(ctx: RenderCtx | undefined): BgSlot {
  const c = ctx ?? {};
  return c.isPartial ? "toolPendingBg" : c.isError ? "toolErrorBg" : "toolSuccessBg";
}

// --- theme accessors (null- and throw-guarded) ---

function themedFg(theme: unknown, color: string, text: string): string {
  const t = theme as { fg?: (c: string, s: string) => string } | undefined;
  return typeof t?.fg === "function" ? t.fg(color, text) : text;
}

function themedBold(theme: unknown, text: string): string {
  const t = theme as { bold?: (s: string) => string } | undefined;
  return typeof t?.bold === "function" ? t.bold(text) : text;
}

/**
 * Paint `text` with the given background slot via the theme's OWN `theme.bg`
 * (byte-exact with Pi's default shell). Guarded with try/catch — NOT a mere
 * typeof check like themedFg — because `theme.bg` THROWS on an unknown slot or an
 * absent/partial theme, and this runs on a call site Pi does not try/catch. On
 * any failure (no theme, unknown slot, throw) it returns `text` unpainted so the
 * render loop can never die and a headless/no-theme run degrades to plain text.
 */
export function themedBg(theme: unknown, slot: BgSlot, text: string): string {
  const t = theme as { bg?: (s: string, txt: string) => string } | undefined;
  if (typeof t?.bg !== "function") return text;
  try {
    return t.bg(slot, text);
  } catch {
    return text;
  }
}

// --- width-aware line helpers (pi-tui's OWN measure — NEVER String.length) ---
//
// pi-tui throws an uncaughtException — killing the process — if a rendered line
// exceeds the terminal, and decides that with visibleWidth() (grapheme +
// East-Asian-width + tabs). We MUST clamp with the same function so our reframe
// agrees exactly with the check pi-tui enforces.

/** A line is blank iff its VISIBLE width (after ANSI strip) is 0 — never `=== ""` (a bg-filled pad line is a non-empty raw string). */
function isBlank(line: string): boolean {
  return visibleWidth(line) === 0;
}

/** Drop ONLY leading and trailing blank lines (interior blanks are content, kept). */
function stripBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start] ?? "")) start++;
  while (end > start && isBlank(lines[end - 1] ?? "")) end--;
  return lines.slice(start, end);
}

/** Clamp one line to `width` VISIBLE columns (pi-tui truncate); "" at width<=0. */
function clampLine(line: string, width: number): string {
  if (width <= 0) return "";
  return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

/**
 * Reframe inner-renderer lines into a de-padded, gutter-kept, background-painted
 * row. The ORDER is load-bearing (all four steps are crash/appearance guards):
 *
 *   a. strip ONLY the leading/trailing blank lines (Pi still prepends its single
 *      plain "" separator in self mode, so we must not add our own);
 *   b. clamp each content line to `clampContentWidth(width)` (`width - 2*GUTTER`)
 *      FIRST — the same width the inner renderer laid the line out at (BOTH-side
 *      padding, exactly Pi's Box). This is what stops a maximally-wide inner line
 *      (one that fills `width` columns) from losing its last column to an ellipsis,
 *      and guarantees room for the right-hand bg margin (an un-clamped width-wide
 *      line + gutter would overflow → pi-tui crash);
 *   c. add the 1-column gutter, then pad to EXACTLY `width` with
 *      `Math.max(0, …)` spaces (a naive negative `repeat` throws RangeError) and
 *      paint the WHOLE line via the guarded themedBg — matching Pi's default Box,
 *      which paints gutter + content + fill so the colored band spans the row;
 *      because content is <= width-2 and the gutter is 1, the fill is >= 1, so the
 *      band carries to the right edge with Pi's >=1-col background margin;
 *   d. a final clamp to `width` as a genuine no-op safety net — it must NOT fire
 *      (step (b) keeps every painted line <= width visible cols); if it ever did it
 *      would slice off the trailing `\x1b[49m` bg reset and bleed the background,
 *      so it exists only to guarantee no line can exceed the width.
 *
 * Empty result: if stripping leaves zero content lines, returns [] so Pi
 * collapses/hides the row (`tool-execution.js:183-184`) rather than showing a
 * lone painted blank.
 */
export function reframe(lines: string[], width: number, theme: unknown, slot: BgSlot): string[] {
  const stripped = stripBlankEdges(lines);
  if (stripped.length === 0) return [];
  const contentWidth = clampContentWidth(width); // width - 2*GUTTER, floored at 0
  return stripped.map((raw) => {
    const clamped = clampLine(raw, contentWidth); // (b) clamp BEFORE bg
    const guttered = " ".repeat(GUTTER) + clamped; // (c) 1-col gutter
    const fill = Math.max(0, width - visibleWidth(guttered)); // guard: never negative
    const painted = themedBg(theme, slot, guttered + " ".repeat(fill));
    return clampLine(painted, width); // (d) no-op safety net
  });
}

// --- generic fallback renderer (renderer-less tools) ---

/**
 * The generic call renderer for a tool with no renderCall — byte-identical to
 * Pi's `createCallFallback` (`tool-execution.js:107`): the bold, toolTitle-colored
 * tool name on one line. reframe adds the gutter + background.
 */
export function genericCallComponent(toolName: string, theme: unknown): Component {
  return {
    render(): string[] {
      return [themedFg(theme, "toolTitle", themedBold(theme, toolName))];
    },
  };
}

/**
 * The generic result renderer for a tool with no renderResult — reproduces Pi's
 * `createResultFallback` (`tool-execution.js:109-115`): the result's text output
 * colored `toolOutput`, or nothing when empty. The text transform mirrors Pi's
 * `getTextOutput` (`render-utils.js:35-53`) EXACTLY (not a sanitizeProgressText
 * join, which diverges): strip ANSI, sanitize binary/control bytes, remove ALL
 * `\r` (a CRLF payload would otherwise return the cursor to col 0 and corrupt the
 * row), and append `[image WxH]` fallback indicators for image blocks that can't
 * be shown. Pi's own `getTextOutput` is not importable (blocked by the package
 * `exports` map — the deep `dist/core/tools/render-utils.js` path does not
 * resolve), so the transform is reproduced here.
 */
export function genericResultComponent(
  result: ResultShape,
  theme: unknown,
  ctx: RenderCtx | undefined,
): Component {
  const showImages = ctx?.showImages === true;
  return {
    render(width: number): string[] {
      const output = getTextOutput(result, showImages);
      if (!output) return [];
      const lines: string[] = [];
      for (const seg of output.split("\n")) {
        // Color THEN wrap — wrapTextWithAnsi carries the active ANSI across breaks.
        for (const l of wrapTextWithAnsi(themedFg(theme, "toolOutput", seg), Math.max(1, width))) {
          lines.push(l);
        }
      }
      return lines;
    },
  };
}

// --- Pi getTextOutput transform, reproduced (see genericResultComponent) ---

// Reproduced from pi-coding-agent `utils/ansi.js` (derived from strip-ansi, MIT).
// Kept byte-for-byte so the generic fallback matches Pi's own strip.
function ansiRegex(): RegExp {
  const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
  const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;
  const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
  return new RegExp(`${osc}|${csi}`, "g");
}
const ANSI_RE = ansiRegex();

function stripAnsi(value: string): string {
  if (!value.includes("\u001B") && !value.includes("\u009B")) return value;
  return value.replace(ANSI_RE, "");
}

// Reproduced from pi-coding-agent `utils/shell.js` `sanitizeBinaryOutput`: drop
// control chars (except \t \n \r) and Unicode format chars that crash width
// measurement, iterating by code point so surrogate pairs survive.
function sanitizeBinaryOutput(str: string): string {
  return Array.from(str)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("");
}

/** Mirror of Pi's `render-utils.js` `getTextOutput(result, showImages)`. */
function getTextOutput(result: ResultShape | undefined, showImages: boolean): string {
  if (!result) return "";
  const content = Array.isArray(result.content) ? (result.content as ContentBlock[]) : [];
  const textBlocks = content.filter((c) => c && c.type === "text");
  const imageBlocks = content.filter((c) => c && c.type === "image");
  let output = textBlocks
    .map((c) => sanitizeBinaryOutput(stripAnsi(String(c.text || ""))).replace(/\r/g, ""))
    .join("\n");
  const caps = getCapabilities();
  if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
    const imageIndicators = imageBlocks
      .map((img) => {
        const mimeType = img.mimeType ?? "image/unknown";
        const dims =
          img.data && img.mimeType
            ? (getImageDimensions(img.data, img.mimeType) ?? undefined)
            : undefined;
        return imageFallback(mimeType, dims);
      })
      .join("\n");
    output = output ? `${output}\n${imageIndicators}` : imageIndicators;
  }
  return output;
}

// --- the wrapper ---

type CallRenderer = (args: Record<string, unknown>, theme: unknown, ctx: RenderCtx) => Component;
type ResultRenderer = (
  result: ResultShape,
  options: Record<string, unknown>,
  theme: unknown,
  ctx: RenderCtx,
) => Component;

/**
 * Wrap a tool so its row renders self-shell (no top/bottom padding) with the
 * background re-applied per line. Sets `renderShell:"self"` and installs a
 * renderCall/renderResult that:
 *   - invoke the tool's OWN renderer when present (Agent/Task/TaskOutput), else a
 *     generic fallback (all the renderer-less Claude-named tools);
 *   - reframe the inner lines at render(width) time (width is unavailable
 *     earlier) with the single-tone slot from ctx.
 * Every other field — `execute`, `name`, `parameters`, … — passes through
 * unchanged; `result.content` is never mutated (the generic renderer reads a
 * local display string only).
 */
export function wrapForSelfShell(tool: Record<string, unknown>): Record<string, unknown> {
  const toolName = typeof tool.name === "string" ? tool.name : "";
  const innerCall =
    typeof tool.renderCall === "function" ? (tool.renderCall as CallRenderer) : undefined;
  const innerResult =
    typeof tool.renderResult === "function" ? (tool.renderResult as ResultRenderer) : undefined;

  return {
    ...tool,
    renderShell: "self",
    renderCall(args: Record<string, unknown>, theme: unknown, ctx: RenderCtx): Component {
      const slot = bgSlotForCtx(ctx);
      const inner = innerCall
        ? innerCall(args, theme, ctx)
        : genericCallComponent(toolName, theme);
      return {
        render(width: number): string[] {
          // Lay the inner content out at width - 2*GUTTER (Pi's Box both-side
          // padding) so wrap/layout matches the space the painted line occupies —
          // a maximally-wide line keeps every column and reframe's clamp is a no-op.
          return reframe(inner.render(innerRenderWidth(width)), width, theme, slot);
        },
      };
    },
    renderResult(
      result: ResultShape,
      options: Record<string, unknown>,
      theme: unknown,
      ctx: RenderCtx,
    ): Component {
      const slot = bgSlotForCtx(ctx);
      const inner = innerResult
        ? innerResult(result, options, theme, ctx)
        : genericResultComponent(result, theme, ctx);
      return {
        render(width: number): string[] {
          // See renderCall: inner is laid out at the reduced content width so the
          // generic renderer's wrapTextWithAnsi(..., width) wraps to the real space.
          return reframe(inner.render(innerRenderWidth(width)), width, theme, slot);
        },
      };
    },
  };
}

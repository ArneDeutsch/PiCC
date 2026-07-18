import {
  Box,
  getCapabilities,
  getImageDimensions,
  imageFallback,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// The single self-shell seam.
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
// createResultFallback when the tool has none), and frames the resulting lines
// with a REAL pi-tui `Box(paddingX=1, paddingY=0, bgFn)` — the very component
// Pi's default shell uses, minus the two blank padding lines (`paddingY=0`). We
// delegate to Box so rows stay
// compact AND inherit Box's built-in render cache: a settled row re-rendered
// unchanged returns Box's cached lines without re-running the per-line paint,
// which is what removes the per-frame CPU spin. The gutter (Box's `leftPad` from
// `paddingX=1`), the inner content width (`width - 2*paddingX`), and the per-line
// background (our `bgFn` -> guarded `themedBg`) are all Box's, matching the old
// paint byte-for-byte. The state/slot decision lives HERE (once), so it can never
// diverge between a tool's call and result line. The wrapper sits OUTSIDE the
// individual renderers.
//
// Box does NOT strip blank edges and does NOT clamp an over-wide child line, so a
// tiny persistent adapter child sits between the Box and the inner renderer: it
// strips leading/trailing blank inner lines and clamps each line to
// `clampContentWidth(width)` before Box paints, so output stays byte-identical to
// Pi's default Box row minus the padding (including at degenerate widths 1
// and 2, where an un-clamped gutter+content would overflow the row).
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
 * The width the adapter CLAMPS a content line to before Box adds the gutter. Same
 * `width - 2*GUTTER` as the width Box lays the inner out at (`box.js`
 * `contentWidth = width - paddingX*2`), but floored at 0 rather than Box's floor
 * of 1: at a degenerate width (1 or 2) the 1-col gutter alone already fills the
 * row, so the clamped content must be 0 cols — otherwise `gutter + content` would
 * exceed `width` and overflow the painted line past the terminal (Box does NOT
 * truncate an over-wide child line, so the crash-invariant guard lives here).
 * Flooring at 0 keeps `gutter + content <= width` at every width, so the painted
 * line always ends within the terminal. This is why the adapter needs the OUTER
 * width, not the `width-2`-floored-at-1 that Box passes its child: those two
 * differ precisely at widths 1 and 2.
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
// East-Asian-width + tabs). We MUST clamp with the same function so the adapter
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

// --- generic fallback renderer (renderer-less tools) ---

/**
 * The generic call renderer for a tool with no renderCall — byte-identical to
 * Pi's `createCallFallback` (`tool-execution.js:107`): the bold, toolTitle-colored
 * tool name on one line. The Box adds the gutter + background.
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
 *
 * Tabs are then normalized to three spaces — exactly what Pi's own fallback does.
 * Pi renders a renderer-less result via `new Text(...)`, and pi-tui `Text.render`
 * runs `this.text.replace(/\t/g, "   ")` (a flat 3-space replace, confirmed in
 * `@earendil-works/pi-tui/dist/components/text.js`) BEFORE `wrapTextWithAnsi`.
 * `getTextOutput`/`sanitizeBinaryOutput` preserve `\t`, so without this the raw
 * tab would render instead of Pi's 3-space form — a small divergence from the
 * "content visually unchanged" promise. Done on the raw segment before coloring
 * (color spans the whole segment, so a pre-color replace is equivalent) and before
 * wrapping, matching Pi's order. ONLY the generic fallback path needs this; the
 * own-renderer and built-in paths delegate to Pi's renderers, which handle tabs.
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
        // Normalize tabs to 3 spaces to match Pi's Text.render (which replaces
        // \t with "   " before wrapping), then color THEN wrap —
        // wrapTextWithAnsi carries the active ANSI across breaks.
        const tabbed = seg.replace(/\t/g, "   ");
        for (const l of wrapTextWithAnsi(themedFg(theme, "toolOutput", tabbed), Math.max(1, width))) {
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

/**
 * Mirror of Pi's `render-utils.js` `getTextOutput(result, showImages)`. Exported
 * so the Pi-contract smoke test can pin this reproduction against Pi's own
 * `getTextOutput` (imported via an absolute `file://` URL, the deep path being
 * `exports`-blocked) — a Pi version bump that changes the transform fails loudly.
 */
export function getTextOutput(result: ResultShape | undefined, showImages: boolean): string {
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
 * The component the wrapper returns to Pi. It carries the INNER component under
 * `__inner` so the next render can thread `ctx.lastComponent` back to the inner
 * renderer (see `innerCtxForLastComponent`); it also carries the persistent
 * pi-tui `Box` (`__box`) and its blank-edge adapter (`__adapter`) so the SAME Box
 * survives across frames and its render cache can actually hit (a fresh Box per
 * frame would never match its own cache).
 */
type WrapperComponent = Component & {
  __inner?: Component;
  __box?: Box;
  __adapter?: BlankEdgeAdapter;
};

/**
 * The single persistent child of the Box. Box neither strips blank edges nor
 * clamps an over-wide child line, so this adapter does BOTH before Box paints —
 * the framing's step (a) strip + step (b) clamp:
 *   - `inner.render(w)` renders at Box's `contentWidth` (`w = max(1, width-2)`),
 *     the same width the inner saw before;
 *   - leading/trailing blank inner lines are dropped (Pi still prepends its one
 *     plain "" separator in self mode, so we must not add our own);
 *   - each surviving line is clamped to `clampContentWidth(outerWidth)`
 *     (`max(0, width-2)`), NOT to `w` — the two differ at widths 1 and 2, where
 *     content must clamp to 0 so `gutter + content` never overflows the row.
 * `inner` and `outerWidth` are MUTABLE fields updated in place each frame so the
 * adapter object identity — and therefore `Box.children` — never changes (Box's
 * `addChild`/`removeChild` invalidate its cache; a field swap does not).
 *
 * `invalidate()` satisfies pi-tui's `Component` contract (required by
 * `Box.addChild`). Nothing invokes it in this design: the Box is not part of Pi's
 * component tree — our wrapper calls `box.render` directly — so `Box.invalidate`
 * (which would forward to children) never fires here, and tone/theme changes are
 * caught by Box's `bgSample` re-sampling, not by invalidation. It is a
 * type-satisfaction stub that forwards to the inner renderer if it exposes one.
 */
type BlankEdgeAdapter = Component & {
  inner: Component;
  outerWidth: number;
  invalidate(): void;
};

function makeBlankEdgeAdapter(inner: Component): BlankEdgeAdapter {
  return {
    inner,
    outerWidth: 0,
    render(contentWidth: number): string[] {
      const clampTo = clampContentWidth(this.outerWidth);
      return stripBlankEdges(this.inner.render(contentWidth)).map((line) =>
        clampLine(line, clampTo),
      );
    },
    invalidate(): void {
      (this.inner as { invalidate?: () => void }).invalidate?.();
    },
  };
}

/**
 * Thread `ctx.lastComponent` for the built-ins' incremental renderers.
 *
 * `ToolExecutionComponent` caches the component WE return and hands it back as
 * `ctx.lastComponent` on the next render (`tool-execution.js:226,248`). The
 * built-in renderers reuse THAT for incremental state — `read.js:259,267`
 * (`?? new Text`), `bash.js:335,351` (`?? new BashResultRenderComponent`),
 * `edit.js:66,224,270` (`instanceof Box` reuse). A naive wrap hands the inner
 * renderer OUR wrapper; `edit.js:66`'s `instanceof Box` cast then misfires and
 * silently loses the incremental state (`read` tolerates it via `?? new Text`,
 * `edit` does not). So we stash the inner component on the wrapper (`__inner`)
 * and hand the inner renderer the PREVIOUS INNER component, preserving every
 * other ctx field.
 */
function innerCtxForLastComponent(ctx: RenderCtx): RenderCtx {
  const prev = ctx?.lastComponent as WrapperComponent | undefined;
  return { ...ctx, lastComponent: prev?.__inner };
}

/**
 * Build the self-shell wrapper component: frame the inner with a real pi-tui
 * `Box(paddingX=GUTTER, paddingY=0, bgFn)` (Pi's own row component, minus the
 * blank padding lines). The Box lays the adapter out at `width - 2*GUTTER`, adds
 * the 1-col gutter (`leftPad`), pads to `width`, and paints every line via `bgFn`
 * — byte-identical to Pi's default Box row (minus the blank padding), and with
 * Box's built-in render cache (an unchanged re-render returns cached lines without
 * re-running the per-line paint).
 *
 * The Box + adapter are REUSED across frames when the previous wrapper is handed
 * back (`prev`, from `ctx.lastComponent`), because Box's cache only helps if the
 * SAME Box instance persists. On reuse we swap `adapter.inner` (a field, so
 * `Box.children` is untouched and the cache is not invalidated) and refresh the
 * `bgFn` via `setBgFn` (its identity changes each frame but its OUTPUT is stable
 * for an unchanged state/theme, so Box's bgSample check still matches). This swap
 * happens at BUILD time, but is safe under Pi's build-then-render lifecycle: only
 * the wrapper we return here is rendered next, so the mutation targets exactly the
 * Box that render will use.
 *
 * `bgFn` routes through the guarded `themedBg`, so it never throws (the render
 * loop is not try/catch-wrapped) and a headless/no-theme run degrades to plain
 * text (bgFn returns its input unpainted).
 */
function selfShellComponent(
  inner: Component,
  theme: unknown,
  slot: BgSlot,
  prev: WrapperComponent | undefined,
): WrapperComponent {
  const bgFn = (text: string): string => themedBg(theme, slot, text);
  let box = prev?.__box;
  let adapter = prev?.__adapter;
  if (box && adapter) {
    adapter.inner = inner; // swap child content WITHOUT touching Box.children
    box.setBgFn(bgFn); // detected via bgSample, not an invalidation
  } else {
    adapter = makeBlankEdgeAdapter(inner);
    box = new Box(GUTTER, 0, bgFn);
    box.addChild(adapter);
  }
  const persistentBox = box;
  const persistentAdapter = adapter;
  return {
    // Stash the inner so the NEXT render can pass it back as ctx.lastComponent
    // (incremental-render threading — see innerCtxForLastComponent), plus the Box
    // + adapter so the SAME Box (and its cache) persists across frames.
    __inner: inner,
    __box: persistentBox,
    __adapter: persistentAdapter,
    render(width: number): string[] {
      // The adapter needs the OUTER width to clamp content (Box only hands its
      // child `width - 2*GUTTER`); set it before delegating to Box.render.
      persistentAdapter.outerWidth = width;
      return persistentBox.render(width);
    },
  };
}

/**
 * Wrap a tool so its row renders self-shell (no top/bottom padding) with the
 * background re-applied per line. Sets `renderShell:"self"` and installs a
 * renderCall/renderResult that:
 *   - invoke the tool's OWN renderer when present (Agent/Task/TaskOutput and the
 *     re-registered built-ins' `create*ToolDefinition` renderers), else a generic
 *     fallback (all the renderer-less Claude-named tools);
 *   - thread `ctx.lastComponent` to the PREVIOUS INNER component so the built-ins'
 *     incremental rendering (diffs, streamed output) survives the wrap, and reuse
 *     the previous wrapper's persistent Box so its render cache survives too;
 *   - frame the inner lines with a pi-tui Box at render(width) time (width is
 *     unavailable earlier) with the single-tone slot from ctx.
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
      const innerCtx = innerCtxForLastComponent(ctx);
      const inner = innerCall
        ? innerCall(args, theme, innerCtx)
        : genericCallComponent(toolName, theme);
      const prev = ctx?.lastComponent as WrapperComponent | undefined;
      return selfShellComponent(inner, theme, slot, prev);
    },
    renderResult(
      result: ResultShape,
      options: Record<string, unknown>,
      theme: unknown,
      ctx: RenderCtx,
    ): Component {
      const slot = bgSlotForCtx(ctx);
      const innerCtx = innerCtxForLastComponent(ctx);
      const inner = innerResult
        ? innerResult(result, options, theme, innerCtx)
        : genericResultComponent(result, theme, innerCtx);
      const prev = ctx?.lastComponent as WrapperComponent | undefined;
      return selfShellComponent(inner, theme, slot, prev);
    },
  };
}

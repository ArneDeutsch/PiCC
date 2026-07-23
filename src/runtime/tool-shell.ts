import {
  getCapabilities,
  getImageDimensions,
  imageFallback,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatToolDisplayName } from "./tool-display.js";

type Component = { render(width: number): string[] };

/** The render context Pi threads to renderCall/renderResult. */
export interface RenderCtx {
  isPartial?: boolean;
  isError?: boolean;
  showImages?: boolean;
  state?: unknown;
  lastComponent?: unknown;
  [key: string]: unknown;
}

type ResultShape = {
  content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
  details?: Record<string, unknown>;
};

type ContentBlock = { type?: string; text?: string; data?: string; mimeType?: string };

type CallRenderer = (args: Record<string, unknown>, theme: unknown, ctx: RenderCtx) => Component;
type ResultRenderer = (
  result: ResultShape,
  options: Record<string, unknown>,
  theme: unknown,
  ctx: RenderCtx,
) => Component;

export type ToolRowOutcome = "running" | "success" | "failure" | "stopped";

type ThemeColor = "muted" | "success" | "error" | "warning";

const OUTCOME_PRESENTATION: Record<ToolRowOutcome, { glyph: string; color: ThemeColor }> = {
  running: { glyph: "○", color: "muted" },
  success: { glyph: "●", color: "success" },
  failure: { glyph: "✗", color: "error" },
  stopped: { glyph: "■", color: "warning" },
};

interface Generation {
  readonly state?: object;
  outcome: ToolRowOutcome;
  resultRegistered: boolean;
  callRendered: boolean;
  callClaimed: boolean;
  active: boolean;
}

interface Coordinator {
  current?: Generation;
}

interface ContextBrand {
  generation: Generation;
  active: boolean;
}

interface ShellCache {
  width: number;
  outcome: ToolRowOutcome;
  continuation: boolean;
  registered: boolean;
  theme: unknown;
  lines: string[];
  innerLines: string[];
}

interface WrapperMetadata {
  owner: object;
  kind: "call" | "result";
  inner: Component;
  cache?: ShellCache;
}

const coordinators = new WeakMap<object, WeakMap<object, Coordinator>>();
const contextBrands = new WeakMap<object, ContextBrand>();
const wrapperMetadata = new WeakMap<object, WrapperMetadata>();

function objectKey(value: unknown): object | undefined {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? value as object
    : undefined;
}

function safeGet(value: unknown, key: PropertyKey): unknown {
  const object = objectKey(value);
  if (!object) return undefined;
  try {
    return Reflect.get(object, key, object);
  } catch {
    return undefined;
  }
}

function ordinaryOutcome(ctx: unknown): ToolRowOutcome {
  return safeGet(ctx, "isPartial") === true
    ? "running"
    : safeGet(ctx, "isError") === true
      ? "failure"
      : "success";
}

function coordinatorFor(state: object | undefined, owner: object): Coordinator | undefined {
  if (!state) return undefined;
  let byOwner = coordinators.get(state);
  if (!byOwner) {
    byOwner = new WeakMap<object, Coordinator>();
    coordinators.set(state, byOwner);
  }
  let coordinator = byOwner.get(owner);
  if (!coordinator) {
    coordinator = {};
    byOwner.set(owner, coordinator);
  }
  return coordinator;
}

function freshGeneration(ctx: unknown, state: object | undefined, coordinator?: Coordinator): Generation {
  const generation: Generation = {
    state,
    outcome: ordinaryOutcome(ctx),
    resultRegistered: false,
    callRendered: false,
    callClaimed: false,
    active: true,
  };
  if (coordinator) {
    if (coordinator.current) coordinator.current.active = false;
    coordinator.current = generation;
  }
  return generation;
}

function callGeneration(ctx: unknown, owner: object): Generation {
  const state = objectKey(safeGet(ctx, "state"));
  return freshGeneration(ctx, state, coordinatorFor(state, owner));
}

function resultGeneration(ctx: unknown, owner: object): Generation {
  const state = objectKey(safeGet(ctx, "state"));
  const coordinator = coordinatorFor(state, owner);
  const current = coordinator?.current;
  if (current?.active && !current.callRendered) {
    current.resultRegistered = true;
    return current;
  }
  const generation = freshGeneration(ctx, state, coordinator);
  generation.resultRegistered = true;
  // A result-only phase must never make a later result join it as though a call were pending.
  generation.callRendered = true;
  return generation;
}

/**
 * Set a specialized row outcome only while an inner renderer is synchronously being built.
 * The exact derived context is closure-branded; retained, cloned, stale, or foreign contexts fail closed.
 */
export function setToolRowOutcome(context: unknown, outcome: ToolRowOutcome): boolean {
  if (typeof outcome !== "string" || !Object.hasOwn(OUTCOME_PRESENTATION, outcome)) return false;
  const key = objectKey(context);
  if (!key) return false;
  const brand = contextBrands.get(key);
  if (!brand?.active || !brand.generation.active) return false;
  brand.generation.outcome = outcome;
  return true;
}

function themed(theme: unknown, method: "fg" | "bold", args: string[], fallback: string): string {
  const receiver = objectKey(theme);
  if (!receiver) return fallback;
  try {
    const fn = Reflect.get(receiver, method, receiver);
    return typeof fn === "function" ? String(Reflect.apply(fn, receiver, args)) : fallback;
  } catch {
    return fallback;
  }
}

function themedFg(theme: unknown, color: string, text: string): string {
  return themed(theme, "fg", [color, text], text);
}

function themedBold(theme: unknown, text: string): string {
  return themed(theme, "bold", [text], text);
}

const SGR_RE = /\u001b\[[0-9;]*m/gu;

function foregroundSequence(parameters: string): "open" | "reset" | undefined {
  const parts = (parameters === "" ? [0] : parameters.split(";").map(Number));
  if (parts.length === 1 && (parts[0] === 0 || parts[0] === 39)) return "reset";
  if (parts.length === 1 && parts[0] !== undefined &&
    ((parts[0] >= 30 && parts[0] <= 37) || (parts[0] >= 90 && parts[0] <= 97))) return "open";
  if (parts[0] === 38 && ((parts.length === 3 && parts[1] === 5) || (parts.length === 5 && parts[1] === 2)) &&
    parts.slice(2).every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return "open";
  return undefined;
}

function safeStyledText(value: string, expected: string): string | undefined {
  if (value === expected) return value;
  const plain = value.replace(SGR_RE, "");
  if (plain !== expected || value.includes("\u001b]") || /[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/u.test(value) ||
    plain.includes("\u001b")) return undefined;

  const visibleStart = value.indexOf(expected);
  const visibleEnd = visibleStart + expected.length;
  let foregroundOpen = false;
  let openedBeforeText = false;
  let resetAfterText = false;
  let lastEnd = 0;
  for (const match of value.matchAll(SGR_RE)) {
    const index = match.index ?? 0;
    const sequence = foregroundSequence(match[0].slice(2, -1));
    if (!sequence) return undefined;
    foregroundOpen = sequence === "open";
    if (foregroundOpen && index < visibleStart) openedBeforeText = true;
    if (!foregroundOpen && index >= visibleEnd) resetAfterText = true;
    lastEnd = index + match[0].length;
  }
  return openedBeforeText && resetAfterText && !foregroundOpen && lastEnd === value.length ? value : undefined;
}

function genericStyleSequence(parameters: string, modes: { foreground: boolean; bold: boolean }): boolean {
  const parts = (parameters === "" ? [0] : parameters.split(";").map(Number));
  if (parts.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === 0) {
      modes.foreground = false;
      modes.bold = false;
    } else if (part === 1) {
      modes.bold = true;
    } else if (part === 22) {
      modes.bold = false;
    } else if (part === 39) {
      modes.foreground = false;
    } else if (part !== undefined && ((part >= 30 && part <= 37) || (part >= 90 && part <= 97))) {
      modes.foreground = true;
    } else if (part === 38) {
      const mode = parts[index + 1];
      const valueCount = mode === 5 ? 1 : mode === 2 ? 3 : 0;
      const values = parts.slice(index + 2, index + 2 + valueCount);
      if (valueCount === 0 || values.length !== valueCount ||
        values.some((value) => value === undefined || value < 0 || value > 255)) return false;
      modes.foreground = true;
      index += valueCount + 1;
    } else {
      return false;
    }
  }
  return true;
}

function safeGenericStyledText(value: string, expected: string): string | undefined {
  if (value === expected) return value;
  const plain = value.replace(SGR_RE, "");
  if (plain !== expected || value.includes("\u001b]") || /[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/u.test(value) ||
    plain.includes("\u001b")) return undefined;

  const modes = { foreground: false, bold: false };
  for (const match of value.matchAll(SGR_RE)) {
    if (!genericStyleSequence(match[0].slice(2, -1), modes)) return undefined;
  }
  return !modes.foreground && !modes.bold ? value : undefined;
}

function safeGenericStyle(theme: unknown, color: string, text: string, bold = false): string {
  const emphasized = bold ? themedBold(theme, text) : text;
  return safeGenericStyledText(themedFg(theme, color, emphasized), text) ?? text;
}

function markerFor(theme: unknown, outcome: ToolRowOutcome): string {
  const { glyph, color } = OUTCOME_PRESENTATION[outcome];
  const styled = safeStyledText(themedFg(theme, color, glyph), glyph);
  if (!styled) return glyph;
  try {
    return visibleWidth(styled) === 1 ? styled : glyph;
  } catch {
    return glyph;
  }
}

function normalizedWidth(width: number): number {
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
}

function isBlank(line: string): boolean {
  return visibleWidth(line) === 0;
}

function visibleLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start] ?? "")) start++;
  while (end > start && isBlank(lines[end - 1] ?? "")) end--;
  return lines.slice(start, end);
}

function clampLine(line: string, width: number): string {
  if (width <= 0) return "";
  return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

function frameOwned(lines: string[], marker: string, width: number): string[] {
  if (width === 1) return [marker];
  if (width === 2) return [`${marker} `];
  const contentWidth = width - 2;
  if (lines.length === 0) return [marker];
  return lines.map((line, index) => `${index === 0 ? `${marker} ` : "  "}${clampLine(line, contentWidth)}`);
}

function frameContinuation(lines: string[], width: number): string[] {
  if (width < 3) return [];
  const contentWidth = width - 2;
  return lines.map((line) => `  ${clampLine(line, contentWidth)}`);
}

function previousMetadata(ctx: unknown, owner: object, kind: "call" | "result"): WrapperMetadata | undefined {
  // Pi returns our outer component, but native renderers (especially Edit's Box) must reuse the prior inner component.
  const previous = objectKey(safeGet(ctx, "lastComponent"));
  if (!previous) return undefined;
  const metadata = wrapperMetadata.get(previous);
  return metadata?.owner === owner && metadata.kind === kind ? metadata : undefined;
}

function derivedContext(ctx: unknown, lastComponent: Component | undefined): RenderCtx {
  try {
    return { ...(ctx as RenderCtx), lastComponent };
  } catch {
    // A proxy-failing context cannot safely share invocation state; preserve only the prior component.
    return { lastComponent };
  }
}

function constructInner(
  renderer: ((ctx: RenderCtx) => Component) | undefined,
  fallback: () => Component,
  context: RenderCtx,
  generation: Generation,
): Component {
  if (!renderer) return fallback();
  const key = objectKey(context);
  const exactState = objectKey(safeGet(context, "state"));
  const brandable = key !== undefined && generation.state !== undefined && exactState === generation.state;
  const brand: ContextBrand = { generation, active: brandable };
  if (brandable && key) contextBrands.set(key, brand);
  const ordinary = generation.outcome;
  try {
    const component = renderer(context);
    if (objectKey(component) && typeof safeGet(component, "render") === "function") return component;
    generation.outcome = ordinary;
    return fallback();
  } catch {
    generation.outcome = ordinary;
    return fallback();
  } finally {
    brand.active = false;
    if (brandable && key) contextBrands.delete(key);
  }
}

function shellComponent(
  inner: Component,
  theme: unknown,
  generation: Generation,
  kind: "call" | "result",
  owner: object,
  previousCache?: ShellCache,
): Component {
  let cache = previousCache;
  const metadata: WrapperMetadata = { owner, kind, inner, cache };
  const component: Component = {
    render(rawWidth: number): string[] {
      const width = normalizedWidth(rawWidth);
      if (width === 0) return [];

      if (kind === "call") {
        generation.callRendered = true;
        generation.callClaimed = false;
      }
      const continuation = kind === "result" && generation.callClaimed;
      const reusable = cache;
      const sameFrame = generation.outcome !== "running" && reusable !== undefined && reusable.width === width &&
        reusable.outcome === generation.outcome && reusable.continuation === continuation &&
        reusable.registered === generation.resultRegistered && reusable.theme === theme;
      const lines = visibleLines(inner.render(Math.max(1, width - 2)));

      let claims = lines.length > 0;
      if (kind === "call" && !claims) {
        claims = generation.outcome === "running" && !generation.resultRegistered;
      } else if (kind === "result" && !claims && !continuation) {
        claims = true;
      }
      if (kind === "call") generation.callClaimed = claims;

      if (sameFrame && reusable && reusable.innerLines.length === lines.length &&
        reusable.innerLines.every((line, index) => line === lines[index])) {
        return reusable.lines;
      }
      const output = continuation
        ? frameContinuation(lines, width)
        : claims
          ? frameOwned(lines, markerFor(theme, generation.outcome), width)
          : [];

      if (generation.outcome !== "running") {
        cache = {
          width,
          outcome: generation.outcome,
          continuation,
          registered: generation.resultRegistered,
          theme,
          lines: output,
          innerLines: lines,
        };
        metadata.cache = cache;
      }
      return output;
    },
  };
  wrapperMetadata.set(component, metadata);
  return component;
}

/** Pi-compatible generic call fallback for renderer-less or failed renderer construction. */
export function genericCallComponent(toolName: string, theme: unknown): Component {
  const displayName = formatToolDisplayName(toolName);
  return { render: () => [safeGenericStyle(theme, "text", displayName, true)] };
}

/** Pi-compatible generic textual result fallback. */
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
      for (const segment of output.split("\n")) {
        // Match Pi's Text.render order: it normalizes each tab to three spaces before wrapping.
        const tabbed = segment.replace(/\t/gu, "   ");
        for (const line of wrapTextWithAnsi(safeGenericStyle(theme, "toolOutput", tabbed), Math.max(1, width))) {
          lines.push(line);
        }
      }
      return lines;
    },
  };
}

// Pi's renderer utility is exports-blocked, so keep its display-only transform local and contract-tested.
function ansiRegex(): RegExp {
  const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
  const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;
  const csi = "[\\u001B\\u009B][[\\]\\()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
  return new RegExp(`${osc}|${csi}`, "g");
}
const ANSI_RE = ansiRegex();

function stripAnsi(value: string): string {
  if (!value.includes("\u001B") && !value.includes("\u009B")) return value;
  return value.replace(ANSI_RE, "");
}

function sanitizeBinaryOutput(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      // Interlinear annotation controls U+FFF9–U+FFFB break terminal width measurement.
      return code < 0xfff9 || code > 0xfffb;
    })
    .join("");
}

/** Mirror of Pi's `getTextOutput(result, showImages)`. */
export function getTextOutput(result: ResultShape | undefined, showImages: boolean): string {
  if (!result) return "";
  const content = Array.isArray(result.content) ? result.content as ContentBlock[] : [];
  const textBlocks = content.filter((block) => block?.type === "text");
  const imageBlocks = content.filter((block) => block?.type === "image");
  let output = textBlocks
    // Remove every CR (including CRLF's CR) so output cannot return the cursor to column zero.
    .map((block) => sanitizeBinaryOutput(stripAnsi(String(block.text || ""))).replace(/\r/gu, ""))
    .join("\n");
  const capabilities = getCapabilities();
  if (imageBlocks.length > 0 && (!capabilities.images || !showImages)) {
    const indicators = imageBlocks
      .map((image) => {
        const mimeType = image.mimeType ?? "image/unknown";
        const dimensions = image.data && image.mimeType
          ? getImageDimensions(image.data, image.mimeType) ?? undefined
          : undefined;
        return imageFallback(mimeType, dimensions);
      })
      .join("\n");
    output = output ? `${output}\n${indicators}` : indicators;
  }
  return output;
}

/**
 * Put a tool behind Pi's public self-render shell and add one foreground state glyph to the
 * invocation's first visible textual line. The wrapper preserves every non-rendering field.
 */
export function wrapForSelfShell(tool: Record<string, unknown>): Record<string, unknown> {
  const owner = {};
  const toolName = typeof tool.name === "string" ? tool.name : "";
  const innerCall = typeof tool.renderCall === "function" ? tool.renderCall as CallRenderer : undefined;
  const innerResult = typeof tool.renderResult === "function" ? tool.renderResult as ResultRenderer : undefined;

  return {
    ...tool,
    renderShell: "self",
    renderCall(args: Record<string, unknown>, theme: unknown, ctx: RenderCtx): Component {
      const generation = callGeneration(ctx, owner);
      const previous = previousMetadata(ctx, owner, "call");
      const context = derivedContext(ctx, previous?.inner);
      const inner = constructInner(
        innerCall ? (derived) => innerCall(args, theme, derived) : undefined,
        () => genericCallComponent(toolName, theme),
        context,
        generation,
      );
      return shellComponent(inner, theme, generation, "call", owner, previous?.cache);
    },
    renderResult(
      result: ResultShape,
      options: Record<string, unknown>,
      theme: unknown,
      ctx: RenderCtx,
    ): Component {
      const generation = resultGeneration(ctx, owner);
      const previous = previousMetadata(ctx, owner, "result");
      const context = derivedContext(ctx, previous?.inner);
      const inner = constructInner(
        innerResult ? (derived) => innerResult(result, options, theme, derived) : undefined,
        () => genericResultComponent(result, theme, context),
        context,
        generation,
      );
      return shellComponent(inner, theme, generation, "result", owner, previous?.cache);
    },
  };
}

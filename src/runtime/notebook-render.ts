import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "../runtime-host.js";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  SUPPORTED_IMAGE_MIMES,
  nonVisionImageNote,
  toImageContent,
} from "./image-ingest.js";
import { modelSupportsImages } from "../util/model.js";
import {
  resolveNotebookCellIdentifiers,
  type NotebookCellIdentifier,
} from "./notebook-edit-core.js";

/**
 * Cell-aware Jupyter `.ipynb` renderer. Parses an nbformat v4 notebook and
 * renders it cell by cell (source + outputs) into an interleaved array of text
 * and real image blocks: a raster image output (one of `SUPPORTED_IMAGE_MIMES`)
 * becomes an `ImageContent` block on a vision-capable model and degrades to a
 * text placeholder otherwise. Every other output — structured JSON, `image/svg+xml`,
 * a base64 `<img>` embedded in a `text/html` repr — stays elided text; only a raster
 * output value ever crosses into an image block.
 *
 * Whole-file structural problems (invalid JSON, no top-level `cells` array,
 * over-size) throw an `Error` naming the reason so a caller can translate them into
 * a read-shaped error or notice. Per-cell oddities degrade gracefully in-output
 * instead of throwing.
 */

/**
 * Content block emitted for one notebook: a coalesced text run or a normalized
 * raster image output.
 */
export type NotebookBlock = TextContent | ImageContent;

/**
 * Secondary sanity cap on the raw notebook string. This renderer only ever sees
 * an already-read string, so any cap here runs post-slurp and cannot prevent an
 * OOM on the read itself; that is why it is only a cheap backstop. The
 * load-bearing OOM protection must reject an over-size file before loading its
 * complete contents. Larger than search-tools' text cap because notebooks
 * legitimately embed images.
 */
export const MAX_NOTEBOOK_BYTES = 25 * 1024 * 1024;

/**
 * Per-notebook cap on emitted image blocks. Beyond it, further raster outputs
 * elide to the placeholder even on a vision model, bounding request size against a
 * notebook that carries hundreds of plots.
 */
const MAX_NOTEBOOK_IMAGE_BLOCKS = 20;

/** Output byte cap handed to the normalizer for each rendered image block. */
const PER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

interface RenderState {
  /** True once any text output was truncated. */
  truncated: boolean;
  /** True iff the active model can receive image content. */
  vision: boolean;
  /** How many image blocks have been emitted so far (bounded by the cap above). */
  imageBlocks: number;
}

/**
 * Buffers text fragments (joined with newlines) into `TextContent` blocks and
 * flushes them whenever an image block is emitted, so text and image content stay
 * interleaved in document order.
 */
class ContentBuilder {
  private readonly blocks: NotebookBlock[] = [];
  private buffer: string[] = [];

  text(fragment: string): void {
    this.buffer.push(fragment);
  }

  image(block: ImageContent): void {
    this.flush();
    this.blocks.push(block);
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    this.blocks.push({ type: "text", text: this.buffer.join("\n") });
    this.buffer = [];
  }

  build(): NotebookBlock[] {
    this.flush();
    return this.blocks;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * nbformat `source`/`text`/text-mime values are string OR array<string>; the
 * fragments already carry their own newlines, so array parts join with "".
 */
function joinText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : "")).join("");
  }
  return "";
}

/**
 * Strip ANSI/VT control sequences (colored stdout, tracebacks, tqdm/pytest/rich
 * all emit real ESC bytes) and guarantee no raw ESC survives — never crash on
 * odd input.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b/g, "");
}

/**
 * Collapse any embedded `data:<mime>;base64,<blob>` URI to a short placeholder so
 * base64 payloads (routinely embedded in `text/html` reprs, e.g. inline `<img>`)
 * never reach the model as text.
 */
function collapseDataUris(s: string): string {
  return s.replace(
    /data:([\w.+-]+\/[\w.+-]+)?;base64,[A-Za-z0-9+/=]+/g,
    (_m, mime: string | undefined) => `<data:${mime ?? ""};base64 … elided>`,
  );
}

/**
 * Render a text output: strip ANSI, collapse embedded base64 data URIs, then run
 * through the shared truncateHead helper, appending a visible `<...>` marker when
 * truncation fires (the helper itself emits none). Every rendered text output
 * (stream, text/plain, text/html) flows through here, so no raw ESC byte or base64
 * blob can reach the model as text.
 */
function renderText(raw: string, state: RenderState): string {
  const cleaned = collapseDataUris(stripAnsi(raw));
  const t = truncateHead(cleaned, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!t.truncated) return t.content;
  state.truncated = true;
  return `${t.content}\n<output truncated: showing first ${t.outputLines} of ${t.totalLines} lines>`;
}

/**
 * Truthful placeholder for an elided non-image output; the raw payload is never
 * emitted. Only string-valued raster image mimes carry base64 and get the
 * `~<N> bytes (base64)` size; structured JSON is a JS object (not base64), and
 * `image/svg+xml` is XML text (not base64), so both get a claim-free descriptor.
 */
function nonTextPlaceholder(mime: string, value: unknown): string {
  // Structured JSON payloads (application/json, application/vnd.*+json) arrive as
  // a JS object — not base64, and joinText would report a bogus ~0-byte size.
  if (mime === "application/json" || /\+json$/.test(mime)) {
    return `<${mime} output elided (structured data)>`;
  }
  // Raster images carry a base64 string; report its length truthfully. SVG is
  // XML text, so it is excluded here and falls through to the generic notice.
  if (mime.startsWith("image/") && mime !== "image/svg+xml") {
    const raw = joinText(value);
    if (raw.length > 0) {
      return `<${mime} output elided — ~${raw.length} bytes (base64)>`;
    }
  }
  // Everything else (svg XML, unknown binary, empty payloads): a claim-free notice.
  return `<${mime} output elided>`;
}

/** A supported raster mime is the only kind that may become an image block. */
function isRasterImageMime(mime: string): mime is (typeof SUPPORTED_IMAGE_MIMES)[number] {
  return (SUPPORTED_IMAGE_MIMES as readonly string[]).includes(mime);
}

/**
 * Emit a raster image output either as a real image block (vision model, under the
 * per-notebook cap, decodable) or as an elided placeholder. The base64 decode seam
 * lives here: a notebook image value is a base64 string, so decode to a Buffer
 * before handing it to the normalizer, which magic-byte-validates, guards against
 * decompression bombs, normalizes, and throws on anything invalid or oversize.
 */
async function emitImageOutput(
  builder: ContentBuilder,
  mime: string,
  value: unknown,
  state: RenderState,
): Promise<void> {
  if (!state.vision) {
    // The model cannot see images at all: keep the placeholder and say why.
    builder.text(`${nonTextPlaceholder(mime, value)}\n${nonVisionImageNote(undefined)}`);
    return;
  }
  if (state.imageBlocks >= MAX_NOTEBOOK_IMAGE_BLOCKS) {
    builder.text(nonTextPlaceholder(mime, value));
    return;
  }
  const base64 = joinText(value);
  try {
    const image = await toImageContent(Buffer.from(base64, "base64"), mime, {
      maxBytes: PER_IMAGE_MAX_BYTES,
    });
    builder.image(image);
    state.imageBlocks++;
  } catch {
    // Invalid bytes, oversize, or an unverifiable header: degrade to the
    // placeholder rather than failing the whole notebook read.
    builder.text(nonTextPlaceholder(mime, value));
  }
}

/**
 * Render an `execute_result` / `display_data` data bundle. When both `text/plain`
 * and `text/html` are present, prefer `text/plain` (a single representation; the
 * html repr is duplicated noise and a common base64 carrier).
 */
async function renderData(data: unknown, builder: ContentBuilder, state: RenderState): Promise<void> {
  if (data === null || typeof data !== "object") {
    builder.text("<empty output>");
    return;
  }
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) {
    builder.text("<empty output>");
    return;
  }
  const hasPlain = entries.some(([mime]) => mime === "text/plain");
  for (const [mime, value] of entries) {
    if (mime === "text/html" && hasPlain) continue;
    if (mime.startsWith("text/")) {
      builder.text(renderText(joinText(value), state));
    } else if (isRasterImageMime(mime)) {
      await emitImageOutput(builder, mime, value, state);
    } else {
      builder.text(nonTextPlaceholder(mime, value));
    }
  }
}

/** Render one output entry of a code cell into the builder. */
async function renderOutput(output: unknown, builder: ContentBuilder, state: RenderState): Promise<void> {
  if (output === null || typeof output !== "object") {
    builder.text("<malformed output>");
    return;
  }
  const o = output as Record<string, unknown>;
  switch (o.output_type) {
    case "stream": {
      const name = typeof o.name === "string" ? o.name : "stream";
      builder.text(`(${name})\n${renderText(joinText(o.text), state)}`);
      return;
    }
    case "execute_result":
    case "display_data":
      await renderData(o.data, builder, state);
      return;
    case "error": {
      const ename = typeof o.ename === "string" ? o.ename : "Error";
      const evalue = typeof o.evalue === "string" ? o.evalue : "";
      const traceback = Array.isArray(o.traceback)
        ? o.traceback.map((line) => (typeof line === "string" ? line : String(line))).join("\n")
        : "";
      const head = `${ename}: ${evalue}`;
      builder.text(traceback ? `${head}\n${stripAnsi(traceback)}` : head);
      return;
    }
    default:
      builder.text(`<unsupported output type: ${String(o.output_type)}>`);
  }
}

/** Render a single cell: header line, source, and (code + outputs) an `Outputs:` block. */
async function renderCell(
  cell: unknown,
  index: number,
  identifier: NotebookCellIdentifier,
  builder: ContentBuilder,
  state: RenderState,
): Promise<void> {
  if (cell === null || typeof cell !== "object") {
    builder.text(`=== Cell ${index} (malformed) ===`);
    builder.text("<malformed cell>");
    return;
  }
  const c = cell as Record<string, unknown>;
  const type = typeof c.cell_type === "string" ? c.cell_type : "unknown";
  const identifierText = identifier.kind === "unavailable-fallback"
    ? `, id unavailable: do not use ${identifier.fallback}; it identifies another cell`
    : `, id=${identifier.identifier}`;
  builder.text(`=== Cell ${index} (${type}${identifierText}) ===`);

  const source = joinText(c.source);
  if (source.length > 0) builder.text(source);

  if (type === "code" && Array.isArray(c.outputs) && c.outputs.length > 0) {
    builder.text("Outputs:");
    for (const output of c.outputs) {
      await renderOutput(output, builder, state);
    }
  }
}

/**
 * Render `jsonText` (the raw contents of an `.ipynb` file) into interleaved text
 * and image content for `opts.model`. Vision capability decides whether raster
 * outputs become real image blocks. Throws on a whole-file structural problem.
 */
export async function renderNotebook(
  jsonText: string,
  opts: { model?: unknown },
): Promise<{ content: NotebookBlock[]; truncated: boolean }> {
  if (jsonText.length > MAX_NOTEBOOK_BYTES) {
    throw new Error(`renderNotebook: notebook too large (${jsonText.length} bytes)`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`renderNotebook: not valid notebook JSON (${errorMessage(err)})`);
  }

  if (doc === null || typeof doc !== "object" || !Array.isArray((doc as { cells?: unknown }).cells)) {
    throw new Error('renderNotebook: not a Jupyter notebook (no top-level "cells" array)');
  }
  const cells = (doc as { cells: unknown[] }).cells;

  if (cells.length === 0) {
    return { content: [{ type: "text", text: "Notebook has 0 cells." }], truncated: false };
  }

  const state: RenderState = {
    truncated: false,
    vision: modelSupportsImages(opts.model),
    imageBlocks: 0,
  };
  const builder = new ContentBuilder();
  const identifiers = resolveNotebookCellIdentifiers(cells);
  for (let index = 0; index < cells.length; index++) {
    if (index > 0) builder.text("");
    await renderCell(cells[index], index, identifiers[index]!, builder, state);
  }

  return { content: builder.build(), truncated: state.truncated };
}

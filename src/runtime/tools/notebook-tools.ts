import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * NotebookRead (plan F18 / ticket #16): a real, cell-based reader for Jupyter
 * `.ipynb` notebooks, replacing the former degraded no-op stub.
 *
 * PiCC's inherited `Read` tool does NOT special-case `.ipynb`, so without this
 * tool a model reading a notebook gets the raw JSON — base64 image blobs,
 * metadata, execution counts and all. This tool parses an nbformat v4 notebook
 * and renders it cell by cell (source + outputs) as readable text, eliding
 * binary/image outputs to a short placeholder and truncating oversized text
 * outputs. It is text-only: PiCC targets text-oriented GPT/Codex models, so
 * image outputs are noted, never rendered or handed back as image data.
 *
 * Whole-file structural problems (missing file, invalid JSON, no top-level
 * `cells` array) throw an `Error` prefixed `NotebookRead:` that names the
 * resolved path — matching Grep/Glob/WebFetch, which throw rather than return a
 * notice. Per-cell oddities degrade gracefully in-output instead of throwing.
 */

// Generous but finite cap so a hostile/huge notebook can't OOM the process
// before elision runs (truncateHead bounds output, not input). Larger than
// search-tools' 2 MB text cap because notebooks legitimately embed images.
const MAX_NOTEBOOK_BYTES = 25 * 1024 * 1024;

interface RenderState {
  /** Set when any text output was truncated, surfaced in `details`. */
  truncated: boolean;
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
 * never reach the model — upholding the feature's hard "never emit base64" rule.
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
 * (stream, text/plain, text/html) flows through here, so no raw ESC byte or
 * base64 blob can reach the model.
 */
function renderText(raw: string, state: RenderState): string {
  const cleaned = collapseDataUris(stripAnsi(raw));
  const t = truncateHead(cleaned, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!t.truncated) return t.content;
  state.truncated = true;
  return `${t.content}\n<output truncated: showing first ${t.outputLines} of ${t.totalLines} lines>`;
}

/**
 * Truthful placeholder for an elided non-text output; the raw payload is never
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
  // Everything else (svg XML, unknown binary, empty payloads): a claim-free notice
  // — no byte count / base64 claim we cannot back.
  return `<${mime} output elided>`;
}

/**
 * Render an `execute_result` / `display_data` data bundle. When both `text/plain`
 * and `text/html` are present, prefer `text/plain` (Claude Code renders a single
 * representation; the html repr is duplicated noise and a common base64 carrier).
 */
function renderData(data: unknown, state: RenderState): string {
  if (data === null || typeof data !== "object") return "<empty output>";
  const entries = Object.entries(data as Record<string, unknown>);
  const hasPlain = entries.some(([mime]) => mime === "text/plain");
  const parts: string[] = [];
  for (const [mime, value] of entries) {
    // Prefer text/plain over text/html when both exist (single representation).
    if (mime === "text/html" && hasPlain) continue;
    if (mime.startsWith("text/")) {
      parts.push(renderText(joinText(value), state));
    } else {
      parts.push(nonTextPlaceholder(mime, value));
    }
  }
  return parts.length > 0 ? parts.join("\n") : "<empty output>";
}

/** Render one output entry of a code cell. */
function renderOutput(output: unknown, state: RenderState): string {
  if (output === null || typeof output !== "object") return "<malformed output>";
  const o = output as Record<string, unknown>;
  switch (o.output_type) {
    case "stream": {
      const name = typeof o.name === "string" ? o.name : "stream";
      return `(${name})\n${renderText(joinText(o.text), state)}`;
    }
    case "execute_result":
    case "display_data":
      return renderData(o.data, state);
    case "error": {
      const ename = typeof o.ename === "string" ? o.ename : "Error";
      const evalue = typeof o.evalue === "string" ? o.evalue : "";
      const traceback = Array.isArray(o.traceback)
        ? o.traceback.map((line) => (typeof line === "string" ? line : String(line))).join("\n")
        : "";
      const head = `${ename}: ${evalue}`;
      return traceback ? `${head}\n${stripAnsi(traceback)}` : head;
    }
    default:
      return `<unsupported output type: ${String(o.output_type)}>`;
  }
}

/** Render a single cell: header line, source, and (code + outputs) an `Outputs:` block. */
function renderCell(cell: unknown, index: number, state: RenderState): string {
  if (cell === null || typeof cell !== "object") {
    return `=== Cell ${index} (malformed) ===\n<malformed cell>`;
  }
  const c = cell as Record<string, unknown>;
  const type = typeof c.cell_type === "string" ? c.cell_type : "unknown";
  const id = typeof c.id === "string" && c.id.length > 0 ? c.id : undefined;
  const header = `=== Cell ${index} (${type}${id !== undefined ? `, id=${id}` : ""}) ===`;

  const lines: string[] = [header];
  const source = joinText(c.source);
  if (source.length > 0) lines.push(source);

  if (type === "code" && Array.isArray(c.outputs) && c.outputs.length > 0) {
    lines.push("Outputs:");
    lines.push(c.outputs.map((output) => renderOutput(output, state)).join("\n"));
  }
  return lines.join("\n");
}

export function createNotebookReadTool(getCwd: () => string): ToolDefinition {
  return defineTool({
    name: "NotebookRead",
    label: "NotebookRead",
    description:
      "Read a Jupyter .ipynb notebook cell by cell — each cell's source and outputs " +
      "(stream text, text/plain results, error tracebacks), with binary/image outputs " +
      "elided and oversized text truncated — instead of the raw notebook JSON. Prefer this " +
      "over Read for .ipynb files (Read returns noisy JSON with base64 image blobs).",
    parameters: Type.Object({
      notebook_path: Type.String({
        description: "Path to the Jupyter notebook (.ipynb) file to read.",
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/require-await
    async execute(_toolCallId, params) {
      const abs = path.resolve(getCwd(), params.notebook_path);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") {
          throw new Error(`NotebookRead: permission denied: ${abs}`);
        }
        throw new Error(`NotebookRead: notebook not found: ${abs}`);
      }
      if (!stat.isFile()) {
        throw new Error(`NotebookRead: not a file: ${abs}`);
      }
      if (stat.size > MAX_NOTEBOOK_BYTES) {
        throw new Error(`NotebookRead: notebook too large (${stat.size} bytes): ${abs}`);
      }

      let doc: unknown;
      try {
        doc = JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch (err) {
        throw new Error(`NotebookRead: not valid notebook JSON: ${abs} (${errorMessage(err)})`);
      }

      if (doc === null || typeof doc !== "object" || !Array.isArray((doc as { cells?: unknown }).cells)) {
        throw new Error(
          `NotebookRead: not a Jupyter notebook (no top-level "cells" array): ${abs}`,
        );
      }
      const cells = (doc as { cells: unknown[] }).cells;

      if (cells.length === 0) {
        return {
          content: [{ type: "text" as const, text: `NotebookRead: notebook has 0 cells: ${abs}` }],
          details: { path: abs, cells: 0, truncated: false },
        };
      }

      const state: RenderState = { truncated: false };
      const text = cells.map((cell, index) => renderCell(cell, index, state)).join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
        details: { path: abs, cells: cells.length, truncated: state.truncated },
      };
    },
  });
}

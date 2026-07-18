import zlib from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { NON_VISION_IMAGE_NOTE } from "../src/runtime/image-ingest.js";
import { renderNotebook, type NotebookBlock } from "../src/runtime/notebook-render.js";

// ---------------------------------------------------------------------------
// Model doubles + helpers
// ---------------------------------------------------------------------------

const VISION_MODEL = { input: ["text", "image"] };
const TEXT_MODEL = { input: ["text"] };
const ESC = "\x1b"; // real ESC control byte

interface Rendered {
  content: NotebookBlock[];
  truncated: boolean;
  /** All text blocks coalesced (CRLF→LF), for the text-matrix assertions. */
  text: string;
}

async function render(nb: unknown, model: unknown): Promise<Rendered> {
  const { content, truncated } = await renderNotebook(JSON.stringify(nb), { model });
  const text = content
    .filter((b): b is Extract<NotebookBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .replace(/\r\n/g, "\n");
  return { content, truncated, text };
}

/** Extract the rendered text for a given 0-based cell index. */
function cellBlock(text: string, index: number): string {
  const block = text.split("=== Cell ").find((p) => p.startsWith(`${index} `));
  return block ?? "";
}

// --- deterministic in-test PNG builder (no committed binaries) --------------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A real 8-bit grayscale PNG of w×h whose IDAT actually decodes (Photon-decodable). */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  const raw = Buffer.alloc(height * (1 + width)); // filter byte + row, all zero
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([PNG_SIG, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

const PNG_BASE64 = makePng(16, 16).toString("base64");

// ---------------------------------------------------------------------------
// Ported text matrix (from test/notebook-read.test.ts), driven on a NON-VISION
// model so every output is text — mirroring the original tool's behavior.
// ---------------------------------------------------------------------------

const OVERSIZE_TAIL = "OVERSIZE_TAIL_MARKER_ZZZ";
const OVERSIZE_TEXT = `${Array.from({ length: 2500 }, (_, i) => `log line ${i}`).join("\n")}\n${OVERSIZE_TAIL}\n`;
const IMAGE_BLOB = "A".repeat(20_000);
const HTML_DATA_BLOB = "B".repeat(15_000);

function buildNotebook(): unknown {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      { cell_type: "markdown", id: "md-1", source: "# Title\nSome **markdown** prose." },
      {
        cell_type: "code",
        id: "cell-stream",
        source: "print('hello from stdout')",
        outputs: [{ output_type: "stream", name: "stdout", text: `${ESC}[32mhello from stdout${ESC}[0m\n` }],
      },
      {
        cell_type: "code",
        id: "cell-result",
        source: "6 * 7",
        outputs: [{ output_type: "execute_result", execution_count: 1, data: { "text/plain": "42" } }],
      },
      {
        cell_type: "code",
        id: "cell-error",
        source: "raise ValueError('boom')",
        outputs: [
          {
            output_type: "error",
            ename: "ValueError",
            evalue: "bad value here",
            traceback: [
              `${ESC}[0;31m---------------------------------${ESC}[0m`,
              `${ESC}[0;32mTRACEBACK_LINE_ONE${ESC}[0m`,
              '  File "<stdin>", line 1',
            ],
          },
        ],
      },
      {
        cell_type: "code",
        id: "cell-image",
        source: "fig",
        outputs: [
          {
            output_type: "display_data",
            data: { "image/png": IMAGE_BLOB, "text/plain": "<Figure size 640x480>" },
          },
        ],
      },
      {
        cell_type: "code",
        id: "cell-oversize",
        source: "spew()",
        outputs: [{ output_type: "stream", name: "stdout", text: OVERSIZE_TEXT }],
      },
      {
        cell_type: "code",
        id: "cell-html",
        source: "df",
        outputs: [
          {
            output_type: "execute_result",
            execution_count: 2,
            data: { "text/html": "<b>HTMLCONTENT_XYZ</b>", "text/plain": "PLAINREPR_ABC" },
          },
        ],
      },
      { cell_type: "code", id: "cell-empty", source: "x = 1", outputs: [] },
      {
        cell_type: "code",
        id: "cell-array",
        source: ["import os\n", "import sys\n", "print(os.getcwd())"],
        outputs: [],
      },
      { cell_type: "code", source: "NOID_CELL_MARKER = True", outputs: [] },
      {
        cell_type: "code",
        id: "cell-html-img",
        source: "rich_df",
        outputs: [
          {
            output_type: "execute_result",
            execution_count: 3,
            data: { "text/html": `<img src="data:image/png;base64,${HTML_DATA_BLOB}"/> HTMLIMG_MARKER` },
          },
        ],
      },
      {
        cell_type: "code",
        id: "cell-json",
        source: "json_obj",
        outputs: [
          {
            output_type: "execute_result",
            execution_count: 4,
            data: { "application/json": { key: "JSONVAL", nested: [1, 2, 3] } },
          },
        ],
      },
    ],
  };
}

describe("renderNotebook — text matrix (non-vision model)", () => {
  let out: Rendered;

  beforeAll(async () => {
    out = await render(buildNotebook(), TEXT_MODEL);
  });

  it("returns all cells in document order, each with an index + type header", () => {
    for (let i = 0; i <= 11; i++) expect(out.text).toContain(`=== Cell ${i} (`);
    for (let i = 0; i < 11; i++) {
      expect(out.text.indexOf(`=== Cell ${i} (`)).toBeLessThan(out.text.indexOf(`=== Cell ${i + 1} (`));
    }
  });

  it("labels the markdown cell and gives it no Outputs subheader", () => {
    const block = cellBlock(out.text, 0);
    expect(block).toContain("0 (markdown");
    expect(block).toContain("Some **markdown** prose.");
    expect(block).not.toContain("Outputs:");
  });

  it("shows a cell id in the header when present", () => {
    expect(cellBlock(out.text, 1)).toContain("id=cell-stream");
  });

  it("includes stream stdout text under an Outputs subheader with ANSI stripped", () => {
    const block = cellBlock(out.text, 1);
    expect(block).toContain("Outputs:");
    expect(block).toContain("hello from stdout");
    expect(block).not.toContain(ESC);
  });

  it("renders a text/plain execute_result", () => {
    expect(cellBlock(out.text, 2)).toContain("42");
  });

  it("surfaces error ename/evalue + traceback and strips ANSI escapes", () => {
    const block = cellBlock(out.text, 3);
    expect(block).toContain("ValueError: bad value here");
    expect(block).toContain("TRACEBACK_LINE_ONE");
    expect(block).toContain('TRACEBACK_LINE_ONE\n  File "<stdin>", line 1');
    expect(out.text).not.toContain(ESC);
  });

  it("elides a raster image output to a base64 placeholder on a non-vision model", () => {
    const block = cellBlock(out.text, 4);
    expect(out.text).not.toContain(IMAGE_BLOB);
    expect(block).toMatch(/image\/png/);
    expect(block).toMatch(/~\d+ bytes \(base64\)/);
    expect(block).toContain("<Figure size 640x480>");
    // The non-vision degrade note explains the omission to the model.
    expect(block).toContain(NON_VISION_IMAGE_NOTE);
    // No real image content is emitted on a non-vision model.
    expect(out.content.some((b) => b.type === "image")).toBe(false);
  });

  it("truncates an oversized text output (marker present, tail absent)", () => {
    const block = cellBlock(out.text, 5);
    expect(block).toContain("output truncated");
    expect(out.text).not.toContain(OVERSIZE_TAIL);
    expect(out.truncated).toBe(true);
  });

  it("prefers text/plain over text/html when a bundle carries both", () => {
    const block = cellBlock(out.text, 6);
    expect(block).toContain("PLAINREPR_ABC");
    expect(block).not.toContain("HTMLCONTENT_XYZ");
  });

  it("collapses a base64 data: URI embedded in a rendered text/html output", () => {
    const block = cellBlock(out.text, 10);
    expect(block).toContain("HTMLIMG_MARKER");
    expect(out.text).not.toContain(HTML_DATA_BLOB);
    expect(block).toMatch(/data:image\/png;base64 .* elided/);
  });

  it("uses a truthful placeholder for a structured application/json output", () => {
    const block = cellBlock(out.text, 11);
    expect(block).toContain("<application/json output elided (structured data)>");
    expect(block).not.toContain("JSONVAL");
    expect(block).not.toMatch(/base64/);
  });

  it("renders an empty-output code cell with no phantom Outputs section", () => {
    const block = cellBlock(out.text, 7);
    expect(block).toContain("x = 1");
    expect(block).not.toContain("Outputs:");
  });

  it("reassembles an array source correctly", () => {
    expect(cellBlock(out.text, 8)).toContain("import os\nimport sys\nprint(os.getcwd())");
  });

  it("falls back to the 0-based document index for a cell with no id", () => {
    const block = cellBlock(out.text, 9);
    expect(block).toMatch(/^9 \(code\)/);
    expect(block).toContain("NOID_CELL_MARKER");
  });
});

// ---------------------------------------------------------------------------
// Image-output behavior: raster → image block on vision, placeholder otherwise.
// ---------------------------------------------------------------------------

function imageCellNotebook(data: Record<string, unknown>): unknown {
  return {
    nbformat: 4,
    cells: [{ cell_type: "code", source: "plot()", outputs: [{ output_type: "display_data", data }] }],
  };
}

describe("renderNotebook — raster image outputs", () => {
  it("emits a real ImageContent block for an image/png output on a vision model", async () => {
    const { content } = await render(
      imageCellNotebook({ "image/png": PNG_BASE64, "text/plain": "<Figure>" }),
      VISION_MODEL,
    );
    const images = content.filter((b): b is Extract<NotebookBlock, { type: "image" }> => b.type === "image");
    expect(images.length).toBe(1);
    expect(images[0]!.type).toBe("image");
    expect(images[0]!.mimeType).toBe("image/png");
    // The sibling text/plain repr is still rendered as text, interleaved with the image.
    expect(content.some((b) => b.type === "text" && b.text.includes("<Figure>"))).toBe(true);
    // The raw base64 never leaks into any text block.
    const allText = content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    expect(allText).not.toContain(PNG_BASE64);
  });

  it("keeps the placeholder (no image block) for the same output on a non-vision model", async () => {
    const { content, text } = await render(
      imageCellNotebook({ "image/png": PNG_BASE64, "text/plain": "<Figure>" }),
      TEXT_MODEL,
    );
    expect(content.some((b) => b.type === "image")).toBe(false);
    expect(text).toMatch(/<image\/png output elided/);
    expect(text).toContain(NON_VISION_IMAGE_NOTE);
    expect(text).not.toContain(PNG_BASE64);
  });

  it("caps emitted image blocks at MAX_NOTEBOOK_IMAGE_BLOCKS and elides the overflow to a placeholder", async () => {
    // 21 code cells, each with a valid image/png output, exceeds the per-notebook
    // cap of 20 by exactly one — the 21st raster output must elide even on vision.
    const cells = Array.from({ length: 21 }, (_, i) => ({
      cell_type: "code",
      source: `plot_${i}()`,
      outputs: [{ output_type: "display_data", data: { "image/png": PNG_BASE64 } }],
    }));
    const { content } = await render({ nbformat: 4, cells }, VISION_MODEL);
    const images = content.filter((b) => b.type === "image");
    expect(images.length).toBe(20);
    const allText = content
      .filter((b): b is Extract<NotebookBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    // Exactly one raster output crossed the cap and rendered as the placeholder.
    expect(allText.match(/<image\/png output elided/g)?.length).toBe(1);
  });

  it("degrades an invalid (non-image) base64 raster output to the placeholder on a vision model", async () => {
    const { content, text } = await render(
      imageCellNotebook({ "image/png": Buffer.from("not a real png").toString("base64") }),
      VISION_MODEL,
    );
    expect(content.some((b) => b.type === "image")).toBe(false);
    expect(text).toMatch(/<image\/png output elided/);
  });
});

// ---------------------------------------------------------------------------
// Boundary cases: html/svg/data-uri elision never crosses into an image block.
// ---------------------------------------------------------------------------

describe("renderNotebook — elision boundaries hold on a vision model", () => {
  it("keeps a base64 <img> inside a text/html repr as elided text (no image block)", async () => {
    const blob = "C".repeat(12_000);
    const { content, text } = await render(
      imageCellNotebook({ "text/html": `<img src="data:image/png;base64,${blob}"/> HTML_ONLY_MARKER` }),
      VISION_MODEL,
    );
    expect(content.some((b) => b.type === "image")).toBe(false);
    expect(text).toContain("HTML_ONLY_MARKER");
    expect(text).not.toContain(blob);
    expect(text).toMatch(/data:image\/png;base64 .* elided/);
  });

  it("keeps an image/svg+xml output as elided text, never an image block", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const { content, text } = await render(imageCellNotebook({ "image/svg+xml": svg }), VISION_MODEL);
    expect(content.some((b) => b.type === "image")).toBe(false);
    expect(text).toContain("<image/svg+xml output elided>");
  });

  it("collapses a data: URI embedded in a text/plain output on a vision model", async () => {
    const blob = "D".repeat(9_000);
    const { content, text } = await render(
      imageCellNotebook({ "text/plain": `before data:image/png;base64,${blob} after` }),
      VISION_MODEL,
    );
    expect(content.some((b) => b.type === "image")).toBe(false);
    expect(text).not.toContain(blob);
    expect(text).toMatch(/data:image\/png;base64 .* elided/);
  });
});

// ---------------------------------------------------------------------------
// Empty + structural error paths.
// ---------------------------------------------------------------------------

describe("renderNotebook — edge cases", () => {
  it("returns a notice (not a throw) for a valid notebook with 0 cells", async () => {
    const { content, text } = await render({ nbformat: 4, cells: [] }, TEXT_MODEL);
    expect(text).toContain("0 cells");
    expect(content.every((b) => b.type === "text")).toBe(true);
  });

  it("throws a clear error for invalid JSON", async () => {
    await expect(renderNotebook("this is not { valid json", { model: TEXT_MODEL })).rejects.toThrow(
      /not valid notebook JSON/,
    );
  });

  it("throws a not-a-notebook error when the top-level cells array is missing", async () => {
    await expect(
      renderNotebook(JSON.stringify({ nbformat: 3, worksheets: [] }), { model: TEXT_MODEL }),
    ).rejects.toThrow(/not a Jupyter notebook/);
  });

  it("throws an over-size error for a notebook string past the cap", async () => {
    const huge = "x".repeat(26 * 1024 * 1024);
    await expect(renderNotebook(huge, { model: TEXT_MODEL })).rejects.toThrow(/too large/);
  });

  it("degrades unknown cell/output types and null cell/output in-output (no throw)", async () => {
    const { text } = await render(
      {
        nbformat: 4,
        cells: [
          { cell_type: "code", source: "ok", outputs: [{ output_type: "widget_view" }] },
          { cell_type: "code", source: "nulls", outputs: [null] },
          null,
          { cell_type: "banana", source: "UNKNOWN_TYPE_MARKER" },
        ],
      },
      TEXT_MODEL,
    );
    expect(text).toContain("<unsupported output type: widget_view>");
    expect(text).toContain("<malformed output>");
    expect(text).toContain("<malformed cell>");
    expect(text).toContain("UNKNOWN_TYPE_MARKER");
  });
});

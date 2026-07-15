import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createNotebookReadTool } from "../src/runtime/tools/notebook-tools.js";

// ---------------------------------------------------------------------------
// Harness (mirrors test/tools-parity.test.ts)
// ---------------------------------------------------------------------------

const CTX = {} as never;
const ESC = ""; // real ESC control byte

interface RunResult {
  text: string;
  details: Record<string, unknown>;
}

async function run(tool: ToolDefinition, params: unknown): Promise<RunResult> {
  const res = await tool.execute("test-call", params, undefined, undefined, CTX);
  const first = res.content[0] as { type: string; text: string };
  return { text: first.text.replace(/\r\n/g, "\n"), details: res.details as Record<string, unknown> };
}

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Extract the rendered block for a given 0-based cell index. */
function cellBlock(text: string, index: number): string {
  const block = text.split("=== Cell ").find((p) => p.startsWith(`${index} `));
  return block ?? "";
}

// The oversized text cell: >2000 lines with a unique tail marker so truncation
// drops the tail. Kept as a module constant so the assertion can key on it.
const OVERSIZE_TAIL = "OVERSIZE_TAIL_MARKER_ZZZ";
const OVERSIZE_TEXT = `${Array.from({ length: 2500 }, (_, i) => `log line ${i}`).join("\n")}\n${OVERSIZE_TAIL}\n`;
const IMAGE_BLOB = "A".repeat(20_000);
// A distinct blob embedded inside a text/html data: URI (proves the collapse
// covers HTML, not just the standalone image/png elision path).
const HTML_DATA_BLOB = "B".repeat(15_000);

function buildNotebook(): unknown {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      // 0: markdown
      { cell_type: "markdown", id: "md-1", source: "# Title\nSome **markdown** prose." },
      // 1: code + stream stdout (has id); text carries a real ESC byte so the
      // ANSI strip must engage on the stream path too (not just tracebacks).
      {
        cell_type: "code",
        id: "cell-stream",
        source: "print('hello from stdout')",
        outputs: [
          {
            output_type: "stream",
            name: "stdout",
            text: `${ESC}[32mhello from stdout${ESC}[0m\n`,
          },
        ],
      },
      // 2: code + execute_result text/plain
      {
        cell_type: "code",
        id: "cell-result",
        source: "6 * 7",
        outputs: [
          { output_type: "execute_result", execution_count: 1, data: { "text/plain": "42" } },
        ],
      },
      // 3: code + error with a real ESC byte in the traceback
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
              "  File \"<stdin>\", line 1",
            ],
          },
        ],
      },
      // 4: code + display_data large image/png (elided, NOT truncated)
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
      // 5: DISTINCT oversized text cell (exercises truncation, not the image)
      {
        cell_type: "code",
        id: "cell-oversize",
        source: "spew()",
        outputs: [{ output_type: "stream", name: "stdout", text: OVERSIZE_TEXT }],
      },
      // 6: code + execute_result with BOTH text/html and text/plain — text/plain
      // is preferred (single representation); the html repr must NOT be rendered.
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
      // 7: code with empty outputs
      { cell_type: "code", id: "cell-empty", source: "x = 1", outputs: [] },
      // 8: array source (multi-line reassembly)
      {
        cell_type: "code",
        id: "cell-array",
        source: ["import os\n", "import sys\n", "print(os.getcwd())"],
        outputs: [],
      },
      // 9: no id (index-fallback)
      { cell_type: "code", source: "NOID_CELL_MARKER = True", outputs: [] },
      // 10: text/html ONLY (no text/plain) embedding a data:image/png;base64 URI —
      // the blob must be collapsed to a placeholder, never emitted.
      {
        cell_type: "code",
        id: "cell-html-img",
        source: "rich_df",
        outputs: [
          {
            output_type: "execute_result",
            execution_count: 3,
            data: {
              "text/html": `<img src="data:image/png;base64,${HTML_DATA_BLOB}"/> HTMLIMG_MARKER`,
            },
          },
        ],
      },
      // 11: application/json — value is a JS object (not base64); the placeholder
      // must be truthful (no bogus "~0 bytes (base64)").
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

// ---------------------------------------------------------------------------
// Rich fixture notebook
// ---------------------------------------------------------------------------

describe("NotebookRead tool", () => {
  let dir: string;
  let tool: ToolDefinition;
  let text: string;
  let details: Record<string, unknown>;

  beforeAll(async () => {
    dir = mkTmpDir("picc-nb-");
    fs.writeFileSync(path.join(dir, "rich.ipynb"), JSON.stringify(buildNotebook()));
    tool = createNotebookReadTool(() => dir);
    const res = await run(tool, { notebook_path: "rich.ipynb" });
    text = res.text;
    details = res.details;
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns all cells in document order, each with an index + type header", () => {
    for (let i = 0; i <= 11; i++) {
      expect(text).toContain(`=== Cell ${i} (`);
    }
    // Document order preserved.
    for (let i = 0; i < 11; i++) {
      expect(text.indexOf(`=== Cell ${i} (`)).toBeLessThan(text.indexOf(`=== Cell ${i + 1} (`));
    }
    expect(details.cells).toBe(12);
  });

  it("labels the markdown cell and gives it no Outputs subheader", () => {
    const block = cellBlock(text, 0);
    expect(block).toContain("0 (markdown");
    expect(block).toContain("Some **markdown** prose.");
    expect(block).not.toContain("Outputs:");
  });

  it("shows a cell id in the header when present", () => {
    expect(cellBlock(text, 1)).toContain("id=cell-stream");
  });

  it("includes stream stdout text under an Outputs subheader with ANSI stripped", () => {
    const block = cellBlock(text, 1);
    expect(block).toContain("Outputs:");
    // The visible text survives; the surrounding ESC color codes are gone.
    expect(block).toContain("hello from stdout");
    expect(block).not.toContain(ESC);
  });

  it("renders a text/plain execute_result", () => {
    expect(cellBlock(text, 2)).toContain("42");
  });

  it("surfaces error ename/evalue + traceback and strips ANSI escapes", () => {
    const block = cellBlock(text, 3);
    expect(block).toContain("ValueError: bad value here");
    expect(block).toContain("TRACEBACK_LINE_ONE");
    // traceback elements join with "\n" (NOT ""): prove the newline BETWEEN two
    // elements survives — this fails under a wrong "" join that runs them together.
    expect(block).toContain('TRACEBACK_LINE_ONE\n  File "<stdin>", line 1');
    // The whole rendered output must contain no raw ESC byte.
    expect(text).not.toContain(ESC);
  });

  it("elides a large image output to a base64 placeholder (blob absent)", () => {
    const block = cellBlock(text, 4);
    expect(text).not.toContain(IMAGE_BLOB);
    expect(block).toMatch(/image\/png/);
    // Pin the size shape so a bogus/omitted byte count can't slip through.
    expect(block).toMatch(/~\d+ bytes \(base64\)/);
    expect(block).toContain("<Figure size 640x480>"); // sibling text/plain still rendered
  });

  it("truncates an oversized text output (marker present, tail absent)", () => {
    const block = cellBlock(text, 5);
    expect(block).toContain("output truncated");
    expect(text).not.toContain(OVERSIZE_TAIL);
    expect(details.truncated).toBe(true);
  });

  it("prefers text/plain over text/html when a bundle carries both", () => {
    const block = cellBlock(text, 6);
    expect(block).toContain("PLAINREPR_ABC"); // text/plain rendered
    expect(block).not.toContain("HTMLCONTENT_XYZ"); // html repr NOT duplicated
  });

  it("collapses a base64 data: URI embedded in a rendered text/html output", () => {
    const block = cellBlock(text, 10);
    expect(block).toContain("HTMLIMG_MARKER"); // the html text/branch did render
    expect(text).not.toContain(HTML_DATA_BLOB); // the base64 blob never emitted
    expect(block).toMatch(/data:image\/png;base64 .* elided/); // placeholder present
  });

  it("uses a truthful placeholder for a structured application/json output", () => {
    const block = cellBlock(text, 11);
    expect(block).toContain("<application/json output elided (structured data)>");
    expect(block).not.toContain("JSONVAL"); // the object payload is not dumped
    expect(block).not.toMatch(/base64/); // NOT the bogus "~0 bytes (base64)"
  });

  it("renders an empty-output code cell with no phantom Outputs section", () => {
    const block = cellBlock(text, 7);
    expect(block).toContain("x = 1");
    expect(block).not.toContain("Outputs:");
  });

  it("reassembles an array source correctly", () => {
    expect(cellBlock(text, 8)).toContain("import os\nimport sys\nprint(os.getcwd())");
  });

  it("falls back to the 0-based document index for a cell with no id", () => {
    const block = cellBlock(text, 9);
    expect(block).toMatch(/^9 \(code\)/); // no "id=" segment
    expect(block).toContain("NOID_CELL_MARKER");
  });
});

// ---------------------------------------------------------------------------
// Empty + error paths
// ---------------------------------------------------------------------------

describe("NotebookRead edge cases", () => {
  let dir: string;
  let tool: ToolDefinition;

  beforeAll(() => {
    dir = mkTmpDir("picc-nb-edge-");
    fs.writeFileSync(path.join(dir, "empty.ipynb"), JSON.stringify({ nbformat: 4, cells: [] }));
    fs.writeFileSync(path.join(dir, "bad.ipynb"), "this is not { valid json");
    fs.writeFileSync(path.join(dir, "v3.ipynb"), JSON.stringify({ nbformat: 3, worksheets: [] }));
    // Malformed-but-structurally-valid notebook: unknown cell/output types and
    // null cell/output must degrade in-output, NOT throw.
    fs.writeFileSync(
      path.join(dir, "degrade.ipynb"),
      JSON.stringify({
        nbformat: 4,
        cells: [
          { cell_type: "code", source: "ok", outputs: [{ output_type: "widget_view" }] },
          { cell_type: "code", source: "nulls", outputs: [null] },
          null,
          { cell_type: "banana", source: "UNKNOWN_TYPE_MARKER" },
        ],
      }),
    );
    tool = createNotebookReadTool(() => dir);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns a notice (not a throw) for a valid notebook with 0 cells", async () => {
    const { text, details } = await run(tool, { notebook_path: "empty.ipynb" });
    expect(text).toContain("0 cells");
    expect(details.cells).toBe(0);
  });

  it("throws a path-naming error for a nonexistent notebook", async () => {
    await expect(run(tool, { notebook_path: "does-not-exist.ipynb" })).rejects.toThrow(
      /NotebookRead:.*does-not-exist\.ipynb/,
    );
  });

  it("throws a clear NotebookRead error for invalid JSON", async () => {
    await expect(run(tool, { notebook_path: "bad.ipynb" })).rejects.toThrow(
      /NotebookRead: not valid notebook JSON:.*bad\.ipynb/,
    );
  });

  it("throws a not-a-notebook error (not corrupt-JSON) when top-level cells is missing", async () => {
    await expect(run(tool, { notebook_path: "v3.ipynb" })).rejects.toThrow(
      /NotebookRead: not a Jupyter notebook.*v3\.ipynb/,
    );
  });

  it("degrades unknown cell/output types and null cell/output in-output (no throw)", async () => {
    const { text, details } = await run(tool, { notebook_path: "degrade.ipynb" });
    // The read SUCCEEDS: all four cells accounted for, nothing thrown.
    expect(details.cells).toBe(4);
    // Unknown output_type → notice, not a throw.
    expect(text).toContain("<unsupported output type: widget_view>");
    // null output → notice.
    expect(text).toContain("<malformed output>");
    // null cell → notice.
    expect(text).toContain("<malformed cell>");
    // Unknown cell_type still renders its source (labelled with the given type).
    expect(text).toContain("UNKNOWN_TYPE_MARKER");
  });
});

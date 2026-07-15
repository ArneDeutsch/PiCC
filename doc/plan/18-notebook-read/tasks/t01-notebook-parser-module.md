# t01: NotebookRead parser/renderer module + unit tests

## Goal

A self-contained module `src/runtime/tools/notebook-tools.ts` exports a factory
`createNotebookReadTool(getCwd)` that returns a real `ToolDefinition` which parses a
Jupyter `.ipynb` and returns its cells (source + outputs) as readable text, eliding
large/binary outputs. It is **not yet wired into the runtime** and nothing is removed
from `DEGRADED_TOOLS` yet — that is t02. A new unit test file exercises the tool by
calling `execute()` directly. After this task the full suite is still green (a new
module + new passing tests; no collisions, nothing removed).

## Context & seams

**Exact exported contract (t02 depends on this — do not change the shape):**

```ts
// src/runtime/tools/notebook-tools.ts
export function createNotebookReadTool(getCwd: () => string): ToolDefinition
```

- Tool `name` and `label`: `"NotebookRead"`.
- Tool `description`: must **steer the model to prefer NotebookRead over Read for
  notebooks** — the only lever here (PiCC's inherited `Read` does NOT special-case
  `.ipynb`, so a vague description means the model keeps calling `Read` and gets the noisy
  raw JSON this feature exists to eliminate). Something like: "Read a Jupyter `.ipynb`
  notebook cell by cell — each cell's source and outputs — instead of raw JSON. Prefer
  this over Read for `.ipynb` files." Model the length/tone on `createWebFetchTool`'s
  description (`web-tools.ts:190-193`).
- Parameters (typebox `Type.Object`): `notebook_path: Type.String({ description: ... })`,
  **required**. (Historical Claude `NotebookRead` schema is `notebook_path` only — keep
  it minimal; see Left open for `cell_id`.)
- Path resolution: `const abs = path.resolve(getCwd(), params.notebook_path)` — exactly
  like `createGrepTool`/`createGlobTool` in `src/runtime/tools/search-tools.ts:701-702,
  798`. `getCwd` is bound at build time so worktree cwd swaps are honoured.
- `execute` returns `{ content: [{ type: "text" as const, text }], details: {...} }` —
  the shape every real tool uses (`web-tools.ts:239`, `search-tools.ts:765`). Text-only:
  **do not** attempt to return image content blocks (PiCC targets text models; the
  SDK's image content type is for user input, not tool results).

**Template to copy:** `createWebFetchTool` (`src/runtime/tools/web-tools.ts:183-250`)
for the `defineTool` skeleton and the `truncateHead(text, { maxLines: DEFAULT_MAX_LINES,
maxBytes: DEFAULT_MAX_BYTES })` output-shaping helper. Reuse these imports:

```ts
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, defineTool, truncateHead,
         type ToolDefinition } from "@earendil-works/pi-coding-agent";
```

**Reading & size guard (before parsing):**
- `fs.statSync(abs)` and **throw** `NotebookRead: notebook too large (<N> bytes): <path>`
  above a bounded cap (pick a generous but finite limit, e.g. 10–25 MB — larger than
  search-tools' 2 MB text cap, since notebooks legitimately embed images) so a hostile/
  huge `.ipynb` can't OOM the process before elision runs (`truncateHead` bounds *output*,
  not input). Then `fs.readFileSync` + `JSON.parse` inside a **broad** `try/catch` (catch
  any throw, incl. a `RangeError` from deeply-nested JSON), surfacing the clean
  "not-valid-JSON" error.

**nbformat v4 parsing rules (verified against the nbformat spec):**
- Top level: `cells[]` (array). If missing/not an array, or JSON parse fails, or the file
  doesn't exist → **throw** a clear `Error` prefixed `NotebookRead:` (matches Grep/Glob/
  WebFetch, which throw rather than returning a notice — that "return a notice" contract is
  only for the degrade stubs). **Every thrown message must name the given/resolved path**
  (like WebFetch's `WebFetch failed for ${url}` — a bare "not found" leaves the model
  unable to tell a wrong relative path from a wrong cwd). Messages: not-found,
  not-valid-JSON, not-a-notebook (the not-a-notebook message must not imply corrupt JSON —
  e.g. an nbformat v3 file with `worksheets[]` and no top-level `cells`).
- **Rendering structure (required — outputs must be unambiguously attributable):** emit a
  per-cell **header line** carrying the cell's 0-based document index and type (and its
  `id` when present), then the joined source, then — for code cells with outputs — an
  explicit **`Outputs:` subheader** before the rendered outputs. A downstream reader must
  never be able to misattribute one cell's output to another; a blank-line separator is
  not sufficient.
- A syntactically valid notebook with `cells: []` → return (do not throw) a short notice
  like `NotebookRead: notebook has 0 cells` so an empty read is distinguishable from a
  failure.
- Each cell: `cell_type ∈ code | markdown | raw`; `source` is **string OR array<string>**
  — **join with `""`** (line fragments already carry their own `\n`); handle both shapes.
  `id` present from nbformat 4.5+ but **may be absent** → fall back to 0-based index.
- Code cells add `outputs[]`. Output types:
  - `stream`: `{ output_type:"stream", name, text }` — `text` is string|array<string>
    (join with `""`); render the stdout/stderr text.
  - `execute_result` / `display_data`: `{ data: { <mime>: value }, ... }`. For **text**
    mimes (`text/plain`, and optionally `text/html`) render the value (string|array,
    join `""`). For **image/binary** mimes (`image/png`, `image/jpeg`, any non-`text/*`)
    render a **placeholder** naming the mime type and approximate size, e.g.
    `<image/png output elided — ~<N> bytes (base64)>` — the raw base64 must NOT appear in
    output. Size is derived from the base64 string length, so label it `(base64)` (or
    divide by 4/3) so the number isn't read as the decoded image size. **Do not build the
    placeholder out of `[...]`** — the ANSI-strip test keys on the ESC byte and must not
    clash with a `[`-delimited placeholder; use `<...>` or another delimiter.
  - `error`: `{ ename, evalue, traceback }` — render `ename: evalue` and the traceback.
    **`traceback` is a list of strings, one line per element with NO trailing newline —
    join it with `"\n"`, NOT `""`** (the blanket `""`-join rule applies to
    `source`/`stream.text`/`text/plain` only; a `""` join here would run traceback lines
    together). Traceback lines often carry ANSI escape codes (real `\x1b`/ESC bytes);
    strip them (don't crash).
- Unknown `cell_type` / `output_type` / malformed cell → represent with a short notice,
  **do not throw** on a per-cell basis (only whole-file structural failures throw).

**Elision / truncation:**
- Binary/image outputs → placeholder as above (never the base64).
- Oversized *text* outputs (stream or text/plain) → truncate via `truncateHead(...)` (the
  SDK helper the other tools use), so both the "large" and "binary" clauses of the
  feature's "elide/truncate large binary outputs" are covered. Note `truncateHead` returns
  `{ content, truncated, outputLines, totalLines }` and does **not** itself emit a visible
  marker — the *caller* appends the "… truncated" marker when `truncated` is true (see
  `web-tools.ts:227-234`).

## Writable surface

- Create `src/runtime/tools/notebook-tools.ts`.
- Create `test/notebook-read.test.ts`.
- Nothing else. (Wiring, registry, and existing-test edits are t02.)

## Approach constraints

- Text-only tool result. No image content blocks.
- Whole-file structural errors throw `Error` (prefixed `NotebookRead:`, naming the path);
  per-cell oddities degrade gracefully in-output.
- `source` / `stream.text` / `text/plain` arrays join with `""`, not `"\n"`. **Exception:
  `error.traceback` joins with `"\n"`** (one line per element, no trailing newlines).

## Left open

- `cell_id` single-cell selection: **omit** for this feature unless it's a trivial
  passthrough you're confident in; parity research judged it optional/not load-bearing.
  If omitted, note it in the log (t02's registry note records the omission).
- Exact human-readable wording of cell headers and the placeholder/truncation markers —
  your call, as long as the test assertions below hold and output is readable.
- Whether to also render `text/html` (in addition to `text/plain`) — your call; if you do,
  pin it with one assertion (below) and consider collapsing any embedded `data:...;base64,`
  URI to a placeholder for consistency with the binary-elision rule.

## Testing

`test/notebook-read.test.ts`, unit layer, using the established harness pattern from
`test/tools-parity.test.ts`: a `run(tool, params)` wrapper calling
`tool.execute("test-call", params, undefined, undefined, CTX)`, and `mkTmpDir` via
`fs.mkdtempSync(path.join(os.tmpdir(), "picc-nb-"))`; clean up in `afterAll` with
`fs.rmSync(dir, { recursive: true, force: true })`. **Generate** the fixture `.ipynb` in
`beforeAll` (JS object → `JSON.stringify` → write to the temp dir) — do **not** commit a
fixture file.

Build ONE rich fixture notebook containing: a markdown cell; a code cell with a `stream`
stdout output; a code cell with an `execute_result` `text/plain` output; a code cell whose
`error` traceback embeds a **real ESC control byte** (`"[31mTraceback[0m"` in
the fixture — the actual `\x1b` byte, NOT the literal ASCII string `"[31m"`, or a strip
keyed on `\x1b` won't engage); a code cell whose `display_data` output is a large
`image/png` base64 blob built as `"A".repeat(N)` for a known large `N`; **a distinct code
cell whose `stream`/`text/plain` text output exceeds `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`**
(so the truncation path fires — the elided image blob does NOT exercise truncation); a code
cell with `outputs: []`; a cell whose `source` is an **array of strings**; and (to prove
the index fallback) a cell with no `id`.

Assertions:
- All cells returned in document order; each has a **header line carrying its 0-based index
  and type**; markdown/raw distinguished from code.
- A multi-line array `source` is reassembled correctly (assert `\n`-normalized content).
- Markdown cell source present, labelled markdown, **no `Outputs:` subheader**.
- `stream` stdout text included verbatim, **under an `Outputs:` subheader**.
- `text/plain` result included.
- `error`: `ename: evalue` + traceback lines surfaced (joined with `\n`); the ANSI escape
  is stripped — assert `expect(text).not.toContain("")` (the ESC byte) AND positively
  assert the `ename`/`evalue` text survived. Do **not** assert on `"["` (it appears
  legitimately in `text/plain` reprs / markdown and would clash with the image placeholder).
- **Image elision (load-bearing):** the base64 blob is ABSENT
  (`expect(text).not.toContain(blob)`) and a placeholder naming `image/png` + an
  approximate `(base64)` size is present.
- **Text truncation (distinct from image elision):** the oversized text cell's output shows
  the truncation marker AND its tail is absent.
- Empty-output code cell renders with no crash and no phantom `Outputs:` section.
- **Index fallback:** the no-`id` cell shows its 0-based document index (a targeted
  assertion, not just the generic "carries its index").
- A valid `cells: []` notebook returns the "0 cells" notice (does not throw, not blank).
- Error paths: nonexistent path throws and the message **names the path**
  (`rejects.toThrow(/NotebookRead:.*<basename>/)`); a file that isn't valid notebook JSON
  throws a clear `NotebookRead:` error (not a raw JSON.parse stack).
- If `text/html` rendering is implemented, pin that branch with one assertion (else leave
  it out entirely — no silent untested branch).

**Cross-platform:** `os.tmpdir()` + `path.join` only (never hardcoded `F:\` or `/tmp`);
assert on `\n`-normalized output (`.replace(/\r\n/g, "\n")`); never assert a literal path
with separators — use the captured tmp var or `path.basename`.

## Acceptance criteria
- [ ] `src/runtime/tools/notebook-tools.ts` exports `createNotebookReadTool(getCwd)` per the seam above.
- [ ] `test/notebook-read.test.ts` covers every assertion listed above and passes.
- [ ] typecheck and full test suite green (nothing removed/rewired yet).

## Depends on
–

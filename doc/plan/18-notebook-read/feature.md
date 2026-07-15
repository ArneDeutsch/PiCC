# F18: NotebookRead — real cell-based notebook reading

Ticket: ArneDeutsch/PiCC#16

## What

Replace the degraded no-op `NotebookRead` with a real tool that reads a Jupyter
notebook (`.ipynb`) and returns it **cell by cell** — each cell's type, source, and
outputs — in a form a model can use, rather than directing the model to `Read` the
raw notebook JSON.

Observable behaviour:

- Calling `NotebookRead` on a `.ipynb` path returns per-cell content: for each cell,
  its index, type (code / markdown / raw), the source, and — for code cells — its
  outputs (stream text, `text/plain` results, error tracebacks).
- Large or binary outputs are **elided or truncated** rather than dumped into context:
  raster images (`image/png`/`jpeg`/…) are noted by mime-type with an approximate
  (base64-length) size; other binary/structured outputs (SVG, `application/json`) are
  noted by mime-type only; oversized text outputs are head-truncated to a marker.
- The registry entry `tool.NotebookRead` moves from `degraded-noop` to `partial`; the
  capability matrix is regenerated and drift guards stay green. (Tier is `partial`, not
  the `full` originally worded in #16, for two reasons: image outputs are noted rather
  than rendered visually, and single-cell selection (`cell_id`) is not supported —
  decided with the user; see the Note under Tasks.)

Non-goals:

- **`NotebookEdit`** (cell insert / replace / delete, execution-count handling)
  stays a degraded no-op — a separate, larger follow-up.
- No notebook writing or execution of any kind.
- No image passthrough: binary/image outputs are represented as elided placeholders,
  never rendered or handed to the model as image data. This is a **permanent design
  choice** — PiCC targets text-oriented GPT/Codex models — not a deferred capability.

## Why

In Claude Code, `NotebookRead` presents a notebook cell by cell so the model sees
usable structure instead of noisy raw JSON (base64 image blobs, metadata, execution
counts). PiCC's north star is running Claude-format projects unchanged; today a
project that touches `.ipynb` hits a degraded stub that wastes context on output
cruft and makes edits error-prone. This closes that parity gap for the self-contained,
easy half (reading), leaving the harder editing half for a follow-up.

## Acceptance

- Reading a `.ipynb` returns per-cell source and outputs, with large binary outputs
  elided/truncated.
- The registry moves `tool.NotebookRead` from `degraded-noop` to `partial`; the matrix is
  regenerated; drift guards are green.
- Tests cover a fixture notebook with code + markdown cells and at least one
  large/binary output.
- `NotebookRead` is removed from the degraded-tool set and registered as a real tool
  wired into the same known-tool path the other real tools use.

## Tasks

- t01 — NotebookRead parser/renderer module + unit tests (depends on: –)
- t02 — Wire NotebookRead into the runtime, retier the registry to `partial`, update drift guards (depends on: t01)
- t03 — Docs & CHANGELOG for the real NotebookRead tool (depends on: t02)

Note: the registry tier is **`partial`** (not the `full` written in #16's acceptance) —
decided with the user because image outputs are noted, not rendered visually. The
substantive ask (real cell-based reading) is fully delivered.

# F18 Review: NotebookRead — real cell-based notebook reading

## Outcome

Shipped a real `NotebookRead` tool (`src/runtime/tools/notebook-tools.ts`) that parses an
nbformat v4 `.ipynb` and renders it cell by cell — per-cell header (index + type + id),
source, and for code cells an `Outputs:` block (stream text, `text/plain` and other text
reprs, error `ename: evalue` + ANSI-stripped traceback). Image/binary outputs are elided to
a truthful placeholder (raster images sized from base64 length; SVG/JSON noted by mime-type
only) and the raw base64 provably never reaches the model — including `data:…;base64,…` URIs
embedded in `text/html`. Oversized text is head-truncated; a 25 MB pre-read cap and broad
JSON.parse guard keep a hostile/huge notebook from crashing the process. The tool is wired
into `buildCwdBoundTools` + `allKnownToolNames`, routes path-scoped permission rules via a
new `matchesRule` case, and the registry entry moved `degraded-noop → partial` with a
truthful note; matrix regenerated, all drift guards green. Verified end to end with a live
`tsx` smoke on a real notebook (correct rendering, no raw ESC, no base64, clean path-named
errors), plus 19 unit tests, a subagent-dispatch wiring test, and a permission path-rule
test.

**Deviation from plan / ticket:** #16's acceptance said tier `full`; shipped `partial` —
decided with the user because images are noted, not rendered (PiCC targets text models), and
`cell_id` selection is unsupported. The substantive ask (real cell-based reading) is fully
delivered. Everything else tracked the plan; no scope was cut silently.

## Planning errors & spec gaps

- The Phase-4 parity investigation initially recommended "delegate to Pi's built-in `Read`
  notebook renderer" — **wrong**: Pi's SDK has no `.ipynb` handling; the notebook-rendering
  `Read` the agent saw was the *Claude Code* harness it was running inside, not PiCC's
  runtime. Caught by reading the SDK directly. Lesson: a claim about "what the harness
  already does" must be verified against the actual dependency, not the ambient environment.
- The initial plan's `allKnownToolNames` "positive test" routed through the registry
  (`lookupCapability`), not `gateTools` — it would have passed whether or not the wiring
  literal existed. Two reviewers caught it independently; replaced with a real
  subagent-dispatch test. Lesson: an assertion that still passes under the exact bug it
  names is not coverage.
- The security-critical `matchesRule` permission case was missing from the first plan draft
  (the tool would have shipped with silently-ineffective path denies). Plan review caught it
  before implementation.

## Friction

- Windows + raw ESC bytes: hand-authoring notebook fixtures/smoke scripts with literal ANSI
  ESC bytes repeatedly tripped the shell control-character guard and produced invalid JSON.
  Resolution: generate fixtures via a JSON serializer (`json.dumps` / `JSON.stringify`) so
  ESC is stored escaped, as real Jupyter does.
- The hard "never emit base64" guarantee had a non-obvious third carrier (base64 inside
  `text/html`) beyond the obvious `image/*` output type; the first implementation covered
  only the obvious path and the test gave false confidence. A hard "never X" invariant needs
  a test on every path X can travel.

## Bugs discovered

- None pre-existing in shipped code. One **pre-existing parity divergence** surfaced (not
  introduced here): PiCC has no Read-family permission expansion, so a `deny: Read(secrets/**)`
  does not cover Grep/Glob — and now not NotebookRead either. Consistent with existing
  Grep/Glob behaviour; see follow-ups.

## Improvement opportunities

- Untested defensive branches in the parser: `not-a-file` (directory path), EACCES, the
  25 MB cap, and the byte-cap (vs line-cap) truncation path. All simple guard clauses, low
  risk; cheap to pin later.
- `errorMessage` is now a fourth local copy of the same 2-line helper (web-tools, worktrees,
  notebook-tools); a shared `src/util/` extraction would be a codebase-wide refactor, out of
  scope here but worth noting the pattern is spreading.

## Proposed follow-ups

1. **`Read` on a `.ipynb` still returns raw JSON.** In Claude Code 2.1.x notebook reading
   lives in `Read` itself; PiCC's inherited `Read` has no notebook path, so a project calling
   `Read` (not `NotebookRead`) on a notebook still gets the noisy JSON this feature exists to
   avoid. Natural next parity ticket.
2. **`NotebookEdit` real implementation.** The harder companion (cell insert/replace/delete,
   execution-count handling), explicit non-goal here; now that a real read exists, the
   documented "read before edit" dependency is satisfiable.
3. **Read-family permission deny expansion** (Grep/Glob/NotebookRead under a `Read(glob)`
   deny), if verified that live Claude intends `Read()` to cover read surfaces.
4. **`examples/full-surface` notebook + e2e scenario.** Add a small committed `.ipynb` and a
   NotebookRead scenario so the executable supported-surface exercises the new tool (mind the
   committed-fixture line-ending risk — force LF).

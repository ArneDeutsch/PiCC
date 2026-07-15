# F18 observations

Raw running record (friction / bugs / opportunities). Distilled into `review.md` at close.

## 2026-07-15 — Phase 4 investigation

- Parity agent's initial recommendation to "delegate to Pi's built-in `Read` notebook
  renderer" was **refuted by the code**: the Pi SDK dist has zero `.ipynb` handling. The
  notebook-rendering `Read` it saw is *this* Claude Code harness, not PiCC's runtime.
  Lesson: a claim about "what the harness Read already does" must be checked against the
  Pi SDK, not the environment the agent is running in.
- Ticket #16 says acceptance = tier `full`; parity truthfulness says placeholder-images →
  `partial`. Escalated to user → chose **`partial`** with an honest note. Deviation from
  the ticket's literal wording, coherent with the substantive ask (real cell reading). To
  reflect in the Phase 8 close-vs-keep-open judgement.

## 2026-07-15 — Phase 6 plan review

- **Security (MUST-FIX):** `matchesRule` permission switch (`src/engine/permissions.ts`
  ~:556-583) had no `NotebookRead` case → a path-scoped `NotebookRead(<glob>)` deny would
  silently never fire once the tool became a real reader. Folded into t02.
- **Tester + generalist (converging MUST-FIX):** the originally-planned "known-tool"
  positive test routed through the registry/`lookupCapability`, not `gateTools`, so it
  would pass whether or not the `allKnownToolNames` literal was added — leaving the one
  genuinely new wiring risk untested. Replaced with a subagent-dispatch test mirroring
  `slashcommand-fork.test.ts`. Process note: a "positive assertion" is worthless if it
  doesn't exercise the seam it claims to guard — reviewers caught this independently.
- **Parity (fidelity fix):** `error.traceback` must join with `"\n"`, not the blanket
  `""` rule (one line per element, no trailing newlines). Carved out in t01.
- **UX:** tool `description` is the ONLY lever steering the model to prefer NotebookRead
  over Read for `.ipynb` (Pi's Read doesn't special-case notebooks); errors must name the
  path; per-cell headers + `Outputs:` subheader needed for unambiguous attribution.
- **ANSI-strip assertion collision** (tester + generalist): the `not.toContain("[")`
  assertion clashed with a `[...]` image placeholder in the same output string. Fixed:
  key the assertion on the ESC byte; use a non-`[` placeholder delimiter.

## 2026-07-15 — Phase 7 t01 (parser) review

- t01 implementer delivered clean per spec (16 tests). Review fan-out (coder/tester/parity)
  surfaced fixes, all folded in via one fix pass (→ 19 tests):
  - **text/html base64 leak (coder + parity, converging, sharpest):** embedded
    `data:...;base64,...` in an HTML output bypassed image elision — violating the hard
    "never emit base64" non-goal. Fixed: prefer `text/plain` over `text/html` when both
    present, and collapse `data:*;base64,*` URIs in all rendered text. Lesson: a hard
    guarantee ("never X") needs a test on *every* path X can travel, not just the obvious
    one; the image-`output_type` test alone gave false confidence.
  - **ANSI stripped only in tracebacks (coder + parity):** colored stdout leaked raw ESC.
    Fixed — strip uniformly in `renderText`.
  - **Placeholder mislabeled non-raster mimes (parity):** `application/json` object →
    `~0 bytes (base64)`. Fixed — truthful per-mime descriptors.
  - **Trivially-passing test + untested degrade contract (tester):** traceback `\n`-join
    assertion couldn't catch the `""`-join bug it guarded; per-cell graceful-degradation
    (unknown output_type / null cell) had no test. Both added. Lesson: an assertion that
    still passes under the exact bug it names is not coverage.

## 2026-07-15 — Phase 7 t02 (wire-in + retier) review

- t02 delivered clean; review fan-out (coder/security/tester/parity) all PASS.
- Security confirmed the new `matchesRule` `NotebookRead` case routes to
  `pathSpecifierMatches` with the read-only boundary intact and no subagent escalation;
  the positive+negative permission test genuinely guards it. Tester confirmed the
  dispatch-wiring test actually fails if the `allKnownToolNames` literal is removed (the
  one real wiring risk is now covered).
- Parity NIT folded in: registry note said "image outputs are noted by mime-type +
  approximate size" but `image/svg+xml` is elided size-free → tightened to "image/binary
  outputs … (raster images with an approximate base64 size)"; matrix regenerated.

## Deferred / out-of-scope opportunities (candidate follow-ups)

- **No Read-family permission expansion (security, pre-existing).** Claude best-effort
  applies a `Read(glob)` deny across read surfaces (Grep/Glob/@file). PiCC has no such
  expansion — a `deny: Read(secrets/**)` covers only the `Read` tool, not Grep/Glob, and
  now not NotebookRead either. Consistent with existing Grep/Glob behaviour, NOT a bug
  introduced here, but making NotebookRead a real reader slightly widens the gap. Candidate
  follow-up: implement a Read-family deny expansion (Grep/Glob/NotebookRead) — verify
  against live Claude first whether `Read()` deny is meant to cover them.

- **`Read` on a `.ipynb` still dumps raw JSON.** In Claude Code 2.1.x notebook reading
  lives in `Read` itself; PiCC's inherited `Read` has no notebook path. A project that
  calls `Read` (not `NotebookRead`) on a notebook still gets raw JSON — a separate parity
  gap, untouched by F18. Candidate follow-up ticket.
- **`examples/full-surface` has no `.ipynb`.** Parity suggested the executable
  supported-surface example gain a small notebook. Deferred to avoid a committed
  line-ending-sensitive fixture blob; the generated unit fixture fully covers behaviour.
  Candidate polish follow-up.
- **`NotebookEdit`** remains a degraded no-op (explicit non-goal); the harder companion.
  Now that a real read exists, the "read before edit" dependency it documents is
  satisfiable — the natural next ticket.

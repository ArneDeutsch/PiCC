# t03: Registry + docs truthfulness for the new default

## Goal

Every stated capability and doc surface tells the truth about background-by-default:
the capability registry no longer claims PiCC defaults foreground, the generated
matrix is regenerated and diff-clean, README / user-guide / architecture / CHANGELOG /
the design doc convey the inverted default, and the registry-wording assertion tests
assert the *new* semantics. The full suite (including the matrix-freshness guard) is
green.

## Context & seams

The registry is the source of truth; `doc/supported-features.md` is **generated** from
it (`npm run gen:capabilities` → `scripts/gen-capability-matrix.mjs`) and must never be
hand-edited. `test/registry.test.ts:403-415` regenerates in-process and diffs against
the committed file, so any registry edit **requires** regenerating the doc.

Edits in `src/registry/capability-registry.ts` (verify current line numbers):

- **`tool.Agent` (~49) and `tool.Task` (~50)** — currently tier `partial`, reason
  "PiCC defaults FOREGROUND … runs serially". **Keep tier `partial`** but replace the
  reason: dispatch now runs **background-by-default** (returns a task id, implicit
  fan-out parallelizes); `run_in_background: false` selects a synchronous inline run;
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` forces foreground. The **residual** gap that
  keeps `partial`: PiCC pushes the settlement notice to an idle parent **next turn**,
  whereas Claude notifies **mid-turn** (this timing gap is real and web-verified).
  You may also note PiCC fires no `agent_completed`-style Notification for in-session
  settlement — but label that residual **inferred** (no Claude doc confirms such a
  hook by name; it is a conservative under-claim, safe to state as inferred, not as an
  asserted Claude behaviour). `tool.Task` mirrors `tool.Agent` (alias).
- **`feature.background-agents` (~232)** — remove the lead GAP "PiCC defaults foreground
  unlike Claude 2.1.198" (now closed). Keep the other gaps (TaskStop task_id-only,
  stopped-agent resume, idle-parent next-turn delivery, no always-on Agent View, no
  remote/cloud, cooperative stop).
- **`agent.frontmatter.background` (~191)** — reword from "dispatches … without
  run_in_background" to: **forces** background even against an explicit
  `run_in_background: false` (its remaining significance once background is default).

Then run `npm run gen:capabilities` and commit the regenerated
`doc/supported-features.md`.

Prose docs to correct (docs investigation gave file:line; re-verify before editing):

- **`README.md`** (~57-61) — "Dispatch defaults to the **foreground** … runs serially
  unless background is requested" → background-by-default; implicit fan-out
  parallelizes; `run_in_background: false` for a synchronous result.
- **`doc/user-guide.md`** — dispatch bullet (~168-170); the "Partial" section
  (~339-343: strike the "defaults foreground / runs serially" clause, keep the other
  background-agent limits); the env-table row (~299: `CLAUDE_CODE_DISABLE_BACKGROUND
  _TASKS` now forces **every** `Agent`/`Task` dispatch foreground, not only explicit
  ones — and note `SendMessage` resume is inherently async and not governed by it, the
  documented exception).
- **`doc/architecture.md`** — the "default direction diverges … single most
  consequential subagent parity gap" paragraph (~262-265): rewrite to state the gap is
  now **closed** (background-by-default; `false` opts into foreground; env forces
  foreground). Reframe the background-tasks data-flow bullets (~126-129, ~214-215) away
  from "run_in_background: true registers…". **Add** a paragraph documenting the nested
  bound (t02): nested (depth ≥ 2) background dispatches are concurrency-bounded via
  per-depth budgets (deadlock-free; total ≤ `maxDepth × concurrency`), a conservative
  PiCC safety choice that diverges from Claude's single global ~10 cap — stated as
  such, not as parity.
- **`doc/design/pi-integration.md` (~77-78)** — currently "background degrades to
  foreground in v1, noted in result", a **living** design doc asserting the opposite of
  the new behaviour. Either correct it to background-by-default, or, if you judge
  `doc/design/**` to be point-in-time, add an explicit dated note that it is superseded
  and record that rationale. (It is NOT in the historical carve-out below, so it must
  be handled, not silently left stale.)
- **`CHANGELOG.md`** — add a `### Changed — background-by-default subagent dispatch
  (2026-07-14)` entry under `[Unreleased]` (match the file's dated-subsection format,
  including the trailing `(YYYY-MM-DD)`): the default flip, implicit fan-out
  parallelizes, `run_in_background: false` for synchronous, env still forces foreground,
  nested background now per-depth bounded, registry retiered notes + regenerated matrix.

Assertion tests to update — **assert the new semantics, do not merely keep old
substrings green** (post-flip the note legitimately still contains the word
"foreground" — a lazy `.toContain("foreground")` would pass while the meaning is
inverted):

- **`test/registry.test.ts` (~195-208)** — update the `tool.Agent` assertion to check
  the new reason (background-by-default; residual = settlement-timing gap), and
  **rewrite the stale prose comment at ~195-197** ("PiCC defaults FOREGROUND …") which
  sits just above the assertion. Keep tier `partial`.
- **`test/registry.test.ts` (~297)** — remove the expectation that
  `feature.background-agents` lists the "PiCC defaults foreground" gap.

**Do not** rewrite historical/point-in-time records (`doc/plan/**`, `doc/research/**`,
prior `review.md`) — dated artifacts, not living docs.

## Writable surface

- `src/registry/capability-registry.ts`
- `doc/supported-features.md` (via `npm run gen:capabilities` — do not hand-edit)
- `README.md`, `doc/user-guide.md`, `doc/architecture.md`,
  `doc/design/pi-integration.md`, `CHANGELOG.md`
- `test/registry.test.ts`
- `doc/plan/15-background-by-default/log/t03.md`

## Approach constraints

- Registry stays truthful: keep the residual notification-timing gap named; label the
  `agent_completed`-hook residual and the env-over-frontmatter precedence as inferred,
  not documented Claude semantics; do not claim full parity.
- Regenerate the matrix; never hand-edit `doc/supported-features.md`.
- Assertions test meaning, not surviving substrings.
- Do not alter runtime behaviour or the t01/t02 tests (docs + registry wording only).

## Left open

- Exact prose in each note/doc, within the truthfulness constraints.
- Whether to correct vs supersede-note `doc/design/pi-integration.md` (record which
  and why).

## Testing

- `npm run gen:capabilities` produces **no** git diff after the commit (freshness
  guard `registry.test.ts:403-415` green).
- Updated `registry.test.ts` wording assertions green and non-vacuous (assert the new
  reason).
- Full suite green.

## Acceptance criteria
- [ ] `tool.Agent`/`tool.Task`/`feature.background-agents`/
      `agent.frontmatter.background` registry notes truthful about background-by-
      default; residual timing gap still named; inferred residuals labelled.
- [ ] `doc/supported-features.md` regenerated, diff-clean.
- [ ] README, user-guide, architecture (incl. nested-bound divergence), design doc,
      CHANGELOG corrected; no stale "defaults foreground" claim in any living doc.
- [ ] Wording-assertion tests assert new semantics; matrix-freshness guard green.
- [ ] typecheck and full test suite green.

## Depends on
t01, t02

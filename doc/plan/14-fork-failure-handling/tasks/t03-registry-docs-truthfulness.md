# t03: Make the registry, generated docs, architecture notes, and CHANGELOG truthful about fork failure/abort handling

## Goal

The capability registry and everything generated from or describing the fork behaviour
accurately reflect what shipped — failure preserves partial output and names the cause; Esc
reports aborted **only from the model-invoked Skill-tool caller**, while a typed top-level
`/forked-skill` expansion is **not** Esc-cancellable due to a **PiCC/Pi harness limitation**
(Pi exposes no abort signal at the input-hook stage). No over-claim, no under-claim.

## Context & seams

- `src/registry/capability-registry.ts:174` — the `skill.frontmatter.context` entry,
  currently `"context: fork runs the skill as a fresh-context subagent (§4.1)"` (a
  description string in the frontmatter map), with **no** failure/abort caveat. Today that
  is a mild over-claim by omission: `tool.Agent` (`:49`) / `tool.Task` (`:50`) advertise the
  "terminal API error is a LOUD failure … partial output preserved" mapping while the fork
  path did the opposite. After t02 the fork path matches — add a note that:
  - fork failure preserves partial output and names the cause (parity with the Agent tool);
  - Esc reports aborted **for a model-invoked `context: fork` (the Skill-tool path)**;
  - a **typed top-level `/forked-skill`** expansion is **not** Esc-cancellable — attribute
    this to a **PiCC/Pi harness limitation** (no abort signal at the input-hook stage), NOT
    to Claude Code scoping Esc. Do **not** write an unqualified "Esc → aborted".
  - (optional, since you are editing the line) a half-clause that `context: fork` dispatches
    are non-resumable, removing the last omission-by-silence.
- **Wording discipline:** frame the Esc gap as *our harness's* limitation, and keep the
  claim scoped to what t02 actually verified (the model-invoked route); do not assert Esc
  works for the nested from-subagent route, whose *delivery* Pi controls and t02 did not
  prove (see t02's scope note).
- `doc/supported-features.md:153` — generated from the registry. Regenerate; do not
  hand-edit.
- `doc/architecture.md:242-265` — the section "Subagent error contract (F02 — the failure
  class this feature closes)". It currently describes the outcome contract (completed/failed/
  aborted, partial preservation, cut-off frame) in **Agent-tool** terms only. Update it to
  record that (a) the `context: fork` path was the last divergence and now conforms, and (b)
  t01 introduced a shared exported `presentDispatchResult` helper that unifies the Agent tool
  and both fork consumers onto one source of truth. Keep the scoped-Esc caveat consistent
  with the registry note.
- `doc/user-guide.md:192-194` — a **generic** statement that "Pressing Esc cancels a running
  foreground dispatch (it reports as aborted…)". A typed `/forked-skill` IS a synchronous
  foreground dispatch yet is not Esc-cancellable. Verify this line is not read as covering
  typed forked-slash (it is contextually about the Agent-tool live-progress view); if it
  could mislead, add a one-clause scope note. Record the outcome of this check either way.
- Version accuracy: the upstream partial-output/loud-failure fix is Claude **2.1.199** (not
  only 2.1.200). If the new note cites a version, cite 2.1.199. Do not rewrite unrelated
  existing "2.1.200" phrasing elsewhere — out of scope.
- `CHANGELOG.md` — add an entry under **### Fixed** (this is a silent-loss/crash bugfix; the
  `[Unreleased]` style is at `CHANGELOG.md:9`), matching the repo's existing style.

## Writable surface

- `src/registry/capability-registry.ts`
- `doc/supported-features.md` (only via the generator)
- `doc/architecture.md`
- `doc/user-guide.md` (only if the :192 check finds an over-claim needing a scope clause)
- `CHANGELOG.md`

## Approach constraints

- Regenerate the matrix with `npm run gen:capabilities`; the working tree must be clean
  afterwards. The un-fakeable guard is the in-process matrix-freshness test at
  `test/registry.test.ts:403-414` (it regenerates via `renderCapabilityMatrix` and diffs
  with CRLF normalization) — cite/rely on it rather than a raw `git diff` (which is
  CRLF-fragile on Windows).
- Keep the Esc claim **scoped** and framed as a harness limitation. Truthfulness over
  tidiness. (No test machine-checks the *wording* — this is human-review-only; get the
  scoping right.)

## Left open

- Exact wording of the registry note, architecture.md update, and CHANGELOG entry.
- Whether `doc/user-guide.md:192` needs a scope clause (decide from the check).

## Testing

- `npm run gen:capabilities`, then the full suite (which includes the matrix-freshness guard
  at `test/registry.test.ts:403`) green — no drift.
- typecheck green.

## Acceptance criteria

- [ ] Registry entry describes fork failure = partial preserved + cause named; Esc-aborted
      scoped to the model-invoked Skill-tool caller; the typed `/forked-skill` non-cancel
      framed as a PiCC/Pi harness limitation; no unqualified Esc claim.
- [ ] `doc/supported-features.md` regenerated, no drift (matrix-freshness test green).
- [ ] `doc/architecture.md` F02 error-contract section notes fork-path conformance + the
      shared `presentDispatchResult` helper.
- [ ] `doc/user-guide.md:192` checked; scoped if it would over-claim (outcome recorded).
- [ ] CHANGELOG has an F14 entry under **Fixed**.
- [ ] typecheck and full test suite green.

## Depends on

t02

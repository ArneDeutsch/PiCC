# t03: Docs & CHANGELOG for the real NotebookRead tool

## Goal

The repo's human-facing records reflect that `NotebookRead` is now a real `partial` tool:
a CHANGELOG entry, the architecture tool-inventory, and the user-guide tier prose. No code
or test changes. Suite stays green (docs only).

## Context & seams

Describes behaviour shipped in t01/t02: `NotebookRead` reads a `.ipynb` cell by cell
(source + stream/text/plain/error outputs), with image and oversized outputs noted rather
than rendered; registry tier `partial`.

**CHANGELOG.md:** add a new self-contained dated heading block at the **top** of the
`## [Unreleased]` section (newest-first), matching the existing per-feature pattern
(`### Added — <title> (YYYY-MM-DD)` / `### Changed — <title> (YYYY-MM-DD)`). Use category
**Added** and today's date (2026-07-15). Self-contained heading block — this is the repo's
mitigation for CHANGELOG serial-merge conflicts across parallel feature branches; do not
append into another feature's bullet list. Mention it closes the reading half of the
notebook parity gap and that `NotebookEdit` remains a separate follow-up.

**doc/architecture.md (~:156-159):** the list of real tool modules under
`src/runtime/tools/` (`web-tools.ts`, `search-tools.ts`, `task-tools.ts`,
`worktree-tools.ts`, `degrade-stubs.ts`) should gain `notebook-tools.ts` (the new real
NotebookRead module), and the surrounding text must no longer imply `NotebookRead` is a
degrade stub. Verify the exact current wording before editing.

**doc/user-guide.md (~:333-363):** the tier prose enumerates the tool surface. Add
NotebookRead to the appropriate tier description — it is `partial` (notebook reading with
image outputs noted, not rendered visually), so place it with the other partial/limited
tools rather than the "Full" list. Keep the phrasing consistent with the surrounding
prose. This is polish (the generated `doc/supported-features.md` table is authoritative and
already updated in t02), but keeps the narrative docs complete.

**Do NOT** hand-edit `doc/supported-features.md` (regenerated in t02).

## Writable surface

- `CHANGELOG.md`
- `doc/architecture.md`
- `doc/user-guide.md`

## Approach constraints

- Docs only — no code, no tests, no regeneration.
- Match existing formatting conventions in each file (verify current wording first).

## Left open

- Exact wording of each entry — your call, consistent with surrounding style.

## Testing

No new tests. Confirm typecheck + full suite still green (should be unaffected by docs).

## Acceptance criteria
- [ ] CHANGELOG has a new `### Added — …NotebookRead… (2026-07-15)` block at the top of `[Unreleased]`.
- [ ] `doc/architecture.md` lists `notebook-tools.ts` and no longer implies NotebookRead is a stub.
- [ ] `doc/user-guide.md` mentions NotebookRead at the correct (`partial`) tier.
- [ ] typecheck and full test suite green.

## Depends on
t02

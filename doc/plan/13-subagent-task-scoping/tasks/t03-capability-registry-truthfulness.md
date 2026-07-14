# t03: Capability registry truthfulness + CHANGELOG

## Goal
The capability registry and its generated matrix state the corrected, scoped
behavior honestly, and the CHANGELOG records the fix. The false "shared registry,
any session task reachable" / "Claude hides TaskOutput from subagents (a
project-intended restriction PiCC does not enforce)" text is gone.

## Context & seams

Source of truth: `src/registry/capability-registry.ts`. The generated
`doc/supported-features.md` is produced by `npm run gen:capabilities`
(`scripts/gen-capability-matrix.mjs` → `doc/supported-features.md`) and must be
regenerated so it does not drift (a drift/consistency test may assert the
generated file matches the registry — run the suite to confirm).

Verified parity facts (Phase-4 claude-parity, cite in wording as needed): Claude
Code's sub-agents "Available tools" doc withholds only `AskUserQuestion`,
`EnterPlanMode`, `ExitPlanMode`, `ScheduleWakeup`, `WaitForMcpServers` from
subagents — `TaskOutput`/`TaskStop` are **inherited**. The "TaskOutput hidden
from subagents" behavior is a filed Claude bug (#15098, #23154), not its
contract. Claude's subagent isolation is via fresh context (a subagent never
learns foreign `task_id`s), not an active dispatcher guard — so picc's explicit
per-dispatcher guard is a faithful hardening, *stricter* than Claude only for the
#15098 pattern (a coordinator deliberately handing a subagent another task's id).

Edits (wording is a guide — keep it accurate, do not fabricate beyond the
verified facts above):

- **`tool.TaskOutput` (~:76).** Keep status `full`. Remove the trailing clause
  beginning *"the background-task registry is session-wide, so a subagent granted
  TaskOutput can reach ANY session task … whereas Claude Code hides TaskOutput
  from subagents entirely (a project-intended restriction PiCC does not
  enforce…)"*. Replace with: subagents inherit `TaskOutput` (only the five named
  tools are withheld); a subagent's `TaskOutput` reaches **only tasks it
  dispatched**; the coordinator reaches every session task; a foreign/unknown
  `task_id` is refused cleanly without leaking existence/label/status/output; and
  the honest hardening note (per-dispatcher guard is stricter than Claude only on
  the #15098 coordinator-passed-id edge case — **not** a blanket "non-divergent"
  claim).

- **`tool.TaskStop` (~:77).** Keep status `partial` (the task_id-only-vs-agent-
  id/name partial stays — it is an F13 non-goal). Add: a subagent's `TaskStop`
  reaches only tasks it dispatched; the coordinator can stop any session task; a
  foreign/unknown `task_id` is refused cleanly and non-leakingly; subagents
  inherit `TaskStop` per Claude's "Available tools" list. **Carry the same honest
  #15098 hardening note as `tool.TaskOutput`** — `TaskStop` is scoped by the
  identical per-dispatcher guard and is equally stricter than Claude only on the
  #15098 coordinator-passed-id edge; do not present its scoping as pure
  undivergent parity (append the note, or an explicit "see `tool.TaskOutput`").
  Remove nothing false (there is no session-wide claim here today).

- **`feature.background-agents` (~:232).** No false claim to remove. Optionally add
  one truthful clause: subagent `TaskOutput`/`TaskStop` are scoped to the
  subagent's own dispatched tasks; the coordinator retains full session-wide
  reach — with a "(see `tool.TaskOutput` for the #15098 hardening note)" cross-ref
  if the clause is added. Do **not** add any "Claude hides TaskOutput" language.

- **`test/registry.test.ts` asserts the exact strings being removed (MUST).** The
  drift/content test at `test/registry.test.ts:231-245` positively requires the
  now-false wording: `expect(out?.note).toContain("session-wide")` (`:237`) and
  `expect(out?.note).toContain("hides TaskOutput from subagents")` (`:238`), with
  a matching comment at `:235-236`. Deleting that text from
  `capability-registry.ts:76` turns this test red. Re-point `:237-238` at the
  corrected wording (e.g. assert the note now contains "only tasks it dispatched"
  / the honest scoped-hardening phrasing and does **not** contain "hides
  TaskOutput from subagents"), and rewrite the `:235-236` comment accordingly. The
  `tool.TaskStop` assertions at `:239-245` target strings t03 keeps (task_id-only
  partial), so leave them; if you add the #15098 note to `TaskStop`, optionally
  add a positive assertion for it. The generated-matrix sync test (~`:404`) is
  handled by the `gen:capabilities` regeneration below.

- **`doc/architecture.md` (SHOULD).** The `background-tasks.ts` description
  (~`:125-130`) does not become false, but this is an isolation-contract change at
  the altitude architecture.md documents (cf. its "Subagent error contract (F02)"
  note ~`:242`). Add one line: subagent `TaskOutput`/`TaskStop` are scoped to the
  dispatcher's own tasks; the coordinator retains full session-wide reach.

- **CHANGELOG.md** `## [Unreleased]` → a `### Fixed` (or `### Changed`) entry,
  dated, describing: subagent `TaskOutput`/`TaskStop` are now scoped to the
  dispatcher's own tasks (siblings' and the coordinator's tasks are unreachable,
  refused cleanly and non-leakingly); the capability registry's inverted parity
  note is corrected. User-facing, concise, no absolute paths.

## Writable surface
- `src/registry/capability-registry.ts`
- `doc/supported-features.md` (regenerated — do not hand-edit)
- `test/registry.test.ts` (re-point the `:237-238` assertions + `:235-236` comment)
- `doc/architecture.md` (one-line scoping note)
- `CHANGELOG.md`

## Approach constraints
- Regenerate `doc/supported-features.md` via `npm run gen:capabilities`; never
  hand-edit it.
- Every wording change must be true against the verified parity facts above and
  the behavior t01/t02 actually shipped — no aspirational claims.
- Do not weaken the existing truthful `TaskStop` partial (task_id-only).

## Left open
- Exact prose, within the accuracy constraints.
- `### Fixed` vs `### Changed` heading for the CHANGELOG entry.

## Testing
- `test/registry.test.ts:237-238` re-pointed at the corrected wording (+ comment
  at `:235-236` rewritten); the content assertion passes against the new note.
- `npm run gen:capabilities` leaves no diff beyond the intended registry changes,
  and the registry/matrix sync test (~`:404`) passes.
- No new behavior tests here (behavior is covered by t01/t02).

## Acceptance criteria
- [ ] `tool.TaskOutput` / `tool.TaskStop` / `feature.background-agents` wording
      corrected per above; false hiding/session-wide text removed; honest #15098
      hardening note present on **both** `tool.TaskOutput` and `tool.TaskStop` (no
      blanket "non-divergent" claim).
- [ ] `test/registry.test.ts` assertions/comment re-pointed and passing.
- [ ] `doc/architecture.md` one-line scoping note added.
- [ ] `doc/supported-features.md` regenerated and in sync.
- [ ] CHANGELOG `[Unreleased]` entry added.
- [ ] typecheck and full test suite green (incl. the registry-matrix sync test).

## Depends on
t02

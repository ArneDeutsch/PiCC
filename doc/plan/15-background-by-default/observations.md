# F15 Observations

Running record of friction, planning errors, bugs, and opportunities — raw material
for `review.md`. Dated bullets, one line each.

## t01 — core flip

- 2026-07-14 (planning error, minor): t01's writable surface under-enumerated the test
  sweep. Two files outside it (`test/builtin-agents.test.ts`,
  `test/slashcommand-fork.test.ts`) boot the whole extension with a real background
  registry and inspect the synchronously-created session / a foreground `outcome`, so
  the flip forced them foreground; the implementer added intent-preserving
  `run_in_background: false` pins. The Phase-6 adversarial reviewer had called
  "no out-of-surface breakage" a "lucky invariant, not designed" — correct instinct;
  it was not fully lucky. Lesson: a default-routing flip's test blast radius includes
  every test that boots the extension with a registry wired, not just the enumerated
  routing tests.
- 2026-07-14 (finding, recorded assumption): grep of `src/` found no TypeBox param
  coercion (`Value.Cast/Convert/Decode`, `TypeCompiler`, `coerce`), so a non-boolean
  `run_in_background` reaches the handler unchanged; `!== false` fails toward the new
  default (background). Acceptable and recorded; revisit if Pi ever coerces.
- 2026-07-14 (test-quality, caught in review): a sanitization assertion was vacuous —
  `expect(JSON.stringify(out)).not.toContain(ESC)` can never fail because
  `JSON.stringify` escapes U+001B to ``. Replaced with a real default-path
  failed-task assertion on `content[0].text`. False-green pattern worth the tester
  lens watching for generally.
- 2026-07-14 (UX, Option-A residual): the dispatch-but-never-collect risk is mitigated
  by guidance only (tool/param descriptions, the every-turn `HARNESS_CONVENTIONS` line,
  the `TaskOutput` strings) — reworded to name the trap, the timing ("before you rely
  on it or finalize"), and the consequence ("otherwise its result is lost"). Residual
  cliff remains: same-turn premature finalize, and total result loss in `-p`/print mode
  (no next turn). This is the Option-B/C follow-up we deferred.

## Pre-existing issues found along the way (out of F15 scope — follow-up candidates)

- 2026-07-14 (security): `unknownIdError` (`src/runtime/background-tasks.ts` ~566-570)
  echoes the raw model-supplied `${id}` into a terminal-bound error without
  `sanitizeLine`, inconsistent with the `sanitizeLine` discipline a few lines below in
  `TaskOutput`. Low-value target (the model's own task_id); worth a hardening pass.
- 2026-07-14 (security/tester): `src/runtime/subagents.ts` ~1491 stores an only
  `.trim()`ed `label` (raw `subagent_type`) as the task's `agentType`, surfacing raw in
  `TaskOutput` `details.agent`. Benign today (renderer/notice sanitize at display), but
  the F15 flip makes this the common path — candidate for sanitizing at store time.

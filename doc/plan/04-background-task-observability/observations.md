# F04 Observations

Running record of friction, planning errors, bugs found, and opportunities. Dated bullets; raw
material for review.md.

- 2026-07-13 t01: clean pure move, no friction. Spec's optional `renderProgressText` re-export was
  correctly omitted (unused by moved code; would trip `noUnusedLocals`) — the "Left open" framing paid
  off. coder review PASS, behavior byte-for-byte identical, baseline green.
- 2026-07-13 t02: spec self-tension — "keep subagent-transcripts start-message assertions green" vs.
  the required removal of builtin id-suppression; one existing test encoded the OLD suppression, so it
  had to be flipped (out of listed writable surface). Minor planning miss: the spec should have named
  that test as intentionally-changed. coder/security review PASS; tester caught two shallow tests (an
  empty-activity guard that wasn't actually exercised, and an untested throwing-subscriber try/catch) —
  both added. Lesson: a `try/catch` or guard clause needs a test that fails when it's deleted.
- 2026-07-13 t03: strong catch by adversarial review — the double-render usage-strip was gated on
  `details.usage` instead of `details.taskId`, so it ran on the SHARED renderer's foreground path and
  would silently delete a legitimate trailing `usage:` line from a foreground agent's message. A
  foreground regression that the per-aspect reviewers rated only a NIT; the adversarial lens made it
  concrete. Lesson: when a task extends a shared component, every new branch needs an explicit
  "foreground unchanged" gate AND a foreground-path regression test. Also: initial-paint subscribe was
  outside the try/finally (leak on throw). Both fixed pre-commit.
- 2026-07-13 t03 (pre-existing, OUT OF SCOPE — follow-up): in background-tasks.ts the dispatch
  *resolve* path stores `record.error = result.error ?? …` WITHOUT `capErrorText`, unlike the *reject*
  path which caps it; `task.error` is then interpolated into failed-content. Not introduced by F04.
  Candidate follow-up: cap/sanitize `result.error` on the resolve path for parity with the reject path.
- 2026-07-13 t04: planning miss — the docs task's writable surface omitted `doc/user-guide.md`, but the
  feature is user-observable and the guide's "Observing subagents" section only covered foreground.
  Expanded t04 scope to update it. Lesson: a docs task for a user-facing behavior must include the
  user-guide, not just the capability registry + CHANGELOG. Also: the full-surface fixture README
  claims "each canary is asserted by tests" but new canaries were added unasserted (pre-existing
  looseness — FS-LEGACY-SHIP too); added an assertion for the new one to keep the claim honest.

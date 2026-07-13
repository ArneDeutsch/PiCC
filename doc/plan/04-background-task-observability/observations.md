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

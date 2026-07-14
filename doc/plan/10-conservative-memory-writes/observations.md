# F10 Observations

Running record of friction, bugs, and opportunities. Dated bullets; distilled into review.md at close.

## 2026-07-14 — Planning

- Plan review (5 reviewers) caught a real WHAT-level defect the investigation missed: the
  documented CLAUDE.md eager-write opt-in was structurally disfavored — the conservative policy
  is injected AFTER the `## Project instructions (CLAUDE.md)` section, so without a deference
  clause the opt-in would silently lose. Fixed by requiring a deference clause in
  `MEMORY_WRITE_POLICY`. Lesson: prompt-section ORDER is a real seam for guidance features;
  worth a standing check when a feature relies on one injected instruction overriding another.
- Tester caught a false-green: asserting `/remember/i` on the whole subagent dispatch prompt is
  satisfied by the co-injected `# Auto memory` section, so it wouldn't prove the per-agent
  string flipped. Shared-constant + co-injection makes "does THIS section carry the policy"
  hard to test by positive substring; the fix is a negative on a phrase unique to the OLD
  string. Lesson: when two sections share wording, positive-substring tests contaminate.
- CHANGELOG friction: the auto-memory feature is still in `[Unreleased] ### Added`, so the
  Keep-a-Changelog-correct move is to reword the existing Added bullet, not add a `### Changed`
  entry (which would make one unreleased section both add and change the same behaviour).
- Deferred (user chose docs-only, Option A): add a `setting.memory` compat finding in
  `compat-report.ts` so a migrant loading auto-memory gets a runtime `/doctor` + startup-notice
  signal about the conservative-writes divergence. Out of scope for F10 by explicit decision;
  candidate follow-up. Tradeoff: more faithful to the "no silent surprises" charter vs. noise
  on every project with a MEMORY.md, and compat findings are designed for per-project
  misconfig, not global house defaults.
- Deferred idea (parity/UX raised, not adopted): an `examples/full-surface` fixture pairing a
  MEMORY.md with a CLAUDE.md eager-write opt-in line to exercise the override end-to-end. No
  deterministic assertion is possible (model behaviour), so it wouldn't test anything — left
  out. The deference-clause unit assertion is the deterministic proxy instead.
- Internal stale claim (out of scope): doc/plan/picc-plan.md:407 still describes memory as
  "write conventions"; historical planning artifact, not a user-facing truthfulness surface.

## 2026-07-14 — t01 implementation & review

- t01 implemented cleanly, first pass, no deviations; coder + tester both PASS.
- Test-design lesson (tester): when two prompt sections share wording via a common constant,
  a positive substring assertion on the whole prompt is contaminated (false green). Proving a
  specific site carries the constant needs either a section-scoped slice or an
  occurrence-COUNT assertion. Applied the count==2 approach.
- Spec-doc friction (coder): t01 carried a stale blanket "don't use 'proactively'" line that
  contradicted the later-added deference clause. Reconciled. Lesson: when review adds a
  MUST (the deference clause) mid-plan, re-scan the earlier constraints in the same spec for
  contradictions before dispatch.

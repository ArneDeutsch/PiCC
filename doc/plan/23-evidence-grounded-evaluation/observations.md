# F23 Observations

Running record of friction, planning errors, bugs, and opportunities. Raw material for
review.md. Dated bullets, one line each.

- 2026-07-16 Phase 4: the evaluate corpus is tightly single-sourced (engine owns the rubric +
  canonical block; modes fill only mode-specific rows). Biggest build risk flagged by the
  generalist: duplicating the grounding rule into every mode instead of the engine, and
  missing the `evaluator.md` return-shape seam (its "no excerpts" rule silently forbids the
  new anchors).
- 2026-07-16 Phase 4: security identified the evidence-anchor field as a genuine new egress
  channel — locked to repo-relative locators (no contents/excerpts), an allow-list rejecting
  absolute/`..`/outside-repo/`.env`/`~/.pi`/`.git`, dual-enforced, investigation
  filesystem-only (never `gh`/fetch). This is the load-bearing safety constraint.
- 2026-07-16 t01: all three diff reviews (security/tester/coder) PASS. Applied 4 trivial
  coordinator fixes: engine-side pins for element-7 (coordinator re-validation strictly
  stronger / never re-open / ≤5 cap) and the `#N`-not-a-locator reconciliation; tightened the
  loose `.git` test assertion to `.git/`; folded security's Windows-absolute note (drive-letter
  / drive-relative / UNC / symlink canonicalization) into engine element 5 so the cross-platform
  "reject absolute" rule isn't POSIX-only.
- 2026-07-16 t02: security + tester reviews PASS. Applied 2 fixes: tightened the prose-only
  test to one binding clause carrying the load-bearing `**only**` (was split into two
  toContains around it — a false-green window); marked engine element 7 as the authoritative
  list in proposal-gate's illustrative restatement (mild single-sourcing drift risk — kept the
  concrete steps since prose is the only compliance guardrail, just anchored authority).
- 2026-07-16 t03: security + tester reviews PASS, no actionable findings. The sharpest trust
  case (issue-eval reads untrusted issue text + trusted tree in one dispatch) holds: locators
  are trusted-tree files, only prose is leakage-stripped, both public egresses (issue-eval +
  pr-eval) proportionately bounded, close-invariant/L1/redirect isolation untouched. issue-eval
  cap tightened to ≤1 brief / ≤4 full (stronger than engine's ≤5), ceilings-never-floors.
- 2026-07-16 t04: docs + tester + security reviews PASS. The Phase 8 `## Evaluation` embed
  (public body authored by the Bash+Read coordinator) correctly applies the full element-7
  re-validation IN ADDITION TO Rule 6 (the plan's security must-fix). Added one test pin for
  the "strictly stronger ... in addition to Rule 6" relationship (tester NIT). CHANGELOG entry
  style-faithful + conflict-safe (separate dated block); no capability regen, no other docs.

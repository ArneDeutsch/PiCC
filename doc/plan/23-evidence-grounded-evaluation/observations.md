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

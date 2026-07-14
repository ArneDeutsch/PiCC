# F07 Observations

- 2026-07-14 — Plan review exposed that “control characters” overstated the existing helper’s `Cc`-only contract; the feature wording was narrowed before implementation.
- 2026-07-14 — Several reviewers proposed changing empty-error fallback semantics, but that would broaden issue #3; the existing nullish contract was preserved and explicitly tested.
- 2026-07-14 — Reviewers using `git diff HEAD` cannot see a newly created untracked execution log, so every review independently flagged possible log omission even though the file existed; future review prompts or workflow guidance should include `git status --short` or explicit log reads.
- 2026-07-14 — The implementation matched the one-task plan without deviations; focused storage-boundary tests were sufficient and no capability or user-guide updates were needed.

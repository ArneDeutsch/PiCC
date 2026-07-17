# Phase 8 — Feature close review

Dispatch prompts are governed by [dispatch-discipline.md](dispatch-discipline.md) — read it before your first fan-out; if it cannot be read, do not dispatch.

When all tasks are committed, review the whole feature against feature.md:

- Fan out the full relevant roster over the complete feature diff (`git diff <default-branch>...HEAD`) + `doc/plan/<feature-slug>/feature.md`: is the WHAT fully delivered? Anything half-done, inconsistent, undocumented?
- Add one adversarial completeness check (`generalist`): "what would a skeptical reviewer of the PR find missing?"

Integrate. Small fixes: do them (with review as in Phase 7, proportionate). Real gaps: define new task specs (continue the task numbering, update feature.md's `## Tasks`) and run them through Phase 7 ([phase-7-implementation.md](phase-7-implementation.md)). If the gap questions the WHAT/WHY, talk to the user. Done when you judge the feature complete and the user has been shown a short completion summary and agrees.

Also make sure the repo's own records are current before closing: docs and `npm run gen:capabilities` if the capability registry changed (the `docs` reviewer should have caught these — this is the backstop).

Then write the feature's `review.md` (template in [templates.md](templates.md)) by distilling `observations.md`, the task logs, and your own judgment of the cycle. This is the learning record: planning errors, friction, bugs found along the way, refactoring and improvement opportunities, and concrete follow-up proposals. It is **written to disk but not committed** — the close/issue-filing pipeline reads it by path, and it is the run-local staging surface from which follow-ups are filed as **GitHub Issues** at close; those filed Issues are the durable cross-feature record that future planning reads (not this uncommitted file), and the process/system weaknesses it records are how this workflow itself gets improved. Present the major findings and proposed follow-ups to the user (they may become the next features).

The ticket-path close hooks (close-vs-keep-open judgement + write preview) and the either-path issue-filing offer run inside this same close gate; their full text is in [ticket-integration.md](ticket-integration.md) (Per-phase ticket hooks → Phase 8). **Read it before any such write, and refuse the write if it cannot be read.**

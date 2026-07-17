# Phase 6 — Plan review & approval

Dispatch prompts are governed by [dispatch-discipline.md](dispatch-discipline.md) — read it before your first fan-out; if it cannot be read, do not dispatch.

Fan out reviewers over the whole plan folder `doc/plan/<feature-slug>/` (its `feature.md` + all `tasks/` specs), in parallel, in review mode:

- Each **relevant specialist**: "Is your aspect completely covered by this plan? What's missing?"
- An **adversarial reviewer** (`generalist`): find holes, contradictions, unstated assumptions, seam mismatches between task specs, missed edge cases in the WHAT/WHY/HOW.
- An **end-user walkthrough** (`user-experience`): walk through the feature as the person using it, start to finish — does the plan actually deliver the promised experience?

Integrate the findings. Fix what's clearly right directly in the plan files. Escalate to the user: anything changing the WHAT/WHY, and any major HOW concern with real tradeoffs. Iterate (further review rounds only for substantial changes) until you and the user both accept — re-show the scope mirror if scope moved. Phase 6 ends here at mutual acceptance: **nothing is committed** — the plan folder is worktree-local gitignored scratch.

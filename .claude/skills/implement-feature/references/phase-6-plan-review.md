# Phase 6 — Plan review & approval

Dispatch prompts are governed by [dispatch-discipline.md](dispatch-discipline.md) — read it before your first fan-out; if it cannot be read, do not dispatch.

Fan out reviewers over the whole plan folder `doc/plan/<feature-slug>/` (its `feature.md` + all `tasks/` specs), in parallel, in review mode:

- Each **relevant specialist**, always including `docs`: "Is your aspect completely covered by this plan? What's missing?" The docs reviewer applies [*Proportional scope* in the documentation guide](../../../../doc/documentation-guide.md) to the whole plan's aggregate footprint, validating the existing disposition against the plan rather than presuming additions.
- An **adversarial reviewer** (`generalist`): find holes, contradictions, unstated assumptions, seam mismatches between task specs, missed edge cases in the WHAT/WHY/HOW.
- An **end-user walkthrough** (`user-experience`): walk through the feature as the person using it, start to finish — does the plan actually deliver the promised experience?

Integrate the findings. Fix what's clearly right directly in the plan files. Docs review may reject a surface or remove an unnecessary documentation task even when its statements would be individually true and correctly placed. When it does, update `feature.md`, dependencies, rationale, and writable surfaces together rather than leaving a tombstone. After a partial removal, preserve the disposition for every remaining accepted surface; record a concise no-change disposition in the surviving owning behavior task only when no accepted durable surfaces remain. Escalate to the user: anything changing the WHAT/WHY, and any major HOW concern with real tradeoffs. Iterate (further review rounds only for substantial changes) until you and the user both accept — re-show the scope mirror if scope moved. Phase 6 ends here at mutual acceptance: **nothing is committed** — the plan folder is worktree-local gitignored scratch.

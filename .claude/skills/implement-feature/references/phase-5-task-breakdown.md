# Phase 5 — Task breakdown

Dispatch prompts are governed by [dispatch-discipline.md](dispatch-discipline.md) — read it before your first fan-out; if it cannot be read, do not dispatch.

Split the work into tasks, each sized for one implementer subagent in one context. For each, write `tasks/t<task-number>-<task-slug>.md` (template in [templates.md](templates.md); task numbering is local to this feature). Order them by dependency; prefer an order where each task leaves the suite green. Then **backfill the `## Tasks` section of feature.md** with the ordered titles and dependencies.

A task spec must be **self-contained**: task spec + feature.md is all the *feature context* the implementer gets. Precision goes to the *seams* — where the task touches existing code and where it touches other tasks (names, shapes, contracts must match across specs). Inside the task, leave breathing room: state the goal and constraints, not pre-written code. List deferred decisions under "Left open".

Preserve the Phase 4 disposition under [*Proportional scope* in the documentation guide](../../../../doc/documentation-guide.md). Record a no-change disposition exactly once, in the relevant owning behavior task's existing `Context & seams`. When durable paths are accepted, put each path's rationale in that path's one owning task and list the path in that task's `Writable surface`; removing a surface removes both its path and rationale. A no-change disposition creates no ceremonial task. Use a standalone documentation task only when the work is independently implementer-sized or dependency-separated.

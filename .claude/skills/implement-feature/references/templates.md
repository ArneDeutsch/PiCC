# Templates

The three plan-folder templates the router and the phase files refer to. Copy the relevant one when a phase says to write `feature.md`, a task spec, or `review.md`.

## Plan folder layout

```
doc/plan/<feature-slug>/
  feature.md          WHAT/WHY spec (Phase 3; Tasks section backfilled in Phase 5)
  tasks/t<task-number>-<task-slug>.md   task specs (Phase 5)
  log/t<task-number>.md        execution logs, written by implementer/fix subagents (Phase 7)
  observations.md     coordinator's running record of deferrals/friction/bugs/opportunities (begins when needed in Phase 6; continues through Phases 7–8)
  review.md           distilled close record (Phase 8)
```

### `feature.md`

```markdown
# <feature-slug>: <Title>

Ticket: <the linked issue as `<issue-host>#N` — the **issue-host** repo where the
issue actually lives: `<fork>#N` for a **given** fork-hosted ticket (a URL ref that
matched the fork only), else `<target>#N`. A ticket **created** via the Phase 1
ticket-creation offer always lands on `target`, so its anchor is always `<target>#N`
(as is a given ref that matched `target`); written at Phase 3; `–` when ticketless.
Kept machine-greppable and stable: the resident anchor reader greps this line on resume.>

## What
<What the feature does, as observable behavior. Include explicit non-goals.>

## Why
<The value: who needs this, what problem it solves, why now.>

## Acceptance
<How we know the feature as a whole is done — user-level checks, not test names.>

## Tasks
<Placeholder at Phase 3: "(filled in during task breakdown)". Backfilled in
Phase 5 as an ordered list: t01 <title> (depends on: –), t02 <title>
(depends on: t01), … Titles and dependencies only. Kept current when Phase 8
adds tasks.>
```

### `tasks/t<task-number>-<task-slug>.md`

```markdown
# t<task-number>: <Title>

## Goal
<What exists and works when this task is done.>

## Context & seams
<Where this hooks into existing code (files/functions/concepts) and the exact
contracts shared with other tasks — names, shapes, behavior at the boundary.
Everything the implementer can't safely invent alone.>

## Writable surface
<Paths this task may create/modify. Everything else is read-only.>

## Approach constraints
<Only genuinely binding decisions from planning. Keep short.>

## Left open
<Decisions deliberately deferred to the implementer.>

## Testing
<What must be covered and at which layer (unit / offline-integration / e2e);
cross-platform concerns (Windows + Linux).>

## Acceptance criteria
- [ ] <verifiable statement>
- [ ] typecheck and full test suite green

## Depends on
<task ids, or –>
```

### `review.md`

```markdown
# <feature-slug> Review: <Title>

## Outcome
<One paragraph: what shipped, and how it deviated from the plan (if at all).>

## Planning errors & spec gaps
<What the plan got wrong or left underspecified, and what that cost.>

## Friction
<Where the process, tooling, specs, or this workflow itself slowed things down.>

## Bugs discovered
<Pre-existing issues found along the way — fixed here, or still open.>

## Improvement opportunities
<Refactorings, missing tests, doc gaps, parity gaps — noted but out of scope here.>

## Proposed follow-ups
<Candidate features/tasks with a one-line rationale each.>
```

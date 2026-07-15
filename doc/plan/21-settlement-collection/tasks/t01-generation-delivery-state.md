# t01: Generation-safe settlement delivery state

## Goal

Each concrete background task run has authoritative delivery state so terminal TaskOutput collection suppresses only a not-yet-delivered notice for that run, while explicit retrieval after notification remains available and resumed runs remain independent.

## Context & seams

`BackgroundTaskRegistry` in `src/runtime/background-tasks.ts` owns each `task-N` result and builds settlement notices. `SubagentRegistry` retains the per-`agent-…` settled gate used to establish readiness and re-arm resumes. Multiple task records may share one stable agent id, so collection state belongs to the task record; agent identity is used only to preserve the existing newest-generation supersession policy.

Extend `BackgroundTaskView` with an owner-safe collection transition delegated by `scopedTo()`. Represent pending, TaskOutput-collected, and successfully-notified outcomes explicitly or equivalently. The transition is idempotent and task-specific. Directional ordering is binding:

- terminal collection before successful notice send marks the run collected and invalidates that pending notice;
- successful notice send before collection marks it notified; later TaskOutput still returns the result and does not re-arm anything;
- a send throw while the notice remains current leaves it pending and retryable;
- a newer generation for the same agent permanently supersedes an older selected or pending notice under the existing newest-generation policy.

`drainSettlementNotices()` must let the newest record claim a shared agent id even when that record is running, collected, or already notified. A collected newest record must not fall through to an older result, and collecting an old record must not suppress a newer resumed result. Registry-miss early failures use the same task-local state.

A selected notice must expose a final synchronous validity check (or equivalent compare-and-set seam) that verifies both pending delivery state and continued newest-generation ownership immediately before send. The production loop has no `await` between that check, `pi.sendMessage`, and commit; this synchronous segment is the linearization boundary. Do not claim safety for a future asynchronous sender without redesigning it as an atomic claim/rollback state machine.

## Writable surface

- `src/runtime/background-tasks.ts`
- `test/background-tasks.test.ts`

## Approach constraints

- Key collection/notified state by `task-N`, never solely by stable agent id.
- Keep the agent registry as the settlement-readiness/resume gate unless removing it is proven safe across all existing lifecycle consumers.
- Preserve bounded notice rendering, successful-send commit, failed-send retry, owner scoping, and existing newest-generation supersession.
- Do not change model-facing TaskOutput or notice wording in this task.
- Use barriers and explicit operation order in tests; no sleeps.

## Left open

- Exact delivery-state names and whether the old fallback flag is removed or migrated.
- Exact method names for collection and final pre-send validity.
- Whether collected current records eagerly consume an armed agent-level gate or leave it harmlessly superseded, provided resume and retry invariants hold.

## Testing

Unit tests in `test/background-tasks.test.ts` must cover:

- eligible uncollected completed/failed/stopped and registry-miss tasks still notify exactly once;
- collection before send suppresses the matching task notice for every terminal status;
- successful send followed by later collection preserves retrieval and never re-arms;
- failed send while current stays retryable;
- selection followed by collection invalidates delivery;
- selection followed by creation of a newer running, collected, or notified generation invalidates the old notice permanently;
- newest-running/collected/notified generations never fall through to older records;
- collecting an older generation cannot suppress the newest pending generation;
- repeated/concurrent collection is idempotent;
- scoped views may collect owned tasks but cannot mutate foreign tasks;
- true registry-miss fallback orderings: selection then collection, send failure then retry, and successful delivery then later collection.

All tests must be deterministic and platform-neutral.

## Acceptance criteria

- [ ] Settlement collection/notified state is authoritative per task generation and owner-scoped views preserve isolation.
- [ ] Collection completed before send prevents that later notice; send completed first remains delivered and does not block later explicit retrieval.
- [ ] Resume-newest-wins, registry-miss fallback, failed-send retry, and bounded exactly-once notices remain correct.
- [ ] Final pre-send validity rejects both a collected task and an old task superseded after selection.
- [ ] typecheck and full test suite green

## Depends on

–

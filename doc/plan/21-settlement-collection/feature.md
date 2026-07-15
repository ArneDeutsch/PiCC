# F21: Collected Task Settlement Delivery

Ticket: ArneDeutsch/PiCC#45

## What

PiCC will treat a terminal background-task record returned through `TaskOutput` as already delivered. The next-turn settlement drain will not repeat a stale instruction to retrieve that same result.

Polling a task before it settles will not count as delivery. In an interactive session, a settled, uncollected task that remains the current generation for its agent will still produce one bounded settlement notice. Collection and notification will remain correct across successful, failed, stopped, resumed, newest-resume-wins, and concurrent task lifecycles.

This feature does not add an always-on task view, solve print-mode loss of uncollected work, change the existing newest-generation supersession policy, or broadly redesign task output and settlement messaging.

## Why

Coordinators need a trustworthy delivery sequence for background results. Re-announcing a result already returned by `TaskOutput` duplicates context, gives stale instructions, and makes completed collection look uncertain. Collection-aware notices remove that confusion without hiding genuinely uncollected current outcomes.

## Acceptance

- A terminal task record successfully returned by `TaskOutput` is not announced afterward on the next user turn.
- Explicit `TaskOutput` retrieval remains available after a notice has already been delivered and does not re-arm another notice.
- Polling a still-running task does not suppress its eventual settlement notice.
- In an interactive session, a settled but uncollected current task emits exactly one bounded notice; older resumed generations remain subject to the existing newest-generation supersession rule.
- Successful, failed, stopped, resumed, and newest-resume-wins outcomes retain correct delivery behavior; an uncollected stopped notice reports the outcome without directing the coordinator to retrieve a discarded result.
- Concurrent collection and settlement neither lose an eligible uncollected result nor announce a result after its earlier terminal collection.
- Existing task dispatch, collection, and notification behavior outside this scope remains compatible.

## Tasks

1. t01 Generation-safe settlement delivery state (depends on: –)
2. t02 Collection-aware TaskOutput lifecycle (depends on: t01)
3. t03 Truthful settlement-delivery contract (depends on: t02)
4. t04 Close-review settlement clarity (depends on: t03)

# F13: Scope subagent TaskOutput/TaskStop to the dispatcher's own tasks

## What

Background tasks live in one session-wide registry that every subagent granted
`TaskOutput`/`TaskStop` can currently reach in full. A subagent can therefore
read the result of, or stop, **any** task in the session — its siblings' tasks
and the coordinator's own tasks — not only the tasks it dispatched. This feature
closes that isolation gap.

After this feature:

- A subagent's `TaskStop` and `TaskOutput` reach **only tasks that same subagent
  dispatched**. A task dispatched by a sibling subagent or by the coordinator is
  unreachable: the subagent is refused cleanly, with no read of, or effect on, the
  foreign task's result, status, or registry/filesystem state — no reachability,
  no content, and no refusal a subagent can distinguish from a genuinely-unknown
  id. (One honest residual: task ids come off a single session-wide monotonic
  counter, so a subagent can still infer a rough *count* of other session tasks
  from its own id — a bare count signal, never their content, status, or
  reachability. t03 states this honestly rather than overclaiming "as if the id
  never existed.")
- The **coordinator** is unaffected: it retains full access to every task in the
  session, exactly as today.
- Subagents **keep** both `TaskOutput` and `TaskStop` — they stay in a subagent's
  toolset, scoped. (Phase-4 parity check, verified against Claude Code's
  sub-agents "Available tools" docs: subagents *inherit* `TaskOutput`/`TaskStop`;
  only `AskUserQuestion`/`EnterPlanMode`/`ExitPlanMode`/`ScheduleWakeup`/
  `WaitForMcpServers` are withheld. The "TaskOutput hidden from subagents"
  behavior is a filed Claude bug — #15098, #23154 — not its contract. So we do
  **not** hide the tool; hiding would also strand a subagent that explicitly
  backgrounds a nested dispatch and then needs to retrieve it.)
- The refusal a subagent sees for a foreign or unknown id is clean and
  non-leaking — it must not reveal that the id exists elsewhere in the session,
  nor expose another task's label, status, or output. Unknown and
  foreign-but-existing ids are indistinguishable to a subagent.

**Parity note (honest divergence):** Claude's own subagent isolation is via
fresh context — a subagent simply never learns foreign `task_id`s — not an active
dispatcher-identity guard. picc's explicit per-dispatcher guard is a faithful
hardening of that same isolation. It is *stricter* than Claude on exactly one
edge case: a coordinator that deliberately hands a subagent another task's id
(the pattern Claude's #15098 fix intends to *allow*) is refused here — which is
precisely the leak F13 closes. The capability registry states this honestly; it
does **not** claim blanket "non-divergent."

**Non-goals (out of scope):**

- No change to the coordinator's full access to all session tasks.
- No change to foreground dispatch semantics, `SendMessage`, or the
  default-foreground-vs-Claude-background divergence.
- No new `TaskStop`-by-agent-id/name support (a separately documented partial).
- No changes to any other capability-registry divergence beyond the
  `TaskOutput`/`TaskStop` subagent-scoping entries this feature corrects.

## Why

This is an isolation divergence found during F02: a code comment claimed a
subagent could only poll/stop its own tasks; the comment was false and was
corrected, leaving the real behavior documented-but-unfixed in the capability
registry. Cross-dispatcher reach means one subagent can observe or disrupt work
it was never handed — a subagent could stop the coordinator's other in-flight
background task, or read output it should never see. Claude Code does not hand a
subagent a sibling's or the coordinator's task either (its subagents run in fresh
context and simply never learn those ids); picc claims Claude-compatibility, so
the shared-registry exposure is both a correctness/isolation problem and a
truthfulness problem in the capability matrix. Fixing it makes the isolation
boundary real and lets the registry state the honest, scoped behavior — matching
Claude's fresh-context isolation in practice, with a truthful note that the
explicit guard is stricter only on the #15098 coordinator-passed-id pattern (see
the Parity note above). Not a blanket "non-divergent" claim.

## Acceptance

- A subagent that dispatches its own background task can still retrieve/stop
  **that** task (its legitimate own-work path keeps working).
- A subagent attempting `TaskOutput`/`TaskStop` on a task dispatched by a sibling
  subagent, or by the coordinator, is refused cleanly — no access to the foreign
  task's result/status and no effect on it — and the refusal does not leak the
  task's existence or contents.
- The coordinator can still reach every task in the session.
- The capability registry (`tool.TaskOutput`, `tool.TaskStop`, and any
  `feature.background-agents` wording) reflects the corrected behavior honestly —
  the false "shared registry, any task reachable" / "Claude hides TaskOutput from
  subagents (a project-intended restriction)" text is gone, replaced with the
  scoped behavior and the honest #15098 hardening note (not a blanket
  "non-divergent" claim).
- Automated tests assert the sibling-task and coordinator-task cases are
  unreachable from a subagent, and that a subagent's own task stays reachable.
- `npm run typecheck` and the full test suite are green; `npm run gen:capabilities`
  is in sync if the registry changed.

## Tasks

- t01 Registry ownership + scoped view (depends on: –) — add `owner` to the task
  record, `scopedTo(ownerId)` returning a filtered `BackgroundTaskView`, retype
  the two tool factories to it; unit tests for the scope predicate + non-leak.
- t02 Thread dispatcher ownership through subagent dispatch (depends on: t01) —
  thread the dispatcher `agentId` through `customToolsFor` and
  `createAgentToolDefinition`, scope subagent tools via `scopedTo`, extract a
  `scopedBackgroundTools` helper, remove the stale divergence comment; one
  offline-integration wiring test.
- t03 Capability registry truthfulness + CHANGELOG (depends on: t02) — correct the
  `tool.TaskOutput`/`tool.TaskStop`/`feature.background-agents` wording, regenerate
  `doc/supported-features.md`, add a CHANGELOG entry.

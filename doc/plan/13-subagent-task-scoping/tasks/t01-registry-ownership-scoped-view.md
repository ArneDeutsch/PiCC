# t01: Registry ownership + scoped view

## Goal
`BackgroundTaskRegistry` records who dispatched each task and can hand out a
per-owner **scoped view** that exposes only that owner's tasks. The two task
tools (`createTaskOutputTool` / `createTaskStopTool`) work unchanged against
either the full registry or a scoped view. No wiring into dispatch yet (that is
t02) — after this task every existing call site still passes the full registry,
so behavior is unchanged and the suite stays green. New unit tests prove the
scoping predicate and the non-leak refusal.

## Context & seams

All in `src/runtime/background-tasks.ts`.

- **Record field.** Add `owner?: string` to `BackgroundTaskRecord` (interface at
  ~line 77). Semantics, fixed contract for t02: `owner` is the **agent id of the
  dispatch that started the task** (a subagent's own `agentId`); `undefined`
  means the coordinator (owns-all, reached only via the full registry, never a
  scoped view). A scoped view keyed to owner `X` matches a record **iff**
  `record.owner === X` (plain string compare; `undefined` never matches any
  scoped owner).

- **`start()` gains an owner.** `start()` (signature at ~line 162:
  `start(label, promise, abort?, agentId?, agentType?)`) must accept the owner
  and set `record.owner`. Keep the existing 5 params in place and order; the
  exact form of the addition (6th optional positional `owner?: string`, or an
  options bag) is left open — but existing callers that pass no owner must keep
  compiling and behave as `owner: undefined`. Note: `owner` is distinct from
  `agentId` — `agentId` is the *dispatched child's* identity; `owner` is the
  *dispatcher's*. Do not conflate them.

- **`BackgroundTaskView` interface + `scopedTo(ownerId)`.** The two tool factories
  currently take `registry: BackgroundTaskRegistry` (concrete class) and use only
  these registry members: `get(id)`, `ids()`, `wait(id)`, `stop(id)`,
  `subscribeProgress(id, cb)` (see `createTaskOutputTool` ~579-756 and
  `createTaskStopTool` ~759-780, and `unknownIdError` ~566, which calls `ids()`).
  Introduce a small exported interface `BackgroundTaskView` declaring exactly
  those five members, and:
  - Retype the `registry` param of both factories from `BackgroundTaskRegistry`
    to `BackgroundTaskView`. `BackgroundTaskRegistry` must structurally satisfy
    `BackgroundTaskView` (it already implements all five), so the coordinator's
    existing `createTaskOutputTool(backgroundTasks)` keeps working with no cast.
  - **Also retype `unknownIdError` (~:566) to `unknownIdError(view:
    BackgroundTaskView, id)`** — both factory bodies call it (`:618`, `:771`) with
    the very param being scoped, so it must receive the **scoped** view and call
    the scoped `ids()`. This is load-bearing for non-leak: do **not** "fix" the
    resulting type error by capturing the full registry in a closure and passing
    that to `unknownIdError` — that would relist every session id and reopen the
    exact leak this task closes. The concrete registry satisfies the widened
    param, so the coordinator's unscoped path is unaffected.
  - Add `scopedTo(ownerId: string): BackgroundTaskView` on `BackgroundTaskRegistry`.
    The returned view **delegates to the live registry at call time** (it must NOT
    snapshot ids/records at construction) but filters **every** member on
    `owner === ownerId`. Live delegation is essential: a subagent's scoped tools
    are built in `customToolsFor` *before* the subagent dispatches its own task,
    so a view that froze the task set at construction would report the subagent's
    own later task as unknown and break the legitimate own-work path. Filtering
    per member:
    - `get(id)` → the record only if owned, else `undefined`.
    - `ids()` → only owned ids (this is what makes `unknownIdError` non-leaking —
      it must never list a foreign id).
    - `stop(id)` → performs the stop **only if owned**; for a non-owned/unknown id
      it must be a no-op returning the same falsy result `stop()` returns for an
      unknown id, and it must **not** call the underlying `registry.stop` / invoke
      the foreign task's `abort` (security: no foreign-task effect).
    - `wait(id)` / `subscribeProgress(id, cb)` → for a non-owned id, must not
      await or subscribe to the foreign task. In practice both tool bodies call
      `get(id)` first and throw `unknownIdError` before reaching `wait` /
      `subscribeProgress`, so a scoped `get` returning `undefined` already
      short-circuits them; still, the view's own `wait`/`subscribeProgress` must
      not reach into foreign records if called directly (defense in depth).

- **Non-leak invariant (security).** For a scoped caller, a foreign-but-existing
  id and a truly-unknown id must be **indistinguishable**: identical thrown error
  text (which, via `unknownIdError` + scoped `ids()`, lists only the caller's own
  ids or none), no foreign status/label/output/transcript/ progress revealed, and
  no side effect on the foreign task. The check must reject synchronously, before
  any `await`, `subscribeProgress`, `wait`, or `stop` touches the foreign record.

## Writable surface
- `src/runtime/background-tasks.ts`
- `test/background-tasks.test.ts`

## Approach constraints
- `BackgroundTaskView` must be a real interface the concrete registry satisfies
  structurally — no `any`, no casting the scoped view to the concrete class.
- Do not change the bodies of `createTaskOutputTool` / `createTaskStopTool`
  beyond the param **type**; the scoping lives entirely in the view.
- Do not touch `noteProgress` (it is called against the full registry by the
  Agent tool's progress callback, not via the scoped view).

## Left open
- Whether `start()` takes a 6th positional `owner?` or an options bag.
- Internal representation of the scoped view (closure object vs small class).
- Whether `scopedTo` memoizes per owner (not required).

## Testing
New `describe` in `test/background-tasks.test.ts` (unit), seeding three tasks with
distinct owners — coordinator (`undefined`), `subA`, `subB` — via `start(...)`,
and building `createTaskOutputTool`/`createTaskStopTool` over
`registry.scopedTo("subA")`:
- **own reachable:** scoped-subA `TaskOutput` resolves subA's task; scoped-subA
  `TaskStop` stops it.
- **own reachable when dispatched AFTER tool build (live delegation):** build the
  scoped-subA tools first, *then* `start(...)` a subA-owned task, then assert
  scoped-subA `TaskOutput`/`TaskStop` reach it. This fails against an eager
  snapshot and is what proves `scopedTo` delegates live.
- **foreign refused (`it.each` over subB's and the coordinator's task, at least
  one of them `running`):** `TaskOutput`/`TaskStop` throw; assert the error text
  contains **no** foreign `task_id`, agent id, label, status, or output. Do
  **not** assert byte-equality against the unknown-id error — `unknownIdError`
  echoes the *requested* id (`Unknown task_id "<id>"`), so two different ids
  differ there for a benign reason. Instead assert (a) the "Known background
  tasks" list **segment** is identical to the unknown-id case (scoped to subA's
  own ids), and (b) no foreign field leaks.
- **known-ids list scoped:** the refusal's "Known background tasks" listing
  contains only subA's own ids (or none) — never subB's / the coordinator's id.
- **no live-progress leak (security MUST):** with a **running** subB-owned task,
  (a) scoped-subA `TaskOutput(subB_running)` is refused before any subscription;
  and (b) calling the scoped view directly —
  `registry.scopedTo("subA").subscribeProgress(subB_running, cb)` — delivers
  **zero** snapshots to `cb`, returns a no-op unsubscribe, and does not add a
  listener to the foreign task's set (assert the foreign task's subscriber count
  is unchanged); a scoped `wait(subB_running)` must not resolve from the foreign
  task's settlement. This locks the defense-in-depth filter that the
  `get`-short-circuit alone would leave untested.
- **no effect:** after a refused `TaskStop` on a foreign id,
  `registry.get(foreignId)?.status` is unchanged (foreign task not aborted).
- **coordinator unscoped reaches all:** the tool built over the full `registry`
  (no `scopedTo`) still reaches all three ids.
- **(optional) grandchild shape:** a task owned by `subB` is unreachable from a
  `subA` scope (already covered by the sibling case; call it out to lock the
  "parent cannot reach grandchild" property t02 relies on).
- Settle tasks deterministically (resolved promises / the existing gate pattern);
  do **not** copy the `setTimeout(r, 20)` timing smell at ~line 1118.
All in-memory; no cross-platform concerns.

## Acceptance criteria
- [ ] `BackgroundTaskRecord.owner` added; `start()` sets it; existing callers
      compile unchanged and behave as `owner: undefined`.
- [ ] `BackgroundTaskView` interface + `scopedTo(ownerId)` (live-delegating)
      implemented; both tool factories **and `unknownIdError`** retyped to the
      interface with no body change.
- [ ] Scoped view filters `get`/`ids`/`wait`/`stop`/`subscribeProgress` on owner,
      with no foreign-task read or side effect, and delivers zero foreign progress
      snapshots.
- [ ] Unit tests above pass, including the live-delegation, non-leak,
      no-live-progress-leak, and no-effect assertions.
- [ ] typecheck and full test suite green.

## Depends on
–

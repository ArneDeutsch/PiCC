# t02: Bound nested (depth ≥ 2) background fan-out — per-depth budgets

## Goal

Nested background dispatches (a sub-coordinator, or a `background: true` grandchild,
at `depth ≥ 2`) are concurrency-bounded, so background-by-default cannot spawn an
unbounded number of concurrent Pi sessions below the root. The bound is **deadlock-
free**: a parent blocked collecting a child's result (via `TaskOutput`) never
prevents that child from acquiring a slot. Foreground nested dispatches keep their
existing bypass. A depth-2 background fan-out test proves the bound actually engages.

## Context & seams

The limiter is a `Semaphore` (`src/runtime/subagents.ts` ~346-367), sized
`Math.max(1, deps.concurrency)` (default `subagentConcurrency` = 4). In
`SubagentRuntime.dispatch()` it is acquired at ~782:

```ts
const release = opts.depth > 1 ? () => {} : await this.semaphore.acquire();
```

The `depth > 1 ⇒ no acquire` bypass prevents a **foreground** nested deadlock: a
parent that holds a slot while synchronously awaiting a foreground child would
deadlock if all slots were held by such parents.

**Why a single shared pool cannot bound nested background (the deadlock to avoid).**
A dispatch holds its slot for the *entire* session — acquired at ~782, released only
in the `finally` after the session's prompt loop. During that loop the session can
call `TaskOutput`, which defaults to `wait: true` and **blocks** on the child's
settlement (`background-tasks.ts` ~625/657/385), and the registry is session-wide so
a parent can await its own background child. So if nested background dispatches
acquired the *same* pool the ancestors hold: with `concurrency = C`, C depth-1
background sub-coordinators each hold a slot, each dispatches a depth-2 background
child that now queues for a slot, then each calls `TaskOutput(wait)` — parents block
holding slots, children can't get slots, nothing settles. **Deadlock** (guaranteed at
`C = 1` with a single depth-2 nesting). A single *dedicated* nested pool has the same
cross-depth cycle. Therefore **do not reuse the root semaphore / a single shared
limiter for nested background.**

**Mechanism: per-depth budgets.** Give each depth its own budget of `concurrency`
(e.g. a `Map<number, Semaphore>` created lazily, each sized like the root, or an
equivalent per-depth limiter). A dispatch acquires from the budget **for its own
depth**. Because an ancestor at depth *d* holds a slot in pool *d* while a descendant
at depth *d+1* acquires from pool *d+1*, the ancestor's held slot is never the one the
descendant waits on → no cross-depth wait-for cycle → deadlock-free even at
`concurrency = 1`. Total concurrency is bounded by `maxDepth × concurrency`, both
finite and capped (`subagentMaxDepth`, `subagents.ts` ~595/108). Keep the **root**
(`depth ≤ 1`) behaviour exactly as today (depth-1 uses its own pool == the existing
root semaphore's role) so root tests are unaffected. Keep the **foreground** nested
bypass (a foreground `depth > 1` dispatch still acquires nothing) — its deadlock
argument is the reason the bypass exists.

The gate becomes, in effect: foreground `depth > 1` → no acquire (bypass preserved);
otherwise acquire from the per-depth budget for `opts.depth`.

**Threading the `background` flag** — three call sites of `dispatch()`:

1. Add optional `background?: boolean` to `dispatch()`'s `opts` (~495-555).
2. **Set `background: true` on the tool handler's background arm** call
   (`createAgentToolDefinition`, ~1526) — the un-awaited `runtime.dispatch(...)`.
3. **Set `background: true` on the `SendMessage`-resume dispatch** (~1792, un-awaited
   via `backgroundTasks.start`, dispatched at `record.depth`). This is **required**,
   not optional: `SendMessage` is parent-initiated only, so the *common* resumable
   agent is depth-1 (acquires regardless), but a grandchild id that bubbled to the
   root is resumable at `record.depth ≥ 2` and would otherwise hit `depth > 1 &&
   !background` → bypass → an unbounded escape from the bound. Setting the flag is
   deadlock-free (the only waiter is root, which holds no slot). Record the
   depth-1-common / depth-≥2-narrow rationale in the log.
4. The **foreground arm** (~1563, awaited) and **`forkDispatch`** (`src/index.ts`,
   awaited) leave `background` unset — they must keep the foreground bypass.

## Writable surface

- `src/runtime/subagents.ts` (`dispatch()` opts type; per-depth budget structure + the
  acquire gate at ~782; `background: true` on the background arm ~1526 and the
  `SendMessage`-resume dispatch ~1792)
- `test/background-tasks.test.ts` (or nearest concurrency test file) — the depth-2
  bound test
- `doc/plan/15-background-by-default/log/t02.md`

## Approach constraints

- Deadlock-free: never let a slot-holder wait (via `TaskOutput`) on a slot-waiter →
  per-depth budgets, not a shared pool.
- Foreground nested (`depth > 1`) keeps its `() => {}` bypass.
- Root-level (`depth ≤ 1`) semantics and tests unchanged.
- Bound derived from existing config (`subagentConcurrency` / `subagentMaxDepth`); no
  new user-facing setting.
- `SendMessage`-resume dispatch counts against the bound (`background: true`).

## Left open

- Exact per-depth structure (lazy `Map<number, Semaphore>` vs a keyed limiter) and
  whether all depths share the numeric budget or scale it — as long as it is finite,
  per-depth, and deadlock-free. Justify in the log.

## Notes to record in the log / for t03 docs

- **Bounded-wait, not starvation.** The only awaiting edges are foreground
  parent→foreground child, and foreground children never acquire a slot, so a queued
  background child is never awaited by a slot-holder in its own pool → no cycle. But a
  nested background child may wait for an ancestor turn to release before it starts, so
  deep fan-out is bounded-wait, not unbounded-immediate parallelism at every depth —
  state this so "background fan-out" is not read as infinite parallelism.
- **Divergence from Claude (for t03).** Claude's parallel-agent cap is a *global* ~10;
  per-depth budgets allow up to `maxDepth × concurrency` total. This is a conservative
  PiCC safety choice (bounded, finite), documented as such — not claimed as exact
  parity.

## Testing

- **Depth-2 background fan-out is bounded (timer-free) — and actually engages.**
  Reachability: the nested `Agent` tool MUST be constructed **with** a `backgroundTasks`
  registry (as production does via `customToolsFor` / `index.ts:644`) — the existing
  depth-2 test at `runtime-core.test.ts:556` omits it, so a copy of that pattern would
  leave the inner dispatch foreground and prove nothing. Assert the children actually
  took the **background** arm (task ids / running records), then that no more than
  `concurrency` are live at once. Determinism: use a **live high-water counter** via
  `fakeSdk`'s `onPrompt` (increment on entry → `await gate` → decrement); assert `max
  === concurrency` **after** releasing the gate and joining all dispatches (a
  semaphore-parked child physically cannot reach `onPrompt`). Do **not** use
  `setTimeout` to observe concurrency (the sibling pattern at
  `background-tasks.test.ts:1221` uses a `setTimeout(20)` — do not copy it).
- **Deadlock regression.** A depth-1 background parent that dispatches a depth-2
  background child and then `TaskOutput(wait)`s on it completes (does not hang) at
  `concurrency = 1`.
- Foreground nested (`depth > 1`) still runs without acquiring — keep/confirm the
  existing nested-dispatch test green.
- Root-level fan-out tests unchanged and green.

## Acceptance criteria
- [ ] A nested (`depth ≥ 2`) background fan-out runs at most `concurrency` sessions
      concurrently; excess queue and still complete.
- [ ] A parent blocked in `TaskOutput(wait)` on a nested background child does not
      deadlock (verified at `concurrency = 1`).
- [ ] `SendMessage`-resume dispatch counts against the bound.
- [ ] Foreground nested keeps its bypass; root behaviour and tests unchanged.
- [ ] Depth-2 test wires `backgroundTasks` into the nested tool and asserts the
      background arm engaged; it is timer-free.
- [ ] typecheck and full test suite green.

## Depends on
t01

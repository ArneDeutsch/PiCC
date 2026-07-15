# t02: Fork-spawns-fork guard (runtime-set marker, not depth)

## Goal

A fork **cannot spawn another fork**. When a fork (which inherits the parent's tools,
including Agent/Task) issues a nested dispatch with `subagent_type: "fork"`, that
request is **refused/degraded visibly** — it runs as a normal fresh-context subagent
with a fork-specific "a fork cannot spawn another fork" notice (calm/by-design tone),
not honored as an inheriting fork. Normal (non-fork) nested subagent types dispatched
by a fork are **still allowed** (subject to the depth cap).

Note the relationship to t01's main-session-only rule: t01 already degrades **any**
`opts.depth > 1` fork (so normal-subagent → fork is bounded by depth). This task adds
the specific, correctly-worded refusal for the **fork → fork** case, and the marker
that lets a *depth-1-relative* fork's children be identified. Keep the two reasons'
wording distinct (t01: "parent conversation not available for a nested fork"; t02: "a
fork cannot spawn another fork").

## Context & seams

Claude's documented rule: *"A fork still can't spawn another fork. It can spawn other
subagent types, and those count toward the depth limit."* The prohibition is
documented; the mechanism (error vs no-op vs degrade) is **not** — PiCC chooses a
**visible degrade** (mark INFERRED in the log).

**Why a distinct marker, not depth.** The depth guard (`src/runtime/subagents.ts:652-663`,
default 5) bounds nesting levels but carries no memory of fork-ness. A distinct
runtime-set marker records whether the dispatcher is itself an inheriting fork.

**Marker plumbing — a single runtime-set boolean threaded through the shared seams.**
t01 already computes the per-dispatch **`isFork`** boolean (true only when the dispatch
actually inherits — a **degraded** fork has `isFork = false`, so it must NOT set the
marker, or its own nested dispatches would be mis-refused). Thread a
`dispatcherIsFork` marker so the fork's Agent/Task tool instances know their dispatcher
was a fork. It is **set by the runtime only**, never derived from a tool parameter
(same anti-spoofing discipline as `ownerAgentId`, `subagents.ts:983-986`). Threading
points (verify each against the code):
1. Add `dispatcherIsFork?: boolean` to the `dispatch()` opts (`~:542`).
2. Add it to the `SubagentRuntimeDeps.customToolsFor` signature (`~:75-81`) and pass
   the current dispatch's `isFork` at the call site (`~:986`) — because
   `customToolsFor` is invoked **per-dispatch**, the marker naturally scopes to *this*
   fork's tools and does **not** leak to the fork's normal (non-fork) grandchildren.
   Preserve that scoping; do not hoist it to a broader lifetime.
3. Add it to the `createAgentToolDefinition` options (defined in `subagents.ts`,
   execute at `~:1651`; **called** at `src/index.ts:700-701` — note it is defined in
   subagents.ts, not index.ts).
4. Carry it on the shared `dispatchOpts` object (`~:1662`) so **both** the background
   arm (`~:1711`) and the foreground arm (`~:1756`) propagate it.

**Enforcement.** At the fork-dispatch decision (the Agent tool `execute` / top of the
fork branch): if the requested type is `"fork"` **and** `dispatcherIsFork` is true →
route to the **visible fork-degrade** path t01 built (fresh general-purpose + a
fork-specific "cannot spawn a fork" notice, calm tone). Keep the depth guard
(`:652-663`) as the untouched outer backstop. The refusal still passes the normal
permission/gate path (no bypass), and must not leak parent history (t01's rules hold).

**Resolve the t01 `forkFrom`-throw marker/identity trap (carried into this task).** In
t01, `customToolsFor` and the fork *identity* are finalized **before** `forkFrom` is
attempted, so a `forkFrom` throw flips `isFork` to false *after* the fork-marked tools
and `Agent(fork)` identity are already built. Threading `isFork` into `customToolsFor`
here would therefore fork-mark a run that actually degraded — the exact "a degraded
fork sets `isFork = false`" invariant this feature relies on. **Fix it as part of the
marker plumbing:** ensure the `isFork` value that reaches `customToolsFor` (and the
resolved identity/badge) reflects the **final, post-fork-attempt** state — e.g. attempt
the fork-session-manager construction (or at least detect a `forkFrom` failure) **before**
building `customTools` and finalizing the fork agent identity, so a throw resolves to a
plain `general-purpose` (`isFork=false`, unmarked tools, `Agent(general-purpose)` badge)
before either is fixed. This also closes t01's known cosmetic badge-on-throw edge
(`log/t01.md`). Add a test that a `forkFrom`-throw degrade produces `isFork=false`,
unmarked tools (its own nested `"fork"` is NOT refused by the guard for the wrong
reason), and the honest `general-purpose` badge.

## Writable surface

- `src/runtime/subagents.ts`
- `src/index.ts` (marker propagation into the Agent/Task tool defs at `:700-701`)
- New/extended test, e.g. `test/fork-nested-guard.test.ts` or additions to
  `test/slashcommand-fork.test.ts`
- `doc/plan/16-subagent-fork-inheritance/log/t02.md`

## Approach constraints

- The marker is **runtime-set**, never a tool parameter; scoped per-dispatch.
- A **degraded** fork does not set the marker.
- Enforce via the marker (fork→fork), not the depth guard; leave the depth guard as-is.
- Reuse t01's visible-degrade path; only the notice wording/tone differs.

## Left open

- Exact marker field name and carriage (constructor option vs closure) — implementer's
  call, minimal.
- Exact "cannot spawn a fork" notice wording (specific, distinct from t01's nested/gate
  wording).

## Testing

The nested Agent/Task tool with depth/owner threading exists only through the **real
`picc()` wiring**, so this is an **offline-integration** test (real `picc()` + injected
fake SDK), following `test/slashcommand-fork.test.ts`:
- **Guarantee a genuine top-level fork** (fixture provides `getMainSessionFile`; the
  fake `forkSessionManager` returns a usable stub; dispatch at depth 1) — otherwise the
  top-level fork itself degrades, `dispatcherIsFork` is never set, and the nested
  refusal would pass *vacuously* (for the wrong reason).
- Drive that fork's fake session to invoke its granted Agent tool with
  `subagent_type: "fork"` (the `customTools.find(t => t.name === "Agent")` pattern at
  `test/slashcommand-fork.test.ts:44-52,80`).
- Assert the nested fork did **not** inherit and that the emitted notice carries the
  **"cannot spawn a fork"** wording (distinct from the gate-off/nested wording) — this
  proves it took the marker path, not the generic degrade.
- Assert a fork **can** still spawn a *normal* subagent type (positive case).
- Cross-check that `deny: Agent(fork)` still short-circuits before any fork is honored
  (may live in t01's tests).

Cross-platform: offline-integration only; no new temp/process/shell handling.

## Acceptance criteria
- [ ] A fork dispatching `subagent_type: "fork"` is refused/degraded to fresh context
      with a fork-specific "cannot spawn a fork" notice (not honored, not silent).
- [ ] A fork can still spawn normal subagent types (subject to the depth cap).
- [ ] The marker is runtime-set, per-dispatch scoped, never a tool parameter; a
      degraded fork does not set it.
- [ ] The depth guard is unchanged and still acts as the outer backstop.
- [ ] The offline test uses a genuine (non-degraded) top-level fork so the nested
      refusal is proven via the marker path.
- [ ] typecheck and full test suite green

## Depends on
t01

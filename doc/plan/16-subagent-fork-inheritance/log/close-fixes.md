# F16 — Close-review fixes

Final polish applied to the working tree after all tasks were committed. Six items.

1. **[SHOULD] Hoisted `FORK_DEGRADE_PREFIX` to a single shared home.** The
   literal `"fork ran with fresh context: "` was defined TWICE (subagents.ts and
   subagent-render.ts), tied only by a "MUST match" comment with no drift guard.
   Now exported from `src/util/subagent-transcripts.ts` — the shared low-level
   module BOTH files already import (subagent-render.ts must not import from
   subagents.ts, which imports render). Removed both local literals; both now
   import the constant. Value unchanged. Full suite re-run confirms no importer
   broke.

2. **[NIT] Removed the dead `forkDegrade` write inside `emitForkDegrade`**
   (subagents.ts). The assignment `forkDegrade = { modelReason, devReason, tone }`
   there was never read after the emit — the only reader (the `else` branch that
   calls `emitForkDegrade(forkDegrade!.…)`) runs BEFORE the write. The branch-set
   carrier (the gate/nested/no-transcript/SDK/fork-spawns-fork sites) still reaches
   the consuming site correctly; behavior unchanged.

3. **[NIT] Made the defensive fork branch's badge honest** (subagents.ts, the
   "unreachable" `isFork && !forkSession` case in the session-manager stage). It
   flipped `isFork=false` and emitted a degrade but left `agent` as the fork agent,
   so the badge would read `Agent(fork)` while the footer said fresh. Now mirrors
   the forkFrom-throw path: `agent = resolveAgent(builtins, "general-purpose") ?? agent`.

4. **[SHOULD] Added a background-surface footer test** (test/fork-inheritance.test.ts).
   Dispatches `subagent_type:"fork"` with `CLAUDE_CODE_FORK_SUBAGENT=0` and
   `run_in_background:true`, waits for `registry.wait(taskId)`, then reads the
   settled `TaskOutput` result and asserts `details.diagnostics` carries the
   `FORK_DEGRADE_PREFIX` message — proving the footer reaches the BACKGROUND surface
   too (previously only the synchronous path was tested). Uses the shared constant
   in the assertion.
   - Decision: did NOT assert `details.agent === "general-purpose"` on the
     background surface. Unlike the synchronous path (where `details.agent` is the
     final `result.agentName`), the background `details.agent` is the eagerly-captured
     requested TYPE ("fork") by design (`task.agentType`). Fixing that background-badge
     honesty is out of scope for these close-review items (fix 3 was scoped only to
     the synchronous defensive branch). Documented inline in the test.

5. **[NIT] Asserted the fork-spawns-fork degrade tone is calm/`info`**
   (test/fork-nested-guard.test.ts, "cannot spawn another fork" test) — looks up the
   degrade diagnostic object and asserts `severity === "info"` (by-design refusals
   are toned calmly).

6. **[NIT] Env save/restore consistency** — both test/fork-inheritance.test.ts and
   test/fork-nested-guard.test.ts previously only `delete`d `CLAUDE_CODE_FORK_SUBAGENT`
   in `afterEach`. Now a `beforeEach` saves the prior value and `afterEach` restores
   it (`prev === undefined ? delete : restore`), matching test/runtime-core.test.ts.

## Verification

- `npm run typecheck`: clean.
- Full suite (`npx vitest run`): 1114 passed / 16 skipped / 0 failed (baseline 1113
  + the new background-surface test). The `hook-runner-parallel` timing flake did
  not fire this run.

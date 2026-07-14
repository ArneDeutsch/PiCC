# F13 Review: Scope subagent TaskOutput/TaskStop to the dispatcher's own tasks

## Outcome

Shipped as planned across three tasks: t01 added `BackgroundTaskRecord.owner` and
a live-delegating `scopedTo(ownerId)` view (retyping the `TaskOutput`/`TaskStop`
factories and `unknownIdError` to a minimal `BackgroundTaskView` interface); t02
threaded the dispatcher's runtime-minted `agentId` through `customToolsFor` so a
subagent's tools are scoped to — and its started tasks tagged with — that one id;
t03 corrected the capability registry to the honest scoped behavior. A subagent's
`TaskOutput`/`TaskStop` now reach only tasks it directly dispatched; sibling and
coordinator tasks are refused indistinguishably from an unknown id, with no
foreign read or side effect. The coordinator retains full session-wide reach.

The only deviation from the original ticket was a **scope refinement forced by the
Phase-4 parity check**: the ticket proposed *hiding* `TaskOutput` from subagents
"to match Claude." That premise was refuted — Claude *inherits* `TaskOutput`/
`TaskStop` into subagents; the "hidden" behavior is a filed Claude bug
(#15098/#23154), and hiding would strand a subagent that backgrounds a nested
dispatch. So the feature keeps both tools and scopes them, and the registry states
an honest hardening (stricter than Claude only on the #15098 coordinator-passed-id
edge) rather than a blanket "non-divergent" claim. The user ratified this at plan
approval.

## Planning errors & spec gaps

- **The plan review caught a red test the initial specs missed.** A content
  assertion added by F02 t07 (`test/registry.test.ts:237-238`) *positively*
  required the exact false strings this feature removes ("session-wide", "hides
  TaskOutput from subagents"); the test file was in no task's writable surface.
  The docs plan-reviewer flagged it as a MUST-FIX and t03 was amended. Lesson: a
  truthfulness fix can be blocked by a test that locked the untruth — grep tests
  for *positive* assertions on any wording you intend to delete.
- **`unknownIdError` retype was under-specified initially.** Retyping only the two
  factory params to `BackgroundTaskView` leaves `unknownIdError` (called from both
  bodies) on the concrete class — a typecheck failure whose tempting "fix" (close
  over the full registry) would reopen the leak. The coder/security/generalist
  plan reviewers all flagged it; t01's spec was amended to require the retype
  explicitly. The scoped view design made the non-leak property fall out for free
  once this was pinned.
- **A required-after-optional parameter trap.** Inserting `ownerAgentId` into
  `customToolsFor` after the optional `subCwd` would be a TS error; the plan review
  pinned the ordering (insert before `subCwd`) so t02 didn't discover it by
  compile failure.

## Friction

- **Line-number references in comments and specs rot fast.** t02's own wiring
  shifted t01's cited lines (mint 559→577, call 913→934, start 1524→1571) within a
  single task; several code comments and one test-header comment needed correcting
  to symbol references. Specs and comments should cite symbols/functions, not raw
  line numbers.
- **Environment (worktree):** coordinator-supplied *absolute* spec paths under the
  main repo root 404 for subagents — the plan docs live only on the feature branch
  in the worktree. Dispatch prompts must use worktree-rooted paths.
- **Environment (Windows shell):** heredoc-append to a file via the Bash tool
  failed on quoting under PowerShell/Git-Bash; Edit-tool fallback worked.

## Bugs discovered

- **Pre-existing (F04, not F13): coordinator `Agent` tool passes `label` into
  `start()`'s `agentType` position** (`subagents.ts` coordinator dispatch vs the
  `start(label, promise, abort?, agentId?, agentType?, owner?)` signature). Noticed
  by the parity close-reviewer while confirming F13's 6th-positional `owner` lines
  up. Not a parity regression from F13 and out of scope here; worth a separate look
  to confirm `agentType` was meant to carry the resolved agent type, not the label.

## Improvement opportunities

- **A first-class injectable-SDK test seam on `picc()`** would remove the mild
  "test code in shipping code" smell of `setSdkForTest` + the widened `onWired`, if
  more offline-dispatch integration tests accrue. The current seam is the
  lowest-cost faithful route and is production-unreachable, but it is a hook on a
  production class.
- **Canonical non-leak assertion pattern** (worth reusing project-wide): the
  "Unknown task_id" error echoes the *queried* id (caller's own input, not a leak),
  so assert the non-leak contract on the "Known background tasks:" list segment and
  by comparing a foreign-id refusal against a never-issued id — not on the echoed
  id.
- **When a defense-in-depth branch sits behind an earlier guard, test it
  directly.** The scoped `stop()` foreign no-op was never exercised through the
  tool (which short-circuits at `get()`); a direct unit test was added so a
  regression that delegated to `registry.stop(foreignId)` fails loudly.

## Proposed follow-ups

1. **Investigate the F04 `agentType`=`label` mapping** in the coordinator's
   background `start()` call — confirm whether the task record's `agentType` should
   carry the resolved agent type rather than the display label, and fix if so.
2. **Consider a first-class `picc({ sdk })` injection seam** to retire
   `setSdkForTest`/`onWired`-widening if offline-dispatch tests grow.
3. **Optional stricter isolation of the task-id counter** — per-owner id namespaces
   would remove the residual monotonic-counter *count* leak, but at the cost of
   Claude's sequential `task-N` id parity; currently an accepted, documented
   residual, not worth the parity cost unless the count signal ever matters.

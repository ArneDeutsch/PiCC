# F13 Observations

Running record of friction, bugs, and opportunities seen during the build. Raw
material for review.md — dated bullets, one line each.

## t01 — Registry ownership + scoped view

- 2026-07-14 — Friction (environment): coordinator-supplied **absolute** spec
  paths under the *main* repo root 404 for a subagent — the plan docs exist only
  on the feature branch checked out in the worktree. Recurring worktree-vs-main
  path trap; dispatch prompts should always give worktree-relative or
  worktree-rooted paths. (coder + implementer)
- 2026-07-14 — Friction (tooling): heredoc append to a file via the Bash tool
  failed on quoting under PowerShell/Git-Bash; Edit-tool fallback worked. Recurring
  Windows shell gotcha for implementers.
- 2026-07-14 — Design note: `start()` gained ownership as a 6th positional
  `owner?` (not an options bag), keeping all 5 existing positional callers
  untouched. Clean, but the positional arg list is getting long — if a 7th datum
  is ever needed, converting to an options bag is the moment.
- 2026-07-14 — Test-teeth gap caught in review: the tool short-circuits at
  `get()`, so the scoped view's own foreign `stop()` branch was never exercised by
  any tool-driven test; a regression delegating to `registry.stop(foreignId)`
  would have passed silently. Added a direct `scopedTo().stop(foreignId)` unit
  test. Lesson: when a defense-in-depth branch sits behind an earlier guard, test
  it directly, not only through the guarded path.
- 2026-07-14 — Hardening applied from review: `BackgroundTaskRecord.owner` marked
  `readonly` so a foreign task can never be mutated into an own task mid-flight.

## t02 — Thread ownership through dispatch

- 2026-07-14 — Canonical non-leak assertion pattern (reusable): the "Unknown
  task_id" error echoes the *queried* id back — that echo is the caller's own
  input, NOT a leak. Assert the non-leak contract on the **"Known background
  tasks:" list segment** (only own ids) and by comparing a foreign-id refusal
  against a never-issued id (`task-99999`) yielding an identical known-list — a
  foreign task's existence is then unobservable. Both t01 and t02 converged on
  this after an initial wrong `not.toContain(queriedId)` cut.
- 2026-07-14 — A production test-seam was needed for a faithful integration test:
  `SubagentRuntime.setSdkForTest()` + widening `onWired` to expose the runtime, so
  the test drives a REAL offline dispatch (owner minted by the runtime, tools
  captured from the runtime) instead of the forbidden test-supplied-owner
  shortcut. Reachable only via the in-process `testSeam` arg. Mild "test code in
  shipping code" smell, but the lowest-cost faithful route and consistent with the
  existing `PiccTestSeam` pattern. Opportunity: a first-class injectable-SDK seam
  on `picc()` would remove the smell if more offline-dispatch tests accrue.
- 2026-07-14 — Friction: line-number references in code comments rot fast — t02
  wiring shifted t01's cited lines (mint 559→577, call 913→934, start 1524→1571)
  within one task. Fixed the drifted comments to symbol references in review.
  Task specs should cite symbols/functions, not just line numbers, for the same
  reason.
- 2026-07-14 — Deliberately dropped a review NIT (TaskStop own-reach in the
  integration test): stopping subagent1's own task would corrupt the later
  own-reach/coordinator-full-reach assertions on that same task, and scoped
  TaskStop own-reach is already covered at the unit layer in t01 (both tools share
  the one `scopedTo` view). Redundant at the integration layer.

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

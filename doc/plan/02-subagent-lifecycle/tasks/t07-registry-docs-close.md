# t07: Registry truthfulness, docs, CHANGELOG

## Goal
The capability registry, generated capability matrix, docs, and CHANGELOG tell the
truth about the new subagent behavior — including surfaces we deliberately did not
build.

## Context & seams
- Registry: `src/registry/capability-registry.ts` — single source of truth, drives
  `/doctor`, the startup compat notice, and the generated `doc/supported-features.md`
  (`npm run gen:capabilities`, never hand-edit the output). Entries to touch:
  - `tool.Agent` (`:49`): reflect new failure semantics (partial+note / terminated
    error), agent IDs, progress rendering.
  - `feature.background-agents` (`:230`): currently `partial` "no push, stop is
    cooperative" — update for settlement push (t05) and abort semantics (t01).
  - **`tool.SendMessage`: add an entry — its current absence is untruthful by
    omission** (subagent resume/steer scope from t04; agent-teams messaging stays
    explicitly out, consistent with the teams exclusion at `:107`).
  - `tool.TaskOutput`/`tool.TaskStop` (`:76-77`): failed-status reporting, notices,
    and TaskStop's "stopped, result discarded" contract labeled as PiCC-defined
    (Claude Code leaves it undocumented).
  - **`agent.frontmatter.background`: add an entry** (honored since t05) — currently
    missing entirely, same untruthful-by-omission class as SendMessage; note Claude's
    2.1.198 background-by-default on `tool.Agent` (PiCC defaults foreground).
  - `hook.event.SubagentStart`/`SubagentStop` (`:93-94`): payloads now carry
    `agent_id` + the subagent's own transcript path (t02).
  - `setting.cleanupPeriodDays` (`:130`): if t02 shipped without transcript cleanup,
    tag it `partial` naming the gap.
  - `hook.event.Notification` (`:105`): update only if t05 wired `agent_completed`;
    otherwise confirm the "parsed, never fired" note survived.
  - SendMessage tier is `partial` at best: name the gaps — no cross-restart resume,
    settlement notices bounded, idle-parent delivery at next turn only, and steering
    reaches only *background* dispatches (a foreground Agent call blocks the parent's
    turn — t04). The user guide states the same limitations.
  - Audit intra-2.1.x version sensitivity: the parity investigation found these
    semantics changed at 2.1.198/199/200/205 — the registry pins `claude-code-2.1.x
    (mid-2026)` (`:19`); note the sub-version where an entry depends on it.
- Docs: `doc/architecture.md` describes the dispatch contract but not the error
  contract — add it (outcome classification, partial output, abort). `doc/user-guide.md`
  gains the observability story (transcript location, progress display, usage
  breakdown, SendMessage). `README.md` feature bullets if user-visible enough.
- CHANGELOG (`Keep a Changelog`, `[Unreleased]`): the empty-success bug fix is the
  headline (reference the 2026-07-12 dogfooding incident), then observability/channel/
  usage as Added.
- Cross-check each claim against the *implemented* behavior of t01–t06, not the plan.

## Writable surface
`src/registry/capability-registry.ts`, `src/registry/compat-report.ts` (only if entry
shape requires), `doc/supported-features.md` (generated only),
`doc/architecture.md`, `doc/user-guide.md`, `README.md`, `CHANGELOG.md`,
`test/registry.test.ts`, `doc/plan/02-subagent-lifecycle/log/t07.md`.

## Approach constraints
- Never hand-edit `doc/supported-features.md`; regenerate.
- Registry tags follow the project's tier definitions (full/partial/degraded/not-supported)
  — when in doubt, undersell.

## Left open
- Exact tier judgments (e.g. is settlement push `full` or `partial` vs Claude's
  behavior?) — decide against the shipped code and Claude's documented semantics.

## Testing
`test/registry.test.ts` updated for new/changed entries; `npm run gen:capabilities`
produces a clean diff that is committed — consider a doc-freshness test that
regenerates to a temp file and diffs (mind CRLF normalization on Windows); grep sweep
for stale claims about subagents in README/doc (e.g. "no way to observe subagents",
"one-shot dispatch documented", the `src/index.ts:579-580` comment claiming subagents
can only poll/stop their own tasks).

## Acceptance criteria
- [ ] Registry entries for Agent, background-agents, SendMessage, TaskOutput/TaskStop match shipped behavior.
- [ ] `doc/supported-features.md` regenerated; architecture/user-guide/README/CHANGELOG updated.
- [ ] No stale subagent claims left in docs.
- [ ] typecheck and full test suite green (flake policy per feature.md).

## Depends on
t01, t02, t03, t04, t05, t06

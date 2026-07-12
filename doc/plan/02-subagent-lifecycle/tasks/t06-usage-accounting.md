# t06: Per-subagent usage accounting

## Goal
Each subagent's token/cost usage is recorded with its dispatch result and visible to
the human — in the tool result details, the task record, and the session's usage
surface — instead of being silently dropped.

## Context & seams
- Pi already measures everything: every `AssistantMessage` carries `usage`
  (input/output/cache tokens + cost, `pi-ai/dist/types.d.ts:245-269`), and the session
  aggregates via `AgentSession.getSessionStats(): SessionStats`
  (`pi-coding-agent/dist/core/agent-session.d.ts:593`, shape `:150-167`). PiCC reads
  none of it.
- Seam (contract shared with t01/t02): capture `getSessionStats()` **after the last
  `prompt()` and before the result is constructed/returned** — the result literals are
  built in the try block (`subagents.ts:584`), so a finally-side capture has nowhere
  to attach; thread the stats into the result (mutable local or capture-then-build).
  `DispatchResult` gains
  `usage?: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }`
  (numbers; omit what Pi doesn't provide rather than inventing zeros). Mirror on
  `BackgroundTaskRecord`/`BackgroundResultLike`. Extend the structural `PiSession`
  interface optionally (fakes may omit it → usage undefined, no crash). Pin
  `getSessionStats`/`SessionStats` in `test/pi-contract.test.ts`. Failed/aborted runs
  report their partial usage when Pi provides it — that answers "what did the failure
  cost me".
- Human-visible surfaces:
  1. Tool result `details` (foreground) and TaskOutput text (background) include a
     compact usage line.
  2. The dispatch registry (t04 — now a declared dependency) answers "what did my
     subagents cost this session" — expose an aggregate through the existing PiCC
     control-command surface (definition site `src/index.ts:1068-1213`, house style
     `/agents`, `/doctor`; the user explicitly noted the existing usage surface is
     unhelpful, so a per-subagent breakdown is the value). List each agent's ID, type,
     outcome, usage, **and transcript path** — one place a human can actually look
     (complements t03's renderResult).
  3. t03's renderResult (mandated there) shows the usage line too.
- Context note: parent-side *summing into Pi's own /usage output* may not be reachable
  from an extension — if so, the control-command breakdown is the deliverable; note it
  in the log, don't fight Pi.

## Writable surface
`src/runtime/subagents.ts`, `src/runtime/background-tasks.ts`, `src/index.ts`
(control-command surface), `test/runtime-core.test.ts`,
`test/background-tasks.test.ts`, `test/pi-contract.test.ts`, `test/helpers/`
(fake-builder extension), new `test/subagent-usage.test.ts` if cleaner,
`doc/plan/02-subagent-lifecycle/log/t06.md`.

## Approach constraints
- Usage is metadata: `details`/records/commands only, never mixed into `finalMessage`.
- Fakes without stats must keep working (optional-method tolerance).

## Left open
- Exact usage-line format and the control-command name/shape.
- Whether aborted/failed runs report their partial usage (default: yes if Pi provides
  it — that's exactly the "what did the failure cost me" question).

## Testing
Unit (shared fake builder): stats captured before result construction; absent stats →
undefined usage, no crash; mirror fields in sync; failed run carries partial usage.
Offline-integration (fake-pi harness via t05's seam): a scripted run's usage lands in
tool result details and TaskOutput text; control command lists per-subagent usage,
transcript paths, and a total.

## Acceptance criteria
- [ ] Every dispatch result carries usage when the session provides stats.
- [ ] The human can see per-subagent usage and a session total via the control surface.
- [ ] typecheck and full test suite green (flake policy per feature.md).

## Depends on
t01, t02, t04 (the dispatch registry it aggregates from), t05 (the test seam)

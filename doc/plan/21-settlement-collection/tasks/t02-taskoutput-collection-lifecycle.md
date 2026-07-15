# t02: Collection-aware TaskOutput lifecycle

## Goal

A TaskOutput call that successfully returns a terminal task record marks that exact task generation as collected, so the real next-turn drain emits no stale retrieval notice.

## Context & seams

`createTaskOutputTool()` in `src/runtime/background-tasks.ts` already waits or polls through a `BackgroundTaskView`, then builds its result from the final observed task status. Use t01's owner-safe collection transition immediately before returning a terminal tool result.

A call counts as collection when the returned status is completed, failed, or stopped. This includes empty successful output, all available failed partial output, stopped/discarded outcomes, and cut-off subagent output: `truncated` means the subagent run ended at its output limit, while TaskOutput still returns the complete stored terminal record and repeating TaskOutput cannot recover missing continuation. A running `wait:false` poll, an aborted wait that returns running status, an unknown/foreign task, or an execution that throws before returning does not collect. A `wait:false` call made after settlement returns a terminal record and therefore counts.

The production `before_agent_start` drain in `src/index.ts` must honor t01's final validity check immediately before sending a selected notice, with no await before send/commit. Existing per-notice error isolation and commit-after-success behavior remain intact. Extract a focused delivery helper or provide an equally deterministic test seam so the real sender's use of validity is proved, not merely the registry API.

An uncollected stopped task still emits its one outcome notice, but `buildSettlementNotice()` must not tell the coordinator to retrieve a “full result” that TaskStop deliberately discarded. Give that outcome-only notice explicit no-result-retained guidance. A later terminal TaskOutput still counts as collection and suppresses the notice normally.

The exact issue regression must traverse real wiring offline: inject the fake SDK through `onWired`, dispatch through the registered `Agent` tool, await through the registered `TaskOutput` tool, and then fire the real `before_agent_start` handler. Directly seeding a background record is insufficient for this headline test.

## Writable surface

- `src/runtime/background-tasks.ts`
- `src/index.ts`
- `test/background-tasks.test.ts`
- `test/integration-extension.test.ts`
- `test/sendmessage.test.ts`

## Approach constraints

- Construct the complete return object first, then mark the terminal task collected immediately before returning it.
- Treat every successfully returned terminal task record, including cut-off output and stopped outcomes, as collected.
- Preserve TaskOutput text, details, rendering, live progress, abort cleanup, usage, and transcript behavior byte-for-byte except for the new delivery side effect. Settlement-notice wording changes only for the stopped outcome's impossible retrieval instruction.
- Preserve full/scoped TaskOutput authorization and non-leak behavior.
- No timers or live-network tests; use deferred promises and the existing fake-Pi/offline runtime seams.
- Keep the broad outcome/race matrix at unit level; use offline integration only for real Agent/TaskOutput/next-turn wiring, real sender validity, and real SendMessage resume generation.

## Left open

- Exact helper extraction for the real delivery loop.
- Which existing persisted-resume fixture is extended, provided a real `SendMessage` creates the tested generation.

## Testing

Unit coverage in `test/background-tasks.test.ts`:

- running TaskOutput wait → settlement → terminal return → next drain empty;
- already-settled terminal return and `wait:false` after settlement → next drain empty;
- running `wait:false` poll → settlement without collection → one bounded notice, then none;
- aborted waiting call returning running status leaves the eventual notice eligible;
- completed (including empty), failed (with and without partial output), stopped, and cut-off terminal retrieval suppression;
- deferred wait → TaskStop → underlying abort settlement → stopped TaskOutput return → no notice;
- TaskStop without subsequent TaskOutput → one stopped outcome notice with no instruction to retrieve a discarded result, then none;
- unknown and foreign scoped TaskOutput failures do not mutate eligibility;
- a deterministic pre-return failure such as throwing `onUpdate` leaves the eventual settlement eligible;
- registry-miss early failure collection suppression;
- repeated/concurrent TaskOutput collectors remain idempotent;
- two independent settled tasks where one is collected and only the other is notified.

Offline-integration coverage:

- registered Agent dispatch → registered TaskOutput wait → real next-turn handler emits no stale notice, then remains empty;
- the real delivery sender selects a notice, collection invalidates it before send through a barrier/helper seam, `pi.sendMessage` is not called, and later turns remain empty;
- real persisted `SendMessage` resume: original collected then resumed-uncollected emits the resumed result once; resumed collection suppresses that generation; late original collection cannot suppress the resumed result.

## Acceptance criteria

- [ ] Every successfully returned terminal TaskOutput record suppresses only a not-yet-delivered notice for that task generation.
- [ ] Polling, aborted waits, unknown/foreign access, and failed tool execution do not prematurely suppress eventual delivery.
- [ ] Fresh, failed, stopped, cut-off, resumed, newest-resume-wins, registry-miss, scoped-owner, mixed-task, and deterministic race paths retain correct exactly-once behavior; stopped-only notices contain no impossible retrieval instruction.
- [ ] The issue sequence “dispatch → await with TaskOutput → next user turn” traverses real registered tools and has no stale notice.
- [ ] The production sender's final validity check is covered directly.
- [ ] typecheck and full test suite green

## Depends on

t01

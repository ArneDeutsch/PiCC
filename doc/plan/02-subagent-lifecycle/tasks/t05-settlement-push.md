# t05: Background settlement visible without polling

## Goal
When a background subagent task settles (completed, failed, aborted), the coordinator
learns about it at its next opportunity without calling TaskOutput — outcome, error,
and the agent ID named, last/partial output excerpted. The delivery is
transcript-visible and clearly framed as untrusted agent output.

## Context & seams
- Today settlement only updates the record (`src/runtime/background-tasks.ts:60-86`);
  the model must poll TaskOutput (`:150-183`). t01 classifies settlement; t02 gives it
  an agent ID; this task delivers it.
- **Delivery vehicle**: prefer the message-level channel PiCC already uses — the guard
  injects context via `pi.sendMessage(..., { deliverAs: "steer" })`
  (`src/runtime/guard.ts:134-142`, wired at `src/index.ts:762-769`) — because it lands
  in the transcript like Claude's settlement message. System-prompt splicing
  (`before_agent_start`, `src/index.ts:779-798`) is the fallback only if message
  delivery proves unreliable in the harness, and it must then carry the same
  untrusted-content framing; document whichever is chosen.
- **Honest limitation (state it, don't hide it)**: PiCC delivers at the parent's next
  turn. An idle coordinator (turn ended, waiting for user input) learns of settlement
  only when the conversation continues — Claude Code re-invokes the agent; PiCC v1
  does not. This goes into the user guide and the t07 registry note (`partial`, gap
  named). If the chosen vehicle can wake an idle parent reliably, better — but do not
  build new machinery for it in this task.
- **Notice content**: task id, **agent id**, label, outcome (notice text uses the
  outcome vocabulary — an aborted run's notice says "aborted", even though the
  background *status* is `"stopped"` per t01's mapping), error (t01's capped string)
  if failed, and a bounded excerpt of final/partial output — long outputs point
  to TaskOutput/the transcript. The excerpt is **explicitly delimited and labeled as
  the agent's output, not instructions** (untrusted-content framing — it is
  model-steerable text being moved into a privileged channel). Exactly-once per
  settlement (dedup in the registry); notices are in-memory — if the user quits before
  the next turn, the transcript is the record (do not overclaim in docs).
- Honor the `background: true` agent-frontmatter field while in this subsystem
  (Claude 2.1.198 semantics: forces background dispatch) — parse + route through the
  existing `run_in_background` path; registry entry lands in t07. Optionally fire the
  hook-runner's `Notification` event (`agent_completed`) at settlement if trivially
  wireable — else leave the registry note as-is.
- **Test seam (plan-review MUST-FIX)**: the fake-pi harness cannot reach the
  closure-local registry/runtime (`src/index.ts:564-595` + `loadRealSdk`), so the
  promised offline-integration test needs a named seam: add a test-only injection
  point on the extension entry (e.g. an optional overrides argument to `picc(pi)` or
  an exported factory the tests compose) — design it minimally, document it in the
  log, and update `test/helpers/fake-pi.ts` accordingly. **The seam must be reachable
  only via an in-process argument or exported factory — never via environment
  variables, settings, or file paths** (an env/settings-gated seam would be a
  project-reachable runtime-swap bypass). Do not silently demote the test to unit
  level: the injection vehicle IS the thing under test.
- `BackgroundTaskRecord` gains the settled-notice state it needs (mirror rules from
  t01 apply).

## Writable surface
`src/runtime/background-tasks.ts`, `src/runtime/subagents.ts` (frontmatter honor +
queue if it lives with the registry), `src/index.ts` (wiring + test seam),
`src/claude/agents.ts` (parse `background` frontmatter only),
`test/background-tasks.test.ts`, `test/integration-extension.test.ts`,
`test/helpers/fake-pi.ts`, `test/agents.test.ts` (frontmatter),
`doc/plan/02-subagent-lifecycle/log/t05.md`.

## Approach constraints
- Exactly-once delivery per settlement; generation while mid-turn delivers next turn.
- Bounded notice size; never a full transcript in context.
- Notices are metadata about agents — they never execute or approve anything.

## Left open
- Notice wording/format (within the framing constraints).
- Whether foreground dispatches also emit a redundant notice — default no.
- The test seam's exact shape (minimal, documented).

## Testing
Unit: queue/dedup (settle → one pending notice; drain → empty; double-settle
impossible); notice content includes agent id + capped error; excerpt bounding.
Offline-integration (via the new seam, in `test/integration-extension.test.ts`):
background task settles between turns → next model request contains the notice with
outcome/error/agent-id; completed vs failed vs stopped shapes; exactly-once across
multiple turns. Frontmatter: `background: true` agent dispatches background without
`run_in_background`. Regression with t01: rate-limit settlement produces a *failed*
notice.

## Acceptance criteria
- [ ] A settled background task is announced to the model without TaskOutput, exactly once, with outcome, error, and agent ID.
- [ ] The notice is transcript-visible and framed as untrusted agent output.
- [ ] The idle-parent limitation is documented (user guide + registry note in t07).
- [ ] `background: true` frontmatter honored.
- [ ] typecheck and full test suite green (flake policy per feature.md).

## Depends on
t01, t02

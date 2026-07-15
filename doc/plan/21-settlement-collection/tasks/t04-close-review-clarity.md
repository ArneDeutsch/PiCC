# t04: Close-review settlement clarity

## Goal

Close-review gaps are resolved so uncollected cut-off tasks, TaskOutput's own guidance, stopped-task terminology, and support-tier summaries all state the shipped delivery contract without contradiction.

## Context & seams

F21 already treats every terminal TaskOutput return, including cut-off output, as collection. `buildSettlementNotice()` still needs to distinguish two independent conditions for an uncollected task: the subagent run itself ended at its output limit (`task.truncated`), and the bounded settlement notice may excerpt only part of the retained output. A cut-off run must not be presented as an ordinary complete result or told that another TaskOutput can recover a missing continuation. TaskOutput or the transcript may expose all retained output, while resuming/re-dispatching is required for further work.

The TaskOutput tool description should state its own delivery side effect: a terminal return suppresses a pending notice, while a running poll preserves notice eligibility. README and still-Unreleased CHANGELOG language must reserve “collection” for terminal TaskOutput, not TaskStop. The user guide must not call all `Task*` tools full now that TaskOutput and TaskStop are partial, and an older identity-only paragraph must not claim settlement delivery is unchanged by F21. One remaining resume comment must describe the agent-level readiness gate rather than an unconditional notice.

The real-Pi live e2e requested by one close reviewer is deliberately not added: the existing offline integration traverses registered Agent and TaskOutput tools plus the real `before_agent_start` handler, while the live suite would duplicate that behavior with slower process-level machinery.

## Writable surface

- `src/runtime/background-tasks.ts`
- `src/runtime/subagents.ts` (comment only)
- `README.md`
- `CHANGELOG.md`
- `doc/user-guide.md`
- `test/background-tasks.test.ts`
- `doc/plan/21-settlement-collection/log/t04.md`

## Approach constraints

- Preserve bounded/untrusted notice framing and existing terminal TaskOutput content/details.
- Distinguish task-output cut-off from notice-excerpt truncation in model-facing wording.
- Do not imply TaskOutput or the transcript can recover a continuation the subagent never produced.
- Do not change TaskStop behavior; only correct terminology.
- Do not expand compatibility-report behavior or add live-process tests.

## Left open

- Exact concise cut-off header and guidance wording.
- Whether the explicit cut-off explanation is one line or split between header and footer.

## Testing

- Unit-test an uncollected cut-off task whose retained output fits the notice and one whose notice excerpt is also truncated.
- Assert the notice names the run cut-off, distinguishes excerpt truncation, and never promises TaskOutput can recover missing continuation.
- Pin the TaskOutput tool description's terminal-collection and running-poll wording.
- Run typecheck and full suite.

## Acceptance criteria

- [ ] Uncollected cut-off notices distinguish run cut-off from bounded notice excerpting and provide truthful next actions.
- [ ] TaskOutput's own description states terminal-collection suppression and running-poll preservation.
- [ ] README, CHANGELOG, user guide support tiers, and contributor comments no longer contradict F21.
- [ ] Existing lifecycle behavior and notice security framing remain unchanged.
- [ ] typecheck and full test suite green

## Depends on

t03

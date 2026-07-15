# F21 Observations

- 2026-07-15 — A per-notice reverse scan made the first generation-validity design O(n²) across a drain; review replaced it with an O(1) newest-task index and added authoritative-agent-id correction coverage.
- 2026-07-15 — Shared agent-level readiness could make task-local delivery tests pass vacuously; meaningful assertions need an always-armed gate plus explicit task-local state checks.
- 2026-07-15 — Retry tests must commit the newly selected retry notice, not a stale closure from the failed attempt, to verify each selection carries correct validity and commit behavior.
- 2026-07-15 — Structural test/diagnostic records are constructed outside `BackgroundTaskRegistry.start()`, so task-local delivery state remains optional at the public record shape while registry-created records initialize it explicitly.
- 2026-07-15 — A headline integration can traverse real registered tools yet still miss the intended runtime injection seam; the regression now injects through `onWired().subagentRuntime.setSdkForTest()` explicitly.
- 2026-07-15 — Parameterized empty-output checks need exact equality because `toContain("")` is vacuous.
- 2026-07-15 — Stopped tasks discard the final result but may retain a useful transcript, so outcome-only notices must distinguish unrecoverable final output from surviving session history.
- 2026-07-15 — Plan review initially preserved `tool.TaskOutput: full`, but external reporter evidence showed Claude `block`/`timeout` inputs versus PiCC `wait`; truthful capability review must verify the whole existing schema, not only the feature's changed behavior.
- 2026-07-15 — Settlement promises existed in always-injected model guidance and contributor comments beyond the obvious user docs/registry rows; contract audits need source-wide wording searches.
- 2026-07-15 — Bare `#N` references to external-repository evidence are ambiguous in repository Markdown; use `owner/repo#N` for cross-repo provenance.
- 2026-07-15 — Older entries under a still-Unreleased CHANGELOG can contradict current behavior even when the newest entry is correct; historical states need explicit supersession wording.
- 2026-07-15 — A cut-off task and a bounded notice excerpt are independent truncation events; model guidance must distinguish retained output from a continuation the subagent never produced.
- 2026-07-15 — User-guide tier summaries built from broad families such as `Task*` can silently contradict the generated per-tool capability matrix.
- 2026-07-15 — Pre-existing follow-up: settlement frame-marker defanging runs its regex before the 1,200-character cap and may show superlinear behavior on adversarial long lines.
- 2026-07-15 — Pre-existing follow-up: project compatibility findings ignore `partial` capabilities, so the newly documented TaskOutput `block`/`timeout` schema gap is not surfaced by startup or `/doctor`.

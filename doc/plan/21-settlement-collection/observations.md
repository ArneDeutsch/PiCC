# F21 Observations

- 2026-07-15 — A per-notice reverse scan made the first generation-validity design O(n²) across a drain; review replaced it with an O(1) newest-task index and added authoritative-agent-id correction coverage.
- 2026-07-15 — Shared agent-level readiness could make task-local delivery tests pass vacuously; meaningful assertions need an always-armed gate plus explicit task-local state checks.
- 2026-07-15 — Retry tests must commit the newly selected retry notice, not a stale closure from the failed attempt, to verify each selection carries correct validity and commit behavior.
- 2026-07-15 — Structural test/diagnostic records are constructed outside `BackgroundTaskRegistry.start()`, so task-local delivery state remains optional at the public record shape while registry-created records initialize it explicitly.
- 2026-07-15 — A headline integration can traverse real registered tools yet still miss the intended runtime injection seam; the regression now injects through `onWired().subagentRuntime.setSdkForTest()` explicitly.
- 2026-07-15 — Parameterized empty-output checks need exact equality because `toContain("")` is vacuous.
- 2026-07-15 — Stopped tasks discard the final result but may retain a useful transcript, so outcome-only notices must distinguish unrecoverable final output from surviving session history.

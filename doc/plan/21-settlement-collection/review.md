# F21 Review: Collected Task Settlement Delivery

## Outcome

F21 fully delivers ArneDeutsch/PiCC#45. A successfully returned terminal `TaskOutput` record now marks that exact task generation collected, and the next-turn drain suppresses its pending stale notice. Running polls preserve eligibility; eligible uncollected latest generations still receive one bounded notice. The implementation preserves failure retry, registry-miss fallback, owner scoping, concurrent collection, stopped outcomes, and newest-generation resume semantics. Close review added truthful cut-off/aborted guidance and corrected capability/documentation inconsistencies. The plan expanded by one close-review task, and `tool.TaskOutput` moved from the initially planned `full` tier to `partial` after external evidence exposed its pre-existing `wait` versus Claude `block`/`timeout` schema gap.

## Planning errors & spec gaps

- The first delivery-validity design performed a reverse task scan per selected notice, making a full drain O(n²). Review replaced it with an O(1) newest-task index and explicit identity-correction coverage.
- The initial plan preserved `tool.TaskOutput: full` by considering only F21's lifecycle change. Review correctly widened the audit to the whole existing tool schema and found the pre-existing input mismatch.
- The initial documentation task missed always-injected model guidance, contributor lifecycle comments, stale historical text inside the still-Unreleased CHANGELOG, and broad `Task*` support summaries.
- Cut-off terminal retrieval was handled, but the plan initially missed the distinct uncollected cut-off-notice journey. Close review added a fourth task to distinguish subagent output-limit cut-off from bounded notice excerpting.
- Stopped records can retain a transcript and can settle with a stale `truncated` flag after cooperative stop; both edge cases were found only during review.

## Friction

- The bug reproduced itself throughout the feature: every collected reviewer result generated a later stale settlement notice, producing substantial duplicate context.
- Several tests initially passed for the wrong reason: the shared agent gate masked task-local bugs, an empty-string containment assertion was vacuous, and a retry test committed the original selection instead of the retry selection.
- Generated capability output is deterministic but rewrites on every run and emits recurring Windows LF/CRLF warnings.
- Cross-repository evidence was initially written as bare issue references, which would resolve ambiguously in PiCC Markdown.
- The close-review proposal gate produced fast, polished-looking assessments that were not source-grounded, requiring transcript inspection to distinguish formatting quality from investigative depth.

## Bugs discovered

- **Pre-existing, unfixed:** settlement frame-marker defanging applies its regex before the 1,200-character output cap; adversarial long lines can exhibit superlinear processing.
- **Pre-existing, unfixed:** startup and `/doctor` compatibility findings ignore `partial` capabilities, so projects can receive an all-clear despite the TaskOutput schema gap.
- **Workflow bug, unfixed:** proposal-gate asks one sandbox evaluator to score supplied proposal prose but does not require source, test, architecture, documentation, or existing-issue investigation. The three F21 proposal evaluators made zero tool calls and used only 60–88 reasoning tokens, so their assessments are not reliable evidence of proposal value.

## Improvement opportunities

- Keep the security-isolated L1 screen for attacker-controlled existing tickets, but separate it from trusted proposal value research.
- Require proposal evaluation to inspect relevant project architecture, source, tests, docs, and existing tracking, returning bounded evidence anchors with the rubric score; use a second adversarial pass when uncertainty or blast radius warrants it.
- Add Claude-compatible `block`/`timeout` inputs to TaskOutput while retaining `wait` compatibility, then reassess its capability tier.
- Make compatibility reporting surface relevant project-used `partial` capabilities without turning startup output into an exhaustive matrix.
- Replace or pre-bound settlement marker scanning with a demonstrably linear implementation.

## Proposed follow-ups

1. **Source-ground proposal-gate evaluations** — tracked in ArneDeutsch/PiCC#55; separate trusted proposals from attacker-content screening and require project evidence before value scoring.
2. **Claude-compatible TaskOutput wait inputs** — support `block`/`timeout` semantics alongside PiCC's `wait` input.
3. **Project-aware partial capability findings** — surface actionable partial gaps in startup and `/doctor` when the project relies on them.
4. **Linear settlement marker defanging** — preserve notice-frame hardening while bounding adversarial scan cost.

The maintainer initially declined the three proposed technical follow-up tickets, then explicitly requested the confirmed proposal-gate workflow bug be filed; it is tracked as ArneDeutsch/PiCC#55. No other follow-up issues were filed.

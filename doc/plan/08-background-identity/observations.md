# F08 Observations

- 2026-07-14 — Planning correction: all three target strings are model-visible content, so “display-only / no model-contract change” had to be narrowed to lifecycle- and schema-preserving wording.
- 2026-07-14 — Existing identity gap: requested/displayed type can differ from the resolved registry name after unknown-type fallback or case-insensitive resolution; broader identity plumbing was explicitly deferred.
- 2026-07-14 — Plan security review exposed same-line tuple spoofing risk from unconstrained project agent names; the task added delimiter encoding, minted-token neutralization, bounded atomic encoding, and fixed invalid-id fallbacks.
- 2026-07-14 — Implementation friction: initial sanitizer and length assertions assumed BEL disappeared without spacing and counted Unicode length incorrectly; focused tests corrected the expectations.
- 2026-07-14 — Review-process weakness: `git diff HEAD` omitted new untracked formatter/test/log files until the coordinator staged them; future review dispatches should require `git status --short` or stage complete task diffs first.
- 2026-07-14 — Security review proposed lexical filtering of natural-language agent names; rejected because arbitrary project names are supported and structural encoding provides a testable boundary without unreliable semantic classification.
- 2026-07-14 — Documentation review caught an easy-to-miss source distinction: TaskStop/settlement use their background task record's stored display type; fresh dispatch records normally store the requested/display label, while resumed records and acknowledgments use the resolved registry name. Stable agent id is the reliable cross-resume key.
- 2026-07-14 — Capability review required separating Claude-supported resume behavior from PiCC-defined exact wording to avoid overstating parity.
- 2026-07-14 — Close review rejected broader requested-vs-resolved identity plumbing and formatter simplification as scope expansion; canonical-type plumbing remains deferred by maintainer decision.
- 2026-07-14 — Claude-reference verification surfaced two documentation-only parity gaps: Claude 2.1.198+ TaskStop accepts agent id/name in addition to task id, and the Claude Code 2.1.x reference refuses SendMessage resume after TaskStop; PiCC currently does neither.
- 2026-07-14 — Close UX review found a broader compatibility-reporting gap: partial capabilities may not appear in startup or `/doctor` findings, allowing overly optimistic summaries; changing scan behavior is a separate cross-cutting feature.

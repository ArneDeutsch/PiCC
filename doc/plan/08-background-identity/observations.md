# F08 Observations

- 2026-07-14 — Planning correction: all three target strings are model-visible content, so “display-only / no model-contract change” had to be narrowed to lifecycle- and schema-preserving wording.
- 2026-07-14 — Existing identity gap: requested/displayed type can differ from the resolved registry name after unknown-type fallback or case-insensitive resolution; broader identity plumbing was explicitly deferred.
- 2026-07-14 — Plan security review exposed same-line tuple spoofing risk from unconstrained project agent names; the task added delimiter encoding, minted-token neutralization, bounded atomic encoding, and fixed invalid-id fallbacks.
- 2026-07-14 — Implementation friction: initial sanitizer and length assertions assumed BEL disappeared without spacing and counted Unicode length incorrectly; focused tests corrected the expectations.
- 2026-07-14 — Review-process weakness: `git diff HEAD` omitted new untracked formatter/test/log files until the coordinator staged them; future review dispatches should require `git status --short` or stage complete task diffs first.
- 2026-07-14 — Security review proposed lexical filtering of natural-language agent names; rejected because arbitrary project names are supported and structural encoding provides a testable boundary without unreliable semantic classification.

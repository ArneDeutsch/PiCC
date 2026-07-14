# F12 observations

Running record of friction, planning errors, bugs, and opportunities. Dated bullets; raw material
for review.md.

- 2026-07-14 — **Planning error (t01 size estimate).** t01 specified "exactly three reference files"
  + "phase spine stays resident" + router ≤ 20,000 (target ~14,000). Empirically infeasible: after
  faithful extraction of the 3 blocks and stripping all rationale, the resident directive bulk
  (Principles, roster, reachability gate, discipline checklist, phase-procedure trunk for Phases
  2/6/7, aborting, layout, grammar) is ~24,350 chars — 4,350 over the cap. Even moving all of Phase 9
  out reaches only ~22,300. Root cause: under-counted irreducible directive text; the 3-file
  partition has no home for path-independent phase-procedure detail. Resolution (in-vision, no
  WHAT/WHY change): authorize additional reference files for phase-procedure detail; router becomes a
  skeleton + routing. Adapted t01 (target ≤ 16,000, ceiling 18,000, extra files allowed) and t05
  (guard test count-agnostic). Lesson for future refactor planning: measure the resident floor before
  fixing a char target.
- 2026-07-14 — **t01 landed faithful (router 15,999 chars, 4 reference files).** Three-way review
  (behavior-preservation / discipline / test) all PASS. Behavior-preservation CONFIRMED: every
  directive, command, flag, decision-branch, template, and the nine rules survive verbatim; only 8
  rationale/emphasis trims in resident sections, none load-bearing. Security: nine rules byte-identical
  in ticket-integration.md, gate resident, floor 1:1, write sites fail-closed. Nice side effect noted
  by security + generalist: the always-loaded resident discipline floor is a defense-in-depth
  improvement — a compaction can no longer evict the rules entirely, which the monolith allowed.
  Coordinator applied 2 trivial NIT fixes (stale "Templates below" cross-ref; test comment precision).

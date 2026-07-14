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
- 2026-07-14 — **t02 review caught two real fork-path bugs (live-verified against gh 2.96.0).** (1)
  `gh`'s `parent` object has **no `nameWithOwner`** field (only id/name/owner.login) — the spec and
  first implementation used `target = parent.nameWithOwner`, which returns null and would have broken
  the entire fork path (every `--repo <target>` call 404s). Fixed to `parent.owner.login + "/" +
  parent.name`. (2) Bare `gh repo view` (no arg) uses gh's base-repo heuristic, which with multiple
  remotes resolves to the **upstream** and returns isFork:false — silently misclassifying a fork as a
  maintainer checkout (cli/cli#6792), the dangerous fork→maintainer direction. Fixed by enumerating
  remotes first and pinning `gh repo view <owner/repo>` per remote. Plus SHOULDs: viewerPermission must
  be read on the *target* (a fork you own is ADMIN); enum has no NONE + needs TRIAGE + nullable;
  fork fetch must not use per-worktree FETCH_HEAD (temp named remote); no-gh maintainer degrade;
  credential redaction in echoed remote URLs. **Lesson:** gh JSON sub-object field names differ from
  top-level (`parent` ≠ a Repository projection) — verify sub-fields against live gh, and never trust
  bare `gh repo view` for classification. This is why the fork half was split out as the risk-bearing task.

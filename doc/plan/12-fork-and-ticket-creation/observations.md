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
- 2026-07-14 — **t03 review: the compare URL was the single point of failure.** The whole fork hand-off
  rides on one string. Initial impl used the three-part head `<forkOwner>:<forkRepo>:<branch>...?expand=1`
  ("rename-safe" per GitHub docs for the compare *view*) — but that + `?expand=1` renders "There isn't
  anything to compare" (desktop/desktop#16269), which would dead-end every hand-off *after* the push.
  Switched to the documented two-part `<forkOwner>:<branch>?expand=1`. Lesson: a load-bearing URL in a
  prose skill has no test to catch it — verify the exact `?expand=1` PR-creation flow, not just the
  compare-view docs. Also caught: fork Phase 9 pointed at handoff.md's "the PR is already open" line
  (true for maintainer ticket path, FALSE on a fork) — fixed to REPLACE, not mirror, those next-steps;
  push-failure degrade could echo an embedded `user:token@` credential (now redacted, matching Phase 0).
- 2026-07-14 — **Router headroom watch:** after t03 the router body is 17,370 / 20,000 (2,630 left).
  Instructed t04/t05 to keep resident additions minimal and relocate into reference files. If t05's grid
  reconciliation risks the cap, relocate the resident write-discipline checklist elaboration.
- 2026-07-14 — **Phase 8 close review (5 reviewers, all PASS) caught a subtle cap bug + process residue.**
  (1) The guard test measured the RAW skill body, but the runtime truncates the SUBSTITUTED body — and
  the router used the literal `$ARGUMENTS` token 3× in prose, which the harness replaces globally. Under
  a documented long-direction invocation (`#5 also add logging …`) that multiplied the args into the
  resident body and could truncate the tail — partially reintroducing the very truncation bug F12 fixes.
  Fixed by removing all literal `$ARGUMENTS` from the router (ref now reaches via the no-marker
  append-fallback) and adding a **rendered-body** guard-test assertion. **Lesson:** for a resident skill,
  guard the *rendered* size (post-substitution), not the file size; and literal `$ARGUMENTS` in prose is
  a latent substitution/garbling bug. (2) Task-ID/"Hole D" planning scaffolding had leaked into the
  shipped reference files — scrubbed; the hole-sweep verified holes were *closed* but was never asked to
  *scrub the labels*, so it was structurally unassigned. (3) Hardened the resume anchor into an explicit
  sanitization gate (owner/repo + integer, no metacharacters) since `feature.md` is a repo-controlled
  file feeding a `gh` command line. Final router: raw 18,741 / rendered 18,907, both under 20,000.
- 2026-07-14 — **Standing constraint for future editors:** the router has ~1,100–1,300 chars of headroom
  under the 20,000-char re-injection cap. Any new resident prose must relocate an equal-or-greater donor
  into a `references/*.md` file — never cut content. The guard test (raw + rendered) enforces the cap.
- 2026-07-14 — **Phase 9 to-do (branch staleness):** this branch forked pre-F11; `origin/main` now
  carries F11 (slashcommand-tool). The Phase 9 merge of `origin/main` must preserve F11's CHANGELOG and
  `doc/supported-features.md` entries (F12 touches neither, so no conflict expected).
- 2026-07-14 — **t04 review: the resume path (the feature's own headline) had two holes.** (1) The
  anchor reader restored the ref but not the issue *cache* — on a post-Phase-3 resume the gate never
  re-runs (empty $ARGUMENTS), so Phase 9's comment-idempotency scan would read a stale `comments: []`
  and **double-post** the hand-off comment. Fixed: the reader re-runs `gh issue view … --json …` to
  re-hydrate. (2) The ticketless sentinel matched an exact en-dash `–`; a hand-typed hyphen/em-dash
  would be read as a real ref and hijack every ticketless resume. Fixed: match ref *shape*, not the
  glyph. **Lesson:** when a durable anchor replaces an in-context cache, the reader must restore
  *everything* the cache fed (ref AND content), and any sentinel must be defined by what it is (a valid
  ref) not by one spelling of what it isn't. Both are classic resume/idempotency traps the No-status-
  bookkeeping principle invites. Router after t04: 18,405/20,000 (1,595 for t05 — kept terse).

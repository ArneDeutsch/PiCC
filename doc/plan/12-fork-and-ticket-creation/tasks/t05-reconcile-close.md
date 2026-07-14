# t05: Reconcile the axes, close the holes, update records

## Goal
The four cells of the ticket-presence × checkout-kind grid are individually coherent and mutually
consistent; the remaining plan holes are closed; the write allow-list reads as one coherent whole;
and the repo records are current. This is the integration/close task after t01–t04.

## Context & seams
Reads and lightly edits the router and all reference files produced by t01–t04. Owns the
cross-cutting reconciliations that no single earlier task should unilaterally settle.

**Explicit hole sweep.** Before the reconciliations below, confirm the full A–F list from planning is
each resolved and pinned (this list lives only in planning context, not on disk, so verify by content
not by grep): **A** fork×ticket composition (this task, item 1); **B** Rule 5 allow-list (t02 push
clause + t04 create clause, finalized here item 2); **C** durable `Ticket:` anchor **and its resident
reader** (t04 — verify the reader actually landed in the always-loaded router; without it C is not
closed); **D** URL-ref fork-vs-target + wrongful-close (this task, item 3); **E** the two
create-issue flows related (this task, item 2); **F** Phase 2 default-branch resolves the **target's**
default, not the fork's (t02 — verify it's stated as a named seam). Assign anything unresolved.

**Reconciliations:**
1. **Hole A — fork × ticket compose.** Make the router state explicitly that fork-awareness is
   orthogonal to ticket presence: the ticketless-**fork** cell still pushes to the fork and hands off
   a compare URL (it is *not* "unchanged from today"). Ensure the four cells are each named and each
   routes correctly (maintainer+none, maintainer+ticket, fork+none, fork+ticket), and that the Phase 1
   fork disclosure (t03) fires on the fork+none cell too.
2. **Hole B/E — Phase 8 finding-filing + allow-list.** Generalize the Phase 8 issue-filing offer to
   file on `<target>` (not `origin`) and to reuse the same discipline as the Phase 1 create-offer;
   relate the two create-issue flows explicitly (same discipline, different intent, both target-aware,
   both idempotent). Do a **final coherence pass on Rule 5**: the allow-list should now read as
   "routine writes + the two explicit per-item offers (create-feature-ticket, file-finding), fork
   push targets the fork remote" — verify t02/t04's clauses compose without contradiction.
3. **Hole D — URL ref pointing at fork vs target (with the cross-repo wrongful-close guard).**
   Finalize the rule left as a marker in t02, and reconcile **both** sinks that state the URL-match
   check — the Phase 0 gate (in `SKILL.md`) **and** Rule 3's URL clause (in
   `references/ticket-integration.md`) — single-sourced or verified identical, so they can't diverge.
   Rule: accept a URL ref matching **either** resolved repo. If it matches the **fork only**, the
   resolved issue lives on the fork while the PR targets `<target>`; warn the user that (a) GitHub
   won't cross-link a fork-issue to an upstream PR, and — the dangerous half — (b) a plain `Closes #N`
   on the upstream PR would **not** close the fork issue but **would wrongly close `target`'s own
   same-numbered issue** if one exists (fork and upstream share a number sequence). So in this cell the
   PR body must carry a **bare cross-repo reference** (`<fork-owner>/<fork-repo>#N`, no closing
   keyword), and the fork issue is closed manually — this is exactly the t03 step-5 conditioning.
   Generalize the rule so it is not cell-specific: **a closing keyword is permitted only when the
   resolved issue lives in the same repo the PR targets; otherwise strip to a bare/cross-repo
   reference.** Correct any lingering "Closes won't fire across repos" rationale to name the
   wrongful-close hazard.
4. **Records.** Add the F12 entry to `CHANGELOG.md` under `[Unreleased]` (Keep-a-Changelog, dated
   `### Category — title (2026-07-14)` sub-header matching the existing entries) covering the two
   user-observable behaviors. State "unchanged" **precisely**: the maintainer **ticket-path hand-off**
   (auto-PR + comment) is unchanged; the maintainer **ticketless run** now gains the opt-in
   create-offer (and on accept does perform ticket writes / a PR). Add a trailing note that the skill's
   on-disk layout changed (router + reference files, prose-only, no `src/` change) **and** that this
   fixes silent post-compaction truncation of the skill's later phases (why the reorg matters, not just
   what moved). Reconcile the **exact stale F06 clause** — the `[Unreleased]` F06 line stating the
   no-argument path "does no ticket reads and no auto-PR" — by qualifying *that clause* in place
   ("unless the create-offer is accepted"), the lighter touch, rather than adding a competing F12
   statement; and note the ticketless path now has **two** opt-in offers (create-ticket after the
   scope mirror, file-findings at close). Confirm (do not regenerate) that `npm run gen:capabilities`
   output is unchanged — the registry is generated from `src/registry/` only, which this feature does
   not touch.

## Writable surface
- `.claude/skills/implement-feature/SKILL.md`
- `.claude/skills/implement-feature/references/ticket-integration.md`
- `.claude/skills/implement-feature/references/fork.md`
- `.claude/skills/implement-feature/references/ticket-creation.md`
- `CHANGELOG.md`
- the guard test under `test/` (extend per Testing)

## Approach constraints
- Editing only — resolve inconsistencies and holes; do not re-open settled decisions from t01–t04.
- The two maintainer cells must remain byte-for-byte behavior-equivalent to today.

## Left open
- Exact CHANGELOG wording and whether the F06 reconciliation edits the old line or adds a clarifying
  clause (pick the lighter touch that removes the contradiction).

## Testing
Confirm the t01 guard test's bidirectional "linked ⇔ exists" check is **count-agnostic** (globs the
actual `references/*.md` and requires each is linked from the router), so it automatically covers the
files t02/t04 added (`fork`, `ticket-creation`) on top of t01's set — no hardcoded count to update.
Keep the `loadSkillBody(skill).length <= REINJECT_PER_SKILL_MAX_CHARS` and single-`SKILL.md`
assertions. Add a
**loose** structural check that the resident discipline checklist is present — e.g. the body contains
`--body-file` and `allow-list` (case-insensitive) — proving the fail-closed floor exists without
pinning its exact prose (which would turn the gate into a wording change-detector). Cross-platform
(fs/path, no shell). Full suite + typecheck green.

## Acceptance criteria
- [ ] The A–F hole sweep is done: A/D/E resolved here; B (Rule 5) reads coherently as a whole; C's
      resident anchor reader verified present in the router; F (target default branch) verified stated.
- [ ] Router names all four grid cells and routes each correctly; ticketless-fork is not described as
      "unchanged"; the Phase 1 fork disclosure fires on fork+none.
- [ ] Phase 8 filing targets `<target>`; the two create-issue flows are related.
- [ ] URL-ref-points-at-fork rule finalized: both the Phase 0 gate and Rule 3 reconciled/single-sourced;
      closing-keyword-only-when-same-repo rule generalized; wrongful-close rationale corrected.
- [ ] CHANGELOG entry added with precise "unchanged" scoping + truncation-fix note; the exact stale F06
      clause qualified in place; capability matrix confirmed unchanged.
- [ ] Guard test is count-agnostic (covers every `references/*.md` bidirectionally) + resident-checklist
      structural check; typecheck and full test suite green.

## Depends on
t01, t02, t03, t04

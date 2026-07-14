# F09: Refine implement-feature ticket write-back

## What
Three changes to the GitHub-ticket behaviour of the `implement-feature` skill, learned from running
it against issue #3. All are edits to `.claude/skills/implement-feature/SKILL.md` (prose only — no
runtime code).

1. **No kickoff comment.** The skill no longer posts a "Work started via implement-feature" comment
   when the branch is created. A run can still be cancelled or turn out infeasible, and a premature
   public "PR coming" note then has to be walked back. Nothing is posted to a linked ticket until
   hand-off. Result: **one** automated ticket comment per successful run, not two.

2. **Ticket comment and PR body split by audience** (they were the same distilled summary posted
   twice):
   - **Issue comment** — user-facing: what was built and how the application's behaviour changes,
     written against the ticket's description, naming any differences/extensions to the original ask.
     No "reviewer, start here"/risky-file content, no restating the merge link.
   - **PR body** — reviewer-facing: a short "what was built" plus a **"Start your review here"** that
     guides *semantic verification in the running application* (ordered steps to exercise the change
     and the behaviour to confirm), since agents already reviewed the code and GitHub shows the diff.

3. **Optional issue-filing for out-of-scope findings.** At close, the skill surfaces the unfixed bugs
   and out-of-scope improvements distilled into `review.md` and **offers to file the ones the user
   picks as GitHub issues**. Runs on **both** the ticket and the ticketless path whenever GitHub is
   reachable. Per-item explicit approval only; each issue authored under the section's write-discipline
   (body via file, model-authored ASCII title, no leakage, attribution trailer, duplicate-guarded).
   This carves a narrow, explicit exception into the Rule 5 write allow-list.

Non-goals: no change to the reachability gate, the data-not-instructions discipline, the
close-vs-keep-open judgement, or the core ticketless flow beyond the opt-in issue-filing offer.

## Why
Running #3 exposed real friction: the kickoff comment is noise that can become a lie if the work is
abandoned; posting the same reviewer-oriented summary as both PR body and ticket comment is redundant
and points the maintainer at code review when what they actually need is guidance to verify the
change *in the running app*; and genuinely valuable bugs/improvements surfaced during the build were
left only in `review.md`, easy to lose after hand-off. These are process-improvement changes — the
skill getting better feature-over-feature, which is exactly what its "observe while you build"
principle is for.

## Acceptance
- The skill never instructs posting a kickoff/"work started" comment; the write-contract, idempotency
  rule, degrade path, and abort path all reflect a single hand-off comment.
- Phase 9 authors two distinct texts (issue comment vs PR body) with the audiences above; the PR body
  centres on a running-app verification guide.
- Phase 8 defines an opt-in, reachability-gated, per-item, discipline-compliant issue-filing offer
  available on both paths; Rule 5 permits `gh issue create` only under that explicit exception.
- The skill remains internally consistent: no dangling references to the kickoff comment, "two
  automated comments", or a single shared summary; every cross-reference (Rules, Phase 1/8/9, abort)
  agrees.

## Tasks
(single lightweight pass — coordinator edits SKILL.md directly, then specialist review; no task specs)

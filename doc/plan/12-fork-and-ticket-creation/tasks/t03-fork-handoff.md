# t03: Fork hand-off — push to fork, compare URL, paste-ready PR (no auto-PR, no auto-comment)

## Goal
Phase 9 on the **fork path** pushes the feature branch to the fork remote and hands the user a
one-click **compare URL** plus **paste-ready** PR title and body (and an optional paste-ready issue
comment) so the user opens the PR against the upstream repo via GitHub's web UI. The workflow makes
**no** `gh pr create` and posts **no** automatic comment to the upstream issue — the only automatic
GitHub write on the fork path is the branch push to the fork. The fork nature is surfaced **early**,
in the Phase 1 write-contract, not sprung at hand-off. Adds the hand-off half of `references/fork.md`.

## Context & seams
Builds on t02's resolved identities (`target`, `push`, `pushRemote`, `targetDefault`) and reuses the
PR-body / issue-comment **skeletons authored in `references/handoff.md`** (t01) — do not re-invent
them; `fork.md` points back to those skeletons and only changes the delivery (paste-ready, not
posted).

**Compare URL** — emit the **two-part head form** (documented and known to work with `?expand=1`):
```
https://github.com/<target-owner>/<target-repo>/compare/<targetDefault>...<forkOwner>:<branch>?expand=1
```
Three dots; `?expand=1` (opens the PR-creation form). Use the **two-part** `<forkOwner>:<branch>` head,
**not** the three-part `<forkOwner>:<forkRepo>:<branch>` form: the three-part head + `?expand=1` is
reported to render "There isn't anything to compare" (desktop/desktop#16269), which would dead-end the
hand-off after the branch is already pushed. The two-part form is unambiguous for a freshly-pushed
branch on the user's fork; only if the fork was renamed such that `<forkOwner>:<branch>` is ambiguous
does the three-part form help — mention that as an aside, don't emit it by default. `forkOwner` comes
from the fork's `nameWithOwner` (`push`) — authoritative; do **not** substitute `gh api user --jq
.login` (wrong for an org-owned fork). All components are ASCII/URL-path-safe given the model-authored
branch slug. **Confirm the branch is actually pushed to the fork before printing the URL**, or the link 404s.

**Fork hand-off procedure (Phase 9, fork path):**
1. `git push -u <pushRemote> feature/<NN>-<slug>` (the fork). This is the only automatic write.
2. Present the final summary: the working compare URL; the PR **title** on its own line (copyable);
   the PR **body** in a fenced code block (byte-exact, including the linking line — see step 5 for
   which linking form is safe — and the attribution trailer); ordered steps (open link → paste title →
   paste body → submit).
3. **Do NOT** pre-fill the body via URL query params (it would clobber the upstream PR template the
   flow deliberately surfaces, and overflows URL limits). The pasted body may need merging with the
   template GitHub shows — say so.
4. **Issue comment:** do not auto-post. Optionally hand the issue-comment text as a paste-ready
   artifact ("if you want to leave a note on #N after opening the PR"). Rationale to state in the
   file: at hand-off the PR doesn't exist yet, and a fork-PR↔upstream-issue link is cross-repo so
   GitHub won't auto-surface it; auto-commenting on a repo the user doesn't own is unwanted.
5. **Closing-keyword discipline on the pasted body (Rule 3), generalized for cross-repo safety.** A
   closing keyword (`Closes/Fixes/Resolves #N`) is safe **only when the resolved issue lives in the
   same repo the PR targets** — i.e. the issue is on `target` (the given/created-on-upstream ticket
   case). In that case the top linking line may carry `Closes #N`. **When the resolved issue lives on
   the fork** (a URL ref pointing at a fork-hosted issue — the t05/Hole D case), a plain `Closes #N`
   on a PR that targets `target` does **not** close the fork issue and **will wrongly close `target`'s
   own same-numbered issue** (fork and upstream share a number sequence). So in that case emit a
   **bare cross-repo reference** (`<fork-owner>/<fork-repo>#N`, no closing keyword) and tell the user
   to close the fork issue manually. Never hard-code `Closes #N` into the skeleton — choose the form
   from where the resolved issue lives. Regardless of form, strip any **stray** `Closes/Fixes/Resolves
   #M` distilled from `review.md`/`observations.md`/ticket text (the UI paste is a human checkpoint,
   not a substitute for stripping). **Forbid** any `gh pr create --head <login>:<branch> --repo
   <target>` fallback.
6. **This is a discipline write site.** Authoring the paste-ready body distills from
   `review.md`/`observations.md` and depends on Rule 3 (stripping) and Rule 6 (leakage): load
   `references/ticket-integration.md` before distilling; if it can't be read, fall back to t01's
   resident checklist floor and refuse to emit until the rules are available. Do not distill a body
   with the rules unloaded.

**Push-failure degrade** (mirror Phase 9's push-rejected branch): lead with "nothing is lost"
(all committed on the branch in the worktree), give the actual git/gh error, state nothing was posted
upstream (name any user-filed issue that already exists), give the fix + re-push command, then hand
the paste-ready title/body and the compare-URL template for once the push succeeds.

**Phase 1 fork disclosure — a NEW moment on a path that had none (fixes the "surfaced early" gap).**
Today the only Phase 1 write-contract moment is gated on the ticket path (`SKILL.md`: "On the ticket
path, extend the scope mirror with the write-contract"). A fork checkout with **no** ticket (cell C)
therefore has *no* early fork disclosure and would first learn it's a fork when the compare URL
appears at hand-off — the exact spring this task forbids. So this task must add a Phase 1 fork
disclosure that fires on **any fork checkout, ticketless included**, not only on the ticket path. Text:
"Heads up — this is a fork checkout: I can push to `<push>` but not to `<target>`. At hand-off I'll
push the branch to your fork and hand you a compare URL plus paste-ready PR (and optional comment)
texts so you open the PR against `<target>` yourself; I will post nothing to `<target>` automatically."
Surface the fork detection result the moment it's known so the manual-PR hand-off is expected. (The
create-offer's own contract lines are owned by t04; t05 reconciles both into the grid.)

**No-gh-on-a-fork degrade:** fork detection needs `gh repo view` (t02). If `gh` is unavailable on a
fork checkout, the run cannot resolve `target`/`push` and must degrade to today's generic "push your
branch and open a PR yourself" hand-off with **no** compare URL — and that degrade must **never**
claim an auto-PR was or will be created.

## Writable surface
**Post-t01/t02 layout:** the Phase 9 maintainer detail + PR/comment skeletons live in
`references/handoff.md`; the common Phase 1 procedure lives in `references/workflow-detail.md` (Phase 1);
`references/fork.md` already has the detection half + a "Phase 9" placeholder line. Put the fork
hand-off **procedure** and the Phase 1 fork-disclosure **text** in `references/fork.md` (new sections),
and add the routing lines in the router skeleton + workflow-detail Phase 1 so a fork checkout reads
them. Files:
- `.claude/skills/implement-feature/references/fork.md` (append the Phase 9 fork hand-off section + a Phase 1 fork-disclosure section)
- `.claude/skills/implement-feature/SKILL.md` (Phase 9 skeleton: route to fork.md on the fork path; Phase 1 skeleton: note the fork disclosure)
- `.claude/skills/implement-feature/references/workflow-detail.md` (Phase 1: route to fork.md's disclosure when a fork is detected; Phase 9 pointer if needed)
- `.claude/skills/implement-feature/references/handoff.md` (only if a shared skeleton needs a small "delivery: posted vs paste-ready" note; keep skeletons single-sourced there and have fork.md reference them)

## Approach constraints
- Single-source the PR/comment skeletons in `references/handoff.md`; `fork.md` references them.
- The maintainer Phase 9 (auto-PR + auto-comment) stays exactly as t01 left it.
- Include the `Signed-off-by`/DCO **note** here (documented only — not added to the commit grammar):
  a short paragraph in `fork.md` that some upstreams require DCO sign-off and the user can add `-s`
  or the UI can enforce it; the skill does not auto-sign.

## Left open
- Whether the optional paste-ready issue comment is shown by default or only on request (recommend:
  offer it, don't dump it).
- Exact wording of the final hand-off summary (UX drafts from planning are a guide, not binding).

## Testing
Prose-only. t01 guard test must stay green. No behavioral unit test possible; correctness via review
against this spec, the UX findings, and the security findings (compare-URL safety, no `gh pr create`,
`Closes #N` stripping).

## Acceptance criteria
- [ ] Fork Phase 9 pushes to the fork remote and hands off compare URL + paste-ready PR title/body;
      no `gh pr create`, no automatic upstream comment.
- [ ] Compare URL uses the verified three-dot `owner:repo:branch` `?expand=1` form; branch confirmed
      pushed before the URL is shown.
- [ ] Linking form is chosen by where the resolved issue lives (closing keyword only when it's on
      `target`; bare cross-repo ref for a fork-hosted issue); stray keyword+`#M` stripped; `gh pr
      create` fork fallback forbidden; the body is authored as a discipline write site.
- [ ] Phase 1 fork disclosure fires on **any** fork checkout including ticketless; no-gh-on-fork
      degrade never claims an auto-PR; push-failure degrade present; DCO note present.
- [ ] typecheck and full test suite green (watch the router-size guard; relocate, never cut)

## Depends on
t01, t02

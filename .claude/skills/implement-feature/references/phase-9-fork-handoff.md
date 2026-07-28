# Phase 9 — fork hand-off (push to fork, compare URL, paste-ready PR)

Read this at **Phase 9** on the **fork path** (Phase 0 resolved `push != target`). It **replaces**
the "Ticket path — open the PR and post the comment" block of [phase-9-handoff.md](phase-9-handoff.md) with a
paste-ready hand-off; the common spine of [phase-9-handoff.md](phase-9-handoff.md) Phase 9 still applies — the
push/merge preamble (step 1), the CI check (step 2), ExitWorktree `action: keep` (step 3), and the
per-path final summary (step 4). The PR **body** and issue-**comment** skeletons are **single-sourced
in [phase-9-handoff.md](phase-9-handoff.md)** — do not re-invent them here; this section changes only the *delivery*
(handed to the user paste-ready, not posted) and the linking form (below).

**Excluding the two separately approved per-item issue-create offers, the fork push is the only
routine Phase 9/hand-off automatic GitHub write.** No `gh pr create`, no `gh issue comment` on fork
hand-off. **Forbid** any `gh pr create --head <login>:<branch> --repo <target>`
fallback — a fork PR is opened by the user through GitHub's web UI, never by the skill.

**This is a discipline write site.** Authoring the paste-ready PR body distills from `review.md` /
`observations.md` / task logs and depends on Rule 3 (stripping stray closing keywords) and Rule 6
(no leakage). **Load [ticket-integration.md](ticket-integration.md) before distilling.** If it can't
be read, fall back to the router's resident write-discipline checklist floor and **refuse to emit
the body until the rules are available** — do not distill a body with the rules unloaded.

**Procedure:**

1. **Merge, then push to the fork.** Re-fetch the **target's** default via a temporary named remote
   (as in Phase 2 — [phase-2-workspace.md](phase-2-workspace.md)); if it moved, merge it into the
   feature branch, resolve conflicts, and verify typecheck + full suite green again. Then apply
   [phase-9-handoff.md](phase-9-handoff.md) step 1's push-safety gate against `<pushRemote>` (the fork) for
   `git push -u <pushRemote> feature/<feature-slug>` — its first-push condition, established-self-owned
   criteria, foreign-ref stop, "nothing is lost" framing, never-force rule, and non-atomic-race caveat
   govern this push exactly as on the maintainer path, just targeting the fork. **Excluding the two
   separately approved per-item issue-create offers, this single fork push is the only routine Phase
   9/hand-off automatic GitHub write.**
2. **Confirm the push landed before printing the compare URL** — a URL for a branch that isn't on the
   fork 404s. Only after the push succeeds, build the URL.
3. **Compare URL — emit exactly this two-part-head form** (split `target` into
   `<target-owner>/<target-repo>`; take `<forkOwner>` from the fork's `nameWithOwner` = `push`
   (authoritative — do **not** substitute `gh api user --jq .login`, which is wrong for an org-owned
   fork); `<branch>` is concretely `feature/<feature-slug>`):
   ```
   https://github.com/<target-owner>/<target-repo>/compare/<targetDefault>...<forkOwner>:feature/<feature-slug>?expand=1
   ```
   **Three dots**; `?expand=1` (opens the PR-creation form). Use the **two-part** `<forkOwner>:<branch>`
   head, **not** the three-part `<forkOwner>:<forkRepo>:<branch>` form: the three-part head + `?expand=1`
   is reported to render "There isn't anything to compare" (desktop/desktop#16269), which would
   dead-end the hand-off after the branch is already pushed. The two-part form is unambiguous for a
   freshly-pushed branch on the user's fork; only if the fork was renamed such that `<forkOwner>:<branch>`
   is ambiguous does the three-part form help — an aside, not the default emission. All components are
   ASCII / URL-path-safe given the model-authored branch slug (Rule 4). Do **not** pre-fill the PR body
   via URL query params: it would clobber the upstream PR template this flow deliberately surfaces and
   overflows URL limits.
4. **Present the final summary.** This **replaces** [phase-9-handoff.md](phase-9-handoff.md) step 4's next-steps
   bullets — both the ticketless "open a Pull Request yourself" line **and** the ticket-path "the
   ready-for-review PR is already open" line: on the fork path a ticket run has **no** open PR, so
   neither of those bullets is true here. Reuse phase-9-handoff.md step 4's framing (what was
   implemented, decisions/deviations, test status) **and its cleanup-loss warning**: durable tracking
   requires either a new issue filed with user approval or an existing issue the user explicitly
   confirmed as equivalent and the workflow reused under Rule 9. Every finding with neither outcome remains only in
   the run-local review/observation records and disappears at cleanup; a candidate near-match or search
   hit alone is not durable. Do not reuse either maintainer-only next-steps bullet. Then give
   the fork next-steps:
   - The working **compare URL** (from step 3).
   - The PR **title** on its own line, copyable — the stable printable-ASCII `<Title>` from confirmed
     scope (Rule 4), with no identifier prefix.
   - The PR **body** in a fenced code block, byte-exact — authored from [phase-9-handoff.md](phase-9-handoff.md)'s
     **PR-body skeleton** (answer every heading; "Start your review here" is a semantic verification
     guide, not a code tour) — this inherits phase-9-handoff.md's single-source launch-and-verify recipe
     (obtain the branch, `node ./bin/picc.mjs --model openai-codex/<id>`, drive-and-confirm); do not
     re-author it here. Inside that body's steps use **inline `code`, never a triple-backtick
     fenced block** — a nested fence would terminate the outer code fence and corrupt the copyable
     artifact. Include the linking line (step 5) and end with the `<attribution trailer>` (Rule 8).
   - **Ordered steps:** open the compare link → paste the title → paste the body → submit. Note that
     GitHub may show the upstream **PR template**; the pasted body may need merging with it — say so,
     since we deliberately did not pre-fill. Point the user to check the upstream's CONTRIBUTING /
     CLA / DCO requirements as they open the PR (see the DCO note below).
5. **Linking form — choose by where the resolved issue lives (Rule 3, generalized for cross-repo
   safety).** A closing keyword (`Closes`/`Fixes`/`Resolves #N`) is safe **only when the resolved
   issue lives in the same repo the PR targets** — i.e. the issue is on `target`. Never hard-code
   `Closes #N`; pick the top linking line from where the issue lives:
   - **Issue on `target`** (the given ticket whose URL matched `target`, or a ticket created on the
     upstream via the create-offer): use [phase-9-handoff.md](phase-9-handoff.md)'s skeleton top line as-is — `Closes #N`
     if Phase 8 judged the feature to **fully** deliver #N, else a bare `#N` (ticket stays open).
   - **Issue on the fork** (a URL ref pointing at a fork-hosted issue — the fork-only URL-ref case): a plain
     `Closes #N` on a PR that targets `target` does **not** close the fork issue and **would wrongly
     close `target`'s own same-numbered issue** (fork and upstream share a number sequence). Emit a
     **bare cross-repo reference** `<fork-owner>/<fork-repo>#N` (no closing keyword) and tell the user
     to close the fork issue manually.
   - **Ticketless fork path:** no ticket, so no linking line at all.

   Regardless of form, **strip any stray `Closes`/`Fixes`/`Resolves #M`** distilled from `review.md` /
   `observations.md` / ticket text (Rule 3) — the UI paste is a human checkpoint, not a substitute for
   stripping.
6. **Issue comment — do not auto-post.** At hand-off the PR doesn't exist yet, a fork-PR↔upstream-issue
   link is cross-repo so GitHub won't auto-surface it, and auto-commenting on a repo the user doesn't
   own is unwanted. **Optionally** hand the [phase-9-handoff.md](phase-9-handoff.md) issue-**comment** text as a
   *paste-ready* artifact ("if you want to leave a note on #N after opening the PR") — offer it, don't
   dump it by default. It is authored under the same discipline (via the skeleton, ending with the
   `<attribution trailer>`, Rule 6 leakage-stripped).

**Push-failure degrade** (the fork push is rejected — mirror [phase-9-handoff.md](phase-9-handoff.md)'s
push-rejected branch): do **not** stop cold. Lead with **"nothing is lost"** (everything is committed
on the branch in the worktree), give the actual `git`/`gh` error — but **redact any embedded
credential first**: a raw `git push` error can echo a remote URL like
`https://x-access-token:TOKEN@github.com/…`, so strip the `user:token@` before showing it, the same
redaction the Phase 0 STOP-and-ask rule applies (keep the two in lockstep). State that **nothing was posted
upstream** (name any issue the user filed earlier — e.g. via the create-offer — that already
stands and was echoed when created, so they know what is already public), give the fix + the re-push
command, then hand the paste-ready PR **title**/**body** and the compare-URL **template** (to fill in
once the push succeeds). No compare URL is shown until a real push lands.

> **Redaction lockstep (cross-file).** The `user:token@` strip above is the same rule enforced at the
> `SKILL.md` Phase-0 STOP-and-ask gate, the `fork.md` resolution step-4 STOP-and-ask (its sibling copy,
> separated from this one by the split), and the Phase-0 ticket preflight (`phase-0-ticket-preflight.md`);
> edit all copies together so none drifts.

**No-gh-on-a-fork degrade.** Fork detection needs `gh repo view` (Phase 0). If `gh` is unavailable on
a fork checkout, the run cannot resolve `target`/`push`, so it degrades to a **generic**
"push your branch and open a PR yourself" hand-off with **no** compare URL (there is no resolved
`targetDefault`/fork identity to build one). That degrade must **never** claim an auto-PR was or will
be created — the maintainer auto-PR path only runs when the checkout is confirmed to *be* the target.

**DCO / `Signed-off-by` note.** Some upstream projects require a Developer Certificate of Origin (DCO)
sign-off — a `Signed-off-by:` trailer on each commit — before a PR is accepted. This skill does
**not** auto-sign: `Signed-off-by` is deliberately kept **out** of the commit grammar. If the target
enforces DCO, the user can add `-s`/`--signoff` to their commits (or amend/rebase to add the trailer),
or use the PR UI's sign-off affordance where the project offers one. Mention this in the hand-off when
the upstream is known to gate on DCO.

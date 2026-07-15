# Phase 9 — Integrate, push, hand off (full detail)

Read this when the coordinator enters Phase 9. It is the whole hand-off procedure — the common
push/merge, the maintainer ticket-path PR + issue comment, the CI check, ExitWorktree, and the final
summary. Before any public GitHub write you must also have read the write discipline in
[ticket-integration.md](ticket-integration.md); if either reference cannot be read, refuse all public
writes and tell the user.

> **Delivery: posted (maintainer) vs. paste-ready (fork).** The PR-body and issue-comment skeletons
> below are **single-sourced here** and used by both paths. On the **maintainer** path they are
> *posted* by `gh` as described in this file. On the **fork** path they are handed to the user
> *paste-ready* (nothing is auto-posted); the fork path also chooses the top linking line by where the
> resolved issue lives (a plain `Closes #N` is unsafe cross-repo). That fork-specific delivery and
> linking discipline live in [fork.md](fork.md) (Phase 9 — fork hand-off); this file's maintainer
> procedure is unchanged.

1. If a remote exists: `git fetch <pushRemote>`. If `<pushRemote>/<default>` moved, merge it into the feature branch, resolve conflicts, and verify typecheck + full suite are green again. **Immediately before every push**, fetch `<pushRemote>` again and inspect the exact fetched ref plus all case-fold-equivalent siblings for `feature/<feature-slug>`.
   - **First push:** an absent exact ref with no case-fold sibling is available for `git push -u <pushRemote> feature/<feature-slug>`.
   - **Established self-owned branch:** an existing exact ref is allowed only when live-run knowledge proves this workflow created it earlier, or the disk-resume trust gate explicitly confirmed it; its configured upstream must be exactly `<pushRemote>/feature/<feature-slug>`, no case-fold sibling may exist, and the fetched remote tip must equal local `HEAD` or be an ancestor of it. Then an ordinary non-forcing equal/fast-forward push (including a resumed handoff or CI-fix repush) is allowed.
   Any foreign/ambiguous ref, wrong or absent upstream for an existing ref, case-fold sibling, or diverged remote tip that is not equal/ancestor stops before push and all later GitHub writes. Lead with **"nothing is lost"**; name the conflicting ref and relationship, state that the local branch, worktree, and commits remain intact and nothing new was posted, and offer safe choices to inspect/reconcile ownership or restart under a new descriptive identity. Never force or suggest force, delete, overwrite, or adoption. The check is not atomic: a same-name branch created in the remaining check-to-push race may still be attached by ordinary push when histories permit; do not claim complete race elimination.
   If there is **no remote**: merge the local default branch if it moved, verify green — the hand-off is the local branch itself.

   **Ticket path — open the PR and post the comment (skip this entirely on the ticketless path).** After the push above succeeds (the branch MUST be pushed first, or `gh pr create` drops into an interactive prompt and hangs): run the **Rule 9** idempotency check — `gh pr list --repo <owner/repo> --head feature/<feature-slug> --state open --json number,url` — and **reuse** any PR it returns; otherwise create a **ready-for-review** PR (ready is the default — do **not** pass `--draft`) against `<default>`:
   ```bash
   gh pr create --repo <owner/repo> --base <default> --head feature/<feature-slug> \
     --title "<Title>" --body-file <path>
   ```
   Author **two distinct texts** — the audiences differ, so don't post one summary twice. Write each to its own temp file **outside the worktree**, each ending with the `<attribution trailer>`; apply **Rule 6** to both while distilling (no absolute paths, no raw output/diffs, no leakage). Echo both URLs in-session (Rule 7).

   - **PR body — for the reviewer, who verifies the change in the running application.** Agents have already reviewed the code and GitHub's UI already shows the diff, so this is *not* a code tour; it is a semantic verification guide. **First judge whether the change even warrants manual verification** (the same applicability rule `CONTRIBUTING.md` and the PR template state): a change with **no runtime surface to drive** — docs, comments — or one **fully and genuinely covered by automated tests** has nothing left to check by hand; write **"no manual verification needed: `<reason>`"** (naming the covering tests, if that is the reason) rather than inventing a step. For a change with no runnable UI — skill/harness/prose-only — **"the running app" is picc executing the changed behaviour**, so it **is not** exempt: give concrete, ordered steps to invoke that flow (which branch, how to launch picc — e.g. against an `examples/` project — the in-app actions) and the observable outcome to confirm (run the command, watch for the changed message/artifact — or its deliberate absence). Open with the linking line — `Closes #N` if Phase 8 judged the feature to **fully** deliver the ticket, else a bare `#N` (ticket stays open); **only that top line may carry a closing keyword — per Rule 3, strip any stray keyword+`#N` from the distilled "what was built"/verification sections** — then a short "what was built" (mild overlap with the comment is fine), then **"Start your review here"**: concrete, ordered steps to exercise the change and the behaviour to confirm at each step. Skeleton — answer every heading (an empty one reads "None"; never omit a heading):
     ```
     Closes #N            (or a bare  #N  when the ticket stays open)

     ## What was built — feature/<feature-slug>
     <2–4 lines: the observable change, mapped to what #N asked for>

     ## Start your review here — verify in the running app
     <ordered steps: how to run/trigger the change and the behaviour to confirm at
     each step; call out edge cases and how to reach them. A semantic verification
     guide, not a code tour. If the change has no runtime surface (docs) or is fully
     covered by automated tests, write "no manual verification needed: <reason>"
     instead — but a skill/harness/prose change is NOT exempt (picc executes it).>

     ## Known limitations & test status
     <deliberate cuts / "Left open" in one line; then typecheck + suite green
     locally, CI green/pending/not-checked>
     ```
   - **Issue comment — for the ticket's readers, explaining the outcome.** Post it with `gh issue comment <N> --repo <owner/repo> --body-file <path>` (per **Rule 9** skip if a prior machine-trailered comment is already on the ticket). Explain **what was built and how the application's behaviour changes**, written against the ticket's description and naming any **differences or extensions** to the original ask. Keep it user-facing: no "start-your-review"/risky-file content (that lives in the PR), and **don't restate the PR link** — GitHub already surfaces the PR on the ticket timeline via the linking line, so a repeated link is exactly the redundancy this split removes. Skeleton — answer every heading (an empty one reads "None"; never omit a heading):
     ```
     ## What was built for #N
     <observable behaviour delivered, in the ticket-reader's terms>

     ## How behaviour changes
     <what a user of picc will now see differently, mapped to what #N asked for>

     ## Differences & extensions vs. the original ask
     <where the delivered behaviour narrows, widens, or reinterprets the ticket; or "None">

     ## Not included this pass
     <WON'T / deferred scope, and — if the ticket stays open — the remaining scope by name; or "None">
     ```

   Raw material for both: `review.md` (Bugs discovered → surfaced; Proposed follow-ups → missing/deferred), `observations.md`, the task `log/t<task-number>.md` files (Left open / deviations → limitations), and the scope-mirror WON'T. Distill — never fabricate; if you can't state a verification step truthfully, say what you couldn't verify rather than inventing one.

   **Write-failure degrade** (reads succeeded but a write is rejected): do **not** stop cold. Lead with "nothing is lost", report which writes already landed (so the user doesn't double-post), then hand over paste-ready artifacts — the PR base/compare/title/body and the issue-comment body, verbatim, with the actual `gh` error. If a PR already exists (Rule 9), the correct degrade is to skip creation and hand over the comment, not to tell the user to open a PR. If the `git push` **itself** is rejected (e.g. `<pushRemote>` exists but isn't pushable), there is no branch to open a PR against: say so plainly — no hand-off comment has been posted to the ticket at this point (it is the first and only automated ticket write, and it never went out), so there is no premature note to correct. (But a feature ticket you **created** via the Phase 1 offer — filed at Phase 3 — *is* already public/open, as are any follow-up issues you filed in the Phase 8 offer; name each with its URL so the user knows what already stands and can keep or close it.) Hand over the paste-ready PR/comment artifacts for when the branch can be pushed.
2. **CI check (when possible).** Local green isn't the same as CI green — CI runs on Linux too and has caught environment-only failures before. If the `gh` CLI is available and authenticated (`gh auth status`), watch the pushed branch's run (`gh run list --branch feature/<feature-slug>`, then `gh run watch <id> --exit-status`) and treat a red run like any test failure: investigate the logs (`gh run view <id> --log-failed`), fix, push again. If `gh` is not available, don't block — note prominently in the final summary that CI on the Actions tab must be green before merging.
3. ExitWorktree with `action: keep` — the worktree must survive until the user has merged.
4. Final summary to the user: what was implemented (per feature.md), notable decisions and deviations, test status, and next steps — which differ by path. **These two next-steps bullets are the maintainer (non-fork) paths only; on the fork path neither is true (a fork run has no auto-opened PR), so [fork.md](fork.md) (Phase 9 — fork hand-off) step 4 replaces them with the compare-URL + paste-ready hand-off.**
   - **Ticketless path (unchanged):** print the stable copyable PR title `<Title>` on its own line; review the branch, open a Pull Request on GitHub (or merge locally if no remote) with that title, use "Delete branch" there after merging, and clean up locally afterwards with:
     - `git worktree remove <worktree-path>`
     - `git branch -d feature/<feature-slug>` (plus the harness-created `worktree-*` branch for that worktree, if one lingers)
   - **Ticket path:** the ready-for-review PR is **already open** (link it) and the ticket carries the single hand-off comment — review the PR by verifying the change in the running app (the PR body's "Start your review here" walks you through it), merge it via GitHub's PR UI, use "Delete branch" there after merging, and clean up locally afterwards with the same two commands above.

The explicit no-`gh` git-only degrade alone reserves literal `origin` for its `git fetch origin`, `origin/<default>`, and `git push -u origin feature/<feature-slug>` guidance; all resolved maintainer operations above use `<pushRemote>`.

Do **not** open the PR yourself; the user reviews first. **On the ticket path the PR is already open** — there, do **not** merge it yourself either; the user reviews and merges via GitHub.

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
> linking discipline live in [fork.md](fork.md) (Phase 9 — fork hand-off).

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

   - **PR body — for the reviewer, who verifies the change in the running application.** Agents have already reviewed the code and GitHub's UI already shows the diff, so this is *not* a code tour; it is a semantic verification guide. **First judge whether the change even warrants manual verification** (the same applicability rule `CONTRIBUTING.md` and the PR template state): a change with **no runtime surface to drive** — docs, comments — or one **fully and genuinely covered by automated tests** has nothing left to check by hand; write **"no manual verification needed: `<reason>`"** (naming the covering tests, if that is the reason) rather than inventing a step. For a change with no runnable UI — skill/harness/prose-only — **"the running app" is picc executing the changed behaviour**, so it **is not** exempt: give concrete, ordered steps to invoke that flow — how to obtain the branch, launch picc from the right working directory, and the in-app actions — by following the **launch-and-verify recipe** below, and the observable outcome to confirm (run the command, watch for the changed message/artifact — or its deliberate absence). Open with the linking line — `Closes #N` if Phase 8 judged the feature to **fully** deliver the ticket, else a bare `#N` (ticket stays open); **only that top line may carry a closing keyword — per Rule 3, strip any stray keyword+`#N` from the distilled "what was built"/verification sections** — then a short "what was built" (mild overlap with the comment is fine), then **"Start your review here"**: concrete, ordered steps to exercise the change and the behaviour to confirm at each step. Skeleton — answer every heading (an empty one reads "None"; never omit a heading):
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

     **Launch-and-verify recipe — driving picc on the feature branch.**

     > **COORDINATOR authoring note — do NOT paste into the PR body.** This recipe is the
     > single source for how a reviewer runs the built change against a live model against
     > a **runnable picc surface** (skill / agent / `CLAUDE.md` / harness / prose); it
     > fleshes out the PR body's "Start your review here" steps. It sits **behind the
     > applicability gate above**: a change with no runtime surface (docs) or one fully
     > covered by automated tests skips it and writes "no manual verification needed:
     > `<reason>`" instead. The fork path re-uses this same PR body ([fork.md](fork.md)
     > Phase 9), so author the recipe **once here** and inherit it there — do not
     > duplicate it, and keep it out of the outcome-only issue comment below. Because the
     > fork hand-off pastes the whole PR body inside one outer ` ``` ` fence, **every
     > command you render stays inline `code`, never a triple-backtick fenced block** — a
     > nested fence would corrupt the copyable artifact. **Steps 1–7 below are the
     > reviewer-facing verification steps: render them into the PR body in your own words,
     > dropping every authoring aside** — this note, the doc cross-references, and the
     > parentheticals about which corpus loads — so the third party reading the PR sees
     > only the verification steps. **Step 8 (feedback routing) is guidance for the run's
     > owner/coordinator, not a verification step — keep it here for your own use but do
     > NOT paste it into the third-party PR body** (a stranger reviewing your PR cannot
     > add tasks to your plan folder).

     When it applies, the "Start your review here" steps follow this order:
     1. **Obtain & enter the branch.** `gh pr checkout <PR#>` (clone first if you don't
        have the repo: `gh repo clone <owner/repo>`) — or, without `gh`,
        `git fetch origin feature/<feature-slug> && git switch feature/<feature-slug>`.
        Use these repo-local commands only; never hand out an absolute checkout path (it
        leaks the OS username — Rule 6).
     2. **Setup (once per fresh checkout).** Node ≥ 22.19; run `npm install
        --ignore-scripts` at the checkout root (where `package.json` is) — do this
        **before** you `cd` into any fixture in the next step. There is **no build step**
        — picc runs straight from the TypeScript source. If setup was skipped you'll see
        `could not find the Pi CLI (@earendil-works/pi-coding-agent)`; the fix is that
        `npm install`.
     3. **Pick the target by change type — launch picc from the root of whichever
        project's `.claude/` corpus you changed.** picc runs against the current directory
        (cwd *is* the project; there is no target-dir argument), so the launch form
        follows from that principle. A **skill / agent / `CLAUDE.md` / prose change** edits
        picc's *own* `.claude/` corpus, which only loads when it is the *active* project,
        so run **from the feature checkout root**, which is itself the target — `node
        ./bin/picc.mjs …`. A **harness / code change** (loaders, `bin/`, `src/`) has no
        corpus of its own and surfaces against any project, so drive a fixture whose
        `.claude/` exercises it — `cd examples/hello-claude`, then `node ../../bin/picc.mjs
        …` (the launcher path is relative to cwd, hence `../../bin/…` from the fixture).
        Getting this wrong silently verifies the *wrong* corpus, so match the launch form
        to the change.
     4. **Use the checkout's own launcher — not the `picc` on `PATH`.** A bare `picc`
        (from `npm link`) resolves to the installed/main checkout, not this branch, so it
        would verify the *old* behaviour. Always invoke the feature checkout's own
        `node ./bin/picc.mjs`.
     5. **Launch (same in PowerShell, cmd, and bash).** `node ./bin/picc.mjs --model
        openai-codex/gpt-5.5` (other valid ids: `openai-codex/gpt-5.4`,
        `openai-codex/gpt-5.6-sol`). Route the
        model through the `openai-codex` provider as shown — a bare `openai/<id>`
        selector fails with "No API key found for openai". The relative forward-slash
        command is byte-identical on Windows PowerShell, cmd, macOS, and Linux. Windows
        differs in **one prerequisite only**: Git Bash must be installed (Pi's `bash`
        tool and project scripts need it). The PowerShell execution-policy prompt applies
        to the npm-link `picc` PowerShell (`.ps1`) shim — which this `node
        ./bin/picc.mjs` launch form does not use, so it's **not applicable here** (don't
        set `RemoteSigned`).
     6. **First-run auth — in-app, after launch.** At the picc prompt run `/login`,
        choose "ChatGPT Plus/Pro (Codex Subscription)", and complete the browser OAuth.
        This is a one-time step *inside* the session (not a shell step before launch);
        the credential persists to your home `~/.pi/agent/auth.json` (user-global, not
        per-repo), so later launches skip it.
     7. **Drive & confirm.** Then run the change-specific ordered action →
        observable-outcome steps of "Start your review here": trigger each action and
        watch for the changed message/artifact (or its deliberate absence). The recipe is
        the preamble that gets a live model running on the right branch — it does **not**
        replace those steps.
     8. **Route feedback back — reuse the existing machinery; the human decides the
        bucket.** A gap in *this* feature's promised behaviour (in scope) means it is
        **not done**: hold the merge and add a new task to the current plan — the kept
        worktree still holds the plan folder — an ordinary Phase 7/8 review round. A
        pre-existing bug or an adjacent improvement (out of scope) routes through the
        existing **Phase 8 issue-filing offer** (per-item consent). Don't invent a
        parallel channel; the Phase 9 final-summary next-steps is the home for acting
        on either.
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
4. Final summary to the user: what was implemented (per feature.md), notable decisions and deviations, test status, and next steps — which differ by path. **Heads-up before the cleanup below:** `git worktree remove` permanently deletes the run's plan folder, `review.md`, and `observations.md` — they were worktree-local and never committed, so anything worth keeping should already have been filed as a GitHub Issue at close (Phase 8). **These two next-steps bullets are the maintainer (non-fork) paths only; on the fork path neither is true (a fork run has no auto-opened PR), so [fork.md](fork.md) (Phase 9 — fork hand-off) step 4 replaces them with the compare-URL + paste-ready hand-off.**
   - **Ticketless path:** print the stable copyable PR title `<Title>` on its own line; review the branch, open a Pull Request on GitHub (or merge locally if no remote) with that title, use "Delete branch" there after merging, and clean up locally afterwards with:
     - `git worktree remove <worktree-path>`
     - `git branch -d feature/<feature-slug>` (plus the harness-created `worktree-*` branch for that worktree, if one lingers)
   - **Ticket path:** the ready-for-review PR is **already open** (link it) and the ticket carries the single hand-off comment — review the PR by verifying the change in the running app (the PR body's "Start your review here" walks you through it via the launch-and-verify recipe; if it surfaces something, route it per that recipe's feedback step — in-scope → hold the merge and add a task, out-of-scope → the Phase 8 issue offer), merge it via GitHub's PR UI, use "Delete branch" there after merging, and clean up locally afterwards with the same two commands above.

The explicit no-`gh` git-only degrade alone reserves literal `origin` for its `git fetch origin`, `origin/<default>`, and `git push -u origin feature/<feature-slug>` guidance; all resolved maintainer operations above use `<pushRemote>`.

Do **not** open the PR yourself; the user reviews first. **On the ticket path the PR is already open** — there, do **not** merge it yourself either; the user reviews and merges via GitHub.

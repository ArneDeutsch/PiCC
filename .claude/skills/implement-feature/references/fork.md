# Fork detection & remote-agnostic repo resolution

Read this at **Phase 0** whenever a git remote exists — before the reachability gate resolves any
repo and before Phase 2 picks a base branch. It resolves, remote-name-agnostically, whether this
checkout is a **maintainer** clone (the checkout *is* the target repo) or a **fork** clone, and
produces the resolved-identities set that every later ticket read/write and the branch push depend
on. The hand-off half — pushing to the fork, the compare URL, the paste-ready PR — is this file's
Phase 9 section, added by t03.

**Key distinction — repos vs. remotes.** `gh` addresses a repository by `--repo <owner/repo>`, never
by a git-remote name: every issue read/write and the PR base are keyed on an `owner/repo`, so they
never depend on what a remote happens to be called. Exactly **one** operation needs a git remote:
pushing the feature branch. So resolve repos by `owner/repo`, and find the push remote separately, by
matching its URL — never assume the name `origin` or `upstream`.

## Resolved identities

Resolve these four once at Phase 0 and carry them through the run; t03 and t04 consume them by these
**exact** names:

- **`target`** — the upstream `owner/repo` where issues live and any PR is based. Every `gh
  issue`/`gh pr` call uses `--repo <target>`.
- **`push`** — the `owner/repo` our feature branch is pushed to: the fork on the fork path;
  **`== target`** on the maintainer path.
- **`pushRemote`** — the local git remote **name** whose URL normalizes to `push` (found by URL
  match, never assumed to be `origin`/`upstream`).
- **`targetDefault`** — the default branch of `target`; Phase 2 bases the feature branch on it.

**Maintainer collapse.** When the checkout is not a fork these degrade to today's behavior exactly:
`target == push ==` the checkout repo's `nameWithOwner`, `pushRemote` = the remote pointing at it
(`origin` in the ordinary case), `targetDefault` = the default branch resolved as today. Nothing
about the maintainer path changes — it stays byte-for-byte what it was.

## Resolution algorithm (run at Phase 0)

1. **Enumerate the remotes first.** `git remote -v`, normalizing each fetch URL to `owner/repo` —
   handle `git@github.com:o/r.git`, `https://github.com/o/r(.git)`, and `ssh://git@github.com/o/r(.git)`;
   strip a trailing `.git`. **Ignore any non-`github.com` remote** — including an **SSH host-alias**
   remote like `git@github-work:o/r.git`, whose host we can't confirm as github.com: treat it as "no
   match" (which routes to the STOP-and-ask degrade below — a safe outcome, never a wrong write).
   Dedup to the set of distinct github repos. The **push remote is found by URL match** to the resolved
   `push` repo's `nameWithOwner`, never by the name `origin`/`upstream`.
2. **Classify each distinct github repo with a PINNED query — never bare `gh repo view`.** For each,
   run `gh repo view <owner/repo> --json isFork,parent,nameWithOwner,defaultBranchRef,viewerPermission`.
   Do **not** call `gh repo view` with no arg: its base-repo heuristic, with multiple remotes present,
   frequently resolves to the **upstream** and returns `isFork:false`, silently misclassifying a fork as
   a maintainer checkout (cli/cli#6792). Pinning `--repo`/positional per remote reads each repo's own
   `isFork`/`parent` authoritatively. **Derive a parent's full name as
   `parent.owner.login + "/" + parent.name`** — gh's `parent` object exposes only `id`, `name`,
   `owner.login`; there is **no `parent.nameWithOwner`** (it returns null), so `target =
   parent.nameWithOwner` would break the entire fork path. E.g.
   `gh repo view <fork> --json parent -q '.parent.owner.login + "/" + .parent.name'`. `defaultBranchRef.name`
   is that repo's default branch; `viewerPermission` is **your** permission on **that** repo. (Verify a
   field actually exists by a trial query, not the `--json` help enumeration — e.g. `viewerPermission`
   works but isn't listed in some gh versions' help.)
3. **Decide from the classified set:**
   - **A remote repo with `isFork:true` that you can push to** (its *own* `viewerPermission` is
     `ADMIN`/`MAINTAIN`/`WRITE`) → **fork path.** `push` = that fork's `nameWithOwner`; `pushRemote` =
     that git remote; `target = parent.owner.login + "/" + parent.name`; `targetDefault =
     gh repo view <target> --json defaultBranchRef -q .defaultBranchRef.name` (the **target's** default,
     not the fork's tracking ref — see the Phase 2 note below).
   - **No fork present, and a remote repo you can push to** → **maintainer path.** `target == push ==`
     that repo; `pushRemote` = that remote; `targetDefault` resolved **git-only, as today**
     (`git symbolic-ref refs/remotes/<pushRemote>/HEAD`; if unset, `git remote show <pushRemote>`).
     Byte-for-byte unchanged in the ordinary single-`origin` case.
4. **Disambiguation & bias.** The `viewerPermission` from step 2 is your permission on **that** repo —
   on a fork you own it is `ADMIN`, which is **not** evidence of upstream access, so it must never drive
   the maintainer-vs-fork call on its own. When a candidate upstream exists, decide by querying the
   **target** explicitly and separately: `gh repo view <target> --json viewerPermission`. On the
   **target**: `ADMIN`/`MAINTAIN`/`WRITE` ⇒ you can push upstream ⇒ **maintainer**;
   `READ`/`TRIAGE`/`null`-or-absent ⇒ **fork** (the enum has no `NONE`; the field is nullable). If it is
   **still** ambiguous — multiple forks, or no remote matches a pushable repo — **STOP and ask the
   user**, echoing what you found (the `gh repo view` facts and the `git remote -v` list) but **redacting
   any credentials embedded in remote URLs** (`https://user:token@github.com/…` → strip the
   `user:token@`) before echoing — never guess which repo receives a push. When the maintainer-vs-fork
   call is genuinely uncertain, **bias toward the fork (hand-off) path**: misclassifying maintainer→fork
   only hands off a compare URL (no wrongful write), whereas fork→maintainer would attempt a write the
   user cannot perform.
5. **No-gh degrade.** If `gh` is absent/unreachable **and** no ticket ref forces the Phase 0 gate, fork
   classification can't run — degrade to **today's git-only maintainer resolution**
   (`git symbolic-ref refs/remotes/origin/HEAD`; branch from `origin/<default>`). This keeps the
   maintainer + ticketless + no-gh cell byte-for-byte as it was before F12. (A ticket ref *does* force
   the gate, which already requires `gh`, so this degrade only applies to the ticketless path.)

> **TODO (t05, Hole D):** the URL-ref-points-at-the-fork nuance — a ticket given as a full GitHub URL
> whose owner/repo is the *fork* rather than the resolved `target` — is deferred. For now the Phase 0
> rule is: **a URL ref's owner/repo must match the resolved `target`.** t05 finalizes the fork-issue
> case.

## How the identities thread into the phases

- **Phase 0 reachability gate** (resident in the router): the required pushable github remote is
  `pushRemote` (the fork on the fork path); a remoteless checkout still stops. Issue reads use
  `--repo <target>`. A URL ref's owner/repo must match `target` (see the t05 TODO above).
- **Phase 2 default branch** ([workflow-detail.md](workflow-detail.md)): base the feature branch on
  **`targetDefault`**, fetched from the **target** — on the fork path the target's freshest default may
  be absent or stale in the fork's tracking refs, so fetch it from the target, not the fork. But **do
  not branch from a bare-URL `FETCH_HEAD`** — it is per-worktree, so a fetch run before/outside the
  worktree is invisible inside it. Add the target as a **temporary named remote**, fetch it, branch
  from the shared `refs/remotes/<tmp>/<targetDefault>`, then remove the temp remote (or fetch inside the
  worktree). Branch from the *target's* default, not the fork's.
- **Rule 3 & Rule 5** ([ticket-integration.md](ticket-integration.md)): a URL ref must match
  `target`; the branch push (Rule 5's allow-list) targets `pushRemote`/`push` — still "our own
  branch," just not necessarily `origin`.
- **Phase 1 disclosure** (below): surface the fork nature the moment it's resolved, on **any** fork
  checkout — ticketless included — so the manual-PR hand-off is expected, never sprung at Phase 9.
- **Phase 9 hand-off** (below): push the branch to the fork and hand the user a compare URL +
  paste-ready PR — the **only** automatic GitHub write on the fork path is that one branch push.

## Phase 1 — fork disclosure (a new early moment, any fork checkout)

Read this at **Phase 1** whenever Phase 0 resolved a **fork** checkout. Today the only Phase 1
write-contract moment is gated on the *ticket* path (the router's "extend the scope mirror with the
write-contract"); a fork checkout with **no** ticket therefore had *no* early fork disclosure and
would first learn it's a fork when the compare URL appeared at hand-off — the exact spring this
task forbids. So the fork disclosure is a **new** Phase 1 moment that fires on **any** fork checkout,
**ticketless included**, independent of the ticket path.

Surface the fork detection result the moment it's known — fold it into the scope mirror (Phase 1),
before "go", so the manual-PR hand-off is expected. Present it as prose to the user:

> Heads up — this is a fork checkout: I can push to `<push>` but not to `<target>`. At hand-off I'll
> push the branch to your fork and hand you a compare URL plus paste-ready PR (and optional comment)
> texts so you open the PR against `<target>` yourself — which is the normal open-source contribution
> flow and is how you see and satisfy the upstream's PR template, CONTRIBUTING checklist, and any
> CLA/DCO gate. I will post nothing to `<target>` automatically.

Substitute the resolved `push`/`target` `owner/repo` names. On the **ticket** path this composes
with — does not replace — the ticket write-contract from
[ticket-integration.md](ticket-integration.md) (Per-phase ticket hooks → Phase 1): show both, so the
maintainer sees the ticket writes *and* that the PR is opened by hand against the upstream. On the
**ticketless** fork path this is the *only* Phase 1 write-contract moment. (The ticket-creation
offer's own contract lines are owned by t04; t05 reconciles both into the grid.)

If `gh` was unavailable so `target`/`push` could not be resolved (the no-gh degrade), there is no
fork disclosure to make — the run is on the git-only maintainer resolution and hands off generically
(see the Phase 9 no-gh degrade below).

## Phase 9 — fork hand-off (push to fork, compare URL, paste-ready PR)

Read this at **Phase 9** on the **fork path** (Phase 0 resolved `push != target`). It **replaces**
the "Ticket path — open the PR and post the comment" block of [handoff.md](handoff.md) with a
paste-ready hand-off; the common spine of [handoff.md](handoff.md) Phase 9 still applies — the
push/merge preamble (step 1), the CI check (step 2), ExitWorktree `action: keep` (step 3), and the
per-path final summary (step 4). The PR **body** and issue-**comment** skeletons are **single-sourced
in [handoff.md](handoff.md)** — do not re-invent them here; this section changes only the *delivery*
(handed to the user paste-ready, not posted) and the linking form (below).

**The only automatic GitHub write on the fork path is the branch push to the fork.** No `gh pr
create`, no `gh issue comment`. **Forbid** any `gh pr create --head <login>:<branch> --repo <target>`
fallback — a fork PR is opened by the user through GitHub's web UI, never by the skill.

**This is a discipline write site.** Authoring the paste-ready PR body distills from `review.md` /
`observations.md` / task logs and depends on Rule 3 (stripping stray closing keywords) and Rule 6
(no leakage). **Load [ticket-integration.md](ticket-integration.md) before distilling.** If it can't
be read, fall back to the router's resident write-discipline checklist floor and **refuse to emit
the body until the rules are available** — do not distill a body with the rules unloaded.

**Procedure:**

1. **Merge, then push to the fork.** Re-fetch the **target's** default (via a temporary named remote,
   as in Phase 2 — [workflow-detail.md](workflow-detail.md) Phase 2); if it moved, merge it into the
   feature branch, resolve conflicts, and verify typecheck + full suite green again. Then push the
   branch to the fork: `git push -u <pushRemote> feature/<NN>-<slug>`. This is the single automatic
   write.
2. **Confirm the push landed before printing the compare URL** — a URL for a branch that isn't on the
   fork 404s. Only after the push succeeds, build the URL.
3. **Compare URL — emit exactly this two-part-head form** (split `target` into
   `<target-owner>/<target-repo>`; take `<forkOwner>` from the fork's `nameWithOwner` = `push`
   (authoritative — do **not** substitute `gh api user --jq .login`, which is wrong for an org-owned
   fork); `<branch>` = `feature/<NN>-<slug>`):
   ```
   https://github.com/<target-owner>/<target-repo>/compare/<targetDefault>...<forkOwner>:<branch>?expand=1
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
4. **Present the final summary.** This **replaces** [handoff.md](handoff.md) step 4's next-steps
   bullets — both the ticketless "open a Pull Request yourself" line **and** the ticket-path "the
   ready-for-review PR is already open" line: on the fork path a ticket run has **no** open PR, so
   neither of those bullets is true here. Reuse only handoff.md step 4's framing (what was
   implemented, decisions/deviations, test status). Then give the fork next-steps:
   - The working **compare URL** (from step 3).
   - The PR **title** on its own line, copyable — a model-authored ASCII title (Rule 4), e.g.
     `F<NN>: <short description>`.
   - The PR **body** in a fenced code block, byte-exact — authored from [handoff.md](handoff.md)'s
     **PR-body skeleton** (answer every heading; "Start your review here" is a semantic verification
     guide, not a code tour). Inside that body's steps use **inline `code`, never a triple-backtick
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
     upstream in the t04 offer): use [handoff.md](handoff.md)'s skeleton top line as-is — `Closes #N`
     if Phase 8 judged the feature to **fully** deliver #N, else a bare `#N` (ticket stays open).
   - **Issue on the fork** (a URL ref pointing at a fork-hosted issue — the t05/Hole D case): a plain
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
   own is unwanted. **Optionally** hand the [handoff.md](handoff.md) issue-**comment** text as a
   *paste-ready* artifact ("if you want to leave a note on #N after opening the PR") — offer it, don't
   dump it by default. It is authored under the same discipline (via the skeleton, ending with the
   `<attribution trailer>`, Rule 6 leakage-stripped).

**Push-failure degrade** (the fork push is rejected — mirror [handoff.md](handoff.md)'s
push-rejected branch): do **not** stop cold. Lead with **"nothing is lost"** (everything is committed
on the branch in the worktree), give the actual `git`/`gh` error — but **redact any embedded
credential first**: a raw `git push` error can echo a remote URL like
`https://x-access-token:TOKEN@github.com/…`, so strip the `user:token@` before showing it, the same
redaction the Phase 0 STOP-and-ask rule applies (keep the two in lockstep). State that **nothing was posted
upstream** (name any issue the user filed earlier — e.g. via the t04 create-offer — that already
stands and was echoed when created, so they know what is already public), give the fix + the re-push
command, then hand the paste-ready PR **title**/**body** and the compare-URL **template** (to fill in
once the push succeeds). No compare URL is shown until a real push lands.

**No-gh-on-a-fork degrade.** Fork detection needs `gh repo view` (Phase 0). If `gh` is unavailable on
a fork checkout, the run cannot resolve `target`/`push`, so it degrades to today's **generic**
"push your branch and open a PR yourself" hand-off with **no** compare URL (there is no resolved
`targetDefault`/fork identity to build one). That degrade must **never** claim an auto-PR was or will
be created — the maintainer auto-PR path only runs when the checkout is confirmed to *be* the target.

**DCO / `Signed-off-by` note.** Some upstream projects require a Developer Certificate of Origin (DCO)
sign-off — a `Signed-off-by:` trailer on each commit — before a PR is accepted. This skill does
**not** auto-sign: `Signed-off-by` is deliberately kept **out** of the commit grammar. If the target
enforces DCO, the user can add `-s`/`--signoff` to their commits (or amend/rebase to add the trailer),
or use the PR UI's sign-off affordance where the project offers one. Mention this in the hand-off when
the upstream is known to gate on DCO.

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

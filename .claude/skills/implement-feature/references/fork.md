# Fork detection & remote-agnostic repo resolution

Read this at **Phase 0** whenever a git remote exists — before the reachability gate resolves any
repo and before Phase 2 picks a base branch. It resolves, remote-name-agnostically, whether this
checkout is a **maintainer** clone (the checkout *is* the target repo) or a **fork** clone, and
produces the resolved-identities set that every later ticket read/write and the branch push depend
on. The hand-off half — pushing to the fork, the compare URL, the paste-ready PR — is in
[phase-9-fork-handoff.md](phase-9-fork-handoff.md).

**Key distinction — repos vs. remotes.** `gh` addresses a repository by `--repo <owner/repo>`, never
by a git-remote name: every issue read/write and the PR base are keyed on an `owner/repo`, so they
never depend on what a remote happens to be called. Exactly **one** operation needs a git remote:
pushing the feature branch. So resolve repos by `owner/repo`, and find the push remote separately, by
matching its URL — never assume the name `origin` or `upstream`.

## Resolved identities

Resolve these four once at Phase 0 and carry them through the run; the fork hand-off and the
ticket-creation offer consume them by these **exact** names:

- **`target`** — the upstream `owner/repo` where issues live and any PR is based. Every `gh
  issue`/`gh pr` call uses `--repo <target>` — **except** the two Phase 0 ticket reads on a
  **fork-only-URL** ref (the reachability `gh api` and the preflight `gh issue view`), which key on
  the **issue-host** repo (the resolved fork `push`); see the fork-only URL-ref rule below.
- **`push`** — the `owner/repo` our feature branch is pushed to: the fork on the fork path;
  **`== target`** on the maintainer path.
- **`pushRemote`** — the local git remote **name** whose URL normalizes to `push` (found by URL
  match, never assumed to be `origin`/`upstream`).
- **`targetDefault`** — the default branch of `target`; Phase 2 bases the feature branch on it.

**Maintainer collapse.** When the checkout is not a fork these collapse to the plain single-repo
mapping: `target == push ==` the checkout repo's `nameWithOwner`, `pushRemote` = the remote pointing
at it (`origin` in the ordinary case), `targetDefault` = the default branch resolved git-only.

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
     that repo; `pushRemote` = that remote; `targetDefault` resolved **git-only**
     (`git symbolic-ref refs/remotes/<pushRemote>/HEAD`; if unset, `git remote show <pushRemote>`).
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
   classification can't run — degrade to the **git-only maintainer resolution**
   (`git symbolic-ref refs/remotes/origin/HEAD`; branch from `origin/<default>`). (A ticket ref *does*
   force the gate, which already requires `gh`, so this degrade only applies to the ticketless path.)

> **The fork-only URL-ref rule.** A URL ref must match host `github.com` and
> **either** resolved repo. Matching `target` → proceed normally. Matching the **fork only** → adopt
> the fork-hosted issue (the PR still targets `target`), but note two hazards: GitHub won't cross-link
> a fork issue to an upstream PR, and — the dangerous half — a plain `Closes #N` on the upstream PR
> would **not** close the fork issue and **would wrongly close `target`'s own same-numbered issue** if
> one exists (fork and upstream share a number sequence). So warn the user, emit a **bare cross-repo
> `<fork-owner>/<fork-repo>#N`** (no closing keyword — Phase 9 step 5 in
> [phase-9-fork-handoff.md](phase-9-fork-handoff.md)), and close the fork issue
> by hand. Matching the **fork only** also redirects the two **Phase 0 ticket reads** — the
> reachability `gh api repos/<issue-host>/issues/<N>` and the preflight `gh issue view <N> --repo
> <issue-host>` — to the fork as their **issue-host** repo (on a `target` match, or a `#N`/`N` ref, the
> issue-host is `target`). The issue-host is keyed on the resolved, cross-verified `push`
> (regex-validated `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`, already carrying `isFork:true` and
> `parent == target`) — **never** parsed out of the URL and **never** interpolated as the raw URL
> string into a `gh` call (either would bypass that cross-check): the URL is a **selector matched by
> value-equality only** (compared case-insensitively, any `..` segment rejected). Every **write**, the
> **PR base**, and the Rule 9 dedup **reads** stay on `target` — only these two reads move. Matching
> **neither** → STOP and ask. This is the detail home for the rule the resident
> Phase 0 gate (`SKILL.md`) and Rule 3 ([ticket-integration.md](ticket-integration.md)) state
> identically (those two are the single-sourced pair; this block only expands the rationale).

## How the identities thread into the phases

An index — each rule is stated in full where it points:

- **Phase 0 reachability gate** → resident in `SKILL.md` (required pushable github remote is
  `pushRemote`, the fork on the fork path; a remoteless checkout still stops; the Phase 0 issue reads
  use `--repo <issue-host>` — the resolved fork (`push`) on a fork-only-URL ref, else `target`).
- **Phase 2 default branch** → [phase-2-workspace.md](phase-2-workspace.md) (base on the target's
  **`targetDefault`**, fetched from the target via a temporary named remote, not the fork).
- **Phase 1 fork disclosure** → [phase-1-fork-disclosure.md](phase-1-fork-disclosure.md) (surface the
  fork nature the moment it's resolved, any fork checkout, so the hand-off is never sprung at Phase 9).
- **Phase 9 hand-off** → [phase-9-fork-handoff.md](phase-9-fork-handoff.md) (the **only** automatic
  GitHub write on the fork path is the one branch push to the fork).
- **The fork-only URL-ref rule** → the box above (a URL ref must match `target` **or the fork**);
  Rule 5's allow-list (the branch push targets `pushRemote`/`push`, not necessarily `origin`) →
  [ticket-integration.md](ticket-integration.md).

# t02: Fork detection & remote-agnostic repo resolution

## Goal
The skill resolves, early and remote-name-agnostically, whether the checkout is a **maintainer**
clone (the checkout *is* the target repo) or a **fork** clone, and computes two identities: the
**target/upstream repo** (`owner/repo` where issues live and any PR is based) and, on a fork, the
**push repo** + the local git remote that points at it. The Phase 0 reachability gate and the
Phase 2 default-branch/base resolution are generalized to use these instead of hard-coded `origin`.
This task adds the detection/resolution half of `references/fork.md`; the hand-off half is t03.

## Context & seams
Builds on t01's structure. New file `references/fork.md` (create it here; t03 appends its hand-off
section). The router gets a Phase 0 routing line: *"If a git remote exists, read
[references/fork.md](references/fork.md) and resolve target vs. push repo before Phase 2."*

**Firm output contract — the "resolved identities."** This task MUST define, in `references/fork.md`,
a named resolved set that t03 and t04 consume by these **exact** names (not a left-open choice — they
bind to them):
- `target` — the upstream `owner/repo` where issues live and any PR is based;
- `push` — the `owner/repo` our branch is pushed to (the fork on the fork path; == `target` on the
  maintainer path);
- `pushRemote` — the local git remote name whose URL resolves to `push` (found by URL match);
- `targetDefault` — the default branch of `target`.
On the maintainer path these collapse to `target == push == origin's repo`, `pushRemote` = that
remote, `targetDefault` = today's resolved default.

**Resolution algorithm (specify in `references/fork.md`, run at Phase 0):**
1. **Enumerate remotes first.** `git remote -v`, normalizing each URL to `owner/repo` (handle
   `git@github.com:o/r.git`, `https://github.com/o/r(.git)`, `ssh://…`). Ignore non-`github.com`
   remotes — including SSH host-alias remotes like `git@github-work:o/r.git`, which we can't confirm as
   github and therefore treat as "no match" → the STOP-and-ask path (a safe degrade, never a wrong
   write). Dedup to the set of distinct github repos.
2. **Classify each remote repo with a PINNED query — never bare `gh repo view`.** For each distinct
   github repo run `gh repo view <owner/repo> --json isFork,parent,nameWithOwner,defaultBranchRef,viewerPermission`.
   Bare `gh repo view` (no arg) uses gh's base-repo heuristic, which with multiple remotes frequently
   resolves to the **upstream** and returns `isFork:false` — silently misclassifying a fork as a
   maintainer checkout (cli/cli#6792). Pinning `--repo`/positional per remote reads each repo's own
   `isFork/parent` authoritatively. **Derive a parent's full name as
   `parent.owner.login + "/" + parent.name`** — gh's `parent` object exposes only `id`, `name`,
   `owner.login`; there is **no `parent.nameWithOwner`** (it returns null), so `target = parent.nameWithOwner`
   would break the whole fork path. (Verify field availability by a trial query, not the `--json` help
   enumeration — e.g. `viewerPermission` works but isn't listed in some gh versions' help.)
3. Decide from the classified set:
   - **A remote repo with `isFork:true` that you can push to** (its *own* `viewerPermission` is
     `ADMIN`/`MAINTAIN`/`WRITE`) → **fork path**: `push` = that fork's `nameWithOwner`, `pushRemote` =
     that git remote, `target` = `parent.owner.login + "/" + parent.name`, `targetDefault` =
     `gh repo view <target> --json defaultBranchRef -q .defaultBranchRef.name`.
   - **No fork present, and a remote repo you can push to** → **maintainer path**: `target == push ==`
     that repo; `pushRemote` = that remote; `targetDefault` resolved **git-only as today**
     (`git symbolic-ref refs/remotes/<pushRemote>/HEAD`, else `git remote show`). Byte-for-byte
     unchanged in the ordinary single-`origin` case.
4. **Disambiguation / bias.** `viewerPermission` from step 2 is the permission on **that repo** — on a
   fork you own it is `ADMIN`, which is **not** evidence of upstream access. So to decide maintainer-
   vs-fork when a candidate upstream exists, query the **target** explicitly and separately:
   `gh repo view <target> --json viewerPermission`. On the **target**: `ADMIN`/`MAINTAIN`/`WRITE` ⇒ you
   can push upstream ⇒ maintainer; `READ`/`TRIAGE`/`null`-or-absent ⇒ fork (the enum has no `NONE`; the
   field is nullable). If still ambiguous (multiple forks, or no remote matches a pushable repo),
   **STOP and ask**, echoing what was found — **redacting any credentials embedded in remote URLs**
   (`https://user:token@github.com/…`) before echoing. Bias toward the fork/hand-off path when
   genuinely uncertain: misclassifying maintainer→fork only hands off a URL (no wrongful write);
   fork→maintainer would attempt a write the user cannot perform.
5. **No-gh degrade.** If `gh` is absent/unreachable **and** no ticket ref forces the Phase 0 gate,
   fork classification can't run — degrade to **today's git-only maintainer resolution**
   (`git symbolic-ref refs/remotes/origin/HEAD`; branch from `origin/<default>`). This keeps the
   maintainer + ticketless + no-gh cell byte-for-byte as it was before F12.

**Threading (generalize these in the router + `references/ticket-integration.md`):**
- **Phase 0 gate** (currently requires an `origin` remote and, for a URL ref, owner/repo "matches
  `origin`"): restate so (a) the required pushable github remote is the **fork** on the fork path (a
  remoteless checkout still stops); (b) issue reads use `--repo <target>`; (c) a URL ref's owner/repo
  must match the **resolved target** (URL-ref-vs-fork nuance is deferred to t05, Hole D — leave a
  `TODO t05` marker or a one-line "matches target" rule here and let t05 finalize the fork-issue
  case). **Also update the gate's user-facing draft message**, which currently hardcodes "origin"
  ("no origin remote", "different repo than origin") — generalize that prose to the resolved
  target/push so the message is truthful on a fork.
- **Rule 3** in `references/ticket-integration.md`: replace "matches `origin`" with "matches the
  resolved target/upstream repo."
- **Phase 2 default branch**: today `git symbolic-ref refs/remotes/origin/HEAD`. On the fork path
  resolve the **target's** default via `gh repo view <target> --json defaultBranchRef` and base the
  feature branch on the **target's** freshest default. Fetch from the target — its commits may be
  absent/stale in the fork's tracking refs — but **do not branch from a bare-URL `FETCH_HEAD`**:
  `FETCH_HEAD` is per-worktree, so a fetch run before/outside the worktree is invisible inside it.
  Instead **add the target as a temporary named remote** (e.g. `git remote add _upstream <target-url>`),
  `git fetch _upstream`, branch from the shared `refs/remotes/_upstream/<targetDefault>`, then remove
  the temp remote — or run the fetch **inside** the worktree and branch from its tracking ref. Name
  this seam explicitly ("branch from the *target's* default, not the fork's").
- **Rule 5** (`references/ticket-integration.md`): add the clause that on the fork path the branch
  **push targets the fork remote** (still "our own branch," just not `origin`). The create-offer and
  Phase 8 filing target-repo clauses are owned by t04/t05 — do not add them here; only the push
  clause.

## Writable surface
**Note the post-t01 layout** (the skill was refactored into a router + `references/`): the reachability
gate is now **resident in `SKILL.md`** (section "GitHub ticket integration — reachability gate"); the
Phase 2 default-branch procedure lives in `references/workflow-detail.md` (Phase 2); Rules 3 & 5 live
in `references/ticket-integration.md`; the router carries skeleton phase paragraphs + routing lines.
Edit each thing where it now lives:
- `.claude/skills/implement-feature/references/fork.md` (new — detection half only)
- `.claude/skills/implement-feature/SKILL.md` (resident Phase 0 gate wording + its user-facing message;
  Phase 0/Phase 2 skeleton routing line to `fork.md`)
- `.claude/skills/implement-feature/references/workflow-detail.md` (Phase 2 default-branch → resolve the
  target's default, fetched from target)
- `.claude/skills/implement-feature/references/ticket-integration.md` (Rule 3 generalization; Rule 5 push-remote clause)

## Approach constraints
- gh addresses repos by `--repo <owner/repo>`; only the branch push needs a git remote. Keep that
  distinction explicit so reads/writes/PR-base never depend on a remote name.
- Maintainer path must remain byte-for-byte behavior-equivalent to post-t01 (target==push==origin's
  repo). The generalization must collapse to today's behavior when `isFork == false`.

## Left open
- Exact prose and section headings within `references/fork.md`.

## Testing
Prose-only; no runtime code. The t01 guard test must still pass (new `references/fork.md` is linked
from the router, so the bidirectional "linked ⇔ exists" assertion covers it). **Watch the router-size
guard:** the Phase 0/Phase 2 rewrites add resident prose under the hard `≤ REINJECT_PER_SKILL_MAX_CHARS`
gate the pre-commit hook enforces — if a new routing line pushes the router over cap, relocate prose
into `references/fork.md`, never cut content. No new behavioral unit test is possible for a prose
skill; correctness is established by review against this spec and the security findings.

## Acceptance criteria
- [ ] `references/fork.md` defines the remote-agnostic resolution algorithm, the disambiguation/bias
      rule, and the STOP-and-ask case.
- [ ] The `{target, push, pushRemote, targetDefault}` resolved-identities set is defined with those
      exact names as a firm output t03/t04 consume; maintainer collapse stated.
- [ ] The Phase 0 gate's user-facing message no longer hardcodes "origin".
- [ ] Phase 0 gate, Phase 2 default-branch, and Rule 3 are generalized from `origin` to the resolved
      target; maintainer path collapses to today's behavior.
- [ ] Rule 5 notes the fork-push-to-fork-remote clause; create-offer/Phase 8 target clauses left to t04/t05.
- [ ] Router links `references/fork.md` at Phase 0 with a when-to-read line.
- [ ] typecheck and full test suite green

## Depends on
t01

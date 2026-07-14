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
1. `gh repo view --json isFork,parent,nameWithOwner,defaultBranchRef,viewerPermission` on the
   checkout's repo. (Verify these fields exist in the installed gh during implementation; all are
   documented.)
2. `git remote -v`, normalizing each URL to `owner/repo` (handle `git@github.com:o/r.git`,
   `https://github.com/o/r(.git)`, `ssh://…`); ignore non-github remotes. The **push remote is found
   by URL match to the resolved push repo's `nameWithOwner`, never by the name `origin`/`upstream`.**
3. Decide:
   - `isFork == false` → **maintainer path**. `target == push == nameWithOwner`. Unchanged behavior.
   - `isFork == true` → **fork path**. `target = parent.nameWithOwner`; `push = nameWithOwner` (the
     fork); push remote = the git remote whose normalized URL equals the fork's `nameWithOwner`.
4. **Disambiguation / bias:** if ambiguous (a maintainer with fork remotes added, multiple github
   remotes, or no remote matches the resolved push repo), use `viewerPermission` on the target
   (`ADMIN/MAINTAIN/WRITE` ⇒ maintainer; `READ/NONE` + a fork present ⇒ fork). If still ambiguous,
   **STOP and ask the user**, echoing exactly what was found — never guess which repo receives a
   push. When the maintainer-vs-fork call is genuinely uncertain, **bias toward the fork (hand-off)
   path**: misclassifying maintainer→fork only hands off a URL (no wrongful write); fork→maintainer
   would attempt a write the user cannot perform.

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
  feature branch on the **target's** freshest default (fetch from the target, whose commits may be
  absent/stale in the fork's tracking refs). Name this seam explicitly ("branch from the *target's*
  default, not the fork's").
- **Rule 5** (`references/ticket-integration.md`): add the clause that on the fork path the branch
  **push targets the fork remote** (still "our own branch," just not `origin`). The create-offer and
  Phase 8 filing target-repo clauses are owned by t04/t05 — do not add them here; only the push
  clause.

## Writable surface
- `.claude/skills/implement-feature/references/fork.md` (new — detection half only)
- `.claude/skills/implement-feature/SKILL.md` (Phase 0 gate wording, Phase 2 default-branch, routing line)
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

# F06 Review: GitHub ticket integration for implement-feature

## Outcome

Shipped as planned: the `implement-feature` skill gained an **optional** GitHub-ticket path, entirely
additive — invoked with no argument it behaves exactly as before. With a ticket ref (`#N`, `N`, or an
issue URL) it runs a Phase-0 `gh` reachability/preconditions gate, scopes the Phase 1 direction
conversation from the issue, discloses the write-contract before "go", posts a kickoff comment once
the branch exists, folds a close-vs-keep-open judgement + a write preview into the Phase 8 gate, and
at hand-off auto-opens a ready-for-review PR linked to the ticket (`Closes #N` when fully delivered,
bare `#N` when partial) plus a reviewer-facing summary comment. A nine-rule GitHub-integration
discipline block governs every public write (untrusted text as data, `--body-file` only,
model-authored title/slug, `#N`-from-invocation-only, three-action write allow-list, attribution
trailers, idempotent-on-resume). The change is prose-only (`SKILL.md` + a `CHANGELOG` entry); no
`src/` change, no capability-registry impact. Delivered as a single task — the whole feature is one
tightly-interlocking edit to one file. No deviation from the approved scope.

## Planning errors & spec gaps

- **Idempotency was specified asymmetrically.** The plan's Rule 9 guarded the kickoff comment and
  `gh pr create` against a resumed run but omitted the third public write — the Phase 9 summary
  comment — so a resume would double-post it. Caught independently by two diff reviewers. Root cause
  was the spec (Rule 9 + acceptance named only two of three writes). Lesson: when a feature adds N
  public side-effects, the resume guard must enumerate all N.
- **Cross-rule contradiction.** Rule 9's "refresh the summary on the PR" implied `gh pr edit`, which
  Rule 5's three-action allow-list forbids without approval — two rules authored separately and never
  cross-checked. Lesson: when one rule is an allow-list and another prescribes an action, reconcile
  them at authoring time.
- **The un-file-able injection sink was nearly missed.** The model-authored-ASCII rule initially
  covered only the branch slug; the PR `--title` (no `--title-file` in `gh`) is the one untrusted-text
  sink that can't use `--body-file`. Caught in plan review. Lesson: enumerate every sink that takes
  untrusted text and mark which cannot be file-fed.
- **Preview-before-`review.md` ordering seam.** Phase 8 previews/confirms the summary text before
  `review.md` (a listed source) exists. Reconcilable (the underlying `observations.md`/logs exist at
  preview time) but the prose didn't say so until a fix clarified it.

## Friction

- **A prose-only change carried a real security surface.** No `src/`, so the authored prose is the
  *only* guardrail — the review load (security + parity + adversarial passes) was closer to a code
  change than a docs change. Worth pricing that in for future skill-behavior features.
- **Subagent dispatch paths pointed at the main checkout** (`doc/plan/06-...`) while the plan files
  existed only in the worktree; the implementer read them in the worktree without trouble, but
  worktree-relative paths would be cleaner.
- **Prior-art discovery took a branch scan, not a plan-folder scan.** The cancelled F03 epic had no
  `doc/plan/03` folder on `main` but did have a repo-global branch — only `git branch --list` surfaced
  it.

## Bugs discovered

- None in existing code. The cancelled **F03** (`feature/03-github-workflow`) branch remains unmerged
  and is now explicitly abandoned/out of scope.

## Improvement opportunities

- **Permission-profile backstop.** Every reviewer noted the real enforcement of the `gh`/`git`
  allow-list is PiCC's permission engine gating Bash, not the skill prose. If a project's
  `settings.json` broadly allows `Bash(gh:*)`, Rule 5 is advisory only. A recommended deny-profile for
  the ticket path (`gh pr merge`, force-push, `gh issue create/close/edit`) would make the allow-list
  enforceable rather than advisory.
- **Live end-to-end validation.** The feature was verified by static prose walkthrough + the existing
  suite (no `src/` change to exercise). A real dogfood run of `implement-feature <issue>` against a
  throwaway issue would validate the `gh` command grammar and the kickoff/summary/PR flow in practice.

## Proposed follow-ups

- **F: Recommended permission profile for the ticket path** — ship a settings snippet / doc that makes
  the three-action write allow-list enforceable via the permission engine, closing the prose-vs-engine
  gap. (Small.)
- **Dogfood pilot** — run the new ticket path on the next real maintainer issue and record what the
  `gh` grammar and the two-comment flow actually do; fold any friction into a follow-up. (Not a
  feature; a validation task.)
- **Optional: bare-ticketless auto-PR** — the user deferred auto-opening a PR when no ticket is given.
  If that turns out to be wanted, it's a small additive change to the Phase 9 ticketless path.

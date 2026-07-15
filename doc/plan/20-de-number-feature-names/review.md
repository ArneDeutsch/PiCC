# F20 Review: Description-Based Feature Naming

## Outcome
Future `implement-feature` runs now use one validated descriptive slug across worktree, branch, plan folder, headings, commits, and hand-off paths instead of allocating a global feature number. GitHub issue numbers remain the canonical numeric reference and task ordering remains local. Existing numbered runs have an explicit end-to-end legacy resume override and historical artifacts remain untouched. The feature stayed prose/test-only as agreed; close review added remote-agnostic maintainer routing, stricter resume trust and title consistency, honest race handling, and a successful ticketless PiCC smoke run.

## Planning errors & spec gaps
- The initial plan promised stronger concurrent collision protection than the create-or-reenter `EnterWorktree` API can provide without runtime changes; the contract was narrowed to visible preflight checks plus an explicit residual-race disclosure.
- The first pre-push collision rule treated every existing remote branch as foreign, which would have blocked resumed hand-offs and CI-fix pushes. The final contract distinguishes absent first publication from confirmed, exact-upstream, non-diverged repushes.
- Resume artifact agreement was initially treated as authorization. Review established that disk consistency proves identity only; a fresh target match and explicit human confirmation are required before public writes.
- Legacy preservation was initially stated without a usable downstream mapping. A delimited override now carries the established branch, paths, headings, commit grammar, PR/CI head, and cleanup commands through every remaining phase.
- The stable display-title contract initially left commit-title and ticket create/dedup/cache seams underspecified; they now share one frozen value with localized regression checks.

## Friction
- Structural prose tests passed early while lifecycle tuples were still contradictory. Assertions had to become localized by consuming file and explicit about resume, collision, push, title, and legacy seams.
- Review exposed several interactions outside the obvious numbering tokens: fork hand-off, idempotent repush, remote-name resolution, resume authorization, and shell-safe public titles.
- One full-suite run executed concurrently with typecheck crossed an existing hook-runner timing threshold; isolated and serial full-suite reruns were green.
- The first real PiCC smoke produced the correct descriptive artifacts but skipped the required visible identity/race announcement. Stronger presentation wording and tests led to a successful second run.

## Bugs discovered
- **Fixed here:** maintainer Phase 2/9 instructions still hard-coded `origin` despite Phase 0 resolving `pushRemote`, which could base or publish through the wrong remote in nonstandard checkouts.
- **Still open:** `EnterWorktree` has no atomic create-only mode. In the remaining preflight-to-call race it can delete a newly appeared unregistered directory, adopt a harness branch, seed files, and run hooks before the workflow can reliably detect the collision. The skill now discloses this honestly but cannot remove it prose-only.
- **Still open, pre-existing:** fork-only issue URLs are described as adoptable while one reachability read still targets the upstream repository, risking same-number issue confusion. This was not introduced by de-numbering.

## Improvement opportunities
- Add atomic create-only/no-reuse worktree semantics so feature identity reservation cannot delete or adopt raced state before branch validation.
- Normalize every persisted ticket anchor to target-qualified `<owner/repo>#N`, making target drift mechanically detectable on resume.
- A deterministic scenario harness for skill workflows could complement structural prose assertions, though real model behavior remains nondeterministic and comparatively expensive.
- Tie case-fold assertions to each collision namespace individually if future edits make the current centralized contract hard to audit.

## Proposed follow-ups
- **Atomic create-only worktree entry:** add a `mustCreate`/no-reuse path that fails before directory deletion, harness-branch adoption, seeding, or create hooks; this would close the principal race deliberately left outside #26.
- **Harden ticket target identity:** fix fork-only URL routing and persist all given tickets as target-qualified anchors so resume cannot silently reinterpret `#N` after remote changes.
- **Consider a skill scenario smoke harness:** automate a disposable ticketless run through identity announcement and Phase 3 if a stable, low-cost model-driven test can be designed without flaky semantic assertions.

# Common-flow phase detail (Phases 1, 2, 3, 4, 5, 6, 7, 8)

The router's phase spine is a skeleton; this file carries the full, path-independent procedure for the
phases whose depth doesn't fit the resident budget. Read the relevant section when the coordinator
enters that phase. Ticket-path and fork-path depth live in
[ticket-integration.md](ticket-integration.md) and [handoff.md](handoff.md); the three plan-folder
templates live in [templates.md](templates.md).

## Phase 1 — Direction (WHAT / WHY)

Ask the user for initial direction in prose. Discuss what the feature should do and why it's worth building — user value, scope, non-goals. Stay off implementation details.

In the background you may scout to keep the dialog grounded: read code, check `doc/architecture.md`, `doc/supported-features.md`, existing plans in `doc/plan/` — especially earlier features' `review.md` files, which record known friction, discovered bugs, and deferred opportunities that may intersect with this feature; spawn specialists (or `generalist` for a broad cross-surface question) in investigate mode, or search the web for anything unclear. Use what you learn to ask better questions, not to steer into HOW.

Converge, then present a **scope mirror** before asking for the go:

> You asked for: …
> This feature WILL: …
> This feature will NOT (deferred/out of scope): …

The user confirms the boundary. Only an explicit "go" moves you to Phase 2. **Write nothing into the repo before Phase 2.** With a ticket present, open Phase 1 from the cached issue and extend the scope mirror with the write-contract — [ticket-integration.md](ticket-integration.md) (Per-phase ticket hooks → Phase 1). On **any fork checkout** — ticketless included — also **disclose the fork nature** in the scope mirror here (a new early moment, independent of and composable with the ticket write-contract): [fork.md](fork.md) (Phase 1 — fork disclosure). This is the fork path's "surfaced early" guarantee — it prevents the compare-URL hand-off from being sprung at Phase 9.

## Phase 2 — Workspace

1. **Default branch — the *target's*, not the fork's.** This is `targetDefault` from [fork.md](fork.md). On a **maintainer** checkout (incl. the no-gh degrade) resolve it as today: `git symbolic-ref refs/remotes/origin/HEAD` (if that ref isn't set, `git remote show origin`), `git fetch`, and branch from `origin/<targetDefault>`, not from a possibly stale local ref. On a **fork** checkout, resolve the target's default via `gh repo view <target> --json defaultBranchRef -q .defaultBranchRef.name` and base the feature branch on the **target's** freshest default. Its commits may be absent or stale in the fork's own tracking refs, so fetch from the target — but **do not branch from a bare-URL `FETCH_HEAD`**: it is per-worktree, so a fetch run before/outside the worktree is invisible inside it. Instead **add the target as a temporary named remote** (e.g. `git remote add _upstream <target-url>`), `git fetch _upstream`, and branch from the shared `refs/remotes/_upstream/<targetDefault>` (step 3), then remove the temp remote (`git remote remove _upstream`) — or run the fetch **inside** the worktree and branch from its tracking ref. Never branch from the fork's default. If there is **no remote**, ask the user which branch to base on and note that Phase 9 will hand off locally instead of pushing.
2. **Feature id.** Next free `<NN>` in `doc/plan/` plus a short slug, e.g. `03-hook-timeouts` — on the ticket path, author the slug yourself per **Rule 4** (never seed it from the raw issue title; ASCII only), since it flows straight into the `git switch -c` / `--head` command line (the top-level `picc-plan.md` there is the project plan, not a feature folder — ignore it when numbering). Plan folders from parallel in-flight sessions live only in their worktrees, so also check `git branch --list "feature/<NN>-*"` — branches are repo-global — and bump `<NN>` past any hit. The id renders as `03` in folder/branch names, `f03` in commits, `F03` in spec headings.
3. **Worktree, then branch.** EnterWorktree does not take a branch — it creates its own. So: **EnterWorktree first** (name it `<NN>-<slug>`), then **inside the worktree** create the real branch: `git switch -c feature/<NN>-<slug> <base>`, where `<base>` is the fetched `targetDefault` from step 1 (`origin/<targetDefault>` on a maintainer checkout; the temp remote's tracking ref `refs/remotes/_upstream/<targetDefault>` on a fork; local `<targetDefault>` if no remote). On a fork, remove the temp remote once the branch exists. Never create or switch branches in the main checkout — that is what keeps parallel sessions from colliding. If the branch already exists, an earlier session made it: ask the user whether to continue on it or pick a fresh id. If EnterWorktree is unavailable or fails, stop and ask the user — do not fall back to working in the main checkout.
4. **Bootstrap and baseline.** A fresh worktree may lack `node_modules` — run `npm ci` if needed. Then run `npm run typecheck` and `npm test` once to establish the baseline. If either is already red, surface it to the user before doing anything else: either fix that first (its own task) or record the known-red set and gate later steps on "no *new* failures".

Nothing is posted to a linked ticket in this phase. On the ticket path the branch stays local and the ticket stays untouched until hand-off (Phase 9), where the single automated comment is posted — so a run cancelled between here and then never leaves a stray "work started" note to walk back.

## Phase 3 — Feature spec

Create `doc/plan/<NN>-<slug>/` and write `feature.md` (template in [templates.md](templates.md)): the WHAT and WHY, explicitly **no HOW** — no file names, no interfaces, no design. Leave the `## Tasks` section as the placeholder `(filled in during task breakdown)`. If a HOW thought feels important, park it in your notes for Phase 4; putting it in feature.md anchors the design prematurely.

## Phase 4 — HOW investigation

Now work out how to build it. Fan out to the relevant specialists — and `generalist` for cross-surface questions no single specialist owns — in investigate mode with concrete questions (where does this hook into the code? what are the risks? what does Claude Code do here? what must tests cover?). Search the web where external behavior matters (Claude Code semantics, library APIs). Integrate the reports into one coherent technical picture: chosen approach, seams to existing code, risks, open questions.

Decide what you can; escalate to the user only what is direction-deciding. Small technical questions: batch them rather than interrupting repeatedly.

## Phase 5 — Task breakdown

Split the work into tasks, each sized for one implementer subagent in one context. For each, write `tasks/t<NN>-<slug>.md` (template in [templates.md](templates.md); task numbering is independent of the feature number). Order them by dependency; prefer an order where each task leaves the suite green. Then **backfill the `## Tasks` section of feature.md** with the ordered titles and dependencies.

A task spec must be **self-contained**: task spec + feature.md is all the *feature context* the implementer gets. Precision goes to the *seams* — where the task touches existing code and where it touches other tasks (names, shapes, contracts must match across specs). Inside the task, leave breathing room: state the goal and constraints, not pre-written code. List deferred decisions under "Left open".

## Phase 6 — Plan review & approval

Fan out reviewers over the whole plan folder (feature.md + all task specs), in parallel, in review mode:

- Each **relevant specialist**: "Is your aspect completely covered by this plan? What's missing?"
- An **adversarial reviewer** (`generalist`): find holes, contradictions, unstated assumptions, seam mismatches between task specs, missed edge cases in the WHAT/WHY/HOW.
- An **end-user walkthrough** (`user-experience`): walk through the feature as the person using it, start to finish — does the plan actually deliver the promised experience?

Integrate the findings. Fix what's clearly right directly in the plan files. Escalate to the user: anything changing the WHAT/WHY, and any major HOW concern with real tradeoffs. Iterate (further review rounds only for substantial changes) until you and the user both accept — re-show the scope mirror if scope moved. Then commit the plan folder: `f<NN>: plan — <title>`.

## Phase 7 — Implementation loop

For each task, in planned order:

1. **Dispatch** a fresh `implementer` subagent with the paths to feature.md and its task spec, and these standing rules (relay them into the dispatch prompt):
   - Read both files first; work in the worktree at `<path>`.
   - Stay inside the writable surface. No workarounds, no mocking-away of problems, no scope creep.
   - Never run `git commit` or `git push` — the coordinator owns all commits.
   - `npm run typecheck` and `npm test` must be green (or no new failures vs. the recorded baseline).
   - Keep an execution log at `log/t<NN>.md` in the plan folder (always part of the writable surface): brief bullets while working — key decisions (especially on "Left open" items), deviations from the spec, friction, anything surprising found in the existing code.
   - If the task cannot be implemented as specified, stop and report precisely why instead of improvising.

   It reports what it did, test results, and any deviations. Fix subagents get the same rules plus the accepted findings, and append to the same log.
2. **On escalation**, apply the boundary: fixable within this task's own spec → update the spec and re-dispatch a fresh subagent. Touches other tasks' contracts or the feature scope → stop, discuss with the user, update the plan, then continue. Before any re-dispatch, deal with the aborted attempt's leftovers: either reset the working tree to the last commit (keep the log file), or tell the new subagent exactly what partial work exists and whether to build on it.
3. **Review fan-out**: pick reviewers by surface touched (see roster; `coder` for any code, `security` whenever execution/permissions/paths are involved, `tester` when coverage might be thin, `docs`/`user-experience`/`claude-parity` when their surfaces moved). Give each the worktree path and have it run `git diff HEAD` there itself, plus the task spec and execution log: is the task *fully* done per spec? What must be fixed? What should be refactored (duplication, extraction, dead code, missing tests, unclear docs)? Also ask them to flag friction with the spec or process itself — that feeds `observations.md`.
4. **Triage and fix**: weigh the findings; drop what's wrong, apply trivial fixes yourself, dispatch an `implementer` (fix mode) for larger ones. Re-review only what a fix meaningfully changed. Don't loop forever — after ~3 non-converging rounds, take it to the user.
5. **Distill observations**: skim the execution log and review reports and append what matters to `observations.md` in the plan folder — friction, planning errors, bugs discovered in existing code, refactoring opportunities, process weaknesses. Dated bullets, one line each; this is raw material for `review.md`, not prose. Surface anything major (a real bug, a plan built on a wrong assumption, a systemic process problem) to the user right away rather than sitting on it until close.
6. **Gate and commit**: verify yourself that typecheck and the full suite are green, then commit everything of the task — including its log and the observations update: `f<NN>: t<NN> — <description>`.

## Phase 8 — Feature close review

When all tasks are committed, review the whole feature against feature.md:

- Fan out the full relevant roster over the complete feature diff (`git diff <default-branch>...HEAD`) + feature.md: is the WHAT fully delivered? Anything half-done, inconsistent, undocumented?
- Add one adversarial completeness check (`generalist`): "what would a skeptical reviewer of the PR find missing?"

Integrate. Small fixes: do them (with review as in Phase 7, proportionate). Real gaps: define new task specs (continue the task numbering, update feature.md's `## Tasks`) and run them through Phase 7. If the gap questions the WHAT/WHY, talk to the user. Done when you judge the feature complete and the user has been shown a short completion summary and agrees.

Also make sure the repo's own records are current before closing: CHANGELOG entry, docs, and `npm run gen:capabilities` if the capability registry changed (the `docs` reviewer should have caught these — this is the backstop).

Then write the feature's `review.md` (template in [templates.md](templates.md)) by distilling `observations.md`, the task logs, and your own judgment of the cycle. This is the learning record: planning errors, friction, bugs found along the way, refactoring and improvement opportunities, and concrete follow-up proposals — future planning sessions read it, and process/system weaknesses it records are how this workflow itself gets improved. Present the major findings and proposed follow-ups to the user (they may become the next features). Commit: `f<NN>: review — <title>`.

The ticket-path close hooks (close-vs-keep-open judgement + write preview) and the either-path issue-filing offer run inside this same close gate; their full text is in [ticket-integration.md](ticket-integration.md) (Per-phase ticket hooks → Phase 8). **Read it before any such write, and refuse the write if it cannot be read.**

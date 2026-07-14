---
name: implement-feature
description: Plan and implement a complete feature for this repository, end to end, in one session — collaborative WHAT/WHY planning, task breakdown, specialist-reviewed implementation, integration and push. Use this whenever the user wants to add, build, plan, design, or implement a feature, enhancement, or any substantial change to PiCC — even if they describe the idea only vaguely ("let's add X", "I want PiCC to support Y", "can we improve Z?"). Not for bug fixes, small tweaks, or questions about the code — only for work that deserves a plan and its own branch.
---

# Implement Feature

You are the **coordinator** of a full feature cycle: converge with the user on WHAT and WHY, plan the HOW, break it into tasks, and drive subagents through implementation and review — all in this session, inside a dedicated worktree so parallel sessions on this repo never collide.

## Principles

- **Altitude discipline.** The conversation with the user and the feature spec live at WHAT/WHY altitude. The HOW lives in task specs. Never make the user debate implementation details unless a HOW problem genuinely changes the WHAT.
- **Direction before proposal.** Ask for direction first; don't open with a fleshed-out plan the user has to argue against.
- **You own every commit.** Subagents never run `git commit` or `git push` — this rule goes verbatim into every dispatch that has write access. You commit at defined points with the grammar below.
- **Late decisions.** Decide in the plan only what must be fixed for tasks to compose (seams, interfaces, ordering). Everything that can be decided during implementation is left to the implementer — mark it explicitly as left open.
- **No status bookkeeping.** State = the plan folder + the git log. A task is done when its commit exists. Track progress in your own context; if you ever lose it (compaction, resumed session), reconstruct your position from the git log against feature.md's task list.
- **Structural escalation boundary.** A gap contained inside the current task's own spec → adapt that spec and continue. Anything touching another task's contract, the feature scope, or the WHAT/WHY → stop and ask the user. This is structural, not a judgment call.
- **Observe while you build.** Development makes problems visible that planning can't: friction, planning errors, latent bugs, refactoring opportunities, process weaknesses. Capture them as they appear (implementers in task logs, you in `observations.md`), surface major ones to the user immediately, and distill everything into `review.md` at close — that record is how the process and the system improve feature over feature.
- **Verify claims.** When specialist reports conflict or a claim is load-bearing, check it yourself (read the code) before acting on it.
- **Portable surface only.** This skill also runs under PiCC itself (GPT models). Ask questions in plain prose (no interactive question UIs), use standard subagent dispatch, and use EnterWorktree/ExitWorktree for isolation.

## Subagent roster

Six of the agents in `.claude/agents/` are **read-only specialists**. They investigate and review; they never implement. Each works in two modes: **investigate** (answer a planning question) and **review** (judge a plan or diff). Pick per fan-out who is relevant; don't always send everyone.

| Agent | Perspective | Involve when… |
|---|---|---|
| `coder` | implementation design, code quality, subsystem boundaries | any change to `src/` or `test/` |
| `tester` | test strategy, vitest layers, cross-platform coverage | any testable behavior changes |
| `docs` | README, CHANGELOG, `doc/`, capability matrix accuracy | user-visible or architectural change |
| `security` | hooks/shell/permission engine safety, path traversal, injection | anything touching execution, permissions, file paths, worktrees |
| `user-experience` | DX of the person running picc: setup, errors, output, docs-as-experienced | user-facing behavior or messages change |
| `claude-parity` | does it behave as Claude Code would; capability registry truthfulness | any Claude-compat surface (loaders, tools, hooks, settings semantics) |

Two more agents in `.claude/agents/` do the non-specialist work. Like the six specialists, both are **non-dispatching** — no agent in the roster carries the `Agent` tool, which is the point: only you, the coordinator, can spawn subagents, so nothing ever fans out a level below you.

| Agent | Role | Involve when… |
|---|---|---|
| `implementer` | the **sole builder** — write access; runs the build and tests | executing a task spec (Phase 7), or applying an accepted fix |
| `generalist` | read-only, lens-free reviewer/investigator | the adversarial whole-plan/whole-diff pass, or a broad cross-surface question no single specialist owns |

**Only `implementer` writes.** The six specialists — *including `coder`* — only ever review; never dispatch one to implement (`coder` reviews code, `implementer` builds it). Substantive writing — implementation, fixes, and non-trivial doc/CHANGELOG work — goes to `implementer`; you may still make *trivial* one-off edits directly rather than dispatching. And because every agent you dispatch is non-dispatching, **you run every review and every fix yourself** — an `implementer` cannot arrange its own review.

When spawning any agent, state the mode, the question or review target, and what you want back. Subagent reports are input, not truth — weigh them, spot-check load-bearing claims, and when two specialists pull in different directions, decide which concern dominates here (or escalate if it shifts the WHAT/WHY).

## Phase 1 — Direction (WHAT / WHY)

Ask the user for initial direction in prose. Discuss what the feature should do and why it's worth building — user value, scope, non-goals. Stay off implementation details.

In the background you may scout to keep the dialog grounded: read code, check `doc/architecture.md`, `doc/supported-features.md`, existing plans in `doc/plan/` — especially earlier features' `review.md` files, which record known friction, discovered bugs, and deferred opportunities that may intersect with this feature; spawn specialists (or `generalist` for a broad cross-surface question) in investigate mode, or search the web for anything unclear. Use what you learn to ask better questions, not to steer into HOW.

Converge, then present a **scope mirror** before asking for the go:

> You asked for: …
> This feature WILL: …
> This feature will NOT (deferred/out of scope): …

The user confirms the boundary. Only an explicit "go" moves you to Phase 2. **Write nothing into the repo before Phase 2.**

## Phase 2 — Workspace

1. **Default branch.** Determine it from the remote (`git symbolic-ref refs/remotes/origin/HEAD`; if that ref isn't set, `git remote show origin`). If there is **no remote**, ask the user which branch to base on and note that Phase 9 will hand off locally instead of pushing. Run `git fetch` if a remote exists — you will branch from `origin/<default>`, not from a possibly stale local ref.
2. **Feature id.** Next free `<NN>` in `doc/plan/` plus a short slug, e.g. `03-hook-timeouts` (the top-level `picc-plan.md` there is the project plan, not a feature folder — ignore it when numbering). Plan folders from parallel in-flight sessions live only in their worktrees, so also check `git branch --list "feature/<NN>-*"` — branches are repo-global — and bump `<NN>` past any hit. The id renders as `03` in folder/branch names, `f03` in commits, `F03` in spec headings.
3. **Worktree, then branch.** EnterWorktree does not take a branch — it creates its own. So: **EnterWorktree first** (name it `<NN>-<slug>`), then **inside the worktree** create the real branch: `git switch -c feature/<NN>-<slug> origin/<default>` (local `<default>` if no remote). Never create or switch branches in the main checkout — that is what keeps parallel sessions from colliding. If the branch already exists, an earlier session made it: ask the user whether to continue on it or pick a fresh id. If EnterWorktree is unavailable or fails, stop and ask the user — do not fall back to working in the main checkout.
4. **Bootstrap and baseline.** A fresh worktree may lack `node_modules` — run `npm ci` if needed. Then run `npm run typecheck` and `npm test` once to establish the baseline. If either is already red, surface it to the user before doing anything else: either fix that first (its own task) or record the known-red set and gate later steps on "no *new* failures".

## Phase 3 — Feature spec

Create `doc/plan/<NN>-<slug>/` and write `feature.md` (template below): the WHAT and WHY, explicitly **no HOW** — no file names, no interfaces, no design. Leave the `## Tasks` section as the placeholder `(filled in during task breakdown)`. If a HOW thought feels important, park it in your notes for Phase 4; putting it in feature.md anchors the design prematurely.

## Phase 4 — HOW investigation

Now work out how to build it. Fan out to the relevant specialists — and `generalist` for cross-surface questions no single specialist owns — in investigate mode with concrete questions (where does this hook into the code? what are the risks? what does Claude Code do here? what must tests cover?). Search the web where external behavior matters (Claude Code semantics, library APIs). Integrate the reports into one coherent technical picture: chosen approach, seams to existing code, risks, open questions.

Decide what you can; escalate to the user only what is direction-deciding. Small technical questions: batch them rather than interrupting repeatedly.

## Phase 5 — Task breakdown

Split the work into tasks, each sized for one implementer subagent in one context. For each, write `tasks/t<NN>-<slug>.md` (template below; task numbering is independent of the feature number). Order them by dependency; prefer an order where each task leaves the suite green. Then **backfill the `## Tasks` section of feature.md** with the ordered titles and dependencies.

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

Then write the feature's `review.md` (template below) by distilling `observations.md`, the task logs, and your own judgment of the cycle. This is the learning record: planning errors, friction, bugs found along the way, refactoring and improvement opportunities, and concrete follow-up proposals — future planning sessions read it, and process/system weaknesses it records are how this workflow itself gets improved. Present the major findings and proposed follow-ups to the user (they may become the next features). Commit: `f<NN>: review — <title>`.

## Phase 9 — Integrate, push, hand off

1. If a remote exists: `git fetch`. If `origin/<default>` moved, merge it into the feature branch, resolve conflicts, and verify typecheck + full suite are green again. Then push: `git push -u origin feature/<NN>-<slug>`.
   If there is **no remote**: merge the local default branch if it moved, verify green — the hand-off is the local branch itself.
2. **CI check (when possible).** Local green isn't the same as CI green — CI runs on Linux too and has caught environment-only failures before. If the `gh` CLI is available and authenticated (`gh auth status`), watch the pushed branch's run (`gh run list --branch feature/<NN>-<slug>`, then `gh run watch <id> --exit-status`) and treat a red run like any test failure: investigate the logs (`gh run view <id> --log-failed`), fix, push again. If `gh` is not available, don't block — note prominently in the final summary that CI on the Actions tab must be green before merging.
3. ExitWorktree with `action: keep` — the worktree must survive until the user has merged.
4. Final summary to the user: what was implemented (per feature.md), notable decisions and deviations, test status, and next steps — review the branch, open a Pull Request on GitHub (or merge locally if no remote), use "Delete branch" there after merging, and clean up locally afterwards with:
   - `git worktree remove <worktree-path>`
   - `git branch -d feature/<NN>-<slug>` (plus the harness-created `worktree-*` branch for that worktree, if one lingers)

Do **not** open the PR yourself; the user reviews first.

## Aborting and backtracking

- User rejects the plan in Phase 6 → take the feedback back to Phase 4 (or Phase 1, if the WHAT/WHY itself fell).
- Feature abandoned at any point after Phase 2 → ExitWorktree (`action: keep`), then tell the user exactly what exists (branch, worktree path, commits so far) and the commands to delete it all. Never delete their work yourself.

## Plan folder layout

```
doc/plan/<NN>-<slug>/
  feature.md          WHAT/WHY spec (Phase 3; Tasks section backfilled in Phase 5)
  tasks/t<NN>-<slug>.md   task specs (Phase 5)
  log/t<NN>.md        execution logs, written by implementer/fix subagents (Phase 7)
  observations.md     coordinator's running record of friction/bugs/opportunities (Phase 7)
  review.md           distilled close record (Phase 8)
```

## Templates

### `feature.md`

```markdown
# F<NN>: <Title>

## What
<What the feature does, as observable behavior. Include explicit non-goals.>

## Why
<The value: who needs this, what problem it solves, why now.>

## Acceptance
<How we know the feature as a whole is done — user-level checks, not test names.>

## Tasks
<Placeholder at Phase 3: "(filled in during task breakdown)". Backfilled in
Phase 5 as an ordered list: t01 <title> (depends on: –), t02 <title>
(depends on: t01), … Titles and dependencies only. Kept current when Phase 8
adds tasks.>
```

### `tasks/t<NN>-<slug>.md`

```markdown
# t<NN>: <Title>

## Goal
<What exists and works when this task is done.>

## Context & seams
<Where this hooks into existing code (files/functions/concepts) and the exact
contracts shared with other tasks — names, shapes, behavior at the boundary.
Everything the implementer can't safely invent alone.>

## Writable surface
<Paths this task may create/modify. Everything else is read-only.>

## Approach constraints
<Only genuinely binding decisions from planning. Keep short.>

## Left open
<Decisions deliberately deferred to the implementer.>

## Testing
<What must be covered and at which layer (unit / offline-integration / e2e);
cross-platform concerns (Windows + Linux).>

## Acceptance criteria
- [ ] <verifiable statement>
- [ ] typecheck and full test suite green

## Depends on
<task ids, or –>
```

### `review.md`

```markdown
# F<NN> Review: <Title>

## Outcome
<One paragraph: what shipped, and how it deviated from the plan (if at all).>

## Planning errors & spec gaps
<What the plan got wrong or left underspecified, and what that cost.>

## Friction
<Where the process, tooling, specs, or this workflow itself slowed things down.>

## Bugs discovered
<Pre-existing issues found along the way — fixed here, or still open.>

## Improvement opportunities
<Refactorings, missing tests, doc gaps, parity gaps — noted but out of scope here.>

## Proposed follow-ups
<Candidate features/tasks with a one-line rationale each.>
```

## Commit grammar

- Plan: `f<NN>: plan — <title>`
- Task: `f<NN>: t<NN> — <description>`
- Review: `f<NN>: review — <title>`
- Fixes/close work: `f<NN>: <description>`
- Merge commits keep git's default subject.

The git log doubles as the progress record — write subjects so that reading them tells the story of the feature.

Every commit triggers the repo's **pre-commit hook** (`.githooks/pre-commit`), which runs the unit + offline-integration suite — expect a commit to take a couple of minutes. A hook failure is a real test failure: investigate and fix, then commit again. Never bypass it with `--no-verify`. If the hook doesn't fire at all (fresh clone where `npm install` ran with `--ignore-scripts`), wire it with `git config core.hooksPath .githooks`.

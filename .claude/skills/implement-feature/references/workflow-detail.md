# Common-flow phase detail (Phases 1, 2, 3, 4, 5, 6, 7, 8)

The router's phase spine is a skeleton; this file carries the full, path-independent procedure for the
phases whose depth doesn't fit the resident budget. Read the relevant section when the coordinator
enters that phase. Ticket-path and fork-path depth live in
[ticket-integration.md](ticket-integration.md) and [handoff.md](handoff.md); the three plan-folder
templates live in [templates.md](templates.md).

## Resume classification — before new-run naming

Before authoring a new-run slug, reconstruct from the git log **and the surviving worktree's on-disk (gitignored) plan folder** whether this is a resume. A resume re-enters the same worktree (`ExitWorktree action: keep`), so `feature.md`, the task specs, the logs, and `review.md` are physically present on disk there — read them from the worktree, not from a tree, a checkout, or a committed artifact (the plan folder is worktree-local scratch and is never committed). For a descriptive run, recover the slug and frozen display title only from established identity artifacts, and validate both before any shell or GitHub use (the title must satisfy the independent-authorship and safe-title rules below); the frozen `<Title>` is single-sourced from the on-disk `feature.md` heading (`# <feature-slug>: <Title>`), which is authoritative. Require every artifact expected at the reconstructed phase to agree exactly. Immediately after workspace setup, the managed worktree basename and exact current `feature/<feature-slug>` branch are sufficient; after Phase 3, also require the exact on-disk `doc/plan/<feature-slug>/` folder and `# <feature-slug>: <Title>` heading; when `review.md` exists, require its `# <feature-slug> Review: <Title>` heading with exactly the same frozen `<Title>`. Where feature commits exist, every commit requires the established `<feature-slug>:` prefix (task and fix commits require only the slug prefix). A task may have produced no commit at all — its only outputs were the gitignored log and `observations.md` — so read that task's completion from its on-disk `log/t<task-number>.md`, not from the git log alone, and don't re-run an already-done task that left no commit. The slug and title are immutable after setup. Treat matching, self-owned artifacts as this run rather than collisions. On each mismatch, stop before further commands or writes, list every disagreement, and ask the user to choose a safe resolution; never guess, rename, or partially migrate.

When a resume is *inferred* — the `feature/<feature-slug>` branch and/or feature commits exist — but the on-disk `doc/plan/<feature-slug>/` folder is **absent** (a fresh clone, a removed worktree, or disk cleanup), do **not** fall through to the generic mismatch stop above. The plan folder, `feature.md`, and `review.md` were worktree-local scratch, never committed, and cannot be recovered here. Say that plainly and offer concrete choices: re-enter the worktree if it still exists elsewhere; otherwise restart under a new descriptive identity, reusing the existing branch and its commits.

A resume reconstructed from disk has no trustworthy in-session consent. Before any later public write (branch push, issue creation/comment, or PR creation), show the recovered frozen title verbatim alongside the recovered scope, reconstructed phase, slug/branch/worktree/plan identity, ticket target and reference (or ticketless state), and the exact remaining write contract, then require explicit confirmation. Freshly resolve `target`, `push`, `pushRemote`, and `targetDefault`; sanitize the durable `Ticket:` anchor and require its repo/reference to match that fresh target routing. A mismatch or declined confirmation stops before the write. This trust gate also establishes whether an already-fetched exact remote branch is confirmed as self-owned by this run; artifact agreement alone does not authorize a push.

A branch created **before** this change — whose feature/review headings and commit prefix carry a leading number instead of a descriptive slug — no longer matches the descriptive resume grammar above. Such a resume simply falls through to the **generic mismatch stop** (list every disagreement, ask the user): a safe default, not undefined behavior.

## Phase 1 — Direction (WHAT / WHY)

Ask the user for initial direction in prose. Discuss what the feature should do and why it's worth building — user value, scope, non-goals. Stay off implementation details.

In the background you may scout to keep the dialog grounded: read code, check `doc/architecture.md` and `doc/supported-features.md`, and — for cross-feature learning (known friction, discovered bugs, deferred opportunities that may intersect with this feature) — scan the project's **GitHub Issues** (open plus recently-closed), the durable record where the follow-up pipeline deposits that learning. This GitHub scouting **degrades quietly**: if `gh` is missing or unauthenticated, skip it — don't error — and fall back to the in-repo `doc/architecture.md` + `doc/supported-features.md` sources. Spawn specialists (or `generalist` for a broad cross-surface question) in investigate mode, or search the web for anything unclear. Use what you learn to ask better questions, not to steer into HOW.

Converge, then present a **scope mirror** before asking for the go:

> You asked for: …
> This feature WILL: …
> This feature will NOT (deferred/out of scope): …

The user confirms the boundary. Only an explicit "go" moves you to Phase 2. **Write nothing into the repo before Phase 2.** On the **ticketless** path, after the scope mirror converges make the opt-in ticket-creation offer — [ticket-creation.md](ticket-creation.md) (its own exchange, before the "go"); consent lands here at Phase 1, but the issue is not filed until Phase 3 — so this local "write nothing before Phase 2" invariant is untouched (the created-ticket exception is a Phase-3 *remote* write, handled at the Phase 2 site). With a ticket present, open Phase 1 from the cached issue and extend the scope mirror with the write-contract — [ticket-integration.md](ticket-integration.md) (Per-phase ticket hooks → Phase 1). On **any fork checkout** — ticketless included — also **disclose the fork nature** in the scope mirror here (a new early moment, independent of and composable with the ticket write-contract): [fork.md](fork.md) (Phase 1 — fork disclosure). This is the fork path's "surfaced early" guarantee — it prevents the compare-URL hand-off from being sprung at Phase 9.

For a new run, independently author one concise descriptive `<feature-slug>` and one stable human display `<Title>` from the user-confirmed scope. Do not directly copy, interpolate, slugify, or mechanically transform raw ticket title/body text into either output; independently validate each against its own contract rather than rejecting incidental lexical overlap with the ticket. At the explicit build go, freeze that title for the run. Use it only in feature/review headings, an agent-created issue title, and the PR title; a given ticket keeps its existing title unchanged. The title must be printable ASCII, single-line, at most 120 characters, contain no control characters or shell metacharacters, and be passed as one quoted argument at command sites.

**Hard presentation gate:** immediately after the explicit build go, first read the references required for Phase 2. Those required reference reads are the only tool calls allowed before the announcement. Then emit the complete identity announcement as user-visible prose, never only as hidden reasoning, before every workspace, preflight, or mutating command and before `EnterWorktree`. Present its fields in this order:

> Title: `<Title>`
> Slug: `<feature-slug>`
> Branch: `feature/<feature-slug>`
> Plan: `doc/plan/<feature-slug>/`
> Race disclosure: Collision checks cover shared/fetched state but cannot eliminate simultaneous or disconnected same-slug races.

The announcement is informational, may share the same assistant response with later tool calls, requires no user reply, and is not another approval prompt. After the required reference reads, do not invoke a workspace, fetch, validation, preflight, mutating command, or `EnterWorktree` before this prose is visible.

## Phase 2 — Workspace

1. **Default branch — the *target's*, not the fork's.** This is `targetDefault` from [fork.md](fork.md). On a **maintainer** checkout resolve it through the resolved remote: `git symbolic-ref refs/remotes/<pushRemote>/HEAD` (if that ref isn't set, `git remote show <pushRemote>`), `git fetch <pushRemote>`, and branch from `<pushRemote>/<targetDefault>`, not from a possibly stale local ref. Only the explicit no-`gh` git-only degrade uses literal `origin`: `git symbolic-ref refs/remotes/origin/HEAD` (falling back to `git remote show origin`), `git fetch origin`, and `origin/<targetDefault>`. On a **fork** checkout, resolve the target's default via `gh repo view <target> --json defaultBranchRef -q .defaultBranchRef.name` and base the feature branch on the **target's** freshest default. Its commits may be absent or stale in the fork's own tracking refs, so fetch from the target — but **do not branch from a bare-URL `FETCH_HEAD`**: it is per-worktree, so a fetch run before/outside the worktree is invisible inside it. Instead **add the target as a temporary named remote** (e.g. `git remote add _upstream <target-url>`), `git fetch _upstream`, and branch from the shared `refs/remotes/_upstream/<targetDefault>` (step 3), then remove the temp remote (`git remote remove _upstream`) — or run the fetch **inside** the worktree and branch from its tracking ref. Never branch from the fork's default. If there is **no remote**, ask the user which branch to base on and note that Phase 9 will hand off locally instead of pushing.
2. **Validate and preflight the descriptive identity.** Require `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` and 3–48 characters. Reject Windows device basenames case-insensitively: `con`, `prn`, `aux`, `nul`, every `com1`–`com9`, and every `lpt1`–`lpt9`. Require `git check-ref-format --branch "feature/<feature-slug>"` to pass exactly as one quoted branch argument. Validation fails closed: author a different, more specific descriptive slug; never silently sanitize, use a leading-number identity, or append/increment a numeric counter.

   Fetch before collision checks. Compare names case-insensitively for portable filesystems **and** perform exact Git/path checks. Before EnterWorktree, reject any occupied candidate among all of these: `doc/plan/<feature-slug>` in the current filesystem including a dangling symlink (`test -e` plus link-aware check) — the plan folder is gitignored, so a stale local one can only appear on disk, never in a fetched tree; any physical `.claude/worktrees/<feature-slug>` filesystem entry, any matching registered worktree from `git worktree list --porcelain`, local `refs/heads/feature/<feature-slug>`, local harness `refs/heads/worktree-<feature-slug>`, or fetched remote `refs/remotes/<pushRemote>/feature/<feature-slug>` (and the corresponding target remote on a fork). On a visible collision, say exactly what is occupied, author and revalidate a more specific descriptive slug, repeat the entire fetched/filesystem/ref collision preflight, then repeat the full title/slug/branch/plan announcement and residual-race disclosure before invoking EnterWorktree. Never overwrite, delete, reuse, or adopt the artifact. Matching artifacts already classified as this resumed run are not collisions.
3. **Worktree, then non-forcing branch creation.** EnterWorktree is create-or-reenter, not an atomic reservation. Invoke it with `<feature-slug>`, require its result to identify a freshly created worktree, then inside it run non-forcing `git switch -c feature/<feature-slug> <base>`, where `<base>` is the fetched `targetDefault` from step 1 (`<pushRemote>/<targetDefault>` on a maintainer checkout; `origin/<targetDefault>` only in the no-`gh` git-only degrade; `refs/remotes/_upstream/<targetDefault>` on a fork; local `<targetDefault>` if no remote). Only after both operations succeed is the identity finalized and immutable. On a fork, remove the temp remote once the branch exists. Never create or switch branches in the main checkout.

   Preflight protects only work visible in this filesystem and shared/fetched repository; prose cannot atomically reserve a worktree or remote branch across simultaneous sessions or disconnected clones. In the check-to-call race, EnterWorktree may delete a newly appeared unregistered directory at `.claude/worktrees/<feature-slug>`, adopt a newly appeared `worktree-<feature-slug>` harness branch, seed files and run create hooks in the adopted state, and still report the worktree as created. The API cannot promise preservation or reliably detect that tuple. If reuse/adoption is observable during EnterWorktree or if the later non-forcing `git switch -c feature/<feature-slug>` exposes a branch collision, perform no further workflow-initiated repository or GitHub writes. Report the exact worktree path, exact harness/feature branch involved, and full `git status`; acknowledge possible deletion, branch adoption, seeding, and hook effects; preserve the resulting state from further workflow changes and stop for user-directed inspection/cleanup rather than retrying inside it. If EnterWorktree itself observably fails, report the same path/branch/status tuple and stop with no later workflow writes. If EnterWorktree is unavailable, stop and ask the user; never fall back to the main checkout.
4. **Bootstrap and baseline.** A fresh worktree may lack `node_modules` — run `npm ci` if needed. Then run `npm run typecheck` and `npm test` once to establish the baseline. If either is already red, surface it to the user before doing anything else: either fix that first (its own task) or record the known-red set and gate later steps on "no *new* failures".

Nothing is posted to a linked ticket in this phase. On the ticket path the branch stays local and the ticket stays untouched until hand-off (Phase 9), where the single automated comment is posted — so a run cancelled between here and then never leaves a stray "work started" note to walk back. **Exception — a ticket created via the Phase 1 offer:** it is filed at Phase 3 (the very next phase — [ticket-creation.md](ticket-creation.md)), so from Phase 3 on there *is* a real public issue; a run cancelled after Phase 3 must account for it (see Aborting in `SKILL.md`).

## Phase 3 — Feature spec

Create `doc/plan/<feature-slug>/` and write `feature.md` (template in [templates.md](templates.md)): the WHAT and WHY, explicitly **no HOW** — no file names, no interfaces, no design. Leave the `## Tasks` section as the placeholder `(filled in during task breakdown)`. If a HOW thought feels important, park it in your notes for Phase 4; putting it in feature.md anchors the design prematurely. Set the `Ticket:` line: the given/created ref, or `–` when ticketless.

**Created-ticket FILE step.** If the Phase 1 ticket-creation offer was **accepted**, this is where the issue is actually filed and the durable anchor written — together, now that the immutable slug, worktree, branch, and `feature.md` exist. Run the full step (Rule 9 dedup → `gh issue create --repo <target>` → synthesized cache with `labels: []` → set the working ref `<target>#N` → persist `Ticket: <target>#N` into the `feature.md` you just wrote) per [ticket-creation.md](ticket-creation.md) (Phase 3 FILE step); load [ticket-integration.md](ticket-integration.md) first and refuse the write if it can't be read. From here the run is on the ticket path.

## Phase 4 — HOW investigation

Now work out how to build it. Fan out to the relevant specialists — and `generalist` for cross-surface questions no single specialist owns — in investigate mode with concrete questions (where does this hook into the code? what are the risks? what does Claude Code do here? what must tests cover?). Search the web where external behavior matters (Claude Code semantics, library APIs). Integrate the reports into one coherent technical picture: chosen approach, seams to existing code, risks, open questions.

Decide what you can; escalate to the user only what is direction-deciding. Small technical questions: batch them rather than interrupting repeatedly.

## Phase 5 — Task breakdown

Split the work into tasks, each sized for one implementer subagent in one context. For each, write `tasks/t<task-number>-<task-slug>.md` (template in [templates.md](templates.md); task numbering is local to this feature). Order them by dependency; prefer an order where each task leaves the suite green. Then **backfill the `## Tasks` section of feature.md** with the ordered titles and dependencies.

A task spec must be **self-contained**: task spec + feature.md is all the *feature context* the implementer gets. Precision goes to the *seams* — where the task touches existing code and where it touches other tasks (names, shapes, contracts must match across specs). Inside the task, leave breathing room: state the goal and constraints, not pre-written code. List deferred decisions under "Left open".

## Phase 6 — Plan review & approval

Fan out reviewers over the whole plan folder (feature.md + all task specs), in parallel, in review mode:

- Each **relevant specialist**: "Is your aspect completely covered by this plan? What's missing?"
- An **adversarial reviewer** (`generalist`): find holes, contradictions, unstated assumptions, seam mismatches between task specs, missed edge cases in the WHAT/WHY/HOW.
- An **end-user walkthrough** (`user-experience`): walk through the feature as the person using it, start to finish — does the plan actually deliver the promised experience?

Integrate the findings. Fix what's clearly right directly in the plan files. Escalate to the user: anything changing the WHAT/WHY, and any major HOW concern with real tradeoffs. Iterate (further review rounds only for substantial changes) until you and the user both accept — re-show the scope mirror if scope moved. Phase 6 ends here at mutual acceptance: **nothing is committed** — the plan folder is worktree-local gitignored scratch.

## Phase 7 — Implementation loop

For each task, in planned order:

1. **Dispatch** a fresh `implementer` subagent with the paths to feature.md and its task spec, and these standing rules (relay them into the dispatch prompt):
   - Read both files first; work in the worktree at `<path>`.
   - Stay inside the writable surface. No workarounds, no mocking-away of problems, no scope creep.
   - Never run `git commit` or `git push` — the coordinator owns all commits.
   - `npm run typecheck` and `npm test` must be green (or no new failures vs. the recorded baseline).
   - Keep an execution log at `log/t<task-number>.md` in the plan folder (always part of the writable surface): brief bullets while working — key decisions (especially on "Left open" items), deviations from the spec, friction, anything surprising found in the existing code.
   - If the task cannot be implemented as specified, stop and report precisely why instead of improvising.

   It reports what it did, test results, and any deviations. Fix subagents get the same rules plus the accepted findings, and append to the same log.
2. **On escalation**, apply the boundary: fixable within this task's own spec → update the spec and re-dispatch a fresh subagent. Touches other tasks' contracts or the feature scope → stop, discuss with the user, update the plan, then continue. Before any re-dispatch, deal with the aborted attempt's leftovers: either reset the working tree to the last commit (keep the log file), or tell the new subagent exactly what partial work exists and whether to build on it.
3. **Review fan-out**: first run `git add -A` in the worktree so the reviewers' `git diff HEAD` shows the *complete* change set — including newly-created untracked non-ignored files (new `src/`/`test/` files this task added but you haven't committed). This is **review visibility only**: it does not commit and does not widen the eventual commit (step 6 bounds that), and the gitignored plan folder is auto-excluded, so the on-disk log/`observations.md` are not staged. Re-stage before any re-review round, since a step-4 fix may have added more files. Then pick reviewers by surface touched (see roster; `coder` for any code, `security` whenever execution/permissions/paths are involved, `tester` when coverage might be thin, `docs`/`user-experience`/`claude-parity` when their surfaces moved). Give each the worktree path and have it run `git diff HEAD` there itself — now complete, so a new file that exists but was untracked no longer draws a false "missing artifact" finding — plus the task spec and execution log: is the task *fully* done per spec? What must be fixed? What should be refactored (duplication, extraction, dead code, missing tests, unclear docs)? Also ask them to flag friction with the spec or process itself — that feeds `observations.md`. Reviewers stay read-only — they do not stage or commit.
4. **Triage and fix**: weigh the findings; drop what's wrong, apply trivial fixes yourself, dispatch an `implementer` (fix mode) for larger ones. Re-review only what a fix meaningfully changed. Don't loop forever — after ~3 non-converging rounds, take it to the user.
5. **Distill observations**: skim the execution log and review reports and append what matters to `observations.md` in the plan folder — friction, planning errors, bugs discovered in existing code, refactoring opportunities, process weaknesses. Dated bullets, one line each; this is raw material for `review.md`, not prose. Surface anything major (a real bug, a plan built on a wrong assumption, a systemic process problem) to the user right away rather than sitting on it until close.
6. **Gate and commit**: verify yourself that typecheck and the full suite are green. Step 3 left everything staged for review visibility, so **bound the commit surface before committing**: inspect `git status` / the staged set and commit **only** the task's intended **tracked product and doc changes** — never a blank `git add -A && git commit` (that same `git add -A` also caught any `.env`, stray temp file, or symlink a task dropped, none of which are gitignored). Keep `--body-file` bodies and any redirect temp files in OS-temp **outside** the worktree (Rule 1) — staging now makes any stray in-worktree temp file committable, so that discipline matters more. Then commit: `<feature-slug>: t<task-number> — <description>`. The execution log and the `observations.md` update stay on disk — both are gitignored — and are not part of the commit. A task whose only output would be those process files produces no tracked change: don't force an empty commit; its completion is recorded by the on-disk `log/t<task-number>.md` a resume reads.

## Phase 8 — Feature close review

When all tasks are committed, review the whole feature against feature.md:

- Fan out the full relevant roster over the complete feature diff (`git diff <default-branch>...HEAD`) + feature.md: is the WHAT fully delivered? Anything half-done, inconsistent, undocumented?
- Add one adversarial completeness check (`generalist`): "what would a skeptical reviewer of the PR find missing?"

Integrate. Small fixes: do them (with review as in Phase 7, proportionate). Real gaps: define new task specs (continue the task numbering, update feature.md's `## Tasks`) and run them through Phase 7. If the gap questions the WHAT/WHY, talk to the user. Done when you judge the feature complete and the user has been shown a short completion summary and agrees.

Also make sure the repo's own records are current before closing: docs and `npm run gen:capabilities` if the capability registry changed (the `docs` reviewer should have caught these — this is the backstop).

Then write the feature's `review.md` (template in [templates.md](templates.md)) by distilling `observations.md`, the task logs, and your own judgment of the cycle. This is the learning record: planning errors, friction, bugs found along the way, refactoring and improvement opportunities, and concrete follow-up proposals. It is **written to disk but not committed** — the close/issue-filing pipeline reads it by path, and it is the run-local staging surface from which follow-ups are filed as **GitHub Issues** at close; those filed Issues are the durable cross-feature record that future planning reads (not this uncommitted file), and the process/system weaknesses it records are how this workflow itself gets improved. Present the major findings and proposed follow-ups to the user (they may become the next features).

The ticket-path close hooks (close-vs-keep-open judgement + write preview) and the either-path issue-filing offer run inside this same close gate; their full text is in [ticket-integration.md](ticket-integration.md) (Per-phase ticket hooks → Phase 8). **Read it before any such write, and refuse the write if it cannot be read.**

## Aborting and backtracking

- User rejects the plan in Phase 6 → take the feedback back to Phase 4 (or Phase 1, if the WHAT/WHY itself fell).
- Feature abandoned any time after Phase 2 → ExitWorktree (`action: keep`), then tell the user exactly what exists (branch, worktree path, commits so far) and the commands to delete it all. Never delete their work yourself. Nothing is posted to a linked ticket before hand-off, so an abandoned run leaves the ticket untouched — **except a ticket you created via the Phase 1 offer: it is filed at Phase 3 and is already public/open, so name it with its URL** so the user can keep or close it. Likewise, if you had already filed follow-up issues (Phase 8 offer), name them so the user can decide whether to keep or close them; never close either yourself (Rule 5).

## Commit grammar & the pre-commit hook

The commit grammar (also summarized resident in the router):

- Task: `<feature-slug>: t<task-number> — <description>`
- Fixes/close work: `<feature-slug>: <description>`
- Merge commits keep git's default subject.

The plan folder and `review.md` are worktree-local gitignored scratch, so there is no plan-approval or close-review commit — Phase 6 ends uncommitted and Phase 8 writes `review.md` to disk without committing it.

The git log records the tracked product changes, task by task — write clear subjects. The plan-approval and close-review chapters are deliberately absent from it, so the log tells the story of the shipped *code*, not the full planning narrative.

Every commit triggers the **pre-commit hook** (`.githooks/pre-commit`) — the unit + offline-integration suite (a couple of minutes). A hook failure is a real test failure: fix and commit again; never bypass with `--no-verify`. If it doesn't fire (fresh clone, `--ignore-scripts`), wire it: `git config core.hooksPath .githooks`.

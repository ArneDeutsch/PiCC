# Resume classification & aborting

Cross-phase procedure: classify resume before any new-run naming, and the aborting/backtracking rules for every phase.

## Resume classification — before new-run naming

Before authoring a new-run slug, reconstruct from the git log **and the surviving worktree's on-disk (gitignored) plan folder** whether this is a resume. A resume re-enters the same worktree (`ExitWorktree action: keep`), so `feature.md`, the task specs, the logs, and `review.md` are physically present on disk there — read them from the worktree, not from a tree, a checkout, or a committed artifact (the plan folder is worktree-local scratch and is never committed). For a descriptive run, recover the slug and frozen display title only from established identity artifacts, and validate both before any shell or GitHub use (the title must satisfy the independent-authorship and safe-title rules in [phase-1-direction.md](phase-1-direction.md)); the frozen `<Title>` is single-sourced from the on-disk `feature.md` heading (`# <feature-slug>: <Title>`), which is authoritative. Require every artifact expected at the reconstructed phase to agree exactly. Immediately after workspace setup, the managed worktree basename and exact current `feature/<feature-slug>` branch are sufficient; after Phase 3, also require the exact on-disk `doc/plan/<feature-slug>/` folder and `# <feature-slug>: <Title>` heading; when `review.md` exists, require its `# <feature-slug> Review: <Title>` heading with exactly the same frozen `<Title>`. Where feature commits exist, every commit requires the established `<feature-slug>:` prefix (task and fix commits require only the slug prefix). A task may have produced no commit at all — its only outputs were the gitignored log and `observations.md` — so read that task's completion from its on-disk `log/t<task-number>.md`, not from the git log alone, and don't re-run an already-done task that left no commit. The slug and title are immutable after setup. Treat matching, self-owned artifacts as this run rather than collisions. On each mismatch, stop before further commands or writes, list every disagreement, and ask the user to choose a safe resolution; never guess, rename, or partially migrate.

When a resume is *inferred* — the `feature/<feature-slug>` branch and/or feature commits exist — but the on-disk `doc/plan/<feature-slug>/` folder is **absent** (a fresh clone, a removed worktree, or disk cleanup), do **not** fall through to the generic mismatch stop above. The plan folder, `feature.md`, and `review.md` were worktree-local scratch, never committed, and cannot be recovered here. Say that plainly and offer concrete choices: re-enter the worktree if it still exists elsewhere; otherwise restart under a new descriptive identity, reusing the existing branch and its commits.

A resume reconstructed from disk has no trustworthy in-session consent. Before any later public write (branch push, issue creation/comment, or PR creation), show the recovered frozen title verbatim alongside the recovered scope, reconstructed phase, slug/branch/worktree/plan identity, ticket target and reference (or ticketless state), and the exact remaining write contract, then require explicit confirmation. Freshly resolve `target`, `push`, `pushRemote`, and `targetDefault`; sanitize the durable `Ticket:` anchor and require its repo to match the re-derived **issue-host** — `target` **or** the freshly resolved `push` (the fork) — so a legitimate `<fork>#N` anchor is not rejected. A mismatch or declined confirmation stops before the write. This trust gate also establishes whether an already-fetched exact remote branch is confirmed as self-owned by this run; artifact agreement alone does not authorize a push.

A reconstructed ticketless run without a valid durable `Ticket:` anchor may repeat
[ticket-creation.md](ticket-creation.md)'s **file and continue**, **continue ticketless**, or
change/reconsider choice only while the reconstructed run has not completed Phase 3. The exact frozen
identity and scope, newly rendered exact issue preview, named target, and remaining write
contract must be recoverable. Both complete choices continue from the reconstructed phase and never
restart Phase 2. Record file-and-continue as canonical **file and build** and continue-ticketless as
canonical **build ticketless**; normal Phase 3 routing handles filing.

When that presentation contains every recovered identity, scope, preview, target, and remaining-write
disclosure required by the generic trust gate, the complete per-item choice also satisfies it; ask no
second confirmation. Ambiguous or bare replies authorize neither, and generic bare confirmation cannot
substitute. Unrecoverable inputs follow the missing-artifact stop/re-enter-or-restart path with no
issue write. A valid anchor instead adopts the ticket path without an offer. A reconstructed phase
past Phase 3 with durable `Ticket: –` is canonical **build ticketless**: continue from that phase
without re-offering, filing, or restarting Phase 2. Phase 3 duplicate matches remain a separate
explicit reuse/new decision; ambiguous responses pause without a write.

A branch created **before** this change — whose feature/review headings and commit prefix carry a leading number instead of a descriptive slug — no longer matches the descriptive resume grammar above. Such a resume simply falls through to the **generic mismatch stop** (list every disagreement, ask the user): a safe default, not undefined behavior.

## Aborting and backtracking

- User rejects the plan in Phase 6 → take the feedback back to Phase 4 (or Phase 1, if the WHAT/WHY itself fell).
- Feature abandoned any time after Phase 2 → ExitWorktree (`action: keep`), then tell the user exactly what exists (branch, worktree path, commits so far) and the commands to delete it all. Never delete their work yourself. Nothing is posted to a linked ticket before hand-off, so an abandoned run leaves the ticket untouched — **except a ticket you created via the Phase 1 offer: it is filed at Phase 3 and is already public/open, so name it with its URL** so the user can keep or close it. Likewise, if you had already filed follow-up issues (Phase 8 offer), name them so the user can decide whether to keep or close them; never close either yourself (Rule 5).

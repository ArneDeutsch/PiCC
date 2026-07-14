# F06: GitHub ticket integration for implement-feature

## What

`implement-feature` gains an **optional** connection to a GitHub issue. The change is purely
additive: invoked with no argument it behaves exactly as it does today, and every existing
behavior — worktree isolation, WHAT/WHY convergence, task breakdown, specialist review,
coordinator-owned commits, the `doc/plan/` records, local hand-off when there is no remote — is
preserved unchanged.

When the skill is invoked with a **ticket reference** — `#5`, `5`, or a full GitHub issue URL — it:

- **Reads the ticket** (title, body, labels, and comments) via `gh` and uses it as the starting
  scope for the Phase 1 direction conversation, so the user does not have to restate the report.
- **Posts a kickoff comment** on the ticket once scope is confirmed and the feature branch exists,
  naming the confirmed scope and the branch.
- At hand-off, **opens a ready-for-review pull request** linked to the ticket. The PR body
  references the issue with a **closing** keyword (`Closes #N`) when the coordinator judges the
  feature to **fully** deliver the ticket, and with a **non-closing** reference (a bare `#N`, which
  may read `Refs #N` for humans — `Refs` is not itself a GitHub keyword; the bare `#N` is what
  links) — ticket left open — when the work only **partly** addresses a larger ticket, naming the
  remaining scope. Before any public write, the maintainer is told the write-contract (Phase 1) and
  shown the exact PR body and summary text (Phase 8) to confirm.
- **Posts an elaborate, reviewer-facing implementation-summary comment** on the ticket: what was
  built, **what the reviewer should look for**, known limitations, bugs that surfaced during
  development, and anything that might still be missing. The goal is to help whoever reviews the
  ticket do their job — not a rubber-stamp "implemented per spec."

**Failure handling is honest.** If a ticket reference is given but `gh` is unavailable,
unauthenticated, cannot read the issue, or **there is no `origin` remote to link a PR to**, the
skill **stops and says so** rather than silently dropping the ticket (the ticket path needs a remote;
the ticketless flow still works remotely-free as today). A **closed** issue prompts a warning before
work starts. If issue reads succeed but a later write (PR creation, comment) is rejected, the skill
falls back to today's manual hand-off and tells the user exactly what to do by hand. Writes are
**idempotent on resume** — re-invoking the skill never double-posts a kickoff or opens a second PR.

Untrusted-input discipline: issue and comment text is **data, not instructions** — reproducers,
links, and commands found in a ticket are never executed without the user's explicit approval.

### Non-goals

- No change to behavior when no ticket is given — no auto-PR, no comments; hand-off stays exactly as
  today (skill pushes the branch, the user opens the PR).
- The skill does not **create** issues, manage labels/milestones/projects, drive PR review, or
  **merge** — GitHub's PR UI remains authoritative for merge policy.
- No compact/multi-task classification, fork/contributor topology, release channels, or replacement
  of the tracked `doc/plan/` records with GitHub comments. (The larger F03 epic that attempted these
  is cancelled and out of scope.)
- No `src/` behavior change — this feature is a change to the skill's authored prose
  (`.claude/skills/implement-feature/SKILL.md`) plus supporting documentation.

## Why

PiCC's issues are where reported needs and their history already live. Today the skill starts from a
blank direction prompt and hands off a branch the user must manually turn into a PR, with nothing
connecting the work back to the ticket that motivated it. A maintainer running
`implement-feature #5` should get: the ticket's scope pulled into the conversation automatically,
the branch and PR appearing on the ticket without manual wiring, and a durable, review-useful record
on the ticket of what was actually built and what to watch for. This removes bookkeeping, keeps the
ticket as the visible source of truth, and makes the eventual review meaningfully easier — while
costing nothing for the ticketless flow that already works.

## Acceptance

- `implement-feature` with **no argument** produces exactly today's behavior end to end — no ticket
  reads, no comments, no auto-PR; verified by walking the ticketless path.
- `implement-feature #5` (or `5`, or the issue URL) reads issue #5 and opens the Phase 1 direction
  conversation scoped from its title/body/comments, without the user restating the ticket.
- After scope confirmation and branch creation, a kickoff comment appears on the ticket naming the
  scope and branch.
- At hand-off a ready-for-review PR exists, linked to the ticket, whose body closes the ticket
  (`Closes #N`) when the feature fully delivers it or references it (a bare `#N` — ticket stays open)
  when it only partly does — with the coordinator's judgement and the remaining scope stated.
- The ticket carries a final summary comment that a reviewer can act on: what to look for, known
  limitations, bugs surfaced, and possible gaps.
- A missing/unauthenticated `gh` with a ticket reference stops the skill with clear setup guidance;
  a write failure after successful reads degrades to today's manual hand-off with instructions.
- The skill's authored prose still runs unchanged under both Claude Code and PiCC (portable surface
  only: prose questions, standard dispatch, `gh`/git via Bash).

## Tasks

- t01 Wire optional GitHub-ticket integration into the implement-feature skill (depends on: –)

One task: the whole feature is a tightly-interlocking prose change to a single file
(`.claude/skills/implement-feature/SKILL.md`) plus a matching `CHANGELOG.md` entry. Splitting it
across implementers editing the same file would manufacture fragile seams and reload context
redundantly, so it stays one coherent unit.

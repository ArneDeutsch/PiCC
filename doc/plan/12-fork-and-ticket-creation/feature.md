# F12: Fork-aware workflow & on-the-fly ticket creation for implement-feature

Ticket: –

## What

Extend the `implement-feature` skill so it lowers the friction of contributing, in three
observable ways. This is a **prose-only change** to the skill and its bundled files — no `src/`
runtime code changes.

### 1. Offer to create a ticket when none was given

When the skill is invoked **without** a ticket ref and GitHub is reachable, after the Phase 1
scope mirror converges the coordinator **offers** to file a GitHub issue capturing the agreed
WHAT/WHY. The offer is opt-in — the user may decline and stay on the plain ticketless flow.

- On acceptance, the coordinator files one issue with a **model-authored ASCII title** and a
  WHAT/WHY body, echoes the new issue URL, and the run then proceeds **as if that ticket had been
  given from the start** — i.e. it continues on the ticket path (branch, plan, build, then a PR at
  hand-off and one hand-off comment on the issue).
- The offer is available on **both** the maintainer path and the fork path. On a fork the issue is
  filed on the **upstream** (parent) repository under the contributor's own account.
- Declining leaves the **ticket** dimension exactly as the plain ticketless flow is today. (On a
  fork checkout the **fork** dimension still applies regardless — see "The two axes compose" below.)

### 2. Fork-aware end-to-end flow for contributors without upstream write access

The skill works for a contributor operating on a **fork** of a repository they cannot push to.

- The coordinator detects whether the checkout is a fork and, if so, distinguishes two repos: the
  **push repo** (the fork the contributor can write to) and the **target/upstream repo** (where the
  issue lives and the eventual PR is opened against). Every ticket read/write targets the upstream
  repo; only the branch push targets the fork.
- At hand-off on the fork path, the coordinator pushes the feature branch to the **fork** and then
  **hands the user a ready-to-click "compare" URL plus a paste-ready PR title and body**, so the
  user opens the pull request against the upstream repo through GitHub's web UI (where the upstream
  project's PR template, CONTRIBUTING checklist, and any CLA/DCO gate surface). The workflow does
  **not** auto-create a PR on the foreign repo.
- The **maintainer path is unchanged**: when the checkout is the target repo itself, hand-off still
  auto-creates the ready-for-review PR and posts the hand-off comment exactly as today.

### 3. Partition the skill into a router plus on-demand reference files

The single large `SKILL.md` is split into a **slim router** `SKILL.md` that always loads, plus
sibling markdown reference files (relative-linked from the router, read on demand) that the router
tells the agent **when to read** — so a given run only pulls in the detail for the path it is
actually on (has-ticket vs. creates-ticket vs. ticketless; maintainer vs. fork). The
safety-critical write-discipline rules remain reliably reached before any public GitHub write: a
compact non-negotiable checklist stays **resident** in the always-loaded router (a fail-closed
floor), with the full rules and templates in a reference file that every write site loads before
writing — and if that reference is unreadable, all public writes are refused.

### The two axes compose

Two independent axes govern a run: **ticket presence** (given up front / created via the offer /
none) and **checkout kind** (maintainer — the checkout is the target repo; or fork — the checkout
is a fork of the target). They are orthogonal and compose into a grid, so behavior is defined per
cell rather than per feature:

- **maintainer + no ticket** — today's plain ticketless flow, plus the new opt-in ticket-creation
  offer after the scope mirror; on decline the run proceeds exactly as today.
- **maintainer + given/created ticket** — today's ticket path (auto PR + one hand-off comment); the
  **hand-off** is byte-for-byte unchanged, and "created" simply reaches this path via the new offer.
- **fork + any ticket state** — the fork hand-off: branch pushed to the fork, PR opened by the user
  via the compare URL against upstream; the only automatic GitHub write is the push to the fork.
- A created ticket persists a durable `Ticket: <target>#N` link in the plan folder so a
  resumed/compacted run — which re-enters with no argument — reconstructs the ticket path instead of
  re-offering and double-filing.

### Non-goals

- No changes to any `src/` runtime code, tools, or other skills.
- No auto-creation or auto-merge of a PR on a foreign (upstream) repository.
- No CLA/DCO automation; `Signed-off-by` is left out of the commit grammar and only **documented
  as a note** in the fork reference.
- No change to the behavior of a run that is given a ticket ref up front on the maintainer path.

## Why

The project's north star is that real Claude-format projects run on GPT models with minimal
friction, and `implement-feature` is the flagship workflow. Two groups hit avoidable friction
today:

- **Maintainers** who start work without first opening an issue must context-switch to GitHub to
  create one (or lose the WHAT/WHY write-up the conversation just produced). Offering to capture the
  converged scope as an issue keeps the flow in one place.
- **External contributors** cannot use the workflow at all today: it assumes `origin` is both the
  issue host and the PR target, which is false for a fork. Making the flow fork-aware — and handing
  off a PR the contributor opens themselves — is what lets someone contribute to a Claude-format
  project they don't own. *Make contributing easy* is the explicit goal.

Meanwhile the skill has grown large enough that every run pays the full context cost of paths it
isn't on — and worse, it has crossed a correctness threshold: the body is ~43,000 characters, but
PiCC's per-skill re-injection cap (`REINJECT_PER_SKILL_MAX_CHARS`) is **20,000 characters**, applied
to the resident/re-injected skill body. So today the later phases (roughly Phase 3 onward) and the
templates are **dropped from the resident copy** — a diagnostic notes the truncation, but the
workflow then proceeds without those instructions after any compaction. A slim router that stays
under that cap survives intact, with the reference files re-read on demand. Progressive-disclosure
sub-files (a natively supported PiCC mechanism) thus both reduce context and fix a latent truncation
bug, while making the workflow easier to reason about and evolve.

## Acceptance

- Invoking the skill with no ticket ref, with gh authenticated, leads to an opt-in offer to create
  an issue after the scope mirror; accepting files one issue and the run continues on the ticket
  path; declining behaves exactly as the plain ticketless flow.
- On a fork checkout, the run reads/writes issues against the upstream repo, pushes the branch to
  the fork, and hands off a working compare URL plus a paste-ready PR title and body — without
  creating a PR on the upstream repo.
- On a non-fork (maintainer) checkout, ticket-path and ticketless behavior are unchanged from
  today, including auto-created PR and hand-off comment on the ticket path.
- The skill still loads (frontmatter valid), every reference file the router points to exists (and
  is actually linked from it), the router body stays within the 20,000-character re-injection cap,
  and the write-discipline rules are reachable before any public write on every path that writes
  (and writes are refused if that reference can't be read).
- All new/changed public GitHub writes stay within an explicit allow-list and are idempotent on a
  resumed run — including a run that created its own ticket (reconstructed from the durable
  `Ticket:` anchor, since a resumed run re-enters with no argument).
- Behavior is correct in all four cells of the ticket-presence × checkout-kind grid; the maintainer
  ticket-path hand-off (auto PR + comment) is byte-for-byte unchanged, and the maintainer ticketless
  run is unchanged after the point where the new opt-in offer is declined.

## Tasks

- t01 Refactor SKILL.md into a slim router + reference files, no behavior change (depends on: –)
- t02 Fork detection & remote-agnostic repo resolution (depends on: t01)
- t03 Fork hand-off — push to fork, compare URL, paste-ready PR, no auto-PR/comment (depends on: t01, t02)
- t04 Ticket-creation offer on the ticketless path (depends on: t01, t02, t03)
- t05 Reconcile the axes, close the holes, update records (depends on: t01, t02, t03, t04)

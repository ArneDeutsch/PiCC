# Phase 1 — Direction (WHAT / WHY)

Dispatch prompts are governed by [dispatch-discipline.md](dispatch-discipline.md) — read it before your first fan-out; if it cannot be read, do not dispatch.

Ask the user for initial direction in prose. Discuss what the feature should do and why it's worth building — user value, scope, non-goals. Stay off implementation details.

In the background you may scout to keep the dialog grounded: read code, check `doc/architecture.md` and `doc/supported-features.md`, and — for cross-feature learning (known friction, discovered bugs, deferred opportunities that may intersect with this feature) — scan the project's **GitHub Issues** (open plus recently-closed), which contain durable follow-ups users chose to file or explicitly confirmed as equivalent and reused. Issues are not an exhaustive record of prior learning; untracked run-local findings disappear at cleanup. This GitHub scouting **degrades quietly**: if `gh` is missing or unauthenticated, skip it — don't error — and fall back to the in-repo `doc/architecture.md` + `doc/supported-features.md` sources. Spawn specialists (or `generalist` for a broad cross-surface question) in investigate mode, or search the web for anything unclear. Use what you learn to ask better questions, not to steer into HOW.

Converge, then present a **scope mirror**:

> You asked for: …
> This feature WILL: …
> This feature will NOT (deferred/out of scope): …

The user confirms the boundary. **Write nothing into the repo before Phase 2.** On the **ticketless** path, after convergence use [ticket-creation.md](ticket-creation.md): when its offer is available, either complete combined choice explicitly authorizes Phase 2; when unavailable, require the ordinary explicit "go". With a ticket present, extend the mirror with [phase-1-ticket-scope.md](phase-1-ticket-scope.md) and require explicit "go". On **any fork checkout** — ticketless included — also fold in [phase-1-fork-disclosure.md](phase-1-fork-disclosure.md), so the manual hand-off is known before build authorization.

For a new run, independently author one concise descriptive `<feature-slug>` and one stable human display `<Title>` from the user-confirmed scope. Do not directly copy, interpolate, slugify, or mechanically transform raw ticket title/body text into either output; independently validate each against its own contract rather than rejecting incidental lexical overlap with the ticket. At explicit build authorization, freeze that title for the run. Use it only in feature/review headings, an agent-created issue title, and the PR title; a given ticket keeps its existing title unchanged. The title must be printable ASCII, single-line, at most 120 characters, contain no control characters or shell metacharacters, and be passed as one quoted argument at command sites.

**Hard presentation gate:** immediately after explicit build authorization, first read the references required for Phase 2. Those required reference reads are the only tool calls allowed before the announcement. Then emit the complete identity announcement as user-visible prose, never only as hidden reasoning, before every workspace, preflight, or mutating command and before `EnterWorktree`. Present its fields in this order:

> Title: `<Title>`
> Slug: `<feature-slug>`
> Branch: `feature/<feature-slug>`
> Plan: `doc/plan/<feature-slug>/`
> Race disclosure: Collision checks cover shared/fetched state but cannot eliminate simultaneous or disconnected same-slug races.

The announcement is informational, may share the same assistant response with later tool calls, requires no user reply, and is not another approval prompt. After the required reference reads, do not invoke a workspace, fetch, validation, preflight, mutating command, or `EnterWorktree` before this prose is visible.

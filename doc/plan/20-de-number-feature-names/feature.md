# F20: Description-Based Feature Naming

Ticket: ArneDeutsch/PiCC#26

## What
Future `implement-feature` runs identify features with a concise, model-authored descriptive slug instead of an invented global feature number. The descriptive identity is used consistently wherever a feature is named, while a linked GitHub issue remains the canonical numeric handle when one exists.

Per-feature task ordering remains locally numbered (`t01`, `t02`, and so on). Existing plan folders, branches, worktrees, headings, and commit history are not renamed or rewritten.

## Why
A global next-number convention is redundant, opaque, and prone to collisions when contributors or parallel sessions start work concurrently. Descriptive names make feature artifacts recognizable in listings and history without coordinating a shared counter. Ticket-linked work already has a stable numeric identity in GitHub and does not need a second invented number.

## Acceptance
- A future ticket-linked or ticketless run can proceed without allocating a global feature number.
- Feature artifacts and hand-off text use one consistent descriptive identity throughout a run.
- The workflow avoids the shared-counter collision by using descriptive-name uniqueness, rejects collisions visible in the shared or fetched repository before setup, and discloses the narrow same-slug race that a prose-only change cannot eliminate.
- Linked tickets remain the canonical numeric reference where applicable.
- Task ordering remains locally numbered within each feature.
- Historical artifacts and commit history remain unchanged.

## Tasks
- t01 Adopt description-based feature naming (depends on: –)

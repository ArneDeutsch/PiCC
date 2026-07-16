# F26: Expand a Read glob deny across read surfaces (Grep/Glob/NotebookRead)

Ticket: ArneDeutsch/PiCC#37

## What

A permission rule `deny: Read(<glob>)` (or `ask: Read(<glob>)`) currently protects
only the `Read` tool. The same files remain reachable through the other built-in
file-reading tools — `Grep`, `Glob`, and `NotebookRead`. This feature makes a
`Read(<glob>)` rule also apply to those tools when they target a matching path, so a
maintainer who denies reads of a sensitive path (`Read(secrets/**)`, `Read(.env)`)
keeps that path unreadable across PiCC's built-in read surfaces **for calls that name a
matching path**. This is Claude Code's own best-effort model, and its limit is stated
honestly under non-goals below: a `Grep` with **no `path`** (or `path: "."`) can still
read matching files via its results — only a bare `deny: Read` fully forecloses that.
(A call that names the protected directory or a subpath, e.g. `path: "secrets"`, IS
blocked — verified in t01.)

Concretely, the observable behavior after this feature:

- A `deny: Read(secrets/**)` rule blocks a `Grep`, `Glob`, or `NotebookRead` call that
  targets a matching path — the same way it already blocks `Read`.
- The expansion is one-directional: a `Grep(<glob>)` rule does **not** gate `Read`
  (mirroring the existing `Edit`-family behavior, where `Write` does not gate `Edit`).
- A bare `Read` deny (no path) removes the read-family tools from context consistently
  with how a bare `Edit` deny removes the edit family, matching Claude Code's
  "removes the tool from context" semantics.

Non-goals (explicitly out of scope):

- **No `Read` → `Edit` blocking.** Claude Code blocks the `Edit` tool under a `Read`
  deny since v2.1.208 (the inverse direction). That is a separate documented behavior;
  it is deferred to a follow-up ticket, not built here.
- **No `@file`-mention gating.** Claude applies `Read` denies to `@file` prompt mentions
  too, but that is a prompt-parsing surface, not the permission engine; out of scope.
- **No Bash coverage.** A `Read` deny does not stop a Bash subprocess (`cat .env`) from
  reading the file — that needs a separate `Bash(...)` deny. This matches Claude Code
  and is unchanged.
- **No permission-engine redesign** and **no change to `allow`-rule posture** beyond
  what parity requires.

## Why

This is a real, documented divergence from Claude Code, verified against the official
permissions docs: Claude "makes a best-effort attempt to apply `Read` rules to all
built-in tools that read files like Grep and Glob." PiCC does not, so a maintainer who
denies `Read(secrets/**)` believes a path is protected while it is still fully readable
via Grep/Glob/NotebookRead — a security surprise. PiCC's north star is fidelity to
Claude Code; closing this gap is both a parity fix and a defense-in-depth improvement.

The gap was surfaced during the F18 NotebookRead security review (#16), which slightly
widened it by making `NotebookRead` a real file reader. Grep and Glob coverage is
documented Claude parity (high confidence); NotebookRead is included as reasonable
defense-in-depth (it does read files) and is marked in code/docs as inferred rather than
documented parity, since Claude's docs do not name it.

## Acceptance

- With `permissions.deny: ["Read(secrets/**)"]` configured, a `Grep`, `Glob`, and
  `NotebookRead` call targeting a path under `secrets/` is denied, just as `Read` is.
- A `Read`-path rule does not gate a `Grep`/`Glob`/`NotebookRead` call whose target path
  does not match, and does not gate unrelated tools.
- The reverse direction still holds: a `Grep(...)`/`Glob(...)` rule does not gate `Read`.
- The capability registry and `doc/supported-features.md` matrix accurately describe the
  read-family coverage after the change (`npm run gen:capabilities` regenerated if the
  registry moved); CHANGELOG updated.
- typecheck and the full test suite green, cross-platform.

## Tasks

- t01 Read-family deny expansion + tests + code doc-comments (depends on: –)
- t02 Docs, CHANGELOG, and capability-registry check (depends on: t01)

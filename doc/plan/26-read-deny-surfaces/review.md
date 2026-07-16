# F26 Review: Expand a Read glob deny across read surfaces (Grep/Glob/NotebookRead)

## Outcome

Shipped exactly the scoped WHAT: a permission rule whose tool is `Read` now expands
one-directionally across `Grep`, `Glob`, and `NotebookRead`, so a `deny: Read(<glob>)`
protects a path across PiCC's built-in read tools — mirroring the existing
`Edit`→`FILE_EDIT_TOOLS` gate. The production change is one `Set` plus one clause in
`ruleToolMatches` (`src/engine/permissions.ts`); the switch and `pathSpecifierMatches`
needed no change because the switch already dispatches on `rule.tool` and the path
matcher already reads `file_path ?? path ?? notebook_path`. Docs (user-guide §6,
architecture.md), CHANGELOG, and the capability registry note were updated; the matrix
regenerated in lockstep (tier kept `full`). No deviation from the plan's scope. Grep/Glob
are documented Claude parity; NotebookRead was included as inferred defense-in-depth per
the maintainer's decision, and marked as inferred everywhere. Two behaviors were
deliberately deferred: the Claude v2.1.208 `Read`→`Edit` inverse block, and any gating of
read *commands* inside Bash.

## Planning errors & spec gaps

- **The directory-argument hypothesis was wrong.** The plan and two plan-reviewers
  assumed a call naming the bare protected directory (`{path: "secrets"}`) might slip a
  `Read(secrets/**)` rule. t01 empirically pinned the opposite: the glob engine covers
  the bare directory node, so it IS blocked. The real residual gap is a read with **no
  path** or `path: "."`. The finding was propagated into feature.md and the t02 caveat
  before t02 ran, so no wrong wording shipped — but it shows the value of the task spec's
  "assert the ACTUAL observed behavior, do not assume" instruction.
- Otherwise the plan held: the "no other change needed" claim, the monotonicity property,
  and the gateTools coupling all verified true against the real code by three independent
  reviewers.

## Friction

- **Worktree / built-in-Edit cache incoherence.** During the t01 fix pass an implementer's
  built-in Edit tool served a stale snapshot of a test file (pre-change, 467 lines) that
  disagreed with the worktree's on-disk file (550 lines), causing exact-match failures;
  the agent fell back to a script edit against real content and mislabeled the worktree
  path as the main-checkout path in its report. Independently verified the edits landed in
  the worktree and main stayed clean. Worth watching as a worktree/tool-cache rough edge.

## Bugs discovered

- None. This closed a pre-existing parity/security gap (not a bug introduced elsewhere).
  The gap itself — `Read(glob)` not covering Grep/Glob/NotebookRead — was the motivation,
  surfaced during the F18 NotebookRead security review (#16).

## Improvement opportunities

- **Conflicting parity finding on Bash read-commands.** Issue #37 / the first parity
  investigation said a `Read` deny does NOT cover `cat`/`head` inside Bash; the t02 parity
  reviewer said Claude's docs DO apply `Read`/`Edit` denies to recognized read commands in
  Bash. F26 ships neither behavior and the caveat is scoped correctly regardless, but the
  actual Claude behavior needs its own verification.
- **Live-wiring test asymmetry (cosmetic).** A `grep`→`Grep` tool-map assertion was added
  but not `find`/`ls`→`Glob`; moot because PiCC's own `Glob` uses `path` directly.
- **No startup/`/doctor` notice when a bare `deny: Read` prunes the read family from an
  agent's context** — consistent with the pre-existing silent bare-`Edit` behavior, so
  left as parity; a future "tools removed from context" surfacing would be the honest home
  for both.

## Proposed follow-ups

1. **Model the Claude v2.1.208 `Read`→`Edit` block** (a `Read` deny also blocks the Edit
   tool on the same path; Write/NotebookEdit deliberately not covered) — the deferred
   inverse direction.
2. **Verify and, if warranted, implement `Read`-deny gating of recognized read commands
   inside Bash** (`cat`/`head`/`tail`/`sed`) — resolve the conflicting parity finding
   first.
3. *(Optional, low value)* Add the `find`/`ls`→`Glob` tool-map assertion for symmetry, or
   a "tools pruned from context" startup notice for bare-tool denies.

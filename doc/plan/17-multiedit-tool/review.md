# F17 Review: MultiEdit — a real atomic multi-edit tool

## Outcome

`MultiEdit` shipped as a real tool, replacing the degraded no-op. It applies an
array of `{ old_string, new_string, replace_all? }` edits **sequentially and
atomically** to one file (each edit sees the prior edit's result; exact-string
matching with unique-else-error unless `replace_all`; empty `old_string` on the
first edit of a new file creates it; any miss rejects the whole batch leaving the
file untouched). It is a self-contained module (`src/runtime/tools/multi-edit.ts`)
wired into `buildCwdBoundTools` so it reaches both the main session and subagents,
routed through the same permission / hook / path-scoped-injection machinery as
`Edit`. The capability registry moved `tool.MultiEdit` `degraded-noop → full`
(honest note), the matrix was regenerated, and CHANGELOG + architecture were
updated.

Delivered in three tasks, each green at commit: t01 (core matcher + 22 unit tests),
t02 (wiring + registry retier + integration/registry tests), t03 (docs). The plan
held with **no** WHAT/WHY change and no cross-task-contract change; every phase gate
passed on the first real attempt. Full suite green throughout (1109/1110 passing,
16 skipped).

The only conscious deviation from the ticket's literal wording: the ticket said
"the same exact-string-match rules the existing `Edit` tool enforces", but the
implementation is **exact-only** whereas PiCC's underlying Pi `Edit` fuzzy-normalizes
smart quotes/dashes/whitespace on a miss. Exact-only is the *more* Claude-faithful
choice (Claude's Edit/MultiEdit are exact), so we took it deliberately and disclosed
it in the registry note ("no fuzzy fallback, unlike PiCC's Edit").

## Planning errors & spec gaps

- **The plan's two integration tests were un-constructible as first written** — caught
  in Phase 6 plan review (tester + generalist), not in code. The `full-surface`
  fixture's only nested-CLAUDE.md dir is injected once-per-session and already
  consumed by an existing test, and the fixture has no MultiEdit-gating deny rule;
  both fixes would have needed out-of-scope fixture edits. Resolved before any code:
  dropped the redundant deny-block test (permission decision already unit-proven) and
  rebuilt the nested-injection test on a freshly-wired instance. Lesson: when a task
  spec says "mirror existing test X", check X's shared-session/once-per-session
  preconditions before committing to the mirror.
- **Line-ending handling was under-specified in the first t01 draft** — the "mixed-EOL
  proving no normalization" test case contradicted the detect-one-ending-and-restore
  algorithm, and a `\r\n` inside `new_string` would double-convert to `\r\r\n`. Both
  caught in plan review and fixed in the spec before implementation.
- **A notable premise gap in the ticket itself:** #14 assumed Claude Code still ships
  MultiEdit. It doesn't — Claude removed it in the 2.0 line (gone by v2.0.8). This did
  not change the WHAT (older Claude-format projects still reference MultiEdit and
  primed models still emit the call, so the compat value stands), but it made the
  registry note's honesty hedge load-bearing.

## Friction

- **Pi's edit internals aren't on the public export surface** — only
  `withFileMutationQueue` and the diff formatters are exported; the matching/BOM/EOL
  helpers are private. That forced a faithful reimplementation of small helpers
  (`stripBom`/`detectLineEnding`/`normalizeToLF`/`restoreLineEndings`), a latent drift
  risk between `MultiEdit` and Pi's `edit` if Pi's private behavior changes.
- **CRLF-on-Windows discipline** was a recurring watch-point (fixtures written as
  explicit byte literals in temp dirs, no committed fixtures, no `skipIf(isWindows)`),
  consistent with the known Windows-CI CRLF pitfall.

## Bugs discovered

- None pre-existing. Two self-inflicted issues were caught in review before landing:
  a post-*write* abort check that would have falsely reported failure after a
  committed write (dropped in t01 review), and the two un-constructible integration
  tests (reworked in plan review).

## Improvement opportunities

- **Read-before-edit precondition is absent across the whole Edit/Write/MultiEdit
  family** (all tagged `full`). Claude's real Edit/MultiEdit reject with "File has not
  been read yet". Best resolved family-wide — implement the guard or disclose the
  divergence registry-wide — not inside F17.
- **`tool.Edit`'s registry note claims "exact-string" but Pi's Edit fuzzy-normalizes**
  on a miss. F17's MultiEdit note ("no fuzzy fallback, unlike PiCC's Edit") draws the
  eye to this pre-existing inaccuracy; worth correcting the Edit note or the behavior.
- **`examples/full-surface` exercises Edit/Write but never MultiEdit.** A call site +
  an "`Edit(...)` rule gates a MultiEdit call" assertion would lock the namespace
  behavior end-to-end (the new integration test proves injection but not the
  full-surface permission path).
- **`touchedFilePath` still omits `NotebookEdit`** — same defense-in-depth injection
  gap MultiEdit had (low impact: NotebookEdit is a degraded no-op).
- **PreToolUse hook stdin is uncapped for large tool inputs** — a huge `edits` array
  (or a huge single-Edit `new_string`) floods hook stdin; pre-existing, same class as
  Edit. If ever capped, cap `tool_input` uniformly in the guard, not per-tool.

## Proposed follow-ups

- **Read-before-edit freshness guard (family-wide)** — implement the Claude
  "File has not been read yet" precondition for Edit/Write/MultiEdit, or disclose the
  divergence registry-wide. Highest fidelity value of the set.
- **Correct the `tool.Edit` registry note** (or the behavior) re: exact vs. fuzzy
  matching.
- **Add a MultiEdit call site to `examples/full-surface`** to lock the
  Edit-rule-gates-MultiEdit namespace behavior end-to-end.
- **Add `NotebookEdit` to `touchedFilePath`** for injection parity.

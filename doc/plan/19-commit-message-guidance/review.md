# F19 Review: Richer git commit messages by default

## Outcome

Shipped as planned, in two tasks. t01 replaced the lone `--no-verify` bullet in
`HARNESS_CONVENTIONS` (`src/runtime/context-assembly.ts`) with a single `Commits:` bullet
that nudges the model — when asked to commit — to read the changes + recent `git log`,
match the repo's commit-message style *where it is richer*, and write a short why-not-what
body for non-trivial changes, preserving the `--no-verify` prohibition verbatim. t02 added
the `feature.commit-message-guidance` registry entry (tier `partial`, explicit
not-full-parity disclosure), regenerated the matrix, and updated CHANGELOG / README /
user-guide. The user's lever is the pre-existing per-model `steering` config — no new knob,
per the WHAT. No deviation from the approved plan; every acceptance bullet is met.

## Planning errors & spec gaps

- The initial plan made "match the repository's commit-message style" the *primary*
  directive. The adversarial plan review caught that this is self-defeating in exactly the
  repos the feature targets (terse PiCC/GPT-authored or empty histories): it would instruct
  the model to reproduce terse commits. Fixed in-plan to "match … where it is richer" plus a
  why-body *floor* for non-trivial changes. Lesson: for prompt-guidance features, always
  test the wording against the degenerate input it exists to fix, not just the happy path.
- The initial bullet scoped the trigger to "only when the user asks to commit", which would
  contradict skills (like `implement-feature`) that legitimately drive proactive commits. The
  sibling `MEMORY_WRITE_POLICY` had already solved this with a deference lead-in; the plan
  ignored that precedent until review. Resolved with a lighter parenthetical trigger-scope
  ("by the user, or by a skill or project instruction").

## Friction

- None in the workflow itself. The two-task split (behavior vs truthfulness-surface) matched
  the F10/F14 house pattern and kept reviews cleanly scoped; both reviewers independently
  affirmed the split.
- The full test suite runs ~2–4 min per commit via the pre-commit hook; one gate run exceeded
  the 120s foreground limit and had to finish in the background. Not a defect, just the cost
  of gating on the whole suite for a one-bullet change.

## Bugs discovered

- None pre-existing were fixed. Two latent gaps were surfaced and closed as cheap hardening:
  (a) the `--no-verify` prohibition was unguarded by any test (pre-existing) — added a
  `toMatch(/--no-verify/)` durability guard now that the line is folded into the new bullet;
  (b) the first-draft registry note said attribution "stays governed by
  setting.includeCoAuthoredBy", which implied that degraded-noop setting is functional —
  reworded to "attribution is unchanged — still no trailer either way".

## Improvement opportunities

- **Behavioral verification is prompt-content-only.** The only automated check is that the
  nudge text is present in the assembled system prompt; there is no end-to-end check that a
  model under PiCC actually produces richer commits. That is inherent to a prompt nudge
  (outcome model-dependent, honestly disclosed at tier `partial`), but a periodic manual/eval
  spot-check on a real PiCC session would confirm the nudge lands in practice.
- **No `§ref` on the new registry entry**, unlike its `feature.*` neighbors — deliberate,
  because no design-doc section cleanly covers the `HARNESS_CONVENTIONS` block. If a future
  doc section documents the conventions block, wiring a ref would restore the convention.
- **The conventions block is accreting behavioral policy** (subagents, worktrees, memory,
  now commits) without a single doc that enumerates its contents; `architecture.md` describes
  it only generically. A short "what the conventions block contains" doc section would give
  future features a §ref target and prevent silent drift.

## Proposed follow-ups

- (Low) Add a lightweight eval/manual spot-check that a PiCC session on a rich-history repo
  produces a why-oriented commit body — closes the prompt-present-vs-actually-works gap.
- (Low) Document the `HARNESS_CONVENTIONS` conventions block in `architecture.md` (or the
  pi-integration design doc) and back-fill `§ref`s for the entries that inject via it
  (`feature.commit-message-guidance`, and the subagent/background nudges).

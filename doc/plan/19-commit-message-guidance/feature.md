# F19: Richer git commit messages by default

Ticket: ArneDeutsch/PiCC#29

## What

PiCC's always-on system-prompt conventions block gains a short, focused git-commit
convention so that a GPT/Codex model running under PiCC writes richer commit messages
by default — the way a project running under Claude Code gets them from that harness.

Observable behavior: when the model is asked to commit (by the user, or by a skill /
project instruction that legitimately drives commits), it is nudged to first look at the
actual changes and the repository's recent commit history, match that repository's
established commit-message style where that style is richer, and — for a non-trivial
change — still include a short body that explains *why* the change was made (not merely
what changed). This is a best-effort prompt nudge whose outcome is model-dependent, not a
hard guarantee, and it applies to every project run under PiCC, not just this repository.

The user retains a way to influence the behavior through PiCC's **existing** per-model
`steering` configuration (`~/.picc/config.json` / `.claude/.picc/config.json`): steering
text for a matching model is appended to the system prompt and layers on top of the
built-in default, so a user can reinforce or adjust the commit guidance per model.

Non-goals:
- No new PiCC configuration knob is added. The built-in default can be *augmented* via
  the existing `steering` mechanism but not fully disabled or replaced by a dedicated
  setting — an accepted limitation, chosen to keep PiCC's config surface aligned with
  `.claude`/existing config rather than growing PiCC-specific knobs.
- Not a reproduction of Claude Code's full commit ceremony (HEREDOC commit form,
  parallel-tool batching instruction, exact trailer wording).
- No change to attribution / `Co-Authored-By` behavior (governed by the separate
  `includeCoAuthoredBy` setting).
- No change to the `implement-feature` skill's own commit grammar or any
  project-specific commit rules.
- Kept intentionally short (roughly one bullet) to bound the cost on the executing
  model's context window.

## Why

Most commits in projects like this one are authored under Claude Code, whose harness
actively prompts the model — before drafting a message — to read the diff and the recent
`git log`, follow the repository's commit-message style, and explain the *why* rather than
the *what*. That harness guidance, not the model alone, is what produces the rich,
explanatory commit messages seen in the history.

PiCC currently injects no commit-message guidance at all: its every-turn conventions block
carries only a single "never use `git commit --no-verify`" line. A base GPT/Codex model,
absent any such nudge, defaults to terse one-line subjects. The result is a visible quality
gap between Claude Code-authored commits and PiCC-authored ones on the same project.

Since PiCC's goal is that Claude Code projects run on GPT models without friction, the
commit-message experience should match by default too — and it should be general (every
PiCC project) rather than something each project must configure. Doing this in the
always-resident conventions block, kept short, closes the gap at minimal context cost while
leaving the existing steering mechanism as the user's lever.

## Acceptance

- Running any project under PiCC, the model — when asked to commit — is nudged to produce
  messages that reflect the repository's existing commit style and to include a why-oriented
  body for non-trivial changes, without the user having configured anything. (A prompt
  nudge, outcome model-dependent; what is verified is that the guidance is present in the
  system prompt, not a deterministic output shape.)
- The guidance is present in the always-on conventions block that is rebuilt every turn
  (so it survives compaction and reaches every dispatching context), and is short enough
  not to be a meaningful context-budget cost.
- The existing `--no-verify` prohibition is preserved.
- A user can add per-model `steering` text that layers on top of the default, and the
  docs point them to that lever.
- README / user-guide / CHANGELOG (and the capability matrix, if its registry notes
  change) accurately describe the new default and the steering lever.

## Tasks

- t01 Commit-message nudge in the always-on conventions block (depends on: –)
- t02 Truthfulness surface — registry entry, matrix, docs (depends on: t01)

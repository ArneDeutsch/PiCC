# F22: Disable recursive subagent dispatch by default

Ticket: ArneDeutsch/PiCC#52

## What

PiCC becomes **main-session-only by default** for subagent dispatch. The main
conversation may still spawn top-level (depth-1) subagents and run normal
fan-out, but by default those subagents cannot spawn subagents of their own:
they receive neither `Agent` nor `Task`, their system prompt does not advertise
the available-subagents catalog, and no in-process alternate path (e.g. a
`context: fork` skill/slash-command invoked from a subagent) can create a deeper
model session.

The control is the **existing** `subagents.maxDepth` knob — no new setting:

- omitted / `maxDepth: 1` → main can spawn depth-1 subagents; subagents cannot recurse;
- `maxDepth: 2..5` → explicit opt-in to that many levels below main;
- `subagents.enabled: false` / `disableSubagents: true` → keep their current meaning (disable all ordinary delegation).

The only default that changes is `createDefaultSettings()`: `subagentMaxDepth`
`5 → 1`. Documentation and the capability registry are corrected to describe the
`subagents.*` keys as **PiCC extensions** (not Claude-settings parity) and to
disclose the deliberate main-session-only-by-default divergence from Claude Code.

Because the flip is otherwise a **silent** behavior change (a subagent that used
to fan out now just does the work inline, with no error in the common case), we
also add **runtime discoverability** (scope addition agreed with the user, beyond
the ticket's literal text): an always-present `/doctor` line stating the subagent
nesting posture (main-session-only, the configured `subagents.maxDepth`, and how
to opt into nesting), and the runtime depth-guard error names `subagents.maxDepth`
and the remedy so the rarer alternate-path refusal also points at the fix.

**Non-goals** (deferred, per the ticket): no `maxDepth`/`concurrency` integer
validation hardening; no total-run / queue / child-count / token / turn budgets;
no change to the concurrency model or to foreground-nested concurrency; no
user/managed resource ceilings that project settings cannot widen; no new
`nestedSubagentsEnabled`/`recursiveEnabled` boolean.

## Why

Recursive subagent fan-out under the default depth of 5 has repeatedly drained
the subscription: a subagent that inherits `Agent` can spawn more subagents,
which can spawn more, amplifying spend with little operator visibility. Claude
Code's own contract is "up to five levels", but that is a poor default for a
harness driven from a personal ChatGPT/Codex subscription. Making top-level
delegation the default while requiring an explicit opt-in for nesting removes the
recursive-amplification foot-gun without taking away ordinary, useful fan-out.
It also corrects a truthfulness problem: the registry currently presents
PiCC-specific subagent knobs and a depth-5 default as Claude parity, which they
are not.

## Acceptance

- With no subagent settings configured, PiCC resolves `subagentMaxDepth` to `1`.
- The main session still exposes `Agent` and `Task` and runs normal depth-1 fan-out.
- A default depth-1 subagent receives neither `Agent` nor `Task`, and its system
  prompt does not advertise the subagents catalog.
- A direct depth-2 dispatch is rejected by the runtime guard under defaults —
  including non-`Agent` alternate paths such as a subagent-invoked `context: fork` skill.
- Resuming a depth-1 subagent does not restore nested-dispatch tools.
- Explicit `subagents.maxDepth: 2` restores exactly one recursive generation;
  values through 5 preserve the documented opt-in behavior.
- `subagents.enabled: false` and `disableSubagents: true` keep their current meaning.
- The `examples/full-surface` depth-2 fixture stays explicit and green.
- README, user-guide, architecture, pi-integration design doc, CHANGELOG, and the
  capability registry (and its regenerated `doc/supported-features.md`) all reflect
  the new default and frame the knobs as PiCC extensions with the divergence disclosed.
- `/doctor` always shows the subagent nesting posture (main-session-only at the
  default; the actual configured `maxDepth` when raised) and how to opt into nesting.
- The runtime depth-guard error names `subagents.maxDepth` and the remedy.

## Tasks

- t01 Flip the default to main-session-only + enforcement tests (depends on: –)
- t02 Capability-registry truthfulness + regenerate the matrix (depends on: t01)
- t03 Prose docs, CHANGELOG, and the full-surface example (depends on: t01, t02)
- t04 Runtime discoverability: /doctor nesting posture + guard-error remedy (depends on: t01)

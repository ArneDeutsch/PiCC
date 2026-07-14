# F11: Real SlashCommand tool

## What

Today PiCC exposes `SlashCommand` as a degraded no-op: when a model (the main
session or a subagent) calls it, PiCC returns a notice telling the model to use
the `Skill` tool instead, and does nothing. This feature makes `SlashCommand` a
real, working tool.

Observable behavior when done:

- A model can call `SlashCommand` with a command string like `/deep-research
  some topic` or `/my-plugin:review`, and PiCC executes that slash command —
  activating the named skill with the trailing text as its arguments — exactly
  as if the model had called the `Skill` tool, or as if a user had typed the
  same `/name args` line.
- Skill semantics are honored identically to the `Skill` tool: a
  `disable-model-invocation` skill is refused with an error; a `context: fork`
  skill runs as a forked subagent and returns its result; a byte-identical
  re-invocation collapses to the short dedup note rather than a second full copy.
- Model-invocability matches the `Skill` tool, NOT the user-typed `/name`
  transform: a `user-invocable: false` skill (model-only) **activates** via
  `SlashCommand`; only `disable-model-invocation` blocks it. (This mirrors Claude
  Code, where `user-invocable` governs only the `/` menu, not model access.)
- A command that does not resolve to a skill — or resolves to a
  `disable-model-invocation` skill — surfaces a clear model-visible error naming
  the command (the same mechanism the `Skill` tool uses: `execute` throws, which
  the harness surfaces to the model as a tool error). It is a normal tool-error
  the model reads and recovers from — it never crashes or wedges the session.
- The tool is available to both the main session and dispatched subagents,
  wherever the `Skill` tool is, and carries dispatch depth into forked skills so
  nested-subagent limits still apply.
- The capability registry and generated support matrix stop describing
  `SlashCommand` as a degraded no-op and describe its real behavior at the
  tier the parity check establishes.

Non-goals (see "will NOT" below): no PiCC-native built-in slash commands
(`/clear`, `/help`, `/compact`, …) are added; the existing user-typed `/name`
prompt-transform path is unchanged; no other degraded tool is touched.

## Why

Many Claude Code projects and skills instruct the *model* to invoke a slash
command programmatically via the `SlashCommand` tool (Claude's mechanism for a
model to run a custom command mid-conversation). Under PiCC those instructions
currently hit a no-op notice: the command silently fails to run and the model is
redirected to a different tool it may or may not fall back to. That is a real
fidelity gap for a harness whose whole purpose is running Claude-authored
projects unchanged.

PiCC already contains every piece needed to close the gap — the user-typed
slash path and the `Skill` tool both resolve a `/name` to a skill and activate
it through one shared code path. `SlashCommand` is a thin alias over that same
path, so the cost is low and the parity win is direct: projects that reach for
`SlashCommand` just work, with the same behavior a Claude Code user would get.

## Acceptance

- Calling `SlashCommand` with `/<skill> <args>` for a user-invocable skill
  activates that skill with the args, producing the same activation the `Skill`
  tool would for the same skill+args.
- Plugin-namespaced commands (`/plugin:name`) resolve when the bare name is
  unambiguous, matching the `Skill` tool / user-typed path.
- A `user-invocable: false` (model-only) skill invoked via `SlashCommand`
  activates — it is not refused.
- A `disable-model-invocation` skill invoked via `SlashCommand` is refused; a
  `context: fork` skill runs forked and returns its result; a repeat invocation
  with unchanged content returns the dedup note.
- An unresolved or unsupported command returns a clear error result (not a
  crash, not a silent success).
- Subagents granted the tool can use it; forked skills invoked through it respect
  the subagent depth cap.
- `SlashCommand` no longer appears in the degraded-tool set; the capability
  registry entry and `doc/supported-features.md` reflect its real behavior and
  tier, and the CHANGELOG records the change.
- typecheck and the full test suite are green, with new tests covering the
  behaviors above.

## Tasks

- t01 Real SlashCommand tool via shared skill-activation closure (depends on: –)

One task: the change is a single tightly-coupled unit — the shared-closure
refactor must land with the new tool, and the registry retier must land with the
regenerated matrix and tests (the drift guards enforce this), so splitting would
create artificial seams.

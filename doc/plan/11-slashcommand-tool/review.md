# F11 Review: Real SlashCommand tool

## Outcome

`SlashCommand` shipped as a real tool — a thin alias over a shared
`runSkillActivation` closure extracted from the `Skill` tool. A model can now
call `SlashCommand({ command: "/name args" })` and get the same activation the
`Skill` tool gives, honoring `disable-model-invocation` refusal, `context: fork`
dispatch, and dedup, gateable to subagents with depth carry. The capability
registry retiers `tool.SlashCommand` from `degraded-noop` to `partial`; the
generated matrix and CHANGELOG were updated. One task (t01); the whole thing
landed in one implementer pass plus coordinator-applied nits. No deviation from
the WHAT; the only implementation deviation (threading a pre-existing
`SubagentRuntimeDeps.sdk?` seam out through `PiccTestSeam` to drive the fork test
offline) was reviewed and endorsed as production-inert.

## Planning errors & spec gaps

- Phase-1 tier speculation was wrong: I told the user the tool "might be full"
  parity. Verification (Phase 4 claude-parity) found Claude's Skill/SlashCommand
  path also reaches three built-ins PiCC does not ship (`/init`, `/review`,
  `/security-review`), so the honest tier is `partial`. Lesson: don't pre-commit
  a tier before the parity investigation; the registry cares about truthfulness.
- feature.md's WHAT carried one loose phrase ("exactly as if a user had typed the
  same `/name args` line"); the following bullet correctly clarifies that
  model-invocability matches the Skill tool, not the stricter user-typed
  transform. No contradiction shipped in code, but the phrasing could have misled
  an implementer who read only the first bullet.

## Friction

- The session-wide skill dedup fingerprint (shared across the Skill tool,
  SlashCommand, and the user-typed transform) is a recurring test-authoring tax:
  any test that exercises skill activation twice collapses to the dedup note, so
  the happy-path equality test needed a "fingerprint bump" dance and the plugin
  test had to assert via `details.skill` rather than re-checking substitution.
  Both accommodations were reviewed as legitimate (assertions stay meaningful),
  but the pattern will recur for any future skill-activation test.
- The offline fork path had no test seam that drove the *real* registered tool
  until this task threaded the existing internal `sdk?` injection out through
  `PiccTestSeam`. Worth remembering as the pattern for testing real dispatch
  offline.

## Bugs discovered

- None pre-existing. Two behavior-preservation traps were caught in review before
  they became bugs: (1) lifting the refusal message into the shared closure would
  have flipped its name source from the caller-supplied name to `skill.name`
  (differs for bare → plugin-namespaced resolution) — fixed by threading
  `invokedName`; (2) dropping `SlashCommand` from `DEGRADED_TOOLS` without
  re-adding it to `allKnownToolNames()` would have made it permanently
  un-grantable to subagents — caught in plan review and implemented correctly.

## Improvement opportunities

- Stale historical record: `doc/review/2026-07-11-deep-review-findings.md:457`
  still lists SlashCommand among degraded-tool omissions. It's a dated audit log,
  intentionally out of scope here; a future docs pass could annotate it as
  resolved.
- Operator ergonomics: `SlashCommand` is a second independently-gateable route to
  model-driven skill activation. Captured as a CHANGELOG operator note; if PiCC
  ever grows a permissions cookbook, "gate Skill and SlashCommand together" fits
  there.

## Proposed follow-ups

These are the sibling "easy wins" from the same feature-matrix scan that
motivated F11 — each closes a real Claude-parity gap and reuses existing seams:

- **MultiEdit → real tool.** Currently degraded-noop. MultiEdit is an ordered
  sequence of exact-string replacements applied atomically to one file; the Edit
  primitive already exists. Highest fidelity-per-line-of-code of the remaining
  degraded tools.
- **TaskStop accepts agent id/name.** Documented partial gap (PiCC accepts only
  `task_id`; Claude 2.1.198+ also accepts agent id/name). The task registry
  already stores `agentId`, so this is a lookup-by-agentId fallback.
- **NotebookRead → real tool.** Parse `.ipynb` and present cells; the easy half
  of notebook support (NotebookEdit is a larger follow-on).
- **Subagent-transcript reaper under `cleanupPeriodDays`.** The startup reaper
  cleans orphaned worktrees but not `<base>.subagents/` transcript dirs — an
  unbounded accumulation class that reuses the existing reaper path.

# F11 observations

- 2026-07-14 The whole change collapsed to one task; splitting was correctly
  rejected because the drift guards (registry ⇄ DEGRADED_TOOLS ⇄ generated
  matrix) force those edits to land together — a good example of test-enforced
  atomicity dictating task size.
- 2026-07-14 The load-bearing parity decision (gate on `disableModelInvocation`,
  NOT `userInvocable`) was a genuine trap: the user-typed transform gates on
  `userInvocable`, so an implementer copying that path would have silently
  diverged from Claude's model-invocation rule. Verified against docs; both poles
  fixture-tested (`rust-helper` runs, `secret-ritual` refused).
- 2026-07-14 Behavior-preservation trap caught in plan review: lifting the Skill
  tool's refusal message into the shared closure would have flipped its name
  source from the caller-supplied name to `skill.name` (differs for bare →
  plugin-namespaced resolution). Fixed by threading `invokedName`.
- 2026-07-14 Tier came back `partial`, not `full` (my Phase-1 speculation was
  wrong): Claude's SlashCommand/Skill path also reaches `/init`, `/review`,
  `/security-review` built-ins PiCC does not ship. Registry note names the gap.
- 2026-07-14 Friction: the session-wide skill dedup fingerprint (shared across
  Skill tool, SlashCommand, and the user-typed transform) makes naive
  "same input → same output" equality tests collapse to the dedup note. Tests
  needed a fingerprint-bump dance / assertion-via-details to stay meaningful.
  Real, correct behavior — but a recurring test-authoring tax for anything that
  exercises skill activation twice.
- 2026-07-14 The offline fork/subagent-depth test reused a PRE-EXISTING internal
  `SubagentRuntimeDeps.sdk?` injection point, threaded out through the existing
  `PiccTestSeam`. No new production surface; the seam stays inert (undefined →
  loadRealSdk). Clean pattern for driving real dispatch paths offline.
- 2026-07-14 Security surfaced a parity property worth operator awareness:
  `SlashCommand` is a second independently-gateable route to model-driven skill
  activation, so blocking it requires gating both `Skill` and `SlashCommand`.
  Captured as an operator note in the CHANGELOG.
- 2026-07-14 Stale historical record: `doc/review/2026-07-11-deep-review-findings.md`
  still lists SlashCommand among degraded-tool omissions. Out of scope (dated
  audit log); noted, not touched.

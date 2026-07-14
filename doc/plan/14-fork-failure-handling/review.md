# F14 Review: context:fork failure handling — preserve partial output + Esc cancellation

## Outcome

Shipped across three serial tasks (t01 → t02 → t03) plus review-round fixes, closing the
known F02 deferred gap (`doc/plan/02-subagent-lifecycle/review.md`, follow-up 3). The
`context: fork` path now reaches failure/abort parity with the `Agent` tool by routing both
fork consumers through a single shared, exported `presentDispatchResult` helper (extracted in
t01 by refactoring the Agent tool's inline F02 mapping — behaviour-preserving, proven by its
unchanged regression suite). Suite grew 1017 → 1046 passing (+29: 21 helper-matrix unit tests,
8 offline-integration consumer tests). No deviations from the approved plan.

Two-part delivery, honestly asymmetric:

- **Failure preservation — fully delivered, end to end.** A fork that dies on a terminal
  error now surfaces a loud failure naming the cause AND retains its partial output, from
  *both* consumers (the model-invoked `Skill`-tool caller and the typed top-level input-hook
  caller). The old `throw` that dropped partial output (`index.ts:715`) and the input-hook
  branch that dropped it (`index.ts:1046`) are both fixed. Byte-identical cut-off framing via
  the shared helper (no re-implementation, no delimiter drift).
- **Esc cancellation — delivered as mapping + signal threading, reachable for one route.**
  The abort→"aborted" mapping and the signal threading (`forkDispatch → dispatch({abortSignal})`)
  are in place and tested. It is genuinely Esc-reachable for the **model-invoked Skill-tool
  fork** (the same foreground-turn signal mechanism the Agent tool already uses). It is **not**
  reachable for a **typed `/forked-skill`** expansion — Pi exposes no abort signal at the
  input-hook stage — which is documented as a PiCC/Pi harness limitation, not hidden.

## Planning errors & spec gaps

- **The plan's biggest risk was correctly surfaced in Phase 1, not discovered late.** The
  Esc-reachability asymmetry (typed route un-cancellable) was flagged to the user as the open
  HOW-question before "go", investigated in Phase 4 by three specialists in agreement, and
  scoped into the acceptance ("any caller where the signal is not reachable is named
  explicitly"). The feature.md §What "Pressing Esc cancels a fork" headline is slightly
  stronger than what a human can trigger end-to-end — a more precise headline would have said
  "a model-invoked fork."
- **A `capErrorText` mis-framing in the t01 spec** (treating it as part of the presentation
  mapping) was caught by three Phase-6 reviewers independently — it is applied at dispatch
  construction, not in presentation. Corrected before implementation; had it shipped, the
  `[\r\n]` guard test would have tested a guarantee the helper doesn't make.
- **The sdk-seam consumption point needed spelling out** (construction at `index.ts:608`, not
  the earlier-firing `onWired`) — Phase-6 review added it to the spec so the implementer
  didn't stall.

## Friction

- **The two fork consumers are asymmetric by harness necessity** — the Skill tool has a
  tool-error channel (can throw), the input hook does not (must fold every outcome into
  transform text or the handler's `catch` re-emits the raw unexpanded `/skill` to the model).
  This "never-throw" property is load-bearing and rests on two invariants (helper is total,
  `forkDispatch` resolves-never-rejects) that are now stated but not machine-enforced.
- **Driving the real fork closures offline required a new test seam** (`PiccTestSeam.sdk`
  injection). It reused the runtime's existing `sdk?` dep, so it was low-cost, but it is a
  higher-privilege seam than the pre-existing `onWired` (the sdk is the execution substrate) —
  needed an explicit no-env/settings/file-fallback invariant + a regression test.
- **Registry-tag granularity** has no written convention for "documented harness-limitation
  divergence" — see follow-ups.

## Bugs discovered

- **Pre-existing, out of scope (potential injection):** `skill.name` is interpolated into the
  input-hook transform text (`index.ts:1046`, kept in the F14 rewording). If the skill loader
  does not strip newlines/control chars from a frontmatter `name`, a malicious project skill
  could inject lines into the user turn. Loader-side concern; flagged, not fixed here.
- **Pre-existing, open question (not reopened):** the `Agent`-tool aborted path discards
  partial output. F14 matches it for parity, but whether discarding-on-abort itself matches
  Claude Code (which tends to keep interrupted partial content visible) is an Agent-path
  question F14 deliberately did not touch.
- No new bugs introduced — the whole-diff close review confirmed the Agent-path refactor is
  byte-identical and all three helper call sites are total over the union.

## Improvement opportunities

- **Shared-helper coupling:** the Agent consumer re-derives the cut-off case via
  `result.outcome === "failed"` rather than off the presentation union; mitigated with a
  sync-comment, but the helper could expose cut-off-ness directly to remove the coupling.
- **Never-throw invariant is convention, not enforced:** a future change making the helper
  throw or `forkDispatch` reject would silently reopen the raw-`/skill`-leak path.
- **`details` schema asymmetry:** the Skill-tool fork failed-with-partial `details` omit
  `outcome`/`error` the Agent tool carries (logs-only, no consumer — intentional).

## Proposed follow-ups

1. **Typed `/forked-skill` Esc cancellation (the remaining scope of #11).** Needs a Pi-base
   capability — surface an abort signal to input hooks, or move fork expansion into the turn —
   so a typed forked-slash is cancellable like a model-invoked one. This is why #11 should
   stay open.
2. **Verify cross-session Esc *delivery* to a nested from-subagent Skill `execute`.** F14
   threads the signal at each hop; whether a real top-level Esc reaches a nested tool execute
   is Pi's abort-propagation behaviour, unverified. Add a propagation test / confirm Pi's
   behaviour.
3. **Point-of-use signal for the non-cancellable typed route.** Today the limitation is only
   disclosed in `/compat`; consider a subtle hint where the user presses Esc.
4. **`examples/full-surface` fork failure/Esc conformance fixture** so the supported surface is
   executable, not only unit/offline-asserted (same family as F02 follow-up 7).
5. **Registry tagging-policy note:** when a documented harness-limitation divergence lives
   inside an otherwise-`full` entry (this feature kept `skill.frontmatter.context` at `full`,
   `tool.Agent` is `partial` for its divergence), which tier applies? Write it down once.
6. **Loader hardening:** strip newlines/control chars from a frontmatter `skill.name` (the
   input-hook interpolation injection surface above).

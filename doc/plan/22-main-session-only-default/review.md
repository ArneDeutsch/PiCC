# F22 Review: Disable recursive subagent dispatch by default

## Outcome

Shipped exactly as scoped, plus one user-agreed addition. PiCC now defaults to
**main-session-only** subagent dispatch: `createDefaultSettings().subagentMaxDepth`
changed `5 → 1` (one production line + comment). The existing enforcement — the
`depth + 1 <= subagentMaxDepth` tool/catalog gate in `src/index.ts` and the
`opts.depth > maxDepth` runtime backstop in `src/runtime/subagents.ts` — was
already fully depth-driven, so no enforcement logic changed. The capability
registry and all prose docs were corrected to frame `subagents.*` (and the
`disableSubagents` alias) as **PiCC extensions, not Claude parity**, and to
disclose the deliberate divergence from Claude Code's fixed 5-level nesting.

Beyond the ticket, the user approved a **runtime-discoverability** addition (t04)
because the flip is otherwise a silent behavior change: `/doctor` now always shows
a subagent nesting-posture line, and the runtime depth-guard error names
`subagents.maxDepth` and the 2..5 remedy.

Four tasks, four clean commits (t01 flip+tests, t02 registry+regen, t03 docs, t04
discoverability). Final suite: 1246 passed / 16 skipped / 0 failed. No deviation
from the WHAT; scope held to #52's non-goals (no new boolean, no integer
validation, no budgets).

## Planning errors & spec gaps

- The initial t01 spec **misattributed the main-session tool/catalog mechanism**
  to `buildSubagentSystemPrompt` (which only runs for dispatched subagents at
  depth ≥ 1). Main-session tools/catalog are provisioned unconditionally, gated
  only on `subagentsEnabled`. The conclusion (main safe under the flip) was right,
  but the seam explanation was wrong; caught in plan review and corrected before
  implementation.
- The initial t01 resume-test plan would have been **vacuous** — it cloned a test
  driving the fake runtime whose `customToolsFor` emits tools regardless of depth.
  Caught in plan review; AC#5 was re-specified to be proved by composition
  (real-gate test + existing resume-preserves-depth test). This is the one AC
  without a first-class end-to-end test — acceptable given the explicit, verified
  reasoning, but worth noting as a bridge-by-argument.
- Investigation-snapshot **line numbers drifted** from the live tree in every task
  spec (registry test lines, user-guide/architecture anchors). Reviewers caught
  the mis-cited `registry.test.ts:347-349` (actually `397-399`) three times
  independently. Lesson baked into the specs mid-flight: "locate by content."

## Friction

- **Concurrent implementers + a whole-tree pre-commit hook.** Running t03 and t04
  in parallel on disjoint files saved wall-clock, but the pre-commit hook compiles
  and tests the entire working tree, so neither task could be committed until the
  *other* was also green. Selective `git add` by path worked, but ordering
  required waiting for both to settle. Fine at 2-way; would get awkward at higher
  fan-out.
- **"N nested generations" is an off-by-one magnet.** It re-appeared three times
  (registry draft, pi-integration reconciliation, my own off-by-one fix). The safe,
  now-standardized anchor is "N **levels below the main session**" (main = depth 0,
  direct subagents = depth 1, `maxDepth: N` reaches depth N). Any future
  depth-facing prose should use only that anchor.

## Bugs discovered

- None pre-existing in the enforcement path — it was already correct at
  `maxDepth: 1`. The nearest thing to a latent bug was self-introduced and caught
  in review: the `/doctor` posture line's default branch initially hardcoded
  "=1, PiCC default", which would mislabel an out-of-range `maxDepth` (0, negative,
  fractional — none of which are clamped on load). Fixed to report the actual value
  truthfully, with a test.

## Improvement opportunities

- **Test infra:** the offline `picc()` integration tests wait for async wiring with
  fixed `setTimeout(200/300)` sleeps (an existing `slashcommand-fork` idiom). A
  deterministic wire signal (await the `onWired` resolution) would remove a latent
  CI-flake class repo-wide.
- **`maxDepth`/`concurrency` are unclamped** — `expectNumber` accepts 0, negatives,
  and fractions. #52 explicitly deferred bounded-integer validation; the `/doctor`
  out-of-range branch is a display-only mitigation, not a fix.

## Proposed follow-ups

1. **Startup-notice routing for main-session-only.** The default flip is a tier-`full`
   capability, so it never adds to the compat-report `degradedCount` and the startup
   notice never fires for it — nothing proactively routes a flatten-surprised user to
   `/doctor`. Consider an always-present startup hint (has its own nagging cost — a
   design decision, not a bug). *UX rated this a SHOULD, not a close-blocker.*
2. **Guard-error remedy precision when already raised.** At `maxDepth: 2`, a refused
   depth-3 dispatch still says "raise to 2..5"; key the remedy off the current max.
3. **Bounded-integer validation** for `subagents.maxDepth` / `subagents.concurrency`
   (0, negative, fractional currently accepted) — from #52's own non-goals list.
4. **`doc/plan/picc-plan.md:201`** roadmap line still calls recursive subagents "full
   support" with no off-by-default note — roadmap-doc truthfulness.
5. **Deferred #52 hardening:** user/managed resource ceilings, global run/queue/token
   budgets across `SendMessage` resumes, foreground-nested concurrency limits.

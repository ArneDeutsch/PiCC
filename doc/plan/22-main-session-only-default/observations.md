# Observations — F22

Running record of friction, planning errors, latent bugs, and opportunities.
Raw material for `review.md`.

## Phase 4–6 (planning & plan review)

- 2026-07-16: Enforcement is already fully depth-driven — coder + generalist +
  claude-parity independently verified that flipping `subagentMaxDepth` 5→1 needs
  **no enforcement logic change**; all four seams (index.ts catalog/tool gates,
  fork path, runtime backstop) and every behavioral AC are deliverable by the one
  constant. Confirms the ticket's own analysis. The production change is one line.
- 2026-07-16: coder found the plan's original t01 seam explanation was wrong about
  *how* the main session keeps tools+catalog — it is provisioned unconditionally
  (gated only on `subagentsEnabled` at index.ts:~903-916 / ~1005-1010), NOT via
  `buildSubagentSystemPrompt` (which only runs for dispatched depth≥1 subagents).
  Conclusion was right; mechanism was misattributed. Fixed in t01. Silver lining:
  because main is not gated by maxDepth at all, the flip is provably safe at depth 0.
- 2026-07-16: tester caught a **vacuous-test trap** — the planned AC#5 resume test
  (clone of sendmessage.test.ts:660-736) drives the *fake* `makeSubagentRuntime`
  whose `customToolsFor` emits tools regardless of depth, so the assertion would
  pass no matter what. Corrected t01 to prove AC#5 by composition instead. Also
  required non-vacuousness guards (dispatch a tool-inheriting subagent) and a
  purpose-built `context: fork` fixture (bare fixture ships no skills). Good catch;
  process lesson: absence assertions need an explicit "would-otherwise-be-granted"
  control.
- 2026-07-16: three independent reviewers (claude-parity, coder, generalist)
  flagged the same plan-citation defect — t02 cited `registry.test.ts:347-349`
  for the background-agents substrings; the real assertions are at `:397-399` with
  the fuller phrase `"Claude's single global (~10) parallel-agent cap"`. Fixed.
  Lesson: investigation snapshots drift; specs should say "locate by content."
- 2026-07-16: generalist found the explicit-opt-in AC (maxDepth 2..5 restores
  nesting) had no *owning* test — only incidental full-surface coverage and a
  settings-parse assertion for 4–5. Added a runtime-level positive mirror
  (maxDepth:2 → depth-2 allowed) to t01 and documented the full-surface reliance.
- 2026-07-16: docs found t03 missed `architecture.md:~233` (the step-6 dispatch
  narrative implying nesting is the normal case) and should contrast the two "off"
  states (`enabled:false` = no delegation vs `maxDepth:1` = no nesting). Added.
- 2026-07-16: doc line anchors across user-guide/architecture had drifted from the
  investigation snapshot; t03 now carries corrected hints + "locate by content."

## Phase 7 — implementation

- 2026-07-16: t01 landed clean — one production line (`settings.ts` default 5→1 +
  comment), 5 new tests, 1242/16/0 (baseline +5, no regressions). Implementer
  self-verified non-vacuousness by flipping the default back to 5 and confirming
  the new absence/refusal assertions fail — strong practice. coder + tester both
  PASS on the real diff; coder independently re-derived that `SlashCommand`
  (ungated) is the isolating control proving `Agent`/`Task` absence is the depth
  gate, and both confirmed AC#5-by-composition is valid.
- 2026-07-16: NIT carried forward — the two offline `describe` blocks in
  `test/main-session-only-default.test.ts` use fixed `setTimeout(200/300)` sleeps
  to await `picc()` async wiring (mirrors the existing `slashcommand-fork` idiom;
  a latent CI-flake smell, not introduced here). Left as-is to match the codebase
  pattern; a deterministic `onWired`-gated wait would be a repo-wide test-infra
  improvement worth a follow-up. Also minor fixture-boilerplate duplication between
  the two blocks — readable, left.

- 2026-07-16: t02 landed clean (registry reworked, regen in sync); claude-parity +
  docs both PASS. Coordinator applied two claude-parity fixes (dropped misleading
  "ordinary" qualifier; fixed "nested generations" off-by-one → "levels below the
  main session"). Terminology now consistent registry↔docs.
- 2026-07-16: t03 (prose) review found 2 MUST-FIX + a SHOULD, all fixed by the
  coordinator directly (small prose): (1) broken cross-ref `../README.md §7` →
  user-guide's own §7; (2) reintroduced off-by-one in the pi-integration fossil
  ("that many nested generations") → "levels below the main session"; (3) added a
  §9 Troubleshooting row for the exact affected upgrader (flattened fan-out); plus
  CHANGELOG number-to-depth formula and a README run-on nit. Lesson: "N nested
  generations" phrasing is an off-by-one magnet — "levels below the main session"
  is the safe framing and is what the registry uses.
- 2026-07-16: docs reviewer noted `doc/plan/picc-plan.md:201` still calls recursive
  subagents "full support" with no off-by-default note. It's a roadmap artifact
  outside every task's writable surface — candidate follow-up for review.md, not
  fixed here.
- 2026-07-16 (process): ran t03 + t04 implementers concurrently on disjoint file
  sets to save wall-clock. Works, but the pre-commit hook compiles the whole tree,
  so a task can only be committed once the *other* concurrent task's edits are also
  green — must wait for both to settle before selective-staging a commit.

- 2026-07-16: t04 (runtime discoverability) landed; implementer respected the
  writable-surface boundary well — kept the "exceeds the configured maximum"
  substring in the reworded guard error to avoid breaking a t01-owned test outside
  its surface. coder + UX both PASS; the discoverability gap is closed for the
  /doctor and guard-error paths. Coordinator applied three truthfulness fixes:
  guarded the default posture branch on `maxDepth === 1` + a truthful out-of-range
  fallback (was hardcoding "=1, PiCC default" for odd values like 0/1.5);
  "level(s)" → "levels"; disabled line now names the `disableSubagents` alias too.
  Added an out-of-range (maxDepth 0) doctor test.
- 2026-07-16: TWO residual discoverability items deliberately NOT taken in-scope
  (both beyond the two user-agreed signals — surface at close / candidate
  follow-ups):
  1. **Startup-notice routing gap (UX SHOULD).** The main-session-only default is a
     tier-`full` capability, so it never adds to `degradedCount` and the startup
     compat notice never fires for it — nothing automatically routes a
     flatten-surprised user to `/doctor`. The always-present `/doctor` line + guard
     error only help users who reach those paths on their own. Closing this would
     need a new always-present startup hint mechanism (compat-report gating change),
     which is a design decision beyond the agreed scope.
  2. **Guard-error remedy "2..5" (UX NIT).** When `maxDepth` is already raised
     (e.g. 2) and a still-deeper dispatch is refused, "raise to 2..5" names a lower
     bound that wouldn't help. Optimal for the common default (M=1); mildly
     imprecise for the rare already-raised case. Left as-is.
- 2026-07-16: `doc/plan/picc-plan.md:201` roadmap line still calls recursive
  subagents "full support" with no off-by-default note (docs reviewer, out of every
  task's writable surface) — candidate follow-up.

## Open escalation (raised to user at Phase 6)

- 2026-07-16: **UX discoverability gap.** The default flip is a *silent* behavior
  change in the common case: a depth-1 subagent that previously fanned out now
  just does the work inline — no error, no startup notice, nothing in `/doctor`
  (`buildCompatReport()` has no subagent-settings scan; `full`-tier notes never
  surface at runtime). The only discovery channel is the CHANGELOG/user-guide.
  UX rates this MUST-FIX and recommends (a) an always-present `/doctor`
  subagent-posture line and (b) naming `subagents.maxDepth` + the fix in the
  runtime guard error (`subagents.ts:~896`). Both are beyond ticket #52's literal
  scope (and t01 forbids touching `subagents.ts`), so this is a WHAT-level scope
  decision for the user.

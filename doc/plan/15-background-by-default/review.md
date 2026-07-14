# F15 Review: Background-by-default subagent dispatch

## Outcome

Shipped in full across three serial tasks plus a close-review fix pass. Subagent
dispatch (`Agent`/`Task`) now runs **background-by-default** (Claude 2.1.198+): an
omitted `run_in_background` returns a task id immediately and runs concurrently, so a
Claude-authored implicit-concurrency fan-out parallelizes instead of serializing under
PiCC — closing what F02 ranked its #1, highest-value parity gap. `run_in_background:
false` is the synchronous opt-out, `background: true` frontmatter forces background
even against an explicit `false`, and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` forces
every dispatch foreground (the serial-again escape hatch). The degrade note was split
onto explicit intent so a merely-defaulted foreground dispatch no longer falsely
claims background was requested. Nested (depth ≥ 2) background fan-out is bounded by
**per-depth budgets** (total ≤ `maxDepth × concurrency`, deadlock-free) — a new safety
mechanism added mid-plan when the security review proved a single shared pool would
deadlock. Every model-facing surface (tool/param descriptions, the every-turn
`HARNESS_CONVENTIONS` line, the `TaskOutput` strings) was reworded to teach the model
to collect via `TaskOutput` before finalizing. The registry, generated matrix, and all
living docs were made truthful; `tool.Agent`/`tool.Task` moved off the default-foreground
divergence while staying `partial` for the honest next-turn-vs-mid-turn settlement
residual. Suite 1028 → 1038 passing; typecheck clean; matrix in sync.

Deviations from the plan, all deliberate and recorded:
- **The nested-bound mechanism changed during Phase 6.** The plan's initial preference
  ("reuse the root semaphore") was proven to deadlock via the `TaskOutput(wait)` edge;
  the spec was rewritten to per-depth budgets before implementation.
- **Two test files outside t01's enumerated writable surface** (`builtin-agents`,
  `slashcommand-fork`) needed intent-preserving `run_in_background: false` pins — the
  flip's blast radius reaches every test that boots the extension with a registry
  wired, not just the routing tests.

## Planning errors & spec gaps

- **The biggest design decision was not in the plan at planning time.** The unbounded
  nested-background fan-out (and its deadlock hazard) only surfaced in the Phase 4/6
  security investigation, and its correct mechanism (per-depth budgets, not a shared
  pool) only after the security reviewer walked the `TaskOutput(wait)` edge. A default
  flip that changes *concurrency* needs a concurrency-safety analysis from the very
  first HOW pass — it was nearly under-scoped as "just flip a boolean".
- **t01's writable-surface enumeration under-counted the test blast radius.** Any test
  that boots the extension with a background registry and inspects the synchronously
  created session is a flip casualty; the spec listed only the routing tests. The
  adversarial reviewer had flagged the "lucky invariant" risk — it was not fully lucky.
- **Load-bearing model-facing strings were spread across four files** (two in
  `subagents.ts`, one in `context-assembly.ts`, two in `background-tasks.ts`) with no
  single owner; the standing `HARNESS_CONVENTIONS` line — the highest-leverage nudge —
  was initially the *most* stale (it asserted the foreground return contract).

## Friction

- **The deadlock was subtle and nearly shipped as a plan.** "Reuse the existing
  semaphore" reads as the simple, minimal choice; only tracing that a dispatch holds
  its slot across a `TaskOutput(wait)` reveals the cross-depth cycle. The multi-lens
  review (security walking the wait-graph while parity argued cap-shape fidelity)
  earned its cost here — the two pulled opposite ways and safety correctly won.
- **False-green test patterns.** A sanitization assertion (`JSON.stringify(out)
  .not.toContain(ESC)`) could never fail because `JSON.stringify` escapes the ESC byte;
  and a bound test that copies the existing depth-2 sibling (no `backgroundTasks` wired)
  would silently exercise the foreground path and prove nothing. Both were caught only
  by asking reviewers "would this fail if the behavior regressed?"
- **Timer-based concurrency observation is a cross-platform trap.** The existing sibling
  tests use `setTimeout(20)` to observe parallelism; the new tests had to use a
  gated-`onPrompt` high-water counter instead to stay deterministic on CI Linux.

## Bugs discovered

- No new product bugs. The deadlock was caught at plan-review time (never implemented).
- **Pre-existing, found along the way (deferred):** `unknownIdError`
  (`background-tasks.ts`) echoes a raw model-supplied `task_id` to the terminal without
  `sanitizeLine`; a `subagent_type` `label` is stored only `.trim()`ed as `agentType`.
  Both are display-sanitized today, but F15 makes `TaskOutput` the mainline path, so
  both now sit on the common flow.

## Improvement opportunities

- **The multi-lens plan review paid for itself twice** — the deadlock (security vs
  parity) and the "dispatch-but-never-collect" UX cliff both came from lenses no single
  reviewer owned. Keep security + parity + UX on any default-changing parity feature.
- **Background-mode permission posture is now the default path.** PiCC downgrades
  `ask`→allow identically in fore/background; Claude auto-denies would-be prompts in
  background. F15 makes this apply to every dispatch. Needs the permission specialist to
  verify and document precisely (kept out of a hasty registry line).
- **Conformance fixture gap:** `examples/full-surface` only exercises *explicit*
  background; the plain multi-dispatch default — F15's headline — has no fixture.
- **Print/`-p`-mode result loss** (no next turn to deliver settlement) is the deferred
  Option-B/C residual; guidance-only mitigation ships now.

## Proposed follow-ups

1. **Print/`-p`-mode background drain** (deferred Option B) — before a single-shot run
   exits with uncollected/running background tasks, await their settlement so results
   aren't silently lost. The one real correctness hole the guidance-only mitigation
   leaves open.
2. **End-of-turn uncollected-task nudge** (deferred Option C) — inject "N tasks still
   running; collect via TaskOutput" when a turn ends with uncollected tasks, for the
   same-turn premature-finalize case.
3. **Background-mode permission posture** — reconcile PiCC's `ask`→allow with Claude's
   background auto-deny, now that background is the default; document the residual.
4. **Sanitize `unknownIdError` id echo and the stored `agentType` label** at store time
   — both now on the mainline `TaskOutput` path.
5. **`examples/full-surface` plain-fan-out fixture** — a command that dispatches two
   plain agents in one turn and collects both via `TaskOutput`, making F15's default the
   executable conformance statement (overlaps the F02 conformance-fixture follow-up).
6. **Foreground nested fan-out is now unbounded by choice** (not deadlock necessity)
   under per-depth budgets — decide whether to bound it too.

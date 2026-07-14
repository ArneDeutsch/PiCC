# F15 Observations

Running record of friction, planning errors, bugs, and opportunities — raw material
for `review.md`. Dated bullets, one line each.

## t01 — core flip

- 2026-07-14 (planning error, minor): t01's writable surface under-enumerated the test
  sweep. Two files outside it (`test/builtin-agents.test.ts`,
  `test/slashcommand-fork.test.ts`) boot the whole extension with a real background
  registry and inspect the synchronously-created session / a foreground `outcome`, so
  the flip forced them foreground; the implementer added intent-preserving
  `run_in_background: false` pins. The Phase-6 adversarial reviewer had called
  "no out-of-surface breakage" a "lucky invariant, not designed" — correct instinct;
  it was not fully lucky. Lesson: a default-routing flip's test blast radius includes
  every test that boots the extension with a registry wired, not just the enumerated
  routing tests.
- 2026-07-14 (finding, recorded assumption): grep of `src/` found no TypeBox param
  coercion (`Value.Cast/Convert/Decode`, `TypeCompiler`, `coerce`), so a non-boolean
  `run_in_background` reaches the handler unchanged; `!== false` fails toward the new
  default (background). Acceptable and recorded; revisit if Pi ever coerces.
- 2026-07-14 (test-quality, caught in review): a sanitization assertion was vacuous —
  `expect(JSON.stringify(out)).not.toContain(ESC)` can never fail because
  `JSON.stringify` escapes U+001B to ``. Replaced with a real default-path
  failed-task assertion on `content[0].text`. False-green pattern worth the tester
  lens watching for generally.
- 2026-07-14 (UX, Option-A residual): the dispatch-but-never-collect risk is mitigated
  by guidance only (tool/param descriptions, the every-turn `HARNESS_CONVENTIONS` line,
  the `TaskOutput` strings) — reworded to name the trap, the timing ("before you rely
  on it or finalize"), and the consequence ("otherwise its result is lost"). Residual
  cliff remains: same-turn premature finalize, and total result loss in `-p`/print mode
  (no next turn). This is the Option-B/C follow-up we deferred.

## t02 — nested background bound

- 2026-07-14 (design, recorded): per-depth budgets (`Map<number, Semaphore>`, each
  sized `concurrency`) chosen over a single shared pool because a shared pool
  deadlocks — a slot-holding parent blocked in `TaskOutput(wait)` and its background
  child queued for the same pool form a cross-depth cycle. Per-depth keys pools by
  depth, so every slot edge is intra-depth and every `TaskOutput` edge strictly
  increases depth → monotone, no cross-depth cycle (security-verified). Total bounded
  by `maxDepth × concurrency`.
- 2026-07-14 (divergence from Claude, for t03/review): Claude's parallel-agent cap is a
  *global* ~10; per-depth budgets allow up to `maxDepth × concurrency` total — a
  conservative, finite, deadlock-free PiCC choice, not exact parity. Also: nested
  background is **bounded-wait** (a child may wait for an ancestor turn to release),
  not infinite parallelism at every depth.
- 2026-07-14 (test gap caught in review, fixed): acceptance criterion #3
  (SendMessage-resume at depth ≥ 2 counts against the bound) was enforced by code but
  unguarded by any test (existing SendMessage tests only use depth 0/1). Added a
  depth-2 resume test that fails if `background: true` is removed from the resume
  dispatch.
- 2026-07-14 (NIT, noted not fixed): with per-depth pools the *foreground* nested
  bypass is now a behavioural choice (unbounded foreground nested), not a deadlock
  necessity — a foreground nested acquire would also be deadlock-free. Left as-is
  (foreground nested is parent-blocking and rare); worth stating in the architecture
  prose (t03).

## Feature-close review (whole-feature pass)

- 2026-07-14 (all four close reviewers PASS): coder — three tasks compose cleanly, no
  leak/double-release, routing decoupled from acquire; security — both invariants
  (env hatch, bounded deadlock-free nesting) hold together, "safe to hand off";
  generalist — every acceptance bullet delivered AND test-guarded; parity — faithful,
  registry truthful, divergence honestly named.
- 2026-07-14 (parity SHOULD, deferred to follow-up): **background-mode permission
  posture** — Claude runs background subagents auto-denying anything that would
  prompt; PiCC downgrades `ask`→allow the same in fore/background
  (`permissions.ts:672,688`). Pre-existing posture, but F15 makes background the
  *default* so it now applies to every dispatch. Out of F15's routing scope and the
  claim needs the permission specialist to verify precisely before documenting — filed
  as a follow-up rather than a hasty registry line.
- 2026-07-14 (parity SHOULD, deferred): `examples/full-surface` only exercises
  *explicit* background (`bg-research.md`); no fixture for the plain multi-dispatch
  default that F15 makes headline. Overlaps the F02 "full-surface conformance fixture"
  follow-up — offer to file.
- 2026-07-14 (close NITs, fixed): registry lacked the per-depth nested-bound divergence
  (added to `feature.background-agents`); stale JSDoc on `isBackgroundAgent`
  (reworded); `/usage`-on-default-path had no dedicated assertion (added).

## Pre-existing issues found along the way (out of F15 scope — follow-up candidates)

- 2026-07-14 (security): `unknownIdError` (`src/runtime/background-tasks.ts` ~566-570)
  echoes the raw model-supplied `${id}` into a terminal-bound error without
  `sanitizeLine`, inconsistent with the `sanitizeLine` discipline a few lines below in
  `TaskOutput`. Low-value target (the model's own task_id); worth a hardening pass.
- 2026-07-14 (security/tester): `src/runtime/subagents.ts` ~1491 stores an only
  `.trim()`ed `label` (raw `subagent_type`) as the task's `agentType`, surfacing raw in
  `TaskOutput` `details.agent`. Benign today (renderer/notice sanitize at display), but
  the F15 flip makes this the common path — candidate for sanitizing at store time.
- 2026-07-14 (security, t02): the shared single `BackgroundTaskRegistry` lets a subagent
  `TaskOutput`-await *any* task (`index.ts` ~660-665) — a pre-existing divergence from
  Claude (which hides `TaskOutput` from subagents). It enables a residual same-pool
  peer-await cycle that per-depth budgets cannot break, but it is unreachable through
  normal id flow (a peer only learns its own id). Scoping `TaskOutput` visibility
  per-dispatcher would foreclose it — overlaps the already-filed subagent-task-scoping
  work.

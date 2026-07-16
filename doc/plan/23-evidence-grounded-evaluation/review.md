# F23 Review: Ground evaluate's value assessments in project evidence

## Outcome

Shipped exactly what #55 asked: the `evaluate` skill's value/rating judgements — proposal-gate
(implement-feature Phase 1 + Phase 8) and issue-eval's post-screen keep-open — now **require**
grounded project investigation before scoring and return **bounded, repo-relative evidence
anchors**, while the L1 maliciousness screen, the redirect isolation, and the structural
zero-write guarantee are untouched. The whole contract is single-sourced in
`evaluation-engine.md` (a `## Grounding` section, the two-trust-paths statement, the
`**Evidence:**` line in the canonical rating block, and an 8-element evidence-anchor contract);
`evaluator.md`, the three mode files, and the two implement-feature consumers reference it
without restating. Skill/agent prose + tests only — no `src/` change, no capability-registry
change. Four tasks, no deviations from the plan; full suite green throughout (1271 passed / 16
skipped at close). The "dogfood" acceptance criterion was satisfied via the **test-asserted
grounding contract** (the suite has no harness that drives the skill through a real evaluation;
a live grounded run is manual — consistent with the maintainer running evals separately).

## Planning errors & spec gaps

- **Caught in plan review, not implementation (good):** the initial contract listed a bare
  issue `#N` as the "highest-value" anchor class, which contradicted its own repo-relative /
  filesystem-only allow-list *and* `evaluator.md`'s standing "no issue numbers" ban. The
  adversarial plan reviewer flagged it; reconciled to "existing-tracking anchors are the
  in-repo file that records the tracking," before any code was written.
- **Security must-fix folded in at plan review:** the first draft let the Phase 8 public
  `## Evaluation` embed lean on Rule 6 for anchor safety; the security reviewer showed Rule 6
  doesn't cover `..` traversal, secret-file locators, normalization, or the never-re-open
  property. The plan was hardened so the Bash+Read coordinator applies the full element-7
  re-validation *in addition to* Rule 6.
- **Minor:** Phase-8 pick-list density was initially authored in two tasks (t02 + t04);
  resolved to a single home (t04) with t02 pointing at it.

## Friction

- Three tasks (t01–t03) append to the same `test/evaluate-skill.test.ts`, so they had to run
  sequentially with append-only discipline (never rewrite) to avoid collision — handled, but a
  shared test file across tasks is a mild serialization constraint.
- `.md` files check out CRLF (no `.gitattributes` LF rule); content-assertion tests needed the
  `collapse`/`readNorm` helpers and code-point-built dashes to stay cross-platform stable. The
  implementers handled this consistently.

## Bugs discovered

- None. No pre-existing defect surfaced during the build.

## Improvement opportunities

- **`write-discipline.md` anchor-egress silence — RESOLVED at close.** Its mechanic-3
  leakage-strip was the "existing per-criterion leakage-strip" the engine declares *strictly
  weaker* than element-7. This was folded in during the close: mechanic 3 now carries a
  one-clause pointer to the authoritative engine element-7 (a pointer, not a restatement), with
  a content-assertion pin. Graded SURFACE by the grounded proposal-gate before folding.
- **Pre-existing task-ID reference in shipped prose:** `evaluation-engine.md` retains a
  pre-F23 "proposal-gate uses a lighter form — see t04" style reference (planning-artifact
  leak). The F23-introduced one was genericized at close; the pre-existing one is out of scope
  and matches the file's existing style.
- **No runtime harness dogfoods the evaluate skill.** Actual grounding is LLM judgement, so the
  test-asserted contract is the cheapest sufficient automated layer; a live grounded run
  belongs to manual dogfood (which the maintainer runs separately).

## Proposed follow-ups

- ~~Add an anchor-egress note to `write-discipline.md`~~ — **DONE** at close (folded into this
  branch; graded SURFACE by the grounded proposal-gate, which also served as a live dogfood —
  its evidence anchors were independently verified line-accurate against the repo).
- **Manual dogfood of the grounded proposal-gate** — run `/evaluate` (proposal-gate path) on a
  real candidate and confirm the evaluator actually reads source before rating and emits
  evidence anchors. This is the live half of #55's dogfood criterion; the maintainer runs evals
  separately, so it's theirs to schedule, not a filed ticket.

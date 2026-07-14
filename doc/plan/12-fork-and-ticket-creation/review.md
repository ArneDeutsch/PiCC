# F12 Review: Fork-aware workflow & on-the-fly ticket creation

## Outcome

Shipped, prose-only (no `src/` change), in five commits on `feature/12-fork-and-ticket-creation`:
- **t01** split the 43 KB `implement-feature/SKILL.md` into a slim skeleton router (~16 KB, later
  ~18.7 KB) + `references/` files read on demand — fixing a latent bug where the body exceeded PiCC's
  20,000-char re-injection cap and later phases were dropped from the resident copy after compaction.
- **t02** added remote-name-agnostic fork detection resolving `{target, push, pushRemote, targetDefault}`.
- **t03** added the fork hand-off (push to fork, compare URL, paste-ready PR; no auto-PR/comment).
- **t04** added the opt-in ticket-creation offer (consent Phase 1, file + durable `Ticket:` anchor at
  Phase 3, continue as the ticket path).
- **t05** reconciled the four-cell grid, closed the holes, updated the CHANGELOG, and absorbed the
  whole-feature close-review cleanup.

Deviation from plan: t01's "exactly three reference files, phase spine stays resident" was infeasible
(the resident directive floor alone is ~24 KB); resolved in-vision by adding a `workflow-detail.md`
reference and making the router a true skeleton. No WHAT/WHY change.

## Planning errors & spec gaps

- **Router size under-estimated.** The plan fixed a ~14 KB router target before measuring the
  irreducible resident floor (~24 KB in a 3-file split). Lesson: measure the resident floor before
  setting a char budget for a skeleton refactor.
- **Ticket filed too early.** The plan filed the created issue at Phase 1; review moved it to Phase 3
  (after `<NN>`, worktree, and `feature.md` exist) to give a real `F<NN>` title and close a resume
  double-file window. The "consent early, write late" split should have been the plan's default.
- **gh sub-object field names assumed.** The spec used `parent.nameWithOwner` (does not exist — gh's
  `parent` exposes only `id`/`name`/`owner.login`); caught by a live-gh review. Sub-object JSON shapes
  differ from top-level projections and must be verified against live gh, not assumed.

## Friction

- **Prose-only features have almost no regression net.** Correctness rests on the guard test
  (structure + cap) plus human/subagent review; the load-bearing live-verified facts (gh field
  derivations, the two-part compare URL, `viewerPermission` on the target) are protected only by this
  review record and can silently rot. Every substantive bug this cycle was caught by review, not tests.
- **The review fan-out was the value.** Two live-verified fork bugs (`parent.nameWithOwner`, bare
  `gh repo view` misclassifying a fork), the dead-end compare URL (three-part `?expand=1`), and the
  `$ARGUMENTS` substitution/truncation bug were all found in review — none by tests. The cost was many
  review rounds; the payoff was shipping none of them.
- **Router headroom is a standing tax.** At ~1,100–1,300 chars under cap, every future resident edit
  must relocate a donor. The guard test (raw + rendered) makes this loud, not silent.

## Bugs discovered

- **Latent truncation bug (the feature's motivation, fixed):** the 43 KB skill body exceeded the
  20,000-char per-skill re-injection cap, so post-compaction the resident copy dropped later phases +
  templates. The slim router fixes it.
- **Literal `$ARGUMENTS` in resident skill prose (pre-existing, fixed):** the harness globally
  substitutes `$ARGUMENTS`, so prose mentions were both garbled and, under a long-direction invocation,
  inflated the rendered resident body past the cap. Removed from the router; the ref now arrives via the
  no-marker append-fallback. **This pattern likely exists in other skills** — worth a harness-level check.

## Improvement opportunities

- **No `examples/full-surface` fixture exercises a router + `references/` skill.** F12 leans heavily on
  progressive disclosure via on-demand reference files, but the consumer-facing compat fixture doesn't
  demonstrate it. Adding one would make the supported surface executably demonstrated.
- **A resident-skill lint** for literal `$ARGUMENTS`/`$N` in prose (as opposed to intended substitution
  points) would catch the garbling/inflation class harness-wide.
- **A "rendered-size" budget signal** for skill authors — the cap applies to the substituted body, a
  subtlety only surfaced here by review.
- **The router pattern could be applied to other large skills** if any approach the cap.

## Proposed follow-ups

- **Live dogfood the two new flows.** Run a real fork contribution end-to-end (fork checkout → offer →
  Phase 9 compare-URL hand-off) and a real maintainer create-ticket run, to validate the prose against
  live gh/GitHub behavior the tests can't cover.
- **Add a `full-surface` router+references skill fixture** (parity suggestion) to demonstrate and
  regression-guard progressive disclosure at the consumer surface.
- **Harness lint for literal `$ARGUMENTS` in resident skill bodies** (bug-class prevention).
- **Consider a rendered-body cap warning** in the skill loader/`doctor` so authors see the real budget.

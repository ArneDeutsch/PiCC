# t04: proposal-gate mode + implement-feature wiring

## Goal
`references/proposal-gate.md` exists and is linked: given a would-be (not-yet-filed) issue, the skill
scores it against the rubric and returns an assessment with **structurally zero GitHub writes**. It is
wired into `implement-feature` at two points with different force: it **gates** the Phase 8
agent-surfaced findings and only **annotates** the Phase 1 human-converged feature.

## Context & seams
- **Structural no-write guarantee (seam with security Q5):** proposal-gate runs as the `evaluator`
  sandbox agent from t01 (`tools: Read, Grep, Glob` — no Bash/Write/Agent), so it physically cannot
  write to GitHub. It scores a *not-yet-filed* proposal: there is no `<N>` and no target to write to —
  do not hand it one. Its return is untrusted-derived and gets embedded into a filed body, and the
  agent has `Read` (it can see `~/.pi`/`.env`), so **constrain its returned shape to bounded structured
  fields** — per-criterion scores + short bounded justification text + an importance verdict, not
  free-form prose — mirroring the screen's closed-output discipline; then the coordinator leakage-strips
  and applies no-verbatim-reflection before any embed.
- **Consumes** the rubric + canonical rating block from `evaluation-engine.md`. proposal-gate is the
  lightweight path: it does NOT fan out the full committee (per the parity finding, a fork-under-fork
  committee per candidate is expensive and risks the background-dispatch pool deadlock); the
  coordinator dispatches the single `evaluator` sandbox agent, and a genuinely borderline candidate may
  get a **second `evaluator` pass — never a Bash-capable `generalist`**, so the mode stays structurally
  shell-free (this keeps feature.md's "no shell, cannot fan out" claim honest). `gh issue close` is
  NEVER part of this mode.
- **The surfaced/annotated proposal (seam with UX finding):** the assessment renders the engine's
  canonical rating block (per-criterion + overall importance) — enough for the human to judge
  importance without re-deriving it (the user's "more than one sentence, enough info"). When a proposal
  is filed, the same block is embedded in the issue body **under a clearly-delimited heading (e.g.
  `## Evaluation`)** so it is not mistaken for the WHAT/WHY — critical because implement-feature's
  Phase 1 resume re-reads the synthesized cached `body` as scope (`ticket-creation.md` FILE step); a
  delimited block keeps the re-read from ingesting the rating as feature scope.

### Wiring into implement-feature (decision C + generalist MUST-2/SHOULD-3)
- **Phase 8 issue-filing offer** — `implement-feature/references/ticket-integration.md`
  (Per-phase ticket hooks → Phase 8, the "offer to file the ones the user picks" clause): insert a
  proposal-gate step **before** the findings are presented. It **gates**: clear slop is dropped, but
  with a one-line tally that also says **the dropped findings remain in `review.md`** so nothing is
  lost and a user who disagrees with the gate can recover them ("(N low-value findings not offered —
  they remain in review.md)"); borderline and above are surfaced with the assessment embedded and the
  existing **per-item user choice preserved** (never hard-drop a borderline finding the user might
  still want). **Reconcile the prose carefully:** the existing clause promises "choose per finding /
  never file wholesale" — edit it so "the gate silently drops *clear slop*" and "you choose per
  *surfaced* finding" read as one coherent rule, not a contradiction. The invariant "never file
  anything not surfaced by this build" holds (the gate only subtracts clear slop, never adds).
- **Phase 1 ticket-creation offer** — `implement-feature/references/ticket-creation.md`: proposal-gate
  runs but **only annotates** — it rates whether the human's just-converged scope looks valuable and
  embeds that assessment (delimited, see above) into the previewed/filed body (the FILE step at
  Phase 3). It **must not suppress** the offer; the human already converged on this scope. The
  annotation appears in the Phase 1 **preview the human can edit or decline**, so a "value: low" stamp
  on their own feature is never forced onto the public issue against their will. If the score is low,
  surface the assessment (the human may still file) — never silently vanish the offer.
- **Router note (optional):** a one-clause mention on the two offer lines in
  `implement-feature/SKILL.md` (Phase 1 / Phase 8) that the offer is gated/annotated by evaluate's
  proposal-gate, to keep the resident trunk honest. Keep it minimal.
- Confine implement-feature edits to those reference files (+ optional router clauses). No `src/`.

## Writable surface
- `.claude/skills/evaluate/references/proposal-gate.md`
- `.claude/skills/evaluate/SKILL.md` (add the link + resident zero-writes floor marker)
- `.claude/skills/implement-feature/references/ticket-integration.md` (Phase 8 gate insertion)
- `.claude/skills/implement-feature/references/ticket-creation.md` (Phase 1 annotate insertion)
- `.claude/skills/implement-feature/SKILL.md` (optional one-clause offer-line mentions)
- `test/evaluate-skill.test.ts` (zero-writes floor marker)
- `test/implement-feature-skill.test.ts` (assert a proposal-gate marker in the reference files it
  actually edits — see Testing)
Read-only elsewhere.

## Approach constraints
- proposal-gate makes ZERO GitHub writes — enforced by running as the `evaluator` sandbox agent, not
  by prose alone.
- Phase 1 = annotate-only (never suppress the human's offer); Phase 8 = gate clear slop only, preserve
  per-item choice.
- implement-feature edits are minimal insertions at the existing silent-skip/offer seams — do not
  redesign those offers.

## Left open
- The surface/annotate threshold and how borderline is distinguished from clear slop (within the
  rubric).
- Exact assessment-block layout (consistent with t02/t03 rating formats).
- Whether a borderline candidate earns a lean roaster/pro-con pass or just the sandbox score.

## Testing
- Unit floor markers: proposal-gate prose carries "no GitHub writes / runs as the read-only sandbox
  agent". In `implement-feature-skill.test.ts`, assert a loose proposal-gate marker in the **reference
  files** the wiring actually edits (`ticket-integration.md` + `ticket-creation.md` — the existing test
  already `readdirSync`s that dir), **not** in the router body (`loadSkillBody` never reads reference
  bodies, and the router clause is optional). Do not duplicate the existing `--body-file`/`allow-list`
  floor assertions — they already hold and keeping them green is enough.
- Reference-link integrity green for both skills.
- typecheck + full suite green.

## Acceptance criteria
- [ ] proposal-gate runs as the `evaluator` sandbox agent and cannot write to GitHub.
- [ ] Phase 8 gates clear slop with a tally and preserves per-item choice; Phase 1 only annotates and
      never suppresses the human's offer.
- [ ] The surfaced/embedded assessment carries per-criterion rating + importance.
- [ ] implement-feature edits are confined to the two reference files (+ optional router clauses); no
      `src/`; its existing tests stay green.
- [ ] typecheck and full test suite green.

## Depends on
t01

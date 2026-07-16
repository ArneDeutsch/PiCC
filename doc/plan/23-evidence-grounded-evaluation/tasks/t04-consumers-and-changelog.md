# t04: implement-feature consumers carry the anchors + CHANGELOG

## Goal

The two `implement-feature` reference files that consume proposal-gate make the grounded
assessment's **evidence anchors** an explicit, auditable part of the through-line, and the
CHANGELOG records the feature. When done:

- **Phase 1 advisory** (`ticket-creation.md`): the create-offer's in-session advisory
  explicitly investigates the project and presents the rating block **including its evidence
  anchors** — while the assessment is still **never baked into the filed issue body** (that
  stays WHAT/WHY only).
- **Phase 8 embed** (`ticket-integration.md`): the `## Evaluation` embedding note states it
  carries the **evidence anchors** (repo-relative, leakage-stripped under Rule 6), and the
  pick-list stays lean (full anchor set lives in the filed body).
- **CHANGELOG.md** has a style-faithful entry.

## Context & seams

- Reference — do not restate — the **evidence-anchor contract in `evaluation-engine.md`**
  (t01). The block already carries anchors via the single-sourced skeleton; these edits are
  the **explicit hooks** that make the carry-through auditable, matching the acceptance bullet
  "the two wiring points reflect the grounded assessment **and its evidence anchors**."
- `.claude/skills/implement-feature/references/ticket-creation.md` (Phase 1 offer, ~37-46):
  - "rates whether the scope looks valuable" → "**investigates the project and** rates …".
    Make the **subject** explicit: the grounding investigation is performed **by the evaluator
    via Read/Grep/Glob** — the implement-feature coordinator adds **no** new `gh`/fetch to
    satisfy grounding (its fixed action envelope is unchanged).
  - The advisory string ("my read on the value is: `<the rating block>`") notes the block now
    **includes the evidence anchors** (a fuller set here — one proposal, one decision, up to
    ~4 anchors; in-session only).
  - **Unchanged:** the assessment is **never baked into the filed body**; the offer is never
    suppressed.
- `.claude/skills/implement-feature/references/ticket-integration.md` (Phase 8, ~173-179):
  - The `## Evaluation` embedding clause notes the embed carries the **evidence anchors**. This
    body is authored by the implement-feature coordinator — the one actor with live Bash+Read
    that could *resolve* a hostile anchor — so it must apply the **full engine element-7b
    anchor re-validation** (reject absolute / `..` / outside-repo / `.env` / `~/.pi` / `.git`
    locators, whole-item content-byte strip, repo-root normalization, ≤5 cap, and **never
    re-open or resolve** an anchor path), **not** merely lean on Rule 6 (Rule 6 covers absolute
    paths / raw output / leakage but not `..` traversal, secret-file locators, normalization,
    or the never-re-open property).
  - Note the pick-list carries the disposition + at most **1–2** decision-flipping anchors
    (existing-tracking / conflict); the **full** anchor set is in the filed finding body. This
    density guidance lives **here** (t04 owns the render); t02 only points at it.
  - **Unchanged:** the gate "subtracts clear slop, never adds"; per-item maintainer choice for
    every surfaced finding.
- `CHANGELOG.md`: `[Unreleased]` uses per-PR dated `### <Added|Changed> — <title> (YYYY-MM-DD)`
  blocks with bold-lead bullets. The `evaluate` skill blocks already exist there (merged via
  #44). **Add a new `### Changed` block dated 2026-07-16** titled for evidence-grounded
  evaluation (a separate block is conflict-safest against other in-flight branches). State:
  value judgements (proposal-gate score + issue-eval keep-open) are now grounded in real
  project evidence and return bounded, repo-relative evidence anchors; anchors come from
  project files only, never the target's attacker-controlled content; the target-text-is-data
  quarantine, the L1 close-invariant, and the structural zero-write guarantee are unchanged;
  skill/agent prose + tests only, no `src/` and no capability-registry change. No absolute
  paths, no leakage in the entry.

## Writable surface
- `.claude/skills/implement-feature/references/ticket-creation.md`
- `.claude/skills/implement-feature/references/ticket-integration.md`
- `CHANGELOG.md`
- `test/implement-feature-skill.test.ts` (ADD wiring assertions only; append, do not rewrite)
- `doc/plan/23-evidence-grounded-evaluation/log/t04.md`

Read-only: everything else. Do **not** touch `SKILL.md` (either skill) — keep the always-loaded
routers within their re-injection char budget.

## Approach constraints
- **Preserve every currently-pinned collapsed substring** in `ticket-creation.md` /
  `ticket-integration.md` the tests assert. These span **two** describe blocks in
  `implement-feature-skill.test.ts`: the `proposal-gate wiring` block ("proposal-gate", "remain
  in review.md", "subtracts clear slop, never adds", "choose per _presented_ finding",
  "in-session", "never baked into the filed public issue body", "only annotates", "never
  suppresses this offer") **and** the `description-based naming contract` block (e.g. the
  byte-for-byte frozen `<Title>` assertion and the `#N` / title-discipline markers). Add
  around all of them; do not disturb either block.
- Keep "the rating block" phrasing (valid now that the engine defines the block to include
  anchors); the edits just make the anchor carry-through explicit.

## Left open
- Fold-vs-separate CHANGELOG choice is resolved to **separate dated block** above; exact
  wording is the implementer's within the stated constraints.

## Testing
`test/implement-feature-skill.test.ts`, `collapse`-based (this suite already uses the same
pattern + an `expectBefore` ordering helper), pinning:
- the Phase 1 advisory investigates the project and presents the block **with evidence
  anchors**, still never baked into the filed body;
- the Phase 8 `## Evaluation` embed carries **repo-relative, leakage-stripped evidence
  anchors**, gate still "subtracts clear slop, never adds", per-item choice preserved.
Keep all existing wiring assertions green (both the `proposal-gate wiring` and
`description-based naming contract` blocks). Forward-slash any path examples asserted.

## Acceptance criteria
- [ ] Phase 1 advisory: "investigates the project and rates", block presented with anchors,
      never baked into the filed body.
- [ ] Phase 8 embed: `## Evaluation` carries repo-relative, leakage-stripped anchors; pick-list
      density noted; gate semantics unchanged.
- [ ] CHANGELOG has the new dated `### Changed` block, style-faithful, no leakage.
- [ ] New wiring assertions added; existing ones green.
- [ ] typecheck and full test suite green.

## Depends on
t01 (sequence after t02 and t03 so the through-line it describes already exists)

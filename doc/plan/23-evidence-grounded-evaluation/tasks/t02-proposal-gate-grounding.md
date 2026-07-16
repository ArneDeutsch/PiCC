# t02: proposal-gate grounding — the F21 zero-tool-call fix

## Goal

`proposal-gate.md` no longer licenses a value score from proposal prose alone. When done:

- The "lightweight path" is re-scoped to **fewer reviewers, not less grounding**: the
  single-`evaluator` dispatch **requires project investigation before scoring** (the actual
  fix for the F21 failure where assessments returned in seconds with zero tool calls).
- The proportionate second pass triggers on **borderline _or higher-stakes_** proposals,
  with **no time quota and no mandatory committee for trivial** ones, and itself **inherits
  the grounding requirement**.
- The bounded structured return and the rendered assessment both carry the **evidence
  anchors** per the engine's contract.

This mode serves jobs 3 (Phase 1: validate a developer's would-be idea) and 4 (Phase 8:
validate a session-surfaced idea) — both must now be grounded.

## Context & seams

- Reference — do not restate — the **evidence-anchor contract in
  `evaluation-engine.md`** authored in t01 (the `**Evidence:**` label, the item format
  `<repo-relative locator> — <what it establishes> (<criterion>)`, count 0–5 with the
  zero-legal justification, contact-verb honesty, locators-only, allow-list, filesystem-only
  investigation, dual enforcement). Match the `**Evidence:**` label and item format
  **verbatim**.
- `.claude/skills/evaluate/references/proposal-gate.md` hook points:
  - **"The lightweight path"** (~21-33): today the single evaluator "score[s] the seven
    criteria and integrate[s] a verdict" from "the proposal text"; "a clear-cut proposal
    needs only the single sandbox score." Re-scope: *light* = fewer reviewers, **never** less
    grounding; the dispatch **requires** the evaluator to investigate the project first
    (Read/Grep/Glob) and reframe its input as **"the proposal plus project evidence."**
  - **Second pass** (same section): add "**or higher-stakes**" alongside "genuinely
    borderline"; add "**no time quota, no mandatory committee for trivial**"; the second pass
    is **also grounded** (still another `evaluator`, never a Bash-capable `generalist`).
  - **"Bounded structured return"** (~35-50): add **evidence anchors** to the evaluator's
    returned fields (repo-relative, bounded, not target excerpts). The coordinator composes
    them **and applies the anchor re-validation from engine element 7b** (allow-list re-check,
    `..`/outside-repo rejection, whole-item content-byte strip, repo-root normalization, ≤5
    cap, never-re-open) **plus** the existing per-criterion leakage-strip — do **not** equate
    the two ("exactly as the justifications" is wrong: element 7b is strictly stronger).
  - **Grounding is the evaluator's filesystem job.** State that the required investigation is
    performed **by the evaluator via Read/Grep/Glob** — the implement-feature/evaluate
    coordinator adds **no** new `gh`/fetch to satisfy grounding (the fixed action envelope is
    unchanged).
  - **"The rendered assessment"** (~53-61): its enumeration of the canonical block must now
    include the `**Evidence:**` line (else it under-describes the engine skeleton).
  - Preserve the **zero-write invariant** framing (~12-18) and the drop/surface/annotate
    dispositions (~80-93) unchanged in substance.
- **Phase-8 pick-list density is owned by t04** (ticket-integration renders the pick-list and
  the filed `## Evaluation` body). proposal-gate need only note that the surfaced assessment
  supports a **lean pick-list** presentation (disposition + the decision-flipping anchors)
  with the **full anchor set in the filed body** — do not restate the exact 1–2 count here;
  t04 is its single home.

## Writable surface
- `.claude/skills/evaluate/references/proposal-gate.md`
- `test/evaluate-skill.test.ts` (ADD proposal-gate assertions only; shared file — append, do
  not rewrite existing `it` blocks)
- `doc/plan/23-evidence-grounded-evaluation/log/t02.md`

Read-only: everything else, including `evaluation-engine.md` (its contract is the source you
cite, not edit) and `evaluator.md`.

## Approach constraints
- **Preserve every currently-pinned collapsed substring** in `proposal-gate.md` that
  `test/evaluate-skill.test.ts` asserts (e.g. "zero github writes", "shell-free", "sandbox
  agent", "second `evaluator` pass", "generalist", "bounded structured", "remain in
  `review.md`", "per-item user choice preserved", "subtracts clear slop, never", "only
  annotates", "never suppresses", "## evaluation", "`gh issue close` is **never**"). Add
  around them; do not delete them.
- Do not weaken the structural zero-write language or the drop/surface/annotate semantics.

## Left open
- Exact prose of the re-scoped "light" framing and the second-pass wording.

## Testing
`test/evaluate-skill.test.ts`, `collapse`-based, pinning obligations (not mere keywords):
- proposal-gate **requires investigation before scoring** (light ≠ ungrounded);
- prose-only score allowed **only** with the explicit no-evidence justification;
- the second pass triggers on borderline **or higher-stakes** and carries **no time quota /
  no mandatory trivial committee**, and is itself grounded;
- the bounded return and rendered block include the `**Evidence:**` anchors.
Keep all existing proposal-gate/zero-write assertions green. Forward-slash any path examples
asserted (anchors carry repo-relative paths).

## Acceptance criteria
- [ ] "Light path" re-scoped so the single-evaluator dispatch requires grounded investigation;
      input reframed to proposal + project evidence.
- [ ] Second-pass allowance updated (higher-stakes trigger, no quota/committee, grounded).
- [ ] Evidence anchors present in the bounded return and the rendered assessment enumeration.
- [ ] Phase-8 pick-list density guidance (≤1–2 anchors, full set in `## Evaluation`) stated.
- [ ] New assertions added; existing proposal-gate + zero-write assertions still green.
- [ ] typecheck and full test suite green.

## Depends on
t01

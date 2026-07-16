# F24 Review: Lean collaborative-planning guidance in the PiCC system prompt

## Outcome

Shipped as planned, in two tasks and with no scope drift. PiCC's always-on
`HARNESS_CONVENTIONS` block now carries a 119-word, model-neutral
collaborative-planning nudge (exported `COLLABORATIVE_PLANNING_GUIDANCE` +
`COLLABORATIVE_PLANNING_MAX_WORDS = 120`), rendered as two trailing bullets inside
the "Claude Code compatibility conventions" block and emitted first in the suffix
so a project's CLAUDE.md, a loaded skill's approval gate, and per-model steering
all get the last word. Tests pin its presence, placement (inside the block),
word/char budget, and subagent reach. A `feature.collaborative-planning` `partial`
registry entry, a regenerated capability matrix, a CHANGELOG entry, and a
user-guide steering note were added following the F19 commit-message-guidance
precedent verbatim.

The single planning decision — model-neutral vs. model-selective placement — was
taken by the maintainer as **model-neutral** (simplest; the wording is written to
be safe for Claude models too, and claude-parity review confirmed it does not make
them over-conversational). The recorded before/after GPT-5.6 Sol behavioural
evaluation is **run by the maintainer separately** (their subscription, their
judgement) and was deliberately not a PR deliverable; `evaluation.md` is the
committed scenarios reference for that run.

## Planning errors & spec gaps

- The plan's authored draft nudge was labelled "119 words" but actually counted
  **121** by the budget test's own tokenizer (space-surrounded em-dashes and `- `
  bullet markers count as tokens under `split(/\s+/)`). The implementer caught it
  and trimmed within permitted polish. Lesson: for a word-budgeted prompt, count
  against the real tokenizer, never a mental word count.
- Otherwise the plan held: the F19 precedent made the seam, test shape, and doc
  surface known up front, so implementation was mechanical and review-driven fixes
  were all seam/consistency nits, not rework.

## Friction

- Minimal. The pre-commit hook (offline suite, ~30–45s here) ran cleanly on every
  commit. The four-cell ticket/checkout routing collapsed to the simple
  maintainer + ticket path (single `origin`, not a fork), so no fork hand-off
  complexity.

## Bugs discovered

- None in existing code. One human-facing wording drift was introduced and fixed
  within this feature: the registry/CHANGELOG paraphrased the nudge's "ask only
  about …" as "discuss only …"; aligned to the shipped verb before commit.

## Improvement opportunities

- **Thin text pin (accepted).** The presence/reach tests grep a single phrase
  ("ask only when blocked"); the load-bearing planning-half wording ("resolve
  discoverable facts by reading, not asking") is not itself pinned, so a future
  edit could rewrite most of the nudge and still pass. This matches the sibling
  `feature.commit-message-guidance` pin depth, so it was left as-is; a stricter
  test could pin the planning-half phrase too.
- **"Exploration / open-ended discussion" folded under "Planning:" (accepted).**
  #51's wording lists "planning/exploration/human-discussion"; the 119-word nudge
  names only "Planning: for a substantial change". Broadening the label costs words
  against a 1-word budget margin and the terseness guardrail, so it was left folded
  — "Planning" reasonably encompasses exploration/discussion of a substantial
  change.
- **Budget margin is thin by design** (~117–119 of 120 words). Any future wording
  edit must re-run the budget test; that is the intended anti-bloat behaviour, not
  a defect.

## Proposed follow-ups

- None worth filing. The two items above are deliberate, low-value tradeoffs
  recorded here for the next editor; neither rises to a tracked issue. The
  behavioural evaluation is the maintainer's own separate activity, not a
  follow-up ticket (per the maintainer's instruction).

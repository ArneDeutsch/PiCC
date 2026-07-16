# t01: Collaborative-planning nudge in the conventions block + tests

## Goal

PiCC's always-on system-prompt suffix carries a compact collaborative-planning
nudge, rendered as terse bullets inside the "Claude Code compatibility
conventions" block, present in both the main-session and subagent prompt
assembly. Its exact text, its placement inside the conventions block, and a
word/character budget are pinned by tests. Typecheck and the full suite are
green.

## Context & seams

- **File:** `src/runtime/context-assembly.ts`.
  - `HARNESS_CONVENTIONS` (currently a module-private const, ~line 99–107) is the
    "## Claude Code compatibility conventions (PiCC)" block, pushed **first** by
    `buildSystemPromptSuffix` (~line 124), before the CLAUDE.md / skills /
    steering sections. Early placement is deliberate: later, more-specific
    sections (project CLAUDE.md, a loaded skill's approval-gate instructions,
    `## Harness guidance` steering) come after and therefore get the last word,
    so the nudge is a **soft default** they can override.
  - `MEMORY_WRITE_POLICY` (~line 116) is the precedent for a **separately
    exported** prompt const with a doc comment.
- **Export a new const** `COLLABORATIVE_PLANNING_GUIDANCE` (the nudge bullet text)
  and a companion `COLLABORATIVE_PLANNING_MAX_WORDS = 120`, so tests import the
  literal and assert on it (matching how `REINJECT_*` budget consts are exported
  and asserted). Compose `HARNESS_CONVENTIONS` so the exported nudge renders as
  the trailing bullet(s) of that block — i.e. the nudge lives *inside* the
  conventions block (honest label, terse tone) while remaining a testable
  isolated const.
  - **TDZ ordering (must):** because `HARNESS_CONVENTIONS` (line 99) will
    interpolate the new const (`` `${...base...}\n${COLLABORATIVE_PLANNING_GUIDANCE}` ``),
    declare `COLLABORATIVE_PLANNING_GUIDANCE` and `COLLABORATIVE_PLANNING_MAX_WORDS`
    **above** the `HARNESS_CONVENTIONS` declaration — NOT beside `MEMORY_WRITE_POLICY`
    (line 116). `MEMORY_WRITE_POLICY` can sit lower because it is consumed later
    (line 139); a const interpolated *into* `HARNESS_CONVENTIONS` is in the temporal
    dead zone until declared, so a lower declaration throws a `ReferenceError` at
    module load. `HARNESS_CONVENTIONS` is module-private with a single consumer
    (`buildSystemPromptSuffix`, line 124), so recomposing it breaks nothing else.
  - Note the F15 subagent bullet (line 104) and F19 commit bullet (line 107)
    already live as trailing bullets of this same block — follow that in-file
    pattern for the new bullets.
- **Reaches subagents for free.** Both `buildSystemPromptSuffix` call sites in
  `src/index.ts` (main session ~line 999; subagents ~line 616) go through the
  same function, and `skipProjectContext` agents (Explore/Plan) keep the
  conventions block. Do **not** gate the nudge on `skipProject`. No `index.ts`
  change and no new `AssemblyInputs` field are needed.

### The nudge text — finalized draft (119 words by the budget test's counter)

Terse, imperative, single-sentence bullets matching the existing block's density
(see the `- Subagents:` / `- Commits:` bullets). This draft has been reworked
through plan review and **word-counted to 119** with the exact tokenizer the
budget test uses (`trim().split(/\s+/).filter(Boolean)`, which counts each
space-surrounded em-dash and each `- ` bullet marker as a token). Ship this or a
minor polish of it, but **re-count after any edit and stay ≤ 120**:

> - Planning: for a substantial change, don't act as a mere approval gate. Ground
>   yourself in the repo first — resolve discoverable facts by reading, not
>   asking, and investigate until the open questions are about intent, not facts.
>   Ask only about goals, preferences, and material tradeoffs; when scope is
>   already clear, say so and proceed instead of inventing questions. Surface
>   alternatives and recommend one, briefly. Don't jump from restating a request
>   to "go"/"confirm"; ask for a skill's explicit confirmation only after the
>   intended convergence has genuinely happened.
> - Implementation: once scope is agreed, act decisively; ask only when blocked,
>   lacking authority, or when a choice changes the agreed scope. Concision limits
>   what you say, not how thoroughly you investigate or verify.

This draft already honors the guardrails below: it leads with behaviour (no
abstract "discuss"/"collaborate"/"engage" verbs), co-locates the
"don't-manufacture-questions" guard with "ask", uses outcome framing (no time
budget), keeps the "Planning:"/"Implementation:" self-framing prefixes, and
sequences (not forbids) a skill's confirmation gate.

**Wording guardrails (from the claude-parity investigation — the nudge is injected
for Claude models too, so avoid making them over-conversational; issue risk #7):**
- **No hard-coded time budget** (no "~one minute"). Use outcome framing:
  "investigate until the open questions are about intent, not facts."
- **Co-locate the "don't manufacture questions when scope is clear" guard with
  the "ask the user" clause** so asking doesn't read as the default.
- **Avoid** "always ask/confirm before proceeding", "restate and check your
  understanding", prescribed turn structures ("first summarize, then list…"),
  open-ended "keep the user informed", and abstract verbs ("discuss",
  "collaborate with", "engage"). **Prefer** concrete verbs (recommend, surface
  tradeoffs, ask when blocked) and goal-framing over format-framing.
- Keep the soft-default framing so it can't fight a skill's explicit approval gate.
- Keep it to a bullet or two — this block is re-sent every turn and never
  compacted, so every sentence is a permanent per-turn cost.

## Writable surface

- `src/runtime/context-assembly.ts`
- `test/runtime-core.test.ts`
- `test/builtin-agents.test.ts` — a single `toMatch` asserting the nudge reaches a
  subagent/Plan prompt (this is the only test that actually pins the "reaches
  every model, including `skipProjectContext` agents" claim, so it is required,
  not optional).

## Approach constraints

- The nudge is **model-neutral** — injected identically for every model; no
  model/provider conditioning (decided in planning).
- It must live **inside** the conventions block, before the CLAUDE.md section
  (i.e. keep `HARNESS_CONVENTIONS` first in `buildSystemPromptSuffix`).
- Keep the final nudge **≤ 120 words** (the acceptance budget). Set
  `COLLABORATIVE_PLANNING_MAX_WORDS = 120` and have the test assert **≤ 120**, so
  the pinned budget equals the stated criterion (do not loosen the ceiling above
  120).

## Left open

- Final wording within the budget and guardrails.
- Whether to add the optional `builtin-agents.test.ts` subagent-reach assertion.
- Exact load-bearing phrase(s) the presence test greps for (pick stable ones).

## Testing

In `test/runtime-core.test.ts` (beside the existing F15 subagent-nudge and F19
commit-nudge assertions in the "builds a suffix containing…" test, ~line 174–227):
- **Presence + placement:** assert the assembled suffix contains a load-bearing
  phrase of the nudge, and that its index is **after** the conventions header
  ("Claude Code compatibility conventions") and **before** the next `\n## `
  section header — i.e. still inside the conventions block. Pick a **newline-free**
  load-bearing phrase for the grep (e.g. `acting as a mere approval gate` or
  `ask only when blocked`), so CRLF-vs-LF in the source template can't split it.
  The existing "builds a suffix containing…" test fixture already yields a
  following `## ` section (Project instructions / rules / skills), so the boundary
  is satisfiable.
- **Subagent reach (required):** in `test/builtin-agents.test.ts` (which already
  asserts the conventions block reaches a subagent prompt), add one `toMatch`
  that the collaborative-planning nudge phrase reaches a subagent/Plan prompt.
- **Budget guard** (own `it(...)`, asserting on the exported const, CRLF-normalized):
  - word count `COLLABORATIVE_PLANNING_GUIDANCE.trim().split(/\s+/).filter(Boolean).length`
    is `>= 60` (guards accidental gutting) and `<= COLLABORATIVE_PLANNING_MAX_WORDS`
    (= 120; the anti-bloat guard);
  - character ceiling on `COLLABORATIVE_PLANNING_GUIDANCE.replace(/\r\n/g,"\n").length`
    (e.g. `<= 900`) as a secondary guard so long words can't dodge the word ceiling.
- All existing context-assembly / skill-activation / compaction / steering /
  capability tests stay green (all current assertions on this block are
  substring/regex, so adding text breaks nothing).
- Cross-platform: counting must be newline-agnostic (`split(/\s+/)`; normalize
  `\r\n` before the char measure).

## Acceptance criteria
- [ ] `COLLABORATIVE_PLANNING_GUIDANCE` + `COLLABORATIVE_PLANNING_MAX_WORDS`
      exported from `context-assembly.ts`; nudge renders inside the conventions
      block, before the CLAUDE.md section, in both main + subagent assembly.
- [ ] Nudge is ≤ 120 words and follows the wording guardrails above.
- [ ] Presence/placement test + word/char budget test + required subagent-reach
      test added and passing.
- [ ] typecheck and full test suite green.

## Depends on
–

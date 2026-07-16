# F24 observations

Running record of friction / bugs / opportunities (Phase 7). Raw material for
`review.md`.

- 2026-07-16 (t01) — The nudge draft I authored in the plan claimed "119 words"
  but counted **121** by the budget test's own tokenizer (em-dashes and `- `
  bullet markers count as tokens under `split(/\s+/)`). Coordinator hand-counting
  is error-prone at a ±2-word margin; the pinned budget test is the real source of
  truth. Implementer self-corrected with two permitted trims. Process note: for a
  word-budgeted prompt, verify against the actual tokenizer, not a mental count.
- 2026-07-16 (t01) — Clean seam: the F15/F19 nudges already live as trailing
  bullets of `HARNESS_CONVENTIONS`, so a third nudge followed an established
  in-file pattern; no `index.ts` change needed (both call sites share
  `buildSystemPromptSuffix`, and `skipProjectContext` agents keep the block).
- 2026-07-16 (t01) — The shipped nudge sits ~117 words, three under the 120
  ceiling. Any future wording edit must re-run the budget test — thin margin by
  design (it's an anti-bloat guard), but worth flagging in `review.md`.
- 2026-07-16 (t02) — The registry/docs described the nudge as "discuss only
  goals/preferences/tradeoffs" while the shipped nudge says "ask only about" —
  human-facing paraphrase drifted slightly from the model-facing source. Fixed to
  match verbatim. Process note: when a capability note paraphrases a shipped prompt
  string, quote the prompt's own verb rather than a synonym.
- 2026-07-16 (t02) — F19 (`feature.commit-message-guidance`) was an exact,
  reusable precedent for this whole task (registry entry shape, generated-matrix
  regen, CHANGELOG idiom, user-guide steering note). Having a near-identical prior
  feature made the docs work mechanical and low-risk.

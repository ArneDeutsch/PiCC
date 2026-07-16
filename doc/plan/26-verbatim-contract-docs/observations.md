# Observations — F26 (verbatim-contract docs)

Running record of friction, bugs, and opportunities. Dated bullets, one line each; raw material for
review.md.

## Phase 1 — direction / investigation (2026-07-16)

- **The ticket (#46) was largely over-valued as written.** Deep investigation showed the "problem" is
  faithful to Claude Code (Claude appends the same in-band resume trailer to resumable subagent
  results), fails safe in the only consumer (evaluate L1 → UNSURE), and the proposed "second channel"
  is not representable inside a tool result on any provider (OpenAI/Anthropic collapse a tool result to
  one string; `details` is never serialized to the model). Decided WITH the maintainer to downsize to a
  docs-truthfulness fix and keep the Claude-faithful trailer.
- **The registry claim was actually false, not just imprecise:** `architecture.md` asserted skills
  parse locked YAML from the verbatim message as "a hard contract" — the exact thing the trailer
  breaks for resumable dispatches. Good example of an aspirational claim ossifying into a "contract."
- **Investigation cost vs. change size:** ~4 subagent investigations (parity ×2, coder trace, API
  research) to land a ~6-line docs correction. Proportionate here because the *decision* (build the
  channel or not) was the expensive part, not the edit — but worth noting the ratio.

## Phase 7 — implementation (2026-07-16)

- **`doc/supported-features.md` is generated + guarded.** `test/registry.test.ts` has an in-process
  matrix-freshness guard, so forgetting `npm run gen:capabilities` fails a test — a good un-fakeable
  discipline. Edit the registry, regenerate, done.
- **Coordinator-authored edits** (not delegated to an implementer): the deliverable was nuanced
  truthful wording grounded in the investigation only the coordinator held; independent review handled
  by claude-parity + docs on the diff. Deviation from the "substantive writing → implementer" default,
  taken deliberately for proportionality on a docs-only change.

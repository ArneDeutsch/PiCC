# F26 Review: Truthful "verbatim final message" contract in the docs

## Outcome

Shipped a **docs-only truthfulness fix** — a deliberate downsize of issue #46. The capability
registry (`tool.Agent`), `doc/design/pi-integration.md`, and `doc/architecture.md` (four sites, incl.
the crux "**Verbatim subagent return**" principle and the "skills parse locked YAML … a hard
contract" claim) now describe the **real** contract: a subagent's final-message *body* is verbatim,
but a **resumable** dispatch appends a clearly-delimited in-band identity/resume trailer to the
model-visible text — faithful to Claude Code, and stripped from the human TUI. Regenerated
`doc/supported-features.md`; added a CHANGELOG entry. **No behavior change, no test change** (existing
tests already encode the real contract; the capability-matrix freshness guard confirms the registry↔
matrix sync). One task (t01), reviewed on the diff by `claude-parity` + `docs`.

The larger thing #46 literally asked for — a second, byte-exact identity channel — was **deliberately
not built.** The decision and its full rationale live in `feature.md`; in short: the in-band trailer
is Claude-faithful (keeping it is correct parity), no provider exposes a model-distinguishable
metadata channel inside a tool result (so a "second channel" can only be a separate injected message,
with real cost/divergence), and the only consumer today (`evaluate` L1) already fails safe.

## Planning errors & spec gaps

- **The task's correction-site list was enumerated by a case-sensitive grep** and so omitted the
  capitalized "**Verbatim subagent return.**" *principle* bullet in `architecture.md` — the single
  strongest unqualified claim in the repo. Both reviewers caught it independently; fixed. Lesson:
  sweep for contract claims **case-insensitively** (a titled principle hides from a lowercase grep).

## Friction

- Ratio of investigation to change was high (~4 subagent investigations — parity ×2, an internal
  tool-result trace, a provider-API study — for a ~6-line docs correction). Justified: the expensive
  part was the *decision* (build the channel or not), not the edit. Worth remembering that a small
  diff can be the correct output of a large investigation.
- `doc/supported-features.md` is generated **and** guarded by an in-process freshness test — a good,
  un-fakeable discipline: edit the registry, `npm run gen:capabilities`, done.

## Bugs discovered

- **The false "verbatim (no wrapper)" claim itself** — an aspirational contract ("skills parse locked
  YAML … a hard contract") that ossified in the docs while the runtime appended a resume trailer that
  breaks exactly that parse for resumable dispatches. Now corrected. (A 2026-07-11 review artifact,
  `doc/review/2026-07-11-deep-review-findings.md:396`, had already *predicted* this class of problem —
  left as historical record.)
- No pre-existing runtime bugs surfaced (behavior was already Claude-faithful; only the docs lied).

## Improvement opportunities

- Human-audience "verbatim" mentions (`README.md:53`, `doc/user-guide.md:24/:480`,
  `CONTRIBUTING.md:54`) were intentionally left: for a human the TUI *does* strip the trailer, so
  "verbatim" is genuinely true there, and they are below this task's contract altitude. If a future
  pass wants uniform phrasing, they could carry a one-clause aside — low value.

## Proposed follow-ups

- **A secure, byte-exact structured-output channel between agents** — only if a real consumer emerges
  beyond `evaluate`'s fail-safe screen. If built, do it as a separate harness-authored message
  (forgery-safe; the only portable form across GPT/Claude), eyes open to the model-facing divergence
  from Claude's in-band trailer. This is the deferred core of #46, captured so it isn't lost.

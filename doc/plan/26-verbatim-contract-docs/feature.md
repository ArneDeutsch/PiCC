# F26: Truthful "verbatim final message" contract in the docs

Ticket: ArneDeutsch/PiCC#46

## What

PiCC's capability registry and design docs claim a subagent's final message is returned
**"verbatim (no wrapper)."** That is **false for resumable dispatches**: the harness appends a
clearly-delimited in-band identity/resume trailer (`— resumable via SendMessage`) to the
model-facing text, matching Claude Code's own behavior. This feature makes the documented contract
describe what actually happens, so the registry is truthful and readers know the real parser-facing
shape.

Observable outcome: the capability registry entries (`tool.Agent`, `tool.Task`, `tool.TaskOutput`)
and the Pi-integration design doc state the real contract — final message returned verbatim for
**non-resumable / one-shot** dispatches, and verbatim **plus a clearly-delimited identity trailer**
for **resumable** dispatches — and note that the trailer is in-band, model-visible text (so an
exact-token / JSON / YAML consumer must account for it), is faithful to Claude Code, and is stripped
from the human TUI render.

**Non-goals (explicit):**
- **No behavior change.** The in-band trailer stays exactly as-is — it is faithful to Claude Code,
  which appends the same kind of resume handle to resumable subagent results.
- **No second / out-of-band identity channel.** #46's literal proposal (move identity to structured
  tool-result metadata, or a separate raw-final field) is deliberately **not** built here — see Why.
- **No change to `evaluate`** or any other consuming skill, and no change to L1 parse behavior.
- **No change to the TUI render** — it already strips the trailer and shows a resumable footer.

## Why

The "verbatim (no wrapper)" claim is a **truthfulness bug in the capability registry**. PiCC's
registry exists to describe real behavior precisely (it feeds `/doctor` and the capability matrix); a
reader trusting "verbatim (no wrapper)" would be wrong for *every* resumable dispatch. Correcting it
is cheap and unambiguously right.

We deliberately **keep the in-band trailer and do not build the second channel** #46 originally
proposed. The reasoning (recorded here so a future session finds the analysis instead of re-deriving
it):

- **It is faithful to Claude Code.** Real Claude Code appends the same in-band resume handle to
  resumable subagent results (its one-shot Explore/Plan agents get none). PiCC's purpose is to run
  Claude-configured projects with *similar results*; a separate-message identity channel would be a
  fresh model-facing divergence.
- **No provider supports a clean "second channel" inside a tool result.** OpenAI and Anthropic both
  collapse a tool result to a single text blob the model parses; multi-part arrays are for modality
  (text/image/file), not payload-vs-metadata, and `details` is never serialized to the model. The
  only real "separate channel" is a separate injected message — which adds per-dispatch context
  noise, a foreground next-turn timing split, and regression risk to a heavily-tuned,
  security-sensitive surface.
- **The only consumer today already fails safe.** PiCC's own `evaluate` L1 screen downgrades any
  extra bytes to `UNSURE` (keep-open); only the aggressive auto-close-on-malicious path is
  conservatively disabled, which is acceptable.
- **If a real need arises later** for a secure byte-exact structured-output channel between agents, it
  should be built *deliberately*, eyes open to the divergence — not pre-emptively now.

## Acceptance

- The capability registry no longer states or implies an unqualified "verbatim (no wrapper)" final
  message for resumable dispatches; it accurately describes the in-band identity/resume trailer and
  its Claude-faithful nature.
- `doc/design/pi-integration.md`'s "returned verbatim" statements are corrected to the real contract.
- Any other doc that repeats the unqualified "verbatim" claim is swept and aligned.
- The generated capability matrix (`npm run gen:capabilities`) is regenerated and consistent.
- CHANGELOG records the documentation correction.
- No behavioral change; typecheck + the full test suite stay green.

## Tasks

1. t01 Correct the "verbatim final message" claims to the real contract (depends on: –)

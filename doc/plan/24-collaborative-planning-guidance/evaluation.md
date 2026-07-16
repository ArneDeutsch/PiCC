# F24 evaluation scenarios (maintainer reference)

This is a **maintainer-facing scenarios reference**, not an automated test and not run
in CI. It records the three behavioural scenarios from ticket
[ArneDeutsch/PiCC#51](https://github.com/ArneDeutsch/PiCC/issues/51) ("Suggested
evaluation scenarios") so the collaborative-planning nudge (F24) can be judged
consistently.

The maintainer runs these **live in picc with GPT-5.6 Sol** and rates each one
separately (before/after the nudge, and against a Claude Code side-by-side where
useful). Per the feature acceptance, this evaluation is **not a blocking deliverable**
of the PR — it is the reference the maintainer's separate run follows. Because the
nudge is guidance, not enforcement, outcomes are model-dependent; rate the posture,
not an exact transcript shape.

## Scenario 1 — Ambiguous planning request (two user-visible resolution choices)

Give the model a substantial but under-specified planning request where at least two
materially different directions are both defensible (e.g. a feature that could be built
as a lightweight in-prompt nudge *or* as a stateful mode, with different tradeoffs).

Observe:
- Does it do targeted **read-only scouting of the repo first** and resolve the
  discoverable facts itself, rather than opening with a list of questions?
- Does it **surface the meaningful alternatives** and **recommend one** with concise
  reasoning, rather than dumping the decision back on the human?
- Does it ask the human only about **goals, preferences, and material tradeoffs** — the
  things that actually change the result — and hold that to a small number of
  purposeful questions?
- Does it **avoid collapsing** the planning phase into a restatement-then-"go"/"confirm"?

## Scenario 2 — Clear, detailed ticket (no material ambiguity)

Give the model a well-scoped, detailed ticket where the WHAT/WHY is already
decision-complete.

Observe:
- Does it recognise that **no material ambiguity remains**, say so, and briefly invite
  corrections — rather than **manufacturing ceremonial questions** to look collaborative?
- Does it still do enough grounding to confirm the ticket matches the repo, without a
  redundant interview round?
- Does it move toward action without a premature, content-free "confirm?" prompt?

## Scenario 3 — Confirmed implementation task (scope already agreed)

Give the model a task where scope has already been agreed / confirmed and the work is
implementation.

Observe:
- Does it **act decisively and autonomously within the confirmed scope**, turning
  routine implementation details into progress rather than repeated questions?
- Does it ask **only when genuinely blocked**, when authority is missing, or when a
  choice would materially alter the agreed behaviour/scope?
- Is concision applied to **user-facing verbosity only** — not to the depth of its tool
  use, investigation, or verification?
- Does it still honour any skill-authored approval gate at the right moment (after real
  convergence), rather than skipping or front-loading it?

## Rating notes

- Treat the nudge as a **posture**, not a state machine: partial adoption still counts;
  rate degree.
- The nudge is model-neutral (injected identically for every model); differences across
  models are expected and are the point of running it live.
- A useful baseline is the same skill (e.g. `implement-feature`) under Claude Code
  side-by-side, per issue #51's evidence.

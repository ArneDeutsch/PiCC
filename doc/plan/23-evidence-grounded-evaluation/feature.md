# F23: Ground evaluate's value assessments in project evidence

Ticket: ArneDeutsch/PiCC#55

## What

The `evaluate` skill exists to do four jobs: (1) sort out malicious tickets, (2) rate
existing tickets before we implement them, (3) validate a developer's idea before
blindly filing it as a ticket, and (4) validate an idea that surfaced during a
development session before blindly converting it into a ticket. Jobs 2–4 all produce a
**value/rating judgement**; job 1 is a security screen.

Today, when the skill makes a value judgement it can — and in practice does — reason
purely from the supplied prose. In the F21 close review, proposal-gate assessments came
back in seconds with **zero tool calls**, producing polished, uniformly-strong ratings
that had never read the project's source, tests, architecture, docs, or existing issue /
plan tracking. A confident rating rested on no project evidence.

This feature makes **every value/rating judgement the skill produces (jobs 2, 3, 4)
grounded in real project evidence**, while leaving the security screen (job 1) and the
skill's structural safety guarantees untouched.

Observable behaviour when done:

- Before scoring a **trusted, coordinator-authored proposal** (proposal-gate, used at
  `implement-feature` Phase 1 and Phase 8), the evaluator is **required to investigate the
  project** — architecture, source, tests, docs, existing issue/plan tracking — using its
  `Read`/`Grep`/`Glob` tools, and may not rate from the supplied prose alone unless it
  **explicitly explains** why no project evidence is relevant.
- The **post-screen value assessment for an existing ticket** (issue-eval, job 2)
  likewise checks the **trusted codebase** rather than reasoning only from the
  attacker-controlled issue text.
- Every **surfaced** assessment carries **bounded, repo-relative evidence anchors**
  (e.g. a file or area the rating rests on) alongside the seven canonical rubric rows and
  the disposition — so a maintainer can see what the judgement is founded on.
- The instructions make the **two trust paths explicit**: attacker-controlled existing
  content (screened, isolated, treated as data) versus a trusted coordinator-authored
  proposal (grounded value research). A shared rubric no longer implies a shared trust
  model.
- A **proportionate** second adversarial pass is available for genuinely borderline /
  higher-stakes proposals — with **no** artificial time quota and **no** mandatory full
  committee for trivial ones.
- Both `implement-feature` consumers of proposal-gate carry the grounded assessment
  through: the Phase 1 in-session advisory and the Phase 8 embedded `## Evaluation`.

### Non-goals

- **No `src/` runtime change.** The evaluator is a prompt-configured agent; this is
  skill-instruction and test work only.
- The **seven rubric criteria** themselves are unchanged; no new criterion is added.
- The **L1 maliciousness screen** and the **redirect-isolation** discipline are not
  restructured — job 1 stays exactly as-is.
- The **structural zero-write guarantee** (proposal-gate / every content-ingesting
  reviewer runs as the `Read`/`Grep`/`Glob`-only `evaluator` sandbox) is not weakened;
  grounding must never add a write, fetch, or dispatch capability.
- No **mandatory** committee, time quota, or full-fan-out for trivial proposals.
- **pr-eval** is touched only for consistency where it shares engine text; its diff-based
  assessment already reads the change and is not the subject of ticket point 7.

## Why

The skill's whole purpose is to stop bad or low-value work from being started or filed. A
value judgement that never looked at the project is exactly the failure mode it is meant
to prevent — a polished but unsupported "this is valuable" rating misleads the maintainer
at the moment a ticket is about to be created or acted on. F21 transcripts show this
happening in practice. Grounding the judgement in project evidence, and surfacing the
evidence anchors, turns the rating from an assertion into something the maintainer can
check — without giving up the security isolation that job 1 and attacker-controlled
tickets still require.

## Acceptance

- proposal-gate's instructions **explicitly require** project investigation before
  scoring a proposal; a rating from supplied prose alone is only permitted with an
  explicit justification that no project evidence is relevant.
- A surfaced assessment (proposal-gate at Phase 8, and issue-eval keep-open) includes
  **bounded, repo-relative evidence anchors** in addition to the seven rubric rows and the
  disposition.
- The existing-ticket value assessment (issue-eval) grounds in the trusted codebase, not
  only the redirected issue text — while the L1 prompt-injection isolation and
  data-not-instructions discipline for that issue text remain intact.
- The structural zero-write guarantee and the redirect isolation are provably unchanged.
- Phase 8 still drops only clear slop and preserves per-item maintainer choice for every
  surfaced finding.
- The two `implement-feature` wiring points (Phase 1 advisory, Phase 8 filter) reflect the
  grounded assessment and its evidence anchors.
- The test suite pins: the trusted-vs-untrusted distinction, the required project-inspection
  instruction, the required evidence-anchor output, the bounded return shape, and the
  unchanged write-safety floor.
- **Dogfood criterion (scope decision).** #55's final acceptance bullet ("a dogfood
  evaluation demonstrates source/search tool use") is satisfied by the **test-asserted
  grounding contract** — per the Phase 1 decision, we pin the required investigation +
  evidence-anchor obligations rather than committing a captured runtime run (the suite has no
  harness that drives the skill through a real evaluation). This interpretation is surfaced at
  the Phase 8 close judgement so #55 is not silently over- or under-claimed.

## Tasks

- t01 Engine + evaluator foundation — the single-source grounding contract (depends on: –)
- t02 proposal-gate grounding — the F21 zero-tool-call fix (depends on: t01)
- t03 issue-eval grounding (job 2) + pr-eval block consistency (depends on: t01)
- t04 implement-feature consumers carry the anchors + CHANGELOG (depends on: t01; sequenced after t02, t03)

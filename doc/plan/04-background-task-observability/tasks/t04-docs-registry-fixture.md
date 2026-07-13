# t04: Docs, capability-registry truthfulness, and fixture coverage

## Goal

The repo's own records tell the truth about the shipped behavior: the capability registry reflects
TaskOutput's new observability render and honestly names the remaining divergence from Claude Code;
the CHANGELOG and any affected docs are updated; and the full-surface fixture exercises a background
dispatch retrieved via TaskOutput so the new surface is executably covered.

## Context & seams

- **`src/registry/capability-registry.ts`:**
  - `tool.TaskOutput` (currently `full`): extend its note to name the new observability render — live
    rolling-tail + activity while awaiting, outcome badge + transcript + usage on settle, and
    self-identifying header (task id + agent type + `agent-<id>`). Tier stays `full`.
  - `feature.background-agents` (currently `partial`): add to its GAPS that PiCC has **no always-on
    Agent View dashboard** (Claude Code's `claude agents`, v2.1.139+) — background progress is
    observable only while a `TaskOutput` call is awaiting (the deliberate non-goal of F04). Tier stays
    `partial`. Do NOT invent a `/tasks` slash command — the Claude Code surface is the `claude agents`
    shell command; name it accurately.
  - Do not invent a new capability id; F04 is observability over the existing lifecycle.
- **Generated matrix:** run `npm run gen:capabilities` after editing the registry and commit the
  regenerated artifact so the doc matrix matches the registry.
- **`doc/supported-features.md`:** update only if it describes TaskOutput/background-agents in prose
  that this change makes stale.
- **`CHANGELOG.md` (`[Unreleased]`):** add an entry under an appropriate `### Added`/`### Fixed`
  heading describing background-task observability (TaskOutput streams like a foreground agent; every
  background surface names its agent). Keep the model-facing verbatim contract note ("display-only").
- **Fixture `examples/full-surface`:** today it contains **no** background dispatch and no
  `TaskOutput` (only the word "background" in prose inside `fork-research/SKILL.md`); add a path that
  actually dispatches an agent with `run_in_background: true` (or a `background: true` agent) and
  retrieves it with `TaskOutput`, so the new render surface is covered by the fixture. Keep the
  fixture minimal and self-consistent with its existing structure.

## Writable surface

- `src/registry/capability-registry.ts`
- the generated capability-matrix artifact updated by `npm run gen:capabilities` (commit it)
- `doc/supported-features.md` (only if prose is now stale)
- `CHANGELOG.md`
- `examples/full-surface/**` (the added background+TaskOutput path)

## Approach constraints

- Registry notes must be **truthful and specific** — describe what actually ships (per t03), not
  aspirational behavior. Do not claim an always-on dashboard.
- Regenerate the matrix with the script; never hand-edit the generated file.
- The fixture must not require network or a live model to be structurally valid (it is a static
  surface example, consistent with the others).

## Left open

- The exact fixture shape (which agent, foreground skill vs. a dedicated example) as long as it
  exercises a background dispatch + TaskOutput retrieval.
- Whether `doc/architecture.md` warrants a one-line note about the new `subagent-render.ts` module
  boundary (add only if it improves the architecture doc's accuracy).

## Testing

- `npm run gen:capabilities` produces no diff after commit (registry and matrix consistent); any
  registry/matrix consistency test in the suite passes.
- typecheck + full suite green.
- Manual read-through: registry notes match t03's shipped behavior; CHANGELOG entry accurate.

## Acceptance criteria
- [ ] `tool.TaskOutput` and `feature.background-agents` registry entries updated truthfully; matrix
      regenerated and committed; consistency check green.
- [ ] CHANGELOG `[Unreleased]` entry added; stale prose in `doc/supported-features.md` (if any) fixed.
- [ ] `examples/full-surface` exercises a background dispatch retrieved via `TaskOutput`.
- [ ] typecheck and full test suite green.

## Depends on
t03

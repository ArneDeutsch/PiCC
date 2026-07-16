# t02: Capability registry entry, generated matrix, CHANGELOG, user-guide

## Goal

The repo's own records reflect the new nudge, following the F19
commit-message-guidance precedent exactly: a `partial` capability-registry entry
whose note states the guidance-only + model-dependent nature, a regenerated
`doc/supported-features.md`, a CHANGELOG entry, and a user-guide note naming the
steering override as the lever to change interaction style. Plus a lightweight
evaluation-scenarios reference in the plan folder for the maintainer's separate
live run. Typecheck and the full suite are green.

## Context & seams

- **Registry:** `src/registry/capability-registry.ts`. The direct precedent is
  `feature.commit-message-guidance` (`partial`) at ~line 243, in the
  `FEATURE_ENTRIES` array. Add `feature.collaborative-planning` (`partial`)
  adjacent to it. The note must state: always-on, every-turn conventions-block
  nudge (rebuilt each turn, survives compaction); what it steers (collaborative
  planning/exploration posture; decisive implementation after convergence;
  preserves skill approval gates); and the PARTIAL rationale — **guidance only,
  outcome model-dependent (a prompt nudge, not deterministic), not a mode/state
  machine, no plan-mode gate**. Keep the note phrased as general planning posture,
  **decoupled from the plan-mode tool surface** — do not imply `feature.plan-mode`
  (a `degraded-noop`) works; an explicit half-clause disclaiming the overlap
  ("a planning *posture*, not plan mode; the plan-mode tool surface stays
  degraded-noop") is welcome for `/doctor` readers.
  - **The note must be a single line** — `test/registry.test.ts:140-144` asserts
    every note is non-empty and contains **no `\n`**. Use semicolons, not
    newlines, however long the note gets.
- **Generated matrix:** `doc/supported-features.md` is generated from the registry
  by `npm run gen:capabilities` (`scripts/gen-capability-matrix.mjs`, wired in
  `package.json`). **Do NOT hand-edit it** — run the generator and commit the
  result; verify a new `feature.collaborative-planning | partial` row appears.
- **CHANGELOG:** `CHANGELOG.md`. Add a self-contained
  `### Added — <title> (2026-07-16)` subsection at the **top of `[Unreleased]`**
  (currently the top block is the "description-based feature naming" entry ~line 9;
  insert above it). Model the prose on the F19 entry ("richer git commit messages
  by default", ~line 161): bold lead sentence; explain it applies to every project
  under PiCC and is a best-effort prompt nudge whose **outcome is model-dependent
  (guidance, not enforcement)**; close with the steering-override sentence pointing
  at the user guide. Insert as a **whole new block** (not interleaved) to keep
  serial merges conflict-clean.
- **User guide:** `doc/user-guide.md`, the Harness-configuration / `steering`
  section (~line 310–321+), which already frames steering as "your lever over
  those built-ins … layers on top of the built-in default." Add a concise note
  naming the collaborative-planning posture as another built-in default that
  steering can tone down / adjust, reusing the existing `~/.picc/config.json` /
  `.claude/.picc/config.json` paths and the worked-example idiom. Use the term
  **"steering"** consistently (not "knob"/"override config").
- **README:** likely no change (it defers steering to the user guide and the matrix
  to supported-features). Only touch if the feature overview genuinely needs it —
  default is PASS.
- **Evaluation-scenarios reference:** write `doc/plan/24-collaborative-planning-guidance/evaluation.md`
  — a short, maintainer-facing reference (NOT a test, NOT run here): the three
  scenarios from the ticket (ambiguous-planning with two user-visible resolution
  choices; clear detailed ticket; confirmed implementation task), what to observe
  in each (per issue #51's "Suggested evaluation scenarios"), and a note that the
  maintainer runs these live in picc with GPT-5.6 Sol and rates them separately.
  Keep it brief.

## Writable surface

- `src/registry/capability-registry.ts`
- `doc/supported-features.md` (generated — via `npm run gen:capabilities` only)
- `CHANGELOG.md`
- `doc/user-guide.md`
- `doc/plan/24-collaborative-planning-guidance/evaluation.md`
- `README.md` (only if genuinely needed; default: no change)

## Approach constraints

- Registry note must not claim plan-mode/state-machine behaviour; it is a prompt
  nudge, `partial`, model-dependent.
- Regenerate the matrix; never hand-edit `doc/supported-features.md`.
- Do not modify any target-project artifact or the `implement-feature` skill.

## Left open

- Exact registry note wording (within the constraints above).
- Exact CHANGELOG title and user-guide sentence.

## Testing

- Run `npm run gen:capabilities` and confirm the generated matrix updates with the
  new row and no unintended diff.
- The registry test that enforces regeneration is the **matrix-freshness diff**
  (`test/registry.test.ts:532`), which regenerates in-process and asserts it equals
  the committed `doc/supported-features.md` (CRLF-normalized) — so skipping the
  regen fails there. There is **no** hardcoded total-count / exhaustiveness /
  ordering test to update (per-tier counts derive from the registry): adding one
  unique `partial` entry with a single-line note trips none of them.
- typecheck + full suite green.

## Acceptance criteria
- [ ] `feature.collaborative-planning` `partial` entry added with a guidance-only +
      model-dependent note that does not imply plan mode.
- [ ] `doc/supported-features.md` regenerated (not hand-edited) with the new row.
- [ ] CHANGELOG `### Added` block at the top of `[Unreleased]`, F19-styled, ending
      in the steering-override pointer.
- [ ] User-guide steering section names the collaborative-planning posture as a
      built-in adjustable via steering, with the config paths.
- [ ] `evaluation.md` scenarios reference written for the maintainer's separate run.
- [ ] typecheck and full test suite green.

## Depends on
t01 (the exported const / behaviour it documents must exist)

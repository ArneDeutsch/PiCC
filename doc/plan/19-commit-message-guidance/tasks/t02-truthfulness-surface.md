# t02: Truthfulness surface — registry entry, matrix, docs

## Goal

The capability registry, the generated matrix, and the user-facing docs honestly
describe the new commit-message default: a best-effort, always-on nudge (tier
`partial`, NOT full Claude Code commit parity), with the existing per-model `steering`
config named as the user's lever (augments; cannot fully disable the built-in default).

## Context & seams

- **Registry:** `src/registry/capability-registry.ts`. Entries are declared via
  `cap("<kind>", "<id>", "<tier>", "<note>")`. Existing `feature`-kind entries include
  `feature.background-agents` (~line 232) and the F10 precedent
  `feature.agent-memory` (~line 241, a `partial` with a `PARTIAL:` disclosure of an
  injected-prompt divergence). The only commit-adjacent entries are
  `setting.includeCoAuthoredBy` and `setting.attribution` (~lines 140-141,
  `degraded-noop`, "no commit-attribution machinery") — **do not modify these**; this
  feature does not touch attribution.
- **Add one new entry:** `cap("feature", "feature.commit-message-guidance", "partial", …)`.
  The note must state what it does (always-on, every-turn nudge to read git
  status/diff + recent git log, match the repo's commit-message style, favor
  why-over-what) AND explicitly disclose it is NOT full parity — guidance only,
  outcome model-dependent; omits Claude Code's full commit ceremony (no HEREDOC commit
  form, no attribution trailer, no parallel git status/diff/log batching); attribution
  stays governed by `setting.includeCoAuthoredBy`. Match the disclosure style of the
  existing `feature.background-agents` / `tool.Agent` notes (they enumerate GAPS/PARTIAL
  inline). If entries carry a `§`-section reference, follow the same convention using
  whatever design-doc section covers the conventions block; if unsure which section,
  omit the `§ref` rather than inventing one.
- **Matrix:** `doc/supported-features.md` is **generated** — never hand-edit. After the
  registry change, regenerate with `npm run gen:capabilities`. The tier-count assertions
  in `test/registry.test.ts` recompute dynamically and should stay green (verify).
- **Docs (additive — no existing prose goes stale):**
  - `CHANGELOG.md`: insert a new entry at the top of `## [Unreleased]` (between the
    `## [Unreleased]` heading ~line 7 and the first existing `###` entry ~line 9).
    Heading pattern: `### Added — richer git commit messages by default (2026-07-15)`.
    State: the built-in default nudges matching the repo's `git log` style + a why-not-what
    body for non-trivial changes; `--no-verify` prohibition preserved; the lever is the
    existing per-model `steering`. Include a **"why you'd care" clause** — it closes the
    visible quality gap between Claude Code-authored and PiCC-authored commits on the same
    repo — and use the searchable phrase **"commit message"** in the entry (a user annoyed
    by commit verbosity greps for "commit", not "steering"). Keep the honesty register:
    "nudges / approximates Claude Code's commit quality", never "matches Claude Code's
    commit messages" and not the full ceremony.
  - `doc/user-guide.md`: the `### Harness configuration` section, `steering` bullet
    (~lines 291-293). Add a sentence AND a concrete commit-oriented `steering` example.
    Frame the control **honestly and usefully** (plan-review DX finding): the built-in
    convention's *text* can't be deleted, but because `steering` is appended to the system
    prompt AFTER the conventions block (`context-assembly.ts:185-187`, `## Harness
    guidance`), a **contrary `steering` entry — or a project's own commit rule — overrides
    the behavior**, including toning commits down to terse subject-only messages. Do NOT
    write a bare "cannot fully disable" that implies the user is stuck with verbose
    commits; state the override path. Give a copy-pasteable example value, e.g. an
    `"openai/*"` steering entry like `"Keep commit messages to a one-line subject; no
    body unless I ask."` so the lever is actionable, not just named.
  - `README.md`: a brief phrase (not a new section) noting PiCC nudges richer,
    repo-style-matching commit messages by default. Anchor it in the **"what it does"
    capability list** (a commit-quality phrase fits awkwardly in the Control-surface
    `/`-command paragraph); include the phrase "commit message" so it is greppable.
    Honesty register as above (nudges/approximates, not full parity).

## Writable surface

- `src/registry/capability-registry.ts`
- `doc/supported-features.md` (via `npm run gen:capabilities` only — do not hand-edit)
- `CHANGELOG.md`
- `doc/user-guide.md`
- `README.md`
- `doc/plan/19-commit-message-guidance/log/t02.md` (execution log)

## Approach constraints

- The registry note and the docs must not overclaim parity: "incentivizes richer commit
  messages, approximating Claude Code's commit-message quality; not the full commit
  ceremony" is the honest register.
- The user-guide sentence must be honest that `steering` **augments** and cannot turn
  the built-in default off (the feature's accepted limitation / non-goal).
- Regenerate the matrix; do not hand-edit `doc/supported-features.md`.

## Left open

- Exact prose of the registry note and doc sentences, within the honesty constraints.
- Whether a `§ref` is included in the registry note (follow existing convention; omit if
  no clear section applies).

## Testing

- `test/registry.test.ts` (tier-count / registry-shape assertions) must stay green with
  the new entry — run it and confirm. If a count assertion is hardcoded rather than
  dynamic, update it to match the new entry.
- No new behavioral test here (t01 owns the prompt-content assertion). This task is
  registry + generated-doc + prose.

## Acceptance criteria

- [ ] `feature.commit-message-guidance` exists in the registry at tier `partial` with an
      explicit not-full-parity disclosure; attribution entries untouched.
- [ ] `doc/supported-features.md` regenerated from the registry (not hand-edited).
- [ ] CHANGELOG, user-guide (steering lever, augment-only), and README updated and honest.
- [ ] typecheck and full test suite green (incl. `test/registry.test.ts`).

## Depends on

t01 (the wording the docs/registry describe should match what t01 shipped)

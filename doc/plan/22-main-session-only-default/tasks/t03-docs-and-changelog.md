# t03: Prose docs, CHANGELOG, and the full-surface example

## Goal

Every prose document that states or implies the old default (depth 5 / recursion
on by default) or frames the subagent knobs as Claude parity is corrected to the
new default (main-session-only, depth 1, opt into nesting via
`subagents.maxDepth: 2..5`, a deliberate PiCC divergence). The user guide gains a
real description of the three controls and their semantics. The CHANGELOG records
the compatibility-affecting change with a migration snippet. The full-surface
example README makes clear its depth-2 nesting is an explicit opt-in.

## Context & seams

Each edit site (from the docs investigation). **The doc has drifted since the
snapshot — corrected line hints below, but LOCATE BY CONTENT, not line number:**

- `README.md:~54` — "nested dispatch with a configurable depth cap" implies
  recursion out of the box. Add a clause: nesting is **off by default
  (main-session-only)**, an explicit opt-in. Feature-overview altitude — one
  clause, not full semantics.
- `doc/user-guide.md` "nested subagent dispatch (default depth cap 5)" (at `~:386`,
  not the stale `:362`): **change to main-session-only / default 1**. And the
  Partial-tier per-depth concurrency prose (at `~:396-407`): note that nested
  (`depth ≥ 2`) fan-out only happens when `maxDepth` is explicitly raised to 2..5.
- `doc/user-guide.md` — the controls `subagents.enabled` / `maxDepth` /
  `concurrency` are currently **not documented** as project `.claude/settings.json`
  keys (the config section at `~:310` covers only `~/.picc/config.json`). Add
  content covering: the three controls, that they are PiCC extensions (not Claude
  parity), depth semantics (main = depth 0, its subagents = depth 1; default
  `maxDepth: 1` blocks depth-2), scope/precedence, per-agent `tools:` /
  `disallowedTools:` restriction as a further narrowing, and a migration snippet
  to restore recursion. **Contrast the two "off" states explicitly** so users
  don't conflate them: `subagents.enabled: false` / `disableSubagents: true`
  disables **all** delegation (even ordinary depth-1 fan-out), whereas the new
  default `maxDepth: 1` **keeps** depth-1 fan-out and blocks only nesting — a user
  who just wants "no runaway recursion" should raise/keep `maxDepth`, not disable
  subagents. State what `concurrency` does (parallel fan-out limit, default 4) or
  cross-reference the existing Partial-tier prose rather than listing it as a bare key.
- `doc/architecture.md` "enforces the depth cap (default 5)" (at `~:111`): **change
  to default 1 (main-session-only)**. The nested-background-bound block (at
  `~:319-328`, not the stale `:302-313`): add that recursion itself is now off by
  default — a second, larger divergence beyond the per-depth-budget one already
  described.
- `doc/architecture.md` step-6 dispatch narrative (at `~:233`): "Nested dispatch is
  depth-capped; the same guard runs inside every subagent session." Under the new
  default this reads as if subagents routinely attempt nested dispatch. Add a
  clause: nesting is off by default (main-session-only); the tool-provisioning /
  guard only engages when an operator raises `subagents.maxDepth` to 2..5.
- `doc/design/pi-integration.md:87-88` — the stale/contradictory fossil:
  "capped by settings (default 1 nesting level beyond orchestrator = depth 2
  total ⇒ configurable)". Rewrite to the new default and reconcile so it no longer
  disagrees with the other docs (new default = 0 nesting levels beyond the
  orchestrator's direct subagents = depth 1 total).
- `CHANGELOG.md` `[Unreleased]` — add a new dated `### Changed` subsection **above
  the existing `### Changed — description-based feature naming (2026-07-15)`
  entry**: default `subagents.maxDepth` 5 → 1 (main-session-only); a **migration
  snippet** (`"subagents": { "maxDepth": 2 }` in `.claude/settings.json` to
  restore one level, up to 5 — make the 2-vs-5 choice explicit so a user who
  nested 3+ levels doesn't copy `2` and stay broken); and an explicit note that
  this is a deliberate divergence from Claude Code (which nests up to 5,
  non-configurable) and that `enabled`/`maxDepth`/`concurrency` are PiCC
  extensions. Match the existing Keep-a-Changelog / dated-subsection style. Do
  **not** rewrite the older released entry that calls the depth cap
  "Claude-faithful" — it is the historical record of a past release.
- `examples/full-surface/README.md:25` — the "Nested subagents (depth 2)" row.
  The fixture already sets `subagents.maxDepth: 2` in its `settings.json`; make
  the README clear that nesting here works because of that **explicit opt-in**,
  not by default.

## Writable surface

- `README.md`
- `doc/user-guide.md`
- `doc/architecture.md`
- `doc/design/pi-integration.md`
- `CHANGELOG.md`
- `examples/full-surface/README.md`
- `doc/plan/22-main-session-only-default/log/t03.md`

Do **not** edit `doc/supported-features.md` (generated — t02 regenerates it) or
any source/registry file.

## Approach constraints

- Prose must match the shipped default (1) and the registry wording from t02 —
  keep terminology consistent ("main-session-only by default", "PiCC extension",
  "opt into nesting via `subagents.maxDepth: 2..5`").
- Do not restate implementation details the router keeps at HOW altitude in
  user-facing docs beyond what each doc's audience needs.
- Do not rewrite unrelated past CHANGELOG entries (e.g. an older "Claude-faithful"
  note describing a prior release) — only add the new `[Unreleased]` entry.

## Left open

- Exact prose and where within `user-guide.md` the new controls section lands
  (a new subsection near the existing dispatch narrative vs. the config section) —
  implementer's call for readability.
- Depth-of-detail in the architecture nested-background note.

## Testing

- No automated tests assert this prose. Verify by reading: no remaining "default
  5" / "depth cap 5" / "Claude parity" for the subagent knobs; `pi-integration.md`
  no longer contradicts `architecture.md`/`user-guide.md`; the CHANGELOG entry has
  the migration snippet.
- Run the full suite once to confirm no doc-linked test (e.g. any snapshot)
  regressed.

## Acceptance criteria

- [ ] `README.md`, `doc/user-guide.md`, `doc/architecture.md` (including the step-6 dispatch narrative at `~:233`), `doc/design/pi-integration.md` all state the main-session-only default and frame the knobs as PiCC extensions; no stale "default 5" / "Claude parity" / "the guard runs inside every subagent session"-as-normal remains. Verify by grepping for `depth cap`, `default 5`, `5 nesting`, `Claude parity` across README/doc/CHANGELOG/examples.
- [ ] `doc/user-guide.md` documents the three controls, depth semantics, scope/precedence, per-agent `tools:` restriction, a migration snippet, AND explicitly contrasts `enabled:false` (no delegation) with `maxDepth:1` (no nesting).
- [ ] `doc/design/pi-integration.md:87-88` no longer contradicts the other docs.
- [ ] `CHANGELOG.md` `[Unreleased]` has a `### Changed` entry with the migration snippet and the divergence note.
- [ ] `examples/full-surface/README.md` makes the depth-2 nesting an explicit opt-in.
- [ ] typecheck and full test suite green.

## Depends on
t01 (shipped default), t02 (registry wording to stay consistent with)

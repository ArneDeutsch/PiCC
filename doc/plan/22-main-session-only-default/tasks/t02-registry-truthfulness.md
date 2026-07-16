# t02: Capability-registry truthfulness + regenerate the matrix

## Goal

The capability registry no longer claims `subagentMaxDepth` defaults to 5 or that
the `subagents.*` knobs are Claude-settings parity. It states the new default
(main-session-only, depth 1), frames `subagents.enabled`/`maxDepth`/`concurrency`
(and the `disableSubagents` alias) as **PiCC extensions with no Claude-settings
equivalent**, and discloses the main-session-only-by-default divergence on the
dispatch-related entries. `doc/supported-features.md` is regenerated from the
registry (never hand-edited) and the registry↔doc drift test passes.

## Context & seams

- `src/registry/capability-registry.ts:134` — the central offender:
  `cap("setting", "setting.subagentMaxDepth", "full", "caps nested subagent recursion depth (default 5, Claude parity) (§4.3)")`.
  Rewrite the note: default 1 / main-session-only, drop "Claude parity", mark it a
  PiCC extension. Keep tier `full` (the knob works as implemented; this matches
  the precedent that `subagentsEnabled`/`subagentConcurrency` are `full`).
- `src/registry/capability-registry.ts:133` (`setting.subagentsEnabled`) and
  `:135` (`setting.subagentConcurrency`) — add PiCC-extension framing to their
  notes (they don't claim parity today, but should not read as parity either).
  `disableSubagents` has no own entry; if disclosed, fold it into the
  `subagentsEnabled` note.
- `src/registry/capability-registry.ts:50` (`tool.Agent`) and `:51` (`tool.Task`)
  — disclose that subagents do **not** recurse by default (depth cap 1); raise
  `subagents.maxDepth` to 2..5 to nest — a PiCC extension, not Claude behavior.
  Reuse the vocabulary already established at `:52` (`tool.Agent.fork`, which
  already says "MAIN-SESSION dispatch ONLY") as the model. **APPEND-ONLY:**
  `test/registry.test.ts:~199-222` pins ~16 `toContain` substrings across these two
  notes (`"LOUD failure"`, `"BACKGROUND-BY-DEFAULT"`, `"2.1.198"`, `"alias"`,
  `"PiCC UX hardening rather than verified parity"`, …). Append your disclosure
  sentence; do NOT reword the existing text, or you break those assertions. If you
  must reword, update the matching assertions too.
- `src/registry/capability-registry.ts:233` (`feature.background-agents`) — the
  live note reads (approximately): "…uses per-depth budgets (total ≤ maxDepth ×
  concurrency, deadlock-free), deliberately diverging from Claude's single global
  (~10) parallel-agent cap…". It presumes nesting happens by default. Add that
  nesting is **off by default** (depth 1) and `depth ≥ 2` only occurs when an
  operator raises `maxDepth`. **Preserve the exact asserted substrings**
  `"per-depth budgets"`, `"maxDepth × concurrency"`, and the FULL phrase
  `"Claude's single global (~10) parallel-agent cap"` — they are asserted at
  `test/registry.test.ts:~397-399` (NOT :347-349, which asserts the unrelated
  Notification-hook note). Update those assertions only if you deliberately reword.
- Registry idiom: the `note` prose is the only place parity-vs-extension is
  expressed — there is no structured field (see `src/types.ts:337-352`). Mirror
  the "— not parity" / "a deliberate PiCC choice" constructions already in the file.
- Regeneration: `npm run gen:capabilities` (= `node scripts/gen-capability-matrix.mjs`,
  `package.json:54`) writes `doc/supported-features.md` (generated banner at its
  top). The affected generated line is `doc/supported-features.md:110`. **Do not
  hand-edit** the generated table — run the script and commit its output.
- Drift guard: `test/registry.test.ts:532` regenerates and diffs the registry
  against the committed doc — it fails if the note changes without a regen.

## Writable surface

- `src/registry/capability-registry.ts`
- `doc/supported-features.md` (only via `npm run gen:capabilities`, not by hand)
- `test/registry.test.ts` (only if you must update the `feature.background-agents`
  substring assertions at `~:397-399`, or the `tool.Agent`/`tool.Task` substrings
  at `~:199-222` — prefer append-only edits that preserve every asserted substring)
- `doc/plan/22-main-session-only-default/log/t02.md`

## Approach constraints

- Notes must be **truthful and specific**: the default is 1; the knobs are PiCC
  extensions; nesting is opt-in via `subagents.maxDepth: 2..5`; Claude Code's
  5-level nesting is fixed and not configurable (so "matches Claude's ceiling" is
  not "Claude parity").
- Keep tier values unchanged (`full`).
- ASCII prose only; no shell metacharacters injected into notes.

## Left open

- Exact wording of each rewritten note (implementer authors it, matching the
  file's established idiom and the recommended wording in issue #52).
- Whether to also touch the `disableSubagents` disclosure (via the
  `subagentsEnabled` note) — do it if it reads cleanly.

## Testing

- `npm run gen:capabilities` then confirm `git diff` shows the expected
  `doc/supported-features.md` change and nothing stale.
- `test/registry.test.ts` (the drift test + the `feature.background-agents`
  substring assertions) green.
- typecheck + full suite green.

## Acceptance criteria

- [ ] `setting.subagentMaxDepth` note states default 1 / main-session-only and no longer says "default 5" or "Claude parity".
- [ ] `subagents.*` settings (and the alias) are framed as PiCC extensions, not Claude parity.
- [ ] `tool.Agent`/`tool.Task` (and `feature.background-agents`) disclose main-session-only-by-default / nesting-is-opt-in.
- [ ] `doc/supported-features.md` regenerated via `npm run gen:capabilities`; no hand edits.
- [ ] `test/registry.test.ts` drift + substring assertions pass.
- [ ] typecheck and full test suite green.

## Depends on
t01 (the shipped default must be 1 before the registry can truthfully state it)

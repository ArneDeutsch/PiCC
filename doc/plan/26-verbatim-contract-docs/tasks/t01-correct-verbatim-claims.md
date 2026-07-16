# t01: Correct the "verbatim final message" claims to the real contract

## Goal

Every doc/registry statement that PiCC returns a subagent's final message "verbatim (no wrapper)"
either (a) accurately qualifies it — verbatim for **non-resumable / one-shot** dispatches, verbatim
**plus a clearly-delimited in-band identity/resume trailer** for **resumable** dispatches, faithful
to Claude Code — or (b) is left alone where it is already accurate. The generated capability matrix
is regenerated from the registry. No behavior changes.

## Context & seams

The real behavior (verified during Phase 1 investigation):
- Foreground `Agent`/`Task` and background `TaskOutput` deliver the final message to the parent
  **model**; a **resumable** dispatch appends `\n\n---\n[agent <id> … — resumable via SendMessage]`
  (`src/util/subagent-transcripts.ts:agentTrailerLine/Frame`, applied in
  `src/runtime/subagents.ts:presentDispatchResult` and `src/runtime/background-tasks.ts`).
- **Non-resumable / one-shot** dispatches (Explore/Plan builtins; forks; `allowResumeTrailer:false`)
  return byte-exact verbatim — no trailer.
- The human **TUI** already strips the trailer and shows a resumable footer
  (`src/runtime/subagent-render.ts`), so the trailer is a **model-visible** concern only.
- This mirrors Claude Code, which likewise appends an in-band resume handle to resumable subagent
  results and none to its one-shot Explore/Plan agents (Phase 1 `claude-parity` finding).

Correction sites (the unqualified/false claims):
- `src/registry/capability-registry.ts` — `tool.Agent` note: `"… verbatim final message; …"` (the flat
  claim). Confirm `tool.Task` (inherits) and `tool.TaskOutput` (already says identity is "outside the
  verbatim body") — adjust only if still misleading.
- `doc/design/pi-integration.md:39` and `:89` — `"returned **verbatim**"` / `"final assistant message
  text **verbatim** (no wrapper)"`.
- `doc/architecture.md:113` — `"final message **verbatim** (skills parse locked YAML from it — a hard
  contract, plan §4.3)"` — the crux false claim (it asserts a *hard* locked-YAML-parse contract).
- `doc/architecture.md:227` and `:267` — `"returns the final message verbatim …"` / `"its verbatim
  final message is returned"`.
- `CONTRIBUTING.md:54` — `"verbatim subagent return"` in the load-bearing-mechanics list (light qualify
  or leave, whichever keeps the list readable).

Leave **historical CHANGELOG entries** untouched (they describe what shipped at the time); add a new
entry instead.

## Writable surface

- `src/registry/capability-registry.ts`
- `doc/supported-features.md` (regenerated only, via `npm run gen:capabilities` — never hand-edited)
- `doc/design/pi-integration.md`
- `doc/architecture.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md` (new entry only)
- `doc/plan/26-verbatim-contract-docs/**`

Everything else is read-only. No `src/` behavior code, no tests.

## Approach constraints

- **Truthful and Claude-grounded.** State the trailer as faithful to Claude Code; do not imply it is a
  PiCC wart or that it will be removed.
- Keep the wording tight and consistent across all sites (one contract, stated the same way).
- Preserve every existing `(§…)` cross-reference and the registry entry's other clauses verbatim.

## Left open

- Exact phrasing at each site (implementer/coordinator judgment), provided it is accurate and consistent.
- Whether `tool.TaskOutput` / `tool.Task` / `CONTRIBUTING.md` need a touch at all — change only if a
  reader would still be misled.

## Testing

- No new behavioral tests (docs-only; existing tests already encode the real behavior — e.g.
  `test/subagent-transcripts.test.ts` "RESUMABLE agent = verbatim message + delimited ID trailer" and
  "no trailer for one-shot builtins").
- Verify `npm run gen:capabilities` leaves the tree clean (regenerated matrix matches the registry) and
  that any registry-text test (`test/*capabilit*`, doctor/compat tests) still passes.
- Cross-platform: doc/registry edits are platform-neutral; ensure the generated matrix has no CRLF/LF
  churn beyond the intended lines.

## Acceptance criteria

- [ ] No doc/registry statement claims an unqualified "verbatim (no wrapper)" final message for
      resumable dispatches; each accurately describes the in-band identity/resume trailer.
- [ ] `doc/architecture.md:113`'s "hard contract" locked-YAML claim is corrected.
- [ ] `doc/supported-features.md` regenerated from the registry and consistent.
- [ ] A CHANGELOG entry records the documentation correction.
- [ ] typecheck and full test suite green.

## Depends on

–

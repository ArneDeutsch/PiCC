# F17: MultiEdit — a real atomic multi-edit tool

Ticket: ArneDeutsch/PiCC#14

## What

`MultiEdit` becomes a real, working tool instead of a degraded no-op. A model calls
it with a `file_path` and an array of edits, each `{ old_string, new_string,
replace_all? }`, and PiCC applies them **sequentially and atomically** to that one
file:

- Each edit operates on the result of the previous one (later edits see earlier
  edits' output).
- Exact-string matching with the same uniqueness requirement as `Edit`: an
  `old_string` that is absent — or ambiguous (multiple matches) without
  `replace_all` — is an error.
- If **any** edit fails, the whole operation is rejected and the file is left
  untouched (all-or-nothing: the file is written once, only after every edit
  matched successfully).
- `replace_all` is honored per edit, matching `Edit`'s semantics.

The tool is routed through the same permission / hook / path-scoped-injection
machinery as `Edit` (its touched path is `file_path`), so project permission rules,
hooks, and nested-CLAUDE.md injection see a `MultiEdit` call the way Claude Code
would.

**Non-goals:**
- No cross-file batch editing — a single `file_path` only, exactly as Claude Code's
  `MultiEdit`.
- No change to the existing `Edit` tool's behavior.
- No touching the other degraded stubs.

## Why

`MultiEdit` is the highest fidelity-per-line win among the remaining degraded tools.
Claude-authored agents and skills reach for `MultiEdit` heavily to make several
changes to one file in a single all-or-nothing step. Under PiCC today every such call
degrades to a notice, forcing the model to re-plan the work as N separate `Edit`
calls and losing the atomicity guarantee — exactly the kind of friction the harness
exists to remove.

## Acceptance

- A `MultiEdit` call applies multiple edits to one file, with later edits seeing the
  results of earlier ones.
- If any edit's `old_string` is missing or ambiguous (without `replace_all`), no
  write occurs and a clear error is returned — the file on disk is unchanged.
- `replace_all` on an edit replaces every occurrence, matching `Edit`.
- The capability registry reports `tool.MultiEdit` as `full` (no longer
  `degraded-noop`); the generated support matrix is regenerated and the drift guards
  are green.
- `MultiEdit` is honored by the permission engine and hooks the same way `Edit` is,
  keyed on `file_path`.
- The test suite covers sequential application, atomic failure, uniqueness failure,
  and `replace_all`; the full suite and typecheck stay green.

## Tasks

- t01 MultiEdit core matcher module + tool factory + unit tests (depends on: –)
- t02 Wire MultiEdit into the runtime, retire the stub, retier the registry (depends on: t01)
- t03 Docs — CHANGELOG + architecture note for the real MultiEdit (depends on: t02)

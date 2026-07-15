# t03: Docs — CHANGELOG + architecture note for the real MultiEdit

## Goal

The repo's human-authored docs reflect that MultiEdit graduated from a degraded
no-op to a real, atomic multi-edit tool: a CHANGELOG entry and a short
architecture note. (`doc/supported-features.md` is generated in t02 — not touched
here.)

## Context & seams

- **CHANGELOG.md** — add an entry under the current unreleased/next section, in the
  house style of existing entries (look at recent `f<NN>` / feature entries). One
  concise line: MultiEdit is now a real tool — atomic, sequential, exact-string
  multi-edit of one file with per-edit `replace_all`; note it is gated by the same
  `Edit(...)` permission family and flows through hooks/injection like Edit.
  **Watch the CHANGELOG serial-conflict process note** (see prior features'
  review.md): keep the edit minimal and localized to avoid collisions.
- **doc/architecture.md** — MultiEdit is a new *real* tool graduating out of the
  degraded list; add a brief mention where the tool surface / degraded tools are
  described (grep for `MultiEdit` and for the degraded-tools discussion). Include
  the **posture note** surfaced in Phase 4: MultiEdit moved from a no-op to a real
  writer, so a project relying on the old no-op as a safety net must lean on its
  `Edit`/`MultiEdit` deny rules — which do hold, since an `Edit(...)` rule expands
  to the whole file-edit family. Keep it short and factual.

## Writable surface

- `CHANGELOG.md`
- `doc/architecture.md`

## Approach constraints

- Match existing doc voice; no marketing. Don't restate the capability matrix
  (it's generated).
- "Atomic" here means **logical** all-or-nothing (a failed batch leaves the file
  untouched) — do **not** let the wording imply durable/crash-atomic writes (there is
  no temp-file+rename; this matches Pi's own Edit/Write atomicity level).

## Left open

- Exact placement/wording within each file.
- Whether the architecture mention warrants its own subsection or a sentence in an
  existing one (prefer the lighter option).

## Testing

Docs-only; no code paths. Confirm typecheck + full suite still green (no
regression) and that no doc-sync test (e.g. a CHANGELOG or link check, if present)
breaks.

## Acceptance criteria

- [ ] CHANGELOG entry describing the real MultiEdit, in house style.
- [ ] doc/architecture.md mentions MultiEdit as a real tool + the no-op→writer posture note.
- [ ] typecheck and full test suite green.

## Depends on

t02

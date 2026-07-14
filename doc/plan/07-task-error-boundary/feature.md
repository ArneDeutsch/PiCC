# F07: Defensive Background-Task Error Boundary

## What

Background-dispatch failures that settle through the successful dispatch-result path retain only bounded error text whose whitespace and Unicode `Cc` control-character runs are normalized. Those characters cannot flow through the stored error field into terminal-bound or model-facing failure output, and oversized errors are capped.

Existing failure behavior, messages, limits, and formatting remain unchanged apart from this defensive normalization. Redesigning background-task error handling, changing unrelated dispatch paths, and broader refactoring are explicitly out of scope.

## Why

Current callers already normalize external error text, but the background-task registry relies on every present and future caller remembering to do so. Enforcing the invariant at the storage boundary prevents a future caller from accidentally exposing unbounded or control-character-laden text in user-visible and model-facing output. This is a narrow defense-in-depth improvement rather than a correction for a currently exploitable path.

## Acceptance

- Every failed or aborted dispatch result retained by the background-task registry has bounded error text normalized for whitespace and Unicode `Cc` control characters.
- Existing background-task failure behavior remains otherwise unchanged.
- Focused regression coverage demonstrates that raw control characters, irregular whitespace, and oversized text cannot pass through the resolved-result boundary.
- The project typecheck and full test suite remain green.

## Tasks

1. t01 Enforce the Resolved-Error Storage Boundary (depends on: –)

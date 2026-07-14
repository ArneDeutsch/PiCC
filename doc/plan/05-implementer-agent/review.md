# F05 Review: Non-dispatching implementer & generalist agents

## Outcome

Shipped two non-dispatching project agents — `implementer` (write access: `Read, Grep, Glob, Bash,
Edit, Write`) and `generalist` (read-only: `Read, Grep, Glob, Bash, WebSearch, WebFetch`), both
omitting `Agent`/`Task`/`Skill` — and rewired the `implement-feature` skill to dispatch them
(implementer for build/fix, generalist for adversarial/broad review) plus `user-experience` for the
end-user walkthrough. The coordinator is now the sole holder of the dispatch tool. No `src` change;
the no-dispatch invariant is locked by a unit test on the shipped files. Delivered as planned, with
one deviation (below).

## Planning errors & spec gaps

- The t01 spec initially described `gateTools`/`allKnownToolNames` as if they were a free function /
  an exported helper; they're a `PermissionEngine` method and a private closure. Caught in plan
  review (coder/tester) and corrected before implementation — no cost beyond the review round.
- The plan didn't anticipate the bootstrapping wrinkle (creating `implementer` in t01, then wanting
  to dispatch it in t02 within the same session). Surfaced during implementation.

## Friction

- **Mid-session agent discovery:** an agent created earlier in a session isn't in the running Claude
  Code agent catalog (fixed at startup), so `implementer` could not be dogfooded on t02; t02 was
  implemented by the coordinator directly. Live-dispatch validation is deferred.
- `allKnownToolNames()` is a private closure (not exported), so the test inlines its own known-tools
  list — a small drift risk.
- Pre-existing: `isReadOnlyAgent` treats `Bash` as write-capable, so no Bash-carrying agent (all six
  specialists + `generalist`) ever gets the catalog "(read-only)" marker — the marker is effectively
  dead.

## Bugs discovered

- None new. This feature grew out of confirming that the original "subagents spawning subagents"
  observation was *faithful Claude Code behavior* (v2.1.172+), not a PiCC bug — so the fix is a
  workflow-level tool-scoping choice, not a harness change.

## Improvement opportunities

- Export `allKnownToolNames()` for test reuse and to prevent drift.
- Reconsider `isReadOnlyAgent` to base "read-only" on write/edit only (Bash alone ≠ writable in
  intent), which would make the "(read-only)" catalog marker meaningful and let `generalist`/the
  specialists carry it.
- A live-dispatch smoke test (fresh session or a PiCC e2e) that actually dispatches `implementer`
  and asserts it receives an empty agent catalog / cannot nest — complements the unit test.

## Proposed follow-ups

- **(small)** Export `allKnownToolNames`; fix the `isReadOnlyAgent` marker semantics.
- **(small)** Fresh-session / PiCC e2e that dispatches `implementer` and `generalist` end to end and
  verifies the no-nesting behavior at runtime, closing the deferred validation gap.

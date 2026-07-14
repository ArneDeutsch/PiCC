# Observations — F05

- 2026-07-14 — `isReadOnlyAgent` (`src/claude/agents.ts:442`) marks an agent "(read-only)" in the
  catalog only when its `tools` allowlist contains none of write/edit/**bash**. Since all six
  specialists (and now `generalist`) carry `Bash`, none of them ever get the marker — the "(read-only)"
  catalog marker is effectively dead for every current agent. Latent inconsistency / possible
  follow-up: either drop the marker or base "read-only" on write/edit only (Bash alone ≠ writable
  in intent). Not in scope for F05.
- 2026-07-14 — `allKnownToolNames()` (`src/index.ts:581`) is a private closure, not exported, so
  tests that need the known-tool set must inline their own copy (done in the F05 test). Minor
  friction; a follow-up could export it for reuse and to prevent drift.

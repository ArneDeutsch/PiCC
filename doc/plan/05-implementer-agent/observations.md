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
- 2026-07-14 — Process friction (bootstrapping): a project agent created mid-session (`implementer`,
  t01) is not dispatchable later in that same session — the running Claude Code agent catalog is
  fixed at startup. So this feature could not dogfood `implementer` on t02; it was implemented by the
  coordinator directly, and live-dispatch validation is deferred to a fresh session / PiCC run. Worth
  a follow-up note in the skill or a fresh-session step when a run introduces the very agents it then
  needs to dispatch.

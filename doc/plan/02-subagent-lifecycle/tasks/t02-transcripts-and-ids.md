# t02: Persisted subagent transcripts + agent IDs

## Goal
Every subagent dispatch leaves a JSONL transcript on disk, discoverable from the main
session, named by a stable agent ID — and the coordinator actually *receives* that ID
in a channel the model can read. Resume-after-dispose is verified feasible here (not
discovered impossible in t04).

## Context & seams
- Today subagent sessions are memory-only: `SessionManager.inMemory(cwd)` at
  `src/runtime/subagents.ts:515` (SDK loader `:121`), disposed in the finally
  (`:602-605`). Pi's `SessionManager.create(cwd, sessionDir?)` accepts a custom
  directory (`pi-coding-agent/dist/core/session-manager.d.ts:311-313`); `open` (`:320`)
  reopens; `NewSessionOptions.id` lets us control the session/file identity;
  `createAgentSession({ sessionManager })` restores existing session data
  (`sdk.js:73-92`). Extend the structural `PiSdk` interface (`subagents.ts:86-92`) and
  `loadRealSdk` (`:113-130`).
- **Location convention** (Claude parity analog `…/{sessionId}/subagents/agent-{id}.jsonl`):
  derive from the main session's transcript file
  (`sessionManagerRef.getSessionFile()`, `src/index.ts:169-175`). One file per
  subagent, filename contains the agent ID. Export one resolver function for the
  mapping — t04 consumes it. **Harden the resolver**: it validates the agent-ID
  argument against the minted format (reject path separators, `..`, drive/UNC
  prefixes, NTFS-reserved names) — defense in depth, since it is exported and IDs
  appear in filenames. If an agent *name* is embedded in filenames, sanitize it the
  same way (house style: worktree flattening, `subagents.ts:411`).
- **Agent ID contract (shared with t01/t04/t05/t06):** opaque, **unique per agent and
  stable across resumes** (a resume reuses the ID and appends to the same transcript —
  t04). `DispatchResult` gains `agentId: string` and `transcriptPath?: string`;
  `BackgroundTaskRecord` (`background-tasks.ts:25-38`) and `BackgroundResultLike`
  mirror them. Record resumability: built-in one-shot agents (Explore, Plan) are
  non-resumable — the flag lives with the ID so t04 can refuse.
- **Model-visible delivery (plan-review MUST-FIX):** Pi's `AgentToolResult.details` is
  logs/UI-only — the model never sees it (`pi-agent-core/dist/types.d.ts:306-310`).
  So: foreground, for resumable agents, the tool result **content** = verbatim
  `finalMessage` + a clearly delimited trailer line carrying the agent ID (e.g.
  `[agent <id> completed — resumable via SendMessage]`); the trailer sits outside the
  verbatim contract the way t01's cut-off note does. Background: the start message
  (`subagents.ts:706`) already reaches the model — include the agent ID there, and in
  TaskOutput text and t05's settlement notice. `details` additionally carries the
  structured copy (`agentId`, `transcriptPath`).
- Subagent-scoped hooks currently receive the *parent's* transcript path
  (`makeScopedHookRunner`, `src/index.ts:605-615`) and are constructed **before** the
  subagent session exists (`subagents.ts:303-318` vs `:521`) — a late-bound getter is
  needed to hand hooks the subagent's own transcript path. While here, add `agent_id`
  (alongside the existing agent type) to SubagentStart/SubagentStop hook payloads —
  Claude Code hook input carries both (`doc/research/02-claude-code-internals.md:336-342`).
- **Resume-feasibility verification (moved here from t04):** an offline test proving
  dispatch → dispose → reopen (via `SessionManager.open` or
  `createAgentSession({sessionManager})`) yields the prior messages intact — on
  Windows and Linux (flush/open-handle risk is exactly where NTFS bites). If this
  fails, escalate to the coordinator *now*, before t03–t06 are built on it.
- Cleanup: v1 may skip age-based cleanup (worktrees' `reapOrphans` pattern exists if
  wanted) but must note it in the log — t07 then marks `setting.cleanupPeriodDays`
  accordingly. Transcript privacy: same exposure class as Pi's/Claude's own transcripts
  under the user home — note the parity argument in the log.
- Fallback discipline ("degrade, never crash"): if the main session file is unknown
  (print-mode edge, tests), fall back to in-memory + a diagnostic — dispatch must
  succeed; such agents are recorded non-resumable (t04 refuses them cleanly).
- Pin new Pi surfaces (`SessionManager.create(cwd, sessionDir)`, `open`,
  `NewSessionOptions.id`) in `test/pi-contract.test.ts`.

## Writable surface
`src/runtime/subagents.ts`, `src/runtime/background-tasks.ts` (ID/trailer surfaces),
`src/index.ts` (wiring), `src/util/` (only if a path helper is genuinely reusable),
`test/runtime-core.test.ts`, `test/agents.test.ts`, `test/background-tasks.test.ts`,
`test/pi-contract.test.ts`, `test/helpers/` (fake-builder extension), new
`test/subagent-transcripts.test.ts` if cleaner,
`doc/plan/02-subagent-lifecycle/log/t02.md`.

## Approach constraints
- Persistence must not alter t01's dispatch semantics — it is a side channel.
- Windows + Linux path safety; flattened names, nothing invalid on NTFS.
- The ID trailer must be visually unmistakable as harness metadata, not agent prose.
  It is advisory, not authenticated — a subagent could emit a forged look-alike line
  in its own output; the dispatch registry (t04) is the source of truth for what an ID
  reaches, which bounds the impact to misdirected (legitimate) delivery. Note this in
  the log; same in-band property exists in Claude Code.

## Left open
- Exact directory/filename scheme (within the stated constraints).
- Agent ID format (uuid vs short hex) — pick one, document in the log.
- Trailer wording.

## Testing
Unit/offline-integration (real SessionManager, temp dir): transcript exists with the
run's messages; resolver mapping + hardening (rejects `..`, separators, absolute
paths, reserved names; accepts minted IDs) — run on both OSes, plus a resolver unit
test against a Windows-shaped main-session path (drive letter); ID trailer present in
foreground content for resumable agents, absent for Explore/Plan; background start
message + TaskOutput carry the ID; dispose→reopen proves messages intact (both
platforms); fallback (no main session file) → in-memory + diagnostic + non-resumable;
scoped hooks receive the subagent's transcript path and `agent_id` in payloads.

## Acceptance criteria
- [ ] After any dispatch a transcript exists, discoverable via the hardened resolver.
- [ ] The coordinator model can read the agent ID from the tool result / start message.
- [ ] Dispose→reopen round-trip proven on both platforms (or escalated).
- [ ] Subagent hooks get their own transcript path + agent_id.
- [ ] New Pi surfaces pinned in pi-contract tests.
- [ ] typecheck and full test suite green (flake policy per feature.md).

## Depends on
t01

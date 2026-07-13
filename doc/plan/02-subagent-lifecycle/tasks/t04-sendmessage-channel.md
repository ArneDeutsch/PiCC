# t04: SendMessage channel — resume and steer subagents

## Goal
The coordinator can send a follow-up message to a finished subagent — which resumes
**in the background under the same ID** with its full prior context (Claude Code
2.1.x semantics) — and can steer a still-running background subagent. Addressing is by
agent ID or name. Resume never weakens any security property of the original dispatch.

## Context & seams
- Claude Code semantics to match (verified against code.claude.com/docs/en/sub-agents):
  SendMessage(`to` = ID or name) resumes a stopped subagent **as a background run under
  the same ID, without a new Agent invocation** — the tool returns an acknowledgment
  (agent ID, "resumed in background"), and the run's outcome arrives like any
  settlement (t05 notice; TaskOutput also works). Resume flips the agent's
  registry/task state back to *running* (2.1.205 — stale settled status is a fixed
  Claude bug; add a test). A running subagent treats parent messages as mid-task
  course corrections → acknowledgment of delivery. Name-integrity (2.1.199): if a
  *name* now resolves to a different live agent than it originally did, refuse and say
  who the name reaches now; IDs always disambiguate; the check is scoped to the
  current session. One-shot built-ins (Explore, Plan) refuse resume. Resumed agents
  keep their original nesting depth (`subagents.ts:281-289`). Resume also resets the
  record's settled-notice dedup state (t05): each settlement of the same agent ID —
  original or resumed — emits exactly one notice.
- **SECURITY (plan-review MUST-FIX #1): resume is a full re-dispatch.** Every
  enforcement layer exists only because `dispatch()` constructs it per session — tool
  gating (`subagents.ts:445-451`), guard extension (`:457-466`), scoped hooks
  (`:300-346`), system-prompt override + skill/agent lockdown (`:476-484`), maxTurns
  (`:470-475`), worktree cwd (`:407-443`). A resume MUST go through the same
  construction path — same gated toolset, guard, hooks, prompt, maxTurns, depth —
  differing only in that the session is seeded/reopened from the persisted transcript
  (t02's dispose→reopen round-trip is already proven). The dispatch registry must
  therefore retain (or re-derive from the agent definition) everything `dispatch()`
  needs: agent name/definition, cwd/worktreePath, depth, and the transcript path.
- **SECURITY (plan-review MUST-FIX #2): `to` resolves registry-only.** Look the
  address up exclusively in the in-memory dispatch registry (the `unknownIdError`
  pattern, `background-tasks.ts:130-135`); the transcript path comes from the registry
  record — **never** from string-assembly over the model-supplied `to` value. Unknown
  address → clear error.
- **Unreachable agents refuse cleanly**: original cwd/worktree no longer exists (the
  worktree may have been merged/removed) → refuse naming the missing path; agents that
  ran on the in-memory fallback (no transcript, t02) → refuse as non-resumable;
  cross-restart resume (registry is process-lifetime) is out of scope — t07 records
  the SendMessage registry entry as `partial` naming this.
- Steering: live sessions support `steer()`/`followUp()`
  (`pi-coding-agent/dist/core/agent-session.d.ts:359-367`). De-facto this reaches only
  **background** dispatches — a foreground Agent call blocks the parent's turn, so the
  coordinator cannot SendMessage while one runs. State this in docs/acceptance; it is
  not a defect. Retain live session handles in the registry while running; on
  settlement keep name/ID/state/transcript-path (+ what resume needs), not the session.
- New tool `SendMessage` registered alongside Agent/TaskOutput (`src/index.ts:687-700`).
  **Not** added to subagent toolsets (`customToolsFor`, `src/index.ts:567-595`) —
  parent-initiated only; one line of constraint prevents a future "inherit all tools"
  change from granting subagents a channel to siblings.
- Registry records: keyed by agent ID; name → ID index with original-binding tracking
  for the integrity refusal. The existing background map's keep-forever policy applies.
- Pin `steer`/`followUp` in `test/pi-contract.test.ts`.

## Writable surface
`src/runtime/subagents.ts`, `src/runtime/background-tasks.ts`, `src/index.ts`
(registration/wiring), new `src/runtime/subagent-registry.ts` if the registry deserves
its own module, `test/runtime-core.test.ts`, `test/agents.test.ts`,
`test/background-tasks.test.ts`, `test/pi-contract.test.ts`, `test/helpers/`, new
`test/sendmessage.test.ts`, `doc/plan/02-subagent-lifecycle/log/t04.md`.

## Approach constraints
- Resume reuses the same agent ID and appends to the same transcript.
- No subagent→subagent or subagent→parent messaging.
- Message content delivered to the resumed/steered agent verbatim as user-role task
  direction; agent messages never count as permission approval (existing engine
  enforces — do not add a parallel mechanism, do not remove one).

## Left open
- Tool parameter names/shape (stay close to Claude's `to` + message; check
  doc/research/02-claude-code-internals.md before inventing).
- Steer delivery mechanics (`steer` vs `followUp` vs queued prompt) — pick what Pi
  makes reliable; document in the log.
- Ack wording.

## Testing
Unit (fakes): registry lifecycle incl. resume→running transition; address by ID and
name; name-collision refusal naming the current holder; one-shot refusal; unknown
address; non-resumable (in-memory fallback) refusal; dead-cwd refusal. Security
regressions: resumed dispatch carries gated tools/guard/hooks/maxTurns/depth identical
to the original (assert via the fake construction hooks); `to` containing `..`/path
separators/absolute paths never touches the filesystem (registry miss → error).
Offline-integration (real SessionManager, temp dir): dispatch → settle → SendMessage →
background run under same ID with prior context visible, transcript appended; ack
returned immediately; **resume resets the record's settled-notice state, so the
resumed run's own settlement emits a fresh t05 notice — assert the second notice fires
(a swallowed re-settlement would recreate the silent-outcome bug class)**. Steer path
delivers into a running fake session.

## Acceptance criteria
- [ ] Finished subagent: SendMessage returns an ack and resumes it in the background, same ID, full context, transcript appended, state back to running.
- [ ] Running background subagent: message delivered as course correction; ack returned.
- [ ] Name ambiguity/one-shot/unknown/unreachable all refuse with precise messages; ID always works.
- [ ] Resume provably re-applies the full enforcement stack; `to` never reaches the filesystem.
- [ ] typecheck and full test suite green (flake policy per feature.md).

## Depends on
t01, t02

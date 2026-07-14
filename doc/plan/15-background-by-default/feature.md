# F15: Background-by-default subagent dispatch

## What

Subagent dispatch (`Agent` / `Task`) runs **in the background by default**, matching
Claude Code 2.1.198+. A dispatch that omits `run_in_background` returns a task id
immediately and runs concurrently with any other dispatch issued in the same turn;
the orchestrator collects the result via `TaskOutput` (or is pushed a settlement
notice when it lands). A dispatch that needs its result synchronously in the same
turn opts back into foreground by passing `run_in_background: false`.

Observable behaviour:

- **Implicit fan-out parallelizes.** Multiple dispatches issued in one turn with no
  explicit `run_in_background` all start in the background and run concurrently
  (subject to the existing concurrency cap), instead of executing serially as they
  do today.
- **`run_in_background: false` is honoured** — that dispatch blocks the turn and
  returns its result inline, exactly as an omitted flag does today. This is how the
  orchestrator selects foreground when it consumes the result immediately; there is
  no automatic detection.
- **`background: true` agent frontmatter still forces background**, and
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` still forces every `Agent`/`Task` dispatch to
  foreground (the serial-again escape hatch).
- Settlement notices, `/usage`, and `TaskOutput` continue to work for the now-default
  background path — nothing that observes a backgrounded dispatch regresses.
- **Nested fan-out stays bounded.** A sub-coordinator (or `background: true`
  grandchild) at depth ≥ 2 that dispatches many agents in one turn does not spawn an
  unbounded number of concurrent sessions; concurrency stays capped without
  deadlocking a parent that is blocked collecting a child's result.
- **The orchestrator is told how to collect.** The always-on harness-conventions
  guidance and the tool descriptions state that a dispatch returns a task id by
  default and its result is collected with `TaskOutput` (or `run_in_background: false`
  for a synchronous inline result) — so a Claude-authored fan-out does not dispatch
  and then finalize without collecting.
- The tool descriptions and the capability registry tell the truth about the new
  default: `tool.Agent` / `tool.Task` background dispatch moves off the documented
  "partial / default-foreground" divergence.

### Non-goals

- **No new PiCC-specific background on/off knob.** The existing
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` env is the only switch for `Agent`/`Task`
  dispatch routing. (Pre-existing, out of scope: `SendMessage` resume is inherently
  asynchronous and is not governed by this env — documented as an explicit exception,
  not changed here.)
- **No rework of the settlement / notification mechanism itself** (F02 t05) — this
  feature composes with it, it does not change it.
- **Does not touch** the foreground abort-badge `outcome` path (F02 follow-up 2),
  `context:fork` failure handling (follow-up 3), or subagent `TaskOutput`/`TaskStop`
  scoping (follow-up 4). Those remain separate.
- Not a change to what a subagent *is* or how it is resolved — only to the default
  foreground/background routing of a dispatch.

## Why

PiCC's core promise is that projects authored for Claude Code run **unchanged**.
Claude-authored multi-agent corpora rely on *implicit* concurrency: dispatch N
reviewers in one turn, let them run in parallel, collect the results — the heart of
the multi-agent fan-out pattern (picc-plan.md §4.3) and exactly the DemonMatrix
review pattern. Because PiCC defaults a dispatch to foreground, that implicit
fan-out silently **serializes**: it still produces answers, so it *looks* like it
ran unchanged, but it runs one-at-a-time. Silent misbehaviour of a project that
appears to run unchanged is precisely the failure the completeness rule (§2.2)
forbids.

F02's review ranked this follow-up #1 — the "highest-value parity gap" and arguably
the single most consequential subagent-parity divergence, verified against the
Claude Code sub-agents documentation. Closing it makes implicit-concurrency
fan-outs behave as their Claude authors intended, without any change to the target
project.

## Acceptance

- Issuing two or more dispatches in a single turn, none passing `run_in_background`,
  results in them running **concurrently** (each returns a task id immediately),
  not one-after-another.
- A dispatch passing `run_in_background: false` blocks the turn and returns its
  result inline.
- A `background: true` frontmatter agent runs in the background regardless of the
  tool call's flag; with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` set, every dispatch
  runs in the foreground.
- After a backgrounded default dispatch settles, its settlement notice, `/usage`
  entry, and `TaskOutput` result are all present and correct.
- A nested (depth ≥ 2) background fan-out of more agents than the configured
  concurrency runs at most that many concurrently — the excess queue and still
  complete — and a parent blocked collecting a child does not deadlock.
- The standing harness-conventions guidance instructs coordinators to collect
  dispatch results via `TaskOutput` (background default) or `run_in_background: false`
  (synchronous), rather than describing the return value as the final message.
- `doc/supported-features.md` / the capability registry no longer describe
  `tool.Agent` / `tool.Task` background dispatch as default-foreground; the
  generated matrix is in sync (`npm run gen:capabilities` produces no diff).
- Typecheck and the full test suite are green.

## Tasks

- **t01 — Core flip: background-by-default routing, intent-split degrade note, tool
  descriptions + routing tests** (depends on: –)
- **t02 — Bound nested (depth ≥ 2) background fan-out so it stays concurrency-capped**
  (depends on: t01)
- **t03 — Registry + docs truthfulness for the new default; regenerate the capability
  matrix** (depends on: t01, t02)

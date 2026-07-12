# t01: Loud failure semantics + abort wiring

## Goal
A subagent run that ends on a terminal API error is classified and reported as a
failure with the error named — foreground and background — and a deliberately stopped
run reports as aborted. Empty-success on failure becomes impossible, and the fix is
proven above the fake layer (offline-integration + e2e against the mock server). Esc
in the parent aborts a running foreground dispatch.

## Context & seams
- Root cause (verified 2026-07-12): Pi's `session.prompt()` resolves normally on
  terminal LLM failure; the failure lives on the *last assistant message* as
  `stopReason: "error"` with the text in `errorMessage` and empty text content
  (pi-agent-core `agent-loop.js:107-110`; `AssistantMessage` in
  `pi-ai/dist/types.d.ts:276-289`). PiCC's `lastAssistantText`
  (`src/runtime/subagents.ts:623-627`) reads only text content → `""`; the
  retry-on-empty (`subagents.ts:551-557`) then repeats the failure; dispatch returns
  `ok: true, finalMessage: ""` (`subagents.ts:584`). Nothing reads `stopReason`.

### Shared result contract (t02–t06 mirror this EXACTLY)
`DispatchResult` (`subagents.ts:103-111`) gains
`outcome: "completed" | "failed" | "aborted"`. The **existing** `error?: string`
field is the single error channel — no new `errorMessage` field; `error` is present
iff `outcome !== "completed"` (for aborted: a short abort reason). `ok` keeps meaning
`outcome === "completed"`. `BackgroundResultLike`
(`src/runtime/background-tasks.ts:16-23`) is a deliberate structural mirror — extend
identically. Every dispatch exit path sets an outcome:
- post-`prompt()` by last message `stopReason`: `"error"` → **failed** (error =
  Pi's `errorMessage`, length-capped ~500 chars, never enriched with request/header/env
  detail — it flows into model-visible text and t05 notices); `"aborted"` → **aborted**;
  a token-limit stop (if Pi's vocabulary has one, e.g. `"length"`) → **completed** but
  with a truncation note appended via the cut-off-note mechanism and a diagnostic —
  never a silent clean-looking truncation; anything else → **completed**.
- pre-`prompt()` exits: unknown agent type (`:270-279`), depth cap (`:281-289`), and
  SubagentStart hook block (`:395-403`) → **failed**; the stopped-before-start paths
  (`:290-298`, `:371-387`, `:424-440`) → **aborted**; the catch-all (`:585-593`,
  covers `createAgentSession` itself throwing — the "API dead before the session
  exists" case) → **failed**.
- Background status mapping (`background-tasks.ts:60-86`): completed → `"completed"`,
  failed → `"failed"`, aborted → `"stopped"` — a failed run must never land
  `"completed"`; TaskOutput surfaces the error and partial output for failed tasks.
- Retry-on-empty: skip entirely when `stopReason` is `"error"`/`"aborted"` (today it
  masks failures and doubles latency); keep it only for genuinely successful empty stops.
- **Partial output**: on failure, `finalMessage` carries the concatenated text of
  earlier assistant turns when any exists, else `""`. Known bound (accept + document +
  test): compaction inside `prompt()` may have rewritten `session.messages`, so partial
  output is best-effort post-compaction content.
- **Foreground tool mapping** (Claude Code 2.1.200 semantics; execute at
  `subagents.ts:682-733`): completed → success result with verbatim `finalMessage`
  (unchanged). Failed with partial output → *success* result: the partial output
  followed by a clearly separated cut-off note naming the API error. Failed with no
  output → throw `Agent terminated early due to an API error: <error>` (existing
  `ok:false → throw → isError` channel, `subagents.ts:713-715`). Aborted → throw with
  distinct wording naming the abort. Never mix error text into the verbatim channel
  except as the specified partial+note shape; diagnostics stay in `details`
  (`subagents.ts:720-723`).
- **Abort wiring**: the Agent tool's `execute` ignores its `signal` parameter
  (`subagents.ts:682`; Pi signature `execute(toolCallId, params, signal, onUpdate,
  ctx)`, `pi-coding-agent/dist/core/extensions/types.d.ts:361`). The runtime accepts
  `abortSignal` (`subagents.ts:243-244`) — wire the foreground path so parent Esc
  aborts the dispatch (Pi's `abort()` also cancels retry waits,
  `agent-session.js:1147-1149` — cover with a unit test). Honest boundary: tests prove
  signal→abort; Pi's interactive Esc→signal wiring itself is Pi behavior we pin, not
  re-test.
- Extend the structural `PiSession` interface (`subagents.ts:94-101`) minimally with
  optional-method tolerance. **Extract one shared fake-SDK builder into
  `test/helpers/`** (fakes are currently copy-pasted at `test/runtime-core.test.ts:390,
  589`, `test/background-tasks.test.ts:32, 320`, `test/builtin-agents.test.ts:23`) —
  t03/t06 will extend it rather than forking more copies. If `outcome` is required on
  the result types (it is), the result literals in existing tests must be updated too.
- **Pin new Pi surfaces in `test/pi-contract.test.ts`** (it exists to fail loudly on Pi
  churn, `doc/testing.md:42`): `stopReason`/`errorMessage` on AssistantMessage, the
  5-arg execute signature.

## Writable surface
`src/runtime/subagents.ts`, `src/runtime/background-tasks.ts`, `src/types.ts` (only if
shared types must move), `test/runtime-core.test.ts`, `test/agents.test.ts`,
`test/background-tasks.test.ts`, `test/builtin-agents.test.ts`,
`test/pi-contract.test.ts`, `test/helpers/` (shared fake builder; mock-openai error
capability), `test/e2e-live-pi.test.ts`, new `test/subagent-outcomes.test.ts` if cleaner,
`doc/plan/02-subagent-lifecycle/log/t01.md`.

## Approach constraints
- Rely on Pi's built-in retry (defaults maxRetries 3) — add no additional retry logic.
- Extend the existing error channel; do not invent a second one.

## Left open
- Exact wording of the cut-off/truncation notes and abort message (must name the cause).
- Partial-output join format (blank lines vs turn markers).
- How `PiSession` exposes messages — match the real session, keep fakes simple.
- Mock-openai error-turn API shape (must be *sticky* per session: Pi retries 3×, and
  the current script-exhaustion fallback `{text:"done"}` at `mock-openai.ts:169` would
  otherwise convert a retried failure into a success).

## Testing
- Unit (shared fake builder): all outcome mappings incl. every pre-prompt path;
  stopReason "error" with/without prior text turns; "aborted"; token-limit stop →
  truncation note; genuine empty success still retries once; error stops don't retry;
  signal fired mid-dispatch → aborted (incl. during a simulated retry wait).
- Foreground tool mapping: completed / failed+partial / failed+empty→isError / aborted.
- Background **through dispatch, not registry literals**: fake session ending
  `stopReason:"error"` → Agent tool with `run_in_background` → wait → TaskOutput shows
  `failed` + error; regression: rate-limit shape can never yield `"completed"`+empty.
- **e2e (`test/e2e-live-pi.test.ts`)**: parent scripted to dispatch a subagent; mock
  serves the child session sticky HTTP 429/500 (new mock-openai capability); assert the
  parent's follow-up request contains a tool result naming the API error — never an
  empty success. Mirrors the existing parent/child `when`-predicate scenarios
  (`e2e-live-pi.test.ts:458-482`).

## Acceptance criteria
- [ ] Every dispatch exit path yields a classified outcome; a session ending `stopReason:"error"` reports failed with the error named, at both layers, proven at unit + dispatch + e2e level.
- [ ] Partial output survives with a cut-off note; empty-failure throws the documented error; token-limit truncation is marked.
- [ ] Aborted ≠ failed in result and background status (`"stopped"`); parent Esc aborts a foreground dispatch.
- [ ] Retry-on-empty no longer fires for error/abort stops.
- [ ] New Pi surfaces pinned in pi-contract tests; shared fake builder extracted.
- [ ] typecheck and full test suite green (flake policy per feature.md).

## Depends on
–

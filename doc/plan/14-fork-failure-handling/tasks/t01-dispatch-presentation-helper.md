# t01: Extract the shared dispatch-outcome presentation helper; refactor the Agent tool onto it

## Goal

A single **exported, pure** function maps a `DispatchResult` to its user-facing
presentation, reproducing the `Agent` tool's F02 mapping exactly. The `Agent` tool
consumes it with **no observable behaviour change** (its existing tests stay green). The
cut-off frame helper (`appendCutOffNote`) is reusable so the fork path (t02) produces a
byte-identical frame. This task is a behaviour-preserving refactor plus new unit coverage;
the suite stays green.

## Context & seams

The mapping lives inline today in `createAgentToolDefinition`'s foreground path,
`src/runtime/subagents.ts:1579-1665`, branching on `DispatchResult.outcome`
(`"completed" | "failed" | "aborted"`; the interface is `subagents.ts:273-316`). It uses
one framing helper, module-private `appendCutOffNote(text, note)` (~`:1401`, produces
`` `${text.replace(/\s+$/,"")}\n\n---\n[subagent cut off] ${note}` ``). Trailers come from
`agentTrailerLine` / `agentTrailerFrame`, already exported from
`src/util/subagent-transcripts.ts:123,137`, and are gated on `result.resumable`.

**Important — `capErrorText` is NOT part of this mapping.** `capErrorText` (~`:1389`) is
applied at *dispatch-construction time* (`subagents.ts:702,1024,1159,1302`), so
`DispatchResult.error` is already single-line / control-char-free before any presentation
code runs. The Agent-tool mapping passes `result.error` **verbatim**. So this task neither
exports nor calls `capErrorText`, and the helper must **not** re-cap (that would double-cap).
The `[subagent cut off]`-frame anti-forgery guarantee is inherited from construction-time
capping; the fork path (t02) consumes the same pre-capped `DispatchResult`.

**The exact four branches to reproduce** (verify against the live code — the code is the
source of truth):

- **completed** → content text = `finalMessage`; if `resumable`, append the trailer
  (`agentTrailerLine` when truncated, else `agentTrailerFrame({completed:true})`).
  `cutOff = result.truncated === true` (the Agent tool sets exactly this,
  `subagents.ts:1649` — do **not** hard-code `false`).
- **failed WITH partial** (`outcome==="failed" && finalMessage.trim()`) → content text =
  `appendCutOffNote(finalMessage, error ?? "<default cut-off note>")`; if `resumable`,
  append `agentTrailerLine({completed:false})`. This is a **success-shaped** result
  carrying `cutOff = true` (consumer sets `details.cutOff/outcome`).
- **failed WITHOUT partial** (`!ok`, no partial) → **surface as failure**: message =
  `error ?? "subagent failed"`, with `agentTrailerFrame({completed:false})` appended only
  when `outcome==="failed" && resumable`.
- **aborted** → surface as failure: message = the runtime's abort wording
  (`error`, e.g. `` `Subagent "<name>" was aborted before completing its task.` ``), **bare
  — no trailer** (matches current: the trailer ternary requires `outcome==="failed"`).
  Any partial `finalMessage` on an aborted run is intentionally **discarded** — this
  matches the Agent tool; do not "improve" it (that would diverge from parity and is out of
  scope).

**The contract t02 depends on — define it with these exact names** (t02's spec references
them verbatim, so they must match):

```ts
export type DispatchPresentation =
  | { kind: "result"; text: string; cutOff: boolean }   // return as content / fold into text
  | { kind: "failure"; message: string };                // throw, or fold into text

export function presentDispatchResult(
  result: DispatchResult,
  opts?: { allowResumeTrailer?: boolean },   // default true; t02 passes false for forks
): DispatchPresentation;
```

- `allowResumeTrailer === false` suppresses every trailer regardless of `result.resumable`
  (forks are non-resumable, but the flag makes the fork call sites explicit and future-proof).
- **Total & defensive.** The helper must return a `DispatchPresentation` for *every*
  `DispatchResult` and never throw — read `finalMessage` as `(result.finalMessage ?? "")`
  before `.trim()`. (t02's input-hook consumer relies on this: if the helper threw, the
  handler's `catch` would leak the raw unexpanded `/skill` to the model.)
- The `Agent` tool calls it with the default (trailers gated on `result.resumable`), then:
  `kind:"result"` → return content `[{type:"text", text}]` with `details` (`outcome`,
  `cutOff`, plus its existing identity/usage fields); `kind:"failure"` →
  `throw new Error(message)`. The `details` fields (identity/usage/`outcome`/`error`) are the
  consumer's job, reconstructed from `result` — the helper owns only the **text** and the
  throw/return decision.

## Writable surface

- `src/runtime/subagents.ts` (extract + export the helper; refactor the Agent-tool
  consumer onto it; export `appendCutOffNote` — or move it to
  `src/util/subagent-transcripts.ts`, implementer's choice).
- `src/util/subagent-transcripts.ts` (only if you relocate `appendCutOffNote` there).
- `test/subagent-outcomes.test.ts` (add helper unit tests) or a new `test/*.test.ts`.
- `test/helpers/*` only if a fixture genuinely needs it.

Everything else is read-only. Do **not** touch `src/index.ts` (that's t02), and do **not**
touch the deliberately-duplicated `capErrorText` mirror in `src/runtime/background-tasks.ts`
(~`:416-423`, out of scope — its comment explains why it must stay separate).

## Approach constraints

- **Behaviour-preserving.** The `Agent` tool's observable output — content text, throw
  wording, `details.cutOff`/`details.outcome`, trailer bytes — must be identical before and
  after. The existing Agent-tool tests (`test/subagent-outcomes.test.ts:333-398`) and the
  trailer-variant tests (`test/subagent-transcripts.test.ts`) are the proof; they must pass
  unchanged. If any existing assertion would have to change, stop and report — that means
  the refactor altered behaviour.
- **One source of truth for the *presentation path*.** After this task there must be exactly
  one implementation of the cut-off-note framing (`appendCutOffNote`) and the
  outcome→presentation decision. This scope is the foreground Agent/fork presentation path
  only — it explicitly does **not** include the `background-tasks.ts` `capErrorText` mirror.
- Keep the helper **pure** (no I/O, no dispatch, no clock) so t02 can unit-test it with
  hand-built `DispatchResult` values on both OSes.

## Left open

- Whether the helper + `appendCutOffNote` stay exported in `subagents.ts` or move to
  `subagent-transcripts.ts`. Pick the option with the least churn and no import cycle (a
  type-only back-edge for `DispatchResult` is fine).
- Exact test file/name and how the `DispatchResult` fixtures are built.
- The exact default cut-off note string (reuse the current one).

## Testing

Unit tests on `presentDispatchResult`, covering the full matrix:
`{completed, completed-truncated, failed-with-partial, failed-no-output, aborted}` ×
`{resumable, non-resumable}` × `{allowResumeTrailer true/false}` where meaningful. Build
`DispatchResult.error` fixtures as **already-capped single-line strings** (mirroring real
`dispatch()` output — the helper does not cap). Assert: partial survives verbatim at the
start of the cut-off text; the cut-off frame is exactly `\n\n---\n[subagent cut off] ...`
(assert `\n` literals — never `os.EOL`); a `failure` message names the cause and (given
capped fixtures) carries no `[\r\n]`; aborted yields `kind:"failure"` with the abort wording
and no trailer; completed sets `cutOff` from `truncated`; non-resumable /
`allowResumeTrailer:false` yields no trailer bytes. Existing Agent-tool mapping tests must
remain green as the regression proof of the refactor.

## Acceptance criteria

- [ ] `presentDispatchResult` and `DispatchPresentation` are exported with the names above,
      total (never throw), and reproduce all four branches incl. `cutOff = truncated` on
      completed.
- [ ] `appendCutOffNote` is reachable from other modules (exported or relocated); exactly
      one implementation of the cut-off framing remains on the presentation path.
- [ ] The `Agent` tool consumes the helper; its existing tests pass **unchanged**.
- [ ] New unit tests cover the full outcome × resumable × trailer matrix with capped-error
      fixtures.
- [ ] typecheck and full test suite green.

## Depends on

–

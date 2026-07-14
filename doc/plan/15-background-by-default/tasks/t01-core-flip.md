# t01: Core flip — background-by-default routing, intent-split note, coordinator guidance

## Goal

Subagent dispatch (`Agent` / `Task`) runs in the background by default. A dispatch
that omits `run_in_background` backgrounds (returns a task id immediately); passing
`run_in_background: false` runs it synchronously in the foreground and returns the
result inline; a `background: true` frontmatter agent backgrounds regardless of the
flag; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` forces every dispatch to the foreground.
The "background requested but ran foreground" degrade note fires only when background
was *explicitly* requested, never on a defaulted dispatch. Every model-facing string
that describes dispatch — the tool + param descriptions, the standing
harness-conventions guidance, and the collection-side (`TaskOutput`) strings — tells
the model the new default and how to collect a result, so a Claude-authored fan-out
does not dispatch and then finalize without collecting. The full suite is green with
the inverted-default tests updated.

## Context & seams

Routing lives in `src/runtime/subagents.ts`, in `createAgentToolDefinition`'s
`execute` (~1434-1665). Verify line numbers against the current file.

- **Routing predicate (~1501-1502)** — today:
  ```ts
  const wantsBackground =
    params.run_in_background === true || runtime.isBackgroundAgent(subagentType);
  ```
  Flip to background-by-default while keeping frontmatter an unconditional override:
  ```ts
  const isBg = runtime.isBackgroundAgent(subagentType);       // hoist: reused below
  const wantsBackground = isBg || params.run_in_background !== false;
  ```
  Precedence ladder this yields (with the env gate below):
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` > `background:true` frontmatter > explicit
  `run_in_background` > default (background). **Only the frontmatter-beats-explicit-
  false rung is parity-verified** (Claude docs: `background:true` = "always … even
  when Claude needs the result"); the top rung (env over frontmatter) is the
  *pre-existing* PiCC behaviour this feature preserves, not a documented Claude
  semantic — do not label it "parity-verified".

- **Env gate unchanged.** Keep `if (wantsBackground && !backgroundDisabled &&
  opts.backgroundTasks)`. **The `!backgroundDisabled` conjunct is load-bearing and
  MUST remain a precondition of the background branch** — it is the serial-again
  escape hatch; folding the default into the branch condition and dropping it silently
  defeats the env (security constraint).

- **Degrade-note intent-split (~1651-1663).** The note is currently keyed on
  `wantsBackground`; after the flip that is true for every default dispatch, so it
  would wrongly fire on a defaulted foreground run (disable-env, or registry-less
  tests). Introduce `const explicitBackgroundIntent = params.run_in_background ===
  true || isBg;` (the *old* predicate) and key the note on that; `wantsBackground`
  drives routing only. Update the stale inline comment (~1651-1656) that calls the
  note keyed on "the EFFECTIVE background request".

- **`run_in_background` param typing.** `Type.Optional(Type.Boolean(...))`: omitted →
  `undefined` (→ background via `!== false`), `false` → foreground opt-out, `true` →
  background. Note in the log: `!== false` fails toward *background* on a non-boolean
  (e.g. stringy `"false"`). If you can cheaply confirm Pi coerces execute() params to
  the TypeBox schema, record it; otherwise keep `!== false` (ambiguous values default
  to the new default — acceptable) and record the assumption.

- **Model-facing description strings — reword all of these so background is the
  default, not opt-in:**
  1. **`Agent`/`Task` tool `description` (~1442-1443)** — today "Returns the
     subagent's final message verbatim." Reword: subagents run in the background by
     default; the call returns a task id and runs concurrently with other dispatches;
     retrieve the result with `TaskOutput` (or wait for the settlement notice); pass
     `run_in_background: false` for a synchronous run that blocks and returns the final
     message inline.
  2. **`run_in_background` param description (~1450-1454)** — reword to: background is
     the default; pass `false` for a synchronous inline result; omit/`true` to
     background and collect with `TaskOutput`.
  3. **`HARNESS_CONVENTIONS` subagent line, `src/runtime/context-assembly.ts:104`** —
     today "Return values are the subagent's final message verbatim — parse them as
     the calling skill specifies." This is emitted every turn to **every** dispatching
     context (main orchestrator `index.ts:940`, and nested sub-coordinators
     `index.ts:592`), so it is the highest-leverage nudge. Reword so it states:
     subagents run in the background by default (a dispatch returns a task id, not the
     result); collect the result with `TaskOutput` before relying on it or finalizing
     an answer; pass `run_in_background: false` for a synchronous inline result; the
     collected result is the subagent's final message verbatim — parse it as the
     calling skill specifies. (Keep the "verbatim / parse as the skill specifies"
     concept — it now attaches to the collected result.)
  4. **Collection-side strings in `src/runtime/background-tasks.ts`** — the
     `TaskOutput` description (~585, "started with the Agent tool's
     run_in_background") and the unknown-id hint (~569, "start one … with
     run_in_background: true") still advertise the old opt-in. Reword so `TaskOutput`
     retrieves the result of a background dispatch (the default), not one gated on
     `run_in_background`.

- **One-shot builtins (Explore/Plan) now default-background.** After the flip a plain
  `Explore`/`Plan` dispatch with a wired registry backgrounds (was foreground). This
  is mechanically fine (the start message carries the agent id, no false resumable
  invite) and arguably more faithful to Claude 2.1.198. Add a one-line note in the log
  and a test (or explicit "verified against Claude") that a one-shot builtin
  default-backgrounds.

Shared contracts: **t02** threads a `background` flag into
`SubagentRuntime.dispatch(opts)` and gates the nested concurrency budget on it — do
**not** add that flag here; t01 only touches the tool-handler routing and the
description strings, and leaves the background-arm `runtime.dispatch(...)` call
untouched for t02. **t03** rewrites the capability-registry notes and prose docs — do
not edit `src/registry/capability-registry.ts` or `doc/` here (so `registry.test.ts`
stays green after t01). `Agent` and `Task` share this one definition (single predicate
covers both). `context:fork` uses a different path (`forkDispatch` in `src/index.ts`,
awaited) and must stay foreground/synchronous — do not touch it.

## Writable surface

- `src/runtime/subagents.ts` (routing predicate, intent-split note + comment,
  tool/param descriptions)
- `src/runtime/context-assembly.ts` (`HARNESS_CONVENTIONS` subagent line only)
- `src/runtime/background-tasks.ts` (`TaskOutput` description + unknown-id hint
  strings only — no logic change)
- `test/background-tasks.test.ts`, `test/runtime-core.test.ts`,
  `test/e2e-live-pi.test.ts` (routing tests + inverted scenarios — see Testing)
- `doc/plan/15-background-by-default/log/t01.md`

Do **not** edit `src/registry/capability-registry.ts`, `doc/`, `README.md`,
`CHANGELOG.md`, `src/index.ts` (wiring), or `dispatch()`'s signature/semaphore here
(t02/t03 own those).

## Approach constraints

- Keep the `!backgroundDisabled && opts.backgroundTasks` gate intact.
- Frontmatter (`isBackgroundAgent`) wins over an explicit `run_in_background: false`.
- Do not change `dispatch()`'s signature or the semaphore (t02 owns that).
- No new settings/env knob.

## Left open

- Exact prose of the four description surfaces (must satisfy the constraints above;
  ASCII).
- Whether to normalize a non-boolean `run_in_background` or rely on `!== false`
  (record the decision + any Pi-coercion finding in the log).
- Exact structure of the concurrency test, as long as it is timer-free.

## Testing

Use the existing `gatedSdk` / `fakeSdk` + `makeSubagentRuntime` helpers; drive the
`Agent` tool's `execute` directly (offline/unit). Cover every acceptance bullet:

- **(a) Implicit concurrency, timer-free.** Registry wired + a *closed* `gatedSdk`
  gate. Two `execute()` calls, no `run_in_background`; assert **both** return the
  "Background task … started" message and both records are `status:"running"` while
  the gate is still closed (a serial/foreground impl would block the first call on the
  gate and never reach the second). Release + drain. No `setTimeout`.
- **(b) `run_in_background: false` blocks + inline.** Registry wired, ungated sdk;
  assert the content is the verbatim final message and `registry.ids()` is empty.
- **(c) Frontmatter precedence.** A `background: true` agent dispatched **with**
  `run_in_background: false` still backgrounds. Keep the existing plain `background:
  true` case green.
- **(d) Disable-env forces foreground on a *plain* dispatch.** Env set, registry
  wired, no flag/frontmatter → foreground, `registry.ids()` empty, and (intent-split)
  **no** degrade note.
- **(e) Settlement / TaskOutput on the default path** (+ sanitization regression
  guard). Omit `run_in_background`; let it settle; `TaskOutput` returns the verbatim
  result and the settlement notice drains exactly once (reuse
  `drain`/`settledSubRegistry`). Also assert a hostile `subagent_type`/label is still
  sanitized in the default-path settlement notice / `TaskOutput` (now the common
  path). `/usage` needs **no** new test (captured in `dispatch()` independent of
  routing).
- **One-shot builtin default-backgrounds** — a plain `Explore` (registry wired)
  returns a task id (see note above).
- **Description anti-regression** — a cheap assertion that the `Agent` tool
  description no longer carries opt-in framing and mentions `run_in_background: false`
  as the synchronous opt-out (no such assertion exists today). (`integration-
  extension.test.ts:246` asserts the expanded text contains `"run_in_background"` —
  that's the param *key*, which survives any rewording; confirm it stays green.)
- **Invert the stale default-foreground tests:**
  - `test/background-tasks.test.ts:841` (plain agent runs foreground) → new
    default-background expectation. Refresh the now-stale comment at
    `background-tasks.test.ts:1153-1156` ("degrade note must key on the EFFECTIVE
    background request") to match the intent-split (assertion stays green — frontmatter
    counts as explicit intent).
  - **`test/e2e-live-pi.test.ts` — FIVE scenarios dispatch `Agent` without
    `run_in_background` and rely on foreground/positional sequencing; all break or
    flake under the flip. Fix each:**
    - **Scenario 5 (~471)**, **Scenario 13 (~764)**, **e2e-t01 (~818)**, **e2e-t02
      (~867)** test verbatim inline return / worktree isolation / failure naming /
      transcript persistence — foreground is incidental; pin `run_in_background:
      false` (cheapest intent-preserving fix).
    - **Scenario 10 (~616)** — rework to *omit* the flag and retrieve via `TaskOutput`
      (like Scenario 11 but without the explicit flag), so the new default gets
      real-stack coverage. Use mock-openai `when` predicates (subagent vs parent
      turns), never positional replies — positional replies are order-nondeterministic
      under concurrency (Scenario 11's comment ~678-679) and flake cross-platform.
- Confirm `test/runtime-core.test.ts:499/524` stay green under the intent-split.

## Acceptance criteria
- [ ] Omitting `run_in_background` backgrounds; `false` runs foreground inline;
      `background:true` frontmatter backgrounds regardless;
      `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` forces foreground.
- [ ] Degrade note fires only on explicit background intent.
- [ ] Tool + param descriptions, `HARNESS_CONVENTIONS`, and the `TaskOutput`/unknown-id
      strings all state the new default and how to collect.
- [ ] All five inverted e2e scenarios fixed; new concurrency test timer-free.
- [ ] typecheck and full test suite green.

## Depends on
–

# t02: Wire the fork path — thread the Esc signal and map both fork consumers through the helper

## Goal

Both `context: fork` consumers stop silently losing information: on failure they preserve
the fork's partial output **and** name the cause, and an aborted fork is reported as
**aborted** distinctly from an empty success or a crash. The Skill-tool consumer forwards
the Esc `AbortSignal` so an Esc'd fork actually cancels and reports aborted. Forks stay
non-resumable — no trailer, no resume invite. Offline tests drive the **real** consumers
through a controllable fork outcome and prove both the mapping and the signal threading.

## Context & seams

Consumes the t01 helper — import `presentDispatchResult` and the `DispatchPresentation`
type (`kind:"result"|"failure"`, `text`/`cutOff`/`message`; `opts.allowResumeTrailer`). All
consumer edits are in `src/index.ts`:

1. **`forkDispatch`** (`src/index.ts:398-431`): add a trailing param
   `abortSignal?: AbortSignal` and forward it into the `subagentRuntime.dispatch({...})`
   call as `abortSignal` (the dispatch option already exists,
   `src/runtime/subagents.ts:508`). `forkDispatch` **must resolve, never reject** (it only
   forwards into `dispatch`, which always resolves a `DispatchResult` incl. on abort —
   `subagents.ts:610,823,893,1167,1233`; do not add a throwing path). No other change to
   fork construction (the synthetic `agentOverride` / non-resumability stays).

2. **Skill-tool consumer** (`src/index.ts:702` execute signature; fork branch `:709-720`):
   - Add a 3rd param to `execute`: `signal?: AbortSignal` (Pi passes it positionally as the
     3rd arg — confirmed by `src/runtime/tools/web-tools.ts:200`,
     `src/runtime/tools/search-tools.ts:701`, and the Agent tool `subagents.ts:1481`; the
     current 2-arg signature simply omits it). One `createSkillTool` factory
     (`src/index.ts:692`) builds **both** the top-level model-invoked instance (`:741`) and
     the subagent-scoped instance (`forSubagent:true`, `:624`), so the single param change
     covers both.
   - Pass `signal` into `forkDispatch(skill, rendered, opts.depth+1, args, signal)`.
   - Replace `if (!result.ok) throw new Error(...)` (`:715`, the partial-dropping bug) with
     `presentDispatchResult(result, { allowResumeTrailer: false })`:
     `kind:"failure"` → `throw new Error(p.message)`; `kind:"result"` → return
     `{ content:[{type:"text", text:p.text}], details:{ forked:true, agent:result.agentName, cutOff:p.cutOff } }`.
   - The **success** path stays observably the same (verbatim `finalMessage` +
     `details.forked/agent`) — it now flows through the helper's `completed` branch.

3. **Top-level input-hook consumer** (the `pi.on("input", async (event, ctx) => …)` handler;
   fork branch `src/index.ts:1040-1048`):
   - `ctx` is the handler's 2nd param (already in scope at `:981`). Pass `ctx.signal` into
     `forkDispatch(skill, rendered, 1, argsText, ctx.signal)`. **Note:** at the input hook
     `ctx.signal` is `undefined` in the normal typed-`/skill` case (the event fires before
     the turn streams), so this wires the harmless/correct steer edge-case only — it does
     **not** make a typed `/forked-skill` expansion Esc-cancellable. This is a PiCC/Pi
     harness limitation (Pi exposes no abort signal at the input-hook stage), documented in
     t03; do not hide it.
   - Map the result with `presentDispatchResult(result, { allowResumeTrailer: false })` and
     **fold every kind into the transform text — never throw** (the handler's `catch` at
     `:1064-1067` would otherwise swallow it and send the raw unexpanded `/skill` to the
     model). Preserve the existing success envelope
     (`` `The ${skill.name} skill ran in a forked subagent. Its result:\n\n${p.text}` ``);
     on `kind:"result"` with `cutOff` the `p.text` already carries the partial + cut-off
     note (same envelope is fine); on `kind:"failure"` produce a clearly-worded line that
     names the cause — e.g.
     `` `The ${skill.name} skill (context: fork) did not finish: ${p.message}` ``.

4. **`PiccTestSeam` sdk injection** (`src/index.ts:171-176`, guarded by the `SECURITY:` block
   at `:164-169`): add an **optional input field** carrying a fake `PiSdk`, and read it into
   the `new SubagentRuntime({ … })` deps at **`src/index.ts:608`** (the `sdk?` dep already
   exists and is consumed lazily — `subagents.ts:119`, `:440`; when unset the runtime calls
   `loadRealSdk()`). **This is NOT the `onWired` callback** — `onWired` fires at `:451`,
   *before* the runtime is constructed at `:608`, so it cannot carry the sdk; it must be a
   new input field consumed at construction. Because `forkDispatch` closes over that one
   runtime instance, the injected sdk reaches forks. Security constraints (mandatory):
   - The field is read **only** off the in-process `testSeam` parameter and plumbed straight
     into `deps.sdk` — **no** `process.env` / `project.settings` / file fallback anywhere on
     that path (the sdk is the execution substrate — higher privilege than the registries
     `onWired` hands out).
   - **Extend** the `SECURITY:` comment block at `:164-169` to name the new sdk field and
     restate the in-process-only invariant.
   - Add a regression test asserting single-arg `picc(pi)` (no `testSeam`) yields the real
     sdk path (i.e. no seam field ⇒ `loadRealSdk`), so the invariant is guarded, not just
     asserted in prose.

Reference behaviour (parity target, do not re-derive): the `Agent` tool at
`subagents.ts:1563-1665`, now expressed through the same t01 helper.

## Writable surface

- `src/index.ts` (the four edits above).
- `test/` — new offline-integration tests (extend `test/integration-extension.test.ts` or
  add a file); may touch `test/helpers/fake-pi.ts` / `test/helpers/fake-sdk.ts` to route the
  injected sdk. Tests must use a fresh `wire()`-style extension instance (pattern at
  `integration-extension.test.ts:464-469`), **not** the outer `beforeAll` `pi` (whose
  runtime lazy-loads the real sdk). The `examples/full-surface/.claude/skills/fork-research`
  fixture is a `context: fork` skill, both model- and `/`-invocable, and drives both
  consumers offline once the fake sdk is injected.
- **Not** the capability registry / generated docs / CHANGELOG / architecture.md — that is t03.
- **Not** `src/runtime/subagents.ts` — the helper is t01's; only import it here.

## Approach constraints

- **Non-resumable forks:** always call the helper with `allowResumeTrailer:false`; never
  emit an agent-id trailer or a "resume via SendMessage" line on a fork.
- **Input hook never throws.** Every fork outcome becomes transform text; the turn still
  expands. (`forkDispatch` resolves-never-rejects and the helper is total, so this holds —
  keep both properties.)
- **No behaviour change** to non-fork skills or to the fork **success** path (regression
  tests must stay green).
- **Byte-identical cut-off frame** via the t01 helper — no hand-written `---` framing here.

## Left open

- Exact seam field name/shape for sdk injection, and how `fake-pi`/`fake-sdk` route it.
- Exact wording of the failure/cut-off lines in the input-hook text channel (must carry
  partial + cause; keep the success envelope wording).
- Exact new test file vs. extending `integration-extension.test.ts`.
- Whether the input hook passes `ctx.signal` or omits it — recommended: pass it through
  (correct when defined, harmless when `undefined`).

## Testing

Offline-integration, driving the real closures via `fake-pi` + injected `fake-sdk` (reuse
the `gate` + `await setTimeout(10)` + `controller.abort()` timing pattern from
`test/subagent-outcomes.test.ts:209-245,372-388`; assert `\n` literals; no fs/worktree
paths — forks are non-resumable so there is no trailer/transcriptPath to assert):

- **Skill tool:** (1) failed-with-partial → success-shaped content, text starts with the
  partial, cut-off note names the cause, `details.cutOff===true`; (2) failed-no-output →
  throws the named cause, no fabricated `[\r\n]` frame; (3) **aborted** → throws/reports the
  abort wording, distinct from the API-error wording — the never-resolving gate + abort via
  the 3rd `execute` arg proves the signal is threaded execute→forkDispatch→dispatch (if
  threading were dropped the test would hang, not pass). Assert on the *abort wording*, not
  on the synthetic `fork:<skill>` agent name (that internal prefix may be prettified later);
  (4) success unchanged.
- **Input hook** (`pi.fire("input",{text:"/<forked-skill> args"})` → `{action:"transform",
  text}`): (5) failed-with-partial → text carries partial **and** cause; (6) failed-no-output
  → text names the cause and the expansion still happens (handler does not throw / does not
  fall back to raw input); (7) success unchanged.
- **Input-hook aborted is NOT reachable as a genuine Esc** (no signal at the input hook) —
  do **not** write a test asserting it; the aborted *mapping* is covered by t01's unit tests.
- **Seam invariant:** single-arg `picc(pi)` uses the real sdk (see edit #4).
- Keep the existing `integration-extension.test.ts` Skill-tool / input non-fork tests
  (`:181-217`, `:223-248`) green.

Scope note on what the abort tests prove: they prove the signal is **threaded** through
`forkDispatch` (the test supplies the signal at the `execute` boundary). Whether a genuine
top-level Esc is **delivered** to a *nested* from-subagent Skill `execute` is Pi's
cross-session abort-propagation behaviour — identical to any nested tool, not introduced or
fixable by F14. t03's registry wording must therefore stay scoped to what is verified (see
t03).

## Acceptance criteria

- [ ] `forkDispatch` accepts and forwards `abortSignal` (and resolves, never rejects); the
      Skill-tool `execute` receives and threads Pi's Esc signal; the input hook passes
      `ctx.signal` through.
- [ ] Both consumers map failure via `presentDispatchResult`: partial output preserved and
      cause named; neither drops `finalMessage` on failure.
- [ ] An Esc'd Skill-tool fork reports **aborted**, distinct from failure and from empty
      success. The input-hook Esc-unreachability is documented, not silently degraded.
- [ ] Fork **success** and non-fork skills are observably unchanged.
- [ ] `PiccTestSeam` sdk-injection reads only from the in-process arg (no env/settings/file
      fallback), the `SECURITY:` block is extended, and a test guards single-arg `picc(pi)`
      ⇒ real sdk.
- [ ] New offline tests cover cases 1–7; existing consumer tests stay green.
- [ ] typecheck and full test suite green.

## Depends on

t01

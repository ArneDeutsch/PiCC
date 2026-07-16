# t01: Flip the default to main-session-only + enforcement tests

## Goal

`createDefaultSettings()` resolves `subagentMaxDepth` to `1` when no subagent
settings are configured, and the suite proves the resulting behavior end-to-end:
the main session still fans out to depth-1 subagents, but a default depth-1
subagent receives neither `Agent` nor `Task`, its system prompt omits the
subagents catalog, a direct depth-2 dispatch (including the `context: fork`
alternate path) is rejected by the runtime guard, and resuming a depth-1 subagent
does not restore nested-dispatch tools. Typecheck and the full suite are green.

## Context & seams

The enforcement is **already implemented** and driven purely by
`subagentMaxDepth` — no enforcement logic changes in this task. The only
production edit is the default constant:

- `src/discovery/settings.ts:87-88` — change `subagentMaxDepth: 5` to `1` and
  rewrite the adjacent comment (it currently reads "Claude Code allows up to 5
  nesting levels below the main conversation (audit E3)."; the new default is a
  deliberate PiCC divergence — main-session-only by default, opt into nesting via
  `subagents.maxDepth: 2..5`).

Enforcement points you are verifying (read them; do not change them). **Line
numbers below are from a snapshot and may have drifted — locate by content:**

- **Main session (depth 0) is NOT gated by `subagentMaxDepth`.** Its `Agent`/`Task`
  tools are provisioned unconditionally at `src/index.ts:~903-916` and its
  subagents catalog is added in the `before_agent_start` hook at
  `src/index.ts:~1005-1010`, both gated only on `subagentsEnabled`. So flipping the
  default to 1 leaves the main session fully intact — this is why the change is
  provably safe for depth-0. (Do **not** attribute the main session's tools/catalog
  to `buildSubagentSystemPrompt` at `src/index.ts:~567-635`; that function is only
  invoked for *dispatched* subagents at depth ≥ 1, never the main session.)
- `src/index.ts:~608-635` — `buildSubagentSystemPrompt` computes
  `nestedDispatchAvailable = subagentsEnabled && depth+1 <= subagentMaxDepth &&
  (granted has Agent|Task)`; the agents catalog it feeds to a *subagent's* prompt is
  `nestedDispatchAvailable ? agentsWithBuiltins() : []`. At default 1 a depth-1
  subagent → `1+1<=1` false → empty catalog.
- `src/index.ts:~704-716` — the subagent tool-provisioning gate (same
  `depth+1 <= subagentMaxDepth` **and** `granted has Agent|Task`) that adds the
  scoped `Agent`/`Task` tools. At depth 1 under default: false → no tools.
- `src/index.ts:~794-799` — a `context: fork` skill/slash-command invoked from a
  subagent calls `forkDispatch(..., opts.depth + 1, ...)`, so from a depth-1
  subagent it dispatches at depth 2.
- `src/runtime/subagents.ts:~888-896` — the runtime backstop: `if (opts.depth >
  this.deps.maxDepth)` rejects with an error containing "exceeds the configured
  maximum". `maxDepth` is wired from `subagentMaxDepth` at `src/index.ts:~745`.

Test-writing seams (from the tester investigation — reuse these patterns;
**locate by content, line numbers may have drifted**):

- Bare default-settings project fixture: see `test/builtin-agents.test.ts:~125-145`
  (a `mkdtemp` project with no `settings.json` ⇒ defaults, dispatching a
  `general-purpose` subagent that **inherits all tools**). This is the fixture
  shape for the depth-1-under-default tests. Do NOT use `examples/full-surface`:
  it pins explicit `maxDepth: 2` and would mask the new default.
- **Non-vacuousness is mandatory for the absence assertions.** "Depth-1 subagent
  has no `Agent`/`Task`" only proves the *depth gate* if the subagent would
  otherwise be granted them — the gate is `depth+1<=maxDepth && (granted includes
  Agent|Task)`. So dispatch a subagent that **inherits all tools** (no `tools:`
  frontmatter restriction), so the only reason `Agent`/`Task`/catalog is absent is
  the depth cap, not a missing grant. Pair every absence assertion with a positive
  control (below).
- Inspect a session's provisioned tools via
  `session.customTools.find(t => t.name === "Agent")` — pattern at
  `test/fork-nested-guard.test.ts:~107`.
- Catalog presence in the system prompt is the string `"Available subagents"` —
  assert its **absence** for the depth-1 subagent and its **presence** for the main
  session (positive control; `builtin-agents.test.ts:~137` shows the main-prompt
  assertion).
- Runtime guard unit test: the block at `test/runtime-core.test.ts:~473-478` uses
  a local `makeRuntime` wrapper (`~:428`) around `makeSubagentRuntime` whose default
  `maxDepth` is **2** (`test/helpers/fake-sdk.ts:~409`). So you MUST pass
  `{ maxDepth: 1 }` and `dispatch({ depth: 2 })` → `ok:false`, error contains
  "depth". Add the **positive mirror** for the explicit opt-in: `{ maxDepth: 2 }` +
  `dispatch({ depth: 2 })` → `ok:true` (proves raising the knob restores one
  generation). `createAgentToolDefinition` depth-cap rejection lives at `~:556-559`.
- `context: fork` alternate-path: the pattern is `test/slashcommand-fork.test.ts:~79-108`
  (real `picc()` + fake SDK; a subagent granted `SlashCommand` invokes a
  `context: fork` skill; today under `maxDepth:2` it registers a depth-2 record).
  You **cannot** just swap the fixture: `slashcommand-fork` materializes
  `full-surface` (which both pins `maxDepth:2` and ships the `context: fork` skill +
  a `SlashCommand`-inheriting subagent), while the bare `builtin-agents` fixture has
  **no skills**. Build a purpose-built default-settings project (no `subagents`
  block ⇒ `maxDepth:1`) that still ships a `context: fork` skill and a subagent
  inheriting `SlashCommand`. Assert **no depth-2 record** registers (invert the
  `records.find(r => r.depth === 2)` check to `toBeUndefined`) **and** a positive
  control that the depth-1 record *does* exist (so the refusal isn't masking a
  dispatch that never ran).
- Resume (AC#5): **do not** clone `test/sendmessage.test.ts:~660-736` to assert
  "resumed depth-1 `customTools` lack `Agent`/`Task`" — that test drives the *fake*
  `makeSubagentRuntime` whose `customToolsFor` is a recorder that emits tools
  regardless of depth/maxDepth, so such an assertion would pass **vacuously** and
  prove nothing. Instead prove AC#5 **by composition** and state it in the log: the
  AC#3 offline test proves the *real* `customToolsFor` (in the `picc()` closure)
  gates a depth-1 subagent to no `Agent`/`Task`; the existing
  `sendmessage.test.ts:~660-736` already proves resume re-invokes `customToolsFor`
  with **preserved `depth=1`** and **identical `customTools`**. Together those are
  AC#5 — no new (vacuous) test needed. (A genuine picc()-level resume test is
  acceptable but is net-new fixture work, not a clone; only write it if the
  composition argument feels insufficient.)

## Writable surface

- `src/discovery/settings.ts` (the default constant + its comment only)
- `test/discovery.test.ts` (update the default assertion + comment)
- New or extended test files for the enforcement coverage below. Prefer adding
  to existing homes where natural; a new focused file (e.g.
  `test/main-session-only-default.test.ts`) is acceptable for the AC#3/#4/#5
  offline-integration + unit cases.
- `doc/plan/22-main-session-only-default/log/t01.md` (execution log)

Do **not** touch `src/index.ts`, `src/runtime/subagents.ts`, the capability
registry, generated docs, or prose docs — those are other tasks or unchanged.

## Approach constraints

- No new setting key. Reuse `subagentMaxDepth`. Do not add
  `nestedSubagentsEnabled`/`recursiveEnabled`.
- Do not change any enforcement logic — this task only flips the default and adds
  the missing tests. If a test reveals the enforcement is actually wrong, STOP
  and report (that would be a scope escalation, not a silent fix).
- Keep `test/discovery.test.ts:513-533` (the explicit-override / both-spellings /
  re-enable test) working as-is — it already covers explicit `maxDepth: 5`,
  `enabled: false`, and `disableSubagents: true`. Do not weaken it.

## Left open

- Whether the new coverage lands in one new test file or is distributed across
  the existing homes named above — implementer's call, optimize for clarity.
- Exact fixture construction for the default-settings project (bare `mkdtemp` vs.
  a helper) — reuse whatever the existing offline-integration tests do.

## Testing

- **Unit:** default resolves to 1 (`discovery.test.ts` update); runtime guard
  rejects `depth: 2` at `maxDepth: 1`; and the positive mirror — `maxDepth: 2`
  admits `depth: 2` (explicit opt-in restores one generation).
- **Offline-integration:** under default settings — (a) main session (depth 0)
  exposes `Agent` + `Task` and the "Available subagents" catalog [positive
  control]; (b) a depth-1 subagent (inheriting all tools) exposes neither tool and
  no catalog; (c) a subagent-invoked `context: fork` (would be depth 2) is refused,
  no depth-2 record, but the depth-1 record exists [positive control]; (d) AC#5 is
  proved by composition (see the resume seam above) — no vacuous clone.
- **Explicit opt-in (AC#6) regression:** the pre-existing `examples/full-surface`
  suite (`maxDepth: 2`) and `test/fork-nested-guard.test.ts` (raises to 3) are the
  behavioral guard that `maxDepth: 2..5` restores nesting; this task adds the
  runtime-level `maxDepth: 2 → depth 2 allowed` positive mirror above and must not
  weaken those. Note this reliance in the log.
- Cross-platform: pure logic + fake SDK. Any new `mkdtemp` + `process.chdir`
  fixture MUST reuse the Windows-safe cleanup idiom (try/catch around `rmSync`, see
  `builtin-agents.test.ts:~143-147`) — Windows transiently locks the just-vacated
  cwd. No OS-specific path assumptions otherwise.

## Acceptance criteria

- [ ] `src/discovery/settings.ts` default `subagentMaxDepth` is `1` with an accurate comment.
- [ ] `test/discovery.test.ts` asserts the default is `1` (comment fixed).
- [ ] A test proves the main session still exposes `Agent`+`Task`+catalog under the default.
- [ ] A test proves a default depth-1 subagent has neither `Agent` nor `Task` and no "Available subagents" catalog.
- [ ] A test proves a direct depth-2 dispatch is rejected by the runtime guard at `maxDepth: 1`, and the positive mirror proves `maxDepth: 2` admits depth 2.
- [ ] A test proves a subagent-invoked `context: fork` (depth 2) is refused under the default, with a positive control that the depth-1 record exists.
- [ ] AC#5 (resumed depth-1 subagent does not regain nested-dispatch tools) is established by composition (real depth-gate test + existing resume-preserves-depth test), documented in the log — not by a vacuous fake-runtime clone.
- [ ] typecheck and full test suite green.

## Depends on
–

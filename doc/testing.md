# Testing

PiCC is tested in three layers, from isolated units up to the **real Pi CLI driven by a mock
model** — no live subscription and no real network are needed for the full suite. This doc is a
decision guide: it tells you **which layer a new test belongs in and why**, how to run each lane,
and the synchronization contracts that keep async tests deterministic.

## Choosing a layer

**The shape is a pyramid.** Cover behavior **fully at the unit layer**; use the costlier layers as
**targeted safety nets** for what a cheaper layer structurally cannot prove. Do not drive every
branch through e2e. The unit lane — not the full suite — is the pre-commit gate
(`.githooks/pre-commit`).

**The trade-off is speed against coverage.** Each e2e scenario runs a real Pi CLI with mock-model
infrastructure, and applicable scenarios spawn further children, on a lane that must stay small
enough to survive a 2-core runner; the same branch tested at the unit layer costs milliseconds and
pins the behavior just as precisely. Do not reach for the highest-fidelity layer because it feels
more convincing.

The decision, in order:

1. **Default to Layer 1.** Can an isolated unit test pin this behavior? Then it goes there — the
   whole field/behavior matrix, not just the happy path.
2. **Go to Layer 2 when the behavior *is* the wiring** — the thing under test only exists once the
   whole extension is loaded (registration, prompt assembly, cross-subsystem ordering).
3. **Go to Layer 3 only for a genuine real-stack boundary** — something that is true only because
   **Pi's own CLI, agent loop, or print mode** is involved — the sole discriminator, since Layers
   1–2 cannot instantiate a real Pi process (Layer 2 fakes `ExtensionAPI`). A real process, shell,
   or OS encoding **by itself stays at Layer 1**, where the hook, worktree, and subprocess tests
   already prove exactly those. If a scenario would merely re-prove PiCC's own logic through a more
   expensive path, it does not earn its place; scenarios like that have been deliberately removed.

**Verify NFRs, don't assume them.** A change is not done because its behavior *looks* similar.
Non-functional requirements — progressive disclosure / lazy loading, context preservation across
compaction, cross-platform execution — get explicit acceptance criteria and tests of their own.
*"Looks right" is not "is right."*

## Test value and cost checklist

Apply this checklist when adding, reviewing, consolidating, or removing tests. Related cases may
share one rationale; do not require a comment on every test.

1. **Name the regression.** State the realistic user, security, compatibility, or operational
   outcome that would break. A test must not compare an implementation with itself. Independent
   authorities such as security allow-lists, compatibility policy, generated-artifact freshness,
   conformance fixtures, observable wire/parser/model shapes, and otherwise-unobservable NFRs are
   legitimate comparisons.
2. **Find the owner.** Search for existing coverage before adding a scenario or file. Extend the
   cohesive owner when possible; use a standalone suite only for a distinct seam, isolation need,
   or failure domain.
3. **Choose the cheapest sufficient layer.** Additional cross-layer proof must exercise a boundary
   the cheaper owner cannot instantiate. Preserve the distinction between a cheap semantic matrix
   and its smallest representative real-process, process-tree, SDK, persistence, HTML, or agent-loop
   witness.
4. **Justify brittle pins.** Private dependency layout, exact wording or markup, and large snapshots
   are exceptional. Retain them only for an externally meaningful wire, parser, security,
   model-visible, compatibility, or otherwise-unobservable NFR contract.
5. **Make it deterministic.** Prefer policy and state seams over production-scale waits. Keep a
   representative high-fidelity witness only where replacing the boundary with a fake would erase
   the contract.
6. **Account for material cost.** When a change adds or substantially expands external launches,
   real waits, Git/worktree setup, or another plausibly costly high-fidelity witness, compare the
   same focused file or lane before and after under comparable conditions where practical. Record
   deterministic Pi or real-process launch deltas; repeat only when process noise affects the
   decision. Reused fixtures and fake-time seams may report `no material cost change`. Measurements
   are review evidence, never duration gates or platform budgets.
7. **Map retired proof.** For consolidation or removal, record the assertion or property and boundary
   retired, its disposition, the surviving owner/test (or `N/A`), and why that owner fails for the
   same regression. If no behavioral contract exists, state the editorial or incidental rationale.
   Preserve negative security/non-egress and platform-distinct process-tree properties rather than
   mapping only a destination filename.
8. **Check aggregate cost.** Review the suite's total permutations and setup burden, not only whether
   each assertion is reasonable alone. Prefer replacement or merging over monotonic growth.
9. **Protect compatibility authorities.** Treat the capability registry, verified Claude semantics,
   and executable conformance fixtures as authoritative. Before retiring compatibility proof, name
   the capability and surviving executable witness; preserve defaults, precedence, error/degrade
   behavior, and model-visible contracts. Review registry claims when support changes, and escalate
   uncertainty rather than deleting proof for cost alone.

In implementation and review evidence, group related cases and record: **regression protected**,
**existing or surviving owner**, **chosen layer**, and **high-cost delta** when applicable. Removal
mappings still include the richer property-and-boundary evidence required above.

## Running the tests

This is the canonical list of lanes.

```bash
npm ci                   # installs the lockfile, including Pi's CLI for the e2e layer
npm run typecheck        # strict TypeScript over src/**, no emit
npm run typecheck:test   # type-check the test suite (test/** + vitest.config.ts)
npm run typecheck:all    # both of the above
npm test                 # unit lane (same as test:unit)
npm run test:unit        # isolated and mixed unit-owned files
npm run test:integration # offline whole-extension integration lane
npm run test:e2e         # installed-Pi preflight, then the real-Pi e2e lane
npm run test:all         # unit, then integration, then e2e
npm run verify           # routine gate: typecheck:all, then unit
npm run verify:all       # complete gate: typecheck:all, then all three lanes
npm run test:coverage    # both in-process lanes, with a src/** coverage report
npm run test:watch       # unit project in watch mode
```

The suite has three Vitest projects (`vitest.config.ts`): `unit`, `integration`, and `e2e`. Each
retains fork parallelism while capping `maxWorkers` at two. Tests in every lane may spawn real child
processes, so the shared bound limits process multiplication and reduces oversubscription risk on
small runners; the cap is the contention lever, not raised timeouts. `test:coverage` spans both
in-process projects and cannot measure the real-Pi child process; it is a guidance signal with no
thresholds.

CI type-checks with `typecheck:all` and runs unit, integration, and e2e as separate lanes across
Windows/Linux. Contributors who opt in with `npm run hooks:install` get the routine `verify`
(typecheck plus unit) pre-commit gate. Use `verify` for ordinary task work and `verify:all` for final
integration and releases.

For a focused inner loop, pass an exact file through its executable owning lane. The lookup is
executable: `e2e-*` files belong to e2e; files in `integrationTestFiles` belong to integration; every
other test file belongs to unit. An explicit-path “No test files found” usually means you chose the
wrong owning lane.

```bash
npm run test:unit -- test/permissions.test.ts
npm run test:integration -- test/integration-extension.test.ts
npm run test:e2e -- test/e2e-core.test.ts
```

The focused e2e form retains the lane's installed-Pi preflight. To select one test, pass an anchored
regular expression containing the full Vitest name, including its `describe` ancestry:

```bash
npm run test:unit -- test/permissions.test.ts -t "^parseRule parses bare tool names$"
```

Vitest's `-t` is a regular-expression filter, so an unanchored leaf name is not exact.

The runner is [vitest](https://vitest.dev). Tests are TypeScript run through `tsx`/vitest — there
is no build step to run first. The e2e layer needs Pi's compiled CLI at
`node_modules/@earendil-works/pi-coding-agent/dist/cli.js`; `npm ci` provides it.
`test:e2e` fails before Vitest with reinstall/version guidance when that CLI is missing, preventing
CI and complete local verification from silently skipping the real-Pi lane. Direct Vitest runs may
still skip the E2E files gracefully, which is useful for narrow development commands.

## Layer 1 — unit tests (per subsystem)

Unit tests live in `test/*.test.ts`, **one or more per subsystem**, named after the subsystem they
cover (`permissions.test.ts`, `worktrees.test.ts`, `skills.test.ts`, …) — the file names are the
index, so list the directory rather than trusting a table here. Run unit-owned files with
`npm run test:unit`; a mixed unit-owned file may retain conceptual Layer-2 blocks.

Each subsystem is tested against its full field/behavior matrix, **including fields the reference
project never exercises** — that is the completeness floor's bar, and it is why this layer carries
the coverage weight. The layer uses no external network and is mostly isolated, but selected hook,
worktree, and subprocess tests launch local processes and exercise real Git repositories.
Cross-platform behavior belongs here too, guarded rather than skipped wholesale: gate on the
platform (`it.skipIf(process.platform !== "win32")(…)`) or on a constant that probes the tool once
at module scope (`hasBash` in `native-temp-paths.test.ts`, `rgAvailable` in `search-tools-rg.test.ts`;
`e2e-live.ts` exports the e2e lane's own `BASH_AVAILABLE`/`PYTHON_BIN`).

One file is not a subsystem test: `test/pi-contract.test.ts` asserts that every pinned Pi API export
still exists, so Pi churn fails first and loudly rather than as a confusing downstream break.
Installed-Pi contract suites own package identity, renderer lifecycle, and HTML boundaries that fake
components cannot prove. Keep each witness in the focused suite for the boundary it exercises.

### Renderer performance evidence

Keep local rendering cost separate from provider, network, and inference latency:

- Unit tests deterministically bound retained-result property access, body scanning, component
  construction, rendered rows, and repeated repaint work. They are the regression gate.
- Exercise collapsed settlement and repaint directly; do not launch a provider or real Pi process
  merely to measure renderer code.
- Record any wall-clock settlement/repaint benchmark as diagnostic review evidence with its input
  shape and environment. Do not make elapsed milliseconds a CI threshold.
- Provider or process-e2e timing supports only a transport/startup claim designed for that boundary;
  it is not evidence that a local renderer became faster or slower.

## Layer 2 — offline integration (fakePi)

The dedicated integration lane contains the dominant whole-extension files selected by
`integrationTestFiles` in `vitest.config.ts`; it does not absorb every conceptual Layer-2 block from
a mixed unit-owned file. Run a focused file through whichever executable lane owns it.

The representative whole-extension suite loads `picc(pi)` against the `examples/full-surface`
conformance fixture through `test/helpers/fake-pi.ts` — a hand-written stand-in for Pi's
`ExtensionAPI` that records every tool, command, event handler, message, and model/thinking call the
extension makes. It also records and **drives the interactive UI surface** with Pi-faithful semantics
— widget installs/removals, focused `custom` components, the raw terminal-input chain
(`feedTerminalInput`), shortcut and message-renderer registration, an injectable keymap, and
mode-shaped contexts (`tuiCtx`/`printCtx`/`rpcCtx` modeling the real TUI/print/RPC ctx shapes) —
which lets TUI behavior such as the subagent status panel and its drill-down be tested offline.
`test/helpers/fixture.ts` copies a fixture from `examples/` into a temp dir and turns it into a real
git repo (so worktree and git-plumbing behavior is genuine).

This layer asserts the **mechanical-fidelity tier end to end without any model**: the Claude tool
surface is registered, the system prompt is assembled correctly, skills stay lazy-loaded until
activation, deny rules and hooks fire, worktrees are created and seeded, and unknown/future features
degrade. It is the fastest way to test cross-subsystem wiring.

## Layer 3 — live e2e (real Pi CLI + mock OpenAI model)

The `test/e2e-*.test.ts` files are the highest-fidelity layer. Each **spawns the real Pi CLI**
(`node dist/cli.js -e src/index.ts -p "<prompt>"`) in a materialized `examples/` fixture, pointed at
a local **mock OpenAI-compatible model server** (`test/helpers/mock-openai.ts`) via a throwaway Pi
agent dir. No real model, no subscription, no outbound network.

They share the process harness and request helpers in `test/helpers/e2e-live.ts`. Group scenarios by
cost so subagent-heavy or compaction-heavy processes do not form one serial pole. Keeping the
`e2e-` prefix on every file is a **contract**: only the e2e project includes `test/e2e-*.test.ts`, so
the prefix keeps real-Pi spawns in that lane. List `test/e2e-*.test.ts` for the current scenario
set rather than maintaining an inventory here.

`mock-openai.ts` is a scriptable SSE server: each test hands it a list of `Turn`s (either scripted
`tool_calls` or plain text, optionally pinned with a `when` predicate or a scripted `error`), and it
streams back OpenAI-shaped chunks while **capturing every request Pi actually sent**. A test
therefore asserts on both sides of the loop — the requests Pi sent to the "model" (system prompt,
advertised tools, tool results, absence of leaked secrets) and the real on-disk side effects (files
written, git worktrees created, transcripts persisted).

**What this layer proves** is that PiCC works as a real Pi extension through Pi's genuine agent
loop, tool dispatch, streaming, machine modes, and persistence — not just against the fake API.
Keep it as a curated **real-stack security layer**: each scenario must prove a boundary a cheaper
unit/integration test structurally cannot.

### Adding a new e2e scenario

1. Pick the file whose theme fits (or add a new `test/e2e-<name>.test.ts` — **keep the `e2e-`
   prefix**). Each file wires the harness once at module scope:

   ```ts
   const { runPi, cleanup } = createE2ELive();
   afterEach(cleanup);
   ```

2. Add an `it(...)` inside that file's `describe.skipIf(cliMissing)` block and call
   `runPi({ script, prompt, setup?, fixture?, persistSession? })`:
   - `script: Turn[]` — the model's turns. Use `{ toolCalls: [{ name, args }] }` to drive a tool call
     (tool `name` is the Pi/registered tool name, e.g. `write`, `bash`, `Agent`), or `{ text }` for a
     plain reply. When the script is exhausted the mock replies `"done"`, so the loop always terminates.
   - `prompt` — the user prompt Pi is launched with.
   - `setup(fixtureDir)` — optional: write extra files into the fixture before the run.
   - `fixture` — `"hello-claude"` (default) or `"full-surface"`.
   - `persistSession` — keep session persistence on (drops `--no-session`) for transcript scenarios.
3. Assert on `result.requests` (what Pi sent the model — use the `systemText` / `toolResultText` /
   `allText` / `userText` helpers) and on files under `result.fixture` / `result.agentDir` (real side
   effects). Gate shell/python scenarios on `BASH_AVAILABLE` / `PYTHON_BIN` as the existing ones do.
4. If a scenario needs artifacts the `hello-claude` fixture lacks, prefer extending `full-surface`
   and its Layer-2 coverage; keep e2e scenarios focused on genuine real-stack boundaries.

## Synchronizing asynchronous tests

Correctness tests must wait for observable readiness, ordering, or completion — not sleep for a
fixed interval or require work to finish within a narrow elapsed-time threshold. Tests directly
under `test/` import the shared synchronization and process helpers with:

```ts
import { deferred, settlement, waitUntil } from "./helpers/async.js";
import { createHookProcessFixture } from "./helpers/hook-process.js";
```

The shared helpers have these contracts:

- `deferred<T>(): Deferred<T>` creates a test-owned promise gate with exposed `resolve` and `reject`.
- `waitUntil(options: WaitUntilOptions): Promise<void>` observes a predicate and rejects with the
  described state at its safety ceiling (`options.timeoutMs`, default 10s). Configure that ceiling
  here rather than adding a second timer around the caller.
- `settlement(promise, options: SettlementOptions): Promise<void>` waits for `promise` to reach a
  terminal state, arming both arms so a rejection is a satisfied wait rather than a predicate error.
  It says nothing about *which* ending occurred, so always follow it with an outcome assertion
  (`await expect(promise).resolves…` / `.rejects…`).
- `FakeSdkHandle.waitForPromptCalls(count: number): Promise<void>` settles when that many prompts
  have entered **and their user messages have been recorded**.
- `FakePi.waitForTools(names: readonly string[]): Promise<void>` settles when the named tools are
  registered. It observes registration only, not initialization or readiness to run a session.
- `FakePi.captureInitialization(completion: Promise<void>): void` records detached startup
  settlement, and `FakePi.waitForInitialization(): Promise<void>` waits until that completion has
  been captured and settled. Wire the observer with
  `picc(pi.api as never, { onInitializationSettled: pi.captureInitialization })`.

Detached startup completion combines orphan reaping and the built-in cwd-bound tool registration
attempts, catching failures from both — so completion does **not** prove that tools registered, and
callers that need tools must separately await `waitForTools`. It is not a session-lifecycle barrier
either. Keep rejecting ceilings comfortably below Vitest's timeout so failures report expected and
observed state instead of an opaque test timeout.

For real hook children, use `createHookProcessFixture(parentDir)` from
`test/helpers/hook-process.ts` and its test-owned marker/release protocol. The child atomically
publishes an `entered` marker; await it with `fixture.waitFor(names, description)` before asserting,
then release identities in the order needed to establish the behavior. When the assertion is that the
children have *exited* rather than that a marker exists, await `fixture.waitForAllClosed(description)`
instead of hand-rolling a poll. Always await cleanup with every still-gated identity in `finally`:

```ts
const fixture = createHookProcessFixture(parentDir);
const runner = new HookRunner({
  config: parseHookConfig({
    UserPromptSubmit: [{ hooks: [{
      type: "command", command: fixture.command, args: ["gate", "first"], timeout: 8,
    }] }],
  }, "<test>").config,
  projectDir: parentDir,
  sessionId: "test-session",
  env: fixture.env,
  disableAllHooks: false,
  onSpawnForTest: fixture.onSpawnForTest,
});
const firing = runner.fire("UserPromptSubmit", { prompt: "hi" });
try {
  await fixture.waitFor(["first.entered"], "hook to enter before release");
  expect(fixture.exists("first.done")).toBe(false);
  fixture.release("first");
  await firing;
  await fixture.waitFor(["first.done"], "hook to finish after release");
} finally {
  await fixture.cleanup("first");
  await firing;
}
```

Values passed through Git Bash must be separately quoted. Prefer portable Node invocation through
environment variables: `exec "$HOOK_NODE" "$HOOK_SCRIPT"`, with `HOOK_NODE` set from
`process.execPath` and paths converted to forward slashes.

Timers are not categorically forbidden. Legitimate uses: semantic timeout tests, process watchdogs
and external-command ceilings, cleanup retries, fixture timestamps, parser-only command strings
(`sleep` tests parsing without executing a wait), and shared rejecting ceilings. A timeout-semantics
test should assert the timeout *result* and structural process/state effects (for example,
cancellation and absence of a post-timeout marker) under a later outer hang ceiling; elapsed speed
is not the success criterion. Review these distinctions directly when adding or changing
asynchronous tests — there is no timing linter whose silence proves a test deterministic.

## Manual testing is the human's job

Everything above runs offline. Two things it cannot do:

- **Validate a real ChatGPT/Codex subscription** — that needs an interactive `/login` OAuth flow and
  a paid account. The provider auth/transport it exercises is Pi's, not PiCC's, and it is the one
  boundary the offline mock-model e2e layer does not cover.
- **Prove a change behaves as intended when picc actually runs it.** A green suite proves the code
  type-checks and the assertions hold; it does not prove the running app does the right thing.

**Agents do not run these checks — they hand the human a script to run.** If your change has a
runtime surface, write a concrete, end-to-end manual-test script: which project to launch picc
against, exactly what to do inside the app, and the **observable outcome** to expect. Not "try it
out". The procedure, the two artifacts it splits into, and the escape hatch for changes with no
runtime surface are canonical in **"Manual verification"** in `CONTRIBUTING.md` — follow it there
rather than inventing your own.

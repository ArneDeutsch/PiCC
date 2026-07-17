# Testing

PiCC is tested in three layers, from isolated units up to the **real Pi CLI driven by a mock
model** — no live subscription and no real network are needed for the full suite (plan §14).

## Running the tests

```bash
npm install       # also fetches Pi, whose CLI the e2e layer drives
npm test          # vitest run — the whole suite (unit + e2e lanes)
npm run test:unit # everything except the real-Pi e2e files
npm run test:e2e  # only the real-Pi e2e files (fork-capped)
npm run test:coverage  # non-e2e lane, with src/** coverage report
npm run test:watch
npm run typecheck
```

The suite is split into two vitest projects (`vitest.config.ts`): a `unit` project
(everything except `test/e2e-*.test.ts`) and an `e2e` project (the real-Pi files). The e2e
project caps its fork count (`maxWorkers`) so the concurrent real-process spawns don't
oversubscribe a small CI runner — the cap is the contention lever, not raised timeouts.
`test:coverage` instruments only in-process code, so it reports the non-e2e lane's coverage of
`src/**`; it cannot measure the real-Pi child process.

The runner is [vitest](https://vitest.dev). Tests are TypeScript run through `tsx`/vitest — there
is no build step to run first. The e2e layer needs Pi's compiled CLI at
`node_modules/@earendil-works/pi-coding-agent/dist/cli.js`; `npm install` provides it. If it is
missing those tests **skip** (they do not fail) with a console warning.

## Synchronizing asynchronous tests

Correctness tests must wait for observable readiness, ordering, or completion—not sleep for a
fixed interval or require work to finish within a narrow elapsed-time threshold. Tests directly
under `test/` import the shared synchronization and process helpers with:

```ts
import { deferred, waitUntil } from "./helpers/async.js";
import { createHookProcessFixture } from "./helpers/hook-process.js";
```

The shared helpers have these contracts:

- `deferred<T>(): Deferred<T>` creates a test-owned promise gate with exposed `resolve` and `reject`.
- `waitUntil(options: WaitUntilOptions): Promise<void>` observes a predicate and rejects with the
  described state at its safety ceiling. Configure that ceiling with `options.timeoutMs` here rather
  than adding a second timer around the caller.
- `FakeSdkHandle.waitForPromptCalls(count: number): Promise<void>` settles when that many prompts
  have entered **and their user messages have been recorded**.
- `FakePi.waitForTools(names: readonly string[]): Promise<void>` settles when the named tools are
  registered. It observes registration only, not initialization or readiness to run a session.
- `FakePi.captureInitialization(completion: Promise<void>): void` records detached startup
  settlement, and `FakePi.waitForInitialization(): Promise<void>` waits until that completion has
  been captured and settled. Wire the observer with
  `picc(pi.api as never, { onInitializationSettled: pi.captureInitialization })`.

Detached startup completion specifically combines orphan reaping and the built-in cwd-bound tool
registration attempts; failures from both activities are caught. Because completion does not prove
that tools registered successfully, callers that need tools must separately await `waitForTools`.
This completion is not a session-lifecycle barrier. Keep rejecting ceilings comfortably below
Vitest's timeout so failures report expected and observed state instead of an opaque test timeout.

For real hook children, use `createHookProcessFixture(parentDir)` from
`test/helpers/hook-process.ts` and its test-owned marker/release protocol. The child atomically
publishes an `entered` marker; await it with `fixture.waitFor` before
asserting, then release identities in the order needed to establish the behavior. Always await
cleanup with every still-gated identity in `finally`:

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
`process.execPath` and paths converted to forward slashes. `test/helpers/hook-process.ts` contains
the reusable implementation.

Timers are not categorically forbidden. Legitimate uses include semantic timeout tests, process
watchdogs and external-command ceilings, cleanup retries, fixture timestamps, parser-only command
strings, and shared rejecting ceilings. A timeout-semantics test should assert the timeout result and
structural process/state effects (for example, cancellation and absence of a post-timeout marker)
under a later outer hang ceiling; elapsed speed is not the success criterion. Watchdogs terminate
hung processes, cleanup retries handle eventual resource release, timestamps provide semantic
fixture data, and parser-only strings such as `sleep` test parsing without executing a wait. Review
these distinctions directly when adding or changing asynchronous tests; there is no general timing
linter whose silence proves a test deterministic.

## Layer 1 — unit tests (per subsystem)

Each subsystem is tested against its full field/behavior matrix, **including fields the reference
project never exercises** (the tier-up completeness bar, plan §2.2). This layer uses no external
network and is mostly isolated, but selected hook, worktree, and subprocess tests launch local
processes and exercise real Git repositories.

| Test file | Covers |
|---|---|
| `test/discovery.test.ts` | location resolution, monorepo walk-up, scope precedence |
| `test/skills.test.ts` | frontmatter parse, progressive disclosure (body absent until load), argument/variable substitution |
| `test/agents.test.ts` | agent frontmatter, `tools:` gating, routing-catalog rendering |
| `test/rules.test.ts` | unconditional vs. `paths:`-scoped rules, user/project layering |
| `test/claude-md.test.ts` | `@import` expansion, nested lookup, HTML-comment stripping |
| `test/hooks.test.ts` | hook config parse/merge, stdin JSON contract, exit-2 block, `updatedInput` |
| `test/permissions.test.ts` | matcher grammar, `deny` enforcement, shell-operator awareness, `if:` conditions |
| `test/plugins.test.ts` | installed-plugin discovery, `${CLAUDE_PLUGIN_ROOT}` resolution |
| `test/tools-parity.test.ts` | Claude ⇄ Pi tool-name mapping, degrade stubs |
| `test/registry.test.ts` | capability registry integrity + compat-report scanning |
| `test/worktrees.test.ts` | worktree create/enter/exit, `.worktreeinclude`, Windows-tolerant removal |
| `test/runtime-core.test.ts` | context assembly, cwd-state, skill activation, steering |
| `test/lenient-frontmatter.test.ts` | malformed YAML degrades to `{}` + diagnostic, never throws |
| `test/subprocess-env.test.ts` | UTF-8 subprocess env defaults, project `env` precedence |
| `test/pi-contract.test.ts` | **Pi upstream contract** — asserts every pinned Pi API export still exists (fails first and loudly if Pi churns) |

## Layer 2 — offline integration (fakePi)

`test/integration-extension.test.ts` loads the **whole extension** (`picc(pi)`) against the
`examples/full-surface` conformance fixture through `test/helpers/fake-pi.ts` — a hand-written stand-in
for Pi's `ExtensionAPI` that records every tool, command, event handler, message, and model/thinking
call the extension makes. `test/helpers/fixture.ts` copies a fixture from `examples/` into a temp dir
and turns it into a real git repo (so worktree and git-plumbing behavior is genuine).

This layer asserts the **mechanical-fidelity tier end to end without any model**: the Claude tool
surface is registered, the system prompt is assembled correctly, skills stay lazy-loaded until
activation, deny rules and hooks fire, worktrees are created and seeded, and unknown/future features
degrade. It is the fastest way to test cross-subsystem wiring.

## Layer 3 — live e2e (real Pi CLI + mock OpenAI model)

The `test/e2e-*.test.ts` files are the highest-fidelity layer. Each **spawns the real Pi CLI**
(`node dist/cli.js -e src/index.ts -p "<prompt>"`) in a materialized `examples/` fixture, pointed at a
local **mock OpenAI-compatible model server** (`test/helpers/mock-openai.ts`) via a throwaway Pi agent
dir. No real model, no subscription, no outbound network.

They share one extracted harness in `test/helpers/e2e-live.ts`: the `createE2ELive()` factory returns
`{ runPi, cleanup }` closing over that file's own per-run temp/fixture bookkeeping, plus the stateless
request helpers (`allText` / `systemText` / `toolResultText` / `userText` / `toolNames`) and probes
(`cliMissing`, `BASH_AVAILABLE`, `PYTHON_BIN`, and the timeouts). The scenarios are grouped by cost so
the subagent-heavy tests aren't one long serial pole:

| File | Scenarios |
|---|---|
| `test/e2e-core.test.ts` | context/prompt assembly smoke; `/deploy` slash-skill expansion |
| `test/e2e-safety-tools.test.ts` | `Read(.env)` deny + secret non-leak; bash (Git Bash) + python encoding round-trip |
| `test/e2e-subagents.test.ts` | background subagent + `TaskOutput`; worktree isolation; provider-error named failure; transcript persistence |

Keeping the `e2e-` prefix on every file is a **contract**: `test:unit` excludes `**/e2e-*.test.ts`, so
the prefix is what keeps real-Pi spawns out of the unit lane.

`mock-openai.ts` is a scriptable SSE server: each test hands it a list of `Turn`s (either scripted
`tool_calls` or plain text, optionally pinned with a `when` predicate or a scripted `error`), and it
streams back OpenAI-shaped chunks while **capturing every request Pi actually sent**. A test therefore
asserts on both sides of the loop — the requests Pi sent to the "model" (system prompt, advertised
tools, tool results, absence of leaked secrets) and the real on-disk side effects (files written, git
worktrees created, transcripts persisted).

**What the mock-model harness proves:** that PiCC works as a real Pi extension through Pi's genuine
agent loop, tool dispatch, streaming, and print mode — not just against the fake API. The lane is
curated to a small **real-stack security layer**: each surviving scenario proves a genuine real-stack
boundary a cheaper unit/integration test structurally cannot (secret non-leak across the real
model-request boundary, real subprocess/shell dispatch and OS encoding, a real background-subagent
session round-trip, real worktree isolation for a spawned subagent, a real provider error killing a
real subagent, and real on-disk transcript persistence). Scenarios that only re-proved PiCC's own logic
already covered by a unit/integration test have been removed.

### Adding a new e2e scenario

1. Pick the file whose theme fits (or add a new `test/e2e-<name>.test.ts` — **keep the `e2e-` prefix**).
   Each file wires the harness once at module scope:

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

## The one manual step

Everything above runs offline in CI. What CI **cannot** do is validate a real ChatGPT/Codex
subscription, because that requires an interactive `/login` OAuth flow and a paid account. That step
is manual: run `picc` against a project, `/login`, pick a GPT/Codex model, and confirm a live
turn (see the user guide's verification status). The provider auth/transport it exercises is Pi's,
not PiCC's, and is the one boundary the offline mock-model e2e layer does not cover.

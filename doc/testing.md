# Testing

PiCC is tested in three layers, from isolated units up to the **real Pi CLI driven by a mock
model** — no live subscription and no real network are needed for the full suite (plan §14).

## Running the tests

```bash
npm install     # also fetches Pi, whose CLI the e2e layer drives
npm test        # vitest run — the whole suite
npm run test:watch
npm run typecheck
```

The runner is [vitest](https://vitest.dev). Tests are TypeScript run through `tsx`/vitest — there
is no build step to run first. The e2e layer needs Pi's compiled CLI at
`node_modules/@earendil-works/pi-coding-agent/dist/cli.js`; `npm install` provides it. If it is
missing those tests **skip** (they do not fail) with a console warning.

## Layer 1 — unit tests (per subsystem)

Each subsystem is tested in isolation against its full field/behavior matrix, **including fields the
reference project never exercises** (the tier-up completeness bar, plan §2.2). These are fast and
have no process/network dependencies.

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

`test/e2e-live-pi.test.ts` is the highest-fidelity layer. It **spawns the real Pi CLI**
(`node dist/cli.js -e src/index.ts -p "<prompt>"`) in a materialized `examples/hello-claude` fixture,
pointed at a local **mock OpenAI-compatible model server** (`test/helpers/mock-openai.ts`) via a
throwaway Pi agent dir. No real model, no subscription, no outbound network.

`mock-openai.ts` is a scriptable SSE server: each test hands it a list of `Turn`s (either scripted
`tool_calls` or plain text), and it streams back OpenAI-shaped chunks while **capturing every request
Pi actually sent**. A test therefore asserts on both sides of the loop — the requests Pi sent to the
"model" (system prompt, advertised tools, tool results, absence of leaked secrets) and the real
on-disk side effects (files written, git worktrees created).

**What the mock-model harness proves:** that PiCC works as a real Pi extension through Pi's
genuine agent loop, tool dispatch, streaming, and print mode — not just against the fake API. Current
scenarios cover: full context assembly into the system prompt (with the skill body staying
lazy-loaded), a scripted `write` tool call round-tripping its result plus a PreToolUse warn hook's
`additionalContext`, a `Read(.env)` deny rule enforced live with the secret never reaching the model,
`Skill` activation with `$0` substitution (0-based positionals), and a real `EnterWorktree` creating
a linked git worktree.

### Adding a new e2e scenario

1. Add an `it(...)` inside the `describe.skipIf(cliMissing)` block in `test/e2e-live-pi.test.ts`.
2. Call `runPi({ script, prompt, setup? })`:
   - `script: Turn[]` — the model's turns in order. Use `{ toolCalls: [{ name, args }] }` to drive a
     tool call (tool `name` is the Pi/registered tool name, e.g. `write`, `Skill`, `EnterWorktree`),
     or `{ text }` for a plain reply. When the script is exhausted the mock replies `"done"`, so the
     agent loop always terminates.
   - `prompt` — the user prompt Pi is launched with.
   - `setup(fixtureDir)` — optional: write extra files into the fixture before the run.
3. Assert on `result.requests` (what Pi sent the model — use the `systemText` / `toolResultText` /
   `allText` helpers) and on files under `result.fixture` (real side effects).
4. If a scenario needs artifacts the `hello-claude` fixture lacks, prefer extending `full-surface`
   and its Layer-2 coverage; keep e2e scenarios focused on end-to-end wiring.

## The one manual step

Everything above runs offline in CI. What CI **cannot** do is validate a real ChatGPT/Codex
subscription, because that requires an interactive `/login` OAuth flow and a paid account. That step
is manual: run `picc` against a project, `/login`, pick a GPT/Codex model, and confirm a live
turn (see the user guide's verification status). The mock-model e2e layer exercises every code path
*except* the provider auth/transport, which is Pi's, not PiCC's.

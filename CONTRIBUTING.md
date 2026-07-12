# Contributing to PiCC

Thanks for your interest. PiCC is a Pi extension bundle that makes Claude Code projects run
unchanged on GPT/Codex models. This guide covers the essentials.

## Setup

```bash
git clone <this-repo> picc
cd picc
npm install --ignore-scripts
```

Node ≥ 22.19 and git are required (Pi's bundled undici 8.x does not run on Node 20). On Windows, Git Bash must be on PATH (see the user guide).

## Develop

The harness is TypeScript source loaded by Pi via jiti — there is **no build step**. Run it against
any Claude Code project with:

```bash
node bin/picc.mjs      # from inside the target project directory
# or: pi -e <path>/src/index.ts
```

Set `PICC_DEBUG=1` to trace load/skill/routing decisions to stderr.

## Test

```bash
npm run typecheck     # strict TypeScript, no emit
npm run test:unit     # fast: unit + offline-integration (fake Pi API)
npm run test:e2e      # slower: drives the REAL Pi CLI against a mock OpenAI server
npm test              # everything
```

See [`doc/testing.md`](doc/testing.md) for the three-layer test strategy and how to add a new
end-to-end scenario. Tests must pass on Windows and Linux; guard OS/dependency-specific behavior
with `it.skipIf`.

## Guiding principles (from the plan)

- **Completeness floor.** No project input may crash the harness. Every artifact/field/tool/hook
  is either honored or degrades to a visible, documented no-op. Loaders never throw — they collect
  `Diagnostic`s.
- **Mechanical fidelity is strict.** Load-bearing mechanics (cwd swap, verbatim subagent return,
  deny enforcement, progressive disclosure, git handling) must behave the way an unchanged project
  expects.
- **No changes to the target project.** Harness state lives outside the project or in the
  gitignored, harness-owned `.claude/.picc/`.
- **No drift.** New capability claims go in `src/registry/capability-registry.ts`; the compatibility
  report and `doc/supported-features.md` are generated from it. Run `npm run gen:capabilities`
  after registry changes.

## Pull requests

- Keep changes focused; match the surrounding code style.
- Add or update tests for behavior changes — prefer an end-to-end scenario for anything a user
  would observe.
- Run `npm run typecheck` and `npm test` before opening the PR. CI runs the same across
  Windows/Linux on Node 22 and 24.
- Note any capability-registry or documentation updates in the PR description.

## Reporting issues

Include: your OS and shell, Node version, the project's relevant `.claude/` artifact (minimized if
possible), and a `PICC_DEBUG=1` trace. `/doctor` output helps for compatibility questions.

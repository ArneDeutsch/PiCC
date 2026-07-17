# PiCC

[![CI](https://github.com/arne/picc/actions/workflows/ci.yml/badge.svg)](https://github.com/arne/picc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Run projects built for Claude Code — unchanged — on GPT/Codex models, from your ChatGPT
subscription.**

Many projects carry a `.claude/` corpus: `CLAUDE.md` hierarchies, skills, subagents,
`settings.json` permissions and hooks, rules, and workflows that rely on worktree isolation and
parallel sessions. PiCC is an agentic harness that reads and honors those Claude-format
artifacts natively on GPT models, with **no changes to the target project**.

It is built as an extension bundle on [Pi](https://github.com/earendil-works/pi) (MIT), which
already solves the two hardest problems — spending a ChatGPT/Codex subscription and abstracting
the model provider. PiCC adds the Claude Code compatibility layer on top.

## Quick start

One command per line — works the same in PowerShell, cmd, and bash:

```powershell
git clone <this-repo> picc
cd picc
npm install --ignore-scripts
npm link

cd \path\to\your-claude-code-project
picc
# /login  → ChatGPT Plus/Pro (Codex subscription)   (one-time)
# /model  → pick a GPT model
# work as you would in Claude Code: /your-skill, subagent fan-outs, worktrees…
```

Windows notes: Git Bash (from Git for Windows) must be installed; if PowerShell blocks the
`picc` script shim, use `picc.cmd` or `Set-ExecutionPolicy -Scope CurrentUser
RemoteSigned`. Details per shell/OS in the guide.

Prefer a package install? Once published, `npm install -g picc` gives you the same
`picc` command; or install a release tarball with `npm install -g picc-0.1.0.tgz`.
PiCC ships as TypeScript source that Pi loads via jiti — there is no build step.

**→ Full documentation: [doc/user-guide.md](doc/user-guide.md)** ·
[Architecture](doc/architecture.md) · [Supported features](doc/supported-features.md) ·
[Testing](doc/testing.md) · [Contributing](CONTRIBUTING.md)

## What it does

- **Skills** — `.claude/skills` and legacy `.claude/commands`, with progressive disclosure,
  argument substitution, and shell injection.
- **Subagents** — `.claude/agents/*.md` and the built-in agent types, with description-driven
  routing, parallel background fan-out (nesting is opt-in via `subagents.maxDepth`), per-agent
  tool gating, and worktree isolation.
- **Worktrees** — `EnterWorktree`/`ExitWorktree` with a real session-cwd swap and a
  Windows-tolerant lifecycle, for parallel sessions on one repo.
- **Hooks** — 13 events (`PreToolUse` … `WorktreeRemove`) with Claude's stdin-JSON/stdout-decision
  contract and matcher semantics.
- **CLAUDE.md, memory & rules** — the ancestor hierarchy, recursive `@import` (the AGENTS.md
  bridge), auto memory, and `.claude/rules/`.
- **Settings & permissions** — `settings.json` precedence and merge semantics, with `deny` rules
  as a hard block.
- **Compaction preservation** — project instructions, rules, and active skills survive
  auto-compaction.
- **Plugins** — content from already-installed plugins and project-bundled `.claude-plugin/`.
- **Git commits** — nudges richer, repo-style-matching commit messages by default.

Everything unrecognized degrades safely and is surfaced — never a crash (the completeness floor).
The full, always-current compatibility matrix is in
[doc/supported-features.md](doc/supported-features.md).

## Control surface

Inside a session: `/skills` and `/agents` list the loaded corpus; `/doctor` gives the full
compatibility breakdown; `/compat` shows/suppresses the startup notice; `/usage` reports a
per-subagent token/cost breakdown; `/quota` reports provider quota headers.
Every user-invocable skill appears in the `/` autocomplete menu. Model and per-model steering are
configured outside the project — see the [user guide](doc/user-guide.md#5-control-surface-project-external).

## Repository layout

| Path | Contents |
|---|---|
| `src/` | The harness: loaders (`claude/`), engines (`engine/`), Pi runtime layer (`runtime/`), capability registry (`registry/`), extension entry (`index.ts`) |
| `bin/picc.mjs` | Launcher (Pi + extension preloaded) |
| `examples/hello-claude` | Minimal demo project |
| `examples/full-surface` | Larger fixture exercising a broad slice of the feature surface |
| `test/` | Unit, offline-integration, and live e2e tests (vitest) — see [doc/testing.md](doc/testing.md) |
| `doc/` | [User guide](doc/user-guide.md), [architecture](doc/architecture.md), [supported features](doc/supported-features.md), [testing](doc/testing.md), and the pinned [Pi contracts](doc/pi-integration.md) |

## Development

```bash
npm run typecheck        # strict TS
npm run test:unit        # fast: unit + offline integration
npm run test:e2e         # drives the real Pi CLI against a mock model
npm test                 # everything
npm run gen:capabilities # regenerate doc/supported-features.md from the registry
```

Support claims are pinned to a **Claude Code ~2.1.x (mid-2026)** baseline in the capability
registry (`src/registry/capability-registry.ts`); the runtime compatibility report is generated
from it, so docs and behavior cannot drift. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

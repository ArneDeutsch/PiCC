# PiClauDex

**Run projects built for Claude Code — unchanged — on GPT/Codex models, from your ChatGPT
subscription.**

Many projects carry a `.claude/` corpus: `CLAUDE.md` hierarchies, skills, subagents,
`settings.json` permissions and hooks, rules, and workflows that rely on worktree isolation and
parallel sessions. PiClauDex is an agentic harness that reads and honors those Claude-format
artifacts natively on GPT models, with **no changes to the target project**.

It is built as an extension bundle on [Pi](https://github.com/earendil-works/pi) (MIT), which
already solves the two hardest problems — spending a ChatGPT/Codex subscription and abstracting
the model provider. PiClauDex adds the Claude Code compatibility layer on top.

## Quick start

```bash
git clone <this-repo> piclaudex && cd piclaudex
npm install --ignore-scripts && npm link

cd /path/to/your-claude-code-project
piclaudex
# /login  → ChatGPT Plus/Pro (Codex subscription)
# /model  → pick a GPT model
# work as you would in Claude Code: /your-skill, subagent fan-outs, worktrees…
```

**→ Full documentation: [doc/user-guide.md](doc/user-guide.md)**

## What it does

- **Skills** — full `SKILL.md` frontmatter, progressive disclosure (bodies lazy-load),
  `$ARGUMENTS`/positional/named substitution, `` !`cmd` `` shell injection (bash + PowerShell),
  `context: fork`, legacy `.claude/commands`.
- **Subagents** — `.claude/agents/*.md`, description-driven routing, parallel fan-out with
  verbatim final-message return, per-agent `tools:` capability gating, nested dispatch with a
  configurable depth cap, `isolation: worktree`.
- **Worktrees** — `EnterWorktree`/`ExitWorktree` with a real session-cwd swap, `.worktreeinclude`
  seeding, Windows-tolerant lifecycle, parallel sessions on one repo.
- **Hooks** — 13 events (`PreToolUse` … `WorktreeCreate`), full stdin-JSON/stdout-decision
  contract, `matcher` + `if:` conditions, plugin and skill-scoped hooks.
- **CLAUDE.md & rules** — root→cwd hierarchy, nested on-demand injection, recursive `@import`
  (the AGENTS.md bridge), `.claude/rules/` with `paths:` scoping.
- **Settings & permissions** — full precedence/merge semantics, honored toggles, `deny` rules as
  a hard block with the complete matcher grammar; a consolidated compatibility report (`/doctor`)
  for everything that degrades.
- **Compaction preservation** — project instructions, rules, and active skills survive
  auto-compaction.
- **Plugins** — content from already-installed plugins and project-bundled `.claude-plugin/`.

Everything unrecognized degrades safely and is surfaced — never a crash (the completeness floor).

## Repository layout

| Path | Contents |
|---|---|
| `src/` | The harness: loaders (`claude/`), engines (`engine/`), Pi runtime layer (`runtime/`), capability registry (`registry/`), extension entry (`index.ts`) |
| `bin/piclaudex.mjs` | Launcher (Pi + extension preloaded) |
| `examples/hello-claude` | Minimal demo project |
| `examples/full-surface` | Conformance fixture exercising the whole feature surface |
| `test/` | Unit + integration + NFR tests (vitest) |
| `doc/user-guide.md` | User documentation |
| `doc/plan/`, `doc/research/`, `doc/design/` | The feature plan (WHAT/WHY), research corpus, pinned Pi integration contracts |

## Development

```bash
npm run typecheck   # strict TS
npm test            # full suite (creates real git repos in temp dirs)
```

Support claims are pinned to a **Claude Code ~2.1.x (mid-2026)** baseline in the capability
registry (`src/registry/capability-registry.ts`); the runtime compatibility report is generated
from it, so docs and behavior cannot drift.

## License

MIT

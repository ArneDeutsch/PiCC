# PiClauDex user guide

PiClauDex runs projects **authored for Claude Code — unchanged — on GPT/Codex models**, driven
from a personal ChatGPT/Codex subscription. It is an extension bundle on
[Pi](https://github.com/earendil-works/pi) (MIT, TypeScript): Pi supplies the agent loop, the
model abstraction, and the subscription auth; PiClauDex supplies Claude Code compatibility —
`CLAUDE.md` hierarchies, `.claude/` skills/agents/rules/commands, `settings.json` permissions
and hooks, worktree isolation, subagent fan-out, and plugin content.

## 1. Requirements

- **Node.js ≥ 20** and npm
- **git** (2.40+ recommended)
- **Windows:** Git Bash on PATH (Pi's `bash` tool and most Claude projects' scripts assume bash;
  PowerShell is used where artifacts declare `shell: powershell`)
- A **ChatGPT Plus/Pro subscription** (for GPT/Codex models) — or any API key Pi supports

## 2. Install

```bash
git clone <this-repo> piclaudex
cd piclaudex
npm install --ignore-scripts
npm link          # makes the `piclaudex` command available globally (optional)
```

Alternatives to `npm link`:

- run Pi directly with the extension: `pi -e /path/to/piclaudex/src/index.ts`
- or add it permanently to Pi's config (`~/.pi/agent/settings.json`):
  ```json
  { "extensions": ["/path/to/piclaudex/src/index.ts"] }
  ```

## 3. Authenticate (spend your subscription)

Auth is Pi's, not ours. In any session:

```
/login        → choose "ChatGPT Plus/Pro (Codex Subscription)" and follow the browser flow
/model        → pick a GPT/Codex model (e.g. openai/gpt-5.5)
```

Notes:
- **Single account only.** Account pooling/credential sharing violates OpenAI ToS; personal
  single-account use is the supported mode.
- If the direct-backend path breaks (endpoint enforcement changes), the documented fallback is
  driving a signed-in `codex` CLI as a subprocess — see Pi's provider docs; PiClauDex works with
  any provider Pi can talk to.
- API keys also work: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.

## 4. Run a Claude Code project

```bash
cd /path/to/your-claude-project     # the one with CLAUDE.md and .claude/
piclaudex
```

On startup PiClauDex loads, with standard Claude Code precedence (user → project → local →
managed):

| Artifact | Source |
|---|---|
| Instructions | `CLAUDE.md` (root→cwd, nested per-directory, `@import` expansion, `CLAUDE.local.md`), `~/.claude/CLAUDE.md` |
| Rules | `.claude/rules/**/*.md` (unconditional at start; `paths:`-scoped inject when you touch matching files) |
| Skills | `.claude/skills/*/SKILL.md` (+ `~/.claude/skills`), lazy-loaded; `.claude/commands/*.md` legacy commands |
| Agents | `.claude/agents/*.md` (+ user scope) — dispatchable via the `Agent` tool |
| Settings | `.claude/settings.json`, `settings.local.json`, `~/.claude/settings.json`, managed policy |
| Hooks | `settings.json` `hooks` (+ plugin hooks, + skill-scoped hooks) |
| Plugins | already-installed plugins from `~/.claude/plugins` + project-bundled `.claude-plugin/` |

Then use it like Claude Code:

- `/skill-name args` — run a user-invocable skill (slash command)
- the model activates skills itself via the `Skill` tool when a task matches a description
- the model dispatches subagents via the `Agent` tool (description-driven routing)
- `EnterWorktree`/`ExitWorktree` isolate work in `.claude/worktrees/<name>/` — the session's
  working directory really moves, so project scripts detect worktree mode via git plumbing
- parallel sessions: open a second terminal, `piclaudex` again, enter a different worktree

## 5. Control surface (project-external)

### Commands

| Command | What it does |
|---|---|
| `/doctor` | Full compatibility breakdown for this project (generated from the capability registry) |
| `/compat [suppress\|show]` | Show the consolidated compatibility notice; suppress/unsuppress it |
| `/quota` | Context usage + provider rate-limit/quota headers from the last response (best-effort) |
| `/model`, `/login`, `/settings` | Pi built-ins: model switching, auth, Pi settings |

### Harness configuration

Lives **outside the project** (`~/.piclaudex/config.json`) or in the harness-owned, gitignored
`<project>/.claude/.piclaudex/config.json` (project overrides user; the harness never touches
tracked project files):

```json
{
  "model": "openai/gpt-5.5",
  "effort": "high",
  "steering": {
    "openai/*": "When a skill specifies a locked output format, reproduce it exactly. Prefer dispatching subagents over doing everything inline when the skill says to fan out."
  },
  "effortMap": { "ultra": "max" },
  "suppressCompatNotice": false
}
```

- `model` / `effort` — defaults applied at session start (effort maps onto Pi thinking levels).
- `steering` — the **model-steering layer**: per-model-pattern system-prompt guidance nudging
  GPT toward Claude-like behavior, without editing the project. Patterns are globs over
  `provider/modelId`; all matching entries are appended.
- `effortMap` — extends the mapping from Claude `effort:` values / prose ("apply maximum
  reasoning effort") to thinking levels.

## 6. Security & permission posture

Deliberately partial, by design (see the plan §6):

- **Default permissive** — no per-command prompts (matches auto-mode usage).
- **`permissions.deny` is a hard, non-interactive block** — the real safety valve. Full matcher
  grammar: `Bash(git *)` (shell-operator aware — `git status && rm -rf /` does **not** match),
  `Read/Edit(glob)`, `WebFetch(domain:*)`, `Agent(type)`, `Skill(name)`, `mcp__server__tool`.
- **Agent `tools:` gating is fully enforced** — a read-only reviewer cannot write; an agent
  without web tools cannot fetch.
- `allow` / `ask` rules and permission modes are parsed and **reported, not enforced** — the
  startup notice and `/doctor` call out every safety-relevant divergence. Never silent.

## 7. What is and isn't supported

Generated truth lives in the capability registry (`src/registry/capability-registry.ts`, baseline
**Claude Code ~2.1.x, mid-2026**) and is what `/doctor` renders. Summary:

**Full:** skills (entire frontmatter set incl. `context: fork`, `paths:`, shell injection under
bash+powershell, argument substitution), rules, agents & nested subagent dispatch with depth caps,
worktrees (incl. `.worktreeinclude`, Windows-tolerant removal), 13 hook events with the full
stdin/stdout contract, CLAUDE.md hierarchy + `@import`, settings toggles, deny rules, tool gating,
`WebFetch`/`WebSearch`/`Grep`/`Glob`/`Task*` tools, installed-plugin content, compaction
preservation.

**Degraded no-op (visible, never crashing):** MCP servers/tools, `ask`/`allow`/permission modes,
plan mode, `AskUserQuestion`, agent `memory:`, checkpointing/rewind, output styles, agent teams,
background tasks, LSP, computer use. Unknown/future fields degrade safely and are reported as
unassessed.

**Not built:** plugin install/marketplace machinery; mid-flight live-session handoff between
harnesses (worktrees/git are fully interoperable — a worktree created under Claude Code can be
re-entered here and vice versa).

## 8. Windows notes

- Git Bash is found automatically (the WSL `bash.exe` stub in System32 is skipped).
- `core.longpaths` is enabled on the repo automatically.
- Worktree removal is best-effort: a file-lock failure never fails your merge; the orphan is
  reaped later (`git worktree prune` + directory sweep on the next session).
- Hook payloads deliver Windows paths with doubled backslashes in JSON, as Claude Code does.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| "could not resolve the Pi CLI" | `npm install` inside the PiClauDex checkout |
| Skill shell injection prints `[shell execution disabled: …]` | project set `disableSkillShellExecution`; that's the project's intent |
| A tool you expected is missing | check `/doctor` — the project may gate it via agent `tools:` or a deny rule |
| Hooks don't fire | check `disableAllHooks` in settings; `/doctor` lists unsupported events/handler types |
| Startup notice keeps appearing | `/compat suppress` (per-project, stored in `.claude/.piclaudex/`) |
| Want to see why a fan-out routed the way it did | agent descriptions are the routing surface — inspect the "Available subagents" catalog in the session, and the dispatch tool calls in the transcript |

## 10. Example projects

Two runnable fixtures ship in `examples/`:

- **`examples/hello-claude`** — a minimal project (one skill, one agent, rules, hooks, deny
  rules) for a first run.
- **`examples/full-surface`** — the conformance fixture exercising the whole supported surface
  (nested subagents, path-scoped rules, `@import` chains, worktree seeding, hook events,
  degradation of unknown/future features). Integration tests run against it; its README maps
  every feature to a canary string.

```bash
cd examples/hello-claude
piclaudex
> /greet Ada
> have the reviewer agent review src/hello.js
```

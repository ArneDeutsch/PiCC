# PiClauDex user guide

PiClauDex runs projects **authored for Claude Code — unchanged — on GPT/Codex models**, driven
from a personal ChatGPT/Codex subscription. It is an extension bundle on
[Pi](https://github.com/earendil-works/pi) (MIT, TypeScript): Pi supplies the agent loop, the
model abstraction, and the subscription auth; PiClauDex supplies Claude Code compatibility —
`CLAUDE.md` hierarchies, `.claude/` skills/agents/rules/commands, `settings.json` permissions
and hooks, worktree isolation, subagent fan-out, and plugin content.

## How it works (in one minute)

At startup PiClauDex reads your project's `.claude/` corpus and `CLAUDE.md` hierarchy into one
in-memory model. From then on, on Pi's own agent loop:

- **Every turn** it appends the assembled instruction set — root `CLAUDE.md`, unconditional rules,
  the budgeted skill listing, and the subagent catalog — to the system prompt. Because the system
  prompt is rebuilt each turn, this is also what survives compaction.
- **Every tool call** passes through a guard that enforces `deny` rules and fires the project's
  hooks, and injects nested `CLAUDE.md` / path-scoped rules when you touch a matching file.
- **Skills** run either as `/slash` commands or via the model's `Skill` tool, with full argument,
  variable, and shell-injection processing — the body loads only on activation (progressive
  disclosure).
- **Subagents** dispatch via the `Agent` tool into fresh, isolated sessions and return their final
  message verbatim; **worktrees** swap the session's working directory so the project's own git
  tooling detects worktree mode.

Nothing is written to your project's tracked files. For the full design see
[`doc/architecture.md`](architecture.md); for the exact compatibility matrix see
[`doc/supported-features.md`](supported-features.md).

## 1. Requirements

- **Node.js ≥ 20** and npm
- **git** (2.40+ recommended)
- **Windows:** Git Bash on PATH (Pi's `bash` tool and most Claude projects' scripts assume bash;
  PowerShell is used where artifacts declare `shell: powershell`)
- A **ChatGPT Plus/Pro subscription** (for GPT/Codex models) — or any API key Pi supports

## 2. Install

Every command below is one line per step — paste them one at a time. They work identically in
**PowerShell**, **cmd**, and **bash** (no `&&` chaining is used anywhere in this guide, because
Windows PowerShell 5.1 does not support it).

### Windows (PowerShell or cmd)

```powershell
git clone <this-repo> piclaudex
cd piclaudex
npm install --ignore-scripts
npm link
```

`npm link` makes the global `piclaudex` command available. Notes for Windows:

- If running `piclaudex` in PowerShell fails with *"running scripts is disabled on this
  system"*, either call the cmd shim `piclaudex.cmd` instead, or allow local scripts once:
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  ```
- **Git Bash must be installed** (it comes with Git for Windows). Pi's `bash` tool and most
  Claude Code projects' scripts assume bash; PiClauDex finds Git Bash automatically and never
  uses the WSL `bash.exe` stub in System32.

### Linux / macOS (bash or zsh)

```bash
git clone <this-repo> piclaudex
cd piclaudex
npm install --ignore-scripts
npm link    # may need: sudo npm link — or configure a user-level npm prefix
```

### Alternatives to `npm link` (any OS)

- Run without installing anything globally — from your target project directory:
  ```powershell
  node <path-to-piclaudex>\bin\piclaudex.mjs
  ```
  (forward slashes work too, in every shell)
- Or, if you already use Pi, load the extension directly:
  `pi -e <path-to-piclaudex>/src/index.ts`
- Or add it permanently to Pi's config (`~/.pi/agent/settings.json`):
  ```json
  { "extensions": ["<path-to-piclaudex>/src/index.ts"] }
  ```

## 3. Authenticate (spend your subscription)

Auth is Pi's, not ours, and is a one-time interactive step. Step by step (any shell):

1. Open a terminal in any directory and start the harness:
   ```powershell
   piclaudex
   ```
   (or `node <path-to-piclaudex>/bin/piclaudex.mjs` if you skipped `npm link`)
2. In the input box at the bottom, type `/login` and press Enter.
3. Select **"ChatGPT Plus/Pro (Codex Subscription)"** with the arrow keys and press Enter.
4. Your browser opens an OpenAI login page (if not, Pi prints a URL to copy). Log in with the
   account holding your subscription and approve.
5. Back in the terminal, type `/model`, press Enter, and pick a GPT/Codex model
   (e.g. `openai-codex/gpt-5.5`).
6. Quit with Ctrl+C pressed twice.

Credentials are stored in `~/.pi/agent/auth.json` (`C:\Users\<you>\.pi\agent\auth.json` on
Windows) — in your user profile, **never inside any project repository**, and PiClauDex never
reads or copies them.

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
| `/skills` | List every loaded skill — invocable-as-slash-command, model-invocable-only, and user-only — with descriptions and source (project / user / plugin) |
| `/agents` | List every subagent available for dispatch, with its tools, read-only marker, model, and worktree-isolation |
| `/doctor` | Full compatibility breakdown for this project (generated from the capability registry) |
| `/compat [suppress\|show]` | Show the consolidated compatibility notice; suppress/unsuppress it |
| `/quota` | Context usage + provider rate-limit/quota headers from the last response (best-effort) |
| `/model`, `/login`, `/settings` | Pi built-ins: model switching, auth, Pi settings |

**Slash autocomplete.** Every user-invocable skill appears in the `/` menu with its description and
argument hint — type `/` to browse, or start typing a name to filter. Selecting one expands the
skill into your turn (with argument, variable, and shell-injection processing) exactly as Claude
Code does. The full instruction body is loaded only on invocation (progressive disclosure), so the
menu stays fast even with dozens of skills.

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

### Environment variables

| Variable | Effect |
|---|---|
| `PICLAUDEX_CLAUDE_USER_DIR` | Override the user-scope Claude dir (default `~/.claude`) — useful for isolated profiles or CI |
| `BRAVE_API_KEY` | Use the Brave Search API for `WebSearch` (otherwise a keyless DuckDuckGo fallback is used) |
| `PI_CODING_AGENT_DIR` | Pi's own config dir override (auth, models, Pi settings) |

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
**Claude Code ~2.1.x, mid-2026**) and is what `/doctor` renders. The full table — every tool, hook
event, setting, frontmatter field, and feature with its tier — is in
[`doc/supported-features.md`](supported-features.md) (generated from that same registry, so it
cannot drift). Summary:

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

## 8. Windows specifics

Everything runs natively on Windows 11 — no WSL required. The points below are Windows-only
behaviors worth knowing:

- **Git Bash is required, and found automatically.** Pi's `bash` tool and most Claude Code
  projects' scripts assume bash. PiClauDex locates the real Git Bash (`Program Files\Git\bin\bash.exe`
  and friends) and **skips the System32 WSL `bash.exe` stub**, which otherwise fails with
  `WSL_E_DEFAULT_DISTRO_NOT_FOUND` when no WSL distro is installed. The resolved shell is used for
  both hooks and `` !`cmd` `` skill injection. Install Git for Windows if `bash` isn't on PATH.
- **UTF-8 subprocess default.** Spawned interpreters (notably Python) default their I/O to the
  legacy code page (cp1252), which can't encode Unicode the model routinely prints (e.g. `→`),
  causing `UnicodeEncodeError`. PiClauDex sets UTF-8 defaults (`PYTHONIOENCODING`/`PYTHONUTF8`,
  `LANG`/`LC_ALL`) for child processes **only when you haven't set them** — an explicit project or
  user `env` value always wins.
- **MSYS argument-mangling caveat (slash commands via `-p`).** Under **Git Bash**, MSYS rewrites an
  argument that looks like a Unix path — so `piclaudex -p "/greet Ada"` gets the leading `/greet`
  mangled into a Windows path and the skill won't resolve. Run slash-command-as-argument invocations
  from **PowerShell or cmd**, or just type `/greet Ada` inside the **interactive TUI** (where no
  MSYS mangling applies). Normal interactive use is unaffected.
- **Long paths & worktrees.** `core.longpaths` is enabled on the repo automatically. Worktree
  removal is best-effort: a file-lock failure never fails your merge; the orphan is reaped later
  (`git worktree prune` + a directory sweep on the next session).
- **Hook payloads** deliver Windows paths with doubled backslashes in JSON, as Claude Code does.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| "could not resolve the Pi CLI" | `npm install` inside the PiClauDex checkout |
| Skill shell injection prints `[shell execution disabled: …]` | project set `disableSkillShellExecution`; that's the project's intent |
| A tool you expected is missing | check `/doctor` — the project may gate it via agent `tools:` or a deny rule |
| Hooks don't fire | check `disableAllHooks` in settings; `/doctor` lists unsupported events/handler types |
| Startup notice keeps appearing | `/compat suppress` (per-project, stored in `.claude/.piclaudex/`) |
| Unexpected skills/agents from plugins | PiClauDex loads a plugin's content only when that plugin is **enabled** in Claude Code (settings `enabledPlugins`). A cloned marketplace under `~/.claude/plugins/marketplaces/` is just a catalog — its plugins stay dormant until enabled. `/doctor` and the startup info notice report how many are available but disabled. |
| A plugin you enabled isn't loading | Confirm it's listed truthy in `enabledPlugins` as `name@marketplace`, and that it isn't in `~/.claude/plugins/blocklist.json`. |
| Want to see why a fan-out routed the way it did | agent descriptions are the routing surface — inspect the "Available subagents" catalog in the session, and the dispatch tool calls in the transcript |

## 10. Verification status

- **Windows 11**: fully verified — the automated suite runs across three layers (per-subsystem
  unit tests, an offline whole-extension integration pass against the fixture projects, and an
  end-to-end suite that drives the **real Pi CLI** with a mock OpenAI-compatible model server; see
  [`doc/testing.md`](testing.md)) — plus live validation on a real ChatGPT/Codex subscription
  (skill slash command with argument substitution, description-routed subagent dispatch
  returning a locked-YAML verdict verbatim, worktree entry detected as `mode=worktree` by the
  project's own git-plumbing probe, `.worktreeinclude` seeding, `WorktreeCreate` hook).
- **Linux**: the code is platform-guarded and expected to work (POSIX is the simpler path for
  every Windows-special case), but has not yet been exercised in CI — run `npm test` on your
  Linux machine before relying on it there.

## 11. Example projects

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

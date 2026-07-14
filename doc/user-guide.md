# PiCC user guide

PiCC runs projects **authored for Claude Code — unchanged — on GPT/Codex models**, driven
from a personal ChatGPT/Codex subscription. It is an extension bundle on
[Pi](https://github.com/earendil-works/pi) (MIT, TypeScript): Pi supplies the agent loop, the
model abstraction, and the subscription auth; PiCC supplies Claude Code compatibility —
`CLAUDE.md` hierarchies, `.claude/` skills/agents/rules/commands, `settings.json` permissions
and hooks, worktree isolation, subagent fan-out, and plugin content.

## How it works (in one minute)

At startup PiCC reads your project's `.claude/` corpus and `CLAUDE.md` hierarchy into one
in-memory model. From then on, on Pi's own agent loop:

- **Every turn** it appends the assembled instruction set — root `CLAUDE.md`, auto memory,
  unconditional rules, the budgeted skill listing, and the subagent catalog — to the system
  prompt. Because the system prompt is rebuilt each turn, this is also what survives compaction.
- **Every tool call** passes through a guard that enforces `deny` rules and fires the project's
  hooks, and injects nested `CLAUDE.md` / path-scoped rules when you touch a matching file.
- **Skills** run either as `/slash` commands or via the model's `Skill` tool, with full argument,
  variable, and shell-injection processing — the body loads only on activation (progressive
  disclosure).
- **Subagents** dispatch via the `Agent` tool into fresh, isolated sessions and return their final
  message verbatim. A failed dispatch is reported as a loud failure naming the cause — never a
  silent empty success — and every run leaves a transcript on disk, shows live progress while it
  runs, records its token/cost, and can be resumed or steered via `SendMessage`. **Worktrees** swap
  the session's working directory so the project's own git tooling detects worktree mode.

Nothing is written to your project's tracked files. For the full design see
[`doc/architecture.md`](architecture.md); for the exact compatibility matrix see
[`doc/supported-features.md`](supported-features.md).

## 1. Requirements

- **Node.js ≥ 22.19** and npm (Node 20 does not work: Pi's bundled undici 8.x requires ≥ 22.19)
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
git clone <this-repo> picc
cd picc
npm install --ignore-scripts
npm link
```

`npm link` makes the global `picc` command available. Notes for Windows:

- If running `picc` in PowerShell fails with *"running scripts is disabled on this
  system"*, either call the cmd shim `picc.cmd` instead, or allow local scripts once:
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  ```
- **Git Bash must be installed** (it comes with Git for Windows). Pi's `bash` tool and most
  Claude Code projects' scripts assume bash; PiCC finds Git Bash automatically and never
  uses the WSL `bash.exe` stub in System32.

### Linux / macOS (bash or zsh)

```bash
git clone <this-repo> picc
cd picc
npm install --ignore-scripts
npm link    # may need: sudo npm link — or configure a user-level npm prefix
```

### Alternatives to `npm link` (any OS)

- Run without installing anything globally — from your target project directory:
  ```powershell
  node <path-to-picc>\bin\picc.mjs
  ```
  (forward slashes work too, in every shell)
- Or, if you already use Pi, load the extension directly:
  `pi -e <path-to-picc>/src/index.ts`
- Or add it permanently to Pi's config (`~/.pi/agent/settings.json`):
  ```json
  { "extensions": ["<path-to-picc>/src/index.ts"] }
  ```

## 3. Authenticate (spend your subscription)

Auth is Pi's, not ours, and is a one-time interactive step. Step by step (any shell):

1. Open a terminal in any directory and start the harness:
   ```powershell
   picc
   ```
   (or `node <path-to-picc>/bin/picc.mjs` if you skipped `npm link`)
2. In the input box at the bottom, type `/login` and press Enter.
3. Select **"ChatGPT Plus/Pro (Codex Subscription)"** with the arrow keys and press Enter.
4. Your browser opens an OpenAI login page (if not, Pi prints a URL to copy). Log in with the
   account holding your subscription and approve.
5. Back in the terminal, type `/model`, press Enter, and pick a GPT/Codex model
   (e.g. `openai-codex/gpt-5.5`).
6. Quit with Ctrl+C pressed twice.

Credentials are stored in `~/.pi/agent/auth.json` (`C:\Users\<you>\.pi\agent\auth.json` on
Windows) — in your user profile, **never inside any project repository**, and PiCC never
reads or copies them.

Notes:
- **Single account only.** Account pooling/credential sharing violates OpenAI ToS; personal
  single-account use is the supported mode.
- If the direct-backend path breaks (endpoint enforcement changes), the documented fallback is
  driving a signed-in `codex` CLI as a subprocess — see Pi's provider docs; PiCC works with
  any provider Pi can talk to.
- API keys also work: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.

## 4. Run a Claude Code project

```bash
cd /path/to/your-claude-project     # the one with CLAUDE.md and .claude/
picc
```

On startup PiCC loads, with standard Claude Code precedence (user → project → local →
managed):

| Artifact | Source |
|---|---|
| Instructions | `CLAUDE.md` (cwd ancestors up to the filesystem root, nested per-directory, `@import` expansion, `CLAUDE.local.md` siblings), `~/.claude/CLAUDE.md`, managed-policy CLAUDE.md (file or inline `claudeMd` settings key) |
| Memory | auto memory: `MEMORY.md` (first 200 lines / 25 KB) from the per-project memory dir under `~/.claude/projects/…/memory`, with conservative write-back — memory is written only when you explicitly ask it to remember something (see note below) — gated by `autoMemoryEnabled` / `autoMemoryDirectory` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY`; agent `memory:` frontmatter scopes likewise |
| Rules | `.claude/rules/**/*.md` (unconditional at start; `paths:`-scoped inject when you touch matching files) |
| Skills | `.claude/skills/**/SKILL.md` (+ `~/.claude/skills`), lazy-loaded; `.claude/commands/**/*.md` legacy commands (recursive, `sub:name`-qualified on collisions) |
| Agents | `.claude/agents/*.md` (+ user scope) plus the built-in `general-purpose`, `Explore`, and `Plan` types — dispatchable via the `Agent` tool |
| Settings | `.claude/settings.json`, `settings.local.json`, `~/.claude/settings.json`, managed policy |
| Hooks | `settings.json` `hooks` (+ plugin hooks, + skill- and agent-scoped `hooks:`) |
| Plugins | already-installed plugins from `~/.claude/plugins` + project-bundled `.claude-plugin/` |

> **Auto memory is conservative by default.** PiCC loads `MEMORY.md` every session but writes
> to it only when you explicitly ask it to remember something (e.g. "remember to…", "make a note
> that…"). This is a deliberate divergence from Claude Code, which also writes proactively — the
> conservative default keeps low-value entries from accreting in the memory that loads into every
> session. To restore Claude-Code-style eager writes on a project, add to that project's
> `CLAUDE.md`:
>
> ```markdown
> ## Memory
> Proactively record durable project facts to auto memory as you work — don't wait for me to
> ask. Keep MEMORY.md as the index, one topic per file, and prune stale entries.
> ```
>
> To opt in **without modifying the target project** (or across all your projects at once), put
> the same instruction in your user-scope `~/.claude/CLAUDE.md` instead — it composes into the
> same prompt and overrides the conservative default the same way.

Then use it like Claude Code:

- `/skill-name args` — run a user-invocable skill (slash command). Arguments substitute as
  `$ARGUMENTS`, 0-based positionals (`$0` is the first argument, `$ARGUMENTS[N]` equivalent),
  and named `$name`; `\$` escapes a literal dollar. Up to 5 leading `/skill` tokens stack in one
  message (`/skill-a /skill-b do XYZ` activates both; the trailing text becomes the last skill's
  arguments and stays as your request).
- the model activates skills itself via the `Skill` tool when a task matches a description
- the model dispatches subagents via the `Agent` tool (description-driven routing; the built-in
  `general-purpose`/`Explore`/`Plan` types complement project agents, a same-named project agent
  overrides a built-in, and an omitted `subagent_type` defaults to general-purpose).
  `run_in_background: true` (or an agent's `background: true` frontmatter) returns a task id
  immediately — results are polled/awaited via `TaskOutput` and stopped via `TaskStop`, and a
  background settlement is announced to the coordinator at its next turn without polling. A
  dispatch that dies on an API error is reported as a **loud, named failure** (with any partial
  output), not an empty success; a run stopped on purpose reports as **aborted**. The coordinator
  can address a finished subagent by its agent id with **`SendMessage`** to continue it (full prior
  context) or redirect a still-running background one. See *Observing subagents* below.
- `EnterWorktree`/`ExitWorktree` isolate work in `.claude/worktrees/<name>/` — the session's
  working directory really moves, so project scripts detect worktree mode via git plumbing
- parallel sessions: open a second terminal, `picc` again, enter a different worktree

### Observing subagents

Every subagent is now visible, both to you and to the coordinating model:

- **Transcript on disk.** Each dispatch leaves a JSONL transcript beside the main session's, under
  `<mainSessionFileBase>.subagents/<stamp>_<agentId>.jsonl` (in Pi's sessions dir,
  `~/.pi/agent/sessions/…`). The agent id is embedded in the filename and appears in the dispatch
  result, so you can locate a subagent's full turn-by-turn record without guessing. (These files
  accumulate like Pi's own session files — `cleanupPeriodDays` reaps orphaned *worktrees* but does
  not yet reap subagent transcripts.)
- **Live progress.** While a subagent runs, the UI shows which agent it is and what it is doing —
  the agent type and your dispatch description instead of a bare "Agent" box, a rolling tail of its
  recent tool calls / output lines, and explicit visibility of silent waits (API auto-retry).
  Pressing **Esc** cancels a running foreground dispatch (it reports as aborted — rendered in an
  error frame worded as aborted, not a distinct abort badge; the dedicated aborted badge is a
  background/next-turn surface) — this covers `Agent`/`Task` dispatches and a model-invoked
  `context: fork` (the `Skill` tool path), but not a *typed* `/forked-skill` expansion, which is
  not Esc-cancellable (a PiCC/Pi harness limitation: no abort signal reaches the input-hook stage). Pressing **Esc** while *awaiting* a background task only detaches
  the live view — the background task keeps running (retrieve it again with `TaskOutput`); Esc does
  not stop a background task.
- **Background tasks are observable too.** A `TaskOutput` call awaiting a still-running background
  dispatch now streams that same live view — a rolling activity tail and a current-activity line,
  updating as the background subagent works — then settles, *in the same call*, to a finished view:
  an outcome badge (completed / failed / aborted), the transcript path, and a per-subagent usage
  footer, matching what a completed foreground dispatch shows. A poll (`TaskOutput` with
  `wait: false`) shows the task's current status and last activity inside the same identifying frame.
  The task-start message and the awaiting/live, poll, and settled `TaskOutput` views carry the same
  identity components: the task id (`task-N`), displayed agent type, and stable `agent-<id>`, shown
  even for non-resumable one-shot builtins (the "resumable via `SendMessage`" hint appears only when
  the task actually is resumable). Their visual framing varies: the start block leads with
  `Agent(<type>) → background as task-N` (with the `agent-<id>` on a subline), while the
  live/poll/settled views use the same components in their identifying frame. This TaskOutput
  rendering is display-only: its completed verbatim result text is unchanged. The one boundary: a
  background task streams live only *while a `TaskOutput` call is awaiting it* — there is no
  always-on background dashboard.
- **`/usage`.** A per-subagent token/cost breakdown for the session: each dispatched agent's id,
  type, outcome, usage line, and transcript path, plus a subagents total. This is **subagent-scoped
  only** — a PiCC-additive view, not Claude Code's whole-session `/usage`/`/cost` (the Pi extension
  API exposes no parent-session cost, so the main agent's own spend is not shown).
- **Compact lifecycle identity.** A `task-N` identifies one background run; an `agent-<id>`
  identifies the agent and is the reliable correlation key across resume. Resuming keeps that agent
  id but creates a new task id. Model-visible `TaskStop` results (for every stop outcome), pushed
  settlement notices, and `SendMessage` resume acknowledgments identify the work with
  `Task(task-N) · Agent(<type>) · agent-<id>`, though punctuation and surrounding framing can vary.
  TaskStop and settlement use the background task record's stored display type. A fresh dispatch
  record normally stores the requested/display label, which can differ from the resolved registry
  definition after fallback or case-insensitive matching. A resumed task record and its resume
  acknowledgment instead use the clean resolved registry name. The stable agent id—not the type
  text—is therefore the reliable correlation key; broader canonical-type plumbing remains deferred.
  This concise wording contract is PiCC-defined, not verified as exact Claude Code wording. Tool
  schemas, lifecycle and stop behavior, settlement delivery, structured results, output framing, and
  limits are unchanged.
- **`SendMessage` (resume / steer).** The coordinator can address a finished subagent by its agent
  id and continue it with its context intact (it resumes in the background under the same stable id
  and a new task id), or redirect a still-running background one. Honest limitations, by design:
  - **No cross-restart resume** — the dispatch registry is process-lifetime; after you quit and
    relaunch `picc`, a prior agent id no longer resolves.
  - **Stopped agents remain resumable in PiCC** — after `TaskStop`, PiCC currently allows a
    `SendMessage` resume; the Claude Code 2.1.x reference refuses stopped-agent resume.
  - **TaskStop addresses tasks only by `task_id`** — current Claude 2.1.198+ also accepts an agent
    id or name.
  - **Steering reaches only background dispatches** — a foreground `Agent` call blocks the
    coordinator's turn, so there is no moment to steer it; resume works once any dispatch settles.
  - **Idle-parent delivery is next-turn** — an idle coordinator learns of a background settlement
    when the conversation next continues; PiCC v1 does not re-invoke an idle agent.
  - **`context: fork` / override dispatches are not resumable** — their restricted definition can't
    be re-derived by name, so they are deliberately refused.

## 5. Control surface (project-external)

### Commands

| Command | What it does |
|---|---|
| `/skills` | List every loaded skill — invocable-as-slash-command, model-invocable-only, and user-only — with descriptions and source (project / user / plugin) |
| `/agents` | List every subagent available for dispatch — project/user agents and the built-in `general-purpose`/`Explore`/`Plan` types — with tools, read-only marker, model, and worktree-isolation |
| `/doctor` | Full compatibility breakdown for this project (generated from the capability registry) |
| `/compat [suppress\|show]` | Show the consolidated compatibility notice; suppress/unsuppress it |
| `/usage` | Per-subagent token/cost breakdown for this session (each dispatch's id, type, outcome, usage, transcript path) plus a subagents total. **Subagent-scoped only** — a PiCC-additive surface, *not* Claude Code's whole-session `/usage`/`/cost`: the Pi extension API exposes no parent-session cost, so the main agent's own spend is not included |
| `/quota` | Context usage + provider rate-limit/quota headers from the last response (best-effort) |
| `/model`, `/login`, `/settings` | Pi built-ins: model switching, auth, Pi settings |

**Slash autocomplete.** Every user-invocable skill appears in the `/` menu with its description and
argument hint — type `/` to browse, or start typing a name to filter. Selecting one expands the
skill into your turn (with argument, variable, and shell-injection processing) exactly as Claude
Code does. The full instruction body is loaded only on invocation (progressive disclosure), so the
menu stays fast even with dozens of skills.

### Harness configuration

Lives **outside the project** (`~/.picc/config.json`) or in the harness-owned, gitignored
`<project>/.claude/.picc/config.json` (project overrides user; the harness never touches
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
| `PICC_CLAUDE_USER_DIR` | Override the user-scope Claude dir (default `~/.claude`) — useful for isolated profiles or CI |
| `BRAVE_API_KEY` | Use the Brave Search API for `WebSearch` (otherwise a keyless DuckDuckGo fallback is used) |
| `PI_CODING_AGENT_DIR` | Pi's own config dir override (auth, models, Pi settings) |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Highest-priority model override for every subagent dispatch (`inherit` = unset) |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | Disable auto-memory loading (also: `autoMemoryEnabled: false` in settings) |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | `run_in_background` dispatches run in the foreground instead |
| `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` | Remove the built-in `Explore`/`Plan` agent types (`general-purpose` always stays) |
| `SLASH_COMMAND_TOOL_CHAR_BUDGET` | Override the startup skill-listing character budget |

## 6. Security & permission posture

Deliberately partial, by design (see the plan §6):

- **Default permissive** — no per-command prompts (matches auto-mode usage).
- **`permissions.deny` is a hard, non-interactive block** — the real safety valve. Full matcher
  grammar: `Bash(git *)` (shell-operator aware — `git status && rm -rf /` does **not** match;
  space-before-`*` is a word boundary, so bare `git` matches but `github` never does),
  `Read/Edit(glob)` (Windows paths normalized — `//c/**` covers `C:\…`, case-insensitively),
  `WebFetch(domain:*)`, `Agent(type)`, `Skill(name)`, `mcp__server__tool`.
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
bash+powershell, argument substitution with 0-based `$N` and `\$` escaping, stacked slash
invocations), rules, agents — built-in `general-purpose`/`Explore`/`Plan` plus project/user agents
— with nested subagent dispatch (default depth cap 5), loud classified failure semantics
(failed/aborted, never an empty success) with partial-output preservation, on-disk subagent
transcripts, live progress rendering, and per-subagent usage accounting, agent-scoped hooks,
worktrees (incl. `.worktreeinclude`, Windows-tolerant
removal), 13 hook events with the full stdin/stdout contract (Claude matcher semantics, parallel
dispatch, async handlers), CLAUDE.md hierarchy to the filesystem root + `@import` + managed policy,
settings toggles, deny rules (incl. Windows path normalization), tool gating,
`WebFetch`/`WebSearch`/`Grep`/`Glob`/`Task*` tools, installed-plugin content, compaction
preservation under Claude's carryover budgets.

**Partial (works within a named limit):** background subagent dispatch (`run_in_background` /
`background: true` + `TaskOutput`/`TaskStop`, with settlement pushed to the coordinator at its next
turn) — but PiCC defaults dispatches to the **foreground**, whereas Claude Code 2.1.198 runs
subagents background-by-default, so an implicit-concurrency fan-out runs serially unless background
is requested; and `SendMessage` resume/steer — no cross-restart resume, steering reaches only
background dispatches, idle-parent delivery is next-turn, and `context: fork`/override dispatches
are non-resumable. `maxTurns` is a best-effort cap. Auto memory (`MEMORY.md`) and agent `memory:`
scopes load with full parity, but writes are conservative by default — memory is written only on
an explicit request to remember, a deliberate divergence from Claude Code's proactive writes (opt
into eager writes via `CLAUDE.md`).

**Degraded no-op (visible, never crashing):** MCP servers/tools, `ask`/`allow`/permission modes,
plan mode, `AskUserQuestion`, checkpointing/rewind, output styles, agent teams, background
*shells* (`BashOutput`/`KillShell`), LSP, computer use. Unknown/future fields degrade safely and
are reported as unassessed.

**Not built:** plugin install/marketplace machinery; mid-flight live-session handoff between
harnesses (worktrees/git are fully interoperable — a worktree created under Claude Code can be
re-entered here and vice versa).

## 8. Windows specifics

Everything runs natively on Windows 11 — no WSL required. The points below are Windows-only
behaviors worth knowing:

- **Git Bash is required, and found automatically.** Pi's `bash` tool and most Claude Code
  projects' scripts assume bash. PiCC locates the real Git Bash (`Program Files\Git\bin\bash.exe`
  and friends) and **skips the System32 WSL `bash.exe` stub**, which otherwise fails with
  `WSL_E_DEFAULT_DISTRO_NOT_FOUND` when no WSL distro is installed. The resolved shell is used for
  both hooks and `` !`cmd` `` skill injection. Install Git for Windows if `bash` isn't on PATH.
- **UTF-8 subprocess default.** Spawned interpreters (notably Python) default their I/O to the
  legacy code page (cp1252), which can't encode Unicode the model routinely prints (e.g. `→`),
  causing `UnicodeEncodeError`. PiCC sets UTF-8 defaults (`PYTHONIOENCODING`/`PYTHONUTF8`,
  `LANG`/`LC_ALL`) for child processes **only when you haven't set them** — an explicit project or
  user `env` value always wins.
- **MSYS argument-mangling caveat (slash commands via `-p`).** Under **Git Bash**, MSYS rewrites an
  argument that looks like a Unix path — so `picc -p "/greet Ada"` gets the leading `/greet`
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
| "could not resolve the Pi CLI" | `npm install` inside the PiCC checkout |
| Skill shell injection prints `[shell execution disabled: …]` | project set `disableSkillShellExecution`; that's the project's intent |
| A tool you expected is missing | check `/doctor` — the project may gate it via agent `tools:` or a deny rule |
| Hooks don't fire | check `disableAllHooks` in settings; `/doctor` lists unsupported events/handler types |
| Startup notice keeps appearing | `/compat suppress` (per-project, stored in `.claude/.picc/`) |
| Unexpected skills/agents from plugins | PiCC loads a plugin's content only when that plugin is **enabled** in Claude Code (settings `enabledPlugins`). A cloned marketplace under `~/.claude/plugins/marketplaces/` is just a catalog — its plugins stay dormant until enabled. `/doctor` and the startup info notice report how many are available but disabled. |
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
picc
> /greet Ada
> have the reviewer agent review src/hello.js
```

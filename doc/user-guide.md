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
  message verbatim; a failed dispatch is a loud failure naming the cause, never a silent empty
  success. **Worktrees** swap the session's working directory so the project's own git tooling
  detects worktree mode.

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

One line per step — paste them one at a time. They work identically in **PowerShell**, **cmd**, and
**bash** (nothing in this guide uses `&&` chaining, which Windows PowerShell 5.1 does not support).

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
| Memory | auto memory: `MEMORY.md` from the per-project memory dir under `~/.claude/projects/…/memory`; gated by `autoMemoryEnabled` / `autoMemoryDirectory` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY`; agent `memory:` frontmatter scopes likewise |
| Rules | `.claude/rules/**/*.md` (unconditional at start; `paths:`-scoped inject when you touch matching files) |
| Skills | `.claude/skills/**/SKILL.md` (+ `~/.claude/skills`), lazy-loaded; `.claude/commands/**/*.md` legacy commands (recursive, `sub:name`-qualified on collisions) |
| Agents | `.claude/agents/*.md` (+ user scope) plus the built-in `general-purpose`, `Explore`, and `Plan` types — dispatchable via the `Agent` tool |
| Settings | `.claude/settings.json`, `settings.local.json`, `~/.claude/settings.json`, managed policy |
| Hooks | `settings.json` `hooks` (+ plugin hooks, + skill- and agent-scoped `hooks:`) |
| Plugins | already-installed plugins from `~/.claude/plugins` + project-bundled `.claude-plugin/` |

> **Auto memory is conservative by default.** PiCC loads `MEMORY.md` every session but writes to
> it only when you explicitly ask it to remember something (e.g. "remember to…"). This is a
> deliberate divergence from Claude Code, which also writes proactively. To restore Claude-Code-style
> eager writes, add an instruction like this to the project's `CLAUDE.md` — or, to opt in without
> modifying the target project, to your user-scope `~/.claude/CLAUDE.md`:
>
> ```markdown
> ## Memory
> Proactively record durable project facts to auto memory as you work — don't wait for me to
> ask. Keep MEMORY.md as the index, one topic per file, and prune stale entries.
> ```

Then use it like Claude Code:

- `/skill-name args` — run a user-invocable skill (slash command). Arguments substitute as
  `$ARGUMENTS`, 0-based positionals (`$0` is the first argument), and named `$name`; `\$` escapes a
  literal dollar. Up to 5 leading `/skill` tokens stack in one message (`/skill-a /skill-b do XYZ`
  activates both; the trailing text becomes the last skill's arguments and stays as your request).
- the model activates skills itself via the `Skill` tool when a task matches a description
- the model dispatches subagents via the `Agent` tool (description-driven routing; an omitted
  `subagent_type` defaults to `general-purpose`, and a same-named project agent overrides a
  built-in). Dispatch runs in the **background by default**: it returns a task id immediately, so
  several dispatches in one turn run in parallel, and results are collected with `TaskOutput` and
  stopped with `TaskStop`. Pass `run_in_background: false` for a synchronous inline result (an
  agent's own `background: true` frontmatter still wins). The special `subagent_type: "fork"`
  **inherits the parent conversation** instead of starting fresh (see `CLAUDE_CODE_FORK_SUBAGENT`
  under *Environment variables* for when inheritance is honored).
- `EnterWorktree`/`ExitWorktree` isolate work in `.claude/worktrees/<name>/` — the session's
  working directory really moves, so project scripts detect worktree mode via git plumbing
- parallel sessions: open a second terminal, `picc` again, enter a different worktree

In the interactive TUI, safely recognized settled tool successes use compact rows. The configured
`app.tools.expand` action (Ctrl+O by default) reveals their native detail. Noncompact paths retain
native detail where safe; otherwise they show bounded diagnostics. HTML export, non-interactive
output, model-facing results, and execution are unchanged.

### Observing subagents

Every subagent is visible, both to you and to the coordinating model:

- **Transcript on disk.** Each dispatch leaves a JSONL transcript under
  `<mainSessionFileBase>.subagents/<stamp>_<agentId>.jsonl` in Pi's sessions dir
  (`~/.pi/agent/sessions/…`). The agent id appears in the dispatch result, so you can find the run's
  full record without guessing. These files are not reaped automatically.
- **Status panel.** While agents run, a panel below the input shows the whole agent tree live —
  no `TaskOutput` await needed. One row per agent, nested children indented: a status bubble
  (spinner while running; `●` done, `✗` failed, `■` stopped), the agent type (tinted with the
  agent's `color:` frontmatter when set), your dispatch description, elapsed time, and token usage
  once known (blank until then — never a fake zero). Finished rows linger briefly — ~10 s
  for successes, ~60 s for failures and stops — then leave on their own. That auto-expiry is a deliberate PiCC
  deviation: Claude Code keeps finished agents listed until dismissed. An expired row is not lost:
  `alt+a` reopens the panel with every finished agent still listed, and the condensed record in
  the chat (below) arrives once the conversation continues. While the panel has keyboard focus,
  no row expires on its own (dismissing with `d` still removes). When several agents run at once,
  a one-time hint names the entry key.
- **Panel navigation (`alt+a`).** Press `alt+a` to focus the panel; a `❯` marker shows the
  selection, and the footer hint lists the keys: `↑↓ select · enter open · x stop · X stop all ·
  d dismiss · esc close`. Stopping from the panel is **background-only** — a foreground agent is
  cancelled with Esc in the editor, as before (that cancels the whole turn). `X` (stop-all) asks
  for a second press within ~3 s to confirm. A user-initiated stop is **permanent**: a
  user-stopped agent cannot be steered or resumed afterwards, not even by the model.
- **Drill-down.** Enter opens the selected agent: its initial prompt (collapsed; `ctrl+p`
  expands), bounded structured live detail (auto-following; `↑↓` scrolls, scrolling back stops
  the follow), and — once settled — its final answer. `ctrl+x` stops a running background agent
  (on a settled one it dismisses). While a background agent runs, type a steering message
  directly into the drill-down and press Enter to send; it is delivered before the agent's next
  model call (the confirmation is optimistic — a delivery failure replaces it). **Caveat:**
  drill-down steering does not fire the project's `UserPromptSubmit` hooks — a PiCC decision.
  Esc steps back one layer: drill-down → list → editor (with typed steer text, the first Esc
  clears the text; where steering is unavailable — foreground, one-shot, user-stopped — the view
  says so instead of offering an input line).
- **Condensed transcript records.** Subagent output does not stream into the chat; selected-agent
  detail owns the live view. Each depth-1 normal-path result replaces its pending call in the same
  tool row; background completion adds one collapsed record — outcome, duration, tokens — that
  the configured `app.tools.expand` action (Ctrl+O by default) expands to the retained output, if any,
  plus the transcript path, usage, and warnings. Background
  agents get their record even if never awaited; an agent that settles while you are away from the prompt gets it
  when the conversation next continues (the record rides the next turn). A later `TaskOutput`
  collection adds only a minimal reference line, never a duplicate. Nested agents (depth ≥ 2) get
  no record of their own — they keep Pi's default notice box and appear in the panel tree and
  their parent's transcript only.
- **Esc** cancels a running *foreground* dispatch (it reports as aborted). Esc while *awaiting* a
  background task only detaches the wait — the task keeps running; retrieve it with `TaskOutput`.
- **`SendMessage`** continues a finished subagent with its context intact, or redirects a running
  background one, addressed by its `agent-<id>`. Resuming keeps that agent id and creates a new task
  id, so the agent id is the reliable correlation key. Resume is process-lifetime only — after you
  quit and relaunch `picc`, a prior agent id no longer resolves — fork dispatches are never
  resumable, and a user-stopped agent refuses resume and steering permanently.
- **Interactive TUI only.** The panel, drill-down, and condensed records exist only in the
  interactive TUI; print and RPC runs keep their previous subagent output unchanged.

### Subagent dispatch controls (`.claude/settings.json`)

Three project settings shape subagent dispatch, under a `subagents` key (they also read at user
scope; project overrides user). These are PiCC extensions with no Claude-settings equivalent.

| Key | Default | Effect |
|---|---|---|
| `subagents.enabled` | `true` | Gates **all** subagent delegation. `false` (or the inverse alias `disableSubagents: true`) removes `Agent`/`Task` from the main session entirely. |
| `subagents.maxDepth` | `1` | Caps subagent **nesting** depth. Default `1` = main-session-only. Raise to `2..5` to let each further generation dispatch. |
| `subagents.concurrency` | `4` | Caps parallel subagent fan-out. |

The main conversation is **depth 0**; the subagents it dispatches are depth 1. So the default
`maxDepth: 1` allows normal fan-out but blocks a subagent from dispatching its own.

**The two "off" states are different.** If your goal is "no runaway recursion," use `maxDepth` —
`enabled: false` removes delegation entirely, including ordinary depth-1 fan-out.

## 5. Control surface (project-external)

### Commands

| Command | What it does |
|---|---|
| `/skills` | List every loaded skill — invocable-as-slash-command, model-invocable-only, and user-only — with descriptions and source (project / user / plugin) |
| `/agents` | List every subagent available for dispatch — project/user agents and the built-in `general-purpose`/`Explore`/`Plan` types — with tools, read-only marker, model, and worktree-isolation |
| `/doctor` | Full compatibility breakdown for this project (generated from the capability registry) |
| `/compat [suppress\|show]` | Show the consolidated compatibility notice; suppress/unsuppress it |
| `/usage` | Per-subagent token/cost breakdown for this session, plus a subagents total. **Subagent-scoped only** — a PiCC-additive surface, *not* Claude Code's whole-session `/usage`/`/cost`: the Pi extension API exposes no parent-session cost, so the main agent's own spend is not included |
| `/quota` | Context usage + provider rate-limit/quota headers from the last response (best-effort) |
| `/model`, `/login`, `/settings` | Pi built-ins: model switching, auth, Pi settings |

**Slash autocomplete.** Every user-invocable skill appears in the `/` menu with its description and
argument hint — type `/` to browse, or start typing a name to filter. Selecting one expands the
skill into your turn exactly as Claude Code does.

### Harness configuration

Lives **outside the project** (`~/.picc/config.json`) or in the harness-owned, gitignored
`<project>/.claude/.picc/config.json` (project overrides user; the harness never touches
tracked project files):

```json
{
  "model": "openai-codex/gpt-5.5",
  "effort": "high",
  "steering": {
    "openai/*": "When a skill specifies a locked output format, reproduce it exactly. Prefer dispatching subagents over doing everything inline when the skill says to fan out."
  },
  "effortMap": { "ultra": "max" },
  "suppressCompatNotice": false,
  "proactiveCompactPercent": 85,
  "clipMaxTokens": 20000
}
```

- `model` / `effort` — defaults applied at session start (effort maps onto Pi thinking levels).
- `steering` — the **model-steering layer**: per-model-pattern system-prompt guidance nudging
  GPT toward Claude-like behavior, without editing the project. Patterns are globs over
  `provider/modelId`; all matching entries are appended.

  Steering is appended *after* PiCC's built-in conventions, so it is also your lever over them: you
  cannot delete their text, but a contrary entry later in the prompt steers the model against them
  (later guidance tends to win — a nudge, not a guarantee). The two built-ins you may want to adjust:
  PiCC pushes richer, repo-style-matching commit messages, and it puts the **main session** (not
  dispatched subagents) in a collaborative-planning posture — ground in the repo, surface the real
  choices, delegate context-heavy investigation, then implement once scope is agreed. To tone either
  back:

  ```json
  "steering": {
    "openai/*": "Keep commit messages to a one-line subject; no body unless I ask. Skip the collaborative back-and-forth; restate my request briefly and proceed unless something is genuinely blocking."
  }
  ```
- `effortMap` — extends the mapping from Claude `effort:` values / prose ("apply maximum
  reasoning effort") to thinking levels.
- `proactiveCompactPercent` — percent of the model's context window at which PiCC
  proactively triggers Pi's own compaction, keeping the session off the ~99% edge where an
  oversized output or a network blip can be fatal. **0–100 scale** (e.g. `85`, not `0.85`).
  **Default `85`**; valid range **50–95**. An out-of-range or malformed value falls back to
  the default with a diagnostic (never disables compaction). Lower it if a session still
  rides too close to the window; raise it to compact later. This is the extension-reachable
  margin lever — Pi's *hard* `reserveTokens` is a Pi settings-file matter, not set here.
  If both user and project scopes set this knob and the project value is malformed, the safe
  default is used (not the still-valid user value).
- `clipMaxTokens` — per-tool-result token budget above which a single oversized tool-result
  text block is clipped (head + tail kept, middle replaced by a model-visible marker naming
  what was omitted and how to retrieve it). A backstop against pathological outputs, **not** a
  trimmer: **default `20000`** tokens (≈80k chars) is generous, so everyday results — a ~20k-char
  diff — pass through untouched. Valid **integer ≥ 1000**; a malformed value falls back to the
  default with a diagnostic. As with `proactiveCompactPercent`, if both user and project scopes
  set this knob and the project value is malformed, the safe default is used (not the still-valid
  user value).

### Environment variables

| Variable | Effect |
|---|---|
| `PICC_CLAUDE_USER_DIR` | Override the user-scope Claude dir (default `~/.claude`) — useful for isolated profiles or CI |
| `BRAVE_API_KEY` | Use the Brave Search API for `WebSearch` (otherwise a keyless DuckDuckGo fallback is used) |
| `PI_CODING_AGENT_DIR` | Pi's own config dir override (auth, models, Pi settings) |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Highest-priority model override for every subagent dispatch (`inherit` = unset) |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | Disable auto-memory loading (also: `autoMemoryEnabled: false` in settings) |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Force **every** `Agent`/`Task` dispatch to the foreground (background is otherwise the default). `SendMessage` resume is inherently async and is **not** governed by this switch |
| `CLAUDE_CODE_FORK_SUBAGENT` | Gate `subagent_type: "fork"` dispatch (inherit the parent conversation instead of starting fresh): `1` forces it on, `0` off. **Left unset it is enabled** — a deliberate PiCC choice. Inheritance is honored only for a **main-session** dispatch; nested, print-mode, and `isolation: worktree` forks run with fresh context and say so on the result |
| `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` | Remove the built-in `Explore`/`Plan` agent types (`general-purpose` always stays) |
| `SLASH_COMMAND_TOOL_CHAR_BUDGET` | Override the startup skill-listing character budget |

## 6. Security & permission posture

PiCC's posture is deliberately partial: it runs permissive by default, enforces `permissions.deny`
and agent `tools:` gating for real, and parses-and-reports the rest rather than enforcing it. The
startup notice and `/doctor` call out every safety-relevant divergence — never silent. For *why* it
is drawn this way, see "Security & permission posture" in
[`doc/architecture.md`](architecture.md).

What that means when you write rules:

- **`permissions.deny` is your safety valve** — a hard, non-interactive block. Matchers:
  `Bash(git *)` (shell-operator aware — `git status && rm -rf /` does **not** match; space-before-`*`
  is a word boundary, so bare `git` matches but `github` never does), `Read/Edit(glob)` (Windows
  paths normalized — `//c/**` covers `C:\…`, case-insensitively), `WebFetch(domain:*)`,
  `Agent(type)`, `Skill(name)`, `mcp__server__tool`.
- **Agent `tools:` gating is your primary control** — a read-only reviewer cannot write; an agent
  without web tools cannot fetch.
- **Do not rely on `allow` / `ask` or permission modes to stop anything** — they are reported, not
  enforced.

**Three rules for writing a `deny` that actually holds.** Matching is on the call's **path**
argument, which makes it best-effort — Claude Code's own limit, not a PiCC gap:

1. **Confidentiality ≠ integrity.** A scoped `deny: Read(<path>)` also blocks `Grep`, `Glob`,
   `NotebookRead`, `Edit`, and `MultiEdit` on a matching path — but **not** `Write` or
   `NotebookEdit`. To make a path immutable, add `deny: Edit(<path>)` **and** `deny: Write(<path>)`.
2. **Pathless read calls aren't matched.** `Grep {}` has no path for the matcher to test, yet its
   results can surface protected content. Only a **bare** `deny: Read` forecloses that — at the cost
   of removing `Read`/`Grep`/`Glob`/`NotebookRead` entirely. It does **not** also strip `Edit`/
   `MultiEdit`; the cross in rule 1 applies to a path-scoped rule only.
3. **A shell read needs its own `Bash(...)` deny.** `Bash(cat secrets/x)` is not covered by any
   `Read` rule.

## 7. What is and isn't supported

The capability registry is the single source of truth, and is what `/doctor` renders. The full
table — every tool, hook event, setting, frontmatter field, and feature with its tier, and the
exact limit named for each partial — is in [`doc/supported-features.md`](supported-features.md),
generated from that registry so it cannot drift. The shape of the answer:

- **Full:** skills, rules, agents (project/user + the built-ins), worktrees, most hook events with
  the full stdin/stdout contract, the CLAUDE.md hierarchy + `@import`, settings toggles, deny rules,
  tool gating, `WebFetch`/`WebSearch`/`Grep`/`Glob`, installed-plugin content, and compaction
  preservation.
- **Partial (works within a named limit):** background subagent dispatch with `TaskOutput`/`TaskStop`;
  `SendMessage` resume/steer; `subagent_type: "fork"`; nested (depth ≥ 2) fan-out, off by default;
  auto-memory writes; managed/enterprise policy (honored where trivially present, otherwise
  degrade-safe); `maxTurns`.
- **Degraded no-op (visible, never crashing):** MCP servers/tools, `ask`/`allow`/permission modes,
  plan mode, `AskUserQuestion`, checkpointing/rewind, output styles, agent teams, background
  *shells* (`BashOutput`/`KillShell`), LSP, computer use, `NotebookRead` (retired — notebook
  reading is merged into `Read`, which renders `.ipynb` cell-aware; the name stays a read-family
  gating token) — and a handful of hook events that are
  parsed but never fired (the matrix marks which). ⚠ `PermissionRequest` is one of them, so it is
  **not** a gate — nothing fires it under the default-permissive posture. Unknown/future fields
  degrade safely and are reported as unassessed.
- **Not built:** plugin install/marketplace machinery; mid-flight live-session handoff between
  harnesses (worktrees and git themselves are fully interoperable — a worktree created under Claude
  Code can be re-entered here and vice versa).

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
| Session died at high context / "input exceeds the context window" | Lower `proactiveCompactPercent` in `.claude/.picc/config.json` so PiCC compacts earlier (see Harness configuration above) |
| `picc -p` finished but a subagent's output never appeared | Background is the default and a one-shot print run has no next turn to deliver it on. Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for scripted runs, or collect with `TaskOutput` before the run ends. |
| Subagents can't spawn subagents / nested fan-out flattened | PiCC defaults to **main-session-only** (`subagents.maxDepth: 1`) — subagents don't recurse by default. Raise `subagents.maxDepth` to `2..5` in `.claude/settings.json`; see "Subagent dispatch controls" above. `/doctor` also shows the current nesting posture. |
| Unexpected skills/agents from plugins | PiCC loads a plugin's content only when that plugin is **enabled** in Claude Code (settings `enabledPlugins`). A cloned marketplace under `~/.claude/plugins/marketplaces/` is just a catalog — its plugins stay dormant until enabled. `/doctor` and the startup info notice report how many are available but disabled. |
| A plugin you enabled isn't loading | Confirm it's listed truthy in `enabledPlugins` as `name@marketplace`, and that it isn't in `~/.claude/plugins/blocklist.json`. |
| Want to see why a fan-out routed the way it did | agent descriptions are the routing surface — inspect the "Available subagents" catalog in the session, and the dispatch tool calls in the transcript |
| Agent finished, its panel row is gone, and no record shows in the chat | Press `alt+a` — finished agents stay reachable in the panel after their rows expire. Or continue the conversation: the condensed record rides the next turn. |

## 10. Verification status

- **Windows 11**: fully verified — the automated suite (see [`doc/testing.md`](testing.md)) plus
  live validation on a real ChatGPT/Codex subscription, covering slash commands with argument
  substitution, description-routed subagent dispatch, worktree entry detected as `mode=worktree` by
  a project's own git-plumbing probe, `.worktreeinclude` seeding, and hooks.
- **Linux**: the code is platform-guarded and expected to work (POSIX is the simpler path for
  every Windows-special case), but has not yet been exercised in CI — run `npm test` on your
  Linux machine before relying on it there.

## 11. Example projects

Two runnable fixtures ship in `examples/`:

- **`examples/hello-claude`** — a minimal project (one skill, one agent, rules, hooks, deny
  rules) for a first run.
- **`examples/full-surface`** — the conformance fixture exercising the whole supported surface
  (nested subagents, path-scoped rules, `@import` chains, worktree seeding, hook events,
  degradation of unknown features). Its README maps every feature to a canary string.

```bash
cd examples/hello-claude
picc
> /greet Ada
> have the reviewer agent review src/hello.js
```

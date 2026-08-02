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

### Source checkout with a global command

These commands work in PowerShell, cmd, and POSIX shells:

```powershell
git clone https://github.com/ArneDeutsch/PiCC.git
cd PiCC
npm run setup
```

`npm run setup` installs the locked dependencies and globally links that checkout, so edits and
pulls continue to drive the `picc` command. The npm global prefix must be writable. Configure a
user-level prefix rather than running the setup as an administrator.

On Windows:

- If running `picc` in PowerShell fails with *"running scripts is disabled on this
  system"*, either call the cmd shim `picc.cmd` instead, or allow local scripts once:
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  ```
- **Git Bash must be installed** (it comes with Git for Windows). Pi's `bash` tool and most
  Claude Code projects' scripts assume bash; PiCC finds Git Bash automatically and never
  uses the WSL `bash.exe` stub in System32.

### Published package

Once PiCC is published, install the global command without a source checkout:

```powershell
npm install --global picc
```

### No global link

- Contributors and users without a writable npm global prefix can run `npm ci` in the checkout,
  then launch it from the target project directory:
  ```powershell
  node <path-to-PiCC>/bin/picc.mjs
  ```
- Or, if you already use Pi, load the extension directly:
  `pi -e <path-to-PiCC>/src/index.ts`
- Or add it permanently to Pi's config (`~/.pi/agent/settings.json`):
  ```json
  { "extensions": ["<path-to-picc>/src/index.ts"] }
  ```

### Check and update PiCC

`picc --version` reports the PiCC version, embedded Pi version, and whether PiCC is running from a
source checkout or an installed package. `picc update --check` reports the current state without
changing the installation; a global npm installation asks npm for the current published version.
The update path depends on who owns the installation:

- **Source checkout / global link:** `picc update` first requires a clean `git status`, using your
  normal Git configuration and global ignores. It then runs `npm ci --ignore-scripts --no-audit
  --no-fund` and revalidates the four coordinated Pi packages. It never pulls or changes tracked
  source; update that through your normal reviewed Git workflow first.
- **Global npm installation:** PiCC updates itself only when its package root is contained by npm's
  reported global root. The npm child inherits your proxy, CA, registry, and other npm settings.
  Exit active sessions before updating.
- **Other installed forms:** PiCC does not guess which package manager or parent project owns the
  files. It prints the command or owner guidance to use and makes no changes.

Pi is a coordinated dependency of the `picc` product; do not update the nested Pi packages
independently. `/picc-update` repeats installation-aware guidance and never changes the running
installation. It is available only when the extension recognizes a direct launcher lineage; that
lineage check is not authentication.

Deliberately hosting PiCC through an external Pi (`pi -e <path-to-PiCC>/src/index.ts`) leaves update
ownership with that Pi installation. PiCC does not register `/picc-update` there, and Pi's native
update behavior remains available. A project skill named `/update` is likewise independent and is
never shadowed by PiCC.

If core initialization fails, the task was not sent. Check or update through the installation
owner. For a direct PiCC launch, `/picc-update` or `picc update --check` are examples. Restart PiCC,
then use `/doctor` and the reported cause if the failure persists.

## 3. Authenticate (spend your subscription)

Auth is Pi's, not ours, and is a one-time interactive step. Step by step (any shell):

1. Open a terminal in any directory and start the harness:
   ```powershell
   picc
   ```
   (or `node <path-to-PiCC>/bin/picc.mjs` if you did not install or link the command)
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

On startup PiCC loads these Claude Code artifacts. Paths beginning with `~/.claude` below are for
the default user profile; see [Environment variables](#environment-variables) for the active
user-profile base when an override is selected.

| Artifact | Source |
|---|---|
| Instructions | `CLAUDE.md` (cwd ancestors up to the filesystem root, nested per-directory, `@import` expansion, `CLAUDE.local.md` siblings), `~/.claude/CLAUDE.md`, managed-policy CLAUDE.md (file or inline `claudeMd` settings key) |
| Memory | auto memory: `MEMORY.md` from the per-project memory dir under `~/.claude/projects/…/memory`; gated by `autoMemoryEnabled` / `autoMemoryDirectory` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY`; agent `memory:` frontmatter scopes likewise |
| Rules | `.claude/rules/**/*.md` (unconditional at start; `paths:`-scoped inject when you touch matching files) |
| Skills | `.claude/skills/**/SKILL.md` (+ `~/.claude/skills`), lazy-loaded; `.claude/commands/**/*.md` legacy commands (recursive, `sub:name`-qualified on collisions) |
| Agents | `.claude/agents/*.md` (+ user scope) plus the built-in `general-purpose`, `Explore`, and `Plan` types — dispatchable via the `Agent` tool |
| Settings | `.claude/settings.json`, `settings.local.json`, `~/.claude/settings.json`, managed policy |
| Hooks | `settings.json` `hooks` (+ plugin hooks, + skill-scoped `hooks:`); agent-scoped hooks apply to non-plugin agents, while plugin agents strip them |
| MCP servers | native Claude user/project-local state + `.mcp.json` + the PiCC settings `mcpServers` extension; source-specific approval and disablement apply |
| Plugins | enabled qualified identities with matching exact records in imported Claude installed state |

### Installed plugins

PiCC loads plugin content only when `enabledPlugins` contains a literal boolean `true` for the
qualified `name@marketplace` identity **and** imported Claude installed state supplies a matching
exact installation record applicable to the current project. Enablement chooses an identity; it cannot create
an installation or authorize a root. `CLAUDE_CODE_PLUGIN_CACHE_DIR` adds one eligible cache base;
each path-delimited `CLAUDE_CODE_PLUGIN_SEED_DIR` entry adds its `<seed>/cache` directory. A base is
eligible only when it resolves to an existing accessible directory. Both still require an exact
imported record and cannot authorize executable content by themselves. Catalog entries,
cache presence without a record,
repository-bundled `.claude-plugin/` content, and development roots likewise provide no
executable-root authority. Repository settings may therefore enable an applicable identity that was
installed separately, but cloning a repository cannot make its bundled plugin code executable.
Development roots remain inert because PiCC has no external development-trust channel. See the
generated [capability matrix](supported-features.md) for exhaustive support details.

PiCC validates the selected installed root and component paths before folding content into the
project model. Missing, unreadable, malformed, unsupported, ambiguous, blocked, or escaping input
fails closed; no affected plugin content, catalog copy, or stale-cache copy is substituted. Imported
installed state is authorization evidence, not a publisher-authenticity guarantee or an OS sandbox.
Use `/doctor` for the bounded reason.

PiCC's realized enablement order is directory-interleaved: user first; then, from the project root
toward the current directory, each directory's project settings followed by local settings; managed
policy last. A nested project's value can therefore override an ancestor's local value, unlike
Claude Code's documented global local-over-project order. Later values replace only the same
qualified identity. Managed policy is read from the platform system `managed-settings.json`, then
JSON drop-ins in `managed-settings.d` by filename. On Windows, HKLM
`SOFTWARE\Policies\ClaudeCode\Settings` follows those files; HKCU at the same key is a user-policy
fallback read only when no administrator source is present. The system file is
`C:\Program Files\ClaudeCode\managed-settings.json` on Windows,
`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, and
`/etc/claude-code/managed-settings.json` on Linux; each drop-in directory is beside that file.

The interactive TUI's `/plugin` opens read-only **Discover**, **Installed**, **Marketplaces**, and
**Errors** views with local filtering and details. Discover and Marketplaces show only registrations
and catalog declarations already available locally; they do not refresh or acquire anything.
`/plugin list` prints the bounded inventory, `/plugin details name@marketplace` selects one exact
qualified identity, and `/plugins` is PiCC's exact-list alias. Use the qualified identity shown by
the list when the same plugin name occurs in multiple marketplaces.

These session commands and `/doctor` share the snapshot captured during extension loading. Viewing
or filtering it does not reread files, run plugin components or hooks, rebuild prompt state, or
change settings. After changing plugin state outside PiCC, run canonical `/reload` in the
interactive TUI, or exit and relaunch PiCC to refresh. `/new` does not reload the snapshot, and
`/reload-plugins` remains guidance only and performs no reload.

Standalone `picc plugin list` and `picc plugin details name@marketplace` inspect the current
working directory's target project. Each builds one fresh command-scoped snapshot without normal Pi
extension, MCP, hook, or plugin-runtime startup, using the active Claude profile in this order:
`PICC_CLAUDE_USER_DIR`, `CLAUDE_CONFIG_DIR`, then the default profile. Lifecycle repair must target
that same profile. Their bounded text is for inspection, not a stable JSON automation contract.
Every inventory surface is read-only: installation, update, enablement changes, removal, marketplace
mutation or refresh,
dependency resolution, rename migration, strict-overlay execution, and unsupported component
execution remain unavailable. See the generated [capability matrix](supported-features.md) for exact
support limits.

> **Auto memory is conservative by default.** PiCC loads `MEMORY.md` every session but writes to
> it only when you explicitly ask it to remember something (e.g. "remember to…"). This is a
> deliberate divergence from Claude Code, which also writes proactively. To restore Claude-Code-style
> eager writes, add an instruction like this to the project's `CLAUDE.md` — or, to opt in without
> modifying the target project, to the active user profile's `CLAUDE.md`:
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

In the interactive TUI, each main-session tool row has one foreground state marker: `○` running,
`●` success, `✗` failure, or `■` stopped/aborted. Lifecycle tools show the meaningful underlying
outcome even when their transport call succeeds. An ordinary settled Read appears as
`● read <path><optional-range>`, Bash as `● bash $ <command><optional-timeout>`, and NotebookEdit as
`● notebook write <path><optional-operation-and-cell>`, each clamped to the terminal width with its
result body hidden. Other routine successes retain compact, semantically useful detail. The
configured `app.tools.expand` action (Ctrl+O by default) reveals retained/native detail without
changing the marker. It cannot recover bytes Pi or PiCC already
removed through canonical clipping or truncation.

Pending/streaming work, errors, aborts, clipping or truncation notices, recovery guidance, images,
MCP tools, search, and subagent/task records keep bounded detail appropriate to their semantics.
When `app.tools.expand` is unbound, an ordinary row whose hidden detail would otherwise be
inaccessible fails open and shows it. NotebookEdit deliberately keeps cell source private and shows
a configuration recovery note instead. Search and subagent completion rows keep a complete
configured-action cue, placing it on a separate row when necessary, and fail open when no usable cue
exists. At an unusably narrow terminal, when expansion is available but its cue cannot fit, they show
only bounded semantic state instead of a large body; detail waits for widening, and resize guidance
appears only when it fits. In PiCC compact summaries, paths
within the invocation-time workspace are relative to it; paths elsewhere in the repository use a
visibly marked repository-relative form, and external paths remain absolute. Eligible custom PiCC
fragments in HTML exports use the export context
available to them, while Pi owns stock built-in cards and their presentation. JSON and RPC have no
renderer styling and retain canonical event and tool data. Plain print is renderer-free and uses
Pi's final-text surface rather than emitting canonical tool records. None of these presentations
changes model-facing results or execution. Panel rows and terminal semantic records omit internal
task IDs; active waiting/running `TaskOutput` rows and `TaskStop` rows retain their requested
targets, while terminal record expansion carries the operational IDs.

### Observing subagents

Every subagent is visible, both to you and to the coordinating model:

- **Transcript storage.** When persistence is available, a dispatch writes
  `<mainSessionFileBase>.subagents/<stamp>_<agentId>.jsonl` beside its main-session transcript in
  Pi's manager-supplied session directory. The default tree is
  `$HOME/.pi/agent/sessions/<encoded-cwd>/…` on POSIX and
  `%USERPROFILE%\.pi\agent\sessions\<encoded-cwd>\…` on Windows, where Pi derives `<encoded-cwd>`
  from the absolute cwd; the host/session manager supplies a custom replacement directory when
  configured. The agent id in the dispatch result identifies its file. If the main transcript or Pi
  persistence API is unavailable, or persistence creation or
  ownership admission fails, the dispatch runs in memory instead and is not resumable.
- **Status panel.** While agents run, a panel below the input shows the whole agent tree live —
  no `TaskOutput` await needed. In row mode, each individually rendered active agent has an indented
  status row and a stable second line for its current tool and primary argument, reasoning, assistant
  or output text, or startup, work, retry, and capacity-waiting status. The second line updates in
  place and disappears only when the agent completes, fails, stops, or is canceled. The status bubble is `◌`
  while waiting for configured capacity, a spinner while running, `●` when done, `✗` when failed,
  and `■` when stopped. Recognized `color:` frontmatter values tint the agent type; other values do
  not. State and identity take priority as width narrows; the dispatch description appears when
  space permits, and elapsed time and token usage appear only when known and terminal width permits.
  Elapsed time runs from dispatch acceptance until completion or stop, so it includes any queue
  time. The panel window contains at most eight agents, not eight physical lines; overflow markers
  and `↑↓` navigation move it through the full tree. Below the minimum useful identity-row width,
  per-agent rows and their activity lines become aggregate state glyphs. Finished rows
  linger briefly — ~10 s
  for successes, ~60 s for failures and stops — then leave on their own. That auto-expiry is a deliberate PiCC
  deviation: Claude Code keeps finished agents listed until dismissed. An expired row is not lost:
  `alt+a` reopens the panel with every finished agent still listed, and the condensed record in
  the chat (below) arrives once the conversation continues. While the panel has keyboard focus,
  no row expires on its own (dismissing with `d` still removes). When multiple agents are accepted,
  including capacity waiters, a one-time hint names the entry key.
- **Panel navigation (`alt+a`).** Press `alt+a` to focus the panel. On row layouts, a `❯` marker
  shows the selection and, when width permits, the footer hints at the available navigation, open,
  stop, dismiss, and close keys; hints may be omitted as the terminal narrows. An aggregate-only
  layout has no visible target, so open, stop, stop-all, and dismiss ask you to resize wider instead
  of acting on a hidden selection. Stopping from the panel is **background-only** — a foreground
  agent is cancelled with Esc in the editor, as before (that cancels the whole turn). `X` (stop-all)
  asks for a second press within ~3 s to confirm. A user-initiated stop is **permanent**: a
  user-stopped agent cannot be steered or resumed afterwards, not even by the model.
- **Drill-down.** Enter opens the selected agent: its initial prompt (collapsed; `ctrl+p`
  expands), bounded structured live detail (auto-following; `↑↓` scrolls, scrolling back stops
  the follow), and — once settled — its final answer. `ctrl+x` stops an admitted running or
  capacity-waiting background agent (on a settled one it dismisses). While an admitted background
  agent runs, type a steering message directly into the drill-down and press Enter to send; it is
  delivered before the agent's next model call (the confirmation is optimistic — a delivery failure
  replaces it). **Caveat:** drill-down steering does not fire the project's `UserPromptSubmit`
  hooks — a PiCC decision. Esc steps back one layer: drill-down → list → editor (with typed steer
  text, the first Esc clears the text; where steering is unavailable — waiting for capacity until
  admission, foreground, one-shot, or user-stopped — the view says so instead of offering an input
  line).
- **Condensed transcript records.** Subagent output does not stream into the chat. The agent list
  owns one bounded current-activity line; selected-agent detail owns multiline history and richer
  live detail. Each depth-1 normal-path result replaces its pending call in the same
  tool row. A successful background acceptance is transient in human chat rather than a durable row;
  its first terminal delivery, whether from `TaskOutput` or next-turn settlement, creates a separate
  semantic record instead of mutating the earlier call. That bounded record prioritizes the
  outcome, agent identity and textual state, actionable exceptional evidence, and dispatch description, then an
  expansion cue and duration as space permits. The configured `app.tools.expand` action (Ctrl+O by
  default) reveals the task and agent IDs, available retained output, transcript location, usage,
  and applicable diagnostics. At usable widths, an unbound action fails open to that detail. A terminal `TaskOutput`
  retrieval after that record was already delivered adds no human row. Background agents still get
  the record if never awaited; an agent that settles while you are away from the prompt gets it when
  the conversation next continues. Nested agents (depth ≥ 2) get no record of their own — they keep
  Pi's default notice box and appear in the panel tree and their parent's transcript only.
- **Esc** cancels a running *foreground* dispatch (it reports as aborted). Esc while *awaiting* a
  background task only detaches the wait — the task keeps running; retrieve it with `TaskOutput`.
- **`SendMessage`** continues a finished subagent with its context intact, or redirects a running
  background one, addressed by its `agent-<id>`. Resuming normally keeps that agent id and creates a
  new task id, so the agent id is the reliable correlation key. A foreground or background agent
  paused by pre-commit operational or hook exhaustion is retained under its agent id instead:
  after repairing the cause, awaiting `SendMessage` performs recovery and returns the result directly
  without creating a task generation. A child whose committed summary cannot be restored or continued
  is terminal and must be abandoned with `TaskStop` and replaced. `TaskStop` accepts that retained
  child's stable agent id only while the originating process is alive.
  Resume is process-lifetime only — after you quit and relaunch `picc`, a prior agent id no longer
  resolves — fork dispatches are never resumable, and a user-stopped
  agent refuses resume and steering permanently.
- **Interactive TUI only.** The panel, drill-down, and condensed records exist only in the
  interactive TUI.

### Transcript and worktree retention (`cleanupPeriodDays`)

`cleanupPeriodDays` is a top-level setting shared by persisted subagent transcripts and orphaned
worktrees. It defaults to 30 and accepts only a literal integer of at least 1. A fresh verified
main-session transcript retains its complete child collection; once that parent is older than the
effective period, recognized children are eligible only when no ownership marker conflicts with the
parent. An absent marker does not conflict in this parent-backed legacy case; an unreadable,
malformed, or mismatched marker preserves the collection. If the parent is gone, PiCC ages
recognized files individually only when the collection has PiCC's matching ownership marker,
retaining fresh files and removing an empty collection. An unreadable, malformed, or mismatched
parent also preserves the collection, as do markerless legacy orphans. When ownership is ambiguous,
PiCC leaves existing transcript data untouched. Preserve or back up that data, and never edit or
delete an ownership marker by hand. Start a new main session for future persisted subagents and
review the old data separately; the new session does not clean the old data.

For transcripts, PiCC scans only the default or custom session directory supplied by the active Pi
session manager; it never crawls global Pi data. Orphan-worktree cleanup separately scans the
project-owned `.claude/worktrees` directory. The exact startup session's collection is excluded. At
session activation PiCC refreshes an existing main transcript's modification time, then does so
approximately hourly without creating the file or changing transcript content. This reduces
concurrent-process races, but is best-effort protection, not a lock or a deletion-time guarantee.

Destructive cleanup is skipped if any applicable settings source is unreadable, malformed, not a
settings object, or contains an invalid `cleanupPeriodDays`; unrelated settings warnings do not
block it. Cleanup runs asynchronously and best-effort around startup, so missing, changed, locked,
or inaccessible files do not prevent the session from becoming usable. A clean no-op is silent;
removals, blocked policy, or problems produce one bounded TUI notification in TUI mode or one
`PiCC:` line on stderr otherwise. The same 30-day default gives orphaned worktrees a grace period
when no value is configured. `/doctor` reports the effective period and whether settings admit
cleanup, not per-run cleanup details or absolute session-directory paths.

PiCC does not remove main-session transcripts, unfamiliar files, markerless legacy orphans, or data
outside these PiCC-owned child collections and orphaned worktrees. Eligibility is not immediate or
secure erasure, and this policy is not global Pi or Claude Code application-data cleanup.

### Subagent dispatch controls (`.claude/settings.json`)

Three settings shape subagent dispatch under a `subagents` key. The effective merged value is
binding: project and local settings may override user scope, while managed policy has highest
precedence. These are PiCC extensions with no Claude-settings equivalent.

| Key | Default | Effect |
|---|---|---|
| `subagents.enabled` | `true` | Gates **all** subagent delegation. `false` (or the inverse alias `disableSubagents: true`) removes `Agent`/`Task` from the main session entirely. |
| `subagents.maxDepth` | `1` | Caps subagent **nesting** depth. Any positive integer is valid; default `1` = main-session-only, and nesting requires a value greater than `1`. |
| `subagents.concurrency` | `10` | Bounds admitted root dispatches and, separately, each opted-in nested-background depth. Additional accepted work waits FIFO with no separate queue-size cap. |

The main conversation is **depth 0**; the subagents it dispatches are depth 1. So the default
`maxDepth: 1` allows normal fan-out but blocks a subagent from dispatching its own. When nesting is
enabled, each background depth has its own configured-capacity pool; `maxDepth × concurrency`
bounds those background pools, not total active work. Foreground nested dispatch bypasses the pools
to prevent a parent/child deadlock, so total active work can be higher.

**The two "off" states are different.** If your goal is "no runaway recursion," use `maxDepth` —
`enabled: false` removes delegation entirely, including ordinary depth-1 fan-out.

## 5. Control surface (project-external)

### Commands

| Command | What it does |
|---|---|
| `/skills` | Categorize loaded skills by typed-slash availability; unsupported-name and reserved-shadowing rows separately state whether direct `Skill` invocation remains allowed |
| `/agents` | List every subagent available for dispatch — project/user agents and the built-in `general-purpose`/`Explore`/`Plan` types — with tools, read-only marker, model, and worktree-isolation |
| `/doctor` | Explicit compatibility report for this project (generated from the capability registry) |
| `/mcp` | Bounded read-only MCP server status; interactive use is immediate, while one-shot text/JSON waits for servers to connect, initialize, and settle advertised tool, prompt, and resource catalogs or time out. See [MCP server settings](#6-security--permission-posture) |
| `/plugin`, `/plugin list`, `/plugin details name@marketplace`, `/plugins` | Read-only captured plugin inventory; see [Installed plugins](#installed-plugins) |
| `/reload-plugins` | Non-mutating guidance to use canonical `/reload` or relaunch; performs no reload |
| `/picc-update` | In a direct `picc` launch, show fixed installation-aware exit-and-update guidance; never mutates the running installation. External Pi hosting does not register it |
| `/usage` | Per-subagent token/cost breakdown for this session, plus a subagents total. **Subagent-scoped only** — a PiCC-additive surface, *not* Claude Code's whole-session `/usage`/`/cost`: the Pi extension API exposes no parent-session cost, so the main agent's own spend is not included |
| `/quota` | Context usage + provider rate-limit/quota headers from the last response (best-effort) |
| `/model`, `/login`, `/settings` | Pi built-ins: model switching, auth, Pi settings |

**Slash autocomplete.** Eligible user-invocable skills whose names do not conflict with Pi or PiCC
built-ins appear in the `/` menu with their description and argument hint — type `/` to browse, or
start typing a name to filter. Selecting one expands the skill into your turn exactly as Claude Code
does.

### MCP prompts and resources

The `/` palette is the primary way to discover connected MCP prompts. Their command form is
`/mcp__<server>__<prompt>`; each UTF-16 code unit outside ASCII letters, digits, `_`, and `-` in
either component becomes `_`, so an astral symbol becomes `__`. Arguments are positional in the
server's declared order; quote multi-word values with single or double quotes, for example
`/mcp__docs__summarize concise "release notes"`.
If palette publication fails, the typed fallback is usable only when you already know the raw server
and prompt names and can normalize them this way. PiCC owns the
`.claude/.picc/prompts` palette metadata, attempts to git-exclude that path, and regenerates it
during startup resource discovery and after `/reload`. Invocation replaces that user turn with
bounded, explicitly untrusted prompt
content. Generated palette files persist metadata only and never write prompt bodies or results;
successful transformed content follows ordinary conversation and session transcript retention.

When any settled initial server snapshot advertises resources, the model receives
`ListMcpResourcesTool` and `ReadMcpResourceTool`, including for an empty or
`resources/list`-failed catalog.
The schemas remain registered through reconnect and terminal retained states; they are absent only
when no initial settled snapshot advertised resources. Deny either fixed name directly, or use the
generic top-level forms
`ListMcpResourcesTool(server:...)`, `ReadMcpResourceTool(server:...)`, and
`ReadMcpResourceTool(uri:...)`; `mcp__server` and `Read(...)` are not aliases. Foreground
subagents and conversation forks inherit these tools through normal `tools:`/`disallowedTools:`
gating, while non-fork background subagents do not. MCP prompt commands remain user-only.

Resource text and complete in-budget binary as labeled base64 are bounded by the configured MCP
content budget; oversized or unsupported content degrades visibly. Prompt and resource catalogs are
immutable initial snapshots. To discover server changes, run `/reload` (which reloads extensions and
prompts) or exit and start PiCC again; reconnecting or resuming alone does not refresh them. MCP
resources have no `@` attachment or autocomplete. See the
[capability matrix](supported-features.md) for exhaustive limits and deferred MCP surfaces.

### Harness configuration

Lives **outside the project** (`~/.picc/config.json`) or in the harness-owned
`<project>/.claude/.picc/config.json` (PiCC attempts to add `.claude/.picc/` to repository-local
excludes; project configuration overrides user configuration):

```json
{
  "model": "openai-codex/gpt-5.5",
  "effort": "high",
  "steering": {
    "openai/*": "When a skill specifies a locked output format, reproduce it exactly. Prefer dispatching subagents over doing everything inline when the skill says to fan out."
  },
  "effortMap": { "ultra": "max" },
  "proactiveCompactPercent": 90,
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
  proactively triggers Pi's own compaction. **0–100 scale** (e.g. `90`, not `0.90`).
  **Default `90`**; valid range **50–95**. An out-of-range or malformed value falls back to
  the default with a diagnostic (never disables compaction). Lower it if a session still
  rides too close to the window; raise it to compact later. This is the extension-reachable
  margin lever — Pi's *hard* `reserveTokens` is a Pi settings-file matter, not set here.
  If both user and project scopes set this knob and the project value is malformed, the safe
  default is used (not the still-valid user value).

  For main sessions and PiCC-created subagents, final usage from a fresh successful assistant
  response that requests tools can queue a checkpoint. When PiCC reports that checkpoint as queued,
  continued already-requested tool activity is safe deferral, not another provider turn or a missed
  checkpoint; high displayed context by itself does not prove that a checkpoint is armed. Before
  admitting another ordinary model request, PiCC samples usage again and
  blocks the ordinary request before provider transport if newly known threshold pressure requires a
  checkpoint. Only after the run and its complete tool batch settle may PiCC start one Pi compaction
  transaction and resume the same
  logical work; it never compacts across an unresolved provider response or tool batch. Completed
  results and queued input remain pending. Pi can automatically recover an eligible transient summary
  transport failure inside that transaction. Summary retries stay
  bounded by Pi's configured summarization retry policy; PiCC-created subagents use Pi's in-memory
  defaults. Cancelling a main
  checkpoint stops PiCC continuation but may wait for Pi's configured summary retries to settle;
  cancelling a subagent checkpoint aborts its compaction. Quota, authentication, cancellation,
  deterministic provider errors, and PreCompact policy blocks are not made broadly retryable. If
  compaction or mandatory restoration cannot complete, work remains paused rather than continuing
  near the limit.

  This gate applies only to models using Pi's `openai-completions`, `openai-responses`, or
  `openai-codex-responses` API. It covers interactive TUI, print, JSON, and RPC operation. TUI
  reports status and recovery in-session. Print reports progress on stderr; two records are
  persisted outside JSON/RPC — an exhaustion with its recovery guidance, and a report of queued
  input a checkpoint could not deliver — and Pi-owned stdout does not prove the logical work
  completed. The process status does report one thing: outside the TUI, a **main-session**
  checkpoint PiCC reports as paused or cancelled sets exit status **3** — distinct from `0` and from the
  status Pi's own print-mode failures use, so a scripted caller can tell "finished" from "gave up"
  without reading prose. It is latched for the rest of the process and never cleared: recovering
  later with `/compact` leaves it at `3`, because the continuation that checkpoint paused never
  ran. A subagent checkpoint's ending never sets it, so `0` is not proof that a dispatched agent
  finished its work. Pi overrides it when print mode itself fails. For a confirmed recoverable
  pre-commit ending, a still-live RPC session can run `/compact`, then explicitly continue. If the
  session was persisted and its process exited, reopen that exact session in Pi's session picker
  before `/compact`, then explicitly continue. A one-shot ephemeral print/JSON session cannot be
  reopened; start a replacement session and resend the retained input. If PiCC says it could not
  confirm that checkpoint host work stopped, first copy any restored TUI draft or recover headless
  input from client/request history. Then exit PiCC completely, start a fresh PiCC process and a
  fresh session, do not reopen the affected session, and resend it. If a PreCompact hook blocked a
  confirmed recoverable attempt, first repair or disable that hook (or allow a manual trigger), then
  run `/compact` and explicitly continue. If the summary committed but restoration or continuation
  startup failed, **do not
  compact again**: start a new session and resend the retained input.

  JSON and RPC expose uncorrelated `picc-checkpoint-lifecycle` custom entries: category
  `checkpoint-exhausted` marks a paused boundary, `checkpoint-cancelled` marks a checkpoint that
  ended without resuming, `checkpoint-resumed` marks resumed work, and
  `checkpoint-manual-compaction-refused` gives restart-process guidance only when manual compaction
  is refused because an unconfirmed-host ending made the process terminal.
  Read `checkpoint-resumed`
  as superseded by any later terminal record for the same run — resumed work can still fail after
  it, and the terminal record is then the last word. An RPC prompt acknowledgement is not a
  checkpoint-completion acknowledgement. Pi may also
  emit native physical-run or compaction-error records that extensions cannot suppress or redact.
  A PiCC subagent retained after pre-commit operational or hook exhaustion is recovered with awaited
  `SendMessage` by agent id after repairing the cause, or abandoned with `TaskStop` before the process
  exits. A terminal post-commit child can only be abandoned and replaced.
- `clipMaxTokens` — per-tool-result token budget above which a single oversized tool-result
  text block is clipped (head + tail kept, middle replaced by a model-visible marker naming
  what was omitted and how to retrieve it). A backstop against pathological outputs, **not** a
  trimmer: **default `20000`** tokens (≈80k chars) is generous, so everyday results — a ~20k-char
  diff — pass through untouched. Valid **integer ≥ 1000**; a malformed value falls back to the
  default with a diagnostic. As with `proactiveCompactPercent`, if both user and project scopes
  set this knob and the project value is malformed, the safe default is used (not the still-valid
  user value).

### Environment variables

Values in Claude `settings.env` reach project-owned Bash, hooks, skills, and stdio MCP child
environments. They do not supply remote MCP URL/header interpolation, PiCC startup, or worktree Git
administration, so settings such as `GIT_DIR` cannot redirect those maintenance operations.

| Variable | Effect |
|---|---|
| `PICC_CLAUDE_USER_DIR` | Highest-priority user-profile directory override for user-scoped settings/artifacts, imported installed-plugin state/data, memory, and native state; project/managed contributions and supplementary authorized plugin roots remain |
| `CLAUDE_CONFIG_DIR` | Same user-profile-backed scope as `PICC_CLAUDE_USER_DIR`, used when that higher-priority override is unset |
| `PICC_GIT` | Absolute path to the Git executable for PiCC-owned source-update and worktree operations; overrides PATH discovery |
| `BRAVE_API_KEY` | Use the Brave Search API for `WebSearch` (otherwise a keyless DuckDuckGo fallback is used) |
| `PI_CODING_AGENT_DIR` | Pi's own config dir override (auth, models, Pi settings) |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Highest-priority model override for every subagent dispatch (`inherit` = unset) |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | Disable auto-memory loading (also: `autoMemoryEnabled: false` in settings) |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Force **every** `Agent`/`Task` dispatch to the foreground (background is otherwise the default). `SendMessage` resume is inherently async and is **not** governed by this switch |
| `CLAUDE_CODE_FORK_SUBAGENT` | Gate `subagent_type: "fork"` dispatch (inherit the parent conversation instead of starting fresh): `1` forces it on, `0` off. **Left unset it is enabled** — a deliberate PiCC choice. Inheritance is honored only for a **main-session** dispatch; nested, print-mode, and `isolation: worktree` forks run with fresh context and say so on the result |
| `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` | Remove the built-in `Explore`/`Plan` agent types (`general-purpose` always stays) |
| `MCP_TIMEOUT` | MCP startup bound in ms (default `30000` — 30 s): for remote servers, the aggregate initial connection/discovery/retry settlement bound and the finite bound for each reconnect attempt; see the capability matrix for retry policy |
| `MCP_TOOL_TIMEOUT` | MCP tool-call, prompt-get, and resource-read timeout in ms when a server entry sets no `timeout` (default ~28 h, Claude parity; values clamped to [1 s, ~24.8 d]) |
| `SLASH_COMMAND_TOOL_CHAR_BUDGET` | Override the startup skill-listing character budget |

## 6. Security & permission posture

PiCC's posture is deliberately partial: it runs permissive by default, enforces `permissions.deny`
and agent `tools:` gating for real, and leaves other Claude permission controls unenforced. Before
relying on a project's permissions or hooks, run `/doctor`: it reports project-specific
compatibility findings and labels detected safety-relevant divergences. For the exhaustive registry
view, the [supported-features matrix](supported-features.md) marks every safety-relevant entry,
including entries the current project does not declare. For *why* the posture is drawn this way,
see "Security & permission posture" in [`doc/architecture.md`](architecture.md).

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
   `NotebookRead`, `Edit`, and `MultiEdit` on a matching path, but does not directly match `Write` or
   `NotebookEdit`. A denied notebook normally cannot satisfy NotebookEdit's required successful-Read
   snapshot. To make a path immutable, add `deny: Edit(<path>)` **and** `deny: Write(<path>)`.
2. **Pathless read calls aren't matched.** `Grep {}` has no path for the matcher to test, yet its
   results can surface protected content. Only a **bare** `deny: Read` forecloses that — at the cost
   of removing `Read`/`Grep`/`Glob`/`NotebookRead` entirely. It does **not** also strip `Edit`/
   `MultiEdit`; the cross in rule 1 applies to a path-scoped rule only.
3. **A shell read needs its own `Bash(...)` deny.** `Bash(cat secrets/x)` is not covered by any
   `Read` rule.

**MCP server configuration and gates.** PiCC reads native Claude state without modifying it. The
default profile uses user-scoped settings and artifacts under `~/.claude` with native MCP state in
`~/.claude.json`. `PICC_CLAUDE_USER_DIR`, then `CLAUDE_CONFIG_DIR`, can select a different coherent
user profile for user-scoped settings and artifacts, imported installed-plugin state and data,
memory, and native state. Project and managed contributions plus supplementary authorized plugin
roots remain in effect.

Native definitions resolve as whole entries in local → project `.mcp.json` → user order; the PiCC
settings `mcpServers` compatibility extension is lower priority, with its existing managed →
untracked local → project → user ordering. Fields never merge across same-name definitions. Native
user and local winners start without the project approval gate. Project `.mcp.json` and committed
project-settings extension winners remain pending until approved as described below. An exact name
in the selected native project's `disabledMcpServers` disables an authentic native or `.mcp.json`
winner before expansion. `enabledMcpServers` is recognized and reported but cannot activate
Claude's default-off built-ins. Native MCP management through Claude Code must target the same
active user profile. When PiCC uses `PICC_CLAUDE_USER_DIR`, run Claude Code for that maintenance
operation with `CLAUDE_CONFIG_DIR` pointing to the same directory; otherwise Claude Code may update
a different profile.

For project-local native state, PiCC canonicalizes real paths so equivalent spellings and symlinks
select the same record. A verified linked worktree also considers its main checkout identity. This
is a conservative PiCC identity policy, not a claim about Claude Code's exact canonicalization.

A missing native state file preserves `.mcp.json` and settings-extension sources. If the file is
present but unusable (for example, malformed or unreadable), PiCC starts no MCP server and emits a
bounded value-redacted warning. Preserve or back up the active user profile. PiCC has no repair
command: restore a known-good backup of the active profile or its native state. If no
known-good backup is available, preserve the profile and seek appropriate support. Restart PiCC
after recovery. Use `/mcp` or `/doctor` for safe diagnostics.
These bounds and fail-closed rules apply to native state, not the older `.mcp.json` loader.

**Remote MCP with static headers.** A remote entry requires an explicit transport `type`. Put only
the variable reference in `.mcp.json`; remote URL and header interpolation reads the ambient
environment that launches PiCC, not Claude `settings.env`:

```json
{
  "mcpServers": {
    "hosted-tools": {
      "type": "http",
      "url": "https://mcp.example.com/api",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

Set the value without placing it in shell history, then launch from that environment:

```powershell
$env:MCP_TOKEN = Read-Host "MCP token"
picc
```

```bash
read -rs MCP_TOKEN; export MCP_TOKEN
picc
```

Do not put a secret-bearing `${VAR:-default}` in tracked configuration. PiCC-owned configuration,
transport, status, diagnostic, and local tool-error surfaces omit expanded URLs and headers, raw
non-protocol HTTP failure bodies/status/redirect targets, and SDK/fetch exception text. Once enabled,
valid MCP metadata, prompt/resource content, successful tool results, and protocol-level errors
remain untrusted, server-controlled model content.

Project-scope MCP servers (`.mcp.json`, or `mcpServers` in the committed
`.claude/settings.json`) are pending by default and never start until you approve them. Approve
selected servers with `enabledMcpjsonServers` in user settings or a clean, user-controlled,
untracked `.claude/settings.local.json`. User approval settings live in `settings.json` inside the
active user profile directory (`~/.claude/settings.json` by default, or inside the selected override
directory). `enableAllProjectMcpServers` trusts current and future project servers;
`disabledMcpjsonServers` declines named servers and wins over approval. Approvals in a git-tracked
`settings.local.json` do not work; create approval content yourself rather than reusing
project-supplied content.

Approval is persisted by sanitized server name, not by a command, URL, or header fingerprint. A
later project revision can change a same-name definition without another approval. Re-review project
MCP definitions after updates and before launching with secrets. Static authentication material is
confined to the currently configured origin across redirects; approval does not make an endpoint
immutable.

Remote startup and transient recovery are bounded. An initial `tools/list` failure is fatal to that
server's staged capability publication: it publishes no capability snapshot, `mcp__...` proxies, or
fixed resource tools. Separately, a `resources/list` failure on an otherwise successfully settled
resource-advertising server retains that advertised capability and registers the fixed resource
tools with an attributable catalog failure. Fix the endpoint, headers, or network, then run `/reload`
or exit and start PiCC again. Retained catalogs and automatic recovery apply only after successful
initial publication.
During an
outage, the original tool proxies stay present and return a transient local failure; after recovery
stops or a permanent failure, those proxies return a terminal local failure until the server is
fixed and the extension is reloaded. An authentication or authorization failure means to check the
configured static headers, not that OAuth is required. Use `/mcp` for current lifecycle state and
`/doctor` for configuration compatibility.
The [capability matrix](supported-features.md) owns alternative transports, deprecations, retry
policy, and unsupported surfaces.

## 7. What is and isn't supported

The capability registry is the single source of truth. `/doctor` uses it to describe detected
project-specific findings; the generated [`doc/supported-features.md`](supported-features.md) is the
exhaustive view of every current capability tier and the exact limit for partial support. Unknown or
future fields degrade safely and are reported as unassessed when detected.

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
- **Long paths & worktrees.** When Git is resolved from `PICC_GIT` or PATH, PiCC attempts to enable
  `core.longpaths` on the repo. Worktree removal is best-effort: a file-lock failure never fails your
  merge. A later session
  retries orphan cleanup only after Git and registered-worktree state are verified; otherwise
  PiCC leaves managed directories untouched.
- **Hook payloads** deliver Windows paths with doubled backslashes in JSON, as Claude Code does.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `/picc-update` is absent | The extension is hosted by an external Pi or the direct-launch lineage did not agree. Use that installation's owner and `picc --version`; do not send `/picc-update` as model input |
| Worktree commands say Git is unavailable | Ensure Git is on PATH, or set `PICC_GIT` to its absolute executable path before starting PiCC |
| Skill shell injection prints `[shell execution disabled: …]` | project set `disableSkillShellExecution`; that's the project's intent |
| A tool you expected is missing | check `/doctor` — the project may gate it via agent `tools:` or a deny rule |
| Hooks don't fire | check `disableAllHooks` in settings; `/doctor` lists unsupported events/handler types |
| MCP pending-approval notice at every startup | Review the pending servers and choose approval or decline under [MCP server settings](#6-security--permission-posture). Use `/mcp` for bounded status and settings guidance, or `/doctor` for broader compatibility findings. |
| Session died at high context / "input exceeds the context window" | Lower `proactiveCompactPercent` in `.claude/.picc/config.json` so PiCC compacts earlier (see Harness configuration above) |
| Checkpoint says work is paused, or a print/RPC command appears finished without `checkpoint-resumed` | For a confirmed recoverable pre-commit ending, a still-live RPC session can run `/compact`, then explicitly continue. If the session was persisted and its process exited, reopen that exact session before `/compact`; a one-shot ephemeral print/JSON session cannot be reopened, so start a replacement session and resend retained input. If PiCC could not confirm checkpoint host work stopped, copy any restored TUI draft or recover headless input from client/request history, then exit PiCC completely, start a fresh PiCC process and fresh session, do not reopen the affected session, and resend it. For a hook block, repair/disable the hook or allow manual compaction first. For any post-commit restoration/startup failure, do **not** compact again; start a new session and resend retained input. In JSON/RPC inspect uncorrelated `picc-checkpoint-lifecycle` categories, including `checkpoint-manual-compaction-refused` for an unsafe manual request. RPC acknowledgement and print stdout do not prove logical completion; outside the TUI, exit status **3** does report that a main-session checkpoint gave up. |
| `picc -p` exited with status **3** | A main-session checkpoint gave up: PiCC paused the work for context compaction and it never resumed, so stdout is a partial answer. Read the `PiCC: ` line on stderr — or the `picc-checkpoint-lifecycle` entries under `--mode json`/RPC — for which ending it was and what to resend. The status is latched for the process: a later recovery does not clear it, and a subagent checkpoint never sets it. |
| `picc -p` finished but a subagent's output never appeared | Background is the default and a one-shot print run has no next turn to deliver it on. Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for scripted runs, or collect with `TaskOutput` before the run ends. |
| Subagents can't spawn subagents / nested fan-out flattened | PiCC defaults to **main-session-only** (`subagents.maxDepth: 1`) — subagents don't recurse by default. Set `subagents.maxDepth` to a positive integer greater than 1 in `.claude/settings.json`; see "Subagent dispatch controls" above. `/doctor` also shows the current nesting posture. |
| Unexpected skills/agents from plugins | Use `/plugin list` for qualified identities, `/plugin details name@marketplace` for captured declarations and runtime posture, and `/doctor` for actionable compatibility findings. Healthy identities stay out of doctor diagnostics. Only literal `true` enablement plus a matching exact imported record can load content. |
| An enabled plugin is reported as uninstalled or its installed state is rejected | Inspect the exact qualified identity in `/plugin details`. Relative to the active Claude user directory, fix access/permissions for `plugins/installed_plugins.json` when unreadable or repair/regenerate it through Claude Code when malformed. For an unsupported format, update PiCC or contact PiCC support. After repair, use canonical `/reload` in the interactive TUI or exit and relaunch PiCC; `/new` does not reload the session snapshot. |
| The qualified plugin blocklist rejects every enabled plugin | Relative to the active Claude user directory, fix access/permissions for `plugins/blocklist.json` when unreadable. When malformed, ensure it is a valid JSON object, its optional `plugins` field is an array, and each entry's `plugin` field is a qualified `name@marketplace` identity. After repair, use canonical `/reload` in the interactive TUI or exit and relaunch PiCC. |
| Plugin policy is ignored or a weaker Windows policy did not apply | `/doctor` identifies the safe source class, not a concrete file or path. For `system-file` or `registry-hklm`, ask the administrator to inspect that class; for `system-drop-in`, ask the administrator to inspect every JSON drop-in. For `registry-hkcu` or `override`, inspect the corresponding user fallback or override input. After repair, use canonical `/reload` in the interactive TUI or exit and relaunch PiCC. |
| A plugin root or component is rejected | Reinstall the plugin through Claude Code rather than moving files or treating an environment/catalog path as a substitute for the exact record. PiCC rejects declarations or content that are malformed, escaping, missing, unreadable, the wrong kind, or no longer resolve to the same contained target. After reinstalling, use canonical `/reload` in the interactive TUI or exit and relaunch PiCC. |
| Plugin activation or agent start reports a persistent-data failure | The failure may name a qualified identity or only a manifest-visible component or agent namespace. Inspect the `plugins/data/` base in the active Claude user-profile directory (see "Environment variables" for profile selection), correlating the affected entry through enabled settings and Claude Code's installed-plugin view when needed. Diagnostics intentionally omit absolute paths. For ownership, writability, or wrong-directory-kind failures, repair the filesystem and retry the affected skill, hook, or agent action without reloading. If integrity or context must instead be reconciled or the plugin reinstalled through Claude Code, then use canonical `/reload` in the interactive TUI or exit and relaunch PiCC. The affected execution did not occur. |
| Want to see why a fan-out routed the way it did | agent descriptions are the routing surface — inspect the "Available subagents" catalog in the session, and the dispatch tool calls in the transcript |
| Agent finished, its panel row is gone, and no record shows in the chat | Press `alt+a` — finished agents stay reachable in the panel after their rows expire. Or continue the conversation: the condensed record rides the next turn. |

## 10. Verification status

- **Windows 11**: fully verified — the automated suite (see [`doc/testing.md`](testing.md)) plus
  live validation on a real ChatGPT/Codex subscription, covering slash commands with argument
  substitution, description-routed subagent dispatch, worktree entry detected as `mode=worktree` by
  a project's own git-plumbing probe, `.worktreeinclude` seeding, and hooks.
- **Linux**: the automated suite, including the real-Pi CLI lane with a local mock model, runs in
  CI. Live ChatGPT/Codex subscription validation remains Windows-only.

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

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

Ordinary project loading writes no tracked project file. Explicit plugin lifecycle actions may write
selected settings declarations as described under [Installed plugins](#installed-plugins). For the
full design see [`doc/architecture.md`](architecture.md); for the exact compatibility matrix see
[`doc/supported-features.md`](supported-features.md).

## 1. Requirements

- **Node.js ≥ 22.19** and npm (Node 20 does not work: Pi's bundled undici 8.x requires ≥ 22.19)
- **git** (2.40+ recommended)
- **Windows:** Git Bash on PATH (Pi's `bash` tool and most Claude projects' scripts assume bash;
  PowerShell is used where artifacts declare `shell: powershell`)
- A **ChatGPT Plus/Pro subscription** (for GPT/Codex models) — or any API key Pi supports

## 2. Install

### Published package

Install the current npm release globally:

```powershell
npm install --global @arnedeutsch/picc
picc --version
```

To select an immutable published version, replace `X.Y.Z` with the required version:

```powershell
npm install --global @arnedeutsch/picc@X.Y.Z
picc --version
```

Each [GitHub Release](https://github.com/ArneDeutsch/PiCC/releases) from `v0.1.1` onward also attaches
`arnedeutsch-picc-X.Y.Z.tgz`. It is the same npm package archive, not a standalone executable.
Download it, then give its local path to npm:

```powershell
npm install --global ./arnedeutsch-picc-X.Y.Z.tgz
picc --version
```

These forms are npm-owned global installations. Running `picc update` moves them to the registry's
current `latest`, including an installation originally selected by exact version or archive. To
remain on a selected version, do not run that updater; reinstall `@arnedeutsch/picc@X.Y.Z` or the
chosen archive when repair is needed.

If npm cannot resolve `@arnedeutsch/picc`, keep an existing installation or use the source-checkout
path below instead.

### Source checkout with a global command

These commands work in PowerShell, cmd, and POSIX shells:

```powershell
git clone https://github.com/ArneDeutsch/PiCC.git
cd PiCC
npm run setup
```

`npm run setup` installs the locked dependencies, builds and verifies the runtime, then globally
links that checkout, so edits and pulls continue to drive the `picc` command. The npm global prefix
must be writable. Configure a user-level prefix rather than running the setup as an administrator.

On Windows:

- If running `picc` in PowerShell fails with *"running scripts is disabled on this
  system"*, either call the cmd shim `picc.cmd` instead, or allow local scripts once:
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
  ```
- **Git Bash must be installed** (it comes with Git for Windows). Pi's `bash` tool and most
  Claude Code projects' scripts assume bash; PiCC finds Git Bash automatically and never
  uses the WSL `bash.exe` stub in System32.

### No global link

- Contributors and users without a writable npm global prefix can prepare PiCC inside its checkout:
  ```powershell
  cd <path-to-PiCC>
  npm ci
  npm run build
  ```
  Then change to the target Claude Code project and launch that prepared checkout:
  ```powershell
  cd <path-to-your-claude-code-project>
  node <path-to-PiCC>/bin/picc.mjs
  ```
- Or, if you already use Pi, load the extension directly:
  `pi -e <path-to-PiCC>/src/index.ts`
- Or add it permanently to Pi's config (`~/.pi/agent/settings.json`):
  ```json
  { "extensions": ["<path-to-picc>/src/index.ts"] }
  ```

### Runtime selection and recovery

The PiCC launcher selects the representation and verifies any compiled runtime before loading the
extension. Healthy startup is quiet; `picc --version` reports the installation kind and runtime
selection.

| How PiCC is hosted | Runtime and recovery | Setup, update, and reload |
|---|---|---|
| Published/global installation | Verified installed JavaScript for interactive and standalone plugin commands. Missing, damaged, or version-incoherent output fails closed; TypeScript is never substituted. Run `picc update`, or repair/reinstall through the package manager or project that owns the copy. | Installation already contains the built runtime and source maps; lifecycle scripts are not required. `/reload` keeps the verified compiled generation selected for the process. Exit and relaunch after update or repair. |
| Source-checkout `picc` or `node …/bin/picc.mjs` | Uses verified JavaScript when it matches the checkout. Missing or stale output produces a notice and uses TypeScript source; damaged output fails closed. Run `npm run build` from the PiCC checkout root, then exit and relaunch. | `npm run setup` installs locked dependencies, builds and verifies the runtime, then globally links the checkout. `picc update` synchronizes locked dependencies, builds for the checked-out revision, and verifies the product without changing tracked source. A compiled selection stays on its verified generation; source fallback stays source-hosted and may observe source edits under Pi's reload semantics. `/reload` cannot adopt a new build. |
| External Pi with `pi -e <path-to-PiCC>/src/index.ts` (or that path in Pi settings) | Explicit TypeScript development path; it does not use PiCC launcher selection or compiled-runtime verification. | Prepare dependencies with `npm ci`. Update ownership stays with the external Pi installation. Reloading remains source-hosted and may observe source edits under Pi's reload semantics; it never switches to compiled output. |

Generated external source maps support source-oriented stack traces for compiled execution, though
exact stack formatting depends on Node and the host. The retained TypeScript files are for explicit
source development and debugging; an installed launch does not use them as integrity recovery.

### Check and update PiCC

`picc --version` reports the PiCC version, embedded Pi version, installation kind, and whether the
runtime is verified compiled output, a disclosed source fallback, or unavailable. `picc update
--check` reports the current state without changing the installation; a global npm installation asks
npm for the current published version. The update path depends on who owns the installation:

- **Source checkout / global link:** `picc update` first requires a clean `git status`, using your
  normal Git configuration and global ignores. It then runs `npm ci --ignore-scripts --no-audit
  --no-fund`, builds and verifies the runtime for the current revision, and revalidates the four
  coordinated Pi packages. It never pulls or changes tracked source; update that through your normal
  reviewed Git workflow first.
- **Global npm installation:** PiCC updates itself only when its canonical package root exactly
  matches npm's scoped global installation path, `<npm global root>/@arnedeutsch/picc`. The npm child
  inherits your proxy, CA, registry, and other npm settings. Exit active sessions before updating.
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
| MCP servers | platform-fixed standalone `managed-mcp.json`, or native Claude user/project-local state + `.mcp.json` + the PiCC settings `mcpServers` extension, plus `mcpServers:` frontmatter on user/project agents; source-specific policy, approval, and disablement apply |
| Plugins | effectively enabled qualified identities backed by an exact imported Claude record or a complete committed PiCC-owned generation |

### Installed plugins

PiCC loads plugin content only when the qualified `name@marketplace` identity is effectively enabled
and executable authority comes from either a matching exact imported Claude installation record or
one complete committed PiCC-owned admission generation. PiCC-owned lifecycle installations use the
default-enable rules below; imported records still require an explicit effective literal `true`.
Enablement chooses an identity; it cannot create an installation or authorize a root.
`CLAUDE_CODE_PLUGIN_CACHE_DIR` and each path-delimited `CLAUDE_CODE_PLUGIN_SEED_DIR` entry's
`<seed>/cache` directory are eligible bases only for resolving an exact imported record. They never
seed or authorize PiCC-owned lifecycle content. Catalog entries, cache presence without an imported
record, repository-bundled `.claude-plugin/` content, and development roots likewise provide no
executable-root authority. Repository settings may therefore enable an applicable identity installed
separately, but cloning a repository cannot make its bundled plugin code executable. See the generated
[capability matrix](supported-features.md) for exhaustive support details.

PiCC validates the selected installed root and component paths before folding content into the
project model. Missing, unreadable, malformed, unsupported, ambiguous, blocked, or escaping input
fails closed; no affected plugin content, catalog copy, or stale-cache copy is substituted. Imported
installed state is authorization evidence, not a publisher-authenticity guarantee or an OS sandbox.
Use `/doctor` for the bounded reason.

Managed policy is read from the platform system `managed-settings.json`, then
JSON drop-ins in `managed-settings.d` by filename. The system file is
`C:\Program Files\ClaudeCode\managed-settings.json` on Windows,
`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, and
`/etc/claude-code/managed-settings.json` on Linux; each drop-in directory is beside that file.

PiCC neither reads nor migrates Windows registry policy. HKLM- or HKCU-only policy is silently
ignored: it supplies no settings, diagnostics, enforcement, cleanup blocking, or fail-closed
behavior. Registry-only deployments must manually deploy the intended managed-settings JSON to the
administrator-owned Windows system file or its ordered drop-ins. There is no precedence-equivalent
migration: a lexically last drop-in best approximates the former machine-policy-after-files order,
while the former user fallback has no exact user-writable managed replacement. The standalone
`managed-mcp.json` authority is separate from managed settings and is not a migration target.

The interactive TUI's bare `/plugin` opens observational **Discover**, **Installed**,
**Marketplaces**, and **Errors** views. Each open keeps loaded-runtime evidence from extension startup
but freshly projects desired state and lifecycle targets from the active checkout. Filtering and
details remain passive: they do not acquire content, mutate state, or reload plugins. The fixed
`/plugins` list and `/doctor` continue to use the extension-start snapshot. In the TUI, `/plugin
install|enable|disable|update|uninstall`, `/plugin marketplace add|refresh|remove`, and `/plugin
recover` enter a focused workflow that collects exact selectors, source and scope, destructive
choices, preview, and confirmation. Headless slash use is guidance-only.

Standalone commands run from the target project's working directory and build a fresh command-scoped
view without normal Pi, MCP, hook, or plugin-runtime startup. The following is an orientation, not a
combined grammar or copy-paste recipe; `picc plugin --help` is the exact operational authority:

```text
picc plugin marketplace list | details | add | refresh | remove
picc plugin list | details | install | enable | disable | update | uninstall
picc plugin recover
```

Marketplace `--source` values are a quoted absolute local directory or catalog-file path (for
example, `"/srv/shared plugins/catalog.json"`), a GitHub `owner/repository`, or a public HTTPS Git or
catalog URL, matching the selected source kind. Scope defaults to `user`; project and local scope require an
explicit flag. Project/local local sources must be contained beneath the canonical main-checkout
family and are stored relative to it; an external absolute local source is user-scope only. Every
mutation displays a bounded preview. Planning an acquisition-capable standalone action may acquire
and validate immutable candidate content for that review. Without `--yes`, a TTY then requires the
literal response `yes`; `--yes` is advance consent and skips that prompt after the preview. Final
confirmation governs durable desired-state and settings publication, so cancelled or unavailable
confirmation publishes neither. `--declaration-only` permits the selected settings declaration to be
written even when a higher-precedence value makes it ineffective; it does not override that value.
User scope writes `settings.json` in the active Claude profile. Project scope writes the active
checkout's `.claude/settings.json`; local scope writes the canonical main checkout's shared
`.claude/settings.local.json`, including from a linked worktree. Imported Claude plugin records and
Claude-owned, seed, or managed marketplace registrations remain inspectable and read-only; only
exact PiCC-owned records and selected authentic declarations are mutated. Adding a same-name
marketplace with different authority is refused rather than replacing it.

Marketplace acquisition supports local directories/files, GitHub repositories, anonymous public
HTTPS Git repositories, and public HTTPS catalog descriptors. Catalog plugins may use immutable
relative content only from retained materialized local or Git-backed marketplace trees; a standalone
HTTPS catalog descriptor cannot confer relative content authority. Remote HTTPS acquisition accepts
only ports 443 and 8443. Other plugin sources are GitHub or anonymous public HTTPS Git repositories
and subdirectories, public npm packages from `registry.npmjs.org` without lifecycle scripts, or
public HTTPS ZIP archives. An accepted anonymous public HTTPS locator is credential-free canonical
authority: lifecycle records, applicable settings, confirmation/recovery evidence, and receipts
retain its complete path, subdirectory, and ref where exact recovery or audit requires them, while
generic paths and refs remain opaque in previews and output. Do not put secrets in locator paths or
refs. URL userinfo, query, fragment, request headers, ambient credentials, raw rejected input, and
other credential material are prohibited and absent from persisted descriptors, diagnostics, logs,
Pi transcripts, receipts, and user-facing failures. Private credentials,
SSH, private-network destinations, custom npm registries, and enterprise distribution are
unsupported. **Plugins are executable code:** inspect the preview's immutable revision/digests,
components, dependencies, and trust target before confirming. Trust is bound to immutable acquired
content; a mutable name or later marketplace refresh does not extend it.

Installation, authentic `enabledPlugins` declaration, precedence-resolved effective state, immutable
code, and optional plugin data are separate. Effective declarations load from user settings, then
each root-to-cwd project/local pair, then, for a reciprocally verified linked worktree, the canonical
main checkout's shared `.claude/settings.local.json`, and finally managed policy; later declarations
win per plugin identity. This interleaving can diverge from Claude's documented global
`Local > Project > User` priority. Existing explicit effective enablement survives install and
update; otherwise initial install uses marketplace `defaultEnabled`, then manifest
`defaultEnabled`, then enabled by default. PiCC-owned lifecycle activation checks dependencies
against already-installed effective plugins and can block activation when missing, incompatible,
cyclic, ambiguous, or indeterminate; imported dependency metadata is observational. PiCC never
acquires, updates, or enables dependencies automatically. Uninstalling with plugin-data removal
logically retires the selected data into PiCC-owned quarantine; it does not provide secure erasure.
Opening a project,
viewing inventory, or encountering a missing declaration never acquires, installs, trusts, recovers,
or executes new plugin content.

A compound failure may leave a safe non-executable pending declaration or installed-disabled record.
`picc plugin recover` lists pending operation IDs; supplying one ID inspects its feasible action, and
`--complete` or `--rollback` explicitly chooses that action. Recovery is offline, performs no
acquisition or trust approval, and must target the same active Claude profile. This is PiCC-owned
lifecycle recovery. Claude-owned plugin state is repaired with Claude Code or a known-good profile
backup, managed state by its administrator, and seed registrations at their configured seed source;
PiCC does not adopt or rewrite them.

A committed lifecycle receipt updates durable desired state, not the loaded session snapshot. Run
`/reload-plugins` in the interactive TUI or start a new PiCC session. Candidate validation failure
starts no reload and leaves the current runtime usable; an operational reload failure requires a new
session. Headless sessions cannot reload plugins, `/new` does not refresh plugin state, and offline
recovery applies only when startup or diagnostics separately identifies pending lifecycle state.

The command output is bounded human-readable text, not stable JSON automation. Unattended updates,
release channels, dependency automation, plugin authoring/evaluation commands, additional plugin
runtime components, and enforcement of `strictKnownMarketplaces`, `blockedMarketplaces`, or
`allowManagedHooksOnly` remain unsupported; see the generated
[capability matrix](supported-features.md).

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
  no `TaskOutput` await needed. Each individually rendered active agent uses one physical status row.
  When row space permits, a muted separator precedes a bounded live-activity payload after the
  dispatch description, or after identity when there is no distinct description. In the normal theme,
  the entire payload is muted italic. While synthetic default `Thinking…` is displayed, it includes
  the remembered activity as `<activity> · Thinking…`; genuine activity replaces it immediately. As
  available row space changes, the payload may be truncated with an ellipsis or omitted together with
  its separator, while terminal rows omit it. The status bubble is `◌` while waiting for configured
  capacity,
  a spinner while running, `●` when done, `✗` when failed, and `■` when stopped. Recognized `color:`
  frontmatter values tint the agent type; other values do not. State and identity take priority as
  width changes; the dispatch description appears when space permits, and elapsed time and token usage
  appear only when known and terminal width permits. Elapsed time runs from dispatch acceptance until
  completion or stop, so it includes any queue time. A bounded panel window uses overflow markers and
  `↑↓` navigation to move through the full tree. At widths too narrow for individual rows, the panel
  retains aggregate state glyphs without per-agent activity. Finished rows linger briefly — ~10 s
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
- **Condensed transcript records.** Subagent output does not stream into the chat. Each depth-1
  normal-path result replaces its pending call in the same tool row. A successful background
  acceptance is transient in human chat rather than a durable row;
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
  child's stable agent id only while the originating process is alive. A confirmed cancellation report
  is canonical: `TaskOutput` accepts either its task id or the reported `agent-…` locator and returns
  the same occurrence counts and retained detail; the panel and foreground result show that locator
  rather than inventing another report. An unconfirmed child stays quarantined: PiCC does not claim
  its input, stop/dispose it again, or release it as safe. Inspect its transcript and possible
  files/tools/external effects before choosing any replacement.
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
| `/mcp` | Stable bounded MCP status; interactive use is immediate, while one-shot text/JSON waits for bounded catalog settlement. `/mcp manage` opens interactive administration in the TUI. See [MCP administration](#mcp-administration) |
| `/plugin`, `/plugin list`, `/plugin details name@marketplace` | Observational inventory plus focused interactive lifecycle actions; see [Installed plugins](#installed-plugins) |
| `/plugins` | Exact observational list alias; never mutates or reloads |
| `/reload-plugins` | In the interactive TUI, validate and adopt a complete plugin generation through Pi reload; headless modes give guidance only |
| `/picc-update` | In a direct `picc` launch, show fixed installation-aware exit-and-update guidance; never mutates the running installation. External Pi hosting does not register it |
| `/usage` | Per-subagent token/cost breakdown for this session, plus a subagents total. **Subagent-scoped only** — a PiCC-additive surface, *not* Claude Code's whole-session `/usage`/`/cost`: the Pi extension API exposes no parent-session cost, so the main agent's own spend is not included |
| `/quota` | Context usage + provider rate-limit/quota headers from the last response (best-effort) |
| `/model`, `/login`, `/settings` | Pi built-ins: model switching, auth, Pi settings |

**Slash autocomplete.** Eligible user-invocable skills whose names do not conflict with Pi or PiCC
built-ins appear in the `/` menu with their description and argument hint — type `/` to browse, or
start typing a name to filter. Selecting one expands the skill into your turn exactly as Claude Code
does.

### MCP administration

Bare `/mcp` retains the status surface. In the interactive TUI, `/mcp manage` opens bounded server
details and eligible approve, reject, enable, disable, reconnect, and authentication actions. The
exact deep links `/mcp approve`, `/mcp reject`, `/mcp enable`, `/mcp disable`, `/mcp reconnect`, and
`/mcp authenticate` preselect an action; they take no tail arguments. Manage, approve, reject, and
authenticate are wholly PiCC-defined. The fixed enable, disable, and reconnect links are PiCC-defined
shortcuts whose no-tail syntax deliberately differs from Claude's textual grammar. Authentication
reports unavailable: PiCC does not implement OAuth login, logout, token storage, or refresh.

Headless slash administration never prompts or mutates. Use bare `/mcp` for status and `picc mcp`
for supported configuration work. The standalone family runs without normal Pi session, hook, or
plugin startup:

```text
picc mcp list [--scope|-s local|project|user]
picc mcp get <name> [--scope|-s local|project|user]
picc mcp add [--dry-run] [--scope|-s ...] ...
picc mcp add-json [--dry-run] [--scope|-s ...] <name> <json>
picc mcp add-json [--dry-run] [--scope|-s ...] <name> --json-file <path|->
picc mcp remove [--dry-run] [--scope|-s ...] <name>
picc mcp reset-project-choices [--dry-run]
```

Run `picc mcp --help` for the exact grammar. Invalid syntax returns bounded help pointing there.
Mutations default to `local` and run directly without a confirmation prompt. `--dry-run` evaluates
the current safe snapshot without recovery or writes, so it can refuse while the corresponding direct
action would first recover. Project scope writes `.mcp.json`; local and user scope update the
applicable native project and user records.
Unscoped `list`/`get` show the bounded acquired inventory and effective winner; scoped reads are a
PiCC extension. Unscoped remove succeeds only for one unambiguous mutable declaration. List/get may
start only eligible winners in a transient bounded runtime to report connected, authentication-needed,
or failed health and capability counts, then attempt bounded shutdown.

For `add-json`, file, stdin, and inline input have a 1 MiB UTF-8 byte limit. Inline JSON and
`--env`/`--header` values can expose credentials in argv and shell history; for credential-bearing
definitions prefer `add-json --json-file <path|->` (file or stdin).
Output is a fixed field-selected projection and does not echo
definitions, commands, arguments, environment/header values, URLs, or raw failures. Stdio `add`
uses a mandatory `--` before the command. Add also accepts `--transport|-t`, `--env|-e`, and
`--header|-H`; remote add supports static HTTP/SSE headers. OAuth and
`add-from-claude-desktop` remain unavailable.

Declarations, project review decisions, and native runtime disablement are separate state. Approve
or reject a project definition in the TUI; use `reset-project-choices` to clear only PiCC-owned exact
definition review records across the active profile and checkout family. Enable/disable changes only
the native `disabledMcpServers` list and cannot activate unsupported default-off
`enabledMcpServers`. User/managed compatibility settings remain independent broad grants, while PiCC
review is bound to the exact execution definition, source family, and agent owner. Invalid private
review state blocks that exact review path but does not revoke an applicable trusted broad grant. A
same-name changed definition therefore returns to pending review when broad authority does not admit
it. Checkout-local approval keys never authorize.
Verified linked worktrees share the review family and recovery boundary; moving the checkout or
profile can make a stale action fail closed.

Mutation results distinguish eligibility, recovery, durable write, runtime reconciliation, and host
exposure. A committed write can be reported separately from a failed or uncertain live effect. If a
transaction leaves recovery pending, startup and direct writes remain fail-closed until recovery completes. Reopen `/mcp
manage` in the TUI to execute service-owned rollback preparation; a completed rollback opens the fresh
inventory, while pending or uncertain recovery stays blocked. Standalone reads and dry-runs only
diagnose it. Preserve the named files and inspect effects when persistence cleanup, runtime cleanup,
or host exposure is uncertain; committed/rolled-back with complete cleanup are terminal durable
outcomes, while pending recovery or cleanup is not. One count-only startup notice points pending TUI
sessions to `/mcp manage`; print/JSON/RPC modes do not recover or wait for review input.

Disable retires the current route before cleanup; enable can reconnect an eligible stdio definition
only after confirmed cleanup. Reconnect is available for a failed eligible remote main-session server.
Same-definition reconnect or re-enable reuses its immutable catalog; a changed execution definition
is rediscovered and refreshes main-session tools, prompts, and resources through the host. The fixed
resource tools are first registered and activated when the live main-session catalog first gains a
resource-capable definition, including through changed-definition administration. Host registration
may persist after the last such definition retires, but active exposure is removed. MCP
`list_changed` notifications remain unsupported, prompt palette stubs remain bounded to startup
prompt discovery and publication, and agent-inline catalogs stay isolated from the parent and siblings.

### MCP prompts and resources

The `/` palette is the primary way to discover connected MCP prompts. Their command form is
`/mcp__<server>__<prompt>`; each UTF-16 code unit outside ASCII letters, digits, `_`, and `-` in
either component becomes `_`, so an astral symbol becomes `__`. Arguments are positional in the
server's declared order; quote multi-word values with single or double quotes, for example
`/mcp__docs__summarize concise "release notes"`.
If palette publication fails, the typed fallback is usable only when you already know the raw server
and prompt names and can normalize them this way. PiCC owns the
`.claude/.picc/prompts` palette metadata, attempts to git-exclude that path, and regenerates it
during startup prompt discovery/publication and after `/reload`. Invocation replaces that user turn with
bounded, explicitly untrusted prompt
content. Generated palette files persist metadata only and never write prompt bodies or results;
successful transformed content follows ordinary conversation and session transcript retention.

When the live main-session catalog first gains an advertised resource capability, the model receives
`ListMcpResourcesTool` and `ReadMcpResourceTool`, including for an empty or
`resources/list`-failed catalog.
Host registration can remain through reconnect, terminal retention, and later retirement, but active
model exposure is absent whenever no live main-session definition advertises resources. Deny either
fixed name directly, or use the
generic top-level forms
`ListMcpResourcesTool(server:...)`, `ReadMcpResourceTool(server:...)`, and
`ReadMcpResourceTool(uri:...)`; `mcp__server` and `Read(...)` are not aliases. Foreground
subagents and conversation forks inherit these tools through normal `tools:`/`disallowedTools:`
gating, while non-fork background subagents do not. MCP prompt commands remain user-only.

Resource text and complete in-budget binary as labeled base64 are bounded by the configured MCP
content budget; oversized or unsupported content degrades visibly. Same-definition catalogs remain
immutable across reconnect and ignored `list_changed` notifications. An administratively admitted
changed definition is rediscovered and refreshes main-session tool/resource exposure, but startup
prompt palette stubs do not republish dynamically; exact typed prompt routing follows the live
catalog. MCP resources have no `@` attachment or autocomplete. See the
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
  checkpoint stops PiCC continuation but may wait for Pi's configured summary retries to settle.
  Only an exact aborted terminal assistant response from the first resumed continuation followed by settlement of that same run is recoverable.
  That first resumed continuation may already have changed files, used tools, or caused external effects;
  after cancellation PiCC starts no second continuation or retained-input replay. In the TUI it reconciles Pi-restored queue text into
  one editor draft in steering FIFO, follow-up FIFO, then pre-existing draft order, separated by blank
  lines. Equal duplicates are preserved, and an inexact editor match is never overwritten. A leading
  slash is only text in that draft and remains inert until you press Enter, when normal command routing
  applies. Images and other non-text input cannot enter the editor and are explicitly counted in the
  retained-input record. Cancelling a subagent checkpoint aborts its compaction. Quota, authentication, cancellation,
  deterministic provider errors, and PreCompact policy blocks are not made broadly retryable. If
  compaction or mandatory restoration cannot complete, work remains paused rather than continuing
  near the limit. Live RPC cancellation during post-compaction retained replay is unsupported: Pi
  0.83 may drain native queued input before PiCC can present the cancellation. If PiCC does present
  it, use the reported counts and stage with caller-owned client/request history where available,
  inspect possible effects, then
  terminate PiCC and start a fresh process and fresh session; never deliberately resubmit in the
  affected RPC session. The action is `restart-process` and status is 3. Print and JSON are likewise
  partial/nonzero and use `retrieve-and-relaunch`. The `picc-checkpoint-retained-input` custom entry
  is a non-locator hint: Pi exposes no entry ID, and append acceptance or an existing session path
  does not verify reopened persistence. Caller-owned client/request history is a recovery source
  where available, not PiCC-verified persistence. A
  sink failure leaves custody unresolved and
  refuses retry rather than guessing; failure to show a decorative TUI notice does not undo successful
  editor or report custody.

  This gate applies only to models using Pi's `openai-completions`, `openai-responses`, or
  `openai-codex-responses` API. It covers interactive TUI, print, JSON, and RPC operation. TUI
  reports status and recovery in-session. Print reports progress on stderr; two records are
  persisted outside JSON/RPC — an exhaustion with its recovery guidance, and a report of queued
  input a checkpoint could not deliver — and Pi-owned stdout does not prove the logical work
  completed. The process status does report one thing: outside the TUI, a **main-session**
  checkpoint PiCC reports as paused or cancelled sets exit status **3** in print and JSON modes and
  for every presented live-RPC post-compaction cancellation. This is distinct
  from `0` and from the status Pi's own print-mode failures use, so a scripted caller can tell
  "finished" from "gave up" without reading prose. It is latched for the rest of the process and never cleared: later recovery
  does not turn the earlier partial paused/cancelled outcome into a one-shot success. A subagent
  checkpoint's ending never sets it, so `0` is not proof that a dispatched agent
  finished its work. Pi overrides it when print mode itself fails. For a confirmed recoverable
  pre-commit ending, a still-live RPC session can run `/compact`, then explicitly continue. If the
  session was persisted and its process exited, reopen that exact session in Pi's session picker
  before `/compact`, then explicitly continue. A one-shot ephemeral print/JSON session cannot be
  reopened; start a replacement session and resend the retained input. If PiCC says it could not
  confirm that checkpoint host work stopped, first copy any restored TUI draft or recover headless
  input from caller-owned client/request history where available. Then exit PiCC completely, start a fresh PiCC process and a
  fresh session, do not reopen the affected session, and resend it. If a PreCompact hook blocked a
  confirmed recoverable attempt, first repair or disable that hook (or allow a manual trigger), then
  run `/compact` and explicitly continue. If the summary committed but restoration or continuation
  startup failed, **do not
  compact again**: start a new session and resend the retained input.

  JSON and RPC expose uncorrelated `picc-checkpoint-lifecycle` custom entries: category
  `checkpoint-exhausted` marks a paused boundary, `checkpoint-cancelled` marks a cancelled checkpoint
  (`restart-process` for live RPC post-compaction cancellation), `checkpoint-resumed` marks resumed work, and
  `checkpoint-manual-compaction-refused` gives restart-process guidance when either authenticated
  RPC cancellation or unconfirmed host work made the process terminal. PiCC binds the readable mode
  to the accepted session, so an RPC ending remains restart-required if its terminal mode getter is
  no longer readable. In-process `/new`, `/resume`,
  `/fork`, and `/reload` are refused; terminate PiCC and start a fresh process and fresh session.
  Read `checkpoint-resumed`
  as superseded by any later terminal record for the same run — resumed work can still fail after
  it, and the terminal record is then the last word. An RPC prompt acknowledgement is not a
  checkpoint-completion acknowledgement. Pi may also
  emit native physical-run or compaction-error records that extensions cannot suppress or redact.
  A PiCC subagent retained after pre-commit operational or hook exhaustion is recovered with awaited
  `SendMessage` by agent id after repairing the cause, or abandoned with `TaskStop` before the process
  exits. A terminal post-commit child can only be abandoned and replaced. On confirmed shutdown,
  PiCC makes one bounded best-effort persistence attempt before releasing retained cleanup. Verified
  success gives one of two restart locators. For `session <path>, entry <id>`, open the named
  JSONL and search for that exact entry id with `customType` `picc-retained-input-report`, then read the
  ordered `data.report.occurrences`. For `recovery file <path> for session <path>`, open the named JSON
  file and read its ordered `report.occurrences` before deliberately resubmitting. Do not treat a
  prospective path or an unconfirmed record as persisted. If no sink verifies custody, PiCC names only a
  bounded subset of affected generated agent IDs, warns that undelivered input may be lost, and continues
  normal shutdown without claiming a locator. Recover from parent/child transcripts and caller-owned
  request history where available before deliberate resubmission, and inspect the worktree plus possible
  files, tools, and external effects. Unconfirmed child work remains fail-closed and blocks cleanup. Its
  bounded affected-agent list pairs each exact current-registry ID only with that agent's exact transcript
  path using reversible JSON quoting, or says that no path was recorded. Path characters are never shortened
  or whitespace-collapsed. Decode the quoted value before copying it: the surrounding quotes are framing, not
  path characters. For a still-live rejected switch or non-quit shutdown, attempt `TaskOutput` with each
  decoded named agent ID before exit and copy its result only if a canonical report exists. If no canonical
  report exists or `TaskOutput` is absent or unavailable, copy retained input from that agent's decoded
  transcript path before exit. For `quit`, the renderer is already stopped, the process is exiting, and no
  further `TaskOutput` invocation is possible: use each decoded transcript path as a recovery locator before
  or after restart. Transcript paths survive process replacement, but agent IDs do
  not. If an affected agent has no recorded path, caller-owned parent/client request history is the remaining
  source where available. Inspect the worktree and possible effects; do not resume or retry that child in this
  process.
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

**MCP server configuration and gates.** PiCC reads native Claude state and changes only targeted MCP
declarations or runtime-disable lists through its administration transactions. The default profile
uses user-scoped settings and artifacts under `~/.claude` with native MCP state in
`~/.claude.json`. `PICC_CLAUDE_USER_DIR`, then `CLAUDE_CONFIG_DIR`, can select a different coherent
user profile for user-scoped settings and artifacts, imported installed-plugin state and data,
memory, and native state. Project and managed contributions plus supplementary authorized plugin
roots remain in effect.

User/project agent `mcpServers:` lists may reference an eligible session server by name or define an
inline stdio/HTTP/SSE server. References reuse the main session's published connection; inline servers belong only to
that dispatch, and PiCC attempts and awaits their shutdown before releasing its worktree. Managed policy, project approval,
the `disabledMcpjsonServers` project-decline gate, agent tool filters, permissions, hooks, and timeouts still apply. A published
session route wins a same-name inline declaration regardless of that declaration's admission status,
without starting a duplicate or warning. Missing, invalid, blocked, disabled, pending, or
startup-failed capability produces a bounded warning before the child's first request and around its
reported result. Cleanup uncertainty is known only after child work, so it preserves and qualifies
the result and receives one session-shutdown retry. Neither warning shows raw configuration. Inline
servers do not appear in the parent `/mcp` or `/doctor` live inventory, do not pass to siblings or
nested children, and keep their launch cwd after a later EnterWorktree. A nested agent with omitted
or clean-empty `mcpServers` still inherits eligible published main-session routes. When the server must follow,
enter the desired worktree first and make a fresh `Agent` dispatch; `SendMessage` does not migrate an
existing agent or its server. In-process resume reuses the original cwd but applies the current loaded definition and policy
snapshot. Plugin agents diagnose and strip this field; define an equivalent user agent when no project
change is wanted, define a project agent otherwise, or remove the field from the plugin source.
Managed agents remain dispatchable, but their `mcpServers` field is retained only as inert evidence
and ignored. PiCC's non-empty declaration selection and rule that a parent's inline servers do not
propagate to nested children are inferred, unverified choices. Its cancellation, project approval,
collision, warning, cwd, and resume rules are likewise PiCC-defined hardening rather than verified
Claude Code parity. Custom agent definitions cannot execute in the main session; plugin
MCP/source references, WebSocket, `--strict-mcp-config`, and `--bare` are also unsupported.

When standalone managed MCP is absent, native definitions resolve as whole entries in local →
project `.mcp.json` → user order; the PiCC settings `mcpServers` compatibility extension is lower
priority, with its existing managed → untracked local → project → user ordering. Fields never merge
across same-name definitions. Native user and local winners start without project review. Project `.mcp.json` and committed
project-settings extension winners remain pending until an applicable exact PiCC review or broad
compatibility grant permits them. An exact name in the selected native project's
`disabledMcpServers` disables an authentic native or `.mcp.json` winner before expansion; ordinary
interactive enable/disable edits only that list. `enabledMcpServers` is recognized and reported but
cannot activate Claude's default-off built-ins. Standalone `picc mcp` uses the selected coherent
profile; external Claude Code maintenance must target that same profile.

For project-local native state, PiCC canonicalizes real paths so equivalent spellings and symlinks
select the same project. A verified linked worktree also considers its main checkout identity.
Multiple canonical aliases, including Windows drive-letter case variants, require no profile repair
when their complete bounded MCP projections agree under PiCC's conservative comparison. Raw MCP
server blocks are compared structurally, while runtime-control lists are validated and deduplicated
as name sets; explicit `enabledMcpServers` presence remains significant even for an empty list.
Conflicting projections or invalid matching project-record, MCP-block, or runtime-list shapes remain
unusable and fail all MCP loading closed.
This is a conservative PiCC identity and conflict policy, not a claim about Claude Code's exact
behavior for canonical-equivalent records.

Without standalone exclusive control, a missing native state file preserves `.mcp.json` and
settings-extension sources. If the file is present but unusable (for example, malformed or
unreadable), PiCC starts no MCP server and emits a bounded value-redacted warning. Preserve or back
up the active user profile and restore a known-good native state; administration refuses unsafe
input rather than rewriting it. Use `/mcp` or `/doctor` for safe diagnostics.
These bounds and fail-closed rules apply to native state, not the older `.mcp.json` loader.

**Managed MCP policy.** A platform-fixed `managed-mcp.json` has the minimal valid root shape
`{ "mcpServers": { ... } }` and is exclusive: a populated map suppresses ordinary sources, while an
empty map disables MCP. Its fixed path is
`C:\Program Files\ClaudeCode\managed-mcp.json` on Windows,
`/Library/Application Support/ClaudeCode/managed-mcp.json` on macOS, and
`/etc/claude-code/managed-mcp.json` on Linux; it is distinct from `managed-settings.json`. Managed
settings deny rules always win; allow contributions are documented soft lists that can be broadened
by valid lower scopes unless `allowManagedMcpServersOnly` is active. Claude's managed validation
treats an invalid allow list as active-empty, drops an invalid deny list, and treats invalid
managed-only as true. PiCC fails the snapshot closed when applicable source uncertainty may have lost
restrictive material; over-limit allow material becomes active-empty, while ambiguous or over-limit
candidate identities are blocked individually. Admission uses only bounded identity interpolation
from one startup environment snapshot. The fixed bounded PiCC-owned Git tracking classification may
run only when winner or approval selection needs it. After a winner is blocked, no further probe,
server-controlled helper, MCP server process, DNS lookup, or network activity occurs. `/mcp` and
`/doctor` show PiCC-defined structured posture, blocked reasons, and authority-specific remediation:
repair user policy yourself, ask an administrator to repair managed policy, or do both for mixed
authority. One bounded warning appears at extension startup for an empty exclusive set, fail-closed
policy, or blocked servers. See the [capability matrix](supported-features.md) for exact matching,
limits, deferred sources, and presentation differences.

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

Project-scope MCP servers (`.mcp.json`, committed settings `mcpServers`, or project-agent inline
definitions) are pending by default. Interactive approve/reject records a PiCC-private decision for
the exact execution definition, source family, checkout family, and agent owner. A changed same-name
definition requires review again; project-agent approval cannot authorize another owner or the main
session. `reset-project-choices` removes these review decisions without removing declarations or
runtime disablement.

The compatibility settings remain broader: `enabledMcpjsonServers` grants a normalized name and
`enableAllProjectMcpServers` grants current and future project servers; `disabledMcpjsonServers`
rejects names and wins. Only user/managed compatibility settings authorize. An untracked local
settings file may contribute declarations but its approval keys do not authorize, and a tracked one
is demoted to project scope. Static authentication material remains confined to the configured
origin across redirects; review does not make an endpoint immutable.

Remote startup and transient recovery are bounded. An initial `tools/list` failure is fatal to that
server's staged capability publication: it publishes no capability snapshot, `mcp__...` proxies, or
fixed resource tools. Separately, a `resources/list` failure on an otherwise successfully settled
resource-advertising server retains that advertised capability and registers the fixed resource
tools with an attributable catalog failure. Fix the endpoint, headers, or network, then use eligible
interactive reconnect or restart PiCC. Retained same-definition catalogs and automatic remote
recovery apply only after successful initial publication.
During an
outage, the original tool proxies stay present and return a transient local failure; after recovery
stops or a permanent failure, those proxies return a terminal local failure until reconnect or a
changed-definition replacement succeeds. An authentication or authorization failure means to check
the configured static headers; the authentication entry point cannot perform OAuth. Use `/mcp` for current lifecycle state and
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
| A source checkout reports a missing, stale, or damaged runtime | Run `npm run build` from the PiCC checkout root, exit, and relaunch; `/reload` cannot adopt the build. |
| An installed copy reports a missing, damaged, or version-incoherent runtime | For a global installation, run `picc update`. Otherwise repair or reinstall it through its package manager or parent project. Installed PiCC never falls back to TypeScript. |
| `/picc-update` is absent | The extension is hosted by an external Pi or the direct-launch lineage did not agree. Use that installation's owner and `picc --version`; do not send `/picc-update` as model input |
| Worktree commands say Git is unavailable | Ensure Git is on PATH, or set `PICC_GIT` to its absolute executable path before starting PiCC |
| Skill shell injection prints `[shell execution disabled: …]` | project set `disableSkillShellExecution`; that's the project's intent |
| A tool you expected is missing | check `/doctor` — the project may gate it via agent `tools:` or a deny rule |
| Hooks don't fire | check `disableAllHooks` in settings; `/doctor` lists unsupported events/handler types |
| MCP pending-review notice at every TUI startup | Open `/mcp manage` and approve or reject the exact definitions, or use broad trusted user/managed compatibility settings deliberately. Bare `/mcp` remains status; `/doctor` shows broader findings. |
| Managed MCP policy is fail closed or a repaired policy is not taking effect | Use `/mcp` or `/doctor` to inspect the reported authority, compiler observations, and any redacted source label. Ask the administrator to repair either the platform-fixed standalone `managed-mcp.json` or the reported managed-settings system file or ordered drop-in. Then use `/reload` or restart PiCC; `/new` does not reload policy. |
| Session died at high context / "input exceeds the context window" | Lower `proactiveCompactPercent` in `.claude/.picc/config.json` so PiCC compacts earlier (see Harness configuration above) |
| Checkpoint says work is paused, or a print/RPC command appears finished without `checkpoint-resumed` | For a confirmed recoverable pre-commit ending, a still-live RPC session can run `/compact`, then explicitly continue. If the session was persisted and its process exited, reopen that exact session before `/compact`; a one-shot ephemeral print/JSON session cannot be reopened, so start a replacement session and resend retained input. If PiCC could not confirm checkpoint host work stopped, copy any restored TUI draft or recover headless input from caller-owned client/request history where available, then exit PiCC completely, start a fresh PiCC process and fresh session, do not reopen the affected session, and resend it. For a hook block, repair/disable the hook or allow manual compaction first. For any post-commit restoration/startup failure, do **not** compact again; start a new session and resend retained input. Any presented post-compaction RPC cancellation is terminal: recover input from caller-owned client/request history where available, inspect possible effects, terminate PiCC, and start a fresh process and fresh session without reopening or resubmitting in the affected session. In JSON/RPC inspect uncorrelated `picc-checkpoint-lifecycle` categories, including `checkpoint-manual-compaction-refused` for an unsafe manual request. RPC acknowledgement and print stdout do not prove logical completion; print, JSON, and presented post-compaction RPC cancellation use status **3**. |
| `picc -p` exited with status **3** | A main-session checkpoint ended partially or was abandoned; resumed work may already have started, and files, tools, or external effects may exist. Treat stdout as partial, inspect the lifecycle stage in the `PiCC: ` stderr line or `picc-checkpoint-lifecycle` JSON/RPC entry, and follow its recovery guidance before resubmitting. The status is latched for the process: a later recovery does not clear it, and a subagent checkpoint never sets it. |
| `picc -p` finished but a subagent's output never appeared | Background is the default and a one-shot print run has no next turn to deliver it on. Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for scripted runs, or collect with `TaskOutput` before the run ends. |
| Subagents can't spawn subagents / nested fan-out flattened | PiCC defaults to **main-session-only** (`subagents.maxDepth: 1`) — subagents don't recurse by default. Set `subagents.maxDepth` to a positive integer greater than 1 in `.claude/settings.json`; see "Subagent dispatch controls" above. `/doctor` also shows the current nesting posture. |
| Unexpected skills/agents from plugins | Use `/plugin list` for qualified identities, `/plugin details name@marketplace` for active-checkout declarations and captured runtime posture, and `/doctor` for actionable compatibility findings. Healthy identities stay out of doctor diagnostics. Runtime loading requires effective literal `true` enablement plus matching imported installation authority or a committed PiCC-owned executable generation. |
| An enabled imported plugin is reported as uninstalled or its Claude-owned installed state is rejected | Inspect the exact qualified identity in `/plugin details`. Relative to the active Claude user directory, fix access/permissions for `plugins/installed_plugins.json` when unreadable or repair/regenerate it through Claude Code when malformed. For an unsupported format, update PiCC or contact PiCC support. After repair, use `/reload-plugins` in the interactive TUI or start a new PiCC session; `/new` does not reload the session snapshot. PiCC-owned pending operations instead use the explicit offline `picc plugin recover` flow above. |
| The qualified plugin blocklist rejects every enabled plugin | Relative to the active Claude user directory, fix access/permissions for `plugins/blocklist.json` when unreadable. When malformed, ensure it is a valid JSON object, its optional `plugins` field is an array, and each entry's `plugin` field is a qualified `name@marketplace` identity. After repair, use `/reload-plugins` in the interactive TUI or start a new PiCC session. |
| Managed plugin policy is ignored or Windows registry policy did not migrate | `/doctor` identifies a managed system file or ordered drop-in by safe source class, not by concrete path. Ask the administrator to repair that source, then use `/reload-plugins` in the interactive TUI or start a new PiCC session. Windows registry-only policy is intentionally silent and must be migrated manually as described under project loading. PiCC does not enforce `strictKnownMarketplaces`, `blockedMarketplaces`, or `allowManagedHooksOnly` against its lifecycle/runtime. |
| A plugin root or component is rejected | Inspect exact ownership in plugin inventory. For a PiCC-owned plugin, update the exact record with PiCC lifecycle; repair imported state through Claude Code. Do not move files or treat an environment/catalog path as a substitute for the exact record. PiCC rejects declarations or content that are malformed, escaping, missing, unreadable, the wrong kind, or no longer resolve to the same contained target. After repair, use `/reload-plugins` in the interactive TUI or start a new PiCC session. |
| Plugin activation or agent start reports a persistent-data failure | The failure may name a qualified identity or only a manifest-visible component or agent namespace. Inspect the `plugins/data/` base in the active Claude user-profile directory (see "Environment variables" for profile selection), correlating the affected entry through enabled settings and plugin inventory when needed. Diagnostics intentionally omit absolute paths. For ownership, writability, or wrong-directory-kind failures, repair the filesystem and retry the affected skill, hook, or agent action without reloading. If integrity or context must instead be reconciled, inspect exact ownership in plugin inventory; update exact PiCC-owned state with PiCC lifecycle or repair imported state through Claude Code, then use `/reload-plugins` in the interactive TUI or start a new PiCC session. The affected execution did not occur. |
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

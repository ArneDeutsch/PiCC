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
| MCP servers | `.mcp.json` + settings `mcpServers`; project-scope servers pending until approved |
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

In the interactive TUI, each main-session tool row has one foreground state marker: `○` running,
`●` success, `✗` failure, or `■` stopped/aborted. Lifecycle tools show the meaningful underlying
outcome even when their transport call succeeds. An ordinary settled Read appears as
`● read <path><optional-range>` and Bash as `● bash $ <command><optional-timeout>`, each clamped to
the terminal width with its result body hidden. Other routine successes retain compact,
semantically useful detail. The configured `app.tools.expand` action (Ctrl+O by default) reveals
retained/native detail without changing the marker. It cannot recover bytes Pi or PiCC already
removed through canonical clipping or truncation.

Pending/streaming work, errors, aborts, clipping or truncation notices, recovery guidance, images,
MCP tools, search, and subagent/task records keep bounded detail appropriate to their semantics.
When `app.tools.expand` is unbound, a row whose hidden detail would otherwise be inaccessible fails
open and shows it. Search and subagent completion rows keep a complete configured-action cue,
placing it on a separate row when necessary, and fail open when no usable cue exists. At an
unusably narrow terminal they show only bounded semantic state instead of a large body; detail waits
for widening, and resize guidance appears only when it fits. In PiCC compact summaries, paths
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

- **Transcript on disk.** Each dispatch leaves a JSONL transcript under
  `<mainSessionFileBase>.subagents/<stamp>_<agentId>.jsonl` in Pi's sessions dir
  (`~/.pi/agent/sessions/…`). The agent id appears in the dispatch result, so you can find the run's
  full record without guessing. These files are not reaped automatically.
- **Status panel.** While agents run, a panel below the input shows the whole agent tree live —
  no `TaskOutput` await needed. When width permits, each agent has an indented row with a status
  bubble (`◌` while waiting for configured capacity, a spinner while running, `●` done, `✗` failed,
  `■` stopped), agent type, and dispatch description. Recognized `color:` frontmatter values tint
  the type; other values do not. State and identity take priority as width narrows; the dispatch
  description appears when space permits, and elapsed time and token usage appear only when known
  and terminal width permits. Elapsed time runs
  from dispatch acceptance until completion or stop, so it includes any queue time. The panel shows
  at most eight rows at once; overflow markers and `↑↓` navigation move the window through the full
  tree. Below the minimum useful identity-row width, per-agent rows become aggregate state glyphs.
  Finished rows
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
- **Condensed transcript records.** Subagent output does not stream into the chat; selected-agent
  detail owns the live view. Each depth-1 normal-path result replaces its pending call in the same
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
  interactive TUI; print and RPC runs keep their previous subagent output unchanged.

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
| `/mcp` | Bounded read-only MCP server status; interactive use is immediate, while one-shot text/JSON waits for servers to connect, initialize, and discover tools or time out. See [MCP server settings](#6-security--permission-posture) |
| `/picc-update` | In a direct `picc` launch, show fixed installation-aware exit-and-update guidance; never mutates the running installation. External Pi hosting does not register it |
| `/usage` | Per-subagent token/cost breakdown for this session, plus a subagents total. **Subagent-scoped only** — a PiCC-additive surface, *not* Claude Code's whole-session `/usage`/`/cost`: the Pi extension API exposes no parent-session cost, so the main agent's own spend is not included |
| `/quota` | Context usage + provider rate-limit/quota headers from the last response (best-effort) |
| `/model`, `/login`, `/settings` | Pi built-ins: model switching, auth, Pi settings |

**Slash autocomplete.** Eligible user-invocable skills whose names do not conflict with Pi or PiCC
built-ins appear in the `/` menu with their description and argument hint — type `/` to browse, or
start typing a name to filter. Selecting one expands the skill into your turn exactly as Claude Code
does.

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

  For main sessions and PiCC-created subagents, PiCC checks at a completed assistant/tool
  cycle. The complete requested tool batch finishes first. Once the threshold is reached,
  PiCC pauses ordinary model requests, starts one Pi compaction transaction, and resumes the same
  logical work; completed results and queued input remain pending. Pi can automatically recover an
  eligible transient summary transport failure inside that transaction. Summary retries stay
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
  finished its work. Pi overrides it when print mode itself fails. For a persisted session, reopen
  that exact session in Pi's session
  picker before `/compact`; an ephemeral print/JSON session cannot be reopened and requires a
  replacement session with the retained input resent. For an operational pre-commit failure, run
  `/compact`, then explicitly continue. If a PreCompact hook blocked the attempt, first repair or
  disable that hook (or allow a manual trigger), then run `/compact` and explicitly continue. If
  the summary committed but restoration or continuation startup failed, **do not compact again**:
  start a new session and resend the retained input.

  JSON and RPC expose uncorrelated `picc-checkpoint-lifecycle` custom entries: category
  `checkpoint-exhausted` marks a paused boundary, `checkpoint-cancelled` marks a checkpoint that
  ended without resuming, and `checkpoint-resumed` marks resumed work. Read `checkpoint-resumed`
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

Values in Claude `settings.env` reach project-owned Bash, hooks, skills, and MCP servers. PiCC does
not apply them to its own startup or worktree Git administration, so settings such as `GIT_DIR`
cannot redirect those maintenance operations.

| Variable | Effect |
|---|---|
| `PICC_CLAUDE_USER_DIR` | Override the user-scope Claude dir (default `~/.claude`) — useful for isolated profiles or CI |
| `PICC_GIT` | Absolute path to the Git executable for PiCC-owned source-update and worktree operations; overrides PATH discovery |
| `BRAVE_API_KEY` | Use the Brave Search API for `WebSearch` (otherwise a keyless DuckDuckGo fallback is used) |
| `PI_CODING_AGENT_DIR` | Pi's own config dir override (auth, models, Pi settings) |
| `CLAUDE_CODE_SUBAGENT_MODEL` | Highest-priority model override for every subagent dispatch (`inherit` = unset) |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | Disable auto-memory loading (also: `autoMemoryEnabled: false` in settings) |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Force **every** `Agent`/`Task` dispatch to the foreground (background is otherwise the default). `SendMessage` resume is inherently async and is **not** governed by this switch |
| `CLAUDE_CODE_FORK_SUBAGENT` | Gate `subagent_type: "fork"` dispatch (inherit the parent conversation instead of starting fresh): `1` forces it on, `0` off. **Left unset it is enabled** — a deliberate PiCC choice. Inheritance is honored only for a **main-session** dispatch; nested, print-mode, and `isolation: worktree` forks run with fresh context and say so on the result |
| `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` | Remove the built-in `Explore`/`Plan` agent types (`general-purpose` always stays) |
| `MCP_TIMEOUT` | MCP server connect timeout in ms (default `30000` — 30 s, Claude parity) |
| `MCP_TOOL_TIMEOUT` | MCP tool-call timeout in ms when a server entry sets no `timeout` (default ~28 h, Claude parity; values clamped to [1 s, ~24.8 d]) |
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
   `NotebookRead`, `Edit`, and `MultiEdit` on a matching path — but **not** `Write` or
   `NotebookEdit`. To make a path immutable, add `deny: Edit(<path>)` **and** `deny: Write(<path>)`.
2. **Pathless read calls aren't matched.** `Grep {}` has no path for the matcher to test, yet its
   results can surface protected content. Only a **bare** `deny: Read` forecloses that — at the cost
   of removing `Read`/`Grep`/`Glob`/`NotebookRead` entirely. It does **not** also strip `Edit`/
   `MultiEdit`; the cross in rule 1 applies to a path-scoped rule only.
3. **A shell read needs its own `Bash(...)` deny.** `Bash(cat secrets/x)` is not covered by any
   `Read` rule.

**MCP servers.** Project-scope MCP servers (`.mcp.json`, or `mcpServers` in the committed
`.claude/settings.json`) are pending by default and never start until you approve them. Approve
selected servers in user settings or a clean, user-controlled, untracked `.claude/settings.local.json`
with a named `"enabledMcpjsonServers"` list. Each UTF-16 code unit outside ASCII letters, digits,
`_`, and `-` becomes `_`; an astral symbol therefore becomes `__`. One persisted named approval can
therefore match a differently named current or future server; re-review aliases when project MCP names change.
`"enableAllProjectMcpServers": true` instead
trusts all current and future project servers; do not use it as a shortcut for a large named list.
Decline with `"disabledMcpjsonServers"`, which always wins and silences the pending notice.
Approvals in a git-tracked `settings.local.json` cannot work.
Immediately put explicit named approvals in user-level `~/.claude/settings.json`, or wait for a
reviewed repository change to stop tracking or remove the local path, then create a fresh untracked
file from scratch. Never reuse project-supplied MCP content.

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
| Checkpoint says work is paused, or a print/RPC command appears finished without `checkpoint-resumed` | Reopen the exact persisted session before recovery; an ephemeral headless session instead requires a replacement session and resent input. For operational exhaustion, run `/compact`, then explicitly continue. For a hook block, repair/disable the hook or allow manual compaction first. For any post-commit restoration/startup failure, do **not** compact again; start a new session and resend retained input. In JSON/RPC inspect uncorrelated `picc-checkpoint-lifecycle` categories `checkpoint-exhausted`, `checkpoint-cancelled`, and `checkpoint-resumed`. RPC acknowledgement and print stdout do not prove logical completion; outside the TUI, exit status **3** does report that a main-session checkpoint gave up. |
| `picc -p` exited with status **3** | A main-session checkpoint gave up: PiCC paused the work for context compaction and it never resumed, so stdout is a partial answer. Read the `PiCC: ` line on stderr — or the `picc-checkpoint-lifecycle` entries under `--mode json`/RPC — for which ending it was and what to resend. The status is latched for the process: a later recovery does not clear it, and a subagent checkpoint never sets it. |
| `picc -p` finished but a subagent's output never appeared | Background is the default and a one-shot print run has no next turn to deliver it on. Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for scripted runs, or collect with `TaskOutput` before the run ends. |
| Subagents can't spawn subagents / nested fan-out flattened | PiCC defaults to **main-session-only** (`subagents.maxDepth: 1`) — subagents don't recurse by default. Set `subagents.maxDepth` to a positive integer greater than 1 in `.claude/settings.json`; see "Subagent dispatch controls" above. `/doctor` also shows the current nesting posture. |
| Unexpected skills/agents from plugins | PiCC loads a plugin's content only when that plugin is **enabled** in Claude Code (settings `enabledPlugins`). A cloned marketplace under `~/.claude/plugins/marketplaces/` is just a catalog — its plugins stay dormant until enabled. `/doctor` reports how many are available but disabled. |
| A plugin you enabled isn't loading | Confirm it's listed truthy in `enabledPlugins` as `name@marketplace`, and that it isn't in `~/.claude/plugins/blocklist.json`. |
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

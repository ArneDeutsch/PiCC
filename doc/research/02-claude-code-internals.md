# Claude Code Internals: Extensibility Mechanisms (Reverse-Engineering Reference)

**Purpose:** Document how Anthropic's Claude Code CLI/harness implements its extensibility features, in enough detail to re-implement them faithfully in a new harness targeting GPT/Codex models.

**Date of research:** 2026-07-11. Claude Code was at the **v2.1.x** line at this time (docs cite specific behaviors gated to versions like v2.1.196–2.1.205). Where behavior is version-specific, it is flagged inline. Some feature surface (agent teams, forks, channels, remote control) is newer and evolving.

**Source quality:** Nearly everything below is drawn from **primary/official docs** at `code.claude.com/docs` and `platform.claude.com/docs`. A handful of settings fields are marked **[community-inferred / unverified]** where the only source was a secondary write-up or a summarizing fetch that could not be confirmed against the canonical settings page. Every URL is listed in the Sources section.

> **Important terminology note (mid-2026):** In Claude Code, **"custom slash commands" have been merged into Skills.** A file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy` and behave the same way. Legacy `.claude/commands/*.md` files still work. Skills are the modern, superset mechanism. This document therefore treats Skills as primary and covers slash-command specifics as a subset (Section 5).

> **Tool rename note:** As of v2.1.63 the **`Task` tool was renamed `Agent`**. `Task(...)` still works as an alias in settings and agent definitions. This doc uses `Agent`.

---

## 1. Agent Skills (`.claude/skills/<name>/SKILL.md`)

Skills are modular, filesystem-based capabilities. Each skill is a **directory** whose entrypoint is `SKILL.md` (YAML frontmatter + Markdown body), optionally bundling reference docs, templates, and executable scripts. Claude Code skills implement the open **Agent Skills standard** (agentskills.io) plus Claude-Code-specific extensions (invocation control, subagent execution, dynamic context injection).

### 1.1 SKILL.md file format

```yaml
---
name: my-skill
description: What this skill does and, crucially, WHEN to use it.
allowed-tools: Read Grep
disable-model-invocation: false
---

# My Skill

## Instructions
Step-by-step guidance Claude follows when the skill is invoked.

## Additional resources
- For complete API details, see [reference.md](reference.md)
```

**Frontmatter fields (Claude Code):** All fields are optional; only `description` is *recommended* (so Claude knows when to auto-trigger). Note this differs from the API/claude.ai standard, where `name` + `description` are both required.

| Field | Purpose |
|---|---|
| `name` | Display label in skill listings. **Defaults to the directory name.** Does NOT set the invoked command name except for a plugin-root SKILL.md. Standard constraints: ≤64 chars, lowercase letters/numbers/hyphens, no XML tags, cannot contain reserved words "anthropic"/"claude". |
| `description` | What the skill does + when to use it; Claude matches this to decide auto-invocation. If omitted, the first paragraph of the body is used. Combined `description` + `when_to_use` is truncated at **1,536 chars** in the listing (`skillListingMaxDescChars` configurable). Put the key use case first. |
| `when_to_use` | Extra trigger phrases / example requests; appended to `description` in the listing (counts toward the 1,536 cap). |
| `argument-hint` | Autocomplete hint, e.g. `[issue-number]` or `[filename] [format]`. |
| `arguments` | Named positional args for `$name` substitution. Space-separated string or YAML list; names map to positions in order. |
| `disable-model-invocation` | `true` = only the user can invoke (via `/name`); removes the description from Claude's context and blocks preloading/scheduled-task invocation. Default `false`. |
| `user-invocable` | `false` = hide from the `/` menu; only Claude invokes. Default `true`. |
| `allowed-tools` | Tools **pre-approved** while this skill is active (no per-use prompt). Does NOT restrict the pool. Space/comma string or YAML list. Accepts scoped Bash patterns, e.g. `Bash(git add *) Bash(git commit *)`. |
| `disallowed-tools` | Tools removed from the pool while the skill is active. Restriction clears on the user's next message. |
| `model` | Model while the skill is active (rest of current turn only, not saved). Same values as `/model`, or `inherit`. |
| `effort` | Effort level while active: `low`/`medium`/`high`/`xhigh`/`max`. |
| `context` | `fork` = run the skill in a forked subagent context (SKILL.md body becomes the subagent prompt). |
| `agent` | Which subagent type executes when `context: fork` (e.g. `Explore`, `Plan`, `general-purpose`, or a custom agent). Defaults to `general-purpose`. |
| `hooks` | Hooks scoped to this skill's lifecycle. |
| `paths` | Glob patterns limiting auto-activation to matching files (same format as `.claude/rules/` path scoping). |
| `shell` | `bash` (default) or `powershell` for `` !`cmd` `` injection blocks. |

### 1.2 Progressive disclosure (three levels)

This is the core mechanic and the token-efficiency claim:

| Level | When loaded | Cost | Content |
|---|---|---|---|
| **1 – Metadata** | Always, at startup, injected into the system prompt / a skill listing | ~100 tokens/skill | `name` + `description` (+`when_to_use`) |
| **2 – Instructions** | When the skill is triggered (auto or `/name`) | < ~5k tokens | Full SKILL.md body |
| **3 – Resources/code** | On demand, referenced from the body | Effectively unlimited | Bundled files (read via bash) and scripts (executed; code never enters context, only stdout does) |

**Runtime flow (API/claude.ai model):** Claude has a VM with filesystem + bash. At startup only Level-1 metadata is in context. When a request matches a description, Claude **reads SKILL.md via bash** into context (Level 2). If the body references `reference.md` or a schema, Claude reads those too (Level 3). If the body says to run `scripts/validate.py`, Claude runs it via bash and only the stdout returns.

**In Claude Code specifically:** skill *descriptions* are loaded into context as a listing so Claude knows what's available; the full body loads only on invocation. The listing has a **character budget = 1% of the model's context window** (`skillListingBudgetFraction`, default `0.01`; or fixed via `SLASH_COMMAND_TOOL_CHAR_BUDGET`). When it overflows, descriptions are dropped starting from least-used skills; names are always kept.

**Re-implementation note for a GPT harness:** You need (a) a discovery pass that enumerates skill dirs and emits a compact `name + description` catalog into the system prompt; (b) a mechanism for the model to request a skill body — Claude Code literally lets the model `Read`/bash the `SKILL.md`, OR exposes a `Skill` tool. Either works. (c) When the body references relative files, resolve them relative to the skill directory (see `${CLAUDE_SKILL_DIR}` below).

### 1.3 Skill content lifecycle (important runtime detail)

- On invocation, the **rendered** SKILL.md enters the conversation as a single message and **stays for the rest of the session**. Claude Code does not re-read the file on later turns → write standing instructions, not one-time steps.
- Re-invoking a skill whose rendered content is identical → a short "already loaded" note instead of a duplicate copy (as of v2.1.202).
- Under auto-compaction: the most recent invocation of each skill is re-attached after the summary, keeping the first 5,000 tokens each, sharing a combined 25,000-token budget (filled most-recent-first).

### 1.4 Bundled resources and relative references

Directory layout:

```
my-skill/
├── SKILL.md          # required entrypoint
├── reference.md      # loaded on demand
├── examples.md
└── scripts/
    └── helper.py     # executed, not loaded into context
```

Reference files from the body so Claude knows what they hold: `see [reference.md](reference.md)`. Keep SKILL.md under ~500 lines; push detail to sibling files.

**String substitutions available in the body (and in `allowed-tools`):**

| Variable | Meaning |
|---|---|
| `$ARGUMENTS` | All args as typed. If absent from body, `ARGUMENTS: <value>` is appended. |
| `$ARGUMENTS[N]` / `$N` | 0-based positional arg (shell-style quoting; quote multi-word values). |
| `$name` | Named arg declared in `arguments:` frontmatter. |
| `${CLAUDE_SESSION_ID}` | Current session ID. |
| `${CLAUDE_EFFORT}` | Current effort level. |
| `${CLAUDE_SKILL_DIR}` | Directory containing this SKILL.md (use to reference bundled scripts regardless of cwd). |
| `${CLAUDE_PROJECT_DIR}` | Project root (v2.1.196+). Works in body and in `allowed-tools`. |

Escape a literal `$` before a digit/`ARGUMENTS`/arg-name with a backslash (`\$1.00`).

**Dynamic context injection (preprocessing, before Claude sees anything):**

```markdown
## Current changes
!`git diff HEAD`

## Environment
```!
node --version
git status --short
```
```

The `` !`cmd` `` inline form (only recognized at line start or after whitespace) and the fenced ` ```! ` block run shell commands and **replace the placeholder with stdout** before the content reaches the model. Runs once; output is not re-scanned. Disable org-wide with `"disableSkillShellExecution": true`.

### 1.5 Locations and precedence

| Level | Path | Applies to |
|---|---|---|
| Enterprise/managed | managed-settings dir | All org users |
| Personal | `~/.claude/skills/<name>/SKILL.md` | All your projects |
| Project | `.claude/skills/<name>/SKILL.md` | This project (commit to VCS) |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Where plugin enabled |

**Precedence when names collide:** enterprise > personal > project, and any of these overrides a **bundled** skill of the same name. Plugin skills are namespaced `plugin-name:skill-name` so they never collide. If a `.claude/commands/` file and a skill share a name, the **skill wins**.

- **Nested/monorepo:** project skills load from `.claude/skills/` in the cwd and every parent up to repo root. When Claude reads/edits a file in a subdir, that subdir's `.claude/skills/` become available on demand. A nested skill that clashes by name gets a directory-qualified name, e.g. `apps/web:deploy` (invoke root with `/deploy`, nested explicitly with `/apps/web:deploy`). Requires v2.1.203+.
- **`--add-dir`:** `.claude/skills/` inside an added dir IS loaded (exception to the general rule that add-dir grants file access only). The `permissions.additionalDirectories` *setting* does NOT load skills.
- **Live reload:** editing SKILL.md in a watched dir takes effect within the session; creating a *new top-level* skills dir needs a restart.

### 1.6 How a skill's invoked command name is derived

The frontmatter `name` sets the *label*, not the typed command (except plugin-root SKILL.md). The typed name comes from location:

| Location | Command name from |
|---|---|
| `~/.claude/skills/deploy-staging/` or project | directory name → `/deploy-staging` |
| Nested with clash | `apps/web/.claude/skills/deploy/` → `/apps/web:deploy` |
| `.claude/commands/deploy.md` | filename → `/deploy` |
| Plugin `my-plugin/skills/review/` | `/my-plugin:review` |
| Plugin-root `SKILL.md` with `name: review` | `/my-plugin:review` (here `name` IS used) |

### 1.7 Bundled skills

Shipped and available every session unless `disableBundledSkills` is set: `/doctor`, `/code-review`, `/batch`, `/debug`, `/loop`, `/claude-api`, `/run`, `/verify`, `/run-skill-generator`, etc. They are prompt-based (instructions Claude orchestrates), not fixed logic. `skillOverrides` in settings can set each skill to `"on"`, `"name-only"`, `"user-invocable-only"`, or `"off"`.

---

## 2. Subagents (`.claude/agents/<name>.md`)

A subagent is a specialized worker with its own **isolated context window**, system prompt, tool access, and permissions. When a task matches a subagent's `description`, Claude delegates; the subagent works independently and returns **only its final summary** to the main conversation. This is the key context-preservation mechanism.

### 2.1 File format

Markdown file: YAML frontmatter (config) + body (the subagent's system prompt).

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices. Use proactively after code changes.
tools: Read, Glob, Grep
model: sonnet
---

You are a code reviewer. When invoked, analyze the code and provide
specific, actionable feedback on quality, security, and best practices.
```

The subagent receives **only** this system prompt + basic env (working dir) — not the full Claude Code system prompt.

### 2.2 Frontmatter fields (complete)

Only `name` and `description` are required.

| Field | Notes |
|---|---|
| `name` | Lowercase + hyphens. Hooks receive it as `agent_type`. Filename need not match. |
| `description` | When to delegate. Include "use proactively" to encourage automatic delegation. This is the routing trigger. |
| `tools` | Allowlist. **Omit = inherit all** main-conversation tools + MCP tools. Comma-separated. Supports `mcp__<server>` / `mcp__<server>__*`. Use `skills` (not listing `Skill`) to preload skills. |
| `disallowedTools` | Denylist, removed from inherited/specified set. Applied *before* `tools`. `mcp__*` removes all MCP. |
| `model` | `sonnet`/`opus`/`haiku`/`fable`, a full ID (e.g. `claude-opus-4-8`), or `inherit`. **Default `inherit`.** |
| `permissionMode` | `default`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions`/`plan` (+`manual` alias for `default`, v2.1.200+). Ignored for plugin subagents. |
| `maxTurns` | Cap on agentic turns. |
| `skills` | Skills to **preload** (full content injected at startup, not just description). |
| `mcpServers` | MCP servers scoped to this subagent (inline definitions or name references). Ignored for plugin subagents. |
| `hooks` | Lifecycle hooks active only while this subagent runs. `Stop` → converted to `SubagentStop`. Ignored for plugin subagents. |
| `memory` | Persistent memory scope: `user` / `project` / `local` (see below). |
| `background` | `true` = always run in background. Default (v2.1.198+): subagents run in background by default; Claude foregrounds when it needs the result. |
| `effort` | `low`/`medium`/`high`/`xhigh`/`max`; overrides session effort. |
| `isolation` | `worktree` = run in a temporary git worktree (isolated repo copy, branched from default branch; auto-cleaned if no changes). |
| `color` | Display color: red/blue/green/yellow/purple/orange/pink/cyan. |
| `initialPrompt` | Auto-submitted first user turn when the agent runs as the main session (via `--agent`/`agent` setting). |

**Tools unavailable to subagents even if listed:** `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` (unless `permissionMode: plan`), `ScheduleWakeup`, `WaitForMcpServers`.

**Tool-resolution rule:** if both `tools` and `disallowedTools` are set, `disallowedTools` applies first, then `tools` resolves against the remainder; a tool in both is removed.

### 2.3 Locations and precedence

| Location | Scope | Priority |
|---|---|---|
| Managed settings | Org-wide | 1 (highest) |
| `--agents` CLI flag (JSON) | Session only | 2 |
| `.claude/agents/` | Project | 3 |
| `~/.claude/agents/` | User (all projects) | 4 |
| Plugin `agents/` dir | Where plugin enabled | 5 (lowest) |

Both project and user dirs are scanned **recursively** (subfolders allowed; identity comes only from `name`). Project agents are discovered by walking up from cwd to repo root; nearest definition wins on clashes (v2.1.178+). Plugin subfolders DO become part of the scoped id (`my-plugin:review:security`). Live-watched: adding/editing a file takes effect within seconds, no restart (unless the `agents` dir didn't exist at session start).

`--agents` JSON uses the same fields (with `prompt` instead of the markdown body): `description`, `prompt`, `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, `initialPrompt`, `memory`, `effort`, `background`, `isolation`, `color`.

### 2.4 Built-in subagents

| Agent | Model | Tools | Purpose |
|---|---|---|---|
| **Explore** | inherits (capped at Opus on Claude API; v2.1.198+) | read-only (Write/Edit denied) | codebase search/discovery. One-shot, returns no agent ID (not resumable). Skips CLAUDE.md + git status. |
| **Plan** | inherits | read-only | research during plan mode. Skips CLAUDE.md + git status. |
| **general-purpose** | inherits | all | complex multi-step work. Resumable. |
| statusline-setup | Sonnet | — | `/statusline` |
| claude-code-guide | Haiku | — | Q&A about Claude Code |

Disable built-ins: `permissions.deny: ["Agent(Explore)"]`; disable all delegation by denying the `Agent` tool; `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` (v2.1.198+) removes Explore/Plan; `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` in headless/SDK.

### 2.5 Invocation: automatic vs explicit; the Agent tool

- **Automatic delegation:** Claude matches the user's request against subagent `description`s + current context and delegates via the **`Agent` tool** (formerly `Task`). "use proactively" in the description encourages this.
- **Natural language:** name the subagent in your prompt; Claude decides.
- **@-mention:** `@"code-reviewer (agent)"` or manual `@agent-<name>` / `@agent-my-plugin:code-reviewer` — guarantees that subagent runs for one task. Your full message still goes to Claude, which *writes the subagent's task prompt*.
- **Session-wide:** `claude --agent code-reviewer` makes the main thread take on that subagent's prompt/tools/model (replaces the default system prompt like `--system-prompt`; CLAUDE.md still loads). Or `"agent": "code-reviewer"` in `.claude/settings.json`.
- **Restrict spawnable subagents (for a main `--agent`):** `tools: Agent(worker, researcher), Read, Bash` — allowlist. Bare `Agent` = any; omit `Agent` = none.

### 2.6 What loads into a subagent + what returns

**Fresh isolated context** contains: the agent's own system prompt + env; the delegation/task message Claude writes; the full CLAUDE.md/memory hierarchy (except Explore/Plan); a git-status snapshot (except Explore/Plan, or when `includeGitInstructions:false`); preloaded skills. It does **not** see conversation history (except a fork — see §2.9), previously invoked skills, or files already read. **Returns:** only its final text summary. (Nested subagents up to depth 5; only the top-level summary reaches the user.)

**Resume:** on completion Claude gets an `agentId`; Claude resumes via the `SendMessage` tool (`to` = id or name) with full prior context. Transcripts persist at `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`.

### 2.7 Persistent subagent memory

`memory: user|project|local` gives a directory that survives across conversations:

| Scope | Location |
|---|---|
| `user` | `~/.claude/agent-memory/<name>/` |
| `project` | `.claude/agent-memory/<name>/` |
| `local` | `.claude/agent-memory-local/<name>/` |

When enabled, the system prompt gets memory read/write instructions + the first 200 lines / 25KB of `MEMORY.md`; Read/Write/Edit are auto-enabled.

### 2.8 Skills vs subagents

Use a **subagent** when work is verbose/self-contained and returns a summary, or to enforce tool restrictions. Use a **skill** (runs in the *main* conversation context) for reusable prompts/workflows. They compose: a skill with `context: fork` runs in a subagent; a subagent with `skills:` preloads skill content.

### 2.9 Fork the current conversation (`subagent_type: "fork"`)

`subagent_type: "fork"` is the one subagent type that does **not** start fresh: it **inherits the parent conversation**. Documented Claude semantics (Claude sub-agents docs; PiCC ticket [#28](https://github.com/ArneDeutsch/PiCC/issues/28)):

- The fork starts with the **parent session's full message history** already in context, so it can answer about and act on what the parent was doing without being re-told.
- It runs with the **same system prompt, tools, and model** as the parent, and — because it is byte-identical to the parent up to the fork point — **shares the prompt cache** (a cost saving over a fresh subagent).
- **Output isolation is kept**: only the fork's final summary returns to the parent; its intermediate steps do not leak back.
- Gated by the **`CLAUDE_CODE_FORK_SUBAGENT`** environment variable; introduced behind a version gate (~v2.1.117+) as a staged rollout.
- A **fork cannot spawn another fork** (no recursive fork inheritance).
- Fork mode also **strips the Agent tool's `run_in_background` parameter** and forces every spawn to background.

**PiCC's implementation (F16) and its disclosed limits:**

- **Main-session dispatch only.** Fork inheritance is honored only for a dispatch made *by the main/root session* (`opts.depth === 1`). A `"fork"` requested from within a nested subagent cannot reach its own dispatcher's conversation — the runtime only exposes the root transcript — so it **visibly degrades** to fresh context rather than seed the *wrong* (root) conversation into it. This is a security boundary as much as a fidelity one: it stops a tool-restricted subagent from forking the root conversation into itself.
- **System prompt is a same-context *reconstruction*, not byte-identical.** PiCC is an extension *on* a Pi-created session and does not own Pi's assembled base prompt, so the fork reuses the parent's project rules/skills/memory/steering reconstruction. Consequence: the fork **loses the prompt-cache cost saving** a byte-identical fork would get.
- **File-based seeding via `SessionManager.forkFrom`.** The fork seeds a **brand-new persisted child transcript** from the parent's on-disk transcript file (the parent file is never touched). It is forced **non-resumable** — the inherited context is the parent conversation *at fork time* and cannot be safely re-derived, so `SendMessage` refuses it. Staleness caveat: the seed is a point-in-time copy of the parent transcript file.
- **Unset ⇒ enabled.** PiCC treats `CLAUDE_CODE_FORK_SUBAGENT` unset as **on** (a deliberate parity choice, since Claude's unset default is an under-specified staged rollout); `=1` forces on, a present-but-off value (`=0`/`false`/…) forces an explicit visible degrade. This divergence is *directional*: PiCC may inherit where a staged-rollout Claude with fork unset would run fresh.
- **Model overrides stay honored.** The inherited parent model is still overridden by an operator `CLAUDE_CODE_SUBAGENT_MODEL` env and by a per-call `model` argument on the fork dispatch.
- **Fork-cannot-spawn-fork** is enforced via a runtime-set dispatcher marker (a fork's granted Agent/Task tools carry it); a nested fork request is a visible refusal, not a silent no-op. (The exact Claude enforcement mechanism is undocumented — this is INFERRED.)
- **Reserved-name edge — `context: fork` skill named `fork`.** `"fork"` is a reserved subagent type, so a *skill* with `context: fork` whose frontmatter also names its agent literally `fork` dispatches with `subagent_type: "fork"` and is therefore honored as a **conversation-inheriting** fork (not the skill-`context:fork` max-isolation path). Ordinary `context: fork` skills dispatch under a `fork:<skill>` type and are unaffected. This is a pathological naming collision; PiCC treats it as reserved-name-wins (consistent with a project agent named `fork` being shadowed by the reserved type). Whether Claude reserves `agent: fork` *inside* a skill is unverified against its docs — flagged as a potential follow-up.
- **Every non-inheriting case degrades *visibly*.** Env-off, nested dispatcher, no parent transcript (print/headless/no-session), fork-spawns-fork, SDK cannot fork, or a `forkFrom` throw all run with fresh context **and** surface a specific footer notice (never the generic "unknown subagent_type" warning). By-design cases (env off, fork-spawns-fork) are toned calmly; genuine can't-do cases are warnings.
- **Deferred / not adopted:** print/headless/no-session support; the `run_in_background`-removal side effect (PiCC keeps F15 background-by-default and **retains** `run_in_background:false` as a synchronous selector); `isolation:"worktree"` on a fork (the fork shares the parent cwd); the version gate is not mirrored. PiCC also deliberately does **not** reproduce Claude's interactive named-fork zero-context regression ([anthropics/claude-code#76019](https://github.com/anthropics/claude-code/issues/76019)).

---

## 3. Hooks (`settings.json` → `hooks`)

Hooks are user-defined handlers that fire at lifecycle events. They are the **deterministic** enforcement layer (vs CLAUDE.md, which only shapes behavior).

### 3.1 Where configured

`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed policy settings, plugin `hooks/hooks.json`, and **skill/agent frontmatter**. Disable all with `"disableAllHooks": true` (managed policy can't be disabled by user settings).

### 3.2 Hook events (complete list)

The full mid-2026 event set (with matcher support). The canonical set requested in the brief is bolded:

| Event | Fires | Matcher |
|---|---|---|
| **`SessionStart`** | session begins/resumes | `startup`,`resume`,`clear`,`compact` |
| `Setup` | `--init-only`/`--init`/`--maintenance` | `init`,`maintenance` |
| **`UserPromptSubmit`** | user submits a prompt | none |
| `UserPromptExpansion` | command expands into prompt | command names |
| **`PreToolUse`** | before a tool runs | tool name |
| `PermissionRequest` | permission dialog appears | tool name |
| `PermissionDenied` | tool denied by auto mode | tool name |
| **`PostToolUse`** | after a tool succeeds | tool name |
| `PostToolUseFailure` | after a tool fails | tool name |
| `PostToolBatch` | after a parallel tool batch resolves | none |
| **`Notification`** | notification sent | `permission_prompt`,`idle_prompt`,`auth_success`,`elicitation_*`,`agent_needs_input`,`agent_completed` |
| `MessageDisplay` | while an assistant message displays | none |
| `SubagentStart` | subagent spawned | agent type |
| **`SubagentStop`** | subagent finishes | agent type |
| `TaskCreated` / `TaskCompleted` | task lifecycle | none |
| **`Stop`** | Claude finishes responding | none |
| `StopFailure` | turn ends on API error | error kinds (`rate_limit`, etc.) |
| `TeammateIdle` | agent-team teammate idle | none |
| `InstructionsLoaded` | CLAUDE.md/rules loaded | `session_start`,`nested_traversal`,`path_glob_match`,`include`,`compact` |
| `ConfigChange` | config file changes | `user_settings`,`project_settings`,`local_settings`,`policy_settings`,`skills` |
| `CwdChanged` | working dir changes | none |
| `FileChanged` | watched file changes | literal filenames |
| `WorktreeCreate` / `WorktreeRemove` | worktree lifecycle | none |
| **`PreCompact`** | before compaction | `manual`,`auto` |
| `PostCompact` | after compaction | none |
| `Elicitation` / `ElicitationResult` | MCP requests/returns user input | MCP server name |
| **`SessionEnd`** | session terminates | `clear`,`resume`,`logout`,`prompt_input_exit`,`bypass_permissions_disabled`,`other` |

### 3.3 Config shape & matcher syntax

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "if": "Bash(rm *)",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh", "args": [] }
        ]
      }
    ]
  }
}
```

**Matcher** (against tool name for tool events): `"Bash"` exact; `"Edit|Write"` alternatives; `"^Edit$"` regex; `"mcp__.*__write.*"` MCP; `"*"` or omitted = all. Matchers are **unanchored regex** — anchor scoped/hyphenated names (`^db-agent$`). MCP tool names are `mcp__<server>__<tool>`.

**Handler types:** `command` (shell/executable), `http` (POST to a URL), `mcp_tool`, `prompt` (LLM eval), `agent` (subagent eval). Common fields: `if` (permission-rule filter like `Bash(git *)`), `timeout` (s), `statusMessage`, `once`. Command-specific: `command`, `args` (exec form, no shell), `async`, `asyncRewake`, `shell` (`bash`/`powershell`). Path placeholders: `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`.

### 3.4 Input payload (stdin JSON)

**Common (all events):**
```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-...",
  "transcript_path": "/home/user/.claude/projects/.../transcript.jsonl",
  "cwd": "/home/user/my-project",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions",
  "effort": { "level": "low|medium|high|xhigh|max" },
  "hook_event_name": "PreToolUse",
  "agent_id": "uuid",        // subagent only
  "agent_type": "Explore"    // subagent only
}
```

**Tool events (`PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`PermissionRequest`/`PermissionDenied`):**
```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "tool_response": "result text"   // Post* only
}
```
`SessionStart` also gets `source`, `model`, `session_title`.

### 3.5 Output contract

**Exit codes:**

| Code | Meaning | JSON parsed? | Effect |
|---|---|---|---|
| `0` | success | yes | proceed; process stdout JSON |
| `2` | blocking error | no | **block** the action; stderr shown to Claude |
| other | non-blocking error | no | show error, continue (except WorktreeCreate) |

For `UserPromptSubmit`, `UserPromptExpansion`, and `SessionStart`, **plain stdout on exit 0 is injected into the model context** (clean way to add context without JSON).

**JSON output fields (all hooks):**
```json
{
  "continue": true,               // false stops Claude entirely
  "stopReason": "Build failed",   // shown when continue=false
  "suppressOutput": false,        // hide stdout from transcript
  "systemMessage": "Warning text",// shown to user
  "additionalContext": "context for Claude",
  "hookSpecificOutput": { "hookEventName": "PreToolUse", ... }
}
```

**PreToolUse decision control (the block/allow gate):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask" | "defer",
    "permissionDecisionReason": "reason text",
    "updatedInput": { "command": "npm run lint" },  // rewrite tool args
    "additionalContext": "..."
  }
}
```
`allow` skips the permission prompt; `deny` blocks; `ask` forces a prompt; `defer` falls through to normal rules. **`updatedInput` lets a hook rewrite the tool call.**

**PostToolUse:** `hookSpecificOutput.updatedToolOutput`, `additionalContext`; plus top-level `"decision": "block"` + `"reason"`.

**Stop:** `"decision": "block"` + `"reason"` to keep the conversation going, plus `hookSpecificOutput.additionalContext`.

**PermissionRequest:** `hookSpecificOutput.decision.behavior` = `allow|deny`, with `updatedInput` and `rules` (persist rules like `{"resource":"Bash(npm test)","mode":"allow"}`).

Example deny script:
```bash
#!/bin/bash
COMMAND=$(jq -r '.tool_input.command' < /dev/stdin)
if echo "$COMMAND" | grep -q 'rm -rf'; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",
    permissionDecision:"deny",permissionDecisionReason:"Destructive command blocked"}}'
else exit 0; fi
```

### 3.6 Interaction with permissions (critical)

- **PreToolUse hooks run *before* the permission prompt.**
- Hook decisions **do not bypass permission rules.** A matching **deny** rule blocks regardless of a hook returning `allow`; a matching **ask** rule still prompts. Deny-first precedence is preserved.
- A hook that **exits 2 blocks the call before permission rules are even evaluated** — so it overrides allow rules. Pattern: allow bare `Bash`, then a PreToolUse hook that rejects specific commands.

---

## 4. settings.json

### 4.1 File hierarchy & precedence

Highest → lowest:

1. **Managed/policy settings** (cannot be overridden, even by CLI args). Files: `managed-settings.json` + `managed-settings.d/*.json` (merged alphabetically). Locations: macOS `/Library/Application Support/ClaudeCode/`, Linux/WSL `/etc/claude-code/`, Windows `C:\Program Files\ClaudeCode\`. Also deliverable via MDM/registry/server-managed/gateway.
2. **Command-line arguments** (session overrides).
3. **Local project** `.claude/settings.local.json` (gitignored, personal-per-project).
4. **Shared project** `.claude/settings.json` (committed).
5. **User** `~/.claude/settings.json`.

**Merge nuance:** permission rules **merge/accumulate across scopes** and are evaluated deny→ask→allow globally; a deny at *any* level cannot be re-allowed by another level. Other scalar settings follow simple precedence.

### 4.2 Schema (harness-relevant keys)

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": ["Bash(npm run test *)", "Read(~/.zshrc)"],
    "deny":  ["Bash(curl *)", "Read(./.env)", "Read(./.env.*)"],
    "ask":   ["Write(./important_file.js)"],
    "defaultMode": "default",
    "additionalDirectories": ["~/my-monorepo/packages/*"],
    "disableBypassPermissionsMode": "disable",
    "disableAutoMode": "disable"
  },
  "env": { "SOME_VAR": "value" },
  "hooks": { "PreToolUse": [ ... ] },
  "model": "claude-opus-4-1",
  "agent": "code-reviewer",
  "cleanupPeriodDays": 30,
  "includeCoAuthoredBy": true,
  "apiKeyHelper": "/bin/generate_temp_api_key.sh",
  "autoMemoryEnabled": true,
  "claudeMdExcludes": ["**/monorepo/CLAUDE.md"],
  "skillOverrides": { "legacy-context": "name-only", "deploy": "off" }
}
```

**`permissions.defaultMode`** — one of: `default` (a.k.a. `manual`, v2.1.200+), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. (A secondary source claimed values `auto|ask|permissive` — **that is inaccurate**; the canonical modes are the six just listed.)

**Confirmed keys** (from official docs): `permissions.*`, `env`, `hooks`, `model`, `agent`, `cleanupPeriodDays` (default 30), `includeCoAuthoredBy`, `apiKeyHelper`, `autoMemoryEnabled`, `autoMemoryDirectory`, `claudeMd` (managed only), `claudeMdExcludes`, `skillOverrides`, `disableBundledSkills`, `disableSkillShellExecution`, `disableAllHooks`, `skillListingBudgetFraction`, `skillListingMaxDescChars`, `includeGitInstructions`, `sandbox.*`, and the managed-only allowlist keys (`allowManagedPermissionRulesOnly`, `allowManagedMcpServersOnly`, `allowedMcpServers`, `deniedMcpServers`, `strictPluginOnlyCustomization`, `disableSideloadFlags`, `strictKnownMarketplaces`, etc.).

**[community-inferred / unverified]** keys surfaced only by a summarizing fetch and not confirmed on the canonical settings page: `effortLevel`, `companyAnnouncements`, `editorMode`, `autoUpdatesChannel`, `autoMode` (object with `soft_deny`), `attribution`, `availableModels`, `fallbackModel`, `alwaysThinkingEnabled`, `disableArtifact`, `disableAgentView`, `forceLoginMethod`, `forceLoginOrgUUID`. Several (e.g. `availableModels`, `forceLoginMethod`) are referenced elsewhere in official docs and are likely real, but treat exact names/shapes as needing verification before relying on them.

**Worktree keys:** there is no dedicated top-level worktree settings block; worktree behavior is driven per-subagent by the `isolation: worktree` frontmatter field and by `WorktreeCreate`/`WorktreeRemove` hooks. Per-project state (trust, allowed tools) lives in `~/.claude.json`.

**Reload:** `permissions`, `hooks`, `apiKeyHelper`, memory settings hot-reload; `model`/`outputStyle` are read-once (need restart). `ConfigChange` hook fires on detected changes.

---

## 5. Slash commands (`.claude/commands/*.md`) — now a subset of Skills

**Status:** merged into Skills. A `.claude/commands/deploy.md` still works and supports the **same frontmatter** as a SKILL.md body; if a skill and a command share a name, the skill wins. New work should use skills (they add supporting-file dirs + auto-invocation).

### 5.1 Format & frontmatter

```markdown
---
description: Fix a GitHub issue
argument-hint: [issue-number]
allowed-tools: Bash(git add *) Bash(git commit *)
model: sonnet
disable-model-invocation: true
---

Fix GitHub issue $ARGUMENTS following our coding standards.
1. Read the issue
2. Implement the fix
3. Write tests, then commit
```

Relevant frontmatter (shared with skills): `description`, `argument-hint`, `arguments`, `allowed-tools`, `disallowed-tools`, `model`, `disable-model-invocation`, `user-invocable`, `context`/`agent`, `hooks`, `shell`.

### 5.2 Argument substitution

- `$ARGUMENTS` = everything after the command name. If absent from the body, `ARGUMENTS: <input>` is appended.
- `$ARGUMENTS[N]` / `$N` = positional (0-based), shell-quoted.
- `$name` = declared in `arguments:` frontmatter.
- Command name derives from the **filename** (`deploy.md` → `/deploy`); subdirectories namespace the command.
- **Stacking (v2.1.199+):** `/code-review /fix-issue 123` loads both skills and passes `123` to each (up to 6 total).

### 5.3 Bash injection & file refs

- `` !`command` `` (and ` ```! ` blocks) run before the model sees the content; stdout replaces the placeholder. Requires `allowed-tools` to permit the command (e.g. `allowed-tools: Bash(gh *)`).
- `@path` references files (via CLAUDE.md-style import in memory files; in command/skill bodies `@` mentions pull file context).

---

## 6. Memory / CLAUDE.md

Two systems, both loaded at the start of every conversation: **CLAUDE.md** (you write instructions) and **auto memory** (Claude writes learnings). Both are context, not enforced config — for hard enforcement use a PreToolUse hook.

### 6.1 CLAUDE.md hierarchy (load order: broad → specific)

| Scope | Location |
|---|---|
| Managed policy | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`; Linux/WSL `/etc/claude-code/CLAUDE.md`; Windows `C:\Program Files\ClaudeCode\CLAUDE.md` (or `claudeMd` key in managed-settings.json) |
| User | `~/.claude/CLAUDE.md` |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md` |
| Local | `./CLAUDE.local.md` (gitignore it) |

### 6.2 Auto-loading & directory walk

Claude walks **up** the tree from cwd, collecting `CLAUDE.md` + `CLAUDE.local.md` at each level. All discovered files are **concatenated** (not overridden), ordered root→cwd (closer files read last, higher effective priority); within a dir, `CLAUDE.local.md` follows `CLAUDE.md`. **Subdirectory** CLAUDE.md files are NOT loaded at launch — they load **on demand when Claude reads a file in that subdir** (this is the nested-injection behavior). Managed → user → project → local is the effective precedence.

Block-level HTML comments (`<!-- ... -->`) are stripped before injection (context-free maintainer notes). Delivered as a **user message after the system prompt**, so no strict-compliance guarantee.

### 6.3 `@import` syntax

`@path/to/file` imports and inlines a file at launch (relative to the importing file, or absolute, or `~/`). Recursive up to **4 hops**. Skipped inside code spans/fences — backtick-wrap `` `@README` `` to keep literal. First-time external imports show an approval dialog. Example:

```markdown
See @README for overview and @package.json for npm commands.

# Additional
- git workflow @docs/git-instructions.md
- @~/.claude/my-project-instructions.md
```

`AGENTS.md` interop: Claude reads only `CLAUDE.md`; do `@AGENTS.md` (import) or symlink.

### 6.4 `.claude/rules/` (modular, path-scoped instructions)

`.claude/rules/*.md` (recursive). Rules without `paths:` load like `.claude/CLAUDE.md`. With `paths:` (glob list, gitignore-style), they load only when Claude touches matching files:

```markdown
---
paths:
  - "src/api/**/*.ts"
---
# API Rules
- All endpoints must validate input
```
User-level `~/.claude/rules/` load before project rules (lower priority). `claudeMdExcludes` (glob, any settings layer, arrays merge) skips ancestor files; managed CLAUDE.md cannot be excluded.

### 6.5 Auto memory (v2.1.59+)

Per-repo directory `~/.claude/projects/<project>/memory/` with `MEMORY.md` (index) + topic files. First **200 lines / 25KB** of `MEMORY.md` loaded every session; topic files read on demand. Toggle via `/memory` or `autoMemoryEnabled` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; relocate with `autoMemoryDirectory`. Machine-local, shared across worktrees of a repo.

**Compaction:** project-root CLAUDE.md is re-read from disk and re-injected after `/compact`; nested subdir CLAUDE.md files are NOT re-injected until Claude next reads a file there. `/init` generates a starting CLAUDE.md (`CLAUDE_CODE_NEW_INIT=1` for the interactive multi-phase flow).

---

## 7. The permission model

Enforced by the harness (not the model). Tiers: read-only tools need no approval; Bash needs approval (allowlistable permanently per project+command); file edits need approval (until session end).

### 7.1 Rule lists & precedence

- **allow** → run without prompting; **ask** → always prompt; **deny** → never run.
- **Evaluation order: deny → ask → allow.** First match wins; specificity does NOT reorder. A broad `Bash(aws *)` deny blocks even a narrower `Bash(aws s3 ls)` allow. Deny/ask from *any* scope beat allow from *any* scope.
- A **bare tool name** deny (`Bash`) removes the tool from context entirely; a **scoped** deny (`Bash(rm *)`) leaves the tool but blocks matching calls.

### 7.2 Rule syntax `Tool` / `Tool(specifier)`

**Bash:** `*` wildcard at any position; matches any sequence incl. spaces. `Bash(ls *)` enforces a word boundary (matches `ls -la`, not `lsof`); `Bash(ls*)` matches both. `:*` suffix = trailing ` *`. **Shell-operator aware:** a rule must match each subcommand independently (separators `&& || ; | |& & newline`). Process wrappers `timeout`/`time`/`nice`/`nohup`/`stdbuf` (and bare `xargs`) are stripped before matching. A built-in read-only set (`ls`,`cat`,`echo`,`pwd`,`head`,`tail`,`grep`,`find`,`wc`,`which`,`diff`,`stat`,`du`,`cd`, read-only `git`) never prompts. Compound-command approvals save one rule per subcommand (≤5).

**Read/Edit** (Edit = all file-editing tools; also applied best-effort to Grep/Glob/`@file`/IDE context, and to Bash file commands like `cat`/`sed`). Gitignore-style patterns with four anchor types:

| Pattern | Anchor |
|---|---|
| `//path` | filesystem root (true absolute) |
| `~/path` | home dir |
| `/path` | **settings-source dir** (project root for project settings — NOT filesystem root) |
| `path` / `./path` | current dir |

Bare filenames match at any depth (`Read(.env)` ≡ `Read(**/.env)`). `*` = within a segment; `**` = across dirs. Symlinks: allow rules require both symlink+target to match; deny rules fire if either matches.

**WebFetch:** `WebFetch(domain:example.com)`; `domain:*.example.com` = subdomains only (not the apex); `domain:*` ≡ bare `WebFetch`. Non-leading wildcards match only between dots.

**MCP:** `mcp__server`, `mcp__server__*`, `mcp__server__tool`. Allow-rule tool-name globs require a literal `mcp__<server>__` prefix.

**Agent:** `Agent(Explore)`, `Agent(my-custom-agent)`. **Parameter matching** (deny/ask only): `Agent(model:opus)`, `Agent(isolation:worktree)`, `Bash(run_in_background:true)` — one param per rule, `*` wildcard allowed; canonicalized fields (`command`, `file_path`, `url`, etc.) are NOT matchable this way.

**Cd:** `Cd(~/code/*)` gates the `/cd` command (user-only, not model-invocable).

### 7.3 Permission modes

`default`(=`manual`), `acceptEdits` (auto-accept edits + common fs commands `mkdir`/`touch`/`mv`/`cp` in cwd/additionalDirectories), `plan` (read-only exploration), `auto` (background classifier verifies actions match your request), `dontAsk` (auto-deny unless pre-allowed), `bypassPermissions` (skip prompts except explicit `ask` rules and `rm -rf /`/`~` circuit-breakers). Lock down with `permissions.disableBypassPermissionsMode`/`disableAutoMode` = `"disable"`.

### 7.4 Additional directories

`--add-dir` / `/add-dir` extend file access AND load a few config types (skills w/ live reload, subagents, `enabledPlugins`/`extraKnownMarketplaces` keys, CLAUDE.md only if `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`). `permissions.additionalDirectories` (setting) grants **file access only** — no config loading. `/cd` relocates the primary working dir (loads new CLAUDE.md, affects `--resume`).

### 7.5 Permissions ⇄ hooks (recap)

PreToolUse hooks run before the permission prompt and can `allow`/`deny`/`ask`/`defer` or `updatedInput`. But deny/ask rules always apply; a hook exit-2 block precedes rule evaluation and overrides allow. Workspace trust: project `permissions.allow` + `additionalDirectories` apply only after accepting the workspace-trust dialog (deny/ask always apply). Sandbox (`sandbox.*`) is a complementary OS-level layer for Bash only.

---

## Re-implementation checklist for a GPT/Codex harness

1. **Discovery pass** at session start: enumerate `~/.claude/` and `.claude/` (walking up to repo root) for `skills/*/SKILL.md`, `agents/*.md`, `commands/*.md`, `settings*.json`, `CLAUDE.md`/`CLAUDE.local.md`/`rules/*.md`. Apply precedence (managed > local > project > user, with permission-rule merging).
2. **System prompt assembly:** inject CLAUDE.md hierarchy (as a post-system user message), the skill *listing* (name+description, budget ~1% context), available subagent descriptions, and tool definitions filtered by permission deny-bare-name rules.
3. **Skill trigger:** either expose a `Skill` tool or let the model read `SKILL.md`; render substitutions + run `` !`cmd` `` preprocessing before injection; keep the rendered body resident for the session.
4. **Subagent runtime:** spawn an isolated context (own system prompt = agent body + env; task message; CLAUDE.md unless Explore/Plan; git snapshot; preloaded skills); enforce `tools`/`disallowedTools`/`permissionMode`; return only the final text.
5. **Permission gate** wrapping every tool call: evaluate deny→ask→allow with the matcher semantics in §7; run PreToolUse hooks first (honor exit-2 block and `updatedInput`); then PostToolUse.
6. **Hook engine:** dispatch the events in §3.2 with the stdin JSON payload and the exit-code + JSON-output contract.

---

## Sources

Primary / official (docs.anthropic.com successor domains — `code.claude.com` and `platform.claude.com`):

- Agent Skills overview: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Skill authoring best practices: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Extend Claude with skills (Claude Code): https://code.claude.com/docs/en/skills
- Create custom subagents: https://code.claude.com/docs/en/sub-agents
- Hooks reference: https://code.claude.com/docs/en/hooks
- Settings: https://code.claude.com/docs/en/settings
- Configure permissions: https://code.claude.com/docs/en/permissions
- Memory / CLAUDE.md: https://code.claude.com/docs/en/memory
- Docs index (for discovering pages): https://code.claude.com/docs/llms.txt
- Anthropic engineering blog — Equipping agents for the real world with Agent Skills: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Agent Skills open standard: https://agentskills.io
- Open-source skills repo: https://github.com/anthropics/skills

Community / secondary (used for cross-checking and the hooks event list; flagged where relied upon):

- Claude Code Hooks (2026) — Morphllm: https://www.morphllm.com/claude-code-hooks
- Claude Code Hooks: All 12 Lifecycle Events — claudefa.st: https://claudefa.st/blog/tools/hooks/hooks-guide
- Claude Code Hooks Complete Guide — hidekazu-konishi.com: https://hidekazu-konishi.com/entry/claude_code_hooks_complete_guide.html
- Claude Agent Skills: A First Principles Deep Dive — leehanchung.github.io: https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/
- Claude Code Subagents complete guide — computingforgeeks.com: https://computingforgeeks.com/claude-code-subagents-guide/
- A Mental Model for Claude Code (Skills/Subagents/Plugins) — Level Up Coding: https://levelup.gitconnected.com/a-mental-model-for-claude-code-skills-subagents-and-plugins-3dea9924bf05

**Verification note:** the settings-schema fetch was performed via a summarizing model and introduced at least two inaccuracies (invented `PreRun`/`PostRun` hook events; a `defaultMode` value of `permissive`). Those were discarded in favor of the canonical hooks and permissions pages. Any settings key marked **[community-inferred / unverified]** in §4.2 should be confirmed against the live settings page before implementation.

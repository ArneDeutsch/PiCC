# PiCC ↔ Pi integration contracts

> **Status:** Working design record. Pinned against **Pi v0.80.6** (`@earendil-works/pi-coding-agent`,
> `pi-agent-core`, `pi-ai` — all 0.80.6, verified on npm 2026-07-11). Effective Node floor ≥ 22.19:
> Pi declares ≥ 20, but its bundled undici 8.x (engines ≥ 22.19) crashes on Node 20 at import
> (`worker_threads.markAsUncloneable` missing). We develop on 24.
> Source of truth for every Pi API PiCC builds on. If Pi churns, update here first.
>
> Decision Q1 (fork vs depend): **depend + extension bundle**. Pi is a regular npm dependency;
> PiCC ships as an extension (loaded via `settings.json "extensions"` array, `.pi/extensions/`,
> or `pi -e`) plus a launcher. No fork.

## 1. How PiCC attaches to Pi

Pi extensions are TS modules (loaded via jiti, no compilation) exporting
`default function (pi: ExtensionAPI)` (async allowed; awaited before startup completes).
PiCC is **one extension bundle** with an entry `src/index.ts` that registers everything.

Launch modes we support:
- `pi -e <path-to-picc>` in the target project (dev/test).
- `"extensions": ["<path>"]` in `~/.pi/agent/settings.json` or `.pi/settings.json` (persistent).
- A `picc` launcher (thin wrapper) that runs Pi with the extension preloaded.

## 2. Pi API surface we use (pinned)

| PiCC subsystem | Pi API used |
|---|---|
| System-prompt assembly (CLAUDE.md hierarchy, rules, agent-description catalog, skill listing, steering layer, compat notice) | `pi.on("before_agent_start")` → return `{ systemPrompt }` (chained); `event.systemPromptOptions` for Pi's own context-file/skill view |
| Context injection mid-session (nested CLAUDE.md, path-scoped rules on file touch, skill activation, hook `additionalContext`) | `pi.sendMessage({ customType, content, display }, { deliverAs: "steer" })`; for tool-triggered injection return extra text in `tool_result` patches |
| Deny rules, hook PreToolUse block/ask, per-agent tools gating at orchestrator level | `pi.on("tool_call")` → `{ block: true, reason }`; `event.input` is mutable (hook `updatedInput`) |
| PostToolUse / PostToolUseFailure hooks, output rewriting | `pi.on("tool_result")` → partial patch `{ content, details, isError }` |
| SessionStart / SessionEnd hooks | `pi.on("session_start")` / `pi.on("session_shutdown")` |
| UserPromptSubmit hook | `pi.on("input")` → `continue/transform/handled` (stdout context → `transform`) |
| Stop hook | `pi.on("agent_settled")` + `pi.sendUserMessage(..., { deliverAs: "followUp" })` to continue when a Stop hook blocks stopping |
| PreCompact/PostCompact + instruction re-injection | `pi.on("session_before_compact")` (can supply custom summary; we append preserved-instructions block), `pi.on("session_compact")` |
| Custom tools: `Agent`, `EnterWorktree`, `ExitWorktree`, `WebFetch`, `WebSearch`, `Grep`, `Glob`, `TaskCreate/...`, degrade stubs | `pi.registerTool({ name, description, parameters: TypeBox, execute, prepareArguments? })`; throw ⇒ `isError`; `terminate: true` supported |
| Slash commands: user-invocable skills, legacy commands, `/doctor`, `/quota`, `/compat` | `pi.registerCommand(name, { description, handler, getArgumentCompletions })`; command handlers get `ExtensionCommandContext` |
| Worktree cwd swap (load-bearing) | Override built-in tools: re-register `bash`/`read`/`write`/`edit`/`grep`/`find`/`ls` wrappers that resolve paths/cwd through a mutable `EffectiveCwd`; built-ins created per-cwd via `createBashTool(cwd, { spawnHook })`, `createReadTool(cwd, …)` etc. Built-in renderers are inherited when we omit renderCall/renderResult. |
| Subagent runtime (fresh context, parallel, per-agent tools/model, verbatim return) | SDK: `createAgentSession({ cwd, tools, customTools, model, thinkingLevel, resourceLoader: new DefaultResourceLoader({ systemPromptOverride, agentsFilesOverride, skillsOverride, extensionFactories }), sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory(), authStorage, modelRegistry })`; final assistant message read from `session.messages` — returned **verbatim** |
| Model/effort control | `pi.setModel(model)`, `ctx.modelRegistry.find(provider,id)`, `pi.setThinkingLevel("off"…"max")` — Claude `effort` maps onto thinking levels |
| Env & exec | `pi.exec(cmd, args, { signal, timeout })` for git/hook commands; hooks additionally need shell execution via `node:child_process` (stdin JSON contract Pi's exec doesn't cover: we use `spawn` directly) |
| Quota | `ctx.getContextUsage()`; subscription quota via provider headers on `after_provider_response` (rate-limit headers) + `/login`-stored auth; degrade gracefully if absent |
| Compat notices / UX | `ctx.ui.notify`, `pi.appendEntry` + `pi.registerEntryRenderer` (TUI-only), `ctx.ui.setStatus` |
| Skill listing into system prompt | We do **not** feed `.claude/skills` through Pi's own skill discovery (Pi's XML listing + `/skill:` semantics differ from Claude's budgeted listing, `$ARGUMENTS`, shell-injection, `context: fork`). PiCC owns the Claude skill pipeline end-to-end: listing text appended in `before_agent_start`, activation via our own `Skill` tool + slash commands. Pi's native skill/command discovery of `.pi/`/`.agents/` stays untouched. |

## 3. Key mechanics decisions

### 3.1 cwd swap for worktrees
Pi has no session-cwd mutation API. We keep a session-scoped `CwdState` (`base`, `effective`).
At extension load we re-register all built-in tools with wrappers that build the real tool
per-call via `create*Tool(cwdState.effective, …)` and delegate. `EnterWorktree` mutates
`cwdState.effective`; `ExitWorktree` restores. Relative paths and bash cwd then resolve inside
the worktree, which is what project preflight scripts probe. `ctx.cwd` (Pi's own value) remains
the launch dir; our wrappers are the single source of truth for tool execution. Subagents get
their worktree cwd natively via `createAgentSession({ cwd })`.

### 3.2 Tool-name mapping (Claude ⇄ Pi)
Claude artifacts name tools `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `WebFetch`,
`WebSearch`, `Agent`/`Task`, `Skill`, `EnterWorktree`, … Pi built-ins are lower-case
`read/write/edit/bash/grep/find/ls`. The **permission/hook/gating layer operates on Claude
names**; a canonical mapping table (in the capability registry) translates: `Read→read`,
`Edit→edit`, `Write→write`, `Bash→bash`, `Grep→grep`, `Glob→find` (+ our own `Glob` tool),
and our registered tools keep Claude names verbatim (`Agent`, `WebFetch`, `EnterWorktree`, …).
Matching is applied on events by translating Pi tool names back to Claude names first.
Unknown names stay verbatim and match string-identically (degrade-predictably, §4.8 of plan).

### 3.3 Hook execution
`type: command` hooks run via `node:child_process.spawn` with: shell selection (`bash -c` default,
`powershell -Command` when `shell: powershell`), JSON payload on stdin (Claude Code schema,
Windows paths double-backslashed in JSON naturally), env incl. `CLAUDE_PROJECT_DIR`,
`${CLAUDE_*}` placeholder expansion in the command string, timeout (default 60s), and the
stdout/exit-code contract: exit 2 ⇒ block; JSON `hookSpecificOutput.permissionDecision`
allow/deny/ask (ask ⇒ treated per §6.1 posture: logged, allowed, surfaced); `additionalContext`
⇒ injected via `sendMessage`/result patch; `updatedInput` ⇒ mutate `event.input` in place.

### 3.4 Subagent dispatch
`Agent` tool params: `{ subagent_type, prompt, model?, run_in_background? }` (dispatch is
**background-by-default** since F15 — an omitted `run_in_background` returns a task id; `false` opts
into a synchronous foreground run; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` forces foreground).
Fan-out: Pi executes sibling tool calls concurrently
already (parallel tool mode); our own concurrency limiter (default 4, settings-honored) queues
`createAgentSession` runs. Each subagent: fresh in-memory session; system prompt = agent body +
CLAUDE.md/rules hierarchy; tools = intersection of requested `tools:` minus `disallowedTools`,
translated per §3.2, with non-granted tools simply absent; per-agent `model`/`effort` resolved
via `modelRegistry`; depth tracked via an env/context counter, capped by settings
(default 1 nesting level beyond orchestrator = depth 2 total ⇒ configurable). Return value:
final assistant message text **verbatim** (no wrapper); on empty/malformed (per caller contract)
one retry supported by re-prompting.

### 3.5 Compaction preservation
On `session_before_compact` we do not replace Pi's summarizer; we let default compaction run
(return nothing) but register a **post-compact re-injection**: on `session_compact` we
`sendMessage` a persistent custom message containing: root CLAUDE.md (+imports), unconditional
rules, and the rendered bodies of currently-active skills. Additionally our `before_agent_start`
always re-asserts the instruction set in the system prompt (system prompt is rebuilt every turn
and never compacted away) — that is the primary preservation mechanism; the post-compact message
covers mid-turn context. PreCompact/PostCompact **project hooks** fire around these events.
Compaction settings pass through Pi (`compaction.reserveTokens` etc.).

### 3.6 What stays Pi-native
Auth (`/login` ChatGPT/Codex OAuth), provider abstraction, retry, session persistence/tree,
TUI, `/model`, project trust. We do not reimplement any of it.

## 4. Risks / churn watchpoints
- Pre-1.0 API churn: pin `0.80.x` exact in package.json; this doc + a smoke test
  (`test/pi-contract.test.ts`) asserts the imports/exports we rely on exist.
- `before_agent_start` system-prompt chaining: other extensions may also modify; we append, not replace.
- Built-in tool override warning in interactive mode is expected (documented for users).
- Quota introspection depends on undocumented response headers; feature is best-effort by design.

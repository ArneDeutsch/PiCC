# PiCC ↔ Pi integration contracts

> **Status:** Contract record for the coordinated Pi 0.80.10 suite
> (`@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui`). `package.json`
> declares `^0.80.10`; `package-lock.json` resolves every direct and coding-agent-nested copy to
> exactly 0.80.10. Pi directly declares Node ≥ 22.19.0.
> Source of truth for every Pi API PiCC builds on. If Pi churns, update here first.
>
> Fork vs. depend: **depend + extension bundle**. Pi is a regular npm dependency;
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

## 2. Pi API surface we use (tested baseline)

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
| Worktree cwd swap (load-bearing) | Override built-in tools: re-register `bash`/`read`/`write`/`edit`/`grep`/`find`/`ls` wrappers that resolve paths/cwd through a mutable `EffectiveCwd`; built-ins created per-cwd via `createBashTool(cwd, { spawnHook })`, `createReadTool(cwd, …)` etc. Built-in renderers are re-applied from `create*ToolDefinition` and de-padded through the self-shell wrapper (`src/runtime/tool-shell.ts` — see *Risks / churn watchpoints*); `execute` stays sourced from `create*Tool` so it is byte-identical. |
| Subagent runtime (fresh context, parallel, per-agent tools/model, verbatim return — see "Verbatim subagent return" in [`architecture.md`](architecture.md)) | SDK: `createAgentSession({ cwd, tools, customTools, resourceLoader, sessionManager, settingsManager, model?, thinkingLevel? })` — the options **PiCC passes**; Pi's own option set is wider. `resourceLoader` is `new DefaultResourceLoader({ cwd, agentDir, systemPromptOverride, agentsFilesOverride, skillsOverride, promptsOverride, extensionFactories })` (`await loader.reload()` before use). Final assistant message read as the last `role: "assistant"` entry of `session.messages`. Per-session `sessionManager` — see "Session managers" below. |
| Session managers (subagent transcripts) | `SessionManager.create(cwd, sessionDir, { id })` — persisted transcript, the default (Pi names the file `<stamp>_<id>.jsonl`); `SessionManager.open(path, sessionDir, cwd)` — reopen the same file to resume and append; `SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id })` — read a source transcript and write a **brand-new** file, so a `subagent_type: "fork"` child inherits the parent conversation without touching the parent's history; `SessionManager.inMemory(cwd)` — the non-resumable fallback when no transcript is available (no main-session file, a failed `create`, or an SDK without persisted sessions). Settings: `SettingsManager.inMemory(settings)`. |
| Model/effort control | `pi.setModel(model)`, `ctx.modelRegistry.find(provider,id)`, `pi.setThinkingLevel("off"…"max")` — Claude `effort` maps onto thinking levels |
| Env & exec | `pi.exec(cmd, args, { signal, timeout })` for git/hook commands; hooks additionally need shell execution via `node:child_process` (stdin JSON contract Pi's exec doesn't cover: we use `spawn` directly) |
| Quota | `ctx.getContextUsage()`; subscription quota via provider headers on `after_provider_response` (rate-limit headers) + `/login`-stored auth; degrade gracefully if absent |
| Compat notices / UX | `ctx.ui.notify`, `pi.appendEntry` + `pi.registerEntryRenderer` (TUI-only) |
| Subagent status panel, drill-down & condensed settlement records (interactive TUI only) | `ctx.ui.setWidget(key, factory, { placement: "belowEditor" })` — factory invoked synchronously, replaced/removed components disposed; `ctx.ui.custom(factory)` — focused component, Pi saves/restores the editor draft around it; `pi.registerShortcut(keyId, { description, handler })` — dispatches only while the default editor has focus; `ctx.ui.onTerminalInput` — raw listeners run BEFORE the focused component, so PiCC's fork-Esc watcher yields a lone Esc while the panel is open; `pi.registerMessageRenderer(customType, renderer)` + `pi.sendMessage(…, details)` — rendered by Pi's `CustomMessageComponent` with a boolean `expanded` (Ctrl+O toggle); `undefined`/throw falls back to Pi's default box. Mode gating is on `ctx.mode === "tui"`, never `hasUI`: print's `noOpUIContext` implements the full ui interface with `hasUI` false, while RPC flips `hasUI` true. |
| Skill listing into system prompt | We do **not** feed `.claude/skills` through Pi's own skill discovery (Pi's XML listing + `/skill:` semantics differ from Claude's budgeted listing, `$ARGUMENTS`, shell-injection, `context: fork`). PiCC owns the Claude skill pipeline end-to-end: listing text appended in `before_agent_start`, activation via our own `Skill` tool + slash commands. Pi's native skill/command discovery of `.pi/`/`.agents/` stays untouched. |

## 3. Key mechanics decisions

### 3.1 cwd swap for worktrees
Pi has no session-cwd mutation API. We keep a session-scoped `CwdState` (`base`, `effective`).
At extension load we re-register all built-in tools with wrappers that build the real tool
per-call via `create*Tool(cwdState.effective, …)` and delegate. `EnterWorktree` mutates
`cwdState.effective`; `ExitWorktree` restores. Relative paths and bash cwd then resolve inside
the worktree, which is what project preflight scripts probe. `ctx.cwd` (Pi's own value) remains
the launch dir; our wrappers are the single source of truth for tool execution. Subagents build
the **same** built-in tools from the shared factory (`buildStockBuiltinTools`) against their own
dispatch-local `CwdState` (`subCwd`); each built-in's `execute` rebinds per call via
`subCwd.get()`, so after a subagent's own `EnterWorktree` its built-ins, custom tools, and
permission guard (`getCwd: () => subCwd.get()`) all re-resolve to the new worktree cwd in
lockstep. `createAgentSession({ cwd })` only fixes the *initial* directory; the live worktree
swap flows through `subCwd`, exactly as the main session's swap flows through `cwdState`.

### 3.2 Tool-name mapping (Claude ⇄ Pi)
Claude artifacts name tools `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `WebFetch`,
`WebSearch`, `Agent`/`Task`, `Skill`, `EnterWorktree`, … Pi built-ins are lower-case
`read/write/edit/bash/grep/find/ls`. The **permission/hook/gating layer operates on Claude
names**; a canonical mapping table (in the capability registry) translates: `Read→read`,
`Edit→edit`, `Write→write`, `Bash→bash`, `Grep→grep`, `Glob→find` (+ our own `Glob` tool),
and our registered tools keep Claude names verbatim (`Agent`, `WebFetch`, `EnterWorktree`, …).
Matching is applied on events by translating Pi tool names back to Claude names first.
A tool name PiCC does not know stays verbatim and matches string-identically — an unmapped name
degrades predictably rather than silently matching nothing.

### 3.3 Hook execution
`type: command` hooks run via `node:child_process.spawn` with: shell selection (`bash -c` default,
`powershell -Command` when `shell: powershell`), JSON payload on stdin (Claude Code schema,
Windows paths double-backslashed in JSON naturally), env incl. `CLAUDE_PROJECT_DIR`,
`${CLAUDE_*}` placeholder expansion in the command string, timeout (default 60s), and the
stdout/exit-code contract: exit 2 ⇒ block; JSON `hookSpecificOutput.permissionDecision`
allow/deny/ask (ask ⇒ logged, allowed, and surfaced — PiCC has no interactive approval prompt);
`additionalContext`
⇒ injected via `sendMessage`/result patch; `updatedInput` ⇒ mutate `event.input` in place.

### 3.4 Subagent dispatch
Each subagent is its own `createAgentSession` run. What that costs us at the Pi seam:

- **Fan-out.** Pi already executes sibling tool calls concurrently (parallel tool mode), so Pi
  imposes no per-dispatch serialization; our own concurrency limiter (settings-honored) queues the
  `createAgentSession` runs.
- **Session seeding.** The default is a persisted transcript (`SessionManager.create`), which is
  what makes a dispatch resumable via `SessionManager.open`; a `subagent_type: "fork"` dispatch
  seeds `SessionManager.forkFrom` instead so the child inherits the parent conversation. With no
  main-session transcript file to work from (print/headless), dispatch falls back to
  `SessionManager.inMemory` and is non-resumable.
- **Prompt and tools.** Pi's own resource discovery is fully overridden: the system prompt (agent
  body + CLAUDE.md/rules hierarchy) arrives via `DefaultResourceLoader`'s `systemPromptOverride`,
  and the granted tool set — requested `tools:` minus `disallowedTools`, translated per *Tool-name
  mapping* — is passed as `tools`/`customTools`, with non-granted tools simply absent rather than
  blocked.
- **Model/effort.** Resolved per-agent through `ctx.modelRegistry` and passed as
  `model`/`thinkingLevel`.
- **Depth.** Pi has no notion of nesting depth; PiCC tracks it in an env/context counter and caps it
  by the `subagents.maxDepth` setting.

The return value is the last `role: "assistant"` message of `session.messages`, returned verbatim
— see "Verbatim subagent return" in [`architecture.md`](architecture.md) for the contract and the
resume trailer that rides on it.

### 3.5 Compaction preservation
On `session_before_compact` we do not replace Pi's summarizer; we let default compaction run
(return nothing) but register a **post-compact re-injection**: on `session_compact` we
`sendMessage` a persistent custom message containing: root CLAUDE.md (+imports), unconditional
rules, and the rendered bodies of currently-active skills. Additionally our `before_agent_start`
always re-asserts the instruction set in the system prompt (system prompt is rebuilt every turn
and never compacted away) — that is the primary preservation mechanism; the post-compact message
covers mid-turn context. PreCompact/PostCompact **project hooks** fire around these events.
Compaction settings pass through Pi (`compaction.reserveTokens` etc.). `reserveTokens` is a
**Pi settings-file** value that extensions cannot raise; PiCC's `proactiveCompactPercent`
compacts *sooner* as the extension-side margin lever, but it cannot make Pi tolerate more than
`contextWindow − reserveTokens` — raising the hard reserve stays an upstream-Pi/settings matter.

We likewise do not *retry* Pi's overflow-recovery summarization when it fails on a transient
error. That recovery is a single, non-retried summarization Pi runs on its own authed transport
(`this.agent.streamFn`), and the extension seam exposes no `streamFn`/`agent` handle to re-run it:
the only completion path reachable from an extension (`completeSimple` with `streamFn` undefined)
bypasses ChatGPT/Codex OAuth and so cannot faithfully stand in for Pi's summarizer. A true
in-recovery retry is therefore an **upstream-Pi requirement**, not something PiCC can add from the
seam. PiCC's resilience comes instead from the proactive early compaction above: firing Pi's own
reliable compaction before usage reaches the edge means a transient blip lands during a safe
compaction (the next turn simply re-fires) rather than during the single-shot recovery at the
overflow edge where it is fatal.

### 3.6 What stays Pi-native
Auth (`/login` ChatGPT/Codex OAuth), provider abstraction, retry, session persistence/tree,
TUI, `/model`, project trust. Pi 0.80.10's auth/model/catalog internals and base-prompt date removal
are inherited behavior, not PiCC compatibility features. PiCC keeps complete eager tool sets and does
not adopt deferred tool activation. We do not reimplement these Pi-native surfaces.

## 4. Risks / churn watchpoints
- Pre-1.0 API churn: the manifest keeps the coordinated `^0.80.10` policy while the lockfile is the
  exact resolution boundary; this doc + a smoke test (`test/pi-contract.test.ts`) asserts the
  imports/exports we rely on exist.
- `before_agent_start` system-prompt chaining: other extensions may also modify; we append, not replace.
- Built-in tool override warning in interactive mode is expected (documented for users).
- Tool-row de-padding and mutation presentation couple `src/runtime/tool-shell.ts` and
  `src/runtime/routine-tool-render.ts` to Pi's render contract. These dependencies are pinned by
  Pi-contract tests so a Pi bump fails loudly in CI rather than degrading incremental rendering
  silently on a green CI. For what the wrapper
  does with these, see "`renderShell` — this is how you control blank lines and framing" in
  [`tui-extension-guide.md`](tui-extension-guide.md); the Pi-side surface is:
  - **`create*ToolDefinition` renderer shape** — the de-padded built-in rows source their
    `renderCall`/`renderResult` from the public `createRead/Write/Edit/Bash/Grep/Find/LsToolDefinition`
    factories (the plain `create*Tool` factory strips renderers via `wrapToolDefinition`). A rename,
    move, or shape change of these factories breaks the wrap.
  - **`ctx.lastComponent` threading** — Pi's `ToolExecutionComponent` caches the component a renderer
    returned and hands it back as `ctx.lastComponent` on the next render (undefined on the first),
    caching the `renderCall` and `renderResult` slots separately. The built-ins depend on that to
    carry incremental render state, so a Pi change here would silently degrade rendering: the
    contract test drives the real `ToolExecutionComponent` and asserts Pi's side of it.
  - **Edit's nested call `Box`** — the public Edit call renderer returns a stateful `Box(1, 1)` and
    recognizes that Box through `ctx.lastComponent`. The routine adapter retains the inner Box and
    removes only its verified full-width outer padding rows; the real lifecycle test covers initial
    call, asynchronous preview, and settled reuse.
  - **Public Edit result renderer and custom HTML lifecycle** — MultiEdit passes a detached,
    sanitized Edit-shaped success snapshot to `createEditToolDefinition().renderResult`; it never
    invokes Edit preview. Pi's custom HTML renderer records call arguments before result rendering
    and renders collapsed and expanded results separately, so each pass must remain independently
    valid and must not depend on shared canonical objects.
  - **`getTextOutput` transform** — `tool-shell.ts` reproduces Pi's `render-utils.js` `getTextOutput`
    (the deep path is `exports`-blocked); the smoke test pins it against Pi's own via an absolute
    `file://` import so a transform change (CRLF stripping, image fallbacks) fails loudly.
- The subagent panel/record surfaces couple to Pi's UI contract (see the status-panel row in
  "Pi API surface we use"): the extension-ctx `setWidget`/`custom`/`onTerminalInput` shape and the
  mode/`hasUI` gating reality, `registerShortcut` presence + recording, `registerMessageRenderer` +
  `sendMessage` details threading, and `CustomMessageComponent`'s boolean `expanded` with the
  undefined→default-box fallback. All pinned in `test/pi-contract.test.ts` so a Pi bump fails
  loudly rather than silently dropping the panel or the settlement records.
- Quota introspection depends on undocumented response headers; feature is best-effort by design.

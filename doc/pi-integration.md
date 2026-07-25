# PiCC ↔ Pi integration contracts

> **Status:** Contract record for the coordinated Pi 0.82.0 suite. `package.json` pins every direct
> suite declaration to exactly 0.82.0; strict admission verifies every lockfile and installed
> occurrence is coherent at that version. Installed package metadata declares Node ≥ 22.19.0.
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
- A `picc` launcher that owns PiCC administration routing, validates one coherent installed Pi suite, then runs its coding-agent CLI with the extension preloaded. Resolution starts from PiCC's package tree rather than the target cwd: Pi's import-only exports map does not expose `dist/cli.js`, while npm may hoist the package to PiCC's containing `node_modules`.

The launcher sets `PI_SKIP_VERSION_CHECK=1` only for its adjacent embedded-Pi startup and supplies a
parent-PID/install-kind/PiCC-version tuple. PiCC accepts that tuple only when it matches the direct
parent and local package metadata: this is a direct-parent lineage check, not authentication. It
removes the PiCC markers immediately, retains suppression through Pi's startup checker, then removes
suppression before the first admitted user input or user-Bash command so descendants cannot inherit
it. An external `pi -e <picc>` host has no launcher tuple; PiCC neither claims update ownership nor
disables Pi's checker. An externally configured `PI_SKIP_VERSION_CHECK` remains the host's setting.

## 2. Pi API surface we use (tested baseline)

| PiCC subsystem | Pi API used |
|---|---|
| System-prompt assembly (CLAUDE.md hierarchy, rules, agent-description catalog, skill listing, steering layer) | `pi.on("before_agent_start")` → return `{ systemPrompt }` (chained); `event.systemPromptOptions` for Pi's own context-file/skill view |
| Context injection mid-session (nested CLAUDE.md, path-scoped rules on file touch, skill activation, hook `additionalContext`) | `pi.sendMessage({ customType, content, display }, { deliverAs: "steer" })`; for tool-triggered injection return extra text in `tool_result` patches |
| Deny rules, hook PreToolUse block/ask, per-agent tools gating at orchestrator level | `pi.on("tool_call")` → `{ block: true, reason }`; `event.input` is mutable (hook `updatedInput`) |
| PostToolUse / PostToolUseFailure hooks, output rewriting | `pi.on("tool_result")` → partial patch `{ content, details, isError }` |
| SessionStart / SessionEnd hooks | `pi.on("session_start")` / `pi.on("session_shutdown")` |
| UserPromptSubmit hook | `pi.on("input")` → `continue/transform/handled` (stdout context → `transform`) |
| Stop hook | `pi.on("agent_settled")` + `pi.sendUserMessage(..., { deliverAs: "followUp" })` to continue when a Stop hook blocks stopping |
| PreCompact/PostCompact + instruction re-injection | `pi.on("session_before_compact")` (can cancel), `pi.on("session_compact")`; PiCC restores SessionStart(compact) context and recent skill bodies through `pi.sendMessage`, while PostCompact output is diagnostic-only |
| Custom tools: `Agent`, `EnterWorktree`, `ExitWorktree`, `WebFetch`, `WebSearch`, `Grep`, `Glob`, `TaskCreate/...`, degrade stubs | `pi.registerTool({ name, description, parameters: TypeBox, execute, prepareArguments? })`; throw ⇒ `isError`; `terminate: true` stops only after Pi completes all sibling results in the requested batch |
| PiCC control commands | The command map in `src/index.ts` is the single owner of PiCC command registration and dispatch; reserved-name lookup consumes that map alongside Pi's built-in-name set. `pi.registerCommand(name, { description, handler })` provides interactive routing. In the shared `pi.on("input")` handler, checkpoint replay/disposition and extension-sourced bypass run first; for admitted non-extension user input across modes, the fallback parses the same map and handles reserved Pi built-in tokens that Pi's exact interactive router missed. Those recognized inputs stay outside hooks, skills, and model context, with output using the protocol-safe transport below. Registered handlers get `ExtensionCommandContext` |
| Worktree cwd swap (load-bearing) | Override built-in tools: re-register `bash`/`read`/`write`/`edit`/`grep`/`find`/`ls` wrappers that resolve paths/cwd through a mutable `EffectiveCwd`; built-ins created per-cwd via `createBashTool(cwd, { spawnHook })`, `createReadTool(cwd, …)` etc. Built-in renderers are re-applied from `create*ToolDefinition` and placed in the foreground-glyph self shell (`src/runtime/tool-shell.ts` — see *Risks / churn watchpoints*); `execute` stays sourced from `create*Tool` until the one outer checkpoint wrapper. |
| Subagent runtime (fresh context, parallel, per-agent tools/model, verbatim return — see "Verbatim subagent return" in [`architecture.md`](architecture.md)) | SDK: `createAgentSession({ cwd, tools, customTools, resourceLoader, sessionManager, settingsManager, model?, thinkingLevel? })` — the options **PiCC passes**; Pi's own option set is wider. `resourceLoader` is `new DefaultResourceLoader({ cwd, agentDir, systemPromptOverride, agentsFilesOverride, skillsOverride, promptsOverride, extensionFactories })` (`await loader.reload()` before use). Final assistant message read as the last `role: "assistant"` entry of `session.messages`. Per-session `sessionManager` — see "Session managers" below. |
| Session managers (subagent transcripts) | `SessionManager.create(cwd, sessionDir, { id })` — persisted transcript, the default (Pi names the file `<stamp>_<id>.jsonl`); `SessionManager.open(path, sessionDir, cwd)` — reopen the same file to resume and append; `SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id })` — read a source transcript and write a **brand-new** file, so a `subagent_type: "fork"` child inherits the parent conversation without touching the parent's history; `SessionManager.inMemory(cwd)` — the non-resumable fallback when no transcript is available (no main-session file, a failed `create`, or an SDK without persisted sessions). Settings: `SettingsManager.inMemory(settings)`. |
| Model/effort control | `pi.setModel(model)`, `ctx.modelRegistry.find(provider,id)`, `pi.setThinkingLevel("off"…"max")` — Claude `effort` maps onto thinking levels |
| Env & exec | PiCC-owned startup/worktree Git administration uses `node:child_process.execFile` with sanitized inherited environment because Pi 0.82's `pi.exec` options do not accept `env`; hooks use `spawn` for their shell/stdin JSON contract. Pi 0.82 Bash factories default to exposing `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`; PiCC passes `exposeSessionEnvironment:false`, then overlays sanitized `setting.env` and the required project-root `CLAUDE_PROJECT_DIR`. |
| Quota | `ctx.getContextUsage()`; subscription quota via provider headers on `after_provider_response` (rate-limit headers) + `/login`-stored auth; degrade gracefully if absent |
| Control output, checkpoint records, and status notifications | `ctx.ui.notify` for TUI status; `pi.appendEntry` records entries across modes, while `pi.registerEntryRenderer` supplies their TUI presentation. Raw control text is written only in text print mode; JSON and RPC remain protocol-safe entry streams |
| Subagent status panel, drill-down & condensed settlement records (interactive TUI only) | `ctx.ui.setWidget(key, factory, { placement: "belowEditor" })` — factory invoked synchronously, replaced/removed components disposed; `ctx.ui.custom(factory)` — focused component, Pi saves/restores the editor draft around it; `pi.registerShortcut(keyId, { description, handler })` — dispatches only while the default editor has focus; `ctx.ui.onTerminalInput` — raw listeners run BEFORE the focused component, so PiCC's fork-Esc watcher yields a lone Esc while the panel is open; `pi.registerMessageRenderer(customType, renderer)` + `pi.sendMessage(…, details)` — rendered by Pi's `CustomMessageComponent` with a boolean `expanded` (Ctrl+O toggle); `undefined`/throw falls back to Pi's default box. Mode gating is on `ctx.mode === "tui"`, never `hasUI`: print's `noOpUIContext` implements the full ui interface with `hasUI` false, while RPC flips `hasUI` true. |
| MCP tool exposure (proxies registered AFTER extension load, once the non-blocking stdio connect settles) | Post-load `pi.registerTool` of a NEW name: with no `tools:` allowlist (the main-session reality) Pi's registry refresh auto-activates the name on the next request, and a snippet-less tool leaves the base system prompt byte-identical — the Pi half of the MCP zero-context guarantee. Pinned against the real Pi dist in `test/mcp-registration.test.ts`. |
| Skill listing and Claude-format slash commands | We do **not** feed `.claude/skills` through Pi's own skill discovery (Pi's XML listing + `/skill:` semantics differ from Claude's budgeted listing, `$ARGUMENTS`, shell-injection, `context: fork`). PiCC owns the Claude skill pipeline end-to-end: listing text appended in `before_agent_start`; activation via our own `Skill` tool or a `pi.on("input")` transform; palette visibility via `resources_discover` prompt paths. Pi's native skill/command discovery of `.pi/`/`.agents/` stays untouched. |
| Mid-run proactive checkpoint | `turn_end` observes the completed tool batch; tool results may set `terminate: true`, and `ctx.abort()` is the fail-closed ordinary-run fallback. Each generation invokes one main `ctx.compact({ onComplete, onError })` or child `AgentSession.compact()` transaction. Main logical cancellation blocks continuation and joins callback settlement; the extension API cannot abort compaction, so configured summary retries may finish. Child cancellation calls public `abortCompaction()` and joins settlement. Children also use `sendCustomMessage()`, `abort()`, and `subscribe()`; summary retry events are condensed without copying `errorMessage`. Hidden `pi.sendMessage(..., { triggerTurn: true })` / child `sendCustomMessage(..., { triggerTurn: true })` starts the synthetic continuation while `before_provider_request` guards ordinary transport. |
| Pi retry contracts | `SettingsManager.inMemory()` supplies child defaults through `getRetrySettings()` and `getProviderRetrySettings()`; PiCC does not copy them into production. Public `generateSummary(..., retryPolicy, retryCallbacks)` pins eligible summary retry, fail-fast categories, callback order, and cancellation. Main compaction inherits the host's configured `retry` and `retry.provider` settings. |
| Guarded provider APIs | The checkpoint gate recognizes only model API ids `openai-completions`, `openai-responses`, and `openai-codex-responses`. Pi's OpenAI Completions/Responses streams honor a pre-aborted signal. PiCC owns the public `openai-codex-responses` registration while loaded and delegates to Pi's public compat loader; it preserves normal automatic transport, but forces abort-aware SSE for an already-aborted request so a cached Codex WebSocket cannot send. Compaction-summary authority is session/generation scoped; arbitrary competing custom API handlers are outside scope. |

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
Main-session live Edit rendering must also bind native preview I/O to the effective cwd at argument
completion and revalidate it at execution start; `ctx.cwd` remains the correct source for HTML and
reconstructed history rendering.

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

### 3.5 Compaction preservation and proactive checkpoints
The system-prompt suffix reasserts durable instructions every turn. After `session_compact`, both
main and child sessions run SessionStart with source `compact`, surface PostCompact diagnostics
without injecting its stdout or additional context, then restore the latest rendered active skill
bodies that fit the heuristic character budget, most-recent-first. This approximates Claude Code's
token-counted retention policy and can under- or over-retain it. `PreCompact` runs before commit;
SessionStart(compact) and PostCompact run only after commit. Pi's void main-session `sendMessage`
confirms only synchronous enqueue acceptance, so later delivery failure is not observable.

`proactiveCompactPercent` defaults to 90. At `turn_end`, PiCC waits for every requested tool result.
A clean PiCC-owned batch uses `terminate`; any mixed, blocked, malformed, truncated, pending, or
ambiguous path uses `ctx.abort()` and the provider guard. The controller invokes exactly one Pi
compaction transaction and awaits it plus the re-entrant synthetic continuation before the logical
run settles. Pi owns retry eligibility and backoff inside that transaction. Main sessions inherit
the host's configured retry settings; PiCC-created children use fresh public in-memory settings with
only PiCC's existing compaction and shell overrides, so their effective retry defaults remain Pi's.
A configured retry budget therefore changes inner provider attempts, never the number of PiCC
checkpoint transactions. Main cancellation is logical: it blocks ordinary work and continuation
while joining bounded Pi settlement, which may finish configured summary retries. Child cancellation
physically aborts compaction through the SDK and joins it. Split summarization operations qualify
independently under Pi's policy; PiCC neither pools nor multiplies their retry budgets. A blocked
`PreCompact` remains policy exhaustion and is not made retryable. The settled-idle sample remains a
non-resuming fallback.

This is PiCC reliability hardening, not verified Claude threshold/retry/continuation parity. It
covers main sessions and PiCC-created children using Pi's `openai-completions`, `openai-responses`,
or `openai-codex-responses` APIs. Eligible transient summary transport failures can recover inside
Pi; deterministic provider, quota, authentication, initial cancellation, and hook failures fail
fast or terminate by category. Operational or hook exhaustion retains a manually recoverable
pre-commit boundary. Authoritative observation of the current generation's `session_compact` marks
the summary committed; every later callback error, rejection, cancellation ambiguity, stale
settlement, restoration, replay, provider release, or continuation failure then requires replacement
and must not mint recovery authority or compact that summary again.

Pi's native summary retry callbacks and child `summarization_retry_scheduled`,
`summarization_retry_attempt_start`, and `summarization_retry_finished` events are observability
seams. Child progress exposes only bounded category/attempt activity and never raw provider
`errorMessage`; main retry presentation and native JSON/RPC compaction errors remain Pi-owned and
may contain provider diagnostics outside PiCC's transcript/lifecycle records. Pi 0.82.0 continues
to emit a native physical `agent_end` for the intentionally stopped pre-compaction run; extensions
cannot suppress or correlate it. Pi's overflow recovery remains a separate Pi-owned transaction,
and `compaction.reserveTokens` remains a settings-file boundary.

### 3.6 What stays Pi-native
Auth (`/login` ChatGPT/Codex OAuth), provider abstraction, retry, session persistence/tree,
TUI, `/model`, project trust. Pi 0.82.0's auth/model/catalog internals and base-prompt date removal
are inherited behavior, not PiCC compatibility features. PiCC keeps complete eager tool sets and does
not adopt deferred tool activation. We do not reimplement these Pi-native surfaces.

## 4. Risks / churn watchpoints
- Pre-1.0 API churn: the manifest pins the complete coordinated suite exactly, while shared strict
  graph admission checks every lockfile and installed occurrence; this doc + the version-sensitive
  smoke probes in `test/pi-contract.test.ts` assert the imports/exports and behavior PiCC relies on.
- `before_agent_start` system-prompt chaining: other extensions may also modify; we append, not replace.
- Mid-run checkpoint watchpoints: `turn_end` must remain after all sibling tool results; `terminate`
  must retain the all-results rule; `ctx.abort()` must stop before another ordinary provider request;
  callback `ctx.compact` and Promise-style SDK `compact` must remain safely callable from settled,
  re-entrant lifecycle work; hidden custom messages must still trigger a turn and persist. Provider
  registration remains API-global last-writer-wins, and Codex cached-WebSocket pre-abort behavior is
  pinned by contract tests.
- Built-in tool override warning in interactive mode is expected (documented for users).
- Late tool registration: PiCC's detached MCP registration relies on Pi auto-activating a post-load
  `registerTool` of a new name and on snippet-less tools not rebuilding the base prompt; the
  real-Pi pin in `test/mcp-registration.test.ts` fails loudly if either changes.
- Tool-row glyph framing, mutation presentation, and settled interactive collapse couple
  `src/runtime/tool-shell.ts`, `src/runtime/routine-tool-render.ts`, and
  `src/runtime/default-collapsed-tool-render.ts` to Pi's render contract. A pending call-only update
  constructs only the call component; if rendered before a later update supersedes it, only that
  component paints. On an update when a result exists, Pi constructs the call component and then
  the result component with the exact same `ctx.state` object before either can paint; when rendered,
  the call paints before the result. Glyph coordination and collapse rely
  on that result-bearing build-before-paint order and state identity; collapse additionally relies
  on Pi propagating the configured `app.tools.expand` state. The Pi-contract test pins this sequence
  and identity across repeated result-bearing updates so a Pi bump fails loudly rather than
  degrading rendering silently.
  For what the wrapper
  does with these, see "`renderShell` — this is how you control blank lines and framing" in
  [`tui-extension-guide.md`](tui-extension-guide.md); the Pi-side surface is:
  - **`create*ToolDefinition` renderer shape** — the glyph-framed built-in rows source their
    `renderCall`/`renderResult` from the public `createRead/Write/Edit/Bash/Grep/Find/LsToolDefinition`
    factories (the plain `create*Tool` factory strips renderers via `wrapToolDefinition`). A rename,
    move, or shape change of these factories breaks the wrap.
  - **`ctx.lastComponent` threading** — Pi's `ToolExecutionComponent` caches the component a renderer
    returned and hands it back as `ctx.lastComponent` on the next render (undefined on the first),
    caching the `renderCall` and `renderResult` slots separately. The built-ins depend on that to
    carry incremental render state, so a Pi change here would silently degrade rendering: the
    contract test drives the real `ToolExecutionComponent` and asserts Pi's side of it.
  - **Edit's nested call `Box`** — the public Edit call renderer returns a stateful `Box(1, 1)` and
    recognizes that Box through `ctx.lastComponent`. The routine adapter retains the exact inner
    Box in a WeakMap, removes only recognized full-width outer padding rows, and neutralizes its
    state background immediately before every render because Pi can reapply it. The real lifecycle
    test covers initial call, asynchronous preview, and settled reuse.
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

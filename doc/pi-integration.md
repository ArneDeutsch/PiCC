# PiCC ↔ Pi integration contracts

> **Status:** Contract record for the coordinated Pi 0.84.2 suite with direct TypeBox 1.3.7
> alignment. `package.json` pins every direct suite declaration and TypeBox exactly; launcher
> admission resolves the four direct Pi package manifests from PiCC's package tree and requires the
> pinned suite version. Installed package metadata declares Node ≥ 22.19.0.
> Source of truth for every Pi API PiCC builds on. If Pi churns, update here first.
>
> Fork vs. depend: **depend + extension bundle**. Pi is a regular npm dependency;
> PiCC ships as an extension (loaded via `settings.json "extensions"` array, `.pi/extensions/`,
> or `pi -nc -e`) plus a launcher. Every settings-based, `.pi/extensions/`, or direct `pi -e` host must
> supply public `-nc` on every enclosing Pi invocation. No fork.

## 1. How PiCC attaches to Pi

Pi extensions may be TypeScript modules loaded through Pi's loader or ordinary JavaScript modules;
they export `default function (pi: ExtensionAPI)` (async allowed; awaited before startup completes).
PiCC is **one extension bundle**. `src/extension.ts` owns implementation composition, event
handlers, tool wiring, and command registration. `picc/index.ts` is the canonical Pi-hosted
bootstrap; `src/index.ts` is the direct source/public-API bootstrap and re-export surface.

Launch modes we support:
- `pi -nc -e <path-to-PiCC>/src/index.ts` in the target project for explicit source development. A
  path in Pi's `extensions` settings or `.pi/extensions/` is Claude-compatible only when every
  enclosing Pi invocation also supplies public `-nc`; an extension cannot retroactively disable the
  host resource loader.
  This source-only bootstrap acquires the shared runtime graph itself and loads `src/extension.ts`;
  it carries no compiled selection authority.
- A source-checkout `picc` launcher, which selects source-matched compiled JavaScript when available
  and otherwise discloses the permitted TypeScript fallback. A damaged runtime is not a fallback.
  Canonical launchers supply Pi's public `-nc` so PiCC alone assembles Claude-format CLAUDE.md,
  rules, memory, skills, and agent context instead of combining it with Pi's native context files.
- An installed `picc` launcher, which selects only package-matched compiled JavaScript and never
  falls back to retained TypeScript. Standalone plugin inventory and lifecycle, and standalone MCP
  administration, each use their own selection and verification route without starting the normal
  Pi extension runtime.

The ordinary launcher starts one child host. That child resolves Pi's CLI and shared package graph,
performs the complete initial selection and verification once, then passes the authenticated
selection to `picc/index.ts` for one-time consumption before loading `src/extension.ts`'s compiled or
source representation. The parent launcher does not repeat Pi-suite validation, runtime selection,
or runtime verification. The source handoff carries only the chosen representation; it never grants
compiled authority. A direct load
of the canonical `picc/index.ts` bootstrap without the child-host handoff acquires its own host graph
and selects and verifies independently. Explicit `src/index.ts` hosting remains source-only.

The launcher also owns PiCC administration routing, including standalone `picc plugin` lifecycle
commands that do not start the normal Pi extension runtime. Pi CLI resolution starts from PiCC's
package tree rather than the target cwd and executes the exact `pi` bin path declared by the
resolved `@earendil-works/pi-coding-agent` package. That manifest field is a narrow pinned
integration watchpoint: it is not permission to import arbitrary private package paths. The
`picc/` bootstrap path deliberately preserves Pi's visible **`picc`** extension label for initial
load and reload.

Every canonical reload freshly selects a candidate and never consumes the initial one-shot
selection. A compiled-pinned process fully re-verifies and enforces its pinned generation, so
`/reload` cannot adopt a new build before exit and relaunch. A source-pinned process remains on its
retained source representation even when fresh selection now finds a valid build. Only a fresh
source selection carries the representation evidence that authorizes loading source; evidence from
a compiled selection does not freshly verify the retained source that is actually loaded. Explicit `src/index.ts` hosting
remains Pi-owned source reload without compiled authority.

Filesystem operations retain `fs.realpathSync.native()` spelling. On Windows, equality,
containment, and deduplication derive a separate case-folded comparison identity and never feed that
folded value back into module loading or filesystem access.

PiCC registers the string-valued `agent` extension flag synchronously. Pi applies its value after
registration and before `session_start`, where PiCC reads it; the launcher only forwards the CLI
argument and does not resolve the agent itself.

The launcher sets `PI_SKIP_VERSION_CHECK=1` only for its adjacent embedded-Pi startup and supplies a
parent-PID/install-kind/PiCC-version tuple. PiCC accepts that tuple only when it matches the direct
parent and local package metadata: this is a direct-parent lineage check, not authentication. It
removes the PiCC markers immediately, retains suppression through Pi's startup checker, then removes
suppression before the first admitted user input or user-Bash command so descendants cannot inherit
it. An external `pi -nc -e <picc>` host has no launcher tuple; PiCC neither claims update ownership
nor disables Pi's checker. An externally configured `PI_SKIP_VERSION_CHECK` remains the host's
setting.

## 2. Pi API surface we use (tested baseline)

| PiCC subsystem | Pi API used |
|---|---|
| System-prompt assembly (CLAUDE.md hierarchy, rules, agent-description catalog, skill listing, steering layer) | `pi.on("before_agent_start")` → return `{ systemPrompt }` on every turn. Ordinary sessions chain from the incoming prompt; a selected custom-agent session deliberately replaces it with the frozen selected identity plus PiCC compatibility context. Supported hosts disable Pi's native context files with public `-nc`; PiCC, not Pi's AGENTS/CLAUDE loader, owns Claude-format context assembly. |
| Context injection mid-session (nested CLAUDE.md, path-scoped rules on file touch, skill activation, hook `additionalContext`) | `pi.sendMessage({ customType, content, display }, { deliverAs: "steer" })`; for tool-triggered injection return extra text in `tool_result` patches |
| Deny rules, hook PreToolUse block/ask, per-agent tools gating at orchestrator level | `pi.on("tool_call")` → `{ block: true, reason }`; `event.input` is mutable (hook `updatedInput`) |
| PostToolUse / PostToolUseFailure hooks, output rewriting | `pi.on("tool_result")` → partial patch `{ content, details, isError }`. `PostToolUseFailure` applies only after execution starts; permission and `PreToolUse` denials are pre-execution blocks and do not synthesize a result event. |
| SessionStart / SessionEnd hooks | `pi.on("session_start")` / `pi.on("session_shutdown")`. During active session replacement, Pi aborts and persists the outgoing response before shutdown; committed tree navigation likewise aborts before moving. PiCC joins outgoing checkpoint work and attributes lifecycle delivery to the owning session before accepting the successor. |
| UserPromptSubmit hook and MCP prompt input | `pi.on("input")` → `continue/transform/handled` (stdout context or a successful MCP `prompts/get` result → `transform`). PiCC awaits MCP exposure before resolving a first `/mcp__…` input, applies local-command precedence after the hook, and returns `handled` on prompt failure so no raw command reaches the provider. MCP prompts are user input transforms, not model `SlashCommand` invocations. |
| Stop hook | `pi.on("agent_settled")` + `pi.sendUserMessage(..., { deliverAs: "followUp" })` to continue when a Stop hook blocks a successfully completed logical settlement. The extension wrapper is asynchronous: PiCC transfers settlement custody only after bounded, identity-authenticated input admission resolves successfully; rejection, timeout, stale identity, throw, or duplicate use refuses the continuation fail closed. Logically unsuccessful outcomes bypass ordinary Stop handling; physical stop reasons alone do not decide the logical outcome because proactive checkpoints have the narrow exception described below. A terminal-main `pending` warns without changing process status in TUI. One-shot print reports on stderr, JSON appends a structured incomplete entry, and both set a generic nonzero status without replacing a checkpoint-specific status. Long-lived RPC appends the same structured entry while Pi owns its eventual shutdown status. |
| PreCompact/PostCompact + instruction re-injection | `pi.on("session_before_compact")` (can cancel), `pi.on("session_compact")`; PiCC restores SessionStart(compact) context and recent skill bodies through `pi.sendMessage`, while PostCompact output is diagnostic-only |
| Custom tools: `Agent`, `EnterWorktree`, `ExitWorktree`, `WebFetch`, `WebSearch`, `Grep`, `Glob`, `TaskCreate/...`, conditional MCP resource tools, degrade stubs | `pi.registerTool({ name, description, parameters: TypeBox, execute, prepareArguments? })`; throw ⇒ `isError`; `terminate: true` stops only after Pi completes all sibling results in the requested batch. PiCC late-registers and activates both fixed resource tools when the live main-session catalog first gains an advertised resource capability, including through an administratively admitted changed definition; an advertised-empty or `resources/list`-failed catalog still qualifies after otherwise successful settlement. Host registration may persist across reconnect, terminal retention, or retirement, while `setActiveTools()` removes active exposure when no current main-session definition remains capable. An initial `tools/list` failure publishes no capability snapshot or fixed resource tools. |
| PiCC control commands | The command map in `src/extension.ts` is the single owner of PiCC command registration and dispatch; reserved-name lookup consumes that map alongside Pi's built-in-name set. `pi.registerCommand(name, { description, handler })` provides interactive routing. In the shared `pi.on("input")` handler, checkpoint replay/disposition and extension-sourced bypass run first; for admitted non-extension user input across modes, the fallback parses the same map and handles reserved Pi built-in tokens that Pi's exact interactive router missed. Those recognized inputs stay outside hooks, skills, and model context, with output using the protocol-safe transport below. Registered handlers get `ExtensionCommandContext`. Exact TUI `/mcp` administration deep links pass the focused controller a narrow service port whose inventory first invokes service-owned recovery preparation; successful rollback supplies its fresh inventory, while uncertain recovery remains blocked. Bare `/mcp` and headless routing never invoke recovery. Interactive `/reload-plugins` validates and records one candidate handoff before calling terminal `ctx.reload()`. Validation rejection never calls Pi. Once Pi starts shutdown/rebuild, the API provides no rollback or strict terminal activation result: an exactly rejected replacement contributes its active `session_start(reason: "reload")` context's graceful `ctx.shutdown()` closure to the matching reload attempt. After Pi returns from `ctx.reload()`, the outgoing handler schedules that one-shot request for the next timer turn and immediately throws authoritative new-session guidance, allowing Pi to render the error first. The request is best-effort; failure or absence of replacement startup cannot use the invalidated outgoing context or claim termination, and a later Pi-owned failure may remain Pi-owned reload-error reporting. |
| Worktree cwd swap (load-bearing) | Override built-in tools: re-register `bash`/`read`/`write`/`edit`/`grep`/`find`/`ls` wrappers that resolve paths/cwd through a mutable `EffectiveCwd`; built-ins created per-cwd via `createBashTool(cwd, { spawnHook })`, `createReadTool(cwd, …)` etc. Built-in renderers are re-applied from `create*ToolDefinition` and placed in the foreground-glyph self shell (`src/runtime/tool-shell.ts` — see *Risks / churn watchpoints*); `execute` stays sourced from `create*Tool` until the one outer checkpoint wrapper. The Bash, Read, Write, and Edit definitions explicitly set Pi's public `constrainedSampling: false`, so ambient `PI_EXPERIMENTAL=1` cannot change those Claude-compatible definitions; grep, find, and ls do not receive this field and retain their unaffected Pi definitions. Ordinary user input awaits successful registration of this fixed core set before hooks or provider dispatch. |
| Pi-owned TUI runtime identity | npm's shrinkwrapped layout may retain duplicate package files, but a Pi-hosted process evaluates one host-owned Pi-suite and TypeBox graph. `runtime-host.ts` projects runtime-bearing implementation access and imports from the retained graph, preserving mutable singleton state and constructor identity for keybindings, TUI capability state, schemas, and native Edit's `Box`; supported bootstraps acquire that graph directly before implementation evaluation. This is evaluated-runtime coherence, not a physical-deduplication claim. |
| Subagent runtime (fresh context, parallel, per-agent tools/model, verbatim return — see "Verbatim subagent return" in [`architecture.md`](architecture.md)) | SDK: `createAgentSession({ cwd, tools, customTools, resourceLoader, sessionManager, settingsManager, model?, thinkingLevel? })` — the options **PiCC passes**; Pi's own option set is wider. Pi's `pending` stop reason is streaming-only; if a malformed/custom child nevertheless settles with terminal `pending`, PiCC fails it loudly as incomplete and retains bounded partial output rather than reporting success. A terminal provider error likewise fails loudly with capped, sanitized cause text and retained partial output. An unexpected terminal `deferred` outcome is a loud incomplete failure retaining only bounded terminal output; PiCC never retries it automatically, disables ordinary resume, and directs the caller to dispatch a fresh agent. `resourceLoader` is `new DefaultResourceLoader({ cwd, agentDir, systemPromptOverride, agentsFilesOverride, skillsOverride, promptsOverride, extensionFactories })` (`await loader.reload()` before use). Final assistant message read as the last `role: "assistant"` entry of `session.messages`. Per-session `sessionManager` — see "Session managers" below. |
| Session managers (main selected identity and subagent transcripts) | Main selected-agent persistence reads only `ctx.sessionManager.getBranch()` and writes a versioned selection record through `appendCustomEntry`; branch absence/uncertainty never degrades to the lower-priority setting. A versioned `pi.sendMessage` custom user message with `triggerTurn: false` carries `initialPrompt`. PiCC proves both records synchronously on the live selected branch before provider admission, but for a new persisted session Pi does not create a reopenable on-disk session until it persists the first assistant response. Once persisted, resume re-resolves selection and does not replay `initialPrompt`. Subagents use `SessionManager.create(cwd, sessionDir, { id })` — persisted transcript, the default (Pi names the file `<stamp>_<id>.jsonl`); `SessionManager.open(path, sessionDir, cwd)` — reopen the same file to resume and append; `SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id })` — read a source transcript and write a **brand-new** file, so a `subagent_type: "fork"` child inherits the parent conversation without touching the parent's history; `SessionManager.inMemory(cwd)` — the non-resumable fallback when no transcript is available or persistence ownership cannot be admitted (no main-session file, unavailable persistence support, a failed `create` or ownership check, or an SDK without persisted sessions). Retention deletion admission also depends on the active manager's `getSessionFile()` persisted-file identity, `getCwd()`, and `getSessionDir()`, plus the bounded first JSONL record remaining a `type: "session"` header whose `id`, `timestamp`, and `cwd` agree with that identity. These are churn watchpoints: uncertainty preserves data. Settings: `SettingsManager.inMemory(settings)`. |
| Model/effort control | `pi.setModel(model)`, `ctx.modelRegistry.find(provider,id)`, `pi.setThinkingLevel("off"…"max")` — Claude `effort` maps onto thinking levels. Selected-main application restores the captured host baseline, applies PiCC config, then the selected override; aliases and unavailable/refused values retain the working choice with a warning rather than claiming exact Claude resolution. |
| Env & exec | PiCC resolves its Git executable from the absolute `PICC_GIT` override or PATH. Startup/worktree Git uses `node:child_process.execFile` with sanitized inherited environment because `pi.exec` options do not accept `env`; hooks use `spawn` for their shell/stdin JSON contract. Project subprocess environments first remove launcher/host-only ambient context, including Pi's `AI_AGENT` (all casing aliases on Windows), then apply explicit/configured values and the required project-root `CLAUDE_PROJECT_DIR`. Pi Bash factories default to exposing `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`; PiCC passes `exposeSessionEnvironment:false`. Direct RPC Bash traverses the composed `user_bash` event chain once: embedded-launch suppression clears before execution and the Git Bash-pinned local operations execute the command without a model turn. |
| JSON/RPC streaming | Pi's official `message_update` wire records carry delta content only. Clients reconstruct streamed text by concatenating deltas; PiCC provides no cumulative-content adapter. The record's top-level usage remains cumulative for the current assistant response. Lifecycle, command acknowledgement, cancellation, and PiCC custom-entry records retain their established shapes. |
| Quota | `ctx.getContextUsage()`; subscription quota via provider headers on `after_provider_response` (rate-limit headers) + `/login`-stored auth; degrade gracefully if absent |
| Control output, checkpoint records, and status notifications | While the TUI renderer is live, checkpoint preparation uses `ctx.ui.notify` and actionable outcomes use model-inert `pi.appendEntry` records with a `pi.registerEntryRenderer`; after renderer shutdown, actionable outcomes fall back to stderr. In TUI, Pi's native indicator owns temporary physical-compaction progress and its native card owns the sole routine success record. `ctx.ui.setStatus(key, text | undefined)` is persistent keyed footer state used elsewhere. TUI presentation is gated on `ctx.mode === "tui"`; print stderr and JSON/RPC lifecycle entry channels are unchanged. Print, JSON, and every presented live-RPC post-compaction cancellation latch status 3. RPC never presents that outcome as reusable; the shared controller remains exhausted with admission closed, and the action requires external PiCC process plus session replacement. |
| Subagent status panel, drill-down & condensed settlement records (interactive TUI only) | `ctx.ui.setWidget(key, factory, { placement: "belowEditor" })` — factory invoked synchronously, replaced/removed components disposed; `ctx.ui.custom(factory)` — focused component, Pi saves/restores the editor draft around it; `pi.registerShortcut(keyId, { description, handler })` — dispatches only while the default editor has focus; `ctx.ui.onTerminalInput` — raw listeners run BEFORE the focused component, so PiCC's fork-Esc watcher yields a lone Esc while the panel is open; `pi.registerMessageRenderer(customType, renderer)` + `pi.sendMessage(…, details)` — rendered by Pi's `CustomMessageComponent` with `{ expanded: boolean; outputPad: number }`, where `expanded` is controlled by the configured `app.tools.expand` action (Ctrl+O by default); `undefined`/throw falls back to Pi's default box. Mode gating is on `ctx.mode === "tui"`, never `hasUI`: print's `noOpUIContext` implements the full ui interface with `hasUI` false, while RPC flips `hasUI` true. |
| Main-session MCP tool exposure (initial settlement and later administration deltas) | Post-load `pi.registerTool` supports new names and same-name changed-definition refresh. PiCC serializes its mutations, authenticates exact source/definition ownership before and after each host side effect, re-reads `getActiveTools()`, and calls `setActiveTools()` with unrelated names preserved plus only the current PiCC-owned set. Same-definition reconnect reuses its proxy; changed definitions register a replacement. Call-time routing still validates the current runtime generation, so stale registered definitions cannot reach retired clients. New snippet-less names leave the base prompt byte-identical. No discovered proxies means no proxy schemas; fixed resource schemas remain conditional on advertised capability, while their live catalogs can change. Pinned against fake-host causality and the real Pi dist in `test/mcp-registration.test.ts`. A selected main agent rebuilds this exposure from its effective owner-bound scope and intersects it with its immutable policy; restrictive exact review/configuration changes retire the old generation before fresh publication. Dispatch-only scopes never use this API-global path and pass an isolated local custom-tool set to `createAgentSession`. |
| Resource discovery, skill listing, and Claude-format slash commands | We do **not** feed `.claude/skills` or MCP prompts through Pi's own skill discovery or model-facing `SlashCommand` surface (Pi's XML listing + `/skill:` semantics differ from Claude's budgeted listing, `$ARGUMENTS`, shell-injection, `context: fork`; MCP prompts are user-input transforms). PiCC owns the Claude skill pipeline; the later async `resources_discover` event awaits the settled exposure transaction and performs startup prompt discovery/publication by publishing bounded frontmatter-only paths for eligible skills and MCP prompt commands. Pi's native `.pi/`/`.agents/` discovery stays untouched. |
| Mid-run proactive checkpoint | `message_end` observes fresh successful tool-requesting assistant usage, interpreted with the public `calculateContextTokens` export from `@earendil-works/pi-agent-core`; this export is the assistant-boundary usage contract. `turn_end` handles the completed tool batch, while `before_provider_request` is the final idle-to-armed sample and calls `ctx.abort()` when newly known pressure must block ordinary provider transport. `agent_settled` is the only boundary that may start one PiCC-owned physical compaction transaction if the checkpoint is still required, and only after provider and tool work is resolved. Tool results may set `terminate: true`, and `ctx.abort()` remains the fail-closed ordinary-run fallback. Each PiCC-owned generation invokes one main `ctx.compact({ onComplete, onError })` or child `AgentSession.compact()` transaction; cancelled colliding native attempts, client manual recovery, and later idle native transactions are separate physical origins. Main logical cancellation blocks continuation and joins callback settlement; the extension API exposes neither an operation handle nor compaction-abort confirmation, so configured summary retries may finish. If a main-session callback settlement or a main-session resumed cancellation/join misses its bounded deadline, elapsed time cannot prove host cancellation; PiCC treats the process as terminal and permits neither recovery nor replacement. Child cancellation calls public `abortCompaction()` and joins settlement. Children also use `sendCustomMessage()`, `abort()`, and `subscribe()`; summary retry events are condensed without copying `errorMessage`. Hidden `pi.sendMessage(..., { triggerTurn: true })` / child `sendCustomMessage(..., { triggerTurn: true })` starts the synthetic continuation while `before_provider_request` guards ordinary transport. |
| Pi retry contracts | `SettingsManager.inMemory()` supplies child defaults through `getRetrySettings()` and `getProviderRetrySettings()`; PiCC does not copy them into production. Public `generateSummary(..., retryPolicy, retryCallbacks)` pins Pi's configured summarization loop as the sole owner of eligible transient transport/overload attempts, abortable backoff, fail-fast categories, callback order, and cancellation. After Pi-owned Agent retry execution settles, PiCC uses Pi's public `isRetryableAssistantError` with `isContextOverflow` to classify a terminal assistant error for guidance only. This classifier exposes neither remaining retry budget nor predicted recovery success; Pi retains retry execution, budget, and backoff, while PiCC combines the classification with conservative lifecycle evidence and actual resumability. |
| Guarded provider APIs | The checkpoint gate recognizes only model API ids `openai-completions`, `openai-responses`, and `openai-codex-responses`. Pi's OpenAI Completions/Responses streams honor a pre-aborted signal. PiCC owns the public `openai-codex-responses` registration while loaded and delegates to Pi's public compat loader. Ordinary PiCC Agent calls retain their configured transport and provider retries; an already-aborted request forces abort-aware SSE so a cached Codex WebSocket cannot send. Pi-owned standalone Codex summaries through the shared summarization seam force SSE and provider `maxRetries: 0`. The public request fields expose no provenance, so an exact-signature custom caller receives the same policy until Pi exposes a purpose marker. Compaction-summary authority is session/generation scoped; arbitrary competing custom API handlers are outside scope. |

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
  blocked. For an eligible named agent, PiCC first composes borrowed session MCP routes and an
  agent-owned inline runtime, then adds only that immutable dispatch-local MCP tool set to
  `customTools`; it never calls the API-global `pi.registerTool` seam for those capabilities.
  A nested agent with an omitted or clean-empty declaration still inherits eligible published
  main-session routes; a parent's inline routes do not propagate. Selecting only a non-empty
  declaration's named routes and parent-inline non-propagation are inferred, unverified PiCC choices.
- **Model/effort.** Resolved per-agent through `ctx.modelRegistry` and passed as
  `model`/`thinkingLevel`.
- **Depth.** Pi has no notion of nesting depth; PiCC tracks it in an env/context counter and caps it
  by the `subagents.maxDepth` setting.

The return value is the last `role: "assistant"` message of `session.messages`, returned verbatim
— see "Verbatim subagent return" in [`architecture.md`](architecture.md). Completed or
truncated-completed resumable results may carry the resume trailer; failed results instead carry
separate state-aware guidance when the structured disposition permits it.

### 3.5 Compaction preservation and proactive checkpoints
The system-prompt suffix reasserts durable instructions every turn. After `session_compact`, both
main and child sessions run SessionStart with source `compact`, surface PostCompact diagnostics
without injecting its stdout or additional context, then restore the latest rendered active skill
bodies that fit the heuristic character budget, most-recent-first. This approximates Claude Code's
token-counted retention policy and can under- or over-retain it. `PreCompact` runs before commit;
SessionStart(compact) and PostCompact run only after commit. Replayed input remains in
session/generation-bound custody until an authenticated matching `message_start` consumes it or
settlement reports it for recovery; synchronous enqueue acceptance alone does not release custody.
The pinned suite exposes queued steering before follow-ups, preserves equal occurrences, restores
those queues around compaction, and reconstructs the outer custom-message object at `message_start`
while preserving the exact `details` value. For retained-input custody, PiCC binds one lease to an
opaque details-envelope identity for every active-generation restoration or continuation send, then
scrubs and revokes it at exact start. This custody protocol is distinct from the zero-context-capable
defensive cutoff authority described below. The host send API is fire-and-forget: return, timeout,
transcript absence, content equality, or an uncorrelated asynchronous rejection proves neither start
nor failure. A missing exact start therefore expires as unconfirmed host custody rather than
successful delivery. The exact authenticated deadline
exception is `UnconfirmedHostDeadlineError`; `session_shutdown` must propagate it before MCP release,
SessionEnd, or ordinary cleanup rather than treating it as a normal shutdown.

`proactiveCompactPercent` defaults to 90. A fresh successful tool-requesting assistant
`message_end` can queue pressure from its final usage; already-requested tools still finish. At
`turn_end`, PiCC handles the complete batch and waits for every requested tool result.
`before_provider_request` then provides the final idle-to-armed sample; when newly known pressure
crosses the threshold, its admission abort blocks ordinary provider transport. A clean PiCC-owned
batch uses `terminate`; any mixed, blocked, malformed, truncated, pending, or ambiguous path uses
`ctx.abort()` and the provider guard. `agent_settled` is the only boundary that may start a
PiCC-owned physical compaction transaction if the checkpoint is still required, and only after no
provider response or tool batch remains unresolved. Native `threshold`/`overflow` attempts that
collide with that generation are cancelled before PiCC hook ownership. This exactly-one guarantee is
per PiCC-owned generation, not across physical origins: a client manual recovery may commit, and a
later idle-controller native threshold transaction may complete.

The narrow pre-commit defensive cutoff is authenticated without requiring context. It binds the
exact controller, session epoch, logical run, generation, batch, batch handle, batch run, and terminal
object identities; issuance additionally requires PiCC to synchronously abort the same initially-live
public signal. Authority is available only in print, JSON, or an explicitly classified regular TUI
whose session-owned `onTerminalInput` fence installed successfully. That fence never consumes input,
but any raw input revokes the live cutoff window. RPC and unknown mode fail closed. If an optional
PiCC guard custom occurrence exists, only its exact opaque details object and same-object start/end
may cross the occurrence fence; a zero-context run needs no such occurrence. The first eligible
assistant `error` terminal object followed by the same settlement continues the already-authorized
checkpoint. Stale identities, cloned or repeated objects, user/custom activity, cancellation,
ambiguous queues, and every unmatched `pending`, `aborted`, or `error` remain operational exhaustion.
After the synthetic resume begins, any unsuccessful terminal outcome is post-commit and terminal
except the exact authenticated selected-branch `aborted` response followed by settlement of that same
run. That exception permits safe in-session recovery only in the regular TUI; print and JSON use
terminal `retrieve-and-relaunch`, while live RPC is process-terminal `restart-process`.

For each PiCC-owned generation, the controller invokes exactly one PiCC-owned Pi compaction
transaction and awaits it plus the re-entrant synthetic continuation before the logical run settles. Pi's configured summarization retry policy
owns retry eligibility, attempts, and backoff inside that transaction; PiCC-created children use
fresh public in-memory settings with only PiCC's existing compaction and shell overrides, so their
effective defaults remain Pi's. A configured summary retry budget changes attempts inside the
transaction, never the number of PiCC checkpoint transactions. Main cancellation is logical: it
blocks ordinary work and continuation while joining bounded Pi settlement, which may finish
configured summary retries. After the first resume, `cancelled` requires the exact selected-branch assistant
object to end `aborted` and then the same run's `agent_settled`; abort intent, `pending`/`error`, stale
or replacement settlement, and missing settlement remain unsafe. Confirmed TUI recovery starts no second continuation or retained-input replay, but effects from that
first resumed run may exist. Live RPC is excluded: `abort()` does not reclaim native steering or
follow-up queues, and the extension API exposes no queue-reclamation seam. Pi may therefore drain
retained input and start later turns before PiCC can reach cancellation presentation. PiCC does not
fake interception; if it does present an authenticated RPC cancellation, the action is
`restart-process`, status 3, with stage/count/client-history/effect guidance and mandatory external
PiCC process plus session replacement. Separately, stock Pi rejects an RPC `prompt` submitted while
compaction is active with `success:false` before PiCC admission. The client owns that input: it must
check the acknowledgement, invoke RPC `compact` when manual recovery is required, explicitly
continue after compaction settles, and retry the rejected prompt. PiCC does not queue rejected input
or patch/proxy Pi's RPC router. For main print/JSON/RPC retained records, `appendEntry` returns no entry ID and neither append
acceptance nor an existing session path verifies reopened persistence. The
`picc-checkpoint-retained-input` custom entry is therefore only a non-locator hint. Caller-owned
client/request history is a recovery source where available, not PiCC-verified persistence. This confirmed ending has its own terminal category; controller
admission and in-process new/resume/fork/reload replacement remain closed. PiCC binds a readable mode
only to the accepted session epoch, so a terminal `ctx.mode` failure preserves a known RPC route without
inferring RPC from an unknown mode or leaking it into a successor session. Confirmed shutdown
uses the same exact join but cannot claim a stopped editor or reusable session; unresolved retained input gets
an explicit possible-loss warning and ordinary shutdown continues. The continuation stage is
advanced immediately before its hidden trigger, so every terminal record names the stage actually
reached. Child cancellation
physically aborts compaction through the SDK and joins it. Pre-commit compaction-paused TaskStop remains
the established paused-session exception. Separately, only the current linked dispatch generation's
authenticated post-commit resumed stream, or its exact `terminalizing`/`resumed-cancellation` join,
qualifies for an active TaskStop flight; scheduling before authenticated start and a normally closed
assistant stream do not. Task-id and stable agent-id callers share that registry-owned cancellation and
linked-dispatch join, while stale generations and foreign nested callers cannot reach it. This is PiCC
hardening, not Claude Code stop-timing parity. At confirmed shutdown, each canonical child report
gets one bounded best-effort persistence attempt before cleanup: exact reopened session-entry or recovery-file
verification emits a locator, while complete storage failure names only a bounded subset of generated agent IDs
without locators, warns of possible loss, directs transcript and caller-owned request-history recovery where available
plus worktree/effect inspection, and continues cleanup and `SessionEnd`. Unconfirmed child work remains quarantined
and blocks cleanup. The bounded unconfirmed subset pairs each exact current-registry agent ID only with its exact
transcript path using reversible JSON quoting, or says explicitly that no path was recorded. Path characters are not
truncated or collapsed; decode the quoted values before `TaskOutput` or filesystem use because their quote delimiters
are framing, not ID/path characters. For a still-live rejected switch or non-quit shutdown, attempt `TaskOutput` with
each decoded named agent ID before exit and copy its result only when a canonical report exists. If no canonical report
exists or the tool is absent or unavailable, use the corresponding decoded transcript path to copy retained input before
exit. For `quit`, the renderer is already stopped, the process is exiting, and no further `TaskOutput` invocation is
possible: use each decoded transcript path as a recovery locator before or after restart. Transcript paths survive
process replacement, but agent IDs do not. Where an affected agent has no recorded path, caller-owned parent/client request
history is the remaining source when available. In either branch, inspect the worktree and possible effects; do not resume
or retry that child in-process.
Split summarization operations qualify
independently under Pi's policy; PiCC neither pools nor multiplies their retry budgets. A blocked
`PreCompact` remains policy exhaustion and is not made retryable. The settled-idle sample remains a
non-resuming fallback.

This is PiCC reliability hardening, not verified Claude threshold/retry/continuation parity. It
covers main sessions and PiCC-created children using Pi's `openai-completions`, `openai-responses`,
or `openai-codex-responses` APIs. Eligible transient summary transport failures can recover inside
Pi; deterministic provider, quota, authentication, initial cancellation, and hook failures fail
fast or terminate by category. Confirmed pre-commit operational or hook exhaustion retains a
manually recoverable boundary. Both the confirmed RPC restart-required ending and an unconfirmed-host
ending are process-terminal: neither permits in-process recovery or replacement, and both require a
fresh process and fresh session. Only the latter claims host quiescence is unconfirmed.
Authoritative observation of the current generation's `session_compact` marks the summary committed.
Except for the exact authenticated aborted-terminal/same-branch TUI settlement described above,
every later callback error, rejection, cancellation ambiguity, stale settlement, restoration, replay, provider
release, or continuation failure requires replacement and must not mint recovery authority or compact
that summary again.

Pi's native summary retry callbacks and child `summarization_retry_scheduled`,
`summarization_retry_attempt_start`, and `summarization_retry_finished` events are observability
seams. Child progress exposes only bounded category/attempt activity and never raw provider
`errorMessage`; main retry presentation and native JSON/RPC compaction errors remain Pi-owned and
may contain provider diagnostics outside PiCC's transcript/lifecycle records. Pi continues to emit
a native physical `agent_end` for the intentionally stopped pre-compaction run; extensions
cannot suppress or correlate it. Pi's overflow recovery remains a separate Pi-owned transaction,
and `compaction.reserveTokens` remains a settings-file boundary.

### 3.6 What stays Pi-native
Auth (`/login` ChatGPT/Codex OAuth), provider abstraction, retry, session persistence/tree,
TUI, `/model`, project trust. Pi's auth/model/catalog internals remain inherited behavior, not PiCC
compatibility features. PiCC keeps complete eager tool sets and does
not adopt deferred tool activation. We do not reimplement these Pi-native surfaces.

### 3.7 Core-tool readiness
Pi loads extension entry points asynchronously, but PiCC's cwd-bound replacements finish through a
detached SDK import and registration step. The ordinary input handler therefore awaits the one
settled readiness result before running `UserPromptSubmit`, skill expansion, or model-bound work in
TUI, print, JSON, and RPC modes. Registered PiCC and admitted Pi control commands remain available
because they route before this gate. Authenticated extension continuations also keep their existing
checkpoint ordering; arbitrary third-party direct-trigger turns that bypass ordinary input are not
covered.

A failed preparation or registration latches admission closed before diagnostics. Stock fallback is
unsafe because it would execute against Pi's launch cwd rather than PiCC's live worktree cwd. Caught
preparation or registration failures immediately attempt remove-only filtering of the fixed core
names from the active set and verify their absence. The terminal readiness-settlement fallback
records cleanup as unverified and first attempts it on rejected ordinary input. Both paths remain
blocked and retry cleanup on each rejected ordinary input while it is unverified. A possible partial
registration makes filtering especially urgent but is not a prerequisite. There is no readiness
timeout.

## 4. Risks / churn watchpoints
- Pre-1.0 API churn: the manifest pins the complete coordinated suite exactly, while launcher
  admission resolves and verifies each direct package manifest; this doc + the version-sensitive
  smoke probes in `test/pi-contract.test.ts` assert the imports/exports and behavior PiCC relies on.
- `before_agent_start` system-prompt chaining: ordinary sessions append after other extensions. A
  selected custom-agent session intentionally replaces the every-turn prompt; ordering with other
  prompt-replacing extensions is therefore last-handler-wins rather than composable.
- Mid-run checkpoint watchpoints: `turn_end` must remain after all sibling tool results; `terminate`
  must retain the all-results rule; `ctx.abort()` must stop before another ordinary provider request;
  callback `ctx.compact` and Promise-style SDK `compact` must remain safely callable from settled,
  re-entrant lifecycle work; hidden custom messages must still trigger a turn and persist. Provider
  registration remains API-global last-writer-wins, and Codex cached-WebSocket pre-abort behavior is
  pinned by contract tests.
- Built-in tool override warning in interactive mode is expected (documented for users).
- Late tool registration: PiCC relies on post-load registration becoming host-visible, including
  same-name changed-definition replacement. The coordinator must keep registration and active-set
  publication serialized, preserve unrelated additions/removals by merging from a fresh
  `getActiveTools()` read, and relinquish an owned name if source/definition provenance changes.
  Same-definition reconnect must not churn registration, and every proxy must validate its route at
  call time. The fake-host causal suite and real-Pi registration pin fail loudly if these assumptions
  change; snippet-less registration must also leave the base prompt unchanged.
- The child host must continue supplying the complete host-owned Pi-suite and TypeBox graph before
  PiCC implementation evaluation. npm may retain duplicate physical files, but constructor,
  singleton, and schema identity must remain coherent in the evaluated process. The installed-Pi
  contract tests pin this boundary; recheck it on every Pi upgrade.
- Pi CLI startup depends on the resolved coding-agent package's strict `bin.pi` declaration. Recheck
  that declared entry and its containment on every Pi upgrade; do not replace it with an assumed
  private path.
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

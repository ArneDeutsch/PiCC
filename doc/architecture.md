# PiCC architecture

A map of how PiCC runs a Claude Code project on a GPT/Codex model: the layers, what each folder is
responsible for, the seams between them, and where new functionality belongs. It is a map, not the
territory — for how a module actually behaves, read the module and its tests.

For the principles a change must honor see the guiding principles in
[`CONTRIBUTING.md`](../CONTRIBUTING.md); for the exact Pi API contracts see
[`doc/pi-integration.md`](pi-integration.md); for the test layout and which layer a new test belongs
in see [`doc/testing.md`](testing.md).

## Layered design

```
┌─────────────────────────────────────────────────────────────────────┐
│  Pi (base harness, @earendil-works/pi-*)                            │
│  agent loop · model/provider abstraction · ChatGPT/Codex auth ·     │
│  TUI · session persistence · built-in tools (read/write/edit/bash/  │
│  grep/find/ls) · extension event bus                                │
└───────────────▲──────────────────────────────── loads as extension ─┘
                │ default export picc(pi)  (src/index.ts)
┌───────────────┴─────────────────────────────────────────────────────┐
│  PiCC (this repo) — one Pi extension bundle                          │
│                                                                      │
│  discovery → claude loaders → project model                         │
│                    │                                                 │
│            engine (permissions · hooks · shell-inject)              │
│                    │                                                 │
│   runtime (context-assembly · subagents · worktrees · guard ·      │
│            cwd-state · tools · skill-activation · steering · mcp)   │
│                    │                                                 │
│            registry (capability registry · compat report)          │
└──────────────────────────────────────────────────────────────────────┘
```

### The Pi ⇄ PiCC boundary

PiCC is **not a fork** of Pi. Pi is an ordinary npm dependency, and PiCC attaches as a single
extension whose entry is `src/index.ts`; the pinned, tested dependency graph is recorded in
[`doc/pi-integration.md`](pi-integration.md). Pi supplies everything model- and UI-related; PiCC
supplies Claude Code compatibility and **never** reimplements auth, the provider layer, or the TUI
shell. A change that would duplicate a Pi responsibility inside `src/` is the wrong change — extend
the seam instead.

The carve-out: PiCC does render **its own** tool rows, built on Pi's `pi-tui` primitives — that is
what `tool-shell.ts` and `subagent-render.ts` are. Rendering a surface PiCC owns is in scope;
owning the shell it renders into is not.

### The PiCC ⇄ Claude Code boundary: compatible-but-independent

The two harnesses meet at the **filesystem and git level only**, and deliberately nowhere else. A
worktree or git history produced by one is clean and usable by the other; a user can switch
providers at will on one project and run **parallel sessions on different worktrees under different
models**. They do **not** exchange live session state, and there is **no mid-flight handoff** of a
live worktree or session between them.

This is why PiCC state lives outside the project or in the gitignored, harness-owned
`.claude/.picc/`, and why compatibility work targets artifacts on disk rather than any shared
runtime protocol. Anything that would require the two harnesses to agree at runtime is out of scope
by construction.

## Module map (`src/`)

Each folder below gets its responsibility, its load-bearing invariant, and a placement line. The
detail of any individual file lives in the file.

### The `engine` ⇄ `runtime` ⇄ `guard` seam

Stated once, because it decides most placement questions:

- **`engine/` is deterministic and session-free.** It answers questions (does this rule match? what
  did this hook decide?) from plain inputs. It knows nothing about Pi, sessions, or cwd, and it
  never throws.
- **`runtime/` owns live session state.** It wires the parsed project model into a Pi session and
  holds everything mutable — cwd, dispatch registries, worktrees.
- **`guard.ts` is the single enforcement seam between them.** It is where an engine decision is
  applied to a real tool call. Enforcement is therefore uniform across the main session and every
  subagent, because both install the same guard extension.

**Placement:** a new enforcement *primitive* (a matcher, a decision rule) lands in `engine/`; the
*application* of it to a tool call lands in `guard.ts`; live state lands in `runtime/`. Do not
enforce from a tool implementation — a check that lives in one tool is a check every other tool
lacks.

### `discovery/` — where artifacts live, and precedence

Resolves the repo root, the Claude artifact directories, and the `settings.json` hierarchy. Two
hierarchies, and they are not the same set:

- **Artifact directories** span **managed, project, and user** — plus the monorepo walk-up, where
  every `.claude/` from cwd up to the repo root contributes. There is no `local` artifact scope.
- **Settings** additionally have a **`local` scope** (`settings.local.json`), which is settings-only
  and merges in ascending precedence.

**Two precedence orderings, deliberately opposite — this is the folder's trap:**

- **Named artifacts (skills, agents, commands): the nearest wins.** Candidates are ordered
  managed → project (nearest-first) → user, and a first-wins dedupe by name keeps the closest
  definition.
- **Rules: the reverse — ascending priority, managed last.** Rules are guidance *text*, not
  name-deduped artifacts, so precedence cannot be expressed by "who wins the name". It is expressed
  by *position in the prompt*: user first, then project root→cwd, then managed, so the
  highest-precedence text lands closest to the end and wins on conflicts.

"Nearest wins" is therefore an invariant of the artifact loaders, not of the folder. Keys that are
recognized-but-deferred and keys that are unknown are split out for the compatibility report rather
than dropped.

**MCP server config** is a third input: the project `.mcp.json` plus scope-tagged `mcpServers`
blocks from the settings hierarchy, resolved here (`discovery/mcp.ts`) by whole-entry precedence
and the enablement gate — project-origin servers stay pending until approved from a user-authored
scope, and a git-tracked `settings.local.json` is demoted to project scope so a cloned repo can
never self-approve.

**Placement:** new scopes, precedence rules, or settings-shape handling. Nothing that interprets an
artifact's *content*.

### `claude/` — parse each artifact format (loaders only, no runtime)

One loader per Claude artifact format — skills and commands, agents, rules, the CLAUDE.md hierarchy
with `@import` expansion, memory, hooks config, MCP server entries (`.mcp.json` and settings
`mcpServers` blocks, `mcp-config.ts`), and installed-plugin content. `src/project.ts` — at
the source root, *above* the loaders, importing both `discovery/` and `claude/` — orchestrates them
into one loaded project model. It sits outside this folder precisely because it depends on both:
a loader knows one format and nothing else.

Invariants across the folder:

- **Loaders never throw.** Malformed input degrades to an empty value plus a diagnostic. A broken
  project must never crash the harness: `src/index.ts` catches load failure and returns quietly.
- **Progressive disclosure is a hard requirement, not an optimization.** Skill frontmatter is
  parsed; the body is **never** stored on the returned object and is re-read only on activation. A
  change that eagerly holds bodies defeats the whole design.
- **The startup skill listing degrades tier by tier, but never omits a skill.** A budget may shrink
  an entry to its name; it may not make a skill invisible.
- Plugin **content** is folded into the same registries. Installation and marketplace machinery are
  out of scope.

**Placement:** a new artifact format, or a change to how an existing one parses. No session
awareness, no I/O beyond reading the artifact.

### `engine/` — the deterministic enforcement primitives

- **`permissions.ts`** — the permission-matcher grammar (`Bash(git *)`, `Read/Edit(glob)`,
  `WebFetch(domain:*)`, `Agent(type)`, `Skill(name)`, `mcp__server__tool`) and the `deny` engine.
  Matching is **shell-operator aware**, paths are normalized to POSIX form on Windows, and it never
  throws.
- **`hook-runner.ts`** — spawns `type: command` hooks, delivers the Claude Code JSON payload on
  stdin, and aggregates the exit-code / stdout-JSON contract into a single `HookOutcome`. Matching
  handlers run in parallel and merge **most-restrictive-wins**; `fire()` never throws.
- **`shell-inject.ts`** — preprocesses skill bodies, replacing inline and fenced `!` command blocks
  with command stdout before the model sees the content. Also resolves the Git Bash path (see *Git
  Bash is pinned on Windows*).

#### Security & permission posture (deliberately partial, by design)

PiCC does **not** reimplement Claude Code's full interactive security model. Two reasons, and both
are load-bearing:

- Part of that model — **auto-mode** — is a **server-side classifier we cannot match**. Imitating it
  would mean inventing a different classifier and calling it parity.
- Interactive per-command approval is **fragile**: a user cannot reliably interpret a complex
  command and tends to allow-by-default anyway, so the prompt buys ceremony rather than safety.

The resulting posture:

- **Default permissive** (auto-mode-like) — the workflow is not blocked and the user is not prompted
  per command.
- **`deny` is honored as a hard, non-interactive block.** It is the one deterministic, useful part
  of the permission model, and it is kept as a real safety valve.
- **`tools:` capability gating is fully honored, and is the primary control.** "These agents may
  search the web, those may not" is just tool possession — deterministic, and nothing to classify.
- **`allow` / `ask` rules, permission modes, and auto-mode are a graceful no-op** — parsed and
  reported, not enforced.

**The matcher grammar is nevertheless fully implemented**, because three subsystems reuse it: `deny`
enforcement, `tools:` gating, and hook `if:` conditions. It is not dead code kept for a someday
`allow`.

**Placement:** a new matcher, decision rule, or hook-contract field. Anything needing a session,
cwd, or Pi object does not belong here.

### `runtime/` — wiring the parsed model into a live Pi session

Clustered by responsibility, not by file — this is where new files land, and a named entry point is
where to start reading, not the extent of its cluster.

- **Context assembly** (`context-assembly.ts`) — assembles the instruction set into the system-prompt
  suffix. Rebuilt every turn, the suffix is never compacted away: **this is the primary
  compaction-preservation mechanism**. Resident skill bodies are restored most-recent-first within
  PiCC's heuristic character budget, which approximates rather than reproduces Claude Code's
  token-counted policy. Its interaction-posture block is main-session-only — a dispatched subagent
  returns a report, and has no user to converse with.

- **Subagent dispatch** (`subagents.ts`, plus the registry, progress/render, and background-task
  modules beside it) — one story: spawn a **fresh-context** session per dispatch, gate it per agent,
  classify every outcome (see *Subagent error contract*), observe it, resume it. Its invariants:
  **nesting is off by default** — a dispatched subagent receives neither `Agent` nor `Task` and its
  prompt omits the agent catalog; raising `subagents.maxDepth` opts in. The one exception to fresh
  context is a `subagent_type: "fork"` dispatch, which inherits the parent conversation; every case
  that *cannot* inherit degrades to fresh context **visibly**. An address resolves **registry-only**
  — a process-lifetime, agent-id-keyed registry holds each dispatch's transcript, resumability,
  outcome, and usage. A subagent's `TaskOutput`/`TaskStop` reach **only its own dispatched tasks**,
  while the coordinator keeps session-wide reach and collects uncollected ones via a bounded,
  untrusted-framed notice. Everything model-visible is bounded and **sanitized at capture** — the
  registry sanitizes on store and the progress condenser at capture, so records are clean regardless
  of caller — **except `agentName`**, deliberately raw as the registry's name-index key and therefore
  sanitized at every render; render-time sanitization stays as a backstop for the rest. The scheduler
  owns admission, `SubagentRegistry` owns dispatch lifecycle and progress, and
  `BackgroundTaskRegistry` owns task-generation admission and stop data consumed by `TaskOutput` and
  joined into the status panel. Registry addresses, including the stable agent id accepted by
  `TaskStop` for a checkpoint-retained child, exist only for the originating
  process lifetime. A **user-initiated stop** (from the panel) is permanent: the record carries the
  marker and `SendMessage` refuses to steer or resume a user-stopped agent — distinct from a model
  `TaskStop`, after which PiCC still allows resume (the divergence is recorded in the capability
  registry).

- **Subagent status panel** (`subagent-panel-model.ts`, `subagent-panel-render.ts`,
  `subagent-panel-widget.ts`, `subagent-panel-focus.ts`, with shared width/theme helpers in
  `render-util.ts` and validated agent presentation colors in `agent-color.ts`) — the
  interactive-TUI observability surface over the dispatch registry: a pure view model and pure
  renderer, a thin `setWidget` shell for the passive
  below-editor panel, and a `ctx.ui.custom` focus controller for list navigation, the drill-down
  (prompt / structured live detail / final answer), stop/dismiss/stop-all, and steering. TUI-only by
  construction — the controllers are constructed unconditionally but attached only when
  `ctx.mode === "tui"`; print/RPC runs never touch a UI verb. The flip side is transcript slimming:
  for main-session/depth-1 background work, the panel owns live waiting/running state, successful
  acceptance is transient in human chat, and the first terminal delivery owns one semantic,
  expandable record. Nested work at depth ≥ 2 instead keeps Pi's default notice box and appears in
  the panel tree and its parent's transcript. Normal-path results still replace pending calls in the
  same tool row, and subagent output does not stream into chat.

- **Session state** (`cwd-state.ts`, `worktrees.ts`) — `CwdState` is **the single mutable source of
  truth for the effective cwd**; every tool resolves through it at execute time (see *The cwd swap is
  load-bearing*). `WorktreeManager` resolves a base ref to a concrete SHA **before** creating the
  worktree and removes Windows-tolerantly. Orphan cleanup is best-effort and runs only after the Git
  executable and registered-worktree state are verified; unavailable state is left untouched. Public methods
  do not throw.

- **Enforcement wiring** (`guard.ts`, `tool-map.ts`) — the guard applies engine decisions to real
  tool calls: deny rules, hooks, on-touch context injection. Main session and every subagent install
  the same one, which is what makes it **the one shared enforcement seam**. Those layers all match on
  **Claude** names, so Pi names are translated back first; unknown names stay verbatim.

- **Skill activation** (`skill-activation.ts`) — the one pipeline (lazy body load → substitution →
  `!`-injection) behind the `Skill` tool, slash commands, and `context: fork` dispatch.

- **MCP runtime** (`mcp.ts`, `mcp-remote.ts`, `mcp-tools.ts`) — starts the **enabled**
  discovery-resolved servers without blocking extension load and exposes discovered tools as
  `mcp__<server>__<tool>` proxies through the same guard/decoration pipeline as every other tool.
  `mcp.ts` owns the transport-neutral lifecycle and retry authority: stdio child process-tree
  cleanup and remote client connection/recovery. `mcp-remote.ts` owns the safe remote adapter and
  typed failure/disconnect evidence. The first successful tool catalog is
  immutable, proxies register once and resolve the current client, and recovery cannot widen the
  session or inherited subagent tool set. The enablement gate is enforced by construction; failed
  startup adds no tools, owned resources close with the session, and when nothing is both configured
  and enabled the model receives **no MCP-related context of any kind**.

- **Proactive compaction** (`mid-run-compaction.ts`, with main wiring in `index.ts` and child wiring
  in `subagents.ts`) — a session-local controller owns threshold sampling, complete-tool-batch
  stopping, one Pi-owned compaction transaction, queued-input reconciliation, resume, cancellation, and
  exhaustion. Confirmed pre-commit operational or hook exhaustion remains recoverable in-session;
  any post-commit restoration, replay, or continuation-start failure is terminal for that session.
  If a main-session callback or main-session resumed cancellation/join misses its bounded deadline, elapsed time does not
  confirm host quiescence: admission and recovery stay closed, and in-process controller replacement
  is unsafe. Clean PiCC-owned tool batches terminate after
  every requested result;
  mixed or ambiguous paths abort, while provider guards remain the final fail-closed boundary.
  Compaction and resume are awaited re-entrant lifecycle work, so the original logical run does not
  settle between its physical runs. A separate settled-run check remains as a non-resuming fallback.

- **Steering** (`steering.ts`) — per-model steering text and the effort→thinking-level mapping, read
  from a config **outside the project** — outside **because harness state must not touch the target
  project**.

- **Tool-row rendering** (`main-session-tool-render.ts`, `tool-shell.ts`,
  `search-tool-render.ts`, `routine-tool-render.ts`, `default-collapsed-tool-render.ts`, with
  display-name/path formatting in `tool-display.ts`) — the central main-session family router,
  self-shell framing, and guarded human renderers for specialized and safely classified settled
  tool rows. `pi-tui-runtime.ts` is the narrow package-instance bridge for Pi-owned mutable
  singletons and constructor identity in the supported two-copy production layout. Decoration
  changes only presentation and never canonical model-facing results.

- **`tools/`** — the **self-contained** Claude-named tools, and the degrade stubs: names that resolve
  for gating but no-op with a notice. A tool that fronts a runtime subsystem lives with that
  subsystem.

#### Tool gating expands one-directionally

Two invariants that are easy to get backwards when adding a tool:

- A `Read(…)` rule expands across the file-**read** family (`Grep`, `Glob`, `NotebookRead`) on a
  matching path, and an `Edit(…)` rule across the file-**edit** family (`Write`, `MultiEdit`,
  `NotebookEdit`). The expansion does **not** run back the other way: a `Grep(…)` rule does not gate
  `Read`, just as `Write` does not gate `Edit`.
- A direct scoped `NotebookEdit(path)` rule is accepted but never matched; startup diagnostics direct
  each allow/deny/ask occurrence to `Edit(path)`. A bare `NotebookEdit` still matches the tool.
- One cross runs the *other* way, and only in the deny direction: a path-scoped `deny: Read(<glob>)`
  also blocks `Edit`/`MultiEdit` on that path, mirroring Claude Code 2.1.208 (denying reads of a path
  also prevents clobbering or recreating it). `Write` and `NotebookEdit` are deliberately outside
  this cross. Being deny-only is the point — `allow: Read` must never grant `Edit`.

`MultiEdit` is a **real writer**, so a project cannot treat it as a degraded no-op safety net; its
`Edit`/`MultiEdit` deny rules are what hold.

**Placement:** anything holding live session state or touching a Pi object. For a new Claude-named
tool the rule is about *coupling*, not about the name: a **self-contained** tool goes in `tools/`;
a tool that is the **surface of a runtime subsystem lives with that subsystem**, because it needs
that subsystem's state and a `tools/` file would only re-export it (`Agent`/`Task`/`SendMessage`
ship from `subagents.ts`, `TaskOutput`/`TaskStop` from `background-tasks.ts`). Either way it must
route through the same permission/hook/injection machinery as its siblings — a tool that reaches the
filesystem outside the guard is a hole.

### `registry/` — the single source of truth for "what's supported"

`capability-registry.ts` holds every known tool, hook event, setting, frontmatter field, and feature
with a support tier, an optional `safetyRelevant` flag, and a one-line note. Anything unassessed
synthesizes a `not-supported` entry, so **unknown names still resolve for gating**.
`compat-report.ts` scans the loaded project against the registry and renders the `/doctor` report.
The generated [`doc/supported-features.md`](supported-features.md) reads the same registry through
[`scripts/gen-capability-matrix.mjs`](../scripts/gen-capability-matrix.mjs), keeping both surfaces
anchored to the same support claims.

**Placement:** every support claim, and the evidence behind a partial tier. Never restate a tier
claim in prose — state it here and link. Run `npm run gen:capabilities` after a registry change.

### `types.ts` — the shared vocabulary

The types more than one subsystem speaks, including `Scope` and `SCOPE_PRECEDENCE` — the precedence
constant the discovery prose above paraphrases. **It is the declaration, not a copy:** a precedence
question is settled here, not re-encoded per subsystem.

**Placement:** a type crossing subsystem boundaries. A type with one subsystem stays with that
subsystem — moving it here to be tidy makes every folder depend on every folder's vocabulary.

### `util/` — shared, dependency-light helpers

Never-throwing filesystem reads and repo-root detection; the shared gitignore-flavored glob engine
used by `paths:`, permission globs, `claudeMdExcludes`, and `.worktreeinclude`; frontmatter/body
splitting with lenient YAML; UTF-8 subprocess env; process-tree listing and killing; agent-id
minting and transcript-path derivation.

**Placement:** a pure helper with more than one consumer and no knowledge of the project model.
Single-consumer logic stays with its consumer.

## Request / turn data flow

The wiring lives in `src/index.ts`, which registers tools and Pi event handlers.

1. **Extension load.** The process env is made UTF-8-safe, then `loadClaudeProject()` assembles the
   project model. `CwdState`, `PermissionEngine`, `WorktreeManager`, `HookRunner` (behind a
   multiplexer so skill-scoped hooks can be added dynamically), `SubagentRuntime`, and `McpRuntime`
   (enabled MCP servers begin connecting in the background, non-blocking) are constructed. All
   Claude-named tools plus cwd-swapping overrides of Pi's built-ins are registered,
   the guard extension is installed on tool events, and prompt-template stubs are written for each
   user-invocable skill with an eligible, non-reserved name so it appears in the `/` palette. The
   per-session scratch dir is created
   eagerly here and its literal path held for injection.

   Load is **not** fully synchronous: the cwd-swapping overrides need Pi's SDK, so they register
   from an async step whose settlement is awaited by the ordinary input-admission seam rather than
   by load returning. The fixed replacement set is owned by `coreToolNames` in `src/index.ts`, and
   preparation completes for the whole set before registration begins. Any initialization failure
   rejects project task input before hooks or provider dispatch because Pi's stock built-ins cannot
   honor PiCC's live worktree cwd. Failure cleanup is remove-only for that fixed set: it cannot widen
   the active tools or release blocked input. See
   [“Core-tool readiness” in `pi-integration.md`](pi-integration.md#37-core-tool-readiness) for the
   exact lifecycle and retry mechanics.

2. **`session_start`.** Captures the model registry and active model, applies the configured
   model/effort, attempts to self-heal `core.hooksPath` when `.githooks/` and a resolved Git executable are
   available (otherwise skips it), and fires the `SessionStart` hook. Steering text is derived from
   the active model here and **re-derived on `model_select`**,
   so a mid-session model switch re-steers — steering follows the model, it is not a startup
   snapshot.

3. **`before_agent_start` (every turn).** Appends the system-prompt suffix, re-asserting the full
   instruction set and the scratchpad section each turn.

4. **`input`.** Checkpoint replay/disposition and extension-sourced input handling run first. For
   admitted non-extension user input, intercept PiCC control commands and handle the fallback for Pi
   built-ins before awaiting the fixed core replacement set. Registered non-provider control
   commands therefore remain available during a readiness failure. Ordinary project input across
   TUI, print, JSON, and RPC proceeds only after readiness: fire the `UserPromptSubmit` hook (block or
   inject context); expand `/skill [args]` slash commands by activating the skills and
   **transforming the user turn** into the rendered bodies; then checkpoint-capture accepted input
   before model delivery. The gate covers this ordinary input path, not authenticated extension
   continuations or arbitrary third-party direct-trigger turns that bypass it. Pi's exact router
   normally owns canonical interactive built-ins; any reserved Pi token reaching this admitted user
   path receives fixed canonical guidance outside hooks, skills, and model context.

5. **Tool calls → `guard`.** Each call is translated to its Claude name, checked against deny rules,
   run through PreToolUse hooks, and — on file-touching tools — triggers nested-CLAUDE.md and
   path-scoped rule/skill injection. PostToolUse / PostToolUseFailure hooks fire on the result.

6. **Subagent dispatch.** The `Agent`/`Task` tool calls `SubagentRuntime.dispatch`, which spawns a
   session with the gated tool set and returns either the final message verbatim or a loud,
   classified failure. Dispatch is background-by-default: the call returns a task id, and
   `TaskOutput`/`TaskStop` manage the lifecycle. `SendMessage` (parent-only) resumes a finished
   subagent by agent id or steers a running background one — never a user-stopped one; a panel stop
   is permanent.

7. **Cycle boundary / compaction / shutdown.** After a complete assistant/tool cycle reaches
   `proactiveCompactPercent`, the session-local controller stops another ordinary request, awaits
   one `ctx.compact()` transaction (or the child SDK equivalent), lets Pi own eligible retries inside it, and resumes the same
   logical run only after restoration and queued-input reconciliation. The controller permits its
   own summary request through the provider gate. Mixed, blocked, malformed, or queued tool paths
   abort and settle before compaction; a separate `agent_settled` sample is a non-resuming fallback.
   `session_before_compact` / `session_compact` fire compact hooks and restore bounded
   SessionStart(compact) context followed by recent active skill bodies within PiCC's heuristic
   character budget; PostCompact output is diagnostic-only, and the system-prompt
   suffix preserves durable instructions. SessionStart(compact) and PostCompact ordinary block output
   is diagnostic-only, while universal hook stop closes the committed-summary session. Confirmed
   pre-commit operational or hook exhaustion leaves admission paused and recoverable; any post-commit
   failure closes the session and requires replacement. An unconfirmed-host ending is process-terminal:
   neither manual recovery nor in-process replacement is safe. Pi's internally
   owned overflow recovery remains outside this controller and is not retried by PiCC. `Stop` runs
   at the logical settlement boundary, and `session_shutdown` joins checkpoint work and shuts down
   the MCP servers before firing `SessionEnd`.

## Mechanical-fidelity decisions (load-bearing)

These are the choices where "close enough" breaks real projects.

- **The cwd swap is load-bearing.** A project's own scripts detect worktree vs. main via standard git
  plumbing, which only works if *every* subsequent tool call runs inside the worktree directory. Pi
  has no session-cwd API, so PiCC re-registers the built-in `bash/read/write/edit/grep/find/ls`
  tools as thin wrappers that rebuild the real tool per call against `CwdState.get()`. Subagents
  resolve their cwd by the same mechanism: their built-ins are rebuilt per call against the
  dispatch-local `subCwd`, so a worktree a subagent enters mid-run takes effect for its own tools and
  its permission guard in lockstep.

- **A nested dispatch inherits its parent's cwd.** This is a deliberate PiCC coherence *decision*,
  not an observed Claude Code behavior — whether Claude hands a worktree-resident parent's cwd to its
  nested children is undocumented, so PiCC chooses the least-surprising option. A subagent that
  dispatches its own children hands them its live `subCwd` (threaded as the Agent/Task tool's
  `dispatchCwd` → the child dispatch's `parentCwd`), so a worktree-resident parent's isolation extends
  to the children it spawns rather than dropping them back at the orchestrator's cwd. Top-level (coordinator) dispatches carry no
  parent cwd and keep the orchestrator's; resume is unaffected (a resumed run reuses its original
  cwd/worktree). Scope of the inheritance: `parentCwd` sets a nested child's *starting* cwd only
  when that child does **not** enter its own worktree (`isolation: none`, or a failed worktree
  entry). A nested child that requests `isolation: worktree` still gets its worktree directory under
  the orchestrator's `projectRoot` — the `WorktreeManager` is pinned there and `parentCwd` is never
  threaded into worktree-path resolution — after which the child runs in that worktree. So `parentCwd`
  governs the isolation-`none` case; the worktree case is already isolated by construction.

- **The builtin bash tool's Git-Bash pin has one owner: the shared factory.** On Windows the factory
  (`buildStockBuiltinTools`) threads `shellPath` into every builtin bash it constructs, main session
  and subagent alike, so the model-invoked bash resolves Git Bash from a single source. Two other
  Git-Bash resolutions survive as separate, intentional backstops for *different* shells, not
  redundant copies: the main-session `!` user-bash (`createLocalBashOperations`) and the subagent's
  SDK-internal / `!`-shell path (the settings-manager `shellPath` in `loadRealSdk`). The
  settings-manager pin does **not** back the factory bash — the factory bash shadows stock bash by
  name, so the settings manager's stock-bash config never reaches the tool the model calls. The
  factory's `shellPath` threading is pinned by the win32 shared-factory bash-options unit test; the
  end-to-end proof that a subagent's bash actually resolves Git Bash on Windows is the real-stack
  subagent e2e (which runs a real subprocess), not the settings-manager backstop.

- **Verbatim subagent return.** A subagent's final message body is returned exactly as produced — no
  summarizing, no wrapping. Completed or truncated-completed resumable results append clearly
  delimited identity framing outside that body (the human TUI strips it), and settled `TaskOutput`
  retrieval may append compact usage metadata outside the body. A strict JSON/YAML consumer must
  parse the body and account for this documented surrounding metadata, or use a foreground one-shot
  dispatch when it needs no resume framing; background consumers must still account for retrieval
  metadata.

- **Subagent error contract.** Every dispatch is classified into exactly one outcome, and the
  classification — never a normal-looking success — is what reaches the coordinator:
  - **completed** — the run finished; its verbatim final message is returned.
  - **failed** — the run ended on a terminal API or session error. The tool reports a **loud
    failure** with capped, sanitized provider/API cause text that is treated as untrusted input and
    kept structurally separate from PiCC-authored guidance. An empty success here is the exact
    failure mode that lets a coordinator commit under-reviewed work believing a subagent approved it.
  - **aborted** — the run was stopped on purpose (Esc, `TaskStop`); distinct from a failure. A signal
    wins on every settle path, and a deliberately stopped background result discards its output.
  - **Partial output is preserved,** delivered inside an explicit cut-off frame rather than dropped;
    a turn-cap truncation also pushes a warning diagnostic, never silent.
  - The contract holds on the foreground, background-settlement, and `TaskOutput` paths through a
    shared structured disposition and fixed guidance formatter; each surface retains its own result
    envelope. A background failure is never shown as completed.
  - Pi owns retry execution, budget, and backoff. After those retries settle, PiCC derives guidance
    only from Pi's transient-error classifier and lifecycle observation. Complete observation can
    prove no successful assistant response, retained model/tool-call content, or started tool
    execution; observed progress or incomplete evidence takes the conservative branch. The
    recommendation is separate from factual resumability, and PiCC never dispatches or resumes
    automatically.

  Dispatch is **background-by-default**, matching Claude Code 2.1.198: an omitted `run_in_background`
  returns a task id so an implicit-concurrency fan-out parallelizes; `run_in_background: false` opts
  into a synchronous inline run, and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` forces every dispatch
  foreground. The residual divergences (notably settlement *timing*) and the upstream evidence for
  them are recorded in the capability registry — do not restate them here.

- **Nested background fan-out is concurrency-bounded.** Each depth gets its own
  `concurrency`-sized budget, so `maxDepth × concurrency` bounds the background pools. This
  per-depth design lets a parent blocked in `TaskOutput` await a child without competing for the
  same pool. Foreground nested dispatch bypasses those pools to prevent the corresponding
  parent/child deadlock, so total active work can exceed that product. The per-depth budget is a
  deliberately conservative, deadlock-free PiCC choice, **not** Claude Code parity.

- **Deny matches any command segment.** The matcher is shell-operator aware, so a deny like
  `Bash(rm *)` cannot be evaded by chaining (`git status && rm -rf /`) — every segment is matched
  independently. Space-before-`*` is a word boundary, so `Bash(git *)` matches bare `git` and never
  `github`.

- **Skills expand as an input-event transform.** `/name` is handled in the `input` handler by
  rewriting the user turn into the rendered skill body, rather than by a self-dispatching extension
  command — which cannot reliably trigger a turn in print mode. Palette visibility is provided
  separately via `resources_discover` prompt stubs. A project skill wins over a same-named plugin
  command.

- **Git Bash is pinned on Windows.** `resolveGitBashPath()` finds the real Git Bash and **skips the
  System32 WSL `bash.exe` stub**, which fails with `WSL_E_DEFAULT_DISTRO_NOT_FOUND` when no distro is
  installed. The resolved shell is passed to Pi's `createBashTool({ shellPath })` and to `!`
  user-bash, so hooks and project shell scripts both get a working bash.

- **UTF-8 subprocess env.** Every spawned child inherits a UTF-8 default, so a Windows cp1252 code
  page (or `LANG=C`) does not crash a tool that prints Unicode. An explicit project/user `env` value
  always wins.

- **A per-session native-safe scratchpad steers temp files off bare `/tmp`.** On Windows the pinned
  Git Bash and the native `Read`/`Grep`/`Glob` tools resolve path *strings* in different namespaces:
  a bare `/tmp/foo` is the shell's mount to Git Bash but a drive-relative `F:\tmp\foo` to native Node
  — the same string, two different real files — so a subagent's first `Read` of a coordinator-written
  temp file `ENOENT`s and burns context recovering. The harness therefore creates one eager
  per-session scratch dir in the form both namespaces agree on and injects its **literal resolved
  path** into the system prompt every turn. The path is literal rather than an env var because that
  mirrors Claude Code's own scratchpad contract, keeping a skill authored against it portable back to
  Claude Code.

  **There is no path *rewriting*.** Translating model-chosen `Read`/`Grep`/`Glob` paths was
  considered and **deliberately rejected**: it is a Claude divergence and a permission-guard risk
  (the guard would match a rule against one path while the tool touched another). The fix is honest
  steering plus a correct first consumer, not silent path translation. The author-facing contract is
  the injected prompt guidance itself; this doc is the contributor record.

- **Everything degrades, nothing crashes.** Loaders never throw; the hook runner and worktree manager
  return error results rather than throwing; unknown tool, setting, hook, and frontmatter names
  resolve to a synthesized `not-supported` entry and are surfaced as *unassessed*. This is the
  completeness floor and forward compatibility in one rule: a project using something we do not yet
  support runs, minus that feature.

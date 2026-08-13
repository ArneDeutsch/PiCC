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
                │ default export picc(pi)  (installed: picc/index.js;
                │                           explicit source: src/index.ts)
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

PiCC is **not a fork** of Pi. Pi is an ordinary npm dependency, and PiCC attaches as one extension
bundle. `src/index.ts` remains the TypeScript authoring and implementation composition root. The
installed Pi boundary instead receives `picc/index.js`, a stable wrapper that verifies product
identity before importing the generated `dist/index.js`; explicit source development may give Pi
`src/index.ts` directly. The pinned, tested dependency graph is recorded in
[`doc/pi-integration.md`](pi-integration.md). Pi supplies everything model- and UI-related; PiCC
supplies Claude Code compatibility and **never** reimplements auth, the provider layer, or the TUI
shell. A change that would duplicate a Pi responsibility inside `src/` is the wrong change — extend
the seam instead.

Source and generated JavaScript are two representations of one product. The PiCC launcher selects
the representation and verifies any compiled runtime before extension load: installed mode therefore
fails closed rather than reaching retained TypeScript, while a source checkout may disclose a
development fallback. A
compiled selection pins its verified generation for the process, so Pi's `/reload` cannot adopt a
new build. Source-hosted reload remains source-hosted and may observe source edits under Pi's reload
semantics.

The carve-out: PiCC does render **its own** tool rows, built on Pi's `pi-tui` primitives — that is
what `tool-shell.ts` and `subagent-render.ts` are. Rendering a surface PiCC owns is in scope;
owning the shell it renders into is not.

### The PiCC ⇄ Claude Code boundary: compatible-but-independent

The two harnesses meet at the **filesystem and git level only**, and deliberately nowhere else. A
worktree or git history produced by one is clean and usable by the other; a user can switch
providers at will on one project and run **parallel sessions on different worktrees under different
models**. They do **not** exchange live session state, and there is **no mid-flight handoff** of a
live worktree or session between them.

This is why PiCC state lives outside the project or in the harness-owned `.claude/.picc/`, which
PiCC attempts to add to repository-local excludes, and why compatibility work targets artifacts on
disk rather than any shared runtime protocol. Anything that would require the two harnesses to agree at runtime is out of scope
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

**MCP server config** is a third input. The platform-fixed standalone `managed-mcp.json` is an
exclusive administrator authority: its presence suppresses ordinary acquisition, including native
Claude user/project-local state, project `.mcp.json`, and the subordinate PiCC `mcpServers` settings
extension. `discovery/claude-profile.ts` selects one coherent user profile, the native loader uses
canonical project identities, and `discovery/mcp.ts` otherwise resolves whole entries in native local
→ `.mcp.json` → native user → settings extension order. It compiles one immutable managed-settings
policy and admits each raw effective winner before expansion, approval, native disablement, or
runtime materialization. Project `.mcp.json` and project-origin extension servers stay pending until
approved from a user-authored settings scope; native local/user definitions instead use native
runtime disablement. A git-tracked `settings.local.json` is demoted to project scope so a cloned repo
can never self-approve. The fixed bounded Git classification may precede final policy admission only
where it can change same-name winner or approval selection; inadmissible contenders do not trigger it,
and no further classification occurs after a blocked winner is known. Present-but-unusable
authoritative native state or standalone managed MCP fails MCP closed, while absence preserves the
applicable lower inputs.

Every current MCP source crosses this admission seam before post-admission materialization. Agent-inline
admission uses the same immutable policy and approval snapshot, then materializes only inside its named
dispatch; it never widens ordinary MCP sources or the parent inventory. Future plugin or explicit
runtime/CLI adapters must cross the same seam before their sources can be claimed as supported.

**Managed policy** is discovered by `discovery/managed-policy.ts` and applied as ordered, attributed
source contributions after ordinary settings. Plugin enablement is validated per qualified identity
at each source before later sources replace that identity, so malformed policy cannot be coerced
into activation or lose its diagnostic owner.

**Placement:** new scopes, precedence rules, or settings-shape handling. Nothing that interprets an
artifact's *content*.

### `claude/` — parse each artifact format (loaders only, no runtime)

One loader per Claude artifact format — skills and commands, agents, rules, the CLAUDE.md hierarchy
with `@import` expansion, memory, hooks config, MCP server entries (standalone `managed-mcp.json`,
`.mcp.json`, native Claude state, and settings `mcpServers` blocks; `managed-mcp.ts`, `mcp-config.ts`,
and `claude-mcp-state.ts`), and installed-plugin content. `src/project.ts` — at the source root, *above* the loaders, importing both `discovery/` and
`claude/` — orchestrates them
into one loaded project model. It sits outside this folder precisely because it depends on both:
a loader knows one format and nothing else.

Invariants across the folder:

- **Loaders never throw.** Malformed ordinary input degrades to an empty value plus a diagnostic.
  Authoritative native MCP state and standalone managed MCP are deliberate exceptions: absence
  preserves lower inputs, but a present unusable authority returns an explicit fail-closed result so
  uncertainty cannot activate a server. A broken project must never crash the harness:
  `src/index.ts` catches load failure and returns quietly.
- **Progressive disclosure is a hard requirement, not an optimization.** Skill frontmatter is
  parsed; the body is **never** stored on the returned object and is re-read only on activation. A
  change that eagerly holds bodies defeats the whole design.
- **The startup skill listing degrades tier by tier, but never omits a skill.** A budget may shrink
  an entry to its name; it may not make a skill invisible.
- Plugin **content** is folded into the same registries only after installed-state selection and
  whole-plugin validation succeed. Marketplace catalogs and repository/development roots are not
  loader inputs.

**Placement:** a new artifact format, or a change to how an existing one parses. No session
awareness, no I/O beyond reading the artifact.

#### Installed-plugin assembly boundary

`claude/plugin-installed-state.ts` adapts the captured Claude installed-state v2 fixture layout into
normalized imported records; the upstream format is undocumented and is not a permanent PiCC API.
`plugin-lifecycle/admission.ts` independently validates one complete committed PiCC-owned profile
generation before active-project projection. Exact-record selection and no-fallback failure are
PiCC-defined; the generated
[capability matrix](supported-features.md) owns exhaustive tiers and limits. The adapter does not scan
storage for candidates. `claude/plugins.ts` owns qualified-identity selection and turns one
applicable record into normalized component loader inputs. `claude/plugin-paths.ts` owns the canonical
selected-root and persistent-data containment boundary, including close-to-use revalidation.
Component loaders consume those validated inputs rather than reopening authority from manifest
values.

The qualified `name@marketplace` identity owns root authorization, installed version, and runtime and
persistent-data context. A valid manifest `name` owns the visible skill, command, and agent namespace;
manifestless content uses the installed identity's lifecycle name.

`src/project.ts` is the composition point: it combines applicable owned and imported installations,
resolves source-aware settings enablement and winning ownership, then merges successful contributions
into the ordinary project registries while preserving qualified runtime context. Assembly-time terminal installed-root, identity, manifest, declaration,
containment, or component-source failures reject the plugin as a unit. Safe component parse or
loader warnings may instead omit only affected content while the plugin remains loaded. Runtime
activation and subagent construction use qualified context for root/data/project substitution and
create isolated persistent data only at point of use; a close-to-use failure blocks that execution
and is retained for compatibility reporting without retroactively changing assembly. Selection
diagnostics and retained runtime failures flow to the compatibility report; no diagnostic pass
rescans plugin storage.

After plugin assembly finalizes shared-registry dedupe, overrides, whole-plugin rejection, and
retained executable hook registrations, `src/project.ts` builds one root-level immutable inventory
snapshot. Its per-plugin join is keyed only by qualified identity across installed-state
observations, enablement, selected records, final runtime outcomes, and capability evidence.
Marketplace registrations and managed policy remain global observations; qualified catalog entries
join a plugin only as inert declarations. Metadata for a selected plugin comes from the exact
manifest object already read for selection; observational metadata for unselected records uses a
separate bounded, contained read capability and cannot authorize execution.

The snapshot is observational, never an execution input. Catalog declarations can describe
components, dependencies, and renames for inventory, but never authorize a root, merge content,
resolve dependencies, rewrite settings, or start unsupported components. Session `/plugin` views,
startup diagnostics, and `/doctor` consume the same fixed snapshot for the extension lifetime;
launcher inventory commands build one command-scoped snapshot without normal runtime startup.
Consumers produce bounded, redacted projections without rereading plugin state. Post-capture
point-of-use refusals remain separate live evidence. Refreshing a session snapshot requires `/reload-plugins` in the interactive TUI or a new PiCC
session. Construction and viewing perform no
marketplace refresh or acquisition, settings or registry writes, plugin process startup, hook
execution, usage mutation, or prompt-cache invalidation.

### `plugin-lifecycle/` — owned acquisition and durable desired state

This subsystem owns safe source routing and acquisition, immutable artifact and marketplace snapshot
storage, exact PiCC-owned installation/registration records, settings planning/writing, executable
admission generations, transaction receipts, and offline recovery. It is the only lifecycle mutation
authority. Imported Claude installations and Claude-owned, seed, or managed marketplace registrations
are assembly inputs and remain read-only.

`src/project.ts` remains the project-assembly authority: it captures applicable imported executable
trees, validates the one committed PiCC-owned generation, combines both ownership families, resolves
effective enablement and dependencies, and produces the session snapshot and reload candidate. Plugin
skill and legacy-command Markdown is privately captured during assembly and later activated from those
bytes; ordinary skills retain progressive disclosure by reading their file on activation. Terminal
commands and the focused TUI share the typed `PluginLifecyclePort` composition in
`plugin-inventory-cli.ts`; passive inventory browsing never crosses its mutation methods. Lifecycle
receipts refresh durable desired-state projections, while the loaded runtime stays session-captured
until a successful `/reload-plugins` replacement or a new session.

**Placement:** lifecycle source, storage, transaction, settings, trust, dependency, and recovery code.
Project contribution selection and final runtime assembly remain in `src/project.ts` and the Claude
component loaders.

### `engine/` — the deterministic enforcement primitives

- **`permissions.ts`** — the permission-matcher grammar (`Bash(git *)`, `Read/Edit(glob)`,
  `WebFetch(domain:*)`, `Agent(type)`, `Skill(name)`, `mcp__server__tool`) and the `deny` engine.
  Matching is **shell-operator aware**, paths are normalized to POSIX form on Windows, and it never
  throws.
- **`mcp-policy.ts`** — compiles bounded managed-setting contributions into one immutable admission
  snapshot and evaluates raw stdio/remote identities deny-first, without ambient reads or runtime
  materialization. Uncertainty that could weaken an applicable restriction fails closed.
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
  marker and `SendMessage` refuses to steer or resume a user-stopped agent — distinct from an ordinary
  model `TaskStop`, after which PiCC still allows resume (the divergence is recorded in the capability
  registry). A confirmed post-commit retained child remains terminal even when model `TaskStop` owns
  its abandonment.

  `subagent-transcript-retention.ts` owns bounded cleanup of persisted child collections.
  Activation starts detached orphan-worktree reaping; only the startup `session_start` may run the
  transcript reaper, once. Every `session_start` immediately touches the current persisted main
  transcript and replaces its hourly heartbeat; replacement starts do not rerun transcript cleanup.
  A fresh verified parent retains its whole collection; a stale verified parent admits recognized
  children only with no conflicting ownership marker, while parentless cleanup requires the
  collection's matching PiCC ownership marker. The startup collection is excluded exactly.
  Malformed, unreadable, or mismatched ownership evidence, changed authority, and I/O failures
  preserve data and flow to one bounded notice rather than blocking startup.

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

- **MCP runtime** (`mcp.ts`, `mcp-remote.ts`, `mcp-tools.ts`, `mcp-prompts.ts`,
  `mcp-resources.ts`) — starts only **enabled, policy-admitted** discovery-resolved servers without
  blocking extension load. Blocked identities never enter this layer. `mcp.ts` owns transport lifecycle, capability negotiation, immutable initial tool/prompt/
  resource snapshots, live status, and recovery-aware operations over the current client;
  `mcp-remote.ts` owns the safe remote adapter and typed failure/disconnect evidence. Tool catalogs
  become guarded `mcp__<server>__<tool>` proxies, prompt catalogs feed the user-input and palette
  path, and a settled initial snapshot advertising resource capability conditionally registers two
  guarded fixed tools even when its catalog is empty or failed. Recovery cannot widen any catalog or
  inherited tool set, and the fixed resource schemas survive reconnect and terminal retained states.
  The enablement gate is enforced by construction: no enabled server means no MCP context; no
  published prompt means no prompt metadata; and no advertised resource capability in the settled
  initial snapshots means no resource-tool schemas. Owned resources close with the session.
  `agent-mcp.ts` composes immutable named-dispatch catalogs and routing from borrowed eligible session
  servers plus one owned agent-inline runtime; a published session route quietly wins any same-name
  inline admission result. Dispatch starts the scope after initial worktree admission and before tool
  gating or the first provider request. It retains the scope through scoped stop hooks and checkpoint
  recovery, then awaits shutdown before worktree release and terminal settlement. A successful later
  EnterWorktree queries live published owned-stdio routes at that boundary before adding pin guidance.
  After main custody is confirmed, session shutdown fences and joins active generations before its one
  retained persistence/quarantine scan, joins linked and other background tasks, cleans checkpoint-paused
  children, shuts down scoped MCP and then the global runtime, and only then fires SessionEnd. Unconfirmed
  main or child custody stops before scoped or global MCP shutdown and before SessionEnd. Agent-inline capabilities never
  enter the parent inventory or a sibling/nested agent. Nested agents with omitted or clean-empty
  declarations still inherit eligible published main-session routes; parent-inline routes do not
  propagate. Claude documents the agent declaration's list/reference/inline shape and
  plugin/managed-policy boundaries. Non-empty declaration selection and parent-inline
  non-propagation are inferred, unverified PiCC choices. Dispatch ordering, session-wins collision precedence,
  worktree-cwd pinning, warning and result framing, and in-process resume reconstruction are also
  PiCC-defined coherence choices, not parity claims.

- **Proactive compaction** (`mid-run-compaction.ts`, with main wiring in `index.ts` and child wiring
  in `subagents.ts`) — on supported model APIs, a session-local controller observes fresh successful
  tool-requesting assistant usage, queues threshold pressure while the requested tools finish, handles
  complete batches at `turn_end`, and samples again at final provider admission. Newly known pressure
  blocks that ordinary request before provider transport. `agent_settled` is the only boundary that
  may start one physical Pi-owned compaction transaction if the checkpoint is still required, and only
  after no provider response or tool batch remains unresolved; the controller then owns queued-input
  reconciliation, resume, cancellation, and exhaustion. Confirmed pre-commit operational or hook
  exhaustion remains recoverable in-session. After a committed summary, the only safe cancellation
  exception is an exact aborted assistant terminal followed by settlement of that same selected-branch
  message: the main TUI restores text to the editor, while child input becomes one canonical retained
  report. The main-session reuse exception is TUI-only. Pi 0.83 RPC abort does not reclaim native
  queued input, so any authenticated live-RPC cancellation outcome leaves the shared controller
  exhausted with admission closed, requires status 3 and external PiCC process plus session
  replacement, and never permits same-session resubmission. The cancellation handoff authenticates
  a `reusable`, `terminal`, or `restart-required` disposition; publication derives its action from
  that authority. The accepted session epoch latches a readable mode only for the same session, so
  a stale terminal context preserves known RPC without inferring it or leaking it to a successor.
  Pi may drain the queues
  before PiCC can present that outcome; PiCC does not intercept or purge them. Every other
  post-commit restoration, replay, provider/tool, or continuation failure remains terminal.
  `SubagentRegistry` is the sole report and quarantine authority; `TaskOutput`, foreground
  Agent/Task results, settlement notices, and the panel all consume that same immutable report identity.
  Unconfirmed child records stay quarantined and cannot be stopped, disposed, or released twice.
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

1. **Extension load.** Before this implementation root runs, an installed or checkout-compiled
   wrapper verifies and pins the compiled runtime generation; a source-checkout launcher instead may
   have emitted its TypeScript-fallback notice. Explicit external-Pi source hosting performs neither
   launcher selection nor compiled-generation verification. The process env is then made UTF-8-safe,
   and `loadClaudeProject()` assembles the project model. MCP loading resolves standalone authority
   and immutable managed-settings policy, admits raw winners, and materializes only enabled results.
   Project opening and observation perform no plugin acquisition, trust approval, lifecycle recovery,
   or settings mutation. `CwdState`, `PermissionEngine`, `WorktreeManager`, and `HookRunner` (behind a
   multiplexer so skill-scoped hooks can be added dynamically), `SubagentRuntime`, and `McpRuntime` (admitted enabled
   MCP servers begin connecting in the background, non-blocking) are constructed. All
   Claude-named tools plus cwd-swapping overrides of Pi's built-ins are registered, the guard
   extension is installed on tool events, and extension load creates the MCP exposure transaction.
   When initial settlement completes, that transaction publishes stable proxies, the prompt command
   catalog, and conditional resource tools. The later async `resources_discover` event awaits the
   settled exposure and writes frontmatter-only stubs for each eligible user-invocable skill and
   published MCP prompt so it appears in the `/` palette. The per-session scratch dir is created
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
   **transforming the user turn** into the rendered bodies; after local command precedence, fetch a
   known MCP prompt and transform its result into bounded user content; then checkpoint-capture
   accepted input before model delivery. Handled MCP prompt failures send no provider request. The
   gate covers this ordinary input path, not authenticated extension continuations or arbitrary
   third-party direct-trigger turns that bypass it. Pi's exact router
   normally owns canonical interactive built-ins; any reserved Pi token reaching this admitted user
   path receives fixed canonical guidance outside hooks, skills, and model context.

5. **Tool calls → `guard`.** Each call is translated to its Claude name, checked against deny rules,
   run through PreToolUse hooks, and — on file-touching tools — triggers nested-CLAUDE.md and
   path-scoped rule/skill injection. PostToolUse / PostToolUseFailure hooks fire on the result.

6. **Subagent dispatch.** The `Agent`/`Task` tool calls `SubagentRuntime.dispatch`. A supported named
   agent resolves its admitted MCP declaration after SubagentStart and initial worktree admission;
   startup settles before the combined tool universe is gated and before the first child request.
   The runtime then returns either the final message verbatim or a loud, classified failure, with
   bounded MCP qualification outside that body when setup or cleanup degraded. Dispatch is
   background-by-default: the call returns a task id, and `TaskOutput`/`TaskStop` manage the lifecycle.
   `SendMessage` (parent-only) resumes a finished agent only from its captured canonical definition
   provenance, using the current definition/policy and original cwd, or steers a running background
   one — never a user-stopped one; a panel stop is permanent.

7. **Cycle boundary / compaction / shutdown.** On supported model APIs, final usage from a fresh
   successful assistant response that requests tools can queue threshold pressure while the requested
   tools finish. `turn_end` handles the complete batch; immediately before any next ordinary provider
   request, the controller samples again and blocks transport when newly known pressure arms the
   checkpoint. `agent_settled` is the only boundary that may start one physical compaction transaction
   if the checkpoint is still required, and only after provider and tool work is resolved. It then
   awaits `ctx.compact()` (or the child SDK equivalent), lets Pi own eligible retries inside that one
   transaction, and resumes the same logical run after restoration and queued-input
   reconciliation. The controller permits its own summary request through the provider gate. Mixed,
   blocked, malformed, or queued tool paths abort and settle before compaction; the settled sample
   also remains a non-resuming fallback.
   `session_before_compact` / `session_compact` fire compact hooks and restore bounded
   SessionStart(compact) context followed by recent active skill bodies within PiCC's heuristic
   character budget; PostCompact output is diagnostic-only, and the system-prompt
   suffix preserves durable instructions. SessionStart(compact) and PostCompact ordinary block output
   is diagnostic-only, while universal hook stop closes the committed-summary session. Confirmed
   pre-commit operational or hook exhaustion leaves admission paused and recoverable. An exact
   aborted-terminal/same-branch settlement after resume may instead reconcile retained main input
   without replaying work in the TUI. A presented live-RPC outcome requires terminating PiCC and
   starting a fresh process and fresh session; print and JSON remain partial/nonzero
   retrieve-and-relaunch outcomes. The authenticated RPC ending is process-terminal despite confirmed
   quiescence: neither manual recovery nor in-process new/resume/fork/reload replacement is safe. All
   ambiguous or other post-commit failures close the session and require replacement. An
   unconfirmed-host ending is likewise process-terminal. Pi's internally
   owned overflow recovery remains outside this controller and is not retried by PiCC. `Stop` runs
   only at a successfully completed logical settlement boundary; logically unsuccessful outcomes
   bypass ordinary Stop handling. Confirmed `session_shutdown` follows the active-generation, retained
   scan, background-join, checkpoint-paused, scoped-MCP, global-MCP, then `SessionEnd` order described
   above; unconfirmed main or child custody reaches neither MCP shutdown nor `SessionEnd`. Confirmed child retained-input reports receive one bounded
   best-effort persistence attempt before retained cleanup. Exact reopen verification of either one Pi
   session custom entry or one restrictive atomic recovery file under the verified Pi session owner
   produces a locator; complete storage failure names a bounded subset of affected generated agent IDs,
   emits an explicit possible-loss warning with transcript and caller-owned request-history recovery where
   available plus effect inspection, and continues
   ordinary cleanup and `SessionEnd`. Unconfirmed reports remain quarantined and block cleanup rather
   than being serialized as confirmed data. Their bounded affected-agent projection includes only each
   outcome's exact current-registry ID and transcript path as reversible JSON-quoted values, or an
   explicit no-path marker; path characters are not truncated or collapsed. Quote delimiters frame the
   value and are not path characters. A live non-quit boundary makes `TaskOutput` conditional on a
   canonical report and otherwise names those decoded paths for copying before exit; after
   renderer-stopped `quit`, it names them for recovery before or after restart. Transcript paths survive process replacement, while
   agent IDs do not; caller-owned parent/client request history is the remaining source where available
   for an affected agent without a recorded path.

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
  - **failed** — the dispatch or run ended through the loud failure channel. Ordinary terminal
    assistant errors expose capped, sanitized provider/API cause text as untrusted input and may
    carry a structured disposition rendered by PiCC's fixed formatter. Identity, setup, depth,
    policy, hook, checkpoint, and other specialized failures instead retain their cause-specific
    framing and receive no generic disposition. An empty success here is the exact failure mode that lets a
    coordinator commit under-reviewed work believing a subagent approved it.
  - **aborted** — the run was stopped on purpose (Esc, `TaskStop`); distinct from a failure. A signal
    wins on every settle path, and a deliberately stopped background result discards its output.
  - **Partial output is preserved,** delivered inside an explicit cut-off frame rather than dropped;
    a turn-cap truncation also pushes a warning diagnostic, never silent.
  - For ordinary terminal assistant errors carrying a disposition, the contract holds on the
    foreground, background-settlement, and `TaskOutput` paths through the shared structured
    disposition and fixed guidance formatter; each surface retains its own result envelope. A
    background failure is never shown as completed.
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

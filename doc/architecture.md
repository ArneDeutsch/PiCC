# PiCC architecture

A contributor's map of how PiCC runs a Claude Code project on a GPT/Codex model. It is
factual and cites file paths; for *what* and *why* see [`doc/plan/picc-plan.md`](plan/picc-plan.md),
and for the exact Pi API contracts see [`doc/design/pi-integration.md`](design/pi-integration.md).

## 1. Layered design

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
│            cwd-state · tools · skill-activation · steering)         │
│                    │                                                 │
│            registry (capability registry · compat report)          │
└──────────────────────────────────────────────────────────────────────┘
```

PiCC is **not a fork** of Pi (design §Q1): Pi is an ordinary npm dependency
(`@earendil-works/pi-coding-agent`, `-agent-core`, `-ai`, all pinned `0.80.x`), and PiCC
attaches as a single extension whose entry is `src/index.ts`. Pi supplies everything model- and
UI-related; PiCC supplies Claude Code compatibility and never reimplements auth, the provider
layer, or the TUI (design §3.6).

## 2. Module map (`src/`)

### `discovery/` — where artifacts live, and precedence
- `locations.ts` — resolves the repo root and the artifact directories across scopes (user
  `~/.claude/`, project `.claude/`, local, managed), with the monorepo walk-up (cwd → root,
  nearest wins) (plan §3).
- `settings.ts` — reads and merges the `settings.json` hierarchy in ascending precedence
  (user → project → local → managed), splitting recognized-but-deferred keys and unknown keys out
  for the compatibility report (plan §5).

### `claude/` — parse each artifact format (loaders only, no runtime)
- `skills.ts` — `.claude/skills/**/SKILL.md` + `.claude/commands/**/*.md` (recursive; a nested
  entry whose name collides is qualified as `sub:name`). Parses **frontmatter only**; the body is
  never stored on the returned object (`body: undefined`) — progressive disclosure is a hard NFR
  (plan §12.1). `loadSkillBody` re-reads on activation. Also renders the budgeted startup skill
  listing (per-entry cap 1536 chars, tiered degradation down to names-only — a skill is never
  omitted) and hosts argument substitution (`$ARGUMENTS`, 0-based `$N`, named, `\$` escaping).
- `agents.ts` — `.claude/agents/*.md` into `ClaudeAgent` records, plus `builtinAgents()` — the
  built-in `general-purpose`/`Explore`/`Plan` types (project agents with the same name override;
  `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` removes Explore/Plan); renders the description-driven
  routing catalog injected into the orchestrator context.
- `rules.ts` — `.claude/rules/**/*.md`; files without `paths:` load unconditionally, files with
  `paths:` inject on matching-file access (plan §4.2).
- `claude-md.ts` — CLAUDE.md hierarchy: `@import` expansion (recursive, hop-limited, code-span
  aware — also the `@AGENTS.md` bridge), session-start collection (managed-policy CLAUDE.md and
  the inline `claudeMd` settings key first, then user, then every ancestor from the **filesystem
  root** down to cwd with `CLAUDE.local.md` siblings), and `findNestedClaudeMd` for
  nearest-ancestor injection on file touch (plan §4.6).
- `memory.ts` — the memory read side: `loadAutoMemory` (per-project `MEMORY.md` under
  `<userDir>/projects/<flattened-path>/memory`, first 200 lines / 25 KB, gated by
  `autoMemoryEnabled`/`autoMemoryDirectory`/`CLAUDE_CODE_DISABLE_AUTO_MEMORY`) and
  `loadAgentMemory` for the agent `memory: user|project|local` frontmatter scopes.
- `hooks.ts` — normalizes the settings `hooks` value into `HookConfig`; keeps unknown event names
  and non-command handler types (they degrade, never throw).
- `plugins.ts` — discovers already-installed plugins under `<userDir>/plugins` and a project
  `.claude-plugin/`, folding their content into the same registries. Installation/marketplace
  machinery is explicitly out of scope (plan §4.9).

`project.ts` orchestrates all loaders into one `LoadedProject` (settings, skills, agents, rules,
CLAUDE.md, plugins, merged hooks). A broken project must never crash the harness — `src/index.ts`
catches load failure and returns quietly (completeness floor, plan §2.2).

### `engine/` — the deterministic enforcement primitives
- `permissions.ts` — the permission-matcher grammar (`Bash(git *)`, `Read/Edit(glob)`,
  `WebFetch(domain:*)`, `Agent(type)`, `Skill(name)`, `mcp__server__tool`) and the `deny` engine.
  The grammar is fully implemented even though `allow`/`ask` are a no-op, because three subsystems
  reuse it: `deny` enforcement, `tools:` gating, and hook `if:` conditions. Matching is
  **shell-operator aware** — `git status && rm -rf /` does not match `Bash(git *)`. Space-before-`*`
  is a word boundary (`Bash(git *)` matches bare `git` too, never `github`), and file-rule paths
  are normalized to POSIX form on Windows (`C:\Users` ↔ `//c/**`, case-insensitive). Never throws.
- `hook-runner.ts` — spawns `type: command` hooks via `node:child_process.spawn`, delivers the
  Claude Code JSON payload on **stdin** (incl. `permission_mode`, `transcript_path`,
  `tool_use_id`, `last_assistant_message`, structured `tool_response`), and aggregates the
  exit-code / stdout-JSON contract (exit 2 = block; `permissionDecision`; `additionalContext`;
  `updatedInput`; `systemMessage`/`suppressOutput`) into a `HookOutcome`. Matching handlers run
  in **parallel** with identical-command dedup and most-restrictive merge; `async: true` handlers
  are fire-and-forget; matchers follow Claude semantics (exact names / `|`,`,` alternation /
  unanchored regex). `fire()` never throws.
- `shell-inject.ts` — preprocesses skill bodies: inline `` !`cmd` `` and `` ```! `` fenced blocks are
  replaced with command stdout before the model sees the content, honoring `shell:` (bash default /
  powershell) and `disableSkillShellExecution`. Also hosts `resolveGitBashPath()` (see §4).

### `runtime/` — wiring the parsed model into a live Pi session
- `context-assembly.ts` — builds the system-prompt suffix appended every turn in
  `before_agent_start`: root CLAUDE.md, auto memory, unconditional rules, budgeted skill listing,
  agent catalog, steering text, and rendered active-skill bodies. Because the system prompt is
  rebuilt each turn and never compacted away, **this is also the primary compaction-preservation
  mechanism** (plan §9).
- `subagents.ts` — `SubagentRuntime`: spawns a fresh in-memory Pi session per dispatch (agent body
  as system prompt + CLAUDE.md/rules, **not** the parent conversation; the built-in Explore/Plan
  types skip the project context), fans out under a concurrency cap, applies per-agent
  `tools:`/`model`/`effort` (with `CLAUDE_CODE_SUBAGENT_MODEL` as the highest-priority model
  override), enforces the depth cap (default 5), runs agent-scoped `hooks:`, supports
  `isolation: worktree`, `run_in_background`, and `background: true` frontmatter, and returns the
  subagent's final message **verbatim** (skills parse locked YAML from it — a hard contract,
  plan §4.3). It also classifies every dispatch outcome (see *Subagent error contract* in §4),
  mints a stable **agent id**, persists a **transcript** discoverable next to the main session's,
  streams **live progress** to the UI via `subagent-progress.ts`, captures **per-subagent usage**,
  and — through `subagent-registry.ts` — backs the `SendMessage` resume/steer channel (F02).
- `subagent-registry.ts` — the process-lifetime dispatch registry (agent-id keyed, name→id index
  with rebinding detection): records every dispatch's transcript path, resumability, outcome, and
  usage so `SendMessage` can resolve an address registry-only and the `/usage` command can report a
  per-subagent breakdown.
- `subagent-progress.ts` — `SubagentProgressCondenser`: a bounded, sanitized rolling tail of a
  running subagent's tool/assistant activity (incl. silent API-retry waits), plus the shared
  display formatters (`sanitizeLine`, `formatUsageCompact`).
- `subagent-transcripts.ts` (in `util/`) — agent-id mint/validate, the `<base>.subagents/` dir
  derivation + resolver, and the agent-id result trailer.
- `background-tasks.ts` — `BackgroundTaskRegistry` plus the real `TaskOutput`/`TaskStop` tools:
  `run_in_background: true` registers the un-awaited dispatch under a task id; `TaskOutput`
  waits/polls for the result (a failed task reports its cause, never an empty success),
  `TaskStop` requests a cooperative abort (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` falls back to
  foreground). Settlement of a background dispatch is **pushed** to the coordinator at its next
  turn (a bounded, untrusted-framed notice) so it learns the outcome without polling `TaskOutput`.
- `background-identity.ts` — shared validated and bounded background identity formatter, with fixed
  fallbacks for invalid task ids, agent ids, and display types.
- `worktrees.ts` — `WorktreeManager` for `EnterWorktree`/`ExitWorktree`: creates
  `.claude/worktrees/<flat>/` on `worktree-<flat>` off a base ref resolved to a concrete SHA
  *before* creation, seeds `.worktreeinclude` files, and does Windows-tolerant removal (best-effort,
  reap orphans later, `core.longpaths`). Public methods never throw.
- `cwd-state.ts` — `CwdState`: the single mutable source of truth for the effective cwd. Pi has no
  session-cwd API, so every tool resolves its cwd through `get()` at execute time; `EnterWorktree`
  swaps it, `ExitWorktree` restores (plan §4.4 — load-bearing).
- `guard.ts` — `createGuardExtension`: the inline Pi extension shared by the main session and every
  subagent. On Pi's tool events it applies deny rules (hard block), PreToolUse hooks
  (block / `updatedInput` / `additionalContext`), PostToolUse / PostToolUseFailure hooks, and
  on-touch context injection (nested CLAUDE.md, path-scoped rules/skills).
- `tool-map.ts` — the Claude ⇄ Pi tool-name mapping (`Read↔read`, `Glob↔find/ls`, …). The
  permission/hook/gating layer operates on Claude names; Pi tool names are translated back before
  matching. Unknown names stay verbatim and match string-identically.
- `skill-activation.ts` — the activation pipeline: lazy body load → argument substitution
  (`$ARGUMENTS`, `$N`, named) → `${CLAUDE_*}` variable substitution → `!`-injection. Shared by the
  `Skill` tool, slash commands, and `context: fork` dispatch.
- `steering.ts` — loads the project-external `PiCCConfig` (`~/.picc/config.json` or the
  gitignored `.claude/.picc/config.json`); provides per-model steering text and the
  effort→thinking-level mapping (plan §10, §13.2).
- `tools/` — the registered Claude-named tools: `web-tools.ts` (`WebFetch`/`WebSearch`, real),
  `search-tools.ts` (`Grep`/`Glob`), `task-tools.ts` (`Task*` tracking), `worktree-tools.ts`
  (`EnterWorktree`/`ExitWorktree`), and `degrade-stubs.ts` (names that resolve for gating but no-op
  with a notice — `NotebookEdit`, `LSP`, `AskUserQuestion`, `ExitPlanMode`, …).

### `registry/` — the single source of truth for "what's supported"
- `capability-registry.ts` — `CAPABILITY_REGISTRY: CapabilityEntry[]` and `CLAUDE_BASELINE`. Every
  known tool, hook event, setting, frontmatter field, and feature with a tier
  (`full | partial | degraded-noop | not-supported | na`), an optional `safetyRelevant` flag, and a
  one-line note. `capabilityForToolName()` synthesizes a `not-supported` entry for anything
  unassessed, so unknown names still resolve for gating (plan §2.4, §17).
- `compat-report.ts` — scans the loaded project against the registry, splits safety-relevant from
  functionality findings, and renders the one-per-session startup notice and the `/doctor` report.
  Because both are generated from the registry, docs and behavior cannot drift.

`doc/supported-features.md` is generated from this registry by
[`scripts/gen-capability-matrix.mjs`](../scripts/gen-capability-matrix.mjs).

### `util/` — shared, dependency-light helpers
- `fs.ts` — never-throwing filesystem reads, repo-root detection, safe JSON parse.
- `globs.ts` — the shared gitignore-flavored glob engine used by rules/skills `paths:`,
  `Read/Edit(glob)` permission rules, `claudeMdExcludes`, and `.worktreeinclude`.
- `markdown.ts` — frontmatter/body splitting with **lenient YAML** (malformed frontmatter degrades
  to `frontmatter={}` + a diagnostic, never throws) and HTML-comment stripping.
- `env.ts` — `unicodeSafeSubprocessEnv` / `applyUnicodeSafeProcessEnv`: force UTF-8 for spawned
  interpreters so Windows cp1252 (and `LANG=C`) don't `UnicodeEncodeError` on output like `→`.

## 3. Request / turn data flow

The wiring lives in `src/index.ts`, which registers tools and Pi event handlers:

1. **Extension load.** `applyUnicodeSafeProcessEnv()`, then `loadClaudeProject()` assembles the
   project model. `CwdState`, `PermissionEngine`, `WorktreeManager`, `HookRunner` (wrapped in a
   `HookMultiplexer` so skill-scoped hooks can be added dynamically), and `SubagentRuntime` are
   constructed. All Claude-named tools plus cwd-swapping overrides of Pi's built-ins are registered
   (§4). The guard extension is installed on tool events. Prompt-template stubs are written for each
   user-invocable skill so it appears in the `/` palette (§4).

2. **`session_start`.** Captures the model registry and active model (→ steering text), applies the
   config model/effort, self-heals `core.hooksPath` when `.githooks/` exists, fires the
   `SessionStart` hook (stdout injected as context), and emits the one-per-session compatibility
   notice unless suppressed.

3. **`before_agent_start` (every turn).** Appends the `buildSystemPromptSuffix` output to Pi's
   system prompt. This re-asserts the full instruction set each turn — the primary
   compaction-preservation path.

4. **`input`.** In order: intercept PiCC control commands so they never reach the model; fire
   the `UserPromptSubmit` hook (block or inject context); expand `/skill [args]` slash commands by
   activating the skill(s) and **transforming the user turn** into the rendered bodies (Claude
   Code's slash semantics — up to 5 leading `/skill` tokens stack, the trailing text feeding the
   last skill's arguments; a transform works in every Pi mode, unlike a self-dispatching command).

5. **Tool calls → `guard`.** Each tool call is translated to its Claude name, checked against deny
   rules (hard block), run through PreToolUse hooks (`updatedInput`/`additionalContext`/block), and
   — on file-touching tools — triggers nested-CLAUDE.md and path-scoped rule/skill injection.
   PostToolUse / PostToolUseFailure hooks fire on the result.

6. **Subagent dispatch.** The `Agent`/`Task` tool calls `SubagentRuntime.dispatch`, which spawns a
   fresh Pi session with the gated tool set and returns the final message verbatim (or a loud,
   classified failure — see the *Subagent error contract* in §4). Nested dispatch is depth-capped;
   the same guard runs inside every subagent session. With `run_in_background: true` (or an agent's
   `background: true` frontmatter) the dispatch registers in the `BackgroundTaskRegistry` and
   returns a task id; `TaskOutput`/`TaskStop` manage its lifecycle, and settlement is pushed to the
   coordinator at its next `before_agent_start`. `SendMessage` (parent-only) resumes a finished
   subagent by its agent id or steers a running background one.

7. **`agent_settled` / compaction.** `agent_settled` fires the `Stop` hook (exit 2 re-prompts the
   agent to continue, capped at 8 consecutive blocks). `session_before_compact`/`session_compact`
   fire `PreCompact`/`PostCompact` and re-inject active skill bodies for mid-turn continuity under
   Claude's carryover budgets (~5k tokens per skill / ~25k combined, most-recent-first); the
   system-prompt suffix already preserves the instruction set.

## 4. Mechanical-fidelity decisions (load-bearing)

These are the choices where "close enough" would break real projects. Each maps to a governing
principle in the plan (§2.1 mechanical fidelity).

- **The cwd swap is load-bearing.** A project's own scripts detect worktree vs. main via standard
  git plumbing, which only works if *every* subsequent tool call runs inside the worktree
  directory. Pi has no session-cwd API, so PiCC re-registers the built-in
  `bash/read/write/edit/grep/find/ls` tools as thin wrappers that rebuild the real tool per call
  against `CwdState.get()` (`src/index.ts`, `cwd-state.ts`, design §3.1). Subagents get their cwd
  natively via `createAgentSession({ cwd })`.

- **Verbatim subagent return.** A subagent's final message is returned exactly as produced — no
  summarizing or wrapping — because skills parse it directly, often a locked-YAML verdict block
  (`subagents.ts`, plan §4.3).

- **Subagent error contract (F02 — the failure class this feature closes).** Every dispatch is
  classified into exactly one outcome, and the classification — not a normal-looking success — is
  what reaches the coordinator:
  - **completed** — the run finished; its verbatim final message is returned.
  - **failed** — the run ended on a terminal API error (e.g. a drained usage limit). The tool
    reports a **loud failure naming the cause** (`Agent terminated early due to an API error: …`),
    never an empty or normal-looking success. This is the exact regression that, before F02,
    returned an empty success and let a coordinator commit under-reviewed work.
  - **aborted** — the run was stopped on purpose (Esc/user abort, `TaskStop`). Reported as
    **aborted**, distinct from a failure; a signal wins on every settle path, and a deliberately
    stopped background result is discarded.
  - **Partial-output preservation.** If a failed or turn-capped run produced output before dying,
    that partial text is preserved and delivered inside an explicit cut-off frame
    (`\n\n---\n[subagent cut off] …`) rather than dropped. A turn-cap (`length`) truncation also
    pushes a warning diagnostic — never silent.
  - **Foreground vs background.** The contract holds on both paths: a foreground dispatch throws
    the loud error (Pi renders it in its own error box) while a background dispatch lands a
    `failed`/`stopped` status that `TaskOutput` reports with the same named cause and partial
    output. A background failure is **never** shown as completed. Retry behavior stays exactly
    Pi's own — no extra recovery logic (`subagents.ts`/`background-tasks.ts`, feature.md §1).
    Note the **default direction diverges**: PiCC dispatches to the **foreground** by default,
    whereas Claude Code 2.1.198 runs subagents background-by-default, so an implicit-concurrency
    fan-out runs serially under PiCC unless `run_in_background`/`background: true` is set — the
    single most consequential subagent parity gap of this feature (see `feature.background-agents`).
  - **One presentation for every dispatch (F14).** The `context: fork` path was the last place
    this contract diverged — a fork that died on a terminal error used to drop its partial output
    and crash rather than fail loudly. F14 closed that gap, so the fork path now conforms to the
    contract above. The unification is structural: t01 extracted a shared exported
    `presentDispatchResult` helper (`subagents.ts`) that renders the completed/failed/aborted
    outcome, the named cause, and the partial-output cut-off frame from **one** source of truth,
    and the Agent tool plus **both** fork consumers (the typed top-level-input caller and the
    model-invoked `Skill`/`SlashCommand`-tool caller — one shared `runSkillActivation` path) route
    through it. The Esc caveat is scoped: F14 threads the abort signal to a **model-invoked** fork
    (the `Skill` or `SlashCommand` tool) so it reports aborted, but a **typed top-level
    `/forked-skill`** expansion is not Esc-cancellable — a PiCC/Pi harness limitation (no abort
    signal at the input-hook stage), not Claude Code scoping Esc.

- **Deny matches any command segment.** The permission matcher is shell-operator aware, so a deny
  like `Bash(rm *)` cannot be evaded by chaining (`git status && rm -rf /`) — every segment is
  matched independently (`permissions.ts`, plan §6.1).

- **Skills expand as an input-event transform.** `/name` is handled in the `input` handler by
  rewriting the user turn into the rendered skill body, not by a self-dispatching extension command
  (which cannot reliably trigger a turn in print mode). Visibility in the `/` palette is provided
  separately via `resources_discover` prompt stubs, and a project skill wins over a same-named
  plugin command (`src/index.ts`, plan §4.1/§4.7).

- **Git Bash is pinned on Windows.** `resolveGitBashPath()` (`shell-inject.ts`) finds the real Git
  Bash and **skips the System32 WSL `bash.exe` stub**, which fails with
  `WSL_E_DEFAULT_DISTRO_NOT_FOUND` when no distro is installed. The resolved shell is passed to Pi's
  `createBashTool({ shellPath })` and to `!` user-bash, so both hooks and project `dm-*.sh`-style
  scripts get a working bash (plan §12.3).

- **UTF-8 subprocess env.** Every spawned child inherits a UTF-8 default
  (`PYTHONIOENCODING`/`PYTHONUTF8`, `LANG`/`LC_ALL` when unset), so a Windows cp1252 default code
  page (or `LANG=C`) doesn't crash a tool that prints Unicode. An explicit project/user `env` value
  always wins (`util/env.ts`).

- **Everything degrades, nothing crashes.** Loaders never throw (malformed YAML → `{}` + diagnostic;
  missing files → `undefined`); the hook runner and worktree manager return error results rather
  than throwing; unknown tool/setting/hook/frontmatter names resolve to a synthesized
  `not-supported` entry and are surfaced as *unassessed* (completeness floor + forward
  compatibility, plan §2.2/§2.4).

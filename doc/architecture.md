# PiClauDex architecture

A contributor's map of how PiClauDex runs a Claude Code project on a GPT/Codex model. It is
factual and cites file paths; for *what* and *why* see [`doc/plan/piclaudex-plan.md`](plan/piclaudex-plan.md),
and for the exact Pi API contracts see [`doc/design/pi-integration.md`](design/pi-integration.md).

## 1. Layered design

```
┌─────────────────────────────────────────────────────────────────────┐
│  Pi (base harness, @earendil-works/pi-*)                            │
│  agent loop · model/provider abstraction · ChatGPT/Codex auth ·     │
│  TUI · session persistence · built-in tools (read/write/edit/bash/  │
│  grep/find/ls) · extension event bus                                │
└───────────────▲──────────────────────────────── loads as extension ─┘
                │ default export piclaudex(pi)  (src/index.ts)
┌───────────────┴─────────────────────────────────────────────────────┐
│  PiClauDex (this repo) — one Pi extension bundle                     │
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

PiClauDex is **not a fork** of Pi (design §Q1): Pi is an ordinary npm dependency
(`@earendil-works/pi-coding-agent`, `-agent-core`, `-ai`, all pinned `0.80.x`), and PiClauDex
attaches as a single extension whose entry is `src/index.ts`. Pi supplies everything model- and
UI-related; PiClauDex supplies Claude Code compatibility and never reimplements auth, the provider
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
- `skills.ts` — `.claude/skills/*/SKILL.md` + `.claude/commands/*.md`. Parses **frontmatter only**;
  the body is never stored on the returned object (`body: undefined`) — progressive disclosure is a
  hard NFR (plan §12.1). `loadSkillBody` re-reads on activation. Also renders the budgeted startup
  skill listing.
- `agents.ts` — `.claude/agents/*.md` into `ClaudeAgent` records; renders the description-driven
  routing catalog injected into the orchestrator context.
- `rules.ts` — `.claude/rules/**/*.md`; files without `paths:` load unconditionally, files with
  `paths:` inject on matching-file access (plan §4.2).
- `claude-md.ts` — CLAUDE.md hierarchy: `@import` expansion (recursive, hop-limited, code-span
  aware — also the `@AGENTS.md` bridge), session-start collection, and `findNestedClaudeMd` for
  nearest-ancestor injection on file touch (plan §4.6).
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
  **shell-operator aware** — `git status && rm -rf /` does not match `Bash(git *)`. Never throws.
- `hook-runner.ts` — spawns `type: command` hooks via `node:child_process.spawn`, delivers the
  Claude Code JSON payload on **stdin**, and aggregates the exit-code / stdout-JSON contract
  (exit 2 = block; `permissionDecision`; `additionalContext`; `updatedInput`) into a `HookOutcome`.
  `fire()` never throws.
- `shell-inject.ts` — preprocesses skill bodies: inline `` !`cmd` `` and `` ```! `` fenced blocks are
  replaced with command stdout before the model sees the content, honoring `shell:` (bash default /
  powershell) and `disableSkillShellExecution`. Also hosts `resolveGitBashPath()` (see §4).

### `runtime/` — wiring the parsed model into a live Pi session
- `context-assembly.ts` — builds the system-prompt suffix appended every turn in
  `before_agent_start`: root CLAUDE.md, unconditional rules, budgeted skill listing, agent catalog,
  steering text, and rendered active-skill bodies. Because the system prompt is rebuilt each turn
  and never compacted away, **this is also the primary compaction-preservation mechanism** (plan §9).
- `subagents.ts` — `SubagentRuntime`: spawns a fresh in-memory Pi session per dispatch (agent body
  as system prompt + CLAUDE.md/rules, **not** the parent conversation), fans out under a
  concurrency cap, applies per-agent `tools:`/`model`/`effort`, enforces the depth cap, supports
  `isolation: worktree`, and returns the subagent's final message **verbatim** (skills parse locked
  YAML from it — a hard contract, plan §4.3).
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
- `steering.ts` — loads the project-external `PiClauDexConfig` (`~/.piclaudex/config.json` or the
  gitignored `.claude/.piclaudex/config.json`); provides per-model steering text and the
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

4. **`input`.** In order: intercept PiClauDex control commands so they never reach the model; fire
   the `UserPromptSubmit` hook (block or inject context); expand a `/skill [args]` slash command by
   activating the skill and **transforming the user turn** into the rendered body (Claude Code's
   slash semantics; a transform works in every Pi mode, unlike a self-dispatching command).

5. **Tool calls → `guard`.** Each tool call is translated to its Claude name, checked against deny
   rules (hard block), run through PreToolUse hooks (`updatedInput`/`additionalContext`/block), and
   — on file-touching tools — triggers nested-CLAUDE.md and path-scoped rule/skill injection.
   PostToolUse / PostToolUseFailure hooks fire on the result.

6. **Subagent dispatch.** The `Agent`/`Task` tool calls `SubagentRuntime.dispatch`, which spawns a
   fresh Pi session with the gated tool set and returns the final message verbatim. Nested dispatch
   is depth-capped; the same guard runs inside every subagent session.

7. **`agent_settled` / compaction.** `agent_settled` fires the `Stop` hook (exit 2 re-prompts the
   agent to continue, bounded). `session_before_compact`/`session_compact` fire `PreCompact`/
   `PostCompact` and re-inject active skill bodies for mid-turn continuity; the system-prompt suffix
   already preserves the instruction set.

## 4. Mechanical-fidelity decisions (load-bearing)

These are the choices where "close enough" would break real projects. Each maps to a governing
principle in the plan (§2.1 mechanical fidelity).

- **The cwd swap is load-bearing.** A project's own scripts detect worktree vs. main via standard
  git plumbing, which only works if *every* subsequent tool call runs inside the worktree
  directory. Pi has no session-cwd API, so PiClauDex re-registers the built-in
  `bash/read/write/edit/grep/find/ls` tools as thin wrappers that rebuild the real tool per call
  against `CwdState.get()` (`src/index.ts`, `cwd-state.ts`, design §3.1). Subagents get their cwd
  natively via `createAgentSession({ cwd })`.

- **Verbatim subagent return.** A subagent's final message is returned exactly as produced — no
  summarizing or wrapping — because skills parse it directly, often a locked-YAML verdict block
  (`subagents.ts`, plan §4.3).

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

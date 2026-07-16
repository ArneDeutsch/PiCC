# Supported features

> **Generated file — do not edit by hand.** This matrix is generated from the living capability registry (`src/registry/capability-registry.ts`), the single source of truth for what PiCC supports (plan §17). The same registry drives the runtime `/doctor` report and the startup compatibility notice, so this document cannot drift from actual behavior.
>
> **Claude Code baseline:** `claude-code-2.1.x (mid-2026)`. Every support claim is stated relative to this
> baseline; anything upstream added after it is treated as *unassessed* and degrades safely.
>
> **Regenerate:** `node scripts/gen-capability-matrix.mjs`

## Tier legend

| Tier | Meaning |
|---|---|
| full | Implemented for real; every field the format defines is functional. |
| partial | Works within limits — parsed and matched, but a constraint applies (see the note). |
| degraded-noop | Parsed and reported, then a visible, documented no-op. Never crashes. |
| not-supported | Out of scope; the name still resolves for gating and degrades safely. |
| n/a | Not applicable to this harness. |

A ⚠ marker on an ID means the divergence is **safety-relevant**: something a project intended to restrict now runs freely. These are always surfaced at startup and in `/doctor`, never silent (plan §6.2).

## Tools (36)

Built-in tool names a project can reference in `tools:`, `permissions.*`, or a hook `if:`.

| ID | Tier | Note |
|---|---|---|
| `tool.Bash` | full | real implementation (from Pi) — shell execution, bash + PowerShell aware |
| `tool.Edit` | full | real implementation — exact-string replacement edits |
| `tool.EnterWorktree` | full | creates/re-enters .claude/worktrees/<flat>/ and swaps the session cwd (§4.4) |
| `tool.ExitWorktree` | full | keep\|remove lifecycle with cwd restore, Windows-tolerant removal (§4.4) |
| `tool.Glob` | full | real implementation — file pattern matching |
| `tool.Grep` | full | real implementation — Claude-baseline parameter surface (-n, -A/-B/-C/context, -i, -o, type, glob, multiline, content/files_with_matches/count modes, head_limit/offset) with ripgrep/JS engine parity (§4.8) |
| `tool.MultiEdit` | full | real implementation of the historical Claude Code MultiEdit — NOTE the pinned Claude Code baseline no longer ships MultiEdit — removed in the 2.0 line, confirmed gone by v2.0.8 — so `full` means faithful to the pre-removal contract, a superset of the pinned baseline kept as an older-project compatibility courtesy, NOT 'matches current Claude Code': batched, strictly exact-string edits (no fuzzy fallback, unlike PiCC's Edit) applied sequentially to one running buffer (each edit sees the prior edit's result), atomic (any miss rejects the whole batch, file left untouched), per-edit replace_all with unique-else-error, and an empty old_string on the first edit of a new file creates it (§4.8) |
| `tool.Read` | full | real implementation — file reads with Claude-shaped input |
| `tool.Skill` | full | skill activation by name with argument substitution (§4.1) |
| `tool.TaskCreate` | full | current task-tracking surface (§4.8) |
| `tool.TaskGet` | full | current task-tracking surface (§4.8) |
| `tool.TaskList` | full | current task-tracking surface (§4.8) |
| `tool.TaskUpdate` | full | current task-tracking surface (§4.8) |
| `tool.WebFetch` | full | implemented for real — research skills and permission allowlists depend on it (§4.8) |
| `tool.WebSearch` | full | implemented for real — research skills and permission allowlists depend on it (§4.8) |
| `tool.Write` | full | real implementation — file creation/overwrite |
| `tool.Agent` | partial | subagent dispatch — built-in general-purpose/Explore/Plan + project agents, omitted type defaults to general-purpose; the final message is returned verbatim, EXCEPT a resumable dispatch appends a clearly-delimited in-band identity/resume trailer to the model-visible text (Claude-faithful — Claude Code likewise appends a resume handle to resumable results and none to one-shot Explore/Plan; the human TUI strips it, so a strict exact-token/JSON/YAML consumer must account for it); a terminal API error is a LOUD failure naming the cause (never an empty success), partial output preserved with a cut-off note (2.1.199/2.1.200); every resumable dispatch gets a stable agent id and live progress rendering; dispatch is BACKGROUND-BY-DEFAULT (Claude 2.1.198): an omitted run_in_background returns a task id immediately so an implicit-concurrency fan-out parallelizes, run_in_background:false selects a synchronous inline run, and CLAUDE_CODE_DISABLE_BACKGROUND_TASKS forces every dispatch foreground. An eligible uncollected current task pushes one bounded settlement notice on the idle parent's next turn; polling TaskOutput while running preserves eligibility, but successfully returning its terminal TaskOutput record counts as delivery and suppresses the redundant later notice. PARTIAL residual — PiCC's notice is next-turn; reporter observations anthropics/claude-code#21343 (Claude Code 2.1.20) and anthropics/claude-code#24752 describe late notifications while a conversation is active, but official docs define neither notification consumption nor exact mid-turn/next-turn timing, so reports establish no normative contract, so PiCC suppression is intentional UX hardening, not verified parity. INFERRED: PiCC fires no agent_completed-style Notification for in-session settlement (a conservative under-claim) and the env override takes precedence over background:true frontmatter (see feature.background-agents); a subagent_type:"fork" dispatch inherits the parent conversation instead of starting fresh — see tool.Agent.fork (§4.3) |
| `tool.Agent.fork` | partial | Task/Agent subagent_type:"fork" (F16) — VERIFIED behavior: inherits the parent conversation (full message history) + parent model + parent tools, seeded via SessionManager.forkFrom into a brand-new persisted child transcript; OUTPUT ISOLATION IS KEPT (only the fork's final message returns; its intermediate steps stay out of the parent conversation); MAIN-SESSION dispatch ONLY — a nested (depth ≠ 1) dispatcher visibly degrades to fresh context (never seeds the root conversation into a nested subagent), and every degrade surfaces a specific footer notice, never the generic unknown-type warning; the system prompt is a same-context RECONSTRUCTION from the parent's project rules/skills/memory/steering, NOT byte-identical (PiCC is an extension on a Pi-assembled base prompt), so a fork FORGOES the prompt-cache cost saving a real fork gets; gated by CLAUDE_CODE_FORK_SUBAGENT (=1 forces on / present-but-off like =0 forces an explicit visible degrade / UNSET ⇒ ENABLED — a deliberate PiCC parity choice over Claude's under-specified staged-rollout default, a DIRECTIONAL divergence: PiCC may inherit where a staged-rollout Claude with fork unset would run fresh); the inherited parent model is overridden by an operator CLAUDE_CODE_SUBAGENT_MODEL env AND by a per-call `model` argument on the fork dispatch (both disclosed so the "same model as parent" claim stays truthful); NON-RESUMABLE (the inherited context is the parent conversation at fork time and cannot be safely re-derived — SendMessage refuses it). PiCC-DEFINED / INFERRED limits: a fork CANNOT SPAWN ANOTHER FORK — a nested fork request is a visible refusal (INFERRED mechanism — enforced via a runtime-set dispatcher marker, not a tool parameter); print/headless/no-session forks degrade (no parent transcript to fork from); fork-mode's run_in_background removal is NOT adopted — PiCC keeps run_in_background:false as a synchronous selector and relies on F15 background-by-default for the "all background" half; isolation:"worktree" on a fork is NOT honored (the fork shares the parent cwd); the Claude version gate (v2.1.117+) is not mirrored; a `name` does not affect inheritance and PiCC does NOT reproduce Claude's interactive named-fork zero-context regression (anthropics/claude-code#76019). Tier PARTIAL: the prompt reconstruction plus these deferrals. See research §2.9 (§4.3) |
| `tool.NotebookRead` | partial | real implementation — parses the .ipynb JSON and presents each cell's source + outputs (stream text, text/plain and other text reprs, error traceback); PARTIAL: image/binary outputs are noted by mime-type (raster images with an approximate base64 size), not rendered visually; oversized text outputs are head-truncated; single-cell selection (cell_id) is not supported (§4.8) |
| `tool.SendMessage` | partial | resumes a completed/failed-with-partial subagent by agent id in the background with prior context, or steers a running background one (Claude 2.1.x); resumed failed/completed agents return to running (2.1.205), create a new task generation, and supersede older generations for settlement delivery (newest generation wins). An eligible uncollected current resumed task receives the same conditional next-turn notice; terminal TaskOutput collection suppresses it and running polls do not. GAPS: PiCC allows resume after TaskStop, while the Claude Code 2.1.x reference refuses stopped-agent resume; no cross-restart resume; steering is background-only; idle-parent settlement delivery is next-turn; fork dispatches are non-resumable (see tool.Agent.fork), and agentOverride and subagent-to-subagent/agent-teams messaging are unsupported. The resume acknowledgment includes the new task id, resolved registry name, and stable agent id in PiCC-defined model-visible wording, not verified as exact Claude wording (§4.3, §7) |
| `tool.SlashCommand` | partial | thin alias over the skill-activation path (mirrors the Skill tool): parses a leading /name (incl. plugin-namespaced /plugin:name) + trailing args from the command string and activates the resolved skill; an unknown or model-blocked command throws a model-visible error like the Skill tool. PARTIAL: covers all user-defined skills/commands but NOT the built-in commands Claude 2.1.x can also invoke via the Skill/SlashCommand skill-activation path (/init, /review, /security-review) — PiCC ships no such built-ins; other built-ins (/clear, /compact, ...) are non-model-invocable in Claude too (§4.1, §4.8) |
| `tool.Task` | partial | alias of the Agent subagent-dispatch tool — same loud-failure/agent-id/progress semantics and background-by-default routing (Claude 2.1.198); its next-turn settlement notice is conditional on an eligible current task remaining uncollected (running polls preserve it; terminal TaskOutput collection suppresses it). Reporter-observed Claude Code 2.1.x may instead enqueue a redundant post-retrieval notification, so this is PiCC UX hardening rather than verified parity; subagent_type:"fork" inherits the parent conversation — see tool.Agent.fork (§4.3) |
| `tool.TaskOutput` | partial | retrieves background subagent results (wait or poll) from the background-task registry, reusing the shared subagent renderer (F04): while awaiting a still-running task it streams a live view like a foreground subagent — a self-identifying header (Task(task-N) · Agent(<type>) with a muted agent-<id> subline), a rolling activity tail, and a current-activity line — then resolves the same call to an outcome badge (completed/failed/aborted) + transcript path + per-subagent usage footer; a poll (wait:false) shows current status + last activity and preserves settlement-notice eligibility; successfully returning any terminal record counts as delivery and suppresses a redundant not-yet-sent notice, including a cut-off result (all output available for that run was delivered). Retrieval remains available after a notice and does not re-arm it. This PiCC-defined collection-aware lifecycle is intentional UX hardening: reporter-observed Claude Code 2.1.x can enqueue a redundant notification after retrieval, while public docs do not specify notification-consumption semantics and available reports establish no exact normative background-subagent contract; it is NOT claimed as verified parity. PRE-EXISTING SCHEMA GAP (separate from F21): reporter evidence anthropics/claude-code#21343 shows Claude Code 2.1.20 TaskOutput using block:true, and anthropics/claude-code#76335 shows 2.1.206 local_agent using block:true with timeout, while PiCC exposes wait; official tools docs list TaskOutput and its deprecation but publish no parameter schema. This gap makes the tier partial. The agent-<id> identity is shown at EVERY surface INCLUDING non-resumable one-shot builtins, with no false 'resumable via SendMessage' invite; the render is display-only — completed model-facing verbatim result text is byte-identical; a failed task reports failed status naming the API error plus any partial output (never an empty success), with identity/usage outside the verbatim body; a stopped terminal record reports the outcome but cannot recover deliberately discarded output. Subagents INHERIT TaskOutput (the 'hidden from subagents' behavior is filed Claude bug #15098/#23154, not its contract), but a subagent reaches only tasks it dispatched (F13); the coordinator reaches every session task; foreign/unknown task_id is refused cleanly without leaking existence or data. HONEST HARDENING: this per-dispatcher guard is stricter than Claude only on the #15098 coordinator-passed-id edge, NOT a blanket 'non-divergent' claim (§4.3, §4.8) |
| `tool.TaskStop` | partial | stops a background subagent; PARTIAL: PiCC accepts only task_id, while Claude 2.1.198+ also accepts agent id/name. Stop is cooperative; the stopped status and discarded late result are PiCC-defined because Claude's post-stop result semantics are undocumented. Every result includes the task record's stored display type and stable agent id in PiCC-defined model-visible wording, not verified as exact Claude wording. Subagents INHERIT TaskStop (per Claude's sub-agents 'Available tools' list), but a subagent's TaskStop reaches only tasks it dispatched (F13); the coordinator can stop any session task; a foreign or unknown task_id is refused cleanly and non-leakingly. This is the identical per-dispatcher guard as tool.TaskOutput — a faithful hardening of Claude's fresh-context isolation, stricter than Claude only on the #15098 coordinator-passed-id edge, NOT a blanket 'non-divergent' claim (see tool.TaskOutput) (§4.3, §4.8) |
| `tool.TodoWrite` | partial | deprecated todo tool — mapped onto the Task* equivalents, not a native implementation (§4.8) |
| `tool.Artifact` | degraded-noop | callable no-op stub — Artifacts out of scope; the notice directs output to a regular file (§7) |
| `tool.AskUserQuestion` | degraded-noop | callable no-op stub — deliberately not provided; the notice redirects questions to plain chat (§7) |
| `tool.BashOutput` | degraded-noop | callable no-op stub — background shells not implemented; commands run in the foreground (§4.8) |
| `tool.computer` | degraded-noop | callable no-op stub — computer use out of scope (§7) |
| `tool.EnterPlanMode` | degraded-noop | callable no-op stub — plan mode is a no-op; planning guidance is treated as ordinary instructions (§7) |
| `tool.ExitPlanMode` | degraded-noop | callable no-op stub — plan mode is a no-op; 'use plan mode' instructions are treated as guidance (§7) |
| `tool.KillBash` | degraded-noop | callable no-op stub — background shells not implemented; there is no shell to kill (§4.8) |
| `tool.KillShell` | degraded-noop | callable no-op stub — background shells not implemented; there is no shell to kill (§4.8) |
| `tool.LSP` | degraded-noop | callable no-op stub — LSP tooling out of scope; the notice directs Grep/Read navigation (§7) |
| `tool.mcp__*` | degraded-noop | MCP deferred — mcp__* names gate/match predictably, calls degrade with a notice (§7) |
| `tool.NotebookEdit` | degraded-noop | callable no-op stub — notebook editing not implemented; the notice directs editing the .ipynb as JSON via Read/Edit (§4.8, §7) |

## Hook events (18)

Lifecycle events the hooks engine can fire (`settings.json` `hooks`, plus skill/agent-scoped hooks).

| ID | Tier | Note |
|---|---|---|
| `hook.event.PostCompact` | full | fires after compaction; wired to re-injection (§9) |
| `hook.event.PostToolUse` | full | fires after successful tool calls; matcher + if: conditions honored; exit-2 block feedback is fed back to the model (§4.5) |
| `hook.event.PostToolUseFailure` | full | fires after failed tool calls (§4.5) |
| `hook.event.PreCompact` | full | fires before compaction; matcher matches the trigger exactly (manual\|auto); wired to instruction preservation (§9) |
| `hook.event.PreToolUse` | full | fires before each tool call; Claude matcher semantics (exact/list/unanchored-regex) + full stdin/stdout contract incl. deny + updatedInput (§4.5) |
| `hook.event.SessionEnd` | full | fires at session end (§4.5) |
| `hook.event.SessionStart` | full | fires at session start; matcher matches the source exactly (startup\|resume\|clear\|compact); stdout injected (§4.5, §9) |
| `hook.event.Stop` | full | fires when the main agent wants to stop; exit 2 blocks stopping (§4.5) |
| `hook.event.SubagentStart` | full | fires when a subagent is spawned; payload carries agent_id + agent_type (subagent-only additions) while transcript_path stays the MAIN session transcript (Claude Code parity); NUANCE: agent_type is the agent's bare frontmatter/definition name — PiCC does NOT apply plugin-scoped naming, so a plugin subagent's agent_type is its plain name (Claude's exact plugin-scoped id here is unverified); a blocking outcome cancels the dispatch (§4.3, §4.5) |
| `hook.event.SubagentStop` | full | fires when a subagent wants to stop; payload carries agent_id + agent_type while transcript_path stays the MAIN session transcript (Claude Code parity); NUANCE: agent_type is the agent's bare frontmatter/definition name, not a plugin-scoped id (Claude's exact plugin-scoped id here is unverified); exit 2 blocks and re-prompts the subagent (bounded) (§4.3, §4.5) |
| `hook.event.UserPromptSubmit` | full | fires on user prompt; stdout injected as context (§4.5) |
| `hook.event.WorktreeCreate` | full | fires on worktree creation — worktree seeding pattern supported (§4.4) |
| `hook.event.WorktreeRemove` | full | fires on worktree removal (§4.4) |
| `hook.event.mcp__elicitation` | degraded-noop | MCP elicitation hook events — MCP deferred, parsed and never fired (§7) |
| `hook.event.Notification` | degraded-noop | UI-notification event — parsed, never fired (no equivalent harness surface); background-subagent settlement does NOT fire an agent_completed Notification. An eligible uncollected current task is instead reported by PiCC's conditional next-turn settlement message (terminal TaskOutput collection suppresses that message). SubagentStop fires independently as part of settlement, not alongside or synchronously with that conditional notice |
| `hook.event.PermissionRequest` ⚠ | degraded-noop | tied to interactive permission machinery — never fired under the default-permissive posture (§6.1) |
| `hook.event.TaskCompleted` | degraded-noop | task-list event — parsed, never fired in v1 |
| `hook.event.TeammateIdle` | degraded-noop | agent-teams event — teams out of scope, parsed and never fired (§7) |

## Settings (35)

`settings.json` / `settings.local.json` keys.

| ID | Tier | Note |
|---|---|---|
| `setting.autoMemoryDirectory` | full | overrides the auto-memory storage directory (~ and env expanded) (§4.6) |
| `setting.autoMemoryEnabled` | full | gates auto-memory loading (default true; CLAUDE_CODE_DISABLE_AUTO_MEMORY also honored) (§4.6) |
| `setting.claudeMd` | full | managed-scope inline CLAUDE.md content injected at highest priority; ignored with a diagnostic in other scopes (§4.6) |
| `setting.claudeMdExcludes` | full | excludes CLAUDE.md/rules files from loading (§4.2, §4.6) |
| `setting.disableAllHooks` | full | disables all hook dispatch (§4.5) |
| `setting.disableSkillShellExecution` | full | disables !`cmd` skill shell injection (§4.1) |
| `setting.enabledPlugins` | full | selects installed-plugin content to load; merges key-wise across scopes, nearer scope wins per plugin (§4.9) |
| `setting.env` | full | injected into sessions and hook/skill subprocesses (§5) |
| `setting.hooks` | full | hook config dispatched per §4.5 — Claude matcher semantics (exact/list/unanchored-regex), parallel execution with dedup, async handlers, systemMessage/suppressOutput honored (command handlers full) |
| `setting.permissions.deny` | full | hard, non-interactive block — the kept deterministic safety valve; a Read(<glob>) deny also gates Grep/Glob/NotebookRead on a matching path, one-directionally (§6.1) |
| `setting.skillListingBudgetFraction` | full | caps the startup skill-listing token budget (§4.1, §12.1) |
| `setting.skillListingMaxDescChars` | full | caps per-skill description length in the startup listing (default 1536, Claude parity; tiered degradation, never omits a skill) (§4.1) |
| `setting.skillOverrides` | full | per-skill overrides applied at load: off / user-invocable-only / name-only (§5) |
| `setting.subagentConcurrency` | full | caps parallel subagent fan-out (§4.3, §12.2) |
| `setting.subagentMaxDepth` | full | caps nested subagent recursion depth (default 5, Claude parity) (§4.3) |
| `setting.subagentsEnabled` | full | gates subagent dispatch (§4.3) |
| `setting.worktree.baseRef` | full | head\|fresh base resolved to a concrete commit before worktree creation (§4.4) |
| `setting.cleanupPeriodDays` | partial | max-age (days) for orphaned-WORKTREE reaping at startup; subagent transcript dirs (<base>.subagents/) are NOT reaped — worktrees-only cleanup (t02 shipped no transcript reaper), same accumulation class as Pi's own session files (§4.4) |
| `setting.memory` | partial | auto memory: MEMORY.md (first 200 lines / 25 KB) loads at session start with full parity; autoMemoryEnabled/autoMemoryDirectory + CLAUDE_CODE_DISABLE_AUTO_MEMORY honored. PARTIAL: injected write guidance is conservative by default — the model writes/updates memory only on an explicit user request to remember, whereas Claude Code also writes proactively; opt into eager writes via CLAUDE.md (§4.6) |
| `setting.permissions.allow` | partial | parsed and matched, but moot under the default-permissive posture — nothing waits on an allow (§6.1) |
| `setting.apiKeyHelper` | degraded-noop | parsed, never invoked — auth comes from the harness subscription/provider flow; reported when set (§5, §7) |
| `setting.attribution` | degraded-noop | parsed, not consumed — no commit/PR attribution machinery; reported when set (§5, §7) |
| `setting.checkpointing` | degraded-noop | checkpointing/rewind deferred — Pi's session model instead (§7) |
| `setting.disabledMcpjsonServers` | degraded-noop | MCP deferred — parsed, no servers started (§7) |
| `setting.enableAllProjectMcpServers` | degraded-noop | MCP deferred — parsed, no servers started (§7) |
| `setting.enabledMcpjsonServers` | degraded-noop | MCP deferred — parsed, no servers started (§7) |
| `setting.includeCoAuthoredBy` | degraded-noop | parsed, not consumed — PiCC has no commit-attribution machinery either way; reported when set (§5, §7) |
| `setting.mcpServers` | degraded-noop | MCP deferred — parsed, no servers started (§7) |
| `setting.model` | degraded-noop | parsed, not consumed — session model selection uses PiCC config (model/effort), not Claude model names; reported when set (§5, §10) |
| `setting.outputStyle` | degraded-noop | cosmetic output styles not honored beyond Pi defaults (§7) |
| `setting.permissions.additionalDirectories` | degraded-noop | parsed, no-op — the default-permissive posture applies no directory sandbox, so extra grants are moot; reported when set (§6.1) |
| `setting.permissions.ask` ⚠ | degraded-noop | ask rules will NOT prompt — default-permissive posture runs them without asking (§6.1) |
| `setting.permissions.defaultMode` ⚠ | degraded-noop | permission modes/auto-mode are a no-op — sessions run default-permissive regardless (§6.1) |
| `setting.planMode` | degraded-noop | plan mode is a no-op — treated as guidance (§7) |
| `setting.statusLine` | degraded-noop | cosmetic statusline not honored beyond Pi defaults (§7) |

## Frontmatter fields (35)

Skill (`SKILL.md`), agent (`.claude/agents/*.md`), and rule frontmatter keys.

| ID | Tier | Note |
|---|---|---|
| `agent.frontmatter.background` | full | background: true forces background dispatch even against an explicit run_in_background:false (its remaining significance now that dispatch is background-by-default); routed through the same background-task lifecycle and forced to foreground under CLAUDE_CODE_DISABLE_BACKGROUND_TASKS (§4.3) |
| `agent.frontmatter.description` | full | auto-injected routing surface for description-driven selection (§4.3) |
| `agent.frontmatter.disallowedTools` | full | tool denylist enforced for the subagent (§4.3) |
| `agent.frontmatter.effort` | full | per-agent effort override honored (§4.3, §10) |
| `agent.frontmatter.hooks` | full | scoped hook runner active for the subagent's dispatch; Stop maps to SubagentStop (§4.3, §4.5) |
| `agent.frontmatter.initialPrompt` | full | injected as the subagent's first user message (§4.3) |
| `agent.frontmatter.isolation` | full | isolation: worktree pins the subagent to its own worktree (§4.3, §4.4) |
| `agent.frontmatter.metadata` | full | metadata.* preserved and exposed (§4.3) |
| `agent.frontmatter.model` | full | per-agent model override honored (§4.3) |
| `agent.frontmatter.name` | full | agent identity for subagent_type dispatch (§4.3) |
| `agent.frontmatter.skills` | full | listed skills preloaded into the agent's context (§4.3) |
| `agent.frontmatter.tools` | full | capability gating fully honored — the primary deterministic security control (§4.3, §6.1) |
| `rule.frontmatter.paths` | full | path-scoped rule injection on matching file access (§4.2) |
| `skill.frontmatter.agent` | full | names the agent context used with context: fork (§4.1) |
| `skill.frontmatter.argument-hint` | full | shown for slash-command argument entry (§4.1) |
| `skill.frontmatter.arguments` | full | named argument specs with required/default handling (§4.1) |
| `skill.frontmatter.context` | full | context: fork runs the skill as a fresh-context subagent; a fork that fails on a terminal error is a LOUD failure naming the cause with partial output preserved (parity with the Agent tool, 2.1.199); Esc cancels an in-flight fork and reports it aborted — a model-invoked fork (Skill/SlashCommand tool) via Pi's per-call signal, and a typed top-level /forked-skill in interactive mode via the input hook watching raw terminal input for Esc (print/RPC modes have no Esc); fork dispatches are non-resumable (§4.1) |
| `skill.frontmatter.description` | full | enters the startup listing; drives model invocation (§4.1) |
| `skill.frontmatter.disable-model-invocation` | full | hides the skill from model-invocation listing (§4.1) |
| `skill.frontmatter.disallowed-tools` | full | denylist enforced — resident-skill denials feed the session deny guard; context:fork dispatch receives them as subagent gating (§4.1, §6.1) |
| `skill.frontmatter.hooks` | full | skill-scoped hook config dispatched while the skill is active (§4.1, §4.5) |
| `skill.frontmatter.metadata` | full | metadata.* preserved and exposed (§4.1) |
| `skill.frontmatter.name` | full | skill identity; nearest-scope wins on clashes (§3, §4.1) |
| `skill.frontmatter.paths` | full | path-scoped skills are surfaced (once) when a matching file is accessed; activation stays explicit via the Skill tool (§4.1, §4.2) |
| `skill.frontmatter.shell` | full | bash (default) \| powershell for !`cmd` injection (§4.1, §12.3) |
| `skill.frontmatter.user-invocable` | full | true (default) creates the slash command (§4.1) |
| `skill.frontmatter.when_to_use` | full | appended to the routing/listing surface (§4.1) |
| `agent.frontmatter.maxTurns` | partial | best-effort cap — tool calls past the cap are blocked with an instruction to answer; the model still produces its final message (§4.3) |
| `agent.frontmatter.memory` | partial | user\|project\|local scopes resolve to Claude's agent-memory dirs; MEMORY.md (200 lines / 25 KB) loads with full parity. PARTIAL: injected write guidance is conservative by default — the subagent writes/updates memory only on an explicit user request to remember, whereas Claude Code also writes proactively; opt into eager writes via CLAUDE.md (§4.3, §4.6) |
| `skill.frontmatter.allowed-tools` ⚠ | partial | gates tools for context:fork dispatch; trivially satisfied for in-session activation under the default-permissive posture (§4.1, §6.1) |
| `skill.frontmatter.effort` | partial | honored for context:fork dispatch and ${CLAUDE_EFFORT} substitution; does not change the parent session's reasoning effort (§4.1, §10) |
| `skill.frontmatter.model` | partial | honored for context:fork dispatch; in-session activation cannot switch the parent session's model (§4.1, §10) |
| `agent.frontmatter.color` | degraded-noop | parsed only — cosmetic; Pi's TUI does not render agent colors (§4.3, §11) |
| `agent.frontmatter.mcpServers` | degraded-noop | parsed; MCP deferred — no servers started for the agent (§7) |
| `agent.frontmatter.permissionMode` ⚠ | degraded-noop | parsed, no-op — subagents run the default-permissive posture regardless; deny rules + tools: gating remain the controls; reported when set (§6.1) |

## Runtime features (27)

Cross-cutting runtime subsystems and behaviors.

| ID | Tier | Note |
|---|---|---|
| `feature.claude-md-import` | full | @import expansion, recursive up to 4 hops, incl. the AGENTS.md bridge (§4.6) |
| `feature.compaction-preservation` | full | root CLAUDE.md + active skills (Claude-parity 20k/100k char budgets, most-recent-first) + unconditional rules survive compaction (§9) |
| `feature.nested-claude-md` | full | full ancestor-chain CLAUDE.md/CLAUDE.local.md load (to filesystem root) + nearest-ancestor injection on subdir file access, incl. worktrees (§4.6) |
| `feature.plugins-content` | full | installed-plugin skills/agents/hooks/commands folded into the registries (§4.9) |
| `feature.rules` | full | .claude/rules/ unconditional load + path-scoped injection at project and user scope (§4.2) |
| `feature.worktrees` | full | EnterWorktree/ExitWorktree lifecycle incl. .worktreeinclude, parallel sessions, Windows tolerance (§4.4) |
| `feature.agent-memory` | partial | auto memory (project MEMORY.md) + per-agent memory scopes load and inject with full parity. PARTIAL: injected write guidance is conservative by default — the model writes/updates memory only on an explicit user request to remember, whereas Claude Code also writes proactively; opt into eager writes via CLAUDE.md (§4.6) |
| `feature.background-agents` | partial | background-by-default dispatch (Claude 2.1.198), TaskOutput/TaskStop, loud failures, and live progress while TaskOutput awaits. An eligible uncollected current task receives one bounded settlement notice on the coordinator's NEXT turn; a running TaskOutput poll preserves eligibility, while a successful terminal return counts as delivery and suppresses a redundant not-yet-sent notice. Explicit retrieval remains available after notification without re-arming it; stopped notices are outcome-only because final output is deliberately discarded; resume uses a new task generation and newest-generation-wins supersession. This collection-aware suppression is intentional PiCC UX hardening, NOT verified parity: reporter-observed Claude Code 2.1.x can enqueue a redundant post-retrieval notification, public docs specify no notification-consumption semantics, and reports establish no exact normative contract. Subagent TaskOutput/TaskStop are scoped to the subagent's own dispatched tasks while the coordinator retains full session-wide reach (F13; see tool.TaskOutput for #15098). GAPS: PiCC notice timing is next-turn, while reporter observations (anthropics/claude-code#21343, Claude Code 2.1.20 background agents, and anthropics/claude-code#24752) describe late notification during an active conversation without establishing exact normative timing; idle parents are not re-invoked; one-shot print mode can finish before eligible uncollected work is surfaced; TaskStop accepts only task_id (Claude 2.1.198+ also accepts agent id/name); PiCC allows SendMessage resume after TaskStop while the Claude Code 2.1.x reference refuses it; no always-on Agent View; no remote/cloud agents; stop is cooperative. Nested (depth ≥ 2) fan-out uses per-depth budgets (total ≤ maxDepth × concurrency, deadlock-free), deliberately diverging from Claude's single global (~10) parallel-agent cap. Lifecycle identity uses the task record's stored display type and stable agent id; resume uses a new task id and resolved registry name. Wording is model-visible and PiCC-defined, not verified as exact Claude wording. A subagent_type:"fork" dispatch inherits the parent conversation (main-session only) and is non-resumable — see tool.Agent.fork (§4.3) |
| `feature.collaborative-planning` | partial | always-on, every-turn nudge in the conventions block (rebuilt each turn, survives compaction): steers a collaborative planning/exploration posture — ground yourself by reading the repo, resolve discoverable facts instead of asking, ask only about goals/preferences/material tradeoffs, surface alternatives and recommend one, and don't collapse a substantial planning phase into a restatement-then-"go"/"confirm"; preserves decisive autonomous implementation after convergence and a skill's explicit approval gates. PARTIAL: guidance only, outcome model-dependent (a prompt nudge, not a deterministic conversation shape), NOT a mode or state machine and NOT gated on plan mode — this is a planning posture, not plan mode; the plan-mode tool surface stays degraded-noop (see feature.plan-mode) |
| `feature.commit-message-guidance` | partial | always-on, every-turn nudge in the conventions block (rebuilt each turn, survives compaction): when asked to commit, first read the changes (git status/diff) and recent git log, match this repo's commit-message style where it is richer, and — for a non-trivial change — write a short why-over-what body; the --no-verify prohibition is preserved. PARTIAL: guidance only, outcome model-dependent (a prompt nudge, not a deterministic output shape); NOT full Claude Code commit parity — omits the HEREDOC commit form, the attribution trailer, and parallel git status/diff/log batching; commit attribution is unchanged — still no attribution trailer either way (see setting.includeCoAuthoredBy) |
| `feature.hook-handler.http` | partial | http hook handlers dispatched best-effort (§4.5) |
| `feature.managed-policy` | partial | managed/enterprise policy honored where trivially present; otherwise degrade-safe (§7) |
| `feature.hook-handler.agent` | degraded-noop | agent hook handlers degrade with a notice (§4.5) |
| `feature.hook-handler.mcp_tool` | degraded-noop | mcp_tool hook handlers degrade with a notice — MCP deferred (§4.5, §7) |
| `feature.hook-handler.prompt` | degraded-noop | prompt hook handlers degrade with a notice (§4.5) |
| `feature.mcp` | degraded-noop | MCP subsystem deferred — committed .mcp.json parsed without crashing, no servers started (§7) |
| `feature.plan-mode` | degraded-noop | plan mode treated as guidance; no mode switch, no ExitPlanMode gate (§7) |
| `feature.telemetry-otel` | degraded-noop | telemetry/OTEL settings parsed, nothing exported (§7) |
| `feature.agent-teams` | not-supported | agent teams out of scope; names degrade safely (§7) |
| `feature.artifacts` | not-supported | Artifacts out of scope; names degrade safely (§7) |
| `feature.checkpointing-rewind` | not-supported | no rewind parity — relies on Pi's session model (§7) |
| `feature.computer-use` | not-supported | computer use out of scope; names degrade safely (§7) |
| `feature.cron` | not-supported | scheduled tasks out of scope; names degrade safely (§7) |
| `feature.lsp` | not-supported | LSP integration out of scope; names degrade safely (§7) |
| `feature.plugin-install` | not-supported | plugin installation machinery out of scope — install plugins via Claude Code (§4.9) |
| `feature.plugin-marketplace` | not-supported | marketplace add/registration/release channels out of scope (§4.9) |
| `feature.remote-control` | not-supported | remote control out of scope; names degrade safely (§7) |

## Summary

The registry enumerates **151 capabilities** against baseline `claude-code-2.1.x (mid-2026)`: **79 full**, **23 partial**, **40 degraded-noop**, **9 not-supported**. 5 entries are safety-relevant (marked ⚠) — a divergence where a project's restriction is not enforced and is therefore reported prominently. Unknown inputs outside this registry are not counted here: they are unassessed by definition and degrade safely at runtime (plan §2.4).

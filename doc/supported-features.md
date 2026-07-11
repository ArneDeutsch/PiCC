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

## Tools (25)

Built-in tool names a project can reference in `tools:`, `permissions.*`, or a hook `if:`.

| ID | Tier | Note |
|---|---|---|
| `tool.Agent` | full | subagent dispatch — fresh-context spawn by subagent_type, verbatim final message (§4.3) |
| `tool.Bash` | full | real implementation (from Pi) — shell execution, bash + PowerShell aware |
| `tool.Edit` | full | real implementation — exact-string replacement edits |
| `tool.EnterWorktree` | full | creates/re-enters .claude/worktrees/<flat>/ and swaps the session cwd (§4.4) |
| `tool.ExitWorktree` | full | keep\|remove lifecycle with cwd restore, Windows-tolerant removal (§4.4) |
| `tool.Glob` | full | real implementation — file pattern matching |
| `tool.Grep` | full | real implementation — content search |
| `tool.Read` | full | real implementation — file reads with Claude-shaped input |
| `tool.Skill` | full | skill activation by name with argument substitution (§4.1) |
| `tool.Task` | full | alias of the Agent subagent-dispatch tool (§4.3) |
| `tool.TaskCreate` | full | current task-tracking surface (§4.8) |
| `tool.TaskGet` | full | current task-tracking surface (§4.8) |
| `tool.TaskList` | full | current task-tracking surface (§4.8) |
| `tool.TaskUpdate` | full | current task-tracking surface (§4.8) |
| `tool.WebFetch` | full | implemented for real — research skills and permission allowlists depend on it (§4.8) |
| `tool.WebSearch` | full | implemented for real — research skills and permission allowlists depend on it (§4.8) |
| `tool.Write` | full | real implementation — file creation/overwrite |
| `tool.TodoWrite` | partial | deprecated todo tool — mapped onto the Task* equivalents, not a native implementation (§4.8) |
| `tool.Artifact` | degraded-noop | Artifacts out of scope — name resolves for gating, degrades with a notice (§7) |
| `tool.AskUserQuestion` | degraded-noop | not provided — explicitly unwanted; human interaction happens in plain chat (§7) |
| `tool.computer-use` | degraded-noop | computer use out of scope — name resolves for gating, degrades with a notice (§7) |
| `tool.ExitPlanMode` | degraded-noop | plan mode is a no-op — 'use plan mode' instructions are treated as guidance (§7) |
| `tool.LSP` | degraded-noop | LSP tooling out of scope — name resolves for gating, degrades with a notice (§7) |
| `tool.mcp__*` | degraded-noop | MCP deferred — mcp__* names gate/match predictably, calls degrade with a notice (§7) |
| `tool.NotebookEdit` | degraded-noop | not implemented — name resolves for gating and degrades with a notice (§4.8) |

## Hook events (18)

Lifecycle events the hooks engine can fire (`settings.json` `hooks`, plus skill/agent-scoped hooks).

| ID | Tier | Note |
|---|---|---|
| `hook.event.PostCompact` | full | fires after compaction; wired to re-injection (§9) |
| `hook.event.PostToolUse` | full | fires after successful tool calls; matcher + if: conditions honored (§4.5) |
| `hook.event.PostToolUseFailure` | full | fires after failed tool calls (§4.5) |
| `hook.event.PreCompact` | full | fires before compaction; wired to instruction preservation (§9) |
| `hook.event.PreToolUse` | full | fires before each tool call; full stdin/stdout contract incl. deny + updatedInput (§4.5) |
| `hook.event.SessionEnd` | full | fires at session end (§4.5) |
| `hook.event.SessionStart` | full | fires at session start incl. source=compact re-entry; stdout injected (§4.5, §9) |
| `hook.event.Stop` | full | fires when the main agent wants to stop; exit 2 blocks stopping (§4.5) |
| `hook.event.SubagentStart` | full | fires when a subagent is spawned (§4.5) |
| `hook.event.SubagentStop` | full | fires when a subagent wants to stop; exit 2 blocks (§4.5) |
| `hook.event.UserPromptSubmit` | full | fires on user prompt; stdout injected as context (§4.5) |
| `hook.event.WorktreeCreate` | full | fires on worktree creation — worktree seeding pattern supported (§4.4) |
| `hook.event.WorktreeRemove` | full | fires on worktree removal (§4.4) |
| `hook.event.mcp__elicitation` | degraded-noop | MCP elicitation hook events — MCP deferred, parsed and never fired (§7) |
| `hook.event.Notification` | degraded-noop | UI-notification event — parsed, never fired (no equivalent harness surface) |
| `hook.event.PermissionRequest` ⚠ | degraded-noop | tied to interactive permission machinery — never fired under the default-permissive posture (§6.1) |
| `hook.event.TaskCompleted` | degraded-noop | task-list event — parsed, never fired in v1 |
| `hook.event.TeammateIdle` | degraded-noop | agent-teams event — teams out of scope, parsed and never fired (§7) |

## Settings (32)

`settings.json` / `settings.local.json` keys.

| ID | Tier | Note |
|---|---|---|
| `setting.apiKeyHelper` | full | honored for auth resolution (§5) |
| `setting.attribution` | full | honored in git commit/PR attribution (§5) |
| `setting.claudeMdExcludes` | full | excludes CLAUDE.md/rules files from loading (§4.2, §4.6) |
| `setting.cleanupPeriodDays` | full | honored for worktree/orphan reaping cadence (§4.4) |
| `setting.disableAllHooks` | full | disables all hook dispatch (§4.5) |
| `setting.disableSkillShellExecution` | full | disables !`cmd` skill shell injection (§4.1) |
| `setting.enabledPlugins` | full | selects installed-plugin content to load (§4.9) |
| `setting.env` | full | injected into sessions and hook/skill subprocesses (§5) |
| `setting.hooks` | full | hook config dispatched per §4.5 (command handlers full) |
| `setting.includeCoAuthoredBy` | full | honored in git commit attribution (§5) |
| `setting.model` | full | honored as the default model-selection input (§5, §10) |
| `setting.permissions.additionalDirectories` | full | extra directories permitted for file access (§5) |
| `setting.permissions.deny` | full | hard, non-interactive block — the kept deterministic safety valve (§6.1) |
| `setting.skillListingBudgetFraction` | full | caps the startup skill-listing token budget (§4.1, §12.1) |
| `setting.skillListingMaxDescChars` | full | caps per-skill description length in the startup listing (§4.1) |
| `setting.skillOverrides` | full | per-skill overrides applied at load (§5) |
| `setting.subagentConcurrency` | full | caps parallel subagent fan-out (§4.3, §12.2) |
| `setting.subagentMaxDepth` | full | caps nested subagent recursion depth (§4.3) |
| `setting.subagentsEnabled` | full | gates subagent dispatch (§4.3) |
| `setting.worktree.baseRef` | full | head\|fresh base resolved to a concrete commit before worktree creation (§4.4) |
| `setting.permissions.allow` | partial | parsed and matched, but moot under the default-permissive posture — nothing waits on an allow (§6.1) |
| `setting.checkpointing` | degraded-noop | checkpointing/rewind deferred — Pi's session model instead (§7) |
| `setting.disabledMcpjsonServers` | degraded-noop | MCP deferred — parsed, no servers started (§7) |
| `setting.enableAllProjectMcpServers` | degraded-noop | MCP deferred — parsed, no servers started (§7) |
| `setting.enabledMcpjsonServers` | degraded-noop | MCP deferred — parsed, no servers started (§7) |
| `setting.mcpServers` | degraded-noop | MCP deferred — parsed, no servers started (§7) |
| `setting.memory` | degraded-noop | auto-memory deferred — parsed, no-op storage (§7) |
| `setting.outputStyle` | degraded-noop | cosmetic output styles not honored beyond Pi defaults (§7) |
| `setting.permissions.ask` ⚠ | degraded-noop | ask rules will NOT prompt — default-permissive posture runs them without asking (§6.1) |
| `setting.permissions.defaultMode` ⚠ | degraded-noop | permission modes/auto-mode are a no-op — sessions run default-permissive regardless (§6.1) |
| `setting.planMode` | degraded-noop | plan mode is a no-op — treated as guidance (§7) |
| `setting.statusLine` | degraded-noop | cosmetic statusline not honored beyond Pi defaults (§7) |

## Frontmatter fields (34)

Skill (`SKILL.md`), agent (`.claude/agents/*.md`), and rule frontmatter keys.

| ID | Tier | Note |
|---|---|---|
| `agent.frontmatter.color` | full | honored in console rendering where Pi's TUI allows (§4.3, §11) |
| `agent.frontmatter.description` | full | auto-injected routing surface for description-driven selection (§4.3) |
| `agent.frontmatter.disallowedTools` | full | tool denylist enforced for the subagent (§4.3) |
| `agent.frontmatter.effort` | full | per-agent effort override honored (§4.3, §10) |
| `agent.frontmatter.initialPrompt` | full | injected as the subagent's first user message (§4.3) |
| `agent.frontmatter.isolation` | full | isolation: worktree pins the subagent to its own worktree (§4.3, §4.4) |
| `agent.frontmatter.maxTurns` | full | turn cap enforced for the subagent (§4.3) |
| `agent.frontmatter.metadata` | full | metadata.* preserved and exposed (§4.3) |
| `agent.frontmatter.model` | full | per-agent model override honored (§4.3) |
| `agent.frontmatter.name` | full | agent identity for subagent_type dispatch (§4.3) |
| `agent.frontmatter.permissionMode` | full | parsed and applied within the §6.1 posture (deny + tools gating remain the controls) |
| `agent.frontmatter.skills` | full | listed skills preloaded into the agent's context (§4.3) |
| `agent.frontmatter.tools` | full | capability gating fully honored — the primary deterministic security control (§4.3, §6.1) |
| `rule.frontmatter.paths` | full | path-scoped rule injection on matching file access (§4.2) |
| `skill.frontmatter.agent` | full | names the agent context used with context: fork (§4.1) |
| `skill.frontmatter.allowed-tools` | full | tool allowlist enforced during skill execution (§4.1) |
| `skill.frontmatter.argument-hint` | full | shown for slash-command argument entry (§4.1) |
| `skill.frontmatter.arguments` | full | named argument specs with required/default handling (§4.1) |
| `skill.frontmatter.context` | full | context: fork runs the skill as a fresh-context subagent (§4.1) |
| `skill.frontmatter.description` | full | enters the startup listing; drives model invocation (§4.1) |
| `skill.frontmatter.disable-model-invocation` | full | hides the skill from model-invocation listing (§4.1) |
| `skill.frontmatter.disallowed-tools` | full | tool denylist enforced during skill execution (§4.1) |
| `skill.frontmatter.effort` | full | per-skill effort override honored (§4.1, §10) |
| `skill.frontmatter.hooks` | full | skill-scoped hook config dispatched while the skill is active (§4.1, §4.5) |
| `skill.frontmatter.metadata` | full | metadata.* preserved and exposed (§4.1) |
| `skill.frontmatter.model` | full | per-skill model override honored (§4.1) |
| `skill.frontmatter.name` | full | skill identity; nearest-scope wins on clashes (§3, §4.1) |
| `skill.frontmatter.paths` | full | path globs scoping when the skill's listing/injection applies (§4.1) |
| `skill.frontmatter.shell` | full | bash (default) \| powershell for !`cmd` injection (§4.1, §12.3) |
| `skill.frontmatter.user-invocable` | full | true (default) creates the slash command (§4.1) |
| `skill.frontmatter.when_to_use` | full | appended to the routing/listing surface (§4.1) |
| `agent.frontmatter.hooks` | degraded-noop | parsed; agent-scoped hooks are not dispatched in v1 |
| `agent.frontmatter.mcpServers` | degraded-noop | parsed; MCP deferred — no servers started for the agent (§7) |
| `agent.frontmatter.memory` | degraded-noop | parsed; no-op storage — auto-memory deferred (§7) |

## Runtime features (25)

Cross-cutting runtime subsystems and behaviors.

| ID | Tier | Note |
|---|---|---|
| `feature.claude-md-import` | full | @import expansion, recursive up to 4 hops, incl. the AGENTS.md bridge (§4.6) |
| `feature.compaction-preservation` | full | root CLAUDE.md + active skills + unconditional rules survive compaction (§9) |
| `feature.nested-claude-md` | full | nearest-ancestor CLAUDE.md injected on subdir file access, incl. worktrees (§4.6) |
| `feature.plugins-content` | full | installed-plugin skills/agents/hooks/commands folded into the registries (§4.9) |
| `feature.rules` | full | .claude/rules/ unconditional load + path-scoped injection at project and user scope (§4.2) |
| `feature.worktrees` | full | EnterWorktree/ExitWorktree lifecycle incl. .worktreeinclude, parallel sessions, Windows tolerance (§4.4) |
| `feature.hook-handler.http` | partial | http hook handlers dispatched best-effort (§4.5) |
| `feature.managed-policy` | partial | managed/enterprise policy honored where trivially present; otherwise degrade-safe (§7) |
| `feature.agent-memory` | degraded-noop | auto-memory parsed with no-op storage (§7) |
| `feature.hook-handler.agent` | degraded-noop | agent hook handlers degrade with a notice (§4.5) |
| `feature.hook-handler.mcp_tool` | degraded-noop | mcp_tool hook handlers degrade with a notice — MCP deferred (§4.5, §7) |
| `feature.hook-handler.prompt` | degraded-noop | prompt hook handlers degrade with a notice (§4.5) |
| `feature.mcp` | degraded-noop | MCP subsystem deferred — committed .mcp.json parsed without crashing, no servers started (§7) |
| `feature.plan-mode` | degraded-noop | plan mode treated as guidance; no mode switch, no ExitPlanMode gate (§7) |
| `feature.telemetry-otel` | degraded-noop | telemetry/OTEL settings parsed, nothing exported (§7) |
| `feature.agent-teams` | not-supported | agent teams out of scope; names degrade safely (§7) |
| `feature.artifacts` | not-supported | Artifacts out of scope; names degrade safely (§7) |
| `feature.background-agents` | not-supported | background agents out of scope; names degrade safely (§7) |
| `feature.checkpointing-rewind` | not-supported | no rewind parity — relies on Pi's session model (§7) |
| `feature.computer-use` | not-supported | computer use out of scope; names degrade safely (§7) |
| `feature.cron` | not-supported | scheduled tasks out of scope; names degrade safely (§7) |
| `feature.lsp` | not-supported | LSP integration out of scope; names degrade safely (§7) |
| `feature.plugin-install` | not-supported | plugin installation machinery out of scope — install plugins via Claude Code (§4.9) |
| `feature.plugin-marketplace` | not-supported | marketplace add/registration/release channels out of scope (§4.9) |
| `feature.remote-control` | not-supported | remote control out of scope; names degrade safely (§7) |

## Summary

The registry enumerates **134 capabilities** against baseline `claude-code-2.1.x (mid-2026)`: **87 full**, **4 partial**, **33 degraded-noop**, **10 not-supported**. 3 entries are safety-relevant (marked ⚠) — a divergence where a project's restriction is not enforced and is therefore reported prominently. Unknown inputs outside this registry are not counted here: they are unassessed by definition and degrade safely at runtime (plan §2.4).

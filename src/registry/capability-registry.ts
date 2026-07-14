/**
 * The living capability registry (plan §17) — the single source of truth for
 * what PiCC supports relative to the named Claude Code baseline.
 *
 * Every known Claude Code tool, hook event, setting, frontmatter field, and
 * runtime feature is enumerated here with a support tier and a one-line note.
 * The runtime compatibility report and /doctor (§6.2) are GENERATED from this
 * registry, so documentation and actual behavior cannot drift apart.
 *
 * Forward compatibility (§2.4): anything NOT in this registry is treated as
 * unassessed/unknown and degrades safely — see capabilityForToolName().
 * Updating support for a newly-assessed feature is a data change here plus a
 * targeted implementation, never a redesign.
 */
import type { CapabilityEntry } from "../types.js";
import { SUPPORTED_HOOK_EVENTS } from "../types.js";

/** Named Claude Code baseline all support claims are relative to (plan §17). */
export const CLAUDE_BASELINE = "claude-code-2.1.x (mid-2026)";

/** Registry id of the wildcard entry covering all `mcp__<server>__<tool>` names. */
export const MCP_TOOL_WILDCARD_ID = "tool.mcp__*";

function cap(
  kind: CapabilityEntry["kind"],
  id: string,
  tier: CapabilityEntry["tier"],
  note: string,
  safetyRelevant?: boolean,
): CapabilityEntry {
  return safetyRelevant === undefined
    ? { id, kind, tier, note }
    : { id, kind, tier, note, safetyRelevant };
}

// ---------------------------------------------------------------------------
// Tools (§4.8 tool-surface parity)
// ---------------------------------------------------------------------------

const TOOL_ENTRIES: CapabilityEntry[] = [
  cap("tool", "tool.Read", "full", "real implementation — file reads with Claude-shaped input"),
  cap("tool", "tool.Write", "full", "real implementation — file creation/overwrite"),
  cap("tool", "tool.Edit", "full", "real implementation — exact-string replacement edits"),
  cap("tool", "tool.Bash", "full", "real implementation (from Pi) — shell execution, bash + PowerShell aware"),
  cap("tool", "tool.Grep", "full", "real implementation — Claude-baseline parameter surface (-n, -A/-B/-C/context, -i, -o, type, glob, multiline, content/files_with_matches/count modes, head_limit/offset) with ripgrep/JS engine parity (§4.8)"),
  cap("tool", "tool.Glob", "full", "real implementation — file pattern matching"),
  cap("tool", "tool.WebFetch", "full", "implemented for real — research skills and permission allowlists depend on it (§4.8)"),
  cap("tool", "tool.WebSearch", "full", "implemented for real — research skills and permission allowlists depend on it (§4.8)"),
  cap("tool", "tool.Agent", "partial", "subagent dispatch — built-in general-purpose/Explore/Plan + project agents, omitted type defaults to general-purpose, verbatim final message; a terminal API error is a LOUD failure naming the cause (never an empty success), partial output preserved with a cut-off note (2.1.199/2.1.200); every resumable dispatch gets a stable agent id and live progress rendering; PARTIAL: PiCC defaults FOREGROUND whereas Claude 2.1.198 runs subagents background-by-default, so an implicit-concurrency fan-out runs serially unless run_in_background/background:true is set (see feature.background-agents) (§4.3)"),
  cap("tool", "tool.Task", "partial", "alias of the Agent subagent-dispatch tool — same loud-failure/agent-id/progress semantics and the same default-foreground divergence from Claude 2.1.198 background-by-default (§4.3)"),
  cap("tool", "tool.Skill", "full", "skill activation by name with argument substitution (§4.1)"),
  cap("tool", "tool.EnterWorktree", "full", "creates/re-enters .claude/worktrees/<flat>/ and swaps the session cwd (§4.4)"),
  cap("tool", "tool.ExitWorktree", "full", "keep|remove lifecycle with cwd restore, Windows-tolerant removal (§4.4)"),
  cap("tool", "tool.TaskCreate", "full", "current task-tracking surface (§4.8)"),
  cap("tool", "tool.TaskUpdate", "full", "current task-tracking surface (§4.8)"),
  cap("tool", "tool.TaskList", "full", "current task-tracking surface (§4.8)"),
  cap("tool", "tool.TaskGet", "full", "current task-tracking surface (§4.8)"),
  cap("tool", "tool.TodoWrite", "partial", "deprecated todo tool — mapped onto the Task* equivalents, not a native implementation (§4.8)"),
  // Degrade stubs — one entry per shipped DEGRADED_TOOLS stub (runtime/tools/
  // degrade-stubs.ts). Each name is registered as a CALLABLE no-op that returns
  // a notice, so gating/matching resolve and calls never wedge the session.
  // test/registry.test.ts asserts this list and DEGRADED_TOOLS stay in sync.
  cap("tool", "tool.NotebookEdit", "degraded-noop", "callable no-op stub — notebook editing not implemented; the notice directs editing the .ipynb as JSON via Read/Edit (§4.8, §7)"),
  cap("tool", "tool.NotebookRead", "degraded-noop", "callable no-op stub — notebook reading not implemented; the notice directs Read on the .ipynb JSON (§4.8, §7)"),
  cap("tool", "tool.AskUserQuestion", "degraded-noop", "callable no-op stub — deliberately not provided; the notice redirects questions to plain chat (§7)"),
  cap("tool", "tool.ExitPlanMode", "degraded-noop", "callable no-op stub — plan mode is a no-op; 'use plan mode' instructions are treated as guidance (§7)"),
  cap("tool", "tool.EnterPlanMode", "degraded-noop", "callable no-op stub — plan mode is a no-op; planning guidance is treated as ordinary instructions (§7)"),
  cap("tool", "tool.Artifact", "degraded-noop", "callable no-op stub — Artifacts out of scope; the notice directs output to a regular file (§7)"),
  cap("tool", "tool.computer", "degraded-noop", "callable no-op stub — computer use out of scope (§7)"),
  cap("tool", "tool.LSP", "degraded-noop", "callable no-op stub — LSP tooling out of scope; the notice directs Grep/Read navigation (§7)"),
  cap("tool", "tool.MultiEdit", "degraded-noop", "callable no-op stub — batch editing not implemented; the notice directs a sequence of Edit calls (§4.8)"),
  cap("tool", "tool.BashOutput", "degraded-noop", "callable no-op stub — background shells not implemented; commands run in the foreground (§4.8)"),
  cap("tool", "tool.KillShell", "degraded-noop", "callable no-op stub — background shells not implemented; there is no shell to kill (§4.8)"),
  cap("tool", "tool.KillBash", "degraded-noop", "callable no-op stub — background shells not implemented; there is no shell to kill (§4.8)"),
  cap("tool", "tool.SlashCommand", "partial", "thin alias over the skill-activation path (mirrors the Skill tool): parses a leading /name (incl. plugin-namespaced /plugin:name) + trailing args from the command string and activates the resolved skill; an unknown or model-blocked command throws a model-visible error like the Skill tool. PARTIAL: covers all user-defined skills/commands but NOT the built-in commands Claude 2.1.x can also invoke via the Skill/SlashCommand skill-activation path (/init, /review, /security-review) — PiCC ships no such built-ins; other built-ins (/clear, /compact, ...) are non-model-invocable in Claude too (§4.1, §4.8)"),
  cap("tool", "tool.TaskOutput", "full", "retrieves background subagent results (wait or poll) from the background-task registry, reusing the shared subagent renderer (F04): while awaiting a still-running task it streams a live view like a foreground subagent — a self-identifying header (Task(task-N) · Agent(<type>) with a muted agent-<id> subline), a rolling activity tail, and a current-activity line — then resolves the same call to an outcome badge (completed/failed/aborted) + transcript path + per-subagent usage footer; a poll (wait:false) shows the task's current status + last activity inside that same identifying frame, never a bare unlabelled chip; the agent-<id> identity is shown at EVERY surface INCLUDING non-resumable one-shot builtins, with no false 'resumable via SendMessage' invite (that invite renders only when the task is actually resumable); the render is display-only — the completed model-facing verbatim result text is byte-identical; a failed task reports failed status naming the API error plus any partial output (never an empty success), with the agent-id trailer + per-subagent usage line outside the verbatim body; the background-task registry is session-wide, so a subagent granted TaskOutput can reach ANY session task — its own and its siblings'/parent's — whereas Claude Code hides TaskOutput from subagents entirely (a project-intended restriction PiCC does not enforce when TaskOutput is granted to a subagent) (§4.3, §4.8)"),
  cap("tool", "tool.TaskStop", "partial", "stops a background subagent; PARTIAL: PiCC accepts only task_id, while Claude 2.1.198+ also accepts agent id/name. Stop is cooperative; the stopped status and discarded late result are PiCC-defined because Claude's post-stop result semantics are undocumented. Every result includes the task record's stored display type and stable agent id in PiCC-defined model-visible wording, not verified as exact Claude wording (§4.3, §4.8)"),
  cap("tool", "tool.SendMessage", "partial", "resumes a completed/failed-with-partial subagent by agent id in the background with prior context, or steers a running background one (Claude 2.1.x); resumed failed/completed agents return to running (2.1.205). GAPS: PiCC allows resume after TaskStop, while the Claude Code 2.1.x reference refuses stopped-agent resume; no cross-restart resume; steering is background-only; idle-parent settlement delivery is next-turn; fork/agentOverride dispatches and subagent-to-subagent/agent-teams messaging are unsupported. The resume acknowledgment includes the new task id, resolved registry name, and stable agent id in PiCC-defined model-visible wording, not verified as exact Claude wording (§4.3, §7)"),
  cap("tool", MCP_TOOL_WILDCARD_ID, "degraded-noop", "MCP deferred — mcp__* names gate/match predictably, calls degrade with a notice (§7)", false),
];

// ---------------------------------------------------------------------------
// Hook events (§4.5)
// ---------------------------------------------------------------------------

const SUPPORTED_HOOK_EVENT_NOTES: Record<(typeof SUPPORTED_HOOK_EVENTS)[number], string> = {
  PreToolUse: "fires before each tool call; Claude matcher semantics (exact/list/unanchored-regex) + full stdin/stdout contract incl. deny + updatedInput (§4.5)",
  PostToolUse: "fires after successful tool calls; matcher + if: conditions honored; exit-2 block feedback is fed back to the model (§4.5)",
  PostToolUseFailure: "fires after failed tool calls (§4.5)",
  SessionStart: "fires at session start; matcher matches the source exactly (startup|resume|clear|compact); stdout injected (§4.5, §9)",
  SessionEnd: "fires at session end (§4.5)",
  UserPromptSubmit: "fires on user prompt; stdout injected as context (§4.5)",
  Stop: "fires when the main agent wants to stop; exit 2 blocks stopping (§4.5)",
  SubagentStart: "fires when a subagent is spawned; payload carries agent_id + agent_type (subagent-only additions) while transcript_path stays the MAIN session transcript (Claude Code parity); NUANCE: agent_type is the agent's bare frontmatter/definition name — PiCC does NOT apply plugin-scoped naming, so a plugin subagent's agent_type is its plain name (Claude's exact plugin-scoped id here is unverified); a blocking outcome cancels the dispatch (§4.3, §4.5)",
  SubagentStop: "fires when a subagent wants to stop; payload carries agent_id + agent_type while transcript_path stays the MAIN session transcript (Claude Code parity); NUANCE: agent_type is the agent's bare frontmatter/definition name, not a plugin-scoped id (Claude's exact plugin-scoped id here is unverified); exit 2 blocks and re-prompts the subagent (bounded) (§4.3, §4.5)",
  PreCompact: "fires before compaction; matcher matches the trigger exactly (manual|auto); wired to instruction preservation (§9)",
  PostCompact: "fires after compaction; wired to re-injection (§9)",
  WorktreeCreate: "fires on worktree creation — worktree seeding pattern supported (§4.4)",
  WorktreeRemove: "fires on worktree removal (§4.4)",
};

const HOOK_EVENT_ENTRIES: CapabilityEntry[] = [
  ...SUPPORTED_HOOK_EVENTS.map((ev) =>
    cap("hook-event", `hook.event.${ev}`, "full", SUPPORTED_HOOK_EVENT_NOTES[ev]),
  ),
  cap("hook-event", "hook.event.Notification", "degraded-noop", "UI-notification event — parsed, never fired (no equivalent harness surface); background-subagent settlement does NOT fire an agent_completed Notification (t05 left it unwired) — the coordinator learns of a settlement via the pushed settlement message and the SubagentStop hook instead"),
  cap("hook-event", "hook.event.PermissionRequest", "degraded-noop", "tied to interactive permission machinery — never fired under the default-permissive posture (§6.1)", true),
  cap("hook-event", "hook.event.TeammateIdle", "degraded-noop", "agent-teams event — teams out of scope, parsed and never fired (§7)"),
  cap("hook-event", "hook.event.TaskCompleted", "degraded-noop", "task-list event — parsed, never fired in v1"),
  cap("hook-event", "hook.event.mcp__elicitation", "degraded-noop", "MCP elicitation hook events — MCP deferred, parsed and never fired (§7)"),
];

// ---------------------------------------------------------------------------
// Settings (§5 honored toggles; §6 permissions; §7 deferred keys)
// ---------------------------------------------------------------------------

const SETTING_ENTRIES: CapabilityEntry[] = [
  // Honored toggles (§5) — full.
  cap("setting", "setting.hooks", "full", "hook config dispatched per §4.5 — Claude matcher semantics (exact/list/unanchored-regex), parallel execution with dedup, async handlers, systemMessage/suppressOutput honored (command handlers full)"),
  cap("setting", "setting.env", "full", "injected into sessions and hook/skill subprocesses (§5)"),
  cap("setting", "setting.disableAllHooks", "full", "disables all hook dispatch (§4.5)"),
  cap("setting", "setting.disableSkillShellExecution", "full", "disables !`cmd` skill shell injection (§4.1)"),
  cap("setting", "setting.skillListingBudgetFraction", "full", "caps the startup skill-listing token budget (§4.1, §12.1)"),
  cap("setting", "setting.skillListingMaxDescChars", "full", "caps per-skill description length in the startup listing (default 1536, Claude parity; tiered degradation, never omits a skill) (§4.1)"),
  cap("setting", "setting.autoMemoryEnabled", "full", "gates auto-memory loading (default true; CLAUDE_CODE_DISABLE_AUTO_MEMORY also honored) (§4.6)"),
  cap("setting", "setting.autoMemoryDirectory", "full", "overrides the auto-memory storage directory (~ and env expanded) (§4.6)"),
  cap("setting", "setting.claudeMd", "full", "managed-scope inline CLAUDE.md content injected at highest priority; ignored with a diagnostic in other scopes (§4.6)"),
  cap("setting", "setting.skillOverrides", "full", "per-skill overrides applied at load: off / user-invocable-only / name-only (§5)"),
  cap("setting", "setting.claudeMdExcludes", "full", "excludes CLAUDE.md/rules files from loading (§4.2, §4.6)"),
  cap("setting", "setting.worktree.baseRef", "full", "head|fresh base resolved to a concrete commit before worktree creation (§4.4)"),
  cap("setting", "setting.cleanupPeriodDays", "partial", "max-age (days) for orphaned-WORKTREE reaping at startup; subagent transcript dirs (<base>.subagents/) are NOT reaped — worktrees-only cleanup (t02 shipped no transcript reaper), same accumulation class as Pi's own session files (§4.4)"),
  cap("setting", "setting.subagentsEnabled", "full", "gates subagent dispatch (§4.3)"),
  cap("setting", "setting.subagentMaxDepth", "full", "caps nested subagent recursion depth (default 5, Claude parity) (§4.3)"),
  cap("setting", "setting.subagentConcurrency", "full", "caps parallel subagent fan-out (§4.3, §12.2)"),
  cap("setting", "setting.enabledPlugins", "full", "selects installed-plugin content to load; merges key-wise across scopes, nearer scope wins per plugin (§4.9)"),
  // Parsed but consumed by nothing yet — honest no-ops, surfaced by the compat
  // report when a project declares them (§5: a toggle that silently doesn't
  // take effect is a correctness bug).
  cap("setting", "setting.model", "degraded-noop", "parsed, not consumed — session model selection uses PiCC config (model/effort), not Claude model names; reported when set (§5, §10)"),
  cap("setting", "setting.includeCoAuthoredBy", "degraded-noop", "parsed, not consumed — PiCC has no commit-attribution machinery either way; reported when set (§5, §7)"),
  cap("setting", "setting.attribution", "degraded-noop", "parsed, not consumed — no commit/PR attribution machinery; reported when set (§5, §7)"),
  cap("setting", "setting.apiKeyHelper", "degraded-noop", "parsed, never invoked — auth comes from the harness subscription/provider flow; reported when set (§5, §7)"),
  // Permissions (§6.1 posture).
  cap("setting", "setting.permissions.deny", "full", "hard, non-interactive block — the kept deterministic safety valve (§6.1)"),
  cap("setting", "setting.permissions.additionalDirectories", "degraded-noop", "parsed, no-op — the default-permissive posture applies no directory sandbox, so extra grants are moot; reported when set (§6.1)"),
  cap("setting", "setting.permissions.allow", "partial", "parsed and matched, but moot under the default-permissive posture — nothing waits on an allow (§6.1)"),
  cap("setting", "setting.permissions.ask", "degraded-noop", "ask rules will NOT prompt — default-permissive posture runs them without asking (§6.1)", true),
  cap("setting", "setting.permissions.defaultMode", "degraded-noop", "permission modes/auto-mode are a no-op — sessions run default-permissive regardless (§6.1)", true),
  // Deferred-subsystem keys (§7) — parsed, degrade safely, reported.
  cap("setting", "setting.mcpServers", "degraded-noop", "MCP deferred — parsed, no servers started (§7)"),
  cap("setting", "setting.enableAllProjectMcpServers", "degraded-noop", "MCP deferred — parsed, no servers started (§7)"),
  cap("setting", "setting.enabledMcpjsonServers", "degraded-noop", "MCP deferred — parsed, no servers started (§7)"),
  cap("setting", "setting.disabledMcpjsonServers", "degraded-noop", "MCP deferred — parsed, no servers started (§7)"),
  cap("setting", "setting.outputStyle", "degraded-noop", "cosmetic output styles not honored beyond Pi defaults (§7)"),
  cap("setting", "setting.statusLine", "degraded-noop", "cosmetic statusline not honored beyond Pi defaults (§7)"),
  cap("setting", "setting.checkpointing", "degraded-noop", "checkpointing/rewind deferred — Pi's session model instead (§7)"),
  cap("setting", "setting.memory", "full", "auto memory: MEMORY.md (first 200 lines / 25 KB) loads at session start with write-back conventions injected; autoMemoryEnabled/autoMemoryDirectory + CLAUDE_CODE_DISABLE_AUTO_MEMORY honored (§4.6)"),
  cap("setting", "setting.planMode", "degraded-noop", "plan mode is a no-op — treated as guidance (§7)"),
];

// ---------------------------------------------------------------------------
// Frontmatter fields (§4.1 skills, §4.3 agents, §4.2 rules)
// ---------------------------------------------------------------------------

const SKILL_FRONTMATTER_FULL_NOTES: Record<string, string> = {
  name: "skill identity; nearest-scope wins on clashes (§3, §4.1)",
  description: "enters the startup listing; drives model invocation (§4.1)",
  when_to_use: "appended to the routing/listing surface (§4.1)",
  "user-invocable": "true (default) creates the slash command (§4.1)",
  "disable-model-invocation": "hides the skill from model-invocation listing (§4.1)",
  "argument-hint": "shown for slash-command argument entry (§4.1)",
  arguments: "named argument specs with required/default handling (§4.1)",
  "disallowed-tools": "denylist enforced — resident-skill denials feed the session deny guard; context:fork dispatch receives them as subagent gating (§4.1, §6.1)",
  context: "context: fork runs the skill as a fresh-context subagent (§4.1)",
  agent: "names the agent context used with context: fork (§4.1)",
  hooks: "skill-scoped hook config dispatched while the skill is active (§4.1, §4.5)",
  paths: "path-scoped skills are surfaced (once) when a matching file is accessed; activation stays explicit via the Skill tool (§4.1, §4.2)",
  shell: "bash (default) | powershell for !`cmd` injection (§4.1, §12.3)",
  metadata: "metadata.* preserved and exposed (§4.1)",
};

const AGENT_FRONTMATTER_FULL_NOTES: Record<string, string> = {
  name: "agent identity for subagent_type dispatch (§4.3)",
  description: "auto-injected routing surface for description-driven selection (§4.3)",
  tools: "capability gating fully honored — the primary deterministic security control (§4.3, §6.1)",
  disallowedTools: "tool denylist enforced for the subagent (§4.3)",
  model: "per-agent model override honored (§4.3)",
  effort: "per-agent effort override honored (§4.3, §10)",
  skills: "listed skills preloaded into the agent's context (§4.3)",
  isolation: "isolation: worktree pins the subagent to its own worktree (§4.3, §4.4)",
  background: "background: true dispatches the subagent in the background without run_in_background (Claude 2.1.198); routed through the same background-task lifecycle and degrades to foreground under CLAUDE_CODE_DISABLE_BACKGROUND_TASKS (§4.3)",
  initialPrompt: "injected as the subagent's first user message (§4.3)",
  metadata: "metadata.* preserved and exposed (§4.3)",
};

const FRONTMATTER_ENTRIES: CapabilityEntry[] = [
  ...Object.entries(SKILL_FRONTMATTER_FULL_NOTES).map(([key, note]) =>
    cap("frontmatter", `skill.frontmatter.${key}`, "full", note),
  ),
  // Skill fields honored with a boundary (§4.1): full for context:fork dispatch,
  // constrained for in-session (resident) activation.
  cap("frontmatter", "skill.frontmatter.allowed-tools", "partial", "gates tools for context:fork dispatch; trivially satisfied for in-session activation under the default-permissive posture (§4.1, §6.1)", true),
  cap("frontmatter", "skill.frontmatter.model", "partial", "honored for context:fork dispatch; in-session activation cannot switch the parent session's model (§4.1, §10)"),
  cap("frontmatter", "skill.frontmatter.effort", "partial", "honored for context:fork dispatch and ${CLAUDE_EFFORT} substitution; does not change the parent session's reasoning effort (§4.1, §10)"),
  ...Object.entries(AGENT_FRONTMATTER_FULL_NOTES).map(([key, note]) =>
    cap("frontmatter", `agent.frontmatter.${key}`, "full", note),
  ),
  cap("frontmatter", "agent.frontmatter.maxTurns", "partial", "best-effort cap — tool calls past the cap are blocked with an instruction to answer; the model still produces its final message (§4.3)"),
  cap("frontmatter", "agent.frontmatter.permissionMode", "degraded-noop", "parsed, no-op — subagents run the default-permissive posture regardless; deny rules + tools: gating remain the controls; reported when set (§6.1)", true),
  cap("frontmatter", "agent.frontmatter.color", "degraded-noop", "parsed only — cosmetic; Pi's TUI does not render agent colors (§4.3, §11)"),
  cap("frontmatter", "agent.frontmatter.memory", "full", "user|project|local scopes resolve to Claude's agent-memory dirs; MEMORY.md (200 lines / 25 KB) injected with persistence guidance (§4.3, §4.6)"),
  cap("frontmatter", "agent.frontmatter.mcpServers", "degraded-noop", "parsed; MCP deferred — no servers started for the agent (§7)"),
  cap("frontmatter", "agent.frontmatter.hooks", "full", "scoped hook runner active for the subagent's dispatch; Stop maps to SubagentStop (§4.3, §4.5)"),
  cap("frontmatter", "rule.frontmatter.paths", "full", "path-scoped rule injection on matching file access (§4.2)"),
];

// ---------------------------------------------------------------------------
// Runtime features (§4, §7, §9)
// ---------------------------------------------------------------------------

const FEATURE_ENTRIES: CapabilityEntry[] = [
  cap("feature", "feature.worktrees", "full", "EnterWorktree/ExitWorktree lifecycle incl. .worktreeinclude, parallel sessions, Windows tolerance (§4.4)"),
  cap("feature", "feature.claude-md-import", "full", "@import expansion, recursive up to 4 hops, incl. the AGENTS.md bridge (§4.6)"),
  cap("feature", "feature.nested-claude-md", "full", "full ancestor-chain CLAUDE.md/CLAUDE.local.md load (to filesystem root) + nearest-ancestor injection on subdir file access, incl. worktrees (§4.6)"),
  cap("feature", "feature.rules", "full", ".claude/rules/ unconditional load + path-scoped injection at project and user scope (§4.2)"),
  cap("feature", "feature.plugins-content", "full", "installed-plugin skills/agents/hooks/commands folded into the registries (§4.9)"),
  cap("feature", "feature.compaction-preservation", "full", "root CLAUDE.md + active skills (Claude-parity 20k/100k char budgets, most-recent-first) + unconditional rules survive compaction (§9)"),
  cap("feature", "feature.plugin-install", "not-supported", "plugin installation machinery out of scope — install plugins via Claude Code (§4.9)"),
  cap("feature", "feature.plugin-marketplace", "not-supported", "marketplace add/registration/release channels out of scope (§4.9)"),
  cap("feature", "feature.checkpointing-rewind", "not-supported", "no rewind parity — relies on Pi's session model (§7)"),
  cap("feature", "feature.agent-teams", "not-supported", "agent teams out of scope; names degrade safely (§7)"),
  cap("feature", "feature.background-agents", "partial", "background dispatch, TaskOutput/TaskStop, loud failures, next-turn settlement push, and live progress while TaskOutput awaits. GAPS: PiCC defaults foreground unlike Claude 2.1.198; TaskStop accepts only task_id (Claude 2.1.198+ also accepts agent id/name); PiCC allows SendMessage resume after TaskStop while the Claude Code 2.1.x reference refuses stopped-agent resume; idle parents are not re-invoked; notices are bounded; no always-on Agent View; no remote/cloud agents; stop is cooperative. Lifecycle identity uses the task record's stored display type and stable agent id; resume uses a new task id and resolved registry name. Wording is model-visible and PiCC-defined, not verified as exact Claude wording (§4.3)"),
  cap("feature", "feature.cron", "not-supported", "scheduled tasks out of scope; names degrade safely (§7)"),
  cap("feature", "feature.remote-control", "not-supported", "remote control out of scope; names degrade safely (§7)"),
  cap("feature", "feature.lsp", "not-supported", "LSP integration out of scope; names degrade safely (§7)"),
  cap("feature", "feature.computer-use", "not-supported", "computer use out of scope; names degrade safely (§7)"),
  cap("feature", "feature.artifacts", "not-supported", "Artifacts out of scope; names degrade safely (§7)"),
  cap("feature", "feature.telemetry-otel", "degraded-noop", "telemetry/OTEL settings parsed, nothing exported (§7)"),
  cap("feature", "feature.mcp", "degraded-noop", "MCP subsystem deferred — committed .mcp.json parsed without crashing, no servers started (§7)"),
  cap("feature", "feature.plan-mode", "degraded-noop", "plan mode treated as guidance; no mode switch, no ExitPlanMode gate (§7)"),
  cap("feature", "feature.agent-memory", "full", "auto memory (project MEMORY.md) + per-agent memory scopes loaded and injected with write-back conventions (§4.6)"),
  cap("feature", "feature.managed-policy", "partial", "managed/enterprise policy honored where trivially present; otherwise degrade-safe (§7)"),
  cap("feature", "feature.hook-handler.http", "partial", "http hook handlers dispatched best-effort (§4.5)"),
  cap("feature", "feature.hook-handler.prompt", "degraded-noop", "prompt hook handlers degrade with a notice (§4.5)"),
  cap("feature", "feature.hook-handler.agent", "degraded-noop", "agent hook handlers degrade with a notice (§4.5)"),
  cap("feature", "feature.hook-handler.mcp_tool", "degraded-noop", "mcp_tool hook handlers degrade with a notice — MCP deferred (§4.5, §7)"),
];

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** The living registry enumerating the baseline surface (plan §17). */
export const CAPABILITY_REGISTRY: CapabilityEntry[] = [
  ...TOOL_ENTRIES,
  ...HOOK_EVENT_ENTRIES,
  ...SETTING_ENTRIES,
  ...FRONTMATTER_ENTRIES,
  ...FEATURE_ENTRIES,
];

const REGISTRY_BY_ID: ReadonlyMap<string, CapabilityEntry> = new Map(
  CAPABILITY_REGISTRY.map((e) => [e.id, e]),
);

/** Exact-id lookup into the registry; undefined for anything unassessed. */
export function lookupCapability(id: string): CapabilityEntry | undefined {
  return REGISTRY_BY_ID.get(id);
}

/**
 * Resolve a Claude tool name (as used in `tools:`, `permissions.*`, hook `if:`)
 * to a capability entry. Unknown names get a synthesized not-supported entry —
 * the forward-compatibility default (§2.4): the name still resolves for gating
 * purposes and degrades safely. The synthesized entry is NOT added to the
 * registry; unassessed names stay unassessed until reviewed (§17).
 */
export function capabilityForToolName(tool: string): CapabilityEntry {
  if (tool.startsWith("mcp__")) {
    const mcp = REGISTRY_BY_ID.get(MCP_TOOL_WILDCARD_ID);
    if (mcp) return mcp;
  }
  const known = REGISTRY_BY_ID.get(`tool.${tool}`);
  if (known) return known;
  return {
    id: `tool.${tool}`,
    kind: "tool",
    tier: "not-supported",
    note: "unassessed/unknown — degrades safely",
  };
}

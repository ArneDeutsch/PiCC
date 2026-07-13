/**
 * Shared types for all PiCC subsystems.
 *
 * Terminology follows the plan (doc/plan/picc-plan.md):
 * - "artifact": any Claude-format input (skill, agent, rule, CLAUDE.md, settings, hook, plugin content)
 * - "scope": where an artifact was discovered; precedence flows managed > local > project > user.
 */

// ---------------------------------------------------------------------------
// Scopes & discovery
// ---------------------------------------------------------------------------

export type Scope = "managed" | "local" | "project" | "user" | "plugin" | "builtin";

/** Precedence order for name clashes: earlier wins. */
export const SCOPE_PRECEDENCE: readonly Scope[] = [
  "managed",
  "local",
  "project",
  "user",
  "plugin",
  "builtin",
];

export interface SourceRef {
  /** Absolute path of the file this artifact came from ("<virtual>" for synthesized). */
  path: string;
  scope: Scope;
  /** For plugin-contributed artifacts: the plugin name. */
  pluginName?: string;
}

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  source?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter (generic parse result)
// ---------------------------------------------------------------------------

export interface ParsedMarkdown {
  /** Raw frontmatter mapping; empty object when absent. Unknown keys preserved. */
  frontmatter: Record<string, unknown>;
  /** Body after the frontmatter block (or whole file when no frontmatter). */
  body: string;
  /** Parse problems (malformed YAML etc.) — never fatal per the completeness floor. */
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Skills (§4.1)
// ---------------------------------------------------------------------------

export interface SkillArgumentSpec {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

export interface ClaudeSkill {
  name: string;
  description: string;
  whenToUse?: string;
  /** true (default) => slash command exists. */
  userInvocable: boolean;
  /** true => hidden from model-invocation listing. */
  disableModelInvocation: boolean;
  argumentHint?: string;
  arguments?: SkillArgumentSpec[];
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: string;
  /** "fork" => run as subagent; agentType names which agent context to use. */
  contextFork: boolean;
  forkAgentType?: string;
  hooks?: HookConfig;
  /** Path globs scoping when this skill's listing/injection applies. */
  paths?: string[];
  /** Shell for !`cmd` injection: "bash" (default) | "powershell". */
  shell: "bash" | "powershell";
  metadata: Record<string, unknown>;
  /** Directory containing SKILL.md (skill dir) — base for bundled files & ${CLAUDE_SKILL_DIR}. */
  baseDir: string;
  source: SourceRef;
  /** Lazily loaded: undefined until activation (progressive disclosure!). */
  body?: string;
  /** True for legacy .claude/commands/*.md entries. */
  legacyCommand: boolean;
  /** Unrecognized frontmatter keys — surfaced in the compatibility report. */
  unknownKeys: string[];
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Agents (§4.3)
// ---------------------------------------------------------------------------

export interface ClaudeAgent {
  name: string;
  description: string;
  /** Tool allowlist (Claude tool names, or "*" semantics when undefined = all tools). */
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: string;
  permissionMode?: string;
  maxTurns?: number;
  /** Skills preloaded into the agent's context. */
  skills?: string[];
  color?: string;
  isolation?: "worktree";
  /**
   * `background: true` (Claude Code 2.1.198): forces the dispatch to run in the
   * background even when the Agent tool call omits `run_in_background` (t05).
   */
  background?: boolean;
  initialPrompt?: string;
  metadata: Record<string, unknown>;
  /** Parsed but deferred (§7): memory, mcpServers, hooks. */
  memory?: unknown;
  mcpServers?: unknown;
  hooks?: HookConfig;
  /** System prompt body. Loaded eagerly (agent bodies are the routing/system surface). */
  body: string;
  source: SourceRef;
  /** True for the code-constructed built-in agents (general-purpose, Explore, Plan). */
  builtin?: boolean;
  /**
   * Skip CLAUDE.md/project-instructions and rules in the subagent system prompt
   * (Claude's Explore/Plan context trimming — audit E6).
   */
  skipProjectContext?: boolean;
  unknownKeys: string[];
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Rules (§4.2)
// ---------------------------------------------------------------------------

export interface ClaudeRule {
  /** Relative id, e.g. "rules/git.md". */
  id: string;
  /** When set: inject only when the model touches a matching file. */
  paths?: string[];
  body: string;
  source: SourceRef;
  unknownKeys: string[];
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// CLAUDE.md (§4.6)
// ---------------------------------------------------------------------------

export interface ClaudeMdFile {
  /** Absolute path of the file. */
  path: string;
  /** Directory whose file accesses trigger injection (dirname of path). */
  dir: string;
  /** Content after @import expansion and HTML-comment stripping. */
  content: string;
  scope: Scope;
  /** True for the root/top-level files loaded at session start. */
  loadAtStart: boolean;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Hooks (§4.5)
// ---------------------------------------------------------------------------

export const SUPPORTED_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "WorktreeCreate",
  "WorktreeRemove",
] as const;
export type SupportedHookEvent = (typeof SUPPORTED_HOOK_EVENTS)[number];

export type HookHandlerType = "command" | "http" | "prompt" | "agent" | "mcp_tool";

export interface HookHandler {
  type: HookHandlerType;
  /** command handler */
  command?: string;
  args?: string[];
  shell?: "bash" | "powershell";
  timeout?: number; // seconds (Claude convention)
  once?: boolean;
  /** Fire-and-forget: never awaited, output/exit code ignored (Claude `async: true`). */
  async?: boolean;
  /** http handler (best-effort) */
  url?: string;
  /** Raw definition for degraded handler types. */
  raw: Record<string, unknown>;
}

export interface HookMatcherEntry {
  /** Tool-name regex/alternation (PreToolUse/PostToolUse style). Undefined = match all. */
  matcher?: string;
  /** Payload conditional reusing permission-rule grammar, e.g. "Bash(git *)". */
  if?: string;
  hooks: HookHandler[];
}

/** eventName -> matcher entries. Unknown event names preserved (degrade + report). */
export type HookConfig = Record<string, HookMatcherEntry[]>;

/** Payload delivered to command hooks on stdin (Claude Code schema). */
export interface HookPayload {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: string;
  /** Constant "default" — PiCC runs a single (default-permissive) posture. */
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUse: the STRUCTURED tool result (content array/object), as Claude sends it. */
  tool_response?: unknown;
  /** Pre/PostToolUse(-Failure): the provider tool-call id, when the host exposes one. */
  tool_use_id?: string;
  prompt?: string;
  /** Stop: text of the last assistant message, when the host exposes it. */
  last_assistant_message?: string;
  [key: string]: unknown;
}

export interface HookOutcome {
  /** Hard block (exit 2 or permissionDecision deny). */
  block: boolean;
  blockReason?: string;
  /** ask decisions are logged-allowed per posture §6.1 but surfaced. */
  askDowngraded: boolean;
  /** Context to inject into the model. */
  additionalContext?: string;
  /** Replacement tool input. */
  updatedInput?: Record<string, unknown>;
  /** Plain stdout for context-injecting events (UserPromptSubmit, SessionStart, ...). */
  stdout?: string;
  /** Top-level `systemMessage` strings — user-facing, shown once by call sites. */
  systemMessages?: string[];
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Settings (§5)
// ---------------------------------------------------------------------------

export interface PermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
  additionalDirectories: string[];
  defaultMode?: string;
}

export interface WorktreeSettings {
  /** "head" (default) | "fresh". */
  baseRef: "head" | "fresh";
}

export interface ClaudeSettings {
  permissions: PermissionRules;
  hooks: HookConfig;
  env: Record<string, string>;
  model?: string;
  includeCoAuthoredBy?: boolean;
  attribution?: Record<string, unknown>;
  disableAllHooks: boolean;
  disableSkillShellExecution: boolean;
  skillListingBudgetFraction?: number;
  skillListingMaxDescChars?: number;
  skillOverrides: Record<string, unknown>;
  claudeMdExcludes: string[];
  /** Auto memory read side (B4): default true; env CLAUDE_CODE_DISABLE_AUTO_MEMORY overrides. */
  autoMemoryEnabled?: boolean;
  /** Overrides the default `<userDir>/projects/<flattened>/memory` auto-memory directory. */
  autoMemoryDirectory?: string;
  /** Managed-settings `claudeMd` key: inline CLAUDE.md content (managed scope only). */
  managedClaudeMd?: { content: string; source: string };
  worktree: WorktreeSettings;
  cleanupPeriodDays?: number;
  apiKeyHelper?: string;
  /** Subagent controls. */
  subagentsEnabled: boolean;
  subagentMaxDepth: number;
  subagentConcurrency: number;
  enabledPlugins: Record<string, boolean> | string[] | undefined;
  /** Every key we did not recognize, with the scope it came from (compat report). */
  unknownKeys: Array<{ key: string; scope: Scope }>;
  /** Keys recognized but gating deferred subsystems (compat report). */
  deferredKeys: Array<{ key: string; scope: Scope }>;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Permission matching (§6)
// ---------------------------------------------------------------------------

export interface PermissionRule {
  /** Original rule text, e.g. "Bash(git *)" or "WebFetch(domain:example.com)". */
  raw: string;
  /** Claude tool name or "mcp__server__tool" or "*". */
  tool: string;
  /** Specifier inside parens, undefined for bare tool rules. */
  specifier?: string;
}

export interface ToolCallDescriptor {
  /** Claude-canonical tool name. */
  tool: string;
  /** Tool input (already Claude-shaped). */
  input: Record<string, unknown>;
  /** cwd for path-anchored matching. */
  cwd: string;
}

// ---------------------------------------------------------------------------
// Capability registry (§17)
// ---------------------------------------------------------------------------

export type SupportTier =
  | "full"
  | "partial"
  | "degraded-noop"
  | "not-supported"
  | "na";

export interface CapabilityEntry {
  /** e.g. "skill.frontmatter.context", "hook.event.PreToolUse", "tool.WebFetch", "setting.permissions.ask" */
  id: string;
  kind: "artifact" | "frontmatter" | "tool" | "hook-event" | "setting" | "feature";
  tier: SupportTier;
  /** True when the divergence is safety-relevant (something restricted now runs freely). */
  safetyRelevant?: boolean;
  note: string;
}

// ---------------------------------------------------------------------------
// Project model (assembled by discovery)
// ---------------------------------------------------------------------------

export interface ClaudeProject {
  /** Repo root (or cwd when not in a repo). */
  root: string;
  /** Launch cwd. */
  cwd: string;
  userDir: string; // ~/.claude
  settings: ClaudeSettings;
  skills: ClaudeSkill[];
  agents: ClaudeAgent[];
  rules: ClaudeRule[];
  claudeMd: ClaudeMdFile[];
  diagnostics: Diagnostic[];
}

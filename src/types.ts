/**
 * Shared types for all PiCC subsystems.
 *
 * Terminology:
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
  /** For plugin-contributed artifacts: the user-visible component namespace. */
  pluginName?: string;
  /** Stable installed lifecycle identity (`name@marketplace`). */
  pluginId?: string;
}

export type ManagedPolicySourceClass =
  | "standalone-mcp"
  | "system-file"
  | "system-drop-in"
  | "override";

export type ManagedPolicyDiagnosticCategory =
  | "managed-policy-malformed"
  | "managed-policy-unreadable";

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  source?: string;
  /** Stable policy classification for startup handling; absent on ordinary diagnostics. */
  category?: ManagedPolicyDiagnosticCategory;
  sourceClass?: ManagedPolicySourceClass;
  impact?: "source-ignored";
}

// ---------------------------------------------------------------------------
// Installed plugins
// ---------------------------------------------------------------------------

export type PluginInstallationScope = "managed" | "local" | "project" | "user";

export interface PluginInstallationProvenance {
  statePath: string;
  stateVersion: number;
  installedAt?: string;
  lastUpdated?: string;
}

export interface NormalizedPluginInstallation {
  pluginId: string;
  scope: PluginInstallationScope;
  projectPath?: string;
  installPath: string;
  version: string;
  provenance: PluginInstallationProvenance;
}

export type PluginResolutionStatus =
  | "loaded"
  | "disabled"
  | "enabled-but-uninstalled"
  | "unsupported"
  | "ambiguous"
  | "blocked"
  | "malformed"
  | "rejected";

export interface ValidatedPluginSourceMetadata {
  pluginId: string;
  pluginName: string;
  authorizedRoot: string;
  lexicalPath: string;
  canonicalPath: string;
}

export type PluginComponentSource =
  | { kind: "file"; path: string; metadata: ValidatedPluginSourceMetadata }
  | { kind: "directory"; path: string; metadata: ValidatedPluginSourceMetadata }
  | { kind: "inline"; value: unknown; pluginId: string; pluginName: string; source: string };

export interface PluginRuntimeContext {
  pluginId: string;
  pluginName: string;
  root: string;
  dataDir: string;
  projectDir: string;
}

export type PluginSharedStateCause =
  | "installed-state-unreadable"
  | "installed-state-malformed"
  | "installed-state-unsupported"
  | "blocklist-unreadable"
  | "blocklist-malformed";

export type PluginManifestDefaultEnabledEvidence =
  | { presence: "explicit"; value: boolean; sourcePath: string }
  | { presence: "absent"; sourcePath: string };

export interface PluginResolutionOutcome {
  pluginId: string;
  status: PluginResolutionStatus;
  sharedStateCauses?: readonly PluginSharedStateCause[];
  installation?: NormalizedPluginInstallation;
  context?: PluginRuntimeContext;
  sources?: PluginComponentSource[];
  manifestDefaultEnabled?: PluginManifestDefaultEnabledEvidence;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Marketplace observations
// ---------------------------------------------------------------------------

export type PluginMarketplaceRegistrationOrigin = "primary" | "seed" | "settings";

export interface PluginMarketplaceProvenance {
  scope: PluginInstallationScope;
  sourcePath: string;
  origin: PluginMarketplaceRegistrationOrigin;
  order: number;
}

export type PluginMarketplaceRegistrationSource =
  | { kind: "github"; repo: string; ref?: string }
  | { kind: "git"; url: string; ref?: string }
  | { kind: "url"; url: string }
  | { kind: "directory" | "file"; path: string; localPath: string };

export type PluginMarketplacePolicyDescriptor =
  | PluginMarketplaceRegistrationSource
  | { kind: "hostPattern"; hostPattern: string }
  | { kind: "pathPattern"; pathPattern: string };

export type PluginMarketplaceCatalogSource =
  | { kind: "relative"; value: string }
  | { kind: "github"; repo: string; ref?: string; sha?: string }
  | { kind: "url"; url: string; ref?: string; sha?: string }
  | { kind: "git-subdir"; url: string; path: string; ref?: string; sha?: string }
  | { kind: "npm"; package: string; version?: string; registry?: string }
  | { kind: "archive"; url: string; sha256?: string };

export interface PluginMarketplaceFieldProvenance {
  field: string;
  sourcePath: string;
  entryIndex?: number;
  key?: string;
  itemIndex?: number;
}

export interface PluginMarketplaceRegistration {
  name: string;
  source: PluginMarketplaceRegistrationSource;
  sourceProvenance: PluginMarketplaceFieldProvenance;
  provenance: PluginMarketplaceProvenance;
  fixtureContract?: "fixture-derived-unverified";
  catalogPath?: string;
  selected: boolean;
  validity: "valid" | "rejected";
}

export interface PluginMarketplaceDependency {
  declaredName: string;
  declaringIdentity: string;
  targetIdentity: string;
  marketplace: string;
  version?: string;
  versionStatus?: "syntax-unverified-not-resolved";
  provenance: PluginMarketplaceFieldProvenance;
  crossMarketplace: "same-marketplace" | "declared-allowed" | "declared-not-allowed" | "indeterminate-because-evidence-omitted";
  posture: "declared-locally-observable-not-resolved";
}

export interface PluginMarketplaceSafeShape {
  keys: readonly { key: string; type: "array" | "boolean" | "null" | "number" | "object" | "string" }[];
  omitted: number;
}

export type PluginMarketplaceComponentDeclaration =
  | {
    kind: "path";
    value: string;
    provenance: PluginMarketplaceFieldProvenance;
    posture: "declared-not-effective";
  }
  | {
    kind: "object-shape";
    shape: PluginMarketplaceSafeShape;
    provenance: PluginMarketplaceFieldProvenance;
    posture: "declared-not-effective";
  };

export type PluginMarketplaceComponentField = "commands" | "agents" | "skills" | "hooks" | "mcpServers" | "lspServers";
export type PluginMarketplaceComponentMap = Partial<Record<PluginMarketplaceComponentField, readonly PluginMarketplaceComponentDeclaration[]>>;
export type PluginMarketplaceUnsupportedComponentField = "workflows" | "outputStyles" | "themes" | "monitors" | "experimental.themes" | "experimental.monitors" | "channels";
export interface PluginMarketplaceUnsupportedComponentObservation {
  field: PluginMarketplaceUnsupportedComponentField;
  declaration: "string-shape" | "array-shape";
  count: number;
  provenance: PluginMarketplaceFieldProvenance;
  posture: "declared-not-effective";
}

export interface PluginMarketplaceCatalogObservation {
  marketplace: string;
  catalogPath: string;
  metadata?: { pluginRoot: string; provenance: PluginMarketplaceFieldProvenance; posture: "inert-lexical-effect-only" };
  provenance: PluginMarketplaceProvenance;
}

export interface PluginMarketplaceCatalogEntry {
  identity: string;
  name: string;
  marketplace: string;
  source: PluginMarketplaceCatalogSource;
  sourceEffect?: { availability: "locally-observable" | "unavailable-from-direct-url-catalog"; lexicalPath?: string; provenance: PluginMarketplaceFieldProvenance };
  release?: { kind: "version" | "revision" | "source-sha"; value: string; provenance: PluginMarketplaceFieldProvenance; evidence?: "fixture-derived-unverified" };
  version?: string;
  revision?: string;
  revisionEvidence?: "fixture-derived-unverified";
  description?: string;
  fieldProvenance: Readonly<Record<string, PluginMarketplaceFieldProvenance>>;
  strict: boolean;
  strictDeclaration: { value: boolean; presence: "explicit" | "default"; provenance: PluginMarketplaceFieldProvenance };
  defaultEnabled: boolean;
  defaultEnabledDeclaration: { value: boolean; presence: "explicit" | "default"; provenance: PluginMarketplaceFieldProvenance };
  components: Readonly<PluginMarketplaceComponentMap>;
  unsupportedComponents?: readonly PluginMarketplaceUnsupportedComponentObservation[];
  dependencies: PluginMarketplaceDependency[];
  userConfig?: PluginMarketplaceSafeShape & { provenance: PluginMarketplaceFieldProvenance };
  provenance: PluginMarketplaceProvenance & { catalogPath: string; entryIndex: number };
  runtimeEffect: "declared-not-effective";
}

export interface PluginMarketplaceAllowlistObservation {
  marketplace: string;
  allowedMarketplace: string;
  provenance: PluginMarketplaceFieldProvenance;
}

export interface PluginMarketplaceRename {
  marketplace: string;
  from: string;
  declaredTarget: string | null;
  currentIdentity: string | null;
  status: "current" | "removed" | "cycle" | "dangling" | "indeterminate-because-evidence-omitted";
  fieldProvenance: PluginMarketplaceFieldProvenance;
  provenance: PluginMarketplaceProvenance & { catalogPath: string };
  runtimeEffect: "declared-not-effective";
}

export interface PluginMarketplaceConflictObservation {
  identity: string;
  winner: PluginMarketplaceFieldProvenance;
  loser: PluginMarketplaceFieldProvenance;
  posture: "observed-conflict-not-effective";
}

export interface PluginMarketplacePolicyObservation {
  kind: "strict" | "blocked";
  descriptor?: PluginMarketplacePolicyDescriptor;
  descriptorProvenance?: PluginMarketplaceFieldProvenance;
  provenance: PluginMarketplaceProvenance;
  validScope: boolean;
  match: boolean | "indeterminate-because-evidence-omitted" | "indeterminate-unsupported-regex-subset" | "indeterminate-redacted-descriptor";
  emptyLockdown?: boolean;
  posture: "claude-lifecycle-observation-not-enforced";
}

export interface PluginMarketplaceState {
  registrations: PluginMarketplaceRegistration[];
  selectedRegistrations: PluginMarketplaceRegistration[];
  catalogs: PluginMarketplaceCatalogObservation[];
  entries: PluginMarketplaceCatalogEntry[];
  dependencies: PluginMarketplaceDependency[];
  allowlists: PluginMarketplaceAllowlistObservation[];
  renames: PluginMarketplaceRename[];
  policies: PluginMarketplacePolicyObservation[];
  conflicts: PluginMarketplaceConflictObservation[];
  diagnostics: Diagnostic[];
  omissions: {
    registrations: number;
    selectedRegistrations: number;
    entries: number;
    components: number;
    dependencies: number;
    renames: number;
    policies: number;
    allowlists: number;
    metadata: number;
    userConfig: number;
    conflicts: number;
    diagnostics: number;
  };
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
// Skills
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
// Agents
// ---------------------------------------------------------------------------

/** Recursively immutable view used for normalized configuration crossing runtime seams. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type AgentMcpScope = "user" | "project";

/** Valid normalized entry retained for later admission, without a parallel diagnostic path. */
export type NormalizedAgentMcpEntry = Omit<
  import("./claude/mcp-config.js").RawMcpEntry,
  "diagnostics" | "skipped"
> & { skipped: false };

export type AgentMcpItem =
  | { readonly kind: "reference"; readonly name: string }
  | {
      readonly kind: "inline";
      readonly name: string;
      readonly entry: DeepReadonly<NormalizedAgentMcpEntry>;
    };

/** Safe structured ownership parallel to an agent MCP diagnostic string. */
export type AgentMcpDiagnosticOwnership =
  | { readonly kind: "server"; readonly serverName: string }
  | { readonly kind: "unowned"; readonly itemIndex?: number };

/** Parsed agent frontmatter only; the declaration itself confers neither admission nor runtime ownership. */
export interface AgentMcpDeclaration {
  readonly scope: AgentMcpScope;
  readonly items: readonly AgentMcpItem[];
  readonly diagnostics: readonly string[];
  readonly diagnosticOwnership: readonly AgentMcpDiagnosticOwnership[];
}

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
   * background even when the Agent tool call omits `run_in_background`.
   */
  background?: boolean;
  initialPrompt?: string;
  metadata: Record<string, unknown>;
  /** Parsed but deferred memory configuration. */
  memory?: unknown;
  /** Inert lexical/reporting evidence; runtime code must consume agentMcp instead. */
  mcpServers?: unknown;
  /** Effective immutable MCP declaration for user- and project-defined agents only. */
  agentMcp?: AgentMcpDeclaration;
  hooks?: HookConfig;
  /** System prompt body. Loaded eagerly (agent bodies are the routing/system surface). */
  body: string;
  source: SourceRef;
  /** True for the code-constructed built-in agents (general-purpose, Explore, Plan). */
  builtin?: boolean;
  /**
   * Skip CLAUDE.md/project-instructions and rules in the subagent system prompt
   * (Claude's Explore/Plan context trimming).
   */
  skipProjectContext?: boolean;
  unknownKeys: string[];
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Rules
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
// CLAUDE.md
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
// Hooks
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
  /** Trusted installed identity, stamped by a plugin-aware parser context. */
  pluginId?: string;
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
  /** Event-specific block (exit 2, decision:block, or permissionDecision deny). */
  block: boolean;
  blockReason?: string;
  /** Universal hook stop (`continue:false`), independent of whether the event is blockable. */
  stop?: boolean;
  stopReason?: string;
  /** ask decisions are logged-allowed by PiCC's single default-permissive posture, but surfaced. */
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
// Settings
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

export interface EffectivePluginEnablement {
  enabled: boolean;
  scope: Scope;
  source: string;
}

export interface PluginMarketplaceSettingsDescriptorObservation {
  descriptor?: PluginMarketplaceRegistrationSource | PluginMarketplacePolicyDescriptor;
  /** Exact credential-free validated-field key; absent for rejected or indeterminate evidence. */
  matchKey?: string;
  validity: "valid" | "redacted" | "invalid";
  indeterminate?: "credential-bearing-or-ambiguous" | "unsupported-regex-subset";
}

export interface PluginMarketplaceSettingsContribution {
  scope: Scope;
  sourcePath: string;
  extraKnownMarketplaces?: Record<string, PluginMarketplaceSettingsDescriptorObservation>;
  strictKnownMarketplaces?: PluginMarketplaceSettingsDescriptorObservation[];
  blockedMarketplaces?: PluginMarketplaceSettingsDescriptorObservation[];
}

export interface PluginMarketplaceSettingsOmissions {
  contributions: number;
  declarations: number;
}

export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;

export interface RetentionCleanupBlocker {
  reason: "unreadable-source" | "malformed-source" | "non-object-source" | "invalid-period";
  source: string;
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
  /** Auto memory read side: default true; env CLAUDE_CODE_DISABLE_AUTO_MEMORY overrides. */
  autoMemoryEnabled?: boolean;
  /** Overrides the default `<userDir>/projects/<flattened>/memory` auto-memory directory. */
  autoMemoryDirectory?: string;
  /** Managed-settings `claudeMd` key: inline CLAUDE.md content (managed scope only). */
  managedClaudeMd?: { content: string; source: string };
  worktree: WorktreeSettings;
  cleanupPeriodDays?: number;
  /** False when retention-relevant source uncertainty or an invalid cleanup period makes deletion unsafe. */
  retentionCleanupAllowed?: boolean;
  /** Deduplicated structured reasons destructive retention housekeeping is blocked. */
  retentionCleanupBlockers?: RetentionCleanupBlocker[];
  apiKeyHelper?: string;
  /** Subagent controls. */
  subagentsEnabled: boolean;
  subagentMaxDepth: number;
  subagentConcurrency: number;
  /** Compatibility projection only; enablement does not authorize an installation root. */
  enabledPlugins: Record<string, boolean> | undefined;
  /** Effective exact qualified-ID values with their winning settings provenance. */
  effectivePluginEnablement?: Record<string, EffectivePluginEnablement>;
  /** Marketplace declarations stay per-file so policy scope and provenance remain observable. */
  pluginMarketplaceSettings?: PluginMarketplaceSettingsContribution[];
  pluginMarketplaceSettingsOmissions?: PluginMarketplaceSettingsOmissions;
  /**
   * Scope-tagged MCP contributions, one entry per settings file that carries
   * any of the four MCP keys (never merged across scopes — the enablement gate
   * in discovery/mcp.ts resolves them). Always populated by loadSettings;
   * optional only so hand-built test literals stay valid.
   */
  mcpSettings?: McpSettingsEntry[];
  /** Every key we did not recognize, with the scope it came from (compat report). */
  unknownKeys: Array<{ key: string; scope: Scope }>;
  /** Keys recognized but gating deferred subsystems (compat report). */
  deferredKeys: Array<{ key: string; scope: Scope }>;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// MCP servers (config discovery — consumed by discovery, runtime, registry)
// ---------------------------------------------------------------------------

/**
 * One settings file's MCP contribution, captured scope-tagged and NEVER
 * field-merged across scopes: the enablement gate needs to know which scope
 * each value came from (project-scope approvals are ignored, and a git-tracked
 * `settings.local.json` is demoted to project scope at assembly time).
 */
export interface McpSettingsEntry {
  scope: Scope;
  /** Absolute path of the settings file this entry came from. */
  sourcePath: string;
  /** Raw `mcpServers` block (null-prototype copy; entries stay unparsed here). */
  servers?: Record<string, unknown>;
  enableAllProjectMcpServers?: boolean;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
}

export type McpPolicyAuthority =
  | "user-controlled"
  | "administrator-controlled"
  | "mixed";

export type McpPolicyRemediation =
  | "repair-user-policy"
  | "repair-administrator-policy"
  | "repair-mixed-policy";

/** Presence-preserving projection of one settings file's MCP policy fields. */
export interface McpPolicySettingsEntry {
  scope: Scope;
  /** Internal provenance only; decisions and reports never expose it. */
  sourcePath: string;
  /** Stable order within the settings precedence sequence. */
  order: number;
  /** False only for a defensive projection whose whole non-managed file failed strict validation. */
  valid: boolean;
  allowedMcpServers?: unknown;
  deniedMcpServers?: unknown;
  allowManagedMcpServersOnly?: unknown;
}

/** Applicable managed input that was present but could not be safely consumed. */
export interface McpPolicySourceFailure {
  kind: "malformed" | "unreadable" | "omitted";
  sourceClass: ManagedPolicySourceClass;
  authority: McpPolicyAuthority;
  remediation: McpPolicyRemediation;
}

export type McpPolicyPosture =
  | "absent"
  | "active-rules"
  | "managed-only"
  | "exclusive"
  | "exclusive-empty"
  | "fail-closed";

export type McpPolicyObservation =
  | "invalid-managed-allow-active-empty"
  | "invalid-managed-deny-dropped"
  | "invalid-managed-only-treated-true"
  | "invalid-non-managed-projection"
  | "invalid-rule-stripped"
  | "unset-environment-variable"
  | "allow-over-limit-active-empty"
  | "restrictive-material-omitted"
  | "source-failure-fail-closed"
  | "compiler-uncertainty-fail-closed"
  | "candidate-over-limit-blocked"
  | "identity-ambiguity-blocked";

export type McpPolicyRule =
  | { serverName: string }
  | { serverUrl: string }
  | { serverCommand: readonly string[] };

export type McpCandidateSourceKind =
  | McpSourceClass
  | "plugin"
  | "subagent-inline"
  | "explicit-runtime";

export interface RawMcpPolicyCandidate {
  name: string;
  source: McpCandidateSourceKind;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: readonly string[];
  url?: string;
  identityAmbiguous?: boolean;
}

export type McpAdmissionReason =
  | "allowed"
  | "denied"
  | "allow-miss"
  | "managed-only"
  | "exclusive-control"
  | "fail-closed"
  | "candidate-invalid";

export interface McpAdmissionDecision {
  status: "allowed" | "blocked";
  reason: McpAdmissionReason;
  authority: McpPolicyAuthority;
  observations: readonly McpPolicyObservation[];
}

export interface CompiledMcpPolicy {
  readonly posture: McpPolicyPosture;
  readonly authority: McpPolicyAuthority;
  readonly observations: readonly McpPolicyObservation[];
  /** Bounded, value-redacted evidence retained for status and diagnostics. */
  readonly failures: readonly Readonly<McpPolicySourceFailure>[];
  /** Opaque immutable compiler state; consumers use evaluateMcpPolicy(). */
  readonly compiled: unknown;
}

export type McpServerStatus =
  | "enabled"
  | "pending-approval"
  | "disabled"
  | "blocked"
  | "skipped"
  | "not-configured";

export type McpSourceClass =
  | "native-local"
  | "project-mcpjson"
  | "native-user"
  | "settings-managed"
  | "settings-local"
  | "settings-project"
  | "settings-user"
  | "managed-mcp";

export type ClaudeProfileSource = "explicit" | "picc-override" | "claude-config" | "default";

export type McpPolicyInactiveReason =
  | "policy-denied"
  | "policy-allow-miss"
  | "policy-managed-only"
  | "policy-candidate-invalid";

export type McpInactiveReason =
  | "mcpjson-unapproved"
  | "mcpjson-rejected"
  | "native-runtime-disabled";

interface ResolvedMcpServerCommon {
  name: string;
  /** Resolver output uses a fixed source class, never a native state path or project identity. */
  source: McpSourceClass;
  /** Per-server tool-call timeout, validated >= 1000 ms. */
  timeoutMs?: number;
  /** Safe per-server findings; expanded URL/header values never enter diagnostics. */
  diagnostics: string[];
}

export interface InactiveResolvedMcpServer extends ResolvedMcpServerCommon {
  status: Exclude<McpServerStatus, "enabled" | "blocked">;
  inactiveReason?: McpInactiveReason;
  /** Safe transport identity only; malformed or unknown shapes omit it. */
  transport?: "stdio" | "http" | "sse";
  /** Original remote type alias, safe to display. */
  configuredType?: "http" | "streamable-http" | "sse";
}

export interface PolicyBlockedResolvedMcpServer extends ResolvedMcpServerCommon {
  status: "blocked";
  inactiveReason: McpPolicyInactiveReason;
  transport?: "stdio" | "http" | "sse";
  configuredType?: "http" | "streamable-http" | "sse";
}

export interface EnabledStdioMcpServer extends ResolvedMcpServerCommon {
  status: "enabled";
  transport: "stdio";
  /** Expanded (`${VAR}` / `${VAR:-default}`). */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Pre-expansion command, for display (never print expanded values). */
  rawCommand: string;
}

export interface EnabledRemoteMcpServer extends ResolvedMcpServerCommon {
  status: "enabled";
  transport: "http" | "sse";
  configuredType: "http" | "streamable-http" | "sse";
  /** Secret-bearing expanded endpoint; never use on diagnostics/status surfaces. */
  url: string;
  /** Secret-bearing expanded static headers. */
  headers: Record<string, string>;
  sseDeprecation?: { deprecated: true; replacement: "http" };
}

export type ResolvedMcpServer =
  | InactiveResolvedMcpServer
  | PolicyBlockedResolvedMcpServer
  | EnabledStdioMcpServer
  | EnabledRemoteMcpServer;

export interface ResolvedMcpConfig {
  /** Every selected server, all statuses. */
  servers: ResolvedMcpServer[];
  /** Config-level findings (malformed file, ignored project-scope approvals). */
  diagnostics: string[];
  /** Explicit acquisition authority that made all MCP inactive. */
  failClosed?: "native-state-unusable" | "administration-recovery-pending";
  /** Fixed provenance for safe fail-closed repair guidance; never a resolved path. */
  failClosedProfile?: ClaudeProfileSource;
  /** Optional for legacy/test literals; policy-aware resolver outputs always populate it. */
  policyPosture?: McpPolicyPosture;
  policyAuthority?: McpPolicyAuthority;
  policyObservations?: readonly McpPolicyObservation[];
  /** Bounded value-redacted compiler failure evidence. */
  policyFailures?: readonly Readonly<McpPolicySourceFailure>[];
  /** True only when discovery established that ordinary sources were suppressed. */
  policyOrdinarySourcesSuppressed?: boolean;
  /** Resolver-owned, immutable declaration/review projection. */
  administration?: import("./mcp-administration/model.js").McpAdministrationTrace;
}

interface ResolvedAgentMcpServerCommon {
  readonly name: string;
  readonly source: "subagent-inline";
  readonly timeoutMs?: number;
  readonly diagnostics: readonly string[];
}

export interface InactiveResolvedAgentMcpServer extends ResolvedAgentMcpServerCommon {
  readonly status: Exclude<McpServerStatus, "enabled">;
  readonly inactiveReason?: McpInactiveReason | McpPolicyInactiveReason | "admission-unavailable";
  readonly transport?: "stdio" | "http" | "sse";
  readonly configuredType?: "http" | "streamable-http" | "sse";
}

export interface EnabledStdioAgentMcpServer extends ResolvedAgentMcpServerCommon {
  readonly status: "enabled";
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly rawCommand: string;
}

export interface EnabledRemoteAgentMcpServer extends ResolvedAgentMcpServerCommon {
  readonly status: "enabled";
  readonly transport: "http" | "sse";
  readonly configuredType: "http" | "streamable-http" | "sse";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly sseDeprecation?: { readonly deprecated: true; readonly replacement: "http" };
}

/** Distinct agent-local result; it never enters ordinary MCP source/reporting unions. */
export type ResolvedAgentMcpServer =
  | InactiveResolvedAgentMcpServer
  | EnabledStdioAgentMcpServer
  | EnabledRemoteAgentMcpServer;

export interface ResolvedAgentMcpConfig {
  readonly servers: readonly ResolvedAgentMcpServer[];
  readonly diagnostics: readonly string[];
  readonly diagnosticOwnership: readonly AgentMcpDiagnosticOwnership[];
  /** Present when the caller supplies the owning agent identity. */
  readonly administration?: import("./mcp-administration/model.js").McpAdministrationTrace;
}

/** Project-captured authority for resolving one declaration into unstarted configuration. */
export interface AgentMcpAdmissionContext {
  readonly resolve: (declaration: AgentMcpDeclaration) => ResolvedAgentMcpConfig;
  readonly resolveOwned?: (
    declaration: AgentMcpDeclaration,
    owner: import("./mcp-administration/model.js").McpAgentOwner,
  ) => ResolvedAgentMcpConfig;
}

// ---------------------------------------------------------------------------
// Permission matching
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
// Capability registry
// ---------------------------------------------------------------------------

export type SupportTier =
  | "full"
  | "partial"
  | "degraded-noop"
  | "not-supported"
  | "na";

export type CapabilityEvidenceQuality =
  | "documented"
  | "observed"
  | "inferred"
  | "unverified";

export interface CapabilityEvidence {
  quality: CapabilityEvidenceQuality;
  /** Non-empty concise description of the evidence source. */
  source: string;
  /** ISO date when the evidence was reviewed. */
  reviewed?: string;
}

export interface CapabilityEntry {
  /** e.g. "skill.frontmatter.context", "hook.event.PreToolUse", "tool.WebFetch", "setting.permissions.ask" */
  id: string;
  kind: "artifact" | "frontmatter" | "tool" | "hook-event" | "setting" | "feature";
  tier: SupportTier;
  /** True when the divergence is safety-relevant (something restricted now runs freely). */
  safetyRelevant?: boolean;
  evidence?: readonly CapabilityEvidence[];
  related?: readonly string[];
  note: string;
}

// ---------------------------------------------------------------------------
// Project model (assembled by discovery)
// ---------------------------------------------------------------------------

export interface ClaudeProject {
  /** Repo root (or cwd when not in a repo). */
  root: string;
  /** Effective cwd used for this project assembly. */
  cwd: string;
  userDir: string; // ~/.claude
  settings: ClaudeSettings;
  skills: ClaudeSkill[];
  agents: ClaudeAgent[];
  rules: ClaudeRule[];
  claudeMd: ClaudeMdFile[];
  /**
   * Resolved MCP server configuration (pure data — processes are the runtime's job).
   * Always populated by loadClaudeProject (required on LoadedProject);
   * optional only so hand-built test literals stay valid.
   */
  mcp?: ResolvedMcpConfig;
  /** Optional so hand-built project fixtures remain source-compatible. */
  agentMcpAdmission?: AgentMcpAdmissionContext;
  diagnostics: Diagnostic[];
}

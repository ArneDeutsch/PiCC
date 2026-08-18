/**
 * Compatibility report — derived from the capability registry so `/doctor` and
 * the generated matrix share the same support claims. buildCompatReport() scans
 * the assembled project; renderDoctorReport() gives a project-specific report.
 */
import path from "node:path";
import type {
  CapabilityEntry,
  ClaudeProject,
  Diagnostic,
  HookConfig,
  McpSourceClass,
  McpPolicyAuthority,
  McpPolicyInactiveReason,
  McpPolicyObservation,
  McpPolicySourceFailure,
  ClaudeProfileSource,
  PluginResolutionOutcome,
  PluginResolutionStatus,
  PluginSharedStateCause,
  ResolvedMcpConfig,
} from "../types.js";
import { DEFAULT_CLEANUP_PERIOD_DAYS, SUPPORTED_HOOK_EVENTS } from "../types.js";
import { modelSupportsImages } from "../util/model.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import type { ResolvedCompactionConfig } from "../runtime/steering.js";
import { projectPluginInventoryDoctor, type PluginInventoryDoctorProjection } from "../runtime/plugin-inventory-text.js";
import type { PluginInventorySnapshot } from "../plugin-inventory.js";
import {
  CAPABILITY_REGISTRY,
  CLAUDE_BASELINE,
  PROACTIVE_COMPACTION_APIS,
  isProactiveCompactionApi,
  capabilityForToolName,
  lookupCapability,
} from "./capability-registry.js";

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

export interface CompatFinding {
  capability: CapabilityEntry;
  /** Where/why the project triggered this, e.g. `permissions.ask rule "Bash(rm *)"`. */
  evidence: string;
}

export interface PluginPosture {
  counts: Partial<Record<PluginResolutionStatus, number>>;
  /** Bounded actionable outcome descriptions; loaded/disabled remain summary-only. */
  details: string[];
  omitted: number;
}

export interface CompatReport {
  /** Functionality findings (a declared feature simply won't work). */
  findings: CompatFinding[];
  /** Safety-relevant findings (something restricted now runs freely). */
  safetyFindings: CompatFinding[];
  /** Inputs unknown at the baseline — surfaced as unassessed. */
  unassessed: string[];
  /** Legacy normalized posture for project models predating the inventory seam. */
  pluginPosture?: PluginPosture;
  /** Structured projection of the immutable captured plugin inventory. */
  pluginInventory?: PluginInventoryDoctorProjection;
  /** Bounded point-of-use plugin failures known not to have executed. */
  pluginRuntimeFindings?: string[];
  /** Distinct runtime findings omitted after the retained cap. */
  pluginRuntimeFindingsOmitted?: number;
  /** The fingerprint counter saturated, so the omitted count is a lower bound. */
  pluginRuntimeFindingsOmittedAtLeast?: boolean;
  /**
   * Pending-approval MCP servers, as one bounded terminal-safe line for the
   * session-start `ctx.ui.notify(...)`. Pending servers are ACTIONABLE STATE,
   * not a compat finding, so this survives the otherwise-quiet startup; the
   * bounded enable/decline guidance lives in the human-facing reports.
   */
  mcpPendingNotice?: string;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const SUPPORTED_EVENT_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_HOOK_EVENTS);
const MCP_TOOL_BLOCKING_EVENT_SET: ReadonlySet<string> = new Set<string>([
  "PreToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "WorktreeCreate",
] satisfies readonly (typeof SUPPORTED_HOOK_EVENTS)[number][]);

function hookHandlerCapabilityId(type: string, effectiveEvent: string): string {
  return type === "mcp_tool" && MCP_TOOL_BLOCKING_EVENT_SET.has(effectiveEvent)
    ? "feature.hook-handler.mcp_tool-blocking-enforcement"
    : `feature.hook-handler.${type}`;
}

/** Deferred settings key with no dedicated registry entry: recognized, degrades. */
function deferredSettingCapability(key: string): CapabilityEntry {
  return (
    lookupCapability(`setting.${key}`) ?? {
      id: `setting.${key}`,
      kind: "setting",
      tier: "degraded-noop",
      note: "recognized key gating a deferred subsystem — parsed, no-op",
    }
  );
}

/** Map a non-supported hook event name to a registry entry, or undefined when unassessed. */
function degradedHookEventCapability(event: string): CapabilityEntry | undefined {
  const exact = lookupCapability(`hook.event.${event}`);
  if (exact) return exact;
  // MCP elicitation events come in server-specific spellings; fold them onto
  // the wildcard registry entry.
  if (/elicit/i.test(event) || /^mcp/i.test(event)) {
    return lookupCapability("hook.event.mcp__elicitation");
  }
  return undefined;
}

const PLUGIN_STATUS_ORDER: readonly PluginResolutionStatus[] = [
  "loaded",
  "disabled",
  "enabled-but-uninstalled",
  "unsupported",
  "ambiguous",
  "blocked",
  "malformed",
  "rejected",
];
const PLUGIN_POSTURE_DETAIL_MAX = 20;
const PLUGIN_SHARED_STATE_ORDER = [
  "installed-state-unreadable",
  "installed-state-malformed",
  "installed-state-unsupported",
  "blocklist-unreadable",
  "blocklist-malformed",
] as const satisfies readonly PluginSharedStateCause[];
const CANONICAL_REFRESH_ACTION = "run the canonical /reload in the interactive TUI or exit and relaunch PiCC";
const PLUGIN_REFRESH_ACTION = "run /reload-plugins in the interactive TUI or start a new PiCC session";
const PLUGIN_OWNERSHIP_ACTION = `Inspect exact ownership with /plugin details <qualified identity>, then use the applicable focused action or picc plugin --help for exact PiCC-owned changes, or repair imported state through Claude Code; afterward, ${PLUGIN_REFRESH_ACTION}.`;
const PLUGIN_SHARED_STATE_DETAILS: Readonly<Record<PluginSharedStateCause, string>> = {
  "installed-state-unreadable": `Installed plugin state is unreadable; all enabled plugins were rejected and no fallback content loaded. Check access and permissions for plugins/installed_plugins.json relative to the active Claude user directory, then ${PLUGIN_REFRESH_ACTION}.`,
  "installed-state-malformed": `Installed plugin state is malformed; all enabled plugins were rejected and no fallback content loaded. Repair or regenerate plugins/installed_plugins.json through Claude Code, then ${PLUGIN_REFRESH_ACTION}.`,
  "installed-state-unsupported": `Installed plugin state uses an unsupported format; all enabled plugins were rejected and no fallback content loaded. Update PiCC or contact PiCC support for this format, then ${PLUGIN_REFRESH_ACTION}.`,
  "blocklist-unreadable": `The qualified plugin blocklist is unreadable; all enabled plugins were rejected and no fallback content loaded. Check access and permissions for plugins/blocklist.json relative to the active Claude user directory, then ${PLUGIN_REFRESH_ACTION}.`,
  "blocklist-malformed": `The qualified plugin blocklist is malformed; all enabled plugins were rejected and no fallback content loaded. Repair plugins/blocklist.json so it is a valid JSON object, its optional plugins field is an array, and each entry's plugin field is a qualified name@marketplace identity, then ${PLUGIN_REFRESH_ACTION}.`,
};
const INSTALLED_STATE_CAUSES: ReadonlySet<PluginSharedStateCause> = new Set([
  "installed-state-unreadable",
  "installed-state-malformed",
  "installed-state-unsupported",
]);
const BLOCKLIST_CAUSES: ReadonlySet<PluginSharedStateCause> = new Set([
  "blocklist-unreadable",
  "blocklist-malformed",
]);
const ADMINISTRATOR_POLICY_SOURCE_CLASSES = new Set([
  "system-file",
  "system-drop-in",
]);

function managedPolicySourceLabel(sourceClass: unknown): string {
  if (typeof sourceClass === "string" && ADMINISTRATOR_POLICY_SOURCE_CLASSES.has(sourceClass)) {
    return `Administrator policy (${sourceClass})`;
  }
  if (sourceClass === "override") return "Managed-settings override";
  return "Managed-policy source";
}

function managedPolicyImpactLabel(impact: unknown): string {
  if (impact === "source-ignored") return "; that source was ignored";
  return "; policy processing was degraded";
}

function safePluginIdentity(value: unknown): string {
  if (typeof value !== "string") return "unknown qualified identity";
  return mcpStatusScalar(value, 128) || "unknown qualified identity";
}

type PluginDiagnosticClass =
  | "path validation"
  | "unreadable content"
  | "wrong component kind"
  | "malformed content"
  | "unsupported component content"
  | "component limitation";

function pluginDiagnosticClass(diagnostics: readonly Diagnostic[]): PluginDiagnosticClass | undefined {
  const text = diagnostics
    .map((item) => typeof item?.message === "string" ? item.message.toLowerCase() : "")
    .join("\n");
  if (/wrong[- ]kind|not a (?:regular )?file|not a directory/.test(text)) return "wrong component kind";
  if (/unreadable|cannot read|access/.test(text)) return "unreadable content";
  if (/path|filesystem|root|escape|mismatch|integrity/.test(text)) return "path validation";
  if (/malformed|not a valid|no description/.test(text)) return "malformed content";
  if (/unsupported|not allowed|ignored|forbidden/.test(text)) return "unsupported component content";
  return diagnostics.length > 0 ? "component limitation" : undefined;
}

function rejectedPluginAction(): string {
  return PLUGIN_OWNERSHIP_ACTION;
}

function loadedPluginLimitation(
  reason: PluginDiagnosticClass,
  diagnostics: readonly Diagnostic[],
): { effect: string; action: string } {
  switch (reason) {
    case "unreadable content":
    case "wrong component kind":
      return {
        effect: "some declared content was skipped",
        action: PLUGIN_OWNERSHIP_ACTION,
      };
    case "path validation":
      return {
        effect: "some declared content was skipped",
        action: PLUGIN_OWNERSHIP_ACTION,
      };
    case "malformed content":
      return {
        effect: "some declared content was ignored",
        action: PLUGIN_OWNERSHIP_ACTION,
      };
    case "unsupported component content": {
      const wasStripped = diagnostics.some((item) =>
        typeof item?.message === "string" && /stripp|removed/i.test(item.message)
      );
      return {
        effect: `some declared content was ${wasStripped ? "stripped" : "ignored"}`,
        action: PLUGIN_OWNERSHIP_ACTION,
      };
    }
    case "component limitation":
      return {
        effect: "some declared content was degraded",
        action: PLUGIN_OWNERSHIP_ACTION,
      };
  }
}

function pluginOutcomeDetail(outcome: PluginResolutionOutcome): string | undefined {
  const id = safePluginIdentity(outcome.pluginId);
  switch (outcome.status) {
    case "loaded":
    case "disabled":
      return undefined;
    case "enabled-but-uninstalled":
      return `${id}: enabled but no applicable installed record was selected; no fallback content loaded. ${PLUGIN_OWNERSHIP_ACTION}`;
    case "unsupported":
      return `${id}: installed-state format is unsupported; no fallback content loaded. ${PLUGIN_OWNERSHIP_ACTION}`;
    case "ambiguous":
      return `${id}: highest-scope installed records are ambiguous; no fallback content loaded. ${PLUGIN_OWNERSHIP_ACTION}`;
    case "blocked":
      return `${id}: listed in the qualified plugin blocklist; no fallback content loaded. ${PLUGIN_OWNERSHIP_ACTION}`;
    case "malformed":
      return `${id}: plugin installed-state or blocklist data is malformed; no fallback content loaded. ${PLUGIN_OWNERSHIP_ACTION}`;
    case "rejected": {
      const reason = pluginDiagnosticClass(Array.isArray(outcome.diagnostics) ? outcome.diagnostics : []);
      return `${id}: installed content was rejected${reason ? ` (${reason})` : ""}; no fallback content loaded. ${rejectedPluginAction()}`;
    }
  }
}

function validatedSharedStateCauses(
  value: unknown,
  status: PluginResolutionStatus,
): readonly PluginSharedStateCause[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return undefined;
  const causes: PluginSharedStateCause[] = [];
  for (const cause of value) {
    if (typeof cause !== "string" || !Object.hasOwn(PLUGIN_SHARED_STATE_DETAILS, cause)) return undefined;
    causes.push(cause as PluginSharedStateCause);
  }
  if (new Set(causes).size !== causes.length) return undefined;
  if (causes.some((cause, index) =>
    index > 0 && PLUGIN_SHARED_STATE_ORDER.indexOf(cause) <= PLUGIN_SHARED_STATE_ORDER.indexOf(causes[index - 1]!)
  )) return undefined;
  const installedCauses = causes.filter((cause) => INSTALLED_STATE_CAUSES.has(cause));
  const blocklistCauses = causes.filter((cause) => BLOCKLIST_CAUSES.has(cause));
  if (installedCauses.length > 1 || blocklistCauses.length > 1) return undefined;

  const expectedStatus = blocklistCauses[0] === "blocklist-malformed"
    ? "malformed"
    : blocklistCauses[0] === "blocklist-unreadable"
      ? "rejected"
      : installedCauses[0] === "installed-state-unsupported"
        ? "unsupported"
        : installedCauses[0] === "installed-state-malformed"
          ? "malformed"
          : installedCauses[0] === "installed-state-unreadable"
            ? "rejected"
            : undefined;
  return status === expectedStatus ? causes : undefined;
}

function buildPluginPosture(outcomes: readonly PluginResolutionOutcome[]): PluginPosture | undefined {
  if (outcomes.length === 0) return undefined;
  const counts: Partial<Record<PluginResolutionStatus, number>> = {};
  const individualDetails: string[] = [];
  const sharedCauses = new Set<PluginSharedStateCause>();
  for (const raw of outcomes) {
    if (!raw || typeof raw !== "object" || !PLUGIN_STATUS_ORDER.includes(raw.status)) continue;
    counts[raw.status] = (counts[raw.status] ?? 0) + 1;
    const outcomeCauses = validatedSharedStateCauses(raw.sharedStateCauses, raw.status);
    if (outcomeCauses) {
      for (const cause of outcomeCauses) sharedCauses.add(cause);
      continue;
    }
    const detail = pluginOutcomeDetail(raw);
    if (detail) individualDetails.push(detail);
  }
  if (Object.keys(counts).length === 0) return undefined;
  const details = [
    ...PLUGIN_SHARED_STATE_ORDER.filter((cause) => sharedCauses.has(cause)).map((cause) => PLUGIN_SHARED_STATE_DETAILS[cause]),
    ...individualDetails,
  ];
  return {
    counts,
    details: details.slice(0, PLUGIN_POSTURE_DETAIL_MAX),
    omitted: Math.max(0, details.length - PLUGIN_POSTURE_DETAIL_MAX),
  };
}

/**
 * Scan the assembled project for declared-but-not-fully-honored usage.
 * Splits safety-relevant findings from functionality findings; anything not
 * known to the baseline registry lands in `unassessed`.
 */
export function buildCompatReport(project: ClaudeProject): CompatReport {
  const all: CompatFinding[] = [];
  const unassessed: string[] = [];

  const addFinding = (capability: CapabilityEntry, evidence: string) => {
    all.push({ capability, evidence });
  };

  const { settings } = project;
  const assembled = project as ClaudeProject & {
    pluginResolutionOutcomes?: readonly PluginResolutionOutcome[];
    mergedHooks?: HookConfig;
    pluginInventory?: PluginInventorySnapshot;
  };
  const pluginInventory = assembled.pluginInventory === undefined
    ? undefined
    : projectPluginInventoryDoctor(assembled.pluginInventory);
  const normalizedPluginOutcomes = pluginInventory === undefined && Array.isArray(assembled.pluginResolutionOutcomes)
    ? assembled.pluginResolutionOutcomes
    : [];
  const pluginPosture = buildPluginPosture(normalizedPluginOutcomes);

  // --- Installed-plugin selection and activation diagnostics -------------
  const selectionCapability = lookupCapability("feature.plugins-installed-selection");
  const componentCapability = lookupCapability("feature.plugins-content");
  if (selectionCapability && pluginPosture) {
    for (const detail of pluginPosture.details) addFinding(selectionCapability, detail);
    if (pluginPosture.omitted > 0) {
      addFinding(
        selectionCapability,
        `${pluginPosture.omitted} additional plugin detail(s) omitted. Review plugin enablement, installed state, qualified blocklist, and selected plugin content as applicable, then ${PLUGIN_REFRESH_ACTION}.`,
      );
    }
  }
  let componentDetails = 0;
  for (const outcome of normalizedPluginOutcomes) {
    if (!outcome || typeof outcome !== "object" || outcome.status !== "loaded") continue;
    const diagnostics = Array.isArray(outcome.diagnostics) ? outcome.diagnostics : [];
    if (diagnostics.length === 0 || !componentCapability || componentDetails >= PLUGIN_POSTURE_DETAIL_MAX) continue;
    componentDetails += 1;
    const reason = pluginDiagnosticClass(diagnostics) ?? "component limitation";
    const limitation = loadedPluginLimitation(reason, diagnostics);
    addFinding(
      componentCapability,
      `${safePluginIdentity(outcome.pluginId)}: loaded with ${reason}; ${limitation.effect}. ${limitation.action}`,
    );
  }
  if (componentCapability && componentDetails === PLUGIN_POSTURE_DETAIL_MAX) {
    const total = normalizedPluginOutcomes.filter((outcome) =>
      outcome?.status === "loaded" && Array.isArray(outcome.diagnostics) && outcome.diagnostics.length > 0,
    ).length;
    if (total > componentDetails) {
      addFinding(componentCapability, `${total - componentDetails} additional loaded-plugin component limitation(s) omitted.`);
    }
  }

  const inventoryCapability = lookupCapability("feature.plugins-inventory");
  if (pluginInventory !== undefined) {
    if (inventoryCapability) {
      for (const omission of pluginInventory.captureOmissions) {
        if (omission.axis.includes("diagnostic") || omission.axis.includes("evidence")) continue;
        addFinding(inventoryCapability, `${omission.count} captured plugin inventory value(s) omitted on ${omission.axis}.`);
      }
    }
    for (const evidence of pluginInventory.capabilityEvidence) {
      const capability = lookupCapability(evidence.capabilityId);
      const component = evidence.component === undefined ? "" : ` component ${JSON.stringify(evidence.component)}`;
      const rendered = evidence.capabilityId === "agent.frontmatter.mcpServers"
        ? `${evidence.qualifiedIdentity}${component}: plugin-agent mcpServers was removed before runtime construction. Define an equivalent user-scoped agent when no project change is wanted, define a project agent otherwise, or remove the field from the plugin source, then ${PLUGIN_REFRESH_ACTION}.`
        : `${evidence.qualifiedIdentity}${component}: ${evidence.observation}`;
      if (capability) addFinding(capability, rendered);
      else unassessed.push(`plugin capability ${JSON.stringify(evidence.capabilityId)} (${evidence.qualifiedIdentity})`);
    }
    const policyCapability = lookupCapability("feature.managed-policy");
    if (policyCapability) for (const evidence of pluginInventory.managedPolicyEvidence) {
      addFinding(policyCapability, `${evidence.sourceLabel} was ${evidence.condition}; this source was ignored. ${evidence.guidance}, then ${evidence.refreshGuidance}.`);
    }

    const marketplacePolicyDeclarations = new Set<string>();
    for (const observation of assembled.pluginInventory?.policyObservations ?? []) {
      const key = observation.kind === "strict"
        ? "strictKnownMarketplaces"
        : observation.kind === "blocked"
          ? "blockedMarketplaces"
          : undefined;
      if (key === undefined || observation.validScope !== true) continue;
      const scope = ["user", "project", "local", "managed"].includes(observation.provenance.scope ?? "")
        ? observation.provenance.scope
        : "unknown";
      marketplacePolicyDeclarations.add(`${key}\0${scope}`);
    }
    for (const declaration of marketplacePolicyDeclarations) {
      const [key, scope] = declaration.split("\0");
      if (key === undefined) continue;
      const capability = lookupCapability(`setting.${key}`);
      if (capability?.safetyRelevant === true) addFinding(capability, `settings key ${JSON.stringify(key)} (${scope ?? "unknown"} scope)`);
    }
  }

  const enablementCapability = lookupCapability("feature.plugins-enablement");
  const managedPolicyCapability = lookupCapability("feature.managed-policy");
  for (const diagnostic of settings.diagnostics) {
    if (
      pluginInventory === undefined && managedPolicyCapability &&
      (diagnostic.category === "managed-policy-malformed" ||
        diagnostic.category === "managed-policy-unreadable")
    ) {
      const condition = diagnostic.category === "managed-policy-malformed" ? "malformed" : "unreadable";
      const source = managedPolicySourceLabel(diagnostic.sourceClass);
      const impact = managedPolicyImpactLabel(diagnostic.impact);
      addFinding(
        managedPolicyCapability,
        `${source} was ${condition}${impact}. Repair the applicable managed policy input, then ${PLUGIN_REFRESH_ACTION}.`,
      );
      continue;
    }
    const diagnosticMessage = typeof diagnostic.message === "string" ? diagnostic.message : "";
    if (pluginInventory === undefined && enablementCapability && /enabledPlugins|plugin identity/i.test(diagnosticMessage)) {
      const reason = /literal boolean/i.test(diagnosticMessage)
        ? "a non-boolean enablement value was ignored"
        : /not an object/i.test(diagnosticMessage)
          ? "the enablement mapping was not an object and was ignored"
          : /identity/i.test(diagnosticMessage)
            ? "an invalid qualified identity was ignored"
            : "an invalid activation entry was ignored";
      addFinding(
        enablementCapability,
        `Plugin activation settings: ${reason}; no rejected setting authorized fallback content. Use qualified identities with literal booleans, then ${PLUGIN_REFRESH_ACTION}.`,
      );
    }
  }

  // --- Permissions --------------------------------------------------------
  if (settings.permissions.ask.length > 0) {
    const cap = lookupCapability("setting.permissions.ask");
    if (cap) {
      addFinding(
        cap,
        `permissions.ask rules: ${settings.permissions.ask.map((r) => `"${r}"`).join(", ")}`,
      );
    }
  }
  if (settings.permissions.defaultMode !== undefined) {
    const cap = lookupCapability("setting.permissions.defaultMode");
    if (cap) {
      addFinding(cap, `permissions.defaultMode = "${settings.permissions.defaultMode}"`);
    }
  }
  if (settings.permissions.allow.length > 0) {
    const cap = lookupCapability("setting.permissions.allow");
    if (cap) {
      addFinding(cap, `${settings.permissions.allow.length} permissions.allow rule(s) declared`);
    }
  }
  if (settings.permissions.additionalDirectories.length > 0) {
    const cap = lookupCapability("setting.permissions.additionalDirectories");
    if (cap) {
      addFinding(
        cap,
        `${settings.permissions.additionalDirectories.length} permissions.additionalDirectories entry(ies) declared`,
      );
    }
  }

  // --- Settings parsed into typed fields but consumed by nothing ----------
  // These never reach deferredKeys (they parse into ClaudeSettings), so they
  // need direct checks to appear in the report instead of silently vanishing.
  if (settings.model !== undefined) {
    const cap = lookupCapability("setting.model");
    if (cap) addFinding(cap, `model = "${settings.model}"`);
  }
  if (settings.includeCoAuthoredBy !== undefined) {
    const cap = lookupCapability("setting.includeCoAuthoredBy");
    if (cap) addFinding(cap, `includeCoAuthoredBy = ${settings.includeCoAuthoredBy}`);
  }
  if (settings.attribution !== undefined) {
    const cap = lookupCapability("setting.attribution");
    if (cap) addFinding(cap, "attribution configured");
  }
  if (settings.apiKeyHelper !== undefined) {
    const cap = lookupCapability("setting.apiKeyHelper");
    if (cap) addFinding(cap, `apiKeyHelper = "${settings.apiKeyHelper}"`);
  }

  // --- Settings keys ------------------------------------------------------
  for (const { key, scope } of settings.deferredKeys) {
    // permissions.defaultMode has a dedicated check above with better evidence;
    // reporting the deferredKeys entry too would double-report one divergence.
    if (key === "permissions.defaultMode") continue;
    addFinding(deferredSettingCapability(key), `settings key "${key}" (${scope} scope)`);
  }
  for (const { key, scope } of settings.unknownKeys) {
    const capability = lookupCapability(`setting.${key}`);
    if (capability) addFinding(capability, `settings key "${key}" (${scope} scope)`);
    else unassessed.push(`settings key "${key}" (${scope} scope)`);
  }

  // --- Hook configs (settings + skill-scoped) -----------------------------
  // Skill hooks arrive as RAW frontmatter (parseHookConfig normalizes them only at
  // activation), so every shape here is project-controlled input: a single matcher
  // object instead of an array, missing `hooks`, missing handler `type` (defaults
  // to "command"). Scanning must never throw (completeness floor).
  const scanHooks = (
    config: HookConfig | undefined,
    where: string,
    effectiveEventFor: (event: string) => string = (event) => event,
  ) => {
    if (!config || typeof config !== "object") return;
    for (const [declaredEvent, rawMatchers] of Object.entries(config)) {
      const event = effectiveEventFor(declaredEvent);
      const eventEvidence = event === declaredEvent
        ? `"${event}"`
        : `effective "${event}" (declared as agent "${declaredEvent}")`;
      if (!SUPPORTED_EVENT_SET.has(event)) {
        const cap = degradedHookEventCapability(event);
        if (cap) addFinding(cap, `hook event ${eventEvidence} configured in ${where}`);
        else unassessed.push(`hook event ${eventEvidence} (${where})`);
      }
      const matchers: unknown[] = Array.isArray(rawMatchers)
        ? rawMatchers
        : rawMatchers && typeof rawMatchers === "object"
          ? [rawMatchers]
          : [];
      for (const matcher of matchers) {
        if (!matcher || typeof matcher !== "object") continue;
        const handlers = Array.isArray((matcher as { hooks?: unknown }).hooks)
          ? ((matcher as { hooks: unknown[] }).hooks)
          : [];
        for (const handler of handlers) {
          if (!handler || typeof handler !== "object") continue;
          const type = (handler as { type?: string }).type ?? "command";
          if (type === "command") continue;
          const cap = lookupCapability(hookHandlerCapabilityId(type, event));
          if (cap) {
            addFinding(cap, `hook handler type "${type}" on ${eventEvidence} in ${where}`);
          } else {
            unassessed.push(`hook handler type "${type}" on ${eventEvidence} (${where})`);
          }
        }
      }
    }
  };
  scanHooks(settings.hooks, "settings");
  for (const skill of project.skills) {
    scanHooks(skill.hooks, `skill "${skill.name}"`);
  }
  // Plugin hooks are scanned from the already-resolved merged config. The
  // parser-stamped pluginId is trusted evidence; source files are never reopened
  // merely to explain a compatibility finding.
  type PluginHookCandidate =
    | { kind: "finding"; capability: CapabilityEntry; evidence: string }
    | { kind: "unassessed"; evidence: string };
  const PLUGIN_HOOK_CANDIDATE_MAX_PER_CLASS = PLUGIN_POSTURE_DETAIL_MAX * 4;
  const pluginHookCandidates = {
    safety: [] as PluginHookCandidate[],
    ordinary: [] as PluginHookCandidate[],
  };
  const pluginHookFingerprints = {
    safety: new Set<string>(),
    ordinary: new Set<string>(),
  };
  const pluginHookCandidateOverflow = { safety: false, ordinary: false };
  const collectPluginHookCandidate = (
    candidate: PluginHookCandidate,
    fingerprint: string,
    safetyRelevant: boolean,
  ) => {
    const classification = safetyRelevant ? "safety" : "ordinary";
    const fingerprints = pluginHookFingerprints[classification];
    if (fingerprints.has(fingerprint)) return;
    if (fingerprints.size >= PLUGIN_HOOK_CANDIDATE_MAX_PER_CLASS) {
      pluginHookCandidateOverflow[classification] = true;
      return;
    }
    fingerprints.add(fingerprint);
    pluginHookCandidates[classification].push(candidate);
  };
  const addPluginHookFinding = (capability: CapabilityEntry, evidence: string) => {
    collectPluginHookCandidate(
      { kind: "finding", capability, evidence },
      `finding|${capability.id}|${evidence}`,
      capability.safetyRelevant === true,
    );
  };
  const addPluginHookUnassessed = (evidence: string) => {
    collectPluginHookCandidate({ kind: "unassessed", evidence }, `unassessed|${evidence}`, false);
  };
  if (pluginInventory === undefined && assembled.mergedHooks && typeof assembled.mergedHooks === "object") {
    for (const [event, matchers] of Object.entries(assembled.mergedHooks)) {
      if (!Array.isArray(matchers)) continue;
      for (const matcher of matchers) {
        if (!matcher || !Array.isArray(matcher.hooks)) continue;
        for (const handler of matcher.hooks) {
          if (!handler?.pluginId) continue;
          const pluginId = safePluginIdentity(handler.pluginId);
          const safeEvent = mcpStatusScalar(event, 80) || "unknown event";
          if (!SUPPORTED_EVENT_SET.has(event)) {
            const capability = degradedHookEventCapability(event);
            const evidence = `hook event "${safeEvent}" configured by installed plugin "${pluginId}"`;
            if (capability) addPluginHookFinding(capability, evidence);
            else addPluginHookUnassessed(`hook event "${safeEvent}" (installed plugin "${pluginId}")`);
          }
          const type = typeof handler.type === "string" ? handler.type : undefined;
          if (type !== "command") {
            const safeType = type === undefined
              ? "invalid handler type"
              : mcpStatusScalar(type, 80) || "unnamed handler type";
            const capability = type === undefined
              ? undefined
              : lookupCapability(hookHandlerCapabilityId(type, event));
            const evidence = `hook handler type "${safeType}" on "${safeEvent}" from installed plugin "${pluginId}"`;
            if (capability) addPluginHookFinding(capability, evidence);
            else addPluginHookUnassessed(`${evidence} (unassessed)`);
          }
        }
      }
    }
  }
  const selectedPluginHookCandidates = [
    ...pluginHookCandidates.safety,
    ...pluginHookCandidates.ordinary,
  ].slice(0, PLUGIN_POSTURE_DETAIL_MAX);
  for (const candidate of selectedPluginHookCandidates) {
    if (candidate.kind === "finding") addFinding(candidate.capability, candidate.evidence);
    else unassessed.push(candidate.evidence);
  }
  const selectedSafetyCount = Math.min(
    pluginHookCandidates.safety.length,
    PLUGIN_POSTURE_DETAIL_MAX,
  );
  const selectedOrdinaryCount = selectedPluginHookCandidates.length - selectedSafetyCount;
  const omittedSafetyCount = pluginHookCandidates.safety.length - selectedSafetyCount;
  const omittedOrdinaryCount = pluginHookCandidates.ordinary.length - selectedOrdinaryCount;
  if (omittedSafetyCount > 0 || pluginHookCandidateOverflow.safety) {
    const capability = lookupCapability("feature.hook-handler.mcp_tool-blocking-enforcement");
    const lowerBound = omittedSafetyCount + (pluginHookCandidateOverflow.safety ? 1 : 0);
    const qualifier = pluginHookCandidateOverflow.safety ? "At least " : "";
    if (capability) addFinding(capability, `${qualifier}${lowerBound} additional safety-relevant installed-plugin hook limitation(s) omitted.`);
  }
  if (omittedOrdinaryCount > 0 || pluginHookCandidateOverflow.ordinary) {
    const capability = lookupCapability("feature.plugins-hooks");
    const lowerBound = omittedOrdinaryCount + (pluginHookCandidateOverflow.ordinary ? 1 : 0);
    const qualifier = pluginHookCandidateOverflow.ordinary ? "At least " : "";
    if (capability) addFinding(capability, `${qualifier}${lowerBound} additional installed-plugin hook limitation(s) omitted.`);
  }

  // Tool lists (`tools:` on agents, `allowed-tools:` on skills): flag degraded/
  // not-supported names, route unknown names to unassessed.
  const scanToolList = (list: string[] | undefined, where: string, field: string) => {
    for (const rawTool of list ?? []) {
      if (rawTool === "*") continue;
      // `Bash(git *)` gates the Bash tool — assess the tool, not the specifier.
      const tool = rawTool.replace(/\(.*$/s, "").trim();
      if (!tool) continue;
      const known =
        lookupCapability(`tool.${tool}`) ??
        (tool.startsWith("mcp__") ? capabilityForToolName(tool) : undefined);
      if (!known) {
        unassessed.push(`tool "${tool}" (${where} ${field})`);
      } else if (known.tier === "degraded-noop" || known.tier === "not-supported") {
        addFinding(known, `${where} lists tool "${tool}" in ${field}`);
      }
    }
  };

  // --- Agents --------------------------------------------------------------
  let strippedAgentFindingCount = 0;
  let strippedAgentFindingsOmitted = 0;
  let agentMcpFindingCount = 0;
  let agentMcpFindingsOmitted = 0;
  const addAgentMcpFinding = (capability: CapabilityEntry, evidence: string): void => {
    if (agentMcpFindingCount < 32) {
      agentMcpFindingCount += 1;
      addFinding(capability, evidence);
    } else {
      agentMcpFindingsOmitted += 1;
    }
  };
  for (const agent of project.agents) {
    if (pluginInventory === undefined && agent.source.scope === "plugin" && agent.source.pluginId) {
      const pluginId = safePluginIdentity(agent.source.pluginId);
      const component = mcpStatusScalar(agent.name, 128) || "unnamed agent";
      for (const field of ["hooks", "mcpServers", "permissionMode"] as const) {
        if (!agent.diagnostics.some((item) => item.message === `Plugin agent field "${field}" is forbidden and was removed`)) continue;
        const capability = lookupCapability(`agent.frontmatter.${field}`);
        if (capability && strippedAgentFindingCount < PLUGIN_POSTURE_DETAIL_MAX) {
          strippedAgentFindingCount += 1;
          const alternative = field === "hooks"
            ? "Use supported plugin-level hooks, or remove this field; agent-scoped hooks are retained only for non-plugin agents."
            : field === "mcpServers"
              ? `Move the agent to user or project scope, or remove this field; mcpServers is not retained on plugin-provided agents. Then ${PLUGIN_REFRESH_ACTION}.`
              : "Use deny rules and tools gating, or remove this field; plugin agents cannot retain permissionMode.";
          addFinding(
            capability,
            `installed plugin "${pluginId}" agent "${component}": forbidden ${field} was stripped before subagent construction. ${alternative}`,
          );
        } else if (capability) {
          strippedAgentFindingsOmitted += 1;
        }
      }
    }
    if (agent.memory !== undefined) {
      const cap = lookupCapability("agent.frontmatter.memory");
      if (cap) addFinding(cap, `agent "${agent.name}" sets memory:`);
    }
    if (agent.mcpServers !== undefined) {
      const cap = lookupCapability("agent.frontmatter.mcpServers");
      if (cap) {
        const safeAgent = quotedMcpName(agent.name, 128);
        const dispatchBoundary = "Startup health and deterministic cleanup are dispatch-time only and appear in bounded Agent/TaskOutput results; agent-local servers do not appear in parent /mcp live status.";
        if (agent.source.scope === "managed") {
          addAgentMcpFinding(cap, `managed agent ${safeAgent} remains dispatchable, but its mcpServers field is retained only as inert declaration evidence and ignored. Define an equivalent user-scoped agent when no project change is wanted, define a project agent otherwise, or remove the declaration, then ${CANONICAL_REFRESH_ACTION}.`);
        } else if (agent.agentMcp !== undefined) {
          const scope = agent.source.scope === "user" ? "user" : "project";
          const declaration = agent.agentMcp;
          const configuredEnabledSessionNames = new Set((project.mcp?.servers ?? [])
            .filter((server) => server.status === "enabled")
            .map((server) => server.name));
          const declarationDiagnostics = declaration.diagnostics.map((diagnostic, index) => ({
            diagnostic,
            owner: declaration.diagnosticOwnership[index],
          }));
          const dispatchCollisionQualification = " If a same-name main-session route publishes at dispatch time, runtime quietly borrows it and bypasses this inline outcome or diagnostic; publication is dispatch-time and is not known by this static finding.";
          if (declarationDiagnostics.length > 0) {
            const ownedNames = declarationDiagnostics.flatMap(({ owner }) =>
              owner?.kind === "server" ? [owner.serverName] : []
            );
            const attribution = ownedNames.length > 0
              ? ` for ${mcpNameList([...new Set(ownedNames)])}`
              : "";
            const omission = declarationDiagnostics.some(({ diagnostic }) => /omitted/iu.test(diagnostic))
              ? " Some diagnostic detail was omitted by the bounded parser."
              : "";
            const collisionQualification = declarationDiagnostics.some(({ owner }) =>
              owner?.kind === "server" && configuredEnabledSessionNames.has(owner.serverName)
            ) ? dispatchCollisionQualification : "";
            addAgentMcpFinding(cap, `${scope} agent ${safeAgent} has invalid, skipped, or adjusted mcpServers declaration diagnostics${attribution}.${omission}${collisionQualification} ${dispatchBoundary} Inspect the documented list of string references or one-key inline mappings and repair or remove affected items, then ${CANONICAL_REFRESH_ACTION}.`);
          }
          for (const item of declaration.items) {
            if (item.kind === "reference" && !configuredEnabledSessionNames.has(item.name)) {
              addAgentMcpFinding(cap, `${scope} agent ${safeAgent} references MCP server ${quotedMcpName(item.name, 128)}, but that name is absent from the resolved enabled main-session set. ${dispatchBoundary} Configure and enable that main-session server, or remove the reference, then ${CANONICAL_REFRESH_ACTION}.`);
            }
          }

          let inlineConfig;
          try {
            inlineConfig = project.agentMcpAdmission?.resolveOwned?.(declaration, { name: agent.name, scope }) ??
              project.agentMcpAdmission?.resolve(declaration);
          } catch {
            inlineConfig = undefined;
          }
          if (inlineConfig === undefined && declaration.items.some((item) => item.kind === "inline")) {
            addAgentMcpFinding(cap, `${scope} agent ${safeAgent} has inline mcpServers, but static admission is unavailable or threw; inline servers remain inactive. ${dispatchBoundary} Restore valid MCP policy/configuration, then ${CANONICAL_REFRESH_ACTION}.`);
          }
          for (const server of inlineConfig?.servers ?? []) {
            const identity = `inline MCP server ${quotedMcpName(server.name, 128)}`;
            const policyReason = server.status === "blocked"
              ? server.inactiveReason ?? (project.mcp?.policyPosture === "fail-closed"
                ? "policy fail-closed"
                : project.mcp?.policyPosture === "exclusive" || project.mcp?.policyPosture === "exclusive-empty"
                  ? "exclusive managed control"
                  : "policy state unavailable")
              : undefined;
            const guidance = server.status === "blocked"
              ? policyReason === "policy-denied"
                ? `${identity} is blocked by an explicit managed-policy deny; ask the policy owner to remove or narrow the deny, or remove the declaration.`
                : policyReason === "policy-allow-miss"
                  ? `${identity} is blocked because it misses the applicable managed allowlist; ask the policy owner to admit this exact transport identity, or remove the declaration.`
                  : policyReason === "policy-managed-only"
                    ? `${identity} is blocked by managed-only policy; an administrator must define and allow an equivalent managed server identity, or the declaration must be removed.`
                    : policyReason === "policy-candidate-invalid"
                      ? `${identity} is blocked because its candidate identity is invalid or over limit; repair the bounded inline command or URL identity, or remove the declaration.`
                      : policyReason === "exclusive managed control"
                        ? `${identity} is blocked by exclusive managed MCP control; ask the administrator whether an equivalent managed route is appropriate, or remove the declaration.`
                        : policyReason === "policy fail-closed"
                          ? `${identity} is blocked because managed MCP policy is fail closed; the policy owner must repair the authoritative policy, or the declaration must be removed.`
                          : `${identity} is blocked because admission policy state is unavailable; restore the authoritative policy/configuration, or remove the declaration.`
              : server.status === "disabled"
                ? `${identity} was declined by disabledMcpjsonServers; after reviewing the definition, remove its exact name from that list to enable it or remove the declaration.`
                : server.status === "pending-approval"
                  ? `${identity} is pending PiCC project approval; review the definition, then add its exact name to enabledMcpjsonServers in user-controlled settings or add it to disabledMcpjsonServers to decline it.`
                  : server.status === "not-configured"
                    ? `${identity} is not configured with a usable transport; add one supported inline command or URL definition, or remove it.`
                    : server.status === "skipped" && server.inactiveReason === "admission-unavailable"
                      ? `${identity} was skipped because admission is unavailable; restore valid policy/configuration.`
                      : server.status === "skipped"
                        ? `${identity} was skipped because its supported inline definition is invalid; repair its one-key declaration or remove it.`
                        : undefined;
            if (guidance !== undefined) {
              const collisionQualification = configuredEnabledSessionNames.has(server.name)
                ? dispatchCollisionQualification
                : "";
              addAgentMcpFinding(cap, `${scope} agent ${safeAgent}: ${guidance}${collisionQualification} ${dispatchBoundary} Then ${CANONICAL_REFRESH_ACTION}.`);
            }
          }
        }
      }
    }
    if (agent.hooks !== undefined) {
      const cap = lookupCapability("agent.frontmatter.hooks");
      if (cap) addFinding(cap, `agent "${agent.name}" sets hooks:`);
      scanHooks(
        agent.hooks,
        `agent "${agent.name}"`,
        (event) => event === "Stop" ? "SubagentStop" : event,
      );
    }
    if (agent.permissionMode !== undefined) {
      // Safety-relevant no-op: an agent restricting its permission mode still
      // runs default-permissive — never silently.
      const cap = lookupCapability("agent.frontmatter.permissionMode");
      if (cap) {
        addFinding(cap, `agent "${agent.name}" sets permissionMode: "${agent.permissionMode}"`);
      }
    }
    scanToolList(agent.tools, `agent "${agent.name}"`, "tools:");
    for (const key of agent.unknownKeys) {
      unassessed.push(`agent "${agent.name}" frontmatter key "${key}"`);
    }
  }
  if (agentMcpFindingsOmitted > 0) {
    const capability = lookupCapability("agent.frontmatter.mcpServers");
    if (capability) addFinding(capability, `${agentMcpFindingsOmitted} additional agent MCP declaration finding(s) omitted after the 32-finding report bound. Repair or remove the affected mcpServers declarations, or correct the applicable policy, then run the canonical /reload in the interactive TUI or exit and relaunch PiCC.`);
  }
  if (strippedAgentFindingsOmitted > 0) {
    const capability = lookupCapability("feature.plugins-agents");
    if (capability) addFinding(capability, `${strippedAgentFindingsOmitted} additional stripped plugin-agent field finding(s) omitted. Define equivalent user-scoped agents when no project change is wanted, define project agents otherwise, or remove the unsupported fields from the plugin source, then ${PLUGIN_REFRESH_ACTION}.`);
  }

  // --- Skills (allowed-tools + unknown frontmatter) ------------------------
  for (const skill of project.skills) {
    // A skill granting a degraded tool won't get real behavior from it — same
    // check as agent tools:. (disallowed-tools denying a degraded tool is
    // trivially satisfied and needs no finding.)
    scanToolList(skill.allowedTools, `skill "${skill.name}"`, "allowed-tools:");
    for (const key of skill.unknownKeys) {
      unassessed.push(`skill "${skill.name}" frontmatter key "${key}"`);
    }
  }

  // --- Rules (unknown frontmatter) ----------------------------------------
  for (const rule of project.rules) {
    for (const key of rule.unknownKeys) {
      unassessed.push(`rule "${rule.id}" frontmatter key "${key}"`);
    }
  }

  // --- MCP discovery results ----------------------------------------------
  // Discovery-fed, not a filesystem probe: findings mirror what the resolver
  // actually decided. Findings cover ACTIONABLE/DEGRADED states — the pending
  // gate, plus EVERY server's stored diagnostics regardless of status (an
  // enabled server's unset-${VAR} warning or ignored-field notice is degraded
  // state too; a CLEAN enabled server stays posture-line data in /doctor,
  // never a finding). Display hygiene: server names are bounded and quoted;
  // diagnostics are classified without reflecting configuration values.
  const mcp = project.mcp ?? EMPTY_MCP;
  const aggregatePolicyState = mcp.policyPosture === "exclusive-empty" || mcp.policyPosture === "fail-closed";
  const pendingNames = aggregatePolicyState || mcp.policyPosture === "exclusive" ? [] : mcp.servers
    .filter((s) => s.status === "pending-approval")
    .map((s) => s.name);
  if (pendingNames.length > 0) {
    const cap = lookupCapability("feature.mcp-project-approval");
    if (cap) {
      // The one-time session-start notice carries only bounded approval/decline
      // direction; report surfaces carry the complete least-authority guidance.
      addFinding(
        cap,
        `MCP server(s) pending approval: ${mcpNameList(pendingNames)} — ${mcpPendingEditDetail(pendingNames)}`,
      );
    }
  }
  const mcpDiagnosticServers: Array<{
    server: ResolvedMcpConfig["servers"][number];
    priority: number;
    index: number;
  }> = [];
  for (const [index, server] of mcp.servers.entries()) {
    if (server.diagnostics.length === 0 && server.status !== "skipped") continue;
    const priority = server.status === "skipped" || server.status === "pending-approval"
      ? 0
      : server.status === "enabled"
        ? 1
        : 2;
    mcpDiagnosticServers.push({ server, priority, index });
  }
  const selectedMcpServers = mcpDiagnosticServers.length <= MCP_STATUS_DETAIL_MAX
    ? mcpDiagnosticServers
    : [...mcpDiagnosticServers]
        .sort((left, right) => left.priority - right.priority || left.index - right.index)
        .slice(0, MCP_STATUS_DETAIL_MAX);
  for (const { server } of selectedMcpServers) {
    const dedicatedDiagnostics = [
      {
        diagnostic: `MCP server "${server.name}": "oauth" is a deferred feature in PiCC; ignored (server still runs)`,
        capabilityId: "feature.mcp-oauth",
      },
      {
        diagnostic: `MCP server "${server.name}": "alwaysLoad" is a deferred feature in PiCC; ignored (server still runs)`,
        capabilityId: "feature.mcp-server-always-load",
      },
      {
        diagnostic: `MCP server "${server.name}": "role" is a deferred feature in PiCC; ignored (server still runs)`,
        capabilityId: "feature.mcp-server-role",
      },
      {
        diagnostic: `MCP server "${server.name}": field "url" is ignored on a stdio server`,
        capabilityId: "feature.mcp-url-without-type-validation",
      },
    ] as const;
    for (const { diagnostic, capabilityId } of dedicatedDiagnostics) {
      if (!server.diagnostics.includes(diagnostic)) continue;
      const capability = lookupCapability(capabilityId);
      if (capability) {
        const limitation = capabilityId === "feature.mcp-oauth"
          ? '"oauth" is a deferred feature in PiCC; ignored (server still runs)'
          : capabilityId === "feature.mcp-server-always-load"
            ? '"alwaysLoad" is a deferred feature in PiCC; ignored (server still runs)'
            : capabilityId === "feature.mcp-server-role"
              ? '"role" is a deferred feature in PiCC; ignored (server still runs)'
              : 'field "url" is ignored on a stdio server';
        addFinding(
          capability,
          `MCP server ${quotedMcpName(server.name, MCP_STATUS_NAME_MAX)}: ${limitation}`,
        );
      }
    }

    const extractedDiagnostics = new Set<string>(dedicatedDiagnostics.map(({ diagnostic }) => diagnostic));
    const remainingDiagnostics = server.diagnostics.filter(
      (diagnostic) => !extractedDiagnostics.has(diagnostic),
    );
    const safeDiagnostic: string[] = [];
    let hasUnclassifiedDiagnostic = false;
    for (const diagnostic of remainingDiagnostics) {
      const unset = diagnostic.match(/(?:environment variable "([A-Za-z_][A-Za-z0-9_]*)" is not set|references unset environment variable "([A-Za-z_][A-Za-z0-9_]*)")/u);
      const unsetName = unset?.[1] ?? unset?.[2];
      if (unsetName !== undefined) {
        safeDiagnostic.push(`environment variable ${JSON.stringify(unsetName)} is not set and has no default`);
        continue;
      }
      const unknown = diagnostic.match(/unknown field "([A-Za-z_][A-Za-z0-9_-]*)" ignored/u);
      if (unknown) {
        safeDiagnostic.push(`unknown field ${JSON.stringify(unknown[1])} ignored`);
        continue;
      }
      if (/remote transport|WebSocket transport/u.test(diagnostic)) {
        safeDiagnostic.push("remote transport configuration is unsupported or unusable");
        continue;
      }
      hasUnclassifiedDiagnostic = true;
    }
    if (hasUnclassifiedDiagnostic) {
      safeDiagnostic.push("additional configuration issue detected; inspect the server definition, then run /reload or restart PiCC");
    }
    const evidence = remainingDiagnostics.length > 0
      ? `MCP server ${quotedMcpName(server.name, MCP_STATUS_NAME_MAX)}: ${[...new Set(safeDiagnostic)].join("; ")}`
      : server.diagnostics.length === 0 && server.status === "skipped"
        ? `MCP server ${quotedMcpName(server.name, MCP_STATUS_NAME_MAX)} was skipped because its selected definition is invalid; repair it, then run /reload or restart PiCC`
        : undefined;
    if (evidence === undefined) continue;

    const diagnosticText = remainingDiagnostics.join("\n");
    const capabilityId = diagnosticText.includes("WebSocket transport")
      ? "feature.mcp-websocket"
      : diagnosticText.includes("headersHelper")
        ? "feature.mcp-headers-helper"
        : server.transport === "http" || server.transport === "sse"
          ? "feature.mcp-remote-transports"
          : "feature.mcp";
    const capability = lookupCapability(capabilityId);
    if (capability) {
      addFinding(
        capability,
        mcpStatusScalar(evidence, MCP_POSTURE_DIAG_MAX_CHARS),
      );
    }
  }
  const omittedMcpServers = mcpDiagnosticServers.length - selectedMcpServers.length;
  if (omittedMcpServers > 0) {
    const capability = lookupCapability("feature.mcp");
    if (capability) {
      addFinding(
        capability,
        `${omittedMcpServers} additional MCP server diagnostic finding(s) omitted; inspect the MCP configuration for complete detail`,
      );
    }
  }
  // Config diagnostics can originate in hostile files. A finite classifier
  // keeps every known remedy distinct while bounding and redacting the report.
  const mcpCapability = lookupCapability("feature.mcp");
  const mcpRuntimeEnabledCapability = lookupCapability("feature.mcp-runtime-enabled");
  if (mcpCapability) {
    for (const diagnostic of mcp.diagnostics) {
      const capability = diagnostic.includes("enabledMcpServers is unsupported")
        ? mcpRuntimeEnabledCapability
        : mcpCapability;
      if (capability) addFinding(capability, mcpConfigDiagnosticEvidence(diagnostic, mcp));
    }
  }

  // De-duplicate findings (same capability + same evidence) and unassessed.
  const seen = new Set<string>();
  const deduped = all.filter((f) => {
    const key = `${f.capability.id}|${f.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const mcpPendingNotice =
    pendingNames.length > 0 ? buildMcpPendingNotice(pendingNames) : undefined;

  return {
    findings: deduped.filter((f) => f.capability.safetyRelevant !== true),
    safetyFindings: deduped.filter((f) => f.capability.safetyRelevant === true),
    unassessed: [...new Set(unassessed)],
    ...(pluginPosture !== undefined ? { pluginPosture } : {}),
    ...(pluginInventory !== undefined ? { pluginInventory } : {}),
    ...(mcpPendingNotice !== undefined ? { mcpPendingNotice } : {}),
  };
}

// ---------------------------------------------------------------------------
// MCP surfaces — pending notice + status renderer + /doctor posture line
// ---------------------------------------------------------------------------

const EMPTY_MCP: ResolvedMcpConfig = { servers: [], diagnostics: [] };

/** Cap on server names quoted in one list — a hostile config must not flood a line. */
const MCP_NAME_LIST_MAX = 8;
const MCP_PENDING_COPY_NAME_MAX = 128;

/** Bound on a per-server diagnostic quoted on the /doctor posture line. */
const MCP_POSTURE_DIAG_MAX_CHARS = 240;
const MCP_BIDI_FORMATTING_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function quotedMcpName(name: string, max: number): string {
  const bidiSafe = name.replace(MCP_BIDI_FORMATTING_CONTROLS, (control) =>
    `\\u${control.codePointAt(0)!.toString(16).padStart(4, "0").toUpperCase()}`
  );
  return JSON.stringify(mcpStatusScalar(bidiSafe, max) || "(unnamed)");
}

function mcpConfigDiagnosticEvidence(diagnostic: string, mcp: ResolvedMcpConfig): string {
  if (diagnostic.includes("enabledMcpServers is unsupported")) {
    return "Native enabledMcpServers was recognized, but PiCC does not support this enablement capability and the list cannot authorize default-off servers.";
  }
  if (/MCP approvals .*cannot work while .*tracked by git/u.test(diagnostic)) {
    return "MCP approval settings in a tracked local settings file were rejected; stop tracking the file and create a clean user-controlled local file, or approve exact trusted names in user settings.";
  }
  if (/tracked by git.*treated as project scope/u.test(diagnostic)) {
    return "A tracked local MCP settings contribution was demoted to project scope, so any servers it contributes require independent user approval; review definitions before approving exact trusted names.";
  }
  if (/MCP approvals .*project-scope settings are ignored/u.test(diagnostic)) {
    return "Project-scope MCP approval settings were ignored because a project cannot authorize itself; review definitions before approving exact trusted names from user-controlled settings.";
  }
  if (diagnostic.includes(".mcp.json is unreadable")) {
    return "Project .mcp.json is unreadable; restore file access or remove it, then run /reload or restart PiCC.";
  }
  if (diagnostic.includes(".mcp.json is malformed JSON")) {
    return "Project .mcp.json is malformed JSON; repair it as strict JSON, then run /reload or restart PiCC.";
  }
  if (diagnostic.includes('.mcp.json has no "mcpServers" key')) {
    return "Project .mcp.json is missing its mcpServers block; add an object block or remove the file, then run /reload or restart PiCC.";
  }
  if (/\.mcp\.json (?:root is not an object|"mcpServers" is not an object)/u.test(diagnostic)) {
    return "Project .mcp.json has the wrong object shape; make the root and mcpServers block objects, then run /reload or restart PiCC.";
  }
  if (/Native (?:user|local) MCP (?:server .* invalid|state contains an invalid server definition).*skipped/u.test(diagnostic)) {
    return "A native MCP server entry was invalid or unsupported and was skipped; repair or remove that entry, then run /reload or restart PiCC.";
  }
  if (/Native (?:user|local) MCP (?:server .* ignored or adjusted|state contains adjusted server configuration)/u.test(diagnostic)) {
    return "A native MCP server entry contained configuration PiCC ignored or adjusted; inspect the entry and effective MCP status, then run /reload or restart PiCC if changed.";
  }
  if (diagnostic === "Native Claude project MCP state has conflicting matching records") {
    return `Canonical-equivalent native Claude project records disagree on MCP server or runtime-control state, so all MCP loading is fail closed. ${mcpFailClosedRecovery(mcp)}`;
  }
  if (/(?:Native Claude|Active project) .*identity|ambiguous matching records/u.test(diagnostic)) {
    return `Native Claude project identity could not be selected safely, so MCP is fail closed. ${mcpFailClosedRecovery(mcp)}`;
  }
  if (
    diagnostic.includes("Matching native Claude project record has an invalid shape") ||
    /Native Claude .*(?:invalid (?:object )?shape|not an object|structural limits|limit|oversized project key)/u.test(diagnostic)
  ) {
    return `Native Claude MCP state has an invalid or unsupported shape, so MCP is fail closed. ${mcpFailClosedRecovery(mcp)}`;
  }
  if (/Native Claude state/u.test(diagnostic)) {
    return `Native Claude MCP state is unreadable, malformed, or otherwise unusable, so MCP is fail closed. ${mcpFailClosedRecovery(mcp)}`;
  }
  return "MCP configuration has an additional redacted issue; inspect the active profile and project MCP configuration, then run /reload or restart PiCC.";
}

function mcpSourceLabel(source: McpSourceClass): string {
  switch (source) {
    case "native-local": return "native local";
    case "project-mcpjson": return ".mcp.json";
    case "native-user": return "native user";
    case "settings-managed": return "settings managed extension";
    case "settings-local": return "settings local extension";
    case "settings-project": return "settings project extension";
    case "settings-user": return "settings user extension";
    case "managed-mcp": return "exclusive managed MCP";
  }
  const exhaustive: never = source;
  return exhaustive;
}

function mcpProfileStateHint(source: ClaudeProfileSource | undefined): string {
  switch (source) {
    case "picc-override": return "the .claude.json inside the user profile directory selected by PICC_CLAUDE_USER_DIR";
    case "claude-config": return "the .claude.json inside the user profile directory selected by CLAUDE_CONFIG_DIR";
    case "explicit": return "the .claude.json inside the explicitly selected Claude user profile directory";
    case "default":
    case undefined:
      return "the default native state file (~/.claude.json)";
  }
  const exhaustive: never = source;
  return exhaustive;
}

/** Fixed, path-redacted recovery text shared by startup, /mcp, and /doctor. */
export function mcpFailClosedRecovery(mcp: ResolvedMcpConfig): string {
  return `Preserve or back up the active user profile. PiCC has no repair command. Restore a known-good backup of the active profile or its native state; use ${mcpProfileStateHint(mcp.failClosedProfile)} to locate the active state. If no known-good backup is available, preserve the profile and seek appropriate support. Restart PiCC after recovery.`;
}

function mcpNameList(
  names: string[],
  maxNames = MCP_NAME_LIST_MAX,
  maxNameLength = MCP_PENDING_COPY_NAME_MAX,
): string {
  const shown = names
    .slice(0, maxNames)
    .map((name) => quotedMcpName(name, maxNameLength))
    .join(", ");
  const rest = names.length - maxNames;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

function boundPostureDiag(text: string): string {
  return text.length > MCP_POSTURE_DIAG_MAX_CHARS
    ? `${text.slice(0, MCP_POSTURE_DIAG_MAX_CHARS)}…`
    : text;
}

/**
 * Bounded least-authority enable/decline guidance for pending project servers.
 * Small sets can carry a copyable explicit allowlist; larger sets direct the
 * user back to configuration rather than turning blanket approval into a
 * list-bounding shortcut.
 */
function mcpPendingEditDetail(pendingNames: string[]): string {
  const enable =
    pendingNames.length <= MCP_NAME_LIST_MAX &&
    pendingNames.every(
      (name) => mcpStatusScalar(name, MCP_PENDING_COPY_NAME_MAX) === name,
    )
      ? `add "enabledMcpjsonServers": ${JSON.stringify(pendingNames)} for the server names you explicitly trust`
      : `inspect your MCP configuration, then add server names you explicitly trust to "enabledMcpjsonServers"`;
  return (
    `${enable} in user settings or a clean, user-controlled, untracked .claude/settings.local.json; add names to ` +
    `"disabledMcpjsonServers" to decline them. Each UTF-16 code unit outside ASCII letters, digits, ` +
    `"_", and "-" becomes "_"; an astral symbol therefore becomes "__". One persisted named approval can therefore match a differently named current or ` +
    `future server; re-review aliases when project MCP names change. Changes apply after reload or in a new session; this guidance does not ` +
    `change settings. Do not set "enableAllProjectMcpServers": true as a shortcut: it approves all current ` +
    `and future project servers.`
  );
}

/** One bounded, terminal-safe, model-inert pointer into the review workflow. */
function buildMcpPendingNotice(pendingNames: string[]): string {
  return `MCP: ${pendingNames.length} server(s) need review — run /mcp manage.`;
}

/**
 * Live per-server state as the runtime reports it. Structural (not imported
 * from runtime/mcp.ts) so the registry layer keeps no runtime dependency;
 * `McpRuntime.serverStates()` satisfies it.
 */
export interface McpServerLiveState {
  name: string;
  transport?: "stdio" | "http" | "sse";
  state: "connecting" | "retrying" | "connected" | "reconnecting" | "failed";
  attempt?: number;
  attemptLimit?: number;
  toolsAdvertised?: boolean;
  promptsAdvertised?: boolean;
  resourcesAdvertised?: boolean;
  toolCount?: number;
  promptCount?: number;
  resourceCount?: number;
  toolDiscoveryError?: string;
  initialToolDiscoveryFailed?: true;
  promptDiscoveryError?: string;
  resourceDiscoveryError?: string;
  diagnostic?: string;
  statusSummary?: string;
}

/**
 * Always-present MCP posture line for `/doctor` (the subagent-posture-line
 * pattern): live state per ENABLED server from the runtime, gate state per
 * pending/disabled/skipped server from discovery. Positive/live state lives
 * HERE — never as a finding.
 */
function mcpTransportLabel(transport: "stdio" | "http" | "sse" | "unknown"): string {
  return transport === "sse" ? "sse (deprecated; use http)" : transport;
}

function mcpInactiveTransportSuffix(
  server: ResolvedMcpConfig["servers"][number],
): string {
  return server.transport === "sse" ? ` via ${mcpTransportLabel(server.transport)}` : "";
}

function hasMcpCapabilityState(live: McpServerLiveState): boolean {
  return live.toolsAdvertised !== undefined || live.promptsAdvertised !== undefined ||
    live.resourcesAdvertised !== undefined;
}

function isMcpToolOnlyState(live: McpServerLiveState): boolean {
  return live.toolsAdvertised === true && live.promptsAdvertised === false &&
    live.resourcesAdvertised === false && live.toolDiscoveryError === undefined;
}

function mcpCapabilitySummary(live: McpServerLiveState, retained = false): string {
  const surfaces: string[] = [];
  const add = (
    label: "tools" | "prompts" | "resources",
    advertised: boolean | undefined,
    count: number | undefined,
    discoveryError: string | undefined,
  ): void => {
    if (advertised !== true) return;
    if (discoveryError !== undefined) {
      surfaces.push(`${label}: advertised, discovery failed`);
      return;
    }
    const safeCount = Number.isSafeInteger(count) && (count ?? -1) >= 0 ? count! : 0;
    surfaces.push(`${label}: ${safeCount}${retained ? " retained" : ""}`);
  };
  add("tools", live.toolsAdvertised, live.toolCount, live.toolDiscoveryError);
  add("prompts", live.promptsAdvertised, live.promptCount, live.promptDiscoveryError);
  add("resources", live.resourcesAdvertised, live.resourceCount, live.resourceDiscoveryError);
  if (surfaces.length > 0) {
    const summary = surfaces.join(", ");
    const discoveryFailed = live.toolDiscoveryError !== undefined ||
      live.promptDiscoveryError !== undefined || live.resourceDiscoveryError !== undefined;
    return discoveryFailed
      ? `${summary}; check the server configuration and logs, then restart PiCC`
      : summary;
  }
  if (
    live.toolsAdvertised === false &&
    live.promptsAdvertised === false &&
    live.resourcesAdvertised === false
  ) return "no tool, prompt, or resource capabilities advertised";
  const fallbackCount = Number.isSafeInteger(live.toolCount) && (live.toolCount ?? -1) >= 0
    ? live.toolCount!
    : 0;
  return `tools: ${fallbackCount}${retained ? " retained" : ""}`;
}

function mcpPolicyRepair(authority: McpPolicyAuthority | undefined): string {
  switch (authority) {
    case "administrator-controlled": return "Ask the administrator to repair or recover the applicable managed MCP policy input, then reload or restart PiCC.";
    case "mixed": return "Repair or recover user-controlled policy inputs and ask the administrator to repair or recover managed policy inputs as applicable, then reload or restart PiCC.";
    case "user-controlled":
    case undefined: return "Repair or recover the applicable user-controlled MCP policy input, then reload or restart PiCC.";
  }
}

function mcpPolicyEnforcementAction(authority: McpPolicyAuthority | undefined): string {
  switch (authority) {
    case "administrator-controlled": return "If access is expected, request an administrator policy change.";
    case "mixed": return "Review the applicable user-controlled policy and, if access is expected, request an administrator policy change.";
    case "user-controlled":
    case undefined: return "Review the applicable user-controlled MCP policy.";
  }
}

function mcpPolicyReason(reason: McpPolicyInactiveReason): string {
  switch (reason) {
    case "policy-denied": return "denied by MCP policy";
    case "policy-allow-miss": return "not present in the effective MCP allowlist";
    case "policy-managed-only": return "not present in the effective managed allow contributions";
    case "policy-candidate-invalid": return "configured identity is invalid, ambiguous, or over the admission limit";
  }
}

function mcpCandidateRepair(source: McpSourceClass): string {
  return source === "managed-mcp" || source === "settings-managed"
    ? "ask the administrator to repair the managed MCP server configuration, then run /reload or restart PiCC"
    : "repair the MCP server configuration, then run /reload or restart PiCC";
}

const MCP_POLICY_OBSERVATION_LABELS: Readonly<Record<McpPolicyObservation, string>> = {
  "invalid-managed-allow-active-empty": "invalid managed allow field became an empty allowlist",
  "invalid-managed-deny-dropped": "invalid managed deny field was stripped",
  "invalid-managed-only-treated-true": "invalid managed-only value was treated as true",
  "invalid-non-managed-projection": "invalid non-managed policy projection could not authorize servers",
  "invalid-rule-stripped": "invalid policy rule was stripped",
  "unset-environment-variable": "an unset environment variable remained literal",
  "allow-over-limit-active-empty": "the affected allow contribution supplied no authorization and was active-empty",
  "restrictive-material-omitted": "potentially restrictive policy material was omitted",
  "source-failure-fail-closed": "an applicable policy source failed",
  "compiler-uncertainty-fail-closed": "policy compilation was uncertain",
  "candidate-over-limit-blocked": "an over-limit candidate identity was blocked",
  "identity-ambiguity-blocked": "an ambiguous candidate identity was blocked",
};

function mcpPolicyHeading(authority: McpPolicyAuthority | undefined): string {
  return authority === "administrator-controlled" ? "Managed MCP policy"
    : authority === "mixed" ? "MCP policy (user and managed)"
    : "User-controlled MCP policy";
}

function mcpPolicySummary(mcp: ResolvedMcpConfig): string | undefined {
  const heading = mcpPolicyHeading(mcp.policyAuthority);
  switch (mcp.policyPosture) {
    case undefined:
    case "absent": return undefined;
    case "active-rules": return `${heading}: active rules.`;
    case "managed-only": return `${heading}: managed-only; only managed allow contributions remain effective.`;
    case "exclusive": return `Managed MCP policy: exclusive administrator server set is active${mcp.policyOrdinarySourcesSuppressed === true ? "; ordinary sources were suppressed" : ""}.`;
    case "exclusive-empty": return "Managed MCP policy: exclusive administrator server set is empty; all MCP is disabled. If access is expected, request an administrator policy change.";
    case "fail-closed": return `${heading}: fail closed; no candidate can start. ${mcpPolicyRepair(mcp.policyAuthority)}`;
  }
}

function mcpPolicyObservationSummary(mcp: ResolvedMcpConfig): string | undefined {
  const unique = [...new Set(mcp.policyObservations ?? [])];
  const observations = unique.slice(0, 12);
  if (observations.length === 0) return undefined;
  const omitted = Math.max(0, unique.length - observations.length);
  return `Policy observations: ${observations.map((item) => MCP_POLICY_OBSERVATION_LABELS[item]).join("; ")}${omitted > 0 ? `; ${omitted} additional observation(s) omitted` : ""}.`;
}

function mcpPolicyFailureSummary(mcp: ResolvedMcpConfig): string | undefined {
  const labels: Readonly<Record<McpPolicySourceFailure["kind"], string>> = {
    malformed: "malformed",
    unreadable: "unreadable",
    omitted: "omitted",
  };
  const sourceLabels: Readonly<Record<McpPolicySourceFailure["sourceClass"], string>> = {
    "standalone-mcp": "standalone managed MCP file",
    "system-file": "managed-settings system file",
    "system-drop-in": "administrator system drop-in",
    override: "managed-settings override",
  };
  const unique = [...new Map((mcp.policyFailures ?? []).map((failure) => [
    `${failure.kind}|${failure.sourceClass}|${failure.authority}|${failure.remediation}`,
    failure,
  ])).values()];
  if (unique.length === 0) return undefined;
  const shown = unique.slice(0, 8);
  const omitted = unique.length - shown.length;
  return `Policy source failures: ${shown.map((failure) => `${sourceLabels[failure.sourceClass]} was ${labels[failure.kind]}`).join("; ")}${omitted > 0 ? `; ${omitted} additional failure(s) omitted` : ""}.`;
}

function mcpPostureLine(
  mcp: ResolvedMcpConfig,
  liveStates: readonly McpServerLiveState[],
): string {
  if (mcp.policyPosture === "exclusive" && mcp.servers.some((server) => server.source !== "managed-mcp")) {
    return mcpPostureLine(
      { ...mcp, servers: mcp.servers.filter((server) => server.source === "managed-mcp") },
      liveStates,
    );
  }
  if (mcp.failClosed === "native-state-unusable") {
    return `MCP: fail closed because native Claude state is unusable. ${mcpFailClosedRecovery(mcp)}`;
  }
  const policy = mcpPolicySummary(mcp);
  if (mcp.policyPosture === "exclusive-empty" || mcp.policyPosture === "fail-closed") {
    return policy ?? "MCP: fail closed by policy.";
  }
  if (mcp.servers.length === 0) return policy ?? "MCP: no servers configured.";
  const liveByName = new Map(liveStates.map((s) => [s.name, s]));
  const ordered = mcp.servers.length <= 32 ? mcp.servers : [...mcp.servers].sort((left, right) => {
    const actionable = (server: ResolvedMcpConfig["servers"][number]): number => {
      const live = liveByName.get(server.name);
      const state = server.status === "enabled" ? live?.state : server.status;
      return state === "retrying" || state === "reconnecting" || state === "failed" ||
        state === "skipped" || state === "pending-approval" ? 0 : 1;
    };
    return actionable(left) - actionable(right);
  });
  const selected = ordered.slice(0, 32);
  const parts = selected.map((server) => {
    const part = (() => {
      const status = server.status;
      const identity = quotedMcpName(server.name, MCP_STATUS_NAME_MAX);
      switch (status) {
      case "enabled": {
        const live = liveByName.get(server.name);
        // Enabled but unknown to the runtime (states not supplied — e.g. a
        // report rendered without a running session): claim only enablement.
        if (!live) return `${identity}: enabled${mcpInactiveTransportSuffix(server)}`;
        const liveTransport = live.transport ?? server.transport ?? "unknown";
        const transport = mcpTransportLabel(liveTransport);
        const attempts = live.attempt !== undefined && live.attemptLimit !== undefined
          ? ` ${live.attempt}/${live.attemptLimit}`
          : "";
        if (liveTransport === "stdio") {
          if (live.state === "connected") return hasMcpCapabilityState(live) && !isMcpToolOnlyState(live)
            ? `${identity}: connected (${mcpCapabilitySummary(live)})`
            : `${identity}: connected (${live.toolCount ?? 0} tool(s))`;
          if (live.state === "connecting") return `${identity}: connecting`;
          const failureDetail = live.initialToolDiscoveryFailed === true
            ? live.statusSummary ?? "Initial tools/list discovery failed; check the server configuration and logs, then run /reload or restart PiCC."
            : live.statusSummary ?? "Connection failed; check the server configuration and logs, then run /reload or restart PiCC.";
          return `${identity}: failed — ${boundPostureDiag(failureDetail)}`;
        }
        if (live.state === "connected") return hasMcpCapabilityState(live) && !isMcpToolOnlyState(live)
          ? `${identity}: connected via ${transport} (${mcpCapabilitySummary(live)})`
          : `${identity}: connected via ${transport} (${live.toolCount ?? 0} tool(s))`;
        if (live.state === "connecting") return `${identity}: connecting via ${transport}${attempts}`;
        if (live.state === "retrying") return `${identity}: retrying via ${transport}${attempts}`;
        if (live.state === "reconnecting") return hasMcpCapabilityState(live) && !isMcpToolOnlyState(live)
          ? `${identity}: reconnecting via ${transport}${attempts} (${mcpCapabilitySummary(live, true)})`
          : `${identity}: reconnecting via ${transport}${attempts} (${live.toolCount ?? 0} retained tool(s))`;
        return hasMcpCapabilityState(live) && !isMcpToolOnlyState(live)
          ? `${identity}: failed via ${transport} (${mcpCapabilitySummary(live, true)}) — ${boundPostureDiag(live.statusSummary ?? "no safe summary")}`
          : `${identity}: failed via ${transport} (${live.toolCount ?? 0} retained tool(s)) — ${boundPostureDiag(live.statusSummary ?? "no safe summary")}`;
      }
      case "pending-approval":
        // No enable/decline hint here — the pending finding rendered below
        // carries the bounded guidance; repeating it would duplicate it.
        return `${identity}: pending approval${mcpInactiveTransportSuffix(server)}`;
      case "disabled":
        return server.inactiveReason === "native-runtime-disabled"
          ? `${identity}: disabled${mcpInactiveTransportSuffix(server)} (native disabledMcpServers); use Claude Code with the same active user profile for this project to remove the exact disabled name if trusted, then run /reload or restart PiCC`
          : `${identity}: disabled${mcpInactiveTransportSuffix(server)} (settings disabledMcpjsonServers)`;
      case "blocked":
        return server.inactiveReason === "policy-candidate-invalid"
          ? `${identity}: blocked — ${mcpPolicyReason(server.inactiveReason)}; ${mcpCandidateRepair(server.source)}`
          : `${identity}: blocked — ${mcpPolicyReason(server.inactiveReason)}; ${mcpPolicyEnforcementAction(mcp.policyAuthority)}`;
      case "not-configured":
        return `${identity}: not configured${mcpInactiveTransportSuffix(server)}`;
      case "skipped":
        return `${identity}: skipped${mcpInactiveTransportSuffix(server)} — configuration is unusable; check the MCP configuration and logs, then run /reload or restart PiCC`;
    }
      // Keep discovery status additions from silently rendering as undefined.
      const unhandledStatus: never = status;
      return unhandledStatus;
    })();
    return `${part} [source: ${mcpSourceLabel(server.source)}]`;
  });
  const prefix = policy ? `${policy} MCP servers: ` : "MCP servers: ";
  const rendered: string[] = [];
  for (const part of parts) {
    const omitted = mcp.servers.length - rendered.length - 1;
    const suffix = omitted > 0
      ? `; ${omitted} additional server name(s) omitted — inspect the MCP configuration for complete detail`
      : "";
    const candidate = `${prefix}${[...rendered, part].join("; ")}${suffix}.`;
    if (candidate.length > MCP_STATUS_REPORT_MAX) break;
    rendered.push(part);
  }
  const omitted = mcp.servers.length - rendered.length;
  const suffix = omitted > 0
    ? `; ${omitted} additional server name(s) omitted — inspect the MCP configuration for complete detail`
    : "";
  return `${prefix}${rendered.join("; ")}${suffix}.`;
}

const MCP_STATUS_DETAIL_MAX = 32;
const MCP_STATUS_NAME_MAX = 120;
const MCP_STATUS_SUMMARY_MAX = 150;
const MCP_STATUS_REPORT_MAX = 16_384;

type McpRenderedState =
  | "enabled"
  | "connecting"
  | "retrying"
  | "connected"
  | "reconnecting"
  | "failed"
  | "pending approval"
  | "disabled"
  | "blocked"
  | "not configured"
  | "skipped";

const MCP_RENDERED_STATE_ORDER: readonly McpRenderedState[] = [
  "enabled",
  "connecting",
  "retrying",
  "connected",
  "reconnecting",
  "failed",
  "pending approval",
  "disabled",
  "blocked",
  "not configured",
  "skipped",
];

function mcpStatusScalar(text: string, max: number): string {
  const wellFormed = text.replace(/\p{Cs}/gu, "�");
  const oneLine = neutralizeControlChars(wellFormed).replace(/\s+/gu, " ").trim();
  if (oneLine.length <= max) return oneLine;
  let slice = oneLine.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(slice)) slice = slice.slice(0, -1);
  return `${slice}…`;
}

function mcpLiveByName(
  liveStates: readonly McpServerLiveState[],
): ReadonlyMap<string, McpServerLiveState> {
  const byName = new Map<string, McpServerLiveState>();
  for (const live of liveStates) {
    if (!byName.has(live.name)) byName.set(live.name, live);
  }
  return byName;
}

function mcpEffectiveState(
  server: ResolvedMcpConfig["servers"][number],
  live: McpServerLiveState | undefined,
): McpRenderedState {
  if (server.status !== "enabled") {
    if (server.status === "pending-approval") return "pending approval";
    if (server.status === "not-configured") return "not configured";
    return server.status;
  }
  return live?.state ?? "enabled";
}

function mcpAttemptSuffix(live: McpServerLiveState | undefined): string {
  if (live?.attempt === undefined || live.attemptLimit === undefined) return "";
  return ` (attempt ${live.attempt}/${live.attemptLimit})`;
}

function mcpStatusRow(
  server: ResolvedMcpConfig["servers"][number],
  live: McpServerLiveState | undefined,
  policyAuthority: McpPolicyAuthority | undefined,
): string {
  const name = quotedMcpName(server.name, MCP_STATUS_NAME_MAX);
  switch (mcpEffectiveState(server, live)) {
    case "enabled":
      return `- ${name}: enabled${mcpInactiveTransportSuffix(server)}; runtime state unavailable`;
    case "connecting": {
      const transport = live?.transport ?? server.transport ?? "unknown";
      return transport === "stdio"
        ? `- ${name}: connecting`
        : `- ${name}: connecting via ${mcpTransportLabel(transport)}${mcpAttemptSuffix(live)}`;
    }
    case "retrying":
      return `- ${name}: retrying via ${mcpTransportLabel(live?.transport ?? server.transport ?? "unknown")}${mcpAttemptSuffix(live)}`;
    case "connected": {
      const transport = live?.transport ?? server.transport ?? "unknown";
      if (live && (!hasMcpCapabilityState(live) || isMcpToolOnlyState(live))) {
        const count = Number.isSafeInteger(live.toolCount) && (live.toolCount ?? -1) >= 0 ? live.toolCount! : 0;
        if (transport === "stdio") return `- ${name}: connected (${count} ${count === 1 ? "tool" : "tools"})`;
        return `- ${name}: connected via ${mcpTransportLabel(transport)} (${count} ${count === 1 ? "tool" : "tools"})`;
      }
      const capabilities = live ? mcpCapabilitySummary(live) : "tools: 0";
      if (transport === "stdio") return `- ${name}: connected (${capabilities})`;
      return `- ${name}: connected via ${mcpTransportLabel(transport)} (${capabilities})`;
    }
    case "reconnecting": {
      if (live && (!hasMcpCapabilityState(live) || isMcpToolOnlyState(live))) {
        const count = Number.isSafeInteger(live.toolCount) ? live.toolCount! : 0;
        return `- ${name}: reconnecting via ${mcpTransportLabel(live.transport ?? server.transport ?? "unknown")}${mcpAttemptSuffix(live)} (${count} retained ${count === 1 ? "tool" : "tools"})`;
      }
      const capabilities = live ? mcpCapabilitySummary(live, true) : "tools: 0 retained";
      return `- ${name}: reconnecting via ${mcpTransportLabel(live?.transport ?? server.transport ?? "unknown")}${mcpAttemptSuffix(live)} (${capabilities})`;
    }
    case "failed": {
      const summary = mcpStatusScalar(live?.statusSummary ?? "", MCP_STATUS_SUMMARY_MAX);
      const transport = live?.transport ?? server.transport ?? "unknown";
      if (transport === "stdio") {
        return `- ${name}: failed — ${summary || "Connection failed; no safe summary is available; run /doctor for details."}`;
      }
      if (live && (!hasMcpCapabilityState(live) || isMcpToolOnlyState(live))) {
        const count = Number.isSafeInteger(live.toolCount) ? live.toolCount! : 0;
        return `- ${name}: failed via ${mcpTransportLabel(transport)} (${count} retained ${count === 1 ? "tool" : "tools"}) — ${summary || "Connection failed; no safe summary is available; run /doctor for details."}`;
      }
      const capabilities = live ? mcpCapabilitySummary(live, true) : "tools: 0 retained";
      return `- ${name}: failed via ${mcpTransportLabel(transport)} (${capabilities}) — ${summary || "Connection failed; no safe summary is available; run /doctor for details."}`;
    }
    case "pending approval":
      return `- ${name}: pending approval${mcpInactiveTransportSuffix(server)}`;
    case "disabled":
      return "inactiveReason" in server && server.inactiveReason === "native-runtime-disabled"
        ? `- ${name}: disabled${mcpInactiveTransportSuffix(server)} — native disabledMcpServers; use Claude Code with the same active user profile for this project to remove the exact disabled name if trusted, then run /reload or restart PiCC`
        : `- ${name}: disabled${mcpInactiveTransportSuffix(server)} — settings disabledMcpjsonServers rejection`;
    case "blocked":
      return server.status === "blocked"
        ? server.inactiveReason === "policy-candidate-invalid"
          ? `- ${name}: blocked — ${mcpPolicyReason(server.inactiveReason)}; ${mcpCandidateRepair(server.source)}`
          : `- ${name}: blocked — ${mcpPolicyReason(server.inactiveReason)}; ${mcpPolicyEnforcementAction(policyAuthority)}`
        : `- ${name}: blocked — policy state unavailable`;
    case "not configured":
      return `- ${name}: not configured${mcpInactiveTransportSuffix(server)}`;
    case "skipped":
      return `- ${name}: skipped${mcpInactiveTransportSuffix(server)} — configuration is unusable; run /doctor for details`;
  }
}

function mcpStatusPendingGuidance(
  pendingNames: readonly string[],
  allPendingDisplayed: boolean,
): string[] {
  if (pendingNames.length === 0) return [];
  const exactNames = pendingNames.every(
    (name) => mcpStatusScalar(name, MCP_PENDING_COPY_NAME_MAX) === name,
  );
  const explicit =
    pendingNames.length <= MCP_NAME_LIST_MAX && allPendingDisplayed && exactNames;
  const enable = explicit
    ? `Add "enabledMcpjsonServers": ${JSON.stringify(pendingNames)} for the server names you explicitly trust.`
    : `Inspect your MCP configuration, then add server names you explicitly trust to "enabledMcpjsonServers".`;
  return [
    "Pending-server guidance (read-only):",
    `${enable} Put approvals in user settings or a clean, user-controlled, untracked .claude/settings.local.json.`,
    `Each UTF-16 code unit outside ASCII letters, digits, "_", and "-" becomes "_"; an astral symbol therefore becomes "__". One persisted named approval can therefore match a differently named current or future server; re-review aliases when project MCP names change.`,
    `Add server names to "disabledMcpjsonServers" to decline them. Changes apply after reload or in a new session; /mcp did not change settings.`,
    `Do not set "enableAllProjectMcpServers": true as a shortcut: it approves all current and future project servers.`,
  ];
}

/**
 * Read-only, aggregate-bounded MCP status report. Arbitrary diagnostics and
 * configuration values are never interpolated; names are normalized and
 * failure summaries come only from the runtime's independently safe field.
 */
export function renderMcpStatusReport(
  mcp: ResolvedMcpConfig | undefined,
  liveStates: readonly McpServerLiveState[],
): string {
  const rawConfig = mcp ?? EMPTY_MCP;
  const config = rawConfig.policyPosture === "exclusive"
    ? { ...rawConfig, servers: rawConfig.servers.filter((server) => server.source === "managed-mcp") }
    : rawConfig;
  const unsupportedEnablement = config.diagnostics.some(
    (diagnostic) => diagnostic.includes("enabledMcpServers is unsupported"),
  );
  const otherConfigDiagnostics = config.diagnostics.some(
    (diagnostic) => !diagnostic.includes("enabledMcpServers is unsupported"),
  );
  const lines = ["MCP status (read-only)"];
  const nativeStateUnusable = config.failClosed === "native-state-unusable";
  const policySummary = nativeStateUnusable ? undefined : mcpPolicySummary(config);
  if (policySummary) lines.push(policySummary);
  const aggregateOnly = config.policyPosture === "exclusive-empty" || config.policyPosture === "fail-closed";
  if (nativeStateUnusable) {
    lines.push(`MCP is fail closed because native Claude state is unusable. ${mcpFailClosedRecovery(config)}`);
  } else if (config.servers.length === 0 && !aggregateOnly) {
    lines.push(
      otherConfigDiagnostics
        ? "No usable MCP servers were resolved."
        : "No MCP servers are configured.",
    );
  } else if (!aggregateOnly) {
    lines.push(`Resolved server entries: ${config.servers.length}`);
  }

  const liveByName = mcpLiveByName(liveStates);
  const suppressRows = aggregateOnly || nativeStateUnusable;
  const detailCount = suppressRows ? 0 : Math.min(config.servers.length, MCP_STATUS_DETAIL_MAX);
  const indexed = config.servers.map((server, index) => ({ server, index }));
  const selected = suppressRows
    ? []
    : config.servers.length <= MCP_STATUS_DETAIL_MAX
      ? indexed
      : [...indexed].sort((left, right) => {
        const priority = (item: typeof left): number => {
          const state = mcpEffectiveState(item.server, liveByName.get(item.server.name));
          return ["retrying", "reconnecting", "failed", "skipped", "pending approval"].includes(state)
            ? 0
            : state === "connected" || state === "enabled"
              ? 2
              : 1;
        };
        return priority(left) - priority(right) || left.index - right.index;
      }).slice(0, detailCount);
  const selectedIndexes = new Set(selected.map((item) => item.index));
  for (const { server } of selected) {
    lines.push(`${mcpStatusRow(server, liveByName.get(server.name), config.policyAuthority)} [source: ${mcpSourceLabel(server.source)}]`);
  }

  if (!suppressRows && config.servers.length > detailCount) {
    const omitted = new Map<McpRenderedState, number>();
    for (let index = 0; index < config.servers.length; index += 1) {
      if (selectedIndexes.has(index)) continue;
      const server = config.servers[index]!;
      const state = mcpEffectiveState(server, liveByName.get(server.name));
      omitted.set(state, (omitted.get(state) ?? 0) + 1);
    }
    const groups = MCP_RENDERED_STATE_ORDER.flatMap((state) => {
      const count = omitted.get(state);
      return count === undefined ? [] : [`${state}: ${count}`];
    });
    lines.push(`Omitted ${config.servers.length - detailCount} servers (${groups.join(", ")}); run /doctor for bounded details.`);
  }

  const policyObservationSummary = mcpPolicyObservationSummary(config);
  if (policyObservationSummary) lines.push(policyObservationSummary);
  const policyFailureSummary = mcpPolicyFailureSummary(config);
  if (policyFailureSummary) lines.push(policyFailureSummary);

  if (
    otherConfigDiagnostics ||
    config.servers.some((server) => server.diagnostics.length > 0)
  ) {
    lines.push("Some MCP configuration was malformed, ignored, or unusable; run /doctor for details.");
  }

  if (unsupportedEnablement) {
    lines.push(
      config.servers.length > 0
        ? "Native enabledMcpServers was recognized, but PiCC does not support this enablement capability; the list does not authorize default-off runtime servers. The resolved rows above determine actual status."
        : "Native enabledMcpServers was recognized, but PiCC does not support this enablement capability; the list does not authorize default-off runtime servers.",
    );
  }

  const pending = aggregateOnly ? [] : config.servers.filter((server) => server.status === "pending-approval");
  const allPendingDisplayed = config.servers.every(
    (server, index) => server.status !== "pending-approval" || selectedIndexes.has(index),
  );
  lines.push(...mcpStatusPendingGuidance(pending.map((server) => server.name), allPendingDisplayed));

  const report = lines.join("\n");
  // Per-row/scalar bounds keep this unreachable; retain a fail-closed ceiling
  // in case future fixed prose grows without revisiting the aggregate contract.
  return report.length <= MCP_STATUS_REPORT_MAX
    ? report
    : `${report.slice(0, MCP_STATUS_REPORT_MAX - 1)}…`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Group findings by capability id, merging evidence, preserving order. */
function groupByCapability(findings: CompatFinding[]): Array<{
  capability: CapabilityEntry;
  evidence: string[];
}> {
  const byId = new Map<string, { capability: CapabilityEntry; evidence: string[] }>();
  for (const f of findings) {
    const existing = byId.get(f.capability.id);
    if (existing) existing.evidence.push(f.evidence);
    else byId.set(f.capability.id, { capability: f.capability, evidence: [f.evidence] });
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Active-model vision surface.
//
// This line is derived from the ACTIVE model's input modalities (via
// `modelSupportsImages`), NOT from the static capability registry and NOT from
// the terminal's render capability. When `/doctor` is requested, it tells the
// user whether their model can actually see image inputs (image files,
// pasted/dropped images, notebook image outputs), so the report makes explicit
// whether a screenshot or notebook plot reached the model.
// ---------------------------------------------------------------------------

/** Display id for the active model (`provider/id` or `id`), or undefined when opaque. */
function activeModelId(model: unknown): string | undefined {
  const m = model as { id?: unknown; provider?: unknown } | null | undefined;
  if (!m || typeof m.id !== "string" || m.id === "") return undefined;
  const provider = typeof m.provider === "string" && m.provider !== "" ? m.provider : undefined;
  return provider ? `${provider}/${m.id}` : m.id;
}

/**
 * True when the model exposes a readable `input` modality array. A model with an
 * `id` but no (or a non-array) `input` is OPAQUE on the vision axis — we cannot
 * say yes OR no, only "unknown". Mirrors the `Array.isArray` guard in
 * `modelSupportsImages`.
 */
function modelHasVisionAxis(model: unknown): boolean {
  return Array.isArray((model as { input?: unknown } | null | undefined)?.input);
}

/**
 * Full, always-shown vision-state line for `/doctor` — yes / no / unknown.
 * Never throws: an absent active model, or one with no readable `input` array,
 * degrades to "vision: unknown" (naming the model id when we have it).
 */
function activeModelVisionLine(model: unknown): string {
  const id = activeModelId(model);
  const label = id ?? "unknown";
  // No id, or an id with no readable modality array → opaque on the vision axis.
  if (id === undefined || !modelHasVisionAxis(model)) {
    return (
      `Active model: ${label} — vision: unknown. If it is not vision-capable, image inputs ` +
      "(image files, pasted/dropped images, notebook image outputs) are sent as text placeholders, not seen by the " +
      "model; use a vision-capable model to have images seen."
    );
  }
  if (modelSupportsImages(model)) {
    return `Active model: ${label} — vision: yes. Image inputs (image files, pasted/dropped images, notebook image outputs) are delivered to the model as images.`;
  }
  return (
    `Active model: ${label} — vision: no. Image inputs (image files, pasted/dropped images, notebook image outputs) are ` +
    "sent as text placeholders, not seen by the model; use a vision-capable model to have images seen."
  );
}

const TIER_ORDER = ["partial", "degraded-noop", "not-supported", "na", "full"] as const;

/**
 * Always-present subagent nesting-posture line for `/doctor`. `subagents.*` are
 * PiCC extensions (not Claude-settings parity). Reads the *effective*
 * `subagentMaxDepth` — at render time we cannot tell an explicit value from the
 * default, so we branch on the number and never claim more than is true.
 */
function subagentPostureLine(project: ClaudeProject): string {
  const { subagentsEnabled, subagentMaxDepth } = project.settings;
  if (subagentsEnabled === false) {
    return "Subagent nesting: subagent dispatch disabled (subagents.enabled=false / disableSubagents:true); no delegation.";
  }
  if (subagentMaxDepth === 1) {
    return "Subagent nesting: main-session-only (subagents.maxDepth=1, PiCC default). Set subagents.maxDepth to any positive integer greater than 1 in .claude/settings.json to allow nested delegation.";
  }
  if (subagentMaxDepth >= 2) {
    return `Subagent nesting: up to ${subagentMaxDepth} levels below the main session (subagents.maxDepth=${subagentMaxDepth}).`;
  }
  // Out-of-range value (0, negative, fractional) — the settings loader now
  // validates subagents.maxDepth as a positive integer, so a loaded value never
  // reaches here. This defensive branch survives because a ClaudeProject can be
  // constructed with an out-of-range subagentMaxDepth directly (bypassing the
  // loader — e.g. registry tests), and we still report the actual number
  // truthfully instead of claiming the default. Never asserts "=1, PiCC default"
  // for a value that isn't 1.
  return `Subagent nesting: subagents.maxDepth=${subagentMaxDepth} (a PiCC extension). Set it to 1 for main-session-only, or another positive integer to allow nested delegation.`;
}

/**
 * Resolved compaction-knob line for `/doctor` — lets a user confirm their
 * `proactiveCompactPercent`/`clipMaxTokens` overrides actually took effect
 * (an out-of-range value fails closed to the default and is reported here as-resolved).
 */
function pluginPostureLine(posture: PluginPosture | undefined): string {
  if (!posture) return "Plugin selection: no normalized outcomes.";
  const parts = PLUGIN_STATUS_ORDER.flatMap((status) => {
    const count = posture.counts[status];
    return count === undefined ? [] : [`${status}: ${count}`];
  });
  return `Plugin selection: ${parts.join(", ")}.`;
}

function pluginInventoryLines(inventory: PluginInventoryDoctorProjection | undefined): string[] {
  if (inventory === undefined) return [];
  const { counts } = inventory;
  const lines = [
    `Plugin inventory (captured snapshot): known: ${counts.known}, installed: ${counts.installed}, enabled: ${counts.enabled}, loaded: ${counts.loaded}, cataloged: ${counts.cataloged}, attention: ${counts.attention}.`,
  ];
  const countOmissions = inventory.captureOmissions.filter((value) => /^(?:snapshot\.(?:items|installations|catalog-declarations)|loader\.installed\.records|loader\.marketplace\.entries)$/u.test(value.axis));
  if (countOmissions.length > 0) lines.push(`  Capture omissions may make these retained counts incomplete: ${countOmissions.map((value) => `${value.axis}=${value.count}`).join(", ")}.`);
  lines.push("Captured for this session; run /reload-plugins in the interactive TUI, or start a new PiCC session to refresh.");
  for (const diagnostic of inventory.diagnostics) {
    const owner = diagnostic.qualifiedIdentity ?? "global";
    const status = diagnostic.status === undefined ? "" : ` [${diagnostic.status}]`;
    const repair = diagnostic.repairBoundary === undefined ? "" : ` Repair boundary: ${diagnostic.repairBoundary}.`;
    const refresh = diagnostic.refreshGuidance === undefined ? "" : ` Refresh: ${diagnostic.refreshGuidance}.`;
    if (diagnostic.category === "lifecycle") {
      const operationId = diagnostic.operationId ?? "not available";
      const semanticStep = diagnostic.semanticStep ?? "not available";
      const recoveryCategory = diagnostic.recoveryCategory ?? "not available";
      const target = diagnostic.target ?? "not attributed";
      const recoveryCommand = diagnostic.nextCommand ?? "not available";
      lines.push(`  - Lifecycle evidence — owner: ${owner}${status}; operation id: ${operationId}; semantic step: ${semanticStep}; recovery category: ${recoveryCategory}; target: ${target}; observational recovery command: ${recoveryCommand}; message: ${diagnostic.message}.${repair}${refresh}`);
    } else {
      const action = diagnostic.nextCommand === undefined ? "" : ` Next: ${diagnostic.nextCommand}.`;
      lines.push(`  - Diagnostic — ${owner}${status}: ${diagnostic.message}.${action}${repair}${refresh}`);
    }
  }
  const diagnosticOmissions = inventory.omitted.diagnostics.capture + inventory.omitted.diagnostics.projection;
  if (diagnosticOmissions > 0) lines.push(`  - ${diagnosticOmissions} additional captured diagnostic(s) omitted.`);
  const capabilityOmissions = inventory.omitted.capabilityEvidence.capture + inventory.omitted.capabilityEvidence.projection;
  if (capabilityOmissions > 0) lines.push(`  - ${capabilityOmissions} additional captured capability observation(s) omitted.`);
  if (inventory.omitted.managedPolicyEvidence.projection > 0) lines.push(`  - ${inventory.omitted.managedPolicyEvidence.projection} additional managed-policy observation(s) omitted.`);
  return lines;
}

export function retentionPostureLine(project: ClaudeProject): string {
  const days = project.settings.cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS;
  if (project.settings.retentionCleanupAllowed === true) {
    return `Retention: ${days} days for persisted subagent transcripts and orphaned worktrees; cleanup allowed.`;
  }
  const blockers = (project.settings.retentionCleanupBlockers ?? []).slice(0, 8).map((blocker) => {
    const source = mcpStatusScalar(path.posix.basename(String(blocker.source).replaceAll("\\", "/")), 80) || "settings source";
    const reason = blocker.reason === "invalid-period"
      ? "invalid cleanupPeriodDays"
      : blocker.reason === "unreadable-source"
        ? "unreadable"
        : blocker.reason === "malformed-source"
          ? "malformed JSON"
          : "non-object root";
    return `${source}: ${reason}`;
  });
  const omitted = Math.max(0, (project.settings.retentionCleanupBlockers?.length ?? 0) - blockers.length);
  const detail = blockers.length > 0 ? blockers.join(", ") : "settings admission unavailable";
  return `Retention: ${days} days; cleanup paused (${detail}${omitted > 0 ? `; ${omitted} more blocker(s) omitted` : ""}). Repair the reported settings source and restart PiCC.`;
}

function compactionKnobsLine(compaction: ResolvedCompactionConfig, activeModel: unknown): string {
  const api = activeModel && typeof activeModel === "object"
    ? (activeModel as { api?: unknown }).api
    : undefined;
  const apiLabel = typeof api === "string" && api.length > 0 ? api : "unknown API";
  const knobs = `proactiveCompactPercent=${compaction.proactiveCompactPercent} (of context window), clipMaxTokens=${compaction.clipMaxTokens} (per tool-result block)`;
  if (isProactiveCompactionApi(api)) {
    return `Compaction: proactive checkpointing active for current model (${apiLabel}); ${knobs}.`;
  }
  const supported = [...PROACTIVE_COMPACTION_APIS];
  const supportedLabel = `${supported.slice(0, -1).join(", ")}, and ${supported.at(-1)}`;
  return `Compaction: current model transport/API (${apiLabel}) is unsupported for proactive checkpointing. Supported API ids are ${supportedLabel}; switch to a model using one of them. ${knobs}.`;
}

const GENERIC_PLUGIN_RUNTIME_REPAIR = /(?:\s*\.?)?\s*(?:Repair plugin-data ownership, writability, and directory kinds, then retry the affected action; no reload is required|(?:Repair|Reconcile) or reinstall (?:the affected |the )?plugin (?:in|through) Claude Code, then (?:(?:run the canonical \/reload in the interactive TUI or exit and relaunch|relaunch) PiCC|run \/reload-plugins in the interactive TUI or start a new PiCC session)|Inspect exact ownership in plugin inventory; update exact PiCC-owned state with PiCC lifecycle or repair imported state through Claude Code, then run \/reload-plugins in the interactive TUI or start a new PiCC session|Inspect exact ownership with \/plugin details <qualified identity>, then use the applicable focused action or picc plugin --help for exact PiCC-owned changes, or repair imported state through Claude Code; afterward, run \/reload-plugins in the interactive TUI or start a new PiCC session)\.?(?=\s*;\s*(?:execution did not occur|no provider request was made)|\s*$)/iu;

interface NormalizedPluginRuntimeFinding {
  evidence: string;
  recovery: string;
}

function normalizePluginRuntimeFinding(value: string): NormalizedPluginRuntimeFinding {
  const withoutGenericRepair = value.replace(GENERIC_PLUGIN_RUNTIME_REPAIR, "").trim();
  const classification = withoutGenericRepair.toLowerCase();
  const recovery = /\((?:unreadable-path|wrong-kind)\)/.test(classification)
    ? "Recovery: repair plugin-data ownership, writability, and directory kinds, then retry the affected action; no reload is required."
    : `Recovery: ${PLUGIN_OWNERSHIP_ACTION}`;
  return { evidence: mcpStatusScalar(withoutGenericRepair, 500), recovery };
}

/** Project-specific /doctor compatibility report, generated from the registry. */
export function renderDoctorReport(
  project: ClaudeProject,
  report: CompatReport,
  activeModel?: unknown,
  compaction?: ResolvedCompactionConfig,
  mcpStates?: readonly McpServerLiveState[],
): string {
  const lines: string[] = [
    `PiCC compatibility report — baseline ${CLAUDE_BASELINE}`,
    `Project: ${project.root}`,
    activeModelVisionLine(activeModel),
    subagentPostureLine(project),
    retentionPostureLine(project),
    "Main-session MCP status (agent declaration findings and remediation appear under Compatibility findings):",
    mcpPostureLine(project.mcp ?? EMPTY_MCP, mcpStates ?? []),
    ...(mcpPolicyObservationSummary(project.mcp ?? EMPTY_MCP) ? [mcpPolicyObservationSummary(project.mcp ?? EMPTY_MCP)!] : []),
    ...(mcpPolicyFailureSummary(project.mcp ?? EMPTY_MCP) ? [mcpPolicyFailureSummary(project.mcp ?? EMPTY_MCP)!] : []),
    ...(report.pluginInventory === undefined ? [pluginPostureLine(report.pluginPosture)] : pluginInventoryLines(report.pluginInventory)),
    ...(compaction ? [compactionKnobsLine(compaction, activeModel)] : []),
    "",
  ];

  const grouped = groupByCapability([...report.safetyFindings, ...report.findings]);
  const hasPluginRuntimeFindings = (report.pluginRuntimeFindings ?? []).length > 0;
  if (grouped.length === 0 && !hasPluginRuntimeFindings) {
    lines.push("No compatibility findings detected.");
  } else if (grouped.length > 0) {
    lines.push("Compatibility findings:");
    for (const tier of TIER_ORDER) {
      const inTier = grouped.filter((g) => g.capability.tier === tier);
      if (inTier.length === 0) continue;
      lines.push(`  [${tier}]`);
      for (const g of inTier) {
        const safety = g.capability.safetyRelevant === true ? "SAFETY " : "";
        lines.push(`    - ${safety}${g.capability.id} — ${g.capability.note}`);
        for (const ev of g.evidence) {
          lines.push(`        evidence: ${ev}`);
        }
      }
    }
  }
  lines.push("");

  const normalizedRuntimeFindings = (report.pluginRuntimeFindings ?? [])
    .filter((item): item is string => typeof item === "string")
    .map(normalizePluginRuntimeFinding)
    .filter((item) => item.evidence.length > 0);
  const runtimeFindings = [...new Map(normalizedRuntimeFindings
    .map((item) => [item.evidence, item] as const)).values()].slice(0, 20);
  if (runtimeFindings.length > 0) {
    lines.push("Plugin runtime failures (execution did not occur):");
    for (const item of runtimeFindings) lines.push(`  - ${item.evidence}`);
    const omitted = Math.max(0, Math.trunc(report.pluginRuntimeFindingsOmitted ?? 0));
    if (omitted > 0) {
      const qualifier = report.pluginRuntimeFindingsOmittedAtLeast ? "at least " : "";
      lines.push(`  - ${qualifier}${omitted} additional distinct failure(s) omitted.`);
    }
    for (const recovery of new Set(runtimeFindings.map((item) => item.recovery))) {
      lines.push(`  ${recovery}`);
    }
    lines.push("");
  }

  if (report.unassessed.length > 0) {
    lines.push(`Unassessed (unknown at baseline ${CLAUDE_BASELINE} — degrade safely):`);
    for (const item of report.unassessed) {
      lines.push(`  - ${item}`);
    }
  } else {
    lines.push("Unassessed: none.");
  }
  lines.push("");

  lines.push(`Support matrix (${CAPABILITY_REGISTRY.length} capabilities @ ${CLAUDE_BASELINE}):`);
  for (const tier of ["full", "partial", "degraded-noop", "not-supported", "na"] as const) {
    const count = CAPABILITY_REGISTRY.filter((e) => e.tier === tier).length;
    lines.push(`  ${tier}: ${count}`);
  }

  return lines.join("\n");
}

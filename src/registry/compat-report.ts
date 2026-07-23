/**
 * Compatibility report — derived from the capability registry so `/doctor` and
 * the generated matrix share the same support claims. buildCompatReport() scans
 * the assembled project; renderDoctorReport() gives a project-specific report.
 */
import fs from "node:fs";
import path from "node:path";

import type {
  CapabilityEntry,
  ClaudeProject,
  HookConfig,
  ResolvedMcpConfig,
} from "../types.js";
import { SUPPORTED_HOOK_EVENTS } from "../types.js";
import { loadPluginHooks, type InstalledPlugin } from "../claude/plugins.js";
import { modelSupportsImages } from "../util/model.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import type { ResolvedCompactionConfig } from "../runtime/steering.js";
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

export interface CompatReport {
  /** Functionality findings (a declared feature simply won't work). */
  findings: CompatFinding[];
  /** Safety-relevant findings (something restricted now runs freely). */
  safetyFindings: CompatFinding[];
  /** Inputs unknown at the baseline — surfaced as unassessed. */
  unassessed: string[];
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
    unassessed.push(`settings key "${key}" (${scope} scope)`);
  }

  // --- Hook configs (settings + skill-scoped) -----------------------------
  // Skill hooks arrive as RAW frontmatter (parseHookConfig normalizes them only at
  // activation), so every shape here is project-controlled input: a single matcher
  // object instead of an array, missing `hooks`, missing handler `type` (defaults
  // to "command"). Scanning must never throw (completeness floor).
  const scanHooks = (config: HookConfig | undefined, where: string) => {
    if (!config || typeof config !== "object") return;
    for (const [event, rawMatchers] of Object.entries(config)) {
      if (!SUPPORTED_EVENT_SET.has(event)) {
        const cap = degradedHookEventCapability(event);
        if (cap) addFinding(cap, `hook event "${event}" configured in ${where}`);
        else unassessed.push(`hook event "${event}" (${where})`);
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
          const cap = lookupCapability(`feature.hook-handler.${type}`);
          if (cap) {
            addFinding(cap, `hook handler type "${type}" on "${event}" in ${where}`);
          } else {
            unassessed.push(`hook handler type "${type}" on "${event}" (${where})`);
          }
        }
      }
    }
  };
  scanHooks(settings.hooks, "settings");
  for (const skill of project.skills) {
    scanHooks(skill.hooks, `skill "${skill.name}"`);
  }
  // Installed-plugin hook configs (folded into mergedHooks at load) must be
  // scanned too — a plugin declaring a Notification event or a prompt/agent
  // handler degrades exactly like the same config in settings.json. Plugins are
  // only present on the assembled LoadedProject; scan defensively when given.
  const plugins = (project as { plugins?: unknown }).plugins;
  if (Array.isArray(plugins)) {
    for (const plugin of plugins) {
      if (!plugin || typeof plugin !== "object") continue;
      const p = plugin as InstalledPlugin;
      if (!Array.isArray(p.hooksFiles) || p.hooksFiles.length === 0) continue;
      const raw = loadPluginHooks(p);
      scanHooks(raw.config as HookConfig, `plugin "${p.name}"`);
    }
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
  for (const agent of project.agents) {
    if (agent.memory !== undefined) {
      const cap = lookupCapability("agent.frontmatter.memory");
      if (cap) addFinding(cap, `agent "${agent.name}" sets memory:`);
    }
    if (agent.mcpServers !== undefined) {
      const cap = lookupCapability("agent.frontmatter.mcpServers");
      if (cap) addFinding(cap, `agent "${agent.name}" sets mcpServers:`);
    }
    if (agent.hooks !== undefined) {
      const cap = lookupCapability("agent.frontmatter.hooks");
      if (cap) addFinding(cap, `agent "${agent.name}" sets hooks:`);
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
  // never a finding). Display hygiene: server NAMES and raw (pre-expansion)
  // diagnostics only; expanded command/args/env values never reach a finding.
  const mcp = project.mcp ?? EMPTY_MCP;
  const pendingNames = mcp.servers
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
  for (const server of mcp.servers) {
    const cap = lookupCapability("feature.mcp");
    if (!cap) continue;
    if (server.diagnostics.length > 0) {
      // Most stored diagnostics already quote the server name; the resolver's
      // unset-${VAR} warnings do not — prefix those so every finding names its
      // server (never expanded values, the diagnostics are raw-only).
      const named = server.diagnostics.map((d) =>
        d.includes(`"${server.name}"`) ? d : `MCP server "${server.name}": ${d}`,
      );
      addFinding(cap, named.join("; "));
    } else if (server.status === "skipped") {
      // A skipped server without stored diagnostics still surfaces, never silently.
      addFinding(cap, `MCP server "${server.name}" (${server.source}) skipped: invalid entry`);
    }
  }
  // Config-level diagnostics (malformed .mcp.json, ignored project-scope
  // approvals, git-tracked settings.local.json demotion) carry their own
  // remedy text — surface each verbatim under the umbrella MCP entry.
  for (const diag of mcp.diagnostics) {
    const cap = lookupCapability("feature.mcp");
    if (cap) addFinding(cap, diag);
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
const MCP_NOTICE_NAME_LIST_MAX = 3;
const MCP_NOTICE_NAME_MAX = 40;

/** Bound on a per-server diagnostic quoted on the /doctor posture line. */
const MCP_POSTURE_DIAG_MAX_CHARS = 240;

function quotedMcpName(name: string, max: number): string {
  return JSON.stringify(mcpStatusScalar(name, max) || "(unnamed)");
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

/**
 * One bounded, terminal-safe line: count, capped structurally quoted names,
 * approval/decline keys, and the /doctor pointer. Startup is otherwise quiet,
 * so this deliberately does NOT carry the full settings edit — the bounded
 * human-facing reports provide the approval and decline guidance.
 */
function buildMcpPendingNotice(pendingNames: string[]): string {
  return (
    `MCP: ${pendingNames.length} server(s) pending approval (` +
    `${mcpNameList(pendingNames, MCP_NOTICE_NAME_LIST_MAX, MCP_NOTICE_NAME_MAX)}) — ` +
    `approve selected names with enabledMcpjsonServers or decline with disabledMcpjsonServers; ` +
    `run /doctor for safe settings guidance.`
  );
}

/**
 * Live per-server state as the runtime reports it. Structural (not imported
 * from runtime/mcp.ts) so the registry layer keeps no runtime dependency;
 * `McpRuntime.serverStates()` satisfies it.
 */
export interface McpServerLiveState {
  name: string;
  state: "connecting" | "connected" | "failed";
  toolCount?: number;
  diagnostic?: string;
  statusSummary?: string;
}

/**
 * Always-present MCP posture line for `/doctor` (the subagent-posture-line
 * pattern): live state per ENABLED server from the runtime, gate state per
 * pending/disabled/skipped server from discovery. Positive/live state lives
 * HERE — never as a finding.
 */
function mcpPostureLine(
  mcp: ResolvedMcpConfig,
  liveStates: readonly McpServerLiveState[],
): string {
  if (mcp.servers.length === 0) return "MCP: no servers configured.";
  const liveByName = new Map(liveStates.map((s) => [s.name, s]));
  const parts = mcp.servers.map((server) => {
    switch (server.status) {
      case "enabled": {
        const live = liveByName.get(server.name);
        // Enabled but unknown to the runtime (states not supplied — e.g. a
        // report rendered without a running session): claim only enablement.
        if (!live) return `${server.name}: enabled`;
        if (live.state === "connected") return `${server.name}: connected (${live.toolCount ?? 0} tool(s))`;
        if (live.state === "connecting") return `${server.name}: connecting`;
        return `${server.name}: failed — ${boundPostureDiag(live.diagnostic ?? "no diagnostic")}`;
      }
      case "pending-approval":
        // No enable/decline hint here — the pending finding rendered below
        // carries the bounded guidance; repeating it would duplicate it.
        return `${server.name}: pending approval`;
      case "disabled":
        return `${server.name}: disabled (disabledMcpjsonServers)`;
      case "skipped": {
        const reason = server.diagnostics[0];
        return `${server.name}: skipped${reason ? ` — ${boundPostureDiag(reason)}` : ""}`;
      }
      default: {
        // Exhaustiveness backstop: a new ResolvedMcpServer status must be
        // rendered deliberately, never silently mislabeled as skipped.
        const unreachable: never = server.status;
        return `${server.name}: ${String(unreachable)}`;
      }
    }
  });
  return `MCP servers: ${parts.join("; ")}.`;
}

const MCP_STATUS_DETAIL_MAX = 32;
const MCP_STATUS_NAME_MAX = 120;
const MCP_STATUS_SUMMARY_MAX = 180;
const MCP_STATUS_REPORT_MAX = 16_384;

type McpRenderedState =
  | "enabled"
  | "connecting"
  | "connected"
  | "failed"
  | "pending approval"
  | "disabled"
  | "skipped";

const MCP_RENDERED_STATE_ORDER: readonly McpRenderedState[] = [
  "enabled",
  "connecting",
  "connected",
  "failed",
  "pending approval",
  "disabled",
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
    return server.status === "pending-approval" ? "pending approval" : server.status;
  }
  return live?.state ?? "enabled";
}

function mcpStatusRow(
  server: ResolvedMcpConfig["servers"][number],
  live: McpServerLiveState | undefined,
): string {
  const name = quotedMcpName(server.name, MCP_STATUS_NAME_MAX);
  switch (mcpEffectiveState(server, live)) {
    case "enabled":
      return `- ${name}: enabled; runtime state unavailable`;
    case "connecting":
      return `- ${name}: connecting`;
    case "connected": {
      const rawCount = live?.toolCount;
      const count = Number.isSafeInteger(rawCount) && (rawCount ?? -1) >= 0 ? rawCount! : 0;
      return `- ${name}: connected (${count} ${count === 1 ? "tool" : "tools"})`;
    }
    case "failed": {
      const summary = mcpStatusScalar(live?.statusSummary ?? "", MCP_STATUS_SUMMARY_MAX);
      return `- ${name}: failed — ${summary || "Connection failed; no safe summary is available; run /doctor for details."}`;
    }
    case "pending approval":
      return `- ${name}: pending approval`;
    case "disabled":
      return `- ${name}: disabled`;
    case "skipped":
      return `- ${name}: skipped — configuration is unusable; run /doctor for details`;
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
  const config = mcp ?? EMPTY_MCP;
  const lines = ["MCP status (read-only)"];
  if (config.servers.length === 0) {
    lines.push(
      config.diagnostics.length > 0
        ? "No usable MCP servers were resolved."
        : "No MCP servers are configured.",
    );
  } else {
    lines.push(`Configured servers: ${config.servers.length}`);
  }

  const liveByName = mcpLiveByName(liveStates);
  const detailCount = Math.min(config.servers.length, MCP_STATUS_DETAIL_MAX);
  for (let index = 0; index < detailCount; index += 1) {
    const server = config.servers[index]!;
    lines.push(mcpStatusRow(server, liveByName.get(server.name)));
  }

  if (config.servers.length > detailCount) {
    const omitted = new Map<McpRenderedState, number>();
    for (let index = detailCount; index < config.servers.length; index += 1) {
      const server = config.servers[index]!;
      const state = mcpEffectiveState(server, liveByName.get(server.name));
      omitted.set(state, (omitted.get(state) ?? 0) + 1);
    }
    const groups = MCP_RENDERED_STATE_ORDER.flatMap((state) => {
      const count = omitted.get(state);
      return count === undefined ? [] : [`${state}: ${count}`];
    });
    lines.push(`Omitted ${config.servers.length - detailCount} servers (${groups.join(", ")}).`);
  }

  if (
    config.diagnostics.length > 0 ||
    config.servers.some((server) => server.diagnostics.length > 0)
  ) {
    lines.push("Some MCP configuration was malformed, ignored, or unusable; run /doctor for details.");
  }

  const pending = config.servers.filter((server) => server.status === "pending-approval");
  const allPendingDisplayed = !config.servers
    .slice(MCP_STATUS_DETAIL_MAX)
    .some((server) => server.status === "pending-approval");
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
    mcpPostureLine(project.mcp ?? EMPTY_MCP, mcpStates ?? []),
    ...(compaction ? [compactionKnobsLine(compaction, activeModel)] : []),
    "",
  ];

  const grouped = groupByCapability([...report.safetyFindings, ...report.findings]);
  if (grouped.length === 0) {
    lines.push("No compatibility findings detected.");
  } else {
    lines.push("Findings (declared by this project, not fully honored):");
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

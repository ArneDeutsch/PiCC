/**
 * Compatibility report — generated from the capability registry so it cannot
 * drift from actual behavior.
 *
 * On config load, buildCompatReport() scans the assembled project for
 * declared-but-not-fully-honored usage. renderStartupNotice() emits ONE
 * consolidated, suppressible notice per session; renderDoctorReport() gives
 * the full /doctor breakdown on demand. Never silent, never nagging.
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
import type { ResolvedCompactionConfig } from "../runtime/steering.js";
import { parseJsonSafe, readTextSafe } from "../util/fs.js";
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
   * Pending-approval MCP servers, as a startup-notice text DECOUPLED from
   * `/compat suppress` (the vision-warning precedent: suppression acknowledges
   * findings, not new actionable state). First line short and self-contained.
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
      // Names-only plus a pointer: the startup notice (mcpPendingNotice below)
      // is the ONE canonical carrier of the exact enable/decline settings edit.
      // In /doctor this evidence renders beside the gate entry's registry note,
      // which names the enabling and decline keys.
      addFinding(
        cap,
        `MCP server(s) pending approval: ${mcpNameList(pendingNames)} — the startup ` +
          `notice carries the exact enable/decline settings edit`,
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
// MCP surfaces — pending notice + /doctor posture line
// ---------------------------------------------------------------------------

const EMPTY_MCP: ResolvedMcpConfig = { servers: [], diagnostics: [] };

/** Cap on server names quoted in one list — a hostile config must not flood a line. */
const MCP_NAME_LIST_MAX = 8;

/** Bound on a per-server diagnostic quoted on the /doctor posture line. */
const MCP_POSTURE_DIAG_MAX_CHARS = 240;

function mcpNameList(names: string[]): string {
  const shown = names.slice(0, MCP_NAME_LIST_MAX).join(", ");
  const rest = names.length - MCP_NAME_LIST_MAX;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

function boundPostureDiag(text: string): string {
  return text.length > MCP_POSTURE_DIAG_MAX_CHARS
    ? `${text.slice(0, MCP_POSTURE_DIAG_MAX_CHARS)}…`
    : text;
}

/**
 * Two lines, vision-warning convention: a short, self-contained first line
 * that survives toast truncation (servers + the enabling key), then a fuller
 * line with the exact settings edit for BOTH exits — enable and decline.
 * This notice is the ONE canonical carrier of that edit — the pending finding
 * and the /doctor posture line point here instead of repeating it.
 */
function buildMcpPendingNotice(pendingNames: string[]): string {
  const count = pendingNames.length;
  // Bounding: past the name-list cap a verbatim JSON enumeration would flood
  // the notice — recommend the blanket key instead of listing every name.
  const edit =
    count > MCP_NAME_LIST_MAX
      ? `Add "enableAllProjectMcpServers": true (or list a subset in ` +
        `"enabledMcpjsonServers") in .claude/settings.local.json to start them; list a `
      : `Add "enabledMcpjsonServers": ${JSON.stringify(pendingNames)} (or ` +
        `"enableAllProjectMcpServers": true) to .claude/settings.local.json to start them; list a `;
  return (
    `MCP: ${count} server(s) pending approval (${mcpNameList(pendingNames)}) — enable with ` +
    `enabledMcpjsonServers in .claude/settings.local.json.\n` +
    edit +
    `server in "disabledMcpjsonServers" to decline it and silence this notice.`
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
        // (registry note + evidence) and the canonical startup notice carry
        // the edit; repeating it on the posture line triplicated it.
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Startup-notice line(s) for one grouped finding. MCP capabilities render
 * SHORT — one line per evidence item, no registry note: their notes run to
 * ~2 KB each (a two-server project produced a 3.4 KB notice), and the
 * evidence already carries the actionable fact. The full note remains a
 * /doctor surface; every other capability keeps the note-bearing format.
 */
function noticeFindingLines(
  group: { capability: CapabilityEntry; evidence: string[] },
  indent: string,
): string[] {
  const { capability, evidence } = group;
  if (capability.id.startsWith("feature.mcp") || capability.id.startsWith("tool.mcp__")) {
    return evidence.map((ev) => `${indent}- ${capability.id}: ${ev}`);
  }
  return [`${indent}- ${capability.id}: ${capability.note} [${evidence.join("; ")}]`];
}

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
// the terminal's render capability. It tells a user whether their model can
// actually see image inputs (image files, pasted/dropped images, notebook image outputs), so a
// non-vision GPT/Codex user is never silently misled into thinking a pasted
// screenshot or notebook plot reached the model.
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

/**
 * The high-value startup warning: emitted ONLY when the active model is known
 * and definitively non-vision (a readable `input` array that lacks "image").
 * Returns undefined for a vision-capable model (the positive line is
 * `/doctor`-only), for an opaque/absent model, and for a model with an `id` but
 * no readable modality array (don't nag when we can't tell — `/doctor` still
 * reports "unknown"). The FIRST line is short and self-contained with the remedy
 * so it survives toast truncation on a narrow terminal; a second, fuller line
 * carries the detail for the notice body / `/doctor`.
 */
function nonVisionStartupWarning(model: unknown): string | undefined {
  const id = activeModelId(model);
  if (id === undefined) return undefined;
  if (!modelHasVisionAxis(model)) return undefined;
  if (modelSupportsImages(model)) return undefined;
  return (
    `Active model ${id} is not vision-capable — images sent as text; use a vision-capable model.\n` +
    "Image inputs (image files, pasted/dropped images, notebook image outputs) are sent as text placeholders, not seen by the model."
  );
}

/**
 * ONE consolidated startup notice per session.
 * Returns undefined when suppressed or when there is nothing to report.
 */
export function renderStartupNotice(
  report: CompatReport,
  opts: { suppressed: boolean; activeModel?: unknown },
): string | undefined {
  // The non-vision active-model warning is DECOUPLED from project-findings
  // suppression. `/compat suppress` acknowledges this project's compat findings,
  // but whether the ACTIVE model can see images is a separate, safety-relevant
  // axis (a user may suppress on a vision model, then later switch to a non-vision
  // one). So it is computed independent of `suppressed`, and when present it is
  // always the FIRST line — the emission site builds the toast from that line.
  const visionWarning = nonVisionStartupWarning(opts.activeModel);
  // The MCP pending-approval notice is equally decoupled from suppression: a
  // pending server is NEW actionable state, and the user who declines has the
  // first-class quiet path (disabledMcpjsonServers) instead of /compat suppress.
  // The vision warning keeps its documented FIRST-line slot; pending follows.
  const pendingNotice = report.mcpPendingNotice;

  // Suppression silences only the project-findings body/header. A non-vision
  // model and pending MCP servers still surface through suppression; otherwise
  // a suppressed session stays fully silent (undefined).
  if (opts.suppressed) {
    const decoupled = [visionWarning, pendingNotice].filter((l) => l !== undefined);
    return decoupled.length > 0 ? decoupled.join("\n") : undefined;
  }

  const safety = groupByCapability(report.safetyFindings);
  const functionality = groupByCapability(report.findings);
  const degradedCount = safety.length + functionality.length + report.unassessed.length;

  if (degradedCount === 0 && visionWarning === undefined && pendingNotice === undefined) {
    return undefined;
  }

  const lines: string[] = [];
  if (visionWarning !== undefined) lines.push(visionWarning);
  if (pendingNotice !== undefined) lines.push(pendingNotice);
  if (degradedCount > 0) {
    lines.push(`PiCC compatibility: ${degradedCount} feature(s) degraded for this project`);
  }
  if (safety.length > 0) {
    lines.push("SAFETY:");
    for (const g of safety) {
      lines.push(...noticeFindingLines(g, "  "));
    }
  }
  for (const g of functionality) {
    lines.push(...noticeFindingLines(g, ""));
  }
  if (report.unassessed.length > 0) {
    lines.push(
      `- unassessed (unknown at baseline ${CLAUDE_BASELINE}): ${report.unassessed.length} item(s)`,
    );
  }
  lines.push("Run /doctor for details. (Suppress with /compat suppress)");
  return lines.join("\n");
}

const TIER_ORDER = ["partial", "degraded-noop", "not-supported", "na", "full"] as const;

/**
 * Always-present subagent nesting-posture line for `/doctor`. `subagents.*` are
 * PiCC extensions (not Claude-settings parity); the main-session-only default is
 * a deliberate divergence from Claude Code (nests up to 5). Reads the *effective*
 * `subagentMaxDepth` — at render time we cannot tell an explicit value from the
 * default, so we branch on the number and never claim more than is true.
 */
function subagentPostureLine(project: ClaudeProject): string {
  const { subagentsEnabled, subagentMaxDepth } = project.settings;
  if (subagentsEnabled === false) {
    return "Subagent nesting: subagent dispatch disabled (subagents.enabled=false / disableSubagents:true); no delegation.";
  }
  if (subagentMaxDepth === 1) {
    return "Subagent nesting: main-session-only (subagents.maxDepth=1, PiCC default; Claude Code nests up to 5). Raise subagents.maxDepth to 2..5 in .claude/settings.json to allow nested delegation.";
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
  return `Subagent nesting: subagents.maxDepth=${subagentMaxDepth} (a PiCC extension). Set it to 1 for main-session-only, or 2..5 to allow nested delegation.`;
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

/** Full /doctor breakdown, generated from the registry. */
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
    lines.push("No compatibility findings: everything this project declares is fully honored.");
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

// ---------------------------------------------------------------------------
// Suppression persistence — suppressible once acknowledged
// ---------------------------------------------------------------------------

/**
 * Harness-owned, non-tracked location: `.claude/.picc/` is PiCC state, never a
 * tracked project file.
 */
function suppressionPath(projectRoot: string): string {
  return path.join(projectRoot, ".claude", ".picc", "compat-ack.json");
}

/** True when the startup notice has been acknowledged/suppressed for this project. */
export function readSuppression(projectRoot: string): boolean {
  const data = parseJsonSafe<{ suppressed?: unknown }>(
    readTextSafe(suppressionPath(projectRoot)),
  );
  return data?.suppressed === true;
}

/** Persist the suppression flag (creates `.claude/.picc/` as needed). Never throws. */
export function writeSuppression(projectRoot: string, v: boolean): void {
  const file = suppressionPath(projectRoot);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ suppressed: v }, null, 2)}\n`, "utf8");
  } catch {
    // completeness floor: suppression is a convenience, never fatal
  }
}

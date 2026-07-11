/**
 * Compatibility report (plan §6.2) — generated from the capability registry
 * (§17) so it cannot drift from actual behavior.
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
} from "../types.js";
import { SUPPORTED_HOOK_EVENTS } from "../types.js";
import { parseJsonSafe, readTextSafe } from "../util/fs.js";
import {
  CAPABILITY_REGISTRY,
  CLAUDE_BASELINE,
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
  /** Safety-relevant findings (something restricted now runs freely) — §6.2. */
  safetyFindings: CompatFinding[];
  /** Inputs unknown at the baseline — surfaced as unassessed (§2.4, §17). */
  unassessed: string[];
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
      note: "recognized key gating a deferred subsystem — parsed, no-op (§7)",
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

  // --- Permissions (§6.1 posture) ---------------------------------------
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

  // --- Settings keys ------------------------------------------------------
  for (const { key, scope } of settings.deferredKeys) {
    addFinding(deferredSettingCapability(key), `settings key "${key}" (${scope} scope)`);
  }
  for (const { key, scope } of settings.unknownKeys) {
    unassessed.push(`settings key "${key}" (${scope} scope)`);
  }

  // --- Hook configs (settings + skill-scoped) -----------------------------
  const scanHooks = (config: HookConfig | undefined, where: string) => {
    if (!config) return;
    for (const [event, matchers] of Object.entries(config)) {
      if (!SUPPORTED_EVENT_SET.has(event)) {
        const cap = degradedHookEventCapability(event);
        if (cap) addFinding(cap, `hook event "${event}" configured in ${where}`);
        else unassessed.push(`hook event "${event}" (${where})`);
      }
      for (const matcher of matchers ?? []) {
        for (const handler of matcher.hooks ?? []) {
          if (handler.type === "command") continue;
          const cap = lookupCapability(`feature.hook-handler.${handler.type}`);
          if (cap) {
            addFinding(cap, `hook handler type "${handler.type}" on "${event}" in ${where}`);
          } else {
            unassessed.push(`hook handler type "${handler.type}" on "${event}" (${where})`);
          }
        }
      }
    }
  };
  scanHooks(settings.hooks, "settings");
  for (const skill of project.skills) {
    scanHooks(skill.hooks, `skill "${skill.name}"`);
  }

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
    for (const tool of agent.tools ?? []) {
      if (tool === "*") continue;
      const known =
        lookupCapability(`tool.${tool}`) ??
        (tool.startsWith("mcp__") ? capabilityForToolName(tool) : undefined);
      if (!known) {
        unassessed.push(`tool "${tool}" (agent "${agent.name}" tools:)`);
      } else if (known.tier === "degraded-noop" || known.tier === "not-supported") {
        addFinding(known, `agent "${agent.name}" lists tool "${tool}" in tools:`);
      }
    }
    for (const key of agent.unknownKeys) {
      unassessed.push(`agent "${agent.name}" frontmatter key "${key}"`);
    }
  }

  // --- Skills (unknown frontmatter) ---------------------------------------
  for (const skill of project.skills) {
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

  // --- .mcp.json at the project root (filesystem check) --------------------
  try {
    if (fs.statSync(path.join(project.root, ".mcp.json")).isFile()) {
      const cap = lookupCapability("feature.mcp");
      if (cap) addFinding(cap, ".mcp.json present at project root — MCP servers will not start");
    }
  } catch {
    // absent or unreadable — nothing to report (completeness floor)
  }

  // De-duplicate findings (same capability + same evidence) and unassessed.
  const seen = new Set<string>();
  const deduped = all.filter((f) => {
    const key = `${f.capability.id}|${f.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    findings: deduped.filter((f) => f.capability.safetyRelevant !== true),
    safetyFindings: deduped.filter((f) => f.capability.safetyRelevant === true),
    unassessed: [...new Set(unassessed)],
  };
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

/**
 * ONE consolidated startup notice per session (§6.2).
 * Returns undefined when suppressed or when there is nothing to report.
 */
export function renderStartupNotice(
  report: CompatReport,
  opts: { suppressed: boolean },
): string | undefined {
  if (opts.suppressed) return undefined;

  const safety = groupByCapability(report.safetyFindings);
  const functionality = groupByCapability(report.findings);
  const degradedCount = safety.length + functionality.length + report.unassessed.length;
  if (degradedCount === 0) return undefined;

  const lines: string[] = [
    `PiCC compatibility: ${degradedCount} feature(s) degraded for this project`,
  ];
  if (safety.length > 0) {
    lines.push("SAFETY:");
    for (const g of safety) {
      lines.push(`  - ${g.capability.id}: ${g.capability.note} [${g.evidence.join("; ")}]`);
    }
  }
  for (const g of functionality) {
    lines.push(`- ${g.capability.id}: ${g.capability.note} [${g.evidence.join("; ")}]`);
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

/** Full /doctor breakdown (§6.2), generated from the registry (§17). */
export function renderDoctorReport(project: ClaudeProject, report: CompatReport): string {
  const lines: string[] = [
    `PiCC compatibility report — baseline ${CLAUDE_BASELINE}`,
    `Project: ${project.root}`,
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
// Suppression persistence (§6.2 — suppressible once acknowledged)
// ---------------------------------------------------------------------------

/**
 * Harness-owned, non-tracked location per §2.3: `.claude/.picc/` is
 * PiCC state, never a tracked project file.
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

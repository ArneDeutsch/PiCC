import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// In-process matrix renderer: importing this does NOT spawn or write —
// the .mjs runs its CLI only when executed directly. Lets the freshness guard
// regenerate the matrix deterministically without a child process / CRLF flake.
import { renderCapabilityMatrix } from "../scripts/gen-capability-matrix.mjs";

import {
  CAPABILITY_REGISTRY,
  CLAUDE_BASELINE,
  PROACTIVE_COMPACTION_APIS,
  capabilityForToolName,
  lookupCapability,
} from "../src/registry/capability-registry.js";
import {
  buildCompatReport,
  renderDoctorReport,
} from "../src/registry/compat-report.js";
import { normalizeMcpServerBlock } from "../src/claude/mcp-config.js";
import { resolveInstalledPlugins } from "../src/claude/plugins.js";
import { resolveMcpConfig } from "../src/discovery/mcp.js";
import { loadSettings } from "../src/discovery/settings.js";
import { DEGRADED_TOOLS } from "../src/runtime/tools/degrade-stubs.js";
import { sniffImageMime } from "../src/runtime/image-ingest.js";
import { renderNotebook } from "../src/runtime/notebook-render.js";
import type { PluginInventoryItem, PluginInventorySnapshot } from "../src/plugin-inventory.js";
import type {
  ClaudeAgent,
  ClaudeProject,
  ClaudeSettings,
  ClaudeSkill,
  ResolvedMcpConfig,
  ResolvedMcpServer,
  SourceRef,
  SupportTier,
} from "../src/types.js";
import { SUPPORTED_HOOK_EVENTS } from "../src/types.js";

type DisclosureCategory = "core" | "gap" | "precedence" | "visibility" | "parity" | "split";

type DisclosureContract = {
  id: string;
  tier: SupportTier;
  safetyRelevant?: true;
} & Partial<Record<DisclosureCategory, readonly RegExp[]>> & { core: readonly RegExp[] };

function expectDisclosure(contract: DisclosureContract): void {
  const entry = lookupCapability(contract.id);
  expect(entry, contract.id).toBeDefined();
  expect(entry).toMatchObject({ id: contract.id, tier: contract.tier });
  expect(Boolean(entry?.safetyRelevant), `${contract.id}: safetyRelevant`)
    .toBe(contract.safetyRelevant ?? false);
  const note = entry?.note ?? "";
  for (const category of ["core", "gap", "precedence", "visibility", "parity", "split"] as const) {
    for (const predicate of contract[category] ?? []) {
      expect(note, `${contract.id}: ${category} ${predicate}`).toMatch(predicate);
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const SOURCE: SourceRef = { path: "<virtual>", scope: "project" };

function makeSettings(overrides: Partial<ClaudeSettings> = {}): ClaudeSettings {
  return {
    permissions: {
      allow: [],
      deny: [],
      ask: [],
      additionalDirectories: [],
    },
    hooks: {},
    env: {},
    disableAllHooks: false,
    disableSkillShellExecution: false,
    skillOverrides: {},
    claudeMdExcludes: [],
    worktree: { baseRef: "head" },
    subagentsEnabled: true,
    subagentMaxDepth: 2,
    subagentConcurrency: 4,
    enabledPlugins: undefined,
    unknownKeys: [],
    deferredKeys: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeSkill(overrides: Partial<ClaudeSkill> = {}): ClaudeSkill {
  return {
    name: "test-skill",
    description: "a test skill",
    userInvocable: true,
    disableModelInvocation: false,
    contextFork: false,
    shell: "bash",
    metadata: {},
    baseDir: "<virtual>",
    source: SOURCE,
    legacyCommand: false,
    unknownKeys: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeAgent(overrides: Partial<ClaudeAgent> = {}): ClaudeAgent {
  return {
    name: "test-agent",
    description: "a test agent",
    metadata: {},
    body: "You are a test agent.",
    source: SOURCE,
    unknownKeys: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeInventoryItem(qualifiedIdentity: string, overrides: Partial<PluginInventoryItem> = {}): PluginInventoryItem {
  const separator = qualifiedIdentity.lastIndexOf("@");
  return {
    qualifiedIdentity,
    lifecycleName: qualifiedIdentity.slice(0, separator),
    marketplaceName: qualifiedIdentity.slice(separator + 1),
    catalogPresence: false,
    installations: [],
    catalogDeclarations: [],
    dependencies: [],
    renames: [],
    components: [],
    executionRisk: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeInventory(items: readonly PluginInventoryItem[], overrides: Partial<PluginInventorySnapshot> = {}): PluginInventorySnapshot {
  const values = [...items];
  return {
    capturedAt: "2026-01-01T00:00:00.000Z",
    lifetime: "session",
    refreshGuidance: "caller-provided wording must not be trusted",
    installedStateStatus: "valid",
    items: values,
    marketplaces: [],
    marketplaceCatalogs: [],
    allowlistObservations: [],
    conflictObservations: [],
    policyObservations: [],
    diagnostics: [],
    capabilityEvidence: [],
    omissions: {},
    find: (identity) => values.find((value) => value.qualifiedIdentity === identity),
    ...overrides,
  };
}

function makeProject(overrides: Partial<ClaudeProject> = {}): ClaudeProject {
  return {
    root: path.join(os.tmpdir(), "picc-nonexistent-root"),
    cwd: path.join(os.tmpdir(), "picc-nonexistent-root"),
    userDir: path.join(os.tmpdir(), "picc-nonexistent-home", ".claude"),
    settings: makeSettings(),
    skills: [],
    agents: [],
    rules: [],
    claudeMd: [],
    diagnostics: [],
    ...overrides,
  };
}

function makeMcpServer(
  overrides: Record<string, unknown> & Pick<ResolvedMcpServer, "name" | "status">,
): ResolvedMcpServer {
  if (overrides.status !== "enabled") {
    return {
      source: "project-mcpjson",
      transport: "stdio",
      diagnostics: [],
      ...overrides,
    } as ResolvedMcpServer;
  }
  return {
    source: "project-mcpjson",
    transport: "stdio",
    command: "",
    args: [],
    env: {},
    rawCommand: "",
    diagnostics: [],
    ...overrides,
  } as ResolvedMcpServer;
}

function makeMcp(overrides: Partial<ResolvedMcpConfig> = {}): ResolvedMcpConfig {
  return { servers: [], diagnostics: [], ...overrides };
}

function resolveAuditedMcp(block: Record<string, unknown>): ResolvedMcpConfig {
  const names = Object.keys(block);
  return resolveMcpConfig({
    projectRoot: path.join(os.tmpdir(), "picc-registry-audit-root"),
    mcpJson: {
      servers: normalizeMcpServerBlock(block, ".mcp.json"),
      diagnostics: [],
      present: true,
    },
    mcpSettings: [{
      scope: "user",
      sourcePath: path.join(os.tmpdir(), "picc-registry-audit-user-settings.json"),
      enabledMcpjsonServers: names,
    }],
    env: {} as NodeJS.ProcessEnv,
    isGitTracked: () => false,
  });
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-registry-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// Registry invariants
// ---------------------------------------------------------------------------

describe("CAPABILITY_REGISTRY invariants", () => {
  it("has no duplicate ids", () => {
    const ids = CAPABILITY_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has a non-empty one-line note", () => {
    for (const e of CAPABILITY_REGISTRY) {
      expect(e.note.trim().length, `note for ${e.id}`).toBeGreaterThan(0);
      expect(e.note, `note for ${e.id} must be one line`).not.toContain("\n");
    }
  });

  it("every entry has a valid kind and tier", () => {
    const kinds = new Set(["artifact", "frontmatter", "tool", "hook-event", "setting", "feature"]);
    const tiers = new Set(["full", "partial", "degraded-noop", "not-supported", "na"]);
    for (const e of CAPABILITY_REGISTRY) {
      expect(kinds.has(e.kind), `kind for ${e.id}`).toBe(true);
      expect(tiers.has(e.tier), `tier for ${e.id}`).toBe(true);
    }
  });

  it("marks ask rules and permission modes as safety-relevant degraded no-ops", () => {
    const ask = lookupCapability("setting.permissions.ask");
    expect(ask?.tier).toBe("degraded-noop");
    expect(ask?.safetyRelevant).toBe(true);

    const mode = lookupCapability("setting.permissions.defaultMode");
    expect(mode?.tier).toBe("degraded-noop");
    expect(mode?.safetyRelevant).toBe(true);
  });

  it("keeps deny as a full-tier safety valve and allow as partial", () => {
    expect(lookupCapability("setting.permissions.deny")?.tier).toBe("full");
    expect(lookupCapability("setting.permissions.allow")?.tier).toBe("partial");
  });

  it("keeps supported hooks full except the explicit lifecycle partials", () => {
    const partial = new Set(["SessionStart", "PreCompact", "PostCompact", "WorktreeCreate"]);
    for (const ev of SUPPORTED_HOOK_EVENTS) {
      expect(lookupCapability(`hook.event.${ev}`)?.tier, ev).toBe(partial.has(ev) ? "partial" : "full");
    }
    const sessionStart = lookupCapability("hook.event.SessionStart")?.note ?? "";
    expect(sessionStart).toContain("startup|resume|clear|compact|fork");
    expect(sessionStart).toContain("startup and reload reasons map to startup");
    expect(sessionStart).toContain("new maps to clear");
    expect(sessionStart).not.toContain("fork source is missing");

    const worktreeCreate = lookupCapability("hook.event.WorktreeCreate")?.note ?? "";
    expect(worktreeCreate).toContain("after worktree creation and entry");
    expect(worktreeCreate).toContain("ordinary nonzero/exit-2 hook outcomes cannot abort creation");
    expect(worktreeCreate).toContain("Universal continue:false aborts subsequent run processing");
    expect(worktreeCreate).toContain("tool result remain truthful");
  });

  it.each<DisclosureContract>([
    { id: "tool.mcp__*", tier: "partial", core: [/transport-neutral MCP tool proxies/, /current client/], gap: [/fixed local transient wording/, /fixed local terminal wording/], precedence: [/deny enforcement/, /subagent inheritance/], visibility: [/model-facing protocol-result trust behavior/], split: [/feature\.mcp-list-changed/, /feature\.mcp-remote-transports/] },
    { id: "setting.mcpServers", tier: "partial", core: [/retained PiCC compatibility extension/, /explicit http/, /streamable-http/, /deprecated sse/, /static-header/], gap: [/unconfirmed upstream settings-file semantics/, /upstream ordering interaction is unverified/, /Native runtime disablement applies only to authentic native\/\.mcp\.json winners, never settings-extension winners/], precedence: [/present standalone managed-mcp\.json suppresses this source entirely/, /authentic Claude sources always outrank it/, /native local > project \.mcp\.json > native user/, /managed settings extension > untracked settings\.local\.json extension > project settings extension > user settings extension/, /central policy admission before approval, native disablement, or materialization/, /all applicable inactive gates run before expansion/, /inactive entries materialize no command, URL, or headers/], visibility: [/size\/count\/syntax caps/, /reserved transport-header restrictions/], parity: [/ambient launch environment/, /not settings.env/], split: [/feature\.mcp-remote-transports/] },
    { id: "setting.enableAllProjectMcpServers", tier: "partial", core: [/blanket approval/, /current and future project server/, /NOT a shortcut for a large pending set/], gap: [/replacing Claude Code's interactive trust dialog/], precedence: [/Nearest-honored-scope-wins/, /disabledMcpjsonServers always wins/], visibility: [/ignored with a diagnostic/], parity: [/PiCC's settings gate/], split: [/feature\.mcp-project-approval/] },
    { id: "setting.enabledMcpjsonServers", tier: "partial", core: [/per-server approval list/, /user-authored scopes/, /outside ASCII letters, digits/, /persisted named approval can therefore match a differently named current or future server/, /re-review aliases when project MCP names change/], gap: [/accumulate-and-dedupe of the lists across settings files remains PiCC-inferred/], precedence: [/Approval from ANY honored scope wins/, /disabledMcpjsonServers always wins/], visibility: [/ignored with a diagnostic/], parity: [/Claude parity, binary-verified/], split: [/feature\.mcp-project-approval/] },
    { id: "setting.disabledMcpjsonServers", tier: "full", core: [/per-server decline list/, /honored from EVERY scope/, /outside ASCII letters, digits/], precedence: [/always wins over enableAllProjectMcpServers and enabledMcpjsonServers/], visibility: [/declined server raises no expansion warnings/], parity: [/binary-corroborated/, /accumulate-and-dedupe across settings files remains PiCC-inferred/] },
    { id: "feature.mcp", tier: "partial", core: [/enabled stdio and remote/, /admitted from standalone managed MCP or selected from native Claude local\/user state/, /non-blockingly/, /aggregate initial-settlement opportunity/, /advertised tools, prompts, or resources capability list/], gap: [/stdio children/, /do not reconnect/, /remote lifecycle/], precedence: [/Standalone exclusive control and settings policy are resolved before post-admission materialization/, /blocked servers never reach runtime/], visibility: [/zero MCP context/], split: [/feature\.mcp-remote-transports/] },
    { id: "feature.mcp-claude-json-scopes", tier: "partial", core: [/read-only native Claude state loading/, /top-level user mcpServers/, /canonical project's local mcpServers/, /public local\/user\/project scope concepts are documented/, /one coherent user profile/, /user-scoped settings and artifacts/, /imported installed-plugin state and data/, /Project and managed contributions plus supplementary authorized plugin roots remain in effect/, /Bounded canonical-equivalent MCP projections coalesce when equivalent/, /bounded individual server definitions retain skip-or-adjust handling/], gap: [/private \.claude\.json physical shape is inferred/, /conservative PiCC policies/, /upstream canonicalization/, /multiple canonical-equivalent project record semantics.*remain inferred or unverified/], precedence: [/Native state is acquired only when standalone managed MCP is absent/, /central policy admission before native disablement or materialization/, /local > project \.mcp\.json > user/, /settings extension/], visibility: [/Only conflicting projections or invalid matching project-record, MCP-block, or runtime-list shapes make matching project state unusable and fail all MCP loading closed/, /absent state file preserves other sources/, /fails all MCP closed before expansion/, /bounded value-redacted diagnostics/], parity: [/not verified Claude behavior for multiple canonical-equivalent project records/, /State is never modified/] },
    { id: "feature.mcp-runtime-disabled", tier: "partial", safetyRelevant: true, core: [/exact-name `disabledMcpServers`/, /final pre-expansion deny/, /authentic native local, project \.mcp\.json, and native user winners/], gap: [/does not disable settings-extension winners/, /exact private-state persistence, list interpretation, upstream matching.*inferred or unverified/], precedence: [/after central policy admission/, /when standalone exclusive control is absent/], visibility: [/cannot edit the list/] },
    { id: "feature.mcp-project-approval", tier: "partial", core: [/project-origin stdio and remote/, /disabled by default/, /name approval/], gap: [/name-based, not definition-bound/, /same-name command, URL, or header change remains approved/], precedence: [/after central policy admission/, /only when standalone exclusive control is absent/, /disabledMcpjsonServers always rejects/, /Native local and user definitions are not project-gated/, /native disabledMcpServers before expansion/], visibility: [/re-review definitions/], parity: [/settings gate/, /interactive trust dialog/] },
    { id: "feature.mcp-control-status", tier: "partial", core: [/bounded read-only/, /connecting\/retrying\/connected\/reconnecting\/failed/, /attempt bounds/, /tool\/prompt\/resource capability counts/, /advertised-empty/, /capability-discovery-failed/, /terminal-retained catalogs/], gap: [/PiCC-defined/], precedence: [/prioritize actionable states/], visibility: [/never includes endpoints, headers, or raw transport failure speech/, /never enters model context/], parity: [/SSE deprecation/] },
    { id: "feature.mcp-remote-transports", tier: "partial", core: [/http\/streamable-http/, /deprecated sse/, /static headers/, /replayable requests capped at 1 MiB/], gap: [/Initial connection/, /reconnects/], precedence: [/aggregate MCP_TIMEOUT/, /permanent failures stop immediately/], visibility: [/same-origin redirects only/, /no cross-origin header forwarding/], split: [/feature\.mcp/, /setting\.mcpServers/, /tool\.mcp__\*/, /feature\.mcp-control-status/, /feature\.mcp-project-approval/] },
  ])("retains $id semantic disclosure", (contract) => {
    expectDisclosure(contract);
  });

  it("keeps summary recovery scoped and separate from proactive admission", () => {
    expectDisclosure({
      id: "feature.compaction-summary-recovery",
      tier: "partial",
      core: [
        /Default provider-backed/,
        /automatic/,
        /manual/,
        /split-turn/,
        /branch Codex summaries/,
        /shared summarization seam/,
        /summary-only SSE/,
        /provider maxRetries: 0/,
        /configured bounded summarization loop/,
        /sole owner/,
        /transient transport\/provider-overload classification/,
        /attempts/,
        /abortable exponential backoff/,
        /retry lifecycle events/,
      ],
      gap: [/cancellation and deterministic failures stop category-appropriately/],
      precedence: [/Ordinary PiCC Agent turns/, /non-Codex summaries/, /retain their configured transport and provider retry behavior/],
      visibility: [
        /COMPATIBILITY BOUNDARY/,
        /public request fields cannot prove provenance/,
        /exact-signature custom caller/,
        /until Pi exposes a purpose marker/,
      ],
      parity: [/PiCC reliability hardening/, /NOT Claude Code transport\/retry parity/],
    });
    const proactiveCapability = lookupCapability("feature.proactive-compaction-policy");
    const proactive = proactiveCapability?.note ?? "";
    const supportedApis = [...PROACTIVE_COMPACTION_APIS]
      .map((api, index, apis) => index === apis.length - 1 ? `and ${api}` : api)
      .join(", ");
    expect(proactiveCapability?.tier).toBe("partial");
    expect(proactive).toContain(
      `Admission is limited to main sessions and PiCC-created children using Pi's APIs: ${supportedApis}.`,
    );
    for (const boundary of [
      /PiCC HARDENING/,
      /Fresh successful tool-requesting assistant usage can queue/,
      /already-requested tools finish/,
      /turn_end handles the complete batch/,
      /before_provider_request is the final idle-to-armed sample/,
      /admission abort blocks ordinary provider transport/,
      /agent_settled is the only boundary that may start one physical Pi compaction transaction if the checkpoint is still required/,
      /only after no provider response or tool batch remains unresolved/,
      /rather than verified Claude parity/,
    ]) {
      expect(proactive).toMatch(boundary);
    }
    expect(proactive).toContain("feature.compaction-summary-recovery");
    expect(proactive).toMatch(/exact aborted terminal object identity followed by same-run selected-branch settlement/);
    expect(proactive).toMatch(/TUI steering\/follow-up\/draft order and no automatic replay/);
    expect(proactive).toMatch(/Live RPC post-compaction retained-replay cancellation is unsupported/);
    expect(proactive).toMatch(/distinct confirmed restart-required terminal category/);
    expect(proactive).toMatch(/restart-process with status 3, leaves controller admission closed, refuses in-process new\/resume\/fork\/reload replacement/);
    expect(proactive).toMatch(/requires an external fresh PiCC process plus fresh session/);
    expect(proactive).toMatch(/Pi may drain those queues before PiCC can present the outcome/);
    expect(proactive).not.toMatch(/TUI and live RPC may remain reusable|reusable live RPC cancellation/);
    expect(proactive).toMatch(/canonical report shared by all consumers/);
    expect(proactive).toMatch(/ambiguous records remain quarantined/);
    expect(proactive).not.toMatch(
      /automatic, manual|split-turn|branch Codex|shared summarization seam|summary-only SSE|force(?:s|d)? SSE|provider(?:-internal)? (?:maxRetries|retr(?:y|ies))|configured (?:bounded )?summarization loop|sole (?:retry )?owner|transport\/provider-overload|abortable exponential backoff|retry lifecycle events|public request fields|prove provenance|exact-signature|purpose marker/,
    );
  });

  it("independently pins the restored MCP proxy qualification families", () => {
    const proxy = lookupCapability("tool.mcp__*")?.note ?? "";
    for (const qualification of [
      "Deny rules at every grammar level",
      "guard's call-time deny as the backstop",
      "deny matching is case-sensitive",
      "input schemas are normalized",
      "Claude passes schemas through verbatim",
      "descriptions are bounded at 2KB",
      "64-char model tool-name limit",
      "tools/list pagination stops after 16 pages",
      "DEGRADED tool-result content",
      "structuredContent is ignored",
      "Claude renders images natively",
      "feature.tool-output-clip",
      "calls resolve the current client",
    ]) expect(proxy, qualification).toContain(qualification);
  });

  it("independently pins restored aggregate, status, and approval qualification families", () => {
    const aggregate = lookupCapability("feature.mcp")?.note ?? "";
    for (const qualification of [
      "${VAR}/${VAR:-default}",
      "CLAUDE_PROJECT_DIR",
      "CLAUDECODE=1",
      "CLAUDE_CODE_SESSION_ID",
      "process-tree shutdown on Windows/POSIX",
      "MCP_TIMEOUT 30 s",
      "MCP_TOOL_TIMEOUT unset default ~27.8 h",
      "transient first-turn wait status",
      "project-root cwd-pinned",
      "launcher-only marker removal",
      "no tool search",
      "NOT reported to the model",
      "NO MCP context of any kind",
      "aggregate initial-settlement opportunity",
      "feature.mcp-remote-transports",
    ]) expect(aggregate, qualification).toContain(qualification);

    const status = lookupCapability("feature.mcp-control-status")?.note ?? "";
    for (const qualification of [
      "at most 32 detailed rows",
      "limits diagnostic-bearing per-server findings to that 32-server budget",
      "Interactive and RPC use an immediate live snapshot",
      "one-shot text and JSON await bounded MCP startup settlement",
      "Claude Code 2.1.205+",
      "interactive management UI or individual-tool view",
      "lifecycle/deprecation rendering",
      "truthful further-omission guidance",
    ]) expect(status, qualification).toContain(qualification);

    const approval = lookupCapability("feature.mcp-project-approval")?.note ?? "";
    for (const qualification of [
      "git-tracked settings.local.json is demoted to project scope",
      "committed project-scope approvals are ignored",
      "bounded one-time session-start notice",
      "bounded approval and decline guidance",
      "Each UTF-16 code unit",
      "astral symbol therefore becomes '__'",
      "normalization collisions",
      "name-based, not definition-bound",
    ]) expect(approval, qualification).toContain(qualification);
  });

  it("pins exact provenance and unchanged-PiCC scope for registry-only MCP gaps", () => {
    expect(lookupCapability("feature.mcp-connect-timeout-ms")?.note).toBe(
      "PiCC ignores MCP_CONNECT_TIMEOUT_MS and uses MCP_TIMEOUT. Owner-reported Claude Code 2.1.218 binary observation covers one connect path with a 5000 ms default; broader semantics are not claimed",
    );
    expect(lookupCapability("feature.mcp-shell-prefix")?.note).toBe(
      "PiCC does not honor CLAUDE_CODE_SHELL_PREFIX for stdio MCP spawning; owner-reported Claude Code 2.1.218 binary provenance reports prefixing on the observed spawn path",
    );
    expect(lookupCapability("feature.mcp-child-session-env")?.note).toBe(
      "PiCC does not remove inherited CLAUDE_CODE_CHILD_SESSION from stdio MCP environments; Claude removal is documented and owner-reported, while PiCC behavior remains unchanged",
    );
  });

  it("carries explicit deferred entries for the non-stdio MCP surfaces", () => {
    for (const id of [
      "feature.mcp-oauth",
      "feature.mcp-headers-helper",
      "feature.mcp-tool-search",
      "feature.mcp-list-changed",
      "feature.mcp-elicitation",
      "feature.mcp-resource-templates",
      "feature.mcp-sampling",
      "feature.mcp-roots",
      "feature.mcp-channels",
      "feature.mcp-connectors",
      "feature.mcp-output-token-cap",
      "feature.mcp-idle-timeout",
      "feature.mcp-auto-background",
      "feature.mcp-plugin-servers",
      "feature.mcp-websocket",
      "feature.mcp-first-byte-timeout",
      "feature.mcp-connect-timeout-ms",
      "feature.mcp-shell-prefix",
      "feature.mcp-child-session-env",
    ]) {
      const entry = lookupCapability(id);
      expect(entry, id).toBeDefined();
      expect(entry?.tier, id).toBe("not-supported");
    }
    // The blanket "MCP deferred" wording is swept off entries whose surface now
    // partially runs; each names its specific deferred surface instead.
    expect(lookupCapability("hook.event.mcp__elicitation")?.note).toContain(
      "historical PiCC compatibility alias",
    );
    expect(lookupCapability("hook.event.mcp__elicitation")?.note).toContain(
      "not the current Claude Code hook contract",
    );
    expect(lookupCapability("feature.mcp-idle-timeout")?.note).toContain("transport-specific idle timers");
    expect(lookupCapability("feature.mcp-idle-timeout")?.note).toContain("CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0");
    const oauth = lookupCapability("feature.mcp-oauth")?.note ?? "";
    for (const surface of ["401/403 auth detection", "automatic token refresh", "fixed callback port", "preconfigured credentials", "authServerMetadataUrl", "oauth.scopes", "dynamic registration", "offline_access", "insufficient_scope"]) {
      expect(oauth).toContain(surface);
    }
    expect(oauth).toContain("`oauth` field is ignored");
    expect(oauth).toContain("server still runs when otherwise usable");
    expect(oauth).toContain("must not rely on `oauth` under PiCC");
    expect(oauth).toContain("static headers are PiCC's supported alternative");
    expect(lookupCapability("agent.frontmatter.mcpServers")?.note).toContain("inherit the session's gated MCP tool proxies and conditional resource tools");
    expect(lookupCapability("feature.hook-handler.mcp_tool")?.note).toContain("ordinary MCP tools themselves still run");
    expect(lookupCapability("feature.mcp-remote-transports")?.tier).toBe("partial");
    // Plugin MCP servers: deferred entry + qualifying clause on the plugins claim.
    expect(lookupCapability("feature.plugins-content")?.note).toContain("feature.mcp-plugin-servers");
  });

  it("pins managed MCP enforcement, hardening, reporting, and deferred-source boundaries", () => {
    const allowed = lookupCapability("setting.allowedMcpServers");
    for (const phrase of [
      "documented soft allowlist",
      "valid lower-scope list can broaden access unless managed-only is active",
      "command rules take precedence over name rules",
      "URL rules take precedence over names",
      "one frozen launch-environment snapshot",
      "PiCC additionally makes over-limit allow material active-empty",
      "deferred plugin/agent-inline/explicit-runtime sources",
      "silently hidden blocked UI",
    ]) expect(allowed?.note, phrase).toContain(phrase);

    const denied = lookupCapability("setting.deniedMcpServers");
    for (const phrase of [
      "deny always wins over every allow",
      "complete command-vector matching is exact and case-sensitive",
      "deny URL matching canonicalizes default ports",
      "invalid managed deny values as dropped",
      "schema-invalid ordinary settings files are rejected with zero policy projection",
      "fails closed when bounded-source or restrictive-projection loss may have omitted deny material",
    ]) expect(denied?.note, phrase).toContain(phrase);

    const managedOnly = lookupCapability("setting.allowManagedMcpServersOnly");
    expect(managedOnly?.note).toContain("prevents valid lower-scope soft allowlists from broadening authorization");
    expect(managedOnly?.note).toContain("does not turn an ordinary soft allowlist into an immutable administrator list");

    for (const setting of [allowed, denied, managedOnly]) {
      expect(setting?.note).toContain("all currently loaded ordinary and standalone-managed");
    }

    const managedConfig = lookupCapability("feature.mcp-managed-config");
    for (const phrase of [
      "exclusive administrator server set before ordinary MCP acquisition",
      "loaded empty set disables MCP",
      "absence preserves ordinary sources",
      "present but unusable or oversized authority",
      "bounded projection with restrictive material omitted",
      "fails MCP closed",
      "PiCC-defined /mcp and /doctor summaries",
      "single startup notice",
      "not Claude UI parity",
      "server-managed delivery is absent",
      "deferred plugin/agent-inline/explicit-runtime sources are not loaded",
    ]) expect(managedConfig?.note, phrase).toContain(phrase);

    expect(lookupCapability("setting.strictPluginOnlyCustomization.mcp")?.note).toContain(
      "manual/CLI/runtime source delivery are themselves unsupported rather than governed",
    );
    expect(lookupCapability("feature.mcp-plugin-servers")?.note).toContain("plugin-bundled MCP servers are deferred");
    expect(lookupCapability("agent.frontmatter.mcpServers")?.note).toContain("per-agent MCP server configs are a deferred surface");
    expect(lookupCapability("feature.mcp-cli-invocation-controls")?.note).toContain("Claude CLI invocation/loading controls");
  });

  it("pins managed MCP documentation boundaries by section", () => {
    const readDoc = (relativePath: string): string => fs.readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const section = (text: string, heading: string): string => {
      const start = text.indexOf(heading);
      expect(start, heading).toBeGreaterThanOrEqual(0);
      const level = heading.match(/^#+/)?.[0].length ?? 2;
      const nextHeading = new RegExp(`^#{1,${level}}\\s`, "m");
      const remainder = text.slice(start + heading.length);
      const next = remainder.search(nextHeading);
      return next < 0 ? text.slice(start) : text.slice(start, start + heading.length + next);
    };

    const readme = readDoc("../README.md");
    const capabilitySection = section(readme, "## What it does");
    expect(capabilitySection).toMatch(/MCP servers[\s\S]*standalone managed[\s\S]*central policy admission[\s\S]*\[capability matrix\]\(doc\/supported-features\.md\)/);

    const guide = readDoc("../doc/user-guide.md");
    const runSection = section(guide, "## 4. Run a Claude Code project");
    expect(runSection).toMatch(/MCP servers[\s\S]*standalone `managed-mcp\.json`[\s\S]*native Claude user\/project-local state/);
    for (const predicate of [
      /neither reads nor migrates Windows registry policy/,
      /HKLM-[\s\S]*HKCU-only policy[\s\S]*silently[\s\S]*ignored[\s\S]*no settings, diagnostics, enforcement, cleanup blocking, or fail-closed[\s\S]*behavior/,
      /manually deploy[\s\S]*administrator-owned Windows system file or its ordered drop-ins/,
      /no precedence-equivalent[\s\S]*migration/,
      /lexically last drop-in best approximates the former machine-policy-after-files[\s\S]*order/,
      /former user fallback has no exact user-writable managed replacement/,
      /standalone[\s\S]*`managed-mcp\.json` authority is separate[\s\S]*not a migration target/,
    ]) expect(runSection).toMatch(predicate);
    const securitySection = section(guide, "## 6. Security & permission posture");
    for (const predicate of [
      /Managed MCP policy/,
      /minimal valid root shape[\s\S]*`\{ "mcpServers": \{ \.\.\. \} \}`[\s\S]*empty map disables MCP/,
      /managed-mcp\.json` on Windows[\s\S]*macOS[\s\S]*Linux/,
      /distinct from `managed-settings\.json`/,
      /source uncertainty may have lost[\s\S]*restrictive material/,
      /over-limit allow material becomes active-empty/,
      /ambiguous or over-limit[\s\S]*blocked individually/,
      /PiCC-owned Git tracking classification may[\s\S]*run only when winner or approval selection needs it/,
      /After a winner is blocked, no further probe[\s\S]*MCP server process[\s\S]*DNS lookup[\s\S]*network activity/,
      /authority-specific remediation[\s\S]*ask an administrator/,
      /\[capability matrix\]\(supported-features\.md\)/,
    ]) expect(securitySection).toMatch(predicate);
    const troubleshooting = section(guide, "## 9. Troubleshooting");
    const managedMcpRow = troubleshooting.match(/^\| Managed MCP policy is fail closed[^\n]+$/m)?.[0];
    expect(managedMcpRow).toMatch(/standalone `managed-mcp\.json`[\s\S]*managed-settings system file or ordered drop-in/);
    expect(managedMcpRow).toMatch(/Then use `\/reload` or restart PiCC; `\/new` does not reload policy/);
    expect(managedMcpRow).not.toMatch(/override|user-controlled/);
    const managedPluginRow = troubleshooting.match(/^\| Managed plugin policy is ignored[^\n]+$/m)?.[0];
    expect(managedPluginRow).toMatch(/Windows registry policy did not migrate[\s\S]*managed system file or ordered drop-in[\s\S]*administrator[\s\S]*`\/reload`[\s\S]*exit and relaunch PiCC[\s\S]*registry-only policy[\s\S]*migrated manually[\s\S]*project loading/);
    expect(managedPluginRow).not.toMatch(/`override`|user-controlled/);

    const architecture = readDoc("../doc/architecture.md");
    const discoverySection = section(architecture, "### `discovery/` — where artifacts live, and precedence");
    for (const predicate of [
      /standalone `managed-mcp\.json`[\s\S]*exclusive administrator authority/,
      /managed-settings[\s\S]*policy and admits each raw effective winner before expansion, approval, native disablement, or[\s\S]*runtime materialization/,
      /future[\s\S]*plugin, agent-inline, or explicit runtime\/CLI adapter must do the same/,
      /those adapters do not exist today/,
    ]) expect(discoverySection).toMatch(predicate);
    const loaderSection = section(architecture, "### `claude/` — parse each artifact format (loaders only, no runtime)");
    expect(loaderSection).toMatch(/MCP server entries \(standalone `managed-mcp\.json`[\s\S]*`managed-mcp\.ts`/);

    const threatModel = readDoc("../doc/threat-model.md");
    const inScope = section(threatModel, "## In scope");
    expect(inScope).toMatch(/Administrator-managed MCP admission[\s\S]*system managed[\s\S]*ordered drop-ins[\s\S]*`managed-mcp\.json`[\s\S]*Applicable[\s\S]*policy from those authorities governs every MCP source PiCC loads/);
    expect(inScope).toMatch(/Uncertainty that could weaken[\s\S]*fails closed[\s\S]*blocked server[\s\S]*cannot initiate[\s\S]*server-side effects/);
    expect(inScope).toMatch(/Windows registry state is not an applicable enforcement input/);
  });

  it("splits installed plugin support truth by selection, component, management, and lifecycle", () => {
    expectDisclosure({
      id: "feature.plugins-installed-selection",
      tier: "partial",
      core: [/read-only exact-version runtime selection/, /separate declaration observation/, /qualified name@marketplace/, /load no fallback content/],
      gap: [/undocumented/, /not PiCC's permanent API/],
      parity: [/FIXTURE-DERIVED/, /Captured Claude installed-state v2/, /PiCC-defined/],
    });
    expectDisclosure({
      id: "feature.plugins-enablement",
      tier: "partial",
      core: [/literal booleans only/, /source-aware key-wise precedence/],
      gap: [/defaultEnabled.*unsupported/, /strict-overlay execution/, /lifecycle policy enforcement/, /cannot establish development or bundled-root trust/],
    });
    const umbrella = lookupCapability("feature.plugins-content");
    expect(umbrella).toMatchObject({ tier: "partial" });
    for (const phrase of ["selected installed-plugin skills, commands, agents, and hooks", "fixture-derived", "catalog roots remain inert", "strict marketplace overlays", "unsupported component execution", "feature.mcp-plugin-servers"]) {
      expect(umbrella?.note).toContain(phrase);
    }
    const enablementNote = lookupCapability("setting.enabledPlugins")?.note ?? "";
    expect(enablementNote).toContain(
      "Realized load order is user settings, then for each directory from project root to cwd that directory's project settings followed by its local settings, then managed policy; the later value wins per qualified identity. A nested project's value can therefore override an ancestor's local value, unlike Claude's documented global local-over-project precedence.",
    );
    expect(enablementNote).not.toContain("managed > local > project > user");
    for (const id of [
      "feature.plugins-skills",
      "feature.plugins-commands",
      "feature.plugins-agents",
      "feature.plugins-hooks",
    ]) {
      const entry = lookupCapability(id);
      expect(entry?.tier, id).toBe("partial");
      expect(entry?.note, id).toContain("qualified");
      expect(entry?.note, id).toContain("lazy");
      expect(entry?.note, id).toContain("VERIFIED rejected");
      expect(entry?.note, id).toContain("PiCC-defined whole-plugin rejection");
    }
    const skills = lookupCapability("feature.plugins-skills")?.note ?? "";
    expect(skills).toContain("explicit skill directories");
    expect(skills).toContain("directory directly containing SKILL.md");
    expect(skills).toContain("individual files are not skill declarations");
    for (const [id, namespace] of [
      ["feature.plugins-skills", "skill"],
      ["feature.plugins-commands", "command"],
      ["feature.plugins-agents", "agent"],
    ] as const) {
      const note = lookupCapability(id)?.note ?? "";
      expect(note).toContain("Installed qualified name@marketplace identity owns selection, variable/data context");
      expect(note).toContain(`present validated kebab-case manifest name owns the visible ${namespace} namespace`);
      expect(note).toContain("manifestless content uses the validated installed lifecycle name");
    }
    const selection = lookupCapability("feature.plugins-installed-selection")?.note ?? "";
    for (const phrase of ["CLAUDE_CODE_PLUGIN_CACHE_DIR", "path-delimited", "<seed>/cache", "existing accessible directories", "exact imported record", "does not import seed marketplaces", "first-seed lifecycle behavior", "Highest-applicable winner", "canonical equivalent deduplication", "qualified blocklist schema and global fail-closed", "namespace/data-key collision rejection", "no fallback", "PiCC-defined"]) expect(selection).toContain(phrase);
    const agents = lookupCapability("feature.plugins-agents")?.note ?? "";
    for (const phrase of ["plugin-agent local names are validated", "Global ordinary-agent parser gaps", "hooks", "mcpServers", "permissionMode"]) expect(agents).toContain(phrase);
    const hooks = lookupCapability("feature.plugins-hooks")?.note ?? "";
    for (const phrase of ["command and argument fields alone", "canonical authorized root", "matcher, condition, URL, and arbitrary raw fields remain literal"]) expect(hooks).toContain(phrase);
    const metadata = lookupCapability("feature.plugins-manifest-metadata")?.note ?? "";
    for (const phrase of ["present validated kebab-case plugin manifest name owns the visible runtime component namespace", "manifestless content uses the validated installed lifecycle name", "bounded same-read projection", "name, description, version, author, homepage, repository, license, keywords, dependencies", "supported or unsupported component declaration shapes", "Skills, commands, agents, and hooks declarations can affect runtime only after selection and validation", "manifest dependencies remain unresolved inventory evidence", "renames remain catalog-only inert declarations", "Broader recognized metadata validation", "defaultEnabled execution", "marketplace strict overlays", "settings rewrite are unsupported"]) expect(metadata).toContain(phrase);
    expect(lookupCapability("feature.plugins-development-trust")).toMatchObject({ tier: "not-supported" });
    expect(lookupCapability("feature.plugins-development-trust")?.note).toContain("repository-bundled");
    expect(lookupCapability("feature.plugins-command-plugin")).toMatchObject({ tier: "partial" });
    for (const phrase of ["PiCC-defined read-only four-view session inventory", "Discover, Installed, Marketplaces, and Errors", "list/details", "No install, update, enable, disable, uninstall", "stable JSON automation contract"]) {
      expect(lookupCapability("feature.plugins-command-plugin")?.note).toContain(phrase);
    }
    expect(lookupCapability("feature.plugins-command-plugins")).toMatchObject({ tier: "partial" });
    for (const phrase of ["PiCC-defined exact-list alias", "same captured read-only session snapshot", "not Claude parity", "no lifecycle mutation", "no stable JSON automation contract"]) {
      expect(lookupCapability("feature.plugins-command-plugins")?.note).toContain(phrase);
    }
    expect(lookupCapability("feature.plugins-command-reload")).toMatchObject({ tier: "degraded-noop" });
    expect(lookupCapability("feature.plugins-command-reload")?.note).toContain("performs no reload");
    expect(lookupCapability("feature.plugins-command-reload")?.note).toContain("canonical interactive /reload");
    for (const [id, phrase] of [
      ["feature.plugin-install", "installation is not implemented"],
      ["feature.plugin-update", "update is not implemented"],
      ["feature.plugin-uninstall", "uninstall is not implemented"],
      ["feature.plugin-marketplace", "marketplace add, update, remove, refresh"],
      ["feature.plugins-other-components", "LSP, workflows, output styles, top-level and experimental themes and monitors, channels"],
    ] as const) {
      expect(lookupCapability(id)?.tier, id).toBe("not-supported");
      expect(lookupCapability(id)?.note, id).toContain(phrase);
    }
    for (const id of ["feature.plugin-install", "feature.plugin-update", "feature.plugin-uninstall"]) {
      expect(lookupCapability(id)?.note, id).toContain("canonical interactive /reload");
      expect(lookupCapability(id)?.note, id).toContain("or relaunch PiCC");
    }
    expect(lookupCapability("feature.plugins-other-components")?.note).toContain("bounded shape-only inventory evidence");
    expect(lookupCapability("feature.plugins-other-components")?.note).toContain("feature.mcp-plugin-servers");

    for (const id of ["feature.plugins-inventory", "feature.plugins-launcher-inventory", "feature.plugins-marketplace-observation"] as const) {
      expect(lookupCapability(id), id).toMatchObject({ tier: "partial" });
    }
    const inventory = lookupCapability("feature.plugins-inventory")?.note ?? "";
    for (const phrase of ["bounded read-only snapshot", "by qualified identity", "marketplace registrations and policy stay global", "selected-manifest and catalog dependencies retain distinct unresolved provenance", "renames remain catalog-only inert declarations", "Session UI/text/doctor consumers share one immutable capture", "command consumers build one fresh snapshot", "No disk reread", "stable JSON automation contract", "exact Claude rendering parity"]) expect(inventory).toContain(phrase);
    const launcher = lookupCapability("feature.plugins-launcher-inventory")?.note ?? "";
    for (const phrase of ["picc plugin list", "picc plugin details <qualified-name>", "one fresh command-scoped", "avoid normal Pi extension, hook, MCP, and plugin-runtime startup", "not stable JSON automation"]) expect(launcher).toContain(phrase);
    const marketplace = lookupCapability("feature.plugins-marketplace-observation")?.note ?? "";
    for (const phrase of ["local-only observation", "fixture-derived known_marketplaces.json serialization", "supported and unsupported component shapes", "dependencies", "renames", "Catalogs are inventory-only and never authorize content", "no network refresh", "dependency resolution", "rename migration", "strict-overlay execution"]) expect(marketplace).toContain(phrase);
    for (const id of ["setting.extraKnownMarketplaces", "setting.strictKnownMarketplaces", "setting.blockedMarketplaces"] as const) {
      expect(lookupCapability(id), id).toMatchObject({ tier: "partial" });
      expect(lookupCapability(id)?.note, id).toContain("read-only observation");
      expect(lookupCapability(id)?.note, id).toMatch(/lifecycle enforcement|Blocking is observational only/);
    }
    const lifecycle = lookupCapability("feature.plugin-marketplace");
    expect(lifecycle).toMatchObject({ tier: "not-supported" });
    for (const phrase of ["add, update, remove, refresh", "network acquisition", "lifecycle mutation", "observation-only"]) expect(lifecycle?.note).toContain(phrase);
  });

  it("qualifies plugin-agent global fields, retained managed-policy sources, and unsupported Windows registry delivery", () => {
    expect(lookupCapability("agent.frontmatter.hooks")?.note).toContain("for non-plugin agents");
    expect(lookupCapability("agent.frontmatter.mcpServers")?.note).toContain("for non-plugin agents");
    expect(lookupCapability("agent.frontmatter.permissionMode")?.note).toContain("for non-plugin agents");
    const managed = lookupCapability("feature.managed-policy");
    expect(managed?.tier).toBe("partial");
    for (const phrase of [
      "system managed settings file",
      "lexically ordered drop-in files",
      "Scalar replacement plus recursive object merge and stable array dedup",
      "managed-settings source discovery",
      "standalone managed-mcp.json exclusive-server mechanism is distinct",
      "Windows registry delivery is unsupported",
      "no complete server-managed settings, MDM, MDM-preference, or policy-helper parity",
      "malformed or unreadable retained sources diagnose and are ignored",
    ]) expect(managed?.note).toContain(phrase);
    const windowsRegistry = lookupCapability("feature.managed-policy-windows-registry");
    expect(windowsRegistry).toMatchObject({ tier: "not-supported", safetyRelevant: true });
    for (const phrase of [
      "HKLM and HKCU are neither queried nor probed",
      "Registry-only policy is silently ignored",
      "no settings, diagnostics, enforcement, cleanup blocking, or fail-closed behavior",
      "administrator-owned system managed settings files or ordered drop-ins",
    ]) expect(windowsRegistry?.note).toContain(phrase);
    expect(managed?.related).toEqual(expect.arrayContaining(["feature.mcp-managed-config", "feature.managed-policy-windows-registry"]));
    expect(windowsRegistry?.related).toContain("feature.managed-policy");
    expect(lookupCapability("feature.mcp-managed-config")?.related).toContain("feature.managed-policy");

    const root = makeTempDir();
    const projectRoot = path.join(root, "project");
    const userDir = path.join(root, "user", ".claude");
    const managedRoot = path.join(root, "windows-managed-policy");
    const description = {
      systemSettingsPath: path.join(managedRoot, "managed-settings.json"),
      dropInDir: path.join(managedRoot, "managed-settings.d"),
      artifactDirs: [managedRoot],
    };
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(description.dropInDir, { recursive: true });
    fs.writeFileSync(description.systemSettingsPath, JSON.stringify({ env: { FROM_SYSTEM_FILE: "loaded" } }));
    fs.writeFileSync(path.join(description.dropInDir, "10-clean.json"), JSON.stringify({ env: { FROM_DROP_IN: "loaded" } }));
    const settings = loadSettings({
      cwd: projectRoot,
      projectRoot,
      userDir,
      managedPolicy: { platform: "win32", description },
    });
    expect(settings.env).toMatchObject({ FROM_SYSTEM_FILE: "loaded", FROM_DROP_IN: "loaded" });
    expect(settings.diagnostics).toEqual([]);

    const cleanProject = makeProject({ root: projectRoot, cwd: projectRoot, userDir, settings });
    const doctor = renderDoctorReport(cleanProject, buildCompatReport(cleanProject));
    expect(doctor).not.toContain("feature.managed-policy-windows-registry");
    expect(doctor).not.toMatch(/Windows registry policy|Registry-only policy/);
  });

  it.each<DisclosureContract>([
    { id: "tool.Grep", tier: "full", core: [/real implementation/, /Claude-baseline parameter surface/, /head_limit/, /offset/], gap: [/oversized-result clip backstop reshapes/], visibility: [/Grep-specific recovery hint/, /tighter pattern/, /smaller head_limit/, /offset/], parity: [/ripgrep\/JS engine parity/], split: [/feature\.tool-output-clip/] },
  ])("retains $id semantic disclosure", (contract) => {
    expectDisclosure(contract);
  });

  it("covers the core tool surface as full and TodoWrite as partial", () => {
    for (const tool of [
      "Read", "Write", "Edit", "Bash", "Grep", "Glob",
      "WebFetch", "WebSearch", "Skill", "MultiEdit",
      "EnterWorktree", "ExitWorktree",
      "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
    ]) {
      expect(lookupCapability(`tool.${tool}`)?.tier, tool).toBe("full");
    }
    expect(lookupCapability("tool.TodoWrite")?.tier).toBe("partial");
  });

  it.each<DisclosureContract>([
    {
      id: "tool.Agent",
      tier: "partial",
      core: [
        /subagent dispatch/,
        /final message is returned verbatim/,
        /main-session\/depth-1 background work/,
        /successful acceptance is transient in human chat/,
        /first terminal delivery through TaskOutput or settlement/,
        /semantic record/,
        /configured `app\.tools\.expand` action \(Ctrl\+O by default\)/,
        /unbound action fails open/,
        /At unusable widths, detail waits for widening; a resize prompt appears only when it fits/,
        /later already-reported retrieval adds no human row/,
        /Nested work at depth >= 2/,
        /default notice box/,
        /panel tree/,
        /parent's transcript/,
        /status-panel observability is defined by feature\.background-agents/,
        /dispatched subagents do NOT recurse/,
      ],
      gap: [/PARTIAL residual/, /notice is next-turn/],
      precedence: [/BACKGROUND-BY-DEFAULT/, /run_in_background:false/, /DISABLE_BACKGROUND_TASKS/, /MAIN-SESSION-ONLY BY DEFAULT/, /default subagents\.maxDepth/, /subagents\.maxDepth of 1/, /positive integer greater than 1/, /nested generations/],
      visibility: [/model-visible text/, /human TUI strips it/, /model-visible background dispatch still returns the task ID/, /shared terminal recovery guidance also reaches print\/RPC delivery/],
      parity: [/Claude-faithful/, /not verified parity/, /PiCC's conservative default/, /subagents\.maxDepth.*explicit nesting control/],
      split: [/feature\.background-agents/, /tool\.Agent\.fork/],
    },
    { id: "tool.Task", tier: "partial", core: [/alias of the Agent subagent-dispatch tool/, /loud-failure/], gap: [/conditional/, /remaining uncollected/], precedence: [/background-by-default/, /terminal TaskOutput collection suppresses/], visibility: [/settlement notice/], parity: [/PiCC UX hardening rather than verified parity/], split: [/tool\.Agent\.fork/] },
    { id: "feature.tool-output-clip", tier: "partial", core: [/tool-result clip backstop/, /head \+ tail kept, middle dropped/], gap: [/Built-in Read\/Bash keep Pi's OWN 50 KB truncation/], precedence: [/clipMaxTokens, default 20k tokens/], visibility: [/model-visible/, /human rendering summarizes/], parity: [/PiCC HARDENING, NOT Claude parity/, /DIRECTIONAL DIVERGENCE/], split: [/tool\.Read \/ tool\.Bash/] },
    { id: "tool.SendMessage", tier: "partial", core: [/resumes any actually resumable completed or failed subagent/, /steers a running background one/, /PiCC allows resume after TaskStop/], gap: [/no cross-restart resume/, /steering is background-only/, /Claude Code 2\.1\.x reference refuses stopped-agent resume/], precedence: [/newest generation wins/], visibility: [/model-visible wording/, /not verified as exact Claude wording/], parity: [/PiCC-defined because Claude's queue behavior is undocumented/], split: [/tool\.Agent\.fork/] },
    { id: "tool.Agent.fork", tier: "partial", core: [/inherits the parent conversation/, /OUTPUT ISOLATION IS KEPT/], gap: [/NON-RESUMABLE/, /CANNOT SPAWN ANOTHER FORK/], precedence: [/CLAUDE_CODE_FORK_SUBAGENT/, /UNSET ⇒ ENABLED/, /CLAUDE_CODE_SUBAGENT_MODEL/, /per-call `model`/], visibility: [/visibly degrades/, /footer notice/], parity: [/VERIFIED behavior/, /PiCC-DEFINED \/ INFERRED/], split: [/SendMessage/] },
    {
      id: "tool.TaskOutput",
      tier: "partial",
      core: [
        /retrieves background subagent results/,
        /canonical terminal result/,
        /main-session retrieval of depth-1 work/,
        /FIRST terminal delivery/,
        /semantic record/,
        /configured `app\.tools\.expand` action \(Ctrl\+O by default\)/,
        /unbound action fails open/,
        /At unusable widths, detail waits for widening; a resize prompt appears only when it fits/,
        /never adding a reference or duplicate row/,
        /status-panel observability is defined by feature\.background-agents/,
      ],
      gap: [/PRE-EXISTING SCHEMA GAP/, /PiCC exposes wait/],
      precedence: [/FIRST terminal delivery/, /AFTER an emitted terminal record/, /terminal record counts as delivery/, /subagent reaches only tasks it dispatched/, /coordinator reaches every session task/],
      visibility: [/human\/streaming partial output/, /returns waiting to the model/, /suppressed from the main-session human TUI/, /model-visible completed or truncated-completed resumable retrieval/],
      parity: [/PiCC-defined collection-aware lifecycle/, /PiCC EXTENSION\/DIVERGENCE/, /official Claude Code/],
    },
    { id: "tool.TaskStop", tier: "partial", core: [/stops a background subagent/, /pre-commit compaction-paused dispatch/, /authenticated post-commit resumed abort\/join epoch/, /linked background settlement join/], gap: [/PiCC accepts only task_id/, /Claude 2\.1\.198\+ also accepts agent id\/name/], precedence: [/current dispatch generation/, /stale task generations cannot stop a newer generation/, /subagent's TaskStop reaches only tasks it dispatched/, /coordinator can stop any session task/], visibility: [/model-visible wording/, /not verified as exact Claude wording/], parity: [/PiCC-defined because Claude's post-stop result semantics are undocumented/], split: [/tool\.TaskOutput/] },
  ])("retains $id semantic disclosure", (contract) => {
    expectDisclosure(contract);
  });

  const duplicatedPanelMechanics = [
    /\binline[- ](?:live[- ])?activity(?: payload)?\b|\blive[- ]activity payload[^.]{0,60}\binline\b/iu,
    /\b(?:one|single) physical (?:status )?row\b|\bone[- ]row (?:status )?layout\b/iu,
    /\bbounded (?:sanitized )?live[- ]activity(?: payload)?\b/iu,
    /(?=[^.]{0,160}(?:live[- ]activity|activity payload))(?=[^.]{0,160}(?:responsiv(?:e|ely)|(?:row )?(?:space|width) (?:changes|narrows)))(?=[^.]{0,160}(?:shorten(?:ed|ing|s)?|truncat(?:e|ed|es|ion)|disappear(?:s|ance)?|om(?:it(?:ted|s)?|ission)))[^.]{1,160}/iu,
    /(?=[^.]{0,140}\bterminal (?:status )?rows?\b)(?=[^.]{0,140}(?:live[- ]activity|activity payload))(?=[^.]{0,140}\b(?:omit(?:ted|s)?|omission)\b)[^.]{1,140}/iu,
    /\bbounded (?:agent )?window\b/iu,
    /(?:narrow widths?|widths? too narrow)[^.]{0,100}(?:truthful )?aggregates?\b/iu,
    /(?:drill-down|detail(?: view)?)[^.]{0,100}\bmultiline (?:activity )?history\b|\bmultiline (?:activity )?history[^.]{0,100}(?:drill-down|detail(?: view)?)/iu,
  ];

  function duplicatesPanelMechanics(note: string): boolean {
    return duplicatedPanelMechanics.some((pattern) => pattern.test(note));
  }

  it.each([
    ["inline/live-activity payload", "The panel puts the live-activity payload inline beside identity."],
    ["one physical row/one-row layout", "Each running agent uses a one-row status layout."],
    ["bounded sanitized live activity", "Each row includes a bounded sanitized live-activity payload."],
    ["responsive shortening with separator wording", "The live activity responsively shortens or is omitted with its separator."],
    ["responsive disappearance without separator wording", "The activity payload disappears responsively as row width narrows."],
    ["terminal omission", "Terminal rows omit the live-activity payload."],
    ["bounded windowing", "A bounded agent window remains navigable."],
    ["narrow aggregate fallback", "At narrow widths truthful aggregates replace individual rows."],
    ["multiline/detail history", "The detail view retains multiline activity history."],
  ])("detects duplicated panel mechanic: %s", (_category, canary) => {
    expect(duplicatesPanelMechanics(canary)).toBe(true);
  });

  it("pins canonical retained-input custody and shutdown truth across affected capability owners", () => {
    const expected = ["tool.Agent", "tool.Task", "tool.TaskOutput", "tool.TaskStop", "tool.SendMessage", "feature.background-agents"];
    for (const id of expected) {
      const note = lookupCapability(id)?.note ?? "";
      expect(note, id).toMatch(/canonical|canonical owner/);
      expect(note, id).toMatch(/quarantined|quarantine/);
    }
    const background = lookupCapability("feature.background-agents")?.note ?? "";
    expect(background).toMatch(/exactly reopens.*session entry.*recovery file/);
    expect(background).toMatch(/best-effort.*warns of possible loss.*cleanup continues/);
    expect(background).toMatch(/unconfirmed work still blocks cleanup/);
  });

  it("keeps panel mechanics in feature.background-agents and tool entries reference that owner", () => {
    const owner = lookupCapability("feature.background-agents")?.note ?? "";
    for (const clause of [
      "inline layout is PiCC-defined presentation rather than verified Claude Code presentation parity",
      "every individually rendered running or capacity-waiting agent uses one physical status row",
      "bounded sanitized live-activity payload",
      "With a valid theme, every dynamic payload is muted and italic",
      "synthetic default `Thinking…` is displayed, it includes the remembered activity as `<activity> · Thinking…`; genuine activity replaces it immediately",
      "As available row space changes",
      "truncated with an ellipsis or omitted together with its separator",
      "terminal rows omit it",
      "bounded agent window remains navigable across overflow",
      "At widths too narrow for individual rows, truthful aggregates remain without per-agent activity",
      "drill-down that retains multiline history and richer detail",
      "PiCC-chosen details, NOT parity",
    ]) expect(owner, clause).toContain(clause);

    for (const id of ["tool.Agent", "tool.TaskOutput"]) {
      const note = lookupCapability(id)?.note ?? "";
      expect(note, id).toContain("status-panel observability is defined by feature.background-agents");
      expect(duplicatesPanelMechanics(note), `${id} must not duplicate panel mechanics`).toBe(false);
    }
  });

  it("keeps the full state-aware policy only in tool.Agent and pins each consumer consequence", () => {
    const canonical = lookupCapability("tool.Agent")?.note ?? "";
    for (const clause of [
      "STATE-AWARE RECOVERY",
      "complete lifecycle observation proves a transient-category failure had no successful assistant response, retained model/tool-call content, or started tool execution",
      "Observed progress or incomplete lifecycle evidence takes the conservative branch",
      "SendMessage is favored only when the result says the agent is factually resumable",
      "otherwise retained work and possible side effects require review before another explicit dispatch",
      "Non-transient or unclassified failures recommend neither blind replacement nor resume",
      "Guidance and resumability are separate",
      "PiCC takes no automatic action",
      "not verified Claude Code recovery-policy parity",
    ]) expect(canonical, clause).toContain(clause);

    const consumers: Array<{ id: string; consequences: readonly string[] }> = [
      {
        id: "tool.Task",
        consequences: ["terminal failures with a structured recovery disposition carry tool.Agent's canonical state-aware guidance", "loud-failure/agent-id semantics"],
      },
      {
        id: "tool.TaskOutput",
        consequences: ["completed or truncated-completed resumable results may carry identity framing", "Failed results with a structured recovery disposition carry the separate state-aware guidance canonically defined by tool.Agent", "a failed task with a structured recovery disposition reports failed status with separate state-aware guidance"],
      },
      {
        id: "feature.background-agents",
        consequences: ["failed terminal delivery with a structured recovery disposition carries tool.Agent's canonical state-aware guidance", "state-aware terminal recovery guidance when a structured recovery disposition exists", "shared with print/RPC delivery"],
      },
      {
        id: "tool.Agent.fork",
        consequences: ["non-resumable consumer of tool.Agent's failure presenter", "require review of retained work and possible side effects rather than a resume recommendation"],
      },
      {
        id: "skill.frontmatter.context",
        consequences: ["consumes tool.Agent's state-aware failure presenter", "require review of retained work and possible side effects before another explicit dispatch"],
      },
    ];

    for (const consumer of consumers) {
      const note = lookupCapability(consumer.id)?.note ?? "";
      for (const consequence of consumer.consequences) expect(note, consumer.id).toContain(consequence);
      expect(note, `${consumer.id} must not duplicate the canonical policy`).not.toContain("complete lifecycle observation proves");
      expect(note, `${consumer.id} must not own the canonical marker`).not.toContain("STATE-AWARE RECOVERY");
    }

    expect(lookupCapability("tool.Task")?.note).not.toContain("its terminal failures carry tool.Agent's canonical state-aware guidance");
    expect(lookupCapability("tool.TaskOutput")?.note).not.toContain("Failed results carry the separate state-aware guidance");
    expect(lookupCapability("tool.TaskOutput")?.note).not.toContain("a failed task reports failed status with separate state-aware guidance");
    expect(lookupCapability("feature.background-agents")?.note).not.toContain("failed terminal delivery carries tool.Agent's canonical state-aware guidance");
    expect(lookupCapability("feature.background-agents")?.note).not.toContain("state-aware terminal recovery guidance — are shared with print/RPC delivery");
  });

  it("limits resume trailers to completed or truncated-completed resumable results", () => {
    const agent = lookupCapability("tool.Agent")?.note ?? "";
    const taskOutput = lookupCapability("tool.TaskOutput")?.note ?? "";

    expect(agent).toContain("completed or truncated-completed resumable result appends a clearly-delimited in-band identity/resume trailer");
    expect(taskOutput).toContain("completed or truncated-completed resumable results may carry identity framing");
    expect(taskOutput).toContain("model-visible completed or truncated-completed resumable retrieval may append the existing resume identity framing");
    expect(agent).not.toContain("a resumable dispatch appends");
    expect(taskOutput).not.toContain("model-visible settled retrieval may append");
  });

  it("keeps touched subagent notes conservative about nesting and user-facing about resize", () => {
    for (const id of ["tool.Agent", "tool.Task", "tool.TaskOutput", "feature.background-agents"]) {
      const note = lookupCapability(id)?.note ?? "";
      expect(note, id).not.toMatch(/CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH|disables nested spawning by default/u);
      if (id !== "tool.Task") expect(note, id).not.toMatch(/one- or two-column|self-shell/u);
    }
  });

  it("documents canonical SubagentStart/SubagentStop identity with transcript_path = MAIN", () => {
    for (const ev of ["SubagentStart", "SubagentStop"]) {
      const entry = lookupCapability(`hook.event.${ev}`);
      expect(entry?.tier, ev).toBe("full");
      expect(entry?.note, ev).toContain("agent_id + canonical agent_type");
      expect(entry?.note, ev).toContain("<plugin>:<agent>");
      expect(entry?.note, ev).toContain("MAIN session transcript");
    }
    expect(lookupCapability("hook.event.SubagentStart")?.note).toContain("exit 2 is diagnostic and non-blocking");
  });

  // Notification stays a degraded no-op; the note must record that settlement does
  // NOT fire an agent_completed Notification (it is unwired).
  it("records that background settlement does not fire an agent_completed Notification", () => {
    const n = lookupCapability("hook.event.Notification");
    expect(n?.tier).toBe("degraded-noop");
    expect(n?.note).toContain("agent_completed");
    expect(n?.note).toContain("eligible uncollected current task");
    expect(n?.note).toContain("conditional next-turn settlement message");
    expect(n?.note).toContain("terminal TaskOutput collection suppresses");
    expect(n?.note).toContain("SubagentStop fires independently");
    expect(n?.note).toContain("not alongside or synchronously");
  });

  // Agent frontmatter `background: true` is honored as a full entry.
  it("carries an agent.frontmatter.background entry as full", () => {
    const bg = lookupCapability("agent.frontmatter.background");
    expect(bg, "agent.frontmatter.background must exist").toBeDefined();
    expect(bg?.tier).toBe("full");
    expect(bg?.note).toContain("background: true");
  });

  it.each<DisclosureContract>([
    {
      id: "feature.background-agents",
      tier: "partial",
      core: [
        /background-by-default dispatch/,
        /always-on status panel/,
        /main-session\/depth-1 background work/,
        /successful acceptance is transient in human chat/,
        /first terminal delivery through TaskOutput or settlement/,
        /semantic.*record/,
        /configured `app\.tools\.expand` action \(Ctrl\+O by default\)/,
        /unbound action fails open/,
        /At unusable widths, detail waits for widening; a resize prompt appears only when it fits/,
        /later already-reported TaskOutput retrieval adds no human row/,
        /Nested work at depth >= 2/,
        /default notice box/,
        /panel tree/,
        /parent's transcript/,
        /inline layout.*PiCC-defined presentation.*one physical status row/s,
        /bounded sanitized live-activity payload.*valid theme.*muted and italic.*synthetic default `Thinking…` is displayed.*includes the remembered activity as `<activity> · Thinking…`.*genuine activity replaces it immediately.*available row space.*truncated with an ellipsis.*omitted together with its separator/s,
        /terminal rows omit.*bounded agent window.*overflow/s,
        /widths too narrow for individual rows.*truthful aggregates.*without per-agent activity/s,
        /drill-down.*retains multiline history and richer detail/,
      ],
      gap: [/idle parents are not re-invoked/, /one-shot print mode/, /no cross-session agent view/, /no remote\/cloud agents/, /PiCC has no corresponding per-session spawn budget/],
      precedence: [/first terminal delivery/, /later already-reported TaskOutput retrieval/, /Nested work at depth >= 2/, /newest-generation-wins/, /effective configured concurrency/, /queues additional accepted work FIFO/, /each nested-background depth/, /separate configured-capacity pool/, /Foreground nested dispatch bypasses those pools/],
      visibility: [/interactive TUI/, /canonical model-visible results/, /shared with print\/RPC delivery/],
      parity: [/NOT verified parity/, /PiCC EXTENSION\/DIVERGENCE/, /Claude Code 2\.1\.217/, /concurrently-running subagent cap/, /default 20/, /CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS/, /does not establish queue-versus-rejection behavior/, /precise concurrency scope/, /Claude Code 2\.1\.212/, /default-200/, /per-session subagent-spawn cap/, /CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION/, /reset by \/clear/],
      split: [/tool\.SendMessage/, /tool\.TaskOutput/, /tool\.Agent\.fork/],
    },
    { id: "setting.subagentMaxDepth", tier: "full", core: [/caps subagent nesting depth/, /accepts any positive integer/], precedence: [/default 1/, /MAIN-SESSION-ONLY/], parity: [/PiCC extension/, /NOT Claude parity/] },
    { id: "setting.subagentConcurrency", tier: "full", core: [/configured capacity applies to root dispatches/, /separately/, /each nested-background depth/], gap: [/foreground nested dispatch bypasses those pools/, /not a total/, /session ceiling/], parity: [/PiCC extension/, /no Claude-settings equivalent/] },
  ])("retains $id semantic disclosure", (contract) => {
    expectDisclosure(contract);
  });

  it("qualifies skill slash availability and SlashCommand for reserved built-in names", () => {
    const userInvocable = lookupCapability("skill.frontmatter.user-invocable");
    expect(userInvocable, "skill.frontmatter.user-invocable must exist").toBeDefined();
    expect(userInvocable?.tier).toBe("partial");
    expect(userInvocable?.note).toContain("ASCII alphanumeric first");
    expect(userInvocable?.note).toContain("optional colon-separated nested-alias segments");
    expect(userInvocable?.note).toContain("Prompt-palette stubs use the narrower single-segment ASCII token form");
    expect(userInvocable?.note).toContain("Reserved Pi/PiCC names are shadowed case-insensitively");
    expect(userInvocable?.note).toContain("precedence is PiCC-defined and unverified against Claude Code");
    expect(userInvocable?.note).toContain("direct model invocation remains governed separately");

    const sc = lookupCapability("tool.SlashCommand");
    expect(sc, "tool.SlashCommand must exist").toBeDefined();
    expect(sc?.tier).toBe("partial");
    expect(sc?.note).toContain("thin alias over the skill-activation path");
    expect(sc?.note).toContain("/plugin:name");
    expect(sc?.note).toContain("Reserved Pi/PiCC names are rejected case-insensitively");
    expect(sc?.note).toContain("colliding skill remains available only through direct Skill invocation");
    expect(sc?.note).toContain("when its model-invocation metadata permits");
    expect(sc?.note).toContain("/plugins is a PiCC-defined extension, not Claude parity");
    const skillNote = lookupCapability("tool.Skill")?.note ?? "";
    expect(skillNote).toContain("bare Skill tokens `plugin`, `plugins`, and `reload-plugins`");
    expect(skillNote).toContain("corresponding /plugin, /plugins, and /reload-plugins commands");
    expect(skillNote).toContain("/plugins is a PiCC-defined extension, not Claude parity");
    expect(sc?.note).toContain("PARTIAL:");
    expect(sc?.note).toContain("built-in commands");
    // Must NOT lead with the degraded-noop em-dash pattern.
    expect(sc?.note.startsWith("—")).toBe(false);
  });

  it.each<DisclosureContract>([
    { id: "tool.Read", tier: "full", core: [/text\/image\/notebook file reads/, /CELL-AWARE/], gap: [/PDF reading is BELOW the Claude baseline/], precedence: [/IMAGE and BINARY classification is BYTE-BASED/, /NOTEBOOK reads/, /\.ipynb extension/], visibility: [/non-vision model/, /model-visible text note/, /binary error/], parity: [/divergence from Claude's extension-based classification/, /PARITY/], split: [/feature\.read\.images/, /feature\.read\.pdf/, /feature\.tool-output-clip/] },
    { id: "feature.read.images", tier: "partial", core: [/real image content block ON A VISION-CAPABLE MODEL/], gap: [/non-vision model/, /model-visible text note/], visibility: [/never a silent drop or garbled text/], parity: [/PiCC's own normalization, NOT asserted byte-identical to Claude Code/], split: [/tool\.Read/] },
    { id: "feature.read.pdf", tier: "not-supported", core: [/Claude Code reads PDFs at baseline/], gap: [/PiCC returns the binary error/, /deferred follow-up/], visibility: [/runtime Claude-style binary error/, /support-matrix table/], parity: [/BELOW the Claude baseline/, /NOT a claim that Claude also errors/], split: [/tool\.Read/] },
  ])("retains $id semantic disclosure", (contract) => {
    expectDisclosure(contract);
  });

  it("discloses NotebookEdit authorization isolation, revalidation, and persistence limits", () => {
    const ne = lookupCapability("tool.NotebookEdit");
    expect(ne?.tier).toBe("full");
    expect(ne?.note).toContain("successful notebook Read in the active conversation");
    expect(ne?.note).toContain("Existing raw cells are addressable");
    expect(ne?.note).toContain("omitting cell_type on replace preserves the existing type, including raw");
    expect(ne?.note).toContain("created/requested cell types remain code or markdown");
    expect(ne?.note).toContain("ordinary child conversations keep independent authorization state");
    expect(ne?.note).toContain("genuine inheriting main-session fork copies");
    expect(ne?.note).toContain("canonical file identity and exact bytes");
    expect(ne?.note).toContain("newest successfully persisted snapshot");
    expect(ne?.note).toContain("unpersisted revocation or positional-fallback-stale transition");
  });

  it("stays in sync with the shipped degrade-stub list, in both directions", () => {
    // Every shipped stub resolves to a dedicated degraded-noop registry entry
    // (a stub reported "unassessed" would be registry drift).
    for (const { name } of DEGRADED_TOOLS) {
      const cap = capabilityForToolName(name);
      expect(cap.id, name).toBe(`tool.${name}`);
      expect(cap.tier, name).toBe("degraded-noop");
      expect(lookupCapability(`tool.${name}`), name).toBeDefined();
    }
    // Every degraded-noop tool entry describes a stub that actually ships — no
    // notes about stubs that don't exist. (The MCP wildcard no longer needs an
    // exemption: mcp__* is a live partial tool surface now, not a stub.)
    const stubNames = new Set(DEGRADED_TOOLS.map((d) => d.name));
    for (const entry of CAPABILITY_REGISTRY) {
      if (entry.kind !== "tool" || entry.tier !== "degraded-noop") continue;
      expect(stubNames.has(entry.id.slice("tool.".length)), entry.id).toBe(true);
    }
    // TaskOutput/TaskStop are REAL tools now, though partial for
    // separately documented gaps; neither may ship as a stub.
    expect(lookupCapability("tool.TaskOutput")?.tier).toBe("partial");
    expect(lookupCapability("tool.TaskStop")?.tier).toBe("partial");
    expect(stubNames.has("TaskOutput")).toBe(false);
    expect(stubNames.has("TaskStop")).toBe(false);
    // SlashCommand is a REAL tool now — retiered to partial and no longer a stub.
    expect(lookupCapability("tool.SlashCommand")?.tier).toBe("partial");
    expect(stubNames.has("SlashCommand")).toBe(false);
    // NotebookRead is RETIRED to a degrade-stub — notebook reading merged into
    // Read (cell-aware); the name is retained only as a gating token.
    expect(lookupCapability("tool.NotebookRead")?.tier).toBe("degraded-noop");
    expect(stubNames.has("NotebookRead")).toBe(true);
    // MultiEdit is a REAL tool now — retiered to full and no longer a stub.
    expect(lookupCapability("tool.MultiEdit")?.tier).toBe("full");
    expect(stubNames.has("MultiEdit")).toBe(false);
    // The stale wrong spelling must be gone: the shipped stub is "computer".
    expect(lookupCapability("tool.computer-use")).toBeUndefined();
    expect(lookupCapability("tool.computer")?.tier).toBe("degraded-noop");
  });

  // Registry-accuracy pass: entries that previously claimed "full" for
  // capabilities with no code consumer (or only boundary-limited consumers).
  // These encode the CORRECTED expectations — if someone re-upgrades an entry
  // without wiring a consumer, this fails.
  it("settings that are parsed but consumed by nothing are not claimed full", () => {
    for (const id of [
      "setting.model",
      "setting.includeCoAuthoredBy",
      "setting.attribution",
      "setting.apiKeyHelper",
      "setting.permissions.additionalDirectories",
    ]) {
      const entry = lookupCapability(id);
      expect(entry, id).toBeDefined();
      expect(entry?.tier, id).toBe("degraded-noop");
    }
  });

  it("settings tiers match their production consumers", () => {
    expect(lookupCapability("setting.skillOverrides")?.tier).toBe("full");
    expect(lookupCapability("setting.enabledPlugins")?.tier).toBe("partial");
    const env = lookupCapability("setting.env");
    expect(env?.tier).toBe("partial");
    expect(env?.note).toContain("main/subagent Bash, hooks, skills, and MCP");
    expect(env?.note).toContain("excluded from PiCC-owned startup and worktree Git administration");
    expect(env?.note).toContain("cannot redirect it");
    expect(env?.note).toContain("MCP server values retain later precedence");

    const bash = lookupCapability("tool.Bash");
    for (const variable of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
      expect(bash?.note, variable).toContain(variable);
    }
    expect(bash?.note).toContain("deliberately disables Pi's");
  });

  it("keeps cleanupPeriodDays partial and bounds its implemented retention claim", () => {
    const c = lookupCapability("setting.cleanupPeriodDays");
    expect(c?.tier).toBe("partial");
    expect(c?.note).toContain("30-day default");
    expect(c?.note).toContain("literal integer >= 1");
    expect(c?.note).toContain("applicable settings source");
    expect(c?.note).toContain("stale verified parents only when no ownership marker conflicts");
    expect(c?.note).toContain("marker-owned orphan collections");
    expect(c?.note).toContain("orphaned worktrees");
    expect(c?.note).toContain("manager-supplied default or custom session directory");
    expect(c?.note).toContain("project's .claude/worktrees directory");
    expect(c?.note).toContain("mtime refresh");
    expect(c?.note).toContain("without a lock-grade guarantee");
    expect(c?.note).toContain("the exact startup session's child transcript collection");
    expect(c?.note).toContain("malformed, unreadable, or mismatched ownership evidence");
    expect(c?.note).toContain("main-session transcripts");
    expect(c?.note).toContain("markerless legacy orphans");
    expect(c?.note).toContain("unfamiliar content");
    expect(c?.note).toContain("unrelated Pi data");
    expect(c?.note).toContain("secure erasure");
    expect(c?.note).toContain("Claude Code's broader application-data cleanup");
  });

  it("agent permissionMode is a safety-relevant no-op, consistent with permissions.defaultMode", () => {
    const mode = lookupCapability("agent.frontmatter.permissionMode");
    expect(mode?.tier).toBe("degraded-noop");
    expect(mode?.safetyRelevant).toBe(true);
  });

  it("agent color is a presentation-only partial and maxTurns a best-effort partial", () => {
    const color = lookupCapability("agent.frontmatter.color");
    expect(color?.tier).toBe("partial");
    expect(color?.note).toContain("recognized documented color names");
    expect(color?.note).toContain("status panel, drill-down, and Agent lifecycle rows");
    expect(color?.note).toContain("exact hues, placement, and permissive normalization are PiCC-defined");
    expect(color?.note).toContain("unrecognized values are ignored for rendering");
    expect(color?.note).toContain("print/RPC remain uncolored");
    expect(color?.note).toContain("does not claim Claude's exact palette or invalid-value behavior");
    const maxTurns = lookupCapability("agent.frontmatter.maxTurns");
    expect(maxTurns?.tier).toBe("partial");
    expect(maxTurns?.note).toContain("best-effort");
  });

  it("skill tool gating / model / effort / paths carry their enforcement boundaries", () => {
    // disallowed-tools deny via the guard for resident skills: full.
    expect(lookupCapability("skill.frontmatter.disallowed-tools")?.tier).toBe("full");
    // allowed-tools only gates fork dispatch — trivially satisfied in-session.
    const allowed = lookupCapability("skill.frontmatter.allowed-tools");
    expect(allowed?.tier).toBe("partial");
    expect(allowed?.safetyRelevant).toBe(true);
    // model/effort honored for fork dispatch; cannot re-model the parent session.
    expect(lookupCapability("skill.frontmatter.model")?.tier).toBe("partial");
    expect(lookupCapability("skill.frontmatter.effort")?.tier).toBe("partial");
    // paths: surfaced on matching file access, activation stays explicit.
    const paths = lookupCapability("skill.frontmatter.paths");
    expect(paths?.tier).toBe("full");
    expect(paths?.note).toContain("surfaced");
  });
});

// ---------------------------------------------------------------------------
// Tool-name resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Matrix freshness — the un-fakeable guard
// ---------------------------------------------------------------------------

describe("capability matrix freshness", () => {
  it("committed doc/supported-features.md is in sync with the registry (regenerated in-process)", () => {
    // Regenerate from the SAME registry + baseline the runtime uses and diff
    // against the committed doc. Both sides CRLF-normalized so a Windows checkout
    // can't false-fail. This makes a stale matrix un-fakeable — a registry edit
    // without `npm run gen:capabilities` fails.
    const firstRender = renderCapabilityMatrix(CAPABILITY_REGISTRY, CLAUDE_BASELINE);
    const secondRender = renderCapabilityMatrix(CAPABILITY_REGISTRY, CLAUDE_BASELINE);
    const committedPath = fileURLToPath(new URL("../doc/supported-features.md", import.meta.url));
    const committed = fs.readFileSync(committedPath, "utf8");
    const norm = (s: string) => s.replace(/\r\n/g, "\n");
    expect(norm(secondRender)).toBe(norm(firstRender));
    expect(norm(committed)).toBe(norm(firstRender));
  });

  it("pins the complete bounded user-guide TUI-only bullet without a print/RPC exemption", () => {
    const guidePath = fileURLToPath(new URL("../doc/user-guide.md", import.meta.url));
    const guide = fs.readFileSync(guidePath, "utf8");
    const bullet = guide.match(/^- \*\*Interactive TUI only\.\*\*[^\n]*(?:\n  [^\n]*)*/m)?.[0].replace(/\r/g, "");

    expect(bullet).toBe("- **Interactive TUI only.** The panel, drill-down, and condensed records exist only in the\n  interactive TUI.");
    expect(bullet).not.toMatch(/print|RPC/);
  });
});

describe("capabilityForToolName", () => {
  it("resolves known tools from the registry", () => {
    const read = capabilityForToolName("Read");
    expect(read.tier).toBe("full");
    expect(read.id).toBe("tool.Read");
  });

  it("resolves mcp__* names to the MCP wildcard entry", () => {
    const cap = capabilityForToolName("mcp__myserver__do_thing");
    expect(cap.id).toBe("tool.mcp__*");
    expect(cap.tier).toBe("partial");
    expect(cap.safetyRelevant).toBe(false);
  });

  it("synthesizes a safe not-supported entry for unknown tools without mutating the registry", () => {
    const before = CAPABILITY_REGISTRY.length;
    const cap = capabilityForToolName("FrobnicateTool");
    expect(cap.tier).toBe("not-supported");
    expect(cap.id).toBe("tool.FrobnicateTool");
    expect(cap.note).toBe("unassessed/unknown — degrades safely");
    expect(CAPABILITY_REGISTRY.length).toBe(before);
    expect(lookupCapability("tool.FrobnicateTool")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildCompatReport
// ---------------------------------------------------------------------------

describe("buildCompatReport", () => {
  it("returns an empty report for a fully-honored project", () => {
    const report = buildCompatReport(makeProject());
    expect(report.findings).toEqual([]);
    expect(report.safetyFindings).toEqual([]);
    expect(report.unassessed).toEqual([]);
  });

  it("derives plugin counts, qualified diagnostics, omissions, and capability findings only from the captured snapshot", () => {
    const inventory = makeInventory([
      makeInventoryItem("healthy@official", {
        installations: [{ validity: "valid", selected: true, diagnostics: [], problems: [] }],
        enablement: { enabled: true, scope: "project", source: { kind: "project", display: "<project>/.claude/settings.json" } },
        outcome: { status: "loaded", sharedStateCauses: [] },
      }),
      makeInventoryItem("broken@community", {
        catalogPresence: true,
        enablement: { enabled: true, scope: "user", source: { kind: "claude-user", display: "<claude-user>/settings.json" } },
        outcome: { status: "enabled-but-uninstalled", sharedStateCauses: [] },
        diagnostics: [{ severity: "warning", message: "C:/SECRET/token=RAW must not survive" }, { severity: "warning", message: "Repair the captured declaration" }],
      }),
    ], {
      diagnostics: [
        { severity: "warning", category: "enabled-plugins-non-boolean", message: "A non-boolean enabledPlugins value was ignored" },
        { severity: "error", category: "managed-policy-malformed", sourceClass: "override", impact: "source-ignored", message: "C:/RAW/POLICY" },
      ],
      capabilityEvidence: [
        { capabilityId: "feature.plugins-content", qualifiedIdentity: "broken@community", component: "commands", observation: "Final loaded component support is partial" },
        { capabilityId: "feature.plugins-other-components", qualifiedIdentity: "broken@community", component: "channels", observation: "Selected manifest declares an unsupported plugin component" },
        { capabilityId: "feature.hook-handler.prompt", qualifiedIdentity: "broken@community", component: "hooks", observation: "Plugin hook handler support is degraded-noop" },
        { capabilityId: "agent.frontmatter.hooks", qualifiedIdentity: "broken@community", component: "worker", observation: "Plugin agent field hooks was stripped before runtime construction" },
        { capabilityId: "feature.future-plugin-capability", qualifiedIdentity: "broken@community", observation: "Capability observation is unassessed because its registry entry is absent" },
      ],
      omissions: { "loader.installed.diagnostics": 3, "snapshot.evidence": 2, "snapshot.items": 4 },
    });
    const project = {
      ...makeProject({ settings: makeSettings({ diagnostics: [{ severity: "warning", message: "enabledPlugins STALE@settings must be a literal boolean" }] }) }),
      pluginInventory: inventory,
      pluginResolutionOutcomes: [{ pluginId: "STALE@outcomes", status: "rejected", diagnostics: [] }],
      mergedHooks: { Notification: [{ hooks: [{ type: "prompt", pluginId: "STALE@hooks", raw: {} }] }] },
    } as unknown as ClaudeProject;

    const report = buildCompatReport(project);
    expect(report.pluginInventory?.counts).toEqual({ known: 2, installed: 1, enabled: 2, loaded: 1, cataloged: 1, attention: 1 });
    expect(report.pluginInventory?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedIdentity: "broken@community", status: "enabled-but-uninstalled", nextCommand: "/plugin details broken@community" }),
    ]));
    for (const id of ["feature.plugins-content", "feature.plugins-other-components", "feature.hook-handler.prompt", "agent.frontmatter.hooks"]) {
      expect([...report.findings, ...report.safetyFindings].some((finding) => finding.capability.id === id), id).toBe(true);
    }
    expect(report.unassessed).toContain('plugin capability "feature.future-plugin-capability" (broken@community)');
    expect(report.findings.some((finding) => finding.evidence.includes("captured plugin diagnostic(s) omitted"))).toBe(false);
    expect(report.findings.some((finding) => finding.evidence.includes("captured plugin capability observation(s) omitted"))).toBe(false);
    const doctor = renderDoctorReport(project, report);
    expect(doctor).toContain("known: 2, installed: 1, enabled: 2, loaded: 1, cataloged: 1, attention: 1");
    expect(doctor).toContain("broken@community");
    expect(doctor).toContain("Selected manifest declares an unsupported plugin component");
    expect(doctor).toContain("<redacted-field>");
    expect(doctor).toContain("A non-boolean enabledPlugins value was ignored");
    expect(doctor).toContain("managed-policy override was malformed; this source was ignored. Correct the managed-policy override format, then run canonical /reload in the interactive TUI, or exit and relaunch PiCC.");
    expect(doctor).toContain("Capture omissions may make these retained counts incomplete: snapshot.items=4.");
    expect(doctor).toContain("Captured for this session; run canonical /reload in the interactive TUI, or exit and relaunch PiCC to refresh.");
    expect(doctor).toContain("Repair boundary: PiCC inventory is read-only; repair plugin state, declarations, or policy outside this command.");
    expect(doctor).toContain("Refresh: Captured for this session; run canonical /reload in the interactive TUI, or exit and relaunch PiCC to refresh.");
    expect(doctor.match(/Repair the captured declaration/gu)).toHaveLength(1);
    expect(doctor.match(/3 additional captured diagnostic\(s\) omitted/gu)).toHaveLength(1);
    expect(doctor.match(/2 additional captured capability observation\(s\) omitted/gu)).toHaveLength(1);
    expect(doctor).toContain('plugin capability "feature.future-plugin-capability" (broken@community)');
    for (const absent of ["healthy@official", "STALE@outcomes", "STALE@hooks", "STALE@settings", "C:/SECRET", "C:/RAW/POLICY", "token=RAW", "caller-provided wording"]) expect(doctor).not.toContain(absent);
  });

  it("flags permissions.ask rules as a safety finding", () => {
    const project = makeProject({
      settings: makeSettings({
        permissions: {
          allow: [],
          deny: [],
          ask: ["Bash(rm *)"],
          additionalDirectories: [],
        },
      }),
    });
    const report = buildCompatReport(project);
    const ask = report.safetyFindings.find((f) => f.capability.id === "setting.permissions.ask");
    expect(ask).toBeDefined();
    expect(ask?.evidence).toContain("Bash(rm *)");
    // Safety findings are split out, not duplicated into functionality findings.
    expect(report.findings.some((f) => f.capability.id === "setting.permissions.ask")).toBe(false);
  });

  it("flags a permission mode as a safety finding", () => {
    const project = makeProject({
      settings: makeSettings({
        permissions: {
          allow: [],
          deny: [],
          ask: [],
          additionalDirectories: [],
          defaultMode: "acceptEdits",
        },
      }),
    });
    const report = buildCompatReport(project);
    const mode = report.safetyFindings.find(
      (f) => f.capability.id === "setting.permissions.defaultMode",
    );
    expect(mode).toBeDefined();
    expect(mode?.evidence).toContain("acceptEdits");
  });

  it("flags deferred settings keys as functionality findings", () => {
    const project = makeProject({
      settings: makeSettings({
        deferredKeys: [
          { key: "outputStyle", scope: "project" },
          { key: "someFutureDeferredThing", scope: "user" },
        ],
      }),
    });
    const report = buildCompatReport(project);
    const style = report.findings.find((f) => f.capability.id === "setting.outputStyle");
    expect(style).toBeDefined();
    expect(style?.capability.tier).toBe("degraded-noop");
    // Deferred key without a dedicated registry entry still degrades, not crashes.
    const other = report.findings.find(
      (f) => f.capability.id === "setting.someFutureDeferredThing",
    );
    expect(other?.capability.tier).toBe("degraded-noop");
  });

  it("routes unknown settings keys to unassessed", () => {
    const project = makeProject({
      settings: makeSettings({ unknownKeys: [{ key: "futureThing", scope: "project" }] }),
    });
    const report = buildCompatReport(project);
    expect(report.unassessed.some((u) => u.includes('"futureThing"'))).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("routes registry-known managed MCP policy keys to safety findings without honoring them", () => {
    const project = makeProject({
      settings: makeSettings({
        unknownKeys: [
          { key: "allowedMcpServers", scope: "managed" },
          { key: "deniedMcpServers", scope: "managed" },
        ],
      }),
    });
    const report = buildCompatReport(project);
    expect(report.unassessed).toEqual([]);
    expect(report.safetyFindings.map((finding) => finding.capability.id)).toEqual([
      "setting.allowedMcpServers",
      "setting.deniedMcpServers",
    ]);
  });

  it("flags unsupported hook event names and non-command handler types", () => {
    const project = makeProject({
      settings: makeSettings({
        hooks: {
          Notification: [{ hooks: [{ type: "command", command: "notify.sh", raw: {} }] }],
          PreToolUse: [{ hooks: [{ type: "prompt", raw: {} }] }],
          SomeBrandNewEvent: [{ hooks: [{ type: "command", command: "x.sh", raw: {} }] }],
        },
      }),
    });
    const report = buildCompatReport(project);
    expect(report.findings.some((f) => f.capability.id === "hook.event.Notification")).toBe(true);
    expect(
      report.findings.some((f) => f.capability.id === "feature.hook-handler.prompt"),
    ).toBe(true);
    // Supported event with a command handler produces no event finding.
    expect(report.findings.some((f) => f.capability.id === "hook.event.PreToolUse")).toBe(false);
    // Truly unknown event name is unassessed, never fatal.
    expect(report.unassessed.some((u) => u.includes('"SomeBrandNewEvent"'))).toBe(true);
  });

  it("classifies mcp_tool handlers for every supported hook event", () => {
    const blockingEvents = [
      "PreToolUse",
      "UserPromptSubmit",
      "Stop",
      "SubagentStop",
      "PreCompact",
      "WorktreeCreate",
    ] as const satisfies readonly (typeof SUPPORTED_HOOK_EVENTS)[number][];
    const ordinaryEvents = [
      "PostToolUse",
      "PostToolUseFailure",
      "SessionStart",
      "SessionEnd",
      "SubagentStart",
      "PostCompact",
      "WorktreeRemove",
    ] as const satisfies readonly (typeof SUPPORTED_HOOK_EVENTS)[number][];
    const root = makeTempDir();
    const userDir = path.join(root, "user");
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({
      hooks: Object.fromEntries(SUPPORTED_HOOK_EVENTS.map((event) => [
        event,
        [{ hooks: [{ type: "mcp_tool", server: "policy", tool: "check", input: {} }] }],
      ])),
    }));
    const settings = loadSettings({ cwd: root, projectRoot: root, userDir, managedPaths: [] });
    const project = makeProject({ settings });
    const report = buildCompatReport(project);

    expect(blockingEvents.length + ordinaryEvents.length).toBe(SUPPORTED_HOOK_EVENTS.length);
    for (const event of SUPPORTED_HOOK_EVENTS) {
      expect([...blockingEvents, ...ordinaryEvents], event).toContain(event);
    }
    expect(report.safetyFindings).toHaveLength(blockingEvents.length);
    expect(report.findings).toHaveLength(ordinaryEvents.length);
    for (const event of blockingEvents) {
      const finding = report.safetyFindings.find(({ evidence }) => evidence.includes(`on "${event}"`));
      expect(finding, event).toMatchObject({
        capability: {
          id: "feature.hook-handler.mcp_tool-blocking-enforcement",
          safetyRelevant: true,
        },
      });
      expect(report.findings.some(({ evidence }) => evidence.includes(`on "${event}"`)), event)
        .toBe(false);
    }
    for (const event of ordinaryEvents) {
      const finding = report.findings.find(({ evidence }) => evidence.includes(`on "${event}"`));
      expect(finding, event).toMatchObject({
        capability: { id: "feature.hook-handler.mcp_tool", safetyRelevant: false },
      });
      expect(report.safetyFindings.some(({ evidence }) => evidence.includes(`on "${event}"`)), event)
        .toBe(false);
    }

    const blockingNote = lookupCapability("feature.hook-handler.mcp_tool-blocking-enforcement")?.note ?? "";
    expect(blockingNote).toContain("For events where PiCC enforces command-hook blocking results");
    expect(blockingNote).toContain("WorktreeCreate creation-time enforcement or other unavailable enforcement");
    const doctor = renderDoctorReport(project, report);
    expect(doctor).toContain("SAFETY feature.hook-handler.mcp_tool-blocking-enforcement");
    expect(doctor).toContain("cannot enforce valid deny/block output");
    expect(doctor).toContain("For events where PiCC enforces command-hook blocking results, use a supported command hook");
    expect(doctor).toContain("use Claude Code when WorktreeCreate creation-time enforcement or other unavailable enforcement is required");
    expect(doctor).toContain("- feature.hook-handler.mcp_tool —");
    expect(doctor).not.toContain("SAFETY feature.hook-handler.mcp_tool —");
  });

  it("flags agents with memory/mcpServers/hooks set", () => {
    const project = makeProject({
      agents: [
        makeAgent({
          name: "stateful",
          memory: { scope: "project" },
          mcpServers: { fetcher: {} },
          hooks: { PreToolUse: [] },
        }),
      ],
    });
    const report = buildCompatReport(project);
    for (const id of [
      "agent.frontmatter.memory",
      "agent.frontmatter.mcpServers",
      "agent.frontmatter.hooks",
    ]) {
      const finding = report.findings.find((f) => f.capability.id === id);
      expect(finding, id).toBeDefined();
      expect(finding?.evidence).toContain('agent "stateful"');
    }
  });

  it("classifies agent-scoped mcp_tool handlers by their effective events", () => {
    const mcpToolHandler = {
      type: "mcp_tool" as const,
      raw: { type: "mcp_tool", server: "policy", tool: "check", input: {} },
    };
    const project = makeProject({
      agents: [makeAgent({
        name: "hooked",
        hooks: {
          PreToolUse: [{ hooks: [mcpToolHandler] }],
          Stop: [{ hooks: [mcpToolHandler] }],
          SessionStart: [{ hooks: [mcpToolHandler] }],
        },
      })],
    });
    const report = buildCompatReport(project);

    const aggregate = report.findings.find(({ capability }) => capability.id === "agent.frontmatter.hooks");
    expect(aggregate?.evidence).toContain('agent "hooked"');

    const preToolUse = report.safetyFindings.find(({ evidence }) => evidence.includes('on "PreToolUse"'));
    expect(preToolUse).toMatchObject({
      capability: { id: "feature.hook-handler.mcp_tool-blocking-enforcement", safetyRelevant: true },
    });
    const stop = report.safetyFindings.find(({ evidence }) => evidence.includes('effective "SubagentStop"'));
    expect(stop).toMatchObject({
      capability: { id: "feature.hook-handler.mcp_tool-blocking-enforcement", safetyRelevant: true },
      evidence: expect.stringContaining('declared as agent "Stop"'),
    });
    expect(stop?.evidence).not.toContain('on "Stop"');

    const sessionStart = report.findings.find(({ evidence }) => evidence.includes('on "SessionStart"'));
    expect(sessionStart).toMatchObject({
      capability: { id: "feature.hook-handler.mcp_tool", safetyRelevant: false },
    });
    expect(report.safetyFindings.some(({ evidence }) => evidence.includes('SessionStart'))).toBe(false);

    const doctor = renderDoctorReport(project, report);
    expect(doctor).toContain("SAFETY feature.hook-handler.mcp_tool-blocking-enforcement");
    expect(doctor).toContain("For events where PiCC enforces command-hook blocking results, use a supported command hook");
    expect(doctor).toContain("use Claude Code when WorktreeCreate creation-time enforcement or other unavailable enforcement is required");
    expect(doctor).not.toContain("SAFETY feature.hook-handler.mcp_tool —");
  });

  it("tolerates malformed raw agent hook frontmatter without throwing", () => {
    const malformedHooks = {
      PreToolUse: "not-a-matcher",
      Stop: null,
      SessionStart: [{ hooks: "not-a-handler-list" }, null],
    } as unknown as NonNullable<ClaudeAgent["hooks"]>;
    const project = makeProject({ agents: [makeAgent({ name: "malformed", hooks: malformedHooks })] });

    expect(() => buildCompatReport(project)).not.toThrow();
    expect(buildCompatReport(project).findings).toEqual([
      expect.objectContaining({
        capability: expect.objectContaining({ id: "agent.frontmatter.hooks" }),
      }),
    ]);
  });

  it("flags degraded/not-supported tools in agents' tools: and routes unknown tools to unassessed", () => {
    const project = makeProject({
      agents: [
        makeAgent({
          name: "gated",
          tools: ["Read", "NotebookEdit", "mcp__srv__x", "TotallyNewTool"],
        }),
      ],
    });
    const report = buildCompatReport(project);
    expect(report.findings.some((f) => f.capability.id === "tool.NotebookEdit")).toBe(false);
    // DELIBERATE TRANSITION: an mcp__* grant stopped being a finding when
    // tool.mcp__* re-tiered to a live partial surface — a supported tool in
    // tools: is as finding-free as Read.
    expect(report.findings.some((f) => f.capability.id === "tool.mcp__*")).toBe(false);
    expect(report.safetyFindings.some((f) => f.capability.id === "tool.mcp__*")).toBe(false);
    expect(report.findings.some((f) => f.capability.id === "tool.Read")).toBe(false);
    expect(report.unassessed.some((u) => u.includes('"TotallyNewTool"'))).toBe(true);
  });

  it("routes unknown skill/agent frontmatter keys to unassessed", () => {
    const project = makeProject({
      skills: [makeSkill({ name: "zappy", unknownKeys: ["zap"] })],
      agents: [makeAgent({ name: "oddball", unknownKeys: ["quux"] })],
    });
    const report = buildCompatReport(project);
    expect(report.unassessed.some((u) => u.includes('skill "zappy"') && u.includes('"zap"'))).toBe(
      true,
    );
    expect(
      report.unassessed.some((u) => u.includes('agent "oddball"') && u.includes('"quux"')),
    ).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("reports permissions.defaultMode exactly once even though settings also defer the key", () => {
    // settings.ts records defaultMode BOTH as permissions.defaultMode and as a
    // deferredKeys entry; the report must not double-count one divergence.
    const project = makeProject({
      settings: makeSettings({
        permissions: {
          allow: [],
          deny: [],
          ask: [],
          additionalDirectories: [],
          defaultMode: "acceptEdits",
        },
        deferredKeys: [{ key: "permissions.defaultMode", scope: "project" }],
      }),
    });
    const report = buildCompatReport(project);
    const findings = [...report.safetyFindings, ...report.findings].filter(
      (f) => f.capability.id === "setting.permissions.defaultMode",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toContain("acceptEdits");
  });

  it("surfaces the parsed-but-unhonored settings when a project declares them", () => {
    const project = makeProject({
      settings: makeSettings({
        model: "opus",
        includeCoAuthoredBy: false,
        attribution: { coAuthoredBy: false },
        apiKeyHelper: "/bin/key-helper.sh",
        permissions: {
          allow: [],
          deny: [],
          ask: [],
          additionalDirectories: ["../shared"],
        },
      }),
    });
    const report = buildCompatReport(project);
    const all = [...report.safetyFindings, ...report.findings];
    for (const id of [
      "setting.model",
      "setting.includeCoAuthoredBy",
      "setting.attribution",
      "setting.apiKeyHelper",
      "setting.permissions.additionalDirectories",
    ]) {
      const finding = all.find((f) => f.capability.id === id);
      expect(finding, id).toBeDefined();
      expect(finding?.capability.tier, id).toBe("degraded-noop");
    }
    expect(all.find((f) => f.capability.id === "setting.model")?.evidence).toContain("opus");
  });

  it("flags an agent permissionMode as a safety finding", () => {
    const project = makeProject({
      agents: [makeAgent({ name: "restricted", permissionMode: "plan" })],
    });
    const report = buildCompatReport(project);
    const mode = report.safetyFindings.find(
      (f) => f.capability.id === "agent.frontmatter.permissionMode",
    );
    expect(mode).toBeDefined();
    expect(mode?.evidence).toContain('agent "restricted"');
    expect(mode?.evidence).toContain("plan");
  });

  it("scans skill allowed-tools like agent tools: — degraded flagged, unknown unassessed, specifiers stripped", () => {
    const project = makeProject({
      skills: [
        makeSkill({
          name: "gated-skill",
          allowedTools: ["Read", "Bash(git *)", "NotebookEdit", "mcp__srv__x", "TotallyNewTool"],
          disallowedTools: ["NotebookRead"],
        }),
      ],
    });
    const report = buildCompatReport(project);
    const notebook = report.findings.find((f) => f.capability.id === "tool.NotebookEdit");
    expect(notebook).toBeUndefined();
    // DELIBERATE TRANSITION: mcp__* in allowed-tools: is no longer a finding —
    // the wildcard re-tiered to a live partial surface with the stdio slice.
    expect(report.findings.some((f) => f.capability.id === "tool.mcp__*")).toBe(false);
    expect(report.safetyFindings.some((f) => f.capability.id === "tool.mcp__*")).toBe(false);
    expect(report.unassessed.some((u) => u.includes('"TotallyNewTool"'))).toBe(true);
    // Fully-honored grants and specifier entries produce no finding/unassessed noise.
    expect(report.findings.some((f) => f.capability.id === "tool.Read")).toBe(false);
    expect(report.findings.some((f) => f.capability.id === "tool.Bash")).toBe(false);
    expect(report.unassessed.some((u) => u.includes("Bash"))).toBe(false);
    // disallowed-tools denying a tool is trivially satisfied — no finding. NotebookRead
    // is now a real `partial` tool, and denying a real tool is equally legitimate.
    expect(report.findings.some((f) => f.capability.id === "tool.NotebookRead")).toBe(false);
  });

  it("scans already-resolved installed-plugin hooks without reopening component files", () => {
    const project = {
      ...makeProject(),
      mergedHooks: {
        Notification: [{ hooks: [{ type: "command", command: "notify.sh", pluginId: "hooky@market", raw: {} }] }],
        PreToolUse: [{ hooks: [
          { type: "prompt", pluginId: "hooky@market", raw: {} },
          { type: "mcp_tool", pluginId: "hooky@market", raw: {} },
        ] }],
        SessionStart: [{ hooks: [{ type: "mcp_tool", pluginId: "hooky@market", raw: {} }] }],
      },
    } as unknown as ClaudeProject;
    const report = buildCompatReport(project);
    const event = report.findings.find((f) => f.capability.id === "hook.event.Notification");
    expect(event?.evidence).toContain('installed plugin "hooky@market"');
    const handler = report.findings.find(
      (f) => f.capability.id === "feature.hook-handler.prompt",
    );
    expect(handler?.evidence).toContain('installed plugin "hooky@market"');
    expect(report.safetyFindings).toContainEqual(expect.objectContaining({
      capability: expect.objectContaining({ id: "feature.hook-handler.mcp_tool-blocking-enforcement" }),
      evidence: expect.stringContaining('on "PreToolUse" from installed plugin "hooky@market"'),
    }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      capability: expect.objectContaining({ id: "feature.hook-handler.mcp_tool" }),
      evidence: expect.stringContaining('on "SessionStart" from installed plugin "hooky@market"'),
    }));
    expect(report.safetyFindings.some(({ evidence }) => evidence.includes('on "SessionStart"'))).toBe(false);
  });

  it("prioritizes late safety-relevant installed-plugin hook details within the shared budget", () => {
    const project = {
      ...makeProject(),
      mergedHooks: {
        SessionStart: [{ hooks: Array.from({ length: 20 }, (_, index) => ({
          type: "prompt",
          pluginId: `ordinary-${index}@market`,
          raw: {},
        })) }],
        PreToolUse: [{ hooks: [{
          type: "mcp_tool",
          pluginId: "blocking@market",
          raw: {},
        }] }],
      },
    } as unknown as ClaudeProject;
    const report = buildCompatReport(project);

    expect(report.safetyFindings).toContainEqual(expect.objectContaining({
      capability: expect.objectContaining({
        id: "feature.hook-handler.mcp_tool-blocking-enforcement",
        safetyRelevant: true,
      }),
      evidence: expect.stringContaining('from installed plugin "blocking@market"'),
    }));
    expect(report.findings.filter(({ capability, evidence }) =>
      capability.id === "feature.hook-handler.prompt" && evidence.includes("ordinary-"),
    )).toHaveLength(19);
    expect(report.findings).toContainEqual(expect.objectContaining({
      capability: expect.objectContaining({ id: "feature.plugins-hooks" }),
      evidence: "1 additional installed-plugin hook limitation(s) omitted.",
    }));
  });

  it("emits a safety-relevant omission when blocking installed-plugin hook candidates exceed the bounded collection", () => {
    const project = {
      ...makeProject(),
      mergedHooks: {
        PreToolUse: [{ hooks: Array.from({ length: 100 }, (_, index) => ({
          type: "mcp_tool",
          pluginId: `blocking-${index}@market`,
          raw: {},
        })) }],
      },
    } as unknown as ClaudeProject;
    const report = buildCompatReport(project);
    const safetyDetails = report.safetyFindings.filter(({ evidence }) =>
      evidence.includes('from installed plugin "blocking-'),
    );
    const safetyOmissions = report.safetyFindings.filter(({ evidence }) =>
      evidence.includes("additional safety-relevant installed-plugin hook limitation(s) omitted"),
    );

    expect(safetyDetails).toHaveLength(20);
    expect(safetyOmissions).toEqual([expect.objectContaining({
      capability: expect.objectContaining({
        id: "feature.hook-handler.mcp_tool-blocking-enforcement",
        safetyRelevant: true,
      }),
      evidence: "At least 61 additional safety-relevant installed-plugin hook limitation(s) omitted.",
    })]);
    expect(safetyOmissions[0]?.evidence).not.toContain("blocking-");
  });

  it("tolerates malformed plugin outcome input without crashing the scan", () => {
    const project = {
      ...makeProject(),
      pluginResolutionOutcomes: [
        null,
        42,
        "junk",
        { pluginId: 7, status: "future", diagnostics: "bad", sharedStateCauses: "installed-state-unreadable" },
        { pluginId: "stale@market", status: "enabled-but-uninstalled", sharedStateCauses: ["installed-state-unreadable"], diagnostics: [] },
        { pluginId: "empty@market", status: "rejected", sharedStateCauses: [], diagnostics: [] },
        { pluginId: "duplicate@market", status: "rejected", sharedStateCauses: ["installed-state-unreadable", "installed-state-unreadable"], diagnostics: [] },
        { pluginId: "unknown@market", status: "rejected", sharedStateCauses: ["installed-state-unreadable", "future-cause"], diagnostics: [] },
        { pluginId: "overlong@market", status: "malformed", sharedStateCauses: ["installed-state-malformed", "blocklist-unreadable", "blocklist-malformed"], diagnostics: [] },
        { pluginId: "contradictory@market", status: "malformed", sharedStateCauses: ["installed-state-unreadable", "installed-state-malformed"], diagnostics: [] },
        { pluginId: "block-contradictory@market", status: "malformed", sharedStateCauses: ["blocklist-unreadable", "blocklist-malformed"], diagnostics: [] },
        { pluginId: "out-of-order@market", status: "malformed", sharedStateCauses: ["blocklist-malformed", "installed-state-malformed"], diagnostics: [] },
        { pluginId: "stale-rejected@market", status: "rejected", sharedStateCauses: ["installed-state-malformed"], diagnostics: [] },
        { pluginId: "stale-malformed@market", status: "malformed", sharedStateCauses: ["installed-state-unreadable"], diagnostics: [] },
        { pluginId: "stale-blocklist-malformed@market", status: "rejected", sharedStateCauses: ["installed-state-unreadable", "blocklist-malformed"], diagnostics: [] },
        { pluginId: "stale-blocklist-unreadable@market", status: "malformed", sharedStateCauses: ["installed-state-malformed", "blocklist-unreadable"], diagnostics: [] },
        { pluginId: "defensive@market", status: "rejected", sharedStateCauses: [null, "unknown", 7], diagnostics: [null, { message: 7 }] },
      ],
    } as unknown as ClaudeProject;
    expect(() => buildCompatReport(project)).not.toThrow();
    const report = buildCompatReport(project);
    expect(report.findings).toHaveLength(13);
    for (const identity of ["stale", "empty", "duplicate", "unknown", "overlong", "contradictory", "block-contradictory", "out-of-order", "stale-rejected", "stale-malformed", "stale-blocklist-malformed", "stale-blocklist-unreadable", "defensive"]) {
      expect(report.findings.some((finding) => finding.evidence.startsWith(`${identity}@market:`))).toBe(true);
    }
    expect(report.findings.some((finding) => finding.evidence.includes("stale@market: enabled but no applicable installed record"))).toBe(true);
    expect(report.findings.some((finding) => finding.evidence.includes("stale-rejected@market: installed content was rejected"))).toBe(true);
    expect(report.findings.some((finding) => finding.evidence.includes("stale-malformed@market: plugin installed-state or blocklist data is malformed"))).toBe(true);
    expect(report.findings.some((finding) => finding.evidence.includes("plugins/installed_plugins.json"))).toBe(false);
  });

  it("reports each resolver-produced shared plugin-state cause once with only its safe recovery", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-doctor-plugin-state-"));
    const userDir = path.join(root, "user", ".claude");
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(projectRoot, { recursive: true });
    const enablement = Object.fromEntries(["private-one@market", "private-two@market"].map((pluginId) => [pluginId, {
      enabled: true,
      scope: "user" as const,
      source: path.join(userDir, "settings.json"),
    }]));
    const recoveries = [
      "Check access and permissions for plugins/installed_plugins.json relative to the active Claude user directory",
      "Repair or regenerate plugins/installed_plugins.json through Claude Code",
      "Update PiCC or contact PiCC support for this format",
      "Check access and permissions for plugins/blocklist.json relative to the active Claude user directory",
      "Repair plugins/blocklist.json so it is a valid JSON object, its optional plugins field is an array, and each entry's plugin field is a qualified name@marketplace identity",
    ] as const;
    const cases = [
      { status: "unreadable", blocklist: () => { throw Object.assign(new Error("missing C:/RAW/state"), { code: "ENOENT" }); }, recovery: recoveries[0] },
      { status: "malformed", blocklist: () => { throw Object.assign(new Error("missing C:/RAW/state"), { code: "ENOENT" }); }, recovery: recoveries[1] },
      { status: "unsupported", blocklist: () => { throw Object.assign(new Error("missing C:/RAW/state"), { code: "ENOENT" }); }, recovery: recoveries[2] },
      { status: "valid", blocklist: () => { throw new Error("denied C:/RAW/blocklist.json"); }, recovery: recoveries[3] },
      { status: "valid", blocklist: () => JSON.stringify({ plugins: [{ plugin: "unqualified RAW" }] }), recovery: recoveries[4] },
    ] as const;

    try {
      for (const scenario of cases) {
        let reads = 0;
        const resolved = resolveInstalledPlugins({
          userDir,
          projectRoot,
          enablement,
          installations: [],
          installedStateStatus: scenario.status,
          readBlocklistForTest: (file) => {
            reads += 1;
            expect(file).toBe(path.join(userDir, "plugins", "blocklist.json"));
            return scenario.blocklist();
          },
        });
        expect(resolved.plugins).toEqual([]);
        expect(resolved.outcomes).toHaveLength(2);
        const readsAfterResolution = reads;
        const project = { ...makeProject(), pluginResolutionOutcomes: resolved.outcomes } as unknown as ClaudeProject;
        const report = buildCompatReport(project);
        const doctor = renderDoctorReport(project, report);
        expect(reads).toBe(readsAfterResolution);
        expect(report.findings.filter((finding) => finding.capability.id === "feature.plugins-installed-selection")).toHaveLength(1);
        expect(doctor.match(/all enabled plugins were rejected/g)).toHaveLength(1);
        expect(doctor.split(scenario.recovery)).toHaveLength(2);
        expect(doctor).toContain("run the canonical /reload in the interactive TUI or exit and relaunch PiCC");
        expect(doctor).not.toContain("/new");
        for (const incompatible of recoveries.filter((recovery) => recovery !== scenario.recovery)) expect(doctor).not.toContain(incompatible);
        for (const secret of ["private-one", "private-two", root, "C:/RAW", "unqualified RAW"]) expect(doctor).not.toContain(secret);
        expect(doctor.toLowerCase()).not.toContain("reinstall");
        expect(doctor).toContain("Compatibility findings:");
        expect(doctor).not.toContain("Findings (declared by this project, not fully honored):");
        expect(doctor).not.toContain("No compatibility findings detected.");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves simultaneous resolver-produced installed-state and blocklist causes once each", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-doctor-plugin-state-combined-"));
    try {
      const userDir = path.join(root, "user", ".claude");
      const projectRoot = path.join(root, "project");
      fs.mkdirSync(projectRoot, { recursive: true });
      let reads = 0;
      const resolved = resolveInstalledPlugins({
        userDir,
        projectRoot,
        enablement: Object.fromEntries(["private-one@market", "private-two@market"].map((pluginId) => [pluginId, {
          enabled: true,
          scope: "user" as const,
          source: path.join(userDir, "settings.json"),
        }])),
        installations: [],
        installedStateStatus: "unreadable",
        readBlocklistForTest: () => {
          reads += 1;
          return "{RAW malformed blocklist";
        },
      });
      expect(resolved.outcomes.map((outcome) => outcome.sharedStateCauses)).toEqual([
        ["installed-state-unreadable", "blocklist-malformed"],
        ["installed-state-unreadable", "blocklist-malformed"],
      ]);
      const project = { ...makeProject(), pluginResolutionOutcomes: resolved.outcomes } as unknown as ClaudeProject;
      const doctor = renderDoctorReport(project, buildCompatReport(project));
      expect(reads).toBe(1);
      expect(doctor.match(/plugins\/installed_plugins\.json/g)).toHaveLength(1);
      expect(doctor.match(/plugins\/blocklist\.json/g)).toHaveLength(1);
      expect(doctor).not.toContain("private-");
      expect(doctor).not.toContain(root);
      expect(doctor).not.toContain("RAW");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports every normalized plugin state, stripped agent fields, and activation policy safely", () => {
    const outcomes = [
      { pluginId: "loaded@market", status: "loaded", diagnostics: [{ severity: "warning", message: "Installed plugin agent loader reported unsupported content", source: "C:/SECRET/agent.md" }] },
      { pluginId: "disabled@market", status: "disabled", diagnostics: [] },
      { pluginId: "missing@market", status: "enabled-but-uninstalled", diagnostics: [] },
      { pluginId: "future@market", status: "unsupported", diagnostics: [] },
      { pluginId: "ambiguous@market", status: "ambiguous", diagnostics: [] },
      { pluginId: "blocked@market", status: "blocked", diagnostics: [] },
      { pluginId: "broken@market", status: "malformed", diagnostics: [] },
      { pluginId: "escape@market", status: "rejected", diagnostics: [{ severity: "warning", message: "escaped path C:/ABSOLUTE/SECRET", source: "C:/ABSOLUTE/SECRET" }] },
    ];
    const stripped = makeAgent({
      name: "plug:worker",
      source: { path: "C:/SECRET/worker.md", scope: "plugin", pluginId: "plug@market", pluginName: "plug" },
      diagnostics: ["hooks", "mcpServers", "permissionMode"].map((field) => ({
        severity: "warning" as const,
        message: `Plugin agent field "${field}" is forbidden and was removed`,
        source: "C:/SECRET/worker.md",
      })),
    });
    const project = {
      ...makeProject({
        agents: [stripped],
        settings: makeSettings({
          diagnostics: [
            { severity: "warning", message: "raw administrator secret", category: "managed-policy-unreadable", sourceClass: "system-file", impact: "source-ignored", source: "C:/SECRET/policy" },
            { severity: "warning", message: 'Plugin "typed@market" in "enabledPlugins" must be a literal boolean; ignored', source: "C:/SECRET/settings.json" },
          ],
        }),
      }),
      pluginResolutionOutcomes: outcomes,
    } as unknown as ClaudeProject;
    const report = buildCompatReport(project);
    expect(report.pluginPosture?.counts).toEqual({
      loaded: 1,
      disabled: 1,
      "enabled-but-uninstalled": 1,
      unsupported: 1,
      ambiguous: 1,
      blocked: 1,
      malformed: 1,
      rejected: 1,
    });
    const doctor = renderDoctorReport(project, report);
    for (const status of ["loaded", "disabled", "enabled-but-uninstalled", "unsupported", "ambiguous", "blocked", "malformed", "rejected"]) {
      expect(doctor).toContain(`${status}: 1`);
    }
    for (const identity of ["missing@market", "future@market", "ambiguous@market", "blocked@market", "broken@market", "escape@market"]) {
      const outcomeLine = doctor.split("\n").find((line) => line.includes(identity)) ?? "";
      expect(outcomeLine).toContain("run the canonical /reload in the interactive TUI or exit and relaunch PiCC");
      expect(outcomeLine).not.toContain("/new");
    }
    expect(doctor.match(/no fallback content loaded/g)?.length).toBeGreaterThanOrEqual(6);
    expect(doctor).toContain("Administrator policy (system-file) was unreadable; that source was ignored");
    expect(doctor).toContain("non-boolean enablement value was ignored");
    const enablementLine = doctor.split("\n").find((line) => line.includes("non-boolean enablement value was ignored")) ?? "";
    expect(enablementLine).toContain("run the canonical /reload in the interactive TUI or exit and relaunch PiCC");
    expect(enablementLine).not.toContain("/new");
    for (const [field, alternative] of [
      ["hooks", "Use supported plugin-level hooks, or remove this field; agent-scoped hooks are retained only for non-plugin agents."],
      ["mcpServers", "Configure session MCP servers and gate their tools, or remove this field; per-agent MCP configuration is not retained."],
      ["permissionMode", "Use deny rules and tools gating, or remove this field; plugin agents cannot retain permissionMode."],
    ]) {
      expect(doctor).toContain(`forbidden ${field} was stripped before subagent construction`);
      expect(doctor).toContain(alternative);
    }
    expect(doctor).toContain('installed plugin "plug@market" agent "plug:worker"');
    expect(doctor).not.toContain("No compatibility findings detected.");
    for (const secret of ["C:/SECRET", "C:/ABSOLUTE", "raw administrator secret"]) expect(doctor).not.toContain(secret);
    expect(doctor).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u);
  });

  it("keeps disabled plugin outcomes summary-only and non-error", () => {
    const project = {
      ...makeProject(),
      pluginResolutionOutcomes: [{ pluginId: "quiet@market", status: "disabled", diagnostics: [] }],
    } as unknown as ClaudeProject;
    const report = buildCompatReport(project);
    expect(report.findings).toEqual([]);
    expect(report.safetyFindings).toEqual([]);
    const doctor = renderDoctorReport(project, report);
    expect(doctor).toContain("Plugin selection: disabled: 1.");
    expect(doctor).toContain("No compatibility findings detected.");
    expect(doctor).not.toContain("quiet@market");
  });

  it("bounds heterogeneous plugin findings with one source-neutral omission finding", () => {
    const project = {
      ...makeProject(),
      pluginResolutionOutcomes: [
        { pluginId: "state-one@market", status: "malformed", sharedStateCauses: ["installed-state-malformed"], diagnostics: [] },
        { pluginId: "state-two@market", status: "rejected", sharedStateCauses: ["installed-state-unreadable"], diagnostics: [] },
        { pluginId: "list-one@market", status: "malformed", sharedStateCauses: ["blocklist-malformed"], diagnostics: [] },
        { pluginId: "list-two@market", status: "rejected", sharedStateCauses: ["blocklist-unreadable"], diagnostics: [] },
        { pluginId: "missing@market", status: "enabled-but-uninstalled", diagnostics: [] },
        ...Array.from({ length: 20 }, (_, index) => ({
          pluginId: `reject-${String(index).padStart(2, "0")}@market`,
          status: "rejected" as const,
          diagnostics: [{ severity: "warning" as const, message: "path validation failure" }],
        })),
      ],
    } as unknown as ClaudeProject;
    const report = buildCompatReport(project);
    expect(report.pluginPosture?.details).toHaveLength(20);
    expect(report.pluginPosture?.omitted).toBe(5);
    const selection = report.findings.filter((finding) => finding.capability.id === "feature.plugins-installed-selection");
    expect(selection).toHaveLength(21);
    expect(selection[0]?.evidence).toContain("plugins/installed_plugins.json");
    expect(selection[4]?.evidence).toContain("missing@market");
    expect(selection[19]?.evidence).toContain("reject-14@market");
    expect(selection[20]?.evidence).toBe("5 additional plugin detail(s) omitted. Review plugin enablement, installed state, qualified blocklist, and selected plugin content as applicable, then run the canonical /reload in the interactive TUI or exit and relaunch PiCC.");
    expect(selection[20]?.evidence).not.toMatch(/outcome|repair/i);
    expect(selection.map((finding) => finding.evidence).join("\n")).not.toContain("reject-15@market");
  });

  it("bounds stripped-agent and resolved-hook diagnostic detail independently", () => {
    const agents = Array.from({ length: 10 }, (_, index) => makeAgent({
      name: `plug:agent-${index}`,
      source: { path: `<agent-${index}>`, scope: "plugin", pluginId: `plug-${index}@market`, pluginName: `plug-${index}` },
      diagnostics: ["hooks", "mcpServers", "permissionMode"].map((field) => ({
        severity: "warning" as const,
        message: `Plugin agent field "${field}" is forbidden and was removed`,
      })),
    }));
    const project = {
      ...makeProject({ agents }),
      mergedHooks: {
        Notification: [{ hooks: Array.from({ length: 25 }, (_, index) => ({
          type: "prompt",
          pluginId: `hook-${index}@market`,
          raw: {},
        })) }],
      },
    } as unknown as ClaudeProject;
    const report = buildCompatReport(project);
    const allFindings = [...report.safetyFindings, ...report.findings];
    expect(allFindings.filter((finding) => finding.evidence.includes("was stripped before subagent construction"))).toHaveLength(20);
    expect(report.findings.some((finding) => finding.evidence === "10 additional stripped plugin-agent field finding(s) omitted.")).toBe(true);
    const hookDetails = report.findings.filter((finding) => finding.evidence.includes("installed plugin \"hook-"));
    expect(hookDetails).toHaveLength(20);
    expect(report.findings.some((finding) => finding.evidence === "30 additional installed-plugin hook limitation(s) omitted.")).toBe(true);
  });

  it("reports the retained managed-policy and activation diagnostic matrix with fixed safe wording", () => {
    const diagnostics = [
      { severity: "warning", message: "RAW malformed detail", category: "managed-policy-malformed", sourceClass: "system-file", impact: "source-ignored", source: "C:/RAW/managed.json" },
      { severity: "warning", message: "RAW unreadable detail", category: "managed-policy-unreadable", sourceClass: "system-drop-in", impact: "source-ignored", source: "C:/RAW/drop-in.json" },
      { severity: "warning", message: "RAW override detail", category: "managed-policy-malformed", sourceClass: "override", impact: "source-ignored", source: "C:/RAW/override" },
      { severity: "warning", message: "RAW unknown source", category: "managed-policy-unreadable", sourceClass: "RAW-SOURCE-CLASS", impact: "source-ignored", source: "C:/RAW/unknown" },
      { severity: "warning", message: "RAW malformed source", category: "managed-policy-malformed", sourceClass: 7, impact: "RAW-IMPACT", source: "C:/RAW/malformed" },
      { severity: "warning", message: "enabledPlugins must be a literal boolean RAW-VALUE", source: "C:/RAW/settings" },
      { severity: "warning", message: "enabledPlugins is not an object RAW-OBJECT", source: "C:/RAW/settings" },
      { severity: "warning", message: "plugin identity is invalid RAW-IDENTITY", source: "C:/RAW/settings" },
      { severity: "warning", message: "enabledPlugins contains another invalid entry RAW-GENERIC", source: "C:/RAW/settings" },
    ] as unknown as ClaudeSettings["diagnostics"];
    const project = makeProject({ settings: makeSettings({ diagnostics }) });
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    for (const phrase of [
      "Administrator policy (system-file) was malformed; that source was ignored",
      "Administrator policy (system-drop-in) was unreadable; that source was ignored",
      "Managed-settings override was malformed; that source was ignored",
      "Managed-policy source was unreadable; that source was ignored",
      "Managed-policy source was malformed; policy processing was degraded",
      "a non-boolean enablement value was ignored",
      "the enablement mapping was not an object and was ignored",
      "an invalid qualified identity was ignored",
      "an invalid activation entry was ignored",
    ]) expect(doctor).toContain(phrase);
    expect(doctor).not.toContain("No compatibility findings detected.");
    for (const raw of ["C:/RAW", "RAW-SOURCE-CLASS", "RAW-IMPACT", "RAW-VALUE", "RAW-OBJECT", "RAW-IDENTITY", "RAW-GENERIC"]) expect(doctor).not.toContain(raw);
    expect(doctor).not.toContain("Administrator policy (override)");
    expect(doctor.match(/Administrator policy/g)).toHaveLength(2);
    const managedPolicyLine = doctor.split("\n").find((line) =>
      line.includes("Administrator policy (system-file) was malformed")
    ) ?? "";
    expect(managedPolicyLine).toContain("run the canonical /reload in the interactive TUI or exit and relaunch PiCC");
    expect(managedPolicyLine).not.toContain("/new");
  });

  it("keeps a clean loaded outcome summary-only and gives loaded component limitations bounded actions", () => {
    const clean = {
      ...makeProject(),
      pluginResolutionOutcomes: [{ pluginId: "clean@market", status: "loaded", diagnostics: [] }],
    } as unknown as ClaudeProject;
    const cleanDoctor = renderDoctorReport(clean, buildCompatReport(clean));
    expect(cleanDoctor).toContain("Plugin selection: loaded: 1.");
    expect(cleanDoctor).toContain("No compatibility findings detected.");
    expect(cleanDoctor).not.toContain("clean@market");

    const limited = {
      ...makeProject(),
      pluginResolutionOutcomes: [
        {
          pluginId: "limited@market",
          status: "loaded",
          diagnostics: [{ severity: "warning", message: "component is not a directory", source: "C:/RAW/component" }],
        },
        {
          pluginId: "stripped@market",
          status: "loaded",
          diagnostics: [{ severity: "warning", message: "unsupported declaration was stripped", source: "C:/RAW/stripped" }],
        },
      ],
    } as unknown as ClaudeProject;
    const limitedReport = buildCompatReport(limited);
    const componentFindings = limitedReport.findings.filter(
      (finding) => finding.capability.id === "feature.plugins-content",
    );
    const selectionFindings = limitedReport.findings.filter(
      (finding) => finding.capability.id === "feature.plugins-installed-selection",
    );
    expect(componentFindings).toHaveLength(2);
    expect(selectionFindings).toHaveLength(0);
    const doctor = renderDoctorReport(limited, limitedReport);
    expect(doctor).toContain("feature.plugins-content");
    expect(doctor).toContain("limited@market: loaded with wrong component kind; some declared content was skipped");
    expect(doctor).toContain("Correct the applicable component declaration, access, or installed file/directory kind in Claude Code");
    expect(doctor).toContain("stripped@market: loaded with unsupported component content; some declared content was stripped");
    expect(doctor).toContain("Remove or replace the unsupported declaration or content in Claude Code");
    expect(doctor.match(/run the canonical \/reload in the interactive TUI or exit and relaunch PiCC/g)).toHaveLength(2);
    expect(doctor).toMatch(/skipped|ignored|stripped|degraded/i);
    expect(doctor).not.toContain("no fallback content loaded");
    expect(doctor).not.toMatch(/affected component did not load|whole plugin failed|component failed|plugin failed/i);
    expect(doctor).not.toContain("C:/RAW");
    expect(doctor).not.toContain("Inspect /doctor");
    expect(doctor).not.toContain("No compatibility findings detected.");
  });

  it("caps loaded component limitations at twenty plus one accurate omission", () => {
    const project = {
      ...makeProject(),
      pluginResolutionOutcomes: Array.from({ length: 23 }, (_, index) => ({
        pluginId: `limited-${index}@market`,
        status: "loaded",
        diagnostics: [{ severity: "warning", message: "malformed content" }],
      })),
    } as unknown as ClaudeProject;
    const findings = buildCompatReport(project).findings.filter((item) => item.capability.id === "feature.plugins-content");
    expect(findings).toHaveLength(21);
    expect(findings.filter((item) => item.evidence.includes("loaded with malformed content"))).toHaveLength(20);
    expect(findings.at(-1)?.evidence).toBe("3 additional loaded-plugin component limitation(s) omitted.");
  });

  it("renders hostile plugin diagnostic identities and handler types terminal-safely", () => {
    const hostile = `name\u001b[31m\u0000\u2060${"x".repeat(300)}@market`;
    const hostileAgent = `agent\u001b\u0000\u200b${"y".repeat(300)}`;
    const hostileEvent = `Future\u001b\u0000\u2060${"e".repeat(200)}`;
    const hostileType = `future\u001b\u0000\u200b${"t".repeat(200)}`;
    const project = {
      ...makeProject({ agents: [makeAgent({
        name: hostileAgent,
        source: { path: "<hostile>", scope: "plugin", pluginId: hostile, pluginName: "name" },
        diagnostics: [{ severity: "warning", message: 'Plugin agent field "hooks" is forbidden and was removed' }],
      })] }),
      pluginResolutionOutcomes: [{ pluginId: hostile, status: "rejected", diagnostics: [] }],
      mergedHooks: {
        [hostileEvent]: [{ hooks: [
          { type: "prompt", pluginId: hostile, raw: {} },
          { type: hostileType, pluginId: hostile, raw: {} },
          { type: 7, pluginId: hostile, raw: {} },
        ] }],
      },
    } as unknown as ClaudeProject;
    expect(() => buildCompatReport(project)).not.toThrow();
    const report = buildCompatReport(project);
    expect(report.findings.some((item) => item.capability.id === "feature.hook-handler.prompt")).toBe(true);
    expect(report.unassessed.some((item) => item.includes("invalid handler type"))).toBe(true);
    const doctor = renderDoctorReport(project, report);
    expect(doctor).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cf}]/u);
    for (const evidence of [...report.findings.map((item) => item.evidence), ...report.unassessed]) {
      expect(evidence.length).toBeLessThan(700);
    }
  });

  it("deduplicates plugin-hook limitations before the detail cap", () => {
    const duplicate = { type: "prompt", pluginId: "duplicate@market", raw: {} };
    const project = {
      ...makeProject(),
      mergedHooks: {
        PreToolUse: [{ hooks: [...Array.from({ length: 25 }, () => ({ ...duplicate })), { type: "agent", pluginId: "distinct@market", raw: {} }] }],
      },
    } as unknown as ClaudeProject;
    const report = buildCompatReport(project);
    expect(report.findings.filter((item) => item.capability.id === "feature.hook-handler.prompt")).toHaveLength(1);
    expect(report.findings.filter((item) => item.capability.id === "feature.hook-handler.agent")).toHaveLength(1);
    expect(report.findings.some((item) => item.evidence.includes("installed-plugin hook limitation(s) omitted"))).toBe(false);
  });

  it("uses state-specific plugin remedies without false policy provenance or circular actions", () => {
    const project = {
      ...makeProject(),
      pluginResolutionOutcomes: [
        { pluginId: "unsupported@market", status: "unsupported", diagnostics: [] },
        { pluginId: "ambiguous@market", status: "ambiguous", diagnostics: [] },
        { pluginId: "blocked@market", status: "blocked", diagnostics: [] },
        { pluginId: "malformed@market", status: "malformed", diagnostics: [] },
        { pluginId: "access@market", status: "rejected", diagnostics: [{ severity: "warning", message: "unreadable component" }] },
        { pluginId: "escape@market", status: "rejected", diagnostics: [{ severity: "warning", message: "path escape mismatch" }] },
      ],
    } as unknown as ClaudeProject;
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    expect(doctor).toContain("Check for or update to PiCC support for this format");
    expect(doctor).toContain("Reconcile or reinstall this qualified identity through Claude Code");
    expect(doctor).toContain("listed in the qualified plugin blocklist");
    expect(doctor).toContain("Review that blocklist entry");
    expect(doctor).toContain("plugin installed-state or blocklist data is malformed");
    expect(doctor).toContain("Check those Claude Code state inputs");
    expect(doctor).toContain("Check the applicable component declaration and installed file or directory kind");
    expect(doctor).toContain("Reconcile or reinstall the qualified plugin through Claude Code");
    expect(doctor).not.toContain("reinstall or reconcile");
    expect(doctor).not.toMatch(/administrator|untrusted by administrator|Ask the administrator/i);
    expect(doctor).not.toContain("Inspect /doctor");
  });

  // -------------------------------------------------------------------------
  // MCP discovery-fed findings (replacing the retired static filesystem check)
  // -------------------------------------------------------------------------

  it("no longer flags .mcp.json by mere filesystem presence — findings come from discovery", () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, ".mcp.json"), '{ "mcpServers": {} }', "utf8");
    // A project literal WITHOUT resolved discovery data (mcp undefined) must
    // produce no MCP finding even though the file exists on disk.
    const report = buildCompatReport(makeProject({ root, cwd: root }));
    expect(report.findings.some((f) => f.capability.id.includes("mcp"))).toBe(false);
    expect(report.mcpPendingNotice).toBeUndefined();
  });

  it("pending-approval servers yield one finding with bounded approval and decline guidance", () => {
    const project = makeProject({
      mcp: makeMcp({
        servers: [
          makeMcpServer({ name: "alpha", status: "pending-approval" }),
          makeMcpServer({ name: "beta", status: "pending-approval" }),
        ],
      }),
    });
    const report = buildCompatReport(project);
    const pending = report.findings.filter(
      (f) => f.capability.id === "feature.mcp-project-approval",
    );
    expect(pending).toHaveLength(1);
    const evidence = pending[0]!.evidence;
    expect(evidence).toContain("alpha");
    expect(evidence).toContain("beta");
    expect(evidence).toContain("enabledMcpjsonServers");
    expect(evidence).toContain("disabledMcpjsonServers");
    const note = pending[0]!.capability.note;
    expect(note).toContain("name-based, not definition-bound");
    expect(note).toContain("re-review definitions after project MCP changes");
    // The one-time notify line stays bounded: names + enabling key + /doctor
    // pointer, never a JSON settings payload.
    expect(report.mcpPendingNotice).toContain("alpha");
    expect(report.mcpPendingNotice).toContain("enabledMcpjsonServers");
    expect(report.mcpPendingNotice).not.toContain('"enabledMcpjsonServers":');
    expect(report.mcpPendingNotice).toContain("/doctor");
  });

  it("surfaces an ENABLED server's diagnostics as findings — variable named, values never expanded", () => {
    // Per-server diagnostics are findings for EVERY status, not only skipped:
    // an enabled server's unset-${VAR} warning is degraded state the user must
    // see without opening /doctor's posture line.
    const project = makeProject({
      mcp: makeMcp({
        servers: [
          makeMcpServer({
            name: "live",
            status: "enabled",
            command: "/secret/expanded/bin",
            rawCommand: "${MCP_BIN}",
            diagnostics: [
              'environment variable "MCP_BIN" is not set and has no default; "${MCP_BIN}" kept as literal text',
            ],
          }),
        ],
      }),
    });
    const report = buildCompatReport(project);
    const diags = report.findings.filter((f) => f.capability.id === "feature.mcp");
    expect(diags).toHaveLength(1);
    // The finding names the server (the resolver's unset-var diagnostic does
    // not embed it) and the variable — never the expanded value.
    expect(diags[0]!.evidence).toContain('MCP server "live"');
    expect(diags[0]!.evidence).toContain('"MCP_BIN"');
    expect(diags[0]!.evidence).not.toContain("/secret/expanded/bin");
  });

  it.each([
    ["alwaysLoad", "feature.mcp-server-always-load"],
    ["role", "feature.mcp-server-role"],
  ] as const)("attributes a loader-normalized %s-only server through the full resolver pipeline", (field, capabilityId) => {
    const project = makeProject({
      mcp: resolveAuditedMcp({ only: { command: "node", [field]: true } }),
    });
    const report = buildCompatReport(project);
    expect(report.findings).toEqual([
      expect.objectContaining({
        capability: expect.objectContaining({ id: capabilityId }),
        evidence: `MCP server "only": "${field}" is a deferred feature in PiCC; ignored (server still runs)`,
      }),
    ]);
    const rendered = renderDoctorReport(project, report);
    expect(rendered).toContain(`${capabilityId} —`);
    expect(rendered).toContain("ignored");
    expect(rendered).toContain("server still runs");
    if (field === "role") {
      expect(rendered).toContain("must not rely on the field under PiCC");
      expect(rendered).toContain("unverified");
    } else {
      expect(rendered).toContain("tool-search exemption");
      expect(rendered).toContain("Check `/mcp` readiness");
      expect(rendered).toContain("use Claude Code if the startup guarantee is required");
    }
  });

  it("attributes an untyped command-plus-URL diagnostic through the full resolver pipeline", () => {
    const project = makeProject({
      mcp: resolveAuditedMcp({ hybrid: { command: "node", url: "https://example.invalid/mcp" } }),
    });
    const report = buildCompatReport(project);
    const exactEvidence = 'MCP server "hybrid": field "url" is ignored on a stdio server';
    expect(report.findings).toEqual([
      expect.objectContaining({
        capability: expect.objectContaining({ id: "feature.mcp-url-without-type-validation" }),
        evidence: exactEvidence,
      }),
    ]);
    expect(report.findings.some((finding) => finding.capability.id === "feature.mcp")).toBe(false);
    const rendered = renderDoctorReport(project, report);
    expect(rendered).toContain("feature.mcp-url-without-type-validation");
    expect(rendered).toContain(exactEvidence);
    expect(rendered).toContain("set an explicit `type`");
    expect(rendered).toContain("do not rely on Claude's validation behavior under PiCC");
  });

  it("splits remote OAuth, alwaysLoad, and role diagnostics while retaining the unrelated fallback", () => {
    const project = makeProject({
      mcp: resolveAuditedMcp({
        mixed: {
          type: "http",
          url: "https://example.invalid/mcp",
          oauth: { clientId: "OAUTH_VALUE_CANARY" },
          alwaysLoad: true,
          role: "reviewer",
          futureOption: true,
        },
      }),
    });
    const report = buildCompatReport(project);
    const byId = new Map<string, typeof report.findings>();
    for (const finding of report.findings) {
      const findings = byId.get(finding.capability.id) ?? [];
      findings.push(finding);
      byId.set(finding.capability.id, findings);
    }
    expect(byId.get("feature.mcp-oauth")?.[0]?.evidence).toBe(
      'MCP server "mixed": "oauth" is a deferred feature in PiCC; ignored (server still runs)',
    );
    expect(byId.get("feature.mcp-server-always-load")?.[0]?.evidence).toBe(
      'MCP server "mixed": "alwaysLoad" is a deferred feature in PiCC; ignored (server still runs)',
    );
    expect(byId.get("feature.mcp-server-role")?.[0]?.evidence).toBe(
      'MCP server "mixed": "role" is a deferred feature in PiCC; ignored (server still runs)',
    );
    expect(byId.get("feature.mcp-remote-transports")?.[0]?.evidence).toBe(
      'MCP server "mixed": unknown field "futureOption" ignored',
    );
    expect(byId.has("feature.mcp")).toBe(false);
    const rendered = renderDoctorReport(project, report);
    expect(rendered).toContain("the `oauth` field is ignored");
    expect(rendered).toContain("server still runs when otherwise usable");
    expect(rendered).toContain("OAuth behavior is absent");
    expect(rendered).toContain("must not rely on `oauth` under PiCC");
    expect(rendered).toContain("static headers are PiCC's supported alternative");
    expect(rendered).not.toContain("OAUTH_VALUE_CANARY");
    expect(JSON.stringify(report)).not.toContain("OAUTH_VALUE_CANARY");
  });

  it("does not substring-route an oauth-named unknown field", () => {
    const project = makeProject({
      mcp: resolveAuditedMcp({ oauth: { command: "node", oauthFutureOption: true } }),
    });
    const report = buildCompatReport(project);
    expect(report.findings).toEqual([
      expect.objectContaining({
        capability: expect.objectContaining({ id: "feature.mcp" }),
        evidence: 'MCP server "oauth": unknown field "oauthFutureOption" ignored',
      }),
    ]);
  });

  it("bounds diagnostic-bearing MCP findings with actionable entries first", () => {
    const inactive = Array.from({ length: 35 }, (_, index) => makeMcpServer({
      name: `inactive-${index}`,
      status: "disabled",
      diagnostics: [`inactive diagnostic ${index} ${"x".repeat(400)}`],
    }));
    const actionable = Array.from({ length: 3 }, (_, index) => makeMcpServer({
      name: `actionable-${index}`,
      status: "skipped",
      diagnostics: [`actionable diagnostic ${index}`],
    }));
    const project = makeProject({
      mcp: makeMcp({
        servers: [...inactive, ...actionable],
        diagnostics: ["config-level MCP diagnostic remains independently visible"],
      }),
    });
    const report = buildCompatReport(project);
    const mcpEvidence = report.findings.filter(
      (finding) => /MCP server \"(?:inactive|actionable)-/.test(finding.evidence),
    );
    expect(mcpEvidence).toHaveLength(32);
    for (const server of actionable) {
      expect(mcpEvidence.some((finding) => finding.evidence.includes(server.name))).toBe(true);
    }
    expect(mcpEvidence.every((finding) => finding.evidence.length <= 241)).toBe(true);
    const omission = report.findings.find((finding) => finding.evidence.includes("additional MCP server diagnostic"));
    expect(omission?.evidence).toBe(
      "6 additional MCP server diagnostic finding(s) omitted; inspect the MCP configuration for complete detail",
    );
    expect(omission?.evidence).not.toContain("inactive-29");
    const doctor = renderDoctorReport(project, report);
    expect(doctor).toContain(omission!.evidence);
    expect(doctor).toContain("MCP configuration has an additional redacted issue");
    expect(doctor).not.toContain("config-level MCP diagnostic remains independently visible");
    expect(doctor).not.toContain("inactive-29");
    expect(doctor.length).toBeLessThan(20_000);
  });

  it("skipped servers yield findings carrying their one-line reasons", () => {
    const project = makeProject({
      mcp: makeMcp({
        servers: [
          makeMcpServer({
            name: "remote",
            status: "skipped",
            diagnostics: [
              'MCP server "remote" in .mcp.json uses remote transport "sse" — remote MCP transports (HTTP/SSE/WebSocket) are not supported yet; server skipped',
            ],
          }),
          makeMcpServer({ name: "broken", status: "skipped" }),
        ],
      }),
    });
    const report = buildCompatReport(project);
    const skipped = report.findings.filter((f) => f.capability.id === "feature.mcp");
    expect(skipped.some((f) => f.evidence.includes("remote transport"))).toBe(true);
    // A skipped server without stored diagnostics still surfaces, never silently.
    expect(skipped.some((f) => f.evidence.includes('"broken"'))).toBe(true);
  });

  it("deduplicates the exact matching-record invalid-shape diagnostic into native repair guidance", () => {
    const diagnostic = "Matching native Claude project record has an invalid shape";
    const project = makeProject({ mcp: makeMcp({ diagnostics: [diagnostic, diagnostic] }) });
    const findings = buildCompatReport(project).findings
      .filter((finding) => finding.capability.id === "feature.mcp");

    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence).toBe(
      "Native Claude MCP state has an invalid or unsupported shape, so MCP is fail closed. Preserve or back up the active user profile. PiCC has no repair command. Restore a known-good backup of the active profile or its native state; use the default native state file (~/.claude.json) to locate the active state. If no known-good backup is available, preserve the profile and seek appropriate support. Restart PiCC after recovery.",
    );
    expect(findings[0]?.evidence).not.toContain(
      "MCP configuration has an additional redacted issue",
    );
    expect(JSON.stringify(findings)).not.toContain(diagnostic);
  });

  it("uses conflict guidance only for the exact fixed diagnostic and redacts lookalikes", () => {
    const diagnostic = "Native Claude project MCP state has conflicting matching records";
    const exactProject = makeProject({ mcp: makeMcp({ diagnostics: [diagnostic] }) });
    const exactEvidence = buildCompatReport(exactProject).findings
      .filter((finding) => finding.capability.id === "feature.mcp")
      .map((finding) => finding.evidence);
    expect(exactEvidence).toEqual([
      "Canonical-equivalent native Claude project records disagree on MCP server or runtime-control state, so all MCP loading is fail closed. Preserve or back up the active user profile. PiCC has no repair command. Restore a known-good backup of the active profile or its native state; use the default native state file (~/.claude.json) to locate the active state. If no known-good backup is available, preserve the profile and seek appropriate support. Restart PiCC after recovery.",
    ]);

    const lookalike = `SECRET_CANARY_PREFIX ${diagnostic} SECRET_CANARY_SUFFIX`;
    const lookalikeProject = makeProject({ mcp: makeMcp({ diagnostics: [lookalike] }) });
    const lookalikeReport = buildCompatReport(lookalikeProject);
    const lookalikeEvidence = lookalikeReport.findings
      .filter((finding) => finding.capability.id === "feature.mcp")
      .map((finding) => finding.evidence);
    expect(lookalikeEvidence).toEqual([
      "MCP configuration has an additional redacted issue; inspect the active profile and project MCP configuration, then run /reload or restart PiCC.",
    ]);
    expect(lookalikeEvidence.join(" ")).not.toContain("Canonical-equivalent");
    expect(renderDoctorReport(lookalikeProject, lookalikeReport)).not.toMatch(/SECRET_CANARY/u);
  });

  it("classifies every known config-level diagnostic into distinct static redacted guidance", () => {
    const diagnostics = [
      "Native Claude enabledMcpServers is unsupported; listed default-off servers remain disabled",
      'MCP approvals ("enableAllProjectMcpServers"/"enabledMcpjsonServers") in project-scope settings are ignored — SOURCE_PATH_CANARY PROJECT_KEY_CANARY',
      'C:/SOURCE_PATH_CANARY/settings.local.json is tracked by git, so a cloned repo could have authored it; its MCP configuration is treated as project scope (approvals ignored; any contributed servers are pending)',
      'MCP approvals ("enableAllProjectMcpServers"/"enabledMcpjsonServers") in C:/SOURCE_PATH_CANARY/settings.local.json cannot work while the file is tracked by git. COMMAND_CANARY',
      ".mcp.json is unreadable; ignored SOURCE_PATH_CANARY",
      ".mcp.json is malformed JSON (PARSER_EXCERPT_CANARY); ignored",
      ".mcp.json root is not an object; ignored URL_CREDENTIAL_CANARY",
      '.mcp.json "mcpServers" is not an object; ignored HEADER_CANARY',
      '.mcp.json has no "mcpServers" key; ignored',
      "Native Claude state could not be read SOURCE_PATH_CANARY",
      "Native Claude local MCP state has an invalid object shape ENV_SECRET_CANARY",
      "Matching native Claude project record has an invalid shape MATCHING_RECORD_CANARY",
      "Native Claude project MCP state has conflicting matching records",
      "Active project identity could not be established PROJECT_KEY_CANARY",
      'Native user MCP server "SERVER_COMMAND_CANARY" has an invalid or unsupported definition and was skipped',
      'Native local MCP server "SERVER_URL_CANARY" has configuration PiCC ignored or adjusted; its definition was retained for later resolution',
      "UNRECOGNIZED_CONFIG_DIAGNOSTIC CREDENTIAL_CANARY",
      ".mcp.json is unreadable; ignored DUPLICATE_PATH_CANARY",
    ];
    const project = makeProject({ mcp: makeMcp({ diagnostics }) });
    const report = buildCompatReport(project);
    const enabledFinding = report.findings.find(
      (finding) => finding.capability.id === "feature.mcp-runtime-enabled",
    );
    expect(enabledFinding).toMatchObject({
      evidence: "Native enabledMcpServers was recognized, but PiCC does not support this enablement capability and the list cannot authorize default-off servers.",
      capability: { tier: "not-supported", safetyRelevant: false },
    });
    const evidence = report.findings
      .filter((finding) => finding.capability.id === "feature.mcp")
      .map((finding) => finding.evidence);
    expect(evidence).toEqual([
      "Project-scope MCP approval settings were ignored because a project cannot authorize itself; review definitions before approving exact trusted names from user-controlled settings.",
      "A tracked local MCP settings contribution was demoted to project scope, so any servers it contributes require independent user approval; review definitions before approving exact trusted names.",
      "MCP approval settings in a tracked local settings file were rejected; stop tracking the file and create a clean user-controlled local file, or approve exact trusted names in user settings.",
      "Project .mcp.json is unreadable; restore file access or remove it, then run /reload or restart PiCC.",
      "Project .mcp.json is malformed JSON; repair it as strict JSON, then run /reload or restart PiCC.",
      "Project .mcp.json has the wrong object shape; make the root and mcpServers block objects, then run /reload or restart PiCC.",
      "Project .mcp.json is missing its mcpServers block; add an object block or remove the file, then run /reload or restart PiCC.",
      "Native Claude MCP state is unreadable, malformed, or otherwise unusable, so MCP is fail closed. Preserve or back up the active user profile. PiCC has no repair command. Restore a known-good backup of the active profile or its native state; use the default native state file (~/.claude.json) to locate the active state. If no known-good backup is available, preserve the profile and seek appropriate support. Restart PiCC after recovery.",
      "Native Claude MCP state has an invalid or unsupported shape, so MCP is fail closed. Preserve or back up the active user profile. PiCC has no repair command. Restore a known-good backup of the active profile or its native state; use the default native state file (~/.claude.json) to locate the active state. If no known-good backup is available, preserve the profile and seek appropriate support. Restart PiCC after recovery.",
      "Canonical-equivalent native Claude project records disagree on MCP server or runtime-control state, so all MCP loading is fail closed. Preserve or back up the active user profile. PiCC has no repair command. Restore a known-good backup of the active profile or its native state; use the default native state file (~/.claude.json) to locate the active state. If no known-good backup is available, preserve the profile and seek appropriate support. Restart PiCC after recovery.",
      "Native Claude project identity could not be selected safely, so MCP is fail closed. Preserve or back up the active user profile. PiCC has no repair command. Restore a known-good backup of the active profile or its native state; use the default native state file (~/.claude.json) to locate the active state. If no known-good backup is available, preserve the profile and seek appropriate support. Restart PiCC after recovery.",
      "A native MCP server entry was invalid or unsupported and was skipped; repair or remove that entry, then run /reload or restart PiCC.",
      "A native MCP server entry contained configuration PiCC ignored or adjusted; inspect the entry and effective MCP status, then run /reload or restart PiCC if changed.",
      "MCP configuration has an additional redacted issue; inspect the active profile and project MCP configuration, then run /reload or restart PiCC.",
    ]);
    const doctor = renderDoctorReport(project, report);
    expect(doctor).toContain("- feature.mcp-runtime-enabled — the selected native project's `enabledMcpServers` list");
    expect(doctor).toContain(enabledFinding!.evidence);
    for (const safe of evidence) expect(doctor).toContain(safe);
    expect(report.findings.some((finding) =>
      finding.capability.id === "feature.mcp" && finding.evidence.includes("enabledMcpServers")
    )).toBe(false);
    expect(doctor).not.toMatch(/CANARY|PARSER_EXCERPT|CREDENTIAL|SOURCE_PATH|PROJECT_KEY|SERVER_COMMAND|SERVER_URL/u);
    expect(evidence.every((item) => item.length < 600)).toBe(true);
  });

  it("retains remote unset-variable guidance plus a redacted fallback for mixed unclassified detail", () => {
    const project = makeProject({
      mcp: makeMcp({
        servers: [makeMcpServer({
          name: "remote-mixed",
          status: "enabled",
          transport: "http",
          diagnostics: [
            'MCP server "remote-mixed" URL references unset environment variable "REMOTE_TOKEN"',
            'unknown field "credential.value=SECRET_FIELD_CANARY" ignored; https://user:pass@example.test/mcp',
          ],
        })],
      }),
    });
    const report = buildCompatReport(project);
    const finding = report.findings.find((item) => item.capability.id === "feature.mcp-remote-transports");
    expect(finding?.evidence).toContain('environment variable "REMOTE_TOKEN" is not set and has no default');
    expect(finding?.evidence).toContain("additional configuration issue detected");
    const doctor = renderDoctorReport(project, report);
    expect(doctor).toContain('environment variable "REMOTE_TOKEN" is not set and has no default');
    expect(doctor).toContain("additional configuration issue detected");
    expect(doctor).not.toMatch(/SECRET_FIELD_CANARY|user:pass|credential\.value/u);
  });

  it("a working enabled server is never a finding (posture-line data instead)", () => {
    const project = makeProject({
      mcp: makeMcp({
        servers: [
          makeMcpServer({ name: "live", status: "enabled", command: "node", rawCommand: "node" }),
          makeMcpServer({ name: "declined", status: "disabled" }),
        ],
      }),
    });
    const report = buildCompatReport(project);
    expect(report.findings).toEqual([]);
    expect(report.safetyFindings).toEqual([]);
    expect(report.mcpPendingNotice).toBeUndefined();
  });

  it("never leaks expanded command/args/env values into MCP findings", () => {
    // Display hygiene: findings quote names and classify stored diagnostics;
    // expanded fields and raw diagnostic values never reach a finding.
    const project = makeProject({
      mcp: makeMcp({
        servers: [
          makeMcpServer({
            name: "secretive",
            status: "pending-approval",
            command: "/secret/expanded/bin",
            args: ["--token", "EXPANDED-SECRET-VALUE"],
            env: { API_KEY: "EXPANDED-SECRET-VALUE" },
            rawCommand: "${MCP_BIN}",
          }),
        ],
      }),
    });
    const report = buildCompatReport(project);
    const all = [...report.findings, ...report.safetyFindings]
      .map((f) => f.evidence)
      .concat(report.mcpPendingNotice ?? "")
      .join("\n");
    expect(all).toContain("secretive");
    expect(all).not.toContain("EXPANDED-SECRET-VALUE");
    expect(all).not.toContain("/secret/expanded/bin");
  });
});

// ---------------------------------------------------------------------------
// renderDoctorReport
// ---------------------------------------------------------------------------

describe("renderDoctorReport", () => {
  it("separates bounded plugin execution failures from unassessed inputs", () => {
    const project = makeProject();
    const report = buildCompatReport(project);
    report.unassessed.push("future setting remains unknown");
    report.pluginRuntimeFindings = [
      "skill owner: persistent data directory validation or creation failed (unreadable-path). Repair plugin-data ownership, writability, and directory kinds, then retry the affected action; no reload is required; execution did not occur",
      "skill owner: persistent data directory validation or creation failed (unreadable-path). Repair plugin-data ownership, writability, and directory kinds, then retry the affected action; no reload is required; execution did not occur",
      "agent owner: persistent data directory validation or creation failed (wrong-kind). Repair plugin-data ownership, writability, and directory kinds, then retry the affected action; no reload is required; execution did not occur",
      "fallback owner: persistent data directory validation or creation failed (data-directory-preparation-failed). Reconcile or reinstall the plugin through Claude Code, then run the canonical /reload in the interactive TUI or exit and relaunch PiCC; execution did not occur",
      "hook owner: persistent data directory validation or creation failed (qualified-projection-mismatch). Reconcile or reinstall the plugin through Claude Code, then run the canonical /reload in the interactive TUI or exit and relaunch PiCC; execution did not occur",
      "legacy owner: preparation failed for an unknown reason; execution did not occur. Reconcile or reinstall the affected plugin through Claude Code, then run the canonical /reload in the interactive TUI or exit and relaunch PiCC.",
      ...Array.from({ length: 15 }, (_, index) => `agent failure ${index} ${"x".repeat(600)}`),
    ];
    report.pluginRuntimeFindingsOmitted = 6;
    report.pluginRuntimeFindingsOmittedAtLeast = true;
    const doctor = renderDoctorReport(project, report);
    const runtime = doctor.slice(
      doctor.indexOf("Plugin runtime failures (execution did not occur):"),
      doctor.indexOf("Unassessed (unknown"),
    );
    expect(runtime.match(/skill owner: persistent data directory validation or creation failed/g)).toHaveLength(1);
    expect(runtime).toContain("skill owner: persistent data directory validation or creation failed (unreadable-path); execution did not occur");
    expect(runtime).toContain("agent owner: persistent data directory validation or creation failed (wrong-kind); execution did not occur");
    expect(runtime).toContain("fallback owner: persistent data directory validation or creation failed (data-directory-preparation-failed); execution did not occur");
    expect(runtime).toContain("hook owner: persistent data directory validation or creation failed (qualified-projection-mismatch); execution did not occur");
    expect(runtime).toContain("at least 6 additional distinct failure(s) omitted");
    expect(runtime).toContain("Recovery: repair plugin-data ownership, writability, and directory kinds, then retry the affected action; no reload is required.");
    expect(runtime).toContain("Recovery: reconcile or reinstall the qualified plugin through Claude Code, then run the canonical /reload in the interactive TUI or exit and relaunch PiCC.");
    expect(runtime).not.toContain("if plugin-data access");
    expect(runtime).not.toContain("Reconcile or reinstall the plugin through Claude Code");
    expect(runtime).not.toContain("Reconcile or reinstall the affected plugin");
    expect(runtime).not.toMatch(/unreadable-path[^\n]*reinstall|wrong-kind[^\n]*reinstall/i);
    expect(runtime).toMatch(/data-directory-preparation-failed[^\n]*execution did not occur/i);
    expect(runtime).not.toContain("future setting remains unknown");
    expect(runtime.length).toBeLessThan(12_000);
    expect(doctor).not.toContain("No compatibility findings detected.");
  });
  it("contains the baseline, findings, unassessed items, and per-tier registry counts", () => {
    const project = makeProject({
      settings: makeSettings({
        permissions: { allow: [], deny: [], ask: ["WebFetch"], additionalDirectories: [] },
        unknownKeys: [{ key: "futureThing", scope: "project" }],
      }),
    });
    const report = buildCompatReport(project);
    const doctor = renderDoctorReport(project, report);

    expect(doctor).toContain(CLAUDE_BASELINE);
    expect(doctor).toContain(project.root);
    expect(doctor).toContain("SAFETY setting.permissions.ask");
    expect(doctor).toContain('"futureThing"');

    const tiers: SupportTier[] = ["full", "partial", "degraded-noop", "not-supported", "na"];
    for (const tier of tiers) {
      const count = CAPABILITY_REGISTRY.filter((e) => e.tier === tier).length;
      expect(doctor).toContain(`${tier}: ${count}`);
    }
    expect(doctor).toContain(`${CAPABILITY_REGISTRY.length} capabilities`);
  });

  it("renders cleanly for a project with nothing to report", () => {
    const project = makeProject();
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    expect(doctor.split(/\r?\n/)).toContain("No compatibility findings detected.");
    expect(doctor).not.toContain("everything this project declares is fully honored");
    expect(doctor).toContain("Unassessed: none.");
    expect(doctor).toContain(CLAUDE_BASELINE);
  });

  it("shows a main-session-only subagent posture line at the default maxDepth of 1", () => {
    const project = makeProject({ settings: makeSettings({ subagentMaxDepth: 1 }) });
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    expect(doctor).toContain("Subagent nesting: main-session-only");
    expect(doctor).toContain("subagents.maxDepth=1");
    expect(doctor).toContain("PiCC default");
    expect(doctor).toContain("any positive integer greater than 1");
    expect(doctor).not.toMatch(/\b2\s*(?:\.\.|-|to)\s*5\b/i);
    expect(doctor).not.toContain("nests up to 5");
  });

  it("reflects a raised subagents.maxDepth in the posture line", () => {
    const project = makeProject({ settings: makeSettings({ subagentMaxDepth: 3 }) });
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    expect(doctor).toContain("Subagent nesting: up to 3 levels below the main session");
    expect(doctor).toContain("subagents.maxDepth=3");
    expect(doctor).not.toContain("main-session-only");
  });

  it("reports an out-of-range subagents.maxDepth truthfully, not as the default", () => {
    const project = makeProject({ settings: makeSettings({ subagentMaxDepth: 0 }) });
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    expect(doctor).toContain("subagents.maxDepth=0");
    expect(doctor).toContain("another positive integer to allow nested delegation");
    expect(doctor).not.toMatch(/\b2\s*(?:\.\.|-|to)\s*5\b/i);
    // must NOT mislabel a non-1 value as the default
    expect(doctor).not.toContain("subagents.maxDepth=1, PiCC default");
    expect(doctor).not.toContain("Subagent nesting: main-session-only");
  });

  it("shows a disabled posture line when subagent dispatch is off", () => {
    const project = makeProject({ settings: makeSettings({ subagentsEnabled: false }) });
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    expect(doctor).toContain("Subagent nesting: subagent dispatch disabled");
    expect(doctor).toContain("subagents.enabled=false");
  });

  it("reports active API truth with resolved compaction knob values", () => {
    const project = makeProject();
    const config = { proactiveCompactPercent: 70, clipMaxTokens: 5000 };
    const supported = renderDoctorReport(project, buildCompatReport(project), {
      api: "openai-responses",
    }, config);
    expect(supported).toContain("proactive checkpointing active");
    expect(supported).toContain("openai-responses");
    expect(supported).toContain("proactiveCompactPercent=70");
    expect(supported).toContain("clipMaxTokens=5000");

    const unsupported = renderDoctorReport(project, buildCompatReport(project), {
      api: "anthropic-messages",
    }, config);
    expect(unsupported).toContain("current model transport/API (anthropic-messages) is unsupported");
    expect(unsupported).toContain("openai-completions, openai-responses, and openai-codex-responses");
    expect(unsupported).toContain("switch to a model using one of them");
  });

  it("omits the compaction line when no compaction config is supplied", () => {
    const project = makeProject();
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    expect(doctor).not.toContain("proactiveCompactPercent=");
  });
});

// ---------------------------------------------------------------------------
// MCP posture line in /doctor — always present, live-state fed
// ---------------------------------------------------------------------------

describe("MCP posture line in /doctor", () => {
  it("shows 'no servers configured' when nothing is discovered (and when mcp is absent)", () => {
    const bare = makeProject();
    expect(renderDoctorReport(bare, buildCompatReport(bare))).toContain(
      "MCP: no servers configured.",
    );
    const empty = makeProject({ mcp: makeMcp() });
    expect(renderDoctorReport(empty, buildCompatReport(empty))).toContain(
      "MCP: no servers configured.",
    );
  });

  it("renders connected/connecting/failed from live runtime states per enabled server", () => {
    const project = makeProject({
      mcp: makeMcp({
        servers: [
          makeMcpServer({ name: "up", status: "enabled" }),
          makeMcpServer({ name: "starting", status: "enabled" }),
          makeMcpServer({ name: "down", status: "enabled" }),
        ],
      }),
    });
    const doctor = renderDoctorReport(project, buildCompatReport(project), undefined, undefined, [
      { name: "up", transport: "stdio", state: "connected", toolCount: 5 },
      { name: "starting", transport: "http", state: "connecting" },
      { name: "down", transport: "http", state: "failed", diagnostic: "UNSAFE_DIAGNOSTIC_CANARY", statusSummary: "Safe permanent failure." },
    ]);
    expect(doctor).toContain('"up": connected (5 tool(s))');
    expect(doctor).toContain('"starting": connecting via http');
    expect(doctor).toContain('"down": failed via http (0 retained tool(s)) — Safe permanent failure.');
    expect(doctor).not.toContain("UNSAFE_DIAGNOSTIC_CANARY");
  });

  it("prioritizes actionable names within the bounded doctor posture and discloses further omission", () => {
    const servers = [
      ...Array.from({ length: 40 }, (_, index) => makeMcpServer({ name: `healthy-${index}`, status: "enabled" })),
      makeMcpServer({ name: "actionable-failed", status: "enabled", transport: "http" }),
      makeMcpServer({ name: "actionable-pending", status: "pending-approval", transport: "http" }),
    ];
    const project = makeProject({ mcp: makeMcp({ servers }) });
    const live = [
      ...Array.from({ length: 40 }, (_, index) => ({
        name: `healthy-${index}`,
        transport: "stdio" as const,
        state: "connected" as const,
        toolCount: 1,
      })),
      { name: "actionable-failed", transport: "http" as const, state: "failed" as const, statusSummary: "Safe failure." },
    ];
    const doctor = renderDoctorReport(project, buildCompatReport(project), undefined, undefined, live);
    const posture = doctor.split("\n").find((line) => line.startsWith("MCP servers:")) ?? "";
    expect(posture).toContain("actionable-failed");
    expect(posture).toContain("actionable-pending");
    expect(posture).toContain("10 additional server name(s) omitted");
    expect(posture).toContain("inspect the MCP configuration for complete detail");
    expect(posture.length).toBeLessThan(16_384);
  });

  it("bounds a failed-server diagnostic on the posture line", () => {
    const project = makeProject({
      mcp: makeMcp({ servers: [makeMcpServer({ name: "noisy", status: "enabled" })] }),
    });
    const doctor = renderDoctorReport(project, buildCompatReport(project), undefined, undefined, [
      { name: "noisy", transport: "http", state: "failed", statusSummary: `safe ${"x".repeat(2000)}` },
    ]);
    const line = doctor.split("\n").find((l) => l.startsWith("MCP servers:")) ?? "";
    expect(line).toContain('"noisy": failed');
    expect(line.length).toBeLessThan(600);
    expect(line).toContain("…");
  });

  it("renders pending/disabled/skipped gate states with NO hint sentence on the posture line", () => {
    const project = makeProject({
      mcp: makeMcp({
        servers: [
          makeMcpServer({ name: "waiting", status: "pending-approval" }),
          makeMcpServer({ name: "declined", status: "disabled" }),
          makeMcpServer({
            name: "remote",
            status: "skipped",
            diagnostics: ["remote MCP transports (HTTP/SSE/WebSocket) are not supported yet; server skipped"],
          }),
        ],
      }),
    });
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    expect(doctor).toContain('"waiting": pending approval');
    expect(doctor).toContain('"declined": disabled (settings disabledMcpjsonServers)');
    expect(doctor).toContain('"remote": skipped — configuration is unusable; check the MCP configuration and logs');
    // The posture line stays status-only; bounded least-authority approval and
    // decline guidance is available from both /mcp and the /doctor finding.
    const postureLine = doctor.split("\n").find((l) => l.startsWith("MCP servers:")) ?? "";
    expect(postureLine).not.toContain("enabledMcpjsonServers");
    expect(postureLine).not.toContain("enableAllProjectMcpServers");
    expect(doctor).toContain("enabledMcpjsonServers");
    expect(doctor).toContain("enableAllProjectMcpServers");
    expect(doctor).toContain("disabledMcpjsonServers");
  });

  it("claims only 'enabled' for an enabled server with no live state supplied", () => {
    const project = makeProject({
      mcp: makeMcp({ servers: [makeMcpServer({ name: "unknown-state", status: "enabled" })] }),
    });
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    expect(doctor).toContain('"unknown-state": enabled');
    expect(doctor).not.toContain('"unknown-state": connected');
  });
});

// ---------------------------------------------------------------------------
// Active-model vision surface (/doctor)
// ---------------------------------------------------------------------------

const VISION_MODEL = { provider: "openai", id: "gpt-see", input: ["text", "image"] };
const NON_VISION_MODEL = { provider: "openai", id: "gpt-text", input: ["text"] };

describe("active-model vision line in /doctor", () => {
  it("reports vision: yes for a vision-capable active model", () => {
    const project = makeProject();
    const doctor = renderDoctorReport(project, buildCompatReport(project), VISION_MODEL);
    expect(doctor).toContain("Active model: openai/gpt-see — vision: yes");
  });

  it("reports vision: no and names the remedy for a non-vision active model", () => {
    const project = makeProject();
    const doctor = renderDoctorReport(project, buildCompatReport(project), NON_VISION_MODEL);
    expect(doctor).toContain("Active model: openai/gpt-text — vision: no");
    expect(doctor).toContain("text placeholders");
    expect(doctor).toContain("use a vision-capable model");
  });

  it("degrades to vision: unknown when no active model is available", () => {
    const project = makeProject();
    // Both the omitted param and an opaque object degrade to "unknown", never throw.
    expect(renderDoctorReport(project, buildCompatReport(project))).toContain(
      "Active model: unknown — vision: unknown",
    );
    expect(() => renderDoctorReport(project, buildCompatReport(project), {})).not.toThrow();
    expect(renderDoctorReport(project, buildCompatReport(project), {})).toContain(
      "vision: unknown",
    );
  });

  it("reports vision: unknown (not no) for a model with an id but no input array", () => {
    const project = makeProject();
    // An id without a readable `input` modality array is OPAQUE on the vision axis:
    // we must not claim "vision: no" — that would be untruthful.
    const doctor = renderDoctorReport(project, buildCompatReport(project), { id: "gpt-opaque" });
    expect(doctor).toContain("vision: unknown");
    expect(doctor).not.toContain("vision: no");
  });
});

// ---------------------------------------------------------------------------
// MCP pending-approval notify line — actionable state, survives quiet startup
// ---------------------------------------------------------------------------

describe("MCP pending-approval notify line (report.mcpPendingNotice)", () => {
  const pendingProject = makeProject({
    mcp: makeMcp({
      servers: [makeMcpServer({ name: "example-server", status: "pending-approval" })],
    }),
  });

  it("is ONE short self-contained line — count, names, the enabling key, the /doctor pointer", () => {
    const notice = buildCompatReport(pendingProject).mcpPendingNotice;
    expect(notice).toBeDefined();
    const line = notice as string;
    // A single toast line: the session-start notify emits it verbatim.
    expect(line).not.toContain("\n");
    expect(line).toContain("1 server(s) pending approval");
    expect(line).toContain("example-server");
    expect(line).toContain("enabledMcpjsonServers");
    expect(line).not.toContain("settings.local.json");
    expect(line).not.toContain("alias");
    expect(line).toContain("disabledMcpjsonServers");
    expect(line).toContain("/doctor for safe settings guidance");
    expect(line.length).toBeLessThan(512);

    const trackedLocal = makeProject({
      mcp: makeMcp({
        servers: [makeMcpServer({ name: "tracked", status: "pending-approval" })],
        diagnostics: ["tracked settings.local.json was demoted"],
      }),
    });
    const trackedNotice = buildCompatReport(trackedLocal).mcpPendingNotice ?? "";
    expect(trackedNotice).not.toContain("settings.local.json");
    expect(trackedNotice).not.toContain("alias");
  });

  it("provides bounded named-approval and decline guidance through /doctor", () => {
    const report = buildCompatReport(pendingProject);
    const pending = report.findings.find(
      (finding) => finding.capability.id === "feature.mcp-project-approval",
    );
    const evidence = pending?.evidence ?? "";
    expect(evidence).toContain('"enabledMcpjsonServers": ["example-server"]');
    expect(evidence).toContain("the server names you explicitly trust");
    expect(evidence).toContain("user settings or a clean, user-controlled, untracked .claude/settings.local.json");
    expect(evidence).toContain('Each UTF-16 code unit outside ASCII letters, digits, "_", and "-"');
    expect(evidence).toContain('astral symbol therefore becomes "__"');
    expect(evidence).toContain("One persisted named approval can therefore match a differently named current or future server");
    expect(evidence).toContain("re-review aliases when project MCP names change");
    expect(evidence).toContain("disabledMcpjsonServers");
    expect(evidence).toContain('Do not set "enableAllProjectMcpServers": true as a shortcut');
    expect(evidence).toContain("it approves all current and future project servers");
  });

  it("keeps raw colliding names copyable while /doctor states the exact ASCII alias boundary", () => {
    const names = ["team.alpha", "team/alpha", "téam.alpha", "t_am/alpha", "keep_under-score"];
    const project = makeProject({
      mcp: makeMcp({
        servers: names.map((name) => makeMcpServer({ name, status: "pending-approval" })),
      }),
    });
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    expect(doctor).toContain(`"enabledMcpjsonServers": ${JSON.stringify(names)}`);
    expect(doctor).toContain('Each UTF-16 code unit outside ASCII letters, digits, "_", and "-"');
    expect(doctor).toContain('astral symbol therefore becomes "__"');
    expect(doctor).toContain("One persisted named approval can therefore match a differently named current or future server");
    expect(doctor).toContain("re-review aliases when project MCP names change");
  });

  it("stays absent with no pending servers", () => {
    const enabledOnly = makeProject({
      mcp: makeMcp({ servers: [makeMcpServer({ name: "live", status: "enabled" })] }),
    });
    expect(buildCompatReport(enabledOnly).mcpPendingNotice).toBeUndefined();
  });

  it("beyond 3 pending servers, keeps notice and /doctor guidance bounded", () => {
    const names = Array.from({ length: 9 }, (_, i) => `srv-${String(i + 1).padStart(2, "0")}`);
    const project = makeProject({
      mcp: makeMcp({
        servers: names.map((name) => makeMcpServer({ name, status: "pending-approval" })),
      }),
    });
    const report = buildCompatReport(project);
    const notice = report.mcpPendingNotice;
    expect(notice).toBeDefined();
    expect(notice).toContain("9 server(s) pending approval");
    expect(notice).toContain("and 6 more");
    // Names after the third appear nowhere on the notify line.
    expect(notice).not.toContain("srv-04");
    expect(notice).not.toContain("srv-09");
    expect(notice!.length).toBeLessThan(512);
    const pending = report.findings.find(
      (finding) => finding.capability.id === "feature.mcp-project-approval",
    );
    const evidence = pending?.evidence ?? "";
    expect(evidence).not.toContain(JSON.stringify(names));
    expect(evidence).toContain("inspect your MCP configuration");
    expect(evidence).toContain("server names you explicitly trust");
    expect(evidence).toContain("disabledMcpjsonServers");
    expect(evidence).toContain('Do not set "enableAllProjectMcpServers": true as a shortcut');
    expect(evidence).toContain("it approves all current and future project servers");
    const doctor = renderDoctorReport(project, report);
    expect(doctor).toContain("enableAllProjectMcpServers");
  });
});

// ---------------------------------------------------------------------------
// Committed full-surface notebook fixture — a reviewable .ipynb that a durable
// artifact carries (in-test Buffers cover the unit layers; this one proves the
// committed file parses and renders cell-aware). It is TEXT (JSON), so it is
// deliberately NOT marked `binary` in .gitattributes. The test decodes and
// magic-byte-SNIFFS the embedded raster (not a bare `existsSync`), so a
// truncated or malformed payload fails loudly rather than silently rotting.
// ---------------------------------------------------------------------------

describe("committed full-surface notebook fixture (examples/full-surface/analysis.ipynb)", () => {
  const fixturePath = fileURLToPath(
    new URL("../examples/full-surface/analysis.ipynb", import.meta.url),
  );
  const raw = fs.readFileSync(fixturePath, "utf8");
  const doc = JSON.parse(raw) as { cells: Array<Record<string, unknown>> };

  it("carries valid raw and error canaries plus a decodable embedded raster image", () => {
    expect(doc.cells.find((cell) => cell.id === "raw-notes")).toEqual({
      cell_type: "raw",
      id: "raw-notes",
      metadata: {
        fixture_canary: "raw-cell-metadata",
        fixture_custom: { preserve: ["raw-custom-field"] },
        nested: { preserve: true },
      },
      source: ["RAW_CELL_SENTINEL\n", "Preserve this source representation."],
    });

    expect(doc.cells.find((cell) => cell.id === "expected-error")).toEqual({
      cell_type: "code",
      id: "expected-error",
      execution_count: 3,
      metadata: {
        fixture_canary: "error-cell-metadata",
        fixture_custom: "error-cell-custom-field",
      },
      outputs: [{
        output_type: "error",
        ename: "FixtureError",
        evalue: "STABLE_ERROR_VALUE",
        traceback: [
          "Traceback (most recent call last):",
          "  <fixture traceback sentinel>",
          "FixtureError: STABLE_ERROR_VALUE",
        ],
      }],
      source: ["raise FixtureError('STABLE_ERROR_VALUE')"],
    });

    const b64 = doc.cells
      .flatMap((cell) => Array.isArray(cell.outputs) ? cell.outputs : [])
      .map((output) => {
        if (output === null || typeof output !== "object") return undefined;
        const data = (output as Record<string, unknown>).data;
        return data !== null && typeof data === "object"
          ? (data as Record<string, unknown>)["image/png"]
          : undefined;
      })
      .find((value): value is string => typeof value === "string");
    expect(b64, "fixture must embed an image/png output").toBeDefined();
    // Decode + magic-byte sniff: a truncated/malformed payload fails here.
    expect(sniffImageMime(Buffer.from(b64!, "base64"))).toBe("image/png");
  });

  it("renders every committed surface cell-aware, degrading the image to a placeholder off-vision", async () => {
    const { content } = await renderNotebook(raw, { model: { input: ["text"] } });
    const text = content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    expect(text).toContain("=== Cell 0 (markdown");
    expect(text).toContain("training complete");
    expect(text).toContain("=== Cell 4 (raw, id=raw-notes) ===");
    expect(text).toContain("RAW_CELL_SENTINEL");
    expect(text).toContain("=== Cell 5 (code, id=expected-error) ===");
    expect(text).toContain("FixtureError: STABLE_ERROR_VALUE");
    expect(text).toContain("<fixture traceback sentinel>");
    // Off-vision: the raster output is a text placeholder, not an image block.
    expect(content.some((b) => b.type === "image")).toBe(false);
    expect(text).toContain("image/png");
  });
});

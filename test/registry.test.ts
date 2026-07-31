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
  capabilityForToolName,
  lookupCapability,
} from "../src/registry/capability-registry.js";
import {
  buildCompatReport,
  renderDoctorReport,
} from "../src/registry/compat-report.js";
import { normalizeMcpServerBlock } from "../src/claude/mcp-config.js";
import { DEGRADED_TOOLS } from "../src/runtime/tools/degrade-stubs.js";
import { sniffImageMime } from "../src/runtime/image-ingest.js";
import { renderNotebook } from "../src/runtime/notebook-render.js";
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
      source: ".mcp.json",
      transport: "stdio",
      diagnostics: [],
      ...overrides,
    } as ResolvedMcpServer;
  }
  return {
    source: ".mcp.json",
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
    { id: "tool.mcp__*", tier: "partial", safetyRelevant: true, core: [/transport-neutral MCP tool proxies/, /first successfully discovered/, /catalog across remote outages/, /current client/], gap: [/fixed local transient wording/, /fixed local terminal wording/, /reconnect never widens/], precedence: [/deny enforcement/, /subagent inheritance/], visibility: [/model-facing protocol-result trust behavior/], split: [/feature\.mcp-list-changed/, /feature\.mcp-remote-transports/] },
    { id: "setting.mcpServers", tier: "partial", core: [/explicit http/, /streamable-http/, /deprecated sse/, /static-header/], gap: [/PiCC-defined stand-in/, /deferred ~\/\.claude\.json scopes/, /upstream ordering interaction is unverified/], precedence: [/Whole-entry precedence and approval apply before expansion/, /inactive entries materialize no command, URL, or headers/], visibility: [/size\/count\/syntax caps/, /reserved transport-header restrictions/], parity: [/ambient launch environment/, /not settings.env/], split: [/feature\.mcp-claude-json-scopes/, /feature\.mcp-remote-transports/] },
    { id: "setting.enableAllProjectMcpServers", tier: "partial", core: [/blanket approval/, /current and future project server/, /NOT a shortcut for a large pending set/], gap: [/replacing Claude Code's interactive trust dialog/], precedence: [/Nearest-honored-scope-wins/, /disabledMcpjsonServers always wins/], visibility: [/ignored with a diagnostic/], parity: [/PiCC's settings gate/], split: [/feature\.mcp-project-approval/] },
    { id: "setting.enabledMcpjsonServers", tier: "partial", core: [/per-server approval list/, /user-authored scopes/, /outside ASCII letters, digits/, /persisted named approval can therefore match a differently named current or future server/, /re-review aliases when project MCP names change/], gap: [/accumulate-and-dedupe of the lists across settings files remains PiCC-inferred/], precedence: [/Approval from ANY honored scope wins/, /disabledMcpjsonServers always wins/], visibility: [/ignored with a diagnostic/], parity: [/Claude parity, binary-verified/], split: [/feature\.mcp-project-approval/] },
    { id: "setting.disabledMcpjsonServers", tier: "full", core: [/per-server decline list/, /honored from EVERY scope/, /outside ASCII letters, digits/], precedence: [/always wins over enableAllProjectMcpServers and enabledMcpjsonServers/], visibility: [/declined server raises no expansion warnings/], parity: [/binary-corroborated/, /accumulate-and-dedupe across settings files remains PiCC-inferred/] },
    { id: "feature.mcp", tier: "partial", core: [/enabled stdio and remote/, /non-blockingly/, /aggregate initial-settlement opportunity/, /siblings that fail before initial catalog discovery add no tools/], gap: [/stdio children/, /do not reconnect/, /remote lifecycle/], visibility: [/zero MCP context/], split: [/feature\.mcp-remote-transports/] },
    { id: "feature.mcp-project-approval", tier: "partial", core: [/project-origin stdio and remote/, /disabled by default/, /name approval/], gap: [/name-based, not definition-bound/, /same-name command, URL, or header change remains approved/], precedence: [/disabledMcpjsonServers always rejects/], visibility: [/re-review definitions/], parity: [/settings gate/, /interactive trust dialog/] },
    { id: "feature.mcp-control-status", tier: "partial", core: [/bounded read-only/, /connecting\/retrying\/connected\/reconnecting\/failed/, /attempt bounds/, /retained tool counts/], gap: [/PiCC-defined/], precedence: [/prioritize actionable states/], visibility: [/never includes endpoints, headers, or raw transport failure speech/, /never enters model context/], parity: [/SSE deprecation/] },
    { id: "feature.mcp-remote-transports", tier: "partial", core: [/http\/streamable-http/, /deprecated sse/, /static headers/, /replayable requests capped at 1 MiB/], gap: [/at most three transient retries at 1\/2\/4 s/, /five reconnects run at 1\/2\/4\/8\/16 s/], precedence: [/aggregate MCP_TIMEOUT/, /discovery retries only network\/5xx/, /authentication\/not-found\/permanent failures stop immediately/], visibility: [/same-origin redirects only/, /no cross-origin header forwarding/], split: [/setting\.mcpServers/, /tool\.mcp__\*/, /feature\.mcp-control-status/, /feature\.mcp-project-approval/] },
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
    const proactive = lookupCapability("feature.proactive-compaction-policy")?.note ?? "";
    expect(proactive).toContain("feature.compaction-summary-recovery");
    expect(proactive).not.toMatch(
      /automatic, manual|split-turn|branch Codex|shared summarization seam|summary-only SSE|force(?:s|d)? SSE|provider(?:-internal)? (?:maxRetries|retr(?:y|ies))|configured (?:bounded )?summarization loop|sole (?:retry )?owner|transport\/provider-overload|abortable exponential backoff|retry lifecycle events|public request fields|prove provenance|exact-signature|purpose marker/,
    );
  });

  it("independently pins the restored MCP proxy qualification families and ownership", () => {
    const proxy = lookupCapability("tool.mcp__*")?.note ?? "";
    for (const qualification of [
      "Deny rules at every grammar level",
      "guard's call-time deny as the backstop",
      "deny matching is case-sensitive",
      "After aggregate initial settlement, one immutable tool universe is registered",
      "fresh proxy objects per dispatch over that same universe",
      "Reconnect never widens it",
      "input schemas are normalized",
      "Claude passes schemas through verbatim",
      "descriptions are bounded at 2KB",
      "64-char model tool-name limit",
      "tools/list pagination stops after 16 pages",
      "DEGRADED tool-result content",
      "structuredContent is ignored",
      "Claude renders images natively",
      "feature.tool-output-clip",
      "catalog across remote outages and terminal failure remains immutable",
      "calls resolve the current client",
    ]) expect(proxy, qualification).toContain(qualification);

    const listChanged = lookupCapability("feature.mcp-list-changed")?.note ?? "";
    expect(listChanged).toContain("unsupported");
    expect(listChanged).toContain("immutable original-catalog behavior belongs to tool.mcp__*");
    expect(listChanged).not.toContain("first successfully discovered");
    expect(lookupCapability("feature.mcp-remote-transports")?.note).not.toContain(
      "immutable original",
    );
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
      "feature.mcp-prompts",
      "feature.mcp-resources",
      "feature.mcp-tool-search",
      "feature.mcp-list-changed",
      "feature.mcp-elicitation",
      "feature.mcp-roots",
      "feature.mcp-channels",
      "feature.mcp-managed-config",
      "feature.mcp-connectors",
      "feature.mcp-claude-json-scopes",
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
    expect(lookupCapability("hook.event.mcp__elicitation")?.note).toBe(
      "MCP elicitation hook events — parsed and never fired: elicitation itself is a deferred MCP surface (see feature.mcp-elicitation), while supported MCP tools otherwise run",
    );
    expect(lookupCapability("feature.mcp-idle-timeout")?.note).toBe(
      "PiCC imposes no MCP server idle timeout; remote transport or server loss may still enter recovery or terminal failure",
    );
    expect(lookupCapability("feature.mcp-oauth")?.note).toBe(
      "the real oauth MCP entry field is recognized key-only and ignored so the server may otherwise run; interactive MCP OAuth login, value parsing, requests, and token storage are deferred, and authentication failures direct users to configured static headers without claiming an HTTP status proves OAuth is required",
    );
    expect(lookupCapability("agent.frontmatter.mcpServers")?.note).toContain("inherit the SESSION's MCP tools");
    expect(lookupCapability("feature.hook-handler.mcp_tool")?.note).toContain("MCP tools themselves run");
    expect(lookupCapability("feature.mcp-remote-transports")?.tier).toBe("partial");
    for (const id of ["setting.allowedMcpServers", "setting.deniedMcpServers"]) {
      expect(lookupCapability(id)).toMatchObject({ tier: "not-supported", safetyRelevant: true });
    }
    // Plugin MCP servers: deferred entry + qualifying clause on the plugins claim.
    expect(lookupCapability("feature.plugins-content")?.note).toContain("feature.mcp-plugin-servers");
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
        /responsive status panel remains the waiting\/running surface/,
        /dispatched subagents do NOT recurse/,
      ],
      gap: [/PARTIAL residual/, /notice is next-turn/],
      precedence: [/BACKGROUND-BY-DEFAULT/, /run_in_background:false/, /DISABLE_BACKGROUND_TASKS/, /MAIN-SESSION-ONLY BY DEFAULT/, /default subagents\.maxDepth/, /subagents\.maxDepth of 1/, /positive integer greater than 1/, /nested generations/],
      visibility: [/model-visible text/, /human TUI strips it/, /model-visible background dispatch still returns the task ID/, /print\/RPC rendering unchanged/],
      parity: [/Claude-faithful/, /not verified parity/, /PiCC's conservative default/, /subagents\.maxDepth.*explicit nesting control/],
      split: [/feature\.background-agents/, /tool\.Agent\.fork/],
    },
    { id: "tool.Task", tier: "partial", core: [/alias of the Agent subagent-dispatch tool/, /loud-failure/], gap: [/conditional/, /remaining uncollected/], precedence: [/background-by-default/, /terminal TaskOutput collection suppresses/], visibility: [/settlement notice/], parity: [/PiCC UX hardening rather than verified parity/], split: [/tool\.Agent\.fork/] },
    { id: "feature.tool-output-clip", tier: "partial", core: [/tool-result clip backstop/, /head \+ tail kept, middle dropped/], gap: [/Built-in Read\/Bash keep Pi's OWN 50 KB truncation/], precedence: [/clipMaxTokens, default 20k tokens/], visibility: [/model-visible/, /human rendering summarizes/], parity: [/PiCC HARDENING, NOT Claude parity/, /DIRECTIONAL DIVERGENCE/], split: [/tool\.Read \/ tool\.Bash/] },
    { id: "tool.SendMessage", tier: "partial", core: [/resumes a completed/, /steers a running background one/, /PiCC allows resume after TaskStop/], gap: [/no cross-restart resume/, /steering is background-only/, /Claude Code 2\.1\.x reference refuses stopped-agent resume/], precedence: [/newest generation wins/], visibility: [/model-visible wording/, /not verified as exact Claude wording/], parity: [/PiCC-defined because Claude's queue behavior is undocumented/], split: [/tool\.Agent\.fork/] },
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
      ],
      gap: [/PRE-EXISTING SCHEMA GAP/, /PiCC exposes wait/],
      precedence: [/FIRST terminal delivery/, /AFTER an emitted terminal record/, /terminal record counts as delivery/, /subagent reaches only tasks it dispatched/, /coordinator reaches every session task/],
      visibility: [/human\/streaming partial output/, /returns waiting to the model/, /suppressed from the main-session human TUI/, /model-visible settled retrieval/],
      parity: [/PiCC-defined collection-aware lifecycle/, /PiCC EXTENSION\/DIVERGENCE/, /official Claude Code/],
    },
    { id: "tool.TaskStop", tier: "partial", core: [/stops a background subagent/, /TaskStop abandons it/], gap: [/PiCC accepts only task_id/, /Claude 2\.1\.198\+ also accepts agent id\/name/], precedence: [/subagent's TaskStop reaches only tasks it dispatched/, /coordinator can stop any session task/], visibility: [/model-visible wording/, /not verified as exact Claude wording/], parity: [/PiCC-defined because Claude's post-stop result semantics are undocumented/], split: [/tool\.TaskOutput/] },
  ])("retains $id semantic disclosure", (contract) => {
    expectDisclosure(contract);
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
      ],
      gap: [/idle parents are not re-invoked/, /one-shot print mode/, /no cross-session agent view/, /no remote\/cloud agents/, /PiCC has no corresponding per-session spawn budget/],
      precedence: [/first terminal delivery/, /later already-reported TaskOutput retrieval/, /Nested work at depth >= 2/, /newest-generation-wins/, /effective configured concurrency/, /queues additional accepted work FIFO/, /each nested-background depth/, /separate configured-capacity pool/, /Foreground nested dispatch bypasses those pools/],
      visibility: [/interactive TUI/, /canonical\/model-visible results/, /print\/RPC output remain unchanged/],
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
    for (const id of [
      "setting.skillOverrides",
      "setting.enabledPlugins",
    ]) {
      expect(lookupCapability(id)?.tier, id).toBe("full");
    }
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
    expect(bash?.note).toContain("deliberately disables Pi 0.82");
  });

  // cleanupPeriodDays reaps orphaned WORKTREES only — there is no subagent
  // transcript reaper, so the claim is downgraded from full to partial (undersell).
  it("marks cleanupPeriodDays partial — worktrees only, no subagent-transcript cleanup", () => {
    const c = lookupCapability("setting.cleanupPeriodDays");
    expect(c?.tier).toBe("partial");
    expect(c?.note).toContain(".subagents/");
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
    const regenerated = renderCapabilityMatrix(CAPABILITY_REGISTRY, CLAUDE_BASELINE);
    const committedPath = fileURLToPath(new URL("../doc/supported-features.md", import.meta.url));
    const committed = fs.readFileSync(committedPath, "utf8");
    const norm = (s: string) => s.replace(/\r\n/g, "\n");
    expect(norm(committed)).toBe(norm(regenerated));
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
    expect(cap.safetyRelevant).toBe(true);
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

  it("scans installed-plugin hook configs for degraded events and handler types", () => {
    const pluginRoot = makeTempDir();
    const hooksFile = path.join(pluginRoot, "hooks", "hooks.json");
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        Notification: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
        PreToolUse: { hooks: [{ type: "prompt", prompt: "degraded handler" }] },
      }),
      "utf8",
    );
    const plugin = {
      name: "hooky",
      root: pluginRoot,
      dataDir: pluginRoot,
      manifest: {},
      skillDirs: [],
      agentDirs: [],
      commandDirs: [],
      hooksFiles: [hooksFile],
      enabled: true,
      diagnostics: [],
    };
    const project = { ...makeProject(), plugins: [plugin] };
    const report = buildCompatReport(project);
    const event = report.findings.find((f) => f.capability.id === "hook.event.Notification");
    expect(event).toBeDefined();
    expect(event?.evidence).toContain('plugin "hooky"');
    const handler = report.findings.find(
      (f) => f.capability.id === "feature.hook-handler.prompt",
    );
    expect(handler).toBeDefined();
    expect(handler?.evidence).toContain('plugin "hooky"');
  });

  it("tolerates malformed plugins entries without crashing the scan", () => {
    const project = {
      ...makeProject(),
      plugins: [null, 42, "junk", { name: "no-hooks" }, { hooksFiles: "not-an-array" }],
    } as unknown as ClaudeProject;
    expect(() => buildCompatReport(project)).not.toThrow();
    expect(buildCompatReport(project).findings).toEqual([]);
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

  it("routes the key-only deferred oauth diagnostic to its dedicated capability", () => {
    const project = makeProject({
      mcp: makeMcp({
        servers: [makeMcpServer({
          name: "oauth-server",
          status: "enabled",
          diagnostics: [
            'MCP server "oauth-server": "oauth" is a deferred feature in PiCC; ignored (server still runs)',
          ],
        })],
      }),
    });
    const report = buildCompatReport(project);
    expect(report.findings).toEqual([
      expect.objectContaining({
        capability: expect.objectContaining({ id: "feature.mcp-oauth" }),
        evidence: 'MCP server "oauth-server": "oauth" is a deferred feature in PiCC; ignored (server still runs)',
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain("OAUTH_VALUE_CANARY");
  });

  it("splits a loader-produced oauth diagnostic from unrelated evidence on the same server", () => {
    const [loaded] = normalizeMcpServerBlock({
      mixed: {
        command: "node",
        oauth: { clientId: "OAUTH_VALUE_CANARY" },
        futureOption: true,
      },
    }, ".mcp.json");
    expect(loaded).toBeDefined();
    const project = makeProject({
      mcp: makeMcp({
        servers: [makeMcpServer({
          name: "mixed",
          status: "enabled",
          diagnostics: loaded!.diagnostics,
        })],
      }),
    });

    const report = buildCompatReport(project);
    const oauth = report.findings.filter(
      (finding) => finding.capability.id === "feature.mcp-oauth",
    );
    const ordinary = report.findings.filter(
      (finding) => finding.capability.id === "feature.mcp",
    );
    expect(oauth).toHaveLength(1);
    expect(oauth[0]!.evidence).toBe(
      'MCP server "mixed": "oauth" is a deferred feature in PiCC; ignored (server still runs)',
    );
    expect(oauth[0]!.evidence).not.toContain("futureOption");
    expect(ordinary).toHaveLength(1);
    expect(ordinary[0]!.evidence).toBe(
      'MCP server "mixed": unknown field "futureOption" ignored',
    );
    expect(ordinary[0]!.evidence).not.toContain('"oauth"');
    expect(JSON.stringify(report)).not.toContain("OAUTH_VALUE_CANARY");
  });

  it("does not route an oauth-named server's unrelated diagnostic to the OAuth capability", () => {
    const project = makeProject({
      mcp: makeMcp({
        servers: [makeMcpServer({
          name: "oauth",
          status: "enabled",
          diagnostics: [
            'MCP server "oauth": unknown field "futureOption"',
            'MCP server "oauth": unrelated text containing "oauth" is a deferred feature in PiCC; but not the loader-owned entry',
          ],
        })],
      }),
    });
    const report = buildCompatReport(project);
    expect(report.findings).toEqual([
      expect.objectContaining({
        capability: expect.objectContaining({ id: "feature.mcp" }),
        evidence:
          'MCP server "oauth": unknown field "futureOption"; MCP server "oauth": unrelated text containing "oauth" is a deferred feature in PiCC; but not the loader-owned entry',
      }),
    ]);
    expect(report.findings.some((finding) => finding.capability.id === "feature.mcp-oauth")).toBe(false);
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
    expect(doctor).toContain("config-level MCP diagnostic remains independently visible");
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

  it("config-level safe approval diagnostics surface verbatim", () => {
    const diagnostics = [
      'MCP approvals ("enableAllProjectMcpServers"/"enabledMcpjsonServers") in project-scope settings are ignored — a cloned repo must not self-approve. Independently review server definitions, then add only explicitly trusted server names to "enabledMcpjsonServers" in user settings (~/.claude/settings.json, or the configured user directory) or a clean untracked .claude/settings.local.json; never copy project-supplied mcpServers, approval keys, or blanket approval (.claude/settings.json)',
      'MCP approvals ("enableAllProjectMcpServers"/"enabledMcpjsonServers") in .claude/settings.local.json cannot work while the file is tracked by git. Approve only explicitly trusted server names with "enabledMcpjsonServers" in user settings (~/.claude/settings.json, or the configured user directory). Create a local file from scratch only after a reviewed repository change stops tracking or removes the path; do not reuse project-supplied MCP content',
    ];
    const project = makeProject({ mcp: makeMcp({ diagnostics }) });
    const report = buildCompatReport(project);
    const diags = report.findings.filter((f) => f.capability.id === "feature.mcp");
    for (const diagnostic of diagnostics) {
      expect(diags.some((f) => f.evidence.includes(diagnostic))).toBe(true);
    }
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
    // Display hygiene: findings quote names and stored (raw/pre-expansion)
    // diagnostics only — the EXPANDED fields must never reach a finding.
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
      "skill owner: persistent data creation failed; execution did not occur",
      "skill owner: persistent data creation failed; execution did not occur",
      ...Array.from({ length: 19 }, (_, index) => `agent failure ${index} ${"x".repeat(600)}`),
    ];
    report.pluginRuntimeFindingsOmitted = 6;
    report.pluginRuntimeFindingsOmittedAtLeast = true;
    const doctor = renderDoctorReport(project, report);
    const runtime = doctor.slice(
      doctor.indexOf("Plugin runtime failures (execution did not occur):"),
      doctor.indexOf("Unassessed (unknown"),
    );
    expect(runtime.match(/persistent data creation failed/g)).toHaveLength(1);
    expect(runtime).toContain("at least 6 additional distinct failure(s) omitted");
    expect(runtime).toContain("Repair or reinstall");
    expect(runtime).not.toContain("future setting remains unknown");
    expect(runtime.length).toBeLessThan(12_000);
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
    expect(doctor).toContain("up: connected (5 tool(s))");
    expect(doctor).toContain("starting: connecting via http");
    expect(doctor).toContain("down: failed via http (0 retained tool(s)) — Safe permanent failure.");
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
    expect(line).toContain("noisy: failed");
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
    expect(doctor).toContain("waiting: pending approval");
    expect(doctor).toContain("declined: disabled (disabledMcpjsonServers)");
    expect(doctor).toContain("remote: skipped — remote MCP transports");
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
    expect(doctor).toContain("unknown-state: enabled");
    expect(doctor).not.toContain("unknown-state: connected");
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

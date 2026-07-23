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

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const SOURCE: SourceRef = { path: "<virtual>", scope: "project" };

function expectCurrentNestedSpawningNote(note: string | undefined): void {
  expect(note).toMatch(/(?:disables nested spawning|nested spawning (?:is )?disabled) by default/i);
  expect(note).not.toMatch(/\b2\s*(?:\.\.|-|to)\s*5\b/i);
  expect(note).not.toMatch(/five-level nesting is fixed|fixed five-level nesting|fixed and not configurable|nesting (?:is )?non-configurable/i);
}

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
  overrides: Partial<ResolvedMcpServer> & Pick<ResolvedMcpServer, "name" | "status">,
): ResolvedMcpServer {
  return {
    source: ".mcp.json",
    command: "",
    args: [],
    env: {},
    rawCommand: "",
    diagnostics: [],
    ...overrides,
  };
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

  // Re-tiered by the stdio MCP slice: mcp__* names are LIVE, deny-enforced
  // tools now, and safety-relevant because deny rules gate real calls.
  it("marks MCP tools partial (live stdio tools) with safetyRelevant true", () => {
    const mcp = lookupCapability("tool.mcp__*");
    expect(mcp?.tier).toBe("partial");
    expect(mcp?.safetyRelevant).toBe(true);
    expect(mcp?.note).toContain("stdio");
    // Claude-parity naming vs PiCC's stricter server-name gate.
    expect(mcp?.note).toContain("sanitized underscore-style like Claude");
    // The empty-after-sanitize drop is PiCC's own floor, stated OUTSIDE the
    // binary-verified parenthetical (Claude never drops a tool name).
    expect(mcp?.note).toContain("PiCC's own floor");
    expect(mcp?.note).toContain("drop-with-diagnostic");
    // Deny-only posture and context removal.
    expect(mcp?.note).toContain("REMOVE the tools from the model's context");
    expect(mcp?.note).toContain("allow/ask stay no-ops");
    expect(mcp?.note).toContain("case-sensitive");
    // Subagent freeze divergence.
    expect(mcp?.note).toContain("FROZEN at dispatch");
    // Schema & content divergences (binary-verified).
    expect(mcp?.note).toContain("permissive object schema");
    expect(mcp?.note).toContain("STDERR-ONLY");
    expect(mcp?.note).toContain("Claude passes schemas through verbatim");
    expect(mcp?.note).toContain("NOT a containment guarantee");
    expect(mcp?.note).toContain("structuredContent is ignored");
  });

  it("re-tiers the MCP settings keys and gate/runtime features truthfully", () => {
    expect(lookupCapability("setting.mcpServers")?.tier).toBe("partial");
    expect(lookupCapability("setting.enableAllProjectMcpServers")?.tier).toBe("partial");
    expect(lookupCapability("setting.enabledMcpjsonServers")?.tier).toBe("partial");
    // Honored from every scope, always wins — nothing partial about it.
    expect(lookupCapability("setting.disabledMcpjsonServers")?.tier).toBe("full");
    // Sanitized-compare parity (binary-verified) is stated on both list keys.
    expect(lookupCapability("setting.enabledMcpjsonServers")?.note).toContain("name sanitizer");
    expect(lookupCapability("setting.disabledMcpjsonServers")?.note).toContain("name sanitizer");

    const mcp = lookupCapability("feature.mcp");
    expect(mcp?.tier).toBe("partial");
    // Binary-verified parity facts must be stated as parity, not PiCC additions.
    expect(mcp?.note).toContain("CLAUDE_CODE_SESSION_ID");
    expect(mcp?.note).toContain("NOT a PiCC addition");
    expect(mcp?.note).toContain("binary-verified Claude parity");
    expect(mcp?.note).toContain("main checkout");
    // cwd-pinning is EFFECTIVE parity, not verified passed-cwd behavior.
    expect(mcp?.note).toContain("Claude passes no cwd");
    expect(mcp?.note).toContain("NO MCP context of any kind");

    const gate = lookupCapability("feature.mcp-project-approval");
    expect(gate?.tier).toBe("partial");
    expect(gate?.note).toContain("not Claude Code's interactive trust dialog");
    expect(gate?.note).toContain("git-tracked settings.local.json is demoted");
    expect(gate?.note).toContain("one-time session-start notice");
    expect(gate?.note).toContain("decline path");
    // Plain-language rationale only — the "vision-warning precedent" insider
    // phrase is a code-comment fact, not user-visible note text.
    expect(gate?.note).not.toContain("vision-warning");
  });

  it("carries explicit deferred entries for the non-stdio MCP surfaces", () => {
    for (const id of [
      "feature.mcp-remote-transports",
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
    ]) {
      const entry = lookupCapability(id);
      expect(entry, id).toBeDefined();
      expect(entry?.tier, id).toBe("not-supported");
    }
    // The blanket "MCP deferred" wording is swept off entries whose surface now
    // partially runs; each names its specific deferred surface instead.
    expect(lookupCapability("hook.event.mcp__elicitation")?.note).toContain("feature.mcp-elicitation");
    expect(lookupCapability("agent.frontmatter.mcpServers")?.note).toContain("inherit the SESSION's MCP tools");
    expect(lookupCapability("feature.hook-handler.mcp_tool")?.note).toContain("stdio MCP tools themselves run");
    // Plugin MCP servers: deferred entry + qualifying clause on the plugins claim.
    expect(lookupCapability("feature.plugins-content")?.note).toContain("feature.mcp-plugin-servers");
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

  // Background-by-default remains; the settlement push is conditional
  // on an eligible uncollected current task and records suppression as PiCC UX
  // hardening rather than verified Claude parity.
  it("marks the subagent dispatch tools partial and names the failure + background-by-default semantics", () => {
    const agent = lookupCapability("tool.Agent");
    expect(agent?.tier).toBe("partial");
    expect(agent?.note).toContain("LOUD failure");
    expect(agent?.note).toContain("agent id");
    expect(agent?.note).toContain("BACKGROUND-BY-DEFAULT");
    expect(agent?.note).toContain("run_in_background:false");
    expect(agent?.note).toContain("prioritizes state, agent identity, and the stable dispatch description before optional telemetry");
    expect(agent?.note).toContain("passive Agent/settlement lifecycle rows omit task ID chips");
    expect(agent?.note).toContain("model-visible background dispatch still returns the task ID");
    expect(agent?.note).toContain("eligible uncollected current task");
    expect(agent?.note).toContain("polling TaskOutput while running preserves eligibility");
    expect(agent?.note).toContain("terminal TaskOutput record counts as delivery");
    expect(agent?.note).toContain("next turn");
    expect(agent?.note).toContain("anthropics/claude-code#21343 (Claude Code 2.1.20)");
    expect(agent?.note).toContain("anthropics/claude-code#24752");
    expect(agent?.note).toContain("late notifications while a conversation is active");
    expect(agent?.note).toContain("official docs define neither notification consumption nor exact mid-turn/next-turn timing");
    expect(agent?.note).toContain("not verified parity");
    expect(agent?.note).toContain("2.1.198");
    expect(agent?.note).toContain("Claude Code 2.1.217");
    expect(agent?.note).toContain("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH");
    expectCurrentNestedSpawningNote(agent?.note);
    const task = lookupCapability("tool.Task");
    expect(task?.tier).toBe("partial");
    expect(task?.note).toContain("alias");
    expect(task?.note).toContain("background-by-default");
    expect(task?.note).toContain("eligible current task remaining uncollected");
    expect(task?.note).toContain("running polls preserve it");
    expect(task?.note).toContain("terminal TaskOutput collection suppresses it");
    expect(task?.note).toContain("PiCC UX hardening rather than verified parity");
    expect(task?.note).toContain("Claude Code 2.1.217");
    expect(task?.note).toContain("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH");
    expectCurrentNestedSpawningNote(task?.note);
  });

  // The tool-output clip backstop is a deliberate directional divergence (a HIGH
  // backstop above Claude's own bounds), not a reproduction of Claude thresholds,
  // and carries a consumer note about the truncation a strict consumer must expect.
  it("frames the tool-output-clip backstop as a directional divergence with a consumer note", () => {
    const clip = lookupCapability("feature.tool-output-clip");
    expect(clip?.tier).toBe("partial");
    expect(clip?.note).toContain("DIRECTIONAL DIVERGENCE");
    expect(clip?.note).toContain("HIGH backstop ABOVE Claude's own bounding");
    expect(clip?.note).toContain("PiCC HARDENING, NOT Claude parity");
    // Human presentation may summarize clipping without changing canonical model content.
    expect(clip?.note).toContain("marker travels in-band on the canonical model-visible result");
    // Parity Q5 consumer note: the clip is a TRUNCATION, not just an added marker.
    expect(clip?.note).toContain("CONSUMER NOTE (parity Q5)");
    expect(clip?.note).toContain("account for the truncation itself, not merely the added marker");
    // The 25k-token Read error stays firmly sourced; the Bash ~30k figure is softened.
    expect(clip?.note).toContain("~25k tokens (VERIFIED)");
    expect(clip?.note).toContain("less-firmly-sourced figure than the 25k-token Read error");
    // Grep cross-references the clip: its results can be reshaped with a Grep hint.
    expect(lookupCapability("tool.Grep")?.note).toContain("feature.tool-output-clip");
  });

  // SendMessage is a distinct partial entry: Claude supports resume/steer behavior,
  // while PiCC defines the acknowledgment wording and retains the documented gaps.
  it("carries a SendMessage entry as partial naming resume identity and its gaps", () => {
    const sm = lookupCapability("tool.SendMessage");
    expect(sm, "tool.SendMessage must exist").toBeDefined();
    expect(sm?.tier).toBe("partial");
    expect(sm?.note).toContain("Claude 2.1.x");
    expect(sm?.note).toContain("resume after TaskStop");
    expect(sm?.note).toContain("Claude Code 2.1.x reference refuses stopped-agent resume");
    expect(sm?.note).toContain("returns its result directly, with no TaskOutput or new task generation");
    expect(sm?.note).toContain("For ordinary resume, the acknowledgment includes the new task id");
    expect(sm?.note).toContain("resolved registry name");
    expect(sm?.note).toContain("stable agent id");
    expect(sm?.note).toContain("PiCC-defined model-visible wording");
    expect(sm?.note).toContain("not verified as exact Claude wording");
    expect(sm?.note).toContain("newest generation wins");
    expect(sm?.note).toContain("eligible uncollected current resumed task");
    expect(sm?.note).toContain("terminal TaskOutput collection suppresses it");
    expect(sm?.note).toContain("running polls do not");
    expect(sm?.note).toContain("waiting for configured capacity visibly refuses steering until admitted");
    expect(sm?.note).toContain("PiCC-defined because Claude's queue behavior is undocumented");
    for (const gap of ["no cross-restart resume", "steering is background-only", "next-turn"]) {
      expect(sm?.note).toContain(gap);
    }
    // The old "fork/agentOverride ... unsupported" phrasing was reworded — a
    // fork is now a partial capability (tool.Agent.fork), unsupported only for
    // RESUME (non-resumable). The note must say so and cross-reference the entry,
    // and must NOT reintroduce the flat "fork ... unsupported" contradiction.
    expect(sm?.note).toContain("fork dispatches are non-resumable");
    expect(sm?.note).toContain("tool.Agent.fork");
  });

  // subagent_type:"fork" is a dedicated partial capability — inherits the
  // parent conversation (main-session only), env-gated, non-resumable, cannot
  // spawn another fork, and its system prompt is a same-context reconstruction.
  it("carries a tool.Agent.fork entry as partial naming the fork semantics and limits", () => {
    const fork = lookupCapability("tool.Agent.fork");
    expect(fork, "tool.Agent.fork must exist").toBeDefined();
    expect(fork?.tier).toBe("partial");
    // Single-line note (the invariants block also enforces this globally).
    expect(fork?.note).not.toContain("\n");
    // Core inheritance + the env gate + the disclosed model overrides.
    expect(fork?.note).toContain("inherits the parent conversation");
    expect(fork?.note).toContain("CLAUDE_CODE_FORK_SUBAGENT");
    expect(fork?.note).toContain("CLAUDE_CODE_SUBAGENT_MODEL");
    // Main-session-only, non-resumable, no-nested-fork, and the reconstruction limit.
    expect(fork?.note).toContain("MAIN-SESSION dispatch ONLY");
    expect(fork?.note).toContain("NON-RESUMABLE");
    expect(fork?.note).toContain("CANNOT SPAWN ANOTHER FORK");
    expect(fork?.note).toContain("RECONSTRUCTION");
    // Verified vs INFERRED/PiCC-defined claims are separated in the note.
    expect(fork?.note).toContain("PiCC-DEFINED / INFERRED");
    // The tier rationale names the reconstruction limit, not just the deferrals.
    expect(fork?.note).toContain("Tier PARTIAL: the prompt reconstruction");
  });

  // TaskOutput reports failed status (never empty success) but is partial for its
  // pre-existing schema gap; TaskStop's discard/identity wording is PiCC-defined.
  it("marks TaskOutput and TaskStop partial with their distinct gaps", () => {
    const out = lookupCapability("tool.TaskOutput");
    expect(out?.tier).toBe("partial");
    expect(out?.note).toContain("failed status");
    expect(out?.note).toContain("waiting for configured capacity");
    expect(out?.note).toContain("in-progress await shows waiting in human/streaming partial output");
    expect(out?.note).toContain("polling, or an interrupted await, returns waiting to the model");
    expect(out?.note).toContain("completed await instead returns the canonical terminal result");
    expect(out?.note).not.toMatch(/completed await[^.]*waiting/i);
    // TaskOutput is INHERITED by subagents but SCOPED to the dispatcher's
    // own tasks — the old inverted "Claude hides TaskOutput; PiCC's session-wide
    // registry does not" wording is gone. The note must state the scoped behavior
    // and the honest #15098 hardening (not a blanket "non-divergent" claim).
    expect(out?.note).toContain("status line that retains the explicitly requested target ID");
    expect(out?.note).not.toContain("status line retains");
    expect(out?.note).toContain("passive Agent/settlement lifecycle rows omit task ID chips");
    expect(out?.note).toContain("registry and canonical identity remain unchanged");
    // Claude removes TaskOutput from named subagents; PiCC deliberately exposes
    // it with own-dispatch scope while preserving coordinator session-wide reach.
    expect(out?.note).toContain("PiCC EXTENSION/DIVERGENCE");
    expect(out?.note).toContain("official Claude Code subagent documentation removes TaskOutput");
    expect(out?.note).toContain("even when it is listed in `tools:`");
    expect(out?.note).toContain("only tasks it dispatched");
    expect(out?.note).toContain("coordinator reaches every session task");
    expect(out?.note).toContain("bracketed lifecycle state `[completed]`, `[failed]`, or `[aborted]`");
    expect(out?.note).not.toContain("#15098");
    expect(out?.note).not.toContain("#23154");
    expect(out?.note).toContain("poll (wait:false)");
    expect(out?.note).toContain("preserves settlement-notice eligibility");
    expect(out?.note).toContain("terminal record counts as delivery");
    expect(out?.note).toContain("cut-off result");
    expect(out?.note).toContain("Retrieval remains available after a notice");
    expect(out?.note).toContain("stopped terminal record reports the outcome");
    expect(out?.note).toContain("reporter-observed Claude Code 2.1.x");
    expect(out?.note).toContain("public docs do not specify notification-consumption semantics");
    expect(out?.note).toContain("NOT claimed as verified parity");
    expect(out?.note).toContain("PRE-EXISTING SCHEMA GAP");
    expect(out?.note).toContain("anthropics/claude-code#21343");
    expect(out?.note).toContain("Claude Code 2.1.20 TaskOutput using block:true");
    expect(out?.note).toContain("anthropics/claude-code#76335");
    expect(out?.note).toContain("2.1.206 local_agent using block:true with timeout");
    expect(out?.note).toContain("PiCC exposes wait");
    expect(out?.note).toContain("official tools docs list TaskOutput and its deprecation but publish no parameter schema");
    expect(out?.note).toContain("This gap makes the tier partial");
    expect(out?.note).not.toContain("hides TaskOutput from subagents");
    expect(out?.note).not.toContain("session-wide, so a subagent");
    const stop = lookupCapability("tool.TaskStop");
    expect(stop?.tier).toBe("partial");
    expect(stop?.note).toContain("CHECKPOINT-PAUSED EXCEPTION");
    expect(stop?.note).toContain("while the originating process remains alive");
    expect(stop?.note).toContain("foreground or background dispatch retained after exhaustion");
    expect(stop?.note).toContain("addressed through the process-lifetime registry by stable agent id");
    expect(stop?.note).toContain("Otherwise PiCC accepts only task_id");
    expect(stop?.note).toContain("Claude 2.1.198+ also accepts agent id/name");
    expect(stop?.note).toContain("task record's stored display type");
    expect(stop?.note).toContain("stable agent id");
    expect(stop?.note).toContain("PiCC-defined model-visible wording");
    expect(stop?.note).toContain("not verified as exact Claude wording");
    expect(stop?.note).toContain("cooperative");
    expect(stop?.note).toContain("discarded late result");
    expect(stop?.note).toContain("post-stop result semantics are undocumented");
    // TaskStop is scoped by the identical per-dispatcher guard as
    // TaskOutput — carry the honest scoped-behavior + #15098 hardening note.
    expect(stop?.note).toContain("only tasks it dispatched");
    expect(stop?.note).toContain("#15098");
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

  // background-agents carries PiCC's settlement/resume identity contract plus
  // the established delivery, visibility, lifecycle, and parity gaps.
  it("keeps feature.background-agents partial with identity and established gaps named", () => {
    const bg = lookupCapability("feature.background-agents");
    expect(bg?.tier).toBe("partial");
    expect(bg?.note).toContain("task record's stored display type");
    expect(bg?.note).toContain("stable agent id");
    expect(bg?.note).toContain("new task id and resolved registry name");
    expect(bg?.note).toContain("PiCC-defined");
    expect(bg?.note).toContain("not verified as exact Claude wording");
    expect(bg?.note).toContain("TaskStop accepts only task_id");
    expect(bg?.note).toContain("Claude 2.1.198+ also accepts agent id/name");
    expect(bg?.note).toContain("resume after TaskStop");
    expect(bg?.note).toContain("Claude Code 2.1.x reference refuses it");
    expect(bg?.note).toContain("eligible uncollected current task");
    expect(bg?.note).toContain("one bounded settlement notice");
    expect(bg?.note).toContain("coordinator's NEXT turn");
    expect(bg?.note).toContain("running TaskOutput poll preserves eligibility");
    expect(bg?.note).toContain("terminal return counts as delivery");
    expect(bg?.note).toContain("retrieval remains available after notification without re-arming");
    expect(bg?.note).toContain("stopped notices are outcome-only");
    expect(bg?.note).toContain("newest-generation-wins");
    expect(bg?.note).toContain("reporter-observed Claude Code 2.1.x");
    expect(bg?.note).toContain("public docs specify no notification-consumption semantics");
    expect(bg?.note).toContain("NOT verified parity");
    expect(bg?.note).toContain("reporter observations (anthropics/claude-code#21343, Claude Code 2.1.20 background agents, and anthropics/claude-code#24752)");
    expect(bg?.note).toContain("late notification during an active conversation");
    expect(bg?.note).toContain("without establishing exact normative timing");
    expect(bg?.note).toContain("one-shot print mode");
    // The default is background — the note must assert that default,
    // not the removed "PiCC defaults foreground" gap, and name the residual timing gap.
    expect(bg?.note).toContain("background-by-default");
    expect(bg?.note).not.toContain("PiCC defaults foreground");
    // PiCC's scheduler and current official Claude facts stay distinct.
    expect(bg?.note).toContain("root dispatches up to the effective configured concurrency");
    expect(bg?.note).not.toContain("root background work");
    expect(bg?.note).toContain("queues additional accepted work FIFO");
    expect(bg?.note).toContain("no separate waiter cap");
    expect(bg?.note).toContain("each nested-background depth has a separate configured-capacity pool");
    expect(bg?.note).toContain("maxDepth × concurrency bounds the background pools only");
    expect(bg?.note).toContain("Foreground nested dispatch bypasses those pools");
    expect(bg?.note).toContain("total active work can be higher");
    expect(bg?.note).toContain("Claude Code 2.1.217");
    expect(bg?.note).toContain("default 20");
    expect(bg?.note).toContain("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS");
    expect(bg?.note).toContain("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH");
    expect(bg?.note).toContain("subagents.maxDepth greater than 1");
    expectCurrentNestedSpawningNote(bg?.note);
    expect(bg?.note).toContain("does not establish queue-versus-rejection behavior or precise concurrency scope");
    expect(bg?.note).toContain("Claude Code 2.1.212");
    expect(bg?.note).toContain("default-200 per-session subagent-spawn cap");
    expect(bg?.note).toContain("CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION");
    expect(bg?.note).toContain("reset by /clear");
    expect(bg?.note).toContain("PiCC has no corresponding per-session spawn budget");
    expect(bg?.note).toContain("Waiting status in TaskOutput and the interactive panel is PiCC-defined UX");
    expect(bg?.note).not.toContain("global (~10) parallel-agent cap");
    expect(bg?.note).not.toContain("Claude's single global");
    const maxDepth = lookupCapability("setting.subagentMaxDepth");
    expect(maxDepth?.note).toContain("accepts any positive integer");
    expect(maxDepth?.note).not.toContain("2..5");
    expect(maxDepth?.note).not.toContain("five-level");
    const concurrency = lookupCapability("setting.subagentConcurrency");
    expect(concurrency?.tier).toBe("full");
    expect(concurrency?.note).toContain("root dispatches");
    expect(concurrency?.note).toContain("separately to each nested-background depth");
    expect(concurrency?.note).toContain("foreground nested dispatch bypasses");
    expect(concurrency?.note).toContain("not a total or session ceiling");
    expect(concurrency?.note).not.toContain("root background");
    // The subagent-scoping clause must survive future edits to this entry.
    expect(bg?.note).toContain("scoped to the subagent's own dispatched tasks");
    expect(bg?.note).toContain("PiCC EXTENSION/DIVERGENCE");
    expect(bg?.note).toContain("official Claude Code subagent documentation removes TaskOutput");
    expect(bg?.note).toContain("individual always-expanded tree rows when a useful identity/description row fits");
    expect(bg?.note).toContain("dropping optional telemetry columns panel-wide as width narrows");
    expect(bg?.note).toContain("very narrow widths use truthful state aggregates");
    expect(bg?.note).toContain("waiting keeps a static glyph plus literal label. The panel also provides");
    expect(bg?.note).not.toContain("literal label, a keyboard-entered drill-down");
    // The in-session Agent View gap is closed by the status panel; the honest
    // residuals must be named instead of the retired "no always-on Agent View".
    expect(bg?.note).not.toContain("no always-on Agent View");
    for (const gap of [
      "idle parents are not re-invoked",
      "interactive-TUI-only",
      "no cross-session agent view",
      "no remote/cloud agents",
      "stop is cooperative",
    ]) {
      expect(bg?.note).toContain(gap);
    }
  });

  // SlashCommand is a real thin-alias tool at partial tier; the note must
  // name the shared skill-activation path and the built-in-command gap.
  it("carries a SlashCommand entry as partial naming the alias path and the built-in gap", () => {
    const sc = lookupCapability("tool.SlashCommand");
    expect(sc, "tool.SlashCommand must exist").toBeDefined();
    expect(sc?.tier).toBe("partial");
    expect(sc?.note).toContain("thin alias over the skill-activation path");
    expect(sc?.note).toContain("/plugin:name");
    expect(sc?.note).toContain("PARTIAL:");
    expect(sc?.note).toContain("built-in commands");
    // Must NOT lead with the degraded-noop em-dash pattern.
    expect(sc?.note.startsWith("—")).toBe(false);
  });

  // tool.Read stays full for its text/image/notebook core, but the note must
  // disclose the vision-gate exception, that the image-FILE path is inherited
  // from base Pi, the Claude-style binary error, and cross-reference the PDF gap
  // to its own entry. Classification truthfulness: IMAGE and BINARY detection is
  // byte-based (magic bytes), but NOTEBOOK routing is keyed on the .ipynb
  // extension (parity with Claude's merged Read), not byte-based — the note must
  // scope the byte-based claim to image/binary and call the notebook path
  // extension-keyed.
  it("describes Read's notebook/image/binary behavior at full, vision-gated, byte-based(image/binary)/extension-keyed(notebook), PDF cross-referenced", () => {
    const read = lookupCapability("tool.Read");
    expect(read?.tier).toBe("full");
    expect(read?.note).toContain("CELL-AWARE");
    expect(read?.note).toContain("image content block");
    expect(read?.note).toContain("vision-gate exception");
    expect(read?.note).toContain("INHERITED from base Pi");
    // Byte-based classification is scoped to IMAGE and BINARY only...
    expect(read?.note).toContain("IMAGE and BINARY classification is BYTE-BASED");
    expect(read?.note).toContain("not extension-based");
    // ...while notebook reads are keyed on the .ipynb extension (Claude parity).
    expect(read?.note).toContain(".ipynb extension");
    expect(read?.note.toLowerCase()).toContain("parity");
    expect(read?.note).toContain("Claude-style binary error");
    // The PDF gap is discoverable via its own entry, not hidden inside "full",
    // and is NOT claimed to be named by /doctor.
    expect(read?.note).toContain("feature.read.pdf");
    expect(read?.note).toContain("feature.read.images");
    expect(read?.note).not.toContain("/doctor flags");
  });

  // The image-ingestion entry is a single `partial` entry: full-on-vision /
  // degraded-on-non-vision, with the split and PiCC-own normalization stated.
  it("carries a partial image-ingestion entry naming the vision split and normalization", () => {
    const img = lookupCapability("feature.read.images");
    expect(img, "feature.read.images must exist").toBeDefined();
    expect(img?.tier).toBe("partial");
    expect(img?.note.toLowerCase()).toContain("vision-capable model");
    expect(img?.note).toContain("SPLITS on vision");
    expect(img?.note).toContain("model-visible text note");
    expect(img?.note).toContain("byte-based");
    // PiCC's own normalization, not asserted byte-identical to Claude.
    expect(img?.note).toContain("NOT asserted byte-identical to Claude Code");
    expect(img?.note).toContain("inherited from base Pi");
  });

  // PDF is disclosed as BELOW the Claude baseline through a discoverable
  // not-supported entry (runtime binary error + support-matrix table), rather
  // than Read hiding it inside its full tier.
  it("carries a not-supported PDF entry disclosing it is below the Claude baseline", () => {
    const pdf = lookupCapability("feature.read.pdf");
    expect(pdf, "feature.read.pdf must exist").toBeDefined();
    expect(pdf?.tier).toBe("not-supported");
    expect(pdf?.note).toContain("Claude Code reads PDFs at baseline");
    expect(pdf?.note).toContain("binary error");
    expect(pdf?.note).toContain("BELOW the Claude baseline");
    // Must NOT imply Claude also errors on PDF.
    expect(pdf?.note).toContain("NOT a claim that Claude also errors on PDF");
  });

  // NotebookEdit was reconciled alongside the retirement: its note directs raw
  // .ipynb editing via Edit and viewing raw JSON via Bash (Read now renders
  // notebooks cell-aware). This verifies that reconciled note still reads truthfully.
  it("keeps the NotebookEdit note truthful about editing raw JSON via Edit and viewing via Bash", () => {
    const ne = lookupCapability("tool.NotebookEdit");
    expect(ne?.tier).toBe("degraded-noop");
    expect(ne?.note).toContain("Edit");
    expect(ne?.note).toContain("Bash");
    expect(ne?.note).toContain("Read now renders notebooks cell-aware");
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

  it("settings honored by real consumers stay full", () => {
    for (const id of [
      "setting.skillOverrides",
      "setting.enabledPlugins",
    ]) {
      expect(lookupCapability(id)?.tier, id).toBe("full");
    }
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

  it("keeps the architecture ownership and nested-pool bounds precise", () => {
    const architecturePath = fileURLToPath(new URL("../doc/architecture.md", import.meta.url));
    const architecture = fs.readFileSync(architecturePath, "utf8");
    const normalized = architecture.replace(/\s+/g, " ").trim();
    const plain = normalized.replace(/[*_]/g, "");
    expect(normalized).toContain("The scheduler owns admission");
    expect(normalized).toContain("`SubagentRegistry` owns dispatch lifecycle and progress");
    expect(normalized).toContain("`BackgroundTaskRegistry` owns task-generation admission and stop data");
    expect(normalized).toContain("`maxDepth × concurrency` bounds the background pools");
    expect(normalized).toContain("Foreground nested dispatch bypasses those pools");
    expect(normalized).toContain("total active work can exceed that product");
    expect(plain).toContain("not Claude Code parity");
    expect(normalized).not.toContain("registry the single data source for the status panel");
    expect(normalized).not.toContain("Claude Code 2.1.217");
    expect(normalized).not.toContain("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS");
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
    expect(report.findings.some((f) => f.capability.id === "tool.NotebookEdit")).toBe(true);
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
    expect(notebook).toBeDefined();
    expect(notebook?.evidence).toContain('skill "gated-skill"');
    expect(notebook?.evidence).toContain("allowed-tools:");
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

  it("pending-approval servers yield one finding carrying the exact enable/decline edit", () => {
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
    // With startup quiet, the /doctor finding is the ONE canonical carrier of
    // the exact settings edit — servers plus BOTH exits (enable and decline).
    const evidence = pending[0]!.evidence;
    expect(evidence).toContain("alpha");
    expect(evidence).toContain("beta");
    expect(evidence).toContain('"enabledMcpjsonServers": ["alpha","beta"]');
    expect(evidence).toContain('"enableAllProjectMcpServers": true');
    expect(evidence).toContain('"disabledMcpjsonServers"');
    // In /doctor the evidence renders beside the gate entry's registry note,
    // which still teaches all three keys.
    const note = pending[0]!.capability.note;
    expect(note).toContain("enableAllProjectMcpServers");
    expect(note).toContain("enabledMcpjsonServers");
    expect(note).toContain("disabledMcpjsonServers");
    // The one-time notify line stays short: names + enabling key + /doctor
    // pointer, never the JSON edit itself.
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

  it("config-level diagnostics (ignored approvals, git-tracked demotion) surface verbatim", () => {
    const project = makeProject({
      mcp: makeMcp({
        diagnostics: [
          'MCP approvals ("enableAllProjectMcpServers"/"enabledMcpjsonServers") in project-scope settings are ignored — a cloned repo must not self-approve; move them to .claude/settings.local.json (.claude/settings.json)',
          '".claude/settings.local.json" is tracked by git, so a cloned repo could have authored it; its MCP configuration is treated as project scope (approvals ignored, servers pending)',
        ],
      }),
    });
    const report = buildCompatReport(project);
    const diags = report.findings.filter((f) => f.capability.id === "feature.mcp");
    expect(diags.some((f) => f.evidence.includes("move them to .claude/settings.local.json"))).toBe(true);
    expect(diags.some((f) => f.evidence.includes("tracked by git"))).toBe(true);
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
      { name: "up", state: "connected", toolCount: 5 },
      { name: "starting", state: "connecting" },
      { name: "down", state: "failed", diagnostic: 'MCP server "down" failed to start (ENOENT) — command: broken-cmd' },
    ]);
    expect(doctor).toContain("up: connected (5 tool(s))");
    expect(doctor).toContain("starting: connecting");
    expect(doctor).toContain("down: failed — ");
    expect(doctor).toContain("ENOENT");
    // The failure diagnostic quotes the RAW command only.
    expect(doctor).toContain("broken-cmd");
  });

  it("bounds a failed-server diagnostic on the posture line", () => {
    const project = makeProject({
      mcp: makeMcp({ servers: [makeMcpServer({ name: "noisy", status: "enabled" })] }),
    });
    const doctor = renderDoctorReport(project, buildCompatReport(project), undefined, undefined, [
      { name: "noisy", state: "failed", diagnostic: `boom ${"x".repeat(2000)}` },
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
    // De-duplicated: the posture line itself carries no enable/decline hint —
    // the pending finding below it (registry note + evidence) is the canonical
    // carrier of the exact edit now that startup is quiet.
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
    expect(line).toContain(".claude/settings.local.json");
    expect(line).toContain("/doctor");
  });

  it("keeps the full enable/decline edit in /doctor (the canonical carrier)", () => {
    const report = buildCompatReport(pendingProject);
    const doctor = renderDoctorReport(pendingProject, report);
    expect(doctor).toContain('"enabledMcpjsonServers": ["example-server"]');
    expect(doctor).toContain('"enableAllProjectMcpServers": true');
    expect(doctor).toContain('"disabledMcpjsonServers"');
  });

  it("stays absent with no pending servers", () => {
    const enabledOnly = makeProject({
      mcp: makeMcp({ servers: [makeMcpServer({ name: "live", status: "enabled" })] }),
    });
    expect(buildCompatReport(enabledOnly).mcpPendingNotice).toBeUndefined();
  });

  it("beyond 8 pending servers, caps the name list; the /doctor edit recommends the blanket key", () => {
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
    expect(notice).toContain("and 1 more");
    // The 9th name appears nowhere on the notify line.
    expect(notice).not.toContain("srv-09");
    // Bounded remedy in the /doctor finding: the blanket key instead of a
    // JSON edit enumerating every server.
    const doctor = renderDoctorReport(project, report);
    expect(doctor).not.toContain(JSON.stringify(names));
    expect(doctor).toContain('"enableAllProjectMcpServers": true');
    expect(doctor).toContain('"disabledMcpjsonServers"');
  });
});

// ---------------------------------------------------------------------------
// Committed notebook-with-image fixture — a reviewable .ipynb that a durable
// artifact carries (in-test Buffers cover the unit layers; this one proves the
// committed file parses and renders cell-aware). It is TEXT (JSON), so it is
// deliberately NOT marked `binary` in .gitattributes. The test decodes and
// magic-byte-SNIFFS the embedded raster (not a bare `existsSync`), so a
// truncated or malformed payload fails loudly rather than silently rotting.
// ---------------------------------------------------------------------------

describe("committed notebook-with-image fixture (examples/full-surface/analysis.ipynb)", () => {
  const fixturePath = fileURLToPath(
    new URL("../examples/full-surface/analysis.ipynb", import.meta.url),
  );
  const raw = fs.readFileSync(fixturePath, "utf8");

  it("carries a decodable embedded raster image", () => {
    const doc = JSON.parse(raw) as {
      cells: Array<{ outputs?: Array<{ data?: Record<string, unknown> }> }>;
    };
    const b64 = doc.cells
      .flatMap((c) => c.outputs ?? [])
      .map((o) => o.data?.["image/png"])
      .find((v): v is string => typeof v === "string");
    expect(b64, "fixture must embed an image/png output").toBeDefined();
    // Decode + magic-byte sniff: a truncated/malformed payload fails here.
    expect(sniffImageMime(Buffer.from(b64!, "base64"))).toBe("image/png");
  });

  it("renders the committed notebook cell-aware, degrading the image to a placeholder off-vision", async () => {
    const { content } = await renderNotebook(raw, { model: { input: ["text"] } });
    const text = content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    expect(text).toContain("=== Cell 0 (markdown");
    expect(text).toContain("training complete");
    // Off-vision: the raster output is a text placeholder, not an image block.
    expect(content.some((b) => b.type === "image")).toBe(false);
    expect(text).toContain("image/png");
    expect(text).toContain("does not support images");
  });
});

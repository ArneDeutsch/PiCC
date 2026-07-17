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
  readSuppression,
  renderDoctorReport,
  renderStartupNotice,
  writeSuppression,
} from "../src/registry/compat-report.js";
import { DEGRADED_TOOLS } from "../src/runtime/tools/degrade-stubs.js";
import type {
  ClaudeAgent,
  ClaudeProject,
  ClaudeSettings,
  ClaudeSkill,
  SourceRef,
  SupportTier,
} from "../src/types.js";
import { SUPPORTED_HOOK_EVENTS } from "../src/types.js";

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

  it("covers all 13 supported hook events as full", () => {
    for (const ev of SUPPORTED_HOOK_EVENTS) {
      expect(lookupCapability(`hook.event.${ev}`)?.tier, ev).toBe("full");
    }
  });

  it("marks MCP tools degraded-noop with safetyRelevant false", () => {
    const mcp = lookupCapability("tool.mcp__*");
    expect(mcp?.tier).toBe("degraded-noop");
    expect(mcp?.safetyRelevant).toBe(false);
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
    const task = lookupCapability("tool.Task");
    expect(task?.tier).toBe("partial");
    expect(task?.note).toContain("alias");
    expect(task?.note).toContain("background-by-default");
    expect(task?.note).toContain("eligible current task remaining uncollected");
    expect(task?.note).toContain("running polls preserve it");
    expect(task?.note).toContain("terminal TaskOutput collection suppresses it");
    expect(task?.note).toContain("PiCC UX hardening rather than verified parity");
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
    expect(sm?.note).toContain("new task id");
    expect(sm?.note).toContain("resolved registry name");
    expect(sm?.note).toContain("stable agent id");
    expect(sm?.note).toContain("PiCC-defined model-visible wording");
    expect(sm?.note).toContain("not verified as exact Claude wording");
    expect(sm?.note).toContain("newest generation wins");
    expect(sm?.note).toContain("eligible uncollected current resumed task");
    expect(sm?.note).toContain("terminal TaskOutput collection suppresses it");
    expect(sm?.note).toContain("running polls do not");
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
    // TaskOutput is INHERITED by subagents but SCOPED to the dispatcher's
    // own tasks — the old inverted "Claude hides TaskOutput; PiCC's session-wide
    // registry does not" wording is gone. The note must state the scoped behavior
    // and the honest #15098 hardening (not a blanket "non-divergent" claim).
    expect(out?.note).toContain("only tasks it dispatched");
    expect(out?.note).toContain("#15098");
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
    expect(stop?.note).toContain("PiCC accepts only task_id");
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

  // Subagent hook payloads carry agent_id + agent_type; transcript_path stays MAIN
  // (Claude Code parity — verified against src/runtime/subagents.ts fireSubagentStop).
  it("documents SubagentStart/SubagentStop carrying agent_id/agent_type with transcript_path = MAIN", () => {
    for (const ev of ["SubagentStart", "SubagentStop"]) {
      const entry = lookupCapability(`hook.event.${ev}`);
      expect(entry?.tier, ev).toBe("full");
      expect(entry?.note, ev).toContain("agent_id + agent_type");
      expect(entry?.note, ev).toContain("MAIN session transcript");
      // The parity claim is softened re plugin agent_type — the note
      // must state agent_type is the bare frontmatter name (no plugin-scoped id),
      // so "full"/"parity" no longer rests on an unverified plugin assumption.
      expect(entry?.note.toLowerCase(), ev).toContain("plugin");
    }
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
    // The nested-concurrency model is machine-readable — per-depth budgets
    // bound nested fan-out and diverge from Claude's single global parallel-agent cap.
    expect(bg?.note).toContain("per-depth budgets");
    expect(bg?.note).toContain("maxDepth × concurrency");
    expect(bg?.note).toContain("Claude's single global (~10) parallel-agent cap");
    // The subagent-scoping clause must survive future edits to this entry.
    expect(bg?.note).toContain("scoped to the subagent's own dispatched tasks");
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

  it("stays in sync with the shipped degrade-stub list, in both directions", () => {
    // Every shipped stub resolves to a dedicated degraded-noop registry entry
    // (a stub reported "unassessed" would be registry drift).
    for (const { name } of DEGRADED_TOOLS) {
      const cap = capabilityForToolName(name);
      expect(cap.id, name).toBe(`tool.${name}`);
      expect(cap.tier, name).toBe("degraded-noop");
      expect(lookupCapability(`tool.${name}`), name).toBeDefined();
    }
    // Every degraded-noop tool entry (except the MCP wildcard) describes a stub
    // that actually ships — no notes about stubs that don't exist.
    const stubNames = new Set(DEGRADED_TOOLS.map((d) => d.name));
    for (const entry of CAPABILITY_REGISTRY) {
      if (entry.kind !== "tool" || entry.tier !== "degraded-noop") continue;
      if (entry.id === "tool.mcp__*") continue;
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
    // NotebookRead is a REAL tool now — retiered to partial and no longer a stub.
    expect(lookupCapability("tool.NotebookRead")?.tier).toBe("partial");
    expect(stubNames.has("NotebookRead")).toBe(false);
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

  it("agent color is a panel-tint-only partial and maxTurns a best-effort partial", () => {
    const color = lookupCapability("agent.frontmatter.color");
    expect(color?.tier).toBe("partial");
    expect(color?.note).toContain("status panel");
    expect(color?.note).toContain("untinted");
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
    expect(cap.tier).toBe("degraded-noop");
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
    expect(report.findings.some((f) => f.capability.id === "tool.mcp__*")).toBe(true);
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
    expect(report.findings.some((f) => f.capability.id === "tool.mcp__*")).toBe(true);
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

  it("flags a committed .mcp.json at the project root", () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, ".mcp.json"), '{ "mcpServers": {} }', "utf8");
    const report = buildCompatReport(makeProject({ root, cwd: root }));
    const mcp = report.findings.find((f) => f.capability.id === "feature.mcp");
    expect(mcp).toBeDefined();
    expect(mcp?.evidence).toContain(".mcp.json");
  });
});

// ---------------------------------------------------------------------------
// renderStartupNotice
// ---------------------------------------------------------------------------

describe("renderStartupNotice", () => {
  const noisyProject = makeProject({
    settings: makeSettings({
      permissions: {
        allow: [],
        deny: [],
        ask: ["Bash(rm *)"],
        additionalDirectories: [],
      },
      deferredKeys: [{ key: "outputStyle", scope: "project" }],
      unknownKeys: [{ key: "futureThing", scope: "project" }],
    }),
  });

  it("emits one consolidated notice with SAFETY first, then functionality, then the doctor hint", () => {
    const report = buildCompatReport(noisyProject);
    const notice = renderStartupNotice(report, { suppressed: false });
    expect(notice).toBeDefined();
    const text = notice as string;

    // Exactly one notice header.
    const headers = text.match(/PiCC compatibility: \d+ feature\(s\) degraded for this project/g);
    expect(headers).toHaveLength(1);
    expect(text.startsWith("PiCC compatibility:")).toBe(true);

    // SAFETY block precedes functionality lines; ask divergence is called out.
    const safetyIdx = text.indexOf("SAFETY:");
    const askIdx = text.indexOf("setting.permissions.ask");
    const funcIdx = text.indexOf("setting.outputStyle");
    expect(safetyIdx).toBeGreaterThan(-1);
    expect(askIdx).toBeGreaterThan(safetyIdx);
    expect(funcIdx).toBeGreaterThan(askIdx);
    expect(text).toContain("ask rules will NOT prompt");
    expect(text).toContain("default-permissive posture");

    // Unassessed inputs are surfaced, and the notice ends with the doctor hint.
    expect(text).toContain("unassessed");
    expect(text.trimEnd().endsWith("Run /doctor for details. (Suppress with /compat suppress)")).toBe(true);
  });

  it("returns undefined when suppressed", () => {
    const report = buildCompatReport(noisyProject);
    expect(renderStartupNotice(report, { suppressed: true })).toBeUndefined();
  });

  it("returns undefined when there are no findings", () => {
    const report = buildCompatReport(makeProject());
    expect(renderStartupNotice(report, { suppressed: false })).toBeUndefined();
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
    expect(doctor).toContain("No compatibility findings");
    expect(doctor).toContain("Unassessed: none.");
    expect(doctor).toContain(CLAUDE_BASELINE);
  });

  it("shows a main-session-only subagent posture line at the default maxDepth of 1", () => {
    const project = makeProject({ settings: makeSettings({ subagentMaxDepth: 1 }) });
    const doctor = renderDoctorReport(project, buildCompatReport(project));
    expect(doctor).toContain("Subagent nesting: main-session-only");
    expect(doctor).toContain("subagents.maxDepth=1");
    expect(doctor).toContain("PiCC default");
    expect(doctor).toContain("2..5");
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
});

// ---------------------------------------------------------------------------
// Suppression persistence
// ---------------------------------------------------------------------------

describe("suppression persistence", () => {
  it("round-trips through .claude/.picc/compat-ack.json", () => {
    const root = makeTempDir();
    expect(readSuppression(root)).toBe(false);

    writeSuppression(root, true);
    expect(readSuppression(root)).toBe(true);
    expect(fs.existsSync(path.join(root, ".claude", ".picc", "compat-ack.json"))).toBe(true);

    writeSuppression(root, false);
    expect(readSuppression(root)).toBe(false);
  });

  it("treats a missing or malformed file as not suppressed", () => {
    const root = makeTempDir();
    expect(readSuppression(root)).toBe(false);
    const file = path.join(root, ".claude", ".picc", "compat-ack.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json at all", "utf8");
    expect(readSuppression(root)).toBe(false);
  });
});

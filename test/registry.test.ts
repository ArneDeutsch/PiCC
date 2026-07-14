import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
// In-process matrix renderer (FIX 9): importing this does NOT spawn or write —
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
      "WebFetch", "WebSearch", "Skill",
      "EnterWorktree", "ExitWorktree",
      "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
    ]) {
      expect(lookupCapability(`tool.${tool}`)?.tier, tool).toBe("full");
    }
    expect(lookupCapability("tool.TodoWrite")?.tier).toBe("partial");
  });

  // F02 subagent-lifecycle: the dispatch tools carry a real parity divergence
  // (PiCC defaults FOREGROUND; Claude 2.1.198 runs subagents background-by-default),
  // so Agent/Task are partial, not full. The note must name the default-direction gap.
  it("marks the subagent dispatch tools partial and names the failure + default-direction semantics", () => {
    const agent = lookupCapability("tool.Agent");
    expect(agent?.tier).toBe("partial");
    expect(agent?.note).toContain("LOUD failure");
    expect(agent?.note).toContain("agent id");
    expect(agent?.note.toLowerCase()).toContain("foreground");
    expect(agent?.note).toContain("2.1.198");
    const task = lookupCapability("tool.Task");
    expect(task?.tier).toBe("partial");
    expect(task?.note).toContain("alias");
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
    for (const gap of ["no cross-restart resume", "steering is background-only", "next-turn", "fork/agentOverride"]) {
      expect(sm?.note).toContain(gap);
    }
  });

  // TaskOutput reports failed status (never empty success); TaskStop's discard
  // contract and identity wording are PiCC-defined.
  it("keeps TaskOutput full and TaskStop partial with identity plus PiCC-defined discard", () => {
    const out = lookupCapability("tool.TaskOutput");
    expect(out?.tier).toBe("full");
    expect(out?.note).toContain("failed status");
    // F13 t03: TaskOutput is INHERITED by subagents but SCOPED to the dispatcher's
    // own tasks — the old inverted "Claude hides TaskOutput; PiCC's session-wide
    // registry does not" wording is gone. The note must state the scoped behavior
    // and the honest #15098 hardening (not a blanket "non-divergent" claim).
    expect(out?.note).toContain("only tasks it dispatched");
    expect(out?.note).toContain("#15098");
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
    // F13 t03: TaskStop is scoped by the identical per-dispatcher guard as
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
      // t07 FIX 5: the parity claim is softened re plugin agent_type — the note
      // must state agent_type is the bare frontmatter name (no plugin-scoped id),
      // so "full"/"parity" no longer rests on an unverified plugin assumption.
      expect(entry?.note.toLowerCase(), ev).toContain("plugin");
    }
  });

  // Notification stays a degraded no-op; the note must record that settlement does
  // NOT fire an agent_completed Notification (t05 left it unwired).
  it("records that background settlement does not fire an agent_completed Notification", () => {
    const n = lookupCapability("hook.event.Notification");
    expect(n?.tier).toBe("degraded-noop");
    expect(n?.note).toContain("agent_completed");
  });

  // Agent frontmatter `background: true` is honored (since t05) as a full entry.
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
    expect(bg?.note).toContain("Claude Code 2.1.x reference refuses stopped-agent resume");
    // F13: the subagent-scoping clause must survive future edits to this entry.
    expect(bg?.note).toContain("scoped to the subagent's own dispatched tasks");
    for (const gap of ["PiCC defaults foreground", "idle parents are not re-invoked", "no always-on Agent View", "no remote/cloud agents", "stop is cooperative"]) {
      expect(bg?.note).toContain(gap);
    }
  });

  // F11: SlashCommand is a real thin-alias tool at partial tier; the note must
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
    // (a stub reported "unassessed" would be registry drift, §17).
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
    // TaskOutput/TaskStop are REAL tools now (audit E4) — registry must agree
    // and they must no longer ship as stubs.
    expect(lookupCapability("tool.TaskOutput")?.tier).toBe("full");
    expect(lookupCapability("tool.TaskStop")?.tier).toBe("partial");
    expect(stubNames.has("TaskOutput")).toBe(false);
    expect(stubNames.has("TaskStop")).toBe(false);
    // SlashCommand is a REAL tool now (F11) — retiered to partial and no longer a stub.
    expect(lookupCapability("tool.SlashCommand")?.tier).toBe("partial");
    expect(stubNames.has("SlashCommand")).toBe(false);
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

  // cleanupPeriodDays reaps orphaned WORKTREES only — t02 shipped no subagent
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

  it("agent color is cosmetic-parsed-only and maxTurns a best-effort partial", () => {
    expect(lookupCapability("agent.frontmatter.color")?.tier).toBe("degraded-noop");
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
// Matrix freshness (t07 FIX 9) — the un-fakeable guard
// ---------------------------------------------------------------------------

describe("capability matrix freshness", () => {
  it("committed doc/supported-features.md is in sync with the registry (regenerated in-process)", () => {
    // Regenerate from the SAME registry + baseline the runtime uses and diff
    // against the committed doc. Both sides CRLF-normalized so a Windows checkout
    // can't false-fail. The first t07 pass shipped a stale matrix; this makes
    // that un-fakeable — a registry edit without `npm run gen:capabilities` fails.
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
    // disallowed-tools denying a degraded tool is trivially satisfied — no finding.
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

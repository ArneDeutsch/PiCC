import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  builtinAgents,
  loadAgents,
  loadPluginAgents,
  renderAgentCatalog,
  resolveAgent,
  type PluginAgentLoaderSource,
} from "../src/claude/agents.js";
import { authorizePluginRoot, resolvePluginPath } from "../src/claude/plugin-paths.js";
import type { ClaudeAgent } from "../src/types.js";

function supportsDirectoryLink(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "picc-agent-dir-link-"));
  try {
    const target = path.join(probe, "target");
    const link = path.join(probe, "link");
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

const canLinkDirectory = supportsDirectoryLink();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-agents-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAgent(relPath: string, content: string): string {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

function load(opts?: { pluginName?: string }) {
  return loadAgents([{ dir: tmpDir, scope: "project" }], opts);
}

function pluginSource(
  pluginRoot: string,
  declaredPath: string,
  kind: "file" | "directory",
): PluginAgentLoaderSource {
  const authorized = authorizePluginRoot(pluginRoot);
  if (!authorized.ok) throw new Error(authorized.diagnostic.message);
  const resolved = resolvePluginPath({
    root: authorized.value,
    declaredPath,
    inputKind: "explicit",
    kind,
  });
  if (!resolved.ok) throw new Error(resolved.diagnostic.message);
  return {
    source: {
      kind,
      path: resolved.value.lexicalPath,
      metadata: {
        pluginId: "agents@trusted-market",
        pluginName: "agents",
        authorizedRoot: authorized.value.canonicalPath,
        lexicalPath: resolved.value.lexicalPath,
        canonicalPath: resolved.value.canonicalPath,
      },
    },
    validatedPath: resolved.value,
  };
}

describe("loadAgents", () => {
  it("parses the full frontmatter set", () => {
    writeAgent(
      "reviewer.md",
      [
        "---",
        "name: code-reviewer",
        "description: Reviews code for quality. Use proactively after changes.",
        "tools:",
        "  - Read",
        "  - Grep",
        "disallowedTools:",
        "  - WebFetch",
        "model: inherit",
        "permissionMode: acceptEdits",
        "maxTurns: 12",
        "skills:",
        "  - code-review",
        "  - security",
        "effort: high",
        "color: red",
        "isolation: worktree",
        "initialPrompt: Start by listing the diff.",
        "metadata:",
        "  team: core",
        "  priority: 1",
        "memory: project",
        "mcpServers:",
        "  github:",
        "    command: gh-mcp",
        "hooks:",
        "  PreToolUse:",
        "    - matcher: Bash",
        "      hooks:",
        "        - type: command",
        "          command: echo hi",
        "          timeout: 5",
        "totallyCustomKey: whatever",
        "---",
        "You are a code reviewer.",
      ].join("\n"),
    );

    const { agents, diagnostics } = load();
    expect(diagnostics).toEqual([]);
    expect(agents).toHaveLength(1);
    const a = agents[0]!;
    expect(a.name).toBe("code-reviewer");
    expect(a.description).toBe("Reviews code for quality. Use proactively after changes.");
    expect(a.tools).toEqual(["Read", "Grep"]);
    expect(a.disallowedTools).toEqual(["WebFetch"]);
    expect(a.model).toBeUndefined(); // "inherit" => no override
    expect(a.permissionMode).toBe("acceptEdits");
    expect(a.maxTurns).toBe(12);
    expect(a.skills).toEqual(["code-review", "security"]);
    expect(a.effort).toBe("high");
    expect(a.color).toBe("red");
    expect(a.isolation).toBe("worktree");
    expect(a.initialPrompt).toBe("Start by listing the diff.");
    expect(a.metadata).toEqual({ team: "core", priority: 1 });
    expect(a.unknownKeys).toEqual(["totallyCustomKey"]);
    expect(a.body).toBe("You are a code reviewer.");
    expect(a.source.path).toBe(path.join(tmpDir, "reviewer.md"));
    expect(a.source.scope).toBe("project");
  });

  it("keeps deferred fields (memory, mcpServers, hooks) parsed and not lost", () => {
    writeAgent(
      "deferred.md",
      [
        "---",
        "description: deferred fields",
        "memory: user",
        "mcpServers:",
        "  gh:",
        "    command: gh-mcp",
        "    args: [serve]",
        "hooks:",
        "  SubagentStop:",
        "    - hooks:",
        "        - type: command",
        "          command: notify.sh",
        "          extraField: kept",
        "---",
        "Body",
      ].join("\n"),
    );
    const { agents } = load();
    const a = agents[0]!;
    expect(a.memory).toBe("user");
    expect(a.mcpServers).toEqual({ gh: { command: "gh-mcp", args: ["serve"] } });
    expect(a.hooks).toBeDefined();
    const entries = a.hooks!["SubagentStop"]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hooks[0]!.type).toBe("command");
    expect(entries[0]!.hooks[0]!.command).toBe("notify.sh");
    // Raw handler definition preserved so nothing is lost.
    expect(entries[0]!.hooks[0]!.raw).toEqual({
      type: "command",
      command: "notify.sh",
      extraField: "kept",
    });
    // Deferred fields are not unknown keys.
    expect(a.unknownKeys).toEqual([]);
  });

  it("accepts tools as a comma-separated string", () => {
    writeAgent(
      "comma.md",
      ["---", "description: d", "tools: Read, Grep, Glob", "---", "b"].join("\n"),
    );
    const { agents } = load();
    expect(agents[0]!.tools).toEqual(["Read", "Grep", "Glob"]);
  });

  it("accepts the allowed-tools alias and disallowed-tools alias", () => {
    writeAgent(
      "alias.md",
      [
        "---",
        "description: d",
        "allowed-tools: Read, Grep",
        "disallowed-tools: Write",
        "---",
        "b",
      ].join("\n"),
    );
    const { agents } = load();
    expect(agents[0]!.tools).toEqual(["Read", "Grep"]);
    expect(agents[0]!.disallowedTools).toEqual(["Write"]);
    expect(agents[0]!.unknownKeys).toEqual([]);
  });

  it("defaults name to filename minus .md", () => {
    writeAgent("my-agent.md", ["---", "description: d", "---", "b"].join("\n"));
    const { agents } = load();
    expect(agents[0]!.name).toBe("my-agent");
  });

  it("coerces a numeric string maxTurns and rejects a non-numeric one", () => {
    writeAgent(
      "turns.md",
      ["---", "description: d", 'maxTurns: "7"', "---", "b"].join("\n"),
    );
    writeAgent(
      "turns-bad.md",
      ["---", "description: d", "maxTurns: lots", "---", "b"].join("\n"),
    );
    const { agents } = load();
    const good = agents.find((a) => a.name === "turns")!;
    const bad = agents.find((a) => a.name === "turns-bad")!;
    expect(good.maxTurns).toBe(7);
    expect(bad.maxTurns).toBeUndefined();
    expect(bad.diagnostics.some((d) => d.message.includes("maxTurns"))).toBe(true);
  });

  it("skips a description-less agent with a warning diagnostic", () => {
    writeAgent("nodesc.md", ["---", "name: nodesc", "tools: Read", "---", "b"].join("\n"));
    const { agents, diagnostics } = load();
    expect(agents).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe("warning");
    expect(diagnostics[0]!.message).toContain("no description");
    expect(diagnostics[0]!.source).toBe(path.join(tmpDir, "nodesc.md"));
  });

  it("degrades an unknown isolation value to undefined with a diagnostic", () => {
    writeAgent(
      "iso.md",
      ["---", "description: d", "isolation: container", "---", "b"].join("\n"),
    );
    const { agents } = load();
    const a = agents[0]!;
    expect(a.isolation).toBeUndefined();
    expect(a.diagnostics.some((d) => d.message.includes("isolation"))).toBe(true);
  });

  it("parses `background: true` frontmatter (Claude 2.1.198); absent/false stay off", () => {
    writeAgent(
      "bg.md",
      ["---", "description: bg agent", "background: true", "---", "b"].join("\n"),
    );
    writeAgent(
      "bg-false.md",
      ["---", "description: not bg", "background: false", "---", "b"].join("\n"),
    );
    writeAgent("bg-absent.md", ["---", "description: plain", "---", "b"].join("\n"));
    const { agents, diagnostics } = load();
    expect(diagnostics).toEqual([]);
    const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
    expect(byName["bg"]!.background).toBe(true);
    expect(byName["bg-false"]!.background).toBe(false);
    expect(byName["bg-absent"]!.background).toBeUndefined();
    // `background` is a known key — never surfaced as unknown.
    expect(byName["bg"]!.unknownKeys).not.toContain("background");
  });

  it('parses string background values ("true"/"1"/"yes" → true; garbage → undefined)', () => {
    // Quoted so YAML keeps them as STRINGS (bare yes/no/1 would coerce in YAML),
    // exercising toOptionalBoolean's string branch directly.
    writeAgent("bg-s-true.md", ["---", 'description: d', 'background: "true"', "---", "b"].join("\n"));
    writeAgent("bg-s-one.md", ["---", 'description: d', 'background: "1"', "---", "b"].join("\n"));
    writeAgent("bg-s-yes.md", ["---", 'description: d', 'background: "yes"', "---", "b"].join("\n"));
    writeAgent("bg-s-maybe.md", ["---", 'description: d', 'background: "maybe"', "---", "b"].join("\n"));
    writeAgent("bg-s-garbage.md", ["---", 'description: d', 'background: "42x"', "---", "b"].join("\n"));
    const { agents } = load();
    const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
    expect(byName["bg-s-true"]!.background).toBe(true);
    expect(byName["bg-s-one"]!.background).toBe(true);
    expect(byName["bg-s-yes"]!.background).toBe(true);
    expect(byName["bg-s-maybe"]!.background).toBeUndefined();
    expect(byName["bg-s-garbage"]!.background).toBeUndefined();
  });

  it("preserves the body verbatim, never parsing YAML-looking body content", () => {
    const body = [
      "# System prompt",
      "",
      "---",
      "name: not-frontmatter",
      "tools: [Bash]",
      "---",
      "",
      "Multi-line **markdown** stays intact.",
      "  indented line",
    ].join("\n");
    writeAgent("body.md", ["---", "description: d", "---", body].join("\n"));
    const { agents } = load();
    const a = agents[0]!;
    expect(a.body).toBe(body);
    // The YAML-looking section in the body did not leak into config.
    expect(a.name).toBe("body");
    expect(a.tools).toBeUndefined();
  });

  it("never throws on malformed frontmatter; recoverable fields are parsed leniently", () => {
    writeAgent(
      "broken.md",
      ["---", "tools: [unclosed", "description: d", "---", "Body"].join("\n"),
    );
    const { agents } = load();
    // Lenient recovery (mechanical fidelity — Claude Code accepts these):
    // the description is recovered so the agent loads; the malformed inline
    // collection `[unclosed` is dropped rather than turned into a bogus tool.
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe("broken");
    expect(agents[0]?.description).toBe("d");
    expect(agents[0]?.tools).toBeUndefined();
  });

  it("skips a truly description-less agent even after lenient recovery", () => {
    writeAgent("nodesc.md", ["---", "tools: Read", "---", "Body"].join("\n"));
    const { agents, diagnostics } = load();
    expect(agents.find((a) => a.source.path.endsWith("nodesc.md"))).toBeUndefined();
    expect(diagnostics.some((d) => /no description/i.test(d.message))).toBe(true);
  });

  it("scans one level of subdirectories, but not deeper", () => {
    writeAgent("top.md", ["---", "description: top agent", "---", "b"].join("\n"));
    writeAgent("review/security.md", ["---", "description: sub agent", "---", "b"].join("\n"));
    writeAgent(
      "review/deep/toodeep.md",
      ["---", "description: too deep", "---", "b"].join("\n"),
    );
    const { agents } = load();
    expect(agents.map((a) => a.name)).toEqual(["top", "security"]);
  });

  it("ignores non-markdown files and reads dirs in deterministic order", () => {
    writeAgent("b-agent.md", ["---", "description: b", "---", "x"].join("\n"));
    writeAgent("a-agent.md", ["---", "description: a", "---", "x"].join("\n"));
    writeAgent("notes.txt", "not an agent");
    const { agents, diagnostics } = load();
    expect(agents.map((a) => a.name)).toEqual(["a-agent", "b-agent"]);
    expect(diagnostics).toEqual([]);
  });

  it("stamps pluginName onto the source when provided", () => {
    writeAgent("p.md", ["---", "description: d", "---", "b"].join("\n"));
    const { agents } = loadAgents([{ dir: tmpDir, scope: "plugin" }], {
      pluginName: "my-plugin",
    });
    expect(agents[0]!.source.pluginName).toBe("my-plugin");
    expect(agents[0]!.source.scope).toBe("plugin");
  });

  it("returns empty results for a missing directory without throwing", () => {
    const { agents, diagnostics } = loadAgents([
      { dir: path.join(tmpDir, "does-not-exist"), scope: "user" },
    ]);
    expect(agents).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});

describe("loadPluginAgents", () => {
  it("loads explicit files and validated directories deterministically with trusted identity", () => {
    const pluginRoot = path.join(tmpDir, "plugin");
    writeAgent("plugin/agents/b.md", "---\ndescription: b\n---\nb");
    writeAgent("plugin/agents/a.md", "---\ndescription: a\n---\na");
    writeAgent("plugin/agents/group/c.md", "---\ndescription: c\n---\nc");
    writeAgent("plugin/agents/group/deep/d.md", "---\nname: custom\ndescription: d\n---\nd");
    writeAgent("plugin/outside.md", "---\nname: explicit-name\ndescription: outside\n---\noutside");

    const directory = loadPluginAgents([
      pluginSource(pluginRoot, "./agents", "directory"),
    ]);
    expect(directory.agents.map((agent) => agent.name)).toEqual([
      "a",
      "b",
      "group:c",
      "group:deep:custom",
    ]);
    expect(directory.agents.every((agent) => agent.source.pluginId === "agents@trusted-market")).toBe(true);
    expect(directory.agents.every((agent) => agent.source.pluginName === "agents")).toBe(true);
    expect(directory.agents.every((agent) => agent.source.scope === "plugin")).toBe(true);

    const file = loadPluginAgents([
      pluginSource(pluginRoot, "./outside.md", "file"),
    ]);
    expect(file.agents.map((agent) => agent.name)).toEqual(["explicit-name"]);
  });

  it.each([
    { label: "absent", fields: "", expected: [] },
    {
      label: "falsey",
      fields: "hooks: false\nmcpServers: null\npermissionMode: 0",
      expected: ["hooks", "mcpServers", "permissionMode"],
    },
    {
      label: "malformed",
      fields: "hooks: scalar\nmcpServers: false\npermissionMode: { bad: true }",
      expected: ["hooks", "mcpServers", "permissionMode"],
    },
  ])("strips every present forbidden plugin field for $label values", ({ label, fields, expected }) => {
    const pluginRoot = path.join(tmpDir, `forbidden-plugin-${label}`);
    const file = writeAgent(
      `forbidden-plugin-${label}/agent.md`,
      `---\ndescription: plugin agent\n${fields}\nskills: [safe-skill]\n---\nbody`,
    );

    const result = loadPluginAgents([pluginSource(pluginRoot, "./agent.md", "file")]);
    const agent = result.agents[0]!;
    expect(Object.hasOwn(agent, "permissionMode")).toBe(false);
    expect(Object.hasOwn(agent, "mcpServers")).toBe(false);
    expect(Object.hasOwn(agent, "hooks")).toBe(false);
    expect(agent.skills).toEqual(["safe-skill"]);
    const expectedDiagnostics = expected.map((field) => ({
      severity: "warning",
      message: `Plugin agent field "${field}" is forbidden and was removed`,
      source: file,
    }));
    expect(agent.diagnostics).toEqual(expectedDiagnostics);
    expect(result.diagnostics).toEqual(expectedDiagnostics);
  });

  it("reports forbidden fields once when a plugin agent is skipped", () => {
    const pluginRoot = path.join(tmpDir, "forbidden-skipped");
    const file = writeAgent("forbidden-skipped/agent.md", "---\nhooks: false\n---\nbody");
    const result = loadPluginAgents([pluginSource(pluginRoot, "./agent.md", "file")]);
    expect(result.agents).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        severity: "warning",
        message: 'Plugin agent field "hooks" is forbidden and was removed',
        source: file,
      },
      {
        severity: "warning",
        message: "Agent has no description; skipped (description is the routing trigger)",
        source: file,
      },
    ]);
  });

  it("preserves forbidden plugin fields for an ordinary user agent", () => {
    const file = writeAgent(
      "ordinary-user/agent.md",
      "---\ndescription: user\npermissionMode: default\nmcpServers: false\nhooks: {}\n---\nbody",
    );
    const result = loadAgents([{ dir: path.dirname(file), scope: "user" }]);
    expect(result.diagnostics).toEqual([]);
    expect(result.agents[0]).toMatchObject({
      permissionMode: "default",
      mcpServers: false,
      hooks: {},
    });
  });

  it("rejects mismatched source metadata rather than reconstructing authority", () => {
    const pluginRoot = path.join(tmpDir, "mismatch-plugin");
    writeAgent("mismatch-plugin/agent.md", "---\ndescription: d\n---\nb");
    const input = pluginSource(pluginRoot, "./agent.md", "file");
    input.source.metadata.authorizedRoot = path.join(pluginRoot, "invented");

    const result = loadPluginAgents([input]);
    expect(result.agents).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.message).toContain("does not match");
    expect(result.pathFailures).toEqual([]);
  });

  it.skipIf(!canLinkDirectory)("preserves ordered terminal input and non-terminal walker path failures", () => {
    const pluginRoot = path.join(tmpDir, "failure-sidecars");
    const selectedInside = path.join(pluginRoot, "selected-inside");
    const outsideSelected = path.join(tmpDir, "failure-sidecars-selected-outside");
    const walked = path.join(pluginRoot, "walked");
    const outsideWalked = path.join(tmpDir, "failure-sidecars-walked-outside");
    for (const dir of [selectedInside, outsideSelected, walked, outsideWalked]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const selected = path.join(pluginRoot, "selected");
    fs.symlinkSync(selectedInside, selected, process.platform === "win32" ? "junction" : "dir");
    const terminalInput = pluginSource(pluginRoot, "./selected", "directory");
    const walkerInput = pluginSource(pluginRoot, "./walked", "directory");
    fs.unlinkSync(selected);
    fs.symlinkSync(outsideSelected, selected, process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(
      outsideWalked,
      path.join(walked, "escaped"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = loadPluginAgents([terminalInput, walkerInput]);
    expect(result.agents).toEqual([]);
    expect(result.pathFailures?.map(({ pluginId, component, source, terminal, failure }) => ({
      pluginId,
      component,
      source: source.path,
      terminal,
      code: failure.code,
      diagnosticSource: failure.diagnostic.source,
    }))).toEqual([
      {
        pluginId: "agents@trusted-market",
        component: "agent",
        source: terminalInput.source.path,
        terminal: true,
        code: "path-escape",
        diagnosticSource: terminalInput.source.path,
      },
      {
        pluginId: "agents@trusted-market",
        component: "agent",
        source: walkerInput.source.path,
        terminal: false,
        code: "path-escape",
        diagnosticSource: path.join(walked, "escaped"),
      },
    ]);
    expect(result.pathFailures![0]!.source).toBe(terminalInput.source);
    expect(result.pathFailures![1]!.source).toBe(walkerInput.source);
    expect(result.diagnostics).toEqual(result.pathFailures!.map(({ failure }) => failure.diagnostic));
    expect(result.pathFailures![0]!.failure.diagnostic).toBe(result.diagnostics[0]);
    expect(result.pathFailures![1]!.failure.diagnostic).toBe(result.diagnostics[1]);
  });
});

describe("renderAgentCatalog", () => {
  function mkAgent(over: Partial<ClaudeAgent> & { name: string; description: string }): ClaudeAgent {
    return {
      metadata: {},
      body: "",
      source: { path: "<virtual>", scope: "project" },
      unknownKeys: [],
      diagnostics: [],
      ...over,
    };
  }

  it("renders the heading plus one block per agent in input order", () => {
    const catalog = renderAgentCatalog([
      mkAgent({ name: "zeta", description: "Does zeta things." }),
      mkAgent({ name: "alpha", description: "Does alpha things." }),
    ]);
    expect(catalog).toBe(
      [
        "Available subagents (dispatch with the Agent tool, subagent_type = name):",
        "- zeta: Does zeta things.",
        "- alpha: Does alpha things.",
      ].join("\n"),
    );
  });

  it("marks read-only agents (tools set, none of Write/Edit/Bash)", () => {
    const catalog = renderAgentCatalog([
      mkAgent({ name: "reader", description: "Reads.", tools: ["Read", "Grep", "Glob"] }),
      mkAgent({ name: "writer", description: "Writes.", tools: ["Read", "Write"] }),
      mkAgent({ name: "sheller", description: "Shells.", tools: ["Read", "Bash(git *)"] }),
      mkAgent({ name: "inherits", description: "Inherits all tools." }),
    ]);
    const lines = catalog.split("\n");
    expect(lines[1]).toBe("- reader (read-only): Reads.");
    expect(lines[2]).toBe("- writer: Writes.");
    expect(lines[3]).toBe("- sheller: Shells.");
    expect(lines[4]).toBe("- inherits: Inherits all tools.");
  });

  it("indents multi-line descriptions verbatim", () => {
    const catalog = renderAgentCatalog([
      mkAgent({
        name: "multi",
        description: "First line.\nSecond line with detail.\nThird line.",
        tools: ["Read"],
      }),
    ]);
    expect(catalog).toBe(
      [
        "Available subagents (dispatch with the Agent tool, subagent_type = name):",
        "- multi (read-only): First line.",
        "  Second line with detail.",
        "  Third line.",
      ].join("\n"),
    );
  });

  it("renders only the heading for an empty agent list", () => {
    expect(renderAgentCatalog([])).toBe(
      "Available subagents (dispatch with the Agent tool, subagent_type = name):",
    );
  });
});

describe("builtinAgents", () => {
  it("defines general-purpose, Explore, and Plan with the built-in markers", () => {
    const agents = builtinAgents({});
    expect(agents.map((a) => a.name)).toEqual(["general-purpose", "Explore", "Plan"]);
    for (const a of agents) {
      expect(a.builtin).toBe(true);
      expect(a.source.scope).toBe("builtin");
      expect(a.description.trim().length).toBeGreaterThan(0);
      expect(a.body.trim().length).toBeGreaterThan(0);
    }
    const gp = agents[0]!;
    expect(gp.description).toBe(
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks",
    );
    expect(gp.tools).toBeUndefined(); // all tools
    expect(gp.skipProjectContext).toBeUndefined();
    for (const name of ["Explore", "Plan"]) {
      const a = agents.find((x) => x.name === name)!;
      // Read-only restriction + Claude's CLAUDE.md skipping.
      expect(a.disallowedTools).toEqual([
        "Edit",
        "Write",
        "MultiEdit",
        "NotebookEdit",
        "Agent",
        "Task",
      ]);
      expect(a.skipProjectContext).toBe(true);
    }
  });

  it("CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS removes Explore/Plan but keeps general-purpose", () => {
    const disabled = builtinAgents({ CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1" });
    expect(disabled.map((a) => a.name)).toEqual(["general-purpose"]);
    // Explicit "off" values do not disable.
    const kept = builtinAgents({ CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "0" });
    expect(kept.map((a) => a.name)).toEqual(["general-purpose", "Explore", "Plan"]);
  });

  it("appears in the routing catalog like any other agent", () => {
    const catalog = renderAgentCatalog(builtinAgents({}));
    expect(catalog).toContain("- general-purpose: General-purpose agent");
    expect(catalog).toContain("- Explore: ");
    expect(catalog).toContain("- Plan: ");
  });
});

describe("resolveAgent", () => {
  function mk(name: string): ClaudeAgent {
    return {
      name,
      description: "d",
      metadata: {},
      body: "",
      source: { path: "<virtual>", scope: "project" },
      unknownKeys: [],
      diagnostics: [],
    };
  }

  it("prefers an exact match over a case-insensitive one", () => {
    const agents = [mk("Explore"), mk("explore")];
    expect(resolveAgent(agents, "explore")).toBe(agents[1]);
    expect(resolveAgent(agents, "Explore")).toBe(agents[0]);
  });

  it("falls back to case-insensitive matching", () => {
    const agents = [mk("code-reviewer")];
    expect(resolveAgent(agents, "Code-Reviewer")).toBe(agents[0]);
  });

  it("returns undefined for unknown types", () => {
    expect(resolveAgent([mk("a")], "b")).toBeUndefined();
  });
});

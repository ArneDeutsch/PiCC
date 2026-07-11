import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgents, renderAgentCatalog, resolveAgent } from "../src/claude/agents.js";
import type { ClaudeAgent } from "../src/types.js";

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
    // Lenient recovery (plan §2.1 mechanical fidelity — Claude Code accepts these):
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

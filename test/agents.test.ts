import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { normalizeAgentMcpDeclaration } from "../src/claude/agent-mcp.js";
import {
  AGENT_TOOL_RESTRICTION_LIMITS,
  builtinAgents,
  loadAgents,
  loadPluginAgents,
  normalizeAgentToolRestrictions,
  renderAgentCatalog,
  resolveAgent,
  type PluginAgentLoaderSource,
} from "../src/claude/agents.js";
import { authorizePluginRoot, resolvePluginPath } from "../src/claude/plugin-paths.js";
import type {
  AgentMcpAdmissionContext,
  AgentMcpDeclaration,
  AgentMcpItem,
  ClaudeAgent,
  ResolvedAgentMcpConfig,
  ResolvedAgentMcpServer,
} from "../src/types.js";

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

function load() {
  return loadAgents([{ dir: tmpDir, scope: "project" }]);
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
        "  - github",
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
    expect(a.toolRestrictionValidation).toEqual({ tools: "valid", disallowedTools: "valid" });
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

  it("normalizes documented MCP list syntax while preserving inert lexical evidence and hooks", () => {
    writeAgent(
      "scoped.md",
      [
        "---",
        "description: scoped fields",
        "memory: user",
        "mcpServers:",
        "  - shared",
        "  - local:",
        "      command: local-mcp",
        "      args: [serve]",
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
    expect(a.mcpServers).toEqual(["shared", { local: { command: "local-mcp", args: ["serve"] } }]);
    expect(a.agentMcp?.items).toEqual([
      { kind: "reference", name: "shared" },
      expect.objectContaining({
        kind: "inline",
        name: "local",
        entry: expect.objectContaining({ command: "local-mcp", args: ["serve"], skipped: false }),
      }),
    ]);
    expect(a.agentMcp?.scope).toBe("project");
    expect(a.agentMcp?.diagnostics).toEqual([]);
    expect(Object.isFrozen(a.agentMcp)).toBe(true);
    expect(Object.isFrozen(a.agentMcp?.items)).toBe(true);
    expect(Object.isFrozen(a.agentMcp?.items[1])).toBe(true);
    expect(Object.isFrozen(a.agentMcp?.diagnostics)).toBe(true);
    expect(Object.isFrozen(a.agentMcp?.items[1]?.kind === "inline" ? a.agentMcp.items[1].entry.env : undefined)).toBe(true);
    expect(a.hooks).toBeDefined();
    const entries = a.hooks!["SubagentStop"]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hooks[0]!.raw).toEqual({
      type: "command",
      command: "notify.sh",
      extraField: "kept",
    });
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

  it("returns empty results for a missing directory without throwing", () => {
    const { agents, diagnostics } = loadAgents([
      { dir: path.join(tmpDir, "does-not-exist"), scope: "user" },
    ]);
    expect(agents).toEqual([]);
    expect(diagnostics).toEqual([]);
  });
});

describe("agent tool-restriction validation provenance", () => {
  it("accepts bounded scalar and flat scalar-list forms before normalization", () => {
    expect(normalizeAgentToolRestrictions({
      tools: "Read, Grep",
      disallowedTools: ["Write", 7, true],
    })).toEqual({
      tools: ["Read", "Grep"],
      disallowedTools: ["Write", "7", "true"],
      validation: { tools: "valid", disallowedTools: "valid" },
    });
    expect(normalizeAgentToolRestrictions({ "allowed-tools": "Glob" })).toEqual({
      tools: ["Glob"],
      disallowedTools: undefined,
      validation: { tools: "valid", disallowedTools: "absent" },
    });
  });

  it("pins exact and +1 item, per-item, and aggregate limits for both fields and aliases", () => {
    const fieldCases = [
      ["tools", "tools"],
      ["allowed-tools", "tools"],
      ["disallowedTools", "disallowedTools"],
      ["disallowed-tools", "disallowedTools"],
    ] as const;
    const aggregateBoundary = Array.from(
      { length: AGENT_TOOL_RESTRICTION_LIMITS.totalChars / AGENT_TOOL_RESTRICTION_LIMITS.itemChars },
      () => "x".repeat(AGENT_TOOL_RESTRICTION_LIMITS.itemChars),
    );
    const boundaries = [
      Array.from({ length: AGENT_TOOL_RESTRICTION_LIMITS.items }, () => "x"),
      ["x".repeat(AGENT_TOOL_RESTRICTION_LIMITS.itemChars)],
      aggregateBoundary,
    ];
    const overLimits = [
      Array.from({ length: AGENT_TOOL_RESTRICTION_LIMITS.items + 1 }, () => "x"),
      ["x".repeat(AGENT_TOOL_RESTRICTION_LIMITS.itemChars + 1)],
      [...aggregateBoundary, "x"],
    ];

    for (const [inputField, validationField] of fieldCases) {
      for (const value of boundaries) {
        expect(normalizeAgentToolRestrictions({ [inputField]: value }).validation[validationField]).toBe("valid");
      }
      for (const value of overLimits) {
        expect(normalizeAgentToolRestrictions({ [inputField]: value }).validation[validationField]).toBe("invalid");
      }
    }
  });

  it("marks object, nested, non-scalar, accessor, prototype-hostile, and oversized material invalid", () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "tools", { get: () => { throw new Error("must not run"); } });
    const hostileArray = ["Read"];
    Object.setPrototypeOf(hostileArray, { poisoned: true });
    const cases: unknown[] = [
      { tools: { Read: true } },
      { tools: [["Read"]] },
      { tools: ["Read", { tool: "Write" }] },
      accessor,
      { tools: hostileArray },
      { tools: new Proxy(["Read"], { get() { throw new Error("array access trap"); } }) },
      { tools: "x".repeat(AGENT_TOOL_RESTRICTION_LIMITS.totalChars + 1) },
      { tools: Array.from({ length: AGENT_TOOL_RESTRICTION_LIMITS.items + 1 }, () => "Read") },
    ];
    for (const value of cases) {
      expect(normalizeAgentToolRestrictions(value).validation.tools).toBe("invalid");
    }
  });

  it("omits malformed legacy projection when shared visit or projected-character budgets are exhausted", () => {
    const shared = ["Read"];
    const nestedShared = Array.from({ length: AGENT_TOOL_RESTRICTION_LIMITS.items }, () => shared);
    const characterHeavyNested = Array.from(
      { length: (AGENT_TOOL_RESTRICTION_LIMITS.totalChars / AGENT_TOOL_RESTRICTION_LIMITS.itemChars) + 1 },
      () => "x".repeat(AGENT_TOOL_RESTRICTION_LIMITS.itemChars),
    );
    for (const tools of [nestedShared, [characterHeavyNested]]) {
      const normalized = normalizeAgentToolRestrictions({ tools });
      expect(normalized.validation.tools).toBe("invalid");
      expect(normalized.tools).toBeUndefined();
    }
  });

  it("retains invalid provenance and bounded diagnostics on parsed agent definitions", () => {
    writeAgent("invalid-tools.md", [
      "---",
      "description: invalid restrictions",
      "tools:",
      "  Read: true",
      "disallowedTools:",
      "  - Write",
      "  - [Bash]",
      "---",
      "body",
    ].join("\n"));

    const { agents } = load();
    expect(agents[0]?.tools).toEqual(["[object Object]"]);
    expect(agents[0]?.disallowedTools).toEqual(["Write", "Bash"]);
    expect(agents[0]?.toolRestrictionValidation).toEqual({
      tools: "invalid",
      disallowedTools: "invalid",
    });
    expect(agents[0]?.diagnostics.filter((item) => item.message.includes("selected main sessions will fail closed")))
      .toHaveLength(2);
  });
});

describe("agent MCP declaration normalization", () => {
  it("accepts references plus stdio and supported remote inline forms in deterministic order", () => {
    const declaration = normalizeAgentMcpDeclaration([
      "session-server",
      { stdio: { type: "stdio", command: "local-command", env: { TOKEN: "secret-value" } } },
      { http: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "secret-header" } } },
      { stream: { type: "streamable-http", url: "https://example.invalid/stream" } },
      { events: { type: "sse", url: "https://example.invalid/events" } },
    ], "project");

    expect(declaration.items.map((item) => [item.kind, item.name])).toEqual([
      ["reference", "session-server"],
      ["inline", "stdio"],
      ["inline", "http"],
      ["inline", "stream"],
      ["inline", "events"],
    ]);
    const inline = declaration.items.filter((item) => item.kind === "inline");
    expect(inline.map((item) => item.entry.remote?.configuredType ?? "stdio")).toEqual([
      "stdio", "http", "streamable-http", "sse",
    ]);
    expect(Object.getPrototypeOf(inline[0]!.entry.env)).toBeNull();
    expect(Object.getPrototypeOf(inline[1]!.entry.remote!.rawEntry!)).toBeNull();
    expect(Object.isFrozen(inline[1]!.entry.remote!.rawEntry)).toBe(true);
    expect(inline.every((item) => !Object.hasOwn(item.entry, "diagnostics"))).toBe(true);
    expect(declaration).toMatchObject({ scope: "project", diagnostics: [] });
  });

  it("preflights very large names while preserving the shared 128-character contract", () => {
    const boundaryName = "a".repeat(128);
    const overBoundaryName = "b".repeat(129);
    const hugeReference = "r".repeat(100_000);
    const hugeMappingName = "m".repeat(100_000);
    const declaration = normalizeAgentMcpDeclaration([
      boundaryName,
      overBoundaryName,
      hugeReference,
      { [hugeMappingName]: { command: "safe" } },
      "bad/name",
    ], "project");

    expect(declaration.items).toEqual([{ kind: "reference", name: boundaryName }]);
    expect(declaration.diagnostics).toEqual([
      "Agent mcpServers item 2 has a server name exceeding the 128-character limit; item ignored",
      "Agent mcpServers item 3 has a server name exceeding the 128-character limit; item ignored",
      "Agent mcpServers item 4 has a server name exceeding the 128-character limit; item ignored",
      expect.stringContaining("allowed: letters, digits"),
    ]);
    expect(declaration.diagnostics.join(" ")).not.toMatch(/r{64}|m{64}/u);
  });

  it("deep-freezes detached projected entries and discards unknown nested payloads", () => {
    const hidden = { payload: { canary: "UNKNOWN_NESTED_SECRET" } };
    const source = {
      command: "before-command",
      args: ["before-arg"],
      env: { TOKEN: "before-env" },
      unknownField: hidden,
    };
    const remote = {
      type: "http",
      url: "https://before.invalid/mcp",
      headers: { Authorization: "before-header" },
    };
    const declaration = normalizeAgentMcpDeclaration([
      { local: source },
      { remote },
    ], "user");
    source.command = "after-command";
    source.args[0] = "after-arg";
    source.env.TOKEN = "after-env";
    hidden.payload.canary = "after-secret";
    remote.url = "https://after.invalid/mcp";
    remote.headers.Authorization = "after-header";

    const inline = declaration.items[0];
    expect(inline?.kind).toBe("inline");
    if (inline?.kind !== "inline") throw new Error("expected inline declaration");
    expect(inline.entry).toMatchObject({
      command: "before-command",
      args: ["before-arg"],
      env: { TOKEN: "before-env" },
    });
    expect(JSON.stringify(inline.entry)).not.toMatch(/after-|UNKNOWN_NESTED_SECRET/u);
    expect(inline.entry).not.toHaveProperty("unknownField");
    const retainedRemote = declaration.items[1];
    expect(retainedRemote?.kind === "inline" ? retainedRemote.entry.remote?.rawEntry : undefined)
      .toMatchObject({ url: "https://before.invalid/mcp", headers: { Authorization: "before-header" } });

    const pending: unknown[] = [declaration];
    const visited = new Set<object>();
    while (pending.length > 0) {
      const value = pending.pop();
      if (value === null || typeof value !== "object" || visited.has(value)) continue;
      visited.add(value);
      expect(Object.isFrozen(value)).toBe(true);
      pending.push(...Object.values(value));
    }
  });

  it("bounds over-deep and over-wide entry graphs before normalization", () => {
    let deep: Record<string, unknown> = { canary: "DEEP_GRAPH_SECRET" };
    for (let index = 0; index < 10_000; index++) deep = { child: deep };
    const wide = Object.create(null) as Record<string, unknown>;
    wide.command = "would-run-if-truncated";
    for (let index = 0; index <= 64; index++) {
      wide[`unknown-${index}`] = { canary: `WIDE_GRAPH_SECRET_${index}` };
    }

    const declaration = normalizeAgentMcpDeclaration([
      { deepUnknown: { command: "safe", unknownField: deep } },
      { deepKnown: { command: "safe", env: { TOKEN: deep } } },
      { tooWide: wide },
    ], "project");

    expect(declaration.items.map((item) => item.name)).toEqual(["deepUnknown"]);
    expect(declaration.diagnostics.join(" ")).toContain('unknown field "unknownField" ignored');
    expect(declaration.diagnostics.join(" ")).toContain("more than 64 entry fields");
    const serialized = JSON.stringify(declaration);
    expect(serialized).not.toMatch(/DEEP_GRAPH_SECRET|WIDE_GRAPH_SECRET|would-run-if-truncated/u);
    const retained = declaration.items[0];
    expect(retained?.kind === "inline" ? retained.entry.remote?.rawEntry : undefined).toBeUndefined();
  });

  it("never invokes or retains callbacks and does not traverse malformed schema leaves", () => {
    let callbacks = 0;
    const callbackLeaf = Object.create(null) as Record<string, unknown>;
    callbackLeaf.toJSON = () => {
      callbacks++;
      return "CALLBACK_SECRET";
    };
    Object.defineProperty(callbackLeaf, "getter", {
      enumerable: true,
      get: () => {
        callbacks++;
        return "GETTER_SECRET";
      },
    });
    let deepLeaf: Record<string, unknown> = callbackLeaf;
    for (let index = 0; index < 10_000; index++) deepLeaf = { child: deepLeaf };
    const broadLeaf = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [
      `leaf-${index}`,
      callbackLeaf,
    ]));
    const accessorEntry = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorEntry, "command", {
      enumerable: true,
      get: () => {
        callbacks++;
        return "must-not-run";
      },
    });
    const accessorHeaders = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorHeaders, "Authorization", {
      enumerable: true,
      get: () => {
        callbacks++;
        return "must-not-read";
      },
    });

    const declaration = normalizeAgentMcpDeclaration([
      { scalar: { command: deepLeaf } },
      { args: { command: "safe", args: [callbackLeaf] } },
      { env: { command: "safe", env: { TOKEN: broadLeaf } } },
      { headers: { type: "http", url: "https://example.invalid", headers: { Authorization: deepLeaf } } },
      { accessorEntry },
      { accessorHeaders: { type: "http", url: "https://example.invalid", headers: accessorHeaders } },
      { unknown: { command: "safe", unknownPayload: callbackLeaf } },
      { nonPlain: new Date(0) },
    ], "project");

    expect(callbacks).toBe(0);
    expect(declaration.items.map((item) => item.name)).toEqual(["unknown"]);
    expect(declaration.diagnostics.join(" ")).toMatch(/invalid property|accessor|plain entry object/u);
    expect(JSON.stringify(declaration)).not.toMatch(/CALLBACK_SECRET|GETTER_SECRET|must-not/u);
    expect(callbacks).toBe(0);
  });

  it("enforces literal collection and combined graph budgets", () => {
    const args = Array.from({ length: 65 }, (_, index) => `arg-${index}`);
    const env = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`ENV_${index}`, `value-${index}`]));
    const headers = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`Header-${index}`, `value-${index}`]));
    const combined: Record<string, unknown> = {
      command: "safe",
      args: Array.from({ length: 64 }, () => "arg"),
      env: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`ENV_${index}`, "value"])),
      headers: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`Header-${index}`, "value"])),
    };
    for (let index = 0; index < 60; index++) combined[`unknown-${index}`] = null;

    const declaration = normalizeAgentMcpDeclaration([
      { tooManyArgs: { command: "safe", args } },
      { tooManyEnv: { command: "safe", env } },
      { tooManyHeaders: { type: "http", url: "https://example.invalid", headers } },
      { tooManyCombinedNodes: combined },
    ], "project");

    expect(declaration.items).toEqual([]);
    expect(declaration.diagnostics).toEqual([
      expect.stringContaining('property "args" has more than 64 entries'),
      expect.stringContaining('property "env" has more than 64 entries'),
      expect.stringContaining('property "headers" has more than 64 entries'),
      expect.stringContaining("exceeds the 256-node projected graph limit"),
    ]);
  });

  it("aligns header names to 256 while retaining narrower field and env name bounds", () => {
    const headerAtBoundary = "H".repeat(256);
    const declaration = normalizeAgentMcpDeclaration([
      { acceptedHeader: {
        type: "http",
        url: "https://example.invalid",
        headers: { [headerAtBoundary]: "value" },
      } },
      { rejectedHeader: {
        type: "http",
        url: "https://example.invalid",
        headers: { ["H".repeat(257)]: "HEADER_VALUE" },
      } },
      { rejectedEnv: { command: "safe", env: { ["E".repeat(129)]: "ENV_VALUE" } } },
      { rejectedField: { command: "safe", ["f".repeat(129)]: null } },
    ], "project");

    const accepted = declaration.items[0];
    expect(accepted?.kind === "inline" ? accepted.entry.remote?.rawEntry?.headers : undefined)
      .toEqual({ [headerAtBoundary]: "value" });
    expect(declaration.diagnostics).toEqual([
      expect.stringContaining('property "headers" has a key exceeding the 256-character name limit'),
      expect.stringContaining('property "env" has a key exceeding the 128-character name limit'),
      expect.stringContaining("field name exceeding the 128-character limit"),
    ]);
    expect(declaration.diagnostics.join(" ")).not.toMatch(/HEADER_VALUE|ENV_VALUE/u);
  });

  it("identifies literal field, string, and scalar projection violations without values", () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "command", { enumerable: true, get: () => "ACCESSOR_VALUE" });
    const declaration = normalizeAgentMcpDeclaration([
      { tooManyFields: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field-${index}`, null])) },
      { tooLongString: { command: "S".repeat(8193) } },
      { invalidTimeout: { command: "safe", timeout: Number.POSITIVE_INFINITY } },
      { accessor },
    ], "project");

    expect(declaration.items).toEqual([]);
    expect(declaration.diagnostics).toEqual([
      expect.stringContaining("more than 64 entry fields"),
      expect.stringContaining('property "command" exceeds the 8192-character string limit'),
      expect.stringContaining('invalid property "timeout" (must be a finite number)'),
      expect.stringContaining("contains an accessor entry property"),
    ]);
    expect(declaration.diagnostics.join(" ")).not.toMatch(/ACCESSOR_VALUE|SSSSSSSS/u);
  });

  it("distinguishes omission from a valid empty declaration", () => {
    writeAgent("omitted.md", "---\ndescription: omitted\n---\nbody");
    writeAgent("empty.md", "---\ndescription: empty\nmcpServers: []\n---\nbody");
    const byName = Object.fromEntries(load().agents.map((agent) => [agent.name, agent]));
    expect(Object.hasOwn(byName["omitted"]!, "agentMcp")).toBe(false);
    expect(byName["empty"]!.agentMcp).toEqual({
      scope: "project",
      items: [],
      diagnostics: [],
      diagnosticOwnership: [],
    });
  });

  it.each([
    ["mapping outer shape", { server: { command: "x" } }],
    ["null outer shape", null],
    ["scalar outer shape", "server"],
  ])("keeps a wrong %s inert and diagnostic", (_label, value) => {
    const declaration = normalizeAgentMcpDeclaration(value, "project");
    expect(declaration.items).toEqual([]);
    expect(declaration.diagnostics).toEqual([
      "Agent mcpServers must be a list of server-name references or one-key inline mappings; declaration ignored",
    ]);
  });

  it("skips malformed items, names, configs, and unsupported transports while retaining valid siblings", () => {
    const declaration = normalizeAgentMcpDeclaration([
      null,
      7,
      {},
      { one: { command: "x" }, two: { command: "y" } },
      "bad/name\nwith-control",
      { "bad__name": { command: "x" } },
      { missing: { args: ["no-command"] } },
      { badArgs: { command: "x", args: ["ok", 7] } },
      { websocket: { type: "ws", url: "wss://secret.invalid/socket" } },
      "valid-reference",
      { validInline: { command: "safe-command" } },
    ], "project");

    expect(declaration.items.map((item) => item.name)).toEqual(["valid-reference", "validInline"]);
    expect(declaration.diagnostics.length).toBeGreaterThanOrEqual(9);
    expect(declaration.diagnostics.join("\n")).not.toContain("wss://secret.invalid/socket");
    expect(declaration.diagnostics.every((message) => !/[\r\n]/u.test(message))).toBe(true);
  });

  it("assigns exact structured ownership without depending on diagnostic prose", () => {
    const declaration = normalizeAgentMcpDeclaration([
      { command: { args: ["missing-command"] } },
      "owned-duplicate",
      "owned-duplicate",
      null,
      { "unsafe/name": { command: "secret-command" } },
    ], "project");

    expect(declaration.diagnosticOwnership).toEqual([
      { kind: "server", serverName: "command" },
      { kind: "server", serverName: "owned-duplicate" },
      { kind: "unowned", itemIndex: 3 },
      { kind: "unowned", itemIndex: 4 },
    ]);
    expect(declaration.diagnosticOwnership).toHaveLength(declaration.diagnostics.length);
    expect(Object.isFrozen(declaration.diagnosticOwnership)).toBe(true);
    for (const owner of declaration.diagnosticOwnership) {
      expect(Object.isFrozen(owner)).toBe(true);
      expect(Object.getPrototypeOf(owner)).toBeNull();
    }
    const opaqueMessages = declaration.diagnostics.map(() => "opaque finding");
    expect(opaqueMessages.map((_message, index) => declaration.diagnosticOwnership[index])).toEqual(
      declaration.diagnosticOwnership,
    );
    expect(JSON.stringify(declaration.diagnosticOwnership)).not.toContain("secret-command");

    let getterCalls = 0;
    const accessorList: unknown[] = [];
    Object.defineProperty(accessorList, "0", {
      enumerable: true,
      configurable: true,
      get: () => { getterCalls++; return { leaked: { command: "ACCESSOR_SECRET" } }; },
    });
    accessorList.length = 1;
    const accessorDeclaration = normalizeAgentMcpDeclaration(accessorList, "project");
    expect(getterCalls).toBe(0);
    expect(accessorDeclaration.diagnosticOwnership).toEqual([{ kind: "unowned", itemIndex: 0 }]);
    expect(JSON.stringify(accessorDeclaration)).not.toContain("ACCESSOR_SECRET");
  });

  it("retains the first valid same-name occurrence across reference and inline kinds", () => {
    const declaration = normalizeAgentMcpDeclaration([
      "same",
      { same: { command: "not-retained" } },
      { other: { command: "retained" } },
      "other",
      "same",
    ], "project");
    expect(declaration.items.map((item) => [item.kind, item.name])).toEqual([
      ["reference", "same"],
      ["inline", "other"],
    ]);
    expect(declaration.diagnostics.filter((message) => message.includes("first valid occurrence retained"))).toHaveLength(3);
    expect(declaration.diagnostics.join("\n")).not.toContain("not-retained");
  });

  it("retains valid item 128 and omits distinct item 129", () => {
    const items = Array.from({ length: 128 }, (_, index) => `server-${index + 1}`);
    items.push("item-129-canary");
    const declaration = normalizeAgentMcpDeclaration(items, "project");

    expect(declaration.items).toHaveLength(128);
    expect(declaration.items[127]).toEqual({ kind: "reference", name: "server-128" });
    expect(declaration.items.some((item) => item.name === "item-129-canary")).toBe(false);
    expect(declaration.diagnostics).toEqual([
      "Agent mcpServers has more than 128 items; later items ignored",
    ]);
  });

  it("reaches exactly 128 single-line diagnostics including the omission summary", () => {
    const hostile: unknown[] = Array.from({ length: 128 }, (_, index) => ({
      [`bad/name-${index}\u001b[31m`]: {
        command: `COMMAND_SECRET_${index}`,
        env: { TOKEN: `ENV_SECRET_${index}` },
      },
    }));
    const declaration = normalizeAgentMcpDeclaration(hostile, "project");

    expect(declaration.items).toEqual([]);
    expect(declaration.diagnostics).toHaveLength(128);
    expect(declaration.diagnostics[127]).toBe("Additional agent MCP diagnostics omitted (1)");
    expect(declaration.diagnosticOwnership).toHaveLength(128);
    expect(declaration.diagnosticOwnership[127]).toEqual({ kind: "unowned" });
    expect(declaration.diagnostics.every((message) => message.length <= 192)).toBe(true);
    const rendered = declaration.diagnostics.join("\n");
    expect(rendered).not.toMatch(/[\u001b\r\t]/u);
    expect(rendered).not.toContain("COMMAND_SECRET_");
    expect(rendered).not.toContain("ENV_SECRET_");
  });

  it("collapses raw controls and caps diagnostics at the character boundary", () => {
    const capCanary = `${"/".repeat(107)}\r\n\tRAW_CONTROL_CANARY`;
    const declaration = normalizeAgentMcpDeclaration([capCanary], "project");
    expect(declaration.items).toEqual([]);
    expect(declaration.diagnostics).toHaveLength(1);
    expect(declaration.diagnostics[0]).toHaveLength(192);
    expect(declaration.diagnostics[0]!.endsWith("…")).toBe(true);
    expect(declaration.diagnostics[0]).not.toMatch(/[\r\n\t]/u);
    expect(declaration.diagnostics[0]).toContain("RAW_CONTROL_CANARY");

    const overlong = normalizeAgentMcpDeclaration([
      `${"a".repeat(129)}\r\n\tOVERLONG_CONTROL_CANARY`,
    ], "project");
    expect(overlong.items).toEqual([]);
    expect(overlong.diagnostics.every((message) => message.length <= 192)).toBe(true);
    expect(overlong.diagnostics.join("")).not.toMatch(/[\r\n\t]/u);
  });

  it("redacts command, env, and header values on post-name-validation failures", () => {
    const declaration = normalizeAgentMcpDeclaration([
      { badStdio: { command: "COMMAND_SECRET", args: ["ok", 7], env: { TOKEN: "ENV_SECRET" } } },
      { badRemote: {
        type: "http",
        url: "https://example.invalid",
        env: { TOKEN: "ENV_SECRET_REMOTE" },
        headers: { Authorization: "HEADER_SECRET" },
      } },
    ], "project");
    expect(declaration.items).toEqual([]);
    expect(JSON.stringify(declaration)).not.toMatch(/COMMAND_SECRET|ENV_SECRET|HEADER_SECRET/u);
  });

  it("fixes declaration/admission/result provenance in the compile-time contracts", () => {
    expectTypeOf<AgentMcpDeclaration["scope"]>().toEqualTypeOf<"user" | "project">();
    expectTypeOf<Parameters<AgentMcpAdmissionContext["resolve"]>>()
      .toEqualTypeOf<[declaration: AgentMcpDeclaration]>();
    expectTypeOf<ReturnType<AgentMcpAdmissionContext["resolve"]>>()
      .toEqualTypeOf<ResolvedAgentMcpConfig>();
    expectTypeOf<ResolvedAgentMcpServer["source"]>().toEqualTypeOf<"subagent-inline">();
    expectTypeOf<Extract<ResolvedAgentMcpServer, { status: "enabled"; transport: "stdio" }>>()
      .toHaveProperty("command")
      .toBeString();
    expectTypeOf<Extract<ResolvedAgentMcpServer, { status: "enabled"; transport: "http" | "sse" }>>()
      .toHaveProperty("url")
      .toBeString();
    expectTypeOf<ResolvedAgentMcpConfig["servers"]>().toEqualTypeOf<readonly ResolvedAgentMcpServer[]>();
    expectTypeOf<AgentMcpDeclaration["diagnosticOwnership"][number]>().toEqualTypeOf<
      | { readonly kind: "server"; readonly serverName: string }
      | { readonly kind: "unowned"; readonly itemIndex?: number }
    >();

    // @ts-expect-error Managed provenance cannot enter an effective declaration.
    const invalidDeclaration: AgentMcpDeclaration = { scope: "managed", items: [], diagnostics: [] };
    // @ts-expect-error Enabled stdio rows cannot carry a remote URL.
    const invalidStdioUrl: ResolvedAgentMcpServer = { name: "x", source: "subagent-inline", status: "enabled", transport: "stdio", command: "x", rawCommand: "x", args: [], env: {}, diagnostics: [], url: "https://invalid.example" };
    // @ts-expect-error Enabled remote rows cannot carry a stdio command.
    const invalidRemoteCommand: ResolvedAgentMcpServer = { name: "x", source: "subagent-inline", status: "enabled", transport: "http", configuredType: "http", url: "https://example.invalid", headers: {}, diagnostics: [], command: "x" };
    // @ts-expect-error Inactive rows cannot carry enabled stdio runtime fields.
    const invalidInactiveRuntime: ResolvedAgentMcpServer = { name: "x", source: "subagent-inline", status: "skipped", diagnostics: [], command: "x", rawCommand: "x", args: [], env: {} };
    // @ts-expect-error Ordinary MCP provenance cannot enter an agent-local result.
    const invalidConfig: ResolvedAgentMcpConfig = { servers: [{ name: "x", source: "settings-user", status: "skipped", diagnostics: [] }], diagnostics: [] };
    if (false) {
      const readonlyDeclaration = null as unknown as AgentMcpDeclaration;
      // @ts-expect-error Declaration provenance is immutable after normalization.
      readonlyDeclaration.scope = "user";
      // @ts-expect-error Declaration items are immutable.
      readonlyDeclaration.items.push({ kind: "reference", name: "x" });
      // @ts-expect-error Declaration diagnostics are immutable.
      readonlyDeclaration.diagnostics.push("x");
      const readonlyItem = null as unknown as AgentMcpItem;
      // @ts-expect-error Item fields are immutable.
      readonlyItem.name = "x";

      const readonlyInline = null as unknown as Extract<AgentMcpItem, { kind: "inline" }>;
      // @ts-expect-error Normalized args are deeply immutable.
      readonlyInline.entry.args[0] = "x";
      // @ts-expect-error Normalized env is deeply immutable.
      readonlyInline.entry.env.TOKEN = "x";
      if (readonlyInline.entry.remote !== undefined) {
        // @ts-expect-error Normalized remote headers are deeply immutable.
        readonlyInline.entry.remote.rawHeaders.Authorization = "x";
      }

      const readonlyConfig = null as unknown as ResolvedAgentMcpConfig;
      // @ts-expect-error Resolved config diagnostics are immutable.
      readonlyConfig.diagnostics.push("x");
      const readonlyServer = readonlyConfig.servers[0]!;
      // @ts-expect-error Resolved server fields are immutable.
      readonlyServer.name = "x";
      if (readonlyServer.status === "enabled" && readonlyServer.transport === "stdio") {
        // @ts-expect-error Resolved stdio args are immutable.
        readonlyServer.args[0] = "x";
      }
      if (readonlyServer.status === "enabled" && readonlyServer.transport !== "stdio") {
        // @ts-expect-error Resolved remote headers are immutable.
        readonlyServer.headers.Authorization = "x";
      }
    }
    void invalidDeclaration;
    void invalidStdioUrl;
    void invalidRemoteCommand;
    void invalidInactiveRuntime;
    void invalidConfig;
  });

  it("retains user/project provenance but managed agents ignore MCP with a diagnostic", () => {
    const userDir = path.join(tmpDir, "user");
    const projectDir = path.join(tmpDir, "project");
    const managedDir = path.join(tmpDir, "managed");
    for (const [dir, name] of [[userDir, "user-agent"], [projectDir, "project-agent"], [managedDir, "managed-agent"]] as const) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.md`), `---\ndescription: ${name}\nmcpServers: [shared]\n---\nbody`);
    }
    const result = loadAgents([
      { dir: userDir, scope: "user" },
      { dir: projectDir, scope: "project" },
      { dir: managedDir, scope: "managed" },
    ]);
    const byName = Object.fromEntries(result.agents.map((agent) => [agent.name, agent]));
    expect(byName["user-agent"]!.source.scope).toBe("user");
    expect(byName["project-agent"]!.source.scope).toBe("project");
    expect(byName["user-agent"]!.agentMcp?.items).toEqual([{ kind: "reference", name: "shared" }]);
    expect(byName["project-agent"]!.agentMcp?.items).toEqual([{ kind: "reference", name: "shared" }]);
    expect(byName["user-agent"]!.agentMcp?.scope).toBe("user");
    expect(byName["project-agent"]!.agentMcp?.scope).toBe("project");
    expect(Object.hasOwn(byName["managed-agent"]!, "agentMcp")).toBe(false);
    expect(byName["managed-agent"]!.mcpServers).toEqual(["shared"]);
    expect(byName["managed-agent"]!.diagnostics).toEqual([
      expect.objectContaining({ message: 'Managed agent field "mcpServers" is unsupported and was ignored' }),
    ]);
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

  it("omits invalid plugin-agent local and later nested segments without affecting a multi-level sibling", () => {
    const pluginRoot = path.join(tmpDir, "name-grammar");
    for (const [relative, frontmatterName] of [
      ["agents/valid-agent.md", undefined],
      ["agents/Upper.md", undefined],
      ["agents/agent1.md", undefined],
      ["agents/under_score.md", undefined],
      ["agents/has space.md", undefined],
      ["agents/colon.md", "has:colon"],
      ["agents/good-parent/good-child/nested-agent.md", undefined],
      ["agents/good-parent/Bad-child/ignored.md", undefined],
      ["agents/good-parent/child2/ignored.md", undefined],
      ["agents/good-parent/under_score-child/ignored.md", undefined],
      ["agents/good-parent/has space/ignored.md", undefined],
    ] as const) {
      writeAgent(`name-grammar/${relative}`, `---\n${frontmatterName ? `name: ${frontmatterName}\n` : ""}description: agent\n---\nbody`);
    }

    const result = loadPluginAgents([pluginSource(pluginRoot, "./agents", "directory")]);
    expect(result.agents.map((agent) => agent.name)).toEqual([
      "good-parent:good-child:nested-agent",
      "valid-agent",
    ]);
    const grammarDiagnostics = result.diagnostics.filter((item) => item.message.includes("expected lowercase letters"));
    expect(grammarDiagnostics).toHaveLength(9);
    expect(new Set(grammarDiagnostics.map((item) => item.message))).toEqual(new Set([
      "Plugin agent directory name is malformed; expected lowercase letters separated by single hyphens; agent skipped",
      "Plugin agent local name is malformed; expected lowercase letters separated by single hyphens; agent skipped",
    ]));
    for (const rejected of ["Upper", "agent1", "under_score", "has space", "has:colon", "Bad-child", "child2"]) {
      expect(grammarDiagnostics.every((item) => !item.message.includes(rejected))).toBe(true);
    }
  });

  it.skipIf(process.platform === "win32")("omits a colon in a later nested segment without affecting a multi-level sibling", () => {
    const pluginRoot = path.join(tmpDir, "colon-directory");
    writeAgent("colon-directory/agents/good-parent/good-child/valid-agent.md", "---\ndescription: valid\n---\nbody");
    writeAgent("colon-directory/agents/good-parent/bad:child/ignored.md", "---\ndescription: ignored\n---\nbody");
    const result = loadPluginAgents([pluginSource(pluginRoot, "./agents", "directory")]);
    expect(result.agents.map((agent) => agent.name)).toEqual(["good-parent:good-child:valid-agent"]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Plugin path must not contain an alternate-data-stream or drive separator" }),
    ]));
    expect(result.diagnostics.every((item) => !item.message.includes("bad:child"))).toBe(true);
  });

  it("reports a direct explicit final-read failure as terminal typed evidence", () => {
    const pluginRoot = path.join(tmpDir, "final-read");
    const file = writeAgent("final-read/agent.md", "---\ndescription: agent\n---\nbody");
    const input = pluginSource(pluginRoot, "./agent.md", "file");
    const nativeRead = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((value: fs.PathOrFileDescriptor, options?: unknown) => {
      if (path.normalize(String(value)) === path.normalize(file)) {
        const error = Object.assign(new Error("private final read"), { code: "EACCES" });
        throw error;
      }
      return nativeRead(value, options as never);
    }) as typeof fs.readFileSync);
    try {
      const result = loadPluginAgents([input]);
      expect(result.agents).toEqual([]);
      expect(result.pathFailures).toHaveLength(1);
      expect(result.pathFailures![0]).toMatchObject({
        pluginId: "agents@trusted-market",
        component: "agent",
        source: input.source,
        terminal: true,
        failure: { code: "unreadable-path" },
      });
      expect(JSON.stringify(result.pathFailures)).not.toContain("private final read");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps a final-read failure below an explicit directory component-local", () => {
    const pluginRoot = path.join(tmpDir, "directory-final-read");
    const failed = writeAgent("directory-final-read/agents/a-failed.md", "---\ndescription: failed\n---\nbody");
    writeAgent("directory-final-read/agents/b-valid.md", "---\ndescription: valid\n---\nbody");
    const nativeRead = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((value: fs.PathOrFileDescriptor, options?: unknown) => {
      if (path.normalize(String(value)) === path.normalize(failed)) {
        throw Object.assign(new Error("private descendant read"), { code: "EACCES" });
      }
      return nativeRead(value, options as never);
    }) as typeof fs.readFileSync);
    try {
      const result = loadPluginAgents([pluginSource(pluginRoot, "./agents", "directory")]);
      expect(result.agents.map((agent) => agent.name)).toEqual(["b-valid"]);
      expect(result.agents[0]!.source).toMatchObject({
        scope: "plugin",
        pluginId: "agents@trusted-market",
        pluginName: "agents",
      });
      expect(result.pathFailures).toEqual([]);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ message: "Could not read agent file; skipped" }),
      ]);
      expect(JSON.stringify(result)).not.toContain("private descendant read");
    } finally {
      spy.mockRestore();
    }
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
    expect(Object.hasOwn(agent, "agentMcp")).toBe(false);
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

  it("rejects a valid mixed plugin MCP declaration without retaining raw or effective forms", () => {
    const pluginRoot = path.join(tmpDir, "forbidden-valid-mcp");
    const file = writeAgent(
      "forbidden-valid-mcp/agent.md",
      [
        "---",
        "description: plugin agent",
        "mcpServers:",
        "  - shared-reference",
        "  - harmless-inline:",
        "      command: picc-harmless-inline-fixture",
        "      args: [--inert]",
        "---",
        "body",
      ].join("\n"),
    );

    const result = loadPluginAgents([pluginSource(pluginRoot, "./agent.md", "file")]);
    expect(result.agents).toHaveLength(1);
    const agent = result.agents[0]!;
    expect(Object.hasOwn(agent, "mcpServers")).toBe(false);
    expect(Object.hasOwn(agent, "agentMcp")).toBe(false);
    expect(agent.diagnostics).toEqual([{
      severity: "warning",
      message: 'Plugin agent field "mcpServers" is forbidden and was removed',
      source: file,
    }]);
    expect(result.diagnostics).toEqual(agent.diagnostics);
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

  it("preserves forbidden plugin fields as effective configuration for an ordinary user agent", () => {
    const file = writeAgent(
      "ordinary-user/agent.md",
      "---\ndescription: user\npermissionMode: default\nmcpServers: [shared]\nhooks: {}\n---\nbody",
    );
    const result = loadAgents([{ dir: path.dirname(file), scope: "user" }]);
    expect(result.diagnostics).toEqual([]);
    expect(result.agents[0]).toMatchObject({
      permissionMode: "default",
      mcpServers: ["shared"],
      agentMcp: { scope: "user", items: [{ kind: "reference", name: "shared" }], diagnostics: [] },
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

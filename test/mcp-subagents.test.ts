import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import picc, { formatAgentMcpSetupWarning, type PiccTestSeam } from "../src/index.js";
import { PermissionEngine } from "../src/engine/permissions.js";
import { HookRunner } from "../src/engine/hook-runner.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk, type FakeCustomTool, type FakeSdkHandle } from "./helpers/fake-sdk.js";
import { createMcpProcessFixture, processIsAlive, type McpProcessFixture } from "./helpers/mcp-process.js";
import type { PiSdk } from "../src/runtime/subagents.js";
import type { McpLifecycleState, McpToolInfo } from "../src/runtime/mcp.js";
import { deferred, waitUntil } from "./helpers/async.js";

/**
 * Subagent MCP integration: inheritance, restriction, and drop of
 * `mcp__<server>__<tool>` names through the existing gateTools machinery, and
 * per-dispatch proxy provisioning over the session-global runtime.
 *
 * Layer 1: gateTools rows with live MCP names in the known-tool universe
 * (matrix style of the gateTools rows in test/permissions.test.ts; kept beside
 * the wired tests so MCP subagent coverage lives in one file).
 *
 * Layer 2: the real extension (`picc(pi)`) against a real fixture stdio
 * server, with dispatch driven through the registered Agent tool over the
 * fake-SDK seam (`setSdkForTest`) — inherit / restrict / drop observed on the
 * actual createAgentSession options, a live in-subagent round-trip through the
 * shared runtime, and the dispatch-installed guard blocking a denied MCP call.
 */

// ---------------------------------------------------------------------------
// Layer 1 — gateTools with MCP names in the universe
// ---------------------------------------------------------------------------

describe("gateTools over a universe containing live MCP names", () => {
  const CWD = process.cwd();
  const rules = (r: Partial<{ allow: string[]; deny: string[]; ask: string[] }> = {}) => ({
    allow: r.allow ?? [],
    deny: r.deny ?? [],
    ask: r.ask ?? [],
    additionalDirectories: [] as string[],
  });
  const MCP_KNOWN = ["mcp__fixture__echo", "mcp__fixture__report-env", "mcp__other__run"];
  const known = ["Read", "Bash", ...MCP_KNOWN];
  const engine = new PermissionEngine(rules(), { cwd: CWD });

  it("unspecified tools: (granted undefined) inherits every MCP name", () => {
    expect(engine.gateTools(undefined, undefined, known)).toEqual(known);
  });

  it("tools: [mcp__fixture] restricts to that server's tools (bare-server fan-out)", () => {
    expect(engine.gateTools(["mcp__fixture"], undefined, known)).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__report-env",
    ]);
  });

  it("an exact mcp__server__tool grant covers only that tool", () => {
    expect(engine.gateTools(["Read", "mcp__fixture__echo"], undefined, known)).toEqual([
      "Read",
      "mcp__fixture__echo",
    ]);
  });

  it("disallowedTools: [mcp__fixture] drops the whole server, keeps the rest", () => {
    expect(engine.gateTools(undefined, ["mcp__fixture"], known)).toEqual([
      "Read",
      "Bash",
      "mcp__other__run",
    ]);
  });

  it("a bare settings deny removes a server's MCP names even when explicitly granted", () => {
    const denyEngine = new PermissionEngine(rules({ deny: ["mcp__fixture"] }), { cwd: CWD });
    expect(denyEngine.gateTools(["mcp__fixture", "Read"], undefined, known)).toEqual(["Read"]);
  });

  it("a broad mcp__* deny removes every MCP name from the universe", () => {
    const broadEngine = new PermissionEngine(rules({ deny: ["mcp__*"] }), { cwd: CWD });
    expect(broadEngine.gateTools(undefined, undefined, known)).toEqual(["Read", "Bash"]);
  });

  it("an exact MCP deny removes only that tool", () => {
    const exactEngine = new PermissionEngine(rules({ deny: ["mcp__fixture__echo"] }), { cwd: CWD });
    expect(exactEngine.gateTools(undefined, undefined, known)).toEqual([
      "Read",
      "Bash",
      "mcp__fixture__report-env",
      "mcp__other__run",
    ]);
  });

  it("a specifier'd MCP deny does NOT remove at gating (stays a call-time guard block)", () => {
    const scopedEngine = new PermissionEngine(rules({ deny: ["mcp__fixture__echo(text:secret*)"] }), {
      cwd: CWD,
    });
    expect(scopedEngine.gateTools(undefined, undefined, known)).toEqual(known);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — wired dispatch over a real fixture server
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeProjectFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const originalCwd = process.cwd();
const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

afterAll(() => {
  process.chdir(originalCwd);
  if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
  else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
  for (const dir of tempDirs) {
    try {
      // Same Windows retry discipline as the MCP registration tests: the load's
      // fire-and-forget orphan reap runs short-lived `git` children inside the
      // project dir, and a still-running child fails the top-level rmdir EPERM.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});

describe("agent MCP generation warning mapper", () => {
  const declaration = {
    items: [{ kind: "inline", name: "command" }],
    diagnostics: [],
    diagnosticOwnership: [],
  } as never;

  it.each(["enabled", "blocked", "pending-approval", "disabled", "invalid"] as const)(
    "keeps a published session-route collision quiet for %s inline admission",
    (status) => {
      const diagnostic = status === "invalid" ? ["opaque admission finding"] : [];
      const warning = formatAgentMcpSetupWarning(
        { borrowedServerNames: () => ["command"], setupOutcomes: () => [] },
        {
          servers: [{ name: "command", status, diagnostics: diagnostic }],
          diagnostics: diagnostic,
          diagnosticOwnership: diagnostic.map(() => ({ kind: "server", serverName: "command" })),
        } as never,
        status === "invalid"
          ? {
              items: [{ kind: "inline", name: "command" }],
              diagnostics: ["wording intentionally opaque"],
              diagnosticOwnership: [{ kind: "server", serverName: "command" }],
            } as never
          : declaration,
      );
      expect(warning).toBeUndefined();
    },
  );

  it("keeps a collision with a healthy sibling quiet", () => {
    const warning = formatAgentMcpSetupWarning(
      { borrowedServerNames: () => ["command"], setupOutcomes: () => [] },
      {
        servers: [
          { name: "command", status: "invalid", diagnostics: ["opaque collision finding"] },
          { name: "healthy", status: "enabled", diagnostics: [] },
        ],
        diagnostics: ["opaque aggregate finding"],
        diagnosticOwnership: [{ kind: "server", serverName: "command" }],
      } as never,
      declaration,
    );

    expect(warning).toBeUndefined();
  });

  it("warns for a collision named command plus an unrelated missing-command victim", () => {
    const warning = formatAgentMcpSetupWarning(
      { borrowedServerNames: () => ["command"], setupOutcomes: () => [] },
      {
        servers: [{ name: "command", status: "enabled", diagnostics: [] }],
        diagnostics: ["opaque aggregate finding with no identity tokens"],
        diagnosticOwnership: [{ kind: "server", serverName: "victim" }],
      } as never,
      {
        items: [{ kind: "inline", name: "command" }],
        diagnostics: ["opaque parser finding with no identity tokens"],
        diagnosticOwnership: [{ kind: "server", serverName: "victim" }],
      } as never,
    );

    expect(warning).toBe("Agent MCP availability warning: part of the mcpServers declaration is malformed; fix the skipped entries and restart the agent.");
  });

  it("warns for a collision plus an unowned malformed sibling", () => {
    const warning = formatAgentMcpSetupWarning(
      { borrowedServerNames: () => ["command"], setupOutcomes: () => [] },
      {
        servers: [{ name: "command", status: "enabled", diagnostics: [] }],
        diagnostics: ["opaque aggregate finding"],
        diagnosticOwnership: [{ kind: "unowned" }],
      } as never,
      {
        items: [{ kind: "inline", name: "command" }],
        diagnostics: ["opaque malformed sibling"],
        diagnosticOwnership: [{ kind: "unowned", itemIndex: 1 }],
      } as never,
    );

    expect(warning).toBe("Agent MCP availability warning: part of the mcpServers declaration is malformed; fix the skipped entries and restart the agent.");
  });

  it.each([
    ["blocked", "blocked by managed MCP policy"],
    ["pending-approval", "needs project approval"],
    ["disabled", "is disabled"],
    ["invalid", "has no usable definition"],
  ] as const)("maps non-routed %s admission to fixed bounded guidance", (status, expected) => {
    const warning = formatAgentMcpSetupWarning(
      { borrowedServerNames: () => [], setupOutcomes: () => [] },
      { servers: [{ name: `unsafe\\n${status}`, status }], diagnostics: [] } as never,
      declaration,
    );
    expect(warning).toContain(expected);
    expect(warning).not.toContain("\n");
    expect(warning!.length).toBeLessThanOrEqual(480);
  });

  it.each([
    ["missing-reference", "configure and enable that server, restart the main PiCC session, then dispatch the agent again"],
    ["inline-startup-failed", "failed during startup or discovery"],
  ] as const)("maps %s scope outcome without raw diagnostics", (kind, expected) => {
    const warning = formatAgentMcpSetupWarning(
      { borrowedServerNames: () => [], setupOutcomes: () => [{ serverName: "safe", kind }] },
      { servers: [], diagnostics: [], diagnosticOwnership: [] }, declaration,
    );
    expect(warning).toContain(expected);
    expect(warning).not.toContain("transport");
  });

  it("bounds overflow, redacts controls, and reports malformed declarations", () => {
    const servers = Array.from({ length: 20 }, (_, index) => ({
      name: `server-${index}\u001b[2J${"x".repeat(100)}`, status: "invalid",
    }));
    const warning = formatAgentMcpSetupWarning(
      { borrowedServerNames: () => [], setupOutcomes: () => [] },
      { servers, diagnostics: ["RAW_SECRET"] } as never,
      { items: [], diagnostics: ["RAW_SECRET"], diagnosticOwnership: [{ kind: "unowned" }] },
    )!;
    expect(warning.length).toBeLessThanOrEqual(480);
    expect(warning).not.toContain("\u001b");
    expect(warning).not.toContain("RAW_SECRET");
    expect(warning).toContain("MCP setup issue");
  });
});

describe("subagent MCP identity across remote lifecycle states (fake runtime)", () => {
  type Runtime = NonNullable<PiccTestSeam["mcpRuntime"]>;

  it("builds distinct proxies over one stable permission universe while connected, reconnecting, and failed", async () => {
    const savedForkGate = process.env.CLAUDE_CODE_FORK_SUBAGENT;
    delete process.env.CLAUDE_CODE_FORK_SUBAGENT;
    const dir = makeTempDir("picc-remotesub-");
    const userDir = makeTempDir("picc-remotesub-user-");
    writeProjectFile(dir, "CLAUDE.md", "REMOTE-SUB-PROJECT\n");
    writeProjectFile(
      dir,
      ".claude/agents/inheritor.md",
      "---\nname: inheritor\ndescription: inherits tools\n---\nStable universe.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/server-only.md",
      "---\nname: server-only\ndescription: server tools only\ntools: mcp__remote\n---\nStable universe.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/dropper.md",
      "---\nname: dropper\ndescription: no remote tools\ndisallowedTools: mcp__remote\n---\nStable universe.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/resource-list.md",
      "---\nname: resource-list\ndescription: list resources only\ntools: ListMcpResourcesTool\n---\nList resources.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/resource-read.md",
      "---\nname: resource-read\ndescription: read resources only\ntools: ReadMcpResourceTool\n---\nRead resources.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/resource-drop-read.md",
      "---\nname: resource-drop-read\ndescription: inherit except resource reads\ndisallowedTools: ReadMcpResourceTool\n---\nDo not read resources.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/resource-drop-list.md",
      "---\nname: resource-drop-list\ndescription: inherit except resource lists\ndisallowedTools: ListMcpResourcesTool\n---\nDo not list resources.\n",
    );
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);

    const catalog: McpToolInfo[] = [
      { serverName: "remote", toolName: "echo", description: "echo", inputSchema: { type: "object" } },
      { serverName: "remote", toolName: "search", description: "search", inputSchema: { type: "object" } },
    ];
    let state: McpLifecycleState = "connected";
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const readResource = vi.fn(async () => ({ contents: [{ uri: "test:", text: "resource" }] }));
    const runtime: Runtime = {
      whenSettled: async () => {},
      tools: () => catalog,
      prompts: () => [],
      resourceServers: () => [{ serverName: "remote", resources: [{ serverName: "remote", uri: "test:", name: "test" }] }],
      getPrompt: async () => { throw new Error("unreachable"); },
      readResource,
      callTool,
      diagnostics: () => [],
      serverStates: () => [{ name: "remote", transport: "http", state }],
      shutdown: async () => {},
    };
    let liveExecution: Promise<void> | undefined;
    const handle = fakeSdk({ onPrompt: async (prompt, session) => {
      if (prompt === "connected") {
        liveExecution = (async () => {
          await session.customTools.find((tool) => tool.name === "mcp__remote__echo")!
            .execute("remote-call", { text: "dispatch-local" });
          await session.customTools.find((tool) => tool.name === "ListMcpResourcesTool")!
            .execute("resource-list", {});
          await session.customTools.find((tool) => tool.name === "ReadMcpResourceTool")!
            .execute("resource-read", { server: "remote", uri: "test:" });
        })();
        await liveExecution;
      }
      return "DONE";
    } });
    const pi = fakePi();
    let internals!: Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];
    try {
      picc(pi.api as never, {
        mcpRuntime: runtime,
        sdk: handle.sdk,
        onWired: (wired) => { internals = wired; },
        onInitializationSettled: pi.captureInitialization,
      });
      await pi.waitForInitialization();
      await pi.waitForTools([
        "Agent",
        "mcp__remote__echo",
        "mcp__remote__search",
        "ListMcpResourcesTool",
        "ReadMcpResourceTool",
      ]);
      internals.subagentRuntime.setSdkForTest(handle.sdk);
      const mainEcho = pi.tools.get("mcp__remote__echo");
      const expected = ["mcp__remote__echo", "mcp__remote__search"];
      const childEchoes: unknown[] = [];
      const childResourceLists: unknown[] = [];
      const childResourceReads: unknown[] = [];

      for (const lifecycle of ["connected", "reconnecting", "failed"] as const) {
        state = lifecycle;
        await pi.tools.get("Agent").execute(`dispatch-${lifecycle}`, {
          subagent_type: "inheritor",
          prompt: lifecycle,
          run_in_background: false,
        });
        const created = handle.created.at(-1)!;
        const remoteTools = (created.customTools as FakeCustomTool[])
          .filter((tool) => tool.name.startsWith("mcp__remote__"));
        expect(remoteTools.map((tool) => tool.name).sort(), lifecycle).toEqual(expected);
        expect((created.tools as string[]).filter((name) => name.startsWith("mcp__remote__")).sort(), lifecycle)
          .toEqual(expected);
        const childEcho = remoteTools.find((tool) => tool.name === "mcp__remote__echo");
        expect(childEcho).not.toBe(mainEcho);
        childEchoes.push(childEcho);
        const childResourceList = (created.customTools as FakeCustomTool[])
          .find((tool) => tool.name === "ListMcpResourcesTool");
        expect(childResourceList).toBeDefined();
        expect(childResourceList).not.toBe(pi.tools.get("ListMcpResourcesTool"));
        childResourceLists.push(childResourceList);
        const childResourceRead = (created.customTools as FakeCustomTool[])
          .find((tool) => tool.name === "ReadMcpResourceTool");
        expect(childResourceRead).toBeDefined();
        expect(childResourceRead).not.toBe(pi.tools.get("ReadMcpResourceTool"));
        childResourceReads.push(childResourceRead);
      }
      await liveExecution;
      expect(callTool).toHaveBeenCalledWith("remote", "echo", { text: "dispatch-local" });
      expect(readResource).toHaveBeenCalledWith("remote", "test:");
      expect(new Set(childEchoes).size).toBe(3);
      expect(new Set(childResourceLists).size).toBe(3);
      expect(new Set(childResourceReads).size).toBe(3);
      expect(pi.tools.get("mcp__remote__echo")).toBe(mainEcho);

      await pi.tools.get("Agent").execute("dispatch-server-only", {
        subagent_type: "server-only", prompt: "failed", run_in_background: false,
      });
      expect((handle.created.at(-1)!.customTools as FakeCustomTool[]).map((tool) => tool.name).sort())
        .toEqual(expected);
      await pi.tools.get("Agent").execute("dispatch-dropper", {
        subagent_type: "dropper", prompt: "failed", run_in_background: false,
      });
      expect((handle.created.at(-1)!.customTools as FakeCustomTool[])
        .some((tool) => tool.name.startsWith("mcp__remote__"))).toBe(false);

      for (const [agent, expectedResource] of [
        ["resource-list", "ListMcpResourcesTool"],
        ["resource-read", "ReadMcpResourceTool"],
      ] as const) {
        await pi.tools.get("Agent").execute(`dispatch-${agent}`, {
          subagent_type: agent, prompt: agent, run_in_background: false,
        });
        expect((handle.created.at(-1)!.customTools as FakeCustomTool[]).map((tool) => tool.name))
          .toEqual([expectedResource]);
      }
      for (const [agent, retained, dropped] of [
        ["resource-drop-read", "ListMcpResourcesTool", "ReadMcpResourceTool"],
        ["resource-drop-list", "ReadMcpResourceTool", "ListMcpResourcesTool"],
      ] as const) {
        await pi.tools.get("Agent").execute(`dispatch-${agent}`, {
          subagent_type: agent, prompt: agent, run_in_background: false,
        });
        const names = (handle.created.at(-1)!.customTools as FakeCustomTool[])
          .map((tool) => tool.name);
        expect(names).toContain(retained);
        expect(names).not.toContain(dropped);
      }

      const beforeBackground = handle.created.length;
      await pi.tools.get("Agent").execute("dispatch-background", {
        subagent_type: "inheritor", prompt: "background", run_in_background: true,
      });
      await waitUntil({
        description: "background child session creation",
        predicate: () => handle.created.length > beforeBackground,
        describeObserved: () => String(handle.created.length),
      });
      const backgroundNames = (handle.created.at(-1)!.customTools as FakeCustomTool[])
        .map((tool) => tool.name);
      expect(backgroundNames).not.toContain("ListMcpResourcesTool");
      expect(backgroundNames).not.toContain("ReadMcpResourceTool");
      expect(backgroundNames).toContain("mcp__remote__echo");

      const parent = SessionManager.create(dir, dir, { id: "mcp-parent" });
      parent.appendMessage({ role: "user", content: "parent" } as never);
      parent.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
      await pi.fire("session_start", {}, pi.ctx({
        sessionManager: { getSessionFile: () => parent.getSessionFile() },
      }));
      await pi.tools.get("Agent").execute("dispatch-fork-foreground", {
        subagent_type: "fork", prompt: "fork foreground", run_in_background: false,
      });
      const foregroundForkNames = (handle.created.at(-1)!.customTools as FakeCustomTool[])
        .map((tool) => tool.name);
      expect(foregroundForkNames).toEqual(expect.arrayContaining([
        "ListMcpResourcesTool", "ReadMcpResourceTool", "mcp__remote__echo",
      ]));

      const beforeDefaultFork = handle.created.length;
      await pi.tools.get("Agent").execute("dispatch-fork-default-background", {
        subagent_type: "fork", prompt: "fork default background",
      });
      await waitUntil({
        description: "default-background conversation fork child creation",
        predicate: () => handle.created.length > beforeDefaultFork,
        describeObserved: () => String(handle.created.length),
      });
      const defaultForkNames = (handle.created.at(-1)!.customTools as FakeCustomTool[])
        .map((tool) => tool.name);
      expect(defaultForkNames).toEqual(expect.arrayContaining([
        "ListMcpResourcesTool", "ReadMcpResourceTool", "mcp__remote__echo",
      ]));
    } finally {
      await pi.fire("session_shutdown", { reason: "other" }, pi.printCtx());
      process.chdir(originalCwd);
      if (savedForkGate === undefined) delete process.env.CLAUDE_CODE_FORK_SUBAGENT;
      else process.env.CLAUDE_CODE_FORK_SUBAGENT = savedForkGate;
    }
  }, 30_000);
});

describe("subagent fixed resource restrictions", () => {
  type Runtime = NonNullable<PiccTestSeam["mcpRuntime"]>;
  const resourceNames = ["ListMcpResourcesTool", "ReadMcpResourceTool"] as const;

  function resourceRuntime(): Runtime {
    return {
      whenSettled: async () => {},
      tools: () => [],
      prompts: () => [],
      resourceServers: () => [{ serverName: "fixture", resources: [] }],
      getPrompt: async () => ({ messages: [] }),
      readResource: async () => ({ contents: [] }),
      callTool: async () => ({ content: [] }),
      diagnostics: () => [],
      serverStates: () => [{
        name: "fixture", transport: "stdio", state: "connected",
        resourcesAdvertised: true, resourceCount: 0,
      }],
      shutdown: async () => {},
    };
  }

  async function childTools(options: {
    deny?: string;
    agents: Record<string, string>;
    dispatch: readonly string[];
  }): Promise<string[][]> {
    const dir = makeTempDir("picc-resource-restrict-");
    const userDir = makeTempDir("picc-resource-restrict-user-");
    writeProjectFile(dir, "CLAUDE.md", "RESOURCE-RESTRICTION\n");
    if (options.deny) {
      writeProjectFile(dir, ".claude/settings.json", JSON.stringify({
        permissions: { deny: [options.deny] },
      }));
    }
    for (const [name, frontmatter] of Object.entries(options.agents)) {
      writeProjectFile(dir, `.claude/agents/${name}.md`, `---\nname: ${name}\ndescription: ${name}\n${frontmatter}---\nRestricted child.\n`);
    }
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    const handle = fakeSdk({ onPrompt: async () => "DONE" });
    const pi = fakePi();
    let internals!: Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];
    try {
      picc(pi.api as never, {
        mcpRuntime: resourceRuntime(),
        sdk: handle.sdk,
        onWired: (wired) => { internals = wired; },
        onInitializationSettled: pi.captureInitialization,
      });
      await pi.waitForInitialization();
      await pi.waitForTools([
        "Agent",
        ...resourceNames.filter((name) => name !== options.deny),
      ]);
      internals.subagentRuntime.setSdkForTest(handle.sdk);
      const rows: string[][] = [];
      for (const agent of options.dispatch) {
        await pi.tools.get("Agent").execute(`dispatch-${agent}`, {
          subagent_type: agent, prompt: agent, run_in_background: false,
        });
        rows.push((handle.created.at(-1)!.customTools as FakeCustomTool[]).map((tool) => tool.name));
      }
      return rows;
    } finally {
      await pi.fire("session_shutdown", { reason: "other" }, pi.printCtx());
      process.chdir(originalCwd);
    }
  }

  it.each(resourceNames)("an exact settings deny for %s removes only that fixed resource name from a child", async (denied) => {
    const [names] = await childTools({
      deny: denied,
      agents: { inheritor: "" },
      dispatch: ["inheritor"],
    });
    expect(names).not.toContain(denied);
    expect(names).toContain(resourceNames.find((name) => name !== denied));
  }, 30_000);

  it("runs a captured production resource call through the dispatch guard's session and agent hooks", async () => {
    const dir = makeTempDir("picc-resource-guard-");
    const userDir = makeTempDir("picc-resource-guard-user-");
    writeProjectFile(dir, "CLAUDE.md", "RESOURCE-GUARD\n");
    writeProjectFile(dir, ".claude/settings.json", JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "session-resource-pre-must-not-launch" }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "session-resource-post-must-not-launch" }] }],
      },
    }));
    writeProjectFile(dir, ".claude/agents/resource-guard.md", [
      "---", "name: resource-guard", "description: guarded resources", "hooks:",
      "  PreToolUse:", "    - hooks:", "        - type: command", "          command: agent-resource-pre-must-not-launch",
      "  PostToolUse:", "    - hooks:", "        - type: command", "          command: agent-resource-post-must-not-launch",
      "---", "Guard resources.", "",
    ].join("\n"));
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    const loaderOptions: Array<Record<string, unknown>> = [];
    const hookCalls: string[] = [];
    const hookSpy = vi.spyOn(HookRunner.prototype, "fire").mockImplementation(async function (this: HookRunner, eventName) {
      const config = JSON.stringify((this as unknown as { opts: { config: unknown } }).opts.config);
      const owner = config.includes("agent-resource") ? "agent" : "session";
      if (eventName === "PreToolUse" || eventName === "PostToolUse") hookCalls.push(`${owner}:${eventName}`);
      return { block: false, askDowngraded: false, diagnostics: [] };
    });
    let exercised = false;
    const handle = fakeSdk({ onPrompt: async (_text, session) => {
      const factory = (loaderOptions.at(-1)!.extensionFactories as Array<{ name: string; factory: (pi: unknown) => unknown }>)
        .find((candidate) => candidate.name.startsWith("picc-guard-"))!;
      type GuardHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
      const handlers = new Map<string, GuardHandler>();
      factory.factory({ on: (name: string, handler: GuardHandler) => { handlers.set(name, handler); }, sendMessage: () => {} });
      const resource = session.customTools.find((tool) => tool.name === "ListMcpResourcesTool")!;
      const input = { server: "fixture" };
      const admitted = await handlers.get("tool_call")!({ toolName: resource.name, toolCallId: "resource", input }, {});
      expect(admitted?.block).not.toBe(true);
      const result = await resource.execute("resource", input);
      await handlers.get("tool_result")!({
        toolName: resource.name, toolCallId: "resource", input, content: result.content, isError: false,
      }, {});
      exercised = true;
      return "RESOURCE-GUARD-DONE";
    } });
    const pi = fakePi();
    let internals!: Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];
    try {
      picc(pi.api as never, {
        mcpRuntime: resourceRuntime(), sdk: handle.sdk,
        onWired: (wired) => { internals = wired; },
        onInitializationSettled: pi.captureInitialization,
      });
      await pi.waitForInitialization();
      await pi.waitForTools(["Agent", ...resourceNames]);
      internals.subagentRuntime.setSdkForTest({
        ...handle.sdk,
        DefaultResourceLoader: class {
          constructor(options: Record<string, unknown>) { loaderOptions.push(options); }
          async reload(): Promise<void> {}
        },
      });
      await pi.tools.get("Agent").execute("resource-guard", {
        subagent_type: "resource-guard", prompt: "exercise", run_in_background: false,
      });
      expect(exercised).toBe(true);
      expect(hookCalls).toEqual(expect.arrayContaining([
        "session:PreToolUse", "agent:PreToolUse", "session:PostToolUse", "agent:PostToolUse",
      ]));
    } finally {
      hookSpy.mockRestore();
      await pi.fire("session_shutdown", { reason: "other" }, pi.printCtx());
      process.chdir(originalCwd);
    }
  }, 30_000);

  it("empty and unrelated tools: child rows receive no fixed resource tools", async () => {
    const [emptyNames, unrelatedNames] = await childTools({
      agents: {
        empty: "tools: []\n",
        unrelated: "tools: Read\n",
      },
      dispatch: ["empty", "unrelated"],
    });
    for (const names of [emptyNames, unrelatedNames]) {
      expect(names).not.toContain("ListMcpResourcesTool");
      expect(names).not.toContain("ReadMcpResourceTool");
    }
    expect(emptyNames).toEqual([]);
    expect(unrelatedNames).toContain("read");
  }, 30_000);
});

describe("deferred first typed fork MCP settlement", () => {
  type Runtime = NonNullable<PiccTestSeam["mcpRuntime"]>;

  it("waits for exposure before snapshotting the fork's resources and existing MCP proxy", async () => {
    const dir = makeTempDir("picc-mcp-typed-fork-");
    const userDir = makeTempDir("picc-mcp-typed-fork-user-");
    writeProjectFile(dir, "CLAUDE.md", "MCP-TYPED-FORK\n");
    writeProjectFile(dir, ".claude/skills/fork-mcp/SKILL.md", [
      "---", "name: fork-mcp", "description: fork after MCP settlement", "context: fork", "---",
      "Use the settled MCP surface for $ARGUMENTS.", "",
    ].join("\n"));
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    const settled = deferred<void>();
    const runtime: Runtime = {
      whenSettled: () => settled.promise,
      tools: () => [{ serverName: "fixture", toolName: "echo", description: "echo", inputSchema: { type: "object" } }],
      prompts: () => [],
      resourceServers: () => [{ serverName: "fixture", resources: [] }],
      getPrompt: async () => ({ messages: [] }), readResource: async () => ({ contents: [] }),
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      diagnostics: () => [],
      serverStates: () => [{ name: "fixture", transport: "stdio", state: "connecting" }],
      shutdown: async () => {},
    };
    const handle = fakeSdk({ onPrompt: async () => "FORK-DONE" });
    const localPi = fakePi();
    try {
      picc(localPi.api as never, {
        mcpRuntime: runtime,
        sdk: handle.sdk,
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      const input = localPi.fire("input", {
        source: "user", text: "/fork-mcp inspect",
      }, localPi.printCtx());
      await Promise.resolve();
      expect(handle.created).toHaveLength(0);
      settled.resolve();
      const result = await input;
      expect(result).toMatchObject({ action: "transform" });
      expect(result.text).toContain("FORK-DONE");
      await waitUntil({
        description: "typed context fork child creation after MCP settlement",
        predicate: () => handle.created.length === 1,
        describeObserved: () => String(handle.created.length),
      });
      const names = (handle.created[0]!.customTools as FakeCustomTool[]).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "mcp__fixture__echo", "ListMcpResourcesTool", "ReadMcpResourceTool",
      ]));
    } finally {
      settled.resolve();
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
      process.chdir(originalCwd);
    }
  }, 30_000);
});

describe("subagent MCP tool provisioning (wired)", () => {
  type Internals = Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];
  type ExtensionFactory = { name: string; factory: (pi: unknown) => unknown };

  let dir: string;
  let fixture: McpProcessFixture;
  let pi: FakePi;
  let handle: FakeSdkHandle;
  let internals: Internals;
  // Options of every DefaultResourceLoader the dispatch path constructs — the
  // fake loader never RUNS extensionFactories, so tests that need the child
  // guard invoke the captured factory themselves (see the deny test below).
  const loaderOptions: Array<Record<string, unknown>> = [];
  const childPrompts: string[] = [];
  let backgroundWarningVisibleBeforePrompt = false;
  let livePinToolResult = "";
  let runGuardProof: ((session: { customTools: FakeCustomTool[] }) => Promise<void>) | undefined;

  const FIXTURE_TOOLS = [
    "mcp__fixture__echo",
    "mcp__fixture__report-env",
    "mcp__fixture__big-output",
  ];

  beforeAll(async () => {
    dir = makeTempDir("picc-mcpsub-");
    fixture = createMcpProcessFixture(makeTempDir("picc-mcpsub-fx-"));
    writeProjectFile(dir, "CLAUDE.md", "MCP-SUB-PROJECT\n");
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "PiCC Test"], { cwd: dir });
    writeProjectFile(
      dir,
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: fixture.nodeCommand,
            args: [fixture.serverScript, "serve"],
            env: fixture.env,
          },
        },
      }),
    );
    // The denied server name is deliberately NOT a configured server: the BARE
    // deny grammar this feature specs also removes the tool from context at
    // gating, so for those rules a call-time block on a granted tool never
    // fires — the scenario here is the model hallucinating a denied name.
    // The guard is still a real backstop for granted tools: specifier'd denies
    // (e.g. `mcp__s__t(key:value)`) deliberately do NOT remove at gating, and
    // skill-activation deny rules arrive after dispatch-time gating.
    writeProjectFile(
      dir,
      ".claude/settings.json",
      JSON.stringify({
        permissions: { deny: ["mcp__denied", "mcp__fixture__echo(text:secret*)"] },
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "session-pre-must-not-launch" }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: "session-post-must-not-launch" }] }],
          PostToolUseFailure: [{ hooks: [{ type: "command", command: "session-failure-must-not-launch" }] }],
        },
      }),
    );
    writeProjectFile(
      dir,
      ".claude/agents/inheritor.md",
      [
        "---", "name: inheritor", "description: inherits every tool", "hooks:",
        "  PreToolUse:", "    - hooks:", "        - type: command", "          command: agent-pre-must-not-launch",
        "  PostToolUse:", "    - hooks:", "        - type: command", "          command: agent-post-must-not-launch",
        "  PostToolUseFailure:", "    - hooks:", "        - type: command", "          command: agent-failure-must-not-launch",
        "---", "You inherit.", "",
      ].join("\n"),
    );
    writeProjectFile(
      dir,
      ".claude/agents/reader.md",
      "---\nname: reader\ndescription: read-only\ntools: Read\n---\nYou read.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/fixture-only.md",
      "---\nname: fixture-only\ndescription: MCP server only\ntools: mcp__fixture\n---\nYou call MCP.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/dropper.md",
      "---\nname: dropper\ndescription: drops the fixture server\ndisallowedTools: mcp__fixture\n---\nYou dropped MCP.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/pending-inline.md",
      [
        "---", "name: pending-inline", "description: degraded inline setup", "mcpServers:",
        "  - pending-server:", `      command: ${JSON.stringify(fixture.nodeCommand)}`,
        `      args: [${JSON.stringify(fixture.serverScript)}, serve]`,
        "---", "PENDING-WARNING-SENTINEL", "",
      ].join("\n"),
    );
    writeProjectFile(
      dir,
      ".claude/agents/inline-owner.md",
      [
        "---",
        "name: inline-owner",
        "description: owns an isolated inline server",
        "mcpServers:",
        "  - inline:",
        `      command: ${JSON.stringify(fixture.nodeCommand)}`,
        `      args: [${JSON.stringify(fixture.serverScript)}, spawn-grandchild]`,
        "      env:",
        `        MCP_BARRIER_DIR: ${JSON.stringify(fixture.dir)}`,
        "---",
        "Use the inline server.",
        "",
      ].join("\n"),
    );
    const userDir = makeTempDir("picc-mcpsub-user-");
    // Approval from a user-authored scope — project scope cannot self-approve.
    writeProjectFile(userDir, "settings.json", JSON.stringify({ enabledMcpjsonServers: ["fixture", "inline"] }));
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: dir, stdio: "ignore" });
    process.chdir(dir);

    handle = fakeSdk({
      stats: { tokens: { input: 7, output: 3 }, cost: 0.01 },
      onPrompt: async (text, session) => {
        childPrompts.push(text);
        if (text.includes("PENDING-WARNING")) {
          backgroundWarningVisibleBeforePrompt = internals?.backgroundTasks.ids().some((id) =>
            internals.backgroundTasks.get(id)?.lastActivity?.startsWith("Agent MCP availability warning:")) ?? false;
        }
        if (text.includes("GUARD-PROOF")) {
          await runGuardProof?.(session as unknown as { customTools: FakeCustomTool[] });
          return "GUARD-DONE";
        }
        if (text.includes("ENTER-WORKTREE-PIN")) {
          const enter = session.customTools.find((tool) => tool.name === "EnterWorktree");
          if (!enter) return "NO-ENTER-WORKTREE";
          const result = await enter.execute("enter-pin", { name: "mcp-pin-proof" });
          livePinToolResult = (result.content as Array<{ text?: string }>).map((entry) => entry.text ?? "").join("\n");
          return "PIN-DONE";
        }
        if (text.includes("CALL-ECHO")) {
          // In-subagent round-trip: the dispatched session calls its OWN MCP
          // proxy instance, which delegates to the session-global runtime.
          const echo = session.customTools.find((t) => t.name === "mcp__fixture__echo");
          if (!echo) return "NO-ECHO-TOOL";
          const result = await echo.execute("sub-call", { text: "sub-round-trip" });
          return `ECHOED:${result.content[0]?.text ?? ""}`;
        }
        return "SUB-DONE";
      },
    });
    pi = fakePi();
    picc(pi.api as never, {
      onWired: (i) => (internals = i),
      onInitializationSettled: pi.captureInitialization,
    });
    await pi.waitForInitialization();
    // Loader-capturing SDK override: identical to the shared fake except that
    // each dispatch's DefaultResourceLoader options (extensionFactories
    // included) are recorded for the guard test.
    const capturingSdk: PiSdk = {
      ...handle.sdk,
      DefaultResourceLoader: class {
        constructor(options: Record<string, unknown>) {
          loaderOptions.push(options);
        }
        async reload(): Promise<void> {}
      },
    };
    internals.subagentRuntime.setSdkForTest(capturingSdk);
    // The MCP settle barrier: once the proxies are registered, the runtime has
    // settled, so dispatch-time gating sees the connected server's names.
    await pi.waitForTools(["Agent", ...FIXTURE_TOOLS]);
  }, 30_000);

  afterAll(async () => {
    process.chdir(originalCwd);
    try {
      await pi.fire("session_shutdown", { reason: "other" }, pi.printCtx());
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  async function dispatch(subagentType: string, prompt: string) {
    const agentTool = pi.tools.get("Agent");
    return agentTool.execute(`dispatch-${subagentType}`, {
      subagent_type: subagentType,
      prompt,
      run_in_background: false,
    });
  }

  function lastCustomToolNames(): string[] {
    const created = handle.created.at(-1)!;
    return (created.customTools as FakeCustomTool[]).map((t) => t.name);
  }

  it("an unspecified-tools: agent inherits the MCP proxies and calls one through the shared runtime", async () => {
    const result = await dispatch("inheritor", "CALL-ECHO now");
    const text = (result.content as Array<{ text?: string }>)
      .map((c) => String(c.text ?? ""))
      .join("\n");
    expect(text).toContain("ECHOED:sub-round-trip");

    const created = handle.created.at(-1)!;
    const custom = lastCustomToolNames();
    expect(custom).toEqual(expect.arrayContaining(FIXTURE_TOOLS));
    // The session `tools:` allowlist carries the MCP names too — Pi filters
    // customTools by that list, so an absent name would drop the proxy.
    expect(created.tools as string[]).toEqual(expect.arrayContaining(FIXTURE_TOOLS));
    // No name of the denied server ever reaches a dispatch.
    expect(custom.filter((n) => n.startsWith("mcp__denied"))).toEqual([]);
  });

  it("threads one canonical degraded-setup warning through the child prompt and foreground/background model surfaces", async () => {
    const foreground = await dispatch("pending-inline", "PENDING-WARNING foreground");
    const foregroundText = (foreground.content as Array<{ text?: string }>).map((entry) => entry.text ?? "").join("\n");
    const warning = "Agent MCP availability warning: \"pending-server\" needs project approval in user settings; approve it and restart the agent.";
    expect(foregroundText).toContain(warning);
    expect(childPrompts.at(-1)).toContain(warning);
    expect((foreground.details as { diagnostics?: Array<{ message: string }> }).diagnostics
      ?.filter((diagnostic) => diagnostic.message === warning)).toHaveLength(1);

    const accepted = await pi.tools.get("Agent").execute("pending-background", {
      subagent_type: "pending-inline", prompt: "PENDING-WARNING background", run_in_background: true,
    });
    const taskId = (accepted.details as { taskId: string }).taskId;
    await internals.backgroundTasks.wait(taskId);
    expect(backgroundWarningVisibleBeforePrompt).toBe(true);
    const task = internals.backgroundTasks.get(taskId)!;
    expect(task.lastActivity).toBe(warning);
    expect(task.diagnostics.filter((diagnostic) => diagnostic.message === warning)).toHaveLength(1);
    const taskOutput = pi.tools.get("TaskOutput");
    const output = await taskOutput.execute("pending-output", { task_id: taskId });
    const canonicalText = (output.content as Array<{ text?: string }>).map((entry) => entry.text ?? "").join("\n");
    expect(canonicalText).toContain(warning);
    expect(canonicalText).toMatch(/\nusage:/u);
    const expanded = taskOutput.renderResult!(
      output, { expanded: true, isPartial: false }, undefined,
      { args: { task_id: taskId }, isError: false, state: {} },
    ).render(200).join("\n");
    expect(expanded).toContain("SUB-DONE");
    expect(expanded.match(/Agent MCP availability warning:/gu)).toHaveLength(1);
    expect(expanded.match(/in 7/gu)).toHaveLength(1);
    expect(expanded).not.toMatch(/\nusage:/u);
  });

  it("starts an inline stdio scope only for its owner and closes its process tree before return", async () => {
    expect(pi.tools.has("mcp__inline__echo")).toBe(false);
    const result = await dispatch("inline-owner", "ENTER-WORKTREE-PIN inline isolated run");
    expect((result.content as Array<{ text?: string }>).map((entry) => entry.text ?? "").join("\n"))
      .toContain("PIN-DONE");
    expect(livePinToolResult).toContain("Scoped MCP stdio");
    expect(livePinToolResult).toContain("pinned to its launch directory");
    expect(livePinToolResult).toMatch(/restart the agent/iu);
    const pinDiagnostics = (result.details as { diagnostics?: Array<{ message: string }> }).diagnostics ?? [];
    const retainedPinWarnings = pinDiagnostics.filter((diagnostic) => diagnostic.message.includes("pinned to its launch directory"));
    expect(retainedPinWarnings).toHaveLength(1);
    expect(livePinToolResult).toContain(retainedPinWarnings[0]!.message);
    const ownerTools = lastCustomToolNames();
    expect(ownerTools).toContain("mcp__inline__echo");
    await fixture.waitFor(["spawn-grandchild.pid", "grandchild.pid"], "inline MCP process tree publication");
    const inlinePids = [fixture.pidOf("spawn-grandchild.pid"), fixture.pidOf("grandchild.pid")];
    await waitUntil({
      description: "inline MCP process tree to close before dispatch settlement",
      predicate: () => inlinePids.every((pid) => !processIsAlive(pid)),
      describeObserved: () => `alive=${inlinePids.filter(processIsAlive).join(",")}`,
    });

    await dispatch("inheritor", "unrelated sibling");
    expect(lastCustomToolNames()).not.toContain("mcp__inline__echo");
    expect(pi.tools.has("mcp__inline__echo")).toBe(false);
  });

  it("a tools: [Read] agent receives no MCP tool (restriction), while its granted built-in survives", async () => {
    await dispatch("reader", "restricted run");
    const custom = lastCustomToolNames();
    expect(custom.some((n) => n.startsWith("mcp__"))).toBe(false);
    // Non-vacuous: the dispatch really provisioned tools — the granted Read
    // built-in (Pi name "read") is present.
    expect(custom).toContain("read");
  });

  it("a bare tools: mcp__fixture grant fans out to exactly the server's tools", async () => {
    await dispatch("fixture-only", "server-scoped run");
    const custom = lastCustomToolNames();
    expect([...custom].sort()).toEqual([...FIXTURE_TOOLS].sort());
  });

  it("disallowedTools: mcp__fixture removes every fixture tool from an otherwise-inheriting agent", async () => {
    await dispatch("dropper", "dropped run");
    const custom = lastCustomToolNames();
    expect(custom.some((n) => n.startsWith("mcp__"))).toBe(false);
    // The drop was surgical: the rest of the inherited surface stays.
    expect(custom).toContain("read");
    expect(custom).toContain("bash");
  });

  it("runs captured dispatch-local proxy calls through session-plus-agent guard hooks without launching hook processes", async () => {
    const hookCalls: string[] = [];
    const hookSpy = vi.spyOn(HookRunner.prototype, "fire").mockImplementation(async function (this: HookRunner, eventName, payload) {
      const config = JSON.stringify((this as unknown as { opts: { config: unknown } }).opts.config);
      const owner = config.includes("agent-") ? "agent" : "session";
      if (eventName === "PreToolUse" || eventName === "PostToolUse" || eventName === "PostToolUseFailure") {
        hookCalls.push(`${owner}:${eventName}`);
      }
      const input = payload.tool_input as Record<string, unknown> | undefined;
      if (eventName === "PreToolUse" && owner === "session" && input?.text === "rewrite") {
        return { block: false, askDowngraded: false, diagnostics: [], updatedInput: { text: "secret-after-hook" } };
      }
      if (eventName === "PreToolUse" && owner === "agent" && input?.text === "hook-deny") {
        return { block: true, blockReason: "agent hook denied", askDowngraded: false, diagnostics: [] };
      }
      if (eventName === "PreToolUse" && owner === "session" && input?.text === "timeout") {
        return {
          block: false, askDowngraded: false,
          diagnostics: [{ severity: "warning", message: "session hook timed out safely" }],
        };
      }
      return { block: false, askDowngraded: false, diagnostics: [] };
    });
    try {
      runGuardProof = async (session) => {
      const factories = loaderOptions.at(-1)!.extensionFactories as ExtensionFactory[];
      const guard = factories.find((factory) => factory.name.startsWith("picc-guard-"));
      expect(guard).toBeDefined();

      type GuardHandler = (
        event: Record<string, unknown>,
        ctx: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | undefined>;
      const handlers = new Map<string, GuardHandler>();
      guard!.factory({
        on: (name: string, handler: GuardHandler) => { handlers.set(name, handler); },
        sendMessage: () => {},
      });
      const toolCall = handlers.get("tool_call")!;
      const toolResult = handlers.get("tool_result")!;
      const tools = session.customTools;
      const echo = tools.find((tool) => tool.name === "mcp__fixture__echo")!;
      let transportCalls = 0;

      const bareDenied = await toolCall({ toolName: "mcp__denied__slow", toolCallId: "deny-1", input: {} }, {});
      expect(bareDenied).toMatchObject({ block: true });

      const rewritten = await toolCall({
        toolName: echo.name, toolCallId: "rewrite-1", input: { text: "rewrite" },
      }, {});
      expect(rewritten).toMatchObject({ block: true });
      expect(transportCalls).toBe(0);

      const hookDenied = await toolCall({
        toolName: echo.name, toolCallId: "hook-deny-1", input: { text: "hook-deny" },
      }, {});
      expect(hookDenied).toMatchObject({ block: true });
      expect(String(hookDenied?.reason)).toContain("agent hook denied");
      expect(transportCalls).toBe(0);

      for (const [id, text] of [["allow-1", "ok"], ["timeout-1", "timeout"]] as const) {
        const allowed = await toolCall({ toolName: echo.name, toolCallId: id, input: { text } }, {});
        expect(allowed?.block).not.toBe(true);
        transportCalls += 1;
        const result = await echo.execute(id, { text });
        await toolResult({
          toolName: echo.name, toolCallId: id, input: { text }, content: result.content, isError: false,
        }, {});
      }

      await toolResult({
        toolName: echo.name, toolCallId: "failure-1", input: { text: "failed" },
        content: [{ type: "text", text: "failed" }], isError: true,
      }, {});

      expect(transportCalls).toBe(2);
      for (const eventName of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
        expect(hookCalls).toContain(`session:${eventName}`);
        expect(hookCalls).toContain(`agent:${eventName}`);
      }
      expect(tools.map((tool) => tool.name)).toContain(echo.name);
      };
      const guarded = await dispatch("inheritor", "GUARD-PROOF run");
      expect((guarded.content as Array<{ text?: string }>)[0]?.text).toContain("GUARD-DONE");
    } finally {
      runGuardProof = undefined;
      hookSpy.mockRestore();
    }
  });
});

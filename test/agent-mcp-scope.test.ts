import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgentMcpScope,
  type AgentMcpRuntimeSource,
  type OwnedAgentMcpRuntime,
} from "../src/runtime/agent-mcp.js";
import {
  McpRuntime,
  type McpCleanupOutcome,
  type McpServerState,
  type McpToolInfo,
} from "../src/runtime/mcp.js";
import type {
  AgentMcpDeclaration,
  EnabledStdioAgentMcpServer,
  ResolvedAgentMcpConfig,
  ResolvedAgentMcpServer,
} from "../src/types.js";
import { deferred } from "./helpers/async.js";
import { createMcpProcessFixture } from "./helpers/mcp-process.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcx-agent-mcp-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(code ?? "")) {
        throw error;
      }
    }
  }
});

function cleanup(confirmed: readonly string[] = [], unconfirmed: readonly string[] = []): McpCleanupOutcome {
  return { confirmed, unconfirmed, diagnostics: unconfirmed.length ? ["cleanup uncertain"] : [] };
}

function tool(serverName: string, toolName: string): McpToolInfo {
  return { serverName, toolName, description: `${toolName} description`, inputSchema: { type: "object" } };
}

function fakeRuntime(options: {
  names?: string[];
  tools?: McpToolInfo[];
  resources?: Array<{ serverName: string; uri: string }>;
  calls?: string[];
  callGate?: Promise<unknown>;
  callError?: Error;
  shutdownOutcome?: McpCleanupOutcome;
  retryOutcome?: McpCleanupOutcome;
  shutdownGate?: Promise<void>;
  states?: McpServerState[];
  diagnostics?: string[];
} = {}): OwnedAgentMcpRuntime & { shutdownCalls: number; retryCalls: number } {
  const names = options.names ?? [];
  const tools = options.tools ?? [];
  const resources = options.resources ?? [];
  const resourceCatalog = resources.map((entry) => ({
    serverName: entry.serverName,
    resources: [{ serverName: entry.serverName, uri: entry.uri, name: entry.uri }],
  }));
  const calls = options.calls ?? [];
  return {
    shutdownCalls: 0,
    retryCalls: 0,
    whenSettled: async () => {},
    tools: () => tools,
    resourceServers: () => resourceCatalog,
    serverStates: () => options.states ?? names.map((name) => ({ name, transport: "stdio", state: "connected" })),
    diagnostics: () => options.diagnostics ?? [],
    async callTool(serverName, toolName) {
      calls.push(`tool:${serverName}:${toolName}`);
      if (options.callError) throw options.callError;
      return options.callGate ?? { content: [{ type: "text", text: `${serverName}:${toolName}` }] };
    },
    async readResource(serverName, uri) {
      calls.push(`resource:${serverName}:${uri}`);
      return { contents: [{ uri, text: serverName }] };
    },
    async shutdown() { this.shutdownCalls += 1; },
    async shutdownAgent() {
      this.shutdownCalls += 1;
      await options.shutdownGate;
      return options.shutdownOutcome ?? cleanup(names);
    },
    async retryAgentShutdown(serverNames) {
      this.retryCalls += 1;
      return options.retryOutcome ?? cleanup(serverNames);
    },
  };
}

function inlineServer(name: string): EnabledStdioAgentMcpServer {
  return {
    name,
    source: "subagent-inline",
    status: "enabled",
    transport: "stdio",
    command: process.execPath,
    args: [],
    env: {},
    rawCommand: "node",
    diagnostics: [],
  };
}

function config(...servers: ResolvedAgentMcpServer[]): ResolvedAgentMcpConfig {
  return { servers, diagnostics: [], diagnosticOwnership: [] };
}

function declaration(...items: Array<{ kind: "reference" | "inline"; name: string }>): Pick<AgentMcpDeclaration, "items"> {
  return { items: items as unknown as AgentMcpDeclaration["items"] };
}

const deps = { projectRoot: "/canonical", spawnCwd: "/dispatch", sessionId: "agent-test", env: {} };

describe("agent MCP scope composition", () => {
  it("inherits the settled session universe when omitted and reuses explicit references without starts", async () => {
    const calls: string[] = [];
    const session = fakeRuntime({ names: ["alpha", "beta"], tools: [tool("alpha", "a"), tool("beta", "b")], calls });
    const startInline = vi.fn();
    const inherited = await createAgentMcpScope({ sessionRuntime: session, inlineConfig: config(), inlineDeps: deps, startInline });
    expect(inherited.knownToolNames()).toEqual(["mcp__alpha__a", "mcp__beta__b"]);

    const referenced = await createAgentMcpScope({
      sessionRuntime: session,
      declaration: declaration(
        { kind: "reference", name: "beta" },
        { kind: "reference", name: "beta" },
        { kind: "reference", name: "missing" },
      ),
      inlineConfig: config(), inlineDeps: deps, startInline,
    });
    await referenced.callTool("beta", "b", {});
    await expect(referenced.callTool("alpha", "a", {})).rejects.toThrow("not available");
    expect(calls).toEqual(["tool:beta:b"]);
    expect(referenced.diagnostics()).toEqual([expect.stringContaining("missing")]);
    expect(referenced.setupOutcomes()).toEqual([{ serverName: "missing", kind: "missing-reference" }]);
    expect(startInline).not.toHaveBeenCalled();
  });

  it("inherits only for omitted or clean-empty declarations and fails malformed-empty closed", async () => {
    const session = fakeRuntime({ names: ["shared"], tools: [tool("shared", "read")] });
    const cleanEmpty = await createAgentMcpScope({
      sessionRuntime: session,
      declaration: { items: [], diagnostics: [] },
      inlineConfig: config(), inlineDeps: deps,
    });
    expect(cleanEmpty.knownToolNames()).toEqual(["mcp__shared__read"]);

    const malformedEmpty = await createAgentMcpScope({
      sessionRuntime: session,
      declaration: { items: [], diagnostics: ["redacted malformed item"] },
      inlineConfig: { servers: [], diagnostics: ["redacted malformed item"], diagnosticOwnership: [{ kind: "unowned" }] }, inlineDeps: deps,
    });
    expect(malformedEmpty.knownToolNames()).toEqual([]);
    await expect(malformedEmpty.callTool("shared", "read", {})).rejects.toThrow("not available");
  });

  it.each([
    "enabled", "blocked", "pending-approval", "disabled", "invalid",
  ] as const)("lets a published session route quietly win an inline %s collision", async (status) => {
    const session = fakeRuntime({ names: ["same"], tools: [tool("same", "borrowed")] });
    const startInline = vi.fn();
    const server = { ...inlineServer("same"), status } as ResolvedAgentMcpConfig["servers"][number];
    const scope = await createAgentMcpScope({
      sessionRuntime: session,
      declaration: declaration({ kind: "inline", name: "same" }),
      inlineConfig: config(server), inlineDeps: deps, startInline,
    });
    expect(scope.knownToolNames()).toEqual(["mcp__same__borrowed"]);
    expect(scope.borrowedServerNames?.()).toEqual(["same"]);
    expect(scope.activeOwnedStdioServerNames?.()).toEqual([]);
    expect(scope.diagnostics()).toEqual([]);
    expect(scope.setupOutcomes()).toEqual([]);
    expect(startInline).not.toHaveBeenCalled();
  });

  it("suppresses only exact collision-owned admission findings in retained scope diagnostics", async () => {
    const scope = await createAgentMcpScope({
      sessionRuntime: fakeRuntime({ names: ["command"], tools: [tool("command", "borrowed")] }),
      declaration: declaration({ kind: "inline", name: "command" }),
      inlineConfig: {
        servers: [inlineServer("command")],
        diagnostics: ["opaque collision finding", "opaque malformed sibling"],
        diagnosticOwnership: [
          { kind: "server", serverName: "command" },
          { kind: "unowned", itemIndex: 1 },
        ],
      },
      inlineDeps: deps,
      startInline: vi.fn(),
    });

    expect(scope.diagnostics()).toEqual([
      "An admitted agent MCP definition produced a redacted setup diagnostic.",
    ]);
  });

  it("combines copied immutable tool/resource catalogs and routes both operation families consistently", async () => {
    const sessionCalls: string[] = [];
    const inlineCalls: string[] = [];
    const schema = { type: "object", properties: { nested: { type: "string" } } };
    const sessionTools: McpToolInfo[] = [{ ...tool("borrowed", "read"), inputSchema: schema }];
    const localStates: McpServerState[] = [{ name: "local", transport: "stdio", state: "connected" }];
    const owned = fakeRuntime({
      names: ["local"], tools: [tool("local", "write")], states: localStates,
      resources: [{ serverName: "local", uri: "local://one" }], calls: inlineCalls,
    });
    const session = fakeRuntime({
      names: ["borrowed"], tools: sessionTools,
      resources: [{ serverName: "borrowed", uri: "borrowed://one" }], calls: sessionCalls,
    });
    const sessionResourceCatalog = session.resourceServers();
    const scope = await createAgentMcpScope({
      sessionRuntime: session,
      declaration: declaration({ kind: "reference", name: "borrowed" }, { kind: "inline", name: "local" }),
      inlineConfig: config(inlineServer("local")), inlineDeps: deps, startInline: () => owned,
    });
    sessionTools.push(tool("borrowed", "late-reconnect-widening"));
    schema.properties.nested.type = "number";
    (sessionResourceCatalog[0]!.resources[0] as { uri: string }).uri = "borrowed://mutated";
    expect(scope.knownToolNames()).toEqual([
      "mcp__borrowed__read", "mcp__local__write", "ListMcpResourcesTool", "ReadMcpResourceTool",
    ]);
    expect(Object.isFrozen(scope.tools())).toBe(true);
    expect(Object.isFrozen(scope.tools()[0])).toBe(true);
    expect(Object.isFrozen(scope.tools()[0]?.inputSchema)).toBe(true);
    expect(Object.isFrozen((scope.tools()[0]?.inputSchema as { properties: object }).properties)).toBe(true);
    expect((scope.tools()[0]?.inputSchema as typeof schema).properties.nested.type).toBe("string");
    expect(Object.isFrozen(scope.resourceServers())).toBe(true);
    expect(Object.isFrozen(scope.resourceServers()[0])).toBe(true);
    expect(Object.isFrozen(scope.resourceServers()[0]?.resources)).toBe(true);
    expect(Object.isFrozen(scope.resourceServers()[0]?.resources[0])).toBe(true);
    expect(scope.resourceServers()[0]?.resources[0]?.uri).toBe("borrowed://one");
    expect(scope.activeOwnedStdioServerNames?.()).toEqual(["local"]);
    localStates[0] = { name: "local", transport: "stdio", state: "failed" };
    expect(scope.activeOwnedStdioServerNames?.()).toEqual([]);
    localStates[0] = { name: "local", transport: "stdio", state: "connected" };
    await scope.callTool("borrowed", "read", {});
    await scope.callTool("local", "write", {});
    await scope.readResource("borrowed", "borrowed://one");
    await scope.readResource("local", "local://one");
    expect(sessionCalls).toEqual(["tool:borrowed:read", "resource:borrowed:borrowed://one"]);
    expect(inlineCalls).toEqual(["tool:local:write", "resource:local:local://one"]);
  });

  it("retains failed-owned setup state without routing it and projects routed state transitions live", async () => {
    const sessionStates: McpServerState[] = [{ name: "borrowed", transport: "http", state: "connected" }];
    const failedStates: McpServerState[] = [{
      name: "failed-local",
      transport: "stdio",
      state: "failed",
      diagnostic: "RAW_ERROR_SECRET",
      statusSummary: "MCP startup failed during connection, initialization, or capability discovery; run /doctor for details.",
    }];
    const session = fakeRuntime({ tools: [tool("borrowed", "read")], states: sessionStates });
    const owned = fakeRuntime({
      states: failedStates,
      diagnostics: ["STDERR_SECRET CONFIG_SECRET"],
    });
    const scope = await createAgentMcpScope({
      sessionRuntime: session,
      declaration: declaration(
        { kind: "reference", name: "borrowed" },
        { kind: "inline", name: "failed-local" },
      ),
      inlineConfig: config(inlineServer("failed-local")), inlineDeps: deps, startInline: () => owned,
    });

    expect(scope.setupOutcomes()).toEqual([{
      serverName: "failed-local",
      kind: "inline-startup-failed",
    }]);
    expect(scope.activeOwnedStdioServerNames?.()).toEqual([]);
    expect(scope.diagnostics().join(" ")).toContain("failed-local");
    expect(scope.diagnostics().join(" ")).not.toMatch(/RAW_ERROR_SECRET|STDERR_SECRET|CONFIG_SECRET/u);
    expect(scope.serverStates()).toHaveLength(2);
    expect(scope.serverStates()[1]?.statusSummary).toBe(
      "Agent MCP server failed during startup or discovery. Review the server logs. If repairing configuration, run the canonical /reload in the interactive TUI or exit and relaunch PiCC, then make a fresh Agent dispatch; otherwise retry a transient failure with a fresh Agent dispatch.",
    );
    expect(JSON.stringify(scope.serverStates())).not.toMatch(/RAW_ERROR_SECRET|\/doctor/u);
    expect(Object.isFrozen(scope.serverStates())).toBe(true);
    expect(Object.isFrozen(scope.serverStates()[0])).toBe(true);
    await expect(scope.callTool("failed-local", "anything", {})).rejects.toThrow("not available");

    sessionStates[0] = { name: "borrowed", transport: "http", state: "reconnecting", attempt: 2 };
    failedStates[0] = { name: "failed-local", transport: "stdio", state: "failed", attempt: 3 };
    expect(scope.serverStates()).toEqual([
      expect.objectContaining({ name: "borrowed", state: "reconnecting", attempt: 2 }),
      expect.objectContaining({ name: "failed-local", state: "failed", attempt: 3 }),
    ]);
  });

  it("keeps previously published failed inline catalogs routed with live terminal errors", async () => {
    const ownedStates: McpServerState[] = [{
      name: "published-then-failed",
      transport: "http",
      state: "failed",
      toolsAdvertised: true,
      resourcesAdvertised: true,
      toolCount: 1,
      resourceCount: 1,
      diagnostic: "RAW_REMOTE_SECRET",
      statusSummary: "RAW_OWNED_STATUS_SECRET /doctor " + "x".repeat(2_000),
    }];
    const owned = fakeRuntime({
      tools: [tool("published-then-failed", "retained")],
      resources: [{ serverName: "published-then-failed", uri: "retained://resource" }],
      states: ownedStates,
      diagnostics: ["RAW_RUNTIME_DIAGNOSTIC_SECRET"],
      callError: new Error("terminal remote call error"),
    });
    const scope = await createAgentMcpScope({
      sessionRuntime: fakeRuntime(),
      declaration: declaration({ kind: "inline", name: "published-then-failed" }),
      inlineConfig: config(inlineServer("published-then-failed")), inlineDeps: deps, startInline: () => owned,
    });

    expect(scope.setupOutcomes()).toEqual([]);
    expect(scope.knownToolNames()).toEqual([
      "mcp__published-then-failed__retained", "ListMcpResourcesTool", "ReadMcpResourceTool",
    ]);
    expect(scope.serverStates()).toEqual([expect.objectContaining({
      name: "published-then-failed",
      state: "failed",
      statusSummary: "Previously published agent MCP capabilities are unavailable. Review the server logs. If repairing configuration, run the canonical /reload in the interactive TUI or exit and relaunch PiCC, then make a fresh Agent dispatch; otherwise retry a transient failure with a fresh Agent dispatch.",
    })]);
    expect(JSON.stringify(scope.serverStates())).not.toMatch(/RAW_REMOTE_SECRET|RAW_OWNED_STATUS_SECRET|\/doctor/u);
    expect(scope.diagnostics()).toContain("Agent MCP runtime produced additional redacted diagnostics.");
    expect(scope.diagnostics().join(" ")).not.toContain("RAW_RUNTIME_DIAGNOSTIC_SECRET");
    await expect(scope.callTool("published-then-failed", "retained", {})).rejects.toThrow("terminal remote call error");
  });

  it("bounds and freezes setup outcomes, diagnostics, identities, and live status projections", async () => {
    const hostileNames = Array.from({ length: 140 }, (_, index) =>
      `identity-${index}-\u0000\u001b]52;SECRET\u0007-${"z".repeat(260)}`);
    const sessionStates: McpServerState[] = [{
      name: `borrowed-\u0000-${"n".repeat(260)}`,
      transport: "http",
      state: "failed",
      toolsAdvertised: true,
      statusSummary: `visible-prefix\u0000\u001b]52;STATUS_SECRET\u0007-${"s".repeat(1_000)}`,
    }];
    const scope = await createAgentMcpScope({
      sessionRuntime: fakeRuntime({ states: sessionStates }),
      declaration: declaration(
        { kind: "reference", name: sessionStates[0]!.name },
        ...hostileNames.map((name) => ({ kind: "reference" as const, name })),
      ),
      inlineConfig: {
        servers: [],
        diagnostics: Array.from({ length: 140 }, () => "RAW_CONFIG_SECRET" + "d".repeat(1_000)),
        diagnosticOwnership: Array.from({ length: 140 }, () => ({ kind: "unowned" as const })),
      },
      inlineDeps: deps,
    });

    const outcomes = scope.setupOutcomes();
    const diagnostics = scope.diagnostics();
    expect(outcomes).toHaveLength(128);
    expect(Object.isFrozen(outcomes)).toBe(true);
    expect(outcomes.every((outcome) => Object.isFrozen(outcome))).toBe(true);
    expect(outcomes.every((outcome) => outcome.serverName.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(outcome.serverName))).toBe(true);
    expect(diagnostics).toHaveLength(128);
    expect(diagnostics.at(-1)).toBe("Additional agent MCP diagnostics were omitted.");
    expect(diagnostics.every((diagnostic) => diagnostic.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(diagnostic))).toBe(true);
    expect(diagnostics.join(" ")).not.toContain("RAW_CONFIG_SECRET");
    expect(Object.isFrozen(diagnostics)).toBe(true);
    const projected = scope.serverStates()[0]!;
    expect(projected.name).toHaveLength(200);
    expect(projected.statusSummary).toHaveLength(512);
    expect(projected.statusSummary?.endsWith("…")).toBe(true);
    expect(projected.statusSummary).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("isolates same-named sibling inline runtimes and leaves parent/global sources unchanged", async () => {
    const parentTools: McpToolInfo[] = [];
    const session = fakeRuntime({ tools: parentTools });
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const first = fakeRuntime({ names: ["local"], tools: [tool("local", "first")], calls: firstCalls });
    const second = fakeRuntime({ names: ["local"], tools: [tool("local", "second")], calls: secondCalls });
    const options = { sessionRuntime: session, declaration: declaration({ kind: "inline", name: "local" }), inlineConfig: config(inlineServer("local")), inlineDeps: deps };
    const firstScope = await createAgentMcpScope({ ...options, startInline: () => first });
    const secondScope = await createAgentMcpScope({ ...options, startInline: () => second });
    await firstScope.callTool("local", "first", {});
    await secondScope.callTool("local", "second", {});
    expect(firstScope.knownToolNames()).toEqual(["mcp__local__first"]);
    expect(secondScope.knownToolNames()).toEqual(["mcp__local__second"]);
    expect(firstCalls).toEqual(["tool:local:first"]);
    expect(secondCalls).toEqual(["tool:local:second"]);
    expect(parentTools).toEqual([]);
  });
});

describe("agent MCP scope ownership and races", () => {
  it("never closes borrowed handles and awaits exactly one owned shutdown across concurrent callers", async () => {
    const session = fakeRuntime({ names: ["borrowed"] });
    const owned = fakeRuntime({ names: ["local"] });
    const scope = await createAgentMcpScope({
      sessionRuntime: session,
      declaration: declaration({ kind: "reference", name: "borrowed" }, { kind: "inline", name: "local" }),
      inlineConfig: config(inlineServer("local")), inlineDeps: deps, startInline: () => owned,
    });
    const [first, second] = await Promise.all([scope.shutdown(), scope.shutdown()]);
    expect(first).toEqual(cleanup(["local"]));
    expect(second).toBe(first);
    expect(owned.shutdownCalls).toBe(1);
    expect(session.shutdownCalls).toBe(0);
  });

  it("reports bounded identity-only uncertainty and permits one idempotent retry", async () => {
    const secret = "SECRET_COMMAND_URL_HEADER_ENV_OUTPUT";
    const owned = fakeRuntime({
      names: ["local"],
      shutdownOutcome: { confirmed: [], unconfirmed: ["local"], diagnostics: [`uncertain ${secret}`] },
      retryOutcome: cleanup(["local"]),
    });
    const scope = await createAgentMcpScope({
      sessionRuntime: fakeRuntime(), declaration: declaration({ kind: "inline", name: "local" }),
      inlineConfig: config(inlineServer("local")), inlineDeps: deps, startInline: () => owned,
    });
    const outcome = await scope.shutdown();
    expect(outcome.unconfirmed).toEqual(["local"]);
    expect(outcome.diagnostics.join(" ")).not.toContain(secret);
    expect(outcome.diagnostics).toEqual(["Cleanup could not be confirmed for 1 agent MCP server(s)."]);
    const [retried, sameRetry] = await Promise.all([scope.retryUnconfirmedShutdown(), scope.retryUnconfirmedShutdown()]);
    expect(retried).toEqual(cleanup(["local"]));
    expect(sameRetry).toBe(retried);
    expect(owned.retryCalls).toBe(1);
  });

  it("starts and awaits shared shutdown when retry is requested first or concurrently", async () => {
    const gate = deferred<void>();
    const owned = fakeRuntime({
      names: ["local"],
      shutdownGate: gate.promise,
      shutdownOutcome: cleanup([], ["local"]),
      retryOutcome: cleanup(["local"]),
    });
    const scope = await createAgentMcpScope({
      sessionRuntime: fakeRuntime(), declaration: declaration({ kind: "inline", name: "local" }),
      inlineConfig: config(inlineServer("local")), inlineDeps: deps, startInline: () => owned,
    });

    const retry = scope.retryUnconfirmedShutdown();
    const concurrentShutdown = scope.shutdown();
    expect(owned.shutdownCalls).toBe(1);
    expect(owned.retryCalls).toBe(0);
    gate.resolve();
    await expect(retry).resolves.toEqual(cleanup(["local"]));
    await expect(concurrentShutdown).resolves.toEqual({
      confirmed: [],
      unconfirmed: ["local"],
      diagnostics: ["Cleanup could not be confirmed for 1 agent MCP server(s)."],
    });
    expect(owned.shutdownCalls).toBe(1);
    expect(owned.retryCalls).toBe(1);
    expect(scope.retryUnconfirmedShutdown()).toBe(retry);
  });

  it("closes admission synchronously so post-shutdown and late in-flight calls cannot revive the scope", async () => {
    const gate = deferred<unknown>();
    const owned = fakeRuntime({ names: ["local"], tools: [tool("local", "slow")], callGate: gate.promise });
    const scope = await createAgentMcpScope({
      sessionRuntime: fakeRuntime(), declaration: declaration({ kind: "inline", name: "local" }),
      inlineConfig: config(inlineServer("local")), inlineDeps: deps, startInline: () => owned,
    });
    const inFlight = scope.callTool("local", "slow", {});
    const shuttingDown = scope.shutdown();
    await expect(scope.callTool("local", "slow", {})).rejects.toThrow("shut down");
    gate.resolve({ content: [] });
    await expect(inFlight).rejects.toThrow("shut down during");
    await shuttingDown;
    expect(scope.knownToolNames()).toEqual(["mcp__local__slow"]);
  });
});

describe("agent MCP local runtime cwd", () => {
  it("passes spawn cwd independently while explicit server env keeps last-wins precedence", async () => {
    let transportOptions: Record<string, unknown> | undefined;
    class FakeTransport {
      readonly pid = undefined;
      readonly stderr = undefined;
      constructor(options: Record<string, unknown>) { transportOptions = options; }
    }
    class FakeClient {
      async connect(): Promise<void> {}
      async listTools(): Promise<{ tools: never[] }> { return { tools: [] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.startAgent(config({
      ...inlineServer("data-only"),
      env: { CLAUDE_PROJECT_DIR: "/explicit-override" },
    }), {
      projectRoot: "/canonical-root",
      spawnCwd: "/dispatch-cwd",
      sessionId: "agent-env-test",
      env: {},
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    });
    await runtime.whenSettled();
    expect(transportOptions?.cwd).toBe("/dispatch-cwd");
    expect((transportOptions?.env as Record<string, string>).CLAUDE_PROJECT_DIR).toBe("/explicit-override");
    await runtime.shutdownAgent();
  });

  it("launches stdio in dispatch cwd while injecting the canonical CLAUDE_PROJECT_DIR", async () => {
    const canonicalRoot = tempDir();
    const spawnCwd = tempDir();
    const fixture = createMcpProcessFixture(tempDir());
    const evidencePath = path.join(fixture.dir, "cwd-evidence.json");
    const bootstrap = [
      "const fs = await import('node:fs');",
      `fs.writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({cwd:process.cwd(),root:process.env.CLAUDE_PROJECT_DIR}));`,
      `await import(${JSON.stringify(pathToFileURL(fixture.serverScript).href)});`,
    ].join("");
    const runtime = McpRuntime.startAgent(config({
      ...inlineServer("cwd"),
      command: process.execPath,
      args: ["--input-type=module", "-e", bootstrap, "unused", "serve"],
      env: fixture.env,
    }), {
      projectRoot: canonicalRoot,
      spawnCwd,
      sessionId: "agent-cwd-test",
      env: {},
    });
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()[0]?.state).toBe("connected");
      expect(JSON.parse(fs.readFileSync(evidencePath, "utf8"))).toEqual({ cwd: spawnCwd, root: canonicalRoot });
    } finally {
      await runtime.shutdownAgent();
      await fixture.cleanup();
    }
  });
});

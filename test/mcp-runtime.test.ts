import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  McpRuntime,
  resolveMcpTimeoutPolicy,
  resolveMcpToolTimeoutMs,
  type McpRuntimeDeps,
} from "../src/runtime/mcp.js";
import type { McpRuntimeAdmission } from "../src/runtime/mcp-control.js";
import { createMcpAdministrationService } from "../src/mcp-administration/service.js";
import type { McpAdministrationDeclaration } from "../src/mcp-administration/model.js";
import { renderMcpStatusReport } from "../src/registry/compat-report.js";
import type { EnabledStdioMcpServer, ResolvedAgentMcpConfig, ResolvedMcpConfig, ResolvedMcpServer } from "../src/types.js";
import { deferred, waitUntil } from "./helpers/async.js";
import { createMcpProcessFixture, processIsAlive } from "./helpers/mcp-process.js";
import { createMcpRemoteServer } from "./helpers/mcp-remote-server.js";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcx-mcp-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeServer(
  over: Partial<EnabledStdioMcpServer> & { name: string; status?: "enabled" },
): EnabledStdioMcpServer;
function makeServer(
  over: { name: string; status: "pending-approval" | "disabled" | "skipped" | "not-configured" },
): ResolvedMcpServer;
function makeServer(over: Record<string, unknown> & { name: string }): ResolvedMcpServer {
  if (over.status !== undefined && over.status !== "enabled") {
    return {
      name: over.name,
      status: over.status as "pending-approval" | "disabled" | "skipped" | "not-configured",
      source: "project-mcpjson",
      transport: "stdio",
      diagnostics: [],
    };
  }
  return {
    status: "enabled",
    source: "project-mcpjson",
    transport: "stdio",
    command: process.execPath,
    args: [],
    env: {},
    rawCommand: "node",
    diagnostics: [],
    ...over,
  };
}

function makeRemoteServer(
  over: Partial<Extract<ResolvedMcpServer, { status: "enabled"; transport: "http" | "sse" }>> & { name: string },
): Extract<ResolvedMcpServer, { status: "enabled"; transport: "http" | "sse" }> {
  const { name, ...rest } = over;
  return {
    status: "enabled",
    source: "project-mcpjson",
    transport: "http",
    configuredType: "http",
    url: "https://REMOTE_URL_CANARY.example/mcp",
    headers: { Authorization: "REMOTE_HEADER_CANARY" },
    diagnostics: [],
    ...rest,
    name,
  };
}

function makeBlockedServer(name: string, transport: "stdio" | "http"): ResolvedMcpServer {
  return {
    name,
    status: "blocked",
    source: "settings-user",
    transport,
    ...(transport === "http" ? { configuredType: "http" as const } : {}),
    inactiveReason: "policy-denied",
    diagnostics: [],
  };
}

function makeConfig(...servers: ResolvedMcpServer[]): ResolvedMcpConfig {
  return { servers, diagnostics: [] };
}

/**
 * process.env minus the MCP knobs: an ambient MCP_TIMEOUT/MCP_TOOL_TIMEOUT in
 * the developer's shell must not steer any row — rows that need them set them
 * explicitly.
 */
function cleanBaseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["MCP_TIMEOUT"];
  delete env["MCP_TOOL_TIMEOUT"];
  return env;
}

/** Deps with a clean process.env base; extras override (setting a key to undefined removes it). */
function makeDeps(over: Partial<McpRuntimeDeps> = {}): McpRuntimeDeps {
  return {
    projectRoot: makeTempDir(),
    sessionId: "mcp-test-session",
    env: cleanBaseEnv(),
    ...over,
  };
}

/** First text content block of a callTool result. */
function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const block = content?.find((c) => c.type === "text");
  return block?.text ?? "";
}

async function waitForDeath(pid: number, what: string): Promise<void> {
  await waitUntil({
    description: `${what} (pid ${pid}) to die`,
    predicate: () => !processIsAlive(pid),
    describeObserved: () => `pid ${pid} alive=${processIsAlive(pid)}`,
    timeoutMs: 10_000,
  });
}

const CONTROL_DIGEST_A = `mcp-review-v1:${"a".repeat(64)}`;
const CONTROL_DIGEST_B = `mcp-review-v1:${"b".repeat(64)}`;
const CONTROL_DIGEST_C = `mcp-review-v1:${"c".repeat(64)}`;
const CONTROL_DIGEST_D = `mcp-review-v1:${"d".repeat(64)}`;
const CONTROL_DIGEST_E = `mcp-review-v1:${"e".repeat(64)}`;

async function controlAdmission(
  name: string,
  digest = CONTROL_DIGEST_A,
  over: Partial<EnabledStdioMcpServer> = {},
): Promise<McpRuntimeAdmission> {
  const server = makeServer({ name, ...over });
  const declaration: McpAdministrationDeclaration = {
    name,
    source: server.source,
    authority: { kind: "mutable", scope: "project" },
    precedence: "winner",
    definitionVersion: 1,
    definitionDigest: digest,
    summary: { transport: "stdio", commandBasename: "node", argumentCount: server.args.length, environmentKeyCount: Object.keys(server.env).length, headerKeyCount: 0, timeoutConfigured: false },
    policy: "allowed",
    review: "approved-exact",
    status: "enabled",
  };
  let admission: McpRuntimeAdmission | undefined;
  const state = {
    reviewIdentity: { profileKey: "profile", checkoutFamilyKey: "family" },
    mcp: {
      servers: [server], diagnostics: [],
      administration: { version: 1 as const, policyPosture: "absent" as const, observations: [], declarations: [declaration], omittedDeclarationCount: 0 },
    },
    liveStates: [{ name, state: "failed" as const }],
  };
  const service = createMcpAdministrationService({
    inspectPending: async () => ({ pending: false, status: "clear" as const }),
    recover: async () => ({ state: "rolled-back", operationId: "none", effect: "unchanged", cleanup: "complete", retrySafe: true }),
    mutate: async () => ({ state: "committed", effect: "unchanged", cleanup: "complete", retrySafe: true }),
    assemble: () => state,
    live: { apply: async (request) => {
      admission = request.runtimeAdmission;
      return { runtime: { state: "succeeded" }, exposure: { state: "succeeded" } };
    } },
  });
  await service.execute({ kind: "reconnect", name });
  if (!admission) throw new Error("test admission was not minted");
  return admission;
}

async function remoteControlAdmission(name: string, digest = CONTROL_DIGEST_A): Promise<McpRuntimeAdmission> {
  const server = makeRemoteServer({ name });
  const declaration: McpAdministrationDeclaration = {
    name, source: server.source, authority: { kind: "mutable", scope: "project" }, precedence: "winner",
    definitionVersion: 1, definitionDigest: digest,
    summary: { transport: "http", remoteOrigin: "https://example.test", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 1, timeoutConfigured: false },
    policy: "allowed", review: "approved-exact", status: "enabled",
  };
  let admission: McpRuntimeAdmission | undefined;
  const state = {
    reviewIdentity: { profileKey: "profile", checkoutFamilyKey: "family" },
    mcp: { servers: [server], diagnostics: [], administration: { version: 1 as const, policyPosture: "absent" as const, observations: [], declarations: [declaration], omittedDeclarationCount: 0 } },
    liveStates: [{ name, state: "failed" as const }],
  };
  const service = createMcpAdministrationService({
    inspectPending: async () => ({ pending: false, status: "clear" as const }),
    recover: async () => ({ state: "rolled-back", operationId: "none", effect: "unchanged", cleanup: "complete", retrySafe: true }),
    mutate: async () => ({ state: "committed", effect: "unchanged", cleanup: "complete", retrySafe: true }),
    assemble: () => state,
    live: { apply: async (request) => { admission = request.runtimeAdmission; return { runtime: { state: "succeeded" }, exposure: { state: "succeeded" } }; } },
  });
  await service.execute({ kind: "reconnect", name });
  if (!admission) throw new Error("test remote admission was not minted");
  return admission;
}

function fakeToolSdk(options: {
  forwardedTimeouts: number[];
  callError?: unknown;
}): Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>> {
  class FakeTransport {
    readonly pid = undefined;
    readonly stderr = undefined;
    constructor(_options: unknown) {}
  }
  class FakeClient {
    constructor(_clientInfo: unknown, _options: unknown) {}
    async connect(_transport: unknown): Promise<void> {}
    async listTools(_params: unknown): Promise<{ tools: Array<{ name: string }> }> {
      return { tools: [{ name: "fake-tool" }] };
    }
    async callTool(
      _params: unknown,
      _resultSchema: unknown,
      requestOptions: { timeout: number },
    ): Promise<{ content: never[] }> {
      options.forwardedTimeouts.push(requestOptions.timeout);
      if (options.callError !== undefined) throw options.callError;
      return { content: [] };
    }
    async close(): Promise<void> {}
  }
  return {
    Client: FakeClient,
    StdioClientTransport: FakeTransport,
  } as unknown as Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>>;
}

// ---------------------------------------------------------------------------
// Generation-safe live control
// ---------------------------------------------------------------------------

describe("McpRuntime live control", () => {
  it("reconciles fresh authority, coalesces duplicate starts, retires routes before cleanup, and reuses an immutable catalog", async () => {
    const closeGate = deferred<void>();
    let clients = 0;
    let lists = 0;
    let notificationHandlers = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      constructor() { clients += 1; }
      async connect(): Promise<void> {}
      setNotificationHandler(): void { notificationHandlers += 1; }
      getServerCapabilities() { return { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true } }; }
      async listTools() { lists += 1; return { tools: [{ name: "controlled", description: "first", inputSchema: { type: "object" } }] }; }
      async listPrompts() { lists += 1; return { prompts: [{ name: "prompt", description: "first", arguments: [] }] }; }
      async listResources() { lists += 1; return { resources: [{ uri: "file:///one", name: "resource" }] }; }
      async callTool() { return { content: [] }; }
      async close(): Promise<void> { await closeGate.promise; }
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    try {
      const admission = await controlAdmission("live", CONTROL_DIGEST_A, {
        command: "EXPANDED_COMMAND_CANARY",
        args: ["ARG_CANARY"],
        env: { TOKEN: "ENV_CANARY" },
        rawCommand: "RAW_COMMAND_CANARY",
      });
      const separatelyMintedAdmission = await controlAdmission("live", CONTROL_DIGEST_A, {
        command: "EXPANDED_COMMAND_CANARY",
        args: ["ARG_CANARY"],
        env: { TOKEN: "ENV_CANARY" },
        rawCommand: "RAW_COMMAND_CANARY",
      });
      const [first, duplicate] = await Promise.all([
        runtime.reconcileServer(admission),
        runtime.reconcileServer(separatelyMintedAdmission),
      ]);
      expect(first).toMatchObject({ state: "succeeded", cleanup: "not-required" });
      expect(first.deltas).toEqual([expect.objectContaining({
        serverName: "live", definitionFingerprint: CONTROL_DIGEST_A, generation: 1, kind: "publish",
        tools: [expect.objectContaining({ wireDefinitionFingerprint: expect.stringMatching(/^mcp-wire-v1:[a-f0-9]{64}$/u) })],
        prompts: [expect.objectContaining({ wireDefinitionFingerprint: expect.stringMatching(/^mcp-wire-v1:[a-f0-9]{64}$/u) })],
        resourceServer: expect.objectContaining({ wireDefinitionFingerprint: expect.stringMatching(/^mcp-wire-v1:[a-f0-9]{64}$/u) }),
      })]);
      expect(duplicate).toBe(first);
      expect({ clients, lists, notificationHandlers }).toEqual({ clients: 1, lists: 3, notificationHandlers: 0 });
      await expect(runtime.reconcileServer(await controlAdmission("live"))).resolves.toEqual({
        state: "succeeded", reason: "already-current", cleanup: "not-required", deltas: [],
      });
      expect({ clients, lists }).toEqual({ clients: 1, lists: 3 });
      for (const canary of ["EXPANDED_COMMAND_CANARY", "ARG_CANARY", "ENV_CANARY", "RAW_COMMAND_CANARY"]) {
        expect(JSON.stringify(first)).not.toContain(canary);
      }

      const disabling = runtime.disableServer("live");
      expect(runtime.tools()).toEqual([]);
      await expect(runtime.callTool("live", "controlled", {})).rejects.toThrow(/route was retired/);
      closeGate.resolve();
      const disabled = await disabling;
      expect(disabled).toMatchObject({ state: "succeeded", cleanup: "confirmed" });
      expect(disabled.deltas).toEqual([expect.objectContaining({ kind: "retire", generation: 2 })]);
      await expect(runtime.disableServer("live")).resolves.toEqual({
        state: "succeeded", reason: "already-inactive", cleanup: "not-required", deltas: [],
      });

      const enabled = await runtime.reconcileServer(admission);
      expect(enabled).toMatchObject({ state: "succeeded" });
      expect(enabled.deltas).toEqual([expect.objectContaining({ kind: "publish", generation: 3 })]);
      expect({ clients, lists, notificationHandlers }).toEqual({ clients: 2, lists: 3, notificationHandlers: 0 });
    } finally {
      closeGate.resolve();
      await runtime.shutdown();
    }
  });

  it("keeps wire fingerprints independent from admission and from sibling wire definitions", async () => {
    let clients = 0;
    let lists = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      private readonly id = clients++;
      async connect(): Promise<void> {}
      getServerCapabilities() { return { tools: {}, prompts: {}, resources: {} }; }
      async listTools() {
        lists += 1;
        const changed = this.id === 2;
        return { tools: [{ name: "tool", description: changed ? "changed-tool" : "baseline-tool", inputSchema: { type: "object", const: changed ? "changed" : "baseline" } }] };
      }
      async listPrompts() {
        lists += 1;
        const changed = this.id === 3;
        return { prompts: [{ name: "prompt", description: changed ? "changed-prompt" : "baseline-prompt", arguments: [{ name: "arg", required: changed }] }] };
      }
      async listResources() {
        lists += 1;
        return { resources: [{ uri: this.id === 4 ? "opaque:changed" : "opaque:baseline", name: "resource" }] };
      }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    const fingerprints = async (digest: string): Promise<readonly string[]> => {
      const result = await runtime.reconcileServer(await controlAdmission("fingerprints", digest));
      const publish = result.deltas.at(-1)!;
      return [
        publish.tools[0]!.wireDefinitionFingerprint,
        publish.prompts[0]!.wireDefinitionFingerprint,
        publish.resourceServer!.wireDefinitionFingerprint,
      ];
    };
    try {
      const baseline = await fingerprints(CONTROL_DIGEST_A);
      expect(new Set(baseline).size).toBe(3);

      const changedAdmissionOnly = await fingerprints(CONTROL_DIGEST_B);
      expect(changedAdmissionOnly).toEqual(baseline);

      const toolOnly = await fingerprints(CONTROL_DIGEST_C);
      expect(toolOnly.map((value, index) => value === baseline[index])).toEqual([false, true, true]);

      const promptOnly = await fingerprints(CONTROL_DIGEST_D);
      expect(promptOnly.map((value, index) => value === baseline[index])).toEqual([true, false, true]);

      const resourceOnly = await fingerprints(CONTROL_DIGEST_E);
      expect(resourceOnly.map((value, index) => value === baseline[index])).toEqual([true, true, false]);
      expect({ clients, lists }).toEqual({ clients: 5, lists: 15 });
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects forged or copied admissions before constructing any SDK client", async () => {
    let sdkLoads = 0;
    let clients = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient { constructor() { clients += 1; } }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => { sdkLoads += 1; return { Client: FakeClient, StdioClientTransport: FakeTransport } as never; },
    }));
    const authentic = await controlAdmission("opaque");
    await expect(runtime.reconcileServer({} as McpRuntimeAdmission)).resolves.toMatchObject({ reason: "definition-unavailable" });
    await expect(runtime.reconcileServer({ ...authentic } as McpRuntimeAdmission)).resolves.toMatchObject({ reason: "definition-unavailable" });
    expect({ sdkLoads, clients }).toEqual({ sdkLoads: 0, clients: 0 });
    await runtime.shutdown();
  });

  it("discovers the first catalog after initial failure, refreshes changed definitions, and isolates siblings", async () => {
    let clients = 0;
    const lists: string[] = [];
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      private readonly id = clients++;
      async connect(): Promise<void> {}
      getServerCapabilities() { return { tools: {} }; }
      async listTools() {
        lists.push(`client-${this.id}`);
        if (this.id === 0) throw Object.assign(new Error("hidden"), { code: "EACCES" });
        return { tools: [{ name: this.id === 1 ? "recovered" : "changed" }] };
      }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    try {
      const failed = await runtime.reconcileServer(await controlAdmission("one"));
      expect(failed).toMatchObject({ state: "failed", reason: "connection-failed" });
      const sibling = await runtime.reconcileServer(await controlAdmission("two"));
      expect(sibling).toMatchObject({ state: "succeeded" });
      expect(runtime.tools().map((tool) => [tool.serverName, tool.toolName])).toEqual([["two", "recovered"]]);

      const recovered = await runtime.reconnectServer(await controlAdmission("one"));
      expect(recovered).toMatchObject({ state: "succeeded" });
      expect(recovered.deltas.at(-1)).toMatchObject({ kind: "publish", definitionFingerprint: CONTROL_DIGEST_A });
      expect(runtime.tools().map((tool) => tool.serverName).sort()).toEqual(["one", "two"]);

      const changed = await runtime.reconcileServer(await controlAdmission("one", CONTROL_DIGEST_B));
      expect(changed).toMatchObject({ state: "succeeded" });
      expect(changed.deltas).toEqual([
        expect.objectContaining({ kind: "retire", definitionFingerprint: CONTROL_DIGEST_A }),
        expect.objectContaining({ kind: "publish", definitionFingerprint: CONTROL_DIGEST_B }),
      ]);
      expect(lists).toHaveLength(4);
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps reconnect fingerprint and health refusals generation-neutral", async () => {
    let clients = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      private readonly id = clients++;
      async connect(): Promise<void> { if (this.id === 0 || this.id === 2) throw new Error("refused"); }
      getServerCapabilities() { return { tools: {} }; }
      async listTools() { return { tools: [{ name: "healthy" }] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    try {
      const admission = await controlAdmission("neutral");
      await expect(runtime.reconcileServer(admission)).resolves.toMatchObject({ state: "failed", reason: "connection-failed" });
      await expect(runtime.reconnectServer(await controlAdmission("neutral", CONTROL_DIGEST_B))).resolves.toEqual({
        state: "failed", reason: "generation-stale", cleanup: "not-required", deltas: [],
      });
      const recovered = await runtime.reconnectServer(await controlAdmission("neutral"));
      expect(recovered.deltas.at(-1)).toMatchObject({ kind: "publish", generation: 1 });
      await expect(runtime.reconnectServer(await controlAdmission("neutral"))).resolves.toEqual({
        state: "failed", reason: "not-failed", cleanup: "not-required", deltas: [],
      });
      await runtime.disableServer("neutral");
      const failed = await runtime.reconcileServer(await controlAdmission("neutral"));
      expect(failed).toMatchObject({ state: "failed", reason: "connection-failed" });
      expect(failed.deltas.some((delta) => delta.kind === "publish")).toBe(false);
      expect(runtime.tools()).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("publishes no catalog when a manual reconnect connection fails", async () => {
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> { throw new Error("refused"); }
      getServerCapabilities() { return { tools: {} }; }
      async listTools() { return { tools: [{ name: "must-not-publish" }] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    try {
      await runtime.reconcileServer(await controlAdmission("manual-failure"));
      const failed = await runtime.reconnectServer(await controlAdmission("manual-failure"));
      expect(failed).toMatchObject({ state: "failed", reason: "connection-failed" });
      expect(failed.deltas.some((delta) => delta.kind === "publish")).toBe(false);
      expect(runtime.tools()).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("preserves automatic remote recovery after a generation-neutral not-failed reconnect refusal", async () => {
    let clients = 0;
    let disconnect: ((event: { kind: "abrupt-stream-failure" }) => void) | undefined;
    class FakeTransport {
      onDisconnect(next: (event: { kind: "abrupt-stream-failure" }) => void): () => void { disconnect = next; return () => { disconnect = undefined; }; }
      async abort(): Promise<void> {}
    }
    class FakeClient {
      constructor() { clients += 1; }
      async connect(): Promise<void> {}
      getServerCapabilities() { return { tools: {} }; }
      async listTools() { return { tools: [{ name: "remote" }] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadRemoteClient: async () => FakeClient as never,
      createRemoteTransport: async () => new FakeTransport() as never,
      delay: async () => {},
    }));
    try {
      await runtime.reconcileServer(await remoteControlAdmission("auto-after-refusal"));
      await expect(runtime.reconnectServer(await remoteControlAdmission("auto-after-refusal"))).resolves.toMatchObject({
        state: "failed", reason: "not-failed", deltas: [],
      });
      disconnect?.({ kind: "abrupt-stream-failure" });
      await waitUntil({ description: "remote route to auto-recover after reconnect refusal", predicate: () => clients >= 2 && runtime.serverStates()[0]?.state === "connected" });
      expect(runtime.tools().map((tool) => tool.toolName)).toEqual(["remote"]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects stale admission, blocks re-enable after uncertain cleanup, and makes shutdown win", async () => {
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> {}
      async listTools() { return { tools: [{ name: "tool" }] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      raceCleanup: async () => false,
    }));
    const valid = await controlAdmission("uncertain");
    try {
      expect(await runtime.reconcileServer({} as McpRuntimeAdmission)).toMatchObject({ state: "failed", reason: "definition-unavailable", deltas: [] });
      await runtime.reconcileServer(valid);
      const disabled = await runtime.disableServer("uncertain");
      expect(disabled).toMatchObject({ state: "failed", reason: "cleanup-unconfirmed", cleanup: "unconfirmed" });
      expect(disabled.deltas).toEqual([expect.objectContaining({ kind: "retire" })]);
      expect(await runtime.reconcileServer(valid)).toMatchObject({
        state: "failed", reason: "cleanup-unconfirmed", cleanup: "unconfirmed",
      });

      const late = await controlAdmission("late");
      const shutdown = runtime.shutdown();
      expect(await runtime.reconcileServer(late)).toMatchObject({ state: "failed", reason: "shutting-down" });
      await shutdown;
    } finally {
      await runtime.shutdown();
    }
  });

  it("disable overtakes entered stdio and remote connects without a test release", async () => {
    for (const transportKind of ["stdio", "remote"] as const) {
      const entered = deferred<void>();
      const blocked = deferred<void>();
      let closes = 0;
      class FakeTransport {
        readonly pid = undefined;
        readonly stderr = undefined;
        async abort(): Promise<void> { closes += 1; blocked.reject(new Error("aborted")); }
        onDisconnect(): void {}
      }
      class FakeClient {
        async connect(): Promise<void> { entered.resolve(); await blocked.promise; }
        async close(): Promise<void> { closes += 1; blocked.reject(new Error("closed")); }
      }
      const runtime = McpRuntime.start(makeConfig(), makeDeps(transportKind === "stdio" ? {
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      } : {
        loadRemoteClient: async () => FakeClient as never,
        createRemoteTransport: async () => new FakeTransport() as never,
      }));
      const admission = transportKind === "stdio" ? await controlAdmission("entered") : await remoteControlAdmission("entered");
      const starting = runtime.reconcileServer(admission);
      await entered.promise;
      const disabled = runtime.disableServer("entered");
      await expect(starting).resolves.toMatchObject({ state: "failed", reason: "generation-stale" });
      await expect(disabled).resolves.toMatchObject({ state: "succeeded", cleanup: "confirmed" });
      expect(closes).toBeGreaterThan(0);
      await runtime.shutdown();
    }
  });

  it("lets a newest equivalent reconcile advance past an entered reconcile and intervening disable", async () => {
    for (const transportKind of ["stdio", "remote"] as const) {
      const entered = deferred<void>();
      const blocked = deferred<void>();
      let clients = 0;
      class FakeTransport {
        readonly pid = undefined;
        readonly stderr = undefined;
        async abort(): Promise<void> { blocked.reject(new Error("aborted")); }
        onDisconnect(): void {}
      }
      class FakeClient {
        private readonly id = clients++;
        async connect(): Promise<void> {
          if (this.id === 0) {
            entered.resolve();
            await blocked.promise;
          }
        }
        getServerCapabilities() { return {}; }
        async close(): Promise<void> { if (this.id === 0) blocked.reject(new Error("closed")); }
      }
      const runtime = McpRuntime.start(makeConfig(), makeDeps(transportKind === "stdio" ? {
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      } : {
        loadRemoteClient: async () => FakeClient as never,
        createRemoteTransport: async () => new FakeTransport() as never,
      }));
      const admission = transportKind === "stdio"
        ? await controlAdmission("latest-equivalent")
        : await remoteControlAdmission("latest-equivalent");
      const first = runtime.reconcileServer(admission);
      await entered.promise;
      const disabling = runtime.disableServer("latest-equivalent");
      const latest = runtime.reconcileServer(transportKind === "stdio"
        ? await controlAdmission("latest-equivalent")
        : await remoteControlAdmission("latest-equivalent"));
      expect(latest).not.toBe(first);
      await expect(first).resolves.toMatchObject({ state: "failed", reason: "generation-stale" });
      await expect(disabling).resolves.toMatchObject({ state: "succeeded", cleanup: "confirmed" });
      await expect(latest).resolves.toMatchObject({ state: "succeeded" });
      expect(runtime.serverStates()).toEqual([expect.objectContaining({ name: "latest-equivalent", state: "connected" })]);
      expect(clients).toBe(2);
      await runtime.shutdown();
    }
  });

  it("makes the newest A win after an entered A then B then A", async () => {
    const entered = deferred<void>();
    const blocked = deferred<void>();
    let clients = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      private readonly id = clients++;
      async connect(): Promise<void> {
        if (this.id === 0) {
          entered.resolve();
          await blocked.promise;
        }
      }
      getServerCapabilities() { return {}; }
      async close(): Promise<void> { if (this.id === 0) blocked.reject(new Error("closed")); }
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    const firstA = runtime.reconcileServer(await controlAdmission("aba", CONTROL_DIGEST_A));
    await entered.promise;
    const middleB = runtime.reconcileServer(await controlAdmission("aba", CONTROL_DIGEST_B));
    const latestA = runtime.reconcileServer(await controlAdmission("aba", CONTROL_DIGEST_A));
    expect(latestA).not.toBe(firstA);
    await expect(firstA).resolves.toEqual({
      state: "failed", reason: "generation-stale", cleanup: "not-required", deltas: [],
    });
    await expect(middleB).resolves.toEqual({
      state: "failed", reason: "generation-stale", cleanup: "confirmed", deltas: [],
    });
    const latestResult = await latestA;
    expect(latestResult).toEqual({
      state: "succeeded",
      cleanup: "confirmed",
      deltas: [expect.objectContaining({
        kind: "publish", definitionFingerprint: CONTROL_DIGEST_A, generation: 1,
      })],
    });
    expect(clients).toBe(2);
    await runtime.shutdown();
  });

  it("disable overtakes entered stdio and remote manual reconnects without a test release", async () => {
    for (const transportKind of ["stdio", "remote"] as const) {
      const entered = deferred<void>();
      const blocked = deferred<void>();
      let clients = 0;
      const initialFailures = 1;
      class FakeTransport {
        readonly pid = undefined;
        readonly stderr = undefined;
        async abort(): Promise<void> {}
        onDisconnect(): void {}
      }
      class FakeClient {
        private readonly id = clients++;
        async connect(): Promise<void> {
          if (this.id < initialFailures) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
          entered.resolve();
          await blocked.promise;
        }
        async close(): Promise<void> { if (this.id >= initialFailures) blocked.reject(new Error("closed")); }
      }
      const runtime = McpRuntime.start(makeConfig(), makeDeps(transportKind === "stdio" ? {
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      } : {
        loadRemoteClient: async () => FakeClient as never,
        createRemoteTransport: async () => new FakeTransport() as never,
        delay: async () => {},
      }));
      const admission = transportKind === "stdio" ? await controlAdmission("entered-reconnect") : await remoteControlAdmission("entered-reconnect");
      await expect(runtime.reconcileServer(admission)).resolves.toMatchObject({ state: "failed", reason: "connection-failed" });
      const reconnecting = runtime.reconnectServer(transportKind === "stdio"
        ? await controlAdmission("entered-reconnect")
        : await remoteControlAdmission("entered-reconnect"));
      const duplicate = runtime.reconnectServer(transportKind === "stdio"
        ? await controlAdmission("entered-reconnect")
        : await remoteControlAdmission("entered-reconnect"));
      expect(duplicate).toBe(reconnecting);
      await entered.promise;
      const disabled = runtime.disableServer("entered-reconnect");
      await expect(reconnecting).resolves.toMatchObject({ state: "failed", reason: "generation-stale" });
      await expect(disabled).resolves.toMatchObject({ state: "succeeded", cleanup: "confirmed" });
      await runtime.shutdown();
    }
  });

  it("retries unconfirmed cleanup before admitting exactly one replacement", async () => {
    let clients = 0;
    let cleanupChecks = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      constructor() { clients += 1; }
      async connect(): Promise<void> {}
      async listTools() { return { tools: [{ name: "tool" }] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      raceCleanup: async (completion) => { cleanupChecks += 1; await completion; return cleanupChecks > 1; },
    }));
    const admission = await controlAdmission("retry-cleanup");
    await runtime.reconcileServer(admission);
    await expect(runtime.disableServer("retry-cleanup")).resolves.toMatchObject({ state: "failed", cleanup: "unconfirmed" });
    const [replacement, duplicate] = await Promise.all([runtime.reconcileServer(admission), runtime.reconcileServer(admission)]);
    expect(replacement).toMatchObject({ state: "succeeded", cleanup: "confirmed" });
    expect(duplicate).toBe(replacement);
    expect(clients).toBe(2);
    await runtime.shutdown();
  });

  it("retries cleanup on repeated disable and reports confirmed cleanup exactly", async () => {
    let cleanupChecks = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> {}
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      raceCleanup: async (completion) => { cleanupChecks += 1; await completion; return cleanupChecks > 1; },
    }));
    await runtime.reconcileServer(await controlAdmission("repeat-confirmed"));
    await expect(runtime.disableServer("repeat-confirmed")).resolves.toMatchObject({
      state: "failed", reason: "cleanup-unconfirmed", cleanup: "unconfirmed",
    });
    await expect(runtime.disableServer("repeat-confirmed")).resolves.toEqual({
      state: "succeeded", reason: "already-inactive", cleanup: "confirmed", deltas: [],
    });
    expect(cleanupChecks).toBe(2);
    await runtime.shutdown();
  });

  it("retries cleanup on repeated disable and reports continuing uncertainty exactly", async () => {
    let cleanupChecks = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> {}
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      raceCleanup: async () => { cleanupChecks += 1; return false; },
    }));
    await runtime.reconcileServer(await controlAdmission("repeat-unconfirmed"));
    await runtime.disableServer("repeat-unconfirmed");
    await expect(runtime.disableServer("repeat-unconfirmed")).resolves.toEqual({
      state: "failed", reason: "cleanup-unconfirmed", cleanup: "unconfirmed", deltas: [],
    });
    expect(cleanupChecks).toBe(2);
    await runtime.shutdown();
  });

  it("treats only the still-latest disable as duplicate and fences an intervening enable", async () => {
    const cleanupGate = deferred<void>();
    let clients = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      constructor() { clients += 1; }
      async connect(): Promise<void> {}
      async close(): Promise<void> { await cleanupGate.promise; }
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    const admission = await controlAdmission("latest-disable");
    await runtime.reconcileServer(admission);
    const firstDisable = runtime.disableServer("latest-disable");
    const enabling = runtime.reconcileServer(await controlAdmission("latest-disable"));
    const latestDisable = runtime.disableServer("latest-disable");
    expect(latestDisable).not.toBe(firstDisable);
    cleanupGate.resolve();
    await expect(firstDisable).resolves.toMatchObject({ state: "succeeded", cleanup: "confirmed" });
    await expect(enabling).resolves.toMatchObject({ state: "failed", reason: "generation-stale" });
    await expect(latestDisable).resolves.toMatchObject({ state: "succeeded", reason: "already-inactive" });
    expect(clients).toBe(1);
    await runtime.shutdown();
  });

  it("shutdown overtakes an entered stdio reconcile without a test release", async () => {
    const entered = deferred<void>();
    const blocked = deferred<void>();
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> { entered.resolve(); await blocked.promise; }
      async close(): Promise<void> { blocked.reject(new Error("shutdown")); }
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    const starting = runtime.reconcileServer(await controlAdmission("shutdown-entered"));
    await entered.promise;
    const shutdown = runtime.shutdown();
    await expect(starting).resolves.toMatchObject({ state: "failed", reason: "shutting-down" });
    await shutdown;
    expect(runtime.tools()).toEqual([]);
  });

  it("keeps a late old-definition completion from replacing the entered new generation", async () => {
    const oldEntered = deferred<void>();
    const oldCompletion = deferred<void>();
    let clients = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      private readonly id = clients++;
      async connect(): Promise<void> {
        if (this.id === 0) { oldEntered.resolve(); await oldCompletion.promise; }
      }
      getServerCapabilities() { return { tools: {} }; }
      async listTools() { return { tools: [{ name: this.id === 0 ? "old" : "new" }] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    const oldStart = runtime.reconcileServer(await controlAdmission("replacement", CONTROL_DIGEST_A));
    await oldEntered.promise;
    const replacement = runtime.reconcileServer(await controlAdmission("replacement", CONTROL_DIGEST_B));
    await expect(oldStart).resolves.toMatchObject({ state: "failed", reason: "generation-stale" });
    await expect(replacement).resolves.toMatchObject({ state: "succeeded" });
    oldCompletion.resolve();
    await Promise.resolve();
    expect(runtime.tools().map((tool) => tool.toolName)).toEqual(["new"]);
    expect(runtime.serverStates()).toEqual([expect.objectContaining({ name: "replacement", state: "connected" })]);
    await runtime.shutdown();
  });

  it("keeps a cached remote catalog hidden when replacement activation fails", async () => {
    let clients = 0;
    class FakeTransport {
      onerror?: (error: Error) => void;
      onDisconnect(): void {}
      async abort(): Promise<void> {}
    }
    class FakeClient {
      private readonly id = clients++;
      async connect(): Promise<void> {
        if (this.id > 0) throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      }
      getServerCapabilities() { return { tools: {} }; }
      async listTools() { return { tools: [{ name: "cached" }] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadRemoteClient: async () => FakeClient as never,
      createRemoteTransport: async () => new FakeTransport() as never,
      delay: async () => {},
    }));
    const admission = await remoteControlAdmission("cached-remote");
    const first = await runtime.reconcileServer(admission);
    expect(first.deltas).toEqual([expect.objectContaining({ kind: "publish" })]);
    expect(runtime.tools().map((tool) => tool.toolName)).toEqual(["cached"]);
    await runtime.disableServer("cached-remote");
    const failed = await runtime.reconcileServer(admission);
    expect(failed).toMatchObject({ state: "failed", reason: "connection-failed" });
    expect(failed.deltas.some((delta) => delta.kind === "publish")).toBe(false);
    expect(runtime.tools()).toEqual([]);
    await runtime.shutdown();
  });

  it("invalidates a late connecting generation when disable races startup", async () => {
    const connectGate = deferred<void>();
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> { await connectGate.promise; }
      async listTools() { return { tools: [{ name: "late" }] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    try {
      const starting = runtime.reconcileServer(await controlAdmission("race"));
      await waitUntil({ description: "live server to enter connecting", predicate: () => runtime.serverStates().some((state) => state.name === "race") });
      const stopping = runtime.disableServer("race");
      connectGate.resolve();
      expect(await starting).toMatchObject({ state: "failed", reason: "generation-stale" });
      expect(await stopping).toMatchObject({ state: "succeeded" });
      expect(runtime.tools()).toEqual([]);
    } finally {
      connectGate.resolve();
      await runtime.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Timeout policy
// ---------------------------------------------------------------------------

describe("MCP timeout policy", () => {
  it("resolves connect defaults, coercions, and invalid fallbacks without changing the public shape", () => {
    expect(resolveMcpTimeoutPolicy({})).toEqual({
      connectTimeoutMs: 30_000,
      environmentToolTimeoutMs: undefined,
    });
    for (const invalid of ["", "   ", "0", "-1", "1.5", "not-a-number"]) {
      expect(resolveMcpTimeoutPolicy({ MCP_TIMEOUT: invalid }).connectTimeoutMs).toBe(30_000);
    }
    for (const [value, expected] of [[" 42.0 ", 42], ["1e3", 1_000], ["0x10", 16]] as const) {
      expect(resolveMcpTimeoutPolicy({ MCP_TIMEOUT: value }).connectTimeoutMs).toBe(expected);
    }
    expect(resolveMcpTimeoutPolicy({ MCP_TIMEOUT: "9999999999" }).connectTimeoutMs).toBe(
      2_147_483_647,
    );
  });

  it("resolves tool defaults, coercions, environment fallback, per-server precedence, and clamps", () => {
    const defaultPolicy = resolveMcpTimeoutPolicy({});
    expect(
      resolveMcpToolTimeoutMs(undefined, defaultPolicy.environmentToolTimeoutMs),
    ).toBe(100_000_000);

    const environmentPolicy = resolveMcpTimeoutPolicy({ MCP_TOOL_TIMEOUT: "2500" });
    for (const [value, expected] of [[" 2500.0 ", 2_500], ["2.5e3", 2_500], ["0x10", 16]] as const) {
      expect(resolveMcpTimeoutPolicy({ MCP_TOOL_TIMEOUT: value }).environmentToolTimeoutMs).toBe(expected);
    }
    expect(
      resolveMcpToolTimeoutMs(undefined, environmentPolicy.environmentToolTimeoutMs),
    ).toBe(2_500);
    expect(resolveMcpToolTimeoutMs(3_500, environmentPolicy.environmentToolTimeoutMs)).toBe(3_500);
    expect(resolveMcpToolTimeoutMs(1, undefined)).toBe(1_000);
    expect(
      resolveMcpToolTimeoutMs(
        undefined,
        resolveMcpTimeoutPolicy({ MCP_TOOL_TIMEOUT: "1" }).environmentToolTimeoutMs,
      ),
    ).toBe(1_000);
    expect(resolveMcpToolTimeoutMs(9_999_999_999, undefined)).toBe(2_147_483_647);
    expect(
      resolveMcpToolTimeoutMs(
        undefined,
        resolveMcpTimeoutPolicy({ MCP_TOOL_TIMEOUT: "9999999999" }).environmentToolTimeoutMs,
      ),
    ).toBe(2_147_483_647);
    expect(
      resolveMcpToolTimeoutMs(
        undefined,
        resolveMcpTimeoutPolicy({ MCP_TOOL_TIMEOUT: "invalid" }).environmentToolTimeoutMs,
      ),
    ).toBe(100_000_000);
  });

  it("emits one fixed redacted constructor diagnostic per rejected non-empty variable", async () => {
    const cases = [
      {
        env: {},
        expected: [],
      },
      {
        env: { MCP_TIMEOUT: "   ", MCP_TOOL_TIMEOUT: "" },
        expected: [],
      },
      {
        env: { MCP_TIMEOUT: "CONNECT_REJECTED_CANARY" },
        expected: [
          "MCP_TIMEOUT was rejected; using the 30000 ms fallback. Set MCP_TIMEOUT to a positive integer number of milliseconds or unset it.",
        ],
      },
      {
        env: { MCP_TOOL_TIMEOUT: "TOOL_REJECTED_CANARY" },
        expected: [
          "MCP_TOOL_TIMEOUT was rejected; per-server timeout remains authoritative, otherwise the 100000000 ms default applies. Set MCP_TOOL_TIMEOUT to a positive integer number of milliseconds or unset it.",
        ],
      },
      {
        env: { MCP_TIMEOUT: "CONNECT_REJECTED_CANARY", MCP_TOOL_TIMEOUT: "TOOL_REJECTED_CANARY" },
        expected: [
          "MCP_TIMEOUT was rejected; using the 30000 ms fallback. Set MCP_TIMEOUT to a positive integer number of milliseconds or unset it.",
          "MCP_TOOL_TIMEOUT was rejected; per-server timeout remains authoritative, otherwise the 100000000 ms default applies. Set MCP_TOOL_TIMEOUT to a positive integer number of milliseconds or unset it.",
        ],
      },
    ] as const;

    for (const row of cases) {
      const runtime = McpRuntime.start(
        makeConfig(
          makeServer({ name: "enabled-one" }),
          makeServer({ name: "enabled-two" }),
        ),
        makeDeps({
          env: { ...cleanBaseEnv(), ...row.env },
          loadSdk: async () => fakeToolSdk({ forwardedTimeouts: [] }),
        }),
      );
      try {
        await runtime.whenSettled();
        expect(runtime.diagnostics()).toEqual(row.expected);
        expect(runtime.diagnostics()).toEqual(row.expected);
        expect(runtime.diagnostics().join("\n")).not.toContain("REJECTED_CANARY");
      } finally {
        await runtime.shutdown();
      }
    }
  });

  it("keeps accepted and clamped timeout values warning-free at runtime", async () => {
    const accepted = [
      { MCP_TIMEOUT: " 42.0 ", MCP_TOOL_TIMEOUT: "2.5e3" },
      { MCP_TIMEOUT: "0x10", MCP_TOOL_TIMEOUT: "1" },
      { MCP_TIMEOUT: "9999999999", MCP_TOOL_TIMEOUT: "9999999999" },
    ];
    for (const env of accepted) {
      const runtime = McpRuntime.start(makeConfig(), makeDeps({ env: { ...cleanBaseEnv(), ...env } }));
      try {
        await runtime.whenSettled();
        expect(runtime.diagnostics()).toEqual([]);
      } finally {
        await runtime.shutdown();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Zero-cost path
// ---------------------------------------------------------------------------

describe("McpRuntime zero-enabled path", () => {
  it("does no SDK, transport, listener, timer, retry, or shutdown work for a policy-blocked snapshot", async () => {
    let sdkLoads = 0;
    let remoteLoads = 0;
    let timeoutRaces = 0;
    const exitListeners = process.listenerCount("exit");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const timeoutCalls = timeoutSpy.mock.calls.length;
    const runtime = McpRuntime.start(
      {
        ...makeConfig(
          makeBlockedServer("blocked-stdio", "stdio"),
          makeBlockedServer("blocked-remote", "http"),
        ),
        policyPosture: "active-rules",
        policyAuthority: "administrator-controlled",
      },
      makeDeps({
        loadSdk: async () => { sdkLoads += 1; throw new Error("blocked stdio reached SDK loading"); },
        loadRemoteClient: async () => { remoteLoads += 1; throw new Error("blocked remote reached client loading"); },
        raceWithTimeout: async () => { timeoutRaces += 1; throw new Error("blocked server reached timeout/retry work"); },
      }),
    );
    try {
      expect(runtime.serverStates()).toEqual([]);
      expect(runtime.tools()).toEqual([]);
      await runtime.whenSettled();
      expect({ sdkLoads, remoteLoads, timeoutRaces }).toEqual({ sdkLoads: 0, remoteLoads: 0, timeoutRaces: 0 });
      expect(process.listenerCount("exit")).toBe(exitListeners);
      expect(timeoutSpy.mock.calls).toHaveLength(timeoutCalls);
      await runtime.shutdown();
      await runtime.shutdown();
      expect(process.listenerCount("exit")).toBe(exitListeners);
      expect(timeoutSpy.mock.calls).toHaveLength(timeoutCalls);
    } finally {
      timeoutSpy.mockRestore();
      await runtime.shutdown();
    }
  });

  it("spawns nothing and settles immediately when no server is enabled", async () => {
    const config = makeConfig(
      makeServer({ name: "pending", status: "pending-approval" }),
      makeServer({ name: "off", status: "disabled" }),
      makeServer({ name: "broken", status: "skipped" }),
      makeServer({ name: "empty", status: "not-configured" }),
    );
    const runtime = McpRuntime.start(config, makeDeps());
    expect(runtime.tools()).toEqual([]);
    expect(runtime.serverStates()).toEqual([]);
    expect(runtime.diagnostics()).toEqual([]);
    await runtime.whenSettled();
    await expect(runtime.callTool("pending", "anything", {})).rejects.toThrow(/not configured or not enabled/);
    await runtime.shutdown();
  });

  it("resolves the connect-timeout default to 30 000 ms with MCP_TIMEOUT unset", async () => {
    // Zero enabled servers: the resolved bound is observable with no spawn.
    const runtime = McpRuntime.start(makeConfig(), makeDeps());
    expect(runtime.resolvedConnectTimeoutMs).toBe(30_000);
    await runtime.shutdown();
  });

  it("resolves MCP_TIMEOUT from project settings.env", async () => {
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      settingsEnv: { MCP_TIMEOUT: "1234" },
    }));
    expect(runtime.resolvedConnectTimeoutMs).toBe(1_234);
    await runtime.shutdown();
  });

  it("returns [] from tools() immediately after start with a never-connecting server, and shutdown settles it", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    // Default MCP_TIMEOUT (30 s): what settles this test is shutdown(), not the
    // connect bound — pinning the non-blocking start contract.
    const config = makeConfig(
      makeServer({
        name: "hang",
        args: [fixture.serverScript, "hang-initialize", "ARG_CANARY"],
        env: { ...fixture.env, TOKEN: "ENV_CANARY" },
        rawCommand: "SHUTDOWN_RAW_COMMAND_CANARY",
      }),
    );
    const runtime = McpRuntime.start(config, makeDeps());
    try {
      expect(runtime.tools()).toEqual([]);
      expect(runtime.serverStates()).toEqual([
        { name: "hang", transport: "stdio", state: "connecting" },
      ]);
      await fixture.waitFor(["hang-initialize.pid"], "hanging server to spawn");
      const pid = fixture.pidOf("hang-initialize.pid");
      await runtime.shutdown();
      await runtime.whenSettled();
      await waitForDeath(pid, "hanging server after shutdown");
      expect(runtime.serverStates()[0]).toMatchObject({
        state: "failed",
        statusSummary: "Connection stopped because the session shut down.",
      });
      const report = renderMcpStatusReport(config, runtime.serverStates());
      for (const canary of [
        "hang-initialize",
        "ARG_CANARY",
        "ENV_CANARY",
        "SHUTDOWN_RAW_COMMAND_CANARY",
      ]) {
        expect(report).not.toContain(canary);
      }
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("McpRuntime stdio lifecycle", () => {
  it("connects, lists tools, round-trips a call, and kills the server on shutdown", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const exitListenerBaseline = process.listenerCount("exit");
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "fixture", args: [fixture.serverScript, "serve"], env: fixture.env }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      // Exit-sweep listener discipline: exactly one listener while running.
      expect(process.listenerCount("exit")).toBe(exitListenerBaseline + 1);
      expect(runtime.serverStates()).toEqual([
        { name: "fixture", transport: "stdio", state: "connected", toolsAdvertised: true, promptsAdvertised: false, resourcesAdvertised: false, toolCount: 3 },
      ]);
      const tools = runtime.tools();
      expect(tools.map((t) => t.toolName).sort()).toEqual(["big-output", "echo", "report-env"]);
      expect(tools.every((t) => t.serverName === "fixture")).toBe(true);
      const echo = tools.find((t) => t.toolName === "echo")!;
      expect(echo.description).toBe("echoes text back");
      expect(echo.inputSchema).toMatchObject({ type: "object" });

      const result = await runtime.callTool("fixture", "echo", { text: "round-trip" });
      expect(firstText(result)).toBe("round-trip");

      const big = await runtime.callTool("fixture", "big-output", { bytes: 100_000 });
      expect(firstText(big)).toHaveLength(100_000);

      const pid = fixture.pidOf("serve.pid");
      expect(processIsAlive(pid)).toBe(true);
      await runtime.shutdown();
      // ...and back to baseline after shutdown.
      expect(process.listenerCount("exit")).toBe(exitListenerBaseline);
      await waitForDeath(pid, "served fixture after shutdown");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it("starts and shuts down concurrent benign servers without leaking children or exit listeners", async () => {
    const firstFixture = createMcpProcessFixture(makeTempDir());
    const secondFixture = createMcpProcessFixture(makeTempDir());
    const exitListenerBaseline = process.listenerCount("exit");
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "first", args: [firstFixture.serverScript, "serve"], env: firstFixture.env }),
        makeServer({ name: "second", args: [secondFixture.serverScript, "serve"], env: secondFixture.env }),
      ),
      makeDeps(),
    );
    try {
      expect(runtime.tools()).toEqual([]);
      expect(runtime.serverStates()).toEqual([
        { name: "first", transport: "stdio", state: "connecting" },
        { name: "second", transport: "stdio", state: "connecting" },
      ]);
      await Promise.all([
        firstFixture.waitFor(["serve.pid"], "first concurrent server to spawn"),
        secondFixture.waitFor(["serve.pid"], "second concurrent server to spawn"),
      ]);
      const pids = [
        firstFixture.pidOf("serve.pid"),
        secondFixture.pidOf("serve.pid"),
      ];
      expect(pids.every(processIsAlive)).toBe(true);
      expect(process.listenerCount("exit")).toBe(exitListenerBaseline + 1);

      await runtime.shutdown();
      await runtime.whenSettled();
      await Promise.all(pids.map((pid) => waitForDeath(pid, "concurrent server after shutdown")));
      expect(pids.every(processIsAlive)).toBe(false);
      expect(process.listenerCount("exit")).toBe(exitListenerBaseline);
    } finally {
      await runtime.shutdown();
      await Promise.all([firstFixture.cleanup(), secondFixture.cleanup()]);
    }
  }, 25_000);

  it("rejects callTool for unknown servers and unknown tools with descriptive errors", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "fixture", args: [fixture.serverScript, "serve"], env: fixture.env }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      await expect(runtime.callTool("nope", "echo", {})).rejects.toThrow(
        /server "nope" is not running/,
      );
      await expect(runtime.callTool("fixture", "no-such-tool", {})).rejects.toThrow(
        /has no tool "no-such-tool"/,
      );
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it("composes server env over Claude defaults over project settings over sanitized inheritance", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const projectRoot = makeTempDir();
    const base: Record<string, string | undefined> = {
      ...cleanBaseEnv(),
      MCP_FIXTURE_VAR: "from-base",
      PROJECT_SETTING: "from-inherited-base",
      PICC_LAUNCHER_PID: "99",
      PICC_INSTALL_KIND: "source",
      PICC_VERSION: "1.2.3",
      PI_SKIP_VERSION_CHECK: "1",
      AI_AGENT: "pi",
    };
    // Prove unicodeSafeSubprocessEnv participates: the default only applies
    // when the base does not already set it.
    delete base["PYTHONIOENCODING"];
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({
          name: "fixture",
          args: [fixture.serverScript, "serve"],
          env: {
            ...fixture.env,
            MCP_FIXTURE_VAR: "from-config",
            // Claude parity: configured server env is applied last.
            CLAUDECODE: "0",
            CLAUDE_PROJECT_DIR: "/config-wins",
          },
        }),
      ),
      makeDeps({
        projectRoot,
        sessionId: "env-proof-session",
        env: base,
        settingsEnv: {
          PROJECT_SETTING: "from-project-settings",
          MCP_FIXTURE_VAR: "from-settings",
          CLAUDE_CODE_SESSION_ID: "settings-must-lose-to-default",
          AI_AGENT: "project-agent",
        },
      }),
    );
    try {
      await runtime.whenSettled();
      const names = [
        "CLAUDE_PROJECT_DIR",
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "MCP_FIXTURE_VAR",
        "PROJECT_SETTING",
        "PYTHONIOENCODING",
        "PICC_LAUNCHER_PID",
        "PICC_INSTALL_KIND",
        "PICC_VERSION",
        "PI_SKIP_VERSION_CHECK",
        "AI_AGENT",
      ];
      const result = await runtime.callTool("fixture", "report-env", { names });
      const reported = JSON.parse(firstText(result)) as Record<string, string | null>;
      expect(reported).toEqual({
        CLAUDE_PROJECT_DIR: "/config-wins",
        CLAUDECODE: "0",
        CLAUDE_CODE_SESSION_ID: "env-proof-session",
        MCP_FIXTURE_VAR: "from-config",
        PROJECT_SETTING: "from-project-settings",
        PYTHONIOENCODING: "utf-8",
        PICC_LAUNCHER_PID: null,
        PICC_INSTALL_KIND: null,
        PICC_VERSION: null,
        PI_SKIP_VERSION_CHECK: null,
        AI_AGENT: "project-agent",
      });
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it.skipIf(process.platform !== "win32")(
    "spawns a .cmd shim without shell:true (cross-spawn behavior pinned)",
    async () => {
      const fixture = createMcpProcessFixture(makeTempDir());
      const shimDir = makeTempDir();
      const shim = path.join(shimDir, "serve-shim.cmd");
      fs.writeFileSync(
        shim,
        `@echo off\r\n"${process.execPath}" "${fixture.serverScript}" serve\r\n`,
      );
      const runtime = McpRuntime.start(
        makeConfig(
          makeServer({ name: "shim", command: shim, args: [], env: fixture.env, rawCommand: "serve-shim.cmd" }),
        ),
        makeDeps(),
      );
      try {
        await runtime.whenSettled();
        expect(runtime.serverStates()).toEqual([{ name: "shim", transport: "stdio", state: "connected", toolsAdvertised: true, promptsAdvertised: false, resourcesAdvertised: false, toolCount: 3 }]);
        const result = await runtime.callTool("shim", "echo", { text: "via cmd shim" });
        expect(firstText(result)).toBe("via cmd shim");
      } finally {
        await runtime.shutdown();
        await fixture.cleanup();
      }
    },
    25_000,
  );
});

// ---------------------------------------------------------------------------
// Prompt and resource capability snapshots
// ---------------------------------------------------------------------------

describe("McpRuntime prompt and resource capabilities", () => {
  it("connects tool-only, prompt-only, resource-only, mixed, and advertised-empty stdio servers", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const modes = ["serve", "prompt-only", "resource-only", "prompt-resource", "empty-capabilities"] as const;
    const runtime = McpRuntime.start(makeConfig(...modes.map((mode) => makeServer({
      name: mode,
      args: [fixture.serverScript, mode],
      env: fixture.env,
    }))), makeDeps());
    try {
      await runtime.whenSettled();
      const states = new Map(runtime.serverStates().map((state) => [state.name, state]));
      expect(states.get("serve")).toMatchObject({ toolsAdvertised: true, promptsAdvertised: false, resourcesAdvertised: false, toolCount: 3 });
      expect(states.get("prompt-only")).toMatchObject({ toolsAdvertised: false, promptsAdvertised: true, resourcesAdvertised: false, promptCount: 1 });
      expect(states.get("resource-only")).toMatchObject({ toolsAdvertised: false, promptsAdvertised: false, resourcesAdvertised: true, resourceCount: 2 });
      expect(states.get("prompt-resource")).toMatchObject({ toolsAdvertised: false, promptsAdvertised: true, resourcesAdvertised: true, promptCount: 1, resourceCount: 2 });
      expect(states.get("empty-capabilities")).toMatchObject({ promptsAdvertised: true, resourcesAdvertised: true, promptCount: 0, resourceCount: 0 });
      expect(runtime.tools().every((tool) => tool.serverName === "serve")).toBe(true);
      expect(runtime.prompts().map((prompt) => prompt.serverName).sort()).toEqual(["prompt-only", "prompt-resource"]);
      expect(runtime.resourceServers().map((server) => [server.serverName, server.resources.length]).sort()).toEqual([
        ["empty-capabilities", 0], ["prompt-resource", 2], ["resource-only", 2],
      ]);

      const promptResult = await runtime.getPrompt("prompt-only", "fixture-prompt", { required: "yes" });
      expect(promptResult).toMatchObject({ messages: [{ content: { text: '{"required":"yes"}' } }] });
      expect(await runtime.readResource("resource-only", "fixture://text")).toMatchObject({
        contents: [{ uri: "fixture://text", text: "fixture text" }],
      });
      expect(await runtime.readResource("resource-only", "fixture://binary")).toMatchObject({
        contents: [{ uri: "fixture://binary", blob: "AAEC" }],
      });
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it.each([
    ["tools", ["tools"]],
    ["prompts", ["prompts"]],
    ["resources", ["resources"]],
  ] as const)("calls exactly the advertised %s list method", async (capability, expectedCalls) => {
    const calls: string[] = [];
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> {}
      getServerCapabilities() { return { [capability]: {} }; }
      async listTools() { calls.push("tools"); return { tools: [] }; }
      async listPrompts() { calls.push("prompts"); return { prompts: [] }; }
      async listResources() { calls.push("resources"); return { resources: [] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(makeServer({ name: `only-${capability}` })), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    try {
      await runtime.whenSettled();
      expect(calls).toEqual(expectedCalls);
    } finally {
      await runtime.shutdown();
    }
  });

  it("requests only advertised capabilities and publishes sanitized frozen metadata", async () => {
    const calls: string[] = [];
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> {}
      getServerCapabilities() { return { prompts: {}, resources: {} }; }
      async listTools(): Promise<never> { calls.push("tools"); throw new Error("must not list tools"); }
      async listPrompts(): Promise<{ prompts: unknown[] }> {
        calls.push("prompts");
        return { prompts: [{
          name: "raw.prompt",
          description: "hello\u001bworld",
          arguments: [{ name: "first", description: "a\u0007b", required: true }],
        }] };
      }
      async listResources(): Promise<{ resources: unknown[] }> {
        calls.push("resources");
        return { resources: [{
          uri: "opaque://host/value",
          name: "resource",
          title: "title\u001b",
          description: "description",
          mimeType: "text/plain",
          size: 12,
        }, { uri: "opaque://invalid-size", name: "other", size: -1 },
        { uri: "opaque://control\nvalue", name: "control" }] };
      }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(makeServer({ name: "caps" })), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    try {
      await runtime.whenSettled();
      expect(calls.sort()).toEqual(["prompts", "resources"]);
      const prompt = runtime.prompts()[0]!;
      expect(prompt).toEqual({
        serverName: "caps",
        promptName: "raw.prompt",
        description: "hello world",
        arguments: [{ name: "first", description: "a b", required: true }],
      });
      expect(Object.isFrozen(prompt)).toBe(true);
      expect(Object.isFrozen(prompt.arguments)).toBe(true);
      const resources = runtime.resourceServers()[0]!;
      expect(resources.resources[0]).toEqual({
        serverName: "caps", uri: "opaque://host/value", name: "resource", title: "title ",
        description: "description", mimeType: "text/plain", size: 12,
      });
      expect(resources.resources[1]).not.toHaveProperty("size");
      expect(resources.resources).toHaveLength(2);
      expect(Object.isFrozen(resources.resources)).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps complete prompt argument declarations and drops every invalid declaration list fail-closed", async () => {
    const validArguments = Array.from({ length: 1_024 }, (_, index) => ({
      name: `argument-${index}`,
      description: `description-${index}`,
      required: index % 2 === 0,
    }));
    const hostileArgumentCanaries = [
      "HOSTILE_NON_ARRAY_CANARY",
      "HOSTILE_NULL_ENTRY_CANARY",
      "HOSTILE_ARRAY_ENTRY_CANARY",
      "HOSTILE_SCALAR_ENTRY_CANARY",
      "HOSTILE_MISSING_NAME_CANARY",
      "HOSTILE_NON_STRING_NAME_CANARY",
      "HOSTILE_EMPTY_NAME_CANARY",
      "HOSTILE_CONTROL_NAME_CANARY",
      "HOSTILE_OVERSIZED_NAME_CANARY",
      "HOSTILE_DESCRIPTION_CANARY",
      "HOSTILE_REQUIRED_CANARY",
      "HOSTILE_DUPLICATE_NAME_CANARY",
      "HOSTILE_OVER_LIMIT_CANARY",
    ] as const;
    const invalidArgumentLists: Array<[string, unknown]> = [
      ["non-array", { name: hostileArgumentCanaries[0] }],
      ["null-entry", [{ name: hostileArgumentCanaries[1] }, null]],
      ["array-entry", [[hostileArgumentCanaries[2]]]],
      ["scalar-entry", [hostileArgumentCanaries[3]]],
      ["missing-name", [{ description: hostileArgumentCanaries[4] }]],
      ["non-string-name", [{ name: { marker: hostileArgumentCanaries[5] } }]],
      ["empty-name", [{ name: "", description: hostileArgumentCanaries[6] }]],
      ["control-name", [{ name: `${hostileArgumentCanaries[7]}\u001b` }]],
      ["oversized-name", [{ name: `${hostileArgumentCanaries[8]}${"n".repeat(1_025)}` }]],
      ["invalid-description", [{ name: "argument", description: { marker: hostileArgumentCanaries[9] } }]],
      ["invalid-required", [{ name: "argument", required: hostileArgumentCanaries[10] }]],
      ["duplicate-name", [{ name: hostileArgumentCanaries[11] }, { name: hostileArgumentCanaries[11] }]],
      ["over-limit", [
        ...Array.from({ length: 1_024 }, (_, index) => ({ name: `over-limit-${index}` })),
        { name: hostileArgumentCanaries[12] },
      ]],
    ];
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> {}
      getServerCapabilities() { return { prompts: {} }; }
      async listPrompts(): Promise<{ prompts: unknown[] }> {
        return { prompts: [
          { name: "absent" },
          { name: "maximum-valid", arguments: validArguments },
          ...invalidArgumentLists.map(([name, arguments_]) => ({ name, arguments: arguments_ })),
        ] };
      }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(makeServer({ name: "prompt-arguments" })), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    try {
      await runtime.whenSettled();
      const prompts = runtime.prompts();
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toEqual({
        serverName: "prompt-arguments",
        promptName: "absent",
        description: "",
        arguments: [],
      });
      expect(prompts[1]?.arguments).toHaveLength(1_024);
      expect(prompts[1]?.arguments).toEqual(validArguments);
      expect(prompts.every((prompt) => Object.isFrozen(prompt.arguments))).toBe(true);
      expect(prompts.flatMap((prompt) => prompt.arguments).every(Object.isFrozen)).toBe(true);
      expect(runtime.diagnostics()).toContain(
        `MCP server "prompt-arguments": dropped ${invalidArgumentLists.length} invalid prompt metadata entries`,
      );
      const diagnostics = runtime.diagnostics().join("\n");
      for (const canary of hostileArgumentCanaries) expect(diagnostics).not.toContain(canary);
    } finally {
      await runtime.shutdown();
    }
  });

  it("retains an advertised resource server entry when its isolated catalog discovery fails", async () => {
    class StreamableHTTPError extends Error { constructor(readonly status: number) { super("RESOURCE_SPEECH_CANARY"); } }
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> {}
      getServerCapabilities() { return { prompts: {}, resources: {} }; }
      async listPrompts() { return { prompts: [] }; }
      async listResources(): Promise<never> { throw new StreamableHTTPError(400); }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(makeServer({ name: "resource-failure" })), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    try {
      await runtime.whenSettled();
      expect(runtime.resourceServers()).toEqual([{
        serverName: "resource-failure",
        resources: [],
        discoveryError: "resources discovery failed after 1 attempt(s) (permanent)",
      }]);
      expect(runtime.serverStates()[0]).toMatchObject({
        state: "connected",
        promptsAdvertised: true,
        promptCount: 0,
        resourcesAdvertised: true,
        resourceCount: 0,
        resourceDiscoveryError: "resources discovery failed after 1 attempt(s) (permanent)",
      });
      expect(runtime.diagnostics().join("\n")).not.toContain("RESOURCE_SPEECH_CANARY");
    } finally {
      await runtime.shutdown();
    }
  });

  it.each(["close", "error"] as const)(
    "fails stdio startup when transport emits %s during otherwise-isolated prompt discovery",
    async (event) => {
      class FakeTransport {
        readonly pid = undefined;
        readonly stderr = undefined;
        onclose?: () => void;
        onerror?: (error: Error) => void;
      }
      class FakeClient {
        private transport?: FakeTransport;
        async connect(transport: FakeTransport): Promise<void> { this.transport = transport; }
        getServerCapabilities() { return { prompts: {} }; }
        async listPrompts(): Promise<never> {
          if (event === "close") this.transport?.onclose?.();
          else this.transport?.onerror?.(new Error("TRANSPORT_ERROR_CANARY"));
          throw new Error("PROMPT_PROTOCOL_CANARY");
        }
        async close(): Promise<void> {}
      }
      const runtime = McpRuntime.start(makeConfig(makeServer({ name: `prompt-${event}` })), makeDeps({
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      }));
      try {
        await runtime.whenSettled();
        expect(runtime.serverStates()[0]).toMatchObject({ state: "failed" });
        expect(runtime.serverStates()[0]).not.toHaveProperty("promptsAdvertised");
        expect(runtime.prompts()).toEqual([]);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("does not publish late prompt/resource discovery after stdio startup times out", async () => {
    const promptGate = deferred<void>();
    const resourceGate = deferred<void>();
    const bothListsEntered = deferred<void>();
    let entered = 0;
    let startupAttempt: Promise<unknown> | undefined;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> {}
      getServerCapabilities() { return { prompts: {}, resources: {} }; }
      async listPrompts() {
        if (++entered === 2) bothListsEntered.resolve();
        await promptGate.promise;
        return {
          prompts: Array.from({ length: 1_025 }, (_, index) => ({ name: `late-prompt-${index}` })),
        };
      }
      async listResources() {
        if (++entered === 2) bothListsEntered.resolve();
        await resourceGate.promise;
        return {
          resources: Array.from({ length: 1_025 }, (_, index) => ({
            uri: `late:${index}`,
            name: `late-resource-${index}`,
          })),
        };
      }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(makeServer({ name: "late-discovery" })), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      raceWithTimeout: async (promise) => {
        startupAttempt = promise;
        await bothListsEntered.promise;
        return { timedOut: true };
      },
    }));
    try {
      await runtime.whenSettled();
      const state = runtime.serverStates()[0]!;
      expect(state.state).toBe("failed");
      for (const field of [
        "toolsAdvertised", "promptsAdvertised", "resourcesAdvertised",
        "toolCount", "promptCount", "resourceCount",
        "toolDiscoveryError", "promptDiscoveryError", "resourceDiscoveryError",
      ]) {
        expect(state).not.toHaveProperty(field);
      }
      expect(runtime.tools()).toEqual([]);
      expect(runtime.prompts()).toEqual([]);
      expect(runtime.resourceServers()).toEqual([]);
      const diagnosticsAtTimeout = runtime.diagnostics();

      promptGate.resolve();
      resourceGate.resolve();
      await startupAttempt;

      expect(runtime.serverStates()[0]).toEqual(state);
      expect(runtime.tools()).toEqual([]);
      expect(runtime.prompts()).toEqual([]);
      expect(runtime.resourceServers()).toEqual([]);
      expect(runtime.diagnostics()).toEqual(diagnosticsAtTimeout);
      expect(runtime.diagnostics().join("\n")).not.toContain("catalog truncated");
    } finally {
      promptGate.resolve();
      resourceGate.resolve();
      await runtime.shutdown();
    }
  });

  it("bounds catalogs and reports cursor cycles and page/item truncation", async () => {
    let promptPage = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> {}
      getServerCapabilities() { return { tools: {}, prompts: {}, resources: {} }; }
      async listTools(params: { cursor?: string }): Promise<{ tools: Array<{ name: string }>; nextCursor: string }> {
        return { tools: [{ name: params.cursor ? "second" : "first" }], nextCursor: "cycle" };
      }
      async listPrompts(): Promise<{ prompts: Array<{ name: string }>; nextCursor: string }> {
        const page = promptPage++;
        return { prompts: [{ name: `prompt-${page}` }], nextCursor: `page-${page + 1}` };
      }
      async listResources(): Promise<{ resources: Array<{ uri: string; name: string }>; nextCursor: string }> {
        return {
          resources: Array.from({ length: 1_025 }, (_, index) => ({ uri: `opaque:${index}`, name: `resource-${index}` })),
          nextCursor: "more",
        };
      }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(makeServer({ name: "bounded" })), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    try {
      await runtime.whenSettled();
      expect(runtime.tools()).toHaveLength(2);
      expect(runtime.prompts()).toHaveLength(16);
      expect(runtime.resourceServers()[0]?.resources).toHaveLength(1_024);
      const diagnostics = runtime.diagnostics().join("\n");
      expect(diagnostics).toContain("tools pagination cursor cycle stopped");
      expect(diagnostics).toContain("prompts pagination truncated at 16 pages");
      expect(diagnostics).toContain("resources catalog truncated at 1024 items");
    } finally {
      await runtime.shutdown();
    }
  });

  it.each(["tools", "prompts", "resources"] as const)(
    "retries transient %s discovery from page one and does not retry auth, 4xx, or request timeout",
    async (capability) => {
      class StreamableHTTPError extends Error { constructor(readonly status: number) { super("SERVER_CANARY"); } }
      for (const row of [
        { errors: [new StreamableHTTPError(500), new StreamableHTTPError(500), new StreamableHTTPError(500)], expectedCalls: 4, expectedDelays: [100, 200, 400] },
        { errors: [new StreamableHTTPError(401)], expectedCalls: 1, expectedDelays: [] },
        { errors: [new StreamableHTTPError(400)], expectedCalls: 1, expectedDelays: [] },
        { errors: [Object.assign(new Error("TIMEOUT_CANARY"), { code: -32_001 })], expectedCalls: 1, expectedDelays: [] },
      ]) {
        let calls = 0;
        const delays: number[] = [];
        class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
        class FakeClient {
          async connect(): Promise<void> {}
          getServerCapabilities() { return { [capability]: {} }; }
          private async list(): Promise<Record<string, unknown>> {
            const error = row.errors[calls++];
            if (error) throw error;
            return { [capability]: [] };
          }
          listTools = () => this.list();
          listPrompts = () => this.list();
          listResources = () => this.list();
          async close(): Promise<void> {}
        }
        const runtime = McpRuntime.start(makeConfig(makeServer({ name: `retry-${capability}` })), makeDeps({
          loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
          delay: async (ms) => { delays.push(ms); },
        }));
        try {
          await runtime.whenSettled();
          expect(calls).toBe(row.expectedCalls);
          expect(delays).toEqual(row.expectedDelays);
          expect(runtime.diagnostics().join("\n")).not.toMatch(/SERVER_CANARY|TIMEOUT_CANARY/);
        } finally {
          await runtime.shutdown();
        }
      }
    },
  );

  it.each(["tools", "prompts", "resources"] as const)(
    "restarts page-two transient %s discovery at page one",
    async (capability) => {
      const cursors: Array<string | undefined> = [];
      let failedPageTwo = false;
      class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
      class FakeClient {
        async connect(): Promise<void> {}
        getServerCapabilities() { return { [capability]: {} }; }
        private async list(params: { cursor?: string }) {
          cursors.push(params.cursor);
          if (params.cursor === "page-two" && !failedPageTwo) {
            failedPageTwo = true;
            throw Object.assign(new Error("TRANSIENT_CANARY"), { code: "ECONNRESET" });
          }
          return params.cursor === undefined
            ? { [capability]: [], nextCursor: "page-two" }
            : { [capability]: [] };
        }
        listTools = (params: { cursor?: string }) => this.list(params);
        listPrompts = (params: { cursor?: string }) => this.list(params);
        listResources = (params: { cursor?: string }) => this.list(params);
        async close(): Promise<void> {}
      }
      const delays: number[] = [];
      const runtime = McpRuntime.start(makeConfig(makeServer({ name: `page-two-${capability}` })), makeDeps({
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
        delay: async (ms) => { delays.push(ms); },
      }));
      try {
        await runtime.whenSettled();
        expect(cursors).toEqual([undefined, "page-two", undefined, "page-two"]);
        expect(delays).toEqual([100]);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it.each(["prompts", "resources"] as const)(
    "isolates four-failure %s exhaustion after three delays and keeps a healthy sibling",
    async (capability) => {
      let clients = 0;
      const calls = [0, 0];
      const delays: number[] = [];
      class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
      class FakeClient {
        private readonly index = clients++;
        async connect(): Promise<void> {}
        getServerCapabilities() { return { [capability]: {} }; }
        private async list() {
          calls[this.index]! += 1;
          if (this.index === 0) throw Object.assign(new Error("FAIL_CANARY"), { code: "ECONNRESET" });
          return { [capability]: [] };
        }
        listPrompts = () => this.list();
        listResources = () => this.list();
        async close(): Promise<void> {}
      }
      const runtime = McpRuntime.start(makeConfig(
        makeServer({ name: "failed" }),
        makeServer({ name: "healthy" }),
      ), makeDeps({
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
        delay: async (ms) => { delays.push(ms); },
      }));
      try {
        await runtime.whenSettled();
        expect(calls).toEqual([4, 1]);
        expect(delays).toEqual([100, 200, 400]);
        expect(runtime.serverStates()).toEqual([
          expect.objectContaining({
            name: "failed",
            state: "connected",
            [`${capability.slice(0, -1)}DiscoveryError`]: `${capability} discovery failed after 4 attempt(s) (transient)`,
          }),
          expect.objectContaining({ name: "healthy", state: "connected" }),
        ]);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("exhausts tool discovery after four failures and three delays without harming a healthy sibling", async () => {
    const calls = new Map<string, number>();
    const delays: number[] = [];
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      private readonly index: number;
      constructor() { this.index = calls.size; calls.set(`server-${this.index}`, 0); }
      async connect(): Promise<void> {}
      async listTools() {
        const key = `server-${this.index}`;
        calls.set(key, calls.get(key)! + 1);
        if (this.index === 0) throw Object.assign(new Error("FAIL_CANARY"), { code: "ECONNRESET" });
        return { tools: [{ name: "healthy" }] };
      }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(
      makeServer({ name: "failed" }),
      makeServer({ name: "healthy" }),
    ), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      delay: async (ms) => { delays.push(ms); },
    }));
    try {
      await runtime.whenSettled();
      expect(calls.get("server-0")).toBe(4);
      expect(delays).toEqual([100, 200, 400]);
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({ name: "failed", state: "failed" }),
        expect.objectContaining({ name: "healthy", state: "connected", toolCount: 1 }),
      ]);
      expect(runtime.tools().map((tool) => tool.toolName)).toEqual(["healthy"]);
    } finally {
      await runtime.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Degrade paths
// ---------------------------------------------------------------------------

describe("McpRuntime degrade paths", () => {
  it("publishes an independent safe summary when the optional SDK fails to load", async () => {
    const config = makeConfig(
      makeServer({
        name: "sdk-failure",
        command: "C:/EXPANDED_PATH_CANARY/server.exe",
        args: ["ARG_CANARY"],
        env: { TOKEN: "ENV_CANARY" },
        rawCommand: "RAW_COMMAND_CANARY",
      }),
    );
    const runtime = McpRuntime.start(
      config,
      makeDeps({
        loadSdk: async () => {
          throw new Error("EXCEPTION_CANARY C:/PRIVATE_PATH_CANARY");
        },
      }),
    );
    try {
      await runtime.whenSettled();
      const state = runtime.serverStates()[0];
      expect(state?.statusSummary).toBe(
        "MCP support is unavailable because its SDK could not be loaded.",
      );
      expect(state?.diagnostic).toContain("sdk failed to load (Error)");
      const report = renderMcpStatusReport(config, runtime.serverStates());
      expect(report).toContain(state!.statusSummary!);
      for (const canary of [
        "EXPANDED_PATH_CANARY",
        "ARG_CANARY",
        "ENV_CANARY",
        "RAW_COMMAND_CANARY",
        "EXCEPTION_CANARY",
        "PRIVATE_PATH_CANARY",
      ]) {
        expect(report).not.toContain(canary);
        expect(state?.statusSummary).not.toContain(canary);
      }
    } finally {
      await runtime.shutdown();
    }
  });

  it("reports a safe umbrella failure when tool discovery rejects after initialization", async () => {
    let initialized = false;
    let discoveryAttempted = false;
    class FakeTransport {
      readonly pid = undefined;
      readonly stderr = undefined;
      constructor(_options: unknown) {}
    }
    class RejectingDiscoveryClient {
      constructor(_clientInfo: unknown, _options: unknown) {}
      async connect(_transport: unknown): Promise<void> {
        initialized = true;
      }
      async listTools(_params: unknown): Promise<never> {
        discoveryAttempted = true;
        throw new Error("LIST_TOOLS_EXCEPTION_CANARY C:/PRIVATE_DISCOVERY_PATH");
      }
      async close(): Promise<void> {}
    }
    const config = makeConfig(
      makeServer({ name: "discovery-reject", rawCommand: "DISCOVERY_RAW_COMMAND_CANARY" }),
    );
    const runtime = McpRuntime.start(
      config,
      makeDeps({
        loadSdk: async () =>
          ({
            Client: RejectingDiscoveryClient,
            StdioClientTransport: FakeTransport,
          }) as unknown as Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>>,
      }),
    );
    try {
      await runtime.whenSettled();
      expect(initialized).toBe(true);
      expect(discoveryAttempted).toBe(true);
      const state = runtime.serverStates()[0];
      expect(state).toMatchObject({
        state: "failed",
        initialToolDiscoveryFailed: true,
        statusSummary:
          "Initial tools/list discovery failed; check the server configuration and logs, then run /reload or restart PiCC.",
      });
      expect(state).not.toHaveProperty("toolsAdvertised");
      expect(runtime.tools()).toEqual([]);
      const report = renderMcpStatusReport(config, runtime.serverStates());
      expect(report).not.toContain("LIST_TOOLS_EXCEPTION_CANARY");
      expect(report).not.toContain("PRIVATE_DISCOVERY_PATH");
      expect(report).not.toContain("DISCOVERY_RAW_COMMAND_CANARY");
    } finally {
      await runtime.shutdown();
    }
  });

  it("reports a safe umbrella timeout when tool discovery does not settle after initialization", async () => {
    let initialized = false;
    let discoveryAttempted = false;
    let closed = false;
    class FakeTransport {
      readonly pid = undefined;
      readonly stderr = undefined;
      constructor(_options: unknown) {}
    }
    class HangingDiscoveryClient {
      constructor(_clientInfo: unknown, _options: unknown) {}
      async connect(_transport: unknown): Promise<void> {
        initialized = true;
      }
      listTools(_params: unknown): Promise<never> {
        discoveryAttempted = true;
        return new Promise<never>(() => {});
      }
      async close(): Promise<void> {
        closed = true;
      }
    }
    const config = makeConfig(
      makeServer({ name: "discovery-timeout", rawCommand: "DISCOVERY_TIMEOUT_RAW_CANARY" }),
    );
    const runtime = McpRuntime.start(
      config,
      makeDeps({
        env: { ...cleanBaseEnv(), MCP_TIMEOUT: "20" },
        loadSdk: async () =>
          ({
            Client: HangingDiscoveryClient,
            StdioClientTransport: FakeTransport,
          }) as unknown as Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>>,
      }),
    );
    try {
      await runtime.whenSettled();
      expect(initialized).toBe(true);
      expect(discoveryAttempted).toBe(true);
      expect(closed).toBe(true);
      const state = runtime.serverStates()[0];
      expect(state).toMatchObject({
        state: "failed",
        statusSummary:
          "MCP startup timed out during connection, initialization, or capability discovery; run /doctor for details.",
      });
      const report = renderMcpStatusReport(config, runtime.serverStates());
      expect(report).toContain(state!.statusSummary!);
      expect(report).not.toContain("DISCOVERY_TIMEOUT_RAW_CANARY");
    } finally {
      await runtime.shutdown();
    }
  });

  it("times out a hung initialize, kills its tree, and leaves other servers unaffected", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "hung", args: [fixture.serverScript, "hang-initialize"], env: fixture.env, rawCommand: "hang-cmd" }),
        makeServer({ name: "healthy", args: [fixture.serverScript, "serve"], env: fixture.env }),
      ),
      // MCP_TIMEOUT is runtime-global, so it also bounds the HEALTHY server's
      // connect: under full-suite fork contention a fixture spawn (node + SDK
      // import) can take seconds, so the bound must be load-tolerant. The
      // assertions stay result-based — nothing here measures elapsed time.
      makeDeps({ env: { ...cleanBaseEnv(), MCP_TIMEOUT: "8000" } }),
    );
    try {
      await runtime.whenSettled();
      const states = new Map(runtime.serverStates().map((s) => [s.name, s]));
      expect(states.get("healthy")).toMatchObject({ state: "connected", toolCount: 3 });
      expect(states.get("hung")).toMatchObject({ state: "failed" });
      expect(states.get("hung")?.diagnostic).toMatch(/failed to connect within 8000 ms/);
      expect(states.get("hung")?.diagnostic).toContain("hang-cmd");
      expect(states.get("hung")?.statusSummary).toBe(
        "MCP startup timed out during connection, initialization, or capability discovery; run /doctor for details.",
      );
      const status = renderMcpStatusReport(
        makeConfig(makeServer({ name: "hung", rawCommand: "hang-cmd" })),
        runtime.serverStates(),
      );
      expect(status).toContain(
        "MCP startup timed out during connection, initialization, or capability discovery; run /doctor for details.",
      );
      expect(status).not.toContain("hang-cmd");
      expect(runtime.diagnostics().some((d) => d.includes('"hung"'))).toBe(true);
      // Only the healthy server's tools are exposed.
      expect(runtime.tools().every((t) => t.serverName === "healthy")).toBe(true);
      expect(runtime.tools()).toHaveLength(3);
      // The hung server's tree was killed at timeout, before shutdown.
      const hungPid = fixture.pidOf("hang-initialize.pid");
      await waitForDeath(hungPid, "hung server after connect timeout");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it("requires phase, local-close ordering, and the matching SDK code for closure classification", async () => {
    const cases = [
      { label: "server lookalike stays open", event: "server-error" },
      { label: "server lookalike then cleanup close", event: "server-error-close" },
      { label: "pre-handshake close with nonmatching code", event: "close-nonmatching" },
      { label: "post-handshake close during discovery", event: "post-handshake-close" },
      { label: "unknown numeric error", event: "unknown-numeric" },
      { label: "ordinary error", event: "ordinary" },
    ] as const;

    for (const row of cases) {
      class FakeTransport {
        readonly pid = undefined;
        readonly stderr = undefined;
        onclose?: () => void;
        onmessage?: (message: unknown) => void;
        constructor(_options: unknown) {}
      }
      class FakeClient {
        private transport: FakeTransport | undefined;
        constructor(_clientInfo: unknown, _options: unknown) {}
        async connect(transport: FakeTransport): Promise<void> {
          this.transport = transport;
          const lookalike = {
            jsonrpc: "2.0",
            id: 0,
            error: { code: -32_000, message: "SERVER_ERROR_MESSAGE_CANARY", data: "SERVER_ERROR_DATA_CANARY" },
          };
          if (row.event === "server-error" || row.event === "server-error-close") {
            transport.onmessage?.(lookalike);
            if (row.event === "server-error-close") transport.onclose?.();
            throw Object.assign(new Error("SERVER_REJECTION_CANARY"), { code: -32_000 });
          }
          if (row.event === "close-nonmatching") {
            transport.onclose?.();
            throw Object.assign(new Error("NONMATCHING_CANARY"), { code: -32_001 });
          }
          if (row.event === "unknown-numeric") {
            throw Object.assign(new Error("UNKNOWN_NUMERIC_CANARY"), { code: -32_099 });
          }
          if (row.event === "ordinary") throw new Error("ORDINARY_ERROR_CANARY");
        }
        async listTools(_params: unknown): Promise<{ tools: never[] }> {
          this.transport?.onclose?.();
          throw Object.assign(new Error("DISCOVERY_CLOSE_CANARY"), { code: -32_000 });
        }
        async close(): Promise<void> {}
      }
      const config = makeConfig(
        makeServer({ name: "ambiguous", rawCommand: "GENERIC_RAW_COMMAND_CANARY" }),
      );
      const runtime = McpRuntime.start(
        config,
        makeDeps({
          loadSdk: async () => ({
            Client: FakeClient,
            StdioClientTransport: FakeTransport,
          }) as unknown as Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>>,
        }),
      );
      try {
        await runtime.whenSettled();
        const state = runtime.serverStates()[0];
        expect(state?.statusSummary, row.label).toBe(
          "MCP startup failed during connection, initialization, or capability discovery; run /doctor for details.",
        );
        expect(state?.diagnostic ?? "", row.label).not.toContain(
          "connection closed before MCP initialization completed",
        );
        const surfaces = `${state?.diagnostic ?? ""}\n${state?.statusSummary ?? ""}`;
        for (const canary of [
          "SERVER_ERROR_MESSAGE_CANARY",
          "SERVER_ERROR_DATA_CANARY",
          "SERVER_REJECTION_CANARY",
          "NONMATCHING_CANARY",
          "UNKNOWN_NUMERIC_CANARY",
          "ORDINARY_ERROR_CANARY",
          "DISCOVERY_CLOSE_CANARY",
        ]) {
          expect(surfaces, `${row.label}: ${canary}`).not.toContain(canary);
        }
      } finally {
        await runtime.shutdown();
      }
    }
  });

  it("classifies only a locally observed pre-initialization close with fixed redacted text", async () => {
    class FakeTransport {
      readonly pid = undefined;
      readonly stderr = new PassThrough();
      onclose?: () => void;
      constructor(_options: unknown) {}
    }
    class ClosingClient {
      constructor(_clientInfo: unknown, _options: unknown) {}
      async connect(transport: FakeTransport): Promise<never> {
        transport.stderr.write("STDERR_CLOSE_CANARY");
        transport.onclose?.();
        throw Object.assign(new Error("RAW_ERROR_MESSAGE_CANARY"), {
          code: -32_000,
          data: "RAW_ERROR_DATA_CANARY",
        });
      }
      async listTools(_params: unknown): Promise<never> {
        throw new Error("unreachable");
      }
      async close(): Promise<void> {}
    }
    const config = makeConfig(
      makeServer({
        name: "closing",
        command: "C:/EXPANDED_COMMAND_PATH_CANARY/server.exe",
        args: ["ARG_CLOSE_CANARY"],
        env: { TOKEN: "ENV_CLOSE_CANARY" },
        rawCommand: "RAW_COMMAND_CLOSE_CANARY",
      }),
    );
    const runtime = McpRuntime.start(
      config,
      makeDeps({
        loadSdk: async () => ({
          Client: ClosingClient,
          StdioClientTransport: FakeTransport,
        }) as unknown as Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>>,
      }),
    );
    try {
      await runtime.whenSettled();
      const state = runtime.serverStates()[0];
      expect(state?.diagnostic).toBe(
        'MCP server "closing": connection closed before MCP initialization completed.',
      );
      expect(state?.statusSummary).toBe("Connection closed before MCP initialization completed.");
      const statusReport = renderMcpStatusReport(config, runtime.serverStates());
      expect(statusReport).toContain("Connection closed before MCP initialization completed.");
      const surfaces = `${runtime.diagnostics().join("\n")}\n${state?.statusSummary ?? ""}\n${statusReport}`;
      expect(surfaces).not.toContain("-32000");
      for (const canary of [
        "RAW_ERROR_MESSAGE_CANARY",
        "RAW_ERROR_DATA_CANARY",
        "EXPANDED_COMMAND_PATH_CANARY",
        "ARG_CLOSE_CANARY",
        "ENV_CLOSE_CANARY",
        "RAW_COMMAND_CLOSE_CANARY",
        "STDERR_CLOSE_CANARY",
      ]) {
        expect(surfaces).not.toContain(canary);
      }
    } finally {
      await runtime.shutdown();
    }
  });

  it("degrades an exiting-early server to failed without throwing", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({
          name: "quitter",
          args: [fixture.serverScript, "exit-early", "EXIT_ARG_CANARY"],
          env: { ...fixture.env, TOKEN: "EXIT_ENV_CANARY" },
          rawCommand: "EXIT_RAW_COMMAND_CANARY",
        }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({
          name: "quitter",
          state: "failed",
          statusSummary: "Connection closed before MCP initialization completed.",
        }),
      ]);
      const diagnostics = runtime.diagnostics().join("\n");
      expect(diagnostics).toContain(
        'MCP server "quitter": connection closed before MCP initialization completed.',
      );
      expect(diagnostics).not.toContain("-32000");
      for (const canary of ["EXIT_ARG_CANARY", "EXIT_ENV_CANARY", "EXIT_RAW_COMMAND_CANARY"]) {
        expect(diagnostics).not.toContain(canary);
        expect(runtime.serverStates()[0]?.statusSummary).not.toContain(canary);
      }
      expect(runtime.tools()).toEqual([]);
      await expect(runtime.callTool("quitter", "echo", {})).rejects.toThrow(/not connected/);
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it("retains a bounded stderr tail before reporting an injected connect timeout", async () => {
    const stderrMarkerObserved = deferred<void>();
    let closed = false;
    class FakeTransport {
      readonly pid = undefined;
      readonly stderr = new PassThrough();
      constructor(_options: unknown) {
        // This parent-owned observer resolves during the same synchronous data
        // emission as McpRuntime's ring handler. Promise continuations cannot
        // run until every listener for that emission has returned.
        this.stderr.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("GARBAGE_STDERR_TAIL_MARKER")) {
            stderrMarkerObserved.resolve();
          }
        });
      }
    }
    class GarbageStreamClient {
      constructor(_clientInfo: unknown, _options: unknown) {}
      async connect(transport: FakeTransport): Promise<void> {
        transport.stderr.write("y".repeat(5_000));
        transport.stderr.write("\nGARBAGE_STDERR_TAIL_MARKER\n");
        return new Promise<void>(() => {});
      }
      async listTools(_params: unknown): Promise<never> {
        throw new Error("unreachable");
      }
      async close(): Promise<void> {
        closed = true;
      }
    }
    const runtime = McpRuntime.start(
      makeConfig(makeServer({ name: "garbage", rawCommand: "garbage-cmd" })),
      makeDeps({
        env: { ...cleanBaseEnv(), MCP_TIMEOUT: "4000" },
        loadSdk: async () =>
          ({
            Client: GarbageStreamClient,
            StdioClientTransport: FakeTransport,
          }) as unknown as Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>>,
        raceWithTimeout: async (_promise, timeoutMs) => {
          expect(timeoutMs).toBe(4_000);
          await stderrMarkerObserved.promise;
          return { timedOut: true };
        },
      }),
    );
    try {
      await runtime.whenSettled();
      expect(closed).toBe(true);
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({ name: "garbage", state: "failed" }),
      ]);
      expect(runtime.tools()).toEqual([]);
      // The stderr excerpt is the RING'S TAIL, bounded: the marker (written
      // last) is present, the 5 KB flood is not, and the whole diagnostic
      // stays small.
      const diagnostic = runtime.serverStates()[0]?.diagnostic ?? "";
      expect(diagnostic).toContain("GARBAGE_STDERR_TAIL_MARKER");
      expect(diagnostic).not.toMatch(/[\n\r\t]/);
      expect(diagnostic).not.toContain("y".repeat(500));
      expect(diagnostic.length).toBeLessThanOrEqual(700);
      expect(runtime.serverStates()[0]?.statusSummary).toBe(
        "MCP startup timed out during connection, initialization, or capability discovery; run /doctor for details.",
      );
      expect(renderMcpStatusReport(makeConfig(makeServer({ name: "garbage" })), runtime.serverStates()))
        .not.toContain("GARBAGE_STDERR_TAIL_MARKER");
    } finally {
      await runtime.shutdown();
    }
  });

  it("never leaks expanded command values into diagnostics", async () => {
    const dir = makeTempDir();
    // Simulates a `${VAR}`-expanded command whose value must never surface:
    // the EXPANDED path (with the secret) does not exist, so spawn fails and
    // Node's err.message would embed it.
    const expandedSecret = path.join(dir, "picc-secret-expanded-value", "missing-server.exe");
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "leaky", command: expandedSecret, rawCommand: "${MCP_SERVER_BIN}" }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({ name: "leaky", state: "failed" }),
      ]);
      const all = runtime.diagnostics().join("\n");
      expect(all).toContain('"leaky"');
      expect(all).toContain("${MCP_SERVER_BIN}");
      expect(all).not.toContain("picc-secret-expanded-value");
      const state = runtime.serverStates()[0];
      expect(state?.diagnostic ?? "").not.toContain("picc-secret-expanded-value");
      expect(state?.statusSummary).toBe(
        "MCP startup failed during connection, initialization, or capability discovery; run /doctor for details.",
      );
      const report = renderMcpStatusReport(
        makeConfig(makeServer({ name: "leaky", command: expandedSecret })),
        runtime.serverStates(),
      );
      expect(report).not.toContain("picc-secret-expanded-value");
      expect(report).not.toContain("${MCP_SERVER_BIN}");
    } finally {
      await runtime.shutdown();
    }
  }, 25_000);

  it("sanitizes tool names Claude-style, dedupes first-wins, and bounds descriptions and diagnostics", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "hostile", args: [fixture.serverScript, "hostile-tools"], env: fixture.env }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        { name: "hostile", transport: "stdio", state: "connected", toolsAdvertised: true, promptsAdvertised: false, resourcesAdvertised: false, toolCount: 8 },
      ]);
      const tools = runtime.tools();
      const names = tools.map((t) => t.toolName);
      // Claude parity (binary-verified 2.1.218): characters outside
      // [A-Za-z0-9_-] become "_" and the tool is KEPT — deny-rule-compatible
      // naming without drops.
      expect(names).toContain("dot_name"); // dot.name sanitized
      expect(names).toContain("white_space"); // space sanitized
      expect(names).toContain("star_name"); // glob char sanitized
      expect(names).toContain("ctrl_name"); // control char sanitized
      expect(names).toContain(`long${"_".repeat(300)}`); // long hostile name sanitized, kept
      // "_" is itself a legal character, so "__" survives verbatim (as in Claude).
      expect(names).toContain("bad__tool");
      // Empty-after-sanitize is the only drop.
      expect(names).toHaveLength(8);
      // First definition wins on duplicates — including the post-sanitize
      // collision: literal "dot_name" arrived after sanitized "dot.name".
      expect(tools.find((t) => t.toolName === "good")?.description).toBe("first");
      expect(tools.find((t) => t.toolName === "dot_name")?.description).toBe("dotted");
      // Description bounded (2 KB + Claude's exact truncation suffix) and
      // escape-stripped.
      const verbose = tools.find((t) => t.toolName === "verbose")!;
      expect(verbose.description.endsWith("… [truncated]")).toBe(true);
      expect(verbose.description.length).toBeLessThanOrEqual(2_048 + "… [truncated]".length);
      expect(verbose.description).not.toContain("\u001b");
      const all = runtime.diagnostics();
      const joined = all.join("\n");
      expect(joined).toContain("dot.name");
      expect(joined).toContain("white space");
      expect(joined).toMatch(/duplicate tool name "good"/);
      expect(joined).toMatch(/duplicate tool name "dot_name"/);
      // Diagnostics quote BOUNDED name slices (200 chars each; the sanitize
      // line quotes the raw AND sanitized form): the 304-char hostile name
      // never appears in full, and no diagnostic line grows unbounded.
      expect(joined).not.toContain("*".repeat(250));
      for (const line of all) expect(line.length).toBeLessThanOrEqual(600);
      // Per-server diagnostic cap: after 5, the rest collapse into a summary.
      expect(joined).toContain("and 3 more");
      expect(joined).not.toContain("star*name");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);
});

// ---------------------------------------------------------------------------
// Tool-call timeouts
// ---------------------------------------------------------------------------

describe("McpRuntime tool-call timeouts", () => {
  it("applies the minimum clamp through the real SDK timeout while the tool stays gated", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({
          name: "slowpoke",
          args: [fixture.serverScript, "slow-tool"],
          env: fixture.env,
          timeoutMs: 1,
        }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      const call = runtime.callTool("slowpoke", "slow", {});
      await fixture.waitFor(["slow.entered"], "slow tool to enter before its SDK timeout");
      await expect(call).rejects.toThrow(
        'MCP tool "slow" on server "slowpoke" timed out after 1000 ms',
      );
      expect(fixture.exists("slow.done")).toBe(false);
      fixture.release("slow");
      await fixture.waitFor(["slow.done"], "slow tool to finish after timeout release");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup("slow");
    }
  }, 25_000);

  it("forwards settings.env and per-server timeout precedence to the SDK without elapsed waits", async () => {
    const cases = [
      { label: "default", settingsEnv: {}, expected: 100_000_000 },
      { label: "settings environment", settingsEnv: { MCP_TOOL_TIMEOUT: "2500" }, expected: 2_500 },
      {
        label: "per-server precedence",
        settingsEnv: { MCP_TOOL_TIMEOUT: "2500" },
        serverTimeoutMs: 3_500,
        expected: 3_500,
      },
      { label: "minimum clamp", settingsEnv: {}, serverTimeoutMs: 1, expected: 1_000 },
      { label: "maximum clamp", settingsEnv: {}, serverTimeoutMs: 9_999_999_999, expected: 2_147_483_647 },
    ] as const;

    for (const row of cases) {
      const forwardedTimeouts: number[] = [];
      const runtime = McpRuntime.start(
        makeConfig(
          makeServer({
            name: "fake",
            ...("serverTimeoutMs" in row ? { timeoutMs: row.serverTimeoutMs } : {}),
          }),
        ),
        makeDeps({
          settingsEnv: row.settingsEnv,
          loadSdk: async () => fakeToolSdk({ forwardedTimeouts }),
        }),
      );
      try {
        await runtime.whenSettled();
        await runtime.callTool("fake", "fake-tool", { label: row.label });
        expect(forwardedTimeouts, row.label).toEqual([row.expected]);
      } finally {
        await runtime.shutdown();
      }
    }
  });

  it("classifies the SDK timeout code with the resolved timeout and no upstream text", async () => {
    const forwardedTimeouts: number[] = [];
    const timeoutError = Object.assign(new Error("UPSTREAM_TIMEOUT_CANARY"), { code: -32_001 });
    const runtime = McpRuntime.start(
      makeConfig(makeServer({ name: "fake" })),
      makeDeps({
        settingsEnv: { MCP_TOOL_TIMEOUT: "2500" },
        loadSdk: async () => fakeToolSdk({ forwardedTimeouts, callError: timeoutError }),
      }),
    );
    try {
      await runtime.whenSettled();
      const rejection = await runtime.callTool("fake", "fake-tool", {}).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe(
        'MCP tool "fake-tool" on server "fake" timed out after 2500 ms',
      );
      expect((rejection as Error).message).not.toContain("UPSTREAM_TIMEOUT_CANARY");
      expect(forwardedTimeouts).toEqual([2_500]);
      expect(runtime.diagnostics().join("\n")).not.toContain("UPSTREAM_TIMEOUT_CANARY");
    } finally {
      await runtime.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Prompt and resource live operations
// ---------------------------------------------------------------------------

describe("McpRuntime prompt/resource live operations", () => {
  it.each(["prompt", "resource"] as const)(
    "forwards exact %s requests and the shared resolved timeout, then classifies SDK timeout safely",
    async (operation) => {
      const requests: unknown[] = [];
      const timeouts: number[] = [];
      let operationCalls = 0;
      class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
      class FakeClient {
        async connect(): Promise<void> {}
        getServerCapabilities() { return operation === "prompt" ? { prompts: {} } : { resources: {} }; }
        async listPrompts() { return { prompts: [{ name: "raw.prompt" }] }; }
        async listResources() { return { resources: [{ uri: "opaque://listed", name: "listed" }] }; }
        async getPrompt(params: unknown, options: { timeout: number }) {
          return this.operate(params, options);
        }
        async readResource(params: unknown, options: { timeout: number }) {
          return this.operate(params, options);
        }
        private async operate(params: unknown, options: { timeout: number }) {
          requests.push(params);
          timeouts.push(options.timeout);
          operationCalls += 1;
          if (operationCalls === 2) {
            throw Object.assign(new Error("UPSTREAM_TIMEOUT_CANARY"), { code: -32_001 });
          }
          return operation === "prompt" ? { messages: [] } : { contents: [] };
        }
        async close(): Promise<void> {}
      }
      const runtime = McpRuntime.start(makeConfig(makeServer({ name: "live" })), makeDeps({
        settingsEnv: { MCP_TOOL_TIMEOUT: "2500" },
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      }));
      try {
        await runtime.whenSettled();
        const invoke = () => operation === "prompt"
          ? runtime.getPrompt("live", "raw.prompt", { one: "1", two: "2" })
          : runtime.readResource("live", "opaque://not-parsed/../value");
        await expect(invoke()).resolves.toEqual(operation === "prompt" ? { messages: [] } : { contents: [] });
        expect(requests[0]).toEqual(operation === "prompt"
          ? { name: "raw.prompt", arguments: { one: "1", two: "2" } }
          : { uri: "opaque://not-parsed/../value" });
        await expect(invoke()).rejects.toThrow(
          operation === "prompt"
            ? 'MCP prompt "raw.prompt" on server "live" timed out after 2500 ms'
            : 'MCP resource read on server "live" timed out after 2500 ms',
        );
        expect(timeouts).toEqual([2_500, 2_500]);
        expect(runtime.diagnostics().join("\n")).not.toContain("UPSTREAM_TIMEOUT_CANARY");
        if (operation === "prompt") {
          await expect(runtime.getPrompt("live", "missing", {})).rejects.toThrow(/has no prompt "missing"/);
        }
        await expect(runtime.readResource("missing", "opaque:any")).rejects.toThrow(/not running/);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("rejects control-bearing resource URIs and bounds caller-controlled identifiers", async () => {
    let reads = 0;
    class FakeTransport { readonly pid = undefined; readonly stderr = undefined; }
    class FakeClient {
      async connect(): Promise<void> {}
      getServerCapabilities() { return { prompts: {}, resources: {}, tools: {} }; }
      async listPrompts() { return { prompts: [{ name: "known" }] }; }
      async listResources() { return { resources: [] }; }
      async listTools() { return { tools: [{ name: "known" }] }; }
      async readResource({ uri }: { uri: string }) { reads += 1; return { contents: [{ uri }] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(makeServer({ name: "bounded" })), makeDeps({
      loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
    }));
    const huge = `prefix-${"x".repeat(10_000)}-suffix`;
    try {
      await runtime.whenSettled();
      await expect(runtime.readResource("bounded", "opaque://clean/%2e%2e/value")).resolves.toEqual({
        contents: [{ uri: "opaque://clean/%2e%2e/value" }],
      });
      await expect(runtime.readResource("bounded", "opaque://bad\nvalue")).rejects.toThrow(/display-control/);
      expect(reads).toBe(1);
      for (const reject of [
        () => runtime.callTool("bounded", huge, {}),
        () => runtime.getPrompt("bounded", huge, {}),
        () => runtime.callTool(huge, "known", {}),
      ]) {
        const error = await reject().then(() => undefined, (value: unknown) => value as Error);
        expect(error?.message.length).toBeLessThan(500);
        expect(error?.message).toContain("prefix-");
        expect(error?.message).not.toContain("-suffix");
      }
    } finally {
      await runtime.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// Kill discipline
// ---------------------------------------------------------------------------

describe("McpRuntime kill discipline", () => {
  it("kills the server AND its grandchild on shutdown (both platforms)", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "family", args: [fixture.serverScript, "spawn-grandchild"], env: fixture.env }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        { name: "family", transport: "stdio", state: "connected", toolsAdvertised: true, promptsAdvertised: false, resourcesAdvertised: false, toolCount: 3 },
      ]);
      await fixture.waitFor(
        ["spawn-grandchild.pid", "grandchild.pid"],
        "server and grandchild pids to publish",
      );
      const serverPid = fixture.pidOf("spawn-grandchild.pid");
      const grandchildPid = fixture.pidOf("grandchild.pid");
      expect(processIsAlive(serverPid)).toBe(true);
      expect(processIsAlive(grandchildPid)).toBe(true);
      const cleanupOutcome = await runtime.shutdownAgent();
      expect(cleanupOutcome).toEqual({ confirmed: ["family"], unconfirmed: [], diagnostics: [] });
      await waitForDeath(serverPid, "grandchild-spawning server after shutdown");
      await waitForDeath(grandchildPid, "grandchild after shutdown");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it.skipIf(process.platform !== "win32")(
    "awaits Windows tree termination before sweeping the captured root",
    async () => {
      const testDepsKey = Symbol.for("picc.test.mcp-process-cleanup");
      const treeKill = deferred<void>();
      const events: string[] = [];
      let now = 0;
      let probes = 0;
      const pid = 4_000_000;
      class FakeTransport {
        readonly pid = pid;
        readonly stderr = undefined;
      }
      class FakeClient {
        async connect(): Promise<void> {}
        async listTools(): Promise<{ tools: never[] }> { return { tools: [] }; }
        async close(): Promise<void> {}
      }
      const deps = makeDeps({
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      });
      Object.defineProperty(deps, testDepsKey, {
        value: {
          snapshot: (target: number) => [target],
          killTree: async () => {
            events.push("tree-start");
            await treeKill.promise;
            now = 4_990;
            events.push("tree-done");
            return true;
          },
          kill: (_target: number, signal: 0 | "SIGKILL") => {
            events.push(String(signal));
            if (signal === 0 && probes++ > 0) {
              throw Object.assign(new Error("gone"), { code: "ESRCH" });
            }
          },
          now: () => now,
          delay: async (delayMs: number) => {
            events.push(`delay:${delayMs}`);
            now += delayMs;
          },
        },
      });
      const runtime = McpRuntime.start(makeConfig(makeServer({ name: "awaited-tree" })), deps);
      await runtime.whenSettled();

      const shutdown = runtime.shutdownAgent();
      await waitUntil({
        description: "Windows MCP tree cleanup to start",
        predicate: () => events.includes("tree-start"),
      });
      expect(events).toEqual(["tree-start"]);

      treeKill.resolve();
      await expect(shutdown).resolves.toEqual({
        confirmed: ["awaited-tree"], unconfirmed: [], diagnostics: [],
      });
      expect(events).toEqual([
        "tree-start", "tree-done", "SIGKILL", "0", "delay:10", "0",
      ]);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "keeps failed Windows tree termination unconfirmed and retries the tree operation",
    async () => {
      const testDepsKey = Symbol.for("picc.test.mcp-process-cleanup");
      const treeKillResults = [false, true];
      const treeKillBudgets: number[] = [];
      const cleanupSignals: Array<0 | "SIGKILL"> = [];
      let closeCalls = 0;
      const pid = 4_000_003;
      class FakeTransport {
        readonly pid = pid;
        readonly stderr = undefined;
      }
      class FakeClient {
        async connect(): Promise<void> {}
        async listTools(): Promise<{ tools: never[] }> { return { tools: [] }; }
        async close(): Promise<void> { closeCalls += 1; }
      }
      const deps = makeDeps({
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      });
      Object.defineProperty(deps, testDepsKey, {
        value: {
          snapshot: (target: number) => [target],
          killTree: (_target: number, maxWaitMs: number) => {
            treeKillBudgets.push(maxWaitMs);
            return treeKillResults.shift() ?? false;
          },
          kill: (_target: number, signal: 0 | "SIGKILL") => {
            cleanupSignals.push(signal);
            if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
          },
          now: () => 0,
          delay: async () => {},
        },
      });
      const runtime = McpRuntime.start(makeConfig(makeServer({ name: "uncertain-tree" })), deps);
      await runtime.whenSettled();

      await expect(runtime.shutdownAgent()).resolves.toEqual({
        confirmed: [],
        unconfirmed: ["uncertain-tree"],
        diagnostics: ["Cleanup could not be confirmed for 1 agent MCP server(s)."],
      });
      expect(treeKillBudgets).toEqual([5_000]);
      expect(cleanupSignals).toEqual([]);
      expect(closeCalls).toBe(0);

      await expect(runtime.retryAgentShutdown(["uncertain-tree"])).resolves.toEqual({
        confirmed: ["uncertain-tree"], unconfirmed: [], diagnostics: [],
      });
      expect(treeKillBudgets).toEqual([5_000, 5_000]);
      expect(cleanupSignals).toEqual(["SIGKILL", 0]);
      expect(closeCalls).toBe(1);
    },
  );

  it("confirms PID cleanup only after absence and retains bounded uncertainty for retry", async () => {
    const testDepsKey = Symbol.for("picc.test.mcp-process-cleanup");
    type TestProcessCleanup = {
      snapshot(pid: number): readonly number[];
      killTree(pid: number, maxWaitMs: number): boolean | Promise<boolean>;
      kill(pid: number, signal: 0 | "SIGKILL"): void;
      now(): number;
      delay(delayMs: number): Promise<void>;
    };
    const startRuntime = async (pid: number, cleanup: TestProcessCleanup): Promise<McpRuntime> => {
      class FakeTransport {
        readonly pid = pid;
        readonly stderr = undefined;
      }
      class FakeClient {
        async connect(): Promise<void> {}
        async listTools(): Promise<{ tools: never[] }> { return { tools: [] }; }
        async close(): Promise<void> {}
      }
      const deps = makeDeps({
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
      });
      Object.defineProperty(deps, testDepsKey, { value: cleanup });
      const runtime = McpRuntime.start(makeConfig(makeServer({ name: `policy-${pid}` })), deps);
      await runtime.whenSettled();
      return runtime;
    };

    const settlingCalls: Array<0 | "SIGKILL"> = [];
    let settlingProbe = 0;
    const settlingRuntime = await startRuntime(4_000_001, {
      snapshot: (pid) => [pid],
      killTree: () => true,
      kill: (_pid, signal) => {
        settlingCalls.push(signal);
        if (signal === "SIGKILL") return;
        if (settlingProbe++ === 0) return;
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
      now: () => 0,
      delay: async () => {},
    });
    await expect(settlingRuntime.shutdownAgent()).resolves.toEqual({
      confirmed: ["policy-4000001"], unconfirmed: [], diagnostics: [],
    });
    expect(settlingCalls).toEqual(["SIGKILL", 0, 0]);

    const retainedCalls: Array<0 | "SIGKILL"> = [];
    const retainedProbeKinds: string[] = [];
    let policyNow = 0;
    let retrying = false;
    const retainedRuntime = await startRuntime(4_000_002, {
      snapshot: (pid) => [pid],
      killTree: () => true,
      kill: (_pid, signal) => {
        retainedCalls.push(signal);
        if (signal === "SIGKILL") return;
        if (retrying) {
          retainedProbeKinds.push("absent");
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        const probe = retainedProbeKinds.length;
        if (probe === 0) {
          retainedProbeKinds.push("present");
          return;
        }
        if (probe === 1) {
          retainedProbeKinds.push("eperm");
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        }
        retainedProbeKinds.push("unknown");
        throw new Error("unclassified probe failure");
      },
      now: () => policyNow,
      delay: async () => { policyNow += 2_000; },
    });
    await expect(retainedRuntime.shutdownAgent()).resolves.toEqual({
      confirmed: [],
      unconfirmed: ["policy-4000002"],
      diagnostics: ["Cleanup could not be confirmed for 1 agent MCP server(s)."],
    });
    expect(retainedProbeKinds).toEqual(["present", "eperm", "unknown", "unknown"]);
    expect(retainedCalls.filter((signal) => signal === "SIGKILL")).toHaveLength(1);

    retrying = true;
    await expect(retainedRuntime.retryAgentShutdown(["policy-4000002"])).resolves.toEqual({
      confirmed: ["policy-4000002"], unconfirmed: [], diagnostics: [],
    });
    const callsAfterConfirmation = [...retainedCalls];
    await expect(retainedRuntime.retryAgentShutdown(["policy-4000002"])).resolves.toEqual({
      confirmed: ["policy-4000002"], unconfirmed: [], diagnostics: [],
    });
    expect(retainedCalls).toEqual(callsAfterConfirmation);
    expect(retainedCalls.filter((signal) => signal === "SIGKILL")).toHaveLength(1);
  });

  it("shutdown is idempotent, safe to call twice concurrently, and truthful afterwards", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const config = makeConfig(
      makeServer({
        name: "fixture",
        args: [fixture.serverScript, "serve"],
        env: fixture.env,
        rawCommand: "CONNECTED_SHUTDOWN_RAW_CANARY",
      }),
    );
    const runtime = McpRuntime.start(config, makeDeps());
    try {
      await runtime.whenSettled();
      const pid = fixture.pidOf("serve.pid");
      await Promise.all([runtime.shutdown(), runtime.shutdown()]);
      await runtime.shutdown();
      await waitForDeath(pid, "server after repeated shutdown");
      // Post-shutdown truthfulness: a killed server must not keep reporting
      // "connected", and its tools disappear.
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({
          name: "fixture",
          state: "failed",
          diagnostic: expect.stringMatching(/shut down/),
          statusSummary: "Connection closed because the session shut down.",
        }),
      ]);
      expect(runtime.tools()).toEqual([]);
      expect(renderMcpStatusReport(config, runtime.serverStates())).not.toContain(
        "CONNECTED_SHUTDOWN_RAW_CANARY",
      );
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it("re-evaluates no-PID stdio close completion and reports only safe identities", async () => {
    const closeGate = deferred<void>();
    let cleanupRaces = 0;
    class FakeTransport {
      readonly pid = undefined;
      readonly stderr = undefined;
    }
    class FakeClient {
      async connect(): Promise<void> {}
      async listTools(): Promise<{ tools: never[] }> { return { tools: [] }; }
      async close(): Promise<void> { await closeGate.promise; }
    }
    const runtime = McpRuntime.start(
      makeConfig(makeServer({
        name: "safe-identity",
        rawCommand: "RAW_COMMAND_SECRET",
        env: { TOKEN: "ENV_SECRET" },
      })),
      makeDeps({
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
        raceCleanup: async (completion) => ++cleanupRaces === 1 ? false : await completion,
      }),
    );
    await runtime.whenSettled();
    const first = await runtime.shutdownAgent();
    expect(first).toEqual({
      confirmed: [],
      unconfirmed: ["safe-identity"],
      diagnostics: ["Cleanup could not be confirmed for 1 agent MCP server(s)."],
    });
    expect(first.diagnostics.join(" ")).not.toMatch(/RAW_COMMAND_SECRET|ENV_SECRET/u);
    closeGate.resolve();
    await expect(runtime.retryAgentShutdown(["safe-identity"])).resolves.toEqual({
      confirmed: ["safe-identity"], unconfirmed: [], diagnostics: [],
    });
    expect(cleanupRaces).toBe(2);
  });

  it("retries uncertain servers concurrently within one injected aggregate grace", async () => {
    const retryGrace = deferred<boolean>();
    let cleanupRaces = 0;
    let retryEntrants = 0;
    class FakeTransport {
      readonly pid = undefined;
      readonly stderr = undefined;
    }
    class FakeClient {
      async connect(): Promise<void> {}
      async listTools(): Promise<{ tools: never[] }> { return { tools: [] }; }
      async close(): Promise<never> { return await new Promise<never>(() => {}); }
    }
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "first-uncertain" }),
        makeServer({ name: "second-uncertain" }),
      ),
      makeDeps({
        loadSdk: async () => ({ Client: FakeClient, StdioClientTransport: FakeTransport }) as never,
        raceCleanup: async () => {
          cleanupRaces += 1;
          if (cleanupRaces <= 2) return false;
          retryEntrants += 1;
          return await retryGrace.promise;
        },
      }),
    );
    await runtime.whenSettled();
    expect((await runtime.shutdownAgent()).unconfirmed).toEqual(["first-uncertain", "second-uncertain"]);
    const retry = runtime.retryAgentShutdown(["first-uncertain", "second-uncertain"]);
    await waitUntil({
      description: "all uncertain cleanup retries to enter the shared grace concurrently",
      predicate: () => retryEntrants === 2,
    });
    retryGrace.resolve(false);
    await expect(retry).resolves.toEqual({
      confirmed: [],
      unconfirmed: ["first-uncertain", "second-uncertain"],
      diagnostics: ["Cleanup could not be confirmed for 2 agent MCP server(s)."],
    });
    expect(cleanupRaces).toBe(4);
  });

  it("a shutdown racing the SDK import prevents any spawn and restores the exit listener", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const exitListenerBaseline = process.listenerCount("exit");
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "raced", args: [fixture.serverScript, "serve"], env: fixture.env }),
      ),
      makeDeps(),
    );
    try {
      // No marker waiting: connectAll is parked at the dynamic SDK import()
      // and shutdown() lands in that window. The stopped-flag guard must keep
      // connectOne from spawning a server that would outlive the session.
      await runtime.shutdown();
      await runtime.whenSettled();
      expect(process.listenerCount("exit")).toBe(exitListenerBaseline);
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({ name: "raced", state: "failed" }),
      ]);
      // Brief observation window: a leaked spawn would publish its pid marker.
      // Any pid that does appear must die; none should appear at all.
      await new Promise((resolve) => setTimeout(resolve, 600));
      for (const pid of fixture.publishedPids()) {
        await waitForDeath(pid, "server spawned despite pre-import shutdown");
      }
      expect(fixture.publishedPids()).toEqual([]);
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);
});


describe("McpRuntime remote retry and recovery", () => {
  class StreamableHTTPError extends Error {
    readonly status: number;
    constructor(status: number) {
      super("REMOTE_SPEECH_CANARY");
      this.status = status;
    }
  }

  type RemoteOutcome = "ok" | number | Error | Promise<void>;

  function remoteHarness(options: {
    connect: RemoteOutcome[];
    discover?: RemoteOutcome[];
    calls?: RemoteOutcome[];
    closes?: RemoteOutcome[];
    catalogs?: string[][];
    capabilities?: { tools?: object; prompts?: object; resources?: object };
  }) {
    const disconnects: Array<(event: { kind: "graceful-eof" | "abrupt-stream-failure" }) => void> = [];
    const transportErrors: Array<(error: Error) => void> = [];
    const closed: number[] = [];
    const aborted: number[] = [];
    let clients = 0;
    let discoveryCount = 0;
    let callCount = 0;
    const events: string[] = [];
    const run = async (outcome: RemoteOutcome | undefined): Promise<void> => {
      if (outcome === undefined || outcome === "ok") return;
      if (typeof outcome === "number") throw new StreamableHTTPError(outcome);
      if (outcome instanceof Error) throw outcome;
      await outcome;
    };
    class FakeRemoteClient {
      readonly index: number;
      constructor() {
        this.index = clients++;
        events.push(`client:${this.index}`);
      }
      async connect(): Promise<void> { await run(options.connect[this.index]); }
      getServerCapabilities(): { tools?: object; prompts?: object; resources?: object } {
        return options.capabilities ?? { tools: {} };
      }
      async listTools(): Promise<{ tools: Array<{ name: string; description: string; inputSchema: object }> }> {
        await run(options.discover?.[discoveryCount++]);
        return {
          tools: (options.catalogs?.[this.index] ?? ["alpha"]).map((name) => ({
            name,
            description: `catalog-${this.index}`,
            inputSchema: { type: "object", title: `schema-${this.index}` },
          })),
        };
      }
      async listPrompts(): Promise<{ prompts: Array<{ name: string; arguments: Array<{ name: string }> }> }> {
        await run(options.discover?.[discoveryCount++]);
        return { prompts: (options.catalogs?.[this.index] ?? ["fixture-prompt"]).map((name) => ({
          name,
          arguments: [{ name: `argument-${this.index}` }],
        })) };
      }
      async listResources(): Promise<{ resources: Array<{ uri: string; name: string }> }> {
        await run(options.discover?.[discoveryCount++]);
        return { resources: (options.catalogs?.[this.index] ?? ["resource"]).map((name) => ({
          uri: `fixture://${name}`,
          name: `${name}-${this.index}`,
        })) };
      }
      async callTool(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        await run(options.calls?.[callCount++]);
        return { content: [{ type: "text", text: `client-${this.index}` }] };
      }
      async getPrompt(): Promise<{ messages: Array<{ role: "user"; content: { type: "text"; text: string } }> }> {
        await run(options.calls?.[callCount++]);
        return { messages: [{ role: "user", content: { type: "text", text: `client-${this.index}` } }] };
      }
      async readResource(): Promise<{ contents: Array<{ uri: string; text: string }> }> {
        await run(options.calls?.[callCount++]);
        return { contents: [{ uri: "fixture://resource", text: `client-${this.index}` }] };
      }
      async close(): Promise<void> {
        closed.push(this.index);
        events.push(`close:${this.index}`);
        await run(options.closes?.[this.index]);
      }
    }
    const createRemoteTransport: NonNullable<McpRuntimeDeps["createRemoteTransport"]> = async (config) => {
      const index = disconnects.length;
      expect(config.transportKind).toBe(config.configuredType === "sse" ? "sse" : "http");
      let listener: ((event: { kind: "graceful-eof" | "abrupt-stream-failure" }) => void) | undefined;
      let errorListener: ((error: Error) => void) | undefined;
      disconnects.push((event) => listener?.(event));
      transportErrors.push((error) => errorListener?.(error));
      return {
        transportKind: config.transportKind,
        deprecated: config.transportKind === "sse",
        onDisconnect(next: (event: { kind: "graceful-eof" | "abrupt-stream-failure" }) => void) { listener = next; return () => { listener = undefined; }; },
        get onerror() { return errorListener; },
        set onerror(next) { errorListener = next; },
        abort: async () => { aborted.push(index); },
        close: async () => {},
        start: async () => {},
        send: async () => {},
      } as never;
    };
    return {
      FakeRemoteClient,
      createRemoteTransport,
      disconnects,
      transportErrors,
      closed,
      aborted,
      events,
      clientCount: () => clients,
      discoveryCount: () => discoveryCount,
      callCount: () => callCount,
    };
  }

  it("joins a delayed remote close begun by recovery before confirming agent shutdown", async () => {
    const priorClose = deferred<void>();
    const harness = remoteHarness({ connect: ["ok"], closes: [priorClose.promise] });
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "delayed-prior-close" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      raceCleanup: async (completion) => await completion,
    }));
    await runtime.whenSettled();
    harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
    await waitUntil({ description: "recovery to begin prior remote close", predicate: () => harness.closed.includes(0) });
    let settled = false;
    const shutdown = runtime.shutdownAgent().finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    priorClose.resolve();
    await expect(shutdown).resolves.toEqual({
      confirmed: ["delayed-prior-close"], unconfirmed: [], diagnostics: [],
    });
  });

  it("retains a hung prior remote close as unconfirmed across shutdown and retry", async () => {
    const harness = remoteHarness({ connect: ["ok"], closes: [new Promise<void>(() => {})] });
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "hung-prior-close" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      raceCleanup: async () => false,
    }));
    await runtime.whenSettled();
    harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
    await waitUntil({ description: "recovery to begin hung remote close", predicate: () => harness.closed.includes(0) });
    await expect(runtime.shutdownAgent()).resolves.toEqual({
      confirmed: [],
      unconfirmed: ["hung-prior-close"],
      diagnostics: ["Cleanup could not be confirmed for 1 agent MCP server(s)."],
    });
    await expect(runtime.retryAgentShutdown(["hung-prior-close"])).resolves.toEqual({
      confirmed: [],
      unconfirmed: ["hung-prior-close"],
      diagnostics: ["Cleanup could not be confirmed for 1 agent MCP server(s)."],
    });
  });

  it("classifies fatal initial tools/list discovery identically for remote startup", async () => {
    const harness = remoteHarness({
      connect: ["ok"],
      discover: [new Error("REMOTE_TOOLS_LIST_SPEECH_CANARY")],
    });
    const config = makeConfig(makeRemoteServer({ name: "remote-discovery-failure" }));
    const runtime = McpRuntime.start(config, makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
    }));
    try {
      await runtime.whenSettled();
      const state = runtime.serverStates()[0];
      expect(state).toMatchObject({
        state: "failed",
        initialToolDiscoveryFailed: true,
        statusSummary:
          "Initial tools/list discovery failed; check the server configuration and logs, then run /reload or restart PiCC.",
      });
      const report = renderMcpStatusReport(config, runtime.serverStates());
      expect(report).toContain("Initial tools/list discovery failed");
      expect(report).toContain("/reload or restart PiCC");
      expect(JSON.stringify(state)).not.toContain("REMOTE_TOOLS_LIST_SPEECH_CANARY");
      expect(report).not.toContain("REMOTE_TOOLS_LIST_SPEECH_CANARY");
    } finally {
      await runtime.shutdown();
    }
  });

  it("round-trips an agent-inline remote through startAgent, discovery, call, and shutdown", async () => {
    const fixture = await createMcpRemoteServer();
    const agentConfig: ResolvedAgentMcpConfig = {
      servers: [{
        name: "loopback", source: "subagent-inline", status: "enabled", transport: "http",
        configuredType: "http", url: fixture.streamableUrl, headers: {}, diagnostics: [],
      }],
      diagnostics: [],
      diagnosticOwnership: [],
    };
    const runtime = McpRuntime.startAgent(agentConfig, makeDeps());
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        { name: "loopback", transport: "http", state: "connected", toolsAdvertised: true, promptsAdvertised: false, resourcesAdvertised: false, toolCount: 1 },
      ]);
      expect(runtime.tools()).toEqual([
        expect.objectContaining({
          serverName: "loopback",
          toolName: "echo",
          description: "Returns its arguments.",
        }),
      ]);
      expect(firstText(await runtime.callTool("loopback", "echo", { value: 7 }))).toBe(
        '{"value":7}',
      );
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
    await waitUntil({
      description: "loopback adapter cleanup",
      predicate: () => fixture.stats().sockets === 0,
    });
    expect(fixture.stats()).toEqual({ listenerOpen: false, sockets: 0, streams: 0, timers: 0 });
  });

  it.each(["prompt", "resource"] as const)(
    "recovers a transient %s operation, retains its initial catalog, and routes through the replacement client",
    async (operation) => {
      const capabilities = operation === "prompt" ? { prompts: {} } : { resources: {} };
      const harness = remoteHarness({
        connect: ["ok", "ok"],
        calls: [new StreamableHTTPError(503), "ok"],
        capabilities,
        catalogs: operation === "prompt"
          ? [["fixture-prompt"], ["fixture-prompt", "replacement-only"]]
          : [["resource"], ["resource", "replacement-only"]],
      });
      const delays: number[] = [];
      const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: `live-${operation}` })), makeDeps({
        loadRemoteClient: async () => harness.FakeRemoteClient as never,
        createRemoteTransport: harness.createRemoteTransport,
        delay: async (ms) => { delays.push(ms); },
      }));
      try {
        await runtime.whenSettled();
        const initialCatalog = operation === "prompt" ? runtime.prompts() : runtime.resourceServers();
        const initialServerEntry = operation === "resource" ? runtime.resourceServers()[0]! : undefined;
        const initialEntry = operation === "prompt"
          ? runtime.prompts()[0]!
          : initialServerEntry!.resources[0]!;
        const initialNestedArray = operation === "prompt"
          ? runtime.prompts()[0]!.arguments
          : runtime.resourceServers()[0]!.resources;
        const invoke = () => operation === "prompt"
          ? runtime.getPrompt(`live-${operation}`, "fixture-prompt", {})
          : runtime.readResource(`live-${operation}`, "fixture://resource");
        await expect(invoke()).rejects.toThrow(/temporarily unavailable while reconnecting/);
        await waitUntil({
          description: `${operation} recovery to publish replacement client`,
          predicate: () => harness.clientCount() === 2 && runtime.serverStates()[0]?.state === "connected",
        });
        expect(delays).toEqual([1_000]);
        expect(operation === "prompt" ? runtime.prompts() : runtime.resourceServers()).toEqual(initialCatalog);
        const currentServerEntry = operation === "resource" ? runtime.resourceServers()[0]! : undefined;
        const currentEntry = operation === "prompt"
          ? runtime.prompts()[0]!
          : currentServerEntry!.resources[0]!;
        const currentNestedArray = operation === "prompt"
          ? runtime.prompts()[0]!.arguments
          : runtime.resourceServers()[0]!.resources;
        expect(currentEntry).toBe(initialEntry);
        if (operation === "resource") expect(currentServerEntry).toBe(initialServerEntry);
        expect(currentNestedArray).toBe(initialNestedArray);
        expect(Object.isFrozen(operation === "prompt" ? runtime.prompts() : runtime.resourceServers())).toBe(true);
        expect(Object.isFrozen(currentEntry)).toBe(true);
        expect(Object.isFrozen(currentNestedArray)).toBe(true);
        expect(JSON.stringify(operation === "prompt" ? runtime.prompts() : runtime.resourceServers()))
          .not.toContain("replacement-only");
        const result = await invoke();
        expect(JSON.stringify(result)).toContain("client-1");
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it.each(["prompt", "resource"] as const)(
    "rejects late stale %s success after client replacement",
    async (operation) => {
      const callGate = deferred<void>();
      const capabilities = operation === "prompt" ? { prompts: {} } : { resources: {} };
      const harness = remoteHarness({ connect: ["ok", "ok"], calls: [callGate.promise], capabilities });
      const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: `stale-${operation}` })), makeDeps({
        loadRemoteClient: async () => harness.FakeRemoteClient as never,
        createRemoteTransport: harness.createRemoteTransport,
        delay: async () => undefined,
      }));
      try {
        await runtime.whenSettled();
        const pending = operation === "prompt"
          ? runtime.getPrompt(`stale-${operation}`, "fixture-prompt", {})
          : runtime.readResource(`stale-${operation}`, "fixture://resource");
        await waitUntil({ description: `${operation} call to enter`, predicate: () => harness.callCount() === 1 });
        harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
        await waitUntil({
          description: `${operation} replacement client`,
          predicate: () => harness.clientCount() === 2 && runtime.serverStates()[0]?.state === "connected",
        });
        callGate.resolve();
        await expect(pending).rejects.toThrow(/connection was replaced/);
      } finally {
        callGate.resolve();
        await runtime.shutdown();
      }
    },
  );

  it.each(["prompt", "resource"] as const)(
    "refuses terminal %s calls without SDK invocation after recovery exhaustion",
    async (operation) => {
      const capabilities = operation === "prompt" ? { prompts: {} } : { resources: {} };
      const harness = remoteHarness({ connect: ["ok", 503, 503, 503, 503, 503], capabilities });
      const delays: number[] = [];
      const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: `terminal-${operation}` })), makeDeps({
        loadRemoteClient: async () => harness.FakeRemoteClient as never,
        createRemoteTransport: harness.createRemoteTransport,
        delay: async (ms) => { delays.push(ms); },
      }));
      try {
        await runtime.whenSettled();
        harness.disconnects[0]!({ kind: "graceful-eof" });
        await waitUntil({ description: `${operation} recovery exhaustion`, predicate: () => runtime.serverStates()[0]?.state === "failed" });
        const invoke = () => operation === "prompt"
          ? runtime.getPrompt(`terminal-${operation}`, "fixture-prompt", {})
          : runtime.readResource(`terminal-${operation}`, "fixture://resource");
        await expect(invoke()).rejects.toThrow(/remote connection failed/);
        expect(harness.callCount()).toBe(0);
        expect(harness.clientCount()).toBe(6);
        expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("retries transient initial failures at exactly 1/2/4 seconds within one settlement", async () => {
    const harness = remoteHarness({ connect: [503, 503, 503, "ok"] });
    const delays: number[] = [];
    const runtime = McpRuntime.start(
      makeConfig(makeRemoteServer({ name: "remote" })),
      makeDeps({
        loadRemoteClient: async () => harness.FakeRemoteClient as never,
        createRemoteTransport: harness.createRemoteTransport,
        delay: async (ms) => { delays.push(ms); },
      }),
    );
    try {
      await runtime.whenSettled();
      expect(delays).toEqual([1_000, 2_000, 4_000]);
      expect(harness.clientCount()).toBe(4);
      expect(runtime.serverStates()).toEqual([
        { name: "remote", transport: "http", state: "connected", toolsAdvertised: true, promptsAdvertised: false, resourcesAdvertised: false, toolCount: 1 },
      ]);
      expect(runtime.tools().map((tool) => tool.toolName)).toEqual(["alpha"]);
    } finally {
      await runtime.shutdown();
    }
  });

  it.each(["connection", "discovery"] as const)(
    "uses typed pre-publication transport loss to retry generic %s rejection safely",
    async (stage) => {
      const harness = remoteHarness({ connect: [] });
      class TypedLossClient extends harness.FakeRemoteClient {
        override async connect(): Promise<void> {
          if (stage === "connection") {
            harness.disconnects[this.index]!({ kind: "abrupt-stream-failure" });
            throw new Error("GENERIC_INITIAL_CANARY");
          }
        }
        override async listTools(): Promise<{ tools: Array<{ name: string; description: string; inputSchema: object }> }> {
          harness.disconnects[this.index]!({ kind: "abrupt-stream-failure" });
          throw new Error("GENERIC_INITIAL_CANARY");
        }
      }
      const delays: number[] = [];
      const runtime = McpRuntime.start(
        makeConfig(makeRemoteServer({ name: "typed-loss" })),
        makeDeps({
          loadRemoteClient: async () => TypedLossClient as never,
          createRemoteTransport: harness.createRemoteTransport,
          delay: async (ms) => { delays.push(ms); },
        }),
      );
      try {
        await runtime.whenSettled();
        expect(delays).toEqual([1_000, 2_000, 4_000]);
        expect(harness.clientCount()).toBe(4);
        expect(runtime.serverStates()[0]).toMatchObject({ state: "failed" });
        expect(`${runtime.diagnostics().join("\n")}\n${JSON.stringify(runtime.serverStates())}`)
          .not.toContain("GENERIC_INITIAL_CANARY");
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("connects deprecated SSE through the remote adapter with truthful transport identity", async () => {
    const harness = remoteHarness({ connect: ["ok"] });
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({
      name: "legacy",
      transport: "sse",
      configuredType: "sse",
      sseDeprecation: { deprecated: true, replacement: "http" },
    })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
    }));
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        { name: "legacy", transport: "sse", state: "connected", toolsAdvertised: true, promptsAdvertised: false, resourcesAdvertised: false, toolCount: 1 },
      ]);
      expect(firstText(await runtime.callTool("legacy", "alpha", {}))).toBe("client-0");
    } finally {
      await runtime.shutdown();
    }
  });

  it("does not retry authentication failures or expose endpoint/header/transport speech", async () => {
    const harness = remoteHarness({ connect: [401] });
    const delays: number[] = [];
    const runtime = McpRuntime.start(
      makeConfig(makeRemoteServer({ name: "auth" })),
      makeDeps({
        loadRemoteClient: async () => harness.FakeRemoteClient as never,
        createRemoteTransport: harness.createRemoteTransport,
        delay: async (ms) => { delays.push(ms); },
      }),
    );
    try {
      await runtime.whenSettled();
      expect(delays).toEqual([]);
      expect(harness.clientCount()).toBe(1);
      expect(runtime.serverStates()[0]).toMatchObject({
        state: "failed",
        statusSummary:
          "Remote MCP authentication failed; check configured static headers. Interactive OAuth is not supported; then reload or start a new session.",
      });
      const surfaces = `${runtime.diagnostics().join("\n")}\n${JSON.stringify(runtime.serverStates())}`;
      for (const canary of ["REMOTE_URL_CANARY", "REMOTE_HEADER_CANARY", "REMOTE_SPEECH_CANARY"]) {
        expect(surfaces).not.toContain(canary);
      }
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps the original catalog while reconnecting and swaps only the current client", async () => {
    const harness = remoteHarness({ connect: ["ok", "ok"], catalogs: [["alpha"], ["alpha", "widened"]] });
    const delays: number[] = [];
    const runtime = McpRuntime.start(
      makeConfig(makeRemoteServer({ name: "recover" })),
      makeDeps({
        loadRemoteClient: async () => harness.FakeRemoteClient as never,
        createRemoteTransport: harness.createRemoteTransport,
        delay: async (ms) => { delays.push(ms); },
      }),
    );
    try {
      await runtime.whenSettled();
      expect(firstText(await runtime.callTool("recover", "alpha", {}))).toBe("client-0");
      harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
      await waitUntil({
        description: "remote recovery to publish the replacement client",
        predicate: () => runtime.serverStates()[0]?.state === "connected" && harness.clientCount() === 2,
      });
      expect(delays).toEqual([1_000]);
      expect(runtime.tools()).toEqual([
        expect.objectContaining({
          toolName: "alpha",
          description: "catalog-0",
          inputSchema: { type: "object", title: "schema-0" },
        }),
      ]);
      expect(harness.events.indexOf("close:0")).toBeLessThan(harness.events.indexOf("client:1"));
      await expect(runtime.callTool("recover", "widened", {})).rejects.toThrow(/has no tool/);
      expect(firstText(await runtime.callTool("recover", "alpha", {}))).toBe("client-1");
      harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
      harness.transportErrors[0]!(new StreamableHTTPError(503));
      await Promise.resolve();
      expect(harness.clientCount()).toBe(2);
      expect(delays).toEqual([1_000]);
      expect(runtime.serverStates()[0]).toMatchObject({ state: "connected", toolCount: 1 });
    } finally {
      await runtime.shutdown();
    }
  });

  it("exhausts exactly five reconnect delays and retains terminal local proxies", async () => {
    const harness = remoteHarness({ connect: ["ok", 503, 503, 503, 503, 503] });
    const delays: number[] = [];
    const runtime = McpRuntime.start(
      makeConfig(makeRemoteServer({ name: "exhaust" })),
      makeDeps({
        loadRemoteClient: async () => harness.FakeRemoteClient as never,
        createRemoteTransport: harness.createRemoteTransport,
        delay: async (ms) => { delays.push(ms); },
      }),
    );
    try {
      await runtime.whenSettled();
      harness.disconnects[0]!({ kind: "graceful-eof" });
      await waitUntil({
        description: "remote reconnect exhaustion",
        predicate: () => runtime.serverStates()[0]?.state === "failed",
      });
      expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
      expect(harness.clientCount()).toBe(6);
      expect(runtime.tools().map((tool) => tool.toolName)).toEqual(["alpha"]);
      expect(runtime.serverStates()[0]?.statusSummary).toContain(
        "check endpoint and network availability, then reload or start a new session",
      );
      await expect(runtime.callTool("exhaust", "alpha", {})).rejects.toThrow(/remote connection failed/);
      expect(harness.clientCount()).toBe(6);
    } finally {
      await runtime.shutdown();
    }
  });

  it("reports not-found startup safely without displaying the configured URL", async () => {
    const harness = remoteHarness({ connect: [404] });
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "missing" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
    }));
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()[0]?.statusSummary).toBe(
        "Remote MCP endpoint was not found; check the configured URL without sharing it, then reload or start a new session.",
      );
      expect(JSON.stringify(runtime.serverStates())).not.toContain("REMOTE_URL_CANARY");
      expect(harness.clientCount()).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it.each([
    ["connection 408", [408], undefined, 2, [1_000]],
    ["connection 429", [429], undefined, 2, [1_000]],
    ["connection 500", [500], undefined, 2, [1_000]],
    ["connection 400", [400], undefined, 1, []],
    ["connection 404", [404], undefined, 1, []],
    ["discovery 500", ["ok"], [500, "ok"], 1, [100]],
    ["discovery 400", ["ok"], [400], 1, []],
  ] as const)("applies stage-aware initial retry policy for %s", async (_label, connect, discover, attempts, expectedDelays) => {
    const harness = remoteHarness({
      connect: [...connect] as RemoteOutcome[],
      ...(discover === undefined ? {} : { discover: [...discover] as RemoteOutcome[] }),
    });
    const delays: number[] = [];
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "policy" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      delay: async (ms) => { delays.push(ms); },
    }));
    try {
      await runtime.whenSettled();
      expect(harness.clientCount()).toBe(attempts);
      expect(delays).toEqual(expectedDelays);
    } finally {
      await runtime.shutdown();
    }
  });

  it.each([
    ["discovery request timeout", Object.assign(new Error("SERVER_TIMEOUT_CANARY"), { code: -32_001 })],
    ["unowned abort", Object.assign(new Error("ABORT_CANARY"), { name: "AbortError" })],
    ["unknown connection error", new Error("UNKNOWN_CANARY")],
  ])("does not retry %s", async (_label, error) => {
    const discovery = _label.startsWith("discovery") ? [error] : undefined;
    const harness = remoteHarness({ connect: discovery ? ["ok"] : [error], ...(discovery ? { discovery } : {}) });
    const delays: number[] = [];
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "no-retry" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      delay: async (ms) => { delays.push(ms); },
    }));
    try {
      await runtime.whenSettled();
      expect(harness.clientCount()).toBe(1);
      expect(delays).toEqual([]);
      expect(runtime.diagnostics().join("\n")).not.toMatch(/SERVER_TIMEOUT_CANARY|ABORT_CANARY|UNKNOWN_CANARY/);
    } finally {
      await runtime.shutdown();
    }
  });

  it("publishes no partial remote capability state or diagnostics after aggregate discovery timeout", async () => {
    const promptGate = deferred<void>();
    const promptEntered = deferred<void>();
    const harness = remoteHarness({ connect: ["ok"], capabilities: { tools: {}, prompts: {} } });
    class PartialClient extends harness.FakeRemoteClient {
      override async listTools() {
        return {
          tools: Array.from({ length: 1_025 }, (_, index) => ({
            name: `tool-${index}`, description: "", inputSchema: {},
          })),
        };
      }
      override async listPrompts() {
        promptEntered.resolve();
        await promptGate.promise;
        return { prompts: [{ name: "late", arguments: [] }] };
      }
    }
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "partial" })), makeDeps({
      loadRemoteClient: async () => PartialClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      raceWithTimeout: async () => {
        await promptEntered.promise;
        return { timedOut: true };
      },
    }));
    try {
      await runtime.whenSettled();
      expect(runtime.tools()).toEqual([]);
      expect(runtime.prompts()).toEqual([]);
      expect(runtime.diagnostics().join("\n")).not.toContain("catalog truncated");
      expect(runtime.serverStates()[0]).not.toHaveProperty("toolsAdvertised");
      promptGate.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(runtime.tools()).toEqual([]);
      expect(runtime.prompts()).toEqual([]);
    } finally {
      promptGate.resolve();
      await runtime.shutdown();
    }
  });

  it("preserves a concurrent sibling diagnostic when remote discovery loses transport", async () => {
    const remoteEntered = deferred<void>();
    const releaseRemote = deferred<void>();
    const harness = remoteHarness({ connect: [] , capabilities: { prompts: {} } });
    class LosingRemoteClient extends harness.FakeRemoteClient {
      override async connect(): Promise<void> {
        if (this.index > 0) throw new StreamableHTTPError(400);
      }
      override async listPrompts() {
        remoteEntered.resolve();
        await releaseRemote.promise;
        harness.disconnects[this.index]!({ kind: "abrupt-stream-failure" });
        return { prompts: [] };
      }
    }
    class FakeStdioTransport { readonly pid = undefined; readonly stderr = undefined; }
    class DiagnosticStdioClient {
      async connect(): Promise<void> {}
      async listTools() {
        await remoteEntered.promise;
        return { tools: [{ name: "bad name" }] };
      }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(
      makeRemoteServer({ name: "losing" }),
      makeServer({ name: "sibling" }),
    ), makeDeps({
      loadRemoteClient: async () => LosingRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      loadSdk: async () => ({ Client: DiagnosticStdioClient, StdioClientTransport: FakeStdioTransport }) as never,
      delay: async () => undefined,
    }));
    try {
      await waitUntil({
        description: "sibling diagnostic publication",
        predicate: () => runtime.diagnostics().some((line) => line.includes('tool name "bad name" sanitized')),
      });
      releaseRemote.resolve();
      await runtime.whenSettled();
      expect(runtime.diagnostics().some((line) => line.includes('tool name "bad name" sanitized'))).toBe(true);
      expect(runtime.serverStates().find((state) => state.name === "sibling")).toMatchObject({ state: "connected" });
    } finally {
      releaseRemote.resolve();
      await runtime.shutdown();
    }
  });

  it("enforces one aggregate initial budget and rejects late initial publication", async () => {
    const gate = deferred<void>();
    const harness = remoteHarness({ connect: [gate.promise] });
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "aggregate" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      raceWithTimeout: async (_promise, timeoutMs) => {
        expect(timeoutMs).toBe(30_000);
        while (harness.clientCount() < 1) await Promise.resolve();
        return { timedOut: true };
      },
    }));
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()[0]).toMatchObject({
        state: "failed",
        statusSummary:
          "Remote MCP startup timed out within the aggregate MCP_TIMEOUT budget; check the endpoint and network, adjust MCP_TIMEOUT if appropriate, then reload or start a new session.",
      });
      gate.resolve();
      const lateInitialContinuation = deferred<void>();
      setImmediate(() => lateInitialContinuation.resolve());
      await lateInitialContinuation.promise;
      expect(runtime.tools()).toEqual([]);
      expect(runtime.serverStates()[0]).toMatchObject({ state: "failed" });
      expect(harness.clientCount()).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("deduplicates recovery signals and calls during outage without accelerating the loop", async () => {
    const retryDelay = deferred<void>();
    const harness = remoteHarness({ connect: ["ok", "ok"] });
    const delays: number[] = [];
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "dedupe" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      delay: async (ms) => { delays.push(ms); await retryDelay.promise; },
    }));
    try {
      await runtime.whenSettled();
      harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
      harness.disconnects[0]!({ kind: "graceful-eof" });
      await waitUntil({ description: "recovery delay", predicate: () => delays.length === 1 });
      await expect(runtime.callTool("dedupe", "alpha", {})).rejects.toThrow(/temporarily unavailable/);
      expect(harness.clientCount()).toBe(1);
      expect(delays).toEqual([1_000]);
      retryDelay.resolve();
      await waitUntil({ description: "deduped recovery success", predicate: () => harness.clientCount() === 2 && runtime.serverStates()[0]?.state === "connected" });
    } finally {
      await runtime.shutdown();
    }
  });

  it("bounds each recovery attempt and ignores a timed-out attempt that completes after newer success", async () => {
    const stale = deferred<void>();
    const harness = remoteHarness({ connect: ["ok", stale.promise, "ok"], catalogs: [["alpha"], ["stale"], ["alpha", "new"]] });
    const delays: number[] = [];
    let races = 0;
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "epoch" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      delay: async (ms) => { delays.push(ms); },
      raceWithTimeout: async <T>(promise: Promise<T>, timeoutMs: number) => {
        expect(timeoutMs).toBe(30_000);
        races += 1;
        if (races === 2) {
          while (harness.clientCount() < 2) await Promise.resolve();
          return { timedOut: true };
        }
        return { timedOut: false, value: await promise };
      },
    }));
    try {
      await runtime.whenSettled();
      harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
      await waitUntil({ description: "newer reconnect success", predicate: () => harness.clientCount() === 3 && runtime.serverStates()[0]?.state === "connected" });
      expect(delays).toEqual([1_000, 2_000]);
      expect(firstText(await runtime.callTool("epoch", "alpha", {}))).toBe("client-2");
      stale.resolve();
      const staleReconnectContinuation = deferred<void>();
      setImmediate(() => staleReconnectContinuation.resolve());
      await staleReconnectContinuation.promise;
      await expect(runtime.callTool("epoch", "new", {})).rejects.toThrow(/has no tool/);
      expect(firstText(await runtime.callTool("epoch", "alpha", {}))).toBe("client-2");
    } finally {
      await runtime.shutdown();
    }
  });

  it("does not let hanging reconnect cleanup consume a second attempt timeout", async () => {
    const connectGate = deferred<void>();
    const cleanupGate = deferred<void>();
    const harness = remoteHarness({
      connect: ["ok", connectGate.promise, "ok"],
      closes: ["ok", cleanupGate.promise, "ok"],
    });
    let races = 0;
    const delays: number[] = [];
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "cleanup-budget" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      delay: async (ms) => { delays.push(ms); },
      raceWithTimeout: async <T>(promise: Promise<T>, timeoutMs: number) => {
        expect(timeoutMs).toBe(30_000);
        races += 1;
        if (races === 2) {
          await waitUntil({ description: "timed reconnect client", predicate: () => harness.clientCount() === 2 });
          return { timedOut: true };
        }
        return { timedOut: false, value: await promise };
      },
    }));
    try {
      await runtime.whenSettled();
      harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
      await waitUntil({
        description: "reconnect progresses past hanging cleanup",
        predicate: () => harness.clientCount() === 3 && runtime.serverStates()[0]?.state === "connected",
      });
      expect(delays).toEqual([1_000, 2_000]);
      expect(races).toBe(3);
      expect(harness.closed).toContain(1);
      expect(firstText(await runtime.callTool("cleanup-budget", "alpha", {}))).toBe("client-2");
    } finally {
      await runtime.shutdown();
      connectGate.resolve();
      cleanupGate.resolve();
    }
  });

  it.each([
    ["typed disconnect", "transient"],
    ["permanent transport error", "terminal"],
  ] as const)(
    "uses %s lifecycle truth when an in-flight call later rejects with generic connection closure",
    async (transition, expected) => {
      const callGate = deferred<void>();
      const recoveryDelay = deferred<void>();
      const harness = remoteHarness({ connect: ["ok", "ok"], calls: [callGate.promise] });
      const delays: number[] = [];
      const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "in-flight" })), makeDeps({
        loadRemoteClient: async () => harness.FakeRemoteClient as never,
        createRemoteTransport: harness.createRemoteTransport,
        delay: async (ms) => { delays.push(ms); await recoveryDelay.promise; },
      }));
      try {
        await runtime.whenSettled();
        const call = runtime.callTool("in-flight", "alpha", {});
        await waitUntil({ description: "in-flight remote call to enter", predicate: () => harness.callCount() === 1 });
        if (transition === "typed disconnect") {
          harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
          await waitUntil({ description: "in-flight disconnect recovery delay", predicate: () => delays.length === 1 });
        } else {
          harness.transportErrors[0]!(new Error("PERMANENT_TRANSPORT_CANARY"));
        }
        callGate.reject(new Error("Connection closed"));
        await expect(call).rejects.toThrow(
          expected === "transient"
            ? 'MCP server "in-flight" is temporarily unavailable while reconnecting'
            : 'MCP server "in-flight" is unavailable because its remote connection failed',
        );
        expect(runtime.serverStates()[0]?.state).toBe(expected === "transient" ? "reconnecting" : "failed");
        expect(harness.clientCount()).toBe(1);
        expect(delays).toEqual(expected === "transient" ? [1_000] : []);
      } finally {
        recoveryDelay.resolve();
        await runtime.shutdown();
      }
    },
  );

  it("starts one recovery loop for a classified transient call and fails unknown transport errors immediately", async () => {
    const delayGate = deferred<void>();
    const harness = remoteHarness({ connect: ["ok", "ok"], calls: [new StreamableHTTPError(503)] });
    const delays: number[] = [];
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "call-recovery" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      delay: async (ms) => { delays.push(ms); await delayGate.promise; },
    }));
    try {
      await runtime.whenSettled();
      await expect(runtime.callTool("call-recovery", "alpha", {})).rejects.toThrow(/temporarily unavailable/);
      await waitUntil({ description: "call-started recovery", predicate: () => delays.length === 1 });
      await expect(runtime.callTool("call-recovery", "alpha", {})).rejects.toThrow(/temporarily unavailable/);
      expect(delays).toEqual([1_000]);
      delayGate.resolve();
      await waitUntil({ description: "call recovery success", predicate: () => runtime.serverStates()[0]?.state === "connected" && harness.clientCount() === 2 });
      harness.transportErrors[1]!(new Error("UNKNOWN_POST_CONNECT_CANARY"));
      expect(runtime.serverStates()[0]).toMatchObject({ state: "failed" });
      expect(delays).toEqual([1_000]);
      expect(runtime.diagnostics().join("\n")).not.toContain("UNKNOWN_POST_CONNECT_CANARY");
    } finally {
      delayGate.resolve();
      await runtime.shutdown();
    }
  });

  it.each(["import", "connect", "discovery", "active-reconnect"] as const)(
    "shutdown during remote %s invalidates work and closes each owned part once",
    async (phase) => {
      const gate = deferred<void>();
      const importEntered = deferred<void>();
      const importGate = deferred<typeof import("@modelcontextprotocol/sdk/client/index.js").Client>();
      const harness = remoteHarness({
        connect: phase === "connect" || phase === "active-reconnect" ? [phase === "connect" ? gate.promise : "ok", gate.promise] : ["ok"],
        discover: phase === "discovery" ? [gate.promise] : undefined,
      });
      const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: `shutdown-${phase}` })), makeDeps({
        loadRemoteClient: phase === "import"
          ? async () => {
              importEntered.resolve();
              return importGate.promise;
            }
          : async () => harness.FakeRemoteClient as never,
        createRemoteTransport: harness.createRemoteTransport,
        delay: async () => undefined,
      }));
      try {
        if (phase === "import") {
          await importEntered.promise;
        } else {
          await waitUntil({ description: `${phase} work to enter`, predicate: () => harness.clientCount() >= 1 });
          if (phase === "active-reconnect") {
            await runtime.whenSettled();
            harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
            await waitUntil({ description: "active reconnect to enter", predicate: () => harness.clientCount() === 2 });
          }
        }
        await Promise.all([runtime.shutdown(), runtime.shutdown(), runtime.whenSettled()]);
        importGate.resolve(harness.FakeRemoteClient as never);
        gate.resolve();
        const releasedWorkContinuation = deferred<void>();
        setImmediate(() => releasedWorkContinuation.resolve());
        await releasedWorkContinuation.promise;
        expect(runtime.serverStates()[0]).toMatchObject({ state: "failed" });
        expect(runtime.tools().map((tool) => tool.toolName)).toEqual(
          phase === "active-reconnect" ? ["alpha"] : [],
        );
        const expectedOwned = phase === "import" ? [] : phase === "active-reconnect" ? [0, 1] : [0];
        expect(harness.closed).toEqual(expectedOwned);
        expect(harness.aborted).toEqual(expectedOwned);
      } finally {
        importGate.resolve(harness.FakeRemoteClient as never);
        gate.resolve();
        await runtime.shutdown();
      }
    },
  );

  it("keeps request-local MCP protocol errors local and model-visible through the bounded call path", async () => {
    const protocolError = Object.assign(new Error("PROTOCOL_ERROR_CANARY"), { code: -32_602 });
    const harness = remoteHarness({ connect: ["ok"], calls: [protocolError] });
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "protocol" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
    }));
    try {
      await runtime.whenSettled();
      await expect(runtime.callTool("protocol", "alpha", {})).rejects.toThrow(/PROTOCOL_ERROR_CANARY/);
      expect(runtime.serverStates()[0]).toMatchObject({ state: "connected" });
      expect(harness.clientCount()).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it.each([
    [401, "Remote MCP authentication failed; check configured static headers. Interactive OAuth is not supported; then reload or start a new session."],
    [404, "Remote MCP endpoint was not found; check the configured URL without sharing it, then reload or start a new session."],
    [400, "Remote MCP connection failed permanently; check endpoint and network availability, then reload or start a new session."],
  ] as const)(
    "fails a post-connect callTool HTTP %i permanently without retrying or harming a sibling",
    async (status, summary) => {
      const harness = remoteHarness({
        connect: ["ok", "ok"],
        calls: [status, "ok"],
      });
      const delays: number[] = [];
      const runtime = McpRuntime.start(makeConfig(
        makeRemoteServer({ name: "failed" }),
        makeRemoteServer({ name: "healthy" }),
      ), makeDeps({
        loadRemoteClient: async () => harness.FakeRemoteClient as never,
        createRemoteTransport: harness.createRemoteTransport,
        delay: async (ms) => { delays.push(ms); },
      }));
      try {
        await runtime.whenSettled();
        await expect(runtime.callTool("failed", "alpha", {})).rejects.toThrow(
          /unavailable because its remote connection failed/,
        );
        expect(runtime.serverStates()[0]).toMatchObject({
          state: "failed",
          statusSummary: summary,
        });
        expect(runtime.serverStates()[1]).toMatchObject({ state: "connected", toolCount: 1 });
        expect(delays).toEqual([]);
        expect(harness.callCount()).toBe(1);

        await expect(runtime.callTool("failed", "alpha", {})).rejects.toThrow(
          /unavailable because its remote connection failed/,
        );
        expect(harness.callCount()).toBe(1);
        expect(firstText(await runtime.callTool("healthy", "alpha", {}))).toBe("client-1");
        expect(harness.callCount()).toBe(2);
        await expect(runtime.callTool("failed", "alpha", {})).rejects.toThrow(
          /unavailable because its remote connection failed/,
        );
        expect(harness.callCount()).toBe(2);
        expect(delays).toEqual([]);
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("keeps stdio healthy when the remote client module fails to load", async () => {
    class FakeStdioTransport {
      pid: number | undefined;
      stderr = undefined;
      onclose?: () => void;
      onerror?: (error: Error) => void;
      onmessage?: (message: unknown) => void;
    }
    class FakeStdioClient {
      async connect(): Promise<void> {}
      async listTools(): Promise<{ tools: Array<{ name: string }> }> { return { tools: [{ name: "stdio-tool" }] }; }
      async close(): Promise<void> {}
    }
    const runtime = McpRuntime.start(makeConfig(
      makeServer({ name: "stdio" }),
      makeRemoteServer({ name: "remote" }),
    ), makeDeps({
      loadSdk: async () => ({ Client: FakeStdioClient, StdioClientTransport: FakeStdioTransport }) as never,
      loadRemoteClient: async () => { throw new Error("REMOTE_IMPORT_CANARY"); },
      createRemoteTransport: async () => { throw new Error("must not construct"); },
    }));
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates().find((state) => state.name === "stdio")).toMatchObject({ state: "connected", toolCount: 1 });
      expect(runtime.serverStates().find((state) => state.name === "remote")).toMatchObject({ state: "failed" });
      expect(runtime.diagnostics().join("\n")).not.toContain("REMOTE_IMPORT_CANARY");
    } finally {
      await runtime.shutdown();
    }
  });

  it("shutdown during reconnect delay cancels the loop without client, request, state, or catalog resurrection", async () => {
    const reconnectDelay = deferred<void>();
    const harness = remoteHarness({ connect: ["ok", "ok"] });
    const delays: number[] = [];
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "shutdown-delay" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      delay: async (ms) => { delays.push(ms); await reconnectDelay.promise; },
    }));
    await runtime.whenSettled();
    const catalog = runtime.tools();
    harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
    await waitUntil({ description: "reconnect delay before shutdown", predicate: () => delays.length === 1 });
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    const stoppedState = runtime.serverStates();
    reconnectDelay.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(delays).toEqual([1_000]);
    expect(harness.clientCount()).toBe(1);
    expect(harness.callCount()).toBe(0);
    expect(harness.closed).toEqual([0]);
    expect(harness.aborted).toEqual([0]);
    expect(runtime.serverStates()).toEqual(stoppedState);
    expect(runtime.tools()).toEqual(catalog);
  });

  it("shutdown concurrent with an outage call leaves one cleanup owner and no later recovery", async () => {
    const reconnectDelay = deferred<void>();
    const harness = remoteHarness({ connect: ["ok", "ok"] });
    const delays: number[] = [];
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "shutdown-outage" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      delay: async (ms) => { delays.push(ms); await reconnectDelay.promise; },
    }));
    await runtime.whenSettled();
    const catalog = runtime.tools();
    harness.disconnects[0]!({ kind: "abrupt-stream-failure" });
    await waitUntil({ description: "outage call recovery delay", predicate: () => delays.length === 1 });
    const outageCall = runtime.callTool("shutdown-outage", "alpha", {});
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    await expect(outageCall).rejects.toThrow(/temporarily unavailable/);
    const stoppedState = runtime.serverStates();
    const lateRecoveryContinuation = deferred<void>();
    reconnectDelay.resolve();
    // The check-phase signal runs only after the released delay's promise continuation processes the shutdown gate.
    setImmediate(() => lateRecoveryContinuation.resolve());
    await lateRecoveryContinuation.promise;
    expect(harness.clientCount()).toBe(1);
    expect(harness.callCount()).toBe(0);
    expect(harness.closed).toEqual([0]);
    expect(harness.aborted).toEqual([0]);
    expect(delays).toEqual([1_000]);
    expect(runtime.serverStates()).toEqual(stoppedState);
    expect(runtime.tools()).toEqual(catalog);
  });

  it("ignores a late rejecting call and transport error after shutdown without resurrecting recovery", async () => {
    const callGate = deferred<void>();
    const harness = remoteHarness({ connect: ["ok"], calls: [callGate.promise] });
    const delays: number[] = [];
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "shutdown-late" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      delay: async (ms) => { delays.push(ms); },
    }));
    await runtime.whenSettled();
    const catalog = runtime.tools();
    const lateCall = runtime.callTool("shutdown-late", "alpha", {});
    await waitUntil({ description: "late call to enter before shutdown", predicate: () => harness.callCount() === 1 });
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);
    const stoppedState = runtime.serverStates();
    callGate.reject(new StreamableHTTPError(503));
    harness.transportErrors[0]!(new StreamableHTTPError(503));
    await expect(lateCall).rejects.toThrow(/temporarily unavailable/);
    await Promise.resolve();
    expect(delays).toEqual([]);
    expect(harness.clientCount()).toBe(1);
    expect(harness.callCount()).toBe(1);
    expect(harness.closed).toEqual([0]);
    expect(harness.aborted).toEqual([0]);
    expect(runtime.serverStates()).toEqual(stoppedState);
    expect(runtime.tools()).toEqual(catalog);
  });

  it("shutdown during initial retry delay settles once and prevents later clients or resurrection", async () => {
    const delayGate = deferred<void>();
    const harness = remoteHarness({ connect: [503, "ok"] });
    const runtime = McpRuntime.start(makeConfig(makeRemoteServer({ name: "shutdown" })), makeDeps({
      loadRemoteClient: async () => harness.FakeRemoteClient as never,
      createRemoteTransport: harness.createRemoteTransport,
      delay: async () => { await delayGate.promise; },
    }));
    await waitUntil({ description: "initial retry delay", predicate: () => runtime.serverStates()[0]?.state === "retrying" });
    await Promise.all([runtime.shutdown(), runtime.shutdown(), runtime.whenSettled()]);
    delayGate.resolve();
    await Promise.resolve();
    expect(harness.clientCount()).toBe(1);
    expect(runtime.tools()).toEqual([]);
    expect(runtime.serverStates()[0]).toMatchObject({ state: "failed" });
  });
});

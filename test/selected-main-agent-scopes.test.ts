import { describe, expect, it, vi } from "vitest";
import type {
  AgentMcpAdmissionContext,
  AgentMcpDeclaration,
  EnabledStdioAgentMcpServer,
  HookOutcome,
  ResolvedAgentMcpConfig,
} from "../src/types.js";
import {
  createAgentMcpScope,
  type AgentMcpScope,
  type CreateAgentMcpScopeOptions,
  type OwnedAgentMcpRuntime,
} from "../src/runtime/agent-mcp.js";
import type {
  McpCleanupOutcome,
  McpResourceServerInfo,
  McpServerState,
  McpToolInfo,
} from "../src/runtime/mcp.js";
import {
  SELECTED_MAIN_HOOK_SLOT,
  SELECTED_MAIN_MCP_INVENTORY_SLOT,
  SelectedMainHookSlotController,
  SelectedMainMcpScopeController,
  type SelectedMainHookRunner,
  type SelectedMainHookSlotHost,
  type SelectedMainMcpInstall,
  type SelectedMainMcpInventorySource,
} from "../src/runtime/selected-main-agent-scopes.js";
import { deferred, waitUntil } from "./helpers/async.js";

function hookOutcome(diagnostics: HookOutcome["diagnostics"] = []): HookOutcome {
  return { block: false, askDowngraded: false, diagnostics };
}

function hookRunner(name: string, events: string[], diagnostics: HookOutcome["diagnostics"] = []): SelectedMainHookRunner {
  return {
    hasHooks: () => true,
    fire: vi.fn(async (eventName) => {
      events.push(`${name}:${eventName}`);
      return hookOutcome(diagnostics);
    }),
  };
}

function hookHost(events: string[]): SelectedMainHookSlotHost & {
  selected?: SelectedMainHookRunner;
  mutation?: "throw-before-install" | "throw-after-install" | "throw-before-remove" | "throw-after-remove";
} {
  const base = hookRunner("base", events);
  return {
    selected: undefined,
    mutation: undefined,
    replaceSelectedMainHook(slot, runner) {
      expect(slot).toBe(SELECTED_MAIN_HOOK_SLOT);
      const operation = runner === undefined ? "remove" : "install";
      events.push(`host-${operation}`);
      if (this.mutation === `throw-before-${operation}`) {
        this.mutation = undefined;
        throw new Error("host uncertain");
      }
      this.selected = runner;
      if (this.mutation === `throw-after-${operation}`) {
        this.mutation = undefined;
        throw new Error("host uncertain");
      }
    },
    async fireSessionHook(eventName, payload) {
      const outcomes = [await base.fire(eventName, payload)];
      if (this.selected?.hasHooks(eventName)) outcomes.push(await this.selected.fire(eventName, payload));
      return {
        outcome: hookOutcome(outcomes.flatMap((outcome) => outcome.diagnostics)),
        selectedDelivered: true,
        baseDelivered: true,
        committed: true,
      };
    },
  };
}

function cleanup(confirmed: readonly string[] = [], unconfirmed: readonly string[] = []): McpCleanupOutcome {
  return { confirmed, unconfirmed, diagnostics: unconfirmed.length > 0 ? ["RAW_CLEANUP_SECRET"] : [] };
}

function tool(serverName: string, toolName: string): McpToolInfo {
  return { serverName, toolName, description: toolName, inputSchema: { type: "object" } };
}

function resources(serverName: string): McpResourceServerInfo {
  return { serverName, resources: [{ serverName, uri: `${serverName}://one`, name: "one" }] };
}

function inline(name: string): EnabledStdioAgentMcpServer {
  return {
    name,
    source: "subagent-inline",
    status: "enabled",
    transport: "stdio",
    command: "never-started",
    args: [],
    env: {},
    rawCommand: "SECRET_COMMAND",
    diagnostics: [],
  };
}

function config(...servers: ResolvedAgentMcpConfig["servers"]): ResolvedAgentMcpConfig {
  return { servers, diagnostics: [], diagnosticOwnership: [] };
}

function declaration(...items: Array<{ kind: "reference" | "inline"; name: string }>): AgentMcpDeclaration {
  return {
    scope: "project",
    items: items as AgentMcpDeclaration["items"],
    diagnostics: [],
    diagnosticOwnership: [],
  };
}

function admission(inlineConfig: ResolvedAgentMcpConfig): AgentMcpAdmissionContext {
  return { resolve: vi.fn(() => inlineConfig) };
}

function runtime(options: {
  tools?: McpToolInfo[];
  resources?: McpResourceServerInfo[];
  states?: McpServerState[];
  calls?: string[];
  callGate?: Promise<unknown>;
  shutdownGate?: Promise<void>;
  shutdown?: McpCleanupOutcome;
  retry?: McpCleanupOutcome;
  events?: string[];
  diagnostics?: string[];
} = {}): OwnedAgentMcpRuntime & { shutdownCalls: number; retryCalls: number } {
  const tools = options.tools ?? [];
  const resourceServers = options.resources ?? [];
  const states = options.states ?? [];
  const calls = options.calls ?? [];
  return {
    shutdownCalls: 0,
    retryCalls: 0,
    whenSettled: async () => {},
    tools: () => tools,
    resourceServers: () => resourceServers,
    serverStates: () => states,
    diagnostics: () => options.diagnostics ?? [],
    async callTool(serverName, toolName) {
      calls.push(`${serverName}:${toolName}`);
      return options.callGate ?? { content: [] };
    },
    async readResource(serverName, uri) {
      calls.push(`${serverName}:${uri}`);
      return { contents: [] };
    },
    async shutdown() {},
    async shutdownAgent() {
      this.shutdownCalls += 1;
      options.events?.push("selected-shutdown-enter");
      await options.shutdownGate;
      options.events?.push("selected-shutdown-complete");
      return options.shutdown ?? cleanup(states.map((state) => state.name));
    },
    async retryAgentShutdown() {
      this.retryCalls += 1;
      return options.retry ?? cleanup();
    },
  };
}

function inventoryHost(events: string[] = []): {
  current?: SelectedMainMcpInventorySource;
  replaceSelectedMainMcpInventory(
    slot: typeof SELECTED_MAIN_MCP_INVENTORY_SLOT,
    source: SelectedMainMcpInventorySource | undefined,
  ): void;
} {
  return {
    replaceSelectedMainMcpInventory(slot, source) {
      expect(slot).toBe(SELECTED_MAIN_MCP_INVENTORY_SLOT);
      events.push(source === undefined ? "inventory-remove" : "inventory-install");
      this.current = source;
    },
  };
}

const deps = { projectRoot: "/project", sessionId: "selected-main", env: {} };

function install(
  identity: string,
  sessionRuntime: OwnedAgentMcpRuntime,
  selectedDeclaration?: AgentMcpDeclaration,
  inlineConfig: ResolvedAgentMcpConfig = config(),
): SelectedMainMcpInstall {
  return {
    agentIdentity: identity,
    sessionRuntime,
    ...(selectedDeclaration === undefined ? {} : {
      declaration: selectedDeclaration,
      admissionContext: admission(inlineConfig),
    }),
    inlineDeps: deps,
  };
}

function fakeScope(overrides: Partial<AgentMcpScope> = {}): AgentMcpScope {
  return {
    whenSettled: async () => {},
    tools: () => [],
    resourceServers: () => [],
    serverStates: () => [],
    callTool: async () => ({ content: [] }),
    readResource: async () => ({ contents: [] }),
    diagnostics: () => [],
    setupOutcomes: () => [],
    knownToolNames: () => [],
    borrowedServerNames: () => [],
    shutdown: async () => cleanup(),
    retryUnconfirmedShutdown: async () => cleanup(),
    ...overrides,
  };
}

const EMPTY_EXPECTED_CLEANUP = { confirmed: [], unconfirmed: [], diagnostics: [] };

describe("selected main hook slot", () => {
  it("runs selected and base SessionEnd exactly once through the host before live A→B and selected→none", async () => {
    const events: string[] = [];
    const host = hookHost(events);
    const unrelated = new Map<string, SelectedMainHookRunner>([
      ["same-name", hookRunner("skill", events)],
      ["agent:same-name", hookRunner("subagent", events)],
    ]);
    const controller = new SelectedMainHookSlotController(host);
    const a = hookRunner("A", events);
    const b = hookRunner("B", events);

    expect(await controller.replace(a, {})).toEqual({
      installed: true, cleared: false, committed: true, sessionEndDelivery: "not-required", reasons: [],
    });
    expect(await controller.replace(b, { reason: "replace" })).toEqual({
      installed: true, cleared: false, committed: true, sessionEndDelivery: "confirmed", reasons: [],
    });
    expect(events.slice(1, 5)).toEqual(["base:SessionEnd", "A:SessionEnd", "host-remove", "host-install"]);
    expect(await controller.replace(undefined, { reason: "fallback" })).toEqual({
      installed: false, cleared: true, committed: true, sessionEndDelivery: "confirmed", reasons: [],
    });
    await controller.replace(undefined, { reason: "admission-denied" });

    expect(events.filter((event) => event === "A:SessionEnd")).toHaveLength(1);
    expect(events.filter((event) => event === "B:SessionEnd")).toHaveLength(1);
    expect(events.filter((event) => event === "base:SessionEnd")).toHaveLength(2);
    expect(host.selected).toBeUndefined();
    expect([...unrelated.keys()]).toEqual(["same-name", "agent:same-name"]);
  });

  it.each(["throw-before-install", "throw-after-install"] as const)(
    "leaves a host-retained delegate inert after initial %s and confirms retry",
    async (mutation) => {
      const events: string[] = [];
      const host = hookHost(events);
      host.mutation = mutation;
      const controller = new SelectedMainHookSlotController(host);
      const selected = hookRunner("selected", events);

      expect(await controller.replace(selected, {})).toEqual({
        installed: false, cleared: true, committed: false,
        sessionEndDelivery: "not-required", reasons: ["slot-update-failed"],
      });
      await host.fireSessionHook("SessionEnd", {});
      expect(events).not.toContain("selected:SessionEnd");
      expect(await controller.replace(selected, {})).toEqual({
        installed: true, cleared: false, committed: true, sessionEndDelivery: "not-required", reasons: [],
      });
    },
  );

  it.each(["throw-before-install", "throw-after-install"] as const)(
    "makes a failed live replacement %s inert and safely retryable",
    async (mutation) => {
      const events: string[] = [];
      const host = hookHost(events);
      const controller = new SelectedMainHookSlotController(host);
      await controller.replace(hookRunner("A", events), {});
      host.mutation = mutation;
      const b = hookRunner("B", events);

      expect((await controller.replace(b, {})).committed).toBe(false);
      await host.fireSessionHook("SessionEnd", {});
      expect(events.filter((event) => event === "A:SessionEnd")).toHaveLength(1);
      expect(events).not.toContain("B:SessionEnd");
      expect((await controller.replace(b, {})).installed).toBe(true);
    },
  );

  it.each(["throw-before-remove", "throw-after-remove"] as const)(
    "revokes locally before %s, blocks replacement, and confirms removal on retry",
    async (mutation) => {
      const events: string[] = [];
      const host = hookHost(events);
      const controller = new SelectedMainHookSlotController(host);
      await controller.replace(hookRunner("A", events), {});
      host.mutation = mutation;

      expect(await controller.replace(hookRunner("B", events), {})).toEqual({
        installed: false, cleared: true, committed: false,
        sessionEndDelivery: "confirmed", reasons: ["slot-update-failed"],
      });
      await host.fireSessionHook("SessionEnd", {});
      expect(events.filter((event) => event === "A:SessionEnd")).toHaveLength(1);
      expect(await controller.replace(hookRunner("B", events), {})).toEqual({
        installed: true, cleared: false, committed: true,
        sessionEndDelivery: "not-required", reasons: [],
      });
    },
  );

  it("serializes SessionEnd, reports fixed diagnostics/failure, and clears with confirmed authority", async () => {
    const events: string[] = [];
    const host = hookHost(events);
    const diagnostic = hookRunner("diagnostic", events, [{ severity: "warning", message: "RAW SECRET" }]);
    const controller = new SelectedMainHookSlotController(host);
    await controller.replace(diagnostic, {});
    expect((await controller.replace(undefined, {})).reasons).toEqual(["session-end-diagnostic"]);

    for (const delivery of ["reject", "missing-evidence"] as const) {
      const failingHost = hookHost([]);
      failingHost.fireSessionHook = delivery === "reject"
        ? async () => { throw new Error("RAW_HOOK_STDERR_SECRET"); }
        : async () => ({
          outcome: hookOutcome(),
          selectedDelivered: undefined,
          baseDelivered: true,
          committed: true,
        }) as never;
      const failing = new SelectedMainHookSlotController(failingHost);
      await failing.replace(hookRunner("selected", []), {});
      const result = await failing.replace(hookRunner("must-not-install", []), {});
      expect(result).toEqual({
        installed: false,
        cleared: true,
        committed: false,
        sessionEndDelivery: "uncertain",
        reasons: ["session-end-delivery-uncertain"],
      });
      expect(failingHost.selected).toBeUndefined();
      expect((await failing.replace(hookRunner("still-blocked", []), {})).installed).toBe(false);
      expect(JSON.stringify(result)).not.toContain("RAW_HOOK_STDERR_SECRET");
    }
  });
});

describe("selected main MCP scope", () => {
  it.each([
    ["omitted", undefined],
    ["clean-empty", declaration()],
  ] as const)("inherits eligible published routes for %s declarations", async (_label, selectedDeclaration) => {
    const session = runtime({
      tools: [tool("published", "read")],
      states: [{ name: "published", transport: "http", state: "connected" }],
    });
    const host = inventoryHost();
    const controller = new SelectedMainMcpScopeController(host);
    const result = await controller.replace(install("reader", session, selectedDeclaration));

    expect(result.installed).toBe(true);
    expect(controller.adapter().tools()).toEqual([tool("published", "read")]);
    expect(host.current?.ownership).toBe("selected-main");
    expect(host.current?.tools()).toEqual([]);
    expect(host.current?.serverStates()).toEqual([]);
  });

  it("resolves declarations with captured admission and never starts pending/disabled/blocked/unavailable inline servers", async () => {
    const nonEnabled = ["pending-approval", "disabled", "blocked", "unavailable"] as const;
    for (const status of nonEnabled) {
      const startInline = vi.fn(() => runtime());
      const factory = (options: CreateAgentMcpScopeOptions) => createAgentMcpScope({ ...options, startInline });
      const controller = new SelectedMainMcpScopeController(inventoryHost(), factory);
      const declarationValue = declaration({ kind: "inline", name: status });
      const result = await controller.replace({
        agentIdentity: status,
        sessionRuntime: runtime(),
        declaration: declarationValue,
        admissionContext: admission(config({
          ...inline(status),
          status,
          diagnostics: ["RAW_ADMISSION_SECRET"],
        } as ResolvedAgentMcpConfig["servers"][number])),
        inlineDeps: deps,
      });
      expect(result.installed).toBe(true);
      expect(startInline).not.toHaveBeenCalled();
    }

    for (const authority of [undefined, { resolve: () => { throw new Error("RAW AUTHORITY"); } }]) {
      const factory = vi.fn(async () => fakeScope());
      const controller = new SelectedMainMcpScopeController(inventoryHost(), factory);
      const result = await controller.replace({
        agentIdentity: "blocked",
        sessionRuntime: runtime(),
        declaration: declaration({ kind: "inline", name: "blocked" }),
        ...(authority === undefined ? {} : { admissionContext: authority }),
        inlineDeps: deps,
      });
      expect(result.diagnostics).toEqual([{ reason: "setup-failed", identity: "blocked" }]);
      expect(factory).not.toHaveBeenCalled();
    }
  });

  it.each(["absent", "throwing"] as const)(
    "rejects and cleans factory scope with %s borrowed-route provenance",
    async (mode) => {
      const shutdown = vi.fn(async () => cleanup());
      const scope = fakeScope({
        borrowedServerNames: mode === "throwing"
          ? () => { throw new Error("RAW_PROVENANCE_SECRET"); }
          : undefined,
        shutdown,
      });
      const factory = vi.fn(async () => scope);
      const controller = new SelectedMainMcpScopeController(inventoryHost(), factory);
      const result = await controller.replace(install("provenance", runtime()));

      expect(result.installed).toBe(false);
      expect(result.diagnostics).toEqual([{ reason: "setup-failed", identity: "provenance" }]);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("RAW_PROVENANCE_SECRET");
    },
  );

  it("projects only selected-owned tools/resources/states and never propagates them into a subagent scope", async () => {
    const session = runtime({
      tools: [tool("shared", "published")],
      resources: [resources("shared")],
      states: [{ name: "shared", transport: "http", state: "connected" }],
    });
    const owned = runtime({
      tools: [tool("local", "write")],
      resources: [resources("local")],
      states: [{ name: "local", transport: "stdio", state: "connected" }],
    });
    const startInline = vi.fn((_config: ResolvedAgentMcpConfig) => owned);
    const factory = (options: CreateAgentMcpScopeOptions) => createAgentMcpScope({ ...options, startInline });
    const host = inventoryHost();
    const controller = new SelectedMainMcpScopeController(host, factory);
    await controller.replace(install(
      "builder",
      session,
      declaration(
        { kind: "reference", name: "shared" },
        { kind: "inline", name: "shared" },
        { kind: "inline", name: "local" },
      ),
      config(inline("shared"), inline("local")),
    ));

    expect(startInline).toHaveBeenCalledTimes(1);
    expect(startInline.mock.calls[0]?.[0].servers.map((server) => server.name)).toEqual(["local"]);

    expect(controller.adapter().tools().map((entry) => entry.serverName)).toEqual(["shared", "local"]);
    expect(host.current?.tools().map((entry) => entry.serverName)).toEqual(["local"]);
    expect(host.current?.resourceServers().map((entry) => entry.serverName)).toEqual(["local"]);
    expect(host.current?.serverStates().map((entry) => entry.name)).toEqual(["local"]);

    const child = await createAgentMcpScope({ sessionRuntime: session, inlineConfig: config(), inlineDeps: deps });
    expect(child.tools().map((entry) => entry.serverName)).toEqual(["shared"]);
    expect(child.resourceServers().map((entry) => entry.serverName)).toEqual(["shared"]);
    await expect(child.callTool("local", "write", {})).rejects.toThrow("not available");

    const retainedInventory = host.current!;
    const retainedAdapter = controller.adapter();
    await controller.replace(undefined);
    expect(retainedInventory.tools()).toEqual([]);
    expect(retainedInventory.resourceServers()).toEqual([]);
    expect(retainedInventory.serverStates()).toEqual([]);
    expect(retainedAdapter.tools()).toEqual([]);
  });

  it("revokes old adapter/inventory and does not enter replacement factory/publication until cleanup resolves", async () => {
    const gate = deferred<void>();
    const events: string[] = [];
    const firstOwned = runtime({
      tools: [tool("local", "slow")],
      states: [{ name: "local", transport: "stdio", state: "connected" }],
      shutdownGate: gate.promise,
      events,
    });
    const secondOwned = runtime({ states: [{ name: "next", transport: "stdio", state: "connected" }] });
    let calls = 0;
    const factory = vi.fn((options: CreateAgentMcpScopeOptions) => createAgentMcpScope({
      ...options,
      startInline: () => calls++ === 0 ? firstOwned : secondOwned,
    }));
    const host = inventoryHost(events);
    const controller = new SelectedMainMcpScopeController(host, factory);
    await controller.replace(install("first", runtime(), declaration({ kind: "inline", name: "local" }), config(inline("local"))));
    const staleAdapter = controller.adapter();
    const staleInventory = host.current!;

    const replacing = controller.replace(install("second", runtime(), declaration({ kind: "inline", name: "next" }), config(inline("next"))));
    await Promise.resolve();
    expect(staleAdapter.tools()).toEqual([]);
    expect(staleInventory.tools()).toEqual([]);
    await expect(staleAdapter.callTool("local", "slow", {})).rejects.toThrow("not active");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(events.slice(events.indexOf("inventory-remove") + 1)).not.toContain("inventory-install");

    gate.resolve();
    expect((await replacing).installed).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("rejects completed A→B same-capability stale tool/resource adapters without touching B", async () => {
    const aCall = vi.fn(async () => ({ content: [] }));
    const aRead = vi.fn(async () => ({ contents: [] }));
    const bCall = vi.fn(async () => ({ content: [] }));
    const bRead = vi.fn(async () => ({ contents: [] }));
    const scopes = [
      fakeScope({ tools: () => [tool("same", "capability")], callTool: aCall, readResource: aRead }),
      fakeScope({ tools: () => [tool("same", "capability")], callTool: bCall, readResource: bRead }),
    ];
    const controller = new SelectedMainMcpScopeController(
      inventoryHost(),
      vi.fn(async () => scopes.shift()!),
    );
    await controller.replace(install("A", runtime()));
    const stale = controller.adapter();
    await controller.replace(install("B", runtime()));

    await expect(stale.callTool("same", "capability", {})).rejects.toThrow("not active");
    await expect(stale.readResource("same", "same://resource")).rejects.toThrow("not active");
    expect(bCall).not.toHaveBeenCalled();
    expect(bRead).not.toHaveBeenCalled();
    await controller.adapter().callTool("same", "capability", {});
    await controller.adapter().readResource("same", "same://resource");
    expect(bCall).toHaveBeenCalledTimes(1);
    expect(bRead).toHaveBeenCalledTimes(1);
  });

  it("owns factory output before inspection and retains fixed cleanup uncertainty on shutdown/retry rejection", async () => {
    const scope = fakeScope({
      setupOutcomes: () => { throw new Error("RAW_INSPECTION_SECRET"); },
      shutdown: vi.fn(async () => { throw new Error("RAW_SHUTDOWN_SECRET"); }),
      retryUnconfirmedShutdown: vi.fn(async () => { throw new Error("RAW_RETRY_SECRET"); }),
    });
    const factory = vi.fn(async () => scope);
    const controller = new SelectedMainMcpScopeController(inventoryHost(), factory);
    const failed = await controller.replace(install("provisional", runtime()));

    expect(scope.shutdown).toHaveBeenCalledTimes(1);
    expect(failed.diagnostics).toEqual([
      { reason: "setup-failed", identity: "provisional" },
      { reason: "cleanup-failed", identity: "provisional" },
      { reason: "cleanup-unconfirmed", identity: "provisional" },
    ]);
    expect(JSON.stringify(failed)).not.toMatch(/RAW_|INSPECTION|SHUTDOWN/u);
    const blocked = await controller.replace(install("replacement", runtime()));
    expect(blocked.installed).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
    const retry = await controller.retryUnconfirmedCleanup();
    expect(retry.diagnostics).toEqual([
      { reason: "cleanup-failed", identity: "provisional" },
      { reason: "cleanup-unconfirmed", identity: "provisional" },
    ]);
    expect((await controller.replace(install("still-blocked", runtime()))).installed).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("cleans a factory-owned scope when diagnostics inspection throws", async () => {
    const shutdown = vi.fn(async () => cleanup());
    const scope = fakeScope({
      diagnostics: () => { throw new Error("RAW_DIAGNOSTIC_SECRET"); },
      shutdown,
    });
    const controller = new SelectedMainMcpScopeController(inventoryHost(), async () => scope);
    const result = await controller.replace(install("inspection", runtime()));
    expect(result.diagnostics).toEqual([{ reason: "setup-failed", identity: "inspection" }]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("RAW_DIAGNOSTIC_SECRET");
  });

  it("makes a mutate-then-throw inventory publication inert, redacted, empty, and cleans exactly once", async () => {
    const retained: { source?: SelectedMainMcpInventorySource } = {};
    const host = {
      replaceSelectedMainMcpInventory(
        _slot: typeof SELECTED_MAIN_MCP_INVENTORY_SLOT,
        source: SelectedMainMcpInventorySource | undefined,
      ) {
        retained.source = source;
        if (source !== undefined) throw new Error("RAW_PUBLICATION_SECRET");
      },
    };
    const owned = runtime({
      tools: [tool("local", "write")],
      states: [{ name: "local", transport: "stdio", state: "connected" }],
    });
    const factory = (options: CreateAgentMcpScopeOptions) => createAgentMcpScope({ ...options, startInline: () => owned });
    const controller = new SelectedMainMcpScopeController(host, factory);
    const result = await controller.replace(install(
      "publisher",
      runtime(),
      declaration({ kind: "inline", name: "local" }),
      config(inline("local")),
    ));

    expect(result.diagnostics).toEqual([{ reason: "inventory-publication-failed", identity: "publisher" }]);
    expect(JSON.stringify(result)).not.toContain("RAW_PUBLICATION_SECRET");
    expect(retained.source?.tools()).toEqual([]);
    expect(owned.shutdownCalls).toBe(1);
    await expect(controller.adapter().callTool("local", "write", {})).rejects.toThrow("not active");
  });

  it.each(["throw-before", "mutate-then-throw"] as const)(
    "keeps retained inventory inert and blocks replacement after %s removal ambiguity until retry",
    async (mode) => {
      const retained: SelectedMainMcpInventorySource[] = [];
      let current: SelectedMainMcpInventorySource | undefined;
      let removalMutation: typeof mode | undefined;
      const host = {
        replaceSelectedMainMcpInventory(
          _slot: typeof SELECTED_MAIN_MCP_INVENTORY_SLOT,
          source: SelectedMainMcpInventorySource | undefined,
        ) {
          if (source === undefined && removalMutation === "throw-before") {
            removalMutation = undefined;
            throw new Error("RAW_REMOVE_SECRET");
          }
          current = source;
          if (source !== undefined) retained.push(source);
          if (source === undefined && removalMutation === "mutate-then-throw") {
            removalMutation = undefined;
            throw new Error("RAW_REMOVE_SECRET");
          }
        },
      };
      const factory = vi.fn(async () => fakeScope({ tools: () => [tool("same", "capability")] }));
      const controller = new SelectedMainMcpScopeController(host, factory);
      await controller.replace(install("A", runtime()));
      const aInventory = retained[0]!;
      removalMutation = mode;

      const blocked = await controller.replace(install("B", runtime()));
      expect(blocked.installed).toBe(false);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(aInventory.tools()).toEqual([]);
      expect(JSON.stringify(blocked)).not.toContain("RAW_REMOVE_SECRET");

      const retried = await controller.replace(install("B", runtime()));
      expect(retried.installed).toBe(true);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(current).toBe(retained[1]);
    },
  );

  it("fences queued/future replacement and completes selected shutdown before global shutdown enters", async () => {
    const selectedGate = deferred<void>();
    const globalGate = deferred<void>();
    const events: string[] = [];
    const owned = runtime({
      states: [{ name: "local", transport: "stdio", state: "connected" }],
      shutdownGate: selectedGate.promise,
      events,
    });
    let factoryCalls = 0;
    const factory = vi.fn((options: CreateAgentMcpScopeOptions) => {
      factoryCalls += 1;
      return createAgentMcpScope({ ...options, startInline: () => owned });
    });
    const controller = new SelectedMainMcpScopeController(inventoryHost(events), factory);
    await controller.replace(install("first", runtime(), declaration({ kind: "inline", name: "local" }), config(inline("local"))));

    const shuttingDown = controller.shutdownBeforeGlobal(async () => {
      events.push("global-enter");
      await globalGate.promise;
      events.push("global-complete");
    });
    const blockedReplacement = controller.replace(install("blocked", runtime()));
    await Promise.resolve();
    expect(factoryCalls).toBe(1);
    expect(events).not.toContain("global-enter");

    selectedGate.resolve();
    await waitUntil({
      description: "global shutdown to enter after selected cleanup",
      predicate: () => events.includes("global-enter"),
    });
    expect(events.indexOf("selected-shutdown-complete")).toBeLessThan(events.indexOf("global-enter"));
    expect(factoryCalls).toBe(1);
    globalGate.resolve();
    await shuttingDown;
    expect((await blockedReplacement).diagnostics).toEqual([{ reason: "shutdown-started", identity: "selected-main" }]);
    expect((await controller.replace(install("future", runtime()))).installed).toBe(false);
    expect(factoryCalls).toBe(1);
  });

  it("keeps replacement blocked when cleanup retry remains unconfirmed", async () => {
    const scope = fakeScope({
      tools: () => [tool("local", "capability")],
      shutdown: async () => cleanup([], ["local"]),
      retryUnconfirmedShutdown: async () => cleanup([], ["local"]),
    });
    const factory = vi.fn(async () => scope);
    const controller = new SelectedMainMcpScopeController(inventoryHost(), factory);
    await controller.replace(install("first", runtime()));
    expect((await controller.replace(install("blocked", runtime()))).installed).toBe(false);
    expect((await controller.retryUnconfirmedCleanup()).cleanup.unconfirmed).toEqual(["local"]);
    expect((await controller.replace(install("still-blocked", runtime()))).installed).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("keeps unconfirmed cleanup fail closed until an explicit successful retry", async () => {
    const uncertain = runtime({
      states: [{ name: "local", transport: "stdio", state: "connected" }],
      shutdown: cleanup([], ["local"]),
      retry: cleanup(["local"]),
    });
    const factory = vi.fn((options: CreateAgentMcpScopeOptions) => createAgentMcpScope({ ...options, startInline: () => uncertain }));
    const controller = new SelectedMainMcpScopeController(inventoryHost(), factory);
    await controller.replace(install("first", runtime(), declaration({ kind: "inline", name: "local" }), config(inline("local"))));

    expect((await controller.replace(install("blocked", runtime()))).installed).toBe(false);
    expect((await controller.replace(install("still-blocked", runtime()))).installed).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
    expect((await controller.retryUnconfirmedCleanup()).cleanup.unconfirmed).toEqual([]);
    expect((await controller.replace(install("admitted", runtime()))).installed).toBe(true);
  });

  it("normalizes hostile, unbounded, diagnostic-bearing, and malformed cleanup outcomes", async () => {
    const hostile = {
      confirmed: Array.from({ length: 300 }, (_, index) => `confirmed-${index}\u0000${"x".repeat(200)}`),
      unconfirmed: ["confirmed-0\u0000" + "x".repeat(200), "RAW_UNCONFIRMED\u0000"],
      diagnostics: ["RAW_RUNTIME_STDERR_SECRET"],
    };
    const hostileController = new SelectedMainMcpScopeController(
      inventoryHost(),
      async () => fakeScope({ shutdown: async () => hostile }),
    );
    await hostileController.replace(install("hostile", runtime()));
    const normalized = await hostileController.replace(undefined);
    expect(normalized.cleanup.confirmed.length).toBeLessThanOrEqual(128);
    expect(normalized.cleanup.unconfirmed).toHaveLength(2);
    expect([...normalized.cleanup.confirmed, ...normalized.cleanup.unconfirmed]
      .every((identity) => Array.from(identity).length <= 128)).toBe(true);
    expect(normalized.cleanup.confirmed).not.toContain(normalized.cleanup.unconfirmed[0]);
    expect(normalized.cleanup.diagnostics).toEqual(["runtime-cleanup-diagnostics-redacted"]);
    expect(JSON.stringify(normalized)).not.toMatch(/RAW_RUNTIME_STDERR_SECRET|[\p{Cc}\p{Cf}]/u);
    expect(Object.isFrozen(normalized.cleanup)).toBe(true);
    expect(Object.isFrozen(normalized.cleanup.confirmed)).toBe(true);
    expect(Object.isFrozen(normalized.cleanup.unconfirmed)).toBe(true);
    expect(Object.isFrozen(normalized.cleanup.diagnostics)).toBe(true);

    const malformedController = new SelectedMainMcpScopeController(
      inventoryHost(),
      async () => fakeScope({ shutdown: async () => null as never }),
    );
    await malformedController.replace(install("malformed\u0000identity", runtime()));
    const malformed = await malformedController.replace(undefined);
    expect(malformed.cleanup).toEqual({
      confirmed: [],
      unconfirmed: ["malformed identity"],
      diagnostics: ["cleanup-outcome-redacted"],
    });
    expect(malformed.diagnostics).toEqual([
      { reason: "cleanup-unconfirmed", identity: "malformed identity" },
    ]);
  });

  it("bounds and redacts setup diagnostics", async () => {
    const items = Array.from({ length: 140 }, (_, index) => ({ kind: "reference" as const, name: `missing-${index}` }));
    const controller = new SelectedMainMcpScopeController(inventoryHost());
    const result = await controller.replace(install("bounded\u0000", runtime(), declaration(...items), config()));
    expect(result.installed).toBe(true);
    expect(result.diagnostics).toHaveLength(128);
    expect(result.diagnostics.every((entry) => entry.reason === "missing-reference")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpCatalogDelta } from "../src/runtime/mcp-control.js";
import { McpMainSessionExposure, type McpExposureHost } from "../src/runtime/mcp-exposure.js";
import type { McpResourceServerInfo, McpToolInfo } from "../src/runtime/mcp.js";

function toolInfo(toolName = "echo", schema: Record<string, unknown> = { type: "object" }): McpToolInfo {
  return { serverName: "srv", toolName, description: `${toolName} description`, inputSchema: schema };
}

function delta(overrides: Partial<McpCatalogDelta> = {}): McpCatalogDelta {
  const info = toolInfo();
  return {
    serverName: "srv",
    definitionFingerprint: "definition-a",
    generation: 1,
    kind: "publish",
    tools: [{ info, wireDefinitionFingerprint: "tool-a" }],
    prompts: [],
    ...overrides,
  };
}

type HostInfo = ReturnType<McpExposureHost["getAllTools"]>[number];

class FakeHost implements McpExposureHost {
  readonly definitions = new Map<string, ToolDefinition<any, any>>();
  readonly registrations: string[] = [];
  readonly coordinatorSource = { path: "/picc", source: "test", scope: "project" } as HostInfo["sourceInfo"];
  active: string[] = [];
  onRegister?: (name: string) => void;
  onSetActive?: (names: string[]) => void;
  onGetAll?: (count: number) => void;
  registerFailure?: (definition: ToolDefinition<any, any>) => "before" | "after" | undefined;
  setActiveFailure?: (names: string[]) => "before" | "after" | undefined;
  private readonly info = new Map<string, HostInfo>();
  private getAllCount = 0;

  constructor(foreign: readonly string[] = []) {
    for (const name of foreign) this.installForeign(name);
  }

  installForeign(name: string, definition: Partial<ToolDefinition<any, any>> = {}): void {
    const complete = {
      name, label: name, description: "foreign", parameters: { type: "object" },
      async execute() { return { content: [{ type: "text", text: "foreign" }] }; },
      ...definition,
    } as ToolDefinition<any, any>;
    this.definitions.set(name, complete);
    this.info.set(name, {
      name,
      description: complete.description,
      parameters: complete.parameters,
      promptGuidelines: complete.promptGuidelines,
      sourceInfo: { path: `/foreign/${name}`, source: "test", scope: "project" } as HostInfo["sourceInfo"],
    });
  }

  remove(name: string): void {
    this.definitions.delete(name);
    this.info.delete(name);
    this.active = this.active.filter((entry) => entry !== name);
  }

  registerTool(definition: ToolDefinition<any, any>): void {
    const failure = this.registerFailure?.(definition);
    if (failure === "before") throw new Error("registration failed");
    this.definitions.set(definition.name, definition);
    this.info.set(definition.name, {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      promptGuidelines: definition.promptGuidelines,
      sourceInfo: this.coordinatorSource,
    });
    this.registrations.push(definition.name);
    if (!this.active.includes(definition.name)) this.active.push(definition.name);
    this.onRegister?.(definition.name);
    if (failure === "after") throw new Error("registration failed");
  }

  getActiveTools(): string[] { return [...this.active]; }
  getAllTools(): readonly HostInfo[] {
    this.getAllCount += 1;
    this.onGetAll?.(this.getAllCount);
    return [...this.info.values()];
  }
  setActiveTools(names: string[]): void {
    const failure = this.setActiveFailure?.(names);
    if (failure === "before") throw new Error("active set failed");
    this.active = [...names];
    this.onSetActive?.(names);
    if (failure === "after") throw new Error("active set failed");
  }

  isCoordinatorSourceInfo(sourceInfo: HostInfo["sourceInfo"]): boolean {
    return sourceInfo === this.coordinatorSource;
  }
}

function fixture(options: { foreign?: string[]; denied?: Set<string> } = {}) {
  const host = new FakeHost(options.foreign);
  const denied = options.denied ?? new Set<string>();
  let resources: McpResourceServerInfo[] = [];
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  let promptFailure = false;
  const exposure = new McpMainSessionExposure({
    host,
    source: {
      callTool,
      resourceServers: () => resources,
      readResource: async (_server, uri) => ({ contents: [{ uri, text: "resource" }] }),
    },
    permissionGate: {
      gateTools: (_granted, _disallowed, names) => names.filter((name) => !denied.has(name)),
    },
    clipMaxTokens: 1_000,
    reservedPromptNames: () => {
      if (promptFailure) throw new Error("prompt catalog failed");
      return new Set(["mcp__srv__local"]);
    },
  });
  return {
    exposure, host, denied, callTool,
    setResources: (value: McpResourceServerInfo[]) => { resources = value; },
    setPromptFailure: (value: boolean) => { promptFailure = value; },
  };
}

async function execute(tool: ToolDefinition<any, any>, params: Record<string, unknown> = {}) {
  return tool.execute("call", params, undefined, undefined, {} as never);
}

describe("McpMainSessionExposure tool ownership and generations", () => {
  it("late-registers a new tool, retires it, and reactivates an unchanged reconnect without re-registration", async () => {
    const { exposure, host } = fixture();
    const published = await exposure.apply(delta());
    expect(published).toMatchObject({ state: "applied", registered: ["mcp__srv__echo"], activated: ["mcp__srv__echo"] });
    expect(host.active).toContain("mcp__srv__echo");

    await exposure.apply(delta({ kind: "retire", generation: 2 }));
    expect(host.active).not.toContain("mcp__srv__echo");
    const reconnected = await exposure.apply(delta({ generation: 3 }));
    expect(reconnected).toMatchObject({ registered: [], refreshed: [], activated: ["mcp__srv__echo"] });
    expect(host.registrations).toEqual(["mcp__srv__echo"]);
  });

  it("refreshes an owned same-name definition when its exact wire fingerprint changes", async () => {
    const { exposure, host } = fixture();
    await exposure.apply(delta());
    await exposure.apply(delta({
      generation: 2,
      definitionFingerprint: "definition-b",
      tools: [{
        info: toolInfo("echo", { type: "object", properties: { count: { type: "number" } } }),
        wireDefinitionFingerprint: "tool-b",
      }],
    }));
    expect(host.registrations).toEqual(["mcp__srv__echo", "mcp__srv__echo"]);
    expect(host.definitions.get("mcp__srv__echo")?.parameters).toMatchObject({
      properties: { count: { type: "number" } },
    });
  });

  it("never replaces or deactivates a foreign exact-name collision", async () => {
    const name = "mcp__srv__echo";
    const { exposure, host } = fixture({ foreign: [name] });
    host.active = [name, "foreign-other"];
    const result = await exposure.apply(delta());
    expect(result.collisions).toEqual([name]);
    expect(host.registrations).toEqual([]);
    expect(host.active).toEqual([name, "foreign-other"]);
    await exposure.apply(delta({ kind: "retire", generation: 2 }));
    expect(host.active).toEqual([name, "foreign-other"]);
  });

  it("does not register or activate permission-denied definitions", async () => {
    const name = "mcp__srv__echo";
    const { exposure, host } = fixture({ denied: new Set([name]) });
    const result = await exposure.apply(delta());
    expect(result.denied).toEqual([name]);
    expect(host.registrations).toEqual([]);
    expect(host.active).toEqual([]);
  });

  it("coalesces exact duplicates and rejects stale and superseded generations before host commit", async () => {
    const { exposure, host } = fixture();
    const first = exposure.apply(delta());
    const duplicate = exposure.apply(delta());
    expect(duplicate).toBe(first);
    const stale = exposure.apply(delta({ generation: 0 }));
    const newest = exposure.apply(delta({ generation: 2, tools: [{ info: toolInfo("new"), wireDefinitionFingerprint: "new" }] }));
    await expect(first).resolves.toMatchObject({ state: "stale" });
    await expect(stale).resolves.toMatchObject({ state: "stale" });
    await expect(newest).resolves.toMatchObject({ state: "applied" });
    expect(host.registrations).toEqual(["mcp__srv__new"]);
  });

  it("re-reads at commit and preserves unrelated activation changes made after planning", async () => {
    const { exposure, host } = fixture({ foreign: ["removed-by-foreign", "added-by-foreign"] });
    host.active = ["removed-by-foreign"];
    const applying = exposure.apply(delta());
    await Promise.resolve();
    host.active = ["added-by-foreign"];
    await applying;
    expect(host.active).toEqual(["added-by-foreign", "mcp__srv__echo"]);
  });

  it("does not register a generation superseded during the serialized planning boundary", async () => {
    const { exposure, host } = fixture();
    const superseded = exposure.apply(delta());
    await Promise.resolve();
    const newest = exposure.apply(delta({
      generation: 2,
      tools: [{ info: toolInfo("newest"), wireDefinitionFingerprint: "newest" }],
    }));
    await expect(superseded).resolves.toMatchObject({ state: "stale" });
    await expect(newest).resolves.toMatchObject({ state: "applied" });
    expect(host.registrations).toEqual(["mcp__srv__newest"]);
  });

  it("keeps call-time runtime validation as the backstop after cleanup-uncertain retirement", async () => {
    const { exposure, host, callTool } = fixture();
    await exposure.apply(delta());
    const retained = host.definitions.get("mcp__srv__echo")!;
    await exposure.apply(delta({ kind: "retire", generation: 2 }));
    callTool.mockRejectedValueOnce(new Error("stale route"));
    await expect(execute(retained)).rejects.toThrow("stale route");
    expect(host.active).not.toContain("mcp__srv__echo");
  });

  it("rechecks permission after planning and compensates a newly autoactivated tool when permission is revoked", async () => {
    const name = "mcp__srv__echo";
    const { exposure, host, denied } = fixture();
    const applying = exposure.apply(delta());
    await Promise.resolve();
    denied.add(name);
    const result = await applying;
    expect(result).toMatchObject({ state: "applied", denied: [name], registered: [] });
    expect(host.registrations).toEqual([]);
    expect(host.active).toEqual([]);
  });

  it("treats a foreign registration added during the planning yield as a collision, but permits a removed transient", async () => {
    const name = "mcp__srv__echo";
    const first = fixture();
    const colliding = first.exposure.apply(delta());
    await Promise.resolve();
    first.host.installForeign(name);
    await expect(colliding).resolves.toMatchObject({ collisions: [name], registered: [] });
    expect(first.host.registrations).toEqual([]);

    const second = fixture();
    const transient = second.exposure.apply(delta());
    await Promise.resolve();
    second.host.installForeign(name);
    second.host.remove(name);
    await expect(transient).resolves.toMatchObject({ registered: [name] });
  });

  it("relinquishes a foreign takeover after ownership and never retires or refreshes that name", async () => {
    const name = "mcp__srv__echo";
    const { exposure, host } = fixture();
    await exposure.apply(delta());
    host.installForeign(name, { description: "takeover" });
    host.active = [name, "foreign-other"];
    const retired = await exposure.apply(delta({ kind: "retire", generation: 2 }));
    expect(retired.collisions).toEqual([name]);
    expect(host.active).toEqual([name, "foreign-other"]);
    await exposure.apply(delta({
      generation: 3,
      definitionFingerprint: "definition-b",
      tools: [{ info: toolInfo("echo", { type: "object", properties: { changed: { type: "boolean" } } }), wireDefinitionFingerprint: "tool-b" }],
    }));
    expect(host.registrations).toEqual([name]);
    expect(host.active).toEqual([name, "foreign-other"]);
  });

  it("lets a reentrant newer apply from registerTool own the final generation and prompt catalog", async () => {
    const { exposure, host } = fixture();
    let newest: Promise<unknown> | undefined;
    host.onRegister = () => {
      host.onRegister = undefined;
      newest = exposure.apply(delta({
        generation: 2,
        definitionFingerprint: "definition-new",
        tools: [{ info: toolInfo("newest"), wireDefinitionFingerprint: "newest" }],
        prompts: [{ info: { serverName: "srv", promptName: "new", description: "new", arguments: [] }, wireDefinitionFingerprint: "new" }],
      }));
    };
    const stale = await exposure.apply(delta({
      prompts: [{ info: { serverName: "srv", promptName: "old", description: "old", arguments: [] }, wireDefinitionFingerprint: "old" }],
    }));
    await newest;
    expect(stale.state).toBe("stale");
    expect(host.active).toEqual(["mcp__srv__newest"]);
    expect(exposure.promptCatalog().commands.map((command) => command.name)).toEqual(["mcp__srv__new"]);
  });

  it("compensates activation when permission is revoked reentrantly by setActiveTools", async () => {
    const name = "mcp__srv__echo";
    const { exposure, host, denied } = fixture();
    host.onSetActive = () => {
      host.onSetActive = undefined;
      denied.add(name);
    };
    const result = await exposure.apply(delta());
    expect(result).toMatchObject({
      state: "applied", registered: [name], activated: [name], deactivated: [name], denied: [name],
    });
    expect(host.active).toEqual([]);
  });

  it("lets a reentrant newer apply from setActiveTools own the final generation and prompt catalog", async () => {
    const { exposure, host } = fixture();
    let newest: Promise<unknown> | undefined;
    host.onSetActive = () => {
      host.onSetActive = undefined;
      newest = exposure.apply(delta({
        generation: 2,
        definitionFingerprint: "definition-new",
        tools: [{ info: toolInfo("newest"), wireDefinitionFingerprint: "newest" }],
        prompts: [{ info: { serverName: "srv", promptName: "new", description: "new", arguments: [] }, wireDefinitionFingerprint: "new" }],
      }));
    };
    const stale = await exposure.apply(delta({
      prompts: [{ info: { serverName: "srv", promptName: "old", description: "old", arguments: [] }, wireDefinitionFingerprint: "old" }],
    }));
    await newest;
    expect(stale.state).toBe("stale");
    expect(host.active).toEqual(["mcp__srv__newest"]);
    expect(exposure.promptCatalog().commands.map((command) => command.name)).toEqual(["mcp__srv__new"]);
  });

  it.each(["before", "after"] as const)(
    "contains a registration throw %s mutation to its tool, preserves its sibling, and retries later",
    async (timing) => {
      const { exposure, host } = fixture();
      host.registerFailure = (definition) => definition.name.endsWith("__echo") ? timing : undefined;
      const two = delta({ tools: [
        { info: toolInfo("echo"), wireDefinitionFingerprint: "echo" },
        { info: toolInfo("sibling"), wireDefinitionFingerprint: "sibling" },
      ] });
      const failed = await exposure.apply(two);
      expect(failed.failures).toEqual(["registration:mcp__srv__echo"]);
      expect(failed.registered).toEqual(timing === "after"
        ? ["mcp__srv__echo", "mcp__srv__sibling"]
        : ["mcp__srv__sibling"]);
      expect(failed.activated).toEqual(timing === "after"
        ? ["mcp__srv__echo", "mcp__srv__sibling"]
        : ["mcp__srv__sibling"]);
      expect(failed.deactivated).toEqual(timing === "after" ? ["mcp__srv__echo"] : []);
      expect(host.active).toEqual(["mcp__srv__sibling"]);
      host.registerFailure = undefined;
      const recovered = await exposure.apply(two);
      expect(recovered.registered).toEqual(["mcp__srv__echo"]);
      expect(host.active).toEqual(expect.arrayContaining(["mcp__srv__echo", "mcp__srv__sibling"]));
    },
  );

  it("preserves the old definition when a changed refresh throws before mutation and retries the same generation", async () => {
    const name = "mcp__srv__echo";
    const { exposure, host } = fixture();
    await exposure.apply(delta());
    const oldDefinition = host.definitions.get(name)!;
    host.registerFailure = () => "before";
    const changed = delta({
      generation: 2,
      definitionFingerprint: "definition-b",
      tools: [{ info: toolInfo("echo", { type: "object", properties: { changed: { type: "boolean" } } }), wireDefinitionFingerprint: "tool-b" }],
    });

    const failed = await exposure.apply(changed);
    expect(failed).toMatchObject({
      state: "failed", registered: [], refreshed: [], activated: [], deactivated: [name],
      failures: [`registration:${name}`], collisions: [],
    });
    expect(host.definitions.get(name)).toBe(oldDefinition);
    expect(host.definitions.get(name)?.parameters).toEqual({ type: "object" });
    expect(host.active).toEqual([]);

    host.registerFailure = undefined;
    const recovered = await exposure.apply(changed);
    expect(recovered).toMatchObject({ state: "applied", registered: [], refreshed: [name], activated: [name] });
    expect(host.definitions.get(name)).not.toBe(oldDefinition);
    expect(host.definitions.get(name)?.parameters).toMatchObject({ properties: { changed: { type: "boolean" } } });
    expect(host.active).toEqual([name]);
  });

  it("deactivates an exact changed-definition throw residue and retries the refresh at the same generation", async () => {
    const name = "mcp__srv__echo";
    const { exposure, host } = fixture();
    await exposure.apply(delta());
    host.active = [];
    host.registerFailure = () => "after";
    const changed = delta({
      generation: 2,
      definitionFingerprint: "definition-b",
      tools: [{ info: toolInfo("echo", { type: "object", properties: { changed: { type: "boolean" } } }), wireDefinitionFingerprint: "tool-b" }],
    });
    const failed = await exposure.apply(changed);
    expect(failed).toMatchObject({
      state: "failed", refreshed: [name], activated: [name], deactivated: [name],
      failures: [`registration:${name}`], collisions: [],
    });
    expect(host.active).toEqual([]);
    host.registerFailure = undefined;
    const recovered = await exposure.apply(changed);
    expect(recovered).toMatchObject({ state: "applied", refreshed: [name], activated: [name] });
    expect(host.active).toEqual([name]);
  });

  it("retains cleanup authority after failed refresh compensation and retirement retries deactivation", async () => {
    const name = "mcp__srv__echo";
    const { exposure, host } = fixture();
    await exposure.apply(delta());
    host.registerFailure = () => "after";
    host.setActiveFailure = () => "before";
    const failed = await exposure.apply(delta({
      generation: 2,
      definitionFingerprint: "definition-b",
      tools: [{ info: toolInfo("echo", { type: "object", properties: { changed: { type: "boolean" } } }), wireDefinitionFingerprint: "tool-b" }],
    }));
    expect(failed).toMatchObject({
      state: "failed", refreshed: [name], activated: [], deactivated: [],
      failures: expect.arrayContaining([`registration:${name}`, "compensation"]), collisions: [],
    });
    expect(host.active).toEqual([name]);
    host.registerFailure = undefined;
    host.setActiveFailure = undefined;
    const retired = await exposure.apply(delta({ kind: "retire", generation: 3, definitionFingerprint: "definition-b" }));
    expect(retired).toMatchObject({ state: "applied", deactivated: [name], collisions: [] });
    expect(host.active).toEqual([]);
  });

  it("relinquishes a post-throw exact-definition residue with foreign provenance", async () => {
    const name = "mcp__srv__echo";
    const { exposure, host } = fixture();
    host.registerFailure = () => "after";
    host.onRegister = () => {
      host.onRegister = undefined;
      const attempted = host.definitions.get(name)!;
      host.installForeign(name, attempted);
    };
    const failed = await exposure.apply(delta());
    expect(failed).toMatchObject({
      state: "failed", registered: [], collisions: [name], failures: [`registration:${name}`],
    });
    host.registerFailure = undefined;
    await exposure.apply(delta());
    expect(host.registrations).toEqual([name]);
    expect(host.active).toEqual([name]);
  });

  it("retries a failed first-registration compensation at the same generation without losing ownership", async () => {
    const name = "mcp__srv__echo";
    const { exposure, host } = fixture();
    host.registerFailure = () => "after";
    host.setActiveFailure = () => "before";
    const failed = await exposure.apply(delta());
    expect(failed).toMatchObject({
      state: "failed", registered: [name], activated: [name], deactivated: [],
      failures: expect.arrayContaining([`registration:${name}`, "compensation"]), collisions: [],
    });
    expect(host.active).toEqual([name]);
    host.registerFailure = undefined;
    host.setActiveFailure = undefined;
    const recovered = await exposure.apply(delta());
    expect(recovered).toMatchObject({ state: "applied", registered: [name], collisions: [] });
    expect(host.active).toEqual([name]);
  });

  it.each(["before", "after"] as const)(
    "reports active-set failure %s mutation, compensates exact new names, and recovers later",
    async (timing) => {
      const { exposure, host } = fixture();
      let failedOnce = false;
      host.setActiveFailure = () => {
        if (failedOnce) return undefined;
        failedOnce = true;
        return timing;
      };
      const failed = await exposure.apply(delta());
      expect(failed).toMatchObject({
        state: "failed",
        registered: ["mcp__srv__echo"],
        activated: ["mcp__srv__echo"],
        deactivated: ["mcp__srv__echo"],
        failures: ["active-set"],
      });
      expect(host.active).toEqual([]);
      host.setActiveFailure = undefined;
      const recovered = await exposure.apply(delta({ generation: 2 }));
      expect(recovered.activated).toEqual(["mcp__srv__echo"]);
      expect(host.active).toEqual(["mcp__srv__echo"]);
    },
  );

  it("reports failed compensation from observed activation truth", async () => {
    const { exposure, host } = fixture();
    host.setActiveFailure = () => "before";
    const result = await exposure.apply(delta());
    expect(result).toMatchObject({
      state: "failed",
      registered: ["mcp__srv__echo"],
      activated: ["mcp__srv__echo"],
      deactivated: [],
      failures: ["active-set", "compensation"],
    });
    expect(host.active).toEqual(["mcp__srv__echo"]);
  });

  it("reports exact changed-definition refresh fields", async () => {
    const { exposure } = fixture();
    await exposure.apply(delta());
    const changed = await exposure.apply(delta({
      generation: 2,
      definitionFingerprint: "definition-b",
      tools: [{ info: toolInfo("echo", { type: "object", properties: { count: { type: "number" } } }), wireDefinitionFingerprint: "tool-b" }],
    }));
    expect(changed).toEqual({
      state: "applied", serverName: "srv", generation: 2,
      registered: [], refreshed: ["mcp__srv__echo"], activated: [], deactivated: [],
      denied: [], collisions: [], failures: [], paletteRefreshAvailable: false,
    });
  });

  it("drops ambiguous exact names produced by different component boundaries", async () => {
    const { exposure, host } = fixture();
    const first = await exposure.apply(delta({
      serverName: "srv_",
      tools: [{ info: { ...toolInfo("echo"), serverName: "srv_" }, wireDefinitionFingerprint: "one" }],
    }));
    expect(first.registered).toEqual(["mcp__srv___echo"]);
    const second = await exposure.apply(delta({
      serverName: "srv",
      generation: 2,
      definitionFingerprint: "definition-two",
      tools: [{ info: toolInfo("_echo"), wireDefinitionFingerprint: "two" }],
    }));
    expect(second.collisions).toContain("mcp__srv___echo");
    expect(host.active).not.toContain("mcp__srv___echo");
  });
});

describe("McpMainSessionExposure resource and prompt projections", () => {
  it("activates fixed resource tools while any capable server exists and removes them with the last server", async () => {
    const { exposure, host, setResources } = fixture();
    const resourceServer: McpResourceServerInfo = { serverName: "srv", resources: [] };
    setResources([resourceServer]);
    const publish = delta({ tools: [], resourceServer: { info: resourceServer, wireDefinitionFingerprint: "resources-a" } });
    await exposure.apply(publish);
    expect(host.active).toEqual(expect.arrayContaining(["ListMcpResourcesTool", "ReadMcpResourceTool"]));
    await exposure.apply(delta({ ...publish, kind: "retire", generation: 2 }));
    expect(host.active).not.toContain("ListMcpResourcesTool");
    expect(host.active).not.toContain("ReadMcpResourceTool");
  });

  it("refreshes typed prompt routing, preserves local and normalized collisions, and reports palette limits", async () => {
    const { exposure } = fixture();
    const result = await exposure.apply(delta({
      tools: [],
      prompts: [
        { info: { serverName: "srv", promptName: "review", description: "review", arguments: [] }, wireDefinitionFingerprint: "p1" },
        { info: { serverName: "srv", promptName: "local", description: "local", arguments: [] }, wireDefinitionFingerprint: "p2" },
        { info: { serverName: "srv", promptName: "a.b", description: "one", arguments: [] }, wireDefinitionFingerprint: "p3" },
        { info: { serverName: "srv", promptName: "a/b", description: "two", arguments: [] }, wireDefinitionFingerprint: "p4" },
      ],
    }));
    expect(result.paletteRefreshAvailable).toBe(false);
    expect(exposure.promptCatalog().commands.map((command) => command.name)).toEqual(["mcp__srv__review"]);
    expect(exposure.promptCatalog().diagnostics).toEqual(expect.arrayContaining([
      "Dropped colliding MCP prompt command /mcp__srv__a_b.",
      "Local command /mcp__srv__local takes precedence over a colliding MCP prompt.",
    ]));

    await exposure.apply(delta({ kind: "retire", generation: 2, tools: [], prompts: [] }));
    expect(exposure.promptCatalog().commands).toEqual([]);
  });

  it("keeps the prior prompt catalog atomic and preserves confirmed tool truth when refresh fails", async () => {
    const { exposure, host, setPromptFailure } = fixture();
    await exposure.apply(delta({
      tools: [],
      prompts: [{ info: { serverName: "srv", promptName: "old", description: "old", arguments: [] }, wireDefinitionFingerprint: "old" }],
    }));
    setPromptFailure(true);
    const failed = await exposure.apply(delta({
      generation: 2,
      definitionFingerprint: "definition-b",
      tools: [{ info: toolInfo("new"), wireDefinitionFingerprint: "new" }],
      prompts: [{ info: { serverName: "srv", promptName: "new", description: "new", arguments: [] }, wireDefinitionFingerprint: "new" }],
    }));
    expect(failed).toMatchObject({
      state: "failed",
      registered: ["mcp__srv__new"],
      activated: ["mcp__srv__new"],
      failures: ["prompt-catalog"],
    });
    expect(host.active).toEqual(["mcp__srv__new"]);
    expect(exposure.promptCatalog().commands.map((command) => command.name)).toEqual(["mcp__srv__old"]);
  });
});

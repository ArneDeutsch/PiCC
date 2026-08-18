import { describe, expect, it } from "vitest";
import {
  createMcpAdministrationInventory,
  MCP_ADMINISTRATION_INVENTORY_LIMITS,
} from "../src/mcp-administration/inventory.js";
import type { McpAdministrationTrace } from "../src/mcp-administration/model.js";
import { commandBasename } from "../src/mcp-administration/review-definition.js";

function trace(count = 1): McpAdministrationTrace {
  return Object.freeze({
    version: 1,
    policyPosture: "absent",
    observations: Object.freeze([]),
    omittedDeclarationCount: 0,
    declarations: Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
      name: `server-${index}`,
      source: "project-mcpjson" as const,
      authority: Object.freeze({ kind: "mutable" as const, scope: "project" as const }),
      precedence: "winner" as const,
      definitionVersion: 1 as const,
      definitionDigest: `mcp-review-v1:${String(index).padStart(64, "0")}`,
      summary: Object.freeze({
        transport: "stdio" as const,
        commandBasename: "node",
        argumentCount: 2,
        environmentKeyCount: 1,
        headerKeyCount: 0,
        timeoutConfigured: false,
      }),
      policy: "allowed" as const,
      review: "pending" as const,
      status: "pending-approval" as const,
      inactiveReason: "mcpjson-unapproved" as const,
    }))),
  });
}

describe("MCP administration inventory", () => {
  it("keeps standalone declaration posture distinct from optional live state", () => {
    const standalone = createMcpAdministrationInventory(trace());
    expect(standalone.servers[0]).toMatchObject({
      name: "server-0",
      live: "not-running",
      capabilityCounts: { tools: 0, prompts: 0, resources: 0 },
    });
    const live = createMcpAdministrationInventory(trace(), [{
      name: "server-0",
      state: "connected",
      toolCount: 3,
      promptCount: 2,
      resourceCount: 1,
    }]);
    expect(live.servers[0]).toMatchObject({
      status: "pending-approval",
      live: "connected",
      capabilityCounts: { tools: 3, prompts: 2, resources: 1 },
    });
    expect(Object.isFrozen(live)).toBe(true);
    expect(Object.isFrozen(live.servers)).toBe(true);
    expect(Object.isFrozen(live.servers[0])).toBe(true);
    expect(Object.isFrozen(live.servers[0]?.capabilityCounts)).toBe(true);
    expect(live.omittedDeclarationCount).toBe(0);
  });

  it("bounds rows and capability counts deterministically", () => {
    const inventory = createMcpAdministrationInventory(trace(MCP_ADMINISTRATION_INVENTORY_LIMITS.servers + 20), [{
      name: "server-0",
      state: "connected",
      toolCount: Number.MAX_SAFE_INTEGER,
      promptCount: -1,
      resourceCount: Number.NaN,
    }]);
    expect(inventory.servers).toHaveLength(MCP_ADMINISTRATION_INVENTORY_LIMITS.servers);
    expect(inventory.servers[0]?.capabilityCounts).toEqual({
      tools: MCP_ADMINISTRATION_INVENTORY_LIMITS.capabilityCount,
      prompts: 0,
      resources: 0,
    });
    expect(inventory.omittedDeclarationCount).toBe(20);
    expect(inventory.observations).toContain("administration-declarations-omitted");
  });

  it("reconstructs the public projection without private review or recursive secret canaries", () => {
    const canary = "RECURSIVE_SECRET_CANARY";
    const knownDigest = trace().declarations[0]!.definitionDigest!;
    const hostile = trace().declarations[0] as unknown as Record<string, unknown>;
    const envValueCanary = "e";
    const headerValueCanary = "h";
    const input = {
      ...trace(),
      declarations: [{
        ...hostile,
        rawJson: { nested: [{ value: canary }], env: { TOKEN: envValueCanary }, headers: { Authorization: headerValueCanary } },
        summary: { ...(hostile.summary as object), hidden: { value: canary } },
        authority: { ...(hostile.authority as object), hidden: canary },
      }],
    } as unknown as McpAdministrationTrace;
    const live: Parameters<typeof createMcpAdministrationInventory>[1] = [
      { name: "server-0", state: "failed", diagnostic: canary, exception: { message: canary } },
    ] as never;
    const inventory = createMcpAdministrationInventory(input, live);
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(`:${JSON.stringify(envValueCanary)}`);
    expect(serialized).not.toContain(`:${JSON.stringify(headerValueCanary)}`);
    expect(serialized).not.toContain(knownDigest);
    expect(serialized).not.toContain("definitionVersion");
    expect(serialized).not.toContain("definitionDigest");
    expect(inventory.servers[0]?.summary).toEqual({
      transport: "stdio",
      commandBasename: "node",
      argumentCount: 2,
      environmentKeyCount: 1,
      headerKeyCount: 0,
      timeoutConfigured: false,
    });
  });

  it.each([
    ["C:\\private\\bin\\server.exe", "server.exe"],
    ["/private/bin/server", "server"],
  ])("keeps only the basename of platform-independent command path %s", (commandPath, expected) => {
    const input = trace();
    const inventory = createMcpAdministrationInventory({
      ...input,
      declarations: [{ ...input.declarations[0]!, summary: { ...input.declarations[0]!.summary, commandBasename: commandBasename(commandPath) } }],
    });
    expect(inventory.servers[0]?.summary.commandBasename).toBe(expected);
    expect(JSON.stringify(inventory)).not.toContain(commandPath);
  });
});

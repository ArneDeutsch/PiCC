import { describe, expect, it } from "vitest";
import { renderMainSessionTool } from "../src/runtime/main-session-tool-render.js";
import { MainSessionCheckpointGate } from "../src/runtime/mid-run-compaction.js";

const theme = {
  fg: (_slot: string, text: string) => text,
  bold: (text: string) => text,
};
const componentLines = (component: { render(width: number): string[] }) => component.render(120);

function tool(name: string, extra: Record<string, unknown> = {}): any {
  return {
    name,
    description: `${name} description`,
    parameters: { sentinel: name },
    execute: async () => name,
    ...extra,
  };
}

describe("main-session tool presentation router", () => {
  it("routes custom and stock search families while forwarding display roots", () => {
    const custom = renderMainSessionTool(tool("Grep"), {
      resolveDisplayRoot: () => "/repo/worktree",
      repositoryRoot: "/repo",
    });
    expect(componentLines(custom.renderCall!(
      { pattern: "needle", path: "/repo/worktree/src" },
      theme as never,
      { state: {}, argsComplete: true, isPartial: false } as never,
    ))).toEqual([]);

    const stock = renderMainSessionTool(tool("grep"), {
      resolveDisplayRoot: () => "/repo/worktree",
      repositoryRoot: "/repo",
    });
    const lines = componentLines(stock.renderCall!(
      { pattern: "needle", path: "/repo/worktree/src" },
      theme as never,
      { state: {}, argsComplete: true, isPartial: false } as never,
    ));
    expect(lines.join("\n")).toContain("grep needle");
    expect(lines.join("\n")).toContain("src");
  });

  it("forwards an admitted MCP fallback label through the shared self shell", () => {
    const routed = renderMainSessionTool(tool("mcp__friendly__lookup"), {
      fallbackCallDisplayName: "Friendly lookup",
    });
    const lines = componentLines(routed.renderCall!(
      {}, theme as never, { state: {}, isPartial: true } as never,
    ));
    expect(lines.join("\n")).toContain("Friendly lookup");
    expect(routed.renderShell).toBe("self");
  });

  it("changes only presentation descriptors before one outer execute wrapper", async () => {
    const schema = { identity: "schema" };
    const execute = async () => "raw";
    let accessorReads = 0;
    const source = tool("WebFetch", { parameters: schema, execute });
    Object.defineProperty(source, "sentinel", {
      enumerable: false,
      configurable: true,
      get: () => {
        accessorReads += 1;
        return "sentinel";
      },
    });
    const before = Object.getOwnPropertyDescriptor(source, "sentinel");
    const routed = renderMainSessionTool(source);

    expect(routed.parameters).toBe(schema);
    expect(routed.execute).toBe(execute);
    expect(Object.getOwnPropertyDescriptor(routed, "sentinel")).toEqual(before);
    expect(accessorReads).toBe(0);
    for (const key of Reflect.ownKeys(source)) {
      if (["renderCall", "renderResult", "renderShell"].includes(String(key))) continue;
      expect(Object.getOwnPropertyDescriptor(routed, key)).toEqual(Object.getOwnPropertyDescriptor(source, key));
    }

    const gate = new MainSessionCheckpointGate("render-contract", 90);
    const checkpointed = gate.wrapTool(routed);
    expect(checkpointed.execute).not.toBe(routed.execute);
    expect(await (checkpointed.execute as any)("id", {}, undefined, undefined, undefined)).toBe("raw");
  });
});

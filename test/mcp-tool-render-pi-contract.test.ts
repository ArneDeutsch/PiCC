import { describe, expect, it } from "vitest";
import { initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildMcpProxyTools, type McpToolSource } from "../src/runtime/mcp-tools.js";
import { withDefaultCollapsedToolRendering } from "../src/runtime/default-collapsed-tool-render.js";
import { withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";
import { wrapForSelfShell } from "../src/runtime/tool-shell.js";

const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

function plain(lines: string[]): string[] {
  return lines.map((line) => line.replace(ANSI_RE, ""));
}

function proxyDefinition(): ToolDefinition {
  const source: McpToolSource = {
    tools: () => [{
      serverName: "Srv.Name",
      toolName: "Echo__V2",
      description: "echoes exactly",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }],
    callTool: async () => ({ content: [{ type: "text", text: "canonical result" }] }),
  };
  const proxy = buildMcpProxyTools(source)[0]!;
  const decorated = withDefaultCollapsedToolRendering(withRoutineToolRendering(proxy));
  return wrapForSelfShell(decorated as unknown as Record<string, unknown>, {
    fallbackCallDisplayName: proxy.label,
  }) as unknown as ToolDefinition;
}

function row(definition: ToolDefinition, id: string): ToolExecutionComponent {
  return new ToolExecutionComponent(
    definition.name,
    id,
    { text: "unchanged argument" },
    {},
    definition,
    { requestRender() {} } as never,
    process.cwd().replace(/\\/gu, "/"),
  );
}

describe("MCP self-shell fallback display name", () => {
  it("keeps non-MCP labels inert, preserves override bytes, and gives existing renderers precedence", () => {
    const args = { value: "argument bytes" };
    const source = {
      name: "CanonicalWireName",
      label: "conflicting arbitrary label",
      parameters: { type: "object" },
      execute: async () => undefined,
    };
    const sourceBefore = { ...source };
    const argsBefore = structuredClone(args);

    const ordinary = wrapForSelfShell(source);
    const ordinaryText = plain((ordinary.renderCall as Function)(args, undefined, { state: {}, isPartial: true }).render(120));
    expect(ordinaryText.join("\n")).toContain("canonical wire name");
    expect(ordinaryText.join("\n")).not.toContain(source.label);

    const overridden = wrapForSelfShell(source, { fallbackCallDisplayName: "Echo__V2 (Srv.Name MCP)" });
    const overrideText = plain((overridden.renderCall as Function)(args, undefined, { state: {}, isPartial: true }).render(120));
    expect(overrideText.join("\n")).toContain("Echo__V2 (Srv.Name MCP)");
    expect(overrideText.join("\n")).not.toContain("echo v2");

    const rendered = wrapForSelfShell({
      ...source,
      renderCall: () => ({ render: () => ["renderer wins"] }),
    }, { fallbackCallDisplayName: "must not render" });
    expect(plain((rendered.renderCall as Function)(args, undefined, { state: {}, isPartial: true }).render(120)))
      .toEqual(["○ renderer wins"]);

    expect(source).toEqual(sourceBefore);
    expect(args).toEqual(argsBefore);
    expect(overridden.name).toBe(source.name);
    expect(overridden.label).toBe(source.label);
    expect(overridden.execute).toBe(source.execute);
    expect(overridden.parameters).toBe(source.parameters);
  });
});

describe("real Pi MCP tool-row contract", () => {
  it("renders the friendly title for pending, success, failure, and constrained widths", () => {
    initTheme();
    const definition = proxyDefinition();
    expect(definition.name).toBe("mcp__Srv.Name__Echo__V2");
    expect(definition.label).toBe("Echo__V2 (Srv.Name MCP)");

    const pending = row(definition, "mcp-pending");
    pending.setArgsComplete();
    const pendingLines = plain(pending.render(80) as string[])
      .filter((line) => visibleWidth(line) > 0);
    expect(pendingLines).toEqual(["○ Echo__V2 (Srv.Name MCP)"]);
    expect(pendingLines.join("\n")).not.toContain(definition.name);

    const canonicalResult = Object.freeze({
      content: Object.freeze([{ type: "text" as const, text: "canonical result" }]),
      details: Object.freeze({ server: "Srv.Name", tool: "Echo__V2" }),
      isError: false,
    });
    const canonicalBefore = JSON.stringify(canonicalResult);
    const success = row(definition, "mcp-success");
    success.setArgsComplete();
    success.updateResult(canonicalResult as never, false);
    const successLines = plain(success.render(80) as string[])
      .filter((line) => visibleWidth(line) > 0);
    expect(successLines[0]).toBe("● Echo__V2 (Srv.Name MCP)");
    const successText = successLines.join("\n");
    expect(successText).toContain("canonical result");
    expect(successText).not.toContain(definition.name);
    expect(JSON.stringify(canonicalResult)).toBe(canonicalBefore);

    const failure = row(definition, "mcp-failure");
    failure.setArgsComplete();
    failure.updateResult({ ...canonicalResult, content: [{ type: "text", text: "canonical failure" }], isError: true } as never, false);
    const failureLines = plain(failure.render(80) as string[])
      .filter((line) => visibleWidth(line) > 0);
    expect(failureLines[0]).toBe("✗ Echo__V2 (Srv.Name MCP)");
    expect(failureLines.join("\n")).not.toContain(definition.name);

    const narrowRows = [
      { width: 1, expected: ["○"] },
      { width: 2, expected: ["○ "] },
      { width: 8, expected: ["○ Echo_…"] },
      { width: 16, expected: ["○ Echo__V2 (Srv…"] },
    ];
    for (const { width, expected } of narrowRows) {
      const narrow = row(definition, `mcp-narrow-${width}`);
      narrow.setArgsComplete();
      const lines = narrow.render(width) as string[];
      const plainLines = plain(lines).filter((line) => visibleWidth(line) > 0);
      expect(plainLines).toEqual(expected);
      expect(plainLines.join("\n")).not.toContain(definition.name);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});

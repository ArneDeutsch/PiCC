import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager, initTheme } from "@earendil-works/pi-coding-agent";
import { wrapForSelfShell } from "../src/runtime/tool-shell.js";
import { buildMcpProxyTools } from "../src/runtime/mcp-tools.js";
import { withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";
import { renderAgentCall, renderAgentResult, renderSendMessageCall, renderSendMessageResult, renderTaskOutputCall } from "../src/runtime/subagent-render.js";

type HtmlExportModule = {
  exportSessionToHtml(
    session: SessionManager,
    state: unknown,
    options: { outputPath: string; toolRenderer: unknown },
  ): Promise<string>;
};

type HtmlRendererModule = {
  createToolHtmlRenderer(deps: {
    getToolDefinition(name: string): Record<string, unknown> | undefined;
    theme: unknown;
    cwd: string;
    width: number;
  }): unknown;
};

const HOSTILE = '<img src=x onerror="boom">& hostile';

function textComponent(text: string): { render(width: number): string[] } {
  return {
    render(width) {
      return [text.slice(0, Math.max(0, width))];
    },
  };
}

describe("Pi-owned assembled HTML tool-row boundary", () => {
  it("retains Pi cards and built-ins while escaping custom glyph fragments without mutating canonical entries", async () => {
    initTheme();
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIndex = mainUrl.indexOf("/dist/");
    expect(distIndex, "unexpected Pi dist layout").toBeGreaterThan(0);
    const piDist = mainUrl.slice(0, distIndex);
    const htmlRendererModule = await import(
      `${piDist}/dist/core/export-html/tool-renderer.js`
    ) as HtmlRendererModule;
    const htmlExportModule = await import(
      `${piDist}/dist/core/export-html/index.js`
    ) as HtmlExportModule;
    const themeModule = await import(
      `${piDist}/dist/modes/interactive/theme/theme.js`
    ) as { theme: unknown };

    const directory = mkdtempSync(join(tmpdir(), "picc-html-boundary-"));
    const outputPath = join(directory, "session.html");
    const requestedDefinitions: string[] = [];
    const customDefinition = wrapForSelfShell({
      name: "CustomBoundary",
      renderCall(args: Record<string, unknown>) {
        return textComponent(`CustomBoundary ${String(args.query)}`);
      },
      renderResult(result: { content?: Array<{ type?: string; text?: string }> }) {
        return textComponent(result.content?.[0]?.text ?? "");
      },
    });
    const routineDefinition = wrapForSelfShell(withRoutineToolRendering({
      name: "EnterWorktree", label: "EnterWorktree", description: "test", parameters: {},
      async execute() { return { content: [] }; },
    } as never, {
      repositoryRoot: directory,
      resolveDisplayRoot: () => { throw new Error("export must use its supplied context"); },
    }) as unknown as Record<string, unknown>);
    const sendMessageDefinition = wrapForSelfShell({
      name: "SendMessage",
      renderCall: renderSendMessageCall,
      renderResult: (result: unknown, _options: unknown, theme: unknown, context: unknown) =>
        renderSendMessageResult(result as never, theme, context as never),
    });
    const mcpProxy = buildMcpProxyTools({
      tools: () => [{
        serverName: "fixture",
        toolName: "echo",
        description: "echoes text back",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      }],
      callTool: async () => ({ content: [{ type: "text", text: "unused" }] }),
    })[0]!;
    const mcpDefinition = wrapForSelfShell(mcpProxy as unknown as Record<string, unknown>, {
      fallbackCallDisplayName: mcpProxy.label,
    });
    const lifecycleDefinitions: Record<string, Record<string, unknown>> = {
      Agent: wrapForSelfShell({
        name: "Agent",
        renderCall: renderAgentCall,
        renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) =>
          renderAgentResult(result, options, theme, context as never, { surface: "agent", resolveAgentColor: () => "blue" }),
      }),
      TaskOutput: wrapForSelfShell({
        name: "TaskOutput",
        renderCall: renderTaskOutputCall,
        renderResult: (result: unknown, options: unknown, theme: unknown, context: unknown) =>
          renderAgentResult(result, options, theme, context as never, { surface: "task-output", resolveAgentColor: () => "magenta" }),
      }),
    };
    const toolRenderer = htmlRendererModule.createToolHtmlRenderer({
      getToolDefinition: (name) => {
        requestedDefinitions.push(name);
        return name === "CustomBoundary"
          ? customDefinition
          : name === mcpProxy.name
            ? mcpDefinition
            : name === "EnterWorktree"
              ? routineDefinition
              : name === "SendMessage"
                ? sendMessageDefinition
                : lifecycleDefinitions[name];
      },
      theme: themeModule.theme,
      cwd: join(directory, "workspace"),
      width: 100,
    });

    try {
      const session = SessionManager.create(directory, directory, { id: "tool-row-html-boundary" });
      session.appendMessage({
        role: "assistant",
        content: [
          { type: "toolCall", id: "stock-read", name: "read", arguments: { path: HOSTILE } },
          { type: "toolCall", id: "custom-boundary", name: "CustomBoundary", arguments: { query: HOSTILE } },
          { type: "toolCall", id: "mcp-friendly", name: mcpProxy.name, arguments: { text: HOSTILE } },
          { type: "toolCall", id: "agent-lifecycle", name: "Agent", arguments: { subagent_type: "reviewer", description: "Review HTML" } },
          { type: "toolCall", id: "task-lifecycle", name: "TaskOutput", arguments: { task_id: "task-7" } },
          { type: "toolCall", id: "routine-worktree", name: "EnterWorktree", arguments: { name: "html-proof" } },
          { type: "toolCall", id: "send-ordinary", name: "SendMessage", arguments: { to: "reviewer", message: "HTML-MESSAGE-MUST-STAY-HIDDEN" } },
          { type: "toolCall", id: "send-exceptional", name: "SendMessage", arguments: { to: "reviewer", message: "HTML-EXCEPTION-MESSAGE-HIDDEN" } },
        ],
        stopReason: "toolUse",
      } as never);
      session.appendMessage({
        role: "toolResult",
        toolCallId: "stock-read",
        toolName: "read",
        content: [{ type: "text", text: HOSTILE }],
        details: undefined,
        isError: false,
      } as never);
      session.appendMessage({
        role: "toolResult",
        toolCallId: "custom-boundary",
        toolName: "CustomBoundary",
        content: [{ type: "text", text: HOSTILE }],
        details: { preserved: HOSTILE },
        isError: false,
      } as never);
      session.appendMessage({
        role: "toolResult",
        toolCallId: "mcp-friendly",
        toolName: mcpProxy.name,
        content: [{ type: "text", text: HOSTILE }],
        details: { server: "fixture", tool: "echo" },
        isError: false,
      } as never);
      session.appendMessage({
        role: "toolResult", toolCallId: "agent-lifecycle", toolName: "Agent",
        content: [{ type: "text", text: "agent body" }],
        details: { outcome: "completed", agent: "reviewer", agentId: "agent-aabbccddeeff" }, isError: false,
      } as never);
      session.appendMessage({
        role: "toolResult", toolCallId: "task-lifecycle", toolName: "TaskOutput",
        content: [{ type: "text", text: "task body" }],
        details: { taskId: "task-7", outcome: "failed", status: "failed", agent: "reviewer", error: "failed safely" }, isError: true,
      } as never);
      session.appendMessage({
        role: "toolResult", toolCallId: "routine-worktree", toolName: "EnterWorktree",
        content: [{ type: "text", text: "entered" }],
        details: { worktreePath: join(directory, "other", HOSTILE), branch: "feature/html", created: true, seeded: [], previousUnlockAttempted: false }, isError: false,
      } as never);
      session.appendMessage({
        role: "toolResult", toolCallId: "send-ordinary", toolName: "SendMessage",
        content: [{ type: "text", text: 'Message delivered to running agent agent-aabbccddeeff ("reviewer") as a mid-task course correction.' }],
        details: { agentId: "agent-aabbccddeeff", agent: "reviewer", description: "review", delivery: "steer" }, isError: false,
      } as never);
      session.appendMessage({
        role: "toolResult", toolCallId: "send-exceptional", toolName: "SendMessage",
        content: [{ type: "text", text: `EXCEPTIONAL ${HOSTILE}` }],
        details: { delivery: "checkpoint-recovery", outcome: "failed", recovered: false, truncated: false }, isError: true,
      } as never);
      const canonicalBytes = Buffer.from(JSON.stringify(session.getEntries()), "utf8");

      await htmlExportModule.exportSessionToHtml(session, {
        tools: [{
          name: mcpProxy.name,
          description: mcpProxy.description,
          parameters: mcpProxy.parameters,
        }],
      }, { outputPath, toolRenderer });

      expect(Buffer.from(JSON.stringify(session.getEntries()), "utf8")).toEqual(canonicalBytes);
      const html = readFileSync(outputPath, "utf8");
      for (const [state, variable] of [
        ["pending", "toolPendingBg"],
        ["success", "toolSuccessBg"],
        ["error", "toolErrorBg"],
      ] as const) {
        expect(html).toMatch(new RegExp(
          String.raw`\.tool-execution\.${state}\s*\{[^}]*background\s*:\s*var\(\s*--${variable}\s*\)`,
          "u",
        ));
      }

      const encoded = html.match(
        /<script id="session-data" type="application\/json">([^<]+)<\/script>/u,
      )?.[1];
      expect(encoded).toBeDefined();
      const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as {
        entries: unknown[];
        tools?: Array<{ name: string }>;
        renderedTools?: Record<string, {
          callHtml?: string;
          resultHtmlCollapsed?: string;
          resultHtmlExpanded?: string;
        }>;
      };
      expect(Buffer.from(JSON.stringify(data.entries), "utf8")).toEqual(canonicalBytes);
      expect(JSON.stringify(data.entries)).toContain('"name":"read"');
      expect(data.tools?.map((tool) => tool.name)).toEqual(["mcp__fixture__echo"]);
      expect(JSON.stringify(data.tools)).not.toContain("echo (fixture MCP)");
      expect(requestedDefinitions).toContain("CustomBoundary");
      expect(requestedDefinitions).toContain("mcp__fixture__echo");
      expect(requestedDefinitions).not.toContain("read");
      expect(data.renderedTools?.["stock-read"]).toBeUndefined();

      const mcp = data.renderedTools?.["mcp-friendly"];
      expect(mcp?.callHtml).toContain("mcp");
      expect(mcp?.callHtml).toContain("echo");
      expect(mcp?.callHtml).toContain("server fixture");
      expect(mcp?.callHtml).not.toContain("mcp__fixture__echo");
      expect(mcp?.callHtml).not.toContain("hostile");
      expect(mcp?.resultHtmlCollapsed).toContain("click to show detail");
      expect(mcp?.resultHtmlCollapsed).not.toMatch(/ctrl|alt|expand/u);
      expect(mcp?.resultHtmlExpanded).toContain("&lt;img src=x onerror=&quot;boom&quot;&gt;&amp; hostile");
      expect(mcp?.resultHtmlExpanded).not.toContain("click to show detail");
      expect(mcp?.resultHtmlExpanded).not.toMatch(/ctrl|alt/u);
      expect(JSON.stringify(data.entries)).toContain('"name":"mcp__fixture__echo"');
      expect(JSON.stringify(data.entries)).toContain('"toolName":"mcp__fixture__echo"');

      const custom = data.renderedTools?.["custom-boundary"];
      expect(custom?.callHtml).toContain("○");
      expect(custom?.resultHtmlExpanded).toContain("●");
      for (const fragment of [custom?.callHtml, custom?.resultHtmlExpanded]) {
        expect(fragment).toContain("&lt;img src=x onerror=&quot;boom&quot;&gt;&amp; hostile");
        expect(fragment).not.toContain("<img");
      }
      const routine = data.renderedTools?.["routine-worktree"];
      expect(routine?.resultHtmlExpanded).toContain("repo:other");
      expect(routine?.resultHtmlExpanded).toContain("&lt;img");
      expect(routine?.resultHtmlExpanded).not.toContain("<img");

      const ordinary = data.renderedTools?.["send-ordinary"];
      expect(ordinary?.callHtml).toContain("○");
      expect(ordinary?.callHtml ?? "").not.toMatch(/reviewer|HTML-MESSAGE|mid-task|delivered/u);
      const ordinaryResultFragments = [ordinary?.resultHtmlCollapsed, ordinary?.resultHtmlExpanded].filter(Boolean) as string[];
      expect(ordinaryResultFragments).toHaveLength(1);
      expect(ordinaryResultFragments[0]).toContain("reviewer");
      expect(ordinaryResultFragments[0]).not.toContain("HTML-MESSAGE-MUST-STAY-HIDDEN");
      expect(ordinaryResultFragments[0]).not.toContain("Message delivered to running agent");
      expect(ordinaryResultFragments.filter((fragment) => fragment.includes("send message"))).toHaveLength(1);

      const exceptional = data.renderedTools?.["send-exceptional"];
      const exceptionalFragments = [exceptional?.resultHtmlCollapsed, exceptional?.resultHtmlExpanded].filter(Boolean) as string[];
      expect(exceptionalFragments).not.toHaveLength(0);
      expect(exceptionalFragments.join("\n")).toContain("EXCEPTIONAL");
      expect(exceptionalFragments.join("\n")).toContain("&lt;img src=x onerror=&quot;boom&quot;&gt;&amp; hostile");

      for (const id of ["agent-lifecycle", "task-lifecycle", "routine-worktree", "send-ordinary", "send-exceptional"]) {
        const lifecycle = data.renderedTools?.[id];
        expect(lifecycle).toBeDefined();
        for (const fragment of [lifecycle?.callHtml, lifecycle?.resultHtmlCollapsed, lifecycle?.resultHtmlExpanded]) {
          expect(fragment ?? "").not.toContain("\u001b");
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager, initTheme } from "@earendil-works/pi-coding-agent";
import { wrapForSelfShell } from "../src/runtime/tool-shell.js";

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
    const toolRenderer = htmlRendererModule.createToolHtmlRenderer({
      getToolDefinition: (name) => {
        requestedDefinitions.push(name);
        return name === "CustomBoundary" ? customDefinition : undefined;
      },
      theme: themeModule.theme,
      cwd: process.cwd(),
      width: 100,
    });

    const directory = mkdtempSync(join(tmpdir(), "picc-html-boundary-"));
    const outputPath = join(directory, "session.html");
    try {
      const session = SessionManager.create(directory, directory, { id: "tool-row-html-boundary" });
      session.appendMessage({
        role: "assistant",
        content: [
          { type: "toolCall", id: "stock-read", name: "read", arguments: { path: HOSTILE } },
          { type: "toolCall", id: "custom-boundary", name: "CustomBoundary", arguments: { query: HOSTILE } },
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
      const canonicalBytes = Buffer.from(JSON.stringify(session.getEntries()), "utf8");

      await htmlExportModule.exportSessionToHtml(session, undefined, { outputPath, toolRenderer });

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
        renderedTools?: Record<string, {
          callHtml?: string;
          resultHtmlCollapsed?: string;
          resultHtmlExpanded?: string;
        }>;
      };
      expect(Buffer.from(JSON.stringify(data.entries), "utf8")).toEqual(canonicalBytes);
      expect(JSON.stringify(data.entries)).toContain('"name":"read"');
      expect(requestedDefinitions).toContain("CustomBoundary");
      expect(requestedDefinitions).not.toContain("read");
      expect(data.renderedTools?.["stock-read"]).toBeUndefined();

      const custom = data.renderedTools?.["custom-boundary"];
      expect(custom?.callHtml).toContain("○");
      expect(custom?.resultHtmlExpanded).toContain("●");
      for (const fragment of [custom?.callHtml, custom?.resultHtmlExpanded]) {
        expect(fragment).toContain("&lt;img src=x onerror=&quot;boom&quot;&gt;&amp; hostile");
        expect(fragment).not.toContain("<img");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

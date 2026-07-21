import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";
import { wrapForSelfShell } from "../src/runtime/tool-shell.js";

const cases = [
  {
    name: "WebFetch" as const,
    args: { url: "https://example.test/invoked" },
    ordinary: {
      content: [{ type: "text", text: "CANONICAL FETCH BODY" }],
      details: {
        url: "https://example.test/invoked",
        finalUrl: "https://redirect.test/final",
        status: 200,
        contentType: "text/html",
        truncated: true,
      },
      isError: false,
    },
    invocation: "https://example.test/invoked",
    hidden: "CANONICAL FETCH BODY",
  },
  {
    name: "WebSearch" as const,
    args: { query: "contract query" },
    ordinary: {
      content: [{ type: "text", text: "CANONICAL SEARCH TITLE\nCANONICAL SEARCH SNIPPET" }],
      details: { query: "contract query", backend: "duckduckgo", resultCount: 0, truncated: false },
      isError: false,
    },
    invocation: "contract query",
    hidden: "CANONICAL SEARCH TITLE",
  },
];

function definition(name: "WebFetch" | "WebSearch"): Record<string, unknown> {
  return wrapForSelfShell(withRoutineToolRendering({ name } as never));
}

describe("real Pi routine rendering composition", () => {
  it.each(cases)("gives settled $name exactly one interactive content row in collapsed and expanded modes", async (entry) => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const build = (payload: unknown, partial = false) => {
      const component = new sdk.ToolExecutionComponent(
        entry.name,
        `${entry.name}-contract`,
        entry.args,
        {},
        definition(entry.name),
        { requestRender() {} },
        process.cwd().replace(/\\/g, "/"),
      );
      component.updateResult(payload, partial);
      return component;
    };
    const paint = (component: any, expanded: boolean): string[] => {
      component.setExpanded(expanded);
      const lines = component.render(100) as string[];
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
      return lines;
    };

    for (const expanded of [false, true]) {
      const lines = paint(build(entry.ordinary), expanded);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("");
      expect(lines[1]).toContain(entry.invocation);
      expect(lines.join("\n")).not.toContain(entry.hidden);
    }

    const partial = paint(build(entry.ordinary, true), false).join("\n");
    expect(partial).toContain(entry.hidden);
    const failure = paint(build({ content: [{ type: "text", text: `${entry.name} visible failure` }], isError: true }), false).join("\n");
    expect(failure).toContain(`${entry.name} visible failure`);
    const malformed = paint(build({ content: [{ type: "text", text: `${entry.name} unfamiliar result` }], details: { future: true }, isError: false }), false).join("\n");
    expect(malformed).toContain(`${entry.name} unfamiliar result`);
  });

  async function htmlHarness(entry: (typeof cases)[number]) {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIndex = mainUrl.indexOf("/dist/");
    expect(distIndex, "unexpected Pi dist layout").toBeGreaterThan(0);
    const piDist = mainUrl.slice(0, distIndex);
    const htmlModule = await import(`${piDist}/dist/core/export-html/tool-renderer.js`) as any;
    const exportModule = await import(`${piDist}/dist/core/export-html/index.js`) as any;
    const themeModule = await import(`${piDist}/dist/modes/interactive/theme/theme.js`) as any;
    const renderer = htmlModule.createToolHtmlRenderer({
      getToolDefinition: (name: string) => name === entry.name ? definition(entry.name) : undefined,
      theme: themeModule.theme,
      cwd: process.cwd(),
      width: 80,
    });
    return { sdk, exportModule, renderer };
  }

  it.each(cases)("keeps ordinary $name HTML result compact while malformed/error results remain visible", async (entry) => {
    const { renderer } = await htmlHarness(entry);
    const id = `html-${entry.name}`;
    expect(renderer.renderCall(id, entry.name, entry.args)).toBe("");
    const rendered = renderer.renderResult(
      id,
      entry.name,
      entry.ordinary.content,
      entry.ordinary.details,
      false,
    );
    expect(rendered?.expanded).toContain(entry.invocation);
    expect(rendered?.expanded).not.toContain(entry.hidden);
    expect(rendered?.collapsed).toBeUndefined();

    for (const [suffix, text, details, isError] of [
      ["error", `${entry.name} HTML failure`, undefined, true],
      ["malformed", `${entry.name} HTML unfamiliar`, { future: true }, false],
    ] as const) {
      const resultId = `${id}-${suffix}`;
      renderer.renderCall(resultId, entry.name, entry.args);
      const visible = renderer.renderResult(
        resultId,
        entry.name,
        [{ type: "text", text }],
        details,
        isError,
      );
      expect(visible?.expanded).toContain(text);
    }
  });

  it.each(cases)("retains canonical $name session content but excludes it from complete rendered HTML", async (entry) => {
    const { sdk, exportModule, renderer } = await htmlHarness(entry);
    const directory = mkdtempSync(join(tmpdir(), "picc-routine-export-"));
    const outputPath = join(directory, `${entry.name}.html`);
    try {
      const session = sdk.SessionManager.create(directory, directory, {
        id: `compact-${entry.name.toLowerCase()}`,
      });
      const toolCallId = `export-${entry.name}`;
      session.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: entry.name, arguments: entry.args }],
        stopReason: "toolUse",
      } as never);
      session.appendMessage({
        role: "toolResult",
        toolCallId,
        toolName: entry.name,
        content: entry.ordinary.content,
        details: entry.ordinary.details,
        isError: false,
      } as never);

      await exportModule.exportSessionToHtml(session, undefined, { outputPath, toolRenderer: renderer });
      const html = readFileSync(outputPath, "utf8");
      const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
      expect(encoded).toBeDefined();
      const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
      const canonical = data.entries.find(
        (candidate: any) => candidate.message?.role === "toolResult" && candidate.message.toolCallId === toolCallId,
      );
      const rendered = data.renderedTools?.[toolCallId];

      expect(JSON.stringify(canonical?.message?.content)).toContain(entry.hidden);
      expect(rendered?.callHtml).toBeUndefined();
      expect(rendered?.resultHtmlExpanded).toContain(entry.invocation);
      expect(rendered?.resultHtmlExpanded).not.toContain(entry.hidden);
      expect(rendered?.resultHtmlCollapsed).toBeUndefined();
      expect(html).toContain(
        'html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;',
      );
      expect(html).not.toContain(entry.hidden);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { SessionManager, initTheme } from "@earendil-works/pi-coding-agent";

interface HtmlExportModule {
  exportSessionToHtml(session: SessionManager, state: unknown, options: { outputPath: string; toolRenderer: unknown }): Promise<string>;
}
interface HtmlRendererModule {
  createToolHtmlRenderer(dependencies: {
    getToolDefinition(name: string): unknown;
    theme: unknown;
    cwd: string;
  }): unknown;
}

describe("stock Read/Bash HTML ownership", () => {
  it("bypasses custom renderers for ordinary and exceptional lowercase built-ins without changing canonical data", async () => {
    initTheme();
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIndex = mainUrl.indexOf("/dist/");
    const piDist = mainUrl.slice(0, distIndex);
    const htmlExport = await import(`${piDist}/dist/core/export-html/index.js`) as HtmlExportModule;
    const htmlRenderer = await import(`${piDist}/dist/core/export-html/tool-renderer.js`) as HtmlRendererModule;
    const themeModule = await import(`${piDist}/dist/modes/interactive/theme/theme.js`) as { theme: unknown };
    const directory = mkdtempSync(join(tmpdir(), "picc-stock-html-"));
    const outputPath = join(directory, "session.html");
    const requested = vi.fn();
    const toolRenderer = htmlRenderer.createToolHtmlRenderer({
      getToolDefinition(name) {
        requested(name);
        throw new Error("lowercase stock tools must bypass custom rendering");
      },
      theme: themeModule.theme,
      cwd: directory,
    });
    try {
      const session = SessionManager.create(directory, directory, { id: "stock-read-bash-html" });
      session.appendMessage({
        role: "assistant", stopReason: "toolUse", content: [
          { type: "toolCall", id: "read-ok", name: "read", arguments: { path: "ordinary.txt" } },
          { type: "toolCall", id: "read-error", name: "read", arguments: { path: "missing.txt" } },
          { type: "toolCall", id: "bash-ok", name: "bash", arguments: { command: "printf ordinary" } },
          { type: "toolCall", id: "bash-error", name: "bash", arguments: { command: "false", timeout: 3 } },
        ],
      } as never);
      for (const entry of [
        { toolCallId: "read-ok", toolName: "read", text: "READ CANONICAL BODY", isError: false },
        { toolCallId: "read-error", toolName: "read", text: "READ CANONICAL ERROR", isError: true },
        { toolCallId: "bash-ok", toolName: "bash", text: "BASH CANONICAL BODY", isError: false },
        { toolCallId: "bash-error", toolName: "bash", text: "Command exited with code 1", isError: true },
      ]) {
        session.appendMessage({
          role: "toolResult", ...entry, content: [{ type: "text", text: entry.text }], details: undefined,
        } as never);
      }
      const canonical = JSON.stringify(session.getEntries());
      await htmlExport.exportSessionToHtml(session, {}, { outputPath, toolRenderer });
      expect(JSON.stringify(session.getEntries())).toBe(canonical);
      expect(requested).not.toHaveBeenCalled();
      const html = readFileSync(outputPath, "utf8");
      const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/u)?.[1];
      expect(encoded).toBeDefined();
      const visibleHtml = html.replace(/<script id="session-data"[\s\S]*?<\/script>/u, "");
      expect(visibleHtml).toContain("case 'read'");
      expect(visibleHtml).toContain("case 'bash'");
      const stockScript = [...visibleHtml.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/gu)]
        .map((match) => match[1] ?? "").find((script) => script.includes("function renderToolCall(call)"));
      expect(stockScript).toBeDefined();
      const runtime: { __renderToolCall?: (call: unknown) => string; window?: unknown } = {
        window: { addEventListener() {}, getSelection: () => ({ toString: () => "" }), location: { search: "" } },
      };
      runInNewContext(stockScript!
        .replace("function renderToolCall(call) {", "globalThis.__renderToolCall = function renderToolCall(call) {")
        .replace("// Initial render", "return; // Initial render"), {
        ...runtime,
        globalThis: runtime,
        document: { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById(id: string) {
          return id === "session-data" ? { textContent: encoded } : {
            addEventListener() {}, appendChild() {}, innerHTML: "", textContent: "", value: "",
            style: {}, classList: { add() {}, remove() {}, toggle() {} },
          };
        } },
        atob,
        btoa,
        console,
        setTimeout,
        clearTimeout,
        TextDecoder,
        Uint8Array,
        URLSearchParams,
        marked: { use() {}, parse: (value: string) => value },
        hljs: { getLanguage: () => false, highlight: (value: string) => ({ value }) },
      });
      const renderStock = runtime.__renderToolCall;
      expect(renderStock).toBeTypeOf("function");
      for (const [call, visible] of [
        [{ type: "toolCall", id: "read-ok", name: "read", arguments: { path: "ordinary.txt" } }, ["ordinary.txt", "READ CANONICAL BODY"]],
        [{ type: "toolCall", id: "read-error", name: "read", arguments: { path: "missing.txt" } }, ["missing.txt", "READ CANONICAL ERROR"]],
        [{ type: "toolCall", id: "bash-ok", name: "bash", arguments: { command: "printf ordinary" } }, ["printf ordinary", "BASH CANONICAL BODY"]],
        [{ type: "toolCall", id: "bash-error", name: "bash", arguments: { command: "false", timeout: 3 } }, ["false", "Command exited with code 1"]],
      ] as const) {
        const rendered = renderStock!(call);
        for (const text of visible) expect(rendered).toContain(text);
      }
      const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as {
        entries: unknown[];
        renderedTools?: Record<string, unknown>;
      };
      expect(JSON.stringify(data.entries)).toBe(canonical);
      expect(data.renderedTools?.["read-ok"]).toBeUndefined();
      expect(data.renderedTools?.["read-error"]).toBeUndefined();
      expect(data.renderedTools?.["bash-ok"]).toBeUndefined();
      expect(data.renderedTools?.["bash-error"]).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

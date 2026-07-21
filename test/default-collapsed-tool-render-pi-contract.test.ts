import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { withDefaultCollapsedToolRendering } from "../src/runtime/default-collapsed-tool-render.js";
import { wrapForSelfShell } from "../src/runtime/tool-shell.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function installExpansionBinding(keys: string[] | undefined): () => void {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    },
    { "app.tools.expand": keys as never },
  ));
  return () => setKeybindings(previous);
}

function withExpansionBinding<T>(keys: string[] | undefined, run: () => T): T {
  const restore = installExpansionBinding(keys);
  try {
    return run();
  } finally {
    restore();
  }
}

async function withExpansionBindingAsync<T>(keys: string[] | undefined, run: () => Promise<T>): Promise<T> {
  const restore = installExpansionBinding(keys);
  try {
    return await run();
  } finally {
    restore();
  }
}

describe("real Pi default-collapsed rendering contract", () => {
  it("drives Read through live, settlement, expansion, and re-collapse as one semantic settled row", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withExpansionBinding(["ctrl+k"], () => {
      const args = { path: "contract.txt" };
      const result = { content: [{ type: "text", text: "first\nsecond" }], details: undefined };
      const source = sdk.createReadToolDefinition(process.cwd());
      const decorated = wrapForSelfShell(withDefaultCollapsedToolRendering(source));
      const component = new sdk.ToolExecutionComponent(
        "read",
        "collapsed-read-contract",
        args,
        {},
        decorated,
        { requestRender() {} },
        process.cwd().replace(/\\/g, "/"),
      );

      component.setArgsComplete();
      const live = (component.render(80) as string[]).map(stripAnsi).join("\n");
      expect(live).toContain("contract.txt");
      expect(live).not.toContain("lines hidden");

      component.markExecutionStarted();
      component.updateResult(result, true);
      const partial = (component.render(80) as string[]).map(stripAnsi).join("\n");
      expect(partial).toContain("contract.txt");
      expect(partial).not.toContain("lines hidden");

      component.updateResult(result, false);
      const collapsed = component.render(80) as string[];
      expect(collapsed).toHaveLength(2);
      expect(collapsed[0]).toBe("");
      expect(stripAnsi(collapsed[1] ?? "")).toContain("Read contract.txt · 2 lines hidden · ctrl+k to expand");
      expect(collapsed.join("\n")).not.toContain("first");

      component.setExpanded(true);
      const expanded = (component.render(80) as string[]).map(stripAnsi);
      expect(expanded.filter((line) => line.includes("contract.txt"))).toHaveLength(1);
      expect(expanded.filter((line) => line.includes("first"))).toHaveLength(1);
      expect(expanded.filter((line) => line.includes("second"))).toHaveLength(1);
      for (const line of expanded) expect(visibleWidth(line)).toBeLessThanOrEqual(80);

      component.setExpanded(false);
      const recollapsed = (component.render(80) as string[]).map(stripAnsi);
      expect(recollapsed).toHaveLength(2);
      expect(recollapsed.join("\n")).toContain("2 lines hidden");
      expect(recollapsed.join("\n")).not.toContain("first");
    });
  });

  it("uses remapped expansion state and leaves settled Write native when the action is unbound", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const args = { path: "write-contract.txt", content: "SECRET WRITE BODY" };
    const result = {
      content: [{ type: "text", text: `Successfully wrote ${args.content.length} bytes to ${args.path}` }],
      details: undefined,
    };

    withExpansionBinding(["alt+x"], () => {
      const component = new sdk.ToolExecutionComponent(
        "write", "write-bound", args, {},
        wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createWriteToolDefinition(process.cwd()))),
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      component.updateResult(result, false);
      const collapsed = (component.render(100) as string[]).map(stripAnsi).join("\n");
      expect(collapsed).toContain("alt+x to expand");
      expect(collapsed).not.toContain("SECRET WRITE BODY");
      component.setExpanded(true);
      expect((component.render(100) as string[]).map(stripAnsi).join("\n")).toContain("SECRET WRITE BODY");
    });

    withExpansionBinding([], () => {
      const longArgs = { path: args.path, content: Array.from({ length: 12 }, (_, index) => `WRITE-${index}`).join("\n") };
      const longResult = { content: [{ type: "text", text: `Successfully wrote ${longArgs.content.length} bytes to ${longArgs.path}` }], details: undefined };
      const component = new sdk.ToolExecutionComponent(
        "write", "write-unbound", longArgs, {},
        wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createWriteToolDefinition(process.cwd()))),
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      component.updateResult(longResult, false);
      const settled = (component.render(100) as string[]).map(stripAnsi).join("\n");
      expect(settled).toContain("WRITE-11");
      expect(settled).not.toContain("more lines");
      expect(settled).not.toContain("lines hidden");

      const readArgs = { path: "unbound-read.txt" };
      const read = new sdk.ToolExecutionComponent(
        "read", "read-unbound", readArgs, {},
        wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createReadToolDefinition(process.cwd()))),
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      read.updateResult({ content: [{ type: "text", text: "ordinary read body" }], details: undefined }, false);
      expect((read.render(100) as string[]).map(stripAnsi).join("\n")).toContain("ordinary read body");
    });
  });

  it("matches stock Pi display normalization for CR and trailing empty lines", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withExpansionBinding(["ctrl+o"], () => {
      for (const [text, expected] of [["one\rtwo", "1 line hidden"], ["one\r\ntwo\n\n", "2 lines hidden"]] as const) {
        const args = { path: "normalize.txt" };
        const component = new sdk.ToolExecutionComponent(
          "read", `normalize-${expected}`, args, {},
          wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createReadToolDefinition(process.cwd()))),
          { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
        );
        component.updateResult({ content: [{ type: "text", text }], details: undefined }, false);
        expect((component.render(80) as string[]).map(stripAnsi).join("\n")).toContain(expected);
      }
    });
  });

  it("retains partial native result state through real self-shell collapse and repeated expansion", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withExpansionBinding(["ctrl+o"], () => {
      const resultCalls: Array<{ last: unknown; returned: { id: number; render(width: number): string[] } }> = [];
      let serial = 0;
      const source = {
        name: "read", label: "read", description: "real continuity probe", parameters: {}, execute() {},
        renderCall: () => ({ render: () => ["native call"] }),
        renderResult(_result: unknown, _options: unknown, _theme: unknown, context: { lastComponent?: unknown }) {
          const returned = { id: ++serial, render: () => [`native result ${serial}`] };
          resultCalls.push({ last: context.lastComponent, returned });
          return returned;
        },
      };
      const args = { path: "continuity.txt" };
      const result = { content: [{ type: "text", text: "settled" }], details: undefined };
      const component = new sdk.ToolExecutionComponent(
        "read", "real-continuity", args, {},
        wrapForSelfShell(withDefaultCollapsedToolRendering(source as never)),
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      component.markExecutionStarted();
      component.updateResult({ content: [{ type: "text", text: "partial" }], details: undefined }, true);
      component.render(80);
      expect(resultCalls).toHaveLength(1);
      expect(resultCalls[0]!.last).toBeUndefined();

      component.updateResult(result, false);
      expect((component.render(80) as string[]).map(stripAnsi).join("\n")).toContain("1 line hidden");
      expect(resultCalls).toHaveLength(1);

      component.setExpanded(true);
      component.render(80);
      expect(resultCalls).toHaveLength(2);
      expect(resultCalls[1]!.last).toBe(resultCalls[0]!.returned);

      component.setExpanded(false);
      component.render(80);
      expect(resultCalls).toHaveLength(2);

      component.setExpanded(true);
      component.render(80);
      expect(resultCalls).toHaveLength(3);
      expect(resultCalls[2]!.last).toBe(resultCalls[1]!.returned);
    });
  });

  it("keeps a real execution-only frame native and does not invoke the result renderer", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withExpansionBinding(["ctrl+o"], () => {
      let resultCalls = 0;
      const source = {
        name: "read", label: "read", description: "execution probe", parameters: {}, execute() {},
        renderCall: () => ({ render: () => ["EXECUTION STILL RUNNING"] }),
        renderResult: () => { resultCalls++; return { render: () => ["unexpected result"] }; },
      };
      const component = new sdk.ToolExecutionComponent(
        "read", "execution-only", { path: "running.txt" }, {},
        wrapForSelfShell(withDefaultCollapsedToolRendering(source as never)),
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      component.markExecutionStarted();
      const rendered = (component.render(60) as string[]).map(stripAnsi).join("\n");
      expect(rendered).toContain("EXECUTION STILL RUNNING");
      expect(rendered).not.toContain("hidden");
      expect(resultCalls).toBe(0);
    });
  });

  it("retains native renderer state across collapsed/expanded toggles", () => withExpansionBinding(["ctrl+o"], () => {
    const calls: Array<{ slot: "call" | "result"; last: unknown }> = [];
    let serial = 0;
    const source = {
      name: "read",
      label: "read",
      description: "probe",
      parameters: {},
      execute() {},
      renderCall(_args: unknown, _theme: unknown, context: { lastComponent?: unknown }) {
        calls.push({ slot: "call", last: context.lastComponent });
        return { id: ++serial, render: () => ["native call"] };
      },
      renderResult(_result: unknown, _options: unknown, _theme: unknown, context: { lastComponent?: unknown }) {
        calls.push({ slot: "result", last: context.lastComponent });
        return { id: ++serial, render: () => ["native result"] };
      },
    };
    const tool = withDefaultCollapsedToolRendering(source as never) as any;
    const args = { path: "state.txt" };
    const result = { content: [{ type: "text", text: "body" }], details: undefined };
    const state = {};
    let callComponent = tool.renderCall(args, undefined, { args, state, isPartial: false });
    let resultComponent = tool.renderResult(result, { expanded: false, isPartial: false }, undefined, {
      args, state, isPartial: false, isError: false,
    });
    callComponent = tool.renderCall(args, undefined, { args, state, isPartial: false, expanded: true, lastComponent: callComponent });
    resultComponent = tool.renderResult(result, { expanded: true, isPartial: false }, undefined, {
      args, state, isPartial: false, isError: false, expanded: true, lastComponent: resultComponent,
    });
    callComponent = tool.renderCall(args, undefined, { args, state, isPartial: false, lastComponent: callComponent });
    resultComponent = tool.renderResult(result, { expanded: false, isPartial: false }, undefined, {
      args, state, isPartial: false, isError: false, lastComponent: resultComponent,
    });
    tool.renderCall(args, undefined, { args, state, isPartial: false, expanded: true, lastComponent: callComponent });
    tool.renderResult(result, { expanded: true, isPartial: false }, undefined, {
      args, state, isPartial: false, isError: false, expanded: true, lastComponent: resultComponent,
    });
    const callEntries = calls.filter((entry) => entry.slot === "call");
    const resultEntries = calls.filter((entry) => entry.slot === "result");
    expect(callEntries.map((entry) => Boolean(entry.last))).toEqual([false, true, true, true]);
    expect((callEntries[1]!.last as { id: number }).id).toBe(1);
    expect((callEntries[2]!.last as { id: number }).id).toBe(2);
    expect((callEntries[3]!.last as { id: number }).id).toBe(4);
    expect(resultEntries).toHaveLength(2);
    expect(resultEntries[0]!.last).toBeUndefined();
    expect((resultEntries[1]!.last as { id: number }).id).toBe(3);
  }));

  it("keeps complete stock Read and Write HTML exports on Pi's unchanged native path", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const piDist = mainUrl.slice(0, mainUrl.indexOf("/dist/"));
    const exportModule = await import(`${piDist}/dist/core/export-html/index.js`) as any;
    const htmlModule = await import(`${piDist}/dist/core/export-html/tool-renderer.js`) as any;
    const themeModule = await import(`${piDist}/dist/modes/interactive/theme/theme.js`) as any;
    const definitions = new Map([
      ["read", withDefaultCollapsedToolRendering(sdk.createReadToolDefinition(process.cwd()))],
      ["write", withDefaultCollapsedToolRendering(sdk.createWriteToolDefinition(process.cwd()))],
    ]);
    const renderer = htmlModule.createToolHtmlRenderer({
      getToolDefinition: (name: string) => definitions.get(name), theme: themeModule.theme, cwd: process.cwd(),
    });
    const directory = mkdtempSync(join(tmpdir(), "picc-file-export-"));
    try {
      const session = sdk.SessionManager.create(directory, directory, { id: "stock-file-export" });
      for (const entry of [
        { id: "stock-read", name: "read", args: { path: "stock.txt" }, text: "STOCK READ HTML BODY", details: undefined },
        { id: "stock-write", name: "write", args: { path: "stock-write.txt", content: "STOCK WRITE HTML BODY" }, text: "Successfully wrote 21 bytes to stock-write.txt", details: undefined },
      ]) {
        session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: entry.id, name: entry.name, arguments: entry.args }], stopReason: "toolUse" } as never);
        session.appendMessage({ role: "toolResult", toolCallId: entry.id, toolName: entry.name,
          content: [{ type: "text", text: entry.text }], details: entry.details, isError: false } as never);
      }
      const outputPath = join(directory, "stock.html");
      await exportModule.exportSessionToHtml(session, undefined, { outputPath, toolRenderer: renderer });
      const html = readFileSync(outputPath, "utf8");
      const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
      expect(encoded).toBeDefined();
      const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
      const canonical = JSON.stringify(data.entries);
      expect(canonical).toContain("STOCK READ HTML BODY");
      expect(canonical).toContain("STOCK WRITE HTML BODY");
      expect(data.renderedTools?.["stock-read"]).toBeUndefined();
      expect(data.renderedTools?.["stock-write"]).toBeUndefined();
      expect(html).not.toContain("lines hidden");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not arm collapse through Pi's HTML partial-call lifecycle", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    await withExpansionBindingAsync(["ctrl+o"], async () => {
      const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
      const distIndex = mainUrl.indexOf("/dist/");
      expect(distIndex).toBeGreaterThan(0);
      const module = await import(`${mainUrl.slice(0, distIndex)}/dist/core/export-html/tool-renderer.js`) as any;
      const source = {
        name: "read",
        label: "read",
        description: "HTML probe",
        parameters: {},
        execute() {},
        renderCall: () => ({ render: () => ["HTML NATIVE CALL"] }),
        renderResult: () => ({ render: () => ["HTML NATIVE RESULT"] }),
      };
      const renderer = module.createToolHtmlRenderer({
        getToolDefinition: () => withDefaultCollapsedToolRendering(source as never),
        theme: { fg: (_slot: string, text: string) => text, bold: (text: string) => text },
        cwd: process.cwd(),
      });
      expect(renderer.renderCall("html-probe", "read", { path: "html.txt" })).toContain("HTML NATIVE CALL");
      const rendered = renderer.renderResult(
        "html-probe", "read", [{ type: "text", text: "body" }], undefined, false,
      );
      expect(rendered.expanded).toContain("HTML NATIVE RESULT");
      expect(rendered.expanded).not.toContain("lines hidden");
    });
  });
});

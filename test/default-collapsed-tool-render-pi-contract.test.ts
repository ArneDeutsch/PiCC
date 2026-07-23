import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { withDefaultCollapsedToolRendering } from "../src/runtime/default-collapsed-tool-render.js";
import { withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";
import { wrapForSelfShell } from "../src/runtime/tool-shell.js";
import { waitUntil } from "./helpers/async.js";

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\].*?(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function glyphs(value: string): string[] {
  return stripAnsi(value).match(/[○●✗■]/gu) ?? [];
}

function withBinding<T>(keys: string[], run: () => T): T {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  }, { "app.tools.expand": keys as never }));
  try { return run(); } finally { setKeybindings(previous); }
}

async function withBindingAsync<T>(keys: string[], run: () => Promise<T>): Promise<T> {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  }, { "app.tools.expand": keys as never }));
  try { return await run(); } finally { setKeybindings(previous); }
}

describe("real Pi default-collapse contracts", () => {
  it("runs one native Read live-to-collapse-to-expand cycle", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withBinding(["ctrl+k"], () => {
      const args = { path: "contract.txt" };
      const row = new sdk.ToolExecutionComponent(
        "read", "read-contract", args, {},
        wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createReadToolDefinition(process.cwd()))),
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      row.setArgsComplete();
      const pending = (row.render(80) as string[]).map(stripAnsi).join("\n");
      expect(pending).toContain("contract.txt");
      expect(glyphs(pending)).toEqual(["○"]);
      row.markExecutionStarted();
      row.setExpanded(true);
      row.updateResult({ content: [{ type: "text", text: "rolling" }], details: undefined }, true);
      const partial = (row.render(80) as string[]).map(stripAnsi).join("\n");
      expect(partial).toContain("contract.txt");
      expect(partial).toContain("rolling");
      expect(partial.split("\n").find((line) => line.includes("rolling"))).toMatch(/^  /u);
      expect(partial).not.toContain("lines hidden");
      expect(glyphs(partial)).toEqual(["○"]);
      row.setExpanded(false);
      row.updateResult({ content: [{ type: "text", text: "first\nsecond" }], details: undefined }, false);
      const collapsed = (row.render(80) as string[]).map(stripAnsi).join("\n");
      expect(collapsed).toContain("read contract.txt · 2 lines hidden · ctrl+k to expand");
      expect(collapsed).not.toContain("first");
      expect(glyphs(collapsed)).toEqual(["●"]);
      row.setExpanded(true);
      const expanded = (row.render(80) as string[]).map(stripAnsi).join("\n");
      expect(expanded.match(/contract\.txt/g)).toHaveLength(1);
      expect(expanded.match(/first/g)).toHaveLength(1);
      expect(glyphs(expanded)).toEqual(["●"]);
      row.setExpanded(false);
      const recollapsed = (row.render(80) as string[]).map(stripAnsi).join("\n");
      expect(recollapsed).not.toContain("first");
      expect(glyphs(recollapsed)).toEqual(["●"]);
    });
  });

  it("freezes the invocation display root across historical redraws", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withBinding(["ctrl+o"], () => {
      const rootA = process.platform === "win32" ? "C:\\repo-a" : "/repo-a";
      const rootB = process.platform === "win32" ? "C:\\repo-b" : "/repo-b";
      const piContextRoot = process.platform === "win32" ? "C:\\pi-context" : "/pi-context";
      const joinFor = (root: string, file: string) => `${root}${root.includes("\\") ? "\\" : "/"}${file}`;
      let activeRoot = rootA;
      const resolver = vi.fn(() => activeRoot);
      const native = {
        name: "read",
        label: "read",
        description: "test",
        parameters: {},
        execute() {},
        renderCall(args: { path: string }) { return { render: () => [`native ${args.path}`] }; },
        renderResult(result: { content: Array<{ text: string }> }) {
          return { render: () => [result.content[0]?.text ?? ""] };
        },
      };
      const decorated = wrapForSelfShell(withDefaultCollapsedToolRendering(native as any, {
        resolveDisplayRoot: resolver,
      }));
      const makeRow = (id: string, root: string) => new sdk.ToolExecutionComponent(
        "read", id, { path: joinFor(root, "src/a.ts") }, {}, decorated,
        { requestRender() {} }, piContextRoot,
      );
      const first = makeRow("freeze-a", rootA);
      first.render(100);
      expect(resolver).not.toHaveBeenCalled();
      first.setArgsComplete();
      first.render(100);
      first.render(100);
      expect(resolver).toHaveBeenCalledTimes(1);
      first.markExecutionStarted();
      activeRoot = rootB;
      first.updateResult({ content: [{ type: "text", text: "body" }], details: undefined }, false);
      const historical = (first.render(100) as string[]).map(stripAnsi).join("\n");
      expect(historical).toContain(process.platform === "win32" ? "src\\a.ts" : "src/a.ts");
      expect(historical).not.toContain("repo-a");
      expect(resolver).toHaveBeenCalledTimes(1);

      const second = makeRow("freeze-b", rootB);
      second.setArgsComplete();
      second.render(100);
      expect(resolver).toHaveBeenCalledTimes(2);
      second.markExecutionStarted();
      second.updateResult({ content: [{ type: "text", text: "body" }], details: undefined }, false);
      const fresh = (second.render(100) as string[]).map(stripAnsi).join("\n");
      expect(fresh).toContain(process.platform === "win32" ? "src\\a.ts" : "src/a.ts");
      expect(fresh).not.toContain("repo-b");
      expect(resolver).toHaveBeenCalledTimes(2);
    });
  });

  it("collapses an ordinary stock Read continuation and restores its native notice", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    await withBindingAsync(["ctrl+o"], async () => {
      const directory = mkdtempSync(join(tmpdir(), "picc-read-continuation-"));
      try {
        writeFileSync(join(directory, "continued.txt"), "first\nsecond\nthird\n");
        const args = { path: "continued.txt", limit: 1 };
        const native = sdk.createReadToolDefinition(directory);
        const result = await native.execute("read-continuation", args);
        const row = new sdk.ToolExecutionComponent(
          "read", "read-continuation", args, {},
          wrapForSelfShell(withDefaultCollapsedToolRendering(native)),
          { requestRender() {} }, directory.replace(/\\/g, "/"),
        );
        row.setArgsComplete();
        row.markExecutionStarted();
        row.render(100);
        row.updateResult(result, false);
        const settled = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(settled).toContain("read continued.txt:1-1");
        expect(settled).toContain("3 more lines");
        expect(settled).toContain("next offset 2");
        expect(glyphs(settled)).toEqual(["●"]);
        row.setExpanded(true);
        const expanded = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(expanded).toContain("3 more lines in file");
        expect(expanded).toContain("offset=2 to continue");
        row.setExpanded(false);
        expect((row.render(100) as string[]).map(stripAnsi).join("\n")).toBe(settled);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("retains Edit preview-failure evidence and native reconstructed mutation detail", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    await withBindingAsync(["ctrl+o"], async () => {
      const directory = mkdtempSync(join(tmpdir(), "picc-edit-preview-"));
      try {
        const args = { path: "missing.txt", edits: [{ oldText: "OLD_STORED", newText: "NEW_STORED" }] };
        const row = new sdk.ToolExecutionComponent(
          "edit", "edit-contract", args, {},
          wrapForSelfShell(withDefaultCollapsedToolRendering(
            withRoutineToolRendering(sdk.createEditToolDefinition(directory), {
              resolveEditRenderCwd: () => directory,
            }),
          )),
          { requestRender() {} }, directory.replace(/\\/g, "/"),
        );
        row.setArgsComplete();
        row.render(100);
        const renderedPreview = () => (row.render(100) as string[]).map(stripAnsi).join("\n");
        await waitUntil({
          description: "the native missing-file Edit preview to settle",
          predicate: () => /ENOENT|no such file|could not/iu.test(renderedPreview()),
          describeObserved: renderedPreview,
          timeoutMs: 15_000,
        });
        row.updateResult({
          content: [{ type: "text", text: "Successfully replaced 1 block(s) in missing.txt." }],
          details: { diff: "-1 OLD_STORED\n+1 NEW_STORED", patch: "stored", firstChangedLine: 1 },
        }, false);
        const settled = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(settled).toContain("Edit preview failed:");
        expect(settled).toContain("OLD_STORED");
        expect(settled).toContain("NEW_STORED");
        expect(settled).not.toContain("diff lines hidden");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("lets stock Bash finalize duration and timer state before hiding secrets", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withBinding(["ctrl+o"], () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(10_000);
        const row = new sdk.ToolExecutionComponent(
          "bash", "bash-contract", { command: "TOKEN=command-secret printf command-output" }, {},
          wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createBashToolDefinition(process.cwd()))),
          { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
        );
        row.setArgsComplete();
        row.markExecutionStarted();
        const pending = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(glyphs(pending)).toEqual(["○"]);
        row.updateResult({ content: [{ type: "text", text: "rolling-output" }], details: undefined }, true);
        const partial = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(partial).toContain("rolling-output");
        expect(partial.split("\n").find((line) => line.includes("rolling-output"))).toMatch(/^  /u);
        expect(glyphs(partial)).toEqual(["○"]);
        expect(vi.getTimerCount()).toBe(1);
        vi.setSystemTime(11_250);
        row.updateResult({ content: [{ type: "text", text: "output-secret" }], details: undefined }, false);
        const collapsed = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(collapsed).toContain("bash TOKEN=command-secret printf command-output · 1 output line hidden · 1.3s · ctrl+o to expand");
        expect(collapsed).toContain("command-secret");
        expect(collapsed).not.toContain("output-secret");
        expect(glyphs(collapsed)).toEqual(["●"]);
        expect(vi.getTimerCount()).toBe(0);
        row.setExpanded(true);
        const expanded = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(expanded).toContain("command-secret");
        expect(expanded).toContain("output-secret");
        expect(glyphs(expanded)).toEqual(["●"]);
        row.setExpanded(false);
        expect(glyphs((row.render(100) as string[]).join("\n"))).toEqual(["●"]);
      } finally { vi.useRealTimers(); }
    });
  });

  it("leaves Edit HTML and reconstructed history on their supplied cwd", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const directory = mkdtempSync(join(tmpdir(), "picc-edit-nonlive-"));
    try {
      writeFileSync(join(directory, "html-edit.txt"), "before\n");
      const resolver = vi.fn(() => { throw new Error("live resolver must not run"); });
      const htmlCallContexts: any[] = [];
      const htmlResultContexts: any[] = [];
      const htmlDefinition = withRoutineToolRendering({
        name: "edit",
        renderCall(_args: unknown, _theme: unknown, context: any) {
          htmlCallContexts.push(context);
          return { render: () => [`HTML_CALL_CWD=${context.cwd}`] };
        },
        renderResult(_result: unknown, options: any, _theme: unknown, context: any) {
          htmlResultContexts.push(context);
          return { render: () => [`HTML_RESULT_${options.expanded ? "EXPANDED" : "COLLAPSED"}_CWD=${context.cwd}`] };
        },
      } as any, { resolveEditRenderCwd: resolver });
      const historyDefinition = withRoutineToolRendering(sdk.createEditToolDefinition(directory), {
        resolveEditRenderCwd: resolver,
      });
      const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
      const distIndex = mainUrl.indexOf("/dist/");
      const html = await import(`${mainUrl.slice(0, distIndex)}/dist/core/export-html/tool-renderer.js`) as any;
      const renderer = html.createToolHtmlRenderer({
        getToolDefinition: (name: string) => name === "edit" ? htmlDefinition : undefined,
        theme: { fg: (_slot: string, text: string) => text, bold: (text: string) => text,
          bg: (_slot: string, text: string) => text },
        cwd: directory,
      });
      expect(renderer.renderCall("html-edit", "edit", {
        path: "html-edit.txt", edits: [{ oldText: "before", newText: "after" }],
      })).toContain(`HTML_CALL_CWD=${directory}`);
      const htmlResult = renderer.renderResult(
        "html-edit", "edit", [{ type: "text", text: "html settled" }],
        { diff: "-before\n+after", firstChangedLine: 1 }, false,
      );
      expect(htmlResult.collapsed).toContain(`HTML_RESULT_COLLAPSED_CWD=${directory}`);
      expect(htmlResult.expanded).toContain(`HTML_RESULT_EXPANDED_CWD=${directory}`);
      expect(htmlCallContexts).toHaveLength(1);
      expect(htmlResultContexts).toHaveLength(2);
      expect([...htmlCallContexts, ...htmlResultContexts].every(({ cwd }) => cwd === directory)).toBe(true);
      expect(htmlResultContexts.every(({ state }) => state === htmlCallContexts[0].state)).toBe(true);
      expect(resolver).not.toHaveBeenCalled();

      const historyArgs = {
        path: "history-edit.txt", edits: [{ oldText: "HISTORY_OLD", newText: "HISTORY_NEW" }],
      };
      const row = new sdk.ToolExecutionComponent(
        "edit", "history-edit", historyArgs, {}, historyDefinition,
        { requestRender() {} }, directory.replace(/\\/g, "/"),
      );
      row.updateResult({
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in history-edit.txt." }],
        details: { diff: "-HISTORY_OLD\n+HISTORY_NEW", patch: "stored", firstChangedLine: 1 },
      }, false);
      const reconstructed = (row.render(100) as string[]).map(stripAnsi).join("\n");
      expect(reconstructed).toContain("HISTORY_OLD");
      expect(reconstructed).toContain("HISTORY_NEW");
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps error fail-open detail and malformed warnings behind one marker", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withBinding(["ctrl+o"], () => {
      const error = new sdk.ToolExecutionComponent(
        "read", "read-error", { path: "broken.txt" }, {},
        wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createReadToolDefinition(process.cwd()))),
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      error.updateResult({ content: [{ type: "text", text: "read failed visibly" }], details: undefined, isError: true }, false);
      const errorText = (error.render(80) as string[]).map(stripAnsi).join("\n");
      expect(errorText).toContain("read failed visibly");
      expect(glyphs(errorText)).toEqual(["✗"]);

      const malformed = new sdk.ToolExecutionComponent(
        "read", "read-malformed", { path: 42 }, {},
        wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createReadToolDefinition(process.cwd()))),
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      malformed.updateResult({ content: [{ type: "text", text: "ignored" }], details: undefined }, false);
      const malformedText = (malformed.render(80) as string[]).map(stripAnsi).join("\n");
      expect(malformedText).toContain("Unfamiliar arguments");
      expect(malformedText.match(/Unfamiliar arguments/gu)?.length).toBeLessThanOrEqual(2);
      expect(glyphs(malformedText)).toEqual(["●"]);
    });
  });

  it("leaves stock Read and custom MultiEdit HTML routes on native detail", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    await withBindingAsync(["ctrl+o"], async () => {
      const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
      const distIndex = mainUrl.indexOf("/dist/");
      const html = await import(`${mainUrl.slice(0, distIndex)}/dist/core/export-html/tool-renderer.js`) as any;
      const definitions = new Map<string, unknown>([
        ["read", withDefaultCollapsedToolRendering(sdk.createReadToolDefinition(process.cwd()))],
        ["MultiEdit", withDefaultCollapsedToolRendering(withRoutineToolRendering({
          name: "MultiEdit", label: "MultiEdit", description: "test", parameters: {}, execute() {},
        } as any))],
      ]);
      const renderer = html.createToolHtmlRenderer({
        getToolDefinition: (name: string) => definitions.get(name),
        theme: { fg: (_slot: string, text: string) => text, bold: (text: string) => text },
        cwd: process.cwd(),
      });

      expect(renderer.renderCall("html-read", "read", { path: "html.txt" })).toContain("html.txt");
      const read = renderer.renderResult("html-read", "read", [{ type: "text", text: "HTML NATIVE BODY" }], undefined, false);
      expect(read.expanded).toContain("HTML NATIVE BODY");
      expect(read.expanded).not.toContain("lines hidden");

      const multiArgs = { file_path: "html.ts", edits: [{ old_string: "before", new_string: "after" }] };
      renderer.renderCall("html-multi", "MultiEdit", multiArgs);
      const multi = renderer.renderResult("html-multi", "MultiEdit", [{
        type: "text", text: "Successfully applied 1 edit(s) to html.ts.",
      }], { filePath: "html.ts", edits: 1, created: false, diff: "-before\n+after", firstChangedLine: 1 }, false);
      expect(multi.expanded).toContain("before");
      expect(multi.expanded).toContain("after");
      expect(multi.expanded).not.toContain("diff lines hidden");
    });
  });
});

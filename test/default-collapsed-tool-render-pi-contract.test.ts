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

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\].*?(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
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
      expect((row.render(80) as string[]).map(stripAnsi).join("\n")).toContain("contract.txt");
      row.markExecutionStarted();
      row.updateResult({ content: [{ type: "text", text: "rolling" }], details: undefined }, true);
      const partial = (row.render(80) as string[]).map(stripAnsi).join("\n");
      expect(partial).toContain("contract.txt");
      expect(partial).not.toContain("lines hidden");
      row.updateResult({ content: [{ type: "text", text: "first\nsecond" }], details: undefined }, false);
      const collapsed = (row.render(80) as string[]).map(stripAnsi).join("\n");
      expect(collapsed).toContain("Read contract.txt · 2 lines hidden · ctrl+k to expand");
      expect(collapsed).not.toContain("first");
      row.setExpanded(true);
      const expanded = (row.render(80) as string[]).map(stripAnsi).join("\n");
      expect(expanded.match(/contract\.txt/g)).toHaveLength(1);
      expect(expanded.match(/first/g)).toHaveLength(1);
      row.setExpanded(false);
      expect((row.render(80) as string[]).map(stripAnsi).join("\n")).not.toContain("first");
    });
  });

  it("shows stock Read continuation evidence for a nonordinary settled result", async () => {
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
        expect(settled).toContain("3 more lines in file");
        expect(settled).toContain("offset=2 to continue");
        expect(settled).not.toContain("lines hidden");
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
            withRoutineToolRendering(sdk.createEditToolDefinition(directory)),
          )),
          { requestRender() {} }, directory.replace(/\\/g, "/"),
        );
        row.setArgsComplete();
        row.render(100);
        await vi.waitFor(() => expect((row.render(100) as string[]).map(stripAnsi).join("\n"))
          .toMatch(/ENOENT|no such file|could not/iu));
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
          "bash", "bash-contract", { command: "TOKEN=command-secret printf output-secret" }, {},
          wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createBashToolDefinition(process.cwd()))),
          { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
        );
        row.setArgsComplete();
        row.markExecutionStarted();
        row.render(100);
        row.updateResult({ content: [{ type: "text", text: "rolling-output" }], details: undefined }, true);
        row.render(100);
        expect(vi.getTimerCount()).toBe(1);
        vi.setSystemTime(11_250);
        row.updateResult({ content: [{ type: "text", text: "output-secret" }], details: undefined }, false);
        const collapsed = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(collapsed).toContain("Bash · 1 output line hidden · ctrl+o to expand · 1.3s");
        expect(collapsed).not.toContain("command-secret");
        expect(collapsed).not.toContain("output-secret");
        expect(vi.getTimerCount()).toBe(0);
        row.setExpanded(true);
        const expanded = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(expanded).toContain("command-secret");
        expect(expanded).toContain("output-secret");
      } finally { vi.useRealTimers(); }
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

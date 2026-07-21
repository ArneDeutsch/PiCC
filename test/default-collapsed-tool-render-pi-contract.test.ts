import { describe, expect, it, vi } from "vitest";
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
import { withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";
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

  it("preserves stock Edit preview invalidation and collapses only after result-driven settlement", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    await withExpansionBindingAsync(["ctrl+k"], async () => {
      const directory = mkdtempSync(join(tmpdir(), "picc-collapsed-edit-"));
      const args = { path: "target.txt", edits: [{ oldText: "BEFORE_EDIT", newText: "AFTER_EDIT" }] };
      let invalidations = 0;
      try {
        await import("node:fs/promises").then(({ writeFile }) => writeFile(join(directory, args.path), "BEFORE_EDIT\n"));
        const source = sdk.createEditToolDefinition(directory);
        const decorated = wrapForSelfShell(withDefaultCollapsedToolRendering(withRoutineToolRendering(source)));
        const component = new sdk.ToolExecutionComponent(
          "edit", "collapsed-edit-contract", args, {}, decorated,
          { requestRender() { invalidations++; } }, directory.replace(/\\/g, "/"),
        );
        component.setArgsComplete();
        component.render(100);
        await vi.waitFor(() => expect(invalidations).toBeGreaterThanOrEqual(2));
        const preview = (component.render(100) as string[]).map(stripAnsi).join("\n");
        expect(preview).toContain("BEFORE_EDIT");
        expect(preview).toContain("AFTER_EDIT");
        expect(preview).not.toContain("diff lines hidden");

        const result = await source.execute("collapsed-edit-contract", args, undefined, undefined, {});
        component.updateResult(result, false);
        const collapsed = (component.render(100) as string[]).map(stripAnsi);
        expect(collapsed).toHaveLength(2);
        expect(collapsed.join("\n")).toContain("Edit target.txt · 1 edit applied · 2 diff lines hidden · ctrl+k to expand");
        expect(collapsed.join("\n")).not.toContain("BEFORE_EDIT");
        expect(collapsed.join("\n")).not.toContain("AFTER_EDIT");

        component.setExpanded(true);
        const expanded = (component.render(100) as string[]).map(stripAnsi).join("\n");
        expect(expanded.match(/BEFORE_EDIT/g)).toHaveLength(1);
        expect(expanded.match(/AFTER_EDIT/g)).toHaveLength(1);
        component.setExpanded(false);
        expect((component.render(100) as string[]).map(stripAnsi).join("\n")).toContain("diff lines hidden");
        component.setExpanded(true);
        const reexpanded = (component.render(100) as string[]).map(stripAnsi).join("\n");
        expect(reexpanded.match(/BEFORE_EDIT/g)).toHaveLength(1);
        expect(reexpanded.match(/AFTER_EDIT/g)).toHaveLength(1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("keeps Edit preview-failure evidence when a reconstructed stored success settles", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    await withExpansionBindingAsync(["ctrl+o"], async () => {
      const directory = mkdtempSync(join(tmpdir(), "picc-collapsed-edit-failed-preview-"));
      const args = { path: "missing.txt", edits: [{ oldText: "OLD_STORED", newText: "NEW_STORED" }] };
      let invalidations = 0;
      try {
        const source = sdk.createEditToolDefinition(directory);
        const decorated = wrapForSelfShell(withDefaultCollapsedToolRendering(withRoutineToolRendering(source)));
        const component = new sdk.ToolExecutionComponent(
          "edit", "stored-edit-contract", args, {}, decorated,
          { requestRender() { invalidations++; } }, directory.replace(/\\/g, "/"),
        );
        component.setArgsComplete();
        component.render(100);
        await vi.waitFor(() => {
          const failedPreview = (component.render(100) as string[]).map(stripAnsi).join("\n");
          expect(failedPreview).toMatch(/ENOENT|no such file|could not/iu);
        });
        expect(invalidations).toBeGreaterThan(0);

        component.updateResult({
          content: [{ type: "text", text: "Successfully replaced 1 block(s) in missing.txt." }],
          details: { diff: "-1 OLD_STORED\n+1 NEW_STORED", patch: "stored patch", firstChangedLine: 1 },
        }, false);
        const settled = (component.render(100) as string[]).map(stripAnsi).join("\n");
        expect(settled).toContain("Edit preview failed:");
        expect(settled).toContain("settled result elabo");
        expect(settled.match(/OLD_STORED/g)).toHaveLength(1);
        expect(settled.match(/NEW_STORED/g)).toHaveLength(1);
        expect(settled).not.toContain("diff lines hidden");
        expect(settled).not.toContain("no net change");
        component.setExpanded(true);
        const expanded = (component.render(100) as string[]).map(stripAnsi).join("\n");
        expect(expanded).toContain("Edit preview failed:");
        expect(expanded.match(/OLD_STORED/g)).toHaveLength(1);
        expect(expanded.match(/NEW_STORED/g)).toHaveLength(1);
        component.setExpanded(false);
        expect((component.render(100) as string[]).map(stripAnsi).join("\n")).toContain("Edit preview failed:");
        component.setExpanded(true);
        expect((component.render(100) as string[]).map(stripAnsi).join("\n").match(/NEW_STORED/g)).toHaveLength(1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });

  it("collapses MultiEdit from its detached Pi Edit DTO and expands one delegated diff", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withExpansionBinding(["ctrl+o"], () => {
      const args = {
        file_path: "src/multi-contract.ts",
        edits: [{ old_string: "OLD_MULTI", new_string: "NEW_MULTI" }],
      };
      const result = {
        content: [{ type: "text", text: "Successfully applied 1 edit(s) to src/multi-contract.ts." }],
        details: {
          filePath: "src/multi-contract.ts", edits: 1, created: false,
          diff: "-1 OLD_MULTI\n+1 NEW_MULTI", firstChangedLine: 1,
        },
      };
      const decorated = wrapForSelfShell(withDefaultCollapsedToolRendering(
        withRoutineToolRendering({ name: "MultiEdit" } as never),
      ));
      const component = new sdk.ToolExecutionComponent(
        "MultiEdit", "collapsed-multiedit-contract", args, {}, decorated,
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      component.setArgsComplete();
      component.updateResult(result, false);
      const collapsed = (component.render(100) as string[]).map(stripAnsi);
      expect(collapsed).toHaveLength(2);
      expect(collapsed.join("\n")).toContain("MultiEdit src/multi-contract.ts · 1 edit applied · 2 diff lines hidden");
      expect(collapsed.join("\n")).not.toContain("OLD_MULTI");
      expect(collapsed.join("\n")).not.toContain("NEW_MULTI");

      component.setExpanded(true);
      const expanded = (component.render(100) as string[]).map(stripAnsi).join("\n");
      expect(expanded.match(/OLD_MULTI/g)).toHaveLength(1);
      expect(expanded.match(/NEW_MULTI/g)).toHaveLength(1);
      expect(expanded.match(/src\/multi-contract\.ts/g)).toHaveLength(1);
      component.setExpanded(false);
      const recollapsed = (component.render(100) as string[]).map(stripAnsi).join("\n");
      expect(recollapsed).toContain("diff lines hidden");
      expect(recollapsed).not.toContain("OLD_MULTI");
      component.setExpanded(true);
      const reexpanded = (component.render(100) as string[]).map(stripAnsi).join("\n");
      expect(reexpanded.match(/OLD_MULTI/g)).toHaveLength(1);
      expect(reexpanded.match(/NEW_MULTI/g)).toHaveLength(1);
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

  it("keeps two stock Bash rows independent through repeated partials, settlement, expansion, and error", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    await withExpansionBindingAsync(["ctrl+k"], async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(10_000);
        const make = (id: string, command: string) => new sdk.ToolExecutionComponent(
          "bash", id, { command }, {},
          wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createBashToolDefinition(process.cwd()))),
          { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
        );
        const first = make("bash-contract-a", "TOKEN=A-command-secret printf A-output-secret");
        const second = make("bash-contract-b", "TOKEN=B-command-secret printf B-output-secret");
        const firstState = first.rendererState as Record<string, unknown>;
        const secondState = second.rendererState as Record<string, unknown>;

        for (const row of [first, second]) {
          row.setArgsComplete();
          row.markExecutionStarted();
          row.render(100);
        }
        first.updateResult({ content: [{ type: "text", text: "A-rolling-one" }], details: undefined }, true);
        first.render(100);
        const firstNative = (first.resultRendererComponent as { __inner?: unknown }).__inner;
        first.updateResult({ content: [{ type: "text", text: "A-rolling-two" }], details: undefined }, true);
        expect((first.render(100) as string[]).map(stripAnsi).join("\n")).toContain("A-rolling-two");
        expect((first.resultRendererComponent as { __inner?: unknown }).__inner).toBe(firstNative);

        second.updateResult({ content: [{ type: "text", text: "B-rolling-one" }], details: undefined }, true);
        second.render(100);
        const secondNative = (second.resultRendererComponent as { __inner?: unknown }).__inner;
        second.updateResult({ content: [{ type: "text", text: "B-rolling-two" }], details: undefined }, true);
        expect((second.render(100) as string[]).map(stripAnsi).join("\n")).toContain("B-rolling-two");
        expect((second.resultRendererComponent as { __inner?: unknown }).__inner).toBe(secondNative);
        expect(vi.getTimerCount()).toBe(2);

        vi.setSystemTime(11_250);
        first.updateResult({ content: [{ type: "text", text: "A-output-secret\nA-second" }], details: undefined }, false);
        const collapsed = (first.render(100) as string[]).map(stripAnsi).join("\n");
        expect(collapsed).toContain("Bash · 2 output lines hidden · ctrl+k to expand · 1.3s · 1 command line hidden");
        expect(collapsed).not.toContain("A-command-secret");
        expect(collapsed).not.toContain("A-output-secret");
        expect(firstState.endedAt).toBe(11_250);
        expect(secondState.endedAt).toBeUndefined();
        expect(vi.getTimerCount()).toBe(1);

        first.setExpanded(true);
        const expanded = (first.render(100) as string[]).map(stripAnsi).join("\n");
        expect(expanded).toContain("A-command-secret");
        expect(expanded).toContain("A-output-secret");
        expect(expanded).toContain("Took 1.3s");
        expect((second.render(100) as string[]).map(stripAnsi).join("\n")).toContain("B-rolling-two");
        expect(vi.getTimerCount()).toBe(1);
        first.setExpanded(false);

        vi.setSystemTime(13_000);
        second.updateResult({ content: [{ type: "text", text: "Command timed out after B-error-sentinel" }], details: undefined, isError: true }, false);
        const error = (second.render(100) as string[]).map(stripAnsi).join("\n");
        expect(error).toContain("B-error-sentinel");
        expect(error).toContain("Took 3.0s");
        expect(error).not.toContain("output lines hidden");
        expect(secondState.endedAt).toBe(13_000);
        expect(firstState.endedAt).toBe(11_250);
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });
  });

  it("keeps a final unbound stock Bash command and output native without arming a timer", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withExpansionBinding([], () => {
      vi.useFakeTimers();
      try {
        const component = new sdk.ToolExecutionComponent(
          "bash", "bash-unbound", { command: "printf unbound-command-sentinel" }, {},
          wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createBashToolDefinition(process.cwd()))),
          { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
        );
        component.updateResult({ content: [{ type: "text", text: "unbound-output-sentinel" }], details: undefined }, false);
        const rendered = (component.render(100) as string[]).map(stripAnsi).join("\n");
        expect(rendered).toContain("unbound-command-sentinel");
        expect(rendered).toContain("unbound-output-sentinel");
        expect(rendered).not.toContain("hidden");
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    });
  });

  it("keeps complete stock Read, Write, Edit, and Bash HTML exports on Pi's unchanged native path", async () => {
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
      ["edit", withDefaultCollapsedToolRendering(withRoutineToolRendering(sdk.createEditToolDefinition(process.cwd())))],
      ["bash", withDefaultCollapsedToolRendering(sdk.createBashToolDefinition(process.cwd()))],
    ]);
    const nativeDefinitions = new Map([
      ["read", sdk.createReadToolDefinition(process.cwd())],
      ["write", sdk.createWriteToolDefinition(process.cwd())],
      ["edit", sdk.createEditToolDefinition(process.cwd())],
      ["bash", sdk.createBashToolDefinition(process.cwd())],
    ]);
    const makeRenderer = (source: Map<string, unknown>) => htmlModule.createToolHtmlRenderer({
      getToolDefinition: (name: string) => source.get(name), theme: themeModule.theme, cwd: process.cwd(),
    });
    const renderer = makeRenderer(definitions);
    const directory = mkdtempSync(join(tmpdir(), "picc-file-export-"));
    try {
      const session = sdk.SessionManager.create(directory, directory, { id: "stock-file-export" });
      for (const entry of [
        { id: "stock-read", name: "read", args: { path: "stock.txt" }, text: "STOCK READ HTML BODY", details: undefined },
        { id: "stock-write", name: "write", args: { path: "stock-write.txt", content: "STOCK WRITE HTML BODY" }, text: "Successfully wrote 21 bytes to stock-write.txt", details: undefined },
        { id: "stock-edit", name: "edit", args: { path: "stock-edit.txt", edits: [{ oldText: "OLD", newText: "NEW" }] }, text: "Successfully replaced 1 block(s) in stock-edit.txt.", details: { diff: "-1 OLD\n+1 NEW", patch: "patch", firstChangedLine: 1 } },
        { id: "stock-bash", name: "bash", args: { command: "printf STOCK_BASH_HTML_BODY" }, text: "STOCK_BASH_HTML_BODY", details: undefined },
      ]) {
        session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: entry.id, name: entry.name, arguments: entry.args }], stopReason: "toolUse" } as never);
        session.appendMessage({ role: "toolResult", toolCallId: entry.id, toolName: entry.name,
          content: [{ type: "text", text: entry.text }], details: entry.details, isError: false } as never);
      }
      const outputPath = join(directory, "stock.html");
      const nativeOutputPath = join(directory, "stock-native.html");
      await exportModule.exportSessionToHtml(session, undefined, { outputPath, toolRenderer: renderer });
      await exportModule.exportSessionToHtml(session, undefined, {
        outputPath: nativeOutputPath, toolRenderer: makeRenderer(nativeDefinitions),
      });
      const html = readFileSync(outputPath, "utf8");
      const nativeHtml = readFileSync(nativeOutputPath, "utf8");
      const decode = (source: string) => {
        const encoded = source.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
        expect(encoded).toBeDefined();
        return JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
      };
      const data = decode(html);
      const nativeData = decode(nativeHtml);
      expect(data.entries).toEqual(nativeData.entries);
      expect(data.renderedTools).toEqual(nativeData.renderedTools);
      const canonical = JSON.stringify(data.entries);
      expect(canonical).toContain("STOCK READ HTML BODY");
      expect(canonical).toContain("STOCK WRITE HTML BODY");
      expect(canonical).toContain("stock-edit.txt");
      expect(canonical).toContain("-1 OLD\\n+1 NEW");
      expect(canonical).toContain("STOCK_BASH_HTML_BODY");
      expect(data.renderedTools?.["stock-read"]).toBeUndefined();
      expect(data.renderedTools?.["stock-write"]).toBeUndefined();
      expect(data.renderedTools?.["stock-edit"]).toBeUndefined();
      expect(data.renderedTools?.["stock-bash"]).toBeUndefined();
      expect(html).not.toContain("lines hidden");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps custom MultiEdit HTML byte-equivalent because export never establishes the settled-call marker", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    await withExpansionBindingAsync(["ctrl+o"], async () => {
      const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
      const piDist = mainUrl.slice(0, mainUrl.indexOf("/dist/"));
      const htmlModule = await import(`${piDist}/dist/core/export-html/tool-renderer.js`) as any;
      const themeModule = await import(`${piDist}/dist/modes/interactive/theme/theme.js`) as any;
      const routine = withRoutineToolRendering({ name: "MultiEdit" } as never);
      const make = (definition: unknown) => htmlModule.createToolHtmlRenderer({
        getToolDefinition: (name: string) => name === "MultiEdit" ? definition : undefined,
        theme: themeModule.theme, cwd: process.cwd(), width: 80,
      });
      const nativeRenderer = make(routine);
      const decoratedRenderer = make(withDefaultCollapsedToolRendering(routine));
      const args = { file_path: "src/html-marker.ts", edits: [{ old_string: "OLD_HTML", new_string: "NEW_HTML" }] };
      const content = [{ type: "text", text: "Successfully applied 1 edit(s) to src/html-marker.ts." }];
      const details = { filePath: "src/html-marker.ts", edits: 1, created: false,
        diff: "-1 OLD_HTML\n+1 NEW_HTML", firstChangedLine: 1 };
      for (const renderer of [nativeRenderer, decoratedRenderer]) renderer.renderCall("html-marker", "MultiEdit", args);
      const native = nativeRenderer.renderResult("html-marker", "MultiEdit", content, details, false);
      const decorated = decoratedRenderer.renderResult("html-marker", "MultiEdit", content, details, false);
      expect(decorated).toEqual(native);
      expect(decorated?.expanded).toContain("OLD_HTML");
      expect(decorated?.expanded).not.toContain("diff lines hidden");
    });
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

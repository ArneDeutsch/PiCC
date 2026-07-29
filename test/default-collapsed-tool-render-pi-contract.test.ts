import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piTui = await import(pathToFileURL(requireFromPi.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\].*?(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function glyphs(value: string): string[] {
  return stripAnsi(value).match(/[○●✗■]/gu) ?? [];
}

function installBinding(keys: string[]): () => void {
  const previousRoot = getKeybindings();
  const previousPi = piTui.getKeybindings();
  const definitions = {
    ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o" as const, description: "Toggle tool output" },
  };
  setKeybindings(new KeybindingsManager(definitions, { "app.tools.expand": ["root-only"] as never }));
  piTui.setKeybindings(new piTui.KeybindingsManager(definitions, { "app.tools.expand": keys as never }));
  return () => {
    piTui.setKeybindings(previousPi);
    setKeybindings(previousRoot);
  };
}

function withBinding<T>(keys: string[], run: () => T): T {
  const restore = installBinding(keys);
  try { return run(); } finally { restore(); }
}

async function withBindingAsync<T>(keys: string[], run: () => Promise<T>): Promise<T> {
  const restore = installBinding(keys);
  try { return await run(); } finally { restore(); }
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
      expect(collapsed).toContain("read contract.txt");
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

  it("renders incremental Read/Bash arguments and honors mismatched expansion fields", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withBinding(["ctrl+o"], () => {
      for (const [name, partialArgs, finalArgs, expected] of [
        ["read", { path: "part" }, { path: "partial.txt" }, "read partial.txt"],
        ["bash", { command: "echo par" }, { command: "echo partial" }, "bash $ echo partial"],
      ] as const) {
        const native = name === "read"
          ? sdk.createReadToolDefinition(process.cwd())
          : sdk.createBashToolDefinition(process.cwd());
        const decorated = wrapForSelfShell(withDefaultCollapsedToolRendering(native));
        const row = new sdk.ToolExecutionComponent(name, `${name}-incremental`, {}, {}, decorated,
          { requestRender() {} }, process.cwd().replace(/\\/g, "/"));
        expect((row.render(100) as string[]).map(stripAnsi).join("\n")).toContain(`${name}${name === "bash" ? " $" : ""} ...`);
        row.updateArgs(partialArgs);
        expect((row.render(100) as string[]).map(stripAnsi).join("\n")).not.toContain("undefined");
        row.updateArgs(finalArgs);
        row.setArgsComplete();
        row.markExecutionStarted();
        row.updateResult({ content: [{ type: "text", text: "retained" }], details: undefined }, false);
        expect((row.render(100) as string[]).map(stripAnsi).join("\n")).toContain(expected);

        const definition = decorated as any;
        for (const [optionExpanded, contextExpanded] of [[true, false], [false, true]] as const) {
          const context = { args: finalArgs, state: {}, isPartial: false, isError: false, expanded: contextExpanded,
            argsComplete: true, executionStarted: true, cwd: process.cwd(), showImages: false, invalidate() {} };
          const realTheme = { fg: (_slot: string, text: string) => text, bold: (text: string) => text,
            bg: (_slot: string, text: string) => text };
          const call = definition.renderCall(finalArgs, realTheme, context);
          const callIdentity = call;
          const detail = definition.renderResult({ content: [{ type: "text", text: "MISMATCH VISIBLE" }], details: undefined },
            { expanded: optionExpanded, isPartial: false }, realTheme, context);
          const composed = [...call.render(100), ...detail.render(100)].map(stripAnsi).join("\n");
          expect(call).toBe(callIdentity);
          expect(composed.match(/MISMATCH VISIBLE/gu)).toHaveLength(1);
          expect(composed).toContain(name === "read" ? "partial.txt" : "echo partial");
          const collapsedContext = { ...context, expanded: false };
          definition.renderCall(finalArgs, realTheme, collapsedContext);
          const collapsedDetail = definition.renderResult(
            { content: [{ type: "text", text: "MISMATCH VISIBLE" }], details: undefined },
            { expanded: false, isPartial: false }, realTheme, collapsedContext,
          );
          expect([...call.render(100), ...collapsedDetail.render(100)].map(stripAnsi).join("\n"))
            .not.toContain("MISMATCH VISIBLE");
        }
      }
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
        expect(settled).toContain("3 more lines · ctrl+o to expand");
        expect(settled).not.toContain("next offset");
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

  it("collapses a real stock byte-limited Read result and restores its native recovery notice", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    await withBindingAsync(["alt+e"], async () => {
      const directory = mkdtempSync(join(tmpdir(), "picc-read-byte-limit-"));
      try {
        const bytes = Buffer.from(Array.from({ length: 120 }, (_, index) =>
          `${String(index + 1).padStart(3, "0")}:${"x".repeat(500)}\n`).join(""), "utf8");
        expect(bytes.byteLength).toBeGreaterThan(sdk.DEFAULT_MAX_BYTES);
        writeFileSync(join(directory, "byte-limited.txt"), bytes);
        const args = { path: "byte-limited.txt", offset: 7 };
        const native = sdk.createReadToolDefinition(directory);
        const result = await native.execute("read-byte-limit", args);
        const truncation = result.details?.truncation;
        expect(truncation).toMatchObject({
          truncated: true, truncatedBy: "bytes", maxBytes: sdk.DEFAULT_MAX_BYTES,
          maxLines: sdk.DEFAULT_MAX_LINES, lastLinePartial: false, firstLineExceedsLimit: false,
        });
        expect(truncation.outputBytes).toBe(Buffer.byteLength(truncation.content, "utf8"));
        const totalFileLines = bytes.toString("utf8").split("\n").length;
        const displayedEnd = args.offset + truncation.outputLines - 1;
        const remainder = totalFileLines - displayedEnd;
        expect(remainder).toBeGreaterThan(0);

        const row = new sdk.ToolExecutionComponent(
          "read", "read-byte-limit", args, {},
          wrapForSelfShell(withDefaultCollapsedToolRendering(native)),
          { requestRender() {} }, directory.replace(/\\/g, "/"),
        );
        row.setArgsComplete();
        row.markExecutionStarted();
        row.render(120);
        row.updateResult(result, false);
        const collapsed = (row.render(120) as string[]).map(stripAnsi).join("\n");
        expect(collapsed).toContain(`read byte-limited.txt:${args.offset}`);
        expect(collapsed).toContain(`${remainder} more lines · alt+e to expand`);
        expect(collapsed).not.toContain("Showing lines");
        expect(glyphs(collapsed)).toEqual(["●"]);

        row.setExpanded(true);
        const expanded = (row.render(120) as string[]).map(stripAnsi).join("\n");
        expect(expanded).toContain(`Showing lines ${args.offset}-${displayedEnd} of ${totalFileLines}`);
        expect(expanded).toContain(`offset=${displayedEnd + 1} to continue`);
        row.setExpanded(false);
        expect((row.render(120) as string[]).map(stripAnsi).join("\n")).toBe(collapsed);
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
        expect(partial).not.toContain("rolling-output");
        expect(partial).toContain("bash $ TOKEN=command-secret printf command-output");
        expect(glyphs(partial)).toEqual(["○"]);
        expect(vi.getTimerCount()).toBe(1);
        vi.setSystemTime(11_250);
        row.updateResult({ content: [{ type: "text", text: "output-secret" }], details: undefined }, false);
        const collapsed = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(collapsed).toContain("bash $ TOKEN=command-secret printf command-output");
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

  it("keeps exact stock Bash truncation and recovery detail behind the configured expansion", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withBinding(["alt+e"], () => {
      const row = new sdk.ToolExecutionComponent(
        "bash", "bash-truncated", { command: "printf retained", timeout: 4 }, {},
        wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createBashToolDefinition(process.cwd()))),
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      row.setArgsComplete();
      row.markExecutionStarted();
      row.render(100);
      const body = "TRUNCATED BODY SECRET";
      const fullOutputPath = "/private/recovery/bash-output.txt";
      row.updateResult({ content: [{ type: "text", text: body }], details: {
        truncation: {
          content: body, truncated: true, truncatedBy: "bytes", totalLines: 100, totalBytes: 100_000,
          outputLines: 20, outputBytes: 50_000, lastLinePartial: false, firstLineExceedsLimit: false,
          maxLines: 2_000, maxBytes: 50_000,
        },
        fullOutputPath,
      } }, false);
      const collapsed = (row.render(100) as string[]).map(stripAnsi).join("\n");
      expect(collapsed).toContain("bash $ printf retained · output truncated · timeout 4s · alt+e to expand");
      expect(collapsed).not.toContain(body);
      expect(collapsed).not.toContain(fullOutputPath);
      row.setExpanded(true);
      const expanded = (row.render(100) as string[]).map(stripAnsi).join("\n");
      expect(expanded).toContain(body);
      expect(expanded).toContain(fullOutputPath);
      row.setExpanded(false);
      expect((row.render(100) as string[]).map(stripAnsi).join("\n")).toBe(collapsed);
    });
  });

  it("drives Read and Bash through real Pi slot identity and transient renderer recovery", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withBinding(["ctrl+o"], () => {
      for (const name of ["read", "bash"] as const) {
        let callThrows = false;
        let resultThrows = false;
        const callContexts: any[] = [];
        const resultContexts: any[] = [];
        const native = {
          name, execute() {},
          renderCall(args: any, _theme: unknown, context: any) {
            callContexts.push(context);
            if (callThrows) throw new Error("call failed");
            return { render: () => [`native ${name} ${args.path ?? args.command ?? "..."}`] };
          },
          renderResult(result: any, _options: unknown, _theme: unknown, context: any) {
            resultContexts.push(context);
            if (resultThrows) throw new Error("result failed");
            return { render: () => [`native body ${result.content?.[0]?.text ?? ""}`] };
          },
        };
        const args = name === "read" ? { path: "matrix.txt" } : { command: "printf matrix" };
        const row = new sdk.ToolExecutionComponent(name, "reused-matrix-id", args, {},
          wrapForSelfShell(withDefaultCollapsedToolRendering(native as any)),
          { requestRender() {} }, process.cwd().replace(/\\/g, "/"));
        row.setArgsComplete();
        const pending = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(glyphs(pending)).toEqual(["○"]);
        expect(pending.split("\n").filter(Boolean)).toHaveLength(1);
        row.setExpanded(true);
        const expandedPending = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(expandedPending).toContain(`native ${name}`);
        row.markExecutionStarted();
        row.updateResult({ content: [{ type: "text", text: "streaming" }], details: undefined }, true);
        const streaming = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(streaming.match(/streaming/gu)).toHaveLength(1);
        expect(glyphs(streaming)).toEqual(["○"]);
        expect(callContexts.at(-1).state).toBe(resultContexts.at(-1).state);
        expect(callContexts.at(-1).lastComponent).not.toBe(resultContexts.at(-1).lastComponent);

        callThrows = true;
        resultThrows = true;
        row.updateResult({ content: [{ type: "text", text: "failure evidence" }], details: undefined }, false);
        const failed = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(failed).toContain(name === "read" ? "read ..." : "bash $ ...");
        expect(failed).toContain("failure evidence");
        callThrows = false;
        resultThrows = false;
        row.setExpanded(true);
        const recovered = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(recovered).toContain(`native ${name}`);
        expect(recovered).toContain("failure evidence");
        expect(callContexts.at(-1).lastComponent).toBeUndefined();
        expect(resultContexts.at(-1).lastComponent).toBeUndefined();
        row.setExpanded(false);
        row.updateResult({ content: [{ type: "text", text: "ordinary history" }], details: undefined }, false);
        const recollapsed = (row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(recollapsed).not.toContain("ordinary history");
        expect(glyphs(recollapsed)).toEqual(["●"]);
      }
    });
  });

  it("isolates four fresh real-Pi rows with reused IDs across pending, history, expansion, and errors", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    withBinding(["ctrl+o"], () => {
      const callRecords = new Map<string, Array<{ last: unknown; returned: unknown }>>();
      const instrument = (native: any) => ({
        ...native,
        renderCall(args: any, theme: unknown, context: any) {
          const returned = native.renderCall(args, theme, context);
          const key = args.path ?? args.command ?? "...";
          const records = callRecords.get(key) ?? [];
          records.push({ last: context.lastComponent, returned });
          callRecords.set(key, records);
          return returned;
        },
      });
      const read = wrapForSelfShell(withDefaultCollapsedToolRendering(instrument(sdk.createReadToolDefinition(process.cwd()))));
      const bash = wrapForSelfShell(withDefaultCollapsedToolRendering(instrument(sdk.createBashToolDefinition(process.cwd()))));
      const make = (name: "read" | "bash", args: any) => new sdk.ToolExecutionComponent(
        name, "deliberately-reused-id", args, {}, name === "read" ? read : bash,
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      const rows = [
        { row: make("read", { path: "read-a.txt" }), key: "read-a.txt", body: "READ_A" },
        { row: make("read", { path: "read-b.txt" }), key: "read-b.txt", body: "READ_B" },
        { row: make("bash", { command: "printf bash-a", timeout: 1 }), key: "printf bash-a", body: "BASH_A" },
        { row: make("bash", { command: "printf bash-b", timeout: 9 }), key: "printf bash-b", body: "BASH_B" },
      ];
      for (const entry of rows) {
        entry.row.setArgsComplete();
        expect(glyphs((entry.row.render(100) as string[]).join("\n"))).toEqual(["○"]);
      }
      for (const entry of [rows[0]!, rows[2]!]) {
        entry.row.setExpanded(true);
        entry.row.render(100);
        const firstNative = callRecords.get(entry.key)?.at(-1)?.returned;
        entry.row.markExecutionStarted();
        entry.row.updateResult({ content: [{ type: "text", text: `${entry.body}_PARTIAL` }], details: undefined }, true);
        const partial = (entry.row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(partial).toContain(`${entry.body}_PARTIAL`);
        expect(callRecords.get(entry.key)?.at(-1)?.last).toBe(firstNative);
      }
      for (const entry of rows) {
        entry.row.setExpanded(false);
        entry.row.markExecutionStarted();
        entry.row.updateResult({ content: [{ type: "text", text: entry.body }], details: undefined }, false);
        const collapsed = (entry.row.render(100) as string[]).map(stripAnsi).join("\n");
        expect(collapsed).toContain(entry.key);
        expect(collapsed).not.toContain(entry.body);
      }
      rows[1]!.row.setExpanded(true);
      const readB = (rows[1]!.row.render(100) as string[]).map(stripAnsi).join("\n");
      expect(readB).toContain("READ_B");
      expect(readB).not.toContain("READ_A");
      rows[1]!.row.setExpanded(false);
      expect((rows[1]!.row.render(100) as string[]).map(stripAnsi).join("\n")).not.toContain("READ_B");

      for (const [name, args, status] of [
        ["read", { path: "read-error.txt" }, "Read failed: isolated"],
        ["bash", { command: "exit 7", timeout: 7 }, "Command exited with code 7"],
      ] as const) {
        const reconstructed = make(name, args);
        reconstructed.updateResult({ content: [{ type: "text", text: status }], details: undefined, isError: true }, false);
        const rendered = (reconstructed.render(100) as string[]).map(stripAnsi).join("\n");
        expect(rendered).toContain(status);
        expect(glyphs(rendered)).toEqual(["✗"]);
        expect(rows.every((entry) => !rendered.includes(entry.body))).toBe(true);
      }
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

      for (const [text, command] of [
        ["Command timed out after 1 seconds", "sleep 2"],
        ["Command exited with code 7", "exit 7"],
      ] as const) {
        const bashFailure = new sdk.ToolExecutionComponent("bash", `bash-${command}`, { command, timeout: 1 }, {},
          wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createBashToolDefinition(process.cwd()))),
          { requestRender() {} }, process.cwd().replace(/\\/g, "/"));
        bashFailure.updateResult({ content: [{ type: "text", text }], details: undefined, isError: true }, false);
        const failureText = (bashFailure.render(80) as string[]).map(stripAnsi).join("\n");
        expect(failureText).toContain(text);
        expect(glyphs(failureText)).toEqual(["✗"]);
      }

      for (const [name, args] of [["read", { path: "stopped.txt" }], ["bash", { command: "sleep 9" }]] as const) {
        const native = name === "read" ? sdk.createReadToolDefinition(process.cwd()) : sdk.createBashToolDefinition(process.cwd());
        const stopped = new sdk.ToolExecutionComponent(name, `${name}-stopped`, args, {},
          wrapForSelfShell(withDefaultCollapsedToolRendering(native)),
          { requestRender() {} }, process.cwd().replace(/\\/g, "/"));
        stopped.updateResult({ content: [{ type: "text", text: "Command aborted by user" }], details: undefined, isError: true }, false);
        const stoppedText = (stopped.render(80) as string[]).map(stripAnsi).join("\n");
        expect(stoppedText).toContain("aborted by user");
        expect(glyphs(stoppedText)).toEqual(["■"]);
      }

      const malformed = new sdk.ToolExecutionComponent(
        "read", "read-malformed", { path: 42 }, {},
        wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createReadToolDefinition(process.cwd()))),
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      malformed.updateResult({ content: [{ type: "text", text: "ignored" }], details: undefined }, false);
      const malformedText = (malformed.render(80) as string[]).map(stripAnsi).join("\n");
      expect(malformedText).toContain("unfamiliar arguments");
      expect(malformedText.match(/unfamiliar arguments/gu)).toHaveLength(1);
      expect(glyphs(malformedText)).toEqual(["✗"]);

      const malformedResult = new sdk.ToolExecutionComponent(
        "read", "read-malformed-result", { path: "broken-envelope.txt" }, {},
        wrapForSelfShell(withDefaultCollapsedToolRendering(sdk.createReadToolDefinition(process.cwd()))),
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      malformedResult.updateResult({ content: [{ type: "future", payload: "unknown" }], details: undefined }, false);
      const malformedResultText = (malformedResult.render(80) as string[]).map(stripAnsi).join("\n");
      expect(malformedResultText.match(/unfamiliar result/gu)).toHaveLength(1);
      expect(malformedResultText.split("\n").filter(Boolean)).toHaveLength(1);
      expect(glyphs(malformedResultText)).toEqual(["✗"]);
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

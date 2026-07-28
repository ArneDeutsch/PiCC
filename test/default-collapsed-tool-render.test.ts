import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withDefaultCollapsedToolRendering } from "../src/runtime/default-collapsed-tool-render.js";
import { withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";

interface Component { render(width: number): string[] }
interface RenderTool {
  name: string;
  execute: unknown;
  renderCall(args: unknown, theme: unknown, context: unknown): Component;
  renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): Component;
}

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piTui = await import(pathToFileURL(requireFromPi.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
const theme = { fg: (_slot: string, text: string) => text, bold: (text: string) => text };
const definitions = {
  ...TUI_KEYBINDINGS,
  "app.tools.expand": { defaultKeys: "ctrl+o" as const, description: "Toggle tool output" },
};

function component(text: string): Component {
  return { render: () => text.split("\n") };
}

function definition(
  name: "read" | "write" | "bash" | "edit",
  behavior: { callThrows?: boolean; resultThrows?: boolean } = {},
  dependencies: Parameters<typeof withDefaultCollapsedToolRendering>[1] = {},
): RenderTool {
  return withDefaultCollapsedToolRendering({
    name, label: name, description: "test", parameters: {}, execute() {},
    renderCall(args: unknown, _theme: unknown, context: { lastComponent?: Component }) {
      if (behavior.callThrows) throw new Error("call renderer failed");
      const value = args as { path?: string; command?: string };
      return context.lastComponent ?? component(name === "bash" ? `native call $ ${value.command}` : `native call ${value.path}`);
    },
    renderResult(result: unknown, _options: unknown, _theme: unknown, context: { lastComponent?: Component }) {
      if (behavior.resultThrows) throw new Error("result renderer failed");
      const text = (result as { content: Array<{ text?: string }> }).content.map((block) => block.text ?? "").join("\n");
      return component(`native detail ${text}`);
    },
  } as unknown as ToolDefinition, dependencies) as unknown as RenderTool;
}

function multiDefinition(): RenderTool {
  const routine = withRoutineToolRendering(
    { name: "MultiEdit", execute() {} } as unknown as ToolDefinition,
    { createEditDefinition: () => ({ renderResult(result) {
      return component(`native delegated ${(result as { details: { diff: string } }).details.diff}`);
    } }) },
  );
  return withDefaultCollapsedToolRendering(routine) as unknown as RenderTool;
}

function result(text: string, extra: Record<string, unknown> = {}): unknown {
  return { content: [{ type: "text", text }], details: undefined, ...extra };
}

function withBinding<T>(keys: string[], run: () => T): T {
  const previousRoot = getKeybindings();
  const previousPi = piTui.getKeybindings();
  setKeybindings(new KeybindingsManager(definitions, { "app.tools.expand": ["root-only"] as never }));
  piTui.setKeybindings(new piTui.KeybindingsManager(definitions, { "app.tools.expand": keys as never }));
  try { return run(); } finally {
    piTui.setKeybindings(previousPi);
    setKeybindings(previousRoot);
  }
}

function paint(
  tool: RenderTool,
  args: unknown,
  value: unknown | undefined,
  flags: { state?: object; partial?: boolean; expanded?: boolean; error?: boolean; argsComplete?: boolean; id?: string } = {},
  width = 160,
): { call: string; detail: string; all: string } {
  const state = flags.state ?? {};
  const partial = flags.partial ?? value === undefined;
  const expanded = flags.expanded ?? false;
  const context = {
    args, state, isPartial: partial, isError: flags.error ?? false, expanded,
    argsComplete: flags.argsComplete ?? true, executionStarted: value !== undefined,
    cwd: process.cwd(), toolCallId: flags.id, showImages: false, invalidate() {},
  };
  const callComponent = tool.renderCall(args, theme, context);
  const detailComponent = value === undefined ? undefined : tool.renderResult(
    value, { expanded, isPartial: partial }, theme, context,
  );
  const call = callComponent.render(width).join("\n");
  const detail = detailComponent?.render(width).join("\n") ?? "";
  return { call, detail, all: [call, detail].filter(Boolean).join("\n") };
}

describe("default-collapsed Read/Bash rendering", () => {
  it("renders incomplete incremental arguments as ellipses", () => withBinding(["ctrl+o"], () => {
    expect(paint(definition("read"), {}, undefined, { partial: true, argsComplete: false }).call).toBe("read ...");
    expect(paint(definition("bash"), {}, undefined, { partial: true, argsComplete: false }).call).toBe("bash $ ...");
    expect(paint(definition("read"), { path: "part" }, undefined, { partial: true, argsComplete: false }).call)
      .toBe("read part");
    expect(paint(definition("bash"), { command: "echo par" }, undefined, { partial: true, argsComplete: false }).call)
      .toBe("bash $ echo par");
  }));

  it("renders the exact Read range and Bash timeout/multiline grammar", () => withBinding(["alt+x"], () => {
    const reads = [
      [{ path: "a.ts" }, "read a.ts"],
      [{ path: "a.ts", limit: 4 }, "read a.ts:1-4"],
      [{ path: "a.ts", offset: 7 }, "read a.ts:7"],
      [{ path: "a.ts", offset: 7, limit: 4 }, "read a.ts:7-10"],
    ] as const;
    for (const [args, expected] of reads) {
      const painted = paint(definition("read"), args, result("SECRET"), { partial: false });
      expect(painted.call).toBe(expected);
      expect(painted.detail).toBe("");
      expect(painted.all).not.toContain("SECRET");
    }
    expect(paint(definition("read"), {
      path: "overflow", offset: Number.MAX_SAFE_INTEGER, limit: 2,
    }, result("body"), { partial: false }).call).toContain("unfamiliar arguments");
    const bashCases = [
      [{ command: "printf one" }, "bash $ printf one"],
      [{ command: "\r\n printf one\r\n\r\necho two", timeout: 2.5 }, "bash $ printf one [ …] (timeout 2.5s)"],
    ] as const;
    for (const [args, expected] of bashCases) {
      const painted = paint(definition("bash"), args, result("SECRET"), { partial: false });
      expect(painted.call).toBe(expected);
      expect(painted.detail).toBe("");
    }
  }));

  it("keeps pending and collapsed streaming call-owned, then expands, settles, and recollapses", () => withBinding(["ctrl+o"], () => {
    for (const [tool, args, identity] of [
      [definition("read"), { path: "stream.txt" }, "read stream.txt"],
      [definition("bash"), { command: "printf stream" }, "bash $ printf stream"],
    ] as const) {
      const state = {};
      expect(paint(tool, args, undefined, { state, partial: true }).all).toBe(identity);
      expect(paint(tool, args, result("ROLLING"), { state, partial: true }).all).toBe(identity);
      const expandedPending = paint(tool, args, undefined, { state, partial: true, expanded: true });
      expect(expandedPending.call).toContain("native call");
      expect(expandedPending.detail).toBe("");
      const expandedPartial = paint(tool, args, result("ROLLING"), { state, partial: true, expanded: true });
      expect(expandedPartial.all).toContain("native call");
      expect(expandedPartial.all).toContain("ROLLING");
      const collapsed = paint(tool, args, result("FINAL SECRET"), { state, partial: false });
      expect(collapsed.all).toBe(identity);
      const expanded = paint(tool, args, result("FINAL SECRET"), { state, partial: false, expanded: true });
      expect(expanded.all).toContain("FINAL SECRET");
      expect(expanded.all.match(/native call/gu)).toHaveLength(1);
      expect(paint(tool, args, result("FINAL SECRET"), { state, partial: false }).all).toBe(identity);
    }
  }));

  it("composes both expansion-field mismatch directions through one stable mutable call slot", () => withBinding(["ctrl+o"], () => {
    for (const [optionExpanded, contextExpanded] of [[true, false], [false, true]] as const) {
      const tool = definition("read");
      const args = { path: "mismatch.txt" };
      const value = result("VISIBLE");
      const state = {};
      const base = { args, state, isPartial: false, isError: false, argsComplete: true, executionStarted: true,
        cwd: process.cwd(), showImages: false, invalidate() {} };
      const call = tool.renderCall(args, theme, { ...base, expanded: contextExpanded });
      const originalCallIdentity = call;
      const detail = tool.renderResult(value, { expanded: optionExpanded, isPartial: false }, theme,
        { ...base, expanded: contextExpanded });
      expect(call).toBe(originalCallIdentity);
      expect([call.render(100), detail.render(100)].flat().join("\n")).toBe("native call mismatch.txt\nnative detail VISIBLE");
      tool.renderCall(args, theme, { ...base, expanded: false });
      const recollapsedDetail = tool.renderResult(value, { expanded: false, isPartial: false }, theme,
        { ...base, expanded: false });
      expect(call).toBe(originalCallIdentity);
      expect([call.render(100), recollapsedDetail.render(100)].flat().join("\n")).toBe("read mismatch.txt");
    }
  }));

  it("fails open through Pi-owned binding state despite a contradictory root singleton", () => {
    withBinding([], () => {
      const painted = paint(definition("read"), { path: "open.txt" }, result("REACHABLE"), { partial: false });
      expect(painted.call).toContain("native call");
      expect(painted.detail).toContain("REACHABLE");
    });
    withBinding(["alt+p"], () => {
      const painted = paint(definition("read"), { path: "closed.txt" }, result("HIDDEN"), { partial: false });
      expect(painted.all).toBe("read closed.txt");
    });
  });

  it("classifies raw relative, POSIX, drive, device, and UNC paths before sanitizing", () => withBinding(["ctrl+o"], () => {
    const matrices = [
      { workspace: "/repo/worktree", repository: "/repo", cases: [
        ["relative.ts", "relative.ts"], ["repo:literal.ts", "./repo:literal.ts"],
        ["/repo/worktree/src/a.ts", "src/a.ts"], ["/repo/src/a.ts", "repo:src/a.ts"],
        ["/repo/src/colon\u200b:a.ts", "repo:src/colon�:a.ts"],
      ] },
      { workspace: "C:\\Repo\\worktree", repository: "C:\\Repo", cases: [
        ["C:\\Repo\\worktree\\src\\a.ts", "src\\a.ts"], ["C:\\Repo\\a.ts", "repo:a.ts"],
        ["C:drive-relative.ts", "C:drive-relative.ts"], ["\\\\?\\C:\\device\\a.ts", "\\\\?\\C:\\device\\a.ts"],
        ["\\\\server\\share\\a.ts", "\\\\server\\share\\a.ts"], ["\\\\server\\bad:share\\a.ts", "\\\\server\\bad:share\\a.ts"],
      ] },
      { workspace: "\\\\server\\share\\repo\\worktree", repository: "\\\\server\\share\\repo", cases: [
        ["\\\\server\\share\\repo\\worktree\\a.ts", "a.ts"],
        ["\\\\server\\share\\repo\\a.ts", "repo:a.ts"],
        ["\\\\server\\share2\\a.ts", "\\\\server\\share2\\a.ts"],
      ] },
    ] as const;
    for (const matrix of matrices) {
      for (const [rawPath, expected] of matrix.cases) {
        const tool = definition("read", {}, { resolveDisplayRoot: () => matrix.workspace, repositoryRoot: matrix.repository });
        const state = {};
        paint(tool, { path: rawPath }, undefined, { state, partial: true });
        expect(paint(tool, { path: rawPath }, result("body"), { state, partial: false }).call).toBe(`read ${expected}`);
      }
    }
  }));

  it("snapshots classified paths and keeps canonical arguments/results immutable", () => withBinding(["ctrl+o"], () => {
    const rawPath = "/repo/src/colon\u200B:a.ts";
    const args = Object.freeze({ path: rawPath });
    const value = Object.freeze({ content: Object.freeze([{ type: "text", text: "body" }]), details: undefined });
    const resolver = vi.fn(() => "/repo/worktree");
    const tool = definition("read", {}, { resolveDisplayRoot: resolver, repositoryRoot: "/repo" });
    const state = {};
    paint(tool, args, undefined, { state, partial: true, argsComplete: true });
    expect(paint(tool, args, value, { state, partial: false }).call).toBe("read repo:src/colon�:a.ts");
    expect(paint(tool, args, value, { state, partial: false }).call).toBe("read repo:src/colon�:a.ts");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(args.path).toBe(rawPath);
    expect(value.content[0]?.text).toBe("body");
  }));

  it("keeps ordinary prose hidden and pins exact Read continuation coherence boundaries", () => withBinding(["ctrl+o"], () => {
    const tool = definition("read");
    expect(paint(tool, { path: "prose" }, result("There are more lines in file if you need them."), { partial: false }).detail)
      .toBe("");
    expect(paint(tool, { path: "notice" }, result("line\n[Truncated: byte limit reached]"), { partial: false }).detail)
      .toContain("Truncated");

    for (const [args, text, exact] of [
      [{ path: "page", limit: 2 }, "one\ntwo\n\n[4 more lines in file. Use offset=3 to continue.]", true],
      [{ path: "page", offset: 9, limit: 2 }, "one\ntwo\n\n[4 more lines in file. Use offset=11 to continue.]", true],
      [{ path: "page", limit: 2 }, "one\n\n[4 more lines in file. Use offset=3 to continue.]", false],
      [{ path: "page", limit: 2 }, "one\ntwo\n\n[4 more lines in file. Use offset=9 to continue.]", false],
      [{ path: "page", limit: 2 }, "one\ntwo\n\n[4 More lines in file. Use offset=3 to continue.]", false],
      [{ path: "page", limit: 2 }, "[4 more lines in file. Use offset=3 to continue.]\none\ntwo", false],
      [{ path: "page", limit: 2 }, "one\ntwo\n\n[4 more lines in file. Use offset=3 to continue.]\nextra", false],
      [{ path: "page", limit: 2 }, "one [4 more lines in file. Use offset=3 to continue.] two", false],
    ] as const) {
      const painted = paint(definition("read"), args, result(text), { partial: false });
      if (exact) expect(painted.detail).toBe("4 more lines · next offset 3".replace("3", String((args.offset ?? 1) + 2)));
      else expect(painted.detail).not.toContain("next offset");
    }
    const extraBlock = paint(definition("read"), { path: "page", limit: 2 }, {
      content: [{ type: "text", text: "one\ntwo\n\n[4 more lines in file. Use offset=3 to continue.]" },
        { type: "text", text: "metadata" }], details: undefined,
    }, { partial: false });
    expect(extraBlock.detail).not.toContain("next offset");
    const metadata = paint(definition("read"), { path: "page", limit: 2 }, {
      content: [{ type: "text", text: "one\ntwo\n\n[4 more lines in file. Use offset=3 to continue.]" }], details: { warning: true },
    }, { partial: false });
    expect(metadata.detail).not.toContain("next offset");

    for (const [text, visible] of [
      ["retained body\n[4 more lines in file.]", true],
      ["[1 more lines in file.]", true],
      ["retained body\n[0 more lines in file.]", false],
      ["retained body\n[4 More lines in file.]", false],
      ["retained body\n4 more lines in file.", false],
      ["retained body\n[4 more lines in file.]\ntrailing", false],
      ["retained body [4 more lines in file.]", false],
    ] as const) {
      const noOffset = paint(definition("read"), { path: "bounded" }, result(text), { partial: false });
      if (visible) {
        expect(noOffset.detail).toMatch(/^\[[1-9]\d* more lines in file\.\]$/u);
        expect(noOffset.all).not.toContain("retained body");
      } else expect(noOffset.detail).not.toMatch(/^\[[1-9]\d* more lines in file\.\]$/u);
    }
  }));

  it("delegates detached sanitized successful image displays and contains failed mixed bodies", () => withBinding(["ctrl+o"], () => {
    const delegated: unknown[] = [];
    const source = {
      name: "read", execute() {},
      renderCall: () => component("native image call"),
      renderResult(value: { content: Array<{ type: string; text?: string; data?: string }> }) {
        delegated.push(value);
        const images = value.content.filter((block) => block.type === "image").map((block) => block.data?.length ?? 0);
        const text = value.content.filter((block) => block.type === "text").map((block) => block.text).join("|");
        return component(`native images ${images.join(",")} text ${text}`);
      },
    } as unknown as ToolDefinition;
    const read = withDefaultCollapsedToolRendering(source) as unknown as RenderTool;
    const image = Object.freeze({ type: "image", data: "AAAA", mimeType: "image/png" });
    const pureValue = Object.freeze({ content: Object.freeze([image]), details: undefined });
    expect(paint(read, { path: "image.png" }, pureValue, { partial: false }).detail).toContain("native images 4");
    const unsafeText = "notebook\u001b]0;SECRET_TITLE\u0007 metadata";
    const mixedValue = Object.freeze({
      content: Object.freeze([image, Object.freeze({ type: "text", text: unsafeText })]),
      details: undefined,
    });
    const mixed = paint(read, { path: "mixed.ipynb" }, mixedValue, { partial: false });
    expect(mixed.detail).toContain("native images 4 text notebook� metadata");
    expect(mixed.detail).not.toContain("SECRET_TITLE");
    expect((delegated.at(-1) as { content: unknown[] })).not.toBe(mixedValue);
    expect((delegated.at(-1) as { content: unknown[] }).content).not.toBe(mixedValue.content);
    expect((mixedValue.content[1] as { text: string }).text).toBe(unsafeText);

    let successfulPayloadReads = 0;
    const largeMixed = Array.from({ length: 41 }, (_, index) => index === 40
      ? { type: "text", text: "notebook metadata" }
      : { type: "image", mimeType: "image/png", get data() { successfulPayloadReads++; return "AAAA"; } });
    expect(paint(read, { path: "notebook.ipynb" }, { content: largeMixed, details: undefined }, { partial: false }).detail)
      .toContain("notebook metadata");
    expect(successfulPayloadReads).toBe(40);

    let oversizedPayloadReads = 0;
    const oversizedMixed = {
      content: [
        { type: "image", mimeType: "image/png", get data() {
          oversizedPayloadReads++;
          throw new Error("image payload must remain unread");
        } },
        { type: "text", text: `Read failed: hidden status\n${"x".repeat(1_000_001)}` },
      ],
      details: undefined,
    };
    const oversized = paint(read, { path: "oversized.ipynb" }, oversizedMixed, { partial: false });
    expect(oversized.all).toBe("read (unfamiliar result)");
    expect(oversized.all).not.toContain("hidden status");
    expect(oversizedPayloadReads).toBe(0);

    let failedPayloadReads = 0;
    const failedImage = { type: "image", mimeType: "image/png", get data() { failedPayloadReads++; throw new Error("SECRET image"); } };
    const failed = paint(read, { path: "failed.ipynb" }, {
      content: [failedImage, { type: "text", text: "SECRET_BODY\u001b]0;title\u0007\nRead failed: sanitized status" }],
      details: undefined, isError: true,
    }, { partial: false, error: true });
    expect(failed.detail).toBe("Read failed: sanitized status");
    expect(failed.all).not.toContain("SECRET_BODY");
    expect(failedPayloadReads).toBe(0);
    const malformed = paint(read, { path: "malformed.ipynb" }, {
      content: [failedImage, { type: "future" }, { type: "text", text: "SECRET malformed" }], details: undefined,
    }, { partial: false });
    expect(malformed.all).toContain("unfamiliar result");
    expect(malformed.all).not.toContain("SECRET malformed");
    expect(failedPayloadReads).toBe(0);
  }));

  it("shows bounded exceptional and recovery evidence without reopening ordinary bodies", () => withBinding(["ctrl+o"], () => {
    const cases = [
      { tool: definition("read"), args: { path: "page" }, value: result(`short-prefix\n[Truncated: byte limit reached]`), evidence: "Truncated", hidden: "short-prefix" },
      { tool: definition("read"), args: { path: "page" }, value: result(`HUGE_PREFIX${"x".repeat(10_000)}\n[Truncated: byte limit reached]`), evidence: "Truncated", hidden: "HUGE_PREFIX" },
      { tool: definition("read"), args: { path: "page" }, value: result(`HUGE_CLIPPED_PREFIX${"c".repeat(10_000)}\n[PiCC clipped tool output]`), evidence: "clipped", hidden: "HUGE_CLIPPED_PREFIX" },
      { tool: definition("read"), args: { path: "bad" }, value: result("read failed", { isError: true }), error: true, evidence: "read failed" },
      { tool: definition("read"), args: { path: "future" }, value: { content: [{ type: "text", text: "future evidence" }], future: true }, evidence: "future evidence" },
      { tool: definition("bash"), args: { command: "false" }, value: result("short-output\nCommand exited with code 7", { isError: true }), error: true, evidence: "code 7", hidden: "short-output" },
      { tool: definition("bash"), args: { command: "sleep 2", timeout: 1 }, value: result(`HUGE_OUTPUT${"y".repeat(10_000)}\nCommand timed out after 1 seconds`, { isError: true }), error: true, evidence: "timed out", hidden: "HUGE_OUTPUT" },
      { tool: definition("bash"), args: { command: "sleep 9" }, value: result("short-abort-output\nCommand aborted by user", { isError: true }), error: true, evidence: "aborted", hidden: "short-abort-output" },
      { tool: definition("bash"), args: { command: "sleep 9" }, value: result(`HUGE_ABORT_OUTPUT${"z".repeat(10_000)}\nCommand aborted by user`, { isError: true }), error: true, evidence: "aborted", hidden: "HUGE_ABORT_OUTPUT" },
    ];
    for (const entry of cases) {
      const painted = paint(entry.tool, entry.args, entry.value, { partial: false, error: entry.error });
      expect(painted.call).toMatch(/^(?:read|bash \$)/u);
      expect(painted.detail).toContain(entry.evidence);
      if (entry.hidden) expect(painted.all).not.toContain(entry.hidden);
      expect(painted.detail.length).toBeLessThan(1_600);
    }
  }));

  it("renders one call-owned malformed-result failure in concise and expanded prior states", () => withBinding(["ctrl+o"], () => {
    for (const expanded of [false, true]) {
      const tool = definition("read");
      const args = { path: "malformed.txt" };
      const state = {};
      const context = { args, state, isPartial: false, isError: false, expanded,
        argsComplete: true, executionStarted: true, cwd: process.cwd(), showImages: false, invalidate() {} };
      const call = tool.renderCall(args, theme, context);
      const callIdentity = call;
      const detail = tool.renderResult({ content: [{ type: "future" }], details: undefined },
        { expanded, isPartial: false }, theme, context);
      const composed = [call.render(100), detail.render(100)].flat().filter(Boolean);
      expect(composed).toEqual(["read (unfamiliar result)"]);
      const recovered = tool.renderResult(result("RECOVERED"),
        { expanded: true, isPartial: false }, theme, context);
      expect(call).toBe(callIdentity);
      expect([call.render(100), recovered.render(100)].flat().join("\n"))
        .toBe("native call malformed.txt\nnative detail RECOVERED");
    }
  }));

  it("uses slot-specific renderer fallbacks and clears only failed native identities", () => withBinding(["ctrl+o"], () => {
    const callFailure = paint(definition("read", { callThrows: true }), { path: "safe.ts" }, result("body"), {
      partial: false, expanded: true,
    });
    expect(callFailure.call).toContain("read ...");
    expect(callFailure.detail).toContain("body");

    const collapsedCallFailure = paint(definition("bash", { callThrows: true }),
      { command: "printf ordinary" }, result("X".repeat(20_000)), { partial: false });
    expect(collapsedCallFailure.all).toBe("bash $ ...");

    const resultFailureTool = definition("bash", { resultThrows: true });
    const state = {};
    const collapsed = paint(resultFailureTool, { command: "false" }, result("canonical status"), { state, partial: false });
    expect(collapsed.call).toBe("bash $ false");
    expect(collapsed.detail).toContain("canonical status");
    const expanded = paint(resultFailureTool, { command: "false" }, result("canonical status"), {
      state, partial: false, expanded: true,
    });
    expect(expanded.call).toContain("native call");
    expect(expanded.detail).toContain("canonical status");
  }));

  it("clears only a transiently failed native slot and recovers without cross-slot identity reuse", () => withBinding(["ctrl+o"], () => {
    let callThrows = false;
    let resultThrows = false;
    const callComponents: Component[] = [];
    const resultComponents: Component[] = [];
    const seenCallLast: Array<Component | undefined> = [];
    const seenResultLast: Array<Component | undefined> = [];
    const tool = withDefaultCollapsedToolRendering({
      name: "read", execute() {},
      renderCall(_args: unknown, _theme: unknown, context: { lastComponent?: Component }) {
        seenCallLast.push(context.lastComponent);
        if (callThrows) throw new Error("call");
        const next = component(`native-call-${callComponents.length}`);
        callComponents.push(next);
        return next;
      },
      renderResult(value: { content: Array<{ text?: string }> }, _options: unknown, _theme: unknown,
        context: { lastComponent?: Component }) {
        seenResultLast.push(context.lastComponent);
        if (resultThrows) throw new Error("result");
        const next = component(`native-result-${resultComponents.length}:${value.content[0]?.text ?? ""}`);
        resultComponents.push(next);
        return next;
      },
    } as unknown as ToolDefinition) as unknown as RenderTool;
    const args = { path: "recover.txt" };
    const state = {};

    paint(tool, args, result("partial"), { state, partial: true, expanded: true });
    expect(seenCallLast.at(-1)).toBeUndefined();
    expect(seenResultLast.at(-1)).toBeUndefined();
    expect(callComponents[0]).not.toBe(resultComponents[0]);

    callThrows = true;
    resultThrows = true;
    const failed = paint(tool, args, result("failure evidence"), { state, partial: false, expanded: true });
    expect(failed.call).toContain("read ...");
    expect(failed.detail).toContain("failure evidence");

    callThrows = false;
    resultThrows = false;
    const recovered = paint(tool, args, result("recovered"), { state, partial: false, expanded: true });
    expect(recovered.call).toContain("native-call");
    expect(recovered.detail).toContain("recovered");
    expect(seenCallLast.at(-1)).toBeUndefined();
    expect(seenResultLast.at(-1)).toBeUndefined();
    expect(paint(tool, args, result("recovered"), { state, partial: false }).all).toBe("read recover.txt");
    expect(paint(tool, args, result("again"), { state, partial: false, expanded: true }).detail).not.toContain("failure evidence");
  }));

  it("isolates interleaved Read/Bash caches, errors, timers, snapshots, and history despite reused IDs", () => withBinding(["ctrl+o"], () => {
    let root = "/repo/one";
    const read = definition("read", {}, { resolveDisplayRoot: () => root, repositoryRoot: "/repo" });
    const bash = definition("bash");
    const readA = {};
    const readB = {};
    const bashA = { startedAt: 10, endedAt: 20 };
    const bashB = { startedAt: 100, endedAt: 300 };
    const reused = "same-tool-call-id";

    paint(read, { path: "/repo/one/a.txt" }, undefined, { state: readA, partial: true, id: reused });
    root = "/repo/two";
    paint(read, { path: "/repo/two/b.txt" }, undefined, { state: readB, partial: true, id: reused });
    expect(paint(read, { path: "/repo/one/a.txt" }, result("FIRST"), { state: readA, partial: false, id: reused }).all)
      .toBe("read a.txt");
    expect(paint(read, { path: "/repo/two/b.txt" }, result("SECOND"), { state: readB, partial: false, expanded: true, id: reused }).all)
      .toContain("SECOND");

    expect(paint(bash, { command: "printf same", timeout: 1 }, result("A"), { state: bashA, partial: false, id: reused }).all)
      .toBe("bash $ printf same (timeout 1s)");
    expect(paint(bash, { command: "printf same", timeout: 9 }, result("B failed", { isError: true }),
      { state: bashB, partial: false, error: true, id: reused }).detail).toContain("B failed");
    expect(paint(bash, { command: "printf same", timeout: 1 }, result("A"), { state: bashA, partial: false, id: reused }).all)
      .not.toContain("B failed");
    expect(paint(read, { path: "/repo/one/a.txt" }, result("FIRST"), { state: readA, partial: false, expanded: true, id: reused }).all)
      .not.toContain("SECOND");
  }));

  it("keeps controls inert, CRLF physical lines normal, and rows width-safe", () => withBinding(["ctrl+o"], () => {
    const args = { command: "\r\nprintf '\u001b]0;title\u0007safe'\r\necho hidden", timeout: 5 };
    const tool = definition("bash");
    const state = {};
    const painted = paint(tool, args, result("body"), { state, partial: false }, 200);
    expect(painted.call).toBe("bash $ printf '�safe' [ …] (timeout 5s)");
    expect(painted.call).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
    for (const width of [0, 1, 8, 24]) {
      for (const line of paint(tool, args, result("body"), { state, partial: false }, width).call.split("\n")) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  }));
});

describe("default-collapse unchanged definition contracts", () => {
  it("passes image data through and preserves execute/schema/descriptor identity", () => withBinding(["ctrl+o"], () => {
    const execute = () => undefined;
    const parameters = Object.freeze({ schema: "identity" });
    const descriptor = Object.freeze({ stable: true });
    const imageData = "A".repeat(1_000_004);
    const source = {
      name: "read", execute, parameters, descriptor,
      renderCall: () => component("native image call"),
      renderResult(value: { content: Array<{ data?: string }> }) {
        expect(value.content[0]?.data).toBe(imageData);
        return component(`native image ${value.content[0]?.data?.length}`);
      },
    } as unknown as ToolDefinition & { descriptor: object };
    const tool = withDefaultCollapsedToolRendering(source) as typeof source & RenderTool;
    expect(tool.execute).toBe(execute);
    expect(tool.parameters).toBe(parameters);
    expect(tool.descriptor).toBe(descriptor);
    const rendered = paint(tool, { path: "image.png" }, {
      content: [{ type: "image", data: imageData, mimeType: "image/png" }], details: undefined,
    }, { partial: false });
    expect(rendered.detail).toContain("native image 1000004");
  }));
});

describe("default-collapse retained mutation policies", () => {
  it("keeps Write/Edit/MultiEdit concise and restores delegated detail", () => withBinding(["ctrl+o"], () => {
    const write = definition("write");
    const writeArgs = { path: "write.ts", content: "alpha\nbeta" };
    const writeValue = result("Successfully wrote 10 bytes to write.ts");
    expect(paint(write, writeArgs, writeValue, { partial: false }).detail).toContain("2 lines hidden");
    expect(paint(write, writeArgs, writeValue, { partial: false, expanded: true }).all).toContain("Successfully wrote");

    const edit = definition("edit");
    const editArgs = { path: "edit.ts", edits: [{ oldText: "old", newText: "new" }] };
    const editValue = { content: [{ type: "text", text: "Successfully replaced 1 block(s) in edit.ts." }], details: {
      diff: "-old\n+new", patch: "patch", firstChangedLine: 1,
    } };
    expect(paint(edit, editArgs, editValue, { partial: false }).detail).toContain("1 edit applied");

    const multi = multiDefinition();
    const multiArgs = { file_path: "multi.ts", edits: [{ old_string: "old", new_string: "new" }] };
    const multiValue = { content: [{ type: "text", text: "Successfully applied 1 edit(s) to multi.ts." }], details: {
      filePath: "multi.ts", edits: 1, created: false, diff: "-old\n+new", firstChangedLine: 1,
    } };
    expect(paint(multi, multiArgs, multiValue, { partial: false }).detail).toContain("1 edit applied");

    const noNetEdit = { content: [{ type: "text", text: "Successfully replaced 1 block(s) in edit.ts." }],
      details: { diff: "", patch: "", firstChangedLine: undefined } };
    expect(paint(edit, editArgs, noNetEdit, { partial: false }).detail).toContain("1 edit applied · no net change");
    const noNetMulti = { content: [{ type: "text", text: "Successfully applied 1 edit(s) to multi.ts." }],
      details: { filePath: "multi.ts", edits: 1, created: false, diff: "", firstChangedLine: undefined } };
    expect(paint(multi, multiArgs, noNetMulti, { partial: false }).detail).toContain("1 edit applied · no net change");
  }));
});

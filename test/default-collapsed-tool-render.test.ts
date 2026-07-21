import { describe, expect, it } from "vitest";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withDefaultCollapsedToolRendering } from "../src/runtime/default-collapsed-tool-render.js";

interface Component { render(width: number): string[] }
interface RenderTool {
  name: string;
  execute: unknown;
  renderCall(args: unknown, theme: unknown, context: unknown): Component;
  renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): Component;
}

const theme = {
  fg(_slot: string, text: string) { return text; },
  bold(text: string) { return text; },
};

function component(text: string): Component {
  return { render: () => text.split("\n") };
}

function definition(name: "read" | "write"): RenderTool {
  const execute = () => undefined;
  return withDefaultCollapsedToolRendering({
    name,
    label: name,
    description: "test",
    parameters: {},
    execute,
    renderCall(args: unknown) {
      const path = (args as { path?: string }).path ?? "?";
      const content = (args as { content?: string }).content;
      return component(`native ${name} ${path}${content === undefined ? "" : `\n${content}`}`);
    },
    renderResult(result: unknown) {
      const text = ((result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "");
      return component(`native result ${text}`);
    },
  } as unknown as ToolDefinition) as unknown as RenderTool;
}

function readResult(text: string, details: unknown = undefined): unknown {
  return { content: [{ type: "text", text }], details };
}

function writeResult(path: string, content: string): unknown {
  return {
    content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
    details: undefined,
  };
}

function contexts(args: unknown) {
  const state = {};
  return {
    call: { args, state, isPartial: false, isError: false, expanded: false },
    result: { args, state, isPartial: false, isError: false, expanded: false },
  };
}

function settle(tool: RenderTool, args: unknown, result: unknown, expanded = false): string[] {
  const context = contexts(args);
  tool.renderCall(args, theme, { ...context.call, expanded }).render(120);
  return tool.renderResult(
    result,
    { expanded, isPartial: false },
    theme,
    { ...context.result, expanded },
  ).render(120);
}

function withBindings<T>(bindings: string[] | undefined, run: () => T): T {
  const previous = getKeybindings();
  const manager = new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    },
    { "app.tools.expand": bindings as never },
  );
  setKeybindings(manager);
  try {
    return run();
  } finally {
    setKeybindings(previous);
  }
}

describe("default-collapsed tool rendering", () => {
  it("preserves every unaffected descriptor and exact execute identity without invoking it", () => {
    let executions = 0;
    const execute = () => { executions++; };
    const metadataSymbol = Symbol("metadata");
    const nestedMetadata = {} as Record<PropertyKey, unknown>;
    Object.defineProperties(nestedMetadata, {
      deep: { value: Object.freeze({ distinctiveSchema: true }), enumerable: false, writable: false, configurable: false },
      [metadataSymbol]: { value: "symbol-value", enumerable: true, writable: false, configurable: false },
    });
    const parameters = Object.freeze({ distinctiveSchema: true, nestedMetadata });
    const source = {} as Record<PropertyKey, unknown>;
    Object.defineProperties(source, {
      name: { value: "read", enumerable: false, writable: false, configurable: true },
      label: { value: "distinctive", enumerable: true, writable: false, configurable: false },
      description: { value: "probe", enumerable: false, writable: true, configurable: true },
      promptSnippet: { value: "snippet", enumerable: true, writable: false, configurable: true },
      parameters: { value: parameters, enumerable: false, writable: false, configurable: false },
      execute: { value: execute, enumerable: true, writable: false, configurable: false },
      renderCall: { value: () => component("call"), enumerable: false, writable: false, configurable: true },
      renderResult: { value: () => component("result"), enumerable: false, writable: false, configurable: true },
      [metadataSymbol]: { value: nestedMetadata, enumerable: false, writable: false, configurable: false },
    });
    const before = Object.getOwnPropertyDescriptors(source);
    const nestedBefore = Object.getOwnPropertyDescriptors(nestedMetadata);
    const decorated = withDefaultCollapsedToolRendering(source as never) as unknown as Record<PropertyKey, unknown>;
    expect(decorated.execute).toBe(execute);
    expect(decorated.parameters).toBe(parameters);
    const after = Object.getOwnPropertyDescriptors(decorated);
    for (const key of Reflect.ownKeys(before)) {
      if (key !== "renderCall" && key !== "renderResult") expect(after[key]).toEqual(before[key]);
    }
    expect(Reflect.ownKeys(after)).toEqual(Reflect.ownKeys(before));
    (decorated.renderCall as RenderTool["renderCall"])({ path: "x" }, theme, { state: {}, isPartial: true }).render(80);
    expect(executions).toBe(0);
    expect(Object.getOwnPropertyDescriptors(source)).toEqual(before);
    expect(Object.getOwnPropertyDescriptors(nestedMetadata)).toEqual(nestedBefore);
    expect(Reflect.ownKeys(source)).toEqual(Reflect.ownKeys(before));
    expect(Reflect.ownKeys(nestedMetadata)).toEqual(Reflect.ownKeys(nestedBefore));

    const unsupported = { name: "other", renderCall() {}, renderResult() {} };
    expect(withDefaultCollapsedToolRendering(unsupported as never)).toBe(unsupported);
    const inherited = Object.create({ renderCall() { return component("bad"); } }) as Record<string, unknown>;
    inherited.name = "read";
    inherited.renderResult = () => component("bad");
    expect(withDefaultCollapsedToolRendering(inherited as never)).toBe(inherited);
  });

  it("collapses ordinary Read and Write successes and expands native detail exactly once", () => withBindings(["ctrl+k"], () => {
    const cases = [
      [definition("read"), { path: "src/a.ts" }, readResult("one\ntwo\n"), "2 lines hidden"],
      [definition("write"), { path: "src/b.ts", content: "alpha\r\nbeta" }, writeResult("src/b.ts", "alpha\r\nbeta"), "2 lines hidden"],
    ] as const;
    for (const [tool, args, result, count] of cases) {
      const collapsed = settle(tool, args, result);
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0]).toContain(tool.name === "read" ? "Read" : "Write");
      expect(collapsed[0]).toContain(args.path);
      expect(collapsed[0]).toContain(count);
      expect(collapsed[0]).toContain("ctrl+k to expand");
      expect(collapsed.join("\n")).not.toContain("native result");

      const expanded = settle(tool, args, result, true).join("\n");
      expect(expanded.match(new RegExp(`native ${tool.name}`, "g"))).toHaveLength(1);
      expect(expanded.match(/native result/g)).toHaveLength(1);
    }
  }));

  it.each([
    ["", "0 lines hidden"],
    ["one", "1 line hidden"],
    ["one\n", "1 line hidden"],
    ["one\r\ntwo", "2 lines hidden"],
    ["one\rtwo", "1 line hidden"],
  ])("counts retained native display lines for %j", (text, expected) => withBindings(["ctrl+o"], () => {
    expect(settle(definition("read"), { path: "f.txt" }, readResult(text)).join("\n")).toContain(expected);
  }));

  it("keeps live/partial rendering native and fails open for exceptional and unfamiliar results", () => withBindings(["ctrl+o"], () => {
    const tool = definition("read");
    const args = { path: "f.txt" };
    const state = {};
    expect(tool.renderCall(args, theme, { args, state, isPartial: true }).render(80).join("\n"))
      .toContain("native read");
    const partial = tool.renderResult(
      readResult("rolling"),
      { expanded: false, isPartial: true },
      theme,
      { args, state, isPartial: true, isError: false },
    ).render(80).join("\n");
    expect(partial).toContain("native result rolling");

    const truncated = settle(tool, args, readResult("body\n\n[Showing lines 1-1 of 2. Use offset=2 to continue.]", {
      truncation: {
        content: "body", truncated: true, truncatedBy: "lines", totalLines: 2, totalBytes: 4,
        outputLines: 1, outputBytes: 4, lastLinePartial: false, firstLineExceedsLimit: false,
        maxLines: 1, maxBytes: 50_000,
      },
    })).join("\n");
    expect(truncated).toContain("Elaborated result");
    expect(truncated).toContain("native result");

    const multiple = settle(tool, args, {
      content: [{ type: "text", text: "x" }, { type: "text", text: "notice" }],
      details: undefined,
    }).join("\n");
    expect(multiple).toContain("Elaborated result");
    expect(multiple).toContain("native result");

    for (const result of [
      { content: [{ type: "future", text: "x" }], details: undefined },
      { content: [{ type: "text", text: "x" }], details: { future: true } },
    ]) {
      expect(settle(tool, args, result).join("\n")).toContain("Unfamiliar result");
    }
  }));

  it("never invokes accessors or passes hostile originals to native renderers", () => withBindings(["ctrl+o"], () => {
    let accesses = 0;
    const hostileArgs = Object.defineProperty({}, "path", {
      enumerable: true,
      get() { accesses++; throw new Error("getter"); },
    });
    const tool = definition("read");
    expect(tool.renderCall(hostileArgs, theme, { state: {}, isPartial: false }).render(80).join("\n"))
      .toContain("Unfamiliar arguments");
    expect(accesses).toBe(0);

    const hostileResult = new Proxy({}, {
      ownKeys() { throw new Error("proxy"); },
      getOwnPropertyDescriptor() { throw new Error("proxy"); },
    });
    const args = { path: "safe.txt" };
    expect(settle(tool, args, hostileResult).join("\n")).toContain("Unfamiliar result");
  }));

  it("sanitizes controls, clamps Unicode widths 0–2, snapshots summaries, and fails open without a binding", () => {
    withBindings(["ctrl+o"], () => {
      const tool = definition("read");
      const args = { path: "界\u001b]0;pwn\u0007\nfile.txt" };
      const result = readResult("safe");
      const context = contexts(args);
      tool.renderCall(args, theme, context.call);
      const component = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context.result);
      args.path = "mutated-secret";
      for (const width of [0, 1, 2]) {
        const lines = component.render(width);
        expect(lines).toHaveLength(1);
        expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
        expect(lines.join("\n")).not.toContain("pwn");
        expect(lines.join("\n")).not.toContain("mutated-secret");
      }
    });

    withBindings([], () => {
      const tool = definition("write");
      const args = { path: "boundless.txt", content: "secret body" };
      const state = {};
      const call = tool.renderCall(args, theme, { args, state, isPartial: false, isError: false });
      expect(call.render(80).join("\n")).toContain("secret body");
      const result = tool.renderResult(
        writeResult(args.path, args.content),
        { expanded: false, isPartial: false },
        theme,
        { args, state, isPartial: false, isError: false },
      );
      expect(result.render(80).join("\n")).toContain("native result");
    });
  });

  it("caps huge payload inspection explicitly instead of compacting on unseen evidence", () => withBindings(["ctrl+o"], () => {
    const huge = "x".repeat(1_000_001);
    const lines = settle(definition("read"), { path: "huge.txt" }, readResult(huge));
    expect(lines.join("\n")).toContain("Detail inspection limit reached");
    expect(lines.join("\n")).toContain("uninspected");
    expect(lines.join("\n")).not.toContain("lines hidden");
  }));

  it("retains Read offset/limit range and keeps hidden detail visible before a long target", () => withBindings(["ctrl+o"], () => {
    const tool = definition("read");
    const args = { path: "very/long/user/supplied/target/name.txt", offset: 7, limit: 3 };
    const context = contexts(args);
    tool.renderCall(args, theme, context.call);
    const row = tool.renderResult(readResult("a\nb\nc"), { expanded: false, isPartial: false }, theme, context.result);
    expect(row.render(120).join("\n")).toContain("name.txt:7-9");
    for (const width of [28, 60]) {
      const narrow = row.render(width).join("\n");
      expect(narrow).toContain("Read");
      expect(narrow).toContain(":7-9");
      expect(narrow).toContain("hidden");
    }
    for (const width of [0, 1, 2, 8, 28, 60]) expect(visibleWidth(row.render(width)[0] ?? "")).toBeLessThanOrEqual(width);
  }));

  it("uses authoritative error state and rejects altered Write success", () => withBindings(["ctrl+o"], () => {
    const read = definition("read");
    const args = { path: "error.txt" };
    const state = {};
    read.renderCall(args, theme, { args, state, isPartial: false });
    const error = read.renderResult(readResult("permission denied"), { expanded: false, isPartial: false }, theme,
      { args, state, isPartial: false, isError: true }).render(80).join("\n");
    expect(error).toContain("Elaborated result");
    expect(error).toContain("permission denied");
    expect(error).not.toContain("hidden");
    const altered = settle(definition("write"), { path: "x", content: "body" }, readResult("Successfully wrote 999 bytes to x")).join("\n");
    expect(altered).toContain("Elaborated result");
    expect(altered).toContain("Successfully wrote 999 bytes");
  }));

  it("elaborates image, notebook, binary, degraded, continuation, and multiple-block Read outcomes", () => withBindings(["ctrl+o"], () => {
    const cases: unknown[] = [
      { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], details: undefined },
      readResult("notebook cells", { truncated: false }),
      readResult("binary file", { binary: true }),
      readResult("could not read notebook", { notebookError: true }),
      readResult("body\n\n[3 more lines in file. Use offset=2 to continue.]"),
      { content: [{ type: "text", text: "body" }, { type: "text", text: "warning" }], details: undefined },
    ];
    for (const value of cases) {
      const rendered = settle(definition("read"), { path: "special.dat" }, value).join("\n");
      expect(rendered).toContain("Elaborated result");
      expect(rendered).not.toContain("lines hidden");
    }
  }));

  it("fails closed for accessor, inherited, revoked, counting-proxy, and large-key shapes", () => withBindings(["ctrl+o"], () => {
    let getters = 0;
    const accessor = Object.defineProperty({ content: [] }, "details", { enumerable: true, get() { getters++; return undefined; } });
    const inherited = Object.create({ details: undefined });
    inherited.content = [{ type: "text", text: "body" }];
    const { proxy: revoked, revoke } = Proxy.revocable([], {});
    revoke();
    let ownKeyCalls = 0;
    const counting = new Proxy({ content: [{ type: "text", text: "body" }], details: undefined }, {
      ownKeys(target) { ownKeyCalls++; return Reflect.ownKeys(target); },
    });
    const large = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, index]));
    for (const value of [accessor, inherited, revoked, counting, large]) {
      expect(settle(definition("read"), { path: "x" }, value).join("\n")).not.toContain("lines hidden");
    }
    expect(getters).toBe(0);
    expect(ownKeyCalls).toBeLessThanOrEqual(2);
  }));

  it.each([
    ["characters", () => readResult("x".repeat(1_000_001))],
    ["elements", () => ({ content: Array.from({ length: 129 }, () => ({ type: "text", text: "x" })), details: undefined })],
    ["keys", () => Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, index]))],
    ["depth", () => { let value: unknown = "leaf"; for (let index = 0; index < 9; index++) value = { next: value }; return value; }],
    ["aggregate characters", () => ({ content: [{ type: "text", text: "x".repeat(600_000) }, { type: "text", text: "y".repeat(400_001) }], details: undefined })],
    ["aggregate keys", () => ({ content: Array.from({ length: 5 }, () => Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`k${index}`, index]))), details: undefined })],
    ["aggregate elements", () => ({ content: [Array.from({ length: 64 }, () => 1), Array.from({ length: 64 }, () => 2)], details: undefined })],
    ["displayed lines", () => readResult("x\n".repeat(10_001))],
  ])("reports %s exhaustion as uninspected detail", (_label, make) => withBindings(["ctrl+o"], () => {
    const output = settle(definition("read"), { path: "budget" }, make()).join("\n");
    expect(output).toContain("Detail inspection limit reached");
    expect(output).toContain("uninspected");
    expect(output).not.toContain("lines hidden");
  }));

  it("labels over-budget argument characters as uninspected", () => withBindings(["ctrl+o"], () => {
    const output = definition("read").renderCall({ path: "x".repeat(16_385) }, theme,
      { state: {}, isPartial: false }).render(100).join("\n");
    expect(output).toContain("Detail inspection limit reached");
    expect(output).toContain("uninspected");
  }));

  it("passes only sanitized detached display DTOs through live, partial, expanded, and error Write paths", () => withBindings(["ctrl+o"], () => {
    const dangerous = "A\u001b[31mB\u001b]8;;https://evil\u0007C\u001b]52;c;QQ==\u0007D\u001bPpayload\u001b\\E\u001b_apc\u001b\\F\u0000\u0085\u200b\u{E0001}\u{E0020}G";
    const seen: unknown[] = [];
    const source = {
      name: "write", label: "write", description: "probe", parameters: {}, execute() {},
      renderCall(args: unknown) { seen.push(args); return component(JSON.stringify(args)); },
      renderResult(result: unknown) { seen.push(result); return component(JSON.stringify(result)); },
    };
    const tool = withDefaultCollapsedToolRendering(source as never) as unknown as RenderTool;
    const args = { path: `safe-${dangerous}\nsecond-line.txt`, content: dangerous };
    const canonicalArgs = structuredClone(args);
    Object.freeze(args);
    const state = {};
    tool.renderCall(args, theme, { args, state, isPartial: true }).render(200);
    tool.renderCall(args, theme, { args, state, isPartial: false }).render(200);
    const partial = readResult(dangerous) as { content: Array<{ type: string; text: string }>; details: undefined };
    Object.freeze(partial.content[0]);
    Object.freeze(partial.content);
    Object.freeze(partial);
    tool.renderResult(partial, { expanded: false, isPartial: true }, theme,
      { args, state, isPartial: true, isError: false }).render(200);
    expect(seen.at(-1)).not.toBe(partial);
    const success = writeResult(args.path, args.content) as { content: Array<{ type: string; text: string }>; details: undefined };
    const canonicalResult = structuredClone(success);
    Object.freeze(success.content[0]);
    Object.freeze(success.content);
    Object.freeze(success);
    tool.renderResult(success, { expanded: true, isPartial: false }, theme, { args, state, isPartial: false, isError: false }).render(200);
    const error = readResult(dangerous);
    tool.renderResult(error, { expanded: false, isPartial: false }, theme, { args, state, isPartial: false, isError: true }).render(200);
    const serialized = JSON.stringify(seen);
    expect(serialized).not.toMatch(/[\u001b\u0000\u0085\u200b\u{E0001}\u{E0020}]/u);
    for (const dto of seen) {
      const path = (dto as { path?: unknown }).path;
      if (typeof path === "string") expect(path).not.toContain("\n");
    }
    expect(args).toEqual(canonicalArgs);
    expect(partial).toEqual(readResult(dangerous));
    expect(success).toEqual(canonicalResult);
  }));

  it("clamps tiny widths for statuses, expanded detail, and capped output", () => withBindings(["ctrl+o"], () => {
    const tool = definition("read");
    const args = { path: "tiny.txt" };
    const state = {};
    tool.renderCall(args, theme, { args, state, isPartial: false });
    const components = [
      tool.renderResult({ future: true }, { expanded: false, isPartial: false }, theme,
        { args, state, isPartial: false, isError: false }),
      tool.renderResult(readResult("expanded body"), { expanded: true, isPartial: false }, theme,
        { args, state, isPartial: false, isError: false }),
      tool.renderResult(readResult("x".repeat(1_000_001)), { expanded: false, isPartial: false }, theme,
        { args, state, isPartial: false, isError: false }),
    ];
    for (const rendered of components) for (const width of [0, 1, 2]) {
      for (const line of rendered.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }));

  it("keeps successive partial result state by exact identity and handles renderer/theme/render failures", () => withBindings(["ctrl+o"], () => {
    const returned: object[] = [];
    const lasts: unknown[] = [];
    const source = {
      name: "read", label: "read", description: "probe", parameters: {}, execute() {},
      renderCall() { return component("call"); },
      renderResult(_result: unknown, _options: unknown, _theme: unknown, ctx: { lastComponent?: unknown }) {
        lasts.push(ctx.lastComponent);
        const next = { render: () => ["native"] };
        returned.push(next);
        return next;
      },
    };
    const tool = withDefaultCollapsedToolRendering(source as never) as unknown as RenderTool;
    const args = { path: "x" }; const state = {};
    tool.renderResult(readResult("one"), { expanded: false, isPartial: true }, theme, { args, state, isError: false });
    tool.renderResult(readResult("two"), { expanded: false, isPartial: true }, theme, { args, state, isError: false });
    expect(lasts[0]).toBeUndefined();
    expect(lasts[1]).toBe(returned[0]);

    const throwingTheme = { fg() { throw new Error("theme"); }, bold() { throw new Error("theme"); } };
    const themed = definition("read");
    const themedContext = contexts(args);
    themed.renderCall(args, throwingTheme, themedContext.call);
    const plainFallback = themed.renderResult(readResult("ok"), { expanded: false, isPartial: false }, throwingTheme, themedContext.result);
    for (const width of [80, 2]) {
      const lines = plainFallback.render(width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
      if (width === 80) expect(lines[0]).toContain("Read x · 1 line hidden");
    }
    const bad = withDefaultCollapsedToolRendering({ ...source, renderCall() { throw new Error("call"); } } as never) as unknown as RenderTool;
    expect(bad.renderCall(args, throwingTheme, { state: {}, isPartial: false }).render(20).join("\n")).toContain("Renderer failed");
    const renderBad = withDefaultCollapsedToolRendering({ ...source, renderCall: () => component("call"), renderResult: () => ({ render() { throw new Error("render"); } }) } as never) as unknown as RenderTool;
    const c = contexts(args); renderBad.renderCall(args, theme, c.call);
    expect(renderBad.renderResult(readResult("x"), { expanded: true, isPartial: false }, theme, c.result).render(20).join("\n")).toContain("Renderer failed");

    const tooMany = withDefaultCollapsedToolRendering({ ...source, renderCall: () => component("call"),
      renderResult: () => ({ render: () => Array.from({ length: 20_001 }, () => "line") }) } as never) as unknown as RenderTool;
    const capped = contexts(args); tooMany.renderCall(args, theme, capped.call);
    const output = tooMany.renderResult(readResult("x"), { expanded: true, isPartial: false }, theme, capped.result).render(100);
    expect(output.at(-1)).toContain("omitted");
  }));
});

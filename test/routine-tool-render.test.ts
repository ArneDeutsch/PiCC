import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  adaptedEditPreviewError,
  withRoutineToolRendering,
} from "../src/runtime/routine-tool-render.js";
import { wrapForSelfShell } from "../src/runtime/tool-shell.js";
import { formatToolDisplayName } from "../src/runtime/tool-display.js";
import { createWebFetchTool, createWebSearchTool } from "../src/runtime/tools/web-tools.js";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piTuiEntry = requireFromPi.resolve("@earendil-works/pi-tui");
const { Box: PiBox } = await import(pathToFileURL(piTuiEntry).href) as typeof import("@earendil-works/pi-tui");

interface Component {
  render(width: number): string[];
}

interface RenderTool {
  name: string;
  execute: unknown;
  renderCall(args: unknown, theme: unknown, context: unknown): Component;
  renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): Component;
}

const fetchArgs = { url: "https://example.test/start" };
const fetchResult = {
  content: [{ type: "text", text: "SECRET FETCH BODY" }],
  details: {
    url: fetchArgs.url,
    finalUrl: "https://redirect.test/final",
    status: 200,
    contentType: "text/html",
    truncated: true,
  },
};
const searchArgs = { query: "compact renderer", allowed_domains: ["example.test"] };
const searchResult = {
  content: [{ type: "text", text: "SECRET SEARCH TITLE\nSECRET SEARCH SNIPPET" }],
  details: { query: searchArgs.query, backend: "duckduckgo", resultCount: 0, truncated: true },
};
const skillArgs = { name: "deploy", arguments: "staging 1.2.3" };
const slashArgs = { command: "/deploy staging 1.2.3" };
const activationResult = {
  content: [{ type: "text", text: "SECRET INJECTED INSTRUCTION BODY" }],
  details: { skill: "deploy" },
};

function decorate(tool: ToolDefinition): RenderTool {
  return withRoutineToolRendering(tool) as unknown as RenderTool;
}

function renderResult(
  tool: RenderTool,
  args: unknown,
  result: unknown,
  extra: { expanded?: boolean; partial?: boolean; error?: boolean; theme?: unknown; width?: number } = {},
): string[] {
  return tool.renderResult(
    result,
    { expanded: extra.expanded ?? false, isPartial: extra.partial ?? false },
    extra.theme,
    { args, isPartial: extra.partial ?? false, isError: extra.error ?? false },
  ).render(extra.width ?? 120);
}

function expectBounded(lines: string[], width: number): void {
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

function renderRaw(
  tool: RenderTool,
  result: unknown,
  options: unknown,
  context: unknown,
  width = 120,
): string[] {
  return tool.renderResult(result, options, undefined, context).render(width);
}

describe("routine tool rendering decorator", () => {
  it("uses one result-owned command row for ordinary WebFetch/WebSearch success", () => {
    const cases = [
      [decorate(createWebFetchTool(() => ".")), fetchArgs, fetchResult, fetchArgs.url, "SECRET FETCH BODY"],
      [decorate(createWebSearchTool(() => ".")), searchArgs, searchResult, searchArgs.query, "SECRET SEARCH TITLE"],
    ] as const;
    for (const [tool, args, result, invocation, hidden] of cases) {
      expect(tool.renderCall(args, undefined, { args }).render(120)).toEqual([]);
      for (const expanded of [false, true]) {
        const lines = renderResult(tool, args, result, { expanded });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(formatToolDisplayName(tool.name));
        expect(lines[0]).toContain(invocation);
        expect(lines.join("\n")).not.toContain(hidden);
      }
    }
  });

  it("freezes path-bearing routine roots per invocation and falls back to context cwd", () => {
    const rootA = "/workspace/a";
    const rootB = "/workspace/b";
    let liveRoot = rootA;
    const args = { file_path: `${rootA}/src/file.ts`, edits: [{ old_string: "old", new_string: "new" }] };
    const result = {
      content: [{ type: "text", text: `Successfully applied 1 edit(s) to ${rootA}/src/file.ts.` }],
      details: { filePath: `${rootA}/src/file.ts`, edits: 1, created: false, diff: "-old\n+new", firstChangedLine: 1 },
    };
    const argsBefore = structuredClone(args);
    const resultBefore = structuredClone(result);
    const relativeEditDefinition = (cwd: string) => ({
      renderResult(_result: unknown, _options: unknown, _theme: unknown, context: unknown) {
        const detachedArgs = (context as { args: { path: string } }).args;
        const displayPath = path.posix.relative(cwd, detachedArgs.path);
        return { render: () => [`multi edit ${displayPath}`] };
      },
    });
    const tool = withRoutineToolRendering({ name: "MultiEdit" } as ToolDefinition, {
      resolveDisplayRoot: () => liveRoot,
      createEditDefinition: relativeEditDefinition,
    }) as unknown as RenderTool;
    const ctx = {
      args, state: {}, cwd: rootA, isPartial: false, isError: false,
      argsComplete: true, executionStarted: false,
    };
    expect(tool.renderCall(args, undefined, ctx).render(120).join(" ")).toContain("src/file.ts");
    liveRoot = rootB;
    const settled = tool.renderResult(result, { expanded: false, isPartial: false }, undefined, ctx).render(120);
    expect(settled).toEqual(["multi edit src/file.ts"]);
    expect(settled.join("\n")).not.toContain(rootA);
    expect(settled.join("\n")).not.toContain(rootB);
    expect(tool.renderCall(args, undefined, ctx).render(120).join(" ")).toContain("src/file.ts");
    expect(args).toEqual(argsBefore);
    expect(result).toEqual(resultBefore);

    const fallback = withRoutineToolRendering({ name: "MultiEdit" } as ToolDefinition, {
      resolveDisplayRoot: () => { throw new Error("resolver unavailable"); },
      createEditDefinition: relativeEditDefinition,
    }) as unknown as RenderTool;
    const fallbackCtx = {
      args, state: {}, cwd: rootA, isPartial: false, isError: false,
      argsComplete: true, executionStarted: false,
    };
    expect(fallback.renderCall(args, undefined, fallbackCtx).render(120).join(" ")).toContain("src/file.ts");
    const fallbackSettled = fallback
      .renderResult(result, { expanded: false, isPartial: false }, undefined, fallbackCtx)
      .render(120);
    expect(fallbackSettled).toEqual(["multi edit src/file.ts"]);
    expect(fallbackSettled.join("\n")).not.toContain(rootA);
    expect(fallbackSettled.join("\n")).not.toContain(rootB);
    expect(args).toEqual(argsBefore);
    expect(result).toEqual(resultBefore);
  });

  it("keeps incomplete routine roots ephemeral, then freezes them at argument completion", () => {
    let workspace = "/workspace/a";
    const resolver = vi.fn(() => workspace);
    const tool = withRoutineToolRendering({ name: "MultiEdit" } as ToolDefinition, {
      resolveDisplayRoot: resolver,
    }) as unknown as RenderTool;
    const args = Object.freeze({
      file_path: "/workspace/b/src/file.ts",
      edits: Object.freeze([{ old_string: "old", new_string: "new" }]),
    });
    const ctx = {
      args, state: {}, cwd: "/workspace/a", isPartial: true, isError: false,
      argsComplete: false, executionStarted: false,
    };
    expect(tool.renderCall(args, undefined, ctx).render(120).join(" ")).toContain("/workspace/b/src/file.ts");
    expect(resolver).not.toHaveBeenCalled();

    workspace = "/workspace/b";
    ctx.argsComplete = true;
    expect(tool.renderCall(args, undefined, ctx).render(120).join(" ")).toContain("src/file.ts");
    workspace = "/workspace/c";
    expect(tool.renderCall(args, undefined, ctx).render(120).join(" ")).toContain("src/file.ts");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(ctx.args).toBe(args);
  });

  it("uses workspace-first and marked repository fallback for worktree paths with frozen roots", () => {
    let workspace = "/repo/worktree";
    const resolver = vi.fn(() => workspace);
    const tool = withRoutineToolRendering({ name: "EnterWorktree" } as ToolDefinition, {
      resolveDisplayRoot: resolver,
      repositoryRoot: "/repo",
    }) as unknown as RenderTool;
    const args = { name: "shared" };
    const state = {};
    const ctx = { args, state, cwd: workspace, argsComplete: true, executionStarted: false, isError: false };
    tool.renderCall(args, undefined, ctx);
    workspace = "/future";
    const result = {
      content: [{ type: "text", text: "CANONICAL" }],
      details: {
        worktreePath: "/repo/shared", branch: "worktree-shared", created: true,
        seeded: [], previousUnlockAttempted: false,
      },
    };
    const row = tool.renderResult(result, { expanded: false, isPartial: false }, undefined, ctx).render(120).join(" ");
    expect(row).toContain("repo:shared");
    expect(row).not.toContain("/future");
    expect(resolver).toHaveBeenCalledTimes(1);

    for (const lifecycle of [{ argsComplete: true, executionStarted: true }, {}]) {
      const historicalResolver = vi.fn(() => "/mutable");
      const historical = withRoutineToolRendering({ name: "ExitWorktree" } as ToolDefinition, {
        resolveDisplayRoot: historicalResolver,
        repositoryRoot: "/repo",
      }) as unknown as RenderTool;
      const historicalResult = {
        content: [{ type: "text", text: "CANONICAL" }],
        details: { outcome: "none", restorePath: "/repo/history" },
      };
      const historyRow = historical.renderResult(
        historicalResult, { expanded: false, isPartial: false }, undefined,
        { args: { action: "remove" }, state: {}, cwd: "/repo/history", isError: false, ...lifecycle },
      ).render(120).join(" ");
      expect(historyRow).toContain("already at .");
      expect(historicalResolver).not.toHaveBeenCalled();
    }
  });

  it("styles worktree targets as primary while preserving exceptional evidence roles", () => {
    const calls: Array<{ slot: string; text: string }> = [];
    const theme = { fg(slot: string, text: string) { calls.push({ slot, text }); return text; } };
    const tool = decorate({ name: "ExitWorktree" } as ToolDefinition);
    const result = {
      content: [{ type: "text", text: "CANONICAL" }],
      details: {
        worktreePath: "/repo/wt", outcome: "removal-failed", restorePath: "/repo",
        ok: false, removed: false, orphaned: false, diagnostics: [], error: "locked",
      },
    };
    renderResult(tool, { action: "remove" }, result, { theme, width: 160 });
    expect(calls).toContainEqual({ slot: "accent", text: "/repo/wt" });
    expect(calls.some((call) => call.slot === "warning" && call.text.includes("locked"))).toBe(true);
    expect(calls.some((call) => call.slot === "muted" && call.text.includes("/repo"))).toBe(true);
  });

  it("uses semantic text for routine keywords and accent for invocation context", () => {
    const calls: Array<{ slot: string; text: string }> = [];
    const theme = {
      fg(slot: string, text: string) {
        calls.push({ slot, text });
        return text;
      },
    };
    const tool = decorate(createWebSearchTool(() => "."));
    renderResult(tool, searchArgs, searchResult, { theme });
    expect(calls).toContainEqual({ slot: "text", text: "web search" });
    expect(calls).toContainEqual({ slot: "accent", text: `“${searchArgs.query}”` });
    expect(calls).not.toContainEqual({ slot: "muted", text: "web search" });
  });

  it("compacts redirects, truncation, empty results, and backend fallback without suffixes", () => {
    const fetch = renderResult(decorate(createWebFetchTool(() => ".")), fetchArgs, fetchResult).join("\n");
    expect(fetch).toBe(`web fetch ${fetchArgs.url}`);
    expect(fetch).not.toContain("redirect.test");
    expect(fetch).not.toMatch(/trunc/i);

    const search = renderResult(decorate(createWebSearchTool(() => ".")), searchArgs, searchResult).join("\n");
    expect(search).toBe(`web search “${searchArgs.query}”`);
    expect(search).not.toMatch(/duck|result|trunc/i);
  });

  it("fails open for partial, error, malformed, mismatched, additional, and unfamiliar results", () => {
    const tool = decorate(createWebFetchTool(() => "."));
    const cases: Array<[unknown, Record<string, boolean>]> = [
      [fetchResult, { partial: true }],
      [fetchResult, { error: true }],
      [{ ...fetchResult, details: { ...fetchResult.details, url: "https://other.test" } }, {}],
      [{ ...fetchResult, content: [...fetchResult.content, { type: "text", text: "NOTICE" }] }, {}],
      [{ ...fetchResult, details: { ...fetchResult.details, future: true } }, {}],
      [{ ...fetchResult, future: true }, {}],
      [{ content: [{ type: "future", payload: "x" }], details: fetchResult.details }, {}],
    ];
    for (const [result, flags] of cases) {
      const text = renderResult(tool, fetchArgs, result, flags).join("\n");
      expect(text).not.toBe(`web fetch ${fetchArgs.url}`);
      expect(text.length).toBeGreaterThan(0);
      if (result === fetchResult || (result as typeof fetchResult).content?.[0]?.type === "text") {
        expect(text).toContain("SECRET FETCH BODY");
      } else {
        expect(text).toContain("Unfamiliar web fetch presentation format");
      }
    }
  });

  it("requires explicit own settled booleans before compacting", () => {
    const tool = decorate(createWebFetchTool(() => "."));
    const ordinaryOptions = { expanded: false, isPartial: false };
    const ordinaryContext = { args: fetchArgs, isError: false };
    const accessorCounts = { partial: 0, error: 0 };
    const accessorOptions = Object.defineProperty({ expanded: false }, "isPartial", {
      enumerable: true,
      get() { accessorCounts.partial++; throw new Error("must not read partial accessor"); },
    });
    const accessorContext = Object.defineProperty({ args: fetchArgs }, "isError", {
      enumerable: true,
      get() { accessorCounts.error++; throw new Error("must not read error accessor"); },
    });
    const cases: Array<[unknown, unknown]> = [
      [{ expanded: false }, ordinaryContext],
      [{ ...ordinaryOptions, isPartial: 0 }, ordinaryContext],
      [{ ...ordinaryOptions, isPartial: "false" }, ordinaryContext],
      [accessorOptions, ordinaryContext],
      [ordinaryOptions, { args: fetchArgs }],
      [ordinaryOptions, { ...ordinaryContext, isError: 0 }],
      [ordinaryOptions, { ...ordinaryContext, isError: "false" }],
      [ordinaryOptions, accessorContext],
    ];
    for (const [options, context] of cases) {
      expect(renderRaw(tool, fetchResult, options, context).join("\n")).toContain("SECRET FETCH BODY");
    }
    expect(accessorCounts).toEqual({ partial: 0, error: 0 });
  });

  it("fails WebSearch open for each unfamiliar argument and detail shape", () => {
    const tool = decorate(createWebSearchTool(() => "."));
    const cases: Array<[unknown, unknown]> = [
      [{ ...searchArgs, query: "different" }, searchResult],
      [{ ...searchArgs, future: true }, searchResult],
      [searchArgs, { ...searchResult, details: { ...searchResult.details, future: true } }],
      [searchArgs, { ...searchResult, content: [...searchResult.content, { type: "text", text: "extra" }] }],
      [{ query: searchArgs.query, allowed_domains: [3] }, searchResult],
      [{ query: searchArgs.query, blocked_domains: "example.test" }, searchResult],
      [searchArgs, { ...searchResult, details: { ...searchResult.details, backend: "future" } }],
      [searchArgs, { ...searchResult, details: { ...searchResult.details, resultCount: -1 } }],
      [searchArgs, { ...searchResult, details: { ...searchResult.details, resultCount: 1.5 } }],
      [searchArgs, { ...searchResult, details: { ...searchResult.details, resultCount: 9 } }],
      [
        { ...searchArgs, query: 7 },
        { ...searchResult, details: { ...searchResult.details, query: 7 } },
      ],
      [searchArgs, { ...searchResult, details: { ...searchResult.details, truncated: "false" } }],
      [searchArgs, { ...searchResult, details: { ...searchResult.details, resultCount: Number.NaN } }],
    ];
    for (const [args, result] of cases) {
      const text = renderResult(tool, args, result).join("\n");
      expect(text).toContain("SECRET SEARCH TITLE");
      expect(text).not.toBe(`web search “${searchArgs.query}”`);
    }
  });

  it("sanitizes terminal controls and line breaks before styling and measuring", () => {
    const escape = "\u001b";
    const bell = "\u0007";
    const args = { query: `${escape}[31mwide界${escape}[0m\nsecond${escape}]0;pwn${bell}` };
    const result = {
      content: [{ type: "text", text: "hidden" }],
      details: { query: args.query, backend: "brave", resultCount: 1, truncated: false },
    };
    const lines = renderResult(decorate(createWebSearchTool(() => ".")), args, result, { width: 18 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("wide");
    expect(lines[0]).not.toContain("[31m");
    expect(lines[0]).not.toContain("]0;pwn");
    expect(lines[0]).not.toMatch(/[\u0007\n\r]/u);
    expectBounded(lines, 18);
  });

  it("clamps safely at widths 0–2 and bounds fail-open canonical output", () => {
    const tool = decorate(createWebFetchTool(() => "."));
    for (const width of [0, 1, 2]) {
      const compact = renderResult(tool, fetchArgs, fetchResult, { width });
      expect(compact).toHaveLength(1);
      expectBounded(compact, width);
    }
    const long = {
      content: [{ type: "text", text: Array.from({ length: 100 }, (_, i) => `line-${i} ${"x".repeat(80)}`).join("\n") }],
      details: undefined,
    };
    const lines = renderResult(tool, fetchArgs, long, { error: true, width: 12 });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(16);
    expectBounded(lines, 12);
  });

  it("fails open when invocation sanitization leaves no truthful command argument", () => {
    const tool = decorate(createWebFetchTool(() => "."));
    const args = { url: "\u001b]0;hostile\u0007\n\u0000" };
    const result = {
      ...fetchResult,
      details: { ...fetchResult.details, url: args.url },
    };
    const text = renderResult(tool, args, result).join("\n");
    expect(text).toContain("Unfamiliar web fetch presentation format");
    expect(text).toContain("SECRET FETCH BODY");
    expect(text).not.toBe("WebFetch ");
  });

  it("bounds and sanitizes hostile fail-open canonical text at extreme widths", () => {
    const tool = decorate(createWebSearchTool(() => "."));
    const hostile = [
      "safe界🙂",
      "\u001b[31mred\u001b[0m",
      "\u001b]0;osc\u0007title",
      "line\nnext\r\u0000\u0008\u2028end",
      "x".repeat(3_950),
      "\u001b]8;;https://truncated.example/" + "y".repeat(20_000),
    ].join("|");
    const result = { content: [{ type: "text", text: hostile }], details: undefined };
    for (const width of [0, 1, 2, 11]) {
      const lines = renderResult(tool, searchArgs, result, { error: true, width });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(16);
      expectBounded(lines, width);
      const output = lines.join("\n");
      const withoutFrameworkCsi = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
      expect(withoutFrameworkCsi).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
      expect(withoutFrameworkCsi).not.toContain("[31m");
      expect(output).not.toContain("]0;osc");
      expect(output).not.toContain("truncated.example");
    }
  });

  it("bounds traversal when many canonical blocks sanitize to empty", () => {
    let descriptorCalls = 0;
    const blocks = new Proxy(
      Array.from({ length: 10_000 }, () => ({ type: "text", text: "\u0000" })),
      {
        getOwnPropertyDescriptor(target, key) {
          descriptorCalls++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const result = { content: blocks, details: undefined };
    const lines = renderResult(decorate(createWebSearchTool(() => ".")), searchArgs, result, {
      error: true,
      width: 12,
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("\u0000");
    expect(descriptorCalls).toBeLessThanOrEqual(4_100);
  });

  it("keeps recognized success compact when theme styling throws or returns malformed values", () => {
    const tool = decorate(createWebFetchTool(() => "."));
    const throwingTheme = new Proxy({}, { get() { throw new Error("theme unavailable"); } });
    const malformedTheme = { fg: () => ({ not: "text" }), bold: () => { throw new Error("bold"); } };
    for (const theme of [throwingTheme, malformedTheme]) {
      const text = renderResult(tool, fetchArgs, fetchResult, { theme }).join("\n");
      expect(text).toContain(fetchArgs.url);
      expect(text).not.toContain("SECRET FETCH BODY");
    }
  });

  it("does not invoke own accessors and rejects unsafe prototype/proxy surprises", () => {
    let getterCalls = 0;
    const accessorNamed = Object.defineProperty({}, "name", {
      enumerable: true,
      get() { getterCalls++; return "WebFetch"; },
    }) as ToolDefinition;
    expect(withRoutineToolRendering(accessorNamed)).toBe(accessorNamed);
    expect(getterCalls).toBe(0);

    const oddPrototype = Object.create({ inherited: true }) as ToolDefinition;
    Object.defineProperty(oddPrototype, "name", { value: "WebFetch", enumerable: true });
    expect(withRoutineToolRendering(oddPrototype)).toBe(oddPrototype);

    const target = { name: "WebFetch" } as ToolDefinition;
    const hostile = new Proxy(target, {
      getPrototypeOf() { throw new Error("no prototype"); },
      get() { throw new Error("no reads"); },
    });
    expect(withRoutineToolRendering(hostile)).toBe(hostile);
  });

  it("does not invoke nested accessors while failing unsafe shapes open", () => {
    const tool = decorate(createWebSearchTool(() => "."));
    let getterCalls = 0;
    const accessor = (target: object, key: string, value: unknown): object => Object.defineProperty(target, key, {
      enumerable: true,
      get() { getterCalls++; return value; },
    });
    const domainArray = ["example.test"];
    accessor(domainArray, "0", "example.test");
    const cases: Array<[unknown, unknown, string]> = [
      [accessor({ query: searchArgs.query }, "allowed_domains", ["example.test"]), searchResult, "SECRET SEARCH TITLE"],
      [accessor({ query: searchArgs.query }, "query", searchArgs.query), searchResult, "SECRET SEARCH TITLE"],
      [searchArgs, { ...searchResult, details: accessor({}, "query", searchArgs.query) }, "SECRET SEARCH TITLE"],
      [searchArgs, { ...searchResult, content: [accessor({ type: "text" }, "text", "secret")] }, "Unfamiliar web search presentation format"],
      [{ query: searchArgs.query, allowed_domains: domainArray }, searchResult, "SECRET SEARCH TITLE"],
    ];
    for (const [args, result, expected] of cases) {
      const output = renderResult(tool, args, result).join("\n");
      expect(output).toContain(expected);
      expect(output).not.toBe(`web search “${searchArgs.query}”`);
    }
    expect(getterCalls).toBe(0);
  });

  it("classifies nested transparent proxies through descriptors without property gets", () => {
    let propertyGets = 0;
    const noGet = <T extends object>(value: T): T => new Proxy(value, {
      get() { propertyGets++; throw new Error("property get forbidden"); },
    });
    const args = noGet({ query: searchArgs.query, allowed_domains: noGet(["example.test"]) });
    const result = {
      content: noGet([noGet({ type: "text", text: "SECRET SEARCH TITLE" })]),
      details: noGet({ ...searchResult.details }),
    };
    expect(renderResult(decorate(createWebSearchTool(() => ".")), args, result)).toEqual([
      `web search “${searchArgs.query}”`,
    ]);
    expect(propertyGets).toBe(0);
  });

  it("fails nested descriptor-hostile proxies open without property gets", () => {
    let propertyGets = 0;
    const hostile = <T extends object>(value: T): T => new Proxy(value, {
      get() { propertyGets++; throw new Error("property get forbidden"); },
      getOwnPropertyDescriptor() { throw new Error("descriptor unavailable"); },
    });
    const cases: Array<[unknown, unknown, string]> = [
      [hostile({ query: searchArgs.query }), searchResult, "SECRET SEARCH TITLE"],
      [searchArgs, { ...searchResult, details: hostile({ ...searchResult.details }) }, "SECRET SEARCH TITLE"],
      [searchArgs, { ...searchResult, content: [hostile({ type: "text", text: "secret" })] }, "Unfamiliar web search presentation format"],
      [{ query: searchArgs.query, allowed_domains: hostile(["example.test"]) }, searchResult, "SECRET SEARCH TITLE"],
    ];
    for (const [args, result, expected] of cases) {
      const output = renderResult(decorate(createWebSearchTool(() => ".")), args, result).join("\n");
      expect(output).toContain(expected);
      expect(output).not.toBe(`web search “${searchArgs.query}”`);
    }
    expect(propertyGets).toBe(0);
  });

  it("does not invoke result accessors and returns a visible bounded fallback", () => {
    let contentReads = 0;
    const result = Object.defineProperty({}, "content", {
      enumerable: true,
      get() { contentReads++; return fetchResult.content; },
    });
    const lines = renderResult(decorate(createWebFetchTool(() => ".")), fetchArgs, result);
    expect(contentReads).toBe(0);
    expect(lines.join("\n")).toContain("Unfamiliar web fetch presentation format");
  });

  it("hardens task-control primaries while preserving canonical args and native results", () => {
    for (const entry of [
      {
        name: "TaskCreate", args: { subject: "Implement\u001b[31m renderer\rnow", description: "detail" },
        primary: "Implement", metadata: [] as string[],
      },
      {
        name: "TaskUpdate", args: { taskId: "17\u001b]0;x\u0007", status: "completed" },
        primary: "17", metadata: ["completed"],
      },
      {
        name: "TaskGet", args: { taskId: "17\rhidden" },
        primary: "17 hidden", metadata: [] as string[],
      },
    ] as const) {
      const frozenArgs = Object.freeze(entry.args);
      const nativeResult = () => ({ render: () => ["native task detail"] });
      const execute = () => undefined;
      const source = { name: entry.name, execute, renderResult: nativeResult } as unknown as ToolDefinition;
      const tool = decorate(source);
      const calls: Array<{ slot: string; text: string }> = [];
      const theme = { fg(slot: string, text: string) { calls.push({ slot, text }); return text; } };
      const wideLine = tool.renderCall(frozenArgs, theme, { args: frozenArgs }).render(120).join(" ");
      expect(wideLine).toContain(entry.primary);
      expect(wideLine).not.toMatch(/[\r\u001b\u0007]/u);
      for (const metadata of entry.metadata) {
        expect(wideLine).toContain(metadata);
        expect(calls.some((call) => call.slot === "muted" && call.text.includes(metadata))).toBe(true);
      }
      const narrowLine = tool.renderCall(frozenArgs, theme, { args: frozenArgs }).render(22).join(" ");
      expect(narrowLine).toContain(entry.primary);
      expect(narrowLine).not.toContain("completed");
      expect(calls.some((call) => call.slot === "accent" && call.text.includes(entry.primary))).toBe(true);
      expect((tool as unknown as { renderResult: unknown }).renderResult).toBe(nativeResult);
      expect((tool as unknown as { execute: unknown }).execute).toBe(execute);
      expect(frozenArgs).toEqual(entry.args);
    }
    const generic = { name: "TaskList" } as ToolDefinition;
    expect(withRoutineToolRendering(generic)).toBe(generic);
  });

  it("renders ordinary Skill and slash command activations from snapshotted call arguments only", () => {
    const cases = [
      [decorate({ name: "Skill" } as ToolDefinition), skillArgs, "skill deploy — staging 1.2.3"],
      [decorate({ name: "SlashCommand" } as ToolDefinition), slashArgs, "slash command /deploy staging 1.2.3"],
    ] as const;
    for (const [tool, args, expected] of cases) {
      expect(tool.renderCall(args, undefined, { args }).render(80)).toEqual([]);
      for (const expanded of [false, true]) {
        const lines = renderResult(tool, args, activationResult, { expanded });
        expect(lines).toEqual([expected]);
        expect(lines.join("\n")).not.toContain("SECRET INJECTED");
      }
    }
  });

  it("renders no-argument Skill and slash command activations without a dangling separator or body", () => {
    const cases = [
      [decorate({ name: "Skill" } as ToolDefinition), { name: "deploy" }, "skill deploy"],
      [decorate({ name: "SlashCommand" } as ToolDefinition), { command: "/deploy" }, "slash command /deploy"],
    ] as const;
    for (const [tool, args, expected] of cases) {
      for (const expanded of [false, true]) {
        const lines = renderResult(tool, args, activationResult, { expanded });
        expect(lines).toEqual([expected]);
        expect(lines[0]).not.toContain("—");
        expect(lines[0]).not.toContain("SECRET INJECTED");
      }
    }
  });

  it("compacts only activation results whose canonical identity matches the invocation", () => {
    const compactCases: Array<[RenderTool, unknown, unknown, string]> = [
      [decorate({ name: "Skill" } as ToolDefinition), { name: "plugin:deploy" }, { ...activationResult, details: { skill: "plugin:deploy" } }, "skill plugin:deploy"],
      [decorate({ name: "Skill" } as ToolDefinition), { name: "deploy" }, { ...activationResult, details: { skill: "plugin:deploy" } }, "skill deploy"],
      [decorate({ name: "SlashCommand" } as ToolDefinition), { command: "/plugin:deploy now" }, { ...activationResult, details: { skill: "plugin:deploy" } }, "slash command /plugin:deploy now"],
      [decorate({ name: "SlashCommand" } as ToolDefinition), { command: "deploy now" }, { ...activationResult, details: { skill: "plugin:deploy" } }, "slash command deploy now"],
    ];
    for (const [tool, args, result, expected] of compactCases) {
      expect(renderResult(tool, args, result)).toEqual([expected]);
    }

    const visibleBody = "VISIBLE MISMATCHED ACTIVATION BODY";
    const mismatches: Array<[RenderTool, unknown]> = [
      [decorate({ name: "Skill" } as ToolDefinition), { name: "other" }],
      [decorate({ name: "SlashCommand" } as ToolDefinition), { command: "/other now" }],
      [decorate({ name: "SlashCommand" } as ToolDefinition), { command: "/deploy/invalid now" }],
    ];
    for (const [tool, args] of mismatches) {
      const result = { content: [{ type: "text", text: visibleBody }], details: { skill: "deploy" } };
      expect(renderResult(tool, args, result).join("\n")).toContain(visibleBody);
    }
  });

  it("keeps deduplicated, forked, partial, failed, additional, and unfamiliar activation outcomes visible", () => {
    const tool = decorate({ name: "Skill" } as ToolDefinition);
    const cases: Array<[unknown, Record<string, boolean>, string]> = [
      [{ content: [{ type: "text", text: "VISIBLE DEDUP NOTICE" }], details: { skill: "deploy", deduplicated: true } }, {}, "VISIBLE DEDUP NOTICE"],
      [{ content: [{ type: "text", text: "VISIBLE FORK OUTPUT" }], details: { forked: true, agent: "worker", cutOff: false } }, {}, "VISIBLE FORK OUTPUT"],
      [activationResult, { partial: true }, "SECRET INJECTED INSTRUCTION BODY"],
      [activationResult, { error: true }, "SECRET INJECTED INSTRUCTION BODY"],
      [{ ...activationResult, content: [...activationResult.content, { type: "text", text: "VISIBLE EXTRA" }] }, {}, "SECRET INJECTED INSTRUCTION BODY"],
      [{ ...activationResult, details: { skill: "deploy", future: true } }, {}, "SECRET INJECTED INSTRUCTION BODY"],
      [{ content: [{ type: "future", payload: "VISIBLE FUTURE" }], details: { skill: "deploy" } }, {}, "Unfamiliar skill presentation format"],
    ];
    for (const [result, flags, visible] of cases) {
      const text = renderResult(tool, skillArgs, result, flags).join("\n");
      expect(text).toContain(visible);
      expect(text).not.toBe("skill deploy — staging 1.2.3");
    }
  });

  it("sanitizes and clamps hostile activation fields across tiny and Unicode widths", () => {
    const escape = "\u001b";
    const args = {
      name: "deploy",
      arguments: `déploy界🙂${escape}[31mfirst\r\nsecond\u2028${escape}]0;pwn\u0007\u009b32mC1CSI\u009b0m\u009d0;C1OSC\u009c`,
    };
    const tool = decorate({ name: "Skill" } as ToolDefinition);
    for (const width of [0, 1, 2, 9, 80]) {
      const lines = renderResult(tool, args, activationResult, { width });
      expect(lines).toHaveLength(1);
      expectBounded(lines, width);
      expect(lines[0]).not.toMatch(/[\r\n\u2028\u0007\u009b\u009d\u009c]/u);
      expect(lines[0]).not.toContain("[31m");
      expect(lines[0]).not.toContain("]0;pwn");
      expect(lines[0]).not.toContain("32m");
      expect(lines[0]).not.toContain("C1OSC");
      expect(lines[0]).not.toContain("SECRET INJECTED");
    }
  });

  it("fails activation accessors, hostile descriptors, and non-exact shapes open without reads", () => {
    const tool = decorate({ name: "SlashCommand" } as ToolDefinition);
    let getterCalls = 0;
    const accessorArgs = Object.defineProperty({}, "command", {
      enumerable: true,
      get() { getterCalls++; return slashArgs.command; },
    });
    const hostileDetails = new Proxy({ skill: "deploy" }, {
      get() { getterCalls++; throw new Error("must not get"); },
      getOwnPropertyDescriptor() { throw new Error("no descriptors"); },
    });
    const cases: Array<[unknown, unknown, unknown]> = [
      [accessorArgs, activationResult, { expanded: false, isPartial: false }],
      [slashArgs, { ...activationResult, details: hostileDetails }, { expanded: false, isPartial: false }],
      [{ ...slashArgs, future: true }, activationResult, { expanded: false, isPartial: false }],
      [slashArgs, { ...activationResult, isError: "false" }, { expanded: false, isPartial: false }],
      [slashArgs, activationResult, { expanded: false }],
    ];
    for (const [args, result, options] of cases) {
      const text = renderRaw(tool, result, options, { args, isError: false }).join("\n");
      expect(text).toContain("SECRET INJECTED INSTRUCTION BODY");
      expect(text).not.toBe(`slash command ${slashArgs.command}`);
    }
    expect(getterCalls).toBe(0);
  });

  it("recognizes transparent activation proxies through descriptors without property gets", () => {
    let propertyGets = 0;
    const noGet = <T extends object>(value: T): T => new Proxy(value, {
      get() { propertyGets++; throw new Error("property get forbidden"); },
    });
    const args = noGet({ name: "部署", arguments: "é🙂" });
    const result = noGet({
      content: noGet([noGet({ type: "text", text: "PROXY SECRET BODY" })]),
      details: noGet({ skill: "部署" }),
    });
    const lines = renderResult(decorate({ name: "Skill" } as ToolDefinition), args, result, { width: 80 });
    expect(lines).toEqual(["skill 部署 — é🙂"]);
    expect(propertyGets).toBe(0);
  });

  it("keeps recognized activation success compact when inputs are frozen or styling degrades", () => {
    const tool = decorate({ name: "SlashCommand" } as ToolDefinition);
    const args = Object.freeze({ command: "/deploy é🙂" });
    const result = Object.freeze({
      content: Object.freeze([Object.freeze({ type: "text", text: "FROZEN SECRET BODY" })]),
      details: Object.freeze({ skill: "deploy" }),
    });
    const themes = [
      new Proxy({}, { get() { throw new Error("theme unavailable"); } }),
      { fg: () => ({ malformed: true }), bold: () => { throw new Error("bold unavailable"); } },
    ];
    for (const theme of themes) {
      const lines = renderResult(tool, args, result, { theme, width: 18 });
      expect(lines).toHaveLength(1);
      expectBounded(lines, 18);
      expect(lines.join("\n")).toContain("slash command");
      expect(lines.join("\n")).not.toContain("FROZEN SECRET BODY");
    }
  });

  it("threads Edit's inner call component through its adapter and removes only known edge padding", () => {
    const seen: unknown[] = [];
    const inners: Component[] = [];
    const source = {
      name: "edit",
      renderCall(_args: unknown, _theme: unknown, context: any) {
        seen.push(context.lastComponent);
        const inner = context.lastComponent ?? {
          render(width: number) { return [" ".repeat(width), "path", " ".repeat(width), "- old", "+ new", " ".repeat(width)]; },
        };
        inners.push(inner);
        return inner;
      },
      renderResult() { return { render: () => ["result"] }; },
    } as unknown as ToolDefinition;
    const tool = decorate(source);
    const first = tool.renderCall({}, undefined, {}).render(20);
    const firstWrapper = tool.renderCall({}, undefined, {}) as unknown as Component;
    const second = tool.renderCall({}, undefined, { lastComponent: firstWrapper }).render(20);
    expect(first).toEqual(["path", " ".repeat(20), "- old", "+ new"]);
    expect(second).toEqual(first);
    expect(seen[0]).toBeUndefined();
    expect(seen[2]).toBe(inners[1]);
    expect((tool as any).renderResult).toBe((source as any).renderResult);
  });

  it("neutralizes the exact retained Edit Box before every render without breaking identity evidence", () => {
    const stateBackgrounds = ["pending", "success", "error"];
    const box = Object.assign(new PiBox(0, 1, (text) => `pending:${text}`), {
      preview: { error: "preview refused" },
    });
    box.addChild({ render: () => ["path", "- old", "+ new"], invalidate() {} });
    const seen: unknown[] = [];
    const source = {
      name: "edit",
      renderCall(_args: unknown, _theme: unknown, context: { lastComponent?: unknown }) {
        seen.push(context.lastComponent);
        return context.lastComponent ?? box;
      },
      renderResult() { return { render: () => ["result"] }; },
    } as unknown as ToolDefinition;
    const tool = decorate(source);
    const adapted = tool.renderCall({}, undefined, {});
    const setBgFn = vi.spyOn(box, "setBgFn");

    for (const state of stateBackgrounds) {
      box.setBgFn((text) => `${state}:${text}`);
      expect(adapted.render(20).map((line) => line.trimEnd())).toEqual(["path", "- old", "+ new"]);
    }
    const neutralizers = setBgFn.mock.calls
      .map(([background]) => background)
      .filter((background) => !stateBackgrounds.some((state) => background?.("") === `${state}:`));
    expect(neutralizers).toHaveLength(3);
    expect(new Set(neutralizers).size).toBe(1);
    expect(adaptedEditPreviewError(adapted)).toBe("preview refused");

    const reused = tool.renderCall({}, undefined, { lastComponent: adapted });
    expect(seen).toEqual([undefined, box]);
    expect(reused.render(20).map((line) => line.trimEnd())).toEqual(["path", "- old", "+ new"]);
    expect(adaptedEditPreviewError(reused)).toBe("preview refused");
  });

  it("does not treat Box-like objects as public Edit Boxes", () => {
    const setBgFn = vi.fn();
    const boxLike = {
      setBgFn,
      render: (width: number) => [" ".repeat(width), "path", " ".repeat(width)],
    };
    const tool = decorate({
      name: "edit",
      renderCall: () => boxLike,
    } as unknown as ToolDefinition);
    expect(tool.renderCall({}, undefined, {}).render(8)).toEqual(["path"]);
    expect(setBgFn).not.toHaveBeenCalled();
  });

  it("keeps Edit edge rows unless both are exactly the known full-width padding", () => {
    const renderWith = (lines: (width: number) => string[]) => {
      const tool = decorate({
        name: "edit",
        renderCall: () => ({ render: lines }),
      } as unknown as ToolDefinition);
      return tool.renderCall({}, undefined, {}).render(8);
    };
    expect(renderWith((width) => [" ".repeat(width), "path", " ".repeat(width)])).toEqual(["path"]);
    expect(renderWith((width) => [" ".repeat(width - 1), "path", " ".repeat(width)])).toEqual([
      " ".repeat(7), "path", " ".repeat(8),
    ]);
    expect(renderWith((width) => [" ".repeat(width), "path", " ".repeat(width - 1)])).toEqual([
      " ".repeat(8), "path", " ".repeat(7),
    ]);
    expect(renderWith((width) => ["x".repeat(width), "path", " ".repeat(width)])).toEqual([
      "x".repeat(8), "path", " ".repeat(8),
    ]);
    expect(renderWith((width) => [" ".repeat(width), "path", " ".repeat(width), "diff", " ".repeat(width)])).toEqual([
      "path", " ".repeat(8), "diff",
    ]);
  });

  it("keeps non-live Edit state, result context, and result component transparent", () => {
    const resolver = vi.fn(() => path.resolve("must-not-be-used"));
    const callContexts: unknown[] = [];
    const resultContexts: unknown[] = [];
    const resultComponent = { render: () => ["native result"] };
    const source = {
      name: "edit",
      renderCall(_args: unknown, _theme: unknown, context: unknown) {
        callContexts.push(context);
        return { render: () => ["native call"] };
      },
      renderResult(_result: unknown, _options: unknown, _theme: unknown, context: unknown) {
        resultContexts.push(context);
        return resultComponent;
      },
    } as unknown as ToolDefinition;
    const tool = withRoutineToolRendering(source, { resolveEditRenderCwd: resolver }) as unknown as RenderTool;
    const state = { nativeState: true };
    const historyContext = {
      state,
      cwd: path.resolve("history-cwd"),
      argsComplete: false,
      executionStarted: false,
    };

    tool.renderCall({}, undefined, historyContext);
    const historyResult = tool.renderResult({}, { expanded: false, isPartial: false }, undefined, historyContext);
    const directContext = {
      state: { htmlState: true },
      cwd: path.resolve("html-cwd"),
      argsComplete: true,
      executionStarted: false,
    };
    const directResult = tool.renderResult({}, { expanded: true, isPartial: false }, undefined, directContext);

    expect((callContexts[0] as { state: unknown }).state).toBe(state);
    expect(resultContexts).toHaveLength(2);
    expect(resultContexts[0]).toBe(historyContext);
    expect(resultContexts[1]).toBe(directContext);
    expect(historyResult).toBe(resultComponent);
    expect(directResult).toBe(resultComponent);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("binds a live Edit row at args completion and freezes the same cwd across repeated redraws", () => {
    const worktreeCwd = path.resolve("effective-worktree");
    const futureCwds = [
      worktreeCwd,
      worktreeCwd,
      path.resolve("future-preview-redraw"),
      path.resolve("future-execution-redraw"),
      path.resolve("future-result-redraw"),
    ];
    const launchCwd = path.resolve("launch-base");
    const resolver = vi.fn(() => futureCwds.shift());
    const callContexts: any[] = [];
    const callComponents: any[] = [];
    const resultContexts: any[] = [];
    const source = {
      name: "edit",
      renderCall(_args: unknown, _theme: unknown, context: any) {
        callContexts.push(context);
        const component = context.lastComponent ?? { render: () => [String(context.cwd)] };
        callComponents.push(component);
        return component;
      },
      renderResult(_result: unknown, _options: unknown, _theme: unknown, context: any) {
        resultContexts.push(context);
        return { render: () => [String(context.cwd)] };
      },
    } as unknown as ToolDefinition;
    const tool = withRoutineToolRendering(source, { resolveEditRenderCwd: resolver }) as unknown as RenderTool;
    const state = {};
    const base = {
      args: { path: "same.txt", edits: [{ oldText: "a", newText: "b" }] },
      state,
      cwd: launchCwd,
      marker: { preserved: true },
      argsComplete: false,
      executionStarted: false,
    };

    const initial = tool.renderCall(base.args, undefined, base);
    const completeContext = { ...base, argsComplete: true, lastComponent: initial };
    const completed = tool.renderCall(base.args, undefined, completeContext);
    const completedRedraw = tool.renderCall(base.args, undefined, { ...completeContext, lastComponent: completed });
    const executionContext = {
      ...completeContext,
      executionStarted: true,
      lastComponent: completedRedraw,
    };
    const executing = tool.renderCall(base.args, undefined, executionContext);
    const executionRedrawContext = { ...executionContext, lastComponent: executing };
    tool.renderCall(base.args, undefined, executionRedrawContext);
    tool.renderResult({}, { expanded: false, isPartial: false }, undefined, executionRedrawContext);
    tool.renderResult({}, { expanded: true, isPartial: false }, undefined, executionRedrawContext);

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(futureCwds).toHaveLength(3);
    expect(callContexts.map(({ cwd, argsComplete, executionStarted }) => ({ cwd, argsComplete, executionStarted })))
      .toEqual([
        { cwd: launchCwd, argsComplete: false, executionStarted: false },
        { cwd: worktreeCwd, argsComplete: true, executionStarted: false },
        { cwd: worktreeCwd, argsComplete: true, executionStarted: false },
        { cwd: worktreeCwd, argsComplete: true, executionStarted: true },
        { cwd: worktreeCwd, argsComplete: true, executionStarted: true },
      ]);
    expect(callContexts.every(({ state: delegatedState }) => delegatedState === state)).toBe(true);
    expect(callComponents.slice(1).every((component) => component === callComponents[1])).toBe(true);
    expect(callContexts.slice(1).every(({ marker }) => marker === base.marker)).toBe(true);
    expect(resultContexts).toHaveLength(2);
    expect(resultContexts.every(({ cwd }) => cwd === worktreeCwd)).toBe(true);
    expect(resultContexts.every(({ state: resultState }) => resultState === callContexts[1].state)).toBe(true);
    expect(base).toEqual(expect.objectContaining({ cwd: launchCwd, argsComplete: false, state }));
  });

  it("rotates a stale Edit preview generation at execution start and detaches late completion", () => {
    const checkoutA = path.resolve("checkout-a");
    const checkoutB = path.resolve("checkout-b");
    const resolver = vi.fn()
      .mockReturnValueOnce(checkoutA)
      .mockReturnValueOnce(checkoutB);
    const generations: Array<{ text: string }> = [];
    const contexts: any[] = [];
    const source = {
      name: "edit",
      renderCall(_args: unknown, _theme: unknown, context: any) {
        contexts.push(context);
        const generation = (context.state.generation ??= { text: `generation-${generations.length + 1}` });
        if (!generations.includes(generation)) generations.push(generation);
        return context.lastComponent ?? { render: () => [generation.text] };
      },
      renderResult(_result: unknown, _options: unknown, _theme: unknown, context: any) {
        context.state.generation.text = "authoritative-result";
        return { render: () => [context.state.generation.text] };
      },
    } as unknown as ToolDefinition;
    const tool = withRoutineToolRendering(source, { resolveEditRenderCwd: resolver }) as unknown as RenderTool;
    const state = {};
    const args = { path: "target.txt", edits: [{ oldText: "old", newText: "new" }] };
    const initialContext = { args, state, cwd: "/launch", argsComplete: false, executionStarted: false };
    const initial = tool.renderCall(args, undefined, initialContext);
    const preview = tool.renderCall(args, undefined, {
      ...initialContext, argsComplete: true, lastComponent: initial,
    });
    const executionContext = {
      ...initialContext, argsComplete: true, executionStarted: true, lastComponent: preview,
    };
    const execution = tool.renderCall(args, undefined, executionContext);

    expect(generations).toHaveLength(2);
    expect(contexts[2]).toEqual(expect.objectContaining({ cwd: checkoutB, argsComplete: false }));
    expect(contexts[2].lastComponent).toBeUndefined();
    generations[0]!.text = "OBSOLETE LATE PREVIEW";
    expect(execution.render(80)).toEqual(["generation-2"]);
    expect(execution.render(80)).not.toContain("OBSOLETE LATE PREVIEW");
    expect(tool.renderResult({}, { expanded: false, isPartial: false }, undefined, executionContext).render(80))
      .toEqual(["authoritative-result"]);
    expect(contexts[2].cwd).toBe(checkoutB);
  });

  it("rotates an Edit preview when execution-start cwd revalidation becomes unusable", () => {
    const checkout = path.resolve("preview-checkout");
    const resolver = vi.fn().mockReturnValueOnce(checkout).mockReturnValueOnce(undefined);
    const contexts: any[] = [];
    const tool = withRoutineToolRendering({
      name: "edit",
      renderCall(_args: unknown, _theme: unknown, context: any) {
        contexts.push(context);
        return context.lastComponent ?? { render: () => [String(context.cwd)] };
      },
    } as unknown as ToolDefinition, { resolveEditRenderCwd: resolver }) as unknown as RenderTool;
    const state = {};
    const initialContext = {
      state, cwd: path.resolve("launch"), argsComplete: false, executionStarted: false,
    };
    const initial = tool.renderCall({}, undefined, initialContext);
    const preview = tool.renderCall({}, undefined, {
      ...initialContext, argsComplete: true, lastComponent: initial,
    });
    tool.renderCall({}, undefined, {
      ...initialContext, argsComplete: true, executionStarted: true, lastComponent: preview,
    });
    expect(contexts[2]).toEqual(expect.objectContaining({
      cwd: initialContext.cwd,
      argsComplete: false,
      lastComponent: undefined,
    }));
    expect(contexts[2].state).not.toBe(contexts[1].state);
  });

  it("suppresses speculative Edit preview for unusable cwd resolution and isolates concurrent rows", () => {
    const unusable = [undefined, 7, "", "relative/path", () => { throw new Error("cwd unavailable"); }];
    for (const candidate of unusable) {
      const seen: any[] = [];
      const resolver = vi.fn(() => typeof candidate === "function" ? candidate() : candidate);
      const tool = withRoutineToolRendering({
        name: "edit",
        renderCall(_args: unknown, _theme: unknown, context: any) {
          seen.push(context);
          return { render: () => ["visible edit invocation"] };
        },
      } as unknown as ToolDefinition, { resolveEditRenderCwd: resolver }) as unknown as RenderTool;
      const state = {};
      const context = { state, cwd: "/launch", argsComplete: false, executionStarted: false };
      tool.renderCall({}, undefined, context);
      expect(tool.renderCall({}, undefined, { ...context, argsComplete: true }).render(80))
        .toEqual(["visible edit invocation"]);
      expect(seen[1]).toEqual(expect.objectContaining({ cwd: "/launch", argsComplete: false }));
      expect(resolver).toHaveBeenCalledTimes(1);
    }

    const calls: any[] = [];
    const rowA = path.resolve("row-a");
    const rowB = path.resolve("row-b");
    const cwdByRow = [rowA, rowB];
    const tool = withRoutineToolRendering({
      name: "edit",
      renderCall(_args: unknown, _theme: unknown, context: any) {
        calls.push(context);
        return { render: () => [String(context.cwd)] };
      },
    } as unknown as ToolDefinition, {
      resolveEditRenderCwd: () => cwdByRow.shift(),
    }) as unknown as RenderTool;
    const first = { state: {}, cwd: "/launch", argsComplete: false, executionStarted: false };
    const second = { state: {}, cwd: "/launch", argsComplete: false, executionStarted: false };
    tool.renderCall({}, undefined, first);
    tool.renderCall({}, undefined, second);
    tool.renderCall({}, undefined, { ...first, argsComplete: true });
    tool.renderCall({}, undefined, { ...second, argsComplete: true });
    expect(calls[2].cwd).toBe(rowA);
    expect(calls[3].cwd).toBe(rowB);
    expect(calls[2].state).not.toBe(calls[3].state);
  });

  it("does not consult the live Edit cwd resolver for non-Edit tools or MultiEdit", () => {
    const resolver = vi.fn(() => path.resolve("must-not-be-used"));
    const web = withRoutineToolRendering(createWebFetchTool(() => "."), {
      resolveEditRenderCwd: resolver,
    }) as unknown as RenderTool;
    web.renderCall(fetchArgs, undefined, {
      state: {}, cwd: path.resolve("launch"), argsComplete: true, executionStarted: false,
    });
    renderResult(web, fetchArgs, fetchResult);

    const multi = withRoutineToolRendering({ name: "MultiEdit" } as ToolDefinition, {
      resolveEditRenderCwd: resolver,
      createEditDefinition: () => ({ renderResult: () => ({ render: () => ["diff"] }) }),
    }) as unknown as RenderTool;
    multi.renderCall({ file_path: "x", edits: [] }, undefined, {
      state: {}, cwd: path.resolve("launch"), argsComplete: true, executionStarted: false,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("leaves Edit rendering unchanged when no live-cwd dependency is supplied", () => {
    const contexts: any[] = [];
    const source = {
      name: "edit",
      renderCall(_args: unknown, _theme: unknown, context: any) {
        contexts.push(context);
        return { render: () => ["native"] };
      },
      renderResult() { return { render: () => ["result"] }; },
    } as unknown as ToolDefinition;
    const tool = withRoutineToolRendering(source) as unknown as RenderTool;
    const state = {};
    const context = { state, cwd: "/native", argsComplete: true, executionStarted: false };
    tool.renderCall({}, undefined, context);
    expect(contexts[0]).toEqual(expect.objectContaining(context));
    expect(contexts[0].state).toBe(state);
    expect((tool as any).renderResult).toBe((source as any).renderResult);
  });

  it("delegates validated MultiEdit evidence once to a detached Edit result DTO without preview", () => {
    const args = Object.freeze({
      file_path: "src/hostile\u001b[31m.ts",
      edits: Object.freeze([Object.freeze({ old_string: "old", new_string: "new" })]),
    });
    const result = Object.freeze({
      content: Object.freeze([Object.freeze({
        type: "text",
        text: "Successfully applied 1 edit(s) to src/hostile\u001b[31m.ts.",
      })]),
      details: Object.freeze({
        filePath: "src/hostile\u001b[31m.ts",
        edits: 1,
        created: false,
        diff: " 1 old\n\u001b[31m-1 old\u001b[0m\n+1 new",
        firstChangedLine: 1,
      }),
    });
    const preview = vi.fn();
    const seen: unknown[][] = [];
    const resultRenderer = vi.fn((...values: unknown[]) => {
      seen.push(values);
      return { render: () => ["SENTINEL EDIT DIFF"] };
    });
    const tool = withRoutineToolRendering(
      { name: "MultiEdit" } as ToolDefinition,
      { createEditDefinition: () => ({ renderCall: preview, renderResult: resultRenderer }) },
    ) as unknown as RenderTool;

    expect(tool.renderCall(args, undefined, { args }).render(80)[0]).toContain("src/hostile");
    expect(tool.renderCall(args, undefined, { args }).render(80).join("\n")).not.toContain("[31m");
    expect(renderResult(tool, args, result)).toEqual(["SENTINEL EDIT DIFF"]);
    expect(preview).not.toHaveBeenCalled();
    expect(resultRenderer).toHaveBeenCalledTimes(1);
    const [dto, delegatedOptions, , delegatedContext] = seen[0] as any[];
    expect(dto).not.toBe(result);
    expect(dto.details).not.toBe(result.details);
    expect(dto.content).not.toBe(result.content);
    expect(dto.details.diff).toBe(" 1 old\n�-1 old�\n+1 new");
    expect(delegatedOptions).toEqual({ expanded: false, isPartial: false });
    expect(delegatedContext.args).toEqual({ path: "src/hostile�.ts", edits: [] });
    expect(delegatedContext.args).not.toBe(args);
    expect(delegatedContext.state).toEqual({});
  });

  it("recognizes transparent MultiEdit proxies through data descriptors without property gets", () => {
    let propertyGets = 0;
    const noGet = <T extends object>(value: T): T => new Proxy(value, {
      get() { propertyGets++; throw new Error("property get forbidden"); },
    });
    const args = noGet({
      file_path: "proxy.ts",
      edits: noGet([noGet({ old_string: "a", new_string: "b" })]),
    });
    const result = noGet({
      content: noGet([noGet({ type: "text", text: "Successfully applied 1 edit(s) to proxy.ts." })]),
      details: noGet({
        filePath: "proxy.ts", edits: 1, created: false, diff: "-1 a\n+1 b", firstChangedLine: 1,
      }),
    });
    const tool = withRoutineToolRendering(
      { name: "MultiEdit" } as ToolDefinition,
      { createEditDefinition: () => ({ renderResult: () => ({ render: () => ["PROXY DIFF"] }) }) },
    ) as unknown as RenderTool;
    expect(renderResult(tool, args, result)).toEqual(["PROXY DIFF"]);
    expect(propertyGets).toBe(0);
  });

  it("renders real Pi MultiEdit combined diff, non-empty creation, and no-net-change truthfully", () => {
    initTheme();
    const tool = decorate({ name: "MultiEdit" } as ToolDefinition);
    const args = {
      file_path: "src/example.ts",
      edits: [{ old_string: "old", new_string: "middle" }, { old_string: "middle", new_string: "new" }],
    };
    const ordinary = {
      content: [{ type: "text", text: "Successfully applied 2 edit(s) to src/example.ts." }],
      details: { filePath: "src/example.ts", edits: 2, created: false, diff: "-1 old\n+1 new", firstChangedLine: 1 },
    };
    const lines = renderResult(tool, args, ordinary, { width: 80 });
    expect(lines.join("\n")).toContain("old");
    expect(lines.join("\n")).toContain("new");
    expect(lines.join("\n").match(/-1 old/g)).toHaveLength(1);

    const creationArgs = { file_path: "new.ts", edits: [{ old_string: "", new_string: "hello" }] };
    const creation = {
      content: [{ type: "text", text: "Created new.ts with 1 edit(s)." }],
      details: { filePath: "new.ts", edits: 1, created: true, diff: "+1 hello", firstChangedLine: 1 },
    };
    expect(renderResult(tool, creationArgs, creation).join("\n")).toContain("hello");

    const noNet = {
      content: [{ type: "text", text: "Successfully applied 2 edit(s) to src/example.ts." }],
      details: { filePath: "src/example.ts", edits: 2, created: false, diff: "", firstChangedLine: undefined },
    };
    expect(renderResult(tool, args, noNet)).toEqual(["No net change (2 edits applied)"]);
  });

  it("sanitizes MultiEdit path/diff payloads while preserving diff newlines at narrow Unicode widths", () => {
    initTheme();
    const rawPath = "src/界🙂\u001b]0;pwn\u0007.ts";
    const args = { file_path: rawPath, edits: [{ old_string: "界", new_string: "🙂" }] };
    const result = {
      content: [{ type: "text", text: `Successfully applied 1 edit(s) to ${rawPath}.` }],
      details: {
        filePath: rawPath,
        edits: 1,
        created: false,
        diff: " 1 context\n\u001b[31m-2 界\u001b[0m\n+2 🙂",
        firstChangedLine: 2,
      },
    };
    const tool = wrapForSelfShell(
      withRoutineToolRendering({ name: "MultiEdit" } as ToolDefinition) as unknown as Record<string, unknown>,
    ) as unknown as RenderTool;
    const normal = renderResult(tool, args, result, { width: 80 }).join("\n");
    expect(normal).toContain("界");
    expect(normal).toContain("🙂");
    expect(normal).not.toContain("]0;pwn");
    expect(normal).not.toContain("[31m");
    for (const width of [1, 2, 7, 12]) {
      const lines = renderResult(tool, args, result, { width });
      expect(lines.length).toBeGreaterThan(0);
      expectBounded(lines, width);
    }
  });

  it("replaces mutation controls visibly without letting malformed sequences consume later diff rows", () => {
    const rawPath = "\u001b]0;only-path\u0007";
    const args = { file_path: rawPath, edits: [{ old_string: "a", new_string: "b" }] };
    const result = {
      content: [{ type: "text", text: `Successfully applied 1 edit(s) to ${rawPath}.` }],
      details: {
        filePath: rawPath,
        edits: 1,
        created: false,
        diff: "-1 \u001b]terminated\u0007\n+2 later\n-3 \u001b]unterminated\n+4 survives\n-5 \u001b[31;\n+6 also survives",
        firstChangedLine: 1,
      },
    };
    const seen: unknown[] = [];
    const trusted = "\u001b[35mTRUSTED PI STYLE\u001b[0m";
    const tool = withRoutineToolRendering(
      { name: "MultiEdit" } as ToolDefinition,
      { createEditDefinition: () => ({
        renderResult(dto) {
          seen.push(dto);
          return { render: () => [trusted] };
        },
      }) },
    ) as unknown as RenderTool;
    expect(tool.renderCall(args, undefined, { args }).render(80).join("\n")).toContain("multi edit �");
    expect(renderResult(tool, args, result)).toEqual([trusted]);
    const dto = seen[0] as { details: { diff: string }; content: Array<{ text: string }> };
    expect(dto.details.diff.split("\n")).toEqual([
      "-1 �", "+2 later", "-3 �", "+4 survives", "-5 �", "+6 also survives",
    ]);
    expect(dto.content[0]?.text).toContain("to �.");
    expect(dto.details.diff).not.toContain("terminated");
  });

  it("bounds oversized MultiEdit successes before edit traversal or Pi delegation", () => {
    const renderer = vi.fn(() => ({ render: () => ["MUST NOT DELEGATE"] }));
    const tool = withRoutineToolRendering(
      { name: "MultiEdit" } as ToolDefinition,
      { createEditDefinition: () => ({ renderResult: renderer }) },
    ) as unknown as RenderTool;
    const cases = [
      {
        path: "count.ts",
        edits: new Array(1_001),
        count: 1_001,
        diff: "-1 a\n+1 b",
      },
      {
        path: "diff.ts",
        edits: [{ old_string: "a", new_string: "b" }],
        count: 1,
        diff: "-1 " + "x".repeat(1_000_001),
      },
      {
        path: "p".repeat(16_385),
        edits: [{ old_string: "a", new_string: "b" }],
        count: 1,
        diff: "-1 a\n+1 b",
      },
    ] as const;
    for (const entry of cases) {
      let indexedReads = 0;
      const edits = new Proxy(entry.edits, {
        getOwnPropertyDescriptor(target, key) {
          if (key !== "length") indexedReads++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      const args = Object.freeze({ file_path: entry.path, edits });
      const canonicalText = `Successfully applied ${entry.count} edit(s) to ${entry.path}.`;
      const result = Object.freeze({
        content: Object.freeze([Object.freeze({ type: "text", text: canonicalText })]),
        details: Object.freeze({
          filePath: entry.path,
          edits: entry.count,
          created: false,
          diff: entry.diff,
          firstChangedLine: 1,
        }),
      });
      const output = renderResult(tool, args, result, { width: 120 }).join("\n");
      expect(output).toContain("Diff too large to display for");
      expect(output).toContain(entry.path.slice(0, Math.min(entry.path.length, 20)));
      expect(indexedReads).toBe(0);
      expect(result.content[0]?.text).toBe(canonicalText);
    }
    expect(renderer).not.toHaveBeenCalled();
  });

  it("fails MultiEdit open for errors, partial/malformed/contradictory shapes and guarded renderer failures", () => {
    const args = { file_path: "x.ts", edits: [{ old_string: "a", new_string: "b" }] };
    const result = {
      content: [{ type: "text", text: "Successfully applied 1 edit(s) to x.ts." }],
      details: { filePath: "x.ts", edits: 1, created: false, diff: "-1 a\n+1 b", firstChangedLine: 1 },
    };
    const delegated = vi.fn(() => ({ render: () => ["UNEXPECTED DELEGATION"] }));
    const tool = withRoutineToolRendering(
      { name: "MultiEdit" } as ToolDefinition,
      { createEditDefinition: () => ({ renderResult: delegated }) },
    ) as unknown as RenderTool;
    for (const [candidateArgs, candidate, flags] of [
      [args, result, { partial: true }],
      [args, result, { error: true }],
      [args, { ...result, details: { ...result.details, filePath: "other.ts" } }, {}],
      [args, { ...result, details: { ...result.details, edits: 2 } }, {}],
      [{ ...args, edits: [{ old_string: "a" }] }, result, {}],
      [{ ...args, edits: [{ old_string: "a", new_string: "b", replace_all: "yes" }] }, result, {}],
      [args, { ...result, details: { ...result.details, firstChangedLine: 0 } }, {}],
      [args, { ...result, details: { ...result.details, firstChangedLine: 1.5 } }, {}],
      [args, { ...result, details: { filePath: "x.ts", edits: 1, created: false, firstChangedLine: 1 } }, {}],
      [args, { ...result, details: { ...result.details, created: true, diff: "", firstChangedLine: undefined } }, {}],
      [args, { ...result, details: { ...result.details, future: true } }, {}],
      [args, { ...result, content: [{ type: "text", text: "MISMATCHED CANONICAL" }] }, {}],
    ] as const) {
      const canonical = (candidate as any).content[0].text as string;
      const output = renderResult(tool, candidateArgs, candidate, flags).join("\n");
      expect(output).toContain(canonical);
      expect(output).not.toContain("SENTINEL EDIT DIFF");
    }

    let accessorReads = 0;
    const accessorDetails = Object.defineProperty({}, "diff", {
      enumerable: true,
      get() { accessorReads++; return result.details.diff; },
    });
    expect(renderResult(tool, args, { ...result, details: accessorDetails }).join("\n")).toContain(
      result.content[0]!.text,
    );
    expect(accessorReads).toBe(0);
    expect(delegated).not.toHaveBeenCalled();

    const throwing = withRoutineToolRendering(
      { name: "MultiEdit" } as ToolDefinition,
      { createEditDefinition: () => ({ renderResult: () => ({ render() { throw new Error("paint"); } }) }) },
    ) as unknown as RenderTool;
    expect(renderResult(throwing, args, result).join("\n")).toContain(result.content[0]!.text);
  });

  it("renders every recognized worktree lifecycle outcome as the confirmed exact row", () => {
    const canonical = (text: string, details: Record<string, unknown>) => ({
      content: [{ type: "text", text }],
      details,
    });
    const enter = decorate({ name: "EnterWorktree" } as ToolDefinition);
    const enterCases = [
      [
        { name: "a" },
        { worktreePath: "/repo/wt", branch: "worktree-a", created: true, seeded: [], previousUnlockAttempted: false },
        "enter worktree(/repo/wt) on branch worktree-a",
      ],
      [
        { path: "/repo/wt" },
        { worktreePath: "/repo/wt", branch: "worktree-a", created: false, seeded: [], previousUnlockAttempted: false },
        "enter worktree(/repo/wt) on branch worktree-a",
      ],
      [
        { name: "a" },
        {
          worktreePath: "/repo/wt", branch: "worktree-a", created: true,
          seeded: ["a", "b"], previousUnlockAttempted: false,
        },
        "enter worktree(/repo/wt) on branch worktree-a; seeded 2 files",
      ],
      [
        { name: "a" },
        {
          worktreePath: "/repo/wt", branch: "worktree-a", created: true,
          seeded: [], previousUnlockAttempted: true, previousWorktreePath: "/repo/old",
          previousKeepOutcome: "kept",
        },
        "enter worktree(/repo/wt) on branch worktree-a; previous /repo/old kept; unlock attempted",
      ],
      [
        { name: "a" },
        {
          worktreePath: "/repo/wt", branch: "worktree-a", created: true,
          seeded: ["a", "b"], previousUnlockAttempted: true, previousWorktreePath: "/repo/old",
          previousKeepOutcome: "kept",
        },
        "enter worktree(/repo/wt) on branch worktree-a; seeded 2 files; previous /repo/old kept; unlock attempted",
      ],
      [
        { name: "a" },
        {
          worktreePath: "/repo/wt", branch: "worktree-a", created: true,
          seeded: [], previousUnlockAttempted: true, previousWorktreePath: "/repo/old",
          previousKeepOutcome: "keep-failed", previousKeepError: "unlock denied",
        },
        "enter worktree(/repo/wt) on branch worktree-a; previous /repo/old keep failed: unlock denied; previous worktree state unknown",
      ],
      [
        { name: "a" },
        {
          worktreePath: "/repo/wt", branch: "worktree-a", created: true,
          seeded: [], previousUnlockAttempted: true, previousWorktreePath: "/repo/old",
          previousKeepOutcome: "keep-failed",
        },
        "enter worktree(/repo/wt) on branch worktree-a; previous /repo/old keep failed; previous worktree state unknown",
      ],
    ] as const;
    for (const [args, details, expected] of enterCases) {
      const result = canonical("CANONICAL ENTER BODY", details);
      expect(renderResult(enter, args, result, { width: 240 })).toEqual([expected]);
      expect(renderResult(enter, args, result, { expanded: true, width: 240 })).toEqual([expected]);
      expect(result.content[0]?.text).toBe("CANONICAL ENTER BODY");
    }

    const exit = decorate({ name: "ExitWorktree" } as ToolDefinition);
    const base = { worktreePath: "/repo/wt", restorePath: "/repo", diagnostics: [] };
    const exitCases = [
      [{ outcome: "none", restorePath: "/repo" }, "exit worktree (no active worktree); already at /repo"],
      [{ ...base, outcome: "kept", ok: true, removed: false, orphaned: false }, "exit worktree(/repo/wt) kept; restored /repo"],
      [{ ...base, outcome: "keep-failed", ok: false, removed: false, orphaned: false, error: "unlock denied" }, "exit worktree(/repo/wt) keep failed: unlock denied; worktree state unknown; restored /repo"],
      [{ ...base, outcome: "keep-failed", ok: false, removed: false, orphaned: false }, "exit worktree(/repo/wt) keep failed; worktree state unknown; restored /repo"],
      [{ ...base, outcome: "removed", ok: true, removed: true, orphaned: false }, "exit worktree(/repo/wt) removed; restored /repo"],
      [{ ...base, outcome: "deferred-removal", ok: true, removed: false, orphaned: true }, "exit worktree(/repo/wt) removal deferred; restored /repo"],
      [{ ...base, outcome: "removal-failed", ok: false, removed: false, orphaned: false, error: "boom" }, "exit worktree(/repo/wt) removal failed: boom; worktree state unknown; restored /repo"],
      [{ ...base, outcome: "removal-failed", ok: false, removed: false, orphaned: false }, "exit worktree(/repo/wt) removal failed; worktree state unknown; restored /repo"],
    ] as const;
    for (const [details, expected] of exitCases) {
      const result = canonical("CANONICAL EXIT BODY", details);
      expect(renderResult(exit, { action: "remove" }, result, { width: 240 })).toEqual([expected]);
      expect(renderResult(exit, { action: "remove" }, result, { expanded: true, width: 240 })).toEqual([expected]);
      expect(result.content[0]?.text).toBe("CANONICAL EXIT BODY");
    }
  });

  it("keeps worktree calls empty and sanitizes settled field values without losing outcome wording", () => {
    const enter = decorate({ name: "EnterWorktree" } as ToolDefinition);
    const exit = decorate({ name: "ExitWorktree" } as ToolDefinition);
    expect(enter.renderCall({ name: "feature" }, undefined, {}).render(80)).toEqual([]);
    expect(exit.renderCall({ action: "remove" }, undefined, {}).render(80)).toEqual([]);

    const result = {
      content: [{ type: "text", text: "HOSTILE CANONICAL" }],
      details: {
        worktreePath: "/界🙂/" + "long".repeat(30) + "\u001b]0;pwn\u0007\nnext",
        branch: "worktree-e\u0301🙂\u001b[31mred",
        created: true,
        seeded: ["a"],
        previousUnlockAttempted: true,
        previousWorktreePath: "/old/" + "wide界🙂".repeat(20),
        previousKeepOutcome: "kept",
      },
    };
    for (const width of [0, 1, 2, 40, 100]) {
      const lines = renderResult(enter, { name: "hostile" }, result, { width });
      expect(lines).toHaveLength(1);
      expectBounded(lines, width);
      const plain = lines.join("\n").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
      expect(plain).not.toMatch(/[\r\n]/u);
      expect(plain).not.toContain("pwn");
      if (width === 100) {
        expect(lines[0]).toContain("; seeded 1 files; previous ");
        expect(lines[0]).toContain(" kept; unlock attempted");
      }
    }
  });

  it("keeps invariant exceptional evidence ahead of hostile detail and paths at narrow widths", () => {
    const hostileError = `unlock denied ${"variable-detail-".repeat(40)}\u001b]0;pwn\u0007`;
    const calls: Array<{ slot: string; text: string }> = [];
    const theme = { fg(slot: string, text: string) { calls.push({ slot, text }); return text; } };
    const enter = decorate({ name: "EnterWorktree" } as ToolDefinition);
    const enterResult = {
      content: [{ type: "text", text: "CANONICAL" }],
      details: {
        worktreePath: "/very/long/current/worktree", branch: "worktree-long", created: true, seeded: [],
        previousUnlockAttempted: true, previousWorktreePath: "/very/long/previous/worktree",
        previousKeepOutcome: "keep-failed", previousKeepError: hostileError,
      },
    };
    const enterLine = renderResult(enter, { name: "next" }, enterResult, { width: 44, theme }).join(" ");
    expect(enterLine).toContain("entered; prior keep failed; state unknown");
    expect(enterLine).not.toContain("/very/long");
    expect(enterLine).not.toContain("pwn");

    const exit = decorate({ name: "ExitWorktree" } as ToolDefinition);
    const base = {
      worktreePath: "/very/long/current/worktree", restorePath: "/very/long/restoration/path",
      ok: false, removed: false, orphaned: false, diagnostics: [],
    };
    const failed = renderResult(exit, { action: "remove" }, {
      content: [{ type: "text", text: "CANONICAL" }],
      details: { ...base, outcome: "removal-failed", error: hostileError },
    }, { width: 44, theme }).join(" ");
    expect(failed).toContain("removal failed; state unknown; restored");
    expect(failed).not.toContain("/very/long");
    expect(failed).not.toContain("variable-detail");

    const deferred = renderResult(exit, { action: "remove" }, {
      content: [{ type: "text", text: "CANONICAL" }],
      details: { ...base, outcome: "deferred-removal", ok: true, orphaned: true },
    }, { width: 28, theme }).join(" ");
    expect(deferred).toContain("removal deferred; restored");
    expect(deferred).not.toContain("/very/long");
    expect(calls).toContainEqual({ slot: "warning", text: "removal failed; state unknown" });
    expect(calls).toContainEqual({ slot: "warning", text: "removal deferred" });
    expect(calls).toContainEqual({ slot: "muted", text: "; restored" });
  });

  it("keeps Exit removal failures to one safe bounded row across hostile Unicode widths", () => {
    const exit = decorate({ name: "ExitWorktree" } as ToolDefinition);
    const result = {
      content: [{ type: "text", text: "REMOVAL FAILURE CANONICAL" }],
      details: {
        worktreePath: "/repo/界🙂e\u0301\u001b[31mwt", outcome: "removal-failed",
        restorePath: "/base/恢復🙂", ok: false, removed: false, orphaned: false,
        diagnostics: [], error: "鎖🙂e\u0301\u001b]0;pwn\u0007\nretry failed",
      },
    };
    for (const width of [0, 1, 2, 40, 80, 200]) {
      const lines = renderResult(exit, { action: "remove" }, result, { width });
      expect(lines).toHaveLength(1);
      expectBounded(lines, width);
      const plain = (lines[0] ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
      expect(plain).not.toMatch(/[\r\n\u001b]/u);
      expect(plain).not.toContain("pwn");
      if (width >= 40) expect(plain).toContain("removal failed");
      if (width === 200) {
        expect(plain).toBe(
          "exit worktree(/repo/界🙂éwt) removal failed: 鎖🙂é retry failed; worktree state unknown; restored /base/恢復🙂",
        );
      }
    }
  });

  it("bounds worktree metadata arrays before key enumeration and fails oversized shapes open", () => {
    const enter = decorate({ name: "EnterWorktree" } as ToolDefinition);
    const exit = decorate({ name: "ExitWorktree" } as ToolDefinition);
    let ownKeysCalls = 0;
    let unsafeGets = 0;
    const oversized = (length: number): unknown[] => {
      const target: unknown[] = [];
      target.length = length;
      return new Proxy(target, {
        get(targetValue, key, receiver) {
          unsafeGets++;
          return Reflect.get(targetValue, key, receiver);
        },
        ownKeys(targetValue) {
          ownKeysCalls++;
          return Reflect.ownKeys(targetValue);
        },
      });
    };
    const enterResult = {
      content: [{ type: "text", text: "OVERSIZED SEEDED VISIBLE" }],
      details: {
        worktreePath: "/repo/wt", branch: "worktree-a", created: true,
        seeded: oversized(1_001), previousUnlockAttempted: false,
      },
    };
    const exitResult = {
      content: [{ type: "text", text: "OVERSIZED DIAGNOSTICS VISIBLE" }],
      details: {
        worktreePath: "/repo/wt", outcome: "removed", restorePath: "/repo",
        ok: true, removed: true, orphaned: false, diagnostics: oversized(1_001),
      },
    };
    expect(renderResult(enter, { name: "a" }, enterResult).join("\n")).toContain(
      "OVERSIZED SEEDED VISIBLE",
    );
    expect(renderResult(exit, { action: "remove" }, exitResult).join("\n")).toContain(
      "OVERSIZED DIAGNOSTICS VISIBLE",
    );
    expect(ownKeysCalls).toBe(0);
    expect(unsafeGets).toBe(0);
  });

  it("fails worktree partial, error, malformed, contradictory, accessor, and unfamiliar shapes open", () => {
    const enter = decorate({ name: "EnterWorktree" } as ToolDefinition);
    const exit = decorate({ name: "ExitWorktree" } as ToolDefinition);
    const ordinary = {
      content: [{ type: "text", text: "VISIBLE WORKTREE RESULT" }],
      details: {
        worktreePath: "/repo/wt", outcome: "removed", restorePath: "/repo",
        ok: true, removed: true, orphaned: false, diagnostics: [],
      },
    };
    let reads = 0;
    const accessor = Object.defineProperty({}, "outcome", {
      enumerable: true,
      get() { reads++; return "removed"; },
    });
    const cases: Array<[unknown, Record<string, boolean>]> = [
      [ordinary, { partial: true }],
      [ordinary, { error: true }],
      [{ ...ordinary, details: { ...ordinary.details, removed: false } }, {}],
      [{ ...ordinary, details: { ...ordinary.details, outcome: "kept", removed: false, ok: false } }, {}],
      [{ ...ordinary, details: { ...ordinary.details, future: true } }, {}],
      [{ ...ordinary, details: accessor }, {}],
      [{ content: [{ type: "text", text: "VISIBLE WORKTREE RESULT" }], details: {} }, {}],
    ];
    for (const [result, flags] of cases) {
      const output = renderResult(exit, { action: "remove" }, result, flags).join("\n");
      expect(output).toContain("VISIBLE WORKTREE RESULT");
      expect(output).not.toBe("exit worktree(/repo/wt) removed; restored /repo");
    }
    expect(reads).toBe(0);

    const enterDetails = {
      worktreePath: "/repo/wt", branch: "worktree-a", created: true,
      seeded: ["seed"], previousUnlockAttempted: false,
    };
    for (const [args, details] of [
      [{ path: "/repo/wt" }, enterDetails],
      [{ name: "a", path: "/repo/wt" }, { ...enterDetails, created: false, seeded: [] }],
      [{ path: "/repo/other" }, { ...enterDetails, created: false, seeded: [] }],
      [{ path: "/repo/wt" }, { ...enterDetails, created: false }],
      [{ name: "a" }, { ...enterDetails, previousUnlockAttempted: true }],
      [{ name: "a" }, { ...enterDetails, previousWorktreePath: "/repo/old" }],
    ] as const) {
      expect(renderResult(enter, args, {
        content: [{ type: "text", text: "VISIBLE ENTER CONTRADICTION" }], details,
      }).join("\n")).toContain("VISIBLE ENTER CONTRADICTION");
    }
  });

  it("recognizes descriptor-safe worktree proxies while rejecting prototypes without mutation or property reads", () => {
    const enter = decorate({ name: "EnterWorktree" } as ToolDefinition);
    let propertyReads = 0;
    const noGet = <T extends object>(value: T): T => new Proxy(value, {
      get(target, key, receiver) {
        propertyReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const args = Object.freeze({ path: "/repo/frozen" });
    const content = Object.freeze([Object.freeze({ type: "text", text: "FROZEN CANONICAL" })]);
    const details = noGet({
      worktreePath: "/repo/frozen", branch: "worktree-frozen", created: false,
      seeded: noGet([] as string[]), previousUnlockAttempted: false,
    });
    const result = Object.freeze({ content, details });
    expect(renderResult(enter, args, result)).toEqual([
      "enter worktree(/repo/frozen) on branch worktree-frozen",
    ]);
    const exit = decorate({ name: "ExitWorktree" } as ToolDefinition);
    const exitDetails = noGet({
      worktreePath: "/repo/frozen", outcome: "kept", restorePath: "/repo",
      ok: true, removed: false, orphaned: false, diagnostics: noGet([] as unknown[]),
    });
    expect(renderResult(exit, Object.freeze({ action: "keep" }), {
      content: Object.freeze([Object.freeze({ type: "text", text: "FROZEN EXIT CANONICAL" })]),
      details: exitDetails,
    })).toEqual(["exit worktree(/repo/frozen) kept; restored /repo"]);
    expect(propertyReads).toBe(0);
    expect(content[0]?.text).toBe("FROZEN CANONICAL");

    let accessorReads = 0;
    const enterAccessor = Object.defineProperty({}, "branch", {
      enumerable: true,
      get() { accessorReads++; return "worktree-frozen"; },
    });
    const exitAccessor = Object.defineProperty({}, "outcome", {
      enumerable: true,
      get() { accessorReads++; return "kept"; },
    });
    expect(renderResult(enter, args, { content, details: enterAccessor }).join("\n")).toContain(
      "FROZEN CANONICAL",
    );
    expect(renderResult(exit, { action: "keep" }, {
      content: [{ type: "text", text: "HOSTILE EXIT DESCRIPTOR" }], details: exitAccessor,
    }).join("\n")).toContain("HOSTILE EXIT DESCRIPTOR");
    expect(accessorReads).toBe(0);

    const inherited = Object.assign(Object.create({ inherited: true }), {
      worktreePath: "/repo/frozen", branch: "worktree-frozen", created: false,
      seeded: [], previousUnlockAttempted: false,
    });
    expect(renderResult(enter, args, { content, details: inherited }).join("\n")).toContain(
      "FROZEN CANONICAL",
    );
  });

  it("preserves execute/fields and leaves source arguments/results and unrelated tools untouched", () => {
    const source = createWebFetchTool(() => ".");
    const decorated = withRoutineToolRendering(source);
    expect(decorated).not.toBe(source);
    expect(decorated.execute).toBe(source.execute);
    for (const key of Object.keys(source)) {
      if (key !== "renderCall" && key !== "renderResult") {
        expect((decorated as unknown as Record<string, unknown>)[key]).toBe(
          (source as unknown as Record<string, unknown>)[key],
        );
      }
    }

    const argsBefore = structuredClone(fetchArgs);
    const resultBefore = structuredClone(fetchResult);
    renderResult(decorated as unknown as RenderTool, fetchArgs, fetchResult);
    expect(fetchArgs).toEqual(argsBefore);
    expect(fetchResult).toEqual(resultBefore);

    for (const name of ["Agent", "Task", "TaskOutput", "TaskStop", "SendMessage", "Other"]) {
      const unrelated = { name, execute() {} } as unknown as ToolDefinition;
      expect(withRoutineToolRendering(unrelated)).toBe(unrelated);
    }
  });
});

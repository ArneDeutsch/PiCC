import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";
import { createWebFetchTool, createWebSearchTool } from "../src/runtime/tools/web-tools.js";

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
    { args, isError: extra.error ?? false },
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
        expect(lines[0]).toContain(tool.name);
        expect(lines[0]).toContain(invocation);
        expect(lines.join("\n")).not.toContain(hidden);
      }
    }
  });

  it("compacts redirects, truncation, empty results, and backend fallback without suffixes", () => {
    const fetch = renderResult(decorate(createWebFetchTool(() => ".")), fetchArgs, fetchResult).join("\n");
    expect(fetch).toBe(`WebFetch ${fetchArgs.url}`);
    expect(fetch).not.toContain("redirect.test");
    expect(fetch).not.toMatch(/trunc/i);

    const search = renderResult(decorate(createWebSearchTool(() => ".")), searchArgs, searchResult).join("\n");
    expect(search).toBe(`WebSearch “${searchArgs.query}”`);
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
      expect(text).not.toBe(`WebFetch ${fetchArgs.url}`);
      expect(text.length).toBeGreaterThan(0);
      if (result === fetchResult || (result as typeof fetchResult).content?.[0]?.type === "text") {
        expect(text).toContain("SECRET FETCH BODY");
      } else {
        expect(text).toContain("Unfamiliar WebFetch presentation format");
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
      expect(text).not.toBe(`WebSearch “${searchArgs.query}”`);
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
    expect(lines[0]).toContain("wide界");
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
    expect(text).toContain("Unfamiliar WebFetch presentation format");
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
      [searchArgs, { ...searchResult, content: [accessor({ type: "text" }, "text", "secret")] }, "Unfamiliar WebSearch presentation format"],
      [{ query: searchArgs.query, allowed_domains: domainArray }, searchResult, "SECRET SEARCH TITLE"],
    ];
    for (const [args, result, expected] of cases) {
      const output = renderResult(tool, args, result).join("\n");
      expect(output).toContain(expected);
      expect(output).not.toBe(`WebSearch “${searchArgs.query}”`);
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
      `WebSearch “${searchArgs.query}”`,
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
      [searchArgs, { ...searchResult, content: [hostile({ type: "text", text: "secret" })] }, "Unfamiliar WebSearch presentation format"],
      [{ query: searchArgs.query, allowed_domains: hostile(["example.test"]) }, searchResult, "SECRET SEARCH TITLE"],
    ];
    for (const [args, result, expected] of cases) {
      const output = renderResult(decorate(createWebSearchTool(() => ".")), args, result).join("\n");
      expect(output).toContain(expected);
      expect(output).not.toBe(`WebSearch “${searchArgs.query}”`);
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
    expect(lines.join("\n")).toContain("Unfamiliar WebFetch presentation format");
  });

  it("renders ordinary Skill and SlashCommand activations from snapshotted call arguments only", () => {
    const cases = [
      [decorate({ name: "Skill" } as ToolDefinition), skillArgs, "Skill deploy — staging 1.2.3"],
      [decorate({ name: "SlashCommand" } as ToolDefinition), slashArgs, "SlashCommand /deploy staging 1.2.3"],
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

  it("renders no-argument Skill and SlashCommand activations without a dangling separator or body", () => {
    const cases = [
      [decorate({ name: "Skill" } as ToolDefinition), { name: "deploy" }, "Skill deploy"],
      [decorate({ name: "SlashCommand" } as ToolDefinition), { command: "/deploy" }, "SlashCommand /deploy"],
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
      [decorate({ name: "Skill" } as ToolDefinition), { name: "plugin:deploy" }, { ...activationResult, details: { skill: "plugin:deploy" } }, "Skill plugin:deploy"],
      [decorate({ name: "Skill" } as ToolDefinition), { name: "deploy" }, { ...activationResult, details: { skill: "plugin:deploy" } }, "Skill deploy"],
      [decorate({ name: "SlashCommand" } as ToolDefinition), { command: "/plugin:deploy now" }, { ...activationResult, details: { skill: "plugin:deploy" } }, "SlashCommand /plugin:deploy now"],
      [decorate({ name: "SlashCommand" } as ToolDefinition), { command: "deploy now" }, { ...activationResult, details: { skill: "plugin:deploy" } }, "SlashCommand deploy now"],
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
      [{ content: [{ type: "future", payload: "VISIBLE FUTURE" }], details: { skill: "deploy" } }, {}, "Unfamiliar Skill presentation format"],
    ];
    for (const [result, flags, visible] of cases) {
      const text = renderResult(tool, skillArgs, result, flags).join("\n");
      expect(text).toContain(visible);
      expect(text).not.toBe("Skill deploy — staging 1.2.3");
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
      expect(text).not.toBe(`SlashCommand ${slashArgs.command}`);
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
    expect(lines).toEqual(["Skill 部署 — é🙂"]);
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
      expect(lines.join("\n")).toContain("SlashCommand");
      expect(lines.join("\n")).not.toContain("FROZEN SECRET BODY");
    }
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

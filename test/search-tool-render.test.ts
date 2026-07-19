import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withCompactSearchTuiRendering } from "../src/runtime/search-tool-render.js";
import { createGlobTool, createGrepTool } from "../src/runtime/tools/search-tools.js";

interface Component {
  render(width: number): string[];
}

interface RenderTool {
  name: string;
  execute: unknown;
  renderCall(args: Record<string, unknown>, theme: unknown, context: RenderContext): Component;
  renderResult(
    result: ResultShape,
    options: { expanded: boolean; isPartial: boolean },
    theme: unknown,
    context: RenderContext,
  ): Component;
}

interface ResultShape {
  content?: unknown;
  details?: unknown;
}

interface RenderContext {
  args: Record<string, unknown>;
  state: Record<string, unknown>;
  isError?: boolean;
  isPartial?: boolean;
}

const grepDetails = {
  mode: "files_with_matches",
  engine: "js",
  totalEntries: 2,
  returnedEntries: 2,
  truncated: false,
};

const globDetails = {
  totalMatches: 2,
  returned: 2,
  capped: false,
  truncated: false,
};

function grepTool(): RenderTool {
  return withCompactSearchTuiRendering(createGrepTool(() => ".", { forceJs: true })) as unknown as RenderTool;
}

function globTool(): RenderTool {
  return withCompactSearchTuiRendering(createGlobTool(() => ".")) as unknown as RenderTool;
}

function context(args: Record<string, unknown>, extra: Partial<RenderContext> = {}): RenderContext {
  return { args, state: {}, ...extra };
}

function textResult(text: string, details: unknown, trailing: unknown[] = []): ResultShape {
  return { content: [{ type: "text", text }, ...trailing], details };
}

function callAndFinalize(
  tool: RenderTool,
  args: Record<string, unknown>,
  result: ResultShape,
  width = 120,
  expanded = false,
  theme: unknown = undefined,
): { call: string[]; result: string[]; ctx: RenderContext } {
  const ctx = context(args);
  const call = tool.renderCall(args, theme, ctx);
  const renderedResult = tool.renderResult(result, { expanded, isPartial: false }, theme, ctx);
  return { call: call.render(width), result: renderedResult.render(width), ctx };
}

function expectBounded(lines: string[], width: number): void {
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

describe("compact search TUI decorator", () => {
  it("preserves execute and every non-render field", () => {
    const source = createGrepTool(() => ".", { forceJs: true });
    const decorated = withCompactSearchTuiRendering(source);
    expect(decorated).not.toBe(source);
    expect(decorated.execute).toBe(source.execute);
    for (const key of Object.keys(source)) {
      if (key !== "renderCall" && key !== "renderResult") {
        expect((decorated as unknown as Record<string, unknown>)[key]).toBe(
          (source as unknown as Record<string, unknown>)[key],
        );
      }
    }
    expect(() =>
      withCompactSearchTuiRendering({ ...source, name: "Other" } as typeof source),
    ).toThrow(/only Grep or Glob/);
  });

  it("renders pending Grep and Glob calls as one recognizable row", () => {
    const cases: Array<[RenderTool, Record<string, unknown>, RegExp]> = [
      [grepTool(), { pattern: "needle", path: "src", glob: "*.ts", type: "ts" }, /Grep.*needle/],
      [globTool(), { pattern: "**\/*.ts", path: "src" }, /Glob.*\.ts/],
    ];
    for (const [tool, args, expected] of cases) {
      const lines = tool.renderCall(args, undefined, context(args)).render(100);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(expected);
      expect(lines[0]).toContain("src");
      expectBounded(lines, 100);
    }
  });

  it("hides ordinary final output in collapsed and expanded views", () => {
    for (const expanded of [false, true]) {
      const grep = callAndFinalize(
        grepTool(),
        { pattern: "needle" },
        textResult("a.ts\nb.ts", grepDetails),
        100,
        expanded,
      );
      expect(grep.call).toHaveLength(1);
      expect(grep.call.join(" ")).toContain("2/2 entries");
      expect(grep.call.join(" ")).not.toContain("a.ts");
      expect(grep.result).toEqual([]);

      const glob = callAndFinalize(
        globTool(),
        { pattern: "*.ts" },
        textResult("/a.ts\n/b.ts", globDetails),
        100,
        expanded,
      );
      expect(glob.call).toHaveLength(1);
      expect(glob.call.join(" ")).toContain("2/2 files");
      expect(glob.result).toEqual([]);
    }
  });

  it("distinguishes zero matches, zero files, and an empty Grep page", () => {
    const zeroGrep = callAndFinalize(
      grepTool(),
      { pattern: "x" },
      textResult("No matches found", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }),
    );
    expect(zeroGrep.call.join(" ")).toContain("no matches");

    const zeroGlob = callAndFinalize(
      globTool(),
      { pattern: "x" },
      textResult("No files found", { ...globDetails, totalMatches: 0, returned: 0 }),
    );
    expect(zeroGlob.call.join(" ")).toContain("no files");

    const emptyPage = callAndFinalize(
      grepTool(),
      { pattern: "x", offset: 8 },
      textResult("No entries at offset 8 (2 total)", { ...grepDetails, returnedEntries: 0 }),
    );
    expect(emptyPage.call.join(" ")).toContain("empty page at offset 8");
    expect(emptyPage.call.join(" ")).not.toContain("no matches");
  });

  it("treats every positive Grep offset as incomplete while preserving empty-page status", () => {
    const remainingPage = callAndFinalize(
      grepTool(),
      { pattern: "needle", offset: 2 },
      textResult("three remaining", { ...grepDetails, totalEntries: 5, returnedEntries: 3 }),
      140,
    );
    expect(remainingPage.call.join(" ")).toContain("offset 2");
    expect([...remainingPage.call, ...remainingPage.result].join(" ")).toContain("head_limit/offset");

    const emptyPage = callAndFinalize(
      grepTool(),
      { pattern: "needle", offset: 8 },
      textResult("empty", { ...grepDetails, returnedEntries: 0 }),
      140,
    );
    expect(emptyPage.call.join(" ")).toContain("empty page at offset 8");
    expect([...emptyPage.call, ...emptyPage.result].join(" ")).toContain("head_limit/offset");
  });

  it("shows limited, capped, truncated, and simultaneous statuses with tool-specific recovery", () => {
    const limited = callAndFinalize(
      grepTool(),
      { pattern: "x", head_limit: 2 },
      textResult("a\nb", { ...grepDetails, totalEntries: 9, truncated: true }),
      140,
    );
    expect(limited.call.join(" ")).toContain("limited + truncated");
    expect(limited.call.join(" ")).toContain("head_limit/offset");
    expect(limited.result).toEqual([]);

    const capped = callAndFinalize(
      globTool(),
      { pattern: "**/*" },
      textResult("many", { totalMatches: 250, returned: 200, capped: true, truncated: true }),
      140,
    );
    expect(capped.call.join(" ")).toContain("capped + truncated");
    expect(capped.call.join(" ")).toContain("cap is fixed");
  });

  it("moves fixed recovery below the row when practical inline space is unavailable", () => {
    const rendered = callAndFinalize(
      grepTool(),
      { pattern: "needle", head_limit: 1 },
      textResult("a", { ...grepDetails, totalEntries: 5, returnedEntries: 1 }),
      32,
    );
    expect(rendered.call).toHaveLength(1);
    expect(rendered.call.join(" ")).toContain("limited");
    expect(rendered.result.join(" ")).toContain("Recovery:");
    expect(rendered.result.join(" ")).toContain("head_limit/offset");
    expectBounded(rendered.result, 32);
  });

  it("recognizes only exact standalone PiCC clip markers", () => {
    const marker =
      "head\n\n[PiCC clipped 123 characters from the middle of this Grep output — re-run the search with a tighter pattern or a smaller head_limit/offset to recover the omitted matches]\n\ntail";
    const exact = callAndFinalize(grepTool(), { pattern: "x" }, textResult(marker, grepDetails), 140);
    expect(exact.call.join(" ")).toContain("clipped");
    expect(exact.call.join(" ")).toContain("head_limit/offset");

    const lookalike = callAndFinalize(
      grepTool(),
      { pattern: "x" },
      textResult("prefix [PiCC clipped 123 characters from this output] suffix", grepDetails),
      140,
    );
    expect(lookalike.call.join(" ")).not.toContain("clipped");
  });

  it("keeps all appended text feedback while never re-showing the primary body", () => {
    const rendered = callAndFinalize(
      grepTool(),
      { pattern: "x" },
      textResult("ordinary-match", grepDetails, [
        { type: "text", text: "first feedback is long enough to wrap" },
        { type: "text", text: "second\nfeedback [PiCC clipped 5 characters]" },
      ]),
      12,
    );
    const shown = rendered.result.join("\n");
    expect(shown).not.toContain("ordinary-match");
    expect(shown).toContain("first");
    expect(shown).toContain("second");
    expectBounded(rendered.result, 12);
    expect(rendered.result.join("").replace(/\s/g, "")).toContain(
      "firstfeedbackislongenoughtowrapsecondfeedback[PiCCclipped5characters]",
    );
  });

  it("sanitizes feedback completely before width-aware wrapping", () => {
    const hostile = "ok\rOVER\u001b[31mred\u001b[0m\u001b]0;title\u0007中🙂e\u0301\u0000\u0085\u007f\u202eend\u2028next";
    const rendered = callAndFinalize(
      globTool(),
      { pattern: "*" },
      textResult("/ordinary", globDetails, [{ type: "text", text: hostile }]),
      8,
    );
    const output = rendered.result.join("\n");
    expect(output).not.toMatch(/[\u001b\u0000\u0085\u007f\u202e\u2028]/u);
    expect(output).toContain("OVER");
    expect(output).toContain("中");
    expectBounded(rendered.result, 8);
  });

  it("sanitizes and bounds hostile invocation fields over a width sweep", () => {
    const args = {
      pattern: "中🙂e\u0301\tline\r\nnext\u001b[31mred\u001b]0;x\u0007\u202eend",
      path: "C:\\very\\long\\路径\\file",
      glob: "**/超長/**/*.ts",
      type: "typescript",
      output_mode: "content",
      "-i": true,
      "-A": 3,
      "-o": true,
    };
    const tool = grepTool();
    for (const width of [1, 2, 3, 4, 8, 16, 40, 80, 120]) {
      const lines = tool.renderCall(args, undefined, context(args)).render(width);
      expect(lines).toHaveLength(1);
      expectBounded(lines, width);
      if (width >= 3) expect(visibleWidth(lines[0] ?? "")).toBeGreaterThan(0);
      expect(lines[0]).not.toMatch(/[\r\n\u0007\u202e]/u);
      expect(lines[0]).not.toContain("[31m");
      expect(lines[0]).not.toContain("]0;x");
    }
  });

  it("displays only effective Grep modifiers", () => {
    const nonContent = grepTool()
      .renderCall(
        { pattern: "x", output_mode: "count", "-A": 3, context: 4, "-o": true, "-i": true },
        undefined,
        context({ pattern: "x" }),
      )
      .render(160)
      .join(" ");
    expect(nonContent).toContain("mode count");
    expect(nonContent).toContain("-i");
    expect(nonContent).not.toContain("-A");
    expect(nonContent).not.toContain("context 4");
    expect(nonContent).not.toContain("-o");
  });

  it("keeps partial output visible, then replaces it with one final summary", () => {
    const tool = grepTool();
    const args = { pattern: "x" };
    const ctx = context(args);
    const call = tool.renderCall(args, undefined, ctx);
    const partial = tool.renderResult(
      textResult("partial match", grepDetails),
      { expanded: false, isPartial: true },
      undefined,
      ctx,
    );
    expect(partial.render(80).join(" ")).toContain("partial match");
    expect(call.render(80)).toHaveLength(1);

    const final = tool.renderResult(
      textResult("final match", grepDetails),
      { expanded: false, isPartial: false },
      undefined,
      ctx,
    );
    expect(final.render(80)).toEqual([]);
    expect(call.render(80)).toHaveLength(1);
    expect(call.render(80).join(" ")).toContain("2/2 entries");
    expect(call.render(80).join(" ")).not.toContain("final match");
  });

  it("keeps errors visible after pending or partial states", () => {
    const tool = globTool();
    const args = { pattern: "*" };
    const ctx = context(args);
    const call = tool.renderCall(args, undefined, ctx);
    tool.renderResult(
      textResult("still searching", globDetails),
      { expanded: false, isPartial: true },
      undefined,
      ctx,
    );
    ctx.isError = true;
    const failed = tool.renderResult(
      textResult("directory exploded", undefined),
      { expanded: false, isPartial: false },
      undefined,
      ctx,
    );
    expect(call.render(100).join(" ")).toContain("failed");
    expect(failed.render(100).join(" ")).toContain("directory exploded");
  });

  it("does not leak state between interleaved calls", () => {
    const tool = grepTool();
    const aArgs = { pattern: "alpha" };
    const bArgs = { pattern: "beta", head_limit: 1 };
    const aCtx = context(aArgs);
    const bCtx = context(bArgs);
    const aCall = tool.renderCall(aArgs, undefined, aCtx);
    const bCall = tool.renderCall(bArgs, undefined, bCtx);
    tool.renderResult(
      textResult("a", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }),
      { expanded: false, isPartial: false },
      undefined,
      aCtx,
    );
    tool.renderResult(
      textResult("b", { ...grepDetails, totalEntries: 5, returnedEntries: 1 }),
      { expanded: false, isPartial: false },
      undefined,
      bCtx,
    );
    expect(aCall.render(120).join(" ")).toContain("no matches");
    expect(aCall.render(120).join(" ")).not.toContain("limited");
    expect(bCall.render(120).join(" ")).toContain("limited");
    expect(bCall.render(120).join(" ")).not.toContain("no matches");
  });

  it("tolerates undefined, null, partial, and throwing themes and state", () => {
    const themes: unknown[] = [
      undefined,
      null,
      {},
      { fg: () => { throw new Error("bad fg"); }, bold: () => { throw new Error("bad bold"); } },
    ];
    const tool = grepTool();
    for (const theme of themes) {
      const ctx = context({ pattern: "x" });
      const lines = tool.renderCall({ pattern: "x" }, theme, ctx).render(20);
      expect(lines).toHaveLength(1);
      expectBounded(lines, 20);
    }
    const malformedCtx = { args: { pattern: "x" }, state: null } as unknown as RenderContext;
    expect(() => tool.renderCall({ pattern: "x" }, undefined, malformedCtx).render(10)).not.toThrow();
  });

  it.each([
    ["NaN", { ...grepDetails, totalEntries: Number.NaN }],
    ["infinity", { ...grepDetails, returnedEntries: Number.POSITIVE_INFINITY }],
    ["negative", { ...grepDetails, totalEntries: -1 }],
    ["inconsistent counts", { ...grepDetails, totalEntries: 1, returnedEntries: 2 }],
    ["unknown mode", { ...grepDetails, mode: "paths" }],
    ["unknown engine", { ...grepDetails, engine: "other" }],
    ["extra key", { ...grepDetails, extra: true }],
  ])("fails open for invalid Grep details: %s", (_label, details) => {
    const rendered = callAndFinalize(grepTool(), { pattern: "x" }, textResult("raw body", details));
    expect(rendered.result.join(" ")).toContain("raw body");
  });

  it("fails open for hostile details prototypes, getters, and incoherent pagination", () => {
    const hostile = Object.assign(Object.create({ polluted: true }), grepDetails);
    const prototypeResult = callAndFinalize(
      grepTool(),
      { pattern: "x" },
      textResult("prototype body", hostile),
    );
    expect(prototypeResult.result.join(" ")).toContain("prototype body");

    const throwing = { ...grepDetails } as Record<string, unknown>;
    Object.defineProperty(throwing, "engine", {
      enumerable: true,
      get: () => {
        throw new Error("hostile getter");
      },
    });
    expect(() =>
      callAndFinalize(grepTool(), { pattern: "x" }, textResult("getter body", throwing)),
    ).not.toThrow();

    const pagination = callAndFinalize(
      grepTool(),
      { pattern: "x", head_limit: 1 },
      textResult("pagination body", grepDetails),
    );
    expect(pagination.result.join(" ")).toContain("pagination body");
  });

  it.each([
    ["NaN", { ...globDetails, totalMatches: Number.NaN }],
    ["infinity", { ...globDetails, returned: Number.POSITIVE_INFINITY }],
    ["negative", { ...globDetails, totalMatches: -1 }],
    ["bad cap count", { totalMatches: 250, returned: 199, capped: true, truncated: false }],
    ["bad cap flag", { totalMatches: 250, returned: 200, capped: false, truncated: false }],
    ["extra key", { ...globDetails, other: 1 }],
  ])("fails open for invalid Glob details: %s", (_label, details) => {
    const rendered = callAndFinalize(globTool(), { pattern: "*" }, textResult("raw body", details));
    expect(rendered.result.join(" ")).toContain("raw body");
  });

  it("fails open for missing/non-text primary and malformed/non-text trailing blocks", () => {
    const cases: ResultShape[] = [
      { content: [], details: grepDetails },
      { content: [{ type: "image", data: "x" }], details: grepDetails },
      { content: [{ type: "text", text: "body", extra: true }], details: grepDetails },
      textResult("body", grepDetails, [{ type: "image", data: "x" }]),
      textResult("body", grepDetails, [{ type: "text", text: 4 }]),
    ];
    for (const result of cases) {
      const rendered = callAndFinalize(grepTool(), { pattern: "x" }, result);
      expect(() => rendered.result.join(" ")).not.toThrow();
      if (Array.isArray(result.content) && result.content[0] && (result.content[0] as { type?: string }).type === "text") {
        expect(rendered.result.join(" ")).toContain("body");
      }
    }
  });

  it("does not mutate args, content, or details", () => {
    const args = Object.freeze({ pattern: "x" });
    const first = Object.freeze({ type: "text" as const, text: "ordinary" });
    const feedback = Object.freeze({ type: "text" as const, text: "feedback" });
    const details = Object.freeze({ ...grepDetails });
    const result = Object.freeze({ content: Object.freeze([first, feedback]), details });
    const before = JSON.stringify(result);
    const rendered = callAndFinalize(grepTool(), args, result, 30);
    expect(rendered.result.join(" ")).toContain("feedback");
    expect(JSON.stringify(result)).toBe(before);
    expect(result.content[0]).toBe(first);
    expect(result.details).toBe(details);
  });

  it("covers every valid Grep mode and engine with coherent args", () => {
    for (const engine of ["rg", "js"] as const) {
      for (const mode of ["content", "files_with_matches", "count"] as const) {
        const args = { pattern: "x", output_mode: mode };
        const details = { ...grepDetails, mode, engine };
        const rendered = callAndFinalize(grepTool(), args, textResult("ordinary", details));
        expect(rendered.result).toEqual([]);
        expect(rendered.call.join(" ")).toContain("2/2 entries");
      }
    }
  });

  it("fails open when Grep mode and arguments disagree", () => {
    for (const args of [
      { pattern: "x", output_mode: "content" },
      { pattern: "x", output_mode: "bogus" },
    ]) {
      const rendered = callAndFinalize(grepTool(), args, textResult("observable body", grepDetails));
      expect(rendered.result.join(" ")).toContain("observable body");
    }
  });

  it("uses execution-equivalent pagination for zero, positive, floored, and clamped values", () => {
    const cases: Array<[Record<string, unknown>, number, string | undefined]> = [
      [{ pattern: "x", head_limit: 0 }, 5, "limit unlimited"],
      [{ pattern: "x", head_limit: -3 }, 5, "limit unlimited"],
      [{ pattern: "x", head_limit: 2.9 }, 2, "limit 2"],
      [{ pattern: "x", offset: -4 }, 5, undefined],
      [{ pattern: "x", offset: 1.9 }, 4, "offset 1"],
    ];
    for (const [args, returnedEntries, display] of cases) {
      const rendered = callAndFinalize(
        grepTool(),
        args,
        textResult("ordinary", { ...grepDetails, totalEntries: 5, returnedEntries }),
        220,
      );
      expect(rendered.result).toEqual([]);
      if (display) expect(rendered.call.join(" ")).toContain(display);
      else expect(rendered.call.join(" ")).not.toContain("offset");
    }
  });

  it("renders resolved context precedence and clamping, omitting ineffective aliases", () => {
    const tool = grepTool();
    const render = (args: Record<string, unknown>) =>
      tool.renderCall(args, undefined, context(args)).render(240).join(" ");
    const precedence = render({
      pattern: "x", output_mode: "content", context: 9.8, "-C": 4.8, "-B": 2.9, "-A": -7,
    });
    expect(precedence).toContain("-B 2");
    expect(precedence).not.toContain("-A");
    expect(precedence).not.toContain("-C");
    expect(precedence).not.toContain("context");

    const symmetric = render({ pattern: "x", output_mode: "content", context: 3.9 });
    expect(symmetric).toContain("-C 3");
    expect(symmetric).not.toContain("context");

    const only = render({ pattern: "x", output_mode: "content", "-o": true, "-C": 8 });
    expect(only).toContain("-o");
    expect(only).not.toContain("-C 8");
  });

  it("omits pagination defaults and displays only effective non-defaults", () => {
    const args = { pattern: "x", head_limit: 100, offset: 0 };
    const row = grepTool().renderCall(args, undefined, context(args)).render(180).join(" ");
    expect(row).not.toContain("limit 100");
    expect(row).not.toContain("offset 0");
  });

  it.each([
    ["pattern", { pattern: 4 }],
    ["path", { pattern: "x", path: false }],
    ["boolean", { pattern: "x", "-i": "yes" }],
    ["number", { pattern: "x", offset: "1" }],
    ["mode", { pattern: "x", output_mode: 1 }],
  ])("fails open for wrong Grep primitive type: %s", (_label, args) => {
    const rendered = callAndFinalize(grepTool(), args, textResult("wrong-type body", grepDetails));
    expect(rendered.result.join(" ")).toContain("wrong-type body");
  });

  it("fails open for wrong Glob primitives and hostile getters/prototypes", () => {
    const wrong = callAndFinalize(globTool(), { pattern: 3 }, textResult("glob primitive", globDetails));
    expect(wrong.result.join(" ")).toContain("glob primitive");

    const inherited = Object.assign(Object.create({ totalMatches: 2 }), {
      returned: 2, capped: false, truncated: false,
    });
    const prototype = callAndFinalize(globTool(), { pattern: "*" }, textResult("glob prototype", inherited));
    expect(prototype.result.join(" ")).toContain("glob prototype");

    const getter = { ...globDetails } as Record<string, unknown>;
    Object.defineProperty(getter, "returned", { enumerable: true, get: () => { throw new Error("boom"); } });
    const hostile = callAndFinalize(globTool(), { pattern: "*" }, textResult("glob getter", getter));
    expect(hostile.result.join(" ")).toContain("glob getter");
  });

  it("shortens and retains long POSIX and Windows paths before dropping them", () => {
    for (const path of [
      "/very/long/project/packages/component/src/recognizable-posix.ts",
      "C:\\very\\long\\project\\packages\\component\\src\\recognizable-win.ts",
    ]) {
      const args = { pattern: "x", path };
      const rendered = callAndFinalize(grepTool(), args, textResult("ordinary", grepDetails), 58);
      const row = rendered.call.join(" ");
      expect(row).toContain("2/2 entries");
      expect(row).toContain("in …");
      expect(row).toMatch(/recognizable-(?:posix|win)\.ts/);
      expectBounded([row], 58);
    }
  });

  it("keeps actionable status ahead of count and path at narrow widths", () => {
    const rendered = callAndFinalize(
      grepTool(),
      { pattern: "x", path: "/ordinary/path" },
      textResult("none", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }),
      16,
    );
    expect(rendered.call.join(" ")).toContain("none");
    expect(rendered.call.join(" ")).not.toContain("0/0");
    expect(rendered.call.join(" ")).not.toContain("ordinary");
  });

  it("bounds finalized clean and status rows across degenerate and practical widths", () => {
    for (const width of [1, 2, 3, 8, 12, 20, 40, 80, 120]) {
      const cleanCtx = context({ pattern: "中🙂" });
      const cleanCall = globTool().renderCall({ pattern: "中🙂" }, undefined, cleanCtx);
      globTool().renderResult(textResult("ordinary", globDetails), { expanded: false, isPartial: false }, undefined, cleanCtx);
      const statusCtx = context({ pattern: "x" });
      const statusTool = grepTool();
      const statusCall = statusTool.renderCall({ pattern: "x" }, undefined, statusCtx);
      statusTool.renderResult(
        textResult("none", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }),
        { expanded: false, isPartial: false }, undefined, statusCtx,
      );
      for (const lines of [cleanCall.render(width), statusCall.render(width)]) {
        expect(lines).toHaveLength(1);
        expectBounded(lines, width);
        if (width >= 3) expect(visibleWidth(lines[0] ?? "")).toBeGreaterThan(0);
        expect(lines.join(" ")).not.toContain("ordinary");
      }
      if (width >= 20) expect(statusCall.render(width).join(" ")).toMatch(/no matches|none/);
    }
  });

  it("replaces stale final status on partial, later success, error, and malformed fail-open", () => {
    const tool = grepTool();
    const args = { pattern: "x", head_limit: 1 };
    const ctx = context(args);
    const call = tool.renderCall(args, undefined, ctx);
    tool.renderResult(
      textResult("one", { ...grepDetails, totalEntries: 4, returnedEntries: 1 }),
      { expanded: false, isPartial: false }, undefined, ctx,
    );
    expect(call.render(120).join(" ")).toContain("limited");

    tool.renderResult(textResult("partial", grepDetails), { expanded: false, isPartial: true }, undefined, ctx);
    expect(call.render(120).join(" ")).not.toContain("limited");

    ctx.args = { pattern: "x" };
    tool.renderResult(textResult("clean", grepDetails), { expanded: false, isPartial: false }, undefined, ctx);
    expect(call.render(120).join(" ")).toContain("2/2");
    expect(call.render(120).join(" ")).not.toContain("limited");

    ctx.isError = true;
    tool.renderResult(textResult("error", undefined), { expanded: false, isPartial: false }, undefined, ctx);
    expect(call.render(120).join(" ")).toContain("failed");
    ctx.isError = false;
    tool.renderResult(textResult("malformed", { bad: true }), { expanded: false, isPartial: false }, undefined, ctx);
    expect(call.render(120).join(" ")).not.toMatch(/failed|limited|2\/2/);
  });

  it("preserves a measured recognizable expression before single and simultaneous statuses", () => {
    const single = callAndFinalize(
      grepTool(), { pattern: "recognizable-expression" },
      textResult("none", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }), 24,
    );
    expect(single.call.join(" ")).toMatch(/rec/);
    expect(single.call.join(" ")).toContain("none");
    expect(single.call.join(" ")).not.toMatch(/[“"]…[”"]/u);

    const simultaneous = callAndFinalize(
      grepTool(), { pattern: "recognizable-expression", head_limit: 1 },
      textResult("one", { ...grepDetails, totalEntries: 5, returnedEntries: 1, truncated: true }), 28,
    );
    expect(simultaneous.call.join(" ")).toMatch(/rec/);
    expect(simultaneous.call.join(" ")).toContain("lim+trunc");
    expect(simultaneous.call.join(" ")).not.toMatch(/[“"]…[”"]/u);
  });

  it("chooses inline versus fixed recovery with the same measured summary candidates", () => {
    const tool = grepTool();
    const args = { pattern: "recognizable-expression", head_limit: 1 };
    for (const width of [40, 60, 80, 100, 130]) {
      const rendered = callAndFinalize(
        tool, args,
        textResult("one", { ...grepDetails, totalEntries: 4, returnedEntries: 1 }),
        width,
      );
      const callText = rendered.call.join(" ");
      const inline = callText.includes("head_limit/offset");
      const separate = rendered.result.join(" ").includes("Recovery:");
      expect(inline).toBe(!separate);
      if (inline) {
        expect(callText).toMatch(/r/);
        expect(callText).toMatch(/limited|lim/);
        expect(callText).not.toMatch(/[“"]…[”"]/u);
      }
      expectBounded([...rendered.call, ...rendered.result], width);
    }
  });

  it("recognizes exact Glob clipping and keeps its fixed-cap remedy correct", () => {
    const marker =
      "head\n\n[PiCC clipped 9 characters from the middle of this Glob output — re-run a narrower command — target a specific path, request fewer entries, or pipe through a filter — to recover the omitted output]\n\ntail";
    const rendered = callAndFinalize(globTool(), { pattern: "**/*" }, textResult(marker, globDetails), 150);
    expect(rendered.call.join(" ")).toContain("clipped");
    expect(rendered.call.join(" ")).toContain("cap is fixed");
    expect(rendered.call.join(" ")).not.toContain("head_limit");
  });

  it("does not parse exact clip grammar inside feedback as status", () => {
    const marker =
      "[PiCC clipped 9 characters from the middle of this Grep output — re-run the search with a tighter pattern or a smaller head_limit/offset to recover the omitted matches]";
    const rendered = callAndFinalize(
      grepTool(), { pattern: "x" }, textResult("ordinary", grepDetails, [{ type: "text", text: marker }]), 140,
    );
    expect(rendered.call.join(" ")).not.toContain("clipped");
    expect(rendered.result.join(" ")).toContain("PiCC clipped");
  });

  it("snapshots mutable args and feedback before delayed rendering", () => {
    const tool = grepTool();
    const args = { pattern: "before", path: "/before/path" };
    const ctx = context(args);
    const call = tool.renderCall(args, undefined, ctx);
    args.pattern = "after";
    args.path = "/after/path";
    expect(call.render(120).join(" ")).toContain("before");
    expect(call.render(120).join(" ")).not.toContain("after");

    const block = { type: "text", text: "feedback-before" };
    const result = tool.renderResult(
      textResult("ordinary", grepDetails, [block]),
      { expanded: false, isPartial: false }, undefined, ctx,
    );
    block.text = "feedback-after";
    expect(result.render(80).join(" ")).toContain("feedback-before");
    expect(result.render(80).join(" ")).not.toContain("feedback-after");
  });

  it("keeps non-text and malformed trailing fail-open output observable", () => {
    const malformed = callAndFinalize(
      grepTool(), { pattern: "x" },
      textResult("primary-body", grepDetails, [
        { type: "text", text: "valid trailing" },
        { type: "image", data: "not-an-image", mimeType: "image/png" },
      ]),
    );
    const output = malformed.result.join(" ");
    expect(output).toContain("primary-body");
    expect(output).toContain("valid trailing");
    expect(output.length).toBeGreaterThan(0);
  });

  it("handles hostile themes on call, partial, error, fail-open, feedback, and recovery paths", () => {
    const themes: unknown[] = [
      undefined,
      null,
      {},
      { get fg() { throw new Error("fg getter"); }, get bold() { throw new Error("bold getter"); } },
      { fg: () => null, bold: () => 4 },
      new Proxy({}, { get: () => { throw new Error("theme proxy"); } }),
    ];
    for (const theme of themes) {
      const tool = grepTool();
      const args = { pattern: "x", head_limit: 1 };
      const ctx = context(args);
      const call = tool.renderCall(args, theme, ctx);
      const partial = tool.renderResult(textResult("partial", grepDetails), { expanded: false, isPartial: true }, theme, ctx);
      const failOpen = tool.renderResult(textResult("bad", { bad: true }), { expanded: false, isPartial: false }, theme, ctx);
      const feedback = tool.renderResult(
        textResult("one", { ...grepDetails, totalEntries: 4, returnedEntries: 1 }, [{ type: "text", text: "feedback" }]),
        { expanded: false, isPartial: false }, theme, ctx,
      );
      ctx.isError = true;
      const error = tool.renderResult(textResult("error", undefined), { expanded: false, isPartial: false }, theme, ctx);
      for (const component of [call, partial, failOpen, feedback, error]) {
        expect(() => component.render(32)).not.toThrow();
        expectBounded(component.render(32), 32);
      }
    }
  });

  it("keeps non-text and coercion-hostile fail-open results observable", () => {
    const image = callAndFinalize(
      globTool(),
      { pattern: "*" },
      { content: [{ type: "image", data: "", mimeType: "image/png" }], details: globDetails },
    );
    expect(image.result.join(" ")).toMatch(/image|Unrenderable/iu);

    const hostileText = {
      type: "text",
      text: { toString: () => { throw new Error("coercion"); } },
    };
    const malformed = callAndFinalize(
      grepTool(), { pattern: "x" }, { content: [hostileText], details: grepDetails },
    );
    expect(() => malformed.result.join(" ")).not.toThrow();
    expect(malformed.result.join(" ")).toContain("Unrenderable");
  });

  it("keeps empty-page status ahead of ordinary fields at a narrow practical width", () => {
    const rendered = callAndFinalize(
      grepTool(),
      { pattern: "x", path: "/ordinary/path", offset: 8 },
      textResult("empty", { ...grepDetails, returnedEntries: 0 }),
      16,
    );
    expect(rendered.call.join(" ")).toMatch(/empty page|empty@8/);
    expect(rendered.call.join(" ")).not.toContain("ordinary");
  });

  it("acquires state safely around inherited accessors and proxies while preserving other keys", () => {
    const prototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototype, "compactSearch", { get: () => { throw new Error("inherited"); } });
    const state = Object.assign(Object.create(prototype), { keep: "valid" }) as Record<string, unknown>;
    const args = { pattern: "x" };
    const ctx = { args, state } as RenderContext;
    const tool = grepTool();
    const call = tool.renderCall(args, undefined, ctx);
    tool.renderResult(
      textResult("none", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }),
      { expanded: false, isPartial: false }, undefined, ctx,
    );
    expect(call.render(40).join(" ")).toContain("no matches");
    expect(state.keep).toBe("valid");

    const inheritedContext = Object.assign(
      Object.create({ get state() { return state; } }),
      { args },
    ) as RenderContext;
    const inheritedCall = tool.renderCall(args, undefined, inheritedContext);
    tool.renderResult(
      textResult("none", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }),
      { expanded: false, isPartial: false }, undefined, inheritedContext,
    );
    expect(inheritedCall.render(40).join(" ")).toContain("no matches");
    expect(state.keep).toBe("valid");

    const throwingContext = Object.create(null) as Record<string, unknown>;
    throwingContext.args = args;
    Object.defineProperty(throwingContext, "state", { get: () => { throw new Error("state getter"); } });
    expect(() => tool.renderCall(args, undefined, throwingContext as unknown as RenderContext).render(20)).not.toThrow();

    const proxyState = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("proxy"); } });
    const proxyCtx = { args, state: proxyState } as RenderContext;
    expect(() => tool.renderCall(args, undefined, proxyCtx).render(20)).not.toThrow();
    const visible = tool.renderResult(
      textResult("ordinary-visible-body", grepDetails),
      { expanded: false, isPartial: false }, undefined, proxyCtx,
    ).render(40);
    expect(visible.join(" ")).toContain("ordinary-visible-body");
  });
});

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withCompactSearchRendering } from "../src/runtime/search-tool-render.js";
import { createGuardExtension } from "../src/runtime/guard.js";
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
  cwd?: string;
  isError?: boolean;
  isPartial?: boolean;
  argsComplete?: boolean;
  executionStarted?: boolean;
}

const grepDetails = {
  mode: "files_with_matches",
  engine: "js",
  totalEntries: 2,
  returnedEntries: 2,
  truncated: false,
};

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piTui = piRequire("@earendil-works/pi-tui") as {
  KeybindingsManager: new (definitions: Record<string, unknown>, bindings?: Record<string, unknown>) => unknown;
  TUI_KEYBINDINGS: Record<string, unknown>;
  setKeybindings(manager: unknown): void;
};

const globDetails = {
  totalMatches: 2,
  returned: 2,
  capped: false,
  truncated: false,
};

function grepTool(): RenderTool {
  return withCompactSearchRendering(createGrepTool(() => ".", { forceJs: true })) as unknown as RenderTool;
}

function globTool(): RenderTool {
  return withCompactSearchRendering(createGlobTool(() => ".")) as unknown as RenderTool;
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

describe("compact search rendering decorator", () => {
  it("pins the real Pi grep/find/ls input fields PiCC consumes", () => {
    const cases = [
      [createGrepToolDefinition("/repo"), ["pattern", "path", "glob", "limit"]],
      [createFindToolDefinition("/repo"), ["pattern", "path", "limit"]],
      [createLsToolDefinition("/repo"), ["path", "limit"]],
    ] as const;
    for (const [definition, fields] of cases) {
      const properties = (definition.parameters as { properties: Record<string, unknown> }).properties;
      for (const field of fields) expect(properties).toHaveProperty(field);
    }
  });

  it("preserves execute and every non-render field", () => {
    const source = createGrepTool(() => ".", { forceJs: true });
    const decorated = withCompactSearchRendering(source);
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
      withCompactSearchRendering({ ...source, name: "Other" } as typeof source),
    ).toThrow(/only Grep, Glob, grep, find, or ls/);
  });

  it("freezes search roots per invocation and uses context cwd when the resolver throws", () => {
    const rootA = "/workspace/a";
    const rootB = "/workspace/b";
    for (const entry of [
      { source: createGrepTool(() => ".", { forceJs: true }), args: { pattern: "needle", path: `${rootA}/src` }, result: textResult("a.ts", { ...grepDetails, totalEntries: 1, returnedEntries: 1 }) },
      { source: createGlobTool(() => "."), args: { pattern: "*.ts", path: `${rootA}/src` }, result: textResult("a.ts", { ...globDetails, totalMatches: 1, returned: 1 }) },
    ]) {
      let liveRoot = rootA;
      const tool = withCompactSearchRendering(entry.source, { resolveDisplayRoot: () => liveRoot }) as unknown as RenderTool;
      const argsBefore = structuredClone(entry.args);
      const resultBefore = structuredClone(entry.result);
      const ctx = context(entry.args, { cwd: rootA });
      tool.renderCall(entry.args, undefined, ctx);
      liveRoot = rootB;
      const historical = tool.renderResult(entry.result, { expanded: false, isPartial: false }, undefined, ctx).render(120).join(" ");
      expect(historical).toContain("src");
      expect(historical).not.toContain(rootA);
      expect(historical).not.toContain(rootB);
      expect(entry.args).toEqual(argsBefore);
      expect(entry.result).toEqual(resultBefore);

      const fallback = withCompactSearchRendering(entry.source, {
        resolveDisplayRoot: () => { throw new Error("resolver unavailable"); },
      }) as unknown as RenderTool;
      const fallbackCtx = context(entry.args, { cwd: rootA });
      fallback.renderCall(entry.args, undefined, fallbackCtx);
      const fallbackRow = fallback.renderResult(entry.result, { expanded: false, isPartial: false }, undefined, fallbackCtx)
        .render(120).join(" ");
      expect(fallbackRow).toContain("src");
      expect(fallbackRow).not.toContain(rootA);
      expect(entry.args).toEqual(argsBefore);
      expect(entry.result).toEqual(resultBefore);
    }
  });

  it("keeps display-ready custom Grep and Glob paths compatibility-normalization invariant", () => {
    const path = "K:/secret";
    for (const entry of [
      {
        tool: grepTool(), args: Object.freeze({ pattern: "needle", path }),
        result: textResult("a.ts", grepDetails),
      },
      {
        tool: globTool(), args: Object.freeze({ pattern: "*.ts", path }),
        result: textResult("a.ts", globDetails),
      },
    ]) {
      const argsBefore = structuredClone(entry.args);
      const resultBefore = structuredClone(entry.result);
      const ctx = context(entry.args);
      entry.tool.renderCall(entry.args, undefined, ctx);
      const row = entry.tool.renderResult(entry.result, { expanded: false, isPartial: false }, undefined, ctx)
        .render(120).join(" ");
      expect(row).toContain(path);
      expect(row).not.toContain("K:/secret");
      expect(entry.args).toEqual(argsBefore);
      expect(entry.result).toEqual(resultBefore);
    }
  });

  it("keeps incomplete roots ephemeral, then freezes custom and stock searches at completion", () => {
    for (const source of [
      createGrepTool(() => ".", { forceJs: true }),
      { name: "grep", renderResult: () => ({ render: () => ["native"] }) } as unknown as ToolDefinition,
    ]) {
      let workspace = "/workspace/a";
      const resolver = vi.fn(() => workspace);
      const tool = withCompactSearchRendering(source, { resolveDisplayRoot: resolver }) as unknown as RenderTool;
      const args = { pattern: "needle", path: "/workspace/b/src" };
      const ctx = context(args, {
        cwd: "/workspace/a", argsComplete: false, executionStarted: false,
      });
      tool.renderCall(args, undefined, ctx).render(120);
      expect(resolver).not.toHaveBeenCalled();

      workspace = "/workspace/b";
      ctx.argsComplete = true;
      tool.renderCall(args, undefined, ctx).render(120);
      workspace = "/workspace/c";
      const row = source.name === "grep"
        ? tool.renderCall(args, undefined, ctx).render(120).join(" ")
        : tool.renderResult(
            textResult("a.ts", { ...grepDetails, totalEntries: 1, returnedEntries: 1 }),
            { expanded: false, isPartial: false }, undefined, ctx,
          ).render(120).join(" ");
      expect(row).toContain("src");
      expect(row).not.toContain("/workspace/b");
      expect(row).not.toContain("/workspace/c");
      expect(resolver).toHaveBeenCalledTimes(1);
    }
  });

  it("uses supplied roots for started and reconstructed searches without consulting the live resolver", () => {
    for (const lifecycle of [
      { argsComplete: true, executionStarted: true },
      {},
    ]) {
      const resolver = vi.fn(() => "/mutable");
      const tool = withCompactSearchRendering(createGrepTool(() => ".", { forceJs: true }), {
        resolveDisplayRoot: resolver,
      }) as unknown as RenderTool;
      const args = { pattern: "needle", path: "/history/src" };
      const ctx = context(args, { cwd: "/history", ...lifecycle });
      tool.renderCall(args, undefined, ctx);
      const row = tool.renderResult(
        textResult("a.ts", { ...grepDetails, totalEntries: 1, returnedEntries: 1 }),
        { expanded: false, isPartial: false }, undefined, ctx,
      ).render(120).join(" ");
      expect(row).toContain("src");
      expect(row).not.toContain("/history");
      expect(resolver).not.toHaveBeenCalled();
    }
  });

  it("uses workspace, marked repository fallback, external, and Windows display paths", () => {
    const cases = [
      { workspace: "/repo/worktree", repository: "/repo", path: "/repo/worktree/src", expected: "src" },
      { workspace: "/repo/worktree", repository: "/repo", path: "/repo/shared", expected: "repo:shared" },
      { workspace: "/repo/worktree", repository: "/repo", path: "/outside/src", expected: "/outside/src" },
      { workspace: "/repo/worktree", repository: "/repo", path: "/repo/worktree/repo:literal", expected: "./repo:literal" },
      { workspace: "/repo/worktree", repository: "/repo", path: "/repo/worktree/re\u200Bpo:literal", expected: "re�po:literal" },
      { workspace: "C:\\repo\\worktree", repository: "C:\\repo", path: "C:\\repo\\shared", expected: "repo:shared" },
    ];
    for (const entry of cases) {
      const tool = withCompactSearchRendering(createGrepTool(() => ".", { forceJs: true }), {
        resolveDisplayRoot: () => entry.workspace,
        repositoryRoot: entry.repository,
      }) as unknown as RenderTool;
      const args = { pattern: "needle", path: entry.path };
      const ctx = context(args, { cwd: entry.workspace });
      Object.assign(ctx, { argsComplete: true, executionStarted: false });
      tool.renderCall(args, undefined, ctx);
      const row = tool.renderResult(
        textResult("a.ts", { ...grepDetails, totalEntries: 1, returnedEntries: 1 }),
        { expanded: false, isPartial: false }, undefined, ctx,
      ).render(160).join(" ");
      expect(row).toContain(entry.expected);
    }
  });

  it("hardens allowlisted stock search calls while preserving native results and canonical args", () => {
    for (const entry of [
      {
        name: "grep", args: { pattern: "needle\u001b[31m", path: "/repo/src\rhidden", glob: "*.ts", limit: 5 },
        primary: "needle", metadata: ["in src�hidden", "glob “*.ts”", "limit 5"],
      },
      {
        name: "find", args: { pattern: "**/*.ts\u001b]0;x\u0007", path: "/repo/src\rhidden", limit: 5 },
        primary: "**/*.ts", metadata: ["in src�hidden", "limit 5"],
      },
      {
        name: "ls", args: { path: "/repo/src\rhidden", limit: 5 },
        primary: "src�hidden", metadata: ["limit 5"],
      },
    ] as const) {
      const frozenArgs = Object.freeze(entry.args);
      const nativeResult = () => ({ render: () => ["native detail"] });
      const execute = () => undefined;
      const source = { name: entry.name, execute, renderCall() { return { render: () => ["native call"] }; }, renderResult: nativeResult } as unknown as ToolDefinition;
      const tool = withCompactSearchRendering(source, {
        resolveDisplayRoot: () => "/repo",
        repositoryRoot: "/repo",
      }) as unknown as RenderTool;
      const calls: Array<{ slot: string; text: string }> = [];
      const theme = { fg(slot: string, text: string) { calls.push({ slot, text }); return text; } };
      const ctx = context(frozenArgs, { cwd: "/repo", argsComplete: true, executionStarted: false });
      const wideLine = tool.renderCall(frozenArgs, theme, ctx).render(160).join(" ");
      expect(wideLine).toContain(entry.primary);
      expect(wideLine).not.toMatch(/[\r\u001b\u0007]/u);
      for (const metadata of entry.metadata) {
        expect(wideLine).toContain(metadata);
        expect(calls.some((call) => call.slot === "muted" && call.text.includes(metadata))).toBe(true);
      }
      const narrowLine = tool.renderCall(frozenArgs, theme, ctx).render(18).join(" ");
      expect(narrowLine).toContain(entry.primary);
      expect(narrowLine).not.toContain("limit 5");
      expect(calls.some((call) => call.slot === "accent" && call.text.includes(entry.primary))).toBe(true);
      expect((tool as unknown as { renderResult: unknown }).renderResult).toBe(nativeResult);
      expect((tool as unknown as { execute: unknown }).execute).toBe(execute);
      expect(ctx.args).toBe(frozenArgs);
    }
  });

  it("classifies hostile paths before visible replacement and leaves canonical args detached", () => {
    const args = { pattern: "needle\u001b[31m", path: "/repo/worktree/../shared\rname" };
    const before = structuredClone(args);
    const tool = withCompactSearchRendering(createGrepTool(() => ".", { forceJs: true }), {
      resolveDisplayRoot: () => "/repo/worktree",
      repositoryRoot: "/repo",
    }) as unknown as RenderTool;
    const ctx = context(args, { cwd: "/repo/worktree" });
    Object.assign(ctx, { argsComplete: true, executionStarted: false });
    tool.renderCall(args, undefined, ctx);
    const row = tool.renderResult(
      textResult("a", { ...grepDetails, totalEntries: 1, returnedEntries: 1 }),
      { expanded: false, isPartial: false }, undefined, ctx,
    ).render(120).join(" ");
    expect(row).toContain("repo:shared�name");
    expect(row).not.toMatch(/[\r\u001b]/u);
    expect(args).toEqual(before);
  });

  it("emits no persisted call content before the result is available", () => {
    for (const [tool, args] of [
      [grepTool(), { pattern: "needle", path: "src" }],
      [globTool(), { pattern: "**/*.ts", path: "src" }],
    ] as const) {
      expect(tool.renderCall(args, undefined, context(args)).render(100)).toEqual([]);
    }
  });

  it("keeps ordinary final output collapsed, reveals it once, and hides it again", () => {
    for (const entry of [
      { tool: grepTool(), args: { pattern: "needle" }, body: "a.ts\nb.ts", details: grepDetails, count: "2/2 entries" },
      { tool: globTool(), args: { pattern: "*.ts" }, body: "/a.ts\n/b.ts", details: globDetails, count: "2/2 files" },
    ]) {
      const ctx = context(entry.args);
      expect(entry.tool.renderCall(entry.args, undefined, ctx).render(100)).toEqual([]);
      const render = (expanded: boolean) => entry.tool.renderResult(
        textResult(entry.body, entry.details), { expanded, isPartial: false }, undefined, ctx,
      ).render(100).join("\n");
      const collapsed = render(false);
      expect(collapsed).toContain(entry.count);
      expect(collapsed).toContain("ctrl+o to expand");
      expect(collapsed).not.toContain(entry.body.split("\n")[0]);
      const expanded = render(true);
      for (const line of entry.body.split("\n")) expect(expanded.split(line)).toHaveLength(2);
      expect(render(false)).not.toContain(entry.body.split("\n")[0]);
    }
  });

  it.each([
    { name: "a remapped action", binding: "alt+e", cue: "alt+e to expand", reveals: false },
    { name: "an explicit unbind", binding: [] as string[], cue: "to expand", reveals: true },
  ])("keeps detail reachable with $name", ({ binding, cue, reveals }) => {
    const definitions = {
      ...piTui.TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    };
    piTui.setKeybindings(new piTui.KeybindingsManager(definitions, { "app.tools.expand": binding }));
    try {
      const body = "src/retained.ts:1:needle";
      const rendered = callAndFinalize(
        grepTool(), { pattern: "needle" },
        textResult(body, { ...grepDetails, totalEntries: 1, returnedEntries: 1 }), 120, false,
      ).result.join("\n");
      expect(rendered.includes(body)).toBe(reveals);
      if (reveals) expect(rendered).not.toContain(cue);
      else expect(rendered).toContain(cue);
    } finally {
      piTui.setKeybindings(new piTui.KeybindingsManager(piTui.TUI_KEYBINDINGS));
    }
  });

  it("does not let hostile patterns impersonate full or compact renderer-owned cues", () => {
    const definitions = {
      ...piTui.TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    };
    piTui.setKeybindings(new piTui.KeybindingsManager(definitions, { "app.tools.expand": "alt+e" }));
    try {
      for (const pattern of ["project alt+e label", "project alt+e to expand label"]) {
        const rendered = callAndFinalize(
          grepTool(), { pattern },
          textResult("owned-hidden-detail", { ...grepDetails, totalEntries: 1, returnedEntries: 1 }), 120, false,
        ).result.join("\n");
        expect(rendered.match(/alt\+e/gu)).toHaveLength(2);
        expect(rendered).not.toContain("owned-hidden-detail");
      }
    } finally {
      piTui.setKeybindings(new piTui.KeybindingsManager(piTui.TUI_KEYBINDINGS));
    }
  });

  it("keeps a truthful cue with hostile labels at narrow widths and fails open when no cue fits", () => {
    const definitions = {
      ...piTui.TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    };
    piTui.setKeybindings(new piTui.KeybindingsManager(definitions, { "app.tools.expand": "alt+e" }));
    try {
      const args = { pattern: `${"hostile".repeat(40)}\u001b[31m`, path: `/very/${"long/".repeat(30)}target` };
      const result = textResult("Z-retained", { ...grepDetails, totalEntries: 1, returnedEntries: 1 });
      const before = structuredClone(result);
      const narrow = callAndFinalize(grepTool(), args, result, 8).result;
      expect(narrow.join("\n")).toContain("alt+e");
      expect(narrow.join("\n")).not.toContain("Z-retained");
      expectBounded(narrow, 8);

      const tooNarrow = callAndFinalize(grepTool(), args, result, 3).result.join("");
      expect(tooNarrow).not.toContain("alt+e");
      expect(tooNarrow).toContain("Z-retained");
      expect(result).toEqual(before);
    } finally {
      piTui.setKeybindings(new piTui.KeybindingsManager(piTui.TUI_KEYBINDINGS));
    }
  });

  it("distinguishes zero matches, zero files, and an empty Grep page", () => {
    const zeroGrep = callAndFinalize(
      grepTool(),
      { pattern: "x" },
      textResult("No matches found", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }),
    );
    expect(zeroGrep.result.join(" ")).toContain("no matches");

    const zeroGlob = callAndFinalize(
      globTool(),
      { pattern: "x" },
      textResult("No files found", { ...globDetails, totalMatches: 0, returned: 0 }),
    );
    expect(zeroGlob.result.join(" ")).toContain("no files");

    const emptyPage = callAndFinalize(
      grepTool(),
      { pattern: "x", offset: 8 },
      textResult("No entries at offset 8 (2 total)", { ...grepDetails, returnedEntries: 0 }),
    );
    expect(emptyPage.result.join(" ")).toContain("empty page at offset 8");
    expect(emptyPage.result.join(" ")).not.toContain("no matches");
  });

  it("treats every positive Grep offset as incomplete while preserving empty-page status", () => {
    const remainingPage = callAndFinalize(
      grepTool(),
      { pattern: "needle", offset: 2 },
      textResult("three remaining", { ...grepDetails, totalEntries: 5, returnedEntries: 3 }),
      140,
    );
    expect(remainingPage.result.join(" ")).toContain("offset 2");
    expect(remainingPage.result.join(" ")).toContain("head_limit/offset");

    const emptyPage = callAndFinalize(
      grepTool(),
      { pattern: "needle", offset: 8 },
      textResult("empty", { ...grepDetails, returnedEntries: 0 }),
      140,
    );
    expect(emptyPage.result.join(" ")).toContain("empty page at offset 8");
    expect(emptyPage.result.join(" ")).toContain("head_limit/offset");
  });

  it("shows limited, capped, truncated, and simultaneous statuses with tool-specific recovery", () => {
    const limited = callAndFinalize(
      grepTool(),
      { pattern: "x", head_limit: 2 },
      textResult("a\nb", { ...grepDetails, totalEntries: 9, truncated: true }),
      140,
    );
    expect(limited.result.join(" ")).toContain("limited + truncated");
    expect(limited.result.join(" ")).toContain("head_limit/offset");
    expect(limited.result).toHaveLength(1);

    const capped = callAndFinalize(
      globTool(),
      { pattern: "**/*" },
      textResult("many", { totalMatches: 250, returned: 200, capped: true, truncated: true }),
      140,
    );
    expect(capped.result.join(" ")).toContain("capped + truncated");
    expect(capped.result.join(" ")).toContain("cap is fixed");
  });

  it("moves fixed recovery below the row when practical inline space is unavailable", () => {
    const rendered = callAndFinalize(
      grepTool(),
      { pattern: "needle", head_limit: 1 },
      textResult("a", { ...grepDetails, totalEntries: 5, returnedEntries: 1 }),
      32,
    );
    expect(rendered.result.length).toBeGreaterThan(1);
    expect(rendered.result[0]).toContain("limited");
    expect(rendered.result.join(" ")).toContain("Recovery:");
    expect(rendered.result.join(" ")).toContain("head_limit/offset");
    expectBounded(rendered.result, 32);
  });

  it("recognizes only exact standalone PiCC clip markers", () => {
    const marker =
      "head\n\n[PiCC clipped 123 characters from the middle of this Grep output — re-run the search with a tighter pattern or a smaller head_limit/offset to recover the omitted matches]\n\ntail";
    const exact = callAndFinalize(grepTool(), { pattern: "x" }, textResult(marker, grepDetails), 140);
    expect(exact.result.join(" ")).toContain("clipped");
    expect(exact.result.join(" ")).toContain("head_limit/offset");

    const lookalike = callAndFinalize(
      grepTool(),
      { pattern: "x" },
      textResult("prefix [PiCC clipped 123 characters from this output] suffix", grepDetails),
      140,
    );
    expect(lookalike.result.join(" ")).not.toContain("clipped");
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

  it("treats CRLF as one line boundary, neutralizes lone CR, and preserves canonical bytes", () => {
    const hostile = "first\r\nsecond\rthird\u0000\u0085\u001b[31mred\u001b]0;title\u0007\u009b32mgreen\u009dtitle\u009c\u001b]unterminated\t中🙂\u202eend";
    const result = textResult(hostile, { ...grepDetails, totalEntries: 1, returnedEntries: 1 });
    const before = structuredClone(result);
    const rendered = callAndFinalize(grepTool(), { pattern: "x" }, result, 80, true).result;
    expect(rendered[1]).toBe("first");
    expect(rendered[2]).toContain("second�third�");
    expect(rendered.join("\n")).toContain("red");
    expect(rendered.join("\n")).not.toMatch(/[\r\u0000\u0085\u001b\u009b\u009d\u009c\u202e]/u);
    expectBounded(rendered, 80);
    expect(result).toEqual(before);
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe(hostile);
  });

  it("uses guard clipping metadata when the default-sized marker is outside inspected edges", async () => {
    const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
    createGuardExtension({
      engine: {} as never,
      hooks: { hasHooks: () => false } as never,
      getCwd: () => ".",
      clipMaxTokens: 20_000,
    })({ on: (event: string, handler: (payload: unknown, context: unknown) => unknown) => handlers.set(event, handler) } as never);
    const event = {
      toolName: "Grep",
      input: { pattern: "needle" },
      content: [{ type: "text", text: `${"h".repeat(50_000)}${"t".repeat(50_000)}` }],
      details: { ...grepDetails, totalEntries: 1, returnedEntries: 1 },
      isError: false,
    };
    const patch = await handlers.get("tool_result")!(event, {});
    const guarded = { ...event, ...(patch as object) };
    const primary = (guarded.content[0] as { text: string }).text;
    expect(primary.slice(0, 32_768)).not.toContain("[PiCC clipped");
    expect(primary.slice(-32_768)).not.toContain("[PiCC clipped");
    const collapsed = callAndFinalize(grepTool(), event.input, guarded, 120).result.join(" ");
    expect(collapsed).toContain("clipped");
    expect(collapsed).toContain("head_limit/offset");
  });

  it("limits fallback collapsed clip-marker inspection to retained edge windows", () => {
    const hint = "re-run the search with a tighter pattern or a smaller head_limit/offset to recover the omitted matches";
    const marker = `[PiCC clipped 12 characters from the middle of this Grep output — ${hint}]`;
    const middle = `head${"x".repeat(40_000)}\n\n${marker}\n\n${"y".repeat(40_000)}tail`;
    const collapsed = callAndFinalize(grepTool(), { pattern: "x" }, textResult(middle, grepDetails), 120).result.join(" ");
    expect(collapsed).not.toContain("clipped");
    const tail = `head${"x".repeat(70_000)}\n\n${marker}`;
    expect(callAndFinalize(grepTool(), { pattern: "x" }, textResult(tail, grepDetails), 120).result.join(" "))
      .toContain("clipped");
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
      const ctx = context(args);
      const lines = tool.renderResult(
        textResult("ordinary", { ...grepDetails, mode: "content" }),
        { expanded: false, isPartial: false }, undefined, ctx,
      ).render(width);
      expect(lines.length).toBeGreaterThan(0);
      expectBounded(lines, width);
      if (width >= 3) expect(visibleWidth(lines[0] ?? "")).toBeGreaterThan(0);
      expect(lines[0]).not.toMatch(/[\r\n\u0007\u202e]/u);
      expect(lines[0]).not.toContain("[31m");
      expect(lines[0]).not.toContain("]0;x");
    }
  });

  it("displays only effective Grep modifiers", () => {
    const args = { pattern: "x", output_mode: "count", "-A": 3, context: 4, "-o": true, "-i": true };
    const nonContent = callAndFinalize(
      grepTool(), args, textResult("2", { ...grepDetails, mode: "count" }), 160,
    ).result.join(" ");
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
    expect(call.render(80)).toEqual([]);

    const final = tool.renderResult(
      textResult("final match", grepDetails),
      { expanded: false, isPartial: false },
      undefined,
      ctx,
    ).render(80);
    expect(final).toHaveLength(1);
    expect(final.join(" ")).toContain("2/2 entries");
    expect(final.join(" ")).not.toContain("final match");
  });

  it("uses error for failed search status while retaining accent and muted metadata roles", () => {
    const calls: Array<{ slot: string; text: string }> = [];
    const theme = { fg(slot: string, text: string) { calls.push({ slot, text }); return text; } };
    for (const tool of [grepTool(), globTool()]) {
      const args = { pattern: "primary", path: "/ordinary/path" };
      const ctx = context(args, { isError: true });
      tool.renderResult(
        textResult("failure detail", undefined),
        { expanded: false, isPartial: false }, theme, ctx,
      ).render(120);
    }
    expect(calls.filter((call) => call.text === "failed")).toEqual([
      { slot: "error", text: "failed" },
      { slot: "error", text: "failed" },
    ]);
    expect(calls.filter((call) => call.text.includes("primary")).every((call) => call.slot === "accent")).toBe(true);
    expect(calls.some((call) => call.slot === "muted" && call.text === " · ")).toBe(true);
    expect(calls.some((call) => call.slot === "muted" && call.text.includes("in /ordinary/path"))).toBe(true);
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
    expect(call.render(100)).toEqual([]);
    expect(failed.render(100).join(" ")).toContain("failed");
    expect(failed.render(100).join(" ")).toContain("directory exploded");
  });

  it("derives each summary independently from its result context", () => {
    const tool = grepTool();
    const aArgs = { pattern: "alpha" };
    const bArgs = { pattern: "beta", head_limit: 1 };
    const a = tool.renderResult(
      textResult("a", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }),
      { expanded: false, isPartial: false }, undefined, context(aArgs),
    ).render(120).join(" ");
    const b = tool.renderResult(
      textResult("b", { ...grepDetails, totalEntries: 5, returnedEntries: 1 }),
      { expanded: false, isPartial: false }, undefined, context(bArgs),
    ).render(120).join(" ");
    expect(a).toContain("no matches");
    expect(a).not.toContain("limited");
    expect(b).toContain("limited");
    expect(b).not.toContain("no matches");
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
      const lines = tool.renderResult(
        textResult("ordinary", grepDetails), { expanded: false, isPartial: false }, theme, ctx,
      ).render(20);
      expect(lines.length).toBeGreaterThan(0);
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
    ["missing required field", {
      mode: grepDetails.mode,
      engine: grepDetails.engine,
      totalEntries: grepDetails.totalEntries,
      returnedEntries: grepDetails.returnedEntries,
    }],
    ["unknown mode", { ...grepDetails, mode: "paths" }],
    ["unknown engine", { ...grepDetails, engine: "other" }],
  ])("fails open for invalid Grep details: %s", (_label, details) => {
    const rendered = callAndFinalize(grepTool(), { pattern: "x" }, textResult("raw body", details));
    expect(rendered.result.join(" ")).toContain("raw body");
  });

  it("keeps Grep and Glob compact when details gain additive own data fields", () => {
    const grep = callAndFinalize(
      grepTool(),
      { pattern: "x" },
      textResult("hidden grep body", { ...grepDetails, futureMetadata: { source: "new" } }),
    );
    expect(grep.result).toHaveLength(1);
    expect(grep.result.join(" ")).not.toContain("hidden grep body");

    const glob = callAndFinalize(
      globTool(),
      { pattern: "*" },
      textResult("hidden glob body", { ...globDetails, diagnostics: ["additive"] }),
    );
    expect(glob.result).toHaveLength(1);
    expect(glob.result.join(" ")).not.toContain("hidden glob body");
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
    ["missing required field", {
      totalMatches: globDetails.totalMatches,
      returned: globDetails.returned,
      capped: globDetails.capped,
    }],
    ["bad cap count", { totalMatches: 250, returned: 199, capped: true, truncated: false }],
    ["bad cap flag", { totalMatches: 250, returned: 200, capped: false, truncated: false }],
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
        expect(rendered.result).toHaveLength(1);
        expect(rendered.result.join(" ")).toContain("2/2 entries");
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

  it("renders actual zero/fraction execution results with normalized modifiers and counts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-search-render-boundaries-"));
    try {
      fs.writeFileSync(path.join(dir, "f.txt"), "one\ntwo NEEDLE\nthree\nfour\nfive\nsix NEEDLE\nseven\n");
      const source = createGrepTool(() => dir, { forceJs: true });
      const tool = withCompactSearchRendering(source) as unknown as RenderTool;
      const matches = "f.txt:2:two NEEDLE\nf.txt:6:six NEEDLE";
      const contextMatches = [
        "f.txt-1-one",
        "f.txt:2:two NEEDLE",
        "f.txt-3-three",
        "--",
        "f.txt-5-five",
        "f.txt:6:six NEEDLE",
        "f.txt-7-seven",
      ].join("\n");
      const cases = [
        { args: { pattern: "NEEDLE", output_mode: "content", head_limit: 0.9 }, text: "No entries at offset 0 (2 total)", total: 2, returned: 0, include: ["limit 0", "0/2 entries", "limited"], exclude: [] },
        { args: { pattern: "NEEDLE", output_mode: "content", head_limit: -0.1 }, text: matches, total: 2, returned: 2, include: ["limit unlimited", "2/2 entries"], exclude: [" · limited"] },
        { args: { pattern: "NEEDLE", output_mode: "content", head_limit: 0 }, text: matches, total: 2, returned: 2, include: ["limit unlimited", "2/2 entries"], exclude: [" · limited"] },
        { args: { pattern: "NEEDLE", output_mode: "content", offset: 0.9 }, text: matches, total: 2, returned: 2, include: ["2/2 entries"], exclude: ["offset"] },
        { args: { pattern: "NEEDLE", output_mode: "content", offset: -0.1 }, text: matches, total: 2, returned: 2, include: ["2/2 entries"], exclude: ["offset"] },
        { args: { pattern: "NEEDLE", output_mode: "content", context: 0.9 }, text: matches, total: 2, returned: 2, include: ["2/2 entries"], exclude: ["-C"] },
        { args: { pattern: "NEEDLE", output_mode: "content", context: 1.9 }, text: contextMatches, total: 7, returned: 7, include: ["-C 1", "7/7 entries"], exclude: [] },
      ] as const;

      for (const testCase of cases) {
        const result = await source.execute("boundary-contract", testCase.args as never, undefined, undefined, {} as never);
        expect(result).toEqual({
          content: [{ type: "text", text: testCase.text }],
          details: {
            mode: "content",
            engine: "js",
            totalEntries: testCase.total,
            returnedEntries: testCase.returned,
            truncated: false,
          },
        });
        const row = tool.renderResult(
          result,
          { expanded: false, isPartial: false },
          undefined,
          context(testCase.args),
        ).render(240);
        expect(row).toHaveLength(1);
        expect(row.join(" ")).not.toContain(testCase.text);
        for (const expected of testCase.include) expect(row.join(" ")).toContain(expected);
        for (const omitted of testCase.exclude) expect(row.join(" ")).not.toContain(omitted);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps large finite execution results compact under the shared normalization contract", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-search-render-contract-"));
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), "needle\n");
      fs.writeFileSync(path.join(dir, "b.txt"), "needle\n");
      fs.writeFileSync(path.join(dir, "c.txt"), "needle\n");
      const source = createGrepTool(() => dir, { forceJs: true });
      const tool = withCompactSearchRendering(source) as unknown as RenderTool;
      const cases: Record<string, unknown>[] = [
        { pattern: "needle", head_limit: Number.MAX_VALUE },
        { pattern: "needle", head_limit: -Number.MAX_VALUE },
        { pattern: "needle", head_limit: 4_500_000_000_000_000.5 },
        { pattern: "needle", offset: Number.MAX_VALUE },
        { pattern: "needle", offset: -Number.MAX_VALUE },
        { pattern: "needle", offset: 1.9 },
        { pattern: "needle", output_mode: "content", context: Number.MAX_VALUE },
        {
          pattern: "needle",
          output_mode: "content",
          context: Number.MAX_VALUE,
          "-C": -Number.MAX_VALUE,
          "-B": 4_500_000_000_000_000.5,
          "-A": -3.9,
        },
      ];
      for (const args of cases) {
        const result = await source.execute("shared-contract", args as never, undefined, undefined, {} as never);
        const before = JSON.stringify(result);
        const primary = (result.content[0] as { type: "text"; text: string }).text;
        const lines = tool.renderResult(
          result,
          { expanded: false, isPartial: false },
          undefined,
          context(args),
        ).render(240);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join(" ")).not.toContain(primary);
        expect(JSON.stringify(result)).toBe(before);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders resolved context precedence and clamping, omitting ineffective aliases", () => {
    const tool = grepTool();
    const render = (args: Record<string, unknown>) =>
      tool.renderResult(
        textResult("ordinary", { ...grepDetails, mode: "content" }),
        { expanded: false, isPartial: false }, undefined, context(args),
      ).render(240).join(" ");
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
    const row = callAndFinalize(grepTool(), args, textResult("ordinary", grepDetails), 180).result.join(" ");
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
      const row = rendered.result.join(" ");
      expect(row).toContain("2/2 entries");
      expect(row).toContain("in …");
      expect(row).toMatch(/recognizable-(?:posix|win)\.ts/);
      expectBounded(rendered.result, 58);
    }
  });

  it("uses semantic text for search keywords and secondary roles for query, status, and recovery", () => {
    const calls: Array<{ slot: string; text: string }> = [];
    const theme = {
      fg(slot: string, text: string) {
        calls.push({ slot, text });
        return text;
      },
    };
    const rendered = callAndFinalize(
      grepTool(),
      { pattern: "semantic-query", path: "/project/src", head_limit: 1 },
      textResult("one", { ...grepDetails, totalEntries: 4, returnedEntries: 1 }),
      28,
      false,
      theme,
    );
    const keywords = calls.filter((call) => call.text.includes("grep"));
    const queries = calls.filter((call) => call.text.includes("semantic-query"));
    const statuses = calls.filter((call) => /(?:^|[ [·])(?:limited|lim)(?:$|[\] ])/u.test(call.text));
    const recoveries = calls.filter((call) => call.text.includes("Recovery:"));
    expect(keywords).toEqual([{ slot: "text", text: "grep" }]);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((call) => call.slot === "accent")).toBe(true);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((call) => call.slot === "muted")).toBe(true);
    expect(recoveries.length).toBeGreaterThan(0);
    expect(recoveries.every((call) => call.slot === "toolOutput")).toBe(true);
    expectBounded(rendered.result, 28);
  });

  it("keeps actionable status ahead of count and path at narrow widths", () => {
    const rendered = callAndFinalize(
      grepTool(),
      { pattern: "x", path: "/ordinary/path" },
      textResult("none", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }),
      16,
    );
    expect(rendered.result.join(" ")).toContain("none");
    expect(rendered.result.join(" ")).not.toContain("0/0");
    expect(rendered.result.join(" ")).not.toContain("ordinary");
  });

  it("bounds finalized clean and status rows across degenerate and practical widths", () => {
    for (const width of [1, 2, 3, 8, 12, 20, 40, 80, 120]) {
      const clean = globTool().renderResult(
        textResult("ordinary", globDetails), { expanded: false, isPartial: false },
        undefined, context({ pattern: "中🙂" }),
      ).render(width);
      const status = grepTool().renderResult(
        textResult("none", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }),
        { expanded: false, isPartial: false }, undefined, context({ pattern: "x" }),
      ).render(width);
      for (const lines of [clean, status]) {
        expect(lines.length).toBeGreaterThan(0);
        expectBounded(lines, width);
        if (width >= 3) expect(visibleWidth(lines[0] ?? "")).toBeGreaterThan(0);
        expect(lines.join(" ")).not.toContain("ordinary");
      }
      if (width >= 20) expect(status.join(" ")).toMatch(/no matches|none/);
    }
  });

  it("keeps successive result components independent", () => {
    const tool = grepTool();
    const ctx = context({ pattern: "x", head_limit: 1 });
    const limited = tool.renderResult(
      textResult("one", { ...grepDetails, totalEntries: 4, returnedEntries: 1 }),
      { expanded: false, isPartial: false }, undefined, ctx,
    );
    expect(limited.render(120).join(" ")).toContain("limited");
    ctx.args = { pattern: "x" };
    const clean = tool.renderResult(
      textResult("clean", grepDetails), { expanded: false, isPartial: false }, undefined, ctx,
    );
    expect(clean.render(120).join(" ")).toContain("2/2");
    expect(clean.render(120).join(" ")).not.toContain("limited");
    expect(limited.render(120).join(" ")).toContain("limited");
  });

  it("preserves a measured recognizable expression before single and simultaneous statuses", () => {
    const single = callAndFinalize(
      grepTool(), { pattern: "recognizable-expression" },
      textResult("none", { ...grepDetails, totalEntries: 0, returnedEntries: 0 }), 24,
    );
    expect(single.result.join(" ")).toMatch(/rec/);
    expect(single.result.join(" ")).toContain("none");
    expect(single.result.join(" ")).not.toMatch(/[“"]…[”"]/u);

    const simultaneous = callAndFinalize(
      grepTool(), { pattern: "recognizable-expression", head_limit: 1 },
      textResult("one", { ...grepDetails, totalEntries: 5, returnedEntries: 1, truncated: true }), 28,
    );
    expect(simultaneous.result.join(" ")).toMatch(/rec/);
    expect(simultaneous.result.join(" ")).toContain("lim+trunc");
    expect(simultaneous.result.join(" ")).not.toMatch(/[“"]…[”"]/u);
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
      const summaryText = rendered.result[0] ?? "";
      const inline = summaryText.includes("head_limit/offset");
      const separate = rendered.result.slice(1).join(" ").includes("Recovery:");
      expect(inline).toBe(!separate);
      if (inline) {
        expect(summaryText).toMatch(/r/);
        expect(summaryText).toMatch(/limited|lim/);
        expect(summaryText).not.toMatch(/[“"]…[”"]/u);
      }
      expectBounded(rendered.result, width);
    }
  });

  it("recognizes exact Glob clipping and keeps its fixed-cap remedy correct", () => {
    const marker =
      "head\n\n[PiCC clipped 9 characters from the middle of this Glob output — re-run a narrower command — target a specific path, request fewer entries, or pipe through a filter — to recover the omitted output]\n\ntail";
    const rendered = callAndFinalize(globTool(), { pattern: "**/*" }, textResult(marker, globDetails), 150);
    expect(rendered.result.join(" ")).toContain("clipped");
    expect(rendered.result.join(" ")).toContain("cap is fixed");
    expect(rendered.result.join(" ")).not.toContain("head_limit");
  });

  it("does not parse exact clip grammar inside feedback as status", () => {
    const marker =
      "[PiCC clipped 9 characters from the middle of this Grep output — re-run the search with a tighter pattern or a smaller head_limit/offset to recover the omitted matches]";
    const rendered = callAndFinalize(
      grepTool(), { pattern: "x" }, textResult("ordinary", grepDetails, [{ type: "text", text: marker }]), 140,
    );
    expect(rendered.result[0]).not.toContain("clipped");
    expect(rendered.result.slice(1).join(" ")).toContain("PiCC clipped");
  });

  it("snapshots mutable args and feedback before delayed rendering", () => {
    const tool = grepTool();
    const args = { pattern: "before", path: "/before/path" };
    const ctx = context(args);
    const block = { type: "text", text: "feedback-before" };
    const result = tool.renderResult(
      textResult("ordinary", grepDetails, [block]),
      { expanded: false, isPartial: false }, undefined, ctx,
    );
    args.pattern = "after";
    args.path = "/after/path";
    block.text = "feedback-after";
    expect(result.render(120).join(" ")).toContain("before");
    expect(result.render(120).join(" ")).not.toContain("after");
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
    expect(rendered.result.join(" ")).toMatch(/empty page|empty@8/);
    expect(rendered.result.join(" ")).not.toContain("ordinary");
  });

});

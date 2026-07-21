import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { waitUntil } from "./helpers/async.js";
import { withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";
import { wrapForSelfShell } from "../src/runtime/tool-shell.js";

const cases = [
  {
    name: "WebFetch" as const,
    args: { url: "https://example.test/invoked" },
    ordinary: {
      content: [{ type: "text", text: "CANONICAL FETCH BODY" }],
      details: {
        url: "https://example.test/invoked",
        finalUrl: "https://redirect.test/final",
        status: 200,
        contentType: "text/html",
        truncated: true,
      },
      isError: false,
    },
    invocation: "https://example.test/invoked",
    hidden: "CANONICAL FETCH BODY",
  },
  {
    name: "WebSearch" as const,
    args: { query: "contract query" },
    ordinary: {
      content: [{ type: "text", text: "CANONICAL SEARCH TITLE\nCANONICAL SEARCH SNIPPET" }],
      details: { query: "contract query", backend: "duckduckgo", resultCount: 0, truncated: false },
      isError: false,
    },
    invocation: "contract query",
    hidden: "CANONICAL SEARCH TITLE",
  },
  {
    name: "Skill" as const,
    args: { name: "deploy", arguments: "contract staging" },
    ordinary: {
      content: [{ type: "text", text: "CANONICAL SKILL INSTRUCTION SENTINEL" }],
      details: { skill: "deploy" },
      isError: false,
    },
    invocation: "deploy — contract staging",
    hidden: "CANONICAL SKILL INSTRUCTION SENTINEL",
  },
  {
    name: "SlashCommand" as const,
    args: { command: "/deploy contract production" },
    ordinary: {
      content: [{ type: "text", text: "CANONICAL SLASH INSTRUCTION SENTINEL" }],
      details: { skill: "deploy" },
      isError: false,
    },
    invocation: "/deploy contract production",
    hidden: "CANONICAL SLASH INSTRUCTION SENTINEL",
  },
];

type RoutineName = (typeof cases)[number]["name"];

function definition(name: RoutineName): Record<string, unknown> {
  return wrapForSelfShell(withRoutineToolRendering({ name } as never));
}

describe("real Pi routine rendering composition", () => {
  it("preserves Edit call preview state while removing only its outer padding rows", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const directory = mkdtempSync(join(tmpdir(), "picc-edit-render-"));
    const filePath = "edit-target.txt";
    const absolutePath = join(directory, filePath);
    const args = { path: filePath, edits: [{ oldText: "before", newText: "after" }] };
    let invalidations = 0;
    try {
      const source = sdk.createEditToolDefinition(directory);
      const definition = wrapForSelfShell(withRoutineToolRendering(source));
      const component = new sdk.ToolExecutionComponent(
        "edit",
        "edit-contract",
        args,
        {},
        definition,
        { requestRender() { invalidations++; } },
        directory.replace(/\\/g, "/"),
      );
      await import("node:fs/promises").then(({ writeFile }) => writeFile(absolutePath, "before\n"));
      component.setArgsComplete();
      component.render(80);
      await waitUntil({
        predicate: () => invalidations >= 2,
        description: "Edit asynchronous preview invalidation",
      });
      const preview = component.render(80) as string[];
      const result = await source.execute("edit-contract", args, undefined, undefined, {});
      component.updateResult(result, false);
      const settled = component.render(80) as string[];
      const stripAnsi = (line: string) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");

      for (const lines of [preview, settled]) {
        expect(lines[0]).toBe("");
        expect(lines.join("\n")).toContain(filePath);
        expect(lines.join("\n")).toContain("before");
        expect(lines.join("\n")).toContain("after");
        expect(stripAnsi(lines[1] ?? "").trim()).not.toBe("");
        expect(stripAnsi(lines[lines.length - 1] ?? "").trim()).not.toBe("");
        expect(lines.filter((line) => stripAnsi(line).trim() === "")).toHaveLength(2);
      }
      expect(settled.map(stripAnsi)).toEqual(preview.map(stripAnsi));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("drives decorated MultiEdit from pending invocation to one delegated settled diff", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const args = {
      file_path: "src/lifecycle.ts",
      edits: [{ old_string: "OLD_LIFECYCLE", new_string: "NEW_LIFECYCLE" }],
    };
    const canonical = "Successfully applied 1 edit(s) to src/lifecycle.ts.";
    const component = new sdk.ToolExecutionComponent(
      "MultiEdit",
      "multiedit-lifecycle-contract",
      args,
      {},
      wrapForSelfShell(withRoutineToolRendering({ name: "MultiEdit" } as never)),
      { requestRender() {} },
      process.cwd().replace(/\\/g, "/"),
    );
    component.setArgsComplete();
    const stripAnsi = (lines: string[]) => lines
      .map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ""))
      .join("\n");
    const pending = stripAnsi(component.render(100) as string[]);
    expect(pending.match(/src\/lifecycle\.ts/g)).toHaveLength(1);
    expect(pending).not.toContain("OLD_LIFECYCLE");
    expect(pending).not.toContain("NEW_LIFECYCLE");

    component.updateResult({
      content: [{ type: "text", text: canonical }],
      details: {
        filePath: "src/lifecycle.ts",
        edits: 1,
        created: false,
        diff: "-1 OLD_LIFECYCLE\n+1 NEW_LIFECYCLE",
        firstChangedLine: 1,
      },
    }, false);
    for (const expanded of [false, true]) {
      component.setExpanded(expanded);
      const settled = stripAnsi(component.render(100) as string[]);
      expect(settled.match(/src\/lifecycle\.ts/g)).toHaveLength(1);
      expect(settled.match(/OLD_LIFECYCLE/g)).toHaveLength(1);
      expect(settled.match(/NEW_LIFECYCLE/g)).toHaveLength(1);
      expect(settled).not.toContain(canonical);
    }
  });

  it.each([
    {
      name: "EnterWorktree",
      args: { name: "PENDING-ENTER-ONLY" },
      result: {
        content: [{ type: "text", text: "PENDING ENTER SENTINEL / CANONICAL ENTER PROSE" }],
        details: {
          worktreePath: "/repo/wt", branch: "worktree-contract", created: true,
          seeded: [], previousUnlockAttempted: false,
        },
      },
      pending: "EnterWorktree(PENDING-ENTER-ONLY)",
      canonical: "PENDING ENTER SENTINEL / CANONICAL ENTER PROSE",
      row: "EnterWorktree(/repo/wt) on branch worktree-contract",
    },
    {
      name: "ExitWorktree",
      args: { action: "remove" },
      result: {
        content: [{ type: "text", text: "PENDING EXIT SENTINEL / CANONICAL EXIT PROSE" }],
        details: {
          worktreePath: "/repo/wt", outcome: "removed", restorePath: "/repo",
          ok: true, removed: true, orphaned: false, diagnostics: [],
        },
      },
      pending: "ExitWorktree(remove)",
      canonical: "PENDING EXIT SENTINEL / CANONICAL EXIT PROSE",
      row: "ExitWorktree(/repo/wt) removed; restored /repo",
    },
    {
      name: "ExitWorktree",
      args: { action: "keep" },
      result: {
        content: [{ type: "text", text: "Exited worktree (kept): /repo/wt. Working directory restored to /repo." }],
        details: {
          worktreePath: "/repo/wt", outcome: "keep-failed", restorePath: "/repo",
          ok: false, removed: false, orphaned: false, diagnostics: [], error: "unlock denied\nretry",
        },
      },
      pending: "ExitWorktree(keep)",
      canonical: "Exited worktree (kept): /repo/wt. Working directory restored to /repo.",
      row: "ExitWorktree(/repo/wt) keep failed: unlock denied retry; worktree state unknown; restored /repo",
    },
    {
      name: "EnterWorktree",
      args: { name: "PENDING-ENTER-FAILED-PRIOR" },
      result: {
        content: [{ type: "text", text: "CANONICAL ENTER STILL CLAIMS PRIOR KEEP" }],
        details: {
          worktreePath: "/repo/new", branch: "worktree-new", created: true, seeded: [],
          previousUnlockAttempted: true, previousWorktreePath: "/repo/old",
          previousKeepOutcome: "keep-failed", previousKeepError: "unlock denied\nretry",
        },
      },
      pending: "EnterWorktree(PENDING-ENTER-FAILED-PRIOR)",
      canonical: "CANONICAL ENTER STILL CLAIMS PRIOR KEEP",
      row: "EnterWorktree(/repo/new) on branch worktree-new; previous /repo/old keep failed: unlock denied retry; previous worktree state unknown",
    },
  ])("keeps real Pi $name rows purely result-owned", async (entry) => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const component = new sdk.ToolExecutionComponent(
      entry.name,
      `${entry.name}-worktree-contract`,
      entry.args,
      {},
      wrapForSelfShell(withRoutineToolRendering({ name: entry.name } as never)),
      { requestRender() {} },
      process.cwd().replace(/\\/g, "/"),
    );
    component.setArgsComplete();
    const stripAnsi = (line: string) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    const pending = component.render(200) as string[];
    expect(pending).toEqual([]);
    expect(pending.join("\n")).not.toContain(entry.pending);
    expect(pending.join("\n")).not.toContain(entry.canonical);

    component.updateResult(entry.result, false);
    for (const expanded of [false, true]) {
      component.setExpanded(expanded);
      const lines = component.render(200) as string[];
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("");
      expect(stripAnsi(lines[1] ?? "").trim()).toBe(entry.row);
      expect(lines.join("\n")).not.toContain(entry.pending);
      expect(lines.join("\n")).not.toContain(entry.canonical);
    }
  });

  it.each(cases)("gives settled $name exactly one interactive content row in collapsed and expanded modes", async (entry) => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const build = (payload: unknown, partial = false) => {
      const component = new sdk.ToolExecutionComponent(
        entry.name,
        `${entry.name}-contract`,
        entry.args,
        {},
        definition(entry.name),
        { requestRender() {} },
        process.cwd().replace(/\\/g, "/"),
      );
      component.updateResult(payload, partial);
      return component;
    };
    const paint = (component: any, expanded: boolean): string[] => {
      component.setExpanded(expanded);
      const lines = component.render(100) as string[];
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
      return lines;
    };

    for (const expanded of [false, true]) {
      const lines = paint(build(entry.ordinary), expanded);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("");
      expect(lines[1]).toContain(entry.invocation);
      expect(lines.join("\n")).not.toContain(entry.hidden);
    }

    const partial = paint(build(entry.ordinary, true), false).join("\n");
    expect(partial).toContain(entry.hidden);
    const failure = paint(build({ content: [{ type: "text", text: `${entry.name} visible failure` }], isError: true }), false).join("\n");
    expect(failure).toContain(`${entry.name} visible failure`);
    const malformed = paint(build({ content: [{ type: "text", text: `${entry.name} unfamiliar result` }], details: { future: true }, isError: false }), false).join("\n");
    expect(malformed).toContain(`${entry.name} unfamiliar result`);
  });

  it.each(cases.filter((entry) => entry.name === "Skill" || entry.name === "SlashCommand"))("keeps mismatched $name activation identity visible in the interactive TUI", async (entry) => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const component = new sdk.ToolExecutionComponent(
      entry.name,
      `mismatch-${entry.name}`,
      entry.args,
      {},
      definition(entry.name),
      { requestRender() {} },
      process.cwd().replace(/\\/g, "/"),
    );
    const visibleBody = `VISIBLE ${entry.name} IDENTITY MISMATCH`;
    component.updateResult({
      content: [{ type: "text", text: visibleBody }],
      details: { skill: "different-skill" },
      isError: false,
    }, false);
    for (const expanded of [false, true]) {
      component.setExpanded(expanded);
      expect((component.render(100) as string[]).join("\n")).toContain(visibleBody);
    }
  });

  async function htmlHarness(entry: (typeof cases)[number], themeOverride?: unknown) {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIndex = mainUrl.indexOf("/dist/");
    expect(distIndex, "unexpected Pi dist layout").toBeGreaterThan(0);
    const piDist = mainUrl.slice(0, distIndex);
    const htmlModule = await import(`${piDist}/dist/core/export-html/tool-renderer.js`) as any;
    const exportModule = await import(`${piDist}/dist/core/export-html/index.js`) as any;
    const themeModule = await import(`${piDist}/dist/modes/interactive/theme/theme.js`) as any;
    const renderer = htmlModule.createToolHtmlRenderer({
      getToolDefinition: (name: string) => name === entry.name ? definition(entry.name) : undefined,
      theme: themeOverride ?? themeModule.theme,
      cwd: process.cwd(),
      width: 80,
    });
    return { sdk, exportModule, renderer };
  }

  it.each(cases)("keeps ordinary $name HTML result compact while malformed/error results remain visible", async (entry) => {
    const { renderer } = await htmlHarness(entry);
    const id = `html-${entry.name}`;
    expect(renderer.renderCall(id, entry.name, entry.args)).toBe("");
    const rendered = renderer.renderResult(
      id,
      entry.name,
      entry.ordinary.content,
      entry.ordinary.details,
      false,
    );
    expect(rendered?.expanded).toContain(entry.invocation);
    expect(rendered?.expanded).not.toContain(entry.hidden);
    expect(rendered?.collapsed).toBeUndefined();

    for (const [suffix, text, details, isError] of [
      ["error", `${entry.name} HTML failure`, undefined, true],
      ["malformed", `${entry.name} HTML unfamiliar`, { future: true }, false],
    ] as const) {
      const resultId = `${id}-${suffix}`;
      renderer.renderCall(resultId, entry.name, entry.args);
      const visible = renderer.renderResult(
        resultId,
        entry.name,
        [{ type: "text", text }],
        details,
        isError,
      );
      expect(visible?.expanded).toContain(text);
    }
  });

  it.each(cases.filter((entry) => entry.name === "Skill" || entry.name === "SlashCommand"))("keeps mismatched $name activation identity visible in HTML", async (entry) => {
    const { renderer } = await htmlHarness(entry);
    const id = `html-mismatch-${entry.name}`;
    const visibleBody = `VISIBLE ${entry.name} HTML IDENTITY MISMATCH`;
    renderer.renderCall(id, entry.name, entry.args);
    const rendered = renderer.renderResult(
      id,
      entry.name,
      [{ type: "text", text: visibleBody }],
      { skill: "different-skill" },
      false,
    );
    expect(rendered?.expanded).toContain(visibleBody);
    expect(rendered?.expanded).not.toContain(entry.invocation);
  });

  it.each(cases.filter((entry) => entry.name === "Skill" || entry.name === "SlashCommand"))("does not expose ordinary $name bodies when HTML renderer styling degrades", async (entry) => {
    const hostileTheme = {
      bg: (_slot: string, text: string) => text,
      fg() { throw new Error("foreground unavailable"); },
      bold() { throw new Error("bold unavailable"); },
    };
    const { renderer } = await htmlHarness(entry, hostileTheme);
    const id = `html-degraded-${entry.name}`;
    expect(renderer.renderCall(id, entry.name, entry.args)).toBe("");
    const rendered = renderer.renderResult(
      id,
      entry.name,
      entry.ordinary.content,
      entry.ordinary.details,
      false,
    );
    expect(rendered?.expanded).toContain(entry.invocation);
    expect(rendered?.expanded).not.toContain(entry.hidden);
  });

  it("composes worktree structured rows with Pi's real HTML renderer and keeps exceptional text visible", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const piDist = mainUrl.slice(0, mainUrl.indexOf("/dist/"));
    const htmlModule = await import(`${piDist}/dist/core/export-html/tool-renderer.js`) as any;
    const themeModule = await import(`${piDist}/dist/modes/interactive/theme/theme.js`) as any;
    const tools = new Map([
      ["EnterWorktree", wrapForSelfShell(withRoutineToolRendering({ name: "EnterWorktree" } as never))],
      ["ExitWorktree", wrapForSelfShell(withRoutineToolRendering({ name: "ExitWorktree" } as never))],
    ]);
    const renderer = htmlModule.createToolHtmlRenderer({
      getToolDefinition: (name: string) => tools.get(name),
      theme: themeModule.theme,
      cwd: process.cwd(),
      width: 100,
    });
    const enterId = "html-enter-worktree";
    expect(renderer.renderCall(enterId, "EnterWorktree", { name: "html" })).toBe("");
    const ordinary = renderer.renderResult(
      enterId,
      "EnterWorktree",
      [{ type: "text", text: "HIDDEN ENTER CANONICAL" }],
      {
        worktreePath: "/repo/wt", branch: "worktree-html", created: true,
        seeded: [], previousUnlockAttempted: false,
      },
      false,
    );
    expect(ordinary?.expanded).toContain("EnterWorktree(/repo/wt) on branch worktree-html");
    expect(ordinary?.expanded).not.toContain("HIDDEN ENTER CANONICAL");

    const exitId = "html-exit-worktree";
    renderer.renderCall(exitId, "ExitWorktree", { action: "remove" });
    const exceptional = renderer.renderResult(
      exitId,
      "ExitWorktree",
      [{ type: "text", text: "VISIBLE MALFORMED EXIT" }],
      { outcome: "removed", restorePath: "/repo" },
      false,
    );
    expect(exceptional?.expanded).toContain("VISIBLE MALFORMED EXIT");
  });

  it("renders MultiEdit HTML with its path and one delegated diff while malformed/errors stay visible", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const piDist = mainUrl.slice(0, mainUrl.indexOf("/dist/"));
    const htmlModule = await import(`${piDist}/dist/core/export-html/tool-renderer.js`) as any;
    const themeModule = await import(`${piDist}/dist/modes/interactive/theme/theme.js`) as any;
    const definition = wrapForSelfShell(withRoutineToolRendering({ name: "MultiEdit" } as never));
    const renderer = htmlModule.createToolHtmlRenderer({
      getToolDefinition: (name: string) => name === "MultiEdit" ? definition : undefined,
      theme: themeModule.theme,
      cwd: process.cwd(),
      width: 80,
    });
    const args = {
      file_path: "src/html.ts",
      edits: [{ old_string: "old", new_string: "new" }],
    };
    const details = {
      filePath: "src/html.ts",
      edits: 1,
      created: false,
      diff: "-1 old\n+1 new",
      firstChangedLine: 1,
    };
    const id = "html-MultiEdit";
    expect(renderer.renderCall(id, "MultiEdit", args)).toContain("src/html.ts");
    const success = renderer.renderResult(
      id,
      "MultiEdit",
      [{ type: "text", text: "Successfully applied 1 edit(s) to src/html.ts." }],
      details,
      false,
    );
    expect(success?.expanded).toContain("old");
    expect(success?.expanded).toContain("new");
    expect(success?.expanded.match(/old/g)).toHaveLength(1);

    for (const [suffix, text, malformedDetails, isError] of [
      ["error", "MultiEdit HTML failure", undefined, true],
      ["malformed", "MultiEdit HTML unfamiliar", { ...details, future: true }, false],
    ] as const) {
      const resultId = `${id}-${suffix}`;
      renderer.renderCall(resultId, "MultiEdit", args);
      expect(renderer.renderResult(
        resultId,
        "MultiEdit",
        [{ type: "text", text }],
        malformedDetails,
        isError,
      )?.expanded).toContain(text);
    }
  });

  it("delegates MultiEdit HTML collapsed and expanded passes independently without mutating canonical data", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const piDist = mainUrl.slice(0, mainUrl.indexOf("/dist/"));
    const htmlModule = await import(`${piDist}/dist/core/export-html/tool-renderer.js`) as any;
    const themeModule = await import(`${piDist}/dist/modes/interactive/theme/theme.js`) as any;
    const calls: Array<{ result: unknown; options: unknown; context: unknown }> = [];
    const custom = withRoutineToolRendering(
      { name: "MultiEdit" } as never,
      { createEditDefinition: () => ({
        renderResult(result, options, _theme, context) {
          calls.push({ result, options, context });
          const expanded = (options as { expanded: boolean }).expanded;
          return { render: () => [expanded ? "EXPANDED SENTINEL" : "COLLAPSED SENTINEL"] };
        },
      }) },
    );
    const renderer = htmlModule.createToolHtmlRenderer({
      getToolDefinition: (name: string) => name === "MultiEdit" ? wrapForSelfShell(custom) : undefined,
      theme: themeModule.theme,
      cwd: process.cwd(),
      width: 80,
    });
    const args = Object.freeze({
      file_path: "src/frozen-html.ts",
      edits: Object.freeze([Object.freeze({ old_string: "old", new_string: "new" })]),
    });
    const content = Object.freeze([Object.freeze({
      type: "text",
      text: "Successfully applied 1 edit(s) to src/frozen-html.ts.",
    })]);
    const details = Object.freeze({
      filePath: "src/frozen-html.ts",
      edits: 1,
      created: false,
      diff: "-1 old\n+1 new",
      firstChangedLine: 1,
    });
    renderer.renderCall("html-sentinel", "MultiEdit", args);
    const rendered = renderer.renderResult("html-sentinel", "MultiEdit", content, details, false);

    expect(rendered?.collapsed).toContain("COLLAPSED SENTINEL");
    expect(rendered?.expanded).toContain("EXPANDED SENTINEL");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => (call.options as { expanded: boolean }).expanded)).toEqual([false, true]);
    for (const call of calls) {
      const dto = call.result as { content: unknown; details: unknown };
      expect(dto.content).not.toBe(content);
      expect(dto.details).not.toBe(details);
      expect((call.context as { args: unknown }).args).not.toBe(args);
    }
    const collapsedCall = calls[0]! as {
      result: { content: unknown; details: unknown };
      context: { args: unknown; state: unknown };
    };
    const expandedCall = calls[1]! as {
      result: { content: unknown; details: unknown };
      context: { args: unknown; state: unknown };
    };
    expect(collapsedCall.result).not.toBe(expandedCall.result);
    expect(collapsedCall.result.content).not.toBe(expandedCall.result.content);
    expect(collapsedCall.result.details).not.toBe(expandedCall.result.details);
    expect(collapsedCall.context).not.toBe(expandedCall.context);
    expect(collapsedCall.context.args).not.toBe(expandedCall.context.args);
    expect(collapsedCall.context.state).not.toBe(expandedCall.context.state);
    expect(args.file_path).toBe("src/frozen-html.ts");
    expect(content[0]?.text).toBe("Successfully applied 1 edit(s) to src/frozen-html.ts.");
    expect(details.diff).toBe("-1 old\n+1 new");
  });

  it.each(cases)("retains canonical $name session content but excludes it from complete rendered HTML", async (entry) => {
    const { sdk, exportModule, renderer } = await htmlHarness(entry);
    const directory = mkdtempSync(join(tmpdir(), "picc-routine-export-"));
    const outputPath = join(directory, `${entry.name}.html`);
    try {
      const session = sdk.SessionManager.create(directory, directory, {
        id: `compact-${entry.name.toLowerCase()}`,
      });
      const toolCallId = `export-${entry.name}`;
      session.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: entry.name, arguments: entry.args }],
        stopReason: "toolUse",
      } as never);
      session.appendMessage({
        role: "toolResult",
        toolCallId,
        toolName: entry.name,
        content: entry.ordinary.content,
        details: entry.ordinary.details,
        isError: false,
      } as never);

      await exportModule.exportSessionToHtml(session, undefined, { outputPath, toolRenderer: renderer });
      const html = readFileSync(outputPath, "utf8");
      const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
      expect(encoded).toBeDefined();
      const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
      const canonical = data.entries.find(
        (candidate: any) => candidate.message?.role === "toolResult" && candidate.message.toolCallId === toolCallId,
      );
      const rendered = data.renderedTools?.[toolCallId];

      expect(JSON.stringify(canonical?.message?.content)).toContain(entry.hidden);
      expect(rendered?.callHtml).toBeUndefined();
      expect(rendered?.resultHtmlExpanded).toContain(entry.invocation);
      expect(rendered?.resultHtmlExpanded).not.toContain(entry.hidden);
      expect(rendered?.resultHtmlCollapsed).toBeUndefined();
      expect(html).not.toContain(entry.hidden);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

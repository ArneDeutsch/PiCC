import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createBashToolDefinition, initTheme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withDefaultCollapsedToolRendering } from "../src/runtime/default-collapsed-tool-render.js";
import { recognizeMultiEditSuccess, withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";
import { formatDisplayPath, formatToolDisplayName } from "../src/runtime/tool-display.js";

interface Component { render(width: number): string[] }
interface RenderTool {
  name: string;
  execute: unknown;
  parameters?: unknown;
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

function definition(name: "read" | "write" | "bash" | "edit"): RenderTool {
  const execute = () => undefined;
  return withDefaultCollapsedToolRendering({
    name, label: name, description: "test", parameters: {}, execute,
    renderCall(args: unknown) {
      const value = args as { path?: string; content?: string; command?: string };
      return component(name === "bash" ? `native bash ${value.command ?? "..."}` : `native ${name} ${value.path}\n${value.content ?? ""}`);
    },
    renderResult(result: unknown) {
      const value = result as { content: Array<{ text?: string }>; details?: { diff?: string } };
      return component(`native result ${value.details?.diff ?? value.content.map((block) => block.text ?? "").join("\n")}`);
    },
  } as unknown as ToolDefinition) as unknown as RenderTool;
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

function readResult(text: string, details: unknown = undefined): unknown {
  return { content: [{ type: "text", text }], details };
}
function writeResult(path: string, content: string): unknown {
  return { content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }], details: undefined };
}
function editResult(path: string, count: number, diff: string): unknown {
  return {
    content: [{ type: "text", text: `Successfully replaced ${count} block(s) in ${path}.` }],
    details: { diff, patch: diff ? `patch:${diff}` : "", firstChangedLine: diff ? 1 : undefined },
  };
}
function multiResult(path: string, count: number, diff: string): unknown {
  return {
    content: [{ type: "text", text: `Successfully applied ${count} edit(s) to ${path}.` }],
    details: { filePath: path, edits: count, created: false, diff, firstChangedLine: diff ? 1 : undefined },
  };
}

function withBinding<T>(keys: string[] | undefined, run: () => T): T {
  const previous = getKeybindings();
  setKeybindings(new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  }, { "app.tools.expand": keys as never }));
  try { return run(); } finally { setKeybindings(previous); }
}

function settle(tool: RenderTool, args: unknown, result: unknown, expanded = false, flags: Record<string, unknown> = {}): string {
  const state = flags.state ?? {};
  tool.renderCall(args, theme, { args, state, isPartial: false, isError: false, expanded });
  return tool.renderResult(result, { expanded, isPartial: false }, theme,
    { args, state, isPartial: false, isError: false, expanded, ...flags }).render(160).join("\n");
}

describe("display-only tool helpers", () => {
  it("formats canonical names without changing their source values", () => {
    const names = ["WebFetch", "MultiEdit", "TaskOutput", "TodoWrite", "read"] as const;
    expect(names.map(formatToolDisplayName)).toEqual([
      "web fetch", "multi edit", "task output", "todo write", "read",
    ]);
    expect(names).toEqual(["WebFetch", "MultiEdit", "TaskOutput", "TodoWrite", "read"]);
  });

  it("shortens only lexically contained POSIX and Windows paths without filesystem I/O", () => {
    const realpath = vi.spyOn(fs, "realpathSync");
    const stat = vi.spyOn(fs, "statSync");
    const cases = [
      ["/repo", "/repo", "."], ["/repo/", "/repo/", "."],
      ["/repo", "/repo/src/a.ts", "src/a.ts"], ["/repo", "./src/../a.ts", "a.ts"],
      ["/repo/worktree", "..", "/repo"], ["/repo/worktree", "../sibling/a.ts", "/repo/sibling/a.ts"],
      ["/repo", "/repo-sibling/a.ts", "/repo-sibling/a.ts"],
      ["C:\\Repo", "C:\\Repo", "."], ["C:\\Repo\\", "c:/repo/src/a.ts", "src\\a.ts"],
      ["C:\\Repo", ".\\src\\..\\a.ts", "a.ts"], ["C:\\Repo", "C:src\\a.ts", "src\\a.ts"],
      ["C:\\Repo", "..\\sibling", "C:\\sibling"], ["C:\\Repo", "D:other.txt", "D:\\other.txt"],
      ["C:\\Repo", "d:\\outside\\a.ts", "d:\\outside\\a.ts"],
      ["\\\\server\\share\\repo", "\\\\SERVER\\SHARE\\repo\\a.ts", "a.ts"],
      ["\\\\server\\share\\repo\\", "a\\..\\b", "b"],
      ["\\\\server\\share\\repo", "\\\\server\\share2\\a.ts", "\\\\server\\share2\\a.ts"],
      ["C:\\Repo", "c:/repo\\mixed/a.ts", "mixed\\a.ts"],
    ] as const;
    for (const [root, input, expected] of cases) expect(formatDisplayPath(input, root)).toBe(expected);
    expect(realpath).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    realpath.mockRestore();
    stat.mockRestore();
  });

  it.each([
    ["/repo", "\\\\?\\C:\\repo\\a.ts"],
    ["C:\\repo", "\\\\.\\pipe\\name"],
    ["C:\\repo", "\\\\server"],
  ])("leaves malformed or device namespace forms unchanged (%s, %s)", (root, input) => {
    expect(formatDisplayPath(input, root)).toBe(input);
  });
});

describe("default-collapsed tool rendering", () => {
  it("collapses all five ordinary successes and restores native detail", () => withBinding(["alt+x"], () => {
    const cases = [
      { tool: definition("read"), args: { path: "src/read.ts" }, result: readResult("one\ntwo"), summary: "read src/read.ts · 2 lines hidden · alt+x to expand", detail: "one" },
      { tool: definition("write"), args: { path: "src/write.ts", content: "alpha\nbeta" }, result: writeResult("src/write.ts", "alpha\nbeta"), summary: "write src/write.ts · 2 lines hidden · alt+x to expand", detail: "alpha" },
      { tool: definition("edit"), args: { path: "src/edit.ts", edits: [{ oldText: "old", newText: "new" }] }, result: editResult("src/edit.ts", 1, "-old\n+new"), summary: "edit src/edit.ts · 1 edit applied · 2 diff lines hidden · alt+x to expand", detail: "-old" },
      { tool: multiDefinition(), args: { file_path: "src/multi.ts", edits: [{ old_string: "old", new_string: "new" }] }, result: multiResult("src/multi.ts", 1, "-old\n+new"), summary: "multi edit src/multi.ts · 1 edit applied · 2 diff lines hidden · alt+x to expand", detail: "-old" },
      { tool: definition("bash"), args: { command: "printf secret-command" }, result: readResult("secret-output"), summary: "bash printf secret-command · 1 output line hidden · alt+x to expand", detail: "secret-output" },
    ];
    for (const item of cases) {
      const collapsed = settle(item.tool, item.args, item.result);
      expect(collapsed, item.tool.name).toBe(item.summary);
      expect(collapsed, item.tool.name).toContain("alt+x to expand");
      expect(collapsed, item.tool.name).not.toContain(item.detail);
      if (item.tool.name === "bash") expect(collapsed).toContain("secret-command");
      expect(settle(item.tool, item.args, item.result, true), item.tool.name).toContain(item.detail);
    }
  }));

  it("collapses only an exact coherent bounded Read continuation", () => withBinding(["ctrl+o"], () => {
    const tool = definition("read");
    const args = { path: "page.txt", offset: 4, limit: 2 };
    const ordinary = readResult("one\ntwo\n\n[7 more lines in file. Use offset=6 to continue.]");
    const compact = settle(tool, args, ordinary);
    expect(compact).toContain("read page.txt:4-5");
    expect(compact).toBe("read page.txt:4-5 · next offset 6 · 7 more lines · ctrl+o to expand");
    expect(settle(definition("read"), { path: "blank.txt", limit: 3 },
      readResult("one\n\nthree\n\n[4 more lines in file. Use offset=4 to continue.]")))
      .toBe("read blank.txt:1-3 · next offset 4 · 4 more lines · ctrl+o to expand");
    const exceptional = [
      readResult("one\n\n[7 more lines in file. Use offset=6 to continue.]"),
      readResult("one\ntwo\n\n[7 more lines in file. Use offset=9 to continue.]"),
      readResult("one\ntwo\n\n[7 more lines in file. use offset=6 to continue.]"),
      readResult("one\ntwo\n\n[7 more lines in file. Use offset=6 to continue.]\nwarning"),
      readResult("[7 more lines in file. Use offset=6 to continue.]\ntwo\n\n[7 more lines in file. Use offset=6 to continue.]"),
      readResult("one\n[999 more lines in file. Use offset=123 to continue.]\n\n[7 more lines in file. Use offset=6 to continue.]"),
      readResult("one\ntwo\n\n[7 more lines in file. Use offset=6 to continue.]", { warning: true }),
    ];
    for (const result of exceptional) {
      const detailed = settle(definition("read"), args, result);
      expect(detailed).toContain("native read page.txt");
      expect(detailed).toContain("native result");
      expect(detailed).not.toContain("Elaborated result");
      expect(detailed).not.toContain("next offset 6");
    }
  }));

  it("covers exact Read continuation arithmetic and fail-open evidence families", () => withBinding(["ctrl+o"], () => {
    expect(settle(definition("read"), { path: "page", limit: 2 },
      readResult("one\ntwo\n\n[4 more lines in file. Use offset=3 to continue.]")))
      .toContain("page:1-2 · next offset 3");
    expect(settle(definition("read"), { path: "page", offset: 9, limit: 2 },
      readResult("one\ntwo\n\n[4 more lines in file. Use offset=11 to continue.]")))
      .toContain("page:9-10 · next offset 11");

    const cases: Array<{ args: Record<string, unknown>; result: unknown; evidence: string }> = [
      { args: { path: "page", limit: 2 }, result: readResult("one\n\n[4 more lines in file. Use offset=3 to continue.]"), evidence: "4 more lines" },
      { args: { path: "page", limit: 2 }, result: readResult("one\ntwo\n\n[4 More lines in file. Use offset=3 to continue.]"), evidence: "More lines" },
      { args: { path: "page", limit: 2 }, result: readResult("one\ntwo\n\n[4 more lines in file. Use offset =3 to continue.]"), evidence: "offset =3" },
      { args: { path: "page", offset: Number.MAX_SAFE_INTEGER, limit: 1 }, result: readResult("one\n\n[1 more lines in file. Use offset=9007199254740991 to continue.]"), evidence: "more lines" },
      { args: { path: "page", limit: 2 }, result: { content: [{ type: "text", text: "one\ntwo\n\n[4 more lines in file. Use offset=3 to continue.]" }, { type: "text", text: "warning block" }] }, evidence: "warning block" },
      { args: { path: "page", limit: 2 }, result: readResult("one\ntwo\n[Showing lines 1-2 of 7. Use offset=3 to continue.]"), evidence: "Showing lines" },
      { args: { path: "page", limit: 2 }, result: readResult("one\ntwo\n[Truncated: byte limit reached]"), evidence: "Truncated" },
      { args: { path: "page", limit: 2 }, result: readResult("[First line exceeds 50KB]"), evidence: "First line" },
      { args: { path: "page", limit: 2 }, result: readResult("one\ntwo\n[PiCC clipped tool output]"), evidence: "PiCC clipped" },
      { args: { path: "page", limit: 2 }, result: { content: [{ type: "text", text: "future envelope" }], future: true }, evidence: "future envelope" },
      { args: { path: "page", limit: 2 }, result: { content: [{ type: "text", text: "read error" }], isError: true }, evidence: "read error" },
    ];
    for (const entry of cases) {
      const rendered = settle(definition("read"), entry.args, entry.result,
        false, (entry.result as { isError?: boolean }).isError ? { isError: true } : {});
      expect(rendered).toContain(entry.evidence);
      expect(rendered).not.toContain("next offset 3 · ctrl+o to expand");
    }
    const eof = settle(definition("read"), { path: "page", limit: 2 }, readResult("one\ntwo"));
    expect(eof).toContain("2 lines hidden");
    expect(eof).not.toContain("next offset");
  }));

  it("previews the first non-empty physical Bash line and counts only additional non-empty lines", () => withBinding(["ctrl+o"], () => {
    const separators = ["\r\n", "\n", "\r", "\u2028", "\u2029"];
    for (const separator of separators) {
      const command = `${separator}printf '$() ; | & 🙂'${separator}${separator}echo second${separator}   `;
      const rendered = settle(definition("bash"), { command }, readResult("ok"));
      expect(rendered).toContain("printf '$() ; | & 🙂'");
      expect(rendered).toContain("1 more command line");
      expect(rendered).not.toContain("echo second");
    }
  }));

  it("keeps Bash previews terminal-safe across controls, malformed escapes, tabs, and graphemes", () => withBinding(["ctrl+o"], () => {
    const commands = [
      "printf '\\t;|&$(){}[]'\necho hidden",
      "printf '界🙂e\u0301'\necho hidden",
      "printf '\u001b[31mred\u001b[0m'\necho hidden",
      "printf '\u001b]0;title\u0007osc'\necho hidden",
      "printf '\u0000\u0085\u200Bcontrol'\necho hidden",
      "printf '\u001b[31malformed'\necho hidden",
    ];
    for (const command of commands) {
      const tool = definition("bash");
      const args = { command };
      const state = { startedAt: 100, endedAt: 2350 };
      tool.renderCall(args, theme, { args, state, isPartial: false, isError: false });
      const result = readResult("out\nsecond");
      const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme,
        { args, state, isPartial: false, isError: false }).render(120).join("\n");
      expect(collapsed).toContain("1 more command line");
      expect(collapsed).toContain("2 output lines hidden");
      expect(collapsed).toContain("2.3s");
      expect(collapsed).not.toMatch(/[\u0000\u0007\u0085\u200B]/u);
      const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme,
        { args, state, isPartial: false, isError: false }).render(120).join("\n");
      expect(expanded).toContain("native result out");
      expect(expanded).toContain("echo hidden");
      const recollapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme,
        { args, state, isPartial: false, isError: false }).render(120).join("\n");
      expect(recollapsed).toContain("ctrl+o to expand");
      expect(recollapsed).not.toContain("echo hidden");
    }
  }));

  it("counts file whitespace-only tails while matching Bash's full trim", () => withBinding(["ctrl+o"], () => {
    const cases = [
      {
        rendered: settle(definition("read"), { path: "read.ts" }, readResult("body\n \n\t\n\n")),
        expected: "3 lines hidden",
      },
      {
        rendered: settle(definition("read"), { path: "empty.ts" }, readResult("\n\n")),
        expected: "0 lines hidden",
      },
      {
        rendered: settle(definition("bash"), { command: " \n command \n\t" }, readResult("\n output \n\t")),
        expected: "bash command · 1 output line hidden · ctrl+o to expand",
      },
    ];
    for (const entry of cases) expect(entry.rendered).toContain(entry.expected);
  }));

  it("keeps exact no-net mutations compact", () => withBinding(["ctrl+o"], () => {
    const edit = settle(definition("edit"),
      { path: "edit.ts", edits: [{ oldText: "same", newText: "same" }] }, editResult("edit.ts", 1, ""));
    const multi = settle(multiDefinition(),
      { file_path: "multi.ts", edits: [{ old_string: "same", new_string: "same" }] }, multiResult("multi.ts", 1, ""));
    expect(edit).toContain("1 edit applied · no net change · ctrl+o to expand");
    expect(multi).toContain("1 edit applied · no net change · ctrl+o to expand");
  }));

  it("forces visible native detail for each distinct nonordinary family", () => withBinding(["ctrl+o"], () => {
    const cases = [
      { tool: definition("read"), args: { path: "read.ts" }, result: readResult("body\n[2 more lines in file.]"), evidence: "2 more lines" },
      { tool: definition("write"), args: { path: "write.ts", content: "body" }, result: readResult("Recovered write with warning"), evidence: "warning" },
      { tool: definition("edit"), args: { path: "edit.ts", edits: [{ oldText: "a", newText: "b" }] }, result: { ...(editResult("edit.ts", 1, "-a\n+b") as Record<string, unknown>), warning: true }, evidence: "-a" },
      { tool: multiDefinition(), args: { file_path: "multi.ts", edits: [{ old_string: "a", new_string: "b" }] }, result: { ...(multiResult("multi.ts", 1, "-a\n+b") as Record<string, unknown>), details: { future: true } }, evidence: "Successfully applied" },
      { tool: definition("bash"), args: { command: "false" }, result: { content: [{ type: "text", text: "bash failed visibly" }], details: undefined, isError: true }, evidence: "bash failed visibly", flags: { isError: true } },
    ];
    for (const item of cases) {
      const rendered = settle(item.tool, item.args, item.result, false, item.flags ?? {});
      expect(rendered, item.tool.name).toContain(item.evidence);
      expect(rendered, item.tool.name).toContain(formatToolDisplayName(item.tool.name));
      expect(rendered, item.tool.name).not.toContain("Elaborated result");
      expect(rendered, item.tool.name).not.toContain("diff lines hidden");
    }
  }));

  it("requires explicit final and non-error agreement", () => withBinding(["ctrl+o"], () => {
    const tool = definition("read");
    const args = { path: "state.ts" };
    const result = readResult("native-state-detail");
    for (const flags of [{ isPartial: true }, { isError: true }, { isError: undefined }]) {
      expect(settle(tool, args, result, false, flags)).toContain("native-state-detail");
    }
  }));

  it("delegates incomplete live arguments to native renderers", () => withBinding(["ctrl+o"], () => {
    initTheme();
    const bash = withDefaultCollapsedToolRendering(
      createBashToolDefinition(process.cwd()) as unknown as ToolDefinition,
    ) as unknown as RenderTool;
    const bashCall = bash.renderCall({}, theme, { args: {}, state: {}, isPartial: true, expanded: false })
      .render(80).join("\n");
    expect(bashCall).toContain("...");
    expect(bashCall).not.toContain("Unfamiliar arguments");

    const write = definition("write");
    const writeCall = write.renderCall({ path: "streaming.ts" }, theme,
      { args: { path: "streaming.ts" }, state: {}, isPartial: true, expanded: false }).render(80).join("\n");
    expect(writeCall).toContain("native write streaming.ts");
    expect(writeCall).not.toContain("Unfamiliar arguments");
  }));

  it("delegates a shared partial state natively without hiding progress", () => withBinding(["ctrl+o"], () => {
    const tool = definition("bash");
    const args = { command: "printf running-secret" };
    const state = {};
    const call = tool.renderCall(args, theme, { args, state, isPartial: true, expanded: false }).render(80).join("\n");
    const result = tool.renderResult(readResult("rolling output"), { expanded: false, isPartial: true }, theme,
      { args, state, isPartial: true, isError: false }).render(80).join("\n");
    expect(call).toContain("running-secret");
    expect(result).toContain("rolling output");
  }));

  it("fails open to native elaboration when expansion is unbound", () => withBinding([], () => {
    const rendered = settle(definition("write"), { path: "write.ts", content: "native body" },
      writeResult("write.ts", "native body"));
    expect(rendered).toContain("native body");
    expect(rendered).not.toContain("hidden");
  }));

  it("sanitizes bounded strings sent to summaries and native renderers", () => withBinding(["ctrl+o"], () => {
    const unsafe = "src/\u001b]0;terminal-title\u0007safe.ts";
    const tool = definition("read");
    const collapsed = settle(tool, { path: unsafe }, readResult("body"));
    const expanded = settle(tool, { path: unsafe }, readResult("body\u001b]0;output-title\u0007"), true);
    for (const rendered of [collapsed, expanded]) {
      expect(rendered).not.toContain("terminal-title");
      expect(rendered).not.toContain("output-title");
      expect(rendered).not.toContain("\u0007");
    }
  }));

  it("uses semantic theme roles and rejects text-altering or control-injecting theme output", () => withBinding(["ctrl+o"], () => {
    const calls: Array<[string, string]> = [];
    const semanticTheme = {
      fg(slot: string, text: string) { calls.push([slot, text]); return `\u001b[32m${text}\u001b[39m`; },
      bold(text: string) { return `\u001b[1m${text}\u001b[22m`; },
    };
    const args = { path: "src/theme.ts" };
    const state = {};
    const tool = definition("read");
    tool.renderCall(args, semanticTheme, { args, state, isPartial: false, isError: false });
    const styled = tool.renderResult(readResult("body"), { expanded: false, isPartial: false }, semanticTheme,
      { args, state, isPartial: false, isError: false }).render(100).join("");
    expect(calls.some(([slot, text]) => slot === "text" && text === "read")).toBe(true);
    expect(calls.some(([slot, text]) => slot === "toolOutput" && text.includes("theme.ts"))).toBe(true);
    expect(styled).toMatch(/\u001b\[39m/u);

    for (const hostile of [
      { fg: () => "changed" },
      { fg: (_slot: string, text: string) => `\u001b]0;pwn\u0007${text}` },
      { fg: (_slot: string, text: string) => `\u001b[31m${text}` },
      { get fg() { throw new Error("theme getter"); } },
    ]) {
      const localState = {};
      tool.renderCall(args, hostile, { args, state: localState, isPartial: false, isError: false });
      const plain = tool.renderResult(readResult("body"), { expanded: false, isPartial: false }, hostile,
        { args, state: localState, isPartial: false, isError: false }).render(100).join("");
      expect(plain).toContain("read src/theme.ts");
      expect(plain).not.toContain("\u001b");
      expect(plain).not.toContain("changed");
    }
  }));

  it("pins Bash and Read recovery fields before optional telemetry at narrow usable widths", () => withBinding(["ctrl+o"], () => {
    const bash = settle(definition("bash"),
      { command: "printf-a-very-long-command-preview\necho hidden" }, readResult("one\ntwo"), false,
      { state: { startedAt: 0, endedAt: 12_300 } });
    const read = settle(definition("read"), { path: "a/very/long/path/to/page.txt", offset: 20, limit: 2 },
      readResult("one\ntwo\n\n[987 more lines in file. Use offset=22 to continue.]"));
    expect(bash).toContain("ctrl+o to expand");
    expect(read).toContain("next offset 22");
    expect(read).toContain("ctrl+o to expand");
    const renderAt = (tool: RenderTool, args: unknown, result: unknown, width: number) => {
      const state = {};
      tool.renderCall(args, theme, { args, state, isPartial: false, isError: false });
      return tool.renderResult(result, { expanded: false, isPartial: false }, theme,
        { args, state, isPartial: false, isError: false }).render(width).join("");
    };
    const narrowBash = renderAt(definition("bash"), { command: "printf-a-very-long-command-preview\necho hidden" }, readResult("ok"), 45);
    const narrowRead = renderAt(definition("read"), { path: "a/very/long/path/to/page.txt", offset: 20, limit: 2 },
      readResult("one\ntwo\n\n[987 more lines in file. Use offset=22 to continue.]"), 58);
    expect(narrowBash).toMatch(/^bash .+ · ctrl\+o to expand$/u);
    expect(narrowBash).not.toContain("output line");
    expect(narrowRead).toMatch(/next offset 22 · ctrl\+o to expand$/u);
    expect(narrowRead).not.toContain("987 more lines");
  }));

  it("delegates image evidence larger than the text cap without sanitizing its base64 data", () => withBinding(["ctrl+o"], () => {
    const imageData = "A".repeat(1_000_004);
    const tool = withDefaultCollapsedToolRendering({
      name: "read", execute() {},
      renderCall: () => component("native read image.png"),
      renderResult(result: unknown) {
        const image = (result as { content: Array<{ data: string }> }).content[0]!;
        expect(image.data).toBe(imageData);
        return component(`native image evidence ${image.data.length}`);
      },
    } as unknown as ToolDefinition) as unknown as RenderTool;
    const rendered = settle(tool, { path: "image.png" }, {
      content: [{ type: "image", data: imageData, mimeType: "image/png" }], details: undefined,
    }, true);
    expect(rendered).toContain("native image evidence 1000004");
    expect(rendered).not.toContain("Unfamiliar result");
  }));

  it("bounds every row at narrow widths", () => withBinding(["ctrl+o"], () => {
    const tool = definition("read");
    const args = { path: "src/a-very-long-界🙂-path.ts" };
    const state = {};
    tool.renderCall(args, theme, { args, state, isPartial: false, isError: false });
    const row = tool.renderResult(readResult("one\ntwo"), { expanded: false, isPartial: false }, theme,
      { args, state, isPartial: false, isError: false });
    for (const width of [0, 1, 8, 24]) {
      for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }));

  it("preserves execution/schema identity and never mutates canonical objects", () => withBinding(["ctrl+o"], () => {
    const execute = () => undefined;
    const parameters = Object.freeze({ schema: "identity" });
    const source = { ...definition("read"), execute, parameters } as unknown as ToolDefinition;
    const tool = withDefaultCollapsedToolRendering(source) as unknown as RenderTool;
    const args = Object.freeze({ path: "frozen.ts" });
    const result = Object.freeze({ content: Object.freeze([Object.freeze({ type: "text", text: "body" })]), details: undefined });
    expect(tool.execute).toBe(execute);
    expect(tool.parameters).toBe(parameters);
    expect(() => settle(tool, args, result)).not.toThrow();
    expect(result.content[0]?.text).toBe("body");
  }));

  it("uses MultiEdit's one authoritative recognizer", () => {
    const args = { file_path: "multi.ts", edits: [{ old_string: "a", new_string: "b" }] };
    const result = multiResult("multi.ts", 1, "-a\n+b");
    expect(recognizeMultiEditSuccess(result, { isPartial: false }, { args, isPartial: false, isError: false }))
      .toMatchObject({ kind: "displayable", path: "multi.ts", editCount: 1 });
    expect(recognizeMultiEditSuccess(result, { isPartial: false }, { args, isPartial: true, isError: false })).toBeUndefined();
  });
});

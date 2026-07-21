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
import { recognizeMultiEditSuccess, withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";

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
      return component(name === "bash" ? `native bash ${value.command}` : `native ${name} ${value.path}\n${value.content ?? ""}`);
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

describe("default-collapsed tool rendering", () => {
  it("collapses all five ordinary successes and restores native detail", () => withBinding(["alt+x"], () => {
    const cases = [
      { tool: definition("read"), args: { path: "src/read.ts" }, result: readResult("one\ntwo"), summary: "Read src/read.ts · 2 lines hidden", detail: "one" },
      { tool: definition("write"), args: { path: "src/write.ts", content: "alpha\nbeta" }, result: writeResult("src/write.ts", "alpha\nbeta"), summary: "Write src/write.ts · 2 lines hidden", detail: "alpha" },
      { tool: definition("edit"), args: { path: "src/edit.ts", edits: [{ oldText: "old", newText: "new" }] }, result: editResult("src/edit.ts", 1, "-old\n+new"), summary: "Edit src/edit.ts · 1 edit applied · 2 diff lines hidden", detail: "-old" },
      { tool: multiDefinition(), args: { file_path: "src/multi.ts", edits: [{ old_string: "old", new_string: "new" }] }, result: multiResult("src/multi.ts", 1, "-old\n+new"), summary: "MultiEdit src/multi.ts · 1 edit applied · 2 diff lines hidden", detail: "-old" },
      { tool: definition("bash"), args: { command: "printf secret-command" }, result: readResult("secret-output"), summary: "Bash · 1 output line hidden · alt+x to expand · 1 command line hidden", detail: "secret-output" },
    ];
    for (const item of cases) {
      const collapsed = settle(item.tool, item.args, item.result);
      expect(collapsed, item.tool.name).toContain(item.summary);
      expect(collapsed, item.tool.name).toContain("alt+x to expand");
      expect(collapsed, item.tool.name).not.toContain(item.detail);
      if (item.tool.name === "bash") expect(collapsed).not.toContain("secret-command");
      expect(settle(item.tool, item.args, item.result, true), item.tool.name).toContain(item.detail);
    }
  }));

  it("keeps exact no-net mutations compact", () => withBinding(["ctrl+o"], () => {
    const edit = settle(definition("edit"),
      { path: "edit.ts", edits: [{ oldText: "same", newText: "same" }] }, editResult("edit.ts", 1, ""));
    const multi = settle(multiDefinition(),
      { file_path: "multi.ts", edits: [{ old_string: "same", new_string: "same" }] }, multiResult("multi.ts", 1, ""));
    expect(edit).toContain("1 edit applied · no net change");
    expect(multi).toContain("1 edit applied · no net change");
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

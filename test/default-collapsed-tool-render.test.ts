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

const theme = {
  fg(_slot: string, text: string) { return text; },
  bold(text: string) { return text; },
};

function component(text: string): Component {
  return { render: () => text.split("\n") };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function definition(name: "read" | "write" | "bash" | "edit"): RenderTool {
  const execute = () => undefined;
  return withDefaultCollapsedToolRendering({
    name,
    label: name,
    description: "test",
    parameters: {},
    execute,
    renderCall(args: unknown) {
      const data = args as { path?: string; content?: string; command?: string };
      if (name === "bash") return component(`native bash ${data.command ?? "?"}`);
      const path = data.path ?? "?";
      return component(`native ${name} ${path}${data.content === undefined ? "" : `\n${data.content}`}`);
    },
    renderResult(result: unknown) {
      const value = result as { content?: Array<{ text?: string }>; details?: { diff?: string } };
      const text = (value.content ?? []).map((block) => block.text ?? "").join("\n");
      return component(`native result ${name === "edit" ? value.details?.diff ?? text : text}`);
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

function bashResult(text = "(no output)", details: unknown = undefined): unknown {
  return { content: [{ type: "text", text }], details };
}

function editResult(path: string, editCount: number, diff: string, firstChangedLine: number | undefined = diff ? 1 : undefined): unknown {
  return {
    content: [{ type: "text", text: `Successfully replaced ${editCount} block(s) in ${path}.` }],
    details: { diff, patch: diff ? `patch:${diff}` : "", firstChangedLine },
  };
}

function multiEditDefinition(): RenderTool {
  const routine = withRoutineToolRendering(
    { name: "MultiEdit", execute() {} } as unknown as ToolDefinition,
    { createEditDefinition: () => ({
      renderResult(result) {
        return component(`native delegated diff ${(result as { details: { diff: string } }).details.diff}`);
      },
    }) },
  );
  return withDefaultCollapsedToolRendering(routine) as unknown as RenderTool;
}

function multiEditResult(path: string, editCount: number, diff: string, created = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text: created
      ? `Created ${path} with ${editCount} edit(s).`
      : `Successfully applied ${editCount} edit(s) to ${path}.` }],
    details: { filePath: path, edits: editCount, created, diff, firstChangedLine: diff ? 1 : undefined },
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
    const decoratedTool = decorated as unknown as RenderTool;
    decoratedTool.renderCall({ path: "x" }, theme, { state: {}, isPartial: true }).render(80);
    expect(decorated.execute).toBe(execute);
    expect(executions).toBe(0);
    const settledState = {};
    const settledArgs = { path: "x" };
    decoratedTool.renderCall(settledArgs, theme, {
      args: settledArgs, state: settledState, isPartial: false, argsComplete: true, executionStarted: true,
    }).render(80);
    expect(decorated.execute).toBe(execute);
    expect(executions).toBe(0);
    for (const expanded of [false, true]) {
      decoratedTool.renderResult(readResult("settled body\n"), { expanded, isPartial: false }, theme, {
        args: settledArgs, state: settledState, isPartial: false, isError: false, expanded,
      }).render(80);
      expect(decorated.execute).toBe(execute);
      expect(executions).toBe(0);
    }
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

  it("collapses ordinary Edit and MultiEdit successes and restores each native diff exactly once", () => withBindings(["ctrl+k"], () => {
    const editArgs = {
      path: "src/edit.ts",
      edits: [{ oldText: "old", newText: "new" }, { oldText: "before", newText: "after" }],
    };
    const multiArgs = {
      file_path: "src/multi.ts",
      edits: [{ old_string: "old", new_string: "new" }, { old_string: "before", new_string: "after" }],
    };
    const cases = [
      [definition("edit"), editArgs, editResult("src/edit.ts", 2, "-1 old\n+1 new"), "Edit", "src/edit.ts"],
      [multiEditDefinition(), multiArgs, multiEditResult("src/multi.ts", 2, "-1 old\n+1 new"), "MultiEdit", "src/multi.ts"],
    ] as const;
    for (const [tool, args, result, identity, path] of cases) {
      const collapsed = settle(tool, args, result).join("\n");
      expect(collapsed).toContain(identity);
      expect(collapsed).toContain(path);
      expect(collapsed).toContain("2 edits applied");
      expect(collapsed).toContain("2 diff lines hidden");
      expect(collapsed).toContain("ctrl+k to expand");
      expect(collapsed).not.toContain("old");
      expect(collapsed).not.toContain("new");

      const expanded = settle(tool, args, result, true).join("\n");
      expect(expanded.match(/-1 old/g)).toHaveLength(1);
      expect(expanded.match(/\+1 new/g)).toHaveLength(1);
    }
  }));

  it("sanitizes and snapshots frozen mutation summaries at Unicode and narrow widths", () => withBindings(["ctrl+o"], () => {
    const rawPath = "src/界🙂\u001b]0;target-secret\u0007.ts";
    const args = deepFreeze({
      file_path: rawPath,
      edits: deepFreeze([deepFreeze({ old_string: "old", new_string: "new" })]),
    });
    const result = deepFreeze(multiEditResult(rawPath, 1, "-1 old\n+1 new", true));
    const tool = multiEditDefinition();
    const context = contexts(args);
    tool.renderCall(args, theme, context.call);
    const row = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context.result);
    for (const width of [0, 1, 2, 12, 40, 100]) {
      const rendered = row.render(width).join("\n");
      expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
      expect(rendered).not.toContain("target-secret");
      expect(rendered).not.toContain("]0;");
      expect(rendered).not.toContain("\u0007");
    }
    expect(row.render(100).join("\n")).toContain("1 edit applied · 2 diff lines hidden");
    expect(Object.isFrozen(args)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  }));

  it("keeps mutation no-op, oversized, malformed, and error outcomes explicitly elaborated", () => withBindings(["ctrl+o"], () => {
    const edit = definition("edit");
    const editArgs = { path: "noop.ts", edits: [{ oldText: "same", newText: "same" }] };
    const editNoNet = settle(edit, editArgs, editResult("noop.ts", 1, "", undefined)).join("\n");
    expect(editNoNet).toContain("1 edit applied · no net change");
    expect(editNoNet).not.toContain("Elaborated result");

    const multi = multiEditDefinition();
    const multiArgs = { file_path: "multi.ts", edits: [{ old_string: "same", new_string: "same" }] };
    const multiNoNet = settle(multi, multiArgs, multiEditResult("multi.ts", 1, "")).join("\n");
    expect(multiNoNet).toContain("1 edit applied · no net change");
    expect(multiNoNet).not.toContain("Elaborated result");
    expect(settle(multi, multiArgs, { ...multiEditResult("multi.ts", 1, "-1 a\n+1 b"), details: { future: true } }).join("\n"))
      .toContain("Elaborated result");

    const oversizedArgs = { file_path: "large.ts", edits: new Array(1_001) };
    const oversized = {
      content: [{ type: "text", text: "Successfully applied 1001 edit(s) to large.ts." }],
      details: { filePath: "large.ts", edits: 1_001, created: false, diff: "-1 a\n+1 b", firstChangedLine: 1 },
    };
    const oversizedOutput = settle(multi, oversizedArgs, oversized).join("\n");
    expect(oversizedOutput).toContain("Edit details too large to display");
    expect(oversizedOutput).not.toContain("diff lines hidden");

    const errorContext = contexts(editArgs);
    edit.renderCall(editArgs, theme, errorContext.call);
    const error = edit.renderResult(
      { content: [{ type: "text", text: "Could not edit noop.ts" }], details: undefined },
      { expanded: false, isPartial: false }, theme, { ...errorContext.result, isError: true },
    ).render(120).join("\n");
    expect(error).toContain("Elaborated result");
    expect(error).not.toContain("diff lines hidden");
  }));

  it("recognizes mutation no-net only from exact settled non-error evidence", () => withBindings(["ctrl+o"], () => {
    const edit = definition("edit");
    const args = { path: "exact.ts", edits: [{ oldText: "same", newText: "same" }] };
    const canonical = editResult("exact.ts", 1, "", undefined) as Record<string, unknown>;
    const variants: unknown[] = [
      { ...canonical, isError: true },
      { ...canonical, warning: "recovered" },
      { ...canonical, content: [...(canonical.content as unknown[]), { type: "text", text: "warning" }] },
      { ...canonical, content: [{ type: "text", text: "Successfully replaced 2 block(s) in exact.ts." }] },
      { ...canonical, details: { diff: "", patch: "warning", firstChangedLine: undefined } },
      { ...canonical, details: { diff: "", patch: "", firstChangedLine: undefined, warning: true } },
    ];
    for (const result of variants) {
      const rendered = settle(edit, args, result).join("\n");
      expect(rendered).toContain("Elaborated result");
      expect(rendered).not.toContain("no net change");
    }
    const context = contexts(args);
    edit.renderCall(args, theme, context.call);
    for (const [options, resultContext] of [
      [{ expanded: false, isPartial: true }, context.result],
      [{ expanded: false, isPartial: false }, { ...context.result, isPartial: true }],
      [{ expanded: false, isPartial: false }, { ...context.result, isError: true }],
      [{ expanded: false, isPartial: false }, { ...context.result, isError: undefined }],
    ] as const) {
      const rendered = edit.renderResult(canonical, options, theme, resultContext).render(120).join("\n");
      expect(rendered).not.toContain("no net change");
    }

    const multi = multiEditDefinition();
    const multiArgs = { file_path: "exact.ts", edits: [{ old_string: "same", new_string: "same" }] };
    const multiCanonical = multiEditResult("exact.ts", 1, "");
    for (const result of [
      { ...multiCanonical, isError: true },
      { ...multiCanonical, warning: true },
      { ...multiCanonical, content: [...(multiCanonical.content as unknown[]), { type: "text", text: "warning" }] },
      { ...multiCanonical, details: { ...(multiCanonical.details as object), warning: true } },
    ]) {
      const rendered = settle(multi, multiArgs, result).join("\n");
      expect(rendered).toContain("Elaborated result");
      expect(rendered).not.toContain("no net change");
    }

    for (const [options, resultFlags] of [
      [{ expanded: false }, { isPartial: false, isError: false }],
      [{ expanded: false, isPartial: false }, { isError: false }],
      [{ expanded: false, isPartial: true }, { isPartial: false, isError: false }],
      [{ expanded: false, isPartial: false }, { isPartial: true, isError: false }],
      [{ expanded: false, isPartial: false }, { isPartial: false, isError: true }],
      [{ expanded: false, isPartial: false }, { isPartial: false }],
    ] as const) {
      const candidate = multiEditDefinition();
      const state = {};
      candidate.renderCall(multiArgs, theme, { args: multiArgs, state, isPartial: false, isError: false });
      const rendered = candidate.renderResult(multiCanonical, options, theme, {
        args: multiArgs, state, ...resultFlags,
      }).render(120).join("\n");
      expect(rendered).toContain("Elaborated result");
      expect(rendered).not.toContain("no net change");
      expect(rendered).not.toContain("diff lines hidden");
    }
  }));

  it("keeps moderate Edit sets native and makes over-budget Edit detail explicit without native delegation", () => withBindings(["ctrl+o"], () => {
    const moderate = Array.from({ length: 65 }, (_, index) => ({ oldText: `old-${index}`, newText: `new-${index}` }));
    const moderateOutput = settle(
      definition("edit"),
      { path: "moderate.ts", edits: moderate },
      editResult("moderate.ts", 65, "-1 old\n+1 new"),
    ).join("\n");
    expect(moderateOutput).toContain("65 edits applied");
    expect(moderateOutput).toContain("diff lines hidden");

    let callDelegations = 0;
    let resultDelegations = 0;
    const source = {
      name: "edit", execute() {},
      renderCall() { callDelegations++; return component("unsafe original call"); },
      renderResult() { resultDelegations++; return component("unsafe original result"); },
    } as unknown as ToolDefinition;
    const tool = withDefaultCollapsedToolRendering(source) as unknown as RenderTool;
    const hugeArgs = { path: "safe-target.ts", edits: Array.from({ length: 257 }, () => ({ oldText: "a", newText: "b" })) };
    const state = {};
    const call = tool.renderCall(hugeArgs, theme, { args: hugeArgs, state, isPartial: false, isError: false }).render(120).join("\n");
    expect(call).toContain("Edit · edit details too large; details uninspected · target safe-target.ts");
    const result = tool.renderResult(editResult("safe-target.ts", 257, "-1 a\n+1 b"),
      { expanded: false, isPartial: false }, theme,
      { args: hugeArgs, state, isPartial: false, isError: false }).render(120).join("\n");
    expect(result).toContain("safe-target.ts");
    expect(result).toContain("edit details too large");
    expect(callDelegations).toBe(0);
    expect(resultDelegations).toBe(0);
  }));

  it("enforces the complete Edit inspection and detached-display budget matrix", () => withBindings(["ctrl+o"], () => {
    const displayCap = 1_000_000;
    const make = () => {
      const calls = { call: 0, result: 0 };
      const tool = withDefaultCollapsedToolRendering({
        name: "edit", execute() {},
        renderCall() { calls.call++; return component("native call"); },
        renderResult() { calls.result++; return component("native result"); },
      } as never) as unknown as RenderTool;
      return { tool, calls };
    };
    const renderCall = (tool: RenderTool, args: unknown) => tool.renderCall(args, theme, {
      args, state: {}, isPartial: false, isError: false,
    }).render(140).join("\n");
    const renderSettled = (tool: RenderTool, args: unknown, result: unknown) => {
      const state = {};
      tool.renderCall(args, theme, { args, state, isPartial: false, isError: false });
      return tool.renderResult(result, { expanded: false, isPartial: false }, theme, {
        args, state, isPartial: false, isError: false,
      }).render(140).join("\n");
    };
    const ordinaryArgs = { path: "budget-target.ts", edits: [{ oldText: "a", newText: "b" }] };

    const acceptedEdits = make();
    const edits256 = Array.from({ length: 256 }, () => ({ oldText: "a", newText: "b" }));
    expect(renderSettled(acceptedEdits.tool, { path: "budget-target.ts", edits: edits256 },
      editResult("budget-target.ts", 256, "-1 a\n+1 b"))).toContain("256 edits applied");
    expect(acceptedEdits.calls).toEqual({ call: 1, result: 1 });

    const rejectedEdits = make();
    const edits257 = Array.from({ length: 257 }, (_, index) => ({
      oldText: index === 256 ? "SECRET_SUFFIX" : "a", newText: "b",
    }));
    const rejectedEditOutput = renderCall(rejectedEdits.tool, { path: "budget-target.ts", edits: edits257 });
    expect(rejectedEditOutput).toContain("budget-target.ts");
    expect(rejectedEditOutput).toContain("details uninspected");
    expect(rejectedEditOutput).not.toContain("SECRET_SUFFIX");
    expect(rejectedEdits.calls).toEqual({ call: 0, result: 0 });

    const content256 = make();
    const content256Output = renderSettled(content256.tool, ordinaryArgs, {
      content: Array.from({ length: 256 }, () => "handled"),
      details: undefined,
    });
    expect(content256Output).toContain("Elaborated result");
    expect(content256Output).not.toContain("details uninspected");

    const content257 = make();
    const content257Output = renderSettled(content257.tool, ordinaryArgs, {
      content: Array.from({ length: 257 }, (_, index) => index === 256 ? "SECRET_SUFFIX" : "handled"),
      details: undefined,
    });
    expect(content257Output).toContain("details uninspected");
    expect(content257Output).not.toContain("SECRET_SUFFIX");
    expect(content257.calls).toEqual({ call: 1, result: 0 });

    const container257 = make();
    const container257Output = renderSettled(container257.tool, ordinaryArgs,
      Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`field${index}`, index === 256 ? "SECRET_SUFFIX" : true])));
    expect(container257Output).toContain("Elaborated result");
    expect(container257Output).not.toContain("details uninspected");
    expect(container257Output).not.toContain("SECRET_SUFFIX");

    const container258 = make();
    const container258Output = renderSettled(container258.tool, ordinaryArgs,
      Object.fromEntries(Array.from({ length: 258 }, (_, index) => [`field${index}`, index === 257 ? "SECRET_SUFFIX" : true])));
    expect(container258Output).toContain("details uninspected");
    expect(container258Output).not.toContain("SECRET_SUFFIX");
    expect(container258.calls).toEqual({ call: 1, result: 0 });

    const nested = (containers: number, leaf: unknown): unknown => {
      let value = leaf;
      for (let index = 0; index < containers; index++) value = { child: value };
      return value;
    };
    const depthAccepted = make();
    const depthAcceptedOutput = renderSettled(depthAccepted.tool, ordinaryArgs, { probe: nested(7, "SECRET_SUFFIX") });
    expect(depthAcceptedOutput).toContain("Elaborated result");
    expect(depthAcceptedOutput).not.toContain("details uninspected");
    expect(depthAcceptedOutput).not.toContain("SECRET_SUFFIX");

    const depthRejected = make();
    const depthRejectedOutput = renderSettled(depthRejected.tool, ordinaryArgs, { probe: nested(8, "SECRET_SUFFIX") });
    expect(depthRejectedOutput).toContain("details uninspected");
    expect(depthRejectedOutput).not.toContain("SECRET_SUFFIX");
    expect(depthRejected.calls).toEqual({ call: 1, result: 0 });

    const keyedContainer = (count: number, secret = false) => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`key${index}`, secret && index === count - 1 ? "SECRET_SUFFIX" : true]),
    );
    const aggregate1024 = make();
    const aggregate1024Output = renderSettled(aggregate1024.tool, ordinaryArgs, {
      first: keyedContainer(255), second: keyedContainer(255), third: keyedContainer(255), fourth: keyedContainer(255, true),
    });
    expect(aggregate1024Output).toContain("Elaborated result");
    expect(aggregate1024Output).not.toContain("details uninspected");
    expect(aggregate1024Output).not.toContain("SECRET_SUFFIX");

    const aggregate1025 = make();
    const aggregate1025Output = renderSettled(aggregate1025.tool, ordinaryArgs, {
      first: keyedContainer(256), second: keyedContainer(255), third: keyedContainer(255), fourth: keyedContainer(255, true),
    });
    expect(aggregate1025Output).toContain("details uninspected");
    expect(aggregate1025Output).not.toContain("SECRET_SUFFIX");
    expect(aggregate1025.calls).toEqual({ call: 1, result: 0 });

    for (const field of ["oldText", "newText"] as const) {
      const accepted = make();
      const entry = { oldText: "", newText: "", [field]: "x".repeat(displayCap) };
      renderCall(accepted.tool, { path: "boundary.ts", edits: [entry] });
      expect(accepted.calls.call, `${field} boundary`).toBe(1);

      const rejected = make();
      const secret = "SECRET_SUFFIX";
      const oversizedEntry = { oldText: "", newText: "", [field]: "x".repeat(displayCap + 1) + secret };
      const output = renderCall(rejected.tool, { path: "budget-target.ts", edits: [oversizedEntry] });
      expect(output).toContain("budget-target.ts");
      expect(output).toContain("details uninspected");
      expect(output).not.toContain(secret);
      expect(rejected.calls).toEqual({ call: 0, result: 0 });
    }

    const aggregate = make();
    const aggregateOutput = renderCall(aggregate.tool, {
      path: "budget-target.ts",
      edits: [{ oldText: "o".repeat(displayCap), newText: "n".repeat(displayCap) }],
    });
    expect(aggregateOutput).toContain("details uninspected");
    expect(aggregate.calls).toEqual({ call: 0, result: 0 });

    for (const [label, result] of [
      ["content string", { content: [{ type: "text", text: "x".repeat(displayCap + 1) + "SECRET_SUFFIX" }], details: undefined }],
      ["diff string", editResult("budget-target.ts", 1, "x".repeat(displayCap + 1) + "SECRET_SUFFIX")],
      ["patch string", { ...(editResult("budget-target.ts", 1, "-1 a\n+1 b") as Record<string, unknown>), details: {
        diff: "-1 a\n+1 b", patch: "x".repeat(displayCap + 1) + "SECRET_SUFFIX", firstChangedLine: 1,
      } }],
      ["elements", { content: Array.from({ length: 257 }, () => ({ type: "text", text: "SECRET_SUFFIX" })), details: undefined }],
      ["keys", { content: [{ type: "text", text: "ok" }], details: {
        diff: "-1 a\n+1 b", patch: Object.fromEntries(Array.from({ length: 258 }, (_, index) => [`k${index}`, "SECRET_SUFFIX"])), firstChangedLine: 1,
      } }],
      ["depth", { content: [{ type: "text", text: "ok" }], details: {
        diff: "-1 a\n+1 b", patch: { a: { b: { c: { d: { e: { f: { g: { h: "SECRET_SUFFIX" } } } } } } } }, firstChangedLine: 1,
      } }],
    ] as const) {
      const rejected = make();
      const output = renderSettled(rejected.tool, ordinaryArgs, result);
      expect(output, label).toContain("budget-target.ts");
      expect(output, label).toContain("details uninspected");
      expect(output, label).not.toContain("SECRET_SUFFIX");
      expect(rejected.calls, label).toEqual({ call: 1, result: 0 });
    }

    for (const [label, result] of [
      ["content", { content: [{ type: "text", text: "x".repeat(displayCap) }], details: undefined }],
      ["diff", { ...(editResult("budget-target.ts", 1, "x") as Record<string, unknown>), details: {
        diff: "x".repeat(displayCap), patch: "", firstChangedLine: 1,
      } }],
      ["patch", { ...(editResult("budget-target.ts", 1, "-1 a\n+1 b") as Record<string, unknown>), details: {
        diff: "-1 a\n+1 b", patch: "x".repeat(displayCap), firstChangedLine: 1,
      } }],
    ] as const) {
      const accepted = make();
      renderSettled(accepted.tool, ordinaryArgs, result);
      expect(accepted.calls, `${label} boundary`).toEqual({ call: 1, result: 1 });
    }
  }));

  it("does not delegate hostile Edit originals and sanitizes mutation controls", () => withBindings(["ctrl+o"], () => {
    let callDelegations = 0;
    let resultDelegations = 0;
    const tool = withDefaultCollapsedToolRendering({
      name: "edit", execute() {},
      renderCall() { callDelegations++; return component("delegated call"); },
      renderResult() { resultDelegations++; return component("delegated result"); },
    } as never) as unknown as RenderTool;
    let getters = 0;
    const hostileArgs = Object.defineProperty({}, "path", {
      enumerable: true, get() { getters++; throw new Error("hostile getter"); },
    });
    expect(tool.renderCall(hostileArgs, theme, { state: {}, isPartial: false }).render(80).join("\n"))
      .toContain("Unfamiliar arguments");
    expect(callDelegations).toBe(0);
    expect(resultDelegations).toBe(0);
    const validArgs = { path: "safe.ts", edits: [{ oldText: "old", newText: "new" }] };
    const context = contexts(validArgs);
    tool.renderCall(validArgs, theme, context.call);
    const hostileResult = new Proxy({}, {
      ownKeys() { throw new Error("hostile proxy"); },
      getOwnPropertyDescriptor() { throw new Error("hostile proxy"); },
    });
    expect(tool.renderResult(hostileResult, { expanded: false, isPartial: false }, theme, context.result).render(80).join("\n"))
      .toContain("Unfamiliar result");
    expect(getters).toBe(0);
    expect(callDelegations).toBe(1);
    expect(resultDelegations).toBe(0);

    const detachedArgs = { path: "detached.ts", edits: [{ oldText: "old", newText: "new" }] };
    const detached = contexts(detachedArgs);
    tool.renderCall(detachedArgs, theme, detached.call);
    tool.renderResult(editResult("detached.ts", 1, "-1 old\n+1 new"),
      { expanded: false, isPartial: false }, theme, detached.result);
    expect(callDelegations).toBe(2);
    expect(resultDelegations).toBe(1);

    const controlledPath = "src/clean\u001b]0;path-secret\u0007.ts";
    const controlled = settle(definition("edit"),
      { path: controlledPath, edits: [{ oldText: "old", newText: "new" }] },
      editResult(controlledPath, 1, "-1 old\u001b]0;diff-secret\u0007\n+1 new"),
    ).join("\n");
    expect(controlled).not.toContain("path-secret");
    expect(controlled).not.toContain("diff-secret");
    expect(controlled).toContain("diff lines hidden");
  }));

  it("reserves mutation truth before a long target at narrow widths", () => withBindings(["ctrl+o"], () => {
    const changed = settle(definition("edit"), {
      path: "a-very-long-target-name-that-must-yield.ts",
      edits: [{ oldText: "a", newText: "b" }],
    }, editResult("a-very-long-target-name-that-must-yield.ts", 1, "-1 a\n+1 b"));
    const noNet = settle(definition("edit"), {
      path: "a-very-long-target-name-that-must-yield.ts",
      edits: [{ oldText: "a", newText: "a" }],
    }, editResult("a-very-long-target-name-that-must-yield.ts", 1, "", undefined));
    expect(changed.join("\n")).toContain("diff lines hidden");
    const changedTool = definition("edit");
    const changedArgs = { path: "a-very-long-target-name-that-must-yield.ts", edits: [{ oldText: "a", newText: "b" }] };
    const changedContext = contexts(changedArgs);
    changedTool.renderCall(changedArgs, theme, changedContext.call);
    const changedRow = changedTool.renderResult(editResult(changedArgs.path, 1, "-1 a\n+1 b"), { expanded: false, isPartial: false }, theme, changedContext.result);
    expect(changedRow.render(24).join("\n")).toContain("diff hidden");
    expect(noNet.join("\n")).toContain("no net change");
    const noNetTool = definition("edit");
    const noNetContext = contexts(changedArgs);
    noNetTool.renderCall(changedArgs, theme, noNetContext.call);
    const noNetRow = noNetTool.renderResult(editResult(changedArgs.path, 1, "", undefined), { expanded: false, isPartial: false }, theme, noNetContext.result);
    expect(noNetRow.render(26).join("\n")).toContain("no net change");
  }));

  it("requires exact settled agreement while preserving native partial and fail-open lifecycle state", () => withBindings(["ctrl+k"], () => {
    const cases = [
      { label: "settled", optionsPartial: false, contextPartial: false, isError: false, requestedExpanded: false, compact: true, resultExpanded: false, resultPartial: false, callCount: 1, resultCount: 0 },
      { label: "options partial", optionsPartial: true, contextPartial: false, isError: false, requestedExpanded: true, compact: false, resultExpanded: true, resultPartial: true, callCount: 1 },
      { label: "context partial", optionsPartial: false, contextPartial: true, isError: false, requestedExpanded: false, compact: false, resultExpanded: false, resultPartial: true, callCount: 1 },
      { label: "missing options", optionsPartial: undefined, contextPartial: false, isError: false, requestedExpanded: false, compact: false, resultExpanded: true, resultPartial: false, callCount: 2 },
      { label: "missing context", optionsPartial: false, contextPartial: undefined, isError: false, requestedExpanded: false, compact: false, resultExpanded: true, resultPartial: false, callCount: 2 },
      { label: "missing error", optionsPartial: false, contextPartial: false, isError: undefined, requestedExpanded: false, compact: false, resultExpanded: true, resultPartial: false, callCount: 2 },
      { label: "settled error", optionsPartial: false, contextPartial: false, isError: true, requestedExpanded: false, compact: false, resultExpanded: true, resultPartial: false, callCount: 2 },
    ] as const;
    for (const name of ["read", "write"] as const) for (const candidate of cases) {
      const callRecords: Array<{ expanded: boolean; last: unknown; returned: Component }> = [];
      const resultRecords: Array<{ expanded: boolean; isPartial: boolean; last: unknown; returned: Component }> = [];
      const source = {
        name, execute() {},
        renderCall(_args: unknown, _theme: unknown, ctx: { expanded: boolean; lastComponent?: unknown }) {
          const returned = component(`native ${name} call ${ctx.expanded ? "expanded" : "collapsed"}`);
          callRecords.push({ expanded: ctx.expanded, last: ctx.lastComponent, returned });
          return returned;
        },
        renderResult(_result: unknown, options: { expanded: boolean; isPartial: boolean }, _theme: unknown,
          ctx: { lastComponent?: unknown }) {
          const returned = component(`native result ${options.expanded ? "expanded" : "collapsed"}\npreview second line`);
          resultRecords.push({ ...options, last: ctx.lastComponent, returned });
          return returned;
        },
      };
      const tool = withDefaultCollapsedToolRendering(source as never) as unknown as RenderTool;
      const args = name === "read" ? { path: "probe.txt" } : { path: "probe.txt", content: "body" };
      const result = name === "read" ? readResult("body") : writeResult("probe.txt", "body");
      const state = {};
      tool.renderCall(args, theme, { args, state, isPartial: false, isError: false, expanded: false });
      const options = { expanded: candidate.requestedExpanded, ...(candidate.optionsPartial === undefined ? {} : { isPartial: candidate.optionsPartial }) };
      const resultContext = {
        args, state, expanded: candidate.requestedExpanded,
        ...(candidate.contextPartial === undefined ? {} : { isPartial: candidate.contextPartial }),
        ...(candidate.isError === undefined ? {} : { isError: candidate.isError }),
      };
      const rendered = tool.renderResult(result, options, theme, resultContext).render(240).join("\n");
      expect(callRecords, `${name} ${candidate.label}`).toHaveLength(candidate.callCount);
      const expectedResultCount = "resultCount" in candidate ? candidate.resultCount : 1;
      expect(resultRecords, `${name} ${candidate.label}`).toHaveLength(expectedResultCount);
      if (expectedResultCount === 1) {
        expect(resultRecords[0]!.expanded, `${name} ${candidate.label}`).toBe(candidate.resultExpanded);
        expect(resultRecords[0]!.isPartial, `${name} ${candidate.label}`).toBe(candidate.resultPartial);
        expect(resultRecords[0]!.last, `${name} ${candidate.label}`).toBeUndefined();
      }
      if (candidate.callCount === 2) {
        expect(callRecords[1]!.expanded, `${name} ${candidate.label}`).toBe(true);
        expect(callRecords[1]!.last, `${name} ${candidate.label}`).toBe(callRecords[0]!.returned);
      }
      if (candidate.compact) expect(rendered).toMatch(/\bline(?:s)? hidden\b/u);
      else {
        expect(rendered).not.toMatch(/\bline(?:s)? hidden\b/u);
        expect(rendered).toContain("preview second line");
        expect(rendered).not.toContain("Elaborated result");
      }
    }
  }));

  it("collapses Bash without command/output-derived text and restores both only on expansion", () => withBindings(["ctrl+k"], () => {
    const tool = definition("bash");
    const command = "AUTH_TOKEN=env-secret curl -u user:url-secret 'https://url-user:url-pass@host/path?key=query-secret' -H 'Authorization: Bearer bearer-secret' --password arg-secret\nprintf done";
    const output = "output-secret /credential-output/token-secret.log\nbearer-output-token";
    const collapsed = settle(tool, { command }, bashResult(output)).join("\n");
    expect(collapsed).toContain("Bash");
    expect(collapsed).toContain("2 output lines hidden");
    expect(collapsed).toContain("2 command lines hidden");
    expect(collapsed).toContain("ctrl+k to expand");
    for (const sentinel of ["env-secret", "url-secret", "url-user", "url-pass", "query-secret", "bearer-secret", "arg-secret", "output-secret", "token-secret.log", "bearer-output-token", "curl", "printf"]) {
      expect(collapsed).not.toContain(sentinel);
    }

    const context = contexts({ command });
    tool.renderCall({ command }, theme, { ...context.call, expanded: true });
    const expanded = tool.renderResult(bashResult(output), { expanded: true, isPartial: false }, theme,
      { ...context.result, expanded: true }).render(500).join("\n");
    expect(expanded).toContain(command);
    expect(expanded).toContain(output);
    expect(expanded.match(/native bash/g)).toHaveLength(1);
    expect(expanded.match(/native result/g)).toHaveLength(1);
    expect(settle(tool, { command: "true" }, bashResult()).join("\n")).toContain("(no output)");
  }));

  it.each([
    ["\n alpha\n beta \n", "2 output lines hidden"],
    ["  \n\t  ", "(no output)"],
    ["", "(no output)"],
    ["(no output)", "(no output)"],
    ["one\r\ntwo", "2 output lines hidden"],
    ["one\rtwo", "1 output line hidden"],
    ["\u001b[31m\none\u001b[0m", "2 output lines hidden"],
    ["first\u001b]0;title\ncontinued\u0007\nsecond", "2 output lines hidden"],
  ])("counts Bash output after stock display normalization for %j", (output, expected) => withBindings(["ctrl+o"], () => {
    const rendered = settle(definition("bash"), { command: "true" }, bashResult(output)).join("\n");
    expect(rendered).toContain(expected);
  }));

  it.each([
    ["first\u001b[31\nmsecond", "1 command line hidden", "first�second"],
    ["first\u001b]0;title\ncontinued\u0007\nsecond", "2 command lines hidden", "first�\nsecond"],
  ])("counts command lines from the exact sanitized native command DTO for %j", (command, expected, delegated) => withBindings(["ctrl+o"], () => {
    const tool = definition("bash");
    const collapsed = settle(tool, { command }, bashResult("ok")).join("\n");
    expect(collapsed).toContain(expected);
    const context = contexts({ command });
    tool.renderCall({ command }, theme, { ...context.call, expanded: true });
    const expanded = tool.renderResult(bashResult("ok"), { expanded: true, isPartial: false }, theme,
      { ...context.result, expanded: true }).render(500).join("\n");
    expect(expanded).toContain(`native bash ${delegated}`);
    expect(expanded).not.toContain(command);
  }));

  it("counts Pi's visible fallback for an empty Bash command", () => withBindings(["ctrl+o"], () => {
    const collapsed = settle(definition("bash"), { command: "" }, bashResult("ok")).join("\n");
    expect(collapsed).toContain("1 command line hidden");
  }));

  it("enforces Bash Unicode width, identity, summary priority, and truthful narrow fallback", () => withBindings(["ctrl+o"], () => {
    const tool = definition("bash");
    const args = { command: "界-command-secret\nsecond" };
    const context = contexts(args);
    tool.renderCall(args, theme, context.call);
    const row = tool.renderResult(bashResult(Array.from({ length: 12 }, () => "界-output-secret").join("\n")),
      { expanded: false, isPartial: false }, theme, context.result);
    expect(row.render(4).join("\n")).toBe("Bash");
    expect(row.render(20).join("\n")).toBe("Bash · output hidden");
    expect(row.render(32).join("\n")).toContain("12 output lines hidden");
    expect(row.render(32).join("\n")).not.toContain("expand");
    expect(row.render(48).join("\n")).toBe("Bash · 12 output lines hidden · ctrl+o to expand");
    expect(row.render(48).join("\n")).not.toContain("command");
    for (const width of [0, 1, 2, 3, 4, 20, 32, 48, 80]) {
      const rendered = row.render(width).join("\n");
      expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
      if (width >= 4) expect(rendered).toContain("Bash");
      expect(rendered).not.toContain("界");
      if (!rendered.includes("output")) expect(rendered).not.toMatch(/expand|command|\d\.\ds/u);
      if (!rendered.includes("expand")) expect(rendered).not.toMatch(/command|\d\.\ds/u);
    }
  }));

  it("keeps duration-bearing Bash segments in priority order at every narrow boundary", () => withBindings(["ctrl+o"], () => {
    const tool = definition("bash");
    const args = { command: "first\nsecond" };
    const state = { startedAt: 1_000, endedAt: 2_250 };
    tool.renderCall(args, theme, { args, state, isPartial: false, isError: false });
    const row = tool.renderResult(bashResult("one\ntwo"), { expanded: false, isPartial: false }, theme,
      { args, state, isPartial: false, isError: false });
    const output = "Bash · 2 output lines hidden";
    const expansion = `${output} · ctrl+o to expand`;
    const duration = `${expansion} · 1.3s`;
    const command = `${duration} · 2 command lines hidden`;
    expect(row.render(visibleWidth(duration)).join("\n")).toBe(duration);
    expect(row.render(visibleWidth(duration) - 1).join("\n")).toBe(expansion);
    expect(row.render(visibleWidth(command)).join("\n")).toBe(command);
    expect(row.render(visibleWidth(command) - 1).join("\n")).toBe(duration);
    for (const [width, present, absent] of [
      [visibleWidth(output) - 1, "output hidden", /expand|1\.3s|command/u],
      [visibleWidth(expansion) - 1, output, /expand|1\.3s|command/u],
      [visibleWidth(duration) - 1, expansion, /1\.3s|command/u],
      [visibleWidth(command) - 1, duration, /command/u],
    ] as const) {
      const rendered = row.render(width).join("\n");
      expect(rendered).toContain(present);
      expect(rendered).not.toMatch(absent);
    }
  }));

  it("sanitizes Bash controls, bounds commands, clamps narrow summaries, and fails open when expansion is unbound", () => {
    const controlledCommand = "printf before\u001b]0;terminal-secret\u0007after";
    const controlledOutput = "left\u001b[31moutput-secret\u001b[0mright";
    withBindings(["ctrl+o"], () => {
      const tool = definition("bash");
      const args = { command: controlledCommand };
      const result = bashResult(controlledOutput);
      const context = contexts(args);
      tool.renderCall(args, theme, context.call);
      const summary = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context.result);
      for (const width of [0, 1, 2, 6, 40]) {
        const rendered = summary.render(width).join("\n");
        expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
        expect(rendered).not.toContain("terminal-secret");
        expect(rendered).not.toContain("output-secret");
      }
      const expandedContext = contexts(args);
      tool.renderCall(args, theme, { ...expandedContext.call, expanded: true });
      const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme,
        { ...expandedContext.result, expanded: true }).render(200).join("\n");
      expect(expanded).not.toMatch(/[\u001b\u0007]/u);
      expect(expanded).not.toContain("terminal-secret");
      expect(expanded).toContain("before�after");
      expect(expanded).toContain("left�output-secret�right");
      expect(args.command).toBe(controlledCommand);
      expect((result as { content: Array<{ text: string }> }).content[0]!.text).toBe(controlledOutput);

      const capped = tool.renderCall({ command: "x".repeat(1_000_001) }, theme,
        { state: {}, isPartial: false }).render(100).join("\n");
      expect(capped).toContain("Detail inspection limit reached");
      expect(capped).toContain("uninspected");
    });

    withBindings([], () => {
      const tool = definition("bash");
      const args = { command: "unbound-command" };
      const context = contexts(args);
      const call = tool.renderCall(args, theme, context.call).render(100).join("\n");
      const result = tool.renderResult(bashResult("unbound-output"), { expanded: false, isPartial: false }, theme,
        context.result).render(100).join("\n");
      expect(call).toContain("unbound-command");
      expect(result).toContain("unbound-output");
      expect(`${call}\n${result}`).not.toContain("hidden");
    });
  });

  it("settles Bash native result state while collapsed and clears its live interval on success and error", () => withBindings(["ctrl+o"], () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const calls: Array<{ partial: boolean; result: unknown }> = [];
      const source = {
        name: "bash", label: "bash", description: "timer probe", parameters: {}, execute() {},
        renderCall(args: unknown, _theme: unknown, context: { state: Record<string, unknown>; executionStarted?: boolean }) {
          if (context.executionStarted && context.state.startedAt === undefined) context.state.startedAt = Date.now();
          return component(`native command ${(args as { command: string }).command}`);
        },
        renderResult(result: unknown, options: { isPartial: boolean }, _theme: unknown,
          context: { state: Record<string, unknown>; invalidate(): void; isError?: boolean }) {
          calls.push({ partial: options.isPartial, result });
          if (options.isPartial && context.state.interval === undefined) {
            context.state.interval = setInterval(() => context.invalidate(), 1_000);
          }
          if (!options.isPartial || context.isError) {
            context.state.endedAt ??= Date.now();
            if (context.state.interval !== undefined) clearInterval(context.state.interval as ReturnType<typeof setInterval>);
            context.state.interval = undefined;
          }
          return component(`native result ${JSON.stringify(result)}`);
        },
      };
      const tool = withDefaultCollapsedToolRendering(source as never) as unknown as RenderTool;
      const args = { command: "secret-command" };
      const state: Record<string, unknown> = {};
      tool.renderCall(args, theme, { args, state, isPartial: true, executionStarted: true });
      tool.renderResult(bashResult("rolling"), { expanded: false, isPartial: true }, theme,
        { args, state, isPartial: true, isError: false, invalidate() {} });
      expect(vi.getTimerCount()).toBe(1);
      vi.setSystemTime(2_250);
      tool.renderCall(args, theme, { args, state, isPartial: false, executionStarted: true });
      const collapsed = tool.renderResult(bashResult("settled-secret"), { expanded: false, isPartial: false }, theme,
        { args, state, isPartial: false, isError: false, invalidate() {} }).render(120).join("\n");
      expect(collapsed).toContain("1.3s");
      expect(collapsed).not.toContain("settled-secret");
      expect(state.endedAt).toBe(2_250);
      expect(state.interval).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(calls.at(-1)?.partial).toBe(false);

      const errorState: Record<string, unknown> = {};
      tool.renderCall(args, theme, { args, state: errorState, isPartial: true, executionStarted: true });
      tool.renderResult(bashResult("rolling"), { expanded: false, isPartial: true }, theme,
        { args, state: errorState, isPartial: true, isError: false, invalidate() {} });
      expect(vi.getTimerCount()).toBe(1);
      tool.renderCall(args, theme, { args, state: errorState, isPartial: false, executionStarted: true });
      const error = tool.renderResult(bashResult("Command timed out after 1 seconds"), { expanded: false, isPartial: false }, theme,
        { args, state: errorState, isPartial: false, isError: true, invalidate() {} }).render(120).join("\n");
      expect(error).toContain("Elaborated result");
      expect(error).toContain("timed out");
      expect(vi.getTimerCount()).toBe(0);

      const malformedState: Record<string, unknown> = {};
      tool.renderCall(args, theme, { args, state: malformedState, isPartial: true, executionStarted: true });
      tool.renderResult(bashResult("rolling"), { expanded: false, isPartial: true }, theme,
        { args, state: malformedState, isPartial: true, isError: false, invalidate() {} });
      expect(vi.getTimerCount()).toBe(1);
      const malformedArgs = Object.defineProperty({}, "command", { get() { throw new Error("must not run"); } });
      const unfamiliar = tool.renderResult({ future: true }, { expanded: false, isPartial: false }, theme,
        { args: malformedArgs, state: malformedState, isPartial: false, isError: true, invalidate() {} }).render(120).join("\n");
      expect(unfamiliar).toContain("Unfamiliar arguments");
      expect(malformedState.interval).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  }));

  it("settles repeated Bash partials once across every exceptional and disagreeing final shape", () => withBindings(["ctrl+o"], () => {
    vi.useFakeTimers();
    try {
      const cases: Array<{
        name: string; result: unknown; optionsPartial?: boolean; contextPartial?: boolean;
        isError?: boolean; omitOptionsPartial?: boolean; omitContextPartial?: boolean; omitIsError?: boolean; expected: string;
      }> = [
        { name: "nonzero", result: bashResult("Command exited with code 7"), isError: true, expected: "Elaborated result" },
        { name: "timeout", result: bashResult("Command timed out"), isError: true, expected: "Elaborated result" },
        { name: "abort", result: bashResult("Command aborted"), isError: true, expected: "Elaborated result" },
        { name: "error-only-final", result: bashResult("Command failed"), optionsPartial: true, contextPartial: true, isError: true, expected: "Elaborated result" },
        { name: "truncation", result: bashResult("tail", {
          truncation: { content: "tail", truncated: true, truncatedBy: "lines", totalLines: 2, totalBytes: 8,
            outputLines: 1, outputBytes: 4, lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 1, maxBytes: 50_000 },
          fullOutputPath: "/credential-output/token-secret.log",
        }), isError: false, expected: "Elaborated result" },
        { name: "recovery", result: { content: [{ type: "text", text: "ok" }, { type: "text", text: "Recovered partial output" }], details: undefined }, isError: false, expected: "Elaborated result" },
        { name: "additional-block", result: { content: [{ type: "text", text: "ok" }, { type: "text", text: "additional" }], details: undefined }, isError: false, expected: "Elaborated result" },
        { name: "future-details", result: bashResult("ok", { future: true }), isError: false, expected: "Unfamiliar result" },
        { name: "malformed", result: { future: true }, isError: false, expected: "Unfamiliar result" },
        { name: "inspection-capped", result: bashResult("x".repeat(1_000_001)), isError: false, expected: "Detail inspection limit reached" },
        { name: "display-capped", result: bashResult(Array.from({ length: 10_001 }, () => "x").join("\n")), isError: false, expected: "Detail inspection limit reached" },
        { name: "options-final-context-partial", result: bashResult("ordinary"), contextPartial: true, isError: false, expected: "Elaborated result" },
        { name: "options-partial-context-final", result: bashResult("ordinary"), optionsPartial: true, isError: false, expected: "Elaborated result" },
        { name: "options-missing-context-final", result: bashResult("ordinary"), omitOptionsPartial: true, isError: false, expected: "Elaborated result" },
        { name: "options-final-context-missing", result: bashResult("ordinary"), omitContextPartial: true, isError: false, expected: "Elaborated result" },
        { name: "missing-error", result: bashResult("ordinary"), omitIsError: true, expected: "Elaborated result" },
      ];
      for (const item of cases) {
        let serial = 0;
        const nativeCalls: Array<{ partial: boolean; last: unknown; args: unknown; result: unknown; returned: Component }> = [];
        const source = {
          name: "bash", label: "bash", description: item.name, parameters: {}, execute() {},
          renderCall(_args: unknown, _theme: unknown, context: { state: Record<string, unknown>; executionStarted?: boolean }) {
            if (context.executionStarted) context.state.startedAt ??= Date.now();
            return component("native command");
          },
          renderResult(result: unknown, options: { isPartial: boolean }, _theme: unknown,
            context: { state: Record<string, unknown>; lastComponent?: unknown; invalidate(): void }) {
            if (options.isPartial) context.state.interval ??= setInterval(() => context.invalidate(), 1000);
            else {
              context.state.endedAt ??= Date.now();
              if (context.state.interval !== undefined) clearInterval(context.state.interval as ReturnType<typeof setInterval>);
              context.state.interval = undefined;
            }
            const returned = component(`native-${++serial}`);
            nativeCalls.push({ partial: options.isPartial, last: context.lastComponent, args: (context as { args?: unknown }).args, result, returned });
            return returned;
          },
        };
        const tool = withDefaultCollapsedToolRendering(source as never) as unknown as RenderTool;
        const args = { command: `secret-${item.name}` };
        const state: Record<string, unknown> = {};
        tool.renderCall(args, theme, { args, state, isPartial: true, executionStarted: true });
        tool.renderResult(bashResult("rolling-one"), { expanded: false, isPartial: true }, theme,
          { args, state, isPartial: true, isError: false, invalidate() {} });
        tool.renderResult(bashResult("rolling-two"), { expanded: false, isPartial: true }, theme,
          { args, state, isPartial: true, isError: false, invalidate() {} });
        expect(vi.getTimerCount(), item.name).toBe(1);
        expect(nativeCalls[1]!.last, item.name).toBe(nativeCalls[0]!.returned);
        const contextPartial = item.contextPartial ?? false;
        tool.renderCall(args, theme, { args, state, isPartial: contextPartial, executionStarted: true });
        const finalContext = {
          args, state, invalidate() {},
          ...(item.omitContextPartial ? {} : { isPartial: contextPartial }),
          ...(item.omitIsError ? {} : { isError: item.isError ?? false }),
        };
        const finalOptions = {
          expanded: false,
          ...(item.omitOptionsPartial ? {} : { isPartial: item.optionsPartial ?? false }),
        };
        const rendered = tool.renderResult(item.result, finalOptions, theme, finalContext).render(160).join("\n");
        expect(rendered, item.name).toContain(item.expected);
        const finalCalls = nativeCalls.filter((call) => !call.partial);
        expect(finalCalls, item.name).toHaveLength(1);
        expect(finalCalls[0]!.last, item.name).toBe(nativeCalls[1]!.returned);
        expect(state.interval, item.name).toBeUndefined();
        expect(vi.getTimerCount(), item.name).toBe(0);
      }
    } finally { vi.useRealTimers(); }
  }));

  it("preserves capped and truncated primaries when armed native Bash cleanup throws", () => withBindings(["ctrl+o"], () => {
    vi.useFakeTimers();
    try {
      const truncation = {
        truncation: { content: "tail", truncated: true, truncatedBy: "lines", totalLines: 2, totalBytes: 8,
          outputLines: 1, outputBytes: 4, lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 1, maxBytes: 50_000 },
        fullOutputPath: "/credential-output/token-secret.log",
      };
      for (const [result, primary] of [
        [bashResult("x".repeat(1_000_001)), "Detail inspection limit reached"],
        [bashResult(Array.from({ length: 10_001 }, () => "x").join("\n")), "Detail inspection limit reached"],
        [bashResult("tail", truncation), "Elaborated result"],
      ] as const) {
        let serial = 0;
        let cleanupTransitions = 0;
        const calls: Array<{ partial: boolean; last: unknown; returned?: Component }> = [];
        const source = {
          name: "bash", label: "bash", description: "cleanup failure", parameters: {}, execute() {},
          renderCall: () => component("call"),
          renderResult(_result: unknown, options: { isPartial: boolean }, _theme: unknown,
            context: { state: Record<string, unknown>; lastComponent?: unknown; invalidate(): void }) {
            if (options.isPartial) {
              context.state.interval ??= setInterval(() => context.invalidate(), 1_000);
              const returned = component(`partial-${++serial}`);
              calls.push({ partial: true, last: context.lastComponent, returned });
              return returned;
            }
            if (context.state.interval !== undefined) {
              clearInterval(context.state.interval as ReturnType<typeof setInterval>);
              context.state.interval = undefined;
              cleanupTransitions++;
            }
            calls.push({ partial: false, last: context.lastComponent });
            throw new Error("cleanup exploded");
          },
        };
        const tool = withDefaultCollapsedToolRendering(source as never) as unknown as RenderTool;
        const args = { command: "secret" };
        const state: Record<string, unknown> = {};
        tool.renderCall(args, theme, { args, state, isPartial: true });
        tool.renderResult(bashResult("rolling-one"), { expanded: false, isPartial: true }, theme,
          { args, state, isPartial: true, isError: false, invalidate() {} });
        tool.renderResult(bashResult("rolling-two"), { expanded: false, isPartial: true }, theme,
          { args, state, isPartial: true, isError: false, invalidate() {} });
        expect(vi.getTimerCount()).toBe(1);
        expect(calls[1]!.last).toBe(calls[0]!.returned);

        const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, theme,
          { args, state, isPartial: false, isError: false, invalidate() {} }).render(160).join("\n");
        expect(rendered).toContain(primary);
        expect(rendered).toContain("Native cleanup failed");
        expect(calls[2]!.last).toBe(calls[1]!.returned);
        expect(cleanupTransitions).toBe(1);
        expect(state.interval).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally { vi.useRealTimers(); }
  }));

  it("elaborates every recognized Bash exception and refuses malformed, future, truncated, or capped success", () => withBindings(["ctrl+o"], () => {
    const tool = definition("bash");
    const args = { command: "secret-command" };
    for (const [result, isError] of [
      [bashResult("Command exited with code 7"), true],
      [bashResult("Command timed out after 1 seconds"), true],
      [bashResult("Command aborted"), true],
      [bashResult("warning", {
        truncation: { content: "warning", truncated: true, truncatedBy: "lines", totalLines: 2, totalBytes: 8,
          outputLines: 1, outputBytes: 7, lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 1, maxBytes: 50_000 },
        fullOutputPath: "/secret/full-output.log",
      }), false],
    ] as const) {
      const context = contexts(args);
      tool.renderCall(args, theme, context.call);
      const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, theme,
        { ...context.result, isError }).render(200).join("\n");
      expect(rendered).toContain("Elaborated result");
      expect(rendered).not.toContain("output lines hidden");
    }
    const additional = settle(tool, args, {
      content: [{ type: "text", text: "ok" }, { type: "text", text: "recovery" }], details: undefined,
    }).join("\n");
    expect(additional).toContain("Elaborated result");
    expect(additional).toContain("recovery");
    for (const result of [
      { content: [{ type: "text", text: "ok" }], details: { future: true } },
      { future: true },
    ]) expect(settle(tool, args, result).join("\n")).toContain("Unfamiliar result");
    const capped = settle(tool, args, bashResult("x".repeat(1_000_001))).join("\n");
    expect(capped).toContain("Detail inspection limit reached");
    expect(capped).not.toContain("output lines hidden");
  }));

  it("classifies Bash only from exact renderer state, never output keywords", () => withBindings(["ctrl+o"], () => {
    for (const keyword of ["error", "warning", "timed out", "aborted"]) {
      expect(settle(definition("bash"), { command: "true" }, bashResult(`successful ${keyword}`)).join("\n"))
        .toContain("1 output line hidden");
    }

    const args = { command: "true" };
    for (const [optionsPartial, contextPartial] of [[false, true], [true, false]] as const) {
      const tool = definition("bash");
      const state = {};
      tool.renderCall(args, theme, { args, state, isPartial: contextPartial, isError: false });
      const rendered = tool.renderResult(bashResult("ordinary"),
        { expanded: false, isPartial: optionsPartial }, theme,
        { args, state, isPartial: contextPartial, isError: false }).render(120).join("\n");
      expect(rendered).toContain("native result");
      expect(rendered).not.toContain("output line hidden");
    }
  }));

  it("keeps deeply frozen canonical Bash values unchanged and delegates only detached sanitized DTOs", () => withBindings(["ctrl+o"], () => {
    const seenArgs: unknown[] = [];
    const seenResults: unknown[] = [];
    const source = {
      name: "bash", label: "bash", description: "immutable probe", parameters: {}, execute() {},
      renderCall(args: unknown) { seenArgs.push(args); return component("call"); },
      renderResult(result: unknown) { seenResults.push(result); return component("result"); },
    };
    const tool = withDefaultCollapsedToolRendering(source as never) as unknown as RenderTool;
    const args = deepFreeze({ command: "TOKEN=frozen-secret printf '\u001b[31mvalue'", timeout: 3 });
    const partialOne = deepFreeze(bashResult("rolling-one\u001b[31m"));
    const partialTwo = deepFreeze(bashResult("rolling-two"));
    const settled = deepFreeze(bashResult("settled-output"));
    const errorResult = deepFreeze({ content: [{ type: "text", text: "Command aborted" }], details: undefined, isError: true });
    const canonical = JSON.stringify({ args, partialOne, partialTwo, settled, errorResult });
    const state = {};

    tool.renderCall(args, theme, { args, state, isPartial: true, executionStarted: true });
    tool.renderResult(partialOne, { expanded: false, isPartial: true }, theme,
      { args, state, isPartial: true, isError: false, invalidate() {} });
    tool.renderResult(partialTwo, { expanded: false, isPartial: true }, theme,
      { args, state, isPartial: true, isError: false, invalidate() {} });
    tool.renderCall(args, theme, { args, state, isPartial: false, executionStarted: true });
    tool.renderResult(settled, { expanded: false, isPartial: false }, theme,
      { args, state, isPartial: false, isError: false, invalidate() {} });
    tool.renderCall(args, theme, { args, state, isPartial: false, expanded: true, executionStarted: true });
    tool.renderResult(settled, { expanded: true, isPartial: false }, theme,
      { args, state, isPartial: false, isError: false, expanded: true, invalidate() {} });

    const errorState = {};
    tool.renderCall(args, theme, { args, state: errorState, isPartial: true, executionStarted: true });
    tool.renderResult(partialOne, { expanded: false, isPartial: true }, theme,
      { args, state: errorState, isPartial: true, isError: false, invalidate() {} });
    tool.renderResult(errorResult, { expanded: false, isPartial: false }, theme,
      { args, state: errorState, isPartial: false, isError: true, invalidate() {} });

    expect(JSON.stringify({ args, partialOne, partialTwo, settled, errorResult })).toBe(canonical);
    expect(Object.isFrozen(args)).toBe(true);
    for (const delegated of seenArgs) {
      expect(delegated).not.toBe(args);
      expect(JSON.stringify(delegated)).not.toContain("\\u001b");
    }
    for (const delegated of seenResults) {
      expect([partialOne, partialTwo, settled, errorResult]).not.toContain(delegated);
      expect(JSON.stringify(delegated)).not.toContain("\\u001b");
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

  it.each([
    ["OSC", "first\u001b]0;hidden\ninside\u0007\nsecond", "2 lines hidden", "first�\nsecond"],
    ["DCS", "first\u001bPhidden\ninside\u001b\\\nsecond", "2 lines hidden", "first�\nsecond"],
    ["APC", "first\u001b_hidden\ninside\u001b\\\nsecond", "2 lines hidden", "first�\nsecond"],
    ["CSI", "first\u001b[31\nmsecond", "1 line hidden", "first�second"],
  ])("counts Read/Write %s detail from the exact detached native display", (_kind, text, expected, delegated) => withBindings(["ctrl+o"], () => {
    for (const [name, args, result] of [
      ["read", { path: "controlled.txt" }, readResult(text)],
      ["write", { path: "controlled.txt", content: text }, writeResult("controlled.txt", text)],
    ] as const) {
      const tool = definition(name);
      expect(settle(tool, args, result).join("\n")).toContain(expected);
      const context = contexts(args);
      tool.renderCall(args, theme, { ...context.call, expanded: true });
      const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme,
        { ...context.result, expanded: true }).render(240).join("\n");
      expect(expanded, name).toContain(delegated);
      expect(expanded, name).not.toContain("inside");
    }
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
    expect(error).not.toContain("Elaborated result");
    expect(error).toContain("native read error.txt");
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

  it("fails closed for every hostile and non-exact Write argument/result shape", () => withBindings(["ctrl+o"], () => {
    let getterCalls = 0;
    const revokedArgsHandle = Proxy.revocable({}, {});
    revokedArgsHandle.revoke();
    const inheritedArgs = Object.create({ path: "inherited.txt", content: "secret" });
    const argumentCases: Array<{ label: string; value: unknown; expected: string }> = [
      { label: "accessor", value: Object.defineProperty({ content: "secret" }, "path", {
        enumerable: true, get() { getterCalls++; return "getter.txt"; },
      }), expected: "Unfamiliar arguments" },
      { label: "inherited", value: inheritedArgs, expected: "Unfamiliar arguments" },
      { label: "revoked proxy", value: revokedArgsHandle.proxy, expected: "Unfamiliar arguments" },
      { label: "future field", value: { path: "future.txt", content: "secret", future: true }, expected: "Unfamiliar arguments" },
      { label: "oversized keys", value: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, "secret"])), expected: "Detail inspection limit reached (keys); remaining detail uninspected" },
      { label: "over-budget content", value: { path: "large.txt", content: "x".repeat(1_000_001) + "ARG_SECRET" }, expected: "Detail inspection limit reached (characters); remaining detail uninspected" },
    ];
    for (const item of argumentCases) {
      const seen: unknown[] = [];
      const tool = withDefaultCollapsedToolRendering({
        name: "write", execute() {},
        renderCall(value: unknown) { seen.push(value); return component("native call"); },
        renderResult(value: unknown) { seen.push(value); return component("native result"); },
      } as never) as unknown as RenderTool;
      const rendered = tool.renderCall(item.value, theme, { args: item.value, state: {}, isPartial: false, isError: false })
        .render(180).join("\n");
      expect(rendered, item.label).toBe(item.expected);
      expect(rendered, item.label).not.toMatch(/secret|ARG_SECRET|getter\.txt|future\.txt|large\.txt/iu);
      expect(seen, item.label).toHaveLength(0);
    }

    const revokedResultHandle = Proxy.revocable({}, {});
    revokedResultHandle.revoke();
    const inheritedResult = Object.create({ details: undefined });
    inheritedResult.content = [{ type: "text", text: "RESULT_SECRET" }];
    const resultCases: Array<{ label: string; value: unknown; expected: string }> = [
      { label: "accessor", value: Object.defineProperty({ content: [{ type: "text", text: "RESULT_SECRET" }] }, "details", {
        enumerable: true, get() { getterCalls++; return undefined; },
      }), expected: "Unfamiliar result" },
      { label: "inherited", value: inheritedResult, expected: "Unfamiliar result" },
      { label: "revoked proxy", value: revokedResultHandle.proxy, expected: "Unfamiliar result" },
      { label: "future field", value: { ...(writeResult("safe.txt", "body") as Record<string, unknown>), future: true }, expected: "Unfamiliar result" },
      { label: "oversized keys", value: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, "RESULT_SECRET"])), expected: "Detail inspection limit reached (keys); remaining detail uninspected" },
      { label: "over-budget result", value: readResult("x".repeat(1_000_001) + "RESULT_SECRET"), expected: "Detail inspection limit reached (characters); remaining detail uninspected" },
    ];
    for (const item of resultCases) {
      const calls: unknown[] = [];
      const results: unknown[] = [];
      const tool = withDefaultCollapsedToolRendering({
        name: "write", execute() {},
        renderCall(value: unknown) { calls.push(value); return component("native call"); },
        renderResult(value: unknown) { results.push(value); return component("native result"); },
      } as never) as unknown as RenderTool;
      const args = { path: "safe.txt", content: "body" };
      const state = {};
      tool.renderCall(args, theme, { args, state, isPartial: false, isError: false });
      const rendered = tool.renderResult(item.value, { expanded: false, isPartial: false }, theme,
        { args, state, isPartial: false, isError: false }).render(180).join("\n");
      expect(rendered, item.label).toBe(item.expected);
      expect(rendered, item.label).not.toContain("RESULT_SECRET");
      expect(calls, item.label).toHaveLength(1);
      expect(calls[0], item.label).not.toBe(args);
      expect(results, item.label).toHaveLength(0);
    }
    expect(getterCalls).toBe(0);
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

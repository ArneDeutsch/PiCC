import { describe, expect, it } from "vitest";
import { renderMainSessionTool } from "../src/runtime/main-session-tool-render.js";
import { MainSessionCheckpointGate } from "../src/runtime/mid-run-compaction.js";
import { NOTEBOOK_MUTATION_FACTS } from "../src/runtime/tools/notebook-edit.js";

const theme = {
  fg: (_slot: string, text: string) => text,
  bold: (text: string) => text,
};
const componentLines = (component: { render(width: number): string[] }) => component.render(120);

function tool(name: string, extra: Record<string, unknown> = {}): any {
  return {
    name,
    description: `${name} description`,
    parameters: { sentinel: name },
    execute: async () => name,
    ...extra,
  };
}

function notebookResult(args: Record<string, unknown>): Record<string, unknown> {
  const details: Record<PropertyKey, unknown> = {
    new_source: args.new_source,
    old_source: "OLD_ROUTER_SECRET",
    cell_id: args.cell_id,
    cell_type: "code",
    language: "python",
    edit_mode: args.edit_mode,
    notebook_path: args.notebook_path,
    original_file: "ORIGINAL_ROUTER_SECRET",
    updated_file: "UPDATED_ROUTER_SECRET",
  };
  details[NOTEBOOK_MUTATION_FACTS] = {
    document: {}, mode: args.edit_mode, resolvedIndex: 0, resultingIndex: 0,
    cellType: "code", previousCellType: "code",
    oldSource: "OLD_ROUTER_SECRET", newSource: args.new_source,
    addressedCellId: args.cell_id, persistedCellId: args.cell_id,
    clearedOutputCount: 0, clearedExecutionCount: 0,
  };
  return {
    content: [{ type: "text", text: `Updated cell ${String(args.cell_id)} with ${String(args.new_source)}` }],
    details,
  };
}

describe("main-session tool presentation router", () => {
  it("routes custom and stock search families while forwarding display roots", () => {
    const custom = renderMainSessionTool(tool("Grep"), {
      resolveDisplayRoot: () => "/repo/worktree",
      repositoryRoot: "/repo",
    });
    expect(componentLines(custom.renderCall!(
      { pattern: "needle", path: "/repo/worktree/src" },
      theme as never,
      { state: {}, argsComplete: true, isPartial: false } as never,
    ))).toEqual([]);

    const stock = renderMainSessionTool(tool("grep"), {
      resolveDisplayRoot: () => "/repo/worktree",
      repositoryRoot: "/repo",
    });
    const lines = componentLines(stock.renderCall!(
      { pattern: "needle", path: "/repo/worktree/src" },
      theme as never,
      { state: {}, argsComplete: true, isPartial: false } as never,
    ));
    expect(lines.join("\n")).toContain("grep needle");
    expect(lines.join("\n")).toContain("src");
  });

  it("routes NotebookEdit through one specialization inside the existing self shell", () => {
    const execute = async () => ({ canonical: true });
    const source = tool("NotebookEdit", { execute });
    const routed = renderMainSessionTool(source, {
      resolveDisplayRoot: () => "/repo/work",
      repositoryRoot: "/repo",
    });
    const args = {
      notebook_path: "/repo/work/book.ipynb",
      new_source: "ROUTER_SECRET",
      cell_id: "cell-a",
      edit_mode: "replace",
    };
    const state = {};
    const callContext = {
      state, args, cwd: "/repo/work", argsComplete: true, executionStarted: false,
      expanded: false, isPartial: false, isError: false,
    };
    const call = routed.renderCall!(args, theme as never, callContext as never);
    const result = notebookResult(args);
    const renderedResult = routed.renderResult!(
      result as never,
      { expanded: false, isPartial: false } as never,
      theme as never,
      { ...callContext, executionStarted: true } as never,
    );
    const output = [...componentLines(call), ...componentLines(renderedResult)].join("\n");
    expect(output).toContain("● notebook write book.ipynb");
    expect(output.match(/notebook write/gu)).toHaveLength(1);
    expect(output).not.toMatch(/ROUTER_SECRET|OLD_ROUTER_SECRET|ORIGINAL_ROUTER_SECRET|UPDATED_ROUTER_SECRET/u);
    expect(routed.renderShell).toBe("self");
    expect(routed.execute).toBe(execute);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("ROUTER_SECRET");
    expect((result.details as Record<string, unknown>).new_source).toBe("ROUTER_SECRET");
  });

  it("pins NotebookEdit result-only, partial-to-final, failure, and abort shell states", () => {
    const routed = renderMainSessionTool(tool("NotebookEdit"), {
      resolveDisplayRoot: () => "/repo/work",
      repositoryRoot: "/repo",
    });
    const args = {
      notebook_path: "/repo/work/book.ipynb",
      new_source: "STATE_SOURCE_SECRET",
      cell_id: "cell-state",
      edit_mode: "replace",
    };
    const base = {
      args, cwd: "/repo/work", argsComplete: true, executionStarted: true, expanded: false,
    };

    const resultOnly = routed.renderResult!(
      notebookResult(args) as never,
      { expanded: false, isPartial: false } as never,
      theme as never,
      { ...base, state: {}, isPartial: false, isError: false } as never,
    );
    const resultOnlyText = componentLines(resultOnly).join("\n");
    expect(resultOnlyText).toContain("● notebook write book.ipynb");
    expect(resultOnlyText).not.toContain("STATE_SOURCE_SECRET");

    const state = {};
    const partialContext = { ...base, state, expanded: true, isPartial: true, isError: false };
    const partialCall = routed.renderCall!(args, theme as never, partialContext as never);
    const partialResult = routed.renderResult!(
      { content: [{ type: "text", text: "PARTIAL_STATE_SECRET" }], details: { new_source: "PARTIAL_DETAIL_SECRET" } } as never,
      { expanded: true, isPartial: true } as never,
      theme as never,
      partialContext as never,
    );
    const runningText = [...componentLines(partialCall), ...componentLines(partialResult)].join("\n");
    expect(runningText).toContain("○ notebook write");
    expect(runningText).not.toMatch(/STATE_SOURCE_SECRET|PARTIAL_(?:STATE|DETAIL)_SECRET/u);

    const finalContext = { ...base, state, isPartial: false, isError: false };
    const finalCall = routed.renderCall!(args, theme as never, finalContext as never);
    const finalResult = routed.renderResult!(
      notebookResult(args) as never,
      { expanded: false, isPartial: false } as never,
      theme as never,
      finalContext as never,
    );
    const finalText = [...componentLines(finalCall), ...componentLines(finalResult)].join("\n");
    expect(finalText).toContain("● notebook write book.ipynb");
    expect(finalText).not.toMatch(/STATE_SOURCE_SECRET|PARTIAL_(?:STATE|DETAIL)_SECRET/u);

    const failureState = {};
    const failureContext = { ...base, state: failureState, isPartial: false, isError: true };
    const failureCall = routed.renderCall!(args, theme as never, failureContext as never);
    const failureResult = routed.renderResult!(
      { content: [{ type: "text", text: "FAILURE_BODY_SECRET" }], details: { error: "Read the notebook again", new_source: "FAILURE_SOURCE_SECRET" }, isError: true } as never,
      { expanded: false, isPartial: false } as never,
      theme as never,
      failureContext as never,
    );
    const failureText = [...componentLines(failureCall), ...componentLines(failureResult)].join("\n");
    expect(failureText).toContain("✗ notebook write book.ipynb");
    expect(failureText).toContain("Read the notebook again");
    expect(failureText).not.toMatch(/FAILURE_(?:BODY|SOURCE)_SECRET/u);

    const abortState = {};
    const abortContext = { ...base, state: abortState, isPartial: false, isError: true };
    const abortCall = routed.renderCall!(args, theme as never, abortContext as never);
    const abortResult = routed.renderResult!(
      { content: [{ type: "text", text: "ABORT_BODY_SECRET" }], details: { error: "NotebookEdit: operation was aborted. No changes were written.", new_source: "ABORT_SOURCE_SECRET" }, isError: true } as never,
      { expanded: false, isPartial: false } as never,
      theme as never,
      abortContext as never,
    );
    const abortText = [...componentLines(abortCall), ...componentLines(abortResult)].join("\n");
    expect(abortText).toContain("■ notebook write book.ipynb");
    expect(abortText).toContain("operation was aborted");
    expect(abortText).not.toMatch(/ABORT_(?:BODY|SOURCE)_SECRET/u);
  });

  it("forwards an admitted MCP fallback label through the shared self shell", () => {
    const routed = renderMainSessionTool(tool("mcp__friendly__lookup"), {
      fallbackCallDisplayName: "Friendly lookup",
    });
    const lines = componentLines(routed.renderCall!(
      {}, theme as never, { state: {}, isPartial: true } as never,
    ));
    expect(lines.join("\n")).toContain("Friendly lookup");
    expect(routed.renderShell).toBe("self");
  });

  it("changes only presentation descriptors before one outer execute wrapper", async () => {
    const schema = { identity: "schema" };
    const execute = async () => "raw";
    let accessorReads = 0;
    const source = tool("WebFetch", { parameters: schema, execute });
    Object.defineProperty(source, "sentinel", {
      enumerable: false,
      configurable: true,
      get: () => {
        accessorReads += 1;
        return "sentinel";
      },
    });
    const before = Object.getOwnPropertyDescriptor(source, "sentinel");
    const routed = renderMainSessionTool(source);

    expect(routed.parameters).toBe(schema);
    expect(routed.execute).toBe(execute);
    expect(Object.getOwnPropertyDescriptor(routed, "sentinel")).toEqual(before);
    expect(accessorReads).toBe(0);
    for (const key of Reflect.ownKeys(source)) {
      if (["renderCall", "renderResult", "renderShell"].includes(String(key))) continue;
      expect(Object.getOwnPropertyDescriptor(routed, key)).toEqual(Object.getOwnPropertyDescriptor(source, key));
    }

    const gate = new MainSessionCheckpointGate("render-contract", 90);
    const checkpointed = gate.wrapTool(routed);
    expect(checkpointed.execute).not.toBe(routed.execute);
    expect(await (checkpointed.execute as any)("id", {}, undefined, undefined, undefined)).toBe("raw");
  });
});

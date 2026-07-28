import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ expansion: { available: true, value: "ctrl+x" } as
  { available: true; value: string } | { available: false } }));
vi.mock("../src/runtime/pi-tui-runtime.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runtime/pi-tui-runtime.js")>(),
  piToolsExpandKeyText: () => bridge.expansion,
}));

import { createGuardExtension } from "../src/runtime/guard.js";
import { withNotebookEditRendering } from "../src/runtime/notebook-edit-render.js";
import {
  NotebookSessionState,
  readNotebookBytesBounded,
  resolveNotebookTarget,
} from "../src/runtime/notebook-session.js";
import { createNotebookEditTool, NOTEBOOK_MUTATION_FACTS } from "../src/runtime/tools/notebook-edit.js";

const theme = {
  fg: (_slot: string, text: string) => text,
  bold: (text: string) => text,
};

const fixtureDirs: string[] = [];
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function producerFixture(minor: number): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-notebook-render-"));
  fixtureDirs.push(dir);
  const file = path.join(dir, "book.ipynb");
  fs.writeFileSync(file, JSON.stringify({
    cells: [
      {
        cell_type: "code", id: "real-code", metadata: {}, source: "PRODUCER_OLD_CODE",
        execution_count: 1, outputs: [{ output_type: "stream", text: "PRODUCER_OLD_OUTPUT" }],
      },
      { cell_type: "markdown", id: "real-md", metadata: {}, source: "PRODUCER_OLD_MARKDOWN" },
    ],
    metadata: { language_info: { name: "python" } },
    nbformat: 4,
    nbformat_minor: minor,
  }, null, 1));
  return { dir, file };
}

async function authorizeProducer(state: NotebookSessionState, file: string): Promise<void> {
  const target = await resolveNotebookTarget(file);
  state.recordRead(target, await readNotebookBytesBounded(target.canonicalPath, 25 * 1024 * 1024));
}

function rawTool(extra: Record<string, unknown> = {}): any {
  return {
    name: "NotebookEdit",
    description: "edit notebook",
    parameters: { identity: "schema" },
    execute: async () => "canonical",
    ...extra,
  };
}

function args(mode: "replace" | "insert" | "delete", path = "/repo/work/book.ipynb"): Record<string, unknown> {
  return {
    notebook_path: path,
    new_source: "SECRET_SOURCE\nsecond line",
    ...(mode === "insert" ? { cell_type: "markdown" } : { cell_id: `${mode}-cell` }),
    edit_mode: mode,
  };
}

function resultFor(callArgs: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const mode = callArgs.edit_mode as "replace" | "insert" | "delete";
  const cellId = mode === "insert" ? "1234abcd" : callArgs.cell_id;
  const sentence = mode === "replace"
    ? `Updated cell ${String(cellId)} with ${String(callArgs.new_source)}`
    : mode === "insert"
      ? `Inserted cell ${String(cellId)} with ${String(callArgs.new_source)}`
      : `Deleted cell ${String(cellId)}`;
  const details: Record<PropertyKey, unknown> = {
    new_source: callArgs.new_source,
    ...(mode === "insert" ? {} : { old_source: "OLD_SECRET" }),
    cell_id: cellId,
    cell_type: callArgs.cell_type ?? "code",
    language: "python",
    edit_mode: mode,
    notebook_path: callArgs.notebook_path,
    original_file: "ORIGINAL_SECRET",
    updated_file: "UPDATED_SECRET",
  };
  details[NOTEBOOK_MUTATION_FACTS] = mode === "insert"
    ? {
        document: {}, mode, resolvedIndex: undefined, resultingIndex: 0,
        cellType: callArgs.cell_type, newSource: callArgs.new_source,
        generatedCellId: cellId, persistedCellId: cellId,
        clearedOutputCount: 0, clearedExecutionCount: 0,
      }
    : mode === "replace"
      ? {
          document: {}, mode, resolvedIndex: 0, resultingIndex: 0,
          cellType: callArgs.cell_type ?? "code", previousCellType: "code",
          oldSource: "OLD_SECRET", newSource: callArgs.new_source,
          addressedCellId: callArgs.cell_id, persistedCellId: callArgs.cell_id,
          clearedOutputCount: 0, clearedExecutionCount: 0,
        }
      : {
          document: {}, mode, resolvedIndex: 0, resultingIndex: 0,
          cellType: "code", previousCellType: "code", oldSource: "OLD_SECRET",
          addressedCellId: callArgs.cell_id, persistedCellId: callArgs.cell_id,
          clearedOutputCount: 0, clearedExecutionCount: 0,
        };
  return { content: [{ type: "text", text: sentence }], details, ...extra };
}

function context(state: object, callArgs: unknown, extra: Record<string, unknown> = {}): any {
  return {
    state,
    args: callArgs,
    cwd: "/repo/work",
    argsComplete: true,
    executionStarted: false,
    expanded: false,
    isPartial: false,
    isError: false,
    ...extra,
  };
}

function settle(tool: any, callArgs: Record<string, unknown>, state = {}, extra: Record<string, unknown> = {}) {
  const ctx = context(state, callArgs, extra);
  const call = tool.renderCall(callArgs, theme, ctx);
  const result = resultFor(callArgs);
  const resultComponent = tool.renderResult(result, { expanded: ctx.expanded, isPartial: false }, theme, {
    ...ctx,
    executionStarted: true,
  });
  return { call, resultComponent, result, ctx };
}

function text(component: { render(width: number): string[] }, width = 120): string {
  return component.render(width).join("\n");
}

async function guardTransform(
  result: Record<string, unknown>,
  input: Record<string, unknown>,
  options: { clipMaxTokens?: number; feedback?: boolean } = {},
): Promise<Record<string, unknown>> {
  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  const hooks = options.feedback
    ? {
        hasHooks: () => true,
        fire: async () => ({
          block: true,
          blockReason: "FIX_THIS\u001b[31m_NOW",
          additionalContext: "RUN_CHECK\u001b]0;owned\u0007_NEXT",
          diagnostics: [],
        }),
      }
    : { hasHooks: () => false };
  createGuardExtension({
    engine: {} as never,
    hooks: hooks as never,
    getCwd: () => ".",
    ...(options.clipMaxTokens === undefined ? {} : { clipMaxTokens: options.clipMaxTokens }),
  })({
    on: (event: string, handler: (payload: unknown, context: unknown) => unknown) => handlers.set(event, handler),
  } as never);
  const patch = await handlers.get("tool_result")!({
    toolName: "NotebookEdit",
    input,
    content: result.content,
    details: result.details,
    isError: false,
  }, {}) as { content?: unknown; details?: unknown } | undefined;
  return {
    content: patch?.content ?? result.content,
    details: patch?.details ?? result.details,
  };
}

describe("NotebookEdit presentation", () => {
  it("renders replace, insert, and delete as concise source-private workspace-aware rows", () => {
    bridge.expansion = { available: true, value: "alt+e" };
    const tool = withNotebookEditRendering(rawTool(), {
      resolveDisplayRoot: () => "/repo/work",
      repositoryRoot: "/repo",
    });
    for (const mode of ["replace", "insert", "delete"] as const) {
      const callArgs = args(mode);
      const { call, resultComponent } = settle(tool, callArgs);
      const row = text(call);
      expect(row).toContain("notebook write book.ipynb");
      expect(row).toContain(mode);
      if (mode !== "insert") expect(row).toContain(`${mode}-cell`);
      expect(row).toContain("alt+e to expand");
      expect(`${row}\n${text(resultComponent)}`).not.toMatch(/SECRET_SOURCE|OLD_SECRET|ORIGINAL_SECRET|UPDATED_SECRET|new_source|original_file/u);
      expect(text(resultComponent)).toBe("");
    }
  });

  it("collapses actual NotebookEdit producer results across ID-bearing and legacy mutation modes", async () => {
    bridge.expansion = { available: true, value: "ctrl+x" };
    const scenarios = [
      { minor: 5, mode: "replace", cell_id: "real-code" },
      { minor: 5, mode: "insert", cell_id: "real-code", cell_type: "code" },
      { minor: 5, mode: "delete", cell_id: "real-md" },
      { minor: 4, mode: "replace", cell_id: "real-code" },
      { minor: 4, mode: "insert", cell_id: "real-code", cell_type: "code" },
      { minor: 4, mode: "delete", cell_id: "real-md" },
    ] as const;

    for (const scenario of scenarios) {
      const { dir, file } = producerFixture(scenario.minor);
      const session = new NotebookSessionState();
      await authorizeProducer(session, file);
      const produced = createNotebookEditTool(() => dir, session, {
        generateCellIdCandidate: () => "1234abcd",
      });
      const tool = withNotebookEditRendering(produced, { resolveDisplayRoot: () => dir });
      const callArgs = {
        notebook_path: file,
        new_source: `PRODUCER_NEW_${scenario.minor}_${scenario.mode}`,
        cell_id: scenario.cell_id,
        ...(scenario.mode === "insert" ? { cell_type: scenario.cell_type } : {}),
        edit_mode: scenario.mode,
      };
      const state = {};
      const before = context(state, callArgs, { cwd: dir });
      const call = tool.renderCall!(callArgs as never, theme as never, before);
      const result = await tool.execute!(
        "producer", callArgs as never, undefined as never, undefined as never, {} as never,
      ) as unknown as {
        content: Array<{ type: string; text?: unknown }>;
        details: Record<PropertyKey, unknown>;
        isError?: boolean;
      };
      expect(
        result.isError,
        `${scenario.minor}/${scenario.mode}: ${String(result.content[0]?.text)}`,
      ).not.toBe(true);
      tool.renderCall!(callArgs as never, theme as never, { ...before, executionStarted: true });
      const continuation = tool.renderResult!(
        result as never,
        { expanded: false, isPartial: false } as never,
        theme as never,
        { ...before, executionStarted: true },
      );
      const row = text(call, 160);
      expect(row).toContain("notebook write book.ipynb");
      expect(row).toContain(scenario.mode);
      expect(text(continuation)).toBe("");
      expect(`${row}\n${text(continuation)}`).not.toMatch(/PRODUCER_(?:OLD|NEW)/u);
    }
  });

  it("surfaces guard clipping without exposing retained source", async () => {
    bridge.expansion = { available: true, value: "ctrl+x" };
    const tool = withNotebookEditRendering(rawTool(), { resolveDisplayRoot: () => "/repo/work" });
    const callArgs = args("replace");
    callArgs.new_source = `CLIPPED_SOURCE_CANARY_${"x".repeat(8_000)}`;
    const state = {};
    const ctx = context(state, callArgs);
    const call = tool.renderCall(callArgs, theme, ctx);
    const guarded = await guardTransform(resultFor(callArgs), callArgs, { clipMaxTokens: 100 });
    const shown = tool.renderResult(guarded, { expanded: false, isPartial: false }, theme, {
      ...ctx, executionStarted: true,
    });
    const collapsed = `${text(call, 160)}\n${text(shown, 160)}`;
    expect(collapsed).toContain("result clipped");
    expect(collapsed).toContain("ctrl+x to expand");
    expect(collapsed).not.toContain("CLIPPED_SOURCE_CANARY");
    expect(collapsed).not.toContain("Unfamiliar notebook edit result");
  });

  it("keeps appended PostToolUse feedback visible collapsed and expanded", async () => {
    bridge.expansion = { available: true, value: "ctrl+x" };
    const tool = withNotebookEditRendering(rawTool(), { resolveDisplayRoot: () => "/repo/work" });
    const callArgs = args("replace");
    const state = {};
    const ctx = context(state, callArgs);
    const call = tool.renderCall(callArgs, theme, ctx);
    const guarded = await guardTransform(resultFor(callArgs), callArgs, { feedback: true });
    const collapsedResult = tool.renderResult(guarded, { expanded: false, isPartial: false }, theme, {
      ...ctx, executionStarted: true,
    });
    const collapsed = `${text(call, 160)}\n${text(collapsedResult, 160)}`;
    expect(collapsed).toContain("[hook blocked] FIX_THIS�_NOW");
    expect(collapsed).toContain("[hook context] RUN_CHECK�_NEXT");
    expect(collapsed).not.toMatch(/\u001b|owned/u);
    expect(collapsed).not.toContain("Unfamiliar notebook edit result");

    tool.renderCall(callArgs, theme, { ...ctx, expanded: true, executionStarted: true });
    const expandedResult = tool.renderResult(guarded, { expanded: true, isPartial: false }, theme, {
      ...ctx, expanded: true, executionStarted: true,
    });
    expect(text(expandedResult, 160)).toContain("[hook blocked] FIX_THIS�_NOW");
    expect(text(expandedResult, 160)).toContain("details.new_source: SECRET_SOURCE");
  });

  it("uses repository-relative and caller-visible path fallbacks without leaking partial arguments", () => {
    const tool = withNotebookEditRendering(rawTool(), {
      resolveDisplayRoot: () => "/repo/work",
      repositoryRoot: "/repo",
    });
    const partialArgs = { notebook_path: "/repo/other/book.ipynb", new_source: "PARTIAL_SECRET", edit_mode: "replace" };
    const partial = tool.renderCall(partialArgs, theme, context({}, partialArgs, {
      argsComplete: false, isPartial: true,
    }));
    expect(text(partial)).toBe("notebook write");
    expect(text(partial)).not.toMatch(/book\.ipynb|PARTIAL_SECRET|replace/u);

    const complete = args("delete", "/repo/other/book.ipynb");
    expect(text(settle(tool, complete).call)).toContain("repo:other/book.ipynb");
  });

  it("freezes path roots, operation, and cell identity when execution starts", () => {
    let displayRoot = "/repo/original";
    const tool = withNotebookEditRendering(rawTool(), {
      resolveDisplayRoot: () => displayRoot,
      repositoryRoot: "/repo",
    });
    const mutableArgs = args("replace", "/repo/original/book.ipynb");
    mutableArgs.cell_id = "original-cell";
    const canonical = resultFor({ ...mutableArgs });
    const state = {};
    const before = context(state, mutableArgs, { cwd: "/repo/original" });
    const call = tool.renderCall(mutableArgs, theme, before);
    tool.renderCall(mutableArgs, theme, { ...before, executionStarted: true });

    displayRoot = "/repo/changed";
    mutableArgs.notebook_path = "/repo/changed/changed.ipynb";
    mutableArgs.edit_mode = "insert";
    mutableArgs.cell_id = "changed-cell";
    mutableArgs.cell_type = "markdown";
    mutableArgs.new_source = "CHANGED_AFTER_FREEZE";
    tool.renderCall(mutableArgs, theme, {
      ...before, cwd: "/repo/changed", executionStarted: true,
    });
    const shown = tool.renderResult(canonical, { expanded: false, isPartial: false }, theme, {
      ...before, args: mutableArgs, cwd: "/repo/changed", executionStarted: true,
    });

    const row = text(call, 160);
    expect(row).toContain("notebook write book.ipynb");
    expect(row).toContain("replace cell original-cell");
    expect(text(shown)).toBe("");
    expect(`${row}\n${text(shown)}`).not.toMatch(/changed\.ipynb|insert|changed-cell|CHANGED_AFTER_FREEZE/u);
  });

  it("settles execution-equivalent relative paths and long cell identities while bounding display only", () => {
    const tool = withNotebookEditRendering(rawTool(), {
      resolveDisplayRoot: () => "/repo/work",
      repositoryRoot: "/repo",
    });
    const longId = `cell-${"x".repeat(600)}`;
    const callArgs = args("replace", "book.ipynb");
    callArgs.cell_id = longId;
    const state = {};
    const ctx = context(state, callArgs);
    const call = tool.renderCall(callArgs, theme, ctx);
    const canonical = resultFor(callArgs);
    (canonical.details as Record<string, unknown>).notebook_path = "/repo/work/book.ipynb";
    const shown = tool.renderResult(canonical, { expanded: false, isPartial: false }, theme, {
      ...ctx, executionStarted: true,
    });

    expect(text(shown)).toBe("");
    expect(text(call, 80)).toContain("notebook write book.ipynb");
    expect(text(call, 400)).not.toContain(longId);
    expect(call.render(80).every((line: string) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("rejects insert detail identity that contradicts authoritative mutation facts", () => {
    const tool = withNotebookEditRendering(rawTool());
    const callArgs = args("insert");
    const state = {};
    const ctx = context(state, callArgs);
    tool.renderCall(callArgs, theme, ctx);
    const contradictory = resultFor(callArgs);
    (contradictory.details as Record<PropertyKey, unknown>)[NOTEBOOK_MUTATION_FACTS] = {
      document: {}, mode: "insert", resolvedIndex: undefined, resultingIndex: 0,
      cellType: "markdown", newSource: callArgs.new_source,
      generatedCellId: "deadbeef", persistedCellId: "deadbeef",
      clearedOutputCount: 0, clearedExecutionCount: 0,
    };
    const shown = tool.renderResult(contradictory, { expanded: false, isPartial: false }, theme, {
      ...ctx, executionStarted: true,
    });
    expect(text(shown)).toContain("Unfamiliar notebook edit result");
    expect(text(shown)).not.toContain("Inserted cell");

    const absentState = {};
    const absentCtx = context(absentState, callArgs);
    tool.renderCall(callArgs, theme, absentCtx);
    const bothAbsent = resultFor(callArgs);
    delete (bothAbsent.details as Record<PropertyKey, unknown>).cell_id;
    (bothAbsent.details as Record<PropertyKey, unknown>)[NOTEBOOK_MUTATION_FACTS] = {
      document: {}, mode: "insert", resolvedIndex: undefined, resultingIndex: 0,
      cellType: "markdown", newSource: callArgs.new_source,
      generatedCellId: undefined, persistedCellId: undefined,
      clearedOutputCount: 0, clearedExecutionCount: 0,
    };
    const absentShown = tool.renderResult(bothAbsent, { expanded: false, isPartial: false }, theme, {
      ...absentCtx, executionStarted: true,
    });
    expect(text(absentShown)).toBe("");

    const truncatedState = {};
    const truncatedCtx = context(truncatedState, callArgs);
    tool.renderCall(callArgs, theme, truncatedCtx);
    const truncated = resultFor(callArgs);
    (truncated.details as Record<PropertyKey, unknown>)[NOTEBOOK_MUTATION_FACTS] = { mode: "insert" };
    const truncatedShown = tool.renderResult(truncated, { expanded: false, isPartial: false }, theme, {
      ...truncatedCtx, executionStarted: true,
    });
    expect(text(truncatedShown)).toContain("Unfamiliar notebook edit result");
  });

  it("rejects producer-impossible mutation-fact metadata relationships", () => {
    const tool = withNotebookEditRendering(rawTool());
    const cases: Array<{
      name: string;
      callArgs: Record<string, unknown>;
      mutate: (facts: Record<PropertyKey, unknown>) => void;
    }> = [
      {
        name: "insert cell type",
        callArgs: args("insert"),
        mutate: (facts) => { facts.cellType = "code"; },
      },
      {
        name: "requested replace cell type",
        callArgs: { ...args("replace"), cell_type: "markdown" },
        mutate: (facts) => { facts.cellType = "code"; },
      },
      {
        name: "implicit replace cell type",
        callArgs: args("replace"),
        mutate: (facts) => { facts.cellType = "markdown"; },
      },
      {
        name: "replace execution clear count",
        callArgs: args("replace"),
        mutate: (facts) => { facts.clearedExecutionCount = 2; },
      },
    ];

    for (const entry of cases) {
      const state = {};
      const ctx = context(state, entry.callArgs);
      tool.renderCall(entry.callArgs, theme, ctx);
      const malformed = resultFor(entry.callArgs);
      const facts = (malformed.details as Record<PropertyKey, unknown>)[NOTEBOOK_MUTATION_FACTS] as
        Record<PropertyKey, unknown>;
      entry.mutate(facts);
      const shown = tool.renderResult(malformed, { expanded: false, isPartial: false }, theme, {
        ...ctx, executionStarted: true,
      });
      expect(text(shown), entry.name).toContain("Unfamiliar notebook edit result");
    }
  });

  it("rejects noncanonical generated IDs and non-code default detail cell types", () => {
    const tool = withNotebookEditRendering(rawTool());

    const insertArgs = args("insert");
    const insertState = {};
    const insertCtx = context(insertState, insertArgs);
    tool.renderCall(insertArgs, theme, insertCtx);
    const noncanonicalId = resultFor(insertArgs);
    const insertDetails = noncanonicalId.details as Record<PropertyKey, unknown>;
    insertDetails.cell_id = "ABCDEF12";
    const insertFacts = insertDetails[NOTEBOOK_MUTATION_FACTS] as Record<PropertyKey, unknown>;
    insertFacts.generatedCellId = "ABCDEF12";
    insertFacts.persistedCellId = "ABCDEF12";
    const insertShown = tool.renderResult(noncanonicalId, { expanded: false, isPartial: false }, theme, {
      ...insertCtx, executionStarted: true,
    });
    expect(text(insertShown)).toContain("Unfamiliar notebook edit result");

    const replaceArgs = args("replace");
    const replaceState = {};
    const replaceCtx = context(replaceState, replaceArgs);
    tool.renderCall(replaceArgs, theme, replaceCtx);
    const wrongDefault = resultFor(replaceArgs);
    (wrongDefault.details as Record<PropertyKey, unknown>).cell_type = "markdown";
    const replaceShown = tool.renderResult(wrongDefault, { expanded: false, isPartial: false }, theme, {
      ...replaceCtx, executionStarted: true,
    });
    expect(text(replaceShown)).toContain("Unfamiliar notebook edit result");
  });

  it("reveals only bounded sanitized labeled canonical detail after explicit expansion", () => {
    const tool = withNotebookEditRendering(rawTool(), { resolveDisplayRoot: () => "/repo/work" });
    const callArgs = args("replace");
    callArgs.new_source = `line\u001b[31mred\u001b[0m\u001b]8;;https://evil.test\u0007link\u2028tail\n${"x".repeat(30_000)}`;
    const state = {};
    const ctx = context(state, callArgs, { expanded: true });
    const call = tool.renderCall(callArgs, theme, ctx);
    const canonical = resultFor(callArgs);
    (canonical.details as Record<string, unknown>).old_source = "old\u0000source";
    const shown = tool.renderResult(canonical, { expanded: true, isPartial: false }, theme, {
      ...ctx, executionStarted: true,
    });
    const output = `${text(call, 24)}\n${text(shown, 24)}`;
    expect(output).toContain("new_source:");
    expect(output).toContain("original_file:");
    expect(output).toContain("updated_file:");
    expect(output).toContain("�");
    expect(output).not.toContain((canonical.content as Array<{ text: string }>)[0]!.text);
    expect(output).not.toMatch(/\u001b|https:\/\/evil\.test/u);
    expect(call.render(24).length).toBeLessThanOrEqual(32);
    expect(shown.render(24).length).toBeLessThanOrEqual(32);
    for (const width of [8, 1, 0, -1]) {
      expect(() => call.render(width)).not.toThrow();
      expect(() => shown.render(width)).not.toThrow();
      expect(call.render(width).every((line: string) => width <= 0 || line.length <= 100)).toBe(true);
    }
  });

  it("renders normal expanded canonical values by label without the success sentence", () => {
    const tool = withNotebookEditRendering(rawTool(), { resolveDisplayRoot: () => "/repo/work" });
    const callArgs = args("replace");
    callArgs.new_source = "print('expanded value')";
    const state = {};
    const ctx = context(state, callArgs, { expanded: true });
    const call = tool.renderCall(callArgs, theme, ctx);
    const canonical = resultFor(callArgs);
    (canonical.details as Record<string, unknown>).old_source = "print('old value')";
    const shown = tool.renderResult(canonical, { expanded: true, isPartial: false }, theme, {
      ...ctx, executionStarted: true,
    });
    const output = `${text(call, 160)}\n${text(shown, 160)}`;
    expect(output).toContain("args.new_source: print('expanded value')");
    expect(output).toContain("details.old_source: print('old value')");
    expect(output).toContain("details.original_file: ORIGINAL_SECRET");
    expect(output).not.toMatch(/(?:Updated|Inserted) cell/u);
  });

  it("keeps ordinary source private and gives non-key recovery when expansion is unavailable", () => {
    bridge.expansion = { available: false };
    const tool = withNotebookEditRendering(rawTool());
    const { call, resultComponent } = settle(tool, args("replace"));
    const output = `${text(call, 160)}\n${text(resultComponent, 160)}`;
    expect(output).toContain("detail unavailable; configure tool expansion");
    expect(output).not.toMatch(/ctrl|alt\+|SECRET_SOURCE|OLD_SECRET/u);
  });

  it("keeps incomplete expanded calls generic without inspecting source", () => {
    bridge.expansion = { available: true, value: "ctrl+x" };
    let sourceReads = 0;
    const incomplete = new Proxy({
      notebook_path: "/repo/work/incomplete.ipynb",
      new_source: "INCOMPLETE_SECRET",
      cell_id: "cell-a",
      edit_mode: "replace",
    }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "new_source") {
          sourceReads += 1;
          throw new Error("source trap");
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const tool = withNotebookEditRendering(rawTool());
    const shown = tool.renderCall(incomplete, theme, context({}, incomplete, {
      argsComplete: false, expanded: true, isPartial: true,
    }));
    expect(text(shown)).toBe("notebook write");
    expect(sourceReads).toBe(0);
  });

  it("keeps partial results running, generic, source-private, and uncached before final settlement", () => {
    bridge.expansion = { available: true, value: "ctrl+x" };
    const tool = withNotebookEditRendering(rawTool());
    const callArgs = args("replace");
    callArgs.new_source = "PARTIAL_ARG_SECRET";
    const state = {};
    const running = context(state, callArgs, {
      expanded: true, executionStarted: true, isPartial: true,
    });
    const call = tool.renderCall(callArgs, theme, running);
    const partial = {
      content: [{ type: "text", text: "PARTIAL_RESULT_SECRET" }],
      details: { new_source: "PARTIAL_DETAIL_SECRET" },
    };
    const continuation = tool.renderResult(partial, { expanded: true, isPartial: true }, theme, running);
    expect(text(call)).toBe("notebook write");
    expect(text(continuation)).toBe("");
    expect(`${text(call)}${text(continuation)}`).not.toMatch(/PARTIAL_(?:ARG|RESULT|DETAIL)_SECRET/u);

    const final = resultFor(callArgs);
    const settled = tool.renderResult(final, { expanded: true, isPartial: false }, theme, {
      ...running, isPartial: false, isError: false,
    });
    expect(text(call)).toContain("args.new_source: PARTIAL_ARG_SECRET");
    expect(text(settled)).toContain("details.original_file: ORIGINAL_SECRET");
    expect(text(settled)).not.toContain("PARTIAL_RESULT_SECRET");
  });

  it("collapses only the canonical final envelope and keeps contradictions source-private", () => {
    const tool = withNotebookEditRendering(rawTool());
    const callArgs = args("replace");
    const state = {};
    const ctx = context(state, callArgs);
    const call = tool.renderCall(callArgs, theme, ctx);
    const contradictory = resultFor(callArgs);
    (contradictory.details as Record<PropertyKey, unknown>).notebook_path = "/repo/work/other.ipynb";
    (contradictory.content as Array<{ text: string }>)[0]!.text = "CONTRADICTORY_SOURCE_BODY";
    const shown = tool.renderResult(contradictory, { expanded: false, isPartial: false }, theme, {
      ...ctx, executionStarted: true,
    });
    expect(text(call)).toContain("notebook write");
    expect(text(shown)).toContain("Unfamiliar notebook edit result");
    expect(`${text(call)}\n${text(shown)}`).not.toContain("CONTRADICTORY_SOURCE_BODY");

    const alteredSentence = resultFor(callArgs);
    (alteredSentence.content as Array<{ text: string }>)[0]!.text = "UNREAD_SUCCESS_BODY";
    const sentenceState = {};
    const sentenceCtx = context(sentenceState, callArgs);
    tool.renderCall(callArgs, theme, sentenceCtx);
    const sentenceShown = tool.renderResult(alteredSentence, { expanded: false, isPartial: false }, theme, {
      ...sentenceCtx, executionStarted: true,
    });
    expect(text(sentenceShown)).toBe("");

    const evidenceState = {};
    const evidenceCtx = context(evidenceState, callArgs, { expanded: true });
    tool.renderCall(callArgs, theme, evidenceCtx);
    const evidence = tool.renderResult(
      { content: [{ type: "text", text: "ordinary\u001b[31m unfamiliar evidence" }], details: {} },
      { expanded: true, isPartial: false },
      theme,
      { ...evidenceCtx, executionStarted: true },
    );
    expect(text(evidence)).toContain("ordinary� unfamiliar evidence");
    expect(text(evidence)).not.toContain("\u001b");

    const fallbackState = {};
    const fallbackCtx = context(fallbackState, callArgs, { expanded: true });
    tool.renderCall(callArgs, theme, fallbackCtx);
    const fallback = tool.renderResult(3, { expanded: true, isPartial: false }, theme, {
      ...fallbackCtx, executionStarted: true,
    });
    expect(text(fallback)).toContain("Notebook edit result is unavailable or malformed; inspect the canonical result.");
  });

  it("keeps failures actionable, sanitized, and visibly exceptional even without expansion", () => {
    bridge.expansion = { available: false };
    const tool = withNotebookEditRendering(rawTool());
    const callArgs = args("replace");
    const state = {};
    const ctx = context(state, callArgs);
    const call = tool.renderCall(callArgs, theme, ctx);
    const failure = {
      content: [{ type: "text", text: "NotebookEdit failed\u001b[31m: Read it again" }],
      details: { error: "Notebook stale\u001b]0;owned\u0007; Read it again", new_source: "SECRET_SOURCE" },
      isError: true,
    };
    const shown = tool.renderResult(failure, { expanded: false, isPartial: false }, theme, {
      ...ctx, executionStarted: true, isError: true,
    });
    expect(text(call)).toContain("notebook write");
    expect(text(shown)).toContain("Notebook stale");
    expect(text(shown)).toContain("Read it again");
    expect(text(shown)).not.toMatch(/SECRET_SOURCE|\u001b|owned/u);
  });

  it("uses sanitized terminal-error detail, canonical text, then a generic fallback", () => {
    const tool = withNotebookEditRendering(rawTool());
    const callArgs = args("replace");
    const cases = [
      {
        result: { content: [{ type: "text", text: "UNUSED_TEXT" }], details: { error: "stale\u001b[31m detail" } },
        expected: "stale� detail",
      },
      {
        result: { content: [{ type: "text", text: "text\u001b]0;owned\u0007 fallback" }], details: {} },
        expected: "text� fallback",
      },
      {
        result: { content: [], details: {} },
        expected: "Notebook edit result is unavailable or malformed",
      },
    ];
    for (const entry of cases) {
      const state = {};
      const ctx = context(state, callArgs, { expanded: true, executionStarted: true, isError: true });
      tool.renderCall(callArgs, theme, ctx);
      const shown = tool.renderResult(entry.result, { expanded: true, isPartial: false }, theme, ctx);
      const output = text(shown);
      expect(output).toContain(entry.expected);
      expect(output).not.toMatch(/\u001b|owned/u);
    }
  });

  it("keeps call and result output within Pi-visible narrow widths and empty at non-positive widths", () => {
    const tool = withNotebookEditRendering(rawTool(), { resolveDisplayRoot: () => "/repo/work" });
    const callArgs = args("replace");
    const state = {};
    const ctx = context(state, callArgs, { expanded: true });
    const call = tool.renderCall(callArgs, theme, ctx);
    const shown = tool.renderResult(resultFor(callArgs), { expanded: true, isPartial: false }, theme, {
      ...ctx, executionStarted: true,
    });
    for (const width of [1, 2, 7]) {
      expect(call.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
      expect(shown.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
    }
    for (const width of [0, -1]) {
      expect(call.render(width)).toEqual([]);
      expect(shown.render(width)).toEqual([]);
    }
  });

  it("prioritizes unavailable-detail recovery at realistic widths with long paths", () => {
    bridge.expansion = { available: false };
    const tool = withNotebookEditRendering(rawTool());
    const callArgs = args("replace", `/repo/work/${"long-segment-".repeat(20)}book.ipynb`);
    const { call } = settle(tool, callArgs);
    for (const width of [80, 100]) {
      const lines = call.render(width);
      expect(lines.join("\n")).toContain("detail unavailable; configure tool expansion");
      expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
    }
  });

  it("isolates interleaved same-path calls and independently expands their cached canaries", () => {
    bridge.expansion = { available: true, value: "ctrl+x" };
    const tool = withNotebookEditRendering(rawTool(), {
      resolveDisplayRoot: () => "/repo/work",
      repositoryRoot: "/repo",
    });
    const sharedPath = "/repo/work/book.ipynb";
    const firstArgs = args("replace", sharedPath);
    firstArgs.new_source = "FIRST_ARG_CANARY";
    const secondArgs = args("delete", sharedPath);
    secondArgs.new_source = "SECOND_ARG_CANARY";
    const firstResult = resultFor(firstArgs);
    (firstResult.details as Record<string, unknown>).original_file = "FIRST_RESULT_CANARY";
    const secondResult = resultFor(secondArgs);
    (secondResult.details as Record<string, unknown>).original_file = "SECOND_RESULT_CANARY";
    const firstCtx = context({}, firstArgs);
    const secondCtx = context({}, secondArgs);
    const firstCall = tool.renderCall(firstArgs, theme, firstCtx);
    const secondCall = tool.renderCall(secondArgs, theme, secondCtx);
    tool.renderResult(firstResult, { expanded: false, isPartial: false }, theme, {
      ...firstCtx, executionStarted: true,
    });
    tool.renderResult(secondResult, { expanded: false, isPartial: false }, theme, {
      ...secondCtx, executionStarted: true,
    });

    tool.renderCall(firstArgs, theme, { ...firstCtx, expanded: true, executionStarted: true });
    const firstExpanded = tool.renderResult(firstResult, { expanded: true, isPartial: false }, theme, {
      ...firstCtx, expanded: true, executionStarted: true,
    });
    tool.renderCall(secondArgs, theme, { ...secondCtx, expanded: true, executionStarted: true });
    const secondExpanded = tool.renderResult(secondResult, { expanded: true, isPartial: false }, theme, {
      ...secondCtx, expanded: true, executionStarted: true,
    });

    const firstText = `${text(firstCall)}\n${text(firstExpanded)}`;
    const secondText = `${text(secondCall)}\n${text(secondExpanded)}`;
    expect(firstText).toContain("FIRST_ARG_CANARY");
    expect(firstText).toContain("FIRST_RESULT_CANARY");
    expect(firstText).not.toMatch(/SECOND_(?:ARG|RESULT)_CANARY/u);
    expect(secondText).toContain("SECOND_ARG_CANARY");
    expect(secondText).toContain("SECOND_RESULT_CANARY");
    expect(secondText).not.toMatch(/FIRST_(?:ARG|RESULT)_CANARY/u);
  });

  it("recognizes collapsed canonical shape without touching source-bearing result descriptors or content text", () => {
    const tool = withNotebookEditRendering(rawTool());
    const callArgs = args("replace");
    const state = {};
    const ctx = context(state, callArgs);
    tool.renderCall(callArgs, theme, ctx);
    const canonical = resultFor(callArgs);
    let sourceDescriptorAccesses = 0;
    let factSourceDescriptorAccesses = 0;
    let contentTextDescriptorAccesses = 0;
    const canonicalDetails = canonical.details as Record<PropertyKey, unknown>;
    canonicalDetails[NOTEBOOK_MUTATION_FACTS] = new Proxy(
      canonicalDetails[NOTEBOOK_MUTATION_FACTS] as Record<PropertyKey, unknown>,
      {
        getOwnPropertyDescriptor(target, key) {
          if (["document", "newSource", "oldSource"].includes(String(key))) {
            factSourceDescriptorAccesses += 1;
            throw new Error("collapsed fact source descriptor trap");
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    canonical.details = new Proxy(canonicalDetails, {
      getOwnPropertyDescriptor(target, key) {
        if (["new_source", "old_source", "original_file", "updated_file"].includes(String(key))) {
          sourceDescriptorAccesses += 1;
          throw new Error("collapsed source descriptor trap");
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const block = (canonical.content as Array<Record<string, unknown>>)[0]!;
    (canonical.content as Array<Record<string, unknown>>)[0] = new Proxy(block, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "text") {
          contentTextDescriptorAccesses += 1;
          throw new Error("collapsed content text trap");
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const shown = tool.renderResult(canonical, { expanded: false, isPartial: false }, theme, {
      ...ctx, executionStarted: true,
    });
    shown.render(120);
    shown.render(120);
    expect(text(shown)).toBe("");
    expect(sourceDescriptorAccesses).toBe(0);
    expect(factSourceDescriptorAccesses).toBe(0);
    expect(contentTextDescriptorAccesses).toBe(0);
  });

  it("does not inspect retained source while collapsed and caches expanded projection across repaint", () => {
    bridge.expansion = { available: true, value: "ctrl+x" };
    let sourceDescriptors = 0;
    const target = args("replace");
    const trapped = new Proxy(target, {
      getOwnPropertyDescriptor(object, key) {
        if (key === "new_source") sourceDescriptors += 1;
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    });
    const tool = withNotebookEditRendering(rawTool());
    const state = {};
    const collapsedCtx = context(state, trapped);
    const collapsed = tool.renderCall(trapped, theme, collapsedCtx);
    const shown = tool.renderResult(resultFor(target), { expanded: false, isPartial: false }, theme, {
      ...collapsedCtx, executionStarted: true,
    });
    collapsed.render(120);
    collapsed.render(120);
    shown.render(120);
    shown.render(120);
    expect(sourceDescriptors).toBe(0);

    const expanded = tool.renderCall(trapped, theme, { ...collapsedCtx, expanded: true, executionStarted: true });
    expect(sourceDescriptors).toBe(1);
    expanded.render(80);
    expanded.render(80);
    expect(sourceDescriptors).toBe(1);

    let resultSourceDescriptors = 0;
    const canonical = resultFor(target);
    canonical.details = new Proxy(canonical.details as Record<PropertyKey, unknown>, {
      getOwnPropertyDescriptor(object, key) {
        if (["new_source", "old_source", "original_file", "updated_file"].includes(String(key))) {
          resultSourceDescriptors += 1;
        }
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
    });
    const expandedResult = tool.renderResult(canonical, { expanded: true, isPartial: false }, theme, {
      ...collapsedCtx, expanded: true, executionStarted: true,
    });
    expect(resultSourceDescriptors).toBeGreaterThan(0);
    expect(resultSourceDescriptors).toBeLessThanOrEqual(12);
    const settledAccesses = resultSourceDescriptors;
    expandedResult.render(80);
    expandedResult.render(80);
    expect(resultSourceDescriptors).toBe(settledAccesses);
  });

  it("bounds hostile path, cell identity, and HTML/base64-like expanded source without rescanning", () => {
    bridge.expansion = { available: true, value: "ctrl+x" };
    let sourceReads = 0;
    const source = `<script>alert(1)</script> data:text/html;base64,${"QUJD".repeat(10_000)}\u001b]8;;https://evil.test\u0007`;
    const hostile = new Proxy({
      notebook_path: "/repo/work/control\u001b[31m-book.ipynb",
      new_source: source,
      cell_id: "cell\u0000id",
      edit_mode: "replace",
    }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "new_source") sourceReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const tool = withNotebookEditRendering(rawTool(), { resolveDisplayRoot: () => "/repo/work" });
    const state = {};
    const ctx = context(state, hostile, { expanded: true });
    const call = tool.renderCall(hostile, theme, ctx);
    expect(sourceReads).toBe(1);
    const first = call.render(40);
    const second = call.render(40);
    expect(sourceReads).toBe(1);
    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(32);
    expect(first.every((line: string) => visibleWidth(line) <= 40)).toBe(true);
    expect(first.join("\n")).not.toMatch(/\u001b|https:\/\/evil\.test/u);

    const oversized = args("replace", `/${"p".repeat(20_000)}.ipynb`);
    oversized.cell_id = "c".repeat(1_000);
    const bounded = tool.renderCall(oversized, theme, context({}, oversized));
    expect(text(bounded)).toContain("notebook write");
    expect(text(bounded)).not.toContain(String(oversized.notebook_path));
    expect(text(bounded)).not.toContain(String(oversized.cell_id));
    expect(bounded.render(120).every((line: string) => visibleWidth(line) <= 120)).toBe(true);
  });

  it("never crashes on malformed, cyclic, accessor, throwing, or revoked envelopes", () => {
    const tool = withNotebookEditRendering(rawTool());
    const accessor = Object.defineProperty({}, "notebook_path", { get: () => { throw new Error("trap"); } });
    const throwing = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const values = [undefined, null, 3, [], accessor, throwing, revocable.proxy, cyclic];
    for (const value of values) {
      const state = {};
      const ctx = context(state, value, { isError: true });
      expect(() => tool.renderCall(value, theme, ctx).render(20)).not.toThrow();
      expect(() => tool.renderResult(value, { expanded: false, isPartial: false }, theme, ctx).render(20)).not.toThrow();
    }
  });

  it("preserves every non-presentation descriptor and canonical identity", async () => {
    const execute = async () => "canonical";
    const schema = { identity: "schema" };
    let reads = 0;
    const source = rawTool({ execute, parameters: schema });
    Object.defineProperty(source, "sentinel", {
      configurable: true,
      enumerable: false,
      get() { reads += 1; return "sentinel"; },
    });
    const decorated = withNotebookEditRendering(source);
    expect(decorated.execute).toBe(execute);
    expect(decorated.parameters).toBe(schema);
    expect(Object.getOwnPropertyDescriptor(decorated, "sentinel")).toEqual(Object.getOwnPropertyDescriptor(source, "sentinel"));
    expect(reads).toBe(0);
    expect(await decorated.execute!("id", {}, undefined as never, undefined as never, undefined as never)).toBe("canonical");
  });
});

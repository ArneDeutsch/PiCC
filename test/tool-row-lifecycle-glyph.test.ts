import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  RECORD_EXPAND_HINT,
  RECORD_REFERENCE_NOTE,
  renderSendMessageResult,
  renderSettlementRecord,
  renderTaskStopCall,
  renderTaskStopResult,
  type SubagentLifecycleRenderContext,
} from "../src/runtime/subagent-render.js";
import { createAgentToolDefinition } from "../src/runtime/subagents.js";
import { BackgroundTaskRegistry, createTaskOutputTool } from "../src/runtime/background-tasks.js";
import { wrapForSelfShell, type RenderCtx } from "../src/runtime/tool-shell.js";
import { fakeSdk, makeAgent, makeSubagentRuntime } from "./helpers/fake-sdk.js";

const ESC = "\u001b";
const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/gu, "");
const theme = {
  fg(slot: string, text: string) {
    const code = slot === "muted" ? 90 : slot === "success" ? 32 : slot === "error" ? 31 : slot === "warning" ? 33 : 36;
    return `${ESC}[${code}m${text}${ESC}[39m`;
  },
  bold: (text: string) => text,
};

type Component = { render(width: number): string[] };
type Tool = Record<string, unknown>;
type Result = { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> };

function lifecycleTool(name: "Agent" | "Task" | "TaskOutput"): Tool {
  if (name === "TaskOutput") {
    return wrapForSelfShell(createTaskOutputTool(new BackgroundTaskRegistry()));
  }
  const runtime = makeSubagentRuntime(
    [makeAgent()],
    fakeSdk({ replies: [{ text: "factory final" }] }).sdk,
  );
  return wrapForSelfShell(createAgentToolDefinition(runtime, { depth: 0, name }));
}

function renderPending(name: "Agent" | "Task" | "TaskOutput"): string[] {
  const tool = lifecycleTool(name);
  const context: RenderCtx = { state: {}, isPartial: true };
  const args = name === "TaskOutput"
    ? { task_id: "task-7" }
    : { subagent_type: "reviewer", description: "Check lifecycle" };
  const component = (tool.renderCall as Function)(args, theme, context) as Component;
  return component.render(100).map(stripAnsi);
}

function renderLifecycle(
  name: "Agent" | "Task" | "TaskOutput",
  result: Result,
  options: { expanded: boolean; isPartial?: boolean; isError?: boolean } = { expanded: false },
  width = 100,
): string[] {
  const tool = lifecycleTool(name);
  const context: RenderCtx = {
    state: {},
    isPartial: options.isPartial === true,
    isError: options.isError === true,
  };
  const args = name === "TaskOutput" ? { task_id: "task-7" } : { subagent_type: "reviewer" };
  const call = (tool.renderCall as Function)(args, theme, context) as Component;
  const canonical = structuredClone(result);
  const rendered = (tool.renderResult as Function)(result, options, theme, context) as Component;
  expect(call.render(width)).toEqual([]);
  const lines = rendered.render(width).map(stripAnsi);
  expect(result).toEqual(canonical);
  return lines;
}

function stateGlyphCount(lines: string[]): number {
  return (lines.join("\n").match(/[○●✗■]/gu) ?? []).length;
}

function expectSingleMarker(lines: string[], glyph: "○" | "●" | "✗" | "■"): void {
  expect(lines[0]).toMatch(new RegExp(`^${glyph}(?: |$)`));
  expect(stateGlyphCount(lines)).toBe(1);
}

const baseDetails = {
  agent: "reviewer",
  agentId: "agent-aabbccddeeff",
  durationMs: 1250,
  settledAt: new Date(2026, 0, 1, 12, 34).getTime(),
  usage: { inputTokens: 12, outputTokens: 4 },
};

const result = (details: Record<string, unknown>, text = "semantic body"): Result => ({
  content: [{ type: "text", text }],
  details: { ...baseDetails, ...details },
});

describe("subagent lifecycle glyph ownership", () => {
  it.each(["Agent", "Task", "TaskOutput"] as const)("shows one running marker for pending %s", (name) => {
    const lines = renderPending(name);
    expectSingleMarker(lines, "○");
    expect(lines.join("\n")).toContain(name === "TaskOutput" ? "task output task-7 [awaiting]" : "reviewer");
  });

  it.each(["Agent", "Task", "TaskOutput"] as const)("uses shell failure for unstructured final %s errors", (name) => {
    const unstructured: Result = { content: [{ type: "text", text: "factory error" }] };
    const lines = renderLifecycle(name, unstructured, { expanded: false, isError: true });
    expectSingleMarker(lines, "✗");
    expect(lines.join("\n")).toContain("factory error");
  });

  it.each(["Agent", "Task", "TaskOutput"] as const)("gives partial user-stopped %s defensive outcomes stopped semantics", (name) => {
    for (const outcome of ["failed", "aborted"] as const) {
      const defensive = result({
        ...(name === "TaskOutput" ? { taskId: "task-7", status: "stopped" } : {}),
        outcome,
        userStopped: true,
      }, "defensive partial");
      const canonical = structuredClone(defensive);
      const lines = renderLifecycle(name, defensive, { expanded: false, isPartial: true });
      expectSingleMarker(lines, "■");
      expect(lines.join("\n")).toContain("stopped by user");
      expect(lines.join("\n")).not.toContain("running");
      expect(defensive).toEqual(canonical);
    }
  });

  it.each(["Agent", "Task"] as const)("maps completed, failed, and stopped foreground %s outcomes", (name) => {
    for (const scenario of [
      { outcome: "completed", glyph: "●", word: "completed" },
      { outcome: "failed", glyph: "✗", word: "failed" },
      { outcome: "aborted", glyph: "■", word: "aborted" },
    ] as const) {
      const lines = renderLifecycle(name, result({ outcome: scenario.outcome }));
      expectSingleMarker(lines, scenario.glyph);
      expect(lines.join("\n")).toContain(`reviewer [${scenario.word}]`);
      expect(lines.join("\n")).toContain(RECORD_EXPAND_HINT);
    }
  });

  it("maps successful-channel partial-output failure to failure without losing the body", () => {
    const lines = renderLifecycle("Agent", result({ outcome: "failed", cutOff: true, error: "provider stopped" }, "partial answer"), { expanded: true });
    expectSingleMarker(lines, "✗");
    expect(lines.join("\n")).toContain("failed (partial output preserved)");
    expect(lines.join("\n")).toContain("partial answer");
    expect(lines.join("\n")).toContain("duration: 1s");
    expect(lines.join("\n")).toContain("usage: in 12 · out 4");
  });

  it("maps successful background dispatch, foreground partial output, and a running poll", () => {
    const background = renderLifecycle("Agent", result({ background: true, taskId: "task-7", description: "Check lifecycle" }, "started"));
    expectSingleMarker(background, "●");
    expect(background.join("\n")).toContain("reviewer [background] - Check lifecycle");

    const partial = renderLifecycle("Agent", result({ live: true }, "working"), { expanded: false, isPartial: true });
    expectSingleMarker(partial, "○");
    expect(partial.join("\n")).toContain("reviewer [running]");

    const poll = renderLifecycle("TaskOutput", result({ taskId: "task-7", status: "running", lastActivity: "reading" }));
    expectSingleMarker(poll, "○");
    expect(poll.join("\n")).toContain("task output task-7");
    expect(poll.join("\n")).toContain("running");
  });

  it.each([
    { status: "completed", outcome: "completed", glyph: "●", word: "completed" },
    { status: "failed", outcome: "failed", glyph: "✗", word: "failed" },
    { status: "stopped", outcome: "aborted", glyph: "■", word: "aborted" },
    { status: "stopped", outcome: "aborted", glyph: "■", word: "stopped by user", userStopped: true },
  ] as const)("maps TaskOutput $word", (scenario) => {
    const lines = renderLifecycle("TaskOutput", result({ taskId: "task-7", ...scenario }));
    expectSingleMarker(lines, scenario.glyph);
    expect(lines.join("\n")).toContain(scenario.word);
    expect(lines.join("\n")).toContain("task output task-7");
  });

  it.each([
    { name: "collapsed", options: { expanded: false }, alreadyReported: false },
    { name: "expanded", options: { expanded: true }, alreadyReported: false },
    { name: "reference", options: { expanded: false }, alreadyReported: true },
  ])("keeps one marker and semantic metadata in the $name variant", ({ options, alreadyReported }) => {
    const lines = renderLifecycle("Agent", result({ outcome: "failed", error: "provider stopped", alreadyReported }), options);
    expectSingleMarker(lines, "✗");
    expect(lines.join("\n")).toContain("failed");
    expect(lines.join("\n")).toContain(alreadyReported ? RECORD_REFERENCE_NOTE : options.expanded ? "semantic body" : "provider stopped");
  });

  it.each([
    { name: "collapsed", options: { expanded: false }, alreadyReported: false },
    { name: "expanded", options: { expanded: true }, alreadyReported: false },
    { name: "reference", options: { expanded: false }, alreadyReported: true },
  ])("gives failed-plus-user-stopped precedence in the $name variant", ({ options, alreadyReported }) => {
    const lines = renderLifecycle("Agent", result({
      outcome: "failed",
      userStopped: true,
      error: "provider stopped",
      alreadyReported,
    }), options);
    expectSingleMarker(lines, "■");
    expect(lines.join("\n")).toContain("stopped by user");
  });

  it("executes the real Agent and Task factories without renderer mutation", async () => {
    for (const name of ["Agent", "Task"] as const) {
      const runtime = makeSubagentRuntime(
        [makeAgent()],
        fakeSdk({ replies: [{ text: `${name} canonical final` }] }).sdk,
      );
      const tool = wrapForSelfShell(createAgentToolDefinition(runtime, { depth: 0, name }));
      const execute = tool.execute as (id: string, params: Record<string, unknown>) => Promise<Result>;
      const produced = await execute("call", {
        subagent_type: "worker",
        prompt: "verify factory",
        run_in_background: false,
      });
      const canonical = structuredClone(produced);
      const context: RenderCtx = { state: {}, isPartial: false };
      const component = (tool.renderResult as Function)(
        produced,
        { expanded: true, isPartial: false },
        theme,
        context,
      ) as Component;
      expectSingleMarker(component.render(100).map(stripAnsi), "●");
      expect(produced).toEqual(canonical);
      expect(produced.content[0]?.text).toBe(`${name} canonical final`);
      expect(produced.details?.outcome).toBe("completed");
    }
  });
});

describe("unwrapped settlement symbols", () => {
  const settlement = (outcome: "completed" | "failed" | "aborted", alreadyReported = false) => ({
    record: "subagent-completion",
    taskId: "task-7",
    agent: "reviewer",
    outcome,
    alreadyReported,
    error: outcome === "failed" ? "provider stopped" : undefined,
    finalText: "settled body",
  });

  it("retains completed collapsed/reference omission and expanded symbol", () => {
    const collapsed = renderSettlementRecord(settlement("completed"), { expanded: false }, theme)!.render(100).map(stripAnsi);
    const expanded = renderSettlementRecord(settlement("completed"), { expanded: true }, theme)!.render(100).map(stripAnsi);
    const reference = renderSettlementRecord(settlement("completed", true), { expanded: false }, theme)!.render(100).map(stripAnsi);
    expect(stateGlyphCount(collapsed)).toBe(0);
    expect(expanded[0]).toMatch(/^● reviewer \[completed\]/);
    expect(stateGlyphCount(expanded)).toBe(1);
    expect(stateGlyphCount(reference)).toBe(0);
  });

  it.each([
    { outcome: "failed", glyph: "✗" },
    { outcome: "aborted", glyph: "■" },
  ] as const)("retains $outcome symbols in collapsed, expanded, and reference records", ({ outcome, glyph }) => {
    for (const [expanded, alreadyReported] of [[false, false], [true, false], [false, true]] as const) {
      const lines = renderSettlementRecord(settlement(outcome, alreadyReported), { expanded }, theme)!.render(100).map(stripAnsi);
      expect(lines[0]).toMatch(new RegExp(`^${glyph} `));
      expect(stateGlyphCount(lines)).toBe(1);
    }
  });
});

describe("lifecycle control result discriminators", () => {
  function renderControl(
    name: "SendMessage" | "TaskStop",
    details: Record<string, unknown> | undefined,
    ordinary: Pick<RenderCtx, "isError"> = {},
    width = 100,
    text = "canonical acknowledgement",
  ): string[] {
    const renderer = name === "SendMessage" ? renderSendMessageResult : renderTaskStopResult;
    const tool = wrapForSelfShell({ name, renderResult: (value: Result, _options: unknown, selectedTheme: unknown, context: SubagentLifecycleRenderContext) => renderer(value, selectedTheme, context) });
    const context: RenderCtx = { state: {}, isPartial: false, ...ordinary };
    const component = (tool.renderResult as Function)(
      { content: [{ type: "text", text }], details },
      { expanded: false, isPartial: false },
      theme,
      context,
    ) as Component;
    return component.render(width).map(stripAnsi);
  }

  it.each([
    { outcome: "completed", glyph: "●" },
    { outcome: "failed", glyph: "✗" },
    { outcome: "aborted", glyph: "■" },
  ] as const)("maps checkpoint-recovery SendMessage $outcome", ({ outcome, glyph }) => {
    const lines = renderControl("SendMessage", { delivery: "checkpoint-recovery", outcome });
    expectSingleMarker(lines, glyph);
    expect(lines.join("\n")).toContain("canonical acknowledgement");
  });

  it.each(["steer", "resume"])("leaves ordinary SendMessage %s acknowledgement on normal success", (delivery) => {
    expectSingleMarker(renderControl("SendMessage", { delivery, outcome: "failed" }), "●");
  });

  it("lets a settled TaskStop result replace its pending target header without a second shell glyph", () => {
    const state = {};
    const context: SubagentLifecycleRenderContext = { state, args: { task_id: "task-requested-123456789" } };
    const callTool = wrapForSelfShell({
      name: "TaskStop",
      renderCall: (args: Record<string, unknown>, selectedTheme: unknown, ctx: SubagentLifecycleRenderContext) =>
        renderTaskStopCall(args, selectedTheme, ctx),
      renderResult: (value: Result, _options: unknown, selectedTheme: unknown, ctx: SubagentLifecycleRenderContext) =>
        renderTaskStopResult(value, selectedTheme, ctx),
    });
    const call = (callTool.renderCall as Function)(context.args, theme, context) as Component;
    const canonical = { content: [{ type: "text", text: "canonical acknowledgement" }], details: { taskId: "task-7", status: "stopped" } };
    const before = structuredClone(canonical);
    const resultComponent = (callTool.renderResult as Function)(canonical, {}, theme, context) as Component;
    expect(call.render(80)).toEqual([]);
    const settled = resultComponent.render(24).map(stripAnsi);
    expect(settled.join("\n").replace(/\s/gu, "")).toContain("task-requested-123456789");
    expect(settled.join("\n").match(/task stop/gu)).toHaveLength(1);
    expectSingleMarker(settled, "■");
    expect(canonical).toEqual(before);
  });

  it.each([
    { status: "completed", glyph: "●" },
    { status: "failed", glyph: "✗" },
    { status: "stopped", glyph: "■" },
  ] as const)("maps exact TaskStop $status records", ({ status, glyph }) => {
    expectSingleMarker(renderControl("TaskStop", { taskId: "task-7", status }), glyph);
    expectSingleMarker(renderControl("TaskStop", { agentId: "agent-aabbccddeeff", checkpointPaused: true, status }), glyph);
  });

  it("does not reinterpret running, malformed, unrelated, or ordinary errors", () => {
    expectSingleMarker(renderControl("TaskStop", { taskId: "task-7", status: "running" }), "●");
    expectSingleMarker(renderControl("TaskStop", { status: "failed" }), "●");
    expectSingleMarker(renderControl("TaskStop", { taskId: "not-a-task", status: "failed" }), "●");
    expectSingleMarker(renderControl("TaskStop", { outcome: "failed" }), "●");
    expectSingleMarker(renderControl("TaskStop", undefined, { isError: true }), "✗");
  });

  it("keeps lifecycle variants width-safe with one marker and aligned continuations", () => {
    const cases = [
      { render: (width: number) => renderLifecycle("Agent", result({ outcome: "completed" }), { expanded: false }, width), semantic: "completed" },
      { render: (width: number) => renderLifecycle("Agent", result({ outcome: "failed", error: "provider stopped" }), { expanded: true }, width), semantic: "failed" },
      { render: (width: number) => renderLifecycle("Agent", result({ outcome: "aborted", alreadyReported: true }), { expanded: false }, width), semantic: "aborted" },
      { render: (width: number) => renderLifecycle("Agent", result({ live: true }, "working"), { expanded: false, isPartial: true }, width), semantic: "running" },
      { render: (width: number) => renderLifecycle("TaskOutput", result({ taskId: "task-7", status: "running", lastActivity: "reading" }), { expanded: false }, width), semantic: "running" },
      { render: (width: number) => renderLifecycle("Agent", result({ outcome: "failed", cutOff: true }, "partial answer"), { expanded: true }, width), semantic: "failed" },
      { render: (width: number) => renderControl("SendMessage", { delivery: "checkpoint-recovery", outcome: "completed" }, {}, width, "first line\nsecond line"), semantic: "first line" },
    ];

    for (const testCase of cases) {
      for (const width of [1, 2, 3, 12, 100]) {
        const lines = testCase.render(width);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(stateGlyphCount(lines)).toBe(1);
        if (width >= 3) {
          for (const line of lines.slice(1)) expect(line.startsWith("  ")).toBe(true);
        }
        if (width === 100) {
          expect(lines.join("\n")).toContain(testCase.semantic);
          expect(lines.join("\n")).toMatch(/(?:reviewer|task output task-7|first line)/u);
        }
      }
    }
  });
});

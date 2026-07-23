import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  RECORD_EXPAND_HINT,
  RECORD_REFERENCE_NOTE,
  renderAgentCall,
  renderSendMessageCall,
  renderSendMessageResult,
  renderSettlementRecord,
  renderTaskOutputCall,
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

  it("coalesces exact ordinary SendMessage results into one result-owned row without a message preview", () => {
    const makeContext = (to: string, message: string): SubagentLifecycleRenderContext => ({
      state: {}, args: { to, message }, isError: false,
    });
    const steerContext = makeContext("reviewer", "MESSAGE-PREVIEW-SENTINEL");
    const resumeContext = makeContext("agent-aabbccddeeff", "SECOND-MESSAGE-SENTINEL");
    const callA = renderSendMessageCall(steerContext.args as Record<string, unknown>, theme, steerContext);
    const callB = renderSendMessageCall(resumeContext.args as Record<string, unknown>, theme, resumeContext);
    expect(callA.render(80)).toEqual([]);
    expect(callB.render(80)).toEqual([]);

    const steer = {
      content: [{ type: "text", text: 'Message delivered to running agent agent-aabbccddeeff ("reviewer") as a mid-task course correction.' }],
      details: { agentId: "agent-aabbccddeeff", agent: "reviewer", description: "review", delivery: "steer" },
      terminate: true,
    };
    const resume = {
      content: [{ type: "text", text: 'Task(task-7) · Agent(reviewer) · agent-aabbccddeeff — resume accepted in background with prior context; it will run when configured concurrency capacity is available. Retrieve it with TaskOutput (task_id "task-7").' }],
      details: { agentId: "agent-aabbccddeeff", agent: "reviewer", taskId: "task-7", admission: "waiting", description: "review", delivery: "resume", resumed: true },
    };
    const before = structuredClone([steer, resume]);
    const steerLines = renderSendMessageResult(steer, theme, steerContext).render(80).map(stripAnsi);
    const resumeLines = renderSendMessageResult(resume, theme, resumeContext).render(80).map(stripAnsi);
    expect(steerLines).toHaveLength(1);
    expect(steerLines[0]).toContain("reviewer");
    expect(steerLines[0]).toContain("delivered");
    expect(resumeLines).toHaveLength(1);
    expect(resumeLines[0]).toContain("agent-aabbccddeeff");
    expect(resumeLines[0]).toContain("resume");
    expect(resumeLines[0]).toContain("⚠ waiting");
    expect([...steerLines, ...resumeLines].join("\n")).not.toMatch(/MESSAGE-PREVIEW|SECOND-MESSAGE/u);
    expect([steer, resume]).toEqual(before);
  });

  it("fails open for incoherent or unfamiliar SendMessage results with recipient and result evidence", () => {
    const context: SubagentLifecycleRenderContext = { state: {}, args: { to: "reviewer", message: "hidden" } };
    renderSendMessageCall(context.args as Record<string, unknown>, theme, context);
    const malformed = {
      content: [{ type: "text", text: "DECISIVE-FAILURE-EVIDENCE" }, { type: "text", text: "extra" }],
      details: { agentId: "agent-aabbccddeeff", agent: "reviewer", description: "review", delivery: "steer", future: true },
    };
    const lines = renderSendMessageResult(malformed, theme, context).render(80).map(stripAnsi);
    expect(lines.join("\n")).toContain("reviewer");
    expect(lines.join("\n")).toContain("DECISIVE-FAILURE-EVIDENCE");
    expect(lines).toHaveLength(3);
  });

  function renderCheckpoint(
    details: Record<string, unknown>,
    options: { isError?: boolean; envelope?: Record<string, unknown>; blocks?: Result["content"]; width?: number } = { isError: false },
  ): string[] {
    const context: RenderCtx = { state: {}, ...(Object.hasOwn(options, "isError") ? { isError: options.isError } : {}) };
    const tool = wrapForSelfShell({
      name: "SendMessage",
      renderCall: renderSendMessageCall,
      renderResult: (value: Result, _renderOptions: unknown, selectedTheme: unknown, ctx: SubagentLifecycleRenderContext) =>
        renderSendMessageResult(value, selectedTheme, ctx),
    });
    const args = { to: "reviewer", message: "recover" };
    (tool.renderCall as Function)(args, theme, context);
    const value = {
      content: options.blocks ?? [{ type: "text", text: "canonical checkpoint body evidence" }],
      details,
      ...options.envelope,
    };
    return ((tool.renderResult as Function)(value, {}, theme, context) as Component).render(options.width ?? 100).map(stripAnsi);
  }

  it.each([
    { outcome: "completed", recovered: true, truncated: false, glyph: "●", state: "recovered" },
    { outcome: "failed", recovered: false, truncated: false, glyph: "✗", state: "failed" },
    { outcome: "aborted", recovered: false, truncated: false, glyph: "■", state: "aborted" },
    { outcome: "completed", recovered: true, truncated: true, glyph: "✗", state: "truncated" },
  ] as const)("maps exact checkpoint-recovery $outcome (truncated=$truncated)", (scenario) => {
    const lines = renderCheckpoint({
      agentId: "agent-aabbccddeeff",
      agent: "reviewer",
      delivery: "checkpoint-recovery",
      outcome: scenario.outcome,
      recovered: scenario.recovered,
      truncated: scenario.truncated,
    });
    expectSingleMarker(lines, scenario.glyph);
    expect(lines.join("\n")).toContain("reviewer");
    expect(lines.join("\n")).toContain(scenario.state);
    expect(lines.join("\n")).toContain("canonical checkpoint body evidence");
  });

  it("retains checkpoint recipient and decisive non-success state at practical widths", () => {
    for (const scenario of [
      { outcome: "failed", recovered: false, truncated: false, state: "failed" },
      { outcome: "aborted", recovered: false, truncated: false, state: "aborted" },
      { outcome: "completed", recovered: true, truncated: true, state: "truncated" },
    ] as const) {
      const lines = renderCheckpoint({
        agentId: "agent-aabbccddeeff", agent: "reviewer", delivery: "checkpoint-recovery",
        outcome: scenario.outcome, recovered: scenario.recovered, truncated: scenario.truncated,
      }, { isError: false, width: 32 });
      expect(lines[0]).toContain("reviewer");
      expect(lines[0]).toContain(scenario.state);
      expect(lines.join("\n").replace(/\s+/gu, " ")).toContain("canonical checkpoint body evidence");
    }
  });

  it("fails malformed and incoherent checkpoint recovery closed while retaining body evidence", () => {
    const base = {
      agentId: "agent-aabbccddeeff",
      agent: "reviewer",
      delivery: "checkpoint-recovery",
      outcome: "completed",
      recovered: true,
      truncated: false,
    };
    const variants = [
      { ...base, extra: true },
      { ...base, recovered: false },
      { ...base, truncated: "false" },
      { ...base, agentId: "not-an-agent" },
      { ...base, agent: "another" },
    ];
    for (const details of variants) {
      const lines = renderCheckpoint(details);
      expectSingleMarker(lines, "✗");
      expect(lines.join("\n")).toContain("canonical checkpoint body evidence");
    }
    expectSingleMarker(renderCheckpoint(base, { isError: false, envelope: { future: true } }), "✗");
    expectSingleMarker(renderCheckpoint(base, { isError: false, blocks: [
      { type: "text", text: "canonical checkpoint body evidence" },
      { type: "text", text: "extra" },
    ] }), "✗");
    expectSingleMarker(renderCheckpoint(base, { isError: true }), "✗");
    expectSingleMarker(renderCheckpoint(base, {}), "●");

    const renderRaw = (value: unknown): string[] => {
      const context: RenderCtx = { state: {}, isError: false };
      const tool = wrapForSelfShell({ name: "SendMessage", renderCall: renderSendMessageCall,
        renderResult: (resultValue: Result, _options: unknown, selectedTheme: unknown, ctx: SubagentLifecycleRenderContext) => renderSendMessageResult(resultValue, selectedTheme, ctx) });
      (tool.renderCall as Function)({ to: "reviewer", message: "recover" }, theme, context);
      return ((tool.renderResult as Function)(value, {}, theme, context) as Component).render(100).map(stripAnsi);
    };
    const accessorEnvelope = {
      content: [{ type: "text", text: "accessor checkpoint evidence" }],
    } as Record<string, unknown>;
    Object.defineProperty(accessorEnvelope, "details", { enumerable: true, configurable: true, get: () => base });
    const accessorLines = renderRaw(accessorEnvelope);
    expectSingleMarker(accessorLines, "✗");
    expect(accessorLines.join("\n")).toContain("accessor checkpoint evidence");

    const throwingProxy = new Proxy({
      content: [{ type: "text", text: "unreachable proxy evidence" }], details: base,
    }, {
      getPrototypeOf() { throw new Error("proxy envelope rejected"); },
      get() { throw new Error("proxy envelope rejected"); },
      ownKeys() { throw new Error("proxy envelope rejected"); },
      getOwnPropertyDescriptor() { throw new Error("proxy envelope rejected"); },
    });
    expectSingleMarker(renderRaw(throwingProxy), "✗");
  });

  it.each(["steer", "resume"])("marks unrecognized non-error SendMessage %s envelopes as failures", (delivery) => {
    expectSingleMarker(renderControl("SendMessage", { delivery, outcome: "failed" }), "✗");
  });

  it("accepts every exact ordinary envelope and persisted description variant", () => {
    const envelopes = [
      {},
      { terminate: true },
    ];
    const descriptions = [
      { description: "review" },
      { description: undefined },
      {},
    ];
    for (const envelope of envelopes) {
      for (const description of descriptions) {
        const state = Object.freeze({});
        const context: RenderCtx = { state, isError: false };
        const tool = wrapForSelfShell({
          name: "SendMessage",
          renderCall: renderSendMessageCall,
          renderResult: (value: Result, _options: unknown, selectedTheme: unknown, ctx: SubagentLifecycleRenderContext) =>
            renderSendMessageResult(value, selectedTheme, ctx),
        });
        const args = JSON.parse(JSON.stringify({ to: "reviewer", message: "hidden" })) as Record<string, unknown>;
        (tool.renderCall as Function)(args, theme, context);
        for (const delivery of ["steer", "resume"] as const) {
          const result = delivery === "steer" ? {
            content: JSON.parse(JSON.stringify([{ type: "text", text: 'Message delivered to running agent agent-aabbccddeeff ("reviewer") as a mid-task course correction.' }])),
            details: { agentId: "agent-aabbccddeeff", agent: "reviewer", ...description, delivery },
            ...envelope,
          } : {
            content: JSON.parse(JSON.stringify([{ type: "text", text: 'Task(task-7) · Agent(reviewer) · agent-aabbccddeeff — resume accepted in background with prior context; it will run when configured concurrency capacity is available. Retrieve it with TaskOutput (task_id "task-7").' }])),
            details: { agentId: "agent-aabbccddeeff", agent: "reviewer", taskId: "task-7", admission: "admitted", ...description, delivery, resumed: true },
            ...envelope,
          };
          const lines = ((tool.renderResult as Function)(result, {}, theme, context) as Component).render(100).map(stripAnsi);
          expectSingleMarker(lines, "●");
          expect(lines.join("\n")).not.toMatch(/Message delivered to running agent|resume accepted in background with prior context/u);
        }
      }
    }
  });

  it("rejects every unfamiliar envelope discriminator and fails closed through the self shell", () => {
    const variants: Array<[string, (result: Record<string, unknown>) => void]> = [
      ["terminate undefined", (value) => { value.terminate = undefined; }],
      ["terminate false", (value) => { value.terminate = false; }],
      ["isError true", (value) => { value.isError = true; }],
      ["unknown key", (value) => { value.future = true; }],
      ["symbol key", (value) => { value[Symbol("future") as unknown as string] = true; }],
      ["accessor", (value) => { Object.defineProperty(value, "details", { get: () => value, enumerable: true, configurable: true }); }],
    ];
    for (const [name, mutate] of variants) {
      const state = {};
      const context: RenderCtx = { state, isError: false };
      const tool = wrapForSelfShell({ name: "SendMessage", renderCall: renderSendMessageCall,
        renderResult: (value: Result, _options: unknown, selectedTheme: unknown, ctx: SubagentLifecycleRenderContext) => renderSendMessageResult(value, selectedTheme, ctx) });
      (tool.renderCall as Function)({ to: "reviewer", message: "hidden" }, theme, context);
      const value: Record<string, unknown> = {
        content: [{ type: "text", text: 'Message delivered to running agent agent-aabbccddeeff ("reviewer") as a mid-task course correction.' }],
        details: { agentId: "agent-aabbccddeeff", agent: "reviewer", delivery: "steer" },
      };
      mutate(value);
      const lines = ((tool.renderResult as Function)(value, {}, theme, context) as Component).render(100).map(stripAnsi);
      expectSingleMarker(lines, "✗");
      expect(lines.join("\n"), name).toContain("Message delivered");
    }
  });

  it("rejects non-exact call objects, arrays, blocks, details, and acknowledgement mismatches", () => {
    const canonical = () => ({
      content: [{ type: "text", text: 'Message delivered to running agent agent-aabbccddeeff ("reviewer") as a mid-task course correction.' }],
      details: { agentId: "agent-aabbccddeeff", agent: "reviewer", delivery: "steer" },
    });
    const invalidCalls: Record<string, unknown>[] = [
      { to: "reviewer" },
      { to: "reviewer", message: "hidden", extra: true },
      Object.assign(Object.create(null), { to: "reviewer", message: "hidden" }) as Record<string, unknown>,
      Object.defineProperty({ to: "reviewer" }, "message", { get: () => "hidden", enumerable: true }),
      Object.defineProperty({ message: "hidden" }, "to", { value: "reviewer", enumerable: true, writable: false, configurable: true }),
    ];
    const malformedResults: Array<(value: ReturnType<typeof canonical>) => unknown> = [
      (value) => ({ ...value, content: Object.assign([value.content[0]], { 1: value.content[0], length: 2 }) }),
      (value) => ({ ...value, content: [{ ...value.content[0], extra: true }] }),
      (value) => ({ ...value, details: { ...value.details, description: null } }),
      (value) => ({ ...value, details: { ...value.details, extra: true } }),
      (value) => ({ ...value, content: [{ type: "text", text: "ack mismatch" }] }),
    ];
    for (const args of invalidCalls) {
      const context: SubagentLifecycleRenderContext = { state: {}, isError: false };
      renderSendMessageCall(args, theme, context);
      expect(renderSendMessageResult(canonical(), theme, context).render(100).map(stripAnsi).join("\n")).toContain("Message delivered");
    }
    for (const mutate of malformedResults) {
      const context: SubagentLifecycleRenderContext = { state: {}, isError: false };
      renderSendMessageCall({ to: "reviewer", message: "hidden" }, theme, context);
      expect(renderSendMessageResult(mutate(canonical()) as Result, theme, context).render(100).map(stripAnsi).join("\n")).toMatch(/Message delivered|ack mismatch/u);
    }
  });

  it("uses detached descriptor values without invoking validated proxy getters", () => {
    const descriptorProxy = <T extends object>(target: T): T => new Proxy(target, {
      get() { throw new Error("validated proxy was re-read"); },
      getPrototypeOf: () => Reflect.getPrototypeOf(target),
      ownKeys: () => Reflect.ownKeys(target),
      getOwnPropertyDescriptor: (_value, key) => Reflect.getOwnPropertyDescriptor(target, key),
    });
    const state = {};
    const context: SubagentLifecycleRenderContext = { state, isError: false };
    const args = descriptorProxy({ to: "reviewer", message: "hidden" });
    renderSendMessageCall(args, theme, context);
    const block = descriptorProxy({ type: "text", text: 'Message delivered to running agent agent-aabbccddeeff ("reviewer") as a mid-task course correction.' });
    const content = descriptorProxy([block]);
    const details = descriptorProxy({ agentId: "agent-aabbccddeeff", agent: "reviewer", delivery: "steer" });
    const result = descriptorProxy({ content, details });
    expect(renderSendMessageResult(result, theme, context).render(100).map(stripAnsi).join("\n")).toContain("reviewer");
  });

  it("isolates reverse-order interleaving and fails closed for hostile state", () => {
    const first: SubagentLifecycleRenderContext = { state: {}, isError: false };
    const second: SubagentLifecycleRenderContext = { state: {}, isError: false };
    renderSendMessageCall({ to: "first", message: "A" }, theme, first);
    renderSendMessageCall({ to: "second", message: "B" }, theme, second);
    const steer = (agent: string, id: string) => ({ content: [{ type: "text", text: `Message delivered to running agent ${id} ("${agent}") as a mid-task course correction.` }], details: { agentId: id, agent, delivery: "steer" } });
    expect(renderSendMessageResult(steer("second", "agent-bbbbbbbbbbbb"), theme, second).render(100).map(stripAnsi).join("\n")).toContain("second");
    expect(renderSendMessageResult(steer("first", "agent-aaaaaaaaaaaa"), theme, first).render(100).map(stripAnsi).join("\n")).toContain("first");

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostile: SubagentLifecycleRenderContext = { state: revoked.proxy, isError: false };
    expect(() => renderSendMessageCall({ to: "first", message: "secret" }, theme, hostile)).not.toThrow();
    const lines = renderSendMessageResult(steer("first", "agent-aaaaaaaaaaaa"), theme, hostile).render(100).map(stripAnsi);
    expect(lines.join("\n")).toContain("Message delivered");
  });

  it("preserves ordinary operational cues over long recipients across narrow widths", () => {
    const scenarios = [
      { admission: "admitted", required: ["resume", "task-123", "admitted"] },
      { admission: "waiting", required: ["resume", "task-123", "⚠ waiting"] },
    ] as const;
    for (const scenario of scenarios) {
      const context: SubagentLifecycleRenderContext = { state: {}, isError: false };
      const to = "very-long-reviewer-recipient-identity-that-must-yield";
      const agentId = "agent-aaaaaaaaaaaa";
      renderSendMessageCall({ to, message: "hidden" }, theme, context);
      const value = {
        content: [{ type: "text", text: `Task(task-123) · Agent(${to}) · ${agentId} — resume accepted in background with prior context; it will run when configured concurrency capacity is available. Retrieve it with TaskOutput (task_id "task-123").` }],
        details: { agentId, agent: to, taskId: "task-123", admission: scenario.admission, delivery: "resume", resumed: true },
      };
      for (const width of [18, 24, 32, 40, 48, 72]) {
        const rendered = renderSendMessageResult(value, theme, context).render(width);
        const text = rendered.map(stripAnsi).join("");
        if (width >= 18) {
          expect(text).toContain("ver");
          expect(text).toContain("task-123");
        }
        if (width >= 24) expect(text).toContain("resume");
        if (scenario.admission === "waiting" && width >= 32) expect(text).toContain("⚠");
        if (width >= 40) for (const required of scenario.required) expect(text).toContain(required);
        expect(rendered).toHaveLength(1);
        expect(visibleWidth(text)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps steer delivery and optional running state across a width sweep", () => {
    const context: SubagentLifecycleRenderContext = { state: {}, isError: false };
    const to = "very-long-reviewer-recipient-identity-that-must-yield";
    renderSendMessageCall({ to, message: "hidden" }, theme, context);
    const value = {
      content: [{ type: "text", text: `Message delivered to running agent agent-aaaaaaaaaaaa ("${to}") as a mid-task course correction.` }],
      details: { agentId: "agent-aaaaaaaaaaaa", agent: to, delivery: "steer" },
    };
    for (const width of [12, 18, 24, 36, 40, 48, 64, 100]) {
      const rendered = renderSendMessageResult(value, theme, context).render(width);
      const text = rendered.map(stripAnsi).join("");
      expect(text).toContain("ver");
      if (width === 12) expect(text).not.toContain("delivered");
      if (width >= 40) {
        expect(text).toContain("very-");
        expect(text).toContain("delivered");
      }
      expect(rendered).toHaveLength(1);
      expect(visibleWidth(text)).toBeLessThanOrEqual(width);
    }
  });

  it.each([false, true, undefined])("compacts ordinary steer/resume only for context.isError=false (%s)", (isError) => {
    for (const delivery of ["steer", "resume"] as const) {
      const context: SubagentLifecycleRenderContext = {
        state: {},
        ...(isError === undefined ? {} : { isError }),
      };
      renderSendMessageCall({ to: "reviewer", message: "hidden" }, theme, context);
      const value = delivery === "steer" ? {
        content: [{ type: "text", text: 'Message delivered to running agent agent-aabbccddeeff ("reviewer") as a mid-task course correction.' }],
        details: { agentId: "agent-aabbccddeeff", agent: "reviewer", delivery },
      } : {
        content: [{ type: "text", text: 'Task(task-7) · Agent(reviewer) · agent-aabbccddeeff — resume accepted in background with prior context; it will run when configured concurrency capacity is available. Retrieve it with TaskOutput (task_id "task-7").' }],
        details: { agentId: "agent-aabbccddeeff", agent: "reviewer", taskId: "task-7", admission: "admitted", delivery, resumed: true },
      };
      const lines = renderSendMessageResult(value, theme, context).render(100).map(stripAnsi);
      if (isError === false) {
        expect(lines).toHaveLength(1);
        expect(lines.join("\n")).not.toContain(value.content[0]!.text);
      } else {
        expect(lines.join("\n")).toContain(delivery === "steer" ? "Message delivered to running agent" : "resume accepted in background");
      }
    }
  });

  it("rejects invalid resume task, admission, and resumed variants with generic failure evidence", () => {
    const variants = [
      { taskId: "bad-task", admission: "admitted", resumed: true },
      { taskId: "task-7", admission: "future", resumed: true },
      { taskId: "task-7", admission: "admitted", resumed: false },
      { taskId: "task-7", admission: "admitted" },
    ];
    for (const variant of variants) {
      const context: SubagentLifecycleRenderContext = { state: {}, isError: false };
      renderSendMessageCall({ to: "reviewer", message: "hidden" }, theme, context);
      const text = `resume generic evidence ${JSON.stringify(variant)}`;
      const value = {
        content: [{ type: "text", text }],
        details: { agentId: "agent-aabbccddeeff", agent: "reviewer", delivery: "resume", ...variant },
      };
      const tool = wrapForSelfShell({ name: "SendMessage", renderResult: (resultValue: Result, _options: unknown, selectedTheme: unknown, ctx: SubagentLifecycleRenderContext) => renderSendMessageResult(resultValue, selectedTheme, ctx) });
      const lines = ((tool.renderResult as Function)(value, {}, theme, context) as Component).render(120).map(stripAnsi);
      expectSingleMarker(lines, "✗");
      expect(lines.join("\n")).toContain(text);
    }
  });

  it("uses semantic theme roles for launch descriptions, control targets, metadata, and waiting", () => {
    const calls: Array<{ slot: string; text: string }> = [];
    const spyTheme = { fg(slot: string, text: string) { calls.push({ slot, text }); return text; }, bold: (text: string) => text };
    renderAgentCall({ subagent_type: "reviewer", description: "Review lifecycle" }, spyTheme).render(100);
    renderTaskOutputCall({ task_id: "task-7" }, spyTheme).render(100);
    renderTaskStopCall({ task_id: "task-8" }, spyTheme).render(100);
    renderTaskStopResult(
      { content: [{ type: "text", text: "stopped" }], details: { taskId: "task-result-10", status: "stopped" } },
      spyTheme,
      { state: {}, args: { task_id: "task-result-10" }, isError: false },
    ).render(100);
    const context: SubagentLifecycleRenderContext = { state: {}, isError: false };
    renderSendMessageCall({ to: "reviewer", message: "hidden" }, spyTheme, context);
    renderSendMessageResult({
      content: [{ type: "text", text: 'Task(task-9) · Agent(reviewer) · agent-aabbccddeeff — resume accepted in background with prior context; it will run when configured concurrency capacity is available. Retrieve it with TaskOutput (task_id "task-9").' }],
      details: { agentId: "agent-aabbccddeeff", agent: "reviewer", taskId: "task-9", admission: "waiting", delivery: "resume", resumed: true },
    }, spyTheme, context).render(100);
    expect(calls.some(({ slot, text }) => slot === "accent" && text.includes("Review lifecycle"))).toBe(true);
    for (const target of ["task-7", "task-8", "task-result-10", "reviewer"]) expect(calls.some(({ slot, text }) => slot === "accent" && text.includes(target))).toBe(true);
    expect(calls.some(({ slot, text }) => slot === "muted" && /awaiting|resume|task-9/u.test(text))).toBe(true);
    expect(calls.some(({ slot, text }) => slot === "warning" && text.includes("waiting"))).toBe(true);
    expect(calls.filter(({ slot }) => slot === "warning").every(({ text }) => /waiting|⚠/u.test(text))).toBe(true);
    expect(calls.some(({ slot, text }) => slot === "warning" && /resume|task-9|reviewer/u.test(text))).toBe(false);
  });

  it("themes checkpoint recipients and decisive states semantically", () => {
    const calls: Array<{ slot: string; text: string }> = [];
    const spyTheme = { fg(slot: string, text: string) { calls.push({ slot, text }); return text; } };
    for (const scenario of [
      { outcome: "completed", recovered: true, truncated: false, state: "recovered", slot: "success" },
      { outcome: "failed", recovered: false, truncated: false, state: "failed", slot: "error" },
      { outcome: "aborted", recovered: false, truncated: false, state: "aborted", slot: "warning" },
      { outcome: "completed", recovered: true, truncated: true, state: "truncated", slot: "warning" },
    ] as const) {
      const context: SubagentLifecycleRenderContext = { state: {}, isError: false };
      renderSendMessageCall({ to: "reviewer", message: "recover" }, spyTheme, context);
      renderSendMessageResult({
        content: [{ type: "text", text: "canonical checkpoint evidence" }],
        details: {
          agentId: "agent-aabbccddeeff", agent: "reviewer", delivery: "checkpoint-recovery",
          outcome: scenario.outcome, recovered: scenario.recovered, truncated: scenario.truncated,
        },
      }, spyTheme, context).render(48);
      expect(calls).toContainEqual({ slot: "accent", text: "reviewer" });
      expect(calls).toContainEqual({ slot: scenario.slot, text: ` · ${scenario.state}` });
    }
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import {
  type DisplayOperationAuthority,
  withDefaultCollapsedToolRendering,
} from "../src/runtime/default-collapsed-tool-render.js";
import { sanitizeDisplayText } from "../src/runtime/render-util.js";

interface Component { render(width: number): string[] }
interface RenderTool {
  renderCall(args: unknown, theme: unknown, context: unknown): Component;
  renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): Component;
}

const theme = { fg: (_slot: string, text: string) => text, bold: (text: string) => text };
let previousBindings: ReturnType<typeof getKeybindings>;

beforeEach(() => {
  previousBindings = getKeybindings();
  setKeybindings(new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  }, { "app.tools.expand": ["ctrl+o"] }));
});

afterEach(() => setKeybindings(previousBindings));

function countedEnvelope(text: string, extra: Record<string, unknown> = {}) {
  const counts = { envelopeGets: 0, blockGets: 0, bodyGets: 0, ownKeys: 0 };
  const block = new Proxy({ type: "text", text }, {
    get(target, key, receiver) {
      counts.blockGets++;
      if (key === "text") counts.bodyGets++;
      return Reflect.get(target, key, receiver);
    },
  });
  const envelope = new Proxy({ content: [block], details: undefined, ...extra }, {
    get(target, key, receiver) { counts.envelopeGets++; return Reflect.get(target, key, receiver); },
    ownKeys(target) { counts.ownKeys++; return Reflect.ownKeys(target); },
  });
  return { envelope, counts };
}

function instrumented(name: "read" | "bash", failures: { call?: boolean; result?: boolean } = {}) {
  const counts = {
    callConstructs: 0, resultConstructs: 0, detailRenders: 0, bodyCharsObserved: 0,
    sanitize: 0, split: 0, slice: 0, maxSanitizeInput: 0, maxSliceSpan: 0,
  };
  const displayOperations: DisplayOperationAuthority = {
    slice(value, start, end) {
      counts.slice++;
      const resolvedEnd = end ?? value.length;
      const resolvedStart = start < 0 ? Math.max(0, value.length + start) : start;
      counts.maxSliceSpan = Math.max(counts.maxSliceSpan, Math.max(0, resolvedEnd - resolvedStart));
      return value.slice(start, end);
    },
    sanitize(value, limit, inline) {
      counts.sanitize++;
      counts.maxSanitizeInput = Math.max(counts.maxSanitizeInput, value.length);
      return sanitizeDisplayText(value, limit, inline);
    },
    splitLines(value) { counts.split++; return value.split("\n"); },
  };
  const tool = withDefaultCollapsedToolRendering({
    name, execute() {},
    renderCall() {
      counts.callConstructs++;
      if (failures.call) throw new Error("call format");
      return { render: () => ["native call"] };
    },
    renderResult(result: { content?: Array<{ text?: string }> }) {
      counts.resultConstructs++;
      if (failures.result) throw new Error("result format");
      const text = result.content?.[0]?.text ?? "";
      counts.bodyCharsObserved += text.length;
      return { render: () => { counts.detailRenders++; return [text]; } };
    },
  } as unknown as ToolDefinition, { displayOperations }) as unknown as RenderTool;
  return { tool, counts };
}

function collapsed(
  tool: RenderTool,
  name: "read" | "bash",
  value: unknown,
  flags: { error?: boolean } = {},
): { call: Component; detail: Component } {
  const args = name === "read" ? { path: "large.txt" } : { command: "printf large", timeout: 1 };
  const state = {};
  const context = {
    args, state, isPartial: false, isError: flags.error ?? false, expanded: false,
    argsComplete: true, executionStarted: true, showImages: false, cwd: process.cwd(), invalidate() {},
  };
  return {
    call: tool.renderCall(args, theme, context),
    detail: tool.renderResult(value, { expanded: false, isPartial: false }, theme, context),
  };
}

describe("collapsed Read/Bash deterministic work bounds", () => {
  it("does not construct or render Read detail and gives Bash only an empty timer-settlement envelope", () => {
    const huge = "S".repeat(8_000_000);
    for (const name of ["read", "bash"] as const) {
      const { envelope, counts: access } = countedEnvelope(huge);
      const { tool, counts } = instrumented(name);
      const row = collapsed(tool, name, envelope);
      for (let repaint = 0; repaint < 25; repaint++) {
        row.call.render(40);
        row.detail.render(40);
      }
      expect(counts.detailRenders).toBe(0);
      expect(counts.bodyCharsObserved).toBe(0);
      expect(counts.resultConstructs).toBe(name === "bash" ? 1 : 0);
      expect(access.envelopeGets).toBeLessThan(20);
      expect(access.blockGets).toBeLessThan(20);
      if (name === "bash") expect(access.bodyGets).toBe(0);
      expect(access.ownKeys).toBe(1);
      expect(counts.sanitize).toBeLessThanOrEqual(name === "read" ? 1 : 0);
      expect(counts.split).toBe(0);
      expect(counts.slice).toBeLessThanOrEqual(name === "read" ? 2 : 0);
      expect(counts.maxSanitizeInput).toBeLessThanOrEqual(1_540);
      expect(counts.maxSliceSpan).toBeLessThanOrEqual(1_024);
    }
  });

  it("does not observe multi-megabyte exact truncated Bash bodies while collapsed or repainting", () => {
    const huge = "T".repeat(8_000_000);
    const { envelope, counts: access } = countedEnvelope(huge, { details: {
      truncation: {
        content: huge, truncated: true, truncatedBy: "bytes", totalLines: 9_000, totalBytes: 8_000_000,
        outputLines: 1, outputBytes: 50_000, lastLinePartial: true, firstLineExceedsLimit: false,
        maxLines: 2_000, maxBytes: 50_000,
      },
      fullOutputPath: "/private/full-output.txt",
    } });
    const { tool, counts } = instrumented("bash");
    const row = collapsed(tool, "bash", envelope);
    const rendered = [...row.call.render(80), ...row.detail.render(80)].join("\n");
    expect(rendered).toContain("output truncated");
    expect(rendered).toContain("ctrl+o to expand");
    expect(rendered).not.toContain("/private/full-output.txt");
    for (let repaint = 0; repaint < 25; repaint++) {
      row.call.render(80);
      row.detail.render(80);
    }
    expect(access.bodyGets).toBe(0);
    expect(counts.bodyCharsObserved).toBe(0);
    expect(counts.detailRenders).toBe(0);
    expect(counts.sanitize).toBe(0);
    expect(counts.split).toBe(0);
    expect(counts.slice).toBe(0);
  });

  it("keeps every exceptional family bounded across repeated repaints", () => {
    const body = "x".repeat(8_000_000);
    const cases = [
      { name: "read" as const, value: `${body}\n[Truncated: byte limit reached]`, extra: {}, error: false },
      { name: "read" as const, value: `${body}\n[PiCC clipped tool output]`, extra: {}, error: false },
      { name: "read" as const, value: `${body}\nCommand aborted`, extra: { isError: true }, error: true },
      { name: "read" as const, value: `${body}\ngeneric failure`, extra: { isError: true }, error: true },
      { name: "read" as const, value: `${body}\nfuture envelope`, extra: { future: true }, error: false },
      { name: "bash" as const, value: `${body}\nCommand timed out after 1 seconds`, extra: { isError: true }, error: true },
      { name: "bash" as const, value: `${body}\nCommand exited with code 9`, extra: { isError: true }, error: true },
    ];
    for (const entry of cases) {
      const { envelope, counts: access } = countedEnvelope(entry.value, entry.extra);
      const { tool, counts } = instrumented(entry.name);
      const row = collapsed(tool, entry.name, envelope, { error: entry.error });
      const operations = { sanitize: counts.sanitize, split: counts.split, slice: counts.slice };
      for (let repaint = 0; repaint < 20; repaint++) {
        for (const line of [...row.call.render(60), ...row.detail.render(60)]) expect(line.length).toBeLessThan(200);
      }
      expect({ sanitize: counts.sanitize, split: counts.split, slice: counts.slice }).toEqual(operations);
      expect(counts.sanitize).toBeLessThanOrEqual(6);
      expect(counts.split).toBeLessThanOrEqual(1);
      expect(counts.slice).toBeLessThanOrEqual(10);
      expect(counts.maxSanitizeInput).toBeLessThanOrEqual(1_540);
      expect(counts.maxSliceSpan).toBeLessThanOrEqual(1_024);
      expect(counts.bodyCharsObserved).toBe(0);
      expect(counts.detailRenders).toBe(0);
      expect(access.envelopeGets).toBeLessThan(24);
      expect(access.blockGets).toBeLessThan(24);
      expect(access.ownKeys).toBeLessThanOrEqual(1);
    }
  });

  it("keeps malformed argument paints bounded without probing retained bodies", () => {
    for (const name of ["read", "bash"] as const) {
      const { tool, counts } = instrumented(name);
      const state = {};
      const args = name === "read" ? { path: 42 } : { command: 42 };
      const context = { args, state, isPartial: false, isError: false, expanded: false,
        argsComplete: true, executionStarted: true, showImages: false, cwd: process.cwd(), invalidate() {} };
      const call = tool.renderCall(args, theme, context);
      const detail = tool.renderResult(countedEnvelope("x".repeat(8_000_000)).envelope,
        { expanded: false, isPartial: false }, theme, context);
      const operations = { sanitize: counts.sanitize, split: counts.split, slice: counts.slice };
      for (let repaint = 0; repaint < 20; repaint++) [...call.render(40), ...detail.render(40)];
      expect({ sanitize: counts.sanitize, split: counts.split, slice: counts.slice }).toEqual(operations);
      expect(counts.bodyCharsObserved).toBe(0);
      expect(counts.detailRenders).toBe(0);
    }
  });

  it("contains actually invoked call/result renderer throws without collapsed full-body operations", () => {
    const huge = "canonical ".repeat(800_000);
    for (const [name, failures] of [
      ["read", { call: true }],
      ["bash", { call: true }],
      ["bash", { result: true }],
    ] as const) {
      const { envelope } = countedEnvelope(huge);
      const { tool, counts } = instrumented(name, failures);
      const args = name === "read" ? { path: "large.txt" } : { command: "printf large", timeout: 1 };
      const state = {};
      const expandedContext = { args, state, isPartial: true, isError: false, expanded: true,
        argsComplete: true, executionStarted: false, showImages: false, cwd: process.cwd(), invalidate() {} };
      if (failures.call) expect(() => tool.renderCall(args, theme, expandedContext).render(80)).not.toThrow();
      const row = collapsed(tool, name, envelope);
      expect(() => row.call.render(80)).not.toThrow();
      expect(() => row.detail.render(80)).not.toThrow();
      if (name === "bash" && failures.call) {
        expect(row.call.render(80)).toEqual(["bash $ ..."]);
        expect(row.detail.render(80)).toEqual([]);
        expect(counts.callConstructs).toBe(2);
      }
      expect(counts.bodyCharsObserved).toBe(0);
      expect(counts.detailRenders).toBe(0);
      expect(counts.maxSanitizeInput).toBeLessThanOrEqual(1_540);
      expect(counts.maxSliceSpan).toBeLessThanOrEqual(1_024);
      const operations = { sanitize: counts.sanitize, split: counts.split, slice: counts.slice };
      for (let repaint = 0; repaint < 10; repaint++) row.detail.render(80);
      expect({ sanitize: counts.sanitize, split: counts.split, slice: counts.slice }).toEqual(operations);
    }
  });

  it("keeps malformed future envelopes bounded without body scans", () => {
    const { tool, counts } = instrumented("read");
    const row = collapsed(tool, "read", { content: [{ type: "future", payload: "x".repeat(8_000_000) }], details: undefined });
    expect(row.call.render(80).join("\n")).toContain("unfamiliar result");
    expect(row.detail.render(80)).toEqual([]);
    expect({ sanitize: counts.sanitize, split: counts.split, slice: counts.slice })
      .toEqual({ sanitize: 0, split: 0, slice: 0 });
  });

  it("pays retained-detail work only after expansion", () => {
    const huge = "expanded-body".repeat(60_000);
    const { envelope } = countedEnvelope(huge);
    const { tool, counts } = instrumented("read");
    const args = { path: "expanded.txt" };
    const state = {};
    const collapsedContext = { args, state, isPartial: false, isError: false, expanded: false,
      argsComplete: true, executionStarted: true, showImages: false, cwd: process.cwd(), invalidate() {} };
    tool.renderCall(args, theme, collapsedContext).render(80);
    tool.renderResult(envelope, { expanded: false, isPartial: false }, theme, collapsedContext).render(80);
    expect(counts.bodyCharsObserved).toBe(0);
    const expandedContext = { ...collapsedContext, expanded: true };
    tool.renderCall(args, theme, expandedContext).render(80);
    tool.renderResult(envelope, { expanded: true, isPartial: false }, theme, expandedContext).render(80);
    expect(counts.bodyCharsObserved).toBe(huge.length);
    expect(counts.detailRenders).toBe(1);
    expect(counts.sanitize).toBeGreaterThan(0);
    expect(counts.maxSanitizeInput).toBe(huge.length);
  });
});

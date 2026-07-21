import { describe, expect, it } from "vitest";
import {
  assistantTextFingerprint,
  DEFAULT_MAX_LINE_LENGTH,
  DEFAULT_MAX_TAIL_LINES,
  DETAIL_FIELD_MAX_LENGTH,
  DETAIL_LOG_MAX_ENTRIES,
  formatUsageCompact,
  renderProgressText,
  sanitizeDetailScalar,
  sanitizeLine,
  sanitizeProgressText,
  SubagentProgressCondenser,
  type ProgressSnapshot,
} from "../src/runtime/subagent-progress.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Build an assistant-message-shaped object the condenser can read text from. */
function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function detailAssistant(rawText: string) {
  return {
    kind: "assistant" as const,
    text: sanitizeDetailScalar(rawText),
    fingerprint: assistantTextFingerprint([rawText]),
  };
}

describe("sanitizeProgressText (terminal-injection defense)", () => {
  it("strips CSI color/cursor sequences", () => {
    const hostile = `${ESC}[31mred${ESC}[0m${ESC}[2J`;
    const clean = sanitizeProgressText(hostile);
    expect(clean).toBe("red");
    expect(clean.includes(ESC)).toBe(false);
  });

  it("strips OSC (window-title) sequences terminated by BEL or ST", () => {
    const bel = `${ESC}]0;pwned${BEL}after`;
    const st = `${ESC}]0;pwned${ESC}\\after`;
    expect(sanitizeProgressText(bel)).toBe("after");
    expect(sanitizeProgressText(st)).toBe("after");
  });

  it("removes stray C0/C1/DEL control characters but keeps newlines/tabs", () => {
    const raw = `a${String.fromCharCode(0)}b${String.fromCharCode(7)}c${String.fromCharCode(
      127,
    )}d${String.fromCharCode(155)}\n\tkeep`;
    const clean = sanitizeProgressText(raw);
    expect(clean).toBe("abcd\n\tkeep");
    // No control chars survive except tab/newline.
    for (const ch of clean) {
      const n = ch.charCodeAt(0);
      const ctl = (n < 32 && n !== 9 && n !== 10 && n !== 13) || n === 127 || (n >= 128 && n <= 159);
      expect(ctl).toBe(false);
    }
  });

  it("keeps a lone CR (line-splitting/per-line trim strips it, not this function)", () => {
    // FIX-B pin: sanitizeProgressText preserves \r (code 13) so callers can split
    // into lines first; the per-line sanitizer (sanitizeLine) collapses the \r.
    expect(sanitizeProgressText("x\ry")).toBe("x\ry");
  });

  it("strips single-char Fe escapes (ESC + final byte)", () => {
    // ESC D (Index) is a two-byte Fe escape — both bytes go, the payload stays.
    expect(sanitizeProgressText(`a${ESC}Db`)).toBe("ab");
  });
});

describe("sanitizeDetailScalar (bounded malformed-input inspection)", () => {
  it("does not scan through huge non-rendering prefixes to a sentinel", () => {
    const sentinel = "RAW_INSPECTION_SENTINEL";
    const values = [
      `${" ".repeat(100_000)}${sentinel}`,
      `${String.fromCharCode(1).repeat(100_000)}${sentinel}`,
      `${ESC}]${"x".repeat(100_000)}${sentinel}`,
    ];
    for (const value of values) expect(sanitizeDetailScalar(value)).not.toContain(sentinel);
  });
});

describe("sanitizeLine (the capture-site single-line sanitizer)", () => {
  // The exact sanitizer applied at capture to model-controlled identity strings
  // (task_id echoes, subagent_type labels, descriptions, agent names).
  it("flattens hostile multi-line/control input to one clean line", () => {
    const c1Csi = String.fromCharCode(155); // single-byte C1 CSI
    const hostile = `a${ESC}]0;title${BEL}b\r\nc\td${c1Csi}`;
    expect(sanitizeLine(hostile, 80)).toBe("ab c d");
  });

  it("strips OSC, CSI, and Fe escape families wholesale", () => {
    const hostile = `x${ESC}]0;pwn${BEL}${ESC}[31m${ESC}Dy`;
    const clean = sanitizeLine(hostile, 80);
    expect(clean).toBe("xy");
    expect(clean.includes(ESC)).toBe(false);
    expect(clean.includes(BEL)).toBe(false);
  });

  it("caps to the requested length with a visible ellipsis", () => {
    const out = sanitizeLine("x".repeat(100), 10);
    expect(out.length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("preserves the legacy UTF-16 truncation boundary", () => {
    const out = sanitizeLine(`${"x".repeat(298)}😀tail`, DETAIL_FIELD_MAX_LENGTH);
    expect(out).toBe(`${"x".repeat(298)}\ud83d…`);
    expect(out).toHaveLength(DETAIL_FIELD_MAX_LENGTH);
  });
});

describe("SubagentProgressCondenser", () => {
  it("names the current tool on tool_execution_start and clears on end", () => {
    const c = new SubagentProgressCondenser();
    expect(c.consume({ type: "tool_execution_start", toolName: "Grep", args: { pattern: "x" } })).toBe(
      true,
    );
    let snap = c.snapshot();
    expect(snap.activity).toBe("running Grep…");
    expect(snap.tail.some((l) => l.includes("Grep") && l.includes("x"))).toBe(true);
    c.consume({ type: "tool_execution_end", toolName: "Grep", result: "irrelevant", isError: false });
    snap = c.snapshot();
    expect(snap.activity).toBe("working…");
  });

  it("makes silent auto-retry waits visible", () => {
    const c = new SubagentProgressCondenser();
    expect(
      c.consume({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 2000, errorMessage: "429" }),
    ).toBe(true);
    expect(c.snapshot().activity).toBe("waiting: API retry 2/3");
    expect(c.snapshot().tail.some((l) => l.includes("API retry 2/3"))).toBe(true);
    c.consume({ type: "auto_retry_end", success: true, attempt: 2 });
    expect(c.snapshot().activity).toBe("retry succeeded; resuming…");
  });

  it("covers the retry-failed and attempt-less retry branches (FIX-B)", () => {
    const c = new SubagentProgressCondenser();
    // Fallback wording when the event carries no attempt/maxAttempts.
    expect(c.consume({ type: "auto_retry_start" })).toBe(true);
    expect(c.snapshot().activity).toBe("waiting: API retry");
    expect(c.snapshot().tail.some((l) => l.includes("waiting: API retry"))).toBe(true);
    // A failed retry (success:false) is surfaced distinctly.
    c.consume({ type: "auto_retry_end", success: false, attempt: 3 });
    expect(c.snapshot().activity).toBe("retry failed");
  });

  it("sanitizes an ANSI/OSC escape in the current-tool activity line (SEC-1)", () => {
    const c = new SubagentProgressCondenser();
    const hostileName = `${ESC}[31mGrep${ESC}]0;pwned${BEL}`;
    c.consume({ type: "tool_execution_start", toolName: hostileName, args: {} });
    const snap = c.snapshot();
    expect(snap.activity).toBe("running Grep…");
    expect(snap.activity.includes(ESC)).toBe(false);
    expect(snap.activity.includes(BEL)).toBe(false);
  });

  it("sanitizes ANSI/control out of tool-result previews (injection defense)", () => {
    const c = new SubagentProgressCondenser();
    const hostile = `${ESC}[31mFROM hostile file${ESC}[0m${BEL}`;
    c.consume({
      type: "tool_execution_end",
      toolName: "Read",
      result: { content: [{ type: "text", text: hostile }] },
      isError: false,
    });
    const line = c.snapshot().tail.find((l) => l.includes("Read:"));
    expect(line).toBeDefined();
    expect(line!.includes(ESC)).toBe(false);
    expect(line!.includes(BEL)).toBe(false);
    expect(line).toContain("FROM hostile file");
  });

  it("folds assistant output lines into the tail on turn_end", () => {
    const c = new SubagentProgressCondenser();
    c.consume({ type: "turn_end", message: assistant("line one\nline two") });
    const snap = c.snapshot();
    expect(snap.tail).toContain("line one");
    expect(snap.tail).toContain("line two");
  });

  it("clears the streaming preview on turn_end so the final line isn't shown twice (FIX-A)", () => {
    const c = new SubagentProgressCondenser();
    c.consume({ type: "message_update", message: assistant("the final line") });
    expect(c.snapshot().activity).toBe("the final line");
    c.consume({ type: "turn_end", message: assistant("the final line") });
    const snap = c.snapshot();
    // The line lives in the tail; the activity footer no longer duplicates it.
    expect(snap.tail).toContain("the final line");
    expect(snap.activity).toBe("working…");
    expect(snap.activity).not.toBe("the final line");
  });

  it("strips CR from CRLF assistant output on turn_end (FIX-B)", () => {
    const c = new SubagentProgressCondenser();
    c.consume({ type: "turn_end", message: assistant("a\r\nb") });
    expect(c.snapshot().tail).toEqual(["a", "b"]);
  });

  it("reduces a huge tool result to a single tail line (flood defense, FIX-B)", () => {
    const c = new SubagentProgressCondenser();
    const before = c.snapshot().tail.length;
    const flood = Array.from({ length: 1000 }, (_, i) => `result line ${i}`).join("\n");
    c.consume({ type: "tool_execution_end", toolName: "Read", result: flood, isError: false });
    expect(c.snapshot().tail.length).toBe(before + 1);
  });

  it("keeps the tail bounded to the configured length", () => {
    const c = new SubagentProgressCondenser(3);
    for (let i = 0; i < 10; i++) {
      c.consume({ type: "tool_execution_start", toolName: `T${i}`, args: {} });
    }
    const snap = c.snapshot();
    expect(snap.tail.length).toBe(3);
    // Only the most recent survive.
    expect(snap.tail.some((l) => l.includes("T9"))).toBe(true);
    expect(snap.tail.some((l) => l.includes("T0"))).toBe(false);
  });

  it("truncates over-long lines", () => {
    const c = new SubagentProgressCondenser(DEFAULT_MAX_TAIL_LINES, 20);
    c.consume({ type: "turn_end", message: assistant("x".repeat(500)) });
    const line = c.snapshot().tail[0]!;
    expect(line.length).toBeLessThanOrEqual(20);
    expect(line.endsWith("…")).toBe(true);
  });

  it("message_update updates the activity preview without growing the tail", () => {
    const c = new SubagentProgressCondenser();
    c.consume({ type: "message_update", message: assistant("partial draft") });
    const snap = c.snapshot();
    expect(snap.activity).toBe("partial draft");
    expect(snap.tail.length).toBe(0);
  });

  it("dedupes: consuming an unknown or no-op event reports no change", () => {
    const c = new SubagentProgressCondenser();
    expect(c.consume({ type: "totally_unknown" })).toBe(false);
    expect(c.consume({ type: "message_update", message: assistant("") })).toBe(false);
  });

  it("renderProgressText lays out tail then the activity line", () => {
    const snap: ProgressSnapshot = { tail: ["a", "b"], activity: "running Read…" };
    expect(renderProgressText(snap)).toBe("a\nb\n… running Read…");
    expect(renderProgressText({ tail: [], activity: "" })).toBe("");
  });
});

/** A Pi-shaped `AssistantMessage.usage` (all fields required, zero-filled by default). */
function piUsage(
  over: Partial<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
  }> = {},
) {
  return {
    input: over.input ?? 0,
    output: over.output ?? 0,
    cacheRead: over.cacheRead ?? 0,
    cacheWrite: over.cacheWrite ?? 0,
    totalTokens: over.totalTokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: over.cost ?? 0 },
  };
}

/** An assistant message carrying Pi-shaped usage. */
function assistantWithUsage(text: string, usage: ReturnType<typeof piUsage>) {
  return { role: "assistant", content: [{ type: "text", text }], usage };
}

describe("SubagentProgressCondenser usage accumulation", () => {
  it("stays absent through zero-filled mid-stream events (never a fake 0 display)", () => {
    const c = new SubagentProgressCondenser();
    c.consume({ type: "message_update", message: assistantWithUsage("draft", piUsage()) });
    expect(c.snapshot().usage).toBeUndefined();
    c.consume({ type: "turn_end", message: assistantWithUsage("draft", piUsage()) });
    expect(c.snapshot().usage).toBeUndefined();
  });

  it("sums each turn's own usage at turn_end, keeping honest measured zeros", () => {
    const c = new SubagentProgressCondenser();
    c.consume({
      type: "turn_end",
      message: assistantWithUsage("one", piUsage({ input: 10, output: 5, totalTokens: 15, cost: 0.25 })),
    });
    expect(c.snapshot().usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.25,
    });
    c.consume({
      type: "turn_end",
      message: assistantWithUsage("two", piUsage({ input: 4, output: 2, cacheRead: 8, totalTokens: 14, cost: 0.5 })),
    });
    expect(c.snapshot().usage).toEqual({
      inputTokens: 14,
      outputTokens: 7,
      cacheReadTokens: 8,
      cacheWriteTokens: 0,
      costUsd: 0.75,
    });
  });

  it("streamed usage REPLACES the in-flight figure and is not double-counted at turn_end", () => {
    const c = new SubagentProgressCondenser();
    c.consume({
      type: "message_update",
      message: assistantWithUsage("d", piUsage({ input: 3, output: 1, totalTokens: 4 })),
    });
    expect(c.snapshot().usage?.outputTokens).toBe(1);
    // The streamed figure is cumulative within the message: replace, never sum.
    c.consume({
      type: "message_update",
      message: assistantWithUsage("dr", piUsage({ input: 3, output: 6, totalTokens: 9 })),
    });
    const expected = {
      inputTokens: 3,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    expect(c.snapshot().usage).toEqual(expected);
    // turn_end folds the SAME message's final figure — no double count.
    c.consume({
      type: "turn_end",
      message: assistantWithUsage("dr", piUsage({ input: 3, output: 6, totalTokens: 9 })),
    });
    expect(c.snapshot().usage).toEqual(expected);
  });

  it("turn_end without usage falls back to the last streamed figure, exactly once", () => {
    const c = new SubagentProgressCondenser();
    c.consume({
      type: "message_update",
      message: assistantWithUsage("d", piUsage({ input: 2, output: 2, totalTokens: 4 })),
    });
    c.consume({ type: "turn_end", message: assistant("d") }); // final event lacks usage
    const expected = {
      inputTokens: 2,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
    expect(c.snapshot().usage).toEqual(expected);
    // A later usage-less turn re-counts nothing.
    c.consume({ type: "turn_end", message: assistant("e") });
    expect(c.snapshot().usage).toEqual(expected);
  });

  it("a usage tick alone is a visible change, so live counts reach subscribers", () => {
    const c = new SubagentProgressCondenser();
    // Empty text: tail and activity are untouched — only usage changed.
    expect(
      c.consume({
        type: "message_update",
        message: assistantWithUsage("", piUsage({ input: 1, totalTokens: 1 })),
      }),
    ).toBe(true);
    expect(c.snapshot().usage?.inputTokens).toBe(1);
  });

  it("formatUsageCompact reads the snapshot usage unchanged (one shape, not two)", () => {
    const c = new SubagentProgressCondenser();
    c.consume({
      type: "turn_end",
      message: assistantWithUsage("x", piUsage({ input: 10, output: 5, totalTokens: 15, cost: 0.25 })),
    });
    expect(formatUsageCompact(c.snapshot().usage)).toBe(
      "in 10 · out 5 · cache read 0 · cache write 0 · $0.25",
    );
  });
});

describe("SubagentProgressCondenser structured detail log", () => {
  it("captures every typed entry in event order, including an empty successful outcome", () => {
    const c = new SubagentProgressCondenser();
    c.consume({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
    c.consume({ type: "auto_retry_end", success: true });
    c.consume({ type: "tool_execution_start", toolName: "Read", args: { file_path: "a.ts" } });
    c.consume({ type: "tool_execution_end", toolName: "Read", result: "", isError: false });
    c.consume({ type: "turn_end", message: assistant("settled answer") });
    expect(c.detailLog()).toEqual([
      { kind: "status", text: "waiting: API retry 1/3" },
      { kind: "status", text: "retry succeeded; resuming…" },
      { kind: "tool-call", tool: "Read", detail: "a.ts" },
      { kind: "tool-outcome", tool: "Read", failed: false },
      detailAssistant("settled answer"),
    ]);
  });

  it("captures exact failed retry and sanitized failed-tool details", () => {
    const hostile = `${ESC}[31mBash${ESC}[0m\nignored`;
    const c = new SubagentProgressCondenser();
    c.consume({ type: "auto_retry_end", success: false });
    c.consume({
      type: "tool_execution_end",
      toolName: hostile,
      result: { content: [{ type: "text", text: `\n${ESC}]0;pwn${BEL}bad\tresult\nignored` }] },
      isError: true,
    });
    expect(c.detailLog()).toEqual([
      { kind: "status", text: "retry failed" },
      { kind: "tool-outcome", tool: "Bash ignored", detail: "bad result", failed: true },
    ]);
  });

  it("caps tool-call names independently when snapshot lines allow more than 300 units", () => {
    const c = new SubagentProgressCondenser(DEFAULT_MAX_TAIL_LINES, 1_000);
    c.consume({ type: "tool_execution_start", toolName: "T".repeat(900), args: {} });
    const entry = c.detailLog()[0];
    expect(entry).toEqual({ kind: "tool-call", tool: `${"T".repeat(299)}…` });
    expect((entry as { tool: string }).tool).toHaveLength(DETAIL_FIELD_MAX_LENGTH);
    expect(c.snapshot().activity.length).toBeGreaterThan(DETAIL_FIELD_MAX_LENGTH);
  });

  it("bounds huge command detail and keeps its ellipsis code-point safe", () => {
    const c = new SubagentProgressCondenser(DEFAULT_MAX_TAIL_LINES, 1_000);
    c.consume({
      type: "tool_execution_start",
      toolName: "Bash",
      args: { command: `${"x".repeat(298)}😀${"y".repeat(1_000_000)}` },
    });
    expect(c.detailLog()).toEqual([
      { kind: "tool-call", tool: "Bash", detail: `${"x".repeat(298)}…` },
    ]);
    expect((c.detailLog()[0] as { detail: string }).detail).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("stops a complete short tool-result preview before inspecting a poison block", () => {
    const poison = Object.defineProperty({}, "type", {
      get(): never {
        throw new Error("late result block was touched");
      },
    });
    const c = new SubagentProgressCondenser();
    expect(() =>
      c.consume({
        type: "tool_execution_end",
        toolName: "Read",
        result: { content: [{ type: "text", text: "safe" }, poison] },
        isError: false,
      }),
    ).not.toThrow();
    expect(c.snapshot().tail).toEqual(["Read: safe"]);
    expect(c.detailLog()).toEqual([
      { kind: "tool-outcome", tool: "Read", detail: "safe", failed: false },
    ]);
  });

  it("consumes a C1 CSI introducer in structured fields", () => {
    const csi = String.fromCharCode(155);
    const c = new SubagentProgressCondenser();
    c.consume({ type: "tool_execution_end", toolName: "Read", result: `a${csi}31mRED`, isError: false });
    expect(c.detailLog()).toEqual([
      { kind: "tool-outcome", tool: "Read", detail: "aRED", failed: false },
    ]);
    expect(c.snapshot().tail).toEqual(["Read: a31mRED"]);
  });

  it("retains raw-line found semantics when sanitization removes the whole line", () => {
    const ansiOnly = `${ESC}[31m${ESC}[0m`;
    const tool = new SubagentProgressCondenser();
    tool.consume({ type: "tool_execution_end", toolName: "Read", result: ansiOnly, isError: false });
    expect(tool.snapshot().tail).toEqual(["Read:"]);
    expect(tool.detailLog()).toEqual([{ kind: "tool-outcome", tool: "Read", failed: false }]);

    const assistantActivity = new SubagentProgressCondenser();
    assistantActivity.consume({ type: "turn_start" });
    assistantActivity.consume({ type: "message_update", message: assistant(ansiOnly) });
    expect(assistantActivity.snapshot().activity).toBe("");
  });

  it("ignores streaming and tool-update floods while recording settled assistant text once", () => {
    const c = new SubagentProgressCondenser();
    for (let i = 0; i < 1_000; i++) {
      c.consume({ type: "message_update", message: assistant(`draft ${i}`) });
      c.consume({ type: "tool_execution_update", toolName: "Read", partialResult: `chunk ${i}` });
    }
    expect(c.detailLog()).toEqual([]);
    c.consume({ type: "turn_end", message: assistant("final") });
    expect(c.detailLog()).toEqual([detailAssistant("final")]);
  });

  it("keeps the newest fixed number of entries and deep-copies every returned object", () => {
    const c = new SubagentProgressCondenser();
    for (let i = 0; i < DETAIL_LOG_MAX_ENTRIES + 10; i++) {
      c.consume({ type: "tool_execution_end", toolName: `T${i}`, result: "", isError: false });
    }
    const first = c.detailLog();
    expect(first).toHaveLength(DETAIL_LOG_MAX_ENTRIES);
    expect(first[0]).toMatchObject({ kind: "tool-outcome", tool: "T10" });
    (first[0] as { tool: string }).tool = "mutated";
    first.push({ kind: "status", text: "caller mutation" });
    expect(c.detailLog()[0]).toMatchObject({ tool: "T10" });
    expect(c.detailLog()).toHaveLength(DETAIL_LOG_MAX_ENTRIES);
  });

  it("sanitizes every scalar to one bounded physical line", () => {
    const controls = `${String.fromCharCode(0)}${String.fromCharCode(155)}`;
    const hostile = `${ESC}]0;pwn${BEL}${ESC}[31mred${ESC}[0m\r\n\tblue${controls}`;
    const c = new SubagentProgressCondenser();
    c.consume({ type: "tool_execution_start", toolName: hostile, args: { command: hostile } });
    c.consume({ type: "tool_execution_end", toolName: hostile, result: hostile, isError: true });
    c.consume({ type: "turn_end", message: assistant(hostile) });
    for (const entry of c.detailLog()) {
      for (const value of Object.values(entry)) {
        if (typeof value !== "string") continue;
        expect(value.length).toBeLessThanOrEqual(DETAIL_FIELD_MAX_LENGTH);
        expect(value).not.toMatch(/[\r\n\t]/u);
        expect(value).not.toContain(ESC);
        expect(value).not.toContain(BEL);
      }
    }
    expect(c.detailLog().at(-1)).toEqual(detailAssistant(hostile));
  });

  it("fingerprints full multiline and long assistant turns without storing their uncapped content", () => {
    const parts = ["first line\n", "x".repeat(500)];
    const c = new SubagentProgressCondenser();
    c.consume({
      type: "turn_end",
      message: {
        role: "assistant",
        content: parts.map((text) => ({ type: "text", text })),
      },
    });
    const entry = c.detailLog()[0];
    expect(entry).toEqual({
      kind: "assistant",
      text: sanitizeDetailScalar(parts.join("")),
      fingerprint: assistantTextFingerprint(parts),
    });
    expect((entry as { text: string }).text).not.toContain("x".repeat(400));
    expect((entry as { fingerprint: string }).fingerprint).toHaveLength(64);
  });

  it("bounds huge strings and block counts before they enter the detail log", () => {
    const hugeBlocks = Array.from({ length: 20_000 }, () => ({ type: "text", text: "block " }));
    const c = new SubagentProgressCondenser();
    c.consume({
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1_000_000) }, ...hugeBlocks] },
    });
    c.consume({
      type: "tool_execution_end",
      toolName: "Read",
      result: { content: hugeBlocks },
      isError: false,
    });
    const detail = c.detailLog();
    expect((detail[0] as { text: string }).text).toHaveLength(DETAIL_FIELD_MAX_LENGTH);
    expect((detail[1] as { detail: string }).detail.length).toBeLessThanOrEqual(DETAIL_FIELD_MAX_LENGTH);
  });

  it("preserves legacy incomplete-CSI and astral truncation while structured fields stay safe", () => {
    const incomplete = `${"i".repeat(10)}${ESC}[31`;
    const astral = `${"x".repeat(298)}😀tail`;
    const c = new SubagentProgressCondenser(DEFAULT_MAX_TAIL_LINES, DETAIL_FIELD_MAX_LENGTH);
    c.consume({ type: "turn_end", message: assistant(incomplete) });
    c.consume({ type: "turn_end", message: assistant(astral) });
    expect(c.snapshot().tail).toEqual([
      `${"i".repeat(10)}[31`,
      `${"x".repeat(298)}\ud83d…`,
    ]);
    expect(c.detailLog()).toEqual([
      detailAssistant(incomplete),
      detailAssistant(astral),
    ]);
    expect((c.detailLog()[1] as { text: string }).text).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("preserves assistant block concatenation and newest-tail semantics with bounded huge lines", () => {
    const c = new SubagentProgressCondenser(4, 20);
    c.consume({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "first\nsec" },
          { type: "text", text: "ond\n" },
          { type: "text", text: "q".repeat(1_000_000) },
          { type: "text", text: "\nnewest" },
        ],
      },
    });
    expect(c.snapshot().tail).toEqual(["first", "second", `${"q".repeat(19)}…`, "newest"]);
  });

  it("reports detail-only changes separately without changing snapshots or rendered progress", () => {
    const c = new SubagentProgressCondenser();
    c.consume({ type: "tool_execution_end", toolName: "Read", result: "", isError: false });
    const before = c.snapshot();
    const rendered = renderProgressText(before);
    expect(c.consume({ type: "tool_execution_end", toolName: "Write", result: "", isError: false })).toBe(false);
    expect(c.detailChanged()).toBe(true);
    expect(c.snapshot()).toEqual(before);
    expect(renderProgressText(c.snapshot())).toBe(rendered);
    expect(c.consume({ type: "tool_execution_update", partialResult: "ignored" })).toBe(false);
    expect(c.detailChanged()).toBe(false);
  });
});

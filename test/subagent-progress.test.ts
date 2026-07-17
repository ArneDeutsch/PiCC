import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TAIL_LINES,
  renderProgressText,
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

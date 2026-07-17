import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  LINGER_FAILURE_MS,
  LINGER_SUCCESS_MS,
  MAX_PANEL_ROWS,
  newestTaskByAgent,
  selectionKeyId,
  selectionKeysEqual,
  SubagentPanelModel,
  type PanelComputeInput,
  type PanelTaskInfo,
  type PanelViewModel,
} from "../src/runtime/subagent-panel-model.js";
import {
  AGENT_COLOR_ANSI,
  formatElapsed,
  PANEL_GLYPH_FAILED,
  PANEL_GLYPH_STOPPED,
  PANEL_GLYPH_SUCCESS,
  PANEL_HINT_FOCUSED,
  PANEL_NARROW_WIDTH,
  PANEL_RUNNING_FRAMES,
  panelHintUnfocused,
  panelMoreAbove,
  panelMoreBelow,
  renderSubagentPanel,
  tintAgentColor,
} from "../src/runtime/subagent-panel-render.js";
import type { SubagentRegistryRecord } from "../src/runtime/subagent-registry.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CHORD = "alt+a";

/** Minimal registry record with the panel-relevant fields overridable. */
function rec(
  over: Partial<SubagentRegistryRecord> & { agentId: string },
): SubagentRegistryRecord {
  return {
    agentName: "coder",
    depth: 1,
    cwd: "/repo",
    resumable: true,
    oneShot: false,
    state: "running",
    settledNoticeConsumed: false,
    startedAt: 0,
    ...over,
  };
}

function makeModel(clock: { t: number }, maxVisibleRows?: number): SubagentPanelModel {
  return new SubagentPanelModel({ now: () => clock.t, maxVisibleRows });
}

function view(
  model: SubagentPanelModel,
  records: SubagentRegistryRecord[],
  extra?: Partial<PanelComputeInput>,
): PanelViewModel {
  return model.view({ records, focused: false, ...extra });
}

describe("selection keys", () => {
  it("discriminates task vs agent keys and compares by content", () => {
    expect(selectionKeyId({ kind: "task", taskId: "task-3" })).toBe("task:task-3");
    expect(selectionKeyId({ kind: "agent", agentId: "agent-abc" })).toBe("agent:agent-abc");
    expect(
      selectionKeysEqual({ kind: "task", taskId: "task-3" }, { kind: "task", taskId: "task-3" }),
    ).toBe(true);
    expect(
      selectionKeysEqual({ kind: "task", taskId: "task-3" }, { kind: "agent", agentId: "task-3" }),
    ).toBe(false);
    expect(selectionKeysEqual(undefined, { kind: "task", taskId: "t" })).toBe(false);
  });
});

describe("task join (newest generation wins)", () => {
  it("keeps the LAST task per agent id — a resume's newer generation wins", () => {
    const tasks: PanelTaskInfo[] = [
      { id: "task-1", status: "completed", agentId: "agent-a" },
      { id: "task-2", status: "running", agentId: "agent-a" },
      { id: "task-3", status: "running", agentId: "agent-b" },
    ];
    const byAgent = newestTaskByAgent(tasks);
    expect(byAgent.get("agent-a")?.id).toBe("task-2");
    expect(byAgent.get("agent-b")?.id).toBe("task-3");
  });

  it("gives a tasked agent a task key and a task-less agent an agent key", () => {
    const clock = { t: 1000 };
    const model = makeModel(clock);
    const v = view(model, [rec({ agentId: "agent-a" }), rec({ agentId: "agent-b" })], {
      tasks: [{ id: "task-9", status: "running", agentId: "agent-b" }],
    });
    const keys = new Map(v.rows.map((r) => [r.agentId, r.keyId]));
    expect(keys.get("agent-a")).toBe("agent:agent-a");
    expect(keys.get("agent-b")).toBe("task:task-9");
    expect(v.rows.find((r) => r.agentId === "agent-b")?.taskId).toBe("task-9");
  });
});

describe("tree flattening", () => {
  it("nests children under their parent, always expanded, ordered by startedAt", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    const v = view(model, [
      rec({ agentId: "agent-p", startedAt: 0 }),
      rec({ agentId: "agent-c2", parentAgentId: "agent-p", startedAt: 20 }),
      rec({ agentId: "agent-c1", parentAgentId: "agent-p", startedAt: 10 }),
    ]);
    expect(v.rows.map((r) => [r.agentId, r.treeDepth])).toEqual([
      ["agent-p", 0],
      ["agent-c1", 1],
      ["agent-c2", 1],
    ]);
  });

  it("orders running before settled within a sibling group (stable by startedAt)", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    const v = view(model, [
      rec({ agentId: "agent-a", startedAt: 0, state: "settled", outcome: "completed", settledAt: 50 }),
      rec({ agentId: "agent-b", startedAt: 10 }),
      rec({ agentId: "agent-c", startedAt: 5 }),
    ]);
    expect(v.rows.map((r) => r.agentId)).toEqual(["agent-c", "agent-b", "agent-a"]);
  });

  it("re-roots a child whose parent expired (nearest visible ancestor)", () => {
    const clock = { t: 0 };
    const model = makeModel(clock);
    const records = [
      rec({ agentId: "agent-p", state: "settled", outcome: "completed", settledAt: 0 }),
      rec({ agentId: "agent-c", parentAgentId: "agent-p", startedAt: 1 }),
    ];
    clock.t = LINGER_SUCCESS_MS + 1;
    const v = view(model, records);
    expect(v.rows.map((r) => [r.agentId, r.treeDepth])).toEqual([["agent-c", 0]]);
  });

  it("reparents to the nearest visible ANCESTOR, not always the root: grandparent visible, parent expired", () => {
    const clock = { t: 0 };
    const model = makeModel(clock);
    const records = [
      rec({ agentId: "agent-g", startedAt: 0 }),
      rec({
        agentId: "agent-p",
        parentAgentId: "agent-g",
        startedAt: 1,
        state: "settled",
        outcome: "completed",
        settledAt: 0,
      }),
      rec({ agentId: "agent-c", parentAgentId: "agent-p", startedAt: 2 }),
    ];
    clock.t = LINGER_SUCCESS_MS + 1;
    const v = view(model, records);
    expect(v.rows.map((r) => [r.agentId, r.treeDepth])).toEqual([
      ["agent-g", 0],
      ["agent-c", 1],
    ]);
  });

  it("handles arbitrary depth (deep chain keeps incrementing treeDepth)", () => {
    const clock = { t: 100 };
    const model = makeModel(clock, 20);
    const records: SubagentRegistryRecord[] = [rec({ agentId: "agent-0", startedAt: 0 })];
    for (let i = 1; i < 8; i++) {
      records.push(
        rec({ agentId: `agent-${i}`, parentAgentId: `agent-${i - 1}`, startedAt: i }),
      );
    }
    const v = view(model, records);
    expect(v.rows.map((r) => r.treeDepth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("degrades a parent cycle to roots instead of hanging or dropping rows", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    const v = view(model, [
      rec({ agentId: "agent-x", parentAgentId: "agent-y", startedAt: 0 }),
      rec({ agentId: "agent-y", parentAgentId: "agent-x", startedAt: 1 }),
    ]);
    expect(v.rows).toHaveLength(2);
    for (const row of v.rows) expect(row.treeDepth).toBe(0);
  });
});

describe("two-tier linger", () => {
  const settledSuccess = () =>
    rec({ agentId: "agent-s", state: "settled", outcome: "completed", settledAt: 1000 });
  const settledFailed = () =>
    rec({ agentId: "agent-f", state: "settled", outcome: "failed", settledAt: 1000 });

  it("keeps a success row until settledAt + LINGER_SUCCESS_MS, then removes it", () => {
    const clock = { t: 1000 + LINGER_SUCCESS_MS - 1 };
    const model = makeModel(clock);
    expect(view(model, [settledSuccess()]).rows).toHaveLength(1);
    clock.t = 1000 + LINGER_SUCCESS_MS;
    expect(view(model, [settledSuccess()]).empty).toBe(true);
  });

  it("keeps failed and user-stopped rows for LINGER_FAILURE_MS", () => {
    const stopped = rec({
      agentId: "agent-x",
      state: "settled",
      outcome: "aborted",
      userStopped: true,
      settledAt: 1000,
    });
    const clock = { t: 1000 + LINGER_FAILURE_MS - 1 };
    const model = makeModel(clock);
    expect(view(model, [settledFailed(), stopped]).rows).toHaveLength(2);
    clock.t = 1000 + LINGER_FAILURE_MS;
    expect(view(model, [settledFailed(), stopped]).empty).toBe(true);
  });

  it("freezes ALL removals while focused; expiry applies on unfocus", () => {
    const clock = { t: 1000 + LINGER_FAILURE_MS + 5000 };
    const model = makeModel(clock);
    expect(view(model, [settledSuccess(), settledFailed()], { focused: true }).rows).toHaveLength(2);
    expect(view(model, [settledSuccess(), settledFailed()]).empty).toBe(true);
  });

  it("always excludes dismissed settled rows (even focused) but never running ones", () => {
    const clock = { t: 1001 };
    const model = makeModel(clock);
    const running = rec({ agentId: "agent-r" });
    const dismissed = new Set(["agent:agent-s", "agent:agent-r"]);
    const v = view(model, [settledSuccess(), running], { focused: true, dismissed });
    expect(v.rows.map((r) => r.agentId)).toEqual(["agent-r"]);
  });
});

describe("row state classification", () => {
  it("maps outcome/userStopped/task status to the four display states", () => {
    const clock = { t: 1001 };
    const model = makeModel(clock);
    const v = view(
      model,
      [
        rec({ agentId: "agent-run" }),
        rec({ agentId: "agent-ok", state: "settled", outcome: "completed", settledAt: 1000 }),
        rec({ agentId: "agent-bad", state: "settled", outcome: "failed", settledAt: 1000 }),
        rec({ agentId: "agent-ab", state: "settled", outcome: "aborted", settledAt: 1000 }),
        rec({ agentId: "agent-us", state: "settled", outcome: "completed", userStopped: true, settledAt: 1000 }),
        rec({ agentId: "agent-uk", state: "settled", settledAt: 1000 }),
      ],
      { tasks: [{ id: "task-1", status: "stopped", agentId: "agent-uk" }] },
    );
    const states = new Map(v.rows.map((r) => [r.agentId, r.state]));
    expect(states.get("agent-run")).toBe("running");
    expect(states.get("agent-ok")).toBe("success");
    expect(states.get("agent-bad")).toBe("failed");
    expect(states.get("agent-ab")).toBe("stopped");
    expect(states.get("agent-us")).toBe("stopped");
    expect(states.get("agent-uk")).toBe("stopped");
  });

  it("reports elapsed from the injected clock while running, frozen once settled", () => {
    const clock = { t: 5000 };
    const model = makeModel(clock);
    const v = view(model, [
      rec({ agentId: "agent-r", startedAt: 1000 }),
      rec({ agentId: "agent-s", startedAt: 1000, state: "settled", outcome: "completed", settledAt: 3000 }),
    ]);
    const byId = new Map(v.rows.map((r) => [r.agentId, r]));
    expect(byId.get("agent-r")?.elapsedMs).toBe(4000);
    expect(byId.get("agent-s")?.elapsedMs).toBe(2000);
  });

  it("prefers settlement usage over live usage, live while running, absent until known", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    const v = view(model, [
      rec({
        agentId: "agent-a",
        state: "settled",
        outcome: "completed",
        settledAt: 50,
        usage: { inputTokens: 9 },
        progress: { tail: [], activity: "", usage: { inputTokens: 1 } },
      }),
      rec({ agentId: "agent-b", progress: { tail: [], activity: "", usage: { inputTokens: 2 } } }),
      rec({ agentId: "agent-c" }),
    ]);
    const byId = new Map(v.rows.map((r) => [r.agentId, r]));
    expect(byId.get("agent-a")?.usage).toEqual({ inputTokens: 9 });
    expect(byId.get("agent-b")?.usage).toEqual({ inputTokens: 2 });
    expect(byId.get("agent-c")?.usage).toBeUndefined();
  });
});

describe("selection movement and survival", () => {
  it("moves over the flattened list, clamped at both ends", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    const records = [
      rec({ agentId: "agent-a", startedAt: 0 }),
      rec({ agentId: "agent-b", startedAt: 1 }),
      rec({ agentId: "agent-c", startedAt: 2 }),
    ];
    view(model, records, { focused: true });
    expect(model.selection()).toEqual({ kind: "agent", agentId: "agent-a" });
    model.moveSelection(1);
    model.moveSelection(1);
    model.moveSelection(1); // clamped at the last row
    expect(model.selection()).toEqual({ kind: "agent", agentId: "agent-c" });
    model.moveSelection(-5); // clamped at the first row
    expect(model.selection()).toEqual({ kind: "agent", agentId: "agent-a" });
  });

  it("keeps the selected KEY across a re-sort (running row jumps ahead)", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    const a = rec({ agentId: "agent-a", startedAt: 0 });
    const b = rec({ agentId: "agent-b", startedAt: 10 });
    view(model, [a, b], { focused: true });
    model.moveSelection(1); // select agent-b
    // agent-a settles: agent-b (running) re-sorts to the top.
    const settledA = rec({
      agentId: "agent-a",
      startedAt: 0,
      state: "settled",
      outcome: "completed",
      settledAt: 100,
    });
    const v = view(model, [settledA, b], { focused: true });
    expect(v.rows.map((r) => r.agentId)).toEqual(["agent-b", "agent-a"]);
    expect(v.rows[0]?.selected).toBe(true);
  });

  it("clamps to the nearest row when the selected row is evicted", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    const a = rec({ agentId: "agent-a", startedAt: 0 });
    const b = rec({ agentId: "agent-b", startedAt: 1 });
    const c = rec({ agentId: "agent-c", startedAt: 2 });
    view(model, [a, b, c], { focused: true });
    model.moveSelection(2); // select agent-c (index 2)
    const settledC = rec({
      agentId: "agent-c",
      startedAt: 2,
      state: "settled",
      outcome: "completed",
      settledAt: 100,
    });
    clock.t = 100 + LINGER_SUCCESS_MS + 1;
    const v = view(model, [a, b, settledC]); // unfocused: agent-c expires
    expect(v.rows.map((r) => r.agentId)).toEqual(["agent-a", "agent-b"]);
    expect(model.selection()).toEqual({ kind: "agent", agentId: "agent-b" });
    expect(v.rows[1]?.selected).toBe(true);
  });

  it("clears the selection when the panel empties", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    view(model, [rec({ agentId: "agent-a" })], { focused: true });
    expect(model.selection()).toBeDefined();
    const v = view(model, []);
    expect(v.empty).toBe(true);
    expect(model.selection()).toBeUndefined();
  });
});

describe("overflow windowing", () => {
  const roots = (n: number) =>
    Array.from({ length: n }, (_, i) => rec({ agentId: `agent-${i}`, startedAt: i }));

  it("bounds visible rows at MAX_PANEL_ROWS and reports hidden counts", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    const v = view(model, roots(12));
    expect(v.rows).toHaveLength(MAX_PANEL_ROWS);
    expect(v.totalRows).toBe(12);
    expect(v.hiddenAbove).toBe(0);
    expect(v.hiddenBelow).toBe(12 - MAX_PANEL_ROWS);
  });

  it("scrolls the window to keep the selection visible", () => {
    const clock = { t: 100 };
    const model = makeModel(clock, 3);
    view(model, roots(6), { focused: true });
    for (let i = 0; i < 5; i++) {
      model.moveSelection(1);
      view(model, roots(6), { focused: true });
    }
    const v = view(model, roots(6), { focused: true });
    expect(v.hiddenAbove).toBe(3);
    expect(v.hiddenBelow).toBe(0);
    expect(v.rows.map((r) => r.agentId)).toEqual(["agent-3", "agent-4", "agent-5"]);
    expect(v.rows[2]?.selected).toBe(true);
  });

  it("marks (+N) ONLY on a parent whose subtree the window hides", () => {
    const clock = { t: 100 };
    const model = makeModel(clock, 3);
    const records = [
      rec({ agentId: "agent-p", startedAt: 0 }),
      ...Array.from({ length: 4 }, (_, i) =>
        rec({ agentId: `agent-c${i}`, parentAgentId: "agent-p", startedAt: i + 1 }),
      ),
    ];
    const v = view(model, records);
    expect(v.rows.map((r) => r.agentId)).toEqual(["agent-p", "agent-c0", "agent-c1"]);
    expect(v.rows[0]?.hiddenDescendants).toBe(2);
    expect(v.rows[1]?.hiddenDescendants).toBe(0);

    // Fully in-window subtree: no (+N) on anything.
    const wide = makeModel(clock);
    const all = view(wide, records);
    for (const row of all.rows) expect(row.hiddenDescendants).toBe(0);
  });
});

describe("row rendering", () => {
  // Long enough that every degrade stage stays above the narrow-summary
  // threshold (the width probes subtract from the previous stage's width).
  const LABEL = "build the entire frontend and wire the API layer";
  const richRecords = () => [
    rec({
      agentId: "agent-a",
      agentName: "coder",
      description: LABEL,
      startedAt: 0,
      color: "red",
      progress: {
        tail: ["done step 1"],
        activity: "running bash…",
        usage: { inputTokens: 1200, outputTokens: 340 },
      },
    }),
  ];

  function renderAt(width: number, focused = false): string[] {
    const clock = { t: 12_000 };
    const model = makeModel(clock);
    const v = view(model, richRecords(), { focused });
    return renderSubagentPanel(v, { width, entryChord: CHORD });
  }

  it("renders type, label, activity, elapsed, and tokens at generous width", () => {
    const lines = renderAt(200);
    const row = lines[0]!;
    expect(row).toContain("coder");
    expect(row).toContain(LABEL);
    expect(row).toContain("running bash…");
    expect(row).toContain("12s");
    expect(row).toContain("in 1200");
    expect(row).toContain("out 340");
  });

  it("degrades in order: tokens → activity → elapsed → label truncation", () => {
    const full = renderAt(200)[0]!;
    const w1 = visibleWidth(full);
    const noTokens = renderAt(w1 - 1)[0]!;
    expect(noTokens).not.toContain("in 1200");
    expect(noTokens).toContain("running bash…");
    expect(noTokens).toContain("12s");

    const w2 = visibleWidth(noTokens);
    const noActivity = renderAt(w2 - 1)[0]!;
    expect(noActivity).not.toContain("running bash…");
    expect(noActivity).toContain("12s");
    expect(noActivity).toContain(LABEL);

    const w3 = visibleWidth(noActivity);
    const noElapsed = renderAt(w3 - 1)[0]!;
    expect(noElapsed).not.toContain("12s");
    expect(noElapsed).toContain(LABEL);

    const truncated = renderAt(PANEL_NARROW_WIDTH)[0]!;
    expect(truncated).toContain("coder");
    expect(truncated).not.toContain(LABEL);
    expect(truncated).toContain("…");
  });

  it("never invents a zero token figure (blank until known)", () => {
    const clock = { t: 5000 };
    const model = makeModel(clock);
    const v = view(model, [rec({ agentId: "agent-a", description: "quiet work" })]);
    const row = renderSubagentPanel(v, { width: 120, entryChord: CHORD })[0]!;
    expect(row).not.toMatch(/\b0 tokens\b/);
    expect(row).not.toContain("in 0");
    expect(row).not.toContain("$0");
  });

  it("does not duplicate the agent name when the label falls back to it", () => {
    const clock = { t: 5000 };
    const model = makeModel(clock);
    const v = view(model, [rec({ agentId: "agent-a", agentName: "reviewer" })]);
    const row = renderSubagentPanel(v, { width: 120, entryChord: CHORD })[0]!;
    expect(row.match(/reviewer/g)).toHaveLength(1);
  });

  it("uses distinct glyphs per state (not color-alone) and the caller's frame", () => {
    const clock = { t: 2000 };
    const model = makeModel(clock);
    const v = view(model, [
      rec({ agentId: "agent-run", startedAt: 0 }),
      rec({ agentId: "agent-ok", startedAt: 1, state: "settled", outcome: "completed", settledAt: 1500 }),
      rec({ agentId: "agent-bad", startedAt: 2, state: "settled", outcome: "failed", settledAt: 1500 }),
      rec({ agentId: "agent-st", startedAt: 3, state: "settled", outcome: "aborted", settledAt: 1500 }),
    ]);
    const lines = renderSubagentPanel(v, { width: 120, entryChord: CHORD, runningFrame: PANEL_RUNNING_FRAMES[3] });
    expect(lines[0]).toContain(PANEL_RUNNING_FRAMES[3]!);
    expect(lines[1]).toContain(PANEL_GLYPH_SUCCESS);
    expect(lines[2]).toContain(PANEL_GLYPH_FAILED);
    expect(lines[3]).toContain(PANEL_GLYPH_STOPPED);
    const glyphs = [PANEL_RUNNING_FRAMES[3]!, PANEL_GLYPH_SUCCESS, PANEL_GLYPH_FAILED, PANEL_GLYPH_STOPPED];
    expect(new Set(glyphs).size).toBe(4);
  });

  it("tints the agent type with the record color, no tint for unknown values", () => {
    expect(tintAgentColor("red", "coder")).toBe(`${AGENT_COLOR_ANSI.red}coder${ESC}[39m`);
    expect(tintAgentColor("blood", "coder")).toBe("coder");
    expect(tintAgentColor(undefined, "coder")).toBe("coder");
    // The row tint is theme-gated (themeless renders degrade to plain text),
    // so a themed render carries the tint...
    const clock = { t: 12_000 };
    const model = makeModel(clock);
    const v = view(model, richRecords());
    const themed = renderSubagentPanel(v, {
      width: 200,
      entryChord: CHORD,
      theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
    });
    expect(themed[0]).toContain(AGENT_COLOR_ANSI.red);
    // ...and a themeless one does not.
    expect(renderAt(200)[0]!).not.toContain(AGENT_COLOR_ANSI.red);
  });

  it("marks the selected row only while focused", () => {
    const focusedRow = renderAt(200, true)[0]!;
    expect(focusedRow).toContain("❯");
    const unfocusedRow = renderAt(200, false)[0]!;
    expect(unfocusedRow).not.toContain("❯");
  });
});

describe("panel chrome (hints, overflow lines, summary, empty)", () => {
  it("returns no lines for an empty view (the panel disappears)", () => {
    const clock = { t: 0 };
    const model = makeModel(clock);
    const v = view(model, []);
    expect(renderSubagentPanel(v, { width: 80, entryChord: CHORD })).toEqual([]);
  });

  it("ends with the unfocused hint NAMING the entry chord (discovery path)", () => {
    expect(panelHintUnfocused(CHORD)).toContain(CHORD);
    const clock = { t: 0 };
    const model = makeModel(clock);
    const v = view(model, [rec({ agentId: "agent-a" })]);
    const lines = renderSubagentPanel(v, { width: 80, entryChord: CHORD });
    expect(lines[lines.length - 1]).toContain(CHORD);
  });

  it("ends with the focused key-map hint while focused", () => {
    const clock = { t: 0 };
    const model = makeModel(clock);
    const v = view(model, [rec({ agentId: "agent-a" })], { focused: true });
    const lines = renderSubagentPanel(v, { width: 120, entryChord: CHORD });
    expect(lines[lines.length - 1]).toContain(PANEL_HINT_FOCUSED);
  });

  it("shows … N more affordances for rows outside the window", () => {
    const clock = { t: 100 };
    const model = makeModel(clock, 3);
    const records = Array.from({ length: 8 }, (_, i) =>
      rec({ agentId: `agent-${i}`, startedAt: i }),
    );
    const below = renderSubagentPanel(view(model, records), { width: 80, entryChord: CHORD });
    expect(below).toContain(panelMoreBelow(5));

    view(model, records, { focused: true });
    for (let i = 0; i < 7; i++) {
      model.moveSelection(1);
      view(model, records, { focused: true });
    }
    const above = renderSubagentPanel(view(model, records, { focused: true }), {
      width: 80,
      entryChord: CHORD,
    });
    expect(above).toContain(panelMoreAbove(5));
  });

  it("degrades to a single summary line below the narrow threshold", () => {
    const clock = { t: 2000 };
    const model = makeModel(clock);
    const v = view(model, [
      rec({ agentId: "agent-a" }),
      rec({ agentId: "agent-b" }),
      rec({ agentId: "agent-c", state: "settled", outcome: "completed", settledAt: 1500 }),
    ]);
    const lines = renderSubagentPanel(v, { width: PANEL_NARROW_WIDTH - 1, entryChord: CHORD });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 running");
    expect(lines[0]).toContain("1 done");
  });
});

describe("width-clamp invariant (pi-tui visibleWidth on every line)", () => {
  const hostileRecords = () => [
    rec({
      agentId: "agent-a",
      agentName: `evil${ESC}[31m名前\tagent`,
      description: "宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符",
      color: "cyan",
      progress: { tail: [], activity: "running 一个非常长的工具名字…", usage: { inputTokens: 123456 } },
    }),
    rec({ agentId: "agent-b", parentAgentId: "agent-a", description: "child\ttask" }),
    rec({
      agentId: "agent-c",
      state: "settled",
      outcome: "failed",
      settledAt: 0,
      description: "x".repeat(400),
    }),
    // A chain deeper than the visual indent cap (6): proves the crash
    // invariant holds at depth and the indent stops growing.
    ...Array.from({ length: 9 }, (_, i) =>
      rec({
        agentId: `agent-d${i}`,
        parentAgentId: i === 0 ? "agent-b" : `agent-d${i - 1}`,
        startedAt: 10 + i,
        description: `deep ${i}`,
      }),
    ),
  ];
  const fakeTheme = {
    fg: (_c: string, s: string) => `${ESC}[36m${s}${ESC}[39m`,
    bold: (s: string) => `${ESC}[1m${s}${ESC}[22m`,
  };

  it("keeps every emitted line <= width for widths 1..90, ANSI/CJK/tab content", () => {
    for (const focused of [false, true]) {
      for (let width = 1; width <= 90; width++) {
        const clock = { t: 90_000 };
        const model = makeModel(clock);
        const v = view(model, hostileRecords(), { focused });
        const lines = renderSubagentPanel(v, {
          width,
          theme: fakeTheme,
          entryChord: CHORD,
          runningFrame: PANEL_RUNNING_FRAMES[0],
        });
        for (const line of lines) {
          expect(
            visibleWidth(line),
            `focused=${focused} width=${width} line=${JSON.stringify(line)}`,
          ).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("emits only empty lines at width 0", () => {
    const clock = { t: 90_000 };
    const model = makeModel(clock);
    const v = view(model, hostileRecords());
    const lines = renderSubagentPanel(v, { width: 0, entryChord: CHORD });
    expect(lines.length).toBeGreaterThan(0); // never vacuous: rows exist to emit
    for (const line of lines) {
      expect(line).toBe("");
    }
  });

  it("caps the visual indent: depths past MAX_INDENT_LEVELS share the level-6 indentation", () => {
    const clock = { t: 90_000 };
    const model = makeModel(clock, 20);
    const v = view(model, hostileRecords());
    const lines = renderSubagentPanel(v, { width: 200, entryChord: CHORD });
    const lineFor = (label: string) => lines.find((l) => l.includes(label))!;
    const indentOf = (l: string) => l.length - l.trimStart().length;
    // agent-d5 sits at treeDepth 7, agent-d8 at treeDepth 10 — both beyond the
    // cap, so their indentation must be identical (and finite).
    expect(indentOf(lineFor("deep 5"))).toBe(indentOf(lineFor("deep 8")));
  });

  it("tintAgentColor refuses prototype keys and unknown names; tint is theme-gated in rows", () => {
    for (const evil of ["constructor", "toString", "hasOwnProperty", "blood"]) {
      expect(tintAgentColor(evil, "text")).toBe("text");
    }
    expect(tintAgentColor("red", "text")).toContain("text");
    // Themeless render of a colored record emits no ANSI at all (degrade symmetry).
    const clock = { t: 90_000 };
    const model = makeModel(clock);
    const v = view(model, [rec({ agentId: "agent-a", color: "red" })]);
    for (const line of renderSubagentPanel(v, { width: 120, entryChord: CHORD })) {
      expect(line.includes(ESC)).toBe(false);
    }
  });

  it("strips hostile escape/control sequences from every rendered line", () => {
    const clock = { t: 90_000 };
    const model = makeModel(clock);
    const hostile = [
      rec({
        agentId: "agent-a",
        agentName: `${ESC}[2Jevil${ESC}]0;pwn${BEL}name`,
        description: `d${ESC}[31mescription`,
        progress: { tail: [], activity: `${ESC}]8;;http://x${BEL}act` },
      }),
    ];
    const lines = renderSubagentPanel(view(model, hostile), { width: 120, entryChord: CHORD });
    for (const line of lines) {
      expect(line.includes(ESC)).toBe(false);
      expect(line.includes(BEL)).toBe(false);
    }
    expect(lines[0]).toContain("evil");
  });
});

describe("formatElapsed", () => {
  it("formats seconds, minutes, and hours in the 4m12s style", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(-500)).toBe("0s");
    expect(formatElapsed(12_000)).toBe("12s");
    expect(formatElapsed(252_000)).toBe("4m12s");
    expect(formatElapsed(62_000)).toBe("1m02s");
    expect(formatElapsed(3_840_000)).toBe("1h04m");
    expect(formatElapsed(Number.NaN)).toBe("0s");
  });
});

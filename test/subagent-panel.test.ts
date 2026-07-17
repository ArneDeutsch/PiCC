import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import picc, { type PiccTestSeam } from "../src/index.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk, type FakeSdkHandle } from "./helpers/fake-sdk.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";
import { waitUntil } from "./helpers/async.js";
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
import { SubagentRegistry, type SubagentRegistryRecord } from "../src/runtime/subagent-registry.js";
import {
  createPanelHintEmitter,
  PANEL_ENTRY_CHORD,
  panelHintText,
  SUBAGENT_PANEL_WIDGET_KEY,
  SubagentPanelWidgetController,
} from "../src/runtime/subagent-panel-widget.js";

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

// ---------------------------------------------------------------------------
// Widget shell (subagent-panel-widget.ts) + fake-pi UI surface
// ---------------------------------------------------------------------------

describe("panel-entry chord constant", () => {
  it("is the compile-time literal the render fixtures above assume", () => {
    // The chord is interpolated into hint lines unsanitized by design — it must
    // stay a compile-time literal, and the fixture CHORD tracks it.
    expect(PANEL_ENTRY_CHORD).toBe(CHORD);
  });
});

describe("one-time panel hint emitter", () => {
  it("emits once (with the injected chord) when more than one agent runs, never again", () => {
    const emitted: string[] = [];
    const emit = createPanelHintEmitter({
      chord: "ctrl+t",
      isTui: () => true,
      emit: (text) => emitted.push(text),
    });
    emit(3);
    expect(emitted).toEqual([panelHintText(3, "ctrl+t")]);
    expect(emitted[0]).toContain("ctrl+t");
    expect(emitted[0]).toContain("3 agents running");
    emit(5); // once per session: a later, larger fan-out stays silent
    expect(emitted).toHaveLength(1);
  });

  it("does NOT emit for a single agent (negative), and a gated-off call keeps the once-gate", () => {
    const emitted: string[] = [];
    const emit = createPanelHintEmitter({
      chord: PANEL_ENTRY_CHORD,
      isTui: () => true,
      emit: (text) => emitted.push(text),
    });
    emit(0);
    emit(1);
    expect(emitted).toEqual([]);
    emit(2); // the single-agent calls did not consume the gate
    expect(emitted).toEqual([panelHintText(2, PANEL_ENTRY_CHORD)]);
  });

  it("emits nothing outside TUI mode, without consuming the once-gate", () => {
    const emitted: string[] = [];
    let tui = false;
    const emit = createPanelHintEmitter({
      chord: PANEL_ENTRY_CHORD,
      isTui: () => tui,
      emit: (text) => emitted.push(text),
    });
    emit(4); // print/RPC: silent
    expect(emitted).toEqual([]);
    tui = true;
    emit(4);
    expect(emitted).toEqual([panelHintText(4, PANEL_ENTRY_CHORD)]);
  });
});

/** A minimal running registry record for widget tests. */
function registerRunning(registry: SubagentRegistry, agentId: string): void {
  registry.register({
    agentId,
    agentName: "coder",
    depth: 1,
    cwd: "/repo",
    resumable: true,
    oneShot: false,
  });
}

describe("panel widget controller (unit, fake-pi ui)", () => {
  function setup(over: Partial<ConstructorParameters<typeof SubagentPanelWidgetController>[0]> = {}) {
    const registry = new SubagentRegistry();
    const pi = fakePi();
    const ui = (pi.ctx() as { ui: never }).ui;
    const controller = new SubagentPanelWidgetController({ registry, tasks: () => [], ...over });
    return { registry, pi, ui, controller };
  }

  it("installs a belowEditor widget on attach when rows are already visible", () => {
    const { registry, pi, ui, controller } = setup();
    registerRunning(registry, "agent-a");
    try {
      controller.attach(ui);
      const install = pi.widgetCalls.find((c) => c.content !== undefined);
      expect(install?.key).toBe(SUBAGENT_PANEL_WIDGET_KEY);
      expect(install?.options?.placement).toBe("belowEditor");
      expect(pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!.render(120).join("\n")).toContain("coder");
    } finally {
      controller.setSuppressed(true); // clear the real repaint interval
    }
  });

  it("onChange drives the lifecycle: absent while empty, installed on registry activity", () => {
    const { registry, pi, ui, controller } = setup();
    try {
      controller.attach(ui); // empty registry: nothing to show
      expect(pi.widgetCalls).toEqual([]);
      registerRunning(registry, "agent-a"); // change while the widget is absent → install
      expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(true);
      const requestsAfterInstall = pi.renderRequests;
      registerRunning(registry, "agent-b"); // change while installed → repaint, no reinstall
      expect(pi.renderRequests).toBeGreaterThan(requestsAfterInstall);
      expect(pi.widgetCalls.filter((c) => c.content !== undefined)).toHaveLength(1);
    } finally {
      controller.setSuppressed(true);
    }
  });

  it("suppression (the t05 focused-panel seam) hides the widget and re-shows it", () => {
    const { registry, pi, ui, controller } = setup();
    try {
      registerRunning(registry, "agent-a");
      controller.attach(ui);
      const widget = pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!;
      controller.setSuppressed(true);
      expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(false);
      expect(widget.disposed).toBe(true); // interval died with the widget
      registerRunning(registry, "agent-b"); // activity while suppressed stays hidden
      expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(false);
      controller.setSuppressed(false);
      expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(true);
    } finally {
      controller.setSuppressed(true);
    }
  });

  it("defensive render: a poisoned render stub is caught, logged, and renders empty (process-liveness)", () => {
    // pi-tui kills the whole process on a throwing render — the shell must
    // catch, log, and emit nothing instead. This is the named process-liveness
    // property, proven with an injected throwing renderer.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, pi, ui, controller } = setup({
      render: () => {
        throw new Error("poisoned render");
      },
    });
    registerRunning(registry, "agent-a");
    try {
      controller.attach(ui);
      const widget = pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!;
      expect(widget.render(80)).toEqual([]);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("subagent panel render failed"));
    } finally {
      controller.setSuppressed(true);
      errors.mockRestore();
    }
  });

  it("a throwing data join never escapes attach/onChange (logs, no widget, registry unharmed)", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { registry, ui, controller, pi } = setup({
      tasks: () => {
        throw new Error("poisoned join");
      },
    });
    try {
      controller.attach(ui);
      registerRunning(registry, "agent-a"); // onChange fires into the throwing join
      expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(false);
      expect(registry.get("agent-a")).toBeDefined(); // the mutation survived the listener
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("subagent panel update failed"));
    } finally {
      controller.setSuppressed(true);
      errors.mockRestore();
    }
  });
});

describe("panel widget timer discipline (fake timers)", () => {
  afterEach(() => {
    // Repo teardown convention: the interval must be gone after dispose.
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("creates the tick interval on install and clears it on dispose (no leak)", () => {
    vi.useFakeTimers();
    const registry = new SubagentRegistry();
    const pi = fakePi();
    const controller = new SubagentPanelWidgetController({ registry, tasks: () => [] });
    registerRunning(registry, "agent-a");
    controller.attach((pi.ctx() as { ui: never }).ui);
    expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    const before = pi.renderRequests;
    vi.advanceTimersByTime(3000); // ~1s cadence: three ticks repaint three times
    expect(pi.renderRequests).toBeGreaterThanOrEqual(before + 3);
    controller.setSuppressed(true); // remove → dispose → interval cleared
    expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a tick that finds every row linger-expired removes the widget (and its own interval)", () => {
    vi.useFakeTimers();
    const clock = { t: Date.now() };
    const registry = new SubagentRegistry();
    const pi = fakePi();
    const controller = new SubagentPanelWidgetController({
      registry,
      tasks: () => [],
      now: () => clock.t,
    });
    registerRunning(registry, "agent-a");
    registry.markSettled("agent-a", { outcome: "completed" });
    controller.attach((pi.ctx() as { ui: never }).ui);
    expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(true); // lingering
    clock.t += LINGER_SUCCESS_MS + 1;
    vi.advanceTimersByTime(1000); // the next tick observes the expiry
    expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(false);
    expect(pi.widgetCalls[pi.widgetCalls.length - 1]).toMatchObject({
      key: SUBAGENT_PANEL_WIDGET_KEY,
      content: undefined,
    });
    expect(vi.getTimerCount()).toBe(0);
    // Expiry-removal → NEW activity → re-install, pinned directly.
    registerRunning(registry, "agent-b");
    expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(true);
    controller.setSuppressed(true); // clean up the fresh interval
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("panel widget wiring (offline integration: fake-pi + fake-sdk)", () => {
  let dir: string;
  const originalCwd = process.cwd();
  const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

  beforeAll(() => {
    dir = materializeFixture("hello-claude");
    // Hermetic user scope: don't absorb the developer's real ~/.claude.
    const userDir = path.join(dir, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
    else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
    cleanupFixture(dir);
  });

  type Internals = Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];

  async function boot(handle: FakeSdkHandle): Promise<{ pi: FakePi; internals: Internals }> {
    const pi = fakePi();
    let internals!: Internals;
    picc(pi.api as never, {
      sdk: handle.sdk,
      onWired: (i) => (internals = i),
      onInitializationSettled: pi.captureInitialization,
    });
    await pi.waitForInitialization();
    await pi.waitForTools(["Agent"]);
    return { pi, internals };
  }

  it("dispatch installs the belowEditor widget; settlement flips the row; linger expiry (injected clock) removes it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const handle = fakeSdk({ replies: [{ text: "sub done", gate }] });
    const { pi, internals } = await boot(handle);
    // Injected clock + short tick per the clock rule: NEVER fake timers around
    // an async dispatch — the panel clock is swapped through the test seam and
    // the real (fast) interval observes it.
    const clock = { t: Date.now() };
    internals.subagentPanel.configureForTest({ now: () => clock.t, tickMs: 10 });

    await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
    expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(false); // nothing running yet

    const agentTool = pi.tools.get("Agent");
    const res = await agentTool.execute("t1", {
      subagent_type: "general-purpose",
      prompt: "GO",
      run_in_background: true,
    });
    const taskId = res.details.taskId as string;
    await waitUntil({
      description: "panel widget installed after the background dispatch",
      predicate: () => pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY),
      describeObserved: () => `setWidget calls: ${JSON.stringify(pi.widgetCalls.map((c) => c.key))}`,
    });
    const install = pi.widgetCalls.find((c) => c.content !== undefined)!;
    expect(install.key).toBe(SUBAGENT_PANEL_WIDGET_KEY);
    expect(install.options?.placement).toBe("belowEditor");
    const runningRow = pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!.render(120).join("\n");
    expect(runningRow).toContain("general-purpose");
    expect(runningRow).not.toContain(PANEL_GLYPH_SUCCESS);

    release();
    const agentId = internals.backgroundTasks.get(taskId)!.agentId!;
    await waitUntil({
      description: "the dispatched agent to settle in the registry",
      predicate: () => internals.subagentRegistry.get(agentId)?.state === "settled",
      describeObserved: () => `record state: ${internals.subagentRegistry.get(agentId)?.state}`,
    });
    const settledRow = pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!.render(120).join("\n");
    expect(settledRow).toContain(PANEL_GLYPH_SUCCESS); // flipped to the finished bubble

    clock.t = Date.now() + LINGER_SUCCESS_MS + 60_000; // way past the success linger
    await waitUntil({
      description: "the widget to be removed after linger expiry",
      predicate: () => !pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY),
      describeObserved: () => `setWidget calls: ${JSON.stringify(pi.widgetCalls.map((c) => c.key))}`,
    });
    expect(pi.widgetCalls[pi.widgetCalls.length - 1]).toMatchObject({
      key: SUBAGENT_PANEL_WIDGET_KEY,
      content: undefined,
    });
  });

  it("never installs the widget from a print- or RPC-mode session (mode gate, not hasUI)", async () => {
    const handle = fakeSdk({ replies: ["done"] });
    const { pi, internals } = await boot(handle);
    // printCtx models real print mode (hasUI false, verbs present as no-ops);
    // rpcCtx is the trap shape: hasUI TRUE and a working setWidget — only the
    // mode gate keeps the panel out of it. Both shapes are pinned against real
    // Pi in test/pi-contract.test.ts.
    await pi.fire("session_start", { reason: "startup" }, pi.printCtx());
    await pi.fire("session_start", { reason: "startup" }, pi.rpcCtx());
    const agentTool = pi.tools.get("Agent");
    await agentTool.execute("t1", {
      subagent_type: "general-purpose",
      prompt: "GO",
      run_in_background: false,
    });
    expect(internals.subagentRegistry.list().length).toBeGreaterThan(0); // the dispatch really ran
    expect(pi.widgetCalls).toEqual([]); // setWidget was never touched
  });
});

describe("fake-pi UI driving surface (the shape later panel tasks build on)", () => {
  it("drives a custom component end to end: factory, keybinding matches, input, render, done", async () => {
    const pi = fakePi();
    const ui = (pi.ctx() as { ui: any }).ui;
    const seen: string[] = [];
    const resultPromise = ui.custom(
      (_tui: unknown, _theme: unknown, keybindings: any, done: (v: string) => void) => ({
        render: (width: number) => [`w=${width}`],
        handleInput: (data: string) => {
          if (keybindings.matches(data, "tui.select.down")) seen.push("down");
          else if (keybindings.matches(data, "tui.select.up")) seen.push("up");
          else if (keybindings.matches(data, "tui.select.confirm")) done("confirmed");
          else if (keybindings.matches(data, "tui.select.cancel")) done("cancelled");
        },
        dispose: () => seen.push("disposed"),
      }),
      { overlay: true },
    );
    const invocation = pi.customs[0]!;
    await invocation.ready;
    expect(invocation.options).toEqual({ overlay: true });
    expect(invocation.render(42)).toEqual(["w=42"]);
    invocation.input("\u001b[B"); // tui.select.down (default keymap)
    invocation.input("\u001b[A"); // tui.select.up
    invocation.input("\r"); // tui.select.confirm → done()
    await expect(resultPromise).resolves.toBe("confirmed");
    expect(invocation.closed).toBe(true);
    expect(seen).toEqual(["down", "up", "disposed"]); // dispose ran exactly once, at close
    invocation.input("\u001b"); // done() is one-shot: a late cancel changes nothing
    await expect(invocation.result).resolves.toBe("confirmed");
  });

  it("records registerShortcut on the api (panel-entry wiring must not break fake-pi tests)", () => {
    const pi = fakePi();
    (pi.api.registerShortcut as (key: string, options: unknown) => void)(PANEL_ENTRY_CHORD, {
      description: "open the agent panel",
      handler: () => undefined,
    });
    expect(pi.shortcuts.get(PANEL_ENTRY_CHORD)?.description).toBe("open the agent panel");
  });

  it("feeds terminal input through the handler chain with pi-tui's consume/rewrite semantics", () => {
    const pi = fakePi();
    const ui = (pi.ctx() as { ui: any }).ui;
    const unsubscribe = ui.onTerminalInput((data: string) =>
      data === "x" ? { consume: true } : { data: data.toUpperCase() },
    );
    ui.onTerminalInput((data: string) => (data === "Y" ? { consume: true } : undefined));
    expect(pi.feedTerminalInput("x")).toEqual({ consumed: true, data: "x" });
    expect(pi.feedTerminalInput("y")).toEqual({ consumed: true, data: "Y" }); // rewritten, then consumed downstream
    expect(pi.feedTerminalInput("z")).toEqual({ consumed: false, data: "Z" });
    unsubscribe();
    expect(pi.feedTerminalInput("x")).toEqual({ consumed: false, data: "x" });
  });
});

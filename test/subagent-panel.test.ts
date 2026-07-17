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
  DETAIL_BANNER_RESUMED,
  DETAIL_BANNER_SETTLED,
  DETAIL_BANNER_VANISHED,
  DETAIL_FINAL_LABEL,
  DETAIL_FOREGROUND_ALT,
  DETAIL_NO_ACTIVITY,
  DETAIL_NO_FINAL_ANSWER,
  DETAIL_NO_TAIL,
  DETAIL_PROMPT_EXPANDED,
  DETAIL_STEER_PREFIX,
  DETAIL_STEER_SENT,
  DETAIL_TAIL_LABEL,
  detailHint,
  detailPromptCollapsed,
  detailSteerFailed,
  detailSteerUnavailable,
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
  renderSubagentDetail,
  renderSubagentPanel,
  tintAgentColor,
  type PanelDetailUiState,
} from "../src/runtime/subagent-panel-render.js";
import {
  AGENT_COLOR_NAMES,
  SubagentRegistry,
  type RegisterInput,
  type SubagentRegistryRecord,
} from "../src/runtime/subagent-registry.js";
import { HookRunner } from "../src/engine/hook-runner.js";
import {
  createPanelHintEmitter,
  PANEL_ENTRY_CHORD,
  panelHintText,
  SUBAGENT_PANEL_WIDGET_KEY,
  SubagentPanelWidgetController,
} from "../src/runtime/subagent-panel-widget.js";
import {
  PANEL_FOCUSED_EMPTY_LINE,
  PANEL_NOTICE_ALL_DISMISSED,
  PANEL_NOTICE_EMPTY,
  PANEL_NOTICE_FOREGROUND,
  PANEL_NOTICE_RUNNING_DISMISS,
  PANEL_NOTICE_STALE,
  PANEL_NOTICE_STOP_ALL_NONE,
  panelNoticeStopAllArmed,
  panelNoticeStopAllDone,
  panelNoticeStopRequested,
  STEER_INPUT_CAP,
  STOP_ALL_CONFIRM_MS,
  SubagentPanelFocusController,
} from "../src/runtime/subagent-panel-focus.js";

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

  it("DRIFT GUARD: the render palette's names equal the capture-side color whitelist", () => {
    // Capture (subagent-registry) whitelists color names; render (this map)
    // assigns them ANSI codes. A name added to one side only would silently
    // drop the tint (or dead-code the ANSI entry) — pin the sets equal.
    expect(Object.keys(AGENT_COLOR_ANSI).sort()).toEqual([...AGENT_COLOR_NAMES].sort());
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
// Drill-down detail rendering (pure)
// ---------------------------------------------------------------------------

function detailUi(over: Partial<PanelDetailUiState> = {}): PanelDetailUiState {
  return { promptExpanded: false, scrollTop: 0, follow: true, steerBuffer: "", ...over };
}

describe("drill-down detail rendering (pure)", () => {
  const numberedTail = (n: number) =>
    Array.from({ length: n }, (_, i) => `tail line ${String(i + 1).padStart(2, "0")}`);

  it("running layout: header, collapsed prompt, auto-following tail, steer line, hint", () => {
    const record = rec({
      agentId: "agent-a",
      description: "build the frontend",
      prompt: "do the thing\nplease",
      fullTail: numberedTail(20),
      transcriptPath: "/repo/.claude/.picc/agent-a.jsonl",
      session: { steer: () => undefined },
      startedAt: 0,
    });
    const { lines, maxScroll } = renderSubagentDetail(
      { record, taskId: "task-7", nowMs: 12_000 },
      detailUi(),
      { width: 120 },
    );
    const text = lines.join("\n");
    expect(text).toContain("coder");
    expect(text).toContain("build the frontend");
    expect(text).toContain("agent-a");
    expect(text).toContain("task-7");
    expect(text).toContain("12s");
    expect(text).toContain("running");
    // The prompt is collapsed to its PINNED one-line affordance — visible even
    // though the following tail has scrolled its window well past the top.
    expect(text).toContain(detailPromptCollapsed(2));
    expect(text).not.toContain("do the thing");
    // Auto-follow: the newest tail line is visible, the oldest scrolled out.
    expect(text).toContain("tail line 20");
    expect(text).not.toContain("tail line 08");
    expect(text).toContain(panelMoreAbove(8)); // 20 tail lines − 12 body rows
    expect(maxScroll).toBe(8);
    // The transcript path is an inert pointer string only (never re-read).
    expect(text).toContain("/repo/.claude/.picc/agent-a.jsonl");
    expect(text).toContain(DETAIL_STEER_PREFIX);
    expect(lines[lines.length - 1]).toContain(
      detailHint({ steerable: true, stoppable: true }),
    );
  });

  it("finished layout: final answer leads, then collapsed prompt, tail below; no steer line", () => {
    const record = rec({
      agentId: "agent-a",
      state: "settled",
      outcome: "completed",
      startedAt: 1000,
      settledAt: 9000,
      finalText: "Answer: everything passed",
      prompt: "check it",
      fullTail: ["step one", "step two"],
    });
    const { lines } = renderSubagentDetail(
      { record, nowMs: 50_000 },
      detailUi({ follow: false }),
      { width: 120 },
    );
    const text = lines.join("\n");
    expect(text).toContain(DETAIL_FINAL_LABEL);
    expect(text).toContain("Answer: everything passed");
    expect(text).toContain(detailPromptCollapsed(1));
    expect(text).toContain("8s"); // elapsed frozen at settledAt − startedAt
    expect(text).toContain("completed");
    expect(text).not.toContain(DETAIL_STEER_PREFIX);
    const answerIndex = lines.findIndex((l) => l.includes(DETAIL_FINAL_LABEL));
    const promptIndex = lines.findIndex((l) => l.includes("initial prompt"));
    expect(answerIndex).toBeGreaterThanOrEqual(0);
    expect(answerIndex).toBeLessThan(promptIndex);
    expect(text).toContain(DETAIL_TAIL_LABEL);
    expect(text).toContain("step two");
    expect(lines[lines.length - 1]).toContain(
      detailHint({ steerable: false, stoppable: false }),
    );
  });

  it("settled view with nothing captured shows the honest placeholders, never blank sections", () => {
    const record = rec({
      agentId: "agent-a",
      state: "settled",
      outcome: "completed",
      startedAt: 0,
      settledAt: 1000,
    });
    const text = renderSubagentDetail({ record, nowMs: 5000 }, detailUi({ follow: false }), {
      width: 120,
    }).lines.join("\n");
    expect(text).toContain(DETAIL_NO_FINAL_ANSWER);
    expect(text).toContain(DETAIL_NO_TAIL);
  });

  it("expands and collapses the prompt via the ui flag", () => {
    const record = rec({
      agentId: "agent-a",
      prompt: "first line\nsecond line\nthird line",
      session: { steer: () => undefined },
    });
    const collapsed = renderSubagentDetail({ record, nowMs: 0 }, detailUi(), { width: 120 });
    expect(collapsed.lines.join("\n")).toContain(detailPromptCollapsed(3));
    expect(collapsed.lines.join("\n")).not.toContain("second line");
    expect(collapsed.lines.join("\n")).toContain(DETAIL_NO_ACTIVITY); // empty tail placeholder
    const expanded = renderSubagentDetail(
      { record, nowMs: 0 },
      detailUi({ promptExpanded: true }),
      { width: 120 },
    );
    expect(expanded.lines.join("\n")).toContain(DETAIL_PROMPT_EXPANDED);
    expect(expanded.lines.join("\n")).toContain("second line");
  });

  it("anchors the scrolled-back window from the top; follow shows the bottom", () => {
    const record = rec({ agentId: "agent-a", fullTail: numberedTail(30) });
    const anchored = renderSubagentDetail(
      { record, nowMs: 0 },
      detailUi({ follow: false, scrollTop: 0 }),
      { width: 120 },
    );
    const anchoredText = anchored.lines.join("\n");
    expect(anchoredText).toContain("tail line 01");
    expect(anchoredText).not.toContain("tail line 30");
    expect(anchoredText).toContain(panelMoreBelow(18)); // 30 lines − 12 rows
    expect(anchored.maxScroll).toBe(18);
    const following = renderSubagentDetail({ record, nowMs: 0 }, detailUi(), { width: 120 });
    expect(following.lines.join("\n")).toContain("tail line 30");
    expect(following.lines.join("\n")).not.toContain("tail line 01");
  });

  it("renders honest unavailability notices: foreground (with the real alternative), one-shot, user-stopped", () => {
    const foreground = renderSubagentDetail(
      { record: rec({ agentId: "agent-a" }), nowMs: 0 },
      detailUi(),
      { width: 160 },
    ).lines.join("\n");
    expect(foreground).toContain(detailSteerUnavailable("foreground agent"));
    expect(foreground).toContain(DETAIL_FOREGROUND_ALT);
    expect(foreground).not.toContain(DETAIL_STEER_PREFIX);

    const oneShot = renderSubagentDetail(
      {
        record: rec({ agentId: "agent-a", oneShot: true, session: { steer: () => undefined } }),
        nowMs: 0,
      },
      detailUi(),
      { width: 160 },
    ).lines.join("\n");
    expect(oneShot).toContain(detailSteerUnavailable("one-shot agent"));

    const stopped = renderSubagentDetail(
      {
        record: rec({ agentId: "agent-a", userStopped: true, session: { steer: () => undefined } }),
        nowMs: 0,
      },
      detailUi(),
      { width: 160 },
    ).lines.join("\n");
    expect(stopped).toContain(detailSteerUnavailable("stopped by user"));
  });

  it("renders the vanished banner without throwing when the record is gone", () => {
    const { lines, maxScroll } = renderSubagentDetail(
      { record: undefined, nowMs: 0 },
      detailUi({ banner: DETAIL_BANNER_VANISHED }),
      { width: 80 },
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain(DETAIL_BANNER_VANISHED);
    expect(maxScroll).toBe(0);
  });

  it("keeps every line <= width for widths 1..90 with hostile ANSI/CJK content in prompt/finalText/tail", () => {
    const fakeTheme = {
      fg: (_c: string, s: string) => `${ESC}[36m${s}${ESC}[39m`,
      bold: (s: string) => `${ESC}[1m${s}${ESC}[22m`,
    };
    const hostile = (state: "running" | "settled") =>
      rec({
        agentId: "agent-a",
        agentName: `evil${ESC}[31m名前\tagent`,
        description: "宽字符".repeat(20),
        // \r and \r\n included: sanitizeProgressText preserves \r, so a lone
        // CR surviving into an emitted line would overprint it from column 0.
        prompt: `p${ESC}]0;pwn${BEL}rompt\rcr-spoof\r\ncrlf-line\n${"宽".repeat(200)}\n${"x".repeat(400)}`,
        finalText: `f${ESC}[2Jinal\rcr-spoof\r\ncrlf-line\n${"宽宽".repeat(100)}`,
        fullTail: [`t${ESC}[31mail`, "宽宽宽宽".repeat(30), "z".repeat(400)],
        session: { steer: () => undefined },
        state,
        ...(state === "settled" ? { outcome: "failed" as const, settledAt: 5 } : {}),
      });
    for (const state of ["running", "settled"] as const) {
      for (const promptExpanded of [false, true]) {
        for (let width = 1; width <= 90; width++) {
          const { lines } = renderSubagentDetail(
            { record: hostile(state), taskId: "task-1", nowMs: 9000 },
            detailUi({ promptExpanded, steerBuffer: "宽".repeat(80) }),
            { width, theme: fakeTheme, runningFrame: PANEL_RUNNING_FRAMES[0] },
          );
          for (const line of lines) {
            expect(
              visibleWidth(line),
              `state=${state} expanded=${promptExpanded} width=${width} line=${JSON.stringify(line)}`,
            ).toBeLessThanOrEqual(width);
            // A surviving CR is invisible to visibleWidth but lets content
            // overprint the line from column 0 — assert none ever leaks.
            expect(line.includes("\r"), JSON.stringify(line)).toBe(false);
          }
        }
      }
    }
    // Themeless render of the same hostile content emits no escape/control
    // bytes. Width 400 keeps every line wrap-only (no clamp truncation), so
    // any ESC here would come from CONTENT — pi-tui's truncateToWidth appends
    // its own benign ANSI reset when it truncates, which is not a leak.
    for (const state of ["running", "settled"] as const) {
      const { lines } = renderSubagentDetail(
        { record: hostile(state), nowMs: 9000 },
        detailUi({ promptExpanded: true }),
        { width: 400 },
      );
      for (const line of lines) {
        expect(line.includes(ESC), JSON.stringify(line)).toBe(false);
        expect(line.includes(BEL), JSON.stringify(line)).toBe(false);
        expect(line.includes("\r"), JSON.stringify(line)).toBe(false);
      }
    }
  });

  it("left-anchors the steer line: overflow truncates from the START so the buffer end stays visible", () => {
    const record = rec({ agentId: "agent-a", session: { steer: () => undefined } });
    const { lines } = renderSubagentDetail(
      { record, nowMs: 0 },
      detailUi({ steerBuffer: "0123456789 steer tail END" }),
      { width: 24 }, // prefix is 8 wide → 16 columns for the buffer
    );
    const steerLine = lines.find((l) => l.startsWith(DETAIL_STEER_PREFIX))!;
    // The END of the buffer (the cursor) is visible; the start is elided.
    expect(steerLine).toBe(`${DETAIL_STEER_PREFIX}… steer tail END`);
  });

  it("emits only empty lines at width 0 and never throws", () => {
    const record = rec({ agentId: "agent-a", prompt: "p", fullTail: ["t"] });
    const { lines } = renderSubagentDetail({ record, nowMs: 0 }, detailUi(), { width: 0 });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toBe("");
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

  it("consumes the dismissed set: a dismissed settled row leaves the passive widget", () => {
    const dismissed = new Set<string>();
    const { registry, pi, ui, controller } = setup({ dismissed: () => dismissed });
    try {
      registerRunning(registry, "agent-a");
      registry.markSettled("agent-a", { outcome: "completed" });
      controller.attach(ui);
      expect(pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!.render(120).join("\n")).toContain("coder");
      dismissed.add("agent:agent-a");
      registry.markSettled("agent-a", { outcome: "completed" }); // any change resyncs
      // The only row is dismissed → the widget removes itself entirely.
      expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(false);
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

// ---------------------------------------------------------------------------
// Focused panel (subagent-panel-focus.ts): entry, navigation, actions
// ---------------------------------------------------------------------------

const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
const KEY_ENTER = String.fromCharCode(13);
const KEY_BACKSPACE = String.fromCharCode(127);
const KEY_CTRL_X = String.fromCharCode(24);
const KEY_CTRL_P = String.fromCharCode(16);

describe("panel focus controller (unit, fake-pi ui)", () => {
  function focusSetup() {
    const registry = new SubagentRegistry();
    const tasks: PanelTaskInfo[] = [];
    const stopped: string[] = [];
    const suppressions: boolean[] = [];
    const clock = { t: Date.now() };
    const poison = { on: false };
    const pi = fakePi();
    const controller = new SubagentPanelFocusController({
      registry,
      tasks: () => {
        if (poison.on) throw new Error("poisoned join");
        return tasks;
      },
      stopTask: (id) => {
        stopped.push(id);
        const task = tasks.find((t) => t.id === id);
        if (task) task.status = "stopped";
      },
      widget: { setSuppressed: (on: boolean) => void suppressions.push(on) },
      now: () => clock.t,
      // A real (unref'd) interval, effectively inert during the test; each
      // component's dispose clears its own.
      tickMs: 3_600_000,
    });
    /** Open via a TUI ctx and return the recorded custom invocation (if any). */
    const openPanel = () => {
      controller.open(pi.tuiCtx() as never);
      return pi.customs[pi.customs.length - 1];
    };
    const notices = () => pi.notifications.map((n) => n.text);
    return { registry, tasks, stopped, suppressions, clock, poison, pi, controller, openPanel, notices };
  }

  /** Register a running record with panel-visible labeling (drill-down fields via `over`). */
  function reg(
    registry: SubagentRegistry,
    agentId: string,
    description?: string,
    over: Partial<RegisterInput> = {},
  ): void {
    registry.register({
      agentId,
      agentName: "coder",
      depth: 1,
      cwd: "/repo",
      resumable: true,
      oneShot: false,
      description,
      ...over,
    });
  }

  it("chord on an empty panel shows the notice and opens no component", () => {
    const s = focusSetup();
    const invocation = s.openPanel();
    expect(invocation).toBeUndefined();
    expect(s.pi.customs).toHaveLength(0);
    expect(s.notices()).toContain(PANEL_NOTICE_EMPTY);
    expect(s.suppressions).toEqual([]); // the widget was never touched
    expect(s.controller.isOpen()).toBe(false);
  });

  it("opens the component, suppresses the widget, marks the selection, and Esc closes/restores", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    const invocation = s.openPanel()!;
    await invocation.ready;
    expect(s.controller.isOpen()).toBe(true);
    expect(s.suppressions).toEqual([true]); // passive widget hidden while open
    const lines = invocation.render(120);
    expect(lines.join("\n")).toContain("coder");
    expect(lines.join("\n")).toContain("❯"); // the accent selection marker
    expect(lines[lines.length - 1]).toContain(PANEL_HINT_FOCUSED);
    // Re-entry while open is a no-op (Pi's focus arbitration normally prevents
    // the chord from even firing — this is the belt for other callers).
    s.controller.open(s.pi.tuiCtx() as never);
    expect(s.pi.customs).toHaveLength(1);
    invocation.input(ESC);
    await invocation.result;
    expect(invocation.closed).toBe(true);
    await Promise.resolve(); // let the close cleanup settle
    expect(s.controller.isOpen()).toBe(false);
    expect(s.suppressions).toEqual([true, false]); // widget released on close
    // A later chord opens a fresh component.
    reg(s.registry, "agent-b");
    const reopened = s.openPanel()!;
    expect(s.pi.customs).toHaveLength(2);
    await reopened.ready;
    reopened.input(ESC);
    await reopened.result;
  });

  it("arrow keys move the selection over the rendered rows", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", "first row");
    reg(s.registry, "agent-b", "second row");
    const invocation = s.openPanel()!;
    await invocation.ready;
    const selectedLine = () => invocation.render(120).find((l) => l.includes("❯"))!;
    expect(selectedLine()).toContain("first row");
    invocation.input(KEY_DOWN);
    expect(selectedLine()).toContain("second row");
    invocation.input(KEY_DOWN); // clamped at the last row
    expect(selectedLine()).toContain("second row");
    invocation.input(KEY_UP);
    expect(selectedLine()).toContain("first row");
    invocation.input(ESC);
    await invocation.result;
  });

  it("x on a running background row applies the PAIRED user stop and notifies", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("x");
    expect(s.stopped).toEqual(["task-1"]); // task-side marker+abort
    expect(s.registry.get("agent-a")!.userStopped).toBe(true); // agent-side marker
    expect(s.notices()).toContain(panelNoticeStopRequested("coder"));
    invocation.input(ESC);
    await invocation.result;
  });

  it("x on a settled row dismisses panel-locally; model-facing state stays untouched", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    s.tasks.push({ id: "task-1", status: "completed", agentId: "agent-a" });
    s.registry.markSettled("agent-a", { outcome: "completed" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("x");
    expect(s.controller.dismissedKeyIds()).toEqual(["task:task-1"]);
    // The only row is dismissed: the focused panel keeps a visible line.
    expect(invocation.render(120).join("\n")).toContain(PANEL_FOCUSED_EMPTY_LINE);
    // Dismiss is invisible to the model: no stop, no marker, notice gate armed.
    expect(s.stopped).toEqual([]);
    const record = s.registry.get("agent-a")!;
    expect(record.userStopped).toBeUndefined();
    expect(s.registry.isSettledNoticeArmed("agent-a")).toBe(true);
    invocation.input(ESC);
    await invocation.result;
  });

  it("PINNED race semantics: a row that settled between render and keypress gets a benign dismiss, never a stop", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120); // selection resolved while the row was running
    // The agent settles between render and keypress.
    s.tasks[0]!.status = "completed";
    s.registry.markSettled("agent-a", { outcome: "completed" });
    invocation.input("x");
    expect(s.stopped).toEqual([]); // NOT a misdirected stop
    expect(s.registry.get("agent-a")!.userStopped).toBeUndefined();
    expect(s.controller.dismissedKeyIds()).toEqual(["task:task-1"]); // benign dismiss
    invocation.input(ESC);
    await invocation.result;
  });

  it("a superseded or vanished target refuses with a notice, never falls through", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120); // selection: task:task-1
    // A resume mints a newer generation: the old key is superseded.
    s.tasks.push({ id: "task-2", status: "running", agentId: "agent-a" });
    invocation.input("x");
    expect(s.stopped).toEqual([]);
    expect(s.registry.get("agent-a")!.userStopped).toBeUndefined();
    expect(s.notices()).toContain(PANEL_NOTICE_STALE);
    // The task join vanishes entirely: same refusal.
    s.tasks.length = 0;
    invocation.input("x");
    expect(s.stopped).toEqual([]);
    expect(s.notices().filter((t) => t === PANEL_NOTICE_STALE)).toHaveLength(2);
    invocation.input(ESC);
    await invocation.result;
  });

  it("key-shape change is stale too: an agent-key row that gained a task generation refuses", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a"); // task-less: the row minted an agent: key
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120); // selection: agent:agent-a
    // A background generation is minted for the same agent — the current row
    // key would now be task:task-9, so the stored agent: key is stale.
    s.tasks.push({ id: "task-9", status: "running", agentId: "agent-a" });
    invocation.input("x");
    expect(s.stopped).toEqual([]);
    expect(s.registry.get("agent-a")!.userStopped).toBeUndefined();
    expect(s.controller.dismissedKeyIds()).toEqual([]); // no stale-key dismiss either
    expect(s.notices()).toContain(PANEL_NOTICE_STALE);
    invocation.input(ESC);
    await invocation.result;
  });

  it("x on a running FOREGROUND row shows stop-unavailable (background-only in v1)", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a"); // no task join: a foreground dispatch
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("x");
    expect(s.stopped).toEqual([]);
    expect(s.registry.get("agent-a")!.userStopped).toBeUndefined();
    expect(s.notices()).toContain(PANEL_NOTICE_FOREGROUND);
    invocation.input(ESC);
    await invocation.result;
  });

  it("d dismisses only settled rows and refuses on a running one", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("d"); // running → refuse
    expect(s.notices()).toContain(PANEL_NOTICE_RUNNING_DISMISS);
    expect(s.controller.dismissedKeyIds()).toEqual([]);
    s.registry.markSettled("agent-a", { outcome: "completed" });
    invocation.render(120);
    invocation.input("d"); // settled → dismiss
    expect(s.controller.dismissedKeyIds()).toEqual(["agent:agent-a"]);
    invocation.input(ESC);
    await invocation.result;
  });

  it("stop-all: double press stops every running BACKGROUND agent with full stop semantics; settled and foreground rows stay", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    reg(s.registry, "agent-b");
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    s.tasks.push({ id: "task-2", status: "running", agentId: "agent-b" });
    reg(s.registry, "agent-c", "failure evidence");
    s.tasks.push({ id: "task-3", status: "failed", agentId: "agent-c" });
    s.registry.markSettled("agent-c", { outcome: "failed" });
    reg(s.registry, "agent-d"); // running foreground: never stop-all'd
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("X"); // arms, stops nothing yet
    expect(s.notices()).toContain(panelNoticeStopAllArmed(2));
    expect(s.stopped).toEqual([]);
    invocation.input("X"); // confirms within the window
    expect(s.stopped).toEqual(["task-1", "task-2"]);
    expect(s.registry.get("agent-a")!.userStopped).toBe(true);
    expect(s.registry.get("agent-b")!.userStopped).toBe(true);
    expect(s.registry.get("agent-d")!.userStopped).toBeUndefined(); // foreground untouched
    expect(s.registry.get("agent-c")!.userStopped).toBeUndefined(); // settled untouched
    expect(s.notices()).toContain(panelNoticeStopAllDone(2));
    // The settled FAILED row was never cleared by stop-all.
    expect(invocation.render(160).join("\n")).toContain("failure evidence");
    invocation.input(ESC);
    await invocation.result;
  });

  it("stop-all confirmation expires: a late second press re-arms instead of executing", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("X");
    s.clock.t += STOP_ALL_CONFIRM_MS + 1;
    invocation.input("X"); // window expired → re-arm
    expect(s.stopped).toEqual([]);
    expect(s.notices().filter((t) => t === panelNoticeStopAllArmed(1))).toHaveLength(2);
    invocation.input("X"); // now inside the fresh window → execute
    expect(s.stopped).toEqual(["task-1"]);
    invocation.input(ESC);
    await invocation.result;
  });

  it("stop-all with no running background agents refuses", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    s.registry.markSettled("agent-a", { outcome: "completed" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("X");
    expect(s.notices()).toContain(PANEL_NOTICE_STOP_ALL_NONE);
    expect(s.stopped).toEqual([]);
    invocation.input(ESC);
    await invocation.result;
  });

  it("stop targets the NEWEST running generation after a resume", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    // A resumed agent has multiple task generations; the newest is last.
    s.tasks.push({ id: "task-1", status: "completed", agentId: "agent-a" });
    s.tasks.push({ id: "task-2", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("x");
    expect(s.stopped).toEqual(["task-2"]);
    expect(s.registry.get("agent-a")!.userStopped).toBe(true);
    invocation.input(ESC);
    await invocation.result;
  });

  it("chord after EVERY row's linger expired (none dismissed) still opens and shows the settled rows", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", "kept past expiry");
    s.registry.markSettled("agent-a", { outcome: "completed" });
    reg(s.registry, "agent-b", "failed and expired");
    s.registry.markSettled("agent-b", { outcome: "failed" });
    // Far past both linger tiers: the PASSIVE panel is long gone, but the
    // records still exist — entry must use focused-view (expiry-skipping)
    // semantics, not the passive view's.
    s.clock.t += LINGER_FAILURE_MS * 10;
    const invocation = s.openPanel()!;
    expect(invocation).toBeDefined();
    await invocation.ready;
    const text = invocation.render(160).join("\n");
    expect(text).toContain("kept past expiry");
    expect(text).toContain("failed and expired");
    expect(s.notices()).toEqual([]); // no refusal notice of any kind
    invocation.input(ESC);
    await invocation.result;
  });

  it("focus freeze: no row is evicted while the panel is open, however far the clock advances", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", "lingering result");
    s.registry.markSettled("agent-a", { outcome: "completed" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    s.clock.t += LINGER_FAILURE_MS * 10; // far past every linger tier
    expect(invocation.render(120).join("\n")).toContain("lingering result");
    invocation.input(ESC);
    await invocation.result;
  });

  it("dismissals persist across opens; stale keys are pruned on entry (resume mints a new generation)", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    s.tasks.push({ id: "task-1", status: "completed", agentId: "agent-a" });
    s.registry.markSettled("agent-a", { outcome: "completed" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("x"); // dismiss the settled row
    invocation.input(ESC);
    await invocation.result;
    // Re-entry: the dismissal persisted, so the panel is empty. PINNED
    // everything-dismissed behavior: refuse to open (re-showing rows the user
    // just dismissed would be wrong), with the honest all-dismissed wording —
    // never the "no subagents" notice, which would be a lie here.
    s.openPanel();
    expect(s.pi.customs).toHaveLength(1); // no new component opened
    expect(s.notices()).toContain(PANEL_NOTICE_ALL_DISMISSED);
    expect(s.notices()).not.toContain(PANEL_NOTICE_EMPTY);
    expect(s.controller.dismissedKeyIds()).toEqual(["task:task-1"]);
    // A resume mints a new task generation: the old dismissed key goes stale
    // and entry-time pruning drops it; the resumed agent is visible again.
    reg(s.registry, "agent-a");
    s.tasks.push({ id: "task-2", status: "running", agentId: "agent-a" });
    const reopened = s.openPanel()!;
    await reopened.ready;
    expect(s.controller.dismissedKeyIds()).toEqual([]);
    expect(reopened.render(120).join("\n")).toContain("coder");
    reopened.input(ESC);
    await reopened.result;
  });

  it("prunes agent: keys too — retained while the agent stays task-less, dropped once a generation is minted", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-b"); // task-less agent → agent: key
    s.registry.markSettled("agent-b", { outcome: "completed" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("x"); // dismiss the settled agent-key row
    invocation.input(ESC);
    await invocation.result;
    expect(s.controller.dismissedKeyIds()).toEqual(["agent:agent-b"]);
    // Re-entry while still task-less: the key still names the current row →
    // retained (the dismissal keeps working).
    s.openPanel();
    expect(s.controller.dismissedKeyIds()).toEqual(["agent:agent-b"]);
    // A background generation is minted for the agent: the current row key
    // becomes task:…, the agent: key no longer names any row → pruned.
    s.tasks.push({ id: "task-7", status: "running", agentId: "agent-b" });
    const reopened = s.openPanel()!;
    await reopened.ready;
    expect(s.controller.dismissedKeyIds()).toEqual([]);
    reopened.input(ESC);
    await reopened.result;
  });

  it("a poisoned data join renders empty and CLOSES the component on input instead of wedging it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = focusSetup();
      reg(s.registry, "agent-a");
      const invocation = s.openPanel()!;
      await invocation.ready;
      invocation.render(120);
      s.poison.on = true;
      // Defensive render, no throw — and never an INVISIBLE focus-holder: the
      // catch keeps a plain visible line so Esc discoverability survives.
      expect(invocation.render(120)).toEqual([PANEL_FOCUSED_EMPTY_LINE]);
      invocation.input(KEY_DOWN); // the poisoned view compute closes the component
      await invocation.result; // resolves — the component is not wedged
      expect(invocation.closed).toBe(true);
      await Promise.resolve();
      expect(s.controller.isOpen()).toBe(false);
      expect(s.suppressions).toEqual([true, false]); // widget restored despite the error
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("subagent panel"));
    } finally {
      errors.mockRestore();
    }
  });

  it("Esc stays reachable on the raw byte even when the keybindings surface throws", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    const invocation = s.openPanel()!;
    await invocation.ready;
    s.pi.keymap = new Proxy(
      {},
      {
        get: () => {
          throw new Error("keybindings broken");
        },
      },
    ) as never;
    invocation.input(ESC);
    await invocation.result; // still closes — the raw-byte fallback fired
    expect(invocation.closed).toBe(true);
  });

  it("Enter opens the drill-down for the selected row; Esc steps detail → list → close", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", "verify things", { prompt: "check the tests" });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    const detailText = invocation.render(120).join("\n");
    expect(detailText).toContain("agent-a");
    expect(detailText).toContain("task-1");
    expect(detailText).toContain(detailPromptCollapsed(1));
    expect(detailText).not.toContain(PANEL_HINT_FOCUSED);
    invocation.input(ESC); // detail → list
    expect(invocation.render(120).join("\n")).toContain(PANEL_HINT_FOCUSED);
    invocation.input(ESC); // list → close
    await invocation.result;
    expect(invocation.closed).toBe(true);
  });

  it("typing fills the steer line; Enter sends through the guard's bound steer fn and clears it", async () => {
    const steered: string[] = [];
    const s = focusSetup();
    reg(s.registry, "agent-a", "steer target", {
      prompt: "the prompt",
      session: { steer: (text: string) => void steered.push(text) },
    });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER); // list → detail
    invocation.input("fix the testsX");
    invocation.input(KEY_BACKSPACE); // backspace edits the buffer
    expect(invocation.render(120).join("\n")).toContain(`${DETAIL_STEER_PREFIX}fix the tests`);
    invocation.input(KEY_ENTER); // send
    expect(steered).toEqual(["fix the tests"]);
    const after = invocation.render(120).join("\n");
    expect(after).toContain(DETAIL_STEER_SENT);
    expect(after).not.toContain("fix the tests"); // buffer cleared
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("caps the steer buffer at STEER_INPUT_CAP", async () => {
    const steered: string[] = [];
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, {
      session: { steer: (text: string) => void steered.push(text) },
    });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input("a".repeat(STEER_INPUT_CAP + 50));
    invocation.input(KEY_ENTER);
    expect(steered).toHaveLength(1);
    expect(steered[0]).toHaveLength(STEER_INPUT_CAP);
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("PINNED Esc semantics: a non-empty steer buffer is cleared first, the next Esc steps back", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, { session: { steer: () => undefined } });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input("abc");
    expect(invocation.render(120).join("\n")).toContain(`${DETAIL_STEER_PREFIX}abc`);
    invocation.input(ESC); // clears the buffer, stays in detail
    const cleared = invocation.render(120).join("\n");
    expect(cleared).not.toContain("abc");
    expect(cleared).not.toContain(PANEL_HINT_FOCUSED); // still the detail view
    invocation.input(ESC); // detail → list
    expect(invocation.render(120).join("\n")).toContain(PANEL_HINT_FOCUSED);
    invocation.input(ESC); // list → close
    await invocation.result;
    expect(invocation.closed).toBe(true);
  });

  it("ctrl+x in the drill-down stops a running background agent with t05's paired semantics", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, { session: { steer: () => undefined } });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input(KEY_CTRL_X); // ctrl+x
    expect(s.stopped).toEqual(["task-1"]);
    expect(s.registry.get("agent-a")!.userStopped).toBe(true);
    expect(s.notices()).toContain(panelNoticeStopRequested("coder"));
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("ctrl+x in the drill-down on a foreground agent refuses with the foreground notice", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a"); // no task join: foreground
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input(KEY_CTRL_X);
    expect(s.stopped).toEqual([]);
    expect(s.registry.get("agent-a")!.userStopped).toBeUndefined();
    expect(s.notices()).toContain(PANEL_NOTICE_FOREGROUND);
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("a send racing a user stop surfaces the guard's refusal inline, and nothing is delivered", async () => {
    const steered: string[] = [];
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, {
      session: { steer: (text: string) => void steered.push(text) },
    });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input("keep going");
    s.registry.markUserStopped("agent-a"); // the stop lands before Enter
    invocation.input(KEY_ENTER);
    expect(steered).toEqual([]);
    expect(invocation.render(160).join("\n")).toMatch(/stopped by the user/);
    invocation.input(ESC); // buffer still holds text → cleared
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("typing at an unsteerable (foreground) agent is inert and the unavailability notice names the alternative", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a"); // running foreground: no session handle
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(160);
    invocation.input(KEY_ENTER);
    invocation.input("abc"); // never silently buffered
    const text = invocation.render(160).join("\n");
    expect(text).not.toContain("abc");
    expect(text).toContain(detailSteerUnavailable("foreground agent"));
    expect(text).toContain(DETAIL_FOREGROUND_ALT);
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("settling while the drill-down is open banners and shows the final answer; resuming banners back to live", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, { session: { steer: () => undefined } });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    s.tasks[0]!.status = "completed";
    s.registry.markSettled("agent-a", {
      outcome: "completed",
      finalText: "the settled final answer",
    });
    const settled = invocation.render(120).join("\n");
    expect(settled).toContain(DETAIL_BANNER_SETTLED);
    expect(settled).toContain(DETAIL_FINAL_LABEL);
    expect(settled).toContain("the settled final answer");
    s.registry.markResuming("agent-a");
    expect(invocation.render(120).join("\n")).toContain(DETAIL_BANNER_RESUMED);
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("a poisoned join while the drill-down is open renders the vanished banner instead of crashing", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, { session: { steer: () => undefined } });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    s.poison.on = true;
    const text = invocation.render(120).join("\n");
    expect(text).toContain(DETAIL_BANNER_VANISHED);
    s.poison.on = false;
    invocation.input(ESC); // still escapable
    invocation.input(ESC);
    await invocation.result;
    expect(invocation.closed).toBe(true);
  });

  it("scrolls the tail: up anchors, incoming lines don't yank, bottom re-engages follow", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, { session: { steer: () => undefined } });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const tail = (n: number) =>
      Array.from({ length: n }, (_, i) => `tail line ${String(i + 1).padStart(2, "0")}`);
    s.registry.noteProgress("agent-a", { tail: [], activity: "" }, tail(30));
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(200);
    invocation.input(KEY_ENTER);
    expect(invocation.render(200).join("\n")).toContain("tail line 30"); // following
    invocation.input(KEY_UP);
    const scrolled = invocation.render(200).join("\n");
    expect(scrolled).not.toContain("tail line 30");
    expect(scrolled).toContain("tail line 18");
    // New content arrives while scrolled back: the window stays anchored.
    s.registry.noteProgress("agent-a", { tail: [], activity: "" }, tail(31));
    const anchored = invocation.render(200).join("\n");
    expect(anchored).toContain("tail line 18");
    expect(anchored).not.toContain("tail line 31");
    // Scrolling back to the bottom re-engages follow.
    invocation.input(KEY_DOWN);
    invocation.render(200);
    invocation.input(KEY_DOWN);
    expect(invocation.render(200).join("\n")).toContain("tail line 31");
    s.registry.noteProgress("agent-a", { tail: [], activity: "" }, tail(32));
    expect(invocation.render(200).join("\n")).toContain("tail line 32"); // following again
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("ctrl+p toggles the prompt open and closed inside the drill-down", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, {
      prompt: "first line\nsecond line\nthird line",
      session: { steer: () => undefined },
    });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    expect(invocation.render(120).join("\n")).toContain(detailPromptCollapsed(3));
    expect(invocation.render(120).join("\n")).not.toContain("second line");
    invocation.input(KEY_CTRL_P); // ctrl+p → expand
    const expanded = invocation.render(120).join("\n");
    expect(expanded).toContain(DETAIL_PROMPT_EXPANDED);
    expect(expanded).toContain("second line");
    invocation.input(KEY_CTRL_P); // ctrl+p → collapse
    expect(invocation.render(120).join("\n")).toContain(detailPromptCollapsed(3));
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("subscribes for live repaints only while the drill-down is open (unsubscribed on view exit)", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, { session: { steer: () => undefined } });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    const inDetail = s.pi.renderRequests;
    reg(s.registry, "agent-b"); // registry change while the detail is open
    expect(s.pi.renderRequests).toBeGreaterThan(inDetail);
    invocation.input(ESC); // detail → list releases the subscription
    const afterExit = s.pi.renderRequests;
    reg(s.registry, "agent-c");
    expect(s.pi.renderRequests).toBe(afterExit);
    invocation.input(ESC);
    await invocation.result;
  });

  it("dispose releases the drill-down subscription (the leak-capable path — no Esc ever ran)", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, { session: { steer: () => undefined } });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER); // detail open: subscription taken
    const inDetail = s.pi.renderRequests;
    reg(s.registry, "agent-b");
    expect(s.pi.renderRequests).toBeGreaterThan(inDetail); // live before dispose
    // Pi calls dispose() when the component closes for ANY reason (fake-pi
    // mirrors this) — with the detail still open, dispose is the only thing
    // standing between the subscription and a session-long leak.
    invocation.component!.dispose!();
    const afterDispose = s.pi.renderRequests;
    reg(s.registry, "agent-c");
    expect(s.pi.renderRequests).toBe(afterDispose);
  });

  it("settling with a long tail top-anchors onto the final answer; resuming re-follows the newest line", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, { session: { steer: () => undefined } });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const tail = (n: number) =>
      Array.from({ length: n }, (_, i) => `tail line ${String(i + 1).padStart(2, "0")}`);
    // ~30 body lines so the 12-row viewport makes the anchor writes visible.
    s.registry.noteProgress("agent-a", { tail: [], activity: "" }, tail(30));
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(200);
    invocation.input(KEY_ENTER);
    expect(invocation.render(200).join("\n")).toContain("tail line 30"); // following
    s.tasks[0]!.status = "completed";
    s.registry.markSettled("agent-a", {
      outcome: "completed",
      finalText: "the settled final answer",
    });
    // The settle transition wrote follow=false/scrollTop=0: with 30 tail
    // lines below, the answer is visible ONLY because the view re-anchored.
    const settled = invocation.render(200).join("\n");
    expect(settled).toContain(DETAIL_BANNER_SETTLED);
    expect(settled).toContain(DETAIL_FINAL_LABEL);
    expect(settled).toContain("the settled final answer");
    expect(settled).not.toContain("tail line 30");
    s.registry.markResuming("agent-a");
    const resumed = invocation.render(200).join("\n");
    expect(resumed).toContain(DETAIL_BANNER_RESUMED);
    expect(resumed).toContain("tail line 30"); // re-follow: newest tail visible
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("an async steer rejection replaces the optimistic sent notice with the failure notice", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, {
      session: { steer: () => Promise.reject(new Error("pipe broke")) },
    });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input("go left");
    invocation.input(KEY_ENTER); // send: the optimistic notice shows first
    expect(invocation.render(120).join("\n")).toContain(DETAIL_STEER_SENT);
    await new Promise((resolve) => setImmediate(resolve)); // let the rejection land
    const after = invocation.render(120).join("\n");
    expect(after).toContain(detailSteerFailed("pipe broke"));
    expect(after).not.toContain(DETAIL_STEER_SENT);
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("a synchronously throwing steer surfaces the failure notice inline", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, {
      session: {
        steer: () => {
          throw new Error("sync boom");
        },
      },
    });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input("go right");
    invocation.input(KEY_ENTER);
    const after = invocation.render(120).join("\n");
    expect(after).toContain(detailSteerFailed("sync boom"));
    expect(after).not.toContain(DETAIL_STEER_SENT);
    invocation.input(ESC); // the sync-throw path kept the buffer → cleared first
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("a rejection landing after exit-and-re-enter never bleeds into the new detail state", async () => {
    let rejectSteer!: (err: unknown) => void;
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, {
      session: {
        steer: () =>
          new Promise((_resolve, reject) => {
            rejectSteer = reject;
          }),
      },
    });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input("go");
    invocation.input(KEY_ENTER); // send: rejection still pending
    invocation.input(ESC); // detail → list detaches the old DetailState
    invocation.input(KEY_ENTER); // re-enter: a NEW DetailState
    rejectSteer(new Error("late failure"));
    await new Promise((resolve) => setImmediate(resolve));
    const text = invocation.render(120).join("\n");
    expect(text).not.toContain(detailSteerFailed("late failure"));
    expect(text).not.toContain("steer failed");
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("a pasted multi-line chunk flattens into the buffer; lone keys and chords keep their meanings", async () => {
    const steered: string[] = [];
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, {
      prompt: "the one prompt line",
      session: { steer: (text: string) => void steered.push(text) },
    });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    const steerLine = () => invocation.render(120).find((l) => l.startsWith(DETAIL_STEER_PREFIX))!;
    invocation.input("\n"); // a LONE \n is the send key, never buffer text
    expect(steered).toEqual([]); // empty buffer → nothing sent
    expect(steerLine()).toBe(DETAIL_STEER_PREFIX); // and nothing buffered
    invocation.input("line one\nline two"); // pasted chunk: flattened, buffered
    expect(steerLine()).toBe(`${DETAIL_STEER_PREFIX}line one line two`);
    invocation.input(KEY_CTRL_P); // ctrl chords unchanged: still the prompt toggle
    expect(invocation.render(120).join("\n")).toContain(DETAIL_PROMPT_EXPANDED);
    expect(steerLine()).toBe(`${DETAIL_STEER_PREFIX}line one line two`);
    invocation.input(KEY_ENTER); // send delivers the flattened text
    expect(steered).toEqual(["line one line two"]);
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("never opens outside TUI mode, even from a hand-rolled caller", () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    s.controller.open(s.pi.printCtx() as never);
    s.controller.open(s.pi.rpcCtx() as never);
    expect(s.pi.customs).toHaveLength(0);
    expect(s.suppressions).toEqual([]);
  });
});

describe("panel focus (offline integration: fake-pi + fake-sdk)", () => {
  let dir: string;
  const originalCwd = process.cwd();
  const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

  beforeAll(() => {
    dir = materializeFixture("hello-claude");
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
    await pi.waitForTools(["Agent", "SendMessage"]);
    return { pi, internals };
  }

  function settlements(pi: FakePi): string[] {
    return pi.messages
      .filter((m) => m.message?.customType === "picc-settlement")
      .map((m) => String(m.message.content));
  }

  async function dispatchBackground(
    pi: FakePi,
    id: string,
  ): Promise<{ taskId: string; agentId: string }> {
    const started = await pi.tools.get("Agent").execute(id, {
      subagent_type: "general-purpose",
      prompt: "GO",
      run_in_background: true,
    });
    return { taskId: String(started.details.taskId), agentId: String(started.details.agentId) };
  }

  it("chord → component; x applies the paired stop; the model gets the NORMAL aborted settlement notice; resume refused", async () => {
    const gate = new Promise<void>(() => {}); // never resolves — only abort ends the run
    const handle = fakeSdk({ replies: [{ text: "never delivered", gate }] });
    const { pi, internals } = await boot(handle);
    try {
      await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
      const { taskId, agentId } = await dispatchBackground(pi, "t1");
      await handle.waitForPromptCalls(1);

      const shortcut = pi.shortcuts.get(PANEL_ENTRY_CHORD)!;
      expect(shortcut.description).toBe("Open the subagent status panel");
      shortcut.handler(pi.tuiCtx());
      const invocation = pi.customs[0]!;
      await invocation.ready;
      // The passive widget is suppressed while the focused panel is open.
      expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(false);
      expect(invocation.render(120).join("\n")).toContain("general-purpose");

      invocation.input("x");
      expect(internals.backgroundTasks.get(taskId)!.status).toBe("stopped");
      expect(internals.backgroundTasks.get(taskId)!.userStopped).toBe(true);
      expect(internals.subagentRegistry.get(agentId)!.userStopped).toBe(true);
      await waitUntil({
        description: "the stopped dispatch to settle in the registry",
        predicate: () => internals.subagentRegistry.get(agentId)?.state === "settled",
        describeObserved: () => `state: ${internals.subagentRegistry.get(agentId)?.state}`,
      });

      // User-stop permanence: the model cannot silently resume the agent.
      await expect(
        pi.tools.get("SendMessage").execute("s", { to: agentId, message: "resume" }),
      ).rejects.toThrow(/stopped by the user/i);

      // The NORMAL settlement machinery delivers the aborted notice — the
      // panel stop is model-visible exactly like any other abort.
      await pi.fire("before_agent_start", { systemPrompt: "B" });
      const delivered = settlements(pi);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain("settled: aborted");
      // The chat-record junction: the same message's `details` drive the
      // REGISTERED picc-settlement renderer to the user-stop record line.
      const message = pi.messages.find((m) => m.message?.customType === "picc-settlement")!.message;
      const renderer = pi.messageRenderers.get("picc-settlement")!;
      const recordLine = renderer(message, { expanded: false }, undefined)!.render(120).join("\n");
      expect(recordLine).toContain("stopped by user");

      // Esc closes; the suppression is released and the widget reinstalls
      // (the stopped row is still lingering).
      invocation.input(ESC);
      await invocation.result;
      await waitUntil({
        description: "the passive widget to reinstall after the panel closes",
        predicate: () => pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY),
        describeObserved: () => `widget keys: ${[...pi.widgets.keys()].join(", ")}`,
      });
    } finally {
      internals.subagentPanel.setSuppressed(true);
    }
  });

  it("dismissing a settled row is invisible to the model: settlement delivery is untouched", async () => {
    const handle = fakeSdk({ replies: ["all done"] });
    const { pi, internals } = await boot(handle);
    try {
      await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
      const { taskId, agentId } = await dispatchBackground(pi, "t1");
      await waitUntil({
        description: "the dispatched agent to settle",
        predicate: () => internals.subagentRegistry.get(agentId)?.state === "settled",
        describeObserved: () => `state: ${internals.subagentRegistry.get(agentId)?.state}`,
      });

      pi.shortcuts.get(PANEL_ENTRY_CHORD)!.handler(pi.tuiCtx());
      const invocation = pi.customs[0]!;
      await invocation.ready;
      invocation.render(120);
      invocation.input("x"); // re-resolves to a settled row → dismiss
      expect(invocation.render(120).join("\n")).toContain(PANEL_FOCUSED_EMPTY_LINE);

      // Nothing model-facing changed: task record, user-stop markers, and the
      // settlement-notice gate are all exactly as before the dismiss.
      expect(internals.backgroundTasks.get(taskId)!.status).toBe("completed");
      expect(internals.backgroundTasks.get(taskId)!.userStopped).toBeUndefined();
      expect(internals.subagentRegistry.get(agentId)!.userStopped).toBeUndefined();
      expect(internals.subagentRegistry.isSettledNoticeArmed(agentId)).toBe(true);

      await pi.fire("before_agent_start", { systemPrompt: "B" });
      const delivered = settlements(pi);
      expect(delivered).toHaveLength(1); // the notice still arrives, exactly once
      expect(delivered[0]).toContain("settled: completed");

      invocation.input(ESC);
      await invocation.result;
      await Promise.resolve(); // let the close cleanup (suppression release) settle
      // The passive widget consumes the dismissed set: the dismissed (and
      // only) row must NOT re-appear after the panel closes.
      expect(pi.widgets.has(SUBAGENT_PANEL_WIDGET_KEY)).toBe(false);
    } finally {
      internals.subagentPanel.setSuppressed(true);
    }
  });

  it("drill-down steer reaches session.steer and NEVER fires UserPromptSubmit hooks (pinned PiCC decision)", async () => {
    const gate = new Promise<void>(() => {}); // held open — the agent stays steerable
    const handle = fakeSdk({ replies: [{ text: "unused", gate }] });
    const { pi, internals } = await boot(handle);
    const hookFire = vi.spyOn(HookRunner.prototype, "fire");
    try {
      await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
      await dispatchBackground(pi, "t1");
      await handle.waitForPromptCalls(1);

      pi.shortcuts.get(PANEL_ENTRY_CHORD)!.handler(pi.tuiCtx());
      const invocation = pi.customs[0]!;
      await invocation.ready;
      invocation.render(120);
      invocation.input(KEY_ENTER); // list → drill-down
      invocation.input("focus on the failing test");
      invocation.input(KEY_ENTER); // send
      expect(handle.sessions[0]!.steerMessages).toEqual(["focus on the failing test"]);
      expect(invocation.render(120).join("\n")).toContain(DETAIL_STEER_SENT);
      // Steer text bypasses UserPromptSubmit — the hook runner is never invoked.
      expect(hookFire.mock.calls.filter(([event]) => event === "UserPromptSubmit")).toEqual([]);

      invocation.input(ESC);
      invocation.input(ESC);
      await invocation.result;
    } finally {
      hookFire.mockRestore();
      internals.subagentPanel.setSuppressed(true);
    }
  });

  it("stop-all mass-stops every running background agent with per-agent permanence; the fan-out hint fired once", async () => {
    const never = new Promise<void>(() => {});
    const handle = fakeSdk({
      replies: [
        { text: "a", gate: never },
        { text: "b", gate: never },
      ],
    });
    const { pi, internals } = await boot(handle);
    try {
      await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
      const first = await dispatchBackground(pi, "t1");
      const second = await dispatchBackground(pi, "t2");
      await handle.waitForPromptCalls(2);

      // The one-time status-line hint fired once when the fan-out reached 2
      // agents, naming the real chord.
      const hints = pi.notifications.filter((n) => n.text === panelHintText(2, PANEL_ENTRY_CHORD));
      expect(hints).toHaveLength(1);

      pi.shortcuts.get(PANEL_ENTRY_CHORD)!.handler(pi.tuiCtx());
      const invocation = pi.customs[0]!;
      await invocation.ready;
      invocation.render(120);

      invocation.input("X"); // arms only
      expect(internals.backgroundTasks.get(first.taskId)!.status).toBe("running");
      expect(internals.backgroundTasks.get(second.taskId)!.status).toBe("running");
      invocation.input("X"); // confirms
      for (const { taskId, agentId } of [first, second]) {
        expect(internals.backgroundTasks.get(taskId)!.status).toBe("stopped");
        expect(internals.backgroundTasks.get(taskId)!.userStopped).toBe(true);
        expect(internals.subagentRegistry.get(agentId)!.userStopped).toBe(true);
      }
      await waitUntil({
        description: "both mass-stopped dispatches to settle",
        predicate: () =>
          internals.subagentRegistry.get(first.agentId)?.state === "settled" &&
          internals.subagentRegistry.get(second.agentId)?.state === "settled",
        describeObserved: () =>
          `states: ${internals.subagentRegistry.get(first.agentId)?.state}, ${internals.subagentRegistry.get(second.agentId)?.state}`,
      });
      // Resume is refused for EVERY mass-stopped agent.
      for (const { agentId } of [first, second]) {
        await expect(
          pi.tools.get("SendMessage").execute("s", { to: agentId, message: "resume" }),
        ).rejects.toThrow(/stopped by the user/i);
      }

      invocation.input(ESC);
      await invocation.result;
    } finally {
      internals.subagentPanel.setSuppressed(true);
    }
  });

  it("print-mode session with a multi-agent fan-out emits NO discovery hint (real wiring, not just the emitter)", async () => {
    const never = new Promise<void>(() => {});
    const handle = fakeSdk({
      replies: [
        { text: "a", gate: never },
        { text: "b", gate: never },
      ],
    });
    const { pi } = await boot(handle);
    // session_start with a PRINT ctx: the hint ui is never captured, so the
    // once-gate must not fire (and must not be consumed) despite 2 running agents.
    await pi.fire("session_start", { reason: "startup" }, pi.printCtx());
    await dispatchBackground(pi, "t1");
    await dispatchBackground(pi, "t2");
    await handle.waitForPromptCalls(2);
    expect(pi.notifications.filter((n) => n.text.includes("press"))).toEqual([]);
  });

  it("chord with no subagents this session: notice only, no component, widget untouched", async () => {
    const handle = fakeSdk({ replies: ["unused"] });
    const { pi } = await boot(handle);
    await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
    pi.shortcuts.get(PANEL_ENTRY_CHORD)!.handler(pi.tuiCtx());
    expect(pi.customs).toHaveLength(0);
    expect(pi.notifications.map((n) => n.text)).toContain(PANEL_NOTICE_EMPTY);
  });
});

describe("panel Esc layering with the typed-fork watch (offline integration)", () => {
  let dir: string;
  const originalCwd = process.cwd();
  const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

  beforeAll(() => {
    dir = materializeFixture("full-surface");
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

  it("UNCONDITIONAL Esc layering: with the fork-Esc watch live AND the panel open, Esc closes the panel and never fires the fork abort", async () => {
    type Internals = Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];
    const gate = new Promise<void>(() => {}); // held open until the fork is aborted
    const handle = fakeSdk({ replies: [{ text: "fork result", gate }] });
    const pi = fakePi();
    let internals!: Internals;
    picc(pi.api as never, {
      sdk: handle.sdk,
      onWired: (i) => (internals = i),
      onInitializationSettled: pi.captureInitialization,
    });
    await pi.waitForInitialization();
    await pi.waitForTools(["Agent"]);

    // A typed /forked-skill in TUI mode subscribes the raw fork-Esc watch.
    const pending = pi.fire("input", { text: "/fork-research x", source: "interactive" }, pi.tuiCtx());
    pending.catch(() => {});
    await waitUntil({
      description: "the typed-fork Esc watch to be subscribed",
      predicate: () => pi.terminalInputHandlers.length > 0,
      describeObserved: () => `handlers: ${pi.terminalInputHandlers.length}`,
    });
    await waitUntil({
      description: "the fork dispatch to register its agent (panel rows exist)",
      predicate: () => internals.subagentRegistry.list().length > 0,
      describeObserved: () => `records: ${internals.subagentRegistry.list().length}`,
    });

    pi.shortcuts.get(PANEL_ENTRY_CHORD)!.handler(pi.tuiCtx());
    const invocation = pi.customs[0]!;
    await invocation.ready;

    // A lone ESC through the raw listener chain, exactly as pi-tui feeds it:
    // while the panel is open the fork watch must PASS the byte through…
    const fed = pi.feedTerminalInput(ESC);
    expect(fed).toEqual({ consumed: false, data: ESC });
    expect(handle.abortCalls()).toBe(0); // the fork abort did NOT fire
    // …and pi-tui then routes the unconsumed byte to the focused component.
    invocation.input(fed.data);
    await invocation.result; // the panel's own done() — Esc closed the panel
    expect(invocation.closed).toBe(true);
    await Promise.resolve(); // let the close cleanup settle

    // Panel closed: the watch owns the lone Esc again and cancels the fork.
    expect(pi.feedTerminalInput(ESC)).toEqual({ consumed: true, data: ESC });
    const out = await pending;
    expect(out.action).toBe("transform");
    expect(out.text).toContain("did not finish");
    expect(handle.abortCalls()).toBeGreaterThan(0);
  });
});

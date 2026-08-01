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
  DETAIL_BANNER_FAILED,
  DETAIL_BANNER_RESUMED,
  DETAIL_BANNER_SETTLED,
  DETAIL_BANNER_STOPPED,
  DETAIL_BANNER_VANISHED,
  DETAIL_FINAL_LABEL,
  DETAIL_FOREGROUND_ALT,
  DETAIL_NO_ACTIVITY,
  DETAIL_NO_DISCARDED_OUTPUT,
  DETAIL_NO_FINAL_ANSWER,
  DETAIL_NO_PARTIAL_OUTPUT,
  DETAIL_PARTIAL_LABEL,
  DETAIL_DISCARDED_LABEL,
  DETAIL_PROMPT_EXPANDED,
  DETAIL_STEER_PREFIX,
  DETAIL_STEER_SENT,
  DETAIL_WAITING,
  detailHint,
  detailPromptCollapsed,
  detailSteerFailed,
  detailSteerUnavailable,
  formatElapsed,
  PANEL_GLYPH_FAILED,
  PANEL_GLYPH_STOPPED,
  PANEL_GLYPH_WAITING,
  PANEL_GLYPH_SUCCESS,
  PANEL_HINT_FOCUSED,
  PANEL_MIN_ROW_WIDTH,
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
  assistantTextFingerprint,
  sanitizeDetailScalar,
  type SubagentDetailEntry,
} from "../src/runtime/subagent-progress.js";
import {
  AGENT_COLOR_NAMES,
  normalizeAgentColor,
  SubagentRegistry,
  type RegisterInput,
  type SubagentRegistryRecord,
} from "../src/runtime/subagent-registry.js";
import { HookRunner } from "../src/engine/hook-runner.js";
import {
  createPanelHintEmitter,
  panelAgentCounts,
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
  PANEL_NOTICE_RESIZE_ACTION,
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
const ANSI_RE = /\x1b\[[0-9;]*m/gu;
const stripAnsi = (value: string): string => value.replace(ANSI_RE, "");

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

  it("preserves active sibling start order across waiting/admitted state, then groups settled rows", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    const v = view(model, [
      rec({ agentId: "settled", startedAt: 0, state: "settled", outcome: "completed", settledAt: 50 }),
      rec({ agentId: "waiting-1", startedAt: 1, admission: "waiting" }),
      rec({ agentId: "admitted", startedAt: 10 }),
      rec({ agentId: "child-waiting", parentAgentId: "admitted", startedAt: 11, admission: "waiting" }),
      rec({ agentId: "waiting-2", startedAt: 1, admission: "waiting" }),
    ]);
    expect(v.rows.map((r) => r.agentId)).toEqual([
      "waiting-1",
      "waiting-2",
      "admitted",
      "child-waiting",
      "settled",
    ]);
    expect(v.rows.map((r) => r.treeDepth)).toEqual([0, 0, 0, 1, 0]);
  });

  it("preserves active sibling start order before settled siblings under one parent", () => {
    const clock = { t: 100 };
    const parentId = "agent-parent";
    const model = makeModel(clock);
    const v = view(model, [
      rec({ agentId: parentId, startedAt: 0 }),
      rec({
        agentId: "child-settled",
        parentAgentId: parentId,
        state: "settled",
        outcome: "completed",
        settledAt: 90,
      }),
      rec({ agentId: "child-waiting", parentAgentId: parentId, admission: "waiting" }),
      rec({ agentId: "child-admitted", parentAgentId: parentId }),
    ]);
    expect(v.rows.map((row) => [row.agentId, row.treeDepth])).toEqual([
      [parentId, 0],
      ["child-waiting", 1],
      ["child-admitted", 1],
      ["child-settled", 1],
    ]);
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

  it("classifies admission as waiting, treats absent admission as admitted, and counts separately", () => {
    const clock = { t: 5000 };
    const model = makeModel(clock);
    const v = view(model, [
      rec({ agentId: "agent-run", startedAt: 1000 }),
      rec({ agentId: "agent-wait", startedAt: 500, admission: "waiting" }),
    ]);
    expect(v.rows.map((row) => [row.agentId, row.state])).toEqual([
      ["agent-wait", "waiting"],
      ["agent-run", "running"],
    ]);
    expect(v).toMatchObject({ runningCount: 1, waitingCount: 1, settledCount: 0 });
    expect(v.rows[0]?.elapsedMs).toBe(4500);
  });

  it("task-side stopped overrides a still-running queued dispatch, freezes, and expires during cleanup", () => {
    const clock = { t: 10_000 };
    const model = makeModel(clock);
    const record = rec({ agentId: "agent-wait", startedAt: 1000, admission: "waiting" });
    const tasks: PanelTaskInfo[] = [{
      id: "task-wait",
      status: "stopped",
      admission: "waiting",
      agentId: "agent-wait",
      settledAt: 7000,
    }];
    const v = view(model, [record], { tasks });
    expect(v.rows[0]).toMatchObject({ state: "stopped", elapsedMs: 6000 });
    expect(v).toMatchObject({ runningCount: 0, waitingCount: 0, settledCount: 1 });
    clock.t = 7000 + LINGER_FAILURE_MS;
    expect(view(model, [record], { tasks }).empty).toBe(true);
  });

  it("keeps task stop time authoritative after the dispatch registry settles later", () => {
    const clock = { t: 55_000 };
    const model = makeModel(clock);
    const record = rec({
      agentId: "agent-stopped",
      startedAt: 1000,
      state: "settled",
      outcome: "completed",
      settledAt: 50_000,
    });
    const tasks: PanelTaskInfo[] = [{
      id: "task-stopped",
      status: "stopped",
      agentId: "agent-stopped",
      settledAt: 7000,
    }];
    expect(view(model, [record], { tasks }).rows[0]).toMatchObject({
      state: "stopped",
      elapsedMs: 6000,
    });
    clock.t = 7000 + LINGER_FAILURE_MS;
    expect(view(model, [record], { tasks }).empty).toBe(true);
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
    expect(byId.get("agent-a")).not.toHaveProperty("activity");
    expect(byId.get("agent-b")?.activity).toEqual({ kind: "status", text: "Working…" });
    expect(byId.get("agent-c")?.activity).toEqual({ kind: "status", text: "Starting agent…" });
  });

  it("projects copied live activity with waiting precedence and omits it from terminal rows", () => {
    const captured = { kind: "tool" as const, tool: "Read", detail: "src/index.ts" };
    const v = view(makeModel({ t: 100 }), [
      rec({ agentId: "captured", liveActivity: captured }),
      rec({ agentId: "waiting", admission: "waiting", liveActivity: captured, startedAt: 1 }),
      rec({ agentId: "with-progress", progress: { tail: [], activity: "legacy" }, startedAt: 2 }),
      rec({ agentId: "startup", startedAt: 3 }),
      rec({
        agentId: "terminal", state: "settled", outcome: "failed", settledAt: 90,
        liveActivity: { kind: "status", text: "stale" }, startedAt: 4,
      }),
    ]);
    const byId = new Map(v.rows.map((row) => [row.agentId, row]));
    expect(byId.get("captured")?.activity).toEqual(captured);
    expect(byId.get("captured")?.activity).not.toBe(captured);
    expect(byId.get("waiting")?.activity).toEqual({ kind: "status", text: "Waiting for capacity" });
    expect(byId.get("with-progress")?.activity).toEqual({ kind: "status", text: "Working…" });
    expect(byId.get("startup")?.activity).toEqual({ kind: "status", text: "Starting agent…" });
    expect(byId.get("terminal")).not.toHaveProperty("activity");
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

  it("keeps the row bound and aggregate counts when more than MAX_PANEL_ROWS include waiters", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    const records = Array.from({ length: MAX_PANEL_ROWS + 4 }, (_, index) =>
      rec({
        agentId: `agent-${index}`,
        startedAt: index,
        admission: index >= 3 ? "waiting" : "admitted",
      }));
    const v = view(model, records);
    expect(v.rows).toHaveLength(MAX_PANEL_ROWS);
    expect(v).toMatchObject({
      totalRows: MAX_PANEL_ROWS + 4,
      hiddenBelow: 4,
      runningCount: 3,
      waitingCount: MAX_PANEL_ROWS + 1,
    });
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

describe("responsive panel table", () => {
  const ASSISTANT_CANARY = "ASSISTANT_STREAM_CANARY";
  const rowsOnly = (lines: string[]) => lines.filter((line) =>
    !line.includes("agent panel") && !line.includes("└ ")
  );

  function mixedView(widthRows = 8): PanelViewModel {
    const clock = { t: 12_000 };
    const model = makeModel(clock, widthRows);
    return view(model, [
      rec({
        agentId: "agent-a", agentName: "coder", description: "build frontend", color: "red",
        liveActivity: { kind: "assistant", text: ASSISTANT_CANARY },
        progress: { tail: [], activity: "LEGACY_ACTIVITY_MUST_NOT_RENDER", usage: {
          inputTokens: 119219, outputTokens: 4936, cacheReadTokens: 80,
          cacheWriteTokens: 20, costUsd: 1.082095,
        } },
      }),
      rec({
        agentId: "agent-b", agentName: "reviewer", description: "review changes", startedAt: 2_000,
        progress: { tail: [], activity: "", usage: { outputTokens: 7, costUsd: 0.005 } },
      }),
      rec({ agentId: "agent-c", agentName: "tester", description: "run checks", startedAt: 4_000 }),
    ], { tasks: [
      { id: "task-secret-a", status: "running", agentId: "agent-a" },
      { id: "task-secret-b", status: "running", agentId: "agent-b" },
    ] });
  }

  it("renders stable semantic activity lines and preserves active block positions across admission", () => {
    const clock = { t: 100 };
    const model = makeModel(clock);
    const records = [
      rec({ agentId: "wait", agentName: "waiter", admission: "waiting", startedAt: 0, liveActivity: { kind: "tool", tool: "ignored" } }),
      rec({ agentId: "tool", agentName: "tooler", startedAt: 1, liveActivity: { kind: "tool", tool: "Read", detail: "src/index.ts" } }),
      rec({ agentId: "reason", startedAt: 2, liveActivity: { kind: "reasoning", text: "checking invariants" } }),
      rec({ agentId: "assistant", startedAt: 3, liveActivity: { kind: "assistant", text: ASSISTANT_CANARY } }),
      rec({ agentId: "output", startedAt: 4, liveActivity: { kind: "output", text: "command output" } }),
      rec({ agentId: "status", startedAt: 5, liveActivity: { kind: "status", text: "waiting: API retry 2/3" } }),
    ];
    const fg = vi.fn((_slot: string, text: string) => `${ESC}[36m${text}${ESC}[39m`);
    const italic = vi.fn((text: string) => `${ESC}[3m${text}${ESC}[23m`);
    const before = renderSubagentPanel(view(model, records), {
      width: 100, entryChord: CHORD, theme: { fg, italic },
    });
    const plainBefore = before.map(stripAnsi);
    expect(plainBefore.filter((line) => line.includes("└ "))).toHaveLength(records.length);
    expect(plainBefore.join("\n")).toContain("└ Waiting for capacity");
    expect(plainBefore.join("\n")).toContain("└ Read src/index.ts");
    expect(plainBefore.join("\n")).toContain(ASSISTANT_CANARY);
    expect(fg).toHaveBeenCalledWith("text", "Read");
    expect(fg).toHaveBeenCalledWith("accent", "src/index.ts");
    expect(fg).toHaveBeenCalledWith("text", ASSISTANT_CANARY);
    expect(fg).toHaveBeenCalledWith("text", "command output");
    expect(fg).toHaveBeenCalledWith("muted", "waiting: API retry 2/3");
    expect(italic).toHaveBeenCalledWith("checking invariants");
    const focusedActivity = renderSubagentPanel(view(model, records, { focused: true }), {
      width: 100, entryChord: CHORD,
    }).map(stripAnsi).filter((line) => line.includes("└ ")).map((line) => line.slice(line.indexOf("└ ")));
    const passiveActivity = plainBefore.filter((line) => line.includes("└ ")).map((line) => line.slice(line.indexOf("└ ")));
    expect(focusedActivity).toEqual(passiveActivity);

    records[0] = rec({ agentId: "wait", agentName: "waiter", admission: "admitted", startedAt: 0, progress: { tail: [], activity: "" } });
    const after = renderSubagentPanel(view(model, records), { width: 100, entryChord: CHORD }).map(stripAnsi);
    expect(after).toHaveLength(plainBefore.length);
    expect(after[0]).toContain("waiter");
    expect(after[1]).toContain("Working…");
    expect(after[2]).toContain("tooler");
  });

  it("normalizes only exact reasoning bold edges after sanitization", () => {
    const records = [
      rec({ agentId: "completed", startedAt: 0, liveActivity: { kind: "reasoning", text: "**Planning inspection**" } }),
      rec({ agentId: "opening", startedAt: 1, liveActivity: { kind: "reasoning", text: "**Streaming plan" } }),
      rec({ agentId: "closing", startedAt: 2, liveActivity: { kind: "reasoning", text: "Streaming close**" } }),
      rec({ agentId: "ordinary", startedAt: 3, liveActivity: { kind: "reasoning", text: "ordinary **internal** text" } }),
      rec({ agentId: "assistant-stars", startedAt: 4, liveActivity: { kind: "assistant", text: "**assistant**" } }),
      rec({ agentId: "output-stars", startedAt: 5, liveActivity: { kind: "output", text: "**output**" } }),
      rec({ agentId: "status-stars", startedAt: 6, liveActivity: { kind: "status", text: "**status**" } }),
      rec({ agentId: "tool-stars", startedAt: 7, liveActivity: { kind: "tool", tool: "**Read**", detail: "**file**" } }),
    ];
    const activities = renderSubagentPanel(view(makeModel({ t: 100 }), records), {
      width: 100, entryChord: CHORD,
    }).map(stripAnsi).filter((line) => line.includes("└ "))
      .map((line) => line.slice(line.indexOf("└ ") + 2));

    expect(activities).toEqual([
      "Planning inspection",
      "Streaming plan",
      "Streaming close",
      "ordinary **internal** text",
      "**assistant**",
      "**output**",
      "**status**",
      "**Read** **file**",
    ]);

    const fg = vi.fn((_color: string, text: string) => text);
    const italic = vi.fn((text: string) => text);
    const markerOnly = view(makeModel({ t: 100 }), [rec({
      agentId: "marker-only", liveActivity: { kind: "reasoning", text: "**" },
    })]);
    const markerLines = renderSubagentPanel(markerOnly, {
      width: 80, entryChord: CHORD, theme: { fg, italic },
    }).map(stripAnsi);
    expect(markerLines).toHaveLength(3);
    expect(markerLines[1]).toBe("  └ Working…");
    expect(markerLines.join("\n")).not.toContain("**");
    expect(fg).toHaveBeenCalledWith("muted", "Working…");
    expect(italic).not.toHaveBeenCalled();

    const waitingMarkerOnly = view(makeModel({ t: 100 }), [rec({
      agentId: "waiting-marker-only", admission: "waiting",
    })]);
    waitingMarkerOnly.rows[0]!.activity = { kind: "reasoning", text: "**" };
    expect(stripAnsi(renderSubagentPanel(waitingMarkerOnly, {
      width: 80, entryChord: CHORD,
    })[1]!)).toBe("  └ Waiting for capacity");
  });

  it("places the fixed activity inset after passive and focused tree gutters", () => {
    const passive = view(makeModel({ t: 100 }), [rec({
      agentId: "passive", liveActivity: { kind: "status", text: "semantic" },
    })]);
    expect(stripAnsi(renderSubagentPanel(passive, { width: 80, entryChord: CHORD })[1]!))
      .toBe("  └ semantic");

    const focusedNested = view(makeModel({ t: 100 }), [rec({
      agentId: "focused", liveActivity: { kind: "status", text: "semantic" },
    })], { focused: true });
    focusedNested.rows[0]!.treeDepth = 1;
    expect(stripAnsi(renderSubagentPanel(focusedNested, { width: 80, entryChord: CHORD })[1]!))
      .toBe("      └ semantic");
  });

  it("aligns identity, description, elapsed, sparse usage, positive cache, and cost columns", () => {
    const lines = rowsOnly(renderSubagentPanel(mixedView(), { width: 180, entryChord: CHORD }));
    expect(lines).toHaveLength(3);
    const starts = (line: string) => ({
      description: Math.min(...["build frontend", "review changes", "run checks"].map((value) => {
        const at = line.indexOf(value); return at < 0 ? Number.POSITIVE_INFINITY : at;
      })),
      elapsedEnd: line.search(/\d+s/) + (line.match(/\d+s/)?.[0].length ?? 0),
      outputEnd: line.indexOf("out ") + (line.match(/out \d+(?:\.\d+)?[km]?/)?.[0].length ?? 0),
      costEnd: line.indexOf("$") + (line.match(/\$\d+(?:\.\d+)?/)?.[0].length ?? 0),
    });
    const positions = lines.map(starts);
    expect(new Set(positions.map((position) => position.description)).size).toBe(1);
    expect(new Set(positions.map((position) => position.elapsedEnd)).size).toBe(1);
    expect(positions[0]!.outputEnd).toBe(positions[1]!.outputEnd);
    expect(positions[0]!.costEnd).toBe(positions[1]!.costEnd);
    expect(lines[0]).toContain("in 119.2k");
    expect(lines[0]).toContain("out 4.9k");
    expect(lines[0]).toContain("c/read 80");
    expect(lines[0]).toContain("c/write 20");
    expect(positions[0]!.costEnd).toBe(180);
    expect(lines.map(visibleWidth)).toEqual([180, 180, 180]);
    expect(renderSubagentPanel(mixedView(), { width: 180, entryChord: CHORD }).join("\n"))
      .toContain(ASSISTANT_CANARY);
  });

  it("reserves output-only, cost-only, and neither rows while omitting all-missing metrics", () => {
    const clock = { t: 1000 };
    const sparse = view(makeModel(clock), [
      rec({ agentId: "out", agentName: "outputter", description: "output only", progress: { tail: [], activity: "", usage: { outputTokens: 7 } } }),
      rec({ agentId: "cost", agentName: "costing", description: "cost only", progress: { tail: [], activity: "", usage: { costUsd: 0.5 } } }),
      rec({ agentId: "none", agentName: "quiet", description: "neither" }),
    ], { focused: true });
    const lines = rowsOnly(renderSubagentPanel(sparse, { width: 100, entryChord: CHORD })).slice(0, 3);
    expect(lines[0]).toContain("out 7");
    expect(lines[0]).not.toContain("$");
    expect(lines[1]).not.toContain("out ");
    expect(lines[1]).toContain("$0.50");
    expect(lines[2]).not.toMatch(/out |\$/u);
    expect(lines.map(visibleWidth)).toEqual([100, 100, 100]);
    expect(lines[0]!.indexOf("out 7") + "out 7".length).toBe(100 - 2 - "$0.50".length);
    expect(lines[1]!.indexOf("$0.50") + "$0.50".length).toBe(100);

    const model = makeModel(clock);
    const zeroCache = view(model, [
      rec({ agentId: "agent-z", description: "zero", progress: { tail: [], activity: "", usage: { cacheReadTokens: 0, cacheWriteTokens: -1 } } }),
      rec({ agentId: "agent-n", description: "none" }),
    ]);
    const text = renderSubagentPanel(zeroCache, { width: 100, entryChord: CHORD }).join("\n");
    expect(text).not.toContain("c/read");
    expect(text).not.toContain("c/write");
  });

  it("drops eligible metadata at the shared panel-profile boundaries", () => {
    type Metric = "cacheWrite" | "cacheRead" | "cost" | "output" | "input" | "elapsed";
    const present = (lines: string[], metric: Metric): boolean => lines.some((line) => ({
      cacheWrite: line.includes("c/write"),
      cacheRead: line.includes("c/read"),
      cost: line.includes("$"),
      output: line.includes("out "),
      input: line.includes("in "),
      elapsed: /\b\d+s\b/.test(line),
    })[metric]);
    const boundaries: Array<[Metric, number, number]> = [
      ["cacheWrite", 84, 83],
      ["cacheRead", 72, 71],
      ["cost", 61, 60],
      ["output", 53, 52],
      ["input", 43, 42],
      ["elapsed", 32, 31],
    ];
    for (const [metric, lastPresent, firstAbsent] of boundaries) {
      const before = rowsOnly(renderSubagentPanel(mixedView(), { width: lastPresent, entryChord: CHORD })).slice(0, 3);
      const after = rowsOnly(renderSubagentPanel(mixedView(), { width: firstAbsent, entryChord: CHORD })).slice(0, 3);
      expect(present(before, metric), `${metric} at ${lastPresent}`).toBe(true);
      expect(present(after, metric), `${metric} at ${firstAbsent}`).toBe(false);
      for (const [lines, width] of [[before, lastPresent], [after, firstAbsent]] as const) {
        expect(lines).toHaveLength(3);
        for (const line of lines) expect(visibleWidth(line)).toBe(width);
      }
    }

    const focusedPanel = mixedView();
    focusedPanel.focused = true;
    focusedPanel.rows[0]!.selected = true;
    const focusedWide = rowsOnly(
      renderSubagentPanel(focusedPanel, { width: 180, entryChord: CHORD }),
    ).slice(0, 3);
    for (const metric of boundaries.map(([name]) => name)) expect(present(focusedWide, metric)).toBe(true);
    expect(focusedWide.every((line) => visibleWidth(line) === 180)).toBe(true);
  });

  it("keeps descriptions until telemetry is gone, then preserves distinguishing narrow fragments", () => {
    const atDrop = rowsOnly(renderSubagentPanel(mixedView(), { width: 83, entryChord: CHORD }));
    expect(atDrop[0]).toContain("build frontend");
    expect(atDrop[1]).toContain("review changes");

    const narrow = rowsOnly(renderSubagentPanel(mixedView(), { width: 22, entryChord: CHORD }));
    expect(narrow.join("\n")).not.toMatch(/\b(?:in|out|c\/read|c\/write)\b|\$/);
    expect(narrow.some((line) => line.includes("…"))).toBe(true);

    const sameType = view(makeModel({ t: 1000 }), [
      rec({ agentId: "same-a", agentName: "coder", description: "alpha dispatch" }),
      rec({ agentId: "same-b", agentName: "coder", description: "bravo dispatch", startedAt: 1 }),
    ]);
    const sameTypeRows = rowsOnly(renderSubagentPanel(sameType, { width: 11, entryChord: CHORD }))
      .slice(0, 2)
      .map(stripAnsi);
    for (const row of sameTypeRows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(11);
      expect(row).toContain(PANEL_RUNNING_FRAMES[0]);
      expect(row).toContain("co");
      expect(row).toContain(" · ");
    }
    const descriptionFragments = sameTypeRows.map((row) => row.split(" · ")[1]!.trim());
    expect(descriptionFragments.every((fragment) => fragment.length > 0)).toBe(true);
    expect(new Set(descriptionFragments).size).toBe(2);
    expect(new Set(sameTypeRows).size).toBe(2);
  });

  it("uses the explicit row minimum and drops description before aggregate fallback", () => {
    const panel = view(makeModel({ t: 1000 }), [rec({
      agentId: "boundary", agentName: "coder", description: "optional detail",
    })]);
    const atMinimum = stripAnsi(renderSubagentPanel(panel, {
      width: PANEL_MIN_ROW_WIDTH,
      entryChord: CHORD,
    })[0] ?? "");
    expect(atMinimum).toContain(PANEL_RUNNING_FRAMES[0]);
    expect(atMinimum).toMatch(/co…/u);
    expect(atMinimum).not.toContain("optional");
    const belowMinimum = stripAnsi(renderSubagentPanel(panel, {
      width: PANEL_MIN_ROW_WIDTH - 1,
      entryChord: CHORD,
    })[0] ?? "");
    expect(belowMinimum).not.toMatch(/co…|coder/u);
    expect(belowMinimum).toContain(PANEL_RUNNING_FRAMES[0]);
  });

  it.each([
    ["input", "in 119.2k"],
    ["output", "out 4.9k"],
    ["cache read", "c/read 80"],
    ["cache write", "c/write 20"],
    ["elapsed", "12s"],
    ["cost", "$1.08"],
  ] as const)("renders %s telemetry muted and never accent", (_field, displayed) => {
    const fg = vi.fn((_slot: string, text: string) => text);
    renderSubagentPanel(mixedView(), { width: 180, entryChord: CHORD, theme: { fg } });
    expect(fg.mock.calls.some(([slot, text]) => slot === "muted" && text.includes(displayed))).toBe(true);
    expect(fg.mock.calls.some(([slot, text]) => slot === "accent" && text.includes(displayed))).toBe(false);
  });

  it("uses accent only for descriptions, muted separators/telemetry, and preserves state/identity colors", () => {
    const fg = vi.fn((_slot: string, text: string) => `${ESC}[36m${text}${ESC}[39m`);
    const themed = renderSubagentPanel(mixedView(), {
      width: 180,
      entryChord: CHORD,
      theme: { fg },
    }).join("\n");
    expect(fg).toHaveBeenCalledWith("accent", PANEL_RUNNING_FRAMES[0]);
    expect(fg).toHaveBeenCalledWith("accent", "build frontend");
    expect(fg).toHaveBeenCalledWith("muted", " · ");
    expect(fg).toHaveBeenCalledWith("muted", expect.stringContaining("in 119.2k"));
    expect(fg).not.toHaveBeenCalledWith("accent", " · ");
    expect(fg).not.toHaveBeenCalledWith("muted", expect.stringContaining("build frontend"));
    expect(themed).toContain(`${AGENT_COLOR_ANSI.red}coder${ESC}[39m`);

    const statePanel = view(makeModel({ t: 1000 }), [
      rec({ agentId: "waiting", admission: "waiting" }),
      rec({ agentId: "success", state: "settled", outcome: "completed", settledAt: 900 }),
      rec({ agentId: "failed", state: "settled", outcome: "failed", settledAt: 900 }),
      rec({ agentId: "stopped", state: "settled", outcome: "aborted", settledAt: 900 }),
    ]);
    renderSubagentPanel(statePanel, { width: 100, entryChord: CHORD, theme: { fg } });
    expect(fg).toHaveBeenCalledWith("warning", PANEL_GLYPH_WAITING);
    expect(fg).toHaveBeenCalledWith("success", PANEL_GLYPH_SUCCESS);
    expect(fg).toHaveBeenCalledWith("error", PANEL_GLYPH_FAILED);
    expect(fg).toHaveBeenCalledWith("warning", PANEL_GLYPH_STOPPED);

    expect(themed).toContain("$1.08");
    expect(themed).toContain("<$0.01");
    expect(themed).not.toContain("$0.00");
    expect(themed).not.toContain("$1.082095");
  });

  it("determines a long fallback before display caps and renders one identity without accent or separator", () => {
    const fg = vi.fn((_slot: string, text: string) => text);
    const longIdentity = `custom-${"identity".repeat(30)}`;
    const panel = view(makeModel({ t: 1000 }), [rec({ agentId: "fallback", agentName: longIdentity })]);
    const row = renderSubagentPanel(panel, { width: 180, entryChord: CHORD, theme: { fg } })[0]!;
    expect(row.match(/custom/gu)).toHaveLength(1);
    expect(row).not.toContain(" · ");
    expect(fg.mock.calls.filter(([slot]) => slot === "accent")).toEqual([["accent", PANEL_RUNNING_FRAMES[0]]]);
  });

  it("keeps a shared description column aligned without a visible separator on fallback rows", () => {
    const fg = vi.fn((_slot: string, text: string) => text);
    const panel = view(makeModel({ t: 12_000 }), [
      rec({ agentId: "described", agentName: "coder", description: "real dispatch" }),
      rec({ agentId: "fallback", agentName: "reviewer", startedAt: 2_000 }),
    ]);
    const rows = rowsOnly(renderSubagentPanel(panel, {
      width: 80, entryChord: CHORD, theme: { fg },
    })).slice(0, 2);
    expect(rows[0]).toContain("coder");
    expect(rows[0]).toContain(" · real dispatch");
    expect(rows[1]).not.toContain(" · ");
    expect(rows[0]!.indexOf("12s")).toBe(rows[1]!.indexOf("10s"));
    expect(fg.mock.calls.filter(([slot, text]) => slot === "muted" && text === " · ")).toHaveLength(1);
    expect(fg).toHaveBeenCalledWith("accent", "real dispatch");
  });

  it("keeps useful long custom identity across aggregate, row-minimum, and wide profiles", () => {
    const panel = view(makeModel({ t: 1000 }), [rec({
      agentId: "custom", agentName: "custom-agent-identity-that-is-very-long",
      description: "distinct-dispatch-description-that-is-also-long",
      progress: { tail: [], activity: "", usage: { inputTokens: 99, outputTokens: 7 } },
    })]);
    const at = (width: number) =>
      stripAnsi(renderSubagentPanel(panel, { width, entryChord: CHORD })[0] ?? "");
    expect(at(PANEL_MIN_ROW_WIDTH - 1)).toMatch(/1 running|^\S$/u);
    expect(at(PANEL_MIN_ROW_WIDTH)).toMatch(/custom|cus|cu…/u);
    expect(at(80)).toMatch(/custom.*distinct/u);
  });

  it("never renders task ids while retaining distinct hidden keys for duplicate visible rows", () => {
    const clock = { t: 1000 };
    const model = makeModel(clock);
    const records = [
      rec({ agentId: "agent-a", agentName: "coder", description: "same work", startedAt: 0 }),
      rec({ agentId: "agent-b", agentName: "coder", description: "same work", startedAt: 0 }),
    ];
    const tasks = [
      { id: "task-secret-a", status: "running" as const, agentId: "agent-a" },
      { id: "task-secret-b", status: "running" as const, agentId: "agent-b" },
    ];
    const panel = view(model, records, { tasks });
    expect(panel.rows.map((row) => row.keyId)).toEqual(["task:task-secret-a", "task:task-secret-b"]);
    const passive = rowsOnly(renderSubagentPanel(panel, { width: 100, entryChord: CHORD }));
    expect(passive.join("\n")).not.toContain("task-secret");
    expect(passive[0]).toBe(passive[1]);
  });

  it("drops hidden-descendant chips before identity at their width boundary", () => {
    const panel = view(makeModel({ t: 100 }, 1), [
      rec({ agentId: "parent", agentName: "parent", description: "optional detail" }),
      rec({ agentId: "child", parentAgentId: "parent", startedAt: 1 }),
    ]);
    expect(panel.rows[0]?.hiddenDescendants).toBe(1);
    const withChip = stripAnsi(renderSubagentPanel(panel, { width: 10, entryChord: CHORD })[0] ?? "");
    expect(withChip).toContain("pa… (+1)");
    const withoutChip = stripAnsi(renderSubagentPanel(panel, { width: 9, entryChord: CHORD })[0] ?? "");
    expect(withoutChip).toContain("parent");
    expect(withoutChip).not.toContain("(+1)");
  });

  it("drops the waiting label before identity at its width boundary", () => {
    const panel = view(makeModel({ t: 100 }), [
      rec({ agentId: "waiting", agentName: "coder", admission: "waiting" }),
    ]);
    const withLabel = stripAnsi(renderSubagentPanel(panel, { width: 15, entryChord: CHORD })[0] ?? "");
    expect(withLabel).toContain("co… [waiting]");
    const withoutLabel = stripAnsi(renderSubagentPanel(panel, { width: 14, entryChord: CHORD })[0] ?? "");
    expect(withoutLabel).toContain("coder");
    expect(withoutLabel).not.toContain("[waiting]");
  });

  it("preserves focus/tree/state gutters and hidden-descendant chips", () => {
    const clock = { t: 100 };
    const model = makeModel(clock, 2);
    const records = [
      rec({ agentId: "agent-p", description: "parent" }),
      rec({ agentId: "agent-c1", parentAgentId: "agent-p", description: "child one", startedAt: 1 }),
      rec({ agentId: "agent-c2", parentAgentId: "agent-p", description: "child two", startedAt: 2 }),
    ];
    const panel = view(model, records, { focused: true });
    const lines = rowsOnly(renderSubagentPanel(panel, { width: 100, entryChord: CHORD }));
    expect(lines[0]).toContain("❯");
    expect(lines[0]).toContain("(+1)");
    expect(lines[1]!.indexOf(PANEL_RUNNING_FRAMES[0]!)).toBeGreaterThan(lines[0]!.indexOf(PANEL_RUNNING_FRAMES[0]!));
  });
});

describe("panel aggregate, palette, and width safety", () => {
  it("renders waiting with a static glyph and literal activity label without a responsive footer count", () => {
    const panel = view(makeModel({ t: 1000 }), [
      rec({ agentId: "running" }),
      rec({ agentId: "waiting", admission: "waiting" }),
    ]);
    const lines = renderSubagentPanel(panel, {
      width: 120,
      entryChord: CHORD,
      runningFrame: PANEL_RUNNING_FRAMES[4],
    });
    const waitingRow = lines.find((line) => line.includes("[waiting]"));
    expect(waitingRow).toContain(PANEL_GLYPH_WAITING);
    expect(waitingRow).not.toContain(PANEL_RUNNING_FRAMES[4]);
    expect(lines).not.toContain("1 running · 1 waiting");
    expect(lines.some((line) => line.includes("Waiting for capacity"))).toBe(true);
  });

  it.each([
    ["failed", rec({ agentId: "a", state: "settled", outcome: "failed", settledAt: 900 }), PANEL_GLYPH_FAILED],
    ["stopped", rec({ agentId: "a", state: "settled", outcome: "aborted", settledAt: 900 }), PANEL_GLYPH_STOPPED],
    ["completed", rec({ agentId: "a", state: "settled", outcome: "completed", settledAt: 900 }), PANEL_GLYPH_SUCCESS],
    ["running", rec({ agentId: "a" }), PANEL_RUNNING_FRAMES[0]],
  ] as const)("distinguishes a %s-only aggregate below the row minimum", (_word, record, glyph) => {
    const panel = view(makeModel({ t: 1000 }), [record], { focused: false });
    const lines = renderSubagentPanel(panel, { width: PANEL_MIN_ROW_WIDTH - 1, entryChord: "a" });
    expect(lines.join("\n")).toContain(glyph);
    expect(lines.join("\n")).not.toContain("agent");
  });

  it("uses complete pre-window counts when failures and stops lie outside the row window", () => {
    const clock = { t: 1000 };
    const model = makeModel(clock, 1);
    const panel = view(model, [
      rec({ agentId: "run", startedAt: 0 }),
      rec({ agentId: "failed", state: "settled", outcome: "failed", settledAt: 900, startedAt: 1 }),
      rec({ agentId: "stopped", state: "settled", outcome: "aborted", settledAt: 900, startedAt: 2 }),
      rec({ agentId: "done", state: "settled", outcome: "completed", settledAt: 900, startedAt: 3 }),
    ]);
    panel.rows[0]!.treeDepth = 6;
    expect(panel.rows.map((row) => row.agentId)).toEqual(["run"]);
    expect(panel).toMatchObject({ runningCount: 1, failedCount: 1, stoppedCount: 1, completedCount: 1 });
    const text = renderSubagentPanel(panel, {
      width: PANEL_MIN_ROW_WIDTH - 1,
      entryChord: CHORD,
    }).join("\n");
    for (const glyph of [PANEL_RUNNING_FRAMES[0], PANEL_GLYPH_FAILED, PANEL_GLYPH_STOPPED, PANEL_GLYPH_SUCCESS]) {
      expect(text).toContain(glyph);
    }
    expect(text).not.toContain("done");
  });

  it("pins the shared palette, normalization, prototype rejection, and foreground-only reset", () => {
    const accepted = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];
    expect([...AGENT_COLOR_NAMES]).toEqual(accepted);
    expect(Object.keys(AGENT_COLOR_ANSI)).toEqual(accepted);
    for (const color of accepted) {
      expect(normalizeAgentColor(` ${color.toUpperCase()} `)).toBe(color);
      expect(tintAgentColor(color, "coder")).toBe(`${AGENT_COLOR_ANSI[color as keyof typeof AGENT_COLOR_ANSI]}coder${ESC}[39m`);
    }
    for (const evil of [undefined, null, {}, "constructor", "toString", "blood"]) {
      expect(normalizeAgentColor(evil)).toBeUndefined();
      expect(tintAgentColor(evil, "coder")).toBe("coder");
    }
    const mutableCompatibilitySet = AGENT_COLOR_NAMES as Set<string>;
    const hadBlood = mutableCompatibilitySet.has("blood");
    try {
      mutableCompatibilitySet.add("blood");
      expect(normalizeAgentColor("blood")).toBeUndefined();
    } finally {
      if (!hadBlood) mutableCompatibilitySet.delete("blood");
    }
    expect(tintAgentColor("red", "coder").replace(/\x1b\[[0-9;]*m/gu, "")).toBe("coder");

    const clock = { t: 1000 };
    const colored = view(makeModel(clock), [rec({
      agentId: "agent-color", color: "red", description: "stable work",
      progress: { tail: [], activity: "", usage: { inputTokens: 4 } },
    })]);
    const row = renderSubagentPanel(colored, {
      width: 100, entryChord: CHORD,
      theme: { fg: (_color: string, text: string) => text },
    })[0]!;
    expect(row).toContain(`${AGENT_COLOR_ANSI.red}coder${ESC}[39m · stable work`);
    expect(row.match(new RegExp(AGENT_COLOR_ANSI.red.replace("[", "\\["), "g"))).toHaveLength(1);
    const fixedTint = row.slice(row.indexOf(AGENT_COLOR_ANSI.red) + AGENT_COLOR_ANSI.red.length, row.indexOf(`${ESC}[39m`));
    expect(fixedTint).toBe("coder");
    const themeless = renderSubagentPanel(colored, { width: 100, entryChord: CHORD });
    expect(themeless.join("\n")).not.toContain(ESC);
    const ansiTheme = { fg: (_color: string, text: string) => `${ESC}[36m${text}${ESC}[39m` };
    const themed = renderSubagentPanel(colored, { width: 100, entryChord: CHORD, theme: ansiTheme });
    expect(themed.map(stripAnsi)).toEqual(themeless);
  });

  it("keeps agent-count windowing, terminal contraction, focused gutters, and narrow aggregates stable", () => {
    const active = Array.from({ length: MAX_PANEL_ROWS + 1 }, (_, index) => rec({
      agentId: `active-${index}`,
      agentName: `agent-${index}`,
      startedAt: index,
      liveActivity: { kind: "status" as const, text: `working ${index}` },
    }));
    const activePanel = view(makeModel({ t: 100 }, MAX_PANEL_ROWS), active);
    const activeLines = renderSubagentPanel(activePanel, { width: 80, entryChord: CHORD }).map(stripAnsi);
    const body = activeLines.filter((line) => !line.includes("agent panel") && !line.startsWith("… "));
    expect(activePanel.rows).toHaveLength(MAX_PANEL_ROWS);
    expect(body).toHaveLength(MAX_PANEL_ROWS * 2);
    expect(activeLines).toContain(panelMoreBelow(1));

    const terminalPanel = view(makeModel({ t: 100 }), [
      rec({ agentId: "ok", state: "settled", outcome: "completed", settledAt: 90 }),
      rec({ agentId: "failed", state: "settled", outcome: "failed", settledAt: 90, startedAt: 1 }),
      rec({ agentId: "stopped", state: "settled", outcome: "aborted", settledAt: 90, startedAt: 2 }),
      rec({ agentId: "cancelled", state: "settled", userStopped: true, settledAt: 90, startedAt: 3 }),
    ]);
    const terminalLines = renderSubagentPanel(terminalPanel, { width: 80, entryChord: CHORD }).map(stripAnsi);
    expect(terminalLines.filter((line) => !line.includes("agent panel"))).toHaveLength(4);
    expect(terminalLines.join("\n")).not.toContain("└ ");

    const focused = view(makeModel({ t: 100 }), [rec({
      agentId: "deep", liveActivity: { kind: "status", text: "semantic" },
    })], { focused: true });
    focused.rows[0]!.treeDepth = 6;
    const minimum = renderSubagentPanel(focused, { width: PANEL_MIN_ROW_WIDTH, entryChord: CHORD }).map(stripAnsi);
    expect(minimum[1]).toMatch(/^  └ ./u);
    expect(visibleWidth(minimum[1]!)).toBeLessThanOrEqual(PANEL_MIN_ROW_WIDTH);

    const aggregate = renderSubagentPanel(activePanel, {
      width: PANEL_MIN_ROW_WIDTH - 1, entryChord: CHORD,
    }).join("\n");
    expect(aggregate).not.toContain("working 0");
    expect(aggregate).not.toContain("└ ");
  });

  it.each([
    ["POSIX", "/repo/src/index.ts"],
    ["Windows", "C:\\repo\\src\\index.ts"],
  ])("keeps one sanitized, bounded tool activity line for %s arguments under hostile themes", (_label, path) => {
    const panel = view(makeModel({ t: 100 }), [rec({
      agentId: "wide", liveActivity: {
        kind: "tool", tool: `Read${ESC}[2J\u0001\uD800\r\nignored`, detail: `${path}${ESC}[31m\u0001\uD800`,
      },
    })], { focused: true });
    const themes = [
      undefined,
      { fg: (_color: string, text: string) => `${ESC}[36m${text}${ESC}[39m` },
      { fg: () => `${ESC}[31munbalanced` },
      { get fg() { throw new Error("hostile fg"); } },
    ];
    for (const width of [PANEL_MIN_ROW_WIDTH, 80]) {
      const baseline = renderSubagentPanel(panel, { width, entryChord: CHORD }).map(stripAnsi);
      expect(baseline).toHaveLength(3);
      expect(baseline.filter((line) => line.includes("└ "))).toHaveLength(1);
      if (width === 80) expect(baseline[1]).toContain(path);
      for (const theme of themes) {
        const lines = renderSubagentPanel(panel, { width, entryChord: CHORD, theme });
        expect(lines).toHaveLength(3);
        expect(lines.map(stripAnsi)).toEqual(baseline);
        expect(lines.filter((line) => stripAnsi(line).includes("└ "))).toHaveLength(1);
        for (const line of lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          const plain = stripAnsi(line);
          expect(plain).not.toMatch(/[\r\n\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
          expect(plain).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
        }
      }
    }
  });

  it("composes muted reasoning with italic styling and defends malformed activity", () => {
    const text = "checking invariants";
    const panel = view(makeModel({ t: 100 }), [rec({
      agentId: "reasoning", liveActivity: { kind: "reasoning", text },
    })], { focused: true });
    const theme = {
      fg: (color: string, value: string) => `${ESC}[${color === "muted" ? "90" : "36"}m${value}${ESC}[39m`,
      italic: (value: string) => `${ESC}[3m${value}${ESC}[23m`,
    };
    const lines = renderSubagentPanel(panel, { width: 80, entryChord: CHORD, theme });
    expect(lines[1]).toContain(`${ESC}[90m${ESC}[3m${text}${ESC}[23m${ESC}[39m`);
    expect(stripAnsi(lines[1]!)).toContain(`└ ${text}`);

    (panel.rows[0] as unknown as { activity: unknown }).activity = { kind: "unknown", text: "bad" };
    expect(stripAnsi(renderSubagentPanel(panel, { width: 20, entryChord: CHORD })[1]!)).toContain("Working…");
  });

  it("fails hostile reasoning theme composition open to the sanitized themeless line", () => {
    const panel = view(makeModel({ t: 100 }), [rec({
      agentId: "hostile-reasoning",
      liveActivity: { kind: "reasoning", text: `think${ESC}[31m\r\n\u0001\uD800 safely` },
    })], { focused: true });
    const width = 40;
    const baselineLines = renderSubagentPanel(panel, { width, entryChord: CHORD });
    const baseline = baselineLines.map(stripAnsi);
    const validFg = (_color: string, value: string) => value;
    const validItalic = (value: string) => `${ESC}[3m${value}${ESC}[23m`;
    const themes: Array<[string, unknown]> = [
      ["malformed italic", { fg: validFg, italic: "malformed" }],
      ["throwing italic getter", { fg: validFg, get italic(): never { throw new Error("hostile italic getter"); } }],
      ["throwing italic method", { fg: validFg, italic: () => { throw new Error("hostile italic method"); } }],
      ["unbalanced italic output", { fg: validFg, italic: (value: string) => `${ESC}[3m${value}` }],
      ["malformed outer fg", { fg: "malformed", italic: validItalic }],
      ["throwing outer fg getter", { get fg(): never { throw new Error("hostile fg getter"); }, italic: validItalic }],
      ["throwing outer fg method", { fg: () => { throw new Error("hostile fg method"); }, italic: validItalic }],
      ["unbalanced outer fg output", { fg: (_color: string, value: string) => `${ESC}[90m${value}`, italic: validItalic }],
    ];

    expect(baselineLines).toHaveLength(3);
    expect(baseline.filter((line) => line.includes("└ "))).toHaveLength(1);
    for (const [label, theme] of themes) {
      const lines = renderSubagentPanel(panel, { width, entryChord: CHORD, theme });
      const plain = lines.map(stripAnsi);
      expect(plain, label).toEqual(baseline);
      expect(lines[1], label).toBe(baselineLines[1]);
      expect(lines, label).toHaveLength(baselineLines.length);
      expect(plain.filter((line) => line.includes("└ ")), label).toHaveLength(1);
      for (const line of lines) {
        expect(visibleWidth(line), label).toBeLessThanOrEqual(width);
        const stripped = stripAnsi(line);
        expect(stripped, label).not.toMatch(/[\r\n\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
        expect(stripped, label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
      }
    }
  });

  it("keeps every line width-safe for hostile text, ANSI/themeless/throwing themes, and widths 0..120", () => {
    const clock = { t: 90_000 };
    const model = makeModel(clock, 20);
    const records = [
      rec({
        agentId: "agent-a", agentName: `evil${ESC}[31m\u0001名\tÁ👨‍👩‍👧‍👦\uD800`,
        description: `宽字符 ${"👨‍👩‍👧‍👦".repeat(20)} ${"x".repeat(300)}`, color: "cyan",
        liveActivity: { kind: "tool", tool: `Read${ESC}[2J\u0001\uD800`, detail: `名 ${"界".repeat(300)}` },
        progress: { tail: [], activity: "", usage: { inputTokens: 123456, cacheReadTokens: 0 } },
      }),
      ...Array.from({ length: 9 }, (_, i) => rec({
        agentId: `agent-${i}`, parentAgentId: i === 0 ? "agent-a" : `agent-${i - 1}`,
        startedAt: i + 1, description: `deep ${i} \t Á 名`,
      })),
    ];
    const panel = view(model, records, {
      tasks: [{ id: `task${ESC}[2J-secret`, status: "running", agentId: "agent-a" }],
    });
    const themes = [
      undefined,
      { fg: (_color: string, text: string) => `${ESC}[36m${text}${ESC}[39m`, italic: (text: string) => `${ESC}[3m${text}${ESC}[23m` },
      { fg: () => { throw new Error("hostile theme"); }, italic: () => { throw new Error("hostile theme"); } },
      { fg: "malformed" },
    ];
    const dangerousControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
    const unpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    for (const theme of themes) {
      for (let width = 0; width <= 120; width++) {
        const lines = renderSubagentPanel(panel, { width, theme, entryChord: CHORD });
        for (const line of lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          const plain = stripAnsi(line);
          expect(plain).not.toMatch(dangerousControls);
          expect(plain).not.toMatch(unpairedSurrogate);
          expect(plain).not.toContain("‍…");
        }
        expect(lines.join("\n")).not.toContain("task-secret");
      }
    }
  });

  it("preserves ordinary state glyphs, overflow affordances, empty view, and passive entry hint", () => {
    const clock = { t: 2000 };
    const model = makeModel(clock, 2);
    const records = [
      rec({ agentId: "run", startedAt: 0 }),
      rec({ agentId: "ok", startedAt: 1, state: "settled", outcome: "completed", settledAt: 1500 }),
      rec({ agentId: "bad", startedAt: 2, state: "settled", outcome: "failed", settledAt: 1500 }),
      rec({ agentId: "stop", startedAt: 3, state: "settled", outcome: "aborted", settledAt: 1500 }),
    ];
    const first = renderSubagentPanel(view(model, records), { width: 100, entryChord: CHORD, runningFrame: PANEL_RUNNING_FRAMES[3] });
    expect(first[0]).toContain(PANEL_RUNNING_FRAMES[3]);
    expect(first.some((line) => line.includes(PANEL_GLYPH_SUCCESS))).toBe(true);
    expect(first).toContain(panelMoreBelow(2));
    expect(first.at(-1)).toBe(panelHintUnfocused(CHORD));

    view(model, records, { focused: true });
    model.moveSelection(3);
    const lastView = view(model, records, { focused: true });
    const last = renderSubagentPanel(lastView, { width: 100, entryChord: CHORD });
    expect(last).toContain(panelMoreAbove(2));
    expect(last.some((line) => line.includes(PANEL_GLYPH_FAILED))).toBe(true);
    expect(last.some((line) => line.includes(PANEL_GLYPH_STOPPED))).toBe(true);
    expect(renderSubagentPanel(view(makeModel(clock), []), { width: 100, entryChord: CHORD })).toEqual([]);
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

function detailAssistant(text: string): SubagentDetailEntry {
  return {
    kind: "assistant",
    text: sanitizeDetailScalar(text),
    fingerprint: assistantTextFingerprint([text]),
  };
}

describe("drill-down detail rendering (pure)", () => {
  const numberedDetail = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      detailAssistant(`tail line ${String(i + 1).padStart(2, "0")}`),
    );

  it("waiting detail says capacity/session startup is pending and offers no steering", () => {
    const record = rec({
      agentId: "agent-w",
      admission: "waiting",
      prompt: "inspect the queue",
      session: { steer: () => undefined },
    });
    const rendered = renderSubagentDetail(
      {
        record,
        taskId: "task-w",
        taskStatus: "running",
        taskAdmission: "waiting",
        nowMs: 5000,
      },
      detailUi(),
      { width: 120, runningFrame: PANEL_RUNNING_FRAMES[2] },
    ).lines.join("\n");
    expect(rendered).toContain(PANEL_GLYPH_WAITING);
    expect(rendered).toContain("waiting");
    expect(rendered).toContain(DETAIL_WAITING);
    expect(rendered).toContain(detailSteerUnavailable("waiting for capacity"));
    expect(rendered).not.toContain(DETAIL_STEER_PREFIX);
  });

  it("task-side stopped uses discarded-output copy and task elapsed after dispatch settlement", () => {
    const rendered = renderSubagentDetail(
      {
        record: rec({
          agentId: "agent-stopped",
          state: "settled",
          outcome: "completed",
          startedAt: 1000,
          settledAt: 20_000,
          finalText: "must not be called a final answer",
        }),
        taskId: "task-stopped",
        taskStatus: "stopped",
        taskSettledAt: 7000,
        nowMs: 30_000,
      },
      detailUi({ follow: false }),
      { width: 160 },
    ).lines.join("\n");
    expect(rendered).toContain("6s · stopped");
    expect(rendered).toContain(DETAIL_DISCARDED_LABEL);
    expect(rendered).not.toContain(DETAIL_FINAL_LABEL);
  });

  it("running layout: header, collapsed prompt, auto-following tail, steer line, hint", () => {
    const record = rec({
      agentId: "agent-a",
      description: "build the frontend",
      prompt: "do the thing\nplease",
      detailLog: numberedDetail(20),
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

  it("accents only the drill-down description while preserving identity tint and state slots", () => {
    const record = rec({
      agentId: "agent-themed", agentName: "reviewer", color: "red",
      description: "inspect output", detailLog: [{ kind: "status", text: "checking evidence" }],
    });
    const fg = vi.fn((_slot: string, text: string) => `${ESC}[36m${text}${ESC}[39m`);
    const rendered = renderSubagentDetail(
      { record, taskId: "task-themed", nowMs: 2000 }, detailUi(), { width: 100, theme: { fg } },
    ).lines.join("\n");
    expect(fg).toHaveBeenCalledWith("accent", PANEL_RUNNING_FRAMES[0]);
    expect(fg).toHaveBeenCalledWith("muted", " · ");
    expect(fg).toHaveBeenCalledWith("accent", "inspect output");
    expect(fg).not.toHaveBeenCalledWith("accent", " · ");
    expect(fg).not.toHaveBeenCalledWith("muted", expect.stringContaining("inspect output"));
    expect(rendered).toContain(`${AGENT_COLOR_ANSI.red}reviewer${ESC}[39m`);
    expect(rendered.indexOf(AGENT_COLOR_ANSI.red)).toBe(rendered.lastIndexOf(AGENT_COLOR_ANSI.red));
    const plain = stripAnsi(rendered);
    expect(plain).toContain("reviewer · inspect output");
    expect(plain).toContain("running");
    expect(plain).toContain("status: checking evidence");
  });

  it("suppresses a long fallback description before unequal header display caps", () => {
    const longIdentity = `custom-${"identity".repeat(30)}`;
    const fg = vi.fn((_slot: string, text: string) => text);
    const rendered = renderSubagentDetail(
      { record: rec({ agentId: "fallback-detail", agentName: longIdentity }), nowMs: 1000 },
      detailUi(),
      { width: 180, theme: { fg } },
    ).lines[0]!;
    expect(rendered.match(/custom/gu)).toHaveLength(1);
    expect(rendered).not.toContain(" · ");
    expect(fg.mock.calls.filter(([slot]) => slot === "accent")).toEqual([["accent", PANEL_RUNNING_FRAMES[0]]]);
  });

  it("keeps a genuine description accented when it equals the capped identity display", () => {
    const longIdentity = `identity-${"x".repeat(100)}`;
    const cappedIdentityDisplay = `${longIdentity.slice(0, 59)}…`;
    const fg = vi.fn((_slot: string, text: string) => text);
    const header = renderSubagentDetail(
      {
        record: rec({
          agentId: "capped-identity-description",
          agentName: longIdentity,
          description: cappedIdentityDisplay,
        }),
        nowMs: 1000,
      },
      detailUi(),
      { width: 180, theme: { fg } },
    ).lines[0]!;
    expect(header).toContain(` · ${cappedIdentityDisplay}`);
    expect(fg).toHaveBeenCalledWith("accent", cappedIdentityDisplay);
  });

  it.each([
    ["waiting", rec({ agentId: "waiting-theme", admission: "waiting" }), "warning", PANEL_GLYPH_WAITING],
    ["running", rec({ agentId: "running-theme" }), "accent", PANEL_RUNNING_FRAMES[0]],
    ["success", rec({ agentId: "success-theme", state: "settled", outcome: "completed" }), "success", PANEL_GLYPH_SUCCESS],
    ["failed", rec({ agentId: "failed-theme", state: "settled", outcome: "failed" }), "error", PANEL_GLYPH_FAILED],
    ["stopped", rec({ agentId: "stopped-theme", state: "settled", outcome: "aborted" }), "warning", PANEL_GLYPH_STOPPED],
  ] as const)("uses the %s drill-down glyph theme slot", (_state, record, slot, glyph) => {
    const fg = vi.fn((_slot: string, text: string) => text);
    renderSubagentDetail({ record, nowMs: 1000 }, detailUi(), { width: 80, theme: { fg } });
    expect(fg).toHaveBeenCalledWith(slot, glyph);
  });

  it("bounds and sanitizes a hostile drill-down description at narrow and normal widths", () => {
    const description = `safe${BEL}${ESC}[2J control\t名 ${"long".repeat(80)}\uD800`;
    const record = rec({ agentId: "hostile-description", agentName: "reviewer", description });
    const dangerousControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
    const unpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    for (const width of [11, 80]) {
      const lines = renderSubagentDetail({ record, nowMs: 1000 }, detailUi(), { width }).lines;
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        const plain = stripAnsi(line);
        expect(plain).not.toMatch(dangerousControls);
        expect(plain).not.toMatch(unpairedSurrogate);
      }
      expect(lines.join("\n")).not.toContain("[2J");
    }
    expect(renderSubagentDetail(
      { record, nowMs: 1000 }, detailUi(), { width: 80 },
    ).lines[0]).toContain("reviewer · safe control 名");
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
      detailLog: [
        { kind: "status", text: "step one" },
        detailAssistant("step two"),
      ],
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
    expect(text).toContain("assistant: step two");
    expect(lines[lines.length - 1]).toContain(
      detailHint({ steerable: false, stoppable: false }),
    );
  });

  it("renders every structured category with explicit success/failure distinctions", () => {
    const record = rec({
      agentId: "agent-a",
      detailLog: [
        detailAssistant("analysis line"),
        { kind: "tool-call", tool: "Read", detail: "a.ts" },
        { kind: "tool-outcome", tool: "Read", detail: "loaded", failed: false },
        { kind: "tool-outcome", tool: "Write", detail: "denied", failed: true },
        { kind: "status", text: "retrying" },
      ],
    });
    const text = renderSubagentDetail({ record, nowMs: 0 }, detailUi({ follow: false }), {
      width: 120,
    }).lines.join("\n");
    expect(text).toContain("assistant: analysis line");
    expect(text).toContain("→ tool call: Read");
    expect(text).toContain("input: a.ts");
    expect(text).toContain("✓ tool result: Read");
    expect(text).toContain("output: loaded");
    expect(text).toContain("✗ tool failure: Write");
    expect(text).toContain("output: denied");
    expect(text).toContain("status: retrying");
  });

  it("deduplicates only an exact trailing assistant turn at registry settlement", () => {
    const settle = (
      detailLog: SubagentDetailEntry[],
      finalText: string,
      outcome: "completed" | "failed" = "completed",
      assistantIdentityText?: string,
    ) => {
      const registry = new SubagentRegistry();
      registry.register({
        agentId: "agent-a",
        agentName: "coder",
        depth: 1,
        cwd: "/repo",
        resumable: true,
        oneShot: false,
      });
      registry.noteProgress("agent-a", undefined, detailLog);
      registry.markSettled("agent-a", { outcome, finalText, assistantIdentityText });
      const record = registry.get("agent-a")!;
      const text = renderSubagentDetail(
        { record, nowMs: 0 },
        detailUi({ follow: false }),
        { width: 500 },
      ).lines.join("\n");
      return { record, text };
    };

    for (const [finalText, outcome, marker] of [
      ["MULTILINE_ONLY\npart two", "completed", "MULTILINE_ONLY"],
      [`LONG_ONLY_${"x".repeat(500)}`, "completed", "LONG_ONLY_"],
      ["FAILED_ONLY\npartial", "failed", "FAILED_ONLY"],
    ] as const) {
      const { record, text } = settle([detailAssistant(finalText)], finalText, outcome);
      expect(record.detailLog).toEqual([]);
      expect(text).not.toContain("assistant:");
      expect(text.match(new RegExp(marker, "g"))).toHaveLength(1);
    }

    const earlier = settle(
      [detailAssistant("same"), { kind: "status", text: "between" }, detailAssistant("same")],
      "same",
    );
    expect(earlier.record.detailLog).toEqual([
      detailAssistant("same"),
      { kind: "status", text: "between" },
    ]);
    expect(earlier.text.match(/same/g)).toHaveLength(2);
    expect(earlier.text).toContain("assistant: same");

    for (const following of [
      { kind: "status", text: "after" } as const,
      { kind: "tool-call", tool: "Read" } as const,
    ]) {
      const { record, text } = settle([detailAssistant("final"), following], "final");
      expect(record.detailLog).toEqual([detailAssistant("final"), following]);
      expect(text).toContain("assistant: final");
    }

    for (const [near, finalText] of [
      ["final prefix", "final"],
      ["suffix final", "final"],
      ["Final", "final"],
      ["final ", "final"],
      [`${"p".repeat(300)}A`, `${"p".repeat(300)}B`],
      [`${"p".repeat(300)}B`, `${"p".repeat(300)}A`],
    ] as const) {
      const { record, text } = settle([detailAssistant(near)], finalText);
      expect(record.detailLog).toEqual([detailAssistant(near)]);
      expect(text).toContain(`assistant: ${sanitizeDetailScalar(near)}`);
    }

    const loneHigh = "\uD800";
    const replacement = "\uFFFD";
    expect(assistantTextFingerprint([loneHigh])).not.toBe(assistantTextFingerprint([replacement]));
    const collisionRegression = settle([detailAssistant(loneHigh)], replacement);
    expect(collisionRegression.record.detailLog).toEqual([detailAssistant(loneHigh)]);
  });

  it("uses outcome-aware settled output labels and honest absent-output text", () => {
    const render = (outcome: "completed" | "failed" | "aborted", finalText?: string) =>
      renderSubagentDetail(
        { record: rec({ agentId: "agent-a", state: "settled", outcome, finalText }), nowMs: 0 },
        detailUi({ follow: false }),
        { width: 120 },
      ).lines.join("\n");
    expect(render("completed", "answer")).toContain(DETAIL_FINAL_LABEL);
    expect(render("failed", "partial")).toContain(DETAIL_PARTIAL_LABEL);
    expect(render("failed")).toContain(DETAIL_NO_PARTIAL_OUTPUT);
    expect(render("aborted", "discard me")).toContain(DETAIL_DISCARDED_LABEL);
    expect(render("aborted")).toContain(DETAIL_NO_DISCARDED_OUTPUT);
  });

  it("defensively validates malformed logs, caps inspection, sanitizes fields, and never mutates input", () => {
    const oversized: unknown[] = Array(10_000);
    oversized[0] = null;
    oversized[1] = {
      kind: "assistant",
      text: `safe${ESC}[2J\rnext`,
      fingerprint: assistantTextFingerprint([`safe${ESC}[2J\rnext`]),
    };
    oversized[2] = { kind: "tool-call", tool: 42, detail: { hostile: true } };
    oversized[3] = { kind: "tool-outcome", tool: "Read", failed: "no" };
    oversized[4] = { kind: "future", value: { arbitrary: true } };
    oversized[5] = { kind: "status", text: `${"s".repeat(1000)}OVERSIZED_SENTINEL` };
    oversized[100] = { kind: "assistant", text: "outside-inspection-budget" };
    const before = oversized.slice();
    const record = rec({ agentId: "agent-a" });
    (record as { detailLog?: unknown }).detailLog = oversized;
    const text = renderSubagentDetail({ record, nowMs: 0 }, detailUi({ follow: false }), {
      width: 400,
    }).lines.join("\n");
    expect(text).toContain("assistant: safe");
    expect(text).toContain("next");
    expect(text).toContain("status:");
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("outside-inspection-budget");
    expect(text).not.toContain("OVERSIZED_SENTINEL");
    expect(text).not.toContain("[object Object]");
    expect(oversized).toEqual(before);

    const nonArray = rec({ agentId: "agent-b" });
    (nonArray as { detailLog?: unknown }).detailLog = { kind: "assistant", text: "ignored" };
    expect(() => renderSubagentDetail({ record: nonArray, nowMs: 0 }, detailUi(), { width: 1 })).not.toThrow();
  });

  it("retains normally registry-capped prompt and final values", () => {
    const registry = new SubagentRegistry();
    registry.register({
      agentId: "agent-a",
      agentName: "coder",
      depth: 1,
      cwd: "/repo",
      resumable: true,
      oneShot: false,
      prompt: "p".repeat(10_000),
    });
    const running = renderSubagentDetail(
      { record: registry.get("agent-a")!, nowMs: 0 },
      detailUi({ promptExpanded: true, follow: false }),
      { width: 20_000 },
    ).lines.join("\n");
    expect(running).toContain(`${"p".repeat(4096)}…`);

    registry.markSettled("agent-a", { outcome: "completed", finalText: "f".repeat(20_000) });
    const settled = renderSubagentDetail(
      { record: registry.get("agent-a")!, nowMs: 0 },
      detailUi({ follow: false }),
      { width: 20_000 },
    ).lines.join("\n");
    expect(settled).toContain(`${"f".repeat(16_384)}…`);
  });

  it("keeps prompt/final capture and runtime-injected rendering scalar-safe", () => {
    const registry = new SubagentRegistry();
    registry.register({
      agentId: "agent-a",
      agentName: "worker",
      depth: 1,
      cwd: "/repo",
      resumable: false,
      oneShot: false,
      prompt: `${"p".repeat(4095)}😀tail`,
    });
    registry.markSettled("agent-a", {
      outcome: "completed",
      finalText: `${"f".repeat(16_383)}😀tail`,
    });
    const captured = registry.get("agent-a")!;
    expect(captured.prompt).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(captured.finalText).not.toMatch(/[\uD800-\uDFFF]/u);

    const injected = rec({
      agentId: "agent-b",
      state: "settled",
      outcome: "completed",
      prompt: `before\uD800after\uDC00`,
      finalText: `final\uD800text\uDC00`,
    });
    const rendered = renderSubagentDetail(
      { record: injected, nowMs: 0 },
      detailUi({ promptExpanded: true, follow: false }),
      { width: 200 },
    ).lines.join("\n");
    expect(rendered).toContain("beforeafter");
    expect(rendered).toContain("finaltext");
    expect(rendered).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("bounds raw prompt/final inspection even when hostile prefixes render nothing", () => {
    const sentinel = "MULTILINE_RAW_SENTINEL";
    const hostileValues = [
      `${" ".repeat(100_000)}${sentinel}`,
      `${String.fromCharCode(1).repeat(100_000)}${sentinel}`,
      `${ESC}]${"x".repeat(100_000)}${sentinel}`,
    ];
    for (const hostile of hostileValues) {
      const running = renderSubagentDetail(
        { record: rec({ agentId: "agent-a", prompt: hostile }), nowMs: 0 },
        detailUi({ promptExpanded: true, follow: false }),
        { width: 500 },
      ).lines.join("\n");
      const settled = renderSubagentDetail(
        {
          record: rec({ agentId: "agent-b", state: "settled", outcome: "completed", finalText: hostile }),
          nowMs: 0,
        },
        detailUi({ follow: false }),
        { width: 500 },
      ).lines.join("\n");
      expect(running).not.toContain(sentinel);
      expect(settled).not.toContain(sentinel);
    }
  });

  it("degrades safely for revoked and throwing detail arrays, slots, entries, and record getters", () => {
    const revoked = Proxy.revocable<unknown[]>([], {});
    revoked.revoke();
    const throwingLength = new Proxy<unknown[]>([], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("length poisoned");
        return Reflect.get(target, property, receiver);
      },
    });
    const throwingSlot = new Proxy<unknown[]>([detailAssistant("hidden")], {
      get(target, property, receiver) {
        if (property === "0") throw new Error("slot poisoned");
        return Reflect.get(target, property, receiver);
      },
    });
    const throwingEntry = new Proxy(detailAssistant("hidden"), {
      get(target, property, receiver) {
        if (property === "text") throw new Error("entry poisoned");
        return Reflect.get(target, property, receiver);
      },
    });

    for (const detailLog of [revoked.proxy, throwingLength, throwingSlot, [throwingEntry]]) {
      const record = rec({ agentId: "agent-a" });
      (record as { detailLog?: unknown }).detailLog = detailLog;
      expect(() => renderSubagentDetail({ record, nowMs: 0 }, detailUi(), { width: 80 })).not.toThrow();
    }

    const throwingRecord = rec({ agentId: "agent-b" });
    Object.defineProperty(throwingRecord, "detailLog", {
      get() {
        throw new Error("detailLog poisoned");
      },
    });
    expect(() => renderSubagentDetail(
      { record: throwingRecord, nowMs: 0 },
      detailUi(),
      { width: 80 },
    )).not.toThrow();
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
    expect(text).toContain(DETAIL_NO_ACTIVITY);
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
    const record = rec({ agentId: "agent-a", detailLog: numberedDetail(30) });
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
        detailLog: [
          {
            kind: "assistant",
            text: `t${ESC}[31mail`,
            fingerprint: assistantTextFingerprint([`t${ESC}[31mail`]),
          },
          { kind: "tool-call", tool: "Read", detail: "宽宽宽宽".repeat(30) },
          { kind: "tool-outcome", tool: "Read", detail: "z".repeat(400), failed: state === "settled" },
        ],
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

  it("normalizes invalid and fractional widths once at the detail boundary", () => {
    const record = rec({ agentId: "agent-a", prompt: "p", detailLog: [detailAssistant("t")] });
    for (const width of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1.5, 0]) {
      const { lines } = renderSubagentDetail({ record, nowMs: 0 }, detailUi(), { width });
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toBe("");
    }

    const fractional = renderSubagentDetail(
      { record, nowMs: 0 },
      detailUi(),
      { width: 12.9 },
    );
    const integer = renderSubagentDetail({ record, nowMs: 0 }, detailUi(), { width: 12 });
    expect(fractional).toEqual(integer);
    for (const line of fractional.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
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
  it("derives mixed capacity-one counts from newest tasks, not transient registry admission", () => {
    const records = [
      rec({ agentId: "agent-running", admission: "admitted" }),
      rec({ agentId: "agent-waiting", admission: "admitted" }),
      rec({ agentId: "agent-transient", admission: "admitted" }),
      rec({ agentId: "agent-foreground", session: { steer: () => undefined } }),
    ];
    const tasks: PanelTaskInfo[] = [
      { id: "old", status: "completed", admission: "admitted", agentId: "agent-running" },
      { id: "new", status: "running", admission: "admitted", agentId: "agent-running" },
      { id: "waiting", status: "running", admission: "waiting", agentId: "agent-waiting" },
    ];
    expect(panelAgentCounts(records.slice(0, 3), tasks)).toEqual({ running: 1, waiting: 1 });
    expect(panelAgentCounts(records, tasks)).toEqual({ running: 2, waiting: 1 });
  });

  it("emits once (with the injected chord) when more than one agent runs, never again", () => {
    const emitted: string[] = [];
    const emit = createPanelHintEmitter({
      chord: "ctrl+t",
      isTui: () => true,
      emit: (text) => emitted.push(text),
    });
    emit({ running: 2, waiting: 1 });
    expect(emitted).toEqual([panelHintText({ running: 2, waiting: 1 }, "ctrl+t")]);
    expect(emitted[0]).toContain("ctrl+t");
    expect(emitted[0]).toContain("2 running · 1 waiting");
    emit({ running: 4, waiting: 1 }); // once per session: a later, larger fan-out stays silent
    expect(emitted).toHaveLength(1);
  });

  it("does NOT emit for a single agent (negative), and a gated-off call keeps the once-gate", () => {
    const emitted: string[] = [];
    const emit = createPanelHintEmitter({
      chord: PANEL_ENTRY_CHORD,
      isTui: () => true,
      emit: (text) => emitted.push(text),
    });
    emit({ running: 0, waiting: 0 });
    emit({ running: 1, waiting: 0 });
    expect(emitted).toEqual([]);
    emit({ running: 1, waiting: 1 }); // the single-agent calls did not consume the gate
    expect(emitted).toEqual([panelHintText({ running: 1, waiting: 1 }, PANEL_ENTRY_CHORD)]);
  });

  it("emits nothing outside TUI mode, without consuming the once-gate", () => {
    const emitted: string[] = [];
    let tui = false;
    const emit = createPanelHintEmitter({
      chord: PANEL_ENTRY_CHORD,
      isTui: () => tui,
      emit: (text) => emitted.push(text),
    });
    emit({ running: 2, waiting: 2 }); // print/RPC: silent
    expect(emitted).toEqual([]);
    tui = true;
    emit({ running: 2, waiting: 2 });
    expect(emitted).toEqual([panelHintText({ running: 2, waiting: 2 }, PANEL_ENTRY_CHORD)]);
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
      const lineCountBefore = pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!.render(120).length;
      registry.noteProgress("agent-a", undefined, undefined, {
        value: { kind: "assistant", text: "live controller activity" },
      });
      expect(pi.renderRequests).toBeGreaterThan(requestsAfterInstall);
      const activityRender = pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!.render(120);
      expect(activityRender).toHaveLength(lineCountBefore);
      expect(activityRender.join("\n")).toContain("live controller activity");
      registerRunning(registry, "agent-b"); // change while installed → repaint, no reinstall
      expect(pi.widgetCalls.filter((c) => c.content !== undefined)).toHaveLength(1);
    } finally {
      controller.setSuppressed(true);
    }
  });

  it("task-registry notification repaints status changes without waiting for the tick", () => {
    let notifyTask!: () => void;
    const tasks: PanelTaskInfo[] = [{
      id: "task-a",
      status: "running",
      admission: "waiting",
      agentId: "agent-a",
    }];
    const { registry, pi, ui, controller } = setup({
      tasks: () => tasks,
      onTasksChange: (listener) => {
        notifyTask = listener;
        return () => {};
      },
      tickMs: 3_600_000,
    });
    try {
      registerRunning(registry, "agent-a");
      registry.noteAdmission("agent-a", "waiting");
      controller.attach(ui);
      expect(pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!.render(120).join("\n")).toContain("waiting");
      const before = pi.renderRequests;
      tasks[0]!.status = "stopped";
      tasks[0]!.settledAt = Date.now();
      notifyTask();
      expect(pi.renderRequests).toBe(before + 1);
      const stopped = pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!.render(120).join("\n");
      expect(stopped).toContain(PANEL_GLYPH_STOPPED);
      expect(stopped).not.toContain("waiting");
    } finally {
      controller.setSuppressed(true);
    }
  });

  it("suppression from the focused panel hides the widget and re-shows it", () => {
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

  it("does not consume the one-time hint on pre-task records and reports capacity-one mixed counts", async () => {
    const localSettings = path.join(dir, ".claude", "settings.local.json");
    fs.writeFileSync(localSettings, JSON.stringify({ subagents: { concurrency: 1 } }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    try {
      const handle = fakeSdk({ replies: [{ text: "first done", gate }, { text: "second done" }] });
      const { pi } = await boot(handle);
      await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
      const agentTool = pi.tools.get("Agent");
      await agentTool.execute("hint-1", {
        subagent_type: "general-purpose",
        prompt: "FIRST",
        run_in_background: true,
      });
      await handle.waitForPromptCalls(1);
      await agentTool.execute("hint-2", {
        subagent_type: "general-purpose",
        prompt: "SECOND",
        run_in_background: true,
      });
      await waitUntil({
        description: "mixed admitted/waiting panel hint",
        predicate: () => pi.notifications.some((notice) =>
          notice.text === panelHintText({ running: 1, waiting: 1 }, PANEL_ENTRY_CHORD)),
      });
      expect(pi.notifications.filter((notice) => notice.text.includes("manage agents"))).toEqual([
        expect.objectContaining({
          text: panelHintText({ running: 1, waiting: 1 }, PANEL_ENTRY_CHORD),
        }),
      ]);
      release();
      await handle.waitForPromptCalls(2);
    } finally {
      release?.();
      fs.rmSync(localSettings, { force: true });
    }
  });

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

  it("carries runtime waiting admission into the assembled panel and repaints when admitted", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const never = new Promise<void>(() => {});
    const handle = fakeSdk({
      replies: Array.from({ length: 11 }, (_, index) => ({
        text: `reply-${index}`,
        gate: index === 0 ? firstGate : never,
      })),
    });
    const { pi, internals } = await boot(handle);
    internals.subagentPanel.configureForTest({ tickMs: 3_600_000 });
    await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
    const agentTool = pi.tools.get("Agent");
    const taskIds: string[] = [];
    for (let index = 0; index < 11; index++) {
      const result = await agentTool.execute(`t${index}`, {
        subagent_type: "general-purpose",
        prompt: `GO ${index}`,
        run_in_background: true,
      });
      taskIds.push(result.details.taskId as string);
    }
    await handle.waitForPromptCalls(10);
    const waitingTask = internals.backgroundTasks.get(taskIds[10]!)!;
    expect(waitingTask.admission).toBe("waiting");
    const waitingSummary = pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!.render(39).join("\n");
    expect(waitingSummary).toContain("… 3 more");
    expect(waitingSummary).not.toContain("1 waiting");
    const beforeAdmission = pi.renderRequests;
    releaseFirst();
    await handle.waitForPromptCalls(11);
    expect(waitingTask.admission).toBe("admitted");
    expect(pi.renderRequests).toBeGreaterThan(beforeAdmission);
    const admittedSummary = pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!.render(39).join("\n");
    expect(admittedSummary).toContain("general-purpose");
    expect(admittedSummary).not.toContain("waiting");
    expect(admittedSummary).toContain("… 3 more");
    internals.subagentPanel.setSuppressed(true);
  });

  it("queued TaskStop requests an immediate task-notification repaint before the periodic tick", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const never = new Promise<void>(() => {});
    const handle = fakeSdk({
      replies: Array.from({ length: 11 }, (_, index) => ({
        text: `reply-${index}`,
        gate: index === 0 ? firstGate : never,
      })),
    });
    const { pi, internals } = await boot(handle);
    internals.subagentPanel.configureForTest({ tickMs: 3_600_000 });
    await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
    const agentTool = pi.tools.get("Agent");
    let waitingTaskId = "";
    for (let index = 0; index < 11; index++) {
      const result = await agentTool.execute(`t${index}`, {
        subagent_type: "general-purpose",
        prompt: `GO ${index}`,
        run_in_background: true,
      });
      if (index === 10) waitingTaskId = result.details.taskId as string;
    }
    await handle.waitForPromptCalls(10);
    expect(internals.backgroundTasks.get(waitingTaskId)?.admission).toBe("waiting");
    const beforeStop = pi.renderRequests;
    const stopping = pi.tools.get("TaskStop").execute("stop-waiting", { task_id: waitingTaskId });
    expect(internals.backgroundTasks.get(waitingTaskId)?.status).toBe("stopped");
    expect(pi.renderRequests).toBeGreaterThan(beforeStop);
    const stoppedSummary = pi.widgets.get(SUBAGENT_PANEL_WIDGET_KEY)!.render(39).join("\n");
    expect(stoppedSummary).toContain("general-purpose");
    expect(stoppedSummary).not.toContain("waiting");
    expect(stoppedSummary).toContain("… 3 more");
    releaseFirst();
    await stopping;
    internals.subagentPanel.setSuppressed(true);
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

  it("subscribes to both registries per open and tears the pair down idempotently", async () => {
    const registry = new SubagentRegistry();
    registerRunning(registry, "agent-a");
    const registryListeners = new Set<() => void>();
    const taskListeners = new Set<() => void>();
    let registryUnsubscribes = 0;
    let taskUnsubscribes = 0;
    vi.spyOn(registry, "onChange").mockImplementation((listener) => {
      registryListeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        registryUnsubscribes++;
        registryListeners.delete(listener);
      };
    });
    const pi = fakePi();
    const controller = new SubagentPanelFocusController({
      registry,
      tasks: () => [],
      onTasksChange: (listener) => {
        taskListeners.add(listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          taskUnsubscribes++;
          taskListeners.delete(listener);
        };
      },
      stopTask: () => {},
      widget: { setSuppressed: () => {} },
      tickMs: 3_600_000,
    });

    controller.open(pi.tuiCtx() as never);
    const first = pi.customs[0]!;
    await first.ready;
    expect([registryListeners.size, taskListeners.size]).toEqual([1, 1]);
    first.input(ESC);
    await first.result;
    first.component?.dispose?.();
    first.component?.dispose?.();
    expect([registryUnsubscribes, taskUnsubscribes]).toEqual([1, 1]);
    const rendersAfterClose = pi.renderRequests;
    for (const listener of [...registryListeners, ...taskListeners]) listener();
    expect(pi.renderRequests).toBe(rendersAfterClose);

    controller.open(pi.tuiCtx() as never);
    const reopened = pi.customs[1]!;
    await reopened.ready;
    expect([registryListeners.size, taskListeners.size]).toEqual([1, 1]);
    const beforeNotifications = pi.renderRequests;
    for (const listener of [...registryListeners, ...taskListeners]) listener();
    expect(pi.renderRequests).toBe(beforeNotifications + 2);
    reopened.input(ESC);
    await reopened.result;
    expect([registryUnsubscribes, taskUnsubscribes]).toEqual([2, 2]);
  });

  it("tears down the focused timer and both subscriptions when the custom promise rejects", async () => {
    const registry = new SubagentRegistry();
    registerRunning(registry, "agent-a");
    const taskListeners = new Set<() => void>();
    let registryUnsubscribes = 0;
    let taskUnsubscribes = 0;
    const originalOnChange = registry.onChange.bind(registry);
    vi.spyOn(registry, "onChange").mockImplementation((listener) => {
      const unsubscribe = originalOnChange(listener);
      return () => {
        registryUnsubscribes++;
        unsubscribe();
      };
    });
    let renders = 0;
    let rejectCustom!: (error: Error) => void;
    const customResult = new Promise<unknown>((_resolve, reject) => (rejectCustom = reject));
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const controller = new SubagentPanelFocusController({
      registry,
      tasks: () => [],
      onTasksChange: (listener) => {
        taskListeners.add(listener);
        return () => {
          taskUnsubscribes++;
          taskListeners.delete(listener);
        };
      },
      stopTask: () => {},
      widget: { setSuppressed: () => {} },
      tickMs: 3_600_000,
    });
    const ctx = {
      mode: "tui",
      ui: {
        custom: (factory: any) => {
          factory({ requestRender: () => renders++ }, undefined, undefined, () => {});
          return customResult;
        },
      },
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      controller.open(ctx);
      expect(controller.isOpen()).toBe(true);
      rejectCustom(new Error("host rejected"));
      await customResult.catch(() => undefined);
      await Promise.resolve();
      expect(controller.isOpen()).toBe(false);
      expect([registryUnsubscribes, taskUnsubscribes]).toEqual([1, 1]);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      const afterRejection = renders;
      registerRunning(registry, "agent-b");
      for (const listener of taskListeners) listener();
      expect(renders).toBe(afterRejection);
    } finally {
      clearIntervalSpy.mockRestore();
      errors.mockRestore();
    }
  });

  it("tears down a synchronously created component when custom then throws", () => {
    vi.useFakeTimers();
    const registry = new SubagentRegistry();
    registerRunning(registry, "agent-a");
    const registryListeners = new Set<() => void>();
    const taskListeners = new Set<() => void>();
    const subscribedCallbacks: Array<() => void> = [];
    let registryUnsubscribes = 0;
    let taskUnsubscribes = 0;
    vi.spyOn(registry, "onChange").mockImplementation((listener) => {
      registryListeners.add(listener);
      subscribedCallbacks.push(listener);
      return () => {
        registryUnsubscribes++;
        registryListeners.delete(listener);
      };
    });
    let renders = 0;
    const controller = new SubagentPanelFocusController({
      registry,
      tasks: () => [],
      onTasksChange: (listener) => {
        taskListeners.add(listener);
        subscribedCallbacks.push(listener);
        return () => {
          taskUnsubscribes++;
          taskListeners.delete(listener);
        };
      },
      stopTask: () => {},
      widget: { setSuppressed: () => {} },
      tickMs: 100,
    });
    const ctx = {
      mode: "tui",
      ui: {
        custom: (factory: any) => {
          factory({ requestRender: () => renders++ }, undefined, undefined, () => {});
          throw new Error("host threw after factory");
        },
      },
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      controller.open(ctx);
      expect(controller.isOpen()).toBe(false);
      expect([registryUnsubscribes, taskUnsubscribes]).toEqual([1, 1]);
      expect([registryListeners.size, taskListeners.size]).toEqual([0, 0]);
      const afterThrow = renders;
      registerRunning(registry, "agent-b");
      for (const listener of subscribedCallbacks) listener();
      vi.advanceTimersByTime(500);
      expect(renders).toBe(afterThrow);
      expect([registryUnsubscribes, taskUnsubscribes]).toEqual([1, 1]);
    } finally {
      errors.mockRestore();
      vi.useRealTimers();
    }
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

  it("aggregate fallback refuses open and stop actions until a visible row render", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", "first target");
    reg(s.registry, "agent-b", "second target");
    s.tasks.push({ id: "task-a", status: "running", agentId: "agent-a" });
    s.tasks.push({ id: "task-b", status: "running", agentId: "agent-b" });
    const invocation = s.openPanel()!;
    await invocation.ready;

    // Initial state and the actual aggregate profile both fail closed.
    invocation.input(KEY_ENTER);
    expect(s.notices()).toContain(PANEL_NOTICE_RESIZE_ACTION);
    expect(invocation.render(1).join("\n")).not.toContain("❯");
    invocation.input(KEY_DOWN); // selection may move, but remains invisible
    invocation.render(1);
    invocation.input(KEY_ENTER);
    invocation.input("x");
    invocation.input("X");
    invocation.input("X");
    expect(s.stopped).toEqual([]);
    expect(s.registry.get("agent-a")!.userStopped).toBeUndefined();
    expect(s.registry.get("agent-b")!.userStopped).toBeUndefined();

    // A row-profile render exposes the same authoritative selection.
    const wide = invocation.render(120).find((line) => line.includes("❯"));
    expect(wide).toContain("second target");
    invocation.input(KEY_ENTER);
    expect(invocation.render(120).join("\n")).toContain("agent-b");
    invocation.input(ESC); // detail → list; requires a fresh visible-row proof
    invocation.render(120);
    invocation.input("x");
    expect(s.stopped).toEqual(["task-b"]);

    invocation.render(120);
    invocation.input("X");
    invocation.input("X");
    expect(s.stopped).toEqual(["task-b", "task-a"]);
    invocation.input(ESC);
    await invocation.result;
  });

  it("aggregate fallback refuses dismiss and preserves the selected settled target across resize", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", "first settled");
    reg(s.registry, "agent-b", "second settled");
    s.tasks.push({ id: "task-a", status: "completed", agentId: "agent-a" });
    s.tasks.push({ id: "task-b", status: "completed", agentId: "agent-b" });
    s.registry.markSettled("agent-a", { outcome: "completed" });
    s.registry.markSettled("agent-b", { outcome: "completed" });
    const invocation = s.openPanel()!;
    await invocation.ready;

    invocation.render(1);
    invocation.input(KEY_DOWN);
    invocation.render(1);
    invocation.input("d");
    expect(s.controller.dismissedKeyIds()).toEqual([]);
    expect(s.notices()).toContain(PANEL_NOTICE_RESIZE_ACTION);

    const selected = invocation.render(120).find((line) => line.includes("❯"));
    expect(selected).toContain("second settled");
    invocation.input("d");
    expect(s.controller.dismissedKeyIds()).toEqual(["task:task-b"]);
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

  it("task admission changes repaint the focused list immediately", async () => {
    const registry = new SubagentRegistry();
    registerRunning(registry, "agent-a");
    const tasks: PanelTaskInfo[] = [{
      id: "task-a",
      status: "running",
      admission: "waiting",
      agentId: "agent-a",
    }];
    let notifyTask!: () => void;
    const pi = fakePi();
    const controller = new SubagentPanelFocusController({
      registry,
      tasks: () => tasks,
      onTasksChange: (listener) => {
        notifyTask = listener;
        return () => {};
      },
      stopTask: () => {},
      widget: { setSuppressed: () => {} },
      tickMs: 3_600_000,
    });
    controller.open(pi.tuiCtx() as never);
    const invocation = pi.customs[0]!;
    await invocation.ready;
    expect(invocation.render(120).join("\n")).toContain("waiting");
    const before = pi.renderRequests;
    tasks[0]!.admission = "admitted";
    notifyTask();
    expect(pi.renderRequests).toBe(before + 1);
    expect(invocation.render(120).join("\n")).not.toContain("waiting");
    invocation.input(ESC);
    await invocation.result;
  });

  it("a waiting background row remains selectable and stoppable through the existing task id", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    s.registry.noteAdmission("agent-a", "waiting");
    s.tasks.push({
      id: "task-wait",
      status: "running",
      admission: "waiting",
      agentId: "agent-a",
    });
    const invocation = s.openPanel()!;
    await invocation.ready;
    expect(invocation.render(120).join("\n")).toContain("waiting");
    invocation.input("x");
    expect(s.stopped).toEqual(["task-wait"]);
    expect(s.registry.get("agent-a")!.userStopped).toBe(true);
    invocation.input(ESC);
    await invocation.result;
  });

  it("x stops the newest failed checkpoint-paused generation exactly once", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    s.tasks.push({ id: "task-old", status: "running", agentId: "agent-a" });
    s.tasks.push({
      id: "task-paused",
      status: "failed",
      checkpointPaused: true,
      agentId: "agent-a",
    });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("x");
    expect(s.stopped).toEqual(["task-paused"]);
    expect(s.stopped.filter((id) => id === "task-paused")).toHaveLength(1);
    expect(s.registry.get("agent-a")!.userStopped).toBe(true);
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
    s.registry.noteAdmission("agent-b", "waiting");
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    s.tasks.push({ id: "task-2", status: "running", admission: "waiting", agentId: "agent-b" });
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

  it("stop-all targets only newest failed checkpoint-paused generations exactly once", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a");
    s.tasks.push({ id: "task-a-old", status: "running", agentId: "agent-a" });
    s.tasks.push({
      id: "task-a-paused",
      status: "failed",
      checkpointPaused: true,
      agentId: "agent-a",
    });
    reg(s.registry, "agent-b");
    s.tasks.push({ id: "task-b-failed", status: "failed", agentId: "agent-b" });
    reg(s.registry, "agent-c");
    s.tasks.push({
      id: "task-c-stopped",
      status: "stopped",
      checkpointPaused: true,
      agentId: "agent-c",
    });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input("X");
    expect(s.notices()).toContain(panelNoticeStopAllArmed(1));
    invocation.input("X");
    expect(s.stopped).toEqual(["task-a-paused"]);
    expect(s.stopped.filter((id) => id === "task-a-paused")).toHaveLength(1);
    expect(s.stopped).not.toContain("task-a-old");
    expect(s.registry.get("agent-a")!.userStopped).toBe(true);
    expect(s.registry.get("agent-b")!.userStopped).toBeUndefined();
    expect(s.registry.get("agent-c")!.userStopped).toBeUndefined();
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

  it("steers a still-current taskless running record through guardSteer", async () => {
    const steered: string[] = [];
    const s = focusSetup();
    reg(s.registry, "agent-a", "taskless steer target", {
      session: { steer: (text: string) => void steered.push(text) },
    });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input("deliver taskless");
    expect(invocation.render(120).join("\n")).toContain(`${DETAIL_STEER_PREFIX}deliver taskless`);
    invocation.input(KEY_ENTER);
    expect(steered).toEqual(["deliver taskless"]);
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("does not buffer text for a waiting task even when the registry already has a session", async () => {
    const steered: string[] = [];
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, {
      session: { steer: (text: string) => void steered.push(text) },
    });
    s.tasks.push({
      id: "task-1",
      status: "running",
      admission: "waiting",
      agentId: "agent-a",
    });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input("must not buffer");
    invocation.input(KEY_ENTER);
    const detail = invocation.render(160).join("\n");
    expect(detail).not.toContain(`${DETAIL_STEER_PREFIX}must not buffer`);
    expect(detail).toContain(detailSteerUnavailable("waiting for capacity"));
    expect(steered).toEqual([]);
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("uses waiting registry admission when task admission is absent", async () => {
    const steered: string[] = [];
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, {
      session: { steer: (text: string) => void steered.push(text) },
    });
    s.registry.noteAdmission("agent-a", "waiting");
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input("must not buffer or send");
    invocation.input(KEY_ENTER);
    const detail = invocation.render(160).join("\n");
    expect(detail).not.toContain(`${DETAIL_STEER_PREFIX}must not buffer or send`);
    expect(detail).toContain(detailSteerUnavailable("waiting for capacity"));
    expect(steered).toEqual([]);
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("refuses text when a task stops after detail entry but before the next render", async () => {
    const steered: string[] = [];
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, {
      session: { steer: (text: string) => void steered.push(text) },
    });
    s.tasks.push({ id: "task-1", status: "running", admission: "admitted", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    s.tasks[0]!.status = "stopped";
    invocation.input("must not buffer");
    invocation.input(KEY_ENTER);
    expect(steered).toEqual([]);
    const stoppedDetail = invocation.render(160).join("\n");
    expect(stoppedDetail).not.toContain(`${DETAIL_STEER_PREFIX}must not buffer`);
    expect(stoppedDetail).toContain(DETAIL_BANNER_STOPPED);
    expect(stoppedDetail).toContain(DETAIL_DISCARDED_LABEL);
    expect(stoppedDetail).not.toContain(DETAIL_FINAL_LABEL);
    invocation.input(ESC);
    invocation.input(ESC);
    await invocation.result;
  });

  it("does not deliver old buffered text across a resumed task-generation race", async () => {
    const steered: string[] = [];
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, {
      session: { steer: (text: string) => void steered.push(text) },
    });
    s.tasks.push({ id: "task-1", status: "running", admission: "admitted", agentId: "agent-a" });
    const invocation = s.openPanel()!;
    await invocation.ready;
    invocation.render(120);
    invocation.input(KEY_ENTER);
    invocation.input("old generation text");
    s.tasks.push({ id: "task-2", status: "running", admission: "admitted", agentId: "agent-a" });
    invocation.input(KEY_ENTER);
    expect(steered).toEqual([]);
    const refused = invocation.render(160).join("\n");
    expect(refused).toContain(PANEL_NOTICE_STALE);
    expect(refused).not.toContain(`${DETAIL_STEER_PREFIX}old generation text`);
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

  it("ctrl+x in the drill-down stops a running background agent with paired stop semantics", async () => {
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

  it("settling while the drill-down is open uses completed, failed, and stopped banners", async () => {
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
    s.tasks[0]!.status = "running";
    expect(invocation.render(120).join("\n")).toContain(DETAIL_BANNER_RESUMED);

    s.registry.markSettled("agent-a", { outcome: "failed", finalText: "partial" });
    s.tasks[0]!.status = "failed";
    const failed = invocation.render(120).join("\n");
    expect(failed).toContain(DETAIL_BANNER_FAILED);
    expect(failed).toContain(DETAIL_PARTIAL_LABEL);

    s.registry.markResuming("agent-a");
    s.tasks[0]!.status = "running";
    expect(invocation.render(120).join("\n")).toContain(DETAIL_BANNER_RESUMED);
    s.registry.markSettled("agent-a", { outcome: "aborted", finalText: "discarded" });
    s.tasks[0]!.status = "stopped";
    const stopped = invocation.render(120).join("\n");
    expect(stopped).toContain(DETAIL_BANNER_STOPPED);
    expect(stopped).toContain(DETAIL_DISCARDED_LABEL);
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

  it("scrolls the detail log: up anchors, incoming entries don't yank, bottom re-engages follow", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, { session: { steer: () => undefined } });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const tail = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        detailAssistant(`tail line ${String(i + 1).padStart(2, "0")}`),
      );
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

  it("keeps live repaint subscriptions across detail exit until the focused component closes", async () => {
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
    invocation.input(ESC); // detail → list; list transitions still repaint immediately
    const afterExit = s.pi.renderRequests;
    reg(s.registry, "agent-c");
    expect(s.pi.renderRequests).toBeGreaterThan(afterExit);
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

  it("settling top-anchors onto the final answer; resuming clears prior-generation detail", async () => {
    const s = focusSetup();
    reg(s.registry, "agent-a", undefined, { session: { steer: () => undefined } });
    s.tasks.push({ id: "task-1", status: "running", agentId: "agent-a" });
    const tail = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        detailAssistant(`tail line ${String(i + 1).padStart(2, "0")}`),
      );
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
    expect(resumed).not.toContain("tail line 30");
    expect(resumed).not.toContain("the settled final answer");
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
      const hints = pi.notifications.filter((n) =>
        n.text === panelHintText({ running: 2, waiting: 0 }, PANEL_ENTRY_CHORD),
      );
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

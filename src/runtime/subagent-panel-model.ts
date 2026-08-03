import type { SubagentLiveActivity } from "./subagent-progress.js";
import type { SubagentRegistryRecord, SubagentUsage } from "./subagent-registry.js";

/**
 * Subagent status-panel model: pure data-in/rows-out. Turns registry records
 * (+ background-task join info) into a flattened, always-expanded agent tree
 * with two-tier linger, a stable discriminated selection, and an overflow
 * window. No timers, no I/O, no Date.now — the clock is injected — so every
 * behavior is unit-testable with a hand-advanced clock. String rendering lives
 * in subagent-panel-render.ts.
 */

/** Settled success rows leave the panel this long after settling. */
export const LINGER_SUCCESS_MS = 10_000;
/**
 * Failed/stopped rows linger longer — the user was not necessarily watching
 * when it broke, and a vanished failure is a silently lost signal.
 */
export const LINGER_FAILURE_MS = 60_000;
/** Bounded visible rows before the overflow window kicks in. */
export const MAX_PANEL_ROWS = 8;

/** Display state of a panel row (drives glyph + bubble color + linger tier). */
export type PanelRowState = "running" | "waiting" | "success" | "failed" | "stopped";

/**
 * Stable selection key. Discriminated: a background dispatch is addressed by
 * its task id (the stop authority — and a resume mints a NEW generation,
 * so a dismissed old generation never hides the new one), a task-less
 * (foreground/nested) dispatch by its agent id.
 */
export type PanelSelectionKey =
  | { kind: "task"; taskId: string }
  | { kind: "agent"; agentId: string };

/** Canonical string form of a selection key (dismissed-set membership, equality). */
export function selectionKeyId(key: PanelSelectionKey): string {
  return key.kind === "task" ? `task:${key.taskId}` : `agent:${key.agentId}`;
}

export function selectionKeysEqual(
  a: PanelSelectionKey | undefined,
  b: PanelSelectionKey | undefined,
): boolean {
  if (!a || !b) return a === b;
  return selectionKeyId(a) === selectionKeyId(b);
}

/**
 * The background-task join info the model consumes: a structural subset of
 * `BackgroundTaskRecord`, so callers can pass `registry.get(id)` results
 * directly without this module importing the task registry.
 */
export interface PanelTaskInfo {
  id: string;
  status: "running" | "completed" | "failed" | "stopped";
  /** Runtime-derived concurrency admission; absent compatibility data is admitted. */
  admission?: "waiting" | "admitted";
  /** Failed task retained a live checkpoint-paused child and remains stoppable. */
  checkpointPaused?: boolean;
  /** Task-side terminal timestamp, including an immediate queued-stop timestamp. */
  settledAt?: number;
  /** The dispatched child's identity — the join key against registry records. */
  agentId?: string;
}

/**
 * Newest task generation per agent id. Input order is registration order (the
 * task registry's `ids()` order), so "newest generation wins" is simply
 * last-match-wins — matching the stop targeting a panel action needs.
 */
export function newestTaskByAgent(
  tasks: readonly PanelTaskInfo[] | undefined,
): Map<string, PanelTaskInfo> {
  const byAgent = new Map<string, PanelTaskInfo>();
  for (const task of tasks ?? []) {
    if (task && typeof task.agentId === "string" && task.agentId) byAgent.set(task.agentId, task);
  }
  return byAgent;
}

/** One flattened, visible panel row (windowed slice member). */
export interface PanelRowView {
  key: PanelSelectionKey;
  /** `selectionKeyId(key)` — precomputed for dismissed-set checks and tests. */
  keyId: string;
  agentId: string;
  /** Newest-generation task id, when the agent has a background task. */
  taskId?: string;
  /** Tree indent depth: 0 for a root, +1 per visible ancestor. */
  treeDepth: number;
  state: PanelRowState;
  /**
   * The agent type (registry `agentName`). RAW — agentName is the one record
   * field deliberately unsanitized at capture (it is the name-index key), so
   * every render of it MUST pass sanitizeLine (subagent-panel-render.ts does).
   */
  agentType: string;
  /** Label column: `description` (sanitized at capture), falling back to raw `agentName`. */
  label: string;
  /** Validated Claude color name from agent frontmatter, when present. */
  color?: string;
  /** End-to-end elapsed time: now−startedAt while active/waiting, frozen after stop/settle. */
  elapsedMs: number;
  /** Live-accumulated or settlement usage (settled wins); absent until known. */
  usage?: SubagentUsage;
  /** Current activity for active rows only; copied from the registry or model fallback. */
  activity?: SubagentLiveActivity;
  selected: boolean;
  /** Descendants hidden by the overflow window — the `(+N)` chip; 0 = none. */
  hiddenDescendants: number;
}

export interface PanelViewModel {
  /** The windowed visible slice, tree order, at most `maxVisibleRows` rows. */
  rows: PanelRowView[];
  /** Total visible (pre-window) row count. */
  totalRows: number;
  /** Rows scrolled off above/below the window (the `… N more` affordances). */
  hiddenAbove: number;
  hiddenBelow: number;
  focused: boolean;
  /** Pre-window state counts for the aggregate fallback. */
  runningCount: number;
  waitingCount: number;
  failedCount: number;
  stoppedCount: number;
  completedCount: number;
  /** Compatibility aggregate for consumers that only distinguish settled rows. */
  settledCount: number;
  /** True when nothing is running or lingering — the panel disappears. */
  empty: boolean;
}

export interface PanelComputeInput {
  /** `SubagentRegistry.list()` — registration order. */
  records: readonly SubagentRegistryRecord[];
  /** Background-task join info in registration order (newest generation last). */
  tasks?: readonly PanelTaskInfo[];
  /** Panel keyboard focus: while true NO row is ever removed by linger expiry. */
  focused: boolean;
  /** Caller-owned dismissed set of `selectionKeyId` strings; always excluded. */
  dismissed?: ReadonlySet<string>;
}

/** Classified display state from the record + newest-generation task join. */
function stateOf(record: SubagentRegistryRecord, task: PanelTaskInfo | undefined): PanelRowState {
  // TaskStop publishes its terminal task-side status before a queued dispatch
  // can settle its dispatch record. That stop must win presentation immediately.
  if (task?.status === "stopped") return "stopped";
  if (record.state === "running") {
    return (task?.admission ?? record.admission) === "waiting" ? "waiting" : "running";
  }
  if (record.userStopped) return "stopped";
  switch (record.outcome) {
    case "failed":
      return "failed";
    case "aborted":
      return "stopped";
    case "completed":
      return "success";
    default:
      break;
  }
  // Unclassified settle: fall back to the task-side status, else read as done.
  if (task?.status === "failed") return "failed";
  return "success";
}

/** Effective terminal endpoint; a task-side stop remains authoritative after dispatch cleanup. */
function terminalAt(
  record: SubagentRegistryRecord,
  state: PanelRowState,
  taskSettledAt: number | undefined,
): number | undefined {
  return state === "stopped" && taskSettledAt !== undefined ? taskSettledAt : record.settledAt;
}

/** Linger deadline for a terminal row; undefined while active or not yet timestamped. */
function expiryOf(
  record: SubagentRegistryRecord,
  state: PanelRowState,
  taskSettledAt: number | undefined,
): number | undefined {
  if (state === "running" || state === "waiting") return undefined;
  const endpoint = terminalAt(record, state, taskSettledAt);
  if (endpoint === undefined) return undefined;
  const linger = state === "success" ? LINGER_SUCCESS_MS : LINGER_FAILURE_MS;
  return endpoint + linger;
}

/** Stable active-state activity, with capacity waiting authoritative over captured runtime state. */
function activityOf(record: SubagentRegistryRecord, state: PanelRowState): SubagentLiveActivity | undefined {
  if (state === "waiting") return { kind: "status", text: "Waiting for capacity" };
  if (state !== "running") return undefined;
  try {
    const activity = record.liveActivity;
    if (activity?.kind === "tool" && typeof activity.tool === "string") {
      return typeof activity.detail === "string"
        ? { kind: "tool", tool: activity.tool, detail: activity.detail }
        : { kind: "tool", tool: activity.tool };
    }
    if (
      activity &&
      (activity.kind === "reasoning" || activity.kind === "assistant" ||
        activity.kind === "output" || activity.kind === "status") &&
      typeof activity.text === "string"
    ) {
      return { kind: activity.kind, text: activity.text };
    }
  } catch {
    // Compatibility records may expose malformed activity; the active presentation still gets a fallback.
  }
  return { kind: "status", text: record.progress === undefined ? "Starting agent…" : "Working…" };
}

/** Internal pre-window row: PanelRowView minus the window-dependent fields. */
interface FlatRow {
  record: SubagentRegistryRecord;
  key: PanelSelectionKey;
  keyId: string;
  taskId?: string;
  taskSettledAt?: number;
  treeDepth: number;
  state: PanelRowState;
}

export class SubagentPanelModel {
  private readonly now: () => number;
  private readonly maxVisibleRows: number;
  private selected: PanelSelectionKey | undefined;
  /** Last resolved selection index — the "nearest row" anchor when it vanishes. */
  private lastSelectedIndex = 0;
  private windowStart = 0;
  /** Keys of the last computed flattened list — what moveSelection walks. */
  private lastFlattened: PanelSelectionKey[] = [];

  constructor(opts: { now: () => number; maxVisibleRows?: number }) {
    this.now = opts.now;
    this.maxVisibleRows = Math.max(1, opts.maxVisibleRows ?? MAX_PANEL_ROWS);
  }

  selection(): PanelSelectionKey | undefined {
    return this.selected;
  }

  select(key: PanelSelectionKey | undefined): void {
    this.selected = key;
  }

  /**
   * Move the selection by `delta` over the last computed flattened visible
   * list, clamped to its ends. No-op before the first view() or when empty.
   */
  moveSelection(delta: number): void {
    const keys = this.lastFlattened;
    if (keys.length === 0) return;
    let index = keys.findIndex((k) => selectionKeysEqual(k, this.selected));
    if (index < 0) index = Math.min(this.lastSelectedIndex, keys.length - 1);
    const next = Math.max(0, Math.min(keys.length - 1, index + delta));
    this.selected = keys[next];
    this.lastSelectedIndex = next;
  }

  /** Compute the current view model (and resolve selection + window state). */
  view(input: PanelComputeInput): PanelViewModel {
    const flattened = this.flatten(input);
    this.lastFlattened = flattened.map((r) => r.key);

    // Selection: keep an exact key match; a vanished target clamps to the
    // nearest row (the remembered index); an empty list clears it. Focus with
    // no selection starts at the first row so the marker is always somewhere.
    let selIndex = flattened.findIndex((r) => selectionKeysEqual(r.key, this.selected));
    if (selIndex < 0 && this.selected && flattened.length > 0) {
      selIndex = Math.min(this.lastSelectedIndex, flattened.length - 1);
      this.selected = flattened[selIndex]!.key;
    }
    if (selIndex < 0 && input.focused && flattened.length > 0) {
      selIndex = 0;
      this.selected = flattened[0]!.key;
    }
    if (flattened.length === 0) this.selected = undefined;
    if (selIndex >= 0) this.lastSelectedIndex = selIndex;

    // Overflow window: sticky start, scrolled just enough to keep the
    // selection inside.
    const total = flattened.length;
    const max = this.maxVisibleRows;
    this.windowStart = Math.max(0, Math.min(this.windowStart, total - max));
    if (selIndex >= 0) {
      if (selIndex < this.windowStart) this.windowStart = selIndex;
      else if (selIndex >= this.windowStart + max) this.windowStart = selIndex - max + 1;
    }
    const start = this.windowStart;
    const end = Math.min(total, start + max);

    const nowMs = this.now();
    const rows: PanelRowView[] = [];
    for (let i = start; i < end; i++) {
      const flat = flattened[i]!;
      const record = flat.record;
      // (+N): descendants of a windowed parent that the window hides. In tree
      // order a subtree is the contiguous deeper run after its parent, so only
      // the below-window part can be hidden.
      let hiddenDescendants = 0;
      for (let j = i + 1; j < total && flattened[j]!.treeDepth > flat.treeDepth; j++) {
        if (j >= end) hiddenDescendants++;
      }
      const elapsedEnd =
        flat.state === "running" || flat.state === "waiting"
          ? nowMs
          : (terminalAt(record, flat.state, flat.taskSettledAt) ?? record.startedAt);
      const activity = activityOf(record, flat.state);
      rows.push({
        key: flat.key,
        keyId: flat.keyId,
        agentId: record.agentId,
        taskId: flat.taskId,
        treeDepth: flat.treeDepth,
        state: flat.state,
        agentType: record.agentName,
        label: record.description || record.agentName,
        color: record.color,
        elapsedMs: Math.max(0, elapsedEnd - record.startedAt),
        usage: record.state === "settled" ? (record.usage ?? record.progress?.usage) : record.progress?.usage,
        ...(activity ? { activity } : {}),
        selected: selIndex === i,
        hiddenDescendants,
      });
    }

    let runningCount = 0;
    let waitingCount = 0;
    let failedCount = 0;
    let stoppedCount = 0;
    let completedCount = 0;
    for (const row of flattened) {
      switch (row.state) {
        case "running":
          runningCount++;
          break;
        case "waiting":
          waitingCount++;
          break;
        case "failed":
          failedCount++;
          break;
        case "stopped":
          stoppedCount++;
          break;
        case "success":
          completedCount++;
          break;
      }
    }
    return {
      rows,
      totalRows: total,
      hiddenAbove: start,
      hiddenBelow: total - end,
      focused: input.focused,
      runningCount,
      waitingCount,
      failedCount,
      stoppedCount,
      completedCount,
      settledCount: failedCount + stoppedCount + completedCount,
      empty: total === 0,
    };
  }

  /**
   * Visibility + tree flatten. Visibility per record: dismissed settled rows
   * are always excluded; linger expiry applies only while unfocused (focus
   * freezes ALL removals). Tree: each visible record parents to its NEAREST
   * VISIBLE ancestor via the parentAgentId chain (an expired or dismissed
   * parent's still-visible children re-root rather than dangle); active siblings preserve
   * startedAt/registration order across waiting↔running transitions, ahead of settled siblings.
   * Handles arbitrary depth; a parent cycle degrades to a root.
   */
  private flatten(input: PanelComputeInput): FlatRow[] {
    const nowMs = this.now();
    const dismissed = input.dismissed;
    const taskByAgent = newestTaskByAgent(input.tasks);
    const byId = new Map<string, SubagentRegistryRecord>();
    for (const record of input.records) {
      if (record && typeof record.agentId === "string") byId.set(record.agentId, record);
    }

    // Pass 1: visibility + key/state classification.
    const visible = new Map<string, FlatRow & { order: number }>();
    let order = 0;
    for (const record of byId.values()) {
      const task = taskByAgent.get(record.agentId);
      const state = stateOf(record, task);
      const key: PanelSelectionKey = task
        ? { kind: "task", taskId: task.id }
        : { kind: "agent", agentId: record.agentId };
      const keyId = selectionKeyId(key);
      // Dismissal only hides non-running rows: dismissing a finished agent
      // must not hide it forever if it is later resumed (running again).
      if (state !== "running" && state !== "waiting" && dismissed?.has(keyId)) continue;
      if (state !== "running" && state !== "waiting" && !input.focused) {
        const expiry = expiryOf(record, state, task?.settledAt);
        if (expiry !== undefined && nowMs >= expiry) continue;
      }
      visible.set(record.agentId, {
        record,
        key,
        keyId,
        taskId: task?.id,
        taskSettledAt: task?.settledAt,
        treeDepth: 0,
        state,
        order: order++,
      });
    }

    // Pass 2: nearest visible ancestor (cycle-guarded).
    const parentOf = new Map<string, string | undefined>();
    for (const row of visible.values()) {
      const seen = new Set<string>([row.record.agentId]);
      let parent = row.record.parentAgentId;
      while (parent !== undefined && !visible.has(parent) && !seen.has(parent)) {
        seen.add(parent);
        parent = byId.get(parent)?.parentAgentId;
      }
      parentOf.set(row.record.agentId, parent !== undefined && visible.has(parent) ? parent : undefined);
    }

    // Pass 3: sorted sibling groups, depth-first walk (always fully expanded).
    const children = new Map<string | undefined, Array<FlatRow & { order: number }>>();
    for (const row of visible.values()) {
      const parent = parentOf.get(row.record.agentId);
      const bucket = children.get(parent);
      if (bucket) bucket.push(row);
      else children.set(parent, [row]);
    }
    const byGroupOrder = (a: FlatRow & { order: number }, b: FlatRow & { order: number }) => {
      const rank = (state: PanelRowState): number =>
        state === "running" || state === "waiting" ? 0 : 1;
      const stateRank = rank(a.state) - rank(b.state);
      if (stateRank !== 0) return stateRank;
      if (a.record.startedAt !== b.record.startedAt) return a.record.startedAt - b.record.startedAt;
      return a.order - b.order;
    };
    const out: FlatRow[] = [];
    const emitted = new Set<string>();
    const walk = (parent: string | undefined, depth: number) => {
      const group = children.get(parent);
      if (!group) return;
      group.sort(byGroupOrder);
      for (const row of group) {
        if (emitted.has(row.record.agentId)) continue; // cycle guard
        emitted.add(row.record.agentId);
        row.treeDepth = depth;
        out.push(row);
        walk(row.record.agentId, depth + 1);
      }
    };
    walk(undefined, 0);
    // A cycle among visible parents leaves its members out of the root walk —
    // emit them as roots rather than dropping live agents from the panel.
    for (const row of visible.values()) {
      if (!emitted.has(row.record.agentId)) {
        emitted.add(row.record.agentId);
        row.treeDepth = 0;
        out.push(row);
      }
    }
    return out;
  }
}

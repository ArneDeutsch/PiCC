import {
  guardSteer,
  retainedInputCount,
  taskOutputAgentLocator,
  type SubagentRegistry,
  type SubagentRegistryRecord,
} from "./subagent-registry.js";
import {
  SubagentPanelModel,
  newestTaskByAgent,
  selectionKeyId,
  type PanelSelectionKey,
  type PanelTaskInfo,
  type PanelViewModel,
} from "./subagent-panel-model.js";
import {
  DETAIL_BANNER_FAILED,
  DETAIL_BANNER_RESUMED,
  DETAIL_BANNER_SETTLED,
  DETAIL_BANNER_STOPPED,
  DETAIL_BANNER_VANISHED,
  DETAIL_STEER_SENT,
  detailSteerFailed,
  detailSteerUnavailable,
  PANEL_RUNNING_FRAMES,
  renderSubagentDetail,
  renderSubagentPanel,
  type PanelDetailUiState,
} from "./subagent-panel-render.js";
import { clampLines, themedFg } from "./render-util.js";
import { sanitizeLine } from "./subagent-progress.js";
import { PANEL_ENTRY_CHORD, PANEL_TICK_MS } from "./subagent-panel-widget.js";

/**
 * Focused subagent panel: the `ctx.ui.custom` component behind the panel-entry
 * chord. Owns keyboard focus while open — arrow selection, stop/dismiss/
 * stop-all actions, the drill-down detail view with type-to-steer, and the Esc
 * ladder (detail → list → editor) — and suppresses the passive widget so the
 * agent list is never shown twice. All display logic stays in the pure
 * model/renderer; this shell owns key handling, action targeting, and the
 * detail view's UI state.
 */

/** Raw control bytes, built from code points so the source stays pure ASCII. */
const ESC_BYTE = String.fromCharCode(27);
const CTRL_P_BYTE = String.fromCharCode(16);
const CTRL_X_BYTE = String.fromCharCode(24);
const BACKSPACE_DEL = String.fromCharCode(127);
const BACKSPACE_BS = String.fromCharCode(8);

/** Second `X` within this window confirms stop-all (Claude Code's own pattern). */
export const STOP_ALL_CONFIRM_MS = 3000;

/** Render-side cap for an agent name interpolated into a status notice. */
const NOTICE_LABEL_CAP = 60;

/** Steer input buffer cap (code points) — bounded like every other buffer. */
export const STEER_INPUT_CAP = 2000;

/** Cap for inline detail notices (guard refusals interpolate an agent name). */
const DETAIL_NOTICE_CAP = 200;

/**
 * True for data that is typed/pasted TEXT (no control bytes anywhere): only
 * such input may enter the steer buffer. Chords and escape sequences all carry
 * a control byte and fall through to the key handlers instead.
 */
function isTypedText(data: string): boolean {
  if (!data) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
  }
  return true;
}

// --- status-line notice wordings (exported so tests pin the exact strings) ---

export const PANEL_NOTICE_EMPTY = "No subagents this session.";
/** The chord's refusal when rows exist but the user dismissed every one. */
export const PANEL_NOTICE_ALL_DISMISSED = "All subagent rows dismissed.";
/** A keypress whose selection no longer resolves to a current row refuses. */
export const PANEL_NOTICE_STALE = "That agent row changed — no action taken.";
export const PANEL_NOTICE_FOREGROUND =
  "Foreground agents cannot be stopped from the panel — Esc in the editor cancels the whole turn.";
export const PANEL_NOTICE_RUNNING_DISMISS = "Still running — press x to stop it first.";
export const PANEL_NOTICE_STOP_ALL_NONE = "No active background agents to stop.";
/** Refuse row actions when responsive fallback has hidden the selected target. */
export const PANEL_NOTICE_RESIZE_ACTION = "Resize wider to show an agent row before acting.";

export function panelNoticeStopRequested(label: string): string {
  return `Stop requested for ${label} — it will settle as aborted.`;
}
export function panelNoticeStopSettling(label: string): string {
  return `Stop requested for ${label}; settling.`;
}
export function panelNoticeStopAllArmed(n: number): string {
  return `Press X again to stop ${n} active background agent${n === 1 ? "" : "s"}.`;
}
export function panelNoticeStopAllDone(n: number): string {
  return `Stop requested for ${n} active background agent${n === 1 ? "" : "s"}.`;
}

/** The one line shown when every row is gone while the panel holds focus. */
export const PANEL_FOCUSED_EMPTY_LINE = "agent panel — empty · esc close";

/** The component contract Pi expects back from a `ctx.ui.custom` factory. */
export interface PanelFocusComponentShape {
  render(width: number): string[];
  handleInput(data: string): void;
  dispose(): void;
}

/** Structural slice of Pi's KeybindingsManager the component consumes. */
interface PanelKeybindingsPort {
  matches?(data: string, id: string): boolean;
}

type PanelCustomFactory = (
  tui: { requestRender?: () => void },
  theme: unknown,
  keybindings: PanelKeybindingsPort | undefined,
  done: (result?: unknown) => void,
) => PanelFocusComponentShape;

/** Structural slice of the shortcut-handler ctx the controller consumes. */
export interface PanelFocusOpenCtx {
  mode?: string;
  ui?: {
    custom?: (factory: PanelCustomFactory, options?: unknown) => Promise<unknown>;
    notify?: (text: string, severity?: string) => void;
  };
}

export interface SubagentPanelFocusDeps {
  /** The dispatch registry: rows, plus the agent-side user-stop marker. */
  registry: SubagentRegistry;
  /** Background-task join info in registration order (newest generation last). */
  tasks: () => readonly PanelTaskInfo[];
  /** Task-registry notification for status/admission-only presentation changes. */
  onTasksChange?: (listener: () => void) => () => void;
  /**
   * Task-side stop (`BackgroundTaskRegistry.markUserStopped` in production).
   * Ordinary panel stops pair it immediately with `SubagentRegistry.markUserStopped`;
   * retained checkpoint stops defer registry permanence until confirmed settlement.
   */
  stopTask: (
    taskId: string,
    metadata?: { source: "panel" },
  ) => void | Promise<void | { disposition?: "provisional" | "confirmed" | "unconfirmed" }>;
  /** Dormant retained-checkpoint stop settlement and presentation; omission preserves shipped panel behavior. */
  retainedOutcomes?: boolean;
  /** The passive widget's suppression seam: hidden while this panel is open. */
  widget: { setSuppressed(on: boolean): void };
  /** Injected clock (tests); defaults to Date.now. */
  now?: () => number;
  tickMs?: number;
}

/**
 * Per-open drill-down state. The selection key keeps stale-refusal action
 * semantics for the chorded stop; the agent id is what the view itself
 * re-resolves each render (registry records never evict, so the record
 * outlives generation changes and keeps rendering through them).
 */
interface DetailState {
  key: PanelSelectionKey;
  agentId: string;
  ui: PanelDetailUiState;
  lastObservedState: "running" | "settled" | "gone";
  /** Max scroll reported by the last render — what scroll keys clamp against. */
  lastMaxScroll: number;
}

/**
 * How a stored selection key resolves against the registries at keypress time.
 * A key is "stale" when it no longer names a current row — the target vanished
 * or a resume minted a newer task generation — and every action then refuses
 * rather than falling through to whatever row sits at the same index now.
 */
type ResolvedTarget =
  | { kind: "running-background"; record: SubagentRegistryRecord; taskId: string }
  | { kind: "running-foreground"; record: SubagentRegistryRecord }
  | { kind: "settled"; record: SubagentRegistryRecord; keyId: string }
  | { kind: "stale" };

function isStoppableTask(task: PanelTaskInfo): boolean {
  return task.status === "running" ||
    (task.status === "failed" && task.checkpointPaused === true);
}

export class SubagentPanelFocusController {
  private readonly deps: SubagentPanelFocusDeps;
  private nowFn: () => number;
  private tickMs: number;
  private openFlag = false;
  /**
   * Panel-local dismissals (`selectionKeyId` strings). Persists across panel
   * opens; never touches settlement delivery or any model-visible state.
   */
  private readonly dismissed = new Set<string>();

  constructor(deps: SubagentPanelFocusDeps) {
    this.deps = deps;
    this.nowFn = deps.now ?? Date.now;
    this.tickMs = deps.tickMs ?? PANEL_TICK_MS;
  }

  /**
   * True while the focused component is open. The typed-fork Esc watcher in
   * src/index.ts consults this to PASS a lone Esc through to the component:
   * raw terminal-input listeners run BEFORE the focused component in pi-tui,
   * so without this gate a panel-close Esc would abort an in-flight fork.
   */
  isOpen(): boolean {
    return this.openFlag;
  }

  /**
   * TEST-ONLY (reached via the in-process `onWired` seam, mirroring the
   * widget's `configureForTest`): inject the clock/tick so linger freeze and
   * the stop-all confirmation window are observable without fake timers.
   */
  configureForTest(opts: { now?: () => number; tickMs?: number }): void {
    if (opts.now) this.nowFn = opts.now;
    if (opts.tickMs !== undefined) this.tickMs = opts.tickMs;
  }

  /** Current dismissed keys — introspection for the pruning contract's tests. */
  dismissedKeyIds(): string[] {
    return [...this.dismissed];
  }

  /**
   * Read-only snapshot of the dismissed keys — the passive widget's
   * `dismissed` dep (called per view, so staleness is one render at most), so
   * a row dismissed here stays hidden after the panel closes instead of
   * re-appearing until its linger expires. A defensive COPY: the ReadonlySet
   * type is compile-time only, and handing out the live set would let any
   * consumer mutate panel dismissal state through a cast.
   */
  dismissedKeys(): ReadonlySet<string> {
    return new Set(this.dismissed);
  }

  /**
   * The chord handler: open the focused panel. Never throws — a broken UI
   * surface degrades to a no-op, and the empty panel degrades to a notice.
   * While open, Pi routes all input to the component (and extension shortcuts
   * dispatch from the default editor only), so a second chord cannot re-enter;
   * the openFlag check is a belt for non-Pi callers.
   */
  open(ctx: PanelFocusOpenCtx | undefined): void {
    try {
      const ui = ctx?.ui;
      // Mode gate: Pi only dispatches shortcuts in TUI, but a defensive check
      // keeps a hand-rolled caller from opening UI chrome in print/RPC.
      if (ctx?.mode !== "tui" || typeof ui?.custom !== "function") return;
      if (this.openFlag) return;
      this.pruneDismissed();
      const notify = (text: string): void => {
        try {
          ui.notify?.(text, "info");
        } catch {
          // status-line notices are best-effort
        }
      };
      // Entry probe on a throwaway model, with FOCUSED-view semantics: the
      // opened component's view skips linger expiry, so the probe must too —
      // probing with the passive (expiring) view would refuse entry to rows
      // the component would happily show (all-rows-expired sessions). Only a
      // genuinely record-free session or an everything-dismissed panel
      // refuses, each with its own honest notice.
      const probe = new SubagentPanelModel({ now: () => this.nowFn() });
      const probeView = probe.view({
        records: this.deps.registry.list(),
        tasks: this.deps.tasks(),
        focused: true,
        dismissed: this.dismissed,
      });
      if (probeView.empty) {
        notify(
          this.deps.registry.list().length === 0 ? PANEL_NOTICE_EMPTY : PANEL_NOTICE_ALL_DISMISSED,
        );
        return;
      }
      this.openFlag = true;
      this.deps.widget.setSuppressed(true);
      const cleanup = (): void => {
        this.openFlag = false;
        try {
          this.deps.widget.setSuppressed(false);
        } catch {
          // unsuppressing is display-side; the panel is closed either way
        }
      };
      // The whole open sequence — including attaching the cleanup continuation —
      // sits in one try, and the return value goes through Promise.resolve: a
      // broken host whose `custom` throws OR returns a non-thenable must never
      // strand `openFlag`/suppression (that would suppress the widget and the
      // fork-Esc watch for the rest of the session). Keep the component outside
      // the try because a host may invoke the factory synchronously, then throw.
      let component: PanelFocusComponentShape | undefined;
      try {
        const opened = Promise.resolve(
          ui.custom((tui, theme, keybindings, done) => {
            component = this.createComponent({ tui, theme, keybindings, done, notify });
            return component;
          }),
        );
        opened.then(
          () => {
            component?.dispose();
            cleanup();
          },
          (err) => {
            component?.dispose();
            cleanup();
            console.error(`PiCC subagent panel closed with an error: ${(err as Error).message}`);
          },
        );
      } catch (err) {
        component?.dispose();
        cleanup();
        console.error(`PiCC subagent panel open failed: ${(err as Error).message}`);
        return;
      }
    } catch (err) {
      console.error(`PiCC subagent panel open failed: ${(err as Error).message}`);
    }
  }

  /**
   * Drop dismissed keys that no longer name a CURRENT row key (their record
   * vanished, or a resume minted a newer task generation, or a task-less agent
   * gained a task generation). Registries never evict, so without this every
   * resume would grow the set unboundedly. Run on each panel entry.
   */
  private pruneDismissed(): void {
    try {
      const tasks = this.deps.tasks();
      const byAgent = newestTaskByAgent(tasks);
      const taskById = new Map<string, PanelTaskInfo>();
      for (const task of tasks) {
        if (task && typeof task.id === "string") taskById.set(task.id, task);
      }
      for (const keyId of [...this.dismissed]) {
        let current = false;
        if (keyId.startsWith("task:")) {
          const task = taskById.get(keyId.slice("task:".length));
          current =
            !!task?.agentId &&
            byAgent.get(task.agentId)?.id === task.id &&
            this.deps.registry.get(task.agentId) !== undefined;
        } else if (keyId.startsWith("agent:")) {
          const agentId = keyId.slice("agent:".length);
          current = this.deps.registry.get(agentId) !== undefined && !byAgent.has(agentId);
        }
        if (!current) this.dismissed.delete(keyId);
      }
    } catch {
      // pruning is best-effort housekeeping — never block panel entry
    }
  }

  /**
   * Re-resolve a selection key against the registries. Pinned action
   * semantics: the action follows the RE-RESOLVED state (running → stop,
   * settled → dismiss), and a key that no longer names a current row —
   * vanished, superseded by a resume's newer generation, or a key-shape change
   * (a task-less agent gained a task) — is stale and refuses.
   */
  private resolveTarget(key: PanelSelectionKey): ResolvedTarget {
    try {
      const tasks = this.deps.tasks();
      const byAgent = newestTaskByAgent(tasks);
      if (key.kind === "task") {
        const task = tasks.find((t) => t?.id === key.taskId);
        if (!task || typeof task.agentId !== "string" || !task.agentId) return { kind: "stale" };
        if (byAgent.get(task.agentId)?.id !== task.id) return { kind: "stale" };
        const record = this.deps.registry.get(task.agentId);
        if (!record) return { kind: "stale" };
        return record.state === "running" && isStoppableTask(task)
          ? { kind: "running-background", record, taskId: task.id }
          : { kind: "settled", record, keyId: selectionKeyId(key) };
      }
      const record = this.deps.registry.get(key.agentId);
      if (!record) return { kind: "stale" };
      if (byAgent.has(key.agentId)) return { kind: "stale" };
      return record.state === "running"
        ? { kind: "running-foreground", record }
        : { kind: "settled", record, keyId: selectionKeyId(key) };
    } catch {
      return { kind: "stale" };
    }
  }

  /**
   * Resolve steering through the selected current generation. Task identity,
   * running status, and effective admission are checked before the registry
   * guard so a render/send race cannot deliver buffered text to a superseding
   * session. A still-taskless selection uses the same guard as its rendering.
   */
  private resolveSteerTarget(key: PanelSelectionKey):
    | { ok: true; steer: (text: string) => Promise<void> | void }
    | { ok: false; refusal: string } {
    try {
      const tasks = this.deps.tasks();
      const byAgent = newestTaskByAgent(tasks);
      if (key.kind !== "task") {
        if (byAgent.has(key.agentId)) return { ok: false, refusal: PANEL_NOTICE_STALE };
        const record = this.deps.registry.get(key.agentId);
        if (!record) return { ok: false, refusal: PANEL_NOTICE_STALE };
        return guardSteer(record, "panel");
      }
      const task = tasks.find((candidate) => candidate.id === key.taskId);
      if (!task?.agentId || byAgent.get(task.agentId)?.id !== task.id) {
        return { ok: false, refusal: PANEL_NOTICE_STALE };
      }
      const record = this.deps.registry.get(task.agentId);
      if (!record) return { ok: false, refusal: PANEL_NOTICE_STALE };
      if (record.userStopped || record.checkpointQuarantined || record.checkpointStopState === "stopping" ||
          record.checkpointStopState === "settling-cancellation") {
        return guardSteer(record, "panel");
      }
      if (task.status !== "running") {
        return { ok: false, refusal: detailSteerUnavailable("agent is no longer running") };
      }
      if ((task.admission ?? record.admission ?? "admitted") !== "admitted") {
        return { ok: false, refusal: detailSteerUnavailable("waiting for capacity") };
      }
      return guardSteer(record, "panel");
    } catch {
      return { ok: false, refusal: PANEL_NOTICE_STALE };
    }
  }

  /**
   * Re-resolve the drill-down's record + newest-generation task each render.
   * A poisoned join degrades to "no record" (→ the vanished banner) — the
   * detail view never throws or freezes on registry state.
   */
  private detailData(agentId: string): {
    record?: SubagentRegistryRecord;
    taskId?: string;
    taskStatus?: PanelTaskInfo["status"];
    taskAdmission?: PanelTaskInfo["admission"];
    taskSettledAt?: number;
  } {
    try {
      const record = this.deps.registry.get(agentId);
      const task = newestTaskByAgent(this.deps.tasks()).get(agentId);
      return {
        record,
        taskId: task?.id,
        taskStatus: task?.status,
        taskAdmission: task?.admission,
        taskSettledAt: task?.settledAt,
      };
    } catch {
      return {};
    }
  }

  /**
   * The full single-stop semantics, applied identically by `x` and stop-all:
   * the agent-side permanence marker FIRST (so a racing settlement already
   * sees `userStopped`), then the task-side marker+abort, which drives the
   * normal aborted settlement notice to the model.
   */
  private stopAgent(
    record: SubagentRegistryRecord,
    taskId: string,
  ): void | Promise<void | { disposition?: "provisional" | "confirmed" | "unconfirmed" }> {
    if (this.deps.retainedOutcomes && record.checkpointPaused) {
      return this.deps.stopTask(taskId, { source: "panel" });
    }
    this.deps.registry.markUserStopped(record.agentId);
    return this.deps.stopTask(taskId);
  }

  /** Active background agents (newest generation each) — stop-all's targets. */
  private collectStopAllTargets(): Array<{ record: SubagentRegistryRecord; taskId: string }> {
    const byAgent = newestTaskByAgent(this.deps.tasks());
    const targets: Array<{ record: SubagentRegistryRecord; taskId: string }> = [];
    for (const record of this.deps.registry.list()) {
      if (!record || record.state !== "running" || record.userStopped) continue;
      const task = byAgent.get(record.agentId);
      if (!task || !isStoppableTask(task)) continue; // foreground/terminal task
      targets.push({ record, taskId: task.id });
    }
    return targets;
  }

  private createComponent(io: {
    tui: { requestRender?: () => void };
    theme: unknown;
    keybindings: PanelKeybindingsPort | undefined;
    done: (result?: unknown) => void;
    notify: (text: string) => void;
  }): PanelFocusComponentShape {
    const { tui, theme, keybindings, done, notify } = io;
    const model = new SubagentPanelModel({ now: () => this.nowFn() });
    let frame = 0;
    let closed = false;
    let viewMode: "list" | "detail" = "list";
    let detail: DetailState | undefined;
    let stopAllArmedAt: number | undefined;
    // Fail closed until a focused list render proves its selected row is visible.
    let selectedRowVisible = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let unsubscribeRegistry: (() => void) | undefined;
    let unsubscribeTasks: (() => void) | undefined;
    let tornDown = false;

    const teardown = (): void => {
      if (tornDown) return;
      tornDown = true;
      if (interval) clearInterval(interval);
      for (const unsubscribe of [unsubscribeRegistry, unsubscribeTasks]) {
        try {
          unsubscribe?.();
        } catch {
          // Display subscription teardown must not trap focus.
        }
      }
      unsubscribeRegistry = undefined;
      unsubscribeTasks = undefined;
    };

    const close = (): void => {
      if (closed) return;
      // Latch only AFTER done() returns: if Pi's done throws once, a later
      // Esc/error path must be able to retry the close — a pre-latched flag
      // would wedge the component with focus held and openFlag stuck.
      try {
        done(undefined);
        closed = true;
        teardown();
      } catch (err) {
        console.error(`PiCC subagent panel close failed: ${(err as Error).message}`);
      }
    };
    const computeView = (): PanelViewModel =>
      model.view({
        records: this.deps.registry.list(),
        tasks: this.deps.tasks(),
        focused: true,
        dismissed: this.dismissed,
      });
    // Resolve the initial selection immediately so a keypress that arrives
    // before the first render already has a target.
    try {
      computeView();
    } catch {
      // the defensive render below reports the failure
    }

    // Repaint tick (spinner + elapsed), same discipline as the widget shell:
    // the interval lives exactly as long as the component, and unref keeps a
    // repaint timer from holding the process open.
    interval = setInterval(() => {
      try {
        frame = (frame + 1) % PANEL_RUNNING_FRAMES.length;
        tui.requestRender?.();
      } catch (err) {
        console.error(`PiCC subagent panel tick failed: ${(err as Error).message}`);
      }
    }, this.tickMs);
    interval.unref?.();

    const requestRepaint = (): void => {
      if (tornDown) return;
      try {
        tui.requestRender?.();
      } catch {
        // repaint is best-effort
      }
    };
    try {
      unsubscribeRegistry = this.deps.registry.onChange(requestRepaint);
    } catch {
      // The periodic tick remains a display-only fallback.
    }
    try {
      unsubscribeTasks = this.deps.onTasksChange?.(requestRepaint);
    } catch {
      // The periodic tick remains a display-only fallback.
    }

    const requestPanelStop = (record: SubagentRegistryRecord, taskId: string): void => {
      const label = sanitizeLine(record.agentName, NOTICE_LABEL_CAP) || "agent";
      if (!this.deps.retainedOutcomes || !record.checkpointPaused) {
        this.stopAgent(record, taskId);
        notify(panelNoticeStopRequested(label));
        return;
      }
      const bestEffortNotify = (message: string): void => {
        try { notify(message); } catch { /* notification is never lifecycle authority */ }
      };
      let stopping: void | Promise<void | { disposition?: "provisional" | "confirmed" | "unconfirmed" }>;
      try {
        stopping = this.stopAgent(record, taskId);
      } catch (error) {
        this.deps.registry.quarantineCheckpoint(record.agentId);
        const report = this.deps.registry.get(record.agentId)?.retainedInputReport;
        bestEffortNotify(`Stop request for ${label} has unconfirmed cleanup: ${sanitizeLine((error as Error).message, NOTICE_LABEL_CAP)}. Do not retry in this process. Exit PiCC completely, start a fresh process and session, and inspect the transcript, worktree, and possible effects.${report ? ` ${retainedInputCount(report)} retained input occurrence(s); canonical report: ${taskOutputAgentLocator(record.agentId)}.` : " No canonical retained-input report exists."}`);
        return;
      }
      const settlement = Promise.resolve(stopping).then((result) => {
        const current = this.deps.registry.get(record.agentId);
        const report = current?.retainedInputReport;
        if (result?.disposition !== "confirmed" || current?.checkpointStopState !== "confirmed" ||
            current.checkpointQuarantined || !report) {
          this.deps.registry.quarantineCheckpoint(record.agentId);
          bestEffortNotify(`Stop disposition for ${label} is unconfirmed. Do not retry in this process. Exit PiCC completely, start a fresh process and session, and inspect the transcript, worktree, and possible effects.${report ? ` ${retainedInputCount(report)} retained input occurrence(s); canonical report: ${taskOutputAgentLocator(record.agentId)}.` : " No canonical retained-input report exists."}`);
          return;
        }
        this.deps.registry.markUserStopped(record.agentId);
        bestEffortNotify(`Stop confirmed for ${label}. ${retainedInputCount(report)} retained input occurrence(s); ${taskOutputAgentLocator(record.agentId)}. Reported input was not auto-replayed; inspect possible existing effects before deliberate retry.`);
      }, (error) => {
        this.deps.registry.quarantineCheckpoint(record.agentId);
        const report = this.deps.registry.get(record.agentId)?.retainedInputReport;
        bestEffortNotify(`Stop settlement for ${label} has unconfirmed cleanup: ${sanitizeLine((error as Error).message, NOTICE_LABEL_CAP)}. Do not retry in this process. Exit PiCC completely, start a fresh process and session, and inspect the transcript, worktree, and possible effects.${report ? ` ${retainedInputCount(report)} retained input occurrence(s); canonical report: ${taskOutputAgentLocator(record.agentId)}.` : " No canonical retained-input report exists."}`);
      });
      void settlement.catch(() => undefined);
      bestEffortNotify(panelNoticeStopSettling(label));
    };

    /**
     * Action shared by `x`/`d` in the list and `ctrl+x` in the drill-down —
     * identical re-resolve/stale semantics on every surface.
     */
    const actOnKey = (key: PanelSelectionKey, mode: "context" | "dismiss"): void => {
      const target = this.resolveTarget(key);
      switch (target.kind) {
        case "running-background":
          if (mode === "dismiss") {
            notify(PANEL_NOTICE_RUNNING_DISMISS);
            return;
          }
          requestPanelStop(target.record, target.taskId);
          return;
        case "running-foreground":
          notify(mode === "dismiss" ? PANEL_NOTICE_RUNNING_DISMISS : PANEL_NOTICE_FOREGROUND);
          return;
        case "settled":
          this.dismissed.add(target.keyId);
          return;
        case "stale":
          notify(PANEL_NOTICE_STALE);
          return;
      }
    };
    const act = (mode: "context" | "dismiss"): void => {
      const key = model.selection();
      if (!key) return;
      actOnKey(key, mode);
    };

    const stopAll = (): void => {
      // Targets are collected at THIS keypress, so the confirming press stops
      // exactly what is active now, not what was active when it armed.
      const targets = this.collectStopAllTargets();
      if (targets.length === 0) {
        stopAllArmedAt = undefined;
        notify(PANEL_NOTICE_STOP_ALL_NONE);
        return;
      }
      const now = this.nowFn();
      if (stopAllArmedAt !== undefined && now - stopAllArmedAt <= STOP_ALL_CONFIRM_MS) {
        stopAllArmedAt = undefined;
        if (this.deps.retainedOutcomes) {
          const ordinary = targets.filter((target) => !target.record.checkpointPaused);
          const checkpoint = targets.filter((target) => target.record.checkpointPaused);
          for (const target of ordinary) this.stopAgent(target.record, target.taskId);
          for (const target of checkpoint) requestPanelStop(target.record, target.taskId);
          if (ordinary.length > 0) {
            try { notify(panelNoticeStopAllDone(ordinary.length)); } catch { /* lifecycle settlement is authoritative */ }
          }
        } else {
          for (const target of targets) this.stopAgent(target.record, target.taskId);
          notify(panelNoticeStopAllDone(targets.length));
        }
        return;
      }
      stopAllArmedAt = now;
      notify(panelNoticeStopAllArmed(targets.length));
    };

    const enter = (): void => {
      const key = model.selection();
      if (!key) return;
      const target = this.resolveTarget(key);
      if (target.kind === "stale") {
        notify(PANEL_NOTICE_STALE);
        return;
      }
      detail = {
        key,
        agentId: target.record.agentId,
        ui: {
          promptExpanded: false,
          scrollTop: 0,
          // Running opens onto structured live detail (auto-following); finished
          // opens at the top, where the outcome-aware output leads.
          follow: target.record.state === "running",
          steerBuffer: "",
        },
        lastObservedState: target.record.state,
        lastMaxScroll: 0,
      };
      viewMode = "detail";
      selectedRowVisible = false;
    };

    /** Leave the drill-down for the list. */
    const exitDetail = (): void => {
      detail = undefined;
      viewMode = "list";
      selectedRowVisible = false;
    };

    const scrollDetail = (delta: number): void => {
      const d = detail!;
      const max = d.lastMaxScroll;
      const current = d.ui.follow ? max : Math.min(d.ui.scrollTop, max);
      const next = Math.max(0, Math.min(max, current + delta));
      d.ui.scrollTop = next;
      // Follow re-engages only at the bottom; a scrolled-back view stays
      // anchored so incoming lines don't yank the reader down.
      d.ui.follow = next >= max;
    };

    const sendSteer = (): void => {
      const d = detail!;
      const text = d.ui.steerBuffer;
      if (!text.trim()) return;
      const guarded = this.resolveSteerTarget(d.key);
      if (!guarded.ok) {
        d.ui.steerBuffer = "";
        d.ui.notice = sanitizeLine(guarded.refusal, DETAIL_NOTICE_CAP);
        return;
      }
      // Deliberately NO UserPromptSubmit hook here — a PiCC decision, not a
      // parity claim: those hooks fire on the MAIN session's prompt turns
      // (the `input` handler in src/index.ts), and Claude Code leaves its
      // steering hook behavior undocumented, so PiCC pins "steer text goes
      // straight to the running session" rather than inventing a contract.
      try {
        // The ONLY delivery path is the guard's bound steer fn — a caller
        // that passed the guard cannot reach a different session.
        const delivered = guarded.steer(text);
        Promise.resolve(delivered).catch((err) => {
          // The rejection can land after this DetailState was detached (view
          // exited, or exited and re-entered — a NEW state object by then):
          // never write the failure notice into a dead state or bleed it into
          // a later drill-down.
          if (detail !== d) return;
          d.ui.notice = sanitizeLine(
            detailSteerFailed((err as Error)?.message ?? "unknown error"),
            DETAIL_NOTICE_CAP,
          );
          try {
            tui.requestRender?.();
          } catch {
            // repaint is best-effort
          }
        });
        d.ui.steerBuffer = "";
        d.ui.notice = DETAIL_STEER_SENT;
      } catch (err) {
        d.ui.notice = sanitizeLine(
          detailSteerFailed((err as Error)?.message ?? "unknown error"),
          DETAIL_NOTICE_CAP,
        );
      }
    };

    const handleDetailKey = (data: string, matches: (id: string) => boolean): void => {
      const d = detail!;
      if (matches("tui.select.up")) {
        scrollDetail(-1);
        return;
      }
      if (matches("tui.select.down")) {
        scrollDetail(1);
        return;
      }
      if (matches("tui.select.confirm") || data === "\r" || data === "\n") {
        sendSteer();
        return;
      }
      if (data === CTRL_X_BYTE) {
        actOnKey(d.key, "context");
        return;
      }
      if (data === CTRL_P_BYTE) {
        d.ui.promptExpanded = !d.ui.promptExpanded;
        if (d.ui.promptExpanded) {
          // The expanded prompt sits at the TOP of the scrollable body — jump
          // there, or the expansion would be invisible under a following tail.
          d.ui.follow = false;
          d.ui.scrollTop = 0;
        } else if (d.lastObservedState === "running") {
          d.ui.follow = true;
        }
        return;
      }
      if (data === BACKSPACE_DEL || data === BACKSPACE_BS) {
        d.ui.notice = undefined;
        d.ui.steerBuffer = [...d.ui.steerBuffer].slice(0, -1).join("");
        return;
      }
      // Paste flatten, for MULTI-character chunks only: a chunk with several
      // code points is pasted text, so its newlines/tabs become single spaces
      // BEFORE the control-byte check — a multi-line paste enters the buffer
      // instead of vanishing silently. Single characters keep their exact key
      // meanings (lone \r is the send key above; lone \t stays excluded), and
      // chords/bracketed-paste framing carry OTHER control bytes, so they
      // still fall through isTypedText unchanged.
      const text =
        [...data].length > 1 ? data.replace(/\r\n|[\r\n\t]/g, " ") : data;
      if (!isTypedText(text)) return;
      // Typed text reaches the buffer only while steering is actually
      // available; otherwise the rendered "steering unavailable (…)" line
      // explains the inert keys — text is never accepted into a buffer that
      // cannot send.
      const guarded = this.resolveSteerTarget(d.key);
      if (!guarded.ok) {
        d.ui.notice = sanitizeLine(guarded.refusal, DETAIL_NOTICE_CAP);
        return;
      }
      d.ui.notice = undefined;
      d.ui.steerBuffer = [...`${d.ui.steerBuffer}${text}`].slice(0, STEER_INPUT_CAP).join("");
    };

    const renderDetailView = (width: number): string[] => {
      const d = detail!;
      const data = this.detailData(d.agentId);
      // Live state changes while open are narrated, never a crash/freeze: the
      // banner pins the transition and the layout/anchor follow the new state.
      const observed: DetailState["lastObservedState"] = data.record
        ? data.taskStatus === "stopped" ? "settled" : data.record.state
        : "gone";
      if (observed !== d.lastObservedState) {
        if (observed === "gone") {
          d.ui.banner = DETAIL_BANNER_VANISHED;
          // The vanished view renders no steer line, so buffered text would
          // make the first Esc (clear-buffer-first semantics) look dead —
          // there is nothing to send it to anyway.
          d.ui.steerBuffer = "";
        } else if (observed === "settled") {
          d.ui.banner = data.taskStatus === "stopped" || data.record?.userStopped || data.record?.outcome === "aborted"
            ? DETAIL_BANNER_STOPPED
            : data.record?.outcome === "failed"
              ? DETAIL_BANNER_FAILED
              : DETAIL_BANNER_SETTLED;
          // The finished layout leads with outcome-aware output — jump to it.
          d.ui.follow = false;
          d.ui.scrollTop = 0;
        } else {
          d.ui.banner = DETAIL_BANNER_RESUMED;
          d.ui.follow = true;
          // Re-key the stored selection to the resume's newest task
          // generation (when one resolves): the header shows the new task id
          // and the banner announces the resume, so the advertised
          // `ctrl+x stop` must act on the DISPLAYED generation — the old key
          // would hit the stale-generation refusal instead.
          if (data.taskId) d.key = { kind: "task", taskId: data.taskId };
        }
        d.lastObservedState = observed;
      }
      const rendered = renderSubagentDetail(
        { ...data, nowMs: this.nowFn() },
        d.ui,
        { width, theme, runningFrame: PANEL_RUNNING_FRAMES[frame] },
      );
      d.lastMaxScroll = rendered.maxScroll;
      return rendered.lines;
    };

    return {
      render: (width: number): string[] => {
        // Defensive render: pi-tui kills the process on a throwing render.
        try {
          if (viewMode === "detail" && detail) {
            selectedRowVisible = false;
            return renderDetailView(width);
          }
          const view = computeView();
          if (view.empty) {
            selectedRowVisible = false;
            // Every row dismissed/gone while focused: keep a visible line so
            // the user is never left holding focus on an invisible component.
            return clampLines([themedFg(theme, "muted", PANEL_FOCUSED_EMPTY_LINE)], width);
          }
          const lines = renderSubagentPanel(view, {
            width,
            theme,
            runningFrame: PANEL_RUNNING_FRAMES[frame],
            entryChord: PANEL_ENTRY_CHORD,
          });
          // The marker is emitted only by the real row profile and survives
          // the final clamp only when the selected target is actually visible.
          selectedRowVisible = lines.some((line) => line.includes("❯"));
          return lines;
        } catch (err) {
          selectedRowVisible = false;
          console.error(`PiCC subagent panel render failed: ${(err as Error).message}`);
          // Same rationale as the empty view: never leave the user holding
          // focus on an INVISIBLE component — plain text, no theme call that
          // could itself throw.
          return [PANEL_FOCUSED_EMPTY_LINE.slice(0, Math.max(0, width))];
        }
      },
      handleInput: (data: string): void => {
        // Defensive input: no key, registry state, or mid-race record shape
        // may wedge the component — an unexpected error CLOSES it (restoring
        // editor focus) rather than trapping the keyboard.
        try {
          const matches = (id: string): boolean => {
            try {
              return keybindings?.matches?.(data, id) === true;
            } catch {
              return false;
            }
          };
          // Esc first, with a raw-byte fallback so the component stays
          // escapable even if the keybindings surface is broken.
          if (matches("tui.select.cancel") || data === ESC_BYTE) {
            if (viewMode === "detail") {
              // Pinned Esc semantics with a non-empty steer buffer: the first
              // Esc cancels the in-progress text (standard input-cancel), the
              // next steps back — Esc never both discards text AND changes
              // view in one press, and the ladder stays fully walkable.
              if (detail && detail.ui.steerBuffer.length > 0) {
                detail.ui.steerBuffer = "";
                detail.ui.notice = undefined;
                return;
              }
              exitDetail();
            } else {
              close();
            }
            return;
          }
          if (viewMode === "detail") {
            if (!detail) {
              viewMode = "list"; // defensive: never wedge on a stateless detail
              return;
            }
            handleDetailKey(data, matches);
            return;
          }
          if (matches("tui.select.up")) {
            computeView();
            model.moveSelection(-1);
            selectedRowVisible = false;
            return;
          }
          if (matches("tui.select.down")) {
            computeView();
            model.moveSelection(1);
            selectedRowVisible = false;
            return;
          }
          const confirm = matches("tui.select.confirm");
          const rowAction = confirm || data === "x" || data === "X" || data === "d";
          if (rowAction && !selectedRowVisible) {
            notify(PANEL_NOTICE_RESIZE_ACTION);
            return;
          }
          if (confirm) {
            enter();
            return;
          }
          if (data === "x") act("context");
          else if (data === "X") stopAll();
          else if (data === "d") act("dismiss");
        } catch (err) {
          console.error(`PiCC subagent panel input failed: ${(err as Error).message}`);
          close();
        }
      },
      dispose: (): void => {
        teardown();
      },
    };
  }
}

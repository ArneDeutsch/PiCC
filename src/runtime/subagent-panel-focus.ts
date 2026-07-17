import type { SubagentRegistry, SubagentRegistryRecord } from "./subagent-registry.js";
import {
  SubagentPanelModel,
  newestTaskByAgent,
  selectionKeyId,
  type PanelSelectionKey,
  type PanelTaskInfo,
  type PanelViewModel,
} from "./subagent-panel-model.js";
import { PANEL_RUNNING_FRAMES, renderSubagentPanel } from "./subagent-panel-render.js";
import { clampLines, themedFg } from "./render-util.js";
import { sanitizeLine } from "./subagent-progress.js";
import { PANEL_ENTRY_CHORD, PANEL_TICK_MS } from "./subagent-panel-widget.js";

/**
 * Focused subagent panel: the `ctx.ui.custom` component behind the panel-entry
 * chord. Owns keyboard focus while open — arrow selection, stop/dismiss/
 * stop-all actions, and the Esc ladder — and suppresses the passive widget so
 * the agent list is never shown twice. All display logic stays in the pure
 * model/renderer; this shell owns key handling and action targeting.
 */

/** Raw ESC byte, kept off string escapes so the source stays pure ASCII. */
const ESC_BYTE = String.fromCharCode(27);

/** Second `X` within this window confirms stop-all (Claude Code's own pattern). */
export const STOP_ALL_CONFIRM_MS = 3000;

/** Render-side cap for an agent name interpolated into a status notice. */
const NOTICE_LABEL_CAP = 60;

// --- status-line notice wordings (exported so tests pin the exact strings) ---

export const PANEL_NOTICE_EMPTY = "No subagents this session.";
/** A keypress whose selection no longer resolves to a current row refuses. */
export const PANEL_NOTICE_STALE = "That agent row changed — no action taken.";
export const PANEL_NOTICE_FOREGROUND =
  "Foreground agents cannot be stopped from the panel — Esc in the editor cancels the whole turn.";
export const PANEL_NOTICE_RUNNING_DISMISS = "Still running — press x to stop it first.";
export const PANEL_NOTICE_STOP_ALL_NONE = "No running background agents to stop.";

export function panelNoticeStopRequested(label: string): string {
  return `Stop requested for ${label} — it will settle as aborted.`;
}
export function panelNoticeStopAllArmed(n: number): string {
  return `Press X again to stop ${n} running background agent${n === 1 ? "" : "s"}.`;
}
export function panelNoticeStopAllDone(n: number): string {
  return `Stop requested for ${n} background agent${n === 1 ? "" : "s"}.`;
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
  /**
   * Task-side user stop (`BackgroundTaskRegistry.markUserStopped` in
   * production) — every panel stop pairs it with
   * `SubagentRegistry.markUserStopped` so user-stop permanence holds on both
   * registries.
   */
  stopTask: (taskId: string) => void;
  /** The passive widget's suppression seam: hidden while this panel is open. */
  widget: { setSuppressed(on: boolean): void };
  /** Injected clock (tests); defaults to Date.now. */
  now?: () => number;
  tickMs?: number;
  /**
   * Drill-down seam: the detail-view renderer. When present, Enter on a
   * resolvable row switches the component's internal view to "detail",
   * rendered through this function with the stored selection key; Esc pops
   * back to the list. Absent, Enter only stores the selection (a no-op stub).
   */
  renderDetail?: (key: PanelSelectionKey, width: number, theme: unknown) => string[];
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
      // Empty probe on a throwaway model: the component's own model must not
      // exist yet (its focused view would freeze linger removals).
      const probe = new SubagentPanelModel({ now: () => this.nowFn() });
      const probeView = probe.view({
        records: this.deps.registry.list(),
        tasks: this.deps.tasks(),
        focused: false,
        dismissed: this.dismissed,
      });
      if (probeView.empty) {
        notify(PANEL_NOTICE_EMPTY);
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
      // fork-Esc watch for the rest of the session).
      try {
        const opened = Promise.resolve(
          ui.custom((tui, theme, keybindings, done) =>
            this.createComponent({ tui, theme, keybindings, done, notify }),
          ),
        );
        opened.then(cleanup, (err) => {
          cleanup();
          console.error(`PiCC subagent panel closed with an error: ${(err as Error).message}`);
        });
      } catch (err) {
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
        return record.state === "running"
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
   * The full single-stop semantics, applied identically by `x` and stop-all:
   * the agent-side permanence marker FIRST (so a racing settlement already
   * sees `userStopped`), then the task-side marker+abort, which drives the
   * normal aborted settlement notice to the model.
   */
  private stopAgent(record: SubagentRegistryRecord, taskId: string): void {
    this.deps.registry.markUserStopped(record.agentId);
    this.deps.stopTask(taskId);
  }

  /** Running background agents (newest generation each) — stop-all's targets. */
  private collectStopAllTargets(): Array<{ record: SubagentRegistryRecord; taskId: string }> {
    const byAgent = newestTaskByAgent(this.deps.tasks());
    const targets: Array<{ record: SubagentRegistryRecord; taskId: string }> = [];
    for (const record of this.deps.registry.list()) {
      if (!record || record.state !== "running" || record.userStopped) continue;
      const task = byAgent.get(record.agentId);
      if (!task) continue; // foreground — panel stop is background-only in v1
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
    let detailKey: PanelSelectionKey | undefined;
    let stopAllArmedAt: number | undefined;

    const close = (): void => {
      if (closed) return;
      // Latch only AFTER done() returns: if Pi's done throws once, a later
      // Esc/error path must be able to retry the close — a pre-latched flag
      // would wedge the component with focus held and openFlag stuck.
      try {
        done(undefined);
        closed = true;
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
    const interval = setInterval(() => {
      try {
        frame = (frame + 1) % PANEL_RUNNING_FRAMES.length;
        tui.requestRender?.();
      } catch (err) {
        console.error(`PiCC subagent panel tick failed: ${(err as Error).message}`);
      }
    }, this.tickMs);
    interval.unref?.();

    /** Action shared by `x` (context) and `d` (dismiss-only). */
    const act = (mode: "context" | "dismiss"): void => {
      const key = model.selection();
      if (!key) return;
      const target = this.resolveTarget(key);
      switch (target.kind) {
        case "running-background":
          if (mode === "dismiss") {
            notify(PANEL_NOTICE_RUNNING_DISMISS);
            return;
          }
          this.stopAgent(target.record, target.taskId);
          notify(
            panelNoticeStopRequested(
              sanitizeLine(target.record.agentName, NOTICE_LABEL_CAP) || "agent",
            ),
          );
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

    const stopAll = (): void => {
      // Targets are collected at THIS keypress, so the confirming press stops
      // exactly what is running now, not what was running when it armed.
      const targets = this.collectStopAllTargets();
      if (targets.length === 0) {
        stopAllArmedAt = undefined;
        notify(PANEL_NOTICE_STOP_ALL_NONE);
        return;
      }
      const now = this.nowFn();
      if (stopAllArmedAt !== undefined && now - stopAllArmedAt <= STOP_ALL_CONFIRM_MS) {
        stopAllArmedAt = undefined;
        for (const target of targets) this.stopAgent(target.record, target.taskId);
        notify(panelNoticeStopAllDone(targets.length));
        return;
      }
      stopAllArmedAt = now;
      notify(panelNoticeStopAllArmed(targets.length));
    };

    const enter = (): void => {
      const key = model.selection();
      if (!key) return;
      if (this.resolveTarget(key).kind === "stale") {
        notify(PANEL_NOTICE_STALE);
        return;
      }
      detailKey = key;
      // Without a wired detail view (the drill-down task's seam), Enter only
      // stores the selection.
      if (this.deps.renderDetail) viewMode = "detail";
    };

    return {
      render: (width: number): string[] => {
        // Defensive render: pi-tui kills the process on a throwing render.
        try {
          if (viewMode === "detail" && detailKey && this.deps.renderDetail) {
            return clampLines(this.deps.renderDetail(detailKey, width, theme), width);
          }
          const view = computeView();
          if (view.empty) {
            // Every row dismissed/gone while focused: keep a visible line so
            // the user is never left holding focus on an invisible component.
            return clampLines([themedFg(theme, "muted", PANEL_FOCUSED_EMPTY_LINE)], width);
          }
          return renderSubagentPanel(view, {
            width,
            theme,
            runningFrame: PANEL_RUNNING_FRAMES[frame],
            entryChord: PANEL_ENTRY_CHORD,
          });
        } catch (err) {
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
            if (viewMode === "detail") viewMode = "list";
            else close();
            return;
          }
          if (viewMode === "detail") return; // drill-down keys are the detail task's
          if (matches("tui.select.up")) {
            computeView();
            model.moveSelection(-1);
            return;
          }
          if (matches("tui.select.down")) {
            computeView();
            model.moveSelection(1);
            return;
          }
          if (matches("tui.select.confirm")) {
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
        clearInterval(interval);
      },
    };
  }
}

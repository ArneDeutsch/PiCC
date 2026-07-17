import type { SubagentRegistry } from "./subagent-registry.js";
import {
  SubagentPanelModel,
  type PanelTaskInfo,
  type PanelViewModel,
} from "./subagent-panel-model.js";
import { PANEL_RUNNING_FRAMES, renderSubagentPanel } from "./subagent-panel-render.js";

/**
 * Subagent status-panel widget shell: wires the pure panel model/renderer into
 * Pi's `belowEditor` widget surface. Deliberately thin — data join, the ~1s
 * animation/expiry tick, and install/remove lifecycle live here; every display
 * decision lives in subagent-panel-model.ts / subagent-panel-render.ts.
 *
 * Installed ONLY in interactive TUI mode (the caller gates on
 * `ctx.mode === "tui"`); in print/RPC the controller is constructed but never
 * attached, so it holds no timer and touches no UI.
 */

/**
 * The panel-entry keyboard chord, as Pi's `registerShortcut` KeyId and as the
 * literal text of rendered hint lines. MUST stay a compile-time string literal:
 * it is interpolated into hint lines unsanitized by design (`alt+a` avoids
 * every built-in Pi binding; users can still shadow it via keybindings.json).
 */
export const PANEL_ENTRY_CHORD = "alt+a";

/** The `setWidget` key of the passive status panel. */
export const SUBAGENT_PANEL_WIDGET_KEY = "picc-subagent-panel";

/** Tick period: once per second animates the spinner and elapsed column. */
export const PANEL_TICK_MS = 1000;

/** The widget/tui/component surfaces the shell touches, structurally. */
export interface PanelWidgetComponent {
  render(width: number): string[];
  dispose?(): void;
}
export interface PanelTuiPort {
  requestRender(): void;
}
export interface PanelWidgetUiPort {
  setWidget(
    key: string,
    content: ((tui: PanelTuiPort, theme: unknown) => PanelWidgetComponent) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

export interface SubagentPanelWidgetDeps {
  /** The dispatch registry: rows + the onChange seam driving install/repaint. */
  registry: SubagentRegistry;
  /** Background-task join info in registration order (newest generation last). */
  tasks: () => readonly PanelTaskInfo[];
  /** Injected clock (tests); defaults to Date.now. */
  now?: () => number;
  tickMs?: number;
  /**
   * Panel-local dismissals from the focus controller (`selectionKeyId`
   * strings), read lazily per view: without it a row dismissed in the focused
   * panel would re-appear here after the panel closes, until its linger
   * expired.
   */
  dismissed?: () => ReadonlySet<string>;
  /**
   * Render seam, defaulting to the real renderer. Exists so the
   * defensive-render test can inject a throwing stub and prove the shell
   * catches it — an uncaught throw from a widget render kills Pi's whole
   * render loop (see "Rules to copy" in doc/tui-extension-guide.md).
   */
  render?: typeof renderSubagentPanel;
}

export class SubagentPanelWidgetController {
  private readonly deps: SubagentPanelWidgetDeps;
  private readonly model: SubagentPanelModel;
  private nowFn: () => number;
  private tickMs: number;
  private ui: PanelWidgetUiPort | undefined;
  private activeTui: PanelTuiPort | undefined;
  private installed = false;
  private suppressed = false;
  private subscribed = false;

  constructor(deps: SubagentPanelWidgetDeps) {
    this.deps = deps;
    this.nowFn = deps.now ?? Date.now;
    this.tickMs = deps.tickMs ?? PANEL_TICK_MS;
    // The model reads the clock through the controller so configureForTest can
    // swap it after construction.
    this.model = new SubagentPanelModel({ now: () => this.nowFn() });
  }

  /**
   * Wire the TUI surface (session_start, `ctx.mode === "tui"` only — the
   * caller owns that gate). Idempotent: the registry subscription is taken
   * once; a re-attach (session resume/new) re-points the UI handle. Installs
   * immediately when agents are already visible.
   */
  attach(ui: PanelWidgetUiPort): void {
    if (this.ui !== ui) {
      // A stale widget on a replaced UI would leak its interval — drop it first.
      this.remove();
      this.ui = ui;
    }
    if (!this.subscribed) {
      this.subscribed = true;
      this.deps.registry.onChange(() => this.sync());
    }
    this.sync();
  }

  /**
   * Suppression seam for the focused panel component (t05): while the
   * interactive list/drill-down is open the passive widget is hidden, so the
   * user never sees the agent list twice. Unsuppressing re-installs when rows
   * are visible.
   */
  setSuppressed(on: boolean): void {
    this.suppressed = on;
    this.sync();
  }

  /**
   * TEST-ONLY (reached via the in-process `onWired` seam, mirroring
   * `setSdkForTest`): inject the panel clock and/or tick period so linger
   * expiry is observable without fake timers around async dispatches.
   */
  configureForTest(opts: { now?: () => number; tickMs?: number }): void {
    if (opts.now) this.nowFn = opts.now;
    if (opts.tickMs !== undefined) this.tickMs = opts.tickMs;
  }

  private view(): PanelViewModel {
    return this.model.view({
      records: this.deps.registry.list(),
      tasks: this.deps.tasks(),
      focused: false,
      dismissed: this.deps.dismissed?.(),
    });
  }

  /**
   * Reconcile widget presence with the model: called on attach, every registry
   * change, and suppression flips (the tick handles time-driven emptiness).
   * Never throws — a display failure must not corrupt the registry mutation
   * that notified us.
   */
  private sync(): void {
    if (!this.ui) return;
    try {
      if (this.suppressed || this.view().empty) {
        this.remove();
        return;
      }
      if (this.installed) {
        this.activeTui?.requestRender();
        return;
      }
      this.ui.setWidget(SUBAGENT_PANEL_WIDGET_KEY, (tui, theme) => this.createComponent(tui, theme), {
        placement: "belowEditor",
      });
      this.installed = true;
    } catch (err) {
      console.error(`PiCC subagent panel update failed: ${(err as Error).message}`);
    }
  }

  private remove(): void {
    if (!this.installed) return;
    // Flip BEFORE setWidget: Pi disposes the component synchronously and a
    // reentrant sync must not see a half-removed widget as installed.
    this.installed = false;
    try {
      this.ui?.setWidget(SUBAGENT_PANEL_WIDGET_KEY, undefined);
    } catch (err) {
      console.error(`PiCC subagent panel update failed: ${(err as Error).message}`);
    }
  }

  /**
   * The widget component. Holds the ONLY timer: created when Pi invokes the
   * factory (synchronously inside setWidget), cleared in dispose() — so the
   * interval exists exactly while the widget does. Each tick advances the
   * spinner and repaints; a tick that finds the view empty (linger expired)
   * removes the widget instead, which disposes this component.
   */
  private createComponent(tui: PanelTuiPort, theme: unknown): PanelWidgetComponent {
    this.activeTui = tui;
    let frame = 0;
    const interval = setInterval(() => {
      try {
        frame = (frame + 1) % PANEL_RUNNING_FRAMES.length;
        if (this.suppressed || this.view().empty) this.remove();
        else tui.requestRender();
      } catch (err) {
        console.error(`PiCC subagent panel tick failed: ${(err as Error).message}`);
      }
    }, this.tickMs);
    // Never hold the process open for a repaint timer (belt to dispose()).
    interval.unref?.();
    const render = this.deps.render ?? renderSubagentPanel;
    return {
      render: (width: number): string[] => {
        // Defensive render: pi-tui runs this inside its render loop with no
        // try/catch of its own — a throw here would kill the process. Log and
        // render empty instead.
        try {
          const view = this.view();
          if (view.empty) return [];
          return render(view, {
            width,
            theme,
            runningFrame: PANEL_RUNNING_FRAMES[frame],
            entryChord: PANEL_ENTRY_CHORD,
          });
        } catch (err) {
          console.error(`PiCC subagent panel render failed: ${(err as Error).message}`);
          return [];
        }
      },
      dispose: () => {
        clearInterval(interval);
        if (this.activeTui === tui) this.activeTui = undefined;
      },
    };
  }
}

/** The one-time chat hint advertising the panel-entry chord. */
export function panelHintText(runningCount: number, chord: string): string {
  return `${runningCount} agents running — press ${chord} to manage`;
}

export interface PanelHintEmitterDeps {
  /** The entry chord to advertise (PANEL_ENTRY_CHORD in production). */
  chord: string;
  /** TUI gate: the hint is for an interactive user; print/RPC emit nothing. */
  isTui: () => boolean;
  /** The delivery channel (the wiring task owns choosing it). */
  emit: (text: string) => void;
}

/**
 * Gated emitter for the one-time panel hint. Call it with the current running
 * agent count whenever that count may have grown; it emits at most once per
 * emitter (= per session), only in TUI mode, and only when MORE THAN ONE agent
 * runs concurrently (a single dispatch needs no fan-out management, and the
 * unfocused panel hint line already advertises the chord). A gated-off call
 * does not consume the once-gate. Built here so the gating is testable; the
 * panel-focus task wires the call site — the hint must not appear before the
 * chord actually works.
 */
export function createPanelHintEmitter(deps: PanelHintEmitterDeps): (runningCount: number) => void {
  let emitted = false;
  return (runningCount: number): void => {
    if (emitted || runningCount <= 1 || !deps.isTui()) return;
    emitted = true;
    deps.emit(panelHintText(runningCount, deps.chord));
  };
}

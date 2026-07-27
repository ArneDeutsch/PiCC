import { deferred, waitUntil, type Deferred } from "./async.js";

/** One recorded `ctx.ui.setStatus` call (clears record `text: undefined`). */
export interface FakeStatusCall {
  key: string;
  text: string | undefined;
}

/** One recorded `ctx.ui.setWidget` call (removals record `content: undefined`). */
export interface FakeWidgetCall {
  key: string;
  content: unknown;
  options?: any;
}

/** A live widget: component factories are invoked SYNCHRONOUSLY, as real Pi does. */
export interface FakeWidgetInstance {
  key: string;
  content: unknown;
  options?: any;
  /** The instantiated component when `content` was a factory. */
  component?: { render(width: number): string[]; dispose?(): void };
  /** Flipped when the widget is removed/replaced (Pi calls dispose then). */
  disposed: boolean;
  render(width: number): string[];
}

/** A recorded `ctx.ui.custom` invocation, drivable end to end. */
export interface FakeCustomInvocation {
  options?: any;
  /** Resolves when the (possibly async) factory has produced the component. */
  ready: Promise<void>;
  /** Resolves with the value the component passes to `done()`. */
  result: Promise<unknown>;
  component?: {
    render(width: number): string[];
    handleInput?(data: string): void;
    dispose?(): void;
  };
  closed: boolean;
  /** Feed raw key bytes to the focused component (Pi routes input to it). */
  input(data: string): void;
  render(width: number): string[];
}

/** A fake Pi ExtensionAPI capturing everything the PiCC extension registers. */
export interface FakePi {
  api: Record<string, unknown>;
  tools: Map<string, any>;
  /** Active names are separate from registered definitions, as in Pi's registry. */
  activeTools: Set<string>;
  commands: Map<string, any>;
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  messages: Array<{ message: any; options?: any }>;
  userMessages: Array<{ content: any; options?: any }>;
  entries: Array<{ customType: string; data: any }>;
  entryRenderers: Map<string, (entry: any, options: any, theme: any) => any>;
  /**
   * Custom-MESSAGE renderers registered via `pi.registerMessageRenderer`
   * (real Pi records them into `Extension.messageRenderers` and
   * CustomMessageComponent invokes them with `(message, { expanded }, theme)`
   * — pinned in test/pi-contract.test.ts). Recorded so wiring tests can drive
   * the registered renderer against a recorded `sendMessage` payload.
   */
  messageRenderers: Map<string, (message: any, options: any, theme: any) => any>;
  notifications: Array<{ text: string; severity?: string }>;
  /** Every `ctx.ui.setStatus` call in order, including clears. */
  statusCalls: FakeStatusCall[];
  modelSets: unknown[];
  thinkingLevels: string[];
  providerRegistrations: Array<{ name: string; config: any }>;
  abortCalls: number;
  editorText: string;
  /** Shortcuts registered via `pi.registerShortcut`, keyed by KeyId. */
  shortcuts: Map<string, { description?: string; handler: (ctx: any) => unknown }>;
  /** Currently-installed widgets by key (removed keys are deleted). */
  widgets: Map<string, FakeWidgetInstance>;
  /** Every `setWidget` call in order, including removals. */
  widgetCalls: FakeWidgetCall[];
  /** Every `ctx.ui.custom` invocation in order. */
  customs: FakeCustomInvocation[];
  /** Live `ctx.ui.onTerminalInput` handlers (unsubscribed ones are removed). */
  terminalInputHandlers: Array<
    (data: string) => { consume?: boolean; data?: string } | undefined
  >;
  /** Drive the handler chain exactly as pi-tui does: consume stops, data rewrites. */
  feedTerminalInput(data: string): { consumed: boolean; data: string };
  /** `tui.requestRender()` calls observed from widget/custom components. */
  renderRequests: number;
  /**
   * The injectable keybinding stub behind the fake KeybindingsManager's
   * `matches(data, id)`: id → raw byte sequences. Ships the select-navigation
   * defaults (up/down/confirm/cancel); tests extend or override entries.
   */
  keymap: Record<string, string[]>;
  fire(event: string, evt?: any, ctx?: any): Promise<any>;
  ctx(overrides?: Record<string, unknown>): Record<string, unknown>;
  /** An interactive-TUI ctx: `mode: "tui"`, `hasUI: true`, the recording ui. */
  tuiCtx(overrides?: Record<string, unknown>): Record<string, unknown>;
  /**
   * A ctx modeling REAL Pi print mode (pinned in test/pi-contract.test.ts):
   * `mode: "print"`, `hasUI: false`, and a ui whose verbs are all PRESENT
   * (Pi's no-op UI context implements the full interface) — so mode, not
   * method presence, is the only valid interactivity gate. The verbs still
   * record here, so a wrongly-gated install is caught, not swallowed.
   */
  printCtx(overrides?: Record<string, unknown>): Record<string, unknown>;
  /**
   * A ctx modeling RPC mode — the gating trap: `hasUI: true` AND a working
   * `setWidget`, but `mode: "rpc"`. Only a `mode === "tui"` gate keeps
   * TUI-only chrome out of it.
   */
  rpcCtx(overrides?: Record<string, unknown>): Record<string, unknown>;
  /** Every `ctx.compact()` call recorded from any ctx this fake produces. */
  compactCalls: Array<unknown>;
  /** Wait until every named tool has been registered. */
  waitForTools(names: readonly string[]): Promise<void>;
  /** Capture the extension's observational detached-initialization completion. */
  captureInitialization(completion: Promise<void>): void;
  /** Wait for the completion callback to be captured and its promise to settle. */
  waitForInitialization(): Promise<void>;
}

export function fakePi(): FakePi {
  const tools = new Map<string, any>();
  const activeTools = new Set<string>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const messages: Array<{ message: any; options?: any }> = [];
  const userMessages: Array<{ content: any; options?: any }> = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const entryRenderers = new Map<string, (entry: any, options: any, theme: any) => any>();
  const messageRenderers = new Map<string, (message: any, options: any, theme: any) => any>();
  const notifications: Array<{ text: string; severity?: string }> = [];
  const statusCalls: FakeStatusCall[] = [];
  const modelSets: unknown[] = [];
  const thinkingLevels: string[] = [];
  const providerRegistrations: Array<{ name: string; config: any }> = [];
  const shortcuts = new Map<string, { description?: string; handler: (ctx: any) => unknown }>();
  const widgets = new Map<string, FakeWidgetInstance>();
  const widgetCalls: FakeWidgetCall[] = [];
  const customs: FakeCustomInvocation[] = [];
  const terminalInputHandlers: Array<
    (data: string) => { consume?: boolean; data?: string } | undefined
  > = [];
  const compactCalls: Array<unknown> = [];
  const toolWaiters = new Set<{ names: readonly string[]; signal: Deferred<void> }>();
  const hasTools = (names: readonly string[]) => names.every((name) => tools.has(name));
  const notifyToolWaiters = () => {
    for (const waiter of toolWaiters) {
      if (hasTools(waiter.names)) {
        toolWaiters.delete(waiter);
        waiter.signal.resolve();
      }
    }
  };
  const waitForTools = (names: readonly string[]): Promise<void> => {
    const expected = [...names];
    const waiter = { names: expected, signal: deferred<void>() };
    if (!hasTools(expected)) toolWaiters.add(waiter);
    return waitUntil({
      description: `tools to be registered: ${expected.join(", ") || "(none)"}`,
      predicate: () => hasTools(expected) || waiter.signal.promise.then(() => hasTools(expected)),
      describeObserved: () => {
        const registered = [...tools.keys()];
        const missing = expected.filter((name) => !tools.has(name));
        return `missing: ${missing.join(", ") || "(none)"}; registered: ${registered.join(", ") || "(none)"}`;
      },
    }).finally(() => toolWaiters.delete(waiter));
  };
  let initializationCompletion: Promise<void> | undefined;
  const captureInitialization = (completion: Promise<void>): void => {
    initializationCompletion = completion;
  };
  const waitForInitialization = (): Promise<void> => waitUntil({
    description: "extension detached initialization to be captured and settled",
    predicate: () => initializationCompletion?.then(() => true) ?? false,
    describeObserved: () => initializationCompletion === undefined
      ? "completion callback not captured"
      : "completion captured but still pending",
  });

  // The tui handed to widget/custom factories: repaint requests are counted.
  const fakeTui = {
    requestRender: () => {
      self.renderRequests++;
    },
  };
  // Identity theme: enough shape for null-guarded renderers, no ANSI noise.
  const fakeTheme = {
    fg: (_slot: string, text: string) => text,
    bg: (_slot: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
  };
  // KeybindingsManager stand-in for `custom` components: resolves matches()
  // through the injectable keymap (see FakePi.keymap).
  const fakeKeybindings = {
    matches: (data: string, id: string) => (self.keymap[id] ?? []).includes(data),
  };

  const setWidget = (key: string, content: unknown, options?: any): void => {
    widgetCalls.push({ key, content, options });
    // Pi disposes an existing component for the key BEFORE anything else.
    const existing = widgets.get(key);
    if (existing) {
      existing.disposed = true;
      existing.component?.dispose?.();
      widgets.delete(key);
    }
    if (content === undefined) return;
    const instance: FakeWidgetInstance = {
      key,
      content,
      options,
      // Real Pi invokes a factory synchronously inside setWidget.
      component:
        typeof content === "function"
          ? (content as (tui: unknown, theme: unknown) => FakeWidgetInstance["component"])(
              fakeTui,
              fakeTheme,
            )
          : undefined,
      disposed: false,
      render: (width: number) =>
        Array.isArray(content) ? [...content] : (instance.component?.render(width) ?? []),
    };
    widgets.set(key, instance);
  };

  const custom = (factory: any, options?: any): Promise<unknown> => {
    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (err: unknown) => void;
    const result = new Promise<unknown>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const invocation: FakeCustomInvocation = {
      options,
      ready: Promise.resolve(),
      result,
      closed: false,
      input: (data: string) => invocation.component?.handleInput?.(data),
      render: (width: number) => invocation.component?.render(width) ?? [],
    };
    // Mirrors Pi's close(): resolve once, then dispose (dispose errors ignored).
    const done = (value: unknown): void => {
      if (invocation.closed) return;
      invocation.closed = true;
      resolveResult(value);
      try {
        invocation.component?.dispose?.();
      } catch {
        /* ignore dispose errors, as Pi does */
      }
    };
    // Mirrors Pi's showExtensionCustom error path: the factory runs INSIDE the
    // promise chain, so a synchronous throw (or async rejection) rejects
    // `result` instead of escaping custom() or dangling forever.
    invocation.ready = Promise.resolve()
      .then(() => factory(fakeTui, fakeTheme, fakeKeybindings, done))
      .then((component: FakeCustomInvocation["component"]) => {
        if (!invocation.closed) invocation.component = component;
      })
      .catch((err: unknown) => {
        if (!invocation.closed) {
          invocation.closed = true;
          rejectResult(err);
        }
      });
    customs.push(invocation);
    return result;
  };

  const onTerminalInput = (
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): (() => void) => {
    terminalInputHandlers.push(handler);
    return () => {
      const index = terminalInputHandlers.indexOf(handler);
      if (index !== -1) terminalInputHandlers.splice(index, 1);
    };
  };

  const feedTerminalInput = (data: string): { consumed: boolean; data: string } => {
    // pi-tui's chain: sequential; consume stops the chain; data rewrites it.
    let current = data;
    for (const handler of [...terminalInputHandlers]) {
      const result = handler(current);
      if (result?.consume) return { consumed: true, data: current };
      if (result?.data !== undefined) current = result.data;
    }
    return { consumed: false, data: current };
  };

  /**
   * Per-call ui factory whose RECORDING STATE is shared by every ctx shape
   * (like `notifications`); each call yields a distinct ui identity. NOTE:
   * the mere PRESENCE of these verbs activates presence-gated branches in
   * production code (e.g. the typed-fork Esc watch) that a verb-less fake
   * would skip — deliberate, and pinned as Pi-accurate by pi-contract.
   */
  const recordingUi = () => ({
    notify: (text: string, severity?: string) => notifications.push({ text, severity }),
    setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
    getEditorText: () => self.editorText,
    setEditorText: (text: string) => {
      self.editorText = text;
    },
    setWidget,
    custom,
    onTerminalInput,
  });

  const self: FakePi = {
    tools,
    activeTools,
    commands,
    handlers,
    messages,
    userMessages,
    entries,
    entryRenderers,
    messageRenderers,
    notifications,
    statusCalls,
    modelSets,
    thinkingLevels,
    providerRegistrations,
    abortCalls: 0,
    editorText: "",
    shortcuts,
    widgets,
    widgetCalls,
    customs,
    terminalInputHandlers,
    feedTerminalInput,
    compactCalls,
    renderRequests: 0,
    keymap: {
      "tui.select.up": ["\u001b[A"],
      "tui.select.down": ["\u001b[B"],
      "tui.select.confirm": ["\r"],
      "tui.select.cancel": ["\u001b"],
    },
    waitForTools,
    captureInitialization,
    waitForInitialization,
    api: {
      registerTool: (t: any) => {
        tools.set(t.name, t);
        activeTools.add(t.name);
        notifyToolWaiters();
      },
      registerCommand: (name: string, options: any) => commands.set(name, options),
      registerProvider: (name: string, config: any) => providerRegistrations.push({ name, config }),
      registerShortcut: (shortcut: string, options: any) => shortcuts.set(shortcut, options),
      on: (event: string, handler: (event: any, ctx: any) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      sendMessage: (message: any, options?: any) => messages.push({ message, options }),
      sendUserMessage: (content: any, options?: any) => userMessages.push({ content, options }),
      appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
      registerEntryRenderer: (customType: string, renderer: any) =>
        entryRenderers.set(customType, renderer),
      registerMessageRenderer: (customType: string, renderer: any) =>
        messageRenderers.set(customType, renderer),
      setModel: async (model: unknown) => {
        modelSets.push(model);
        return true;
      },
      setThinkingLevel: (level: string) => thinkingLevels.push(level),
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      events: { on: () => undefined, emit: () => undefined },
      getActiveTools: () => [...activeTools],
      getAllTools: () => [...tools.values()],
      setActiveTools: (names: string[]) => {
        activeTools.clear();
        for (const name of names) activeTools.add(name);
      },
    },
    async fire(event: string, evt: any = {}, ctx?: any) {
      let result: any;
      for (const handler of handlers.get(event) ?? []) {
        const r = await handler(evt, ctx ?? self.ctx());
        if (r !== undefined) result = r;
      }
      return result;
    },
    ctx(overrides: Record<string, unknown> = {}) {
      return {
        cwd: process.cwd(),
        // NOTE: hasUI:true + mode:"print" is a deliberately odd legacy pair
        // many existing tests rely on (dialog-notify paths without a TUI).
        // Mode-shape-sensitive tests use tuiCtx/printCtx/rpcCtx instead.
        hasUI: true,
        mode: "print",
        ui: recordingUi(),
        modelRegistry: { find: () => undefined },
        model: { provider: "openai", id: "gpt-test" },
        // Real Pi ContextUsage is a 3-field shape ({ tokens, contextWindow, percent } on the
        // 0–100 scale). The default sits well below any proactive-compaction threshold so
        // firing `agent_settled` never incidentally triggers compaction; tests that exercise
        // proactive compaction override getContextUsage with an above-threshold percent.
        getContextUsage: () => ({ tokens: 1234, contextWindow: 400000, percent: (1234 / 400000) * 100 }),
        compact: (options?: unknown) => compactCalls.push(options),
        abort: () => {
          self.abortCalls += 1;
        },
        hasPendingMessages: () => false,
        sessionManager: { getEntries: () => [] },
        ...overrides,
      };
    },
    tuiCtx(overrides: Record<string, unknown> = {}) {
      return self.ctx({ mode: "tui", hasUI: true, ...overrides });
    },
    printCtx(overrides: Record<string, unknown> = {}) {
      return self.ctx({ mode: "print", hasUI: false, ...overrides });
    },
    rpcCtx(overrides: Record<string, unknown> = {}) {
      return self.ctx({ mode: "rpc", hasUI: true, ...overrides });
    },
  };
  return self;
}

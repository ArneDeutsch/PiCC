import { deferred, waitUntil, type Deferred } from "./async.js";

/** A fake Pi ExtensionAPI capturing everything the PiCC extension registers. */
export interface FakePi {
  api: Record<string, unknown>;
  tools: Map<string, any>;
  commands: Map<string, any>;
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  messages: Array<{ message: any; options?: any }>;
  userMessages: Array<{ content: any; options?: any }>;
  entries: Array<{ customType: string; data: any }>;
  entryRenderers: Map<string, (entry: any, options: any, theme: any) => any>;
  notifications: Array<{ text: string; severity?: string }>;
  modelSets: unknown[];
  thinkingLevels: string[];
  fire(event: string, evt?: any, ctx?: any): Promise<any>;
  ctx(overrides?: Record<string, unknown>): Record<string, unknown>;
  /** Wait until every named tool has been registered. */
  waitForTools(names: readonly string[]): Promise<void>;
}

export function fakePi(): FakePi {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const messages: Array<{ message: any; options?: any }> = [];
  const userMessages: Array<{ content: any; options?: any }> = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const entryRenderers = new Map<string, (entry: any, options: any, theme: any) => any>();
  const notifications: Array<{ text: string; severity?: string }> = [];
  const modelSets: unknown[] = [];
  const thinkingLevels: string[] = [];
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

  const self: FakePi = {
    tools,
    commands,
    handlers,
    messages,
    userMessages,
    entries,
    entryRenderers,
    notifications,
    modelSets,
    thinkingLevels,
    waitForTools,
    api: {
      registerTool: (t: any) => {
        tools.set(t.name, t);
        notifyToolWaiters();
      },
      registerCommand: (name: string, options: any) => commands.set(name, options),
      on: (event: string, handler: (event: any, ctx: any) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      sendMessage: (message: any, options?: any) => messages.push({ message, options }),
      sendUserMessage: (content: any, options?: any) => userMessages.push({ content, options }),
      appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
      registerEntryRenderer: (customType: string, renderer: any) =>
        entryRenderers.set(customType, renderer),
      registerMessageRenderer: () => undefined,
      setModel: async (model: unknown) => {
        modelSets.push(model);
        return true;
      },
      setThinkingLevel: (level: string) => thinkingLevels.push(level),
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      events: { on: () => undefined, emit: () => undefined },
      getActiveTools: () => [...tools.keys()],
      getAllTools: () => [...tools.values()],
      setActiveTools: () => undefined,
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
        hasUI: true,
        mode: "print",
        ui: {
          notify: (text: string, severity?: string) => notifications.push({ text, severity }),
          setStatus: () => undefined,
        },
        modelRegistry: { find: () => undefined },
        model: { provider: "openai", id: "gpt-test" },
        getContextUsage: () => ({ tokens: 1234 }),
        sessionManager: { getEntries: () => [] },
        ...overrides,
      };
    },
  };
  return self;
}

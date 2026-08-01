import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import picc from "../src/index.js";
import { deferred } from "./helpers/async.js";

const roots: string[] = [];
const disposals: Array<Promise<unknown>> = [];

afterEach(async () => {
  await Promise.allSettled(disposals.splice(0));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface LifecycleRecord {
  owner: string;
  type: "session_start" | "session_before_switch" | "agent_settled" | "session_shutdown";
  reason?: string;
  branch?: any[];
}

interface RuntimeAuthority {
  gate: any;
  captureStop: () => boolean;
  controller: any;
}

interface AssembledHarness {
  sdk: any;
  project: string;
  agentDir: string;
  sessionDir: string;
  modelRuntime: any;
  model: Record<string, unknown>;
  requests: any[];
  responseEntered: ReturnType<typeof deferred<void>>;
  toolInvocations: string[];
  lifecycle: LifecycleRecord[];
  stopInvocations: Array<{ owner: string; payload: unknown }>;
  stopContinuations: Array<{ owner: string; text: string }>;
  authorities: Map<string, RuntimeAuthority>;
  createRuntime(sessionManager: any, sessionStartEvent?: any): Promise<any>;
}

async function assembledHarness(): Promise<AssembledHarness> {
  const sdk: any = await import("@earendil-works/pi-coding-agent");
  const ai: any = await import("@earendil-works/pi-ai");
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "picc-session-replacement-"));
  roots.push(project);
  const agentDir = path.join(project, ".pi-agent");
  const sessionDir = path.join(agentDir, "sessions");
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "assembled session lifecycle contract\n");

  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false } });
  const modelRuntime = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.hasConfiguredAuth = () => true;
  modelRuntime.getAuth = async () => ({ auth: { apiKey: "assembled-key" }, source: "assembled contract" });
  const requests: any[] = [];
  const responseEntered = deferred<void>();
  const toolInvocations: string[] = [];
  modelRuntime.streamSimple = (_model: any, context: any, options: any) => {
    const requestIndex = requests.push({
      messages: structuredClone(context.messages),
      tools: (context.tools ?? []).map((tool: any) => tool.name),
    }) - 1;
    const stream = ai.createAssistantMessageEventStream();
    const base = {
      role: "assistant",
      api: "openai-completions",
      provider: "assembled",
      model: "session-contract",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(),
    };
    if (requestIndex === 0) {
      const toolCall = { type: "toolCall", id: "transition-probe-call", name: "transition_probe", arguments: {} };
      const partial = { ...base, content: [{ ...toolCall, arguments: {} }], stopReason: "pending" };
      const message = { ...base, content: [toolCall], stopReason: "toolUse" };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...base, content: [], stopReason: "pending" } });
        stream.push({ type: "toolcall_start", contentIndex: 0, partial });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end(message);
      });
    } else if (requestIndex === 1) {
      const partial = { ...base, content: [{ type: "text", text: "OUTGOING_ABORTED_RESPONSE" }], stopReason: "pending" };
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      responseEntered.resolve();
      const abort = () => {
        const error = { ...partial, stopReason: "aborted", errorMessage: "aborted by host transition" };
        stream.push({ type: "error", reason: "aborted", error });
        stream.end(error);
      };
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
    } else {
      const message = { ...base, content: [{ type: "text", text: `fresh-${requestIndex}` }], stopReason: "stop" };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
    }
    return stream;
  };
  const model = {
    id: "session-contract", name: "Session Contract", api: "openai-completions", provider: "assembled",
    baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
  };
  const lifecycle: LifecycleRecord[] = [];
  const stopInvocations: Array<{ owner: string; payload: unknown }> = [];
  const stopContinuations: Array<{ owner: string; text: string }> = [];
  const authorities = new Map<string, RuntimeAuthority>();

  const harness = {
    sdk, project, agentDir, sessionDir, modelRuntime, model, requests, responseEntered, toolInvocations,
    lifecycle, stopInvocations, stopContinuations, authorities,
    async createRuntime(sessionManager: any, sessionStartEvent?: any) {
      let initialization: Promise<void> | undefined;
      const owner = sessionManager.getSessionFile();
      const loader = new sdk.DefaultResourceLoader({
        cwd: project,
        agentDir,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          {
            name: "picc-assembled-session-contract",
            factory: (api: any) => picc(api, {
              onInitializationSettled: (completion) => { initialization = completion; },
              onWired: ({ mainCheckpointGate, inputHooks }) => {
                authorities.set(owner, {
                  gate: mainCheckpointGate,
                  captureStop: mainCheckpointGate.captureLogicalRunStop(),
                  controller: mainCheckpointGate.currentController(),
                });
                const fire = inputHooks.fire.bind(inputHooks);
                inputHooks.fire = async (event: string, payload: unknown, ...args: unknown[]) => {
                  if (event === "Stop") stopInvocations.push({ owner, payload });
                  return fire(event, payload, ...args);
                };
              },
            }),
          },
          {
            name: "session-lifecycle-recorder",
            factory: (api: any) => {
              api.registerTool({
                name: "transition_probe",
                label: "transition probe",
                description: "Exercise one real tool call before a session transition.",
                parameters: { type: "object", properties: {}, additionalProperties: false },
                execute: async (id: string) => {
                  toolInvocations.push(id);
                  return { content: [{ type: "text", text: "transition probe completed" }] };
                },
              });
              api.on("input", (event: any) => {
                if (event?.source === "extension" && String(event.text ?? "").startsWith("[Stop hook]")) {
                  stopContinuations.push({ owner, text: event.text });
                }
              });
              for (const type of ["session_start", "session_before_switch", "agent_settled", "session_shutdown"] as const) {
                api.on(type, (event: any, ctx: any) => {
                  lifecycle.push({
                    owner,
                    type,
                    reason: event?.reason,
                    ...(type === "session_shutdown" ? { branch: structuredClone(ctx.sessionManager.getBranch()) } : {}),
                  });
                });
              }
            },
          },
        ],
      });
      await loader.reload();
      const created = await sdk.createAgentSession({
        cwd: project,
        agentDir,
        settingsManager,
        modelRuntime,
        model,
        resourceLoader: loader,
        sessionManager,
        sessionStartEvent,
      });
      await initialization;
      return {
        ...created,
        services: { cwd: project, agentDir, settingsManager, modelRuntime, resourceLoader: loader, diagnostics: [] },
        diagnostics: [],
      };
    },
  } satisfies AssembledHarness;
  return harness;
}

function branchText(entries: any[]): string {
  return JSON.stringify(entries.map((entry) => entry.type === "message" ? entry.message : entry));
}

function messages(entries: any[]): any[] {
  return entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
}

function expectBalancedExercisedTool(entries: any[]): void {
  const persistedMessages = messages(entries);
  const calls = persistedMessages.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
    ? message.content.filter((part: any) => part.type === "toolCall").map((part: any) => part.id)
    : []);
  const results = persistedMessages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId);
  expect(calls).toContain("transition-probe-call");
  expect(results).toContain("transition-probe-call");
  expect(calls.filter((id: string) => !new Set(results).has(id))).toEqual([]);
}

function expectAbortedAssistant(entries: any[]): void {
  const aborted = messages(entries).find((message) => message.role === "assistant" && message.stopReason === "aborted");
  expect(aborted).toMatchObject({ stopReason: "aborted", errorMessage: "aborted by host transition" });
  expect(JSON.stringify(aborted.content)).toContain("OUTGOING_ABORTED_RESPONSE");
}

function reopen(sdk: any, file: string): any {
  return sdk.SessionManager.open(file);
}

async function commitTreeSelectionThroughInteractiveMode(
  sdk: any,
  session: any,
  sessionManager: any,
  selectedId: string,
): Promise<string[]> {
  const ordering: string[] = [];
  const originalAbort = session.abort.bind(session);
  const originalNavigateTree = session.navigateTree.bind(session);
  session.abort = async () => {
    ordering.push("abort:start");
    await originalAbort();
    ordering.push("abort:end");
  };
  session.navigateTree = async (...args: unknown[]) => {
    ordering.push("navigateTree");
    return originalNavigateTree(...args);
  };

  let commitSelection: ((entryId: string) => Promise<void>) | undefined;
  sdk.initTheme(undefined, false);
  const settingsManager = {
    getTreeFilterMode: () => "all",
    getBranchSummarySkipPrompt: () => true,
  };
  const interactiveSession = new Proxy(session, {
    get(target, property) {
      if (property === "sessionManager") return sessionManager;
      if (property === "settingsManager") return settingsManager;
      return Reflect.get(target, property, target);
    },
  });
  const interactive: any = Object.create(sdk.InteractiveMode.prototype);
  Object.assign(interactive, {
    runtimeHost: { session: interactiveSession },
    ui: { terminal: { rows: 40 }, requestRender: () => {} },
    defaultEditor: { onEscape: undefined },
    editor: { getText: () => "", setText: () => {} },
    chatContainer: { clear: () => {}, addChild: () => {} },
    restoreQueuedMessagesToEditor: () => {},
    showStatus: () => {},
    renderInitialMessages: () => {},
    flushCompactionQueue: async () => {},
    showError: (error: unknown) => { throw error; },
    showSelector: (create: (done: () => void) => { component: any }) => {
      const { component } = create(() => {});
      commitSelection = component.treeList.onSelect;
    },
  });
  interactive.showTreeSelector();
  if (!commitSelection) throw new Error("InteractiveMode did not expose the tree selector commit callback");
  await commitSelection(selectedId);
  return ordering;
}

describe("Pi 0.83 assembled session transition contract", () => {
  it("replaces an active PiCC session only after abort persistence and shutdown", async () => {
    const h = await assembledHarness();
    const previousCwd = process.cwd();
    process.chdir(h.project);
    let runtime: any;
    try {
      const outgoing = h.sdk.SessionManager.create(h.project, h.sessionDir);
      const incoming = h.sdk.SessionManager.create(h.project, h.sessionDir);
      incoming.appendMessage({ role: "user", content: "incoming-existing", timestamp: Date.now() });
      incoming.appendMessage({ role: "assistant", content: [{ type: "text", text: "incoming-ready" }], stopReason: "stop", timestamp: Date.now() });
      const outgoingPath = outgoing.getSessionFile();
      const incomingPath = incoming.getSessionFile();
      const initial = await h.createRuntime(outgoing, { type: "session_start", reason: "startup" });
      runtime = new h.sdk.AgentSessionRuntime(initial.session, initial.services, ({ sessionManager, sessionStartEvent }: any) =>
        h.createRuntime(sessionManager, sessionStartEvent), initial.diagnostics);

      const activePrompt = runtime.session.prompt("OUTGOING_ACTIVE_MARKER");
      await h.responseEntered.promise;
      const staleAuthority = h.authorities.get(outgoingPath)!;
      staleAuthority.captureStop = staleAuthority.gate.captureLogicalRunStop();
      await expect(runtime.switchSession(incomingPath)).resolves.toEqual({ cancelled: false });
      await activePrompt;

      const outgoingGraph = reopen(h.sdk, outgoingPath).getEntries();
      const incomingGraph = reopen(h.sdk, incomingPath).getEntries();
      expect(branchText(outgoingGraph)).toContain("OUTGOING_ACTIVE_MARKER");
      expectBalancedExercisedTool(outgoingGraph);
      expectAbortedAssistant(outgoingGraph);
      expect(branchText(incomingGraph)).toContain("incoming-existing");
      expect(branchText(incomingGraph)).not.toContain("OUTGOING_ACTIVE_MARKER");
      expect(h.toolInvocations).toEqual(["transition-probe-call"]);

      const outgoingLifecycle = h.lifecycle.filter((event) => event.owner === outgoingPath);
      expect(outgoingLifecycle.map(({ type, reason }) => ({ type, reason }))).toEqual([
        { type: "session_before_switch", reason: "resume" },
        { type: "agent_settled", reason: undefined },
        { type: "session_shutdown", reason: "resume" },
      ]);
      expectAbortedAssistant(outgoingLifecycle.at(-1)!.branch!);
      expect(outgoingLifecycle.at(-1)!.branch).toEqual(outgoingGraph.filter((entry: any) =>
        reopen(h.sdk, outgoingPath).getBranch().some((branchEntry: any) => branchEntry.id === entry.id)));

      const successorAuthority = h.authorities.get(incomingPath)!;
      expect(successorAuthority.gate.currentController().snapshot().phase).toBe("idle");
      expect(staleAuthority.captureStop()).toBe(false);
      expect(successorAuthority.gate.currentController().snapshot().phase).toBe("idle");
      expect(h.stopInvocations).toEqual([]);
      expect(h.stopContinuations).toEqual([]);

      await runtime.session.prompt("INCOMING_FRESH_MARKER");
      expect(h.requests).toHaveLength(3);
      const finalIncomingGraph = reopen(h.sdk, incomingPath).getEntries();
      expect(branchText(finalIncomingGraph)).toContain("fresh-2");
      expect(branchText(finalIncomingGraph)).not.toContain("OUTGOING_ACTIVE_MARKER");
      expect(h.lifecycle.filter((event) => event.owner === incomingPath).map((event) => event.type))
        .toEqual(["agent_settled"]);
    } finally {
      process.chdir(previousCwd);
      if (runtime) disposals.push(Promise.resolve(runtime.dispose()));
    }
  });

  it("committed active-response navigation abandons the old branch without reviving PiCC work", async () => {
    const h = await assembledHarness();
    const previousCwd = process.cwd();
    process.chdir(h.project);
    let session: any;
    try {
      const manager = h.sdk.SessionManager.create(h.project, h.sessionDir);
      manager.appendMessage({ role: "user", content: "selected-root", timestamp: Date.now() });
      const selectedId = manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "selected-ready" }], stopReason: "stop", timestamp: Date.now(),
      });
      const sessionPath = manager.getSessionFile();
      const initial = await h.createRuntime(manager, { type: "session_start", reason: "startup" });
      session = initial.session;

      const activePrompt = session.prompt("ABANDONED_NAVIGATION_MARKER");
      await h.responseEntered.promise;
      const authority = h.authorities.get(sessionPath)!;
      const staleStop = authority.gate.captureLogicalRunStop();
      const ordering = await commitTreeSelectionThroughInteractiveMode(h.sdk, session, manager, selectedId);
      await activePrompt;
      expect(ordering).toEqual(["abort:start", "abort:end", "navigateTree"]);

      const reopened = reopen(h.sdk, sessionPath);
      const fullGraph = reopened.getEntries();
      const abandonedLeaf = fullGraph.find((entry: any) =>
        entry.type === "message" && entry.message?.role === "assistant" && entry.message.stopReason === "aborted")!.id;
      const abandonedBranch = reopened.getBranch(abandonedLeaf);
      const selectedBranch = reopened.getBranch(selectedId);
      expect(branchText(fullGraph)).toContain("ABANDONED_NAVIGATION_MARKER");
      expectBalancedExercisedTool(abandonedBranch);
      expectAbortedAssistant(abandonedBranch);
      expect(branchText(selectedBranch)).toContain("selected-ready");
      expect(branchText(selectedBranch)).not.toContain("ABANDONED_NAVIGATION_MARKER");
      expect(staleStop()).toBe(false);
      expect(authority.gate.currentController().snapshot().phase).toBe("idle");
      expect(h.stopInvocations).toEqual([]);
      expect(h.stopContinuations).toEqual([]);

      await session.prompt("NAVIGATION_FRESH_MARKER");
      expect(h.requests).toHaveLength(3);
      const finalReopened = reopen(h.sdk, sessionPath);
      expect(branchText(finalReopened.getBranch())).toContain("fresh-2");
      expect(branchText(finalReopened.getBranch())).not.toContain("ABANDONED_NAVIGATION_MARKER");
      expect(branchText(finalReopened.getEntries())).toContain("ABANDONED_NAVIGATION_MARKER");
      expect(h.lifecycle.map((event) => event.type)).toEqual(["agent_settled", "agent_settled"]);
    } finally {
      process.chdir(previousCwd);
      if (session) disposals.push(Promise.resolve(session.dispose()));
    }
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import picc from "../src/index.js";
import { renderMainSessionTool } from "../src/runtime/main-session-tool-render.js";
import { deferred, waitUntil } from "./helpers/async.js";

const CORE = ["bash", "read", "write", "edit", "grep", "find", "ls"] as const;
let project: string;
let previousCwd: string;
let previousUserDir: string | undefined;
let providerSourceId = 0;

beforeAll(() => {
  previousCwd = process.cwd();
  previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
  project = fs.mkdtempSync(path.join(os.tmpdir(), "picc-input-contract-"));
  fs.mkdirSync(path.join(project, ".claude-user"), { recursive: true });
  fs.mkdirSync(path.join(project, ".claude", "commands"), { recursive: true });
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "input contract fixture\n");
  fs.writeFileSync(path.join(project, ".claude", "commands", "deploy.md"),
    "Deploy the release target $ARGUMENTS after the readiness gate.\n");
  process.env.PICC_CLAUDE_USER_DIR = path.join(project, ".claude-user");
  process.chdir(project);
});

afterAll(() => {
  process.chdir(previousCwd);
  if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
  else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
  fs.rmSync(project, { recursive: true, force: true });
});

interface InstalledOptions {
  loadBuiltinSdk: () => Promise<any>;
  failPresentation?: boolean;
  failCheckpoint?: boolean;
  failCoreRegistrationAt?: number;
  cleanup?: "throw" | "unverified";
  abortBeforeProvider?: boolean;
  useRealProviderStream?: boolean;
  messageForProvider?: (ordinal: number) => {
    content: readonly unknown[];
    usage?: Record<string, unknown>;
    stopReason?: string;
  };
  heldTool?: Promise<Record<string, unknown>>;
  observeMessageEnd?: (event: any, ctx: any, gate: any) => void;
}

async function installedSession(options: InstalledOptions) {
  const sdk: any = await import("@earendil-works/pi-coding-agent");
  const ai: any = await import("@earendil-works/pi-ai");
  const aiCompat: any = await import("@earendil-works/pi-ai/compat");
  let providerPrompts = 0;
  let hookCalls = 0;
  let sdkLoads = 0;
  let coreRegistrations = 0;
  let firstProviderTools: string[] | undefined;
  let firstActiveTools: string[] | undefined;
  let firstRegisteredTools: string[] | undefined;
  let extensionApi: any;
  let mainCheckpointGate: any;
  let initialization: Promise<void> | undefined;
  const settingsManager = sdk.SettingsManager.inMemory();
  const providerSource = `picc-input-admission-${++providerSourceId}`;
  const providerStream = (...args: any[]) => {
    providerPrompts += 1;
    if (firstProviderTools === undefined) {
      firstProviderTools = (args[1]?.tools ?? []).map((tool: { name?: unknown }) => String(tool.name));
      firstActiveTools = extensionApi.getActiveTools().map(String);
      firstRegisteredTools = extensionApi.getAllTools().map((tool: { name?: unknown }) => String(tool.name));
    }
    const stream = ai.createAssistantMessageEventStream();
    const configured = options.messageForProvider?.(providerPrompts);
    const message = {
      role: "assistant", content: configured?.content ?? [{ type: "text", text: `answer-${providerPrompts}` }],
      api: options.useRealProviderStream ? "picc-admission-contract" : "openai-completions",
      provider: options.useRealProviderStream ? "openai" : "contract", model: "admission",
      usage: configured?.usage ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: configured?.stopReason ?? "stop", timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
  let providerRegistered = false;
  if (options.useRealProviderStream) {
    aiCompat.registerApiProvider({ api: "picc-admission-contract", stream: providerStream, streamSimple: providerStream }, providerSource);
    providerRegistered = true;
  }
  try {
  const modelRuntime = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  modelRuntime.hasConfiguredAuth = () => true;
  modelRuntime.getAuth = async () => ({ auth: { apiKey: "contract-test-key" }, source: "in-process contract" });
  if (!options.useRealProviderStream) modelRuntime.streamSimple = providerStream;
  const model = {
    id: "admission", name: "Admission Contract",
    api: options.useRealProviderStream ? "picc-admission-contract" : "openai-completions",
    provider: options.useRealProviderStream ? "openai" : "contract",
    baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
  };
  const loader = new sdk.DefaultResourceLoader({
    cwd: project,
    agentDir: path.join(project, ".claude-user"),
    settingsManager,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{
      name: "picc-admission-contract",
      factory: (api: any) => {
        extensionApi = api;
        const register = api.registerTool.bind(api);
        api.registerTool = (definition: any) => {
          if (CORE.includes(definition.name)) {
            coreRegistrations += 1;
            if (coreRegistrations === options.failCoreRegistrationAt) throw new Error("injected registration fault");
          }
          return register(definition);
        };
        picc(api, {
          loadBuiltinSdk: async () => { sdkLoads += 1; return options.loadBuiltinSdk(); },
          ...(options.failPresentation ? {
            renderMainSessionTool: ((definition, routeOptions) => {
              if (definition.name === "bash") throw new Error("presentation fault");
              return renderMainSessionTool(definition, routeOptions);
            }) as typeof renderMainSessionTool,
          } : {}),
          onInitializationSettled: (completion) => { initialization = completion; },
          onWired: ({ inputHooks, mainCheckpointGate: wiredGate }) => {
            mainCheckpointGate = wiredGate;
            const fire = inputHooks.fire.bind(inputHooks);
            inputHooks.fire = async (...args: any[]) => {
              if (args[0] === "UserPromptSubmit") hookCalls += 1;
              return fire(...args);
            };
            if (options.failCheckpoint) {
              const realWrap = mainCheckpointGate.wrapTool.bind(mainCheckpointGate);
              mainCheckpointGate.wrapTool = ((definition: Record<string, unknown>) => {
                if (definition.name === "bash") throw new Error("checkpoint fault");
                return realWrap(definition);
              }) as typeof mainCheckpointGate.wrapTool;
            }
          },
        });
        if (options.heldTool) {
          api.registerTool({
            name: "contract_hold",
            label: "Contract hold",
            description: "In-process contract gate",
            parameters: Type.Object({}),
            execute: async () => options.heldTool,
          });
        }
        if (options.observeMessageEnd) {
          api.on("message_end", (event: any, ctx: any) => options.observeMessageEnd?.(event, ctx, mainCheckpointGate));
        }
        if (options.abortBeforeProvider) {
          api.on("before_provider_request", (_event: unknown, ctx: { abort(): void }) => { ctx.abort(); });
        }
      },
    }],
  });
  await loader.reload();
  const { session } = await sdk.createAgentSession({
    cwd: project,
    agentDir: path.join(project, ".claude-user"),
    resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(project),
    settingsManager,
    modelRuntime,
    model,
  });
  if (options.cleanup === "throw") extensionApi.setActiveTools = () => { throw new Error("cleanup denied"); };
  if (options.cleanup === "unverified") extensionApi.setActiveTools = () => undefined;
  return {
    session,
    extensionApi,
    mainCheckpointGate,
    counts: () => ({ providerPrompts, hookCalls, sdkLoads, coreRegistrations }),
    firstProviderToolState: () => ({
      advertised: firstProviderTools,
      active: firstActiveTools,
      registered: firstRegisteredTools,
    }),
    close: async () => {
      try {
        await initialization;
      } finally {
        try {
          session.dispose?.();
        } finally {
          if (providerRegistered) {
            aiCompat.unregisterApiProviders(providerSource);
            providerRegistered = false;
          }
        }
      }
    },
  };
  } catch (error) {
    if (providerRegistered) aiCompat.unregisterApiProviders(providerSource);
    throw error;
  }
}

async function submit(installed: Awaited<ReturnType<typeof installedSession>>, mode: "tui" | "print" | "json" | "rpc", text: string, source: "interactive" | "rpc" | "extension" = mode === "rpc" ? "rpc" : "interactive") {
  installed.session.extensionRunner.setUIContext({}, mode);
  await installed.session.prompt(text, { source });
}

function providerText(context: any): string {
  return context.messages.flatMap((message: any) => typeof message.content === "string"
    ? [message.content]
    : (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text))
    .join("\n");
}

function malformedMessageGetter(): Error {
  const error = new Error("placeholder");
  Object.defineProperty(error, "message", { get: () => { throw new Error("message getter fault"); } });
  return error;
}

function malformedMessageValue(): Error {
  const error = new Error("placeholder");
  Object.defineProperty(error, "message", {
    value: { toString: () => { throw new Error("message conversion fault"); } },
  });
  return error;
}

describe("installed Pi AgentSession input admission", () => {
  it("does not invoke the real provider stream after a synchronous before_provider_request abort", async () => {
    const installed = await installedSession({
      loadBuiltinSdk: () => import("@earendil-works/pi-coding-agent"),
      abortBeforeProvider: true,
      useRealProviderStream: true,
    });
    try {
      await submit(installed, "print", "abort before provider transport");
      expect(installed.counts()).toMatchObject({ providerPrompts: 0, hookCalls: 1 });
    } finally {
      await installed.close();
    }
  });

  it("uses fresh assistant usage at the first post-compaction message_end before Pi persists it", async () => {
    const toolRelease = deferred<Record<string, unknown>>();
    let postCompaction = false;
    let observation: { usage: any; snapshot: any; eventUsage: any } | undefined;
    let installed: Awaited<ReturnType<typeof installedSession>> | undefined;
    let prompt: Promise<void> | undefined;
    try {
      installed = await installedSession({
        loadBuiltinSdk: () => import("@earendil-works/pi-coding-agent"),
        heldTool: toolRelease.promise,
        messageForProvider: () => {
          if (!postCompaction) return { content: [{ type: "text", text: "ordinary response" }] };
          postCompaction = false;
          return {
            content: [{ type: "toolCall", id: "post-compact-tool", name: "contract_hold", arguments: {} }],
            stopReason: "toolUse",
            usage: {
              input: 90_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 90_000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
        },
        observeMessageEnd: (event, ctx, gate) => {
          if (event.message?.role !== "assistant" || event.message?.content?.[0]?.id !== "post-compact-tool") return;
          observation = {
            usage: ctx.getContextUsage(),
            snapshot: gate.currentController().snapshot(),
            eventUsage: event.message.usage,
          };
        },
      });
      await submit(installed, "print", "oldest turn summarized by compaction");
      await submit(installed, "print", "history ".repeat(40_000));
      await submit(installed, "print", "recent turn retained across compaction");
      await installed.session.compact();
      postCompaction = true;
      prompt = submit(installed, "print", "first request after compaction");
      await waitUntil({ description: "first post-compaction assistant message_end", predicate: () => observation !== undefined });

      expect(observation?.usage).toMatchObject({ percent: null });
      expect(observation?.eventUsage).toMatchObject({ input: 90_000, totalTokens: 90_000 });
      expect(observation?.snapshot).toMatchObject({ generation: 1, phase: "stopping" });
      await expect(installed.mainCheckpointGate.cancel("user")).resolves.toMatchObject({ cancelled: true });
    } finally {
      postCompaction = false;
      toolRelease.resolve({ content: [], details: {} });
      try {
        if (prompt) await prompt;
      } finally {
        if (installed) await installed.close();
      }
    }
  });

  it("holds slash-template task input across ordinary TUI, print, JSON, and RPC prompt modes, then initializes once", async () => {
    for (const mode of ["tui", "print", "json", "rpc"] as const) {
      const gate = deferred<any>();
      const installed = await installedSession({ loadBuiltinSdk: () => gate.promise });
      try {
        let settled = false;
        const prompt = submit(installed, mode, `/deploy ${mode}`).then(() => { settled = true; });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled, mode).toBe(false);
        expect(installed.counts()).toMatchObject({ providerPrompts: 0, hookCalls: 0, sdkLoads: 1 });

        gate.resolve(await import("@earendil-works/pi-coding-agent"));
        await prompt;
        expect(installed.counts()).toEqual({ providerPrompts: 1, hookCalls: 1, sdkLoads: 1, coreRegistrations: 7 });
        const firstProvider = installed.firstProviderToolState();
        expect(firstProvider.advertised).toEqual(firstProvider.active);
        for (const name of CORE) {
          expect(firstProvider.registered, `${mode} registered routed ${name} before first provider call`).toContain(name);
        }
        expect(firstProvider.registered, `${mode} registered NotebookEdit synchronously`).toContain("NotebookEdit");
        expect(firstProvider.advertised, `${mode} advertised NotebookEdit on the first provider call`).toContain("NotebookEdit");
        expect(firstProvider.advertised, `${mode} advertised routed Read on the first provider call`).toContain("read");
        expect(providerText({ messages: installed.session.messages })).toContain("Deploy the release target");

        await submit(installed, mode, "second successful ordinary input");
        expect(installed.counts()).toEqual({ providerPrompts: 2, hookCalls: 2, sdkLoads: 1, coreRegistrations: 7 });
      } finally {
        gate.resolve(await import("@earendil-works/pi-coding-agent"));
        await installed.close();
      }
    }
  });

  it("lets an extension continuation bypass pending ordinary readiness without deadlock", async () => {
    const gate = deferred<any>();
    const installed = await installedSession({ loadBuiltinSdk: () => gate.promise });
    try {
      await submit(installed, "rpc", "authenticated continuation", "extension");
      expect(installed.counts()).toMatchObject({ providerPrompts: 1, hookCalls: 0 });
    } finally {
      gate.resolve(await import("@earendil-works/pi-coding-agent"));
      await installed.close();
    }
  });

  it("retries unavailable pre-bind cleanup at first failed input without widening the active set", async () => {
    const installed = await installedSession({ loadBuiltinSdk: async () => { throw new Error("sdk unavailable"); } });
    try {
      installed.session.setActiveToolsByName(["WebFetch", ...CORE]);
      await submit(installed, "print", "blocked after runtime binding");
      expect(installed.counts()).toMatchObject({ providerPrompts: 0, hookCalls: 0 });
      expect(installed.session.getActiveToolNames()).toContain("WebFetch");
      expect(installed.session.getActiveToolNames().filter((name: string) => CORE.includes(name as typeof CORE[number]))).toEqual([]);
      expect(installed.session.getActiveToolNames()).not.toContain("WebSearch");
    } finally {
      await installed.close();
    }
  });

  it("keeps actual provider and submit-hook counts at zero for every failure phase across repeated ordinary mode submissions", async () => {
    const realSdk: any = await import("@earendil-works/pi-coding-agent");
    const scenarios: Array<{ label: string; options: InstalledOptions; registrations: number }> = [
      { label: "import", options: { loadBuiltinSdk: async () => { throw new Error("import fault"); } }, registrations: 0 },
      { label: "factory", options: { loadBuiltinSdk: async () => ({ ...realSdk, createBashTool: () => { throw new Error("factory fault"); } }) }, registrations: 0 },
      { label: "presentation", options: { loadBuiltinSdk: async () => realSdk, failPresentation: true }, registrations: 0 },
      { label: "checkpoint", options: { loadBuiltinSdk: async () => realSdk, failCheckpoint: true }, registrations: 0 },
      { label: "partial", options: { loadBuiltinSdk: async () => realSdk, failCoreRegistrationAt: 3 }, registrations: 3 },
      { label: "malformed getter", options: { loadBuiltinSdk: async () => { throw malformedMessageGetter(); } }, registrations: 0 },
      { label: "malformed value", options: { loadBuiltinSdk: async () => { throw malformedMessageValue(); } }, registrations: 0 },
    ];
    for (const scenario of scenarios) {
      const installed = await installedSession(scenario.options);
      try {
        for (const [mode, source] of [["tui", "interactive"], ["print", "interactive"], ["json", "interactive"], ["rpc", "rpc"]] as const) {
          await submit(installed, mode, `${scenario.label}-${mode}-first`, source);
          await submit(installed, mode, `${scenario.label}-${mode}-repeat`, source);
        }
        expect(installed.counts(), scenario.label).toEqual({
          providerPrompts: 0,
          hookCalls: 0,
          sdkLoads: 1,
          coreRegistrations: scenario.registrations,
        });
      } finally {
        await installed.close();
      }
    }
  });

  it("keeps cleanup throw and failed verification away from providers for repeated ordinary TUI, print, JSON, and RPC tasks", async () => {
    for (const cleanup of ["throw", "unverified"] as const) {
      const installed = await installedSession({
        loadBuiltinSdk: async () => { throw new Error("sdk unavailable"); }, cleanup,
      });
      try {
        installed.session.setActiveToolsByName(["WebFetch", ...CORE]);
        for (const [mode, source] of [["tui", "interactive"], ["print", "interactive"], ["json", "interactive"], ["rpc", "rpc"]] as const) {
          await submit(installed, mode, `${cleanup}-${mode}-first`, source);
          await submit(installed, mode, `${cleanup}-${mode}-repeat`, source);
        }
        expect(installed.counts()).toMatchObject({ providerPrompts: 0, hookCalls: 0, sdkLoads: 1 });
      } finally {
        await installed.close();
      }
    }
  });
});

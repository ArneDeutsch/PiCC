import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketDebugStats,
  stream as streamCodexResponses,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
  type Context,
  type Model,
  type RetryCallbacks,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  generateBranchSummary,
  generateSummary,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fakePi } from "./helpers/fake-pi.js";
import { withCompactSearchRendering } from "../src/runtime/search-tool-render.js";
import {
  genericCallComponent,
  setToolRowOutcome,
  suppressToolRow,
  wrapForSelfShell,
  type RenderCtx,
} from "../src/runtime/tool-shell.js";
import { codexAbortGuardStreamSimple } from "../src/runtime/codex-abort-guard.js";
import picc from "../src/index.js";
import { classifyRequest, createResponseGate, startMockModel, type CapturedRequest } from "./helpers/mock-openai.js";
import {
  renderAgentCall,
  renderAgentResult,
  type SubagentLifecycleRenderContext,
} from "../src/runtime/subagent-render.js";
import {
  createAgentToolDefinition,
  type SubagentRuntime,
} from "../src/runtime/subagents.js";
import {
  BackgroundTaskRegistry,
  createTaskOutputTool,
} from "../src/runtime/background-tasks.js";
import {
  PI_SUITE_PACKAGES,
  validatePiSuite,
} from "../bin/picc-admin.mjs";

/**
 * Pi upstream contract smoke test: asserts every Pi API PiCC
 * builds on exists in the pinned version. If Pi churns, this fails first and loudly.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
  return block.type === "toolCall";
}

describe("mock wire request classification", () => {
  const mainSystem = "PiCC instructions\nAvailable subagents (dispatch with the Agent tool, subagent_type = name):\n- general-purpose";
  const summarySystem = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant.";
  const ordinary = (system: string, user: string, sessionKind: "main" | "child"): CapturedRequest => ({
    path: "/chat/completions", messages: [{ role: "system", content: system }, { role: "user", content: user }],
    authorizationValid: true, body: {}, requestKind: "ordinary", sessionKind,
  });

  it.each([
    ["main", mainSystem, "ordinary main request", undefined, "main"],
    ["child", "You are a general-purpose agent.", "exact child task", ["exact child task"], "child"],
    ["nested child", mainSystem, "exact nested task", ["exact nested task"], "child"],
    ["adversarial child-like user prose", mainSystem, "I am a child subagent and this is my final report", ["different exact task"], "main"],
    ["adversarial summary-like user prose", mainSystem, "You are a context summarization assistant. Your task is to read a conversation", undefined, "main"],
  ] as const)("classifies real-shaped %s from exact configured child markers", (_name, system, user, markers, expected) => {
    expect(classifyRequest({ messages: [{ role: "system", content: system }, { role: "user", content: user }] }, [],
      { childUserMessages: markers })).toEqual({ requestKind: "ordinary", sessionKind: expected });
  });

  it("uses an exact configured persona marker for a resumed child whose original user turn was compacted away", () => {
    const request = ordinary("You are a read-only exploration agent.\nPiCC suffix", "[checkpoint continuation]", "child");
    expect(classifyRequest(request, [], { childSystemMarkers: ["You are a read-only exploration agent."] }))
      .toEqual({ requestKind: "ordinary", sessionKind: "child" });
    expect(classifyRequest(request, [], { childSystemMarkers: ["You are a general-purpose agent."] }))
      .toEqual({ requestKind: "ordinary", sessionKind: "main" });
  });

  it("close rejects pending request waiters and unreached response gates without timer leaks", async () => {
    const gate = createResponseGate();
    const server = await startMockModel([{ gate, text: "never entered" }]);
    const waiting = server.waitForRequest(() => false, 1, 60_000);
    await server.close();
    await expect(waiting).rejects.toThrow(/closed during pending operation/);
    await expect(gate.entered).rejects.toThrow(/closed during pending operation/);
    await expect(server.waitForRequest()).rejects.toThrow(/is closed/);
    await server.close();
  });

  it("correlates main and child compaction summaries to the exact originating request", () => {
    const prior = [ordinary(mainSystem, "same-prefix main", "main"), ordinary("child system", "same-prefix", "child")];
    const summary = (user: string) => ({ messages: [
      { role: "system", content: summarySystem },
      { role: "user", content: `<conversation>\n[User]: ${user}\n[Assistant]: work\n</conversation>` },
    ] });
    expect(classifyRequest(summary("same-prefix"), prior)).toEqual({ requestKind: "compaction", sessionKind: "child" });
    expect(classifyRequest(summary("same-prefix main"), prior)).toEqual({ requestKind: "compaction", sessionKind: "main" });
  });
});

describe("pi 0.83.0 API contract", () => {
  it("exports the transient assistant classifier while context overflow remains a separate category", () => {
    const message = (errorMessage: string): AssistantMessage => ({
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "contract",
      model: "contract-model",
      usage: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage,
      timestamp: 1,
    });
    expect(isRetryableAssistantError(message("503 service unavailable"))).toBe(true);
    expect(isRetryableAssistantError(message("quota exceeded"))).toBe(false);
    const overflow = message("503 server error: input exceeds the context window");
    expect(isRetryableAssistantError(overflow)).toBe(true);
    expect(isContextOverflow(overflow, 100_000)).toBe(true);
  });

  it("maps an unknown OpenAI-compatible terminal reason to a loud error while retaining the raw reason", async () => {
    const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-completions");
    const body = [
      `data: ${JSON.stringify({
        id: "contract-response",
        model: "contract-model",
        choices: [{ index: 0, delta: {}, finish_reason: "provider_mystery" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const injectedFetch = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const result = await streamSimple({
      id: "contract-model",
      name: "Contract Model",
      api: "openai-completions",
      provider: "contract",
      baseUrl: "https://example.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    }, { systemPrompt: "contract", messages: [] }, {
      apiKey: "contract-key",
      fetch: injectedFetch,
    }).result();

    expect(injectedFetch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      stopReason: "error",
      rawStopReason: "provider_mystery",
    });
    expect(result.errorMessage).toBe("Provider finish_reason: provider_mystery");
  });

  it("declares and resolves the four direct Pi 0.83.0 packages", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      engines: { node: string };
    };

    expect(Object.fromEntries(PI_SUITE_PACKAGES.map((name) => [name, manifest.dependencies[name]])))
      .toEqual(Object.fromEntries(PI_SUITE_PACKAGES.map((name) => [name, "0.83.0"])));
    expect(manifest.engines.node).toBe(">=22.19.0");
    expect(validatePiSuite({ packageRoot: root }))
      .toMatchObject({ ok: true, version: "0.83.0" });

    for (const name of PI_SUITE_PACKAGES) {
      const installed = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as {
        name: string;
        version: string;
        engines?: { node?: string };
      };
      expect(installed, name).toMatchObject({
        name,
        version: "0.83.0",
        engines: { node: ">=22.19.0" },
      });
    }
  });

  it("aligns direct and coding-agent-context TypeBox 1.3.7 and compiles a real PiCC tool schema", async () => {
    const directRequire = createRequire(import.meta.url);
    const codingAgentRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const contexts = [directRequire, codingAgentRequire];
    const schema = createAgentToolDefinition({} as SubagentRuntime, { depth: 0 }).parameters;
    const sample = {
      subagent_type: "general-purpose",
      prompt: "Inspect the runtime contract.",
      run_in_background: false,
    };

    for (const contextRequire of contexts) {
      const typeboxEntry = contextRequire.resolve("typebox");
      const manifest = JSON.parse(
        readFileSync(join(dirname(typeboxEntry), "..", "package.json"), "utf8"),
      ) as { version: string };
      const compileModule = await import(pathToFileURL(contextRequire.resolve("typebox/compile")).href) as {
        Compile(schema: unknown): { Check(value: unknown): boolean };
      };
      expect(manifest.version).toBe("1.3.7");
      expect(compileModule.Compile(schema).Check(sample)).toBe(true);
    }
  });

  it("honors Pi's startup checker suppression while an external host without it retains the checker", async () => {
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIndex = mainUrl.indexOf("/dist/");
    expect(distIndex, "unexpected Pi dist layout").toBeGreaterThan(0);
    const versionCheck: {
      checkForNewPiVersion(currentVersion: string): Promise<{ version: string } | undefined>;
    } = await import(`${mainUrl.slice(0, distIndex)}/dist/utils/version-check.js`);
    const previousFetch = globalThis.fetch;
    const previousSkip = process.env.PI_SKIP_VERSION_CHECK;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response(JSON.stringify({ version: "999.0.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      process.env.PI_SKIP_VERSION_CHECK = "1";
      await expect(versionCheck.checkForNewPiVersion("0.83.0")).resolves.toBeUndefined();
      expect(requests).toBe(0);

      delete process.env.PI_SKIP_VERSION_CHECK;
      await expect(versionCheck.checkForNewPiVersion("0.83.0")).resolves.toMatchObject({ version: "999.0.0" });
      expect(requests).toBe(1);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousSkip === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
      else process.env.PI_SKIP_VERSION_CHECK = previousSkip;
    }
  });

  it("pins fresh in-memory summarization and provider retry defaults through public getters", () => {
    const settings = SettingsManager.inMemory();
    expect(settings.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
    });
    expect(settings.getProviderRetrySettings()).toEqual({
      timeoutMs: undefined,
      maxRetries: undefined,
      maxRetryDelayMs: 60_000,
    });
  });

  const summaryModel: Model<"openai-completions"> = {
    id: "summary-contract",
    name: "Summary Contract",
    api: "openai-completions",
    provider: "contract",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
  };
  const summaryInput = [{
    role: "user" as const,
    content: [{ type: "text" as const, text: "Summarize this contract conversation." }],
    timestamp: 1,
  }];
  const summaryUsage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const summaryResponse = (stopReason: AssistantMessage["stopReason"], text: string, errorMessage?: string): AssistantMessage => ({
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: summaryModel.api,
    provider: summaryModel.provider,
    model: summaryModel.id,
    usage: summaryUsage,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  });
  type SummaryStreamFn = NonNullable<Parameters<typeof generateSummary>[9]>;
  const scriptedSummaryStream = (responses: AssistantMessage[], calls: { count: number }): SummaryStreamFn =>
    () => {
      calls.count += 1;
      const stream = createAssistantMessageEventStream();
      const response = responses.shift();
      if (!response) throw new Error("summary stream script exhausted");
      stream.end(response);
      return stream;
    };
  const runSummary = (
    streamFn: SummaryStreamFn,
    options: { signal?: AbortSignal; callbacks?: RetryCallbacks; baseDelayMs?: number } = {},
  ) => generateSummary(
    summaryInput,
    summaryModel,
    1_000,
    undefined,
    undefined,
    options.signal,
    undefined,
    undefined,
    undefined,
    streamFn,
    undefined,
    { enabled: true, maxRetries: 1, baseDelayMs: options.baseDelayMs ?? 0 },
    options.callbacks,
  );

  it("retries a transient summarization transport failure inside one public summary operation", async () => {
    const calls = { count: 0 };
    const scheduled: Array<[number, number, number, string]> = [];
    const started: number[] = [];
    const finished: Array<[boolean, number, string?]> = [];
    const result = await runSummary(scriptedSummaryStream([
      summaryResponse("error", "", "socket connection was closed"),
      summaryResponse("stop", "usable summary"),
    ], calls), {
      callbacks: {
        onRetryScheduled: (...event) => { scheduled.push(event); },
        onRetryAttemptStart: () => { started.push(calls.count); },
        onRetryFinished: (...event) => { finished.push(event); },
      },
    });

    expect(result).toBe("usable summary");
    expect(calls.count).toBe(2);
    expect(scheduled).toEqual([[1, 1, 0, "socket connection was closed"]]);
    expect(started).toEqual([1]);
    expect(finished).toEqual([[true, 1]]);
  });

  it("fails fast when the initial summary response is aborted", async () => {
    const calls = { count: 0 };
    const scheduled: number[] = [];
    await expect(runSummary(scriptedSummaryStream([
      summaryResponse("aborted", ""),
    ], calls), {
      callbacks: { onRetryScheduled: (attempt) => { scheduled.push(attempt); } },
    })).resolves.toBe("");
    expect(calls.count).toBe(1);
    expect(scheduled).toEqual([]);
  });

  it.each([
    ["deterministic HTTP 400", "Provider returned HTTP 400 Bad Request: invalid request shape"],
    ["overlapping HTTP 429 quota/billing", "HTTP 429 Too Many Requests: insufficient_quota billing quota exceeded"],
    ["authentication", "HTTP 401 Unauthorized: authentication failed, invalid API key"],
  ])("does not retry a %s summarization failure", async (_category, errorMessage) => {
    const calls = { count: 0 };
    const scheduled: number[] = [];
    await expect(runSummary(scriptedSummaryStream([
      summaryResponse("error", "", errorMessage),
    ], calls), {
      callbacks: { onRetryScheduled: (attempt) => { scheduled.push(attempt); } },
    })).rejects.toThrow(`Summarization failed: ${errorMessage}`);
    expect(calls.count).toBe(1);
    expect(scheduled).toEqual([]);
  });

  it("cancels a scheduled summarization retry without a surviving timer or provider call", async () => {
    vi.useFakeTimers();
    try {
      const calls = { count: 0 };
      const abort = new AbortController();
      const attemptStarts: number[] = [];
      const finished: Array<[boolean, number, string?]> = [];
      let retryScheduled!: () => void;
      const scheduled = new Promise<void>((resolve) => { retryScheduled = resolve; });
      const settlement = runSummary(scriptedSummaryStream([
        summaryResponse("error", "", "terminated while reading summary stream"),
      ], calls), {
        signal: abort.signal,
        baseDelayMs: 60_000,
        callbacks: {
          onRetryScheduled: () => { retryScheduled(); },
          onRetryAttemptStart: () => { attemptStarts.push(calls.count); },
          onRetryFinished: (...event) => { finished.push(event); },
        },
      });

      await scheduled;
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      abort.abort();
      const result = await settlement;
      expect(result).toBe("");
      expect(abort.signal.aborted).toBe(true);
      expect(calls.count).toBe(1);
      expect(attemptStarts).toEqual([]);
      expect(finished).toEqual([[false, 1, "terminated while reading summary stream"]]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();
      expect(calls.count).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exports the SDK surface PiCC uses", async () => {
    const sdk: Record<string, unknown> = await import("@earendil-works/pi-coding-agent");
    for (const name of [
      "createAgentSession",
      "DefaultResourceLoader",
      "SessionManager",
      "SettingsManager",
      "ModelRegistry",
      "defineTool",
      "createBashTool",
      "createReadTool",
      "createWriteTool",
      "createEditTool",
      "createGrepTool",
      "createFindTool",
      "createLsTool",
      "truncateHead",
      "truncateTail",
      "CONFIG_DIR_NAME",
    ]) {
      expect(sdk[name], `missing pi export: ${name}`).toBeDefined();
    }
  });

  it("keeps interleaved main and child provider registrations stateless through independent shutdown", async () => {
    const main = fakePi();
    const childA = fakePi();
    const childB = fakePi();
    picc(main.api as never);
    picc(childA.api as never);
    picc(main.api as never);
    picc(childB.api as never);
    picc(childA.api as never);
    for (const registry of [main, childA, childB]) {
      const registrations = registry.providerRegistrations.filter((entry) => entry.name === "picc-codex-abort-guard");
      expect(registrations).toHaveLength(1);
      expect(Object.keys(registrations[0]!.config).sort()).toEqual(["api", "streamSimple"]);
    }
    await Promise.all([
      ...(main.handlers.get("session_shutdown") ?? []).map((handler) => handler({ reason: "test" }, main.printCtx())),
      ...(childA.handlers.get("session_shutdown") ?? []).map((handler) => handler({ reason: "test" }, childA.printCtx())),
    ]);

    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    let fetches = 0;
    let sockets = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("pre-aborted surviving guard must not fetch");
    }) as typeof fetch;
    globalThis.WebSocket = class {
      constructor() {
        sockets += 1;
        throw new Error("pre-aborted surviving guard must not open a socket");
      }
    } as never;
    try {
      const surviving = childB.providerRegistrations[0]!.config.streamSimple as typeof codexAbortGuardStreamSimple;
      const abort = new AbortController();
      abort.abort();
      const model: any = {
        id: "gpt-test", name: "GPT Test", api: "openai-codex-responses", provider: "openai-codex",
        baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
      };
      await surviving(model, { systemPrompt: "", messages: [] }, {
        apiKey: "unused", signal: abort.signal, sessionId: "surviving-after-independent-shutdown",
      }).result();
      expect(fetches).toBe(0);
      expect(sockets).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("claims the Codex API handler only once for the same extension registry", () => {
    const isolated = fakePi();
    picc(isolated.api as never);
    picc(isolated.api as never);
    expect(isolated.providerRegistrations.filter((entry) => entry.name === "picc-codex-abort-guard")).toHaveLength(1);
  });

  it("public Codex abort guard sends no HTTP/WebSocket request when pre-aborted and leaves normal auto transport enabled", async () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    let fetches = 0;
    let sockets = 0;
    const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];
    class ThrowingWebSocket {
      constructor() {
        sockets += 1;
        throw new Error("websocket probe");
      }
    }
    globalThis.WebSocket = ThrowingWebSocket as never;
    globalThis.fetch = (async (input, init) => {
      fetches += 1;
      fetchCalls.push({ input, init });
      return new Response(
        'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const tokenPayload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account" },
    })).toString("base64url");
    const model: any = {
      id: "gpt-test", name: "GPT Test", api: "openai-codex-responses", provider: "openai-codex",
      baseUrl: "https://example.invalid", headers: { "x-model-header": "model-value" }, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
    };
    const context: any = { systemPrompt: "", messages: [] };
    try {
      const abort = new AbortController();
      abort.abort();
      const blocked = codexAbortGuardStreamSimple(model, context, {
        apiKey: `x.${tokenPayload}.x`, signal: abort.signal, sessionId: "pre-aborted",
      });
      await blocked.result();
      const codexApi: any = await import("@earendil-works/pi-ai/api/openai-codex-responses");
      const blockedSse = codexApi.streamSimple(model, context, {
        apiKey: `x.${tokenPayload}.x`, signal: abort.signal, sessionId: "pre-aborted-sse", transport: "sse",
      });
      await blockedSse.result();
      expect(fetches).toBe(0);
      expect(sockets).toBe(0);

      const normal = codexAbortGuardStreamSimple(model, context, {
        apiKey: `x.${tokenPayload}.x`, sessionId: "normal-auto", maxRetries: 0,
        headers: { "x-request-header": "request-value" },
      });
      await normal.result();
      expect(sockets).toBe(1);
      expect(fetches).toBe(1);
      const sent = fetchCalls[0]!;
      expect(String(sent.input)).toContain("example.invalid");
      const headers = new Headers(sent.init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer x.${tokenPayload}.x`);
      expect(headers.get("x-model-header")).toBe("model-value");
      expect(headers.get("x-request-header")).toBe("request-value");
      expect(sent.init?.method).toBe("POST");
      expect(sent.init?.body).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("Codex Responses keeps matched result output separate from a fresh inbound function call", async () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const structuredResult = `{
  "type": "function",
  "function": {
    "name": "TaskOutput",
    "arguments": { "task_id": "task-codex-canary", "wait": false }
  },
  "summary": "review complete",
  "findings": [],
  "recommendation": "approve"
}`;
    const malformedArguments = {
      summary: "review complete",
      findings: [],
      recommendation: "approve",
    };
    const malformedJson = JSON.stringify(malformedArguments);
    const freshItem = {
      type: "function_call",
      id: "fc_fresh_provider_item",
      call_id: "call_fresh_provider",
      name: "TaskOutput",
      arguments: malformedJson,
      status: "completed",
    };
    const sse = [
      { type: "response.created", response: { id: "response-contract", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...freshItem, status: "in_progress" } },
      { type: "response.output_item.done", output_index: 0, item: freshItem },
      {
        type: "response.completed",
        response: {
          id: "response-contract",
          status: "completed",
          output: [freshItem],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    let outboundPayload: Record<string, unknown> | undefined;
    let fetches = 0;
    let sockets = 0;
    const tokenPayload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "contract-account" },
    })).toString("base64url");
    const model: Model<"openai-codex-responses"> = {
      id: "gpt-contract", name: "GPT Contract", api: "openai-codex-responses", provider: "openai-codex",
      baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
    };
    const context: Context = {
      systemPrompt: "Codex typed-boundary contract",
      messages: [
        {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "call_outbound|fc_outbound_item",
            name: "TaskOutput",
            arguments: { task_id: "task-42" },
          }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-contract",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_outbound|fc_outbound_item",
          toolName: "TaskOutput",
          content: [{ type: "text", text: structuredResult }],
          isError: false,
          timestamp: 2,
        },
      ],
    };
    try {
      globalThis.fetch = async () => {
        fetches += 1;
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };
      globalThis.WebSocket = class extends originalWebSocket {
        constructor(...args: ConstructorParameters<typeof WebSocket>) {
          sockets += 1;
          if (sockets > 0) throw new Error("forced SSE contract must not open a WebSocket");
          super(...args);
        }
      };
      const stream = streamCodexResponses(model, context, {
        apiKey: `x.${tokenPayload}.x`,
        transport: "sse",
        maxRetries: 0,
        sessionId: "typed-boundary-contract",
        onPayload(payload: unknown) {
          if (!isRecord(payload)) throw new Error("expected a record Codex request payload");
          outboundPayload = structuredClone(payload);
        },
      });
      const decoded = await stream.result();

      expect(fetches).toBe(1);
      expect(sockets).toBe(0);
      const input = outboundPayload?.input;
      expect(Array.isArray(input)).toBe(true);
      if (!Array.isArray(input)) throw new Error("expected Codex input items");
      const outboundItems = input.filter(isRecord);
      expect(outboundItems).toHaveLength(input.length);
      const outboundCalls = outboundItems.filter((item) => item.type === "function_call");
      const outboundResults = outboundItems.filter((item) => item.type === "function_call_output");
      expect(outboundCalls).toEqual([{
        type: "function_call",
        id: "fc_outbound_item",
        call_id: "call_outbound",
        name: "TaskOutput",
        arguments: JSON.stringify({ task_id: "task-42" }),
      }]);
      expect(outboundResults).toEqual([{
        type: "function_call_output",
        call_id: "call_outbound",
        output: structuredResult,
      }]);
      expect(typeof outboundResults[0]!.output).toBe("string");

      const decodedCalls = decoded.content.filter(isToolCall);
      expect(decodedCalls).toEqual([{
        type: "toolCall",
        id: "call_fresh_provider|fc_fresh_provider_item",
        name: "TaskOutput",
        arguments: malformedArguments,
      }]);
      expect(decodedCalls[0]!.id).not.toContain("call_outbound");
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.WebSocket = originalWebSocket;
    }
  });

  it("registered Codex override bypasses an already-open cached WebSocket and fetch when pre-aborted", async () => {
    const { WebSocketServer } = createRequire(import.meta.url)("ws") as { WebSocketServer: new(options: Record<string, unknown>) => any };
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string") throw new Error("expected TCP WebSocket address");
    let frames = 0;
    server.on("connection", (socket: any) => {
      socket.on("message", () => {
        frames += 1;
        socket.send(JSON.stringify({ type: "response.created", response: { id: "cached-response", status: "in_progress", output: [] } }));
        socket.send(JSON.stringify({
          type: "response.completed",
          response: { id: "cached-response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
        }));
      });
    });
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("fetch must not run");
    }) as typeof fetch;
    const isolated = fakePi();
    picc(isolated.api as never);
    const override = isolated.providerRegistrations.find((entry) => entry.name === "picc-codex-abort-guard")!
      .config.streamSimple as typeof codexAbortGuardStreamSimple;
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
    })).toString("base64url");
    const model: any = {
      id: "gpt-test", name: "GPT Test", api: "openai-codex-responses", provider: "openai-codex",
      baseUrl: `http://127.0.0.1:${address.port}`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
    };
    const options = { apiKey: `x.${payload}.x`, sessionId: "cached-guard-t05", transport: "websocket-cached" as const, maxRetries: 0 };
    try {
      const warm = override(model, { systemPrompt: "", messages: [] }, options);
      await warm.result();
      expect(frames).toBe(1);
      expect(fetches).toBe(0);

      const abort = new AbortController();
      abort.abort();
      const blocked = override(model, { systemPrompt: "", messages: [] }, { ...options, signal: abort.signal });
      await blocked.result();
      expect(frames).toBe(1);
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      const codexApi: any = await import("@earendil-works/pi-ai/api/openai-codex-responses");
      codexApi.closeOpenAICodexWebSocketSessions("cached-guard-t05");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("public OpenAI Responses and Completions transports send zero HTTP when pre-aborted", async () => {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("pre-aborted transport reached fetch");
    }) as typeof fetch;
    const baseModel = {
      id: "gpt-test", name: "GPT Test", provider: "openai", baseUrl: "https://example.invalid/v1",
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000, maxTokens: 1_000,
    };
    const context: any = { systemPrompt: "", messages: [] };
    try {
      for (const [subpath, api] of [
        ["openai-responses", "openai-responses"],
        ["openai-completions", "openai-completions"],
      ] as const) {
        const implementation: any = await import(`@earendil-works/pi-ai/api/${subpath}`);
        const abort = new AbortController();
        abort.abort();
        const stream = implementation.streamSimple(
          { ...baseModel, api },
          context,
          { apiKey: "test-key", signal: abort.signal },
        );
        await stream.result();
      }
      expect(fetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes the session factories and AgentSession methods PiCC uses", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    for (const [owner, methods] of [
      [sdk.SessionManager, ["inMemory", "create", "open", "forkFrom"]],
      [sdk.SettingsManager, ["inMemory"]],
      [sdk.SessionManager?.prototype, ["getSessionFile", "getBranch", "appendCustomEntry"]],
      // AgentSession methods live on the prototype; constructing a real session
      // needs a model/provider and belongs to the real-stack lane, not this smoke pin.
      [sdk.AgentSession?.prototype, [
        "prompt", "compact", "sendCustomMessage", "abortCompaction", "abort", "subscribe", "steer", "followUp",
      ]],
    ] as const) {
      for (const method of methods) expect(typeof owner?.[method], method).toBe("function");
    }
  });

  it("SessionManager.forkFrom copies custom entries from the source transcript", () => {
    const dir = mkdtempSync(join(tmpdir(), "picc-session-fork-contract-"));
    try {
      const source = SessionManager.create(dir, dir, { id: "source-custom" });
      source.appendMessage({ role: "user", content: "fork contract" } as never);
      source.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ready" }],
        stopReason: "stop",
      } as never);
      source.appendCustomEntry("picc-contract-custom", { marker: "copied" });
      const sourcePath = source.getSessionFile();
      expect(sourcePath).toBeTruthy();

      const fork = SessionManager.forkFrom(sourcePath!, dir, dir, { id: "fork-custom" });
      expect(fork.getBranch()).toContainEqual(expect.objectContaining({
        type: "custom",
        customType: "picc-contract-custom",
        data: { marker: "copied" },
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("real AgentSession emits mode-less block-array user starts and preserves occurrence queue order", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const ai: any = await import("@earendil-works/pi-ai");
    const cwd = mkdtempSync(join(tmpdir(), "picc-pi-queue-contract-"));
    const agentDir = join(cwd, "agent");
    const calls: any[] = [];
    const userStarts: any[] = [];
    let releaseFirst: (() => void) | undefined;
    let session: any;
    try {
      const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const settingsManager = sdk.SettingsManager.inMemory();
      const modelRuntime = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
      modelRuntime.hasConfiguredAuth = () => true;
      modelRuntime.getAuth = async () => ({ auth: { apiKey: "contract-test-key" }, source: "in-process contract" });
      modelRuntime.streamSimple = (_model: any, context: any) => {
        const stream = ai.createAssistantMessageEventStream();
        const index = calls.push(structuredClone(context)) - 1;
        void (async () => {
          if (index === 0) await firstRelease;
          const message = {
            role: "assistant", content: [{ type: "text", text: `answer-${index}` }],
            api: "openai-completions", provider: "mock", model: "queue-model",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop", timestamp: Date.now(),
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
        })();
        return stream;
      };
      const model = {
        id: "queue-model", name: "Queue Model", api: "openai-completions", provider: "mock",
        baseUrl: "http://127.0.0.1", reasoning: false, input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
      };
      const loader = new sdk.DefaultResourceLoader({
        cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [{ name: "queue-contract", factory: (api: any) => {
          api.on("message_start", (event: any) => {
            if (event.message?.role === "user") userStarts.push(structuredClone(event));
          });
        } }],
      });
      await loader.reload();
      ({ session } = await sdk.createAgentSession({
        cwd, agentDir, settingsManager, modelRuntime, model, resourceLoader: loader,
        sessionManager: sdk.SessionManager.inMemory(cwd), noTools: "all",
      }));

      const running = session.prompt("start");
      while (calls.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const imageA = { type: "image", mimeType: "image/png", data: "a" };
      const imageB = { type: "image", mimeType: "image/png", data: "b" };
      const steerA = [{ type: "text", text: "steer A" }, imageA];
      const steerB = [{ type: "text", text: "steer B" }, imageB];
      const followUpFirst = [{ type: "text", text: "follow-up first" }];
      const followUpSecond = [{ type: "text", text: "follow-up second" }];
      await session.followUp("follow-up first");
      await session.followUp("follow-up second");
      await session.steer("steer A", [structuredClone(imageA)]);
      await session.steer("steer B", [structuredClone(imageB)]);
      await session.steer("steer A", [structuredClone(imageA)]);
      releaseFirst?.();
      await running;

      expect(calls).toHaveLength(6);
      const users = (call: any) => call.messages
        .filter((message: any) => message.role === "user")
        .map((message: any) => message.content);
      expect(users(calls[0])).toEqual([[{ type: "text", text: "start" }]]);
      const providerQueueOrder = calls.slice(1).map((call) => users(call).at(-1));
      expect(providerQueueOrder).toEqual([
        steerA, steerB, steerA, followUpFirst, followUpSecond,
      ]);
      expect(providerQueueOrder.filter((content) => JSON.stringify(content) === JSON.stringify(steerA))).toHaveLength(2);
      expect(providerQueueOrder[0]).not.toBe(providerQueueOrder[2]);

      const eventQueueOrder = userStarts.slice(1).map((event) => event.message.content);
      expect(userStarts[0]!.message.content).toEqual([{ type: "text", text: "start" }]);
      expect(eventQueueOrder).toEqual([
        steerA, steerB, steerA, followUpFirst, followUpSecond,
      ]);
      expect(eventQueueOrder.filter((content) => JSON.stringify(content) === JSON.stringify(steerA))).toHaveLength(2);
      expect(eventQueueOrder[0]).not.toBe(eventQueueOrder[2]);
      for (const event of userStarts) {
        expect(event).not.toHaveProperty("streamingBehavior");
        expect(event).not.toHaveProperty("delivery");
        expect(event.message).not.toHaveProperty("delivery");
      }
    } finally {
      releaseFirst?.();
      session?.dispose?.();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("AgentSession exposes getSessionStats() for usage accounting", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    expect(typeof sdk.AgentSession?.prototype?.getSessionStats).toBe("function");
  });

  it("exposes create*ToolDefinition factories whose renderCall/renderResult are functions", async () => {
    // The self-shell de-padding of the built-ins sources renderers from these
    // public Definition factories (create*Tool strips renderers via
    // wrapToolDefinition). A Pi upgrade that moves/renames them — or drops the
    // renderer shape the wrap frames — fails loudly here rather than degrading
    // the built-in rows silently in the terminal.
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    for (const name of [
      "createReadToolDefinition",
      "createWriteToolDefinition",
      "createEditToolDefinition",
      "createBashToolDefinition",
      "createGrepToolDefinition",
      "createFindToolDefinition",
      "createLsToolDefinition",
    ]) {
      expect(typeof sdk[name], `missing/renamed ${name}`).toBe("function");
    }
    // read + edit are the payloads our renderers frame (truncation + diff) —
    // pin that both expose renderCall/renderResult on a constructed definition.
    for (const name of ["createReadToolDefinition", "createEditToolDefinition"]) {
      const def = sdk[name]("/cwd");
      expect(typeof def.renderCall, `${name}().renderCall`).toBe("function");
      expect(typeof def.renderResult, `${name}().renderResult`).toBe("function");
    }
  });

  it("our getTextOutput reproduction matches Pi's real render-utils.js transform", async () => {
    // We reproduce Pi's getTextOutput locally because the deep path is
    // exports-blocked by the package name. The concrete file IS importable via an
    // absolute file:// URL — pin the reproduction against Pi's own so a version
    // bump that changes the transform (CRLF stripping, image fallbacks) fails
    // loudly instead of silently diverging.
    const { getTextOutput: ours } = await import("../src/runtime/tool-shell.js");
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIdx = mainUrl.indexOf("/dist/");
    expect(distIdx, "unexpected Pi dist layout").toBeGreaterThan(0);
    const realUrl = `${mainUrl.slice(0, distIdx)}/dist/core/tools/render-utils.js`;
    const real: any = await import(realUrl);
    expect(typeof real.getTextOutput, "Pi render-utils getTextOutput moved").toBe("function");

    const payloads = [
      // CRLF-bearing text: every \r must be removed (a bare \r would return the
      // cursor to col 0 and corrupt the row).
      { content: [{ type: "text", text: "line-a\r\nline-b\rTAIL" }] },
      // Image block with no text: the [image …] fallback indicator is appended.
      { content: [{ type: "image", data: "Zm9v", mimeType: "image/png" }] },
      // Mixed text + image.
      {
        content: [
          { type: "text", text: "hello\r\nworld" },
          { type: "image", data: "Zm9v", mimeType: "image/png" },
        ],
      },
    ];
    for (const showImages of [false, true]) {
      for (const p of payloads) {
        expect(ours(p as never, showImages)).toBe(real.getTextOutput(p, showImages));
      }
    }
  });

  it("extension ctx pins the UI widget surface and the mode/hasUI gating reality", async () => {
    // The subagent status panel installs via ctx.ui.setWidget from a
    // `ctx.mode === "tui"` gate. This pins WHY that gate (and only that gate)
    // is valid, against Pi's real ExtensionRunner ctx:
    //  - Default (print) mode: hasUI is FALSE, but every UI verb — setWidget,
    //    custom, onTerminalInput — is PRESENT as a no-op (Pi's noOpUIContext
    //    implements the full ExtensionUIContext). Method presence therefore
    //    proves nothing about interactivity.
    //  - A bound non-TUI UI context (RPC): hasUI flips TRUE while mode stays
    //    "rpc" — so a hasUI gate would wrongly install TUI chrome in RPC.
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const runner = new sdk.ExtensionRunner(
      [],
      sdk.createExtensionRuntime(),
      process.cwd(),
      {},
      {},
    );
    const ctx = runner.createContext();
    expect(ctx.mode).toBe("print");
    expect(ctx.hasUI).toBe(false);
    for (const verb of ["setWidget", "custom", "onTerminalInput", "notify", "setStatus"]) {
      expect(typeof ctx.ui[verb], `print-mode ui.${verb} must exist (no-op)`).toBe("function");
    }
    // No-op reality: callable without a TUI, returning nothing/unsubscribe.
    expect(ctx.ui.setWidget("k", ["x"], { placement: "belowEditor" })).toBeUndefined();
    expect(typeof ctx.ui.onTerminalInput(() => undefined)).toBe("function");
    await expect(ctx.ui.custom(() => ({ render: () => [] }))).resolves.toBeUndefined();

    // Bind a (dummy) UI context as RPC mode does → the hasUI trap.
    runner.setUIContext({ setWidget: () => undefined }, "rpc");
    expect(ctx.mode).toBe("rpc");
    expect(ctx.hasUI).toBe(true);
  });

  it("fake-pi's print-mode ctx matches the pinned print-mode reality", async () => {
    // The "no setWidget in print mode" tests must model Pi, not mirror
    // whichever field the implementation happens to read — so the fake's
    // print ctx is pinned here against the same shape as the real one above.
    const ctx: any = fakePi().printCtx();
    expect(ctx.mode).toBe("print");
    expect(ctx.hasUI).toBe(false);
    for (const verb of ["setWidget", "custom", "onTerminalInput", "notify", "setStatus"]) {
      expect(typeof ctx.ui[verb], `fake print-mode ui.${verb} must exist`).toBe("function");
    }
  });

  it("registerShortcut exists on the extension API and records the shortcut", async () => {
    // The panel-entry chord (alt+a) registers through pi.registerShortcut;
    // fake-pi mirrors it, so a Pi rename must fail here first. The loader is
    // not re-exported at the package root, so it is imported by file URL —
    // the same pattern as the render-utils getTextOutput pin above.
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIdx = mainUrl.indexOf("/dist/");
    expect(distIdx, "unexpected Pi dist layout").toBeGreaterThan(0);
    const loader: any = await import(`${mainUrl.slice(0, distIdx)}/dist/core/extensions/loader.js`);
    expect(typeof loader.loadExtensionFromFactory, "Pi extension loader moved").toBe("function");
    let captured: any;
    const ext = await loader.loadExtensionFromFactory(
      (pi: any) => {
        captured = pi;
        pi.registerShortcut("alt+a", { description: "probe", handler: () => undefined });
      },
      process.cwd(),
      sdk.createEventBus(),
      sdk.createExtensionRuntime(),
    );
    expect(typeof captured.registerShortcut).toBe("function");
    expect(ext.shortcuts.get("alt+a")?.description).toBe("probe");
  });

  it("registerMessageRenderer exists on the real ExtensionAPI and sendMessage threads a details param", async () => {
    // The picc-settlement completion record hangs off BOTH seams: index.ts
    // registers a custom-message renderer via pi.registerMessageRenderer and
    // attaches the structured record payload as sendMessage's `details`. A Pi
    // rename/drop must fail here first, not degrade the settlement notice
    // silently to the default box (or strip the record data).
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIdx = mainUrl.indexOf("/dist/");
    expect(distIdx, "unexpected Pi dist layout").toBeGreaterThan(0);
    const loader: any = await import(`${mainUrl.slice(0, distIdx)}/dist/core/extensions/loader.js`);
    const runtime = loader.createExtensionRuntime
      ? loader.createExtensionRuntime()
      : sdk.createExtensionRuntime();
    let captured: any;
    const renderer = () => undefined;
    const ext = await loader.loadExtensionFromFactory(
      (pi: any) => {
        captured = pi;
        pi.registerMessageRenderer("picc-contract-probe", renderer);
      },
      process.cwd(),
      sdk.createEventBus(),
      runtime,
    );
    expect(typeof captured.registerMessageRenderer, "Pi moved: ExtensionAPI.registerMessageRenderer").toBe(
      "function",
    );
    // Registration is recorded where the interactive mode reads it back.
    expect(
      ext.messageRenderers?.get("picc-contract-probe"),
      "Pi moved: registerMessageRenderer no longer records into Extension.messageRenderers",
    ).toBe(renderer);
    // sendMessage accepts and threads `details` (bind the runtime slot the way
    // Runner.bindCore does — createExtensionRuntime ships throwing stubs).
    const sent: Array<{ message: any; options: any }> = [];
    runtime.sendMessage = (message: any, options: any) => sent.push({ message, options });
    captured.sendMessage(
      { customType: "picc-contract-probe", content: "c", display: true, details: { probe: 1 } },
      { deliverAs: "steer" },
    );
    expect(sent, "Pi moved: ExtensionAPI.sendMessage no longer forwards to the runtime").toHaveLength(1);
    expect(
      sent[0]!.message.details,
      "Pi moved: sendMessage dropped/renamed the details param",
    ).toEqual({ probe: 1 });
    expect(sent[0]!.options?.deliverAs).toBe("steer");
  });

  it("CustomMessageComponent drives the registered renderer with a BOOLEAN expanded and defaults on undefined", async () => {
    // The collapsed-by-default settlement record keys on the EXPLICIT
    // `options.expanded === false`; nested/detail-less messages return undefined
    // to get Pi's default box. Pin both against Pi's REAL interactive component
    // (exported at the package root), so a Pi change to the renderer calling
    // convention fails loudly here.
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    // The component reads Pi's module-global theme singleton — initialize it,
    // as the wired-edit integration test does.
    sdk.initTheme();
    const message = {
      role: "custom",
      customType: "picc-probe",
      content: "notice body",
      display: true,
      details: { record: "probe" },
      timestamp: Date.now(),
    };
    const seen: unknown[] = [];
    const component = new sdk.CustomMessageComponent(message, (m: any, options: any) => {
      expect(m, "Pi moved: renderer no longer receives the CustomMessage itself").toBe(message);
      seen.push(options?.expanded);
      return { render: () => ["probe-line"] };
    });
    // The global Ctrl+O toggle reaches custom messages through setExpanded.
    expect(
      typeof component.setExpanded,
      "Pi moved: CustomMessageComponent.setExpanded (Ctrl+O expand reach)",
    ).toBe("function");
    component.setExpanded(true);
    expect(seen, "Pi moved: message renderer no longer gets a boolean `expanded`").toEqual([
      false,
      true,
    ]);
    expect(component.render(80).join("\n")).toContain("probe-line");
    // A renderer returning undefined falls back to Pi's default labeled box.
    const fallback = new sdk.CustomMessageComponent(message, () => undefined);
    expect(fallback.render(80).join("\n")).toContain("picc-probe");
  });

  it("typebox + StringEnum are importable the way our tools use them", async () => {
    const { Type } = await import("typebox");
    const { StringEnum } = await import("@earendil-works/pi-ai");
    expect(typeof Type.Object).toBe("function");
    expect(typeof StringEnum).toBe("function");
  });

  it("type pins compile against the pinned Pi: stopReason/errorMessage, execute, transcripts, and full lifecycle event payloads", async () => {
    // vitest strips types without checking them and the project tsconfig
    // excludes test/, so the pins live in test/helpers/pi-contract-pins.ts and
    // are compiled HERE with the real TypeScript checker — Pi type churn fails
    // this test with the actual tsc diagnostics.
    const { createRequire } = await import("node:module");
    const { execFileSync } = await import("node:child_process");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const require = createRequire(import.meta.url);
    const tscBin = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
    const pinsConfig = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "helpers",
      "pi-contract-pins.tsconfig.json",
    );
    let output = "";
    let failed = false;
    try {
      output = execFileSync(process.execPath, [tscBin, "-p", pinsConfig], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string; message: string };
      output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message}`;
    }
    expect(failed, `Pi type contract broken:\n${output}`).toBe(false);
  }, 30_000);
});

describe("Codex standalone-summary transport contract", () => {
  const summaryPrompt = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";
  const apiKey = `x.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "summary-contract" },
  })).toString("base64url")}.x`;
  const model: Model<"openai-codex-responses"> = {
    id: "gpt-summary-contract", name: "GPT Summary Contract", api: "openai-codex-responses", provider: "openai-codex",
    baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_096,
  };
  const userMessage = (text: string, timestamp = 1) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp,
  });
  const summaryContext = (overrides: Partial<Context> = {}): Context => ({
    systemPrompt: summaryPrompt,
    messages: [userMessage("opaque summary input")],
    ...overrides,
  });
  const freshUuidV7 = () => {
    const bytes = randomBytes(16);
    let timestamp = BigInt(Date.now());
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = Number(timestamp & 0xffn);
      timestamp >>= 8n;
    }
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const summaryOptions = (overrides: Record<string, unknown> = {}) => ({
    apiKey,
    cacheRetention: "none" as const,
    sessionId: freshUuidV7(),
    transport: "websocket-cached" as const,
    maxRetries: 4,
    ...overrides,
  });
  const completedSse = (text = "summary ok") => {
    const output = [{
      type: "message", id: "msg-summary", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }];
    return [
      { type: "response.created", response: { id: "response-summary", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...output[0], status: "in_progress" } },
      { type: "response.output_item.done", output_index: 0, item: output[0] },
      { type: "response.completed", response: {
        id: "response-summary", status: "completed", output,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  };
  const okResponse = (text = "summary ok") => new Response(completedSse(text), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const truncatedSseResponse = () => new Response([
    { type: "response.created", response: { id: "response-truncated", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: {
      type: "message", id: "msg-truncated", role: "assistant", status: "in_progress", content: [],
    } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const overloadResponse = () => new Response("temporarily overloaded", {
    status: 429,
    headers: { "content-type": "text/plain", "retry-after": "0" },
  });
  const quotaResponse = () => new Response("insufficient_quota billing quota exceeded", {
    status: 429,
    headers: { "content-type": "text/plain", "retry-after": "0" },
  });
  const deterministicResponse = () => new Response("invalid request shape", {
    status: 400,
    headers: { "content-type": "text/plain" },
  });
  type ResponseFactory = () => Response;
  async function withCodexWire<T>(responses: ResponseFactory[], run: (wire: {
    fetches: Array<{ input: unknown; init?: RequestInit }>;
    sockets: { count: number };
  }) => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const fetches: Array<{ input: unknown; init?: RequestInit }> = [];
    const sockets = { count: 0 };
    globalThis.fetch = (async (input, init) => {
      fetches.push({ input, init });
      const response = responses.shift();
      if (!response) throw new Error("Codex response script exhausted");
      return response();
    }) as typeof fetch;
    globalThis.WebSocket = class {
      constructor() {
        sockets.count += 1;
        throw new Error("deterministic WebSocket probe");
      }
    } as never;
    try {
      return await run({ fetches, sockets });
    } finally {
      try {
        closeOpenAICodexWebSocketSessions();
      } finally {
        try {
          resetOpenAICodexWebSocketDebugStats();
        } finally {
          globalThis.fetch = originalFetch;
          globalThis.WebSocket = originalWebSocket;
        }
      }
    }
  }
  async function resultWithProviderTimers(stream: ReturnType<typeof codexAbortGuardStreamSimple>) {
    vi.useFakeTimers();
    try {
      const result = stream.result();
      await vi.runAllTimersAsync();
      return await result;
    } finally {
      try {
        await vi.runAllTimersAsync();
      } finally {
        vi.useRealTimers();
      }
    }
  }
  const runGeneratedSummary = (
    retry: { enabled: boolean; maxRetries: number; baseDelayMs: number },
    callbacks?: RetryCallbacks,
  ) => generateSummary(
    [userMessage("public generateSummary input")], model, 1_000, apiKey, undefined, undefined,
    undefined, undefined, undefined, codexAbortGuardStreamSimple as never, undefined, retry, callbacks,
  );

  it("routes public compaction and branch summary producers through forced SSE without provider retries", async () => {
    await withCodexWire([() => okResponse("history summary"), () => okResponse("branch summary")], async (wire) => {
      await expect(runGeneratedSummary({ enabled: true, maxRetries: 0, baseDelayMs: 0 }))
        .resolves.toBe("history summary");
      const branch = await generateBranchSummary([{
        type: "message", id: "entry-1", parentId: null, timestamp: new Date(0).toISOString(),
        message: userMessage("public generateBranchSummary input"),
      }], {
        model,
        apiKey,
        signal: new AbortController().signal,
        streamFn: codexAbortGuardStreamSimple as never,
        retry: { enabled: true, maxRetries: 0, baseDelayMs: 0 },
      });
      expect(branch.summary).toContain("branch summary");
      expect(wire.fetches).toHaveLength(2);
      expect(wire.sockets.count).toBe(0);
    });
  });

  it("leaves overload recovery to Pi's one outer summary retry loop", async () => {
    await withCodexWire([overloadResponse, () => okResponse("recovered")], async (wire) => {
      const scheduled: number[] = [];
      const started: number[] = [];
      const finished: Array<[boolean, number, string?]> = [];
      await expect(runGeneratedSummary(
        { enabled: true, maxRetries: 1, baseDelayMs: 0 },
        {
          onRetryScheduled: (attempt) => { scheduled.push(attempt); },
          onRetryAttemptStart: () => { started.push(scheduled.length); },
          onRetryFinished: (...event) => { finished.push(event); },
        },
      )).resolves.toBe("recovered");
      expect(wire.fetches).toHaveLength(2);
      expect(wire.sockets.count).toBe(0);
      expect(scheduled).toEqual([1]);
      expect(started).toEqual([1]);
      expect(finished).toEqual([[true, 1]]);
    });
  });

  it("recovers a truncated Codex SSE stream through exactly one public-summary retry lifecycle", async () => {
    await withCodexWire([truncatedSseResponse, () => okResponse("recovered after truncation")], async (wire) => {
      const scheduled: number[] = [];
      const started: number[] = [];
      const finished: Array<[boolean, number, string?]> = [];
      await expect(runGeneratedSummary(
        { enabled: true, maxRetries: 1, baseDelayMs: 0 },
        {
          onRetryScheduled: (attempt) => { scheduled.push(attempt); },
          onRetryAttemptStart: () => { started.push(scheduled.length); },
          onRetryFinished: (...event) => { finished.push(event); },
        },
      )).resolves.toBe("recovered after truncation");
      expect(wire.fetches).toHaveLength(2);
      expect(wire.sockets.count).toBe(0);
      expect(scheduled).toEqual([1]);
      expect(started).toEqual([1]);
      expect(finished).toEqual([[true, 1]]);
    });
  });

  it("exhausts overloads at the outer budget while quota and deterministic failures fail fast", async () => {
    await withCodexWire([overloadResponse, overloadResponse, overloadResponse], async (wire) => {
      const scheduled: number[] = [];
      await expect(runGeneratedSummary(
        { enabled: true, maxRetries: 2, baseDelayMs: 0 },
        { onRetryScheduled: (attempt) => { scheduled.push(attempt); } },
      )).rejects.toThrow(/Summarization failed:.*overloaded/i);
      expect(wire.fetches).toHaveLength(3);
      expect(wire.sockets.count).toBe(0);
      expect(scheduled).toEqual([1, 2]);
    });
    for (const response of [quotaResponse, deterministicResponse]) {
      await withCodexWire([response], async (wire) => {
        const scheduled: number[] = [];
        await expect(runGeneratedSummary(
          { enabled: true, maxRetries: 2, baseDelayMs: 0 },
          { onRetryScheduled: (attempt) => { scheduled.push(attempt); } },
        )).rejects.toThrow(/Summarization failed/);
        expect(wire.fetches).toHaveLength(1);
        expect(scheduled).toEqual([]);
      });
    }
  });

  it("preserves injected fetch through ordinary and forced-SSE summary delegation", async () => {
    const delegated = vi.fn(() => createAssistantMessageEventStream());
    const injectedFetch = vi.fn(async () => new Response()) as typeof fetch;
    vi.resetModules();
    vi.doMock("@earendil-works/pi-ai/compat", () => ({
      openAICodexResponsesApi: () => ({ streamSimple: delegated }),
    }));
    try {
      const isolated = await import("../src/runtime/codex-abort-guard.js");
      const ordinaryContext = { systemPrompt: "ordinary", messages: [] };
      const ordinaryOptions = { apiKey, sessionId: "ordinary-fetch", fetch: injectedFetch };
      isolated.codexAbortGuardStreamSimple(model, ordinaryContext, ordinaryOptions);

      const context = summaryContext({ tools: [] });
      const sessionId = freshUuidV7();
      const options = summaryOptions({ sessionId, temperature: 0.37, fetch: injectedFetch });
      isolated.codexAbortGuardStreamSimple(model, context, options);

      expect(delegated).toHaveBeenCalledTimes(2);
      expect(delegated).toHaveBeenNthCalledWith(1, model, ordinaryContext, ordinaryOptions);
      expect(delegated).toHaveBeenNthCalledWith(2, model, context, {
        ...options,
        sessionId,
        temperature: 0.37,
        fetch: injectedFetch,
        transport: "sse",
        maxRetries: 0,
      });
    } finally {
      vi.doUnmock("@earendil-works/pi-ai/compat");
      vi.resetModules();
    }
  });

  it("forces an exact-signature custom summary to one SSE provider attempt and preserves unrelated callbacks", async () => {
    await withCodexWire([overloadResponse], async (wire) => {
      const abort = new AbortController();
      const payloads: unknown[] = [];
      const responses: number[] = [];
      const stream = codexAbortGuardStreamSimple(model, summaryContext({ tools: [] }), summaryOptions({
        signal: abort.signal,
        headers: { "x-summary-contract": "preserved" },
        onPayload: (payload: unknown) => { payloads.push(payload); },
        onResponse: (response: { status: number }) => { responses.push(response.status); },
      }));
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(wire.fetches).toHaveLength(1);
      expect(wire.sockets.count).toBe(0);
      expect(payloads).toHaveLength(1);
      expect(responses).toEqual([429]);
      expect(new Headers(wire.fetches[0]!.init?.headers).get("x-summary-contract")).toBe("preserved");
      expect(wire.fetches[0]!.init?.signal?.aborted).toBe(false);
    });
  });

  it.each([
    ["cache retention", { options: { cacheRetention: "short" } }],
    ["UUIDv7 session shape", { options: { sessionId: "018f22e2-7c9b-4cc1-8c2a-123456789abc" } }],
    ["fixed system prompt", { context: { systemPrompt: `${summaryPrompt} changed` } }],
    ["tool absence", { context: { tools: [{ name: "probe", description: "probe", parameters: {} as never }] } }],
    ["one user-role message", { context: { messages: [userMessage("one"), userMessage("two", 2)] } }],
  ] as const)("treats a call with mutated %s as ordinary and preserves its provider retry budget", async (_name, mutation) => {
    await withCodexWire([overloadResponse, () => okResponse()], async (wire) => {
      const context = summaryContext("context" in mutation ? mutation.context as Partial<Context> : {});
      const options = summaryOptions("options" in mutation ? mutation.options : {});
      const result = await resultWithProviderTimers(
        codexAbortGuardStreamSimple(model, context, { ...options, transport: "sse", maxRetries: 1 }),
      );
      expect(result.stopReason).toBe("stop");
      expect(wire.fetches).toHaveLength(2);
      expect(wire.sockets.count).toBe(0);
    });
  });

  it.each([
    ["omitted", undefined, 1, 1],
    ["automatic", "auto", 1, 1],
    ["WebSocket-cached", "websocket-cached", 1, 1],
    ["SSE", "sse", 0, 1],
  ] as const)("preserves ordinary %s transport selection", async (_name, transport, expectedSockets, expectedFetches) => {
    await withCodexWire([() => okResponse()], async (wire) => {
      const options = {
        apiKey,
        sessionId: `ordinary-${_name}`,
        maxRetries: 0,
        ...(transport === undefined ? {} : { transport }),
      };
      await codexAbortGuardStreamSimple(model, { systemPrompt: "ordinary", messages: [] }, options).result();
      expect(wire.sockets.count).toBe(expectedSockets);
      expect(wire.fetches).toHaveLength(expectedFetches);
    });
  });

  it("preserves omitted and explicit nonzero provider retry budgets on ordinary SSE calls", async () => {
    await withCodexWire([overloadResponse], async (wire) => {
      const result = await codexAbortGuardStreamSimple(model, { systemPrompt: "ordinary", messages: [] }, {
        apiKey, transport: "sse", cacheRetention: "none", sessionId: "ordinary-retries-omitted",
      }).result();
      expect(result.stopReason).toBe("error");
      expect(wire.fetches).toHaveLength(1);
    });
    await withCodexWire([overloadResponse, () => okResponse()], async (wire) => {
      const result = await resultWithProviderTimers(
        codexAbortGuardStreamSimple(model, { systemPrompt: "ordinary", messages: [] }, {
          apiKey, transport: "sse", maxRetries: 1, cacheRetention: "none",
          sessionId: "ordinary-cache-none-is-insufficient",
        }),
      );
      expect(result.stopReason).toBe("stop");
      expect(wire.fetches).toHaveLength(2);
      expect(wire.sockets.count).toBe(0);
    });
  });

  it("pre-aborted ordinary and summary calls perform no network work while summaries keep the collision policy", async () => {
    await withCodexWire([], async (wire) => {
      for (const [context, options] of [
        [{ systemPrompt: "ordinary", messages: [] }, { apiKey, sessionId: "aborted-ordinary", maxRetries: 3 }],
        [summaryContext(), summaryOptions()],
      ]) {
        const abort = new AbortController();
        abort.abort();
        const result = await codexAbortGuardStreamSimple(model, context as Context, { ...options, signal: abort.signal }).result();
        expect(result.stopReason).toBe("aborted");
      }
      expect(wire.fetches).toHaveLength(0);
      expect(wire.sockets.count).toBe(0);
    });
  });
});

describe("real Pi compact-search composition", () => {
  const cases = [
    {
      name: "Grep" as const,
      args: { pattern: "lifecycle-needle", path: "src", output_mode: "content", head_limit: 1 },
      ordinary: {
        content: [{ type: "text", text: "src/a.ts:1:lifecycle-needle\nsrc/b.ts:2:lifecycle-needle" }],
        details: { mode: "content", engine: "js", totalEntries: 1, returnedEntries: 1, truncated: false },
        isError: false,
      },
      status: {
        content: [
          { type: "text", text: "src/a.ts:1:lifecycle-needle" },
          { type: "text", text: "Post-processing Grep feedback." },
        ],
        details: { mode: "content", engine: "js", totalEntries: 3, returnedEntries: 1, truncated: true },
        isError: false,
      },
      statusText: /limited|lim/,
      hidden: "src/a.ts:1",
    },
    {
      name: "Glob" as const,
      args: { pattern: "**/*.ts", path: "src" },
      ordinary: {
        content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
        details: { totalMatches: 2, returned: 2, capped: false, truncated: false },
        isError: false,
      },
      status: {
        content: [
          { type: "text", text: "src/a.ts" },
          { type: "text", text: "Post-processing Glob feedback." },
        ],
        details: { totalMatches: 250, returned: 200, capped: true, truncated: true },
        isError: false,
      },
      statusText: /capped|cap/,
      hidden: "src/a.ts",
    },
  ];

  it.each(cases)("composes result-owned $name summaries in collapsed, expanded, and reconstructed TUI rows", async (search) => {
    const { ToolExecutionComponent, initTheme } = (await import(
      "@earendil-works/pi-coding-agent"
    )) as any;
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    initTheme();
    const definition = wrapForSelfShell(withCompactSearchRendering({ name: search.name } as any));
    const build = (payload: any) => {
      const component = new ToolExecutionComponent(
        search.name, `${search.name}-contract`, search.args, {}, definition,
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      component.updateResult(payload, false);
      return component;
    };
    const paint = (component: any, expanded: boolean, width = 100): string[] => {
      component.setExpanded(expanded);
      const lines = component.render(width) as string[];
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      return lines;
    };

    const collapsed = paint(build(search.ordinary), false);
    expect(collapsed).toHaveLength(2); // shell-owned separator + one result-owned content row
    expect(collapsed[0]).toBe("");
    expect(collapsed[1]).toContain(search.name.toLowerCase());
    expect(collapsed.join("\n")).toContain("ctrl+o to expand");
    expect(collapsed.join("\n")).not.toContain(search.hidden);

    const expanded = paint(build(search.ordinary), true);
    expect(expanded[0]).toBe("");
    expect(expanded[1]).toContain(search.name.toLowerCase());
    expect(expanded.join("\n").split(search.hidden)).toHaveLength(2);
    expect(paint(build(search.ordinary), false).join("\n")).not.toContain(search.hidden);

    const partial = new ToolExecutionComponent(
      search.name, `${search.name}-partial`, search.args, {}, definition,
      { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
    );
    partial.updateResult(search.ordinary, true);
    expect(paint(partial, false).join("\n")).toContain(search.hidden);

    const statusLines = paint(build(search.status), false, 48);
    expect(statusLines.join("\n")).toMatch(search.statusText);
    expect(statusLines.join("\n")).toContain(`Post-processing ${search.name} feedback.`);
    expect(statusLines.join("\n")).toContain("Recovery:");
    expect(statusLines.join("\n")).not.toContain(search.hidden);

    const failure = build({
      content: [{ type: "text", text: `${search.name} search failed; repair the input.` }],
      details: undefined,
      isError: true,
    });
    expect(paint(failure, false).join("\n")).toContain("failed");
    expect(paint(failure, false).join("\n")).toContain(`${search.name} search failed`);
  });

  it.each(cases)("keeps real Pi $name remapped and explicitly-unbound detail reachable", async (search) => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    sdk.initTheme();
    const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const piTui: any = piRequire("@earendil-works/pi-tui");
    const definitions = {
      ...piTui.TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    };
    const definition = wrapForSelfShell(withCompactSearchRendering({ name: search.name } as any));
    const build = () => {
      const component = new sdk.ToolExecutionComponent(
        search.name, `${search.name}-binding-contract`, search.args, {}, definition,
        { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
      );
      component.updateResult(search.ordinary, false);
      return component;
    };
    const render = (component: any, expanded: boolean) => {
      component.setExpanded(expanded);
      return (component.render(100) as string[]).join("\n");
    };
    const before = structuredClone(search.ordinary);
    try {
      piTui.setKeybindings(new piTui.KeybindingsManager(definitions, { "app.tools.expand": "alt+e" }));
      const remapped = build();
      expect(render(remapped, false)).toContain("alt+e to expand");
      expect(render(remapped, false)).not.toContain(search.hidden);
      expect(render(remapped, true).split(search.hidden)).toHaveLength(2);
      expect(render(remapped, false)).not.toContain(search.hidden);

      piTui.setKeybindings(new piTui.KeybindingsManager(definitions, { "app.tools.expand": [] }));
      const unbound = build();
      for (const expanded of [false, true, false]) {
        const pass = render(unbound, expanded);
        expect(pass.split(search.hidden)).toHaveLength(2);
        expect(pass).not.toContain("to expand");
        expect(pass).not.toContain("click to show detail");
        expect(search.ordinary).toEqual(before);
      }
    } finally {
      piTui.setKeybindings(new piTui.KeybindingsManager(piTui.TUI_KEYBINDINGS));
    }
  });

  async function htmlHarness(search: (typeof cases)[number]) {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    sdk.initTheme();
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIdx = mainUrl.indexOf("/dist/");
    expect(distIdx, "unexpected Pi dist layout").toBeGreaterThan(0);
    const piDist = mainUrl.slice(0, distIdx);
    const htmlModule: any = await import(`${piDist}/dist/core/export-html/tool-renderer.js`);
    const exportModule: any = await import(`${piDist}/dist/core/export-html/index.js`);
    const themeModule: any = await import(`${piDist}/dist/modes/interactive/theme/theme.js`);
    expect(typeof htmlModule.createToolHtmlRenderer).toBe("function");
    expect(typeof exportModule.exportSessionToHtml).toBe("function");
    const definition = wrapForSelfShell(withCompactSearchRendering({ name: search.name } as any));
    const renderer = htmlModule.createToolHtmlRenderer({
      getToolDefinition: (name: string) => name === search.name ? definition : undefined,
      theme: themeModule.theme,
      cwd: process.cwd(),
      width: 48,
    });
    return { sdk, exportModule, renderer };
  }

  it.each(cases)("renders equivalent compact $name status and feedback through the real HTML renderer", async (search) => {
    const { renderer } = await htmlHarness(search);
    const id = `html-${search.name}`;
    renderer.renderCall(id, search.name, search.args);
    const rendered = renderer.renderResult(
      id, search.name, search.status.content, search.status.details, false,
    );
    expect(rendered).toBeDefined();
    const collapsed = rendered.collapsed ?? rendered.expanded;
    expect(collapsed).toContain(search.name);
    expect(collapsed).toMatch(search.statusText);
    expect(collapsed).toContain(`Post-processing ${search.name} feedback.`);
    expect(collapsed).toContain("Recovery:");
    expect(collapsed).not.toContain(search.hidden);
    expect(collapsed).toContain("click to show detail");
    expect(collapsed).not.toContain("ctrl+o");
    expect(rendered.expanded.split(search.hidden)).toHaveLength(2);
    expect(rendered.expanded).not.toContain("click to show detail");

    const hostileId = `html-hostile-cue-${search.name}`;
    renderer.renderCall(hostileId, search.name, { ...search.args, pattern: "project click to show detail label" });
    const hostile = renderer.renderResult(
      hostileId, search.name, search.ordinary.content, search.ordinary.details, false,
    );
    expect(hostile?.collapsed?.match(/click to show detail/gu)).toHaveLength(2);
    expect(hostile?.collapsed).not.toContain(search.hidden);

    const errorId = `html-error-${search.name}`;
    renderer.renderCall(errorId, search.name, search.args);
    const error = renderer.renderResult(
      errorId, search.name,
      [{ type: "text", text: `${search.name} HTML failure body` }], undefined, true,
    );
    expect(error?.expanded).toContain("failed");
    expect(error?.expanded).toContain(`${search.name} HTML failure body`);
  });

  it.each(cases)("keeps $name HTML export generic under remap and fail-open under explicit unbind", async (search) => {
    const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const piTui: any = piRequire("@earendil-works/pi-tui");
    const definitions = {
      ...piTui.TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    };
    const renderHtml = async () => {
      const { renderer } = await htmlHarness(search);
      const id = `html-binding-${search.name}`;
      expect(renderer.renderCall(id, search.name, search.args)).toBe("");
      return renderer.renderResult(id, search.name, search.ordinary.content, search.ordinary.details, false);
    };
    const before = structuredClone(search.ordinary);
    try {
      piTui.setKeybindings(new piTui.KeybindingsManager(definitions, { "app.tools.expand": "alt+e" }));
      const remapped = await renderHtml();
      const collapsed = remapped?.collapsed ?? remapped?.expanded;
      expect(collapsed).toContain("click to show detail");
      expect(collapsed).not.toContain("alt+e");
      expect(collapsed).not.toContain(search.hidden);
      expect(remapped?.expanded.split(search.hidden)).toHaveLength(2);

      piTui.setKeybindings(new piTui.KeybindingsManager(definitions, { "app.tools.expand": [] }));
      const direct = withCompactSearchRendering({ name: search.name } as any);
      const directPass = (expanded: boolean) => {
        const context = { args: search.args, state: {}, isPartial: true } as any;
        direct.renderCall?.(search.args, undefined as never, context);
        return direct.renderResult?.(search.ordinary, { expanded, isPartial: false }, undefined as never, context)
          .render(48).join("\n");
      };
      const directCollapsed = directPass(false);
      const directExpanded = directPass(true);
      expect(directCollapsed).toBe(directExpanded);
      expect(directCollapsed.split(search.hidden)).toHaveLength(2);

      const unbound = await renderHtml();
      expect(unbound?.collapsed).toBeUndefined();
      expect(unbound?.expanded.split(search.hidden)).toHaveLength(2);
      expect(unbound?.expanded).not.toContain("to expand");
      expect(unbound?.expanded).not.toContain("click to show detail");
      expect(search.ordinary).toEqual(before);
    } finally {
      piTui.setKeybindings(new piTui.KeybindingsManager(piTui.TUI_KEYBINDINGS));
    }
  });

  it.each(cases)("assembles full $name HTML export with a generic header and one compact settled result", async (search) => {
    const { sdk, exportModule, renderer } = await htmlHarness(search);
    const dir = mkdtempSync(join(tmpdir(), "picc-search-export-"));
    const outputPath = join(dir, `${search.name}.html`);
    try {
      const session = sdk.SessionManager.create(dir, dir, { id: `compact-${search.name.toLowerCase()}` });
      const toolCallId = `export-${search.name}`;
      session.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: search.name, arguments: search.args }],
        stopReason: "toolUse",
      } as never);
      session.appendMessage({
        role: "toolResult",
        toolCallId,
        toolName: search.name,
        content: search.status.content,
        details: search.status.details,
        isError: false,
      } as never);

      await exportModule.exportSessionToHtml(session, undefined, { outputPath, toolRenderer: renderer });
      const html = readFileSync(outputPath, "utf8");
      const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
      expect(encoded).toBeDefined();
      const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
      const rendered = data.renderedTools?.[toolCallId];
      const canonicalResult = data.entries.find(
        (entry: any) => entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId,
      );

      expect(JSON.stringify(canonicalResult?.message?.content)).toContain(search.hidden);
      expect(rendered).toBeDefined();
      expect(rendered.resultHtmlExpanded).toContain(search.name);
      expect(rendered.resultHtmlExpanded).toMatch(search.statusText);
      expect(rendered.resultHtmlExpanded).toContain(`Post-processing ${search.name} feedback.`);
      expect(rendered.resultHtmlExpanded.split(search.hidden)).toHaveLength(2);
      expect(rendered.resultHtmlCollapsed).not.toContain(search.hidden);
      expect(rendered.resultHtmlCollapsed).toContain("click to show detail");
      expect(rendered.resultHtmlCollapsed).not.toContain("ctrl+o");
      expect(html).toContain(
        'html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;',
      );
      expect(html).not.toContain(search.hidden);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drives one installed lowercase grep lifecycle through real ToolExecutionComponent", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    sdk.initTheme();
    const definition = wrapForSelfShell(withCompactSearchRendering(sdk.createGrepToolDefinition(process.cwd())));
    const args = { pattern: "stock-lifecycle", path: "src" };
    const result = { content: [{ type: "text", text: "src/a.ts:1:stock-lifecycle\nsrc/b.ts:2:stock-lifecycle" }], details: undefined };
    const component = new sdk.ToolExecutionComponent(
      "grep", "stock-grep-contract", args, {}, definition,
      { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
    );
    component.setArgsComplete();
    component.markExecutionStarted();
    component.updateResult(result, false);
    component.setExpanded(false);
    const collapsed = (component.render(120) as string[]).join("\n");
    expect(collapsed).toContain("grep");
    expect(collapsed).toContain("stock-lifecycle");
    expect(collapsed).toContain("ctrl+o to expand");
    expect(collapsed).not.toContain("src/a.ts:1");
    component.setExpanded(true);
    expect((component.render(120) as string[]).join("\n")).toContain("src/a.ts:1:stock-lifecycle");
    component.setExpanded(false);
    expect((component.render(120) as string[]).join("\n")).not.toContain("src/a.ts:1");
  });

  it("pins exporter ownership: ls stays template-owned while grep/find custom fragments collapse safely", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    sdk.initTheme();
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const piDist = mainUrl.slice(0, mainUrl.indexOf("/dist/"));
    const htmlModule: any = await import(`${piDist}/dist/core/export-html/tool-renderer.js`);
    const exportModule: any = await import(`${piDist}/dist/core/export-html/index.js`);
    const themeModule: any = await import(`${piDist}/dist/modes/interactive/theme/theme.js`);
    const definitions = new Map([
      ["grep", wrapForSelfShell(withCompactSearchRendering(sdk.createGrepToolDefinition(process.cwd())))],
      ["find", wrapForSelfShell(withCompactSearchRendering(sdk.createFindToolDefinition(process.cwd())))],
      ["ls", wrapForSelfShell(withCompactSearchRendering(sdk.createLsToolDefinition(process.cwd())))],
    ]);
    const renderer = htmlModule.createToolHtmlRenderer({
      getToolDefinition: (name: string) => definitions.get(name), theme: themeModule.theme,
      cwd: process.cwd(), width: 80,
    });
    const customCases = [
      ["grep", { pattern: "<needle>", path: "src" }, "src/<unsafe>.ts:1:<needle>", "&lt;needle&gt;"],
      ["find", { pattern: "**/<unsafe>.ts", path: "src" }, "src/<unsafe>.ts", "**/&lt;unsafe&gt;.ts"],
    ] as const;
    for (const [name, args, body, escapedInvocation] of customCases) {
      const id = `stock-html-${name}`;
      expect(renderer.renderCall(id, name, args)).toBe("");
      const rendered = renderer.renderResult(id, name, [{ type: "text", text: body }], undefined, false);
      expect(rendered?.collapsed).toContain("click to show detail");
      expect(rendered?.collapsed).toContain(escapedInvocation);
      expect(rendered?.collapsed).not.toContain(name === "grep" ? "<needle>" : "**/<unsafe>.ts");
      expect(rendered?.collapsed).not.toContain(body);
      expect(rendered?.collapsed).not.toContain("ctrl+o");
      expect(rendered?.expanded).toContain("&lt;unsafe&gt;");
      expect(rendered?.expanded).not.toContain("<unsafe>");
    }
    const dir = mkdtempSync(join(tmpdir(), "picc-stock-export-"));
    const outputPath = join(dir, "stock.html");
    try {
      const session = sdk.SessionManager.create(dir, dir, { id: "stock-export-ownership" });
      for (const [name, args, body] of customCases) {
        const toolCallId = `full-export-${name}`;
        session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name,
          arguments: args }], stopReason: "toolUse" } as never);
        session.appendMessage({ role: "toolResult", toolCallId, toolName: name,
          content: [{ type: "text", text: body }], details: undefined, isError: false } as never);
      }
      session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "stock-html-ls", name: "ls",
        arguments: { path: "<template-owned>" } }], stopReason: "toolUse" } as never);
      session.appendMessage({ role: "toolResult", toolCallId: "stock-html-ls", toolName: "ls",
        content: [{ type: "text", text: "<template-entry>" }], details: undefined, isError: false } as never);
      await exportModule.exportSessionToHtml(session, undefined, { outputPath, toolRenderer: renderer });
      const html = readFileSync(outputPath, "utf8");
      const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
      const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
      for (const [name] of customCases) {
        const rendered = data.renderedTools?.[`full-export-${name}`];
        expect(rendered).toBeDefined();
        expect(rendered.callHtml).toBeUndefined();
        expect(rendered.resultHtmlCollapsed).toContain("click to show detail");
      }
      expect(data.renderedTools?.["stock-html-ls"]).toBeUndefined();
      expect(JSON.stringify(data.entries)).toContain("template-entry");
      expect(html).toContain("case 'ls':");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("real Pi glyph-shell image and spacing ownership", () => {
  it("keeps binary images Pi-owned and aligns textual image fallbacks", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const tui: any = await import("@earendil-works/pi-tui");
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const codingAgentRequire = createRequire(mainUrl);
    const piOwnedTui: any = codingAgentRequire("@earendil-works/pi-tui");
    const tuiModules = tui === piOwnedTui ? [tui] : [tui, piOwnedTui];
    if (tuiModules.length === 1) expect(tui.Box).toBe(piOwnedTui.Box);
    else expect(tui.Box).not.toBe(piOwnedTui.Box);
    sdk.initTheme();
    const previous = tuiModules.map((module) => module.getCapabilities());
    const definition = wrapForSelfShell({ name: "ImageProbe" });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const build = (id: string) => new sdk.ToolExecutionComponent(
      "ImageProbe", id, {}, { showImages: true }, definition,
      { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
    );
    try {
      tuiModules.forEach((module, index) => module.setCapabilities({ ...previous[index], images: "kitty" }));
      const binary = build("binary-image");
      binary.updateResult({ content: [{ type: "image", data: png, mimeType: "image/png" }], details: undefined }, false);
      const binaryLines = binary.render(40) as string[];
      expect(binaryLines[0]).toBe("");
      expect(binaryLines[1]?.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")).toBe("● image probe");
      expect(binaryLines[2]).toBe(""); // Pi-owned text/image separator
      expect(binaryLines.slice(3).join("\n")).toContain("_G");
      expect(binaryLines.join("\n").match(/[○●✗■]/gu)).toHaveLength(1);

      tuiModules.forEach((module, index) => module.setCapabilities({ ...previous[index], images: null }));
      const fallback = build("fallback-image");
      fallback.updateResult({ content: [{ type: "image", data: png, mimeType: "image/png" }], details: undefined }, false);
      const fallbackText = (fallback.render(80) as string[]).join("\n").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
      expect(fallbackText).toContain("● image probe");
      expect(fallbackText).toMatch(/\n  \[Image/iu);
      expect(fallbackText.match(/[○●✗■]/gu)).toHaveLength(1);

      for (const row of [binary, fallback]) expect((row.render(80) as string[])[0]).toBe("");
    } finally {
      tuiModules.forEach((module, index) => module.setCapabilities(previous[index]));
    }
  });
});

describe("real Pi lifecycle row ownership", () => {
  it("composes Agent and TaskOutput pending, partial, collapsed, expanded, and error rows without call shells", async () => {
    const { ToolExecutionComponent, initTheme } = (await import(
      "@earendil-works/pi-coding-agent"
    )) as any;
    initTheme();
    const cwd = process.cwd().replace(/\\/g, "/");
    const ui = { requestRender() {} };
    // Use the production factories, not renderer-shaped test doubles: this
    // proves each definition forwards Pi's per-call context into the shared
    // lifecycle renderers before the real self-shell composes the component.
    const taskRegistry = new BackgroundTaskRegistry();
    const registeredTaskId = taskRegistry.start(
      "agent:coder",
      new Promise(() => {}),
      undefined,
      "agent-aabbccddeeff",
      "coder",
      undefined,
      "Review authentication",
    );
    expect(registeredTaskId).toBe("task-1");
    const definitions = {
      Agent: wrapForSelfShell(
        createAgentToolDefinition({} as SubagentRuntime, { depth: 0 }),
      ),
      TaskOutput: wrapForSelfShell(
        createTaskOutputTool(taskRegistry),
      ),
    };
    const definition = (name: "Agent" | "TaskOutput") => definitions[name];
    const build = (name: "Agent" | "TaskOutput", id: string, args: Record<string, unknown>) =>
      new ToolExecutionComponent(name, id, args, {}, definition(name), ui, cwd);
    const text = (component: any, expanded = false) => {
      component.setExpanded(expanded);
      return (component.render(120) as string[])
        .join("\n")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    };

    const semanticLines = (rendered: string) => rendered.split("\n").filter((line) => line.trim());

    const acceptedArgs = {
      subagent_type: "coder",
      description: "Review auth",
      run_in_background: true,
    };
    const acceptedResult = {
      content: [{ type: "text", text: "canonical acceptance" }],
      details: {
        background: true,
        taskId: "task-9",
        agent: "coder",
        agentId: "agent-aabbccddeeff",
        admission: "admitted",
        description: "Review auth",
      },
      isError: false,
    };
    const acceptedCanonical = structuredClone(acceptedResult);
    const accepted = build("Agent", "accepted-row", structuredClone(acceptedArgs));
    accepted.updateResult(structuredClone(acceptedResult), false);
    expect(text(accepted)).toBe("");
    expect(text(accepted, true)).toBe("");
    expect(acceptedResult).toEqual(acceptedCanonical);
    const acceptedReconstructed = build("Agent", "accepted-reconstructed", structuredClone(acceptedArgs));
    acceptedReconstructed.updateResult(structuredClone(acceptedResult), false);
    expect(text(acceptedReconstructed)).toBe("");

    const agent = build("Agent", "agent-row", {
      subagent_type: "coder",
      description: "Review auth",
      run_in_background: true,
    });
    expect(text(agent)).toContain("coder - Review auth");
    expect(text(agent)).not.toContain("background");
    expect(semanticLines(text(agent))).toHaveLength(1);
    agent.updateResult(
      { content: [{ type: "text", text: "live assistant text" }], details: { agent: "coder" }, isError: false },
      true,
    );
    const running = text(agent);
    expect(running).toContain("coder [running]");
    expect(running).not.toContain("Review auth");
    expect(running).not.toContain("live assistant text");
    expect(semanticLines(running)).toHaveLength(1);

    agent.updateResult(
      {
        content: [{ type: "text", text: "final answer" }],
        details: {
          outcome: "completed",
          agent: "coder",
          durationMs: 1_000,
          settledAt: new Date(2026, 0, 2, 7, 5).getTime(),
          transcriptPath: "/x/agent-aabbccddeeff.jsonl",
        },
        isError: false,
      },
      false,
    );
    const collapsed = text(agent);
    expect(collapsed).toContain("coder [completed]");
    expect(collapsed).toContain("1s");
    expect(collapsed).toContain("07:05");
    expect(collapsed).not.toContain("Review auth");
    expect(collapsed).not.toContain("final answer");
    expect(collapsed).not.toContain(".jsonl");
    expect(semanticLines(collapsed)).toHaveLength(1);
    const expanded = text(agent, true);
    expect(expanded).toContain("final answer");
    expect(expanded).toContain("transcript: /x/agent-aabbccddeeff.jsonl");
    expect(expanded).not.toContain("Review auth");

    const awaiting = build("TaskOutput", "task-await", { task_id: "task-1" });
    const polling = build("TaskOutput", "task-poll", { task_id: "task-2", wait: false });
    expect(text(awaiting)).toContain("task output task-1 [awaiting]");
    expect(text(polling)).toContain("task output task-2 [polling]");
    expect(semanticLines(text(awaiting))).toHaveLength(1);
    expect(semanticLines(text(polling))).toHaveLength(1);
    expect(text(awaiting).match(/[○●✗■]/gu)).toHaveLength(1);
    expect(text(polling).match(/[○●✗■]/gu)).toHaveLength(1);
    const runningResult = {
      content: [{ type: "text", text: "running Grep" }],
      details: {
        subagentProgress: undefined,
        admission: "admitted",
        status: "running",
        agent: "coder",
        taskId: "task-1",
        agentId: "agent-aabbccddeeff",
        live: true,
      },
      isError: false,
    };
    const runningCanonical = structuredClone(runningResult);
    awaiting.updateResult(runningResult, true);
    const taskRunning = text(awaiting);
    expect(taskRunning).toContain("task output Review authentication · running · coder · task-1");
    expect(runningResult).toEqual(runningCanonical);
    expect(JSON.stringify(runningResult)).not.toContain("Review authentication");
    expect(taskRunning).not.toContain("awaiting");
    expect(taskRunning).not.toContain("Grep");
    expect(semanticLines(taskRunning)).toHaveLength(1);
    expect(taskRunning.match(/[○●✗■]/gu)).toHaveLength(1);
    const terminalResult = {
      content: [{ type: "text", text: "task answer" }],
      details: {
        taskId: "task-1",
        status: "completed",
        admission: "admitted",
        outcome: "completed",
        agent: "coder",
        agentId: "agent-aabbccddeeff",
        description: "Review authentication",
      },
      isError: false,
    };
    const terminalCanonical = structuredClone(terminalResult);
    awaiting.updateResult(terminalResult, false);
    const firstTerminal = text(awaiting);
    expect(firstTerminal).toContain("coder [completed] - Review authentication");
    expect(firstTerminal).not.toContain("task output");
    expect(firstTerminal).not.toContain("task-1");
    expect(firstTerminal).not.toContain("task answer");
    expect(firstTerminal).not.toContain("agent-aabbccddeeff");
    expect(firstTerminal).not.toContain("awaiting");
    expect(semanticLines(firstTerminal)).toHaveLength(1);
    expect(firstTerminal.match(/[○●✗■]/gu)).toHaveLength(1);
    const firstExpanded = text(awaiting, true);
    expect(firstExpanded).toContain("task answer");
    expect(firstExpanded).toContain("task: task-1");
    expect(firstExpanded).toContain("agent: agent-aabbccddeeff");
    expect(firstExpanded.match(/[○●✗■]/gu)).toHaveLength(1);
    const firstRecollapsed = text(awaiting, false);
    expect(firstRecollapsed).not.toContain("task answer");
    expect(firstRecollapsed).not.toContain("task: task-1");
    expect(firstRecollapsed).not.toContain("agent: agent-aabbccddeeff");
    expect(firstRecollapsed.match(/[○●✗■]/gu)).toHaveLength(1);
    expect(terminalResult).toEqual(terminalCanonical);
    const firstReconstructed = build("TaskOutput", "task-first-reconstructed", { task_id: "task-1" });
    firstReconstructed.updateResult(structuredClone(terminalResult), false);
    expect(text(firstReconstructed)).toContain("coder [completed] - Review authentication");
    expect(text(firstReconstructed, true)).toContain("task: task-1");

    const duplicate = structuredClone({
      content: [{ type: "text", text: "task answer" }],
      details: {
        taskId: "task-1",
        status: "completed",
        admission: "admitted",
        outcome: "completed",
        agent: "coder",
        agentId: "agent-aabbccddeeff",
        description: "Review authentication",
        alreadyReported: true,
      },
      isError: false,
    });
    const duplicateCanonical = structuredClone(duplicate);
    awaiting.updateResult(duplicate, false);
    expect(text(awaiting)).toBe("");
    expect(text(awaiting, true)).toBe("");
    expect(duplicate).toEqual(duplicateCanonical);

    const reconstructed = build("TaskOutput", "task-reconstructed", { task_id: "task-1" });
    reconstructed.updateResult(structuredClone(duplicateCanonical), false);
    expect(text(reconstructed)).toBe("");

    const failed = build("Agent", "agent-error", { subagent_type: "coder" });
    failed.updateResult(
      { content: [{ type: "text", text: "provider failed" }], details: undefined, isError: true },
      false,
    );
    expect(text(failed)).toContain("provider failed");
    expect(text(failed)).not.toContain("coder [");
  });

  it("resets trusted disposition for each pre-paint renderer construction and each result generation", async () => {
    const { ToolExecutionComponent, initTheme } = (await import("@earendil-works/pi-coding-agent")) as any;
    initTheme();
    const ui = { requestRender() {} };
    const cwd = process.cwd().replace(/\\/g, "/");
    const renderText = (component: any) => (component.render(100) as string[]).join("\n")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");

    const accepted = {
      content: [{ type: "text", text: "accepted evidence" }],
      details: {
        background: true, taskId: "task-7", agent: "coder", agentId: "agent-aabbccddeeff",
        admission: "admitted",
      },
      isError: false,
    };
    const malformed = {
      content: [{ type: "text", text: "malformed decisive evidence" }],
      details: { background: true, taskId: "task-7", agent: "coder" },
      isError: true,
    };
    const ordinary = { content: [{ type: "text", text: "ordinary evidence" }], details: {}, isError: false };
    const agentDefinition = wrapForSelfShell(createAgentToolDefinition({} as SubagentRuntime, { depth: 0 }));
    const buildAgent = (id: string) => new ToolExecutionComponent(
      "Agent", id, { subagent_type: "coder" }, {}, agentDefinition, ui, cwd,
    );
    const transitions = [
      [accepted, malformed, "malformed decisive evidence"],
      [malformed, accepted, ""],
      [accepted, ordinary, "ordinary evidence"],
      [ordinary, accepted, ""],
    ] as const;
    for (const [index, [first, second, expected]] of transitions.entries()) {
      const component = buildAgent(`prepaint-${index}`);
      component.updateResult(structuredClone(first), false);
      component.updateResult(structuredClone(second), false);
      const text = renderText(component);
      if (expected) {
        expect(text).toContain(expected);
        expect(text.match(/[○●✗■]/gu)).toHaveLength(1);
      } else {
        expect(text).toBe("");
      }
    }

    const reported = {
      content: [{ type: "text", text: "reported evidence" }],
      details: {
        taskId: "task-7", status: "completed", admission: "admitted", outcome: "completed",
        agent: "coder", agentId: "agent-aabbccddeeff", alreadyReported: true,
      },
      isError: false,
    };
    const malformedReported = {
      content: [{ type: "text", text: "malformed reported evidence" }],
      details: { ...reported.details, background: false },
      isError: false,
    };
    const taskDefinition = wrapForSelfShell(createTaskOutputTool(new BackgroundTaskRegistry()));
    const buildTaskOutput = (id: string) => new ToolExecutionComponent(
      "TaskOutput", id, { task_id: "task-7" }, {}, taskDefinition, ui, cwd,
    );
    const taskTransitions = [
      [reported, malformedReported, "malformed reported evidence"],
      [malformedReported, reported, ""],
      [reported, ordinary, "ordinary evidence"],
      [ordinary, reported, ""],
    ] as const;
    for (const [index, [first, second, expected]] of taskTransitions.entries()) {
      const component = buildTaskOutput(`task-prepaint-${index}`);
      component.updateResult(structuredClone(first), false);
      component.updateResult(structuredClone(second), false);
      const text = renderText(component);
      if (expected) {
        expect(text).toContain(expected);
        expect(text.match(/[○●✗■]/gu)).toHaveLength(1);
      } else {
        expect(text).toBe("");
      }
    }

    const dispositionProbe = wrapForSelfShell({
      name: "DispositionProbe",
      renderCall: (_args: unknown, _theme: unknown, ctx: RenderCtx) => {
        suppressToolRow(ctx);
        setToolRowOutcome(ctx, "failure");
        return { render: () => ["call"] };
      },
      renderResult: () => ({ render: () => ["ordinary result"] }),
    });
    const probe = new ToolExecutionComponent("DispositionProbe", "probe", {}, {}, dispositionProbe, ui, cwd);
    probe.updateResult(ordinary, false);
    const probeText = renderText(probe);
    expect(probeText).toContain("ordinary result");
    expect(probeText).toContain("●");
    expect(probeText).not.toContain("✗");
  });

  it("keeps ownership isolated across interleaved calls and a throwing result renderer", async () => {
    const { ToolExecutionComponent, initTheme } = (await import(
      "@earendil-works/pi-coding-agent"
    )) as any;
    initTheme();
    const cwd = process.cwd().replace(/\\/g, "/");
    const ui = { requestRender() {} };
    const throwingDefinition = wrapForSelfShell({
      name: "Agent",
      renderCall: renderAgentCall,
      renderResult(_result: unknown, _options: unknown, _theme: unknown, ctx: SubagentLifecycleRenderContext) {
        if (ctx.state) ctx.state.resultOwned = true;
        throw new Error("renderer boom");
      },
    });
    const normalDefinition = wrapForSelfShell({
      name: "Agent",
      renderCall: renderAgentCall,
      renderResult: renderAgentResult,
    });
    const first = new ToolExecutionComponent(
      "Agent", "isolated-a", { subagent_type: "coder" }, {}, throwingDefinition, ui, cwd,
    );
    const second = new ToolExecutionComponent(
      "Agent", "isolated-b", { subagent_type: "reviewer" }, {}, normalDefinition, ui, cwd,
    );
    first.updateResult(
      { content: [{ type: "text", text: "fallback result" }], details: {}, isError: false },
      false,
    );
    const firstText = (first.render(100) as string[]).join("\n");
    const secondText = (second.render(100) as string[]).join("\n");
    expect(firstText).toContain("fallback result");
    expect(firstText).not.toContain("coder [");
    expect(secondText).toContain("reviewer");
    expect(secondText).not.toContain("fallback result");
  });
});

describe("real Pi glyph-shell construction and render ordering", () => {
  it("shares exact state, renders call before result repeatedly, and preserves adjacent separators", async () => {
    const { ToolExecutionComponent, initTheme } = (await import(
      "@earendil-works/pi-coding-agent"
    )) as any;
    initTheme();
    const constructed: Array<{ kind: "call" | "result"; state: unknown }> = [];
    const rendered: string[] = [];
    const definition = wrapForSelfShell({
      name: "OrderProbe",
      renderCall: (_args: unknown, _theme: unknown, ctx: RenderCtx) => {
        constructed.push({ kind: "call", state: ctx.state });
        return { render: () => { rendered.push("call"); return ["call"]; } };
      },
      renderResult: (_result: unknown, _options: unknown, _theme: unknown, ctx: RenderCtx) => {
        constructed.push({ kind: "result", state: ctx.state });
        return { render: () => { rendered.push("result"); return ["result"]; } };
      },
    });
    const build = (id: string) => new ToolExecutionComponent(
      "OrderProbe", id, {}, {}, definition, { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
    );
    const first = build("order-a");
    constructed.length = 0;
    first.updateResult({ content: [{ type: "text", text: "canonical" }], details: undefined }, false);
    expect(constructed.map(({ kind }) => kind)).toEqual(["call", "result"]);
    expect(constructed[0]?.state).toBe(constructed[1]?.state);
    const invocationState = constructed[0]?.state;
    expect(rendered).toEqual([]);

    const firstPaint = first.render(80) as string[];
    expect(rendered).toEqual(["call", "result"]);

    constructed.length = 0;
    rendered.length = 0;
    first.updateResult({ content: [{ type: "text", text: "updated" }], details: undefined }, false);
    expect(constructed.map(({ kind }) => kind)).toEqual(["call", "result"]);
    expect(constructed[0]?.state).toBe(constructed[1]?.state);
    expect(constructed[0]?.state).toBe(invocationState);
    expect(rendered).toEqual([]);

    const secondPaint = first.render(80) as string[];
    expect(rendered).toEqual(["call", "result"]);
    for (const paint of [firstPaint, secondPaint]) {
      expect(paint[0]).toBe("");
      expect(paint.join("\n").match(/[○●✗■]/gu)).toHaveLength(1);
    }

    const adjacent = build("order-b");
    adjacent.updateResult({ content: [{ type: "text", text: "neighbor" }], details: undefined }, false);
    const adjacentPaint = adjacent.render(80) as string[];
    const stripAnsi = (line: string) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    const combined = [...firstPaint, ...adjacentPaint].map(stripAnsi);
    expect(combined).toEqual(["", "● call", "  result", "", "● call", "  result"]);
    expect(combined.flatMap((line, index) => line === "" ? [index] : [])).toEqual([0, 3]);
    expect(combined.at(-1)).not.toBe("");
    expect(combined.join("\n").match(/[○●✗■]/gu)).toHaveLength(2);
  });

  it("preserves the real theme's generic bold toolTitle composition", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    sdk.initTheme();
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const piDist = mainUrl.slice(0, mainUrl.indexOf("/dist/"));
    const { theme }: any = await import(`${piDist}/dist/modes/interactive/theme/theme.js`);
    const expected = theme.fg("text", theme.bold("generic probe"));
    expect(genericCallComponent("GenericProbe", theme).render(80)).toEqual([expected]);
  });
});

/**
 * Pin Pi's `ctx.lastComponent` threading with a contract
 * test that drives the REAL, publicly-exported `ToolExecutionComponent`.
 *
 * The glyph-framed built-ins depend on Pi caching the outer component our wrapper
 * returns and handing it back as `ctx.lastComponent` on the next render. PiCC's
 * `wrapperMetadata` WeakMap resolves that outer component to its retained previous
 * inner component; `edit`'s `instanceof Box` incremental reuse breaks if the wrong
 * component is threaded. PiCC's own
 * threading is unit-tested against a fake ctx (`test/runtime-core.test.ts`); this
 * asserts PI's side of the contract, so a Pi upgrade that stops threading the
 * prior component fails loudly here instead of degrading incremental rendering
 * silently in the terminal.
 */
describe("ToolExecutionComponent threads the prior render component as ctx.lastComponent", () => {
  it("hands back the previously-returned component (undefined on the first render), for renderCall and renderResult", async () => {
    const { ToolExecutionComponent, initTheme } = (await import(
      "@earendil-works/pi-coding-agent"
    )) as any;
    // The render loop reads a module-global `theme`; initialize it first so
    // render()/updateDisplay() don't throw — same pattern as the wired-edit
    // integration test (test/integration-extension.test.ts).
    initTheme();

    // For each renderer slot: the lastComponent it was HANDED on each invocation,
    // and the fresh sentinel it RETURNED (so we can assert identity, not truthiness).
    const call: { seen: unknown[]; returned: unknown[] } = { seen: [], returned: [] };
    const result: { seen: unknown[]; returned: unknown[] } = { seen: [], returned: [] };

    // A sentinel Component: a plain `{ render() }` is a valid pi-tui child
    // (Container.addChild just stores it; render() collects child.render(width)).
    const sentinel = () => ({ render: () => [] as string[] });

    // Instrumented tool definition. renderShell:"self" mirrors PiCC's real usage
    // (the built-ins register self-shell), though Pi's caching is shell-independent.
    const toolDefinition = {
      name: "PiccLastComponentProbe",
      renderShell: "self",
      renderCall: (_args: unknown, _theme: unknown, ctx: { lastComponent: unknown }) => {
        call.seen.push(ctx.lastComponent);
        const c = sentinel();
        call.returned.push(c);
        return c;
      },
      renderResult: (
        _res: unknown,
        _opts: unknown,
        _theme: unknown,
        ctx: { lastComponent: unknown },
      ) => {
        result.seen.push(ctx.lastComponent);
        const c = sentinel();
        result.returned.push(c);
        return c;
      },
    };

    // A made-up toolName so `builtInToolDefinition` (createAllToolDefinitions(cwd)
    // [toolName]) is undefined and ONLY the instrumented definition drives rendering.
    const component = new ToolExecutionComponent(
      "PiccLastComponentProbe",
      "picc-tc-1",
      { probe: "args-1" },
      {},
      toolDefinition,
      { requestRender() {} },
      process.cwd().replace(/\\/g, "/"),
    );

    // The constructor already ran one updateDisplay (renderCall #1; no result yet).
    // Drive a second call render, then two result renders — each updateDisplay pass
    // re-invokes the renderers and threads the prior returned component back.
    const mkResult = (text: string) => ({
      content: [{ type: "text", text }],
      details: {},
      isError: false,
    });
    component.updateArgs({ probe: "args-2" }); // renderCall #2
    component.updateResult(mkResult("out-1"), false); // renderResult #1 (+ renderCall #3)
    component.updateResult(mkResult("out-2"), false); // renderResult #2 (+ renderCall #4)
    component.render(80); // exercise the self-shell render path with the sentinels

    // renderCall: 1st render sees `undefined`; the 2nd sees EXACTLY the component
    // the renderer returned on the 1st render — non-vacuous (identity, not truthy).
    expect(call.seen.length).toBeGreaterThanOrEqual(2);
    expect(call.seen[0]).toBeUndefined();
    expect(call.seen[1]).toBe(call.returned[0]);

    // renderResult is cached in a SEPARATE slot — same contract holds independently.
    expect(result.seen.length).toBeGreaterThanOrEqual(2);
    expect(result.seen[0]).toBeUndefined();
    expect(result.seen[1]).toBe(result.returned[0]);

    // The two slots really are independent caches (call sentinel is never handed
    // to the result renderer and vice-versa).
    expect(call.returned[0]).not.toBe(result.returned[0]);
    expect(result.seen[1]).not.toBe(call.returned[0]);
  });
});

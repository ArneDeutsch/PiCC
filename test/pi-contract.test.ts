import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { fakePi } from "./helpers/fake-pi.js";
import { withCompactSearchRendering } from "../src/runtime/search-tool-render.js";
import { genericCallComponent, wrapForSelfShell, type RenderCtx } from "../src/runtime/tool-shell.js";
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

/**
 * Pi upstream contract smoke test: asserts every Pi API PiCC
 * builds on exists in the pinned version. If Pi churns, this fails first and loudly.
 */
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

describe("pi 0.80.x API contract", () => {
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
      [sdk.SessionManager, ["inMemory", "create", "open"]],
      [sdk.SettingsManager, ["inMemory"]],
      // AgentSession methods live on the prototype; constructing a real session
      // needs a model/provider and belongs to the real-stack lane, not this smoke pin.
      [sdk.AgentSession?.prototype, [
        "prompt", "compact", "sendCustomMessage", "abortCompaction", "abort", "subscribe", "steer", "followUp",
      ]],
    ] as const) {
      for (const method of methods) expect(typeof owner?.[method], method).toBe("function");
    }
  });

  it("real Agent preserves duplicate-image steering identity and steer-before-followUp order", async () => {
    const { Agent }: any = await import("@earendil-works/pi-agent-core");
    const { createAssistantMessageEventStream }: any = await import("@earendil-works/pi-ai");
    const calls: any[] = [];
    let releaseFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const model = {
      id: "queue-model", name: "Queue Model", api: "openai-completions", provider: "mock",
      baseUrl: "http://127.0.0.1", reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
    };
    const agent = new Agent({
      initialState: { systemPrompt: "queue contract", model, thinkingLevel: "off", tools: [], messages: [] },
      streamFn: (_model: any, context: any) => {
        const stream = createAssistantMessageEventStream();
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
      },
    });
    const running = agent.prompt("start");
    while (calls.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const imageA = { type: "image", mimeType: "image/png", data: "a" };
    const imageB = { type: "image", mimeType: "image/png", data: "b" };
    agent.steer({ role: "user", content: [{ type: "text", text: "duplicate" }, imageA], timestamp: 1 });
    agent.steer({ role: "user", content: [{ type: "text", text: "duplicate" }, imageB], timestamp: 2 });
    agent.followUp({ role: "user", content: [{ type: "text", text: "after steering" }], timestamp: 3 });
    releaseFirst();
    await running;

    expect(calls).toHaveLength(4);
    const users = (call: any) => call.messages.filter((message: any) => message.role === "user").map((message: any) => message.content);
    expect(users(calls[1]).at(-1)).toEqual([{ type: "text", text: "duplicate" }, imageA]);
    expect(users(calls[2]).at(-1)).toEqual([{ type: "text", text: "duplicate" }, imageB]);
    expect(users(calls[3]).at(-1)).toEqual([{ type: "text", text: "after steering" }]);
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

  it("type pins compile against the pinned Pi: stopReason/errorMessage, 5-arg execute, transcript surface, subscribe + event kinds", async () => {
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

    for (const expanded of [false, true]) {
      const lines = paint(build(search.ordinary), expanded);
      expect(lines).toHaveLength(2); // shell-owned separator + one result-owned content row
      expect(lines[0]).toBe("");
      expect(lines[1]).toContain(search.name);
      expect(lines.join("\n")).not.toContain(search.hidden);
    }
    expect(paint(build(search.ordinary), true)).toEqual(paint(build(search.ordinary), false));

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
    expect(rendered.expanded).toBe(collapsed);

    const errorId = `html-error-${search.name}`;
    renderer.renderCall(errorId, search.name, search.args);
    const error = renderer.renderResult(
      errorId, search.name,
      [{ type: "text", text: `${search.name} HTML failure body` }], undefined, true,
    );
    expect(error?.expanded).toContain("failed");
    expect(error?.expanded).toContain(`${search.name} HTML failure body`);
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
      expect(rendered.resultHtmlExpanded).not.toContain(search.hidden);
      expect(rendered.resultHtmlCollapsed).toBeUndefined();
      expect(html).toContain(
        'html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;',
      );
      expect(html).not.toContain(search.hidden);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("real Pi glyph-shell image and spacing ownership", () => {
  it("keeps binary images Pi-owned and aligns textual image fallbacks", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const tui: any = await import("@earendil-works/pi-tui");
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const piDist = mainUrl.slice(0, mainUrl.indexOf("/dist/"));
    const nestedTui: any = await import(`${piDist}/node_modules/@earendil-works/pi-tui/dist/index.js`);
    sdk.initTheme();
    const previous = tui.getCapabilities();
    const nestedPrevious = nestedTui.getCapabilities();
    const definition = wrapForSelfShell({ name: "ImageProbe" });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const build = (id: string) => new sdk.ToolExecutionComponent(
      "ImageProbe", id, {}, { showImages: true }, definition,
      { requestRender() {} }, process.cwd().replace(/\\/g, "/"),
    );
    try {
      tui.setCapabilities({ ...previous, images: "kitty" });
      nestedTui.setCapabilities({ ...nestedPrevious, images: "kitty" });
      const binary = build("binary-image");
      binary.updateResult({ content: [{ type: "image", data: png, mimeType: "image/png" }], details: undefined }, false);
      const binaryLines = binary.render(40) as string[];
      expect(binaryLines[0]).toBe("");
      expect(binaryLines[1]?.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")).toBe("● ImageProbe");
      expect(binaryLines[2]).toBe(""); // Pi-owned text/image separator
      expect(binaryLines.slice(3).join("\n")).toContain("_G");
      expect(binaryLines.join("\n").match(/[○●✗■]/gu)).toHaveLength(1);

      tui.setCapabilities({ ...previous, images: null });
      nestedTui.setCapabilities({ ...nestedPrevious, images: null });
      const fallback = build("fallback-image");
      fallback.updateResult({ content: [{ type: "image", data: png, mimeType: "image/png" }], details: undefined }, false);
      const fallbackText = (fallback.render(80) as string[]).join("\n").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
      expect(fallbackText).toContain("● ImageProbe");
      expect(fallbackText).toMatch(/\n  \[Image/iu);
      expect(fallbackText.match(/[○●✗■]/gu)).toHaveLength(1);

      for (const row of [binary, fallback]) expect((row.render(80) as string[])[0]).toBe("");
    } finally {
      tui.setCapabilities(previous);
      nestedTui.setCapabilities(nestedPrevious);
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
    const definitions = {
      Agent: wrapForSelfShell(
        createAgentToolDefinition({} as SubagentRuntime, { depth: 0 }),
      ),
      TaskOutput: wrapForSelfShell(
        createTaskOutputTool(new BackgroundTaskRegistry()),
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

    const agent = build("Agent", "agent-row", {
      subagent_type: "coder",
      description: "Review auth",
      run_in_background: true,
    });
    expect(text(agent)).toContain("Agent(coder) - Review auth");
    expect(text(agent)).not.toContain("background");
    expect(semanticLines(text(agent))).toHaveLength(1);
    agent.updateResult(
      { content: [{ type: "text", text: "live assistant text" }], details: { agent: "coder" }, isError: false },
      true,
    );
    const running = text(agent);
    expect(running).toContain("Agent(coder) running");
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
    expect(collapsed).toContain("Agent(coder) completed");
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
    expect(text(awaiting)).toContain("TaskOutput(task-1) awaiting");
    expect(text(polling)).toContain("TaskOutput(task-2) polling");
    expect(semanticLines(text(awaiting))).toHaveLength(1);
    expect(semanticLines(text(polling))).toHaveLength(1);
    awaiting.updateResult(
      {
        content: [{ type: "text", text: "running Grep" }],
        details: { taskId: "task-1", status: "running", agent: "coder", lastActivity: "running Grep" },
        isError: false,
      },
      true,
    );
    const taskRunning = text(awaiting);
    expect(taskRunning).toContain("Agent(coder) → Task(task-1) running");
    expect(taskRunning).not.toContain("awaiting");
    expect(taskRunning).not.toContain("Grep");
    expect(semanticLines(taskRunning)).toHaveLength(1);
    awaiting.updateResult(
      {
        content: [{ type: "text", text: "task answer" }],
        details: { taskId: "task-1", status: "completed", outcome: "completed", agent: "coder" },
        isError: false,
      },
      false,
    );
    expect(text(awaiting)).toContain("Agent(coder) → Task(task-1) completed");
    expect(text(awaiting)).not.toContain("awaiting");
    expect(semanticLines(text(awaiting))).toHaveLength(1);

    const failed = build("Agent", "agent-error", { subagent_type: "coder" });
    failed.updateResult(
      { content: [{ type: "text", text: "provider failed" }], details: undefined, isError: true },
      false,
    );
    expect(text(failed)).toContain("provider failed");
    expect(text(failed)).not.toContain("Agent(coder)");
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
    expect(firstText).not.toContain("Agent(coder)");
    expect(secondText).toContain("Agent(reviewer)");
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
    const expected = theme.fg("toolTitle", theme.bold("GenericProbe"));
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

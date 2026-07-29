import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SSEClientTransport,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedRemoteMcpFields } from "../src/claude/mcp-remote-config.js";
import {
  classifyRemoteMcpFailure,
  createRemoteMcpFetch,
  createRemoteMcpTransport,
  type RemoteMcpDisconnect,
  type RemoteMcpTransportDeps,
  type RemoteMcpTransportHandle,
  type RemoteMcpStage,
} from "../src/runtime/mcp-remote.js";
import { settlement, waitUntil } from "./helpers/async.js";
import { createMcpRemoteServer } from "./helpers/mcp-remote-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function config(
  transportKind: "http" | "sse",
  url = "http://127.0.0.1:1/mcp",
  headers: Record<string, string> = {},
  configuredType: "http" | "streamable-http" | "sse" = transportKind === "sse" ? "sse" : "http",
): ResolvedRemoteMcpFields {
  return {
    configuredType,
    transportKind,
    rawUrl: url,
    rawHeaders: headers,
    url,
    headers,
    ...(transportKind === "sse"
      ? { sseDeprecation: { deprecated: true as const, replacement: "http" as const } }
      : {}),
  };
}

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  closeCalls = 0;
  async start(): Promise<void> {}
  async send(_message: JSONRPCMessage): Promise<void> {}
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.onclose?.();
  }
}

const initializeMessage: JSONRPCMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "adapter-test", version: "1" },
  },
};

function assertCanaryFree(error: unknown, ...canaries: string[]): void {
  const rendered = `${String(error)} ${JSON.stringify(error)}`;
  for (const canary of canaries) expect(rendered).not.toContain(canary);
}

async function directStatusFailure(
  kind: "http" | "sse",
  status: number,
  throughPost = false,
): Promise<{ error: unknown; onerror: Error[] }> {
  const fixture = await createMcpRemoteServer();
  cleanups.push(fixture.cleanup);
  if (!throughPost) {
    fixture.setMode({
      kind: "status",
      status,
      statusText: "STATUS-TEXT-CANARY",
      body: "BODY-CANARY",
      headers: { "x-response-canary": "HEADER-CANARY" },
    });
  }
  const baseUrl = kind === "http" ? fixture.streamableUrl : fixture.sseUrl;
  const handle = await createRemoteMcpTransport(
    config(kind, `${baseUrl}?url=URL-CANARY`),
  );
  cleanups.push(handle.close.bind(handle));
  const onerror: Error[] = [];
  handle.onerror = (error) => onerror.push(error);
  let error: unknown;
  if (kind === "sse") {
    if (throughPost) {
      await handle.start();
      fixture.setMode({
        kind: "status",
        status,
        statusText: "STATUS-TEXT-CANARY",
        body: "BODY-CANARY",
        headers: { "x-response-canary": "HEADER-CANARY" },
      });
      error = await handle.send(initializeMessage).catch((caught: unknown) => caught);
    } else {
      error = await handle.start().catch((caught: unknown) => caught);
    }
  } else {
    await handle.start();
    error = await handle.send(initializeMessage).catch((caught: unknown) => caught);
  }
  return { error, onerror };
}

describe("remote transport construction and boundary", () => {
  it("selects both HTTP aliases, disables SDK retries, and selects deprecated SSE", async () => {
    const httpOptions: unknown[] = [];
    const sseOptions: unknown[] = [];
    class HttpTransport extends FakeTransport {
      constructor(_url: URL, options?: unknown) {
        super();
        httpOptions.push(options);
      }
    }
    class SseTransport extends FakeTransport {
      constructor(_url: URL, options?: unknown) {
        super();
        sseOptions.push(options);
      }
    }
    const deps = {
      StreamableHTTPClientTransport: HttpTransport,
      SSEClientTransport: SseTransport,
    } as unknown as RemoteMcpTransportDeps;

    const http = await createRemoteMcpTransport(config("http"), deps);
    const alias = await createRemoteMcpTransport(
      config("http", undefined, {}, "streamable-http"),
      deps,
    );
    const sse = await createRemoteMcpTransport(config("sse"), deps);

    expect(http.transportKind).toBe("http");
    expect(alias.transportKind).toBe("http");
    expect(sse.deprecated).toBe(true);
    expect(httpOptions).toHaveLength(2);
    expect(httpOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reconnectionOptions: expect.objectContaining({ maxRetries: 0 }) }),
      ]),
    );
    expect(sseOptions[0]).toEqual(
      expect.objectContaining({
        fetch: expect.any(Function),
        eventSourceInit: { fetch: expect.any(Function) },
      }),
    );
    await Promise.all([http.abort(), http.close(), alias.close(), sse.close()]);
    expect((httpOptions.length)).toBe(2);
  });

  it("makes close and abort reentrantly idempotent and sanitizes async rejection", async () => {
    let instance: RejectingCloseTransport | undefined;
    class RejectingCloseTransport extends FakeTransport {
      constructor() {
        super();
        instance = this;
      }
      override close(): Promise<void> {
        this.closeCalls += 1;
        this.onclose?.();
        return Promise.reject(new Error("ASYNC-CLOSE-CANARY authorization=secret"));
      }
    }
    const handle = await createRemoteMcpTransport(config("http"), {
      StreamableHTTPClientTransport: RejectingCloseTransport as never,
    });
    const reentrant: Promise<void>[] = [];
    handle.onclose = () => reentrant.push(handle.close(), handle.abort());
    const closing = handle.close();
    const aborting = handle.abort();
    expect(reentrant).toEqual([closing, closing]);
    expect(aborting).toBe(closing);
    const firstError = await closing.catch((error: unknown) => error);
    const secondError = await aborting.catch((error: unknown) => error);
    expect(secondError).toBe(firstError);
    expect(instance!.closeCalls).toBe(1);
    assertCanaryFree(firstError, "ASYNC-CLOSE-CANARY", "authorization=secret");
  });

  it("contains and sanitizes a synchronous underlying close throw", async () => {
    let instance: SyncThrowingCloseTransport | undefined;
    class SyncThrowingCloseTransport extends FakeTransport {
      constructor() {
        super();
        instance = this;
      }
      override close(): Promise<void> {
        this.closeCalls += 1;
        throw new Error("SYNC-CLOSE-CANARY token=secret");
      }
    }
    const handle = await createRemoteMcpTransport(config("http"), {
      StreamableHTTPClientTransport: SyncThrowingCloseTransport as never,
    });
    const closing = handle.close();
    expect(handle.abort()).toBe(closing);
    const error = await closing.catch((caught: unknown) => caught);
    expect(instance!.closeCalls).toBe(1);
    assertCanaryFree(error, "SYNC-CLOSE-CANARY", "token=secret");
  });

  it.each([
    ["http", false],
    ["sse", false],
    ["sse", true],
  ] as const)("sanitizes real %s non-2xx failures (POST=%s) at rejection and onerror", async (kind, post) => {
    const { error, onerror } = await directStatusFailure(kind, 503, post);
    expect(error).toBeInstanceOf(Error);
    expect(classifyRemoteMcpFailure(error, { stage: "connection" }).class).toBe("transient");
    assertCanaryFree(
      error,
      "BODY-CANARY",
      "STATUS-TEXT-CANARY",
      "HEADER-CANARY",
      "URL-CANARY",
    );
    expect(onerror.length).toBeGreaterThan(0);
    for (const observed of onerror) {
      assertCanaryFree(
        observed,
        "BODY-CANARY",
        "STATUS-TEXT-CANARY",
        "HEADER-CANARY",
        "URL-CANARY",
      );
    }
    assertCanaryFree(
      classifyRemoteMcpFailure(error, { stage: "connection" }),
      "BODY-CANARY",
      "STATUS-TEXT-CANARY",
      "HEADER-CANARY",
      "URL-CANARY",
    );
  });

  it("sanitizes invalid content type and SSE-advertised cross-origin endpoint speech", async () => {
    const invalid = await listen((_req, res) => {
      res.writeHead(200, "STATUS-CANARY", {
        "content-type": "application/CANARY-invalid",
        "x-header-canary": "HEADER-CANARY",
      });
      res.end("BODY-CANARY");
    });
    cleanups.push(invalid.close);
    const httpHandle = await createRemoteMcpTransport(
      config("http", `${invalid.origin}/mcp?url=URL-CANARY`),
    );
    cleanups.push(httpHandle.close.bind(httpHandle));
    const httpErrors: Error[] = [];
    httpHandle.onerror = (error) => httpErrors.push(error);
    await httpHandle.start();
    const invalidError = await httpHandle.send(initializeMessage).catch((error: unknown) => error);
    assertCanaryFree(
      invalidError,
      "CANARY-invalid",
      "STATUS-CANARY",
      "HEADER-CANARY",
      "BODY-CANARY",
      "URL-CANARY",
    );
    for (const error of httpErrors) assertCanaryFree(error, "CANARY", "URL-CANARY");

    const endpoint = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: endpoint\ndata: http://other.invalid/messages?token=ENDPOINT-CANARY\n\n");
    });
    cleanups.push(endpoint.close);
    let underlyingCloseCalls = 0;
    class CountingSseTransport extends SSEClientTransport {
      override async close(): Promise<void> {
        underlyingCloseCalls += 1;
        await super.close();
      }
    }
    const sseHandle = await createRemoteMcpTransport(
      config("sse", `${endpoint.origin}/sse`),
      { SSEClientTransport: CountingSseTransport },
    );
    cleanups.push(sseHandle.close.bind(sseHandle));
    const sseErrors: Error[] = [];
    let publicCloseCalls = 0;
    sseHandle.onerror = (error) => sseErrors.push(error);
    sseHandle.onclose = () => {
      publicCloseCalls += 1;
    };
    const endpointError = await sseHandle.start().catch((error: unknown) => error);
    const laterClose = sseHandle.close();
    expect(sseHandle.close()).toBe(laterClose);
    expect(sseHandle.abort()).toBe(laterClose);
    await laterClose;
    await waitUntil({
      description: "one delayed public close after pinned SDK SSE startup failure",
      predicate: () => publicCloseCalls === 1,
    });
    assertCanaryFree(endpointError, "other.invalid", "ENDPOINT-CANARY");
    for (const error of sseErrors) assertCanaryFree(error, "other.invalid", "ENDPOINT-CANARY");
    expect(underlyingCloseCalls).toBe(1);
    expect(publicCloseCalls).toBe(1);
    expect(endpoint.requests()).toBe(1);
  });

  it("reduces arbitrary injected start, send, and onerror exceptions to fixed errors", async () => {
    class ThrowingTransport extends FakeTransport {
      override async start(): Promise<void> {
        const error = new Error("START-CANARY https://secret.invalid/start");
        this.onerror?.(error);
        throw error;
      }
      override async send(): Promise<void> {
        const error = new Error("SEND-CANARY authorization=secret");
        this.onerror?.(error);
        throw error;
      }
    }
    const handle = await createRemoteMcpTransport(config("http"), {
      StreamableHTTPClientTransport: ThrowingTransport as never,
    });
    const observed: Error[] = [];
    handle.onerror = (error) => observed.push(error);
    const startError = await handle.start().catch((error: unknown) => error);
    const sendError = await handle.send(initializeMessage).catch((error: unknown) => error);
    assertCanaryFree(startError, "START-CANARY", "secret.invalid");
    assertCanaryFree(sendError, "SEND-CANARY", "authorization=secret");
    expect(observed).toHaveLength(2);
    for (const error of observed) assertCanaryFree(error, "CANARY", "secret");
    await handle.close();
  });
});

describe("failure classification", () => {
  it.each([
    [401, "connection", "authentication"],
    [403, "call", "authentication"],
    [404, "connection", "not-found"],
    [410, "call", "not-found"],
    [408, "connection", "transient"],
    [429, "call", "transient"],
    [408, "discovery", "permanent"],
    [429, "discovery", "permanent"],
    [418, "connection", "permanent"],
    [500, "connection", "transient"],
    [503, "discovery", "transient"],
  ] as const)("classifies real HTTP status %i at %s as %s", async (status, stage, expected) => {
    const { error } = await directStatusFailure("http", status);
    const result = classifyRemoteMcpFailure(error, { stage });
    expect(result).toEqual({ class: expected, stage });
    assertCanaryFree(result, "BODY-CANARY", "STATUS-TEXT-CANARY", "HEADER-CANARY");
  });

  it("also preserves status identity for real SSE GET and POST paths", async () => {
    const get = await directStatusFailure("sse", 403);
    const post = await directStatusFailure("sse", 410, true);
    expect(classifyRemoteMcpFailure(get.error, { stage: "connection" }).class).toBe("authentication");
    expect(classifyRemoteMcpFailure(post.error, { stage: "call" }).class).toBe("not-found");
  });

  it("keeps status provenance operation-local across concurrent sends", async () => {
    let options: { fetch?: (url: string | URL, init?: RequestInit) => Promise<Response> } | undefined;
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    class ConcurrentTransport extends FakeTransport {
      constructor(_url: URL, captured?: typeof options) {
        super();
        options = captured;
      }
      override async send(message: JSONRPCMessage): Promise<void> {
        const id = "id" in message ? message.id : 0;
        const response = await options!.fetch!(`https://example.test/status-${id}`);
        if (!response.ok) throw new Error("SDK-GENERIC-CANARY");
      }
    }
    const handle = await createRemoteMcpTransport(config("http", "https://example.test/mcp"), {
      StreamableHTTPClientTransport: ConcurrentTransport as never,
      fetch: async (url) => {
        if (String(url).endsWith("status-1")) {
          firstEntered();
          await firstGate;
          return new Response("FIRST-BODY-CANARY", { status: 401 });
        }
        return new Response("SECOND-BODY-CANARY", { status: 503 });
      },
    });
    const first = handle.send({ ...initializeMessage, id: 1 }).catch((error: unknown) => error);
    await entered;
    const second = handle.send({ ...initializeMessage, id: 2 }).catch((error: unknown) => error);
    const secondError = await second;
    releaseFirst();
    const firstError = await first;
    expect(classifyRemoteMcpFailure(firstError, { stage: "call" }).class).toBe("authentication");
    expect(classifyRemoteMcpFailure(secondError, { stage: "call" }).class).toBe("transient");
    assertCanaryFree(firstError, "FIRST-BODY-CANARY", "SDK-GENERIC-CANARY");
    assertCanaryFree(secondError, "SECOND-BODY-CANARY", "SDK-GENERIC-CANARY");
    await handle.close();
  });

  it("uses explicit timeout and stream-loss provenance and fails unknowns closed", () => {
    expect(
      classifyRemoteMcpFailure(new Error("CANARY"), { stage: "connection", timedOut: true }).class,
    ).toBe("transient");
    expect(
      classifyRemoteMcpFailure(new Error("CANARY"), { stage: "discovery", timedOut: true }).class,
    ).toBe("permanent");
    expect(
      classifyRemoteMcpFailure(new Error("CANARY"), {
        stage: "call",
        transportLoss: { kind: "abrupt-stream-failure" },
      }).class,
    ).toBe("transient");
    expect(classifyRemoteMcpFailure(new Error("CANARY"), { stage: "connection" })).toEqual({
      class: "permanent",
      stage: "connection",
    });
  });

  it("recognizes pinned SDK status identity without returning SDK speech", () => {
    const streamable = classifyRemoteMcpFailure(new StreamableHTTPError(401, "CANARY"), {
      stage: "connection",
    });
    const sse = classifyRemoteMcpFailure(
      new SseError(404, "REMOTE-CANARY", new Event("error") as never),
      { stage: "connection" },
    );
    expect(streamable.class).toBe("authentication");
    expect(sse.class).toBe("not-found");
    assertCanaryFree(streamable, "CANARY");
    assertCanaryFree(sse, "CANARY");
  });
});

describe("safe remote fetch", () => {
  it("confines the initial URL before reading its body or issuing a request", async () => {
    const target = await listen((_req, res) => res.end("unexpected"));
    cleanups.push(target.close);
    let bodyPulls = 0;
    let injectedCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyPulls += 1;
        controller.enqueue(new Uint8Array([1]));
      },
    });
    await Promise.resolve();
    const pullsBeforeCall = bodyPulls;
    const safeFetch = createRemoteMcpFetch("https://configured.test/mcp", async () => {
      injectedCalls += 1;
      return new Response("unexpected");
    });
    const error = await safeFetch(`${target.origin}/steal`, {
      method: "POST",
      headers: { authorization: "STATIC-HEADER-CANARY" },
      body,
      duplex: "half",
    } as RequestInit).catch((caught: unknown) => caught);
    expect(bodyPulls).toBe(pullsBeforeCall);
    expect(injectedCalls).toBe(0);
    expect(target.requests()).toBe(0);
    assertCanaryFree(error, target.origin, "STATIC-HEADER-CANARY");
    await body.cancel();
  });

  it("preserves method, exact body, headers, and signal across a same-origin 307", async () => {
    const seen: Array<{
      url: string;
      method?: string;
      body?: Uint8Array;
      header: string | null;
      signal?: AbortSignal | null;
    }> = [];
    const controller = new AbortController();
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const safeFetch = createRemoteMcpFetch("https://example.test/mcp", async (url, init) => {
      seen.push({
        url: String(url),
        method: init?.method,
        body: init?.body as Uint8Array | undefined,
        header: new Headers(init?.headers).get("x-static"),
        signal: init?.signal,
      });
      return seen.length === 1
        ? new Response(null, { status: 307, headers: { location: "/redirected" } })
        : new Response("ok");
    });
    await safeFetch("https://example.test/mcp", {
      method: "POST",
      body: payload,
      headers: { "x-static": "secret" },
      signal: controller.signal,
    });
    expect(seen.map((request) => [request.url, request.method, [...(request.body ?? [])], request.header])).toEqual([
      ["https://example.test/mcp", "POST", [...payload], "secret"],
      ["https://example.test/redirected", "POST", [...payload], "secret"],
    ]);
    controller.abort("redirect cancellation");
    expect(seen.every((request) => request.signal?.aborted)).toBe(true);
  });

  it("accepts the 1 MiB replay cap exactly and rejects overflow before fetch", async () => {
    const cap = 1024 * 1024;
    let exactLength = 0;
    const exactFetch = createRemoteMcpFetch("https://example.test/mcp", async (_url, init) => {
      exactLength = (init?.body as Uint8Array).byteLength;
      return new Response("ok");
    });
    await exactFetch("https://example.test/mcp", {
      method: "POST",
      body: new Uint8Array(cap),
    });
    expect(exactLength).toBe(cap);

    let overflowCalls = 0;
    let overflowCancelled = 0;
    const overflowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(cap));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        overflowCancelled += 1;
      },
    });
    const overflowFetch = createRemoteMcpFetch("https://example.test/mcp", async () => {
      overflowCalls += 1;
      return new Response("unexpected");
    });
    const overflow = await overflowFetch("https://example.test/mcp", {
      method: "POST",
      body: overflowBody,
      duplex: "half",
    } as RequestInit).catch((error: unknown) => error);
    expect(overflowCancelled).toBe(1);
    expect(overflowCalls).toBe(0);
    expect(String(overflow)).toBe(
      "RemoteMcpSafeError: Remote MCP request rejected by local policy.",
    );
  });

  it("cancels and settles a never-ending request body without issuing fetch", async () => {
    const controller = new AbortController();
    let cancelled = false;
    let calls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    const safeFetch = createRemoteMcpFetch("https://example.test/mcp", async () => {
      calls += 1;
      return new Response("unexpected");
    });
    const pending = safeFetch("https://example.test/mcp", {
      method: "POST",
      body,
      signal: controller.signal,
      duplex: "half",
    } as RequestInit);
    controller.abort();
    await settlement(pending, { description: "endless replay body to settle after abort" });
    const error = await pending.catch((caught: unknown) => caught);
    expect(classifyRemoteMcpFailure(error, { stage: "call" }).class).toBe("cancelled");
    expect(cancelled).toBe(true);
    expect(calls).toBe(0);
  });

  it("keeps cancellation causal when an unrelated rejection wins before a late abort", async () => {
    const late = new AbortController();
    const unrelatedFetch = createRemoteMcpFetch("https://example.test/mcp", async () => {
      throw new DOMException("UNOWNED-CANARY", "AbortError");
    });
    const unrelated = await unrelatedFetch("https://example.test/mcp", { signal: late.signal }).catch(
      (error: unknown) => error,
    );
    late.abort();
    expect(
      classifyRemoteMcpFailure(unrelated, { stage: "call", ownedAbortSignal: late.signal }).class,
    ).toBe("permanent");
    expect(
      classifyRemoteMcpFailure(new DOMException("CANARY", "AbortError"), { stage: "call" }).class,
    ).toBe("permanent");

    const owned = new AbortController();
    const ownedFetch = createRemoteMcpFetch("https://example.test/mcp", async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("NATIVE-CANARY")), {
          once: true,
        });
      }),
    );
    const pending = ownedFetch("https://example.test/mcp", { signal: owned.signal });
    owned.abort();
    const ownedError = await pending.catch((error: unknown) => error);
    expect(classifyRemoteMcpFailure(ownedError, { stage: "call" }).class).toBe("cancelled");
    assertCanaryFree(ownedError, "NATIVE-CANARY");

    const refusedFetch = createRemoteMcpFetch("https://example.test/mcp", async () => {
      throw Object.assign(new Error("NETWORK-CANARY"), { code: "ECONNREFUSED" });
    });
    const refused = await refusedFetch("https://example.test/mcp").catch((error: unknown) => error);
    expect(classifyRemoteMcpFailure(refused, { stage: "connection" }).class).toBe("transient");
    assertCanaryFree(refused, "NETWORK-CANARY");
  });

  it("caps redirects and rejects cross-origin and downgrade destinations before issuing them", async () => {
    let hops = 0;
    const capped = createRemoteMcpFetch("https://example.test/mcp", async () => {
      hops += 1;
      return new Response("BODY-CANARY", {
        status: 307,
        headers: { location: `/hop-${hops}?token=REDIRECT-CANARY` },
      });
    });
    const capError = await capped("https://example.test/mcp").catch((error: unknown) => error);
    expect(hops).toBe(4);
    assertCanaryFree(capError, "BODY-CANARY", "REDIRECT-CANARY");

    const target = await listen((_req, res) => res.end("unexpected"));
    const source = await listen((_req, res) => {
      res.writeHead(307, { location: `${target.origin}/stolen?token=CROSS-CANARY` }).end();
    });
    cleanups.push(target.close, source.close);
    const cross = createRemoteMcpFetch(`${source.origin}/mcp`);
    const crossError = await cross(`${source.origin}/mcp`, {
      headers: { "x-static": "secret" },
    }).catch((error: unknown) => error);
    expect(target.requests()).toBe(0);
    assertCanaryFree(crossError, "CROSS-CANARY", target.origin);

    const urls: string[] = [];
    const downgrade = createRemoteMcpFetch("https://secure.test/mcp", async (url) => {
      urls.push(String(url));
      return new Response(null, {
        status: 307,
        headers: { location: "http://secure.test/leak?token=DOWNGRADE-CANARY" },
      });
    });
    const downgradeError = await downgrade("https://secure.test/mcp").catch(
      (error: unknown) => error,
    );
    expect(urls).toEqual(["https://secure.test/mcp"]);
    assertCanaryFree(downgradeError, "DOWNGRADE-CANARY");
  });

  it("uses ambient fetch options only and restores HTTPS_PROXY in finally", async () => {
    const oldProxy = process.env["HTTPS_PROXY"];
    try {
      process.env["HTTPS_PROXY"] = "http://project-proxy.invalid";
      let captured: RequestInit | undefined;
      const safeFetch = createRemoteMcpFetch("https://example.test/mcp", async (_url, init) => {
        captured = init;
        return new Response("ok");
      });
      await safeFetch("https://example.test/mcp");
      expect(captured).not.toHaveProperty("dispatcher");
    } finally {
      if (oldProxy === undefined) delete process.env["HTTPS_PROXY"];
      else process.env["HTTPS_PROXY"] = oldProxy;
    }
  });
});

describe("real SDK protocol, stream loss, and recovery", () => {
  it.each(["http", "sse"] as const)("initializes, lists, calls, and closes real %s", async (kind) => {
    const fixture = await createMcpRemoteServer();
    cleanups.push(fixture.cleanup);
    const handle = await createRemoteMcpTransport(
      config(kind, kind === "http" ? fixture.streamableUrl : fixture.sseUrl, {
        "x-static": "fixture-secret",
      }),
    );
    const client = new Client({ name: "picc-test", version: "1" }, { capabilities: {} });
    try {
      await client.connect(handle);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("echo");
      const result = await client.callTool({ name: "echo", arguments: { value: 7 } });
      expect(JSON.stringify(result)).toContain("value");
      expect(fixture.requests.every((request) => request.headers["x-static"] === "fixture-secret")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it.each([
    ["http", false, "graceful-eof"],
    ["http", true, "abrupt-stream-failure"],
    ["sse", false, "graceful-eof"],
    ["sse", true, "abrupt-stream-failure"],
  ] as const)("reports real connected %s stream loss (abrupt=%s) as %s", async (kind, abrupt, expected) => {
    const fixture = await createMcpRemoteServer();
    cleanups.push(fixture.cleanup);
    const handle = await createRemoteMcpTransport(
      config(kind, kind === "http" ? fixture.streamableUrl : fixture.sseUrl),
    );
    const client = new Client({ name: "loss-test", version: "1" }, { capabilities: {} });
    const events: RemoteMcpDisconnect[] = [];
    handle.onDisconnect((event) => events.push(event));
    await client.connect(handle);
    const publicErrors: Error[] = [];
    const clientErrorListener = handle.onerror;
    handle.onerror = (error) => {
      publicErrors.push(error);
      clientErrorListener?.(error);
    };
    await waitUntil({
      description: `${kind} event stream to become active`,
      predicate: () => fixture.stats().streams > 0,
    });
    const requestsBeforeLoss = fixture.requests.length;
    if (abrupt) fixture.disconnectAbruptly();
    else fixture.disconnectGracefully();
    await waitUntil({
      description: `${kind} typed ${expected} event`,
      predicate: () => events.some((event) => event.kind === expected),
    });
    expect(events).toEqual([{ kind: expected }]);
    expect(fixture.requests).toHaveLength(requestsBeforeLoss);
    expect(publicErrors).toEqual([]);
    await client.close();
  });

  it("recovers with a new transport on the same listener after abrupt failure", async () => {
    const fixture = await createMcpRemoteServer();
    cleanups.push(fixture.cleanup);
    const first = await createRemoteMcpTransport(config("sse", fixture.sseUrl));
    const firstClient = new Client({ name: "first", version: "1" }, { capabilities: {} });
    const events: RemoteMcpDisconnect[] = [];
    first.onDisconnect((event) => events.push(event));
    await firstClient.connect(first);
    const stableUrl = fixture.sseUrl;
    fixture.disconnectAbruptly();
    await waitUntil({
      description: "first transport abrupt event",
      predicate: () => events.some((event) => event.kind === "abrupt-stream-failure"),
    });
    await firstClient.close();

    fixture.setMode({ kind: "healthy" });
    const second = await createRemoteMcpTransport(config("sse", stableUrl));
    const secondClient = new Client({ name: "second", version: "1" }, { capabilities: {} });
    try {
      await secondClient.connect(second);
      expect((await secondClient.listTools()).tools.map((tool) => tool.name)).toContain("echo");
    } finally {
      await secondClient.close();
    }
    expect(fixture.sseUrl).toBe(stableUrl);
  });

  it("releases a delayed request into healthy behavior without rebinding", async () => {
    const fixture = await createMcpRemoteServer();
    cleanups.push(fixture.cleanup);
    fixture.setMode({ kind: "delayed" });
    const stableUrl = fixture.streamableUrl;
    const handle = await createRemoteMcpTransport(config("http", stableUrl));
    const client = new Client({ name: "delayed", version: "1" }, { capabilities: {} });
    const connecting = client.connect(handle);
    await waitUntil({
      description: "delayed initialize request",
      predicate: () => fixture.requests.length > 0,
    });
    fixture.setMode({ kind: "healthy" });
    fixture.releaseDelayed();
    await connecting;
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("echo");
    expect(fixture.streamableUrl).toBe(stableUrl);
    await client.close();
  });

  it("preserves valid server-controlled MCP tool errors unchanged", async () => {
    const fixture = await createMcpRemoteServer();
    cleanups.push(fixture.cleanup);
    const handle = await createRemoteMcpTransport(config("http", fixture.streamableUrl));
    const client = new Client({ name: "protocol-error", version: "1" }, { capabilities: {} });
    await client.connect(handle);
    fixture.setMode({ kind: "protocol-error", message: "PROTOCOL-ERROR-CANARY" });
    const result = await client.callTool({ name: "echo", arguments: { value: 1 } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("PROTOCOL-ERROR-CANARY");
    await client.close();
  });

  it("rejects real client call failures without remote HTTP speech", async () => {
    for (const kind of ["http", "sse"] as const) {
      const fixture = await createMcpRemoteServer();
      cleanups.push(fixture.cleanup);
      const handle = await createRemoteMcpTransport(
        config(kind, kind === "http" ? fixture.streamableUrl : fixture.sseUrl),
      );
      const client = new Client({ name: "failure-test", version: "1" }, { capabilities: {} });
      await client.connect(handle);
      fixture.setMode({
        kind: "status",
        status: 429,
        statusText: "CALL-STATUS-CANARY",
        body: "CALL-BODY-CANARY",
        headers: { "x-call-canary": "CALL-HEADER-CANARY" },
      });
      const error = await client.callTool({ name: "echo", arguments: { value: 1 } }).catch(
        (caught: unknown) => caught,
      );
      assertCanaryFree(error, "CALL-STATUS-CANARY", "CALL-BODY-CANARY", "CALL-HEADER-CANARY");
      expect(classifyRemoteMcpFailure(error, { stage: "call" }).class).toBe("transient");
      await client.close();
    }
  });

  it("closes SSE synchronously on stream failure so EventSource does not retry", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let requests = 0;
    let options:
      | { eventSourceInit?: { fetch?: (url: string | URL, init?: RequestInit) => Promise<Response> } }
      | undefined;
    let instance: SseTransport | undefined;
    class SseTransport extends FakeTransport {
      private stopped = false;
      constructor(_url: URL, captured?: typeof options) {
        super();
        options = captured;
        instance = this;
      }
      override async start(): Promise<void> {
        const response = await options!.eventSourceInit!.fetch!("http://127.0.0.1:1/mcp", {
          method: "GET",
        });
        try {
          await response.body!.getReader().read();
        } catch {
          if (!this.stopped) requests += 1;
        }
      }
      override async close(): Promise<void> {
        this.stopped = true;
        await super.close();
      }
    }
    const handle = await createRemoteMcpTransport(config("sse"), {
      SSEClientTransport: SseTransport as never,
      fetch: async () => {
        requests += 1;
        return new Response(
          new ReadableStream({ start(controller) { streamController = controller; } }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const started = handle.start();
    await waitUntil({
      description: "injected SSE stream to be created",
      predicate: () => streamController !== undefined,
    });
    streamController!.error(new Error("EventSource canary"));
    await started;
    expect(instance!.closeCalls).toBe(1);
    expect(requests).toBe(1);
    await handle.close();

    const next = await createRemoteMcpTransport(config("sse"), {
      SSEClientTransport: SseTransport as never,
      fetch: async () => {
        requests += 1;
        return new Response(
          new ReadableStream({ start(controller) { streamController = controller; } }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const nextStarted = next.start();
    await waitUntil({
      description: "PiCC-owned next SSE attempt",
      predicate: () => requests === 2,
    });
    streamController!.close();
    await nextStarted;
    expect(requests).toBe(2);
    await next.close();
  });

  it("cleans up idempotently during delayed handshake and active SSE", async () => {
    const delayed = await createMcpRemoteServer();
    cleanups.push(delayed.cleanup);
    delayed.setMode({ kind: "delayed" });
    const pending = fetch(delayed.streamableUrl, { method: "POST", body: "{}" }).catch(() => undefined);
    await waitUntil({
      description: "delayed request to arrive",
      predicate: () => delayed.requests.length === 1 && delayed.stats().timers === 1,
    });
    delayed.releaseDelayed();
    expect(delayed.stats().timers).toBe(0);
    await Promise.all([delayed.cleanup(), delayed.cleanup()]);
    await pending;
    expect(delayed.stats()).toEqual({ listenerOpen: false, sockets: 0, streams: 0, timers: 0 });

    const active = await createMcpRemoteServer();
    cleanups.push(active.cleanup);
    const handle = await createRemoteMcpTransport(config("sse", active.sseUrl));
    const client = new Client({ name: "cleanup-test", version: "1" }, { capabilities: {} });
    await client.connect(handle);
    await Promise.all([active.cleanup(), active.cleanup(), handle.close()]);
    expect(active.stats()).toEqual({ listenerOpen: false, sockets: 0, streams: 0, timers: 0 });
  });

  it("runs every cleanup arm and memoizes a fixed AggregateError", async () => {
    const fixture = await createMcpRemoteServer();
    cleanups.push(() => fixture.cleanup().catch(() => undefined));
    fixture.setMode({ kind: "delayed" });
    const pending = fetch(fixture.streamableUrl, { method: "POST", body: "{}" }).catch(
      () => undefined,
    );
    await waitUntil({
      description: "failure-injection fixture to own a socket and timer",
      predicate: () => fixture.stats().sockets > 0 && fixture.stats().timers === 1,
    });
    fixture.injectCleanupFailure("sync");
    fixture.injectCleanupFailure("async");
    const cleanup = fixture.cleanup();
    expect(fixture.cleanup()).toBe(cleanup);
    const error = await cleanup.catch((caught: unknown) => caught);
    await pending;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe("Remote MCP fixture cleanup failed.");
    expect(fixture.cleanupFailureArmRuns()).toBe(2);
    expect(fixture.stats()).toEqual({ listenerOpen: false, sockets: 0, streams: 0, timers: 0 });
    const repeated = await fixture.cleanup().catch((caught: unknown) => caught);
    expect(repeated).toBe(error);
    expect(fixture.cleanupFailureArmRuns()).toBe(2);
  });
});

async function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void>; requests: () => number }> {
  let count = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    count += 1;
    handler(req, res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests: () => count,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

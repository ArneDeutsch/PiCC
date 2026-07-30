import { AsyncLocalStorage } from "node:async_hooks";
import type {
  RemoteMcpTransportKind,
  ResolvedRemoteMcpFields,
} from "../claude/mcp-remote-config.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export type RemoteMcpFailureClass =
  | "authentication"
  | "not-found"
  | "permanent"
  | "transient"
  | "cancelled";

export type RemoteMcpStage = "connection" | "discovery" | "call";

export type RemoteMcpDisconnect =
  | { kind: "graceful-eof" }
  | { kind: "abrupt-stream-failure" };

export interface RemoteMcpFailureContext {
  stage: RemoteMcpStage;
  /** Exact operation signal for callers that retain it; its later state is not cancellation proof. */
  ownedAbortSignal?: AbortSignal;
  /** Local timeout provenance for the exact operation being classified. */
  timedOut?: boolean;
  /** Adapter-owned stream lifecycle evidence for this operation. */
  transportLoss?: RemoteMcpDisconnect;
}

export interface RemoteMcpFailure {
  class: RemoteMcpFailureClass;
  stage: RemoteMcpStage;
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
type StreamableCtor = new (
  url: URL,
  options?: StreamableHTTPClientTransportOptions,
) => Transport;
type SseCtor = new (url: URL, options?: SSEClientTransportOptions) => Transport;

export interface RemoteMcpTransportDeps {
  fetch?: FetchLike;
  StreamableHTTPClientTransport?: StreamableCtor;
  SSEClientTransport?: SseCtor;
}

export interface RemoteMcpTransportHandle extends Transport {
  readonly transportKind: RemoteMcpTransportKind;
  readonly deprecated: boolean;
  onDisconnect(listener: (event: RemoteMcpDisconnect) => void): () => void;
  /** Idempotent synchronous abort initiation followed by awaited SDK cleanup. */
  abort(): Promise<void>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 3;
const MAX_REPLAY_BODY_BYTES = 1024 * 1024;
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

type SafeErrorKind = "cancelled" | "network" | "policy" | "transport";

class RemoteMcpSafeError extends Error {
  declare readonly status?: number;
  declare readonly networkCode?: string;
  readonly kind: SafeErrorKind;

  constructor(kind: SafeErrorKind, options: { status?: number; networkCode?: string } = {}) {
    const messages: Record<SafeErrorKind, string> = {
      cancelled: "Remote MCP operation cancelled.",
      network: "Remote MCP network request failed.",
      policy: "Remote MCP request rejected by local policy.",
      transport: "Remote MCP transport operation failed.",
    };
    super(messages[kind]);
    this.name = "RemoteMcpSafeError";
    this.kind = kind;
    Object.defineProperties(this, {
      status: { value: options.status, enumerable: false },
      networkCode: { value: options.networkCode, enumerable: false },
    });
  }
}

interface OperationEvidence {
  status?: number;
}

const operationEvidence = new AsyncLocalStorage<OperationEvidence>();

interface FetchObserver {
  onStreamEnd(event: RemoteMcpDisconnect): void;
  onFetchFailure(): void;
  inactive(): boolean;
}

export function createRemoteMcpFetch(baseUrl: URL | string, baseFetch?: FetchLike): FetchLike {
  return createObservedRemoteMcpFetch(baseUrl, baseFetch, undefined);
}

function createObservedRemoteMcpFetch(
  baseUrl: URL | string,
  baseFetch: FetchLike | undefined,
  observer: FetchObserver | undefined,
): FetchLike {
  const configured = new URL(baseUrl);
  const fetchImpl = baseFetch ?? globalThis.fetch;

  return async (url, init) => {
    let currentUrl: URL;
    try {
      currentUrl = new URL(url);
    } catch {
      throw new RemoteMcpSafeError("policy");
    }
    if (currentUrl.origin !== configured.origin) {
      throw new RemoteMcpSafeError("policy");
    }

    let initial: Request;
    try {
      initial = new Request(currentUrl, { ...init, redirect: "manual" });
    } catch {
      throw new RemoteMcpSafeError("policy");
    }
    const body = await readReplayBody(initial);
    let method = initial.method;
    let currentBody = body;

    for (let hop = 0; ; hop += 1) {
      if (initial.signal.aborted) throw new RemoteMcpSafeError("cancelled");
      const requestInit: RequestInit = {
        method,
        headers: new Headers(initial.headers),
        body: method === "GET" || method === "HEAD" ? undefined : currentBody,
        signal: initial.signal,
        cache: initial.cache,
        credentials: initial.credentials,
        integrity: initial.integrity,
        keepalive: initial.keepalive,
        mode: initial.mode,
        redirect: "manual",
        referrer: initial.referrer,
        referrerPolicy: initial.referrerPolicy,
      };
      let response: Response;
      try {
        response = await abortOwned(fetchImpl(currentUrl, requestInit), initial.signal);
      } catch (error) {
        if (error instanceof RemoteMcpSafeError && error.kind === "cancelled") throw error;
        const safeError = safeTransportError(error);
        if (
          safeError.kind === "network" &&
          safeError.networkCode !== undefined &&
          !observer?.inactive()
        ) {
          observer?.onFetchFailure();
        }
        throw safeError;
      }
      if (!REDIRECT_STATUSES.has(response.status)) {
        if (!response.ok) {
          const evidence = operationEvidence.getStore();
          if (evidence !== undefined) evidence.status = response.status;
          await cancelBody(response);
          response = new Response(null, {
            status: response.status,
            statusText: "",
            headers: { "content-type": "text/plain" },
          });
        }
        return observeEventStream(response, observer, method);
      }

      if (hop >= MAX_REDIRECT_HOPS) {
        await cancelBody(response);
        throw new RemoteMcpSafeError("policy");
      }
      const location = response.headers.get("location");
      let next: URL;
      try {
        if (location === null) throw new Error();
        next = new URL(location, currentUrl);
      } catch {
        await cancelBody(response);
        throw new RemoteMcpSafeError("policy");
      }
      if (configured.protocol === "https:" && next.protocol === "http:") {
        await cancelBody(response);
        throw new RemoteMcpSafeError("policy");
      }
      if (next.origin !== configured.origin) {
        await cancelBody(response);
        throw new RemoteMcpSafeError("policy");
      }
      await cancelBody(response);
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        currentBody = undefined;
      }
      currentUrl = next;
    }
  };
}

async function readReplayBody(request: Request): Promise<Uint8Array | undefined> {
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await abortOwned(reader.read(), request.signal);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_REPLAY_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RemoteMcpSafeError("policy");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof RemoteMcpSafeError) throw error;
    throw new RemoteMcpSafeError("policy");
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function abortOwned<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RemoteMcpSafeError("cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new RemoteMcpSafeError("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function observeEventStream(
  response: Response,
  observer: FetchObserver | undefined,
  method: string,
): Response {
  if (
    observer === undefined ||
    method !== "GET" ||
    response.body === null ||
    !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")
  ) {
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          if (!observer.inactive()) observer.onStreamEnd({ kind: "graceful-eof" });
        } else {
          controller.enqueue(chunk.value);
        }
      } catch {
        controller.error(new RemoteMcpSafeError("network"));
        if (!observer.inactive()) observer.onStreamEnd({ kind: "abrupt-stream-failure" });
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function classifyRemoteMcpFailure(
  error: unknown,
  context: RemoteMcpFailureContext,
): RemoteMcpFailure {
  let failureClass: RemoteMcpFailureClass = "permanent";
  if (error instanceof RemoteMcpSafeError && error.kind === "cancelled") {
    failureClass = "cancelled";
  } else if (context.transportLoss !== undefined) {
    failureClass = "transient";
  } else {
    const status = inspectedStatus(error);
    if (status === 401 || status === 403) {
      failureClass = "authentication";
    } else if (status === 404 || status === 410) {
      failureClass = "not-found";
    } else if (status !== undefined && status >= 400 && status < 500) {
      failureClass =
        context.stage !== "discovery" && (status === 408 || status === 429)
          ? "transient"
          : "permanent";
    } else if (status !== undefined && status >= 500 && status < 600) {
      failureClass = "transient";
    } else if (context.timedOut) {
      failureClass = context.stage === "discovery" ? "permanent" : "transient";
    } else if (
      error instanceof RemoteMcpSafeError &&
      error.kind === "network" &&
      error.networkCode !== undefined
    ) {
      failureClass = "transient";
    }
  }
  return { class: failureClass, stage: context.stage };
}

function inspectedStatus(error: unknown): number | undefined {
  if (error instanceof RemoteMcpSafeError) return error.status;
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; status?: unknown; constructor?: { name?: string } };
  const identity = candidate.constructor?.name;
  if (identity !== "StreamableHTTPError" && identity !== "SseError") return undefined;
  const value = typeof candidate.status === "number" ? candidate.status : candidate.code;
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function knownNetworkCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && NETWORK_CODES.has(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

function safeTransportError(error: unknown, evidence?: OperationEvidence): RemoteMcpSafeError {
  if (error instanceof RemoteMcpSafeError) return error;
  const status = evidence?.status ?? operationEvidence.getStore()?.status ?? inspectedStatus(error);
  if (status !== undefined) return new RemoteMcpSafeError("transport", { status });
  const networkCode = knownNetworkCode(error);
  if (networkCode !== undefined) return new RemoteMcpSafeError("network", { networkCode });
  return new RemoteMcpSafeError("transport");
}

export async function createRemoteMcpTransport(
  config: ResolvedRemoteMcpFields,
  deps: RemoteMcpTransportDeps = {},
): Promise<RemoteMcpTransportHandle> {
  const listeners = new Set<(event: RemoteMcpDisconnect) => void>();
  let closing = false;
  let disconnectEmitted = false;
  let closePromise: Promise<void> | undefined;
  let transport: Transport;
  let sseStarted = false;
  let initiateClose: () => Promise<void> = () => Promise.resolve();

  const emitDisconnect = (event: RemoteMcpDisconnect): void => {
    if (closing || disconnectEmitted) return;
    disconnectEmitted = true;
    // Aborting before the wrapped reader settles prevents the SDK from entering its own
    // reconnect branch; PiCC's outer server lifecycle is the sole reconnect owner.
    void initiateClose().catch(() => undefined);
    for (const listener of [...listeners]) listener(event);
  };
  const observer: FetchObserver = {
    onStreamEnd: emitDisconnect,
    onFetchFailure: () => emitDisconnect({ kind: "abrupt-stream-failure" }),
    inactive: () => closing,
  };
  const safeFetch = createObservedRemoteMcpFetch(config.url, deps.fetch, observer);
  const requestInit: RequestInit = { headers: new Headers(config.headers) };

  if (config.transportKind === "http") {
    const Constructor =
      deps.StreamableHTTPClientTransport ??
      (await import("@modelcontextprotocol/sdk/client/streamableHttp.js"))
        .StreamableHTTPClientTransport;
    transport = new Constructor(new URL(config.url), {
      fetch: safeFetch,
      requestInit,
      reconnectionOptions: {
        initialReconnectionDelay: 1_000,
        maxReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    });
  } else {
    const Constructor =
      deps.SSEClientTransport ??
      (await import("@modelcontextprotocol/sdk/client/sse.js")).SSEClientTransport;
    transport = new Constructor(new URL(config.url), {
      fetch: safeFetch,
      requestInit,
      eventSourceInit: { fetch: safeFetch },
    });
  }

  const originalClose = transport.close.bind(transport);
  initiateClose = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closing = true;
    let resolveClose!: () => void;
    let rejectClose!: (error: RemoteMcpSafeError) => void;
    closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    try {
      Promise.resolve(originalClose()).then(resolveClose, (error: unknown) => {
        rejectClose(safeTransportError(error));
      });
    } catch (error) {
      rejectClose(safeTransportError(error));
    }
    return closePromise;
  };
  transport.close = initiateClose;

  let closeListener: Transport["onclose"];
  let holdCloseNotification = false;
  let delayedCloseNotification = false;
  transport.onclose = (): void => {
    if (holdCloseNotification) {
      if (!delayedCloseNotification) {
        delayedCloseNotification = true;
        const timer = setTimeout(() => closeListener?.(), 0);
        timer.unref();
      }
      return;
    }
    closeListener?.();
  };

  const handle: RemoteMcpTransportHandle = {
    transportKind: config.transportKind,
    deprecated: config.transportKind === "sse",
    onDisconnect(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort: initiateClose,
    close: initiateClose,
    async start() {
      const evidence: OperationEvidence = {};
      try {
        await operationEvidence.run(evidence, () => transport.start());
        sseStarted = true;
      } catch (error) {
        throw safeTransportError(error, evidence);
      }
    },
    async send(message: JSONRPCMessage, options?: TransportSendOptions) {
      const evidence: OperationEvidence = {};
      try {
        await operationEvidence.run(evidence, () => transport.send(message, options));
      } catch (error) {
        throw safeTransportError(error, evidence);
      }
    },
    get sessionId() {
      return transport.sessionId;
    },
    setProtocolVersion(version: string) {
      transport.setProtocolVersion?.(version);
    },
  };

  Object.defineProperties(handle, {
    onclose: {
      get: () => closeListener,
      set: (listener: Transport["onclose"]) => {
        closeListener = listener;
      },
      enumerable: true,
    },
    onmessage: {
      get: () => transport.onmessage,
      set: (listener: Transport["onmessage"]) => {
        transport.onmessage = listener;
      },
      enumerable: true,
    },
  });

  let errorListener: Transport["onerror"];
  Object.defineProperty(handle, "onerror", {
    get: () => errorListener,
    set: (listener: Transport["onerror"]) => {
      errorListener = listener;
    },
    enumerable: true,
  });
  transport.onerror = (error: Error): void => {
    if (closing && disconnectEmitted) return;
    const evidence = operationEvidence.getStore();
    const safeError = safeTransportError(error, evidence);
    const terminalSseError =
      config.transportKind === "sse" &&
      (!sseStarted || inspectedStatus(safeError) !== undefined || error.constructor.name === "SseError");
    if (terminalSseError) {
      // EventSource must stop synchronously, while the operation's status rejection wins over
      // the SDK's generic connection-closed callback at the public handle boundary.
      holdCloseNotification = true;
      void initiateClose().catch(() => undefined);
      holdCloseNotification = false;
    }
    errorListener?.(safeError);
  };

  return handle;
}

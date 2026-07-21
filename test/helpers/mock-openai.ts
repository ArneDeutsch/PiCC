import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { deferred, type Deferred } from "./async.js";

export interface MockToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface MockErrorSpec {
  status: number;
  message?: string;
  sticky?: boolean;
}

export interface MockUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** A test-owned response barrier. `entered` is readiness, never a silence assertion. */
export interface MockResponseGate {
  readonly entered: Promise<CapturedRequest>;
  release(): void;
}

export function createResponseGate(): MockResponseGate {
  const entered = deferred<CapturedRequest>();
  const released = deferred<void>();
  void entered.promise.catch(() => undefined);
  void released.promise.catch(() => undefined);
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    // Kept structural rather than exported: only this server may publish entry/read release.
    _entered: entered,
    _released: released,
  } as MockResponseGate;
}

interface InternalResponseGate extends MockResponseGate {
  _entered: Deferred<CapturedRequest>;
  _released: Deferred<void>;
}

export interface Turn {
  toolCalls?: MockToolCall[];
  text?: string;
  error?: MockErrorSpec;
  /** Usage emitted for this turn; defaults to the historic small fixture usage. */
  usage?: MockUsage;
  /** Hold the response after capture until the test explicitly releases it. */
  gate?: MockResponseGate;
  when?: (request: CapturedRequest) => boolean;
}

export type RequestKind = "ordinary" | "compaction";
export type SessionKind = "main" | "child";

export interface CapturedRequest {
  path: string;
  model?: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  body: Record<string, unknown>;
  requestKind: RequestKind;
  sessionKind: SessionKind;
}

export interface RequestClassifierOptions {
  /** Exact originating user messages that identify child/nested sessions in this script. */
  childUserMessages?: readonly string[];
  /** Exact configured persona markers for resumed child requests whose original turn was compacted away. */
  childSystemMarkers?: readonly string[];
}

export interface MockModelServer {
  url: string;
  requests: CapturedRequest[];
  /** Resolves from request capture, with a rejecting safety ceiling only. */
  waitForRequest(
    predicate?: (request: CapturedRequest) => boolean,
    count?: number,
    timeoutMs?: number,
  ): Promise<CapturedRequest>;
  close(): Promise<void>;
}

interface Chunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: MockUsage;
}

const DEFAULT_USAGE: MockUsage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
const SUMMARY_SYSTEM_MARKER = "You are a context summarization assistant. Your task is to read a conversation";

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? part.text
        : JSON.stringify(part)).join("\n");
  }
  return JSON.stringify(message.content ?? "");
}

/** Classify from the wire body, not script position or elapsed timing. */
export function classifyRequest(
  request: Pick<CapturedRequest, "messages" | "tools">,
  priorRequests: readonly CapturedRequest[] = [],
  options: RequestClassifierOptions = {},
): Pick<CapturedRequest, "requestKind" | "sessionKind"> {
  const system = request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map(messageText)
    .join("\n");
  const all = request.messages.map(messageText).join("\n");
  const requestKind: RequestKind = system.includes(SUMMARY_SYSTEM_MARKER) ? "compaction" : "ordinary";
  const exactChildMarkers = new Set(options.childUserMessages ?? []);
  const exactChildSystemMarkers = options.childSystemMarkers ?? [];
  const ordinaryUsers = request.messages
    .filter((message) => message.role === "user")
    .map(messageText);
  let sessionKind: SessionKind = ordinaryUsers.some((text) => exactChildMarkers.has(text)) ||
    exactChildSystemMarkers.some((marker) => system.includes(marker)) ? "child" : "main";
  if (requestKind === "compaction") {
    const originalUser = all.match(/<conversation>\s*\n\[User\]: ([^\n]+)/u)?.[1];
    const origin = originalUser === undefined ? undefined : [...priorRequests].reverse().find((candidate) =>
      candidate.requestKind === "ordinary" && candidate.messages.some((message) =>
        message.role === "user" && messageText(message) === originalUser));
    sessionKind = origin?.sessionKind ?? (originalUser !== undefined && exactChildMarkers.has(originalUser) ? "child" : "main");
  }
  return { requestKind, sessionKind };
}

function buildChunks(turn: Turn, model: string, requestIndex: number): Chunk[] {
  const id = `chatcmpl-mock-${requestIndex}`;
  const created = Math.floor(Date.now() / 1000);
  const base = (delta: Record<string, unknown>, finish: string | null = null): Chunk => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const chunks: Chunk[] = [base({ role: "assistant" })];
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    turn.toolCalls.forEach((call, i) => {
      const argsJson = JSON.stringify(call.args ?? {});
      const mid = Math.ceil(argsJson.length / 2);
      chunks.push(
        base({ tool_calls: [{ index: i, id: `call_${requestIndex}_${i}`, type: "function", function: { name: call.name, arguments: argsJson.slice(0, mid) } }] }),
        base({ tool_calls: [{ index: i, function: { arguments: argsJson.slice(mid) } }] }),
      );
    });
    chunks.push(base({}, "tool_calls"));
  } else {
    const text = turn.text ?? "done";
    const mid = Math.ceil(text.length / 2);
    if (text.slice(0, mid)) chunks.push(base({ content: text.slice(0, mid) }));
    if (text.slice(mid)) chunks.push(base({ content: text.slice(mid) }));
    chunks.push(base({}, "stop"));
  }
  chunks.push({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { ...(turn.usage ?? DEFAULT_USAGE) } });
  return chunks;
}

function buildNonStreamingResponse(turn: Turn, model: string, requestIndex: number): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: turn.text ?? null };
  let finish = "stop";
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    finish = "tool_calls";
    message.content = null;
    message.tool_calls = turn.toolCalls.map((call, i) => ({
      id: `call_${requestIndex}_${i}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    }));
  } else if (message.content === null) message.content = "done";
  return {
    id: `chatcmpl-mock-${requestIndex}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { ...(turn.usage ?? DEFAULT_USAGE) },
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockModel(
  script: Turn[],
  classifierOptions: RequestClassifierOptions = {},
): Promise<MockModelServer> {
  const requests: CapturedRequest[] = [];
  const consumed = script.map(() => false);
  const waiters = new Set<{
    predicate: (request: CapturedRequest) => boolean;
    remaining: number;
    resolve: (request: CapturedRequest) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  const responseGates = new Set<InternalResponseGate>(
    script.flatMap((turn) => turn.gate ? [turn.gate as InternalResponseGate] : []),
  );
  const sockets = new Set<Socket>();
  let closed = false;

  function publish(request: CapturedRequest): void {
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(request)) continue;
      waiter.remaining -= 1;
      if (waiter.remaining === 0) {
        waiters.delete(waiter);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(request);
      }
    }
  }

  function nextTurn(request: CapturedRequest): Turn {
    for (let i = 0; i < script.length; i++) {
      if (consumed[i]) continue;
      const candidate = script[i]!;
      if (candidate.when && !candidate.when(request)) continue;
      if (!(candidate.error && candidate.error.sticky !== false)) consumed[i] = true;
      return candidate;
    }
    return { text: "done" };
  }

  const server = http.createServer(async (req, res) => {
    const requestPath = (req.url ?? "").split("?")[0] ?? "";
    if (req.method !== "POST" || !requestPath.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `mock: no route for ${req.method} ${requestPath}` } }));
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `mock: bad JSON body: ${(err as Error).message}` } }));
      return;
    }
    const base = {
      path: requestPath,
      model: typeof body.model === "string" ? body.model : undefined,
      messages: Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [],
      tools: Array.isArray(body.tools) ? body.tools as Array<Record<string, unknown>> : undefined,
      body,
    };
    const captured: CapturedRequest = { ...base, ...classifyRequest(base, requests, classifierOptions) };
    requests.push(captured);
    publish(captured);
    const turn = nextTurn(captured);
    if (turn.gate) {
      const gate = turn.gate as InternalResponseGate;
      gate._entered.resolve(captured);
      try {
        await gate._released.promise;
      } catch {
        res.destroy();
        return;
      } finally {
        responseGates.delete(gate);
      }
      if (res.destroyed) return;
    }
    const requestIndex = requests.length - 1;
    const model = typeof body.model === "string" ? body.model : "mock-1";
    if (turn.error) {
      res.writeHead(turn.error.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: turn.error.message ?? `mock: scripted error (${turn.error.status})`, type: "mock_scripted_error", code: turn.error.status } }));
      return;
    }
    if (body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildNonStreamingResponse(turn, model, requestIndex)));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
    for (const chunk of buildChunks(turn, model, requestIndex)) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    waitForRequest(predicate = () => true, count = 1, timeoutMs = 10_000) {
      const existing = requests.filter(predicate);
      if (existing.length >= count) return Promise.resolve(existing[count - 1]!);
      if (closed) return Promise.reject(new Error("Mock model server is closed"));
      return new Promise<CapturedRequest>((resolve, reject) => {
        const waiter = {
          predicate,
          remaining: count - existing.length,
          resolve,
          reject,
          timer: undefined as ReturnType<typeof setTimeout> | undefined,
        };
        waiters.add(waiter);
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for request ${count}; captured ${requests.length}: ${requests.map((r) => `${r.sessionKind}/${r.requestKind}`).join(", ")}`));
        }, timeoutMs);
      });
    },
    close: () => new Promise<void>((resolve) => {
      if (closed) return resolve();
      closed = true;
      const error = new Error("Mock model server closed during pending operation");
      for (const waiter of waiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      waiters.clear();
      for (const gate of responseGates) {
        gate._entered.reject(error);
        gate._released.reject(error);
      }
      responseGates.clear();
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

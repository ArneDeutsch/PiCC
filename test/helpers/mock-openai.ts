import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Scriptable mock OpenAI-compatible model server for live e2e tests.
 *
 * Each incoming POST to /v1/chat/completions (any prefix; matched by path
 * suffix "/chat/completions") consumes the next Turn from the script. A
 * toolCalls turn streams OpenAI `tool_calls` deltas and finishes with
 * finish_reason "tool_calls"; a text turn streams content deltas and finishes
 * with "stop". When the script is exhausted the server answers with a plain
 * text turn "done" so the agent loop always terminates.
 */
export interface MockToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Scripted HTTP error response (t01: error-path e2e). */
export interface MockErrorSpec {
  /** HTTP status to answer with (e.g. 429, 500). */
  status: number;
  /** Message for the OpenAI-style error body. */
  message?: string;
  /**
   * Sticky (the default): the turn is NEVER consumed, so Pi's automatic retries
   * — and any later request matching `when` — keep hitting the same error
   * instead of falling through to the script-exhaustion `{text: "done"}`
   * fallback (which would convert a retried failure into a success).
   * Set `sticky: false` for a one-shot error.
   */
  sticky?: boolean;
}

export interface Turn {
  toolCalls?: MockToolCall[];
  text?: string;
  /** Serve an HTTP error instead of a completion (takes precedence). */
  error?: MockErrorSpec;
  /**
   * Optional gate for concurrent-session scripts: the turn is only served to a
   * request this predicate accepts. On each request the server picks the FIRST
   * unconsumed turn whose predicate matches (turns without `when` match any
   * request), so scripts without predicates keep the strict sequential order.
   */
  when?: (request: CapturedRequest) => boolean;
}

export interface CapturedRequest {
  /** URL path the client hit (e.g. /v1/chat/completions). */
  path: string;
  model?: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  /** Full parsed request body. */
  body: Record<string, unknown>;
}

export interface MockModelServer {
  url: string;
  requests: CapturedRequest[];
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
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };

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
      // First delta carries id + function name + first half of the arguments,
      // second delta carries the remaining arguments (streamed JSON).
      chunks.push(
        base({
          tool_calls: [
            {
              index: i,
              id: `call_${requestIndex}_${i}`,
              type: "function",
              function: { name: call.name, arguments: argsJson.slice(0, mid) },
            },
          ],
        }),
        base({
          tool_calls: [{ index: i, function: { arguments: argsJson.slice(mid) } }],
        }),
      );
    });
    chunks.push(base({}, "tool_calls"));
  } else {
    const text = turn.text ?? "done";
    // Split content across two deltas to exercise real streaming assembly.
    const mid = Math.ceil(text.length / 2);
    if (text.slice(0, mid)) chunks.push(base({ content: text.slice(0, mid) }));
    if (text.slice(mid)) chunks.push(base({ content: text.slice(mid) }));
    chunks.push(base({}, "stop"));
  }

  // Final usage chunk (stream_options.include_usage style) — sent regardless.
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage: { ...USAGE },
  });
  return chunks;
}

function buildNonStreamingResponse(
  turn: Turn,
  model: string,
  requestIndex: number,
): Record<string, unknown> {
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
  } else if (message.content === null) {
    message.content = "done";
  }
  return {
    id: `chatcmpl-mock-${requestIndex}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { ...USAGE },
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

export async function startMockModel(script: Turn[]): Promise<MockModelServer> {
  const requests: CapturedRequest[] = [];
  const consumed = script.map(() => false);

  /** First unconsumed turn whose `when` accepts this request (none → fallback "done"). */
  function nextTurn(request: CapturedRequest): Turn {
    for (let i = 0; i < script.length; i++) {
      if (consumed[i]) continue;
      const candidate = script[i]!;
      if (candidate.when && !candidate.when(request)) continue;
      // Sticky error turns are never consumed: Pi's retries keep hitting them.
      if (!(candidate.error && candidate.error.sticky !== false)) consumed[i] = true;
      return candidate;
    }
    return { text: "done" };
  }

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `mock: no route for ${req.method} ${path}` } }));
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

    const requestIndex = requests.length;
    const captured: CapturedRequest = {
      path,
      model: typeof body.model === "string" ? body.model : undefined,
      messages: Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [],
      tools: Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : undefined,
      body,
    };
    requests.push(captured);

    const turn = nextTurn(captured);
    const model = typeof body.model === "string" ? body.model : "mock-1";

    if (turn.error) {
      // OpenAI-style error body; applies to streaming and non-streaming requests
      // alike (clients check the HTTP status before consuming any stream).
      res.writeHead(turn.error.status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: turn.error.message ?? `mock: scripted error (${turn.error.status})`,
            type: "mock_scripted_error",
            code: turn.error.status,
          },
        }),
      );
      return;
    }

    if (body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(buildNonStreamingResponse(turn, model, requestIndex)));
      return;
    }

    // SSE streaming (Pi always sends stream: true).
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const chunk of buildChunks(turn, model, requestIndex)) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

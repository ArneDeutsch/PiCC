import http, { type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export type RemoteMcpFixtureMode =
  | { kind: "healthy" }
  | {
      kind: "status";
      status: number;
      statusText?: string;
      body?: string;
      headers?: Record<string, string>;
    }
  | { kind: "delayed" }
  | { kind: "abrupt" }
  | { kind: "protocol-error"; message: string };

export interface RemoteMcpFixtureRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

export interface RemoteMcpFixtureStats {
  listenerOpen: boolean;
  sockets: number;
  streams: number;
  timers: number;
}

export interface McpRemoteServerFixture {
  readonly streamableUrl: string;
  readonly sseUrl: string;
  readonly requests: RemoteMcpFixtureRequest[];
  setMode(mode: RemoteMcpFixtureMode): void;
  releaseDelayed(): void;
  disconnectGracefully(): void;
  disconnectAbruptly(): void;
  injectCleanupFailure(kind: "sync" | "async"): void;
  cleanupFailureArmRuns(): number;
  stats(): RemoteMcpFixtureStats;
  cleanup(): Promise<void>;
}

function makeMcpServer(getMode: () => RemoteMcpFixtureMode): Server {
  const server = new Server(
    { name: "picc-loopback", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Returns its arguments.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const current = getMode();
    if (current.kind === "protocol-error") {
      return { isError: true, content: [{ type: "text", text: current.message }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(request.params.arguments ?? {}) }],
    };
  });
  return server;
}

export async function createMcpRemoteServer(): Promise<McpRemoteServerFixture> {
  let mode: RemoteMcpFixtureMode = { kind: "healthy" };
  const delayed = new Set<{ resolve: () => void; timer: NodeJS.Timeout }>();
  const timers = new Set<NodeJS.Timeout>();
  const cleanupFailures: Array<"sync" | "async"> = [];
  let cleanupFailureRuns = 0;
  let closed = false;
  let cleanupPromise: Promise<void> | undefined;
  const requests: RemoteMcpFixtureRequest[] = [];
  const sockets = new Set<Socket>();
  const streams = new Set<ServerResponse>();
  const servers = new Set<Server>();
  const transports = new Set<StreamableHTTPServerTransport | SSEServerTransport>();
  const sseBySession = new Map<string, SSEServerTransport>();

  const streamableTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  const streamableServer = makeMcpServer(() => mode);
  servers.add(streamableServer);
  transports.add(streamableTransport);
  await streamableServer.connect(streamableTransport);

  const listener = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      requests.push({ method: req.method ?? "GET", path, headers: { ...req.headers } });

      if (mode.kind === "delayed") {
        await new Promise<void>((resolve) => {
          let timer: NodeJS.Timeout;
          const entry = {
            resolve: () => {
              clearTimeout(timer);
              timers.delete(timer);
              delayed.delete(entry);
              resolve();
            },
            timer: undefined as unknown as NodeJS.Timeout,
          };
          timer = setTimeout(entry.resolve, 60_000);
          entry.timer = timer;
          timer.unref();
          timers.add(timer);
          delayed.add(entry);
        });
      }
      if (closed) return;
      if (mode.kind === "abrupt") {
        req.socket.destroy();
        return;
      }
      if (mode.kind === "status") {
        res.writeHead(mode.status, mode.statusText ?? "Fixture status", {
          "content-type": "text/plain",
          ...mode.headers,
        });
        res.end(mode.body ?? "REMOTE-SPEECH-CANARY");
        return;
      }

      if (path === "/mcp") {
        if (req.method === "GET") trackStream(res, streams);
        await streamableTransport.handleRequest(req, res);
        return;
      }
      if (path === "/sse" && req.method === "GET") {
        trackStream(res, streams);
        const transport = new SSEServerTransport("/messages", res);
        const mcp = makeMcpServer(() => mode);
        transports.add(transport);
        servers.add(mcp);
        sseBySession.set(transport.sessionId, transport);
        transport.onclose = () => {
          sseBySession.delete(transport.sessionId);
          transports.delete(transport);
          streams.delete(res);
        };
        await mcp.connect(transport);
        return;
      }
      if (path === "/messages" && req.method === "POST") {
        const sessionId = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("sessionId");
        const transport = sessionId === null ? undefined : sseBySession.get(sessionId);
        if (transport === undefined) {
          res.writeHead(404).end();
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  listener.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      listener.off("error", reject);
      resolve();
    });
  });
  const address = listener.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      closed = true;
      for (const entry of [...delayed]) entry.resolve();
      const cleanupArms: Array<() => void | Promise<void>> = [
        ...[...transports].map((transport) => () => transport.close()),
        ...[...servers].map((server) => () => server.close()),
        ...cleanupFailures.map((kind) => () => {
          cleanupFailureRuns += 1;
          if (kind === "sync") throw new Error("FIXTURE-SYNC-CLEANUP-CANARY");
          return Promise.reject(new Error("FIXTURE-ASYNC-CLEANUP-CANARY"));
        }),
      ];
      const cleanupResults = await Promise.allSettled(
        cleanupArms.map(async (arm) => arm()),
      );
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const stream of streams) stream.destroy();
      const socketClosures = [...sockets].map(
        (socket) => new Promise<void>((resolve) => {
          if (socket.destroyed) resolve();
          else socket.once("close", () => resolve());
          socket.destroy();
        }),
      );
      listener.closeAllConnections();
      if (listener.listening) {
        await new Promise<void>((resolve) => listener.close(() => resolve()));
      }
      await Promise.all(socketClosures);
      const failures = cleanupResults.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Remote MCP fixture cleanup failed.",
        );
      }
    })();
    return cleanupPromise;
  };

  return {
    streamableUrl: `${origin}/mcp`,
    sseUrl: `${origin}/sse`,
    requests,
    setMode(next) {
      mode = next;
    },
    releaseDelayed() {
      for (const entry of [...delayed]) entry.resolve();
    },
    disconnectGracefully() {
      for (const stream of streams) stream.end();
    },
    disconnectAbruptly() {
      for (const stream of streams) stream.destroy(new Error("fixture disconnect"));
    },
    injectCleanupFailure(kind) {
      cleanupFailures.push(kind);
    },
    cleanupFailureArmRuns() {
      return cleanupFailureRuns;
    },
    stats() {
      return {
        listenerOpen: listener.listening,
        sockets: sockets.size,
        streams: streams.size,
        timers: timers.size,
      };
    },
    cleanup,
  };
}

function trackStream(response: ServerResponse, streams: Set<ServerResponse>): void {
  streams.add(response);
  response.once("close", () => streams.delete(response));
}

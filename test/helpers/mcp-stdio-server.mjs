// SDK-based MCP stdio test server, spawned as `process.execPath <this file> <mode>`
// (no shebang on purpose — Windows has no shebang execution). Marker/release
// protocol mirrors test/helpers/hook-process.ts: markers are published into
// $MCP_BARRIER_DIR with atomic tmp+rename writes, and gated modes block until a
// `.release` marker appears. Modes:
//   serve            — tools `echo`, `report-env`, `big-output`
//   hang-initialize  — swallows stdin forever (initialize never answered); no SDK import
//   slow-tool        — tool `slow` blocks until `slow.release`, then publishes `slow.done`
//   spawn-grandchild — serve + a live grandchild process; publishes both pids
//   exit-early       — exits immediately after publishing its pid
//   hostile-tools    — advertises invalid/duplicate/oversized tool metadata
//   prompt-only      — advertises prompts without tools
//   resource-only    — advertises resources without tools
//   prompt-resource  — advertises prompts and resources without tools
//   empty-capabilities — advertises empty prompt/resource catalogs
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const mode = process.argv[2] ?? "serve";
const barrier = process.env.MCP_BARRIER_DIR;

const marker = (name) => path.join(barrier, name);
const publish = (name, value = "") => {
  if (!barrier) return;
  const destination = marker(name);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, value, "utf8");
  fs.renameSync(temporary, destination);
};
const waitForMarker = (name) =>
  new Promise((resolve) => {
    const check = () => {
      if (barrier && fs.existsSync(marker(name))) resolve();
      else setTimeout(check, 10);
    };
    check();
  });

publish(`${mode}.pid`, JSON.stringify({ pid: process.pid }));

if (mode === "exit-early") {
  process.exit(0);
} else if (mode === "hang-initialize") {
  // Never speak MCP: swallow stdin so the client's initialize request hangs
  // until its MCP_TIMEOUT bound. The interval keeps the process alive even
  // when the client closes our stdin, so kill discipline is provable.
  process.stdin.resume();
  setInterval(() => {}, 60_000);
} else {
  await serve();
}

async function serve() {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
  } = await import("@modelcontextprotocol/sdk/types.js");

  if (mode === "spawn-grandchild") {
    // A real, live grandchild (not detached, not unref'd): it keeps this
    // process alive past stdin-EOF, so the harness's tree-kill is what has to
    // end both of us.
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
    });
    publish("grandchild.pid", JSON.stringify({ pid: grandchild.pid }));
  }

  const objectSchema = (properties = {}) => ({ type: "object", properties });
  const textResult = (text) => ({ content: [{ type: "text", text }] });

  let tools;
  if (mode === "slow-tool") {
    tools = [{ name: "slow", description: "blocks until released", inputSchema: objectSchema() }];
  } else if (mode === "hostile-tools") {
    // Control/escape characters are spelled as \u escapes on purpose:
    // invisible bytes in source are unreviewable. Order matters: the first
    // five diagnostic-producing entries stay visible, the later ones prove
    // the per-server diagnostic cap.
    const longDescription = "\u001b[31mRED\u001b[0m" + "d".repeat(5000);
    tools = [
      { name: "long" + "*".repeat(300), description: "very long name", inputSchema: objectSchema() },
      { name: "dot.name", description: "dotted", inputSchema: objectSchema() },
      { name: "white space", description: "whitespace", inputSchema: objectSchema() },
      { name: "good", description: "first", inputSchema: objectSchema() },
      { name: "good", description: "second", inputSchema: objectSchema() },
      { name: "dot_name", description: "post-sanitize collision", inputSchema: objectSchema() },
      { name: "star*name", description: "glob char", inputSchema: objectSchema() },
      { name: "ctrl\u0007name", description: "control char", inputSchema: objectSchema() },
      { name: "", description: "empty name", inputSchema: objectSchema() },
      { name: "bad__tool", description: "kept verbatim (Claude parity)", inputSchema: objectSchema() },
      { name: "verbose", description: longDescription, inputSchema: objectSchema() },
    ];
  } else {
    tools = [
      {
        name: "echo",
        description: "echoes text back",
        inputSchema: objectSchema({ text: { type: "string" } }),
      },
      {
        name: "report-env",
        description: "reports the named environment variables",
        inputSchema: objectSchema({ names: { type: "array", items: { type: "string" } } }),
      },
      {
        name: "big-output",
        description: "returns `bytes` bytes of output",
        inputSchema: objectSchema({ bytes: { type: "number" } }),
      },
    ];
  }

  const hasTools = !["prompt-only", "resource-only", "prompt-resource", "empty-capabilities"].includes(mode);
  const hasPrompts = ["prompt-only", "prompt-resource", "empty-capabilities"].includes(mode);
  const hasResources = ["resource-only", "prompt-resource", "empty-capabilities"].includes(mode);
  const capabilities = {
    ...(hasTools ? { tools: {} } : {}),
    ...(hasPrompts ? { prompts: {} } : {}),
    ...(hasResources ? { resources: {} } : {}),
  };
  const server = new Server(
    { name: `picc-fixture-${mode}`, version: "1.0.0" },
    { capabilities },
  );
  if (hasTools) server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  if (hasTools) server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name === "echo") return textResult(String(args.text ?? ""));
    if (name === "report-env") {
      const names = Array.isArray(args.names) ? args.names : [];
      return textResult(
        JSON.stringify(Object.fromEntries(names.map((n) => [n, process.env[n] ?? null]))),
      );
    }
    if (name === "big-output") return textResult("x".repeat(Number(args.bytes ?? 0)));
    if (name === "slow") {
      publish("slow.entered", JSON.stringify({ pid: process.pid }));
      await waitForMarker("slow.release");
      publish("slow.done", JSON.stringify({ pid: process.pid }));
      return textResult("slow done");
    }
    throw new Error(`unknown tool: ${name}`);
  });
  if (hasPrompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: mode === "empty-capabilities" ? [] : [{
        name: "fixture-prompt",
        description: "Builds a fixture prompt",
        arguments: [
          { name: "required", description: "required value", required: true },
          { name: "optional", description: "optional value" },
        ],
      }],
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
      description: "fixture result",
      messages: [{
        role: "user",
        content: { type: "text", text: JSON.stringify(request.params.arguments ?? {}) },
      }],
    }));
  }
  if (hasResources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: mode === "empty-capabilities" ? [] : [
        { uri: "fixture://text", name: "fixture text", mimeType: "text/plain", size: 12 },
        { uri: "fixture://binary", name: "fixture binary", mimeType: "application/octet-stream" },
      ],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
      contents: request.params.uri === "fixture://binary"
        ? [{ uri: request.params.uri, mimeType: "application/octet-stream", blob: "AAEC" }]
        : [{ uri: request.params.uri, mimeType: "text/plain", text: "fixture text" }],
    }));
  }
  await server.connect(new StdioServerTransport());
}

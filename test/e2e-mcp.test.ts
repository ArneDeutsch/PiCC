import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  allText,
  cliMissing,
  createE2ELive,
  systemText,
  toolNames,
  toolResultText,
  userText,
  TEST_TIMEOUT_MS,
  CLI_PATH,
} from "./helpers/e2e-live.js";
import { waitUntil } from "./helpers/async.js";
import { createMcpProcessFixture, processIsAlive, type McpProcessFixture } from "./helpers/mcp-process.js";

/**
 * E2E — MCP stdio support: the two headline claims of the feature, proven on
 * the wire against the real Pi CLI + mock model (see test/helpers/e2e-live.ts).
 *
 * 1. Zero-context guarantee: with MCP configured but NOTHING enabled, no
 *    request the model receives carries any `mcp__*` tool definition and the
 *    system prompt is identical to a no-MCP baseline.
 * 2. Round-trip + death: an enabled stdio server's tool is advertised on the
 *    first request (the first-turn settle barrier in src/index.ts — a
 *    contract, not a race),
 *    the model calls it, the real result rides the next request's tool
 *    message, and the server process dies with the session.
 *
 * NORMALIZATION CONTRACT (scenario 1, fixed here — not tuned during debugging):
 * two runs use distinct temp dirs, so raw byte-equality of the system prompt
 * cannot hold. Path-tokenized equality is the honest claim. `normalizeFor(root)`
 *   (a) replaces the run's own fixture root path — both slash forms — with a
 *       token, and
 *   (b) replaces the random mkdtemp suffix of every harness/session temp dir
 *       (`pcd-fixture-*`, `pcd-claude-user-*`, `pcd-piagent-*`, `picc-scratch-*`)
 *       with a fixed token. The prefixes before those suffixes are identical
 *       across the two runs, so (b) also covers every DERIVED form of a per-run
 *       path — the flattened auto-memory project path (slashes mangled to `-`,
 *       which (a) cannot match) and any short-path/realpath prefix variants.
 * No date line is emitted into the prompt (verified against src/), so no date
 * token is needed.
 *
 * The Layer-2 half of the zero-context guarantee (zero FakePi registrations +
 * prompt suffix identical modulo the session scratch-dir token) already lives
 * in test/mcp-registration.test.ts ("MCP zero-enabled path (wired)") —
 * deliberately not duplicated here.
 */

const { startPi, runPi, cleanup } = createE2ELive();
afterEach(cleanup);

/** Fixture-server entry for a `.mcp.json` / settings `mcpServers` map. */
function serverEntry(
  fixture: McpProcessFixture,
  mode = "serve",
): Record<string, unknown> {
  return {
    command: fixture.nodeCommand,
    args: [fixture.serverScript, mode],
    env: fixture.env,
  };
}

function normalizeFor(fixtureRoot: string): (text: string) => string {
  return (text: string) => {
    let out = text;
    for (const variant of [fixtureRoot, fixtureRoot.replace(/\\/g, "/")]) {
      out = out.split(variant).join("«FIXTURE-ROOT»");
    }
    // mkdtemp suffixes are exactly 6 chars; bounding the token keeps adjacent
    // alphanumeric leak text from being swallowed into it.
    return out.replace(
      /(pcd-fixture|pcd-claude-user|pcd-piagent|picc-scratch)-[A-Za-z0-9]{6}/g,
      "$1-X",
    );
  };
}

describe.skipIf(cliMissing)("e2e MCP: real Pi CLI + PiCC extension + mock OpenAI model", () => {
  if (cliMissing) {
    // eslint-disable-next-line no-console
    console.warn(
      `Skipping live e2e tests: Pi CLI not found at ${CLI_PATH} — run npm install first.`,
    );
  }

  it(
    "zero-context guarantee: unapproved MCP config changes neither the advertised tools nor the system prompt",
    async () => {
      // Run A — baseline: plain hello-claude fixture, no MCP config anywhere.
      const runA = await runPi({ script: [{ text: "hello" }], prompt: "say hello" });

      // Run B — same fixture plus BOTH project-scope MCP sources (.mcp.json and
      // `mcpServers` in the repo-committed .claude/settings.json), nothing
      // enabled or approved. NOT settings.local.json: an untracked local-scope
      // `mcpServers` is enabled-by-default and would silently start a server.
      let barrier: McpProcessFixture | undefined;
      try {
        const runB = await runPi({
          script: [{ text: "hello" }],
          prompt: "say hello",
          setup(dir) {
            barrier = createMcpProcessFixture(dir);
            fs.writeFileSync(
              path.join(dir, ".mcp.json"),
              JSON.stringify({ mcpServers: { fixture: serverEntry(barrier) } }, null, 2),
            );
            const settingsPath = path.join(dir, ".claude", "settings.json");
            const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<
              string,
              unknown
            >;
            settings.mcpServers = { "settings-origin": serverEntry(barrier) };
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          },
        });

        expect(runA.code).toBe(0);
        expect(runB.code).toBe(0);
        expect(runA.requests.length).toBeGreaterThanOrEqual(1);
        expect(runB.requests.length).toBeGreaterThanOrEqual(1);

        // No request in EITHER run may advertise any mcp__* tool.
        for (const [label, run] of [["baseline", runA], ["unapproved", runB]] as const) {
          for (const request of run.requests) {
            const mcpTools = toolNames(request).filter((name) => name?.startsWith("mcp__"));
            expect(mcpTools, `${label} run must advertise no mcp__* tool`).toEqual([]);
          }
        }

        // Path-tokenized system-prompt equality (see the contract in the header).
        expect(normalizeFor(runB.fixture)(systemText(runB.requests[0]!))).toBe(
          normalizeFor(runA.fixture)(systemText(runA.requests[0]!)),
        );

        // "No MCP-related context of any kind": the ENTIRE first request —
        // every message of every role, not just the system prompt — is
        // identical modulo the path tokens.
        expect(normalizeFor(runB.fixture)(allText(runB.requests[0]!))).toBe(
          normalizeFor(runA.fixture)(allText(runA.requests[0]!)),
        );

        // The pending server truly never started: the fixture server publishes
        // its pid into the barrier dir on spawn, and no marker ever appeared.
        expect(barrier!.publishedPids(), "pending MCP server must never start").toEqual([]);
      } finally {
        await barrier?.cleanup();
      }
    },
    TEST_TIMEOUT_MS * 2,
  );

  it(
    "one-shot text /mcp waits for settled status without a provider request",
    async () => {
      let barrier: McpProcessFixture | undefined;
      try {
        const result = await runPi({
          script: [],
          prompt: "/mcp",
          setup(dir) {
            barrier = createMcpProcessFixture(dir);
            fs.writeFileSync(
              path.join(dir, ".mcp.json"),
              JSON.stringify({ mcpServers: { fixture: serverEntry(barrier) } }, null, 2),
            );
            fs.writeFileSync(
              path.join(dir, ".claude", "settings.local.json"),
              JSON.stringify({ enabledMcpjsonServers: ["fixture"] }, null, 2),
            );
          },
        });

        expect(result.code).toBe(0);
        expect(result.requests).toEqual([]);
        expect(result.stdout).toContain('"fixture": connected (3 tools)');
      } finally {
        await barrier?.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "holds first-input JSON prompt discovery before sending only the transformed prompt result",
    async () => {
      const required = "FIRST-ARG-7421";
      const optional = "SECOND-ARG-9365";
      const rawCommand = `/mcp__fixture__fixture-prompt ${required} ${optional}`;
      let barrier: McpProcessFixture | undefined;
      let started: Awaited<ReturnType<typeof startPi>> | undefined;
      try {
        started = await startPi({
          script: [{ text: "PROMPT-DONE" }],
          prompt: "unused",
          modeArgs: ["--mode", "json", "-p", rawCommand],
          setup(dir) {
            barrier = createMcpProcessFixture(dir);
            fs.writeFileSync(
              path.join(dir, ".mcp.json"),
              JSON.stringify({
                mcpServers: {
                  fixture: serverEntry(barrier, "gated-prompt-discovery"),
                },
              }, null, 2),
            );
            fs.writeFileSync(
              path.join(dir, ".claude", "settings.local.json"),
              JSON.stringify({ enabledMcpjsonServers: ["fixture"] }, null, 2),
            );
          },
        });

        await Promise.race([
          barrier!.waitFor(
            ["prompt-discovery.entered"],
            "initial MCP prompt discovery to hold the first typed input",
            20_000,
          ),
          started.completion.then((result) => {
            throw new Error(
              `Pi exited before gated prompt discovery: code=${result.code}; stderr=${result.stderr}; stdout=${result.stdout}`,
            );
          }),
        ]);
        expect(started.requests).toEqual([]);

        barrier!.release("prompt-discovery");
        const firstRequest = await started.waitForRequest(undefined, 1);
        const transformed = userText(firstRequest);
        expect(transformed).toContain(required);
        expect(transformed).toContain(optional);
        expect(transformed).not.toContain(rawCommand);
        expect(allText(firstRequest)).not.toContain("/mcp__fixture__fixture-prompt");
        expect(toolNames(firstRequest)).not.toContain("ListMcpResourcesTool");
        expect(toolNames(firstRequest)).not.toContain("ReadMcpResourceTool");

        const result = await started.completion;
        expect(result.code, result.stderr).toBe(0);
        expect(result.requests).toHaveLength(1);
        expect(barrier!.exists("prompt-discovery.done")).toBe(true);
      } finally {
        barrier?.release("prompt-discovery");
        await started?.stop().catch(() => undefined);
        await barrier?.cleanup("prompt-discovery");
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "round-trips one approved MCP tool through JSON, rebuilt persistence, and process death",
    async () => {
      const marker = "JSON-MCP-ROUNDTRIP-9137";
      let barrier: McpProcessFixture | undefined;
      try {
        const result = await runPi({
          persistSession: true,
          modeArgs: ["--mode", "json", "-p", "run the JSON MCP round trip"],
          script: [
            { toolCalls: [{ name: "mcp__fixture__echo", args: { text: marker } }] },
            { text: "JSON-MCP-DONE" },
          ],
          prompt: "unused",
          // An ambient MCP_TIMEOUT must not shrink the first-turn settle barrier.
          extraEnv: { MCP_TIMEOUT: "30000" },
          setup(dir) {
            barrier = createMcpProcessFixture(dir);
            fs.writeFileSync(
              path.join(dir, ".mcp.json"),
              JSON.stringify({ mcpServers: { fixture: serverEntry(barrier) } }, null, 2),
            );
            // setup runs after the fixture commit, so this untracked local scope may self-approve.
            fs.writeFileSync(
              path.join(dir, ".claude", "settings.local.json"),
              JSON.stringify({ enabledMcpjsonServers: ["fixture"] }, null, 2),
            );
          },
        });

        expect(result.code, result.stderr).toBe(0);
        expect(toolNames(result.requests[0]!)).toContain("mcp__fixture__echo");
        expect(toolResultText(result.requests[1]!)).toContain(marker);
        expect(JSON.stringify(result.requests)).toContain(marker);
        const records = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as any);
        const assistantCalls = records.filter((record) => record.type === "message_end" &&
          record.message?.role === "assistant" && record.message.content?.some(
            (block: any) => block.type === "toolCall" && block.name === "mcp__fixture__echo",
          ));
        const toolResults = records.filter((record) => record.type === "message_end" &&
          record.message?.role === "toolResult" && record.message.toolName === "mcp__fixture__echo");
        expect(assistantCalls).toHaveLength(1);
        expect(toolResults).toHaveLength(1);
        const jsonCall = assistantCalls[0]!.message.content.find(
          (block: any) => block.type === "toolCall" && block.name === "mcp__fixture__echo",
        );
        expect(jsonCall).toMatchObject({
          id: expect.any(String),
          name: "mcp__fixture__echo",
          arguments: { text: marker },
        });
        expect(toolResults[0]!.message).toMatchObject({
          toolCallId: jsonCall.id,
          toolName: "mcp__fixture__echo",
          content: [{ type: "text", text: marker }],
          isError: false,
        });
        expect(JSON.stringify(records)).not.toContain("echo (fixture MCP)");
        expect(JSON.stringify(result.requests)).not.toContain("echo (fixture MCP)");

        const sessionFiles: string[] = [];
        const walk = (dir: string): void => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".jsonl") && !full.includes(".subagents")) sessionFiles.push(full);
          }
        };
        walk(path.join(result.agentDir, "sessions"));
        expect(sessionFiles).toHaveLength(1);
        const manager = SessionManager.open(sessionFiles[0]!);
        const entries = manager.getEntries() as any[];
        const rebuiltMessages = manager.buildSessionContext().messages as any[];
        const rebuiltAssistantCalls = rebuiltMessages.filter((message) => message.role === "assistant" &&
          message.content?.some((block: any) => block.type === "toolCall" &&
            block.name === "mcp__fixture__echo"));
        expect(rebuiltAssistantCalls).toHaveLength(1);
        const rebuiltCall = rebuiltAssistantCalls[0]!.content.find(
          (block: any) => block.type === "toolCall" && block.name === "mcp__fixture__echo",
        );
        expect(rebuiltCall).toMatchObject({
          id: expect.any(String),
          name: "mcp__fixture__echo",
          arguments: { text: marker },
        });
        const persistedToolResults = rebuiltMessages.filter((message) => message.role === "toolResult" &&
          message.toolName === "mcp__fixture__echo");
        expect(persistedToolResults).toHaveLength(1);
        expect(persistedToolResults[0]).toMatchObject({
          toolCallId: rebuiltCall.id,
          toolName: "mcp__fixture__echo",
          content: [{ type: "text", text: marker }],
          isError: false,
        });
        expect(rebuiltCall.id).toBe(jsonCall.id);
        expect(JSON.stringify(entries)).not.toContain("echo (fixture MCP)");

        expect(barrier!.exists("serve.pid"), "server must have published its pid").toBe(true);
        const pid = barrier!.pidOf("serve.pid");
        await waitUntil({
          description: `JSON MCP fixture server (pid ${pid}) to die with the session`,
          predicate: () => !processIsAlive(pid),
          describeObserved: () => `pid ${pid} alive=${processIsAlive(pid)}`,
          timeoutMs: 10_000,
        });
      } finally {
        await barrier?.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

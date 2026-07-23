import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpRuntime, type McpRuntimeDeps } from "../src/runtime/mcp.js";
import { renderMcpStatusReport } from "../src/registry/compat-report.js";
import type { ResolvedMcpConfig, ResolvedMcpServer } from "../src/types.js";
import { waitUntil } from "./helpers/async.js";
import { createMcpProcessFixture, processIsAlive } from "./helpers/mcp-process.js";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcx-mcp-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeServer(over: Partial<ResolvedMcpServer> & { name: string }): ResolvedMcpServer {
  return {
    status: "enabled",
    source: ".mcp.json",
    command: process.execPath,
    args: [],
    env: {},
    rawCommand: "node",
    diagnostics: [],
    ...over,
  };
}

function makeConfig(...servers: ResolvedMcpServer[]): ResolvedMcpConfig {
  return { servers, diagnostics: [] };
}

/**
 * process.env minus the MCP knobs: an ambient MCP_TIMEOUT/MCP_TOOL_TIMEOUT in
 * the developer's shell must not steer any row — rows that need them set them
 * explicitly.
 */
function cleanBaseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["MCP_TIMEOUT"];
  delete env["MCP_TOOL_TIMEOUT"];
  return env;
}

/** Deps with a clean process.env base; extras override (setting a key to undefined removes it). */
function makeDeps(over: Partial<McpRuntimeDeps> = {}): McpRuntimeDeps {
  return {
    projectRoot: makeTempDir(),
    sessionId: "mcp-test-session",
    env: cleanBaseEnv(),
    ...over,
  };
}

/** First text content block of a callTool result. */
function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const block = content?.find((c) => c.type === "text");
  return block?.text ?? "";
}

async function waitForDeath(pid: number, what: string): Promise<void> {
  await waitUntil({
    description: `${what} (pid ${pid}) to die`,
    predicate: () => !processIsAlive(pid),
    describeObserved: () => `pid ${pid} alive=${processIsAlive(pid)}`,
    timeoutMs: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Zero-cost path
// ---------------------------------------------------------------------------

describe("McpRuntime zero-enabled path", () => {
  it("spawns nothing and settles immediately when no server is enabled", async () => {
    const config = makeConfig(
      makeServer({ name: "pending", status: "pending-approval" }),
      makeServer({ name: "off", status: "disabled" }),
      makeServer({ name: "broken", status: "skipped" }),
    );
    const runtime = McpRuntime.start(config, makeDeps());
    expect(runtime.tools()).toEqual([]);
    expect(runtime.serverStates()).toEqual([]);
    expect(runtime.diagnostics()).toEqual([]);
    await runtime.whenSettled();
    await expect(runtime.callTool("pending", "anything", {})).rejects.toThrow(/not configured or not enabled/);
    await runtime.shutdown();
  });

  it("resolves the connect-timeout default to 30 000 ms with MCP_TIMEOUT unset", async () => {
    // Zero enabled servers: the resolved bound is observable with no spawn.
    const runtime = McpRuntime.start(makeConfig(), makeDeps());
    expect(runtime.resolvedConnectTimeoutMs).toBe(30_000);
    await runtime.shutdown();
  });

  it("returns [] from tools() immediately after start with a never-connecting server, and shutdown settles it", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    // Default MCP_TIMEOUT (30 s): what settles this test is shutdown(), not the
    // connect bound — pinning the non-blocking start contract.
    const config = makeConfig(
      makeServer({
        name: "hang",
        args: [fixture.serverScript, "hang-initialize", "ARG_CANARY"],
        env: { ...fixture.env, TOKEN: "ENV_CANARY" },
        rawCommand: "SHUTDOWN_RAW_COMMAND_CANARY",
      }),
    );
    const runtime = McpRuntime.start(config, makeDeps());
    try {
      expect(runtime.tools()).toEqual([]);
      expect(runtime.serverStates()).toEqual([
        { name: "hang", state: "connecting" },
      ]);
      await fixture.waitFor(["hang-initialize.pid"], "hanging server to spawn");
      const pid = fixture.pidOf("hang-initialize.pid");
      await runtime.shutdown();
      await runtime.whenSettled();
      await waitForDeath(pid, "hanging server after shutdown");
      expect(runtime.serverStates()[0]).toMatchObject({
        state: "failed",
        statusSummary: "Connection stopped because the session shut down.",
      });
      const report = renderMcpStatusReport(config, runtime.serverStates());
      for (const canary of [
        "hang-initialize",
        "ARG_CANARY",
        "ENV_CANARY",
        "SHUTDOWN_RAW_COMMAND_CANARY",
      ]) {
        expect(report).not.toContain(canary);
      }
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("McpRuntime stdio lifecycle", () => {
  it("connects, lists tools, round-trips a call, and kills the server on shutdown", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const exitListenerBaseline = process.listenerCount("exit");
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "fixture", args: [fixture.serverScript, "serve"], env: fixture.env }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      // Exit-sweep listener discipline: exactly one listener while running.
      expect(process.listenerCount("exit")).toBe(exitListenerBaseline + 1);
      expect(runtime.serverStates()).toEqual([
        { name: "fixture", state: "connected", toolCount: 3 },
      ]);
      const tools = runtime.tools();
      expect(tools.map((t) => t.toolName).sort()).toEqual(["big-output", "echo", "report-env"]);
      expect(tools.every((t) => t.serverName === "fixture")).toBe(true);
      const echo = tools.find((t) => t.toolName === "echo")!;
      expect(echo.description).toBe("echoes text back");
      expect(echo.inputSchema).toMatchObject({ type: "object" });

      const result = await runtime.callTool("fixture", "echo", { text: "round-trip" });
      expect(firstText(result)).toBe("round-trip");

      const big = await runtime.callTool("fixture", "big-output", { bytes: 100_000 });
      expect(firstText(big)).toHaveLength(100_000);

      const pid = fixture.pidOf("serve.pid");
      expect(processIsAlive(pid)).toBe(true);
      await runtime.shutdown();
      // ...and back to baseline after shutdown.
      expect(process.listenerCount("exit")).toBe(exitListenerBaseline);
      await waitForDeath(pid, "served fixture after shutdown");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it("rejects callTool for unknown servers and unknown tools with descriptive errors", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "fixture", args: [fixture.serverScript, "serve"], env: fixture.env }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      await expect(runtime.callTool("nope", "echo", {})).rejects.toThrow(
        /server "nope" is not running/,
      );
      await expect(runtime.callTool("fixture", "no-such-tool", {})).rejects.toThrow(
        /has no tool "no-such-tool"/,
      );
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it("composes config env over the injected Claude vars over inherited env, unicode-safe", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const projectRoot = makeTempDir();
    const base: Record<string, string | undefined> = { ...cleanBaseEnv(), MCP_FIXTURE_VAR: "from-base" };
    // Prove unicodeSafeSubprocessEnv participates: the default only applies
    // when the base does not already set it.
    delete base["PYTHONIOENCODING"];
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({
          name: "fixture",
          args: [fixture.serverScript, "serve"],
          env: {
            ...fixture.env,
            MCP_FIXTURE_VAR: "from-config",
            // Claude parity (binary-verified 2.1.218): config `env` is spread
            // LAST — it wins even over the injected Claude vars.
            CLAUDECODE: "0",
            CLAUDE_PROJECT_DIR: "/config-wins",
          },
        }),
      ),
      makeDeps({ projectRoot, sessionId: "env-proof-session", env: base }),
    );
    try {
      await runtime.whenSettled();
      const names = [
        "CLAUDE_PROJECT_DIR",
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "MCP_FIXTURE_VAR",
        "PYTHONIOENCODING",
      ];
      const result = await runtime.callTool("fixture", "report-env", { names });
      const reported = JSON.parse(firstText(result)) as Record<string, string | null>;
      expect(reported).toEqual({
        CLAUDE_PROJECT_DIR: "/config-wins",
        CLAUDECODE: "0",
        // Not set in config env, so the injected value survives.
        CLAUDE_CODE_SESSION_ID: "env-proof-session",
        MCP_FIXTURE_VAR: "from-config",
        PYTHONIOENCODING: "utf-8",
      });
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it.skipIf(process.platform !== "win32")(
    "spawns a .cmd shim without shell:true (cross-spawn behavior pinned)",
    async () => {
      const fixture = createMcpProcessFixture(makeTempDir());
      const shimDir = makeTempDir();
      const shim = path.join(shimDir, "serve-shim.cmd");
      fs.writeFileSync(
        shim,
        `@echo off\r\n"${process.execPath}" "${fixture.serverScript}" serve\r\n`,
      );
      const runtime = McpRuntime.start(
        makeConfig(
          makeServer({ name: "shim", command: shim, args: [], env: fixture.env, rawCommand: "serve-shim.cmd" }),
        ),
        makeDeps(),
      );
      try {
        await runtime.whenSettled();
        expect(runtime.serverStates()).toEqual([{ name: "shim", state: "connected", toolCount: 3 }]);
        const result = await runtime.callTool("shim", "echo", { text: "via cmd shim" });
        expect(firstText(result)).toBe("via cmd shim");
      } finally {
        await runtime.shutdown();
        await fixture.cleanup();
      }
    },
    25_000,
  );
});

// ---------------------------------------------------------------------------
// Degrade paths
// ---------------------------------------------------------------------------

describe("McpRuntime degrade paths", () => {
  it("publishes an independent safe summary when the optional SDK fails to load", async () => {
    const config = makeConfig(
      makeServer({
        name: "sdk-failure",
        command: "C:/EXPANDED_PATH_CANARY/server.exe",
        args: ["ARG_CANARY"],
        env: { TOKEN: "ENV_CANARY" },
        rawCommand: "RAW_COMMAND_CANARY",
      }),
    );
    const runtime = McpRuntime.start(
      config,
      makeDeps({
        loadSdk: async () => {
          throw new Error("EXCEPTION_CANARY C:/PRIVATE_PATH_CANARY");
        },
      }),
    );
    try {
      await runtime.whenSettled();
      const state = runtime.serverStates()[0];
      expect(state?.statusSummary).toBe(
        "MCP support is unavailable because its SDK could not be loaded.",
      );
      expect(state?.diagnostic).toContain("sdk failed to load (Error)");
      const report = renderMcpStatusReport(config, runtime.serverStates());
      expect(report).toContain(state!.statusSummary!);
      for (const canary of [
        "EXPANDED_PATH_CANARY",
        "ARG_CANARY",
        "ENV_CANARY",
        "RAW_COMMAND_CANARY",
        "EXCEPTION_CANARY",
        "PRIVATE_PATH_CANARY",
      ]) {
        expect(report).not.toContain(canary);
        expect(state?.statusSummary).not.toContain(canary);
      }
    } finally {
      await runtime.shutdown();
    }
  });

  it("reports a safe umbrella failure when tool discovery rejects after initialization", async () => {
    let initialized = false;
    let discoveryAttempted = false;
    class FakeTransport {
      readonly pid = undefined;
      readonly stderr = undefined;
      constructor(_options: unknown) {}
    }
    class RejectingDiscoveryClient {
      constructor(_clientInfo: unknown, _options: unknown) {}
      async connect(_transport: unknown): Promise<void> {
        initialized = true;
      }
      async listTools(_params: unknown): Promise<never> {
        discoveryAttempted = true;
        throw new Error("LIST_TOOLS_EXCEPTION_CANARY C:/PRIVATE_DISCOVERY_PATH");
      }
      async close(): Promise<void> {}
    }
    const config = makeConfig(
      makeServer({ name: "discovery-reject", rawCommand: "DISCOVERY_RAW_COMMAND_CANARY" }),
    );
    const runtime = McpRuntime.start(
      config,
      makeDeps({
        loadSdk: async () =>
          ({
            Client: RejectingDiscoveryClient,
            StdioClientTransport: FakeTransport,
          }) as unknown as Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>>,
      }),
    );
    try {
      await runtime.whenSettled();
      expect(initialized).toBe(true);
      expect(discoveryAttempted).toBe(true);
      const state = runtime.serverStates()[0];
      expect(state).toMatchObject({
        state: "failed",
        statusSummary:
          "MCP startup failed during connection, initialization, or tool discovery; run /doctor for details.",
      });
      const report = renderMcpStatusReport(config, runtime.serverStates());
      expect(report).toContain(state!.statusSummary!);
      expect(report).not.toContain("LIST_TOOLS_EXCEPTION_CANARY");
      expect(report).not.toContain("PRIVATE_DISCOVERY_PATH");
      expect(report).not.toContain("DISCOVERY_RAW_COMMAND_CANARY");
    } finally {
      await runtime.shutdown();
    }
  });

  it("reports a safe umbrella timeout when tool discovery does not settle after initialization", async () => {
    let initialized = false;
    let discoveryAttempted = false;
    let closed = false;
    class FakeTransport {
      readonly pid = undefined;
      readonly stderr = undefined;
      constructor(_options: unknown) {}
    }
    class HangingDiscoveryClient {
      constructor(_clientInfo: unknown, _options: unknown) {}
      async connect(_transport: unknown): Promise<void> {
        initialized = true;
      }
      listTools(_params: unknown): Promise<never> {
        discoveryAttempted = true;
        return new Promise<never>(() => {});
      }
      async close(): Promise<void> {
        closed = true;
      }
    }
    const config = makeConfig(
      makeServer({ name: "discovery-timeout", rawCommand: "DISCOVERY_TIMEOUT_RAW_CANARY" }),
    );
    const runtime = McpRuntime.start(
      config,
      makeDeps({
        env: { ...cleanBaseEnv(), MCP_TIMEOUT: "20" },
        loadSdk: async () =>
          ({
            Client: HangingDiscoveryClient,
            StdioClientTransport: FakeTransport,
          }) as unknown as Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>>,
      }),
    );
    try {
      await runtime.whenSettled();
      expect(initialized).toBe(true);
      expect(discoveryAttempted).toBe(true);
      expect(closed).toBe(true);
      const state = runtime.serverStates()[0];
      expect(state).toMatchObject({
        state: "failed",
        statusSummary:
          "MCP startup timed out during connection, initialization, or tool discovery after 20 ms; run /doctor for details.",
      });
      const report = renderMcpStatusReport(config, runtime.serverStates());
      expect(report).toContain(state!.statusSummary!);
      expect(report).not.toContain("DISCOVERY_TIMEOUT_RAW_CANARY");
    } finally {
      await runtime.shutdown();
    }
  });

  it("times out a hung initialize, kills its tree, and leaves other servers unaffected", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "hung", args: [fixture.serverScript, "hang-initialize"], env: fixture.env, rawCommand: "hang-cmd" }),
        makeServer({ name: "healthy", args: [fixture.serverScript, "serve"], env: fixture.env }),
      ),
      // MCP_TIMEOUT is runtime-global, so it also bounds the HEALTHY server's
      // connect: under full-suite fork contention a fixture spawn (node + SDK
      // import) can take seconds, so the bound must be load-tolerant. The
      // assertions stay result-based — nothing here measures elapsed time.
      makeDeps({ env: { ...cleanBaseEnv(), MCP_TIMEOUT: "8000" } }),
    );
    try {
      await runtime.whenSettled();
      const states = new Map(runtime.serverStates().map((s) => [s.name, s]));
      expect(states.get("healthy")).toMatchObject({ state: "connected", toolCount: 3 });
      expect(states.get("hung")).toMatchObject({ state: "failed" });
      expect(states.get("hung")?.diagnostic).toMatch(/failed to connect within 8000 ms/);
      expect(states.get("hung")?.diagnostic).toContain("hang-cmd");
      expect(states.get("hung")?.statusSummary).toBe(
        "MCP startup timed out during connection, initialization, or tool discovery after 8000 ms; run /doctor for details.",
      );
      const status = renderMcpStatusReport(
        makeConfig(makeServer({ name: "hung", rawCommand: "hang-cmd" })),
        runtime.serverStates(),
      );
      expect(status).toContain(
        "MCP startup timed out during connection, initialization, or tool discovery after 8000 ms; run /doctor for details.",
      );
      expect(status).not.toContain("hang-cmd");
      expect(runtime.diagnostics().some((d) => d.includes('"hung"'))).toBe(true);
      // Only the healthy server's tools are exposed.
      expect(runtime.tools().every((t) => t.serverName === "healthy")).toBe(true);
      expect(runtime.tools()).toHaveLength(3);
      // The hung server's tree was killed at timeout, before shutdown.
      const hungPid = fixture.pidOf("hang-initialize.pid");
      await waitForDeath(hungPid, "hung server after connect timeout");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it("degrades an exiting-early server to failed without throwing", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "quitter", args: [fixture.serverScript, "exit-early"], env: fixture.env, rawCommand: "quitter-cmd" }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({
          name: "quitter",
          state: "failed",
          statusSummary:
            "MCP startup failed during connection, initialization, or tool discovery; run /doctor for details.",
        }),
      ]);
      expect(runtime.diagnostics().join("\n")).toContain('"quitter"');
      expect(runtime.tools()).toEqual([]);
      await expect(runtime.callTool("quitter", "echo", {})).rejects.toThrow(/not connected/);
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it("degrades a garbage-stdout server via the connect bound and kills it", async () => {
    const dir = makeTempDir();
    const pidFile = path.join(dir, "garbage.pid");
    const script = path.join(dir, "garbage-server.mjs");
    // Deliberately SDK-free broken server: publishes its pid, floods stderr
    // (>4 KB, tail marker last) to prove the diagnostic excerpt stays a
    // bounded tail, then floods stdout with non-JSON-RPC noise and stays
    // alive.
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        'process.stderr.write("y".repeat(5000));',
        'process.stderr.write("\\nGARBAGE_STDERR_TAIL_MARKER\\n");',
        'setInterval(() => process.stdout.write("this is not JSON-RPC\\n"), 20);',
      ].join("\n"),
    );
    const runtime = McpRuntime.start(
      makeConfig(makeServer({ name: "garbage", args: [script], rawCommand: "garbage-cmd" })),
      // Load-tolerant bound: the child must get to write its pid file before
      // the runtime's timeout kill lands, even on a contended runner.
      makeDeps({ env: { ...cleanBaseEnv(), MCP_TIMEOUT: "4000" } }),
    );
    let pid: number | undefined;
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({ name: "garbage", state: "failed" }),
      ]);
      expect(runtime.tools()).toEqual([]);
      // The stderr excerpt is the RING'S TAIL, bounded: the marker (written
      // last) is present, the 5 KB flood is not, and the whole diagnostic
      // stays small.
      const diagnostic = runtime.serverStates()[0]?.diagnostic ?? "";
      expect(diagnostic).toContain("GARBAGE_STDERR_TAIL_MARKER");
      // The fixture's stderr is multi-line (flood\nmarker\n); the excerpt must
      // stay ONE line — /doctor's posture line and the stderr drain splice it
      // into a sentence.
      expect(diagnostic).not.toMatch(/[\n\r\t]/);
      expect(diagnostic).not.toContain("y".repeat(500));
      expect(diagnostic.length).toBeLessThanOrEqual(700);
      expect(runtime.serverStates()[0]?.statusSummary).toBe(
        "MCP startup timed out during connection, initialization, or tool discovery after 4000 ms; run /doctor for details.",
      );
      expect(renderMcpStatusReport(makeConfig(makeServer({ name: "garbage" })), runtime.serverStates()))
        .not.toContain("GARBAGE_STDERR_TAIL_MARKER");
      pid = Number(fs.readFileSync(pidFile, "utf8"));
      await waitForDeath(pid, "garbage server after connect timeout");
    } finally {
      await runtime.shutdown();
      if (pid !== undefined && processIsAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 25_000);

  it("never leaks expanded command values into diagnostics", async () => {
    const dir = makeTempDir();
    // Simulates a `${VAR}`-expanded command whose value must never surface:
    // the EXPANDED path (with the secret) does not exist, so spawn fails and
    // Node's err.message would embed it.
    const expandedSecret = path.join(dir, "picc-secret-expanded-value", "missing-server.exe");
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "leaky", command: expandedSecret, rawCommand: "${MCP_SERVER_BIN}" }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({ name: "leaky", state: "failed" }),
      ]);
      const all = runtime.diagnostics().join("\n");
      expect(all).toContain('"leaky"');
      expect(all).toContain("${MCP_SERVER_BIN}");
      expect(all).not.toContain("picc-secret-expanded-value");
      const state = runtime.serverStates()[0];
      expect(state?.diagnostic ?? "").not.toContain("picc-secret-expanded-value");
      expect(state?.statusSummary).toBe(
        "MCP startup failed during connection, initialization, or tool discovery; run /doctor for details.",
      );
      const report = renderMcpStatusReport(
        makeConfig(makeServer({ name: "leaky", command: expandedSecret })),
        runtime.serverStates(),
      );
      expect(report).not.toContain("picc-secret-expanded-value");
      expect(report).not.toContain("${MCP_SERVER_BIN}");
    } finally {
      await runtime.shutdown();
    }
  }, 25_000);

  it("sanitizes tool names Claude-style, dedupes first-wins, and bounds descriptions and diagnostics", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "hostile", args: [fixture.serverScript, "hostile-tools"], env: fixture.env }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        { name: "hostile", state: "connected", toolCount: 8 },
      ]);
      const tools = runtime.tools();
      const names = tools.map((t) => t.toolName);
      // Claude parity (binary-verified 2.1.218): characters outside
      // [A-Za-z0-9_-] become "_" and the tool is KEPT — deny-rule-compatible
      // naming without drops.
      expect(names).toContain("dot_name"); // dot.name sanitized
      expect(names).toContain("white_space"); // space sanitized
      expect(names).toContain("star_name"); // glob char sanitized
      expect(names).toContain("ctrl_name"); // control char sanitized
      expect(names).toContain(`long${"_".repeat(300)}`); // long hostile name sanitized, kept
      // "_" is itself a legal character, so "__" survives verbatim (as in Claude).
      expect(names).toContain("bad__tool");
      // Empty-after-sanitize is the only drop.
      expect(names).toHaveLength(8);
      // First definition wins on duplicates — including the post-sanitize
      // collision: literal "dot_name" arrived after sanitized "dot.name".
      expect(tools.find((t) => t.toolName === "good")?.description).toBe("first");
      expect(tools.find((t) => t.toolName === "dot_name")?.description).toBe("dotted");
      // Description bounded (2 KB + Claude's exact truncation suffix) and
      // escape-stripped.
      const verbose = tools.find((t) => t.toolName === "verbose")!;
      expect(verbose.description.endsWith("… [truncated]")).toBe(true);
      expect(verbose.description.length).toBeLessThanOrEqual(2_048 + "… [truncated]".length);
      expect(verbose.description).not.toContain("\u001b");
      const all = runtime.diagnostics();
      const joined = all.join("\n");
      expect(joined).toContain("dot.name");
      expect(joined).toContain("white space");
      expect(joined).toMatch(/duplicate tool name "good"/);
      expect(joined).toMatch(/duplicate tool name "dot_name"/);
      // Diagnostics quote BOUNDED name slices (200 chars each; the sanitize
      // line quotes the raw AND sanitized form): the 304-char hostile name
      // never appears in full, and no diagnostic line grows unbounded.
      expect(joined).not.toContain("*".repeat(250));
      for (const line of all) expect(line.length).toBeLessThanOrEqual(600);
      // Per-server diagnostic cap: after 5, the rest collapse into a summary.
      expect(joined).toContain("and 3 more");
      expect(joined).not.toContain("star*name");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);
});

// ---------------------------------------------------------------------------
// Tool-call timeouts
// ---------------------------------------------------------------------------

describe("McpRuntime tool-call timeouts", () => {
  it("rejects a slow call at the per-server timeout (which beats MCP_TOOL_TIMEOUT) without a result", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({
          name: "slowpoke",
          args: [fixture.serverScript, "slow-tool"],
          env: fixture.env,
          timeoutMs: 1_000,
        }),
      ),
      // A large MCP_TOOL_TIMEOUT that would exceed the test window: the call
      // rejecting at all (with the gate still closed) proves the per-server
      // value won — no wall-clock assertion needed.
      makeDeps({ env: { ...cleanBaseEnv(), MCP_TOOL_TIMEOUT: "600000" } }),
    );
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        { name: "slowpoke", state: "connected", toolCount: 1 },
      ]);
      const call = runtime.callTool("slowpoke", "slow", {});
      await fixture.waitFor(["slow.entered"], "slow tool to enter before timeout");
      await expect(call).rejects.toThrow(/timed out after 1000 ms/);
      // The rejection was timeout-driven, not result-driven: the handler is
      // still gated, so no result marker can exist yet.
      expect(fixture.exists("slow.done")).toBe(false);
      fixture.release("slow");
      await fixture.waitFor(["slow.done"], "slow tool to finish after release");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup("slow");
    }
  }, 25_000);

  it("bounds a slow call by MCP_TOOL_TIMEOUT alone when no per-server timeout is set", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "slowpoke", args: [fixture.serverScript, "slow-tool"], env: fixture.env }),
      ),
      // The middle branch of the timeout resolution: no per-server timeoutMs,
      // MCP_TOOL_TIMEOUT alone must bound the call (gate-based proof, no
      // wall-clock assertion).
      makeDeps({ env: { ...cleanBaseEnv(), MCP_TOOL_TIMEOUT: "1000" } }),
    );
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        { name: "slowpoke", state: "connected", toolCount: 1 },
      ]);
      const call = runtime.callTool("slowpoke", "slow", {});
      await fixture.waitFor(["slow.entered"], "slow tool to enter before timeout");
      await expect(call).rejects.toThrow(/timed out after 1000 ms/);
      expect(fixture.exists("slow.done")).toBe(false);
      fixture.release("slow");
      await fixture.waitFor(["slow.done"], "slow tool to finish after release");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup("slow");
    }
  }, 25_000);

  it("clamps an over-max MCP_TOOL_TIMEOUT instead of letting the timer overflow", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "fixture", args: [fixture.serverScript, "serve"], env: fixture.env }),
      ),
      // > 2^31-1: unclamped this would exceed Node's TIMEOUT_MAX, overflow the
      // SDK's setTimeout, and fire at ~1 ms — instantly rejecting even a fast
      // call. The call succeeding at all proves the clamp.
      makeDeps({ env: { ...cleanBaseEnv(), MCP_TOOL_TIMEOUT: "9999999999" } }),
    );
    try {
      await runtime.whenSettled();
      const result = await runtime.callTool("fixture", "echo", { text: "clamped" });
      expect(firstText(result)).toBe("clamped");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);
});

// ---------------------------------------------------------------------------
// Kill discipline
// ---------------------------------------------------------------------------

describe("McpRuntime kill discipline", () => {
  it("kills the server AND its grandchild on shutdown (both platforms)", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "family", args: [fixture.serverScript, "spawn-grandchild"], env: fixture.env }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      expect(runtime.serverStates()).toEqual([
        { name: "family", state: "connected", toolCount: 3 },
      ]);
      await fixture.waitFor(
        ["spawn-grandchild.pid", "grandchild.pid"],
        "server and grandchild pids to publish",
      );
      const serverPid = fixture.pidOf("spawn-grandchild.pid");
      const grandchildPid = fixture.pidOf("grandchild.pid");
      expect(processIsAlive(serverPid)).toBe(true);
      expect(processIsAlive(grandchildPid)).toBe(true);
      await runtime.shutdown();
      await waitForDeath(serverPid, "grandchild-spawning server after shutdown");
      await waitForDeath(grandchildPid, "grandchild after shutdown");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it("shutdown is idempotent, safe to call twice concurrently, and truthful afterwards", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const config = makeConfig(
      makeServer({
        name: "fixture",
        args: [fixture.serverScript, "serve"],
        env: fixture.env,
        rawCommand: "CONNECTED_SHUTDOWN_RAW_CANARY",
      }),
    );
    const runtime = McpRuntime.start(config, makeDeps());
    try {
      await runtime.whenSettled();
      const pid = fixture.pidOf("serve.pid");
      await Promise.all([runtime.shutdown(), runtime.shutdown()]);
      await runtime.shutdown();
      await waitForDeath(pid, "server after repeated shutdown");
      // Post-shutdown truthfulness: a killed server must not keep reporting
      // "connected", and its tools disappear.
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({
          name: "fixture",
          state: "failed",
          diagnostic: expect.stringMatching(/shut down/),
          statusSummary: "Connection closed because the session shut down.",
        }),
      ]);
      expect(runtime.tools()).toEqual([]);
      expect(renderMcpStatusReport(config, runtime.serverStates())).not.toContain(
        "CONNECTED_SHUTDOWN_RAW_CANARY",
      );
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);

  it("a shutdown racing the SDK import prevents any spawn and restores the exit listener", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const exitListenerBaseline = process.listenerCount("exit");
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "raced", args: [fixture.serverScript, "serve"], env: fixture.env }),
      ),
      makeDeps(),
    );
    try {
      // No marker waiting: connectAll is parked at the dynamic SDK import()
      // and shutdown() lands in that window. The stopped-flag guard must keep
      // connectOne from spawning a server that would outlive the session.
      await runtime.shutdown();
      await runtime.whenSettled();
      expect(process.listenerCount("exit")).toBe(exitListenerBaseline);
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({ name: "raced", state: "failed" }),
      ]);
      // Brief observation window: a leaked spawn would publish its pid marker.
      // Any pid that does appear must die; none should appear at all.
      await new Promise((resolve) => setTimeout(resolve, 600));
      for (const pid of fixture.publishedPids()) {
        await waitForDeath(pid, "server spawned despite pre-import shutdown");
      }
      expect(fixture.publishedPids()).toEqual([]);
    } finally {
      await runtime.shutdown();
      await fixture.cleanup();
    }
  }, 25_000);
});

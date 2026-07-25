import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  McpRuntime,
  resolveMcpTimeoutPolicy,
  resolveMcpToolTimeoutMs,
  type McpRuntimeDeps,
} from "../src/runtime/mcp.js";
import { renderMcpStatusReport } from "../src/registry/compat-report.js";
import type { ResolvedMcpConfig, ResolvedMcpServer } from "../src/types.js";
import { deferred, waitUntil } from "./helpers/async.js";
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

function fakeToolSdk(options: {
  forwardedTimeouts: number[];
  callError?: unknown;
}): Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>> {
  class FakeTransport {
    readonly pid = undefined;
    readonly stderr = undefined;
    constructor(_options: unknown) {}
  }
  class FakeClient {
    constructor(_clientInfo: unknown, _options: unknown) {}
    async connect(_transport: unknown): Promise<void> {}
    async listTools(_params: unknown): Promise<{ tools: Array<{ name: string }> }> {
      return { tools: [{ name: "fake-tool" }] };
    }
    async callTool(
      _params: unknown,
      _resultSchema: unknown,
      requestOptions: { timeout: number },
    ): Promise<{ content: never[] }> {
      options.forwardedTimeouts.push(requestOptions.timeout);
      if (options.callError !== undefined) throw options.callError;
      return { content: [] };
    }
    async close(): Promise<void> {}
  }
  return {
    Client: FakeClient,
    StdioClientTransport: FakeTransport,
  } as unknown as Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>>;
}

// ---------------------------------------------------------------------------
// Timeout policy
// ---------------------------------------------------------------------------

describe("MCP timeout policy", () => {
  it("resolves connect defaults, environment values, and invalid fallbacks without timers", () => {
    expect(resolveMcpTimeoutPolicy({})).toEqual({
      connectTimeoutMs: 30_000,
      environmentToolTimeoutMs: undefined,
    });
    for (const invalid of ["", "0", "-1", "1.5", "not-a-number"]) {
      expect(resolveMcpTimeoutPolicy({ MCP_TIMEOUT: invalid }).connectTimeoutMs).toBe(30_000);
    }
    expect(resolveMcpTimeoutPolicy({ MCP_TIMEOUT: "42" }).connectTimeoutMs).toBe(42);
    expect(resolveMcpTimeoutPolicy({ MCP_TIMEOUT: "9999999999" }).connectTimeoutMs).toBe(
      2_147_483_647,
    );
  });

  it("resolves tool defaults, environment fallback, per-server precedence, and clamps", () => {
    const defaultPolicy = resolveMcpTimeoutPolicy({});
    expect(
      resolveMcpToolTimeoutMs(undefined, defaultPolicy.environmentToolTimeoutMs),
    ).toBe(100_000_000);

    const environmentPolicy = resolveMcpTimeoutPolicy({ MCP_TOOL_TIMEOUT: "2500" });
    expect(
      resolveMcpToolTimeoutMs(undefined, environmentPolicy.environmentToolTimeoutMs),
    ).toBe(2_500);
    expect(resolveMcpToolTimeoutMs(3_500, environmentPolicy.environmentToolTimeoutMs)).toBe(3_500);
    expect(resolveMcpToolTimeoutMs(1, undefined)).toBe(1_000);
    expect(
      resolveMcpToolTimeoutMs(
        undefined,
        resolveMcpTimeoutPolicy({ MCP_TOOL_TIMEOUT: "1" }).environmentToolTimeoutMs,
      ),
    ).toBe(1_000);
    expect(resolveMcpToolTimeoutMs(9_999_999_999, undefined)).toBe(2_147_483_647);
    expect(
      resolveMcpToolTimeoutMs(
        undefined,
        resolveMcpTimeoutPolicy({ MCP_TOOL_TIMEOUT: "9999999999" }).environmentToolTimeoutMs,
      ),
    ).toBe(2_147_483_647);
    expect(
      resolveMcpToolTimeoutMs(
        undefined,
        resolveMcpTimeoutPolicy({ MCP_TOOL_TIMEOUT: "invalid" }).environmentToolTimeoutMs,
      ),
    ).toBe(100_000_000);
  });
});

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

  it("resolves MCP_TIMEOUT from project settings.env", async () => {
    const runtime = McpRuntime.start(makeConfig(), makeDeps({
      settingsEnv: { MCP_TIMEOUT: "1234" },
    }));
    expect(runtime.resolvedConnectTimeoutMs).toBe(1_234);
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

  it("starts and shuts down concurrent benign servers without leaking children or exit listeners", async () => {
    const firstFixture = createMcpProcessFixture(makeTempDir());
    const secondFixture = createMcpProcessFixture(makeTempDir());
    const exitListenerBaseline = process.listenerCount("exit");
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({ name: "first", args: [firstFixture.serverScript, "serve"], env: firstFixture.env }),
        makeServer({ name: "second", args: [secondFixture.serverScript, "serve"], env: secondFixture.env }),
      ),
      makeDeps(),
    );
    try {
      expect(runtime.tools()).toEqual([]);
      expect(runtime.serverStates()).toEqual([
        { name: "first", state: "connecting" },
        { name: "second", state: "connecting" },
      ]);
      await Promise.all([
        firstFixture.waitFor(["serve.pid"], "first concurrent server to spawn"),
        secondFixture.waitFor(["serve.pid"], "second concurrent server to spawn"),
      ]);
      const pids = [
        firstFixture.pidOf("serve.pid"),
        secondFixture.pidOf("serve.pid"),
      ];
      expect(pids.every(processIsAlive)).toBe(true);
      expect(process.listenerCount("exit")).toBe(exitListenerBaseline + 1);

      await runtime.shutdown();
      await runtime.whenSettled();
      await Promise.all(pids.map((pid) => waitForDeath(pid, "concurrent server after shutdown")));
      expect(pids.every(processIsAlive)).toBe(false);
      expect(process.listenerCount("exit")).toBe(exitListenerBaseline);
    } finally {
      await runtime.shutdown();
      await Promise.all([firstFixture.cleanup(), secondFixture.cleanup()]);
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

  it("composes server env over Claude defaults over project settings over sanitized inheritance", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const projectRoot = makeTempDir();
    const base: Record<string, string | undefined> = {
      ...cleanBaseEnv(),
      MCP_FIXTURE_VAR: "from-base",
      PROJECT_SETTING: "from-inherited-base",
      PICC_LAUNCHER_PID: "99",
      PICC_INSTALL_KIND: "source",
      PICC_VERSION: "1.2.3",
      PI_SKIP_VERSION_CHECK: "1",
    };
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
            // Claude parity: configured server env is applied last.
            CLAUDECODE: "0",
            CLAUDE_PROJECT_DIR: "/config-wins",
          },
        }),
      ),
      makeDeps({
        projectRoot,
        sessionId: "env-proof-session",
        env: base,
        settingsEnv: {
          PROJECT_SETTING: "from-project-settings",
          MCP_FIXTURE_VAR: "from-settings",
          CLAUDE_CODE_SESSION_ID: "settings-must-lose-to-default",
        },
      }),
    );
    try {
      await runtime.whenSettled();
      const names = [
        "CLAUDE_PROJECT_DIR",
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "MCP_FIXTURE_VAR",
        "PROJECT_SETTING",
        "PYTHONIOENCODING",
        "PICC_LAUNCHER_PID",
        "PICC_INSTALL_KIND",
        "PICC_VERSION",
        "PI_SKIP_VERSION_CHECK",
      ];
      const result = await runtime.callTool("fixture", "report-env", { names });
      const reported = JSON.parse(firstText(result)) as Record<string, string | null>;
      expect(reported).toEqual({
        CLAUDE_PROJECT_DIR: "/config-wins",
        CLAUDECODE: "0",
        CLAUDE_CODE_SESSION_ID: "env-proof-session",
        MCP_FIXTURE_VAR: "from-config",
        PROJECT_SETTING: "from-project-settings",
        PYTHONIOENCODING: "utf-8",
        PICC_LAUNCHER_PID: null,
        PICC_INSTALL_KIND: null,
        PICC_VERSION: null,
        PI_SKIP_VERSION_CHECK: null,
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
          "MCP startup timed out during connection, initialization, or tool discovery; run /doctor for details.",
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
        "MCP startup timed out during connection, initialization, or tool discovery; run /doctor for details.",
      );
      const status = renderMcpStatusReport(
        makeConfig(makeServer({ name: "hung", rawCommand: "hang-cmd" })),
        runtime.serverStates(),
      );
      expect(status).toContain(
        "MCP startup timed out during connection, initialization, or tool discovery; run /doctor for details.",
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

  it("retains a bounded stderr tail before reporting an injected connect timeout", async () => {
    const stderrMarkerObserved = deferred<void>();
    let closed = false;
    class FakeTransport {
      readonly pid = undefined;
      readonly stderr = new PassThrough();
      constructor(_options: unknown) {
        // This parent-owned observer resolves during the same synchronous data
        // emission as McpRuntime's ring handler. Promise continuations cannot
        // run until every listener for that emission has returned.
        this.stderr.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("GARBAGE_STDERR_TAIL_MARKER")) {
            stderrMarkerObserved.resolve();
          }
        });
      }
    }
    class GarbageStreamClient {
      constructor(_clientInfo: unknown, _options: unknown) {}
      async connect(transport: FakeTransport): Promise<void> {
        transport.stderr.write("y".repeat(5_000));
        transport.stderr.write("\nGARBAGE_STDERR_TAIL_MARKER\n");
        return new Promise<void>(() => {});
      }
      async listTools(_params: unknown): Promise<never> {
        throw new Error("unreachable");
      }
      async close(): Promise<void> {
        closed = true;
      }
    }
    const runtime = McpRuntime.start(
      makeConfig(makeServer({ name: "garbage", rawCommand: "garbage-cmd" })),
      makeDeps({
        env: { ...cleanBaseEnv(), MCP_TIMEOUT: "4000" },
        loadSdk: async () =>
          ({
            Client: GarbageStreamClient,
            StdioClientTransport: FakeTransport,
          }) as unknown as Awaited<ReturnType<NonNullable<McpRuntimeDeps["loadSdk"]>>>,
        raceWithTimeout: async (_promise, timeoutMs) => {
          expect(timeoutMs).toBe(4_000);
          await stderrMarkerObserved.promise;
          return { timedOut: true };
        },
      }),
    );
    try {
      await runtime.whenSettled();
      expect(closed).toBe(true);
      expect(runtime.serverStates()).toEqual([
        expect.objectContaining({ name: "garbage", state: "failed" }),
      ]);
      expect(runtime.tools()).toEqual([]);
      // The stderr excerpt is the RING'S TAIL, bounded: the marker (written
      // last) is present, the 5 KB flood is not, and the whole diagnostic
      // stays small.
      const diagnostic = runtime.serverStates()[0]?.diagnostic ?? "";
      expect(diagnostic).toContain("GARBAGE_STDERR_TAIL_MARKER");
      expect(diagnostic).not.toMatch(/[\n\r\t]/);
      expect(diagnostic).not.toContain("y".repeat(500));
      expect(diagnostic.length).toBeLessThanOrEqual(700);
      expect(runtime.serverStates()[0]?.statusSummary).toBe(
        "MCP startup timed out during connection, initialization, or tool discovery; run /doctor for details.",
      );
      expect(renderMcpStatusReport(makeConfig(makeServer({ name: "garbage" })), runtime.serverStates()))
        .not.toContain("GARBAGE_STDERR_TAIL_MARKER");
    } finally {
      await runtime.shutdown();
    }
  });

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
  it("applies the minimum clamp through the real SDK timeout while the tool stays gated", async () => {
    const fixture = createMcpProcessFixture(makeTempDir());
    const runtime = McpRuntime.start(
      makeConfig(
        makeServer({
          name: "slowpoke",
          args: [fixture.serverScript, "slow-tool"],
          env: fixture.env,
          timeoutMs: 1,
        }),
      ),
      makeDeps(),
    );
    try {
      await runtime.whenSettled();
      const call = runtime.callTool("slowpoke", "slow", {});
      await fixture.waitFor(["slow.entered"], "slow tool to enter before its SDK timeout");
      await expect(call).rejects.toThrow(
        'MCP tool "slow" on server "slowpoke" timed out after 1000 ms',
      );
      expect(fixture.exists("slow.done")).toBe(false);
      fixture.release("slow");
      await fixture.waitFor(["slow.done"], "slow tool to finish after timeout release");
    } finally {
      await runtime.shutdown();
      await fixture.cleanup("slow");
    }
  }, 25_000);

  it("forwards settings.env and per-server timeout precedence to the SDK without elapsed waits", async () => {
    const cases = [
      { label: "default", settingsEnv: {}, expected: 100_000_000 },
      { label: "settings environment", settingsEnv: { MCP_TOOL_TIMEOUT: "2500" }, expected: 2_500 },
      {
        label: "per-server precedence",
        settingsEnv: { MCP_TOOL_TIMEOUT: "2500" },
        serverTimeoutMs: 3_500,
        expected: 3_500,
      },
      { label: "minimum clamp", settingsEnv: {}, serverTimeoutMs: 1, expected: 1_000 },
      { label: "maximum clamp", settingsEnv: {}, serverTimeoutMs: 9_999_999_999, expected: 2_147_483_647 },
    ] as const;

    for (const row of cases) {
      const forwardedTimeouts: number[] = [];
      const runtime = McpRuntime.start(
        makeConfig(
          makeServer({
            name: "fake",
            ...("serverTimeoutMs" in row ? { timeoutMs: row.serverTimeoutMs } : {}),
          }),
        ),
        makeDeps({
          settingsEnv: row.settingsEnv,
          loadSdk: async () => fakeToolSdk({ forwardedTimeouts }),
        }),
      );
      try {
        await runtime.whenSettled();
        await runtime.callTool("fake", "fake-tool", { label: row.label });
        expect(forwardedTimeouts, row.label).toEqual([row.expected]);
      } finally {
        await runtime.shutdown();
      }
    }
  });

  it("classifies the SDK timeout code with the resolved timeout and no upstream text", async () => {
    const forwardedTimeouts: number[] = [];
    const timeoutError = Object.assign(new Error("UPSTREAM_TIMEOUT_CANARY"), { code: -32_001 });
    const runtime = McpRuntime.start(
      makeConfig(makeServer({ name: "fake" })),
      makeDeps({
        settingsEnv: { MCP_TOOL_TIMEOUT: "2500" },
        loadSdk: async () => fakeToolSdk({ forwardedTimeouts, callError: timeoutError }),
      }),
    );
    try {
      await runtime.whenSettled();
      const rejection = await runtime.callTool("fake", "fake-tool", {}).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe(
        'MCP tool "fake-tool" on server "fake" timed out after 2500 ms',
      );
      expect((rejection as Error).message).not.toContain("UPSTREAM_TIMEOUT_CANARY");
      expect(forwardedTimeouts).toEqual([2_500]);
      expect(runtime.diagnostics().join("\n")).not.toContain("UPSTREAM_TIMEOUT_CANARY");
    } finally {
      await runtime.shutdown();
    }
  });
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

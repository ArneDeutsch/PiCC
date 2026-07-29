import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import picc, { type PiccTestSeam } from "../src/index.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { deferred, waitUntil } from "./helpers/async.js";
import type { McpLifecycleState, McpToolInfo } from "../src/runtime/mcp.js";
import {
  createMcpProcessFixture,
  processIsAlive,
  type McpProcessFixture,
} from "./helpers/mcp-process.js";

/**
 * Layer 2: MCP main-session tool exposure wired through the REAL extension
 * (`picc(pi)`) against real fixture stdio servers — late registration under
 * `mcp__<server>__<tool>` names, live round-trips, bare-server deny removal,
 * guard deny blocking, clip backstop, PreToolUse matcher, the first-turn settle
 * barrier, session_shutdown kill discipline, and the zero-enabled zero-context
 * half. The real-Pi half of the zero-context guarantee runs in the end-to-end
 * zero-context scenario; the Pi late-activation behavior itself is pinned
 * against the real Pi dist below.
 */

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeProjectFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function waitForDeath(pid: number, what: string): Promise<void> {
  await waitUntil({
    description: `${what} (pid ${pid}) to die`,
    predicate: () => !processIsAlive(pid),
    describeObserved: () => `pid ${pid} alive=${processIsAlive(pid)}`,
    timeoutMs: 10_000,
  });
}

/** Fire session_shutdown on a loaded extension (idempotent runtime shutdown). */
async function shutdownExtension(pi: FakePi): Promise<void> {
  await pi.fire("session_shutdown", { reason: "other" }, pi.printCtx());
}

function startGatedExtension(identity: string, serverMode: string): {
  fixture: McpProcessFixture;
  pi: FakePi;
} {
  const dir = makeTempDir(`picc-${identity}-`);
  const fixture = createMcpProcessFixture(makeTempDir(`picc-${identity}-fx-`));
  const wrapper = path.join(fixture.dir, "gated-server.mjs");
  fs.writeFileSync(
    wrapper,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const dir = process.env.MCP_BARRIER_DIR;",
      `fs.writeFileSync(path.join(dir, ${JSON.stringify(`${identity}.pid`)}), JSON.stringify({ pid: process.pid }));`,
      "await new Promise((resolve) => {",
      `  const check = () => (fs.existsSync(path.join(dir, ${JSON.stringify(`${identity}.release`)})) ? resolve() : setTimeout(check, 10));`,
      "  check();",
      "});",
      // Import by file URL so the committed fixture's SDK/package imports resolve from test/helpers, not the temp wrapper directory.
      `await import(${JSON.stringify(pathToFileURL(fixture.serverScript).href)});`,
    ].join("\n"),
  );
  writeProjectFile(dir, "CLAUDE.md", `MCP-${identity.toUpperCase()}-PROJECT\n`);
  writeProjectFile(
    dir,
    ".mcp.json",
    JSON.stringify({
      mcpServers: {
        [identity]: {
          command: fixture.nodeCommand,
          args: [wrapper, serverMode],
          env: fixture.env,
        },
      },
    }),
  );
  const userDir = makeTempDir(`picc-${identity}-user-`);
  writeProjectFile(userDir, "settings.json", JSON.stringify({ enabledMcpjsonServers: [identity] }));
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);
  const pi = fakePi();
  picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
  return { fixture, pi };
}

const originalCwd = process.cwd();
const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

afterAll(() => {
  process.chdir(originalCwd);
  if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
  else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
  for (const dir of tempDirs) {
    try {
      // Retries are load-bearing on Windows: the extension load fire-and-forgets
      // an orphan-worktree reap whose short-lived `git` children run with cwd
      // INSIDE the project dir, and a still-running child makes the top-level
      // rmdir fail EPERM. The leaking call sites also join initialization (see
      // the zero-enabled test); this backstops the describes that cannot.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort — vitest swallows afterAll console output anyway */
    }
  }
});

// ---------------------------------------------------------------------------
// Main wired instance: two enabled servers ("fixture" serve, "denied" slow-tool
// under a bare-server deny), approval via user-scope enabledMcpjsonServers, a
// PreToolUse hook with an mcp__fixture__.* matcher.
// ---------------------------------------------------------------------------

describe("MCP main-session tool exposure (wired)", () => {
  let dir: string;
  let userDir: string;
  let fixture: McpProcessFixture;
  let pi: FakePi;
  const checkpointWrapCounts = new Map<string, number>();
  const checkpointOutputs = new Map<string, object>();
  const FIXTURE_TOOLS = ["mcp__fixture__echo", "mcp__fixture__report-env", "mcp__fixture__big-output"];

  beforeAll(async () => {
    dir = makeTempDir("picc-mcpreg-");
    fixture = createMcpProcessFixture(makeTempDir("picc-mcpreg-fx-"));
    writeProjectFile(dir, "CLAUDE.md", "MCP-REG-PROJECT\n");
    writeProjectFile(
      dir,
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: fixture.nodeCommand,
            args: [fixture.serverScript, "serve"],
            env: fixture.env,
          },
          denied: {
            command: fixture.nodeCommand,
            args: [fixture.serverScript, "slow-tool"],
            env: fixture.env,
          },
        },
      }),
    );
    writeProjectFile(
      dir,
      ".claude/settings.json",
      JSON.stringify({
        permissions: { deny: ["mcp__denied"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "mcp__fixture__.*",
              hooks: [
                {
                  type: "command",
                  command: 'echo fired >> "$CLAUDE_PROJECT_DIR/.claude/.mcp-hook-log"',
                },
              ],
            },
          ],
        },
      }),
    );
    userDir = makeTempDir("picc-mcpreg-user-");
    // Approval lives in a USER-authored scope — project scope cannot self-approve.
    writeProjectFile(userDir, "settings.json", JSON.stringify({
      enabledMcpjsonServers: ["fixture", "denied"],
    }));
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    pi = fakePi();
    picc(pi.api as never, {
      onInitializationSettled: pi.captureInitialization,
      onWired: ({ mainCheckpointGate }) => {
        const realWrap = mainCheckpointGate.wrapTool.bind(mainCheckpointGate);
        mainCheckpointGate.wrapTool = ((definition: Record<string, unknown>) => {
          const wrapped = realWrap(definition);
          const name = String(definition.name);
          if (name.startsWith("mcp__fixture__")) {
            checkpointWrapCounts.set(name, (checkpointWrapCounts.get(name) ?? 0) + 1);
            checkpointOutputs.set(name, wrapped);
          }
          return wrapped;
        }) as typeof mainCheckpointGate.wrapTool;
      },
    });
    await pi.waitForInitialization();
    // Late registration lands after the non-blocking connect settles.
    await pi.waitForTools(FIXTURE_TOOLS);
  }, 30_000);

  afterAll(async () => {
    process.chdir(originalCwd);
    try {
      await shutdownExtension(pi);
    } finally {
      await fixture.cleanup("slow");
    }
  }, 30_000);

  it("registers connected-server tools under mcp__<server>__<tool> with no prompt snippet", () => {
    for (const name of FIXTURE_TOOLS) {
      const tool = pi.tools.get(name);
      expect(tool, name).toBeDefined();
      // Zero-context hard invariant survives the whole decoration pipeline.
      expect(tool.promptSnippet).toBeUndefined();
      expect(tool.promptGuidelines).toBeUndefined();
      expect(checkpointWrapCounts.get(name), name).toBe(1);
      expect(tool, name).toBe(checkpointOutputs.get(name));
    }
    const echo = pi.tools.get("mcp__fixture__echo");
    expect(echo.description).toBe("echoes text back");
    expect(echo.label).toBe("echo (fixture MCP)");
    const slots: string[] = [];
    const theme = { fg(slot: string, text: string) { slots.push(slot); return text; } };
    const rendered = (echo.renderCall as Function)({}, theme, { state: {}, isPartial: true })
      .render(120)
      .join("\n");
    expect(rendered).toBe("○ mcp echo · server fixture");
    expect(slots).toEqual(expect.arrayContaining(["text", "accent", "muted"]));
    expect(rendered).not.toContain("mcp__fixture__echo");
  });

  it("keeps path-shaped arguments out of an actually registered inert proxy presentation", () => {
    const tool = pi.tools.get("mcp__fixture__echo");
    const pathArgument = path.join(dir, "nested", "secret.txt");
    const context = { state: {}, args: { path: pathArgument }, cwd: dir, isError: false, isPartial: true };
    tool.renderCall(context.args, undefined, context);
    context.isPartial = false;
    const callComponent = tool.renderCall(context.args, undefined, context);
    const canonical = {
      content: [{ type: "text", text: "inert proxy evidence" }],
      details: { server: "fixture", tool: "echo" }, isError: false,
    };
    const collapsedResult = tool.renderResult(
      canonical, { expanded: false, isPartial: false }, undefined, context,
    ).render(100).join("\n");
    const call = callComponent.render(100).join("\n");
    expect(call).toContain("mcp echo · server fixture");
    expect(call).toContain("ctrl+o to expand");
    expect(call).not.toContain("mcp__fixture__echo");
    expect(call).not.toContain(pathArgument);
    expect(call).not.toContain("nested/secret.txt");
    expect(call).not.toContain("inert proxy evidence");
    expect(collapsedResult).not.toContain("inert proxy evidence");
    tool.renderResult(canonical, { expanded: true, isPartial: false }, undefined, context);
    expect(callComponent.render(100).join("\n")).toContain("inert proxy evidence");
  });

  it("round-trips a real tool call through the registered proxy", async () => {
    const result = await pi.tools.get("mcp__fixture__echo").execute("call-1", { text: "round-trip" });
    expect(result.content).toEqual([{ type: "text", text: "round-trip" }]);
    expect(result.details).toMatchObject({ server: "fixture", tool: "echo" });
  });

  it("bare-server deny removes the denied server's tools from registration while the server runs", async () => {
    // The deny gates REGISTRATION, not enablement: the denied server really
    // started (its pid marker exists) yet none of its tools reached the model.
    await fixture.waitFor(["slow-tool.pid"], "denied slow-tool server to spawn");
    const mcpDenied = [...pi.tools.keys()].filter((name) => name.startsWith("mcp__denied"));
    expect(mcpDenied).toEqual([]);
    // The enabled sibling was NOT collateral damage.
    expect(pi.tools.has("mcp__fixture__echo")).toBe(true);
  });

  it("the guard blocks a live call against the denied server with no server-side effect", async () => {
    const result = await pi.fire(
      "tool_call",
      { toolName: "mcp__denied__slow", toolCallId: "deny-1", input: {} },
      pi.printCtx(),
    );
    expect(result).toMatchObject({ block: true });
    expect(String(result.reason)).toContain("mcp__denied");
    // The server-side handler never entered: no marker was written.
    expect(fixture.exists("slow.entered")).toBe(false);
  });

  it("a PreToolUse hook with an mcp__fixture__.* matcher fires on a proxy call", async () => {
    const log = path.join(dir, ".claude", ".mcp-hook-log");
    fs.rmSync(log, { force: true });
    const result = await pi.fire(
      "tool_call",
      { toolName: "mcp__fixture__echo", toolCallId: "hook-1", input: { text: "x" } },
      pi.printCtx(),
    );
    expect(result?.block).not.toBe(true);
    expect(fs.existsSync(log)).toBe(true);
    // ...and the matcher really is scoped: a non-matching MCP name stays silent.
    fs.rmSync(log, { force: true });
    await pi.fire(
      "tool_call",
      { toolName: "mcp__denied__slow", toolCallId: "hook-2", input: {} },
      pi.printCtx(),
    );
    expect(fs.existsSync(log)).toBe(false);
  });

  it("/mcp reports the connected fixture's live tool count", async () => {
    await pi.commands.get("mcp").handler("", pi.tuiCtx());
    const entry = pi.entries.find((candidate) => candidate.customType === "picc-control" && candidate.data?.command === "mcp");
    expect(entry).toBeDefined();
    expect(String(entry?.data?.output)).toContain('"fixture": connected (3 tools)');
    expect(pi.messages).toEqual([]);
  });

  it("the clip backstop marks an oversized MCP tool result", async () => {
    const big = await pi.tools.get("mcp__fixture__big-output").execute("clip-1", { bytes: 200_000 });
    expect((big.content[0] as { text: string }).text).toHaveLength(200_000);
    const patched = await pi.fire(
      "tool_result",
      {
        toolName: "mcp__fixture__big-output",
        toolCallId: "clip-1",
        input: { bytes: 200_000 },
        content: big.content,
        isError: false,
      },
      pi.printCtx(),
    );
    const text = (patched?.content ?? [])
      .filter((c: { type?: string }) => c?.type === "text")
      .map((c: { text?: string }) => String(c.text ?? ""))
      .join("\n");
    expect(text).toContain("[PiCC clipped");
    expect(text.length).toBeLessThan(200_000);
  });

  // LAST in this describe: kills the shared instance's servers.
  it("session_shutdown kills the MCP servers via the runtime path", async () => {
    const servePid = fixture.pidOf("serve.pid");
    const slowPid = fixture.pidOf("slow-tool.pid");
    expect(processIsAlive(servePid)).toBe(true);
    expect(processIsAlive(slowPid)).toBe(true);
    await shutdownExtension(pi);
    await waitForDeath(servePid, "serve fixture after session_shutdown");
    await waitForDeath(slowPid, "denied slow-tool fixture after session_shutdown");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// First-turn settle barrier: a gated server (connect blocked on a release
// marker) holds before_agent_start; release lets it return WITH the tools.
// ---------------------------------------------------------------------------

describe("MCP first-turn settle barrier (wired)", () => {
  let fixture: McpProcessFixture;
  let pi: FakePi;

  beforeAll(() => {
    const started = startGatedExtension("gated", "serve");
    fixture = started.fixture;
    pi = started.pi;
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    try {
      await shutdownExtension(pi);
    } finally {
      await fixture.cleanup("gated");
    }
  }, 30_000);

  it("shows and clears TUI startup status around the barrier without changing machine modes", async () => {
    await fixture.waitFor(["gated.pid"], "gated server to spawn");
    let settled = false;
    const firing = pi
      .fire("before_agent_start", { systemPrompt: "BASE" }, pi.tuiCtx())
      .then((result) => {
        settled = true;
        return result;
      });
    await waitUntil({
      description: "TUI MCP startup status to be recorded",
      predicate: () => pi.statusCalls.length === 1,
      describeObserved: () => JSON.stringify(pi.statusCalls),
    });
    expect(pi.statusCalls).toEqual([{
      key: "picc-mcp-startup",
      text: "Waiting for MCP servers to start…",
    }]);
    expect(settled).toBe(false);
    expect(pi.tools.has("mcp__gated__echo")).toBe(false);

    const throwingStatusCalls: Array<{ key: string; text: string | undefined }> = [];
    const throwingFiring = pi.fire(
      "before_agent_start",
      { systemPrompt: "THROWING-UI" },
      pi.tuiCtx({
        ui: {
          setStatus: (key: string, text: string | undefined) => {
            throwingStatusCalls.push({ key, text });
            throw new Error("setStatus fixture failure");
          },
        },
      }),
    );
    const machineFirings = [
      pi.fire("before_agent_start", { systemPrompt: "PRINT" }, pi.printCtx()),
      pi.fire("before_agent_start", { systemPrompt: "JSON" }, pi.ctx({ mode: "json", hasUI: false })),
      pi.fire("before_agent_start", { systemPrompt: "RPC" }, pi.rpcCtx()),
    ];
    expect(throwingStatusCalls).toEqual([{
      key: "picc-mcp-startup",
      text: "Waiting for MCP servers to start…",
    }]);
    expect(pi.statusCalls).toHaveLength(1);
    expect(pi.messages).toEqual([]);
    expect(pi.entries).toEqual([]);

    fixture.release("gated");
    const [result, throwingResult, ...machineResults] = await Promise.all([
      firing,
      throwingFiring,
      ...machineFirings,
    ]);
    expect(settled).toBe(true);
    expect(pi.statusCalls).toEqual([
      { key: "picc-mcp-startup", text: "Waiting for MCP servers to start…" },
      { key: "picc-mcp-startup", text: undefined },
    ]);
    // Registration completed BEFORE the handler returned: Pi snapshots the
    // run's tools after awaiting before_agent_start, so the first request
    // deterministically carries the connected server's tools.
    expect(throwingStatusCalls).toEqual([
      { key: "picc-mcp-startup", text: "Waiting for MCP servers to start…" },
      { key: "picc-mcp-startup", text: undefined },
    ]);
    expect(pi.tools.has("mcp__gated__echo")).toBe(true);
    expect(String(result?.systemPrompt ?? "")).toContain("BASE");
    expect(String(result?.systemPrompt ?? "")).not.toContain("Waiting for MCP");
    expect(String(throwingResult?.systemPrompt ?? "")).toContain("THROWING-UI");
    expect(String(throwingResult?.systemPrompt ?? "")).not.toContain("Waiting for MCP");
    for (const machineResult of machineResults) {
      expect(String(machineResult?.systemPrompt ?? "")).not.toContain("Waiting for MCP");
    }
    expect(JSON.stringify(pi.messages)).not.toContain("Waiting for MCP");
    expect(JSON.stringify(pi.entries)).not.toContain("Waiting for MCP");
    expect(JSON.stringify(pi.notifications)).not.toContain("Waiting for MCP");

    await pi.fire("before_agent_start", { systemPrompt: "LATER" }, pi.tuiCtx());
    expect(pi.statusCalls).toHaveLength(2);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Terminal cleanup paths: failed settlement and shutdown while connecting.
// ---------------------------------------------------------------------------

describe("MCP startup status terminal cleanup (wired)", () => {
  it("contains throwing set/clear calls and clears before the failure warning", async () => {
    const { fixture, pi } = startGatedExtension("failed", "exit-early");
    const events: string[] = [];
    const ctx = pi.tuiCtx({
      ui: {
        setStatus: (_key: string, text: string | undefined) => {
          events.push(text === undefined ? "clear" : "set");
          throw new Error("setStatus fixture failure");
        },
        notify: (text: string, severity?: string) => {
          events.push("notify");
          pi.notifications.push({ text, severity });
        },
      },
    });
    const firing = pi.fire("before_agent_start", { systemPrompt: "FAIL" }, ctx);
    try {
      await fixture.waitFor(["failed.pid"], "failed server to reach its gate");
      await waitUntil({
        description: "throwing failure-path status set attempt",
        predicate: () => events.length === 1,
        describeObserved: () => JSON.stringify(events),
      });
      fixture.release("failed");
      const result = await firing;
      expect(String(result?.systemPrompt ?? "")).toContain("FAIL");
      expect(events).toEqual(["set", "clear", "notify"]);
      expect(pi.notifications).toEqual([{
        text: "MCP server(s) failed to connect: failed — run /doctor for details.",
        severity: "warning",
      }]);
      expect(pi.tools.has("mcp__failed__echo")).toBe(false);

      await pi.fire("before_agent_start", { systemPrompt: "LATER" }, ctx);
      expect(events).toEqual(["set", "clear", "notify"]);
      expect(pi.notifications).toHaveLength(1);
    } finally {
      try {
        await shutdownExtension(pi);
      } finally {
        try {
          await firing.catch(() => undefined);
        } finally {
          try {
            await fixture.cleanup("failed");
          } finally {
            process.chdir(originalCwd);
          }
        }
      }
    }
  }, 30_000);

  it("clears the status when shutdown settles a pending connection", async () => {
    const { fixture, pi } = startGatedExtension("shutdown", "serve");
    const firing = pi.fire("before_agent_start", { systemPrompt: "SHUTDOWN" }, pi.tuiCtx());
    try {
      await fixture.waitFor(["shutdown.pid"], "shutdown server to reach its gate");
      await waitUntil({
        description: "pending-shutdown status set",
        predicate: () => pi.statusCalls.length === 1,
        describeObserved: () => JSON.stringify(pi.statusCalls),
      });
      expect(pi.tools.has("mcp__shutdown__echo")).toBe(false);
      await shutdownExtension(pi);
      const result = await firing;
      expect(String(result?.systemPrompt ?? "")).toContain("SHUTDOWN");
      expect(pi.statusCalls).toEqual([
        { key: "picc-mcp-startup", text: "Waiting for MCP servers to start…" },
        { key: "picc-mcp-startup", text: undefined },
      ]);
      expect(pi.tools.has("mcp__shutdown__echo")).toBe(false);
    } finally {
      try {
        await shutdownExtension(pi);
      } finally {
        try {
          await firing.catch(() => undefined);
        } finally {
          try {
            await fixture.cleanup("shutdown");
          } finally {
            process.chdir(originalCwd);
          }
        }
      }
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Zero-enabled zero-context (Layer-2 half; the real-Pi half runs in the
// end-to-end zero-context scenario)
// ---------------------------------------------------------------------------

describe("MCP zero-enabled path (wired)", () => {
  it("registers no mcp__* tool and leaves the prompt suffix identical to a no-MCP baseline", async () => {
    // Prefixes must not contain "mcp": the temp paths land in the prompt (auto
    // memory dir, scratchpad) and would trip the no-MCP-mention assertion below.
    const dir = makeTempDir("picc-zeroctx-");
    const userDir = makeTempDir("picc-zeroctx-user-");
    // Marker must not spell "MCP" either — it lands in the prompt via CLAUDE.md.
    writeProjectFile(dir, "CLAUDE.md", "ZEROCTX-PROJECT\n");
    fs.mkdirSync(userDir, { recursive: true });
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    try {
      // Baseline: no .mcp.json at all.
      const baselinePi = fakePi();
      picc(baselinePi.api as never, { onInitializationSettled: baselinePi.captureInitialization });
      // Join the load's fire-and-forget initialization (orphan-worktree reap +
      // built-in registration): the reap spawns short-lived `git` children with
      // cwd inside this project dir, and a child still alive at afterAll makes
      // Windows refuse the temp-dir removal with EPERM.
      await baselinePi.waitForInitialization();
      const baseline = await baselinePi.fire(
        "before_agent_start",
        { systemPrompt: "BASE" },
        baselinePi.tuiCtx(),
      );
      expect(baselinePi.statusCalls).toEqual([]);
      await shutdownExtension(baselinePi);

      // Same project, .mcp.json present but NOTHING enabled (pending approval).
      writeProjectFile(
        dir,
        ".mcp.json",
        JSON.stringify({
          mcpServers: { pending: { command: "definitely-not-started", args: [] } },
        }),
      );
      const mcpPi = fakePi();
      picc(mcpPi.api as never, { onInitializationSettled: mcpPi.captureInitialization });
      await mcpPi.waitForInitialization(); // same temp-dir discipline as above
      // The first-turn barrier is the synchronization point: after it returns,
      // MCP registration (a no-op here) has completed.
      const withPending = await mcpPi.fire(
        "before_agent_start",
        { systemPrompt: "BASE" },
        mcpPi.tuiCtx(),
      );
      expect(mcpPi.statusCalls).toEqual([]);
      const mcpTools = [...mcpPi.tools.keys()].filter((name) => name.startsWith("mcp__"));
      expect(mcpTools).toEqual([]);

      // Byte-identical prompt output modulo the per-session random scratch-dir
      // suffix (the only legitimately session-unique text in the suffix).
      const normalize = (value: unknown): string =>
        String(value ?? "").replace(/picc-scratch-[A-Za-z0-9]+/g, "picc-scratch-X");
      expect(normalize(withPending?.systemPrompt)).toBe(normalize(baseline?.systemPrompt));
      expect(normalize(withPending?.systemPrompt)).not.toMatch(/mcp/i);
      await shutdownExtension(mcpPi);
    } finally {
      process.chdir(originalCwd);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Remote lifecycle consumption through an injected fake runtime
// ---------------------------------------------------------------------------

describe("remote MCP stable main-session registration (fake runtime)", () => {
  type Runtime = NonNullable<PiccTestSeam["mcpRuntime"]>;

  it("registers once after retries, keeps the same proxy through recovery/exhaustion, and clears retrying status", async () => {
    const dir = makeTempDir("picc-remotereg-");
    const userDir = makeTempDir("picc-remotereg-user-");
    writeProjectFile(dir, "CLAUDE.md", "REMOTE-STABLE-PROJECT\n");
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);

    const settled = deferred<void>();
    const catalog: McpToolInfo[] = [{
      serverName: "remote",
      toolName: "echo",
      description: "trusted metadata canary",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }];
    let state: McpLifecycleState = "retrying";
    let callMode: "success" | "outage" | "failed" = "success";
    let logicalCalls = 0;
    const runtime: Runtime = {
      whenSettled: () => settled.promise,
      tools: () => catalog,
      diagnostics: () => [],
      serverStates: () => [{ name: "remote", transport: "http", state }],
      shutdown: async () => {},
      callTool: async () => {
        logicalCalls += 1;
        if (callMode === "outage") {
          throw new Error('MCP server "remote" is temporarily unavailable while reconnecting');
        }
        if (callMode === "failed") {
          throw new Error('MCP server "remote" is unavailable because its remote connection failed');
        }
        return { content: [{ type: "text", text: "trusted result canary" }] };
      },
    };
    const pi = fakePi();
    const registrations: string[] = [];
    const registerTool = pi.api.registerTool as (tool: { name: string }) => void;
    pi.api.registerTool = ((tool: { name: string }) => {
      registrations.push(tool.name);
      registerTool(tool);
    }) as typeof pi.api.registerTool;
    try {
      picc(pi.api as never, {
        mcpRuntime: runtime,
        onInitializationSettled: pi.captureInitialization,
      });
      await pi.waitForInitialization();
      const firstTurn = pi.fire("before_agent_start", { systemPrompt: "BASE" }, pi.tuiCtx());
      await waitUntil({
        description: "retrying remote startup status",
        predicate: () => pi.statusCalls.length === 1,
        describeObserved: () => JSON.stringify(pi.statusCalls),
      });
      expect(pi.statusCalls).toEqual([{
        key: "picc-mcp-startup",
        text: "Waiting for MCP servers to start…",
      }]);
      expect(pi.tools.has("mcp__remote__echo")).toBe(false);

      state = "connected";
      settled.resolve();
      const prompt = await firstTurn;
      expect(String(prompt?.systemPrompt)).not.toMatch(/trusted metadata canary|trusted result canary/u);
      expect(pi.statusCalls.at(-1)).toEqual({ key: "picc-mcp-startup", text: undefined });
      expect(registrations.filter((name) => name === "mcp__remote__echo")).toHaveLength(1);
      const proxy = pi.tools.get("mcp__remote__echo");
      expect(proxy.description).toBe("trusted metadata canary");
      expect((await proxy.execute("ok", {})).content[0].text).toBe("trusted result canary");

      state = "reconnecting";
      callMode = "outage";
      await expect(proxy.execute("outage", {})).rejects.toThrow(/was not called.*Retry later/u);
      expect(pi.tools.get("mcp__remote__echo")).toBe(proxy);

      state = "connected";
      callMode = "success";
      expect((await proxy.execute("recovered", {})).content[0].text).toBe("trusted result canary");
      expect(pi.tools.get("mcp__remote__echo")).toBe(proxy);

      state = "failed";
      callMode = "failed";
      await expect(proxy.execute("failed", {})).rejects.toThrow(
        /was not called.*recovery has stopped.*\/mcp or \/doctor.*reload or start a new session/u,
      );
      expect(logicalCalls).toBe(4);
      expect(registrations.filter((name) => name.startsWith("mcp__remote__"))).toEqual([
        "mcp__remote__echo",
      ]);
      expect([...pi.tools.keys()].filter((name) => name.startsWith("mcp__remote__"))).toEqual([
        "mcp__remote__echo",
      ]);
    } finally {
      await pi.fire("session_shutdown", { reason: "other" }, pi.printCtx());
      process.chdir(originalCwd);
    }
  }, 30_000);

  it("keeps startup failure zero-context, bounded, and one-shot", async () => {
    const dir = makeTempDir("picc-remotefail-");
    const userDir = makeTempDir("picc-remotefail-user-");
    writeProjectFile(dir, "CLAUDE.md", "REMOTE-FAIL-PROJECT\n");
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    const runtime: Runtime = {
      whenSettled: async () => {},
      tools: () => [],
      diagnostics: () => ["MCP server startup failed (authentication)."],
      serverStates: () => Array.from({ length: 20 }, (_, index) => ({
        name: `failed-${index}`,
        transport: "http" as const,
        state: "failed" as const,
      })),
      shutdown: async () => {},
      callTool: async () => { throw new Error("unreachable"); },
    };
    const baselinePi = fakePi();
    const failedPi = fakePi();
    let errSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      // Independent extension instance with no MCP config/runtime replacement:
      // this is the authority for exactly what the same project contributes.
      picc(baselinePi.api as never, { onInitializationSettled: baselinePi.captureInitialization });
      await baselinePi.waitForInitialization();
      const baseline = await baselinePi.fire(
        "before_agent_start",
        { systemPrompt: "BASE" },
        baselinePi.tuiCtx(),
      );
      await shutdownExtension(baselinePi);

      errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      picc(failedPi.api as never, {
        mcpRuntime: runtime,
        onInitializationSettled: failedPi.captureInitialization,
      });
      await failedPi.waitForInitialization();
      const first = await failedPi.fire(
        "before_agent_start",
        { systemPrompt: "BASE" },
        failedPi.tuiCtx(),
      );
      const second = await failedPi.fire(
        "before_agent_start",
        { systemPrompt: "BASE" },
        failedPi.tuiCtx(),
      );
      const normalize = (value: unknown): string =>
        String(value ?? "").replace(/picc-scratch-[A-Za-z0-9]+/g, "picc-scratch-X");
      expect(Buffer.from(normalize(first?.systemPrompt))).toEqual(
        Buffer.from(normalize(baseline?.systemPrompt)),
      );
      expect(Buffer.from(normalize(second?.systemPrompt))).toEqual(
        Buffer.from(normalize(baseline?.systemPrompt)),
      );
      expect([...failedPi.tools.keys()].filter((name) => name.startsWith("mcp__"))).toEqual([]);
      expect(failedPi.messages).toEqual(baselinePi.messages);
      expect(failedPi.entries).toEqual(baselinePi.entries);
      expect(failedPi.messages).toEqual([]);
      expect(failedPi.entries).toEqual([]);
      expect(failedPi.notifications).toHaveLength(1);
      expect(failedPi.notifications[0]!.text).toContain("and 12 more");
      expect(failedPi.notifications[0]!.text.length).toBeLessThan(300);
    } finally {
      errSpy?.mockRestore();
      await shutdownExtension(failedPi);
      await shutdownExtension(baselinePi);
      process.chdir(originalCwd);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Pi late-activation pin (real dist, in-process)
// ---------------------------------------------------------------------------

const piDistDir = path.join(
  originalCwd,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
);
const piDistMissing = !fs.existsSync(path.join(piDistDir, "core", "agent-session.js"));
if (piDistMissing) {
  console.warn("Pi dist missing; skipping the real-Pi late-registration pin");
}

describe.skipIf(piDistMissing)("real Pi late-registration pin", () => {
  it("auto-activates a post-load registered NEW tool name; a snippet-less tool leaves the prompt byte-identical", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const { Type } = await import("typebox");
    const cwd = makeTempDir("picc-pipin-");
    const agentDir = makeTempDir("picc-pipin-agent-");
    let extApi: any;
    const settingsManager = sdk.SettingsManager.inMemory();
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [{ name: "mcp-pin", factory: (api: any) => { extApi = api; } }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    // No `tools:` option — the main-session reality: no allowedToolNames
    // allowlist, so Pi's registry refresh auto-appends genuinely NEW names.
    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      settingsManager,
    });
    try {
      expect(extApi).toBeDefined();
      const promptBefore = session.systemPrompt;
      expect(session.getActiveToolNames()).not.toContain("mcp__pin__late");

      // Post-load registration of a NEW name — the branch PiCC's detached MCP
      // registration exercises in production.
      extApi.registerTool({
        name: "mcp__pin__late",
        label: "mcp__pin__late",
        description: "late-registered MCP-shaped tool",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
      });
      expect(session.getActiveToolNames()).toContain("mcp__pin__late");
      // A snippet-less tool must not disturb the base system prompt — the
      // contrapositive of the "no promptSnippet on MCP proxies" invariant.
      expect(session.systemPrompt).toBe(promptBefore);

      // ...and the reason the invariant exists: a snippet-bearing registration
      // DOES rebuild the prompt with the snippet in it.
      extApi.registerTool({
        name: "mcp__pin__snippety",
        label: "mcp__pin__snippety",
        description: "snippet-bearing tool",
        promptSnippet: "PIN-SNIPPET-MARKER",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
      });
      expect(session.getActiveToolNames()).toContain("mcp__pin__snippety");
      expect(session.systemPrompt).toContain("PIN-SNIPPET-MARKER");
    } finally {
      try {
        session.dispose?.();
      } catch {
        /* best effort */
      }
    }
  }, 30_000);
});

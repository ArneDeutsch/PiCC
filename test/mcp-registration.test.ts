import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import picc from "../src/index.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { waitUntil } from "./helpers/async.js";
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
    picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
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
    }
    expect(pi.tools.get("mcp__fixture__echo").description).toBe("echoes text back");
  });

  it("keeps path-shaped arguments on an actually registered inert proxy generic", () => {
    const tool = pi.tools.get("mcp__fixture__echo");
    const pathArgument = path.join(dir, "nested", "secret.txt");
    const context = { state: {}, args: { path: pathArgument }, cwd: dir, isError: false, isPartial: false };
    const call = tool.renderCall(context.args, undefined, context).render(100).join("\n");
    const result = tool.renderResult(
      { content: [{ type: "text", text: "inert proxy evidence" }] },
      { expanded: false, isPartial: false },
      undefined,
      context,
    ).render(100).join("\n");
    expect(call).toContain("mcp fixture echo");
    expect(call).not.toContain(pathArgument);
    expect(call).not.toContain("nested/secret.txt");
    expect(result).toContain("inert proxy evidence");
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
  let dir: string;
  let fixture: McpProcessFixture;
  let pi: FakePi;

  beforeAll(() => {
    dir = makeTempDir("picc-mcpgate-");
    fixture = createMcpProcessFixture(makeTempDir("picc-mcpgate-fx-"));
    // Gate wrapper in the fixture dir: publish a pid marker, wait for the
    // release marker, then run the COMMITTED fixture server module (imported by
    // file URL so its SDK imports resolve from test/helpers, not this temp dir).
    const wrapper = path.join(fixture.dir, "gated-server.mjs");
    fs.writeFileSync(
      wrapper,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        "const dir = process.env.MCP_BARRIER_DIR;",
        'fs.writeFileSync(path.join(dir, "gated.pid"), JSON.stringify({ pid: process.pid }));',
        "await new Promise((resolve) => {",
        '  const check = () => (fs.existsSync(path.join(dir, "gated.release")) ? resolve() : setTimeout(check, 10));',
        "  check();",
        "});",
        `await import(${JSON.stringify(pathToFileURL(fixture.serverScript).href)});`,
      ].join("\n"),
    );
    writeProjectFile(dir, "CLAUDE.md", "MCP-GATE-PROJECT\n");
    writeProjectFile(
      dir,
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          gated: {
            command: fixture.nodeCommand,
            // argv[2] = "serve" reaches the imported committed module's mode switch.
            args: [wrapper, "serve"],
            env: fixture.env,
          },
        },
      }),
    );
    const userDir = makeTempDir("picc-mcpgate-user-");
    writeProjectFile(userDir, "settings.json", JSON.stringify({ enabledMcpjsonServers: ["gated"] }));
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    pi = fakePi();
    picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    try {
      await shutdownExtension(pi);
    } finally {
      await fixture.cleanup("gated");
    }
  }, 30_000);

  it("before_agent_start does not return until the gated server settles, then carries its tools", async () => {
    await fixture.waitFor(["gated.pid"], "gated server to spawn");
    let settled = false;
    const firing = pi
      .fire("before_agent_start", { systemPrompt: "BASE" }, pi.printCtx())
      .then((result) => {
        settled = true;
        return result;
      });
    // Observation window only — the deterministic proof is that RELEASING the
    // gate is what lets the fire settle (below); nothing here asserts elapsed time.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    expect(pi.tools.has("mcp__gated__echo")).toBe(false);

    fixture.release("gated");
    const result = await firing;
    expect(settled).toBe(true);
    // Registration completed BEFORE the handler returned: Pi snapshots the
    // run's tools after awaiting before_agent_start, so the first request
    // deterministically carries the connected server's tools.
    expect(pi.tools.has("mcp__gated__echo")).toBe(true);
    expect(String(result?.systemPrompt ?? "")).toContain("BASE");
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
        baselinePi.printCtx(),
      );
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
        mcpPi.printCtx(),
      );
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

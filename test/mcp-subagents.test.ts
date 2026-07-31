import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc, { type PiccTestSeam } from "../src/index.js";
import { PermissionEngine } from "../src/engine/permissions.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk, type FakeCustomTool, type FakeSdkHandle } from "./helpers/fake-sdk.js";
import { createMcpProcessFixture, type McpProcessFixture } from "./helpers/mcp-process.js";
import type { PiSdk } from "../src/runtime/subagents.js";
import type { McpLifecycleState, McpToolInfo } from "../src/runtime/mcp.js";
import { deferred, waitUntil } from "./helpers/async.js";

/**
 * Subagent MCP integration: inheritance, restriction, and drop of
 * `mcp__<server>__<tool>` names through the existing gateTools machinery, and
 * per-dispatch proxy provisioning over the session-global runtime.
 *
 * Layer 1: gateTools rows with live MCP names in the known-tool universe
 * (matrix style of the gateTools rows in test/permissions.test.ts; kept beside
 * the wired tests so MCP subagent coverage lives in one file).
 *
 * Layer 2: the real extension (`picc(pi)`) against a real fixture stdio
 * server, with dispatch driven through the registered Agent tool over the
 * fake-SDK seam (`setSdkForTest`) — inherit / restrict / drop observed on the
 * actual createAgentSession options, a live in-subagent round-trip through the
 * shared runtime, and the dispatch-installed guard blocking a denied MCP call.
 */

// ---------------------------------------------------------------------------
// Layer 1 — gateTools with MCP names in the universe
// ---------------------------------------------------------------------------

describe("gateTools over a universe containing live MCP names", () => {
  const CWD = process.cwd();
  const rules = (r: Partial<{ allow: string[]; deny: string[]; ask: string[] }> = {}) => ({
    allow: r.allow ?? [],
    deny: r.deny ?? [],
    ask: r.ask ?? [],
    additionalDirectories: [] as string[],
  });
  const MCP_KNOWN = ["mcp__fixture__echo", "mcp__fixture__report-env", "mcp__other__run"];
  const known = ["Read", "Bash", ...MCP_KNOWN];
  const engine = new PermissionEngine(rules(), { cwd: CWD });

  it("unspecified tools: (granted undefined) inherits every MCP name", () => {
    expect(engine.gateTools(undefined, undefined, known)).toEqual(known);
  });

  it("tools: [mcp__fixture] restricts to that server's tools (bare-server fan-out)", () => {
    expect(engine.gateTools(["mcp__fixture"], undefined, known)).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__report-env",
    ]);
  });

  it("an exact mcp__server__tool grant covers only that tool", () => {
    expect(engine.gateTools(["Read", "mcp__fixture__echo"], undefined, known)).toEqual([
      "Read",
      "mcp__fixture__echo",
    ]);
  });

  it("disallowedTools: [mcp__fixture] drops the whole server, keeps the rest", () => {
    expect(engine.gateTools(undefined, ["mcp__fixture"], known)).toEqual([
      "Read",
      "Bash",
      "mcp__other__run",
    ]);
  });

  it("a bare settings deny removes a server's MCP names even when explicitly granted", () => {
    const denyEngine = new PermissionEngine(rules({ deny: ["mcp__fixture"] }), { cwd: CWD });
    expect(denyEngine.gateTools(["mcp__fixture", "Read"], undefined, known)).toEqual(["Read"]);
  });

  it("a broad mcp__* deny removes every MCP name from the universe", () => {
    const broadEngine = new PermissionEngine(rules({ deny: ["mcp__*"] }), { cwd: CWD });
    expect(broadEngine.gateTools(undefined, undefined, known)).toEqual(["Read", "Bash"]);
  });

  it("an exact MCP deny removes only that tool", () => {
    const exactEngine = new PermissionEngine(rules({ deny: ["mcp__fixture__echo"] }), { cwd: CWD });
    expect(exactEngine.gateTools(undefined, undefined, known)).toEqual([
      "Read",
      "Bash",
      "mcp__fixture__report-env",
      "mcp__other__run",
    ]);
  });

  it("a specifier'd MCP deny does NOT remove at gating (stays a call-time guard block)", () => {
    const scopedEngine = new PermissionEngine(rules({ deny: ["mcp__fixture__echo(text:secret*)"] }), {
      cwd: CWD,
    });
    expect(scopedEngine.gateTools(undefined, undefined, known)).toEqual(known);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — wired dispatch over a real fixture server
// ---------------------------------------------------------------------------

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

const originalCwd = process.cwd();
const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

afterAll(() => {
  process.chdir(originalCwd);
  if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
  else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
  for (const dir of tempDirs) {
    try {
      // Same Windows retry discipline as the MCP registration tests: the load's
      // fire-and-forget orphan reap runs short-lived `git` children inside the
      // project dir, and a still-running child fails the top-level rmdir EPERM.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});

describe("subagent MCP identity across remote lifecycle states (fake runtime)", () => {
  type Runtime = NonNullable<PiccTestSeam["mcpRuntime"]>;

  it("builds distinct proxies over one stable permission universe while connected, reconnecting, and failed", async () => {
    const savedForkGate = process.env.CLAUDE_CODE_FORK_SUBAGENT;
    delete process.env.CLAUDE_CODE_FORK_SUBAGENT;
    const dir = makeTempDir("picc-remotesub-");
    const userDir = makeTempDir("picc-remotesub-user-");
    writeProjectFile(dir, "CLAUDE.md", "REMOTE-SUB-PROJECT\n");
    writeProjectFile(
      dir,
      ".claude/agents/inheritor.md",
      "---\nname: inheritor\ndescription: inherits tools\n---\nStable universe.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/server-only.md",
      "---\nname: server-only\ndescription: server tools only\ntools: mcp__remote\n---\nStable universe.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/dropper.md",
      "---\nname: dropper\ndescription: no remote tools\ndisallowedTools: mcp__remote\n---\nStable universe.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/resource-list.md",
      "---\nname: resource-list\ndescription: list resources only\ntools: ListMcpResourcesTool\n---\nList resources.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/resource-read.md",
      "---\nname: resource-read\ndescription: read resources only\ntools: ReadMcpResourceTool\n---\nRead resources.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/resource-drop-read.md",
      "---\nname: resource-drop-read\ndescription: inherit except resource reads\ndisallowedTools: ReadMcpResourceTool\n---\nDo not read resources.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/resource-drop-list.md",
      "---\nname: resource-drop-list\ndescription: inherit except resource lists\ndisallowedTools: ListMcpResourcesTool\n---\nDo not list resources.\n",
    );
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);

    const catalog: McpToolInfo[] = [
      { serverName: "remote", toolName: "echo", description: "echo", inputSchema: { type: "object" } },
      { serverName: "remote", toolName: "search", description: "search", inputSchema: { type: "object" } },
    ];
    let state: McpLifecycleState = "connected";
    const runtime: Runtime = {
      whenSettled: async () => {},
      tools: () => catalog,
      prompts: () => [],
      resourceServers: () => [{ serverName: "remote", resources: [] }],
      getPrompt: async () => { throw new Error("unreachable"); },
      readResource: async () => ({ contents: [{ uri: "test:", text: "resource" }] }),
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      diagnostics: () => [],
      serverStates: () => [{ name: "remote", transport: "http", state }],
      shutdown: async () => {},
    };
    const handle = fakeSdk({ onPrompt: async () => "DONE" });
    const pi = fakePi();
    let internals!: Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];
    try {
      picc(pi.api as never, {
        mcpRuntime: runtime,
        sdk: handle.sdk,
        onWired: (wired) => { internals = wired; },
        onInitializationSettled: pi.captureInitialization,
      });
      await pi.waitForInitialization();
      await pi.waitForTools([
        "Agent",
        "mcp__remote__echo",
        "mcp__remote__search",
        "ListMcpResourcesTool",
        "ReadMcpResourceTool",
      ]);
      internals.subagentRuntime.setSdkForTest(handle.sdk);
      const mainEcho = pi.tools.get("mcp__remote__echo");
      const expected = ["mcp__remote__echo", "mcp__remote__search"];
      const childEchoes: unknown[] = [];
      const childResourceLists: unknown[] = [];
      const childResourceReads: unknown[] = [];

      for (const lifecycle of ["connected", "reconnecting", "failed"] as const) {
        state = lifecycle;
        await pi.tools.get("Agent").execute(`dispatch-${lifecycle}`, {
          subagent_type: "inheritor",
          prompt: lifecycle,
          run_in_background: false,
        });
        const created = handle.created.at(-1)!;
        const remoteTools = (created.customTools as FakeCustomTool[])
          .filter((tool) => tool.name.startsWith("mcp__remote__"));
        expect(remoteTools.map((tool) => tool.name).sort(), lifecycle).toEqual(expected);
        expect((created.tools as string[]).filter((name) => name.startsWith("mcp__remote__")).sort(), lifecycle)
          .toEqual(expected);
        const childEcho = remoteTools.find((tool) => tool.name === "mcp__remote__echo");
        expect(childEcho).not.toBe(mainEcho);
        childEchoes.push(childEcho);
        const childResourceList = (created.customTools as FakeCustomTool[])
          .find((tool) => tool.name === "ListMcpResourcesTool");
        expect(childResourceList).toBeDefined();
        expect(childResourceList).not.toBe(pi.tools.get("ListMcpResourcesTool"));
        childResourceLists.push(childResourceList);
        const childResourceRead = (created.customTools as FakeCustomTool[])
          .find((tool) => tool.name === "ReadMcpResourceTool");
        expect(childResourceRead).toBeDefined();
        expect(childResourceRead).not.toBe(pi.tools.get("ReadMcpResourceTool"));
        childResourceReads.push(childResourceRead);
      }
      expect(new Set(childEchoes).size).toBe(3);
      expect(new Set(childResourceLists).size).toBe(3);
      expect(new Set(childResourceReads).size).toBe(3);
      expect(pi.tools.get("mcp__remote__echo")).toBe(mainEcho);

      await pi.tools.get("Agent").execute("dispatch-server-only", {
        subagent_type: "server-only", prompt: "failed", run_in_background: false,
      });
      expect((handle.created.at(-1)!.customTools as FakeCustomTool[]).map((tool) => tool.name).sort())
        .toEqual(expected);
      await pi.tools.get("Agent").execute("dispatch-dropper", {
        subagent_type: "dropper", prompt: "failed", run_in_background: false,
      });
      expect((handle.created.at(-1)!.customTools as FakeCustomTool[])
        .some((tool) => tool.name.startsWith("mcp__remote__"))).toBe(false);

      for (const [agent, expectedResource] of [
        ["resource-list", "ListMcpResourcesTool"],
        ["resource-read", "ReadMcpResourceTool"],
      ] as const) {
        await pi.tools.get("Agent").execute(`dispatch-${agent}`, {
          subagent_type: agent, prompt: agent, run_in_background: false,
        });
        expect((handle.created.at(-1)!.customTools as FakeCustomTool[]).map((tool) => tool.name))
          .toEqual([expectedResource]);
      }
      for (const [agent, retained, dropped] of [
        ["resource-drop-read", "ListMcpResourcesTool", "ReadMcpResourceTool"],
        ["resource-drop-list", "ReadMcpResourceTool", "ListMcpResourcesTool"],
      ] as const) {
        await pi.tools.get("Agent").execute(`dispatch-${agent}`, {
          subagent_type: agent, prompt: agent, run_in_background: false,
        });
        const names = (handle.created.at(-1)!.customTools as FakeCustomTool[])
          .map((tool) => tool.name);
        expect(names).toContain(retained);
        expect(names).not.toContain(dropped);
      }

      const beforeBackground = handle.created.length;
      await pi.tools.get("Agent").execute("dispatch-background", {
        subagent_type: "inheritor", prompt: "background", run_in_background: true,
      });
      await waitUntil({
        description: "background child session creation",
        predicate: () => handle.created.length > beforeBackground,
        describeObserved: () => String(handle.created.length),
      });
      const backgroundNames = (handle.created.at(-1)!.customTools as FakeCustomTool[])
        .map((tool) => tool.name);
      expect(backgroundNames).not.toContain("ListMcpResourcesTool");
      expect(backgroundNames).not.toContain("ReadMcpResourceTool");
      expect(backgroundNames).toContain("mcp__remote__echo");

      await pi.fire("session_start", {}, pi.ctx({
        sessionManager: { getSessionFile: () => path.join(dir, "parent.jsonl") },
      }));
      await pi.tools.get("Agent").execute("dispatch-fork-foreground", {
        subagent_type: "fork", prompt: "fork foreground", run_in_background: false,
      });
      const foregroundForkNames = (handle.created.at(-1)!.customTools as FakeCustomTool[])
        .map((tool) => tool.name);
      expect(foregroundForkNames).toEqual(expect.arrayContaining([
        "ListMcpResourcesTool", "ReadMcpResourceTool", "mcp__remote__echo",
      ]));

      const beforeDefaultFork = handle.created.length;
      await pi.tools.get("Agent").execute("dispatch-fork-default-background", {
        subagent_type: "fork", prompt: "fork default background",
      });
      await waitUntil({
        description: "default-background conversation fork child creation",
        predicate: () => handle.created.length > beforeDefaultFork,
        describeObserved: () => String(handle.created.length),
      });
      const defaultForkNames = (handle.created.at(-1)!.customTools as FakeCustomTool[])
        .map((tool) => tool.name);
      expect(defaultForkNames).toEqual(expect.arrayContaining([
        "ListMcpResourcesTool", "ReadMcpResourceTool", "mcp__remote__echo",
      ]));
    } finally {
      await pi.fire("session_shutdown", { reason: "other" }, pi.printCtx());
      process.chdir(originalCwd);
      if (savedForkGate === undefined) delete process.env.CLAUDE_CODE_FORK_SUBAGENT;
      else process.env.CLAUDE_CODE_FORK_SUBAGENT = savedForkGate;
    }
  }, 30_000);
});

describe("subagent fixed resource restrictions", () => {
  type Runtime = NonNullable<PiccTestSeam["mcpRuntime"]>;
  const resourceNames = ["ListMcpResourcesTool", "ReadMcpResourceTool"] as const;

  function resourceRuntime(): Runtime {
    return {
      whenSettled: async () => {},
      tools: () => [],
      prompts: () => [],
      resourceServers: () => [{ serverName: "fixture", resources: [] }],
      getPrompt: async () => ({ messages: [] }),
      readResource: async () => ({ contents: [] }),
      callTool: async () => ({ content: [] }),
      diagnostics: () => [],
      serverStates: () => [{
        name: "fixture", transport: "stdio", state: "connected",
        resourcesAdvertised: true, resourceCount: 0,
      }],
      shutdown: async () => {},
    };
  }

  async function childTools(options: {
    deny?: string;
    agents: Record<string, string>;
    dispatch: readonly string[];
  }): Promise<string[][]> {
    const dir = makeTempDir("picc-resource-restrict-");
    const userDir = makeTempDir("picc-resource-restrict-user-");
    writeProjectFile(dir, "CLAUDE.md", "RESOURCE-RESTRICTION\n");
    if (options.deny) {
      writeProjectFile(dir, ".claude/settings.json", JSON.stringify({
        permissions: { deny: [options.deny] },
      }));
    }
    for (const [name, frontmatter] of Object.entries(options.agents)) {
      writeProjectFile(dir, `.claude/agents/${name}.md`, `---\nname: ${name}\ndescription: ${name}\n${frontmatter}---\nRestricted child.\n`);
    }
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    const handle = fakeSdk({ onPrompt: async () => "DONE" });
    const pi = fakePi();
    let internals!: Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];
    try {
      picc(pi.api as never, {
        mcpRuntime: resourceRuntime(),
        sdk: handle.sdk,
        onWired: (wired) => { internals = wired; },
        onInitializationSettled: pi.captureInitialization,
      });
      await pi.waitForInitialization();
      await pi.waitForTools([
        "Agent",
        ...resourceNames.filter((name) => name !== options.deny),
      ]);
      internals.subagentRuntime.setSdkForTest(handle.sdk);
      const rows: string[][] = [];
      for (const agent of options.dispatch) {
        await pi.tools.get("Agent").execute(`dispatch-${agent}`, {
          subagent_type: agent, prompt: agent, run_in_background: false,
        });
        rows.push((handle.created.at(-1)!.customTools as FakeCustomTool[]).map((tool) => tool.name));
      }
      return rows;
    } finally {
      await pi.fire("session_shutdown", { reason: "other" }, pi.printCtx());
      process.chdir(originalCwd);
    }
  }

  it.each(resourceNames)("an exact settings deny for %s removes only that fixed resource name from a child", async (denied) => {
    const [names] = await childTools({
      deny: denied,
      agents: { inheritor: "" },
      dispatch: ["inheritor"],
    });
    expect(names).not.toContain(denied);
    expect(names).toContain(resourceNames.find((name) => name !== denied));
  }, 30_000);

  it("empty and unrelated tools: child rows receive no fixed resource tools", async () => {
    const [emptyNames, unrelatedNames] = await childTools({
      agents: {
        empty: "tools: []\n",
        unrelated: "tools: Read\n",
      },
      dispatch: ["empty", "unrelated"],
    });
    for (const names of [emptyNames, unrelatedNames]) {
      expect(names).not.toContain("ListMcpResourcesTool");
      expect(names).not.toContain("ReadMcpResourceTool");
    }
    expect(emptyNames).toEqual([]);
    expect(unrelatedNames).toContain("read");
  }, 30_000);
});

describe("deferred first typed fork MCP settlement", () => {
  type Runtime = NonNullable<PiccTestSeam["mcpRuntime"]>;

  it("waits for exposure before snapshotting the fork's resources and existing MCP proxy", async () => {
    const dir = makeTempDir("picc-mcp-typed-fork-");
    const userDir = makeTempDir("picc-mcp-typed-fork-user-");
    writeProjectFile(dir, "CLAUDE.md", "MCP-TYPED-FORK\n");
    writeProjectFile(dir, ".claude/skills/fork-mcp/SKILL.md", [
      "---", "name: fork-mcp", "description: fork after MCP settlement", "context: fork", "---",
      "Use the settled MCP surface for $ARGUMENTS.", "",
    ].join("\n"));
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    const settled = deferred<void>();
    const runtime: Runtime = {
      whenSettled: () => settled.promise,
      tools: () => [{ serverName: "fixture", toolName: "echo", description: "echo", inputSchema: { type: "object" } }],
      prompts: () => [],
      resourceServers: () => [{ serverName: "fixture", resources: [] }],
      getPrompt: async () => ({ messages: [] }), readResource: async () => ({ contents: [] }),
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      diagnostics: () => [],
      serverStates: () => [{ name: "fixture", transport: "stdio", state: "connecting" }],
      shutdown: async () => {},
    };
    const handle = fakeSdk({ onPrompt: async () => "FORK-DONE" });
    const localPi = fakePi();
    try {
      picc(localPi.api as never, {
        mcpRuntime: runtime,
        sdk: handle.sdk,
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      const input = localPi.fire("input", {
        source: "user", text: "/fork-mcp inspect",
      }, localPi.printCtx());
      await Promise.resolve();
      expect(handle.created).toHaveLength(0);
      settled.resolve();
      const result = await input;
      expect(result).toMatchObject({ action: "transform" });
      expect(result.text).toContain("FORK-DONE");
      await waitUntil({
        description: "typed context fork child creation after MCP settlement",
        predicate: () => handle.created.length === 1,
        describeObserved: () => String(handle.created.length),
      });
      const names = (handle.created[0]!.customTools as FakeCustomTool[]).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "mcp__fixture__echo", "ListMcpResourcesTool", "ReadMcpResourceTool",
      ]));
    } finally {
      settled.resolve();
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
      process.chdir(originalCwd);
    }
  }, 30_000);
});

describe("subagent MCP tool provisioning (wired)", () => {
  type Internals = Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];
  type ExtensionFactory = { name: string; factory: (pi: unknown) => unknown };

  let dir: string;
  let fixture: McpProcessFixture;
  let pi: FakePi;
  let handle: FakeSdkHandle;
  let internals: Internals;
  // Options of every DefaultResourceLoader the dispatch path constructs — the
  // fake loader never RUNS extensionFactories, so tests that need the child
  // guard invoke the captured factory themselves (see the deny test below).
  const loaderOptions: Array<Record<string, unknown>> = [];

  const FIXTURE_TOOLS = [
    "mcp__fixture__echo",
    "mcp__fixture__report-env",
    "mcp__fixture__big-output",
  ];

  beforeAll(async () => {
    dir = makeTempDir("picc-mcpsub-");
    fixture = createMcpProcessFixture(makeTempDir("picc-mcpsub-fx-"));
    writeProjectFile(dir, "CLAUDE.md", "MCP-SUB-PROJECT\n");
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
        },
      }),
    );
    // The denied server name is deliberately NOT a configured server: the BARE
    // deny grammar this feature specs also removes the tool from context at
    // gating, so for those rules a call-time block on a granted tool never
    // fires — the scenario here is the model hallucinating a denied name.
    // The guard is still a real backstop for granted tools: specifier'd denies
    // (e.g. `mcp__s__t(key:value)`) deliberately do NOT remove at gating, and
    // skill-activation deny rules arrive after dispatch-time gating.
    writeProjectFile(
      dir,
      ".claude/settings.json",
      JSON.stringify({ permissions: { deny: ["mcp__denied"] } }),
    );
    writeProjectFile(
      dir,
      ".claude/agents/inheritor.md",
      "---\nname: inheritor\ndescription: inherits every tool\n---\nYou inherit.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/reader.md",
      "---\nname: reader\ndescription: read-only\ntools: Read\n---\nYou read.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/fixture-only.md",
      "---\nname: fixture-only\ndescription: MCP server only\ntools: mcp__fixture\n---\nYou call MCP.\n",
    );
    writeProjectFile(
      dir,
      ".claude/agents/dropper.md",
      "---\nname: dropper\ndescription: drops the fixture server\ndisallowedTools: mcp__fixture\n---\nYou dropped MCP.\n",
    );
    const userDir = makeTempDir("picc-mcpsub-user-");
    // Approval from a user-authored scope — project scope cannot self-approve.
    writeProjectFile(userDir, "settings.json", JSON.stringify({ enabledMcpjsonServers: ["fixture"] }));
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);

    handle = fakeSdk({
      onPrompt: async (text, session) => {
        if (text.includes("CALL-ECHO")) {
          // In-subagent round-trip: the dispatched session calls its OWN MCP
          // proxy instance, which delegates to the session-global runtime.
          const echo = session.customTools.find((t) => t.name === "mcp__fixture__echo");
          if (!echo) return "NO-ECHO-TOOL";
          const result = await echo.execute("sub-call", { text: "sub-round-trip" });
          return `ECHOED:${result.content[0]?.text ?? ""}`;
        }
        return "SUB-DONE";
      },
    });
    pi = fakePi();
    picc(pi.api as never, {
      onWired: (i) => (internals = i),
      onInitializationSettled: pi.captureInitialization,
    });
    await pi.waitForInitialization();
    // Loader-capturing SDK override: identical to the shared fake except that
    // each dispatch's DefaultResourceLoader options (extensionFactories
    // included) are recorded for the guard test.
    const capturingSdk: PiSdk = {
      ...handle.sdk,
      DefaultResourceLoader: class {
        constructor(options: Record<string, unknown>) {
          loaderOptions.push(options);
        }
        async reload(): Promise<void> {}
      },
    };
    internals.subagentRuntime.setSdkForTest(capturingSdk);
    // The MCP settle barrier: once the proxies are registered, the runtime has
    // settled, so dispatch-time gating sees the connected server's names.
    await pi.waitForTools(["Agent", ...FIXTURE_TOOLS]);
  }, 30_000);

  afterAll(async () => {
    process.chdir(originalCwd);
    try {
      await pi.fire("session_shutdown", { reason: "other" }, pi.printCtx());
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  async function dispatch(subagentType: string, prompt: string) {
    const agentTool = pi.tools.get("Agent");
    return agentTool.execute(`dispatch-${subagentType}`, {
      subagent_type: subagentType,
      prompt,
      run_in_background: false,
    });
  }

  function lastCustomToolNames(): string[] {
    const created = handle.created.at(-1)!;
    return (created.customTools as FakeCustomTool[]).map((t) => t.name);
  }

  it("an unspecified-tools: agent inherits the MCP proxies and calls one through the shared runtime", async () => {
    const result = await dispatch("inheritor", "CALL-ECHO now");
    const text = (result.content as Array<{ text?: string }>)
      .map((c) => String(c.text ?? ""))
      .join("\n");
    expect(text).toContain("ECHOED:sub-round-trip");

    const created = handle.created.at(-1)!;
    const custom = lastCustomToolNames();
    expect(custom).toEqual(expect.arrayContaining(FIXTURE_TOOLS));
    // The session `tools:` allowlist carries the MCP names too — Pi filters
    // customTools by that list, so an absent name would drop the proxy.
    expect(created.tools as string[]).toEqual(expect.arrayContaining(FIXTURE_TOOLS));
    // No name of the denied server ever reaches a dispatch.
    expect(custom.filter((n) => n.startsWith("mcp__denied"))).toEqual([]);
  });

  it("a tools: [Read] agent receives no MCP tool (restriction), while its granted built-in survives", async () => {
    await dispatch("reader", "restricted run");
    const custom = lastCustomToolNames();
    expect(custom.some((n) => n.startsWith("mcp__"))).toBe(false);
    // Non-vacuous: the dispatch really provisioned tools — the granted Read
    // built-in (Pi name "read") is present.
    expect(custom).toContain("read");
  });

  it("a bare tools: mcp__fixture grant fans out to exactly the server's tools", async () => {
    await dispatch("fixture-only", "server-scoped run");
    const custom = lastCustomToolNames();
    expect([...custom].sort()).toEqual([...FIXTURE_TOOLS].sort());
  });

  it("disallowedTools: mcp__fixture removes every fixture tool from an otherwise-inheriting agent", async () => {
    await dispatch("dropper", "dropped run");
    const custom = lastCustomToolNames();
    expect(custom.some((n) => n.startsWith("mcp__"))).toBe(false);
    // The drop was surgical: the rest of the inherited surface stays.
    expect(custom).toContain("read");
    expect(custom).toContain("bash");
  });

  it("the dispatch-installed guard blocks a denied MCP call inside the subagent", async () => {
    await dispatch("inheritor", "guard run");
    const factories = loaderOptions.at(-1)!.extensionFactories as ExtensionFactory[];
    const guard = factories.find((f) => f.name.startsWith("picc-guard-"));
    expect(guard).toBeDefined();

    // Install the REAL guard factory this dispatch built onto a recorder pi and
    // drive its tool_call handler directly — the fake loader never runs it.
    type ToolCallHandler = (
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Promise<{ block?: boolean; reason?: string } | undefined>;
    const handlers = new Map<string, ToolCallHandler>();
    const recorder = {
      on: (name: string, handler: ToolCallHandler) => {
        handlers.set(name, handler);
      },
      sendMessage: () => {},
    };
    guard!.factory(recorder);
    const toolCall = handlers.get("tool_call");
    expect(toolCall).toBeDefined();

    const blocked = await toolCall!({ toolName: "mcp__denied__slow", toolCallId: "deny-1", input: {} }, {});
    expect(blocked).toMatchObject({ block: true });
    expect(String(blocked?.reason)).toContain("mcp__denied");

    // Positive control: the granted fixture tool passes the same guard.
    const allowed = await toolCall!(
      { toolName: "mcp__fixture__echo", toolCallId: "allow-1", input: { text: "x" } },
      {},
    );
    expect(allowed?.block).not.toBe(true);
  });
});

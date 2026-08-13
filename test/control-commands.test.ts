import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import picc, { type PiccTestSeam } from "../src/index.js";
import { sanitizePluginDataKey } from "../src/claude/plugin-paths.js";
import type { ManagedMcpIo } from "../src/claude/managed-mcp.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { deferred } from "./helpers/async.js";
import { fakeSdk } from "./helpers/fake-sdk.js";
import { createHookProcessFixture } from "./helpers/hook-process.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";
import { loadClaudeProject } from "../src/project.js";

/**
 * Control commands render through transcript entries outside model context.
 * Registered routing serves Pi-owned command handling; admitted-input routing
 * protects headless and protocol modes. Each mode may impose distinct timing
 * and output-transport requirements.
 */

let dir: string;
let pi: FakePi;
const originalCwd = process.cwd();
const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

beforeAll(async () => {
  dir = materializeFixture("full-surface");
  // Hermetic user scope: don't absorb the developer's real ~/.claude.
  const userDir = path.join(dir, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);
  pi = fakePi();
  picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
  await pi.waitForInitialization();
  await pi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
});

afterAll(() => {
  process.chdir(originalCwd);
  if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
  else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
  cleanupFixture(dir);
});

function reset() {
  pi.messages.length = 0;
  pi.entries.length = 0;
}

function controlEntry(command: string, owner: FakePi = pi) {
  return owner.entries.find((e) => e.customType === "picc-control" && e.data?.command === command);
}

function installPluginFixture(
  projectRoot: string,
  pluginId: string,
  manifestName: string,
  populate: (installRoot: string) => void,
): string {
  const userDir = path.join(projectRoot, ".claude-user");
  const separator = pluginId.lastIndexOf("@");
  const entryName = pluginId.slice(0, separator);
  const marketplace = pluginId.slice(separator + 1);
  const installRoot = path.join(userDir, "plugins", "cache", marketplace, entryName, "1.0.0");
  fs.mkdirSync(path.join(installRoot, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(installRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: manifestName }),
    "utf8",
  );
  populate(installRoot);

  const settingsPath = path.join(userDir, "settings.json");
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { enabledPlugins?: Record<string, boolean> }
    : {};
  settings.enabledPlugins = { ...settings.enabledPlugins, [pluginId]: true };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");

  const statePath = path.join(userDir, "plugins", "installed_plugins.json");
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8")) as { version: number; plugins: Record<string, unknown[]> }
    : { version: 2, plugins: {} };
  state.plugins[pluginId] = [{ scope: "user", installPath: installRoot, version: "1.0.0" }];
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
  return installRoot;
}

async function freshControlPi(
  seam?: PiccTestSeam,
  setup?: (root: string) => void,
): Promise<{ fresh: FakePi; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-control-"));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "Temporary control-command project.\n", "utf8");
  setup?.(root);
  const userDir = path.join(root, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  const previousCwd = process.cwd();
  process.chdir(root);
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  const fresh = fakePi();
  picc(fresh.api as never, { ...seam, onInitializationSettled: fresh.captureInitialization });
  await fresh.waitForInitialization();
  process.chdir(previousCwd);
  return { fresh, root };
}

describe("control commands render transcript output outside model context", () => {
  it("/skills via the input event renders a picc-control entry and short-circuits", async () => {
    reset();
    const outcome = await pi.fire("input", { text: "/skills", source: "interactive" });

    // Short-circuited: the handler answered instead of producing a model turn.
    expect(outcome).toEqual({ action: "handled" });

    const entry = controlEntry("skills");
    expect(entry, "expected a picc-control entry for /skills").toBeDefined();
    const output = String(entry?.data?.output ?? "");
    expect(output).toContain("skill(s) loaded");
    expect(output).toContain("/deploy");

    // Control output is user-facing status — it must never enter LLM context.
    expect(pi.messages).toHaveLength(0);
  });

  it("/agents via the input event renders a picc-control entry", async () => {
    reset();
    const outcome = await pi.fire("input", { text: "/agents", source: "interactive" });

    expect(outcome).toEqual({ action: "handled" });
    const entry = controlEntry("agents");
    expect(entry, "expected a picc-control entry for /agents").toBeDefined();
    expect(String(entry?.data?.output ?? "")).toContain("reviewer");
    expect(pi.messages).toHaveLength(0);
  });

  it("/usage via the input event is intercepted (print/non-interactive mode) and never leaks to the model", async () => {
    // Regression guard: /usage was registered as a command but MISSING
    // from the input-handler control-command interceptor, so in print mode it fell
    // through to the model instead of being short-circuited.
    reset();
    const outcome = await pi.fire("input", { text: "/usage", source: "print" });

    expect(outcome).toEqual({ action: "handled" });
    const entry = controlEntry("usage");
    expect(entry, "expected a picc-control entry for /usage").toBeDefined();
    expect(String(entry?.data?.output ?? "")).toContain("subagent");
    expect(pi.messages, "/usage must not leak to the model").toHaveLength(0);
  });

  it("/doctor via the registered command handler displays immediately (regression: was queued for the next turn)", async () => {
    reset();
    const command = pi.commands.get("doctor");
    expect(command, "expected a registered /doctor command").toBeDefined();

    await command.handler("", pi.ctx());

    const entry = controlEntry("doctor");
    expect(entry, "expected a picc-control entry appended synchronously").toBeDefined();
    expect(String(entry?.data?.output ?? "")).toContain("PiCC compatibility report");
    // Nothing queued as a (deferred) LLM message.
    expect(pi.messages).toHaveLength(0);
  });

  it("every control command is registered and produces transcript entry output", async () => {
    for (const name of ["doctor", "quota", "skills", "agents", "usage", "mcp"]) {
      reset();
      const command = pi.commands.get(name);
      expect(command, `expected /${name} to be registered`).toBeDefined();
      await command.handler("", pi.tuiCtx());
      expect(controlEntry(name), `expected /${name} to append a picc-control entry`).toBeDefined();
      expect(pi.messages, `/${name} must not send LLM-context messages`).toHaveLength(0);
    }
  });

  it("the picc-control entry renderer turns an entry into visible lines", () => {
    const renderer = pi.entryRenderers.get("picc-control");
    expect(renderer, "expected an entry renderer for picc-control").toBeDefined();

    const theme = { fg: (_color: string, text: string) => text };
    const component = renderer!(
      { data: { command: "doctor", output: "first line\nsecond line" } },
      { expanded: false },
      theme,
    );
    const lines: string[] = component.render(80);
    expect(lines[0]).toContain("/doctor");
    expect(lines).toContain("first line");
    expect(lines).toContain("second line");
  });

  it("does not register or render /compat as a PiCC control surface", () => {
    expect(pi.commands.has("compat")).toBe(false);
    expect(pi.entryRenderers.has("picc-compat")).toBe(false);
  });

  it("allows a project skill named compat into autocomplete and the ordinary slash transform", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "picc-compat-skill-"));
    const skillDir = path.join(project, ".claude", "skills", "compat");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "Temporary compat-skill project.\n", "utf8");
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\ndescription: User compat skill\nargument-hint: [topic]\n---\nCOMPAT-SKILL-BODY $ARGUMENTS\n",
      "utf8",
    );

    const previousCwd = process.cwd();
    try {
      process.chdir(project);
      const fresh = fakePi();
      picc(fresh.api as never, { onInitializationSettled: fresh.captureInitialization });
      await fresh.waitForInitialization();
      const resources = await fresh.fire("resources_discover", { reason: "startup" });
      const promptDir = resources.promptPaths[0] as string;
      expect(fs.existsSync(path.join(promptDir, "compat.md"))).toBe(true);
      expect(fresh.commands.has("compat")).toBe(false);

      const outcome = await fresh.fire("input", { text: "/compat details", source: "interactive" });
      expect(outcome.action).toBe("transform");
      expect(String(outcome.text)).toContain("COMPAT-SKILL-BODY details");
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("does not treat a real skill slash command as a control command (it transforms)", async () => {
    // Contrast: /deploy is a project skill, so it expands into a model turn
    // rather than being short-circuited as a control command.
    const outcome = await pi.fire("input", { text: "/deploy staging 1.0", source: "interactive" });
    expect(outcome.action).toBe("transform");
    expect(String(outcome.text ?? "")).toContain("FS-SKILL-ARGS-BODY");
  });
});

describe("/mcp timing, transport, exactness, and fail-closed handling", () => {
  it("registered TUI and admitted RPC render immediate snapshots without settlement or raw text", async () => {
    let waits = 0;
    const settlement = deferred<void>();
    const writes: string[] = [];
    const { fresh, root } = await freshControlPi({
      mcpControl: {
        whenSettled: async () => { waits += 1; await settlement.promise; },
        render: () => "MCP status (read-only)\n- fixture: connecting",
        writeText: (output) => { writes.push(output); },
      },
    });
    try {
      await fresh.commands.get("mcp").handler("", fresh.tuiCtx());
      expect(String(fresh.entries.at(-1)?.data.output)).toContain("connecting");
      const rpc = await fresh.fire("input", { text: "/MCP", source: "rpc" }, fresh.rpcCtx());
      expect(rpc).toEqual({ action: "handled" });
      expect(String(fresh.entries.at(-1)?.data.output)).toContain("connecting");
      expect(waits).toBe(0);
      expect(writes).toEqual([]);
      expect(fresh.messages).toEqual([]);
    } finally {
      settlement.resolve();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["print", "json"] as const)("bare %s input waits for settlement before reporting", async (mode) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const writes: string[] = [];
    const { fresh, root } = await freshControlPi({
      mcpControl: {
        whenSettled: async () => { entered.resolve(); await release.promise; },
        render: () => "MCP status (read-only)\n- fixture: connected; 3 tools",
        writeText: (output) => { writes.push(output); },
      },
    });
    try {
      const firing = fresh.fire(
        "input",
        { text: "  /mCp  ", source: mode },
        fresh.ctx({ mode, hasUI: false }),
      );
      await entered.promise;
      expect(fresh.entries.filter((entry) => entry.data?.command === "mcp")).toEqual([]);
      expect(writes).toEqual([]);
      release.resolve();
      expect(await firing).toEqual({ action: "handled" });
      expect(String(fresh.entries.at(-1)?.data.output)).toContain("3 tools");
      expect(writes).toEqual(mode === "print" ? [expect.stringContaining("3 tools")] : []);
      expect(fresh.messages).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects arguments immediately in every transport without reflection, waiting, or rendering", async () => {
    let waits = 0;
    let renders = 0;
    const writes: string[] = [];
    const { fresh, root } = await freshControlPi({
      mcpControl: {
        whenSettled: async () => { waits += 1; },
        render: () => { renders += 1; return "unexpected"; },
        writeText: (output) => { writes.push(output); },
      },
    });
    const secret = "ARGUMENT_SECRET_CANARY";
    try {
      await fresh.commands.get("mcp").handler(secret, fresh.tuiCtx());
      for (const [mode, ctx] of [
        ["print", fresh.printCtx()],
        ["json", fresh.ctx({ mode: "json", hasUI: false })],
        ["rpc", fresh.rpcCtx()],
      ] as const) {
        const outcome = await fresh.fire("input", { text: `/mCp\t${secret}`, source: mode }, ctx);
        expect(outcome).toEqual({ action: "handled" });
      }
      expect(waits).toBe(0);
      expect(renders).toBe(0);
      const outputs = fresh.entries.map((entry) => String(entry.data?.output ?? ""));
      expect(outputs).toHaveLength(4);
      expect(outputs.every((output) => output.includes("status-only") && !output.includes(secret))).toBe(true);
      expect(writes).toHaveLength(1);
      expect(writes[0]).not.toContain(secret);
      expect(fresh.messages).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts whitespace-only tails and mixed case but does not intercept /mcpx", async () => {
    const { fresh, root } = await freshControlPi({ mcpControl: { render: () => "MCP SNAPSHOT" } });
    try {
      expect(await fresh.fire("input", { text: " \t/McP\t  ", source: "rpc" }, fresh.rpcCtx()))
        .toEqual({ action: "handled" });
      expect(String(fresh.entries.at(-1)?.data.output)).toBe("MCP SNAPSHOT");
      expect(await fresh.fire("input", { text: "/mcpx", source: "rpc" }, fresh.rpcCtx()))
        .toEqual({ action: "continue" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["unsupported arguments", "/mcp ARGUMENT_CANARY", false],
    ["processing failure", "/mcp", true],
  ] as const)("recognized /mcp %s skips hooks and colliding fork skills", async (_case, input, failRender) => {
    let hookFixture: ReturnType<typeof createHookProcessFixture> | undefined;
    const sdk = fakeSdk({ replies: ["FORK_ACTION_CANARY"] });
    const { fresh, root } = await freshControlPi(
      {
        sdk: sdk.sdk,
        mcpControl: {
          render: () => {
            if (failRender) throw new Error("PROCESSING_CANARY");
            return "UNEXPECTED_RENDER";
          },
        },
      },
      (projectRoot) => {
        hookFixture = createHookProcessFixture(projectRoot);
        const skillDir = path.join(projectRoot, ".claude", "skills", "mcp");
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          "---\ndescription: colliding fork\ncontext: fork\n---\nFORK_SKILL_BODY_CANARY\n",
        );
        fs.writeFileSync(
          path.join(projectRoot, ".claude", "settings.json"),
          JSON.stringify({
            env: hookFixture.env,
            hooks: {
              UserPromptSubmit: [{ hooks: [{
                type: "command",
                command: hookFixture.command,
                args: ["complete", "submit", "HOOK_ACTION_CANARY"],
              }] }],
            },
          }),
        );
      },
    );
    try {
      const result = await fresh.fire("input", { text: input, source: "interactive" }, fresh.tuiCtx());
      expect(result).toEqual({ action: "handled" });
      expect(hookFixture!.exists("submit.entered")).toBe(false);
      expect(hookFixture!.spawnedChildren()).toHaveLength(0);
      expect(sdk.created).toHaveLength(0);
      expect(fresh.messages).toEqual([]);
      expect(fresh.userMessages).toEqual([]);
      expect(JSON.stringify({ entries: fresh.entries, messages: fresh.messages, userMessages: fresh.userMessages, result }))
        .not.toMatch(/ARGUMENT_CANARY|PROCESSING_CANARY|HOOK_ACTION_CANARY|FORK_(?:ACTION|SKILL_BODY)_CANARY/);
    } finally {
      await hookFixture!.cleanup("submit");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["settlement", "json"],
    ["renderer", "json"],
    ["renderer", "rpc"],
  ] as const)("fails closed when %s fails in %s without raw text", async (fault, mode) => {
    const writes: string[] = [];
    const { fresh, root } = await freshControlPi({
      mcpControl: {
        whenSettled: async () => { if (fault === "settlement") throw new Error("SETTLEMENT_FAULT_CANARY"); },
        render: () => { if (fault === "renderer") throw new Error("RENDER_FAULT_CANARY"); return "status"; },
        writeText: (output) => { writes.push(output); },
      },
    });
    try {
      const ctx = mode === "json" ? fresh.ctx({ mode: "json", hasUI: false }) : fresh.rpcCtx();
      const outcome = await fresh.fire("input", { text: "/mcp", source: mode }, ctx);
      expect(outcome).toEqual({ action: "handled" });
      expect(String(fresh.entries.at(-1)?.data.output)).toContain("could not produce");
      expect(JSON.stringify(fresh.entries)).not.toMatch(/(?:SETTLEMENT|RENDER)_FAULT_CANARY/);
      expect(writes).toEqual([]);
      expect(fresh.messages).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed under append and stdout faults, including compound fallback faults", async () => {
    const writes: string[] = [];
    let writeAttempts = 0;
    let stdoutThrows = false;
    const { fresh, root } = await freshControlPi({
      mcpControl: {
        render: () => "status",
        writeText: (output) => {
          writeAttempts += 1;
          if (stdoutThrows) throw new Error("STDOUT_FAULT_CANARY");
          writes.push(output);
        },
      },
    });
    const append = fresh.api.appendEntry as (...args: unknown[]) => void;
    try {
      fresh.api.appendEntry = () => { throw new Error("APPEND_FAULT_CANARY"); };
      expect(await fresh.fire("input", { text: "/mcp", source: "print" }, fresh.printCtx()))
        .toEqual({ action: "handled" });
      expect(writes).toEqual([expect.stringContaining("could not produce")]);

      fresh.api.appendEntry = append;
      stdoutThrows = true;
      expect(await fresh.fire("input", { text: "/mcp", source: "print" }, fresh.printCtx()))
        .toEqual({ action: "handled" });
      expect(fresh.entries.some((entry) => String(entry.data?.output).includes("could not produce"))).toBe(true);

      const textWriteAttempts = writeAttempts;
      fresh.api.appendEntry = () => { throw new Error("APPEND_AND_FALLBACK_FAULT_CANARY"); };
      for (const ctx of [fresh.ctx({ mode: "json", hasUI: false }), fresh.rpcCtx()]) {
        expect(await fresh.fire("input", { text: "/mcp", source: ctx.mode }, ctx))
          .toEqual({ action: "handled" });
        expect(writeAttempts).toBe(textWriteAttempts);
      }

      const throwingCtx = fresh.tuiCtx({ ui: { notify: () => { throw new Error("FALLBACK_FAULT_CANARY"); } } });
      expect(await fresh.fire("input", { text: "/mcp", source: "interactive" }, throwingCtx))
        .toEqual({ action: "handled" });
      expect(writeAttempts).toBe(textWriteAttempts);
      expect(JSON.stringify({ entries: fresh.entries, messages: fresh.messages, writes }))
        .not.toMatch(/(?:STDOUT|APPEND|FALLBACK)_FAULT_CANARY/);
      expect(fresh.messages).toEqual([]);
    } finally {
      fresh.api.appendEntry = append;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("managed MCP snapshot status and aggregate startup notice", () => {
  const inertMcpRuntime = {
    whenSettled: async () => {},
    tools: () => [],
    prompts: () => [],
    resourceServers: () => [],
    callTool: async () => { throw new Error("inert MCP runtime"); },
    getPrompt: async () => { throw new Error("inert MCP runtime"); },
    readResource: async () => { throw new Error("inert MCP runtime"); },
    diagnostics: () => [],
    serverStates: () => [],
    shutdown: async () => {},
  };

  function managedMcpIo(text: string | undefined): ManagedMcpIo {
    if (text === undefined) return { open: () => ({ status: "absent" }) };
    const bytes = Buffer.from(text, "utf8");
    const metadata = { regular: true, size: bytes.length, identity: "managed-test", modified: "stable" };
    return {
      open: () => ({
        status: "opened",
        handle: {
          metadata: () => metadata,
          read: () => bytes,
          currentPathMetadata: () => metadata,
          close: () => true,
        },
      }),
    };
  }

  async function policySnapshotProject(options: {
    managed?: Record<string, unknown>;
    ordinary?: Record<string, unknown>;
    policy?: Record<string, unknown>;
  }): Promise<{ fresh: FakePi; root: string }> {
    const managedPaths: string[] = [];
    return await freshControlPi({
      mcpRuntime: inertMcpRuntime,
      managedSettingsPaths: managedPaths,
      managedArtifactDirs: [],
      managedMcpDiscovery: {
        testAuthority: {
          path: "/test/managed-mcp",
          io: managedMcpIo(options.managed === undefined
            ? undefined
            : JSON.stringify({ mcpServers: options.managed })),
        },
      },
    }, (root) => {
      if (options.ordinary) {
        const userDir = path.join(root, ".claude-user");
        fs.mkdirSync(userDir, { recursive: true });
        fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({ mcpServers: options.ordinary }));
      }
      if (options.policy) {
        const managed = path.join(root, "managed-policy.json");
        fs.writeFileSync(managed, JSON.stringify(options.policy));
        managedPaths.push(managed);
      }
    });
  }

  async function renderedMcpReports(fresh: FakePi): Promise<readonly string[]> {
    await fresh.commands.get("mcp").handler("", fresh.tuiCtx());
    await fresh.commands.get("doctor").handler("", fresh.tuiCtx());
    const reports = fresh.entries
      .filter((entry) => entry.data?.command === "mcp" || entry.data?.command === "doctor")
      .map((entry) => String(entry.data?.output ?? ""));
    expect(reports).toHaveLength(2);
    return reports;
  }

  async function mixedPolicyProject(): Promise<{ fresh: FakePi; root: string }> {
    const managedPaths: string[] = [];
    return await freshControlPi({
      managedSettingsPaths: managedPaths,
      managedArtifactDirs: [],
      managedMcpDiscovery: {
        testAuthority: { path: "/test/absent-managed-mcp", io: { open: () => ({ status: "absent" }) } },
      },
    }, (root) => {
      fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({
        mcpServers: {
          pending: { command: "PENDING_COMMAND_SECRET_CANARY", args: ["PENDING_ARG_SECRET_CANARY"] },
          blocked: { command: "BLOCKED_COMMAND_SECRET_CANARY" },
        },
      }));
      const managed = path.join(root, "managed-policy.json");
      fs.writeFileSync(managed, JSON.stringify({
        deniedMcpServers: [{ serverName: "blocked" }],
      }));
      managedPaths.push(managed);
    });
  }

  it("reports exclusive-empty once across startup and /new without model messages", async () => {
    const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const { fresh, root } = await policySnapshotProject({
      managed: {},
      ordinary: { ordinary: { command: "ordinary-command" } },
    });
    try {
      await fresh.fire("session_start", { reason: "startup" }, fresh.tuiCtx());
      await fresh.fire("session_start", { reason: "startup" }, fresh.tuiCtx());
      await fresh.fire("session_start", { reason: "new" }, fresh.tuiCtx());
      const notices = fresh.notifications.filter((item) => item.text.includes("empty exclusive server set"));
      expect(notices).toHaveLength(1);
      const reports = await renderedMcpReports(fresh);
      for (const report of reports) {
        expect(report).toContain("exclusive administrator server set is empty; all MCP is disabled");
        expect(report).toContain("If access is expected, request an administrator policy change.");
        expect(report).not.toContain('"ordinary":');
      }
      expect(fresh.messages).toEqual([]);
    } finally {
      await fresh.fire("session_shutdown", { reason: "other" }, fresh.printCtx());
      fs.rmSync(root, { recursive: true, force: true });
      if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
    }
  });

  it("keeps healthy populated-exclusive authority quiet while retaining only managed rows", async () => {
    const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const { fresh, root } = await policySnapshotProject({
      managed: { managed: { command: "managed-command" } },
      ordinary: { ordinary: { command: "ordinary-command" } },
    });
    try {
      await fresh.fire("session_start", { reason: "startup" }, fresh.tuiCtx());
      await fresh.fire("session_start", { reason: "new" }, fresh.tuiCtx());
      expect(fresh.notifications.filter((item) => item.text.includes("MCP"))).toEqual([]);
      const reports = await renderedMcpReports(fresh);
      for (const report of reports) {
        expect(report).toContain("exclusive administrator server set is active");
        expect(report).toContain('"managed":');
        expect(report).not.toContain('"ordinary":');
      }
      expect(fresh.messages).toEqual([]);
    } finally {
      await fresh.fire("session_shutdown", { reason: "other" }, fresh.printCtx());
      fs.rmSync(root, { recursive: true, force: true });
      if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
    }
  });

  it("reports an actually denied managed row once without /new replay", async () => {
    const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const blockedName = "managed-blocked";
    const { fresh, root } = await policySnapshotProject({
      managed: { [blockedName]: { command: "MANAGED_BLOCKED_COMMAND_CANARY" } },
      ordinary: { ordinary: { command: "ordinary-command" } },
      policy: { deniedMcpServers: [{ serverName: blockedName }] },
    });
    try {
      await fresh.fire("session_start", { reason: "startup" }, fresh.tuiCtx());
      await fresh.fire("session_start", { reason: "startup" }, fresh.tuiCtx());
      await fresh.fire("session_start", { reason: "new" }, fresh.tuiCtx());
      const notices = fresh.notifications.filter((item) => item.text.includes("MCP policy blocked"));
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toContain(`MCP policy blocked 1 server(s): ${JSON.stringify(blockedName)}`);
      expect(notices[0]!.text).not.toContain("MANAGED_BLOCKED_COMMAND_CANARY");
      const reports = await renderedMcpReports(fresh);
      for (const report of reports) {
        expect(report).toContain(`${JSON.stringify(blockedName)}: blocked`);
        expect(report).not.toContain('"ordinary":');
      }
      expect(fresh.messages).toEqual([]);
    } finally {
      await fresh.fire("session_shutdown", { reason: "other" }, fresh.printCtx());
      fs.rmSync(root, { recursive: true, force: true });
      if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
    }
  });

  it("keeps a valid nonmatching active policy quiet", async () => {
    const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const { fresh, root } = await policySnapshotProject({
      ordinary: { ordinary: { command: "ordinary-command" } },
      policy: { deniedMcpServers: [{ serverName: "different-server" }] },
    });
    try {
      await fresh.fire("session_start", { reason: "startup" }, fresh.tuiCtx());
      await fresh.fire("session_start", { reason: "new" }, fresh.tuiCtx());
      expect(fresh.notifications.filter((item) => item.text.includes("MCP"))).toEqual([]);
      const reports = await renderedMcpReports(fresh);
      for (const report of reports) {
        expect(report).toContain("Managed MCP policy: active rules.");
        expect(report).toContain('"ordinary":');
        expect(report).not.toContain("invalid managed deny field was stripped");
      }
      expect(fresh.messages).toEqual([]);
    } finally {
      await fresh.fire("session_shutdown", { reason: "other" }, fresh.printCtx());
      fs.rmSync(root, { recursive: true, force: true });
      if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
    }
  });

  it("renders one mixed snapshot in /mcp and /doctor and never repeats it on /new", async () => {
    const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const { fresh, root } = await mixedPolicyProject();
    try {
      await fresh.fire("session_start", { reason: "startup" }, fresh.tuiCtx());
      await fresh.fire("session_start", { reason: "startup" }, fresh.tuiCtx());
      await fresh.fire("session_start", { reason: "new" }, fresh.tuiCtx());
      const notices = fresh.notifications.filter((item) => item.text.includes("MCP"));
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toContain("pending approval");
      expect(notices[0]!.text).toContain('MCP policy blocked 1 server(s): "blocked"');
      expect(notices[0]!.text.length).toBeLessThan(1_000);

      await fresh.commands.get("mcp").handler("", fresh.tuiCtx());
      await fresh.commands.get("doctor").handler("", fresh.tuiCtx());
      const mcp = String(fresh.entries.find((entry) => entry.data?.command === "mcp")?.data?.output ?? "");
      const doctor = String(fresh.entries.find((entry) => entry.data?.command === "doctor")?.data?.output ?? "");
      for (const report of [mcp, doctor]) {
        expect(report).toContain('"pending": pending approval');
        expect(report).toContain('"blocked": blocked');
        expect(report).toContain("request an administrator policy change");
      }
      const observed = JSON.stringify({ notices, entries: fresh.entries, messages: fresh.messages });
      expect(observed).not.toMatch(/(?:PENDING_(?:COMMAND|ARG)|BLOCKED_COMMAND)_SECRET_CANARY/u);
      expect(fresh.messages).toEqual([]);
    } finally {
      await fresh.fire("session_shutdown", { reason: "other" }, fresh.printCtx());
      fs.rmSync(root, { recursive: true, force: true });
      if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
    }
  });

  it.each(["print", "rpc"] as const)("uses stderr rather than UI/model context in %s mode", async (mode) => {
    const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fresh, root } = await mixedPolicyProject();
    try {
      const ctx = mode === "print" ? fresh.printCtx() : fresh.rpcCtx();
      await fresh.fire("session_start", { reason: "startup" }, ctx);
      await fresh.fire("session_start", { reason: "new" }, ctx);
      const stderr = error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("MCP policy blocked"));
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toContain("pending approval");
      expect(fresh.notifications).toEqual([]);
      expect(fresh.messages).toEqual([]);
      expect(stderr.join("\n")).not.toMatch(/(?:PENDING_(?:COMMAND|ARG)|BLOCKED_COMMAND)_SECRET_CANARY/u);
    } finally {
      error.mockRestore();
      await fresh.fire("session_shutdown", { reason: "other" }, fresh.printCtx());
      fs.rmSync(root, { recursive: true, force: true });
      if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
    }
  });
});

describe("reserved plugin-management commands", () => {
  it("intercepts every alias across admission modes and blocks skill collisions", async () => {
    let hookFixture: ReturnType<typeof createHookProcessFixture> | undefined;
    const sdk = fakeSdk({ replies: ["subagent complete"] });
    const { fresh, root } = await freshControlPi({ sdk: sdk.sdk }, (projectRoot) => {
      hookFixture = createHookProcessFixture(projectRoot);
      fs.mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({
        env: hookFixture.env,
        hooks: { UserPromptSubmit: [{ hooks: [{
          type: "command",
          command: hookFixture.command,
          args: ["complete", "reserved-submit", "MUST-NOT-SPAWN"],
        }] }] },
      }), "utf8");
      const agentDir = path.join(projectRoot, ".claude", "agents");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "skill-runner.md"), "---\nname: skill-runner\ndescription: subagent skill test\n---\nRun skills.\n", "utf8");
      installPluginFixture(projectRoot, "same@market", "same", () => undefined);
      for (const name of ["plugin", "plugins", "reload-plugins"]) {
        for (const skillName of [`owner-${name}:${name}`, `other-${name}:${name}`]) {
          const skillDir = path.join(projectRoot, ".claude", "skills", skillName.replace(":", "-"));
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(
            path.join(skillDir, "SKILL.md"),
            `---\nname: ${skillName}\ndescription: collision canary\n---\nMUST-NOT-EGRESS-${skillName}`,
            "utf8",
          );
        }
      }
    });
    try {
      let reloadCalls = 0;
      const performReload = async (): Promise<void> => {
        reloadCalls += 1;
        const previous = process.cwd();
        try {
          process.chdir(root);
          const replacement = fakePi();
          picc(replacement.api as never, { onInitializationSettled: replacement.captureInitialization });
          await replacement.waitForInitialization();
          await replacement.fire("session_start", { reason: "reload" }, replacement.tuiCtx());
        } finally {
          process.chdir(previous);
        }
      };
      const admissionModes = [
        ["tui", () => fresh.tuiCtx({ reload: performReload })],
        ["print", () => fresh.printCtx()],
        ["json", () => fresh.ctx({ mode: "json", hasUI: false })],
        ["rpc", () => fresh.rpcCtx()],
      ] as const;
      for (const [mode, makeCtx] of admissionModes) {
        for (const [name, command] of [
          ["plugin", "/PlUgIn list"],
          ["plugins", "/PlUgInS"],
          ["reload-plugins", "/ReLoAd-PlUgInS"],
        ] as const) {
          fresh.entries.length = 0;
          const customBaseline = fresh.customs.length;
          expect(await fresh.fire("input", { text: command, source: mode }, makeCtx())).toEqual({ action: "handled" });
          const output = String(controlEntry(name, fresh)?.data?.output ?? "");
          if (name === "reload-plugins" && mode === "tui") {
            expect(controlEntry(name, fresh)).toBeUndefined();
            expect(reloadCalls).toBe(1);
          } else if (name === "reload-plugins") {
            expect(output).toContain("did not reload or mutate this process");
            expect(output).toContain("standalone PiCC plugin commands");
            expect(output).toContain("requires /reload-plugins in the live interactive session or a new PiCC session");
          } else {
            expect(output).toContain("Plugin inventory (read-only)");
            expect(output).toContain("captured for this session");
          }
          expect(fresh.customs).toHaveLength(customBaseline);
        }
      }

      const bareOutputs: string[] = [];
      for (const [mode, makeCtx] of admissionModes.filter(([mode]) => mode !== "tui")) {
        fresh.entries.length = 0;
        const customBaseline = fresh.customs.length;
        expect(await fresh.fire("input", { text: "/plugin list", source: mode }, makeCtx())).toEqual({ action: "handled" });
        const explicit = String(controlEntry("plugin", fresh)?.data?.output ?? "");
        expect(explicit).toContain("Plugin: same@market");
        fresh.entries.length = 0;
        expect(await fresh.fire("input", { text: "/plugin", source: mode }, makeCtx())).toEqual({ action: "handled" });
        const bare = String(controlEntry("plugin", fresh)?.data?.output ?? "");
        bareOutputs.push(bare);
        expect(bare).toBe(explicit);
        expect(fresh.customs).toHaveLength(customBaseline);
      }
      expect(new Set(bareOutputs).size).toBe(1);
      expect(bareOutputs[0]).toContain("Plugin inventory (read-only)");
      expect(fresh.messages).toEqual([]);
      expect(fresh.userMessages).toEqual([]);
      expect(sdk.promptCalls()).toBe(0);

      fresh.entries.length = 0;
      await fresh.commands.get("plugins").handler("", fresh.printCtx());
      const alias = String(controlEntry("plugins", fresh)?.data?.output ?? "");
      fresh.entries.length = 0;
      await fresh.commands.get("plugin").handler("list", fresh.printCtx());
      expect(String(controlEntry("plugin", fresh)?.data?.output ?? "")).toBe(alias);

      for (const invalid of ["install same@market", "details same", "details --force", "list extra", "--help"]) {
        fresh.entries.length = 0;
        expect(await fresh.fire("input", { text: `/plugin ${invalid}`, source: "rpc" }, fresh.rpcCtx()))
          .toEqual({ action: "handled" });
        const usage = String(controlEntry("plugin", fresh)?.data?.output ?? "");
        expect(usage).toContain("Usage: /plugin list | /plugin details <plugin@marketplace>");
        expect(usage).toContain("No changes were made");
        expect(usage).toContain("run picc plugin --help");
        expect(usage).toContain("Headless mode cannot reload plugins");
        expect(usage).toContain("If an interactive PiCC session is already running, use /reload-plugins there; otherwise start a new PiCC session.");
        if (invalid !== "--help") expect(usage).not.toContain(invalid);
      }

      fresh.entries.length = 0;
      expect(await fresh.fire("input", { text: "/plugins extra", source: "json" }, fresh.ctx({ mode: "json", hasUI: false })))
        .toEqual({ action: "handled" });
      expect(String(controlEntry("plugins", fresh)?.data?.output ?? "")).toContain("No changes were made");

      for (const [malformed, command, marker] of [
        ["/plugin\v", "plugin", "Usage:"],
        ["/plugin\vlist", "plugin", "Usage:"],
        ["/plugins\v", "plugins", "Usage:"],
        ["/plugins\vlist", "plugins", "Usage:"],
        ["\u0001/plugin list", "plugin", "Usage:"],
        ["/reload-plugins\v", "reload-plugins", "did not reload or mutate this process"],
        ["/ReLoAd-PlUgInS\vSECRET-MALFORMED-TAIL", "reload-plugins", "did not reload or mutate this process"],
      ] as const) {
        fresh.entries.length = 0;
        expect(await fresh.fire("input", { text: malformed, source: "rpc" }, fresh.rpcCtx()))
          .toEqual({ action: "handled" });
        const output = String(controlEntry(command, fresh)?.data?.output ?? "");
        expect(output).toContain(marker);
        expect(output).not.toContain("Plugin inventory (read-only)");
        expect(output).not.toMatch(/[\u0001\v]|SECRET-MALFORMED-TAIL/u);
      }
      for (const [command, args, marker] of [
        ["plugin", "\v", "Usage:"],
        ["plugin", "\vlist", "Usage:"],
        ["plugins", "\v", "Usage:"],
        ["plugins", "\vlist", "Usage:"],
        ["reload-plugins", "\v", "did not reload or mutate this process"],
        ["reload-plugins", "\vSECRET-MALFORMED-TAIL", "did not reload or mutate this process"],
      ] as const) {
        fresh.entries.length = 0;
        await fresh.commands.get(command).handler(args, fresh.rpcCtx());
        const output = String(controlEntry(command, fresh)?.data?.output ?? "");
        expect(output).toContain(marker);
        expect(output).not.toContain("SECRET-MALFORMED-TAIL");
      }
      expect(hookFixture!.spawnedChildren()).toHaveLength(0);
      expect(fresh.messages).toEqual([]);
      expect(fresh.userMessages).toEqual([]);
      expect(sdk.promptCalls()).toBe(0);

      fresh.entries.length = 0;
      const terminalCtx = fresh.tuiCtx({ reload: performReload });
      await fresh.commands.get("reload-plugins").handler("SECRET-ARG-MUST-NOT-REFLECT", terminalCtx);
      expect(reloadCalls).toBe(2);
      expect(controlEntry("reload-plugins", fresh)).toBeUndefined();
      expect(JSON.stringify(fresh.messages)).not.toContain("MUST-NOT-EGRESS");

      const slash = fresh.tools.get("SlashCommand");
      const skill = fresh.tools.get("Skill");
      for (const name of ["plugin", "plugins", "reload-plugins"] as const) {
        await expect(slash.execute(`slash-${name}`, { command: `/${name} ignored` }))
          .rejects.toThrow("reserved by a built-in");
        const mixed = name === "reload-plugins" ? "ReLoAd-PlUgInS" : name === "plugins" ? "PlUgInS" : "PlUgIn";
        await expect(skill.execute(`skill-${name}`, { name: mixed }))
          .rejects.toThrow("reserved plugin-management name");
        const explicit = await skill.execute(`skill-explicit-${name}`, { name: `owner-${name}:${name}` });
        expect(JSON.stringify(explicit)).toContain(`MUST-NOT-EGRESS-owner-${name}:${name}`);
        const explicitSlash = await slash.execute(`slash-explicit-${name}`, { command: `/owner-${name}:${name}` });
        expect(JSON.stringify(explicitSlash)).toContain(`owner-${name}:${name}`);
      }
      const agentTool = fresh.tools.get("Agent");
      await agentTool.execute("subagent", {
        subagent_type: "skill-runner",
        prompt: "prepare subagent skill tool",
        run_in_background: false,
      });
      const subagentSkill = (sdk.created[0]!.customTools as Array<{ name?: string; execute?: (...args: any[]) => Promise<any> }>)
        .find((tool) => tool.name === "Skill")!;
      for (const name of ["plugin", "plugins", "reload-plugins"] as const) {
        const mixed = name === "reload-plugins" ? "ReLoAd-PlUgInS" : name === "plugins" ? "PlUgInS" : "PlUgIn";
        await expect(subagentSkill.execute!("sub-bare", { name: mixed })).rejects.toThrow("reserved plugin-management name");
        const explicit = await subagentSkill.execute!("sub-explicit", { name: `owner-${name}:${name}` });
        expect(JSON.stringify(explicit)).toContain(`MUST-NOT-EGRESS-owner-${name}:${name}`);
      }

      expect(hookFixture!.spawnedChildren()).toHaveLength(0);
      for (const nonOwned of [
        "/pluginx", "/plugin:skill", "/plugin\u017f", "/plug\u0131n", "/plugins\u0430",
        "/reload-pluginsx", "/reload-plugins:skill", "/reload-plugin\u017f",
      ]) {
        const nearPrefix = await fresh.fire("input", { text: nonOwned, source: "rpc" }, fresh.rpcCtx());
        expect(nearPrefix).toMatchObject({ action: "transform" });
        expect(nearPrefix.text).toContain(nonOwned);
      }
    } finally {
      await hookFixture?.cleanup("reserved-submit");
      const candidate = loadClaudeProject({ cwd: root, userDir: path.join(root, ".claude-user"), homeDir: os.homedir() });
      if (candidate.reloadCandidate.status === "ready") {
        fs.rmSync(path.dirname(path.dirname(candidate.reloadCandidate.handoffPath)), { recursive: true, force: true });
      }
      cleanupFixture(root);
    }
  });

  it("reserves absent bare Skill tokens before lookup in main and subagent tools", async () => {
    const sdk = fakeSdk({ replies: ["subagent complete"] });
    const { fresh, root } = await freshControlPi({ sdk: sdk.sdk }, (projectRoot) => {
      const agentDir = path.join(projectRoot, ".claude", "agents");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "skill-runner.md"), "---\nname: skill-runner\ndescription: subagent skill test\ntools: [Skill]\n---\nRun skills.\n", "utf8");
    });
    try {
      const mainSkill = fresh.tools.get("Skill");
      await fresh.tools.get("Agent").execute("subagent", {
        subagent_type: "skill-runner", prompt: "prepare subagent skill tool", run_in_background: false,
      });
      const subagentSkill = (sdk.created[0]!.customTools as Array<{ name?: string; execute?: (...args: any[]) => Promise<any> }>)
        .find((tool) => tool.name === "Skill")!;
      for (const name of ["plugin", "plugins", "reload-plugins"] as const) {
        await expect(mainSkill.execute("main-absent", { name })).rejects.toThrow("reserved plugin-management name");
        await expect(subagentSkill.execute!("sub-absent", { name })).rejects.toThrow("reserved plugin-management name");
      }
    } finally {
      cleanupFixture(root);
    }
  });

  it("keeps qualified same-name identities distinct and opens/closes the TUI without a transcript row", async () => {
    const { fresh, root } = await freshControlPi(undefined, (projectRoot) => {
      installPluginFixture(projectRoot, "same@market-a", "same", () => undefined);
      installPluginFixture(projectRoot, "same@market-b", "same", () => undefined);
    });
    try {
      await fresh.commands.get("plugin").handler("list", fresh.printCtx());
      const list = String(controlEntry("plugin", fresh)?.data?.output ?? "");
      expect(list).toContain("Plugin: same@market-a");
      expect(list).toContain("Plugin: same@market-b");

      fresh.entries.length = 0;
      await fresh.commands.get("plugin").handler("details same@market-b", fresh.rpcCtx());
      const details = String(controlEntry("plugin", fresh)?.data?.output ?? "");
      expect(details).toContain("Plugin: same@market-b");
      expect(details).not.toContain("Plugin: same@market-a");

      fresh.entries.length = 0;
      const opening = fresh.commands.get("plugin").handler("", fresh.tuiCtx());
      await Promise.resolve();
      const custom = fresh.customs.at(-1)!;
      await custom.ready;
      custom.input("\u001b[C");
      expect(custom.render(72).join("\n")).toContain("same@market-a");
      custom.input("\u001b[B");
      custom.input("\r");
      expect(custom.render(72).join("\n")).toContain("same@market-b");
      custom.input("\u001b");
      custom.input("\u001b");
      await opening;
      expect(fresh.entries).toEqual([]);
      expect(fresh.messages).toEqual([]);
      expect(fresh.userMessages).toEqual([]);
    } finally {
      cleanupFixture(root);
    }
  });

  it("keeps headless lifecycle requests inert and collects TUI workflow values without transcript egress", async () => {
    let compositions = 0; const sdk = fakeSdk({ replies: ["MUST-NOT-RUN"] }); let hookFixture: ReturnType<typeof createHookProcessFixture> | undefined;
    const { fresh, root } = await freshControlPi({ sdk: sdk.sdk, pluginLifecycle: async () => { compositions += 1; return { ok: false as const, code: "fixture-unavailable", message: "SECRET_FACTORY_DETAIL" }; } }, (projectRoot) => {
      hookFixture = createHookProcessFixture(projectRoot); const settingsPath = path.join(projectRoot, ".claude", "settings.json"); fs.mkdirSync(path.dirname(settingsPath), { recursive: true }); const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown> : {}; settings.env = hookFixture.env; settings.hooks = { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookFixture.command, args: ["complete", "plugin-lifecycle-headless"] }] }] }; fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
    });
    try {
      for (const [mode, ctx] of [["print", fresh.printCtx()], ["json", fresh.ctx({ mode: "json", hasUI: false })], ["rpc", fresh.rpcCtx()]] as const) {
        fresh.entries.length = 0; const customs = fresh.customs.length; const messages = fresh.messages.length; const userMessages = fresh.userMessages.length;
        expect(await fresh.fire("input", { text: "/plugin install SECRET_SOURCE_VALUE", source: mode }, ctx)).toEqual({ action: "handled" });
        expect(compositions).toBe(0); expect(fresh.customs).toHaveLength(customs); expect(fresh.messages).toHaveLength(messages); expect(fresh.userMessages).toHaveLength(userMessages);
        const guidance = String(controlEntry("plugin", fresh)?.data?.output ?? ""); expect(guidance.length).toBeLessThan(5000); expect(guidance).toContain("Headless modes are guidance-only"); expect(guidance).toContain("If an interactive PiCC session is already running, use /reload-plugins there; otherwise start a new PiCC session."); expect(guidance).not.toContain("SECRET_SOURCE_VALUE");
      }

      fresh.entries.length = 0;
      const opening = fresh.commands.get("plugin").handler("install SECRET_SOURCE_VALUE", fresh.tuiCtx());
      await Promise.resolve(); const custom = fresh.customs.at(-1)!; await custom.ready;
      expect(compositions).toBe(0);
      expect(custom.render(72).join("\n")).not.toContain("SECRET_SOURCE_VALUE");
      custom.input("\r");
      custom.input("alpha@official"); custom.input("\r");
      custom.input("user"); custom.input("\r");
      await vi.waitFor(() => expect(custom.render(72).join("\n")).toContain("fixture unavailable"));
      expect(compositions).toBe(1);
      expect(custom.render(72).join("\n")).not.toMatch(/SECRET_(?:SOURCE_VALUE|FACTORY_DETAIL)/u);
      custom.input("\u001b"); custom.input("\u001b"); await opening;

      for (const [args, expected] of [["enable TRAILING_RAW_SECRET", "enable"], ["disable TRAILING_RAW_SECRET", "disable"], ["update TRAILING_RAW_SECRET", "update"], ["uninstall TRAILING_RAW_SECRET", "uninstall"], ["marketplace add TRAILING_RAW_SECRET", "marketplace-add"], ["marketplace refresh TRAILING_RAW_SECRET", "marketplace-refresh"], ["marketplace remove TRAILING_RAW_SECRET", "marketplace-remove"], ["recover TRAILING_RAW_SECRET", "recover"]] as const) {
        const routed = fresh.commands.get("plugin").handler(args, fresh.tuiCtx()); await Promise.resolve(); const pane = fresh.customs.at(-1)!; await pane.ready; const text = pane.render(72).join("\n"); expect(text).toContain(expected); expect(text).not.toContain("TRAILING_RAW_SECRET"); pane.input("\u001b"); pane.input("\u001b"); await routed;
      }
      expect(JSON.stringify(fresh.entries)).not.toMatch(/SECRET_(?:SOURCE_VALUE|FACTORY_DETAIL)|TRAILING_RAW_SECRET/u);
      expect(fresh.messages).toEqual([]); expect(fresh.userMessages).toEqual([]); expect(sdk.promptCalls()).toBe(0); expect(hookFixture?.spawnedChildren()).toHaveLength(0);
    } finally { await hookFixture?.cleanup("plugin-lifecycle-headless"); cleanupFixture(root); }
  });

  it("uses a bounded list fallback when interactive opening is unavailable or rejected", async () => {
    const { fresh, root } = await freshControlPi();
    try {
      for (const ui of [
        { notify: () => undefined },
        { notify: () => undefined, custom: async () => { throw new Error("CUSTOM_OPEN_CANARY"); } },
      ]) {
        fresh.entries.length = 0;
        expect(await fresh.fire("input", { text: "/plugin", source: "interactive" }, fresh.tuiCtx({ ui })))
          .toEqual({ action: "handled" });
        const output = String(controlEntry("plugin", fresh)?.data?.output ?? "");
        expect(output).toMatch(/Interactive plugin inventory (?:is unavailable in this TUI|could not open)/);
        expect(output).toContain("Plugin inventory (read-only)");
        expect(output).not.toMatch(/CUSTOM_OPEN_CANARY|open-failed/);
      }
    } finally {
      cleanupFixture(root);
    }
  });

  it("keeps mutation rejection final when transcript append and text stdout presentation both fail", async () => {
    const sdk = fakeSdk({ replies: ["MUST-NOT-RUN"] });
    const { fresh, root } = await freshControlPi({
      sdk: sdk.sdk,
      mcpControl: { writeText: () => { throw new Error("STDOUT_PLUGIN_CANARY"); } },
    });
    const append = fresh.api.appendEntry;
    try {
      fresh.api.appendEntry = () => { throw new Error("APPEND_PLUGIN_CANARY"); };
      expect(await fresh.fire("input", { text: "/plugin install SECRET_MUTATION", source: "print" }, fresh.printCtx()))
        .toEqual({ action: "handled" });
      expect(fresh.messages).toEqual([]);
      expect(fresh.userMessages).toEqual([]);
      expect(sdk.promptCalls()).toBe(0);
      expect(JSON.stringify(fresh.entries)).not.toMatch(/SECRET_MUTATION|(?:APPEND|STDOUT)_PLUGIN_CANARY/);
    } finally {
      fresh.api.appendEntry = append;
      cleanupFixture(root);
    }
  });

  it("keeps one attached snapshot and model-visible state unchanged while backing files change and the manager navigates", async () => {
    const sdk = fakeSdk({ replies: ["MUST-NOT-RUN"] });
    let hookFixture: ReturnType<typeof createHookProcessFixture> | undefined;
    const runtimeCalls: string[] = [];
    const inertMcp = {
      whenSettled: async () => { runtimeCalls.push("settle"); }, tools: () => { runtimeCalls.push("tools"); return []; },
      prompts: () => { runtimeCalls.push("prompts"); return []; }, resourceServers: () => { runtimeCalls.push("resources"); return []; },
      callTool: async () => { runtimeCalls.push("callTool"); throw new Error("not called"); },
      getPrompt: async () => { runtimeCalls.push("getPrompt"); throw new Error("not called"); },
      readResource: async () => { runtimeCalls.push("readResource"); throw new Error("not called"); },
      diagnostics: () => [], serverStates: () => [], shutdown: async () => { runtimeCalls.push("shutdown"); },
    };
    const { fresh, root } = await freshControlPi({ sdk: sdk.sdk, mcpRuntime: inertMcp }, (projectRoot) => {
      hookFixture = createHookProcessFixture(projectRoot);
      installPluginFixture(projectRoot, "locked@market", "locked", (installRoot) => {
        const skillDir = path.join(installRoot, "skills", "snapshot-witness");
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          "---\nname: snapshot-witness\ndescription: DISTINCTIVE_CAPTURED_PLUGIN_RESOURCE\n---\nDISTINCTIVE_LAZY_PLUGIN_BODY\n",
          "utf8",
        );
      });
      fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "DISTINCTIVE_CAPTURED_PROJECT_CONTEXT\n", "utf8");
      const resourceSkillDir = path.join(projectRoot, ".claude", "skills", "captured-resource");
      fs.mkdirSync(resourceSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(resourceSkillDir, "SKILL.md"),
        "---\nname: captured-resource\ndescription: DISTINCTIVE_CAPTURED_PROMPT_RESOURCE\n---\nDISTINCTIVE_LAZY_PROJECT_BODY\n",
        "utf8",
      );
      fs.writeFileSync(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({
        env: hookFixture!.env,
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookFixture!.command, args: ["complete", "inventory-hook"] }] }] },
      }), "utf8");
    });
    try {
      const beforePrompt = await fresh.fire("before_agent_start", { systemPrompt: "base" }, fresh.printCtx());
      expect(JSON.stringify(beforePrompt)).toContain("DISTINCTIVE_CAPTURED_PROJECT_CONTEXT");
      expect(JSON.stringify(beforePrompt)).toContain("DISTINCTIVE_CAPTURED_PLUGIN_RESOURCE");
      expect(JSON.stringify(beforePrompt)).toContain("DISTINCTIVE_CAPTURED_PROMPT_RESOURCE");
      expect(JSON.stringify(beforePrompt)).not.toMatch(/DISTINCTIVE_LAZY_(?:PLUGIN|PROJECT)_BODY/);
      const resourcesBefore = await fresh.fire("resources_discover", { reason: "startup" }, fresh.printCtx());
      const readPromptResourceEvidence = () => (resourcesBefore.promptPaths as string[]).flatMap((promptRoot) =>
        fs.readdirSync(promptRoot, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
          .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8")),
      ).join("\n");
      const promptResourceEvidence = readPromptResourceEvidence();
      expect(promptResourceEvidence).toContain("DISTINCTIVE_CAPTURED_PROMPT_RESOURCE");
      expect(promptResourceEvidence).not.toMatch(/DISTINCTIVE_LAZY_(?:PLUGIN|PROJECT)_BODY/);
      const runtimeBaseline = [...runtimeCalls];
      const providerBaseline = fresh.providerRegistrations.length;
      const tree = (directory: string): string[] => fs.readdirSync(directory, { recursive: true, withFileTypes: true })
        .map((entry) => `${entry.isDirectory() ? "d" : "f"}:${path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/")}${entry.isFile() ? `:${fs.readFileSync(path.join(entry.parentPath, entry.name)).toString("base64")}` : ""}`)
        .sort();
      const fetchTrap = vi.fn(() => { throw new Error("inventory network access forbidden"); });
      vi.stubGlobal("fetch", fetchTrap);
      const connectTrap = vi.spyOn(net, "connect").mockImplementation((() => { throw new Error("inventory socket access forbidden"); }) as typeof net.connect);
      const createConnectionTrap = vi.spyOn(net, "createConnection").mockImplementation((() => { throw new Error("inventory socket access forbidden"); }) as typeof net.createConnection);
      const projectBefore = tree(root);
      const profileBefore = tree(path.join(root, ".claude-user"));
      try {
      const compactBaseline = fresh.compactCalls.length;
      const customBaseline = fresh.customs.length;
      await fresh.commands.get("plugin").handler("list", fresh.rpcCtx());
      const listBefore = String(controlEntry("plugin", fresh)?.data?.output ?? "");
      fresh.entries.length = 0;
      await fresh.commands.get("plugin").handler("details locked@market", fresh.rpcCtx());
      const detailsBefore = String(controlEntry("plugin", fresh)?.data?.output ?? "");
      expect(tree(root)).toEqual(projectBefore);
      expect(tree(path.join(root, ".claude-user"))).toEqual(profileBefore);

      fs.rmSync(path.join(root, ".claude-user", "plugins"), { recursive: true, force: true });
      fs.rmSync(path.join(root, ".claude-user", "settings.json"), { force: true });
      const projectAfterBackingChange = tree(root);
      const profileAfterBackingChange = tree(path.join(root, ".claude-user"));
      fresh.entries.length = 0;
      await fresh.commands.get("plugin").handler("list", fresh.rpcCtx());
      expect(String(controlEntry("plugin", fresh)?.data?.output ?? "")).toBe(listBefore);
      fresh.entries.length = 0;
      await fresh.commands.get("plugin").handler("details locked@market", fresh.rpcCtx());
      expect(String(controlEntry("plugin", fresh)?.data?.output ?? "")).toBe(detailsBefore);

      fresh.entries.length = 0;
      const opening = fresh.commands.get("plugin").handler("", fresh.tuiCtx());
      await Promise.resolve();
      const custom = fresh.customs.at(-1)!;
      await custom.ready;
      custom.input("\u001b[C");
      expect(custom.render(72).join("\n")).toContain("locked@market");
      custom.input("\u001b[D");
      custom.input("\u001b");
      await opening;
      expect(fresh.customs).toHaveLength(customBaseline + 1);
      const afterPrompt = await fresh.fire("before_agent_start", { systemPrompt: "base" }, fresh.printCtx());
      expect(afterPrompt).toEqual(beforePrompt);
      expect(readPromptResourceEvidence()).toBe(promptResourceEvidence);
      expect(fresh.messages).toEqual([]);
      expect(fresh.userMessages).toEqual([]);
      expect(fresh.modelSets).toEqual([]);
      expect(fresh.thinkingLevels).toEqual([]);
      expect(sdk.promptCalls()).toBe(0);
      expect(runtimeCalls).toEqual(runtimeBaseline);
      expect(fresh.providerRegistrations).toHaveLength(providerBaseline);
      expect(fresh.compactCalls).toHaveLength(compactBaseline);
      expect(hookFixture!.spawnedChildren()).toHaveLength(0);
      expect(tree(root)).toEqual(projectAfterBackingChange);
      expect(tree(path.join(root, ".claude-user"))).toEqual(profileAfterBackingChange);
      expect(fetchTrap).not.toHaveBeenCalled();
      expect(connectTrap).not.toHaveBeenCalled();
      expect(createConnectionTrap).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
        connectTrap.mockRestore();
        createConnectionTrap.mockRestore();
      }
    } finally {
      await hookFixture?.cleanup("inventory-hook");
      cleanupFixture(root);
    }
  });
});

describe("pre-selection plugin discovery to first use", () => {
  it("keeps data absent through discovery, then creates isolated directories at first skill and scoped-hook references", async () => {
    let hookRoot = "";
    let marker = "";
    const { fresh, root } = await freshControlPi(undefined, (projectRoot) => {
      marker = path.join(projectRoot, "skill-hook-environment.json");
      const script = path.join(projectRoot, "record-skill-hook.cjs");
      fs.writeFileSync(script, [
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.env.HOOK_MARKER, JSON.stringify({ root: process.env.CLAUDE_PLUGIN_ROOT, data: process.env.CLAUDE_PLUGIN_DATA, project: process.env.CLAUDE_PROJECT_DIR }));',
      ].join("\n"), "utf8");
      for (const [name, skill, body, hooks] of [
        ["data-owner", "data-skill", "state=${CLAUDE_PLUGIN_DATA}/state.json", ""],
        ["hook-owner", "hook-skill", "hook body without data", [
          "hooks:", "  PreToolUse:", "    - hooks:", "        - type: command", '          command: exec "$HOOK_NODE" "$HOOK_SCRIPT"',
        ].join("\n")],
      ] as const) {
        const installRoot = installPluginFixture(projectRoot, `${name}@market`, name, (pluginRoot) => {
          const skillDir = path.join(pluginRoot, "skills", skill);
          fs.mkdirSync(skillDir, { recursive: true });
          fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
            "---", `name: ${skill}`, `description: ${skill} canary`, hooks, "---", body,
          ].filter(Boolean).join("\n"), "utf8");
        });
        if (name === "hook-owner") hookRoot = fs.realpathSync.native(installRoot);
      }
      const settingsPath = path.join(projectRoot, ".claude-user", "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      settings["env"] = {
        HOOK_NODE: process.execPath.replaceAll("\\", "/"),
        HOOK_SCRIPT: script.replaceAll("\\", "/"),
        HOOK_MARKER: marker.replaceAll("\\", "/"),
      };
      fs.writeFileSync(settingsPath, JSON.stringify(settings), "utf8");
    });
    const dataDir = path.join(root, ".claude-user", "plugins", "data", sanitizePluginDataKey("data-owner@market"));
    const hookDir = path.join(root, ".claude-user", "plugins", "data", sanitizePluginDataKey("hook-owner@market"));
    try {
      expect(fs.existsSync(dataDir)).toBe(false);
      expect(fs.existsSync(hookDir)).toBe(false);
      expect(fs.existsSync(marker)).toBe(false);
      await fresh.fire("resources_discover", { reason: "startup" });
      expect(fs.existsSync(dataDir)).toBe(false);
      expect(fs.existsSync(hookDir)).toBe(false);
      expect(fs.existsSync(marker)).toBe(false);

      await fresh.tools.get("Skill").execute("data-first", { name: "data-owner:data-skill" });
      expect(fs.existsSync(dataDir)).toBe(true);
      expect(fs.existsSync(hookDir)).toBe(false);

      await fresh.tools.get("Skill").execute("hook-activate", { name: "hook-owner:hook-skill" });
      expect(fs.existsSync(hookDir)).toBe(false);
      await fresh.fire("tool_call", { toolName: "read", toolCallId: "hook-first", input: { path: "x" } }, fresh.tuiCtx());
      expect(fs.existsSync(hookDir)).toBe(true);
      expect(fs.existsSync(dataDir)).toBe(true);
      expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual({
        root: hookRoot,
        data: hookDir,
        project: root,
      });
    } finally {
      cleanupFixture(root);
    }
  });
});

describe("plugin startup warning wiring", () => {
  it("uses the snapshot once per session mode, preserves same-name qualified identities, and redacts raw diagnostics", async () => {
    const missingSetup = (root: string) => {
      const userDir = path.join(root, ".claude-user");
      fs.mkdirSync(userDir, { recursive: true });
      fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({
        enabledPlugins: { "same@market-a": true, "same@market-b": true },
      }), "utf8");
    };
    const omissionSetup = (root: string) => {
      const pluginDir = path.join(root, ".claude-user", "plugins");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, "known_marketplaces.json"), JSON.stringify(Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [
          index === 299 ? "SECRET_RAW_DIAGNOSTIC_PATH_C:/private/plugin-state" : `malformed-${index}`,
          { source: { source: "directory" } },
        ]),
      )), "utf8");
    };
    const tui = await freshControlPi(undefined, missingSetup);
    const headless = await freshControlPi(undefined, missingSetup);
    const throwing = await freshControlPi(undefined, missingSetup);
    let throwingPluginNotifyCalls = 0;
    const omitted = await freshControlPi(undefined, omissionSetup);
    const quiet = await freshControlPi();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await tui.fresh.fire("session_start", { reason: "new" }, tui.fresh.tuiCtx());
      await tui.fresh.fire("session_start", { reason: "reload" }, tui.fresh.tuiCtx());
      expect(tui.fresh.notifications).toHaveLength(0);
      await tui.fresh.fire("session_start", { reason: "startup" }, tui.fresh.tuiCtx());
      await tui.fresh.fire("session_start", { reason: "startup" }, tui.fresh.tuiCtx());
      await tui.fresh.fire("session_start", { reason: "new" }, tui.fresh.tuiCtx());
      await tui.fresh.fire("session_start", { reason: "reload" }, tui.fresh.tuiCtx());
      const notices = tui.fresh.notifications.filter((item) => item.text.includes("needs attention"));
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text.match(/same@market-a/g)).toHaveLength(1);
      expect(notices[0]!.text.match(/same@market-b/g)).toHaveLength(1);
      expect(notices[0]!.text).toContain("Run /doctor for details");
      expect(notices[0]!.text).not.toMatch(/installed_plugins|\.claude-user|SECRET_RAW_DIAGNOSTIC_PATH|C:\/private/i);

      await omitted.fresh.fire("session_start", { reason: "startup" }, omitted.fresh.tuiCtx());
      await omitted.fresh.fire("session_start", { reason: "startup" }, omitted.fresh.tuiCtx());
      const omissionNotices = omitted.fresh.notifications.filter((item) => item.text.includes("This startup notice is abbreviated"));
      expect(omissionNotices).toHaveLength(1);
      expect(omissionNotices[0]!.text.split("\n").at(-1)).toBe("This startup notice is abbreviated.");
      expect(omissionNotices[0]!.text).not.toMatch(/\/plugin list|\/doctor|all omission|omission counts|complete inventory|recovery/i);
      expect(omissionNotices[0]!.text).not.toMatch(/malformed-299|SECRET_RAW_DIAGNOSTIC_PATH|C:\/private/i);
      await omitted.fresh.commands.get("plugin").handler("list", omitted.fresh.tuiCtx());
      const omittedList = String(controlEntry("plugin", omitted.fresh)?.data?.output ?? "");
      expect(omittedList).toContain("Snapshot-capture evidence omissions:");
      expect(omittedList).toContain("loader.marketplace.diagnostics=172");
      expect(omittedList).not.toContain("SECRET_RAW_DIAGNOSTIC_PATH");
      expect(omissionNotices[0]!.text).not.toContain("loader.marketplace.diagnostics");
      expect(omissionNotices[0]!.text).not.toContain("loader.marketplace.diagnostics=172");
      expect(omissionNotices[0]!.text).not.toContain("SECRET_RAW_DIAGNOSTIC_PATH_C:/private/plugin-state");
      expect(omissionNotices[0]!.text).not.toContain("Snapshot-capture evidence omissions");

      await headless.fresh.fire("session_start", { reason: "startup" }, headless.fresh.printCtx());
      await headless.fresh.fire("session_start", { reason: "startup" }, headless.fresh.printCtx());
      const stderr = error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("needs attention"));
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toContain("same@market-a");
      expect(stderr[0]).toContain("same@market-b");
      expect(stderr[0]).not.toContain("SECRET_RAW_DIAGNOSTIC_PATH");

      const notificationFault = throwing.fresh.tuiCtx({
        ui: { notify: (text: string) => {
          if (text.includes("needs attention")) throwingPluginNotifyCalls += 1;
          throw new Error("SECRET_NOTIFICATION_EXCEPTION_CANARY");
        } },
      });
      await expect(throwing.fresh.fire("session_start", { reason: "startup" }, notificationFault)).resolves.toBeUndefined();
      await expect(throwing.fresh.fire("session_start", { reason: "startup" }, notificationFault)).resolves.toBeUndefined();
      expect(throwingPluginNotifyCalls).toBe(1);
      expect(error.mock.calls.flat().join("\n")).not.toContain("SECRET_NOTIFICATION_EXCEPTION_CANARY");

      await quiet.fresh.fire("session_start", { reason: "startup" }, quiet.fresh.tuiCtx());
      expect(quiet.fresh.notifications.some((item) => item.text.includes("needs attention"))).toBe(false);
    } finally {
      error.mockRestore();
      cleanupFixture(tui.root);
      cleanupFixture(headless.root);
      cleanupFixture(throwing.root);
      cleanupFixture(omitted.root);
      cleanupFixture(quiet.root);
    }
  });
});

describe("plugin activation runtime behavior", () => {
  it("serves direct, slash, typed, and context:fork activation from the imported body snapshot", async () => {
    const sdk = fakeSdk({ replies: Array.from({ length: 3 }, () => "SNAPSHOT-FINAL") });
    let skillFile = "";
    const { fresh, root } = await freshControlPi({ sdk: sdk.sdk }, (projectRoot) => {
      installPluginFixture(projectRoot, "snapshot-owner@market", "snapshot-owner", (installRoot) => {
        const skillDir = path.join(installRoot, "skills", "snapshot-plugin-skill");
        skillFile = path.join(skillDir, "SKILL.md");
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(skillFile, [
          "---",
          "name: snapshot-plugin-skill",
          "description: imported body snapshot canary",
          "context: fork",
          "hooks:",
          "  PreToolUse:",
          "    - hooks:",
          "        - type: command",
          "          command: echo SCOPED-HOOK-CANARY",
          "---",
          "snapshot-data=${CLAUDE_PLUGIN_DATA}",
        ].join("\n"), "utf8");
      });
    });
    fs.rmSync(skillFile);
    try {
      const expectedDataPath = path.join(
        root,
        ".claude-user",
        "plugins",
        "data",
        sanitizePluginDataKey("snapshot-owner@market"),
      );
      const before = await fresh.fire("before_agent_start", { systemPrompt: "base" }, fresh.printCtx());
      expect(before?.systemPrompt).toContain("base");
      expect(String(before?.systemPrompt ?? "")).not.toContain("snapshot-data=");

      const skill = fresh.tools.get("Skill");
      const slash = fresh.tools.get("SlashCommand");
      const skillResult = await skill.execute("snapshot-skill", { name: "snapshot-plugin-skill" });
      expect(skillResult.content).toEqual([{ type: "text", text: "SNAPSHOT-FINAL" }]);
      const slashResult = await slash.execute("snapshot-slash", { command: "/snapshot-plugin-skill" });
      expect(slashResult.content).toEqual([{ type: "text", text: "SNAPSHOT-FINAL" }]);
      const typed = await fresh.fire("input", { text: "/snapshot-plugin-skill", source: "interactive" }, fresh.printCtx());
      expect(typed).toEqual({
        action: "transform",
        text: "The snapshot-owner:snapshot-plugin-skill skill ran in a forked subagent. Its result:\n\nSNAPSHOT-FINAL",
      });
      expect(fresh.messages).toEqual([]);
      expect(fresh.userMessages).toEqual([]);
      expect(sdk.created).toHaveLength(3);
      expect(sdk.promptCalls()).toBe(3);
      expect(sdk.sessions).toHaveLength(3);
      const sessionPrompts = sdk.sessions.map((session) => {
        const userMessage = session.messages.find((message) => message.role === "user");
        expect(userMessage).toBeDefined();
        expect(typeof userMessage?.content).toBe("string");
        return typeof userMessage?.content === "string" ? userMessage.content : "";
      });
      const assertExpandedSnapshot = (prompt: string | undefined) => {
        expect(prompt).toContain(`snapshot-data=${expectedDataPath}`);
        expect(prompt).not.toContain("${CLAUDE_PLUGIN_DATA}");
      };
      const [skillPrompt, slashCommandPrompt, typedSlashForkPrompt] = sessionPrompts;
      assertExpandedSnapshot(skillPrompt);
      assertExpandedSnapshot(slashCommandPrompt);
      assertExpandedSnapshot(typedSlashForkPrompt);

      const after = await fresh.fire("before_agent_start", { systemPrompt: "base" }, fresh.printCtx());
      expect(after?.systemPrompt).toContain("base");
      expect(String(after?.systemPrompt ?? "")).not.toContain("snapshot-data=");
      const unblocked = await fresh.fire("tool_call", {
        toolName: "read", toolCallId: "after-snapshot-forks", input: { path: "safe.txt" },
      }, fresh.printCtx());
      expect(unblocked).toBeUndefined();

      await fresh.commands.get("doctor").handler("", fresh.tuiCtx());
      const report = String([...fresh.entries].reverse().find((entry) => entry.data?.command === "doctor")?.data?.output ?? "");
      expect(report).not.toContain("Plugin runtime failures (execution did not occur):");
      expect(report).not.toContain("Reconcile or reinstall");

      fresh.entries.length = 0;
      await fresh.commands.get("plugin").handler("list", fresh.rpcCtx());
      const inventory = String(fresh.entries.at(-1)?.data?.output ?? "");
      expect(inventory).toContain("Plugin: snapshot-owner@market");
      expect(inventory).toContain("runtime: loaded");
      expect(inventory).not.toContain("Runtime refusals observed after snapshot capture");
    } finally {
      cleanupFixture(root);
    }
  });

  it("caps, deduplicates, and counts distinct runtime-finding overflow", async () => {
    const { fresh, root } = await freshControlPi(undefined, (projectRoot) => {
      installPluginFixture(projectRoot, "overflow-owner@market", "overflow-owner", (root) => {
        for (let index = 0; index < 26; index++) {
          const dir = path.join(root, "skills", `broken-${index}`);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "SKILL.md"), [
            "---", `name: broken-${index}`, "description: overflow canary", "---", "data=${CLAUDE_PLUGIN_DATA}",
          ].join("\n"), "utf8");
        }
      });
    });
    fs.writeFileSync(path.join(root, ".claude-user", "plugins", "data"), "blocks data directory", "utf8");
    try {
      const skill = fresh.tools.get("Skill");
      for (let index = 0; index < 22; index++) {
        await expect(skill.execute(`overflow-${index}`, { name: `overflow-owner:broken-${index}` })).rejects.toThrow();
      }
      await expect(skill.execute("overflow-duplicate", { name: "overflow-owner:broken-21" })).rejects.toThrow();
      await fresh.commands.get("doctor").handler("", fresh.tuiCtx());
      const report = String(fresh.entries.at(-1)?.data?.output ?? "");
      expect(report.match(/^  - skill overflow-owner:broken-/gm)).toHaveLength(20);
      expect(report).toContain("2 additional distinct failure(s) omitted");
      expect(report).not.toContain("at least 2");
      expect(report).toContain("Recovery: repair plugin-data ownership, writability, and directory kinds, then retry the affected action; no reload is required.");
      expect(report).not.toContain("Reconcile or reinstall the plugin");
      expect(report).toContain("execution did not occur");

      for (let index = 22; index < 26; index++) {
        await expect(skill.execute(`overflow-${index}`, { name: `overflow-owner:broken-${index}` })).rejects.toThrow();
      }
      await fresh.commands.get("doctor").handler("", fresh.tuiCtx());
      const saturated = String(fresh.entries.at(-1)?.data?.output ?? "");
      expect(saturated).toContain("at least 5 additional distinct failure(s) omitted");
      expect(saturated).not.toContain("broken-25");
    } finally {
      cleanupFixture(root);
    }
  });

  it("rejects a plugin agent owner through production preparation before SDK resources or provider work", async () => {
    const handle = fakeSdk({ replies: ["MUST-NOT-RUN"] });
    let resourceLoaders = 0;
    const BaseLoader = handle.sdk.DefaultResourceLoader;
    const sdk = {
      ...handle.sdk,
      DefaultResourceLoader: class extends BaseLoader {
        constructor(options: any) {
          resourceLoaders += 1;
          super(options);
        }
      },
    };
    const { fresh, root } = await freshControlPi({ sdk }, (projectRoot) => {
      installPluginFixture(projectRoot, "broken-agent-owner@market", "broken-agent-owner", (installRoot) => {
        const agentDir = path.join(installRoot, "agents");
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, "broken-agent.md"), [
          "---", "name: broken-agent", "description: owner preparation canary",
          "tools:", "  - Read(${CLAUDE_PLUGIN_DATA}/**)", "---", "body without data",
        ].join("\n"), "utf8");
      });
    });
    fs.writeFileSync(path.join(root, ".claude-user", "plugins", "data"), "blocks data directory", "utf8");
    try {
      const agent = fresh.tools.get("Agent");
      const agentError = await agent.execute("broken-agent", {
        subagent_type: "broken-agent", prompt: "must not run", run_in_background: false,
      }).then(() => undefined, (caught: unknown) => caught as Error);
      expect(agentError?.message).toMatch(/Agent "broken-agent-owner:broken-agent" did not start.*no provider request was made/i);
      expect(agentError?.message).toContain("Repair plugin-data ownership, writability, and directory kinds, then retry the affected action; no reload is required.");
      expect(agentError?.message).not.toContain("Reconcile or reinstall");
      expect(agentError?.message).not.toContain("canonical /reload");
      expect(handle.created).toHaveLength(0);
      expect(resourceLoaders).toBe(0);
      expect(handle.promptCalls()).toBe(0);
      await fresh.commands.get("doctor").handler("", fresh.tuiCtx());
      const report = String(fresh.entries.at(-1)?.data?.output ?? "");
      expect(report).toContain("Agent \"broken-agent-owner:broken-agent\" did not start");
      expect(report).toContain("Recovery: repair plugin-data ownership, writability, and directory kinds, then retry the affected action; no reload is required.");
      expect(report).not.toContain("trusted context");
    } finally {
      cleanupFixture(root);
    }
  });

  it("preloads a deleted imported skill from the captured body without dispatch warnings", async () => {
    const handle = fakeSdk({ replies: Array.from({ length: 7 }, () => "SNAPSHOT-FINAL") });
    const preloadedPrompts: string[] = [];
    const BaseLoader = handle.sdk.DefaultResourceLoader;
    const sdk = {
      ...handle.sdk,
      DefaultResourceLoader: class extends BaseLoader {
        constructor(options: any) {
          super(options);
          preloadedPrompts.push(String(options.systemPromptOverride()));
        }
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let preloadSkillFile = "";
    const { fresh, root } = await freshControlPi({ sdk }, (projectRoot) => {
      const agentDir = path.join(projectRoot, ".claude", "agents");
      const forkDir = path.join(projectRoot, ".claude", "skills", "named-fork");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.mkdirSync(forkDir, { recursive: true });
      installPluginFixture(projectRoot, "preload-owner@market", "preload-owner", (installRoot) => {
        const skillDir = path.join(installRoot, "skills", "snapshot-preload");
        fs.mkdirSync(skillDir, { recursive: true });
        preloadSkillFile = path.join(skillDir, "SKILL.md");
        fs.writeFileSync(preloadSkillFile, [
          "---", "name: snapshot-preload", "description: preload snapshot canary", "---", "snapshot-data=${CLAUDE_PLUGIN_DATA}",
        ].join("\n"), "utf8");
      });
      fs.writeFileSync(path.join(agentDir, "preload-agent.md"), [
        "---", "name: preload-agent", "description: preload canary", "skills:", "  - preload-owner:snapshot-preload", "---", "Run as owner.",
      ].join("\n"), "utf8");
      fs.writeFileSync(path.join(forkDir, "SKILL.md"), [
        "---", "name: named-fork", "description: named fork canary", "context: fork", "agent: preload-agent", "---", "run named fork",
      ].join("\n"), "utf8");
    });
    fs.rmSync(preloadSkillFile);
    try {
      const expectedDataPath = path.join(
        root,
        ".claude-user",
        "plugins",
        "data",
        sanitizePluginDataKey("preload-owner@market"),
      );
      const expectedTypedFork = {
        action: "transform",
        text: "The named-fork skill ran in a forked subagent. Its result:\n\nSNAPSHOT-FINAL",
      };
      const typedPrint = await fresh.fire("input", { text: "/named-fork", source: "print" }, fresh.printCtx());
      expect(typedPrint).toEqual(expectedTypedFork);
      expect(fresh.notifications).toHaveLength(0);

      const agent = fresh.tools.get("Agent");
      for (let index = 0; index < 2; index++) {
        const result = await agent.execute(
          `preload-${index}`,
          { subagent_type: "preload-agent", prompt: "run", run_in_background: false },
          undefined,
          undefined,
          index === 0 ? fresh.printCtx() : fresh.tuiCtx(),
        );
        expect(JSON.stringify(result.content)).toContain("SNAPSHOT-FINAL");
        expect(JSON.stringify(result.details.diagnostics)).not.toMatch(/omitted preloaded skill|Reconcile or reinstall|canonical \/reload/);
      }
      const skill = fresh.tools.get("Skill");
      const slash = fresh.tools.get("SlashCommand");
      const printFork = await skill.execute("fork-print", { name: "named-fork" }, undefined, undefined, fresh.printCtx());
      expect(printFork.content).toEqual([{ type: "text", text: "SNAPSHOT-FINAL" }]);
      expect(JSON.stringify(printFork.details.diagnostics)).not.toContain("omitted preloaded skill");
      const tuiFork = await slash.execute("fork-tui", { command: "/named-fork" }, undefined, undefined, fresh.tuiCtx());
      expect(tuiFork.content).toEqual([{ type: "text", text: "SNAPSHOT-FINAL" }]);
      expect(JSON.stringify(tuiFork.details.diagnostics)).not.toContain("omitted preloaded skill");

      const typedTui = await fresh.fire("input", { text: "/named-fork", source: "interactive" }, fresh.tuiCtx());
      const repeatedTypedTui = await fresh.fire("input", { text: "/named-fork", source: "interactive" }, fresh.tuiCtx());
      expect(typedTui).toEqual(expectedTypedFork);
      expect(repeatedTypedTui).toEqual(expectedTypedFork);
      expect(fresh.notifications).toHaveLength(0);

      expect(handle.promptCalls()).toBe(7);
      expect(preloadedPrompts).toHaveLength(7);
      for (const prompt of preloadedPrompts) {
        expect(prompt).toContain("## Preloaded skill: preload-owner:snapshot-preload");
        expect(prompt).toContain(`snapshot-data=${expectedDataPath}`);
        expect(prompt).not.toContain("${CLAUDE_PLUGIN_DATA}");
      }
      const warnings = error.mock.calls.map((call) => String(call[0])).join("\n");
      expect(warnings).not.toMatch(/omitted preloaded skill|Reconcile or reinstall|canonical \/reload/);
      await fresh.commands.get("doctor").handler("", fresh.tuiCtx());
      const report = String(fresh.entries.at(-1)?.data?.output ?? "");
      expect(report).not.toMatch(/omitted preloaded skill|Reconcile or reinstall|Plugin runtime failures \(execution did not occur\)/);
    } finally {
      error.mockRestore();
      cleanupFixture(root);
    }
  });

  it("registers a successfully activated skill hook once across repeated activation", async () => {
    const { fresh, root } = await freshControlPi(undefined, (projectRoot) => {
      const skillDir = path.join(projectRoot, ".claude", "skills", "hook-once");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
        "---", "name: hook-once", "description: hook once canary", "hooks:",
        "  PreToolUse:", "    - hooks:", "        - type: command",
        "          command: exit 2", "          once: true", "---", "valid body",
      ].join("\n"), "utf8");
    });
    try {
      const skill = fresh.tools.get("Skill");
      await skill.execute("first", { name: "hook-once" });
      await skill.execute("second", { name: "hook-once" });
      const first = await fresh.fire("tool_call", { toolName: "read", toolCallId: "one", input: { path: "a" } }, fresh.tuiCtx());
      const second = await fresh.fire("tool_call", { toolName: "read", toolCallId: "two", input: { path: "b" } }, fresh.tuiCtx());
      expect(first).toMatchObject({ block: true });
      expect(second).toBeUndefined();
    } finally {
      cleanupFixture(root);
    }
  });
});

describe("reserved-name skill collisions", () => {
  async function collisionProject(mcpName: string): Promise<{ fresh: FakePi; root: string }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-collision-"));
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "Collision fixture.\n");
    const skills: Array<[string, string, string]> = [
      [mcpName, "description: MCP collision", "MCP-COLLISION-BODY"],
      ["MoDeL", "description: model collision\ndisable-model-invocation: true", "MODEL-COLLISION-BODY"],
      ["ordinary", "description: ordinary skill", "ORDINARY-SKILL-BODY"],
      ["alpha_1", "description: underscore skill", "UNDERSCORE-SKILL-BODY"],
      ["dash-name", "description: hyphen skill", "HYPHEN-SKILL-BODY"],
      ["!leading", "description: leading punctuation\ndisable-model-invocation: true", "LEADING-PUNCTUATION-BODY"],
      [".dot", "description: dotted skill", "DOT-SKILL-BODY"],
      ["éclair", "description: non-ASCII skill", "NONASCII-SKILL-BODY"],
      [path.join("nested", "alias"), "description: nested alias", "NESTED-ALIAS-BODY"],
    ];
    for (const [name, frontmatter, body] of skills) {
      const skillDir = path.join(root, ".claude", "skills", name);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
    }
    const userDir = path.join(root, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    const previousCwd = process.cwd();
    process.chdir(root);
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    const fresh = fakePi();
    picc(fresh.api as never, { onInitializationSettled: fresh.captureInitialization });
    await fresh.waitForInitialization();
    process.chdir(previousCwd);
    return { fresh, root };
  }

  it.each(["mcp", "McP"])("classifies %s and Pi built-in collisions truthfully without changing ordinary skills", async (mcpName) => {
    const { fresh, root } = await collisionProject(mcpName);
    try {
      const resources = await fresh.fire("resources_discover", { reason: "startup" });
      const promptDir = resources.promptPaths[0] as string;
      expect(fs.existsSync(path.join(promptDir, `${mcpName}.md`))).toBe(false);
      expect(fs.existsSync(path.join(promptDir, "MoDeL.md"))).toBe(false);
      expect(fs.existsSync(path.join(promptDir, "ordinary.md"))).toBe(true);
      expect(fs.existsSync(path.join(promptDir, "alpha_1.md"))).toBe(true);
      expect(fs.existsSync(path.join(promptDir, "dash-name.md"))).toBe(true);
      expect(fs.existsSync(path.join(promptDir, "nested:alias.md"))).toBe(false);
      expect(fs.existsSync(path.join(promptDir, "!leading.md"))).toBe(false);
      expect(fs.existsSync(path.join(promptDir, ".dot.md"))).toBe(false);
      expect(fs.existsSync(path.join(promptDir, "éclair.md"))).toBe(false);

      expect(fresh.commands.get("skills").description).toContain("invocation availability");
      await fresh.commands.get("skills").handler("", fresh.tuiCtx());
      const listing = String(fresh.entries.at(-1)?.data.output ?? "");
      expect(listing).toContain("Shadowed by reserved built-ins");
      expect(listing).toContain(`/${mcpName} — built-in /mcp wins; direct Skill invocation remains allowed`);
      expect(listing).toContain("/MoDeL — built-in /model wins; direct Skill invocation is not allowed");
      expect(listing).toContain("/ordinary");
      expect(listing).toContain("/alpha_1");
      expect(listing).toContain("/dash-name");
      expect(listing).toContain("/nested:alias");
      expect(listing).toContain("Unsupported slash names (3)");
      expect(listing).toContain('"!leading" — direct Skill invocation is not allowed (disable-model-invocation)');
      expect(listing).toContain('".dot" — direct Skill invocation remains allowed');
      expect(listing).toContain('"éclair" — direct Skill invocation remains allowed');
      expect(listing.slice(listing.indexOf("Invocable as slash commands"), listing.indexOf("Shadowed")))
        .not.toMatch(/\/mcp|\/model/i);
      const unsupportedSection = listing.slice(listing.indexOf("Unsupported slash names"));
      expect(unsupportedSection).not.toMatch(/  \/(?:!leading|\.dot|éclair)/u);

      const slash = fresh.tools.get("SlashCommand");
      expect(slash.description).toContain("Reserved built-in names cannot activate skills");
      await expect(slash.execute("slash-reserved", { command: `/${mcpName} ARG_SECRET` }))
        .rejects.toThrow("reserved by a built-in");
      await expect(slash.execute("slash-pi-reserved", { command: "/MODEL ARG_SECRET" }))
        .rejects.toThrow("reserved by a built-in");
      await expect(slash.execute("slash-no-reflection", { command: `/${mcpName} ARG_SECRET` }))
        .rejects.not.toThrow("ARG_SECRET");

      const skill = fresh.tools.get("Skill");
      expect(JSON.stringify(await skill.execute("skill-direct", { name: mcpName })))
        .toContain("MCP-COLLISION-BODY");
      const denied = await skill.execute("skill-denied", { name: "MoDeL" })
        .then(() => undefined, (error: unknown) => error as Error);
      expect(denied?.message).toBe(
        "Direct Skill invocation is disabled. Built-in /model owns this reserved name, and no slash fallback can activate the skill.",
      );
      expect(denied?.message).not.toContain("Ask the user");
      expect(denied?.message).not.toContain("MoDeL");

      expect(await fresh.fire("input", { text: `/${mcpName} ARG_SECRET`, source: "interactive" }, fresh.tuiCtx()))
        .toEqual({ action: "handled" });
      expect(JSON.stringify(fresh.messages)).not.toContain("ARG_SECRET");

      const piOwned = await fresh.fire(
        "input",
        { text: "/MODEL MODEL_TYPED_ARGUMENT_CANARY", source: "interactive" },
        fresh.tuiCtx(),
      );
      expect(piOwned).toEqual({ action: "handled" });
      const guidance = String(fresh.entries.at(-1)?.data.output ?? "");
      expect(guidance).toBe("Canonical /model is a Pi built-in but was not run from this input path. Use canonical /model in the interactive TUI; no project skill ran.");
      expect(JSON.stringify({ piOwned, entries: fresh.entries, messages: fresh.messages }))
        .not.toMatch(/MODEL-COLLISION-BODY|MODEL_TYPED_ARGUMENT_CANARY/);
      expect(fresh.messages).toEqual([]);
      expect(fresh.userMessages).toEqual([]);

      expect(await fresh.fire(
        "input",
        { text: "/model CANONICAL_ARGUMENT_CANARY", source: "rpc" },
        fresh.rpcCtx(),
      )).toEqual({ action: "handled" });
      expect(String(fresh.entries.at(-1)?.data.output)).toBe(guidance);
      expect(JSON.stringify({ entries: fresh.entries, messages: fresh.messages, userMessages: fresh.userMessages }))
        .not.toContain("CANONICAL_ARGUMENT_CANARY");
      expect(await fresh.fire(
        "input",
        { text: "/modelx", source: "interactive" },
        fresh.tuiCtx(),
      )).toEqual({ action: "continue" });

      for (const [token, body] of [
        ["ordinary", "ORDINARY-SKILL-BODY"],
        ["alpha_1", "UNDERSCORE-SKILL-BODY"],
        ["dash-name", "HYPHEN-SKILL-BODY"],
        ["nested:alias", "NESTED-ALIAS-BODY"],
      ] as const) {
        const typed = await fresh.fire("input", { text: `/${token}`, source: "interactive" }, fresh.tuiCtx());
        expect(typed.action).toBe("transform");
        expect(String(typed.text)).toContain(body);
      }
      for (const token of ["!leading", ".dot", "éclair"]) {
        expect(await fresh.fire("input", { text: `/${token}`, source: "interactive" }, fresh.tuiCtx()))
          .toEqual({ action: "continue" });
        expect(JSON.stringify(fresh.messages)).not.toContain(`${token}-BODY`);
      }

      await expect(skill.execute("direct-invalid-denied", { name: "!leading" }))
        .rejects.toThrow("disable-model-invocation");
      for (const [name, body] of [
        [".dot", "DOT-SKILL-BODY"],
        ["éclair", "NONASCII-SKILL-BODY"],
      ] as const) {
        expect(JSON.stringify(await skill.execute(`direct-${name}`, { name }))).toContain(body);
      }
      await expect(skill.execute("direct-qualified", { name: "nested:alias" }))
        .rejects.toThrow("disable-model-invocation");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

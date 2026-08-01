import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc, { type PiccTestSeam } from "../src/index.js";
import { sanitizePluginDataKey } from "../src/claude/plugin-paths.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { deferred } from "./helpers/async.js";
import { fakeSdk } from "./helpers/fake-sdk.js";
import { createHookProcessFixture } from "./helpers/hook-process.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

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

function controlEntry(command: string) {
  return pi.entries.find((e) => e.customType === "picc-control" && e.data?.command === command);
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
      const admissionModes = [
        ["tui", () => fresh.tuiCtx()],
        ["print", () => fresh.printCtx()],
        ["json", () => fresh.ctx({ mode: "json", hasUI: false })],
        ["rpc", () => fresh.rpcCtx()],
      ] as const;
      const fixedOutputs = new Map<string, string>();
      for (const name of ["plugin", "plugins", "reload-plugins"] as const) {
        for (const [mode, makeCtx] of admissionModes) {
          fresh.messages.length = 0;
          fresh.entries.length = 0;
          const mixed = name === "reload-plugins" ? "ReLoAd-PlUgInS" : name === "plugins" ? "PlUgInS" : "PlUgIn";
          const secret = `SECRET-${name}-${mode}`;
          expect(await fresh.fire("input", {
            text: `  /${mixed}   ${secret}  `,
            source: mode === "tui" ? "interactive" : mode,
          }, makeCtx())).toEqual({ action: "handled" });
          const output = String(fresh.entries.find((entry) => entry.data?.command === name)?.data?.output ?? "");
          expect(output).not.toContain(secret);
          expect(JSON.stringify(fresh.messages)).not.toContain("MUST-NOT-EGRESS");
          const prior = fixedOutputs.get(name);
          if (prior === undefined) fixedOutputs.set(name, output);
          else expect(output).toBe(prior);
        }
      }

      for (const name of ["plugin", "plugins"] as const) {
        const output = fixedOutputs.get(name) ?? "";
        expect(output).toContain("Claude Code");
        expect(output).toContain("canonical /reload in the interactive TUI");
        expect(output).toContain("whole extension, including installed plugin state");
        expect(output).toContain("or exit and relaunch");
        expect(output).toContain("/new does not reload plugin state");
        expect(output).toContain("no changes were made");
      }
      const reloadOutput = fixedOutputs.get("reload-plugins") ?? "";
      expect(reloadOutput).toContain("/reload-plugins did no reload");
      expect(reloadOutput).toContain("canonical /reload in the interactive TUI");
      expect(reloadOutput).toContain("whole extension, including installed plugin state");
      expect(reloadOutput).toContain("or exit and relaunch");

      for (const name of ["plugin", "plugins", "reload-plugins"] as const) {
        await fresh.commands.get(name).handler("SECRET-ARG-MUST-NOT-REFLECT", fresh.tuiCtx());
        const direct = [...fresh.entries].reverse().find((entry) => entry.data?.command === name)?.data?.output;
        expect(direct).toBe(fresh.entries.find((entry) => entry.data?.command === name)?.data?.output);
        expect(String(direct)).not.toContain("SECRET-ARG-MUST-NOT-REFLECT");
      }

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
      const nearPrefix = await fresh.fire("input", { text: "/pluginx", source: "rpc" }, fresh.rpcCtx());
      expect(nearPrefix).toMatchObject({ action: "transform" });
      expect(nearPrefix.text).toContain("/pluginx");
    } finally {
      await hookFixture?.cleanup("reserved-submit");
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
  it("warns once at TUI startup and stderr in headless startup, while non-startup and valid outcomes stay quiet", async () => {
    const failed = [{ pluginId: "missing@market", status: "enabled-but-uninstalled" as const, diagnostics: [] }];
    const tui = await freshControlPi({ pluginResolutionOutcomes: failed });
    const headless = await freshControlPi({ pluginResolutionOutcomes: failed });
    const valid = await freshControlPi({ pluginResolutionOutcomes: [
      { pluginId: "loaded@market", status: "loaded", diagnostics: [] },
      { pluginId: "disabled@market", status: "disabled", diagnostics: [] },
    ] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await tui.fresh.fire("session_start", { reason: "startup" }, tui.fresh.tuiCtx());
      expect(tui.fresh.notifications.filter((item) => item.text.includes("missing@market"))).toHaveLength(1);
      tui.fresh.notifications.length = 0;
      await tui.fresh.fire("session_start", { reason: "new" }, tui.fresh.tuiCtx());
      await tui.fresh.fire("session_start", { reason: "reload" }, tui.fresh.tuiCtx());
      expect(tui.fresh.notifications.filter((item) => item.text.includes("missing@market"))).toHaveLength(0);

      await headless.fresh.fire("session_start", { reason: "startup" }, headless.fresh.printCtx());
      expect(error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("missing@market"))).toHaveLength(1);

      await valid.fresh.fire("session_start", { reason: "startup" }, valid.fresh.tuiCtx());
      expect(valid.fresh.notifications.some((item) => item.text.includes("plugin content did not load"))).toBe(false);
    } finally {
      error.mockRestore();
      cleanupFixture(tui.root);
      cleanupFixture(headless.root);
      cleanupFixture(valid.root);
    }
  });
});

describe("plugin activation runtime failures", () => {
  it("fails tools, typed slash, and context:fork before any staged state or provider egress, then reports once", async () => {
    const sdk = fakeSdk({ replies: ["MUST-NOT-RUN"] });
    let skillFile = "";
    const { fresh, root } = await freshControlPi({ sdk: sdk.sdk }, (projectRoot) => {
      installPluginFixture(projectRoot, "broken-owner@market", "broken-owner", (installRoot) => {
        const skillDir = path.join(installRoot, "skills", "broken-plugin-skill");
        skillFile = path.join(skillDir, "SKILL.md");
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(skillFile, [
          "---",
          "name: broken-plugin-skill",
          "description: runtime failure canary",
          "context: fork",
          "hooks:",
          "  PreToolUse:",
          "    - hooks:",
          "        - type: command",
          "          command: echo MUST-NOT-RUN",
          "---",
          "data=${CLAUDE_PLUGIN_DATA}",
        ].join("\n"), "utf8");
      });
    });
    fs.rmSync(skillFile);
    try {
      const skill = fresh.tools.get("Skill");
      const slash = fresh.tools.get("SlashCommand");
      const skillError = await skill.execute("broken-skill", { name: "broken-plugin-skill" })
        .then(() => undefined, (caught: unknown) => caught as Error);
      expect(skillError?.message).toMatch(/Reconcile or reinstall.*canonical \/reload.*exit and relaunch PiCC/);
      expect(skillError?.message.match(/Reconcile or reinstall/g)).toHaveLength(1);
      await expect(slash.execute("broken-slash", { command: "/broken-plugin-skill" }))
        .rejects.toThrow(/Reconcile or reinstall.*canonical \/reload.*exit and relaunch PiCC/);
      const typed = await fresh.fire("input", { text: "/broken-plugin-skill", source: "interactive" }, fresh.printCtx());
      expect(typed).toEqual({ action: "handled" });
      expect(fresh.messages).toEqual([]);
      expect(fresh.userMessages).toEqual([]);
      expect(sdk.created).toHaveLength(0);
      expect(sdk.promptCalls()).toBe(0);
      const before = await fresh.fire("before_agent_start", { systemPrompt: "base" }, fresh.printCtx());
      expect(String(before?.systemPrompt ?? "")).not.toContain("data=${CLAUDE_PLUGIN_DATA}");
      const unblocked = await fresh.fire("tool_call", {
        toolName: "read", toolCallId: "after-failed-fork", input: { path: "safe.txt" },
      }, fresh.printCtx());
      expect(unblocked).toBeUndefined();

      await fresh.commands.get("doctor").handler("", fresh.tuiCtx());
      const report = String([...fresh.entries].reverse().find((entry) => entry.data?.command === "doctor")?.data?.output ?? "");
      expect(report).toContain("Plugin runtime failures (execution did not occur):");
      expect(report.match(/broken-plugin-skill/g)?.length).toBe(1);
      expect(report).not.toContain("Unassessed (unknown at baseline");
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
      expect(report).not.toContain("canonical /reload");
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
      expect(report).not.toContain("canonical /reload");
      expect(report).not.toContain("trusted context");
    } finally {
      cleanupFixture(root);
    }
  });

  it("omits a failed preloaded plugin skill with dispatch diagnostics and one immediate warning while the owner runs", async () => {
    const handle = fakeSdk({ replies: Array.from({ length: 6 }, () => "LOCKED-FINAL") });
    const BaseLoader = handle.sdk.DefaultResourceLoader;
    const sdk = {
      ...handle.sdk,
      DefaultResourceLoader: class extends BaseLoader {
        constructor(options: any) {
          super(options);
          options.systemPromptOverride();
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
        const skillDir = path.join(installRoot, "skills", "broken-preload");
        fs.mkdirSync(skillDir, { recursive: true });
        preloadSkillFile = path.join(skillDir, "SKILL.md");
        fs.writeFileSync(preloadSkillFile, [
          "---", "name: broken-preload", "description: preload data canary", "---", "data=${CLAUDE_PLUGIN_DATA}",
        ].join("\n"), "utf8");
      });
      fs.writeFileSync(path.join(agentDir, "preload-agent.md"), [
        "---", "name: preload-agent", "description: preload canary", "skills:", "  - preload-owner:broken-preload", "---", "Run as owner.",
      ].join("\n"), "utf8");
      fs.writeFileSync(path.join(forkDir, "SKILL.md"), [
        "---", "name: named-fork", "description: named fork canary", "context: fork", "agent: preload-agent", "---", "run named fork",
      ].join("\n"), "utf8");
    });
    fs.rmSync(preloadSkillFile);
    try {
      const expectedTypedFork = {
        action: "transform",
        text: "The named-fork skill ran in a forked subagent. Its result:\n\nLOCKED-FINAL",
      };
      const typedPrint = await fresh.fire("input", { text: "/named-fork", source: "print" }, fresh.printCtx());
      expect(typedPrint).toEqual(expectedTypedFork);
      expect(fresh.notifications).toHaveLength(0);
      const typedPrintWarnings = error.mock.calls.map((call) => String(call[0]))
        .filter((line) => line.includes("omitted preloaded skill"));
      expect(typedPrintWarnings).toHaveLength(1);
      expect(typedPrintWarnings[0]).toContain("Reconcile or reinstall");
      expect(typedPrintWarnings[0]).toContain("canonical /reload");

      const agent = fresh.tools.get("Agent");
      for (let index = 0; index < 2; index++) {
        const result = await agent.execute(
          `preload-${index}`,
          { subagent_type: "preload-agent", prompt: "run", run_in_background: false },
          undefined,
          undefined,
          index === 0 ? fresh.printCtx() : fresh.tuiCtx(),
        );
        expect(JSON.stringify(result.content)).toContain("LOCKED-FINAL");
        expect(JSON.stringify(result.content)).not.toContain("omitted preloaded skill");
        expect(result.details.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ severity: "warning", message: expect.stringContaining("omitted preloaded skill") }),
        ]));
      }
      const skill = fresh.tools.get("Skill");
      const slash = fresh.tools.get("SlashCommand");
      const printFork = await skill.execute("fork-print", { name: "named-fork" }, undefined, undefined, fresh.printCtx());
      expect(printFork.content).toEqual([{ type: "text", text: "LOCKED-FINAL" }]);
      expect(printFork.details.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("omitted preloaded skill") }),
      ]));
      const tuiFork = await slash.execute("fork-tui", { command: "/named-fork" }, undefined, undefined, fresh.tuiCtx());
      expect(tuiFork.content).toEqual([{ type: "text", text: "LOCKED-FINAL" }]);
      expect(tuiFork.details.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("omitted preloaded skill") }),
      ]));
      expect(fresh.notifications.filter((item) => item.text.includes("omitted preloaded skill"))).toHaveLength(0);

      const typedTui = await fresh.fire("input", { text: "/named-fork", source: "interactive" }, fresh.tuiCtx());
      const repeatedTypedTui = await fresh.fire("input", { text: "/named-fork", source: "interactive" }, fresh.tuiCtx());
      expect(typedTui).toEqual(expectedTypedFork);
      expect(repeatedTypedTui).toEqual(expectedTypedFork);
      const tuiWarnings = fresh.notifications.filter((item) => item.text.includes("omitted preloaded skill"));
      expect(tuiWarnings).toHaveLength(1);
      expect(tuiWarnings[0]).toMatchObject({ severity: "warning" });
      expect(expectedTypedFork.text).not.toContain("omitted preloaded skill");

      const warnings = error.mock.calls.map((call) => String(call[0]))
        .filter((line) => line.includes("omitted preloaded skill"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Reconcile or reinstall");
      expect(warnings[0]).toContain("canonical /reload");
      expect(handle.promptCalls()).toBe(7);
      await fresh.commands.get("doctor").handler("", fresh.tuiCtx());
      expect(String(fresh.entries.at(-1)?.data?.output ?? "")).toContain("omitted preloaded skill");
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

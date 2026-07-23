import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc, { type PiccTestSeam } from "../src/index.js";
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

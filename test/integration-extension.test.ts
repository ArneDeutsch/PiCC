import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc, { type PiccTestSeam } from "../src/index.js";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { BackgroundResultLike } from "../src/runtime/background-tasks.js";
import { resolveGitBashPath } from "../src/engine/shell-inject.js";
import { RECORD_EXPAND_HINT } from "../src/runtime/subagent-render.js";
import type { PiSessionMessage } from "../src/runtime/subagents.js";
import { formatElapsed } from "../src/runtime/subagent-panel-render.js";
import { createGlobTool, createGrepTool } from "../src/runtime/tools/search-tools.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk, type FakeCustomTool, type FakeSessionState } from "./helpers/fake-sdk.js";
import { deferred, waitUntil } from "./helpers/async.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";
import { loadSkills } from "../src/claude/skills.js";

/**
 * Integration + NFR tests: the whole extension wired against
 * the full-surface conformance fixture through a fake Pi API. No LLM/network involved —
 * these assert the mechanical-fidelity tier end to end.
 */

let dir: string;
let pi: FakePi;
const originalCwd = process.cwd();
const compatAckSentinel = '{"suppressed":true,"sentinel":"KEEP-BYTES"}\n';

beforeAll(async () => {
  dir = materializeFixture("full-surface");
  // Seedable gitignored files for .worktreeinclude
  fs.writeFileSync(path.join(dir, ".env.local"), "SECRET=1\n");
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "app.secret"), "s\n");
  const ack = path.join(dir, ".claude", ".picc", "compat-ack.json");
  fs.mkdirSync(path.dirname(ack), { recursive: true });
  fs.writeFileSync(ack, compatAckSentinel, "utf8");
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
  cleanupFixture(dir);
});

async function proveRuntimeAdmissionCapacity(options: {
  expectedCapacity: number;
  override?: number;
}): Promise<void> {
  const fixture = materializeFixture("hello-claude");
  const previousCwd = process.cwd();
  const hadPreviousUserDir = Object.hasOwn(process.env, "PICC_CLAUDE_USER_DIR");
  const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
  const release = deferred<void>();
  const handle = fakeSdk({ replies: [{ text: "capacity-complete", gate: release.promise }] });
  let dispatches: Array<Promise<unknown>> = [];

  try {
    const userDir = path.join(fixture, ".picc-hermetic-user");
    fs.mkdirSync(userDir, { recursive: true });
    if (options.override !== undefined) {
      const settingsDir = path.join(fixture, ".claude");
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, "settings.json"),
        `${JSON.stringify({ subagents: { concurrency: options.override } }, null, 2)}\n`,
      );
    }

    process.chdir(fixture);
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    const capacityPi = fakePi();
    picc(capacityPi.api as never, {
      sdk: handle.sdk,
      managedSettingsPaths: [],
      managedArtifactDirs: [],
      onInitializationSettled: capacityPi.captureInitialization,
    });
    await capacityPi.waitForInitialization();
    await capacityPi.waitForTools(["Agent"]);

    const agent = capacityPi.tools.get("Agent");
    dispatches = Array.from({ length: options.expectedCapacity + 1 }, (_, index) =>
      agent.execute(`capacity-${index}`, {
        subagent_type: "general-purpose",
        prompt: `held dispatch ${index}`,
        run_in_background: false,
      }) as Promise<unknown>,
    );

    await handle.waitForPromptCalls(options.expectedCapacity);
    expect(handle.promptCalls()).toBe(options.expectedCapacity);
    expect(handle.sessions).toHaveLength(options.expectedCapacity);

    release.resolve();
    const settled = await Promise.allSettled(dispatches);
    for (const result of settled) {
      expect(result.status).toBe("fulfilled");
      if (result.status === "fulfilled") {
        expect((result.value as { details?: { outcome?: string } }).details?.outcome).toBe("completed");
      }
    }
    expect(handle.promptCalls()).toBe(options.expectedCapacity + 1);
    expect(handle.sessions).toHaveLength(options.expectedCapacity + 1);
  } finally {
    release.resolve();
    await Promise.allSettled(dispatches);
    dispatches = [];
    process.chdir(previousCwd);
    if (hadPreviousUserDir) process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
    else delete process.env.PICC_CLAUDE_USER_DIR;
    cleanupFixture(fixture);
  }
}

describe("settings-to-runtime subagent concurrency wiring", () => {
  it("admits ten root dispatches by default while an eleventh waits", async () => {
    await proveRuntimeAdmissionCapacity({ expectedCapacity: 10 });
  });

  it("honors an effective override of two while a third dispatch waits", async () => {
    await proveRuntimeAdmissionCapacity({ expectedCapacity: 2, override: 2 });
  });
});

describe("tool surface registration", () => {
  it("registers the Claude tool surface", () => {
    for (const name of [
      "Agent",
      "Task",
      "Skill",
      "SlashCommand",
      "WebFetch",
      "WebSearch",
      "Grep",
      "Glob",
      "NotebookRead",
      "MultiEdit",
      "EnterWorktree",
      "ExitWorktree",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TodoWrite",
    ]) {
      expect(pi.tools.has(name), `missing tool ${name}`).toBe(true);
    }
  });

  it.each([
    {
      name: "WebFetch",
      args: { url: "https://example.test/invoked" },
      result: {
        content: [{ type: "text", text: "registered fetch body" }],
        details: {
          url: "https://example.test/invoked",
          finalUrl: "https://redirect.test/final",
          status: 200,
          contentType: "text/plain",
          truncated: false,
        },
      },
      invocation: "https://example.test/invoked",
      hidden: "registered fetch body",
    },
    {
      name: "WebSearch",
      args: { query: "registered query" },
      result: {
        content: [{ type: "text", text: "registered search title and snippet" }],
        details: { query: "registered query", backend: "brave", resultCount: 1, truncated: false },
      },
      invocation: "registered query",
      hidden: "registered search title",
    },
  ])("compactly renders registered $name without changing canonical payloads", ({ name, args, result, invocation, hidden }) => {
    const tool = pi.tools.get(name);
    const argsBefore = structuredClone(args);
    const resultBefore = structuredClone(result);
    expect(tool.renderCall(args, undefined, { args }).render(80)).toEqual([]);
    const lines = tool.renderResult(
      result,
      { expanded: false, isPartial: false },
      undefined,
      { args, isError: false },
    ).render(80) as string[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(invocation);
    expect(lines.join("\n")).not.toContain(hidden);
    expect(args).toEqual(argsBefore);
    expect(result).toEqual(resultBefore);
  });

  it("installs collapse only on main-session tool definitions", async () => {
    for (const name of ["read", "write", "edit", "MultiEdit", "bash"]) {
      expect(pi.tools.get(name).renderShell, name).toBe("self");
    }
    const previousBindings = getKeybindings();
    setKeybindings(new KeybindingsManager({ ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } }));
    try {
      const read = pi.tools.get("read");
      const args = { path: "registered.txt" };
      const state = {};
      const theme = { fg: (_slot: string, text: string) => text, bold: (text: string) => text,
        bg: (_slot: string, text: string) => text };
      const context = { args, state, isPartial: false, isError: false, expanded: false,
        cwd: dir, showImages: false, invalidate() {} };
      read.renderCall(args, theme, context);
      const rendered = read.renderResult(
        { content: [{ type: "text", text: "REGISTERED_DETAIL_ONE\nREGISTERED_DETAIL_TWO" }], details: undefined },
        { expanded: false, isPartial: false }, theme, context,
      ).render(160).join("\n");
      expect(rendered).toContain("read registered.txt · 2 lines hidden · ctrl+o to expand");
      expect(rendered).not.toContain("REGISTERED_DETAIL");

      const multiEdit = pi.tools.get("MultiEdit");
      const multiEditArgs = {
        file_path: "registered-multi.txt",
        edits: [{ old_string: "REGISTERED_MULTIEDIT_DETAIL_OLD", new_string: "REGISTERED_MULTIEDIT_DETAIL_NEW" }],
      };
      const multiEditState = {};
      const multiEditContext = { args: multiEditArgs, state: multiEditState, isPartial: false,
        isError: false, expanded: false, cwd: dir, showImages: false, invalidate() {} };
      multiEdit.renderCall(multiEditArgs, theme, multiEditContext);
      const multiEditRendered = multiEdit.renderResult(
        {
          content: [{ type: "text", text: "Successfully applied 1 edit(s) to registered-multi.txt." }],
          details: {
            filePath: "registered-multi.txt",
            edits: 1,
            created: false,
            diff: "-REGISTERED_MULTIEDIT_DETAIL_OLD\n+REGISTERED_MULTIEDIT_DETAIL_NEW",
            firstChangedLine: 1,
          },
        },
        { expanded: false, isPartial: false }, theme, multiEditContext,
      ).render(160).join("\n");
      expect(multiEditRendered).toContain("multi edit registered-multi.txt · 1 edit applied · 2 diff lines hidden · ctrl+o to expand");
      expect(multiEditRendered).not.toContain("REGISTERED_MULTIEDIT_DETAIL");
    } finally {
      setKeybindings(previousBindings);
    }

    const created: Array<Record<string, unknown>> = [];
    const handle = fakeSdk({ replies: ["done"], created });
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    handle.sdk.createReadToolDefinition = (cwd: string) => sdk.createReadToolDefinition(cwd);
    const rawEditCallContexts: any[] = [];
    const rawEditResultContexts: any[] = [];
    const rawEditRenderCall = vi.fn((_args: unknown, _theme: unknown, context: any) => {
      rawEditCallContexts.push(context);
      return context.lastComponent ?? { render: () => [`raw edit call ${context.cwd}`] };
    });
    const rawEditRenderResult = vi.fn((_result: unknown, _options: unknown, _theme: unknown, context: any) => {
      rawEditResultContexts.push(context);
      return { render: () => [`raw edit result ${context.cwd}`] };
    });
    handle.sdk.createEditToolDefinition = () => ({
      renderCall: rawEditRenderCall,
      renderResult: rawEditRenderResult,
    }) as never;
    const fresh = fakePi();
    let internals!: Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];
    picc(fresh.api as never, {
      onWired: (value) => { internals = value; },
      onInitializationSettled: fresh.captureInitialization,
    });
    await fresh.waitForInitialization();
    internals.subagentRuntime.setSdkForTest(handle.sdk);
    await fresh.tools.get("Agent").execute("main-only", {
      subagent_type: "general-purpose", prompt: "inspect", run_in_background: false,
    });
    const subagentTools = created[0]?.customTools as Array<Record<string, any>>;
    const rawRead = subagentTools.find((tool) => tool.name === "read");
    const rawEdit = subagentTools.find((tool) => tool.name === "edit");
    const rawMultiEdit = subagentTools.find((tool) => tool.name === "MultiEdit");
    expect(rawRead, "missing subagent read").toBeDefined();
    expect(rawEdit, "missing subagent edit").toBeDefined();
    expect(rawMultiEdit, "missing subagent MultiEdit").toBeDefined();
    expect(rawRead!.renderShell).not.toBe("self");
    expect(rawEdit!.renderShell).not.toBe("self");
    expect(rawMultiEdit!.renderShell).not.toBe("self");
    expect(rawEdit!.renderCall).toBe(rawEditRenderCall);
    expect(rawEdit!.renderResult).toBe(rawEditRenderResult);

    const renderRaw = (name: string, args: unknown, definition: Record<string, unknown>, result: unknown): string => {
      const row = new sdk.ToolExecutionComponent(
        name, `subagent-${name}`, args, {}, definition,
        { requestRender() {} }, dir.replace(/\\/g, "/"),
      );
      row.setArgsComplete();
      row.markExecutionStarted();
      row.render(160);
      row.updateResult(result, false);
      return (row.render(160) as string[]).join("\n");
    };
    const rawReadRendered = renderRaw("read", { path: "subagent-read.txt" }, rawRead!, {
      content: [{ type: "text", text: "SUBAGENT_READ_DETAIL_ONE\nSUBAGENT_READ_DETAIL_TWO" }],
      details: undefined,
    });
    const rawEditState = {};
    const rawEditCwd = path.join(dir, "subagent-render-cwd").replace(/\\/g, "/");
    const rawEditArgs = { path: "subagent-edit.txt", edits: [] };
    const rawEditInitialContext = {
      state: rawEditState, cwd: rawEditCwd, argsComplete: false, executionStarted: false,
    };
    const rawEditInitial = rawEdit!.renderCall(rawEditArgs, undefined, rawEditInitialContext);
    const rawEditPreviewContext = {
      ...rawEditInitialContext, argsComplete: true, lastComponent: rawEditInitial,
    };
    const rawEditPreview = rawEdit!.renderCall(rawEditArgs, undefined, rawEditPreviewContext);
    const rawEditExecutionContext = {
      ...rawEditPreviewContext, executionStarted: true, lastComponent: rawEditPreview,
    };
    rawEdit!.renderCall(rawEditArgs, undefined, rawEditExecutionContext);
    const rawEditRendered = rawEdit!.renderResult(
      { content: [{ type: "text", text: "raw settled" }], details: undefined },
      { expanded: false, isPartial: false }, undefined, rawEditExecutionContext,
    ).render(160).join("\n");
    expect(rawEditCallContexts).toHaveLength(3);
    expect(rawEditCallContexts.every(({ cwd, state }) => cwd === rawEditCwd && state === rawEditState)).toBe(true);
    expect(rawEditResultContexts).toHaveLength(1);
    expect(rawEditResultContexts[0]).toEqual(expect.objectContaining({ cwd: rawEditCwd, state: rawEditState }));
    const rawMultiEditRendered = renderRaw("MultiEdit", {
      file_path: "subagent-multi.txt",
      edits: [{ old_string: "old", new_string: "new" }],
    }, rawMultiEdit!, {
      content: [{ type: "text", text: "Successfully applied 1 edit(s) to subagent-multi.txt." }],
      details: { filePath: "subagent-multi.txt", edits: 1, created: false, diff: "-old\n+new", firstChangedLine: 1 },
    });
    const rawReadPlain = rawReadRendered
      .replace(/\u001b\].*?(?:\u0007|\u001b\\)/gu, "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    expect(rawReadPlain).toContain("read subagent-read.txt");
    expect(rawEditRendered).toContain(`raw edit result ${rawEditCwd}`);
    expect(rawMultiEditRendered).toContain("Successfully applied 1 edit(s) to subagent-multi.txt.");
    for (const rendered of [rawReadRendered, rawEditRendered, rawMultiEditRendered]) {
      expect(rendered).not.toContain("hidden");
      expect(rendered).not.toContain("to expand");
    }
  });

  it("registers degrade stubs that answer instead of crashing", async () => {
    expect(pi.tools.has("AskUserQuestion")).toBe(true);
    const stub = pi.tools.get("AskUserQuestion");
    const result = await stub.execute("t", { anything: true });
    expect(result.content[0].text).toContain("not available in PiCC");
    expect(result.details.degraded).toBe(true);
  });

  it("overrides Pi built-ins with cwd-swapping wrappers", () => {
    for (const name of ["bash", "read", "write", "edit", "grep", "find", "ls"]) {
      expect(pi.tools.has(name), `missing builtin override ${name}`).toBe(true);
    }
  });

  it("de-pads the re-registered built-ins: renderShell:'self' with renderers installed", () => {
    for (const name of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
      const tool = pi.tools.get(name);
      expect(tool, `missing builtin ${name}`).toBeTruthy();
      expect(tool.renderShell, `${name} not self-shell`).toBe("self");
      // Renderers sourced from create*ToolDefinition (create*Tool strips them),
      // then wrapped by the self-shell seam — BOTH must be installed.
      expect(typeof tool.renderCall, `${name} missing renderCall`).toBe("function");
      expect(typeof tool.renderResult, `${name} missing renderResult`).toBe("function");
      // execute stays sourced from create*Tool (byte-identical) — not stripped.
      expect(typeof tool.execute, `${name} missing execute`).toBe("function");
    }
  });

  it("wired edit keeps its diff under one outer success glyph with no outer background", async () => {
    // edit's renderResult colors the diff body via Pi's theme singleton (renderDiff),
    // which the real TUI initializes at startup — do the same here.
    const { initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme();
    let backgroundCalls = 0;
    const slotTheme = {
      fg: (_c: string, s: string) => s,
      bold: (s: string) => s,
      inverse: (s: string) => s,
      bg: (_slot: string, text: string) => { backgroundCalls++; return text; },
    };
    // Produce a REAL edit result payload (with details.diff) via the WIRED tool.
    fs.writeFileSync(path.join(dir, "t02-edit-target.txt"), "alpha\nbeta\ngamma\n");
    const editArgs = { path: "t02-edit-target.txt", edits: [{ oldText: "beta", newText: "BETAEDITED" }] };
    const result = await pi.tools.get("edit").execute("t02e", editArgs);
    expect(result.details.diff, "edit did not produce a diff").toBeTruthy();

    // Run the SHIPPED closure-local wrapper (via pi.tools.get) over the payload.
    const width = 120;
    const out: string[] = pi.tools
      .get("edit")
      .renderResult(
        result,
        { expanded: true, isPartial: false },
        slotTheme,
        { isPartial: false, isError: false, showImages: false, state: {}, args: editArgs, cwd: dir },
      )
      .render(width);
    expect(out.length).toBeGreaterThan(0);
    const joined = out.join("\n");
    // Diff survived the wrap: removed AND added tokens are both present.
    expect(joined).toContain("beta");
    expect(joined).toContain("BETAEDITED");
    expect(backgroundCalls).toBe(0);
    const plain = out.join("\n").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    expect(plain.match(/●/gu)).toHaveLength(1);
    expect(plain.split("\n")[0]).toMatch(/^● /u);
    expect(plain.split("\n").at(-1)?.trim().length).toBeGreaterThan(0);
  });

  it("de-pads every Claude-named tool row: renderShell:'self' across the registration loop", () => {
    // A representative set spanning both wrapper cases: own-renderer tools
    // (Agent/TaskOutput), high-traffic renderer-less tools (TodoWrite/Grep),
    // SendMessage, and the previously renderer-less TaskStop.
    for (const name of ["Agent", "Task", "TaskOutput", "TaskStop", "SendMessage", "TodoWrite", "Grep"]) {
      const tool = pi.tools.get(name);
      expect(tool, `missing tool ${name}`).toBeTruthy();
      expect(tool.renderShell, `${name} not self-shell`).toBe("self");
      // The wrapper always installs BOTH renderers (own or generic fallback).
      expect(typeof tool.renderCall, `${name} missing renderCall`).toBe("function");
      expect(typeof tool.renderResult, `${name} missing renderResult`).toBe("function");
      // execute is preserved (not stripped by the wrapper).
      expect(typeof tool.execute, `${name} missing execute`).toBe("function");
    }
  });

  it("keeps checkpoint-gated Grep/Glob canonical results unchanged after collapsed and expanded rendering", async () => {
    const searchDir = path.join(dir, "t02-search");
    fs.mkdirSync(searchDir, { recursive: true });
    fs.writeFileSync(path.join(searchDir, "needle.txt"), "alpha\nT02-SEARCH-NEEDLE\nomega\n");

    const cases = [
      {
        name: "Grep",
        args: { pattern: "T02-SEARCH-NEEDLE", path: "t02-search", output_mode: "content" },
        undecorated: createGrepTool(() => dir),
      },
      {
        name: "Glob",
        args: { pattern: "**/*.txt", path: "t02-search" },
        undecorated: createGlobTool(() => dir),
      },
    ] as const;

    for (const search of cases) {
      const registered = pi.tools.get(search.name);
      const result = await registered.execute(`t02-${search.name}`, search.args);
      const baseline = await search.undecorated.execute(
        `baseline-${search.name}`,
        search.args,
        undefined,
        undefined,
        undefined as never,
      );
      expect(result).toEqual(baseline);
      const beforeRender = structuredClone(result);

      for (const expanded of [false, true]) {
        const ctx = {
          args: search.args,
          state: {},
          isPartial: false,
          isError: false,
          expanded,
          showImages: false,
        };
        const call = registered.renderCall(search.args, undefined, ctx);
        const renderedResult = registered.renderResult(
          result,
          { expanded, isPartial: false },
          undefined,
          ctx,
        );
        expect(call.render(80)).toEqual([]);
        const lines = renderedResult.render(80);
        expect(lines).toHaveLength(1);
        expect(lines[0]!.trim()).not.toBe("");
        expect(lines[0]).toContain(search.name.toLowerCase());
        expect(lines[0]).toContain(search.args.pattern);
      }
      expect(result).toEqual(beforeRender);
    }
  });

  it("keeps unrelated Claude and lowercase built-in rendering outside compact specialization", async () => {
    const todo = pi.tools.get("TodoWrite");
    const lowerGrep = pi.tools.get("grep");
    expect(todo.renderCall({}, undefined, { state: {} }).render(80).join("\n")).toContain("todo write");

    const args = { pattern: "T02-LOWERCASE-STOCK", path: "t02-lowercase.txt" };
    fs.writeFileSync(path.join(dir, "t02-lowercase.txt"), "T02-LOWERCASE-STOCK complete stock result\n");
    const result = await lowerGrep.execute("lowercase-stock", args);
    const ctx = { args, state: {}, isError: false, isPartial: false, expanded: false, showImages: false };
    const theme = {
      fg: (_slot: string, text: string) => text,
      bold: (text: string) => text,
      bg: (_slot: string, text: string) => text,
    };
    const callText = lowerGrep.renderCall(args, theme, ctx).render(100).join("\n");
    const resultText = lowerGrep.renderResult(
      result, { expanded: false, isPartial: false }, theme, ctx,
    ).render(100).join("\n");
    expect(callText).toContain("T02-LOWERCASE-STOCK");
    expect(resultText).toContain("complete stock result");
    expect(`${callText}\n${resultText}`).not.toContain("1/1 entries");
  });

  it("wrapped renderers add one foreground glyph without invoking theme.bg", () => {
    let backgroundCalls = 0;
    const theme = {
      fg: (_c: string, s: string) => s,
      bold: (s: string) => s,
      bg: (_slot: string, text: string) => { backgroundCalls++; return text; },
    };
    const ctx = { isPartial: false, isError: false, showImages: false };
    const todo = pi.tools.get("TodoWrite");
    const callLines = todo.renderCall({}, theme, ctx).render(60);
    expect(callLines).toEqual(["● todo write"]);
    expect(backgroundCalls).toBe(0);
  });

  it("registers retained control commands but not /compat", () => {
    for (const name of ["doctor", "quota", "skills", "agents"]) {
      expect(pi.commands.has(name), `missing command ${name}`).toBe(true);
    }
    expect(pi.commands.has("compat")).toBe(false);
  });

  it("exposes user-invocable skills in the / palette via prompt-template stubs (resources_discover)", async () => {
    const rd = await pi.fire("resources_discover", { reason: "startup" });
    expect(rd?.promptPaths?.length).toBeGreaterThan(0);
    const dir = rd.promptPaths[0] as string;
    const stubs = fs.readdirSync(dir).map((f) => f.replace(/\.md$/, ""));
    // user-invocable skills appear...
    expect(stubs).toContain("deploy");
    expect(stubs).toContain("fork-research");
    // ...user-invocable:false skills do not...
    expect(stubs).not.toContain("rust-helper");
    // ...and neither do reserved/built-in names.
    expect(stubs).not.toContain("model");
    expect(stubs).not.toContain("doctor");
    // A stub carries the description and argument hint for the palette.
    const deployStub = fs.readFileSync(path.join(dir, "deploy.md"), "utf8");
    expect(deployStub).toContain("argument-hint:");
    expect(deployStub).toContain("Deploy the app");
  });

  it("/skills lists the loaded corpus grouped by invocability", async () => {
    pi.entries.length = 0;
    await pi.commands.get("skills").handler("", pi.ctx());
    const out = pi.entries
      .filter((e) => e.customType === "picc-control")
      .map((e) => String(e.data?.output ?? ""))
      .join("\n");
    expect(out).toContain("Invocable as slash commands");
    expect(out).toContain("/deploy");
    expect(out).toMatch(/Model-invocable only|User-only/);
  });

  it("/agents lists subagents with tools and read-only markers", async () => {
    pi.entries.length = 0;
    await pi.commands.get("agents").handler("", pi.ctx());
    const out = pi.entries
      .filter((e) => e.customType === "picc-control")
      .map((e) => String(e.data?.output ?? ""))
      .join("\n");
    expect(out).toContain("subagent(s) available");
    expect(out).toContain("reviewer");
    expect(out).toMatch(/reviewer[^\n]*read-only/);
    expect(out).toContain("tools:");
  });

  it("user-invocable skills are NOT registered as extension commands (they expand via input)", () => {
    // Pi intercepts extension commands before the input event and can't drive
    // their turn in print mode — so skills expand through the input handler instead.
    expect(pi.commands.has("deploy")).toBe(false);
    expect(pi.commands.has("fork-research")).toBe(false);
  });
});

describe("system prompt assembly + progressive disclosure NFR", () => {
  it("assembles instructions, rules, skills listing, agent catalog — bodies absent (lazy)", async () => {
    const result = await pi.fire("before_agent_start", { systemPrompt: "BASE-PROMPT" });
    const prompt = result.systemPrompt as string;
    expect(prompt).toContain("BASE-PROMPT");
    // CLAUDE.md hierarchy + @import + local + comment stripping
    expect(prompt).toContain("FS-ROOT-CLAUDE-MD");
    expect(prompt).toContain("FS-IMPORT-HOP-1");
    expect(prompt).toContain("FS-IMPORT-HOP-2");
    expect(prompt).toContain("FS-CLAUDE-LOCAL-MD");
    expect(prompt).not.toContain("FS-STRIPPED-COMMENT");
    // import immunity
    expect(prompt).toContain("@not-an-import.md");
    // rules: unconditional + nested yes, path-scoped no
    expect(prompt).toContain("FS-RULE-UNCONDITIONAL");
    expect(prompt).toContain("FS-RULE-NESTED-GIT");
    expect(prompt).not.toContain("FS-RULE-RUST-PATHSCOPED");
    // nested CLAUDE.md not at start
    expect(prompt).not.toContain("FS-NESTED-SRC-CLAUDE-MD");
    // skill listing: names + descriptions present…
    expect(prompt).toContain("fork-research:");
    expect(prompt).toContain("deploy:");
    expect(prompt).toContain("plugin-skill:");
    // …but user-only skill hidden from the model listing
    expect(prompt).not.toMatch(/- secret-ritual:/);
    // THE lazy-load NFR: no skill body may be in context before activation
    for (const canary of [
      "FS-SKILL-FORK-BODY",
      "FS-SKILL-ARGS-BODY",
      "FS-SKILL-SHELL-BODY",
      "FS-SKILL-PATHS-BODY",
      "FS-SKILL-USERONLY-BODY",
      "FS-PLUGIN-SKILL-BODY",
    ]) {
      expect(prompt, `${canary} leaked into startup context`).not.toContain(canary);
    }
    // agent catalog (description-driven routing surface)
    expect(prompt).toContain("Available subagents");
    expect(prompt).toMatch(/- planner( \(read-only\))?: Plans multi-step work/);
    expect(prompt).toMatch(/- reviewer \(read-only\): Read-only reviewer/);
    expect(prompt).toMatch(/- isolated-worker: Performs implementation work/);
  });
});

describe("skill activation", () => {
  it("Skill tool loads the body with positional + named args substituted, then stays resident", async () => {
    const skillTool = pi.tools.get("Skill");
    const result = await skillTool.execute("t1", { name: "deploy", arguments: "staging 1.2.3" });
    const text = result.content[0].text as string;
    expect(text).toContain("FS-SKILL-ARGS-BODY");
    expect(text).toContain("Deploy to environment **staging** at version **1.2.3**");
    expect(text).toContain("environment=staging version=1.2.3");

    const after = await pi.fire("before_agent_start", { systemPrompt: "B" });
    expect(after.systemPrompt).toContain("FS-SKILL-ARGS-BODY"); // resident once active
  });

  it("shell injection runs at activation (bash inline + fenced) with ${CLAUDE_*} vars", async () => {
    const skillTool = pi.tools.get("Skill");
    const result = await skillTool.execute("t2", { name: "repo-info", arguments: "" });
    const text = result.content[0].text as string;
    expect(text).toContain("FS-SKILL-SHELL-BODY");
    expect(text).toContain("main"); // injected `git rev-parse --abbrev-ref HEAD`
    expect(text).toContain("fixture baseline"); // injected `git log --oneline -3`
    expect(text).not.toContain("!`git rev-parse"); // markers replaced
    expect(text).toContain(dir); // ${CLAUDE_PROJECT_DIR}
  });

  it("powershell shell injection works when declared", async () => {
    const skillTool = pi.tools.get("Skill");
    const result = await skillTool.execute("t3", { name: "ps-info", arguments: "" });
    expect(result.content[0].text).toContain("FS-PS-INJECTED");
  });

  it("refuses model invocation of user-only skills", async () => {
    const skillTool = pi.tools.get("Skill");
    await expect(skillTool.execute("t4", { name: "secret-ritual" })).rejects.toThrow(/user-only/);
  });

  it("plugin-contributed skill resolves ${CLAUDE_PLUGIN_ROOT}", async () => {
    const skillTool = pi.tools.get("Skill");
    const result = await skillTool.execute("t5", { name: "plugin-skill" });
    const text = result.content[0].text as string;
    expect(text).toContain("FS-PLUGIN-SKILL-BODY");
    expect(text).not.toContain("${CLAUDE_PLUGIN_ROOT}");
  });

  it("`/skill args` expands into the user turn via the input event (Claude slash semantics)", async () => {
    const expanded = await pi.fire("input", { text: "/deploy prod 9.9", source: "interactive" });
    expect(expanded.action).toBe("transform");
    expect(expanded.text).toContain("FS-SKILL-ARGS-BODY");
    expect(expanded.text).toContain("Deploy to environment **prod** at version **9.9**");
    // user-invocable:false skill does not expand
    const notExpanded = await pi.fire("input", { text: "/rust-helper", source: "interactive" });
    expect(
      notExpanded.action === "continue" ||
        !String(notExpanded.text ?? "").includes("FS-SKILL-PATHS-BODY"),
    ).toBe(true);
  });

  it("background dispatch + TaskOutput path is exercisable: bg agent loads, /bg-research expands", async () => {
    const fixtureSource = fs.readFileSync(path.join(dir, ".claude", "commands", "bg-research.md"), "utf8").replace(/\r\n/gu, "\n");
    const frontmatter = `---
description: Dispatch the async-researcher in the background and retrieve it with TaskOutput.
argument-hint: "<topic>"
---`;
    expect(fixtureSource.slice(0, fixtureSource.indexOf("\n\n"))).toBe(frontmatter);
    const loaded = loadSkills([], [{ dir: path.join(dir, ".claude", "commands"), scope: "project" }]);
    const command = loaded.skills.find((skill) => skill.name === "bg-research");
    expect(command).toMatchObject({
      description: "Dispatch the async-researcher in the background and retrieve it with TaskOutput.",
      argumentHint: "<topic>",
      legacyCommand: true,
    });
    // The async-researcher background agent (background: true) reaches the routing catalog…
    const prompt = (await pi.fire("before_agent_start", { systemPrompt: "B" })).systemPrompt as string;
    expect(prompt).toMatch(/- async-researcher( \(read-only\))?: Researches a question in the background/);
    // …and the /bg-research command expands into the user turn with full-surface
    // guidance. These assertions pin fixture text; focused lifecycle tests prove the
    // terminal-suppression and running-poll branches behaviorally.
    const expanded = await pi.fire("input", { text: "/bg-research WASM ABI", source: "interactive" });
    expect(expanded.action).toBe("transform");
    expect(expanded.text).toContain("FS-BG-TASKOUTPUT");
    expect(expanded.text).toContain("run_in_background");
    expect(expanded.text).toContain("TaskOutput");
    expect(expanded.text).toContain("Passive lifecycle rows emphasize the agent and state, while explicit task actions retain the target ID.");
    expect(expanded.text).toContain("shows running status and available metadata; bounded live activity belongs to the subagent panel drill-down.");
    expect(expanded.text).toContain("running poll keeps the task eligible");
    expect(expanded.text).toContain("one bounded next-turn settlement notice");
    expect(expanded.text).toContain("terminal return is already delivery and suppresses");
    expect(expanded.text).toContain("do not call TaskOutput again");
    expect(expanded.text).toContain("Research this topic without blocking: WASM ABI");
    expect(expanded.text).not.toContain("$ARGUMENTS");
  });
});

describe("SlashCommand tool", () => {
  it("activates the resolved skill with args, byte-identical to the Skill tool for the same input", async () => {
    const skillTool = pi.tools.get("Skill");
    const slash = pi.tools.get("SlashCommand");
    // Unique args so `expected` renders full (never seen before), then a bump so
    // the SlashCommand re-render of the SAME content is not collapsed by the
    // session-wide dedup fingerprint (which Skill and SlashCommand share).
    const expected = await skillTool.execute("eq1", { name: "deploy", arguments: "eqenv 5.5.5" });
    await skillTool.execute("eq2", { name: "deploy", arguments: "eqbump 5.5.5" });
    const viaSlash = await slash.execute("eq3", { command: "/deploy eqenv 5.5.5" });
    expect(viaSlash).toEqual(expected);
    const text = viaSlash.content[0].text as string;
    expect(text).toContain("FS-SKILL-ARGS-BODY");
    expect(text).toContain("Deploy to environment **eqenv** at version **5.5.5**");
  });

  it("resolves a plugin skill by bare name and by :-form (findByName parity)", async () => {
    // Asserts parse+resolution of both name forms. ${CLAUDE_PLUGIN_ROOT} substitution
    // is NOT re-checked here (plugin-skill is fixed-content/no-args, so a full render
    // always dedups by this point); it is proven on the shared runSkillActivation
    // render path by the Skill-tool plugin test earlier in this file.
    const slash = pi.tools.get("SlashCommand");
    const bare = await slash.execute("p1", { command: "/plugin-skill" });
    expect(bare.details.skill).toBe("bundled-fixture-plugin:plugin-skill");
    const colon = await slash.execute("p2", { command: "/bundled-fixture-plugin:plugin-skill" });
    expect(colon.details.skill).toBe("bundled-fixture-plugin:plugin-skill");
  });

  it("tolerates a missing leading slash (deploy staging → /deploy staging)", async () => {
    const slash = pi.tools.get("SlashCommand");
    // Bump the shared fingerprint first so this render is not deduped.
    await pi.tools.get("Skill").execute("noslash-bump", { name: "deploy", arguments: "bump 0.1" });
    const res = await slash.execute("ns1", { command: "deploy noslash 8.8.8" });
    const text = res.content[0].text as string;
    expect(text).toContain("FS-SKILL-ARGS-BODY");
    expect(text).toContain("Deploy to environment **noslash** at version **8.8.8**");
  });

  it("activates a model-only (user-invocable:false) skill — gated on disable-model-invocation ONLY", async () => {
    const slash = pi.tools.get("SlashCommand");
    // rust-helper is user-invocable:false but model-invocable — it must RUN.
    const res = await slash.execute("mo1", { command: "/rust-helper" });
    expect(res.details.skill).toBe("rust-helper");
    // Either the full body or (if a prior render exists) the dedup note for it —
    // both prove it activated rather than being refused.
    expect(res.details.deduplicated ? true : String(res.content[0].text).includes("FS-SKILL-PATHS-BODY")).toBe(true);
  });

  it("refuses a disable-model-invocation skill (throws, naming user-only)", async () => {
    const slash = pi.tools.get("SlashCommand");
    await expect(slash.execute("dmi1", { command: "/secret-ritual now" })).rejects.toThrow(/user-only/);
  });

  it("dedups a byte-identical re-invocation, and shares the fingerprint set with the Skill tool", async () => {
    const skillTool = pi.tools.get("Skill");
    const slash = pi.tools.get("SlashCommand");
    // First SlashCommand render records the fingerprint; the identical second dedups.
    await slash.execute("dd1", { command: "/deploy dedupenv 1.1.1" });
    const second = await slash.execute("dd2", { command: "/deploy dedupenv 1.1.1" });
    expect(second.details.deduplicated).toBe(true);
    // Cross-tool: Skill-tool render then identical SlashCommand collapses too.
    await skillTool.execute("dd3", { name: "deploy", arguments: "shared 2.2.2" });
    const cross = await slash.execute("dd4", { command: "/deploy shared 2.2.2" });
    expect(cross.details.deduplicated).toBe(true);
  });

  it("throws a naming error for an unknown command (not a crash, not a silent success)", async () => {
    const slash = pi.tools.get("SlashCommand");
    await expect(slash.execute("u1", { command: "/no-such-skill foo" })).rejects.toThrow(
      /Unknown slash command: \/no-such-skill/,
    );
  });

  it("throws the dedicated 'requires a command' message for empty / whitespace / bare-slash input", async () => {
    const slash = pi.tools.get("SlashCommand");
    for (const command of ["", "   ", "/"]) {
      await expect(slash.execute("e", { command })).rejects.toThrow(
        /SlashCommand requires a command like "\/name args"\./,
      );
    }
  });
});

describe("permission + hook enforcement (guard)", () => {
  it("hard-blocks deny rules: Read(secrets/**) and Bash(curl *)", async () => {
    const blocked = await pi.fire("tool_call", {
      toolName: "read",
      toolCallId: "c1",
      input: { path: "secrets/key.txt" },
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("deny");

    const blockedBash = await pi.fire("tool_call", {
      toolName: "bash",
      toolCallId: "c2",
      input: { command: "curl http://example.com" },
    });
    expect(blockedBash?.block).toBe(true);
  });

  it("does not let a chained command evade a deny prefix rule", async () => {
    const blocked = await pi.fire("tool_call", {
      toolName: "bash",
      toolCallId: "c3",
      input: { command: "git status && curl http://evil" },
    });
    expect(blocked?.block).toBe(true);
  });

  it("keeps matching permissions.ask diagnostics at point of use without executing the tool", async () => {
    const bashExecute = vi.spyOn(pi.tools.get("bash"), "execute");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const toolCallId of ["ask-1", "ask-2"]) {
        const outcome = await pi.fire("tool_call", {
          toolName: "bash",
          toolCallId,
          input: { command: "git push origin main" },
        });
        expect(outcome?.block ?? false).toBe(false);
      }
      const diagnostics = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('ask rule "Bash(git push *)" downgraded to allow'));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain("default-permissive posture");
      expect(bashExecute).not.toHaveBeenCalled();
    } finally {
      bashExecute.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("runs the warn-only PreToolUse write-guard: allows and injects additionalContext", async () => {
    pi.messages.length = 0;
    // NOTE: touch a file OUTSIDE src/ so this test does not consume the
    // once-per-session nested-CLAUDE.md injection asserted below.
    const result = await pi.fire("tool_call", {
      toolName: "write",
      toolCallId: "c4",
      input: { path: "docs/tmp-guard.txt", content: "x" },
    });
    expect(result?.block ?? false).toBe(false);
    const injected = pi.messages.map((m) => String(m.message.content)).join("\n");
    expect(injected).toContain("FS-WRITE-GUARD saw:");
    expect(injected).toContain("tmp-guard.txt");
  });

  it("injects nested CLAUDE.md + path-scoped rule on first touch only", async () => {
    pi.messages.length = 0;
    await pi.fire("tool_call", {
      toolName: "read",
      toolCallId: "c5",
      input: { path: path.join(dir, "src", "main.rs") },
    });
    const first = pi.messages.map((m) => String(m.message.content)).join("\n");
    expect(first).toContain("FS-NESTED-SRC-CLAUDE-MD");
    expect(first).toContain("FS-RULE-RUST-PATHSCOPED");

    pi.messages.length = 0;
    await pi.fire("tool_call", {
      toolName: "read",
      toolCallId: "c6",
      input: { path: path.join(dir, "src", "lib.rs") },
    });
    const second = pi.messages.map((m) => String(m.message.content)).join("\n");
    expect(second).not.toContain("FS-NESTED-SRC-CLAUDE-MD");
    expect(second).not.toContain("FS-RULE-RUST-PATHSCOPED");
  });

  it("injects nested CLAUDE.md + path-scoped rule on a MultiEdit's first src/ touch", async () => {
    // Do NOT reuse the shared `pi`: its once-per-session src/ injection is already
    // consumed by the first-touch read test above. A freshly-wired instance has
    // pristine injection-dedup state, so this proves MultiEdit specifically flows
    // through on-touch nested-CLAUDE.md / path-scoped-rule injection, end-to-end,
    // as its first `src/` touch — with no fixture edit.
    const freshPi = fakePi();
    picc(freshPi.api as never, { onInitializationSettled: freshPi.captureInitialization });
    await freshPi.waitForInitialization();
    await freshPi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);

    freshPi.messages.length = 0;
    await freshPi.fire("tool_call", {
      toolName: "MultiEdit",
      toolCallId: "me1",
      input: {
        file_path: path.join(dir, "src", "main.rs"),
        edits: [{ old_string: "fn main", new_string: "fn main" }],
      },
    });
    const injected = freshPi.messages.map((m) => String(m.message.content)).join("\n");
    expect(injected).toContain("FS-NESTED-SRC-CLAUDE-MD");
    expect(injected).toContain("FS-RULE-RUST-PATHSCOPED");
  });

  it("fires PostToolUse hooks gated by if: Bash(git *) only for git commands", async () => {
    const logFile = path.join(dir, ".claude", ".hook-log");
    fs.rmSync(logFile, { force: true });
    await pi.fire("tool_result", {
      toolName: "bash",
      toolCallId: "c7",
      input: { command: "git status" },
      content: [{ type: "text", text: "clean" }],
      isError: false,
    });
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.readFileSync(logFile, "utf8")).toContain("FS-POST-GIT-HOOK");

    fs.rmSync(logFile, { force: true });
    await pi.fire("tool_result", {
      toolName: "bash",
      toolCallId: "c8",
      input: { command: "ls" },
      content: [{ type: "text", text: "" }],
      isError: false,
    });
    expect(fs.existsSync(logFile)).toBe(false);
  });
});

describe("session lifecycle hooks", () => {
  it("UserPromptSubmit hook context transforms the prompt", async () => {
    const result = await pi.fire("input", { text: "hello", source: "interactive" });
    expect(result.action).toBe("transform");
    expect(result.text).toContain("hello");
    expect(result.text).toContain("FS-PROMPT-HOOK-CONTEXT");
  });

  it("expands a user-invocable skill slash command into the user turn (with args)", async () => {
    const result = await pi.fire("input", { text: "/deploy staging 4.5", source: "interactive" });
    expect(result.action).toBe("transform");
    // The skill body becomes the turn, with $0/$1 substituted and the body now loaded.
    expect(result.text).toContain("FS-SKILL-ARGS-BODY");
    expect(result.text).toContain("Deploy to environment **staging** at version **4.5**");
  });

  it("does not expand a Pi built-in slash command", async () => {
    const result = await pi.fire("input", { text: "/model gpt-5", source: "interactive" });
    expect(result.action === "continue" || !String(result.text ?? "").includes("FS-SKILL")).toBe(true);
  });

  // A pasted/dropped image Pi captured on the input (`event.images`) must survive
  // whenever the turn text is rewritten — both transform return sites of the input
  // handler carry it forward via one shared helper.
  it("preserves captured images through a hook-suffix-only transform", async () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0=" } };
    const result = await pi.fire("input", { text: "hello", images: [image], source: "interactive" });
    expect(result.action).toBe("transform");
    expect(result.text).toContain("FS-PROMPT-HOOK-CONTEXT"); // the transform fired
    expect(result.images).toEqual([image]); // captured block preserved, unchanged
  });

  it("preserves captured images through a skill-expansion transform", async () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA=" } };
    // Unique args so the session-wide dedup fingerprint renders the full body
    // (not the "invoked again" note) — the point here is the image, not dedup.
    const result = await pi.fire("input", {
      text: "/deploy t05env 7.7",
      images: [image],
      source: "interactive",
    });
    expect(result.action).toBe("transform");
    expect(result.text).toContain("FS-SKILL-ARGS-BODY"); // skill expanded
    expect(result.images).toEqual([image]);
  });

  it("does not attach captured images to an extension-synthesized input (early-return unchanged)", async () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB=" } };
    const result = await pi.fire("input", { text: "hello", images: [image], source: "extension" });
    // Synthesized text is passed through verbatim: the handler returns `continue`
    // (Pi keeps the original event), and never forwards the block itself.
    expect(result).toEqual({ action: "continue" });
  });

  it("keeps noisy non-vision startup quiet while delivering SessionStart context and preserving old ack state", async () => {
    pi.messages.length = 0;
    pi.entries.length = 0;
    pi.notifications.length = 0;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx({
        model: { provider: "openai", id: "gpt-text", input: ["text"] },
      }));
      const sent = pi.messages.map((m) => String(m.message.content)).join("\n");
      expect(sent).toContain("FS-SESSION-START-HOOK-CONTEXT");
      expect(pi.entries.some((e) => e.customType === "picc-compat")).toBe(false);
      const notificationText = pi.notifications.map((notification) => notification.text).join("\n");
      expect(notificationText).not.toContain("PiCC compatibility:");
      expect(notificationText).not.toContain("Run /doctor");
      expect(notificationText).not.toContain("is not vision-capable");
      // The ONE deliberate exception to quiet startup: the fixture's unapproved
      // .mcp.json server is ACTIONABLE state, so exactly one MCP pending toast
      // fires (asserted in detail in its own test below).
      expect(pi.notifications).toHaveLength(1);
      expect(pi.notifications[0]!.text).toContain("pending approval");

      const consoleText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join("\n");
      expect(consoleText).not.toContain("PiCC compatibility:");
      expect(consoleText).not.toContain("Run /doctor");
      expect(consoleText).not.toContain("is not vision-capable");
      expect(consoleText).not.toContain("images sent as text");
      expect(fs.readFileSync(path.join(dir, ".claude", ".picc", "compat-ack.json"), "utf8"))
        .toBe(compatAckSentinel);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("toasts the MCP pending-approval line once at startup — actionable state survives quiet startup", async () => {
    pi.notifications.length = 0;
    await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
    const pendingToasts = pi.notifications.filter((n) => n.text.includes("pending approval"));
    expect(pendingToasts).toHaveLength(1);
    const text = pendingToasts[0]!.text;
    // The bounded one-line notice carries a server sample, decision keys, and
    // the /doctor pointer; detailed safe settings guidance stays out of the toast.
    expect(text).not.toContain("\n");
    expect(text).toContain("example-server");
    expect(text).toContain("enabledMcpjsonServers");
    expect(text).not.toContain("settings.local.json");
    expect(text).toContain("/doctor for safe settings guidance");
    // A non-startup session_start (e.g. /new) must not re-toast it.
    pi.notifications.length = 0;
    await pi.fire("session_start", { reason: "new" }, pi.tuiCtx());
    expect(pi.notifications.filter((n) => n.text.includes("pending approval"))).toHaveLength(0);
  });

  it("/doctor renders the registry-generated breakdown with the MCP posture line", async () => {
    pi.entries.length = 0;
    await pi.commands.get("doctor").handler("", pi.ctx());
    const doctor = pi.entries
      .filter((e) => e.customType === "picc-control")
      .map((e) => String(e.data?.output ?? ""))
      .join("\n");
    expect(doctor).toContain("claude-code-2.1.x");
    // Always-present MCP posture line, fed by real discovery: the fixture's
    // unapproved server renders as pending, and the retired static
    // ".mcp.json present" wording must be gone.
    expect(doctor).toContain("example-server: pending approval");
    // De-duplicated within /doctor: its posture line carries no enable/decline
    // hint because the pending finding below carries that report's guidance.
    // The dedicated /mcp report independently carries bounded guidance.
    const postureLine = doctor.split("\n").find((l) => l.startsWith("MCP servers:")) ?? "";
    expect(postureLine).not.toContain("enabledMcpjsonServers");
    expect(doctor).toContain('"enabledMcpjsonServers": ["example-server"]');
    expect(doctor).toContain("disabledMcpjsonServers");
    expect(doctor).not.toContain("MCP servers will not start");
  });

  it("handles headless /doctor immediately with findings and active-model vision state", async () => {
    await pi.fire("session_start", { reason: "startup" }, pi.printCtx({
      model: { provider: "openai", id: "gpt-text", input: ["text"] },
    }));
    pi.entries.length = 0;
    pi.messages.length = 0;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const outcome = await pi.fire("input", { text: "/doctor", source: "print" }, pi.printCtx());
      expect(outcome).toEqual({ action: "handled" });
      const entry = pi.entries.find(
        (e) => e.customType === "picc-control" && e.data?.command === "doctor",
      );
      const output = String(entry?.data?.output ?? "");
      expect(output).toContain("SAFETY setting.permissions.ask");
      expect(output).toContain("Active model: openai/gpt-text — vision: no");
      const stdout = logSpy.mock.calls.flat().join("\n");
      expect(stdout).toContain("SAFETY setting.permissions.ask");
      expect(stdout).toContain("Active model: openai/gpt-text — vision: no");
      expect(pi.messages).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("compaction: PostCompact re-injects active skills mid-run via steer", async () => {
    const skillTool = pi.tools.get("Skill");
    await skillTool.execute("t6", { name: "deploy", arguments: "prod 2.0" });
    pi.messages.length = 0;
    const compactCtx = pi.ctx();
    await expect(pi.fire("session_before_compact", {
      reason: "threshold",
      customInstructions: undefined,
    }, compactCtx)).resolves.toBeUndefined();
    await pi.fire("session_compact", {
      reason: "threshold",
      compactionEntry: { summary: "threshold summary" },
    }, compactCtx);
    const entry = pi.messages.find((m) => m.message?.customType === "picc-preserved");
    expect(entry, "expected a picc-preserved message").toBeDefined();
    const preserved = String(entry?.message?.content ?? "");
    expect(preserved).toContain("preserved across compaction");
    expect(preserved).toContain("FS-SKILL-ARGS-BODY");
    // Auto-compaction happens MID-RUN; "nextTurn" would queue until the next user
    // prompt and never reach the continuing/retried run (the /doctor-class bug).
    expect(entry?.options?.deliverAs).toBe("steer");
  });
});

describe("worktrees end-to-end (cwd swap is load-bearing)", () => {
  it("EnterWorktree creates, seeds, fires WorktreeCreate, and the project preflight detects worktree mode", async () => {
    const enter = pi.tools.get("EnterWorktree");
    const result = await enter.execute("w1", { name: "it/test-flow" });
    const wt = result.details.worktreePath as string;
    expect(wt).toContain(path.join(".claude", "worktrees", "it-test-flow"));
    expect(fs.existsSync(wt)).toBe(true);

    // .worktreeinclude seeding of gitignored files
    expect(fs.existsSync(path.join(wt, ".env.local"))).toBe(true);
    expect(fs.existsSync(path.join(wt, "config", "app.secret"))).toBe(true);

    // WorktreeCreate hook ran inside the worktree
    expect(fs.existsSync(path.join(wt, ".worktree-seeded"))).toBe(true);

    // the project's own git-plumbing probe must report worktree mode from the new cwd
    // (resolveGitBashPath covers user-local Git installs the hardcoded path missed)
    const bashCandidates = [
      resolveGitBashPath(),
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "bash",
    ].filter(Boolean) as string[];
    let probe = "";
    for (const bash of bashCandidates) {
      try {
        probe = execFileSync(bash, ["tools/preflight.sh"], { cwd: wt, encoding: "utf8" });
        break;
      } catch {
        /* try next */
      }
    }
    expect(probe).toContain("mode=worktree");
    expect(probe).toContain("branch=worktree-it-test-flow");

    // ExitWorktree(remove) restores and cleans (or reaps later on Windows)
    const exit = pi.tools.get("ExitWorktree");
    const exitResult = await exit.execute("w2", { action: "remove" });
    expect(exitResult.content[0].text).toContain("restored");
  });

  it("registered Edit previews and settles against the effective cwd across entry and restoration", async () => {
    const sdk = await import("@earendil-works/pi-coding-agent") as any;
    sdk.initTheme();
    const edit = pi.tools.get("edit");
    const relativePath = `edit-preview-cwd-${Date.now()}.txt`;
    const errorRelativePath = `edit-preview-error-${Date.now()}.txt`;
    const basePath = path.join(dir, relativePath);
    const errorBasePath = path.join(dir, errorRelativePath);
    const plainRow = (row: any): string => (row.render(120) as string[]).join("\n")
      .replace(/\u001b\].*?(?:\u0007|\u001b\\)/gu, "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
    const makeRow = (id: string, args: unknown) => new sdk.ToolExecutionComponent(
      "edit", id, args, {}, edit, { requestRender() {} }, dir.replace(/\\/g, "/"),
    );

    fs.writeFileSync(basePath, "BASE TOKEN\n");
    fs.writeFileSync(errorBasePath, "BASE WITHOUT MATCH\n");
    let activeWorktree = false;
    try {
      const rotationArgs = {
        path: relativePath, edits: [{ oldText: "TOKEN", newText: "ROTATED" }],
      };
      const rotationRow = makeRow("edit-preview-rotation", rotationArgs);
      rotationRow.setArgsComplete();
      await waitUntil({
        description: "the base Edit preview to finish before cwd rotation",
        predicate: () => plainRow(rotationRow).includes("BASE ROTATED"),
        describeObserved: () => plainRow(rotationRow),
        timeoutMs: 15_000,
      });

      const errorArgs = {
        path: errorRelativePath, edits: [{ oldText: "ERROR TOKEN", newText: "RECOVERED" }],
      };
      const errorRow = makeRow("edit-preview-error-rotation", errorArgs);
      errorRow.setArgsComplete();
      await waitUntil({
        description: "the mismatched base Edit preview to fail before cwd rotation",
        predicate: () => plainRow(errorRow).includes("Could not find the exact text"),
        describeObserved: () => plainRow(errorRow),
        timeoutMs: 15_000,
      });
      const obsoleteErrorComponent = errorRow.callRendererComponent;

      const entered = await pi.tools.get("EnterWorktree").execute(
        "edit-preview-enter", { name: `it/edit-preview-${Date.now()}` },
      );
      activeWorktree = true;
      const worktreePath = entered.details.worktreePath as string;
      fs.writeFileSync(path.join(worktreePath, relativePath), "WORKTREE TOKEN\n");
      fs.writeFileSync(path.join(worktreePath, errorRelativePath), "WORKTREE ERROR TOKEN\n");

      errorRow.markExecutionStarted();
      expect(errorRow.callRendererComponent).not.toBe(obsoleteErrorComponent);
      expect(plainRow(errorRow)).not.toContain("Could not find the exact text");
      const recoveredResult = await edit.execute("edit-preview-error-rotation", errorArgs);
      errorRow.updateResult(recoveredResult, false);
      const recoveredSettled = plainRow(errorRow);
      expect(recoveredSettled).toContain("WORKTREE RECOVERED");
      expect(recoveredSettled).not.toContain("Edit preview failed");
      expect(recoveredResult.details.diff).toContain("WORKTREE RECOVERED");
      expect(fs.readFileSync(errorBasePath, "utf8")).toBe("BASE WITHOUT MATCH\n");

      rotationRow.markExecutionStarted();
      expect(plainRow(rotationRow)).not.toContain("BASE ROTATED");
      const rotatedResult = await edit.execute("edit-preview-rotation", rotationArgs);
      rotationRow.updateResult(rotatedResult, false);
      const rotatedSettled = plainRow(rotationRow);
      expect(rotatedSettled).toContain("WORKTREE ROTATED");
      expect(rotatedSettled).not.toContain("BASE ROTATED");
      expect(rotatedSettled).not.toContain("Edit preview failed");
      expect(rotatedResult.content[0].text).toContain("Successfully replaced 1 block");
      expect(rotatedResult.details.diff).toContain("WORKTREE ROTATED");
      expect(fs.readFileSync(basePath, "utf8")).toBe("BASE TOKEN\n");

      fs.writeFileSync(path.join(worktreePath, relativePath), "WORKTREE FRESH\n");
      const worktreeArgs = {
        path: relativePath, edits: [{ oldText: "FRESH", newText: "EDITED" }],
      };
      const worktreeRow = makeRow("edit-preview-worktree", worktreeArgs);
      worktreeRow.setArgsComplete();
      await waitUntil({
        description: "the worktree Edit preview to finish",
        predicate: () => {
          const preview = plainRow(worktreeRow);
          return preview.includes("WORKTREE EDITED") && !preview.includes("BASE TOKEN");
        },
        describeObserved: () => plainRow(worktreeRow),
        timeoutMs: 15_000,
      });
      worktreeRow.markExecutionStarted();
      const worktreeResult = await edit.execute("edit-preview-worktree", worktreeArgs);
      worktreeRow.updateResult(worktreeResult, false);
      expect(plainRow(worktreeRow)).not.toContain("Edit preview failed");

      await pi.tools.get("ExitWorktree").execute("edit-preview-exit", { action: "remove" });
      activeWorktree = false;
      const baseArgs = {
        path: relativePath, edits: [{ oldText: "TOKEN", newText: "RESTORED" }],
      };
      const baseRow = makeRow("edit-preview-base", baseArgs);
      baseRow.setArgsComplete();
      await waitUntil({
        description: "the restored-base Edit preview to finish",
        predicate: () => plainRow(baseRow).includes("BASE RESTORED"),
        describeObserved: () => plainRow(baseRow),
        timeoutMs: 15_000,
      });
      baseRow.markExecutionStarted();
      const baseResult = await edit.execute("edit-preview-base", baseArgs);
      baseRow.updateResult(baseResult, false);
      expect(plainRow(baseRow)).not.toContain("Edit preview failed");
      expect(fs.readFileSync(basePath, "utf8")).toBe("BASE RESTORED\n");

      const mismatchArgs = {
        path: relativePath, edits: [{ oldText: "MISSING BLOCK", newText: "NEVER WRITTEN" }],
      };
      const mismatchRow = makeRow("edit-preview-mismatch", mismatchArgs);
      mismatchRow.setArgsComplete();
      mismatchRow.markExecutionStarted();
      let mismatchMessage = "";
      try {
        await edit.execute("edit-preview-mismatch", mismatchArgs);
      } catch (error) {
        mismatchMessage = error instanceof Error ? error.message : String(error);
      }
      expect(mismatchMessage).toMatch(/not found|match/iu);
      mismatchRow.updateResult({
        isError: true,
        content: [{ type: "text", text: mismatchMessage }],
        details: undefined,
      }, false);
      const mismatchRendered = plainRow(mismatchRow);
      expect(mismatchRendered).toContain("Could not find the exact text");
      expect(mismatchRendered).toContain("Edit preview failed");
      expect(fs.readFileSync(basePath, "utf8")).toBe("BASE RESTORED\n");
    } finally {
      if (activeWorktree) {
        await pi.tools.get("ExitWorktree").execute("edit-preview-cleanup", { action: "remove" });
      }
      fs.rmSync(basePath, { force: true });
      fs.rmSync(errorBasePath, { force: true });
    }
  });

  it("renders custom and rebuilt-stock paths workspace-first then repository-relative without changing canonical bytes", async () => {
    const previousBindings = getKeybindings();
    setKeybindings(new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
    }));
    const entered = await pi.tools.get("EnterWorktree").execute("t02-display-wt", { name: `it/display-${Date.now()}` });
    const wt = entered.details.worktreePath as string;
    try {
      const absoluteFile = path.join(wt, "display-proof.txt");
      const repositoryFile = path.join(dir, "repository-display-proof.txt");
      fs.writeFileSync(absoluteFile, "alpha\nbeta", "utf8");
      fs.writeFileSync(repositoryFile, "repository proof", "utf8");
      const theme = { fg: (_slot: string, text: string) => text, bold: (text: string) => text };
      const cases = [
        { name: "read", args: { path: absoluteFile }, expected: "read display-proof.txt" },
        { name: "Grep", args: { pattern: "alpha", path: absoluteFile }, expected: "display-proof.txt" },
        { name: "read", args: { path: repositoryFile }, expected: "read repo:repository-display-proof.txt" },
        { name: "Grep", args: { pattern: "repository", path: repositoryFile }, expected: "repo:repository-display-proof.txt" },
      ] as const;
      for (const entry of cases) {
        const tool = pi.tools.get(entry.name);
        const argsBefore = structuredClone(entry.args);
        const state = {};
        const context = {
          args: entry.args,
          state,
          cwd: dir,
          argsComplete: true,
          executionStarted: false,
          isPartial: false,
          isError: false,
          expanded: false,
        };
        tool.renderCall(entry.args, theme, context);
        const result = await tool.execute(`t02-${entry.name}-display`, entry.args);
        const resultBefore = structuredClone(result);
        const row = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context).render(120).join("\n");
        expect(row).toContain(entry.expected);
        expect(row).not.toContain(wt);
        expect(entry.args).toEqual(argsBefore);
        expect(result).toEqual(resultBefore);
      }
    } finally {
      await pi.tools.get("ExitWorktree").execute("t02-display-wt-exit", { action: "remove" });
      fs.rmSync(path.join(dir, "repository-display-proof.txt"), { force: true });
      setKeybindings(previousBindings);
    }
  });

  it("re-registered built-in execute re-resolves the live cwd after a worktree swap", async () => {
    // Proves the wrap did NOT drop the factory(cwdState.get()) re-resolution: call
    // a built-in's execute, swap cwdState via EnterWorktree, call again, and observe
    // the effective directory changed. A dropped re-resolution would keep listing
    // the old cwd.
    const ls = pi.tools.get("ls");
    const before = await ls.execute("t02-ls-a", { path: "." });
    const beforeText = before.content.map((c: { text?: string }) => c.text ?? "").join("\n");
    expect(beforeText).not.toContain(".worktree-seeded");

    const entered = await pi.tools.get("EnterWorktree").execute("t02-wt", { name: "it/exec-cwd-swap" });
    const wt = entered.details.worktreePath as string;
    try {
      expect(fs.existsSync(path.join(wt, ".worktree-seeded"))).toBe(true);
      const after = await ls.execute("t02-ls-b", { path: "." });
      const afterText = after.content.map((c: { text?: string }) => c.text ?? "").join("\n");
      // The worktree carries a seeded marker the fixture root does not — the
      // execute now resolves against the swapped cwd.
      expect(afterText).toContain(".worktree-seeded");
    } finally {
      await pi.tools.get("ExitWorktree").execute("t02-wt-exit", { action: "remove" });
    }
  });
});

describe("background settlement delivery (offline integration via the seam)", () => {
  // The fake-Pi harness cannot reach the closure-local registries, so a fresh
  // extension instance is wired with the test-only `onWired` seam (reachable
  // ONLY via this in-process argument — never env/settings/files). Coverage
  // includes both real registered Agent/TaskOutput traversal and focused seeded
  // lifecycle cases, all driven through the REAL before_agent_start drain handler.
  // Reuses the fixture cwd from the outer beforeAll.
  type Internals = Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];

  async function wire(options: {
    beforeSettlementSend?: PiccTestSeam["beforeSettlementSend"];
  } = {}): Promise<{ p: FakePi; internals: Internals }> {
    const p = fakePi();
    let internals!: Internals;
    picc(p.api as never, {
      onWired: (i) => (internals = i),
      onInitializationSettled: p.captureInitialization,
      ...(options.beforeSettlementSend ? { beforeSettlementSend: options.beforeSettlementSend } : {}),
    });
    await p.waitForInitialization();
    await p.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
    return { p, internals };
  }

  // A single fresh wire shared by the read-only `/usage` cases below (empty
  // report, then control-byte sanitize). Neither depends on pristine
  // dedup/injection state: the empty-report test runs first on the pristine
  // shared instance, and the sanitize test only registers and inspects its own
  // agent. Sharing avoids a second full wire() (fakePi + init + tool wait).
  let roShared: { p: FakePi; internals: Internals } | undefined;
  async function wireReadOnly(): Promise<{ p: FakePi; internals: Internals }> {
    return (roShared ??= await wire());
  }

  const reg = (internals: Internals, agentId: string) =>
    internals.subagentRegistry.register({
      agentId,
      agentName: "reviewer",
      depth: 1,
      cwd: process.cwd(),
      resumable: true,
      oneShot: false,
    });

  function settlements(
    p: FakePi,
  ): Array<{ content: string; deliverAs?: string; display?: unknown }> {
    return p.messages
      .filter((m) => m.message?.customType === "picc-settlement")
      .map((m) => ({
        content: String(m.message.content),
        deliverAs: m.options?.deliverAs,
        display: m.message.display,
      }));
  }

  it("registered Agent → TaskOutput wait → real next-turn drain emits no stale notice", async () => {
    const handle = fakeSdk({ replies: ["REAL-WIRED-RESULT"] });
    const { p, internals } = await wire();
    internals.subagentRuntime.setSdkForTest(handle.sdk);
    const agent = p.tools.get("Agent");
    const started = await agent.execute("dispatch", {
      subagent_type: "reviewer",
      prompt: "review offline",
      run_in_background: true,
    });
    const taskId = String(started.details.taskId);
    expect(taskId).toMatch(/^task-\d+$/);

    const taskOutput = p.tools.get("TaskOutput");
    const returned = await taskOutput.execute("collect", { task_id: taskId });
    expect(returned.content[0].text).toContain("REAL-WIRED-RESULT");
    p.messages.length = 0;
    await p.fire("before_agent_start", { systemPrompt: "B" });
    expect(settlements(p)).toHaveLength(0);
    await p.fire("before_agent_start", { systemPrompt: "B" });
    expect(settlements(p)).toHaveLength(0);
  });

  it("resolves recorded agent color through registered Agent, TaskOutput, and settlement surfaces", async () => {
    const handle = fakeSdk({ replies: ["COLOR-WIRED-RESULT"] });
    const { p, internals } = await wire();
    internals.subagentRuntime.setSdkForTest(handle.sdk);
    const agent = p.tools.get("Agent");
    const args = { subagent_type: "reviewer", prompt: "check color wiring", run_in_background: true };
    const started = await agent.execute("color-agent", args);
    const taskId = String(started.details.taskId);
    const agentId = String(started.details.agentId);
    await internals.backgroundTasks.wait(taskId);
    expect(internals.subagentRegistry.get(agentId)?.color).toBe("red");

    const taskOutput = p.tools.get("TaskOutput");
    const outputArgs = { task_id: taskId };
    const output = await taskOutput.execute("color-output", outputArgs);
    const agentText = agent.renderResult(
      started, { expanded: false, isPartial: false }, undefined, { state: {}, args },
    ).render(100).join("\n");
    const outputText = taskOutput.renderResult(
      output, { expanded: false, isPartial: false }, undefined, { state: {}, args: outputArgs },
    ).render(100).join("\n");
    const settlement = p.messageRenderers.get("picc-settlement")!(
      {
        details: {
          record: "subagent-completion",
          outcome: "completed",
          agent: "reviewer",
          agentId,
          finalText: "COLOR-WIRED-RESULT",
        },
      },
      { expanded: false },
      undefined,
    ).render(100).join("\n");

    for (const text of [agentText, outputText, settlement]) {
      expect(text.match(/\u001b\[31mreviewer\u001b\[39m/gu)).toHaveLength(1);
      expect(text.replace(/\u001b\[[0-9;]*m/gu, "")).toContain("reviewer");
      expect(text).not.toMatch(/\u001b\[31m\s*\[(?:background|completed)\]/u);
    }
    expect(agentText.replace(/\u001b\[[0-9;]*m/gu, "")).toContain("reviewer [background]");
    for (const text of [outputText, settlement]) {
      expect(text.replace(/\u001b\[[0-9;]*m/gu, "")).toContain("reviewer [completed]");
    }
  });

  it("keeps execution-produced lifecycle and canonical SendMessage values unchanged after renderer calls", async () => {
    const canonicalText = `MACHINE-CANONICAL-RESULT ${dir}`;
    const handle = fakeSdk({ replies: [canonicalText, canonicalText] });
    const { p, internals } = await wire();
    internals.subagentRuntime.setSdkForTest(handle.sdk);
    const agent = p.tools.get("Agent");
    const taskOutput = p.tools.get("TaskOutput");
    const taskStop = p.tools.get("TaskStop");
    const sendMessage = p.tools.get("SendMessage");
    const theme = { fg: (_slot: string, text: string) => `\u001b[36m${text}\u001b[39m`, bold: (text: string) => text };

    for (const mode of ["offline"] as const) {
      const machineContext = p.printCtx();
      const agentArgs = { subagent_type: "reviewer", prompt: "machine boundary", run_in_background: true };
      const agentBefore = structuredClone(agentArgs);
      const started = await agent.execute(`${mode}-agent`, agentArgs, undefined, undefined, machineContext);
      expect(agentArgs).toEqual(agentBefore);
      const taskId = String(started.details.taskId);
      const outputArgs = { task_id: taskId };
      const output = await taskOutput.execute(`${mode}-output`, outputArgs, undefined, undefined, machineContext);
      const stopArgs = { task_id: taskId };
      const stop = await taskStop.execute(`${mode}-stop`, stopArgs, undefined, undefined, machineContext);
      const agentId = String(started.details.agentId);
      const record = internals.backgroundTasks.get(taskId)!;
      const expectedCanonical = {
        started: {
          content: [{
            type: "text",
            text: `Background task ${taskId} accepted (agent: reviewer, agent id: ${agentId}); it will run when configured concurrency capacity is available. Use TaskOutput with task_id "${taskId}" to retrieve the result before finalizing.`,
          }],
          details: {
            background: true,
            taskId,
            agent: "reviewer",
            agentId,
            description: undefined,
            admission: "admitted",
          },
        },
        output: {
          content: [{ type: "text", text: canonicalText }],
          details: {
            taskId,
            status: "completed",
            admission: "admitted",
            outcome: "completed",
            agent: "reviewer",
            agentId,
            cutOff: false,
            transcriptPath: undefined,
            resumable: false,
            usage: record.usage,
            lastActivity: record.lastActivity,
            diagnostics: [{
              severity: "info",
              message: "main session has no transcript file (print/no-session mode?); subagent transcript not persisted — this agent will not be resumable",
            }],
            description: undefined,
            durationMs: record.settledAt! - record.startedAt!,
            settledAt: record.settledAt,
          },
        },
        stop: {
          content: [{
            type: "text",
            text: `Task(${taskId}) · Agent(reviewer) · ${agentId} — already finished with status "completed"; nothing to stop.`,
          }],
          details: { taskId, status: "completed" },
        },
      };
      expect({ started, output, stop }).toEqual(expectedCanonical);
      expect(path.isAbsolute(dir)).toBe(true);
      expect(expectedCanonical.output.content[0]!.text).toContain(dir);
      agent.renderResult(started, { expanded: false, isPartial: false }, theme, { state: {}, args: agentArgs }).render(80);
      taskOutput.renderResult(output, { expanded: false, isPartial: false }, theme, { state: {}, args: outputArgs }).render(80);
      taskStop.renderResult(stop, {}, theme, { state: {}, args: stopArgs }).render(80);
      const sendArgs = { to: "reviewer", message: "MACHINE-MESSAGE-BYTES" };
      const exceptionalSend = {
        content: [{ type: "text", text: "MACHINE-EXCEPTION-EVIDENCE" }],
        details: { delivery: "checkpoint-recovery", outcome: "failed", recovered: false, truncated: false },
      };
      const sendBefore = structuredClone({ sendArgs, exceptionalSend });
      const sendContext = { state: {}, args: sendArgs, isError: false };
      sendMessage.renderCall(sendArgs, theme, sendContext).render(80);
      sendMessage.renderResult(exceptionalSend, { expanded: false, isPartial: false }, theme, sendContext).render(80);
      expect({ sendArgs, exceptionalSend }).toEqual(sendBefore);
      expect({ started, output, stop }).toEqual(expectedCanonical);
      const machineBytes = JSON.stringify({ ...expectedCanonical, sendArgs, exceptionalSend });
      expect(machineBytes).toContain(taskId);
      expect(machineBytes).toContain("MACHINE-CANONICAL-RESULT");
      expect(machineBytes).toContain("MACHINE-MESSAGE-BYTES");
      expect(machineBytes).toContain("MACHINE-EXCEPTION-EVIDENCE");
      expect(machineBytes).not.toContain("\u001b");
      expect(machineBytes).not.toContain(RECORD_EXPAND_HINT);
    }

    const release = deferred<void>();
    const steerHandle = fakeSdk({ replies: [{ text: "steered final", gate: release.promise }] });
    const { p: steerPi, internals: steerInternals } = await wire();
    steerInternals.subagentRuntime.setSdkForTest(steerHandle.sdk);
    const steerAgent = steerPi.tools.get("Agent");
    const registeredSendMessage = steerPi.tools.get("SendMessage");
    const started = await steerAgent.execute("real-steer-agent", {
      subagent_type: "reviewer",
      prompt: "hold for ordinary SendMessage",
      run_in_background: true,
    });
    try {
      await steerHandle.waitForPromptCalls(1);
      const args = { to: String(started.details.agentId), message: "REAL-ORDINARY-MESSAGE-BYTES" };
      const produced = await registeredSendMessage.execute("real-ordinary-send", args);
      const canonical = structuredClone({ args, produced });
      const context = { state: {}, args, isError: false };
      registeredSendMessage.renderCall(args, theme, context).render(80);
      const rendered = registeredSendMessage.renderResult(
        produced,
        { expanded: false, isPartial: false },
        theme,
        context,
      ).render(80);
      expect(rendered).toHaveLength(1);
      expect({ args, produced }).toEqual(canonical);
      expect(produced.details).toEqual(expect.objectContaining({
        agentId: started.details.agentId,
        agent: "reviewer",
        delivery: "steer",
      }));
      expect(produced.content[0].text).toContain("mid-task course correction");
      expect(JSON.stringify({ args, produced })).toContain("REAL-ORDINARY-MESSAGE-BYTES");
    } finally {
      release.resolve();
      await steerPi.tools.get("TaskOutput").execute("collect-real-steer", {
        task_id: String(started.details.taskId),
      });
    }
  });

  it("production pre-send validity skips a notice collected after selection", async () => {
    let internals!: Internals;
    let taskId = "";
    let barrierCalls = 0;
    const p = fakePi();
    picc(p.api as never, {
      onWired: (i) => (internals = i),
      onInitializationSettled: p.captureInitialization,
      beforeSettlementSend: () => {
        barrierCalls++;
        expect(internals.backgroundTasks.markCollected(taskId)).toBe(true);
      },
    });
    await p.waitForInitialization();
    await p.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
    const agentId = "agent-0a1b2c3d4e5f";
    reg(internals, agentId);
    taskId = internals.backgroundTasks.start(
      "agent:reviewer",
      Promise.resolve({
        ok: true,
        outcome: "completed" as const,
        finalMessage: "selected then collected",
        agentId,
        diagnostics: [],
      }),
      undefined,
      agentId,
      "reviewer",
    );
    await internals.backgroundTasks.wait(taskId);
    internals.subagentRegistry.markSettled(agentId);

    p.messages.length = 0;
    await p.fire("before_agent_start", { systemPrompt: "B" });
    expect(barrierCalls).toBe(1);
    expect(settlements(p)).toHaveLength(0);
    await p.fire("before_agent_start", { systemPrompt: "B" });
    expect(barrierCalls).toBe(1);
    expect(settlements(p)).toHaveLength(0);
  });

  it("announces a settled background task at the next turn (outcome, agent id, framed output) — no TaskOutput needed", async () => {
    const { p, internals } = await wire();
    const agentId = "agent-0011aa22bb33";
    reg(internals, agentId);
    const taskId = internals.backgroundTasks.start(
      "agent:reviewer",
      Promise.resolve({
        ok: true,
        outcome: "completed" as const,
        finalMessage: "LGTM - no blocking issues",
        agentId,
        diagnostics: [],
      }),
      undefined,
      agentId,
      "reviewer",
    );
    await internals.backgroundTasks.wait(taskId);
    internals.subagentRegistry.markSettled(agentId);

    // The next parent turn begins — the drain delivers the notice.
    p.messages.length = 0;
    await p.fire("before_agent_start", { systemPrompt: "B" });
    const notices = settlements(p);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.deliverAs).toBe("steer"); // message-level channel, transcript-visible
    expect(notices[0]!.display).toBe(true); // transcript-visible acceptance (rendered to the user)
    const identity = `Task(${taskId}) · Agent(reviewer) · ${agentId}`;
    expect(notices[0]!.content.split(identity)).toHaveLength(2);
    expect(notices[0]!.content).not.toContain("agent:reviewer");
    expect(notices[0]!.content).toContain("settled: completed");
    expect(notices[0]!.content).toContain("LGTM - no blocking issues");
    expect(notices[0]!.content).toContain("UNTRUSTED SUBAGENT OUTPUT"); // untrusted framing
    expect(notices[0]!.content).toContain("not an instruction");

    // Exactly-once across turns: the following turn delivers nothing new.
    p.messages.length = 0;
    await p.fire("before_agent_start", { systemPrompt: "B" });
    expect(settlements(p)).toHaveLength(0);
  });

  it("a pi.sendMessage throw on one notice still delivers the others and re-fires the throwing one next turn", async () => {
    // The real delivery path (deliverSettlementNotices): each notice is delivered
    // in its own try/catch and the dedup gate is committed ONLY after a successful
    // send. A throw on one notice must neither drop the others nor consume the
    // thrower — it re-fires next turn. Nothing is silently lost.
    const { p, internals } = await wire();
    const agentA = "agent-1a2b3c4d5e6f";
    const agentB = "agent-6f5e4d3c2b1a";
    for (const [aid, text] of [
      [agentA, "A-report"],
      [agentB, "B-report"],
    ] as const) {
      reg(internals, aid);
      const t = internals.backgroundTasks.start(
        "agent:reviewer",
        Promise.resolve({
          ok: true,
          outcome: "completed" as const,
          finalMessage: text,
          agentId: aid,
          diagnostics: [],
        }),
        undefined,
        aid,
        "reviewer",
      );
      await internals.backgroundTasks.wait(t);
      internals.subagentRegistry.markSettled(aid);
    }

    // Make the FIRST send of the batch throw (before its commit).
    const realSend = p.api.sendMessage as (m: unknown, o?: unknown) => unknown;
    let calls = 0;
    (p.api as Record<string, unknown>).sendMessage = (m: unknown, o?: unknown) => {
      calls++;
      if (calls === 1) throw new Error("sendMessage boom");
      return realSend(m, o);
    };

    p.messages.length = 0;
    await p.fire("before_agent_start", { systemPrompt: "B" });
    const turn1 = settlements(p);
    expect(turn1).toHaveLength(1); // the non-throwing notice still landed

    // Restore normal delivery; the un-committed (throwing) notice re-fires.
    (p.api as Record<string, unknown>).sendMessage = realSend;
    p.messages.length = 0;
    await p.fire("before_agent_start", { systemPrompt: "B" });
    const turn2 = settlements(p);
    expect(turn2).toHaveLength(1); // the previously-thrown notice, not lost

    // Across both turns each agent was delivered exactly once — nothing dropped,
    // nothing duplicated.
    const joined = [...turn1, ...turn2].map((n) => n.content).join("\n===\n");
    expect(joined).toContain(agentA);
    expect(joined).toContain(agentB);
    expect(joined).toContain("A-report");
    expect(joined).toContain("B-report");

    // A third turn delivers nothing more.
    p.messages.length = 0;
    await p.fire("before_agent_start", { systemPrompt: "B" });
    expect(settlements(p)).toHaveLength(0);
  });

  it("/usage aggregates per-subagent usage, transcript paths, outcome, and a session total", async () => {
    const { p, internals } = await wire();
    // Two settled dispatches with usage, exactly as the runtime would record:
    // register (running) then markSettled with outcome + usage.
    internals.subagentRegistry.register({
      agentId: "agent-1111aaaa2222",
      agentName: "reviewer",
      depth: 1,
      cwd: process.cwd(),
      transcriptPath: "/sessions/main.subagents/x_agent-1111aaaa2222.jsonl",
      resumable: true,
      oneShot: false,
    });
    internals.subagentRegistry.markSettled("agent-1111aaaa2222", {
      outcome: "completed",
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 },
    });
    internals.subagentRegistry.register({
      agentId: "agent-3333bbbb4444",
      agentName: "planner",
      depth: 1,
      cwd: process.cwd(),
      transcriptPath: "/sessions/main.subagents/y_agent-3333bbbb4444.jsonl",
      resumable: true,
      oneShot: false,
    });
    internals.subagentRegistry.markSettled("agent-3333bbbb4444", {
      outcome: "failed",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    });

    p.entries.length = 0;
    await p.commands.get("usage").handler("", p.ctx());
    const out = p.entries
      .filter((e) => e.customType === "picc-control")
      .map((e) => String(e.data?.output ?? ""))
      .join("\n");
    // Per-subagent lines: id, type, outcome, usage, transcript path.
    expect(out).toContain("agent-1111aaaa2222 (reviewer) — completed");
    expect(out).toContain("agent-3333bbbb4444 (planner) — failed");
    expect(out).toContain("in 100 · out 50 · $0.02");
    expect(out).toContain("x_agent-1111aaaa2222.jsonl");
    expect(out).toContain("y_agent-3333bbbb4444.jsonl");
    // Subagents total sums each present field across records. The label and
    // header must make clear this is SUBAGENT usage, not whole-session/main-agent.
    expect(out).toContain("Subagents total: in 110 · out 55 · $0.03");
    expect(out).not.toContain("Session total:");
    expect(out).toContain("does NOT include the main agent's own usage");
    expect(out).toContain("the main-agent / whole-session total is not shown");
  });

  it("/usage is registered and reports nothing before any dispatch", async () => {
    const { p } = await wireReadOnly();
    expect(p.commands.has("usage")).toBe(true);
    p.entries.length = 0;
    await p.commands.get("usage").handler("", p.ctx());
    const out = p.entries
      .filter((e) => e.customType === "picc-control")
      .map((e) => String(e.data?.output ?? ""))
      .join("\n");
    expect(out).toContain("No subagents have been dispatched this session");
  });

  it("sanitizes a control-byte agent name in the /usage report", async () => {
    // agentName derives from agent frontmatter `name`/basename (only trimmed
    // upstream); a hostile ANSI/OSC/control-byte name must not reach the terminal
    // on /usage. Control bytes from code points so this source stays pure ASCII.
    const { p, internals } = await wireReadOnly();
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const NUL = String.fromCharCode(0);
    internals.subagentRegistry.register({
      agentId: "agent-abcabcabcabc",
      agentName: `rev${ESC}[31miewer${BEL}${ESC}]0;pwn${BEL}${NUL}`,
      depth: 1,
      cwd: process.cwd(),
      resumable: true,
      oneShot: false,
    });
    internals.subagentRegistry.markSettled("agent-abcabcabcabc", {
      outcome: "completed",
      usage: { inputTokens: 1 },
    });
    p.entries.length = 0;
    await p.commands.get("usage").handler("", p.ctx());
    const out = p.entries
      .filter((e) => e.customType === "picc-control")
      .map((e) => String(e.data?.output ?? ""))
      .join("\n");
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    expect(out).not.toContain(NUL);
    expect(out).toContain("reviewer"); // visible name text preserved
    expect(out).toContain("agent-abcabcabcabc");
  });

  it("delivers completed / failed / stopped shapes together (rate-limit → failed; TaskStop → aborted)", async () => {
    const { p, internals } = await wire();

    const okId = "agent-cc33dd44ee55";
    reg(internals, okId);
    const okTask = internals.backgroundTasks.start(
      "agent:reviewer",
      Promise.resolve({ ok: true, outcome: "completed" as const, finalMessage: "done", agentId: okId, diagnostics: [] }),
      undefined,
      okId,
      "reviewer",
    );
    await internals.backgroundTasks.wait(okTask);
    internals.subagentRegistry.markSettled(okId);

    const failId = "agent-ff00ee11dd22";
    reg(internals, failId);
    const failTask = internals.backgroundTasks.start(
      "agent:reviewer",
      Promise.resolve({
        ok: false,
        outcome: "failed" as const,
        finalMessage: "",
        agentId: failId,
        error: "Agent terminated early due to an API error: insufficient_quota",
        diagnostics: [],
      }),
      undefined,
      failId,
      "reviewer",
    );
    await internals.backgroundTasks.wait(failTask);
    internals.subagentRegistry.markSettled(failId);

    const stopId = "agent-aa11bb22cc33";
    reg(internals, stopId);
    let resolveStop!: (v: BackgroundResultLike) => void;
    const stopTask = internals.backgroundTasks.start(
      "agent:reviewer",
      new Promise((r) => (resolveStop = r)),
      () => {},
      stopId,
      "reviewer",
    );
    internals.backgroundTasks.stop(stopTask); // status → stopped; notice reads "aborted"
    resolveStop({ ok: false, outcome: "aborted", finalMessage: "discard", agentId: stopId, error: "aborted", diagnostics: [] });
    await internals.backgroundTasks.wait(stopTask);
    internals.subagentRegistry.markSettled(stopId);

    p.messages.length = 0;
    await p.fire("before_agent_start", { systemPrompt: "B" });
    const joined = settlements(p).map((n) => n.content).join("\n===\n");
    expect(settlements(p)).toHaveLength(3);
    expect(joined).toContain("settled: completed");
    expect(joined).toContain("settled: failed");
    expect(joined).toContain("insufficient_quota"); // regression: never a silent success
    expect(joined).toContain("settled: aborted"); // outcome vocabulary (status is "stopped")
  });

  it("WIRING: the settlement message carries the record details and the REGISTERED picc-settlement renderer draws the one-line record; nested falls back to Pi's default box", async () => {
    // End-to-end through the real registration + drain, against the recorded
    // renderer — a typo'd customType, a dropped `details` attach, or a renderer
    // that stops delegating would each fail HERE instead of degrading silently
    // to Pi's default purple notice box in the terminal.
    const { p, internals } = await wire();
    const renderer = p.messageRenderers.get("picc-settlement");
    expect(typeof renderer, "no message renderer registered for picc-settlement").toBe(
      "function",
    );
    const throwingDetails = Object.defineProperty({}, "details", {
      get(): never {
        throw new Error("details getter");
      },
    });
    const revokedMessage = Proxy.revocable({}, {});
    revokedMessage.revoke();
    expect(() => renderer!(throwingDetails, { expanded: false }, undefined)).not.toThrow();
    expect(() => renderer!(revokedMessage.proxy, { expanded: false }, undefined)).not.toThrow();
    expect(renderer!(throwingDetails, { expanded: false }, undefined)).toBeUndefined();

    // A coordinator-owned settlement, never awaited.
    const agentId = "agent-77aa88bb99cc";
    reg(internals, agentId);
    const taskId = internals.backgroundTasks.start(
      "agent:reviewer",
      Promise.resolve({
        ok: true,
        outcome: "completed" as const,
        finalMessage: "WIRED-RECORD-REPORT",
        agentId,
        transcriptPath: `/x/sessions/${agentId}.jsonl`,
        resumable: true,
        diagnostics: [],
      }),
      undefined,
      agentId,
      "reviewer",
    );
    await internals.backgroundTasks.wait(taskId);
    internals.subagentRegistry.markSettled(agentId);

    // A NESTED (owner-tagged) settlement: dispatched by a subagent.
    const nestedAgentId = "agent-ddeeff001122";
    reg(internals, nestedAgentId);
    const nestedTaskId = internals.backgroundTasks.start(
      "agent:reviewer",
      Promise.resolve({
        ok: true,
        outcome: "completed" as const,
        finalMessage: "NESTED-REPORT",
        agentId: nestedAgentId,
        diagnostics: [],
      }),
      undefined,
      nestedAgentId,
      "reviewer",
      "agent-aabb00112233", // owner tag → nested
    );
    await internals.backgroundTasks.wait(nestedTaskId);
    internals.subagentRegistry.markSettled(nestedAgentId);

    // The real before_agent_start drain delivers both notices.
    p.messages.length = 0;
    await p.fire("before_agent_start", { systemPrompt: "B" });
    const sent = p.messages
      .filter((m) => m.message?.customType === "picc-settlement")
      .map((m) => m.message as { content: string; details?: Record<string, unknown> });
    expect(sent).toHaveLength(2);
    const top = sent.find((m) => m.details?.taskId === taskId);
    const nested = sent.find((m) => m.details?.taskId === nestedTaskId);
    expect(top, "settlement message lost its details payload").toBeDefined();
    expect(nested).toBeDefined();
    expect(top!.details!.record).toBe("subagent-completion");
    expect(typeof top!.details!.settledAt).toBe("number");
    expect(typeof top!.details!.durationMs).toBe("number");
    expect(top!.content).toContain("settled: completed"); // model-facing text untouched

    // The RECORDED registered renderer, driven with the actual sent message at
    // Pi's collapsed default ({ expanded: false }) → the one-line record.
    const component = renderer!(top, { expanded: false }, undefined);
    expect(component, "registered renderer fell back to the default box").toBeTruthy();
    const lines = component.render(200) as string[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reviewer");
    expect(lines[0]).toContain("[completed]");
    expect(lines[0]).not.toContain(taskId);
    expect(lines[0]).not.toContain(".jsonl");
    expect(lines[0]).toContain(RECORD_EXPAND_HINT);
    expect(lines[0]).not.toContain("WIRED-RECORD-REPORT"); // body stays behind expand

    // Nested settlement: the renderer returns undefined → Pi's default box,
    // no main-chat completion record for depth ≥ 2 tasks.
    expect(nested!.details!.nested).toBe(true);
    expect(renderer!(nested, { expanded: false }, undefined)).toBeUndefined();
  });

  it("registers Agent and Task with accepted/capacity wording and the foreground-forcing exception", () => {
    for (const name of ["Agent", "Task"] as const) {
      const tool = pi.tools.get(name) as unknown as {
        description: string;
        parameters: { properties?: Record<string, { description?: string }> };
      };
      const parameter = tool.parameters.properties?.run_in_background?.description ?? "";
      for (const text of [tool.description, parameter]) {
        expect(text).toMatch(/accept(?:ed)? (?:the dispatch )?immediately/iu);
        expect(text).toContain("configured concurrency capacity");
        expect(text).toContain("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS");
        expect(text).not.toMatch(/\b(?:started|starts immediately|has started)\b/iu);
      }
    }
  });

  it("registered Agent threads a background description through the real TaskOutput wiring", async () => {
    const handle = fakeSdk({ replies: ["BACKGROUND-DONE"] });
    const { p, internals } = await wire();
    internals.subagentRuntime.setSdkForTest(handle.sdk);
    const agent = p.tools.get("Agent");
    const started = await agent.execute("bg-description", {
      subagent_type: "reviewer",
      prompt: "review in background",
      description: "Review authentication",
      run_in_background: true,
    });
    expect(started.content).toEqual([
      {
        type: "text",
        text: `Background task ${started.details.taskId} accepted (agent: reviewer, agent id: ${started.details.agentId}); it will run when configured concurrency capacity is available. Use TaskOutput with task_id "${started.details.taskId}" to retrieve the result before finalizing.`,
      },
    ]);
    expect(started.details.description).toBe("Review authentication");
    await internals.backgroundTasks.wait(String(started.details.taskId));
    const output = await p.tools.get("TaskOutput").execute("collect-description", {
      task_id: started.details.taskId,
    });
    expect(output.content[0]!.text).toContain("BACKGROUND-DONE");
    expect(output.details.description).toBe("Review authentication");
  });

  it("a FOREGROUND completed dispatch carries durationMs; its collapsed record shows a duration segment", async () => {
    const handle = fakeSdk({ replies: ["FOREGROUND-DONE"] });
    const { p, internals } = await wire();
    internals.subagentRuntime.setSdkForTest(handle.sdk);
    const agent = p.tools.get("Agent");
    const res = await agent.execute("fg", {
      subagent_type: "reviewer",
      prompt: "review inline",
      run_in_background: false,
    });
    expect(res.details.outcome).toBe("completed");
    expect(typeof res.details.settledAt).toBe("number");
    const durationMs = res.details.durationMs;
    expect(typeof durationMs).toBe("number");
    expect(durationMs as number).toBeGreaterThanOrEqual(0);
    const lines = agent
      .renderResult(res, { isPartial: false, expanded: false }, undefined)
      .render(200) as string[];
    expect(lines).toHaveLength(1);
    // The duration segment, exactly as the collapsed line formats it.
    expect(lines[0]).toContain(` · ${formatElapsed(durationMs as number)}`);
    expect(lines[0]).toContain(RECORD_EXPAND_HINT);
  });
});

describe("subagent background-task scoping (offline-integration via a real dispatch)", () => {
  // A REAL dispatch through the coordinator's registered Agent tool, driven
  // OFFLINE by a fake SDK injected via the onWired seam's subagentRuntime. The
  // dispatcher-owner id is minted by the RUNTIME (the `mintAgentId` in dispatch)
  // and threaded through `customToolsFor` into both the subagent's scoped
  // TaskOutput/TaskStop and the tasks it starts (createAgentToolDefinition →
  // start's owner) — the test never supplies it. We assert the subagent reaches
  // only its OWN task, is refused a coordinator's and a sibling's task (cleanly,
  // no leak), and that the coordinator reaches every task.
  type Internals = Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];

  const findTool = (tools: FakeCustomTool[] | undefined, name: string): FakeCustomTool => {
    const t = tools?.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} was not injected into the subagent's session`);
    return t;
  };

  it("scopes a subagent's TaskOutput/TaskStop to its own dispatched tasks; coordinator keeps full reach", async () => {
    // Gates so the nested background dispatches settle deterministically — no
    // setTimeout "let the dispatch create its session" smell.
    let releaseInner1!: () => void;
    let releaseInner2!: () => void;
    const innerGate1 = new Promise<void>((r) => (releaseInner1 = r));
    const innerGate2 = new Promise<void>((r) => (releaseInner2 = r));

    // Captured FROM THE RUNTIME during dispatch: the exact tools the runtime
    // handed each subagent, plus the ids of the tasks they started.
    let subagent1Tools: FakeCustomTool[] | undefined;
    let subagent2Tools: FakeCustomTool[] | undefined;
    let ownTaskId1: string | undefined;
    let siblingTaskId: string | undefined;

    const handle = fakeSdk({
      onPrompt: async (text, session: FakeSessionState) => {
        if (text.includes("OUTER1")) {
          // The subagent uses its OWN injected Agent tool to background a nested
          // dispatch — the only way a subagent starts a background task.
          subagent1Tools = session.customTools;
          const res = await findTool(session.customTools, "Agent").execute("n1", {
            subagent_type: "general-purpose",
            prompt: "INNER1",
            run_in_background: true,
          });
          ownTaskId1 = res.details?.taskId as string;
          return "outer1 done";
        }
        if (text.includes("OUTER2")) {
          subagent2Tools = session.customTools;
          const res = await findTool(session.customTools, "Agent").execute("n2", {
            subagent_type: "general-purpose",
            prompt: "INNER2",
            run_in_background: true,
          });
          siblingTaskId = res.details?.taskId as string;
          return "outer2 done";
        }
        if (text.includes("INNER1")) return { text: "inner1 result", gate: innerGate1 };
        if (text.includes("INNER2")) return { text: "inner2 result", gate: innerGate2 };
        return "coord done";
      },
    });

    const p = fakePi();
    let internals!: Internals;
    picc(p.api as never, {
      onWired: (i) => (internals = i),
      onInitializationSettled: p.captureInitialization,
    });
    await p.waitForInitialization();
    await p.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
    // Inject the fake SDK into the real runtime BEFORE any dispatch, so the
    // coordinator's registered Agent tool dispatches offline.
    internals.subagentRuntime.setSdkForTest(handle.sdk);

    const coordAgent = p.tools.get("Agent");
    // Two foreground subagent dispatches: each starts ITS OWN nested background
    // task (owner = that subagent's runtime-minted id). run_in_background: false
    // pins them foreground (dispatch is background-by-default) so each outer
    // subagent runs synchronously and its nested task id is captured before the
    // scoping assertions below.
    await coordAgent.execute("c1", {
      subagent_type: "general-purpose",
      prompt: "OUTER1",
      run_in_background: false,
    });
    await coordAgent.execute("c2", {
      subagent_type: "general-purpose",
      prompt: "OUTER2",
      run_in_background: false,
    });
    // A coordinator-owned background task (owner: undefined).
    const coordRes = await coordAgent.execute("c3", {
      subagent_type: "general-purpose",
      prompt: "COORD",
      run_in_background: true,
    });
    const coordTaskId = coordRes.details.taskId as string;

    expect(ownTaskId1, "subagent1 started its own task").toBeTruthy();
    expect(siblingTaskId, "subagent2 started its own task").toBeTruthy();
    expect(coordTaskId).toBeTruthy();
    // Three distinct ids off the single session-wide counter.
    expect(new Set([ownTaskId1, siblingTaskId, coordTaskId]).size).toBe(3);

    // Parent link on a GENUINELY nested dispatch: the inner agent's registry
    // record carries the outer subagent's runtime-minted id (== the task owner
    // the runtime tagged) — the seam the panel's tree (t03) is built on.
    const innerTask1 = internals.backgroundTasks.get(ownTaskId1!);
    expect(innerTask1?.owner, "nested task carries its dispatcher-owner id").toBeTruthy();
    const innerRecord1 = internals.subagentRegistry.get(innerTask1!.agentId!);
    expect(innerRecord1?.parentAgentId).toBe(innerTask1!.owner);
    // The coordinator-owned task has no parent (depth-1).
    const coordRecord = internals.subagentRegistry.get(internals.backgroundTasks.get(coordTaskId)!.agentId!);
    expect(coordRecord?.parentAgentId).toBeUndefined();

    const sub1Output = findTool(subagent1Tools, "TaskOutput");
    const sub1Stop = findTool(subagent1Tools, "TaskStop");
    // Sanity: subagent2 also received its own scoped tools (used implicitly via
    // the sibling id below; assert it was wired).
    expect(findTool(subagent2Tools, "TaskOutput").name).toBe("TaskOutput");

    // FOREIGN-REFUSED (before any gate is released — refusal needs no settlement):
    // the coordinator's and the sibling's tasks are indistinguishable from an
    // unknown id — a clean throw, no read, no side effect.
    await expect(sub1Output.execute("r1", { task_id: coordTaskId, wait: false })).rejects.toThrow(
      /Unknown task_id/,
    );
    await expect(
      sub1Output.execute("r2", { task_id: siblingTaskId!, wait: false }),
    ).rejects.toThrow(/Unknown task_id/);
    await expect(sub1Stop.execute("r3", { task_id: coordTaskId })).rejects.toThrow(/Unknown task_id/);

    // Non-leak: an "unknown id" message echoes the QUERIED id back (the caller's
    // own input — no leak) but its "Known background tasks" list must reveal only
    // subagent1's OWN task, never the coordinator's or the sibling's id.
    const errMsg = (r: Promise<unknown>) => r.then(() => "", (e: Error) => e.message);
    const foreignRefusal = await errMsg(
      sub1Output.execute("r4", { task_id: coordTaskId, wait: false }),
    );
    const knownList = foreignRefusal.split("Known background tasks:")[1] ?? "";
    expect(knownList).toContain(ownTaskId1!);
    expect(knownList).not.toContain(coordTaskId);
    expect(knownList).not.toContain(siblingTaskId!);
    // Indistinguishable from a genuinely-unknown id: querying a never-issued id
    // yields the same "known" list (only own tasks) — a foreign task's existence
    // is unobservable through the refusal.
    const unknownRefusal = await errMsg(
      sub1Output.execute("r4b", { task_id: "task-99999", wait: false }),
    );
    expect(unknownRefusal.split("Known background tasks:")[1] ?? "").toBe(knownList);

    // No side effect: the refused TaskStop did not stop the coordinator's task.
    expect(internals.backgroundTasks.get(coordTaskId)?.status).not.toBe("stopped");

    // OWN-REACHABLE: subagent1 retrieves its own task, awaited deterministically.
    releaseInner1();
    const ownOut = await sub1Output.execute("r5", { task_id: ownTaskId1!, wait: true });
    expect(ownOut.content[0]?.text).toContain("inner1 result");

    // COORDINATOR FULL REACH: every task, through the coordinator's own tools.
    releaseInner2();
    const coordOutput = p.tools.get("TaskOutput");
    const a = await coordOutput.execute("k1", { task_id: ownTaskId1!, wait: true });
    const b = await coordOutput.execute("k2", { task_id: siblingTaskId!, wait: true });
    const c = await coordOutput.execute("k3", { task_id: coordTaskId, wait: true });
    expect(a.content[0].text).toContain("inner1 result");
    expect(b.content[0].text).toContain("inner2 result");
    expect(c.content[0].text).toContain("coord done");
  });
});

describe("subagent built-ins via the shared factory (offline-integration)", () => {
  type Internals = Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];

  it("builds a subagent's bash through the shared factory; its spawnHook yields settings.env + CLAUDE_PROJECT_DIR (BUG 1)", async () => {
    // Drive a REAL dispatch offline (fakeSdk via the onWired seam). The fake's
    // RECORDING createBashTool captures the options object the shared factory hands
    // it — proving (a) the subagent path went THROUGH the factory (non-vacuous), and
    // (b) the captured spawnHook layers project.settings.env + CLAUDE_PROJECT_DIR,
    // exactly as the main-session bash does. general-purpose inherits all tools, so
    // Bash is granted and its built-in is constructed.
    const handle = fakeSdk({ replies: ["FACTORY-BASH-DONE"] });
    const p = fakePi();
    let internals!: Internals;
    picc(p.api as never, {
      onWired: (i) => (internals = i),
      onInitializationSettled: p.captureInitialization,
    });
    await p.waitForInitialization();
    await p.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
    internals.subagentRuntime.setSdkForTest(handle.sdk);

    const agent = p.tools.get("Agent");
    await agent.execute("fb", {
      subagent_type: "general-purpose",
      prompt: "run something",
      run_in_background: false,
    });

    const bashOpts = handle.builtinBashOptions();
    expect(bashOpts.length, "subagent bash was NOT built through the shared factory").toBeGreaterThan(
      0,
    );
    const spawnHook = bashOpts[0]!.spawnHook;
    expect(typeof spawnHook, "factory bash options carry no spawnHook").toBe("function");
    const out = spawnHook!({ command: "echo hi", cwd: dir, env: { PATH: "/usr/bin" } });
    // the project's settings.env is layered onto the subprocess env…
    expect(out.env.FS_FIXTURE).toBe("full-surface");
    // …and CLAUDE_PROJECT_DIR is injected (exact key casing) at the project root.
    expect(out.env.CLAUDE_PROJECT_DIR).toBeDefined();
    expect(path.resolve(out.env.CLAUDE_PROJECT_DIR!)).toBe(path.resolve(dir));
    // Inherited env is preserved.
    expect(out.env.PATH).toBe("/usr/bin");
  });
});

describe("degradation floor", () => {
  it("unknown hook event, degraded handler types, future settings keys — nothing crashed at load", () => {
    // The extension registered tools/commands despite FuturisticUnknownEvent,
    // a prompt-type PreCompact handler, futureUnknownSetting, outputStyle, .mcp.json,
    // future-agent with mcpServers/memory, and unknown skill frontmatter.
    expect(pi.tools.size).toBeGreaterThan(15);
    expect(pi.commands.size).toBeGreaterThanOrEqual(3); // doctor, quota, skills
  });

  it("future-agent (memory/mcpServers/unknown keys) is still dispatchable via the catalog", async () => {
    const prompt = (await pi.fire("before_agent_start", { systemPrompt: "B" })).systemPrompt as string;
    expect(prompt).toContain("future-agent:");
  });
});

describe("universal tool/worktree stops through production wiring", () => {
  const cases = [
    { event: "PreToolUse", kind: "tool" },
    { event: "WorktreeRemove", kind: "remove" },
  ] as const;

  it.each(cases)("main $event stops the threshold run and releases the next cycle", async ({ event, kind }) => {
    const fixture = materializeFixture("full-surface");
    const previousCwd = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    const marker = path.join(fixture, `.stop-once-${event}`);
    const script = path.join(fixture, "stop-once.cjs");
    fs.writeFileSync(script, [
      "const fs=require('node:fs');",
      `const marker=${JSON.stringify(marker)};`,
      "if(!fs.existsSync(marker)){fs.writeFileSync(marker,'stopped');process.stdout.write(JSON.stringify({continue:false,stopReason:'wired universal stop'}));}",
    ].join(""));
    const settingsFile = path.join(fixture, ".claude", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    settings.env = { ...(settings.env ?? {}), STOP_NODE: process.execPath, STOP_SCRIPT: script };
    settings.hooks = {
      [event]: [{
        ...(event === "PreToolUse" ? { matcher: "TodoWrite" } : {}),
        hooks: [{ type: "command", command: "\"$STOP_NODE\" \"$STOP_SCRIPT\"" }],
      }],
    };
    fs.writeFileSync(settingsFile, JSON.stringify(settings));

    const p = fakePi();
    let high = true;
    const context = p.tuiCtx({
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      getContextUsage: () => high
        ? ({ tokens: 950, contextWindow: 1000, percent: 95 })
        : ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    });
    try {
      process.chdir(fixture);
      process.env.PICC_CLAUDE_USER_DIR = path.join(fixture, ".user");
      picc(p.api as never, { onInitializationSettled: p.captureInitialization });
      await p.waitForInitialization();
      await p.fire("session_start", { sessionId: "wired-stop" }, context);
      await p.fire("input", { text: "first run", source: "interactive" }, context);

      let toolName = "TodoWrite";
      let args: Record<string, unknown> = { todos: [] };
      if (kind === "remove") {
        const entered = await p.tools.get("EnterWorktree").execute("seed", { name: `stop-remove-${Date.now()}` }, undefined, undefined, context);
        toolName = "ExitWorktree";
        args = { action: "remove" };
        expect(entered.details.worktreePath).toBeTruthy();
      }
      const callId = `call-${event}`;
      await p.fire("message_end", {
        message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }] },
      }, context);
      const pre = await p.fire("tool_call", { toolName, toolCallId: callId, input: args }, context);
      let result: any = { content: [{ type: "text", text: "blocked" }], details: {}, isError: true };
      if (!pre?.block) {
        result = await p.tools.get(toolName).execute(callId, args, undefined, undefined, context);
        await p.fire("tool_result", { toolName, toolCallId: callId, input: args, ...result }, context);
      }
      await p.fire("tool_execution_end", { toolCallId: callId, result, isError: result.isError === true }, context);
      await p.fire("turn_end", {}, context);
      await p.fire("before_provider_request", {}, context);
      await p.fire("agent_settled", {}, context);

      expect(p.compactCalls).toHaveLength(0);
      expect(p.messages.some(({ message }) => message.customType === "picc-checkpoint-continuation")).toBe(false);
      expect(p.userMessages).toHaveLength(0);
      const stoppedAborts = p.abortCalls;
      expect(stoppedAborts).toBeGreaterThan(0);

      high = false;
      expect(await p.fire("input", { text: "next genuine run", source: "interactive" }, context)).toMatchObject({ action: "continue" });
      const nextId = `next-${event}`;
      const nextArgs = { todos: [] };
      await p.fire("message_end", {
        message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: nextId, name: "TodoWrite", arguments: nextArgs }] },
      }, context);
      expect((await p.fire("tool_call", { toolName: "TodoWrite", toolCallId: nextId, input: nextArgs }, context))?.block).not.toBe(true);
      const nextResult = await p.tools.get("TodoWrite").execute(nextId, nextArgs, undefined, undefined, context);
      await p.fire("tool_result", { toolName: "TodoWrite", toolCallId: nextId, input: nextArgs, ...nextResult }, context);
      await p.fire("tool_execution_end", { toolCallId: nextId, result: nextResult, isError: false }, context);
      await p.fire("turn_end", {}, context);
      await p.fire("before_provider_request", {}, context);
      expect(p.abortCalls).toBe(stoppedAborts);
    } finally {
      process.chdir(previousCwd);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  });
});

describe("child worktree stops through the production extension assembly", () => {
  type Internals = Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];

  it.each(["WorktreeRemove"] as const)(
    "%s continue:false reaches the child gate and leaves the next dispatch healthy",
    async (event) => {
      const fixture = materializeFixture("full-surface");
      const previousCwd = process.cwd();
      const previousUser = process.env.PICC_CLAUDE_USER_DIR;
      const markerPath = path.join(fixture, `.child-stop-once-${event}`);
      const hookScript = path.join(fixture, "child-worktree-stop.cjs");
      fs.writeFileSync(hookScript, [
        "const fs=require('node:fs');",
        `const marker=${JSON.stringify(markerPath)};`,
        "if(!fs.existsSync(marker)){fs.writeFileSync(marker,'stopped');process.stdout.write(JSON.stringify({continue:false,stopReason:'child worktree stop'}));}",
      ].join(""));
      const settingsPath = path.join(fixture, ".claude", "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      settings.env = { ...(settings.env ?? {}), STOP_NODE: process.execPath, STOP_SCRIPT: hookScript };
      settings.hooks = {
        [event]: [{ hooks: [{ type: "command", command: "\"$STOP_NODE\" \"$STOP_SCRIPT\"" }] }],
      };
      fs.writeFileSync(settingsPath, JSON.stringify(settings));

      const base = fakeSdk().sdk;
      let creations = 0;
      let compactions = 0;
      let continuations = 0;
      let ordinaryProviderRequests = 0;
      let childAborts = 0;

      class Loader {
        constructor(readonly options: Record<string, unknown>) {}
        async reload(): Promise<void> {}
      }

      const sdk: typeof base = {
        ...base,
        DefaultResourceLoader: Loader,
        async createAgentSession(options) {
          creations += 1;
          const creation = creations;
          const loader = options.resourceLoader as Loader;
          const handlers = new Map<string, Array<(payload: unknown, ctx: unknown) => unknown>>();
          const extensionPi = {
            on(name: string, handler: (payload: unknown, ctx: unknown) => unknown) {
              const list = handlers.get(name) ?? [];
              list.push(handler);
              handlers.set(name, list);
            },
            registerProvider() {},
            sendMessage() {},
          };
          for (const extension of loader.options.extensionFactories as Array<{
            factory(pi: typeof extensionPi): unknown;
          }>) extension.factory(extensionPi);
          const emit = async (name: string, payload: unknown, ctx: unknown): Promise<unknown[]> => {
            const results: unknown[] = [];
            for (const handler of handlers.get(name) ?? []) results.push(await handler(payload, ctx));
            return results;
          };
          const messages: PiSessionMessage[] = [];
          const listeners = new Set<(event: unknown) => void>();
          let aborted = false;
          const ctx = {
            mode: "json",
            model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
            getContextUsage: () => creation === 1
              ? ({ tokens: 950, contextWindow: 1000, percent: 95 })
              : ({ tokens: 100, contextWindow: 1000, percent: 10 }),
            hasPendingMessages: () => false,
            abort: () => { aborted = true; childAborts += 1; },
          };
          const recordProviderIfAdmitted = async () => {
            await emit("before_provider_request", {}, ctx);
            if (!aborted) ordinaryProviderRequests += 1;
          };
          const session = {
            messages,
            subscribe(listener: (event: unknown) => void) {
              listeners.add(listener);
              return () => { listeners.delete(listener); };
            },
            async prompt(text: string) {
              messages.push({ role: "user", content: text });
              await emit("turn_start", {}, ctx);
              await recordProviderIfAdmitted();
              const calls = [
                { id: "enter", name: "EnterWorktree", args: { name: `wired-${event}-${creation}` } },
                { id: "exit", name: "ExitWorktree", args: { action: "remove" } },
              ];
              const assistant = {
                role: "assistant",
                stopReason: "toolUse",
                content: calls.map((call) => ({
                  type: "toolCall", id: call.id, name: call.name, arguments: call.args,
                })),
              };
              messages.push(assistant);
              await emit("message_end", { message: assistant }, ctx);
              for (const call of calls) {
                await emit("tool_call", {
                  toolName: call.name, toolCallId: call.id, input: call.args,
                }, ctx);
                const tool = (options.customTools as FakeCustomTool[])
                  .find((candidate) => candidate.name === call.name);
                if (!tool) throw new Error(`${call.name} was not assembled for the child session`);
                const result = await (tool.execute as (...args: unknown[]) => Promise<Record<string, unknown>>)(
                  call.id, call.args, undefined, undefined, ctx,
                );
                await emit("tool_result", {
                  toolName: call.name, toolCallId: call.id, input: call.args, ...result,
                }, ctx);
                await emit("tool_execution_end", {
                  toolCallId: call.id, result, isError: result.isError === true,
                }, ctx);
              }
              const continuationsBefore = continuations;
              await emit("turn_end", {}, ctx);
              if (continuations === continuationsBefore) {
                await recordProviderIfAdmitted();
                messages.push({
                  role: "assistant",
                  content: [],
                  stopReason: aborted ? "aborted" : "stop",
                  ...(aborted ? { errorMessage: "Aborted" } : {}),
                });
                await emit("agent_settled", {}, ctx);
              }
            },
            async compact() {
              compactions += 1;
              const before = await emit("session_before_compact", { reason: "manual" }, ctx);
              if (before.some((result) => (result as { cancel?: boolean } | undefined)?.cancel)) {
                throw new Error("compaction cancelled");
              }
              await emit("session_compact", { compactionEntry: { summary: "summary" } }, ctx);
              return { summary: "summary" };
            },
            abortCompaction() {},
            async sendCustomMessage(
              _message: { customType: string; content: unknown; display: boolean },
              sendOptions?: { triggerTurn?: boolean },
            ) {
              if (!sendOptions?.triggerTurn) return;
              continuations += 1;
              aborted = false;
              await emit("turn_start", {}, ctx);
              await recordProviderIfAdmitted();
              messages.push({
                role: "assistant",
                content: [{ type: "text", text: "continued" }],
                stopReason: "stop",
              });
              await emit("turn_end", {}, ctx);
              await emit("agent_settled", {}, ctx);
            },
            abort() { aborted = true; childAborts += 1; },
            dispose() {},
          };
          return { session };
        },
      };

      const p = fakePi();
      let internals!: Internals;
      try {
        process.chdir(fixture);
        process.env.PICC_CLAUDE_USER_DIR = path.join(fixture, ".user");
        picc(p.api as never, {
          onWired: (wired) => { internals = wired; },
          onInitializationSettled: p.captureInitialization,
        });
        await p.waitForInitialization();
        await p.waitForTools(["Agent"]);
        internals.subagentRuntime.setSdkForTest(sdk);

        const agent = p.tools.get("Agent");
        await expect(agent.execute("first", {
          subagent_type: "general-purpose",
          prompt: "stopped threshold child run",
          run_in_background: false,
        })).rejects.toThrow(/aborted before completing/);
        expect(fs.readFileSync(markerPath, "utf8")).toBe("stopped");
        expect(compactions).toBe(0);
        expect(continuations).toBe(0);
        expect(ordinaryProviderRequests).toBe(1);
        expect(childAborts).toBeGreaterThan(0);

        const abortsAfterStoppedRun = childAborts;
        const second = await agent.execute("second", {
          subagent_type: "general-purpose",
          prompt: "subsequent healthy child run",
          run_in_background: false,
        });
        expect(second.details.outcome).toBe("completed");
        expect(compactions).toBe(0);
        expect(continuations).toBe(0);
        expect(ordinaryProviderRequests).toBeGreaterThan(1);
        expect(childAborts).toBe(abortsAfterStoppedRun);
      } finally {
        process.chdir(previousCwd);
        if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
        else process.env.PICC_CLAUDE_USER_DIR = previousUser;
        cleanupFixture(fixture);
      }
    },
  );
});

describe("MCP failed-connect surfacing (dedicated temp project)", () => {
  // The full-surface fixture's .mcp.json deliberately stays UNAPPROVED (the
  // standing pending case), so the failed-connect path gets its own minimal
  // project: an approved server whose command cannot spawn. The approval rides
  // an UNTRACKED settings.local.json (no git repo → the tracked probe fails
  // open), so the enablement gate itself is exercised for real.
  function makeFailingMcpProject(): string {
    const mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-mcp-fail-"));
    fs.writeFileSync(
      path.join(mcpDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "failing-server": { command: "picc-no-such-command-t05" } },
      }),
      "utf8",
    );
    fs.mkdirSync(path.join(mcpDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(mcpDir, ".claude", "settings.local.json"),
      JSON.stringify({ enabledMcpjsonServers: ["failing-server"] }),
      "utf8",
    );
    return mcpDir;
  }

  function cleanupFailingMcpProject(mcpDir: string): void {
    process.chdir(dir);
    // Best-effort: Windows can EPERM a just-vacated cwd (handle release lag).
    try {
      fs.rmSync(mcpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* leftover temp dir is harmless */
    }
  }

  it(
    "a failed server reaches the /doctor posture line, fires the one-time warning notify, and drains diagnostics to stderr",
    async () => {
      const mcpDir = makeFailingMcpProject();
      process.chdir(mcpDir);
      // Installed BEFORE wiring: the settle-time diagnostics drain runs inside
      // the detached registration step, any time after connect settles.
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const p = fakePi();
      try {
        picc(p.api as never, { onInitializationSettled: p.captureInitialization });
        await p.waitForInitialization();
        // The first-turn barrier awaits MCP settle + registration, so after this
        // fire the spawn failure has been classified.
        await p.fire("before_agent_start", { systemPrompt: "B" });
        const warnings = p.notifications.filter((n) => n.text.includes("MCP"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.text).toContain("failing-server");
        expect(warnings[0]!.text).toContain("/doctor");
        expect(warnings[0]!.severity).toBe("warning");
        // One-time: a later turn must not re-notify.
        await p.fire("before_agent_start", { systemPrompt: "B" });
        expect(p.notifications.filter((n) => n.text.includes("MCP"))).toHaveLength(1);
        // Settle-time stderr drain: the runtime's connect-failure diagnostic
        // reaches console.error — the stderr surface the registry note claims.
        const drained = errSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(drained).toContain("PiCC: MCP:");
        expect(drained).toContain("failing-server");

        p.entries.length = 0;
        await p.commands.get("doctor").handler("", p.ctx());
        const doctor = p.entries
          .filter((e) => e.customType === "picc-control")
          .map((e) => String(e.data?.output ?? ""))
          .join("\n");
        expect(doctor).toContain("failing-server: failed");
        // The diagnostic quotes the RAW command, never a resolved path.
        expect(doctor).toContain("picc-no-such-command-t05");
      } finally {
        errSpy.mockRestore();
        await p.fire("session_shutdown", { reason: "other" });
        cleanupFailingMcpProject(mcpDir);
      }
    },
    60_000,
  );

  it(
    "the one-time failure notice falls back to stderr when the ctx has no UI",
    async () => {
      const mcpDir = makeFailingMcpProject();
      process.chdir(mcpDir);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const p = fakePi();
      try {
        picc(p.api as never, { onInitializationSettled: p.captureInitialization });
        await p.waitForInitialization();
        // printCtx models real Pi print mode: hasUI false → stderr fallback.
        await p.fire("before_agent_start", { systemPrompt: "B" }, p.printCtx());
        expect(p.notifications.filter((n) => n.text.includes("MCP"))).toHaveLength(0);
        const errText = errSpy.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(errText).toContain("MCP server(s) failed to connect");
        expect(errText).toContain("failing-server");
        expect(errText).toContain("run /doctor for details");
      } finally {
        errSpy.mockRestore();
        await p.fire("session_shutdown", { reason: "other" });
        cleanupFailingMcpProject(mcpDir);
      }
    },
    60_000,
  );
});

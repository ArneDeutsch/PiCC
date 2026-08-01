import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import picc, { type PiccTestSeam } from "../src/index.js";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { BackgroundResultLike } from "../src/runtime/background-tasks.js";
import { resolveGitBashPath } from "../src/engine/shell-inject.js";
import { RECORD_EXPAND_HINT } from "../src/runtime/subagent-render.js";
import {
  formatSubagentRecoveryGuidance,
  type RecoveryGuidanceInput,
} from "../src/runtime/subagent-recovery.js";
import type { PiSessionMessage } from "../src/runtime/subagents.js";
import { formatElapsed } from "../src/runtime/subagent-panel-render.js";
import { createGlobTool, createGrepTool } from "../src/runtime/tools/search-tools.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk, type FakeCustomTool, type FakeSessionState } from "./helpers/fake-sdk.js";
import { deferred, waitUntil } from "./helpers/async.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";
import { loadSkills } from "../src/claude/skills.js";
import { sanitizePluginDataKey } from "../src/claude/plugin-paths.js";
import type { NotebookSessionState } from "../src/runtime/notebook-session.js";

/**
 * Integration + NFR tests: the whole extension wired against
 * the full-surface conformance fixture through a fake Pi API. No LLM/network involved —
 * these assert the mechanical-fidelity tier end to end.
 */

let dir: string;
let pi: FakePi;
let getActiveNotebookState: () => NotebookSessionState;
const originalCwd = process.cwd();
const compatAckSentinel = '{"suppressed":true,"sentinel":"KEEP-BYTES"}\n';
const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piTui = await import(pathToFileURL(requireFromPi.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");

beforeAll(async () => {
  dir = materializeFixture("full-surface");
  // Seedable gitignored files for .worktreeinclude
  fs.writeFileSync(path.join(dir, ".env.local"), "SECRET=1\n");
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "app.secret"), "s\n");
  const ack = path.join(dir, ".claude", ".picc", "compat-ack.json");
  fs.mkdirSync(path.dirname(ack), { recursive: true });
  fs.writeFileSync(ack, compatAckSentinel, "utf8");
  // Hermetic installed plugin: repository `.claude-plugin/` is only source fixture
  // material and never an executable root.
  const userDir = path.join(dir, ".claude-user");
  const pluginId = "bundled-fixture-plugin@fixture-market";
  const installRoot = path.join(userDir, "plugins", "cache", "fixture-market", "bundled-fixture-plugin", "1.0.0");
  fs.mkdirSync(path.join(installRoot, ".claude-plugin"), { recursive: true });
  fs.copyFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    path.join(installRoot, ".claude-plugin", "plugin.json"),
  );
  fs.mkdirSync(path.join(installRoot, "skills", "plugin-skill"), { recursive: true });
  fs.copyFileSync(
    path.join(dir, ".claude-plugin", "skills", "plugin-skill", "SKILL.md"),
    path.join(installRoot, "skills", "plugin-skill", "SKILL.md"),
  );
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "skills", "plugin-skill", "SKILL.md"),
    "---\ndescription: inert repository canary\n---\nCanary: FS-REPOSITORY-PLUGIN-INERT\n",
  );
  fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({
    enabledPlugins: { [pluginId]: true, "disabled@fixture-market": false },
  }));
  fs.writeFileSync(
    path.join(userDir, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { [pluginId]: [{ scope: "user", installPath: installRoot, version: "1.0.0" }] } }),
  );
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);
  pi = fakePi();
  picc(pi.api as never, {
    onInitializationSettled: pi.captureInitialization,
    onWired: (internals) => { getActiveNotebookState = internals.getActiveNotebookState; },
  });
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
      "NotebookEdit",
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

  it("classifies every actual main-session registration under one explicit presentation policy", () => {
    type PolicyFamily = "overview" | "specialized" | "mcp" | "generic-fail-open";
    const explicit = new Map<string, Exclude<PolicyFamily, "mcp">>();
    const add = (family: Exclude<PolicyFamily, "mcp">, names: readonly string[]) => {
      for (const name of names) {
        expect(explicit.has(name), `duplicate policy for ${name}`).toBe(false);
        explicit.set(name, family);
      }
    };
    add("overview", [
      "bash", "read", "write", "edit", "grep", "find", "ls",
      "WebFetch", "WebSearch", "Grep", "Glob", "MultiEdit", "Skill", "SlashCommand",
      "EnterWorktree", "ExitWorktree", "TaskCreate", "TaskUpdate", "TaskGet",
    ]);
    add("specialized", [
      "Agent", "Task", "SendMessage", "TaskOutput", "TaskStop", "TaskList", "TodoWrite", "NotebookEdit",
    ]);
    add("generic-fail-open", [
      "NotebookRead", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode", "Artifact",
      "computer", "LSP", "BashOutput", "KillShell", "KillBash",
    ]);

    const isMcpName = (name: string): boolean => {
      const prefix = "mcp__";
      if (!name.startsWith(prefix)) return false;
      const payload = name.slice(prefix.length);
      const separator = payload.indexOf("__");
      if (separator < 0) return false;
      const server = payload.slice(0, separator);
      const tool = payload.slice(separator + 2);
      return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(server) && /^[A-Za-z0-9_-]+$/u.test(tool);
    };
    const familiesFor = (name: string): PolicyFamily[] => [
      ...(explicit.has(name) ? [explicit.get(name)!] : []),
      ...(isMcpName(name) ? ["mcp" as const] : []),
    ];
    expect(familiesFor("mcp__future_server__future_method")).toEqual(["mcp"]);
    expect(familiesFor("mcp__fixture____")).toEqual(["mcp"]);
    expect(["mcp____tool", "mcp___server__tool", "mcp__server__bad.tool", "mcp__server"]
      .map((name) => familiesFor(name))).toEqual([[], [], [], []]);

    const actual = [...pi.tools.keys()].sort();
    const declared = [...explicit.keys()].sort();
    expect(actual.filter((name) => !isMcpName(name))).toEqual(declared);
    for (const name of actual) {
      const matches = familiesFor(name);
      expect(matches, `${name} must match exactly one policy family`).toHaveLength(1);
      const tool = pi.tools.get(name);
      expect(tool.renderShell, `${name} policy lost self-shell`).toBe("self");
      expect(typeof tool.renderCall, `${name} policy lost call evidence`).toBe("function");
      expect(typeof tool.renderResult, `${name} policy lost result evidence`).toBe("function");
      if (matches[0] === "generic-fail-open") {
        expect(String(tool.description)).toContain("degraded no-op");
      }
    }
  });

  it("shares main Read/Edit state per branch and persists only bounded non-model-visible snapshots", async () => {
    const notebookPath = path.join(dir, "wired-notebook.ipynb");
    fs.writeFileSync(notebookPath, JSON.stringify({
      cells: [{ cell_type: "code", id: "cell-a", metadata: {}, source: "old", execution_count: 1, outputs: [] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }), "utf8");
    const branchA: unknown[] = [];
    const sessionManager = { getBranch: () => branchA, getSessionFile: () => undefined };
    pi.entries.length = 0;
    await pi.fire("session_start", { reason: "startup" }, pi.ctx({ sessionManager }));

    const unread = await pi.tools.get("NotebookEdit").execute("edit-unread", {
      notebook_path: notebookPath,
      new_source: "blocked",
      cell_id: "cell-a",
    });
    expect(unread.isError).toBe(true);

    await pi.tools.get("read").execute("read-notebook", { path: notebookPath });
    const firstEdit = await pi.tools.get("NotebookEdit").execute("edit-authorized", {
      notebook_path: notebookPath,
      new_source: "first",
      cell_id: "cell-a",
    });
    expect(firstEdit.isError).not.toBe(true);
    const persisted = pi.entries.filter((entry) => entry.customType === "picc-notebook-session");
    expect(persisted.length).toBeGreaterThanOrEqual(2);
    for (const entry of persisted) {
      expect(Object.keys(entry.data).sort()).toEqual(["generation", "records", "version"]);
      expect(JSON.stringify(entry.data)).not.toContain("old");
      branchA.push({ type: "custom", customType: entry.customType, data: entry.data });
    }

    const outgoingState = getActiveNotebookState();
    await pi.fire("session_before_switch", {}, pi.ctx());
    const entriesAtAcceptedSwitch = pi.entries.length;
    outgoingState.recordRead({
      normalizedPath: notebookPath,
      canonicalPath: notebookPath,
      fingerprint: "a".repeat(64),
    }, Buffer.from("late outgoing transition"));
    expect(pi.entries).toHaveLength(entriesAtAcceptedSwitch);

    const gapEdit = await pi.tools.get("NotebookEdit").execute("edit-switch-gap", {
      notebook_path: notebookPath,
      new_source: "gap-leak",
      cell_id: "cell-a",
    });
    expect(gapEdit.isError).toBe(true);

    await pi.fire("session_start", { reason: "new" }, pi.ctx({
      sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
    }));
    const isolated = await pi.tools.get("NotebookEdit").execute("edit-new-session", {
      notebook_path: notebookPath,
      new_source: "leaked",
      cell_id: "cell-a",
    });
    expect(isolated.isError).toBe(true);

    await pi.fire("session_before_switch", {}, pi.ctx());
    await pi.fire("session_start", { reason: "resume" }, pi.ctx({
      sessionManager: {
        getBranch: () => [...branchA, {
          type: "custom",
          customType: "picc-notebook-session",
          data: { version: 1, generation: 2, records: new Array(65).fill({}) },
        }],
        getSessionFile: () => undefined,
      },
    }));
    const corruptNewest = await pi.tools.get("NotebookEdit").execute("edit-corrupt-resume", {
      notebook_path: notebookPath,
      new_source: "must-not-fallback",
      cell_id: "cell-a",
    });
    expect(corruptNewest.isError).toBe(true);

    await pi.fire("session_before_switch", {}, pi.ctx());
    await pi.fire("session_start", { reason: "resume" }, pi.ctx({ sessionManager }));
    const restored = await pi.tools.get("NotebookEdit").execute("edit-restored", {
      notebook_path: notebookPath,
      new_source: "restored",
      cell_id: "cell-a",
    });
    expect(restored.isError).not.toBe(true);
    expect(JSON.parse(fs.readFileSync(notebookPath, "utf8")).cells[0].source).toBe("restored");
    fs.rmSync(notebookPath, { force: true });
  });

  it("keeps live edits successful across append failure and restores only the last persisted snapshot", async () => {
    const notebookPath = path.join(dir, "append-failure-notebook.ipynb");
    fs.writeFileSync(notebookPath, JSON.stringify({
      cells: [{ cell_type: "code", id: "cell-a", metadata: {}, source: "old", execution_count: null, outputs: [] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }), "utf8");
    const branch: unknown[] = [];
    const originalAppendEntry = pi.api.appendEntry;
    try {
      pi.api.appendEntry = (customType: string, data: unknown) => {
        pi.entries.push({ customType, data });
        branch.push({ type: "custom", customType, data });
      };
      await pi.fire("session_before_switch", {}, pi.ctx());
      await pi.fire("session_start", { reason: "startup" }, pi.ctx({
        sessionManager: { getBranch: () => branch, getSessionFile: () => undefined },
      }));
      await pi.tools.get("read").execute("persisted-read", { path: notebookPath });
      expect(branch).toHaveLength(1);

      pi.api.appendEntry = () => { throw new Error("scripted append failure"); };
      const entryCount = pi.entries.length;
      const messageCount = pi.messages.length;
      const edited = await pi.tools.get("NotebookEdit").execute("live-edit", {
        notebook_path: notebookPath,
        new_source: "live-success",
        cell_id: "cell-a",
      });
      expect(edited.isError).not.toBe(true);
      expect(pi.entries).toHaveLength(entryCount);
      expect(pi.messages).toHaveLength(messageCount);
      expect(JSON.parse(fs.readFileSync(notebookPath, "utf8")).cells[0].source).toBe("live-success");

      await pi.fire("session_before_switch", {}, pi.ctx());
      await pi.fire("session_start", { reason: "resume" }, pi.ctx({
        sessionManager: { getBranch: () => branch, getSessionFile: () => undefined },
      }));
      const restored = await pi.tools.get("NotebookEdit").execute("restored-old-snapshot", {
        notebook_path: notebookPath,
        new_source: "must-not-write",
        cell_id: "cell-a",
      });
      expect(restored.isError).toBe(true);
      expect(restored.content[0].text).toContain("changed after the authorizing Read");
      expect(JSON.parse(fs.readFileSync(notebookPath, "utf8")).cells[0].source).toBe("live-success");
    } finally {
      pi.api.appendEntry = originalAppendEntry;
      fs.rmSync(notebookPath, { force: true });
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
    const previousPiBindings = piTui.getKeybindings();
    const bindingDefinitions = { ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o" as const, description: "Toggle tool output" } };
    setKeybindings(new KeybindingsManager(bindingDefinitions));
    piTui.setKeybindings(new piTui.KeybindingsManager(bindingDefinitions));
    try {
      const read = pi.tools.get("read");
      const args = { path: "registered.txt" };
      const state = {};
      const theme = { fg: (_slot: string, text: string) => text, bold: (text: string) => text,
        bg: (_slot: string, text: string) => text };
      const context = { args, state, isPartial: false, isError: false, expanded: false,
        cwd: dir, showImages: false, invalidate() {} };
      const readCallComponent = read.renderCall(args, theme, context);
      const readResultComponent = read.renderResult(
        { content: [{ type: "text", text: "REGISTERED_DETAIL_ONE\nREGISTERED_DETAIL_TWO" }], details: undefined },
        { expanded: false, isPartial: false }, theme, context,
      );
      const readCall = readCallComponent.render(160).join("\n");
      const rendered = readResultComponent.render(160).join("\n");
      expect(readCall).toBe("● read registered.txt · ctrl+o to expand");
      expect(rendered).toBe("");
      expect(`${readCall}\n${rendered}`).not.toContain("REGISTERED_DETAIL");

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
      piTui.setKeybindings(previousPiBindings);
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

      const ctx = {
        args: search.args,
        state: {},
        isPartial: false,
        isError: false,
        expanded: false,
        showImages: false,
      };
      const call = registered.renderCall(search.args, undefined, ctx);
      const renderedResult = registered.renderResult(
        result,
        { expanded: false, isPartial: false },
        undefined,
        ctx,
      );
      expect(call.render(80)).toEqual([]);
      const lines = renderedResult.render(80);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.trim()).not.toBe("");
      expect(lines[0]).toContain(search.name.toLowerCase());
      expect(lines[0]).toContain(search.args.pattern);
      expect(result).toEqual(beforeRender);
    }
  });

  it("keeps unrelated Claude rendering generic while lowercase stock grep uses compact specialization", async () => {
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
    const call = lowerGrep.renderCall(args, theme, ctx);
    const resultText = lowerGrep.renderResult(
      result, { expanded: false, isPartial: false }, theme, ctx,
    ).render(100).join("\n");
    const callText = call.render(100).join("\n");
    expect(callText).toContain("T02-LOWERCASE-STOCK");
    expect(callText).toContain("ctrl+o to expand");
    expect(`${callText}\n${resultText}`).not.toContain("complete stock result");
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
    expect(prompt).toContain("selected installed plugin");
    expect(prompt).not.toContain("FS-REPOSITORY-PLUGIN-INERT");
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

  it("pins the single state-aware recovery rule and its dynamic disposition semantics", async () => {
    const result = await pi.fire("before_agent_start", { systemPrompt: "BASE-PROMPT" });
    const prompt = result.systemPrompt as string;
    const expectedRule = "- Subagent failure recovery: follow each terminal result, which is authoritative for that run. Favor a fresh explicit Agent/Task dispatch only when complete lifecycle observation proves a transient-category failure had no successful assistant response, retained model/tool-call content, or started tool execution. Observed progress or incomplete lifecycle evidence takes the conservative branch: use SendMessage only if the result says the agent is resumable; otherwise review retained work and possible side effects before another explicit dispatch. For non-transient or unclassified failures, address the cause rather than blindly replacing or resuming. PiCC takes no automatic action.";
    const recoveryLines = prompt.split("\n").filter((line) => line.startsWith("- Subagent failure recovery:"));

    expect(recoveryLines).toEqual([expectedRule]);

    const cases: Array<{
      name: string;
      input: RecoveryGuidanceInput;
      staticClauses: readonly string[];
      dynamicClauses: readonly string[];
    }> = [
      {
        name: "proven zero progress favors fresh dispatch despite resumability",
        input: { disposition: "fresh-dispatch-preferred", resumable: true },
        staticClauses: ["complete lifecycle observation proves", "fresh explicit Agent/Task dispatch"],
        dynamicClauses: ["observed no assistant or tool progress", "fresh replacement agent", "technically resumable via SendMessage"],
      },
      {
        name: "observed or uncertain progress favors resume when available",
        input: { disposition: "resume-preferred", resumable: true },
        staticClauses: ["Observed progress or incomplete lifecycle evidence takes the conservative branch", "use SendMessage only if the result says the agent is resumable"],
        dynamicClauses: ["progress may have occurred", "Resume this same agent with SendMessage", "technically resumable via SendMessage"],
      },
      {
        name: "observed or uncertain non-resumable progress requires review",
        input: { disposition: "progressed-non-resumable", resumable: false },
        staticClauses: ["incomplete lifecycle evidence takes the conservative branch", "otherwise review retained work and possible side effects"],
        dynamicClauses: ["progress may have occurred", "same-agent continuation is unavailable", "not resumable via SendMessage", "Review retained work and possible tool side effects"],
      },
    ];

    for (const testCase of cases) {
      const dynamic = formatSubagentRecoveryGuidance(testCase.input);
      expect(dynamic, testCase.name).toBeDefined();
      for (const clause of testCase.staticClauses) expect(expectedRule, testCase.name).toContain(clause);
      for (const clause of testCase.dynamicClauses) expect(dynamic, testCase.name).toContain(clause);
    }
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

  it("installed plugin skill resolves exact variables and creates persistent data lazily", async () => {
    const skillTool = pi.tools.get("Skill");
    const dataDir = path.join(
      dir,
      ".claude-user",
      "plugins",
      "data",
      sanitizePluginDataKey("bundled-fixture-plugin@fixture-market"),
    );
    expect(fs.existsSync(dataDir)).toBe(false);
    const result = await skillTool.execute("t5", { name: "plugin-skill" });
    const text = result.content[0].text as string;
    expect(text).toContain("FS-PLUGIN-SKILL-BODY");
    expect(text).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(text).not.toContain("${CLAUDE_PLUGIN_DATA}");
    expect(text).not.toContain("FS-REPOSITORY-PLUGIN-INERT");
    expect(text).toContain(path.join(dir, ".claude-user", "plugins", "cache", "fixture-market", "bundled-fixture-plugin", "1.0.0"));
    expect(text).toContain(dataDir);
    expect(fs.statSync(dataDir).isDirectory()).toBe(true);
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
    expect(expanded.text).toContain("Waiting/running TaskOutput actions retain that target ID; the first delivered terminal outcome leaves one semantic agent record without it.");
    expect(expanded.text).toContain("shows running status and available metadata; bounded live activity belongs to the subagent panel drill-down.");
    expect(expanded.text).toContain("running poll keeps the task eligible");
    expect(expanded.text).toContain("one bounded next-turn settlement notice");
    expect(expanded.text).toContain("terminal return is already delivery and suppresses");
    expect(expanded.text).toContain("later retrieval adds no human row");
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
      expect(pi.notifications.filter((item) => item.text.includes("pending approval"))).toHaveLength(1);

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

  it("surfaces one bounded startup notice for enabled installed-state rejection", async () => {
    const fixture = materializeFixture("hello-claude");
    const previousCwd = process.cwd();
    const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
    try {
      const rejectedUserDir = path.join(fixture, ".claude-user");
      fs.mkdirSync(rejectedUserDir, { recursive: true });
      const pluginId = "selected-but-rejected@fixture-market";
      const installRoot = path.join(rejectedUserDir, "plugins", "cache", "fixture-market", "selected-but-rejected", "1.0.0");
      fs.mkdirSync(path.join(installRoot, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(installRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "selected-but-rejected", commands: "./wrong.txt" }),
      );
      fs.writeFileSync(path.join(installRoot, "wrong.txt"), "wrong extension");
      fs.writeFileSync(
        path.join(rejectedUserDir, "settings.json"),
        JSON.stringify({ enabledPlugins: { [pluginId]: true } }),
      );
      fs.mkdirSync(path.join(rejectedUserDir, "plugins"), { recursive: true });
      fs.writeFileSync(
        path.join(rejectedUserDir, "plugins", "installed_plugins.json"),
        JSON.stringify({ version: 2, plugins: { [pluginId]: [{ scope: "user", installPath: installRoot, version: "1.0.0" }] } }),
      );
      process.chdir(fixture);
      process.env.PICC_CLAUDE_USER_DIR = rejectedUserDir;
      const rejectedPi = fakePi();
      picc(rejectedPi.api as never, {
        managedSettingsPaths: [],
        managedArtifactDirs: [],
        onInitializationSettled: rejectedPi.captureInitialization,
      });
      await rejectedPi.waitForInitialization();
      await rejectedPi.fire("session_start", { reason: "startup" }, rejectedPi.tuiCtx());
      const pluginNotices = rejectedPi.notifications.filter((item) => item.text.includes("Enabled plugin content did not load"));
      expect(pluginNotices).toHaveLength(1);
      expect(pluginNotices[0]!.text).toContain(pluginId);
      expect(pluginNotices[0]!.text).toContain("/doctor");
    } finally {
      process.chdir(previousCwd);
      if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
      cleanupFixture(fixture);
    }
  });

  it("emits no plugin-failure notice for loaded and disabled installed states", async () => {
    pi.notifications.length = 0;
    await pi.fire("session_start", { reason: "startup" }, pi.tuiCtx());
    expect(pi.notifications.filter((item) => item.text.includes("Enabled plugin content did not load"))).toEqual([]);
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
    expect(doctor).toContain("\"example-server\": pending approval");
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
      rotationRow.setExpanded(true);
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
      errorRow.setExpanded(true);
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
      worktreeRow.setExpanded(true);
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
      baseRow.setExpanded(true);
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
    const previousPiBindings = piTui.getKeybindings();
    const bindingDefinitions = {
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o" as const, description: "Toggle tool output" },
    };
    setKeybindings(new KeybindingsManager(bindingDefinitions));
    piTui.setKeybindings(new piTui.KeybindingsManager(bindingDefinitions));
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
        const callComponent = tool.renderCall(entry.args, theme, context);
        const result = await tool.execute(`t02-${entry.name}-display`, entry.args);
        const resultBefore = structuredClone(result);
        const resultComponent = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
        const row = [...callComponent.render(120), ...resultComponent.render(120)].join("\n");
        expect(row).toContain(entry.expected);
        expect(row).not.toContain(wt);
        expect(entry.args).toEqual(argsBefore);
        expect(result).toEqual(resultBefore);
      }
    } finally {
      await pi.tools.get("ExitWorktree").execute("t02-display-wt-exit", { action: "remove" });
      fs.rmSync(path.join(dir, "repository-display-proof.txt"), { force: true });
      piTui.setKeybindings(previousPiBindings);
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

  it("hides registered Agent acceptance and resolves recorded color through terminal surfaces", async () => {
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
      started, { expanded: false, isPartial: false }, undefined, { state: {}, args, isError: false },
    ).render(100).join("\n");
    const outputText = taskOutput.renderResult(
      output, { expanded: false, isPartial: false }, undefined, { state: {}, args: outputArgs, isError: false },
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

    expect(agentText).toBe("");
    for (const text of [outputText, settlement]) {
      expect(text.match(/\u001b\[31mreviewer\u001b\[39m/gu)).toHaveLength(1);
      expect(text).not.toMatch(/\u001b\[31m\s*\[completed\]/u);
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
      undefined,
      "Review authentication boundaries",
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
    expect(top!.details!.description).toBe("Review authentication boundaries");
    expect(top!.content).toContain("settled: completed"); // model-facing text untouched

    // The RECORDED registered renderer, driven with the actual sent message at
    // Pi's collapsed default ({ expanded: false }) → the one-line record.
    const topCanonical = structuredClone(top);
    const component = renderer!(top, { expanded: false }, undefined);
    expect(component, "registered renderer fell back to the default box").toBeTruthy();
    const lines = component.render(200) as string[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reviewer");
    expect(lines[0]).toContain("[completed] - Review authentication boundaries");
    expect(lines[0]).toContain(formatElapsed(top!.details!.durationMs as number));
    expect(lines[0]).not.toContain(taskId);
    expect(lines[0]).not.toContain(".jsonl");
    expect(lines[0]).toContain(RECORD_EXPAND_HINT);
    expect(lines[0]).not.toContain("WIRED-RECORD-REPORT"); // body stays behind expand
    const expandedRecord = renderer!(top, { expanded: true }, undefined)!.render(200).join("\n");
    expect(expandedRecord).toContain("WIRED-RECORD-REPORT");
    expect(expandedRecord).toContain(`task: ${taskId}`);
    expect(expandedRecord).toContain(`agent: ${agentId}`);
    const reconstructed = structuredClone(top);
    expect(renderer!(reconstructed, { expanded: false }, undefined)!.render(200)).toEqual(lines);
    expect(top).toEqual(topCanonical);
    expect(reconstructed).toEqual(topCanonical);

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

  it("registered Agent acceptance is hidden, first TaskOutput is semantic, and later retrieval is human-hidden", async () => {
    const handle = fakeSdk({ replies: ["BACKGROUND-DONE"] });
    const { p, internals } = await wire();
    internals.subagentRuntime.setSdkForTest(handle.sdk);
    const agent = p.tools.get("Agent");
    const agentArgs = {
      subagent_type: "reviewer",
      prompt: "review in background",
      description: "Review authentication",
      run_in_background: true,
    };
    const started = await agent.execute("bg-description", agentArgs);
    expect(started.content).toEqual([
      {
        type: "text",
        text: `Background task ${started.details.taskId} accepted (agent: reviewer, agent id: ${started.details.agentId}); it will run when configured concurrency capacity is available. Use TaskOutput with task_id "${started.details.taskId}" to retrieve the result before finalizing.`,
      },
    ]);
    expect(started.details.description).toBe("Review authentication");
    const startedCanonical = structuredClone({ args: agentArgs, result: started });
    const agentContext = { state: {}, args: agentArgs, isPartial: false, isError: false };
    const agentCall = agent.renderCall(agentArgs, undefined, agentContext);
    const accepted = agent.renderResult(
      started, { isPartial: false, expanded: false }, undefined, agentContext,
    );
    expect(agentCall.render(120)).toEqual([]);
    expect(accepted.render(120)).toEqual([]);
    expect({ args: agentArgs, result: started }).toEqual(startedCanonical);

    const taskId = String(started.details.taskId);
    await internals.backgroundTasks.wait(taskId);
    const taskOutput = p.tools.get("TaskOutput");
    const outputArgs = { task_id: taskId };
    const output = await taskOutput.execute("collect-description", outputArgs);
    expect(output.content[0]!.text).toContain("BACKGROUND-DONE");
    expect(output.details.description).toBe("Review authentication");
    const outputCanonical = structuredClone({ args: outputArgs, result: output });
    const outputContext = { state: {}, args: outputArgs, isPartial: false, isError: false };
    taskOutput.renderCall(outputArgs, undefined, outputContext);
    const collapsed = taskOutput.renderResult(
      output, { isPartial: false, expanded: false }, undefined, outputContext,
    ).render(120).join("\n");
    const collapsedPlain = collapsed.replace(/\u001b\[[0-9;]*m/gu, "");
    expect(collapsedPlain).toContain("reviewer [completed] - Review authentication");
    expect(collapsedPlain).not.toContain("task output");
    expect(collapsed).not.toContain(taskId);
    const expanded = taskOutput.renderResult(
      output, { isPartial: false, expanded: true }, undefined, outputContext,
    ).render(120).join("\n");
    expect(expanded).toContain(`task: ${taskId}`);
    expect(expanded).toContain(`agent: ${started.details.agentId}`);
    expect({ args: outputArgs, result: output }).toEqual(outputCanonical);

    const duplicate = await taskOutput.execute("collect-description-again", outputArgs);
    expect(duplicate.details.alreadyReported).toBe(true);
    const duplicateCanonical = structuredClone(duplicate);
    const duplicateContext = { state: {}, args: structuredClone(outputArgs), isPartial: false, isError: false };
    const duplicateCall = taskOutput.renderCall(duplicateContext.args, undefined, duplicateContext);
    const duplicateResult = taskOutput.renderResult(
      structuredClone(duplicate), { isPartial: false, expanded: false }, undefined, duplicateContext,
    );
    expect(duplicateCall.render(120)).toEqual([]);
    expect(duplicateResult.render(120)).toEqual([]);
    expect(duplicate).toEqual(duplicateCanonical);
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

describe("MCP timeout diagnostic delivery (zero-enabled project)", () => {
  it("drains each rejected variable once to stderr without leaking values or entering other surfaces", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-mcp-timeout-diag-"));
    const userDir = path.join(projectDir, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    const previousCwd = process.cwd();
    const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const previousConnectTimeout = process.env.MCP_TIMEOUT;
    const previousToolTimeout = process.env.MCP_TOOL_TIMEOUT;
    const connectCanary = "CONNECT_TIMEOUT_REJECTED_VALUE_CANARY";
    const toolCanary = "TOOL_TIMEOUT_REJECTED_VALUE_CANARY";
    const connectDiagnostic =
      "MCP_TIMEOUT was rejected; using the 30000 ms fallback. Set MCP_TIMEOUT to a positive integer number of milliseconds or unset it.";
    const toolDiagnostic =
      "MCP_TOOL_TIMEOUT was rejected; per-server timeout remains authoritative, otherwise the 100000000 ms default applies. Set MCP_TOOL_TIMEOUT to a positive integer number of milliseconds or unset it.";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const p = fakePi();
    try {
      process.chdir(projectDir);
      process.env.PICC_CLAUDE_USER_DIR = userDir;
      process.env.MCP_TIMEOUT = connectCanary;
      process.env.MCP_TOOL_TIMEOUT = toolCanary;
      picc(p.api as never, {
        managedSettingsPaths: [],
        managedArtifactDirs: [],
        onInitializationSettled: p.captureInitialization,
      });
      await p.waitForInitialization();
      const promptResult = await p.fire("before_agent_start", { systemPrompt: "BASE_PROMPT" });

      const stderr = errSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(stderr.split(connectDiagnostic)).toHaveLength(2);
      expect(stderr.split(toolDiagnostic)).toHaveLength(2);
      expect(stderr).not.toContain(connectCanary);
      expect(stderr).not.toContain(toolCanary);

      await p.commands.get("doctor").handler("", p.ctx());
      await p.commands.get("mcp").handler("", p.ctx());
      const observedNonStderr = [
        logSpy.mock.calls.map((call) => call.join(" ")).join("\n"),
        p.notifications.map((notification) => notification.text).join("\n"),
        JSON.stringify(p.messages),
        JSON.stringify(p.entries),
        [...p.tools.keys()].join("\n"),
        JSON.stringify(promptResult),
      ].join("\n");
      for (const forbidden of [connectDiagnostic, toolDiagnostic, connectCanary, toolCanary]) {
        expect(observedNonStderr).not.toContain(forbidden);
      }
      expect([...p.tools.keys()].filter((name) => name.startsWith("mcp__"))).toEqual([]);
    } finally {
      await p.fire("session_shutdown", { reason: "other" });
      errSpy.mockRestore();
      logSpy.mockRestore();
      process.chdir(previousCwd);
      if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
      if (previousConnectTimeout === undefined) delete process.env.MCP_TIMEOUT;
      else process.env.MCP_TIMEOUT = previousConnectTimeout;
      if (previousToolTimeout === undefined) delete process.env.MCP_TOOL_TIMEOUT;
      else process.env.MCP_TOOL_TIMEOUT = previousToolTimeout;
      fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);
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
        expect(doctor).toContain("\"failing-server\": failed");
        // Raw commands remain redacted from /doctor.
        expect(doctor).not.toContain("picc-no-such-command-t05");
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
        expect(errText).toContain("MCP server(s) failed to start");
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


describe("MCP prompt/resource extension integration", () => {
  type Runtime = NonNullable<PiccTestSeam["mcpRuntime"]>;

  function runtimeWithPrompt(resourceCapable = true): Runtime {
    return {
      whenSettled: async () => {},
      tools: () => [],
      prompts: () => [{
        serverName: "fixture",
        promptName: "review code",
        description: "Review selected code",
        arguments: [{ name: "target", description: "Target", required: true }],
      }],
      resourceServers: () => resourceCapable
        ? [{ serverName: "fixture", resources: [] }]
        : [],
      getPrompt: async (_server, _prompt, args) => {
        if (args.target === "call-failure") throw new Error("safe call failure");
        if (args.target === "bad-response") return {};
        return {
          messages: [{ role: "user", content: { type: "text", text: `review:${args.target}` } }],
        };
      },
      readResource: async () => ({ contents: [{ uri: "fixture:test", text: "resource" }] }),
      callTool: async () => ({ content: [] }),
      diagnostics: () => [],
      serverStates: () => [{
        name: "fixture",
        transport: "stdio",
        state: "connected",
        toolsAdvertised: false,
        promptsAdvertised: true,
        resourcesAdvertised: resourceCapable,
        toolCount: 0,
        promptCount: 1,
        resourceCount: 0,
      }],
      shutdown: async () => {},
    };
  }

  it("gives fatal initial tools/list startup failures reload-or-restart guidance", async () => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      process.chdir(fixture);
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: {
          ...runtimeWithPrompt(false),
          prompts: () => [],
          serverStates: () => [{
            name: "safe-server",
            transport: "stdio",
            state: "failed",
            initialToolDiscoveryFailed: true,
            statusSummary: "Initial tools/list discovery failed; check the server configuration and logs, then run /reload or restart PiCC.",
          }],
        },
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      await localPi.fire("before_agent_start", { systemPrompt: "base" }, localPi.tuiCtx());
      expect(localPi.notifications.at(-1)).toMatchObject({ severity: "warning" });
      expect(localPi.notifications.at(-1)!.text).toContain("Initial tools/list discovery failed");
      expect(localPi.notifications.at(-1)!.text).toContain("server configuration and logs");
      expect(localPi.notifications.at(-1)!.text).toContain("/reload or restart PiCC");
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it("keeps exact local and unique namespaced suffix commands ahead of colliding MCP prompts", async () => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    try {
      const user = path.join(fixture, ".user");
      const pluginId = "alpha@fixture-market";
      fs.mkdirSync(user, { recursive: true });
      fs.writeFileSync(path.join(user, "settings.json"), JSON.stringify({ enabledPlugins: { [pluginId]: true } }));
      process.env.PICC_CLAUDE_USER_DIR = user;
      const commands = path.join(fixture, ".claude", "commands");
      fs.mkdirSync(commands, { recursive: true });
      fs.writeFileSync(path.join(commands, "mcp__fixture__exact.md"), "LOCAL-EXACT $ARGUMENTS\n");
      const plugin = path.join(user, "plugins", "cache", "fixture-market", "alpha", "1.0.0");
      fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
      fs.mkdirSync(path.join(plugin, "commands"), { recursive: true });
      fs.writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha" }));
      fs.writeFileSync(
        path.join(plugin, "commands", "mcp__fixture__alias.md"),
        "LOCAL-UNIQUE-PLUGIN-SUFFIX $ARGUMENTS\n",
      );
      fs.writeFileSync(
        path.join(user, "plugins", "installed_plugins.json"),
        JSON.stringify({ version: 2, plugins: { [pluginId]: [{ scope: "user", installPath: plugin, version: "1.0.0" }] } }),
      );
      process.chdir(fixture);
      let promptCalls = 0;
      const runtime: Runtime = {
        ...runtimeWithPrompt(false),
        prompts: () => ["exact", "alias"].map((promptName) => ({
          serverName: "fixture", promptName, description: promptName, arguments: [],
        })),
        getPrompt: async () => { promptCalls += 1; return { messages: [] }; },
      };
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtime,
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      const exact = await localPi.fire("input", {
        source: "user", text: "/mcp__fixture__exact one",
      }, localPi.printCtx());
      expect(exact).toMatchObject({ action: "transform" });
      expect(exact.text).toContain("LOCAL-EXACT one");
      const alias = await localPi.fire("input", {
        source: "user", text: "/mcp__fixture__alias two",
      }, localPi.printCtx());
      expect(alias).toMatchObject({ action: "transform" });
      expect(alias.text).toContain("LOCAL-UNIQUE-PLUGIN-SUFFIX two");
      expect(promptCalls).toBe(0);
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it.each([
    {
      label: "universal stop",
      hookOutput: JSON.stringify({ continue: false, stopReason: "prompt-stop-canary" }),
      exitCode: 0,
    },
    { label: "event block", hookOutput: "prompt-block-canary", exitCode: 2 },
  ])("keeps an MCP prompt out of invocation and provider dispatch after UserPromptSubmit $label", async ({ hookOutput, exitCode }) => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      const script = path.join(fixture, "prompt-admission-hook.mjs");
      fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(hookOutput)}); process.exit(${exitCode});\n`);
      fs.mkdirSync(path.join(fixture, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(fixture, ".claude", "settings.json"), JSON.stringify({
        env: { HOOK_NODE: process.execPath.replace(/\\/gu, "/"), HOOK_SCRIPT: script.replace(/\\/gu, "/") },
        hooks: { UserPromptSubmit: [{ hooks: [{
          type: "command", command: 'exec "$HOOK_NODE" "$HOOK_SCRIPT"',
        }] }] },
      }));
      process.chdir(fixture);
      let promptCalls = 0;
      const runtime: Runtime = {
        ...runtimeWithPrompt(false),
        getPrompt: async () => {
          promptCalls += 1;
          return { messages: [{ role: "user", content: { type: "text", text: "must-not-run" } }] };
        },
      };
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtime,
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      const raw = "/mcp__fixture__review_code RAW_MUST_NOT_DISPATCH";
      const result = await localPi.fire("input", { source: "user", text: raw }, localPi.printCtx());
      const providerInputs: string[] = [];
      if (result.action === "continue") providerInputs.push(raw);
      if (result.action === "transform") providerInputs.push(String(result.text));
      expect(result).toEqual({ action: "handled" });
      expect(promptCalls).toBe(0);
      expect(providerInputs).toEqual([]);
      expect(localPi.messages).toEqual([]);
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      errorSpy.mockRestore();
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it("runs UserPromptSubmit on the raw command and appends hook context after prompt expansion", async () => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      const capture = path.join(fixture, "hook-input.json");
      const script = path.join(fixture, "capture-hook.mjs");
      fs.writeFileSync(script, [
        'import fs from "node:fs";',
        'let input = "";',
        'for await (const chunk of process.stdin) input += chunk;',
        'fs.writeFileSync(process.env.HOOK_CAPTURE_OUTPUT, input, "utf8");',
        'process.stdout.write("RAW-HOOK-SUFFIX");',
      ].join("\n"));
      fs.mkdirSync(path.join(fixture, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(fixture, ".claude", "settings.json"), JSON.stringify({
        env: {
          HOOK_NODE: process.execPath.replace(/\\/gu, "/"),
          HOOK_CAPTURE_SCRIPT: script.replace(/\\/gu, "/"),
          HOOK_CAPTURE_OUTPUT: capture.replace(/\\/gu, "/"),
        },
        hooks: { UserPromptSubmit: [{ hooks: [{
          type: "command", command: 'exec "$HOOK_NODE" "$HOOK_CAPTURE_SCRIPT"',
        }] }] },
      }));
      process.chdir(fixture);
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtimeWithPrompt(false),
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      const raw = "/mcp__fixture__review_code src/index.ts";
      const transformed = await localPi.fire("input", { source: "user", text: raw }, localPi.printCtx());
      expect(transformed).toMatchObject({ action: "transform" });
      expect(transformed.text.indexOf("review:src/index.ts"))
        .toBeLessThan(transformed.text.indexOf("RAW-HOOK-SUFFIX"));
      expect(JSON.parse(fs.readFileSync(capture, "utf8"))).toMatchObject({ prompt: raw });
      expect(transformed.text).not.toContain(raw);
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it("publishes frontmatter-only prompt stubs, transforms typed prompts, and owns machine failures", async () => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      process.chdir(fixture);
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtimeWithPrompt(),
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      await localPi.waitForTools(["ListMcpResourcesTool", "ReadMcpResourceTool"]);

      const resources = await localPi.fire("resources_discover", {}, localPi.tuiCtx());
      expect(resources.promptPaths).toHaveLength(1);
      const stub = fs.readFileSync(path.join(resources.promptPaths[0], "mcp__fixture__review_code.md"), "utf8");
      expect(stub).toContain("description: \"Review selected code\"");
      expect(stub).toContain("argument-hint: \"<target>\"");
      expect(stub.trimEnd().endsWith("---")).toBe(true);
      expect(stub).not.toContain("review:");

      const transformed = await localPi.fire("input", {
        source: "user",
        text: "/mcp__fixture__review_code src/index.ts",
      }, localPi.printCtx());
      expect(transformed).toMatchObject({ action: "transform" });
      expect(transformed.text).toContain("review:src/index.ts");
      expect(transformed.text).not.toContain("/mcp__fixture__review_code");

      const failed = await localPi.fire("input", {
        source: "user",
        text: "/mcp__fixture__review_code",
      }, localPi.rpcCtx());
      expect(failed).toEqual({ action: "handled" });
      const entry = localPi.entries.at(-1)!;
      expect(entry).toMatchObject({
        customType: "picc-mcp-prompt",
        data: {
          command: "mcp__fixture__review_code",
          server: "fixture",
          category: "arguments",
          providerRequestSent: false,
        },
      });
      expect(entry.data.message).toContain("target");
      expect(entry.data.message).toContain("Usage:");
      const renderer = localPi.entryRenderers.get("picc-mcp-prompt");
      expect(renderer).toBeDefined();
      for (const theme of [
        {
          fg: (slot: string, text: string) => `\u001b[${slot === "warning" ? "33" : slot === "error" ? "31" : "37"}m${text}\u001b[39m`,
          bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
        },
        { fg: (slot: string, text: string) => `\u001b[${slot === "warning" ? "33" : slot === "error" ? "31" : "37"}m${text}\u001b[39m` },
      ]) {
        for (const width of [80, 9]) {
          const lines = renderer!(entry, {}, theme).render(width);
          expect(lines.every((line: string) => piTui.visibleWidth(line) <= width)).toBe(true);
          const rendered = lines.join("\n");
          expect(rendered).toContain("\u001b[33m");
          const semantic = rendered.replace(/\u001b\[[0-9;]*m/gu, "").replace(/\s/gu, "");
          expect(semantic).toContain("arguments");
          expect(semantic).toContain("mcp__fixture__review_code");
          expect(semantic).toContain("Usage:");
          expect(semantic).toContain("target");
        }
      }

      for (const invocation of [
        "/mcp__fixture__review_code one surplus",
        "/mcp__fixture__review_code \"unterminated",
      ]) {
        const invalid = await localPi.fire("input", { source: "user", text: invocation }, localPi.ctx({
          mode: "json", hasUI: false,
        }));
        expect(invalid).toEqual({ action: "handled" });
        expect(localPi.entries.at(-1)).toMatchObject({
          customType: "picc-mcp-prompt",
          data: { category: "arguments", providerRequestSent: false },
        });
        expect(JSON.stringify(localPi.entries.at(-1))).not.toContain(invocation);
      }

      const tuiFailure = await localPi.fire("input", {
        source: "user", text: "/mcp__fixture__review_code",
      }, localPi.tuiCtx());
      expect(tuiFailure).toEqual({ action: "handled" });
      expect(localPi.notifications.at(-1)).toMatchObject({ severity: "warning" });
      expect(localPi.notifications.at(-1)!.text).toContain("Usage:");

      const unknown = await localPi.fire("input", {
        source: "user", text: "/mcp__fixture__missing raw-secret",
      }, localPi.rpcCtx());
      expect(unknown).toEqual({ action: "handled" });
      expect(localPi.entries.at(-1)).toMatchObject({
        customType: "picc-mcp-prompt",
        data: { category: "unknown", providerRequestSent: false },
      });
      expect(JSON.stringify(localPi.entries.at(-1))).not.toContain("raw-secret");

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const callFailure = await localPi.fire("input", {
          source: "user", text: "/mcp__fixture__review_code call-failure",
        }, localPi.printCtx());
        expect(callFailure).toEqual({ action: "handled" });
        expect(errorSpy.mock.calls.flat().join(" ")).toContain("Retry later");
        expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("/mcp__fixture__review_code call-failure");

        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
        try {
          const presenterFailure = await localPi.fire("input", {
            source: "user", text: "/mcp__fixture__review_code",
          }, localPi.tuiCtx({ ui: { notify: () => { throw new Error("presenter failed"); } } }));
          expect(presenterFailure).toEqual({ action: "handled" });
          expect(stderrSpy.mock.calls.flat().join(" ")).toContain("Usage:");
        } finally {
          stderrSpy.mockRestore();
        }
      } finally {
        errorSpy.mockRestore();
      }

      const badResponse = await localPi.fire("input", {
        source: "user", text: "/mcp__fixture__review_code bad-response",
      }, localPi.rpcCtx());
      expect(badResponse).toEqual({ action: "handled" });
      expect(localPi.entries.at(-1)).toMatchObject({
        customType: "picc-mcp-prompt",
        data: { category: "response", providerRequestSent: false },
      });
      expect(localPi.entries.at(-1)!.data.message).toContain("server's prompt implementation");
      expect(localPi.entries.at(-1)!.data.message).not.toContain("run /mcp");
      for (const theme of [
        {
          fg: (slot: string, text: string) => `\u001b[${slot === "error" ? "31" : "37"}m${text}\u001b[39m`,
          bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
        },
        { fg: (slot: string, text: string) => `\u001b[${slot === "error" ? "31" : "37"}m${text}\u001b[39m` },
      ]) {
        for (const width of [80, 9]) {
          const lines = renderer!(localPi.entries.at(-1), {}, theme).render(width);
          expect(lines.every((line: string) => piTui.visibleWidth(line) <= width)).toBe(true);
          const rendered = lines.join("\n");
          const semantic = rendered.replace(/\u001b\[[0-9;]*m/gu, "").replace(/\s/gu, "");
          expect(rendered).toContain("\u001b[31m");
          expect(semantic).toContain("response");
          expect(semantic).toContain("mcp__fixture__review_code");
          expect(semantic).toContain("server'spromptimplementation");
        }
      }
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it("retains a near-limit JSON/RPC failure hint and corrective tail through storage and rendering", async () => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      process.chdir(fixture);
      const argumentsList = Array.from({ length: 10 }, (_, index) => ({
        name: `arg${index}_${"x".repeat(184)}`,
        description: "required",
        required: true,
      }));
      const runtime: Runtime = {
        ...runtimeWithPrompt(false),
        prompts: () => [{
          serverName: "fixture",
          promptName: "near limit",
          description: "Near-limit failure",
          arguments: argumentsList,
        }],
      };
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtime,
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      const command = "mcp__fixture__near_limit";
      const hint = argumentsList.map((argument) => `<${argument.name}>`).join(" ");
      const correctiveTail = `Usage: /${command} ${hint}.`;
      for (const ctx of [localPi.ctx({ mode: "json", hasUI: false }), localPi.rpcCtx()]) {
        const result = await localPi.fire("input", { source: "user", text: `/${command}` }, ctx);
        expect(result).toEqual({ action: "handled" });
        const entry = localPi.entries.at(-1)!;
        expect(entry).toMatchObject({
          customType: "picc-mcp-prompt",
          data: { command, category: "arguments", providerRequestSent: false },
        });
        const stored = String(entry.data.message);
        expect(stored.length).toBeGreaterThan(1_200);
        expect(stored.length).toBeLessThanOrEqual(4_096);
        expect(stored.endsWith(correctiveTail)).toBe(true);

        const renderer = localPi.entryRenderers.get("picc-mcp-prompt")!;
        for (const width of [80, 9]) {
          const lines = renderer(entry, {}, { fg: (_slot: string, text: string) => text }).render(width);
          expect(lines.every((line: string) => piTui.visibleWidth(line) <= width)).toBe(true);
          const rendered = lines.join("\n").replace(/\s/gu, "");
          expect(rendered).toContain(hint.replace(/\s/gu, ""));
          expect(rendered.endsWith(correctiveTail.replace(/\s/gu, ""))).toBe(true);
        }
      }
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it("shows and clears delayed palette progress, coalesces publication, and retains frontmatter-only stubs", async () => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    const settled = deferred<void>();
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      process.chdir(fixture);
      const runtime: Runtime = {
        ...runtimeWithPrompt(false),
        whenSettled: () => settled.promise,
        serverStates: () => [{ name: "fixture", transport: "stdio", state: "connecting" }],
      };
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtime,
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      const staleDirectory = path.join(fixture, ".claude", ".picc", "prompts");
      fs.mkdirSync(staleDirectory, { recursive: true });
      fs.writeFileSync(path.join(staleDirectory, "stale.md"), "STALE");
      vi.useFakeTimers();
      const first = localPi.fire("resources_discover", {}, localPi.tuiCtx());
      const second = localPi.fire("resources_discover", {}, localPi.tuiCtx());
      await vi.advanceTimersByTimeAsync(151);
      expect(localPi.statusCalls.filter((call) => call.text === "Discovering MCP prompts…"))
        .toHaveLength(1);
      settled.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toEqual(secondResult);
      expect(firstResult.promptPaths).toHaveLength(1);
      expect(localPi.statusCalls.filter((call) => call.text === undefined)).toHaveLength(1);
      const names = fs.readdirSync(firstResult.promptPaths[0]);
      expect(names).not.toContain("stale.md");
      expect(names.filter((name) => name === "mcp__fixture__review_code.md")).toHaveLength(1);
      expect(fs.readdirSync(path.join(fixture, ".claude", ".picc")))
        .not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.prompts-(?:staging|backup)-/u)]));
      const promptStub = fs.readFileSync(
        path.join(firstResult.promptPaths[0], "mcp__fixture__review_code.md"), "utf8",
      );
      expect(promptStub.trimEnd().endsWith("---")).toBe(true);
      expect(promptStub).not.toContain("review:");
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      vi.useRealTimers();
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it("reports a benign palette write failure without advertising a path while typed invocation survives", async () => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    let writeSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      process.chdir(fixture);
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtimeWithPrompt(false),
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      const published = path.join(fixture, ".claude", ".picc", "prompts");
      fs.mkdirSync(published, { recursive: true });
      fs.writeFileSync(path.join(published, "old.md"), "OLD_PALETTE");
      writeSpy = vi.spyOn(fs.promises, "writeFile").mockRejectedValueOnce(new Error("benign-write-canary"));
      const resources = await localPi.fire("resources_discover", {}, localPi.tuiCtx({ ui: {} }));
      expect(resources.promptPaths).toBeUndefined();
      expect(stderrSpy.mock.calls.flat().join(" ")).toContain("Slash-command palette publication failed");
      expect(stderrSpy.mock.calls.flat().join(" ")).toContain("exact typed invocation still works");
      expect(fs.readFileSync(path.join(published, "old.md"), "utf8")).toBe("OLD_PALETTE");
      expect(fs.readdirSync(path.dirname(published)))
        .not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.prompts-(?:staging|backup)-/u)]));
      const transformed = await localPi.fire("input", {
        source: "user", text: "/mcp__fixture__review_code safe",
      }, localPi.printCtx());
      expect(transformed).toMatchObject({ action: "transform" });
      expect(transformed.text).toContain("review:safe");
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      writeSpy?.mockRestore();
      stderrSpy.mockRestore();
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it("rolls back the old palette when the staged replacement swap fails", async () => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let renameSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      process.chdir(fixture);
      const published = path.join(fixture, ".claude", ".picc", "prompts");
      fs.mkdirSync(published, { recursive: true });
      fs.writeFileSync(path.join(published, "old.md"), "OLD_PALETTE");
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtimeWithPrompt(false),
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      const realRename = fs.promises.rename.bind(fs.promises);
      let renameCalls = 0;
      renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
        renameCalls += 1;
        if (renameCalls === 2) throw Object.assign(new Error("swap-canary"), { code: "EACCES" });
        return realRename(from, to);
      });
      const resources = await localPi.fire("resources_discover", {}, localPi.printCtx());
      expect(resources.promptPaths).toBeUndefined();
      expect(renameCalls).toBe(3);
      expect(fs.readFileSync(path.join(published, "old.md"), "utf8")).toBe("OLD_PALETTE");
      expect(fs.readdirSync(path.dirname(published)))
        .not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.prompts-(?:staging|backup)-/u)]));
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      renameSpy?.mockRestore();
      errorSpy.mockRestore();
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it("retains failed exposure while tool-only and advertised-empty prompt namespaces pass through", async () => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      process.chdir(fixture);
      let promptCalls = 0;
      const failedRuntime: Runtime = {
        ...runtimeWithPrompt(false),
        whenSettled: async () => { throw new Error("startup-attribution-canary"); },
        prompts: () => { promptCalls += 1; return []; },
      };
      const failedPi = fakePi();
      picc(failedPi.api as never, {
        mcpRuntime: failedRuntime,
        onInitializationSettled: failedPi.captureInitialization,
      });
      await failedPi.waitForInitialization();
      const handled = await failedPi.fire("input", {
        source: "user", text: "/mcp__fixture__missing RAW_ARGUMENT_MUST_NOT_LEAK",
      }, failedPi.rpcCtx());
      expect(handled).toEqual({ action: "handled" });
      expect(promptCalls).toBe(0);
      expect(failedPi.messages).toEqual([]);
      expect(failedPi.entries.at(-1)).toMatchObject({
        customType: "picc-mcp-prompt",
        data: { category: "call", providerRequestSent: false },
      });
      const serialized = JSON.stringify(failedPi.entries.at(-1));
      expect(serialized).toContain("startup-attribution-canary");
      expect(serialized).toContain("server configuration and logs");
      expect(serialized).not.toContain("RAW_ARGUMENT_MUST_NOT_LEAK");

      let discoveryPromptCalls = 0;
      const discoveryPi = fakePi();
      const discoveryRuntime: Runtime = {
        ...runtimeWithPrompt(false),
        prompts: () => [],
        getPrompt: async () => {
          discoveryPromptCalls += 1;
          return { messages: [] };
        },
        serverStates: () => [{
          name: "fixture-safe-name",
          transport: "stdio",
          state: "connected",
          promptsAdvertised: true,
          promptCount: 0,
          promptDiscoveryError: "RAW_SERVER_DIAGNOSTIC_MUST_NOT_LEAK",
        }],
      };
      picc(discoveryPi.api as never, {
        mcpRuntime: discoveryRuntime,
        onInitializationSettled: discoveryPi.captureInitialization,
      });
      await discoveryPi.waitForInitialization();
      const discoveryHandled = await discoveryPi.fire("input", {
        source: "user", text: "/mcp__fixture-safe-name__missing RAW_DISCOVERY_ARGS_MUST_NOT_LEAK",
      }, discoveryPi.rpcCtx());
      expect(discoveryHandled).toEqual({ action: "handled" });
      expect(discoveryPromptCalls).toBe(0);
      expect(discoveryPi.messages).toEqual([]);
      expect(discoveryPi.entries.at(-1)).toMatchObject({
        customType: "picc-mcp-prompt",
        data: { category: "call", providerRequestSent: false },
      });
      const discoverySerialized = JSON.stringify(discoveryPi.entries.at(-1));
      expect(discoverySerialized).toContain("fixture-safe-name");
      expect(discoverySerialized).toContain("prompt discovery failed");
      expect(discoverySerialized).not.toContain("RAW_SERVER_DIAGNOSTIC_MUST_NOT_LEAK");
      expect(discoverySerialized).not.toContain("RAW_DISCOVERY_ARGS_MUST_NOT_LEAK");

      const toolOnlyPi = fakePi();
      const toolOnlyRuntime: Runtime = {
        ...runtimeWithPrompt(false),
        prompts: () => [],
        serverStates: () => [{
          name: "tool-only",
          transport: "stdio",
          state: "connected",
          toolsAdvertised: true,
          promptsAdvertised: false,
          toolCount: 0,
        }],
      };
      picc(toolOnlyPi.api as never, {
        mcpRuntime: toolOnlyRuntime,
        onInitializationSettled: toolOnlyPi.captureInitialization,
      });
      await toolOnlyPi.waitForInitialization();
      const toolOnlyPassthrough = await toolOnlyPi.fire("input", {
        source: "user", text: "/mcp__ordinary_project_text tool-only",
      }, toolOnlyPi.printCtx());
      expect(toolOnlyPassthrough).toEqual({ action: "continue" });
      expect(toolOnlyPi.entries).toEqual([]);

      const zeroPi = fakePi();
      const zeroRuntime: Runtime = {
        ...runtimeWithPrompt(false),
        prompts: () => [],
        serverStates: () => [{
          name: "advertised-empty",
          transport: "stdio",
          state: "connected",
          promptsAdvertised: true,
          promptCount: 0,
        }],
      };
      picc(zeroPi.api as never, {
        mcpRuntime: zeroRuntime,
        onInitializationSettled: zeroPi.captureInitialization,
      });
      await zeroPi.waitForInitialization();
      const passthrough = await zeroPi.fire("input", {
        source: "user", text: "/mcp__ordinary_project_text untouched",
      }, zeroPi.printCtx());
      expect(passthrough).toEqual({ action: "continue" });
      expect(zeroPi.entries).toEqual([]);
      await failedPi.fire("session_shutdown", { reason: "other" }, failedPi.printCtx());
      await discoveryPi.fire("session_shutdown", { reason: "other" }, discoveryPi.printCtx());
      await toolOnlyPi.fire("session_shutdown", { reason: "other" }, toolOnlyPi.printCtx());
      await zeroPi.fire("session_shutdown", { reason: "other" }, zeroPi.printCtx());
    } finally {
      errorSpy.mockRestore();
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it("attributes a failed prompt namespace without shadowing a healthy server command", async () => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      process.chdir(fixture);
      const promptCalls: Array<{ server: string; prompt: string; args: Record<string, string> }> = [];
      const runtime: Runtime = {
        ...runtimeWithPrompt(false),
        prompts: () => [{
          serverName: "healthy server",
          promptName: "review code",
          description: "Healthy prompt",
          arguments: [{ name: "target", description: "Target", required: true }],
        }],
        getPrompt: async (server, prompt, args) => {
          promptCalls.push({ server, prompt, args });
          return { messages: [{ role: "user", content: { type: "text", text: `healthy:${args.target}` } }] };
        },
        serverStates: () => [{
          name: "healthy server",
          transport: "stdio",
          state: "connected",
          promptsAdvertised: true,
          promptCount: 1,
        }, {
          name: "failed server",
          transport: "stdio",
          state: "connected",
          promptsAdvertised: true,
          promptCount: 0,
          promptDiscoveryError: "RAW_FAILED_SERVER_DIAGNOSTIC_MUST_NOT_LEAK",
        }],
      };
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtime,
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();

      const healthy = await localPi.fire("input", {
        source: "user", text: "/mcp__healthy_server__review_code SAFE_HEALTHY_ARGUMENT",
      }, localPi.rpcCtx());
      expect(healthy).toMatchObject({ action: "transform" });
      expect(healthy.text).toContain("healthy:SAFE_HEALTHY_ARGUMENT");
      expect(promptCalls).toEqual([{
        server: "healthy server",
        prompt: "review code",
        args: { target: "SAFE_HEALTHY_ARGUMENT" },
      }]);

      const failed = await localPi.fire("input", {
        source: "user", text: "/mcp__failed_server__missing RAW_FAILED_ARGUMENT_MUST_NOT_LEAK",
      }, localPi.rpcCtx());
      expect(failed).toEqual({ action: "handled" });
      expect(promptCalls).toHaveLength(1);
      expect(localPi.messages).toEqual([]);
      expect(localPi.entries.at(-1)).toMatchObject({
        customType: "picc-mcp-prompt",
        data: {
          command: "mcp__failed_server__missing",
          server: "failed_server",
          category: "call",
          providerRequestSent: false,
        },
      });
      const serialized = JSON.stringify(localPi.entries.at(-1));
      expect(serialized).toContain("prompt discovery failed for server failed_server");
      expect(serialized).toContain("Check the server configuration and logs, then restart PiCC.");
      expect(serialized).not.toContain("RAW_FAILED_SERVER_DIAGNOSTIC_MUST_NOT_LEAK");
      expect(serialized).not.toContain("RAW_FAILED_ARGUMENT_MUST_NOT_LEAK");
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      errorSpy.mockRestore();
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it("bounds maximum-name multi-failure guidance while retaining exact namespace attribution", async () => {
    const fixture = materializeFixture("hello-claude");
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      process.chdir(fixture);
      const serverNames = Array.from({ length: 10 }, (_, index) =>
        `${String(index).padStart(2, "0")}_${"s".repeat(97)}`,
      );
      let promptCalls = 0;
      const runtime: Runtime = {
        ...runtimeWithPrompt(false),
        prompts: () => [],
        getPrompt: async () => {
          promptCalls += 1;
          return { messages: [] };
        },
        serverStates: () => serverNames.map((name, index) => ({
          name,
          transport: "stdio" as const,
          state: "connected" as const,
          promptsAdvertised: true,
          promptCount: 0,
          promptDiscoveryError: `RAW_MULTI_DIAGNOSTIC_${index}_MUST_NOT_LEAK`,
        })),
      };
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtime,
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();

      const attributed = await localPi.fire("input", {
        source: "user",
        text: `/mcp__${serverNames[7]}__missing RAW_ATTRIBUTED_ARGUMENT_MUST_NOT_LEAK`,
      }, localPi.rpcCtx());
      expect(attributed).toEqual({ action: "handled" });
      expect(localPi.entries.at(-1)).toMatchObject({
        customType: "picc-mcp-prompt",
        data: { server: serverNames[7], category: "call", providerRequestSent: false },
      });

      const summarized = await localPi.fire("input", {
        source: "user", text: "/mcp__unmatched__missing RAW_SUMMARY_ARGUMENT_MUST_NOT_LEAK",
      }, localPi.rpcCtx());
      expect(summarized).toEqual({ action: "handled" });
      expect(promptCalls).toBe(0);
      expect(localPi.messages).toEqual([]);
      const entry = localPi.entries.at(-1)!;
      expect(entry).toMatchObject({
        customType: "picc-mcp-prompt",
        data: { category: "call", providerRequestSent: false },
      });
      const message = String(entry.data.message);
      expect(Array.from(message).length).toBeLessThanOrEqual(1_200);
      expect(message).toContain(serverNames[0]);
      expect(message).toContain(serverNames[2]);
      expect(message).not.toContain(serverNames[3]);
      expect(message).toContain("and 7 others");
      expect(message.endsWith("Check the server configuration and logs, then restart PiCC.")).toBe(true);
      const serialized = JSON.stringify(localPi.entries);
      expect(serialized).not.toContain("RAW_MULTI_DIAGNOSTIC");
      expect(serialized).not.toContain("RAW_ATTRIBUTED_ARGUMENT_MUST_NOT_LEAK");
      expect(serialized).not.toContain("RAW_SUMMARY_ARGUMENT_MUST_NOT_LEAK");
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      errorSpy.mockRestore();
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      cleanupFixture(fixture);
    }
  }, 30_000);

  it.skipIf(process.platform !== "win32")("rejects a Windows directory symlink separately when creation is supported", async () => {
    const fixture = materializeFixture("hello-claude");
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "picc-prompt-symlink-sentinel-"));
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    const sentinel = path.join(external, "sentinel.txt");
    fs.writeFileSync(sentinel, "KEEP");
    fs.mkdirSync(path.join(external, "prompts"));
    fs.writeFileSync(path.join(external, "prompts", "old.md"), "OLD_PALETTE");
    let localPi: ReturnType<typeof fakePi> | undefined;
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      const piccDir = path.join(fixture, ".claude", ".picc");
      fs.rmSync(piccDir, { recursive: true, force: true });
      try {
        fs.symlinkSync(external, piccDir, "dir");
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
        throw error;
      }
      process.chdir(fixture);
      localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtimeWithPrompt(false),
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      const resources = await localPi.fire("resources_discover", {}, localPi.printCtx());
      expect(resources.promptPaths).toBeUndefined();
      expect(fs.readFileSync(sentinel, "utf8")).toBe("KEEP");
      expect(fs.readFileSync(path.join(external, "prompts", "old.md"), "utf8")).toBe("OLD_PALETTE");
      expect(fs.readdirSync(external).sort()).toEqual(["prompts", "sentinel.txt"]);
    } finally {
      if (localPi) await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.rmSync(external, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an external prompt-directory redirection without touching it while typed invocation survives", async () => {
    const fixture = materializeFixture("hello-claude");
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "picc-prompt-sentinel-"));
    const previous = process.cwd();
    const previousUser = process.env.PICC_CLAUDE_USER_DIR;
    const sentinel = path.join(external, "sentinel.txt");
    fs.writeFileSync(sentinel, "KEEP");
    fs.mkdirSync(path.join(external, "prompts"));
    fs.writeFileSync(path.join(external, "prompts", "old.md"), "OLD_PALETTE");
    try {
      const user = path.join(fixture, ".user");
      fs.mkdirSync(user, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = user;
      const piccDir = path.join(fixture, ".claude", ".picc");
      fs.rmSync(piccDir, { recursive: true, force: true });
      fs.symlinkSync(external, piccDir, process.platform === "win32" ? "junction" : "dir");
      process.chdir(fixture);
      const localPi = fakePi();
      picc(localPi.api as never, {
        mcpRuntime: runtimeWithPrompt(false),
        onInitializationSettled: localPi.captureInitialization,
      });
      await localPi.waitForInitialization();
      const resources = await localPi.fire("resources_discover", {}, localPi.printCtx());
      expect(resources.promptPaths).toBeUndefined();
      expect(fs.readFileSync(sentinel, "utf8")).toBe("KEEP");
      expect(fs.readFileSync(path.join(external, "prompts", "old.md"), "utf8")).toBe("OLD_PALETTE");
      expect(fs.readdirSync(external).sort()).toEqual(["prompts", "sentinel.txt"]);
      const transformed = await localPi.fire("input", {
        source: "user",
        text: "/mcp__fixture__review_code safe",
      }, localPi.printCtx());
      expect(transformed).toMatchObject({ action: "transform" });
      expect(transformed.text).toContain("review:safe");
      await localPi.fire("session_shutdown", { reason: "other" }, localPi.printCtx());
    } finally {
      process.chdir(previous);
      if (previousUser === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUser;
      fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.rmSync(external, { recursive: true, force: true });
    }
  }, 30_000);
});
